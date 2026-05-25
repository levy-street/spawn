#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'smoke-local-login: missing required command: %s\n' "$1" >&2
    exit 1
  }
}

need cargo
need curl
need python3
need uv

tmp_dir="$(mktemp -d)"
server_pid=""
login_pid=""
watchdog_pid=""

cleanup() {
  local status=$?
  if [[ -n "$watchdog_pid" ]]; then
    kill "$watchdog_pid" >/dev/null 2>&1 || true
    wait "$watchdog_pid" 2>/dev/null || true
  fi
  if [[ -n "$login_pid" ]]; then
    kill "$login_pid" >/dev/null 2>&1 || true
    wait "$login_pid" 2>/dev/null || true
  fi
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [[ "$status" != "0" ]]; then
    for log in "${server_log:-}" "${login_out:-}" "${login_err:-}" "${status_out:-}" "${status_err:-}"; do
      if [[ -n "$log" && -f "$log" ]]; then
        printf '---- %s ----\n' "$(basename "$log")" >&2
        tail -200 "$log" >&2 || true
      fi
    done
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
db_path="$tmp_dir/spawn-login-smoke.db"
db_url="sqlite+aiosqlite:///$db_path"
home="$tmp_dir/home"
server_log="$tmp_dir/server.log"
login_out="$tmp_dir/login.out"
login_err="$tmp_dir/login.err"
status_out="$tmp_dir/status.out"
status_err="$tmp_dir/status.err"
mkdir -p "$home"

printf '%s\n' "smoke-local-login: building spawnd"
(cd daemon && cargo build --locked >/dev/null)

printf '%s\n' "smoke-local-login: preparing database"
(
  cd server
  SPAWN_DATABASE_URL="$db_url" \
    SPAWN_USE_INPROCESS_PUBSUB=1 \
    SPAWN_JWT_SECRET=smoke-login-secret-with-enough-length \
    SPAWN_PUBLIC_URL="$base_url" \
    uv run python - <<'PY'
import asyncio

import spawn_server.models  # noqa: F401
from spawn_server.db import Base, dispose_engine, get_engine, init_engine


async def main() -> None:
    init_engine()
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await dispose_engine()


asyncio.run(main())
PY
)

printf '%s\n' "smoke-local-login: starting server on $base_url"
(
  cd server
  SPAWN_DATABASE_URL="$db_url" \
    SPAWN_USE_INPROCESS_PUBSUB=1 \
    SPAWN_JWT_SECRET=smoke-login-secret-with-enough-length \
    SPAWN_PUBLIC_URL="$base_url" \
    uv run uvicorn spawn_server.main:app --host 127.0.0.1 --port "$port" \
      >"$server_log" 2>&1
) &
server_pid=$!

for _ in {1..100}; do
  if curl -fsS "$base_url/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
curl -fsS "$base_url/healthz" >/dev/null

user_token="$(
  python3 - "$base_url" <<'PY'
import json
import sys
import urllib.error
import urllib.request

base_url = sys.argv[1]
req = urllib.request.Request(
    base_url + "/api/auth/signup",
    data=json.dumps({"email": "cli-login-smoke@example.com", "password": "passpasspass"}).encode(),
    method="POST",
    headers={"Content-Type": "application/json"},
)
try:
    with urllib.request.urlopen(req, timeout=10) as response:
        print(json.loads(response.read().decode())["access_token"])
except urllib.error.HTTPError as error:
    raise SystemExit(f"signup failed: {error.code} {error.read().decode()}") from error
PY
)"

printf '%s\n' "smoke-local-login: running spawnd login"
HOME="$home" \
  SPAWN_DISABLE_KEYRING=1 \
  daemon/target/debug/spawnd --server "$base_url" login --host-name cli-login-smoke --no-run \
  >"$login_out" 2>"$login_err" &
login_pid=$!

user_code="$(
  python3 - "$db_path" <<'PY'
import sqlite3
import sys
import time

