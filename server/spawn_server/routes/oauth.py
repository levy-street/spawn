"""OAuth 2.1 endpoints used by ChatGPT Apps and other remote MCP clients."""

from __future__ import annotations

import base64
import hashlib
import html
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, schemas
from ..config import get_settings
from ..db import get_session
from ..models import OAuthAuthorizationCode, OAuthClient, OAuthRefreshToken, User
from .auth_providers import enabled_provider_summaries

router = APIRouter(tags=["oauth"])

SUPPORTED_SCOPES = {"spawn"}
SUPPORTED_GRANT_TYPES = {"authorization_code", "refresh_token"}
SUPPORTED_RESPONSE_TYPES = {"code"}


def _now() -> datetime:
    return datetime.now(UTC)


def _aware(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value


def _hash_secret(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _new_secret() -> str:
    return secrets.token_urlsafe(32)


def _client_id() -> str:
    return f"spawn_{secrets.token_urlsafe(24)}"


def _public_url(path: str = "") -> str:
    return f"{get_settings().public_url.rstrip('/')}{path}"


def _form_str(form: Any, key: str) -> str:
    value = form.get(key)
    return value if isinstance(value, str) else ""


def _normalize_scope(scope: str | None) -> str:
    requested = set((scope or "spawn").split())
    if not requested:
        requested = {"spawn"}
    unknown = requested - SUPPORTED_SCOPES
    if unknown:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"unsupported scope: {sorted(unknown)[0]}",
        )
    return " ".join(sorted(requested))


def _valid_redirect_uri(uri: str) -> bool:
    parsed = urlparse(uri)
    if parsed.scheme == "https" and parsed.netloc:
        return True
    if parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}:
        return True
    return False


def _redirect_with_params(uri: str, params: dict[str, str]) -> RedirectResponse:
    parsed = urlparse(uri)
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query.update(params)
    target = urlunparse(parsed._replace(query=urlencode(query)))
    return RedirectResponse(target, status_code=status.HTTP_302_FOUND)


def _oauth_json_error(
    error: str,
    description: str,
    *,
    status_code: int = status.HTTP_400_BAD_REQUEST,
) -> JSONResponse:
    return JSONResponse(
        {"error": error, "error_description": description},
        status_code=status_code,
    )


def _authorization_server_metadata() -> dict[str, Any]:
    issuer = _public_url()
    return {
        "issuer": issuer,
        "authorization_endpoint": _public_url("/api/oauth/authorize"),
        "token_endpoint": _public_url("/api/oauth/token"),
        "registration_endpoint": _public_url("/api/oauth/register"),
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
        "scopes_supported": sorted(SUPPORTED_SCOPES),
    }


@router.get("/.well-known/oauth-authorization-server")
async def oauth_authorization_server_metadata() -> dict[str, Any]:
    return _authorization_server_metadata()


@router.get("/.well-known/openid-configuration")
async def openid_configuration_metadata() -> dict[str, Any]:
    # Some clients probe OIDC discovery before OAuth AS metadata. We are an OAuth
    # authorization server, not an OIDC identity provider, so this intentionally
    # exposes only the OAuth metadata fields we support.
    return _authorization_server_metadata()


