"""The billing emails: what they may say, and what stops them saying it twice.

These six are the only place this product is allowed to name a price. The 402
body is machine codes (`tests/test_billing_enforcement.py` holds that line) and
the mobile copy is pure account state, because the app renders server strings
verbatim inside a binary that shipped through App Review. A message is not
rendered by that binary, so it carries the tiers, the prices and the link.

Which puts the risk somewhere unusual for a mail module. The failure that
matters here is not an ugly email: it is a webhook that raises and makes Stripe
retry the same event for three days, a pairing refused because an SMTP server
was slow, a self-hosted deployment mailing people about subscriptions it does
not sell, or twenty identical messages to somebody running `spawnd possess` in
a loop. Every test below is one of those.
"""

from __future__ import annotations

import logging
import re
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, update

from spawn_server import billing_email, billing_stripe, mail
from spawn_server.config import get_settings
from spawn_server.db import get_sessionmaker
from spawn_server.models import EmailLog, Subscription, User
from tests.test_billing_enforcement import _approve_ceremony, _set_override
from tests.test_device import (
    _pair,
    _poll,
    _public_key,
    _register_browser,
    _signup,
)

# All five, because `Settings` refuses to boot with billing on and any of them
# missing — the half-configured deployment is the dangerous one, not the
# absent one.
STRIPE_ENV = {
    "SPAWN_BILLING_ENABLED": "true",
    "SPAWN_STRIPE_SECRET_KEY": "sk_test_email",
    "SPAWN_STRIPE_WEBHOOK_SECRET": "whsec_email",
    "SPAWN_STRIPE_PRICE_COVEN": "price_test_coven",
    "SPAWN_STRIPE_PRICE_LEGION": "price_test_legion",
    "SPAWN_STRIPE_PRICE_PANDEMONIUM": "price_test_pandemonium",
    "SPAWN_STRIPE_PORTAL_UPGRADE_CONFIGURATION": "bpc_test_upgrade",
}

PERIOD_END = datetime(2026, 9, 24, 12, 0, tzinfo=UTC)

#: One representative call per sender, keyed by the `kind` it must record
#: itself under. `routes/admin.py`'s email visibility is what those kinds are
#: for, so a sender that reused another's kind would be invisible there.
SENDERS = {
    billing_email.KIND_STARTED: lambda session, user: billing_email.send_subscription_started(
        session,
        user,
        tier_name="Coven",
        price_cents=500,
        current_period_end=PERIOD_END,
    ),
    billing_email.KIND_PAYMENT_FAILED: lambda session, user: billing_email.send_payment_failed(
        session, user, portal_url="https://billing.example/portal/abc"
    ),
    billing_email.KIND_ACTION_REQUIRED: (
        lambda session, user: billing_email.send_payment_action_required(
            session, user, invoice_url="https://invoice.example/i/abc"
        )
    ),
    billing_email.KIND_PLAN_CHANGED: lambda session, user: billing_email.send_plan_changed(
        session,
        user,
        from_tier_name="Coven",
        to_tier_name="Legion",
        host_limit=20,
    ),
    billing_email.KIND_ENDED: lambda session, user: billing_email.send_subscription_ended(
        session, user, host_limit=1, host_count=4
    ),
    billing_email.KIND_HOST_LIMIT: lambda session, user: billing_email.send_host_limit_reached(
        session, user, tier_name="Free", host_limit=1, host_count=1
    ),
}

#: URLs are not prose. The product-name checks below strip them first, because
#: `spawnd.dev` is the domain and `spawn` is the folder — neither is the name
#: of the thing the reader is looking at.
_URL = re.compile(r"https?://\S+")


@pytest.fixture
def billing_on(monkeypatch):
    """A fully configured hosted instance, for one test.

    `get_settings()` is lru_cached, so the cache is cleared going in and again
    coming out — by then monkeypatch has restored the environment, and a
    billing-enabled `Settings` left cached would change every test after it.
    """

    for name, value in STRIPE_ENV.items():
        monkeypatch.setenv(name, value)
    get_settings.cache_clear()  # type: ignore[attr-defined]
    yield
    get_settings.cache_clear()  # type: ignore[attr-defined]


@pytest.fixture
def mailer_on(monkeypatch):
    """Pretend SMTP is configured, without configuring SMTP.

    The suite runs on the `console` backend, which records every attempt to
    `EmailLog` and delivers nothing — exactly what a test wants. But
    `mailer_ready()` is false for it, and the senders are deliberately inert
    without a delivery path, so the readiness answer is substituted the same
    way `tests/test_account_recovery.py` substitutes it for verification mail.
    """

    monkeypatch.setattr(mail, "mailer_ready", lambda: True)


