"""A closed deployment gates provider sign-ups the same way it gates signup."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from spawn_server import auth, invites
from spawn_server.config import get_settings
from spawn_server.db import get_sessionmaker
from spawn_server.models import Invite, User
from spawn_server.routes.auth_providers import (
    InviteRequired,
    ProviderProfile,
    _user_for_profile,
)


@pytest.fixture(autouse=True)
def closed_deployment(monkeypatch):
    monkeypatch.setenv("SPAWN_INVITE_ONLY", "true")
    get_settings.cache_clear()  # type: ignore[attr-defined]
    yield
    get_settings.cache_clear()  # type: ignore[attr-defined]


@pytest.fixture
def configured_google(monkeypatch):
    monkeypatch.setenv("SPAWN_GOOGLE_CLIENT_ID", "google-client")
    monkeypatch.setenv("SPAWN_GOOGLE_CLIENT_SECRET", "google-secret")
    get_settings.cache_clear()  # type: ignore[attr-defined]
    yield
    get_settings.cache_clear()  # type: ignore[attr-defined]


def _profile(email: str = "newcomer@example.com", sub: str = "sub-1") -> ProviderProfile:
    return ProviderProfile(
        provider="google", provider_user_id=sub, email=email, email_verified=True
    )


async def _seed_owner() -> str:
    """An existing account, so the caller is not the deployment's first."""
    sm = get_sessionmaker()
    async with sm() as session:
        owner = User(email="owner@example.com", password_hash=auth.hash_password("pw"))
        session.add(owner)
        await session.commit()
        return owner.id


async def _make_invite(**overrides) -> tuple[str, str]:
    sm = get_sessionmaker()
    async with sm() as session:
        code = "invite-code-that-is-long-enough"
        fields = {"expires_at": datetime.now(UTC) + timedelta(days=1), **overrides}
        row = Invite(code_hash=invites.hash_code(code), **fields)
        session.add(row)
        await session.commit()
        return code, row.id


async def _link(profile: ProviderProfile, invite_code: str | None = None, **kw) -> User:
    sm = get_sessionmaker()
    async with sm() as session:
        return await _user_for_profile(
            session=session,
            profile=profile,
            linked_user_id=kw.get("linked_user_id"),
            invite_code_hash=invites.hash_code(invite_code) if invite_code else None,
        )


class TestClosedDeployment:
    async def test_a_provider_signup_without_an_invite_is_refused(self, app):
        """The hole this closes: OAuth used to walk straight past the gate."""
        await _seed_owner()
        with pytest.raises(InviteRequired) as caught:
            await _link(_profile())
        assert "invite only" in str(caught.value)
        assert caught.value.provider == "google"

        sm = get_sessionmaker()
        async with sm() as session:
            emails = [u.email for u in (await session.execute(select(User))).scalars()]
        assert emails == ["owner@example.com"]

    async def test_a_valid_invite_admits_and_is_spent(self, app):
        await _seed_owner()
        code, invite_id = await _make_invite()

        user = await _link(_profile(), invite_code=code)
        assert user.email == "newcomer@example.com"

        sm = get_sessionmaker()
        async with sm() as session:
            invite = await session.get(Invite, invite_id)
            assert invite is not None
            assert invite.used_at is not None
            assert invite.used_by_user_id == user.id

    async def test_an_invite_cannot_be_spent_twice(self, app):
        await _seed_owner()
        code, _ = await _make_invite()
        await _link(_profile(), invite_code=code)

        with pytest.raises(InviteRequired) as caught:
            await _link(_profile("second@example.com", sub="sub-2"), invite_code=code)
        assert str(caught.value) == "this invite is not valid"

    @pytest.mark.parametrize(
        "overrides",
        [
            {"expires_at": datetime.now(UTC) - timedelta(hours=1)},
            {"revoked_at": datetime.now(UTC)},
        ],
        ids=["expired", "revoked"],
    )
    async def test_an_unusable_invite_is_refused_indistinguishably(self, app, overrides):
        """One message for every failure, so codes cannot be probed."""
        await _seed_owner()
        code, _ = await _make_invite(**overrides)
        with pytest.raises(InviteRequired) as caught:
            await _link(_profile(), invite_code=code)
        assert str(caught.value) == "this invite is not valid"

    async def test_an_unknown_code_is_refused_the_same_way(self, app):
        await _seed_owner()
        with pytest.raises(InviteRequired) as caught:
            await _link(_profile(), invite_code="not-a-real-invite-code-at-all")
        assert str(caught.value) == "this invite is not valid"


