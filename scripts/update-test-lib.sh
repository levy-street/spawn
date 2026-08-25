#!/usr/bin/env bash
set -euo pipefail

# Shared localhost-only fixture for the updater E2E, fault, probation, skew,
# and chaos scripts. Executing this file directly is supported only for its
# guard self-test.

UPDATE_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export NO_COLOR=1
unset FORCE_COLOR CLICOLOR CLICOLOR_FORCE 2>/dev/null || true

# shellcheck source=release-lib.sh
source "$UPDATE_REPO_ROOT/scripts/release-lib.sh"

update_test_log() {
  printf 'update-test: %s\n' "$*"
}

update_test_die() {
  printf 'update-test: %s\n' "$*" >&2
  return 1
}

update_test_need() {
  command -v "$1" >/dev/null 2>&1 || update_test_die "missing required command: $1"
}

update_test_is_local_url() {
  python3 - "$1" <<'PY'
import ipaddress
import sys
import urllib.parse

url = urllib.parse.urlparse(sys.argv[1])
if url.scheme not in {"http", "ws"} or not url.hostname:
    raise SystemExit(1)
try:
    local = ipaddress.ip_address(url.hostname).is_loopback
except ValueError:
    local = url.hostname == "localhost"
raise SystemExit(0 if local else 1)
PY
}

update_test_require_local_url() {
  update_test_is_local_url "$1" \
    || update_test_die "refusing non-local test origin: $1"
}

update_test_free_port() {
  python3 - <<'PY'
import socket

with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    print(listener.getsockname()[1])
PY
}

update_test_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

update_test_wait_file() {
  local path="$1"
  local timeout_seconds="${2:-30}"
  local deadline=$((SECONDS + timeout_seconds))
  while ((SECONDS < deadline)); do
    [[ -e "$path" ]] && return 0
    sleep 0.05
  done
  update_test_die "timed out waiting for $path"
}

update_test_init() {
  local label="$1"
  update_test_need awk
  update_test_need cargo
  update_test_need curl
  update_test_need git
  update_test_need mktemp
  update_test_need python3

  UPDATE_TREE_A="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  UPDATE_TREE_B="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  UPDATE_COUNTER_A=1000
  UPDATE_COUNTER_B=2000
  UPDATE_TARGET=""
  case "$(uname -s):$(uname -m)" in
    Darwin:arm64) UPDATE_TARGET="darwin-aarch64" ;;
    Darwin:x86_64) UPDATE_TARGET="darwin-x86_64" ;;
    Linux:aarch64) UPDATE_TARGET="linux-aarch64" ;;
    Linux:x86_64) UPDATE_TARGET="linux-x86_64" ;;
    *) update_test_die "unsupported local build target: $(uname -s)/$(uname -m)" ;;
  esac

  local scratch_root="${SPAWN_UPDATE_TMP_ROOT:-/private/tmp}"
  [[ -d "$scratch_root" ]] || update_test_die "scratch root does not exist: $scratch_root"
  UPDATE_SCRATCH="$(mktemp -d "$scratch_root/spawn-${label}.XXXXXX")"
  UPDATE_ARTIFACTS="$UPDATE_SCRATCH/artifacts"
  UPDATE_PREBUILT="$UPDATE_SCRATCH/prebuilt"
  UPDATE_KEY_FILE="$UPDATE_SCRATCH/release-signing.key"
  UPDATE_CARGO_ROOT="${SPAWN_TEST_CARGO_TARGET_DIR:-/private/tmp/spawn-t2-cargo}"
  case "$UPDATE_CARGO_ROOT" in
    /|"$UPDATE_REPO_ROOT"|"$UPDATE_REPO_ROOT"/)
      update_test_die "unsafe SPAWN_TEST_CARGO_TARGET_DIR: $UPDATE_CARGO_ROOT" ;;
  esac
  mkdir -p "$UPDATE_ARTIFACTS/old" "$UPDATE_ARTIFACTS/new" \
    "$UPDATE_PREBUILT/$UPDATE_TARGET" "$UPDATE_CARGO_ROOT/old" "$UPDATE_CARGO_ROOT/new"

  "$UPDATE_REPO_ROOT/server/.venv/bin/python" - "$UPDATE_KEY_FILE" <<'PY'
import base64
import os
import sys
from pathlib import Path

path = Path(sys.argv[1])
path.write_text(base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("=") + "\n")
path.chmod(0o600)
PY
  UPDATE_PUBLIC_KEY="$(release_signing_public_key "$UPDATE_KEY_FILE")"
  UPDATE_KEY_ID="$(release_signing_key_id "$UPDATE_PUBLIC_KEY")"
  UPDATE_COMMIT="$(git -C "$UPDATE_REPO_ROOT" rev-parse HEAD)"

  UPDATE_SERVER_PID=""
  UPDATE_DAEMON_PID=""
  UPDATE_DAEMON_CHILD_PID_FILE=""
  UPDATE_PROXY_PID=""
  UPDATE_WEB_PID=""
  UPDATE_BROWSER_PID=""
  UPDATE_FIXTURE=""
  UPDATE_SERVER_ROOT="$UPDATE_REPO_ROOT"
  UPDATE_HTTP_STATUS=""
  UPDATE_HTTP_BODY=""
}

