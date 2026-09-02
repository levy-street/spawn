"""The host limit where it is actually applied, and where it is advertised.

`tests/test_billing.py` pins down what a plan *means*; this pins down what the
server does about it. Everything here drives the real device ceremony — start,
review, approve, poll — because that is the only path that brings a `Host` row
into existence, and a test that constructs `Host(...)` through the ORM proves
nothing about a gate that lives in a route.

Three things are easy to break here and hard to notice:

- refusing somebody their *own* machine, which is what a re-pair looks like to
  a careless check and would strand a paying customer outside their laptop;
- letting the approve gate stand alone, when an approved ceremony lives 30
  minutes and several can be banked under the limit and polled afterwards;
- letting prose into a refusal. The mobile app renders `ApiError.message`
  verbatim inside a binary that ships through app review, so a friendly
  sentence from the server is purchase copy in an iOS app with no string in
  `mobile/` to find it. That one has its own test.
"""

from __future__ import annotations

import asyncio
import os

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from spawn_server.config import get_settings
from spawn_server.db import get_sessionmaker
from spawn_server.models import DeviceCode, User
from tests.test_device import (
    _approve,
    _pair,
    _poll,
    _public_key,
    _register_browser,
    _review,
    _signup,
    _start,
    _wire,
)

# All five values, because `Settings` refuses to boot with billing on and any
# of them missing — a half-configured billing deployment is the dangerous
# state, not the absent one.
STRIPE_ENV = {
    "SPAWN_BILLING_ENABLED": "true",
    "SPAWN_STRIPE_SECRET_KEY": "sk_test_enforcement",
    "SPAWN_STRIPE_WEBHOOK_SECRET": "whsec_enforcement",
    "SPAWN_STRIPE_PRICE_COVEN": "price_test_coven",
    "SPAWN_STRIPE_PRICE_LEGION": "price_test_legion",
    "SPAWN_STRIPE_PRICE_PANDEMONIUM": "price_test_pandemonium",
}

# Words that must never reach a client from this server on a billing path.
# Apple polices the verb, not the link, so a declarative sentence with a price
# in it fails just as hard as a button would.
FORBIDDEN_WORDS = ("buy", "upgrade", "subscribe", "pay", "purchase", "checkout")


@pytest.fixture
def billing_on(monkeypatch):
    """A fully configured hosted instance, for the duration of one test.

    `get_settings()` is lru_cached, so the cache is cleared going in and again
    coming out — by then monkeypatch has restored the environment, and a
    billing-enabled `Settings` left cached would change every test after it.
    """
    for name, value in STRIPE_ENV.items():
        monkeypatch.setenv(name, value)
    get_settings.cache_clear()  # type: ignore[attr-defined]
    yield
    get_settings.cache_clear()  # type: ignore[attr-defined]


async def _set_override(user_id: str, value: int | None) -> None:
    async with get_sessionmaker()() as session:
        user = await session.get(User, user_id)
        assert user is not None
        user.host_limit_override = value
        await session.commit()


async def _make_admin(user_id: str) -> None:
    async with get_sessionmaker()() as session:
        user = await session.get(User, user_id)
        assert user is not None
        user.is_admin = True
        await session.commit()


async def _device_code_status(device_code: str) -> str:
    async with get_sessionmaker()() as session:
        row = await session.get(DeviceCode, device_code)
        assert row is not None
        return row.status


async def _approve_ceremony(client, user_id, auth, browser, public_key, *, name="host"):
    """start → review → approve, stopping short of the poll that creates the Host."""
    start = await _start(client, public_key, name=name)
    review = await _review(client, start, auth)
    return start, await _approve(client, start, user_id, auth, review, browser)


def _assert_no_purchase_copy(text: str) -> None:
    """The compliance bright line, asserted rather than reviewed.

    No link to follow, no price to compare, no verb aimed at the reader. The
    server sends the machine code and the numbers; every word a person reads
    about it belongs to the client rendering it.
    """
    lowered = text.lower()
    assert "http://" not in lowered, text
    assert "https://" not in lowered, text
    assert "://" not in lowered, text
    assert "$" not in text, text
    assert "spawnd.dev" not in lowered, text
    for word in FORBIDDEN_WORDS:
        assert word not in lowered, (word, text)


