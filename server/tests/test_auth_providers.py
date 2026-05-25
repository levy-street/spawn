"""External auth provider sign-in and account-linking behavior."""

from __future__ import annotations

import base64
import hashlib
from urllib.parse import parse_qs, urlencode, urlparse

import pytest
from sqlalchemy import func, select

from spawn_server.config import get_settings
from spawn_server.db import get_sessionmaker
from spawn_server.models import AuthIdentity, User
from spawn_server.routes import auth_providers
from spawn_server.routes.auth_providers import ProviderProfile


def _challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


@pytest.fixture
def configured_providers(monkeypatch):
    for provider in ("GOOGLE", "MICROSOFT", "GITHUB"):
        monkeypatch.setenv(f"SPAWN_{provider}_CLIENT_ID", f"{provider.lower()}-client")
        monkeypatch.setenv(f"SPAWN_{provider}_CLIENT_SECRET", f"{provider.lower()}-secret")
    get_settings.cache_clear()  # type: ignore[attr-defined]
    yield
    get_settings.cache_clear()  # type: ignore[attr-defined]


async def _provider_state(client, provider: str, return_to: str = "/") -> str:
    response = await client.get(
        f"/api/auth/oauth/{provider}/start",
        params={"return_to": return_to},
        follow_redirects=False,
    )
    assert response.status_code == 302, response.text
    query = parse_qs(urlparse(response.headers["location"]).query)
    return query["state"][0]


async def _identity_count() -> int:
    async with get_sessionmaker()() as session:
        return await session.scalar(select(func.count()).select_from(AuthIdentity)) or 0


async def test_provider_list_and_start_urls_require_enabled_credentials(client, configured_providers):
    providers = await client.get("/api/auth/providers")
    assert providers.status_code == 200
    assert providers.json() == {
        "providers": [
            {"id": "google", "name": "Google"},
            {"id": "microsoft", "name": "Microsoft"},
            {"id": "github", "name": "GitHub"},
        ]
    }

    google = await client.get("/api/auth/oauth/google/start", follow_redirects=False)
    assert google.status_code == 302
    google_location = urlparse(google.headers["location"])
    assert google_location.netloc == "accounts.google.com"
    google_query = parse_qs(google_location.query)
    assert google_query["client_id"] == ["google-client"]
    assert google_query["scope"] == ["openid email profile"]
    assert google_query["redirect_uri"] == [
        "http://localhost:8000/api/auth/oauth/google/callback"
    ]

    microsoft = await client.get("/api/auth/oauth/microsoft/start", follow_redirects=False)
    assert microsoft.status_code == 302
    microsoft_location = urlparse(microsoft.headers["location"])
    assert microsoft_location.netloc == "login.microsoftonline.com"
    assert parse_qs(microsoft_location.query)["client_id"] == ["microsoft-client"]

    github = await client.get("/api/auth/oauth/github/start", follow_redirects=False)
    assert github.status_code == 302
    github_location = urlparse(github.headers["location"])
    assert github_location.netloc == "github.com"
    assert parse_qs(github_location.query)["scope"] == ["read:user user:email"]


async def test_provider_start_is_hidden_when_provider_is_not_configured(client):
    get_settings.cache_clear()  # type: ignore[attr-defined]
    providers = await client.get("/api/auth/providers")
    assert providers.status_code == 200
    assert providers.json() == {"providers": []}

    start = await client.get("/api/auth/oauth/google/start", follow_redirects=False)
    assert start.status_code == 404


async def test_google_login_links_existing_manual_account_by_verified_email(
    client,
    configured_providers,
    monkeypatch,
):
    signup = await client.post(
        "/api/auth/signup",
        json={"email": "Person@Example.com", "password": "passpasspass"},
    )
    assert signup.status_code == 200
    user_id = signup.json()["user"]["id"]
    await client.post("/api/auth/logout")
    client.cookies.clear()

    async def fake_exchange(**_kwargs):
        return ProviderProfile(
            provider="google",
            provider_user_id="google-sub-1",
            email="person@example.com",
            email_verified=True,
        )

    monkeypatch.setattr(auth_providers, "_exchange_provider_code", fake_exchange)
    state = await _provider_state(client, "google")
    callback = await client.get(
        "/api/auth/oauth/google/callback",
        params={"state": state, "code": "provider-code"},
        follow_redirects=False,
    )
    assert callback.status_code == 302, callback.text
    assert callback.headers["location"] == "/"

    me = await client.get("/api/me")
    assert me.status_code == 200
    assert me.json()["user"]["id"] == user_id
    assert me.json()["user"]["email"] == "person@example.com"

    async with get_sessionmaker()() as session:
        identity = (
            await session.execute(select(AuthIdentity).where(AuthIdentity.provider == "google"))
        ).scalar_one()
        users = (await session.execute(select(User))).scalars().all()
    assert identity.user_id == user_id
    assert identity.email == "person@example.com"
    assert identity.email_verified is True
    assert len(users) == 1


