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
    results[name] = ok
    print(f"fake-codex-{name}:{'ok' if ok else 'bad'}", flush=True)


results: dict[str, bool] = {}
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
(Path.cwd() / ".spawn-smoke-capabilities.json").write_text(
    json.dumps({"skills": skill_names, "checks": results}),
    encoding="utf-8",
)
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

wait_agent_running() {
  local agent_id="$1"
  python3 - "$base_url" "$smoke_token" "$agent_id" <<'PY'
import json
import sys
import time
import urllib.error
import urllib.request

base_url, token, agent_id = sys.argv[1:]
last = None
for _ in range(120):
    req = urllib.request.Request(
        f"{base_url}/api/agents/{agent_id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            last = json.loads(response.read().decode())
    except (urllib.error.HTTPError, urllib.error.URLError):
        time.sleep(0.1)
        continue
    if last.get("status") == "running":
        raise SystemExit(0)
    time.sleep(0.1)
raise SystemExit(f"agent did not reach running state; last={last!r}")
PY
}

wait_file_contains() {
  local path="$1"
  local expected="$2"
  for _ in {1..120}; do
    if [[ -f "$path" ]] && grep -F "$expected" "$path" >/dev/null; then
      return 0
    fi
    sleep 0.1
  done
  printf 'smoke-local-daemon: %s did not contain %s\n' "$path" "$expected" >&2
  return 1
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
import json
import sys
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
    },
)
print(json.dumps({"agent_id": created["id"]}))
PY
)"
smoke_agent_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["agent_id"])' <<<"$agent")"
wait_agent_running "$smoke_agent_id"
capability_report="$agent_cwd/.spawn-smoke-capabilities.json"
wait_file_contains "$capability_report" '"skills": ["spawn-smoke-skill"]'
python3 - "$capability_report" <<'PY'
import json
import sys

report = json.loads(open(sys.argv[1], encoding="utf-8").read())
if not report["checks"] or not all(report["checks"].values()):
    raise SystemExit(f"fake codex capability checks failed: {report!r}")
PY
curl -fsS -X DELETE \
  -H "Authorization: Bearer $smoke_token" \
  "$base_url/api/agents/$smoke_agent_id" >/dev/null
smoke_agent_id=""

printf '%s\n' "smoke-local-daemon: creating persistent shell agent"
agent="$(
  python3 - "$base_url" "$smoke_token" "$smoke_host_id" "$agent_cwd" <<'PY'
import json
import sys
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
            "printf 'spawn-smoke-ready\\n' > .spawn-smoke-ready; printf 'spawn-smoke-ready\\n'; while :; do sleep 1; done",
        ],
    },
)
print(json.dumps({"agent_id": created["id"]}))
PY
)"
smoke_agent_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["agent_id"])' <<<"$agent")"
wait_agent_running "$smoke_agent_id"
wait_file_contains "$agent_cwd/.spawn-smoke-ready" "spawn-smoke-ready"

printf '%s\n' "smoke-local-daemon: verifying concurrent worker lifecycles stay isolated"
python3 - "$base_url" "$smoke_token" "$smoke_host_id" "$agent_cwd" <<'PY'
import concurrent.futures
import json
from pathlib import Path
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


def wait_for(agent_id: str, path: Path, marker: str) -> None:
    last = None
    for _ in range(120):
        agent = request("GET", f"/api/agents/{agent_id}")
        last = agent
        if agent.get("status") == "running" and path.is_file() and path.read_text() == marker:
            return
        time.sleep(0.1)
    raise RuntimeError(f"agent {agent_id} did not become isolated and ready; last={last!r}")


def exercise(index: int) -> str:
    ready = f"concurrent-{index}-ready"
    cwd = Path(root_cwd) / f"concurrent-{index}"
    created = request(
        "POST",
        "/api/agents",
        {
            "host_id": host_id,
            "name": f"concurrent-{index}",
            "cwd": str(cwd),
            "argv": [
                "sh",
                "-lc",
                f"printf '{ready}' > .spawn-worker-ready; while :; do sleep 1; done",
            ],
            "create_cwd": True,
        },
    )
    agent_id = created["id"]
    agent_ids.append(agent_id)
    wait_for(agent_id, cwd / ".spawn-worker-ready", ready)
    return agent_id


try:
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(exercise, range(4)))
    ready_files = sorted(Path(root_cwd).glob("concurrent-*/.spawn-worker-ready"))
    if len(ready_files) != 4 or len({path.read_text() for path in ready_files}) != 4:
        raise RuntimeError(f"concurrent worker markers were not isolated: {ready_files!r}")
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
wait_agent_running "$smoke_agent_id"
wait_file_contains "$agent_cwd/.spawn-smoke-ready" "spawn-smoke-ready"

printf '%s\n' "smoke-local-daemon: verifying daemon reconnects after server restart"
stop_server
start_server
wait_host_online
wait_agent_running "$smoke_agent_id"
wait_file_contains "$agent_cwd/.spawn-smoke-ready" "spawn-smoke-ready"

curl -fsS -X DELETE \
  -H "Authorization: Bearer $smoke_token" \
  "$base_url/api/agents/$smoke_agent_id" >/dev/null
smoke_agent_id=""

printf '%s\n' "smoke-local-daemon: passed"
