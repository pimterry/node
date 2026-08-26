// Flags: --experimental-stream-iter
'use strict';

// An IncomingMessage answers the stream/iter streamable protocol with a source
// fed straight from the HTTP parser, so consuming a request body with
// stream/iter never drives the Readable side of the message.

const common = require('../common');
const assert = require('assert');
const http = require('http');
const net = require('net');
const {
  bytes,
  from,
  text,
  toAsyncStreamable,
} = require('stream/iter');

const BIG = 'x'.repeat(4 * 1024 * 1024);

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, () => resolve(server.address().port));
  });
}

function request(port, options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, method: 'POST', ...options }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => out += chunk);
      res.on('end', () => resolve(out));
    });
    req.on('error', reject);
    if (Array.isArray(body)) {
      for (const piece of body) req.write(piece);
      req.end();
    } else {
      req.end(body);
    }
  });
}

// A body read with text() arrives intact, and the Readable is never driven.
async function testText() {
  const server = http.createServer(async (req, res) => {
    req.on('data', common.mustNotCall('Readable must not be driven'));
    req.on('end', common.mustNotCall('Readable must not be driven'));
    res.end(await text(req));
  });
  const port = await listen(server);
  const got = await request(port, {}, 'hello world');
  server.close();
  assert.strictEqual(got, 'hello world');
}

// Bodies past the high water mark exercise the pause/resume path.
async function testLargeBody() {
  const server = http.createServer(async (req, res) => {
    const body = await text(req);
    res.end(`${body.length}:${body === BIG}`);
  });
  const port = await listen(server);
  const got = await request(port, {}, BIG);
  server.close();
  assert.strictEqual(got, `${BIG.length}:true`);
}

// Chunked request bodies are delivered the same way.
async function testChunked() {
  const server = http.createServer(async (req, res) => {
    const encoding = req.headers['transfer-encoding'];
    const body = await bytes(req);
    res.end(`${encoding}:${body.byteLength}`);
  });
  const port = await listen(server);
  const got = await request(port, {}, ['abc', 'defg']);
  server.close();
  assert.strictEqual(got, 'chunked:7');
}

// A request with no body ends immediately rather than waiting for bytes.
async function testNoBody() {
  const server = http.createServer(async (req, res) => {
    res.end(`[${await text(req)}]`);
  });
  const port = await listen(server);
  const got = await request(port, { method: 'GET' });
  server.close();
  assert.strictEqual(got, '[]');
}

// Several bodies on one keep-alive connection stay separated.
async function testKeepAlive() {
  const server = http.createServer(async (req, res) => {
    const body = await text(req);
    res.end(body.toUpperCase());
  });
  const port = await listen(server);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const got = [];
  for (const word of ['one', 'two', 'three']) {
    got.push(await request(port, { agent }, word));
  }
  agent.destroy();
  server.close();
  assert.deepStrictEqual(got, ['ONE', 'TWO', 'THREE']);
}

// Asking for the streamable twice yields the same source, so a consumer cannot
// accidentally split the body across two readers.
async function testIdempotent() {
  const server = http.createServer(async (req, res) => {
    const first = req[toAsyncStreamable]();
    const second = req[toAsyncStreamable]();
    res.end(`${first === second}:${await text(req)}`);
  });
  const port = await listen(server);
  const got = await request(port, {}, 'same');
  server.close();
  assert.strictEqual(got, 'true:same');
}

// Frameworks assign to `req.body`. That must not be confused with the internal
// body source, which lives behind a symbol.
async function testUserBodyProperty() {
  const server = http.createServer(async (req, res) => {
    req.body = { parsed: true };
    const body = await text(req);
    res.end(`${body}:${req.body.parsed}`);
  });
  const port = await listen(server);
  const got = await request(port, {}, 'raw');
  server.close();
  assert.strictEqual(got, 'raw:true');
}

// Requests never handed to stream/iter keep the classic behaviour.
async function testClassicPath() {
  const server = http.createServer((req, res) => {
    let out = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => out += chunk);
    req.on('end', () => res.end(out));
  });
  const port = await listen(server);
  const got = await request(port, {}, 'classic');
  server.close();
  assert.strictEqual(got, 'classic');
}

// A handler that awaits before reading still gets the body: bytes the parser
// already pushed into the Readable are handed over, not stranded.
async function testDeferredRead() {
  const server = http.createServer(async (req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    res.end(await text(req));
  });
  const port = await listen(server);
  const got = await request(port, {}, 'deferred');
  server.close();
  assert.strictEqual(got, 'deferred');
}

