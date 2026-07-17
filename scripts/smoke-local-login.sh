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
    for log in "${server_log:-}" "${login_out:-}" "${login_err:-}" "${login_out_2:-}" "${login_err_2:-}" "${status_out:-}" "${status_err:-}"; do
      if [[ -n "$log" && -f "$log" ]]; then
        printf '%s\n' "---- $(basename "$log") ----" >&2
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
config_dir="$home/spawn-login-config"
server_log="$tmp_dir/server.log"
login_out="$tmp_dir/login.out"
login_err="$tmp_dir/login.err"
login_out_2="$tmp_dir/login-2.out"
login_err_2="$tmp_dir/login-2.err"
status_out="$tmp_dir/status.out"
status_err="$tmp_dir/status.err"
approved_browser="$tmp_dir/approved-browser.json"
approved_browser_2="$tmp_dir/approved-browser-2.json"
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
env \
  -u SPAWN_ACCESS_TOKEN \
  -u SPAWN_DAEMON_TOKEN \
  -u SPAWN_HOST_ID \
  -u SPAWN_SERVER_URL \
  -u SPAWN_DISABLE_KEYRING \
  -u XDG_CONFIG_HOME \
  HOME="$home" \
  SPAWN_CONFIG_DIR="$config_dir" \
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
            "select user_code from device_codes where host_name = ? "
            "and host_possession_version = 1 and host_possession_verified_at is not null "
            "order by expires_at desc limit 1",
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
raise SystemExit("spawnd login did not prove its pending device code")
PY
)"

