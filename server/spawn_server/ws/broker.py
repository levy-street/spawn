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
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def send_text(self, payload: dict) -> None:
        async with self.send_lock:
            await self.websocket.send_text(json.dumps(payload))

    async def send_bytes(self, payload: bytes) -> None:
        async with self.send_lock:
            await self.websocket.send_bytes(payload)


class Broker:
    def __init__(self) -> None:
        self._daemons_by_host: dict[str, DaemonConn] = {}
        self._daemon_by_agent: dict[str, DaemonConn] = {}
        self._browsers_by_agent: dict[str, set[BrowserConn]] = defaultdict(set)
        self._snapshot_waiters: dict[str, set[asyncio.Future[str]]] = defaultdict(set)
        self._dir_list_waiters: dict[str, asyncio.Future[dict]] = {}
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
            self._daemons_by_host[conn.host_id] = conn

    async def unregister_daemon(self, conn: DaemonConn) -> None:
        async with self._lock:
            if self._daemons_by_host.get(conn.host_id) is conn:
                self._daemons_by_host.pop(conn.host_id, None)
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

    # ---- browser attach ----

    async def attach_browser(self, conn: BrowserConn) -> None:
        async with self._lock:
            self._browsers_by_agent[conn.agent_id].add(conn)

    async def detach_browser(self, conn: BrowserConn) -> None:
        async with self._lock:
            self._browsers_by_agent.get(conn.agent_id, set()).discard(conn)

    def browsers_for(self, agent_id: str) -> list[BrowserConn]:
        return list(self._browsers_by_agent.get(agent_id, ()))

    async def request_snapshot(
        self,
        agent_id: str,
        daemon: DaemonConn,
        *,
        lines: int = 5000,
        plain: bool = False,
        timeout: float = 2.0,
    ) -> str | None:
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[str] = loop.create_future()
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

    async def resolve_snapshot(self, agent_id: str, bytes_b64: str) -> None:
        async with self._lock:
            waiters = list(self._snapshot_waiters.pop(agent_id, ()))
        for fut in waiters:
            if not fut.done():
                fut.set_result(bytes_b64)

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
        async with self._lock:
            fut = self._dir_list_waiters.pop(request_id, None)
        if fut is not None and not fut.done():
            fut.set_result(payload)


_broker = Broker()


def get_broker() -> Broker:
    return _broker
