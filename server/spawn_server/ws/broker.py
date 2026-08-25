"""In-process ownership and content-free control/signaling routing."""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING

from ..redis import get_backend
from .owner_dispatch import (
    OwnerResultEnvelope,
    decode_owner_result,
    owner_result_channel,
    publish_owner_result,
)
from .signed_signal_relay import SIGNED_ENVELOPE_FIELD

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
    session_ids: set[str] = field(default_factory=set)
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    superseded_close_started: bool = False
    rtc_revocation_started: bool = False

    async def send_text(self, payload: dict) -> None:
        async with self.send_lock:
            await self.websocket.send_text(
                json.dumps(payload, ensure_ascii=SIGNED_ENVELOPE_FIELD not in payload)
            )

@dataclass(eq=False)
class BrowserConn:
    user_id: str
    session_id: str
    websocket: WebSocket
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def send_text(self, payload: dict) -> None:
        async with self.send_lock:
            await self.websocket.send_text(
                json.dumps(payload, ensure_ascii=SIGNED_ENVELOPE_FIELD not in payload)
            )

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
            await self.websocket.send_text(
                json.dumps(payload, ensure_ascii=SIGNED_ENVELOPE_FIELD not in payload)
            )

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
    daemon_connection_id: str
    daemon_generation: int
    nonce: str
    expires_at: float
    # Selected by the initiating offer and immutable for this RTC generation.
    # A signed session must never accept or forward a legacy raw-SDP answer.
    signed_signal: bool = False


@dataclass(frozen=True)
class DaemonOwnerAcceptance:
    accepted: bool
    superseded_connection_id: str | None = None

    def __bool__(self) -> bool:
        return self.accepted


