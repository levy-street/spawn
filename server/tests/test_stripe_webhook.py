"""The webhook: the only path in this server that grants a paid tier.

Nothing here opens a socket. Signatures are built locally with `hmac`, exactly
the way Stripe builds them, and every Stripe read is answered from a dict by
`_FakeStripe` — injected by replacing `billing_stripe._client`, which is the
single place a real `StripeClient` is ever constructed.

What is pinned down here is the set of things that are cheap to get wrong and
expensive to notice:

- a payload that is re-serialised before verification (it isn't: the handler
  reads `await request.body()` and declares no Pydantic model);
- a redelivery applied twice, or a retry deduped into a no-op by our own record
  of having failed;
- a delta applied from the payload, which is wrong under Stripe's unordered
  delivery — everything here re-fetches and writes the whole state;
- a tier read from the event's own `price.metadata`, which is a dashboard
  setting rather than an authority;
- the `success_url` treated as proof of payment, which is the classic way to
  give a paid tier away;
- a status code that asks Stripe for the wrong thing: a retry we do not want,
  or none where we do.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import time
from datetime import UTC, datetime

import pytest
import pytest_asyncio
import stripe

from spawn_server import billing, billing_stripe
from spawn_server.config import get_settings
from spawn_server.db import get_sessionmaker
from spawn_server.models import Host, StripeEvent, Subscription, User
from tests.test_device import _signup

# Deliberately no `pytestmark = pytest.mark.anyio` — `asyncio_mode = "auto"`
# already runs these, and adding the mark puts the test in one event loop and
# the `app` fixture's engine in another. See the note in `test_billing.py`.

PRICE_COVEN = "price_test_coven"
PRICE_LEGION = "price_test_legion"
PRICE_PANDEMONIUM = "price_test_pandemonium"

SECRET = "whsec_primary"
SECOND_SECRET = "whsec_rotated_in"

STRIPE_ENV = {
    "SPAWN_BILLING_ENABLED": "true",
    "SPAWN_STRIPE_SECRET_KEY": "sk_test_webhook",
    # Two, comma separated, because rotation is the state this has to survive:
    # for up to 24 hours Stripe signs with both and sends both in one header.
    "SPAWN_STRIPE_WEBHOOK_SECRET": f"{SECRET},{SECOND_SECRET}",
    "SPAWN_STRIPE_PRICE_COVEN": PRICE_COVEN,
    "SPAWN_STRIPE_PRICE_LEGION": PRICE_LEGION,
    "SPAWN_STRIPE_PRICE_PANDEMONIUM": PRICE_PANDEMONIUM,
    "SPAWN_STRIPE_PORTAL_UPGRADE_CONFIGURATION": "bpc_test_upgrade",
}

WEBHOOK = "/api/billing/webhook"

# A fixed point in time, so period arithmetic in the fixtures is readable.
JAN = int(datetime(2026, 1, 1, tzinfo=UTC).timestamp())
FEB = int(datetime(2026, 2, 1, tzinfo=UTC).timestamp())
MAR = int(datetime(2026, 3, 1, tzinfo=UTC).timestamp())


@pytest.fixture
def billing_on(monkeypatch):
    for name, value in STRIPE_ENV.items():
        monkeypatch.setenv(name, value)
    get_settings.cache_clear()  # type: ignore[attr-defined]
    yield
    get_settings.cache_clear()  # type: ignore[attr-defined]


# ---------- a Stripe that is a dict ----------


class _Resource:
    def __init__(self, api: _FakeStripe) -> None:
        self._api = api


class _Subscriptions(_Resource):
    def retrieve(self, subscription_id, params=None, options=None):
        self._api.record("subscriptions.retrieve", subscription_id)
        obj = self._api.subscriptions.get(subscription_id)
        if obj is None:
            # Built the way Stripe actually builds it. The `code` and the 404
            # are the whole difference between "retry this for three days" and
            # "this object is never coming back" — a fixture that omitted them
            # would let the handler classify a permanent miss as an outage and
            # no test would notice.
            raise stripe.InvalidRequestError(
                f"No such subscription: {subscription_id}",
                "subscription",
                code="resource_missing",
                http_status=404,
            )
        return obj

    def update(self, subscription_id, params=None, options=None):
        self._api.record("subscriptions.update", (subscription_id, params))
        obj = self._api.subscriptions[subscription_id]
        params = params or {}
        price = params.get("items", [{}])[0].get("price")
        if price:
            obj["items"]["data"][0]["price"]["id"] = price
        # The two spellings of "stop ending": an empty string clears
        # `cancel_at`, false clears the older boolean. Both clear `canceled_at`
        # too, as Stripe does when a scheduled cancellation is withdrawn.
        if params.get("cancel_at") == "" or params.get("cancel_at_period_end") is False:
            obj["cancel_at"] = None
            obj["cancel_at_period_end"] = False
            obj["canceled_at"] = None
        return obj

    def cancel(self, subscription_id, params=None, options=None):
        self._api.record("subscriptions.cancel", subscription_id)
        obj = self._api.subscriptions[subscription_id]
        obj["status"] = "canceled"
        return obj


class _Customers(_Resource):
    def create(self, params=None, options=None):
        self._api.record("customers.create", params)
        self._api.customer_serial += 1
        return {"id": f"cus_fake_{self._api.customer_serial}", "object": "customer"}

    def delete(self, customer_id, params=None, options=None):
        self._api.record("customers.delete", customer_id)
        return {"id": customer_id, "deleted": True}


class _CheckoutSessions(_Resource):
    def create(self, params=None, options=None):
        self._api.record("checkout.sessions.create", params)
        return {"id": "cs_fake", "object": "checkout.session", "url": self._api.checkout_url}


class _PortalSessions(_Resource):
    def create(self, params=None, options=None):
        self._api.record("billing_portal.sessions.create", params)
        return {"id": "bps_fake", "object": "billing_portal.session", "url": self._api.portal_url}


class _V1:
    def __init__(self, api: _FakeStripe) -> None:
        self.subscriptions = _Subscriptions(api)
        self.customers = _Customers(api)
        self.checkout = type("_Checkout", (), {"sessions": _CheckoutSessions(api)})()
        self.billing_portal = type(
            "_BillingPortal", (), {"sessions": _PortalSessions(api)}
        )()


class _FakeStripe:
    """Everything Stripe is asked for, answered from memory.

    `outage` flips every call to the failure the SDK raises when it cannot
    reach the API, so the 503 and 500 paths are exercised through the same
    `except` clauses production uses rather than a bespoke sentinel.
    """

    def __init__(self, subscriptions: dict | None = None) -> None:
        self.subscriptions = dict(subscriptions or {})
        self.outage = False
        self.calls: list[tuple[str, object]] = []
        self.customer_serial = 0
        self.checkout_url = "https://checkout.stripe.com/c/pay/cs_fake"
        self.portal_url = "https://billing.stripe.com/p/session/bps_fake"
        self.v1 = _V1(self)

    def record(self, name: str, payload: object) -> None:
        if self.outage:
            raise stripe.APIConnectionError("could not connect to Stripe")
        self.calls.append((name, payload))

    def named(self, name: str) -> list[object]:
        return [payload for called, payload in self.calls if called == name]


@pytest.fixture
def fake_stripe(monkeypatch):
    api = _FakeStripe()
    # `_client` is the one place a real `StripeClient` is built, so replacing
    # it is the whole of "this test cannot reach the network".
    monkeypatch.setattr(billing_stripe, "_client", lambda settings=None: api)
    return api


async def _drain_mail() -> None:
    """Let the fire-and-forget mail tasks finish before asserting on them."""
    from spawn_server.routes import billing as billing_routes

    for _ in range(20):
        pending = [task for task in billing_routes._mail_tasks if not task.done()]
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        await asyncio.sleep(0)


@pytest_asyncio.fixture(autouse=True)
async def _settle_billing_mail():
    """Let each test's fire-and-forget mail tasks finish before the next starts.

    Not tidiness. The suite's in-memory SQLite is a single shared connection, so
    a mail task's session and a test's session are the *same* transaction —
    a task committing or rolling back midway through a test's writes discards
    them. Production pools a connection per session and has no such coupling;
    this fixture is what keeps the test database behaving like it.
    """
    yield
    await _drain_mail()


# ---------- payload and signature construction ----------


def _sign(payload: bytes, secret: str, *, timestamp: int | None = None) -> str:
    """The `Stripe-Signature` header, built the way Stripe builds it."""
    stamp = int(time.time()) if timestamp is None else timestamp
    signed = f"{stamp}.".encode() + payload
    digest = hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()
    return f"t={stamp},v1={digest}"


def _subscription_object(
    *,
    subscription_id: str = "sub_test",
    customer: str = "cus_test",
    price: str = PRICE_COVEN,
    status: str = "active",
    spawn_user_id: str | None = None,
    created: int = JAN,
    period_start: int = JAN,
    period_end: int = FEB,
    canceled_at: int | None = None,
    ended_at: int | None = None,
    cancel_at_period_end: bool = False,
    cancel_at: int | None = None,
    price_metadata: dict | None = None,
) -> dict:
    return {
        "id": subscription_id,
        "object": "subscription",
        "customer": customer,
        "status": status,
        "created": created,
        "start_date": created,
        "canceled_at": canceled_at,
        "ended_at": ended_at,
        "cancel_at_period_end": cancel_at_period_end,
        "cancel_at": cancel_at,
        "metadata": {"spawn_user_id": spawn_user_id} if spawn_user_id else {},
        "items": {
            "object": "list",
            "data": [
                {
                    "id": "si_test",
                    "object": "subscription_item",
                    "price": {
                        "id": price,
                        "object": "price",
                        "metadata": price_metadata or {},
                    },
                    "current_period_start": period_start,
                    "current_period_end": period_end,
                }
            ],
        },
    }


def _event_bytes(
    event_type: str,
    obj: dict,
    *,
    event_id: str = "evt_test",
    created: int = JAN,
) -> bytes:
    return json.dumps(
        {
            "id": event_id,
            "object": "event",
            "api_version": billing_stripe.STRIPE_API_VERSION,
            "created": created,
            "type": event_type,
            "data": {"object": obj},
        }
    ).encode("utf-8")


async def _post(client, payload: bytes, *, secret: str = SECRET, timestamp: int | None = None):
    return await client.post(
        WEBHOOK,
        content=payload,
        headers={
            "stripe-signature": _sign(payload, secret, timestamp=timestamp),
            "content-type": "application/json",
        },
    )


# ---------- our side of the fixture ----------


async def _seed_customer(user_id: str, *, customer: str = "cus_test") -> None:
    """The row `ensure_customer` leaves behind: a Customer and nothing else."""
    async with get_sessionmaker()() as session:
        session.add(
            Subscription(
                user_id=user_id,
                stripe_customer_id=customer,
                tier=billing.TIER_FREE,
                status="incomplete",
                host_limit=1,
            )
        )
        await session.commit()


async def _row(user_id: str) -> Subscription | None:
    async with get_sessionmaker()() as session:
        user = await session.get(User, user_id)
        assert user is not None
        from sqlalchemy import select

        return (
            await session.execute(
                select(Subscription).where(Subscription.user_id == user_id)
            )
        ).scalar_one_or_none()


async def _entitlement(user_id: str):
    async with get_sessionmaker()() as session:
        user = await session.get(User, user_id)
        assert user is not None
        return await billing.entitlement(session, user)


# ---------- signatures ----------


class TestTheSignatureIsTheWholeOfTheAuthentication:
    async def test_a_locally_signed_event_is_accepted_and_applied(
        self, client, billing_on, fake_stripe
    ):
        user_id, _ = await _signup(client, "signed@example.com")
        await _seed_customer(user_id)
        subscription = _subscription_object(spawn_user_id=user_id)
        fake_stripe.subscriptions["sub_test"] = subscription

        response = await _post(
            client, _event_bytes("customer.subscription.created", subscription)
        )
        assert response.status_code == 200, response.text

        granted = await _entitlement(user_id)
        assert granted.tier == billing.TIER_COVEN
        assert granted.host_limit == 3

    async def test_a_bad_signature_is_400_and_grants_nothing(
        self, client, billing_on, fake_stripe
    ):
        user_id, _ = await _signup(client, "forged@example.com")
        await _seed_customer(user_id)
        subscription = _subscription_object(spawn_user_id=user_id)
        fake_stripe.subscriptions["sub_test"] = subscription
        payload = _event_bytes("customer.subscription.created", subscription)

        response = await client.post(
            WEBHOOK,
            content=payload,
            headers={"stripe-signature": _sign(payload, "whsec_not_ours")},
        )
        assert response.status_code == 400, response.text
        assert (await _entitlement(user_id)).tier == billing.TIER_FREE
        # Nothing was read from Stripe either — a forged event never gets that far.
        assert fake_stripe.named("subscriptions.retrieve") == []

    async def test_a_missing_signature_header_is_400(self, client, billing_on, fake_stripe):
        payload = _event_bytes(
            "customer.subscription.created", _subscription_object()
        )
        response = await client.post(WEBHOOK, content=payload)
        assert response.status_code == 400, response.text

    async def test_a_timestamp_outside_the_tolerance_is_400(
        self, client, billing_on, fake_stripe
    ):
        """A replayed capture is not an event. The timestamp is inside the HMAC,
        so an attacker cannot move it without the secret — the tolerance is what
        makes yesterday's genuine bytes worthless today."""
        user_id, _ = await _signup(client, "stale@example.com")
        await _seed_customer(user_id)
        subscription = _subscription_object(spawn_user_id=user_id)
        fake_stripe.subscriptions["sub_test"] = subscription

        response = await _post(
            client,
            _event_bytes("customer.subscription.created", subscription),
            timestamp=int(time.time()) - 86_400,
        )
        assert response.status_code == 400, response.text
        assert (await _entitlement(user_id)).tier == billing.TIER_FREE

    async def test_rotation_accepts_a_signature_from_the_second_secret(
        self, client, billing_on, fake_stripe
    ):
        """Zero-downtime rotation, which is the only reason this is a list.

        Stripe signs with every active secret for up to 24 hours. A server that
        knew only one of them would drop half the events for a day, and the
        half it dropped would be the half nobody was watching."""
        assert billing_stripe.webhook_secrets() == [SECRET, SECOND_SECRET]

        user_id, _ = await _signup(client, "rotated@example.com")
        await _seed_customer(user_id)
        subscription = _subscription_object(spawn_user_id=user_id, price=PRICE_LEGION)
        fake_stripe.subscriptions["sub_test"] = subscription

        response = await _post(
            client,
            _event_bytes("customer.subscription.created", subscription),
            secret=SECOND_SECRET,
        )
        assert response.status_code == 200, response.text
        assert (await _entitlement(user_id)).host_limit == 20


