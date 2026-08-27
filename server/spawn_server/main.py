"""FastAPI app factory + lifespan glue."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import auth
from .agents_builtin import seed_builtin_agents
from .config import get_settings
from .db import dispose_engine, get_sessionmaker, init_engine
from .redis import lifespan_shutdown as redis_shutdown
from .redis import lifespan_startup as redis_startup
from .routes import account_recovery as account_recovery_routes
from .routes import admin as admin_routes
from .routes import agents as agents_routes
from .routes import auth as auth_routes
from .routes import auth_config as auth_config_routes
from .routes import auth_providers as auth_providers_routes
from .routes import browser_devices as browser_devices_routes
from .routes import capabilities as capabilities_routes
from .routes import device as device_routes
from .routes import device_pairing as device_pairing_routes
from .routes import host_introductions as host_introductions_routes
from .routes import hosts as hosts_routes
from .routes import install as install_routes
from .routes import profile as profile_routes
from .routes import push as push_routes
from .routes import release as release_routes
from .routes import root_introductions as root_introductions_routes
from .routes import sessions as sessions_routes
from .routes import trust_bundle as trust_bundle_routes
from .routes import workspace_templates as workspace_templates_routes
from .routes import workspaces as workspaces_routes
from .turn import validate_and_log_ice_config
from .ws import alerts as alerts_ws
from .ws import browser as browser_ws
from .ws import daemon as daemon_ws
from .ws import host as host_ws
from .ws.broker import get_broker

log = logging.getLogger("spawn.main")


class SessionRenewalMiddleware:
    """Attach a staged sliding cookie without changing endpoint task context.

    A pure ASGI response hook matters here: ``BaseHTTPMiddleware`` moves the
    downstream application into another task, which breaks request context
    propagation and can buffer or otherwise interfere with streaming bodies.
    WebSocket scopes pass straight through.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_renewal(message: Message) -> None:
            if message["type"] == "http.response.start":
                state = scope.get("state")
                token = state.get("session_renewal_token") if isinstance(state, dict) else None
                if isinstance(token, str):
                    MutableHeaders(scope=message).append(
                        "set-cookie", auth.session_cookie_header(token)
                    )
            await send(message)

        await self.app(scope, receive, send_with_renewal)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    log.info("starting spawn-server (db=%s redis=%s)", settings.database_url, settings.redis_url)
    validate_and_log_ice_config(settings)

    init_engine()
    await redis_startup()

    # Seed built-in agent definitions idempotently.
    sm = get_sessionmaker()
    async with sm() as session:
        try:
            await seed_builtin_agents(session)
        except Exception as e:  # noqa: BLE001
            log.warning("builtin agent seed skipped: %s", e)
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
    app.add_middleware(SessionRenewalMiddleware)
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
    app.include_router(auth_config_routes.router)
    app.include_router(auth_providers_routes.router)
    app.include_router(browser_devices_routes.router)
    app.include_router(capabilities_routes.router)
    app.include_router(device_routes.router)
    app.include_router(device_pairing_routes.router)
    app.include_router(host_introductions_routes.router)
    app.include_router(root_introductions_routes.router)
    app.include_router(hosts_routes.router)
    app.include_router(profile_routes.router)
    app.include_router(push_routes.router)
    app.include_router(release_routes.router)
    app.include_router(sessions_routes.router)
    app.include_router(workspace_templates_routes.router)
    app.include_router(workspaces_routes.router)
    app.include_router(agents_routes.router)
    app.include_router(install_routes.router)
    app.include_router(trust_bundle_routes.router)

    app.include_router(daemon_ws.router)
    app.include_router(browser_ws.router)
    app.include_router(host_ws.router)
    app.include_router(alerts_ws.router)

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
