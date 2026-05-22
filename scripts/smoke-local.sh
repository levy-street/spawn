#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/smoke-local.sh

Runs a local end-to-end smoke test against an already-running spawn stack.

Expected local stack:
  - spawn-server reachable through the web origin's /api and /ws rewrites
  - spawn-web reachable at SPAWN_SMOKE_BASE_URL
  - an approved, online local spawnd host

Environment:
  SPAWN_SMOKE_BASE_URL       Web origin. Default: http://localhost:3002
  SPAWN_SMOKE_DB_URL         Server DB URL. Default: sqlite+aiosqlite:///./data/spawn.db
  SPAWN_SMOKE_PUBSUB         Server pubsub mode for DB helper process. Default: 1
  SPAWND_BIN                 Installed wrapper. Default: ~/.local/bin/spawnd
  SPAWND_RELEASE_BIN         Installed release script. Default: ~/.local/lib/spawnd/rel/bin/spawnd
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

die() {
  printf 'smoke-local: %s\n' "$*" >&2
  exit 1
}

detect_target() {
  local os_name arch_name target_os target_arch
  os_name="$(uname -s 2>/dev/null || printf unknown)"
  arch_name="$(uname -m 2>/dev/null || printf unknown)"

  case "$os_name" in
    Linux) target_os=linux ;;
    Darwin) target_os=darwin ;;
    *) return 1 ;;
  esac

  case "$arch_name" in
    x86_64|amd64) target_arch=x86_64 ;;
    arm64|aarch64) target_arch=arm64 ;;
    *) return 1 ;;
  esac

  printf '%s-%s\n' "$target_os" "$target_arch"
}

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || die "run from inside the spawn repo"
cd "$repo_root"

base_url="${SPAWN_SMOKE_BASE_URL:-http://localhost:3002}"
db_url="${SPAWN_SMOKE_DB_URL:-sqlite+aiosqlite:///./data/spawn.db}"
pubsub="${SPAWN_SMOKE_PUBSUB:-1}"
spawnd_bin="${SPAWND_BIN:-$HOME/.local/bin/spawnd}"
release_bin="${SPAWND_RELEASE_BIN:-$HOME/.local/lib/spawnd/rel/bin/spawnd}"

[[ -x "$spawnd_bin" ]] || die "spawnd wrapper is not executable at $spawnd_bin"
[[ -x "$release_bin" ]] || die "spawnd release script is not executable at $release_bin"

curl -fsSI "$base_url/hosts" >/dev/null || die "$base_url/hosts is not reachable"
install_script="$(mktemp)"
artifact_archive="$(mktemp)"
package_dir="$(mktemp -d)"
trap 'rm -f "$install_script" "$artifact_archive"; rm -rf "$package_dir"' EXIT INT TERM
curl -fsSL "$base_url/install.sh" -o "$install_script" || die "$base_url/install.sh is not reachable"
grep -q '^#!/bin/sh' "$install_script" || die "install.sh is not a shell script"
sh -n "$install_script" || die "install.sh has invalid shell syntax"
grep -q -- '--build-from-source' "$install_script" || die "install.sh missing source fallback"
if target="$(detect_target)"; then
  packaged_artifact="$(scripts/package-spawnd.sh --skip-build --out-dir "$package_dir")" ||
    die "could not package current-target spawnd artifact"
  [[ "$(basename "$packaged_artifact")" == "spawnd-$target.tar.gz" ]] ||
    die "spawnd package used unexpected target name: $packaged_artifact"
  tar -tzf "$packaged_artifact" | grep -q 'spawnd/bin/spawnd$' ||
    die "packaged spawnd artifact missing release wrapper"
  tar -tzf "$packaged_artifact" | grep -q 'spawnd/spawnd_cli$' ||
    die "packaged spawnd artifact missing CLI"
  temp_install_root="$package_dir/install-root"
  SPAWN_INSTALL_ROOT="$temp_install_root" sh "$install_script" \
    --server "$base_url" \
    --artifact-url "file://$packaged_artifact" \
    --no-login \
    --no-start >/dev/null ||
    die "prebuilt installer failed against packaged spawnd artifact"
  [[ -x "$temp_install_root/bin/spawnd" ]] ||
    die "prebuilt installer did not create wrapper"
  [[ -x "$temp_install_root/lib/spawnd/rel/bin/spawnd" ]] ||
    die "prebuilt installer did not install release script"
  [[ -f "$temp_install_root/lib/spawnd/rel/spawnd_cli" ]] ||
    die "prebuilt installer did not install CLI"
  "$temp_install_root/bin/spawnd" --version >/dev/null ||
    die "prebuilt installer wrapper cannot run"
  curl -fsSL "$base_url/install/spawnd/$target.tar.gz" -o "$artifact_archive" ||
    die "current-target spawnd artifact is not downloadable for $target"
  tar -tzf "$artifact_archive" | grep -q 'spawnd/bin/spawnd$' ||
    die "spawnd artifact missing release wrapper"
  tar -tzf "$artifact_archive" | grep -q 'spawnd/spawnd_cli$' ||
    die "spawnd artifact missing CLI"
