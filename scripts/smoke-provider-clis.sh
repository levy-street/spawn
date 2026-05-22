#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/smoke-provider-clis.sh

Runs the real installed provider CLIs through spawn's daemon-backed agent path.
This verifies that the host daemon can find and launch the actual provider
binaries under its service environment. It uses harmless `--version` commands;
provider account credentials are still owned by the CLIs and are not inspected.

Expected local stack:
  - spawn-server reachable through the web origin's /api and /ws rewrites
  - spawn-web reachable at SPAWN_PROVIDER_SMOKE_BASE_URL
  - an approved, online local spawnd host

Environment:
  SPAWN_PROVIDER_SMOKE_BASE_URL   Web origin. Default: http://localhost:3002
  SPAWN_PROVIDER_SMOKE_DB_URL     Server DB URL. Default: sqlite+aiosqlite:///./data/spawn.db
  SPAWN_PROVIDER_SMOKE_COMMANDS   Commands to verify. Default: claude codex opencode aider
  SPAWN_PROVIDER_SMOKE_REQUIRE    If 1, fail when any requested command is absent. Default: 0
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

die() {
  printf 'smoke-provider-clis: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1
}

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || die "run from inside the spawn repo"
cd "$repo_root"

need curl || die "curl is required"

base_url="${SPAWN_PROVIDER_SMOKE_BASE_URL:-http://localhost:3002}"
db_url="${SPAWN_PROVIDER_SMOKE_DB_URL:-sqlite+aiosqlite:///./data/spawn.db}"
commands="${SPAWN_PROVIDER_SMOKE_COMMANDS:-claude codex opencode aider}"
require_all="${SPAWN_PROVIDER_SMOKE_REQUIRE:-0}"

curl -fsSI "$base_url/hosts" >/dev/null || die "$base_url/hosts is not reachable"

available=()
missing=()
for command_name in $commands; do
  if command -v "$command_name" >/dev/null 2>&1; then
    available+=("$command_name")
  else
    missing+=("$command_name")
  fi
done

if [[ "$require_all" == "1" && "${#missing[@]}" -gt 0 ]]; then
  die "missing requested provider command(s): ${missing[*]}"
fi
if [[ "${#available[@]}" -eq 0 ]]; then
  die "no requested provider commands are installed; set SPAWN_PROVIDER_SMOKE_COMMANDS or install one of: $commands"
fi
if [[ "${#missing[@]}" -gt 0 ]]; then
  printf 'smoke-provider-clis: skipping missing provider command(s): %s\n' "${missing[*]}" >&2
fi

(
  cd server
  SPAWN_DATABASE_URL="$db_url" \
  SPAWN_PROVIDER_SMOKE_BASE_URL="$base_url" \
  SPAWN_PROVIDER_SMOKE_AVAILABLE="${available[*]}" \
  uv run python - <<'PY'
import asyncio
import base64
import json
import os
import tempfile
import time
from urllib.parse import urlencode, urlparse

import httpx
import websockets
from sqlalchemy import select

from spawn_server import auth
from spawn_server.db import get_sessionmaker, init_engine
from spawn_server.models import Agent, Host

BASE = os.environ["SPAWN_PROVIDER_SMOKE_BASE_URL"].rstrip("/")
COMMANDS = os.environ["SPAWN_PROVIDER_SMOKE_AVAILABLE"].split()
parsed = urlparse(BASE)
ws_scheme = "wss" if parsed.scheme == "https" else "ws"
WS_BASE = f"{ws_scheme}://{parsed.netloc}"

EXPECTED = {
    "claude": "claude",
    "codex": "codex",
    "opencode": "",
    "aider": "aider",
}


async def issue_token_for_online_host() -> tuple[str, str]:
    init_engine()
    async with get_sessionmaker()() as session:
        hosts = (
            await session.execute(select(Host).order_by(Host.last_seen_at.desc()))
        ).scalars().all()
        for host in hosts:
            if host.status == "online":
                return auth.issue_access_token(host.owner_user_id), host.id
    raise RuntimeError("no online host in local DB")


async def wait_agent(client: httpx.AsyncClient, agent_id: str, timeout: float = 20) -> dict:
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        response = await client.get(f"/api/agents/{agent_id}")
        response.raise_for_status()
        last = response.json()
        if last["status"] in {"exited", "killed"}:
            return last
        await asyncio.sleep(0.2)
    raise AssertionError(f"agent {agent_id} did not exit; last={last}")


async def transcript_for(token: str, agent_id: str) -> str:
    qs = urlencode({"agent_id": agent_id, "token": token, "cols": 100, "rows": 24})
    texts: list[str] = []
    deadline = time.monotonic() + 8
    async with websockets.connect(f"{WS_BASE}/ws/browser?{qs}", subprotocols=["spawn.v1"]) as ws:
        while time.monotonic() < deadline:
            msg = await asyncio.wait_for(ws.recv(), timeout=max(0.1, deadline - time.monotonic()))
            if isinstance(msg, bytes):
                texts.append(msg.decode("utf-8", "ignore"))
                continue
            try:
                obj = json.loads(msg)
            except json.JSONDecodeError:
                continue
            if obj.get("type") == "history":
                texts.append(base64.b64decode(obj.get("bytes_b64") or "").decode("utf-8", "ignore"))
            if obj.get("type") in {"agent.exit", "agent.status"} and texts:
                break
    return "".join(texts)


async def cleanup(prefix: str, token: str) -> None:
    init_engine()
    async with get_sessionmaker()() as session:
        rows = (
            await session.execute(select(Agent).where(Agent.name.like(f"{prefix}%")))
        ).scalars().all()
    async with httpx.AsyncClient(base_url=BASE, headers={"Authorization": f"Bearer {token}"}) as client:
        for agent in rows:
            await client.delete(f"/api/agents/{agent.id}")


async def main() -> None:
    token, host_id = await issue_token_for_online_host()
    headers = {"Authorization": f"Bearer {token}"}
    prefix = f"spawn provider smoke {int(time.time())}"
    results = []
    async with httpx.AsyncClient(base_url=BASE, headers=headers, timeout=30) as client:
        for command in COMMANDS:
            name = f"{prefix} {command}"
            response = await client.post(
                "/api/agents",
                json={
                    "host_id": host_id,
                    "cwd": tempfile.mkdtemp(prefix=f"spawn-provider-{command}-"),
                    "argv": [command, "--version"],
                    "cols": 100,
                    "rows": 24,
                    "create_cwd": True,
                    "name": name,
                },
            )
            response.raise_for_status()
            agent_id = response.json()["id"]
            try:
                agent = await wait_agent(client, agent_id)
                if agent.get("exit_code") != 0:
                    raise AssertionError(f"{command} --version exited nonzero: {agent}")
                transcript = await transcript_for(token, agent_id)
                expected = EXPECTED.get(command, command).lower()
                if expected and expected not in transcript.lower():
                    raise AssertionError(
                        f"{command} transcript did not contain {expected!r}: {transcript!r}"
                    )
                if not transcript.strip():
                    raise AssertionError(f"{command} produced an empty transcript")
                results.append({"command": command, "agent_id": agent_id, "output": transcript.strip()[:160]})
            finally:
                await client.delete(f"/api/agents/{agent_id}")
    await cleanup(prefix, token)
    print(json.dumps({"ok": True, "providers": results}, indent=2))


asyncio.run(main())
PY
)
