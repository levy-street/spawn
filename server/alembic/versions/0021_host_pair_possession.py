"""record daemon host-key possession for device ceremonies

Revision ID: 0021
Revises: 0020
"""

import sqlalchemy as sa

from alembic import op

revision = "0021"
down_revision = "0020"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("device_codes") as batch:
        batch.add_column(sa.Column("host_possession_version", sa.SmallInteger(), nullable=True))
        batch.add_column(
            sa.Column("host_possession_verified_at", sa.DateTime(timezone=True), nullable=True)
        )
        batch.create_check_constraint(
            "ck_device_codes_host_possession",
            "(host_possession_version IS NULL AND host_possession_verified_at IS NULL) OR "
            "(host_possession_version IS NOT NULL AND host_possession_version = 1 AND "
            "host_possession_verified_at IS NOT NULL)",
        )


def downgrade() -> None:
    # Dropping and later re-adding these columns intentionally turns every
    # surviving ceremony back into the unproved state. A downgraded server may
    # not be used for pairing because 0020 has no possession enforcement.
    with op.batch_alter_table("device_codes") as batch:
        batch.drop_constraint("ck_device_codes_host_possession", type_="check")
        batch.drop_column("host_possession_verified_at")
        batch.drop_column("host_possession_version")
