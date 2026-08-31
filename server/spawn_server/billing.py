"""What a plan entitles an account to. The only module that knows.

Every enforcement point asks this module the same question — `may_add_host` —
and every surface that shows a plan reads the same answer — `billing_state` —
so the gate and the screen explaining the gate can never disagree about a
number. A tier's name, its price and the hosts it admits are defined once, in
`TIERS`, and nowhere else.

Pure functions and database reads. Nothing here imports `stripe`, opens a
socket, or has an opinion about a webhook. Entitlement is resolved from our own
tables, which is what keeps an existing customer pairing a host on a morning
when Stripe is unreachable: Stripe being down is not evidence that anybody
stopped paying. The map from a Stripe price id to a tier is ours too, never
Stripe's price metadata — that is editable by anyone with a dashboard login and
is not an authority.

`host_limit is None` means unlimited, here and everywhere else in this
codebase. The one place a `0` appears is `User.host_limit_override`, where the
column has no other way to spell "unlimited"; `entitlement()` translates it at
the boundary so nothing downstream has to know.

Nothing this module returns is prose. The 402 body is machine codes and
numbers, because the mobile app renders server strings verbatim inside a
binary that ships through an app review.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import Settings, get_settings
from .models import Host, Subscription, User

TIER_FREE = "free"
TIER_COVEN = "coven"
TIER_LEGION = "legion"
TIER_PANDEMONIUM = "pandemonium"

#: Cheapest first. The order a pricing page lists them in, and the order that
#: decides which of two tiers is the upgrade.
TIER_ORDER: tuple[str, ...] = (TIER_FREE, TIER_COVEN, TIER_LEGION, TIER_PANDEMONIUM)


@dataclass(frozen=True)
class Tier:
    """One plan: what it is called, how many hosts it admits, what it costs."""

    key: str
    #: What a person reads. "the Legion plan" is spelled out because `/legion`
    #: is already the fleet page and `Legion` alone in a billing sentence reads
    #: as that page rather than as a plan.
    name: str
    #: None = unlimited.
    host_limit: int | None
    #: Monthly, USD, in cents. Display only — Stripe charges what its own price
    #: object says, and this number never reaches a payment.
    price_cents: int


TIERS: dict[str, Tier] = {
    TIER_FREE: Tier(key=TIER_FREE, name="Free", host_limit=1, price_cents=0),
    TIER_COVEN: Tier(key=TIER_COVEN, name="Coven", host_limit=3, price_cents=500),
    TIER_LEGION: Tier(
        key=TIER_LEGION, name="the Legion plan", host_limit=20, price_cents=2000
    ),
    TIER_PANDEMONIUM: Tier(
        key=TIER_PANDEMONIUM, name="Pandemonium", host_limit=None, price_cents=5000
    ),
}

#: Stripe subscription statuses that grant entitlement. `past_due` is
#: deliberately included: Stripe's dunning runs for weeks, and a card that
#: failed this morning is not a reason to refuse somebody a host this
#: afternoon. Entitlement ends at `canceled` or `unpaid`, which is where Stripe
#: has itself given up.
ENTITLING_STATUSES = frozenset({"active", "trialing", "past_due"})


@dataclass(frozen=True)
class Entitlement:
    """A resolved limit, and where the number came from."""

    tier: str
    #: None = unlimited.
    host_limit: int | None
    #: "billing_disabled" | "comped" | "subscription" | "free". Carried so a
    #: support answer, a log line and a status screen can all say why without
    #: re-deriving it.
    reason: str


@dataclass(frozen=True)
class Decision:
    """The answer to "may this account take one more host", and its arithmetic."""

    allowed: bool
    entitlement: Entitlement
    host_count: int

    @property
    def host_limit(self) -> int | None:
        return self.entitlement.host_limit

    @property
    def tier(self) -> str:
        return self.entitlement.tier


def tier_for_price_id(price_id: str | None, settings: Settings | None = None) -> str:
    """Our own price-id → tier map. Anything unrecognised is Free.

    The only supported way to learn what a subscription is worth. Stripe's
    `price.metadata.host_limit` says the same thing and is not consulted: it
    is editable in a dashboard by anyone with access, so trusting it would
    make a plan's value a UI setting rather than a fact about our config.

    Failing closed to Free is the point. A price id we do not recognise is a
    subscription to something this deployment does not sell — a leftover from
    a renamed product, or a test-mode id against a live key — and reading it
    as "unlimited" would be the wrong guess in the expensive direction.
    """
    if not price_id:
        return TIER_FREE
    settings = settings or get_settings()
    for tier, configured in (
        (TIER_COVEN, settings.stripe_price_coven),
        (TIER_LEGION, settings.stripe_price_legion),
        (TIER_PANDEMONIUM, settings.stripe_price_pandemonium),
    ):
        if configured and configured == price_id:
            return tier
    return TIER_FREE


def price_id_for_tier(tier: str, settings: Settings | None = None) -> str | None:
    """The configured price id for a tier, or None for Free and the unknown.

    The inverse of `tier_for_price_id`, and the reason a client may name a tier
    but never a price: a caller who could name a price could name a $0 one.
    """
    settings = settings or get_settings()
    return {
        TIER_COVEN: settings.stripe_price_coven,
        TIER_LEGION: settings.stripe_price_legion,
        TIER_PANDEMONIUM: settings.stripe_price_pandemonium,
    }.get(tier) or None


def host_limit_for_tier(tier: str) -> int | None:
    """How many hosts a tier admits; None = unlimited. Unknown tiers get Free's."""
    return TIERS.get(tier, TIERS[TIER_FREE]).host_limit


