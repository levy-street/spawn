"""Provider sign-ins skip email verification, and cannot be used to inherit one."""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import select

from spawn_server import auth
from spawn_server.db import get_sessionmaker
from spawn_server.models import AuthIdentity, User
from spawn_server.routes.auth_providers import ProviderProfile, _user_for_profile


def _profile(email: str = "operator@example.com", *, verified: bool = True, sub: str = "sub-1"):
    return ProviderProfile(
        provider="google",
        provider_user_id=sub,
        email=email,
        email_verified=verified,
    )


async def _link(profile: ProviderProfile, linked_user_id: str | None = None) -> User:
    sm = get_sessionmaker()
    async with sm() as session:
        return await _user_for_profile(
            session=session, profile=profile, linked_user_id=linked_user_id
        )


class TestNewAccounts:
    async def test_a_provider_account_is_verified_on_creation(self, app):
        user = await _link(_profile())
        assert user.email_verified_at is not None

    async def test_an_unverified_provider_email_does_not_confer_verification(self, app):
        """Only a provider that actually vouched for the address counts."""
        sm = get_sessionmaker()
        async with sm() as session:
            existing = User(email="known@example.com", password_hash=auth.hash_password("pw"))
            session.add(existing)
            await session.commit()

        user = await _link(_profile("known@example.com", verified=False))
        assert user.email_verified_at is None


class TestReturningUsers:
    async def test_a_second_sign_in_keeps_the_account_verified(self, app):
        first = await _link(_profile())
        second = await _link(_profile())
        assert first.id == second.id
        assert second.email_verified_at is not None

    async def test_an_account_linked_before_this_change_is_caught_up(self, app):
        """A user stranded behind the old gate must not stay stuck there."""
        user = await _link(_profile())
        sm = get_sessionmaker()
        async with sm() as session:
            row = await session.get(User, user.id)
            assert row is not None
            row.email_verified_at = None
            await session.commit()

        # Apple sends no email on a repeat sign-in; the stored claim carries it.
        again = await _link(_profile(email="", verified=False))
        assert again.email_verified_at is not None

    async def test_a_repeat_sign_in_without_an_email_keeps_the_stored_one(self, app):
        await _link(_profile())
        await _link(_profile(email="", verified=False))
        sm = get_sessionmaker()
        async with sm() as session:
            identity = (await session.execute(select(AuthIdentity))).scalar_one()
            assert identity.email == "operator@example.com"


class TestAdoptingALocalAccount:
    async def test_an_unverified_local_account_loses_its_password(self, app):
        """The pre-hijacking guard.

        Planting an unverified account under someone else's address and waiting
        for them to arrive by provider is the standard attack. Adoption must not
        hand the planter a now-verified account they still hold the password to.
        """
        sm = get_sessionmaker()
        async with sm() as session:
            planted = User(
                email="victim@example.com",
                password_hash=auth.hash_password("attacker-knows-this"),
            )
            session.add(planted)
            await session.commit()
            planted_hash = planted.password_hash
            planted_epoch = planted.session_epoch

        user = await _link(_profile("victim@example.com"))

        assert user.email_verified_at is not None
        assert user.password_hash != planted_hash
        assert not auth.verify_password("attacker-knows-this", user.password_hash)
        # Any session minted against the planted account is refused as well.
        assert user.session_epoch == planted_epoch + 1

    async def test_an_already_verified_account_keeps_its_password(self, app):
        """Nothing to defend against: the real owner proved the address."""
        sm = get_sessionmaker()
        async with sm() as session:
            owner = User(
                email="owner@example.com",
                password_hash=auth.hash_password("my-own-password"),
                email_verified_at=datetime.now(UTC),
            )
            session.add(owner)
            await session.commit()
            original_hash = owner.password_hash
            original_epoch = owner.session_epoch

        user = await _link(_profile("owner@example.com"))

        assert user.password_hash == original_hash
        assert user.session_epoch == original_epoch
        assert auth.verify_password("my-own-password", user.password_hash)

    async def test_explicit_linking_from_a_signed_in_session_is_untouched(self, app):
        """Linking a provider while already signed in proves the account is yours."""
        sm = get_sessionmaker()
        async with sm() as session:
            me = User(email="me@example.com", password_hash=auth.hash_password("keep-me"))
            session.add(me)
            await session.commit()
            my_id, my_hash = me.id, me.password_hash

        user = await _link(_profile("me@example.com"), linked_user_id=my_id)

        assert user.id == my_id
        assert user.password_hash == my_hash
        assert user.email_verified_at is not None