@router.post(
    "/api/oauth/register",
    response_model=schemas.OAuthClientRegistrationResponse,
    status_code=status.HTTP_201_CREATED,
)
async def register_oauth_client(
    body: schemas.OAuthClientRegistration,
    session: AsyncSession = Depends(get_session),
) -> schemas.OAuthClientRegistrationResponse:
    for redirect_uri in body.redirect_uris:
        if not _valid_redirect_uri(redirect_uri):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"unsupported redirect_uri: {redirect_uri}",
            )
    grant_types = body.grant_types or ["authorization_code", "refresh_token"]
    response_types = body.response_types or ["code"]
    if not set(grant_types).issubset(SUPPORTED_GRANT_TYPES):
        raise HTTPException(status_code=400, detail="unsupported grant type")
    if "authorization_code" not in grant_types:
        raise HTTPException(status_code=400, detail="authorization_code grant is required")
    if not set(response_types).issubset(SUPPORTED_RESPONSE_TYPES):
        raise HTTPException(status_code=400, detail="unsupported response type")
    if body.token_endpoint_auth_method != "none":
        raise HTTPException(status_code=400, detail="only public OAuth clients are supported")
    scope = _normalize_scope(body.scope)

    client = OAuthClient(
        client_id=_client_id(),
        client_name=body.client_name.strip() or "Spawn MCP client",
        redirect_uris=body.redirect_uris,
        scope=scope,
        token_endpoint_auth_method="none",
        grant_types=grant_types,
        response_types=response_types,
        created_at=_now(),
    )
    session.add(client)
    await session.commit()
    return schemas.OAuthClientRegistrationResponse(
        client_id=client.client_id,
        client_id_issued_at=int(_aware(client.created_at).timestamp()),
        client_name=client.client_name,
        redirect_uris=client.redirect_uris,
        token_endpoint_auth_method=client.token_endpoint_auth_method,
        grant_types=client.grant_types,
        response_types=client.response_types,
        scope=client.scope,
    )


async def _load_valid_authorization_request(
    params: dict[str, str],
    session: AsyncSession,
) -> tuple[OAuthClient, str, str, str, str, str | None]:
    client_id = params.get("client_id", "")
    redirect_uri = params.get("redirect_uri", "")
    state = params.get("state", "")
    if params.get("response_type") != "code":
        raise HTTPException(status_code=400, detail="response_type must be code")
    client = await session.get(OAuthClient, client_id)
    if client is None:
        raise HTTPException(status_code=400, detail="unknown client_id")
    if not redirect_uri or redirect_uri not in client.redirect_uris:
        raise HTTPException(status_code=400, detail="redirect_uri is not registered")
    try:
        scope = _normalize_scope(params.get("scope") or client.scope)
    except HTTPException as e:
        return_error = str(e.detail)
        return _raise_redirect_error(redirect_uri, state, "invalid_scope", return_error)
    if params.get("code_challenge_method") != "S256":
        return _raise_redirect_error(
            redirect_uri,
            state,
            "invalid_request",
            "code_challenge_method must be S256",
        )
    code_challenge = params.get("code_challenge", "")
    if not code_challenge:
        return _raise_redirect_error(
            redirect_uri,
            state,
            "invalid_request",
            "code_challenge is required",
        )
    return client, redirect_uri, scope, state, code_challenge, params.get("resource")


def _raise_redirect_error(
    redirect_uri: str,
    state: str,
    error: str,
    description: str,
) -> Any:
    params = {"error": error, "error_description": description}
    if state:
        params["state"] = state
    raise _RedirectException(_redirect_with_params(redirect_uri, params))


class _RedirectException(Exception):
    def __init__(self, response: RedirectResponse) -> None:
        self.response = response


async def _issue_authorization_code(
    *,
    session: AsyncSession,
    user: User,
    client: OAuthClient,
    redirect_uri: str,
    scope: str,
    code_challenge: str,
    resource: str | None,
) -> str:
    settings = get_settings()
    code = _new_secret()
    row = OAuthAuthorizationCode(
        code_hash=_hash_secret(code),
        client_id=client.client_id,
        user_id=user.id,
        redirect_uri=redirect_uri,
        scope=scope,
        code_challenge=code_challenge,
        code_challenge_method="S256",
        resource=resource,
        expires_at=_now() + timedelta(minutes=settings.oauth_authorization_code_ttl_minutes),
        created_at=_now(),
    )
    session.add(row)
    await session.commit()
    return code


