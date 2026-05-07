"""add preset.install column

Revision ID: 0002
Revises: 0001
Create Date: 2026-05-04
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

# revision identifiers
revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("presets", sa.Column("install", sa.String(length=2048), nullable=True))


def downgrade() -> None:
    op.drop_column("presets", "install")