@pytest.fixture
def captured(monkeypatch):
    """Intercept the send itself, for the tests that read the rendered bodies."""

    sent: list[dict[str, str | None]] = []

    async def fake_send(
        *,
        to: str,
        subject: str,
        body: str,
        kind: str = "other",
        html_body: str | None = None,
    ) -> None:
        sent.append(
            {"to": to, "subject": subject, "body": body, "kind": kind, "html": html_body}
        )

    monkeypatch.setattr(mail, "send_email", fake_send)
    return sent


async def _account(email: str = "biller@example.com") -> User:
    async with get_sessionmaker()() as session:
        user = User(email=email, password_hash="unusable")
        session.add(user)
        await session.commit()
        await session.refresh(user)
        return user


async def _send_all(user: User) -> None:
    async with get_sessionmaker()() as session:
        for send in SENDERS.values():
            await send(session, user)


async def _email_log(kind: str | None = None) -> list[EmailLog]:
    async with get_sessionmaker()() as session:
        stmt = select(EmailLog).order_by(EmailLog.created_at)
        if kind is not None:
            stmt = stmt.where(EmailLog.kind == kind)
        return list((await session.execute(stmt)).scalars().all())


def _prose(text: str) -> str:
    return _URL.sub(" ", text)


# --- the two states in which none of this happens ----------------------------


async def test_no_sender_writes_anything_when_billing_is_off(app, mailer_on):
    """A self-hosted deployment has no subscription to write about.

    Billing off is the default and the state most deployments never leave —
    no limit, no UI, no Stripe call, and no mail. There is nothing here that
    could be true for such an install, so nothing is sent and the delivery log
    stays empty.
    """

    user = await _account()
    await _send_all(user)
    assert await _email_log() == []


async def test_no_sender_writes_anything_without_a_mailer(app, billing_on):
    """No delivery path is an ordinary state, not a fault.

    `auth.py:206-211` makes email verification inert on exactly this
    reasoning: a gate nobody can pass is an outage rather than a control. The
    billing analogue is quieter but the same — with no SMTP configured, a
    "send" writes a customer's plan into a log file and nothing else.
    """

    user = await _account()
    await _send_all(user)
    assert await _email_log() == []


# --- the promise the callers depend on ---------------------------------------


@pytest.mark.parametrize("kind", list(SENDERS))
async def test_no_sender_raises_when_the_mailer_blows_up(
    app, billing_on, mailer_on, monkeypatch, kind
):
    """A mail failure must never become the caller's failure.

    These are called from a Stripe webhook and from a device approval. An
    exception in the first makes Stripe retry the event for three days; in the
    second it refuses somebody their own machine because a mail server was
    slow. Neither is a trade worth making for a message.
    """

    async def explode(**_kwargs) -> None:
        raise RuntimeError("smtp is on fire")

    monkeypatch.setattr(mail, "send_email", explode)
    user = await _account()
    async with get_sessionmaker()() as session:
        await SENDERS[kind](session, user)  # must not raise

    assert await _email_log() == []


# --- what the six actually say -----------------------------------------------


@pytest.mark.parametrize("kind", list(SENDERS))
async def test_every_message_has_both_parts_and_records_its_own_kind(
    app, billing_on, mailer_on, captured, kind
):
    """Multipart, with a plain-text body that is a body.

    Plenty of people read mail as text and every spam filter does, so the text
    part is written rather than derived — the module docstring in
    `email_templates` argues this at length and these are held to it.
    """

    user = await _account()
    async with get_sessionmaker()() as session:
        await SENDERS[kind](session, user)

    assert len(captured) == 1
    message = captured[0]
    assert message["kind"] == kind
    assert message["to"] == user.email
    assert message["subject"] and message["subject"] == message["subject"].strip()
    assert len(message["subject"]) <= 60

    html = message["html"]
    assert html and "<html" in html and "<table" in html
    assert "<img" not in html.lower() and "<script" not in html.lower()

    text = message["body"]
    assert text.strip()
    assert "<" not in text
    # A real body, not a subject line with a link stapled to it.
    assert len(text.splitlines()) > 5


