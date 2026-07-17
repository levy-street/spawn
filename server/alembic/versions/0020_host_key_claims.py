"""retain host key ownership across Host revocation

Revision ID: 0020
Revises: 0019
"""

import sqlalchemy as sa

from alembic import op

revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "host_key_claims",
        sa.Column("host_key_algorithm", sa.String(length=16), nullable=False),
        sa.Column("host_public_key", sa.String(length=43), nullable=False),
        sa.Column("owner_user_id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "host_key_algorithm = 'ed25519' AND length(host_public_key) = 43",
            name="ck_host_key_claims_ed25519_key",
        ),
        sa.ForeignKeyConstraint(["owner_user_id"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("host_key_algorithm", "host_public_key"),
    )
    op.create_index(
        op.f("ix_host_key_claims_owner_user_id"),
        "host_key_claims",
        ["owner_user_id"],
        unique=False,
    )
    op.execute(
        sa.text(
            "INSERT INTO host_key_claims "
            "(host_key_algorithm, host_public_key, owner_user_id, created_at) "
            "SELECT host_key_algorithm, host_public_key, owner_user_id, created_at "
            "FROM hosts WHERE host_key_algorithm IS NOT NULL "
            "AND host_public_key IS NOT NULL"
        )
    )
    op.create_index(
        "ix_device_codes_host_key",
        "device_codes",
        ["host_key_algorithm", "host_public_key"],
        unique=False,
    )


def downgrade() -> None:
    # Once a Host is deleted its claim is the only record preventing a stable
    # identity key from being captured by another account. Refuse to discard
    # such tombstones silently. Operators must re-upgrade or perform a future
    # explicit ownership-transfer process, never erase the binding by rollback.
    orphan_claims = op.get_bind().execute(
        sa.text(
            "SELECT count(*) FROM host_key_claims AS claim "
            "WHERE NOT EXISTS ("
            "SELECT 1 FROM hosts AS host "
            "WHERE host.host_key_algorithm = claim.host_key_algorithm "
            "AND host.host_public_key = claim.host_public_key "
            "AND host.owner_user_id = claim.owner_user_id)"
        )
    ).scalar_one()
    if orphan_claims:
        raise RuntimeError(
            "cannot downgrade 0020 while retained host key ownership claims exist"
        )

    op.drop_index("ix_device_codes_host_key", table_name="device_codes")
    op.drop_index(op.f("ix_host_key_claims_owner_user_id"), table_name="host_key_claims")
    op.drop_table("host_key_claims")
