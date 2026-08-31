"""Migration 0068 (billing) adds two tables and a column, and nothing else.

Everything here is additive, which is what makes it safe to run while the
previous processes are still draining: an account that existed before the
migration comes out of it with `host_limit_override` NULL, which is exactly
"no override", and no code consults either new table until billing is switched
on.

What the schema itself has to enforce is asserted here rather than trusted to
the writer: only the four tier names, no negative host limit, one subscription
per account, one per Stripe object — and a `stripe_events` primary key that
rejects a redelivered event id, because that rejection *is* the idempotency
mechanism the webhook handler is built on.

Pinned to revision 0068 rather than head for the same reason the neighbouring
migration tests are: what is under test is this step.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError

from tests.test_migrations_overhaul import _alembic, _migration_env

USER_ID = "68686868-6868-4868-8868-686868686868"
OTHER_USER_ID = "68686868-6868-4868-8868-686868686869"
NOW = "2026-01-01 00:00:00"


def _seed(conn) -> None:
    for user_id, email in (
        (USER_ID, "billing-migration@example.com"),
        (OTHER_USER_ID, "billing-migration-other@example.com"),
    ):
        conn.execute(
            text(
                "INSERT INTO users (id, email, password_hash, created_at)"
                " VALUES (:id, :email, 'x', :now)"
            ),
            {"id": user_id, "email": email, "now": NOW},
        )


def _insert_subscription(conn, **overrides) -> None:
    values = {
        "id": "sub-row-1",
        "user_id": USER_ID,
        "stripe_customer_id": "cus_one",
        "stripe_subscription_id": "sub_one",
        "tier": "legion",
        "status": "active",
        "host_limit": 20,
        "now": NOW,
        **overrides,
    }
    conn.execute(
        text(
            "INSERT INTO subscriptions (id, user_id, stripe_customer_id,"
            " stripe_subscription_id, tier, status, host_limit, cancel_at_period_end,"
            " created_at, updated_at)"
            " VALUES (:id, :user_id, :stripe_customer_id, :stripe_subscription_id,"
            " :tier, :status, :host_limit, 0, :now, :now)"
        ),
        values,
    )


def _upgraded(tmp_path: Path, name: str):
    """Seed at 0067, then upgrade to 0068. Returns the env and the sync URL."""
    db_path = tmp_path / name
    env = _migration_env(f"sqlite+aiosqlite:///{db_path}")
    sync_url = f"sqlite:///{db_path}"

    _alembic(["upgrade", "0067"], env=env)
    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            _seed(conn)
    finally:
        engine.dispose()

    _alembic(["upgrade", "0068"], env=env)
    return env, sync_url


def test_0068_leaves_every_existing_account_without_an_override(tmp_path: Path):
    _, sync_url = _upgraded(tmp_path, "spawn-billing.db")

    engine = create_engine(sync_url, future=True)
    try:
        inspector = inspect(engine)
        assert {"subscriptions", "stripe_events"} <= set(inspector.get_table_names())
        indexes = {index["name"] for index in inspector.get_indexes("subscriptions")}
        assert {
            "ix_subscriptions_user_id",
            "ix_subscriptions_stripe_customer_id",
            "ix_subscriptions_stripe_subscription_id",
        } <= indexes

        with engine.begin() as conn:
            # NULL is "no override", so nobody who existed before the migration
            # has been comped or capped by it.
            row = conn.execute(
                text("SELECT email, host_limit_override FROM users WHERE id = :id"),
                {"id": USER_ID},
            ).one()
            assert tuple(row) == ("billing-migration@example.com", None)
            # And nothing was invented on the way in.
            assert conn.execute(text("SELECT count(*) FROM subscriptions")).scalar_one() == 0
            assert conn.execute(text("SELECT count(*) FROM stripe_events")).scalar_one() == 0
    finally:
        engine.dispose()


def test_0068_holds_a_subscription_and_defaults_a_bare_row_to_free(tmp_path: Path):
    _, sync_url = _upgraded(tmp_path, "spawn-billing-rows.db")

    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            _insert_subscription(conn)
            row = conn.execute(
                text(
                    "SELECT tier, status, host_limit, cancel_at_period_end,"
                    " current_period_end, last_event_at FROM subscriptions"
                )
            ).one()
            assert tuple(row) == ("legion", "active", 20, 0, None, None)

            # The server always writes tier and status, but the column defaults
            # are what a row created by anything else falls back to, and the
            # safe fallback is the tier that grants the least.
            conn.execute(
                text(
                    "INSERT INTO subscriptions (id, user_id, stripe_customer_id,"
                    " created_at, updated_at)"
                    " VALUES ('bare', :user_id, 'cus_bare', :now, :now)"
                ),
                {"user_id": OTHER_USER_ID, "now": NOW},
            )
            bare = conn.execute(
                text(
                    "SELECT tier, status, host_limit, cancel_at_period_end"
                    " FROM subscriptions WHERE id = 'bare'"
                )
            ).one()
            assert tuple(bare) == ("free", "incomplete", None, 0)
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    "overrides",
    [
        # Not one of the four tiers we sell.
        {"tier": "enterprise"},
        {"tier": "Legion"},
        # A negative allowance has no meaning; NULL is how unlimited is spelled.
        {"host_limit": -1},
    ],
)
def test_0068_refuses_a_subscription_the_server_could_not_mean(
    tmp_path: Path, overrides: dict
):
    _, sync_url = _upgraded(tmp_path, "spawn-billing-checks.db")

    engine = create_engine(sync_url, future=True)
    try:
        with pytest.raises(IntegrityError):
            with engine.begin() as conn:
                _insert_subscription(conn, **overrides)
    finally:
        engine.dispose()


def test_0068_allows_unlimited_and_a_subscription_that_does_not_exist_yet(tmp_path: Path):
    """NULL `host_limit` is unlimited; NULL `stripe_subscription_id` is a
    Customer created before its subscription. Both are ordinary states, and a
    unique index over a nullable column must not collapse the second one."""
    _, sync_url = _upgraded(tmp_path, "spawn-billing-nulls.db")

    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            _insert_subscription(
                conn, tier="pandemonium", host_limit=None, stripe_subscription_id=None
            )
            _insert_subscription(
                conn,
                id="sub-row-2",
                user_id=OTHER_USER_ID,
                stripe_customer_id="cus_two",
                stripe_subscription_id=None,
            )
            assert conn.execute(text("SELECT count(*) FROM subscriptions")).scalar_one() == 2
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    "overrides",
    [
        # Two rows for one account: whichever is read second decides what they
        # are entitled to, which is not a question that may have two answers.
        {"id": "sub-row-2", "stripe_customer_id": "cus_two", "stripe_subscription_id": "sub_2"},
        # One Stripe Customer belonging to two accounts, or one subscription.
        {"id": "sub-row-2", "user_id": OTHER_USER_ID, "stripe_subscription_id": "sub_2"},
        {"id": "sub-row-2", "user_id": OTHER_USER_ID, "stripe_customer_id": "cus_two"},
    ],
)
def test_0068_keeps_one_subscription_per_account_and_per_stripe_object(
    tmp_path: Path, overrides: dict
):
    _, sync_url = _upgraded(tmp_path, "spawn-billing-uniques.db")

    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            _insert_subscription(conn)
        with pytest.raises(IntegrityError):
            with engine.begin() as conn:
                _insert_subscription(conn, **overrides)
    finally:
        engine.dispose()


def test_0068_rejects_a_redelivered_event_id(tmp_path: Path):
    """The primary key IS the idempotency mechanism. Stripe retries for up to
    three days and can send the same event twice; the handler inserts first and
    reads this failure as "already applied"."""
    _, sync_url = _upgraded(tmp_path, "spawn-billing-events.db")

    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO stripe_events (id, type, received_at)"
                    " VALUES ('evt_1', 'customer.subscription.updated', :now)"
                ),
                {"now": NOW},
            )
        with pytest.raises(IntegrityError):
            with engine.begin() as conn:
                # A different type and a later timestamp: only the id matters.
                conn.execute(
                    text(
                        "INSERT INTO stripe_events (id, type, received_at)"
                        " VALUES ('evt_1', 'invoice.paid', :now)"
                    ),
                    {"now": "2026-01-02 00:00:00"},
                )
    finally:
        engine.dispose()


def test_0068_downgrade_removes_everything_it_added(tmp_path: Path):
    env, sync_url = _upgraded(tmp_path, "spawn-billing-down.db")

    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            _insert_subscription(conn)
            conn.execute(
                text(
                    "UPDATE users SET host_limit_override = 0 WHERE id = :id"
                ),
                {"id": USER_ID},
            )
    finally:
        engine.dispose()

    _alembic(["downgrade", "0067"], env=env)

    engine = create_engine(sync_url, future=True)
    try:
        tables = set(inspect(engine).get_table_names())
        assert {"subscriptions", "stripe_events"}.isdisjoint(tables)
        columns = {column["name"] for column in inspect(engine).get_columns("users")}
        assert "host_limit_override" not in columns
        with engine.begin() as conn:
            # The account survives the round trip; only what billing added left.
            assert (
                conn.execute(
                    text("SELECT email FROM users WHERE id = :id"), {"id": USER_ID}
                ).scalar_one()
                == "billing-migration@example.com"
            )
    finally:
        engine.dispose()