@pytest.mark.parametrize("kind", list(SENDERS))
async def test_every_message_names_the_product_and_the_plan_correctly(
    app, billing_on, mailer_on, captured, kind
):
    """Two spelling rules, both of them stated bugs in docs/BILLING.md.

    The product is `SPAWN D` — capitals, one space. `spawn` is the folder and
    `spawnd` is the daemon, and neither is what somebody reading an email is
    looking at.

    The Legion tier is written "Legion" — the same word as the fleet page, on
    purpose — so the sentence around it has to carry "plan".
    """

    user = await _account()
    async with get_sessionmaker()() as session:
        await SENDERS[kind](session, user)

    for part in (captured[0]["body"], captured[0]["html"]):
        assert "SPAWN D" in part
        assert re.search(r"\bspawn\b", _prose(part)) is None, part


async def test_the_host_limit_message_is_the_one_that_may_sell(
    app, billing_on, mailer_on, captured
):
    """The conversion path from §6.3, and the only place it may exist.

    The app says "Host limit reached · Your plan includes 1 host. Disconnect
    one to connect another." and stops. This message is outside the app, which
    is the case Apple's 3.1.3 preamble expressly permits, so it carries the
    tier comparison, the prices and the link.
    """

    user = await _account()
    async with get_sessionmaker()() as session:
        await SENDERS[billing_email.KIND_HOST_LIMIT](session, user)

    text = captured[0]["body"]
    assert "$5.00 / month" in text and "$20.00 / month" in text and "$50.00 / month" in text
    assert "unlimited hosts" in text  # Pandemonium, spelled rather than 0
    assert "Free —" not in text  # the free tier is not an offer
    assert f"{get_settings().billing_return_base}/pricing" in text
    # The in-app action comes first: somebody replacing a dead laptop is not
    # shopping, and leading with the plans answers a question they didn't ask.
    assert text.index("disconnecting a host") < text.index("Or take more room")


async def test_the_ended_message_promises_the_machines_are_untouched(
    app, billing_on, mailer_on, captured
):
    """The fear this answers is "which of my machines did you just kill".

    None of them. There is no suspend state and we are not building one, so an
    account over its limit simply sits there until the person chooses. Both
    halves — the machines keep running, and nothing goes without an explicit
    choice — are load-bearing, and neither is conditional on the numbers.
    """

    user = await _account()
    async with get_sessionmaker()() as session:
        await SENDERS[billing_email.KIND_ENDED](session, user)

    text = captured[0]["body"]
    assert "Your machines keep running." in text
    assert "nothing has been deleted" in text
    assert "which hosts to keep" in text and "or to keep none" in text
    assert "Nothing is removed until you choose." in text


async def test_the_payment_failure_is_not_a_revocation_notice(
    app, billing_on, mailer_on, captured
):
    """Dunning runs for weeks and `past_due` still entitles.

    At the moment this goes out nothing has been lost, and saying so is the
    whole job: a message that reads like a disconnection notice makes people
    panic about hosts that are still running perfectly well.
    """

    user = await _account()
    async with get_sessionmaker()() as session:
        await SENDERS[billing_email.KIND_PAYMENT_FAILED](session, user)

    text = captured[0]["body"]
    assert "Nothing has been lost." in text
    assert "still active" in text
    assert "https://billing.example/portal/abc" in text


# --- the brake ---------------------------------------------------------------


async def test_the_host_limit_email_is_capped_at_one_a_day(app, billing_on, mailer_on):
    """Somebody hammering `spawnd possess` must not be mailed twenty times.

    The refusal fires once per ceremony and a daemon that cannot register is
    usually run again straight away, so the uncapped version of this is one
    person and one wall generating a mailbox full of identical messages.

    Driven through the real `EmailLog` rather than a counter, because the
    delivery log is where the answer has to come from: it is written on its
    own transaction and survives the request that triggered it rolling back.
    """

    user = await _account()
    send = SENDERS[billing_email.KIND_HOST_LIMIT]

    async with get_sessionmaker()() as session:
        await send(session, user)
        assert len(await _email_log(billing_email.KIND_HOST_LIMIT)) == 1

        await send(session, user)
        assert len(await _email_log(billing_email.KIND_HOST_LIMIT)) == 1

    # Age the first one out of the window; the wall is still there tomorrow.
    async with get_sessionmaker()() as session:
        await session.execute(
            update(EmailLog)
            .where(EmailLog.kind == billing_email.KIND_HOST_LIMIT)
            .values(created_at=datetime.now(UTC) - timedelta(hours=25))
        )
        await session.commit()

    async with get_sessionmaker()() as session:
        await send(session, user)
    assert len(await _email_log(billing_email.KIND_HOST_LIMIT)) == 2


