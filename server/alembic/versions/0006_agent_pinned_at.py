"""Add pinned timestamp to agents."""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

# revision identifiers
revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("agents", sa.Column("pinned_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("agents", "pinned_at")
