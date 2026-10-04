"""Owner-scoped attention events: detection rules, publishing, and delivery.

The detection half is the part worth guarding. Three writes in the tree null
`foreground_command` — a crash, a restart, and an archive — and only one of
them is anything the owner wants to hear about. Everything below exists so a
future change to any of those three cannot quietly start buzzing people.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable
from contextlib import asynccontextmanager
from typing import Any

import pytest

from spawn_server import auth
from spawn_server.db import get_sessionmaker
from spawn_server.models import Host, Session, User
from spawn_server.redis import get_backend, user_alert_channel
from spawn_server.ws.alerts import (
    ALERTS_WS_PROTOCOL,
    QuietWatch,
    alerts_ws,
    is_agent_finish,
    is_shell_command,
)
from spawn_server.ws.daemon import daemon_ws

REGISTER = {
    "type": "register",
    "host_name": "spawnd",
    "os": "linux",
    "arch": "x86_64",
    "version": "0.1.0",
}


class FakeAlertWebSocket:
    def __init__(
        self,
        *,
        authorization: str | None = None,
        cookies: dict[str, str] | None = None,
        subprotocols: list[str] | None = None,
    ) -> None:
        self.headers: dict[str, str] = {}
        if authorization is not None:
            self.headers["authorization"] = authorization
        self.cookies = cookies or {}
        self.scope: dict[str, Any] = {"subprotocols": subprotocols or [ALERTS_WS_PROTOCOL]}
        self.accepted_subprotocol: str | None = None
        self.sent_text: list[str] = []
        self.closed: tuple[int, str] | None = None
        self._incoming: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    async def accept(self, subprotocol: str | None = None) -> None:
        self.accepted_subprotocol = subprotocol

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = (code, reason)

    async def receive(self) -> dict[str, Any]:
        return await self._incoming.get()

    async def send_text(self, value: str) -> None:
        self.sent_text.append(value)

    async def send_json(self, value: dict[str, Any]) -> None:
        self.sent_text.append(json.dumps(value))

    def queue_disconnect(self) -> None:
        self._incoming.put_nowait({"type": "websocket.disconnect"})

    def queue_text(self, payload: dict[str, Any]) -> None:
        self._incoming.put_nowait({"type": "websocket.receive", "text": json.dumps(payload)})

    def frames(self) -> list[dict[str, Any]]:
        return [json.loads(item) for item in self.sent_text]


class FakeDaemonWebSocket:
    def __init__(self) -> None:
        self.headers: dict[str, str] = {}
        self.scope: dict[str, Any] = {"subprotocols": ["spawn.control.v3"]}
        self.accepted_subprotocol: str | None = None
        self.sent_text: list[str] = []
        self.closed: tuple[int, str] | None = None
        self._incoming: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    async def accept(self, subprotocol: str | None = None) -> None:
        self.accepted_subprotocol = subprotocol

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = (code, reason)

    async def receive(self) -> dict[str, Any]:
        return await self._incoming.get()

    async def send_text(self, value: str) -> None:
        self.sent_text.append(value)

    async def send_json(self, value: dict[str, Any]) -> None:
        self.sent_text.append(json.dumps(value))

    async def send_bytes(self, value: bytes) -> None:
        pass

    def queue_text(self, payload: dict[str, Any]) -> None:
        self._incoming.put_nowait({"type": "websocket.receive", "text": json.dumps(payload)})

    def queue_disconnect(self) -> None:
        self._incoming.put_nowait({"type": "websocket.disconnect"})


async def _signup(client, email: str) -> tuple[str, str]:
    response = await client.post(
        "/api/auth/signup", json={"email": email, "password": "passpasspass"}
    )
    assert response.status_code == 200, response.text
    return response.json()["user"]["id"], response.json()["access_token"]


async def _create_host(user_id: str, *, name: str = "alert-box") -> str:
    sm = get_sessionmaker()
    async with sm() as session:
        host = Host(owner_user_id=user_id, name=name, status="offline")
        session.add(host)
        await session.commit()
        return host.id


async def _create_session_row(user_id: str, host_id: str, *, status: str = "running") -> str:
    sm = get_sessionmaker()
    async with sm() as session:
        row = Session(
            owner_user_id=user_id,
            host_id=host_id,
            name="session",
            cwd="/repo",
            status=status,
        )
        session.add(row)
        await session.commit()
        return row.id


class _AlertCollector:
    """Subscribes to an owner's alert channel for the length of a `with`.

    `events` holds only the `alert` family. The channel also carries trust
    and data-changed frames now, and this file asserts alert *semantics* —
    counting a data frame here would fail every "exactly one alert" claim
    for the wrong reason.
    """

    def __init__(self, user_id: str) -> None:
        self._user_id = user_id
        self.events: list[dict[str, Any]] = []
        self._task: asyncio.Task | None = None
        self._ready = asyncio.Event()
        self._received = asyncio.Event()

    async def __aenter__(self) -> _AlertCollector:
        self._task = asyncio.create_task(self._pump())
        await asyncio.wait_for(self._ready.wait(), timeout=1.0)
        return self

    async def __aexit__(self, *exc: object) -> None:
        # Publishes are fire-and-forget; give the loop a beat to drain.
        await asyncio.sleep(0.05)
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass

    async def _pump(self) -> None:
        async with get_backend().subscribe_channel(user_alert_channel(self._user_id)) as stream:
            self._ready.set()
            async for raw in stream:
                event = json.loads(raw)
                if event.get("type") == "alert":
                    self.events.append(event)
                    self._received.set()

    async def wait_for(self, event_name: str) -> None:
        while not any(event.get("event") == event_name for event in self.events):
            self._received.clear()
            await self._received.wait()


async def _run_daemon(
    token: str,
    frames: list[dict[str, Any]],
    *,
    existing_sessions: list[str] | None = None,
) -> FakeDaemonWebSocket:
    ws = FakeDaemonWebSocket()
    ws.queue_text(
        REGISTER
        if existing_sessions is None
        else {**REGISTER, "existing_sessions": existing_sessions}
    )
    for frame in frames:
        ws.queue_text(frame)
    ws.queue_disconnect()
    await daemon_ws(ws, token=token)  # type: ignore[arg-type]
    return ws


# ---------- pure detection ----------


@pytest.mark.parametrize(
    ("command", "expected"),
    [
        ("bash", True),
        ("zsh", True),
        ("-zsh", True),  # login shells prefix argv[0] with "-"
        ("ZSH", True),
        ("fish", True),
        ("sh", True),
        ("dash", True),
        ("claude", False),
        ("", False),
        (None, False),
        ("zsh-completions", False),
    ],
)
def test_is_shell_command(command: str | None, expected: bool) -> None:
    assert is_shell_command(command) is expected


def test_quiet_window_matches_the_status_dot() -> None:
    """The dot saying "Awaiting input" and the alert firing are one event.

    They were 8 s and 30 s apart, which is what produced "the badge appeared
    but nothing told me". Pinned so a change to either has to be a change to
    both, deliberately.
    """
    from spawn_server.routes.sessions import WAITING_OUTPUT_WINDOW
    from spawn_server.ws.alerts import ALERT_QUIET_SECONDS

    assert ALERT_QUIET_SECONDS == WAITING_OUTPUT_WINDOW.total_seconds()


@pytest.mark.parametrize(
    ("previous", "current", "status", "expected", "why"),
    [
        ("claude", None, "running", True, "agent left the foreground"),
        ("claude", "zsh", "running", True, "agent handed back to the shell"),
        ("claude", "-zsh", "running", True, "login shell counts as the prompt"),
        ("claude", "vim", "running", False, "handed to another program, not finished"),
        ("claude", "codex", "running", False, "one agent replacing another"),
        (None, "claude", "running", False, "a start is not a finish"),
        (None, None, "running", False, "a worker that never reports anything"),
        ("zsh", "claude", "running", False, "leaving the shell is not a finish"),
        ("zsh", None, "running", False, "shell to nothing is not a finish"),
        ("claude", None, "exited", False, "crash: session.died owns this transition"),
        ("claude", None, "killed", False, "kill: session.died owns this transition"),
        ("claude", None, "starting", False, "restart: the user asked for this"),
    ],
)
def test_is_agent_finish(
    previous: str | None, current: str | None, status: str, expected: bool, why: str
) -> None:
    assert is_agent_finish(previous, current, status) is expected, why


# ---------- publishing from the daemon socket ----------


async def test_agent_returning_to_shell_publishes_one_finish(client):
    user_id, _ = await _signup(client, "alert-finish@example.com")
    host_id = await _create_host(user_id)
    pty_id = await _create_session_row(user_id, host_id)
    token = auth.issue_daemon_token(host_id, user_id)

    async with _AlertCollector(user_id) as alerts:
        await _run_daemon(
            token,
            [
                {"type": "session.foreground", "session_id": pty_id, "command": "claude"},
                {"type": "session.foreground", "session_id": pty_id, "command": "zsh"},
            ],
        )

    assert len(alerts.events) == 1, alerts.events
    event = alerts.events[0]
    assert event["type"] == "alert"
    assert event["event"] == "agent.finished"
    assert event["session_id"] == pty_id
    assert event["command"] == "claude"
    assert isinstance(event["at"], str)


async def test_agent_handoff_and_start_publish_nothing(client):
    user_id, _ = await _signup(client, "alert-handoff@example.com")
    host_id = await _create_host(user_id)
    pty_id = await _create_session_row(user_id, host_id)
    token = auth.issue_daemon_token(host_id, user_id)

    async with _AlertCollector(user_id) as alerts:
        await _run_daemon(
            token,
            [
                # shell -> agent -> another program: no finish anywhere.
                {"type": "session.foreground", "session_id": pty_id, "command": "zsh"},
                {"type": "session.foreground", "session_id": pty_id, "command": "claude"},
                {"type": "session.foreground", "session_id": pty_id, "command": "vim"},
            ],
        )

    assert alerts.events == []


async def test_crash_publishes_died_only_not_a_finish(client):
    """The regression this whole module exists for.

    `session.exit` nulls `foreground_command` in the same update that writes
    "exited". Detected naively that is a finish *and* a death for one event.
    """
    user_id, _ = await _signup(client, "alert-crash@example.com")
    host_id = await _create_host(user_id)
    pty_id = await _create_session_row(user_id, host_id)
    token = auth.issue_daemon_token(host_id, user_id)

    async with _AlertCollector(user_id) as alerts:
        await _run_daemon(
            token,
            [
                {"type": "session.foreground", "session_id": pty_id, "command": "claude"},
                {"type": "session.exit", "session_id": pty_id, "exit_code": 137},
            ],
        )

    assert len(alerts.events) == 1, alerts.events
    event = alerts.events[0]
    assert event["event"] == "session.died"
    assert event["session_id"] == pty_id
    # The alert still names what went down with the session.
    assert event["command"] == "claude"
    assert event["exit_code"] == 137
    assert event["signal"] is None


async def test_killed_session_reports_its_signal(client):
    user_id, _ = await _signup(client, "alert-killed@example.com")
    host_id = await _create_host(user_id)
    pty_id = await _create_session_row(user_id, host_id)
    token = auth.issue_daemon_token(host_id, user_id)

    async with _AlertCollector(user_id) as alerts:
        await _run_daemon(
            token,
            [{"type": "session.exit", "session_id": pty_id, "signal": "TERM"}],
        )

    assert len(alerts.events) == 1, alerts.events
    assert alerts.events[0]["event"] == "session.died"
    assert alerts.events[0]["signal"] == "TERM"
    assert alerts.events[0]["command"] is None


async def test_restart_cleared_foreground_does_not_alert(client):
    """`POST /api/sessions/{id}/restart` nulls the foreground and sets
    "starting". The next daemon report must not read as a finish."""
    user_id, _ = await _signup(client, "alert-restart@example.com")
    host_id = await _create_host(user_id)
    pty_id = await _create_session_row(user_id, host_id, status="starting")
    token = auth.issue_daemon_token(host_id, user_id)

    sm = get_sessionmaker()
    async with sm() as session:
        row = await session.get(Session, pty_id)
        assert row is not None
        row.foreground_command = "claude"
        await session.commit()

    async with _AlertCollector(user_id) as alerts:
        await _run_daemon(
            token,
            [{"type": "session.foreground", "session_id": pty_id, "command": "zsh"}],
        )

    assert alerts.events == []


async def test_alerts_do_not_cross_owners(client):
    """A daemon may only alert the owner of the session it is reporting on."""
    owner_id, _ = await _signup(client, "alert-owner@example.com")
    other_id, _ = await _signup(client, "alert-other@example.com")
    host_id = await _create_host(owner_id)
    pty_id = await _create_session_row(owner_id, host_id)
    token = auth.issue_daemon_token(host_id, owner_id)

    async with _AlertCollector(other_id) as eavesdropper:
        async with _AlertCollector(owner_id) as alerts:
            await _run_daemon(
                token,
                [
                    {"type": "session.foreground", "session_id": pty_id, "command": "claude"},
                    {"type": "session.foreground", "session_id": pty_id, "command": "zsh"},
                ],
            )

    assert len(alerts.events) == 1
    assert eavesdropper.events == []


# ---------- exits the server asked for ----------


async def _wait_until(predicate, *, timeout: float = 1.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("timed out waiting for condition")
        await asyncio.sleep(0.01)


def _record_pushes(monkeypatch) -> list[dict[str, Any]]:
    from spawn_server.ws import daemon as daemon_module

    pushed: list[dict[str, Any]] = []
    monkeypatch.setattr(
        daemon_module,
        "_schedule_alert_push",
        lambda _owner_id, payload: pushed.append(payload),
    )
    return pushed


def _sent_frames(ws: FakeDaemonWebSocket, kind: str) -> list[dict[str, Any]]:
    frames = [json.loads(item) for item in ws.sent_text]
    return [frame for frame in frames if frame.get("type") == kind]


async def test_archived_window_exits_without_a_died_alert(client, monkeypatch):
    """Archive stops every window in the workspace. The daemon's confirming
    exit is the stop the owner asked for, not a death: no alert, no push, and
    no fencing close of the daemon's link — while the exit is still recorded."""
    pushed = _record_pushes(monkeypatch)
    user_id, access_token = await _signup(client, "alert-archive@example.com")
    owner = {"Authorization": f"Bearer {access_token}"}
    host_id = await _create_host(user_id)
    pty_id = await _create_session_row(user_id, host_id)
    created = await client.post("/api/workspaces", json={"name": "put away"}, headers=owner)
    workspace_id = created.json()["workspace"]["id"]
    tile = {"session_id": pty_id, "x": 0, "y": 0, "w": 24, "h": 24}
    layout = {
        "version": 3,
        "active_tab": "tab-1",
        "tabs": [
            {
                "id": "tab-1",
                "name": "Tab 1",
                "host_id": None,
                "cwd": None,
                "layout": {"version": 3, "tiles": [tile]},
            }
        ],
    }
    patched = await client.patch(
        f"/api/workspaces/{workspace_id}", json={"layout": layout}, headers=owner
    )
    assert patched.status_code == 200, patched.text

    ws = FakeDaemonWebSocket()
    task = asyncio.create_task(daemon_ws(ws, token=auth.issue_daemon_token(host_id, user_id)))  # type: ignore[arg-type]
    async with _AlertCollector(user_id) as alerts:
        ws.queue_text({**REGISTER, "existing_sessions": [pty_id]})
        await _wait_until(lambda: bool(_sent_frames(ws, "registered")))
        ws.queue_text({"type": "session.foreground", "session_id": pty_id, "command": "claude"})
        # An agent is running in a window on a settled host. The socket reads
        # frames in order, so once the foreground is stored, registration has
        # finished too, including its own check for workers to stop.
        for _ in range(200):
            async with get_sessionmaker()() as session:
                row = await session.get(Session, pty_id)
                if row is not None and row.foreground_command == "claude":
                    break
            await asyncio.sleep(0.01)
        else:
            raise AssertionError("the foreground frame was never stored")

        archived = await client.post(f"/api/workspaces/{workspace_id}/archive", headers=owner)
        assert archived.status_code == 200, archived.text
        assert [frame["session_id"] for frame in _sent_frames(ws, "session.kill")] == [pty_id]

        ws.queue_text({"type": "session.exit", "session_id": pty_id, "signal": "TERM"})
        ws.queue_disconnect()
        await asyncio.wait_for(task, timeout=2)

    assert alerts.events == []
    assert pushed == []
    assert ws.closed is None
    async with get_sessionmaker()() as session:
        row = await session.get(Session, pty_id)
        assert row is not None
        assert row.status == "killed"
        assert row.exited_at is not None
        assert row.foreground_command is None


