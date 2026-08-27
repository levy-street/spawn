"""Browser push subscriptions, so an alert can reach a closed browser.

Revision ID: 0066
Revises: 0065

`push_devices` records where to reach a phone: one opaque 255-character token
per install, addressed through Expo. A browser is addressed differently — an
endpoint URL on a host the vendor chose, plus the two keys the user agent
minted so the payload can be encrypted end to end — and none of that fits a
NOT NULL `String(255)` token. It gets its own table rather than four columns
that are always NULL for whichever kind of client did not write the row.

The unique key is the endpoint, for the same reason the phone table keys on
the token: it is what the push service addresses, and it is the thing that
rotates. A subscription that reappears under a different account moves rather
than duplicates.

Additive only. Nothing reads or writes this table until the new server starts,
so the migration is safe to run while the previous processes are still
draining.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0066"
down_revision = "0065"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "web_push_subscriptions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("endpoint", sa.Text(), nullable=False),
        sa.Column("p256dh", sa.String(255), nullable=False),
        sa.Column("auth", sa.String(64), nullable=False),
        sa.Column("label", sa.String(64), nullable=True),
        sa.Column("browser_device_id", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("disabled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("retry_after", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_index(
        "ix_web_push_subscriptions_endpoint",
        "web_push_subscriptions",
        ["endpoint"],
        unique=True,
    )
    op.create_index(
        "ix_web_push_subscriptions_user_id",
        "web_push_subscriptions",
        ["user_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_web_push_subscriptions_user_id", table_name="web_push_subscriptions")
    op.drop_index("ix_web_push_subscriptions_endpoint", table_name="web_push_subscriptions")
    op.drop_table("web_push_subscriptions")
