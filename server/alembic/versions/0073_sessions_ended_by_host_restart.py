"""Remember windows ended by a complete worker inventory."""

import sqlalchemy as sa

from alembic import op

revision = "0073"
down_revision = "0072"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "sessions", sa.Column("ended_by_host_restart_at", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("sessions", "ended_by_host_restart_at")
