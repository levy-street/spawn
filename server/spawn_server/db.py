"""Async SQLAlchemy engine and session dependency."""

from __future__ import annotations

from collections.abc import AsyncIterator

from sqlalchemy import event
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from .config import get_settings


class Base(DeclarativeBase):
    """Declarative base for all ORM models."""


_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


# How long a SQLite connection waits for a lock before `database is locked`.
# The driver's default is five seconds. Production runs on SQLite, and a burst
# of daemon registrations on a starved host outlasted that: each failure cost
# the daemon its websocket and the server another registration (2026-09-22).
SQLITE_BUSY_TIMEOUT_MS = 15_000


def configure_sqlite_connections(engine: AsyncEngine) -> None:
    """Set the pragmas every SQLite connection of this engine relies on.

    `foreign_keys=ON`: SQLite ships with foreign keys OFF per connection, so
    the schema's ondelete rules (CASCADE on ownership chains, the deliberate
    RESTRICT on host_key_claims) would silently not exist. Postgres always
    enforced them; the pragma gives SQLite-backed runs the same behavior.

    `journal_mode=WAL`: the default rollback journal makes every writer block
    every reader for the whole transaction, so one slow heartbeat UPDATE
    stalled every daemon's registration lookup. In WAL readers never wait for
    a writer. The mode persists in the file, so this is a no-op after the
    first connection; an in-memory database answers `memory` and is left so.

    `busy_timeout`: see `SQLITE_BUSY_TIMEOUT_MS`. Set before the journal-mode
    switch so that switch itself waits for a busy database instead of failing.

    `synchronous=NORMAL`: with WAL a commit survives a process crash without
    an fsync per transaction; only power loss can lose the newest ones.
    """

    @event.listens_for(engine.sync_engine, "connect")
    def _configure_sqlite_connection(dbapi_connection, _record):  # type: ignore[no-untyped-def]
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute(f"PRAGMA busy_timeout={SQLITE_BUSY_TIMEOUT_MS}")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.close()


def _build_engine(url: str) -> AsyncEngine:
    # SQLite doesn't support pool_size / max_overflow.
    if url.startswith("sqlite"):
        engine = create_async_engine(url, future=True)
        configure_sqlite_connections(engine)
        return engine
    return create_async_engine(url, future=True, pool_pre_ping=True)


def init_engine(url: str | None = None) -> AsyncEngine:
    """(Re)initialize the global engine. Call from lifespan or tests."""
    global _engine, _sessionmaker
    settings = get_settings()
    _engine = _build_engine(url or settings.database_url)
    _sessionmaker = async_sessionmaker(_engine, expire_on_commit=False)
    return _engine


def get_engine() -> AsyncEngine:
    if _engine is None:
        init_engine()
    assert _engine is not None
    return _engine


def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    if _sessionmaker is None:
        init_engine()
    assert _sessionmaker is not None
    return _sessionmaker


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency yielding an AsyncSession."""
    sm = get_sessionmaker()
    async with sm() as session:
        yield session


async def dispose_engine() -> None:
    global _engine, _sessionmaker
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _sessionmaker = None
