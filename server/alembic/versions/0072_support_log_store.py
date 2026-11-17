"""Inert support log storage; existing code tolerates every addition.

Revision ID: 0072
Revises: 0071
"""

import sqlalchemy as sa

from alembic import op

revision = "0072"
down_revision = "0071"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Reserved for the later dispatch change; no registration code uses it.
    op.add_column(
        "hosts",
        sa.Column("support_log_capable", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_table(
        "support_log_consents",
        sa.Column(
            "owner_user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        # Zero-padded decimal text preserves u64 exactly on both database engines.
        sa.Column("issued_at_ms", sa.String(20), nullable=False),
        sa.Column(
            "signer_device_id",
            sa.String(36),
            sa.ForeignKey("browser_devices.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("signed_device_id", sa.String(36), nullable=False),
        sa.Column("signer_public_key", sa.String(43), nullable=False),
        sa.Column("signature", sa.String(86), nullable=False),
        sa.Column("carried_endorsements", sa.JSON(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "support_log_collections",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "owner_user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("host_id", sa.String(36), sa.ForeignKey("hosts.id", ondelete="SET NULL")),
        sa.Column("host_name", sa.String(128), nullable=False),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("decline_code", sa.String(24)),
        sa.Column("reason", sa.String(200), nullable=False),
        sa.Column("requested_by", sa.Text(), nullable=False),
        sa.Column("window_seconds", sa.Integer(), nullable=False),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("dispatched_at", sa.DateTime(timezone=True)),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
        sa.Column("expires_at", sa.DateTime(timezone=True)),
        sa.Column("size_bytes", sa.Integer()),
        sa.Column("line_count", sa.Integer()),
        sa.Column("log_from", sa.BigInteger()),
        sa.Column("log_to", sa.BigInteger()),
        sa.Column("digest", sa.String(64)),
        sa.Column("truncated", sa.Boolean()),
        sa.CheckConstraint(
            "state IN ('requested','dispatched','collected','declined','failed',"
            "'expired','cancelled','deleted')",
            name="ck_support_log_state",
        ),
        sa.CheckConstraint("length(reason) BETWEEN 1 AND 200", name="ck_support_log_reason"),
        sa.CheckConstraint("window_seconds BETWEEN 60 AND 259200", name="ck_support_log_window"),
    )
    op.create_index(
        "ix_support_log_collections_owner_user_id", "support_log_collections", ["owner_user_id"]
    )
    op.create_index(
        "ix_support_log_state_expiry", "support_log_collections", ["state", "expires_at"]
    )
    op.create_index("ix_support_log_requested_at", "support_log_collections", ["requested_at"])

    op.create_index(
        "ix_support_log_state_requested", "support_log_collections", ["state", "requested_at"]
    )
    op.create_index(
        "ix_support_log_state_dispatched", "support_log_collections", ["state", "dispatched_at"]
    )


def downgrade() -> None:
    op.drop_table("support_log_collections")
    op.drop_table("support_log_consents")
    # SQLite batch drop rebuilds hosts; only the downgrade pays this cost.
    with op.batch_alter_table("hosts") as batch:
        batch.drop_column("support_log_capable")
