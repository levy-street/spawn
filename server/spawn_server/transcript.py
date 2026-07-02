"""On-disk PTY transcripts, one file per agent.

Replaces the in-process ring buffer for replay. Survives server restart,
gives the user real scrollback (current cap: ~64 MB per agent across two
rotated files), and is trivial to inspect with `tail -f`.
"""

from __future__ import annotations

import asyncio
from collections import defaultdict
from pathlib import Path

from .config import get_settings


def _dir() -> Path:
    settings = get_settings()
    p = Path(settings.transcript_dir).expanduser().resolve()
    p.mkdir(parents=True, exist_ok=True)
    return p


def _path(agent_id: str, idx: int = 0) -> Path:
    base = _dir() / f"{agent_id}.log"
    return base if idx == 0 else base.with_suffix(f".log.{idx}")


# Per-agent locks so concurrent appends + a concurrent read can't tear.
_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)


def _max_bytes_per_file() -> int:
    return get_settings().transcript_max_bytes_per_file


def _append_blocking(agent_id: str, data: bytes) -> None:
    path = _path(agent_id, 0)
    try:
        sz = path.stat().st_size
    except FileNotFoundError:
        sz = 0
    if sz >= _max_bytes_per_file():
        # Rotate: <id>.log -> <id>.log.1 (overwriting any older .1).
        try:
            path.replace(_path(agent_id, 1))
        except FileNotFoundError:
            pass
    with open(path, "ab") as f:
        f.write(data)


async def append(agent_id: str, data: bytes) -> None:
    if not data:
        return
    async with _locks[agent_id]:
        # The stat/open/write are synchronous filesystem calls; keep them off
        # the event loop so a slow disk can't stall every websocket on this
        # worker.
        await asyncio.to_thread(_append_blocking, agent_id, data)


async def read(agent_id: str, max_bytes: int | None = None) -> bytes:
    """Return the agent's transcript (rotated tail + current head), ordered
    oldest → newest so xterm renders sequentially. With ``max_bytes``, only
    the newest tail is read from disk — long-running agents accumulate tens
    of megabytes, which would otherwise be shipped to the browser whole."""
    async with _locks[agent_id]:
        if max_bytes is None:
            chunks: list[bytes] = []
            # .log.1 is older; .log is newer.
            for idx in (1, 0):
                try:
                    chunks.append(_path(agent_id, idx).read_bytes())
                except FileNotFoundError:
                    continue
            return b"".join(chunks)

        parts: list[bytes] = []
        remaining = max_bytes
        # Newest file first; stop once the budget is filled.
        for idx in (0, 1):
            if remaining <= 0:
                break
            path = _path(agent_id, idx)
            try:
                size = path.stat().st_size
            except FileNotFoundError:
                continue
            take = min(size, remaining)
            with open(path, "rb") as f:
                f.seek(size - take)
                parts.append(f.read(take))
            remaining -= take
        parts.reverse()
        return b"".join(parts)


async def clear(agent_id: str) -> None:
    async with _locks[agent_id]:
        for idx in (0, 1):
            try:
                _path(agent_id, idx).unlink()
            except FileNotFoundError:
                pass
