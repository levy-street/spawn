"""Redis connection and pub/sub helpers, with an in-process fallback for tests.

The fallback implements just enough of the publish/subscribe + ring-buffer API
that the broker uses, keyed off agent UUIDs, in a single process. Production
deployments use real Redis so multiple uvicorn workers can share state.
"""

from __future__ import annotations

import asyncio
import json
from collections import defaultdict
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import redis.asyncio as aioredis

from .config import get_settings

# ---------- in-process pubsub ----------


class _InProcPubSub:
    def __init__(self) -> None:
        self._subs: dict[str, set[asyncio.Queue]] = defaultdict(set)
        # Per-channel ring buffer of bytes (already limited by size).
        self._buf: dict[str, bytearray] = defaultdict(bytearray)
        self._display_viewers: dict[str, set[str]] = defaultdict(set)
        self._display_state: dict[str, dict[str, str]] = defaultdict(dict)
        self._display_lock = asyncio.Lock()

    async def publish(self, channel: str, data: bytes) -> int:
        subscribers = len(self._subs.get(channel, ()))
        for q in list(self._subs.get(channel, ())):
            await q.put(data)
        return subscribers

    def subscribe(self, channel: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._subs[channel].add(q)
        return q

    def unsubscribe(self, channel: str, q: asyncio.Queue) -> None:
        self._subs.get(channel, set()).discard(q)

    async def append_ring(self, channel: str, data: bytes, max_bytes: int) -> None:
        buf = self._buf[channel]
        buf.extend(data)
        if len(buf) > max_bytes:
            del buf[: len(buf) - max_bytes]

    async def read_ring(self, channel: str) -> bytes:
        return bytes(self._buf.get(channel, b""))

    async def clear_ring(self, channel: str) -> None:
        self._buf.pop(channel, None)

    async def display_attach(
        self, agent_id: str, conn_id: str, cols: int | None, rows: int | None
    ) -> dict[str, Any]:
        async with self._display_lock:
            viewers = self._display_viewers[agent_id]
            viewers.add(conn_id)
            state = self._display_state[agent_id]
            owner = state.get("owner")
            if owner not in viewers:
                state["owner"] = conn_id
                if cols is not None and rows is not None:
                    state["cols"] = str(cols)
                    state["rows"] = str(rows)
            elif "cols" not in state and cols is not None and rows is not None:
                state["cols"] = str(cols)
                state["rows"] = str(rows)
            return _display_state_result(state, len(viewers))

    async def display_detach(self, agent_id: str, conn_id: str) -> dict[str, Any] | None:
        async with self._display_lock:
            viewers = self._display_viewers.get(agent_id)
            state = self._display_state.get(agent_id)
            if viewers is None or state is None:
                return None
            viewers.discard(conn_id)
            if not viewers:
                self._display_viewers.pop(agent_id, None)
                self._display_state.pop(agent_id, None)
                return None
            if state.get("owner") not in viewers:
                state["owner"] = next(iter(viewers))
            return _display_state_result(state, len(viewers))

    async def display_update_size(
        self, agent_id: str, conn_id: str, cols: int, rows: int
    ) -> dict[str, Any] | None:
        async with self._display_lock:
            viewers = self._display_viewers[agent_id]
            viewers.add(conn_id)
            state = self._display_state[agent_id]
            if state.get("owner") not in viewers:
                state["owner"] = conn_id
            if state.get("owner") != conn_id:
                return None
            state["cols"] = str(cols)
            state["rows"] = str(rows)
            return _display_state_result(state, len(viewers))

    async def display_take_control(
        self, agent_id: str, conn_id: str, cols: int, rows: int
    ) -> dict[str, Any]:
        async with self._display_lock:
            viewers = self._display_viewers[agent_id]
            viewers.add(conn_id)
            state = self._display_state[agent_id]
            state["owner"] = conn_id
            state["cols"] = str(cols)
            state["rows"] = str(rows)
            return _display_state_result(state, len(viewers))

    async def display_state(self, agent_id: str) -> dict[str, Any] | None:
        async with self._display_lock:
            viewers = self._display_viewers.get(agent_id)
            state = self._display_state.get(agent_id)
            if not viewers or state is None:
                return None
            if state.get("owner") not in viewers:
                state["owner"] = next(iter(viewers))
            return _display_state_result(state, len(viewers))


def _to_int(value: Any) -> int | None:
    if value in (None, "", b""):
        return None
    if isinstance(value, bytes):
        value = value.decode("utf-8")
    return int(value)


def _to_str(value: Any) -> str | None:
    if value in (None, "", b""):
        return None
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return str(value)


def _display_state_result(state: dict[str, Any], viewers: int) -> dict[str, Any]:
    return {
        "owner_conn_id": _to_str(state.get("owner")),
        "cols": _to_int(state.get("cols")),
        "rows": _to_int(state.get("rows")),
        "viewers": viewers,
    }


def _display_result_from_redis(result: list[Any] | tuple[Any, ...]) -> dict[str, Any]:
    return {
        "owner_conn_id": _to_str(result[0] if len(result) > 0 else None),
        "cols": _to_int(result[1] if len(result) > 1 else None),
        "rows": _to_int(result[2] if len(result) > 2 else None),
        "viewers": int(result[3] if len(result) > 3 else 0),
    }


# ---------- backend abstraction ----------


class RedisBackend:
    """Thin wrapper around aioredis or the in-process stub."""

    def __init__(self) -> None:
        self._client: aioredis.Redis | None = None
        self._inproc: _InProcPubSub | None = None

    async def startup(self) -> None:
        settings = get_settings()
        if settings.use_inprocess_pubsub:
            self._inproc = _InProcPubSub()
            return
        self._client = aioredis.from_url(settings.redis_url, decode_responses=False)

    async def shutdown(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None
        self._inproc = None

    @property
    def inproc(self) -> _InProcPubSub | None:
        return self._inproc

    @property
    def client(self) -> aioredis.Redis | None:
        return self._client

    @property
    def available(self) -> bool:
        return self._inproc is not None or self._client is not None

    # ----- ring buffer -----

    @staticmethod
    def _ring_key(agent_id: str) -> str:
        return f"spawn:agent:{agent_id}:ring"

    async def ring_append(self, agent_id: str, data: bytes) -> None:
        max_bytes = get_settings().ringbuffer_max_bytes
        if self._inproc is not None:
            await self._inproc.append_ring(agent_id, data, max_bytes)
            return
        assert self._client is not None
        key = self._ring_key(agent_id)
        # APPEND then trim by reading length and using GETRANGE — simplest correct approach.
        async with self._client.pipeline(transaction=True) as p:
            p.append(key, data)
            p.strlen(key)
            _, length = await p.execute()
        if length > max_bytes:
            tail = await self._client.getrange(key, length - max_bytes, length - 1)
            await self._client.set(key, tail)

    async def ring_read(self, agent_id: str) -> bytes:
        if self._inproc is not None:
            return await self._inproc.read_ring(agent_id)
        assert self._client is not None
        v = await self._client.get(self._ring_key(agent_id))
        return v or b""

    async def ring_clear(self, agent_id: str) -> None:
        if self._inproc is not None:
            await self._inproc.clear_ring(agent_id)
            return
        assert self._client is not None
        await self._client.delete(self._ring_key(agent_id))

    # ----- pubsub -----

    @staticmethod
    def _agent_channel(agent_id: str) -> str:
        return f"spawn:agent:{agent_id}"

    @staticmethod
    def _agent_event_channel(agent_id: str) -> str:
        return f"spawn:agent:{agent_id}:events"

    @staticmethod
    def _display_viewers_key(agent_id: str) -> str:
        return f"spawn:agent:{agent_id}:display:viewers"

    @staticmethod
    def _display_state_key(agent_id: str) -> str:
        return f"spawn:agent:{agent_id}:display:state"

    async def display_attach(
        self, agent_id: str, conn_id: str, cols: int | None, rows: int | None
    ) -> dict[str, Any]:
        if self._inproc is not None:
            return await self._inproc.display_attach(agent_id, conn_id, cols, rows)
        if self._client is None:
            raise RuntimeError("redis backend is not started")
        result = await self._client.eval(
            """
            local viewers = KEYS[1]
            local state = KEYS[2]
            local conn = ARGV[1]
            local cols = ARGV[2]
            local rows = ARGV[3]
            redis.call('SADD', viewers, conn)
            local owner = redis.call('HGET', state, 'owner')
            if (not owner) or redis.call('SISMEMBER', viewers, owner) == 0 then
              owner = conn
              redis.call('HSET', state, 'owner', owner)
              if cols ~= '' and rows ~= '' then
                redis.call('HSET', state, 'cols', cols, 'rows', rows)
              end
            elseif (not redis.call('HGET', state, 'cols')) and cols ~= '' and rows ~= '' then
              redis.call('HSET', state, 'cols', cols, 'rows', rows)
            end
            return {
              redis.call('HGET', state, 'owner') or '',
              redis.call('HGET', state, 'cols') or '',
              redis.call('HGET', state, 'rows') or '',
              redis.call('SCARD', viewers)
            }
            """,
            2,
            self._display_viewers_key(agent_id),
            self._display_state_key(agent_id),
            conn_id,
            "" if cols is None else str(cols),
            "" if rows is None else str(rows),
        )
        return _display_result_from_redis(result)

    async def display_detach(self, agent_id: str, conn_id: str) -> dict[str, Any] | None:
        if self._inproc is not None:
            return await self._inproc.display_detach(agent_id, conn_id)
        if self._client is None:
            raise RuntimeError("redis backend is not started")
        result = await self._client.eval(
            """
            local viewers = KEYS[1]
            local state = KEYS[2]
            local conn = ARGV[1]
            redis.call('SREM', viewers, conn)
            local count = redis.call('SCARD', viewers)
            if count == 0 then
              redis.call('DEL', viewers, state)
              return {'', '', '', 0}
            end
            local owner = redis.call('HGET', state, 'owner')
            if (not owner) or owner == conn or redis.call('SISMEMBER', viewers, owner) == 0 then
              owner = redis.call('SRANDMEMBER', viewers)
              redis.call('HSET', state, 'owner', owner)
            end
            return {
              owner or '',
              redis.call('HGET', state, 'cols') or '',
              redis.call('HGET', state, 'rows') or '',
              count
            }
            """,
            2,
            self._display_viewers_key(agent_id),
            self._display_state_key(agent_id),
            conn_id,
        )
        state = _display_result_from_redis(result)
        return state if state["viewers"] > 0 else None

    async def display_update_size(
        self, agent_id: str, conn_id: str, cols: int, rows: int
    ) -> dict[str, Any] | None:
        if self._inproc is not None:
            return await self._inproc.display_update_size(agent_id, conn_id, cols, rows)
        if self._client is None:
            raise RuntimeError("redis backend is not started")
        result = await self._client.eval(
            """
            local viewers = KEYS[1]
            local state = KEYS[2]
            local conn = ARGV[1]
            local cols = ARGV[2]
            local rows = ARGV[3]
            redis.call('SADD', viewers, conn)
            local owner = redis.call('HGET', state, 'owner')
            if (not owner) or redis.call('SISMEMBER', viewers, owner) == 0 then
              owner = conn
              redis.call('HSET', state, 'owner', owner)
            end
            if owner ~= conn then
              return {
                0,
                owner or '',
                redis.call('HGET', state, 'cols') or '',
                redis.call('HGET', state, 'rows') or '',
                redis.call('SCARD', viewers)
              }
            end
            redis.call('HSET', state, 'cols', cols, 'rows', rows)
            return {1, owner, cols, rows, redis.call('SCARD', viewers)}
            """,
            2,
            self._display_viewers_key(agent_id),
            self._display_state_key(agent_id),
            conn_id,
            str(cols),
            str(rows),
        )
        allowed = int(result[0]) == 1
        state = _display_result_from_redis(result[1:])
        return state if allowed else None

    async def display_take_control(
        self, agent_id: str, conn_id: str, cols: int, rows: int
    ) -> dict[str, Any]:
        if self._inproc is not None:
            return await self._inproc.display_take_control(agent_id, conn_id, cols, rows)
        if self._client is None:
            raise RuntimeError("redis backend is not started")
        result = await self._client.eval(
            """
            local viewers = KEYS[1]
            local state = KEYS[2]
            local conn = ARGV[1]
            local cols = ARGV[2]
            local rows = ARGV[3]
            redis.call('SADD', viewers, conn)
            redis.call('HSET', state, 'owner', conn, 'cols', cols, 'rows', rows)
            return {conn, cols, rows, redis.call('SCARD', viewers)}
            """,
            2,
            self._display_viewers_key(agent_id),
            self._display_state_key(agent_id),
            conn_id,
            str(cols),
            str(rows),
        )
        return _display_result_from_redis(result)

    async def display_state(self, agent_id: str) -> dict[str, Any] | None:
        if self._inproc is not None:
            return await self._inproc.display_state(agent_id)
        if self._client is None:
            raise RuntimeError("redis backend is not started")
        result = await self._client.eval(
            """
            local viewers = KEYS[1]
            local state = KEYS[2]
            local count = redis.call('SCARD', viewers)
            if count == 0 then
              redis.call('DEL', viewers, state)
              return {'', '', '', 0}
            end
            local owner = redis.call('HGET', state, 'owner')
            if (not owner) or redis.call('SISMEMBER', viewers, owner) == 0 then
              owner = redis.call('SRANDMEMBER', viewers)
              redis.call('HSET', state, 'owner', owner)
            end
            return {
              owner or '',
              redis.call('HGET', state, 'cols') or '',
              redis.call('HGET', state, 'rows') or '',
              count
            }
            """,
            2,
            self._display_viewers_key(agent_id),
            self._display_state_key(agent_id),
        )
        state = _display_result_from_redis(result)
        return state if state["viewers"] > 0 else None

    async def publish(self, agent_id: str, payload: bytes) -> int:
        ch = self._agent_channel(agent_id)
        if self._inproc is not None:
            return await self._inproc.publish(ch, payload)
        if self._client is None:
            return 0
        return int(await self._client.publish(ch, payload))

    @asynccontextmanager
    async def subscribe(self, agent_id: str) -> AsyncIterator[AsyncIterator[bytes]]:
        """Subscribe to PTY bytes for an agent.

        Yields an async iterator of bytes payloads. The iterator stops when
        the context manager exits (caller cancels the consuming task).

        Works the same against real Redis and the in-process fallback so the
        consumer in `ws/browser.py` doesn't branch.
        """
        ch = self._agent_channel(agent_id)
        if self._inproc is not None:
            queue = self._inproc.subscribe(ch)

            async def _iter_inproc() -> AsyncIterator[bytes]:
                try:
                    while True:
                        item = await queue.get()
                        yield item
                except asyncio.CancelledError:
                    return

            try:
                yield _iter_inproc()
            finally:
                self._inproc.unsubscribe(ch, queue)
            return

        if self._client is None:
            raise RuntimeError("redis backend is not started")
        pubsub = self._client.pubsub()
        await pubsub.subscribe(ch)

        async def _iter_redis() -> AsyncIterator[bytes]:
            try:
                async for msg in pubsub.listen():
                    if msg.get("type") != "message":
                        continue
                    data = msg.get("data")
                    if isinstance(data, bytes):
                        yield data
            except asyncio.CancelledError:
                return

        try:
            yield _iter_redis()
        finally:
            try:
                await pubsub.unsubscribe(ch)
            except Exception:
                pass
            try:
                await pubsub.aclose()
            except Exception:
                pass

    # ----- daemon command bus -----

    @staticmethod
    def _host_command_channel(host_id: str) -> str:
        return f"spawn:host:{host_id}:commands"

    @staticmethod
    def _request_response_channel(request_id: str) -> str:
        return f"spawn:request:{request_id}:response"

    async def publish_host_command(self, host_id: str, envelope: dict[str, Any]) -> int:
        payload = json.dumps(envelope).encode("utf-8")
        ch = self._host_command_channel(host_id)
        if self._inproc is not None:
            return await self._inproc.publish(ch, payload)
        if self._client is None:
            return 0
        return int(await self._client.publish(ch, payload))

    @asynccontextmanager
    async def subscribe_host_commands(
        self, host_id: str
    ) -> AsyncIterator[AsyncIterator[dict[str, Any]]]:
        ch = self._host_command_channel(host_id)
        if self._inproc is not None:
            queue = self._inproc.subscribe(ch)

            async def _iter_inproc() -> AsyncIterator[dict[str, Any]]:
                try:
                    while True:
                        item = await queue.get()
                        yield json.loads(item.decode("utf-8"))
                except asyncio.CancelledError:
                    return

            try:
                yield _iter_inproc()
            finally:
                self._inproc.unsubscribe(ch, queue)
            return

        if self._client is None:
            raise RuntimeError("redis backend is not started")
        pubsub = self._client.pubsub()
        await pubsub.subscribe(ch)

        async def _iter_redis() -> AsyncIterator[dict[str, Any]]:
            try:
                async for msg in pubsub.listen():
                    if msg.get("type") != "message":
                        continue
                    data = msg.get("data")
                    if isinstance(data, bytes):
                        yield json.loads(data.decode("utf-8"))
            except asyncio.CancelledError:
                return

        try:
            yield _iter_redis()
        finally:
            try:
                await pubsub.unsubscribe(ch)
            except Exception:
                pass
            try:
                await pubsub.aclose()
            except Exception:
                pass

    async def publish_request_response(self, request_id: str, payload: dict[str, Any]) -> int:
        data = json.dumps(payload).encode("utf-8")
        ch = self._request_response_channel(request_id)
        if self._inproc is not None:
            return await self._inproc.publish(ch, data)
        if self._client is None:
            return 0
        return int(await self._client.publish(ch, data))

    @asynccontextmanager
    async def subscribe_request_response(
        self, request_id: str
    ) -> AsyncIterator[AsyncIterator[dict[str, Any]]]:
        ch = self._request_response_channel(request_id)
        if self._inproc is not None:
            queue = self._inproc.subscribe(ch)

            async def _iter_inproc() -> AsyncIterator[dict[str, Any]]:
                try:
                    while True:
                        item = await queue.get()
                        yield json.loads(item.decode("utf-8"))
                except asyncio.CancelledError:
                    return

            try:
                yield _iter_inproc()
            finally:
                self._inproc.unsubscribe(ch, queue)
            return

        if self._client is None:
            raise RuntimeError("redis backend is not started")
        pubsub = self._client.pubsub()
        await pubsub.subscribe(ch)

        async def _iter_redis() -> AsyncIterator[dict[str, Any]]:
            try:
                async for msg in pubsub.listen():
                    if msg.get("type") != "message":
                        continue
                    data = msg.get("data")
                    if isinstance(data, bytes):
                        yield json.loads(data.decode("utf-8"))
            except asyncio.CancelledError:
                return

        try:
            yield _iter_redis()
        finally:
            try:
                await pubsub.unsubscribe(ch)
            except Exception:
                pass
            try:
                await pubsub.aclose()
            except Exception:
                pass

    async def publish_agent_event(self, agent_id: str, payload: dict[str, Any]) -> int:
        data = json.dumps(payload).encode("utf-8")
        ch = self._agent_event_channel(agent_id)
        if self._inproc is not None:
            return await self._inproc.publish(ch, data)
        if self._client is None:
            return 0
        return int(await self._client.publish(ch, data))

    @asynccontextmanager
    async def subscribe_agent_events(
        self, agent_id: str
    ) -> AsyncIterator[AsyncIterator[dict[str, Any]]]:
        ch = self._agent_event_channel(agent_id)
        if self._inproc is not None:
            queue = self._inproc.subscribe(ch)

            async def _iter_inproc() -> AsyncIterator[dict[str, Any]]:
                try:
                    while True:
                        item = await queue.get()
                        yield json.loads(item.decode("utf-8"))
                except asyncio.CancelledError:
                    return

            try:
                yield _iter_inproc()
            finally:
                self._inproc.unsubscribe(ch, queue)
            return

        if self._client is None:
            raise RuntimeError("redis backend is not started")
        pubsub = self._client.pubsub()
        await pubsub.subscribe(ch)

        async def _iter_redis() -> AsyncIterator[dict[str, Any]]:
            try:
                async for msg in pubsub.listen():
                    if msg.get("type") != "message":
                        continue
                    data = msg.get("data")
                    if isinstance(data, bytes):
                        yield json.loads(data.decode("utf-8"))
            except asyncio.CancelledError:
                return

        try:
            yield _iter_redis()
        finally:
            try:
                await pubsub.unsubscribe(ch)
            except Exception:
                pass
            try:
                await pubsub.aclose()
            except Exception:
                pass


_backend = RedisBackend()


def get_backend() -> RedisBackend:
    return _backend


async def lifespan_startup() -> None:
    await _backend.startup()


async def lifespan_shutdown() -> None:
    await _backend.shutdown()


__all__ = ["RedisBackend", "get_backend", "lifespan_startup", "lifespan_shutdown", "Any"]
