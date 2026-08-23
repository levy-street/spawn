"""Workspace home: the host and folder a workspace was created in.

Revision ID: 0047
Revises: 0046

Adds nullable ``host_id`` / ``cwd`` columns so the folder is chosen once at
workspace creation and new sessions default there. Backfilled from the first
session tile in the workspace's layout (tabs in order, reading order within),
which is the session its creation flow opened; workspaces whose sessions are
all gone stay NULL and the client falls back to asking.
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op

revision = "0047"
down_revision = "0046"
branch_labels = None
depends_on = None


def _first_session_id(raw: object) -> str | None:
    layout = raw
    if isinstance(layout, (str, bytes)):
        try:
            layout = json.loads(layout)
        except ValueError:
            return None
    if not isinstance(layout, dict) or layout.get("version") != 3:
        return None
    for tab in layout.get("tabs") or []:
        if not isinstance(tab, dict):
            continue
        tiles = (tab.get("layout") or {}).get("tiles") or []
        for tile in sorted(
            (t for t in tiles if isinstance(t, dict) and "widget" not in t),
            key=lambda t: (t.get("y", 0), t.get("x", 0)),
        ):
            session_id = tile.get("session_id")
            if isinstance(session_id, str):
                return session_id
    return None


def upgrade() -> None:
    with op.batch_alter_table("workspaces") as batch:
        batch.add_column(
            sa.Column(
                "host_id",
                sa.String(36),
                sa.ForeignKey(
                    "hosts.id",
                    ondelete="SET NULL",
                    # SQLite batch mode requires named constraints.
                    name="fk_workspaces_host_id_hosts",
                ),
                nullable=True,
            )
        )
        batch.add_column(sa.Column("cwd", sa.String(1024), nullable=True))

    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id, layout FROM workspaces")).fetchall()
    for row in rows:
        session_id = _first_session_id(row.layout)
        if session_id is None:
            continue
        found = conn.execute(
            sa.text("SELECT host_id, cwd FROM sessions WHERE id = :id"),
            {"id": session_id},
        ).fetchone()
        if found is None:
            continue
        conn.execute(
            sa.text("UPDATE workspaces SET host_id = :host_id, cwd = :cwd WHERE id = :id"),
            {"host_id": found.host_id, "cwd": found.cwd, "id": row.id},
        )


def downgrade() -> None:
    with op.batch_alter_table("workspaces") as batch:
        batch.drop_column("cwd")
        batch.drop_column("host_id")
