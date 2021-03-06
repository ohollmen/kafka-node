'use strict';

var logger = require('./logging')('kafka-node:ConsumerGroup');
var util = require('util');
var EventEmitter = require('events');
var highLevelConsumer = require('./highLevelConsumer');
var Client = require('./client');
var Offset = require('./offset');
var _ = require('lodash');
var async = require('async');
var validateConfig = require('./utils').validateConfig;
var ConsumerGroupRecovery = require('./consumerGroupRecovery');
var Heartbeat = require('./consumerGroupHeartbeat');
var createTopicPartitionList = require('./utils').createTopicPartitionList;
var errors = require('./errors');

var assert = require('assert');
var builtInProtocols = require('./assignment');

var LATEST_OFFSET = -1;
var EARLIEST_OFFSET = -2;
var ACCEPTED_FROM_OFFSET = {
  latest: LATEST_OFFSET,
  earliest: EARLIEST_OFFSET,
  none: false
};

var DEFAULTS = {
  groupId: 'kafka-node-group',
  // Auto commit config
  autoCommit: true,
  autoCommitIntervalMs: 5000,
  // Fetch message config
  fetchMaxWaitMs: 100,
  paused: false,
  maxNumSegments: 1000,
  fetchMinBytes: 1,
  fetchMaxBytes: 1024 * 1024,
  maxTickMessages: 1000,
  fromOffset: 'latest',
  outOfRangeOffset: 'earliest',
  sessionTimeout: 30000,
  retries: 10,
  retryFactor: 1.8,
  retryMinTimeout: 1000,
  connectOnReady: true,
  migrateHLC: false,
  migrateRolling: true,
  protocol: ['roundrobin']
};

function ConsumerGroup (memberOptions, topics) {
  EventEmitter.call(this);
  var self = this;
  this.options = _.defaults((memberOptions || {}), DEFAULTS);

  if (!this.options.heartbeatInterval) {
    this.options.heartbeatInterval = Math.floor(this.options.sessionTimeout / 3);
  }

  if (memberOptions.ssl === true) {
    memberOptions.ssl = {};
  }

  if (!(this.options.fromOffset in ACCEPTED_FROM_OFFSET)) {
    throw new Error('fromOffset ' + this.options.fromOffset + ' should be either: ' + Object.keys(ACCEPTED_FROM_OFFSET).join(', ') + '');
  }

  if (!(this.options.outOfRangeOffset in ACCEPTED_FROM_OFFSET)) {
    throw new Error('outOfRangeOffset ' + this.options.outOfRangeOffset + ' should be either: ' + Object.keys(ACCEPTED_FROM_OFFSET).join(', ') + '');
  }

  this.client = new Client(memberOptions.host, memberOptions.id, memberOptions.zk,
    memberOptions.batch, memberOptions.ssl);

  if (_.isString(topics)) {
    topics = [topics];
  }

  assert(Array.isArray(topics), 'Array of topics is required');

  this.topics = topics;

  this.recovery = new ConsumerGroupRecovery(this);

  this.setupProtocols(this.options.protocol);

  if (this.options.connectOnReady && !this.options.migrateHLC) {
    this.client.once('ready', this.connect.bind(this));
  }

  if (this.options.migrateHLC) {
    var ConsumerGroupMigrator = require('./consumerGroupMigrator');
    this.migrator = new ConsumerGroupMigrator(this);
    this.migrator.on('error', function (error) {
      self.emit('error', error);
    });
  }

  this.client.on('error', function (err) {
    logger.error('Error from %s', self.client.clientId, err);
    self.emit('error', err);
  });

  var recoverFromBrokerChange = _.debounce(function () {
    logger.debug('brokersChanged refreshing metadata');
    self.client.refreshMetadata(self.topics, function (error) {
      if (error) {
        self.emit(error);
        return;
      }
      self.paused = false;
      if (!self.ready && !self.connecting) {
        if (self.reconnectTimer) {
          // brokers changed so bypass backoff retry and reconnect now
          clearTimeout(self.reconnectTimer);
          self.reconnectTimer = null;
        }
        self.connect();
      } else if (!self.connecting) {
        self.fetch();
      }
    });
  }, 200);

  this.client.on('brokersChanged', function () {
    self.pause();
    recoverFromBrokerChange();
  });

  this.client.on('reconnect', function (lastError) {
    self.fetch();
  });

  this.on('offsetOutOfRange', function (topic) {
    this.pause();
    if (this.options.outOfRangeOffset === 'none') {
      this.emit('error', new errors.InvalidConsumerOffsetError('Offset out of range for topic "' + topic.topic + '" partition ' + topic.partition + ''));
      return;
    }

    topic.time = ACCEPTED_FROM_OFFSET[this.options.outOfRangeOffset];

    this.getOffset().fetch([topic], function (error, result) {
      if (error) {
        this.emit('error', new errors.InvalidConsumerOffsetError('Fetching '+this.options.outOfRangeOffset+' offset failed', error));
        return;
      }
      var offset = _.head(result[topic.topic][topic.partition]);
      var oldOffset = _.find(this.topicPayloads, {topic: topic.topic, partition: topic.partition}).offset;

      logger.debug('replacing %s-%s stale offset of %d with %d', topic.topic, topic.partition, oldOffset, offset);

      this.setOffset(topic.topic, topic.partition, offset);
      this.resume();
    });
  });

  // 'done' will be emit when a message fetch request complete
  this.on('done', function (topics) {
    self.updateOffsets(topics);
    if (!self.paused) {
      setImmediate(function () {
        self.fetch();
      });
    }
  });

  if (this.options.groupId) {
    validateConfig('options.groupId', this.options.groupId);
  }

  this.isLeader = false;
  this.coordinatorId = null;
  this.generationId = null;
  this.ready = false;
  this.topicPayloads = [];
}