async def test_returning_host_exits_raise_no_died_alert(client, monkeypatch):
    """The kills a returning host is handed come back as exits too: for a
    window stopped while it was away (its row already says so) and for one
    moved to another host (no longer this host's row to report on)."""
    pushed = _record_pushes(monkeypatch)
    user_id, _ = await _signup(client, "alert-returning@example.com")
    host_id = await _create_host(user_id)
    other_host_id = await _create_host(user_id, name="elsewhere")
    stopped = await _create_session_row(user_id, host_id, status="killed")
    moved = await _create_session_row(user_id, other_host_id)

    async with _AlertCollector(user_id) as alerts:
        ws = await _run_daemon(
            auth.issue_daemon_token(host_id, user_id),
            [
                {"type": "session.exit", "session_id": stopped, "exit_code": 143},
                {"type": "session.exit", "session_id": moved, "signal": "TERM"},
            ],
            existing_sessions=[stopped, moved],
        )

    assert sorted(frame["session_id"] for frame in _sent_frames(ws, "session.kill")) == sorted(
        [stopped, moved]
    )
    assert alerts.events == []
    assert pushed == []
    assert ws.closed is None
    async with get_sessionmaker()() as session:
        stopped_row = await session.get(Session, stopped)
        assert stopped_row is not None
        assert (stopped_row.status, stopped_row.exit_code) == ("killed", 143)
        moved_row = await session.get(Session, moved)
        assert moved_row is not None
        assert (moved_row.status, moved_row.exit_code) == ("running", None)


