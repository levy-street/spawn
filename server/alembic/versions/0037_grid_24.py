"""Lift stored layouts from the 12x12 grid (schema v2) to 24x24 (schema v3).

Revision ID: 0037
Revises: 0036

The workspace canvas doubles its resolution — 24 snap positions per axis
instead of 12, with the minimum pane size doubling to 4x4 so panes stay the
same fraction of the canvas. Coordinates ARE the wire format, so every stored
layout has to move with it: doubling every x/y/w/h reproduces exactly the same
picture in the new space, and keeps every invariant (bounds, minimum size,
non-overlap) true by construction.

**This migration is driven by the per-grid `version` field, never by the shape
of the numbers.** Scaling is not idempotent, and a layout cannot be told apart
from its own doubled self by inspection — so a grid already stamped v3 is left
alone, and only a v2 grid is lifted. That makes the migration safe to re-run,
safe to roll back and re-apply, and safe when new application code reaches
users before the migration does (those clients' writes arrive as v2 and are
lifted by the API on the way in, or arrive as v3 and are skipped here).

Two places store geometry: ``workspaces.layout`` (a v3 envelope of tabs, each
holding a tile grid) and ``workspace_templates.spec`` (the same geometry
without the sessions), whose own version goes 1 -> 2 for the same reason.
"""

from __future__ import annotations

import json
from typing import Any

import sqlalchemy as sa

from alembic import op

revision = "0037"
down_revision = "0036"
branch_labels = None
depends_on = None

GEOMETRY_KEYS = ("x", "y", "w", "h")
SCALE = 2

# Pinned to this migration rather than imported: `spawn_server.grid` tracks the
# live canvas, and a migration has to keep meaning what it meant when written.
GRID_VERSION_BEFORE = 2
GRID_VERSION_AFTER = 3
SPEC_VERSION_BEFORE = 1
SPEC_VERSION_AFTER = 2


def _load(raw: object) -> Any:
    """Layout columns are JSON on Postgres and TEXT on SQLite."""
    if isinstance(raw, (str, bytes)):
        try:
            return json.loads(raw)
        except ValueError:
            return None
    return raw


def _scaled_tiles(tiles: object, factor: int) -> object:
    if not isinstance(tiles, list):
        return tiles
    out = []
    for tile in tiles:
        if not isinstance(tile, dict):
            out.append(tile)
            continue
        scaled = dict(tile)
        for key in GEOMETRY_KEYS:
            value = scaled.get(key)
            # Anything non-integer is left exactly as found: a malformed row is
            # the validator's problem, and quietly "fixing" it here hides it.
            if isinstance(value, int) and not isinstance(value, bool):
                scaled[key] = value * factor if factor > 0 else value // -factor
        out.append(scaled)
    return out


def _relabelled_layout(raw: object, *, to_version: int) -> Any | None:
    """A workspace envelope whose v2 grids are lifted, or None to skip the row.

    Returns None when nothing needs doing, so untouched rows are never
    rewritten — which keeps a re-run a no-op rather than a second scaling.
    """
    envelope = _load(raw)
    if not isinstance(envelope, dict) or not isinstance(envelope.get("tabs"), list):
        return None
    from_version = GRID_VERSION_BEFORE if to_version == GRID_VERSION_AFTER else GRID_VERSION_AFTER
    factor = SCALE if to_version == GRID_VERSION_AFTER else -SCALE

    changed = False
    tabs = []
    for tab in envelope["tabs"]:
        grid_layout = tab.get("layout") if isinstance(tab, dict) else None
        if not isinstance(grid_layout, dict) or grid_layout.get("version") != from_version:
            tabs.append(tab)
            continue
        changed = True
        tabs.append(
            {
                **tab,
                "layout": {
                    **grid_layout,
                    "version": to_version,
                    "tiles": _scaled_tiles(grid_layout.get("tiles"), factor),
                },
            }
        )
    return {**envelope, "tabs": tabs} if changed else None


def _relabelled_spec(raw: object, *, to_version: int) -> Any | None:
    """A template spec lifted the same way, or None to skip the row."""
    spec = _load(raw)
    if not isinstance(spec, dict) or not isinstance(spec.get("tabs"), list):
        return None
    from_version = SPEC_VERSION_BEFORE if to_version == SPEC_VERSION_AFTER else SPEC_VERSION_AFTER
    if spec.get("version") != from_version:
        return None
    factor = SCALE if to_version == SPEC_VERSION_AFTER else -SCALE
    tabs = [
        {**tab, "tiles": _scaled_tiles(tab.get("tiles"), factor)} if isinstance(tab, dict) else tab
        for tab in spec["tabs"]
    ]
    return {**spec, "version": to_version, "tabs": tabs}


def _rescale(*, grid_version: int, spec_version: int) -> None:
    conn = op.get_bind()

    for row in conn.execute(sa.text("SELECT id, layout FROM workspaces")).fetchall():
        lifted = _relabelled_layout(row.layout, to_version=grid_version)
        if lifted is None:
            continue
        conn.execute(
            sa.text("UPDATE workspaces SET layout = :layout WHERE id = :id"),
            {"layout": json.dumps(lifted), "id": row.id},
        )

    if not sa.inspect(conn).has_table("workspace_templates"):
        return
    for row in conn.execute(sa.text("SELECT id, spec FROM workspace_templates")).fetchall():
        lifted = _relabelled_spec(row.spec, to_version=spec_version)
        if lifted is None:
            continue
        conn.execute(
            sa.text("UPDATE workspace_templates SET spec = :spec WHERE id = :id"),
            {"spec": json.dumps(lifted), "id": row.id},
        )


def upgrade() -> None:
    _rescale(grid_version=GRID_VERSION_AFTER, spec_version=SPEC_VERSION_AFTER)


def downgrade() -> None:
    _rescale(grid_version=GRID_VERSION_BEFORE, spec_version=SPEC_VERSION_BEFORE)
