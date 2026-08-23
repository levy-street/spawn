"""`GET /api/auth/config` — the auth surface's one-shot configuration."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from .. import invites, schemas
from ..config import get_settings
from ..db import get_session
from ..mail import mailer_ready
from .auth_providers import enabled_provider_summaries

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.get("/config", response_model=schemas.AuthConfigOut)
async def auth_config(session: AsyncSession = Depends(get_session)) -> schemas.AuthConfigOut:
    settings = get_settings()
    return schemas.AuthConfigOut(
        providers=enabled_provider_summaries(settings),
        # The exact condition auth.verified_user enforces: the gate is inert
        # when mail cannot actually be delivered, so onboarding must not show
        # a verify step the server would never require.
        email_verification_required=bool(
            settings.require_email_verification and mailer_ready()
        ),
        # Mirrors the signup route's actual enforcement, not the static flag:
        # a closed install with no accounts admits its first signup freely
        # (nobody exists to issue an invite), so the form must not demand a
        # code that cannot exist. Populated installs report closed as before.
        invite_only=not await invites.signup_is_open(session),
    )
