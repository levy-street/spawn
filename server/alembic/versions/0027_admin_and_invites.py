"""admin flag and signup invites

Revision ID: 0027
Revises: 0026
"""

import sqlalchemy as sa

from alembic import op

revision = "0027"
down_revision = "0026"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("is_admin", sa.Boolean(), nullable=False, server_default=sa.false()),
    )

    # Only the hash is stored. The code travels in a URL the admin shares, so a
    # database leak must not hand anyone the ability to mint accounts on a
    # closed deployment — the same reasoning as email_tokens.
    op.create_table(
        "invites",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("code_hash", sa.String(64), nullable=False, unique=True),
        # Set when the invite was addressed to someone specific. Advisory: the
        # code alone admits, so this records intent rather than enforcing it.
        sa.Column("email", sa.String(255), nullable=True),
        sa.Column(
            "created_by_user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
            index=True,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "used_by_user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_invites_created_at", "invites", ["created_at"])

    # An existing single-user deployment has nobody who could grant admin to
    # anyone, so the earliest account becomes the owner. On a fresh install
    # this table is empty and the first signup takes the role instead.
    # `true`, not `1`: SQLite coerces the integer, but PostgreSQL rejects it
    # ("column is of type boolean but expression is of type integer").
    op.execute(
        "UPDATE users SET is_admin = true WHERE id = "
        "(SELECT id FROM users ORDER BY created_at ASC LIMIT 1)"
    )


def downgrade() -> None:
    op.drop_index("ix_invites_created_at", table_name="invites")
    op.drop_table("invites")
    op.drop_column("users", "is_admin")
