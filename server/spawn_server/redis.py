"""Redis connection and pub/sub helpers, with an in-process fallback for tests.

The fallback implements the publish/subscribe API that the broker uses, keyed
off agent UUIDs, in a single process. Production deployments use real Redis so
multiple uvicorn workers can share state.
"""

from __future__ import annotations

import asyncio
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

    async def publish(self, channel: str, data: bytes) -> None:
        for q in list(self._subs.get(channel, ())):
            await q.put(data)

    def subscribe(self, channel: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._subs[channel].add(q)
        return q

    def unsubscribe(self, channel: str, q: asyncio.Queue) -> None:
        self._subs.get(channel, set()).discard(q)


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
        if self._inproc is not None:
            await self._inproc.publish(ch, payload)
            return
        assert self._client is not None
        await self._client.publish(ch, payload)

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

        assert self._client is not None
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


_backend = RedisBackend()


def get_backend() -> RedisBackend:
    return _backend


async def lifespan_startup() -> None:
    await _backend.startup()


async def lifespan_shutdown() -> None:
    await _backend.shutdown()


__all__ = ["RedisBackend", "get_backend", "lifespan_startup", "lifespan_shutdown", "Any"]
