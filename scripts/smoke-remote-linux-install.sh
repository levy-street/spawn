#!/usr/bin/env bash
set -euo pipefail

host="${1:-}"
if [[ -z "$host" ]]; then
  printf 'Usage: %s ssh-host\n' "$0" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

binary="daemon/target/prebuilt/linux-x86_64/spawnd"
worker_binary="daemon/target/prebuilt/linux-x86_64/spawn-worker"
if [[ ! -x "$binary" ]]; then
  printf 'smoke-remote-linux-install: missing %s\n' "$binary" >&2
  exit 1
fi
if [[ ! -x "$worker_binary" ]]; then
  printf 'smoke-remote-linux-install: missing %s\n' "$worker_binary" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
remote_tmp=""

cleanup() {
  local status=$?
  rm -rf "$tmp_dir"
  if [[ -n "$remote_tmp" ]]; then
    ssh "$host" "rm -rf '$remote_tmp'" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT

install_script="$tmp_dir/install.sh"
(
  cd server
  uv run python - >"$install_script" <<'PY'
import shlex

from spawn_server.routes.install import DEFAULT_BRANCH, DEFAULT_REPO, INSTALL_SCRIPT

script = INSTALL_SCRIPT.replace("__DEFAULT_SERVER__", shlex.quote("http://localhost:8000"))
script = script.replace("__DEFAULT_REPO__", shlex.quote(DEFAULT_REPO))
script = script.replace("__DEFAULT_BRANCH__", shlex.quote(DEFAULT_BRANCH))
print(script, end="")
PY
)

remote_tmp="$(ssh "$host" 'mktemp -d')"
ssh "$host" "mkdir -p '$remote_tmp/api/install/spawnd' '$remote_tmp/api/install/spawn-worker'"
scp -q "$install_script" "$host:$remote_tmp/install.sh"
scp -q "$binary" "$host:$remote_tmp/api/install/spawnd/linux-x86_64"
scp -q "$worker_binary" "$host:$remote_tmp/api/install/spawn-worker/linux-x86_64"

ssh "$host" "SPAWN_REMOTE_INSTALL_SMOKE_DIR='$remote_tmp' bash -se" <<'REMOTE'
set -euo pipefail

work="$SPAWN_REMOTE_INSTALL_SMOKE_DIR"
server_pid=""
cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

chmod 755 "$work/api/install/spawnd/linux-x86_64"
chmod 755 "$work/api/install/spawn-worker/linux-x86_64"
port="$(
  python3 - <<'PY'
import socket

s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$work" >"$work/http.log" 2>&1 &
server_pid=$!

for _ in {1..80}; do
  if curl -fsS "http://127.0.0.1:$port/install.sh" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
curl -fsS "http://127.0.0.1:$port/install.sh" >/dev/null

mkdir -p "$work/home" "$work/install"
HOME="$work/home" SPAWN_INSTALL_ROOT="$work/install" sh "$work/install.sh" \
  --server "http://127.0.0.1:$port" \
  --no-login \
  --no-start \
  --no-service \
  --prebuilt-only

"$work/install/bin/spawnd" --version >/dev/null
test -x "$work/install/bin/spawn-worker"
printf '%s\n' "smoke-remote-linux-install: passed"
REMOTE
