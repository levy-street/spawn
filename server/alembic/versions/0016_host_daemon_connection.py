"""durable host daemon connection ownership

Revision ID: 0016
Revises: 0015
"""

import sqlalchemy as sa

from alembic import op

MAX_SAFE_FENCING_GENERATION = 9_007_199_254_740_991

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
        sa.Column(
            "daemon_generation",
            sa.BigInteger(),
            sa.CheckConstraint(
                f"daemon_generation BETWEEN 0 AND {MAX_SAFE_FENCING_GENERATION}",
                name="ck_hosts_daemon_generation_safe",
            ),
            server_default="0",
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("hosts", "daemon_generation")
    op.drop_column("hosts", "daemon_connection_id")