// Client responses are IncomingMessages too, but keep the Readable-driven
// streamable: the agent releases a keep-alive socket from the response's 'end'
// event, so a source that suppressed it would exhaust the pool. Reading
// several responses over one socket is what catches that.
async function testClientResponse() {
  const body = 'z'.repeat(5000);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Length': `${body.length}` });
    res.end(body);
  });
  const port = await listen(server);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  for (let i = 0; i < 3; i++) {
    const res = await new Promise((resolve) =>
      http.get({ port, agent }, resolve));
    await null; // Reach the response a turn late, as real code does.
    assert.strictEqual(await text(res), body);
  }
  agent.destroy();
  server.close();
}

// A connection that dies mid-body must fail the consumer, not leave it waiting
// for a chunk that is never coming.
async function testAbortedRequestBody() {
  const server = http.createServer(common.mustCall(async (req, res) => {
    let read = 0;
    await assert.rejects(async () => {
      for await (const batch of from(req)) {
        for (const chunk of batch) read += chunk.length;
      }
    }, { code: 'ECONNRESET' });
    assert.ok(read > 0);
    server.close();
  }));
  const port = await listen(server);
  await new Promise((resolve) => {
    const socket = net.connect(port, () => {
      socket.write('POST / HTTP/1.1\r\nHost: localhost\r\n' +
                   'Content-Length: 20000\r\n\r\n');
      socket.write('a'.repeat(1000));
      setTimeout(() => socket.destroy(), 50);
    });
    socket.on('close', resolve);
    socket.on('error', () => {});
  });
}

// A response destroyed mid-body must do the same, rather than present the part
// that arrived as if it were the whole body.
async function testAbortedResponseBody() {
  const server = net.createServer((socket) => {
    socket.on('data', () => {
      socket.write('HTTP/1.1 200 OK\r\nContent-Length: 20000\r\n\r\n' +
                   'a'.repeat(1000));
    });
  });
  const port = await new Promise((r) => server.listen(0, () => r(server.address().port)));
  const req = http.get({ port });
  const res = await new Promise((r) => req.on('response', r));
  setTimeout(() => req.destroy(), 50);
  let read = 0;
  await assert.rejects(async () => {
    for await (const batch of from(res)) {
      for (const chunk of batch) read += chunk.length;
    }
  }, { code: 'ECONNRESET' });
  assert.ok(read > 0);
  server.close();
}

// Once a message has been dumped its body is gone. Asking for the streamable
// afterwards must not resume delivery and hand over the tail as a whole body.
async function testClaimAfterDump() {
  let report;
  const claimed = new Promise((r) => report = r);
  const server = http.createServer((req, res) => {
    res.end('ok');
    // resOnFinish dumps the unread request before this runs.
    res.on('finish', async () => {
      const body = await bytes(req);
      report(body.byteLength);
    });
  });
  const port = await listen(server);
  const socket = net.connect(port, () => {
    socket.write('POST / HTTP/1.1\r\nHost: localhost\r\n' +
                 'Content-Length: 30000\r\n\r\n');
    socket.write('a'.repeat(10000));
  });
  socket.resume();
  socket.on('error', () => {});
  await new Promise((r) => socket.once('data', r));
  socket.write('b'.repeat(20000));
  assert.strictEqual(await claimed, 0);
  socket.destroy();
  server.close();
}

// A response already read as a stream has emitted its 'end'. Taking the
// streamable afterwards must not emit a second one, which would run the
// client's socket release twice.
async function testNoDoubleEnd() {
  const server = http.createServer((req, res) => res.end('hello'));
  const port = await listen(server);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const res = await new Promise((resolve) =>
    http.get({ port, agent }, resolve));
  let ends = 0;
  res.on('end', () => ends++);
  res.resume();
  await new Promise((r) => res.on('end', r));
  await bytes(res);
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(ends, 1);
  agent.destroy();
  server.close();
}

async function main() {
  await testText();
  await testDeferredRead();
  await testClientResponse();
  await testLargeBody();
  await testChunked();
  await testNoBody();
  await testKeepAlive();
  await testIdempotent();
  await testUserBodyProperty();
  await testClassicPath();
  await testAbortedRequestBody();
  await testAbortedResponseBody();
  await testClaimAfterDump();
  await testNoDoubleEnd();
}

main().then(common.mustCall());
