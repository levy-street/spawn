"""retain the endorsement that admitted a browser to a host

Revision ID: 0024
Revises: 0023
"""

import sqlalchemy as sa

from alembic import op

revision = "0024"
down_revision = "0023"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # A pin created by endorsement carries the signature that authorized it, so
    # the daemon can re-verify against the browser keys it already trusts rather
    # than believing this table. Nullable because pins created by the device
    # ceremony have no endorsement and never will.
    with op.batch_alter_table("host_browser_pins") as batch:
        batch.add_column(sa.Column("endorser_device_id", sa.String(length=36), nullable=True))
        batch.add_column(sa.Column("endorsement_signature", sa.String(length=86), nullable=True))
        batch.create_check_constraint(
            "ck_host_browser_pins_endorsement_pair",
            "(endorser_device_id IS NULL AND endorsement_signature IS NULL) OR "
            "(endorser_device_id IS NOT NULL AND endorsement_signature IS NOT NULL AND "
            "length(endorsement_signature) = 86)",
        )


def downgrade() -> None:
    # Dropping these leaves endorsed pins in the table with nothing behind them.
    # A daemon that enforces endorsement will then refuse to adopt them, which
    # is the safe direction: it withholds trust rather than granting it.
    with op.batch_alter_table("host_browser_pins") as batch:
        batch.drop_constraint("ck_host_browser_pins_endorsement_pair", type_="check")
        batch.drop_column("endorsement_signature")
        batch.drop_column("endorser_device_id")
