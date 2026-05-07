"""Shared test fixtures.

Tests run against in-memory SQLite (using a single shared connection so all
sessions see the same schema), with the in-process Redis fallback enabled.
This keeps the sanity suite fast and dependency-free.
"""

from __future__ import annotations

import os

import pytest_asyncio

# Configure environment BEFORE app modules are imported.
os.environ.setdefault("SPAWN_DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("SPAWN_USE_INPROCESS_PUBSUB", "1")
os.environ.setdefault("SPAWN_JWT_SECRET", "test-secret")

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402

import spawn_server.db as db_mod  # noqa: E402
from spawn_server.config import get_settings  # noqa: E402
from spawn_server.db import Base  # noqa: E402
from spawn_server.main import app as fastapi_app  # noqa: E402
from spawn_server.presets import seed_builtin_presets  # noqa: E402
from spawn_server.redis import get_backend  # noqa: E402

# Force the cached settings to re-read env on each session.
get_settings.cache_clear()  # type: ignore[attr-defined]


@pytest_asyncio.fixture
async def app():
    """Yield a freshly-initialized FastAPI app with empty in-memory DB."""
    # Single shared in-memory SQLite connection — required so multiple sessions see same data.
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        future=True,
    )
    sm = async_sessionmaker(engine, expire_on_commit=False)

    # Override the module-level globals.
    db_mod._engine = engine
    db_mod._sessionmaker = sm

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    # Initialize in-process redis backend.
    await get_backend().startup()

    async with sm() as session:
        await seed_builtin_presets(session)

    yield fastapi_app

    await get_backend().shutdown()
    await engine.dispose()
    db_mod._engine = None
    db_mod._sessionmaker = None


@pytest_asyncio.fixture
async def client(app):
    from httpx import ASGITransport, AsyncClient

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        yield ac