# ---------- billing off: the default, and it must change nothing ----------


async def test_billing_disabled_pairs_a_whole_fleet_and_advertises_nothing(client):
    user_id, auth = await _signup(client, "selfhost@example.com")
    browser = await _register_browser(client, user_id, auth)

    for index in range(4):
        paired = await _pair(
            client, user_id, auth, browser, _public_key(index), name=f"box-{index}"
        )
        assert paired["host_id"]

    config = await client.get("/api/auth/config")
    assert config.status_code == 200, config.text
    assert config.json()["billing"] == {
        "enabled": False,
        # Advertised even when off because it is a fact about the tier table,
        # not a gate; `enabled: false` already tells a client to draw nothing.
        "free_host_limit": 1,
        "tiers": [],
        "mobile_upgrade_link": False,
    }

    me = await client.get("/api/me", headers=auth)
    assert me.status_code == 200, me.text
    assert me.json()["user"]["billing"] is None

    profile = await client.get("/api/profile", headers=auth)
    assert profile.status_code == 200, profile.text
    assert profile.json()["billing"] is None


async def test_the_admin_list_reports_no_limit_while_billing_is_off(client):
    """A self-hosted operator sees an unlimited fleet, and no subscription is read.

    The subscription table is not queried at all on this path, so the page also
    works on an install that has never run migration 0070.
    """
    # The first account on a deployment is bootstrapped to admin.
    admin_id, admin_auth = await _signup(client, "operator@example.com")
    await _make_admin(admin_id)

    listed = await client.get("/api/admin/users", headers=admin_auth)
    assert listed.status_code == 200, listed.text
    row = next(item for item in listed.json() if item["id"] == admin_id)
    assert row["host_limit_override"] is None
    assert row["billing_tier"] == "free"
    assert row["effective_host_limit"] is None


async def test_the_mobile_link_cannot_be_advertised_while_billing_is_off(client, monkeypatch):
    """Switching billing off must never leave a link advertised to a shipped app."""
    monkeypatch.setenv("SPAWN_BILLING_MOBILE_UPGRADE_LINK", "true")
    get_settings.cache_clear()  # type: ignore[attr-defined]
    try:
        config = await client.get("/api/auth/config")
        assert config.json()["billing"]["mobile_upgrade_link"] is False
    finally:
        get_settings.cache_clear()  # type: ignore[attr-defined]


# ---------- billing on: the gate, and what it says ----------


async def test_the_second_host_is_refused_with_402_at_approve(client, billing_on):
    user_id, auth = await _signup(client, "free@example.com")
    browser = await _register_browser(client, user_id, auth)

    first = await _pair(client, user_id, auth, browser, _public_key(0), name="first")
    assert first["host_id"]

    _, refusal = await _approve_ceremony(
        client, user_id, auth, browser, _public_key(1), name="second"
    )
    # 402, not the 409-with-prose every other capacity error in this codebase
    # uses: "out of room" and "must pay for more room" are different answers
    # and a client should not have to match on a string to tell them apart.
    assert refusal.status_code == 402, refusal.text
    assert refusal.json()["detail"] == {
        "code": "host_limit",
        "tier": "free",
        "host_limit": 1,
        "host_count": 1,
    }


async def test_neither_refusal_carries_a_link_a_price_or_a_verb(client, billing_on):
    """The anti-steering line, enforced server-side for a mobile-store reason.

    Both halves: the 402 a browser reads and the machine code a daemon reads.
    Neither may carry a word somebody could act on, because one of them is
    rendered verbatim by an app that shipped through review.
    """
    user_id, auth = await _signup(client, "compliance@example.com")
    browser = await _register_browser(client, user_id, auth)

    await _set_override(user_id, 2)
    await _pair(client, user_id, auth, browser, _public_key(0), name="first")
    second, _ = await _approve_ceremony(
        client, user_id, auth, browser, _public_key(1), name="second"
    )
    third, _ = await _approve_ceremony(
        client, user_id, auth, browser, _public_key(2), name="third"
    )
    assert (await _poll(client, second, _public_key(1))).status_code == 200

    poll_refusal = await _poll(client, third, _public_key(2))
    assert poll_refusal.json() == {"error": "host_limit"}
    _assert_no_purchase_copy(poll_refusal.text)

    _, approve_refusal = await _approve_ceremony(
        client, user_id, auth, browser, _public_key(3), name="fourth"
    )
    assert approve_refusal.status_code == 402
    _assert_no_purchase_copy(approve_refusal.text)