# ---------- idempotency and ordering ----------


class TestARedeliveryChangesNothing:
    async def test_a_replayed_event_id_is_a_no_op_and_still_200(
        self, client, billing_on, fake_stripe
    ):
        user_id, _ = await _signup(client, "replayed@example.com")
        await _seed_customer(user_id)
        subscription = _subscription_object(spawn_user_id=user_id)
        fake_stripe.subscriptions["sub_test"] = subscription
        payload = _event_bytes("customer.subscription.created", subscription)

        first = await _post(client, payload)
        assert first.status_code == 200, first.text
        reads = len(fake_stripe.named("subscriptions.retrieve"))

        second = await _post(client, payload)
        assert second.status_code == 200, second.text
        # Deduped before any work: the second delivery did not talk to Stripe.
        assert len(fake_stripe.named("subscriptions.retrieve")) == reads

        async with get_sessionmaker()() as session:
            assert await session.get(StripeEvent, "evt_test") is not None

    async def test_two_events_a_second_apart_are_not_confused_for_one(
        self, client, billing_on, fake_stripe
    ):
        """Dedupe is on `event.id`, never on `created`. Stripe records that in
        whole seconds and distinct events routinely share one."""
        user_id, _ = await _signup(client, "sametime@example.com")
        await _seed_customer(user_id)
        first = _subscription_object(spawn_user_id=user_id, price=PRICE_COVEN)
        fake_stripe.subscriptions["sub_test"] = first

        response = await _post(
            client,
            _event_bytes(
                "customer.subscription.created", first, event_id="evt_a", created=JAN
            ),
        )
        assert response.status_code == 200, response.text

        upgraded = _subscription_object(
            spawn_user_id=user_id, price=PRICE_LEGION, period_start=FEB, period_end=MAR
        )
        fake_stripe.subscriptions["sub_test"] = upgraded
        response = await _post(
            client,
            _event_bytes(
                "customer.subscription.updated", upgraded, event_id="evt_b", created=JAN
            ),
        )
        assert response.status_code == 200, response.text
        assert (await _entitlement(user_id)).host_limit == 20


