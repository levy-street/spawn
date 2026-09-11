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

from .. import auth, email_templates, schemas
from ..config import get_settings
from ..db import get_session
from ..invites import create_invite, invite_state, invite_url
from ..mail import mailer_ready, send_email
from ..models import BrowserDevice, EmailLog, Host, Invite, Session, User, WaitlistEntry

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

    return [
        schemas.AdminUserOut(
            id=user.id,
            email=user.email,
            created_at=user.created_at,
            email_verified_at=user.email_verified_at,
            is_admin=user.is_admin,
            host_count=int(host_counts.get(user.id, 0)),
            session_count=int(session_counts.get(user.id, 0)),
            browser_device_count=int(device_counts.get(user.id, 0)),
        )
        for user in users
    ]


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

    if body.email:
        await _mail_invite(invite_url(code), to=body.email, inviter=admin)

    return _invite_out(invite, code=code)


async def _mail_invite(url: str, *, to: str, inviter: User) -> None:
    """Send the invitation, best effort.

    The URL is returned to the admin regardless: they can always hand it over
    themselves, and failing the request would discard a live invite.
    """

    rendered = email_templates.invite(link=url, site_url=_site_url(), inviter=inviter.email)
    try:
        await send_email(
            to=to,
            subject=rendered.subject,
            body=rendered.text,
            html_body=rendered.html,
            kind="invite",
        )
    except Exception as exc:
        log.warning("could not send invite email to %s: %s", to, exc)


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


# ---------- waitlist ----------


def _waitlist_out(
    entry: WaitlistEntry,
    *,
    invite: Invite | None,
    has_account: bool,
) -> schemas.AdminWaitlistEntryOut:
    return schemas.AdminWaitlistEntryOut(
        id=entry.id,
        email=entry.email,
        source=entry.source,
        created_at=entry.created_at,
        invited_at=entry.invited_at,
        invite_id=entry.invite_id,
        invite_state=invite_state(invite) if invite is not None else None,
        has_account=has_account,
    )


async def _account_exists(session: AsyncSession, email: str) -> bool:
    found = (
        await session.execute(select(User.id).where(func.lower(User.email) == email.lower()))
    ).scalar_one_or_none()
    return found is not None


@router.get("/waitlist", response_model=list[schemas.AdminWaitlistEntryOut])
async def list_waitlist(
    _: User = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> list[schemas.AdminWaitlistEntryOut]:
    entries = (
        (await session.execute(select(WaitlistEntry).order_by(WaitlistEntry.created_at.desc())))
        .scalars()
        .all()
    )
    if not entries:
        return []
    invite_ids = [entry.invite_id for entry in entries if entry.invite_id is not None]
    invites: dict[str, Invite] = {}
    if invite_ids:
        rows = (await session.execute(select(Invite).where(Invite.id.in_(invite_ids)))).scalars()
        invites = {invite.id: invite for invite in rows}
    emails = [entry.email for entry in entries]
    accounts = {
        row.lower()
        for row in (
            await session.execute(select(User.email).where(func.lower(User.email).in_(emails)))
        ).scalars()
    }
    return [
        _waitlist_out(
            entry,
            invite=invites.get(entry.invite_id) if entry.invite_id else None,
            has_account=entry.email in accounts,
        )
        for entry in entries
    ]


@router.post("/waitlist/{entry_id}/invite", response_model=schemas.AdminInviteOut)
async def invite_from_waitlist(
    entry_id: str,
    body: schemas.AdminWaitlistInvite | None = None,
    admin: User = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> schemas.AdminInviteOut:
    """Mint an invite for a waitlisted address and send it.

    An ordinary invite, addressed to the entry, and recorded on the entry so
    the list shows who has been sent a code and whether it was used. Inviting
    again is allowed — the previous code may have expired — and simply points
    the entry at the newest invite.
    """

    entry = await session.get(WaitlistEntry, entry_id)
    if entry is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="waitlist entry not found"
        )
    if await _account_exists(session, entry.email):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="this address already has an account"
        )
    invite, code = await create_invite(
        session,
        created_by=admin,
        email=entry.email,
        ttl_hours=body.ttl_hours if body is not None else None,
    )
    # The invite's id is assigned on flush; the entry needs it.
    await session.flush()
    entry.invite_id = invite.id
    entry.invited_at = datetime.now(UTC)
    await session.commit()
    await session.refresh(invite)

    await _mail_invite(invite_url(code), to=entry.email, inviter=admin)
    return _invite_out(invite, code=code)


@router.delete("/waitlist/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_from_waitlist(
    entry_id: str,
    _: User = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> None:
    entry = await session.get(WaitlistEntry, entry_id)
    if entry is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="waitlist entry not found"
        )
    await session.delete(entry)
    await session.commit()


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