update_test_build_pair() {
  local name="$1"
  local tree="$2"
  local counter="$3"
  local cargo_dir="$UPDATE_CARGO_ROOT/$name"
  local started=$SECONDS
  update_test_log "building $name daemon identity tree=$tree counter=$counter"
  env \
    CARGO_TARGET_DIR="$cargo_dir" \
    SPAWND_DAEMON_TREE_OVERRIDE="$tree" \
    SPAWND_BUILD_COUNTER_OVERRIDE="$counter" \
    SPAWND_RELEASE_PUBLIC_KEYS_OVERRIDE="$UPDATE_PUBLIC_KEY" \
    cargo build --manifest-path "$UPDATE_REPO_ROOT/daemon/Cargo.toml" --locked \
      --bin spawnd --bin spawn-worker >/dev/null
  cp "$cargo_dir/debug/spawnd" "$UPDATE_ARTIFACTS/$name/spawnd"
  cp "$cargo_dir/debug/spawn-worker" "$UPDATE_ARTIFACTS/$name/spawn-worker"
  chmod 755 "$UPDATE_ARTIFACTS/$name/spawnd" "$UPDATE_ARTIFACTS/$name/spawn-worker"
  update_test_log "built $name identity in $((SECONDS - started))s"
}

update_test_build_identities() {
  update_test_build_pair old "$UPDATE_TREE_A" "$UPDATE_COUNTER_A"
  update_test_build_pair new "$UPDATE_TREE_B" "$UPDATE_COUNTER_B"
  UPDATE_VERSION="$("$UPDATE_ARTIFACTS/new/spawnd" --version | awk 'NR == 1 {print $2}')"
  [[ "$UPDATE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+\+g[0-9a-f]{12}$ ]] \
    || update_test_die "unexpected new daemon version: $UPDATE_VERSION"
  [[ "${UPDATE_VERSION##*+g}" == "${UPDATE_COMMIT:0:12}" ]] \
    || update_test_die "HEAD moved while updater identities were building"
  [[ "$("$UPDATE_ARTIFACTS/old/spawn-worker" --version)" == *"tree=$UPDATE_TREE_A" ]] \
    || update_test_die "old worker identity was not stamped"
  [[ "$("$UPDATE_ARTIFACTS/new/spawn-worker" --version)" == *"tree=$UPDATE_TREE_B" ]] \
    || update_test_die "new worker identity was not stamped"
}

update_test_write_manifest() {
  local tree="$1"
  local counter="$2"
  local daemon_source="${3:-$UPDATE_ARTIFACTS/new/spawnd}"
  local worker_source="${4:-$UPDATE_ARTIFACTS/new/spawn-worker}"
  local target_dir="$UPDATE_PREBUILT/$UPDATE_TARGET"
  local daemon_sha worker_sha
  mkdir -p "$target_dir"
  cp "$daemon_source" "$target_dir/spawnd"
  cp "$worker_source" "$target_dir/spawn-worker"
  chmod 755 "$target_dir/spawnd" "$target_dir/spawn-worker"
  daemon_sha="$(update_test_sha256 "$target_dir/spawnd")"
  worker_sha="$(update_test_sha256 "$target_dir/spawn-worker")"
  render_prebuilt_manifest \
    "$UPDATE_COMMIT" "$tree" "$UPDATE_VERSION" "$counter" "$UPDATE_KEY_ID" \
    "$UPDATE_TARGET:$daemon_sha:$worker_sha" >"$UPDATE_PREBUILT/manifest.json"
  sign_prebuilt_manifest \
    "$UPDATE_PREBUILT/manifest.json" "$UPDATE_PREBUILT/manifest.json.sig" "$UPDATE_KEY_FILE"
  verify_prebuilt_manifest_signature \
    "$UPDATE_PREBUILT/manifest.json" "$UPDATE_PREBUILT/manifest.json.sig" "$UPDATE_PUBLIC_KEY"
}

update_test_new_fixture() {
  local label="$1"
  [[ -z "$UPDATE_SERVER_PID$UPDATE_DAEMON_PID$UPDATE_PROXY_PID$UPDATE_WEB_PID$UPDATE_BROWSER_PID" ]] \
    || update_test_die "cannot replace a live updater fixture"
  UPDATE_FIXTURE="$UPDATE_SCRATCH/$label"
  UPDATE_DB_URL="sqlite+aiosqlite:///$UPDATE_FIXTURE/spawn.db"
  UPDATE_SERVER_PORT="$(update_test_free_port)"
  UPDATE_SERVER_URL="http://127.0.0.1:$UPDATE_SERVER_PORT"
  UPDATE_DAEMON_URL="$UPDATE_SERVER_URL"
  UPDATE_SERVER_LOG="$UPDATE_FIXTURE/server.log"
  UPDATE_DAEMON_LOG="$UPDATE_FIXTURE/daemon.log"
  UPDATE_PROXY_LOG="$UPDATE_FIXTURE/proxy.log"
  UPDATE_BROWSER_LOG="$UPDATE_FIXTURE/browser.log"
  UPDATE_WEB_LOG="$UPDATE_FIXTURE/web.log"
  UPDATE_DAEMON_HOME="$UPDATE_FIXTURE/daemon-home"
  UPDATE_BIN_DIR="$UPDATE_FIXTURE/bin"
  # macOS limits Unix-domain socket paths to 103 bytes. Session IDs consume
  # most of that budget, so keep worker state in a deliberately short path.
  UPDATE_WORKER_DIR="$(mktemp -d /private/tmp/su.XXXXXX)"
  UPDATE_SESSION_CWD="$UPDATE_FIXTURE/session-cwd"
  UPDATE_SHELL="$UPDATE_FIXTURE/update-shell"
  UPDATE_TOKEN=""
  UPDATE_HOST_ID=""
  UPDATE_ACCOUNT_ID=""
  UPDATE_ANCHOR_DEVICE_ID=""
  UPDATE_ANCHOR_PUBLIC_KEY=""
  UPDATE_ANCHOR_SEED=""
  UPDATE_SESSION_ID=""
  UPDATE_WORKSPACE_ID=""
  mkdir -p "$UPDATE_DAEMON_HOME" "$UPDATE_BIN_DIR" "$UPDATE_SESSION_CWD"
  cp "$UPDATE_ARTIFACTS/old/spawnd" "$UPDATE_BIN_DIR/spawnd"
  cp "$UPDATE_ARTIFACTS/old/spawn-worker" "$UPDATE_BIN_DIR/spawn-worker"
  chmod 755 "$UPDATE_BIN_DIR/spawnd" "$UPDATE_BIN_DIR/spawn-worker"
  cat >"$UPDATE_SHELL" <<'SH'
#!/usr/bin/env sh
set -u
printf '%s\n' 'update-shell-ready' > .update-shell-ready
printf '%s\n' 'update-shell-ready'
while IFS= read -r line; do
  printf 'update-shell:%s\n' "$line"
done
SH
  chmod 755 "$UPDATE_SHELL"
}

update_test_prepare_database() {
  (
    cd "$UPDATE_SERVER_ROOT/server"
    env \
      SPAWN_DATABASE_URL="$UPDATE_DB_URL" \
      SPAWN_USE_INPROCESS_PUBSUB=1 \
      SPAWN_JWT_SECRET=update-test-secret-with-enough-length \
      SPAWN_PUBLIC_URL="$UPDATE_SERVER_URL" \
      "$UPDATE_REPO_ROOT/server/.venv/bin/python" - <<'PY'
import asyncio

import spawn_server.models  # noqa: F401
from spawn_server.db import Base, dispose_engine, get_engine, init_engine


async def main() -> None:
    init_engine()
    engine = get_engine()
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    await dispose_engine()


asyncio.run(main())
PY
  )
}

update_test_start_server() {
  local auto_update="$1"
  [[ -z "$UPDATE_SERVER_PID" ]] || update_test_die "server is already running"
  update_test_require_local_url "$UPDATE_SERVER_URL"
  (
    cd "$UPDATE_SERVER_ROOT/server"
    exec env \
      SPAWN_DATABASE_URL="$UPDATE_DB_URL" \
      SPAWN_USE_INPROCESS_PUBSUB=1 \
      SPAWN_JWT_SECRET=update-test-secret-with-enough-length \
      SPAWN_PUBLIC_URL="$UPDATE_SERVER_URL" \
      SPAWN_PREBUILT_DIR="$UPDATE_PREBUILT" \
      SPAWN_DAEMON_AUTO_UPDATE="$auto_update" \
      "$UPDATE_REPO_ROOT/server/.venv/bin/python" -m uvicorn \
        spawn_server.main:app --host 127.0.0.1 --port "$UPDATE_SERVER_PORT"
  ) >>"$UPDATE_SERVER_LOG" 2>&1 &
  UPDATE_SERVER_PID=$!
  local deadline=$((SECONDS + 30))
  while ((SECONDS < deadline)); do
    if curl -fsS --max-time 1 "$UPDATE_SERVER_URL/healthz" >/dev/null 2>&1; then
      return 0
    fi
    kill -0 "$UPDATE_SERVER_PID" 2>/dev/null \
      || update_test_die "server exited during startup; see $UPDATE_SERVER_LOG"
    sleep 0.1
  done
  update_test_die "server did not become ready; see $UPDATE_SERVER_LOG"
}

update_test_stop_process() {
  local label="$1"
  local variable="$2"
  local signal_name="${3:-TERM}"
  local pid="${!variable:-}"
  [[ -n "$pid" ]] || return 0
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || update_test_die "unsafe $label pid: $pid"
  kill -"$signal_name" "$pid" >/dev/null 2>&1 || true
  for _ in {1..100}; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.05
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" >/dev/null 2>&1 || true
  fi
  wait "$pid" 2>/dev/null || true
  printf -v "$variable" '%s' ""
}

update_test_stop_server() {
  update_test_stop_process server UPDATE_SERVER_PID "${1:-TERM}"
}

update_test_start_proxy() {
  local match_path="$1"
  shift
  local proxy_port
  proxy_port="$(update_test_free_port)"
  UPDATE_PROXY_URL="http://127.0.0.1:$proxy_port"
  update_test_require_local_url "$UPDATE_PROXY_URL"
  "$UPDATE_REPO_ROOT/scripts/fault-proxy.py" \
    --listen "127.0.0.1:$proxy_port" \
    --upstream "127.0.0.1:$UPDATE_SERVER_PORT" \
    --match-path "$match_path" "$@" >"$UPDATE_PROXY_LOG" 2>&1 &
  UPDATE_PROXY_PID=$!
  update_test_wait_file "$UPDATE_PROXY_LOG" 10
  local deadline=$((SECONDS + 10))
  while ((SECONDS < deadline)); do
    grep -q 'fault-proxy: listening' "$UPDATE_PROXY_LOG" && {
      UPDATE_DAEMON_URL="$UPDATE_PROXY_URL"
      return 0
    }
    kill -0 "$UPDATE_PROXY_PID" 2>/dev/null \
      || update_test_die "fault proxy exited during startup; see $UPDATE_PROXY_LOG"
    sleep 0.05
  done
  update_test_die "fault proxy did not become ready; see $UPDATE_PROXY_LOG"
}

update_test_stop_proxy() {
  update_test_stop_process proxy UPDATE_PROXY_PID
}

update_test_start_web() {
  [[ -z "$UPDATE_WEB_PID" ]] || update_test_die "web server is already running"
  local web_port
  web_port="$(update_test_free_port)"
  UPDATE_WEB_URL="http://127.0.0.1:$web_port"
  update_test_require_local_url "$UPDATE_WEB_URL"
  (
    cd "$UPDATE_REPO_ROOT/web"
    exec env \
      SPAWN_API_PROXY_TARGET="$UPDATE_SERVER_URL" \
      NEXT_PUBLIC_SPAWN_WS_URL="ws://127.0.0.1:$UPDATE_SERVER_PORT" \
      "$UPDATE_REPO_ROOT/web/node_modules/.bin/next" dev \
        -H 127.0.0.1 -p "$web_port"
  ) >>"$UPDATE_WEB_LOG" 2>&1 &
  UPDATE_WEB_PID=$!
  local deadline=$((SECONDS + 120))
  while ((SECONDS < deadline)); do
    if curl -fsS --max-time 2 "$UPDATE_WEB_URL/login" >/dev/null 2>&1; then
      return 0
    fi
    kill -0 "$UPDATE_WEB_PID" 2>/dev/null \
      || update_test_die "web server exited during startup; see $UPDATE_WEB_LOG"
    sleep 0.25
  done
  update_test_die "web server did not become ready; see $UPDATE_WEB_LOG"
}

update_test_stop_web() {
  update_test_stop_process web UPDATE_WEB_PID
}

update_test_mint_credentials() {
  local daemon_origin="${1:-$UPDATE_DAEMON_URL}"
  local email_label
  update_test_require_local_url "$daemon_origin"
  email_label="$(basename "$UPDATE_FIXTURE" | tr -cd 'a-zA-Z0-9')"
  local result
  result="$({
    cd "$UPDATE_REPO_ROOT/server"
    env \
      SPAWN_DATABASE_URL="$UPDATE_DB_URL" \
      SPAWN_JWT_SECRET=update-test-secret-with-enough-length \
      SPAWN_PUBLIC_URL="$UPDATE_SERVER_URL" \
      "$UPDATE_REPO_ROOT/server/.venv/bin/python" - \
      "$UPDATE_SERVER_URL" "$daemon_origin" "$UPDATE_DAEMON_HOME" "$email_label" <<'PY'
import asyncio
import base64
import json
import os
import sys
import urllib.error
import urllib.request
import uuid
from datetime import UTC, datetime

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from spawn_server import auth
from spawn_server.browser_registration import encode_browser_registration_transcript
from spawn_server.db import dispose_engine, get_sessionmaker, init_engine
from spawn_server.host_identity import decode_ed25519_public_key, ed25519_key_fingerprint
from spawn_server.host_pair_approval import (
    decode_approval_nonce,
    encode_host_pair_approval_transcript,
)
from spawn_server.host_pair_possession import (
    decode_device_code,
    encode_host_pair_possession_transcript,
)
from spawn_server.models import User

api_origin, daemon_origin, daemon_home, label = sys.argv[1:]


def request(method: str, path: str, payload: dict | None = None, token: str | None = None) -> dict:
    data = None if payload is None else json.dumps(payload).encode()
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(api_origin + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return json.loads(response.read().decode() or "{}")
    except urllib.error.HTTPError as error:
        raise SystemExit(
            f"{method} {path} failed: {error.code} {error.read().decode()}"
        ) from error


email = f"update-{label}@example.com"


async def create_fixture_user() -> tuple[str, str]:
    init_engine()
    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        user = User(
            email=email,
            password_hash=auth.hash_password("passpasspass"),
            is_admin=True,
            email_verified_at=datetime.now(UTC),
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)
        token = auth.issue_access_token(user.id, user.session_epoch)
        user_id = user.id
    await dispose_engine()
    return token, user_id


token, user_id = asyncio.run(create_fixture_user())
seed = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
public = bytes.fromhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
host_public_key = base64.urlsafe_b64encode(public).rstrip(b"=").decode()
host_binding = {"host_key_algorithm": "ed25519", "host_public_key": host_public_key}
started = request(
    "POST",
    "/api/auth/device/start",
    {
        "host_name": f"update-{label}",
        "os": sys.platform,
        "arch": "smoke",
        "version": "smoke",
        **host_binding,
    },
)
host_key = Ed25519PrivateKey.from_private_bytes(seed)
possession_transcript = encode_host_pair_possession_transcript(
    decode_device_code(started["device_code"]),
    decode_approval_nonce(started["approval_nonce"]),
    public,
)
possession = request(
    "POST",
    "/api/auth/device/possession",
    {
        "device_code": started["device_code"],
        "approval_nonce": started["approval_nonce"],
        **host_binding,
        "signature": base64.urlsafe_b64encode(host_key.sign(possession_transcript))
        .rstrip(b"=")
        .decode(),
    },
)
if possession.get("verified") is not True or possession.get("version") != 1:
    raise SystemExit(f"unexpected possession response: {possession!r}")
reviewed = request(
    "POST", "/api/auth/device/pending", {"user_code": started["user_code"]}, token
)
browser_key = Ed25519PrivateKey.generate()
browser_public = browser_key.public_key().public_bytes_raw()
browser_public_key = base64.urlsafe_b64encode(browser_public).rstrip(b"=").decode()
registration = encode_browser_registration_transcript(user_id, browser_public, is_root=False)
browser = request(
    "POST",
    "/api/browser-devices/register",
    {
        "key_algorithm": "ed25519",
        "public_key": browser_public_key,
        "signature": base64.urlsafe_b64encode(browser_key.sign(registration))
        .rstrip(b"=")
        .decode(),
    },
    token,
)
approval_transcript = encode_host_pair_approval_transcript(
    user_id,
    decode_approval_nonce(reviewed["approval_nonce"]),
    decode_ed25519_public_key(reviewed["host_public_key"]),
    browser_public,
)
approval = {
    "user_code": started["user_code"],
    "approval_nonce": reviewed["approval_nonce"],
    "host_key_algorithm": reviewed["host_key_algorithm"],
    "host_public_key": reviewed["host_public_key"],
    "host_key_fingerprint": reviewed["host_key_fingerprint"],
    "browser_device_id": browser["id"],
    "browser_key_algorithm": browser["key_algorithm"],
    "browser_public_key": browser["public_key"],
    "browser_key_fingerprint": ed25519_key_fingerprint(browser["public_key"]),
    "signature": base64.urlsafe_b64encode(browser_key.sign(approval_transcript))
    .rstrip(b"=")
    .decode(),
}
request("POST", "/api/auth/device/approve", approval, token)
polled = request(
    "POST",
    "/api/auth/device/poll",
    {"device_code": started["device_code"], **host_binding},
)
credentials = {
    "credential_record_version": 1,
    "credential_generation": 1,
    "credential_record_id": str(uuid.uuid4()),
    "access_token": polled["access_token"],
    "host_id": polled["host_id"],
    "server_url": daemon_origin,
    "host_private_key_seed": base64.urlsafe_b64encode(seed).rstrip(b"=").decode(),
    "browser_pins": [
        {
            "browser_device_id": polled["browser_device_id"],
            "browser_key_algorithm": polled["browser_key_algorithm"],
            "browser_public_key": polled["browser_public_key"],
            "browser_key_fingerprint": polled["browser_key_fingerprint"],
        }
    ],
}
for config_dir in (
    os.path.join(daemon_home, ".config", "spawn"),
    os.path.join(daemon_home, "Library", "Application Support", "spawn"),
):
    os.makedirs(config_dir, exist_ok=True)
    os.chmod(config_dir, 0o700)
    path = os.path.join(config_dir, "credentials.json")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(credentials, handle)
    os.chmod(path, 0o600)

print(
    json.dumps(
        {
            "token": token,
            "host_id": polled["host_id"],
            "account_id": user_id,
            "anchor_device_id": browser["id"],
            "anchor_public_key": browser["public_key"],
            "anchor_seed": base64.urlsafe_b64encode(browser_key.private_bytes_raw())
            .rstrip(b"=")
            .decode(),
        }
    )
)
PY
  })"
  UPDATE_TOKEN="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])' <<<"$result")"
  UPDATE_HOST_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["host_id"])' <<<"$result")"
  UPDATE_ACCOUNT_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["account_id"])' <<<"$result")"
  UPDATE_ANCHOR_DEVICE_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["anchor_device_id"])' <<<"$result")"
  UPDATE_ANCHOR_PUBLIC_KEY="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["anchor_public_key"])' <<<"$result")"
  UPDATE_ANCHOR_SEED="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["anchor_seed"])' <<<"$result")"
}