class TestAScheduledCancellationIsRecordedHoweverStripeSpellsIt:
    async def test_the_portal_sets_cancel_at_and_leaves_the_old_flag_false(
        self, client, billing_on, fake_stripe
    ):
        """On the pinned API version a Customer Portal cancellation leaves
        `cancel_at_period_end` FALSE and sets `cancel_at` to the period end.
        That is still "entitled until then, and ending" — the panel has to say
        so, and nothing may be taken away before the date."""
        user_id, _ = await _signup(client, "cancel-at@example.com")
        await _seed_customer(user_id)
        ending = _subscription_object(
            spawn_user_id=user_id,
            status="active",
            period_start=JAN,
            period_end=FEB,
            canceled_at=JAN + 3600,
            cancel_at=FEB,
        )
        fake_stripe.subscriptions["sub_test"] = ending

        response = await _post(
            client, _event_bytes("customer.subscription.updated", ending)
        )
        assert response.status_code == 200, response.text

        row = await _row(user_id)
        assert row is not None
        assert row.status == "active"
        assert row.cancel_at_period_end is True
        assert billing_stripe._aware(row.current_period_end) == datetime.fromtimestamp(
            FEB, tz=UTC
        )
        assert (await _entitlement(user_id)).host_limit == 3

    async def test_an_earlier_cancel_at_is_the_date_the_person_sees(
        self, client, billing_on, fake_stripe
    ):
        """`cancel_at` can be any moment, not only the period end. The stored
        end is whichever comes first, because that is when access stops."""
        user_id, _ = await _signup(client, "cancel-at-early@example.com")
        await _seed_customer(user_id)
        mid = JAN + 15 * 86_400
        ending = _subscription_object(
            spawn_user_id=user_id,
            status="active",
            period_start=JAN,
            period_end=FEB,
            canceled_at=JAN + 3600,
            cancel_at=mid,
        )
        fake_stripe.subscriptions["sub_test"] = ending

        response = await _post(
            client, _event_bytes("customer.subscription.updated", ending)
        )
        assert response.status_code == 200, response.text

        row = await _row(user_id)
        assert row is not None
        assert row.cancel_at_period_end is True
        assert billing_stripe._aware(row.current_period_end) == datetime.fromtimestamp(
            mid, tz=UTC
        )


    async def test_resuming_from_the_portal_takes_the_cancellation_back(
        self, client, billing_on, fake_stripe
    ):
        """A resume clears `canceled_at` and `cancel_at`, so the object now
        carries an *older* set of stamps than the cancellation did. The event's
        own clock is what says it is newer, and the row has to follow it —
        otherwise an account that un-cancelled reads "ends on…" for ever."""
        user_id, _ = await _signup(client, "resume@example.com")
        await _seed_customer(user_id)
        ending = _subscription_object(
            spawn_user_id=user_id,
            status="active",
            period_start=JAN,
            period_end=FEB,
            canceled_at=JAN + 3600,
            cancel_at=FEB,
        )
        fake_stripe.subscriptions["sub_test"] = ending
        cancelled = await _post(
            client,
            _event_bytes(
                "customer.subscription.updated", ending, event_id="evt_c", created=JAN + 3600
            ),
        )
        assert cancelled.status_code == 200, cancelled.text
        row = await _row(user_id)
        assert row is not None and row.cancel_at_period_end is True

        resumed = _subscription_object(
            spawn_user_id=user_id, status="active", period_start=JAN, period_end=FEB
        )
        fake_stripe.subscriptions["sub_test"] = resumed
        response = await _post(
            client,
            _event_bytes(
                "customer.subscription.updated", resumed, event_id="evt_r", created=JAN + 7200
            ),
        )
        assert response.status_code == 200, response.text

        row = await _row(user_id)
        assert row is not None
        assert row.cancel_at_period_end is False
        assert billing_stripe._aware(row.current_period_end) == datetime.fromtimestamp(
            FEB, tz=UTC
        )

    async def test_reconciliation_lands_a_resume_whose_webhook_was_missed(
        self, client, billing_on, fake_stripe
    ):
        """The sweep reads the truth as of now, so it is never the stale side
        of the guard: a resume nobody told us about still arrives."""
        user_id, _ = await _signup(client, "resume-sweep@example.com")
        await _seed_customer(user_id)
        ending = _subscription_object(
            spawn_user_id=user_id,
            status="active",
            period_start=JAN,
            period_end=FEB,
            canceled_at=JAN + 3600,
            cancel_at=FEB,
        )
        fake_stripe.subscriptions["sub_test"] = ending
        cancelled = await _post(
            client,
            _event_bytes(
                "customer.subscription.updated", ending, event_id="evt_c2", created=JAN + 3600
            ),
        )
        assert cancelled.status_code == 200, cancelled.text

        fake_stripe.subscriptions["sub_test"] = _subscription_object(
            spawn_user_id=user_id, status="active", period_start=JAN, period_end=FEB
        )
        assert await billing_stripe.run_reconciliation_once() == 1

        row = await _row(user_id)
        assert row is not None
        assert row.cancel_at_period_end is False


