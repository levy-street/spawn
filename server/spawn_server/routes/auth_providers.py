"""External OAuth provider sign-in for human Spawn accounts."""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from urllib.parse import urlencode, urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import RedirectResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, schemas
from ..config import Settings, get_settings
from ..db import get_session
from ..models import AuthIdentity, AuthProviderState, User

ProviderId = Literal["google", "microsoft", "github"]

router = APIRouter(prefix="/api/auth", tags=["auth"])


@dataclass(frozen=True)
class AuthProviderDefinition:
    id: ProviderId
    name: str
    authorization_endpoint: str
    token_endpoint: str
    scopes: tuple[str, ...]
    userinfo_endpoint: str | None = None


@dataclass(frozen=True)
class AuthProviderConfig:
    definition: AuthProviderDefinition
    client_id: str
    client_secret: str


@dataclass(frozen=True)
class ProviderProfile:
    provider: ProviderId
    provider_user_id: str
    email: str
    email_verified: bool


PROVIDER_DEFINITIONS: dict[ProviderId, AuthProviderDefinition] = {
    "google": AuthProviderDefinition(
        id="google",
        name="Google",
        authorization_endpoint="https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint="https://oauth2.googleapis.com/token",
        userinfo_endpoint="https://openidconnect.googleapis.com/v1/userinfo",
        scopes=("openid", "email", "profile"),
    ),
    "microsoft": AuthProviderDefinition(
        id="microsoft",
        name="Microsoft",
        authorization_endpoint="https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        token_endpoint="https://login.microsoftonline.com/common/oauth2/v2.0/token",
        userinfo_endpoint="https://graph.microsoft.com/oidc/userinfo",
        scopes=("openid", "email", "profile"),
    ),
    "github": AuthProviderDefinition(
        id="github",
        name="GitHub",
        authorization_endpoint="https://github.com/login/oauth/authorize",
        token_endpoint="https://github.com/login/oauth/access_token",
        scopes=("read:user", "user:email"),
    ),
}


def _now() -> datetime:
    return datetime.now(UTC)


def _aware(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value


def _hash_state(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _public_url(path: str = "") -> str:
    return f"{get_settings().public_url.rstrip('/')}{path}"


def _provider_credentials(
    provider: ProviderId,
    settings: Settings,
) -> tuple[str | None, str | None]:
    if provider == "google":
        return settings.google_client_id, settings.google_client_secret
    if provider == "microsoft":
        return settings.microsoft_client_id, settings.microsoft_client_secret
    return settings.github_client_id, settings.github_client_secret


def enabled_provider_configs(settings: Settings | None = None) -> list[AuthProviderConfig]:
    settings = settings or get_settings()
    configs: list[AuthProviderConfig] = []
    for provider_id, definition in PROVIDER_DEFINITIONS.items():
        client_id, client_secret = _provider_credentials(provider_id, settings)
        if client_id and client_secret:
            configs.append(
                AuthProviderConfig(
                    definition=definition,
                    client_id=client_id,
                    client_secret=client_secret,
                )
            )
    return configs


def enabled_provider_summaries(settings: Settings | None = None) -> list[schemas.AuthProviderOut]:
    return [
        schemas.AuthProviderOut(id=config.definition.id, name=config.definition.name)
        for config in enabled_provider_configs(settings)
    ]


def _enabled_config(provider: str) -> AuthProviderConfig:
    if provider not in PROVIDER_DEFINITIONS:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="unknown auth provider")
    for config in enabled_provider_configs():
        if config.definition.id == provider:
            return config
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="auth provider is not enabled")


def _clean_return_to(return_to: str | None) -> str:
    if not return_to:
        return "/"
    parsed = urlparse(return_to)
    if parsed.scheme or parsed.netloc or not return_to.startswith("/") or return_to.startswith("//"):
        return "/"
    if len(return_to) > 2048:
        return "/"
    return return_to


def _provider_redirect_uri(provider: ProviderId) -> str:
    return _public_url(f"/api/auth/oauth/{provider}/callback")


