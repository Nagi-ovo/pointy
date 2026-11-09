#!/bin/zsh
# usage: down.sh   stops what up.sh started, by the pids it recorded, closes
# the fixture documents this run opened, and removes the scratch homes and
# builds. $VP_RUN/evidence stays.
set -u
source ${0:A:h}/env.sh
for p in dsh pointy mock; do
  root=$(pid $p) || continue
  all=($(tree $root))
  kill $all 2>/dev/null
  sleep 1
  for q in $all; do kill -0 $q 2>/dev/null && kill -9 $q && log "killed -9 $p $q"; done
done
for doc in $(cat "$VP_RUN/fixtures" 2>/dev/null); do
  osascript -e "tell application \"TextEdit\" to close (every document whose path is \"$doc\") saving no" > /dev/null 2>&1
done
pa close > /dev/null 2>&1
rm -rf "$VP_RUN/home" "$VP_RUN/dsh-home" "$VP_RUN/ws" "$BIN" "$VP_RUN"/*.tgz "$SOCK"
log "down; evidence in $EV"
