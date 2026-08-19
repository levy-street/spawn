"""FastAPI app factory + lifespan glue."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import assert_jwt_secret_usable, get_settings
from .db import dispose_engine, get_sessionmaker, init_engine
from .presets import seed_builtin_presets
from .redis import lifespan_shutdown as redis_shutdown
from .redis import lifespan_startup as redis_startup
from .routes import account_recovery as account_recovery_routes
from .routes import admin as admin_routes
from .routes import agents as agents_routes
from .routes import auth as auth_routes
from .routes import auth_providers as auth_providers_routes
from .routes import browser_devices as browser_devices_routes
from .routes import capabilities as capabilities_routes
from .routes import device as device_routes
from .routes import hosts as hosts_routes
from .routes import install as install_routes
from .routes import presets as presets_routes
from .routes import screens as screens_routes
from .routes import trust_bundle as trust_bundle_routes
from .ws import browser as browser_ws
from .ws import daemon as daemon_ws
from .ws import host as host_ws
from .ws.broker import get_broker

log = logging.getLogger("spawn.main")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    # Before anything else, and before a single request is served: a
    # guessable signing key means every token on this deployment is
    # forgeable, so refuse to come up rather than fail open quietly.
    assert_jwt_secret_usable(settings)
    log.info("starting spawn-server (db=%s redis=%s)", settings.database_url, settings.redis_url)

    init_engine()
    await redis_startup()

    # Seed built-in presets idempotently.
    sm = get_sessionmaker()
    async with sm() as session:
        try:
            await seed_builtin_presets(session)
        except Exception as e:  # noqa: BLE001
            log.warning("preset seed skipped: %s", e)
    hosts_routes.start_auto_update_checker()

    try:
        yield
    finally:
        await hosts_routes.stop_auto_update_checker()
        await get_broker().shutdown()
        await redis_shutdown()
        await dispose_engine()


def create_app() -> FastAPI:
    app = FastAPI(title="spawn-server", version="0.1.0", lifespan=lifespan)

    settings = get_settings()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(auth_routes.router)
    app.include_router(account_recovery_routes.router)
    app.include_router(admin_routes.router)
    app.include_router(auth_providers_routes.router)
    app.include_router(browser_devices_routes.router)
    app.include_router(capabilities_routes.router)
    app.include_router(device_routes.router)
    app.include_router(hosts_routes.router)
    app.include_router(agents_routes.router)
    app.include_router(presets_routes.router)
    app.include_router(screens_routes.router)
    app.include_router(install_routes.router)
    app.include_router(trust_bundle_routes.router)

    app.include_router(daemon_ws.router)
    app.include_router(browser_ws.router)
    app.include_router(host_ws.router)

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
