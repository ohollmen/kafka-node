'use strict';

const kafka = require('..');
const Client = kafka.KafkaClient;
const sinon = require('sinon');
const EventEmitter = require('events');
const TimeoutError = require('../lib/errors/TimeoutError');

describe('Kafka Client', function () {
  describe('#wrapTimeoutIfNeeded', function () {
    let sandbox, wrapTimeoutIfNeeded, client, clock;

    beforeEach(function () {
      sandbox = sinon.sandbox.create();
      clock = sandbox.useFakeTimers();
      client = {
        unqueueCallback: sandbox.stub(),
        options: {
          requestTimeout: false
        }
      };
      wrapTimeoutIfNeeded = Client.prototype.wrapTimeoutIfNeeded.bind(client);
    });

    afterEach(function () {
      sandbox.restore();
    });

    it('should not wrap if there is not a this.options.requestTimeout', function () {
      const myFn = function () {};
      const retFn = wrapTimeoutIfNeeded(1, 1, myFn);
      myFn.should.be.exactly(retFn);
    });

    it('should not yield timeout if returned callback is called in time', function (done) {
      client.options.requestTimeout = 400;
      const retFn = wrapTimeoutIfNeeded(1, 1, done);
      retFn.should.not.be.exactly(done);
      clock.tick(300);
      retFn();
      clock.tick(300);
    });

    it('should yield timeout error if not called by timeout', function (done) {
      client.options.requestTimeout = 400;
      function callback (error) {
        error.should.be.an.instanceOf(Error);
        error.message.should.be.exactly('Request timed out after 400ms');
        sinon.assert.calledWithExactly(client.unqueueCallback, 1, 10);
        done();
      }
      const retFn = wrapTimeoutIfNeeded(1, 10, callback);
      retFn.should.not.be.exactly(callback);
      clock.tick(400);
      retFn(new Error('BAD'));
    });
  });

  it('should connect plaintext', function (done) {
    const client = new Client({
      kafkaHost: 'localhost:9092'
    });
    client.once('ready', done);
  });

  it('should error when connecting to an invalid host', function (done) {
    const client = new Client({
      kafkaHost: 'localhost:9094'
    });

    client.on('error', function (error) {
      error.code.should.be.eql('ECONNREFUSED');
      done();
    });
  });

  it('should connect SSL', function (done) {
    const client = new Client({
      kafkaHost: 'localhost:9093',
      sslOptions: {
        rejectUnauthorized: false
      }
    });
    client.once('ready', done);
  });

  describe('Verify Timeout', function () {
    let sandbox;

    beforeEach(function () {
      sandbox = sinon.sandbox.create();
    });

    afterEach(function () {
      sandbox.restore();
    });

    it('should timeout when connect is not emitted', function (done) {
      const clock = sandbox.useFakeTimers();
      const client = new Client({
        autoConnect: false,
        kafkaHost: 'localhost:9093',
        sslOptions: {
          rejectUnauthorized: false
        }
      });

      sandbox.stub(client, 'setupBroker').returns({
        socket: new EventEmitter()
      });

      client.connect();
      client.once('error', function (error) {
        error.should.be.an.instanceOf(TimeoutError);
        done();
      });

      clock.tick(10000);
    });
  });
});
