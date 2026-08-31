"""Admin surface: who is on this deployment, and who may join it.

Authorization is the `is_admin` flag on the account, checked on every request.
The admin UI is served from its own hostname for convenience, but hostname is
packaging, never permission — these endpoints are equally reachable from the
main origin and equally guarded there.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, billing, email_templates, schemas
from ..config import get_settings
from ..db import get_session
from ..invites import create_invite, invite_state, invite_url
from ..mail import mailer_ready, send_email
from ..models import BrowserDevice, EmailLog, Host, Invite, Session, Subscription, User

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin", tags=["admin"])


def _site_url() -> str:
    settings = get_settings()
    return (settings.web_url or settings.public_url).rstrip("/")


async def require_admin(user: User = Depends(auth.current_user)) -> User:
    if not user.is_admin:
        # 404 rather than 403: a non-admin has no business learning that this
        # surface exists on this deployment.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    return user


def _effective_host_limit(user: User, subscription: Subscription | None) -> int | None:
    """What `billing.may_add_host` would enforce for this account. None = unlimited.

    `billing.entitlement()` is the authority and answers exactly this, but it
    reads the subscription itself, and this list would then be one query per
    user. So the *order* is mirrored here while the numbers and the entitling
    statuses still come from `billing`. Keep the two in step: a divergence
    would show an admin a limit nobody is held to.
    """
    if not get_settings().billing_enabled:
        return None
    if user.host_limit_override is not None:
        return None if user.host_limit_override == 0 else user.host_limit_override
    if subscription is not None and subscription.status in billing.ENTITLING_STATUSES:
        return subscription.host_limit
    return billing.host_limit_for_tier(billing.TIER_FREE)


def _admin_user_out(
    user: User,
    *,
    subscription: Subscription | None,
    host_count: int,
    session_count: int,
    browser_device_count: int,
) -> schemas.AdminUserOut:
    return schemas.AdminUserOut(
        id=user.id,
        email=user.email,
        created_at=user.created_at,
        email_verified_at=user.email_verified_at,
        is_admin=user.is_admin,
        host_count=host_count,
        session_count=session_count,
        browser_device_count=browser_device_count,
        host_limit_override=user.host_limit_override,
        # The row as it stands, not the entitlement: a comped account keeps
        # whatever tier it is subscribed to, and an operator wants to see both
        # that and the limit actually in force.
        billing_tier=subscription.tier if subscription is not None else billing.TIER_FREE,
        effective_host_limit=_effective_host_limit(user, subscription),
    )


def _invite_out(invite: Invite, *, code: str | None = None) -> schemas.AdminInviteOut:
    return schemas.AdminInviteOut(
        id=invite.id,
        email=invite.email,
        state=invite_state(invite),
        expires_at=invite.expires_at,
        created_at=invite.created_at,
        used_at=invite.used_at,
        created_by_user_id=invite.created_by_user_id,
        used_by_user_id=invite.used_by_user_id,
        # Present only in the response that minted it: the code is stored
        # hashed and cannot be recovered afterwards.
        url=invite_url(code) if code else None,
    )


@router.get("/users", response_model=list[schemas.AdminUserOut])
async def list_users(
    _: User = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> list[schemas.AdminUserOut]:
    users = (await session.execute(select(User).order_by(User.created_at.asc()))).scalars().all()

    # One grouped query per relation rather than per user: this list is small
    # today and should not become N+1 the week it is not.
    host_counts = dict(
        (
            await session.execute(
                select(Host.owner_user_id, func.count()).group_by(Host.owner_user_id)
            )
        ).all()
    )
    session_counts = dict(
        (
            await session.execute(
                select(Session.owner_user_id, func.count()).group_by(Session.owner_user_id)
            )
        ).all()
    )
    device_counts = dict(
        (
            await session.execute(
                select(BrowserDevice.owner_user_id, func.count())
                .where(BrowserDevice.revoked_at.is_(None))
                .group_by(BrowserDevice.owner_user_id)
            )
        ).all()
    )
    # One more grouped read, in the same spirit: there is at most one row per
    # account and only for accounts that have ever paid, so this is smaller
    # than the user list it decorates. Skipped entirely with billing off, which
    # also keeps this page working on a self-hosted install that has never run
    # migration 0068.
    subscriptions: dict[str, Subscription] = {}
    if get_settings().billing_enabled:
        subscriptions = {
            row.user_id: row
            for row in (await session.execute(select(Subscription))).scalars().all()
        }

    return [
        _admin_user_out(
            user,
            subscription=subscriptions.get(user.id),
            host_count=int(host_counts.get(user.id, 0)),
            session_count=int(session_counts.get(user.id, 0)),
            browser_device_count=int(device_counts.get(user.id, 0)),
        )
        for user in users
    ]


@router.patch("/users/{user_id}", response_model=schemas.AdminUserOut)
async def patch_user(
    user_id: str,
    body: schemas.AdminUserPatch,
    _: User = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> schemas.AdminUserOut:
    """Comp an account, or stop comping it. How internal accounts never pay.

    `host_limit_override` outranks any subscription, so this works on an
    account with a lapsed card and needs no Stripe call — which is the point:
    comping is an operator decision about our own product, not a discount
    somebody has to remember to cancel in a dashboard.

    A field the body omits is left alone; an explicit null clears the override,
    which is why `model_fields_set` is consulted rather than the value.
    """
    target = await session.get(User, user_id)
    if target is None:
        raise HTTPException(status_code=404, detail="user not found")

    if "host_limit_override" in body.model_fields_set:
        target.host_limit_override = body.host_limit_override
        await session.commit()
        await session.refresh(target)

    subscription = None
    if get_settings().billing_enabled:
        subscription = (
            await session.execute(select(Subscription).where(Subscription.user_id == target.id))
        ).scalar_one_or_none()
    return _admin_user_out(
        target,
        subscription=subscription,
        host_count=await billing.host_count(session, target.id),
        session_count=int(
            (
                await session.execute(
                    select(func.count()).select_from(Session).where(
                        Session.owner_user_id == target.id
                    )
                )
            ).scalar_one()
        ),
        browser_device_count=int(
            (
                await session.execute(
                    select(func.count())
                    .select_from(BrowserDevice)
                    .where(
                        BrowserDevice.owner_user_id == target.id,
                        BrowserDevice.revoked_at.is_(None),
                    )
                )
            ).scalar_one()
        ),
    )


@router.get("/invites", response_model=list[schemas.AdminInviteOut])
async def list_invites(
    _: User = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> list[schemas.AdminInviteOut]:
    invites = (
        (await session.execute(select(Invite).order_by(Invite.created_at.desc()))).scalars().all()
    )
    return [_invite_out(invite) for invite in invites]


@router.post("/invites", response_model=schemas.AdminInviteOut)
async def create_invite_endpoint(
    body: schemas.AdminInviteCreate,
    admin: User = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> schemas.AdminInviteOut:
    invite, code = await create_invite(
        session, created_by=admin, email=body.email, ttl_hours=body.ttl_hours
    )
    await session.commit()
    await session.refresh(invite)

    url = invite_url(code)
    if body.email:
        rendered = email_templates.invite(link=url, site_url=_site_url(), inviter=admin.email)
        try:
            await send_email(
                to=body.email,
                subject=rendered.subject,
                body=rendered.text,
                html_body=rendered.html,
                kind="invite",
            )
        except Exception as exc:
            # The URL is returned regardless: the admin can always hand it over
            # themselves, and failing the request would discard a live invite.
            log.warning("could not send invite email to %s: %s", body.email, exc)

    return _invite_out(invite, code=code)


@router.post("/invites/{invite_id}/revoke", response_model=schemas.AdminInviteOut)
async def revoke_invite(
    invite_id: str,
    _: User = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> schemas.AdminInviteOut:
    invite = await session.get(Invite, invite_id)
    if invite is None:
        raise HTTPException(status_code=404, detail="invite not found")
    if invite.used_at is None and invite.revoked_at is None:
        invite.revoked_at = datetime.now(UTC)
        await session.commit()
        await session.refresh(invite)
    return _invite_out(invite)


@router.get("/mail", response_model=schemas.AdminMailStatus)
async def mail_status(_: User = Depends(require_admin)) -> schemas.AdminMailStatus:
    settings = get_settings()
    backend = settings.email_backend.strip().lower()
    return schemas.AdminMailStatus(
        backend=backend,
        delivering=mailer_ready(),
        from_address=settings.email_from,
        smtp_host=settings.smtp_host or None,
    )


@router.get("/emails", response_model=list[schemas.AdminEmailOut])
async def list_emails(
    limit: int = 100,
    _: User = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> list[schemas.AdminEmailOut]:
    rows = (
        (
            await session.execute(
                select(EmailLog).order_by(EmailLog.created_at.desc()).limit(max(1, min(limit, 500)))
            )
        )
        .scalars()
        .all()
    )
    return [
        schemas.AdminEmailOut(
            id=row.id,
            to_email=row.to_email,
            subject=row.subject,
            kind=row.kind,
            status=row.status,
            error=row.error,
            body_redacted=row.body_redacted,
            created_at=row.created_at,
        )
        for row in rows
    ]


@router.post("/emails/test", response_model=schemas.AdminEmailOut)
async def send_test_email(
    body: schemas.AdminTestEmail,
    admin: User = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> schemas.AdminEmailOut:
    """Send a message to prove the mailer works, and surface the failure if not.

    Delivery problems are otherwise invisible until a user cannot reset their
    password, so this reports the transport error verbatim instead of the
    deliberately vague message the public endpoints use.
    """

    recipient = body.to or admin.email
    error: str | None = None
    rendered = email_templates.test_email(site_url=_site_url())
    try:
        await send_email(
            to=recipient,
            subject=rendered.subject,
            body=rendered.text,
            html_body=rendered.html,
            kind="test",
        )
    except Exception as exc:
        error = str(exc)

    row = (
        await session.execute(select(EmailLog).order_by(EmailLog.created_at.desc()).limit(1))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=500, detail=error or "the mailer recorded nothing")
    return schemas.AdminEmailOut(
        id=row.id,
        to_email=row.to_email,
        subject=row.subject,
        kind=row.kind,
        status=row.status,
        error=row.error,
        body_redacted=row.body_redacted,
        created_at=row.created_at,
    )
