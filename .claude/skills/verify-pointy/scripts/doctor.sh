#!/bin/zsh
# usage: doctor.sh   read-only: is this run's instance worth driving?
set -u
source ${0:A:h}/env.sh
bad=0
check() { if eval "$2" > /dev/null 2>&1; then print "ok   $1"; else print "FAIL $1"; bad=1; fi }
for p in pointy dsh mock; do check "$p is running (pid $(pid $p))" "kill -0 $(pid $p)"; done
check "port $POINTY_PORT belongs to this run's Pointy" "[ \"\$(lsof -tnP -iTCP:$POINTY_PORT -sTCP:LISTEN)\" = $(pid pointy) ]"
check "port $MOCK_PORT belongs to this run's mock" "[ \"\$(lsof -tnP -iTCP:$MOCK_PORT -sTCP:LISTEN)\" = $(pid mock) ]"
check "port $DSH_PORT belongs to this run's DSH" "tree $(pid dsh) | grep -qx \"\$(lsof -tnP -iTCP:$DSH_PORT -sTCP:LISTEN)\""
check "the plugin connected to Pointy" "grep -q dsh-ui $VP_RUN/home/.pointy/error.log"
check "the automation socket answers" "pa open --socket $SOCK"
check "Pointy is this checkout's build" "[ $BIN/Pointy -nt $REPO/desktop/go.mod ]"
check "the screen is unlocked" "[ \"\$(drive locked)\" = false ]"
print "user idle for $(drive idle)s; Pointy says: $(grep -v dsh-ui $VP_RUN/home/.pointy/error.log 2>/dev/null | tail -3)"
exit $bad