async def test_a_crash_still_raises_died_and_its_push(client, monkeypatch):
    """The other side of the two tests above: nobody asked for this exit."""
    pushed = _record_pushes(monkeypatch)
    user_id, _ = await _signup(client, "alert-still-crashes@example.com")
    host_id = await _create_host(user_id)
    pty_id = await _create_session_row(user_id, host_id)

    async with _AlertCollector(user_id) as alerts:
        await _run_daemon(
            auth.issue_daemon_token(host_id, user_id),
            [
                {"type": "session.foreground", "session_id": pty_id, "command": "claude"},
                {"type": "session.exit", "session_id": pty_id, "signal": "KILL"},
            ],
            existing_sessions=[pty_id],
        )

    assert [event["event"] for event in alerts.events] == ["session.died"]
    assert alerts.events[0]["command"] == "claude"
    assert [payload["event"] for payload in pushed] == ["session.died"]
    async with get_sessionmaker()() as session:
        row = await session.get(Session, pty_id)
        assert row is not None and row.status == "killed"


class _SessionEventTap:
    """What the per-session channel carried: the frames panes open on one
    window hear (`session.status`, `session.exit`)."""

    def __init__(self, session_id: str) -> None:
        from spawn_server.redis import session_event_channel

        self.channel = session_event_channel(session_id)
        self.frames: list[dict[str, Any]] = []
        self._task: asyncio.Task | None = None
        self._ready = asyncio.Event()

    async def __aenter__(self) -> _SessionEventTap:
        async def pump() -> None:
            async with get_backend().subscribe_channel(self.channel) as stream:
                self._ready.set()
                async for raw in stream:
                    self.frames.append(json.loads(raw))

        self._task = asyncio.create_task(pump())
        await asyncio.wait_for(self._ready.wait(), timeout=1.0)
        return self

    async def __aexit__(self, *exc: object) -> None:
        await asyncio.sleep(0.05)
        assert self._task is not None
        self._task.cancel()
        try:
            await self._task
        except (asyncio.CancelledError, Exception):
            pass


