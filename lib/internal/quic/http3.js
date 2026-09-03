'use strict';

const {
  ArrayIsArray,
  ArrayPrototypePush,
  ArrayPrototypeSome,
  ObjectKeys,
  StringPrototypeToLowerCase,
  Symbol,
  SymbolAsyncIterator,
} = primordials;

const {
  getOptionValue,
} = require('internal/options');

if (!process.features.quic || !getOptionValue('--experimental-quic')) {
  return;
}

// Internal, experimental HTTP/3 layer over node:quic: Http3Session wraps a
// QuicSession and surfaces its streams as Http3Stream objects.

const {
  connect: quicConnect,
  listen: quicListen,
  QuicSession,
  QuicStream,
  kApplication,
  kApplicationSettings,
  kStreamHandle,
  kSessionHandle,
  markSessionClosing,
  getQuicStreamState,
  getQuicSessionState,
  safeCallbackInvoke: quicSafeCallbackInvoke,
  kApplicationOwner,
} = require('internal/quic/quic');

const {
  setHttp3Callbacks,
  createHttp3Handle,

  QUIC_STREAM_HEADERS_KIND_INITIAL: kHeadersKindInitial,
  QUIC_STREAM_HEADERS_KIND_HINTS: kHeadersKindHints,
  QUIC_STREAM_HEADERS_KIND_TRAILING: kHeadersKindTrailing,
  QUIC_STREAM_HEADERS_FLAGS_NONE: kHeadersFlagsNone,
  QUIC_STREAM_HEADERS_FLAGS_TERMINAL: kHeadersFlagsTerminal,
} = internalBinding('quic');

const {
  buildNgHeaderString,
  assertValidPseudoHeader,
  assertValidPseudoHeaderTrailer,
} = require('internal/http2/util');

const {
  onSessionApplicationChannel,
  onSessionClosingChannel,
  onSessionGoawayChannel,
  onSessionOriginChannel,
  onStreamHeadersChannel,
  onStreamTrailersChannel,
  onStreamInfoChannel,
} = require('internal/quic/diagnostics');

const {
  validateBoolean,
  validateFunction,
  validateObject,
  validateOneOf,
} = require('internal/validators');

const {
  codes: {
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_STATE,
    ERR_QUIC_OPEN_STREAM_FAILED,
  },
} = require('internal/errors');

const assert = require('internal/assert');

const kEmptyObject = { __proto__: null };
const kHttp3Alpn = 'h3';
// Tells the peer the request was not processed and may be retried
const kH3RequestRejected = 0x10b;

// Route the application events registered via setHttp3Callbacks below.
const kOnHeaders = Symbol('kOnHeaders');
const kOnWantTrailers = Symbol('kOnWantTrailers');
const kOnGoaway = Symbol('kOnGoaway');
const kOnOrigin = Symbol('kOnOrigin');
const kOnSettings = Symbol('kOnSettings');

function isQuicSession(value) {
  return value instanceof QuicSession;
}

function isQuicStream(value) {
  return value instanceof QuicStream;
}

// Parses an alternating [name, value, ...] array from the application,
// collecting repeated names into arrays.
function parseHeaderPairs(pairs) {
  assert(ArrayIsArray(pairs));
  assert(pairs.length % 2 === 0);
  const block = { __proto__: null };
  for (let n = 0; n + 1 < pairs.length; n += 2) {
    const name = pairs[n];
    let value = pairs[n + 1];
    // Match HTTP/2 behavior: incoming :status is exposed as a number.
    if (name === ':status')
      value |= 0;
    if (block[name] !== undefined) {
      if (ArrayIsArray(block[name])) {
        ArrayPrototypePush(block[name], value);
      } else {
        block[name] = [block[name], value];
      }
    } else {
      block[name] = value;
    }
  }
  return block;
}

/**
 * @typedef {object} SendHeadersOptions
 * @property {boolean} [terminal] No body data follows these headers.
 */

const kGetHttp3Handle = Symbol('kGetHttp3Handle');
const kSubmitInitialHeaders = Symbol('kSubmitInitialHeaders');

function hasPriorityHeader(headers) {
  return ArrayPrototypeSome(
    ObjectKeys(headers),
    (name) => StringPrototypeToLowerCase(name) === 'priority');
}

