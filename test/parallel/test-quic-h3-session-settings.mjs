// Flags: --experimental-quic --experimental-stream-iter --no-warnings --expose-internals

// Test: http3Session.settings reports the effective HTTP/3 settings, as
// configured by the `settings` option or at dynamic attach, and null once
// the session closes.

import { hasQuic, skip, mustCall } from '../common/index.mjs';
import assert from 'node:assert';
import * as fixtures from '../common/fixtures.mjs';

if (!hasQuic) {
  skip('QUIC is not enabled');
}

const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const { getQuicSessionState } = require('internal/quic/quic');

const { listenHttp3: listen, connectHttp3: connect } = await import('node:quic');
const { createPrivateKey } = await import('node:crypto');

const key = createPrivateKey(fixtures.readKey('agent1-key.pem'));
const cert = fixtures.readKey('agent1-cert.pem');

// Applied to both peers: some values are confirmed by the peer's SETTINGS
// frame, so an identical config keeps what reads back stable.
const customSettings = {
  maxHeaderPairs: 50n,
  maxHeaderLength: 8192n,
  maxFieldSectionSize: 16384n,
  qpackMaxDTableCapacity: 2048n,
  qpackEncoderMaxDTableCapacity: 2048n,
  qpackBlockedStreams: 50n,
  enableConnectProtocol: false,
};

function checkSettings(settings, what) {
  assert.ok(settings != null, `${what} settings should be available`);
  assert.strictEqual(typeof settings, 'object');
  assert.strictEqual(Object.getPrototypeOf(settings), null);
  assert.strictEqual(settings.maxHeaderPairs, customSettings.maxHeaderPairs);
  assert.strictEqual(settings.maxHeaderLength, customSettings.maxHeaderLength);
  assert.strictEqual(settings.maxFieldSectionSize,
                     customSettings.maxFieldSectionSize);
  assert.strictEqual(settings.qpackMaxDTableCapacity,
                     customSettings.qpackMaxDTableCapacity);
  assert.strictEqual(settings.qpackEncoderMaxDTableCapacity,
                     customSettings.qpackEncoderMaxDTableCapacity);
  assert.strictEqual(settings.qpackBlockedStreams,
                     customSettings.qpackBlockedStreams);
  assert.strictEqual(settings.enableConnectProtocol,
                     customSettings.enableConnectProtocol);
}

const serverDone = Promise.withResolvers();

const serverEndpoint = await listen(mustCall((serverSession) => {
  serverSession.onstream = mustCall(async (stream) => {
    checkSettings(serverSession.settings, 'server');
    assert.strictEqual(
      getQuicSessionState(serverSession.session).applicationType, 2);
    assert.strictEqual(getQuicSessionState(serverSession.session).isServer, true);

    stream.onheaders = mustCall(() => {
      stream.sendHeaders({ ':status': '200' }, { terminal: true });
    });
    await stream.closed;
    serverSession.close();
    serverDone.resolve();
  });
}), {
  sni: { '*': { keys: [key], certs: [cert] } },
  settings: customSettings,
});

const clientSession = await connect(serverEndpoint.address, {
  servername: 'localhost',
  verifyPeer: 'manual',
  settings: customSettings,
});
await clientSession.opened;

checkSettings(clientSession.settings, 'client');
assert.strictEqual(getQuicSessionState(clientSession.session).applicationType, 2);
assert.strictEqual(getQuicSessionState(clientSession.session).isServer, false);

// Exchange a request to let the server side run its assertions.
const stream = await clientSession.request({
  ':method': 'GET',
  ':path': '/',
  ':scheme': 'https',
  ':authority': 'localhost',
});

// eslint-disable-next-line no-unused-vars
for await (const _ of stream) { /* drain */ }
await Promise.all([stream.closed, serverDone.promise]);

await clientSession.close();
assert.strictEqual(clientSession.settings, null);

await serverEndpoint.close();

// Settings passed to a dynamic attach apply the same way.
{
  const { listen: quicListen, connect: quicConnect } =
    await import('node:quic');
  const { Http3Session } = await import('node:quic');

  const serverChecked = Promise.withResolvers();
  const endpoint = await quicListen(mustCall((quicSession) => {
    const session = new Http3Session(quicSession, {
      settings: customSettings,
    });
    checkSettings(session.settings, 'dynamic server');
    session.onstream = mustCall(async (stream) => {
      stream.onheaders = mustCall(() => {
        stream.sendHeaders({ ':status': '200' }, { terminal: true });
      });
      await stream.closed;
      session.close();
      serverChecked.resolve();
    });
  }), { sni: { '*': { keys: [key], certs: [cert] } }, alpn: 'h3' });

  const client = new Http3Session(
    await quicConnect(endpoint.address, {
      servername: 'localhost',
      verifyPeer: 'manual',
      alpn: 'h3',
    }),
    { settings: customSettings });
  checkSettings(client.settings, 'dynamic client');

  const stream = await client.request({
    ':method': 'GET', ':path': '/', ':scheme': 'https',
    ':authority': 'localhost',
  });
  // eslint-disable-next-line no-unused-vars
  for await (const _ of stream) { /* drain */ }
  await Promise.all([stream.closed, serverChecked.promise]);
  await client.close();
  await endpoint.close();
}
