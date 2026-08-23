"""host advertises account-chain admission

Revision ID: 0034
Revises: 0033
"""

import sqlalchemy as sa

from alembic import op

revision = "0034"
down_revision = "0033"
branch_labels = None
depends_on = None


# Mesh R9: a daemon that validates account-scoped endorsement chains says so at
# register; the server then refuses the legacy per-host device-endorsement path
# toward that host. Defaulted false so existing rows stay on legacy behavior
# until their daemon reconnects and advertises.
def upgrade() -> None:
    op.add_column(
        "hosts",
        sa.Column(
            "supports_account_chains", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
    )


def downgrade() -> None:
    op.drop_column("hosts", "supports_account_chains")
