"""Thin wrappers around `RedisBackend` for clarity at call sites."""

from __future__ import annotations

from ..redis import get_backend


async def append(agent_id: str, data: bytes) -> None:
    await get_backend().ring_append(agent_id, data)


async def read(agent_id: str) -> bytes:
    return await get_backend().ring_read(agent_id)


async def clear(agent_id: str) -> None:
    await get_backend().ring_clear(agent_id)
