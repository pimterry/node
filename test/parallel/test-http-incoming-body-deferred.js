'use strict';

// Body bytes that arrive before anything reads them are held rather than
// pushed through the Readable. Two things have to stay true because of that:
// a reader that turns up after the body has already arrived still sees all of
// it, and a body that nobody ever reads still lets the connection move on.

const common = require('../common');
const assert = require('assert');
const http = require('http');
const net = require('net');

const BODY = 'abcdefghijklmnopqrstuvwxyz';

function post(body) {
  return 'POST / HTTP/1.1\r\n' +
         'Host: localhost\r\n' +
         `Content-Length: ${body.length}\r\n` +
         '\r\n' +
         body;
}

// A handler that only starts reading on a later tick still gets the whole body.
{
  const server = http.createServer(common.mustCall((req, res) => {
    setImmediate(common.mustCall(() => {
      // The request was written in one go, so the parser has already run to
      // the end of the message: the body is here, held, and unread.
      assert.strictEqual(req.complete, true);

      let received = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { received += chunk; });
      req.on('end', common.mustCall(() => {
        assert.strictEqual(received, BODY);
        res.end();
        server.close();
      }));
    }));
  }));

  server.listen(0, common.mustCall(() => {
    const socket = net.connect(server.address().port, common.mustCall(() => {
      socket.end(post(BODY));
    }));
    // The response is not what this test is about; take it and hang up.
    socket.on('data', () => socket.destroy());
  }));
}

// Three pipelined requests whose bodies the handler never looks at. The bytes
// still have to be taken off the socket and each message finished, or the
// request after them is never served.
{
  const server = http.createServer(common.mustCall((req, res) => {
    res.end('ok');
  }, 3));

  server.listen(0, common.mustCall(() => {
    const socket = net.connect(server.address().port, common.mustCall(() => {
      socket.write(post(BODY).repeat(3));
    }));

    let responses = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      responses += chunk;
      if (responses.split('HTTP/1.1 200').length - 1 === 3) {
        socket.destroy();
        server.close();
      }
    });
  }));
}

// 'end' and 'close' can only ever come from the stream, so a listener for
// either one has to wake the held body up. Each is checked on its own, with no
// 'data' listener, because that is what a lifecycle-only listener looks like.
for (const event of ['end', 'close']) {
  const server = http.createServer(common.mustCall((req, res) => {
    req.on(event, common.mustCall());
    res.end();
  }));

  server.listen(0, common.mustCall(() => {
    const socket = net.connect(server.address().port, common.mustCall(() => {
      socket.end(post(BODY));
    }));
    socket.on('data', () => {
      socket.destroy();
      server.close();
    });
  }));
}
