"""give browser devices a human label

Revision ID: 0025
Revises: 0024
"""

import sqlalchemy as sa

from alembic import op

revision = "0025"
down_revision = "0024"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # A fingerprint is the right thing to compare and useless for recognising
    # which device is which -- an operator staring at several identical-looking
    # base64 strings cannot tell their phone from a stranger's.
    #
    # The label is strictly a convenience and must never be what anyone
    # verifies: it is server-stored and server-mutable, so a hostile server
    # could label its own device "Your iPhone". The fingerprint stays the
    # comparison value; this only makes the list navigable.
    with op.batch_alter_table("browser_devices") as batch:
        batch.add_column(sa.Column("label", sa.String(length=64), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("browser_devices") as batch:
        batch.drop_column("label")
