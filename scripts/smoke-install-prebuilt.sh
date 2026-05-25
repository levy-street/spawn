#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'smoke-install-prebuilt: missing required command: %s\n' "$1" >&2
    exit 1
  }
}

need cargo
need curl
need python3
need tmux

tmp_dir="$(mktemp -d)"
server_pid=""

cleanup() {
  local status=$?
  if [[ "$status" != "0" && -f "${server_log:-}" ]]; then
    printf '%s\n' "---- server log ----" >&2
    tail -200 "$server_log" >&2 || true
  fi
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
  exit "$status"
}
trap cleanup EXIT

port="$(
  python3 - <<'PY'
import socket

s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"
base_url="http://127.0.0.1:$port"
server_log="$tmp_dir/server.log"
install_root="$tmp_dir/install-root"
home="$tmp_dir/home"
mkdir -p "$install_root" "$home"

printf '%s\n' "smoke-install-prebuilt: building release spawnd"
(cd daemon && cargo build --release --locked >/dev/null)

printf '%s\n' "smoke-install-prebuilt: starting install server on $base_url"
(
  cd server
  SPAWN_DATABASE_URL="sqlite+aiosqlite:///$tmp_dir/spawn-install-smoke.db" \
    SPAWN_USE_INPROCESS_PUBSUB=1 \
    SPAWN_JWT_SECRET=smoke-install-secret-with-enough-length \
    SPAWN_PUBLIC_URL="$base_url" \
    uv run uvicorn spawn_server.main:app --host 127.0.0.1 --port "$port" \
      >"$server_log" 2>&1
) &
server_pid=$!

for _ in {1..80}; do
  if curl -fsS "$base_url/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
curl -fsS "$base_url/healthz" >/dev/null

printf '%s\n' "smoke-install-prebuilt: running installer"
HOME="$home" \
  SPAWN_INSTALL_ROOT="$install_root" \
  curl -fsSL "$base_url/install.sh" | HOME="$home" SPAWN_INSTALL_ROOT="$install_root" sh -s -- \
    --server "$base_url" \
    --no-login \
    --no-start \
    --no-service \
    --prebuilt-only

"$install_root/bin/spawnd" --version >/dev/null
printf '%s\n' "smoke-install-prebuilt: passed"
