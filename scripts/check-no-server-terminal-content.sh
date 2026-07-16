#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

forbidden() {
  local label="$1"
  local pattern="$2"
  shift 2
  local matches
  matches="$(rg -n --color never "$pattern" "$@" || true)"
  if [[ -n "$matches" ]]; then
    printf 'no-server-terminal-content: %s\n%s\n' "$label" "$matches" >&2
    exit 1
  fi
}

for removed in \
  daemon/src/frames.rs \
  server/spawn_server/transcript.py \
  server/spawn_server/ws/frames.py; do
  if [[ -e "$removed" ]]; then
    printf 'no-server-terminal-content: retired file returned: %s\n' "$removed" >&2
    exit 1
  fi
done

forbidden \
  "daemon control socket regained a terminal binary path" \
  'WsOutbound::Binary|WsInbound::Binary|KIND_PTY_(INPUT|OUTPUT)|crate::frames|mod frames|from_legacy|legacy_signal' \
  daemon/src
forbidden \
  "daemon production code advertises the retired protocol" \
  'spawn\.v1|spawn\.control\.v1' \
  daemon/src
forbidden \
  "server regained transcript or terminal-frame helpers" \
  '(^|[[:space:]])(from|import).*transcript|ws\.frames|agent\.snapshot' \
  server/spawn_server
forbidden \
  "server websocket regained a binary send path" \
  'send_bytes\(' \
  server/spawn_server/ws/browser.py \
  server/spawn_server/ws/daemon.py \
  server/spawn_server/ws/broker.py
forbidden \
  "server regained a REST terminal-content or viewport route" \
  '@router\.(post|get)\("/\{agent_id\}/(input|resize|scroll|redraw|snapshot)' \
  server/spawn_server/routes
forbidden \
  "server regained agent terminal-content pubsub" \
  'spawn:agent:\{agent_id\}"|backend\.(publish|subscribe)\(agent_id' \
  server/spawn_server
forbidden \
  "browser bundle regained the v1 terminal relay" \
  'spawn\.v1|SPAWN_WS_SUBPROTOCOLS|forceV1|wsV2Ref|WsFallback' \
  web/src

printf '%s\n' "no-server-terminal-content: passed"
