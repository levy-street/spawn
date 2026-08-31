"""Stripe: the only module in this server that imports the SDK.

`billing.py` decides what a plan *means* and reads it from our own tables. This
module is the other half — it talks to Stripe, and it is the single place
allowed to. Everything else (`routes/billing.py`, account deletion, the
reconciliation loop) goes through the functions below, so there is exactly one
answer to "where does a Stripe call come from" and exactly one file to read
when that answer matters.

`web_push.py:29-32` records a decision to reject a library that dragged a
second HTTP client into a server standardised on `httpx`. The `stripe` SDK
ships `requests` and so starts from behind. It earns its place by owning three
things we would otherwise reimplement badly: webhook signature verification
(constant-time, timestamp-bounded, multi-secret), API versioning, and retry
and idempotency semantics against a payment processor. It stays behind this
module's door: nothing else imports it, and the one exception type callers need
is re-exported below so that stays true.

The API version is pinned in code rather than left to the account default, so
somebody bumping the version in a dashboard cannot change payload shapes under
a running server.

Two rules govern everything here and are worth stating once:

- **Never apply a delta.** No function writes a plan from what an event
  asserted. `fetch_and_apply_subscription` re-reads the subscription from the
  API and writes our whole current state, which is the only handler that is
  correct under Stripe's unordered delivery.
- **A tier is computed from our own price map.** Stripe's `price.metadata` says
  the same thing and is editable by anyone with a dashboard login, so it is
  never read. `billing.tier_for_price_id` is the authority.

Stripe being unreachable is not an entitlement change. A transport failure or a
refusal raises `StripeUnavailable`, and every caller is expected to carry on:
the limit that is actually enforced is read from our own tables, which do not
depend on Stripe answering.

An object Stripe says is *gone* raises `StripeResourceMissing` instead, and the
split is load-bearing rather than tidy. Stripe retries a 500 for three days; a
subscription this key cannot see will still be missing at the end of them, so
the two get different answers — a retry for the outage, a loud log and a 200
for the one that is never going to clear.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from datetime import UTC, datetime
from typing import Any

import stripe
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from . import billing
from .config import Settings, get_settings
from .db import get_sessionmaker
from .models import Subscription, User

log = logging.getLogger(__name__)

#: Pinned deliberately. An account-level version bump in the Stripe dashboard
#: changes payload shapes; pinning here means it cannot do that to a server
#: that is already running, and that upgrading is a commit with a diff.
STRIPE_API_VERSION = "2026-08-26.dahlia"

#: Re-exported so `routes/billing.py` can catch a bad signature without
#: importing `stripe` itself, which would break the one-door rule above.
SignatureVerificationError = stripe.SignatureVerificationError

#: How often the reconciliation loop re-reads every paid subscription. Webhooks
#: are the fast path and this is the slow, boring one that catches what they
#: missed, so hours rather than minutes: a plan that is wrong for six hours is
#: a support conversation, and a plan that is wrong forever is a revenue hole.
RECONCILIATION_INTERVAL_SECONDS = 6 * 60 * 60
#: Long enough after boot that a deploy's first minutes are not spent talking
#: to Stripe, matching `_auto_update_check_loop`'s own settling delay.
RECONCILIATION_FIRST_DELAY_SECONDS = 300


class StripeUnavailable(RuntimeError):
    """Stripe could not be reached or refused.

    Entitlement is unaffected: it is read from our own tables, which are the
    authority at enforcement time. A caller that was doing something else —
    deleting an account, reconciling a fleet — must carry on regardless. Only
    the Stripe-shaped part of the request has failed.
    """


class StripeResourceMissing(LookupError):
    """Stripe answered, and said the object is not there.

    Deliberately NOT a `StripeUnavailable`. An outage is worth retrying and
    this is not: an event naming a subscription our key cannot see will name
    the same one in three days' time. Stripe retries a 500 for three days, so
    classing this as an outage buys nothing and costs a log full of a failure
    that was never going to clear. The webhook handler answers 200 to it and
    says so loudly instead.

    Reachable without anyone doing anything wrong: an event delivered after the
    object was deleted from a sandbox, or a key rotated to a different account
    while an endpoint kept its backlog.
    """


class StripeNotConfigured(RuntimeError):
    """Billing is off, or a key or price id this call needs is unset.

    Distinct from `StripeUnavailable` on purpose: nothing is down, the
    deployment simply does not sell anything. It is a programming error to
    reach here from a route, because every billing route 404s first.
    """


class SubscriptionMissing(LookupError):
    """This account has no Stripe subscription to act on.

    Its own type because the caller's answer differs: a route turns it into a
    409 telling the client to start a subscription rather than change one,
    where `StripeUnavailable` would be a 503 and a retry.
    """


def stripe_ready(settings: Settings | None = None) -> bool:
    """Whether this deployment can talk to Stripe at all.

    Both halves matter. `billing_enabled` is the switch a self-hoster never
    touches; the secret key is what a call would actually authenticate with.
    """
    settings = settings or get_settings()
    return bool(settings.billing_enabled and settings.stripe_secret_key)


def webhook_secrets(settings: Settings | None = None) -> list[str]:
    """Every signing secret currently accepted, in configuration order.

    A list rather than a string because rotation is the case that matters.
    Stripe sends one `v1` signature per active secret in the same header for
    up to 24 hours, so a server that knows both the old and the new one accepts
    every event throughout the rotation and nothing is dropped. A single-secret
    server has to be restarted at exactly the right moment, which is not a
    thing anyone manages to do.
    """
    settings = settings or get_settings()
    raw = settings.stripe_webhook_secret or ""
    return [secret.strip() for secret in raw.split(",") if secret.strip()]


def verify_event(payload: bytes, sig_header: str, secrets: list[str]) -> stripe.Event:
    """Verify raw bytes against each secret in turn; the first that verifies wins.

    `payload` must be the bytes as they arrived. Re-serialising the JSON —
    which is what happens if a handler declares a Pydantic body or calls
    `request.json()` first — changes whitespace and key order and breaks the
    HMAC over content that is otherwise identical.
    """
    if not secrets:
        # Cannot happen on a booted server: `Settings` refuses to start with
        # billing on and no signing secret. Belt and braces, because the thing
        # this prevents is an unauthenticated grant API.
        raise SignatureVerificationError(
            "no webhook signing secret is configured", sig_header
        )
    failure: stripe.SignatureVerificationError | None = None
    for secret in secrets:
        try:
            return stripe.Webhook.construct_event(payload, sig_header, secret)
        except SignatureVerificationError as exc:
            failure = exc
    assert failure is not None
    raise failure


# ---------- the client, and getting off the event loop ----------


_CLIENT: tuple[str, stripe.StripeClient] | None = None


def _client(settings: Settings | None = None) -> stripe.StripeClient:
    """The real client, cached per secret key.

    Cached because the SDK holds a connection pool behind it and the webhook
    handler is directly in a customer's path — Checkout waits up to ten
    seconds for our response, and a fresh TLS handshake per event is a bad way
    to spend that budget.
    """
    global _CLIENT
    settings = settings or get_settings()
    if not stripe_ready(settings):
        raise StripeNotConfigured(
            "billing is disabled or SPAWN_STRIPE_SECRET_KEY is unset"
        )
    key = str(settings.stripe_secret_key)
    if _CLIENT is not None and _CLIENT[0] == key:
        return _CLIENT[1]
    client = stripe.StripeClient(key, stripe_version=STRIPE_API_VERSION)
    _CLIENT = (key, client)
    return client


async def _call(fn: Any, /, *args: Any, **kwargs: Any) -> Any:
    """One blocking SDK call, off the event loop, with its failures translated.

    The SDK is sync-first, and this server is not: a call left on the loop
    stalls every websocket in the process for the duration of an HTTP
    round-trip to Stripe.

    Stripe's transport failures become `StripeUnavailable`, which is retried.
    An object Stripe says does not exist becomes `StripeResourceMissing`, which
    is not — the distinction matters because Stripe retries a 500 for three
    days and a missing object will still be missing at the end of them.

    Anything else — a `TypeError` from a call built wrong, a `KeyError` from a
    payload shape we misread — is our bug and propagates, because the webhook
    handler answers 200 to those on purpose. Three days of Stripe retries
    against a deterministic exception delays nothing but our own fix.
    """
    try:
        return await asyncio.to_thread(fn, *args, **kwargs)
    except stripe.InvalidRequestError as exc:
        if getattr(exc, "code", None) == "resource_missing" or getattr(exc, "http_status", None) == 404:
            raise StripeResourceMissing(str(exc)) from exc
        raise StripeUnavailable(str(exc)) from exc
    except stripe.StripeError as exc:
        raise StripeUnavailable(str(exc)) from exc
    except (OSError, TimeoutError) as exc:
        raise StripeUnavailable(f"{type(exc).__name__}: {exc}") from exc


# ---------- reading Stripe's objects without trusting their shape ----------


def _field(obj: Any, name: str, default: Any = None) -> Any:
    """Read one field off a Stripe object, a plain dict, or a test double.

    Stripe's objects are dict subclasses that also answer attribute access, and
    the tests here hand this module plain dicts. Reading both ways costs
    nothing and keeps the fixtures honest — a test double does not have to
    subclass anything to be exercised by the real code path.
    """
    if obj is None:
        return default
    try:
        value = obj[name]
    except (TypeError, KeyError, IndexError):
        value = getattr(obj, name, default)
    return default if value is None else value


def _timestamp(value: Any) -> datetime | None:
    """A Stripe unix seconds field as an aware datetime, or None."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    if value <= 0:
        return None
    return datetime.fromtimestamp(int(value), tz=UTC)


