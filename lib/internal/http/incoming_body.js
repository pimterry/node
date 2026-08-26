'use strict';

const {
  Promise,
  PromiseReject,
  PromiseResolve,
  SymbolAsyncIterator,
} = primordials;

const {
  kValidatedSource,
} = require('internal/streams/iter/types');

const kDone = { __proto__: null, done: true, value: undefined };

function noop() {}

/**
 * The body of an incoming message, delivered to a pull consumer.
 *
 * This is the core of the inbound path and deliberately knows nothing about
 * messages, streams or events. It owns two things - holding the bytes until
 * they are asked for, and whether the socket should keep reading - and reports
 * everything else to its owner through the `onRead` and `onEnd` slots, which
 * an adapter fills in.
 *
 * It exists only for a message whose body something claimed. A message read
 * the classic way never builds one, and neither does one whose body is never
 * read: the parser pushes into the Readable, or holds the bytes on the
 * message, so those paths pay nothing for this.
 *
 * Tagged as a validated source so stream/iter's `from()`, `pull()` and the
 * consumer helpers take it as-is.
 */
class IncomingBody {
  constructor(owner, highWaterMark) {
    // Opaque to this class apart from `owner.socket`, which flow control
    // needs. Adapters hang their own meaning off it.
    this.owner = owner;
    // Captured once rather than read per chunk, so this stays independent of
    // where the owner keeps it. An owner with no high water mark means no
    // limit, rather than a limit of zero.
    this.highWaterMark = highWaterMark === undefined ? Infinity : highWaterMark;

    this.discarded = false;

    this.pending = [];
    this.pendingBytes = 0;
    this.ended = false;
    this.waiting = null;
    this.waitingReject = null;
    // Set when the message is destroyed before the body finished. A consumer
    // must see that as a failure, not as a short body that ended cleanly.
    this.errored = null;
    this.paused = false;
    this.consumed = false;

    // Adapter notifications. Called at most once each, with the body as
    // `this`, so filling them in costs no closure.
    this.onRead = noop;
    this.onEnd = noop;
  }

  [SymbolAsyncIterator]() {
    return this;
  }

  next() {
    if (this.errored !== null)
      return PromiseReject(this.errored);

    if (!this.consumed) {
      this.consumed = true;
      this.onRead();
    }

    const pending = this.pending;
    if (pending.length !== 0) {
      this.pending = [];
      this.pendingBytes = 0;
      if (this.paused) {
        this.paused = false;
        resumeReading(this.owner);
      }
      return PromiseResolve({ __proto__: null, done: false, value: pending });
    }

    if (this.ended)
      return PromiseResolve(kDone);

    return new Promise((resolve, reject) => {
      this.waiting = resolve;
      this.waitingReject = reject;
    });
  }

  /**
   * Called by the parser.
   * @param {Uint8Array} chunk Body bytes just parsed.
   * @returns {boolean} false when the consumer is behind and the socket should
   *   stop reading, matching what a false from `push` means.
   */
  write(chunk) {
    if (this.discarded)
      return true;

    const waiting = this.waiting;
    if (waiting !== null) {
      this.waiting = null;
      waiting({ __proto__: null, done: false, value: [chunk] });
      return true;
    }

    this.pending.push(chunk);
    this.pendingBytes += chunk.length;

    if (this.pendingBytes < this.highWaterMark)
      return true;

    this.paused = true;
    return false;
  }

  end() {
    this.ended = true;

    const waiting = this.waiting;
    if (waiting !== null) {
      this.waiting = null;
      this.waitingReject = null;
      waiting(kDone);
    }

    this.onEnd();
  }

  /**
   * The message was destroyed before the body finished. Anything waiting on
   * next(), and anything that asks later, has to see the failure - resolving
   * with done instead would present a truncated body as a complete one.
   * @param {Error} err Why the message ended early.
   */
  destroy(err) {
    if (this.ended || this.errored !== null)
      return;

    this.errored = err;
    this.pending = [];
    this.pendingBytes = 0;

    const reject = this.waitingReject;
    if (reject !== null) {
      this.waiting = null;
      this.waitingReject = null;
      reject(err);
    }
  }

  /** Nothing is reading and nothing will; keep the connection draining. */
  dump() {
    this.discarded = true;
    this.pending = [];
    this.pendingBytes = 0;

    if (this.paused) {
      this.paused = false;
      resumeReading(this.owner);
    }
  }
}

IncomingBody.prototype[kValidatedSource] = true;

function resumeReading(owner) {
  const socket = owner.socket;
  if (socket && !socket._paused && socket.readable)
    socket.resume();
}

module.exports = {
  IncomingBody,
};