class TestMovingUpTurnsAutoRenewBackOn:
    async def test_an_upgrade_while_scheduled_to_end_withdraws_the_cancellation(
        self, client, billing_on, fake_stripe
    ):
        """Policy, not a Stripe default: somebody who scheduled a cancellation
        on Coven and then paid to move to Legion has changed their mind about
        leaving. The handler notices the tier went up while the subscription
        was still ending, withdraws the cancellation, and re-reads."""
        user_id, _ = await _signup(client, "upgrade-resume@example.com")
        await _seed_customer(user_id)
        ending = _subscription_object(
            spawn_user_id=user_id,
            price=PRICE_COVEN,
            status="active",
            period_start=JAN,
            period_end=FEB,
            canceled_at=JAN + 3600,
            cancel_at=FEB,
        )
        fake_stripe.subscriptions["sub_test"] = ending
        cancelled = await _post(
            client,
            _event_bytes(
                "customer.subscription.updated", ending, event_id="evt_c3", created=JAN + 3600
            ),
        )
        assert cancelled.status_code == 200, cancelled.text

        # Stripe's confirm page moved the price and left the cancellation as
        # it was — that is what the object says when the webhook arrives.
        ending["items"]["data"][0]["price"]["id"] = PRICE_LEGION
        response = await _post(
            client,
            _event_bytes(
                "customer.subscription.updated", ending, event_id="evt_u3", created=JAN + 7200
            ),
        )
        assert response.status_code == 200, response.text

        assert ("sub_test", {"cancel_at": ""}) in fake_stripe.named("subscriptions.update")
        row = await _row(user_id)
        assert row is not None
        assert row.tier == billing.TIER_LEGION
        assert row.cancel_at_period_end is False

    async def test_a_downgrade_leaves_a_scheduled_cancellation_alone(
        self, client, billing_on, fake_stripe
    ):
        user_id, _ = await _signup(client, "downgrade-keep@example.com")
        await _seed_customer(user_id)
        ending = _subscription_object(
            spawn_user_id=user_id,
            price=PRICE_LEGION,
            status="active",
            period_start=JAN,
            period_end=FEB,
            canceled_at=JAN + 3600,
            cancel_at=FEB,
        )
        fake_stripe.subscriptions["sub_test"] = ending
        await _post(
            client,
            _event_bytes(
                "customer.subscription.updated", ending, event_id="evt_c4", created=JAN + 3600
            ),
        )
        ending["items"]["data"][0]["price"]["id"] = PRICE_COVEN
        response = await _post(
            client,
            _event_bytes(
                "customer.subscription.updated", ending, event_id="evt_d4", created=JAN + 7200
            ),
        )
        assert response.status_code == 200, response.text
        assert fake_stripe.named("subscriptions.update") == []
        row = await _row(user_id)
        assert row is not None and row.cancel_at_period_end is True


