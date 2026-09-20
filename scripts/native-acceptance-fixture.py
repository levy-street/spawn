#!/usr/bin/env python3
"""Disposable native acceptance API/daemon; never imported by the product server."""

from __future__ import annotations

import argparse
import asyncio
import base64
import hmac
import hashlib
import json
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from contextlib import nullcontext
from collections import deque
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
MAX_EVENTS = 20000
MAX_LIFECYCLE_EVENTS = 32
PROVISION_TIMEOUT_SECONDS = 75
CONTROL_TRACE_PATHS = frozenset(
    {
        "config",
        "start",
        "status",
        "health",
        "bootstrap",
        "device",
        "event",
        "command",
        "native-command",
    }
)


def encoded(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def write_json(path: Path, value: Any, *, private: bool = False) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    if private:
        temporary.chmod(0o600)
    temporary.replace(path)


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class ApiRequestTrace:
    """Bounded response metadata, without credentials or request content."""

    def __init__(self, app: Any, output: Path) -> None:
        self.app = app
        self.output = output
        self.count = 0

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def observe(message: Any) -> None:
            if message["type"] == "http.response.start" and self.count < MAX_EVENTS:
                # The router template excludes path parameters as well as the
                # query string. Never copy raw request URLs, headers or bodies.
                route = getattr(scope.get("route"), "path", "")
                control_path = scope.get("path_params", {}).get("path")
                is_control = (
                    route == "/__acceptance/{path}"
                    and control_path in CONTROL_TRACE_PATHS
                )
                if route.startswith("/api/") or is_control:
                    headers = dict(scope.get("headers", []))
                    method = scope.get("method")
                    record = {
                        "at": datetime.now(UTC).isoformat(),
                        "monotonic": time.monotonic(),
                        "route": route,
                        "method": method
                        if method
                        in {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}
                        else "OTHER",
                        "status": message["status"],
                        "has_bearer": headers.get(b"authorization", b"")
                        .lower()
                        .startswith(b"bearer "),
                        "has_client_id": b"x-spawn-client" in headers,
                    }
                    if is_control:
                        # Only known control names, never arbitrary path values.
                        # A refused initial bootstrap cannot report its own error
                        # over this same channel, so retain its response status.
                        record["control"] = control_path
                        record["has_control_token"] = b"x-acceptance-token" in headers
                    self.count += 1
                    with self.output.open("a") as log:
                        log.write(json.dumps(record) + "\n")
            await send(message)

        await self.app(scope, receive, observe)


class Fixture:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.scratch = Path(tempfile.mkdtemp(prefix="sna-", dir="/tmp"))
        self.output = args.output.resolve()
        self.output.mkdir(parents=True, exist_ok=True)
        self.token = secrets.token_urlsafe(32)
        self.run_id = str(uuid.uuid4())
        self.candidate = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
        ).strip()
        self.source_clean = (
            subprocess.run(
                ["git", "diff", "--quiet", "HEAD"], cwd=ROOT, check=False
            ).returncode
            == 0
        )
        self.origin = f"http://127.0.0.1:{args.port}"
        self.client_origin = f"http://{args.client_host}:{args.port}"
        self.children: list[asyncio.subprocess.Process] = []
        self.logs: list[Any] = []
        self.events: list[dict[str, Any]] = []
        self.commands: deque[dict[str, Any]] = deque()
        self.native_commands: deque[dict[str, Any]] = deque()
        self.results: dict[str, dict[str, Any]] = {}
        self.bootstrap: dict[str, Any] | None = None
        self.sessions: list[str] = []
        self.device_ids: set[str] = set()
        self.user_token = ""
        self.account_id = ""
        self.second_account_id = ""
        self.proxy: asyncio.subprocess.Process | None = None
        self.proxy_lock = asyncio.Lock()
        self.turn_servers: list[dict[str, Any]] = []
        self.client_ice: list[dict[str, Any]] = []
        self.closed = asyncio.Event()
        self.failed: str | None = None
        self.phase = "preparing"
        self.failure_event = asyncio.Event()
        self.provision_task: asyncio.Task[None] | None = None
        self.child_watchers: list[asyncio.Task[None]] = []
        self.child_names: dict[int, str] = {}
        self.closing = False
        self.lifecycle_events = 0
        self.binary_identity: dict[str, Any] = {}
        self.binary_dir = self.scratch / "bin"
        self.daemon: asyncio.subprocess.Process | None = None

    def status(self) -> dict[str, Any]:
        self.check_children()
        return {
            "runId": self.run_id,
            "candidateCommit": self.candidate,
            "phase": self.phase,
            "ready": self.phase == "ready" and self.failed is None,
            "failure_reason": self.failed,
            "events": len(self.events),
            "children": [
                {
                    "name": self.child_names[child.pid],
                    "pid": child.pid,
                    "returncode": child.returncode,
                }
                for child in self.children
            ],
        }

    def configuration(self) -> dict[str, Any]:
        # Build-time configuration contains no account or daemon bearer token.
        return {
            "runId": self.run_id,
            "candidateCommit": self.candidate,
            "apiUrl": self.client_origin,
            "iceServers": self.client_ice,
            "forceRelay": self.args.transport == "relay",
        }

    def lifecycle(self, event: str, **fields: Any) -> None:
        if self.lifecycle_events >= MAX_LIFECYCLE_EVENTS:
            return
        self.lifecycle_events += 1
        row = {"at": datetime.now(UTC).isoformat(), "event": event, **fields}
        with (self.output / "fixture-lifecycle.jsonl").open("a") as log:
            log.write(json.dumps(row) + "\n")
        print("native-acceptance: " + json.dumps(row), flush=True)

    def fail(self, reason: str) -> None:
        # Callers supply fixed diagnostics or an exception class, never raw
        # HTTP bodies, command lines, environment values or credential errors.
        if self.failed is not None:
            return
        self.failed = reason
        self.phase = "failed"
        self.failure_event.set()
        self.lifecycle("failed", failure_reason=reason)
        path = self.output / "evidence.json"
        report = (
            json.loads(path.read_text())
            if path.exists()
            else {
                "schema_version": 1,
                "suite": "native_connections",
                "candidate_commit": self.candidate,
                "baseline_commit": getattr(self.args, "baseline", "0" * 40),
                "source_clean": self.source_clean,
                "physical_device": False,
                "started_at": datetime.now(UTC).isoformat(),
                "cases": [],
                "binaries": self.binary_identity,
            }
        )
        report.update(
            status="failed",
            failure_reason=reason,
            completed_at=datetime.now(UTC).isoformat(),
        )
        write_json(path, report)

    def check_children(self) -> None:
        if self.closing:
            return
        for process in self.children:
            if process.returncode is not None:
                name = self.child_names[process.pid]
                self.fail(
                    f"fixture {name} exited unexpectedly (code {process.returncode})"
                )

    def raise_if_failed(self) -> None:
        self.check_children()
        if self.failed is not None:
            raise RuntimeError(self.failed)

    def watch_child(self, process: asyncio.subprocess.Process, name: str) -> None:
        self.child_names[process.pid] = name

        async def watch() -> None:
            await process.wait()
            self.check_children()

        self.child_watchers.append(asyncio.create_task(watch()))

    async def prepare_binaries(self) -> None:
        self.binary_dir.mkdir()

        def copy_pair() -> None:
            for name in ("spawnd", "spawn-worker"):
                source = self.args.daemon.resolve().parent / name
                target = self.binary_dir / name
                shutil.copy2(source, target)
                version = subprocess.check_output(
                    [str(target), "--version"], text=True, timeout=10
                ).strip()
                with target.open("rb") as executable:
                    digest = hashlib.file_digest(executable, "sha256").hexdigest()
                self.binary_identity[name] = {
                    "version": version,
                    "sha256": digest,
                    "candidate_match": f"+g{self.candidate[:12]}" in version,
                }

        await asyncio.to_thread(copy_pair)
        write_json(self.output / "native-binaries.json", self.binary_identity)

    def start_provisioning(self) -> dict[str, Any]:
        # No await between the state check and task assignment: simultaneous
        # POSTs cannot create another account, daemon or set of sessions.
        self.raise_if_failed()
        if self.phase == "prepared" and self.provision_task is None:
            self.phase = "starting"
            self.lifecycle("starting")
            self.provision_task = asyncio.create_task(self.provision_and_verify())
        return self.status()

    async def provision_and_verify(self) -> None:
        try:
            async with asyncio.timeout(PROVISION_TIMEOUT_SECONDS):
                await self.provision()
                while not await self.runtime_ready():
                    self.raise_if_failed()
                    await asyncio.sleep(0.1)
                self.raise_if_failed()
            self.phase = "ready"
            self.lifecycle("ready")
        except Exception as error:
            self.fail(f"fixture provisioning failed ({type(error).__name__})")

    async def runtime_ready(self) -> bool:
        self.raise_if_failed()
        if self.daemon is None or len(self.sessions) != 2:
            return False
        host = await self.request("GET", f"/api/hosts/{self.host_id}")
        if host.get("status") != "online":
            return False
        for label, session_id in zip(("a", "b"), self.sessions, strict=True):
            session = await self.request("GET", f"/api/sessions/{session_id}")
            if (
                session.get("status") != "running"
                or session.get("host_id") != self.host_id
            ):
                return False
            pid_file = self.cwd / label / "shell.pid"
            if (
                not pid_file.is_file()
                or not (self.workers / f"{session_id}.sock").exists()
            ):
                return False
            try:
                os.kill(int(pid_file.read_text()), 0)
            except (ValueError, OSError):
                return False
        self.raise_if_failed()
        return True

    async def health(self) -> dict[str, Any]:
        self.raise_if_failed()
        if self.phase != "ready":
            raise RuntimeError("fixture is not ready")
        try:
            ready = await asyncio.wait_for(self.runtime_ready(), 15)
        except Exception as error:
            self.fail(f"fixture health check failed ({type(error).__name__})")
        else:
            if not ready:
                self.fail("fixture host or session readiness was lost")
        self.raise_if_failed()
        return self.status()

    async def child(
        self, argv: list[str], name: str, **kwargs: Any
    ) -> asyncio.subprocess.Process:
        log = (self.output / f"{name}.log").open("ab")
        self.logs.append(log)
        process = await asyncio.create_subprocess_exec(
            *argv, stdout=log, stderr=log, start_new_session=True, **kwargs
        )
        self.children.append(process)
        self.watch_child(process, name)
        return process

    async def start_turn(self) -> None:
        if self.args.transport != "relay":
            return
        turnserver = shutil.which("turnserver")
        if turnserver is None:
            raise RuntimeError("relay acceptance requires coturn's turnserver")
        port = free_port()
        # An ephemeral listener and loopback-only relay constrain all effects
        # to these disposable processes. No system firewall or TURN is edited.
        username, password = "acceptance", secrets.token_urlsafe(24)
        config = self.scratch / "turn.conf"
        config.write_text(
            "\n".join(
                [
                    "listening-ip=127.0.0.1",
                    "relay-ip=127.0.0.1",
                    f"listening-port={port}",
                    "realm=acceptance.localhost",
                    "lt-cred-mech",
                    f"user={username}:{password}",
                    "fingerprint",
                    "no-tcp",
                    "no-tls",
                    "no-dtls",
                    "no-cli",
                    "allow-loopback-peers",
                    "no-multicast-peers",
                    "denied-peer-ip=0.0.0.0-126.255.255.255",
                    "denied-peer-ip=128.0.0.0-255.255.255.255",
                    "allowed-peer-ip=127.0.0.1",
                    "no-software-attribute",
                    f"userdb={self.scratch / 'turn.sqlite'}",
                    f"pidfile={self.scratch / 'turn.pid'}",
                    "log-file=stdout",
                ]
            )
            + "\n"
        )
        config.chmod(0o600)
        turn = await self.child([turnserver, "-c", str(config)], "turn")
        await asyncio.sleep(0.5)
        if turn.returncode is not None:
            raise RuntimeError("disposable coturn failed to start")
        self.proxy = await asyncio.create_subprocess_exec(
            sys.executable,
            str(ROOT / "scripts/udp-chaos-proxy.py"),
            "--listen",
            "127.0.0.1:0",
            "--upstream",
            f"127.0.0.1:{port}",
            "--seed",
            "87",
            "--max-runtime-seconds",
            str(self.args.timeout),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        self.children.append(self.proxy)
        self.watch_child(self.proxy, "UDP proxy")
        assert self.proxy.stdout is not None
        ready = json.loads(await asyncio.wait_for(self.proxy.stdout.readline(), 10))
        if ready.get("event") != "ready":
            raise RuntimeError("UDP proxy did not report readiness")
        write_json(self.output / "udp-proxy.json", ready)
        proxy_port = ready["listen"]["port"]
        self.turn_servers = [
            {
                "urls": f"turn:127.0.0.1:{port}?transport=udp",
                "username": username,
                "credential": password,
            }
        ]
        self.client_ice = [
            {
                **self.turn_servers[0],
                "urls": f"turn:{self.args.client_host}:{proxy_port}?transport=udp",
            }
        ]

    async def proxy_command(self, command: dict[str, Any]) -> dict[str, Any]:
        if self.proxy is None or self.proxy.returncode is not None:
            raise RuntimeError("UDP fault proxy is unavailable")
        assert self.proxy.stdin is not None and self.proxy.stdout is not None
        async with self.proxy_lock:
            command = {**command, "id": str(uuid.uuid4())}
            self.proxy.stdin.write((json.dumps(command) + "\n").encode())
            await self.proxy.stdin.drain()
            reply = json.loads(await asyncio.wait_for(self.proxy.stdout.readline(), 10))
            if reply.get("id") != command["id"] or reply.get("ok") is not True:
                raise RuntimeError(f"UDP proxy rejected command: {reply}")
            return reply["status"]

    async def request(
        self, method: str, path: str, body: Any = None, *, token: str | None = None
    ) -> Any:
        import httpx

        if token is None and self.account_id:
            self.user_token = await self.account_token(self.account_id)
        async with httpx.AsyncClient(
            base_url=self.origin, timeout=15, trust_env=False
        ) as client:
            response = await client.request(
                method,
                path,
                json=body,
                headers={"Authorization": f"Bearer {token or self.user_token}"},
            )
            response.raise_for_status()
            return response.json() if response.content else None

    async def account_token(self, account_id: str) -> str:
        from spawn_server import auth
        from spawn_server.db import get_sessionmaker
        from spawn_server.models import User

        if account_id not in {self.account_id, self.second_account_id}:
            raise ValueError("token requested outside disposable fixture accounts")
        async with get_sessionmaker()() as session:
            user = await session.get(User, account_id)
            if user is None:
                raise ValueError("fixture account is absent")
            return auth.issue_access_token(user.id, user.session_epoch)

    async def bootstrap_state(self) -> dict[str, Any]:
        self.raise_if_failed()
        if self.phase != "ready" or self.bootstrap is None:
            raise ValueError("fixture not ready")
        return {
            **self.bootstrap,
            "bearerToken": await self.account_token(self.account_id),
            "secondAccount": {
                "accountId": self.second_account_id,
                "bearerToken": await self.account_token(self.second_account_id),
            },
        }

    async def provision(self) -> None:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from spawn_server import auth
        from spawn_server.browser_registration import (
            encode_browser_registration_transcript,
        )
        from spawn_server.db import get_sessionmaker
        from spawn_server.host_identity import (
            decode_ed25519_public_key,
            ed25519_key_fingerprint,
        )
        from spawn_server.host_pair_approval import (
            decode_approval_nonce,
            encode_host_pair_approval_transcript,
        )
        from spawn_server.host_pair_possession import (
            decode_device_code,
            encode_host_pair_possession_transcript,
        )
        from spawn_server.models import User

        async with get_sessionmaker()() as session:
            user = User(
                email=f"native-{self.run_id}@example.com",
                is_admin=True,
                password_hash=auth.hash_password(secrets.token_urlsafe(24)),
                email_verified_at=datetime.now(UTC),
            )
            session.add(user)
            await session.commit()
            await session.refresh(user)
            self.account_id = user.id
            self.user_token = auth.issue_access_token(user.id, user.session_epoch)
            second_user = User(
                email=f"native-second-{self.run_id}@example.com",
                password_hash=auth.hash_password(secrets.token_urlsafe(24)),
                email_verified_at=datetime.now(UTC),
            )
            session.add(second_user)
            await session.commit()
            await session.refresh(second_user)
            self.second_account_id = second_user.id

        host_key = Ed25519PrivateKey.generate()
        host_public = host_key.public_key().public_bytes_raw()
        binding = {
            "host_key_algorithm": "ed25519",
            "host_public_key": encoded(host_public),
        }
        start = await self.request(
            "POST",
            "/api/auth/device/start",
            {
                "host_name": "Native acceptance",
                "os": sys.platform,
                "arch": "acceptance",
                "version": "acceptance",
                **binding,
            },
        )
        possession = encode_host_pair_possession_transcript(
            decode_device_code(start["device_code"]),
            decode_approval_nonce(start["approval_nonce"]),
            host_public,
        )
        await self.request(
            "POST",
            "/api/auth/device/possession",
            {
                "device_code": start["device_code"],
                "approval_nonce": start["approval_nonce"],
                **binding,
                "signature": encoded(host_key.sign(possession)),
            },
        )
        reviewed = await self.request(
            "POST", "/api/auth/device/pending", {"user_code": start["user_code"]}
        )
        self.anchor_key = Ed25519PrivateKey.generate()
        anchor_public = self.anchor_key.public_key().public_bytes_raw()
        registration = encode_browser_registration_transcript(
            self.account_id, anchor_public, is_root=False
        )
        self.anchor = await self.request(
            "POST",
            "/api/browser-devices/register",
            {
                "key_algorithm": "ed25519",
                "public_key": encoded(anchor_public),
                "signature": encoded(self.anchor_key.sign(registration)),
            },
        )
        approval = encode_host_pair_approval_transcript(
            self.account_id,
            decode_approval_nonce(reviewed["approval_nonce"]),
            decode_ed25519_public_key(reviewed["host_public_key"]),
            anchor_public,
        )
        await self.request(
            "POST",
            "/api/auth/device/approve",
            {
                "user_code": start["user_code"],
                "approval_nonce": reviewed["approval_nonce"],
                **binding,
                "host_key_fingerprint": reviewed["host_key_fingerprint"],
                "browser_device_id": self.anchor["id"],
                "browser_key_algorithm": "ed25519",
                "browser_public_key": self.anchor["public_key"],
                "browser_key_fingerprint": ed25519_key_fingerprint(
                    self.anchor["public_key"]
                ),
                "signature": encoded(self.anchor_key.sign(approval)),
            },
        )
        poll = await self.request(
            "POST",
            "/api/auth/device/poll",
            {"device_code": start["device_code"], **binding},
        )
        self.host_id = poll["host_id"]
        config_dir = self.scratch / "config"
        config_dir.mkdir(mode=0o700)
        credentials = {
            "credential_record_version": 1,
            "credential_generation": 1,
            "credential_record_id": str(uuid.uuid4()),
            "access_token": poll["access_token"],
            "host_id": self.host_id,
            "server_url": self.origin,
            "host_private_key_seed": encoded(host_key.private_bytes_raw()),
            "browser_pins": [
                {
                    key: poll[key]
                    for key in (
                        "browser_device_id",
                        "browser_key_algorithm",
                        "browser_public_key",
                        "browser_key_fingerprint",
                    )
                }
            ],
        }
        write_json(config_dir / "credentials.json", credentials, private=True)
        # Never repoint or reset a real user's install. The fixture binary is
        # not installed; explicit config/worker paths own every runtime file.
        self.cwd = self.scratch / "sessions"
        self.cwd.mkdir()
        self.workers = self.scratch / "w"
        self.workers.mkdir(mode=0o700)
        shell = self.scratch / "shell"
        shell.write_text(
            '#!/bin/sh\ncase "${1:-}" in -ic|-lc|-c) exec /bin/sh "$@";; esac\n'
            "printf '%s\\n' $$ > shell.pid\nprintf 'native-ready\\n'\n"
            "while IFS= read -r line; do printf '%s\\n' \"$line\" >> received.txt; "
            "printf 'native-echo:%s\\n' \"$line\"; done\n"
        )
        shell.chmod(0o700)
        daemon_env = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith(("SPAWN_", "SPAWND_"))
        }
        daemon_env.update(
            {
                "SPAWN_CONFIG_DIR": str(config_dir),
                "SPAWN_DISABLE_KEYRING": "1",
                "SPAWND_WORKER_DIR": str(self.workers),
                "SPAWND_NO_SELF_UPDATE": "1",
                "SPAWND_NO_PERMISSION_PRIME": "1",
                "SHELL": str(shell),
                "NO_COLOR": "1",
            }
        )
        self.daemon = await self.child(
            [str(self.binary_dir / "spawnd"), "--server", self.origin, "run"],
            "daemon",
            env=daemon_env,
            cwd=self.scratch,
        )
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            self.raise_if_failed()
            host = await self.request("GET", f"/api/hosts/{self.host_id}")
            if host["status"] == "online":
                break
            if self.daemon.returncode is not None:
                raise RuntimeError("fixture daemon exited")
            await asyncio.sleep(0.1)
        else:
            raise RuntimeError("fixture daemon never registered")
        for label in ("a", "b"):
            cwd = self.cwd / label
            cwd.mkdir()
            created = await self.request(
                "POST",
                "/api/workspaces",
                {
                    "name": f"Native acceptance {label}",
                    "first_session": {"host_id": self.host_id, "cwd": str(cwd)},
                },
            )
            self.sessions.append(created["session"]["id"])
            if label == "a":
                workspace_id = created["workspace"]["id"]
        self.bootstrap = {
            "runId": self.run_id,
            "candidateCommit": self.candidate,
            "accountId": self.account_id,
            "bearerToken": self.user_token,
            "hostId": self.host_id,
            "hostPublicKey": encoded(host_public),
            "sessionA": self.sessions[0],
            "sessionB": self.sessions[1],
            "workspaceId": workspace_id,
            "cwd": str(self.cwd),
            "iceServers": self.client_ice,
            "forceRelay": self.args.transport == "relay",
        }

    async def endorse_device(self, device_id: str, public_key: str) -> None:
        from spawn_server.acct_endorsement import encode_acct_endorsement_transcript
        from spawn_server.host_identity import decode_ed25519_public_key

        devices = await self.request("GET", "/api/browser-devices")
        device = next((row for row in devices if row["id"] == device_id), None)
        if (
            not device
            or device["public_key"] != public_key
            or device["revoked_at"] is not None
        ):
            raise ValueError(
                "device is not a live registered key of this fixture account"
            )
        if device_id in self.device_ids:
            return
        transcript = encode_acct_endorsement_transcript(
            self.account_id,
            self.anchor_key.public_key().public_bytes_raw(),
            decode_ed25519_public_key(public_key),
            device_id,
        )
        await self.request(
            "POST",
            "/api/trust/account-endorsements",
            {
                "endorser_device_id": self.anchor["id"],
                "endorsed_device_id": device_id,
                "signature": encoded(self.anchor_key.sign(transcript)),
            },
        )
        self.device_ids.add(device_id)

    def record(self, body: dict[str, Any]) -> None:
        if not isinstance(body, dict) or not isinstance(body.get("type"), str):
            raise ValueError("native acceptance event must be an object with a type")
        if len(self.events) >= MAX_EVENTS:
            raise ValueError("native acceptance event limit exceeded")
        if len(json.dumps(body)) > 65536:
            raise ValueError("native acceptance event exceeds 64 KiB")
        event = {
            **body,
            "at": datetime.now(UTC).isoformat(),
            "monotonic": time.monotonic(),
        }
        self.events.append(event)
        with (self.output / "events.jsonl").open("a") as log:
            log.write(json.dumps(event) + "\n")
        if body.get("commandId") and body.get("type") in {"command", "native-command"}:
            self.results[body["commandId"]] = event

    async def command(
        self,
        action: str,
        payload: dict[str, Any] | None = None,
        *,
        native: bool = False,
        timeout: float = 90,
    ) -> dict[str, Any]:
        self.raise_if_failed()
        command = {"id": str(uuid.uuid4()), "action": action, "payload": payload or {}}
        (self.native_commands if native else self.commands).append(command)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.raise_if_failed()
            result = self.results.pop(command["id"], None)
            if result:
                if result.get("status") != "passed":
                    raise RuntimeError(f"{action} failed: {result.get('details')}")
                details = result.get("details") or {}
                if not native and details.get("candidate_commit") != self.candidate:
                    raise RuntimeError("native app reports the wrong candidate commit")
                values = details.get("values", details)
                return values.get("result", values)
            await asyncio.sleep(0.1)
        raise TimeoutError(f"native acceptance command timed out: {action}")

    async def close(self) -> None:
        self.closing = True
        if self.provision_task is not None and not self.provision_task.done():
            self.provision_task.cancel()
            await asyncio.gather(self.provision_task, return_exceptions=True)
        for session in self.sessions:
            try:
                await self.request("DELETE", f"/api/sessions/{session}")
            except Exception:
                pass
        if hasattr(self, "workers"):
            deadline = time.monotonic() + 5
            while list(self.workers.glob("*.sock")) and time.monotonic() < deadline:
                await asyncio.sleep(0.1)
        for child in reversed(self.children):
            if child.returncode is None:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                    await asyncio.wait_for(child.wait(), 10)
                except (ProcessLookupError, TimeoutError):
                    if child.returncode is None:
                        os.killpg(child.pid, signal.SIGKILL)
                        await child.wait()
        # Workers deliberately survive supervisor death. Restrict cleanup to
        # command lines carrying this fixture's unique socket directory.
        if hasattr(self, "workers"):

            def owned_workers() -> list[int]:
                listing = subprocess.check_output(
                    ["ps", "-eo", "pid=,args="], text=True
                )
                return [
                    int(row.strip().split(None, 1)[0])
                    for row in listing.splitlines()
                    if f"--socket {self.workers}/" in row and "spawn-worker " in row
                ]

            for sig in (signal.SIGTERM, signal.SIGKILL):
                for pid in owned_workers():
                    try:
                        os.kill(pid, sig)
                    except ProcessLookupError:
                        pass
                deadline = time.monotonic() + 3
                while owned_workers() and time.monotonic() < deadline:
                    await asyncio.sleep(0.1)
            if owned_workers():
                raise RuntimeError("fixture worker cleanup failed")
        for log in self.logs:
            log.close()
        await asyncio.gather(*self.child_watchers, return_exceptions=True)
        self.closed.set()


