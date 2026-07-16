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
    printf 'no-server-agent-upload: %s\n%s\n' "$label" "$matches" >&2
    exit 1
  fi
}

if [[ -e server/spawn_server/agent_control.py ]]; then
  printf '%s\n' \
    "no-server-agent-upload: retired server agent upload helper returned" >&2
  exit 1
fi

forbidden \
  "REST agent upload route or schema returned" \
  '@router\.(post|get)\("/\{agent_id\}/upload|AgentUpload|bytes_b64' \
  server/spawn_server/routes/agents.py \
  server/spawn_server/schemas.py
forbidden \
  "server broker regained an agent upload waiter" \
  'request_upload|resolve_upload|UploadResolution|agent\.upload|upload\.(saved|error|legacy)' \
  server/spawn_server/ws/broker.py \
  server/spawn_server/ws/owner_dispatch.py
forbidden \
  "daemon control websocket regained an agent upload leg" \
  'AgentUpload|agent\.upload(ed)?|send_upload_error' \
  daemon/src/proto.rs \
  daemon/src/run.rs
forbidden \
  "web API or signaling types regained an agent upload leg" \
  'AgentUpload|agents\.(upload|uploadFile)|upload\.(saved|error)|bytes_b64|/agents/\$\{[^}]+\}/upload' \
  web/src/lib/api.ts \
  web/src/lib/ws.ts

rg -q 'reason="agent uploads belong on spawn\.ctl"' server/spawn_server/ws/browser.py
rg -q 'reason="agent upload acknowledgements belong on spawn\.ctl"' \
  server/spawn_server/ws/daemon.py
rg -q 'reason="agent upload errors belong on spawn\.ctl"' \
  server/spawn_server/ws/daemon.py

printf '%s\n' "no-server-agent-upload: passed"
