"""Per-host recent working directories for the new-session cascade.

Revision ID: 0045
Revises: 0044

Backfilled from surviving sessions: the newest ``started_at`` per distinct
path, capped at 8 per (owner, host), so the Recent section works on day one.
"""

from __future__ import annotations

import uuid

import sqlalchemy as sa

from alembic import op

revision = "0045"
down_revision = "0044"
branch_labels = None
depends_on = None

MAX_RECENT_DIRS_PER_HOST = 8


def upgrade() -> None:
    op.create_table(
        "recent_dirs",
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
        sa.Column("path", sa.String(1024), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint(
            "owner_user_id", "host_id", "path", name="uq_recent_dirs_owner_host_path"
        ),
    )

    conn = op.get_bind()
    rows = conn.execute(
        sa.text(
            "SELECT owner_user_id, host_id, cwd, started_at FROM sessions "
            "ORDER BY started_at DESC"
        )
    ).fetchall()

    seen: dict[tuple[str, str], set[str]] = {}
    for row in rows:
        key = (row.owner_user_id, row.host_id)
        paths = seen.setdefault(key, set())
        if row.cwd in paths or len(paths) >= MAX_RECENT_DIRS_PER_HOST:
            continue
        paths.add(row.cwd)
        conn.execute(
            sa.text(
                "INSERT INTO recent_dirs (id, owner_user_id, host_id, path, last_used_at) "
                "VALUES (:id, :owner, :host, :path, :last_used_at)"
            ),
            {
                "id": str(uuid.uuid4()),
                "owner": row.owner_user_id,
                "host": row.host_id,
                "path": row.cwd,
                "last_used_at": row.started_at,
            },
        )


def downgrade() -> None:
    op.drop_table("recent_dirs")
