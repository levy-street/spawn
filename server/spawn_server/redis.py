"""Redis connection and pub/sub helpers, with an in-process fallback for tests.

The fallback implements the publish/subscribe API that the broker uses, keyed
off agent UUIDs, in a single process. Production deployments use real Redis so
multiple uvicorn workers can share state.
"""

from __future__ import annotations

import asyncio
import time
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
        self._values: dict[str, tuple[bytes, float]] = {}

    async def publish(self, channel: str, data: bytes) -> None:
        for q in list(self._subs.get(channel, ())):
            await q.put(data)

    def subscribe(self, channel: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._subs[channel].add(q)
        return q

    def unsubscribe(self, channel: str, q: asyncio.Queue) -> None:
        self._subs.get(channel, set()).discard(q)

    def set_ephemeral(self, key: str, value: bytes, ttl_seconds: int) -> None:
        self._values[key] = (value, time.monotonic() + ttl_seconds)

    def swap_ephemeral(self, key: str, value: bytes, ttl_seconds: int) -> bytes | None:
        previous = self.get_ephemeral(key)
        self.set_ephemeral(key, value, ttl_seconds)
        return previous

    def get_ephemeral(self, key: str) -> bytes | None:
        item = self._values.get(key)
        if item is None:
            return None
        value, expires_at = item
        if time.monotonic() >= expires_at:
            self._values.pop(key, None)
            return None
        return value

    def delete_ephemeral_if(self, key: str, value: bytes) -> bool:
        if self.get_ephemeral(key) == value:
            self._values.pop(key, None)
            return True
        return False

    def refresh_ephemeral_if(self, key: str, value: bytes, ttl_seconds: int) -> bool:
        if self.get_ephemeral(key) != value:
            return False
        self._values[key] = (value, time.monotonic() + ttl_seconds)
        return True


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

    # ----- pubsub -----

    @staticmethod
    def _agent_channel(agent_id: str) -> str:
        return f"spawn:agent:{agent_id}"

    async def publish(self, agent_id: str, payload: bytes) -> None:
        ch = self._agent_channel(agent_id)
        await self.publish_channel(ch, payload)

    async def publish_channel(self, channel: str, payload: bytes) -> None:
        if self._inproc is not None:
            await self._inproc.publish(channel, payload)
            return
        assert self._client is not None
        await self._client.publish(channel, payload)

    @asynccontextmanager
    async def subscribe(self, agent_id: str) -> AsyncIterator[AsyncIterator[bytes]]:
        """Subscribe to PTY bytes for an agent.

        Yields an async iterator of bytes payloads. The iterator stops when
        the context manager exits (caller cancels the consuming task).

        Works the same against real Redis and the in-process fallback so the
        consumer in `ws/browser.py` doesn't branch.
        """
        async with self.subscribe_channel(self._agent_channel(agent_id)) as stream:
            yield stream

    @asynccontextmanager
    async def subscribe_channel(self, channel: str) -> AsyncIterator[AsyncIterator[bytes]]:
        """Subscribe to an arbitrary internal binary pub/sub channel."""
        if self._inproc is not None:
            # Capture the active fallback instance. Test/app shutdown can clear
            # ``self._inproc`` while a websocket subscription is unwinding.
            inproc = self._inproc
            queue = inproc.subscribe(channel)

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
                inproc.unsubscribe(channel, queue)
            return

        assert self._client is not None
        pubsub = self._client.pubsub()
        await pubsub.subscribe(channel)

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
                await pubsub.unsubscribe(channel)
            except Exception:
                pass
            try:
                await pubsub.aclose()
            except Exception:
                pass

    async def set_ephemeral(self, key: str, value: bytes, *, ttl_seconds: int) -> None:
        if self._inproc is not None:
            self._inproc.set_ephemeral(key, value, ttl_seconds)
            return
        assert self._client is not None
        await self._client.set(key, value, ex=ttl_seconds)

    async def swap_ephemeral(
        self, key: str, value: bytes, *, ttl_seconds: int
    ) -> bytes | None:
        """Atomically replace a leased value and return its previous owner."""
        if self._inproc is not None:
            return self._inproc.swap_ephemeral(key, value, ttl_seconds)
        assert self._client is not None
        previous = await self._client.eval(
            "local old = redis.call('get', KEYS[1]); "
            "redis.call('set', KEYS[1], ARGV[1], 'EX', ARGV[2]); "
            "return old",
            1,
            key,
            value,
            ttl_seconds,
        )
        return previous if isinstance(previous, bytes) else None

    async def get_ephemeral(self, key: str) -> bytes | None:
        if self._inproc is not None:
            return self._inproc.get_ephemeral(key)
        assert self._client is not None
        value = await self._client.get(key)
        return value if isinstance(value, bytes) else None

    async def delete_ephemeral_if(self, key: str, value: bytes) -> bool:
        if self._inproc is not None:
            return self._inproc.delete_ephemeral_if(key, value)
        assert self._client is not None
        deleted = await self._client.eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then "
            "return redis.call('del', KEYS[1]) else return 0 end",
            1,
            key,
            value,
        )
        return bool(deleted)

    async def refresh_ephemeral_if(
        self, key: str, value: bytes, *, ttl_seconds: int
    ) -> bool:
        if self._inproc is not None:
            return self._inproc.refresh_ephemeral_if(key, value, ttl_seconds)
        assert self._client is not None
        refreshed = await self._client.eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then "
            "return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end",
            1,
            key,
            value,
            ttl_seconds,
        )
        return bool(refreshed)


_backend = RedisBackend()


def get_backend() -> RedisBackend:
    return _backend


async def lifespan_startup() -> None:
    await _backend.startup()


async def lifespan_shutdown() -> None:
    await _backend.shutdown()


__all__ = ["RedisBackend", "get_backend", "lifespan_startup", "lifespan_shutdown", "Any"]
