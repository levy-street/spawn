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


def enable_sqlite_foreign_keys(engine: AsyncEngine) -> None:
    """Enforce foreign keys on every SQLite connection of this engine.

    SQLite ships with foreign keys OFF per connection, so the schema's
    ondelete rules (CASCADE on ownership chains, the deliberate RESTRICT on
    host_key_claims) silently did not exist under SQLite. Postgres —
    production — always enforced them; the pragma makes SQLite-backed runs
    (tests included) exercise the same referential behavior.
    """

    @event.listens_for(engine.sync_engine, "connect")
    def _enable_sqlite_foreign_keys(dbapi_connection, _record):  # type: ignore[no-untyped-def]
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()


def _build_engine(url: str) -> AsyncEngine:
    # SQLite doesn't support pool_size / max_overflow.
    if url.startswith("sqlite"):
        engine = create_async_engine(url, future=True)
        enable_sqlite_foreign_keys(engine)
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