function priorityFieldValue(level, incremental) {
  const urgency = level === 'high' ? 0 : level === 'low' ? 7 : 3;
  if (urgency === 3 && !incremental) return undefined;
  return incremental ? `u=${urgency}, i` : `u=${urgency}`;
}

class Http3Stream {
  #stream;
  #session;
  #h3handle;
  #headers = undefined;
  #onheaders = undefined;
  #oninfo = undefined;
  #ontrailers = undefined;
  #onwanttrailers = undefined;
  #priority = { __proto__: null, level: 'default', incremental: false };
  #headersSubmitted = false;

  constructor(stream, session, callbacks = kEmptyObject) {
    if (!isQuicStream(stream)) {
      throw new ERR_INVALID_ARG_TYPE('stream', 'QuicStream', stream);
    }
    this.#stream = stream;
    this.#session = session;
    this.#h3handle = session[kGetHttp3Handle]();
    const handle = stream[kStreamHandle];
    if (handle !== undefined) {
      handle[kApplicationOwner] = this;
    }
    const {
      onheaders,
      oninfo,
      ontrailers,
      onwanttrailers,
      onreset,
      onerror,
    } = callbacks;
    if (onheaders !== undefined) this.onheaders = onheaders;
    if (oninfo !== undefined) this.oninfo = oninfo;
    if (ontrailers !== undefined) this.ontrailers = ontrailers;
    if (onwanttrailers !== undefined) this.onwanttrailers = onwanttrailers;
    if (onreset !== undefined) this.onreset = onreset;
    if (onerror !== undefined) this.onerror = onerror;
  }

