"""pin Ed25519 host identities during device approval

Revision ID: 0017
Revises: 0016
"""

import sqlalchemy as sa

from alembic import op

# revision identifiers
revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Nullable is intentional for a rolling migration: existing hosts and
    # interrupted legacy device codes are visibly unpaired and cannot acquire
    # a key implicitly. The vNext device endpoints require both fields.
    with op.batch_alter_table("hosts") as batch:
        batch.add_column(sa.Column("host_key_algorithm", sa.String(length=16), nullable=True))
        batch.add_column(sa.Column("host_public_key", sa.String(length=43), nullable=True))
        batch.create_check_constraint(
            "ck_hosts_host_key_pair",
            "(host_key_algorithm IS NULL AND host_public_key IS NULL) OR "
            "(host_key_algorithm IS NOT NULL AND host_public_key IS NOT NULL AND "
            "host_key_algorithm = 'ed25519' AND length(host_public_key) = 43)",
        )
        batch.create_unique_constraint(
            "uq_hosts_host_public_key", ["host_key_algorithm", "host_public_key"]
        )

    with op.batch_alter_table("device_codes") as batch:
        batch.add_column(sa.Column("host_key_algorithm", sa.String(length=16), nullable=True))
        batch.add_column(sa.Column("host_public_key", sa.String(length=43), nullable=True))
        batch.create_check_constraint(
            "ck_device_codes_host_key_pair",
            "(host_key_algorithm IS NULL AND host_public_key IS NULL) OR "
            "(host_key_algorithm IS NOT NULL AND host_public_key IS NOT NULL AND "
            "host_key_algorithm = 'ed25519' AND length(host_public_key) = 43)",
        )
        batch.create_unique_constraint(
            "uq_device_codes_host_public_key", ["host_key_algorithm", "host_public_key"]
        )


def downgrade() -> None:
    with op.batch_alter_table("device_codes") as batch:
        batch.drop_constraint("uq_device_codes_host_public_key", type_="unique")
        batch.drop_constraint("ck_device_codes_host_key_pair", type_="check")
        batch.drop_column("host_public_key")
        batch.drop_column("host_key_algorithm")

    with op.batch_alter_table("hosts") as batch:
        batch.drop_constraint("uq_hosts_host_public_key", type_="unique")
        batch.drop_constraint("ck_hosts_host_key_pair", type_="check")
        batch.drop_column("host_public_key")
        batch.drop_column("host_key_algorithm")