async def test_provider_login_creates_user_and_reuses_identity_on_later_login(
    client,
    configured_providers,
    monkeypatch,
):
    profiles = [
        ProviderProfile(
            provider="github",
            provider_user_id="12345",
            email="github-user@example.com",
            email_verified=True,
        ),
        ProviderProfile(
            provider="github",
            provider_user_id="12345",
            email="github-renamed@example.com",
            email_verified=True,
        ),
    ]

    async def fake_exchange(**_kwargs):
        return profiles.pop(0)

    monkeypatch.setattr(auth_providers, "_exchange_provider_code", fake_exchange)

    first_state = await _provider_state(client, "github")
    first = await client.get(
        "/api/auth/oauth/github/callback",
        params={"state": first_state, "code": "first-code"},
        follow_redirects=False,
    )
    assert first.status_code == 302, first.text
    first_me = await client.get("/api/me")
    assert first_me.status_code == 200
    user_id = first_me.json()["user"]["id"]
    assert first_me.json()["user"]["email"] == "github-user@example.com"
    assert await _identity_count() == 1

    await client.post("/api/auth/logout")
    client.cookies.clear()
    second_state = await _provider_state(client, "github")
    second = await client.get(
        "/api/auth/oauth/github/callback",
        params={"state": second_state, "code": "second-code"},
        follow_redirects=False,
    )
    assert second.status_code == 302, second.text
    second_me = await client.get("/api/me")
    assert second_me.status_code == 200
    assert second_me.json()["user"]["id"] == user_id
    assert second_me.json()["user"]["email"] == "github-user@example.com"
    assert await _identity_count() == 1

    async with get_sessionmaker()() as session:
        identity = (
            await session.execute(select(AuthIdentity).where(AuthIdentity.provider == "github"))
        ).scalar_one()
    assert identity.email == "github-renamed@example.com"


async def test_provider_callback_rejects_unverified_email_and_state_replay(
    client,
    configured_providers,
    monkeypatch,
):
    async def fake_exchange(**_kwargs):
        raise auth_providers.ProviderAuthError("Google did not return a verified email")

    monkeypatch.setattr(auth_providers, "_exchange_provider_code", fake_exchange)
    state = await _provider_state(client, "google")
    rejected = await client.get(
        "/api/auth/oauth/google/callback",
        params={"state": state, "code": "provider-code"},
        follow_redirects=False,
    )
    assert rejected.status_code == 400
    assert rejected.json()["detail"] == "Google did not return a verified email"
    assert await _identity_count() == 0

    replay = await client.get(
        "/api/auth/oauth/google/callback",
        params={"state": state, "code": "provider-code"},
        follow_redirects=False,
    )
    assert replay.status_code == 400
    assert replay.json()["detail"] == "auth state was used"


async def test_provider_login_resumes_spawn_oauth_authorization(
    client,
    configured_providers,
    monkeypatch,
):
    registered = await client.post(
        "/api/oauth/register",
        json={
            "client_name": "ChatGPT Spawn",
            "redirect_uris": ["https://chat.openai.com/aip/callback"],
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "scope": "spawn",
        },
    )
    assert registered.status_code == 201, registered.text
    verifier = "provider-oauth-flow-verifier"
    oauth_params = {
        "response_type": "code",
        "client_id": registered.json()["client_id"],
        "redirect_uri": "https://chat.openai.com/aip/callback",
        "scope": "spawn",
        "state": "chatgpt-state",
        "code_challenge": _challenge(verifier),
        "code_challenge_method": "S256",
    }
    authorize = await client.get("/api/oauth/authorize", params=oauth_params)
    assert authorize.status_code == 200
    assert "Continue with Google" in authorize.text

    async def fake_exchange(**_kwargs):
        return ProviderProfile(
            provider="microsoft",
            provider_user_id="microsoft-sub-1",
            email="oauth-provider@example.com",
            email_verified=True,
        )

    monkeypatch.setattr(auth_providers, "_exchange_provider_code", fake_exchange)
    return_to = f"/api/oauth/authorize?{urlencode(oauth_params)}"
    provider_state = await _provider_state(client, "microsoft", return_to=return_to)
    callback = await client.get(
        "/api/auth/oauth/microsoft/callback",
        params={"state": provider_state, "code": "provider-code"},
        follow_redirects=False,
    )
    assert callback.status_code == 302, callback.text
    assert callback.headers["location"] == return_to

    resumed = await client.get(callback.headers["location"])
    assert resumed.status_code == 200
    assert "Signed in as oauth-provider@example.com" in resumed.text
