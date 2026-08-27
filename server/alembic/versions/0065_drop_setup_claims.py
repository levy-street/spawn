"""Drop setup claims and their device-code routing token.

Revision ID: 0065
Revises: 0064
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0065"
down_revision = "0064"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_index("ix_setup_claims_token", table_name="setup_claims")
    op.drop_index("ix_setup_claims_user_id", table_name="setup_claims")
    op.drop_table("setup_claims")
    op.drop_index("ix_device_codes_setup_token", table_name="device_codes")
    op.drop_column("device_codes", "setup_token")


def downgrade() -> None:
    op.add_column("device_codes", sa.Column("setup_token", sa.String(43), nullable=True))
    op.create_index("ix_device_codes_setup_token", "device_codes", ["setup_token"])

    op.create_table(
        "setup_claims",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("token", sa.String(43), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("error", sa.String(32), nullable=True),
        sa.Column("device_code_id", sa.String(64), nullable=True),
        sa.Column("approval_ref", sa.String(43), nullable=True),
        sa.Column("host_name", sa.String(128), nullable=True),
        sa.Column("os", sa.String(64), nullable=True),
        sa.Column("host_key_fingerprint", sa.String(23), nullable=True),
        sa.Column("host_id", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('pending', 'ready', 'approved', 'failed')",
            name="ck_setup_claims_status",
        ),
        sa.CheckConstraint(
            "error IS NULL OR error IN "
            "('expired', 'denied', 'key_conflict', 'pin_conflict', 'pin_limit')",
            name="ck_setup_claims_error",
        ),
        sa.ForeignKeyConstraint(
            ["device_code_id"], ["device_codes.device_code"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(["host_id"], ["hosts.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_setup_claims_user_id", "setup_claims", ["user_id"])
    op.create_index("ix_setup_claims_token", "setup_claims", ["token"], unique=True)