class TestOutOfOrderDeliveryConverges:
    async def test_an_older_event_delivered_last_does_not_reinstate_a_stale_plan(
        self, client, billing_on, fake_stripe
    ):
        """The handler re-fetches rather than applying what the event said, so
        the state it writes is whatever Stripe holds when it asks — and the
        ordering guard drops a read that is strictly older than the one already
        applied. Both together are why order does not matter."""
        user_id, _ = await _signup(client, "unordered@example.com")
        await _seed_customer(user_id)

        # The truth as Stripe now holds it: cancelled in February.
        cancelled = _subscription_object(
            spawn_user_id=user_id,
            price=PRICE_COVEN,
            status="canceled",
            period_start=FEB,
            period_end=MAR,
            canceled_at=FEB,
            ended_at=FEB,
        )
        fake_stripe.subscriptions["sub_test"] = cancelled

        newer = await _post(
            client,
            _event_bytes(
                "customer.subscription.deleted", cancelled, event_id="evt_new"
            ),
        )
        assert newer.status_code == 200, newer.text
        assert (await _entitlement(user_id)).tier == billing.TIER_FREE

        # Now the January "created" event turns up, late. Its payload claims an
        # active Coven plan. It must not resurrect one.
        stale_payload = _subscription_object(
            spawn_user_id=user_id, price=PRICE_COVEN, status="active"
        )
        older = await _post(
            client,
            _event_bytes(
                "customer.subscription.created", stale_payload, event_id="evt_old"
            ),
        )
        assert older.status_code == 200, older.text

        granted = await _entitlement(user_id)
        assert granted.tier == billing.TIER_FREE
        assert granted.host_limit == 1
        row = await _row(user_id)
        assert row is not None
        assert row.status == "canceled"

    async def test_a_stale_fetch_racing_a_fresh_one_loses(
        self, client, billing_on, fake_stripe
    ):
        """The guard on its own, with the re-fetch neutralised.

        The previous test cannot fail if the ordering guard were deleted,
        because re-fetching already answers it. This one pins the guard: Stripe
        is made to answer with genuinely older state, and the row must not move.
        """
        user_id, _ = await _signup(client, "raced@example.com")
        await _seed_customer(user_id)

        current = _subscription_object(
            spawn_user_id=user_id,
            price=PRICE_LEGION,
            period_start=FEB,
            period_end=MAR,
            created=FEB,
        )
        fake_stripe.subscriptions["sub_test"] = current
        first = await _post(
            client,
            _event_bytes("customer.subscription.updated", current, event_id="evt_1"),
        )
        assert first.status_code == 200, first.text
        assert (await _entitlement(user_id)).host_limit == 20

        # A read that predates the one already applied.
        fake_stripe.subscriptions["sub_test"] = _subscription_object(
            spawn_user_id=user_id,
            price=PRICE_COVEN,
            period_start=JAN,
            period_end=FEB,
            created=JAN,
        )
        second = await _post(
            client,
            _event_bytes(
                "customer.subscription.updated",
                fake_stripe.subscriptions["sub_test"],
                event_id="evt_2",
            ),
        )
        assert second.status_code == 200, second.text
        assert (await _entitlement(user_id)).host_limit == 20


# ---------- status codes are retry instructions ----------


class TestTheStatusCodeAsksStripeForTheRightThing:
    async def test_an_unhandled_event_type_is_200(self, client, billing_on, fake_stripe):
        """Not an error. Answering otherwise would have Stripe retrying an event
        this server has no use for, for three days."""
        response = await _post(
            client,
            _event_bytes(
                "customer.discount.created", {"id": "di_1", "object": "discount"}
            ),
        )
        assert response.status_code == 200, response.text
        assert fake_stripe.named("subscriptions.retrieve") == []

    async def test_an_object_stripe_says_is_missing_is_200_not_a_retry(
        self, client, billing_on, fake_stripe, caplog
    ):
        """A permanent miss must not be dressed up as an outage.

        Stripe retries a 500 for three days. An event naming a subscription
        this key cannot see will name the same one at the end of them, so a
        retry buys nothing and costs three days of a failure that was never
        going to clear. Reachable without anyone doing anything wrong: an
        event delivered after a sandbox object was deleted, or a key rotated
        to another account while an endpoint kept its backlog.
        """
        user_id, _ = await _signup(client, "vanished@example.com")
        await _seed_customer(user_id)
        # Deliberately NOT registered with the fake, so the retrieve 404s.
        subscription = _subscription_object(spawn_user_id=user_id)

        with caplog.at_level("ERROR"):
            response = await _post(
                client, _event_bytes("customer.subscription.updated", subscription)
            )

        assert response.status_code == 200, response.text
        # Loud, because nobody is going to be told by Stripe retrying.
        assert any("does not exist" in record.message for record in caplog.records)
        # And it granted nothing on the way past.
        assert (await _entitlement(user_id)).tier == billing.TIER_FREE

    async def test_a_stripe_outage_is_500_so_stripe_retries(
        self, client, billing_on, fake_stripe
    ):
        user_id, _ = await _signup(client, "outage@example.com")
        await _seed_customer(user_id)
        subscription = _subscription_object(spawn_user_id=user_id)
        fake_stripe.subscriptions["sub_test"] = subscription
        fake_stripe.outage = True

        response = await _post(
            client, _event_bytes("customer.subscription.created", subscription)
        )
        assert response.status_code == 500, response.text

        # And the dedupe row went back with it, or the retry we just asked for
        # would be answered "already applied" and do nothing.
        async with get_sessionmaker()() as session:
            assert await session.get(StripeEvent, "evt_test") is None

        fake_stripe.outage = False
        retry = await _post(
            client, _event_bytes("customer.subscription.created", subscription)
        )
        assert retry.status_code == 200, retry.text
        assert (await _entitlement(user_id)).tier == billing.TIER_COVEN

    async def test_a_bug_of_ours_is_200_and_a_loud_log(
        self, client, billing_on, fake_stripe, monkeypatch, caplog
    ):
        """Three days of retries against a `KeyError` delays nothing but our own
        fix. The alert is the log line, not Stripe's dashboard."""
        user_id, _ = await _signup(client, "ourbug@example.com")
        await _seed_customer(user_id)
        subscription = _subscription_object(spawn_user_id=user_id)
        fake_stripe.subscriptions["sub_test"] = subscription

        async def _boom(*args, **kwargs):
            raise KeyError("a shape we misread")

        monkeypatch.setattr(billing_stripe, "fetch_and_apply_subscription", _boom)

        with caplog.at_level("ERROR"):
            response = await _post(
                client, _event_bytes("customer.subscription.created", subscription)
            )
        assert response.status_code == 200, response.text
        assert any(record.levelname == "ERROR" for record in caplog.records)
        assert (await _entitlement(user_id)).tier == billing.TIER_FREE

    async def test_the_exact_configured_path_never_redirects(
        self, client, billing_on, fake_stripe
    ):
        """A 3xx is a delivery failure to Stripe, and both spellings are served
        directly rather than by a redirect to the other."""
        payload = _event_bytes(
            "customer.discount.created", {"id": "di_1", "object": "discount"}
        )
        for path in (WEBHOOK, f"{WEBHOOK}/"):
            response = await client.post(
                path,
                content=payload,
                headers={"stripe-signature": _sign(payload, SECRET)},
            )
            assert response.status_code == 200, (path, response.status_code)
            assert not response.history, path


