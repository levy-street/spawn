"""External OAuth provider sign-in for human Spawn accounts."""

from __future__ import annotations

import base64
import hashlib
import secrets
import string
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from urllib.parse import urlencode, urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import RedirectResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, invites, rate_limit, schemas
from ..apple_identity import (
    APPLE_AUTHORIZATION_ENDPOINT,
    APPLE_TOKEN_ENDPOINT,
    AppleIdentityError,
    apple_client_secret,
    apple_is_configured,
    verify_apple_identity_token,
)
from ..config import Settings, get_settings
from ..db import get_session
from ..models import AuthIdentity, AuthProviderExchange, AuthProviderState, User

ProviderId = Literal["google", "microsoft", "github", "apple"]

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
    "apple": AuthProviderDefinition(
        id="apple",
        name="Apple",
        authorization_endpoint=APPLE_AUTHORIZATION_ENDPOINT,
        token_endpoint=APPLE_TOKEN_ENDPOINT,
        # Email only. Apple will also hand over the account holder's name, but
        # only on a first authorization and never again, and there is nowhere to
        # put it — `User` carries an email and nothing else. Asking for data
        # that is immediately discarded is a consent prompt charging the user
        # for nothing.
        #
        # Asking for any scope at all obliges Apple to POST the callback back as
        # a form, which is why there is a POST route below as well as a GET.
        scopes=("email",),
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


_PKCE_ALPHABET = set(string.ascii_letters + string.digits + "-._~")


def _clean_code_challenge(challenge: str | None, method: str | None) -> str | None:
    """Validate a PKCE challenge from `/oauth/{provider}/start`.

    Only S256 is accepted. `plain` would make the challenge and the verifier
    the same string, so anyone who saw the redirect could redeem the code — the
    thing this exists to prevent.
    """
    if not challenge:
        return None
    if (method or "S256") != "S256":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="only the S256 code challenge method is supported",
        )
    if not (43 <= len(challenge) <= 128) or set(challenge) - _PKCE_ALPHABET:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="code_challenge is malformed",
        )
    return challenge


def _pkce_matches(challenge: str, verifier: str) -> bool:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    expected = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return secrets.compare_digest(expected, challenge)


def _public_url(path: str = "") -> str:
    return f"{get_settings().public_url.rstrip('/')}{path}"


def _web_url(path: str = "") -> str:
    """Where a browser should be sent. Falls back to the API origin."""
    settings = get_settings()
    base = (settings.web_url or settings.public_url).rstrip("/")
    return f"{base}{path}"


class InviteRequired(Exception):
    """A provider sign-in that would create an account on a closed deployment.

    Carried out of `_user_for_profile` as an exception rather than an HTTP
    error because the right answer depends on who is asking. An API client
    wants a 403; a browser mid-redirect wants a page that explains itself and
    offers somewhere to type the code. Returning JSON to the browser — which is
    what raising here used to do — ends the flow on a wall of `{"detail": …}`.
    """

    def __init__(self, provider: str, reason: str) -> None:
        super().__init__(reason)
        self.provider = provider
        self.reason = reason


def _provider_credentials(
    provider: ProviderId,
    settings: Settings,
) -> tuple[str | None, str | None]:
    if provider == "google":
        return settings.google_client_id, settings.google_client_secret
    if provider == "microsoft":
        return settings.microsoft_client_id, settings.microsoft_client_secret
    if provider == "apple":
        # Apple's "secret" is a JWT this server signs, so it is minted on demand
        # rather than configured; a key that cannot sign disables the provider
        # instead of failing every sign-in at the token endpoint.
        if not apple_is_configured(settings):
            return None, None
        try:
            return settings.apple_client_id, apple_client_secret(settings)
        except AppleIdentityError:
            return None, None
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


def _native_redirect_uri(redirect_uri: str | None) -> str | None:
    """The app's own redirect target, or None when this is an ordinary web flow.

    Matching is exact against the configured allow-list. A prefix or host rule
    would let anything that claims the scheme collect codes meant for the real
    app, which is the whole reason the code is single-use and short-lived.
    """
    if not redirect_uri:
        return None
    allowed = get_settings().oauth_native_redirect_uri_list
    if redirect_uri not in allowed:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="redirect_uri is not an allowed native redirect",
        )
    return redirect_uri


