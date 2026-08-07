'use strict';
// Diagnostic for the parallel/test-stream-pipeline-http2 flake.
// No node checkout needed - runs against any node binary.
//
// The test logic is identical to test/parallel/test-stream-pipeline-http2.js;
// mustCall/mustCallAtLeast are inlined so ../common is not required.
//
// Hypothesis under test: both peers deadlock at the socket layer.
// Http2Session::MaybeStopReading() stops reading while a write is in progress
// (added in ba624b6766f to mitigate CVE-2019-9511/9517). With the 4MB/32MB
// default windows both peers can fill both socket send buffers, so both stop
// reading, and neither uv_write can ever drain.
//
// To confirm that we need to show, at the socket level, that NOTHING moves:
// bytesRead is handle-backed (StreamResource::bytes_read_) so it still tracks
// C++-level reads even though http2 has consumed the socket, which makes it a
// direct read-side probe. Samples are taken continuously and dumped on hang.
//
// Exit codes: 0 = passed, 99 = HUNG (state dumped), 1 = mustCall not met.
const { Readable, pipeline } = require('stream');
const http2 = require('http2');

const WATCHDOG_MS = Number(process.env.PIPELINE_DIAG_MS || 30000);
const SAMPLE_MS = Number(process.env.PIPELINE_SAMPLE_MS || 500);
const KEEP_SAMPLES = Number(process.env.PIPELINE_KEEP_SAMPLES || 12);
const t0 = Date.now();

// On a released binary the 4MB/32MB defaults do not exist yet, so EMULATE=1
// applies them via public API. Faithful per-stream (SETTINGS), only
// approximate at the connection level (setLocalWindowSize cannot run before
// the session exists).
const NATIVE = http2.constants.DEFAULT_SETTINGS_INITIAL_WINDOW_SIZE === 4194304;
const EMULATE = process.env.EMULATE === '1' && !NATIVE;
const STREAM_WINDOW = 4194304;
const CONN_WINDOW = 33554432;
const serverOpts = EMULATE ? { settings: { initialWindowSize: STREAM_WINDOW } } : {};
const clientOpts = EMULATE ? { settings: { initialWindowSize: STREAM_WINDOW } } : {};

// --- minimal ../common shims -------------------------------------------------
const pendingCalls = [];
function mustCall(fn, exact = 1) {
  const rec = { want: exact, atLeast: false, got: 0 };
  pendingCalls.push(rec);
  return function(...args) { rec.got++; return fn.apply(this, args); };
}
function mustCallAtLeast(fn, min = 1) {
  const rec = { want: min, atLeast: true, got: 0 };
  pendingCalls.push(rec);
  return function(...args) { rec.got++; return fn.apply(this, args); };
}
process.on('exit', (code) => {
  if (code !== 0) return;
  for (const r of pendingCalls) {
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
  serverPipelineCb: null,
  clientPipelineCb: null,
  dataEvents: 0,
  bytesIn: 0,
  rsPushes: 0,
  rsDestroyedAt: null,
  serverCloseCalled: false,
  clientCloseCalled: false,
};

let clientSession = null, serverSession = null;
let clientReq = null, serverReq = null, serverRes = null;
let clientSocket = null, serverSocket = null;

const streamInfo = (s) => s && ({
  destroyed: s.destroyed, closed: s.closed,
  readableEnded: s.readableEnded, writableEnded: s.writableEnded,
  writableFinished: s.writableFinished, readableFlowing: s.readableFlowing,
  writableLength: s.writableLength, readableLength: s.readableLength,
  writableNeedDrain: s.writableNeedDrain,
  rstCode: s.rstCode, pending: s.pending,
});
const sessionInfo = (s) => {
  if (!s) return null;
  let state = null;
  try { state = s.state; } catch { /* destroyed */ }
  return { destroyed: s.destroyed, closed: s.closed, state };
};
const sockNum = (sock, prop) => {
  if (!sock) return null;
  try { return sock[prop]; } catch { return 'ERR'; }
};

// Continuous sampling: the point is to show every counter frozen while both
// peers still have data to send and window to send it in.
const samples = [];
function sample() {
  let cRecv = null, sRecv = null, cRemoteWin = null, sRemoteWin = null;
  try { cRecv = clientSession.state.effectiveRecvDataLength; } catch { /* ignore */ }
  try { sRecv = serverSession.state.effectiveRecvDataLength; } catch { /* ignore */ }
  try { cRemoteWin = clientSession.state.remoteWindowSize; } catch { /* ignore */ }
  try { sRemoteWin = serverSession.state.remoteWindowSize; } catch { /* ignore */ }
  samples.push({
    ms: Date.now() - t0,
    dataEvents: seen.dataEvents,
    rsPushes: seen.rsPushes,
    // handle-backed, so these still move even though http2 consumed the socket
    clientSockBytesRead: sockNum(clientSocket, 'bytesRead'),
    serverSockBytesRead: sockNum(serverSocket, 'bytesRead'),
    clientSockBytesWritten: sockNum(clientSocket, 'bytesWritten'),
    serverSockBytesWritten: sockNum(serverSocket, 'bytesWritten'),
    clientSessRecv: cRecv,
    serverSessRecv: sRecv,
    clientRemoteWindow: cRemoteWin,
    serverRemoteWindow: sRemoteWin,
    clientReqWritableLen: clientReq ? clientReq.writableLength : null,
    serverResWritableLen: serverRes ? serverRes.writableLength : null,
    activeRequests: process._getActiveRequests().map((r) => r.constructor.name),
  });
  if (samples.length > KEEP_SAMPLES) samples.shift();
}
const sampler = setInterval(sample, SAMPLE_MS);
sampler.unref();

const watchdog = setTimeout(() => {
  sample();
  const first = samples[0] || {};
  const last = samples[samples.length - 1] || {};
  const frozen = (k) => first[k] !== undefined && first[k] === last[k];
  console.error(`=== HUNG: still alive after ${Date.now() - t0} ms ===`);
  console.error(JSON.stringify({
    seen,
    // The headline: if these are all true over the sample window, nothing at
    // the socket layer moved while both peers still wanted to send.
    frozenOverSampleWindow: {
      spanMs: (last.ms || 0) - (first.ms || 0),
      clientSockBytesRead: frozen('clientSockBytesRead'),
      serverSockBytesRead: frozen('serverSockBytesRead'),
      clientSessRecv: frozen('clientSessRecv'),
      serverSessRecv: frozen('serverSessRecv'),
      dataEvents: frozen('dataEvents'),
      rsPushes: frozen('rsPushes'),
    },
    clientReq: streamInfo(clientReq),
    serverReq: streamInfo(serverReq),
    serverRes: streamInfo(serverRes),
    clientSession: sessionInfo(clientSession),
    serverSession: sessionInfo(serverSession),
    handles: process._getActiveHandles().map((h) => h.constructor.name),
    requests: process._getActiveRequests().map((r) => r.constructor.name),
    samples,
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
  // Raw sockets: session.socket is a restricted proxy, these are not.
  server.on('connection', (socket) => { serverSocket = socket; });

  server.listen(0, mustCall(() => {
    const url = `http://localhost:${server.address().port}`;
    const client = http2.connect(url, clientOpts);
    clientSession = client;
    client.on('connect', (sess, socket) => {
      clientSocket = socket;
      if (EMULATE) client.setLocalWindowSize(CONN_WINDOW);
    });
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
