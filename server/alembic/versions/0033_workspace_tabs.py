"""Workspace layout v2 -> v3: wrap each tile grid in a single-tab envelope.

Revision ID: 0033
Revises: 0032

Layout schema v3 (tabs) puts an ordered list of named tabs above the v2 tile
grid; the v2 algebra itself is unchanged. Every stored v2 layout becomes one
default tab, using the same deterministic id/name the runtime upgrade in
``routes/workspaces.parse_workspace_layout`` produces, so pre- and
post-migration rows read identically. Downgrade unwraps the first tab and
discards the rest (their sessions survive; layout pruning re-places nothing).
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op

revision = "0033"
down_revision = "0032"
branch_labels = None
depends_on = None

DEFAULT_TAB_ID = "tab-1"
DEFAULT_TAB_NAME = "Tab 1"


def _load(raw: object) -> dict | None:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, (str, bytes)):
        try:
            parsed = json.loads(raw)
        except ValueError:
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def upgrade() -> None:
    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id, layout FROM workspaces")).fetchall()
    for row in rows:
        layout = _load(row.layout)
        if layout is not None and layout.get("version") == 3:
            continue
        tiles = (
            layout["tiles"]
            if layout is not None
            and layout.get("version") == 2
            and isinstance(layout.get("tiles"), list)
            else []
        )
        wrapped = {
            "version": 3,
            "active_tab": DEFAULT_TAB_ID,
            "tabs": [
                {
                    "id": DEFAULT_TAB_ID,
                    "name": DEFAULT_TAB_NAME,
                    "layout": {"version": 2, "tiles": tiles},
                }
            ],
        }
        conn.execute(
            sa.text("UPDATE workspaces SET layout = :layout WHERE id = :id"),
            {"layout": json.dumps(wrapped), "id": row.id},
        )


def downgrade() -> None:
    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id, layout FROM workspaces")).fetchall()
    for row in rows:
        layout = _load(row.layout)
        if layout is None or layout.get("version") != 3:
            continue
        tabs = layout.get("tabs")
        first = tabs[0] if isinstance(tabs, list) and tabs else None
        tiles = (
            first["layout"]["tiles"]
            if isinstance(first, dict)
            and isinstance(first.get("layout"), dict)
            and isinstance(first["layout"].get("tiles"), list)
            else []
        )
        conn.execute(
            sa.text("UPDATE workspaces SET layout = :layout WHERE id = :id"),
            {"layout": json.dumps({"version": 2, "tiles": tiles}), "id": row.id},
        )
