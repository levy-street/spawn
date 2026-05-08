"""add agent activity timestamps

Revision ID: 0004
Revises: 0003
Create Date: 2026-05-08
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

# revision identifiers
revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("agents", sa.Column("last_output_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("agents", sa.Column("last_input_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("agents", "last_input_at")
    op.drop_column("agents", "last_output_at")
