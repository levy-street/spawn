"""`GET /api/auth/config` — the auth surface's one-shot configuration."""

from __future__ import annotations

from fastapi import APIRouter

from .. import schemas
from ..config import get_settings
from ..mail import mailer_ready
from .auth_providers import enabled_provider_summaries

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.get("/config", response_model=schemas.AuthConfigOut)
async def auth_config() -> schemas.AuthConfigOut:
    settings = get_settings()
    return schemas.AuthConfigOut(
        providers=enabled_provider_summaries(settings),
        # The exact condition auth.verified_user enforces: the gate is inert
        # when mail cannot actually be delivered, so onboarding must not show
        # a verify step the server would never require.
        email_verification_required=bool(
            settings.require_email_verification and mailer_ready()
        ),
        invite_only=bool(settings.invite_only),
    )