# ---------- which account, and which tier ----------


class TestTheGrantLandsOnTheRightAccountAndTheRightTier:
    async def test_the_subscription_metadata_names_the_account(
        self, client, billing_on, fake_stripe
    ):
        """The binding `create_checkout_session` rides onto the Subscription, so
        a `customer.subscription.*` event carries it without a Session lookup."""
        mine, _ = await _signup(client, "mine@example.com")
        theirs, _ = await _signup(client, "theirs@example.com")
        await _seed_customer(theirs, customer="cus_theirs")

        # No row for `mine` at all: the metadata is the only thing that can
        # find the account, and it must.
        subscription = _subscription_object(
            subscription_id="sub_mine",
            customer="cus_mine",
            spawn_user_id=mine,
            price=PRICE_PANDEMONIUM,
        )
        fake_stripe.subscriptions["sub_mine"] = subscription

        response = await _post(
            client, _event_bytes("customer.subscription.created", subscription)
        )
        assert response.status_code == 200, response.text

        assert (await _entitlement(mine)).host_limit is None
        assert (await _entitlement(theirs)).tier == billing.TIER_FREE

    async def test_a_checkout_session_binds_through_client_reference_id(
        self, client, billing_on, fake_stripe
    ):
        user_id, _ = await _signup(client, "checkout@example.com")
        await _seed_customer(user_id, customer="cus_checkout")
        subscription = _subscription_object(
            subscription_id="sub_checkout",
            customer="cus_checkout",
            spawn_user_id=user_id,
            price=PRICE_LEGION,
        )
        fake_stripe.subscriptions["sub_checkout"] = subscription

        session_object = {
            "id": "cs_1",
            "object": "checkout.session",
            "mode": "subscription",
            "customer": "cus_checkout",
            "client_reference_id": user_id,
            "subscription": "sub_checkout",
        }
        response = await _post(
            client, _event_bytes("checkout.session.completed", session_object)
        )
        assert response.status_code == 200, response.text
        assert (await _entitlement(user_id)).host_limit == 20

    async def test_an_event_for_nobody_we_know_is_200_and_grants_nothing(
        self, client, billing_on, fake_stripe
    ):
        """A test-mode event against a live key, or a leftover from another
        deployment. Not an error, and not a reason to invent an account."""
        subscription = _subscription_object(
            subscription_id="sub_stranger", customer="cus_stranger"
        )
        fake_stripe.subscriptions["sub_stranger"] = subscription
        response = await _post(
            client, _event_bytes("customer.subscription.updated", subscription)
        )
        assert response.status_code == 200, response.text

        async with get_sessionmaker()() as session:
            from sqlalchemy import func, select

            count = (
                await session.execute(select(func.count()).select_from(Subscription))
            ).scalar_one()
        assert count == 0

    async def test_the_tier_comes_from_our_price_map_not_the_events_metadata(
        self, client, billing_on, fake_stripe
    ):
        """Stripe's `price.metadata` is editable by anyone with a dashboard
        login. Reading it would make a plan's value a UI setting."""
        user_id, _ = await _signup(client, "metadata@example.com")
        await _seed_customer(user_id)
        subscription = _subscription_object(
            spawn_user_id=user_id,
            price=PRICE_COVEN,
            price_metadata={"host_limit": "9999", "tier": "pandemonium"},
        )
        fake_stripe.subscriptions["sub_test"] = subscription

        response = await _post(
            client, _event_bytes("customer.subscription.created", subscription)
        )
        assert response.status_code == 200, response.text

        granted = await _entitlement(user_id)
        assert granted.tier == billing.TIER_COVEN
        assert granted.host_limit == 3

    async def test_a_price_this_deployment_does_not_sell_falls_back_to_free(
        self, client, billing_on, fake_stripe
    ):
        user_id, _ = await _signup(client, "unknownprice@example.com")
        await _seed_customer(user_id)
        subscription = _subscription_object(
            spawn_user_id=user_id, price="price_from_another_account"
        )
        fake_stripe.subscriptions["sub_test"] = subscription

        response = await _post(
            client, _event_bytes("customer.subscription.created", subscription)
        )
        assert response.status_code == 200, response.text
        granted = await _entitlement(user_id)
        assert granted.tier == billing.TIER_FREE
        assert granted.host_limit == 1

    async def test_dunning_keeps_the_plan_and_records_the_status(
        self, client, billing_on, fake_stripe
    ):
        """`past_due` entitles. Stripe's dunning runs for weeks, and a card that
        failed this morning is not a reason to refuse a host this afternoon."""
        user_id, _ = await _signup(client, "dunning@example.com")
        await _seed_customer(user_id)
        subscription = _subscription_object(
            spawn_user_id=user_id, price=PRICE_LEGION, status="past_due"
        )
        fake_stripe.subscriptions["sub_test"] = subscription

        invoice = {
            "id": "in_1",
            "object": "invoice",
            "customer": "cus_test",
            "parent": {"subscription_details": {"subscription": "sub_test"}},
        }
        response = await _post(client, _event_bytes("invoice.payment_failed", invoice))
        assert response.status_code == 200, response.text

        granted = await _entitlement(user_id)
        assert granted.host_limit == 20
        row = await _row(user_id)
        assert row is not None and row.status == "past_due"

    async def test_finalization_failure_alerts_us_and_touches_nobodys_plan(
        self, client, billing_on, fake_stripe, caplog
    ):
        """Silent revenue loss with no user-visible symptom: the subscription
        stays active and the invoice simply cannot be collected."""
        user_id, _ = await _signup(client, "finalize@example.com")
        await _seed_customer(user_id)
        subscription = _subscription_object(spawn_user_id=user_id, price=PRICE_LEGION)
        fake_stripe.subscriptions["sub_test"] = subscription
        await _post(
            client,
            _event_bytes(
                "customer.subscription.created", subscription, event_id="evt_seed"
            ),
        )

        invoice = {
            "id": "in_broken",
            "object": "invoice",
            "customer": "cus_test",
            "parent": {"subscription_details": {"subscription": "sub_test"}},
        }
        with caplog.at_level("ERROR"):
            response = await _post(
                client, _event_bytes("invoice.finalization_failed", invoice)
            )
        assert response.status_code == 200, response.text
        assert any("in_broken" in record.getMessage() for record in caplog.records)
        assert (await _entitlement(user_id)).host_limit == 20


