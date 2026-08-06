"""email tokens, session epoch, and email verification state

Revision ID: 0026
Revises: 0025
"""

import sqlalchemy as sa

from alembic import op

revision = "0026"
down_revision = "0025"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # One table for every emailed single-use secret, discriminated by purpose.
    # Only the SHA-256 of the token is stored: the emailed value is the
    # credential, so a database leak must not hand an attacker the ability to
    # take over accounts by replaying reset links.
    op.create_table(
        "email_tokens",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("purpose", sa.String(32), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_email_tokens_user_purpose", "email_tokens", ["user_id", "purpose"])

    # Sessions are stateless JWTs, so a password reset could not previously
    # evict an attacker who already holds one -- the victim would change their
    # password and the thief would keep reading. Every user token now carries
    # this epoch and is rejected when it falls behind, making reset an actual
    # eviction.
    op.add_column(
        "users",
        sa.Column("session_epoch", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column("users", sa.Column("email_verified_at", sa.DateTime(timezone=True), nullable=True))

    # Existing accounts predate verification and were created by a human who
    # already proved control of the address well enough for this deployment;
    # marking them verified avoids locking out live users on deploy. New
    # signups start unverified.
    op.execute("UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL")


def downgrade() -> None:
    op.drop_column("users", "email_verified_at")
    op.drop_column("users", "session_epoch")
    op.drop_index("ix_email_tokens_user_purpose", table_name="email_tokens")
    op.drop_table("email_tokens")
