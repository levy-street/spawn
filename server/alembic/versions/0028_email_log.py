"""record every outbound email attempt

Revision ID: 0028
Revises: 0027
"""

import sqlalchemy as sa

from alembic import op

revision = "0028"
down_revision = "0027"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "email_log",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("to_email", sa.String(255), nullable=False, index=True),
        sa.Column("subject", sa.String(255), nullable=False),
        # What the message was for: password_reset, email_verify, invite, test.
        sa.Column("kind", sa.String(32), nullable=False),
        # sent | failed | not_delivered (the console backend logs, never sends)
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        # Body with credentials REDACTED. Reset and invite links are bearer
        # credentials, so storing them verbatim would turn this audit trail
        # into an account-takeover vault for anyone who reaches the database
        # or the admin page. The text is kept for support; the secrets are not.
        sa.Column("body_redacted", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_email_log_created_at", "email_log", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_email_log_created_at", table_name="email_log")
    op.drop_table("email_log")
