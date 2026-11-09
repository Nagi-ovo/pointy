#!/bin/zsh
# usage: up.sh [locale]   e.g. up.sh zh-CN; prints the export line for VP_RUN.
# Builds this checkout and starts, each in a scratch home: the mock model on
# 47398, the e2e build of Pointy on 47397, and DSH web on 3093 with the
# packed plugin.
set -u
export VP_RUN=${${VP_RUN:-$(mktemp -d /tmp/verify-pointy.XXXXXX)}:A}  # DSH wants the real path, /private/tmp
source ${0:A:h}/env.sh
LOCALE=${1:-}
DSH=${DSH:-dsh}
mkdir -p "$BIN" "$VP_RUN/pids" "$VP_RUN/home/.pointy" "$VP_RUN/dsh-home/storages" "$VP_RUN/ws"

for port in $POINTY_PORT $MOCK_PORT $DSH_PORT; do
  lsof -nP -iTCP:$port -sTCP:LISTEN > /dev/null 2>&1 && die "port $port is taken; another run may be up (down.sh it) or something else owns it"
done

log "building pages and plugin"
(cd "$REPO" && node tools/build.ts) > "$VP_RUN/build.log" 2>&1 || die "tools/build.ts failed, see $VP_RUN/build.log"
(cd "$REPO/desktop" && go build -tags e2e -o "$BIN/Pointy" . && go build -o "$BIN/drive" ./cmd/drive \
  && go build -o "$BIN/mygo-automation" github.com/egoist/mygo/plugins/automation/cmd/mygo-automation) >> "$VP_RUN/build.log" 2>&1 \
  || die "go build failed, see $VP_RUN/build.log"
(cd "$REPO" && npm pack ./plugin --pack-destination "$VP_RUN") > "$VP_RUN/pack.log" 2>&1 || die "npm pack failed, see $VP_RUN/pack.log"

# welcomedVersion is the version Pointy reads from build/../package.json, so
# neither the full-screen intro nor the welcome covers the screen at start.
now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
print -r -- "{\"unit\":{\"name\":\"workspace\",\"version\":2},\"global\":{\"initialized\":true,\"workspaceIds\":[\"11111111-1111-4111-8111-111111111111\"],\"archivedSessionIds\":[],\"pinnedSessionIds\":[]},\"tables\":{\"workspaces\":{\"11111111-1111-4111-8111-111111111111\":{\"path\":\"$VP_RUN/ws\",\"title\":\"verify-pointy\",\"sessionIds\":[],\"createdAt\":\"$now\",\"updatedAt\":\"$now\"}}}}" > "$VP_RUN/dsh-home/storages/workspace.json"
print -r -- "{ \"dnd\": false, \"shake\": true, \"shakeLevel\": \"medium\", \"welcomed\": true, \"welcomedVersion\": \"$(node -p "require('$REPO/package.json').version")\", \"locale\": \"$LOCALE\" }" > "$VP_RUN/home/.pointy/settings.json"

export HOME=$VP_RUN/home DSH_HOME=$VP_RUN/dsh-home POINTY_HOME=$VP_RUN/home/.pointy POINTY_PORT
"$DSH" plugin --profile web add "$(print -r -- $VP_RUN/pointylab-dsh-*.tgz)" > "$VP_RUN/plugin-add.log" 2>&1 || die "dsh plugin add failed, see $VP_RUN/plugin-add.log"
print -r -- '- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-official
    model: deepseek-v4-flash' > "$DSH_HOME/profiles/web/cordis.patch.yml"

: > "$EV/mock.jsonl"
node "$REPO/tools/mock-llm.ts" $MOCK_PORT "$EV/mock.jsonl" > "$VP_RUN/mock.log" 2>&1 &
print $! > "$VP_RUN/pids/mock"

# Pointy first: the plugin starts its own runtime when nothing listens.
POINTY_ROOT=$REPO/build MYGO_AUTOMATION=$SOCK "$BIN/Pointy" > "$VP_RUN/pointy.log" 2>&1 &
print $! > "$VP_RUN/pids/pointy"
wait_until 20 "Pointy on $POINTY_PORT" nc -z 127.0.0.1 $POINTY_PORT

DEEPSEEK_BASE_URL=http://127.0.0.1:$MOCK_PORT/anthropic DEEPSEEK_API_KEY=sk-mock-0000000000000000 \
  "$DSH" web --port $DSH_PORT --no-open > "$VP_RUN/dsh.log" 2>&1 &
print $! > "$VP_RUN/pids/dsh"
wait_until 120 "the plugin to connect" grep -q dsh-ui "$POINTY_HOME/error.log"

log "up: pointy=$(pid pointy) dsh=$(pid dsh) mock=$(pid mock) locale=${LOCALE:-system}"
print -r -- "export VP_RUN=$VP_RUN"