def _email_from_body(body: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = body.get(key)
        if isinstance(value, str) and "@" in value:
            return auth.normalize_email(value)
    return ""


def _str_claim(body: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = body.get(key)
        if value is not None:
            text = str(value).strip()
            if text:
                return text
    return ""


class ProviderAuthError(Exception):
    def __init__(self, message: str, status_code: int = status.HTTP_400_BAD_REQUEST) -> None:
        super().__init__(message)
        self.status_code = status_code


async def _exchange_provider_code(
    *,
    config: AuthProviderConfig,
    code: str,
) -> ProviderProfile:
    async with httpx.AsyncClient(timeout=10) as client:
        token_response = await client.post(
            config.definition.token_endpoint,
            data={
                "grant_type": "authorization_code",
                "client_id": config.client_id,
                "client_secret": config.client_secret,
                "code": code,
                "redirect_uri": _provider_redirect_uri(config.definition.id),
            },
            headers={"Accept": "application/json"},
        )
        if token_response.status_code >= 400:
            raise ProviderAuthError(
                f"{config.definition.name} rejected the authorization code",
                status.HTTP_502_BAD_GATEWAY,
            )
        token_body = token_response.json()
        access_token = token_body.get("access_token")
        if not isinstance(access_token, str) or not access_token:
            raise ProviderAuthError(
                f"{config.definition.name} did not return an access token",
                status.HTTP_502_BAD_GATEWAY,
            )
        if config.definition.id == "github":
            return await _github_profile(client, access_token)
        return await _oidc_profile(client, config.definition, access_token)


async def _oidc_profile(
    client: httpx.AsyncClient,
    definition: AuthProviderDefinition,
    access_token: str,
) -> ProviderProfile:
    if definition.userinfo_endpoint is None:
        raise ProviderAuthError("provider is missing userinfo configuration")
    response = await client.get(
        definition.userinfo_endpoint,
        headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
    )
    if response.status_code >= 400:
        raise ProviderAuthError(
            f"{definition.name} user info lookup failed",
            status.HTTP_502_BAD_GATEWAY,
        )
    body = response.json()
    provider_user_id = _str_claim(body, "sub", "oid", "id")
    if not provider_user_id:
        raise ProviderAuthError(f"{definition.name} did not return an account id")

    if definition.id == "microsoft":
        email = _email_from_body(body, "email", "preferred_username", "upn")
        email_verified = bool(email)
    else:
        email = _email_from_body(body, "email")
        email_verified = body.get("email_verified") is True or body.get("email_verified") == "true"

    if not email or not email_verified:
        raise ProviderAuthError(f"{definition.name} did not return a verified email")
    return ProviderProfile(
        provider=definition.id,
        provider_user_id=provider_user_id,
        email=email,
        email_verified=True,
    )


async def _github_profile(client: httpx.AsyncClient, access_token: str) -> ProviderProfile:
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    user_response = await client.get("https://api.github.com/user", headers=headers)
    if user_response.status_code >= 400:
        raise ProviderAuthError("GitHub user lookup failed", status.HTTP_502_BAD_GATEWAY)
    user_body = user_response.json()
    provider_user_id = _str_claim(user_body, "id")
    if not provider_user_id:
        raise ProviderAuthError("GitHub did not return an account id")

    emails_response = await client.get("https://api.github.com/user/emails", headers=headers)
    if emails_response.status_code >= 400:
        raise ProviderAuthError("GitHub email lookup failed", status.HTTP_502_BAD_GATEWAY)
    emails = emails_response.json()
    if not isinstance(emails, list):
        raise ProviderAuthError("GitHub returned an invalid email response")
    verified = [
        row
        for row in emails
        if isinstance(row, dict)
        and row.get("verified") is True
        and isinstance(row.get("email"), str)
        and "@" in row["email"]
    ]
    primary = next((row for row in verified if row.get("primary") is True), None)
    selected = primary or (verified[0] if verified else None)
    if selected is None:
        raise ProviderAuthError("GitHub did not return a verified email")
    return ProviderProfile(
        provider="github",
        provider_user_id=provider_user_id,
        email=auth.normalize_email(selected["email"]),
        email_verified=True,
    )


async def _consume_state(
    *,
    session: AsyncSession,
    provider: ProviderId,
    state: str,
) -> AuthProviderState:
    row = (
        await session.execute(
            select(AuthProviderState).where(AuthProviderState.state_hash == _hash_state(state))
        )
    ).scalar_one_or_none()
    if row is None or row.provider != provider:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid auth state")
    if row.used_at is not None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="auth state was used")
    if _aware(row.expires_at) <= _now():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="auth state expired")
    row.used_at = _now()
    await session.commit()
    return row


