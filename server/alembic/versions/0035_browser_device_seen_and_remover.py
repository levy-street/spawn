"""browser device last-seen stamp and remover attribution

Revision ID: 0035
Revises: 0034
"""

import sqlalchemy as sa

from alembic import op

revision = "0035"
down_revision = "0034"
branch_labels = None
depends_on = None


# Access-screen display data (docs/TRUST_UX.md): last_seen_at is stamped when a
# device's identity registration reconciles (every app load); revoked_by_device_id
# records which of the account's devices asked for a removal so the refused
# screen can name its remover (R4). Both advisory, never authorization.
def upgrade() -> None:
    op.add_column(
        "browser_devices",
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "browser_devices",
        sa.Column("revoked_by_device_id", sa.String(36), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("browser_devices", "revoked_by_device_id")
    op.drop_column("browser_devices", "last_seen_at")
