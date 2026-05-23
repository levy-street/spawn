"""Email/password signup, login, logout, /api/me."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, schemas
from ..config import get_settings
from ..db import get_session
from ..models import User

router = APIRouter(prefix="/api", tags=["auth"])


def _set_session_cookie(response: Response, token: str) -> None:
    # HTTP-only web session. Secure should be true in prod (set behind a proxy).
    settings = get_settings()
    response.set_cookie(
        "spawn_session",
        token,
        max_age=60 * 60 * 24 * settings.jwt_refresh_ttl_days,
        httponly=True,
        samesite="lax",
        secure=False,
    )


@router.post("/auth/signup", response_model=schemas.TokenResponse)
async def signup(
    body: schemas.SignupRequest,
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> schemas.TokenResponse:
    user = User(email=body.email, password_hash=auth.hash_password(body.password))
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
    row = (await session.execute(select(User).where(User.email == body.email))).scalar_one_or_none()
    if row is None or not auth.verify_password(body.password, row.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")
    access_token = auth.issue_access_token(row.id)
    _set_session_cookie(response, auth.issue_session_token(row.id))
    return schemas.TokenResponse(
        access_token=access_token, user=schemas.UserOut.model_validate(row)
    )


@router.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(response: Response) -> None:
    response.delete_cookie("spawn_session", samesite="lax", secure=False)


@router.post("/auth/mcp-token", response_model=schemas.McpTokenResponse)
async def mcp_token(user: User = Depends(auth.current_user)) -> schemas.McpTokenResponse:
    settings = get_settings()
    return schemas.McpTokenResponse(
        access_token=auth.issue_session_token(user.id),
        expires_in=60 * 60 * 24 * settings.jwt_refresh_ttl_days,
    )


@router.get("/me", response_model=schemas.MeResponse)
async def me(user: User = Depends(auth.current_user)) -> schemas.MeResponse:
    return schemas.MeResponse(user=schemas.UserOut.model_validate(user))
