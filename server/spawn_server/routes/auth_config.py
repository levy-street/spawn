"""`GET /api/auth/config` — the auth surface's one-shot configuration."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from .. import billing, invites, schemas
from ..config import Settings, get_settings
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
        billing=_billing_config(settings),
    )


def _billing_config(settings: Settings) -> schemas.BillingConfigOut:
    """The billing block, mirroring exactly what `routes/device.py` enforces.

    With billing off there is nothing to sell and nothing to gate, so the tier
    list is empty and the mobile link is off regardless of how they are
    configured — a client reading `enabled: false` draws no billing UI at all,
    and must not be handed prices it would have to decide to ignore.
    """
    free = billing.TIERS[billing.TIER_FREE].host_limit
    if not settings.billing_enabled:
        return schemas.BillingConfigOut(
            enabled=False,
            free_host_limit=free if free is not None else 1,
        )
    return schemas.BillingConfigOut(
        enabled=True,
        free_host_limit=free if free is not None else 1,
        tiers=[
            schemas.BillingTierOut(
                key=tier.key,
                name=tier.name,
                price_cents=tier.price_cents,
                host_limit=tier.host_limit,
            )
            # Cheapest first, so a pricing page never has to sort them itself.
            for tier in (billing.TIERS[key] for key in billing.TIER_ORDER)
        ],
        mobile_upgrade_link=bool(settings.billing_mobile_upgrade_link),
    )