async def test_re_approving_an_existing_host_is_never_refused(client, billing_on):
    """The regression that would strand people outside their own machines."""
    user_id, auth = await _signup(client, "repair@example.com")
    browser = await _register_browser(client, user_id, auth)

    await _set_override(user_id, 3)
    for index in range(3):
        await _pair(client, user_id, auth, browser, _public_key(index), name=f"box-{index}")

    # Now put the account *over* its limit, the way a downgrade does. Nothing
    # about using what is already paired may change.
    await _set_override(user_id, 1)
    second_attempt = await _approve_ceremony(
        client, user_id, auth, browser, _public_key(3), name="new-box"
    )
    assert second_attempt[1].status_code == 402

    for index in range(3):
        start = await _start(client, _public_key(index), name=f"box-{index}")
        review = await _review(client, start, auth)
        approval = await _approve(client, start, user_id, auth, review, browser)
        assert approval.status_code == 200, approval.text
        poll = await _poll(client, start, _public_key(index))
        assert poll.status_code == 200, poll.text
        assert "access_token" in poll.json(), poll.text


async def test_the_poll_backstop_catches_ceremonies_banked_under_the_limit(client, billing_on):
    """Approve and poll are decoupled; an approved code lives thirty minutes."""
    user_id, auth = await _signup(client, "banked@example.com")
    browser = await _register_browser(client, user_id, auth)

    await _set_override(user_id, 2)
    await _pair(client, user_id, auth, browser, _public_key(0), name="first")

    # Both approve: at approve time the account holds one host of two, and
    # neither ceremony has created a row yet.
    second, second_approval = await _approve_ceremony(
        client, user_id, auth, browser, _public_key(1), name="second"
    )
    third, third_approval = await _approve_ceremony(
        client, user_id, auth, browser, _public_key(2), name="third"
    )
    assert second_approval.status_code == 200, second_approval.text
    assert third_approval.status_code == 200, third_approval.text

    admitted = await _poll(client, second, _public_key(1))
    assert admitted.status_code == 200
    assert "access_token" in admitted.json(), admitted.text

    refused = await _poll(client, third, _public_key(2))
    assert refused.status_code == 200
    assert refused.json() == {"error": "host_limit"}
    # Persisted on the DeviceCode, exactly as `pin_limit` is, so the answer
    # survives the request that produced it...
    assert await _device_code_status(third["device_code"]) == "host_limit"
    # ...and a daemon that polls again is told the same thing rather than
    # being sent back to authorization_pending.
    assert (await _poll(client, third, _public_key(2))).json() == {"error": "host_limit"}


async def test_host_limit_override_outranks_the_plan(client, billing_on):
    zero_user, zero_auth = await _signup(client, "comped@example.com")
    zero_browser = await _register_browser(client, zero_user, zero_auth)
    # 0 is the column's only way to spell "unlimited"; a free account with it
    # set pairs as many machines as it likes.
    await _set_override(zero_user, 0)
    for index in range(3):
        await _pair(
            client, zero_user, zero_auth, zero_browser, _public_key(index), name=f"box-{index}"
        )

    # Fresh keys: a host key claim is retained for the account that took it,
    # so a second account in the same test can never reuse the first's.
    two_user, two_auth = await _signup(client, "two@example.com")
    two_browser = await _register_browser(client, two_user, two_auth)
    await _set_override(two_user, 2)
    for index in (3, 4):
        await _pair(
            client, two_user, two_auth, two_browser, _public_key(index), name=f"box-{index}"
        )
    _, refusal = await _approve_ceremony(
        client, two_user, two_auth, two_browser, _public_key(5), name="third"
    )
    assert refusal.status_code == 402, refusal.text
    assert refusal.json()["detail"]["host_limit"] == 2
    assert refusal.json()["detail"]["host_count"] == 2