async def _subscription(session: AsyncSession, user_id: str) -> Subscription | None:
    return (
        await session.execute(select(Subscription).where(Subscription.user_id == user_id))
    ).scalar_one_or_none()


async def _resolve(
    session: AsyncSession, user: User
) -> tuple[Entitlement, Subscription | None]:
    """`entitlement()` plus the row it read, so a caller needing both reads once."""
    settings = get_settings()
    if not settings.billing_enabled:
        # Self-hosted, and the branch most deployments never leave. No limit,
        # and no new column consulted — the subscription table is not even
        # queried, so a deployment that has never run the migration behaves.
        return Entitlement(tier=TIER_FREE, host_limit=None, reason="billing_disabled"), None

    subscription = await _subscription(session, user.id)

    override = user.host_limit_override
    if override is not None:
        # Outranks any subscription, so a comped account with a lapsed card is
        # unaffected — and a comped account never sees billing at all.
        return (
            Entitlement(
                tier=subscription.tier if subscription is not None else TIER_FREE,
                host_limit=None if override == 0 else override,
                reason="comped",
            ),
            subscription,
        )

    if subscription is not None and subscription.status in ENTITLING_STATUSES:
        return (
            Entitlement(
                tier=subscription.tier,
                host_limit=subscription.host_limit,
                reason="subscription",
            ),
            subscription,
        )

    return (
        Entitlement(tier=TIER_FREE, host_limit=TIERS[TIER_FREE].host_limit, reason="free"),
        subscription,
    )


async def entitlement(session: AsyncSession, user: User) -> Entitlement:
    """How many hosts this account may hold, and why. First match wins:

    1. Billing disabled → unlimited, tier Free, reason `billing_disabled`.
    2. `user.host_limit_override` set → that number (0 = unlimited), the tier
       from any subscription row, reason `comped`.
    3. A subscription whose status entitles → its limit and tier, reason
       `subscription`.
    4. Otherwise → 1, tier Free, reason `free`.

    Note what is *not* here: nothing reads Stripe, and a cancelled or unpaid
    subscription simply falls through to Free rather than being an error.
    """
    granted, _ = await _resolve(session, user)
    return granted


async def host_count(session: AsyncSession, user_id: str) -> int:
    """How many hosts this account holds.

    Never count via `host_key_claims`. Deleting a host frees the slot
    immediately but deliberately *retains* the key claim
    (`routes/hosts.py`), so that a machine can only ever come back to the same
    account — which means a user who has deleted forty hosts still holds forty
    claims. `hosts` is the only correct count: there is no soft delete and no
    archived flag, and an offline host still occupies a slot, which is right,
    because an offline host is just a laptop that is shut.
    """
    return int(
        (
            await session.execute(
                select(func.count()).select_from(Host).where(Host.owner_user_id == user_id)
            )
        ).scalar_one()
    )


