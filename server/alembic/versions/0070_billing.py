"""Subscriptions, so the hosted instance can admit more than one host.

Revision ID: 0070
Revises: 0069

A host is a registration rather than a machine, and registrations are the only
thing the server can count. `subscriptions` is where an account's entitlement
to more than one of them lives: the tier, the number of hosts it admits, and
the Stripe objects that back it. One row per account that has ever paid, kept
after cancellation so the Stripe customer id is stable across a resubscribe —
a second Customer for the same person would split their invoice history and
break the portal.

The tier and the limit are written from OUR price-id map, never from anything
a webhook asserted, and they are read at enforcement time from this table
rather than from Stripe. That is what keeps an existing customer pairing hosts
on a morning when Stripe is unreachable.

`stripe_events` exists only to make a redelivery a no-op. Stripe retries for
up to three days and can send the same event twice; the primary key is the
idempotency mechanism, so the handler inserts first and reads an
IntegrityError as "already applied".

`users.host_limit_override` is how an account is comped without touching
Stripe at all: NULL means no override, 0 means unlimited, anything else is
that many hosts. It is a column of its own rather than an overload of
`is_admin`, so granting the admin surface never silently grants free hosts.

Additive only — two new tables and one nullable column — so old code tolerates
the new schema and the migration is safe to run while previous processes are
still draining. No data migration and no grandfathering: billing is off unless
`SPAWN_BILLING_ENABLED` is set, and nothing consults these columns until it is.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0070"
down_revision = "0069"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "subscriptions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("stripe_customer_id", sa.String(64), nullable=False),
        sa.Column("stripe_subscription_id", sa.String(64), nullable=True),
        sa.Column("tier", sa.String(16), nullable=False, server_default="free"),
        sa.Column("status", sa.String(24), nullable=False, server_default="incomplete"),
        sa.Column("host_limit", sa.Integer(), nullable=True),
        sa.Column("current_period_end", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "cancel_at_period_end", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
        sa.Column("last_event_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.CheckConstraint(
            "tier IN ('free', 'coven', 'legion', 'pandemonium')",
            name="ck_subscriptions_tier",
        ),
        sa.CheckConstraint(
            "host_limit IS NULL OR host_limit >= 0",
            name="ck_subscriptions_host_limit",
        ),
    )
    op.create_index("ix_subscriptions_user_id", "subscriptions", ["user_id"], unique=True)
    op.create_index(
        "ix_subscriptions_stripe_customer_id",
        "subscriptions",
        ["stripe_customer_id"],
        unique=True,
    )
    # Nullable and unique: a row can sit without a subscription id between
    # creating the Customer and the subscription existing, and both engines
    # allow many NULLs under a unique index.
    op.create_index(
        "ix_subscriptions_stripe_subscription_id",
        "subscriptions",
        ["stripe_subscription_id"],
        unique=True,
    )

    op.create_table(
        "stripe_events",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("type", sa.String(64), nullable=False),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.add_column("users", sa.Column("host_limit_override", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "host_limit_override")
    op.drop_table("stripe_events")
    op.drop_index("ix_subscriptions_stripe_subscription_id", table_name="subscriptions")
    op.drop_index("ix_subscriptions_stripe_customer_id", table_name="subscriptions")
    op.drop_index("ix_subscriptions_user_id", table_name="subscriptions")
    op.drop_table("subscriptions")
