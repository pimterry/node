// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

const {
  ObjectDefineProperty,
  ObjectSetPrototypeOf,
  ReflectApply,
  Symbol,
} = primordials;

const { Readable, finished } = require('stream');
const {
  deprecateInstantiation,
} = require('internal/util');

const { AbortController } = require('internal/abort_controller');
const { ConnResetException } = require('internal/errors');
const {
  toAsyncStreamable,
} = require('internal/streams/iter/types');

const { IncomingBody } = require('internal/http/incoming_body');

const kHeaders = Symbol('kHeaders');
const kHeadersDistinct = Symbol('kHeadersDistinct');
const kHeadersCount = Symbol('kHeadersCount');
const kTrailers = Symbol('kTrailers');
const kTrailersDistinct = Symbol('kTrailersDistinct');
const kTrailersCount = Symbol('kTrailersCount');
const kAbortController = Symbol('kAbortController');
const kAbortSignalSocket = Symbol('kAbortSignalSocket');
const kAbortSignalListener = Symbol('kAbortSignalListener');
const kAbortSignalDetached = Symbol('kAbortSignalDetached');
const kAttachAbortSignal = Symbol('kAttachAbortSignal');
const kDetachAbortSignal = Symbol('kDetachAbortSignal');
// A message body has exactly one consumer, and kBodySink says which:
//
//   null             nothing has asked for the body yet, so chunks are held
//   kReadableSink    the message's own Readable ('data'/'end')
//   an IncomingBody  a pull consumer, through the stream/iter protocol
//
// A consumer takes over at most once and never hands back, so a held chunk can
// never overtake a delivered one. Holding rather than pushing means a body
// nobody reads - a 403 that rejects without looking at it, say - never runs
// through the stream at all.
const kBodySink = Symbol('kBodySink');
const kReadableSink = { __proto__: null };
// Body bytes that arrived while kBodySink was still null.
const kHeldChunks = Symbol('kHeldChunks');
const kHeldBytes = Symbol('kHeldBytes');
// Called once the parser reports the message finished. Lets the server learn
// that without driving the stream, which a message nobody reads never does.
const kOnComplete = Symbol('kOnComplete');

function readStart(socket) {
  if (socket && !socket._paused && socket.readable)
    socket.resume();
}

function readStop(socket) {
  if (socket)
    socket.pause();
}

/* Abstract base class for ServerRequest and ClientResponse. */
function IncomingMessage(socket) {
  if (!(this instanceof IncomingMessage)) {
    return deprecateInstantiation(IncomingMessage, 'DEP0195', socket);
  }

  let streamOptions;

  if (socket) {
    streamOptions = {
      highWaterMark: socket.readableHighWaterMark,
    };
  }

  Readable.call(this, streamOptions);

  this._readableState.readingMore = true;

  this.socket = socket;

  this.httpVersionMajor = null;
  this.httpVersionMinor = null;
  this.httpVersion = null;
  this.complete = false;
  this[kHeaders] = null;
  this[kHeadersCount] = 0;
  this.rawHeaders = [];
  this[kTrailers] = null;
  this[kTrailersCount] = 0;
  this.rawTrailers = [];
  this.joinDuplicateHeaders = false;
  this.aborted = false;

  this.upgrade = null;

  // request (server) only
  this.url = '';
  this.method = null;

  // response (client) only
  this.statusCode = null;
  this.statusMessage = null;
  this.client = socket;

  this._consuming = false;
  // Flag for when we decide that this message cannot possibly be
  // read by the user, so there's no point continuing to handle it.
  this._dumped = false;
  // Appended last, so every field the message already had keeps its place.
  this[kHeldChunks] = null;
  this[kHeldBytes] = 0;
  this[kOnComplete] = null;
  this[kBodySink] = null;
  this[kAbortController] = null;
  this[kAbortSignalSocket] = null;
  this[kAbortSignalListener] = null;
  this[kAbortSignalDetached] = false;
}
ObjectSetPrototypeOf(IncomingMessage.prototype, Readable.prototype);
ObjectSetPrototypeOf(IncomingMessage, Readable);

