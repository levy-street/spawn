"""In-process routing map between daemon WS and browser WSs.

Multi-process deploys still work: PTY output is also `publish()`ed to Redis,
so a browser attached on a different worker receives the bytes via pubsub.
This module is the *local* fast path plus the registration source of truth
for which daemon owns which agent on this worker.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

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


@dataclass(frozen=True)
class RtcSessionBinding:
    session_id: str
    generation: str
    agent_id: str
    browser: BrowserConn
    daemon: DaemonConn


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
        self._daemon_by_agent: dict[str, DaemonConn] = {}
        self._browsers_by_agent: dict[str, set[BrowserConn]] = defaultdict(set)
        self._display_by_agent: dict[str, _DisplayState] = {}
        self._snapshot_waiters: dict[str, set[asyncio.Future[dict]]] = defaultdict(set)
        self._dir_list_waiters: dict[str, asyncio.Future[dict]] = {}
        self._fs_waiters: dict[str, asyncio.Future[dict]] = {}
        self._tool_check_waiters: dict[str, asyncio.Future[dict]] = {}
        self._tool_install_waiters: dict[str, asyncio.Future[dict]] = {}
        self._upload_waiters: dict[str, tuple[str, asyncio.Future[dict]]] = {}
        self._rtc_sessions: dict[str, RtcSessionBinding] = {}
        self._lock = asyncio.Lock()

    # ---- daemon registration ----

    async def register_daemon(self, conn: DaemonConn) -> None:
        displaced_bindings: list[RtcSessionBinding] = []
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
                existing.agent_ids.clear()
                displaced_bindings = [
                    binding
                    for binding in self._rtc_sessions.values()
                    if binding.daemon is existing
                ]
                for binding in displaced_bindings:
                    self._rtc_sessions.pop(binding.session_id, None)
            self._daemons_by_host[conn.host_id] = conn
        await self._notify_rtc_bindings_unavailable(displaced_bindings)

    async def unregister_daemon(self, conn: DaemonConn) -> None:
        displaced_bindings: list[RtcSessionBinding] = []
        async with self._lock:
            if self._daemons_by_host.get(conn.host_id) is conn:
                self._daemons_by_host.pop(conn.host_id, None)
            for aid in list(conn.agent_ids):
                if self._daemon_by_agent.get(aid) is conn:
                    self._daemon_by_agent.pop(aid, None)
            conn.agent_ids.clear()
            displaced_bindings = [
                binding
                for binding in self._rtc_sessions.values()
                if binding.daemon is conn
            ]
            for binding in displaced_bindings:
                self._rtc_sessions.pop(binding.session_id, None)
        await self._notify_rtc_bindings_unavailable(displaced_bindings)

    @staticmethod
    async def _notify_rtc_bindings_unavailable(bindings: list[RtcSessionBinding]) -> None:
        for binding in bindings:
            try:
                await binding.browser.send_text(
                    {
                        "type": "rtc.status",
                        "session_id": binding.session_id,
                        "agent_id": binding.agent_id,
                        "status": "unavailable",
                        "message": "Owning daemon disconnected.",
                    }
                )
            except Exception:
                pass

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
        conn: BrowserConn,
        agent_id: str,
        daemon: DaemonConn,
    ) -> RtcSessionBinding | None:
        async with self._lock:
            if session_id in self._rtc_sessions:
                return None
            binding = RtcSessionBinding(
                session_id=session_id,
                generation=uuid.uuid4().hex,
                agent_id=agent_id,
                browser=conn,
                daemon=daemon,
            )
            self._rtc_sessions[session_id] = binding
            return binding

    async def rtc_binding_for_browser(
        self, session_id: str, conn: BrowserConn, agent_id: str
    ) -> RtcSessionBinding | None:
        async with self._lock:
            binding = self._rtc_sessions.get(session_id)
            if (
                binding is not None
                and binding.browser is conn
                and binding.agent_id == agent_id
            ):
                return binding
            return None

    async def unregister_rtc_session(
        self, session_id: str, conn: BrowserConn, agent_id: str
    ) -> RtcSessionBinding | None:
        async with self._lock:
            binding = self._rtc_sessions.get(session_id)
            if (
                binding is not None
                and binding.browser is conn
                and binding.agent_id == agent_id
            ):
                self._rtc_sessions.pop(session_id, None)
                return binding
            return None

    async def unregister_rtc_sessions_for(self, conn: BrowserConn) -> list[RtcSessionBinding]:
        async with self._lock:
            bindings = [
                binding for binding in self._rtc_sessions.values() if binding.browser is conn
            ]
            for binding in bindings:
                self._rtc_sessions.pop(binding.session_id, None)
            return bindings

    async def browser_for_rtc_signal(
        self,
        session_id: str,
        agent_id: str,
        daemon: DaemonConn,
        generation: str,
    ) -> BrowserConn | None:
        async with self._lock:
            binding = self._rtc_sessions.get(session_id)
            if (
                binding is not None
                and binding.agent_id == agent_id
                and binding.daemon is daemon
                and binding.generation == generation
            ):
                return binding.browser
            return None

    async def unregister_rtc_signal(
        self,
        session_id: str,
        agent_id: str,
        daemon: DaemonConn,
        generation: str,
    ) -> RtcSessionBinding | None:
        """Consume a terminal daemon status without touching a replacement binding."""
        async with self._lock:
            binding = self._rtc_sessions.get(session_id)
            if (
                binding is not None
                and binding.agent_id == agent_id
                and binding.daemon is daemon
                and binding.generation == generation
            ):
                self._rtc_sessions.pop(session_id, None)
                return binding
            return None

    async def rtc_session_count(self) -> int:
        async with self._lock:
            return len(self._rtc_sessions)

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
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict] = loop.create_future()
        async with self._lock:
            self._snapshot_waiters[agent_id].add(fut)
        try:
            payload: dict[str, object] = {
                "type": "agent.snapshot",
                "agent_id": agent_id,
                "lines": lines,
            }
            if plain:
                payload["plain"] = True
            if rtc_session_id:
                payload["rtc_session_id"] = rtc_session_id
            await daemon.send_text(payload)
            return await asyncio.wait_for(fut, timeout=timeout)
        except TimeoutError:
            return None
        finally:
            async with self._lock:
                waiters = self._snapshot_waiters.get(agent_id)
                if waiters is not None:
                    waiters.discard(fut)
                    if not waiters:
                        self._snapshot_waiters.pop(agent_id, None)

    async def resolve_snapshot(self, agent_id: str, payload: dict) -> None:
        async with self._lock:
            waiters = list(self._snapshot_waiters.pop(agent_id, ()))
        for fut in waiters:
            if not fut.done():
                fut.set_result(payload)

    async def request_dir_list(
        self,
        daemon: DaemonConn,
        *,
        path: str | None = None,
        include_files: bool = False,
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
            if include_files:
                payload["include_files"] = True
            await daemon.send_text(payload)
            return await asyncio.wait_for(fut, timeout=timeout)
        except TimeoutError:
            return None
        finally:
            async with self._lock:
                if self._dir_list_waiters.get(request_id) is fut:
                    self._dir_list_waiters.pop(request_id, None)

    async def resolve_dir_list(self, request_id: str, payload: dict) -> None:
        async with self._lock:
            fut = self._dir_list_waiters.pop(request_id, None)
        if fut is not None and not fut.done():
            fut.set_result(payload)

    async def _request_fs(
        self,
        daemon: DaemonConn,
        payload: dict[str, object],
        *,
        timeout: float,
    ) -> dict | None:
        request_id = str(uuid.uuid4())
        payload["request_id"] = request_id
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict] = loop.create_future()
        async with self._lock:
            self._fs_waiters[request_id] = fut
        try:
            await daemon.send_text(payload)
            return await asyncio.wait_for(fut, timeout=timeout)
        except TimeoutError:
            return None
        finally:
            async with self._lock:
                if self._fs_waiters.get(request_id) is fut:
                    self._fs_waiters.pop(request_id, None)

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

    async def resolve_fs_result(self, request_id: str, payload: dict) -> None:
        async with self._lock:
            fut = self._fs_waiters.pop(request_id, None)
        if fut is not None and not fut.done():
            fut.set_result(payload)

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
        async with self._lock:
            fut = self._tool_check_waiters.pop(request_id, None)
        if fut is not None and not fut.done():
            fut.set_result(payload)

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
        async with self._lock:
            fut = self._tool_install_waiters.pop(request_id, None)
        if fut is not None and not fut.done():
            fut.set_result(payload)

    async def request_upload(
        self,
        agent_id: str,
        daemon: DaemonConn,
        *,
        payload: dict,
        client_id: str,
        timeout: float = 30.0,
    ) -> dict | None:
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict] = loop.create_future()
        async with self._lock:
            self._upload_waiters[client_id] = (agent_id, fut)
        try:
            await daemon.send_text(payload)
            return await asyncio.wait_for(fut, timeout=timeout)
        except TimeoutError:
            return None
        finally:
            async with self._lock:
                current = self._upload_waiters.get(client_id)
                if current is not None and current[1] is fut:
                    self._upload_waiters.pop(client_id, None)

    async def resolve_upload(self, agent_id: str, client_id: str | None, payload: dict) -> None:
        if not client_id:
            return
        async with self._lock:
            waiter = self._upload_waiters.pop(client_id, None)
        if waiter is None:
            return
        waiter_agent_id, fut = waiter
        if waiter_agent_id != agent_id or fut.done():
            return
        fut.set_result(payload)

    async def reject_uploads_for_agent(self, agent_id: str, message: str) -> None:
        async with self._lock:
            rejected = [
                (client_id, fut)
                for client_id, (waiter_agent_id, fut) in self._upload_waiters.items()
                if waiter_agent_id == agent_id
            ]
            for client_id, _ in rejected:
                self._upload_waiters.pop(client_id, None)
        for _, fut in rejected:
            if not fut.done():
                fut.set_exception(RuntimeError(message))


_broker = Broker()


def get_broker() -> Broker:
    return _broker
