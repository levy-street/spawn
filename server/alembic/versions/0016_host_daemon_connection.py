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
    op.add_column(
        "hosts",
        sa.Column(
            "daemon_generation_counter",
            sa.BigInteger(),
            sa.CheckConstraint(
                f"daemon_generation_counter BETWEEN 0 AND {MAX_SAFE_FENCING_GENERATION}",
                name="ck_hosts_daemon_generation_counter_safe",
            ),
            sa.CheckConstraint(
                "daemon_generation_counter >= daemon_generation",
                name="ck_hosts_daemon_generation_counter_monotonic",
            ),
            server_default="0",
            nullable=False,
        ),
    )
    op.add_column(
        "hosts",
        sa.Column("daemon_pending_connection_id", sa.String(length=32), nullable=True),
    )
    op.add_column(
        "hosts",
        sa.Column(
            "daemon_pending_generation",
            sa.BigInteger(),
            sa.CheckConstraint(
                f"daemon_pending_generation IS NULL OR daemon_pending_generation BETWEEN 1 AND {MAX_SAFE_FENCING_GENERATION}",
                name="ck_hosts_daemon_pending_generation_safe",
            ),
            sa.CheckConstraint(
                "(daemon_pending_connection_id IS NULL) = (daemon_pending_generation IS NULL)",
                name="ck_hosts_daemon_pending_owner_pair",
            ),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("hosts", "daemon_pending_generation")
    op.drop_column("hosts", "daemon_pending_connection_id")
    op.drop_column("hosts", "daemon_generation_counter")
    op.drop_column("hosts", "daemon_generation")
    op.drop_column("hosts", "daemon_connection_id")
