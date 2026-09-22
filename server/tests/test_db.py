"""The engine's per-connection SQLite setup."""

from __future__ import annotations

import pytest
from sqlalchemy import text

from spawn_server import db as db_mod


async def _pragma(conn, name: str):  # type: ignore[no-untyped-def]
    return (await conn.execute(text(f"PRAGMA {name}"))).scalar_one()


@pytest.mark.asyncio
async def test_a_file_database_runs_in_wal_with_the_long_busy_timeout(tmp_path):
    engine = db_mod._build_engine(f"sqlite+aiosqlite:///{tmp_path / 'pragmas.db'}")
    try:
        async with engine.connect() as conn:
            assert await _pragma(conn, "journal_mode") == "wal"
            assert await _pragma(conn, "busy_timeout") == db_mod.SQLITE_BUSY_TIMEOUT_MS
            assert await _pragma(conn, "foreign_keys") == 1
            # NORMAL
            assert await _pragma(conn, "synchronous") == 1
    finally:
        await engine.dispose()
    # The journal mode is a property of the file: a second engine finds it set.
    again = db_mod._build_engine(f"sqlite+aiosqlite:///{tmp_path / 'pragmas.db'}")
    try:
        async with again.connect() as conn:
            assert await _pragma(conn, "journal_mode") == "wal"
    finally:
        await again.dispose()


@pytest.mark.asyncio
async def test_an_in_memory_database_keeps_its_own_journal(tmp_path):
    engine = db_mod._build_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.connect() as conn:
            assert await _pragma(conn, "journal_mode") == "memory"
            assert await _pragma(conn, "foreign_keys") == 1
    finally:
        await engine.dispose()