fi
"$release_bin" ping >/dev/null || die "installed daemon did not answer ping"
"$spawnd_bin" ping >/dev/null || die "installed wrapper did not answer ping"
status_out="$("$spawnd_bin" status)" || die "spawnd status failed"
grep -q 'logged in:  yes' <<<"$status_out" || die "spawnd status did not report login"
"$spawnd_bin" agents >/dev/null || die "spawnd agents failed"
"$spawnd_bin" update-check >/dev/null || die "spawnd update-check failed"
"$spawnd_bin" self-test >/dev/null || die "spawnd self-test failed"
missing_kill_out="$(mktemp)"
if "$spawnd_bin" kill 00000000-0000-0000-0000-00000000eeee >"$missing_kill_out"; then
  die "spawnd kill should fail for an unknown agent"
fi
grep -q '"ok":false' "$missing_kill_out" || die "spawnd kill failure did not return JSON"
rm -f "$missing_kill_out"

(
  cd server
  SPAWN_DATABASE_URL="$db_url" \
  SPAWN_USE_INPROCESS_PUBSUB="$pubsub" \
  SPAWN_SMOKE_BASE_URL="$base_url" \
  SPAWND_BIN="$spawnd_bin" \
  uv run python - <<'PY'
import asyncio
import base64
import json
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.parse import urlencode, urlparse

import httpx
import websockets
from sqlalchemy import select

from spawn_server import auth
from spawn_server.db import get_sessionmaker, init_engine
from spawn_server.models import Agent, Host, Preset

import os

BASE = os.environ["SPAWN_SMOKE_BASE_URL"].rstrip("/")
parsed = urlparse(BASE)
ws_scheme = "wss" if parsed.scheme == "https" else "ws"
WS_BASE = f"{ws_scheme}://{parsed.netloc}"
SPAWND_BIN = os.environ["SPAWND_BIN"]


async def issue_token_for_online_host() -> tuple[str, str, str]:
    init_engine()
    sm = get_sessionmaker()
    async with sm() as session:
        hosts = (
            await session.execute(select(Host).order_by(Host.last_seen_at.desc()))
        ).scalars().all()
        for host in hosts:
            if host.status == "online":
                return auth.issue_access_token(host.owner_user_id), host.id, host.name
    raise RuntimeError("no online host in local DB")


async def wait_agent(client: httpx.AsyncClient, agent_id: str, status: str, timeout: float = 8) -> dict:
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        response = await client.get(f"/api/agents/{agent_id}")
        response.raise_for_status()
        last = response.json()
        if last["status"] == status:
            return last
        await asyncio.sleep(0.2)
    raise AssertionError(f"agent {agent_id} did not reach {status}; last={last}")


async def wait_agent_in_statuses(
    client: httpx.AsyncClient, agent_id: str, statuses: set[str], timeout: float = 8
) -> dict:
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        response = await client.get(f"/api/agents/{agent_id}")
        response.raise_for_status()
        last = response.json()
        if last["status"] in statuses:
            return last
        await asyncio.sleep(0.2)
    raise AssertionError(f"agent {agent_id} did not reach one of {statuses}; last={last}")


async def wait_daemon_pid(
    client: httpx.AsyncClient,
    host_id: str,
    agent_id: str,
    old_pid: str | None = None,
    timeout: float = 8,
) -> str:
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        response = await client.get(f"/api/hosts/{host_id}/daemon")
        response.raise_for_status()
        last = response.json()
        matches = [a for a in last.get("agents", []) if a.get("agent_id") == agent_id]
        if matches:
            pid = matches[0].get("pid")
            if old_pid is None or pid != old_pid:
                return str(pid)
        await asyncio.sleep(0.2)
    raise AssertionError(f"daemon did not report desired pid; last={last}")


async def recv_until(ws, needle: str, timeout: float = 8) -> None:
    deadline = time.monotonic() + timeout
    seen_text: list[str] = []
    seen_bytes = bytearray()
    while time.monotonic() < deadline:
        msg = await asyncio.wait_for(ws.recv(), timeout=max(0.1, deadline - time.monotonic()))
        if isinstance(msg, bytes):
            seen_bytes.extend(msg)
            if needle in seen_bytes.decode("utf-8", "ignore"):
                return
            continue

        seen_text.append(msg)
        try:
            obj = json.loads(msg)
        except json.JSONDecodeError:
            obj = None
        if obj and obj.get("type") in {"history", "snapshot"}:
            decoded = base64.b64decode(obj.get("bytes_b64") or "").decode("utf-8", "ignore")
            if needle in decoded:
                return
        if needle in msg:
            return
    raise AssertionError(
        f"did not receive {needle!r}; bytes={bytes(seen_bytes)!r}; texts={seen_text[-5:]}"
    )


async def recv_text_type(ws, frame_type: str, timeout: float = 8) -> dict:
    deadline = time.monotonic() + timeout
    last: list[str] = []
    while time.monotonic() < deadline:
        msg = await asyncio.wait_for(ws.recv(), timeout=max(0.1, deadline - time.monotonic()))
        if isinstance(msg, bytes):
            continue
        last.append(msg)
        try:
            obj = json.loads(msg)
        except json.JSONDecodeError:
            continue
        if obj.get("type") == frame_type:
            return obj
    raise AssertionError(f"did not receive {frame_type}; last={last[-5:]}")


async def cleanup_agents(token: str, prefix: str) -> None:
    init_engine()
    sm = get_sessionmaker()
    async with sm() as session:
        rows = (
            await session.execute(select(Agent).where(Agent.name.like(f"{prefix}%")))
        ).scalars().all()
    async with httpx.AsyncClient(
        base_url=BASE,
        headers={"Authorization": f"Bearer {token}"},
        timeout=10,
    ) as client:
        for agent in rows:
            await client.delete(f"/api/agents/{agent.id}")


async def run_agent_smoke(token: str, host_id: str) -> None:
    name = f"spawn local smoke {int(time.time())}"
    cwd = tempfile.mkdtemp(prefix="spawn-local-smoke-")
    headers = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient(base_url=BASE, headers=headers, timeout=15) as client:
        script = 'printf "READY\\n"; while IFS= read -r line; do printf "ECHO:%s\\n" "$line"; done'
        response = await client.post(
            "/api/agents",
            json={
                "host_id": host_id,
                "cwd": cwd,
                "argv": ["/bin/sh", "-lc", script],
                "cols": 80,
                "rows": 24,
                "create_cwd": True,
                "name": name,
            },
        )
        response.raise_for_status()
        agent_id = response.json()["id"]
        try:
            await wait_agent(client, agent_id, "running")
            first_pid = await wait_daemon_pid(client, host_id, agent_id)
            qs = urlencode({"agent_id": agent_id, "token": token, "cols": 80, "rows": 24})
            async with websockets.connect(
                f"{WS_BASE}/ws/browser?{qs}",
                subprotocols=["spawn.v1"],
            ) as ws:
                await recv_until(ws, "READY")
                await ws.send(b"hello\n")
                await recv_until(ws, "ECHO:hello")

                payload1 = base64.b64encode(b"one\n").decode("ascii")
                payload2 = base64.b64encode(b"two\n").decode("ascii")
                for client_id, payload in (("upload-1", payload1), ("upload-2", payload2)):
                    await ws.send(
                        json.dumps(
                            {
                                "type": "upload",
                                "name": "note.txt",
                                "mime_type": "text/plain",
                                "bytes_b64": payload,
                                "destination": "cwd",
                                "paste": False,
                                "client_id": client_id,
                            }
                        )
                    )
                    saved = await recv_text_type(ws, "upload.saved")
                    assert saved["client_id"] == client_id, saved
                    assert Path(saved["path"]).exists(), saved

                await ws.send(json.dumps({"type": "snapshot", "lines": 100, "plain": True}))
                await recv_until(ws, "ECHO:hello")

            response = await client.post(
                f"/api/agents/{agent_id}/restart",
                json={"cols": 80, "rows": 24, "create_cwd": True},
            )
            response.raise_for_status()
            await wait_agent(client, agent_id, "running")
            await wait_daemon_pid(client, host_id, agent_id, old_pid=first_pid)

            agents_cli = subprocess.run(
                [SPAWND_BIN, "agents"],
                check=True,
                capture_output=True,
                text=True,
            )
            cli_status = json.loads(agents_cli.stdout)
            matches = [a for a in cli_status["agents"] if a["agent_id"] == agent_id]
            assert matches, cli_status

            kill_cli = subprocess.run(
                [SPAWND_BIN, "kill", agent_id],
                check=True,
                capture_output=True,
                text=True,
            )
            kill_status = json.loads(kill_cli.stdout)
            assert kill_status["ok"] is True, kill_status
            await wait_agent_in_statuses(client, agent_id, {"killed", "exited"})
        finally:
            await client.delete(f"/api/agents/{agent_id}")
            await cleanup_agents(token, name)


async def run_spawn_failure_smoke(token: str, host_id: str) -> None:
    name = f"spawn failure smoke {int(time.time())}"
    cwd = tempfile.mkdtemp(prefix="spawn-failure-smoke-")
    headers = {"Authorization": f"Bearer {token}"}
    missing = f"spawn-definitely-missing-{int(time.time())}"
    async with httpx.AsyncClient(base_url=BASE, headers=headers, timeout=15) as client:
        response = await client.post(
            "/api/agents",
            json={
                "host_id": host_id,
                "cwd": cwd,
                "argv": [missing],
                "cols": 80,
                "rows": 24,
                "create_cwd": True,
                "name": name,
            },
        )
        response.raise_for_status()
        agent_id = response.json()["id"]
        try:
            exited = await wait_agent(client, agent_id, "exited")
            assert exited["exit_code"] == 127, exited
            qs = urlencode({"agent_id": agent_id, "token": token, "cols": 80, "rows": 24})
            async with websockets.connect(
                f"{WS_BASE}/ws/browser?{qs}",
                subprotocols=["spawn.v1"],
            ) as ws:
                await recv_until(ws, "spawn: failed to launch agent")
                status = await recv_text_type(ws, "agent.status")
                assert status["status"] == "exited", status
        finally:
            await client.delete(f"/api/agents/{agent_id}")
            await cleanup_agents(token, name)


async def run_tool_smoke(token: str, host_id: str) -> None:
    headers = {"Authorization": f"Bearer {token}"}
    tool_dir = Path(tempfile.mkdtemp(prefix="spawn-local-tool-"))
    tool = tool_dir / "spawn-fake-tool"
    install = f"printf '#!/bin/sh\\necho spawn-fake-tool 1.0\\n' > {tool} && chmod +x {tool}"
    async with httpx.AsyncClient(base_url=BASE, headers=headers, timeout=30) as client:
        response = await client.post(
            "/api/presets",
            json={
                "name": f"spawn fake tool {int(time.time())}",
                "agent_kind": "fake",
                "default_argv": [str(tool)],
                "env_template": {},
                "install": install,
            },
        )
        response.raise_for_status()
        preset = response.json()
        try:
            response = await client.get(f"/api/hosts/{host_id}/tools")
            response.raise_for_status()
            tools = response.json()["tools"]
            by_name = {tool["preset_name"]: tool for tool in tools}
            for builtin in ["claude-code", "codex", "opencode", "aider-sonnet", "shell"]:
                assert builtin in by_name, by_name.keys()
            for tool_status in tools:
                if not tool_status["installed"]:
                    assert tool_status["path"] is None, tool_status
                    assert tool_status["version"] is None, tool_status
            before = next(t for t in tools if t["preset_id"] == preset["id"])
            assert before["installed"] is False, before

            for enabled in (True, False):
                response = await client.patch(
                    f"/api/hosts/{host_id}/tools/{preset['id']}/policy",
                    json={"auto_update": enabled},
                )
                response.raise_for_status()
                assert response.json()["auto_update"] is enabled

            response = await client.post(f"/api/hosts/{host_id}/tools/{preset['id']}/install")
            response.raise_for_status()
            result = response.json()
            assert result["success"] is True, result
            assert result["status"]["installed"] is True, result
            assert result["status"]["path"] == str(tool), result
        finally:
            await client.delete(f"/api/presets/{preset['id']}")
            try:
                tool.unlink()
            except FileNotFoundError:
                pass
            try:
                tool_dir.rmdir()
            except OSError:
                pass


async def run_builtin_preset_smoke(token: str, host_id: str) -> None:
    headers = {"Authorization": f"Bearer {token}"}
    fake_dir = Path(tempfile.mkdtemp(prefix="spawn-provider-bin-"))
    cwd = Path(tempfile.mkdtemp(prefix="spawn-provider-cwd-"))
    provider_names = ["claude-code", "codex", "opencode", "aider-sonnet"]
    command_by_preset = {
        "claude-code": "claude",
        "codex": "codex",
        "opencode": "opencode",
        "aider-sonnet": "aider",
    }
    for command in command_by_preset.values():
        script = fake_dir / command
        script.write_text(
            "#!/bin/sh\n"
            f"printf 'provider-smoke {command} %s\\n' \"$*\"\n"
            "sleep 3\n",
            encoding="utf-8",
        )
        script.chmod(0o755)

    base_path = os.environ.get("PATH", "")
    env = {"PATH": f"{fake_dir}:{base_path}"}

    async with httpx.AsyncClient(base_url=BASE, headers=headers, timeout=15) as client:
        response = await client.get("/api/presets")
        response.raise_for_status()
        presets = {preset["name"]: preset for preset in response.json()}
        for name in provider_names + ["shell"]:
            assert name in presets, presets.keys()

        created: list[str] = []
        try:
            for name in provider_names:
                response = await client.post(
                    "/api/agents",
                    json={
                        "host_id": host_id,
                        "preset_id": presets[name]["id"],
                        "cwd": str(cwd),
                        "env": env,
                        "cols": 80,
                        "rows": 24,
                        "create_cwd": True,
                        "name": f"spawn preset smoke {name} {int(time.time())}",
                    },
                )
                response.raise_for_status()
                agent_id = response.json()["id"]
                created.append(agent_id)
                await wait_agent(client, agent_id, "running")
                qs = urlencode({"agent_id": agent_id, "token": token, "cols": 80, "rows": 24})
                async with websockets.connect(
                    f"{WS_BASE}/ws/browser?{qs}",
                    subprotocols=["spawn.v1"],
                ) as ws:
                    await recv_until(ws, f"provider-smoke {command_by_preset[name]}")
                await wait_agent_in_statuses(client, agent_id, {"exited", "killed"}, timeout=8)

            response = await client.post(
                "/api/agents",
                json={
                    "host_id": host_id,
                    "preset_id": presets["shell"]["id"],
                    "cwd": str(cwd),
                    "env": {"PATH": base_path},
                    "cols": 80,
                    "rows": 24,
                    "create_cwd": True,
                    "name": f"spawn preset smoke shell {int(time.time())}",
                },
            )
            response.raise_for_status()
            shell_agent_id = response.json()["id"]
            created.append(shell_agent_id)
            await wait_agent(client, shell_agent_id, "running")
            agents_cli = subprocess.run(
                [SPAWND_BIN, "agents"],
                check=True,
                capture_output=True,
                text=True,
            )
            cli_status = json.loads(agents_cli.stdout)
            assert any(a["agent_id"] == shell_agent_id for a in cli_status["agents"]), cli_status
            subprocess.run([SPAWND_BIN, "kill", shell_agent_id], check=True, capture_output=True)
            await wait_agent_in_statuses(client, shell_agent_id, {"killed", "exited"})
        finally:
            for agent_id in created:
                await client.delete(f"/api/agents/{agent_id}")
            await cleanup_agents(token, "spawn preset smoke")
            for path in fake_dir.iterdir():
                path.unlink()
            fake_dir.rmdir()
            try:
                cwd.rmdir()
            except OSError:
                pass


async def main() -> None:
    token, host_id, host_name = await issue_token_for_online_host()
    await run_agent_smoke(token, host_id)
    await run_spawn_failure_smoke(token, host_id)
    await run_tool_smoke(token, host_id)
    await run_builtin_preset_smoke(token, host_id)
    print(json.dumps({"ok": True, "host": host_name, "host_id": host_id}))


asyncio.run(main())
PY
)

printf 'smoke-local: ok\n'
