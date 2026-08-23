"""Device approval requests: a new device knocking, so the others hear it.

Revision ID: 0044
Revises: 0043

Admitting a second device was always possible and never discoverable. The
endorsement ceremony ran entirely on the *trusted* device, so the operator had
to already know it existed, remember where it lived, and go there unprompted —
while the new device sat on a spinner that could not say why.

This table is the missing knock. It grants nothing: the pin is still created by
an endorsement signed on a device the host already trusts, and this row only
records that somebody is waiting so the other devices can offer the ceremony
instead of hiding it. Rows are short-lived, one pending per device, and are
resolved by the endorsement that admits the device (or by an explicit deny).
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0044"
down_revision = "0043"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "device_approval_requests",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_user_id", sa.String(36), nullable=False),
        sa.Column("browser_device_id", sa.String(36), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resolved_by_device_id", sa.String(36), nullable=True),
        sa.ForeignKeyConstraint(["owner_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["browser_device_id"], ["browser_devices.id"], ondelete="CASCADE"
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'approved', 'denied')",
            name="ck_device_approval_requests_status",
        ),
    )
    op.create_index(
        "ix_device_approval_requests_owner_user_id",
        "device_approval_requests",
        ["owner_user_id"],
    )
    # Partial, so a device may knock again after an earlier request was
    # resolved while still being unable to stack two live ones.
    op.create_index(
        "uq_device_approval_requests_pending",
        "device_approval_requests",
        ["browser_device_id"],
        unique=True,
        sqlite_where=sa.text("status = 'pending'"),
        postgresql_where=sa.text("status = 'pending'"),
    )


def downgrade() -> None:
    op.drop_index("uq_device_approval_requests_pending", table_name="device_approval_requests")
    op.drop_index(
        "ix_device_approval_requests_owner_user_id", table_name="device_approval_requests"
    )
    op.drop_table("device_approval_requests")