async def test_deleting_a_host_frees_a_slot_synchronously(client, billing_on):
    user_id, auth = await _signup(client, "churn@example.com")
    browser = await _register_browser(client, user_id, auth)

    first = await _pair(client, user_id, auth, browser, _public_key(0), name="first")
    _, refusal = await _approve_ceremony(
        client, user_id, auth, browser, _public_key(1), name="second"
    )
    assert refusal.status_code == 402

    deleted = await client.delete(f"/api/hosts/{first['host_id']}", headers=auth)
    assert deleted.status_code == 204, deleted.text

    replacement = await _pair(client, user_id, auth, browser, _public_key(1), name="second")
    assert replacement["host_id"]


# ---------- what every surface that returns a user now carries ----------


async def test_the_plan_block_travels_with_every_user_shape(client, billing_on):
    user_id, auth = await _signup(client, "shapes@example.com")
    browser = await _register_browser(client, user_id, auth)
    await _pair(client, user_id, auth, browser, _public_key(0), name="only")

    expected = {
        "enabled": True,
        "tier": "free",
        "tier_name": "Free",
        "host_limit": 1,
        "host_count": 1,
        "over_limit": False,
        "status": None,
        "current_period_end": None,
        "cancel_at_period_end": False,
    }

    me = await client.get("/api/me", headers=auth)
    assert me.json()["user"]["billing"] == expected

    # The mobile sign-in paths seed their me-cache from the token response, so
    # a login that omitted this would serve a stale plan until the first
    # refetch — which is why all seven construction sites go through one helper.
    login = await client.post(
        "/api/auth/login",
        json={"email": "shapes@example.com", "password": "correcthorse"},
    )
    assert login.status_code == 200, login.text
    assert login.json()["user"]["billing"] == expected

    profile = await client.get("/api/profile", headers=auth)
    assert profile.json()["billing"] == expected


async def test_the_config_block_lists_the_tiers_cheapest_first(client, billing_on):
    config = await client.get("/api/auth/config")
    block = config.json()["billing"]
    assert block["enabled"] is True
    assert block["free_host_limit"] == 1
    assert block["mobile_upgrade_link"] is False
    assert block["tiers"] == [
        {"key": "free", "name": "Free", "price_cents": 0, "host_limit": 1},
        {"key": "coven", "name": "Coven", "price_cents": 500, "host_limit": 3},
        # Spelled out: `/legion` is already the fleet page, so bare "Legion"
        # in a billing sentence reads as that page rather than as a plan.
        {"key": "legion", "name": "the Legion plan", "price_cents": 2000, "host_limit": 20},
        {
            "key": "pandemonium",
            "name": "Pandemonium",
            "price_cents": 5000,
            "host_limit": None,
        },
    ]


# ---------- comping ----------


