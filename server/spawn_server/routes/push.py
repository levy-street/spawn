"""`/api/notifications/*` — where to reach an account when nothing is connected.

Two client kinds, one rule. `/devices` takes an Expo push token from a phone;
`/web-push` takes a browser's `PushSubscription`. Both are idempotent on the
address the push service actually uses — the token, the endpoint — because
both rotate without asking: the app re-registers on every launch because a
reinstall, a restore or an OS upgrade reissues its token, and a browser
re-subscribes on a service worker update or a `pushsubscriptionchange` and may
come back with a new endpoint. Re-registering refreshes the row, revives it if
the service had previously reported it gone, and moves it if it now belongs to
a different account.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, schemas
from ..config import get_settings
from ..db import get_session
from ..models import PushDevice, User, WebPushSubscription
from ..web_push import vapid_public_key, web_push_configured

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


@router.get("/web-push/key", response_model=schemas.WebPushKeyOut)
async def web_push_key(
    _user: User = Depends(auth.current_user),
) -> schemas.WebPushKeyOut:
    """The VAPID application server key, or an honest "there isn't one".

    A browser cannot call `pushManager.subscribe` without this, so a server
    with no key configured has no browser channel — which is a supported
    deployment (every development machine is one) and must therefore be a
    200 the web app can branch on, not an error it has to catch.
    """
    settings = get_settings()
    if not web_push_configured(settings):
        return schemas.WebPushKeyOut(enabled=False, public_key=None)
    return schemas.WebPushKeyOut(enabled=True, public_key=vapid_public_key(settings))


@router.post(
    "/web-push",
    response_model=schemas.WebPushSubscriptionOut,
    status_code=status.HTTP_200_OK,
)
async def register_web_push(
    body: schemas.WebPushSubscribeRequest,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.WebPushSubscriptionOut:
    """Record where to reach one browser. Idempotent on the endpoint.

    Refused outright when this server has no VAPID key: by the time the
    browser gets here it has already registered with its push service, and
    silently accepting a subscription that can never be delivered to would
    leave it believing notifications are on.
    """
    if not web_push_configured(get_settings()):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="SPAWN D is not configured to send browser notifications.",
        )

    now = _utcnow()
    # Read the dependency's ORM object once, before anything can roll back —
    # see the note in `register_push_device` for why this is not optional.
    owner_id = user.id
    await session.execute(
        delete(WebPushSubscription).where(
            WebPushSubscription.disabled_at.is_not(None),
            WebPushSubscription.disabled_at < now - DISABLED_PUSH_RETENTION,
        )
    )

    values = {
        "user_id": owner_id,
        "p256dh": body.p256dh,
        "auth": body.auth,
        "label": body.label,
        "browser_device_id": body.browser_device_id,
        "last_seen_at": now,
        # A re-subscribe is the browser telling us it is there. Whatever the
        # push service said last time is stale, including a rate limit.
        "disabled_at": None,
        "retry_after": None,
    }

    async def lookup() -> WebPushSubscription | None:
        return (
            await session.execute(
                select(WebPushSubscription).where(
                    WebPushSubscription.endpoint == body.endpoint
                )
            )
        ).scalar_one_or_none()

    existing = await lookup()
    if existing is not None:
        # An endpoint that reappears under another account has changed hands
        # — a shared machine, a browser profile signed into a second account.
        # Reassigning is what stops the previous owner's alerts from arriving
        # on a browser that is no longer theirs.
        for field, value in values.items():
            setattr(existing, field, value)
        await session.commit()
        subscription = existing
    else:
        session.add(WebPushSubscription(endpoint=body.endpoint, created_at=now, **values))
        try:
            await session.commit()
        except IntegrityError:
            # The same check-then-act window `register_push_device` documents.
            # A page that re-subscribes on focus can easily have two tabs
            # arrive together, both find nothing, and both insert; the unique
            # index settles it and the loser adopts the winner's row.
            await session.rollback()
            session.expunge_all()
            claimed = await session.execute(
                update(WebPushSubscription)
                .where(WebPushSubscription.endpoint == body.endpoint)
                .values(**values)
            )
            if claimed.rowcount == 0:
                raise
            await session.commit()
        found = await lookup()
        if found is None:  # pragma: no cover - the row was just committed
            raise RuntimeError("the web push subscription vanished immediately after registering")
        subscription = found

    await session.refresh(subscription)
    return schemas.WebPushSubscriptionOut.model_validate(subscription)


@router.delete("/web-push", status_code=status.HTTP_204_NO_CONTENT)
async def unregister_web_push(
    endpoint: str = Query(min_length=8, max_length=2048),
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> Response:
    """Stop pushing to one browser — sign-out, or notifications switched off.

    The endpoint is a URL, so it travels as a query parameter rather than a
    path segment: it is the only identifier the browser reliably still has
    (`registration.pushManager.getSubscription()` hands back the subscription,
    never our row id).

    Deleting only ever touches the caller's own row and says nothing about
    whether the endpoint existed — a 204 either way, so this cannot be used to
    test whether some other account owns a given subscription.
    """
    subscription = (
        await session.execute(
            select(WebPushSubscription).where(
                WebPushSubscription.endpoint == endpoint,
                WebPushSubscription.user_id == user.id,
            )
        )
    ).scalar_one_or_none()
    if subscription is not None:
        await session.delete(subscription)
        await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