# ---------- the redirect grants nothing ----------


class TestTheSuccessUrlIsAPageAndNothingElse:
    async def test_visiting_the_return_url_never_upgrades_anyone(
        self, client, billing_on, fake_stripe
    ):
        """The classic way to give a paid tier away is to treat a browser
        arriving at `success_url` as proof of payment. It is a URL the user can
        visit at will, and nothing on this server reads it."""
        user_id, auth = await _signup(client, "returned@example.com")
        checkout = await client.post(
            "/api/billing/checkout", json={"tier": "pandemonium"}, headers=auth
        )
        assert checkout.status_code == 200, checkout.text

        created = fake_stripe.named("checkout.sessions.create")[0]
        success_url = created["success_url"]
        assert "{CHECKOUT_SESSION_ID}" not in success_url

        # Whatever path it points at, on this server it is not a grant.
        path = success_url.split("://", 1)[1].split("/", 1)[1]
        for _ in range(3):
            visited = await client.get(f"/{path}", headers=auth)
            assert visited.status_code < 500

        granted = await _entitlement(user_id)
        assert granted.tier == billing.TIER_FREE
        assert granted.host_limit == 1

    async def test_only_the_webhook_writes_a_tier(self, client, billing_on, fake_stripe):
        """Checkout created a Customer and a Session and no entitlement; the
        webhook that follows is what grants."""
        user_id, auth = await _signup(client, "onlywebhook@example.com")
        assert (
            await client.post(
                "/api/billing/checkout", json={"tier": "coven"}, headers=auth
            )
        ).status_code == 200

        row = await _row(user_id)
        assert row is not None
        assert row.tier == billing.TIER_FREE
        assert row.status == "incomplete"
        assert row.stripe_subscription_id is None

        subscription = _subscription_object(
            customer=row.stripe_customer_id, spawn_user_id=user_id
        )
        fake_stripe.subscriptions["sub_test"] = subscription
        assert (
            await _post(
                client, _event_bytes("customer.subscription.created", subscription)
            )
        ).status_code == 200
        assert (await _entitlement(user_id)).host_limit == 3


# ---------- the mail the webhook triggers ----------


@pytest.fixture
def sent_mail(monkeypatch):
    """Record what `billing_email` was asked to send, without sending it."""
    from spawn_server import billing_email

    recorded: list[tuple[str, dict]] = []

    def _recorder(name):
        async def _record(session, user, **kwargs):
            recorded.append((name, {"user_id": user.id, **kwargs}))

        return _record

    for name in (
        "send_subscription_started",
        "send_payment_failed",
        "send_payment_action_required",
        "send_plan_changed",
        "send_subscription_ended",
    ):
        monkeypatch.setattr(billing_email, name, _recorder(name))
    return recorded


