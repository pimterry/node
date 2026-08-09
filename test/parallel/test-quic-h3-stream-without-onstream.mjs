// Flags: --experimental-quic --experimental-stream-iter --no-warnings

// Test: incoming stream consumer checks.
// A session with no stream consumer destroys incoming streams on arrival
// (and emits a warning), so unconsumed streams cannot accumulate and hold
// flow control credit. Wrapping a session in an Http3Session makes the
// HTTP/3 layer the consumer: request streams are kept and driven through
// the Http3Session's onstream handler even though the underlying QUIC
// session's onstream slot was never set by the user.
// Refs: https://github.com/nodejs/node/issues/64192

import { hasQuic, skip, mustCall } from '../common/index.mjs';
import assert from 'node:assert';
import * as fixtures from '../common/fixtures.mjs';

if (!hasQuic) {
  skip('QUIC is not enabled');
}

const { listen, connect, Http3Session } = await import('node:quic');
const { createPrivateKey } = await import('node:crypto');
const { text } = await import('stream/iter');

const key = createPrivateKey(fixtures.readKey('agent1-key.pem'));
const cert = fixtures.readKey('agent1-cert.pem');
const sni = { '*': { keys: [key], certs: [cert] } };

// The consumer warning must never fire in the first block (the HTTP/3
// layer is the consumer) and must fire in the second (no consumer).
// common.expectWarning is not usable here: importing node:quic emits
// ExperimentalWarning, which it would reject as unexpected.
const kWarning =
  'A new stream was received but no onstream callback was provided';
function failOnConsumerWarning(warning) {
  assert.notStrictEqual(warning.message, kWarning);
}

// --- An h3 request completes with the HTTP/3 layer as the consumer ---
{
  process.on('warning', failOnConsumerWarning);
  const serverDone = Promise.withResolvers();

  const serverEndpoint = await listen(mustCall((quicSession) => {
    quicSession.onerror = () => {};
    const session = new Http3Session(quicSession);
    session.onstream = mustCall((stream) => {
      stream.onheaders = mustCall(function(headers) {
        assert.strictEqual(headers[':path'], '/test');
        stream.sendHeaders({
          ':status': '200',
          'content-type': 'text/plain',
        });
        const w = stream.writer;
        w.writeSync('kept without onstream');
        w.endSync();
        serverDone.resolve();
      });
    });
  }), { sni, alpn: ['h3'] });

  const clientSession = new Http3Session(await connect(serverEndpoint.address, {
    servername: 'localhost',
    verifyPeer: 'manual',
    alpn: 'h3',
  }));
  await clientSession.opened;

  const headersReceived = Promise.withResolvers();
  const stream = await clientSession.request({
    ':method': 'GET',
    ':path': '/test',
    ':scheme': 'https',
    ':authority': 'localhost',
  }, {
    onheaders: mustCall((headers) => {
      assert.strictEqual(headers[':status'], 200);
      headersReceived.resolve();
    }),
  });

  await headersReceived.promise;
  const body = await text(stream);
  assert.strictEqual(body, 'kept without onstream');

  await serverDone.promise;
  await clientSession.close();
  await serverEndpoint.close();
  process.off('warning', failOnConsumerWarning);
}

// --- A session with no consumer destroys incoming streams ---
// A raw QUIC session with no onstream callback has no way to observe an
// incoming stream, so it is destroyed with the warning.
{
  // Awaiting warned.promise is the assertion: the test times out if the
  // warning never fires.
  const warned = Promise.withResolvers();
  process.on('warning', function onWarning(warning) {
    if (warning.message === kWarning) {
      process.off('warning', onWarning);
      warned.resolve();
    }
  });

  const serverEndpoint = await listen(mustCall((serverSession) => {
    serverSession.onerror = () => {};
  }), { sni, alpn: ['test-proto'] });

  const clientSession = await connect(serverEndpoint.address, {
    servername: 'localhost',
    alpn: 'test-proto',
    verifyPeer: 'manual',
  });
  await clientSession.opened;

  const stream = await clientSession.createUnidirectionalStream();
  stream.writer.writeSync('x');

  await warned.promise;
  await clientSession.close();
  await serverEndpoint.close();
}
