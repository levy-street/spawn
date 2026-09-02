"""Bind a native OAuth exchange code to the client that started the flow.

Revision ID: 0068
Revises: 0067

The native leg hands an app a one-time code on a custom scheme and lets it
trade that for a token. The code bound only to the *user*, never to the client
flow, so nothing verified that the app redeeming it was the app that asked. An
attacker could complete OAuth with their own account, take the resulting
`spawn://auth/oauth?code=...` link, and lure someone into opening it: that
person's app would sign into the attacker's account — and, on desktop, possess
their computer under it.

PKCE closes it. The client generates a verifier before opening the browser,
sends only its SHA-256 challenge on `/oauth/{provider}/start`, and presents the
verifier at `/oauth/exchange`. Both columns are nullable so app builds that
predate PKCE keep working; a code minted without a challenge redeems as before,
and one minted with a challenge is useless without the verifier.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0068"
down_revision = "0067"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "auth_provider_states",
        sa.Column("code_challenge", sa.String(length=128), nullable=True),
    )
    op.add_column(
        "auth_provider_exchanges",
        sa.Column("code_challenge", sa.String(length=128), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("auth_provider_exchanges", "code_challenge")
    op.drop_column("auth_provider_states", "code_challenge")
