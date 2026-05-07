"""initial schema + builtin presets

Revision ID: 0001
Revises:
Create Date: 2026-05-01

"""

from __future__ import annotations

import json
import uuid
from collections.abc import Sequence
from datetime import UTC, datetime

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("email", sa.String(255), nullable=False, unique=True),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        "hosts",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "owner_user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("os", sa.String(64), nullable=True),
        sa.Column("arch", sa.String(64), nullable=True),
        sa.Column("version", sa.String(64), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="offline"),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        "presets",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "owner_user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=True,
            index=True,
        ),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("agent_kind", sa.String(64), nullable=False),
        sa.Column("default_argv", sa.JSON(), nullable=False),
        sa.Column("env_template", sa.JSON(), nullable=False),
        sa.UniqueConstraint("owner_user_id", "name", name="uq_presets_owner_name"),
    )

    op.create_table(
        "agents",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "owner_user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "host_id",
            sa.String(36),
            sa.ForeignKey("hosts.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "preset_id",
            sa.String(36),
            sa.ForeignKey("presets.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("cwd", sa.String(1024), nullable=False),
        sa.Column("argv", sa.JSON(), nullable=False),
        sa.Column("env", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="starting"),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("exited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("exit_code", sa.Integer(), nullable=True),
    )

    op.create_table(
        "device_codes",
        sa.Column("device_code", sa.String(64), primary_key=True),
        sa.Column("user_code", sa.String(16), nullable=False, unique=True, index=True),
        sa.Column("host_name", sa.String(128), nullable=True),
        sa.Column("os", sa.String(64), nullable=True),
        sa.Column("arch", sa.String(64), nullable=True),
        sa.Column("version", sa.String(64), nullable=True),
        sa.Column("status", sa.String(32), nullable=False, server_default="pending"),
        sa.Column(
            "user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_polled_at", sa.DateTime(timezone=True), nullable=True),
    )

    # Seed built-in presets (owner_user_id IS NULL). Source of truth: spawn_server.presets
    builtins = [
        ("claude-code", "claude-code", ["claude"]),
        ("codex", "codex", ["codex"]),
        ("opencode", "opencode", ["opencode"]),
        (
            "aider-sonnet",
            "aider",
            ["aider", "--model", "claude-sonnet-4-6"],
        ),
        ("shell", "shell", ["bash", "-l"]),
    ]
    bind = op.get_bind()
    now = datetime.now(UTC)
    for name, kind, argv in builtins:
        bind.execute(
            sa.text(
                "INSERT INTO presets (id, owner_user_id, name, agent_kind, default_argv, "
                "env_template) VALUES (:id, NULL, :name, :kind, :argv, :env)"
            ),
            {
                "id": str(uuid.uuid4()),
                "name": name,
                "kind": kind,
                "argv": json.dumps(argv),
                "env": json.dumps({}),
            },
        )
    _ = now  # silence unused — present for parity with ORM's default


def downgrade() -> None:
    op.drop_table("device_codes")
    op.drop_table("agents")
    op.drop_table("presets")
    op.drop_table("hosts")
    op.drop_table("users")