util.inherits(ConsumerGroup, highLevelConsumer);

ConsumerGroup.prototype.setupProtocols = function (protocols) {
  if (!Array.isArray(protocols)) {
    protocols = [protocols];
  }

  this.protocols = protocols.map(function (protocol) {
    if (typeof protocol === 'string') {
      if (!(protocol in builtInProtocols)) {
        throw new Error('Unknown built in assignment protocol ' + protocol);
      }
      protocol = _.assign({}, builtInProtocols[protocol]);
    } else {
      checkProtocol(protocol);
    }

    protocol.subscription = this.topics;
    return protocol;
  }, this);
};

function checkProtocol (protocol) {
  assert(protocol, 'protocol is null');
  assert(protocol.assign, 'assign function is not defined in the protocol');
  assert(protocol.name, 'name must be given to protocol');
  assert(protocol.version >= 0, 'version must be >= 0');
}

ConsumerGroup.prototype.setCoordinatorId = function (coordinatorId) {
  this.client.coordinatorId = String(coordinatorId);
};

ConsumerGroup.prototype.assignPartitions = function (protocol, groupMembers, callback) {
  logger.debug('Assigning Partitions to members', groupMembers);
  logger.debug('Using group protocol', protocol);

  protocol = _.find(this.protocols, {name: protocol});

  var self = this;
  var topics = _(groupMembers).map('subscription').flatten().uniq().value();

  async.waterfall([
    function (callback) {
      logger.debug('loadingMetadata for topics:', topics);
      self.client.loadMetadataForTopics(topics, callback);
    },

    function (metadataResponse, callback) {
      var metadata = mapTopicToPartitions(metadataResponse[1].metadata);
      logger.debug('mapTopicToPartitions', metadata);
      protocol.assign(metadata, groupMembers, callback);
    }
  ], callback);
};

function mapTopicToPartitions (metadata) {
  return _.mapValues(metadata, Object.keys);
}

ConsumerGroup.prototype.handleJoinGroup = function (joinGroupResponse, callback) {
  logger.debug('joinGroupResponse %j from %s', joinGroupResponse, this.client.clientId);

  this.isLeader = (joinGroupResponse.leaderId === joinGroupResponse.memberId);
  this.generationId = joinGroupResponse.generationId;
  this.memberId = joinGroupResponse.memberId;

  var groupAssignment;
  if (this.isLeader) {
    // assign partitions
    return this.assignPartitions(joinGroupResponse.groupProtocol, joinGroupResponse.members, callback);
  }
  callback(null, groupAssignment);
};