def _aware(value: datetime | None) -> datetime | None:
    """Read a stored timestamp as UTC-aware.

    SQLite hands back naive datetimes for a `DateTime(timezone=True)` column
    where PostgreSQL hands back aware ones, and comparing the two raises. The
    column only ever holds UTC, so filling in the zone is a restatement rather
    than a guess.
    """
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def _items(subscription: Any) -> list[Any]:
    return list(_field(_field(subscription, "items"), "data") or [])


def _first_item(subscription: Any) -> Any:
    items = _items(subscription)
    return items[0] if items else None


def _price_id(subscription: Any) -> str | None:
    """The price the first item is on — the only thing a tier is computed from.

    One item, because `create_checkout_session` creates exactly one and
    `change_plan` moves that one. A subscription with several items is not
    something this product can produce, and reading only the first is the
    conservative answer if one ever appears.
    """
    price = _field(_first_item(subscription), "price")
    identifier = _field(price, "id")
    return identifier if isinstance(identifier, str) else None


def _period_end(subscription: Any) -> datetime | None:
    """When the current period ends.

    Read off the item first: `current_period_end` moved from the Subscription
    to the SubscriptionItem in a 2025 API version, and the pinned version is
    past it. The subscription-level fallback is for older payloads and for
    fixtures that spell it the old way.
    """
    item_end = _timestamp(_field(_first_item(subscription), "current_period_end"))
    if item_end is not None:
        return item_end
    return _timestamp(_field(subscription, "current_period_end"))


