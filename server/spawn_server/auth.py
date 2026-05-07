"""Password hashing, JWT issuance/verification, FastAPI auth dependencies."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import Cookie, Depends, Header, HTTPException, Query, status
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


def verify_password(plaintext: str, hashed: str) -> bool:
    try:
        return _hasher.verify(hashed, plaintext)
    except VerifyMismatchError:
        return False
    except Exception:
        return False


def _now() -> datetime:
    return datetime.now(UTC)


def issue_access_token(user_id: str) -> str:
    s = get_settings()
    return _issue_user_token(user_id, timedelta(minutes=s.jwt_access_ttl_minutes))


def issue_session_token(user_id: str) -> str:
    s = get_settings()
    return _issue_user_token(user_id, timedelta(days=s.jwt_refresh_ttl_days))


def _issue_user_token(user_id: str, ttl: timedelta) -> str:
    s = get_settings()
    now = _now()
    payload = {
        "sub": f"user:{user_id}",
        "kind": KIND_ACCESS,
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


def _extract_bearer(authorization: str | None) -> str | None:
    if not authorization:
        return None
    parts = authorization.split(None, 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip()
    return None


async def current_user(
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
    return user


async def current_user_optional(
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
    return await session.get(User, sub.split(":", 1)[1])


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
