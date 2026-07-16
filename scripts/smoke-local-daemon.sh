#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'smoke-local-daemon: missing required command: %s\n' "$1" >&2
    exit 1
  }
}

need curl
need python3

tmp_dir="$(mktemp -d)"
server_pid=""
daemon_pid=""

cleanup() {
  local status=$?
  if [[ "$status" != "0" ]]; then
    if [[ -f "${server_log:-}" ]]; then
      printf '%s\n' "---- server log ----" >&2
      tail -200 "$server_log" >&2 || true
    fi
    if [[ -f "${daemon_log:-}" ]]; then
      printf '%s\n' "---- daemon log ----" >&2
      tail -200 "$daemon_log" >&2 || true
    fi
  fi
  if [[ -n "${smoke_agent_id:-}" && -n "${smoke_token:-}" && -n "${base_url:-}" ]]; then
    curl -fsS -X DELETE \
      -H "Authorization: Bearer $smoke_token" \
      "$base_url/api/agents/$smoke_agent_id" >/dev/null 2>&1 || true
  fi
  if [[ -n "$daemon_pid" ]]; then
    kill "$daemon_pid" >/dev/null 2>&1 || true
    wait "$daemon_pid" 2>/dev/null || true
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
db_url="sqlite+aiosqlite:///$tmp_dir/spawn-smoke.db"
server_log="$tmp_dir/server.log"
daemon_log="$tmp_dir/daemon.log"
daemon_home="$tmp_dir/daemon-home"
agent_cwd="$tmp_dir/agent-cwd"
fake_bin="$tmp_dir/fake-bin"
worker_dir="$tmp_dir/workers"
mkdir -p "$daemon_home" "$agent_cwd" "$fake_bin" "$worker_dir"

cat >"$fake_bin/codex" <<'SH'
#!/usr/bin/env sh
set -eu

printf '%s\n' "fake-codex-ready"
python3 - <<'PY'
import json
import os
from pathlib import Path


def report(name: str, ok: bool) -> None:
    print(f"fake-codex-{name}:{'ok' if ok else 'bad'}", flush=True)


required = [
    "SPAWN_AGENT_CONFIG_DIR",
    "SPAWN_SKILLS_FILE",
    "SPAWN_SKILLS_DIR",
    "CODEX_HOME",
]
missing = [name for name in required if not os.environ.get(name)]
report("env", not missing)

config_dir = Path(os.environ.get("SPAWN_AGENT_CONFIG_DIR", "/missing"))
skills_file = Path(os.environ.get("SPAWN_SKILLS_FILE", "/missing"))
skills_dir = Path(os.environ.get("SPAWN_SKILLS_DIR", "/missing"))
codex_home = Path(os.environ.get("CODEX_HOME", "/missing"))

skills = json.loads(skills_file.read_text(encoding="utf-8"))
config = (codex_home / "config.toml").read_text(encoding="utf-8")

skill_names = [skill["name"] for skill in skills]

print("fake-codex-skills:" + ",".join(skill_names), flush=True)
report("config-dir", config_dir.is_dir())
report("skills-json", skill_names == ["spawn-smoke-skill"])
report("skill-file", (skills_dir / "spawn-smoke-skill" / "SKILL.md").is_file())
report("codex-config-skill", "[[skills.config]]" in config)
report("codex-config-project", 'trust_level = "trusted"' in config)
PY

while IFS= read -r line; do
  printf 'fake-codex-echo:%s\n' "$line"
done
SH
chmod 755 "$fake_bin/codex"

start_server() {
  printf '%s\n' "smoke-local-daemon: starting server on $base_url"
  (
    cd server
    SPAWN_DATABASE_URL="$db_url" \
      SPAWN_USE_INPROCESS_PUBSUB=1 \
      SPAWN_JWT_SECRET=smoke-test-secret-with-enough-length \
      SPAWN_PUBLIC_URL="$base_url" \
      SPAWN_TRANSCRIPT_DIR="$tmp_dir/transcripts" \
      uv run uvicorn spawn_server.main:app --host 127.0.0.1 --port "$port" \
        >>"$server_log" 2>&1
  ) &
  server_pid=$!

  for _ in {1..80}; do
    if curl -fsS "$base_url/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  curl -fsS "$base_url/healthz" >/dev/null
}

stop_server() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" 2>/dev/null || true
    server_pid=""
  fi
}

