'use strict';
// Standalone diagnostic for the parallel/test-stream-pipeline-http2 flake.
// No node checkout needed - runs against any downloaded node binary.
//
// The test logic is identical to test/parallel/test-stream-pipeline-http2.js;
// the mustCall/mustCallAtLeast helpers are inlined so ../common is not needed.
// Everything else only observes.
//
// Exit codes:
//   0  = passed normally
//   99 = HUNG (watchdog fired; state dumped) - the CI failure mode
//   1  = a mustCall expectation was not met
//
// Usage:
//   node pipeline-http2-diag-standalone.js
//   PIPELINE_DIAG_MS=30000 node pipeline-http2-diag-standalone.js
const { Readable, pipeline } = require('stream');
const http2 = require('http2');

const WATCHDOG_MS = Number(process.env.PIPELINE_DIAG_MS || 30000);
const t0 = Date.now();

// On a released binary the 4MB/32MB defaults do not exist yet (the change is
// semver-major and unreleased), so EMULATE=1 applies them via public API.
// Fidelity note: initialWindowSize is a SETTINGS parameter and is applied in
// advance exactly as the real change does. The 32MB *connection* window is not
// - the real change sets it in the Http2Session constructor before any frames,
// whereas setLocalWindowSize can only run once the session exists, after the
// initial WINDOW_UPDATE has gone out. So this is faithful per-stream, only
// approximate at the connection level.
const NATIVE = http2.constants.DEFAULT_SETTINGS_INITIAL_WINDOW_SIZE === 4194304;
const EMULATE = process.env.EMULATE === '1' && !NATIVE;
const STREAM_WINDOW = 4194304;
const CONN_WINDOW = 33554432;
const serverOpts = EMULATE ? { settings: { initialWindowSize: STREAM_WINDOW } } : {};
const clientOpts = EMULATE ? { settings: { initialWindowSize: STREAM_WINDOW } } : {};

// --- minimal ../common shims -------------------------------------------------
const pending = [];
function mustCall(fn, exact = 1) {
  const rec = { fn, want: exact, atLeast: false, got: 0, name: fn.name || 'anon' };
  pending.push(rec);
  return function(...args) { rec.got++; return fn.apply(this, args); };
}
function mustCallAtLeast(fn, min = 1) {
  const rec = { fn, want: min, atLeast: true, got: 0, name: fn.name || 'anon' };
  pending.push(rec);
  return function(...args) { rec.got++; return fn.apply(this, args); };
}
process.on('exit', (code) => {
  if (code !== 0) return;
  for (const r of pending) {
    const ok = r.atLeast ? r.got >= r.want : r.got === r.want;
    if (!ok) {
      console.error(`mustCall failure: got ${r.got}, wanted ${r.atLeast ? '>=' : '=='} ${r.want}`);
      process.exitCode = 1;
    }
  }
});
// -----------------------------------------------------------------------------

const seen = {
  nodeVersion: process.version,
  defaultInitialWindowSize: http2.constants.DEFAULT_SETTINGS_INITIAL_WINDOW_SIZE,
  windowChangeNative: NATIVE,
  emulatingWindowChange: EMULATE,
  serverHandlerCalled: false,
  serverPipelineCb: null,        // null = never fired
  clientPipelineCb: null,        // null = never fired  <-- the 2018 stall signature
  dataEvents: 0,
  bytesIn: 0,
  rsPushes: 0,
  rsDestroyedAt: null,
  serverCloseCalled: false,
  clientCloseCalled: false,
};

let clientSession = null, serverSession = null;
let clientReq = null, serverReq = null, serverRes = null;

const streamInfo = (s) => s && ({
  destroyed: s.destroyed, closed: s.closed,
  readableEnded: s.readableEnded, writableEnded: s.writableEnded,
  writableFinished: s.writableFinished, readableFlowing: s.readableFlowing,
  writableLength: s.writableLength, readableLength: s.readableLength,
  rstCode: s.rstCode, pending: s.pending,
});
const sessionInfo = (s) => {
  if (!s) return null;
  let state = null;
  try { state = s.state; } catch { /* destroyed */ }
  return { destroyed: s.destroyed, closed: s.closed, state };
};

const watchdog = setTimeout(() => {
  console.error(`=== HUNG: still alive after ${Date.now() - t0} ms ===`);
  console.error(JSON.stringify({
    seen,
    clientReq: streamInfo(clientReq),
    serverReq: streamInfo(serverReq),
    serverRes: streamInfo(serverRes),
    clientSession: sessionInfo(clientSession),
    serverSession: sessionInfo(serverSession),
    handles: process._getActiveHandles().map((h) => h.constructor.name),
    requests: process._getActiveRequests().map((r) => r.constructor.name),
  }, null, 2));
  process.exit(99);
}, WATCHDOG_MS);
watchdog.unref();

{
  const server = http2.createServer(serverOpts, mustCallAtLeast((req, res) => {
    seen.serverHandlerCalled = true;
    serverReq = req; serverRes = res; serverSession = req.stream.session;
    if (EMULATE) {
      try { serverSession.setLocalWindowSize(CONN_WINDOW); } catch { /* already up */ }
    }
    pipeline(req, res, mustCall((err) => {
      seen.serverPipelineCb = { at: Date.now() - t0, err: err && err.code };
    }));
  }));

  server.listen(0, mustCall(() => {
    const url = `http://localhost:${server.address().port}`;
    const client = http2.connect(url, clientOpts);
    clientSession = client;
    if (EMULATE) {
      client.on('connect', () => client.setLocalWindowSize(CONN_WINDOW));
    }
    const req = client.request({ ':method': 'POST' });
    clientReq = req;

    const rs = new Readable({
      read() {
        seen.rsPushes++;
        rs.push('hello');
      }
    });

    pipeline(rs, req, mustCall((err) => {
      seen.clientPipelineCb = { at: Date.now() - t0, err: err && err.code };
      server.close();
      seen.serverCloseCalled = true;
      client.close();
      seen.clientCloseCalled = true;
    }));

    let cnt = 10;
    req.on('data', (data) => {
      seen.dataEvents++;
      seen.bytesIn += data.length;
      cnt--;
      if (cnt === 0) {
        seen.rsDestroyedAt = Date.now() - t0;
        rs.destroy();
      }
    });
  }));
}
