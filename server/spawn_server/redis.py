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
from .limits import MAX_SAFE_FENCING_GENERATION


def agent_event_channel(agent_id: str) -> str:
    """Cross-worker JSON control events for browsers attached to an agent."""
    return f"spawn:agent:{agent_id}:events"


def _lease_generation(value: bytes) -> int | None:
    try:
        generation_raw, owner_raw = value.split(b":", 1)
        generation_text = generation_raw.decode("ascii")
        owner = owner_raw.decode("ascii")
    except (ValueError, UnicodeDecodeError):
        return None
    if len(owner) != 32 or any(character not in "0123456789abcdef" for character in owner):
        return None
    if not generation_text or not generation_text.isascii() or not generation_text.isdecimal():
        return None
    generation = int(generation_text)
    if generation < 1 or generation > MAX_SAFE_FENCING_GENERATION:
        return None
    return generation


# ---------- in-process pubsub ----------


class _InProcPubSub:
    def __init__(self) -> None:
        self._subs: dict[str, set[asyncio.Queue]] = defaultdict(set)
        self._values: dict[str, tuple[bytes, float]] = {}

    async def publish(self, channel: str, data: bytes) -> None:
        for q in list(self._subs.get(channel, ())):
            await q.put(data)

    async def publish_if_ephemeral(
        self, key: str, expected: bytes, channel: str, data: bytes
    ) -> bool:
        if self.get_ephemeral(key) != expected:
            return False
        await self.publish(channel, data)
        return True

    def host_owner_is_current(
        self,
        active_key: str,
        pending_key: str,
        expected: bytes,
        generation: int,
    ) -> bool:
        if self.get_ephemeral(active_key) != expected:
            return False
        pending = self.get_ephemeral(pending_key)
        if pending is None:
            return True
        pending_generation = _lease_generation(pending)
        if pending_generation is None or pending_generation > generation:
            return False
        return pending_generation < generation or pending == expected

    async def publish_if_host_owner(
        self,
        active_key: str,
        pending_key: str,
        expected: bytes,
        generation: int,
        channel: str,
        data: bytes,
    ) -> bool:
        if not self.host_owner_is_current(active_key, pending_key, expected, generation):
            return False
        await self.publish(channel, data)
        return True

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

    def set_ephemeral_if_newer(
        self,
        key: str,
        value: bytes,
        generation: int,
        ttl_seconds: int,
    ) -> tuple[bool, bytes | None]:
        previous = self.get_ephemeral(key)
        if previous is not None:
            previous_generation = _lease_generation(previous)
            if previous_generation is None:
                return False, previous
            if previous_generation > generation:
                return False, previous
            if previous_generation == generation and previous != value:
                return False, previous
        self.set_ephemeral(key, value, ttl_seconds)
        return True, previous

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

    def activate_ephemeral(
        self,
        pending_key: str,
        pending_value: bytes,
        active_key: str,
        expected_active: bytes | None,
        active_value: bytes,
        ttl_seconds: int,
    ) -> bool:
        if self.get_ephemeral(pending_key) != pending_value:
            return False
        if self.get_ephemeral(active_key) != expected_active:
            return False
        self.set_ephemeral(active_key, active_value, ttl_seconds)
        self._values.pop(pending_key, None)
        return True

    def activate_ephemeral_if_newer(
        self,
        pending_key: str,
        pending_value: bytes,
        active_key: str,
        generation: int,
        ttl_seconds: int,
    ) -> bool:
        """Promote a DB-committed pending owner over only older active state."""
        if self.get_ephemeral(pending_key) != pending_value:
            return False
        if _lease_generation(pending_value) != generation:
            return False
        active = self.get_ephemeral(active_key)
        if active is not None:
            active_generation = _lease_generation(active)
            if active_generation is None or active_generation > generation:
                return False
            if active_generation == generation and active != pending_value:
                return False
        self.set_ephemeral(active_key, pending_value, ttl_seconds)
        self._values.pop(pending_key, None)
        return True

    def restore_ephemeral_if(
        self,
        key: str,
        expected: bytes,
        restored: bytes | None,
        ttl_seconds: int,
    ) -> bool:
        if self.get_ephemeral(key) != expected:
            return False
        if restored is None:
            self._values.pop(key, None)
        else:
            self.set_ephemeral(key, restored, ttl_seconds)
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

    async def publish_if_ephemeral(
        self, key: str, expected: bytes, channel: str, payload: bytes
    ) -> bool:
        """Publish only while an exact generation-bearing lease is active."""
        if self._inproc is not None:
            return await self._inproc.publish_if_ephemeral(key, expected, channel, payload)
        assert self._client is not None
        result = await self._client.eval(
            "if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end; "
            "redis.call('publish', ARGV[2], ARGV[3]); return 1",
            1,
            key,
            expected,
            channel,
            payload,
        )
        return bool(result)

    async def host_owner_is_current(
        self,
        active_key: str,
        pending_key: str,
        expected: bytes,
        *,
        generation: int,
    ) -> bool:
        """Atomically reject an active owner once a higher pending owner exists."""
        if generation < 1 or generation > MAX_SAFE_FENCING_GENERATION:
            return False
        if _lease_generation(expected) != generation:
            return False
        if self._inproc is not None:
            return self._inproc.host_owner_is_current(
                active_key, pending_key, expected, generation
            )
        assert self._client is not None
        result = await self._client.eval(
            "if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end; "
            "local pending = redis.call('get', KEYS[2]); "
            "if not pending then return 1 end; "
            "local separator = string.find(pending, ':', 1, true); "
            "if not separator then return 0 end; "
            "local raw = string.sub(pending, 1, separator - 1); "
            "local owner = string.sub(pending, separator + 1); "
            "if not string.match(raw, '^%d+$') or string.len(owner) ~= 32 "
            "or not string.match(owner, '^[0-9a-f]+$') then return 0 end; "
            "local candidate = tonumber(raw); "
            "if not candidate or candidate < 1 or candidate > tonumber(ARGV[3]) "
            "or candidate ~= math.floor(candidate) then return 0 end; "
            "if candidate > tonumber(ARGV[2]) then return 0 end; "
            "if candidate == tonumber(ARGV[2]) and pending ~= ARGV[1] then return 0 end; "
            "return 1",
            2,
            active_key,
            pending_key,
            expected,
            generation,
            MAX_SAFE_FENCING_GENERATION,
        )
        return bool(result)

    async def publish_if_host_owner(
        self,
        active_key: str,
        pending_key: str,
        expected: bytes,
        *,
        generation: int,
        channel: str,
        payload: bytes,
    ) -> bool:
        """Atomically publish only before any higher host generation is pending."""
        if generation < 1 or generation > MAX_SAFE_FENCING_GENERATION:
            return False
        if _lease_generation(expected) != generation:
            return False
        if self._inproc is not None:
            return await self._inproc.publish_if_host_owner(
                active_key,
                pending_key,
                expected,
                generation,
                channel,
                payload,
            )
        assert self._client is not None
        result = await self._client.eval(
            "if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end; "
            "local pending = redis.call('get', KEYS[2]); "
            "if pending then "
            "local separator = string.find(pending, ':', 1, true); "
            "if not separator then return 0 end; "
            "local raw = string.sub(pending, 1, separator - 1); "
            "local owner = string.sub(pending, separator + 1); "
            "if not string.match(raw, '^%d+$') or string.len(owner) ~= 32 "
            "or not string.match(owner, '^[0-9a-f]+$') then return 0 end; "
            "local candidate = tonumber(raw); "
            "if not candidate or candidate < 1 or candidate > tonumber(ARGV[5]) "
            "or candidate ~= math.floor(candidate) then return 0 end; "
            "if candidate > tonumber(ARGV[2]) then return 0 end; "
            "if candidate == tonumber(ARGV[2]) and pending ~= ARGV[1] then return 0 end; "
            "end; redis.call('publish', ARGV[3], ARGV[4]); return 1",
            2,
            active_key,
            pending_key,
            expected,
            generation,
            channel,
            payload,
            MAX_SAFE_FENCING_GENERATION,
        )
        return bool(result)

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
                while True:
                    item = await queue.get()
                    yield item

            try:
                yield _iter_inproc()
            finally:
                inproc.unsubscribe(channel, queue)
            return

        assert self._client is not None
        pubsub = self._client.pubsub()
        await pubsub.subscribe(channel)

        async def _iter_redis() -> AsyncIterator[bytes]:
            async for msg in pubsub.listen():
                if msg.get("type") != "message":
                    continue
                data = msg.get("data")
                if isinstance(data, bytes):
                    yield data

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

    async def swap_ephemeral(self, key: str, value: bytes, *, ttl_seconds: int) -> bytes | None:
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

    async def set_ephemeral_if_newer(
        self,
        key: str,
        value: bytes,
        *,
        generation: int,
        ttl_seconds: int,
    ) -> tuple[bool, bytes | None]:
        """Set a generation-prefixed lease only if it is not older than Redis."""
        if generation < 1 or generation > MAX_SAFE_FENCING_GENERATION:
            raise ValueError("generation is outside Redis's exact integer range")
        if _lease_generation(value) != generation:
            raise ValueError("lease value does not contain the supplied generation")
        if self._inproc is not None:
            return self._inproc.set_ephemeral_if_newer(
                key,
                value,
                generation,
                ttl_seconds,
            )
        assert self._client is not None
        result = await self._client.eval(
            "local old = redis.call('get', KEYS[1]); "
            "if old then "
            "local separator = string.find(old, ':', 1, true); "
            "if not separator then return {-1, old}; end; "
            "local current_raw = string.sub(old, 1, separator - 1); "
            "if not string.match(current_raw, '^%d+$') then return {-1, old}; end; "
            "local current_owner = string.sub(old, separator + 1); "
            "if string.len(current_owner) ~= 32 "
            "or not string.match(current_owner, '^[0-9a-f]+$') "
            "then return {-1, old}; end; "
            "local current = tonumber(current_raw); "
            "if not current or current < 1 or current > tonumber(ARGV[4]) "
            "or current ~= math.floor(current) then return {-1, old}; end; "
            "if current > tonumber(ARGV[3]) then return {0, old}; end; "
            "if current == tonumber(ARGV[3]) and old ~= ARGV[1] "
            "then return {-1, old}; end; "
            "end; "
            "redis.call('set', KEYS[1], ARGV[1], 'EX', ARGV[2]); "
            "return {1, old or false}",
            1,
            key,
            value,
            ttl_seconds,
            generation,
            MAX_SAFE_FENCING_GENERATION,
        )
        if not isinstance(result, (list, tuple)) or len(result) != 2:
            raise RuntimeError("Redis returned an invalid lease claim")
        status_raw, previous_raw = result
        previous = previous_raw if isinstance(previous_raw, bytes) else None
        if not isinstance(status_raw, int):
            raise RuntimeError("Redis returned an invalid lease claim status")
        return status_raw == 1, previous

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

    async def refresh_ephemeral_if(self, key: str, value: bytes, *, ttl_seconds: int) -> bool:
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

    async def activate_ephemeral(
        self,
        pending_key: str,
        pending_value: bytes,
        active_key: str,
        expected_active: bytes | None,
        active_value: bytes,
        *,
        ttl_seconds: int,
    ) -> bool:
        """Promote an exact pending reservation into the active routing lease."""
        if self._inproc is not None:
            return self._inproc.activate_ephemeral(
                pending_key,
                pending_value,
                active_key,
                expected_active,
                active_value,
                ttl_seconds,
            )
        assert self._client is not None
        result = await self._client.eval(
            "if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end; "
            "local active = redis.call('get', KEYS[2]); "
            "if ARGV[2] == '1' and active ~= ARGV[3] then return 0 end; "
            "if ARGV[2] ~= '1' and active then return 0 end; "
            "redis.call('set', KEYS[2], ARGV[4], 'EX', ARGV[5]); "
            "redis.call('del', KEYS[1]); return 1",
            2,
            pending_key,
            active_key,
            pending_value,
            "1" if expected_active is not None else "0",
            expected_active or b"",
            active_value,
            ttl_seconds,
        )
        return bool(result)

    async def activate_ephemeral_if_newer(
        self,
        pending_key: str,
        pending_value: bytes,
        active_key: str,
        *,
        generation: int,
        ttl_seconds: int,
    ) -> bool:
        """Promote a proven DB owner over nil or strictly older Redis state.

        The caller must invoke this only after an exact durable-owner read or
        its own successful durable commit. Redis independently requires the
        exact pending token and refuses malformed, equal-other, or newer
        active owners.
        """
        if generation < 1 or generation > MAX_SAFE_FENCING_GENERATION:
            raise ValueError("generation is outside Redis's exact integer range")
        if _lease_generation(pending_value) != generation:
            raise ValueError("pending lease does not contain the supplied generation")
        if self._inproc is not None:
            return self._inproc.activate_ephemeral_if_newer(
                pending_key,
                pending_value,
                active_key,
                generation,
                ttl_seconds,
            )
        assert self._client is not None
        result = await self._client.eval(
            "if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end; "
            "local active = redis.call('get', KEYS[2]); "
            "if active then "
            "local separator = string.find(active, ':', 1, true); "
            "if not separator then return 0 end; "
            "local current_raw = string.sub(active, 1, separator - 1); "
            "local current_owner = string.sub(active, separator + 1); "
            "if not string.match(current_raw, '^%d+$') "
            "or string.len(current_owner) ~= 32 "
            "or not string.match(current_owner, '^[0-9a-f]+$') then return 0 end; "
            "local current = tonumber(current_raw); "
            "if not current or current < 1 or current > tonumber(ARGV[4]) "
            "or current ~= math.floor(current) then return 0 end; "
            "if current > tonumber(ARGV[2]) then return 0 end; "
            "if current == tonumber(ARGV[2]) and active ~= ARGV[1] then return 0 end; "
            "end; "
            "redis.call('set', KEYS[2], ARGV[1], 'EX', ARGV[3]); "
            "redis.call('del', KEYS[1]); return 1",
            2,
            pending_key,
            active_key,
            pending_value,
            generation,
            ttl_seconds,
            MAX_SAFE_FENCING_GENERATION,
        )
        return bool(result)

    async def restore_ephemeral_if(
        self,
        key: str,
        expected: bytes,
        restored: bytes | None,
        *,
        ttl_seconds: int,
    ) -> bool:
        """CAS-restore an active lease after a failed database commit."""
        if self._inproc is not None:
            return self._inproc.restore_ephemeral_if(key, expected, restored, ttl_seconds)
        assert self._client is not None
        result = await self._client.eval(
            "if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end; "
            "if ARGV[2] == '1' then "
            "redis.call('set', KEYS[1], ARGV[3], 'EX', ARGV[4]); "
            "else redis.call('del', KEYS[1]); end; return 1",
            1,
            key,
            expected,
            "1" if restored is not None else "0",
            restored or b"",
            ttl_seconds,
        )
        return bool(result)


_backend = RedisBackend()


def get_backend() -> RedisBackend:
    return _backend


async def lifespan_startup() -> None:
    await _backend.startup()


async def lifespan_shutdown() -> None:
    await _backend.shutdown()


__all__ = ["RedisBackend", "get_backend", "lifespan_startup", "lifespan_shutdown", "Any"]
