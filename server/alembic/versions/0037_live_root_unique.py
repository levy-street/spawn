"""one live root per account, enforced by the database

Revision ID: 0037
Revises: 0036
"""

import sqlalchemy as sa

from alembic import op

revision = "0037"
down_revision = "0036"
branch_labels = None
depends_on = None


# "At most one account root" (device mesh §4.1) was app-logic-only: the
# register route checks for a live root before inserting one (0033 added just
# the column). Two concurrent mints could both pass that check and fork the
# account's trust anchor. This partial unique index makes the invariant a DB
# fact. Partial (is_root AND revoked_at IS NULL) so rotation — revoke the old
# root, mint a successor — still works; SQLite and Postgres both support the
# predicate as written.
def upgrade() -> None:
    op.create_index(
        "uq_browser_devices_live_root",
        "browser_devices",
        ["owner_user_id"],
        unique=True,
        sqlite_where=sa.text("is_root AND revoked_at IS NULL"),
        postgresql_where=sa.text("is_root AND revoked_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_browser_devices_live_root", table_name="browser_devices")
