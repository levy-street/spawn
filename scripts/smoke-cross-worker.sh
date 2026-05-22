#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/smoke-cross-worker.sh

Runs an isolated cross-worker smoke test with:
  - Redis from infra/docker-compose.yml
  - two uvicorn workers on 127.0.0.1:8101 and 127.0.0.1:8102
  - a temp SQLite database
  - a fake daemon connected to worker A
  - REST + browser websocket traffic sent to worker B

The test verifies daemon status request/response, agent create, browser stdin,
snapshot request/response, upload acknowledgement, agent exit, and daemon-side
launch failure handling across workers.

Environment:
  SPAWN_CROSS_REDIS_URL     Default: redis://127.0.0.1:6379/13
  SPAWN_CROSS_PORT_A        Default: 8101
  SPAWN_CROSS_PORT_B        Default: 8102
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

die() {
  printf 'smoke-cross-worker: %s\n' "$*" >&2
  exit 1
}

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || die "run from inside the spawn repo"
cd "$repo_root"

redis_url="${SPAWN_CROSS_REDIS_URL:-redis://127.0.0.1:6379/13}"
port_a="${SPAWN_CROSS_PORT_A:-8101}"
port_b="${SPAWN_CROSS_PORT_B:-8102}"
jwt_secret="cross-worker-smoke-secret-at-least-32-bytes"
tmpdir="$(mktemp -d /tmp/spawn-cross-worker.XXXXXX)"
db_url="sqlite+aiosqlite:///$tmpdir/spawn.db"
pid_a=""
pid_b=""
started_redis=0