approve_device_code() {
  local code="$1"
  local browser_output="$2"
  (
  cd server
  uv run python - "$base_url" "$user_token" "$code" "$browser_output" <<'PY'
import base64
import json
import sys
import urllib.error
import urllib.request

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from spawn_server.browser_registration import encode_browser_registration_transcript
from spawn_server.host_identity import decode_ed25519_public_key
from spawn_server.host_pair_approval import (
    decode_approval_nonce,
    encode_host_pair_approval_transcript,
)

base_url, token, user_code, approved_browser_path = sys.argv[1:]
headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def post(path: str, payload: dict) -> dict:
    req = urllib.request.Request(
        base_url + path,
        data=json.dumps(payload).encode(),
        method="POST",
        headers=headers,
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as error:
        raise SystemExit(f"{path} failed: {error.code} {error.read().decode()}") from error


def wire(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


me_req = urllib.request.Request(base_url + "/api/me", headers=headers)
with urllib.request.urlopen(me_req, timeout=10) as response:
    user_id = json.loads(response.read().decode())["user"]["id"]

browser_key = Ed25519PrivateKey.generate()
browser_public = browser_key.public_key().public_bytes_raw()
browser = post(
    "/api/browser-devices/register",
    {
        "key_algorithm": "ed25519",
        "public_key": wire(browser_public),
        "signature": wire(
            browser_key.sign(encode_browser_registration_transcript(user_id, browser_public))
        ),
    },
)
reviewed = post("/api/auth/device/pending", {"user_code": user_code})
if reviewed.get("host_name") != "cli-login-smoke":
    raise SystemExit(f"unexpected pending response: {reviewed!r}")
host_public = decode_ed25519_public_key(reviewed["host_public_key"])
approval_transcript = encode_host_pair_approval_transcript(
    user_id,
    decode_approval_nonce(reviewed["approval_nonce"]),
    host_public,
    browser_public,
)
approval = {
    "user_code": user_code,
    "approval_nonce": reviewed["approval_nonce"],
    "host_key_algorithm": reviewed["host_key_algorithm"],
    "host_public_key": reviewed["host_public_key"],
    "host_key_fingerprint": reviewed["host_key_fingerprint"],
    "browser_device_id": browser["id"],
    "browser_key_algorithm": browser["key_algorithm"],
    "browser_public_key": browser["public_key"],
    "browser_key_fingerprint": browser["fingerprint"],
    "signature": wire(browser_key.sign(approval_transcript)),
}
body = post("/api/auth/device/approve", approval)
if body.get("host_name") != "cli-login-smoke":
    raise SystemExit(f"unexpected approve response: {body!r}")
if any(body.get(field) != approval[field] for field in approval if field != "user_code" and field != "signature"):
    raise SystemExit(f"approval response changed reviewed identity: {body!r}")
with open(approved_browser_path, "w", encoding="utf-8") as approved_browser_file:
    json.dump(
        {
            "browser_device_id": browser["id"],
            "browser_key_algorithm": browser["key_algorithm"],
            "browser_public_key": browser["public_key"],
            "browser_key_fingerprint": browser["fingerprint"],
        },
        approved_browser_file,
        sort_keys=True,
    )
PY
  )
}

printf '%s\n' "smoke-local-login: approving first device code"
approve_device_code "$user_code" "$approved_browser"

wait_for_login() {
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
}

wait_for_login

grep -F "enter code:" "$login_out" >/dev/null
grep -F "logged in. host_id =" "$login_out" >/dev/null

printf '%s\n' "smoke-local-login: re-running login in the same scoped keyring namespace"
env \
  -u SPAWN_ACCESS_TOKEN \
  -u SPAWN_DAEMON_TOKEN \
  -u SPAWN_HOST_ID \
  -u SPAWN_SERVER_URL \
  -u SPAWN_DISABLE_KEYRING \
  -u XDG_CONFIG_HOME \
  HOME="$home" \
  SPAWN_CONFIG_DIR="$config_dir" \
  daemon/target/debug/spawnd --server "$base_url" login --host-name cli-login-smoke --no-run \
  >"$login_out_2" 2>"$login_err_2" &
login_pid=$!

user_code_2="$(
  python3 - "$db_path" "$user_code" <<'PY'
import sqlite3
import sys
import time

db_path, first_code = sys.argv[1:]
for _ in range(100):
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute(
            "select user_code from device_codes where host_name = ? and user_code != ? "
            "order by expires_at desc limit 1",
            ("cli-login-smoke", first_code),
        ).fetchone()
    except sqlite3.OperationalError:
        row = None
    finally:
        conn.close()
    if row:
        print(row[0])
        raise SystemExit(0)
    time.sleep(0.1)
raise SystemExit("second spawnd login did not create a fresh device code")
PY
)"

printf '%s\n' "smoke-local-login: approving second device code"
approve_device_code "$user_code_2" "$approved_browser_2"
wait_for_login
grep -F "enter code:" "$login_out_2" >/dev/null
grep -F "logged in. host_id =" "$login_out_2" >/dev/null

printf '%s\n' "smoke-local-login: verifying stored credentials and host"
env \
  -u SPAWN_ACCESS_TOKEN \
  -u SPAWN_DAEMON_TOKEN \
  -u SPAWN_HOST_ID \
  -u SPAWN_SERVER_URL \
  -u SPAWN_DISABLE_KEYRING \
  -u XDG_CONFIG_HOME \
  HOME="$home" \
  SPAWN_CONFIG_DIR="$config_dir" \
  daemon/target/debug/spawnd --server "$base_url" status \
  >"$status_out" 2>"$status_err"
grep -F "logged in:  yes" "$status_out" >/dev/null
grep -F "configured: $base_url/" "$status_out" >/dev/null

python3 - "$config_dir" "$base_url" "$user_token" "$approved_browser" "$approved_browser_2" \
  "$login_out" "$login_err" "$login_out_2" "$login_err_2" "$status_out" "$status_err" <<'PY'
import json
import os
import stat
import sys
import urllib.error
import urllib.request
from pathlib import Path

(
    config_dir,
    base_url,
    token,
    approved_browser_path,
    approved_browser_path_2,
    *output_paths,
) = sys.argv[1:]
path = Path(config_dir) / "credentials.json"
if not path.is_file():
    raise SystemExit("credentials file missing from isolated smoke config directory")
creds = json.loads(path.read_text(encoding="utf-8"))
missing = [field for field in ("access_token", "host_id") if not creds.get(field)]
if missing:
    raise SystemExit(f"credentials are missing required fields: {', '.join(missing)}")
if creds.get("server_url") != base_url + "/":
    raise SystemExit("stored server URL does not match the expected smoke-test origin")
sensitive_values = [creds.get("access_token"), creds.get("host_private_key_seed")]
combined_output = "".join(Path(output).read_text(encoding="utf-8") for output in output_paths)
if any(value and value in combined_output for value in sensitive_values):
    raise SystemExit("daemon login/status output exposed a stored credential secret")
approved_browsers = sorted(
    [
        json.loads(Path(approved_browser_path).read_text(encoding="utf-8")),
        json.loads(Path(approved_browser_path_2).read_text(encoding="utf-8")),
    ],
    key=lambda pin: pin["browser_device_id"],
)
if creds.get("browser_pins") != approved_browsers:
    raise SystemExit(
        "daemon did not preserve both exact approving browser tuples across re-login: "
        f"expected {approved_browsers!r}, got {creds.get('browser_pins')!r}"
    )
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