async def test_the_cap_is_per_account_not_global(app, billing_on, mailer_on):
    """One person hitting their limit must not silence everybody else's mail."""

    first = await _account("first@example.com")
    second = await _account("second@example.com")
    send = SENDERS[billing_email.KIND_HOST_LIMIT]

    async with get_sessionmaker()() as session:
        await send(session, first)
        await send(session, second)

    recipients = {row.to_email for row in await _email_log(billing_email.KIND_HOST_LIMIT)}
    assert recipients == {"first@example.com", "second@example.com"}


async def test_the_cap_does_not_silence_the_other_five(app, billing_on, mailer_on):
    """Only the host-limit message is rate limited; a lifecycle event is not spam."""

    user = await _account()
    await _send_all(user)
    await _send_all(user)

    kinds = [row.kind for row in await _email_log()]
    assert kinds.count(billing_email.KIND_HOST_LIMIT) == 1
    for kind in SENDERS:
        if kind != billing_email.KIND_HOST_LIMIT:
            assert kinds.count(kind) == 2, kind


# --- account deletion, where the money bug lives -----------------------------


async def _subscribe(
    user_id: str,
    *,
    customer_id: str = "cus_test_deleteme",
    subscription_id: str = "sub_test_deleteme",
) -> None:
    async with get_sessionmaker()() as session:
        session.add(
            Subscription(
                user_id=user_id,
                stripe_customer_id=customer_id,
                stripe_subscription_id=subscription_id,
                tier="coven",
                status="active",
                host_limit=3,
            )
        )
        await session.commit()


async def test_deleting_an_account_cancels_stripe_before_the_row_goes(
    client, billing_on, monkeypatch
):
    """`Subscription` is ON DELETE CASCADE, and that is the bug.

    Left to the cascade, deleting the user would drop our only local record of
    a live subscription while Stripe went on charging the card every month —
    a money bug that erases its own evidence. So the cancel happens by hand,
    first, in the same function, exactly as the host key claims do for the
    opposite reason.
    """

    user_id, headers = await _signup(client, "cancelme@example.com")
    await _subscribe(user_id)

    observed: dict[str, bool] = {}

    async def fake_cancel(session, user, **_kwargs) -> bool:
        # Both rows must still exist here: the real implementation reads the
        # subscription to find the ids it cancels.
        observed["user_present"] = await session.get(User, user.id) is not None
        observed["subscription_present"] = (
            await session.execute(select(Subscription).where(Subscription.user_id == user.id))
        ).scalar_one_or_none() is not None
        return True

    monkeypatch.setattr(billing_stripe, "cancel_subscription_for_user", fake_cancel)

    deleted = await client.post(
        "/api/account/delete",
        json={"confirm_email": "cancelme@example.com", "password": "correcthorse"},
        headers=headers,
    )
    assert deleted.status_code == 204
    assert observed == {"user_present": True, "subscription_present": True}

    async with get_sessionmaker()() as session:
        assert await session.get(User, user_id) is None


async def test_deletion_still_succeeds_when_stripe_is_unreachable(
    client, billing_on, monkeypatch, caplog
):
    """A person's right to delete their account outranks our payment processor.

    So the deletion proceeds — but it now needs a human, and the log line is
    the only thing that will ever tell one. It has to carry the ids somebody
    would search Stripe for, or it is a shrug with a timestamp.
    """

    user_id, headers = await _signup(client, "stripedown@example.com")
    await _subscribe(user_id, customer_id="cus_orphaned", subscription_id="sub_orphaned")

    async def explode(session, user, **_kwargs) -> bool:
        raise RuntimeError("stripe is unreachable")

    monkeypatch.setattr(billing_stripe, "cancel_subscription_for_user", explode)

    with caplog.at_level(logging.ERROR, logger="spawn_server.routes.auth"):
        deleted = await client.post(
            "/api/account/delete",
            json={"confirm_email": "stripedown@example.com", "password": "correcthorse"},
            headers=headers,
        )
    assert deleted.status_code == 204

    async with get_sessionmaker()() as session:
        assert await session.get(User, user_id) is None

    errors = [
        record.getMessage() for record in caplog.records if record.levelno >= logging.ERROR
    ]
    assert any(
        "sub_orphaned" in message and "cus_orphaned" in message and user_id in message
        for message in errors
    ), errors


