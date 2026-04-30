// Instrumented version of test/parallel/test-http2-close-while-writing.js.
//
// Logs every relevant event with a timestamp. If nothing finishes the test
// within HANG_TIMEOUT_MS, dumps the full state to stderr and exits with code
// 99 so the wrapper script can distinguish hangs from other failures.
//
// Designed to discriminate between the hypotheses:
//   H1: server stream becomes a zombie (writableFinished false), preventing
//       its destroy and keeping its session alive.
//   H2: server's first 'data' event never fires, so client_stream.destroy()
//       is never invoked and 'close' on client_stream never fires.
//   H3: 'close' fires on client_stream but cleanup (server.close()/client.close())
//       never completes.
//
// Each hypothesis has a distinct fingerprint in the dump:
//   H1: clientStreamCloseFired === true, serverStreamCloseFired === false,
//       serverWriteCallbackCount < serverWriteCount
//   H2: serverDataCount === 0, clientStreamCloseFired === false
//   H3: clientStreamCloseFired === true, serverClosed === false (or
//       clientClosed === false)

'use strict';

const path = require('path');
const http2 = require('http2');

// Resolve fixtures from the working tree we are running from.
const TEST_DIR = path.resolve(__dirname, '..', '..', 'test');
const fixtures = require(path.join(TEST_DIR, 'common', 'fixtures.js'));

const key = fixtures.readKey('agent8-key.pem', 'binary');
const cert = fixtures.readKey('agent8-cert.pem', 'binary');
const ca = fixtures.readKey('fake-startcom-root-cert.pem', 'binary');

const HANG_TIMEOUT_MS = parseInt(process.env.HANG_TIMEOUT_MS || '15000', 10);
const APPLY_FIX = process.env.APPLY_FIX === '1';
const start = Date.now();
const events = [];

function log(msg) {
  events.push(`+${(Date.now() - start).toString().padStart(5, ' ')}ms ${msg}`);
}

let serverDataCount = 0;
let serverWriteCount = 0;
let serverWriteCallbackCount = 0;
let serverWriteCallbackErrors = [];
let clientWriteCallbackCount = 0;
let clientWriteCallbackErr = null;
let clientStreamCloseFired = false;
let serverStreamCloseFired = false;
let serverStreamRef = null;
let clientStreamRef = null;
let serverSessionRef = null;
let clientSessionRef = null;
let serverListening = true;
let serverClosed = false;
let clientClosed = false;
let firstDataAt = null;

function describeStream(label, s) {
  if (!s) return { [label]: null };
  const out = { [label]: {} };
  try { out[label].destroyed = s.destroyed; } catch {}
  try { out[label].closed = s.closed; } catch {}
  try { out[label].aborted = s.aborted; } catch {}
  try { out[label].readable = s.readable; } catch {}
  try { out[label].writable = s.writable; } catch {}
  try { out[label].writableFinished = s.writableFinished; } catch {}
  try { out[label].writableEnded = s.writableEnded; } catch {}
  try { out[label].writableLength = s.writableLength; } catch {}
  try { out[label].readableEnded = s.readableEnded; } catch {}
  try { out[label].readableLength = s.readableLength; } catch {}
  try { out[label].id = s[Object.getOwnPropertySymbols(s).find((x) => String(x) === 'Symbol(id)')]; } catch {}
  return out;
}

function describeSession(label, s) {
  if (!s) return { [label]: null };
  const out = { [label]: {} };
  try { out[label].destroyed = s.destroyed; } catch {}
  try { out[label].closed = s.closed; } catch {}
  try { out[label].connecting = s.connecting; } catch {}
  return out;
}

function dumpAndExit(reason, code) {
  console.error(`HANG_DUMP_BEGIN reason=${reason}`);
  const dump = {
    reason,
    elapsedMs: Date.now() - start,
    serverDataCount,
    serverWriteCount,
    serverWriteCallbackCount,
    serverWriteCallbackErrors,
    clientWriteCallbackCount,
    clientWriteCallbackErr,
    clientStreamCloseFired,
    serverStreamCloseFired,
    serverClosed,
    clientClosed,
    firstDataAt,
    activeHandles: process._getActiveHandles().length,
    activeRequests: process._getActiveRequests().length,
    activeHandleNames: process._getActiveHandles().map((h) => h.constructor && h.constructor.name).sort(),
    ...describeStream('clientStream', clientStreamRef),
    ...describeStream('serverStream', serverStreamRef),
    ...describeSession('clientSession', clientSessionRef),
    ...describeSession('serverSession', serverSessionRef),
    events,
  };
  console.error(JSON.stringify(dump, null, 2));
  console.error(`HANG_DUMP_END`);
  // Try to write a v8 diagnostic report too.
  try {
    if (process.report && typeof process.report.writeReport === 'function') {
      const rpt = process.report.writeReport(`/tmp/node-report-hang-${process.pid}.json`);
      console.error(`Diagnostic report: ${rpt}`);
    }
  } catch (e) {
    console.error(`writeReport failed: ${e && e.message}`);
  }
  process.exit(code);
}

