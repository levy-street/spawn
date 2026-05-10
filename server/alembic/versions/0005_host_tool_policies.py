"""Host tool auto-update policy state."""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

# revision identifiers
revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "host_tool_policies",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("owner_user_id", sa.String(length=36), nullable=False),
        sa.Column("host_id", sa.String(length=36), nullable=False),
        sa.Column("preset_id", sa.String(length=36), nullable=False),
        sa.Column("auto_update", sa.Boolean(), nullable=False),
        sa.Column("last_checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_auto_update_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_auto_update_error", sa.String(length=2048), nullable=True),
        sa.ForeignKeyConstraint(["host_id"], ["hosts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["owner_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["preset_id"], ["presets.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "owner_user_id",
            "host_id",
            "preset_id",
            name="uq_host_tool_policies_owner_host_preset",
        ),
    )
    op.create_index(
        op.f("ix_host_tool_policies_host_id"),
        "host_tool_policies",
        ["host_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_host_tool_policies_owner_user_id"),
        "host_tool_policies",
        ["owner_user_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_host_tool_policies_preset_id"),
        "host_tool_policies",
        ["preset_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_host_tool_policies_preset_id"), table_name="host_tool_policies")
    op.drop_index(op.f("ix_host_tool_policies_owner_user_id"), table_name="host_tool_policies")
    op.drop_index(op.f("ix_host_tool_policies_host_id"), table_name="host_tool_policies")
    op.drop_table("host_tool_policies")
