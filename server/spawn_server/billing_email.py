"""The six messages billing sends, and the only place they are sent from.

Email is the one billing surface allowed to name a price. The app itself never
does — the 402 body is machine codes and numbers (`billing.limit_error_detail`)
and the mobile copy is pure account state — because the mobile app renders
server strings verbatim inside a binary that shipped through App Review. A
message is not rendered by that binary, and Apple's 3.1.3 preamble says so in as
many words: *"Developers can send communications outside of the app to their
user base about purchasing methods other than in-app purchase."* So the tier
comparison and the link live here, and nowhere the app can draw them.

Three rules hold for every sender below, and each one exists because of what
calls them.

**Silent when billing is off, and silent when no mailer is configured.** A
self-hosted deployment has no subscription to write about; a deployment without
SMTP has no delivery path, and sending into one only writes a customer's plan
into a log. `auth.py:206-211` records the same principle for email
verification: a gate nobody can pass is an outage, not a control.

**Never raises**, structurally rather than by remembering to. These are called
from a Stripe webhook and from a device approval. An exception in the first
makes Stripe retry the event for three days; in the second it refuses somebody
their own machine because a mail server was slow. Neither is a trade worth
making for a message.

**The caller's transaction is finished before we are called.** `mail._record`
writes the delivery log on its own session, deliberately, so a caller still
holding a write lock would end up waiting on itself. Commit or roll back first;
`routes/device.py` does exactly that at both gates.

Every sender takes the caller's `session` whether it needs it or not, so no
caller has to remember which ones do. Only `send_host_limit_reached` reads it,
and it only reads.
"""

from __future__ import annotations

import functools
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import billing, email_templates, mail
from .config import get_settings
from .models import EmailLog, User

log = logging.getLogger(__name__)

# One `kind` per message, so `routes/admin.py`'s email visibility can tell a
# dunning notice from a welcome and an operator can answer "what did we send
# this person" without reading bodies.
KIND_STARTED = "billing_started"
KIND_PAYMENT_FAILED = "billing_payment_failed"
KIND_ACTION_REQUIRED = "billing_action_required"
KIND_PLAN_CHANGED = "billing_plan_changed"
KIND_ENDED = "billing_ended"
KIND_HOST_LIMIT = "billing_host_limit"

#: At most one host-limit mail per account per day. Somebody hammering
#: `spawnd possess` on a machine that cannot be registered is one person
#: hitting one wall, not twenty events worth telling them about.
HOST_LIMIT_INTERVAL = timedelta(hours=24)


def _never_raises[**P](fn: Callable[P, Awaitable[None]]) -> Callable[P, Awaitable[None]]:
    """Make "a mail failure is never the caller's problem" structural.

    Written as a decorator rather than a try block in each body because the
    guarantee has to cover everything, including reading `user.email` off an
    instance the caller expired — a lazy load from sync context raises, and it
    would raise from inside a webhook handler that must answer 200 or watch
    Stripe retry the event for three days.
    """

    @functools.wraps(fn)
    async def guarded(*args: P.args, **kwargs: P.kwargs) -> None:
        try:
            await fn(*args, **kwargs)
        except Exception as exc:
            log.warning("could not send the %s email: %s", fn.__name__, exc)

    return guarded


def _sending() -> bool:
    """Whether a billing email should leave the building at all.

    Both answers are ordinary states rather than faults: billing is off on
    every self-hosted deployment, and a deployment with no SMTP has nowhere to
    send. Read through the `mail` module rather than imported by name so a
    test can substitute it, which is how `tests/test_account_recovery.py`
    exercises the mail-dependent half of email verification.
    """

    if not get_settings().billing_enabled:
        return False
    return mail.mailer_ready()


def _site_url() -> str:
    return get_settings().billing_return_base


def _app_url() -> str:
    """Where Settings → Subscription lives. The cancel path, and the manage path."""

    return f"{_site_url()}/app"


def _plans_url() -> str:
    """The pricing page. Only ever linked from email, never from the app."""

    return f"{_site_url()}/pricing"


def _paid_plans() -> list[email_templates.PlanOption]:
    """The tier comparison, straight from `billing.TIERS`. Free is not an offer.

    Cheapest first, because `TIER_ORDER` is the order a pricing page lists
    them in and two places disagreeing about that is how a comparison table
    starts lying.
    """

    return [
        email_templates.PlanOption(
            name=tier.name,
            price_cents=tier.price_cents,
            host_limit=tier.host_limit,
        )
        for key in billing.TIER_ORDER
        if (tier := billing.TIERS[key]).price_cents > 0
    ]


async def _sent_within(
    session: AsyncSession, *, to: str, kind: str, window: timedelta
) -> bool:
    """Has a message of this kind gone to this address inside the window?

    Any row counts, including one `mail` recorded as failed or undelivered.
    The limit is on how often we *try*: a bouncing address that we retried
    twenty times is precisely the case this exists to stop.

    Exact match on the address rather than a case-folded one: `to_email` is
    indexed, and both sides come from the same `User.email`, which
    `auth.normalize_email` already lower-cased on the way in.
    """

    since = datetime.now(UTC) - window
    return (
        await session.execute(
            select(EmailLog.id)
            .where(
                EmailLog.kind == kind,
                EmailLog.to_email == to,
                EmailLog.created_at >= since,
            )
            .limit(1)
        )
    ).first() is not None


