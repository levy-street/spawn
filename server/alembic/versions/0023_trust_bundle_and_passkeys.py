"""store the operator's sealed trust bundle and passkey credential IDs

Revision ID: 0023
Revises: 0022
"""

import sqlalchemy as sa

from alembic import op

revision = "0023"
down_revision = "0022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Ciphertext only. The server cannot read or forge a trust bundle, which is
    # what lets a new device learn real host keys without trusting this server.
    op.create_table(
        "trust_bundles",
        sa.Column(
            "owner_user_id",
            sa.String(length=36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("sealed", sa.Text(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("length(sealed) > 0", name="ck_trust_bundles_sealed_present"),
        sa.CheckConstraint("revision >= 1", name="ck_trust_bundles_revision_positive"),
    )

    # Credential IDs are not secret and are never verified server-side: the PRF
    # secret is derived and consumed in the browser. Tampering here can only
    # deny service, never disclose or forge.
    op.create_table(
        "passkey_credentials",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "owner_user_id",
            sa.String(length=36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("credential_id", sa.String(length=512), nullable=False),
        sa.Column("label", sa.String(length=128), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("owner_user_id", "credential_id", name="uq_passkey_owner_credential"),
        sa.CheckConstraint("length(credential_id) > 0", name="ck_passkey_credential_id_present"),
    )
    op.create_index(
        "ix_passkey_credentials_owner_user_id", "passkey_credentials", ["owner_user_id"]
    )


def downgrade() -> None:
    # Dropping trust_bundles discards the only copy of the sealed bundle the
    # server holds. Devices that still hold their local pins are unaffected, but
    # a device that has not yet unlocked would have to re-bootstrap.
    op.drop_index("ix_passkey_credentials_owner_user_id", table_name="passkey_credentials")
    op.drop_table("passkey_credentials")
    op.drop_table("trust_bundles")