update_test_exec_daemon_env() {
  exec env \
    -u SPAWN_ACCESS_TOKEN \
    -u SPAWN_DAEMON_TOKEN \
    -u SPAWN_HOST_ID \
    -u SPAWN_SERVER_URL \
    -u XDG_CONFIG_HOME \
    HOME="$UPDATE_DAEMON_HOME" \
    SPAWN_DISABLE_KEYRING=1 \
    SPAWN_CONFIG_DIR="$UPDATE_DAEMON_HOME/.config/spawn" \
    SPAWND_WORKER_DIR="$UPDATE_WORKER_DIR" \
    SPAWND_WORKER_BIN="$UPDATE_BIN_DIR/spawn-worker" \
    SHELL="$UPDATE_SHELL" \
    NO_COLOR=1 \
    "$@"
}

update_test_start_daemon() {
  local daemon_origin="${1:-$UPDATE_DAEMON_URL}"
  shift || true
  [[ -z "$UPDATE_DAEMON_PID" ]] || update_test_die "daemon is already running"
  update_test_require_local_url "$daemon_origin"
  (
    update_test_exec_daemon_env "$@" \
      "$UPDATE_BIN_DIR/spawnd" --server "$daemon_origin" run
  ) >>"$UPDATE_DAEMON_LOG" 2>&1 &
  UPDATE_DAEMON_PID=$!
}

