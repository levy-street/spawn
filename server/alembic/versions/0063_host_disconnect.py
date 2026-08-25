"""Record why a host most recently disconnected.

Revision ID: 0063
Revises: 0062
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0063"
down_revision = "0062"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "hosts", sa.Column("last_disconnect_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("hosts", sa.Column("last_disconnect_reason", sa.String(32), nullable=True))


def downgrade() -> None:
    op.drop_column("hosts", "last_disconnect_reason")
    op.drop_column("hosts", "last_disconnect_at")
