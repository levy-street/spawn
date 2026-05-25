"""Add OAuth clients, authorization codes, and refresh tokens."""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

# revision identifiers
revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "oauth_clients",
        sa.Column("client_id", sa.String(128), primary_key=True),
        sa.Column("client_name", sa.String(255), nullable=False),
        sa.Column("redirect_uris", sa.JSON(), nullable=False),
        sa.Column("scope", sa.String(255), nullable=False, server_default="spawn"),
        sa.Column("token_endpoint_auth_method", sa.String(64), nullable=False, server_default="none"),
        sa.Column("grant_types", sa.JSON(), nullable=False),
        sa.Column("response_types", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "oauth_authorization_codes",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("code_hash", sa.String(64), nullable=False, unique=True, index=True),
        sa.Column(
            "client_id",
            sa.String(128),
            sa.ForeignKey("oauth_clients.client_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("redirect_uri", sa.String(2048), nullable=False),
        sa.Column("scope", sa.String(255), nullable=False, server_default="spawn"),
        sa.Column("code_challenge", sa.String(255), nullable=False),
        sa.Column("code_challenge_method", sa.String(16), nullable=False, server_default="S256"),
        sa.Column("resource", sa.String(2048), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "oauth_refresh_tokens",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True, index=True),
        sa.Column(
            "client_id",
            sa.String(128),
            sa.ForeignKey("oauth_clients.client_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("scope", sa.String(255), nullable=False, server_default="spawn"),
        sa.Column("resource", sa.String(2048), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("oauth_refresh_tokens")
    op.drop_table("oauth_authorization_codes")
    op.drop_table("oauth_clients")