def _state_timestamp(subscription: Any) -> datetime | None:
    """How old the state we just fetched is, for the ordering guard.

    Stripe subscriptions carry no "updated at", so this is the latest of the
    timestamps that only ever move forward: when it was created and started,
    when the current period began, and when it was cancelled or ended. Two
    fetches inside one billing period tie, which is why the guard drops only
    *strictly* older state; a fetch from before a renewal or from before a
    cancellation loses, which is exactly the stale plan that must not be
    reinstated.

    `cancel_at` is deliberately absent: on a cancel-at-period-end it is a
    *future* timestamp, and letting it in here would push the guard past the
    real cancellation and then drop it when it arrives.
    """
    candidates = [
        _timestamp(_field(subscription, "created")),
        _timestamp(_field(subscription, "start_date")),
        _timestamp(_field(subscription, "canceled_at")),
        _timestamp(_field(subscription, "ended_at")),
        *(_timestamp(_field(item, "current_period_start")) for item in _items(subscription)),
    ]
    known = [value for value in candidates if value is not None]
    return max(known) if known else None


def _customer_id(subscription: Any) -> str | None:
    """The customer id, whether the field is expanded or not."""
    customer = _field(subscription, "customer")
    if isinstance(customer, str):
        return customer
    identifier = _field(customer, "id")
    return identifier if isinstance(identifier, str) else None