async def _user_for_profile(
    *,
    session: AsyncSession,
    profile: ProviderProfile,
    linked_user_id: str | None,
) -> User:
    now = _now()
    identity = (
        await session.execute(
            select(AuthIdentity).where(
                AuthIdentity.provider == profile.provider,
                AuthIdentity.provider_user_id == profile.provider_user_id,
            )
        )
    ).scalar_one_or_none()
    if identity is not None:
        identity.email = profile.email
        identity.email_verified = profile.email_verified
        identity.last_login_at = now
        await session.commit()
        user = await session.get(User, identity.user_id)
        if user is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="user gone")
        return user

    user: User | None = None
    if linked_user_id is not None:
        user = await session.get(User, linked_user_id)
        if user is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="user gone")
    if user is None:
        user = (
            await session.execute(
                select(User).where(func.lower(User.email) == profile.email.lower())
            )
        ).scalar_one_or_none()
    if user is None:
        user = User(email=profile.email, password_hash=auth.hash_random_password(), created_at=now)
        session.add(user)
        await session.flush()

    session.add(
        AuthIdentity(
            user_id=user.id,
            provider=profile.provider,
            provider_user_id=profile.provider_user_id,
            email=profile.email,
            email_verified=profile.email_verified,
            created_at=now,
            last_login_at=now,
        )
    )
    await session.commit()
    await session.refresh(user)
    return user


@router.get("/providers", response_model=schemas.AuthProviderList)
async def auth_providers() -> schemas.AuthProviderList:
    return schemas.AuthProviderList(providers=enabled_provider_summaries())


@router.get("/oauth/{provider}/start")
async def provider_start(
    provider: ProviderId,
    return_to: str | None = Query(default="/"),
    session: AsyncSession = Depends(get_session),
    user: User | None = Depends(auth.current_user_optional),
) -> RedirectResponse:
    config = _enabled_config(provider)
    state = secrets.token_urlsafe(32)
    settings = get_settings()
    session.add(
        AuthProviderState(
            state_hash=_hash_state(state),
            provider=config.definition.id,
            return_to=_clean_return_to(return_to),
            user_id=user.id if user else None,
            expires_at=_now() + timedelta(minutes=settings.oauth_provider_state_ttl_minutes),
            created_at=_now(),
        )
    )
    await session.commit()
    params = {
        "client_id": config.client_id,
        "redirect_uri": _provider_redirect_uri(config.definition.id),
        "response_type": "code",
        "scope": " ".join(config.definition.scopes),
        "state": state,
    }
    if config.definition.id in {"google", "microsoft"}:
        params["prompt"] = "select_account"
    return RedirectResponse(
        f"{config.definition.authorization_endpoint}?{urlencode(params)}",
        status_code=status.HTTP_302_FOUND,
    )


@router.get("/oauth/{provider}/callback")
async def provider_callback(
    provider: ProviderId,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> Response:
    config = _enabled_config(provider)
    provider_error = request.query_params.get("error")
    if provider_error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{config.definition.name} sign-in failed: {provider_error}",
        )
    state = request.query_params.get("state", "")
    code = request.query_params.get("code", "")
    if not state or not code:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="state and code are required",
        )
    state_row = await _consume_state(session=session, provider=config.definition.id, state=state)
    try:
        profile = await _exchange_provider_code(config=config, code=code)
    except ProviderAuthError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e)) from e
    user = await _user_for_profile(
        session=session,
        profile=profile,
        linked_user_id=state_row.user_id,
    )
    auth.set_session_cookie(response, auth.issue_session_token(user.id, user.session_epoch))
    redirect = RedirectResponse(state_row.return_to, status_code=status.HTTP_302_FOUND)
    if "set-cookie" in response.headers:
        redirect.headers.append("set-cookie", response.headers["set-cookie"])
    return redirect
