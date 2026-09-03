// Flags: --experimental-quic --no-warnings --expose-internals

import { hasQuic, skip, mustCall } from '../common/index.mjs';
import assert from 'node:assert';
import * as fixtures from '../common/fixtures.mjs';

if (!hasQuic) {
  skip('QUIC is not enabled');
}

const { listen, connect } = await import('node:quic');
const { createPrivateKey } = await import('node:crypto');

const key = createPrivateKey(fixtures.readKey('agent1-key.pem'));
const cert = fixtures.readKey('agent1-cert.pem');

// Test that negotiating the h3 ALPN does not itself activate HTTP/3: the
// ALPN is reported, and HTTP/3 is only installed via the HTTP/3 API.

const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const { getQuicSessionState } = require('internal/quic/quic');

const serverOpened = Promise.withResolvers();

const serverEndpoint = await listen(mustCall(async (serverSession) => {
  // No application selected yet (type 0), so a wrap is still possible.
  assert.strictEqual(serverSession.alpnProtocol, 'h3');
  assert.strictEqual(getQuicSessionState(serverSession).applicationType, 0);
  const info = await serverSession.opened;
  assert.strictEqual(info.protocol, 'h3');
  serverOpened.resolve();
  serverSession.close();
}), {
  alpn: ['h3'],
  sni: { '*': { keys: [key], certs: [cert] } },
});

assert.notStrictEqual(serverEndpoint.address, undefined);

const clientSession = await connect(serverEndpoint.address, {
  alpn: 'h3',
  servername: 'localhost',
  verifyPeer: 'manual',
  // Ignored: the application is chosen internally, never by the user.
  application: 'http3',
});

async function checkClient() {
  const info = await clientSession.opened;
  assert.strictEqual(info.protocol, 'h3');
  // No HTTP/3 attach happened, so the default application (type 1) is used.
  assert.strictEqual(getQuicSessionState(clientSession).applicationType, 1);
}

await Promise.all([serverOpened.promise, checkClient()]);
await clientSession.close();
await serverEndpoint.close();