def subscription_id_from_event(event_type: str, obj: Any) -> str | None:
    """Which subscription an event's object is about, or None.

    Here rather than in the route because it is knowledge of Stripe's payload
    shapes, and this module is where that lives. It is also the field that has
    moved most: `invoice.subscription` was removed in a 2025 API version in
    favour of `parent.subscription_details.subscription`, and the pinned
    version is past that, so both spellings are read and the invoice lines are
    the last resort.

    Only ever an identifier to go and re-read. Nothing an event says about a
    plan is applied.
    """
    if event_type.startswith("customer.subscription."):
        identifier = _field(obj, "id")
        return identifier if isinstance(identifier, str) else None

    if event_type.startswith("checkout.session."):
        subscription = _field(obj, "subscription")
        if isinstance(subscription, str):
            return subscription
        identifier = _field(subscription, "id")
        return identifier if isinstance(identifier, str) else None

    if event_type.startswith("invoice."):
        direct = _field(obj, "subscription")
        if isinstance(direct, str):
            return direct
        identifier = _field(direct, "id")
        if isinstance(identifier, str):
            return identifier
        parent = _field(_field(obj, "parent"), "subscription_details")
        identifier = _field(parent, "subscription")
        if isinstance(identifier, str):
            return identifier
        for line in _field(_field(obj, "lines"), "data") or []:
            details = _field(_field(line, "parent"), "subscription_item_details")
            identifier = _field(details, "subscription")
            if isinstance(identifier, str):
                return identifier
    return None


def invoice_identity(obj: Any) -> tuple[str | None, str | None]:
    """The invoice id and its customer, for a log line. Either may be absent."""
    invoice_id = _field(obj, "id")
    customer_id = _field(obj, "customer")
    if not isinstance(customer_id, str):
        customer_id = _field(customer_id, "id")
    return (
        invoice_id if isinstance(invoice_id, str) else None,
        customer_id if isinstance(customer_id, str) else None,
    )


def checkout_user_id(obj: Any) -> str | None:
    """The `client_reference_id` we put on a Checkout Session, if it is there.

    One of the two bindings `create_checkout_session` sets. Used only to say
    *which account an event is about*, never what it is entitled to.
    """
    identifier = _field(obj, "client_reference_id")
    return identifier if isinstance(identifier, str) and identifier else None


def hosted_invoice_url(obj: Any) -> str | None:
    """Stripe's own hosted page for an invoice, for a 3-D Secure email.

    Checked for an `https:` scheme before it is handed to a mail template. The
    event is signature-verified, so this is not a trust boundary so much as a
    refusal to put whatever a field happens to contain into a link somebody
    clicks.
    """
    url = _field(obj, "hosted_invoice_url")
    if isinstance(url, str) and url.startswith("https://"):
        return url
    return None


# ---------- our rows ----------


async def _row_for_user(session: AsyncSession, user_id: str) -> Subscription | None:
    return (
        await session.execute(select(Subscription).where(Subscription.user_id == user_id))
    ).scalar_one_or_none()


async def _row_for_subscription(
    session: AsyncSession, subscription_id: str
) -> Subscription | None:
    return (
        await session.execute(
            select(Subscription).where(
                Subscription.stripe_subscription_id == subscription_id
            )
        )
    ).scalar_one_or_none()


async def _row_for_customer(
    session: AsyncSession, customer_id: str
) -> Subscription | None:
    return (
        await session.execute(
            select(Subscription).where(Subscription.stripe_customer_id == customer_id)
        )
    ).scalar_one_or_none()


