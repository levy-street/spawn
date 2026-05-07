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


async def append(agent_id: str, data: bytes) -> None:
    if not data:
        return
    async with _locks[agent_id]:
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


async def read(agent_id: str) -> bytes:
    """Return the agent's full transcript (rotated tail + current head),
    capped to fit recent history. Order: oldest → newest so xterm renders
    sequentially."""
    async with _locks[agent_id]:
        chunks: list[bytes] = []
        # .log.1 is older; .log is newer.
        for idx in (1, 0):
            try:
                chunks.append(_path(agent_id, idx).read_bytes())
            except FileNotFoundError:
                continue
        return b"".join(chunks)


async def clear(agent_id: str) -> None:
    async with _locks[agent_id]:
        for idx in (0, 1):
            try:
                _path(agent_id, idx).unlink()
            except FileNotFoundError:
                pass
