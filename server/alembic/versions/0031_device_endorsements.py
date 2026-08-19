"""account-scoped device endorsements

Revision ID: 0031
Revises: 0030
"""

import sqlalchemy as sa

from alembic import op

revision = "0031"
down_revision = "0030"
branch_labels = None
depends_on = None


# A directed edge in the account's device trust graph (docs/TRUST_DEVICE_MESH.md
# §3): endorser_device vouches for endorsed_device's key for the whole account,
# with no host binding. The server stores/relays these but is not their
# authority -- the daemon re-verifies each against its own anchors. `signature`
# is base64url of the 64-byte Ed25519 signature over the SPAWN-ACCT-ENDORSE-V1
# transcript (86 chars). One edge per ordered pair; no self-endorsement.
def upgrade() -> None:
    op.create_table(
        "device_endorsements",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "owner_user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "endorser_device_id",
            sa.String(36),
            sa.ForeignKey("browser_devices.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "endorsed_device_id",
            sa.String(36),
            sa.ForeignKey("browser_devices.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("signature", sa.String(86), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint(
            "endorser_device_id",
            "endorsed_device_id",
            name="uq_device_endorsements_pair",
        ),
        sa.CheckConstraint(
            "endorser_device_id <> endorsed_device_id",
            name="ck_device_endorsements_not_self",
        ),
        sa.CheckConstraint(
            "length(signature) = 86",
            name="ck_device_endorsements_signature",
        ),
    )
    op.create_index(
        "ix_device_endorsements_owner_user_id",
        "device_endorsements",
        ["owner_user_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_device_endorsements_owner_user_id", table_name="device_endorsements")
    op.drop_table("device_endorsements")
