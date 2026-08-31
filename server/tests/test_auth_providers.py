"""External auth provider sign-in and account-linking behavior."""

from __future__ import annotations

import base64
import hashlib
from urllib.parse import parse_qs, urlparse

import pytest
from sqlalchemy import func, select

from spawn_server.config import Settings, get_settings
from spawn_server.db import get_sessionmaker
from spawn_server.models import AuthIdentity, User
from spawn_server.routes import auth_providers
from spawn_server.routes.auth_providers import ProviderProfile


def _challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


@pytest.fixture(autouse=True)
def isolated_provider_settings(monkeypatch):
    monkeypatch.setenv("SPAWN_PUBLIC_URL", "http://localhost:8000")
    for provider in ("GOOGLE", "MICROSOFT", "GITHUB"):
        monkeypatch.setenv(f"SPAWN_{provider}_CLIENT_ID", "")
        monkeypatch.setenv(f"SPAWN_{provider}_CLIENT_SECRET", "")
    # Apple is configured from four values rather than a pair, and a developer
    # with real ones in a local .env would otherwise see this file's exact
    # provider-list assertions fail for reasons that have nothing to do with it.
    for key in ("TEAM_ID", "KEY_ID", "PRIVATE_KEY", "CLIENT_ID", "NATIVE_CLIENT_ID"):
        monkeypatch.setenv(f"SPAWN_APPLE_{key}", "")
    get_settings.cache_clear()  # type: ignore[attr-defined]
    yield
    get_settings.cache_clear()  # type: ignore[attr-defined]


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


async def test_auth_config_lists_providers_and_start_urls_require_credentials(
    client, configured_providers
):
    config = await client.get("/api/auth/config")
    assert config.status_code == 200
    body = config.json()
    assert body["providers"] == [
        {"id": "google", "name": "Google"},
        {"id": "microsoft", "name": "Microsoft"},
        {"id": "github", "name": "GitHub"},
    ]
    # No SMTP is configured in tests, so the server would never enforce the
    # email gate — config must say so.
    assert body["email_verification_required"] is False
    assert body["invite_only"] is False

    # The old providers endpoint is deleted, not aliased.
    assert (await client.get("/api/auth/providers")).status_code == 404

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
    config = await client.get("/api/auth/config")
    assert config.status_code == 200
    assert config.json()["providers"] == []

    start = await client.get("/api/auth/oauth/google/start", follow_redirects=False)
    assert start.status_code == 404


async def test_native_redirect_default_accepts_mobile_and_desktop_but_rejects_unknown(
    client, configured_providers, monkeypatch
):
    default_redirects = "spawn://auth/oauth,spawn://oauth/callback"
    assert Settings.model_fields["oauth_native_redirect_uris"].default == default_redirects
    monkeypatch.setenv("SPAWN_OAUTH_NATIVE_REDIRECT_URIS", default_redirects)
    get_settings.cache_clear()  # type: ignore[attr-defined]

    for redirect_uri in ("spawn://auth/oauth", "spawn://oauth/callback"):
        response = await client.get(
            "/api/auth/oauth/google/start",
            params={"redirect_uri": redirect_uri},
            follow_redirects=False,
        )
        assert response.status_code == 302

    unknown = await client.get(
        "/api/auth/oauth/google/start",
        params={"redirect_uri": "spawn://oauth/callback/extra"},
        follow_redirects=False,
    )
    assert unknown.status_code == 400
    assert unknown.json()["detail"] == "redirect_uri is not an allowed native redirect"


def test_native_redirect_environment_override_replaces_defaults(monkeypatch):
    monkeypatch.setenv("SPAWN_OAUTH_NATIVE_REDIRECT_URIS", "example-app://oauth/callback")
    get_settings.cache_clear()  # type: ignore[attr-defined]

    assert get_settings().oauth_native_redirect_uri_list == ["example-app://oauth/callback"]


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


async def test_provider_login_redirects_to_relative_return_to(
    client,
    configured_providers,
    monkeypatch,
):
    async def fake_exchange(**_kwargs):
        return ProviderProfile(
            provider="microsoft",
            provider_user_id="microsoft-sub-1",
            email="oauth-provider@example.com",
            email_verified=True,
        )

    monkeypatch.setattr(auth_providers, "_exchange_provider_code", fake_exchange)
    return_to = "/agents?from=provider-login"
    provider_state = await _provider_state(client, "microsoft", return_to=return_to)
    callback = await client.get(
        "/api/auth/oauth/microsoft/callback",
        params={"state": provider_state, "code": "provider-code"},
        follow_redirects=False,
    )
    assert callback.status_code == 302, callback.text
    assert callback.headers["location"] == return_to


