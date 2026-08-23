"""Rename presets to agents: launchable CLI tool definitions.

Revision ID: 0043
Revises: 0042

`default_argv` (JSON list) becomes a single shell `command` string, and
`env_template` becomes `env`. The built-in `shell` row is deleted — sessions
ARE shells now, so the shortcut is meaningless. Must run after 0029: `agents`
is both the old sessions table name and this migration's new name.
"""

from __future__ import annotations

import json
import uuid

import sqlalchemy as sa

from alembic import op

revision = "0043"
down_revision = "0042"
branch_labels = None
depends_on = None

_UNSAFE_SHELL_CHARS = set(" \t\n\"'`$\\|&;<>()*?[]{}~#!")


def _shell_quote(token: str) -> str:
    """POSIX single-quote quoting, applied only when the token needs it."""
    if token and not (set(token) & _UNSAFE_SHELL_CHARS):
        return token
    return "'" + token.replace("'", "'\"'\"'") + "'"


def _shell_join(argv: list[str]) -> str:
    return " ".join(_shell_quote(str(token)) for token in argv)


def _shell_split(command: str) -> list[str]:
    import shlex

    try:
        return shlex.split(command)
    except ValueError:
        return [command] if command else []


def upgrade() -> None:
    conn = op.get_bind()

    # Sessions are shells; the built-in shell shortcut (and its policies) go.
    conn.execute(
        sa.text(
            "DELETE FROM host_tool_policies WHERE preset_id IN "
            "(SELECT id FROM presets WHERE owner_user_id IS NULL AND name = 'shell')"
        )
    )
    conn.execute(sa.text("DELETE FROM presets WHERE owner_user_id IS NULL AND name = 'shell'"))

    op.rename_table("presets", "agents")
    op.add_column("agents", sa.Column("command", sa.String(1024), nullable=True))

    rows = conn.execute(sa.text("SELECT id, default_argv FROM agents")).fetchall()
    for row in rows:
        argv = row.default_argv if isinstance(row.default_argv, list) else json.loads(
            row.default_argv or "[]"
        )
        conn.execute(
            sa.text("UPDATE agents SET command = :command WHERE id = :id"),
            {"command": _shell_join(argv)[:1024], "id": row.id},
        )

    # Column renames run before any batch that names their constraints:
    # creating a constraint on a column renamed inside the same SQLite batch
    # silently loses the constraint.
    op.alter_column("agents", "env_template", new_column_name="env", existing_type=sa.JSON())
    op.alter_column("agents", "agent_kind", new_column_name="kind", existing_type=sa.String(64))
    with op.batch_alter_table("agents") as batch:
        batch.alter_column("command", existing_type=sa.String(1024), nullable=False)
        batch.drop_column("default_argv")
        batch.drop_constraint("uq_presets_owner_name", type_="unique")
        batch.create_unique_constraint("uq_agents_owner_name", ["owner_user_id", "name"])
    op.drop_index("ix_presets_owner_user_id", table_name="agents")
    op.create_index("ix_agents_owner_user_id", "agents", ["owner_user_id"])

    op.rename_table("host_tool_policies", "host_agent_policies")
    op.alter_column(
        "host_agent_policies", "preset_id", new_column_name="agent_id",
        existing_type=sa.String(36),
    )
    with op.batch_alter_table("host_agent_policies") as batch:
        batch.drop_constraint("uq_host_tool_policies_owner_host_preset", type_="unique")
        batch.create_unique_constraint(
            "uq_host_agent_policies_owner_host_agent", ["owner_user_id", "host_id", "agent_id"]
        )
    op.drop_index("ix_host_tool_policies_owner_user_id", table_name="host_agent_policies")
    op.drop_index("ix_host_tool_policies_host_id", table_name="host_agent_policies")
    op.drop_index("ix_host_tool_policies_preset_id", table_name="host_agent_policies")
    op.create_index(
        "ix_host_agent_policies_owner_user_id", "host_agent_policies", ["owner_user_id"]
    )
    op.create_index("ix_host_agent_policies_host_id", "host_agent_policies", ["host_id"])
    op.create_index("ix_host_agent_policies_agent_id", "host_agent_policies", ["agent_id"])


def downgrade() -> None:
    op.drop_index("ix_host_agent_policies_agent_id", table_name="host_agent_policies")
    op.drop_index("ix_host_agent_policies_host_id", table_name="host_agent_policies")
    op.drop_index("ix_host_agent_policies_owner_user_id", table_name="host_agent_policies")
    with op.batch_alter_table("host_agent_policies") as batch:
        batch.drop_constraint("uq_host_agent_policies_owner_host_agent", type_="unique")
        batch.create_unique_constraint(
            "uq_host_tool_policies_owner_host_preset", ["owner_user_id", "host_id", "agent_id"]
        )
    op.alter_column(
        "host_agent_policies", "agent_id", new_column_name="preset_id",
        existing_type=sa.String(36),
    )
    op.rename_table("host_agent_policies", "host_tool_policies")
    op.create_index(
        "ix_host_tool_policies_owner_user_id", "host_tool_policies", ["owner_user_id"]
    )
    op.create_index("ix_host_tool_policies_host_id", "host_tool_policies", ["host_id"])
    op.create_index("ix_host_tool_policies_preset_id", "host_tool_policies", ["preset_id"])

    op.add_column("agents", sa.Column("default_argv", sa.JSON(), nullable=True))
    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id, command FROM agents")).fetchall()
    for row in rows:
        conn.execute(
            sa.text("UPDATE agents SET default_argv = :argv WHERE id = :id"),
            {"argv": json.dumps(_shell_split(row.command or "")), "id": row.id},
        )
    with op.batch_alter_table("agents") as batch:
        batch.alter_column("default_argv", existing_type=sa.JSON(), nullable=False)
        batch.drop_column("command")
        batch.drop_constraint("uq_agents_owner_name", type_="unique")
        batch.create_unique_constraint("uq_presets_owner_name", ["owner_user_id", "name"])
    op.alter_column("agents", "env", new_column_name="env_template", existing_type=sa.JSON())
    op.alter_column("agents", "kind", new_column_name="agent_kind", existing_type=sa.String(64))
    op.drop_index("ix_agents_owner_user_id", table_name="agents")
    op.rename_table("agents", "presets")
    op.create_index("ix_presets_owner_user_id", "presets", ["owner_user_id"])

    # Restore the built-in shell shortcut the upgrade deleted.
    conn.execute(
        sa.text(
            "INSERT INTO presets (id, owner_user_id, name, agent_kind, default_argv, "
            "env_template, install) VALUES (:id, NULL, 'shell', 'shell', :argv, :env, NULL)"
        ),
        {
            "id": str(uuid.uuid4()),
            "argv": json.dumps(["bash", "-l"]),
            "env": "{}",
        },
    )
