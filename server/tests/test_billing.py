"""Entitlement: how many hosts an account may hold, and why.

`spawn_server/billing.py` is the only module that knows what a tier means, so
this is where the four ways an account can arrive at a limit are pinned down,
along with the two things that are easy to get wrong in a way nobody notices:
counting hosts through the retained key claims instead of the hosts, and
letting prose into an error body that a phone renders verbatim.

No Stripe, no network — none of this code has either.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest
from sqlalchemy import func, select

from spawn_server import billing
from spawn_server.config import InsecureConfigurationError, Settings, get_settings
from spawn_server.db import get_sessionmaker
from spawn_server.models import Host, HostKeyClaim, Subscription, User

pytestmark = pytest.mark.anyio

PRICE_COVEN = "price_test_coven"
PRICE_LEGION = "price_test_legion"
PRICE_PANDEMONIUM = "price_test_pandemonium"

STRIPE_ENV = {
    "SPAWN_BILLING_ENABLED": "true",
    "SPAWN_STRIPE_SECRET_KEY": "sk_test_entitlement",
    "SPAWN_STRIPE_WEBHOOK_SECRET": "whsec_entitlement",
    "SPAWN_STRIPE_PRICE_COVEN": PRICE_COVEN,
    "SPAWN_STRIPE_PRICE_LEGION": PRICE_LEGION,
    "SPAWN_STRIPE_PRICE_PANDEMONIUM": PRICE_PANDEMONIUM,
}


@pytest.fixture
def billing_on(monkeypatch):
    """A fully configured hosted instance, for the duration of one test.

    `get_settings()` is lru_cached, so the cache is cleared on the way in and
    again on the way out — monkeypatch has restored the environment by then,
    and leaving a billing-enabled Settings cached would change every test that
    ran afterwards.
    """
    for name, value in STRIPE_ENV.items():
        monkeypatch.setenv(name, value)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _settings(**overrides) -> Settings:
    """Settings built from nothing but what this call passes.

    `_env_file=None` keeps a developer's `.env` out of it and every billing
    value is named explicitly, so the ambient environment cannot quietly
    supply the one the test is asserting is missing.
    """
    return Settings(
        _env_file=None,
        **{
            "billing_enabled": True,
            "stripe_secret_key": "sk_test_x",
            "stripe_webhook_secret": "whsec_x",
            "stripe_price_coven": PRICE_COVEN,
            "stripe_price_legion": PRICE_LEGION,
            "stripe_price_pandemonium": PRICE_PANDEMONIUM,
            **overrides,
        },
    )


async def _user(session, email: str, **columns) -> User:
    user = User(email=email, password_hash="x", **columns)
    session.add(user)
    await session.flush()
    return user


async def _subscribe(session, user: User, **columns) -> Subscription:
    subscription = Subscription(
        user_id=user.id,
        stripe_customer_id=f"cus_{user.id[:16]}",
        stripe_subscription_id=f"sub_{user.id[:16]}",
        **columns,
    )
    session.add(subscription)
    await session.flush()
    return subscription


class TestEntitlementResolutionOrder:
    async def test_billing_disabled_is_unlimited_and_reads_no_subscription(self, app):
        """The branch every self-hosted deployment lives in, forever."""
        async with get_sessionmaker()() as session:
            user = await _user(session, "self-hosted@example.com")
            # Present, and entitling, and irrelevant: with the flag off the
            # row must not be consulted at all.
            await _subscribe(session, user, tier="coven", status="active", host_limit=3)

            granted = await billing.entitlement(session, user)

        assert granted.host_limit is None
        assert granted.tier == billing.TIER_FREE
        assert granted.reason == "billing_disabled"

    async def test_an_entitling_subscription_grants_its_own_limit(self, app, billing_on):
        async with get_sessionmaker()() as session:
            user = await _user(session, "legion-plan@example.com")
            await _subscribe(session, user, tier="legion", status="active", host_limit=20)

            granted = await billing.entitlement(session, user)

        assert granted == billing.Entitlement(
            tier=billing.TIER_LEGION, host_limit=20, reason="subscription"
        )

    async def test_an_account_that_has_never_paid_gets_one_host(self, app, billing_on):
        async with get_sessionmaker()() as session:
            user = await _user(session, "never-paid@example.com")

            granted = await billing.entitlement(session, user)

        assert granted == billing.Entitlement(
            tier=billing.TIER_FREE, host_limit=1, reason="free"
        )

    @pytest.mark.parametrize("status", ["canceled", "unpaid", "incomplete_expired"])
    async def test_a_finished_subscription_falls_back_to_the_free_limit(
        self, app, billing_on, status
    ):
        """Where Stripe has given up, so have we — but the row stays.

        It is kept so the customer id survives a resubscribe, which means a
        lapsed row is a completely ordinary state and not an error.
        """
        async with get_sessionmaker()() as session:
            user = await _user(session, f"lapsed-{status}@example.com")
            await _subscribe(session, user, tier="pandemonium", status=status, host_limit=None)

            granted = await billing.entitlement(session, user)

        assert granted.host_limit == 1
        assert granted.tier == billing.TIER_FREE
        assert granted.reason == "free"

    @pytest.mark.parametrize("status", sorted(billing.ENTITLING_STATUSES))
    async def test_dunning_does_not_take_a_host_away(self, app, billing_on, status):
        """`past_due` entitles. A card that failed this morning is not a reason
        to refuse somebody a host this afternoon."""
        async with get_sessionmaker()() as session:
            user = await _user(session, f"dunning-{status}@example.com")
            await _subscribe(session, user, tier="coven", status=status, host_limit=3)

            granted = await billing.entitlement(session, user)

        assert granted.host_limit == 3
        assert granted.reason == "subscription"


class TestCompedAccounts:
    async def test_an_override_outranks_an_entitling_subscription(self, app, billing_on):
        async with get_sessionmaker()() as session:
            user = await _user(session, "comped-over-paid@example.com", host_limit_override=2)
            await _subscribe(
                session, user, tier="pandemonium", status="active", host_limit=None
            )

            granted = await billing.entitlement(session, user)

        assert granted.host_limit == 2
        assert granted.reason == "comped"
        # The tier still names what they are paying for; only the number moved.
        assert granted.tier == billing.TIER_PANDEMONIUM

    async def test_an_override_of_zero_is_unlimited(self, app, billing_on):
        """The column's only way to spell it, translated at this boundary so
        nothing downstream has to know that 0 is special."""
        async with get_sessionmaker()() as session:
            user = await _user(session, "comped-unlimited@example.com", host_limit_override=0)

            granted = await billing.entitlement(session, user)

        assert granted.host_limit is None
        assert granted.tier == billing.TIER_FREE
        assert granted.reason == "comped"

    async def test_an_override_survives_a_lapsed_card(self, app, billing_on):
        async with get_sessionmaker()() as session:
            user = await _user(session, "comped-lapsed@example.com", host_limit_override=5)
            await _subscribe(session, user, tier="legion", status="canceled", host_limit=20)

            granted = await billing.entitlement(session, user)

        assert granted.host_limit == 5
        assert granted.reason == "comped"


class TestTierCatalogue:
    def test_the_legion_plan_is_never_written_bare(self):
        """`/legion` is already the fleet page. A billing string that says just
        "Legion" reads as that page rather than as a plan, and is a bug."""
        assert billing.TIERS[billing.TIER_LEGION].name == "the Legion plan"

    def test_every_tier_key_matches_its_entry_and_the_order(self):
        assert tuple(billing.TIERS) == billing.TIER_ORDER
        for key, tier in billing.TIERS.items():
            assert tier.key == key

    def test_pandemonium_is_the_only_unlimited_tier(self):
        unlimited = {key for key, tier in billing.TIERS.items() if tier.host_limit is None}
        assert unlimited == {billing.TIER_PANDEMONIUM}

    def test_host_limit_for_tier_falls_back_to_free(self):
        assert billing.host_limit_for_tier(billing.TIER_COVEN) == 3
        assert billing.host_limit_for_tier(billing.TIER_PANDEMONIUM) is None
        assert billing.host_limit_for_tier("enterprise-platinum") == 1

    def test_our_configured_price_ids_map_to_their_tiers(self, billing_on):
        assert billing.tier_for_price_id(PRICE_COVEN) == billing.TIER_COVEN
        assert billing.tier_for_price_id(PRICE_LEGION) == billing.TIER_LEGION
        assert billing.tier_for_price_id(PRICE_PANDEMONIUM) == billing.TIER_PANDEMONIUM

    @pytest.mark.parametrize(
        "price_id",
        [None, "", "price_from_another_account", "PRICE_TEST_COVEN", " price_test_coven"],
    )
    def test_anything_else_is_free(self, billing_on, price_id):
        """Fails closed, and matches exactly. A price id we do not recognise is
        a subscription to something this deployment does not sell."""
        assert billing.tier_for_price_id(price_id) == billing.TIER_FREE

    def test_an_unconfigured_deployment_maps_nothing_to_a_paid_tier(self):
        """With the ids unset, a price id that happens to be empty must not
        collide with them and hand out Pandemonium."""
        bare = Settings(_env_file=None, billing_enabled=False)
        assert billing.tier_for_price_id(PRICE_LEGION, bare) == billing.TIER_FREE
        assert billing.tier_for_price_id("", bare) == billing.TIER_FREE
        assert billing.price_id_for_tier(billing.TIER_LEGION, bare) is None

    def test_price_id_for_tier_round_trips(self, billing_on):
        for tier in (billing.TIER_COVEN, billing.TIER_LEGION, billing.TIER_PANDEMONIUM):
            price_id = billing.price_id_for_tier(tier)
            assert price_id is not None
            assert billing.tier_for_price_id(price_id) == tier
        assert billing.price_id_for_tier(billing.TIER_FREE) is None
        assert billing.price_id_for_tier("enterprise-platinum") is None


class TestHostCounting:
    async def test_a_retained_key_claim_is_not_a_host(self, app, billing_on):
        """Deleting a host frees the slot; the claim deliberately stays.

        `routes/hosts.py` keeps the claim so a machine can only ever come back
        to the same account, which means someone who has deleted forty hosts
        still holds forty claims. Counting those would bill them for machines
        they no longer have.
        """
        public_key = "A" * 43
        async with get_sessionmaker()() as session:
            user = await _user(session, "deleted-a-host@example.com")
            host = Host(
                owner_user_id=user.id,
                name="the-laptop",
                host_key_algorithm="ed25519",
                host_public_key=public_key,
            )
            session.add(host)
            session.add(
                HostKeyClaim(
                    host_key_algorithm="ed25519",
                    host_public_key=public_key,
                    owner_user_id=user.id,
                )
            )
            await session.flush()
            assert await billing.host_count(session, user.id) == 1

            await session.delete(host)
            await session.flush()

            assert await billing.host_count(session, user.id) == 0
            # The claim is still there — that is the whole point of the test.
            claims = (
                await session.execute(
                    select(func.count())
                    .select_from(HostKeyClaim)
                    .where(HostKeyClaim.owner_user_id == user.id)
                )
            ).scalar_one()
            assert claims == 1

    async def test_an_offline_host_still_occupies_its_slot(self, app, billing_on):
        """An offline host is just a laptop that is shut."""
        async with get_sessionmaker()() as session:
            user = await _user(session, "offline-host@example.com")
            session.add(Host(owner_user_id=user.id, name="asleep", status="offline"))
            await session.flush()

            assert await billing.host_count(session, user.id) == 1

    async def test_hosts_are_counted_per_account(self, app, billing_on):
        async with get_sessionmaker()() as session:
            mine = await _user(session, "mine@example.com")
            theirs = await _user(session, "theirs@example.com")
            session.add(Host(owner_user_id=theirs.id, name="not-mine"))
            await session.flush()

            assert await billing.host_count(session, mine.id) == 0
            assert await billing.host_count(session, theirs.id) == 1


class TestMayAddHost:
    async def test_a_free_account_is_refused_its_second_host(self, app, billing_on):
        async with get_sessionmaker()() as session:
            user = await _user(session, "second-host@example.com")
            session.add(Host(owner_user_id=user.id, name="first"))
            await session.flush()

            decision = await billing.may_add_host(session, user)

        assert decision.allowed is False
        assert decision.host_count == 1
        assert decision.host_limit == 1
        assert decision.tier == billing.TIER_FREE

    async def test_room_left_is_allowed(self, app, billing_on):
        async with get_sessionmaker()() as session:
            user = await _user(session, "room-left@example.com")
            await _subscribe(session, user, tier="coven", status="active", host_limit=3)
            session.add(Host(owner_user_id=user.id, name="first"))
            await session.flush()

            decision = await billing.may_add_host(session, user)

        assert decision.allowed is True
        assert (decision.host_count, decision.host_limit) == (1, 3)

    async def test_unlimited_is_always_allowed(self, app, billing_on):
        async with get_sessionmaker()() as session:
            user = await _user(session, "unlimited@example.com")
            await _subscribe(
                session, user, tier="pandemonium", status="active", host_limit=None
            )
            for index in range(4):
                session.add(Host(owner_user_id=user.id, name=f"host-{index}"))
            await session.flush()

            decision = await billing.may_add_host(session, user)

        assert decision.allowed is True
        assert decision.host_limit is None

    async def test_the_account_lock_is_a_no_op_on_sqlite(self, app, billing_on):
        """SQLAlchemy's SQLite dialect emits no FOR UPDATE, which is correct
        rather than a gap — the answer must be the same either way."""
        async with get_sessionmaker()() as session:
            user = await _user(session, "locked@example.com")
            session.add(Host(owner_user_id=user.id, name="first"))
            await session.flush()

            await billing.lock_account(session, user.id)
            locked = await billing.may_add_host(session, user, lock=True)
            unlocked = await billing.may_add_host(session, user)

        assert locked == unlocked
        assert locked.allowed is False


class TestBillingState:
    async def test_it_is_safe_to_call_with_billing_disabled(self, app):
        async with get_sessionmaker()() as session:
            user = await _user(session, "state-self-hosted@example.com")
            session.add(Host(owner_user_id=user.id, name="one"))
            await session.flush()

            state = await billing.billing_state(session, user)

        assert state == {
            "tier": "free",
            "tier_name": "Free",
            "host_limit": None,
            "host_count": 1,
            "over_limit": False,
            "status": None,
            "current_period_end": None,
            "cancel_at_period_end": False,
            "has_subscription": False,
            "reason": "billing_disabled",
        }

    async def test_it_reports_the_subscription_a_status_screen_needs(self, app, billing_on):
        renews = datetime(2026, 9, 30, 12, 0, tzinfo=UTC)
        async with get_sessionmaker()() as session:
            user = await _user(session, "state-subscribed@example.com")
            await _subscribe(
                session,
                user,
                tier="legion",
                status="past_due",
                host_limit=20,
                current_period_end=renews,
                cancel_at_period_end=True,
            )

            state = await billing.billing_state(session, user)

        assert state["tier"] == "legion"
        assert state["tier_name"] == "the Legion plan"
        assert state["host_limit"] == 20
        assert state["status"] == "past_due"
        assert state["cancel_at_period_end"] is True
        assert state["has_subscription"] is True
        assert state["reason"] == "subscription"
        assert state["current_period_end"].startswith("2026-09-30T12:00:00")

    async def test_over_limit_is_reachable_without_anyone_doing_anything_wrong(
        self, app, billing_on
    ):
        """A downgrade is always allowed, so an account can sit above its limit
        until it sheds hosts. That is a state to display, not an error."""
        async with get_sessionmaker()() as session:
            user = await _user(session, "over-limit@example.com")
            for index in range(3):
                session.add(Host(owner_user_id=user.id, name=f"host-{index}"))
            await session.flush()

            state = await billing.billing_state(session, user)

        assert (state["host_count"], state["host_limit"]) == (3, 1)
        assert state["over_limit"] is True


class TestTheErrorBodyIsMachineReadableOnly:
    """The mobile app renders server strings verbatim inside a binary that
    ships through app review, so the 402 body carries facts and no words."""

    def _detail(self, tier: str, host_limit: int | None, host_count: int) -> dict:
        return billing.limit_error_detail(
            billing.Decision(
                allowed=False,
                entitlement=billing.Entitlement(
                    tier=tier, host_limit=host_limit, reason="free"
                ),
                host_count=host_count,
            )
        )

    def test_it_is_the_documented_shape(self):
        assert self._detail("free", 1, 1) == {
            "code": "host_limit",
            "tier": "free",
            "host_limit": 1,
            "host_count": 1,
        }

    def test_an_unlimited_limit_is_null_not_a_sentinel(self):
        assert self._detail("pandemonium", None, 40)["host_limit"] is None

    @pytest.mark.parametrize(
        ("tier", "host_limit"),
        [("free", 1), ("coven", 3), ("legion", 20), ("pandemonium", None)],
    )
    def test_it_contains_no_url_no_price_and_no_purchase_verb(self, tier, host_limit):
        """A compliance bright line, not a style preference. Anything a person
        reads about paying is written by the client that shows it."""
        blob = json.dumps(self._detail(tier, host_limit, 99)).lower()
        for forbidden in (
            "http",
            "://",
            ".com",
            "$",
            "€",
            "£",
            "usd",
            "buy",
            "upgrade",
            "subscribe",
            "pay",
            "purchase",
            "price",
            "plan",
        ):
            assert forbidden not in blob, forbidden

    def test_every_value_is_a_machine_code_or_a_number(self):
        detail = self._detail("legion", 20, 21)
        assert detail["code"] == "host_limit"
        assert detail["tier"] in billing.TIER_ORDER
        assert isinstance(detail["host_count"], int)
        assert detail["host_limit"] is None or isinstance(detail["host_limit"], int)


class TestRefusingToBootHalfConfigured:
    def test_a_fully_configured_instance_boots(self):
        settings = _settings()
        assert settings.billing_enabled is True
        assert settings.stripe_price_legion == PRICE_LEGION

    def test_billing_off_needs_none_of_it(self):
        """The default, and the only state a self-hoster ever sees."""
        settings = Settings(_env_file=None, billing_enabled=False)
        assert settings.billing_enabled is False
        assert settings.stripe_webhook_secret is None

    def test_a_missing_webhook_secret_refuses_to_start(self):
        """An endpoint that cannot verify a signature is an unauthenticated
        "make me a paid subscriber" API."""
        with pytest.raises(InsecureConfigurationError) as raised:
            _settings(stripe_webhook_secret=None)
        assert "SPAWN_STRIPE_WEBHOOK_SECRET" in str(raised.value)

    @pytest.mark.parametrize(
        ("field", "variable"),
        [
            ("stripe_secret_key", "SPAWN_STRIPE_SECRET_KEY"),
            ("stripe_price_coven", "SPAWN_STRIPE_PRICE_COVEN"),
            ("stripe_price_legion", "SPAWN_STRIPE_PRICE_LEGION"),
            ("stripe_price_pandemonium", "SPAWN_STRIPE_PRICE_PANDEMONIUM"),
        ],
    )
    @pytest.mark.parametrize("missing", [None, ""])
    def test_a_half_configured_catalogue_refuses_to_start(self, field, variable, missing):
        with pytest.raises(InsecureConfigurationError) as raised:
            _settings(**{field: missing})
        assert variable in str(raised.value)

    def test_every_problem_is_reported_at_once(self):
        """One restart per missing value would be a miserable way to find out."""
        with pytest.raises(InsecureConfigurationError) as raised:
            _settings(
                stripe_secret_key=None,
                stripe_webhook_secret=None,
                stripe_price_coven=None,
                stripe_price_legion=None,
                stripe_price_pandemonium=None,
            )
        message = str(raised.value)
        for variable in (
            "SPAWN_STRIPE_SECRET_KEY",
            "SPAWN_STRIPE_WEBHOOK_SECRET",
            "SPAWN_STRIPE_PRICE_COVEN",
            "SPAWN_STRIPE_PRICE_LEGION",
            "SPAWN_STRIPE_PRICE_PANDEMONIUM",
        ):
            assert variable in message

    def test_the_guard_applies_on_a_laptop_too(self):
        """Unlike the development-defaults guard. Nothing about billing has a
        working default, so a half-done switch-on is wrong everywhere."""
        with pytest.raises(InsecureConfigurationError):
            _settings(public_url="http://localhost:8000", stripe_webhook_secret=None)


class TestTheReturnUrl:
    def test_an_explicit_value_wins(self):
        settings = _settings(
            billing_return_url="https://app.example.com/",
            web_url="https://web.example.com",
        )
        assert settings.billing_return_base == "https://app.example.com"

    def test_it_falls_back_to_the_web_app_then_the_server(self):
        assert (
            _settings(web_url="https://web.example.com/").billing_return_base
            == "https://web.example.com"
        )
        assert (
            _settings(web_url="", public_url="http://localhost:8000").billing_return_base
            == "http://localhost:8000"
        )