async def test_a_moving_window_exits_without_an_alert_and_stays_moving(client, monkeypatch):
    """A device is carrying the window's conversation away: the source's retire
    stops the shell and the agent, or the shell goes anyway. The exit is
    recorded and is not news — no session.died, no push, no "Shell exited" to
    the panes open on it — and the row stays "moving" until the move commits
    or is aborted. The account-wide data frame still carries the recorded
    exit."""
    from spawn_server.data_events import DATA_FRAME_TYPE

    pushed = _record_pushes(monkeypatch)
    user_id, _ = await _signup(client, "alert-moving-exit@example.com")
    host_id = await _create_host(user_id)
    pty_id = await _create_session_row(user_id, host_id, status="moving")

    data_frames: list[dict[str, Any]] = []

    async def collect_data() -> None:
        async with get_backend().subscribe_channel(user_alert_channel(user_id)) as stream:
            async for raw in stream:
                frame = json.loads(raw)
                if frame.get("type") == DATA_FRAME_TYPE:
                    data_frames.append(frame)

    data_task = asyncio.create_task(collect_data())
    await asyncio.sleep(0)
    try:
        async with _SessionEventTap(pty_id) as panes, _AlertCollector(user_id) as alerts:
            ws = await _run_daemon(
                auth.issue_daemon_token(host_id, user_id),
                [
                    {"type": "session.foreground", "session_id": pty_id, "command": "claude"},
                    {"type": "session.exit", "session_id": pty_id, "signal": "TERM"},
                ],
                existing_sessions=[pty_id],
            )
    finally:
        await asyncio.sleep(0.05)
        data_task.cancel()
        try:
            await data_task
        except (asyncio.CancelledError, Exception):
            pass

    assert alerts.events == []
    assert pushed == []
    assert [frame for frame in panes.frames if frame.get("type") == "session.exit"] == []
    # The host it is leaving was not told to stop it at registration either:
    # that is the move's retire, never the server's.
    assert _sent_frames(ws, "session.kill") == []
    assert ws.closed is None
    assert ("sessions", pty_id) in [(f.get("resource"), f.get("id")) for f in data_frames]
    async with get_sessionmaker()() as session:
        row = await session.get(Session, pty_id)
        assert row is not None
        assert row.status == "moving"
        assert row.exited_at is not None
        assert row.exit_code is None
        assert row.foreground_command is None


