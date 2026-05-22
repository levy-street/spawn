"""Routing between daemon WS and browser WSs.

The in-process maps are the local fast path. Redis channels carry PTY output,
agent text events, host command envelopes, and request/response frames so
browser and REST traffic can land on a different worker than the daemon WS.
"""

from __future__ import annotations

import asyncio
import base64
import json
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from ..redis import get_backend

if TYPE_CHECKING:
    from fastapi import WebSocket


@dataclass(eq=False)
class DaemonConn:
    host_id: str
    user_id: str
    websocket: WebSocket
    home_dir: str | None = None
    agent_ids: set[str] = field(default_factory=set)
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    command_task: asyncio.Task[None] | None = None

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


class Broker:
    def __init__(self) -> None:
        self._daemons_by_host: dict[str, DaemonConn] = {}
        self._daemon_by_agent: dict[str, DaemonConn] = {}
        self._browsers_by_agent: dict[str, set[BrowserConn]] = defaultdict(set)
        self._display_by_agent: dict[str, _DisplayState] = {}
        self._snapshot_waiters: dict[str, asyncio.Future[str]] = {}
        self._legacy_snapshot_waiters: dict[str, set[asyncio.Future[str]]] = defaultdict(set)
        self._dir_list_waiters: dict[str, asyncio.Future[dict]] = {}
        self._tool_check_waiters: dict[str, asyncio.Future[dict]] = {}
        self._tool_install_waiters: dict[str, asyncio.Future[dict]] = {}
        self._daemon_status_waiters: dict[str, asyncio.Future[dict]] = {}
        self._lock = asyncio.Lock()

    # ---- daemon registration ----

    async def register_daemon(self, conn: DaemonConn) -> None:
        async with self._lock:
            existing = self._daemons_by_host.get(conn.host_id)
            if existing is not None and existing is not conn:
                # Drop the stale connection (best-effort).
                try:
                    await existing.websocket.close(code=4000, reason="superseded")
                except Exception:
                    pass
                for aid in list(existing.agent_ids):
                    self._daemon_by_agent.pop(aid, None)
                self._stop_command_task(existing)
            self._daemons_by_host[conn.host_id] = conn
            if get_backend().available:
                conn.command_task = asyncio.create_task(self._pump_host_commands(conn))

    async def unregister_daemon(self, conn: DaemonConn) -> None:
        async with self._lock:
            if self._daemons_by_host.get(conn.host_id) is conn:
                self._daemons_by_host.pop(conn.host_id, None)
                self._stop_command_task(conn)
            for aid in list(conn.agent_ids):
                if self._daemon_by_agent.get(aid) is conn:
                    self._daemon_by_agent.pop(aid, None)

    async def attach_agent_to_daemon(self, agent_id: str, conn: DaemonConn) -> None:
        async with self._lock:
            conn.agent_ids.add(agent_id)
            self._daemon_by_agent[agent_id] = conn

    async def detach_agent(self, agent_id: str) -> None:
        async with self._lock:
            conn = self._daemon_by_agent.pop(agent_id, None)
            if conn is not None:
                conn.agent_ids.discard(agent_id)

    def get_daemon_for_host(self, host_id: str) -> DaemonConn | None:
        return self._daemons_by_host.get(host_id)

    def get_daemon_for_agent(self, agent_id: str) -> DaemonConn | None:
        return self._daemon_by_agent.get(agent_id)

    def _stop_command_task(self, conn: DaemonConn) -> None:
        task = conn.command_task
        conn.command_task = None
        if task is not None and not task.done():
            task.cancel()

    async def _pump_host_commands(self, conn: DaemonConn) -> None:
        try:
            async with get_backend().subscribe_host_commands(conn.host_id) as stream:
                async for envelope in stream:
                    async with self._lock:
                        active = self._daemons_by_host.get(conn.host_id) is conn
                    if not active:
                        return
                    kind = envelope.get("kind")
                    if kind == "text":
                        payload = envelope.get("payload")
                        if isinstance(payload, dict):
                            await conn.send_text(payload)
                    elif kind == "binary":
                        payload_b64 = envelope.get("payload_b64")
                        if isinstance(payload_b64, str):
                            await conn.send_bytes(base64.b64decode(payload_b64))
        except asyncio.CancelledError:
            return
        except Exception:
            # The daemon websocket heartbeat will keep running. If the command
            # subscription dies, restart it on the same connection.
            async with self._lock:
                active = self._daemons_by_host.get(conn.host_id) is conn
            if active:
                conn.command_task = asyncio.create_task(self._pump_host_commands(conn))

    async def send_text_to_host(self, host_id: str, payload: dict) -> bool:
        daemon = self.get_daemon_for_host(host_id)
        if daemon is not None:
            await daemon.send_text(payload)
            return True
        subscribers = await get_backend().publish_host_command(
            host_id,
            {"kind": "text", "payload": payload},
        )
        return subscribers > 0

    async def send_text_to_agent(self, agent_id: str, host_id: str, payload: dict) -> bool:
        daemon = self.get_daemon_for_agent(agent_id) or self.get_daemon_for_host(host_id)
        if daemon is not None:
            await daemon.send_text(payload)
            return True
        return await self.send_text_to_host(host_id, payload)

    async def send_bytes_to_agent(self, agent_id: str, host_id: str, payload: bytes) -> bool:
        daemon = self.get_daemon_for_agent(agent_id) or self.get_daemon_for_host(host_id)
        if daemon is not None:
            await daemon.send_bytes(payload)
            return True
        subscribers = await get_backend().publish_host_command(
            host_id,
            {
                "kind": "binary",
                "payload_b64": base64.b64encode(payload).decode("ascii"),
            },
        )
        return subscribers > 0

    # ---- browser attach ----

    async def attach_browser(
        self,
        conn: BrowserConn,
        *,
        cols: int | None = None,
        rows: int | None = None,
    ) -> BrowserDisplayState:
        if get_backend().available:
            async with self._lock:
                self._browsers_by_agent[conn.agent_id].add(conn)
            state = await get_backend().display_attach(conn.agent_id, conn.id, cols, rows)
            await self.publish_display_state(conn.agent_id, state)
            return self._browser_display_state(conn, state)

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
        if get_backend().available:
            async with self._lock:
                browsers = self._browsers_by_agent.get(conn.agent_id)
                if browsers is not None:
                    browsers.discard(conn)
                    if not browsers:
                        self._browsers_by_agent.pop(conn.agent_id, None)
            state = await get_backend().display_detach(conn.agent_id, conn.id)
            if state is not None:
                await self.publish_display_state(conn.agent_id, state)
                return self._browser_display_state(conn, state)
            return None

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

    async def update_display_size(
        self,
        conn: BrowserConn,
        *,
        cols: int,
        rows: int,
    ) -> BrowserDisplayState | None:
        if get_backend().available:
            state = await get_backend().display_update_size(conn.agent_id, conn.id, cols, rows)
            if state is None:
                return None
            await self.publish_display_state(conn.agent_id, state)
            return self._browser_display_state(conn, state)

        async with self._lock:
            state = self._display_by_agent.setdefault(conn.agent_id, _DisplayState())
            self._drop_stale_display_owner_locked(conn.agent_id, state)
            self._promote_display_owner_locked(conn.agent_id, state, preferred=conn)
            if state.owner_conn_id != conn.id:
                return None
            state.cols = cols
            state.rows = rows
            return self._browser_display_state_locked(conn, state)

    async def take_display_control(
        self,
        conn: BrowserConn,
        *,
        cols: int,
        rows: int,
    ) -> BrowserDisplayState:
        if get_backend().available:
            async with self._lock:
                self._browsers_by_agent[conn.agent_id].add(conn)
            state = await get_backend().display_take_control(conn.agent_id, conn.id, cols, rows)
            await self.publish_display_state(conn.agent_id, state)
            return self._browser_display_state(conn, state)

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
        if get_backend().available:
            state = await get_backend().display_state(agent_id)
            if state is None:
                return []
            async with self._lock:
                conns = list(self._browsers_by_agent.get(agent_id, ()))
            return [(conn, self._browser_display_state(conn, state)) for conn in conns]

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
        self, conn: BrowserConn, state: _DisplayState
    ) -> BrowserDisplayState:
        return BrowserDisplayState(
            owner=state.owner_conn_id == conn.id,
            cols=state.cols,
            rows=state.rows,
            viewers=len(self._browsers_by_agent.get(conn.agent_id, ())),
        )

    def _browser_display_state(self, conn: BrowserConn, state: dict) -> BrowserDisplayState:
        return BrowserDisplayState(
            owner=state.get("owner_conn_id") == conn.id,
            cols=state.get("cols"),
            rows=state.get("rows"),
            viewers=int(state.get("viewers") or 0),
        )

    async def publish_display_state(self, agent_id: str, state: dict) -> None:
        await get_backend().publish_agent_event(
            agent_id,
            {
                "type": "_display.state",
                "owner_conn_id": state.get("owner_conn_id"),
                "cols": state.get("cols"),
                "rows": state.get("rows"),
                "viewers": state.get("viewers") or 0,
            },
        )

    async def request_snapshot(
        self,
        agent_id: str,
        daemon: DaemonConn,
        *,
        lines: int = 5000,
        plain: bool = False,
        timeout: float = 2.0,
    ) -> str | None:
        request_id = str(uuid.uuid4())
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[str] = loop.create_future()
        async with self._lock:
            self._snapshot_waiters[request_id] = fut
            self._legacy_snapshot_waiters[agent_id].add(fut)
        try:
            payload: dict[str, object] = {
                "type": "agent.snapshot",
                "request_id": request_id,
                "agent_id": agent_id,
                "lines": lines,
            }
            if plain:
                payload["plain"] = True
            await daemon.send_text(payload)
            return await asyncio.wait_for(fut, timeout=timeout)
        except TimeoutError:
            return None
        finally:
            async with self._lock:
                if self._snapshot_waiters.get(request_id) is fut:
                    self._snapshot_waiters.pop(request_id, None)
                waiters = self._legacy_snapshot_waiters.get(agent_id)
                if waiters is not None:
                    waiters.discard(fut)
                    if not waiters:
                        self._legacy_snapshot_waiters.pop(agent_id, None)

    async def request_snapshot_for_host(
        self,
        host_id: str,
        agent_id: str,
        *,
        lines: int = 5000,
        plain: bool = False,
        timeout: float = 2.0,
    ) -> str | None:
        daemon = self.get_daemon_for_agent(agent_id) or self.get_daemon_for_host(host_id)
        if daemon is not None:
            return await self.request_snapshot(
                agent_id,
                daemon,
                lines=lines,
                plain=plain,
                timeout=timeout,
            )

        request_id = str(uuid.uuid4())
        payload: dict[str, object] = {
            "type": "agent.snapshot",
            "request_id": request_id,
            "agent_id": agent_id,
            "lines": lines,
        }
        if plain:
            payload["plain"] = True
        result = await self._request_remote_host(host_id, request_id, payload, timeout=timeout)
        if result is None:
            return None
        bytes_b64 = result.get("bytes_b64")
        return bytes_b64 if isinstance(bytes_b64, str) else None

    async def resolve_snapshot(
        self, agent_id: str, bytes_b64: str, request_id: str | None = None
    ) -> None:
        if request_id is not None:
            await get_backend().publish_request_response(
                request_id,
                {
                    "type": "agent.snapshot",
                    "request_id": request_id,
                    "agent_id": agent_id,
                    "bytes_b64": bytes_b64,
                },
            )
        async with self._lock:
            waiters: list[asyncio.Future[str]] = []
            if request_id is not None:
                fut = self._snapshot_waiters.pop(request_id, None)
                if fut is not None:
                    waiters.append(fut)
            if not waiters:
                waiters = list(self._legacy_snapshot_waiters.pop(agent_id, ()))
        for fut in waiters:
            if not fut.done():
                fut.set_result(bytes_b64)

    async def _request_remote_host(
        self,
        host_id: str,
        request_id: str,
        payload: dict[str, object],
        *,
        timeout: float,
    ) -> dict | None:
        try:
            async with get_backend().subscribe_request_response(request_id) as stream:
                subscribers = await get_backend().publish_host_command(
                    host_id,
                    {"kind": "text", "payload": payload},
                )
                if subscribers <= 0:
                    return None
                return await asyncio.wait_for(anext(stream), timeout=timeout)
        except TimeoutError:
            return None

    async def request_dir_list(
        self,
        daemon: DaemonConn,
        *,
        path: str | None = None,
        timeout: float = 3.0,
    ) -> dict | None:
        request_id = str(uuid.uuid4())
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict] = loop.create_future()
        async with self._lock:
            self._dir_list_waiters[request_id] = fut
        try:
            payload: dict[str, object] = {"type": "host.fs.list", "request_id": request_id}
            if path is not None:
                payload["path"] = path
            await daemon.send_text(payload)
            return await asyncio.wait_for(fut, timeout=timeout)
        except TimeoutError:
            return None
        finally:
            async with self._lock:
                if self._dir_list_waiters.get(request_id) is fut:
                    self._dir_list_waiters.pop(request_id, None)

    async def resolve_dir_list(self, request_id: str, payload: dict) -> None:
        await get_backend().publish_request_response(request_id, payload)
        async with self._lock:
            fut = self._dir_list_waiters.pop(request_id, None)
        if fut is not None and not fut.done():
            fut.set_result(payload)

    async def request_dir_list_for_host(
        self,
        host_id: str,
        *,
        path: str | None = None,
        timeout: float = 3.0,
    ) -> dict | None:
        daemon = self.get_daemon_for_host(host_id)
        if daemon is not None:
            return await self.request_dir_list(daemon, path=path, timeout=timeout)
        request_id = str(uuid.uuid4())
        payload: dict[str, object] = {"type": "host.fs.list", "request_id": request_id}
        if path is not None:
            payload["path"] = path
        return await self._request_remote_host(host_id, request_id, payload, timeout=timeout)

    async def request_tool_check(
        self,
        daemon: DaemonConn,
        *,
        targets: list[dict],
        timeout: float = 15.0,
    ) -> dict | None:
        request_id = str(uuid.uuid4())
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict] = loop.create_future()
        async with self._lock:
            self._tool_check_waiters[request_id] = fut
        try:
            await daemon.send_text(
                {
                    "type": "host.tools.check",
                    "request_id": request_id,
                    "targets": targets,
                }
            )
            return await asyncio.wait_for(fut, timeout=timeout)
        except TimeoutError:
            return None
        finally:
            async with self._lock:
                if self._tool_check_waiters.get(request_id) is fut:
                    self._tool_check_waiters.pop(request_id, None)

    async def resolve_tool_check(self, request_id: str, payload: dict) -> None:
        await get_backend().publish_request_response(request_id, payload)
        async with self._lock:
            fut = self._tool_check_waiters.pop(request_id, None)
        if fut is not None and not fut.done():
            fut.set_result(payload)

    async def request_tool_check_for_host(
        self,
        host_id: str,
        *,
        targets: list[dict],
        timeout: float = 15.0,
    ) -> dict | None:
        daemon = self.get_daemon_for_host(host_id)
        if daemon is not None:
            return await self.request_tool_check(daemon, targets=targets, timeout=timeout)
        request_id = str(uuid.uuid4())
        payload = {
            "type": "host.tools.check",
            "request_id": request_id,
            "targets": targets,
        }
        return await self._request_remote_host(host_id, request_id, payload, timeout=timeout)

    async def request_tool_install(
        self,
        daemon: DaemonConn,
        *,
        target: dict,
        timeout: float = 180.0,
    ) -> dict | None:
        request_id = str(uuid.uuid4())
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict] = loop.create_future()
        async with self._lock:
            self._tool_install_waiters[request_id] = fut
        try:
            await daemon.send_text(
                {
                    "type": "host.tools.install",
                    "request_id": request_id,
                    "target": target,
                }
            )
            return await asyncio.wait_for(fut, timeout=timeout)
        except TimeoutError:
            return None
        finally:
            async with self._lock:
                if self._tool_install_waiters.get(request_id) is fut:
                    self._tool_install_waiters.pop(request_id, None)

    async def resolve_tool_install(self, request_id: str, payload: dict) -> None:
        await get_backend().publish_request_response(request_id, payload)
        async with self._lock:
            fut = self._tool_install_waiters.pop(request_id, None)
        if fut is not None and not fut.done():
            fut.set_result(payload)

    async def request_tool_install_for_host(
        self,
        host_id: str,
        *,
        target: dict,
        timeout: float = 180.0,
    ) -> dict | None:
        daemon = self.get_daemon_for_host(host_id)
        if daemon is not None:
            return await self.request_tool_install(daemon, target=target, timeout=timeout)
        request_id = str(uuid.uuid4())
        payload = {
            "type": "host.tools.install",
            "request_id": request_id,
            "target": target,
        }
        return await self._request_remote_host(host_id, request_id, payload, timeout=timeout)

    async def request_daemon_status(
        self,
        daemon: DaemonConn,
        *,
        timeout: float = 3.0,
    ) -> dict | None:
        request_id = str(uuid.uuid4())
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict] = loop.create_future()
        async with self._lock:
            self._daemon_status_waiters[request_id] = fut
        try:
            await daemon.send_text({"type": "host.daemon.status", "request_id": request_id})
            return await asyncio.wait_for(fut, timeout=timeout)
        except TimeoutError:
            return None
        finally:
            async with self._lock:
                if self._daemon_status_waiters.get(request_id) is fut:
                    self._daemon_status_waiters.pop(request_id, None)

    async def resolve_daemon_status(self, request_id: str, payload: dict) -> None:
        await get_backend().publish_request_response(request_id, payload)
        async with self._lock:
            fut = self._daemon_status_waiters.pop(request_id, None)
        if fut is not None and not fut.done():
            fut.set_result(payload)

    async def request_daemon_status_for_host(
        self,
        host_id: str,
        *,
        timeout: float = 3.0,
    ) -> dict | None:
        daemon = self.get_daemon_for_host(host_id)
        if daemon is not None:
            return await self.request_daemon_status(daemon, timeout=timeout)
        request_id = str(uuid.uuid4())
        payload = {"type": "host.daemon.status", "request_id": request_id}
        return await self._request_remote_host(host_id, request_id, payload, timeout=timeout)


_broker = Broker()


def get_broker() -> Broker:
    return _broker