class TestNotASignup:
    """The gate is on account creation, and nothing else."""

    async def test_signing_back_in_needs_no_invite(self, app):
        await _seed_owner()
        code, _ = await _make_invite()
        first = await _link(_profile(), invite_code=code)

        second = await _link(_profile())
        assert second.id == first.id

    async def test_a_provider_matching_an_existing_account_needs_no_invite(self, app):
        """Adoption by email is a link, not a new account."""
        await _seed_owner()
        user = await _link(_profile("owner@example.com"))
        assert user.email == "owner@example.com"

    async def test_linking_from_a_signed_in_session_needs_no_invite(self, app):
        owner_id = await _seed_owner()
        user = await _link(_profile("other@example.com"), linked_user_id=owner_id)
        assert user.id == owner_id

    async def test_the_first_account_is_admitted_without_one(self, app):
        """A closed install with nobody in it has no one to issue an invite."""
        user = await _link(_profile())
        assert user.email == "newcomer@example.com"


class TestOpenDeployment:
    async def test_no_invite_is_required_when_the_gate_is_off(self, app, monkeypatch):
        monkeypatch.setenv("SPAWN_INVITE_ONLY", "false")
        get_settings.cache_clear()  # type: ignore[attr-defined]
        await _seed_owner()
        user = await _link(_profile())
        assert user.email == "newcomer@example.com"


class TestTheBrowserNeverSeesJson:
    """A redirect flow must not end on `{"detail": ...}`.

    The callback is reached by following a redirect, so whatever it returns is
    rendered as a page. A 403 there strands the person on a JSON body with no
    way forward and no explanation of what an invite even is.
    """

    async def _start(self, client, **params):
        from urllib.parse import parse_qs, urlparse

        r = await client.get(
            "/api/auth/oauth/google/start", params=params, follow_redirects=False
        )
        return parse_qs(urlparse(r.headers["location"]).query)["state"][0]

    async def _stub_exchange(self, monkeypatch, email="newcomer@example.com"):
        from spawn_server.routes import auth_providers

        async def fake(*, config, code):
            return ProviderProfile(
                provider="google", provider_user_id="sub-1", email=email, email_verified=True
            )

        monkeypatch.setattr(auth_providers, "_exchange_provider_code", fake)

    async def test_web_callback_redirects_to_a_page_that_can_ask(
        self, client, monkeypatch, configured_google
    ):
        await _seed_owner()
        state = await self._start(client)
        await self._stub_exchange(monkeypatch)

        r = await client.get(
            "/api/auth/oauth/google/callback",
            params={"state": state, "code": "authorization-code"},
            follow_redirects=False,
        )
        assert r.status_code == 302
        location = r.headers["location"]
        assert "invite_required=1" in location
        assert "provider=google" in location
        assert "/signup" in location
        # And nothing was created on the way past.
        sm = get_sessionmaker()
        async with sm() as session:
            emails = [u.email for u in (await session.execute(select(User))).scalars()]
        assert emails == ["owner@example.com"]

    async def test_native_callback_signals_on_its_own_scheme(
        self, client, monkeypatch, configured_google
    ):
        """The app cannot show a web page, so it gets the reason on its scheme."""
        await _seed_owner()
        state = await self._start(client, redirect_uri="spawn://auth/oauth")
        await self._stub_exchange(monkeypatch)

        r = await client.get(
            "/api/auth/oauth/google/callback",
            params={"state": state, "code": "authorization-code"},
            follow_redirects=False,
        )
        assert r.status_code == 302
        assert r.headers["location"].startswith("spawn://auth/oauth?")
        assert "error=invite_required" in r.headers["location"]
        assert "set-cookie" not in r.headers