async def test_a_carried_move_aborted_after_the_source_exit_stays_quiet(client, monkeypatch):
    """The whole server side of a move that does not finish: begin, the
    source's exit while moving, abort, then a late duplicate exit. The row
    ends "killed" with the exit the source reported, and nothing pages."""
    pushed = _record_pushes(monkeypatch)
    user_id, access_token = await _signup(client, "alert-moving-abort@example.com")
    owner = {"Authorization": f"Bearer {access_token}"}
    host_id = await _create_host(user_id)
    pty_id = await _create_session_row(user_id, host_id)

    ws = FakeDaemonWebSocket()
    task = asyncio.create_task(daemon_ws(ws, token=auth.issue_daemon_token(host_id, user_id)))  # type: ignore[arg-type]
    async with _AlertCollector(user_id) as alerts:
        ws.queue_text({**REGISTER, "existing_sessions": [pty_id]})
        await _wait_until(lambda: bool(_sent_frames(ws, "registered")))
        r = await client.post(
            f"/api/sessions/{pty_id}/move/begin",
            json={"expected_host_id": host_id},
            headers=owner,
        )
        assert r.status_code == 200, r.text
        assert _sent_frames(ws, "session.kill") == []

        ws.queue_text({"type": "session.exit", "session_id": pty_id, "exit_code": 143})

        async def exit_recorded() -> bool:
            async with get_sessionmaker()() as session:
                row = await session.get(Session, pty_id)
                return row is not None and row.exit_code == 143

        for _ in range(200):
            if await exit_recorded():
                break
            await asyncio.sleep(0.01)
        else:
            raise AssertionError("the exit was never recorded")

        r = await client.post(
            f"/api/sessions/{pty_id}/move/abort",
            json={"expected_host_id": host_id},
            headers=owner,
        )
        assert r.status_code == 200, r.text
        assert (r.json()["status"], r.json()["exit_code"]) == ("killed", 143)
        # The abort's kill: whatever the retire did not reach.
        assert [frame["session_id"] for frame in _sent_frames(ws, "session.kill")] == [pty_id]

        ws.queue_text({"type": "session.exit", "session_id": pty_id, "signal": "TERM"})
        ws.queue_disconnect()
        await asyncio.wait_for(task, timeout=2)

    assert alerts.events == []
    assert pushed == []
    assert ws.closed is None
    async with get_sessionmaker()() as session:
        row = await session.get(Session, pty_id)
        assert row is not None and row.status == "killed"