async def _native_code(client, monkeypatch, *, email: str, challenge: str | None) -> str:
    """Run a native provider sign-in to completion and return its one-time code."""

    async def fake_exchange(**_kwargs):
        return ProviderProfile(
            provider="google",
            provider_user_id=f"google-sub-{email}",
            email=email,
            email_verified=True,
        )

    monkeypatch.setattr(auth_providers, "_exchange_provider_code", fake_exchange)
    params = {"redirect_uri": "spawn://auth/oauth"}
    if challenge is not None:
        params |= {"code_challenge": challenge, "code_challenge_method": "S256"}
    start = await client.get(
        "/api/auth/oauth/google/start", params=params, follow_redirects=False
    )
    assert start.status_code == 302, start.text
    state = parse_qs(urlparse(start.headers["location"]).query)["state"][0]
    callback = await client.get(
        "/api/auth/oauth/google/callback",
        params={"state": state, "code": "provider-code"},
        follow_redirects=False,
    )
    assert callback.status_code == 302, callback.text
    location = callback.headers["location"]
    assert location.startswith("spawn://auth/oauth?")
    return parse_qs(urlparse(location).query)["code"][0]


def _challenge_for(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


async def test_native_exchange_code_is_bound_to_the_client_that_started_the_flow(
    client, configured_providers, monkeypatch
):
    """The login-CSRF this closes.

    Without PKCE the one-time code proves only *which account* signed in, never
    *who asked*. An attacker completes OAuth with their own account, takes the
    resulting `spawn://auth/oauth?code=...` link, and lures someone into opening
    it; that person's app signs into the attacker's account — and on desktop,
    where the host gate possesses on arrival, hands over their computer.
    """
    verifier = "v" * 64
    code = await _native_code(
        client, monkeypatch, email="pkce@example.com", challenge=_challenge_for(verifier)
    )

    # The victim's app has no verifier for a flow it never started.
    stolen = await client.post("/api/auth/oauth/exchange", json={"code": code})
    assert stolen.status_code == 400
    assert stolen.json()["detail"] == "this sign-in code was not issued to this app"

    # And a spent code stays spent, so the real client cannot rescue it either.
    replay = await client.post(
        "/api/auth/oauth/exchange", json={"code": code, "code_verifier": verifier}
    )
    assert replay.status_code == 400
    assert replay.json()["detail"] == "this sign-in code is invalid or has expired"


async def test_native_exchange_accepts_the_matching_verifier_and_refuses_a_wrong_one(
    client, configured_providers, monkeypatch
):
    verifier = "w" * 64
    challenge = _challenge_for(verifier)

    wrong = await _native_code(
        client, monkeypatch, email="pkce-wrong@example.com", challenge=challenge
    )
    refused = await client.post(
        "/api/auth/oauth/exchange", json={"code": wrong, "code_verifier": "x" * 64}
    )
    assert refused.status_code == 400
    assert refused.json()["detail"] == "this sign-in code was not issued to this app"

    good = await _native_code(
        client, monkeypatch, email="pkce-good@example.com", challenge=challenge
    )
    accepted = await client.post(
        "/api/auth/oauth/exchange", json={"code": good, "code_verifier": verifier}
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["user"]["email"] == "pkce-good@example.com"


async def test_native_exchange_without_a_challenge_still_works_for_older_apps(
    client, configured_providers, monkeypatch
):
    """A build that predates PKCE must keep signing in through an updated server."""
    code = await _native_code(client, monkeypatch, email="legacy@example.com", challenge=None)
    accepted = await client.post("/api/auth/oauth/exchange", json={"code": code})
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["user"]["email"] == "legacy@example.com"


async def test_start_refuses_a_plain_or_malformed_code_challenge(client, configured_providers):
    plain = await client.get(
        "/api/auth/oauth/google/start",
        params={
            "redirect_uri": "spawn://auth/oauth",
            "code_challenge": "a" * 43,
            "code_challenge_method": "plain",
        },
        follow_redirects=False,
    )
    assert plain.status_code == 400
    assert plain.json()["detail"] == "only the S256 code challenge method is supported"

    malformed = await client.get(
        "/api/auth/oauth/google/start",
        params={
            "redirect_uri": "spawn://auth/oauth",
            "code_challenge": "too-short",
            "code_challenge_method": "S256",
        },
        follow_redirects=False,
    )
    assert malformed.status_code == 400
    assert malformed.json()["detail"] == "code_challenge is malformed"
