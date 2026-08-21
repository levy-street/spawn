"""Yolo mode: how each agent skips its permission prompts, and who wants it.

Revision ID: 0043
Revises: 0042

Every agent CLI spells "stop asking me" differently — Claude Code takes
``--dangerously-skip-permissions``, Codex ``--dangerously-bypass-approvals-and-sandbox``,
aider ``--yes-always``, and opencode has no flag at all and reads
``OPENCODE_PERMISSION`` from the environment instead. So the *spelling* lives
on the definition, as arguments appended to ``command`` and/or environment
merged over ``env``, and gets seeded for the built-ins on startup.

The *choice* cannot live there. Built-in agents are single rows shared by every
account and immutable through the API, so "I want Claude Code in yolo mode" is
a per-user fact about a row the user does not own. ``agent_preferences`` holds
it: one lazily created row per (owner, agent), absent meaning off.

Additive and off by default — nothing changes what is typed into a shell until
somebody flips the toggle in Settings → Agents.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0043"
down_revision = "0042"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("agents") as batch:
        batch.add_column(sa.Column("yolo_args", sa.String(256), nullable=True))
        batch.add_column(
            sa.Column("yolo_env", sa.JSON(), nullable=False, server_default="{}")
        )

    op.create_table(
        "agent_preferences",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_user_id", sa.String(36), nullable=False),
        sa.Column("agent_id", sa.String(36), nullable=False),
        sa.Column("yolo", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.ForeignKeyConstraint(["owner_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["agent_id"], ["agents.id"], ondelete="CASCADE"),
        sa.UniqueConstraint(
            "owner_user_id", "agent_id", name="uq_agent_preferences_owner_agent"
        ),
    )
    op.create_index(
        "ix_agent_preferences_owner_user_id", "agent_preferences", ["owner_user_id"]
    )
    op.create_index("ix_agent_preferences_agent_id", "agent_preferences", ["agent_id"])


def downgrade() -> None:
    op.drop_index("ix_agent_preferences_agent_id", table_name="agent_preferences")
    op.drop_index("ix_agent_preferences_owner_user_id", table_name="agent_preferences")
    op.drop_table("agent_preferences")
    with op.batch_alter_table("agents") as batch:
        batch.drop_column("yolo_env")
        batch.drop_column("yolo_args")