async def _lock_subscription(session: AsyncSession, subscription_id: str) -> None:
    """Serialise fetch-then-write for one subscription, cluster-wide.

    A webhook handler and the reconciliation loop can both be reading the same
    subscription in different processes. Without this, one can fetch, be
    descheduled while the other fetches and writes something newer, and then
    write its own older read over the top. A transaction-scoped advisory lock
    keyed on the subscription id is the whole fix, and it releases itself when
    the transaction ends however it ends.

    Nothing is emitted on SQLite, which is correct rather than a gap: the test
    database has one connection and cannot exhibit the interleave.
    """
    if session.get_bind().dialect.name != "postgresql":
        return
    # `pg_advisory_xact_lock` takes a bigint, so the id is hashed down to one.
    # A collision costs two unrelated subscriptions a moment of mutual
    # exclusion, which is invisible; the digest is not a security boundary.
    digest = hashlib.blake2b(subscription_id.encode("utf-8"), digest_size=8).digest()
    await session.execute(
        text("SELECT pg_advisory_xact_lock(:key)"),
        {"key": int.from_bytes(digest, "big", signed=True)},
    )


# ---------- the public surface ----------


async def ensure_customer(
    session: AsyncSession, user: User, *, client: Any = None
) -> str:
    """This account's Stripe customer id, creating it and its row on first use.

    An existing id is always reused. A second Customer for the same person
    splits their invoice history across two objects and leaves the Customer
    Portal showing only half of it, which is not something that can be undone
    afterwards.

    The account row is taken first, so two tabs opening Checkout at once cannot
    create two Customers. That does hold a row lock across an HTTP call to
    Stripe — accepted deliberately: this runs once in an account's life, the
    lock is per account and blocks nobody else, and the alternative is the
    duplicate Customer this exists to prevent.
    """
    row = await _row_for_user(session, user.id)
    if row is not None and row.stripe_customer_id:
        return row.stripe_customer_id

    await billing.lock_account(session, user.id)
    row = await _row_for_user(session, user.id)
    if row is not None and row.stripe_customer_id:
        return row.stripe_customer_id

    api = client if client is not None else _client()
    customer = await _call(
        api.v1.customers.create,
        {"email": user.email, "metadata": {"spawn_user_id": user.id}},
    )
    customer_id = _field(customer, "id")
    if not isinstance(customer_id, str) or not customer_id:
        raise StripeUnavailable("Stripe returned a customer with no id")

    if row is None:
        # Free and `incomplete`: a Customer is not a subscription, and an
        # abandoned Checkout must leave an account entitled to exactly what it
        # was entitled to before. `host_limit` is the free number rather than
        # NULL — NULL means unlimited everywhere in this codebase, and this is
        # not the place to spell that by accident.
        row = Subscription(
            user_id=user.id,
            stripe_customer_id=customer_id,
            tier=billing.TIER_FREE,
            status="incomplete",
            host_limit=billing.host_limit_for_tier(billing.TIER_FREE),
        )
        session.add(row)
    else:
        row.stripe_customer_id = customer_id
    await session.flush()
    return customer_id


async def create_checkout_session(
    session: AsyncSession, user: User, *, tier: str, client: Any = None
) -> str:
    """A hosted Checkout session for `tier`. Returns the URL to send them to.

    The caller names a tier and the price id comes from our config. A caller
    that could name a price could name a $0 one, and Checkout would happily
    honour it.

    Both bindings are set on purpose. `client_reference_id` ties the Session to
    our user; the `subscription_data` metadata rides onto the Subscription
    itself, so every later `customer.subscription.*` event carries the binding
    without anyone having to look a Session back up.
    """
    settings = get_settings()
    price_id = billing.price_id_for_tier(tier, settings)
    if not price_id:
        raise StripeNotConfigured(f"no price is configured for tier {tier!r}")

    api = client if client is not None else _client(settings)
    customer_id = await ensure_customer(session, user, client=api)
    base = settings.billing_return_base
    created = await _call(
        api.v1.checkout.sessions.create,
        {
            "mode": "subscription",
            "customer": customer_id,
            "line_items": [{"price": price_id, "quantity": 1}],
            "client_reference_id": user.id,
            "subscription_data": {"metadata": {"spawn_user_id": user.id}},
            # Both of these are pages, and a page grants nothing. Entitlement
            # is written by the webhook and nowhere else; a browser arriving
            # here proves only that a browser arrived here.
            "success_url": f"{base}/?billing=complete",
            "cancel_url": f"{base}/?billing=cancelled",
        },
    )
    url = _field(created, "url")
    if not isinstance(url, str) or not url:
        raise StripeUnavailable("Stripe returned a Checkout session with no url")
    return url


