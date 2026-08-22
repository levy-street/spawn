"""host-key introductions on the add-device pairing relay

Revision ID: 0039
Revises: 0038
"""

import sqlalchemy as sa

from alembic import op

revision = "0039"
down_revision = "0038"
branch_labels = None
depends_on = None


# R7 host-key gossip (docs/TRUST_DEVICE_MESH.md §9): the approver's signed host
# introductions ride the pairing relay to the joiner, which verifies each
# against the ceremony-pinned approver key. Opaque JSON to the server; set-once.
def upgrade() -> None:
    op.add_column(
        "device_pairings",
        sa.Column("introductions", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("device_pairings", "introductions")