update_test_start_supervised_daemon() {
  local daemon_origin="${1:-$UPDATE_DAEMON_URL}"
  update_test_require_local_url "$daemon_origin"
  UPDATE_DAEMON_CHILD_PID_FILE="$UPDATE_FIXTURE/daemon-child.pid"
  (
    trap 'if [[ -s "$UPDATE_DAEMON_CHILD_PID_FILE" ]]; then kill "$(<"$UPDATE_DAEMON_CHILD_PID_FILE")" >/dev/null 2>&1 || true; fi; exit 0' TERM INT
    while :; do
      (
        update_test_exec_daemon_env \
          "$UPDATE_BIN_DIR/spawnd" --server "$daemon_origin" run
      ) >>"$UPDATE_DAEMON_LOG" 2>&1 &
      child=$!
      printf '%s\n' "$child" >"$UPDATE_DAEMON_CHILD_PID_FILE"
      wait "$child" || true
      sleep 0.1
    done
  ) &
  UPDATE_DAEMON_PID=$!
}

update_test_stop_daemon() {
  if [[ -n "$UPDATE_DAEMON_CHILD_PID_FILE" && -s "$UPDATE_DAEMON_CHILD_PID_FILE" ]]; then
    local child
    child="$(<"$UPDATE_DAEMON_CHILD_PID_FILE")"
    if [[ "$child" =~ ^[1-9][0-9]*$ ]]; then
      kill -TERM "$child" >/dev/null 2>&1 || true
    fi
  fi
  update_test_stop_process daemon UPDATE_DAEMON_PID
  UPDATE_DAEMON_CHILD_PID_FILE=""
}

