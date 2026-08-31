"""Password reset and email verification.

Both flows share one shape: mint a high-entropy secret, store only its hash,
mail the plaintext, and accept it exactly once before it expires.

Neither flow reveals whether an address has an account. Request endpoints
always answer the same way, so the response cannot be used to enumerate
users — a property that survives only if every branch, including "no such
user" and "mail send failed", returns identically.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, email_templates, rate_limit, schemas
from ..config import get_settings
from ..db import get_session
from ..mail import send_email
from ..models import EmailToken, User

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])

PURPOSE_PASSWORD_RESET = "password_reset"
PURPOSE_EMAIL_VERIFY = "email_verify"

RESET_TTL = timedelta(hours=1)
VERIFY_TTL = timedelta(days=2)


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _web_base() -> str:
    settings = get_settings()
    return (settings.web_url or settings.public_url).rstrip("/")


async def issue_email_token(session: AsyncSession, user: User, purpose: str, ttl: timedelta) -> str:
    """Mint a single-use token, superseding any outstanding one of its kind."""

    # Only the newest link should work: leaving older ones live widens the
    # window an intercepted email stays useful.
    await session.execute(
        update(EmailToken)
        .where(
            EmailToken.user_id == user.id,
            EmailToken.purpose == purpose,
            EmailToken.used_at.is_(None),
        )
        .values(used_at=datetime.now(UTC))
    )
    token = secrets.token_urlsafe(32)
    session.add(
        EmailToken(
            user_id=user.id,
            purpose=purpose,
            token_hash=_hash_token(token),
            expires_at=datetime.now(UTC) + ttl,
        )
    )
    return token


async def _consume_token(session: AsyncSession, token: str, purpose: str) -> User:
    row = (
        await session.execute(
            select(EmailToken).where(
                EmailToken.token_hash == _hash_token(token),
                EmailToken.purpose == purpose,
            )
        )
    ).scalar_one_or_none()
    now = datetime.now(UTC)
    if row is None or row.used_at is not None:
        raise HTTPException(status_code=400, detail="this link is no longer valid")
    expires_at = row.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=UTC)
    if expires_at <= now:
        raise HTTPException(status_code=400, detail="this link has expired")
    user = await session.get(User, row.user_id)
    if user is None:
        raise HTTPException(status_code=400, detail="this link is no longer valid")
    row.used_at = now
    return user


async def send_verification_email(session: AsyncSession, user: User) -> None:
    """Best-effort verification mail; never fails the caller's request."""

    token = await issue_email_token(session, user, PURPOSE_EMAIL_VERIFY, VERIFY_TTL)
    # The delivery audit deliberately uses its own transaction. Make the token
    # durable before entering the mailer so SQLite does not leave this session
    # holding the write lock while the audit session waits for that same lock.
    # PostgreSQL benefits from the same ordering: never advertise a token before
    # the database state that accepts it has committed.
    await session.commit()
    link = f"{_web_base()}/verify-email?token={token}"
    rendered = email_templates.verify_email(link=link, site_url=_web_base())
    try:
        await send_email(
            to=user.email,
            subject=rendered.subject,
            body=rendered.text,
            html_body=rendered.html,
            kind="email_verify",
        )
    except Exception as exc:
        # Signup must still succeed: the user can request another mail, and
        # failing here would leave an account created but unreported.
        log.warning("could not send verification email to %s: %s", user.email, exc)


@router.post(
    "/password-reset/request",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(rate_limit.limiter(rate_limit.PASSWORD_RESET))],
)
async def request_password_reset(
    body: schemas.PasswordResetRequest,
    session: AsyncSession = Depends(get_session),
) -> None:
    email = auth.normalize_email(body.email)
    user = (
        await session.execute(select(User).where(func.lower(User.email) == email))
    ).scalar_one_or_none()

    if user is not None:
        token = await issue_email_token(session, user, PURPOSE_PASSWORD_RESET, RESET_TTL)
        await session.commit()
        link = f"{_web_base()}/reset-password?token={token}"
        rendered = email_templates.password_reset(link=link, site_url=_web_base())
        try:
            await send_email(
                to=user.email,
                subject=rendered.subject,
                body=rendered.text,
                html_body=rendered.html,
                kind="password_reset",
            )
        except Exception as exc:
            # Swallowed on purpose: a send failure must not turn into a signal
            # that distinguishes real addresses from invented ones.
            log.warning("could not send password reset email: %s", exc)

    return None


@router.post("/password-reset/confirm", response_model=schemas.TokenResponse)
async def confirm_password_reset(
    body: schemas.PasswordResetConfirm,
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> schemas.TokenResponse:
    user = await _consume_token(session, body.token, PURPOSE_PASSWORD_RESET)
    user.password_hash = auth.hash_password(body.new_password)
    # Evict every existing session. A reset is what someone does when they
    # believe an attacker has access; leaving the attacker's session alive
    # would make the whole ceremony theatre.
    user.session_epoch = int(user.session_epoch or 0) + 1
    # Reaching the mailbox proves control of the address.
    if user.email_verified_at is None:
        user.email_verified_at = datetime.now(UTC)
    await session.commit()
    await session.refresh(user)

    access_token = auth.issue_access_token(user.id, user.session_epoch)
    auth.set_session_cookie(response, auth.issue_session_token(user.id, user.session_epoch))
    return schemas.TokenResponse(
        access_token=access_token, user=schemas.UserOut.model_validate(user)
    )


@router.post(
    "/verify-email/request",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(rate_limit.limiter(rate_limit.VERIFY_RESEND))],
)
async def request_email_verification(
    request: Request,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> None:
    if user.email_verified_at is not None:
        return None
    await send_verification_email(session, user)
    await session.commit()
    return None


@router.post("/verify-email/confirm", response_model=schemas.MeResponse)
async def confirm_email_verification(
    body: schemas.EmailVerifyConfirm,
    session: AsyncSession = Depends(get_session),
) -> schemas.MeResponse:
    user = await _consume_token(session, body.token, PURPOSE_EMAIL_VERIFY)
    if user.email_verified_at is None:
        user.email_verified_at = datetime.now(UTC)
    await session.commit()
    await session.refresh(user)
    return schemas.MeResponse(user=schemas.UserOut.model_validate(user))
