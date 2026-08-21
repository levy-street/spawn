"""browser device approval-request stamp

Revision ID: 0038
Revises: 0037
"""

import sqlalchemy as sa

from alembic import op

revision = "0038"
down_revision = "0037"
branch_labels = None
depends_on = None


# Access-screen display data (docs/TRUST_UX.md): stamped when an unapproved
# device actively asks to be approved (it tried to open an agent session), so
# other devices can surface — and re-surface — the approval toast instead of
# treating the sign-in as idle. Advisory, never authorization.
def upgrade() -> None:
    op.add_column(
        "browser_devices",
        sa.Column("approval_requested_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("browser_devices", "approval_requested_at")
