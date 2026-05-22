#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/smoke-device-login.sh

Runs an isolated end-to-end smoke for the spawnd CLI device login flow:
  - creates a web user
  - starts `spawnd login` in a temp HOME/XDG_CONFIG_HOME
  - approves the printed device code through the API
  - verifies credentials are saved, status reports logged in, and logout clears
    the isolated credentials file

Environment:
  SPAWN_SMOKE_BASE_URL   Web/API origin. Default: http://localhost:3002
  SPAWN_SMOKE_DB_URL     Server DB URL. Default: sqlite+aiosqlite:///./data/spawn.db
  SPAWND_BIN             Installed spawnd wrapper. Default: ~/.local/bin/spawnd
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

die() {
  printf 'smoke-device-login: %s\n' "$*" >&2
  exit 1
}

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" ||
  die "run from inside the spawn repo"
cd "$repo_root"

base_url="${SPAWN_SMOKE_BASE_URL:-http://localhost:3002}"
db_url="${SPAWN_SMOKE_DB_URL:-sqlite+aiosqlite:///./data/spawn.db}"
spawnd_bin="${SPAWND_BIN:-$HOME/.local/bin/spawnd}"

[[ -x "$spawnd_bin" ]] || die "spawnd wrapper is not executable at $spawnd_bin"
curl -fsS "$base_url/install.sh" >/dev/null || die "$base_url/install.sh is not reachable"

(
  cd server
  SPAWN_SMOKE_BASE_URL="$base_url" \
  SPAWN_DATABASE_URL="$db_url" \
  SPAWND_BIN="$spawnd_bin" \
  uv run python - <<'PY'
import asyncio
import json
import os
import re
import secrets
import shutil
import subprocess
import tempfile
from pathlib import Path

import httpx
from sqlalchemy import delete

from spawn_server import auth
from spawn_server.db import get_sessionmaker, init_engine
from spawn_server.models import DeviceCode, Host, User


BASE = os.environ["SPAWN_SMOKE_BASE_URL"].rstrip("/")
SPAWND_BIN = os.environ["SPAWND_BIN"]
PASSWORD = "passpasspass"


async def read_line(stream: asyncio.StreamReader, timeout: float = 10) -> str:
    raw = await asyncio.wait_for(stream.readline(), timeout=timeout)
    if not raw:
        raise AssertionError("spawnd login exited before printing a device code")
    return raw.decode("utf-8", "replace").strip()


async def main() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="spawn-device-login-"))
    try:
        home = tmp / "home"
        xdg = tmp / "config"
        home.mkdir()
        xdg.mkdir()
        env = {
            **os.environ,
            "HOME": str(home),
            "XDG_CONFIG_HOME": str(xdg),
            "SHELL": os.environ.get("SHELL") or "/bin/sh",
            # Keep the isolated smoke away from any locally-running daemon's
            # control socket.
            "SPAWND_CONTROL_PORT": str(19000 + secrets.randbelow(1000)),
        }
        email = f"spawn-device-smoke-{secrets.token_hex(5)}@example.com"
        host_name = f"spawn-device-smoke-{secrets.token_hex(4)}"
        init_engine()
        sm = get_sessionmaker()
        async with sm() as session:
            user = User(email=email, password_hash=auth.hash_password(PASSWORD))
            session.add(user)
            await session.commit()
            await session.refresh(user)
            token = auth.issue_access_token(user.id)

        async with httpx.AsyncClient(base_url=BASE, timeout=15) as client:
            login = await asyncio.create_subprocess_exec(
                SPAWND_BIN,
                "--server",
                BASE,
                "login",
                "--host-name",
                host_name,
                "--no-run",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )
            assert login.stdout is not None
            first_line = await read_line(login.stdout)
            match = re.search(r"\b([A-Z2-9]{4}-[A-Z2-9]{4})\b", first_line)
            if not match:
                stderr = (await login.stderr.read()).decode("utf-8", "replace") if login.stderr else ""
                raise AssertionError(f"could not parse device code from {first_line!r}; stderr={stderr!r}")
            user_code = match.group(1)

            approved = await client.post(
                "/api/auth/device/approve",
                json={"user_code": user_code},
                headers={"Authorization": f"Bearer {token}"},
            )
            approved.raise_for_status()
            assert approved.json()["host_name"] == host_name

            stdout, stderr = await asyncio.wait_for(login.communicate(), timeout=20)
            if login.returncode != 0:
                raise AssertionError(
                    f"spawnd login failed rc={login.returncode} "
                    f"stdout={stdout.decode('utf-8', 'replace')!r} "
                    f"stderr={stderr.decode('utf-8', 'replace')!r}"
                )
            login_output = (first_line + "\n" + stdout.decode("utf-8", "replace")).strip()
            host_match = re.search(r"host_id ([0-9a-f-]{36})", login_output)
            if not host_match:
                raise AssertionError(f"login output did not include host_id: {login_output!r}")
            host_id = host_match.group(1)

            creds_path = xdg / "spawn" / "credentials.json"
            creds = json.loads(creds_path.read_text(encoding="utf-8"))
            assert creds["host_id"] == host_id
            assert creds["server_url"] == BASE
            assert creds["access_token"]

            hosts = await client.get("/api/hosts", headers={"Authorization": f"Bearer {token}"})
            hosts.raise_for_status()
            matching = [host for host in hosts.json() if host["id"] == host_id]
            assert matching and matching[0]["name"] == host_name
            deleted = await client.delete(
                f"/api/hosts/{host_id}",
                headers={"Authorization": f"Bearer {token}"},
            )
            deleted.raise_for_status()

        status = subprocess.run(
            [SPAWND_BIN, "--server", BASE, "status"],
            env=env,
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        assert f"configured: {BASE}" in status, status
        assert "logged in:  yes" in status, status
        assert f"host_id:    {host_id}" in status, status

        subprocess.run(
            [SPAWND_BIN, "logout"],
            env=env,
            check=True,
            capture_output=True,
            text=True,
        )
        assert not creds_path.exists()
        print(json.dumps({"ok": True, "host_id": host_id, "host_name": host_name}))
    finally:
        try:
            sm = get_sessionmaker()
            async with sm() as session:
                await session.execute(delete(Host).where(Host.name == host_name))
                await session.execute(delete(DeviceCode).where(DeviceCode.host_name == host_name))
                await session.execute(delete(User).where(User.email == email))
                await session.commit()
        except Exception:
            pass
        shutil.rmtree(tmp, ignore_errors=True)


asyncio.run(main())
PY
)

printf 'smoke-device-login: ok\n'