async def test_an_exit_read_before_a_move_began_still_keeps_it_moving(client, monkeypatch):
    """Begin commits between the exit handler's read (the row says running)
    and its write. The status is decided in the statement, so the move is
    not overwritten with "killed", and the alert the stale read would have
    raised is not sent either."""
    from sqlalchemy.ext.asyncio import AsyncSession
    from sqlalchemy.sql.dml import Update

    pushed = _record_pushes(monkeypatch)
    user_id, _ = await _signup(client, "alert-moving-race@example.com")
    host_id = await _create_host(user_id)
    pty_id = await _create_session_row(user_id, host_id)

    real_execute = AsyncSession.execute
    armed = False
    raced = False

    async def execute(self, statement, *args, **kwargs):
        nonlocal raced
        if (
            armed
            and not raced
            and isinstance(statement, Update)
            and statement.table.name == "sessions"
        ):
            raced = True
            async with get_sessionmaker()() as other:
                row = await other.get(Session, pty_id)
                assert row is not None
                row.status = "moving"
                await other.commit()
        return await real_execute(self, statement, *args, **kwargs)

    monkeypatch.setattr(AsyncSession, "execute", execute)
    ws = FakeDaemonWebSocket()
    task = asyncio.create_task(daemon_ws(ws, token=auth.issue_daemon_token(host_id, user_id)))  # type: ignore[arg-type]
    async with _AlertCollector(user_id) as alerts:
        ws.queue_text({**REGISTER, "existing_sessions": [pty_id]})
        await _wait_until(lambda: bool(_sent_frames(ws, "registered")))
        armed = True
        ws.queue_text({"type": "session.exit", "session_id": pty_id, "signal": "TERM"})
        await _wait_until(lambda: raced)
        ws.queue_disconnect()
        await asyncio.wait_for(task, timeout=2)
    monkeypatch.setattr(AsyncSession, "execute", real_execute)

    assert alerts.events == []
    assert pushed == []
    assert ws.closed is None
    async with get_sessionmaker()() as session:
        row = await session.get(Session, pty_id)
        assert row is not None
        assert row.status == "moving"
        assert row.exited_at is not None


# ---------- delivery over /ws/alerts ----------


async def test_alerts_ws_requires_its_subprotocol(client):
    user_id, access_token = await _signup(client, "alert-proto@example.com")
    ws = FakeAlertWebSocket(authorization=f"Bearer {access_token}", subprotocols=["spawn.v3"])
    await alerts_ws(ws, token=None)  # type: ignore[arg-type]
    assert ws.closed == (4003, "protocol upgrade required")
    assert ws.frames()[0]["type"] == "protocol.required"
    assert user_id


async def test_alerts_ws_rejects_unauthenticated(client):
    ws = FakeAlertWebSocket()
    await alerts_ws(ws, token=None)  # type: ignore[arg-type]
    assert ws.accepted_subprotocol == ALERTS_WS_PROTOCOL
    assert ws.closed == (1008, "not authenticated")


async def test_alerts_ws_rejects_revoked_epoch_and_reports_unknown_frame(client):
    user_id, token = await _signup(client, "alert-revoked-epoch@example.com")
    async with get_sessionmaker()() as session:
        user = await session.get(User, user_id)
        assert user is not None
        user.session_epoch += 1
        await session.commit()
    revoked = FakeAlertWebSocket(authorization=f"Bearer {token}")
    await alerts_ws(revoked, token=None)  # type: ignore[arg-type]
    assert revoked.closed == (1008, "not authenticated")

    fresh = auth.issue_access_token(user_id, session_epoch=1)
    ws = FakeAlertWebSocket(authorization=f"Bearer {fresh}")
    task = asyncio.create_task(alerts_ws(ws, token=None))  # type: ignore[arg-type]
    await asyncio.sleep(0.02)
    ws.queue_text({"type": "future.alert.frame"})
    for _ in range(100):
        if any(frame.get("type") == "error" for frame in ws.frames()):
            break
        await asyncio.sleep(0.01)
    assert [frame for frame in ws.frames() if frame.get("type") == "error"] == [
        {
            "type": "error",
            "code": "unknown_frame",
            "frame_type": "future.alert.frame",
        }
    ]
    ws.queue_disconnect()
    await asyncio.wait_for(task, timeout=1)


async def test_alerts_ws_closes_4010_when_subscription_is_not_ready(client, monkeypatch):
    _user_id, token = await _signup(client, "alert-subscription-lost@example.com")

    @asynccontextmanager
    async def ended_subscription(_channel):
        async def empty():
            if False:
                yield b""

        yield empty()

    monkeypatch.setattr(get_backend(), "subscribe_channel", ended_subscription)
    ws = FakeAlertWebSocket(authorization=f"Bearer {token}")
    await alerts_ws(ws, token=None)  # type: ignore[arg-type]
    assert ws.closed == (4010, "subscription lost")


