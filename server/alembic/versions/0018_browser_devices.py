"""add account-bound browser device identities

Revision ID: 0018
Revises: 0017
"""

import sqlalchemy as sa

from alembic import op

# revision identifiers
revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "browser_devices",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("owner_user_id", sa.String(length=36), nullable=False),
        sa.Column("key_algorithm", sa.String(length=16), nullable=False),
        sa.Column("public_key", sa.String(length=43), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "key_algorithm = 'ed25519' AND length(public_key) = 43",
            name="ck_browser_devices_ed25519_key",
        ),
        sa.ForeignKeyConstraint(["owner_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "key_algorithm", "public_key", name="uq_browser_devices_public_key"
        ),
    )
    op.create_index(
        op.f("ix_browser_devices_owner_user_id"),
        "browser_devices",
        ["owner_user_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_browser_devices_owner_user_id"), table_name="browser_devices")
    op.drop_table("browser_devices")
