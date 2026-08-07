# Candidate fix (under test — not proposed for merge)

## The deadlock

`Http2Session::MaybeStopReading()` stops reading from the socket whenever a
write is in progress. Added in `ba624b6766f` to mitigate **CVE-2019-9511 /
CVE-2019-9517** (HTTP/2 "Data Dribble" / "Internal Data Buffering"): refuse to
take on more input while output is backed up.

With the old 64KB window a peer could never put enough in flight to fill a
socket send buffer, so a write always drained and reading always resumed. With
the 4MB stream / 32MB connection defaults both peers can fill both socket send
buffers at once. Both then stop reading, so neither `uv_write` can drain, so
neither resumes reading. Deadlock.

Confirmed on macOS CI: 61/300 timeouts and 24/200 hangs on the Aug 5 nightly,
0 on the Aug 4 nightly which predates the window change. Every hang dump showed
two outstanding `WriteWrap`s, both sessions with `outboundQueueSize: 0`, and
~32MB of remote window still available — i.e. both peers wanted to send, were
allowed to send, and simply could not.

## Why the obvious fix does not work

Dropping `|| is_write_in_progress()` reintroduces the CVE, so the bound has to
stay. But it also breaks an invariant: `OnDataChunkReceived` has a *second*
gate on the same condition, and asserts the first one fired.

```c
if (session->is_write_in_progress()) {
  CHECK(session->is_reading_stopped());
  session->set_receive_paused();
  return NGHTTP2_ERR_PAUSE;
}
```

Relaxing only `MaybeStopReading()` aborts immediately:

```
Assertion failed: session->is_reading_stopped()
  at ../../src/node_http2.cc:1491  (Http2Session::OnDataChunkReceived)
```

Socket reading and nghttp2 receive-processing are gated together, so both must
be relaxed together.

## What this candidate does

Keep a hard bound on buffering, but express it as an explicit memory budget
(`maxSessionMemory`, 10MB by default) rather than as "any write is in flight".
An attacker still cannot force unbounded buffering — the bound is explicit
instead of implied by write progress — while two well-behaved peers can always
read enough to let each other drain.

Site 1 — `MaybeStopReading()`:

```c
  if (want_read == 0 ||
      (is_write_in_progress() && !has_available_session_memory(0))) {
```

Site 2 — `OnDataChunkReceived()`, kept consistent with site 1:

```c
  if (session->is_write_in_progress() && session->is_reading_stopped()) {
    session->set_receive_paused();
```

## Status

- Compiles clean.
- All **289** `test-http2-*` tests pass (parallel + sequential) on Linux.
- Efficacy **unproven**: the deadlock has never reproduced on Linux, so local
  runs cannot show it fixes anything. That is what the `fix-test` CI job is for
  — it A/Bs baseline vs patched on macOS, and reports INCONCLUSIVE if the
  baseline fails to reproduce.
- Not reviewed against the CVE threat model by anyone but me. The memory-budget
  bound is a *claim*, not an established equivalence, and needs security review
  before this goes anywhere near a PR.
