"""opaque approval_ref for device codes

Revision ID: 0029
Revises: 0028
"""

import sqlalchemy as sa

from alembic import op

revision = "0029"
down_revision = "0028"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # A high-entropy handle the browser uses to load a pending approval from a
    # URL (`/device?ref=…`), so the short human user_code never has to appear in
    # a link. Nullable for rows from an interrupted pre-0029 ceremony; new
    # device/start always sets it.
    op.add_column("device_codes", sa.Column("approval_ref", sa.String(43), nullable=True))
    op.create_index(
        "ix_device_codes_approval_ref",
        "device_codes",
        ["approval_ref"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ix_device_codes_approval_ref", table_name="device_codes")
    op.drop_column("device_codes", "approval_ref")