db_path = sys.argv[1]
for _ in range(100):
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute(
            "select user_code from device_codes where host_name = ? order by expires_at desc limit 1",
            ("cli-login-smoke",),
        ).fetchone()
    except sqlite3.OperationalError:
        row = None
    finally:
        conn.close()
    if row:
        print(row[0])
        raise SystemExit(0)
    time.sleep(0.1)
raise SystemExit("spawnd login did not create a pending device code")
PY
)"

printf '%s\n' "smoke-local-login: approving device code"
python3 - "$base_url" "$user_token" "$user_code" <<'PY'
import json
import sys
import urllib.error
import urllib.request

base_url, token, user_code = sys.argv[1:]
req = urllib.request.Request(
    base_url + "/api/auth/device/approve",
    data=json.dumps({"user_code": user_code}).encode(),
    method="POST",
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
)
try:
    with urllib.request.urlopen(req, timeout=10) as response:
        body = json.loads(response.read().decode())
except urllib.error.HTTPError as error:
    raise SystemExit(f"approve failed: {error.code} {error.read().decode()}") from error
if body.get("host_name") != "cli-login-smoke":
    raise SystemExit(f"unexpected approve response: {body!r}")
PY

(
  sleep 35
  if [[ -n "$login_pid" ]]; then
    kill "$login_pid" >/dev/null 2>&1 || true
  fi
) &
watchdog_pid=$!
if ! wait "$login_pid"; then
  login_pid=""
  exit 1
fi
login_pid=""
kill "$watchdog_pid" >/dev/null 2>&1 || true
wait "$watchdog_pid" 2>/dev/null || true
watchdog_pid=""

grep -F "enter code:" "$login_out" >/dev/null
grep -F "logged in. host_id =" "$login_out" >/dev/null

printf '%s\n' "smoke-local-login: verifying stored credentials and host"
HOME="$home" \
  SPAWN_DISABLE_KEYRING=1 \
  daemon/target/debug/spawnd --server "$base_url" status \
  >"$status_out" 2>"$status_err"
grep -F "logged in:  yes" "$status_out" >/dev/null
grep -F "configured: $base_url/" "$status_out" >/dev/null

python3 - "$home" "$base_url" "$user_token" <<'PY'
import json
import os
import stat
import sys
import urllib.error
import urllib.request
from pathlib import Path

home, base_url, token = sys.argv[1:]
candidates = [
    Path(home) / ".config" / "spawn" / "credentials.json",
    Path(home) / "Library" / "Application Support" / "spawn" / "credentials.json",
]
path = next((candidate for candidate in candidates if candidate.is_file()), None)
if path is None:
    raise SystemExit(f"credentials file missing; checked {candidates!r}")
creds = json.loads(path.read_text(encoding="utf-8"))
if not creds.get("access_token") or not creds.get("host_id"):
    raise SystemExit(f"credentials are incomplete: {creds!r}")
if creds.get("server_url") != base_url + "/":
    raise SystemExit(f"unexpected stored server URL: {creds!r}")
if os.name == "posix":
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode != 0o600:
        raise SystemExit(f"credentials mode is {mode:o}, expected 600")

req = urllib.request.Request(
    base_url + "/api/hosts",
    headers={"Authorization": f"Bearer {token}"},
)
try:
    with urllib.request.urlopen(req, timeout=10) as response:
        hosts = json.loads(response.read().decode())
except urllib.error.HTTPError as error:
    raise SystemExit(f"hosts failed: {error.code} {error.read().decode()}") from error

matches = [host for host in hosts if host["id"] == creds["host_id"]]
if len(matches) != 1:
    raise SystemExit(f"host {creds['host_id']} not visible in {hosts!r}")
host = matches[0]
if host["name"] != "cli-login-smoke" or host["status"] != "offline":
    raise SystemExit(f"unexpected host row: {host!r}")
PY

printf '%s\n' "smoke-local-login: passed"
