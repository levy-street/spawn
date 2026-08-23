"""Rename agents to sessions: shells replace launch commands.

Revision ID: 0042
Revises: 0041

Sessions are always the host's login shell, so the per-row launch surface
(argv, env, preset_id) and the retired archive/pin concepts are dropped.
Archived agents have no UI anymore and are deleted (the one deliberate data
deletion of the overhaul); everything else carries over.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0042"
down_revision = "0041"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()

    # Archived agents are deleted, not migrated. Their skill grants go first
    # so the delete works identically whether or not FK cascades are active.
    conn.execute(
        sa.text(
            "DELETE FROM agent_skill_grants WHERE agent_id IN "
            "(SELECT id FROM agents WHERE archived_at IS NOT NULL)"
        )
    )
    conn.execute(sa.text("DELETE FROM agents WHERE archived_at IS NOT NULL"))

    op.rename_table("agents", "sessions")
    with op.batch_alter_table("sessions") as batch:
        batch.drop_column("argv")
        batch.drop_column("env")
        batch.drop_column("preset_id")
        batch.drop_column("archived_at")
        batch.drop_column("pinned_at")
        batch.add_column(sa.Column("foreground_command", sa.String(255), nullable=True))
    op.drop_index("ix_agents_owner_user_id", table_name="sessions")
    op.drop_index("ix_agents_host_id", table_name="sessions")
    op.create_index("ix_sessions_owner_user_id", "sessions", ["owner_user_id"])
    op.create_index("ix_sessions_host_id", "sessions", ["host_id"])

    op.rename_table("agent_skill_grants", "session_skill_grants")
    # Column rename first, in its own step: creating a constraint on a column
    # renamed inside the same SQLite batch silently loses the constraint.
    op.alter_column(
        "session_skill_grants", "agent_id", new_column_name="session_id",
        existing_type=sa.String(36),
    )
    with op.batch_alter_table("session_skill_grants") as batch:
        batch.drop_constraint("uq_agent_skill_grants", type_="unique")
        batch.create_unique_constraint("uq_session_skill_grants", ["session_id", "skill_id"])
    op.drop_index("ix_agent_skill_grants_owner_user_id", table_name="session_skill_grants")
    op.drop_index("ix_agent_skill_grants_agent_id", table_name="session_skill_grants")
    op.drop_index("ix_agent_skill_grants_skill_id", table_name="session_skill_grants")
    op.create_index(
        "ix_session_skill_grants_owner_user_id", "session_skill_grants", ["owner_user_id"]
    )
    op.create_index(
        "ix_session_skill_grants_session_id", "session_skill_grants", ["session_id"]
    )
    op.create_index("ix_session_skill_grants_skill_id", "session_skill_grants", ["skill_id"])


def downgrade() -> None:
    op.drop_index("ix_session_skill_grants_skill_id", table_name="session_skill_grants")
    op.drop_index("ix_session_skill_grants_session_id", table_name="session_skill_grants")
    op.drop_index("ix_session_skill_grants_owner_user_id", table_name="session_skill_grants")
    with op.batch_alter_table("session_skill_grants") as batch:
        batch.drop_constraint("uq_session_skill_grants", type_="unique")
        batch.create_unique_constraint("uq_agent_skill_grants", ["session_id", "skill_id"])
    op.alter_column(
        "session_skill_grants", "session_id", new_column_name="agent_id",
        existing_type=sa.String(36),
    )
    op.rename_table("session_skill_grants", "agent_skill_grants")
    op.create_index(
        "ix_agent_skill_grants_owner_user_id", "agent_skill_grants", ["owner_user_id"]
    )
    op.create_index("ix_agent_skill_grants_agent_id", "agent_skill_grants", ["agent_id"])
    op.create_index("ix_agent_skill_grants_skill_id", "agent_skill_grants", ["skill_id"])

    op.drop_index("ix_sessions_host_id", table_name="sessions")
    op.drop_index("ix_sessions_owner_user_id", table_name="sessions")

    with op.batch_alter_table("sessions") as batch:
        batch.drop_column("foreground_command")
        batch.add_column(sa.Column("pinned_at", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("preset_id", sa.String(36), nullable=True))
        batch.create_foreign_key(
            "fk_agents_preset_id_presets", "presets", ["preset_id"], ["id"],
            ondelete="SET NULL",
        )
        batch.add_column(sa.Column("env", sa.JSON(), nullable=True))
        batch.add_column(sa.Column("argv", sa.JSON(), nullable=True))
    op.rename_table("sessions", "agents")

    # The v2 rows launched shells; restore a matching launch surface so the
    # downgraded server can respawn them. Archived rows are gone for good.
    conn = op.get_bind()
    conn.execute(sa.text("UPDATE agents SET argv = :argv, env = :env"), {"argv": '[]', "env": "{}"})
    with op.batch_alter_table("agents") as batch:
        batch.alter_column("argv", existing_type=sa.JSON(), nullable=False)
        batch.alter_column("env", existing_type=sa.JSON(), nullable=False)
    op.create_index("ix_agents_owner_user_id", "agents", ["owner_user_id"])
    op.create_index("ix_agents_host_id", "agents", ["host_id"])