async def _authorize_redirect(
    *,
    session: AsyncSession,
    user: User,
    params: dict[str, str],
) -> RedirectResponse:
    try:
        client, redirect_uri, scope, state, code_challenge, resource = (
            await _load_valid_authorization_request(params, session)
        )
    except _RedirectException as e:
        return e.response
    code = await _issue_authorization_code(
        session=session,
        user=user,
        client=client,
        redirect_uri=redirect_uri,
        scope=scope,
        code_challenge=code_challenge,
        resource=resource,
    )
    redirect_params = {"code": code}
    if state:
        redirect_params["state"] = state
    return _redirect_with_params(redirect_uri, redirect_params)


def _hidden_inputs(params: dict[str, str]) -> str:
    names = [
        "response_type",
        "client_id",
        "redirect_uri",
        "scope",
        "state",
        "code_challenge",
        "code_challenge_method",
        "resource",
    ]
    return "\n".join(
        f'<input type="hidden" name="{name}" value="{html.escape(params.get(name, ""), quote=True)}">'
        for name in names
    )


def _authorize_return_to(params: dict[str, str]) -> str:
    query = urlencode({key: value for key, value in params.items() if value})
    return f"/api/oauth/authorize?{query}"


def _provider_links_html(return_to: str) -> str:
    providers = enabled_provider_summaries()
    if not providers:
        return ""
    links = "\n".join(
        (
            '<a class="provider" '
            f'href="/api/auth/oauth/{provider.id}/start?{urlencode({"return_to": return_to})}">'
            f"Continue with {html.escape(provider.name)}</a>"
        )
        for provider in providers
    )
    return f"""
          <div class="providers">
            {links}
          </div>
          <div class="divider"><span>or use email</span></div>
        """


