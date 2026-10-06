#!/bin/zsh
# macOS only. Runs the `ui` test suite (real Chat view, fake agent) and
# screenshots just the test window whenever the test requests a shot.
# Output: .vscode-test/screenshots/*.png
# Requires Screen Recording permission for your terminal app.
set -e
ROOT=${0:a:h:h}
OUT=$ROOT/.vscode-test/screenshots
WINID=$ROOT/.vscode-test/winid
mkdir -p $OUT && rm -f $OUT/*(N)
[ -x $WINID ] || swiftc -O $ROOT/scripts/winid.swift -o $WINID

cd $ROOT
npm run compile >/dev/null && npm run compile-tests >/dev/null
(ACP_UI_SIGNAL_DIR=$OUT npx vscode-test --label ui > $OUT/ui.log 2>&1; echo $? > $OUT/exit) &

while [ ! -f $OUT/exit ]; do
  for r in $OUT/*.req(N); do
    n=${r:t:r}
    id=$($WINID "Extension Development Host" | head -1 | cut -f1)
    [ -n "$id" ] && screencapture -x -o -l$id $OUT/$n.tmp.png && mv $OUT/$n.tmp.png $OUT/$n.png
    rm -f $r
  done
  sleep 0.5
done
code=$(cat $OUT/exit); rm -f $OUT/exit
grep -E "passing|failing" $OUT/ui.log || true
echo "Screenshots in $OUT"
exit $code