async def lock_account(session: AsyncSession, user_id: str) -> None:
    """Serialise this account's pairings against each other, in the caller's transaction.

    Two ceremonies completing at the same moment would otherwise both read
    `count == limit - 1` and both insert, putting a Free account on two hosts.
    The existing host-key-claim fence serialises only against the *same* key,
    not against a different machine being paired by the same person a
    millisecond later.

    `FOR NO KEY UPDATE`, not `FOR UPDATE`, and the difference is the whole
    function working. The transaction that asks this question has already
    inserted into `host_key_claims`, whose foreign key makes PostgreSQL take
    `FOR KEY SHARE` on this same `users` row — so a plain `FOR UPDATE` waits
    on the key share every *other* concurrent pairing is holding, and two
    daemons pairing at once deadlock outright. `FOR NO KEY UPDATE` does not
    conflict with `FOR KEY SHARE`, and still conflicts with itself, which is
    exactly the mutual exclusion this exists for. It is also the honest lock:
    nothing here modifies the row's key.

    SQLAlchemy's SQLite dialect emits no locking clause at all, which is
    correct rather than a gap: the in-memory database the suite runs against
    has one connection and cannot exhibit the race. It also means this line
    cannot be checked by the default test run — see the PostgreSQL half of the
    pair in `tests/test_billing_enforcement.py`.
    """
    await session.execute(
        select(User.id).where(User.id == user_id).with_for_update(key_share=True)
    )


async def may_add_host(
    session: AsyncSession, user: User, *, lock: bool = False
) -> Decision:
    """The single question every enforcement point asks.

    The limit governs admitting a *new* host and never using an existing one,
    so callers ask this only where a `Host` row would come into being — a
    re-pair of a machine that already has a row is not a new host and must
    never be refused.

    `lock=True` takes `lock_account()` first, so the count is read under a row
    lock. Pass it wherever the answer is about to be acted on inside a
    transaction that will insert.
    """
    if lock:
        await lock_account(session, user.id)
    granted = await entitlement(session, user)
    count = await host_count(session, user.id)
    allowed = granted.host_limit is None or count < granted.host_limit
    return Decision(allowed=allowed, entitlement=granted, host_count=count)


def limit_error_detail(decision: Decision) -> dict:
    """The 402 body: a machine code and three numbers.

    No prose, no link, no price, no verb. The mobile app renders server
    strings verbatim inside a binary that ships through app review, and a
    sentence here would put purchase copy into that binary from the server
    side. Clients own every word a person reads about this; the server owns
    only the facts they are written from.
    """
    return {
        "code": "host_limit",
        "tier": decision.tier,
        "host_limit": decision.host_limit,
        "host_count": decision.host_count,
    }


async def billing_state(session: AsyncSession, user: User) -> dict:
    """Everything a client needs to draw a status surface. Safe when billing is off.

    With billing disabled this reports an unlimited Free plan and no
    subscription, without touching the subscription table at all — a
    self-hosted deployment has no billing state to read.
    """
    granted, subscription = await _resolve(session, user)
    count = await host_count(session, user.id)
    tier = TIERS.get(granted.tier, TIERS[TIER_FREE])
    period_end = subscription.current_period_end if subscription is not None else None
    return {
        "tier": granted.tier,
        "tier_name": tier.name,
        "host_limit": granted.host_limit,
        "host_count": count,
        # Reachable without anyone doing anything wrong: a downgrade is always
        # allowed, so an account can sit above its limit until it sheds hosts.
        "over_limit": granted.host_limit is not None and count > granted.host_limit,
        "status": subscription.status if subscription is not None else None,
        "current_period_end": period_end.isoformat() if period_end is not None else None,
        "cancel_at_period_end": (
            bool(subscription.cancel_at_period_end) if subscription is not None else False
        ),
        "has_subscription": subscription is not None,
        "reason": granted.reason,
    }
