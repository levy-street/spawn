"""Signup invites for a closed deployment.

An invite is a bearer credential: whoever holds the code can create one
account. It is stored hashed, single-use, expiring, and revocable, and the
plaintext exists only in the response that created it.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import get_settings
from .models import Invite, User

INVITE_CODE_BYTES = 24


def hash_code(code: str) -> str:
    return hashlib.sha256(code.strip().encode("utf-8")).hexdigest()


def invite_url(code: str) -> str:
    settings = get_settings()
    base = (settings.web_url or settings.public_url).rstrip("/")
    return f"{base}/signup?invite={code}"


async def create_invite(
    session: AsyncSession,
    *,
    created_by: User,
    email: str | None,
    ttl_hours: int | None = None,
) -> tuple[Invite, str]:
    """Mint an invite. Returns the row and the plaintext code (shown once)."""

    hours = ttl_hours or get_settings().invite_default_ttl_hours
    code = secrets.token_urlsafe(INVITE_CODE_BYTES)
    invite = Invite(
        code_hash=hash_code(code),
        email=(email or None),
        created_by_user_id=created_by.id,
        expires_at=datetime.now(UTC) + timedelta(hours=hours),
    )
    session.add(invite)
    return invite, code


def invite_state(invite: Invite, *, now: datetime | None = None) -> str:
    """One word for what this invite can currently do."""

    moment = now or datetime.now(UTC)
    expires_at = invite.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=UTC)
    if invite.used_at is not None:
        return "used"
    if invite.revoked_at is not None:
        return "revoked"
    if expires_at <= moment:
        return "expired"
    return "pending"


async def redeem_invite(session: AsyncSession, code: str) -> Invite:
    """Claim an invite, or raise ValueError with a reason.

    Deliberately vague to the caller's caller: signup surfaces one message for
    every failure so a stranger probing codes cannot learn which ones exist.
    """

    return await redeem_invite_hash(session, hash_code(code))


async def redeem_invite_hash(session: AsyncSession, code_hash: str) -> Invite:
    """Claim an invite already reduced to its hash.

    A provider sign-in cannot hold the raw code across the round trip: the
    invite arrives on the start URL, and what comes back from the provider is
    only the state this server minted. So the hash is what gets stored, and the
    lookup is against the hash either way — `Invite` never holds the code.
    """

    invite = (
        await session.execute(select(Invite).where(Invite.code_hash == code_hash))
    ).scalar_one_or_none()
    if invite is None:
        raise ValueError("unknown invite")
    state = invite_state(invite)
    if state != "pending":
        raise ValueError(state)
    return invite


async def is_first_account(session: AsyncSession) -> bool:
    """Whether this deployment has no accounts yet.

    Kept strictly separate from :func:`signup_is_open`: conflating them makes
    every signup on an OPEN deployment look like the first one, which would
    hand admin to everybody who registers.
    """

    total = (await session.execute(select(func.count()).select_from(User))).scalar_one()
    return int(total) == 0


async def signup_is_open(session: AsyncSession) -> bool:
    """Whether an account can be created without an invite.

    True when the deployment is open, or when it has no accounts at all: a
    closed install with nobody in it has no one who could issue the first
    invite, so the first signup is always allowed.
    """

    if not get_settings().invite_only:
        return True
    return await is_first_account(session)
