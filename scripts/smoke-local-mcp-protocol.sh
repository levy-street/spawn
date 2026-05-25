#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'smoke-local-mcp-protocol: missing required command: %s\n' "$1" >&2
    exit 1
  }
}

need cargo
need curl
need python3
need tmux
need uv

tmp_dir="$(mktemp -d)"
server_pid=""
daemon_pid=""
user_token=""
base_url=""
tmux_tmp="$tmp_dir/tmux"

cleanup() {
  local status=$?
  if [[ -n "${base_url:-}" && -n "${user_token:-}" ]]; then
    python3 - "$base_url" "$user_token" <<'PY' >/dev/null 2>&1 || true
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

base_url, token = sys.argv[1:]


def request(method: str, path: str, payload: dict | None = None) -> dict | list | None:
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(
        base_url + path,
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            body = response.read()
            return json.loads(body.decode() or "null")
    except (urllib.error.HTTPError, urllib.error.URLError):
        return None


agents = request("GET", "/api/agents?" + urllib.parse.urlencode({"include_archived": "true"}))
if isinstance(agents, list):
    for agent in agents:
        agent_id = agent.get("id")
        if agent_id:
            request("DELETE", f"/api/agents/{agent_id}")
PY
  fi
  if [[ -n "$daemon_pid" ]]; then
    kill "$daemon_pid" >/dev/null 2>&1 || true
    wait "$daemon_pid" 2>/dev/null || true
  fi
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [[ -d "$tmux_tmp" ]]; then
    TMUX_TMPDIR="$tmux_tmp" tmux kill-server >/dev/null 2>&1 || true
  fi
  if [[ "$status" != "0" ]]; then
    for log in "${server_log:-}" "${daemon_log:-}" "${mcp_log:-}"; do
      if [[ -n "$log" && -f "$log" ]]; then
        printf '%s\n' "---- $(basename "$log") ----" >&2
        tail -240 "$log" >&2 || true
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
db_url="sqlite+aiosqlite:///$tmp_dir/spawn-mcp-smoke.db"
server_log="$tmp_dir/server.log"
daemon_log="$tmp_dir/daemon.log"
mcp_log="$tmp_dir/mcp.log"
daemon_home="$tmp_dir/daemon-home"
agent_cwd="$tmp_dir/agent-cwd"
upload_path="$agent_cwd/mcp-upload.txt"
mkdir -p "$daemon_home" "$agent_cwd" "$tmux_tmp"

printf '%s\n' "smoke-local-mcp-protocol: building spawnd"
(cd daemon && cargo build --locked >/dev/null)

printf '%s\n' "smoke-local-mcp-protocol: preparing database"
(
  cd server
  SPAWN_DATABASE_URL="$db_url" \
    SPAWN_USE_INPROCESS_PUBSUB=1 \
    SPAWN_JWT_SECRET=smoke-mcp-protocol-secret-with-enough-length \
    SPAWN_PUBLIC_URL="$base_url" \
    uv run alembic upgrade head >/dev/null
)

printf '%s\n' "smoke-local-mcp-protocol: starting API server on $base_url"
(
  cd server
  exec env \
    SPAWN_DATABASE_URL="$db_url" \
    SPAWN_USE_INPROCESS_PUBSUB=1 \
    SPAWN_JWT_SECRET=smoke-mcp-protocol-secret-with-enough-length \
    SPAWN_PUBLIC_URL="$base_url" \
    SPAWN_TRANSCRIPT_DIR="$tmp_dir/transcripts" \
    uv run uvicorn spawn_server.main:app --host 127.0.0.1 --port "$port"
) >"$server_log" 2>&1 &
server_pid=$!

for _ in {1..100}; do
  if curl -fsS "$base_url/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
curl -fsS "$base_url/healthz" >/dev/null

printf '%s\n' "smoke-local-mcp-protocol: provisioning daemon credentials"
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
            return json.loads(response.read().decode() or "{}")
    except urllib.error.HTTPError as error:
        raise SystemExit(f"{method} {path} failed: {error.code} {error.read().decode()}") from error


signup = request(
    "POST",
    "/api/auth/signup",
    {"email": "mcp-protocol@example.com", "password": "passpasspass"},
)
token = signup["access_token"]
start = request(
    "POST",
    "/api/auth/device/start",
    {
        "host_name": "mcp-protocol-host",
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
user_token="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])' <<<"$creds")"
host_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["host_id"])' <<<"$creds")"

printf '%s\n' "smoke-local-mcp-protocol: starting spawnd for host $host_id"
HOME="$daemon_home" \
  SPAWN_DISABLE_KEYRING=1 \
  TMUX_TMPDIR="$tmux_tmp" \
  daemon/target/debug/spawnd --server "$base_url" run \
  >"$daemon_log" 2>&1 &
daemon_pid=$!

python3 - "$base_url" "$user_token" "$host_id" <<'PY'
import json
import sys
import time
import urllib.error
import urllib.request

base_url, token, host_id = sys.argv[1:]
for _ in range(120):
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

printf '%s\n' "smoke-local-mcp-protocol: calling Spawn MCP over streamable HTTP"
(
  cd server
  SPAWN_MCP_BASE_URL="$base_url" \
    SPAWN_MCP_USER_TOKEN="$user_token" \
    SPAWN_MCP_HOST_ID="$host_id" \
    SPAWN_MCP_AGENT_CWD="$agent_cwd" \
    SPAWN_MCP_UPLOAD_PATH="$upload_path" \
    uv run python - <<'PY'
import asyncio
import ast
import base64
import json
import os
import time
from typing import Any

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client


base_url = os.environ["SPAWN_MCP_BASE_URL"].rstrip("/")
token = os.environ["SPAWN_MCP_USER_TOKEN"]
host_id = os.environ["SPAWN_MCP_HOST_ID"]
agent_cwd = os.environ["SPAWN_MCP_AGENT_CWD"]
upload_path = os.environ["SPAWN_MCP_UPLOAD_PATH"]


def normalize(value: Any) -> Any:
    if isinstance(value, dict) and set(value) == {"result"}:
        return value["result"]
    return value


def payload(result: Any) -> Any:
    structured = getattr(result, "structured_content", None)
    if structured is None:
        structured = getattr(result, "structuredContent", None)
    if structured is not None:
        return normalize(structured)
    content = getattr(result, "content", None) or []
    if len(content) == 1 and hasattr(content[0], "text"):
        text = content[0].text
        try:
            return normalize(json.loads(text))
        except json.JSONDecodeError:
            try:
                return normalize(ast.literal_eval(text))
            except (SyntaxError, ValueError):
                return text
    return [getattr(item, "text", repr(item)) for item in content]


async def call(session: ClientSession, name: str, arguments: dict[str, Any] | None = None) -> Any:
    result = await session.call_tool(name, arguments or {})
    if getattr(result, "isError", False):
        raise RuntimeError(f"{name} failed: {result!r}")
    return payload(result)


async def main() -> None:
    headers = {"Authorization": f"Bearer {token}"}
    async with streamablehttp_client(f"{base_url}/mcp/", headers=headers) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            names = {tool.name for tool in tools.tools}
            required = {
                "list_hosts",
                "create_agent",
                "send_agent_input",
                "snapshot_agent",
                "upload_agent_file",
                "delete_agent",
            }
            missing = sorted(required - names)
            if missing:
                raise SystemExit(f"missing MCP tools: {missing}")

            hosts = await call(session, "list_hosts")
            if not isinstance(hosts, list):
                raise SystemExit(f"list_hosts returned unexpected payload: {hosts!r}")
            if not any(host.get("id") == host_id and host.get("status") == "online" for host in hosts):
                raise SystemExit(f"connected host not visible through MCP: {hosts!r}")

            agent = await call(
                session,
                "create_agent",
                {
                    "host_id": host_id,
                    "cwd": agent_cwd,
                    "name": "mcp protocol",
                    "argv": [
                        "sh",
                        "-lc",
                        "printf 'mcp-protocol-ready\\n'; while IFS= read -r line; do printf 'mcp-protocol:%s\\n' \"$line\"; done",
                    ],
                    "cols": 100,
                    "rows": 30,
                },
            )
            agent_id = agent["id"]
            try:
                for _ in range(120):
                    snapshot = await call(
                        session,
                        "snapshot_agent",
                        {"agent_id": agent_id, "lines": 200, "plain": True},
                    )
                    text = base64.b64decode(snapshot["bytes_b64"]).decode(errors="replace")
                    if "mcp-protocol-ready" in text:
                        break
                    await asyncio.sleep(0.1)
                else:
                    raise SystemExit(f"agent readiness not visible in snapshot: {text!r}")

                sent = await call(
                    session,
                    "send_agent_input",
                    {"agent_id": agent_id, "text": "hello over mcp\n"},
                )
                if sent.get("bytes", 0) < len("hello over mcp\n"):
                    raise SystemExit(f"unexpected send result: {sent!r}")

                for _ in range(120):
                    snapshot = await call(
                        session,
                        "snapshot_agent",
                        {"agent_id": agent_id, "lines": 200, "plain": True},
                    )
                    text = base64.b64decode(snapshot["bytes_b64"]).decode(errors="replace")
                    if "mcp-protocol:hello over mcp" in text:
                        break
                    await asyncio.sleep(0.1)
                else:
                    raise SystemExit(f"agent echo not visible in snapshot: {text!r}")

                uploaded = await call(
                    session,
                    "upload_agent_file",
                    {
                        "agent_id": agent_id,
                        "name": "mcp-upload.txt",
                        "mime_type": "text/plain",
                        "bytes_b64": base64.b64encode(b"uploaded over mcp\n").decode(),
                        "paste": False,
                        "destination": "cwd",
                    },
                )
                if uploaded.get("path") != upload_path:
                    raise SystemExit(f"unexpected upload result: {uploaded!r}")

                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    if os.path.exists(upload_path):
                        with open(upload_path, encoding="utf-8") as handle:
                            body = handle.read()
                        if body == "uploaded over mcp\n":
                            break
                    await asyncio.sleep(0.1)
                else:
                    raise SystemExit("MCP upload did not appear on disk")
            finally:
                await call(session, "delete_agent", {"agent_id": agent_id})


asyncio.run(main())
PY
) >"$mcp_log" 2>&1

grep -Fx "uploaded over mcp" "$upload_path" >/dev/null

printf '%s\n' "smoke-local-mcp-protocol: passed"