def _is_native_redirect(return_to: str) -> bool:
    return return_to in get_settings().oauth_native_redirect_uri_list


async def _issue_exchange_code(
    *, session: AsyncSession, user: User, code_challenge: str | None = None
) -> str:
    code = secrets.token_urlsafe(32)
    settings = get_settings()
    session.add(
        AuthProviderExchange(
            code_hash=_hash_state(code),
            code_challenge=code_challenge,
            user_id=user.id,
            expires_at=_now() + timedelta(seconds=settings.oauth_exchange_ttl_seconds),
            created_at=_now(),
        )
    )
    await session.commit()
    return code


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
        if config.definition.id == "apple":
            return await _apple_profile(client, token_body)
        access_token = token_body.get("access_token")
        if not isinstance(access_token, str) or not access_token:
            raise ProviderAuthError(
                f"{config.definition.name} did not return an access token",
                status.HTTP_502_BAD_GATEWAY,
            )
        if config.definition.id == "github":
            return await _github_profile(client, access_token)
        return await _oidc_profile(client, config.definition, access_token)


async def _apple_profile(
    client: httpx.AsyncClient,
    token_body: dict[str, Any],
) -> ProviderProfile:
    """Read the account out of Apple's id_token; there is no userinfo endpoint."""
    id_token = token_body.get("id_token")
    if not isinstance(id_token, str) or not id_token:
        raise ProviderAuthError(
            "Apple did not return an identity token",
            status.HTTP_502_BAD_GATEWAY,
        )
    return await apple_profile_from_identity_token(id_token, client=client)


async def apple_profile_from_identity_token(
    id_token: str,
    *,
    client: httpx.AsyncClient | None = None,
) -> ProviderProfile:
    """Verify an Apple id_token — from either the web callback or the app.

    The email is deliberately allowed to be missing. Apple releases it only on
    the first authorization for a given Apple ID; every sign-in after that
    carries `sub` alone. Demanding an email here is the standard way this
    provider ends up working exactly once per user, so the absent case is
    resolved later against the identity already on file.
    """
    try:
        identity = await verify_apple_identity_token(
            id_token,
            settings=get_settings(),
            client=client,
        )
    except AppleIdentityError as e:
        raise ProviderAuthError(str(e), status.HTTP_401_UNAUTHORIZED) from e

    email = auth.normalize_email(identity.email) if identity.email else ""
    return ProviderProfile(
        provider="apple",
        provider_user_id=identity.subject,
        email=email,
        email_verified=bool(email) and identity.email_verified,
    )


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
    invite_code_hash: str | None = None,
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
        # An empty email means the provider simply did not resend it (Apple after
        # the first authorization), not that the account lost one — so keep what
        # is already on file rather than blanking it.
        if profile.email:
            identity.email = profile.email
            identity.email_verified = profile.email_verified
        identity.last_login_at = now
        user = await session.get(User, identity.user_id)
        if user is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="user gone")
        # Reads the stored flag rather than this sign-in's, because Apple sends
        # the email only on a first authorization: a returning user arrives with
        # nothing to assert, and the claim on file is the one that was proved.
        # This also catches accounts linked before provider sign-ins were
        # trusted, which would otherwise stay stuck behind the gate forever.
        if identity.email_verified and user.email_verified_at is None:
            user.email_verified_at = now
        await session.commit()
        return user

    # Reaching here means there is no identity on file, so this is a first
    # sign-in and an email is the only thing that can name the account.
    if not profile.email:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "this provider account is not linked yet and the provider sent no email; "
                "sign in on the web once, or revoke the app under your provider account "
                "and try again"
            ),
        )

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
        if user is not None and profile.email_verified and user.email_verified_at is None:
            # Adopting an account that exists but was never verified, on the
            # word of a provider that *has* verified this address.
            #
            # Whoever created that row proved nothing, so it cannot be assumed
            # to be the same person now signing in — planting an unverified
            # account under someone else's address and waiting for them to
            # arrive by provider is the standard pre-hijacking move. Retiring
            # the password and bumping the epoch is what stops the plant from
            # being worth anything: the address's real owner keeps the account,
            # and anyone else is left holding a credential that no longer opens
            # it. A local password set legitimately but never verified is lost
            # here too, and recovering it is a password reset away.
            user.password_hash = auth.hash_random_password()
            user.session_epoch += 1
    invite = None
    if user is None:
        # Creating an account, which is the moment the deployment's admission
        # rule applies. Signing in to an account that already exists, or
        # linking a provider to one, is not a signup and is never gated.
        if not await invites.signup_is_open(session):
            if invite_code_hash is None:
                raise InviteRequired(profile.provider, "SPAWN D is invite only right now")
            try:
                invite = await invites.redeem_invite_hash(session, invite_code_hash)
            except ValueError as cause:
                # One message for every failure mode, matching signup: a
                # stranger probing codes learns nothing from the difference.
                raise InviteRequired(
                    profile.provider, "this invite is not valid"
                ) from cause

        user = User(email=profile.email, password_hash=auth.hash_random_password(), created_at=now)
        session.add(user)
        await session.flush()
        if invite is not None:
            invite.used_at = now
            invite.used_by_user_id = user.id

    if profile.email_verified and user.email_verified_at is None:
        # The provider has already proved control of this address, which is a
        # stronger claim than a link clicked in an inbox — and on a relayed
        # Apple address the verification mail cannot arrive at all, so leaving
        # the gate up would strand that account with nothing to diagnose.
        user.email_verified_at = now

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


