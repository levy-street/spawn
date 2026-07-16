"""In-process routing map between daemon WS and browser WSs.

Multi-process deploys still work: PTY output is also `publish()`ed to Redis,
so a browser attached on a different worker receives the bytes via pubsub.
This module is the *local* fast path plus the registration source of truth
for which daemon owns which agent on this worker.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field, replace
from enum import Enum
from typing import TYPE_CHECKING

from ..redis import get_backend
from .owner_dispatch import (
    OwnerResultEnvelope,
    decode_owner_result,
    owner_result_channel,
    publish_owner_result,
)

if TYPE_CHECKING:
    from fastapi import WebSocket

    from .host_signal import RedisBrowserConn


@dataclass(eq=False)
class DaemonConn:
    host_id: str
    user_id: str
    websocket: WebSocket
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    host_generation: int | None = None
    home_dir: str | None = None
    agent_ids: set[str] = field(default_factory=set)
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    superseded_close_started: bool = False
    rtc_revocation_started: bool = False

    async def send_text(self, payload: dict) -> None:
        async with self.send_lock:
            await self.websocket.send_text(json.dumps(payload))

    async def send_bytes(self, payload: bytes) -> None:
        async with self.send_lock:
            await self.websocket.send_bytes(payload)


@dataclass(eq=False)
class BrowserConn:
    user_id: str
    agent_id: str
    websocket: WebSocket
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def send_text(self, payload: dict) -> None:
        async with self.send_lock:
            await self.websocket.send_text(json.dumps(payload))

    async def send_bytes(self, payload: bytes) -> None:
        async with self.send_lock:
            await self.websocket.send_bytes(payload)

    @property
    def route_id(self) -> str:
        return self.id


@dataclass(eq=False)
class HostBrowserConn:
    user_id: str
    host_id: str
    websocket: WebSocket
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def send_text(self, payload: dict) -> None:
        async with self.send_lock:
            await self.websocket.send_text(json.dumps(payload))

    @property
    def route_id(self) -> str:
        return self.id


@dataclass(frozen=True)
class RtcSessionBinding:
    session_id: str
    browser: BrowserConn | HostBrowserConn | RedisBrowserConn
    daemon: DaemonConn
    scope_type: str
    scope_id: str
    protocol: str
    protocol_version: int
    expires_at: float


@dataclass(frozen=True)
class DaemonOwnerAcceptance:
    accepted: bool
    superseded_connection_id: str | None = None

    def __bool__(self) -> bool:
        return self.accepted


class UploadResolution(Enum):
    RESOLVED = "resolved"
    NO_WAITER = "no_waiter"
    STALE_OWNER = "stale_owner"


@dataclass
class _DisplayState:
    owner_conn_id: str | None = None
    cols: int | None = None
    rows: int | None = None


@dataclass(frozen=True)
class BrowserDisplayState:
    owner: bool
    cols: int | None
    rows: int | None
    viewers: int
    changed: bool = False


class Broker:
    def __init__(self) -> None:
        self._daemons_by_host: dict[str, DaemonConn] = {}
        self._accepted_daemon_owners: dict[str, tuple[str, int]] = {}
        self._daemon_by_agent: dict[str, DaemonConn] = {}
        self._browsers_by_agent: dict[str, set[BrowserConn]] = defaultdict(set)
        self._display_by_agent: dict[str, _DisplayState] = {}
        self._rtc_sessions: dict[str, RtcSessionBinding] = {}
        self._lock = asyncio.Lock()

    # ---- daemon registration ----

    @staticmethod
    async def _close_superseded(conn: DaemonConn | None) -> None:
        if conn is None or conn.superseded_close_started:
            return
        conn.superseded_close_started = True
        try:
            await asyncio.wait_for(
                conn.websocket.close(code=4000, reason="superseded"), timeout=1.0
            )
        except Exception:
            conn.superseded_close_started = False

    async def register_daemon(self, conn: DaemonConn) -> None:
        superseded: DaemonConn | None = None
        async with self._lock:
            existing = self._daemons_by_host.get(conn.host_id)
            if existing is not None and existing is not conn:
                superseded = existing
                for aid in list(existing.agent_ids):
                    self._daemon_by_agent.pop(aid, None)
                existing.agent_ids.clear()
                # Host sessions are actively revoked by the distributed owner
                # event after the replacement daemon claims its Redis lease.
                # Keep them long enough to send unavailable/rtc.close instead
                # of silently orphaning an established DataChannel.
                self._drop_rtc_sessions_for_daemon_locked(existing, include_host=False)
            self._daemons_by_host[conn.host_id] = conn
        await self._close_superseded(superseded)

    async def unregister_daemon(self, conn: DaemonConn) -> None:
        async with self._lock:
            if self._daemons_by_host.get(conn.host_id) is conn:
                self._daemons_by_host.pop(conn.host_id, None)
            if conn.host_generation is not None and self._accepted_daemon_owners.get(
                conn.host_id
            ) == (conn.id, conn.host_generation):
                self._accepted_daemon_owners.pop(conn.host_id, None)
            for aid in list(conn.agent_ids):
                if self._daemon_by_agent.get(aid) is conn:
                    self._daemon_by_agent.pop(aid, None)
            conn.agent_ids.clear()
            self._drop_rtc_sessions_for_daemon_locked(conn)

    def _drop_rtc_sessions_for_daemon_locked(
        self, conn: DaemonConn, *, include_host: bool = True
    ) -> None:
        stale = [
            session_id
            for session_id, binding in self._rtc_sessions.items()
            if binding.daemon is conn and (include_host or binding.scope_type != "host")
        ]
        for session_id in stale:
            self._rtc_sessions.pop(session_id, None)

    async def accept_daemon_owner(self, conn: DaemonConn, generation: int) -> DaemonOwnerAcceptance:
        """Atomically expose a fully claimed daemon to local routing.

        Authenticated sockets remain absent from the broker until their durable
        generation and distributed presence lease have both been established.
        This transition is therefore also the one place where an accepted local
        predecessor may be superseded.
        """
        superseded: DaemonConn | None = None
        async with self._lock:
            if conn.host_generation != generation:
                return DaemonOwnerAcceptance(False)
            current = self._accepted_daemon_owners.get(conn.host_id)
            if current is not None and (
                current[1] > generation or (current[1] == generation and current[0] != conn.id)
            ):
                return DaemonOwnerAcceptance(False)

            existing = self._daemons_by_host.get(conn.host_id)
            superseded_connection_id: str | None = None
            if existing is not None and existing is not conn:
                superseded = existing
                superseded_connection_id = existing.id
                for aid in list(existing.agent_ids):
                    if self._daemon_by_agent.get(aid) is existing:
                        self._daemon_by_agent.pop(aid, None)
                existing.agent_ids.clear()
                self._drop_rtc_sessions_for_daemon_locked(existing, include_host=False)

            self._daemons_by_host[conn.host_id] = conn
            self._accepted_daemon_owners[conn.host_id] = (conn.id, generation)
        await self._close_superseded(superseded)
        return DaemonOwnerAcceptance(True, superseded_connection_id)

    async def is_accepted_daemon_owner(self, conn: DaemonConn, generation: int) -> bool:
        async with self._lock:
            return self._is_accepted_daemon_owner_locked(conn, generation)

    def _is_accepted_daemon_owner_locked(self, conn: DaemonConn, generation: int) -> bool:
        return (
            self._daemons_by_host.get(conn.host_id) is conn
            and conn.host_generation == generation
            and self._accepted_daemon_owners.get(conn.host_id) == (conn.id, generation)
        )

    async def attach_agent_to_daemon(
        self,
        agent_id: str,
        conn: DaemonConn,
        *,
        expected_host_generation: int | None = None,
    ) -> bool:
        async with self._lock:
            if expected_host_generation is not None and not (
                self._daemons_by_host.get(conn.host_id) is conn
                and conn.host_generation == expected_host_generation
                and self._accepted_daemon_owners.get(conn.host_id)
                == (conn.id, expected_host_generation)
            ):
                return False
            conn.agent_ids.add(agent_id)
            self._daemon_by_agent[agent_id] = conn
            return True

    async def detach_agent(
        self,
        agent_id: str,
        *,
        expected_daemon: DaemonConn | None = None,
        expected_host_generation: int | None = None,
    ) -> bool:
        async with self._lock:
            conn = self._daemon_by_agent.get(agent_id)
            if expected_daemon is not None and (
                conn is not expected_daemon
                or expected_host_generation is None
                or not self._is_accepted_daemon_owner_locked(
                    expected_daemon, expected_host_generation
                )
            ):
                return False
            conn = self._daemon_by_agent.pop(agent_id, None)
            if conn is not None:
                conn.agent_ids.discard(agent_id)
            return conn is not None

    def get_daemon_for_host(self, host_id: str) -> DaemonConn | None:
        return self._daemons_by_host.get(host_id)

    def get_daemon_for_agent(self, agent_id: str) -> DaemonConn | None:
        return self._daemon_by_agent.get(agent_id)

    # ---- browser attach ----

    async def attach_browser(
        self,
        conn: BrowserConn,
        *,
        cols: int | None = None,
        rows: int | None = None,
    ) -> BrowserDisplayState:
        async with self._lock:
            browsers = self._browsers_by_agent[conn.agent_id]
            browsers.add(conn)
            state = self._display_by_agent.setdefault(conn.agent_id, _DisplayState())
            self._drop_stale_display_owner_locked(conn.agent_id, state)
            if state.owner_conn_id is None:
                state.owner_conn_id = conn.id
                if cols is not None and rows is not None:
                    state.cols = cols
                    state.rows = rows
            elif state.cols is None and cols is not None and rows is not None:
                state.cols = cols
                state.rows = rows
            return self._browser_display_state_locked(conn, state)

    async def detach_browser(self, conn: BrowserConn) -> BrowserDisplayState | None:
        async with self._lock:
            browsers = self._browsers_by_agent.get(conn.agent_id)
            if browsers is not None:
                browsers.discard(conn)
                if not browsers:
                    self._browsers_by_agent.pop(conn.agent_id, None)
            state = self._display_by_agent.get(conn.agent_id)
            if state is None:
                return None
            if state.owner_conn_id == conn.id:
                state.owner_conn_id = None
            self._drop_stale_display_owner_locked(conn.agent_id, state)
            self._promote_display_owner_locked(conn.agent_id, state)
            return self._browser_display_state_locked(conn, state)

    def browsers_for(self, agent_id: str) -> list[BrowserConn]:
        return list(self._browsers_by_agent.get(agent_id, ()))

    async def register_rtc_session(
        self,
        session_id: str,
        conn: BrowserConn | HostBrowserConn | RedisBrowserConn,
        *,
        daemon: DaemonConn,
        scope_type: str,
        scope_id: str,
        protocol: str,
        protocol_version: int,
        ttl_seconds: int | None = None,
        now: float | None = None,
    ) -> bool:
        async with self._lock:
            now = time.monotonic() if now is None else now
            self._prune_expired_rtc_sessions_locked(now)
            if session_id in self._rtc_sessions:
                return False
            if scope_type == "host":
                from .host_signal import (
                    MAX_HOST_RTC_SESSIONS_PER_BROWSER,
                    MAX_HOST_RTC_SESSIONS_PER_DAEMON,
                    MAX_HOST_RTC_SESSIONS_PER_HOST,
                )

                host_bindings = [
                    binding
                    for binding in self._rtc_sessions.values()
                    if binding.scope_type == "host" and binding.scope_id == scope_id
                ]
                if len(host_bindings) >= MAX_HOST_RTC_SESSIONS_PER_HOST:
                    return False
                if (
                    sum(binding.daemon is daemon for binding in host_bindings)
                    >= MAX_HOST_RTC_SESSIONS_PER_DAEMON
                ):
                    return False
                if (
                    sum(binding.browser.route_id == conn.route_id for binding in host_bindings)
                    >= MAX_HOST_RTC_SESSIONS_PER_BROWSER
                ):
                    return False
            self._rtc_sessions[session_id] = RtcSessionBinding(
                session_id=session_id,
                browser=conn,
                daemon=daemon,
                scope_type=scope_type,
                scope_id=scope_id,
                protocol=protocol,
                protocol_version=protocol_version,
                expires_at=float("inf") if ttl_seconds is None else now + ttl_seconds,
            )
            return True

    async def unregister_rtc_session(
        self,
        session_id: str,
        conn: BrowserConn | HostBrowserConn | RedisBrowserConn | None = None,
    ) -> None:
        async with self._lock:
            current = self._rtc_sessions.get(session_id)
            if current is not None and (conn is None or current.browser is conn):
                self._rtc_sessions.pop(session_id, None)

    async def unregister_rtc_sessions_for(
        self, conn: BrowserConn | HostBrowserConn | RedisBrowserConn
    ) -> list[RtcSessionBinding]:
        async with self._lock:
            sessions = [
                (session_id, binding)
                for session_id, binding in self._rtc_sessions.items()
                if binding.browser is conn
            ]
            for session_id, _ in sessions:
                self._rtc_sessions.pop(session_id, None)
            return [binding for _, binding in sessions]

    async def rtc_session_for(
        self,
        session_id: str,
        *,
        browser: BrowserConn | HostBrowserConn | RedisBrowserConn | None = None,
        daemon: DaemonConn | None = None,
        now: float | None = None,
    ) -> RtcSessionBinding | None:
        async with self._lock:
            self._prune_expired_rtc_sessions_locked(time.monotonic() if now is None else now)
            binding = self._rtc_sessions.get(session_id)
            if binding is None:
                return None
            if browser is not None and binding.browser is not browser:
                return None
            if daemon is not None and binding.daemon is not daemon:
                return None
            return binding

    def _prune_expired_rtc_sessions_locked(self, now: float) -> None:
        expired = [
            session_id
            for session_id, binding in self._rtc_sessions.items()
            if binding.expires_at <= now
        ]
        for session_id in expired:
            self._rtc_sessions.pop(session_id, None)

    async def expire_rtc_session(self, session_id: str, expected: RtcSessionBinding) -> bool:
        async with self._lock:
            current = self._rtc_sessions.get(session_id)
            if current is not expected:
                return False
            self._rtc_sessions.pop(session_id, None)
            return True

    async def mark_rtc_session_connected(
        self, session_id: str, expected: RtcSessionBinding
    ) -> RtcSessionBinding | None:
        """Extend a token-dispatched session without making it immortal."""
        from .host_signal import RTC_CONNECTED_SESSION_TTL_SECONDS

        async with self._lock:
            current = self._rtc_sessions.get(session_id)
            if current is not expected:
                return None
            connected = replace(
                current,
                expires_at=time.monotonic() + RTC_CONNECTED_SESSION_TTL_SECONDS,
            )
            self._rtc_sessions[session_id] = connected
            return connected

    async def rtc_sessions_for_daemon(self, daemon: DaemonConn) -> list[RtcSessionBinding]:
        async with self._lock:
            self._prune_expired_rtc_sessions_locked(time.monotonic())
            return [binding for binding in self._rtc_sessions.values() if binding.daemon is daemon]

    async def browser_for_rtc_session(
        self, session_id: str
    ) -> BrowserConn | HostBrowserConn | RedisBrowserConn | None:
        binding = await self.rtc_session_for(session_id)
        return binding.browser if binding is not None else None

    async def update_display_size(
        self,
        conn: BrowserConn,
        *,
        cols: int,
        rows: int,
    ) -> BrowserDisplayState | None:
        async with self._lock:
            state = self._display_by_agent.setdefault(conn.agent_id, _DisplayState())
            self._drop_stale_display_owner_locked(conn.agent_id, state)
            self._promote_display_owner_locked(conn.agent_id, state, preferred=conn)
            if state.owner_conn_id != conn.id:
                return None
            changed = state.cols != cols or state.rows != rows
            state.cols = cols
            state.rows = rows
            return self._browser_display_state_locked(conn, state, changed=changed)

    async def take_display_control(
        self,
        conn: BrowserConn,
        *,
        cols: int,
        rows: int,
    ) -> BrowserDisplayState:
        async with self._lock:
            browsers = self._browsers_by_agent[conn.agent_id]
            browsers.add(conn)
            state = self._display_by_agent.setdefault(conn.agent_id, _DisplayState())
            state.owner_conn_id = conn.id
            state.cols = cols
            state.rows = rows
            return self._browser_display_state_locked(conn, state)

    async def display_states_for_agent(
        self, agent_id: str
    ) -> list[tuple[BrowserConn, BrowserDisplayState]]:
        async with self._lock:
            state = self._display_by_agent.setdefault(agent_id, _DisplayState())
            self._drop_stale_display_owner_locked(agent_id, state)
            self._promote_display_owner_locked(agent_id, state)
            return [
                (conn, self._browser_display_state_locked(conn, state))
                for conn in self._browsers_by_agent.get(agent_id, ())
            ]

    def _drop_stale_display_owner_locked(self, agent_id: str, state: _DisplayState) -> None:
        if state.owner_conn_id is None:
            return
        if any(
            conn.id == state.owner_conn_id for conn in self._browsers_by_agent.get(agent_id, ())
        ):
            return
        state.owner_conn_id = None

    def _promote_display_owner_locked(
        self,
        agent_id: str,
        state: _DisplayState,
        *,
        preferred: BrowserConn | None = None,
    ) -> None:
        if state.owner_conn_id is not None:
            return
        browsers = self._browsers_by_agent.get(agent_id)
        if not browsers:
            return
        owner = preferred if preferred in browsers else next(iter(browsers))
        state.owner_conn_id = owner.id

    def _browser_display_state_locked(
        self, conn: BrowserConn, state: _DisplayState, *, changed: bool = False
    ) -> BrowserDisplayState:
        return BrowserDisplayState(
            owner=state.owner_conn_id == conn.id,
            cols=state.cols,
            rows=state.rows,
            viewers=len(self._browsers_by_agent.get(conn.agent_id, ())),
            changed=changed,
        )

    async def request_snapshot(
        self,
        agent_id: str,
        daemon: DaemonConn,
        *,
        lines: int = 5000,
        plain: bool = False,
        timeout: float = 2.0,
        rtc_session_id: str | None = None,
    ) -> dict | None:
        request_id = str(uuid.uuid4())
        payload: dict[str, object] = {
            "type": "agent.snapshot",
            "request_id": request_id,
            "agent_id": agent_id,
            "lines": lines,
        }
        if plain:
            payload["plain"] = True
        if rtc_session_id:
            payload["rtc_session_id"] = rtc_session_id
        return await self._request_owner_result(
            daemon,
            "agent.snapshot",
            request_id,
            payload,
            timeout=timeout,
        )

    async def resolve_snapshot(
        self,
        agent_id: str,
        payload: dict,
        *,
        daemon: DaemonConn | None = None,
        expected_host_generation: int | None = None,
    ) -> bool:
        request_id = payload.get("request_id")
        if not isinstance(request_id, str) or daemon is None:
            return False
        return await self._publish_owner_result(
            daemon,
            expected_host_generation,
            "agent.snapshot",
            request_id,
            payload,
        )

    async def request_dir_list(
        self,
        daemon: DaemonConn,
        *,
        path: str | None = None,
        include_files: bool = False,
        timeout: float = 3.0,
    ) -> dict | None:
        request_id = str(uuid.uuid4())
        payload: dict[str, object] = {"type": "host.fs.list", "request_id": request_id}
        if path is not None:
            payload["path"] = path
        if include_files:
            payload["include_files"] = True
        return await self._request_owner_result(
            daemon,
            "host.fs.list_result",
            request_id,
            payload,
            timeout=timeout,
        )

    async def resolve_dir_list(
        self,
        request_id: str,
        payload: dict,
        *,
        daemon: DaemonConn | None = None,
        expected_host_generation: int | None = None,
    ) -> bool:
        if daemon is None:
            return False
        return await self._publish_owner_result(
            daemon,
            expected_host_generation,
            "host.fs.list_result",
            request_id,
            payload,
        )

    async def _request_fs(
        self,
        daemon: DaemonConn,
        payload: dict[str, object],
        *,
        timeout: float,
    ) -> dict | None:
        request_id = str(uuid.uuid4())
        payload["request_id"] = request_id
        return await self._request_owner_result(
            daemon,
            "host.fs.result",
            request_id,
            payload,
            timeout=timeout,
        )

    async def request_fs_read(
        self, daemon: DaemonConn, *, path: str, timeout: float = 60.0
    ) -> dict | None:
        return await self._request_fs(
            daemon, {"type": "host.fs.read", "path": path}, timeout=timeout
        )

    async def request_fs_write(
        self,
        daemon: DaemonConn,
        *,
        dir: str,
        name: str,
        bytes_b64: str,
        overwrite: bool = False,
        timeout: float = 60.0,
    ) -> dict | None:
        return await self._request_fs(
            daemon,
            {
                "type": "host.fs.write",
                "dir": dir,
                "name": name,
                "bytes_b64": bytes_b64,
                "overwrite": overwrite,
            },
            timeout=timeout,
        )

    async def request_fs_mkdir(
        self, daemon: DaemonConn, *, path: str, timeout: float = 10.0
    ) -> dict | None:
        return await self._request_fs(
            daemon, {"type": "host.fs.mkdir", "path": path}, timeout=timeout
        )

    async def request_fs_rename(
        self, daemon: DaemonConn, *, path: str, name: str, timeout: float = 10.0
    ) -> dict | None:
        return await self._request_fs(
            daemon, {"type": "host.fs.rename", "path": path, "name": name}, timeout=timeout
        )

    async def request_fs_remove(
        self, daemon: DaemonConn, *, path: str, recursive: bool = False, timeout: float = 30.0
    ) -> dict | None:
        return await self._request_fs(
            daemon,
            {"type": "host.fs.remove", "path": path, "recursive": recursive},
            timeout=timeout,
        )

    async def resolve_fs_result(
        self,
        request_id: str,
        payload: dict,
        *,
        daemon: DaemonConn | None = None,
        expected_host_generation: int | None = None,
    ) -> bool:
        if daemon is None:
            return False
        return await self._publish_owner_result(
            daemon,
            expected_host_generation,
            "host.fs.result",
            request_id,
            payload,
        )

    async def request_tool_check(
        self,
        daemon: DaemonConn,
        *,
        targets: list[dict],
        timeout: float = 15.0,
    ) -> dict | None:
        request_id = str(uuid.uuid4())
        return await self._request_owner_result(
            daemon,
            "host.tools.check_result",
            request_id,
            {
                "type": "host.tools.check",
                "request_id": request_id,
                "targets": targets,
            },
            timeout=timeout,
        )

    async def resolve_tool_check(
        self,
        request_id: str,
        payload: dict,
        *,
        daemon: DaemonConn | None = None,
        expected_host_generation: int | None = None,
    ) -> bool:
        if daemon is None:
            return False
        return await self._publish_owner_result(
            daemon,
            expected_host_generation,
            "host.tools.check_result",
            request_id,
            payload,
        )

    async def request_tool_install(
        self,
        daemon: DaemonConn,
        *,
        target: dict,
        timeout: float = 180.0,
    ) -> dict | None:
        request_id = str(uuid.uuid4())
        return await self._request_owner_result(
            daemon,
            "host.tools.install_result",
            request_id,
            {
                "type": "host.tools.install",
                "request_id": request_id,
                "target": target,
            },
            timeout=timeout,
        )

    async def resolve_tool_install(
        self,
        request_id: str,
        payload: dict,
        *,
        daemon: DaemonConn | None = None,
        expected_host_generation: int | None = None,
    ) -> bool:
        if daemon is None:
            return False
        return await self._publish_owner_result(
            daemon,
            expected_host_generation,
            "host.tools.install_result",
            request_id,
            payload,
        )

    async def request_upload(
        self,
        agent_id: str,
        daemon: DaemonConn,
        *,
        payload: dict,
        client_id: str,
        timeout: float = 30.0,
    ) -> dict | None:
        request_id = str(uuid.uuid4())
        payload["request_id"] = request_id
        return await self._request_owner_result(
            daemon,
            "agent.uploaded",
            request_id,
            payload,
            timeout=timeout,
        )

    async def resolve_upload(
        self,
        agent_id: str,
        request_id: str | None,
        payload: dict,
        *,
        daemon: DaemonConn | None = None,
        expected_host_generation: int | None = None,
    ) -> UploadResolution:
        if not request_id:
            return UploadResolution.NO_WAITER
        if daemon is None:
            return UploadResolution.STALE_OWNER
        published = await self._publish_owner_result(
            daemon,
            expected_host_generation,
            "agent.uploaded",
            request_id,
            payload,
        )
        return UploadResolution.RESOLVED if published else UploadResolution.STALE_OWNER

    async def _request_owner_result(
        self,
        daemon: DaemonConn,
        kind: str,
        request_id: str,
        request: dict[str, object],
        *,
        timeout: float,
    ) -> dict | None:
        generation = daemon.host_generation
        if generation is None:
            return None
        channel = owner_result_channel(daemon.host_id, kind, request_id)
        async with get_backend().subscribe_channel(channel) as stream:
            await daemon.send_text(request)
            try:
                async with asyncio.timeout(timeout):
                    async for raw in stream:
                        envelope = decode_owner_result(raw)
                        if envelope is None or not (
                            envelope.host_id == daemon.host_id
                            and envelope.daemon_connection_id == daemon.id
                            and envelope.daemon_generation == generation
                            and envelope.kind == kind
                            and envelope.request_id == request_id
                        ):
                            continue
                        return envelope.payload
            except TimeoutError:
                return None
        return None

    @staticmethod
    async def _publish_owner_result(
        daemon: DaemonConn,
        expected_host_generation: int | None,
        kind: str,
        request_id: str,
        payload: dict,
    ) -> bool:
        generation = daemon.host_generation
        if (
            expected_host_generation is None
            or generation != expected_host_generation
            or generation < 1
        ):
            return False
        return await publish_owner_result(
            OwnerResultEnvelope(
                host_id=daemon.host_id,
                daemon_connection_id=daemon.id,
                daemon_generation=generation,
                kind=kind,
                request_id=request_id,
                payload=payload,
            )
        )


_broker = Broker()


def get_broker() -> Broker:
    return _broker
