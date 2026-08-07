#!/usr/bin/env bash
# Probe B: run the diagnostic N times concurrently and summarise.
# usage: run-probe-b.sh <node> <runs> <parallelism> <outdir>
set -uo pipefail

NODE_BIN="$1"; RUNS="$2"; PAR="$3"; OUT="$4"
DIAG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pipeline-http2-diag.js"

echo "##### PROBE B: ${RUNS} runs, ${PAR} concurrent, out=${OUT} #####"
rm -rf "$OUT"; mkdir -p "$OUT"

export NODE_BIN DIAG OUT
run_one() {
  i="$1"
  PIPELINE_DIAG_MS="${PIPELINE_DIAG_MS:-30000}" "$NODE_BIN" "$DIAG" \
    > "$OUT/run-$i.out" 2>&1
  echo "$?" > "$OUT/run-$i.rc"
}
export -f run_one

seq 1 "$RUNS" | xargs -P "$PAR" -I{} bash -c 'run_one {}'

HUNG=0; FAILED=0; PASSED=0
for f in "$OUT"/*.rc; do
  rc="$(cat "$f")"
  case "$rc" in
    0)  PASSED=$((PASSED+1)) ;;
    99) HUNG=$((HUNG+1)) ;;
    *)  FAILED=$((FAILED+1)) ;;
  esac
done
echo "##### PROBE B RESULT: hung=$HUNG failed=$FAILED passed=$PASSED total=$RUNS #####"
echo "$HUNG" > "$OUT/hung.count"

# Aggregate the headline question across every hang: did anything move?
python3 - "$OUT" <<'PY'
import json, glob, os, sys, collections
d = sys.argv[1]
dumps = []
for f in sorted(glob.glob(os.path.join(d, '*.out'))):
    if os.path.getsize(f) == 0:
        continue
    t = open(f).read()
    i = t.find('{')
    if i < 0:
        continue
    try:
        dumps.append(json.loads(t[i:]))
    except Exception:
        pass
if not dumps:
    print('##### PROBE B: no hang dumps #####')
    raise SystemExit
print('##### PROBE B AGGREGATE over %d hangs #####' % len(dumps))
c = collections.Counter
print('dataEvents (10 needed to finish):', sorted(c(x['seen']['dataEvents'] for x in dumps).items()))
print('active requests               :', c(tuple(x['requests']) for x in dumps).most_common(3))
fz = [x.get('frozenOverSampleWindow', {}) for x in dumps]
for k in ('clientSockBytesRead', 'serverSockBytesRead', 'clientSessRecv',
          'serverSessRecv', 'dataEvents', 'rsPushes'):
    n = sum(1 for f in fz if f.get(k) is True)
    print(f'frozen {k:22s}: {n}/{len(dumps)}')
print('client remoteWindow min       :', min(x['clientSession']['state']['remoteWindowSize'] for x in dumps if x['clientSession'] and x['clientSession']['state']))
print('server remoteWindow min       :', min(x['serverSession']['state']['remoteWindowSize'] for x in dumps if x['serverSession'] and x['serverSession']['state']))
PY

n=0
for f in "$OUT"/*.rc; do
  rc="$(cat "$f")"; [ "$rc" = "0" ] && continue
  n=$((n+1)); [ "$n" -gt 3 ] && break
  echo "##### PROBE B FAILURE DUMP #$n (rc=$rc) #####"
  cat "${f%.rc}.out"
done
exit 0
