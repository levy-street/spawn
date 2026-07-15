"""durable host daemon connection ownership

Revision ID: 0016
Revises: 0015
"""

import sqlalchemy as sa

from alembic import op

# revision identifiers
revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "hosts",
        sa.Column("daemon_connection_id", sa.String(length=32), nullable=True),
    )
    op.add_column(
        "hosts",
        sa.Column("daemon_generation", sa.Integer(), server_default="0", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("hosts", "daemon_generation")
    op.drop_column("hosts", "daemon_connection_id")
