'use strict';

require('mocha');
const chai = require('chai');
const should = chai.should();
const net = require('net');
const cls = require('../index.js');

describe('cls with net connection', () => {

  let namespace = cls.createNamespace('net');
  let testValue1;
  let testValue2;
  let testValue3;
  let testValue4;

  before(function(done) {

    let serverDone = false;
    let clientDone = false;

    namespace.run(() => {
      namespace.set('test', 'originalValue');

      let server;
      namespace.run(() => {
        namespace.set('test', 'newContextValue');

        server = net.createServer((socket) => {
          //namespace.bindEmitter(socket);

          testValue1 = namespace.get('test');

          socket.on('data', namespace.bind(() => {
            testValue2 = namespace.get('test');
            server.close();
            socket.end('GoodBye');

            serverDone = true;
            checkDone();
          }));

        });

        server.listen(() => {
          const address = server.address();
          namespace.run(() => {
            namespace.set('test', 'MONKEY');

            const client = net.connect(address.port, () => {
              //namespace.bindEmitter(client);
              testValue3 = namespace.get('test');
              client.write('Hello');

              client.on('data', () => {
                testValue4 = namespace.get('test');
                clientDone = true;
                checkDone();
              });

            });
          });
        });
      });
    });

    function checkDone() {
      if (serverDone && clientDone) {
        done();
      }
    }

  });

  it('value newContextValue', () => {
    should.exist(testValue1);
    testValue1.should.equal('newContextValue');
  });

  it('value newContextValue 2', () => {
    should.exist(testValue2);
    testValue2.should.equal('newContextValue');
  });

  it('value MONKEY', () => {
    should.exist(testValue3);
    testValue3.should.equal('MONKEY');
  });

  it('value MONKEY 2', () => {
    should.exist(testValue4);
    testValue4.should.equal('MONKEY');
  });

});