update_test_stop_recorded_workers() {
  [[ -n "${UPDATE_WORKER_DIR:-}" && -d "$UPDATE_WORKER_DIR" ]] || return 0
  find "$UPDATE_WORKER_DIR" -type s -print -quit | grep -q . || return 0
  [[ -n "${UPDATE_DAEMON_LOG:-}" && -f "$UPDATE_DAEMON_LOG" ]] || return 0

  local pids pid
  pids="$(sed -n 's/.*worker_pid=\([0-9][0-9]*\).*/\1/p' "$UPDATE_DAEMON_LOG" | sort -u)"
  while IFS= read -r pid; do
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || continue
    kill -TERM "$pid" >/dev/null 2>&1 || true
  done <<<"$pids"
  for _ in {1..100}; do
    find "$UPDATE_WORKER_DIR" -type s -print -quit | grep -q . || return 0
    sleep 0.05
  done
  while IFS= read -r pid; do
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || continue
    kill -KILL "$pid" >/dev/null 2>&1 || true
  done <<<"$pids"
  for _ in {1..100}; do
    local alive=0
    while IFS= read -r pid; do
      [[ "$pid" =~ ^[1-9][0-9]*$ ]] || continue
      kill -0 "$pid" >/dev/null 2>&1 && alive=1
    done <<<"$pids"
    [[ "$alive" == "0" ]] && {
      # SIGKILL cannot run the worker's unlink guard. Remove only socket nodes
      # in this fixture-owned mktemp directory after every recorded PID died.
      find "$UPDATE_WORKER_DIR" -type s -delete
      return 0
    }
    sleep 0.05
  done
  return 1
}