// Requests carry a method, responses carry a status.
function isResponse(msg) {
  return msg.method === null;
}

// True once the Readable is the body's consumer: from then on the message is
// finished when the stream is.
function readableIsConsumer(msg) {
  return msg[kBodySink] === kReadableSink;
}

// Does anything still need the stream to run? Bytes are held only while this
// is false, so the moment something needs it the body goes in and the message
// behaves as it always has, including handing already-held bytes to a listener
// that arrives later.
//
// Adding a 'data' or 'readable' listener shows up in the first two terms:
// Readable's own `on` sets `flowing` and `readableListening` as it goes. That
// leaves 'end' and 'close', which only the stream lifecycle can deliver.
// Listeners for 'error' and 'aborted' are not counted - those reach the
// message through _destroy whether the stream ran or not.
function needsReadable(msg) {
  const state = msg._readableState;
  if (state.flowing !== null || state.readableListening)
    return true;

  return msg._eventsCount > 0 &&
    (msg.listenerCount('end') !== 0 || msg.listenerCount('close') !== 0);
}

// Hold a body chunk for a consumer that has not appeared yet. Returns false
// when enough is held that the socket should stop reading, matching what a
// false from push() means.
function holdChunk(msg, chunk) {
  const held = msg[kHeldChunks];
  if (held === null)
    msg[kHeldChunks] = [chunk];
  else
    held.push(chunk);

  msg[kHeldBytes] += chunk.length;
  return msg[kHeldBytes] < msg._readableState.highWaterMark;
}

function dropHeldChunks(msg) {
  msg[kHeldChunks] = null;
  msg[kHeldBytes] = 0;
}

// _dump() used to resume the stream, and the drain that followed ran a tick
// later - so a 'data' listener added while the response finished still saw
// whatever was buffered, even though _dump() had just removed the listeners
// that were there before it. Settle the held bytes at that same point: hand
// them over if something turned up wanting them, drop them otherwise.
function resolveAbandonedBody(msg) {
  if (msg[kBodySink] !== null)
    return;

  if (msg.listenerCount('data') !== 0 || msg._readableState.readableListening) {
    switchToReadable(msg);
    msg.resume();
  } else {
    dropHeldChunks(msg);
  }
}

function emitAbandonedEnd(msg) {
  msg.emit('end');
  msg.emit('close');
}

// Draining an abandoned body through the stream used to leave the Readable
// ended and destroyed, and emitted 'end' and 'close' on the way. finished(req)
// and anything else inspecting the message once the response is over still
// expects to find it that way, so put it in that state directly rather than
// running the body through the stream to get there.
//
// The events only have somewhere to go if a listener turned up after the body
// was abandoned - one present while the body was routed took the draining path
// instead - so a message nobody ever listened to pays a pair of field stores
// and nothing else.
function finishAbandonedReadable(msg) {
  if (msg[kBodySink] !== null || !msg._dumped || !msg.complete || msg.destroyed)
    return;

  msg._dumpAndCloseReadable();

  if (msg._eventsCount > 0)
    process.nextTick(emitAbandonedEnd, msg);
}

// Make the Readable the body's consumer and give it everything held.
function switchToReadable(msg) {
  const held = msg[kHeldChunks];
  msg[kBodySink] = kReadableSink;

  if (held !== null) {
    // Only resume if holding the bytes is what stopped the socket. Resuming
    // one that was never paused starts an upgraded connection flowing early.
    const wasPaused = msg[kHeldBytes] >= msg._readableState.highWaterMark;
    dropHeldChunks(msg);

    for (let i = 0; i < held.length; i++)
      msg.push(held[i]);

    if (wasPaused)
      readStart(msg.socket);
  }

  // The parser will not call back again once the message is complete.
  if (msg.complete)
    msg.push(null);
}

/**
 * Route a body chunk from the parser to whoever is consuming the message.
 * @param {IncomingMessage} msg Message the chunk belongs to.
 * @param {Buffer} chunk Body bytes just parsed.
 * @returns {boolean} false when the socket should stop reading.
 */
