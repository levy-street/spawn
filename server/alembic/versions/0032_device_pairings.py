"""browser-to-browser add-device SAS ceremonies

Revision ID: 0032
Revises: 0031
"""

import sqlalchemy as sa

from alembic import op

revision = "0032"
down_revision = "0031"
branch_labels = None
depends_on = None


# A committed-ephemeral SAS ceremony between two of the account's browsers
# (docs/TRUST_DEVICE_MESH.md §4, Appendix A). The server relays opaque base64url
# values (32-byte keys/nonces/commitment, 43 chars); it can neither grind the
# number nor read anything. Nonce/key fields fill in as each move lands.
def upgrade() -> None:
    op.create_table(
        "device_pairings",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "owner_user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "initiator_device_id",
            sa.String(36),
            sa.ForeignKey("browser_devices.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "joiner_device_id",
            sa.String(36),
            sa.ForeignKey("browser_devices.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("initiator_public_key", sa.String(43), nullable=False),
        sa.Column("initiator_commit", sa.String(43), nullable=False),
        sa.Column("joiner_public_key", sa.String(43), nullable=True),
        sa.Column("joiner_nonce", sa.String(43), nullable=True),
        sa.Column("initiator_nonce", sa.String(43), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "initiator_device_id <> joiner_device_id",
            name="ck_device_pairings_distinct",
        ),
    )
    op.create_index(
        "ix_device_pairings_owner_user_id",
        "device_pairings",
        ["owner_user_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_device_pairings_owner_user_id", table_name="device_pairings")
    op.drop_table("device_pairings")
