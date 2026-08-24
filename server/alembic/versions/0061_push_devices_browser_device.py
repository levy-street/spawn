"""Link a push token to the browser device it lives on.

Revision ID: 0061
Revises: 0060

A knock (`/api/trust/device-approvals`) is pushed to the account's phones so
the one that can approve hears about it while closed. The knocking device's
own phone must not be one of them: "Approve spawn on iPhone?" landing on that
same iPhone is noise at best and confusing at worst. Push tokens were keyed on
the handset alone, so the server had no way to tell which token belongs to the
device that asked. Nullable: a registration from an older app stays valid and
is simply never excluded.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0061"
down_revision = "0060"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "push_devices",
        sa.Column("browser_device_id", sa.String(36), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("push_devices", "browser_device_id")
