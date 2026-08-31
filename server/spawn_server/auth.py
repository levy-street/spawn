"""Password hashing, JWT issuance/verification, FastAPI auth dependencies."""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import Cookie, Depends, Header, HTTPException, Query, Request, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import get_settings
from .db import get_session
from .models import Host, User

_hasher = PasswordHasher()

# Token "kind" claim — distinguishes web access tokens from daemon tokens.
KIND_ACCESS = "access"
KIND_DAEMON = "daemon"


def hash_password(plaintext: str) -> str:
    return _hasher.hash(plaintext)


def hash_random_password() -> str:
    return hash_password(secrets.token_urlsafe(32))


def email_is_bootstrap_admin(email: str) -> bool:
    """Whether SPAWN_ADMIN_EMAILS names this address.

    Only ever grants; never revokes. The database flag stays the source of
    truth so admin can also be handed out (and taken back) at runtime.
    """

    configured = get_settings().admin_emails
    wanted = {item.strip().lower() for item in configured.split(",") if item.strip()}
    return email.strip().lower() in wanted


def normalize_email(email: str) -> str:
    return email.strip().lower()


def verify_password(plaintext: str, hashed: str) -> bool:
    try:
        return _hasher.verify(hashed, plaintext)
    except VerifyMismatchError:
        return False
    except Exception:
        return False


def _now() -> datetime:
    return datetime.now(UTC)


def issue_access_token(user_id: str, session_epoch: int = 0) -> str:
    s = get_settings()
    return _issue_user_token(user_id, timedelta(minutes=s.jwt_access_ttl_minutes), session_epoch)


def issue_session_token(user_id: str, session_epoch: int = 0) -> str:
    s = get_settings()
    return _issue_user_token(user_id, timedelta(days=s.jwt_refresh_ttl_days), session_epoch)


def _issue_user_token(user_id: str, ttl: timedelta, session_epoch: int = 0) -> str:
    s = get_settings()
    now = _now()
    payload = {
        "sub": f"user:{user_id}",
        "kind": KIND_ACCESS,
        # The epoch this token was minted under. Bumping the user's epoch
        # invalidates every token that predates it -- the only way to evict a
        # stolen stateless session, and what makes a password reset mean
        # something to someone already logged in as you.
        "epoch": session_epoch,
        "iat": int(now.timestamp()),
        "exp": int((now + ttl).timestamp()),
    }
    return jwt.encode(payload, s.jwt_secret, algorithm=s.jwt_algorithm)


def issue_daemon_token(host_id: str, user_id: str) -> str:
    s = get_settings()
    payload = {
        "sub": f"host:{host_id}",
        "user_id": user_id,
        "kind": KIND_DAEMON,
        "iat": int(_now().timestamp()),
        "exp": int((_now() + timedelta(days=s.jwt_daemon_ttl_days)).timestamp()),
    }
    return jwt.encode(payload, s.jwt_secret, algorithm=s.jwt_algorithm)


def decode_token(token: str) -> dict[str, Any]:
    s = get_settings()
    try:
        return jwt.decode(token, s.jwt_secret, algorithms=[s.jwt_algorithm])
    except jwt.PyJWTError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"invalid token: {e}",
        ) from e


def set_session_cookie(response: Response, token: str) -> None:
    settings = get_settings()
    response.set_cookie(
        "spawn_session",
        token,
        max_age=60 * 60 * 24 * settings.jwt_refresh_ttl_days,
        httponly=True,
        samesite="lax",
        secure=settings.public_url.startswith("https://"),
    )


def session_cookie_header(token: str) -> str:
    """Render the canonical cookie attributes for an ASGI response hook."""
    response = Response()
    set_session_cookie(response, token)
    return response.headers["set-cookie"]


