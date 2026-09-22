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
# Rate limits are per-client and cumulative across a process, so leaving them
# on would make unrelated tests fail based on how many ran before them. Tests
# that exercise limiting turn it back on explicitly.
os.environ.setdefault("SPAWN_RATE_LIMIT_ENABLED", "false")
# Production defaults to a closed deployment; most tests create several
# accounts and are not about that gate. The invite tests turn it back on.
os.environ.setdefault("SPAWN_INVITE_ONLY", "false")
os.environ.setdefault("SPAWN_USE_INPROCESS_PUBSUB", "1")
os.environ.setdefault("SPAWN_JWT_SECRET", "test-secret")
# Tests use an HTTP client and assert development cookie/redirect behavior.
# Override developer shell and .env values before importing the application.
os.environ["SPAWN_PUBLIC_URL"] = "http://localhost:8000"

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402

import spawn_server.db as db_mod  # noqa: E402
from spawn_server.agents_builtin import seed_builtin_agents  # noqa: E402
from spawn_server.config import get_settings  # noqa: E402
from spawn_server.db import Base  # noqa: E402
from spawn_server.main import app as fastapi_app  # noqa: E402
from spawn_server.redis import get_backend  # noqa: E402
from spawn_server.ws.broker import get_broker  # noqa: E402

# Force the cached settings to re-read env on each session.
get_settings.cache_clear()  # type: ignore[attr-defined]


@pytest_asyncio.fixture
async def app():
    """Yield a freshly-initialized FastAPI app with empty in-memory DB."""
    external_services = os.environ.get("SPAWN_TEST_EXTERNAL_SERVICES") == "1"
    if external_services:
        # The opt-in crash/race smoke runs these same tests against real
        # PostgreSQL and Redis instead of silently exercising the fallbacks.
        engine = create_async_engine(get_settings().database_url, future=True)
    else:
        # Single shared in-memory SQLite connection — required so multiple
        # sessions see the same schema.
        engine = create_async_engine(
            "sqlite+aiosqlite:///:memory:",
            connect_args={"check_same_thread": False},
            future=True,
        )
        # The same pragmas production's SQLite runs under.
        db_mod.configure_sqlite_connections(engine)
    sm = async_sessionmaker(engine, expire_on_commit=False)

    # Override the module-level globals.
    db_mod._engine = engine
    db_mod._sessionmaker = sm

    async with engine.begin() as conn:
        if external_services:
            await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    # Initialize in-process redis backend.
    await get_backend().startup()

    async with sm() as session:
        await seed_builtin_agents(session)

    yield fastapi_app

    await get_broker().shutdown()
    await get_backend().shutdown()
    if external_services:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()
    db_mod._engine = None
    db_mod._sessionmaker = None


@pytest_asyncio.fixture
async def client(app):
    from httpx import ASGITransport, AsyncClient

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        yield ac


@pytest_asyncio.fixture
async def file_sqlite_client(app, tmp_path):
    """Exercise real concurrent SQLite connections instead of one shared in-memory connection."""

    from httpx import ASGITransport, AsyncClient

    previous_engine = db_mod._engine
    previous_sessionmaker = db_mod._sessionmaker
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'spawn-test.db'}",
        connect_args={"timeout": 30},
        future=True,
    )
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    db_mod._engine = engine
    db_mod._sessionmaker = sessionmaker
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        async with sessionmaker() as session:
            await seed_builtin_agents(session)

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
            yield ac
    finally:
        db_mod._engine = previous_engine
        db_mod._sessionmaker = previous_sessionmaker
        await engine.dispose()