async def _deliver(user: User, rendered: email_templates.RenderedEmail, *, kind: str) -> None:
    await mail.send_email(
        to=user.email,
        subject=rendered.subject,
        body=rendered.text,
        html_body=rendered.html,
        kind=kind,
    )


@_never_raises
async def send_subscription_started(
    session: AsyncSession,
    user: User,
    *,
    tier_name: str,
    price_cents: int,
    current_period_end: datetime | None,
) -> None:
    """Confirm a subscription that has just become active.

    Not a nicety: EU and UK distance-selling rules want the terms of what was
    bought, in a durable medium, from the seller. Stripe's receipt records a
    payment and is a different document.
    """

    if not _sending():
        return
    rendered = email_templates.subscription_started(
        tier_name=tier_name,
        price_cents=price_cents,
        renewal_date=current_period_end,
        manage_url=_app_url(),
        site_url=_site_url(),
    )
    await _deliver(user, rendered, kind=KIND_STARTED)


@_never_raises
async def send_payment_failed(
    session: AsyncSession, user: User, *, portal_url: str | None
) -> None:
    """`invoice.payment_failed` — a declined card, not a revocation.

    Dunning is still running and `past_due` still entitles
    (`billing.ENTITLING_STATUSES`), so nothing has been lost at the moment
    this goes out.

    `portal_url` is the Stripe portal session the webhook handler minted, if
    it managed to; falling back to the app is better than a message that says
    "update your card" and offers nowhere to do it.
    """

    if not _sending():
        return
    rendered = email_templates.payment_failed(
        portal_url=portal_url or _app_url(),
        site_url=_site_url(),
    )
    await _deliver(user, rendered, kind=KIND_PAYMENT_FAILED)


@_never_raises
async def send_payment_action_required(
    session: AsyncSession, user: User, *, invoice_url: str | None
) -> None:
    """`invoice.payment_action_required` — the bank wants the cardholder.

    Only they can complete 3-D Secure, and only on the hosted invoice page, so
    this message is useless without the link. When Stripe gave us no
    `hosted_invoice_url` the app is the honest fallback: the same invoice is
    reachable from the portal, one step further along.
    """

    if not _sending():
        return
    rendered = email_templates.payment_action_required(
        invoice_url=invoice_url or _app_url(),
        site_url=_site_url(),
    )
    await _deliver(user, rendered, kind=KIND_ACTION_REQUIRED)


@_never_raises
async def send_plan_changed(
    session: AsyncSession,
    user: User,
    *,
    from_tier_name: str,
    to_tier_name: str,
    host_limit: int | None,
) -> None:
    """A plan moved, in either direction, and it moved immediately."""

    if not _sending():
        return
    rendered = email_templates.plan_changed(
        from_tier_name=from_tier_name,
        to_tier_name=to_tier_name,
        host_limit=host_limit,
        manage_url=_app_url(),
        site_url=_site_url(),
    )
    await _deliver(user, rendered, kind=KIND_PLAN_CHANGED)


@_never_raises
async def send_subscription_ended(
    session: AsyncSession, user: User, *, host_limit: int | None, host_count: int
) -> None:
    """A subscription cancelled or lapsed.

    `host_count` is carried so the message can say what the account is still
    holding. There is no suspend state and we are not building one, so the
    honest thing to report is that every machine is exactly where it was.
    """

    if not _sending():
        return
    rendered = email_templates.subscription_ended(
        host_limit=host_limit,
        host_count=host_count,
        plans_url=_plans_url(),
        site_url=_site_url(),
    )
    await _deliver(user, rendered, kind=KIND_ENDED)


@_never_raises
async def send_host_limit_reached(
    session: AsyncSession,
    user: User,
    *,
    tier_name: str,
    host_limit: int,
    host_count: int,
) -> None:
    """A machine was refused, and this is the only place we may say why in full.

    The conversion path from `docs/BILLING.md` §6.3. The app that produced the
    refusal says only what the account state is; this says what the plans cost
    and where to change one, because it is outside the app.

    Rate-limited to one a day per account. The refusal fires once per
    ceremony and a daemon that cannot register is often run again immediately,
    so the unlimited version of this is a person being mailed twenty times
    about one wall.
    """

    if not _sending():
        return
    if await _sent_within(
        session, to=user.email, kind=KIND_HOST_LIMIT, window=HOST_LIMIT_INTERVAL
    ):
        return
    rendered = email_templates.host_limit_reached(
        tier_name=tier_name,
        host_limit=host_limit,
        host_count=host_count,
        plans=_paid_plans(),
        upgrade_url=_plans_url(),
        site_url=_site_url(),
    )
    await _deliver(user, rendered, kind=KIND_HOST_LIMIT)