cleanup() {
  if [[ -n "$pid_a" ]]; then kill "$pid_a" 2>/dev/null || true; fi
  if [[ -n "$pid_b" ]]; then kill "$pid_b" 2>/dev/null || true; fi
  wait "$pid_a" 2>/dev/null || true
  wait "$pid_b" 2>/dev/null || true
  rm -rf "$tmpdir"
  if [[ "$started_redis" == "1" ]]; then
    docker compose -f infra/docker-compose.yml stop redis >/dev/null || true
    docker compose -f infra/docker-compose.yml rm -f redis >/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

wait_http() {
  local url="$1"
  for _ in {1..80}; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

if ! docker compose -f infra/docker-compose.yml ps --status running -q redis | grep -q .; then
  docker compose -f infra/docker-compose.yml up -d redis >/dev/null
  started_redis=1
fi

(
  cd server
  SPAWN_DATABASE_URL="$db_url" \
    SPAWN_REDIS_URL="$redis_url" \
    SPAWN_USE_INPROCESS_PUBSUB=0 \
    SPAWN_JWT_SECRET="$jwt_secret" \
    uv run python - <<'PY'
import asyncio

import redis.asyncio as redis

from spawn_server import auth, models  # noqa: F401
from spawn_server.config import get_settings
from spawn_server.db import Base, get_engine, get_sessionmaker, init_engine
from spawn_server.models import Host, User
from spawn_server.presets import seed_builtin_presets


async def main() -> None:
    r = redis.from_url(get_settings().redis_url, decode_responses=False)
    await r.flushdb()
    await r.aclose()

    engine = init_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    sm = get_sessionmaker()
    async with sm() as session:
        await seed_builtin_presets(session)
        user = User(
            email="cross-worker@example.com",
            password_hash=auth.hash_password("passpasspass"),
        )
        session.add(user)
        await session.flush()
        session.add(Host(owner_user_id=user.id, name="cross-worker-host", status="offline"))
        await session.commit()

    await get_engine().dispose()


asyncio.run(main())
PY
)

(
  cd server
  SPAWN_DATABASE_URL="$db_url" \
    SPAWN_REDIS_URL="$redis_url" \
    SPAWN_USE_INPROCESS_PUBSUB=0 \
    SPAWN_JWT_SECRET="$jwt_secret" \
    uv run uvicorn spawn_server.main:app --host 127.0.0.1 --port "$port_a" >/tmp/spawn-cross-a.log 2>&1
) &
pid_a=$!

(
  cd server
  SPAWN_DATABASE_URL="$db_url" \
    SPAWN_REDIS_URL="$redis_url" \
    SPAWN_USE_INPROCESS_PUBSUB=0 \
    SPAWN_JWT_SECRET="$jwt_secret" \
    uv run uvicorn spawn_server.main:app --host 127.0.0.1 --port "$port_b" >/tmp/spawn-cross-b.log 2>&1
) &
pid_b=$!

wait_http "http://127.0.0.1:$port_a/healthz" || die "worker A did not start"
wait_http "http://127.0.0.1:$port_b/healthz" || die "worker B did not start"

(
  cd server
  SPAWN_DATABASE_URL="$db_url" \
    SPAWN_REDIS_URL="$redis_url" \
    SPAWN_USE_INPROCESS_PUBSUB=0 \
    SPAWN_JWT_SECRET="$jwt_secret" \
    SPAWN_CROSS_PORT_A="$port_a" \
    SPAWN_CROSS_PORT_B="$port_b" \
    uv run python - <<'PY'
import asyncio
import base64
import json
import os
import uuid

import httpx
import websockets
from sqlalchemy import select

from spawn_server import auth
from spawn_server.db import get_sessionmaker, init_engine
from spawn_server.models import Host, User


PORT_A = os.environ["SPAWN_CROSS_PORT_A"]
PORT_B = os.environ["SPAWN_CROSS_PORT_B"]
DAEMON_URL = f"ws://127.0.0.1:{PORT_A}/ws/daemon"
API = f"http://127.0.0.1:{PORT_B}"
BROWSER_WS = f"ws://127.0.0.1:{PORT_B}/ws/browser"
BROWSER_WS_A = f"ws://127.0.0.1:{PORT_A}/ws/browser"


async def recv_browser_json(ws, wanted: str, timeout: float = 3) -> dict:
    deadline = asyncio.get_running_loop().time() + timeout
    seen: list[str] = []
    while asyncio.get_running_loop().time() < deadline:
        msg = await asyncio.wait_for(
            ws.recv(), timeout=max(0.1, deadline - asyncio.get_running_loop().time())
        )
        if isinstance(msg, bytes):
            seen.append(f"<bytes {len(msg)}>")
            continue
        obj = json.loads(msg)
        seen.append(str(obj.get("type")))
        if obj.get("type") == wanted:
            return obj
    raise AssertionError(f"browser missing {wanted}; seen={seen}")


async def next_daemon_command(ws, wanted: str, timeout: float = 3):
    deadline = asyncio.get_running_loop().time() + timeout
    seen: list[str] = []
    while asyncio.get_running_loop().time() < deadline:
        msg = await asyncio.wait_for(
            ws.recv(), timeout=max(0.1, deadline - asyncio.get_running_loop().time())
        )
        if isinstance(msg, bytes):
            if wanted == "<binary>":
                return msg
            seen.append(f"<bytes {len(msg)}>")
            continue
        obj = json.loads(msg)
        seen.append(str(obj.get("type")))
        if obj.get("type") == wanted:
            return obj
        if obj.get("type") in {"agent.resize", "agent.redraw"}:
            continue
    raise AssertionError(f"daemon missing {wanted}; seen={seen}")


async def wait_agent_status(client: httpx.AsyncClient, agent_id: str, wanted: str, timeout: float = 3) -> dict:
    deadline = asyncio.get_running_loop().time() + timeout
    last = None
    while asyncio.get_running_loop().time() < deadline:
        response = await client.get(f"/api/agents/{agent_id}")
        response.raise_for_status()
        last = response.json()
        if last["status"] == wanted:
            return last
        await asyncio.sleep(0.1)
    raise AssertionError(f"agent {agent_id} missing status {wanted}; last={last}")


async def main() -> None:
    init_engine()
    sm = get_sessionmaker()
    async with sm() as session:
        user = (
            await session.execute(select(User).where(User.email == "cross-worker@example.com"))
        ).scalar_one()
        host = (await session.execute(select(Host).where(Host.owner_user_id == user.id))).scalar_one()
        access_token = auth.issue_access_token(user.id)
        daemon_token = auth.issue_daemon_token(host.id, user.id)
        host_id = host.id

    async with websockets.connect(
        f"{DAEMON_URL}?token={daemon_token}", subprotocols=["spawn.v1"]
    ) as daemon:
        await daemon.send(
            json.dumps(
                {
                    "type": "register",
                    "host_name": "cross-worker-host",
                    "os": "linux",
                    "arch": "x86_64-test",
                    "version": "0.2.0-test",
                    "home_dir": "/home/cross",
                    "existing_agents": [],
                }
            )
        )
        registered = await next_daemon_command(daemon, "registered")
        assert registered["host_id"] == host_id

        async with httpx.AsyncClient(
            base_url=API,
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=5,
        ) as client:
            status_task = asyncio.create_task(client.get(f"/api/hosts/{host_id}/daemon"))
            cmd = await next_daemon_command(daemon, "host.daemon.status")
            await daemon.send(
                json.dumps(
                    {
                        "type": "host.daemon.status_result",
                        "request_id": cmd["request_id"],
                        "status": "online",
                        "agents": [],
                        "update": {"ok": True, "clean": True},
                    }
                )
            )
            status = await status_task
            assert status.status_code == 200, status.text
            assert status.json()["status"] == "online"

            created = await client.post(
                "/api/agents",
                json={
                    "host_id": host_id,
                    "cwd": "/tmp",
                    "argv": ["/bin/sh", "-lc", "cat"],
                    "cols": 80,
                    "rows": 24,
                    "create_cwd": False,
                    "name": "cross worker agent",
                },
            )
            assert created.status_code == 201, created.text
            agent_id = created.json()["id"]
            cmd = await next_daemon_command(daemon, "agent.create")
            assert cmd["agent_id"] == agent_id
            await daemon.send(json.dumps({"type": "agent.started", "agent_id": agent_id}))

            browser = await websockets.connect(
                f"{BROWSER_WS}?agent_id={agent_id}&token={access_token}&cols=80&rows=24",
                subprotocols=["spawn.v1"],
            )
            second_browser = None
            try:
                first_display = await recv_browser_json(browser, "display.control")
                assert first_display["owner"] is True
                assert first_display["viewers"] == 1

                snap_cmd = await next_daemon_command(daemon, "agent.snapshot")
                await daemon.send(
                    json.dumps(
                        {
                            "type": "agent.snapshot",
                            "request_id": snap_cmd["request_id"],
                            "agent_id": agent_id,
                            "bytes_b64": base64.b64encode(b"initial screen").decode("ascii"),
                        }
                    )
                )
                hist = await recv_browser_json(browser, "history")
                assert base64.b64decode(hist["bytes_b64"]) == b"initial screen"

                second_browser = await websockets.connect(
                    f"{BROWSER_WS_A}?agent_id={agent_id}&token={access_token}&cols=60&rows=20",
                    subprotocols=["spawn.v1"],
                )
                second_display = await recv_browser_json(second_browser, "display.control")
                assert second_display["owner"] is False
                assert second_display["viewers"] == 2
                assert second_display["cols"] == 80
                assert second_display["rows"] == 24

                snap_cmd = await next_daemon_command(daemon, "agent.snapshot")
                await daemon.send(
                    json.dumps(
                        {
                            "type": "agent.snapshot",
                            "request_id": snap_cmd["request_id"],
                            "agent_id": agent_id,
                            "bytes_b64": base64.b64encode(b"second screen").decode("ascii"),
                        }
                    )
                )
                second_hist = await recv_browser_json(second_browser, "history")
                assert base64.b64decode(second_hist["bytes_b64"]) == b"second screen"

                first_display = await recv_browser_json(browser, "display.control")
                assert first_display["owner"] is True
                assert first_display["viewers"] == 2

                await second_browser.send(json.dumps({"type": "take_control", "cols": 100, "rows": 30}))
                resize_cmd = await next_daemon_command(daemon, "agent.resize")
                assert resize_cmd["cols"] == 100
                assert resize_cmd["rows"] == 30
                second_display = await recv_browser_json(second_browser, "display.control")
                assert second_display["owner"] is True
                assert second_display["cols"] == 100
                assert second_display["rows"] == 30
                first_display = await recv_browser_json(browser, "display.control")
                assert first_display["owner"] is False
                assert first_display["cols"] == 100
                assert first_display["rows"] == 30

                await daemon.send(json.dumps({"type": "agent.started", "agent_id": agent_id}))
                event = await recv_browser_json(browser, "agent.status")
                assert event["status"] == "running"

                await browser.send(b"hello from worker b\n")
                raw = await next_daemon_command(daemon, "<binary>")
                assert raw[0] == 0x02
                assert str(uuid.UUID(bytes=raw[1:17])) == agent_id
                assert raw[17:] == b"hello from worker b\n"

                await browser.send(json.dumps({"type": "snapshot", "lines": 100, "plain": True}))
                snap_cmd = await next_daemon_command(daemon, "agent.snapshot")
                await daemon.send(
                    json.dumps(
                        {
                            "type": "agent.snapshot",
                            "request_id": snap_cmd["request_id"],
                            "agent_id": agent_id,
                            "bytes_b64": base64.b64encode(b"snapshot over redis").decode("ascii"),
                        }
                    )
                )
                snap = await recv_browser_json(browser, "snapshot")
                assert base64.b64decode(snap["bytes_b64"]) == b"snapshot over redis"

                await browser.send(
                    json.dumps(
                        {
                            "type": "upload",
                            "name": "note.txt",
                            "mime_type": "text/plain",
                            "bytes_b64": base64.b64encode(b"upload").decode("ascii"),
                            "destination": "cwd",
                            "paste": False,
                            "client_id": "cw-upload",
                        }
                    )
                )
                upload_cmd = await next_daemon_command(daemon, "agent.upload")
                assert upload_cmd["client_id"] == "cw-upload"
                await daemon.send(
                    json.dumps(
                        {
                            "type": "agent.uploaded",
                            "agent_id": agent_id,
                            "path": "/tmp/note.txt",
                            "client_id": "cw-upload",
                        }
                    )
                )
                saved = await recv_browser_json(browser, "upload.saved")
                assert saved["client_id"] == "cw-upload"
                assert saved["path"] == "/tmp/note.txt"

                await daemon.send(
                    json.dumps(
                        {
                            "type": "agent.exit",
                            "agent_id": agent_id,
                            "exit_code": 0,
                            "signal": None,
                        }
                    )
                )
                exited = await recv_browser_json(browser, "agent.exit")
                assert exited["exit_code"] == 0
                assert exited["signal"] is None
            finally:
                if second_browser is not None:
                    await second_browser.close()
                await browser.close()
            await client.delete(f"/api/agents/{agent_id}")

            failed = await client.post(
                "/api/agents",
                json={
                    "host_id": host_id,
                    "cwd": "/tmp",
                    "argv": ["spawn-definitely-missing"],
                    "cols": 80,
                    "rows": 24,
                    "create_cwd": False,
                    "name": "cross worker failed agent",
                },
            )
            assert failed.status_code == 201, failed.text
            failed_agent_id = failed.json()["id"]
            cmd = await next_daemon_command(daemon, "agent.create")
            assert cmd["agent_id"] == failed_agent_id

            failed_browser = await websockets.connect(
                f"{BROWSER_WS}?agent_id={failed_agent_id}&token={access_token}&cols=80&rows=24",
                subprotocols=["spawn.v1"],
            )
            try:
                await recv_browser_json(failed_browser, "display.control")
                snap_cmd = await next_daemon_command(daemon, "agent.snapshot")
                await daemon.send(
                    json.dumps(
                        {
                            "type": "agent.snapshot",
                            "request_id": snap_cmd["request_id"],
                            "agent_id": failed_agent_id,
                            "bytes_b64": "",
                        }
                    )
                )
                await recv_browser_json(failed_browser, "history")
                status = await recv_browser_json(failed_browser, "agent.status")
                assert status["status"] == "starting"
                await daemon.send(
                    json.dumps(
                        {
                            "type": "error",
                            "agent_id": failed_agent_id,
                            "code": "spawn_failed",
                            "message": "executable not found",
                        }
                    )
                )
                failed_exit = await recv_browser_json(failed_browser, "agent.exit")
                assert failed_exit["exit_code"] == 127
                assert failed_exit["signal"] is None
                failed_status = await wait_agent_status(client, failed_agent_id, "exited")
                assert failed_status["exit_code"] == 127
            finally:
                await failed_browser.close()
                await client.delete(f"/api/agents/{failed_agent_id}")

    print("smoke-cross-worker: ok")


asyncio.run(main())
PY
)
