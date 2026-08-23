"""Tab folder: each tab's own default host and folder.

Revision ID: 0052
Revises: 0051

A window added to a tab opens in that tab's folder, falling back to the
workspace's home when the tab has none of its own. Nothing is stored in a
column — the pair lives in the layout envelope's tabs (layout schema v3), so
this migration only backfills existing rows and normalizes their shape:

Each tab takes the host/folder of its first session tile (the tab's own reading
order), which is where its windows have been opening all along. A tab whose
sessions are gone — or whose panes are all widgets — is left exactly as it was:
an absent pair reads as "inherit the workspace's home", so those rows need no
rewrite at all.

Downgrade strips the two keys from every tab, leaving the pre-0039 shape.
"""

from __future__ import annotations

import json
from typing import Any

import sqlalchemy as sa

from alembic import op

revision = "0052"
down_revision = "0051"
branch_labels = None
depends_on = None


def _load(raw: object) -> Any:
    if isinstance(raw, (str, bytes)):
        try:
            return json.loads(raw)
        except ValueError:
            return None
    return raw


def _reading_order(tiles: list) -> list:
    return sorted(
        (tile for tile in tiles if isinstance(tile, dict)),
        key=lambda tile: (tile.get("y", 0), tile.get("x", 0)),
    )


def _tab_folders(conn: sa.engine.Connection, layout: dict) -> bool:
    """Fill each tab's host_id/cwd from its first session. True if changed."""
    changed = False
    for tab in layout.get("tabs") or []:
        if not isinstance(tab, dict) or tab.get("host_id") is not None:
            continue
        tiles = (tab.get("layout") or {}).get("tiles") or []
        found = None
        for tile in _reading_order(tiles if isinstance(tiles, list) else []):
            if "widget" in tile or not isinstance(tile.get("session_id"), str):
                continue
            found = conn.execute(
                sa.text("SELECT host_id, cwd FROM sessions WHERE id = :id"),
                {"id": tile["session_id"]},
            ).fetchone()
            if found is not None:
                break
        if found is None:
            # Nothing to inherit from: the tab keeps no folder of its own and
            # follows the workspace's home, so the row is left untouched.
            continue
        tab["host_id"] = found.host_id
        tab["cwd"] = found.cwd
        changed = True
    return changed


def _strip(layout: object, keys: tuple[str, ...] = ("host_id", "cwd")) -> bool:
    changed = False
    if not isinstance(layout, dict):
        return False
    for tab in layout.get("tabs") or []:
        if not isinstance(tab, dict):
            continue
        for key in keys:
            if key in tab:
                del tab[key]
                changed = True
    return changed


def _rewrite(conn: sa.engine.Connection, column: str, apply: Any) -> None:
    rows = conn.execute(sa.text(f"SELECT id, {column} FROM workspaces")).fetchall()
    for row in rows:
        stored = _load(getattr(row, column))
        if not isinstance(stored, dict) or not isinstance(stored.get("tabs"), list):
            continue
        if not apply(stored):
            continue
        conn.execute(
            sa.text(f"UPDATE workspaces SET {column} = :value WHERE id = :id"),
            {"value": json.dumps(stored), "id": row.id},
        )


def upgrade() -> None:
    conn = op.get_bind()
    _rewrite(conn, "layout", lambda layout: _tab_folders(conn, layout))


def downgrade() -> None:
    conn = op.get_bind()
    _rewrite(conn, "layout", _strip)
