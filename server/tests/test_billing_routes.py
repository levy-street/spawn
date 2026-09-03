"""`/api/billing` as HTTP: what it refuses, in what words, and to whom.

Three things are being held down here.

**Invisibility.** `SPAWN_BILLING_ENABLED` defaults false and a self-hosted
install must not have a discoverable billing API — not a 403, not an empty
catalogue, not a "billing is disabled" body. Every route 404s, the webhook
included.

**The client never names a price.** `/checkout` and `/change-plan` take a tier
name and the server maps it through its own config. A body carrying a price id
or an amount is refused outright rather than half-honoured, which is what
`extra="forbid"` buys.

**Nothing a person reads comes from here.** The mobile app renders
`ApiError.message` verbatim inside a binary that ships through app review, so
every refusal on this surface is a machine code and some numbers. The one
deliberate exception is the `url` field on `/checkout` and `/portal`, which is
Stripe's own hosted page and the entire point of the call.

No network: the Stripe double comes from `tests/test_stripe_webhook.py`, and it
is installed by replacing `billing_stripe._client`, the one place a real client
is ever built.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from spawn_server import billing, billing_stripe
from spawn_server.config import get_settings
from spawn_server.db import get_sessionmaker
from spawn_server.models import Host, Subscription, User
from tests.test_device import _signup
from tests.test_stripe_webhook import (
    PRICE_COVEN,
    PRICE_LEGION,
    PRICE_PANDEMONIUM,
    SECRET,
    STRIPE_ENV,
    _FakeStripe,
    _sign,
    _subscription_object,
)

# See the note in `test_billing.py`: no `pytest.mark.anyio` on top of
# `asyncio_mode = "auto"`, or the app's engine ends up on another event loop.


@pytest.fixture
def billing_on(monkeypatch):
    """A fully configured hosted instance, for one test.

    Declared here rather than imported, because a fixture imported by name and
    then shadowed by a test's own parameter is the kind of thing that works
    until somebody renames it.
    """
    for name, value in STRIPE_ENV.items():
        monkeypatch.setenv(name, value)
    get_settings.cache_clear()  # type: ignore[attr-defined]
    yield
    get_settings.cache_clear()  # type: ignore[attr-defined]


@pytest.fixture
def fake_stripe(monkeypatch):
    """A Stripe that answers from a dict, installed at the one place a real
    client is ever built. Nothing in this file can reach the network."""
    api = _FakeStripe()
    monkeypatch.setattr(billing_stripe, "_client", lambda settings=None: api)
    return api

#: Every path under the prefix, so "billing is invisible" is asserted against
#: the whole surface rather than a sample of it.
EVERY_ROUTE = (
    ("GET", "/api/billing/state"),
    ("POST", "/api/billing/checkout"),
    ("POST", "/api/billing/portal"),
    ("POST", "/api/billing/change-plan"),
    ("POST", "/api/billing/upgrade"),
    ("POST", "/api/billing/webhook"),
    ("POST", "/api/billing/webhook/"),
)

#: Apple polices the verb, not the link, so a declarative sentence with a price
#: in it fails as hard as a button would. Same list as
#: `tests/test_billing_enforcement.py`, because it is the same bright line.
FORBIDDEN_WORDS = ("buy", "upgrade", "subscribe", "pay", "purchase", "checkout")


def _assert_no_purchase_copy(text: str) -> None:
    lowered = text.lower()
    assert "http://" not in lowered, text
    assert "https://" not in lowered, text
    assert "://" not in lowered, text
    assert "$" not in text, text
    assert "spawnd.dev" not in lowered, text
    for word in FORBIDDEN_WORDS:
        assert word not in lowered, (word, text)


async def _entitlement(user_id: str):
    async with get_sessionmaker()() as session:
        user = await session.get(User, user_id)
        assert user is not None
        return await billing.entitlement(session, user)


async def _row_in(session, user_id: str) -> Subscription:
    row = (
        await session.execute(select(Subscription).where(Subscription.user_id == user_id))
    ).scalar_one_or_none()
    assert row is not None
    return row


async def _row(user_id: str) -> Subscription | None:
    async with get_sessionmaker()() as session:
        return (
            await session.execute(
                select(Subscription).where(Subscription.user_id == user_id)
            )
        ).scalar_one_or_none()


async def _subscribe(
    user_id: str,
    *,
    tier: str = billing.TIER_LEGION,
    status: str = "active",
    subscription_id: str | None = "sub_routes",
    customer: str = "cus_routes",
) -> None:
    async with get_sessionmaker()() as session:
        session.add(
            Subscription(
                user_id=user_id,
                stripe_customer_id=customer,
                stripe_subscription_id=subscription_id,
                tier=tier,
                status=status,
                host_limit=billing.host_limit_for_tier(tier),
            )
        )
        await session.commit()


async def _give_hosts(user_id: str, count: int) -> list[str]:
    """Hosts straight through the ORM, on purpose.

    What is under test here is the route's precondition arithmetic against
    `billing.host_count`, not the pairing ceremony — that has its own coverage
    in `tests/test_billing_enforcement.py`, which drives the real four-step
    flow because the gate it tests lives inside it. Releasing them below still
    goes through the real `DELETE /api/hosts/{id}`.
    """
    ids: list[str] = []
    async with get_sessionmaker()() as session:
        for index in range(count):
            host = Host(owner_user_id=user_id, name=f"box-{index}")
            session.add(host)
            await session.flush()
            ids.append(host.id)
        await session.commit()
    return ids


# ---------- billing off: nothing exists ----------


class TestABillingFreeDeploymentHasNoBillingApi:
    @pytest.mark.parametrize(("method", "path"), EVERY_ROUTE)
    async def test_every_route_is_404(self, client, method, path):
        response = await client.request(method, path, json={"tier": "coven"})
        assert response.status_code == 404, (path, response.status_code, response.text)

    async def test_the_404_says_nothing_about_billing(self, client):
        response = await client.get("/api/billing/state")
        assert response.status_code == 404
        assert "billing" not in response.text.lower(), response.text
        _assert_no_purchase_copy(response.text)

    async def test_a_signed_webhook_is_refused_too(self, client):
        """A deployment with no Stripe account has no business accepting events
        for one, however well signed."""
        payload = json.dumps(
            {
                "id": "evt_off",
                "type": "customer.subscription.created",
                "created": 0,
                "data": {"object": {"id": "sub_x"}},
            }
        ).encode()
        response = await client.post(
            "/api/billing/webhook",
            content=payload,
            headers={"stripe-signature": _sign(payload, SECRET)},
        )
        assert response.status_code == 404, response.text

    async def test_it_is_absent_from_the_published_schema(self, client):
        """`/openapi.json` is unauthenticated and is built from the registered
        routes, so a schema entry is an advertisement no per-request dependency
        can withdraw. The whole router is `include_in_schema=False`."""
        schema = (await client.get("/openapi.json")).json()
        assert not [path for path in schema["paths"] if path.startswith("/api/billing")]


# ---------- /state ----------


class TestState:
    async def test_it_needs_a_session(self, client, billing_on, fake_stripe):
        # An explicit bad bearer rather than no header at all: the shared test
        # client keeps the session cookie a signup sets, so "send nothing" is
        # not the same as "not signed in".
        response = await client.get(
            "/api/billing/state", headers={"Authorization": "Bearer not-a-token"}
        )
        assert response.status_code == 401, response.text

    async def test_a_free_account_reads_the_free_plan_and_the_whole_catalogue(
        self, client, billing_on, fake_stripe
    ):
        _, auth = await _signup(client, "state-free@example.com")
        response = await client.get("/api/billing/state", headers=auth)
        assert response.status_code == 200, response.text
        body = response.json()

        assert body["tier"] == "free"
        assert body["tier_name"] == "Free"
        assert body["host_limit"] == 1
        assert body["host_count"] == 0
        assert body["over_limit"] is False
        assert body["status"] is None
        assert body["current_period_end"] is None
        assert body["cancel_at_period_end"] is False
        assert body["has_subscription"] is False
        assert body["reason"] == "free"
        assert [tier["key"] for tier in body["tiers"]] == list(billing.TIER_ORDER)
        # Cheapest first, so no client ever sorts the catalogue itself.
        prices = [tier["price_cents"] for tier in body["tiers"]]
        assert prices == sorted(prices)

    async def test_it_reports_a_subscription_and_never_writes_one(
        self, client, billing_on, fake_stripe
    ):
        user_id, auth = await _signup(client, "state-paid@example.com")
        await _subscribe(user_id, tier=billing.TIER_LEGION)
        await _give_hosts(user_id, 2)

        body = (await client.get("/api/billing/state", headers=auth)).json()
        assert body["tier"] == "legion"
        assert body["tier_name"] == "Legion"
        assert body["host_limit"] == 20
        assert body["host_count"] == 2
        assert body["has_subscription"] is True
        assert body["reason"] == "subscription"
        # A read, and no Stripe call: this is on every settings screen and must
        # not be able to be slow or to fail.
        assert fake_stripe.calls == []

    async def test_the_legion_plan_is_never_written_bare(
        self, client, billing_on, fake_stripe
    ):
        _, auth = await _signup(client, "state-name@example.com")
        body = (await client.get("/api/billing/state", headers=auth)).json()
        names = {tier["key"]: tier["name"] for tier in body["tiers"]}
        assert names["legion"] == "Legion"


# ---------- /checkout ----------


class TestCheckout:
    async def test_it_maps_a_tier_name_to_the_configured_price(
        self, client, billing_on, fake_stripe
    ):
        user_id, auth = await _signup(client, "checkout-map@example.com")
        response = await client.post(
            "/api/billing/checkout", json={"tier": "legion"}, headers=auth
        )
        assert response.status_code == 200, response.text
        assert response.json() == {"url": fake_stripe.checkout_url}

        created = fake_stripe.named("checkout.sessions.create")[0]
        assert created["line_items"] == [{"price": PRICE_LEGION, "quantity": 1}]
        assert created["mode"] == "subscription"
        # Both bindings. The first is on the Session; the second rides onto the
        # Subscription, so later events carry it without a Session lookup.
        assert created["client_reference_id"] == user_id
        assert created["subscription_data"]["metadata"]["spawn_user_id"] == user_id
        # Back into the product, never the marketing root, with a flag the app
        # turns into "where you were, with the plan panel open".
        assert created["success_url"].endswith("/app?billing=complete")
        assert created["cancel_url"].endswith("/app?billing=cancelled")

    @pytest.mark.parametrize(
        "body",
        [
            {"tier": "coven", "price_id": PRICE_PANDEMONIUM},
            {"tier": "coven", "price": PRICE_PANDEMONIUM},
            {"tier": "coven", "amount": 1},
            {"tier": "coven", "quantity": 40},
            {"price_id": PRICE_COVEN},
        ],
        ids=["price_id", "price", "amount", "quantity", "price-only"],
    )
    async def test_a_body_that_names_money_is_refused_outright(
        self, client, billing_on, fake_stripe, body
    ):
        """`extra="forbid"` rather than "ignored unknown keys".

        A caller who could name a price could name a $0 one, and a body that is
        merely *not read* is one refactor away from being read."""
        _, auth = await _signup(client, f"forbid-{sorted(body)[0]}@example.com")
        response = await client.post("/api/billing/checkout", json=body, headers=auth)
        assert response.status_code == 422, response.text
        assert fake_stripe.named("checkout.sessions.create") == []

    @pytest.mark.parametrize("tier", ["free", "pandemonium ", "Legion", "", "enterprise"])
    async def test_an_unknown_tier_is_refused(self, client, billing_on, fake_stripe, tier):
        """Free included: leaving a plan is a cancellation, not a purchase of
        nothing, and there is no Checkout Session for it."""
        _, auth = await _signup(client, f"tier-{abs(hash(tier))}@example.com")
        response = await client.post(
            "/api/billing/checkout", json={"tier": tier}, headers=auth
        )
        assert response.status_code == 422, response.text
        assert fake_stripe.named("checkout.sessions.create") == []

    async def test_an_existing_subscription_is_a_409_not_a_second_one(
        self, client, billing_on, fake_stripe
    ):
        """Two live subscriptions on one account is a double charge and a
        support incident. The code points the client at `/change-plan`."""
        user_id, auth = await _signup(client, "checkout-twice@example.com")
        await _subscribe(user_id, tier=billing.TIER_COVEN)

        response = await client.post(
            "/api/billing/checkout", json={"tier": "legion"}, headers=auth
        )
        assert response.status_code == 409, response.text
        assert response.json()["detail"]["code"] == "subscription_exists"
        assert fake_stripe.named("checkout.sessions.create") == []
        _assert_no_purchase_copy(response.text)

    @pytest.mark.parametrize("status", ["canceled", "unpaid", "incomplete"])
    async def test_a_finished_subscription_is_not_in_the_way(
        self, client, billing_on, fake_stripe, status
    ):
        """The row survives cancellation so the customer id is stable across a
        resubscribe. It must not become a permanent refusal."""
        user_id, auth = await _signup(client, f"resub-{status}@example.com")
        await _subscribe(user_id, tier=billing.TIER_COVEN, status=status)

        response = await client.post(
            "/api/billing/checkout", json={"tier": "coven"}, headers=auth
        )
        assert response.status_code == 200, response.text
        # The existing customer is reused rather than a second one created —
        # a second Customer splits the invoice history and breaks the portal.
        assert fake_stripe.named("customers.create") == []
        assert fake_stripe.named("checkout.sessions.create")[0]["customer"] == "cus_routes"

    async def test_it_creates_one_customer_and_reuses_it(
        self, client, billing_on, fake_stripe
    ):
        user_id, auth = await _signup(client, "one-customer@example.com")
        for _ in range(3):
            assert (
                await client.post(
                    "/api/billing/checkout", json={"tier": "coven"}, headers=auth
                )
            ).status_code == 200
        assert len(fake_stripe.named("customers.create")) == 1

        row = await _row(user_id)
        assert row is not None
        # A Customer is not a subscription: an abandoned Checkout leaves the
        # account entitled to exactly what it was entitled to before.
        assert row.tier == billing.TIER_FREE
        assert row.status == "incomplete"
        assert (await _entitlement(user_id)).host_limit == 1


# ---------- /portal ----------


class TestUpgrade:
    async def test_it_returns_the_stripe_page_that_confirms_and_charges(
        self, client, billing_on, fake_stripe
    ):
        """A move up is confirmed and paid on Stripe's own page: nothing
        changes on our side until the webhook says it did."""
        user_id, auth = await _signup(client, "upgrade@example.com")
        await _subscribe(user_id, tier=billing.TIER_COVEN)
        fake_stripe.subscriptions["sub_routes"] = _stripe_subscription(
            user_id, price=PRICE_COVEN
        )

        response = await client.post(
            "/api/billing/upgrade", json={"tier": "legion"}, headers=auth
        )
        assert response.status_code == 200, response.text
        assert response.json() == {"url": fake_stripe.portal_url}

        created = fake_stripe.named("billing_portal.sessions.create")[0]
        assert created["customer"] == "cus_routes"
        assert created["configuration"] == "bpc_test_upgrade"
        flow = created["flow_data"]
        assert flow["type"] == "subscription_update_confirm"
        assert flow["subscription_update_confirm"]["subscription"] == "sub_routes"
        assert flow["subscription_update_confirm"]["items"] == [
            {"id": "si_test", "price": PRICE_LEGION, "quantity": 1}
        ]
        assert flow["after_completion"]["redirect"]["return_url"].endswith(
            "/app?billing=complete"
        )
        assert created["return_url"].endswith("/app?billing=cancelled")
        # Nothing moved: the row is what it was, and no update was sent.
        assert fake_stripe.named("subscriptions.update") == []
        assert (await _entitlement(user_id)).tier == billing.TIER_COVEN

    async def test_it_runs_the_same_host_precondition_as_change_plan(
        self, client, billing_on, fake_stripe
    ):
        """Not a way around the host-selection step: a target that would not
        hold what the account has is refused here too."""
        user_id, auth = await _signup(client, "upgrade-over@example.com")
        await _subscribe(user_id, tier=billing.TIER_PANDEMONIUM)
        fake_stripe.subscriptions["sub_routes"] = _stripe_subscription(
            user_id, price=PRICE_PANDEMONIUM
        )
        await _give_hosts(user_id, 25)

        response = await client.post(
            "/api/billing/upgrade", json={"tier": "legion"}, headers=auth
        )
        assert response.status_code == 409, response.text
        assert response.json()["detail"]["code"] == "host_selection_required"
        assert fake_stripe.named("billing_portal.sessions.create") == []

    async def test_it_needs_a_subscription_to_move(self, client, billing_on, fake_stripe):
        _, auth = await _signup(client, "upgrade-none@example.com")
        response = await client.post(
            "/api/billing/upgrade", json={"tier": "legion"}, headers=auth
        )
        assert response.status_code == 409, response.text
        assert response.json()["detail"] == {"code": "subscription_required"}


class TestPortal:
    async def test_it_returns_a_portal_url(self, client, billing_on, fake_stripe):
        user_id, auth = await _signup(client, "portal@example.com")
        await _subscribe(user_id, tier=billing.TIER_COVEN)

        response = await client.post("/api/billing/portal", headers=auth)
        assert response.status_code == 200, response.text
        assert response.json() == {"url": fake_stripe.portal_url}
        created = fake_stripe.named("billing_portal.sessions.create")[0]
        assert created["customer"] == "cus_routes"
        assert created["return_url"].endswith("/app?billing=portal")

    async def test_it_needs_a_session(self, client, billing_on, fake_stripe):
        response = await client.post(
            "/api/billing/portal", headers={"Authorization": "Bearer not-a-token"}
        )
        assert response.status_code == 401, response.text


# ---------- /change-plan ----------


class TestChangePlan:
    async def test_an_upgrade_moves_the_price_immediately_with_prorations(
        self, client, billing_on, fake_stripe
    ):
        user_id, auth = await _signup(client, "upgrade@example.com")
        await _subscribe(user_id, tier=billing.TIER_COVEN)
        fake_stripe.subscriptions["sub_routes"] = _stripe_subscription(
            user_id, price=PRICE_COVEN
        )

        response = await client.post(
            "/api/billing/change-plan", json={"tier": "legion"}, headers=auth
        )
        assert response.status_code == 200, response.text
        assert response.json()["tier"] == "legion"
        assert response.json()["host_limit"] == 20

        _, params = fake_stripe.named("subscriptions.update")[0]
        assert params["items"] == [{"id": "si_test", "price": PRICE_LEGION}]
        assert params["proration_behavior"] == "create_prorations"
        # Never scheduled: a subscription with a scheduled update cannot be
        # updated or cancelled by the customer for up to a month.
        assert "schedule_at_period_end" not in params
        assert (await _entitlement(user_id)).host_limit == 20

    async def test_a_downgrade_over_the_target_limit_is_409_and_changes_nothing(
        self, client, billing_on, fake_stripe
    ):
        user_id, auth = await _signup(client, "downgrade@example.com")
        await _subscribe(user_id, tier=billing.TIER_LEGION)
        fake_stripe.subscriptions["sub_routes"] = _stripe_subscription(
            user_id, price=PRICE_LEGION
        )
        await _give_hosts(user_id, 5)

        response = await client.post(
            "/api/billing/change-plan", json={"tier": "coven"}, headers=auth
        )
        assert response.status_code == 409, response.text
        assert response.json()["detail"] == {
            "code": "host_selection_required",
            "tier": "coven",
            "host_limit": 3,
            "host_count": 5,
        }
        # The server never releases a host on a billing signal, and it did not
        # move the plan either: they are still on what they were paying for.
        assert fake_stripe.named("subscriptions.update") == []
        assert (await _entitlement(user_id)).host_limit == 20
        _assert_no_purchase_copy(response.text)

    async def test_it_applies_right_after_an_evented_cancellation(
        self, client, billing_on, fake_stripe
    ):
        """The row was last written by a webhook, whose clock is later than any
        stamp the subscription object carries. A change we make ourselves is
        as fresh as reads get, and must not lose to that clock — the client
        renders the response, and the response has to be the new plan."""
        user_id, auth = await _signup(client, "fresh-change@example.com")
        await _subscribe(user_id, tier=billing.TIER_LEGION)
        async with get_sessionmaker()() as session:
            row = await _row_in(session, user_id)
            row.last_event_at = datetime.now(UTC)
            await session.commit()
        fake_stripe.subscriptions["sub_routes"] = _stripe_subscription(
            user_id, price=PRICE_LEGION
        )

        response = await client.post(
            "/api/billing/change-plan", json={"tier": "coven"}, headers=auth
        )
        assert response.status_code == 200, response.text
        assert response.json()["tier"] == "coven"
        assert (await _entitlement(user_id)).tier == billing.TIER_COVEN

    async def test_it_succeeds_once_the_user_has_released_hosts(
        self, client, billing_on, fake_stripe
    ):
        """The release goes first, through the ordinary host-delete path. A
        payment that then fails leaves them on the old plan with fewer hosts —
        recoverable and honest, rather than on a cheaper plan while over its
        limit."""
        user_id, auth = await _signup(client, "released@example.com")
        await _subscribe(user_id, tier=billing.TIER_LEGION)
        fake_stripe.subscriptions["sub_routes"] = _stripe_subscription(
            user_id, price=PRICE_LEGION
        )
        host_ids = await _give_hosts(user_id, 5)

        for host_id in host_ids[:2]:
            released = await client.delete(f"/api/hosts/{host_id}", headers=auth)
            assert released.status_code == 204, released.text

        response = await client.post(
            "/api/billing/change-plan", json={"tier": "coven"}, headers=auth
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["tier"] == "coven"
        assert body["host_limit"] == 3
        assert body["host_count"] == 3
        assert body["over_limit"] is False

    async def test_exactly_at_the_target_limit_is_allowed(
        self, client, billing_on, fake_stripe
    ):
        user_id, auth = await _signup(client, "exactly@example.com")
        await _subscribe(user_id, tier=billing.TIER_LEGION)
        fake_stripe.subscriptions["sub_routes"] = _stripe_subscription(
            user_id, price=PRICE_LEGION
        )
        await _give_hosts(user_id, 3)

        response = await client.post(
            "/api/billing/change-plan", json={"tier": "coven"}, headers=auth
        )
        assert response.status_code == 200, response.text

    async def test_moving_to_the_unlimited_tier_is_never_blocked(
        self, client, billing_on, fake_stripe
    ):
        user_id, auth = await _signup(client, "unlimited@example.com")
        await _subscribe(user_id, tier=billing.TIER_COVEN)
        fake_stripe.subscriptions["sub_routes"] = _stripe_subscription(
            user_id, price=PRICE_COVEN
        )
        await _give_hosts(user_id, 40)

        response = await client.post(
            "/api/billing/change-plan", json={"tier": "pandemonium"}, headers=auth
        )
        assert response.status_code == 200, response.text
        assert response.json()["host_limit"] is None

    async def test_an_account_with_nothing_to_change_is_409(
        self, client, billing_on, fake_stripe
    ):
        _, auth = await _signup(client, "nothing@example.com")
        response = await client.post(
            "/api/billing/change-plan", json={"tier": "coven"}, headers=auth
        )
        assert response.status_code == 409, response.text
        assert response.json()["detail"] == {"code": "subscription_required"}
        _assert_no_purchase_copy(response.text)

    async def test_a_body_that_names_money_is_refused(
        self, client, billing_on, fake_stripe
    ):
        user_id, auth = await _signup(client, "change-forbid@example.com")
        await _subscribe(user_id, tier=billing.TIER_COVEN)
        response = await client.post(
            "/api/billing/change-plan",
            json={"tier": "legion", "price_id": PRICE_PANDEMONIUM},
            headers=auth,
        )
        assert response.status_code == 422, response.text
        assert fake_stripe.named("subscriptions.update") == []


# ---------- Stripe is down ----------


class TestAnOutageIsNotAnEntitlementChange:
    async def test_checkout_is_a_503(self, client, billing_on, fake_stripe):
        _, auth = await _signup(client, "outage-checkout@example.com")
        fake_stripe.outage = True
        response = await client.post(
            "/api/billing/checkout", json={"tier": "coven"}, headers=auth
        )
        assert response.status_code == 503, response.text
        _assert_no_purchase_copy(response.text)

    async def test_portal_is_a_503(self, client, billing_on, fake_stripe):
        user_id, auth = await _signup(client, "outage-portal@example.com")
        await _subscribe(user_id, tier=billing.TIER_COVEN)
        fake_stripe.outage = True
        response = await client.post("/api/billing/portal", headers=auth)
        assert response.status_code == 503, response.text
        _assert_no_purchase_copy(response.text)

    async def test_change_plan_is_a_503_and_leaves_the_plan_alone(
        self, client, billing_on, fake_stripe
    ):
        user_id, auth = await _signup(client, "outage-change@example.com")
        await _subscribe(user_id, tier=billing.TIER_COVEN)
        fake_stripe.subscriptions["sub_routes"] = _stripe_subscription(
            user_id, price=PRICE_COVEN
        )
        fake_stripe.outage = True

        response = await client.post(
            "/api/billing/change-plan", json={"tier": "pandemonium"}, headers=auth
        )
        assert response.status_code == 503, response.text
        _assert_no_purchase_copy(response.text)
        # Still on what they were paying for, and still entitled to it.
        assert (await _entitlement(user_id)).host_limit == 3

    async def test_entitlement_still_resolves_from_our_own_tables(
        self, client, billing_on, fake_stripe
    ):
        """A gate nobody can pass is an outage, not a control. Stripe being
        down is not evidence that anybody stopped paying."""
        user_id, auth = await _signup(client, "outage-state@example.com")
        await _subscribe(user_id, tier=billing.TIER_PANDEMONIUM)
        fake_stripe.outage = True

        state = await client.get("/api/billing/state", headers=auth)
        assert state.status_code == 200, state.text
        assert state.json()["host_limit"] is None
        assert (await _entitlement(user_id)).host_limit is None


# ---------- the words ----------


class TestNoRefusalOnThisSurfaceCarriesCopy:
    async def test_every_error_body_is_machine_readable_only(
        self, client, billing_on, fake_stripe
    ):
        """Collected in one place so a new refusal has to be added here to be
        forgotten, rather than merely written somewhere else."""
        user_id, auth = await _signup(client, "words@example.com")
        await _subscribe(user_id, tier=billing.TIER_LEGION)
        fake_stripe.subscriptions["sub_routes"] = _stripe_subscription(
            user_id, price=PRICE_LEGION
        )
        await _give_hosts(user_id, 8)

        other_id, other_auth = await _signup(client, "words-two@example.com")

        refusals = [
            # 401: not signed in.
            await client.get(
                "/api/billing/state", headers={"Authorization": "Bearer not-a-token"}
            ),
            # 409: already subscribed.
            await client.post(
                "/api/billing/checkout", json={"tier": "coven"}, headers=auth
            ),
            # 409: over the target limit.
            await client.post(
                "/api/billing/change-plan", json={"tier": "coven"}, headers=auth
            ),
            # 409: nothing to change.
            await client.post(
                "/api/billing/change-plan", json={"tier": "coven"}, headers=other_auth
            ),
            # 422: an unknown tier.
            await client.post(
                "/api/billing/checkout", json={"tier": "enterprise"}, headers=other_auth
            ),
            # 400: an unsigned webhook.
            await client.post("/api/billing/webhook", content=b"{}"),
        ]
        assert [r.status_code for r in refusals] == [401, 409, 409, 409, 422, 400]
        for response in refusals:
            _assert_no_purchase_copy(response.text)

        fake_stripe.outage = True
        outage = await client.post("/api/billing/portal", headers=other_auth)
        assert outage.status_code == 503
        _assert_no_purchase_copy(outage.text)

    async def test_the_only_urls_are_the_two_stripe_pages(
        self, client, billing_on, fake_stripe
    ):
        """`/checkout` and `/portal` return a Stripe-hosted URL because that is
        the entire point of the call. Nothing else on this surface may."""
        _, auth = await _signup(client, "urls@example.com")

        checkout = await client.post(
            "/api/billing/checkout", json={"tier": "coven"}, headers=auth
        )
        assert checkout.json().keys() == {"url"}
        assert checkout.json()["url"].startswith("https://")

        portal = await client.post("/api/billing/portal", headers=auth)
        assert portal.json().keys() == {"url"}
        assert portal.json()["url"].startswith("https://")

        # And the one read every surface uses carries none.
        _assert_no_purchase_copy((await client.get("/api/billing/state", headers=auth)).text)


# ---------- rate limits ----------


class TestPerUserRateLimits:
    async def test_checkout_is_capped_per_account(self, client, monkeypatch, fake_stripe):
        """Bucketed on the account id rather than an address behind a proxy:
        these are all authenticated, and `enforce_identifier` exists for
        exactly that."""
        from spawn_server.routes import billing as billing_routes

        for name, value in {
            "SPAWN_BILLING_ENABLED": "true",
            "SPAWN_STRIPE_SECRET_KEY": "sk_test_rl",
            "SPAWN_STRIPE_WEBHOOK_SECRET": "whsec_rl",
            "SPAWN_STRIPE_PRICE_COVEN": PRICE_COVEN,
            "SPAWN_STRIPE_PRICE_LEGION": PRICE_LEGION,
            "SPAWN_STRIPE_PRICE_PANDEMONIUM": PRICE_PANDEMONIUM,
            "SPAWN_STRIPE_PORTAL_UPGRADE_CONFIGURATION": "bpc_test_upgrade",
            "SPAWN_RATE_LIMIT_ENABLED": "true",
        }.items():
            monkeypatch.setenv(name, value)
        get_settings.cache_clear()  # type: ignore[attr-defined]
        try:
            _, mine = await _signup(client, "rl-mine@example.com")
            _, theirs = await _signup(client, "rl-theirs@example.com")

            limit = billing_routes.CHECKOUT.limit
            for _ in range(limit):
                assert (
                    await client.post(
                        "/api/billing/checkout", json={"tier": "coven"}, headers=mine
                    )
                ).status_code == 200
            over = await client.post(
                "/api/billing/checkout", json={"tier": "coven"}, headers=mine
            )
            assert over.status_code == 429, over.text
            _assert_no_purchase_copy(over.text)

            # One account's bucket is its own.
            assert (
                await client.post(
                    "/api/billing/checkout", json={"tier": "coven"}, headers=theirs
                )
            ).status_code == 200
        finally:
            get_settings.cache_clear()  # type: ignore[attr-defined]


def _stripe_subscription(user_id: str, *, price: str) -> dict:
    return _subscription_object(
        subscription_id="sub_routes",
        customer="cus_routes",
        spawn_user_id=user_id,
        price=price,
    )