def _extract_bearer(authorization: str | None) -> str | None:
    if not authorization:
        return None
    parts = authorization.split(None, 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip()
    return None


async def current_user(
    request: Request,
    authorization: str | None = Header(default=None),
    spawn_session: str | None = Cookie(default=None),
    token_q: str | None = Query(default=None, alias="token"),
    session: AsyncSession = Depends(get_session),
) -> User:
    raw = _extract_bearer(authorization) or spawn_session or token_q
    if not raw:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="not authenticated")
    payload = decode_token(raw)
    if payload.get("kind") != KIND_ACCESS:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="wrong token kind")
    sub = payload.get("sub", "")
    if not sub.startswith("user:"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="bad subject")
    user_id = sub.split(":", 1)[1]
    user = await session.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="user gone")
    _assert_current_epoch(payload, user)
    _schedule_session_renewal(request, payload, user)
    # For the data-event response hook: who a successful mutation should be
    # fanned out to. Left only after the epoch check, so a revoked session
    # never broadcasts.
    request.state.data_event_user_id = user.id
    return user


def _assert_current_epoch(payload: dict[str, Any], user: User) -> None:
    """Refuse tokens minted before the account's current session epoch.

    Tokens issued before this claim existed carry no epoch and read as 0,
    which is the epoch every account starts at -- so they keep working until
    something (a password reset) actually bumps it, and stop the moment it
    does.
    """

    if int(payload.get("epoch", 0) or 0) != int(user.session_epoch or 0):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="session ended; sign in again",
        )


def _schedule_session_renewal(request: Request, payload: dict[str, Any], user: User) -> None:
    """Stage one sliding cookie refresh after epoch validation.

    The HTTP ASGI response hook attaches it before the response starts,
    including redirects and streaming responses. WebSockets never traverse
    that hook and keep their existing authentication path.
    """

    issued_at = payload.get("iat")
    if isinstance(issued_at, bool) or not isinstance(issued_at, (int, float)):
        return
    half_life = timedelta(days=get_settings().jwt_refresh_ttl_days) / 2
    if _now() - datetime.fromtimestamp(issued_at, UTC) <= half_life:
        return
    request.state.session_renewal_token = issue_session_token(user.id, user.session_epoch)


async def verified_user(user: User = Depends(current_user)) -> User:
    """A signed-in user who has confirmed their email address.

    Guards the step where an account first consumes operator-funded resources
    (attaching a host, and with it TURN relay), not sign-in itself: a user who
    cannot sign in cannot reach the page that resends their verification mail.

    Inert unless mail can actually be delivered. A deployment with no SMTP
    configured cannot send a verification link, so enforcing the requirement
    there would lock every new account out of the product permanently with no
    path forward — a gate nobody can pass is an outage, not a control.
    """

    from .mail import mailer_ready

    if (
        get_settings().require_email_verification
        and mailer_ready()
        and user.email_verified_at is None
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="verify your email address before pairing a host",
        )
    return user


async def current_user_optional(
    request: Request,
    authorization: str | None = Header(default=None),
    spawn_session: str | None = Cookie(default=None),
    session: AsyncSession = Depends(get_session),
) -> User | None:
    raw = _extract_bearer(authorization) or spawn_session
    if not raw:
        return None
    try:
        payload = decode_token(raw)
    except HTTPException:
        return None
    if payload.get("kind") != KIND_ACCESS:
        return None
    sub = payload.get("sub", "")
    if not sub.startswith("user:"):
        return None
    user = await session.get(User, sub.split(":", 1)[1])
    if user is None:
        return None
    # An evicted session must read as anonymous here too, not as the user.
    if int(payload.get("epoch", 0) or 0) != int(user.session_epoch or 0):
        return None
    _schedule_session_renewal(request, payload, user)
    return user


async def daemon_principal(
    authorization: str | None = Header(default=None),
    session: AsyncSession = Depends(get_session),
) -> Host:
    """Resolve the Host that a daemon's bearer token authorizes."""
    raw = _extract_bearer(authorization)
    if not raw:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="missing bearer")
    payload = decode_token(raw)
    if payload.get("kind") != KIND_DAEMON:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="not a daemon token")
    sub = payload.get("sub", "")
    if not sub.startswith("host:"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="bad subject")
    host_id = sub.split(":", 1)[1]
    host = (await session.execute(select(Host).where(Host.id == host_id))).scalar_one_or_none()
    if host is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="host gone")
    if host.owner_user_id != payload.get("user_id"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="host/user mismatch")
    return host
