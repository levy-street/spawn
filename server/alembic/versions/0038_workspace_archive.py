"""Workspace archive: put a workspace away without destroying its shape.

Revision ID: 0038
Revises: 0037

Delete is the only way a workspace leaves the sidebar today, and it kills and
hard-deletes every session in it. Archive is the everyday alternative: the
sessions still stop, but the workspace's *shape* — its tabs, tile geometry,
and each pane's host/folder/skills — is captured first and can be replayed.

Two nullable columns, no data migration; every existing workspace is active
(``archived_at IS NULL``) and unchanged.

``archived_at`` is a timestamp rather than a boolean so the UI can say
"archived 3 days ago" and a retention sweep stays possible later.
``archived_shape`` holds the snapshot (schema below, validated by
``schemas.WorkspaceArchivedShape``) and is only ever set while archived —
it cannot live in ``layout`` because ``prune_workspace_tiles`` drops tiles
whose session row is gone, which is precisely what archiving does.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0038"
down_revision = "0037"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("workspaces") as batch:
        batch.add_column(sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("archived_shape", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("workspaces") as batch:
        batch.drop_column("archived_shape")
        batch.drop_column("archived_at")