async def create_portal_session(
    session: AsyncSession, user: User, *, client: Any = None
) -> str:
    """A Customer Portal session — payment method, invoices, cancellation.

    Plan switching is turned off in the portal configuration on purpose: it
    would let somebody downgrade without ever consulting us, leaving an account
    over its host limit with no chance to choose what to keep. Plan changes go
    through `change_plan`.
    """
    settings = get_settings()
    api = client if client is not None else _client(settings)
    customer_id = await ensure_customer(session, user, client=api)
    created = await _call(
        api.v1.billing_portal.sessions.create,
        {
            "customer": customer_id,
            "return_url": f"{settings.billing_return_base}/?billing=portal",
        },
    )
    url = _field(created, "url")
    if not isinstance(url, str) or not url:
        raise StripeUnavailable("Stripe returned a portal session with no url")
    return url


async def change_plan(
    session: AsyncSession, user: User, *, tier: str, client: Any = None
) -> None:
    """Move the existing subscription to another tier's price, immediately.

    `proration_behavior="create_prorations"` and applied at once — never
    `schedule_at_period_end`. Deferring a decrease materialises a subscription
    schedule, and *customers cannot update or cancel a subscription that has an
    update scheduled with a schedule*: a user who downgraded would be locked
    out of every self-service change, including cancelling, for up to a month.
    That is a support-incident generator and a consumer-law problem, and it
    buys nothing — the caller has already resolved the over-limit question by
    making the user choose which hosts to keep, so there is no deferral to
    gain from. Do not "improve" this into a schedule.

    Our row is refreshed here rather than left to the webhook, so the response
    a client renders is already true. The webhook arrives anyway and is
    idempotent, because both paths re-fetch and write the whole state.
    """
    settings = get_settings()
    price_id = billing.price_id_for_tier(tier, settings)
    if not price_id:
        raise StripeNotConfigured(f"no price is configured for tier {tier!r}")

    row = await _row_for_user(session, user.id)
    if row is None or not row.stripe_subscription_id:
        raise SubscriptionMissing("this account has no Stripe subscription to change")
    subscription_id = row.stripe_subscription_id

    api = client if client is not None else _client(settings)
    current = await _call(api.v1.subscriptions.retrieve, subscription_id)
    item_id = _field(_first_item(current), "id")
    if not isinstance(item_id, str) or not item_id:
        raise StripeUnavailable("the subscription has no item to move to another price")

    await _call(
        api.v1.subscriptions.update,
        subscription_id,
        {
            "items": [{"id": item_id, "price": price_id}],
            "proration_behavior": "create_prorations",
        },
    )
    await fetch_and_apply_subscription(
        session, subscription_id=subscription_id, client=api
    )


async def cancel_subscription_for_user(
    session: AsyncSession, user: User, *, client: Any = None
) -> bool:
    """Cancel immediately and delete the Customer. True if anything was cancelled.

    For account deletion. The `Subscription` row is `ON DELETE CASCADE`, so
    deleting the user would otherwise make the row vanish locally while Stripe
    went on charging the card — a real money bug with no local evidence that it
    happened.

    Raises `StripeUnavailable` if Stripe refuses. The caller must still proceed:
    somebody's right to delete their account cannot be blocked by our payment
    processor being down. It has to be logged loudly enough that a human
    cancels it by hand.
    """
    row = await _row_for_user(session, user.id)
    if row is None:
        return False

    api = client if client is not None else _client()
    cancelled = False
    if row.stripe_subscription_id:
        await _call(api.v1.subscriptions.cancel, row.stripe_subscription_id)
        cancelled = True
    if row.stripe_customer_id:
        # After the subscription, so a delete that fails leaves a cancelled
        # subscription rather than an orphaned live one.
        await _call(api.v1.customers.delete, row.stripe_customer_id)
        cancelled = True
    return cancelled