function writeBody(msg, chunk) {
  const sink = msg[kBodySink];

  // Checked ahead of `_dumped`, which claiming the body sets: a pull consumer
  // discards internally, so the chunk still goes to it.
  if (sink !== null && sink !== kReadableSink)
    return sink.write(chunk);

  if (msg._dumped)
    return true;

  if (sink === kReadableSink)
    return msg.push(chunk);

  // Something looked at the stream while the bytes were held. Hand those over
  // first so the body stays in order, then feed this chunk straight in.
  if (needsReadable(msg)) {
    switchToReadable(msg);
    return msg.push(chunk);
  }

  return holdChunk(msg, chunk);
}

// The parser has reached the end of the message.
function endBody(msg) {
  const sink = msg[kBodySink];

  if (sink === kReadableSink) {
    msg.push(null);
  } else if (sink !== null) {
    sink.end();
  } else if (!msg._dumped && needsReadable(msg)) {
    // Looked at but never read from: hand over what was held and end it, so a
    // reader that arrives later still sees the whole body and its 'end'.
    switchToReadable(msg);
  }
  // Otherwise nothing is reading the body. A dumped message stays dumped even
  // if a listener turns up between the dump and here - engaging the stream
  // then would leave it waiting on a reader that is never coming, where
  // draining used to carry it to 'end'. finishAbandonedReadable() finishes it
  // instead. switchToReadable() ends the stream immediately for a consumer
  // that arrives after this point.

  const onComplete = msg[kOnComplete];
  if (onComplete !== null) {
    msg[kOnComplete] = null;
    onComplete(msg);
  }

  finishAbandonedReadable(msg);
}

// The body consumer has to hear that the message failed, or its pending next()
// waits for a chunk that is never coming.
const readableDestroy = IncomingMessage.prototype.destroy;
IncomingMessage.prototype.destroy = function destroy(err) {
  const sink = this[kBodySink];
  if (sink !== null && sink !== kReadableSink)
    sink.destroy(err || new ConnResetException('aborted'));

  return ReflectApply(readableDestroy, this, [err]);
};

// Adapter notifications for a body handed to a pull consumer. Module-level, so
// filling the slots in costs no closure.
function markConsuming() {
  this.owner._consuming = true;
}

// A response reaches completion through 'end': it is what detaches the abort
// signal, drops the socket timeout listeners and hands the keep-alive socket
// back to the agent (responseOnEnd in _http_client). The Readable would have
// emitted it, so with the Readable out of the way the body has to.
function emitMessageEnd() {
  this.owner.emit('end');
}

// Give the body to a pull consumer, taking over from whatever held it so far.
function claimBody(msg) {
  const fromReadable = readableIsConsumer(msg);
  const body = new IncomingBody(msg, msg._readableState.highWaterMark);
  msg[kBodySink] = body;

  if (msg._dumped) {
    // The body was already discarded, so there is nothing to hand over and
    // more of it may still be arriving. Present it as finished rather than
    // resuming delivery and passing off the tail as a whole body.
    body.ended = true;
    body.dump();
    return body;
  }

  let endAlreadyEmitted = false;
  if (fromReadable) {
    // Recover what the Readable buffered but never handed to a reader. This is
    // the one place bytes travel backwards, and only a message read both ways
    // reaches it.
    const state = msg._readableState;
    for (const chunk of state.buffer)
      body.write(chunk);
    body.ended = state.ended;
    // The Readable already told the message it ended; saying so again would
    // run the consumer's 'end' listeners twice, and with them the client's
    // socket release.
    endAlreadyEmitted = state.endEmitted;
  } else {
    const held = msg[kHeldChunks];
    if (held !== null) {
      dropHeldChunks(msg);
      for (let i = 0; i < held.length; i++)
        body.write(held[i]);
    }
    body.ended = msg.complete;
  }

  // The Readable side is out of the picture from here. Closing it out leaves
  // it looking finished, so a second consumer sees an ended stream rather than
  // a body that is already spoken for.
  msg._dumpAndCloseReadable();

  body.onRead = markConsuming;
  if (isResponse(msg)) {
    body.onEnd = emitMessageEnd;
    // The parser may already have finished, in which case end() has been and
    // gone while the slot was still empty.
    if (body.ended && !endAlreadyEmitted)
      emitMessageEnd.call(body);
  }

  if (!body.ended)
    readStart(msg.socket);

  return body;
}

