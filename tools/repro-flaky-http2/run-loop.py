#!/usr/bin/env python3
"""Run a node test in a tight loop and capture full diagnostics on hang.

Usage:
  run-loop.py NODE TEST OUTDIR ITER TIMEOUT_S MAX_HANGS [extra env...]

For every iteration:
  - Spawn `NODE TEST` with stdout+stderr piped.
  - Wait up to TIMEOUT_S seconds. On timeout, treat as a hang and capture:
      * `sample <pid> 3` (macOS sampling profile).
      * `lldb -p <pid>` thread backtrace all + Node-related ivars.
      * `lsof -p <pid>` to dump open FDs/sockets.
      * `vmmap <pid>` to dump memory map.
      * The diagnostic report file the JS-side writer produces (if any).
      * Saved stdout/stderr captured up to that point.
    Then SIGKILL.
  - On non-zero exit, treat as an error and save stdout/stderr.
  - On exit code 99, treat as an internally-detected hang (instrumented test).

Extra env vars on the command line are appended as KEY=VALUE.
Stops early once `MAX_HANGS` hangs/errors have been captured.
"""

import os
import subprocess
import sys
import time
from pathlib import Path


def parse_args():
    if len(sys.argv) < 7:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    node = sys.argv[1]
    test = sys.argv[2]
    outdir = Path(sys.argv[3])
    iters = int(sys.argv[4])
    timeout_s = float(sys.argv[5])
    max_hangs = int(sys.argv[6])
    env_extras = {}
    for kv in sys.argv[7:]:
        if "=" in kv:
            k, v = kv.split("=", 1)
            env_extras[k] = v
    return node, test, outdir, iters, timeout_s, max_hangs, env_extras


def run_capture(cmd, timeout):
    try:
        return subprocess.run(
            cmd, capture_output=True, timeout=timeout,
            stdin=subprocess.DEVNULL,
        )
    except FileNotFoundError as e:
        return type("R", (), {"stdout": b"", "stderr": str(e).encode(), "returncode": 127})()
    except subprocess.TimeoutExpired as e:
        return type("R", (), {
            "stdout": e.stdout or b"",
            "stderr": (e.stderr or b"") + b"\n[TIMED OUT]\n",
            "returncode": -1,
        })()


def capture_native_state(pid, dest_prefix):
    """Capture sample/lldb/lsof/vmmap output for a hung process."""
    captures = []

    # sample(1) is fast and doesn't require lldb privileges.
    sample_path = f"{dest_prefix}.sample.txt"
    r = run_capture(["sample", str(pid), "2"], timeout=20)
    Path(sample_path).write_bytes(r.stdout + b"\n--STDERR--\n" + r.stderr)
    captures.append(sample_path)

    # lldb backtrace; gives us thread state too.
    lldb_path = f"{dest_prefix}.lldb.txt"
    r = run_capture(
        [
            "lldb", "--batch", "-p", str(pid),
            "-o", "thread list",
            "-o", "thread backtrace all",
            "-o", "process detach",
        ], timeout=30,
    )
    Path(lldb_path).write_bytes(r.stdout + b"\n--STDERR--\n" + r.stderr)
    captures.append(lldb_path)

    # lsof: FDs, sockets — useful to spot stuck TCP connections.
    lsof_path = f"{dest_prefix}.lsof.txt"
    r = run_capture(["lsof", "-nP", "-p", str(pid)], timeout=15)
    Path(lsof_path).write_bytes(r.stdout + b"\n--STDERR--\n" + r.stderr)
    captures.append(lsof_path)

    # netstat-style snapshot of all sockets on the box (no -p filter on macOS).
    netstat_path = f"{dest_prefix}.netstat.txt"
    r = run_capture(["netstat", "-anvp", "tcp"], timeout=15)
    if not r.stdout:
        r = run_capture(["netstat", "-an"], timeout=15)
    Path(netstat_path).write_bytes(r.stdout + b"\n--STDERR--\n" + r.stderr)
    captures.append(netstat_path)

    return captures


def main():
    node, test, outdir, iters, timeout_s, max_hangs, env_extras = parse_args()
    outdir.mkdir(parents=True, exist_ok=True)
    hangs_dir = outdir / "hangs"
    errors_dir = outdir / "errors"
    hangs_dir.mkdir(exist_ok=True)
    errors_dir.mkdir(exist_ok=True)

    env = dict(os.environ)
    env.update(env_extras)

    success = 0
    hangs = 0
    errors = 0
    internal_hangs = 0
    started_at = time.monotonic()

    progress_path = outdir / "progress.txt"

    for i in range(1, iters + 1):
        proc = subprocess.Popen(
            [node, test],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        try:
            stdout, stderr = proc.communicate(timeout=timeout_s)
            rc = proc.returncode
            if rc == 0:
                success += 1
            elif rc == 99:
                # Instrumented JS dumped state and exited cleanly.
                internal_hangs += 1
                idx = internal_hangs
                if idx <= max_hangs:
                    p = hangs_dir / f"internal-{idx:04d}"
                    p.with_suffix(".stdout.txt").write_bytes(stdout)
                    p.with_suffix(".stderr.txt").write_bytes(stderr)
            else:
                errors += 1
                idx = errors
                if idx <= max_hangs:
                    p = errors_dir / f"err-{idx:04d}"
                    (p.with_suffix(".meta.txt")).write_text(f"rc={rc}\n")
                    p.with_suffix(".stdout.txt").write_bytes(stdout)
                    p.with_suffix(".stderr.txt").write_bytes(stderr)
        except subprocess.TimeoutExpired:
            hangs += 1
            idx = hangs
            if idx <= max_hangs:
                prefix = str(hangs_dir / f"hang-{idx:04d}")
                # Capture native diagnostics first (process is still alive).
                capture_native_state(proc.pid, prefix)
                # Then read whatever stdout/stderr was buffered up to now.
                proc.kill()
                try:
                    rest_out, rest_err = proc.communicate(timeout=10)
                except subprocess.TimeoutExpired:
                    rest_out, rest_err = b"", b"[final communicate timed out]"
                Path(f"{prefix}.stdout.txt").write_bytes(rest_out)
                Path(f"{prefix}.stderr.txt").write_bytes(rest_err)
            else:
                proc.kill()
                proc.wait()

        if i % 50 == 0 or hangs >= max_hangs or errors >= max_hangs:
            elapsed = time.monotonic() - started_at
            line = (
                f"iter={i} success={success} hang={hangs} "
                f"internal_hang={internal_hangs} err={errors} "
                f"elapsed={elapsed:.1f}s"
            )
            print(line)
            sys.stdout.flush()
            progress_path.write_text(line + "\n")

        if hangs + internal_hangs + errors >= max_hangs:
            print(
                f"reached max captures ({max_hangs}); stopping at iteration {i}"
            )
            break

    elapsed = time.monotonic() - started_at
    summary = (
        f"node={node}\n"
        f"test={test}\n"
        f"env={env_extras}\n"
        f"iterations_run={i}\n"
        f"success={success}\n"
        f"hang={hangs}\n"
        f"internal_hang={internal_hangs}\n"
        f"error={errors}\n"
        f"elapsed_s={elapsed:.1f}\n"
    )
    (outdir / "summary.txt").write_text(summary)
    print("---")
    print(summary, end="")

    # Exit non-zero if we captured any hang/error so the workflow sees the
    # signal — but don't fail before we get a chance to upload artifacts.
    sys.exit(0)


if __name__ == "__main__":
    main()
