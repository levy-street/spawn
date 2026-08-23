"""One-time codes so a native app can finish an OAuth sign-in.

Revision ID: 0045
Revises: 0044

The provider callback has only ever ended one way: set a session cookie on the
browser that started the flow, then redirect to a path on the site. An app has
no such browser. Its sign-in runs in a system web view whose cookie jar the app
cannot read, and the redirect target it needs is a custom scheme the callback
refuses on purpose.

This table is the handoff. The callback mints a single-use code, hands it to the
app on an allow-listed scheme, and the app trades it for the same token the
password login returns. Rows live for a couple of minutes and are spent on
first use, so a code lifted from a log or a URL bar is worthless by the time
anyone finds it.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0045"
down_revision = "0044"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "auth_provider_exchanges",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("code_hash", sa.String(64), nullable=False),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_index(
        "ix_auth_provider_exchanges_code_hash",
        "auth_provider_exchanges",
        ["code_hash"],
        unique=True,
    )
    op.create_index(
        "ix_auth_provider_exchanges_user_id",
        "auth_provider_exchanges",
        ["user_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_auth_provider_exchanges_user_id", table_name="auth_provider_exchanges")
    op.drop_index("ix_auth_provider_exchanges_code_hash", table_name="auth_provider_exchanges")
    op.drop_table("auth_provider_exchanges")