start_daemon() {
  printf '%s\n' "smoke-local-daemon: starting spawnd for host $smoke_host_id"
  HOME="$daemon_home" \
    SPAWN_DISABLE_KEYRING=1 \
    SPAWN_CONFIG_DIR="$daemon_home/.config/spawn" \
    SPAWND_WORKER_DIR="$worker_dir" \
    PATH="$fake_bin:$PATH" \
    daemon/target/debug/spawnd --server "$base_url" run \
    >>"$daemon_log" 2>&1 &
  daemon_pid=$!
}

stop_daemon() {
  if [[ -n "$daemon_pid" ]]; then
    kill "$daemon_pid" >/dev/null 2>&1 || true
    wait "$daemon_pid" 2>/dev/null || true
    daemon_pid=""
  fi
}

wait_host_online() {
  python3 - "$base_url" "$smoke_token" "$smoke_host_id" <<'PY'
import json
import sys
import time
import urllib.error
import urllib.request

base_url, token, host_id = sys.argv[1:]

for _ in range(100):
    req = urllib.request.Request(
        f"{base_url}/api/hosts/{host_id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            host = json.loads(response.read().decode())
    except urllib.error.URLError:
        time.sleep(0.1)
        continue
    if host["status"] == "online":
        raise SystemExit(0)
    time.sleep(0.1)
raise SystemExit("daemon did not come online")
PY
}

agent_snapshot_contains() {
  local expected="$1"
  python3 - "$base_url" "$smoke_token" "$smoke_agent_id" "$expected" <<'PY'
import base64
import json
import sys
import time
import urllib.error
import urllib.request

base_url, token, agent_id, expected = sys.argv[1:]


def snapshot() -> str | None:
    req = urllib.request.Request(
        f"{base_url}/api/agents/{agent_id}/snapshot",
        data=json.dumps({"lines": 200, "plain": True}).encode(),
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            body = json.loads(response.read().decode())
    except (urllib.error.HTTPError, urllib.error.URLError):
        return None
    return base64.b64decode(body["bytes_b64"]).decode(errors="replace")


last = None
for _ in range(100):
    last = snapshot()
    if last is not None and expected in last:
        raise SystemExit(0)
    time.sleep(0.1)
raise SystemExit(f"snapshot did not contain {expected!r}; last snapshot: {last!r}")
PY
}

agent_send_and_expect_echo() {
  local text="$1"
  local expected="echo:$text"
  python3 - "$base_url" "$smoke_token" "$smoke_agent_id" "$text" "$expected" <<'PY'
import base64
import json
import sys
import time
import urllib.error
import urllib.request

base_url, token, agent_id, text, expected = sys.argv[1:]


def request(method: str, path: str, payload: dict | None = None) -> dict | None:
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(
        base_url + path,
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            body = response.read()
            return json.loads(body.decode() or "{}")
    except (urllib.error.HTTPError, urllib.error.URLError):
        return None


def snapshot() -> str | None:
    body = request(
        "POST",
        f"/api/agents/{agent_id}/snapshot",
        {"lines": 200, "plain": True},
    )
    if body is None:
        return None
    return base64.b64decode(body["bytes_b64"]).decode(errors="replace")


sent = False
last = None
for _ in range(120):
    if not sent:
        sent = request("POST", f"/api/agents/{agent_id}/input", {"text": text + "\n"}) is not None
    last = snapshot()
    if last is not None and expected in last:
        raise SystemExit(0)
    time.sleep(0.1)
raise SystemExit(f"agent did not echo {text!r}; sent={sent}; last snapshot: {last!r}")
PY
}

printf '%s\n' "smoke-local-daemon: building spawnd"
(cd daemon && cargo build --locked >/dev/null)

printf '%s\n' "smoke-local-daemon: preparing database"
(
  cd server
  SPAWN_DATABASE_URL="$db_url" \
    SPAWN_USE_INPROCESS_PUBSUB=1 \
    SPAWN_JWT_SECRET=smoke-test-secret-with-enough-length \
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

start_server

printf '%s\n' "smoke-local-daemon: provisioning daemon credentials"
creds="$(
  python3 - "$base_url" "$daemon_home" <<'PY'
import json
import os
import sys
import urllib.error
import urllib.request

base_url, home = sys.argv[1:]


def request(method: str, path: str, payload: dict | None = None, token: str | None = None) -> dict:
    data = None if payload is None else json.dumps(payload).encode()
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(base_url + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            body = response.read()
            return json.loads(body.decode() or "{}")
    except urllib.error.HTTPError as error:
        raise SystemExit(f"{method} {path} failed: {error.code} {error.read().decode()}") from error


signup = request(
    "POST",
    "/api/auth/signup",
    {"email": "smoke@example.com", "password": "passpasspass"},
)
token = signup["access_token"]
start = request(
    "POST",
    "/api/auth/device/start",
    {
        "host_name": "smoke-host",
        "os": sys.platform,
        "arch": "smoke",
        "version": "smoke",
    },
)
request("POST", "/api/auth/device/approve", {"user_code": start["user_code"]}, token)
poll = request("POST", "/api/auth/device/poll", {"device_code": start["device_code"]})

creds = {
    "access_token": poll["access_token"],
    "host_id": poll["host_id"],
    "server_url": base_url,
}
for config_dir in (
    os.path.join(home, ".config", "spawn"),
    os.path.join(home, "Library", "Application Support", "spawn"),
):
    os.makedirs(config_dir, exist_ok=True)
    with open(os.path.join(config_dir, "credentials.json"), "w", encoding="utf-8") as handle:
        json.dump(creds, handle)

print(json.dumps({"token": token, "host_id": poll["host_id"]}))
PY
)"
smoke_token="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])' <<<"$creds")"
smoke_host_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["host_id"])' <<<"$creds")"

start_daemon
wait_host_online

printf '%s\n' "smoke-local-daemon: verifying skills reach a real daemon-launched codex agent"
python3 - "$base_url" "$smoke_token" <<'PY'
import json
import sys
import urllib.error
import urllib.request

base_url, token = sys.argv[1:]


def request(method: str, path: str, payload: dict | None = None) -> dict:
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(
        base_url + path,
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            body = response.read()
            return json.loads(body.decode() or "{}")
    except urllib.error.HTTPError as error:
        raise SystemExit(f"{method} {path} failed: {error.code} {error.read().decode()}") from error


request(
    "POST",
    "/api/skills",
    {
        "name": "spawn-smoke-skill",
        "description": "Smoke skill",
        "content": "# Smoke Skill\nUse this skill during the smoke test.",
        "enabled_by_default": True,
    },
)
PY

agent="$(
  python3 - "$base_url" "$smoke_token" "$smoke_host_id" "$agent_cwd" <<'PY'
import base64
import json
import sys
import time
import urllib.error
import urllib.request

base_url, token, host_id, cwd = sys.argv[1:]


def request(method: str, path: str, payload: dict | None = None) -> dict:
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(
        base_url + path,
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            body = response.read()
            return json.loads(body.decode() or "{}")
    except urllib.error.HTTPError as error:
        raise SystemExit(f"{method} {path} failed: {error.code} {error.read().decode()}") from error


created = request(
    "POST",
    "/api/agents",
    {
        "host_id": host_id,
        "name": "fake-codex-capabilities",
        "cwd": cwd,
        "argv": ["codex", "--yolo"],
        "cols": 100,
        "rows": 30,
    },
)
agent_id = created["id"]


def snapshot() -> str:
    body = request(
        "POST",
        f"/api/agents/{agent_id}/snapshot",
        {"lines": 200, "plain": True},
    )
    return base64.b64decode(body["bytes_b64"]).decode(errors="replace")


required_markers = [
    "fake-codex-ready",
    "fake-codex-env:ok",
    "fake-codex-skills:spawn-smoke-skill",
    "fake-codex-config-dir:ok",
    "fake-codex-skills-json:ok",
    "fake-codex-skill-file:ok",
    "fake-codex-codex-config-skill:ok",
    "fake-codex-codex-config-project:ok",
]

last = ""
for _ in range(120):
    last = snapshot()
    if all(marker in last for marker in required_markers):
        print(json.dumps({"agent_id": agent_id}))
        raise SystemExit(0)
    time.sleep(0.1)

missing = [marker for marker in required_markers if marker not in last]
raise SystemExit(f"fake codex did not observe capabilities; missing={missing}; last snapshot: {last!r}")
PY
)"
smoke_agent_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["agent_id"])' <<<"$agent")"
curl -fsS -X DELETE \
  -H "Authorization: Bearer $smoke_token" \
  "$base_url/api/agents/$smoke_agent_id" >/dev/null
smoke_agent_id=""

printf '%s\n' "smoke-local-daemon: creating and interacting with shell agent"
agent="$(
  python3 - "$base_url" "$smoke_token" "$smoke_host_id" "$agent_cwd" <<'PY'
import base64
import json
import sys
import time
import urllib.error
import urllib.request

base_url, token, host_id, cwd = sys.argv[1:]


def request(method: str, path: str, payload: dict | None = None) -> dict:
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(
        base_url + path,
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            body = response.read()
            return json.loads(body.decode() or "{}")
    except urllib.error.HTTPError as error:
        raise SystemExit(f"{method} {path} failed: {error.code} {error.read().decode()}") from error


created = request(
    "POST",
    "/api/agents",
    {
        "host_id": host_id,
        "cwd": cwd,
        "argv": [
            "sh",
            "-lc",
            "printf 'spawn-smoke-ready\\n'; while IFS= read -r line; do printf 'echo:%s\\n' \"$line\"; done",
        ],
        "cols": 100,
        "rows": 30,
    },
)
agent_id = created["id"]


def snapshot() -> str:
    body = request(
        "POST",
        f"/api/agents/{agent_id}/snapshot",
        {"lines": 200, "plain": True},
    )
    return base64.b64decode(body["bytes_b64"]).decode(errors="replace")


for _ in range(100):
    text = snapshot()
    if "spawn-smoke-ready" in text:
        break
    time.sleep(0.1)
else:
    raise SystemExit(f"agent did not print readiness marker; last snapshot: {text!r}")

request("POST", f"/api/agents/{agent_id}/input", {"text": "hello from smoke\n"})

for _ in range(100):
    text = snapshot()
    if "echo:hello from smoke" in text:
        print(json.dumps({"agent_id": agent_id}))
        raise SystemExit(0)
    time.sleep(0.1)
raise SystemExit(f"agent did not echo input; last snapshot: {text!r}")
PY
)"
smoke_agent_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["agent_id"])' <<<"$agent")"

printf '%s\n' "smoke-local-daemon: verifying concurrent shell agents stay isolated"
python3 - "$base_url" "$smoke_token" "$smoke_host_id" "$agent_cwd" <<'PY'
import base64
import concurrent.futures
import json
import sys
import time
import urllib.error
import urllib.request

base_url, token, host_id, root_cwd = sys.argv[1:]
agent_ids: list[str] = []


def request(method: str, path: str, payload: dict | None = None) -> dict:
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(
        base_url + path,
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            body = response.read()
            return json.loads(body.decode() or "{}")
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"{method} {path} failed: {error.code} {error.read().decode()}") from error


def snapshot(agent_id: str) -> str:
    body = request(
        "POST",
        f"/api/agents/{agent_id}/snapshot",
        {"lines": 200, "plain": True},
    )
    return base64.b64decode(body["bytes_b64"]).decode(errors="replace")


def wait_for(agent_id: str, marker: str) -> str:
    last = ""
    for _ in range(120):
        last = snapshot(agent_id)
        if marker in last:
            return last
        time.sleep(0.1)
    raise RuntimeError(f"agent {agent_id} did not show {marker!r}; last snapshot: {last!r}")


def exercise(index: int) -> tuple[str, str]:
    ready = f"concurrent-{index}-ready"
    echo = f"concurrent-{index}:payload-{index}"
    created = request(
        "POST",
        "/api/agents",
        {
            "host_id": host_id,
            "name": f"concurrent-{index}",
            "cwd": f"{root_cwd}/concurrent-{index}",
            "argv": [
                "sh",
                "-lc",
                f"printf '{ready}\\n'; while IFS= read -r line; do printf 'concurrent-{index}:%s\\n' \"$line\"; done",
            ],
            "cols": 100,
            "rows": 30,
            "create_cwd": True,
        },
    )
    agent_id = created["id"]
    agent_ids.append(agent_id)
    wait_for(agent_id, ready)
    request("POST", f"/api/agents/{agent_id}/input", {"text": f"payload-{index}\n"})
    final = wait_for(agent_id, echo)
    return agent_id, final


try:
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(exercise, range(4)))
    for index, (agent_id, text) in enumerate(results):
        for other in range(4):
            marker = f"concurrent-{other}:payload-{other}"
            if other == index and marker not in text:
                raise RuntimeError(f"agent {agent_id} missing own marker {marker!r}")
            if other != index and marker in text:
                raise RuntimeError(f"agent {agent_id} leaked marker {marker!r}: {text!r}")
finally:
    for agent_id in list(agent_ids):
        try:
            request("DELETE", f"/api/agents/{agent_id}")
        except Exception:
            pass
PY

printf '%s\n' "smoke-local-daemon: verifying agent survives daemon restart"
stop_daemon
start_daemon
wait_host_online
agent_snapshot_contains "spawn-smoke-ready"
agent_send_and_expect_echo "after daemon restart"

printf '%s\n' "smoke-local-daemon: verifying daemon reconnects after server restart"
stop_server
start_server
wait_host_online
agent_snapshot_contains "echo:after daemon restart"
agent_send_and_expect_echo "after server restart"

curl -fsS -X DELETE \
  -H "Authorization: Bearer $smoke_token" \
  "$base_url/api/agents/$smoke_agent_id" >/dev/null
smoke_agent_id=""

printf '%s\n' "smoke-local-daemon: passed"