async def test_deleting_an_account_touches_stripe_only_when_billing_is_on(
    client, monkeypatch
):
    """Absent configuration is a supported state, not an error.

    A self-hosted deployment has no Stripe account, no key and no subscription
    table worth reading; a deletion there must issue exactly the queries it
    always did.
    """

    user_id, headers = await _signup(client, "selfhosted@example.com")

    async def never(session, user, **_kwargs) -> bool:
        raise AssertionError("billing is off; Stripe must not be consulted")

    monkeypatch.setattr(billing_stripe, "cancel_subscription_for_user", never)

    deleted = await client.post(
        "/api/account/delete",
        json={"confirm_email": "selfhosted@example.com", "password": "correcthorse"},
        headers=headers,
    )
    assert deleted.status_code == 204
    async with get_sessionmaker()() as session:
        assert await session.get(User, user_id) is None


# --- the gate that actually triggers it --------------------------------------


async def test_the_approve_refusal_mails_what_the_app_may_not_say(
    client, billing_on, mailer_on, captured
):
    """The two halves of §6.3, in one request.

    The 402 a client renders is machine codes and numbers, because the mobile
    app puts `ApiError.message` on screen verbatim inside a binary that
    shipped through App Review. The email is outside the app — the case
    Apple's 3.1.3 preamble expressly permits — so it carries the price and the
    link the refusal cannot.
    """

    user_id, auth = await _signup(client, "atlimit@example.com")
    browser = await _register_browser(client, user_id, auth)
    await _pair(client, user_id, auth, browser, _public_key(0), name="first")

    _, refusal = await _approve_ceremony(
        client, user_id, auth, browser, _public_key(1), name="second"
    )
    assert refusal.status_code == 402, refusal.text
    assert refusal.json()["detail"] == {
        "code": "host_limit",
        "tier": "free",
        "host_limit": 1,
        "host_count": 1,
    }

    assert len(captured) == 1
    assert captured[0]["kind"] == billing_email.KIND_HOST_LIMIT
    assert captured[0]["to"] == "atlimit@example.com"
    assert "$5.00 / month" in captured[0]["body"]


async def test_the_poll_backstop_mails_too(client, billing_on, mailer_on, captured):
    """Approve and poll are decoupled, and so is the message.

    An approved ceremony lives thirty minutes, so several can be banked under
    the limit and polled afterwards. The daemon reading that refusal is a
    process, not a person — the person is wherever their mail is.
    """

    user_id, auth = await _signup(client, "backstop@example.com")
    browser = await _register_browser(client, user_id, auth)

    first, approved = await _approve_ceremony(
        client, user_id, auth, browser, _public_key(0), name="first"
    )
    assert approved.status_code == 200, approved.text
    second, approved = await _approve_ceremony(
        client, user_id, auth, browser, _public_key(1), name="second"
    )
    assert approved.status_code == 200, approved.text

    assert (await _poll(client, first, _public_key(0))).status_code == 200
    refused = await _poll(client, second, _public_key(1))
    assert refused.json() == {"error": "host_limit"}

    assert len(captured) == 1
    assert captured[0]["kind"] == billing_email.KIND_HOST_LIMIT
    assert captured[0]["to"] == "backstop@example.com"


async def test_a_refusal_survives_the_mailer_failing(
    client, billing_on, mailer_on, monkeypatch
):
    """The gate is the point; the message is a courtesy.

    A refusal that turned into a 500 because SMTP timed out would be a worse
    bug than the one this email exists to soften — and the same shape as the
    webhook that makes Stripe retry for three days.
    """

    async def explode(**_kwargs) -> None:
        raise RuntimeError("smtp is on fire")

    monkeypatch.setattr(mail, "send_email", explode)

    user_id, auth = await _signup(client, "mailerdown@example.com")
    browser = await _register_browser(client, user_id, auth)
    await _pair(client, user_id, auth, browser, _public_key(0), name="first")

    _, refusal = await _approve_ceremony(
        client, user_id, auth, browser, _public_key(1), name="second"
    )
    assert refusal.status_code == 402, refusal.text
    assert refusal.json()["detail"]["code"] == "host_limit"


async def test_a_comped_account_is_refused_without_being_sold_to(
    client, billing_on, mailer_on, captured
):
    """A comped account never sees billing at all (docs/BILLING.md §4.8).

    Its ceiling is an operator's decision about our own product rather than
    something anyone can pay to move, so a price list is the wrong answer to
    hitting it — the right one is a word with whoever set the number.
    """

    user_id, auth = await _signup(client, "comped@example.com")
    browser = await _register_browser(client, user_id, auth)
    await _set_override(user_id, 1)
    await _pair(client, user_id, auth, browser, _public_key(0), name="first")

    _, refusal = await _approve_ceremony(
        client, user_id, auth, browser, _public_key(1), name="second"
    )
    assert refusal.status_code == 402, refusal.text
    assert captured == []
