"""Carry an invite across a provider sign-in on a closed deployment.

Revision ID: 0060
Revises: 0059

`/api/auth/signup` has always demanded an invite when `invite_only` is on, but
the provider callback created accounts without ever asking. On a closed
deployment that made the OAuth start URL an open front door: anyone with a
Google account could walk past the gate the email form enforces.

Closing it needs somewhere to put the invite, because the app hands it over at
the *start* of the flow and the account is created at the *end*, with only the
state row surviving in between. Hashed rather than raw: this row outlives the
request that made it, and the invite table is keyed on the same hash anyway.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0060"
down_revision = "0059"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "auth_provider_states",
        sa.Column("invite_code_hash", sa.String(64), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("auth_provider_states", "invite_code_hash")
