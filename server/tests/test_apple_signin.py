"""Sign in with Apple through the routes: native sheet and web form_post."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from spawn_server.apple_identity import AppleIdentity, AppleIdentityError
from spawn_server.config import get_settings
from spawn_server.db import get_sessionmaker
from spawn_server.models import AuthIdentity, User
from spawn_server.routes import auth_providers

APPLE_SUB = "001234.abcdef.0000"
IDENTITY_TOKEN = "a." + "b" * 64 + ".c"


@pytest.fixture(autouse=True)
def apple_configured(monkeypatch):
    monkeypatch.setenv("SPAWN_APPLE_TEAM_ID", "TEAM123456")
    monkeypatch.setenv("SPAWN_APPLE_KEY_ID", "KEY1234567")
    monkeypatch.setenv("SPAWN_APPLE_CLIENT_ID", "dev.spawnd.web")
    monkeypatch.setenv("SPAWN_APPLE_NATIVE_CLIENT_ID", "dev.spawnd")
    # A real ES256 key, so the client secret genuinely signs.
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.serialization import (
        Encoding,
        NoEncryption,
        PrivateFormat,
    )

    key = ec.generate_private_key(ec.SECP256R1())
    monkeypatch.setenv(
        "SPAWN_APPLE_PRIVATE_KEY",
        key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()).decode("ascii"),
    )
    get_settings.cache_clear()  # type: ignore[attr-defined]
    yield
    get_settings.cache_clear()  # type: ignore[attr-defined]


def _returns(monkeypatch, identity: AppleIdentity) -> None:
    async def fake(_token, *, settings, client=None):  # noqa: ANN001
        return identity

    monkeypatch.setattr(auth_providers, "verify_apple_identity_token", fake)


def _rejects(monkeypatch, message: str = "the Apple token was rejected") -> None:
    async def fake(_token, *, settings, client=None):  # noqa: ANN001
        raise AppleIdentityError(message)

    monkeypatch.setattr(auth_providers, "verify_apple_identity_token", fake)


class TestProviderListing:
    async def test_apple_is_offered_once_configured(self, client):
        response = await client.get("/api/auth/config")
        assert response.status_code == 200
        ids = {provider["id"] for provider in response.json()["providers"]}
        assert "apple" in ids

    async def test_apple_disappears_without_a_key(self, client, monkeypatch):
        monkeypatch.setenv("SPAWN_APPLE_PRIVATE_KEY", "")
        get_settings.cache_clear()  # type: ignore[attr-defined]
        response = await client.get("/api/auth/config")
        ids = {provider["id"] for provider in response.json()["providers"]}
        assert "apple" not in ids


class TestNativeSignIn:
    async def test_creates_an_account_on_first_sign_in(self, client, monkeypatch):
        _returns(
            monkeypatch,
            AppleIdentity(subject=APPLE_SUB, email="new@example.com", email_verified=True),
        )
        response = await client.post(
            "/api/auth/oauth/apple/native",
            json={"identity_token": IDENTITY_TOKEN},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["user"]["email"] == "new@example.com"
        assert body["access_token"]

        # The returned token is a real session, not a stub.
        me = await client.get(
            "/api/me", headers={"Authorization": f"Bearer {body['access_token']}"}
        )
        assert me.status_code == 200

    async def test_a_returning_user_needs_no_email(self, client, monkeypatch):
        """Apple sends the email only on the first authorization.

        Every sign-in after that carries `sub` alone, so demanding an email is
        exactly how this provider ends up working once and never again.
        """
        _returns(
            monkeypatch,
            AppleIdentity(subject=APPLE_SUB, email="repeat@example.com", email_verified=True),
        )
        first = await client.post(
            "/api/auth/oauth/apple/native", json={"identity_token": IDENTITY_TOKEN}
        )
        assert first.status_code == 200

        _returns(monkeypatch, AppleIdentity(subject=APPLE_SUB, email="", email_verified=False))
        second = await client.post(
            "/api/auth/oauth/apple/native", json={"identity_token": IDENTITY_TOKEN}
        )
        assert second.status_code == 200
        assert second.json()["user"]["id"] == first.json()["user"]["id"]

        # And the stored email survived the token that did not carry one.
        sm = get_sessionmaker()
        async with sm() as session:
            identity = (await session.execute(select(AuthIdentity))).scalar_one()
            assert identity.email == "repeat@example.com"

    async def test_an_unlinked_account_with_no_email_is_refused_clearly(
        self, client, monkeypatch
    ):
        _returns(monkeypatch, AppleIdentity(subject=APPLE_SUB, email="", email_verified=False))
        response = await client.post(
            "/api/auth/oauth/apple/native", json={"identity_token": IDENTITY_TOKEN}
        )
        assert response.status_code == 400
        assert "not linked" in response.json()["detail"]

    async def test_links_to_an_existing_account_with_the_same_email(self, client, monkeypatch):
        signup = await client.post(
            "/api/auth/signup",
            json={"email": "existing@example.com", "password": "a-long-enough-password"},
        )
        assert signup.status_code == 200
        existing_id = signup.json()["user"]["id"]

        _returns(
            monkeypatch,
            AppleIdentity(subject=APPLE_SUB, email="existing@example.com", email_verified=True),
        )
        response = await client.post(
            "/api/auth/oauth/apple/native", json={"identity_token": IDENTITY_TOKEN}
        )
        assert response.status_code == 200
        assert response.json()["user"]["id"] == existing_id

        sm = get_sessionmaker()
        async with sm() as session:
            assert len(list((await session.execute(select(User))).scalars())) == 1

    async def test_a_rejected_token_signs_nobody_in(self, client, monkeypatch):
        _rejects(monkeypatch)
        response = await client.post(
            "/api/auth/oauth/apple/native", json={"identity_token": IDENTITY_TOKEN}
        )
        assert response.status_code == 401
        sm = get_sessionmaker()
        async with sm() as session:
            assert list((await session.execute(select(User))).scalars()) == []

    async def test_the_endpoint_is_off_when_apple_is_not_configured(
        self, client, monkeypatch
    ):
        monkeypatch.setenv("SPAWN_APPLE_PRIVATE_KEY", "")
        get_settings.cache_clear()  # type: ignore[attr-defined]
        response = await client.post(
            "/api/auth/oauth/apple/native", json={"identity_token": IDENTITY_TOKEN}
        )
        assert response.status_code == 404

    @pytest.mark.parametrize("body", [{}, {"identity_token": ""}, {"identity_token": "x"}])
    async def test_a_malformed_body_is_refused(self, client, body):
        response = await client.post("/api/auth/oauth/apple/native", json=body)
        assert response.status_code == 422


class TestWebFlow:
    async def test_start_asks_apple_for_a_form_post(self, client):
        from urllib.parse import parse_qs, urlparse

        response = await client.get(
            "/api/auth/oauth/apple/start", follow_redirects=False
        )
        assert response.status_code == 302
        query = parse_qs(urlparse(response.headers["location"]).query)
        # Requesting any scope obliges Apple to POST the result back.
        assert query["response_mode"] == ["form_post"]
        assert query["client_id"] == ["dev.spawnd.web"]
        assert "email" in query["scope"][0]

    async def test_the_callback_accepts_a_post(self, client, monkeypatch):
        """Apple delivers form_post as a POST, so a GET-only callback 405s."""
        from urllib.parse import parse_qs, urlparse

        start = await client.get("/api/auth/oauth/apple/start", follow_redirects=False)
        state = parse_qs(urlparse(start.headers["location"]).query)["state"][0]

        async def fake_exchange(*, config, code):  # noqa: ANN001
            return auth_providers.ProviderProfile(
                provider="apple",
                provider_user_id=APPLE_SUB,
                email="web@example.com",
                email_verified=True,
            )

        monkeypatch.setattr(auth_providers, "_exchange_provider_code", fake_exchange)

        response = await client.post(
            "/api/auth/oauth/apple/callback",
            data={"state": state, "code": "apple-authorization-code"},
            follow_redirects=False,
        )
        assert response.status_code == 302
        assert "set-cookie" in response.headers

        sm = get_sessionmaker()
        async with sm() as session:
            user = (await session.execute(select(User))).scalar_one()
            assert user.email == "web@example.com"

    async def test_a_native_redirect_gets_a_code_and_no_cookie(self, client, monkeypatch):
        """The app cannot read a cookie set on a system web view's jar."""
        from urllib.parse import parse_qs, urlparse

        start = await client.get(
            "/api/auth/oauth/apple/start",
            params={"redirect_uri": "spawn://auth/oauth"},
            follow_redirects=False,
        )
        state = parse_qs(urlparse(start.headers["location"]).query)["state"][0]

        async def fake_exchange(*, config, code):  # noqa: ANN001
            return auth_providers.ProviderProfile(
                provider="apple",
                provider_user_id=APPLE_SUB,
                email="native@example.com",
                email_verified=True,
            )

        monkeypatch.setattr(auth_providers, "_exchange_provider_code", fake_exchange)

        response = await client.post(
            "/api/auth/oauth/apple/callback",
            data={"state": state, "code": "apple-authorization-code"},
            follow_redirects=False,
        )
        assert response.status_code == 302
        location = response.headers["location"]
        assert location.startswith("spawn://auth/oauth?")
        assert "set-cookie" not in response.headers

        code = parse_qs(urlparse(location).query)["code"][0]
        exchanged = await client.post("/api/auth/oauth/exchange", json={"code": code})
        assert exchanged.status_code == 200
        assert exchanged.json()["user"]["email"] == "native@example.com"

        # Single use: a code lifted from a log is already spent.
        assert (
            await client.post("/api/auth/oauth/exchange", json={"code": code})
        ).status_code == 400

    async def test_an_unlisted_redirect_is_refused(self, client):
        response = await client.get(
            "/api/auth/oauth/apple/start",
            params={"redirect_uri": "evil://auth/oauth"},
            follow_redirects=False,
        )
        assert response.status_code == 400