async def finish_cleanup(fixture: Fixture, server: Any, server_task: Any) -> None:
    async def cleanup() -> None:
        cleanup_error = None
        try:
            await fixture.close()
        except Exception as error:
            cleanup_error = error
        finally:
            if server is not None:
                server.should_exit = True
            if server_task is not None:
                await server_task
            # Finish disconnect writes before deleting this fixture's database.
            shutil.rmtree(fixture.scratch)
            evidence_path = fixture.output / "evidence.json"
            if evidence_path.exists():
                evidence = json.loads(evidence_path.read_text())
                evidence["cleanup_passed"] = cleanup_error is None
                if cleanup_error is not None:
                    evidence.update(
                        status="failed", failure_reason=f"cleanup: {cleanup_error}"
                    )
                write_json(evidence_path, evidence)
        if cleanup_error is not None:
            raise cleanup_error

    # The runner can finish collecting evidence while automatic cleanup is still
    # stopping workers. Its subsequent SIGTERM must not interrupt that cleanup or
    # leave a passed report without proof that the fixture was removed.
    cleanup_task = asyncio.create_task(cleanup())
    interrupted = False
    while not cleanup_task.done():
        try:
            await asyncio.shield(cleanup_task)
        except asyncio.CancelledError:
            interrupted = True
    cleanup_task.result()
    if interrupted:
        raise asyncio.CancelledError