@router.get("/oauth/{provider}/start")
async def provider_start(
    provider: ProviderId,
    return_to: str | None = Query(default="/"),
    redirect_uri: str | None = Query(default=None),
    invite: str | None = Query(default=None, max_length=256),
    code_challenge: str | None = Query(default=None, max_length=128),
    code_challenge_method: str | None = Query(default=None, max_length=16),
    session: AsyncSession = Depends(get_session),
    user: User | None = Depends(auth.current_user_optional),
) -> RedirectResponse:
    config = _enabled_config(provider)
    state = secrets.token_urlsafe(32)
    settings = get_settings()
    native = _native_redirect_uri(redirect_uri)
    challenge = _clean_code_challenge(code_challenge, code_challenge_method)
    session.add(
        AuthProviderState(
            state_hash=_hash_state(state),
            provider=config.definition.id,
            return_to=native or _clean_return_to(return_to),
            # Not validated here on purpose. Checking it now would turn this
            # endpoint into an oracle for probing codes, and the redemption at
            # the callback is the only check that has to hold.
            invite_code_hash=invites.hash_code(invite) if invite else None,
            # Only a native flow redeems a code later, so only it needs PKCE;
            # the browser leg already ends on a cookie for the same origin.
            code_challenge=challenge if native else None,
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
    if config.definition.id == "apple":
        # Apple requires form_post the moment any scope is requested, and then
        # delivers the result as a POST body rather than query parameters.
        params["response_mode"] = "form_post"
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
    return await _complete_callback(
        provider=provider,
        values=dict(request.query_params),
        response=response,
        session=session,
    )


@router.post("/oauth/{provider}/callback")
async def provider_callback_post(
    provider: ProviderId,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> Response:
    """Apple's half of the callback: response_mode=form_post arrives as a POST.

    No CSRF token guards this route and none can — the request is a cross-site
    form submission from Apple, by design. The `state` value consumed below is
    what ties it to a flow this server started, and it is single-use.
    """
    form = await request.form()
    values = {key: str(value) for key, value in form.items() if isinstance(value, str)}
    return await _complete_callback(
        provider=provider,
        values=values,
        response=response,
        session=session,
    )


async def _complete_callback(
    *,
    provider: ProviderId,
    values: dict[str, str],
    response: Response,
    session: AsyncSession,
) -> Response:
    config = _enabled_config(provider)
    provider_error = values.get("error")
    if provider_error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{config.definition.name} sign-in failed: {provider_error}",
        )
    state = values.get("state", "")
    code = values.get("code", "")
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
    native = _is_native_redirect(state_row.return_to)
    try:
        user = await _user_for_profile(
            session=session,
            profile=profile,
            linked_user_id=state_row.user_id,
            invite_code_hash=state_row.invite_code_hash,
        )
    except InviteRequired as e:
        # Hand the flow back to a surface that can ask for a code, rather than
        # ending it on a JSON body. The app gets the same signal on its own
        # scheme so it can show its invite field instead of a browser error.
        target = (
            f"{state_row.return_to}?{urlencode({'error': 'invite_required'})}"
            if native
            else _web_url(f"/signup?{urlencode({'invite_required': '1', 'provider': e.provider})}")
        )
        return RedirectResponse(target, status_code=status.HTTP_302_FOUND)
    if native:
        # The app cannot read the cookie this would otherwise set: its sign-in
        # ran in a system web view with its own jar. Hand back a single-use code
        # instead and let it trade that for a token over the API, and set no
        # cookie at all — nothing here is a browser session.
        code = await _issue_exchange_code(
            session=session, user=user, code_challenge=state_row.code_challenge
        )
        return RedirectResponse(
            f"{state_row.return_to}?{urlencode({'code': code})}",
            status_code=status.HTTP_302_FOUND,
        )
    auth.set_session_cookie(response, auth.issue_session_token(user.id, user.session_epoch))
    redirect = RedirectResponse(state_row.return_to, status_code=status.HTTP_302_FOUND)
    if "set-cookie" in response.headers:
        redirect.headers.append("set-cookie", response.headers["set-cookie"])
    return redirect


@router.post(
    "/oauth/exchange",
    response_model=schemas.TokenResponse,
    dependencies=[Depends(rate_limit.limiter(rate_limit.LOGIN))],
)
async def provider_exchange(
    body: schemas.OAuthExchangeRequest,
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> schemas.TokenResponse:
    """Trade a native callback's one-time code for the same token a login returns."""
    row = (
        await session.execute(
            select(AuthProviderExchange).where(
                AuthProviderExchange.code_hash == _hash_state(body.code)
            )
        )
    ).scalar_one_or_none()
    if row is None or row.used_at is not None or _aware(row.expires_at) <= _now():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="this sign-in code is invalid or has expired",
        )
    # Bind the redemption to the client that started the flow. Without this the
    # code proves only *which account* signed in, not *who asked* — so an
    # attacker could complete OAuth with their own account and lure the code
    # onto someone else's machine, where the app would sign itself into the
    # attacker's account and possess that machine under it. Consuming the row
    # first would let a wrong guess burn the user's real code, so check before
    # marking it used, and mark it used on a failed verifier too so a bad code
    # is spent either way.
    if row.code_challenge is not None:
        verifier = body.code_verifier or ""
        if not verifier or not _pkce_matches(row.code_challenge, verifier):
            row.used_at = _now()
            await session.commit()
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="this sign-in code was not issued to this app",
            )
    row.used_at = _now()
    await session.commit()

    user = await session.get(User, row.user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="user gone")
    auth.set_session_cookie(response, auth.issue_session_token(user.id, user.session_epoch))
    return schemas.TokenResponse(
        access_token=auth.issue_access_token(user.id, user.session_epoch),
        user=schemas.UserOut.model_validate(user),
    )


@router.post(
    "/oauth/apple/native",
    response_model=schemas.TokenResponse,
    dependencies=[Depends(rate_limit.limiter(rate_limit.LOGIN))],
)
async def apple_native_sign_in(
    body: schemas.AppleNativeSignInRequest,
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> schemas.TokenResponse:
    """Sign in from the iOS Sign in with Apple sheet.

    There is no redirect, no state and no one-time code here, because there was
    no browser: the sheet runs inside the app and hands it a signed identity
    token directly. That token is the entire proof, so it is verified against
    Apple's published keys — signature, issuer, expiry and audience — before it
    is allowed to name an account.
    """
    _enabled_config("apple")
    try:
        profile = await apple_profile_from_identity_token(body.identity_token)
    except ProviderAuthError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e)) from e

    # The native Apple sheet has no start URL to carry an invite, so the app
    # sends it with the identity token instead.
    try:
        user = await _user_for_profile(
            session=session,
            profile=profile,
            linked_user_id=None,
            invite_code_hash=invites.hash_code(body.invite) if body.invite else None,
        )
    except InviteRequired as e:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(e)) from e
    auth.set_session_cookie(response, auth.issue_session_token(user.id, user.session_epoch))
    return schemas.TokenResponse(
        access_token=auth.issue_access_token(user.id, user.session_epoch),
        user=schemas.UserOut.model_validate(user),
    )
