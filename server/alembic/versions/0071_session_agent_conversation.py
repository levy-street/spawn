"""A session remembers the conversation its agent was started with.

Revision ID: 0071
Revises: 0070

`sessions.agent_id` (0069) records *which* agent a window was opened as. It
says nothing about *which conversation* that agent is holding, and that is the
thing a restart has to bring back: an agent CLI that installed an update in
the background stays on the old binary until it is relaunched, and relaunching
it from scratch loses the thread the person was in the middle of.

`sessions.agent_session_id` is the conversation identity SPAWN D handed the
agent when it typed the launch command (`claude --session-id <uuid>`), so a
restart can type `claude --resume <uuid>` and land back in the same
conversation on the updated version. The server never reads it: it is an
opaque token chosen by the client, stored so a phone can resume what a
browser started. Existing rows stay NULL; a restart of one of those falls back
to the agent's own "continue the most recent conversation here" flag.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0071"
down_revision = "0070"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("sessions") as batch:
        batch.add_column(sa.Column("agent_session_id", sa.String(64), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("sessions") as batch:
        batch.drop_column("agent_session_id")
