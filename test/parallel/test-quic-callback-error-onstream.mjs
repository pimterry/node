// Flags: --experimental-quic --experimental-stream-iter --no-warnings

// Test: callback error handling for onstream.
// Sync throw in onstream destroys the session.
// safeCallbackInvoke catches the throw and calls session.destroy(error).
// The error is delivered to the onerror callback.

import { hasQuic, skip, mustCall } from '../common/index.mjs';
import assert from 'node:assert';

if (!hasQuic) {
  skip('QUIC is not enabled');
}

const { listen, connect } = await import('../common/quic.mjs');

const encoder = new TextEncoder();

const testError = new Error('sync onstream throw');

const serverEndpoint = await listen(mustCall(async (serverSession) => {
  serverSession.onerror = mustCall((err) => {
    assert.strictEqual(err, testError);
  });

  serverSession.onstream = () => {
    throw testError;
  };

  // The session's closed rejects with the error from destroy().
  await assert.rejects(serverSession.closed, testError);
}), { transportParams: { maxIdleTimeout: 1 } });

const clientSession = await connect(serverEndpoint.address, {
  transportParams: { maxIdleTimeout: 1 },
});
await clientSession.opened;

// Send data to trigger onstream on the server.
const stream = await clientSession.createBidirectionalStream({
  body: encoder.encode('trigger onstream'),
});

// The server's destroy reaches us as a CONNECTION_CLOSE carrying the
// throw's message, so both the stream and the session report it.
const expected = { code: 'ERR_QUIC_TRANSPORT_ERROR', reason: testError.message };
await assert.rejects(stream.closed, expected);
await assert.rejects(clientSession.closed, expected);
await serverEndpoint.close();