// stream/iter asks a source for its streamable through this protocol. Readable
// implements it too, but by driving the stream; answering it with the body
// itself means Stream.text(req), Stream.bytes(req) and pull(req, ...) never
// run the Readable lifecycle.
IncomingMessage.prototype[toAsyncStreamable] = function() {
  const sink = this[kBodySink];
  if (sink !== null && sink !== kReadableSink)
    return sink;

  return claimBody(this);
};

// Held bytes are not in the stream's own buffer, but they have arrived and
// are waiting for a reader, which is what this reports.
ObjectDefineProperty(IncomingMessage.prototype, 'readableLength', {
  __proto__: null,
  enumerable: false,
  get: function() {
    return this._readableState.length + this[kHeldBytes];
  },
});

ObjectDefineProperty(IncomingMessage.prototype, 'connection', {
  __proto__: null,
  get: function() {
    return this.socket;
  },
  set: function(val) {
    this.socket = val;
  },
});

ObjectDefineProperty(IncomingMessage.prototype, 'headers', {
  __proto__: null,
  get: function() {
    if (!this[kHeaders]) {
      this[kHeaders] = { __proto__: null };

      const src = this.rawHeaders;
      const dst = this[kHeaders];

      for (let n = 0; n < this[kHeadersCount]; n += 2) {
        this._addHeaderLine(src[n + 0], src[n + 1], dst);
      }
    }
    return this[kHeaders];
  },
  set: function(val) {
    this[kHeaders] = val;
  },
});

ObjectDefineProperty(IncomingMessage.prototype, 'headersDistinct', {
  __proto__: null,
  get: function() {
    if (!this[kHeadersDistinct]) {
      this[kHeadersDistinct] = { __proto__: null };

      const src = this.rawHeaders;
      const dst = this[kHeadersDistinct];

      for (let n = 0; n < this[kHeadersCount]; n += 2) {
        this._addHeaderLineDistinct(src[n + 0], src[n + 1], dst);
      }
    }
    return this[kHeadersDistinct];
  },
  set: function(val) {
    this[kHeadersDistinct] = val;
  },
});

ObjectDefineProperty(IncomingMessage.prototype, 'trailers', {
  __proto__: null,
  get: function() {
    if (!this[kTrailers]) {
      this[kTrailers] = { __proto__: null };

      const src = this.rawTrailers;
      const dst = this[kTrailers];

      for (let n = 0; n < this[kTrailersCount]; n += 2) {
        this._addHeaderLine(src[n + 0], src[n + 1], dst);
      }
    }
    return this[kTrailers];
  },
  set: function(val) {
    this[kTrailers] = val;
  },
});

ObjectDefineProperty(IncomingMessage.prototype, 'trailersDistinct', {
  __proto__: null,
  get: function() {
    if (!this[kTrailersDistinct]) {
      this[kTrailersDistinct] = { __proto__: null };

      const src = this.rawTrailers;
      const dst = this[kTrailersDistinct];

      for (let n = 0; n < this[kTrailersCount]; n += 2) {
        this._addHeaderLineDistinct(src[n + 0], src[n + 1], dst);
      }
    }
    return this[kTrailersDistinct];
  },
  set: function(val) {
    this[kTrailersDistinct] = val;
  },
});

ObjectDefineProperty(IncomingMessage.prototype, 'signal', {
  __proto__: null,
  configurable: true,
  get: function() {
    if (this[kAbortController] === null) {
      const ac = new AbortController();
      this[kAbortController] = ac;
      if (this.destroyed && (!this.readableEnded || !this.complete)) {
        ac.abort();
      } else {
        this[kAttachAbortSignal]();
      }
    }
    return this[kAbortController].signal;
  },
});