update_test_host_json() {
  curl -fsS --max-time 5 \
    -H "Authorization: Bearer $UPDATE_TOKEN" \
    "$UPDATE_SERVER_URL/api/hosts/$UPDATE_HOST_ID"
}

update_test_wait_host() {
  local tree="$1"
  local state="${2:-}"
  local error_contains="${3:-}"
  local timeout_seconds="${4:-60}"
  "$UPDATE_REPO_ROOT/server/.venv/bin/python" - \
    "$UPDATE_SERVER_URL" "$UPDATE_TOKEN" "$UPDATE_HOST_ID" \
    "$tree" "$state" "$error_contains" "$timeout_seconds" <<'PY'
import json
import sys
import time
import urllib.error
import urllib.request

origin, token, host_id, tree, state, error_contains, timeout_raw = sys.argv[1:]
deadline = time.monotonic() + float(timeout_raw)
last = None
while time.monotonic() < deadline:
    request = urllib.request.Request(
        f"{origin}/api/hosts/{host_id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            last = json.loads(response.read().decode())
    except (TimeoutError, urllib.error.URLError):
        time.sleep(0.1)
        continue
    update = last.get("update") or {}
    matches = last.get("daemon_tree") == tree
    if state:
        matches = matches and update.get("state") == state
    if error_contains:
        matches = matches and error_contains.lower() in str(update.get("error") or "").lower()
    if matches:
        print(json.dumps(last))
        raise SystemExit(0)
    time.sleep(0.1)
raise SystemExit(f"host state timeout; last={last!r}")
PY
}

update_test_wait_online() {
  local tree="$1"
  local timeout="${2:-60}"
  local deadline=$((SECONDS + timeout))
  local host=""
  while ((SECONDS < deadline)); do
    host="$(update_test_host_json 2>/dev/null || true)"
    if [[ -n "$host" ]] && python3 -c '
import json
import sys

host = json.load(sys.stdin)
raise SystemExit(0 if host.get("daemon_tree") == sys.argv[1] and host.get("status") == "online" else 1)
' "$tree" <<<"$host"; then
      return 0
    fi
    sleep 0.1
  done
  update_test_die "host did not become online at tree=$tree; last=$host"
}

update_test_post_update() {
  local payload="${1:-}"
  [[ -n "$payload" ]] || payload='{}'
  local response
  response="$(curl -sS --max-time 10 \
    -H "Authorization: Bearer $UPDATE_TOKEN" \
    -H 'Content-Type: application/json' \
    -X POST --data "$payload" \
    -w $'\n%{http_code}' \
    "$UPDATE_SERVER_URL/api/hosts/$UPDATE_HOST_ID/update")"
  UPDATE_HTTP_STATUS="${response##*$'\n'}"
  UPDATE_HTTP_BODY="${response%$'\n'*}"
}

update_test_create_session() {
  local response
  response="$(python3 - "$UPDATE_SERVER_URL" "$UPDATE_TOKEN" "$UPDATE_HOST_ID" "$UPDATE_SESSION_CWD" <<'PY'
import json
import sys
import urllib.request

origin, token, host_id, cwd = sys.argv[1:]
request = urllib.request.Request(
    origin + "/api/workspaces",
    data=json.dumps(
        {"name": "updater survival", "first_session": {"host_id": host_id, "cwd": cwd}}
    ).encode(),
    method="POST",
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
)
with urllib.request.urlopen(request, timeout=10) as response:
    created = json.loads(response.read().decode())
print(json.dumps({"workspace_id": created["workspace"]["id"], "session_id": created["session"]["id"]}))
PY
)"
  UPDATE_WORKSPACE_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["workspace_id"])' <<<"$response")"
  UPDATE_SESSION_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["session_id"])' <<<"$response")"
  update_test_wait_session_running "$UPDATE_SESSION_ID"
}

