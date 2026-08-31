"""Track daemon content identity and self-update state.

Revision ID: 0062
Revises: 0061
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0062"
down_revision = "0061"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("hosts", sa.Column("daemon_tree", sa.String(64), nullable=True))
    op.add_column(
        "hosts",
        sa.Column(
            "self_update",
            sa.Boolean(),
            server_default=sa.false(),
            nullable=False,
        ),
    )
    op.add_column("hosts", sa.Column("self_update_blocked", sa.String(64), nullable=True))
    op.add_column("hosts", sa.Column("update_state", sa.String(16), nullable=True))
    op.add_column("hosts", sa.Column("update_tree", sa.String(64), nullable=True))
    op.add_column("hosts", sa.Column("update_error", sa.String(500), nullable=True))
    op.add_column(
        "hosts",
        sa.Column("update_requested_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("hosts", "update_requested_at")
    op.drop_column("hosts", "update_error")
    op.drop_column("hosts", "update_tree")
    op.drop_column("hosts", "update_state")
    op.drop_column("hosts", "self_update_blocked")
    op.drop_column("hosts", "self_update")
    op.drop_column("hosts", "daemon_tree")