IncomingMessage.prototype[kAttachAbortSignal] = function() {
  if (this[kAbortController].signal.aborted ||
      this[kAbortSignalDetached] ||
      this[kAbortSignalListener] !== null) {
    return;
  }

  const socket = this.socket;
  if (!socket) {
    return;
  }

  if (socket.destroyed) {
    abortSignal(this);
    return;
  }

  this[kAbortSignalSocket] = socket;
  this[kAbortSignalListener] = () => {
    abortSignal(this);
  };
  socket.once('close', this[kAbortSignalListener]);
};

IncomingMessage.prototype[kDetachAbortSignal] = function() {
  const socket = this[kAbortSignalSocket];
  const listener = this[kAbortSignalListener];
  this[kAbortSignalDetached] = true;
  this[kAbortSignalSocket] = null;
  this[kAbortSignalListener] = null;
  if (socket !== null && listener !== null) {
    socket.removeListener('close', listener);
  }
};

IncomingMessage.prototype.setTimeout = function setTimeout(msecs, callback) {
  if (callback)
    this.on('timeout', callback);
  this.socket.setTimeout(msecs);
  return this;
};

IncomingMessage.prototype._read = function _read() {
  if (!this._consuming) {
    this._readableState.readingMore = false;
    this._consuming = true;
  }

  // A reader that only calls read(), with no listeners, first shows up here.
  if (this[kBodySink] === null)
    switchToReadable(this);

  // We actually do almost nothing here, because the parserOnBody
  // function fills up our internal buffer directly.  However, we
  // do need to unpause the underlying socket so that it flows.
  //
  // An upgraded connection is the exception: the socket has been handed to
  // whoever took the upgrade, and resuming it here would read the bytes meant
  // for them. UpgradeStream resumes it itself when its consumer asks.
  if (this.socket.readable && !this.upgrade)
    readStart(this.socket);
};

// It's possible that the socket will be destroyed, and removed from
// any messages, before ever calling this.  In that case, just skip
// it, since something else is destroying this connection anyway.
IncomingMessage.prototype._destroy = function _destroy(err, cb) {
  if (!this.readableEnded || !this.complete) {
    this.aborted = true;
    this.emit('aborted');
    abortSignal(this);
  }

  // If aborted and the underlying socket is not already destroyed,
  // destroy it.
  // We have to check if the socket is already destroyed because finished
  // does not call the callback when this method is invoked from `_http_client`
  // in `test/parallel/test-http-client-spurious-aborted.js`
  if (this.socket && !this.socket.destroyed && this.aborted) {
    this.socket.destroy(err);
    const cleanup = finished(this.socket, (e) => {
      if (e?.code === 'ERR_STREAM_PREMATURE_CLOSE') {
        e = null;
      }
      cleanup();
      process.nextTick(onError, this, e || err, cb);
    });
  } else {
    process.nextTick(onError, this, err, cb);
  }
};

function abortSignal(self) {
  self[kDetachAbortSignal]();
  if (self[kAbortController] !== null) {
    self[kAbortController].abort();
  }
}

IncomingMessage.prototype._addHeaderLines = _addHeaderLines;
function _addHeaderLines(headers, n) {
  if (headers?.length) {
    let dest;
    if (this.complete) {
      this.rawTrailers = headers;
      this[kTrailersCount] = n;
      dest = this[kTrailers];
    } else {
      this.rawHeaders = headers;
      this[kHeadersCount] = n;
      dest = this[kHeaders];
    }

    if (dest) {
      for (let i = 0; i < n; i += 2) {
        this._addHeaderLine(headers[i], headers[i + 1], dest);
      }
    }
  }
}