update_test_wait_session_running() {
  local session_id="$1"
  python3 - "$UPDATE_SERVER_URL" "$UPDATE_TOKEN" "$session_id" <<'PY'
import json
import sys
import time
import urllib.error
import urllib.request

origin, token, session_id = sys.argv[1:]
last = None
for _ in range(200):
    request = urllib.request.Request(
        f"{origin}/api/sessions/{session_id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            last = json.loads(response.read().decode())
    except (TimeoutError, urllib.error.URLError):
        time.sleep(0.1)
        continue
    if last.get("status") == "running":
        raise SystemExit(0)
    time.sleep(0.1)
raise SystemExit(f"session did not become running: {last!r}")
PY
}

update_test_delete_sessions() {
  [[ -n "${UPDATE_TOKEN:-}" && -n "${UPDATE_SERVER_URL:-}" ]] || return 0
  curl -fsS --max-time 1 "$UPDATE_SERVER_URL/healthz" >/dev/null 2>&1 || return 0
  python3 - "$UPDATE_SERVER_URL" "$UPDATE_TOKEN" <<'PY' >/dev/null 2>&1 || true
import json
import sys
import urllib.error
import urllib.request

origin, token = sys.argv[1:]
headers = {"Authorization": f"Bearer {token}"}
try:
    with urllib.request.urlopen(urllib.request.Request(origin + "/api/sessions", headers=headers), timeout=3) as response:
        sessions = json.loads(response.read().decode())
except Exception:
    raise SystemExit(0)
for session in sessions:
    session_id = session.get("id")
    if not session_id:
        continue
    try:
        urllib.request.urlopen(
            urllib.request.Request(
                f"{origin}/api/sessions/{session_id}", headers=headers, method="DELETE"
            ),
            timeout=3,
        ).close()
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
PY
}

update_test_cleanup_fixture() {
  local cleanup_status=0
  if [[ -n "${UPDATE_BROWSER_PID:-}" ]]; then
    update_test_stop_process browser UPDATE_BROWSER_PID || cleanup_status=1
  fi
  update_test_delete_sessions || cleanup_status=1
  if [[ -n "${UPDATE_BIN_DIR:-}" ]]; then
    chmod 755 "$UPDATE_BIN_DIR" 2>/dev/null || true
  fi
  update_test_stop_daemon || cleanup_status=1
  update_test_stop_recorded_workers || cleanup_status=1
  update_test_stop_proxy || cleanup_status=1
  update_test_stop_web || cleanup_status=1
  update_test_stop_server || cleanup_status=1
  if [[ -n "${UPDATE_WORKER_DIR:-}" && -d "$UPDATE_WORKER_DIR" ]]; then
    local deadline=$((SECONDS + 10))
    while ((SECONDS < deadline)) && find "$UPDATE_WORKER_DIR" -type s -print -quit | grep -q .; do
      sleep 0.1
    done
    if find "$UPDATE_WORKER_DIR" -type s -print -quit | grep -q .; then
      printf 'update-test: worker sockets survived fixture cleanup: %s\n' "$UPDATE_WORKER_DIR" >&2
      cleanup_status=1
    else
      rm -rf "$UPDATE_WORKER_DIR"
    fi
  fi
  UPDATE_WORKER_DIR=""
  UPDATE_FIXTURE=""
  return "$cleanup_status"
}

update_test_cleanup_all() {
  local status="${1:-0}"
  set +e
  update_test_cleanup_fixture
  local cleanup_status=$?
  if [[ "$status" != "0" ]]; then
    for log in "${UPDATE_SERVER_LOG:-}" "${UPDATE_DAEMON_LOG:-}" \
      "${UPDATE_PROXY_LOG:-}" "${UPDATE_WEB_LOG:-}" "${UPDATE_BROWSER_LOG:-}"; do
      if [[ -n "$log" && -f "$log" ]]; then
        printf '%s\n' "---- $log ----" >&2
        tail -160 "$log" >&2 || true
      fi
    done
  fi
  if [[ "$cleanup_status" == "0" && -n "${UPDATE_SCRATCH:-}" && -d "$UPDATE_SCRATCH" ]]; then
    # A just-exited daemon can release its credentials lock a few milliseconds
    # after wait(2). Retry the exact mktemp root so that cleanup is both quiet
    # and honest about a late file recreation race.
    local removed=0
    for _ in {1..50}; do
      rm -rf "$UPDATE_SCRATCH" 2>/dev/null || true
      if [[ ! -e "$UPDATE_SCRATCH" ]]; then
        removed=1
        break
      fi
      sleep 0.05
    done
    if [[ "$removed" == "0" ]]; then
      printf 'update-test: could not remove scratch directory: %s\n' "$UPDATE_SCRATCH" >&2
      status=1
    fi
  elif [[ -n "${UPDATE_SCRATCH:-}" && -d "$UPDATE_SCRATCH" ]]; then
    printf 'update-test: preserving %s because cleanup was incomplete\n' "$UPDATE_SCRATCH" >&2
    status=1
  fi
  return "$status"
}

update_test_lib_self_test() {
  update_test_is_local_url "http://127.0.0.1:1234"
  update_test_is_local_url "ws://localhost:1234"
  if update_test_is_local_url "https://spawnd.dev"; then
    update_test_die "production origin passed the localhost guard"
  fi
  if update_test_is_local_url "file:///tmp/socket"; then
    update_test_die "non-network URL passed the localhost guard"
  fi
  [[ "$(printf abc | python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())')" \
    == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" ]]
  printf '%s\n' "update-test-lib: self-test ok"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  if [[ "${1:-}" != "--self-test" || "$#" != "1" ]]; then
    printf '%s\n' "usage: scripts/update-test-lib.sh --self-test" >&2
    exit 2
  fi
  update_test_lib_self_test
fi
