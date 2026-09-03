// Flags: --experimental-quic --no-warnings

// Test: QuicStream/QuicSession expose no HTTP/3 surface, whatever the
// negotiated ALPN. The HTTP/3 layer reaches those members through internal
// symbols instead.

import { hasQuic, skip, mustCall } from '../common/index.mjs';
import assert from 'node:assert';
import * as fixtures from '../common/fixtures.mjs';

if (!hasQuic) {
  skip('QUIC is not enabled');
}

const { listen, connect, QuicStream, QuicSession } = await import('node:quic');
const { createPrivateKey } = await import('node:crypto');

const key = createPrivateKey(fixtures.readKey('agent1-key.pem'));
const cert = fixtures.readKey('agent1-cert.pem');
const encoder = new TextEncoder();

for (const name of ['sendHeaders', 'sendInformationalHeaders', 'sendTrailers',
                    'headers', 'pendingTrailers', 'onheaders', 'oninfo',
                    'ontrailers', 'onwanttrailers']) {
  assert.strictEqual(Object.getOwnPropertyDescriptor(QuicStream.prototype, name),
                     undefined);
}
for (const name of ['ongoaway', 'onorigin']) {
  assert.strictEqual(Object.getOwnPropertyDescriptor(QuicSession.prototype, name),
                     undefined);
}

function assertNoH3Surface(stream) {
  assert.strictEqual(typeof stream.sendHeaders, 'undefined');
  assert.strictEqual(typeof stream.sendInformationalHeaders, 'undefined');
  assert.strictEqual(typeof stream.sendTrailers, 'undefined');
  assert.strictEqual(stream.headers, undefined);
  assert.strictEqual(stream.pendingTrailers, undefined);

  // The h3 callback names are inert expandos: no setter intercepts them.
  const inert = () => {};
  stream.onheaders = inert;
  assert.strictEqual(stream.onheaders, inert);
  delete stream.onheaders;
}

const serverDone = Promise.withResolvers();
const serverEndpoint = await listen(mustCall(async (serverSession) => {
  assert.strictEqual(typeof serverSession.ongoaway, 'undefined');
  assert.strictEqual(typeof serverSession.onorigin, 'undefined');
  serverSession.onstream = mustCall(async (stream) => {
    assertNoH3Surface(stream);

    stream.writer.endSync();

    serverSession.close();
    serverDone.resolve();
  });
}), {
  sni: { '*': { keys: [key], certs: [cert] } },
  alpn: 'quic-test',
});

const clientSession = await connect(serverEndpoint.address, {
  servername: 'localhost',
  verifyPeer: 'manual',
  alpn: 'quic-test',
});
await clientSession.opened;

assert.strictEqual(typeof clientSession.ongoaway, 'undefined');
assert.strictEqual(typeof clientSession.onorigin, 'undefined');

const stream = await clientSession.createBidirectionalStream({
  body: encoder.encode('ping'),
});

assertNoH3Surface(stream);

await serverDone.promise;
await clientSession.close();
await serverEndpoint.close();
