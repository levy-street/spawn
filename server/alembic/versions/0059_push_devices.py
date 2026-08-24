"""Push tokens, so an alert can reach a phone that is not running spawn.

Revision ID: 0059
Revises: 0058

`/ws/alerts` only reaches a client that is connected, which is precisely the
client that does not need telling. On a phone the app is usually suspended or
closed by the time an agent finishes, and a suspended app holds no socket. The
push service does, so this table records where to send.

The unique key is the token, not the account: the token is what the push
service addresses and what goes stale on reinstall, restore or handset change,
and a token that reappears under a different account must move rather than
duplicate.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0059"
down_revision = "0058"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "push_devices",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("token", sa.String(255), nullable=False),
        sa.Column("platform", sa.String(16), nullable=False),
        sa.Column("label", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("disabled_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_push_devices_token", "push_devices", ["token"], unique=True)
    op.create_index("ix_push_devices_user_id", "push_devices", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_push_devices_user_id", table_name="push_devices")
    op.drop_index("ix_push_devices_token", table_name="push_devices")
    op.drop_table("push_devices")