async def fetch_and_apply_subscription(
    session: AsyncSession, *, subscription_id: str, client: Any = None
) -> Subscription | None:
    """Re-read one subscription from Stripe and write our whole state from it.

    The only function in this server that writes `tier`, `status` or
    `host_limit`. Every path — webhook, plan change, reconciliation — comes
    through here, which is what makes them agree.

    Nothing is applied as a delta from an event. Stripe does not promise
    ordered delivery, so "go and read the truth" is the only handler that is
    correct when a `created` and an `updated` arrive the wrong way round.

    Returns the row so a caller can diff it against what it captured before.
    A downgrade is that diff, against **our** stored `host_limit` — never
    against the event's `previous_attributes`, which is absent on
    `customer.subscription.deleted` (and a cancellation is a downgrade) and
    absent when reconciliation finds drift. Two detection paths that can
    disagree is how an account silently keeps a limit it no longer pays for.

    Returns None when the subscription belongs to no account we know, which is
    a loud log line and not an error: it is what a test-mode event against a
    live key, or a leftover from another deployment, looks like.
    """
    api = client if client is not None else _client()
    # Taken before the fetch, so fetch-then-write is atomic against another
    # process doing the same thing to the same subscription.
    await _lock_subscription(session, subscription_id)
    fetched = await _call(api.v1.subscriptions.retrieve, subscription_id)
    return await _apply(session, fetched, subscription_id=subscription_id)


async def _apply(
    session: AsyncSession, fetched: Any, *, subscription_id: str
) -> Subscription | None:
    """Write one fetched subscription onto our row. Call under the lock."""
    customer_id = _customer_id(fetched)
    spawn_user_id = _field(_field(fetched, "metadata") or {}, "spawn_user_id")

    # Three ways to find the account, in descending order of directness. Only
    # ever things Stripe holds because *we* put them there — never an email
    # address or anything else the event merely asserts.
    row = await _row_for_subscription(session, subscription_id)
    if row is None and customer_id:
        row = await _row_for_customer(session, customer_id)
    if row is None and isinstance(spawn_user_id, str) and spawn_user_id:
        row = await _row_for_user(session, spawn_user_id)
    if row is None:
        if not (isinstance(spawn_user_id, str) and spawn_user_id and customer_id):
            log.error(
                "stripe subscription %s resolves to no account here; ignoring",
                subscription_id,
            )
            return None
        user = await session.get(User, spawn_user_id)
        if user is None:
            log.error(
                "stripe subscription %s names user %s, who does not exist here",
                subscription_id,
                spawn_user_id,
            )
            return None
        row = Subscription(
            user_id=user.id,
            stripe_customer_id=customer_id,
            tier=billing.TIER_FREE,
            status="incomplete",
            host_limit=billing.host_limit_for_tier(billing.TIER_FREE),
        )
        session.add(row)

    state_at = _state_timestamp(fetched)
    stored_at = _aware(row.last_event_at)
    if state_at is not None and stored_at is not None and state_at < stored_at:
        log.info(
            "dropping stale stripe state for %s (%s is older than %s)",
            subscription_id,
            state_at.isoformat(),
            stored_at.isoformat(),
        )
        return row

    # OUR map, from the price id we fetched. Stripe's `price.metadata` says the
    # same thing and is a dashboard setting, so it is not consulted.
    tier = billing.tier_for_price_id(_price_id(fetched))
    row.stripe_subscription_id = subscription_id
    if customer_id:
        row.stripe_customer_id = customer_id
    row.tier = tier
    row.host_limit = billing.host_limit_for_tier(tier)
    # Verbatim, and truncated only to fit the column: a status we have never
    # seen before is worth storing rather than discarding, and `billing.py`
    # decides which ones entitle.
    row.status = str(_field(fetched, "status") or "incomplete")[:24]
    row.current_period_end = _period_end(fetched)
    row.cancel_at_period_end = bool(_field(fetched, "cancel_at_period_end", False))
    if state_at is not None:
        row.last_event_at = state_at
    await session.flush()
    return row


