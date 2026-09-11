"""The waitlist: addresses left while signup is invite-only.

Revision ID: 0070
Revises: 0069

A closed deployment turned every visitor who reached the signup form away
with nothing to do next. This table is where they leave an address instead.
An entry is not a credential — it holds the address, the page it was left
on, and later the invite an admin minted for it, so the admin surface can
show who has been sent a code and whether it was used.
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
        "waitlist",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("source", sa.String(120), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("invited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "invite_id",
            sa.String(36),
            sa.ForeignKey("invites.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.UniqueConstraint("email", name="uq_waitlist_email"),
    )


def downgrade() -> None:
    op.drop_table("waitlist")
