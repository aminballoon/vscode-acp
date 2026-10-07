#!/bin/zsh
# macOS only. Runs the `ui` test suite (real Chat view, fake agent) and
# screenshots just the test window whenever the test requests a shot.
# Output: .vscode-test/screenshots/*.png
# Requires Screen Recording permission for your terminal app.
# Prints test results live, a heartbeat every 30s, and kills the run after
# UI_TIMEOUT seconds (default 600) so a hang is visible instead of silent.
set -e
ROOT=${0:a:h:h}
OUT=$ROOT/.vscode-test/screenshots
WINID=$ROOT/.vscode-test/winid
mkdir -p $OUT && rm -f $OUT/*(N)
[ -x $WINID ] || swiftc -O $ROOT/scripts/winid.swift -o $WINID

cd $ROOT
npm run compile >/dev/null && npm run compile-tests >/dev/null
: > $OUT/ui.log
ACP_UI_SIGNAL_DIR=$OUT npx vscode-test --label ui > $OUT/ui.log 2>&1 &
pid=$!
start=$SECONDS seen=0 beat=0 code=0
timeout=${UI_TIMEOUT:-600}

while kill -0 $pid 2>/dev/null; do
  lines=$(wc -l < $OUT/ui.log)
  if (( lines > seen )); then
    sed -n "$((seen + 1)),${lines}p" $OUT/ui.log | grep -E '✔|✖|[0-9]+\) |passing|failing' || true
    seen=$lines
  fi
  elapsed=$((SECONDS - start))
  if (( elapsed >= beat + 30 )); then
    beat=$elapsed
    echo "… still running (${elapsed}s, last log: $(tail -1 $OUT/ui.log | cut -c1-80))"
  fi
  if (( elapsed >= timeout )); then
    echo "UI tests timed out after ${timeout}s; last log lines:"
    tail -20 $OUT/ui.log
    pkill -P $pid 2>/dev/null; kill $pid 2>/dev/null
    exit 124
  fi
  for r in $OUT/*.req(N); do
    n=${r:t:r}
    id=$($WINID "Extension Development Host" | head -1 | cut -f1)
    [ -n "$id" ] && screencapture -x -o -l$id $OUT/$n.tmp.png && mv $OUT/$n.tmp.png $OUT/$n.png
    rm -f $r
  done
  sleep 0.5
done
wait $pid || code=$?
sed -n "$((seen + 1)),\$p" $OUT/ui.log | grep -E '✔|✖|[0-9]+\) |passing|failing' || true
echo "Screenshots in $OUT"
exit $code
