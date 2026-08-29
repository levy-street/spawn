"""Workspace home, second pass: adopt a live session's folder.

Revision ID: 0062
Revises: 0061

0047 backfilled each workspace's home from the first session tile in its
layout — and skipped the row entirely when that session was already gone,
which is exactly what a long-lived workspace looked like by then. Nothing
after creation ever writes the home back, so those workspaces ask where every
new window should open, forever.

This pass re-runs the backfill for workspaces still missing either half of
the pair, adopting the first tile (tabs in order, reading order within) whose
session still exists. Workspaces with no surviving sessions stay NULL; for
those, session create now adopts the first session made in them
(routes/sessions.py), so the state heals the next time the workspace is used.
"""

from __future__ import annotations

import json
from collections.abc import Iterator

import sqlalchemy as sa

from alembic import op

revision = "0062"
down_revision = "0061"
branch_labels = None
depends_on = None


def _session_ids_in_order(raw: object) -> Iterator[str]:
    """Every session tile's id: tabs in order, reading order within."""
    layout = raw
    if isinstance(layout, (str, bytes)):
        try:
            layout = json.loads(layout)
        except ValueError:
            return
    if not isinstance(layout, dict) or layout.get("version") != 3:
        return
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
                yield session_id


def upgrade() -> None:
    conn = op.get_bind()
    rows = conn.execute(
        sa.text("SELECT id, layout FROM workspaces WHERE host_id IS NULL OR cwd IS NULL")
    ).fetchall()
    for row in rows:
        for session_id in _session_ids_in_order(row.layout):
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
            break


def downgrade() -> None:
    # A home adopted here is indistinguishable from one chosen at creation,
    # and clearing it would only bring the asking back. Nothing to undo.
    pass