async def test_alerts_ws_forwards_owner_events_only(client):
    user_id, access_token = await _signup(client, "alert-stream@example.com")
    other_id, _ = await _signup(client, "alert-stream-other@example.com")

    ws = FakeAlertWebSocket(authorization=f"Bearer {access_token}")
    stream = asyncio.create_task(alerts_ws(ws, token=None))  # type: ignore[arg-type]
    # Let the subscription attach before anything is published.
    await asyncio.sleep(0.1)

    backend = get_backend()
    mine = {
        "type": "alert",
        "event": "agent.finished",
        "session_id": "s-1",
        "command": "claude",
        "at": "2026-08-21T00:00:00+00:00",
    }
    theirs = {**mine, "session_id": "s-2"}
    await backend.publish_channel(user_alert_channel(user_id), json.dumps(mine).encode())
    await backend.publish_channel(user_alert_channel(other_id), json.dumps(theirs).encode())
    # Junk on the owner's own channel is dropped rather than forwarded.
    await backend.publish_channel(
        user_alert_channel(user_id),
        json.dumps({"type": "alert", "event": "not.a.thing", "session_id": "s-3"}).encode(),
    )
    await backend.publish_channel(user_alert_channel(user_id), b"{not json")
    await asyncio.sleep(0.1)

    ws.queue_disconnect()
    await asyncio.wait_for(stream, timeout=2.0)

    forwarded = [frame for frame in ws.frames() if frame.get("type") == "alert"]
    assert len(forwarded) == 1, ws.frames()
    assert forwarded[0]["session_id"] == "s-1"


async def test_alerts_ws_delivers_a_live_daemon_transition(client):
    """End to end: an agent exits on a host and the owner's socket says so,
    with no session pane open and no polling anywhere in the path."""
    user_id, access_token = await _signup(client, "alert-live@example.com")
    host_id = await _create_host(user_id)
    pty_id = await _create_session_row(user_id, host_id)
    daemon_token = auth.issue_daemon_token(host_id, user_id)

    ws = FakeAlertWebSocket(authorization=f"Bearer {access_token}")
    stream = asyncio.create_task(alerts_ws(ws, token=None))  # type: ignore[arg-type]
    await asyncio.sleep(0.1)

    await _run_daemon(
        daemon_token,
        [
            {"type": "session.foreground", "session_id": pty_id, "command": "claude"},
            {"type": "session.foreground", "session_id": pty_id, "command": "zsh"},
        ],
    )
    await asyncio.sleep(0.1)

    ws.queue_disconnect()
    await asyncio.wait_for(stream, timeout=2.0)

    forwarded = [frame for frame in ws.frames() if frame.get("type") == "alert"]
    assert len(forwarded) == 1, ws.frames()
    assert forwarded[0]["event"] == "agent.finished"
    assert forwarded[0]["session_id"] == pty_id
    assert forwarded[0]["command"] == "claude"


# ---------- the quiet watch (agent.awaiting_input) ----------


async def test_quiet_watch_fires_once_after_the_delay():
    fired: list[str] = []

    async def on_quiet(session_id: str) -> None:
        fired.append(session_id)

    watch = QuietWatch(on_quiet, delay=0.05)
    watch.touch("s-1")
    assert watch.pending == 1
    await asyncio.sleep(0.15)
    assert fired == ["s-1"]
    # Staying quiet is one event, not a repeating one.
    await asyncio.sleep(0.15)
    assert fired == ["s-1"]
    assert watch.pending == 0


async def test_quiet_watch_is_rearmed_by_activity():
    fired: list[str] = []

    async def on_quiet(session_id: str) -> None:
        fired.append(session_id)

    # Timings are deliberately loose multiples of the delay: this asserts
    # ordering, not latency.
    watch = QuietWatch(on_quiet, delay=0.10)
    for _ in range(4):
        watch.touch("s-1")
        await asyncio.sleep(0.03)
    # Output kept arriving, so it never went quiet.
    assert fired == []
    await asyncio.sleep(0.30)
    assert fired == ["s-1"]
    await watch.shutdown()


async def test_quiet_watch_cancel_and_shutdown_silence_it():
    fired: list[str] = []

    async def on_quiet(session_id: str) -> None:
        fired.append(session_id)

    watch = QuietWatch(on_quiet, delay=0.02)
    watch.touch("s-1")
    watch.cancel("s-1")
    watch.touch("s-2")
    await watch.shutdown()
    await asyncio.sleep(0.08)
    assert fired == []
    assert watch.pending == 0


async def test_quiet_watch_tracks_sessions_independently():
    fired: list[str] = []

    async def on_quiet(session_id: str) -> None:
        fired.append(session_id)

    watch = QuietWatch(on_quiet, delay=0.10)
    watch.touch("s-1")
    watch.touch("s-2")
    await asyncio.sleep(0.05)
    watch.touch("s-2")  # s-2 keeps working; s-1 does not
    # s-1's clock runs out at 0.10; s-2's was pushed to 0.15.
    await asyncio.sleep(0.07)
    assert fired == ["s-1"]
    await asyncio.sleep(0.15)
    assert fired == ["s-1", "s-2"]


