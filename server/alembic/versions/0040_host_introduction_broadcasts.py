"""durable host-key introductions + ceremony device introductions

Revision ID: 0040
Revises: 0039
"""

import sqlalchemy as sa

from alembic import op

revision = "0040"
down_revision = "0039"
branch_labels = None
depends_on = None


# Continuous host-key gossip (mesh R7, continuous leg): host_introductions is
# the durable account store of signed SPAWN-HOST-INTRO-BCAST-V1 vouches; the
# device_pairings column carries the ceremony's device-key introductions that
# bootstrap each recipient's firsthand peer-key memory. Both additive; the
# server relays and hygiene-checks but is never the authority.
def upgrade() -> None:
    op.create_table(
        "host_introductions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "owner_user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "publisher_device_id",
            sa.String(36),
            sa.ForeignKey("browser_devices.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("host_id", sa.String(36), nullable=False),
        sa.Column("host_name", sa.String(128), nullable=False),
        sa.Column("host_public_key", sa.String(43), nullable=False),
        sa.Column("signature", sa.String(86), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint(
            "publisher_device_id",
            "host_public_key",
            name="uq_host_introductions_publisher_host",
        ),
        sa.CheckConstraint(
            "length(host_public_key) = 43", name="ck_host_introductions_host_key"
        ),
        sa.CheckConstraint("length(signature) = 86", name="ck_host_introductions_signature"),
    )
    op.add_column(
        "device_pairings",
        sa.Column("device_introductions", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("device_pairings", "device_introductions")
    op.drop_table("host_introductions")
