// Measure the cost of consuming an incoming request body on the server.
//
// `classic` drives the IncomingMessage as a Readable ('data'/'end' events).
// `iter` reads it through stream/iter, which answers the streamable protocol
// with a source fed straight from the parser and never runs the stream
// lifecycle.
//
// Both modes do the same work for a given `op`, so what differs is the
// delivery path rather than what the handler does with the bytes:
//   stream   - consume and discard, as a proxy or a hash would
//   collect  - build the whole body, as a body parser would
//   ignore   - reply without reading it, as an auth rejection or a redirect
//              would; `mode` has no meaning here, since nothing reads
//
// The load generator runs in a child process so the measurement is the
// server's own cost, and requests are pipelined so the server stays saturated.
'use strict';

const common = require('../common.js');
const http = require('http');
const net = require('net');
const { fork } = require('child_process');

// Requests written per batch, enough to keep the server busy while a batch is
// in flight.
const PIPELINE = 64;

// Chunks are touched into this so neither arm can have its consume loop
// optimised away; both do the same negligible work per chunk.
let sink = 0;

function requestBytes(len) {
  if (len === 0)
    return Buffer.from('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n');
  return Buffer.concat([
    Buffer.from(`POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${len}\r\n\r\n`),
    Buffer.alloc(len, 120),
  ]);
}

// Child: pipeline requests at the server and throw the responses away.
if (process.env.NODE_BENCH_INCOMING_BODY_PORT) {
  const port = +process.env.NODE_BENCH_INCOMING_BODY_PORT;
  const batch = Buffer.concat(
    new Array(PIPELINE).fill(requestBytes(+process.env.NODE_BENCH_INCOMING_BODY_LEN)));
  const socket = net.connect(port, '127.0.0.1');
  socket.setNoDelay(true);
  socket.resume();
  socket.on('error', () => process.exit(0));
  socket.on('connect', function pump() {
    // Bounded per turn so the child keeps servicing its own socket.
    for (let i = 0; i < 8; i++) {
      if (!socket.write(batch)) return;
    }
    setImmediate(pump);
  });
  socket.on('drain', function pump() {
    for (let i = 0; i < 8; i++) {
      if (!socket.write(batch)) return;
    }
    setImmediate(pump);
  });
} else {
  const bench = common.createBenchmark(main, {
    mode: ['classic', 'iter'],
    op: ['stream', 'collect', 'ignore'],
    len: [0, 4, 1024, 65536],
    dur: [5],
  }, {
    flags: ['--experimental-stream-iter'],
  });

  module.exports = main;

  // Requests still in flight when the load generator is killed abort, and the
  // consumer sees that as a rejection. That is teardown; anything before it is
  // a real failure and must not be swallowed.
  let shuttingDown = false;
  function ignoreAbort(err) {
    if (!shuttingDown)
      throw err;
  }

  function main({ mode, op, len, dur }) {
    // Required here rather than at the top level: the module only exists under
    // --experimental-stream-iter, and the parent process that enumerates the
    // configurations runs without the benchmark's own flags.
    const { bytes, from } = require('stream/iter');

    let served = 0;

    function reply(res) {
      res.writeHead(200, { 'Content-Length': '2' });
      res.end('ok');
      served++;
    }

    const handlers = {
      // Nothing to consume; `iter` still asks for the streamable, as a
      // Fetch-shaped layer would for every request.
      'classic-empty': (req, res) => reply(res),
      'iter-empty': (req, res) => { from(req); reply(res); },

      'classic-stream': (req, res) => {
        req.on('error', ignoreAbort);
        req.on('data', (buf) => { sink += buf.length; });
        req.on('end', () => reply(res));
      },
      'iter-stream': (req, res) => {
        (async () => {
          for await (const chunks of from(req)) {
            for (const chunk of chunks) sink += chunk.length;
          }
          reply(res);
        })().catch(ignoreAbort);
      },

      // Nothing reads the body. The bytes still have to arrive and be
      // discarded, but no stream or source should be built for them.
      'classic-ignore': (req, res) => reply(res),
      'iter-ignore': (req, res) => reply(res),

      'classic-collect': (req, res) => {
        req.on('error', ignoreAbort);
        const chunks = [];
        req.on('data', (buf) => chunks.push(buf));
        req.on('end', () => { Buffer.concat(chunks); reply(res); });
      },
      'iter-collect': (req, res) => {
        bytes(req).then(() => reply(res), ignoreAbort);
      },
    };

    const key = len === 0 ? `${mode}-empty` : `${mode}-${op}`;
    const server = http.createServer(handlers[key]);

    server.listen(0, () => {
      const child = fork(__filename, [], {
        env: {
          ...process.env,
          NODE_BENCH_INCOMING_BODY_PORT: `${server.address().port}`,
          NODE_BENCH_INCOMING_BODY_LEN: `${len}`,
        },
      });

      // Let the connection come up and the paths warm before counting.
      setTimeout(() => {
        served = 0;
        bench.start();
        setTimeout(() => {
          bench.end(served);
          if (sink < 0) throw new Error('unreachable');
          shuttingDown = true;
          child.kill();
          server.close();
        }, dur * 1000);
      }, 1000);
    });
  }
}