# ---------- reconciliation ----------


async def reconcile_all(session: AsyncSession, *, client: Any = None) -> int:
    """Re-read every paid subscription and rewrite it. Returns how many were read.

    The unglamorous half of the integration, and the one that closes the hole
    webhooks leave: an endpoint outage longer than Stripe's three days of
    retries, or a handler that answered 200 while doing nothing, is invisible
    otherwise. Drift is logged at warning level, because finding any is
    evidence a webhook was missed.

    Committed per subscription rather than in one transaction: the advisory
    lock is transaction-scoped, and holding one per row across the whole sweep
    would block every webhook for the duration of it.
    """
    if not stripe_ready():
        return 0
    api = client if client is not None else _client()

    rows = list(
        (
            await session.execute(
                select(Subscription).where(
                    Subscription.stripe_subscription_id.is_not(None),
                    Subscription.tier != billing.TIER_FREE,
                )
            )
        )
        .scalars()
        .all()
    )
    subscription_ids = [row.stripe_subscription_id for row in rows if row.stripe_subscription_id]
    before = {
        row.stripe_subscription_id: (row.tier, row.host_limit, row.status) for row in rows
    }
    await session.commit()

    read = 0
    for subscription_id in subscription_ids:
        try:
            applied = await fetch_and_apply_subscription(
                session, subscription_id=subscription_id, client=api
            )
        except StripeResourceMissing as exc:
            # Stripe answered and said it is gone. Louder than an outage,
            # because a paid row pointing at a subscription that does not exist
            # is drift a sweep cannot fix by trying again — somebody has to
            # look. It still does not abandon the rest of the sweep, and it
            # still changes nothing: the limit in our row stands until a human
            # or a real event moves it.
            await session.rollback()
            log.error("reconciliation found %s missing at Stripe: %s", subscription_id, exc)
            continue
        except StripeUnavailable as exc:
            # One unreadable subscription is not a reason to abandon the rest,
            # and it changes nothing: the limit in our row still stands.
            await session.rollback()
            log.warning("reconciliation could not read %s: %s", subscription_id, exc)
            continue
        if applied is None:
            await session.rollback()
            continue
        after = (applied.tier, applied.host_limit, applied.status)
        await session.commit()
        read += 1
        if before.get(subscription_id) != after:
            log.warning(
                "reconciliation corrected %s: %s -> %s (a webhook was missed)",
                subscription_id,
                before.get(subscription_id),
                after,
            )
    return read


async def run_reconciliation_once() -> int:
    """One sweep, in its own session. No-op when billing is off."""
    if not stripe_ready():
        return 0
    async with get_sessionmaker()() as session:
        return await reconcile_all(session)


_RECONCILIATION_TASK: asyncio.Task[None] | None = None


async def _reconciliation_loop() -> None:
    await asyncio.sleep(RECONCILIATION_FIRST_DELAY_SECONDS)
    while True:
        try:
            await run_reconciliation_once()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.warning("subscription reconciliation failed: %s", e)
        await asyncio.sleep(RECONCILIATION_INTERVAL_SECONDS)


def start_reconciliation_loop() -> None:
    """Start the sweep, if this deployment sells anything.

    Started nowhere but `main.py`'s lifespan, and started not at all when
    billing is off — a self-hosted process holds no timer, opens no session on
    a schedule, and has nothing running that mentions Stripe.
    """
    global _RECONCILIATION_TASK
    if not stripe_ready():
        return
    if _RECONCILIATION_TASK is not None and not _RECONCILIATION_TASK.done():
        return
    _RECONCILIATION_TASK = asyncio.create_task(_reconciliation_loop())


async def stop_reconciliation_loop() -> None:
    global _RECONCILIATION_TASK
    task = _RECONCILIATION_TASK
    _RECONCILIATION_TASK = None
    if task is None:
        return
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