def _authorize_html(
    *,
    params: dict[str, str],
    client_name: str | None,
    user: User | None,
    error: str | None = None,
) -> HTMLResponse:
    title = "Authorize Spawn"
    escaped_client = html.escape(client_name or "this app")
    escaped_email = html.escape(user.email) if user else ""
    error_html = (
        f'<p class="error" role="alert">{html.escape(error)}</p>'
        if error
        else ""
    )
    hidden = _hidden_inputs(params)
    provider_links = _provider_links_html(_authorize_return_to(params))
    if user is not None:
        body = f"""
          <p class="muted">Signed in as {escaped_email}</p>
          <p>Allow <strong>{escaped_client}</strong> to control your Spawn hosts and agents through the Spawn MCP server.</p>
          {error_html}
          <form method="post" action="/api/oauth/authorize">
            {hidden}
            <button name="action" value="authorize" type="submit">Authorize</button>
            <button class="secondary" name="action" value="deny" type="submit">Deny</button>
          </form>
        """
    else:
        body = f"""
          <p>Sign in or create a Spawn account to authorize <strong>{escaped_client}</strong>.</p>
          {error_html}
          {provider_links}
          <form method="post" action="/api/oauth/authorize">
            {hidden}
            <input type="hidden" name="action" value="login">
            <label>Email <input name="email" type="email" autocomplete="email" required></label>
            <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
            <button type="submit">Sign in and authorize</button>
          </form>
          <hr>
          <form method="post" action="/api/oauth/authorize">
            {hidden}
            <input type="hidden" name="action" value="signup">
            <label>Email <input name="email" type="email" autocomplete="email" required></label>
            <label>Password <input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
            <button type="submit">Create account and authorize</button>
          </form>
        """
    return HTMLResponse(
        f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <style>
    :root {{ color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
    body {{ min-height: 100vh; margin: 0; display: grid; place-items: center; background: #070707; color: #f4f4f5; }}
    main {{ width: min(420px, calc(100vw - 32px)); border: 1px solid #27272a; border-radius: 8px; padding: 24px; background: #0f0f10; }}
    h1 {{ margin: 0 0 12px; font-size: 22px; }}
    p {{ color: #d4d4d8; line-height: 1.45; }}
    .muted {{ color: #a1a1aa; font-size: 14px; }}
    .error {{ color: #f87171; }}
    form {{ display: grid; gap: 12px; }}
    label {{ display: grid; gap: 6px; color: #d4d4d8; font-size: 14px; }}
    input {{ border: 1px solid #3f3f46; border-radius: 6px; padding: 10px 12px; background: #050505; color: #f4f4f5; font: inherit; }}
    button {{ border: 0; border-radius: 6px; padding: 10px 12px; background: #fafafa; color: #09090b; font: inherit; font-weight: 650; cursor: pointer; }}
    button.secondary {{ background: #27272a; color: #fafafa; }}
    .providers {{ display: grid; gap: 8px; margin: 16px 0; }}
    .provider {{ display: block; border: 1px solid #3f3f46; border-radius: 6px; padding: 10px 12px; color: #f4f4f5; text-align: center; text-decoration: none; font-weight: 650; }}
    .divider {{ display: flex; align-items: center; gap: 10px; margin: 18px 0; color: #a1a1aa; font-size: 12px; text-transform: uppercase; }}
    .divider::before, .divider::after {{ content: ""; height: 1px; flex: 1; background: #27272a; }}
    hr {{ border: 0; border-top: 1px solid #27272a; margin: 20px 0; }}
  </style>
</head>
<body>
  <main>
    <h1>{title}</h1>
    {body}
  </main>
</body>
</html>"""
    )


@router.get("/api/oauth/authorize")
async def authorize_get(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: User | None = Depends(auth.current_user_optional),
) -> Response:
    params = dict(request.query_params)
    try:
        client, *_ = await _load_valid_authorization_request(params, session)
    except _RedirectException as e:
        return e.response
    except HTTPException as e:
        return HTMLResponse(str(e.detail), status_code=e.status_code)
    return _authorize_html(params=params, client_name=client.client_name, user=user)


@router.post("/api/oauth/authorize")
async def authorize_post(
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_session),
    current: User | None = Depends(auth.current_user_optional),
) -> Response:
    form = await request.form()
    params = {key: _form_str(form, key) for key in dict(form)}
    action = _form_str(form, "action")
    try:
        client, redirect_uri, *_ = await _load_valid_authorization_request(params, session)
    except _RedirectException as e:
        return e.response
    except HTTPException as e:
        return HTMLResponse(str(e.detail), status_code=e.status_code)

    if action not in {"authorize", "deny", "login", "signup"}:
        return _authorize_html(
            params=params,
            client_name=client.client_name,
            user=current,
            error="Choose whether to authorize this app.",
        )

    if action == "deny":
        state = params.get("state", "")
        redirect_params = {"error": "access_denied"}
        if state:
            redirect_params["state"] = state
        return _redirect_with_params(redirect_uri, redirect_params)

    user = current
    if action in {"login", "signup"}:
        email = auth.normalize_email(_form_str(form, "email"))
        password = _form_str(form, "password")
        if not email or not password:
            return _authorize_html(
                params=params,
                client_name=client.client_name,
                user=None,
                error="Email and password are required.",
            )
        if action == "login":
            user = (
                await session.execute(select(User).where(func.lower(User.email) == email))
            ).scalar_one_or_none()
            if user is None or not auth.verify_password(password, user.password_hash):
                return _authorize_html(
                    params=params,
                    client_name=client.client_name,
                    user=None,
                    error="Invalid email or password.",
                )
        else:
            existing = (
                await session.execute(select(User).where(func.lower(User.email) == email))
            ).scalar_one_or_none()
            if existing is not None:
                return _authorize_html(
                    params=params,
                    client_name=client.client_name,
                    user=None,
                    error="An account already exists for that email.",
                )
            user = User(email=email, password_hash=auth.hash_password(password))
            session.add(user)
            try:
                await session.commit()
            except IntegrityError:
                await session.rollback()
                return _authorize_html(
                    params=params,
                    client_name=client.client_name,
                    user=None,
                    error="An account already exists for that email.",
                )
            await session.refresh(user)
        auth.set_session_cookie(response, auth.issue_session_token(user.id))

    if user is None:
        return _authorize_html(params=params, client_name=client.client_name, user=None)
    redirect = await _authorize_redirect(session=session, user=user, params=params)
    if "set-cookie" in response.headers:
        redirect.headers.append("set-cookie", response.headers["set-cookie"])
    return redirect


def _pkce_s256(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


async def _issue_token_response(
    *,
    session: AsyncSession,
    user_id: str,
    client_id: str,
    scope: str,
    resource: str | None,
) -> schemas.OAuthTokenResponse:
    settings = get_settings()
    refresh = _new_secret()
    row = OAuthRefreshToken(
        token_hash=_hash_secret(refresh),
        client_id=client_id,
        user_id=user_id,
        scope=scope,
        resource=resource,
        expires_at=_now() + timedelta(days=settings.oauth_refresh_ttl_days),
        created_at=_now(),
    )
    session.add(row)
    await session.commit()
    return schemas.OAuthTokenResponse(
        access_token=auth.issue_oauth_access_token(user_id, client_id, scope),
        expires_in=settings.oauth_access_ttl_minutes * 60,
        scope=scope,
        refresh_token=refresh,
    )


async def _authorization_code_grant(
    form: Any,
    session: AsyncSession,
) -> Response:
    client_id = _form_str(form, "client_id")
    code = _form_str(form, "code")
    redirect_uri = _form_str(form, "redirect_uri")
    code_verifier = _form_str(form, "code_verifier")
    if not client_id or not code or not redirect_uri or not code_verifier:
        return _oauth_json_error("invalid_request", "client_id, code, redirect_uri, and code_verifier are required")
    client = await session.get(OAuthClient, client_id)
    if client is None:
        return _oauth_json_error("invalid_client", "unknown client_id", status_code=401)
    row = (
        await session.execute(
            select(OAuthAuthorizationCode).where(
                OAuthAuthorizationCode.code_hash == _hash_secret(code)
            )
        )
    ).scalar_one_or_none()
    if row is None or row.client_id != client_id or row.redirect_uri != redirect_uri:
        return _oauth_json_error("invalid_grant", "invalid authorization code")
    if row.used_at is not None:
        return _oauth_json_error("invalid_grant", "authorization code was already used")
    if _aware(row.expires_at) <= _now():
        return _oauth_json_error("invalid_grant", "authorization code expired")
    if _pkce_s256(code_verifier) != row.code_challenge:
        return _oauth_json_error("invalid_grant", "PKCE verification failed")
    row.used_at = _now()
    token = await _issue_token_response(
        session=session,
        user_id=row.user_id,
        client_id=row.client_id,
        scope=row.scope,
        resource=row.resource,
    )
    return JSONResponse(token.model_dump())


async def _refresh_token_grant(form: Any, session: AsyncSession) -> Response:
    client_id = _form_str(form, "client_id")
    refresh_token = _form_str(form, "refresh_token")
    if not client_id or not refresh_token:
        return _oauth_json_error("invalid_request", "client_id and refresh_token are required")
    row = (
        await session.execute(
            select(OAuthRefreshToken).where(
                OAuthRefreshToken.token_hash == _hash_secret(refresh_token)
            )
        )
    ).scalar_one_or_none()
    if row is None or row.client_id != client_id:
        return _oauth_json_error("invalid_grant", "invalid refresh token")
    if row.revoked_at is not None:
        return _oauth_json_error("invalid_grant", "refresh token was revoked")
    if _aware(row.expires_at) <= _now():
        return _oauth_json_error("invalid_grant", "refresh token expired")
    row.revoked_at = _now()
    token = await _issue_token_response(
        session=session,
        user_id=row.user_id,
        client_id=row.client_id,
        scope=row.scope,
        resource=row.resource,
    )
    return JSONResponse(token.model_dump())


@router.post("/api/oauth/token")
async def oauth_token(
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> Response:
    form = await request.form()
    grant_type = _form_str(form, "grant_type")
    if grant_type == "authorization_code":
        return await _authorization_code_grant(form, session)
    if grant_type == "refresh_token":
        return await _refresh_token_grant(form, session)
    return _oauth_json_error("unsupported_grant_type", "supported grants: authorization_code, refresh_token")
