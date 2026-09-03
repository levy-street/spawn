"""`/api/billing` — the plan surface, and the webhook that is the only grant path.

Every route here returns 404 when `settings.billing_enabled` is false, in the
shape `require_admin` established (`admin.py:35-40`): a deployment that does not
sell anything should not have a discoverable billing API, and a self-hoster
probing this prefix should learn nothing from the answer. The 404 is the whole
of the feature's invisibility — there is no flag to read, no empty catalogue and
no "billing is disabled" body.

The division of labour is worth stating once, because it is the point of the
design:

- `billing.py` says what an account is entitled to, from our own tables. It is
  the authority at enforcement time and does not depend on Stripe answering.
- `billing_stripe.py` is the only module that talks to Stripe.
- This file is HTTP: authentication, rate limits, machine-readable refusals,
  and the webhook's status codes, which are how a retry is asked for.

Nothing a client sends decides a price. `/checkout` and `/change-plan` take a
tier *name* and the server maps it to a price id from its own configuration; a
caller who could name a price could name a $0 one.

No string this file emits carries a URL, a price, or a purchase verb — with the
one deliberate exception of the `url` field on `/checkout` and `/portal`, which
is Stripe's own hosted page and the entire point of those calls. The mobile app
renders `ApiError.message` verbatim inside a binary that ships through app
review, so an error body here is machine codes and numbers and the client owns
every word a person reads.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, billing, billing_stripe, rate_limit
from ..config import get_settings
from ..db import get_session, get_sessionmaker
from ..models import StripeEvent, Subscription, User

log = logging.getLogger(__name__)


async def require_billing() -> None:
    """404 unless this deployment sells subscriptions.

    A router-level dependency, so it covers the webhook too: an endpoint that
    accepts Stripe events on an install that has no Stripe account is a
    surface with no reason to exist.
    """
    if not get_settings().billing_enabled:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")


router = APIRouter(
    prefix="/api/billing",
    tags=["billing"],
    dependencies=[Depends(require_billing)],
    # Absent from `/openapi.json` on every deployment, billing or not. The
    # schema is built from the registered routes and cannot consult a
    # per-request dependency, so a router that is in it is a router a
    # self-hosted install advertises — which is exactly the discoverability the
    # 404 exists to deny. Both frontends are written from `docs/BILLING.md`
    # rather than from the schema, so nothing is lost by it.
    include_in_schema=False,
    # A 3xx is a failure to Stripe: it records the delivery as failed and
    # retries for three days. This flag says so, but note that it does NOT do
    # the work on its own — `include_router` copies these routes into the app's
    # router, and it is *that* router's `redirect_slashes` that decides at match
    # time. What actually makes a redirect impossible is that the webhook is
    # registered at both spellings below, so neither can fall through to the
    # not-found path that would issue the 307. `infra/nginx-spawnd.conf.example`
    # proxies `location /` with the URI untouched and normalises nothing.
    redirect_slashes=False,
)


# Per-user rather than per-IP: these are all authenticated, and
# `enforce_identifier` exists for exactly the case where a trusted caller id is
# a better bucket than an address behind a proxy. Generous enough that nobody
# clicking around Settings ever meets one, tight enough that a script cannot
# make thousands of Checkout Sessions on our Stripe account.
#
# Declared here rather than in `rate_limit.py` beside `SIGNUP` and friends
# because that module is shared and this is the only consumer; the shape and
# the naming follow it exactly.
CHECKOUT = rate_limit.RateLimit("billing_checkout", limit=10, window_seconds=3600)
PORTAL = rate_limit.RateLimit("billing_portal", limit=20, window_seconds=3600)
CHANGE_PLAN = rate_limit.RateLimit("billing_change_plan", limit=10, window_seconds=3600)

#: Exactly the events subscribed to in the dashboard. Anything else is a 200
#: and nothing else — an unhandled type is not an error, and answering
#: otherwise would have Stripe retrying an event we have no use for.
#:
#: `invoice.created` is deliberately absent. Failing to return 200 to it delays
#: finalising every automatic-collection invoice for up to 72 hours, which
#: turns a bug in this handler into a fleet-wide billing outage, for an event
#: this server does nothing with.
HANDLED_EVENTS = frozenset(
    {
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded",
        "checkout.session.async_payment_failed",
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
        "invoice.paid",
        "invoice.payment_failed",
        "invoice.payment_action_required",
        "invoice.finalization_failed",
    }
)

#: The tiers a client may name. Free is absent because there is no Checkout
#: Session for it — leaving a plan is a cancellation, not a purchase of nothing.
PaidTier = Literal["coven", "legion", "pandemonium"]


# ---------- shapes ----------
#
# Local rather than in `schemas.py`: these are read by the billing surfaces and
# nothing else, and `schemas.py` is already the widest file in the server.


class BillingTierOut(BaseModel):
    """One plan as a pricing surface lists it. Display only; nothing charges from here."""

    key: str
    #: Display name, as the person reads it ("Coven", "Legion", "Pandemonium").
    name: str
    #: Monthly, USD, in cents.
    price_cents: int
    #: None = unlimited.
    host_limit: int | None = None


class BillingStateOut(BaseModel):
    """Everything a status surface draws, in one read.

    The same numbers `billing.may_add_host` enforces, from the same function,
    so the gate and the screen explaining the gate cannot disagree.
    """

    tier: str
    tier_name: str
    host_limit: int | None = None
    host_count: int
    over_limit: bool
    status: str | None = None
    current_period_end: str | None = None
    cancel_at_period_end: bool
    has_subscription: bool
    #: "billing_disabled" | "comped" | "subscription" | "free".
    reason: str
    #: The catalogue, cheapest first, so a client never sorts it itself.
    tiers: list[BillingTierOut]


class RedirectOut(BaseModel):
    """A Stripe-hosted page to send the browser to.

    The one place a URL is a legitimate part of a billing response body: it is
    Stripe's own page and returning it is the entire purpose of the call.
    """

    url: str


class TierIn(BaseModel):
    """A tier name and nothing else.

    `extra="forbid"` is load-bearing rather than tidy. A body that could carry
    a `price`, an `amount` or a `quantity` is a body somebody will eventually
    try to make the server read, and refusing unknown keys outright means
    there is never a version of this that half-honours one.
    """

    model_config = ConfigDict(extra="forbid")

    tier: PaidTier


def _catalogue() -> list[BillingTierOut]:
    return [
        BillingTierOut(
            key=tier.key,
            name=tier.name,
            price_cents=tier.price_cents,
            host_limit=tier.host_limit,
        )
        for tier in (billing.TIERS[key] for key in billing.TIER_ORDER)
    ]


async def _state(session: AsyncSession, user: User) -> BillingStateOut:
    return BillingStateOut(**await billing.billing_state(session, user), tiers=_catalogue())


def _unavailable() -> HTTPException:
    """503 when Stripe will not answer.

    Prose, because this one is genuinely an outage report rather than a
    statement about a plan — but prose with no link, no price and no verb
    aimed at the reader, because the phone renders it verbatim.

    The second sentence is the important one and is true: entitlement is read
    from our own tables at every enforcement point, so an existing customer
    goes on pairing hosts throughout this. A gate nobody can pass is an outage,
    not a control.
    """
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="the billing provider is not answering; this account is unchanged",
    )


# ---------- reads ----------


@router.get("/state", response_model=BillingStateOut)
async def read_state(
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> BillingStateOut:
    """The one read every surface uses. No Stripe call, so it cannot be slow or fail.

    `current_user` rather than `verified_user`: reading what you are entitled
    to is not spending anything, and an unverified account still has a plan.
    """
    return await _state(session, user)


# ---------- the money paths ----------


@router.post("/checkout", response_model=RedirectOut)
async def start_checkout(
    body: TierIn,
    user: User = Depends(auth.verified_user),
    session: AsyncSession = Depends(get_session),
) -> RedirectOut:
    """A hosted Checkout Session for a tier the caller names. Returns its URL.

    Refuses when the account already has an entitling subscription. Two live
    subscriptions on one account is a double charge and a support incident, and
    the fix is a plan change rather than a second purchase — the 409's code
    says which.
    """
    await rate_limit.enforce_identifier(user.id, CHECKOUT)

    existing = await _subscription_row(session, user.id)
    if existing is not None and existing.status in billing.ENTITLING_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "subscription_exists", "tier": existing.tier},
        )

    try:
        url = await billing_stripe.create_checkout_session(
            session, user, tier=body.tier
        )
    except billing_stripe.StripeUnavailable as exc:
        # Logged before the rollback, never after: a rollback expires every
        # instance in the session, and reading `user.id` off an expired one
        # would be a lazy refresh from an async context — which raises, and
        # would turn a clean 503 into a 500.
        log.warning("checkout session for %s could not be created: %s", user.id, exc)
        await session.rollback()
        raise _unavailable() from exc
    await session.commit()
    return RedirectOut(url=url)


@router.post("/portal", response_model=RedirectOut)
async def start_portal(
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> RedirectOut:
    """A Customer Portal session — card, invoices, cancellation.

    `current_user`, not `verified_user`. Verification guards first spending, and
    somebody who is already paying must be able to reach their own invoices and
    cancel, whatever state their email address is in. A gate on the way *out*
    of a subscription is not a gate we get to have.
    """
    await rate_limit.enforce_identifier(user.id, PORTAL)
    try:
        url = await billing_stripe.create_portal_session(session, user)
    except billing_stripe.StripeUnavailable as exc:
        log.warning("portal session for %s could not be created: %s", user.id, exc)
        await session.rollback()
        raise _unavailable() from exc
    await session.commit()
    return RedirectOut(url=url)


@router.post("/upgrade", response_model=RedirectOut)
async def upgrade(
    body: TierIn,
    user: User = Depends(auth.verified_user),
    session: AsyncSession = Depends(get_session),
) -> RedirectOut:
    """A move to another tier, confirmed and paid for on a Stripe-hosted page.

    The client sends anyone moving *up* here and anyone moving *down* to
    `change-plan`, because a downgrade has to run the host-selection step
    first and never costs anything, while an upgrade costs money the person
    should see before it is taken. The same precondition guards both all the
    same: a target that would not hold what the account has is refused with
    `host_selection_required`, so this can never be a back door around it.
    """
    await rate_limit.enforce_identifier(user.id, CHANGE_PLAN)

    existing = await _subscription_row(session, user.id)
    if (
        existing is None
        or not existing.stripe_subscription_id
        or existing.status not in billing.ENTITLING_STATUSES
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "subscription_required"},
        )

    target_limit = billing.host_limit_for_tier(body.tier)
    count = await billing.host_count(session, user.id)
    if target_limit is not None and count > target_limit:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "host_selection_required",
                "tier": body.tier,
                "host_limit": target_limit,
                "host_count": count,
            },
        )

    try:
        url = await billing_stripe.create_plan_change_confirmation(
            session, user, tier=body.tier
        )
    except billing_stripe.SubscriptionMissing as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "subscription_required"},
        ) from exc
    except billing_stripe.StripeNotConfigured as exc:
        log.error("plan change for %s cannot be offered: %s", user.id, exc)
        raise _unavailable() from exc
    except billing_stripe.StripeUnavailable as exc:
        log.warning("plan change page for %s could not be created: %s", user.id, exc)
        raise _unavailable() from exc
    await session.commit()
    return RedirectOut(url=url)


@router.post("/change-plan", response_model=BillingStateOut)
async def change_plan(
    body: TierIn,
    user: User = Depends(auth.verified_user),
    session: AsyncSession = Depends(get_session),
) -> BillingStateOut:
    """Move an existing subscription to another tier, immediately.

    The precondition is the whole of the downgrade story: if the account holds
    more hosts than the target tier admits, this refuses with 409
    `host_selection_required` and the three numbers a client needs to draw the
    choice. **The server never releases a host on a billing signal.** The
    client releases the hosts the user picked through the ordinary
    `DELETE /api/hosts/{id}`, which frees each slot synchronously, retains the
    `HostKeyClaim` so the machine can only ever return to this account, and
    closes the live daemon socket with `4001 "host revoked"` — then retries
    this call.

    Releasing before the Stripe call is deliberate. A payment that then fails
    leaves them on the old plan with fewer hosts: recoverable and honest,
    rather than on a cheaper plan while still over its limit.
    """
    await rate_limit.enforce_identifier(user.id, CHANGE_PLAN)

    existing = await _subscription_row(session, user.id)
    if (
        existing is None
        or not existing.stripe_subscription_id
        or existing.status not in billing.ENTITLING_STATUSES
    ):
        # There is nothing to move. The client's next step is `/checkout`, and
        # the code says so without saying anything a person reads.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "subscription_required"},
        )

    target_limit = billing.host_limit_for_tier(body.tier)
    count = await billing.host_count(session, user.id)
    if target_limit is not None and count > target_limit:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "host_selection_required",
                "tier": body.tier,
                "host_limit": target_limit,
                "host_count": count,
            },
        )

    try:
        await billing_stripe.change_plan(session, user, tier=body.tier)
    except billing_stripe.SubscriptionMissing as exc:
        # Raced with a cancellation between the check above and the call.
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "subscription_required"},
        ) from exc
    except billing_stripe.StripeUnavailable as exc:
        log.warning("plan change for %s could not be applied: %s", user.id, exc)
        await session.rollback()
        raise _unavailable() from exc

    state = await _state(session, user)
    await session.commit()
    return state


# ---------- the webhook ----------


@dataclass(frozen=True)
class _PlanSnapshot:
    """What an account was entitled to, captured as values before a write.

    Plain values rather than the row, because the row is about to be rewritten
    in place and a "before" that is the same object as the "after" compares
    equal to itself forever.
    """

    entitling: bool
    tier: str
    host_limit: int | None

    @classmethod
    def of(cls, row: Subscription | None) -> _PlanSnapshot:
        if row is None:
            return cls(entitling=False, tier=billing.TIER_FREE, host_limit=None)
        return cls(
            entitling=row.status in billing.ENTITLING_STATUSES,
            tier=row.tier,
            host_limit=row.host_limit,
        )


async def _subscription_row(session: AsyncSession, user_id: str) -> Subscription | None:
    return (
        await session.execute(select(Subscription).where(Subscription.user_id == user_id))
    ).scalar_one_or_none()


_mail_tasks: set[asyncio.Task[None]] = set()


def _schedule_billing_mail(
    user_id: str, send: Callable[[Any, AsyncSession, User], Awaitable[None]]
) -> None:
    """Send one billing email out of band, on the `push.py:201-229` pattern.

    Fire-and-forget for two reasons. Checkout waits up to ten seconds for this
    handler's response with a customer watching, so an SMTP round-trip does not
    belong in it; and a mail failure must never fail a webhook, because Stripe
    would retry a delivery that already applied correctly.

    Its own session, because the request's is closed the moment the response
    is sent. Everything the template needs is captured by the caller's closure
    before then.
    """

    async def deliver() -> None:
        try:
            from .. import billing_email
        except ImportError:  # pragma: no cover - the module ships with this one
            log.warning("no billing mail module; nothing was sent for %s", user_id)
            return
        try:
            async with get_sessionmaker()() as mail_session:
                user = await mail_session.get(User, user_id)
                if user is None:
                    return
                await send(billing_email, mail_session, user)
        except Exception as e:  # noqa: BLE001
            log.warning("billing mail for %s failed: %s", user_id, e)

    try:
        task = asyncio.create_task(deliver())
    except RuntimeError:
        return
    _mail_tasks.add(task)
    task.add_done_callback(_mail_tasks.discard)


@router.post("/webhook", include_in_schema=False)
# The same handler at the trailing-slash spelling, so a request for either can
# never reach the not-found path that would answer with a 307. Stripe is
# configured with the first one; this exists so that a proxy or a typo cannot
# turn every event into a redirect Stripe reads as a failed delivery.
@router.post("/webhook/", include_in_schema=False)
async def stripe_webhook(
    request: Request, session: AsyncSession = Depends(get_session)
) -> Response:
    """Stripe's events. **Entitlement is granted here and nowhere else.**

    Never from the `success_url` redirect: that is a URL the user can visit at
    will, and treating a browser arriving at it as proof of payment is the
    classic way to give a paid tier away. The success page is a page.

    The body is read as raw bytes and verified before anything else looks at
    it. No Pydantic model is declared on this handler and `request.json()` is
    never called first — either re-serialises the payload and breaks an HMAC
    over content that is otherwise identical.

    `SessionRenewalMiddleware` (`main.py:51`) is a pure ASGI *response* hook:
    it wraps `send` and never touches `receive`, so the raw body arrives
    intact and no exemption is needed today. **If a request-reading middleware
    is ever added to this app, this route must be excluded from it.**

    The status code is the only thing Stripe reads, and it is a retry
    instruction:

    - **400** — the signature did not verify. It is not from Stripe, or a
      rotation went wrong, and either deserves an alarm rather than a retry.
    - **200** — applied, already applied, an event type we do not handle, an
      object Stripe says does not exist, or a deterministic bug of our own.
      Three days of retries against a `KeyError` delays nothing but our own
      fix, so the last two are logged loudly and answered cheerfully.
    - **500** — the database or the Stripe API would not answer. This is the
      one we want retried, so nothing is committed on the way out and the
      dedupe row goes back with it.
    """
    raw = await request.body()
    signature = request.headers.get("stripe-signature", "")
    try:
        event = billing_stripe.verify_event(
            raw, signature, billing_stripe.webhook_secrets()
        )
    except billing_stripe.SignatureVerificationError as exc:
        log.warning("rejected a billing webhook with an unverifiable signature: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail={"code": "bad_signature"}
        ) from exc
    except ValueError as exc:
        log.warning("rejected an unparseable billing webhook body")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail={"code": "bad_payload"}
        ) from exc

    event_id = str(event["id"])
    event_type = str(event["type"])

    # Insert first and let the primary key decide, which is atomic in a way
    # that read-then-write is not. Flushed rather than committed: if the work
    # below fails we roll this back with it, so the retry we ask for is not
    # deduped into a no-op by our own record of having failed.
    session.add(StripeEvent(id=event_id[:64], type=event_type[:64]))
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        log.info("billing webhook %s (%s) was already applied", event_id, event_type)
        return Response(status_code=status.HTTP_200_OK)

    if event_type not in HANDLED_EVENTS:
        await session.commit()
        return Response(status_code=status.HTTP_200_OK)

    try:
        await _handle(
            session,
            event_type=event_type,
            obj=event["data"]["object"],
            observed_at=billing_stripe.event_observed_at(event),
        )
    except billing_stripe.StripeResourceMissing as exc:
        # Not an outage, so not a retry. The object this event names is not
        # there and will not be there in three days either — an event delivered
        # after a sandbox object was deleted, or a key rotated to another
        # account while an endpoint kept its backlog. Answer 200 so Stripe
        # stops, and say so where somebody will see it.
        await session.rollback()
        log.error(
            "billing webhook %s (%s) names a Stripe object that does not exist: %s",
            event_id,
            event_type,
            exc,
        )
        return Response(status_code=status.HTTP_200_OK)
    except billing_stripe.StripeUnavailable as exc:
        await session.rollback()
        log.warning("billing webhook %s (%s) could not reach Stripe: %s", event_id, event_type, exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail={"code": "retry"}
        ) from exc
    except SQLAlchemyError as exc:
        await session.rollback()
        log.warning("billing webhook %s (%s) could not be stored: %s", event_id, event_type, exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail={"code": "retry"}
        ) from exc
    except Exception:  # noqa: BLE001
        await session.rollback()
        log.exception(
            "billing webhook %s (%s) hit a bug of ours; answering 200 so Stripe stops",
            event_id,
            event_type,
        )
        return Response(status_code=status.HTTP_200_OK)

    await session.commit()
    return Response(status_code=status.HTTP_200_OK)


async def _handle(
    session: AsyncSession,
    *,
    event_type: str,
    obj: Any,
    observed_at: datetime | None = None,
) -> None:
    """One handled event. Everything that grants or removes entitlement is here.

    `observed_at` is the event's own clock, handed to the apply step so the
    state it re-fetches counts as at least that fresh (see
    `billing_stripe.event_observed_at`).
    """
    if event_type == "invoice.finalization_failed":
        # Nobody sees this one. The subscription stays active and the invoice
        # simply cannot be collected, so it is silent revenue loss with no
        # user-visible symptom — it alerts us, not the customer, and it is not
        # a reason to change what anyone is entitled to.
        invoice_id, customer_id = billing_stripe.invoice_identity(obj)
        log.error(
            "stripe could not finalize an invoice (%s, customer %s); it will not be collected",
            invoice_id,
            customer_id,
        )
        return

    if event_type == "checkout.session.async_payment_failed":
        # A delayed-notification method that did not clear. No subscription
        # was ever entitling, so there is nothing to take away.
        log.warning(
            "a checkout session failed to collect (account %s)",
            billing_stripe.checkout_user_id(obj),
        )
        return

    subscription_id = billing_stripe.subscription_id_from_event(event_type, obj)
    if not subscription_id:
        # A checkout session for something that is not a subscription, or an
        # invoice with no subscription behind it. Handled, and a no-op.
        log.info("billing webhook %s names no subscription; nothing to apply", event_type)
        return

    previous = (
        await session.execute(
            select(Subscription).where(
                Subscription.stripe_subscription_id == subscription_id
            )
        )
    ).scalar_one_or_none()
    before = _PlanSnapshot.of(previous)

    row = await billing_stripe.fetch_and_apply_subscription(
        session, subscription_id=subscription_id, observed_at=observed_at
    )
    if row is None:
        return
    after = _PlanSnapshot.of(row)
    user_id = row.user_id

    if (
        before.entitling
        and billing.tier_rank(after.tier) > billing.tier_rank(before.tier)
        and row.cancel_at_period_end
    ):
        # Policy, not a Stripe default: moving UP a plan turns auto-renew back
        # on. Somebody who scheduled a cancellation on Coven and then paid to
        # move to Legion has plainly changed their mind about leaving, and a
        # plan that quietly ended anyway a month later is the surprise every
        # other subscription product avoids. Done here, on the observation,
        # so it holds whichever page the upgrade came through. `before` has
        # to have been a paid plan: a subscription first seen while already
        # ending did not move up, it merely arrived.
        log.info("subscription %s moved up while scheduled to end; resuming it", subscription_id)
        resumed = await billing_stripe.resume_scheduled_cancellation(
            session, subscription_id=subscription_id, observed_at=observed_at
        )
        if resumed is not None:
            row = resumed
            after = _PlanSnapshot.of(row)

    if event_type == "invoice.payment_action_required":
        invoice_url = billing_stripe.hosted_invoice_url(obj)
        _schedule_billing_mail(
            user_id,
            lambda mail, s, u: mail.send_payment_action_required(
                s, u, invoice_url=invoice_url
            ),
        )
    elif event_type == "invoice.payment_failed":
        _schedule_billing_mail(user_id, _payment_failed_mail)

    # The plan diff, against OUR stored limit rather than the event's
    # `previous_attributes` — which is absent on `customer.subscription.deleted`
    # (and a cancellation is a downgrade) and absent when reconciliation finds
    # drift. Two detection paths that can disagree is how an account silently
    # keeps a limit it no longer pays for.
    if after.entitling and not before.entitling:
        tier = billing.TIERS.get(after.tier, billing.TIERS[billing.TIER_FREE])
        period_end = row.current_period_end
        _schedule_billing_mail(
            user_id,
            lambda mail, s, u: mail.send_subscription_started(
                s,
                u,
                tier_name=tier.name,
                price_cents=tier.price_cents,
                current_period_end=period_end,
            ),
        )
    elif after.entitling and before.entitling and after.tier != before.tier:
        from_name = billing.TIERS.get(before.tier, billing.TIERS[billing.TIER_FREE]).name
        to_name = billing.TIERS.get(after.tier, billing.TIERS[billing.TIER_FREE]).name
        host_limit = after.host_limit
        _schedule_billing_mail(
            user_id,
            lambda mail, s, u: mail.send_plan_changed(
                s,
                u,
                from_tier_name=from_name,
                to_tier_name=to_name,
                host_limit=host_limit,
            ),
        )
    elif before.entitling and not after.entitling:
        # What they hold now and what they may hold: the two numbers the mail
        # needs to explain that nothing has been deleted and nothing will be
        # until they choose. Resolved through `billing`, so the mail quotes the
        # same limit the gate will apply — including a comped override.
        user = await session.get(User, user_id)
        if user is not None:
            granted = await billing.entitlement(session, user)
            count = await billing.host_count(session, user_id)
            _schedule_billing_mail(
                user_id,
                lambda mail, s, u: mail.send_subscription_ended(
                    s, u, host_limit=granted.host_limit, host_count=count
                ),
            )


async def _payment_failed_mail(mail: Any, session: AsyncSession, user: User) -> None:
    """The declined-card mail, with a way back to the card if one can be minted.

    Not a revocation notice: `past_due` still entitles, because Stripe's
    dunning runs for weeks and a card that failed this morning is not a reason
    to refuse somebody a host this afternoon.

    The portal link is best-effort and may be absent — Stripe's portal URLs are
    short-lived, and this runs outside the request that could have failed, so
    a Stripe outage here costs a link and not the mail.
    """
    portal_url: str | None = None
    try:
        portal_url = await billing_stripe.create_portal_session(session, user)
        await session.commit()
    except Exception as e:  # noqa: BLE001
        await session.rollback()
        log.warning("no portal link for the failed-payment mail to %s: %s", user.id, e)
    await mail.send_payment_failed(session, user, portal_url=portal_url)