ConsumerGroup.prototype.saveDefaultOffsets = function (topicPartitionList, callback) {
  var self = this;
  var offsetPayload = _(topicPartitionList).cloneDeep().map(function (tp) {
    tp.time = ACCEPTED_FROM_OFFSET[this.options.fromOffset];
    return tp;
  });

  self.getOffset().fetch(offsetPayload, function (error, result) {
    if (error) {
      return callback(error);
    }
    self.defaultOffsets = _.mapValues(result, function (partitionOffsets) {
      return _.mapValues(partitionOffsets, _.head);
    });
    callback(null);
  });
};

ConsumerGroup.prototype.handleSyncGroup = function (syncGroupResponse, callback) {
  logger.debug('SyncGroup Response');
  var self = this;
  var ownedTopics = Object.keys(syncGroupResponse.partitions);
  if (ownedTopics.length) {
    logger.debug('%s owns topics: ', self.client.clientId, syncGroupResponse.partitions);

    var topicPartitionList = createTopicPartitionList(syncGroupResponse.partitions);
    var useDefaultOffsets = self.options.fromOffset in ACCEPTED_FROM_OFFSET;

    async.waterfall([
      function (callback) {
        self.fetchOffset(syncGroupResponse.partitions, callback);
      },
      function (offsets, callback) {
        logger.debug('%s fetchOffset Response: %j', self.client.clientId, offsets);

        var noOffset = topicPartitionList.some(function (tp) {
          return offsets[tp.topic][tp.partition] === -1;
        });

        if (noOffset) {
          logger.debug('No saved offsets');

          if (self.options.fromOffset === 'none') {
            return callback(new Error(self.client.clientId + ' owns topics and partitions which contains no saved offsets for group "'+ self.options.groupId + '" '));
          }

          async.parallel([
            function (callback) {
              if (self.migrator) {
                return self.migrator.saveHighLevelConsumerOffsets(topicPartitionList, callback);
              }
              callback(null);
            },
            function (callback) {
              if (useDefaultOffsets) {
                return self.saveDefaultOffsets(topicPartitionList, callback);
              }
              callback(null);
            }
          ], function (error) {
            if (error) {
              return callback(error);
            }
            logger.debug('%s defaultOffset Response for %s: %j', self.client.clientId, self.options.fromOffset, self.defaultOffsets);
            callback(null, offsets);
          });
        } else {
          logger.debug('Has saved offsets');
          callback(null, offsets);
        }
      },
      function (offsets, callback) {
        self.topicPayloads = self.buildPayloads(topicPartitionList).map(function (p) {
          var offset = offsets[p.topic][p.partition];
          if (offset === -1) { // -1 means no offset was saved for this topic/partition combo
            offset = useDefaultOffsets ? self.getDefaultOffset(p, 0) : 0;
            if (self.migrator) {
              offset = self.migrator.getOffset(p, offset);
            }
          }
          p.offset = offset;
          return p;
        });
        callback(null, true);
      }
    ], callback);
  } else { // no partitions assigned
    callback(null, false);
  }
};

ConsumerGroup.prototype.getDefaultOffset = function (tp, defaultOffset) {
  return _.get(this.defaultOffsets, [tp.topic, tp.partition], defaultOffset);
};

ConsumerGroup.prototype.getOffset = function () {
  if (this.offset) {
    return this.offset;
  }
  this.offset = new Offset(this.client);
  // we can ignore this since we are already forwarding error event emitted from client
  this.offset.on('error', _.noop);
  return this.offset;
};

function emptyStrIfNull (value) {
  return value == null ? '' : value;
}

ConsumerGroup.prototype.connect = function () {
  if (this.connecting) {
    logger.warn('Connect ignored. Currently connecting.');
    return;
  }

  logger.debug('Connecting %s', this.client.clientId);
  var self = this;

  this.connecting = true;
  this.emit('rebalancing');

  async.waterfall([
    function (callback) {
      if (self.client.coordinatorId) {
        return callback(null, null);
      }
      self.client.sendGroupCoordinatorRequest(self.options.groupId, callback);
    },

    function (coordinatorInfo, callback) {
      logger.debug('GroupCoordinator Response:', coordinatorInfo);
      if (coordinatorInfo) {
        self.setCoordinatorId(coordinatorInfo.coordinatorId);
      }
      self.client.sendJoinGroupRequest(self.options.groupId, emptyStrIfNull(self.memberId), self.options.sessionTimeout, self.protocols, callback);
    },

    function (joinGroupResponse, callback) {
      self.handleJoinGroup(joinGroupResponse, callback);
    },

    function (groupAssignment, callback) {
      logger.debug('SyncGroup Request from %s', self.memberId);
      self.client.sendSyncGroupRequest(self.options.groupId, self.generationId, self.memberId, groupAssignment, callback);
    },

    function (syncGroupResponse, callback) {
      self.handleSyncGroup(syncGroupResponse, callback);
    }
  ], function (error, startFetch) {
    self.connecting = false;
    self.rebalancing = false;
    if (error) {
      return self.recovery.tryToRecoverFrom(error, 'connect');
    }

    self.ready = true;
    self.recovery.clearError();

    logger.debug('generationId', self.generationId);

    if (startFetch) {
      self.fetch();
    }
    self.startHeartbeats();
    self.emit('connect');
    self.emit('rebalanced');
  });
};

