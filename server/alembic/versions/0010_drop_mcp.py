"""Drop MCP: managed servers, agent grants, and the MCP-client OAuth tables."""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

# revision identifiers
revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Grants and codes/tokens reference their parent tables; drop children first.
    op.drop_table("agent_mcp_server_grants")
    op.drop_table("mcp_servers")
    op.drop_table("oauth_authorization_codes")
    op.drop_table("oauth_refresh_tokens")
    op.drop_table("oauth_clients")


def downgrade() -> None:
    op.create_table(
        "mcp_servers",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "owner_user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("transport", sa.String(32), nullable=False, server_default="streamable_http"),
        sa.Column("url", sa.String(2048), nullable=True),
        sa.Column("command", sa.String(2048), nullable=True),
        sa.Column("args", sa.JSON(), nullable=False),
        sa.Column("env", sa.JSON(), nullable=False),
        sa.Column("headers", sa.JSON(), nullable=False),
        sa.Column("enabled_by_default", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("owner_user_id", "name", name="uq_mcp_servers_owner_name"),
    )
    op.create_table(
        "agent_mcp_server_grants",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "owner_user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "agent_id",
            sa.String(36),
            sa.ForeignKey("agents.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "mcp_server_id",
            sa.String(36),
            sa.ForeignKey("mcp_servers.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("agent_id", "mcp_server_id", name="uq_agent_mcp_server_grants"),
    )
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