class Broker:
    def __init__(self) -> None:
        self._daemons_by_host: dict[str, DaemonConn] = {}
        self._accepted_daemon_owners: dict[str, tuple[str, int]] = {}
        self._daemon_by_session: dict[str, DaemonConn] = {}
        self._rtc_sessions: dict[str, RtcSessionBinding] = {}
        self._retired_rtc_bindings: dict[tuple[str, str, int, str], float] = {}
        self._rtc_tombstone_cleanup_task: asyncio.Task[None] | None = None
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
                for sid in list(existing.session_ids):
                    self._daemon_by_session.pop(sid, None)
                existing.session_ids.clear()
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
            for sid in list(conn.session_ids):
                if self._daemon_by_session.get(sid) is conn:
                    self._daemon_by_session.pop(sid, None)
            conn.session_ids.clear()
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
            binding = self._rtc_sessions.get(session_id)
            if binding is not None and self._retire_rtc_binding_locked(binding):
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
                for sid in list(existing.session_ids):
                    if self._daemon_by_session.get(sid) is existing:
                        self._daemon_by_session.pop(sid, None)
                existing.session_ids.clear()
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

    async def attach_session_to_daemon(
        self,
        session_id: str,
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
            conn.session_ids.add(session_id)
            self._daemon_by_session[session_id] = conn
            return True

    async def detach_session(
        self,
        session_id: str,
        *,
        expected_daemon: DaemonConn | None = None,
        expected_host_generation: int | None = None,
    ) -> bool:
        async with self._lock:
            conn = self._daemon_by_session.get(session_id)
            if expected_daemon is not None and (
                conn is not expected_daemon
                or expected_host_generation is None
                or not self._is_accepted_daemon_owner_locked(
                    expected_daemon, expected_host_generation
                )
            ):
                return False
            conn = self._daemon_by_session.pop(session_id, None)
            if conn is not None:
                conn.session_ids.discard(session_id)
            return conn is not None

    def get_daemon_for_host(self, host_id: str) -> DaemonConn | None:
        return self._daemons_by_host.get(host_id)

    def get_daemon_for_session(self, session_id: str) -> DaemonConn | None:
        return self._daemon_by_session.get(session_id)

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
        binding_nonce: str | None = None,
        signed_signal: bool = False,
        ttl_seconds: int | None = None,
        now: float | None = None,
    ) -> bool:
        async with self._lock:
            now = time.monotonic() if now is None else now
            self._prune_expired_rtc_sessions_locked(now)
            generation = daemon.host_generation if daemon.host_generation is not None else 0
            from .host_signal import (
                MAX_RTC_BINDING_IDENTITIES,
                new_rtc_binding_nonce,
                valid_rtc_binding_nonce,
            )

            nonce = binding_nonce or new_rtc_binding_nonce()
            if not valid_rtc_binding_nonce(nonce):
                return False
            route_nonce = getattr(conn, "binding_nonce", nonce)
            if route_nonce != nonce:
                return False
            identity = (session_id, daemon.id, generation, nonce)
            # A retired identity is an immutable generation. Reinstalling it
            # would make delayed frames indistinguishable from current ones,
            # even if the entry existed only until the caller's follow-up
            # lookup. Reject it before mutating the live-session map.
            if identity in self._retired_rtc_bindings:
                return False
            if (
                len(self._rtc_sessions) + len(self._retired_rtc_bindings)
                >= MAX_RTC_BINDING_IDENTITIES
            ):
                return False
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
                daemon_connection_id=daemon.id,
                daemon_generation=generation,
                nonce=nonce,
                expires_at=float("inf") if ttl_seconds is None else now + ttl_seconds,
                signed_signal=signed_signal,
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
                if self._retire_rtc_binding_locked(current):
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
            removed: list[RtcSessionBinding] = []
            for session_id, binding in sessions:
                if self._retire_rtc_binding_locked(binding):
                    self._rtc_sessions.pop(session_id, None)
                    removed.append(binding)
            return removed

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
        self._prune_rtc_tombstones_locked(now)
        expired = [
            session_id
            for session_id, binding in self._rtc_sessions.items()
            if binding.expires_at <= now
        ]
        for session_id in expired:
            binding = self._rtc_sessions.get(session_id)
            if binding is not None and self._retire_rtc_binding_locked(binding, now=now):
                self._rtc_sessions.pop(session_id, None)

    @staticmethod
    def _rtc_binding_identity(binding: RtcSessionBinding) -> tuple[str, str, int, str]:
        return (
            binding.session_id,
            binding.daemon_connection_id,
            binding.daemon_generation,
            binding.nonce,
        )

    def _retire_rtc_binding_locked(
        self, binding: RtcSessionBinding, *, now: float | None = None
    ) -> bool:
        from .host_signal import (
            MAX_RTC_BINDING_IDENTITIES,
            RTC_BINDING_TOMBSTONE_TTL_SECONDS,
        )

        timestamp = time.monotonic() if now is None else now
        identity = self._rtc_binding_identity(binding)
        if (
            identity not in self._retired_rtc_bindings
            and len(self._retired_rtc_bindings) >= MAX_RTC_BINDING_IDENTITIES
        ):
            return False
        self._retired_rtc_bindings[identity] = (
            timestamp + RTC_BINDING_TOMBSTONE_TTL_SECONDS
        )
        self._schedule_rtc_tombstone_cleanup_locked()
        return True

    def _prune_rtc_tombstones_locked(self, now: float) -> None:
        for identity in [
            identity
            for identity, expires_at in self._retired_rtc_bindings.items()
            if expires_at <= now
        ]:
            self._retired_rtc_bindings.pop(identity, None)

    def _schedule_rtc_tombstone_cleanup_locked(self) -> None:
        if (
            self._rtc_tombstone_cleanup_task is None
            or self._rtc_tombstone_cleanup_task.done()
        ):
            self._rtc_tombstone_cleanup_task = asyncio.create_task(
                self._rtc_tombstone_cleanup_loop()
            )

    async def _rtc_tombstone_cleanup_loop(self) -> None:
        current_task = asyncio.current_task()
        try:
            while True:
                async with self._lock:
                    now = time.monotonic()
                    self._prune_expired_rtc_sessions_locked(now)
                    if not self._retired_rtc_bindings:
                        return
                    delay = max(
                        0.0,
                        min(self._retired_rtc_bindings.values()) - time.monotonic(),
                    )
                await asyncio.sleep(delay)
        finally:
            if self._rtc_tombstone_cleanup_task is current_task:
                self._rtc_tombstone_cleanup_task = None

    async def shutdown(self) -> None:
        task = self._rtc_tombstone_cleanup_task
        self._rtc_tombstone_cleanup_task = None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        async with self._lock:
            self._rtc_sessions.clear()
            self._retired_rtc_bindings.clear()

    def _rtc_binding_is_current_locked(self, binding: RtcSessionBinding) -> bool:
        return (
            self._rtc_sessions.get(binding.session_id) is binding
            and self._rtc_binding_identity(binding) not in self._retired_rtc_bindings
        )

    async def rtc_session_is_current(self, binding: RtcSessionBinding) -> bool:
        async with self._lock:
            now = time.monotonic()
            self._prune_expired_rtc_sessions_locked(now)
            return self._rtc_binding_is_current_locked(binding)

    async def rtc_binding_identity_is_retired(
        self,
        session_id: str,
        daemon: DaemonConn,
        binding_nonce: str,
    ) -> bool:
        """Recognize an exact retired binding for delayed teardown only."""
        generation = daemon.host_generation
        if generation is None:
            return False
        async with self._lock:
            self._prune_rtc_tombstones_locked(time.monotonic())
            return (
                session_id,
                daemon.id,
                generation,
                binding_nonce,
            ) in self._retired_rtc_bindings

    async def expire_rtc_session(self, session_id: str, expected: RtcSessionBinding) -> bool:
        async with self._lock:
            current = self._rtc_sessions.get(session_id)
            if current is not expected:
                return False
            if not self._retire_rtc_binding_locked(current):
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
            if current is not expected or not self._rtc_binding_is_current_locked(expected):
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

    async def request_agent_check(
        self,
        daemon: DaemonConn,
        *,
        targets: list[dict],
        timeout: float = 15.0,
    ) -> dict | None:
        request_id = str(uuid.uuid4())
        return await self._request_owner_result(
            daemon,
            "host.agents.check_result",
            request_id,
            {
                "type": "host.agents.check",
                "request_id": request_id,
                "targets": targets,
            },
            timeout=timeout,
        )

    async def request_host_ping(
        self,
        daemon: DaemonConn,
        *,
        timeout: float = 3.0,
    ) -> bool:
        request_id = str(uuid.uuid4())
        result = await self._request_owner_result(
            daemon,
            "host.pong",
            request_id,
            {"type": "host.ping", "request_id": request_id},
            timeout=timeout,
        )
        return result == {"type": "host.pong", "request_id": request_id}

    async def request_daemon_update(
        self,
        daemon: DaemonConn,
        payload: dict[str, object],
        *,
        timeout: float = 3.0,
    ) -> bool:
        """Bounded fire-and-forget delivery to the accepted daemon owner."""

        generation = daemon.host_generation
        if generation is None or not await self.is_accepted_daemon_owner(daemon, generation):
            return False
        try:
            await asyncio.wait_for(daemon.send_text(payload), timeout=timeout)
        except Exception:
            return False
        return await self.is_accepted_daemon_owner(daemon, generation)

    async def resolve_host_pong(
        self,
        request_id: str,
        payload: dict,
        *,
        daemon: DaemonConn | None = None,
        expected_host_generation: int | None = None,
    ) -> bool:
        if daemon is None or payload != {"type": "host.pong", "request_id": request_id}:
            return False
        return await self._publish_owner_result(
            daemon,
            expected_host_generation,
            "host.pong",
            request_id,
            payload,
        )

    async def resolve_agent_check(
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
            "host.agents.check_result",
            request_id,
            payload,
        )

    async def request_agent_install(
        self,
        daemon: DaemonConn,
        *,
        target: dict,
        timeout: float = 180.0,
    ) -> dict | None:
        request_id = str(uuid.uuid4())
        return await self._request_owner_result(
            daemon,
            "host.agents.install_result",
            request_id,
            {
                "type": "host.agents.install",
                "request_id": request_id,
                "target": target,
            },
            timeout=timeout,
        )

    async def resolve_agent_install(
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
            "host.agents.install_result",
            request_id,
            payload,
        )

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
        if generation is None or not await self.is_accepted_daemon_owner(daemon, generation):
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