async def test_admin_sets_and_clears_the_override(client, billing_on):
    # The operator signs up first: the first account on a deployment is
    # bootstrapped to admin, and this test needs a genuinely unprivileged one.
    admin_id, admin_auth = await _signup(client, "operator@example.com")
    user_id, auth = await _signup(client, "customer@example.com")

    # 404, not 403: a non-admin has no business learning this surface exists.
    unauthorised = await client.patch(
        f"/api/admin/users/{user_id}", json={"host_limit_override": 5}, headers=auth
    )
    assert unauthorised.status_code == 404, unauthorised.text

    await _make_admin(admin_id)

    granted = await client.patch(
        f"/api/admin/users/{user_id}", json={"host_limit_override": 5}, headers=admin_auth
    )
    assert granted.status_code == 200, granted.text
    assert granted.json()["host_limit_override"] == 5
    assert granted.json()["effective_host_limit"] == 5
    assert granted.json()["billing_tier"] == "free"

    # An omitted field leaves the override alone; only an explicit null clears it.
    untouched = await client.patch(
        f"/api/admin/users/{user_id}", json={}, headers=admin_auth
    )
    assert untouched.status_code == 200, untouched.text
    assert untouched.json()["host_limit_override"] == 5

    comped = await client.patch(
        f"/api/admin/users/{user_id}", json={"host_limit_override": 0}, headers=admin_auth
    )
    assert comped.json()["host_limit_override"] == 0
    assert comped.json()["effective_host_limit"] is None

    cleared = await client.patch(
        f"/api/admin/users/{user_id}", json={"host_limit_override": None}, headers=admin_auth
    )
    assert cleared.json()["host_limit_override"] is None
    assert cleared.json()["effective_host_limit"] == 1

    assert (
        await client.patch(
            f"/api/admin/users/{user_id}",
            json={"host_limit_override": -1},
            headers=admin_auth,
        )
    ).status_code == 422
    assert (
        await client.patch(
            f"/api/admin/users/{user_id}", json={"is_admin": True}, headers=admin_auth
        )
    ).status_code == 422
    assert (
        await client.patch(
            "/api/admin/users/does-not-exist",
            json={"host_limit_override": 1},
            headers=admin_auth,
        )
    ).status_code == 404

    listed = await client.get("/api/admin/users", headers=admin_auth)
    assert listed.status_code == 200, listed.text
    row = next(item for item in listed.json() if item["id"] == user_id)
    assert row["host_limit_override"] is None
    assert row["billing_tier"] == "free"
    assert row["effective_host_limit"] == 1


# ---------- the race ----------


CONCURRENT_CEREMONIES = 6


async def _assert_concurrent_pairing_respects_the_limit(client) -> None:
    """Daemons finishing at the same moment must not all get a slot.

    The ceremony already holds a write fence on the host key claim, but that
    serialises against the *same* key — not against six different machines
    being paired by the same person in the same millisecond, which is what a
    fleet rollout looks like. The account row lock inside
    `billing.may_add_host` is what closes it, and this is the only test that
    can tell whether it is there.

    All six approve legitimately: approving creates no `Host`, so at approve
    time the account holds zero of its one and every one of them is honest.
    """
    user_id, auth = await _signup(client, "race@example.com")

    ceremonies = []
    for index in range(CONCURRENT_CEREMONIES):
        # A browser each, deliberately. Poll updates the approving
        # BrowserDevice row, so six ceremonies from one browser would queue
        # behind that row lock and never reach the limit check together —
        # the test would pass with no account lock at all. Six browsers on one
        # account is also the honest shape of the race: a laptop, a phone and
        # a desktop, all bringing a machine online at once.
        browser = await _register_browser(client, user_id, auth)
        # Generated rather than drawn from the shared corpus: it is only seven
        # keys long, and possession is stamped directly by `_start` anyway.
        public_key = _wire(Ed25519PrivateKey.generate().public_key().public_bytes_raw())
        start, approval = await _approve_ceremony(
            client, user_id, auth, browser, public_key, name=f"box-{index}"
        )
        assert approval.status_code == 200, approval.text
        ceremonies.append((start, public_key))

    results = await asyncio.gather(
        *(_poll(client, start, public_key) for start, public_key in ceremonies)
    )
    bodies = [response.json() for response in results]
    admitted = [body for body in bodies if "access_token" in body]
    refused = [body for body in bodies if body == {"error": "host_limit"}]
    assert len(admitted) == 1, bodies
    assert len(refused) == CONCURRENT_CEREMONIES - 1, bodies

    profile = await client.get("/api/profile", headers=auth)
    assert profile.json()["billing"]["host_count"] == 1
    assert len(profile.json()["hosts"]) == 1


async def test_file_sqlite_concurrent_pairing_respects_the_limit(file_sqlite_client, billing_on):
    await _assert_concurrent_pairing_respects_the_limit(file_sqlite_client)


@pytest.mark.skipif(
    os.environ.get("SPAWN_TEST_EXTERNAL_SERVICES") != "1",
    reason="requires independent PostgreSQL transactions",
)
async def test_postgresql_concurrent_pairing_respects_the_limit(client, billing_on):
    await _assert_concurrent_pairing_respects_the_limit(client)