// This function is used to help avoid the lowercasing of a field name if it
// matches a 'traditional cased' version of a field name. It then returns the
// lowercased name to both avoid calling toLowerCase() a second time and to
// indicate whether the field was a 'no duplicates' field. If a field is not a
// 'no duplicates' field, a `0` byte is prepended as a flag. The one exception
// to this is the Set-Cookie header which is indicated by a `1` byte flag, since
// it is an 'array' field and thus is treated differently in _addHeaderLines().
// TODO: perhaps http_parser could be returning both raw and lowercased versions
// of known header names to avoid us having to call toLowerCase() for those
// headers.
function matchKnownFields(field, lowercased) {
  switch (field.length) {
    case 3:
      if (field === 'Age' || field === 'age') return 'age';
      break;
    case 4:
      if (field === 'Host' || field === 'host') return 'host';
      if (field === 'From' || field === 'from') return 'from';
      if (field === 'ETag' || field === 'etag') return 'etag';
      if (field === 'Date' || field === 'date') return '\u0000date';
      if (field === 'Vary' || field === 'vary') return '\u0000vary';
      break;
    case 6:
      if (field === 'Server' || field === 'server') return 'server';
      if (field === 'Cookie' || field === 'cookie') return '\u0002cookie';
      if (field === 'Origin' || field === 'origin') return '\u0000origin';
      if (field === 'Expect' || field === 'expect') return '\u0000expect';
      if (field === 'Accept' || field === 'accept') return '\u0000accept';
      break;
    case 7:
      if (field === 'Referer' || field === 'referer') return 'referer';
      if (field === 'Expires' || field === 'expires') return 'expires';
      if (field === 'Upgrade' || field === 'upgrade') return '\u0000upgrade';
      break;
    case 8:
      if (field === 'Location' || field === 'location')
        return 'location';
      if (field === 'If-Match' || field === 'if-match')
        return '\u0000if-match';
      break;
    case 10:
      if (field === 'User-Agent' || field === 'user-agent')
        return 'user-agent';
      if (field === 'Set-Cookie' || field === 'set-cookie')
        return '\u0001';
      if (field === 'Connection' || field === 'connection')
        return '\u0000connection';
      break;
    case 11:
      if (field === 'Retry-After' || field === 'retry-after')
        return 'retry-after';
      break;
    case 12:
      if (field === 'Content-Type' || field === 'content-type')
        return 'content-type';
      if (field === 'Max-Forwards' || field === 'max-forwards')
        return 'max-forwards';
      break;
    case 13:
      if (field === 'Authorization' || field === 'authorization')
        return 'authorization';
      if (field === 'Last-Modified' || field === 'last-modified')
        return 'last-modified';
      if (field === 'Cache-Control' || field === 'cache-control')
        return '\u0000cache-control';
      if (field === 'If-None-Match' || field === 'if-none-match')
        return '\u0000if-none-match';
      break;
    case 14:
      if (field === 'Content-Length' || field === 'content-length')
        return 'content-length';
      break;
    case 15:
      if (field === 'Accept-Encoding' || field === 'accept-encoding')
        return '\u0000accept-encoding';
      if (field === 'Accept-Language' || field === 'accept-language')
        return '\u0000accept-language';
      if (field === 'X-Forwarded-For' || field === 'x-forwarded-for')
        return '\u0000x-forwarded-for';
      break;
    case 16:
      if (field === 'Content-Encoding' || field === 'content-encoding')
        return '\u0000content-encoding';
      if (field === 'X-Forwarded-Host' || field === 'x-forwarded-host')
        return '\u0000x-forwarded-host';
      break;
    case 17:
      if (field === 'If-Modified-Since' || field === 'if-modified-since')
        return 'if-modified-since';
      if (field === 'Transfer-Encoding' || field === 'transfer-encoding')
        return '\u0000transfer-encoding';
      if (field === 'X-Forwarded-Proto' || field === 'x-forwarded-proto')
        return '\u0000x-forwarded-proto';
      break;
    case 19:
      if (field === 'Proxy-Authorization' || field === 'proxy-authorization')
        return 'proxy-authorization';
      if (field === 'If-Unmodified-Since' || field === 'if-unmodified-since')
        return 'if-unmodified-since';
      break;
  }
  if (lowercased) {
    return '\u0000' + field;
  }
  return matchKnownFields(field.toLowerCase(), true);
}
// Add the given (field, value) pair to the message
//
// Per RFC2616, section 4.2 it is acceptable to join multiple instances of the
// same header with a ', ' if the header in question supports specification of
// multiple values this way. The one exception to this is the Cookie header,
// which has multiple values joined with a '; ' instead. If a header's values
// cannot be joined in either of these ways, we declare the first instance the
// winner and drop the second. Extended header fields (those beginning with
// 'x-') are always joined.
IncomingMessage.prototype._addHeaderLine = _addHeaderLine;
function _addHeaderLine(field, value, dest) {
  field = matchKnownFields(field);
  const flag = field.charCodeAt(0);
  if (flag === 0 || flag === 2) {
    field = field.slice(1);
    // Make a delimited list
    if (typeof dest[field] === 'string') {
      dest[field] += (flag === 0 ? ', ' : '; ') + value;
    } else {
      dest[field] = value;
    }
  } else if (flag === 1) {
    // Array header -- only Set-Cookie at the moment
    if (dest['set-cookie'] !== undefined) {
      dest['set-cookie'].push(value);
    } else {
      dest['set-cookie'] = [value];
    }
  } else if (this.joinDuplicateHeaders) {
    // RFC 9110 https://www.rfc-editor.org/rfc/rfc9110#section-5.2
    // https://github.com/nodejs/node/issues/45699
    // allow authorization multiple fields
    // Make a delimited list
    if (dest[field] === undefined) {
      dest[field] = value;
    } else {
      dest[field] += ', ' + value;
    }
  } else if (dest[field] === undefined) {
    // Drop duplicates
    dest[field] = value;
  }
}

