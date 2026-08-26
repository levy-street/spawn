"""`/api/notifications/devices` — where to reach an account's app installs.

Registration is idempotent on the token, because the app re-registers on every
launch: the push service reissues tokens on reinstall, restore and some OS
upgrades, and an app that only registered once would go quiet without ever
noticing. Re-registering an existing token refreshes it, revives it if the
service had previously reported it dead, and moves it if it now belongs to a
different account.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, schemas
from ..db import get_session
from ..models import PushDevice, User

router = APIRouter(prefix="/api/notifications", tags=["notifications"])
DISABLED_PUSH_RETENTION = timedelta(days=90)


def _utcnow() -> datetime:
    return datetime.now(UTC)


@router.post(
    "/devices",
    response_model=schemas.PushDeviceOut,
    status_code=status.HTTP_200_OK,
)
async def register_push_device(
    body: schemas.PushDeviceRegisterRequest,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.PushDeviceOut:
    now = _utcnow()
    # Read off the dependency's ORM object once, before anything can roll back.
    # `user` lives in this session, so a rollback expires it — and reading
    # `user.id` after that is a lazy reload, which is IO from a place
    # SQLAlchemy refuses to do it (MissingGreenlet). The recovery path below
    # needs this value precisely when it is no longer safe to ask for.
    owner_id = user.id
    await session.execute(
        delete(PushDevice).where(
            PushDevice.disabled_at.is_not(None),
            PushDevice.disabled_at < now - DISABLED_PUSH_RETENTION,
        )
    )
    def claim(device: PushDevice) -> PushDevice:
        # A token that reappears under another account has moved handsets or
        # hands; reassigning it is what stops the previous owner's alerts from
        # continuing to arrive on a phone that is no longer theirs.
        device.user_id = owner_id
        device.platform = body.platform
        device.label = body.label
        device.browser_device_id = body.browser_device_id
        device.last_seen_at = now
        device.disabled_at = None
        return device

    async def lookup() -> PushDevice | None:
        return (
            await session.execute(select(PushDevice).where(PushDevice.token == body.token))
        ).scalar_one_or_none()

    existing = await lookup()

    if existing is not None:
        device = claim(existing)
        await session.commit()
    else:
        session.add(
            PushDevice(
                user_id=owner_id,
                token=body.token,
                platform=body.platform,
                label=body.label,
                browser_device_id=body.browser_device_id,
                created_at=now,
                last_seen_at=now,
            )
        )
        try:
            await session.commit()
        except IntegrityError:
            # Looking the token up and then inserting it is a check-then-act,
            # and the app re-registers on every connection attempt — so tapping
            # "Ask again" a few times is enough for two requests to find no row
            # and both insert one.  The unique index settles it; the loser
            # adopts the row the winner wrote rather than 500ing at a phone
            # whose only crime was asking twice.
            #
            # The recovery writes with a statement rather than by mutating a
            # freshly-loaded object: a rolled-back session has expired every
            # instance it holds, and assigning to one of those attributes
            # reaches for the old value, which is IO in a place SQLAlchemy will
            # not do it from.
            await session.rollback()
            # Nothing this session was holding survived the collision: a
            # rolled-back session expires every instance it mapped, and reading
            # one of those attributes later reaches for the database from a
            # place SQLAlchemy will not do IO. Drop them and start clean.
            session.expunge_all()
            claimed = await session.execute(
                update(PushDevice)
                .where(PushDevice.token == body.token)
                .values(
                    user_id=owner_id,
                    platform=body.platform,
                    label=body.label,
                    browser_device_id=body.browser_device_id,
                    last_seen_at=now,
                    disabled_at=None,
                )
            )
            if claimed.rowcount == 0:
                # The row the insert collided with is already gone. Nothing to
                # adopt, and nothing useful to say beyond the original error.
                raise
            await session.commit()
        device = await lookup()
        if device is None:  # pragma: no cover - the row was just committed
            raise RuntimeError("the push device vanished immediately after registering")

    await session.refresh(device)
    return schemas.PushDeviceOut.model_validate(device)


@router.delete("/devices/{token}", status_code=status.HTTP_204_NO_CONTENT)
async def unregister_push_device(
    token: str,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> Response:
    """Stop pushing to one install — sign-out, or notifications switched off.

    Deleting only ever touches the caller's own row, and says nothing about
    whether the token existed: a 204 either way, so this cannot be used to test
    whether some other account owns a given token.
    """
    device = (
        await session.execute(
            select(PushDevice).where(
                PushDevice.token == token,
                PushDevice.user_id == user.id,
            )
        )
    ).scalar_one_or_none()
    if device is not None:
        await session.delete(device)
        await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
