"""bind device approvals to browser identities

Revision ID: 0019
Revises: 0018
"""

import sqlalchemy as sa

from alembic import op

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("device_codes") as batch:
        # Multiple devices may independently approve the same existing host;
        # Host ownership and bounded pin admission remain serialized later.
        batch.drop_constraint("uq_device_codes_host_public_key", type_="unique")
        batch.add_column(sa.Column("approval_nonce", sa.String(length=43), nullable=True))
        batch.add_column(sa.Column("browser_device_id", sa.String(length=36), nullable=True))
        batch.add_column(sa.Column("browser_key_algorithm", sa.String(length=16), nullable=True))
        batch.add_column(sa.Column("browser_public_key", sa.String(length=43), nullable=True))
        batch.add_column(sa.Column("browser_key_fingerprint", sa.String(length=23), nullable=True))
        batch.create_foreign_key(
            "fk_device_codes_browser_device_id",
            "browser_devices",
            ["browser_device_id"],
            ["id"],
            ondelete="CASCADE",
        )
        batch.create_check_constraint(
            "ck_device_codes_approval_nonce",
            "approval_nonce IS NULL OR length(approval_nonce) = 43",
        )
        batch.create_check_constraint(
            "ck_device_codes_browser_binding",
            "(browser_device_id IS NULL AND browser_key_algorithm IS NULL AND "
            "browser_public_key IS NULL AND browser_key_fingerprint IS NULL) OR "
            "(browser_device_id IS NOT NULL AND browser_key_algorithm = 'ed25519' AND "
            "length(browser_public_key) = 43 AND length(browser_key_fingerprint) = 23)",
        )

    op.create_table(
        "host_browser_pins",
        sa.Column("host_id", sa.String(length=36), nullable=False),
        sa.Column("browser_device_id", sa.String(length=36), nullable=False),
        sa.Column("browser_key_algorithm", sa.String(length=16), nullable=False),
        sa.Column("browser_public_key", sa.String(length=43), nullable=False),
        sa.Column("browser_key_fingerprint", sa.String(length=23), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "browser_key_algorithm = 'ed25519' AND length(browser_public_key) = 43 "
            "AND length(browser_key_fingerprint) = 23",
            name="ck_host_browser_pins_key",
        ),
        sa.ForeignKeyConstraint(["host_id"], ["hosts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["browser_device_id"], ["browser_devices.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("host_id", "browser_device_id"),
    )


def downgrade() -> None:
    op.drop_table("host_browser_pins")
    with op.batch_alter_table("device_codes") as batch:
        batch.drop_constraint("ck_device_codes_browser_binding", type_="check")
        batch.drop_constraint("ck_device_codes_approval_nonce", type_="check")
        batch.drop_constraint("fk_device_codes_browser_device_id", type_="foreignkey")
        batch.drop_column("browser_key_fingerprint")
        batch.drop_column("browser_public_key")
        batch.drop_column("browser_key_algorithm")
        batch.drop_column("browser_device_id")
        batch.drop_column("approval_nonce")
        batch.create_unique_constraint(
            "uq_device_codes_host_public_key", ["host_key_algorithm", "host_public_key"]
        )