async def run(args: argparse.Namespace) -> None:
    if args.client_host not in {"127.0.0.1", "10.0.2.2"}:
        raise ValueError(
            "native acceptance only permits loopback or the Android host alias"
        )
    fixture = Fixture(args)
    server = None
    task = None
    try:
        # The ready-file permits Android to clean Cargo outputs. Private copies
        # and their hashes must exist before that file is published.
        await fixture.prepare_binaries()
        await fixture.start_turn()
        # Import configuration only after isolating it from ambient .env files.
        for key in list(os.environ):
            if key.startswith(("SPAWN_", "SPAWND_")):
                del os.environ[key]
        os.environ.update(
            {
                "SPAWN_DATABASE_URL": f"sqlite+aiosqlite:///{fixture.scratch / 'fixture.db'}",
                "SPAWN_USE_INPROCESS_PUBSUB": "1",
                "SPAWN_JWT_SECRET": secrets.token_urlsafe(40),
                "SPAWN_PUBLIC_URL": fixture.origin,
                "SPAWN_DAEMON_AUTO_UPDATE": "0",
                "SPAWN_PREBUILT_DIR": str(fixture.scratch / "no-prebuilts"),
                "SPAWN_WEBRTC_ENABLED": "1",
                "SPAWN_PUSH_ENABLED": "0",
                "SPAWN_TURN_URLS": "",
                "SPAWN_TURN_SECRET": "",
                "SPAWN_WEBRTC_ICE_SERVERS": json.dumps(fixture.turn_servers),
                "SPAWN_SIGNUP_INVITE_ONLY": "0",
                "SPAWN_EMAIL_REQUIRE_VERIFICATION": "0",
            }
        )
        os.chdir(fixture.scratch)
        sys.path.insert(0, str(ROOT / "server"))
        import uvicorn
        from fastapi import HTTPException, Request
        from fastapi.responses import JSONResponse
        from spawn_server.config import get_settings
        from spawn_server.db import Base, dispose_engine, init_engine
        from spawn_server.main import create_app

        get_settings.cache_clear()
        engine = init_engine()
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        await dispose_engine()
        app = create_app()

        async def control(request: Request, path: str) -> Any:
            if not hmac.compare_digest(
                request.headers.get("x-acceptance-token", ""), fixture.token
            ):
                raise HTTPException(403, "fixture token required")
            if path == "config" and request.method == "GET":
                return fixture.configuration()
            if path == "start" and request.method == "POST":
                try:
                    return fixture.start_provisioning()
                except RuntimeError:
                    return JSONResponse(status_code=503, content=fixture.status())
            if path == "health" and request.method == "GET":
                try:
                    return await fixture.health()
                except RuntimeError:
                    return JSONResponse(status_code=503, content=fixture.status())
            if path == "bootstrap" and request.method == "GET":
                if not fixture.status()["ready"]:
                    return JSONResponse(status_code=503, content=fixture.status())
                return await fixture.bootstrap_state()
            if path in {"command", "native-command"} and request.method == "GET":
                queue = (
                    fixture.native_commands
                    if path == "native-command"
                    else fixture.commands
                )
                return queue.popleft() if queue else None
            if path == "event" and request.method == "POST":
                try:
                    fixture.record(await request.json())
                except ValueError as error:
                    raise HTTPException(400, str(error)) from error
                return {"ok": True}
            if path == "device" and request.method == "POST":
                if not fixture.status()["ready"]:
                    return JSONResponse(status_code=503, content=fixture.status())
                body = await request.json()
                try:
                    await fixture.endorse_device(body["deviceId"], body["publicKey"])
                except (ValueError, KeyError, TypeError) as error:
                    raise HTTPException(
                        400, "invalid fixture device endorsement"
                    ) from error
                return {"approved": True}
            if path == "status" and request.method == "GET":
                return fixture.status()
            raise HTTPException(404)

        # Request's concrete annotation must remain resolvable with postponed
        # annotations; this module is also imported by focused unit tests.
        control.__annotations__["request"] = Request
        app.add_api_route("/__acceptance/{path}", control, methods=["GET", "POST"])

        class FixtureServer(uvicorn.Server):
            def capture_signals(self):
                # The fixture owns shutdown, including worker/relay cleanup.
                return nullcontext()

        server = FixtureServer(
            uvicorn.Config(
                ApiRequestTrace(app, fixture.output / "api-requests.jsonl"),
                host="127.0.0.1",
                port=args.port,
                log_level="warning",
                access_log=False,
                timeout_graceful_shutdown=10,
            )
        )
        task = asyncio.create_task(server.serve())
        while not server.started:
            if task.done():
                await task
                raise RuntimeError("acceptance API failed to start")
            await asyncio.sleep(0.05)
        fixture.raise_if_failed()
        fixture.phase = "prepared"
        fixture.lifecycle("prepared")
        write_json(
            args.ready_file,
            {
                **fixture.configuration(),
                "token": fixture.token,
            },
            private=True,
        )
        print("native-acceptance: isolated fixture prepared", flush=True)
        if args.provision_only:
            fixture.start_provisioning()
            assert fixture.provision_task is not None
            await fixture.provision_task
            await fixture.health()
            return
        import importlib.util

        spec = importlib.util.spec_from_file_location(
            "native_acceptance_suite", ROOT / "scripts/native-acceptance-suite.py"
        )
        assert spec and spec.loader
        suite = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(suite)
        exercise = asyncio.create_task(suite.exercise(fixture))
        failed = asyncio.create_task(fixture.failure_event.wait())
        try:
            done, _ = await asyncio.wait(
                (exercise, failed, task),
                timeout=args.timeout,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if failed in done:
                fixture.raise_if_failed()
            if task in done:
                fixture.fail("fixture API exited unexpectedly")
                fixture.raise_if_failed()
            if exercise not in done:
                fixture.fail("native acceptance exceeded its fixture deadline")
                raise TimeoutError(fixture.failed)
            await exercise
        finally:
            for pending in (exercise, failed):
                if not pending.done():
                    pending.cancel()
            await asyncio.gather(exercise, failed, return_exceptions=True)
    except BaseException as error:
        # The suite persists its own actionable failure. Earlier setup and
        # child failures still need evidence when no native case has begun.
        if not (fixture.output / "evidence.json").exists():
            fixture.fail(f"fixture setup interrupted ({type(error).__name__})")
        raise
    finally:
        await finish_cleanup(fixture, server, task)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=18100)
    parser.add_argument(
        "--client-host", choices=["127.0.0.1", "10.0.2.2"], default="127.0.0.1"
    )
    parser.add_argument("--transport", choices=["direct", "relay"], default="relay")
    parser.add_argument(
        "--daemon", type=Path, default=ROOT / "daemon/target/debug/spawnd"
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--ready-file", type=Path, required=True)
    parser.add_argument("--timeout", type=int, default=1800)
    parser.add_argument(
        "--baseline",
        default="0" * 40,
        help="Public release baseline used by the aggregate gate; not a native test target",
    )
    parser.add_argument(
        "--provision-only",
        action="store_true",
        help="fixture smoke only; never acceptance evidence",
    )
    args = parser.parse_args()
    args.ready_file = args.ready_file.resolve()
    if not re.fullmatch(r"[0-9a-f]{40}", args.baseline):
        parser.error("baseline must be a full commit SHA")
    if not 1024 <= args.port <= 65535 or not 60 <= args.timeout <= 7200:
        parser.error("invalid port or timeout")

    async def supervised() -> None:
        current = asyncio.current_task()
        assert current is not None
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, current.cancel)
        try:
            await run(args)
        except asyncio.CancelledError:
            pass

    asyncio.run(supervised())


if __name__ == "__main__":
    main()
