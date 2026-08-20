"""account root marker on browser devices

Revision ID: 0033
Revises: 0032
"""

import sqlalchemy as sa

from alembic import op

revision = "0033"
down_revision = "0032"
branch_labels = None
depends_on = None


# The account root (device mesh §3, stage 5) is stored as a browser_device row
# marked is_root, so it reuses the endorsement store, pin/anchor delivery, and
# chain validation. A root never connects; it only endorses (R→d) and anchors.
# Additive + defaulted, so existing rows become non-root.
def upgrade() -> None:
    op.add_column(
        "browser_devices",
        sa.Column("is_root", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("browser_devices", "is_root")
