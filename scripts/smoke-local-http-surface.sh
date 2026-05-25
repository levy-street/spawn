#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'smoke-local-http-surface: missing required command: %s\n' "$1" >&2
    exit 1
  }
}

need bun
need cargo
need curl
need python3
need uv

tmp_dir="$(mktemp -d)"
server_pid=""
web_pid=""

cleanup() {
  local status=$?
  if [[ "$status" != "0" ]]; then
    if [[ -f "${server_log:-}" ]]; then
      printf '%s\n' "---- server log ----" >&2
      tail -200 "$server_log" >&2 || true
    fi
    if [[ -f "${web_log:-}" ]]; then
      printf '%s\n' "---- web log ----" >&2
      tail -200 "$web_log" >&2 || true
    fi
  fi
  for pid in "$web_pid" "$server_pid"; do
    if [[ -n "$pid" ]]; then
      kill "$pid" >/dev/null 2>&1 || true
      if command -v pkill >/dev/null 2>&1; then
        pkill -TERM -P "$pid" >/dev/null 2>&1 || true
      fi
      wait "$pid" 2>/dev/null || true
    fi
  done
  rm -rf "$tmp_dir"
  exit "$status"
}
trap cleanup EXIT

read -r server_port web_port < <(
  python3 - <<'PY'
import socket

sockets = []
ports = []
for _ in range(2):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sockets.append(sock)
    ports.append(sock.getsockname()[1])
print(*ports)
for sock in sockets:
    sock.close()
PY
)

server_url="http://127.0.0.1:$server_port"
web_url="http://127.0.0.1:$web_port"
server_log="$tmp_dir/server.log"
web_log="$tmp_dir/web.log"

wait_for_url() {
  local url="$1"
  local label="$2"
  local deadline="${3:-120}"
  local elapsed=0
  until curl -fsS --max-time 2 "$url" >/dev/null 2>&1; do
    if [[ "$elapsed" -ge "$deadline" ]]; then
      printf 'smoke-local-http-surface: timed out waiting for %s at %s\n' "$label" "$url" >&2
      return 1
    fi
    sleep 0.5
    elapsed=$((elapsed + 1))
  done
}

printf '%s\n' "smoke-local-http-surface: building local release daemon"
(cd daemon && cargo build --release --locked >/dev/null)

printf '%s\n' "smoke-local-http-surface: starting API server on $server_url"
(
  cd server
  exec env \
    SPAWN_DATABASE_URL="sqlite+aiosqlite:///$tmp_dir/spawn-http-smoke.db" \
    SPAWN_USE_INPROCESS_PUBSUB=1 \
    SPAWN_JWT_SECRET=smoke-http-surface-secret-with-enough-length \
    SPAWN_PUBLIC_URL="$web_url" \
    SPAWN_CORS_ORIGINS="$web_url" \
    uv run uvicorn spawn_server.main:app --host 127.0.0.1 --port "$server_port"
) >"$server_log" 2>&1 &
server_pid=$!

wait_for_url "$server_url/healthz" "API server"

printf '%s\n' "smoke-local-http-surface: starting web server on $web_url"
(
  cd web
  exec env SPAWN_API_PROXY_TARGET="$server_url" bun run dev -- -H 127.0.0.1 -p "$web_port"
) >"$web_log" 2>&1 &
web_pid=$!

wait_for_url "$web_url/" "web server"

printf '%s\n' "smoke-local-http-surface: checking web HTTP surface"
scripts/smoke-http-surface.sh "$web_url"

printf '%s\n' "smoke-local-http-surface: passed"
