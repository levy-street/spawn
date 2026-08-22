"""durable root-key introductions

Revision ID: 0041
Revises: 0040
"""

import sqlalchemy as sa

from alembic import op

revision = "0041"
down_revision = "0040"
branch_labels = None
depends_on = None


# Firsthand delivery channel for pk_R (mesh §4.1 provenance rule): devices that
# know the root firsthand (mint/unlock) publish a signed SPAWN-ROOT-INTRO-V1
# introduction; pinned devices that verify one against a ceremony-learned
# introducer key can then run the per-host root anchor sweep. One row per
# introducer (rotation replaces it). Additive; the server relays and
# hygiene-checks but is never the authority.
def upgrade() -> None:
    op.create_table(
        "root_introductions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "owner_user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "introducer_device_id",
            sa.String(36),
            sa.ForeignKey("browser_devices.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column("root_public_key", sa.String(43), nullable=False),
        sa.Column("signature", sa.String(86), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "length(root_public_key) = 43", name="ck_root_introductions_root_key"
        ),
        sa.CheckConstraint("length(signature) = 86", name="ck_root_introductions_signature"),
    )


def downgrade() -> None:
    op.drop_table("root_introductions")
