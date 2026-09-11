"""`POST /api/waitlist` — an address left while signup is invite-only.

Public and unauthenticated: it sits on every marketing page and under the
closed signup form. The response is the same whatever the address's standing
— new, already listed, or already an account — so the endpoint cannot be used
to learn who is here. Abuse is bounded by the rate limit and by the unique
address, not by anything the caller can observe.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, rate_limit, schemas
from ..db import get_session
from ..models import User, WaitlistEntry

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/waitlist", tags=["waitlist"])


def clean_source(source: str | None) -> str | None:
    """The page the form sat on, reduced to a label.

    A site path or a short word; anything else is dropped rather than stored,
    so the admin table never renders a client-chosen string with markup in it.
    """

    if source is None:
        return None
    value = "".join(ch for ch in source.strip() if ch.isprintable() and ch not in "<>\"'")
    return value[:120] or None


@router.post(
    "",
    response_model=schemas.WaitlistJoinOut,
    dependencies=[Depends(rate_limit.limiter(rate_limit.WAITLIST))],
)
async def join_waitlist(
    body: schemas.WaitlistJoinRequest,
    session: AsyncSession = Depends(get_session),
) -> schemas.WaitlistJoinOut:
    email = auth.normalize_email(body.email)

    # An address that already has an account has nothing to wait for. Not
    # stored, but acknowledged identically.
    has_account = (
        await session.execute(select(User.id).where(func.lower(User.email) == email))
    ).scalar_one_or_none() is not None
    if has_account:
        return schemas.WaitlistJoinOut()

    listed = (
        await session.execute(select(WaitlistEntry.id).where(WaitlistEntry.email == email))
    ).scalar_one_or_none()
    if listed is not None:
        return schemas.WaitlistJoinOut()

    session.add(WaitlistEntry(email=email, source=clean_source(body.source)))
    try:
        await session.commit()
    except IntegrityError:
        # Two submissions of one address racing: the first one won, and the
        # second one is the same request.
        await session.rollback()
    return schemas.WaitlistJoinOut()
