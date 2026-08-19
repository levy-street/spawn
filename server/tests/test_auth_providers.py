"""External auth provider sign-in and account-linking behavior."""

from __future__ import annotations

import base64
import hashlib
from datetime import UTC, datetime
from urllib.parse import parse_qs, urlparse

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


@pytest.fixture(autouse=True)
def isolated_provider_settings(monkeypatch):
    monkeypatch.setenv("SPAWN_PUBLIC_URL", "http://localhost:8000")
    for provider in ("GOOGLE", "MICROSOFT", "GITHUB"):
        monkeypatch.setenv(f"SPAWN_{provider}_CLIENT_ID", "")
        monkeypatch.setenv(f"SPAWN_{provider}_CLIENT_SECRET", "")
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


async def test_google_login_refuses_to_adopt_an_unverified_manual_account(
    client,
    configured_providers,
    monkeypatch,
):
    """Matching strings is not proof of ownership.

    Signup enforces only that an address is unique, so anyone can park a row
    on an address they do not own and wait for its real owner to arrive
    through a provider -- and keep password access to whatever that account
    later pairs. This is the account pre-hijacking case, and it must refuse.
    """

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

    # Refused, but not into a raw JSON error: this account holder has a
    # password and a way in, so say so on the sign-in page.
    assert callback.status_code == 302, callback.text
    location = urlparse(callback.headers["location"])
    assert location.path == "/login"
    assert "person@example.com" in parse_qs(location.query)["error"][0]
    assert "password" in parse_qs(location.query)["error"][0]

    # No session was issued, and nothing was attached to the account.
    me = await client.get("/api/me")
    assert me.status_code == 401
    assert await _identity_count() == 0
    async with get_sessionmaker()() as session:
        users = (await session.execute(select(User))).scalars().all()
    assert [user.id for user in users] == [user_id]


async def test_google_login_links_a_manual_account_that_verified_the_same_address(
    client,
    configured_providers,
    monkeypatch,
):
    """Both sides independently proved they hold the address, so link them.

    spawn's own verification mail is the out-of-band confirmation that makes
    adoption safe -- an attacker parking the row never receives it.
    """

    signup = await client.post(
        "/api/auth/signup",
        json={"email": "Owner@Example.com", "password": "passpasspass"},
    )
    assert signup.status_code == 200
    user_id = signup.json()["user"]["id"]
    async with get_sessionmaker()() as session:
        user = await session.get(User, user_id)
        assert user is not None
        user.email_verified_at = datetime.now(UTC)
        await session.commit()
    await client.post("/api/auth/logout")
    client.cookies.clear()

    async def fake_exchange(**_kwargs):
        return ProviderProfile(
            provider="google",
            provider_user_id="google-sub-owner",
            email="owner@example.com",
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

    async with get_sessionmaker()() as session:
        identity = (
            await session.execute(select(AuthIdentity).where(AuthIdentity.provider == "google"))
        ).scalar_one()
        users = (await session.execute(select(User))).scalars().all()
    assert identity.user_id == user_id
    assert len(users) == 1


async def test_provider_link_from_an_authenticated_session_still_works(
    client,
    configured_providers,
    monkeypatch,
):
    """The explicit path -- start the flow while signed in -- is unaffected."""

    signup = await client.post(
        "/api/auth/signup",
        json={"email": "linker@example.com", "password": "passpasspass"},
    )
    assert signup.status_code == 200
    user_id = signup.json()["user"]["id"]

    async def fake_exchange(**_kwargs):
        return ProviderProfile(
            provider="github",
            provider_user_id="github-sub-linked",
            # A different address on the provider side; the link is
            # authorized by the session, not by the string.
            email="linker-alias@example.com",
            email_verified=True,
        )

    monkeypatch.setattr(auth_providers, "_exchange_provider_code", fake_exchange)
    state = await _provider_state(client, "github")
    callback = await client.get(
        "/api/auth/oauth/github/callback",
        params={"state": state, "code": "provider-code"},
        follow_redirects=False,
    )
    assert callback.status_code == 302, callback.text

    async with get_sessionmaker()() as session:
        identity = (
            await session.execute(select(AuthIdentity).where(AuthIdentity.provider == "github"))
        ).scalar_one()
        users = (await session.execute(select(User))).scalars().all()
    assert identity.user_id == user_id
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


class _FakeUserinfoResponse:
    def __init__(self, body: dict) -> None:
        self.status_code = 200
        self._body = body

    def json(self) -> dict:
        return self._body


class _FakeUserinfoClient:
    """Stands in for the httpx client `_oidc_profile` calls."""

    def __init__(self, body: dict) -> None:
        self._body = body

    async def get(self, _url: str, **_kwargs) -> _FakeUserinfoResponse:
        return _FakeUserinfoResponse(self._body)


async def _microsoft_profile(body: dict):
    return await auth_providers._oidc_profile(
        _FakeUserinfoClient(body),  # type: ignore[arg-type]
        auth_providers.PROVIDER_DEFINITIONS["microsoft"],
        "access-token",
    )


async def test_microsoft_email_is_not_verified_just_because_it_is_present():
    """The nOAuth pattern: `mail` is a mutable directory attribute.

    Any tenant admin can set it to any string, so treating "non-empty" as
    "verified" hands over any account whose address they care to type.
    """

    with pytest.raises(auth_providers.ProviderAuthError) as excinfo:
        await _microsoft_profile({"sub": "attacker-sub", "email": "victim@company.com"})
    assert "verified email" in str(excinfo.value)


async def test_microsoft_requires_the_tenants_domain_ownership_claim():
    profile = await _microsoft_profile(
        {"sub": "ms-sub", "email": "person@company.com", "xms_edov": True}
    )
    assert profile.provider == "microsoft"
    assert profile.provider_user_id == "ms-sub"
    assert profile.email == "person@company.com"
    assert profile.email_verified is True

    # Entra ID emits the claim stringly in some token versions.
    stringly = await _microsoft_profile(
        {"sub": "ms-sub", "email": "person@company.com", "xms_edov": "true"}
    )
    assert stringly.email_verified is True

    # An explicit false is a refusal, not a missing claim.
    with pytest.raises(auth_providers.ProviderAuthError):
        await _microsoft_profile(
            {"sub": "ms-sub", "email": "person@company.com", "xms_edov": False}
        )


async def test_microsoft_never_takes_identity_from_preferred_username_or_upn():
    """Neither claim is an email address, verified or otherwise."""

    with pytest.raises(auth_providers.ProviderAuthError) as excinfo:
        await _microsoft_profile(
            {
                "sub": "ms-sub",
                "xms_edov": True,
                "preferred_username": "victim@company.com",
                "upn": "victim@company.com",
            }
        )
    assert "email address" in str(excinfo.value)


async def test_google_still_requires_its_own_verified_claim():
    async def google_profile(body: dict):
        return await auth_providers._oidc_profile(
            _FakeUserinfoClient(body),  # type: ignore[arg-type]
            auth_providers.PROVIDER_DEFINITIONS["google"],
            "access-token",
        )

    profile = await google_profile(
        {"sub": "google-sub", "email": "person@example.com", "email_verified": True}
    )
    assert profile.email_verified is True

    with pytest.raises(auth_providers.ProviderAuthError):
        await google_profile({"sub": "google-sub", "email": "person@example.com"})

    # And Google's `xms_edov` means nothing — it is an Entra ID claim.
    with pytest.raises(auth_providers.ProviderAuthError):
        await google_profile(
            {"sub": "google-sub", "email": "person@example.com", "xms_edov": True}
        )
