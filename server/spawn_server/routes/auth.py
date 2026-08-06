"""Email/password signup, login, logout, /api/me."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, schemas
from ..config import get_settings
from ..db import get_session
from ..models import AuthIdentity, Host, HostKeyClaim, User
from ..ws.broker import get_broker

router = APIRouter(prefix="/api", tags=["auth"])


def _set_session_cookie(response: Response, token: str) -> None:
    auth.set_session_cookie(response, token)


@router.post("/auth/signup", response_model=schemas.TokenResponse)
async def signup(
    body: schemas.SignupRequest,
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> schemas.TokenResponse:
    email = auth.normalize_email(body.email)
    existing = (
        await session.execute(select(User).where(func.lower(User.email) == email))
    ).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="email already in use")
    user = User(email=email, password_hash=auth.hash_password(body.password))
    session.add(user)
    try:
        await session.commit()
    except IntegrityError as e:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="email already in use"
        ) from e
    await session.refresh(user)
    access_token = auth.issue_access_token(user.id)
    _set_session_cookie(response, auth.issue_session_token(user.id))
    return schemas.TokenResponse(
        access_token=access_token, user=schemas.UserOut.model_validate(user)
    )


@router.post("/auth/login", response_model=schemas.TokenResponse)
async def login(
    body: schemas.LoginRequest,
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> schemas.TokenResponse:
    email = auth.normalize_email(body.email)
    row = (
        await session.execute(select(User).where(func.lower(User.email) == email))
    ).scalar_one_or_none()
    if row is None or not auth.verify_password(body.password, row.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")
    access_token = auth.issue_access_token(row.id)
    _set_session_cookie(response, auth.issue_session_token(row.id))
    return schemas.TokenResponse(
        access_token=access_token, user=schemas.UserOut.model_validate(row)
    )


@router.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(response: Response) -> None:
    response.delete_cookie(
        "spawn_session",
        samesite="lax",
        secure=get_settings().public_url.startswith("https://"),
    )


@router.get("/me", response_model=schemas.MeResponse)
async def me(user: User = Depends(auth.current_user)) -> schemas.MeResponse:
    return schemas.MeResponse(user=schemas.UserOut.model_validate(user))


@router.post("/account/delete", status_code=status.HTTP_204_NO_CONTENT)
async def delete_account(
    body: schemas.AccountDeleteRequest,
    response: Response,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> None:
    """Permanently delete the signed-in account and everything it owns.

    Two-factor confirmation: the caller must retype the account email (wrong-
    account protection), and an account that was created with a password must
    present it (session theft protection). Provider-created accounts carry an
    unusable random hash no one can type, so for accounts with a linked auth
    identity the typed email alone suffices — their session came from the
    provider's own authentication.

    Host key claims are ``ondelete=RESTRICT`` precisely so that deleting a
    user can never RELEASE host identity keys as a side effect; an account
    deletion is the one deliberate act that does release them, so they are
    deleted explicitly here before the user row cascades everything else.
    Live daemon sockets for the account's hosts are closed best-effort — their
    tokens are already dead (every request re-resolves the user row).
    """

    if body.confirm_email.strip().lower() != user.email.lower():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="confirmation email does not match this account",
        )
    password_ok = body.password is not None and auth.verify_password(
        body.password, user.password_hash
    )
    if not password_ok:
        has_identity = (
            await session.execute(
                select(func.count()).select_from(AuthIdentity).where(
                    AuthIdentity.user_id == user.id
                )
            )
        ).scalar_one() > 0
        if not has_identity or body.password is not None:
            # Password accounts must present the password; a supplied-but-wrong
            # password is rejected even for provider accounts.
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="password confirmation failed",
            )

    host_ids = (
        (await session.execute(select(Host.id).where(Host.owner_user_id == user.id)))
        .scalars()
        .all()
    )
    await session.execute(delete(HostKeyClaim).where(HostKeyClaim.owner_user_id == user.id))
    await session.execute(delete(User).where(User.id == user.id))
    await session.commit()

    for host_id in host_ids:
        try:
            daemon = get_broker().get_daemon_for_host(host_id)
            if daemon is not None:
                await daemon.close()
        except Exception:
            pass

    response.delete_cookie(
        "spawn_session",
        samesite="lax",
        secure=get_settings().public_url.startswith("https://"),
    )