ConsumerGroup.prototype.scheduleReconnect = function (timeout) {
  assert(timeout);
  this.rebalancing = true;

  if (this.reconnectTimer) {
    clearTimeout(this.reconnectTimer);
  }

  var self = this;
  this.reconnectTimer = setTimeout(function () {
    self.reconnectTimer = null;
    self.connect();
  }, timeout);
};

ConsumerGroup.prototype.startHeartbeats = function () {
  assert(this.options.sessionTimeout > 0);
  assert(this.ready, 'consumerGroup is not ready');

  var heartbeatIntervalMs = this.options.heartbeatInterval || (Math.floor(this.options.sessionTimeout / 3));

  logger.debug('%s started heartbeats at every %d ms', this.client.clientId, heartbeatIntervalMs);
  this.stopHeartbeats();

  var heartbeat = this.sendHeartbeat();

  this.heartbeatInterval = setInterval(function () {
    // only send another heartbeat if we got a response from the last one
    if (heartbeat.verifyResolved()) {
      heartbeat = this.sendHeartbeat();
    }
  }, heartbeatIntervalMs);
};

ConsumerGroup.prototype.stopHeartbeats = function () {
  this.heartbeatInterval && clearInterval(this.heartbeatInterval);
};

ConsumerGroup.prototype.leaveGroup = function (callback) {
  logger.debug('%s leaving group', this.client.clientId);
  var self = this;
  this.stopHeartbeats();
  if (self.generationId != null && self.memberId) {
    this.client.sendLeaveGroupRequest(this.options.groupId, this.memberId, function (error) {
      self.generationId = null;
      callback(error);
    });
  } else {
    callback(null);
  }
};

ConsumerGroup.prototype.sendHeartbeat = function () {
  assert(this.memberId, 'invalid memberId');
  assert(this.generationId >= 0, 'invalid generationId');
  // logger.debug('%s ❤️  ->', this.client.clientId);
  var self = this;

  function heartbeatCallback (error) {
    if (error) {
      logger.warn('%s Heartbeat error:', self.client.clientId, error);
      self.recovery.tryToRecoverFrom(error, 'heartbeat');
    }
    // logger.debug('%s 💚 <-', self.client.clientId, error);
  }

  var heartbeat = new Heartbeat(this.client, heartbeatCallback);
  heartbeat.send(this.options.groupId, this.generationId, this.memberId);

  return heartbeat;
};

ConsumerGroup.prototype.fetchOffset = function (payloads, cb) {
  this.client.sendOffsetFetchV1Request(this.options.groupId, payloads, cb);
};

ConsumerGroup.prototype.sendOffsetCommitRequest = function (commits, cb) {
  if (this.generationId && this.memberId) {
    this.client.sendOffsetCommitV2Request(this.options.groupId, this.generationId, this.memberId, commits, cb);
  } else {
    cb(null, 'Nothing to be committed');
  }
};

ConsumerGroup.prototype.close = function (force, cb) {
  var self = this;
  this.ready = false;

  this.stopHeartbeats();

  if (typeof force === 'function') {
    cb = force;
    force = false;
  }

  async.series([
    function (callback) {
      if (force) {
        self.commit(true, callback);
        return;
      }
      callback(null);
    },
    function (callback) {
      self.leaveGroup(function (error) {
        if (error) {
          logger.error('Leave group failed with', error);
        }
        callback(null);
      });
    },
    function (callback) {
      self.client.close(callback);
    }
  ], cb);
};

module.exports = ConsumerGroup;
