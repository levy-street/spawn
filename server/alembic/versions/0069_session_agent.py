"""A session remembers the agent it was opened as.

Revision ID: 0069
Revises: 0068

Until now the only record of what a window *was* — a Claude Code window, a
Hermes window — was the daemon's report of what held its PTY foreground a
second ago. That answers a different question, and answers it wrongly for two
ordinary cases: a window whose agent has been quit reads as a plain shell, and
a CLI that ships as a script reports its interpreter (`hermes` is a venv
console script, so the kernel calls it "python3"). Duplicating either one
produced a bare shell.

`sessions.agent_id` records the agent SPAWN D launched into the window, so a
duplicate can reproduce the window's type. Existing rows stay NULL and fall
back to the foreground heuristic, which is what they have always used.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0069"
down_revision = "0068"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("sessions") as batch:
        batch.add_column(sa.Column("agent_id", sa.String(36), nullable=True))
        batch.create_foreign_key(
            "fk_sessions_agent_id",
            "agents",
            ["agent_id"],
            ["id"],
            ondelete="SET NULL",
        )


def downgrade() -> None:
    with op.batch_alter_table("sessions") as batch:
        batch.drop_constraint("fk_sessions_agent_id", type_="foreignkey")
        batch.drop_column("agent_id")