const hangTimer = setTimeout(() => dumpAndExit('HANG_TIMEOUT', 99), HANG_TIMEOUT_MS);

const server = http2.createSecureServer({
  key,
  cert,
  maxSessionMemory: 1000,
});

server.on('session', (session) => {
  log('server: session');
  serverSessionRef = session;
  session.on('error', (e) => log(`server.session error: ${e && e.message}`));
  session.on('close', () => log('server.session close'));
  session.on('goaway', (...args) => log(`server.session goaway: ${JSON.stringify(args)}`));
  session.on('stream', (stream) => {
    log(`server.session stream id=${stream.id}`);
    serverStreamRef = stream;
    stream.on('aborted', () => log('server.stream aborted'));
    stream.on('close', () => {
      serverStreamCloseFired = true;
      log('server.stream close');
    });
    stream.on('error', (e) => log(`server.stream error: ${e && e.message}`));
    stream.on('finish', () => log('server.stream finish'));
    stream.on('end', () => log('server.stream end'));

    if (APPLY_FIX) {
      stream.once('data', function() {
        if (firstDataAt === null) firstDataAt = Date.now() - start;
        log(`server.stream data #${++serverDataCount} (once)`);
        this.resume();
        serverWriteCount++;
        const writeId = serverWriteCount;
        this.write(Buffer.alloc(1), (err) => {
          serverWriteCallbackCount++;
          if (err) serverWriteCallbackErrors.push({ id: writeId, code: err.code });
          log(`server.write[${writeId}] cb ${err ? err.code : 'ok'}`);
        });
        process.nextTick(() => {
          log(`server: nextTick destroy(client) #${serverDataCount}`);
          clientStreamRef.destroy();
        });
      });
    } else {
      stream.resume();
      stream.on('data', function() {
        if (firstDataAt === null) firstDataAt = Date.now() - start;
        log(`server.stream data #${++serverDataCount}`);
        serverWriteCount++;
        const writeId = serverWriteCount;
        this.write(Buffer.alloc(1), (err) => {
          serverWriteCallbackCount++;
          if (err) serverWriteCallbackErrors.push({ id: writeId, code: err.code });
          log(`server.write[${writeId}] cb ${err ? err.code : 'ok'}`);
        });
        process.nextTick(() => {
          log(`server: nextTick destroy(client) #${serverDataCount}`);
          clientStreamRef.destroy();
        });
      });
    }
  });
});

server.on('error', (e) => log(`server error: ${e && e.message}`));

server.listen(0, () => {
  log(`server listening on ${server.address().port}`);
  const client = http2.connect(`https://localhost:${server.address().port}`, {
    ca,
    maxSessionMemory: 1000,
  });
  clientSessionRef = client;
  client.on('error', (e) => log(`client.session error: ${e && e.message}`));
  client.on('close', () => log('client.session close'));
  client.on('connect', () => log('client.session connect'));
  client.on('goaway', (...args) => log(`client.session goaway: ${JSON.stringify(args)}`));

  const stream = client.request({ ':method': 'POST' });
  clientStreamRef = stream;
  stream.on('aborted', () => log('client.stream aborted'));
  stream.on('end', () => log('client.stream end'));
  stream.on('error', (e) => log(`client.stream error: ${e && e.message}`));
  stream.on('finish', () => log('client.stream finish'));
  stream.on('response', (h) => log(`client.stream response: ${JSON.stringify(h)}`));
  stream.on('close', () => {
    log('client.stream close');
    clientStreamCloseFired = true;
    client.close(() => {
      clientClosed = true;
      log('client.close cb');
    });
    server.close(() => {
      serverClosed = true;
      log('server.close cb');
      // Everything finished cleanly.
      clearTimeout(hangTimer);
      // Surface a concise success summary on stderr so the wrapper can grep.
      console.error(`SUCCESS dataCount=${serverDataCount} ` +
                    `writeCount=${serverWriteCount} ` +
                    `writeCb=${serverWriteCallbackCount} ` +
                    `clientCb=${clientWriteCallbackCount}`);
    });
    // If client.close + server.close don't trigger their callbacks, the
    // hang timer still catches it and dumps state with serverClosed=false.
  });
  stream.resume();
  stream.write(Buffer.alloc(64 * 1024), (err) => {
    clientWriteCallbackCount++;
    if (err) clientWriteCallbackErr = err.code;
    log(`client.write cb ${err ? err.code : 'ok'}`);
  });
});

process.on('uncaughtException', (e) => {
  log(`uncaughtException: ${e && e.stack}`);
  dumpAndExit('uncaughtException', 1);
});
process.on('unhandledRejection', (e) => {
  log(`unhandledRejection: ${e}`);
  dumpAndExit('unhandledRejection', 1);
});
