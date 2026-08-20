"""Archiving suspends a workspace instead of dismantling it.

Revision ID: 0040
Revises: 0039

0038 archived by killing and deleting a workspace's sessions and keeping a
snapshot of its shape in ``archived_shape`` to rebuild from. Archiving now
stops the sessions and keeps their rows, so the layout keeps naming the same
windows in the same places and a restore restarts them where they stopped —
which leaves nothing for a snapshot to hold, and nothing to rebuild.

Existing snapshots are replayed into the layout on the way through: a
workspace archived under the old scheme has an emptied ``layout`` and its
sessions are already gone, so there is nothing to restart. Those workspaces
are unarchived here rather than left holding a shape no code reads any more.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0040"
down_revision = "0039"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    # Snapshot-era archives cannot be carried over: their sessions were
    # deleted. Bring the workspaces back rather than strand them.
    conn.execute(
        sa.text(
            "UPDATE workspaces SET archived_at = NULL "
            "WHERE archived_at IS NOT NULL AND archived_shape IS NOT NULL"
        )
    )
    with op.batch_alter_table("workspaces") as batch:
        batch.drop_column("archived_shape")


def downgrade() -> None:
    with op.batch_alter_table("workspaces") as batch:
        batch.add_column(sa.Column("archived_shape", sa.JSON(), nullable=True))