def _fast_quiet(monkeypatch, delay: float = 0.05) -> None:
    """Collapse both windows so a 30 s feature is not a 30 s test.

    `QuietWatch`'s delay is when the timer fires; `ALERT_QUIET_SECONDS` is the
    silence the publisher re-checks against the row before it believes it.
    """
    import spawn_server.ws.daemon as daemon_mod
    from spawn_server.ws.alerts import QuietWatch as RealQuietWatch

    monkeypatch.setattr(
        daemon_mod, "QuietWatch", lambda on_quiet, **kw: RealQuietWatch(on_quiet, delay=delay)
    )
    monkeypatch.setattr(daemon_mod, "ALERT_QUIET_SECONDS", delay / 2)


async def _drive_daemon(
    token: str,
    frames: list[dict[str, Any]],
    *,
    settle: float = 0.3,
    until: Awaitable[None] | None = None,
) -> None:
    ws = FakeDaemonWebSocket()
    ws.queue_text(REGISTER)
    for frame in frames:
        ws.queue_text(frame)
    task = asyncio.create_task(daemon_ws(ws, token=token))  # type: ignore[arg-type]
    try:
        if until is None:
            await asyncio.sleep(settle)
        else:
            await asyncio.wait_for(until, timeout=5.0)
    finally:
        ws.queue_disconnect()
        await asyncio.wait_for(task, timeout=2.0)


@pytest.mark.parametrize("registration_delay", [0.0, 0.35])
async def test_awaiting_input_publishes_for_a_quiet_agent(
    client, monkeypatch, registration_delay
):
    """The event the user actually wants: an agent that spoke, then stopped."""
    _fast_quiet(monkeypatch)
    real_accept = FakeDaemonWebSocket.accept

    async def delayed_accept(self, subprotocol=None):
        # Registration may consume the entire old 300 ms settle budget before
        # activity can even arm its quiet timer. Keep the connection alive
        # until the alert is observed instead of timing it from task creation.
        await asyncio.sleep(registration_delay)
        await real_accept(self, subprotocol=subprotocol)

    monkeypatch.setattr(FakeDaemonWebSocket, "accept", delayed_accept)
    user_id, _ = await _signup(client, "alert-quiet@example.com")
    host_id = await _create_host(user_id)
    pty_id = await _create_session_row(user_id, host_id)
    token = auth.issue_daemon_token(host_id, user_id)

    async with _AlertCollector(user_id) as alerts:
        await _drive_daemon(
            token,
            [
                {"type": "session.foreground", "session_id": pty_id, "command": "claude"},
                {"type": "session.activity", "session_id": pty_id},
            ],
            until=alerts.wait_for("agent.awaiting_input"),
        )

    awaiting = [e for e in alerts.events if e["event"] == "agent.awaiting_input"]
    assert len(awaiting) == 1, alerts.events
    assert awaiting[0]["session_id"] == pty_id
    assert awaiting[0]["command"] == "claude"


async def test_a_foreground_report_alone_never_alerts(client, monkeypatch):
    """The phantom-alert regression.

    A worker re-reports its foreground on every reconnect. Arming the clock on
    that meant a daemon reconnect raised "is waiting for you" for a session
    that had produced nothing at all. Only output starts a turn.
    """
    _fast_quiet(monkeypatch)
    user_id, _ = await _signup(client, "alert-phantom@example.com")
    host_id = await _create_host(user_id)
    pty_id = await _create_session_row(user_id, host_id)
    token = auth.issue_daemon_token(host_id, user_id)

    async with _AlertCollector(user_id) as alerts:
        await _drive_daemon(
            token,
            [{"type": "session.foreground", "session_id": pty_id, "command": "claude"}],
            settle=0.3,
        )

    assert [e for e in alerts.events if e["event"] == "agent.awaiting_input"] == []


async def test_input_after_output_stops_the_wait(client, monkeypatch):
    """You typed, so the agent owes you — it is not waiting on you."""
    _fast_quiet(monkeypatch)
    user_id, _ = await _signup(client, "alert-typed@example.com")
    host_id = await _create_host(user_id)
    pty_id = await _create_session_row(user_id, host_id)
    token = auth.issue_daemon_token(host_id, user_id)

    async with _AlertCollector(user_id) as alerts:
        await _drive_daemon(
            token,
            [
                {"type": "session.foreground", "session_id": pty_id, "command": "claude"},
                {"type": "session.activity", "session_id": pty_id},
                {"type": "session.input_activity", "session_id": pty_id},
            ],
            settle=0.3,
        )

    assert [e for e in alerts.events if e["event"] == "agent.awaiting_input"] == []


async def test_awaiting_input_stays_silent_at_a_shell_prompt(client, monkeypatch):
    """A quiet shell is just a shell. Only a running agent is *waiting*."""
    _fast_quiet(monkeypatch)
    user_id, _ = await _signup(client, "alert-quiet-shell@example.com")
    host_id = await _create_host(user_id)
    pty_id = await _create_session_row(user_id, host_id)
    token = auth.issue_daemon_token(host_id, user_id)

    async with _AlertCollector(user_id) as alerts:
        await _drive_daemon(
            token,
            [
                {"type": "session.foreground", "session_id": pty_id, "command": "zsh"},
                {"type": "session.activity", "session_id": pty_id},
            ],
            settle=0.3,
        )

    assert [e for e in alerts.events if e["event"] == "agent.awaiting_input"] == []