IncomingMessage.prototype._addHeaderLineDistinct = _addHeaderLineDistinct;
function _addHeaderLineDistinct(field, value, dest) {
  field = field.toLowerCase();
  if (!dest[field]) {
    dest[field] = [value];
  } else {
    dest[field].push(value);
  }
}

IncomingMessage.prototype._dumpAndCloseReadable = function _dumpAndCloseReadable() {
  this._dumped = true;
  this._readableState.ended = true;
  this._readableState.endEmitted = true;
  this._readableState.destroyed = true;
  this._readableState.closed = true;
  this._readableState.closeEmitted = true;
};


// Call this instead of resume() if we want to just
// dump all the data to /dev/null
IncomingMessage.prototype._dump = function _dump() {
  // Checked ahead of `_dumped`, which claiming the body sets: an abandoned
  // body still has to be discarded so it stops applying backpressure and the
  // connection stays usable.
  const sink = this[kBodySink];
  if (sink !== null && sink !== kReadableSink) {
    if (!sink.discarded) {
      this._dumped = true;
      sink.dump();
    }
    return;
  }

  if (this._dumped)
    return;
  this._dumped = true;

  if (!needsReadable(this)) {
    // Nothing is waiting on the stream's lifecycle. resume() marked it
    // flowing and kept the socket reading; do both, and leave what is held to
    // be settled a tick later by resolveAbandonedBody, as resume()'s drain was.
    this._readableState.flowing = true;
    readStart(this.socket);
    return;
  }

  // Something is listening. Hand over what was held and drain the stream as
  // this always has, so 'resume', 'end' and 'close' arrive unchanged and a
  // listener added from the 'resume' handler still sees the body.
  if (sink === null)
    switchToReadable(this);

  // If there is buffered data, it may trigger 'data' events.
  // Remove 'data' event listeners explicitly.
  this.removeAllListeners('data');
  this.resume();
};

function onError(self, error, cb) {
  // This is to keep backward compatible behavior.
  // An error is emitted only if there are listeners attached to the event.
  if (self.listenerCount('error') === 0) {
    cb();
  } else {
    cb(error);
  }
}

module.exports = {
  IncomingMessage,
  writeBody,
  endBody,
  resolveAbandonedBody,
  finishAbandonedReadable,
  kOnComplete,
  readableIsConsumer,
  kDetachAbortSignal,
  readStart,
  readStop,
};