class TestTheMailFollowsTheEntitlement:
    async def test_a_first_grant_sends_the_confirmation(
        self, client, billing_on, fake_stripe, sent_mail
    ):
        """Required by EU/UK distance-selling rules: Stripe's own receipt does
        not cover the pre-contract disclosure."""
        user_id, _ = await _signup(client, "mail-start@example.com")
        await _seed_customer(user_id)
        subscription = _subscription_object(spawn_user_id=user_id, price=PRICE_LEGION)
        fake_stripe.subscriptions["sub_test"] = subscription

        assert (
            await _post(
                client, _event_bytes("customer.subscription.created", subscription)
            )
        ).status_code == 200
        await _drain_mail()

        assert [name for name, _ in sent_mail] == ["send_subscription_started"]
        _, kwargs = sent_mail[0]
        assert kwargs["user_id"] == user_id
        assert kwargs["tier_name"] == "Legion"
        assert kwargs["price_cents"] == 2000

    async def test_a_second_event_for_the_same_plan_sends_nothing(
        self, client, billing_on, fake_stripe, sent_mail
    ):
        user_id, _ = await _signup(client, "mail-quiet@example.com")
        await _seed_customer(user_id)
        subscription = _subscription_object(spawn_user_id=user_id)
        fake_stripe.subscriptions["sub_test"] = subscription

        for event_id in ("evt_1", "evt_2"):
            assert (
                await _post(
                    client,
                    _event_bytes(
                        "customer.subscription.updated", subscription, event_id=event_id
                    ),
                )
            ).status_code == 200
        await _drain_mail()
        assert [name for name, _ in sent_mail] == ["send_subscription_started"]

    async def test_a_tier_change_says_what_changed(
        self, client, billing_on, fake_stripe, sent_mail
    ):
        user_id, _ = await _signup(client, "mail-changed@example.com")
        await _seed_customer(user_id)
        coven = _subscription_object(spawn_user_id=user_id, price=PRICE_COVEN)
        fake_stripe.subscriptions["sub_test"] = coven
        await _post(
            client,
            _event_bytes("customer.subscription.created", coven, event_id="evt_1"),
        )

        legion = _subscription_object(spawn_user_id=user_id, price=PRICE_LEGION)
        fake_stripe.subscriptions["sub_test"] = legion
        await _post(
            client,
            _event_bytes("customer.subscription.updated", legion, event_id="evt_2"),
        )
        await _drain_mail()

        assert [name for name, _ in sent_mail] == [
            "send_subscription_started",
            "send_plan_changed",
        ]
        assert sent_mail[1][1]["from_tier_name"] == "Coven"
        assert sent_mail[1][1]["to_tier_name"] == "Legion"
        assert sent_mail[1][1]["host_limit"] == 20

    async def test_a_cancellation_says_what_they_hold_and_what_they_may(
        self, client, billing_on, fake_stripe, sent_mail
    ):
        """The diff is against OUR stored limit. `previous_attributes` is absent
        on `customer.subscription.deleted`, and a cancellation is a downgrade."""
        user_id, _ = await _signup(client, "mail-ended@example.com")
        await _seed_customer(user_id)
        active = _subscription_object(spawn_user_id=user_id, price=PRICE_LEGION)
        fake_stripe.subscriptions["sub_test"] = active
        await _post(
            client,
            _event_bytes("customer.subscription.created", active, event_id="evt_1"),
        )
        # Before writing anything: the confirmation mail's task shares this
        # test database's single connection, and its commit would land in the
        # middle of the inserts below.
        await _drain_mail()

        async with get_sessionmaker()() as session:
            for index in range(4):
                session.add(Host(owner_user_id=user_id, name=f"box-{index}"))
            await session.commit()

        cancelled = _subscription_object(
            spawn_user_id=user_id,
            price=PRICE_LEGION,
            status="canceled",
            period_start=FEB,
            period_end=MAR,
            canceled_at=FEB,
            ended_at=FEB,
        )
        fake_stripe.subscriptions["sub_test"] = cancelled
        await _post(
            client,
            _event_bytes("customer.subscription.deleted", cancelled, event_id="evt_2"),
        )
        await _drain_mail()

        assert [name for name, _ in sent_mail] == [
            "send_subscription_started",
            "send_subscription_ended",
        ]
        # The limit the gate will actually apply, and what they are still
        # holding — nothing is suspended and nothing is deleted.
        assert sent_mail[1][1]["host_limit"] == 1
        assert sent_mail[1][1]["host_count"] == 4

    async def test_a_mail_failure_never_fails_a_webhook(
        self, client, billing_on, fake_stripe, monkeypatch
    ):
        """Stripe would retry a delivery that had already applied correctly."""
        from spawn_server import billing_email

        async def _explode(*args, **kwargs):
            raise RuntimeError("smtp is on fire")

        monkeypatch.setattr(billing_email, "send_subscription_started", _explode)

        user_id, _ = await _signup(client, "mail-broken@example.com")
        await _seed_customer(user_id)
        subscription = _subscription_object(spawn_user_id=user_id)
        fake_stripe.subscriptions["sub_test"] = subscription

        response = await _post(
            client, _event_bytes("customer.subscription.created", subscription)
        )
        assert response.status_code == 200, response.text
        await _drain_mail()
        assert (await _entitlement(user_id)).host_limit == 3


# ---------- reconciliation ----------


class TestReconciliationCatchesWhatWebhooksMissed:
    async def test_it_rewrites_a_plan_that_drifted(self, app, billing_on, fake_stripe):
        """The endpoint could have been down for longer than Stripe's three days
        of retries. Nothing else would ever notice."""
        async with get_sessionmaker()() as session:
            user = User(email="drifted@example.com", password_hash="x")
            session.add(user)
            await session.flush()
            session.add(
                Subscription(
                    user_id=user.id,
                    stripe_customer_id="cus_drift",
                    stripe_subscription_id="sub_drift",
                    tier=billing.TIER_PANDEMONIUM,
                    status="active",
                    host_limit=None,
                )
            )
            await session.commit()
            user_id = user.id

        fake_stripe.subscriptions["sub_drift"] = _subscription_object(
            subscription_id="sub_drift",
            customer="cus_drift",
            spawn_user_id=user_id,
            price=PRICE_COVEN,
        )

        assert await billing_stripe.run_reconciliation_once() == 1
        granted = await _entitlement(user_id)
        assert granted.tier == billing.TIER_COVEN
        assert granted.host_limit == 3

    async def test_it_is_a_no_op_when_billing_is_off(self, app, fake_stripe):
        assert await billing_stripe.run_reconciliation_once() == 0
        assert fake_stripe.calls == []

    async def test_it_starts_no_task_when_billing_is_off(self, app):
        billing_stripe.start_reconciliation_loop()
        assert billing_stripe._RECONCILIATION_TASK is None
        await billing_stripe.stop_reconciliation_loop()

    async def test_an_unreadable_subscription_does_not_abandon_the_sweep(
        self, app, billing_on, fake_stripe
    ):
        async with get_sessionmaker()() as session:
            user = User(email="unreadable@example.com", password_hash="x")
            session.add(user)
            await session.flush()
            session.add(
                Subscription(
                    user_id=user.id,
                    stripe_customer_id="cus_gone",
                    stripe_subscription_id="sub_gone",
                    tier=billing.TIER_COVEN,
                    status="active",
                    host_limit=3,
                )
            )
            await session.commit()
            user_id = user.id

        # Not in the fake's dict: Stripe raises rather than answering.
        assert await billing_stripe.run_reconciliation_once() == 0
        # And the limit our own tables hold is untouched, because Stripe being
        # unable to answer is not evidence that anybody stopped paying.
        assert (await _entitlement(user_id)).host_limit == 3