  [kOnHeaders](pairs, kind) {
    if (this.#stream.destroyed) return;
    quicSafeCallbackInvoke(() => this.#onHeaderBlock(pairs, kind), this.#stream);
  }

  [kOnWantTrailers]() {
    if (this.#stream.destroyed) return;
    if (typeof this.#onwanttrailers !== 'function') return;
    quicSafeCallbackInvoke(() => this.#onwanttrailers(), this.#stream);
  }

  #onHeaderBlock(pairs, kind) {
    const block = parseHeaderPairs(pairs);
    const stream = this.#stream;
    switch (kind) {
      case kHeadersKindInitial:
        this.#headers ??= block;
        if (onStreamHeadersChannel.hasSubscribers) {
          onStreamHeadersChannel.publish({
            __proto__: null,
            stream,
            session: stream.session,
            headers: block,
          });
        }
        if (typeof this.#onheaders === 'function') {
          return this.#onheaders(block);
        }
        return undefined;
      case kHeadersKindTrailing:
        if (onStreamTrailersChannel.hasSubscribers) {
          onStreamTrailersChannel.publish({
            __proto__: null,
            stream,
            session: stream.session,
            trailers: block,
          });
        }
        if (typeof this.#ontrailers === 'function') {
          return this.#ontrailers(block);
        }
        return undefined;
      case kHeadersKindHints:
        if (onStreamInfoChannel.hasSubscribers) {
          onStreamInfoChannel.publish({
            __proto__: null,
            stream,
            session: stream.session,
            headers: block,
          });
        }
        if (typeof this.#oninfo === 'function') {
          return this.#oninfo(block);
        }
        return undefined;
    }
  }

  get session() { return this.#session; }

  get stream() { return this.#stream; }

  /** @type {bigint} */
  get id() { return this.#stream.id; }

  /** @type {'bidi'|'uni'} */
  get direction() { return this.#stream.direction; }

  get headers() { return this.#headers; }

  get early() { return this.#stream.early; }

  get #isServer() {
    return getQuicSessionState(this.#session.session).isServer;
  }

  get #knownToNgHttp3() {
    return this.#isServer || this.#headersSubmitted;
  }

  // The stream's priority. On a client this is the value we requested; on a
  // server it is the peer's requested priority read from nghttp3.
  get priority() {
    const stream = this.#stream;
    if (stream.destroyed || this.#h3handle === undefined) return null;
    if (!this.#isServer) {
      return { level: this.#priority.level,
               incremental: this.#priority.incremental };
    }
    const packed = this.#h3handle.getPriority(stream[kStreamHandle]);
    if (packed === undefined) return null;
    const urgency = packed >> 1;
    const incremental = !!(packed & 1);
    const level = urgency < 3 ? 'high' : urgency > 3 ? 'low' : 'default';
    return { level, incremental };
  }

  setPriority(options = kEmptyObject) {
    const stream = this.#stream;
    if (stream.destroyed) return;
    validateObject(options, 'options');
    const { level = 'default', incremental = false } = options;
    validateOneOf(level, 'options.level', ['default', 'low', 'high']);
    validateBoolean(incremental, 'options.incremental');
    this.#priority = { __proto__: null, level, incremental };

    // Before nghttp3 knows the stream, sendHeaders carries the priority in the
    // initial header block; afterwards changes need a PRIORITY_UPDATE frame.
    if (this.#knownToNgHttp3 && this.#h3handle !== undefined) {
      const urgency = level === 'high' ? 0 : level === 'low' ? 7 : 3;
      this.#h3handle.setPriority(
        stream[kStreamHandle], (urgency << 1) | (incremental ? 1 : 0));
    }
  }

  [kSubmitInitialHeaders](headerString, flags) {
    const stream = this.#stream;
    if (stream.destroyed || this.#h3handle === undefined) return false;
    this.#headersSubmitted = true;
    return this.#h3handle.sendHeaders(
      stream[kStreamHandle], headerString, flags);
  }

  #updateHeaderInterest() {
    getQuicStreamState(this.#stream).wantsHeaders =
      this.#onheaders !== undefined ||
      this.#oninfo !== undefined ||
      this.#ontrailers !== undefined;
  }

  get onheaders() { return this.#onheaders; }
  set onheaders(fn) {
    if (fn !== undefined) validateFunction(fn, 'onheaders');
    this.#onheaders = fn;
    this.#updateHeaderInterest();
  }

  get oninfo() { return this.#oninfo; }
  set oninfo(fn) {
    if (fn !== undefined) validateFunction(fn, 'oninfo');
    this.#oninfo = fn;
    this.#updateHeaderInterest();
  }

  get ontrailers() { return this.#ontrailers; }
  set ontrailers(fn) {
    if (fn !== undefined) validateFunction(fn, 'ontrailers');
    this.#ontrailers = fn;
    this.#updateHeaderInterest();
  }

  get onwanttrailers() { return this.#onwanttrailers; }
  set onwanttrailers(fn) {
    if (fn === undefined) {
      this.#onwanttrailers = undefined;
      getQuicStreamState(this.#stream).wantsTrailers = false;
    } else {
      validateFunction(fn, 'onwanttrailers');
      this.#onwanttrailers = fn;
      getQuicStreamState(this.#stream).wantsTrailers = true;
    }
  }

  get onreset() { return this.#stream.onreset; }
  set onreset(fn) { this.#stream.onreset = fn; }

  get onerror() { return this.#stream.onerror; }
  set onerror(fn) { this.#stream.onerror = fn; }

  /**
   * Sends the initial request or response header block.
   * @param {object} headers
   * @param {SendHeadersOptions} [options]
   * @returns {boolean} true if the headers were scheduled to be sent.
   */
  sendHeaders(headers, options = kEmptyObject) {
    const stream = this.#stream;
    if (stream.destroyed || this.#h3handle === undefined) return false;
    validateObject(headers, 'headers');
    const { terminal = false } = options;

    // A client request carries its requested priority as a priority header
    // when set - server responses signal via setPriority instead.
    let toSend = headers;
    if (!this.#isServer) {
      const pri = priorityFieldValue(
        this.#priority.level, this.#priority.incremental);
      if (pri !== undefined && !hasPriorityHeader(headers)) {
        toSend = { __proto__: null, ...headers, priority: pri };
      }
    }

    const headerString = buildNgHeaderString(
      toSend, assertValidPseudoHeader, true /* strictSingleValueFields */);
    const flags = terminal ? kHeadersFlagsTerminal : kHeadersFlagsNone;
    this.#headersSubmitted = true;
    return this.#h3handle.sendHeaders(
      stream[kStreamHandle], headerString, flags);
  }

  /**
   * Sends informational (1xx) headers on this stream. Server only.
   * @returns {boolean} true if the headers were scheduled to be sent.
   */
  sendInformationalHeaders(headers) {
    const stream = this.#stream;
    if (stream.destroyed) return false;
    if (this.#h3handle === undefined) return false;
    validateObject(headers, 'headers');
    const headerString = buildNgHeaderString(
      headers, assertValidPseudoHeader, true);
    return this.#h3handle.sendInformationalHeaders(
      stream[kStreamHandle], headerString);
  }

  /**
   * Sends trailing headers on this stream. Must be called synchronously
   * during the onwanttrailers callback.
   * @returns {boolean} true if the trailers were scheduled to be sent.
   */
  sendTrailers(headers) {
    const stream = this.#stream;
    if (stream.destroyed) return false;
    if (this.#h3handle === undefined) return false;
    validateObject(headers, 'headers');
    const headerString =
      buildNgHeaderString(headers, assertValidPseudoHeaderTrailer);
    return this.#h3handle.sendTrailers(
      stream[kStreamHandle], headerString);
  }

  get writer() { return this.#stream.writer; }

  [SymbolAsyncIterator]() {
    return this.#stream[SymbolAsyncIterator]();
  }

  /** @type {Promise<void>} */
  get closed() { return this.#stream.closed; }

  get destroyed() { return this.#stream.destroyed; }

  destroy(error, options) { return this.#stream.destroy(error, options); }

  stopSending(code) { return this.#stream.stopSending(code); }

  resetStream(code) { return this.#stream.resetStream(code); }
}

class Http3Session {
  #session;
  #h3handle;
  #onstream = undefined;
  #ongoaway = undefined;
  #onorigin = undefined;
  #onsettings = undefined;

  /**
   * Wraps an existing QuicSession to handle HTTP/3.
   * Must be constructed synchronously in the frame the session is delivered,
   * before any I/O tick, so that no stream or session event is missed.
   */
  constructor(session, options = kEmptyObject) {
    if (!isQuicSession(session)) {
      throw new ERR_INVALID_ARG_TYPE('session', 'QuicSession', session);
    }
    if (session.destroyed) {
      throw new ERR_INVALID_STATE('Session is destroyed');
    }
    this.#session = session;
    const { ongoaway, onorigin, onsettings, settings } = options;
    const handle = session[kSessionHandle];
    if (handle !== undefined) {
      this.#h3handle = createHttp3Handle(handle, settings);
      this.#h3handle[kApplicationOwner] = this;
    }
    // Claims the session's single onstream slot; anything else wanting these
    // streams has to chain onto this handler explicitly.
    session.onstream = (stream) => {
      if (typeof this.#onstream !== 'function') {
        process.emitWarning(
          'A new HTTP/3 stream was received but no onstream callback ' +
          'was provided');
        stream.destroy(undefined, { code: kH3RequestRejected });
        return;
      }

      return this.#onstream(new Http3Stream(stream, this));
    };
    if (ongoaway !== undefined) this.ongoaway = ongoaway;
    if (onorigin !== undefined) this.onorigin = onorigin;
    if (onsettings !== undefined) this.onsettings = onsettings;
  }

  [kGetHttp3Handle]() { return this.#h3handle; }

  // The peer asked for a graceful shutdown (GOAWAY). Streams above
  // lastStreamId were not processed by the peer and may be retried.
  [kOnGoaway](lastStreamId) {
    const session = this.#session;
    if (session.destroyed) return;
    markSessionClosing(session);
    if (onSessionClosingChannel.hasSubscribers) {
      onSessionClosingChannel.publish({ __proto__: null, session });
    }
    if (onSessionGoawayChannel.hasSubscribers) {
      onSessionGoawayChannel.publish({
        __proto__: null,
        session,
        lastStreamId,
      });
    }
    if (typeof this.#ongoaway === 'function') {
      quicSafeCallbackInvoke(() => this.#ongoaway(lastStreamId), session);
    }
  }

  /**
   * The peer announced the origins it claims authority for (HTTP/3
   * ORIGIN frame).
   * @param {string[]} origins
   */
  [kOnOrigin](origins) {
    const session = this.#session;
    if (session.destroyed) return;
    if (onSessionOriginChannel.hasSubscribers) {
      onSessionOriginChannel.publish({
        __proto__: null,
        origins,
        session,
      });
    }
    if (typeof this.#onorigin === 'function') {
      quicSafeCallbackInvoke(() => this.#onorigin(origins), session);
    }
  }

  [kOnSettings]() {
    const session = this.#session;
    if (session.destroyed) return;
    const settings = this.settings;
    if (onSessionApplicationChannel.hasSubscribers) {
      onSessionApplicationChannel.publish({
        __proto__: null,
        settings,
        session,
      });
    }
    if (typeof this.#onsettings === 'function') {
      quicSafeCallbackInvoke(() => this.#onsettings(settings), session);
    }
  }

  get session() { return this.#session; }

  // The configured settings plus any update from the peer's SETTINGS frame,
  // which may arrive after the session opens. Null once destroyed.
  get settings() {
    if (this.#session.destroyed) return null;
    return this.#h3handle?.settings();
  }

  get servername() { return this.#session.servername; }

  get alpnProtocol() { return this.#session.alpnProtocol; }

  get onstream() { return this.#onstream; }
  set onstream(fn) {
    if (fn !== undefined) validateFunction(fn, 'onstream');
    this.#onstream = fn;
  }

  get ongoaway() { return this.#ongoaway; }
  set ongoaway(fn) {
    if (fn !== undefined) validateFunction(fn, 'ongoaway');
    this.#ongoaway = fn;
  }

  get onorigin() { return this.#onorigin; }
  set onorigin(fn) {
    if (fn === undefined) {
      this.#onorigin = undefined;
      this.#h3handle?.setOriginListener(false);
    } else {
      validateFunction(fn, 'onorigin');
      this.#onorigin = fn;
      this.#h3handle?.setOriginListener(true);
    }
  }

  get onsettings() { return this.#onsettings; }
  set onsettings(fn) {
    if (fn !== undefined) validateFunction(fn, 'onsettings');
    this.#onsettings = fn;
  }

  get onerror() { return this.#session.onerror; }
  set onerror(fn) { this.#session.onerror = fn; }


  /** @type {Promise<object>} */
  get opened() { return this.#session.opened; }

  /** @type {Promise<void>} */
  get closed() { return this.#session.closed; }

  /**
   * Opens a bidirectional request stream with the optional headers. Headers
   * may instead be sent later with stream.sendHeaders(); callbacks are
   * passed in options so that they attach before any event can be delivered.
   * @returns {Promise<Http3Stream>}
   */
  async request(headers, options = kEmptyObject) {
    if (getQuicSessionState(this.#session).isServer) {
      throw new ERR_INVALID_STATE(
        'Server sessions cannot open HTTP/3 request streams');
    }
    if (headers !== undefined) validateObject(headers, 'headers');
    validateObject(options, 'options');
    const {
      onheaders,
      oninfo,
      ontrailers,
      onwanttrailers,
      onreset,
      onerror,
      priority,
      incremental,
      ...quicOptions
    } = options;

    if (priority !== undefined) {
      validateOneOf(priority, 'options.priority', ['default', 'low', 'high']);
    }
    if (incremental !== undefined) {
      validateBoolean(incremental, 'options.incremental');
    }

    let headerString;
    if (headers !== undefined) {
      let toSend = headers;
      const pri = priorityFieldValue(priority ?? 'default', incremental ?? false);
      if (pri !== undefined && !hasPriorityHeader(headers)) {
        toSend = { __proto__: null, ...headers, priority: pri };
      }
      headerString = buildNgHeaderString(
        toSend, assertValidPseudoHeader, true /* strictSingleValueFields */);
    }

    const stream = await this.#session.createBidirectionalStream(quicOptions);
    const wrapped = new Http3Stream(stream, this, {
      __proto__: null,
      onheaders,
      oninfo,
      ontrailers,
      onwanttrailers,
      onreset,
      onerror,
    });

    if (priority !== undefined || incremental !== undefined) {
      wrapped.setPriority({ __proto__: null, level: priority, incremental });
    }

    // Safe to submit only now the callbacks are attached: nothing for this
    // stream reaches the wire before the application sees these headers.
    if (headerString !== undefined) {
      const flags = quicOptions.body === undefined ?
        kHeadersFlagsTerminal : kHeadersFlagsNone;
      if (!wrapped[kSubmitInitialHeaders](headerString, flags)) {
        wrapped.destroy();
        throw new ERR_QUIC_OPEN_STREAM_FAILED();
      }
    }
    return wrapped;
  }

  close(options) { return this.#session.close(options); }

  destroy(error, options) { return this.#session.destroy(error, options); }
}

// C++ invokes each of these with `this` set to the handle the event belongs to
// (the stream handle, or the session's HTTP/3 handle), so route via its owner.
setHttp3Callbacks({
  onStreamHeaders(headers, kind) {
    this[kApplicationOwner]?.[kOnHeaders](headers, kind);
  },
  onStreamTrailers() {
    this[kApplicationOwner]?.[kOnWantTrailers]();
  },
  /**
   * The peer initiated a graceful shutdown of a session.
   * @param {bigint} lastStreamId
   */
  onSessionGoaway(lastStreamId) {
    this[kApplicationOwner]?.[kOnGoaway](lastStreamId);
  },
  /**
   * The peer announced the origins it claims authority for.
   * @param {string[]} origins
   */
  onSessionOrigin(origins) {
    this[kApplicationOwner]?.[kOnOrigin](origins);
  },
  onSessionApplication() {
    this[kApplicationOwner]?.[kOnSettings]();
  },
});

/**
 * SETTINGS values advertised to the peer (RFC 9114 section 7.2, RFC 9204),
 * plus limits enforced only locally.
 * @typedef {object} Http3Settings
 * @property {bigint|number} [maxHeaderPairs] Maximum number of header
 *   pairs accepted on a stream (local enforcement limit).
 * @property {bigint|number} [maxHeaderLength] Maximum total header
 *   bytes accepted on a stream (local enforcement limit).
 * @property {bigint|number} [maxFieldSectionSize] The maximum field
 *   section size advertised to the peer.
 * @property {bigint|number} [qpackMaxDTableCapacity] The QPACK maximum
 *   dynamic table capacity.
 * @property {bigint|number} [qpackEncoderMaxDTableCapacity] The QPACK
 *   encoder maximum dynamic table capacity.
 * @property {bigint|number} [qpackBlockedStreams] The maximum number of
 *   QPACK blocked streams.
 * @property {boolean} [enableConnectProtocol] Enable extended CONNECT
 *   (RFC 9220).
 */

/**
 * Connects a QUIC session with ALPN h3 and wraps it.
 * @param {SocketAddress|string} address
 * @param {object} [options]
 * @param {Http3Settings} [options.settings]
 * @returns {Promise<Http3Session>}
 */
async function connect(address, options = kEmptyObject) {
  validateObject(options, 'options');
  const { ongoaway, onorigin, onsettings, settings, ...quicOptions } = options;
  const session = await quicConnect(address, {
    ...quicOptions,
    // The onstream callback is owned by this layer. Datagrams are not (yet)
    // exposed for HTTP/3, so suppress ondatagram too.
    onstream: undefined,
    ondatagram: undefined,
    alpn: kHttp3Alpn,
    [kApplication]: 'http3',
    [kApplicationSettings]: settings,
  });
  return new Http3Session(session, { ongoaway, onorigin, onsettings });
}

/**
 * Listens with ALPN h3, invoking onsession with each new Http3Session.
 * @param {Function} onsession
 * @param {object} [options]
 * @param {Http3Settings} [options.settings]
 * @returns {Promise<object>} the listening QuicEndpoint
 */
async function listen(onsession, options = kEmptyObject) {
  validateFunction(onsession, 'onsession');
  validateObject(options, 'options');
  const { ongoaway, onorigin, onsettings, settings, ...quicOptions } = options;
  return quicListen((session) => {
    return onsession(new Http3Session(session, { ongoaway, onorigin, onsettings }));
  }, {
    ...quicOptions,
    onstream: undefined,
    ondatagram: undefined,
    alpn: kHttp3Alpn,
    [kApplication]: 'http3',
    [kApplicationSettings]: settings,
  });
}

module.exports = {
  Http3Session,
  Http3Stream,
  connect,
  listen,
};
