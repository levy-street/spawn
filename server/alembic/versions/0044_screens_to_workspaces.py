"""Rename screens to workspaces and convert layouts to the v2 packed grid.

Revision ID: 0044
Revises: 0043

Split-tree v1 layouts become 12x12 grid-v2 tile lists via the shared algebra
in ``spawn_server.grid`` (the same conversion the web implements from the
shared fixtures). Tiles referencing sessions deleted by 0029 are dropped
first; an emptied layout becomes ``{"version": 2, "tiles": []}``. The retired
ephemeral/pinned concepts are dropped and a `position` ordering is added,
backfilled by name order per owner.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager

import sqlalchemy as sa

from alembic import op
from spawn_server import grid

revision = "0044"
# The canvas this migration was written against. `spawn_server.grid` follows
# the live constants, which 0037 later doubled — but a migration has to keep
# producing the geometry of its own era, or 0037 would rescale tiles that were
# already born at the new size. Pin the algebra while it runs here.
ERA_GRID_SIZE = 12
ERA_MIN_TILE_SIZE = 2
ERA_MAX_TILES = 8
down_revision = "0043"
branch_labels = None
depends_on = None


@contextmanager
def _era_grid() -> Iterator[None]:
    """Run the shared split-tree conversion on this migration's own canvas."""
    saved = (grid.GRID_COLS, grid.GRID_ROWS, grid.MIN_TILE_SIZE, grid.MAX_TILES)
    grid.GRID_COLS = grid.GRID_ROWS = ERA_GRID_SIZE
    grid.MIN_TILE_SIZE = ERA_MIN_TILE_SIZE
    grid.MAX_TILES = ERA_MAX_TILES
    try:
        yield
    finally:
        grid.GRID_COLS, grid.GRID_ROWS, grid.MIN_TILE_SIZE, grid.MAX_TILES = saved


def _parse_layout(raw: object) -> dict:
    if isinstance(raw, dict):
        return raw
    try:
        parsed = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _normalize_v1_node(node: object, keep: set[str], seen: set[str]) -> dict | None:
    """Prune dead/duplicate panes and collapse single-child splits so the
    tree stays well-formed before conversion. Pane keys stay `agent_id` —
    `from_split_tree` maps them to tile session_ids verbatim."""
    if not isinstance(node, dict):
        return None
    if node.get("type") == "pane":
        session_id = node.get("agent_id")
        if not isinstance(session_id, str) or session_id not in keep or session_id in seen:
            return None
        seen.add(session_id)
        return {"type": "pane", "agent_id": session_id}
    if node.get("type") != "split":
        return None
    a = _normalize_v1_node(node.get("a"), keep, seen)
    b = _normalize_v1_node(node.get("b"), keep, seen)
    if a is None:
        return b
    if b is None:
        return a
    ratio = node.get("ratio", 0.5)
    if not isinstance(ratio, int | float):
        ratio = 0.5
    direction = node.get("direction")
    if direction not in ("row", "column"):
        direction = "row"
    return {"type": "split", "direction": direction, "ratio": ratio, "a": a, "b": b}


def upgrade() -> None:
    op.rename_table("screens", "workspaces")
    with op.batch_alter_table("workspaces") as batch:
        batch.drop_column("ephemeral")
        batch.drop_column("pinned_at")
        batch.add_column(
            sa.Column("position", sa.Integer(), nullable=False, server_default="0")
        )
    # The owner index still carried its 0011 "views" name; fix it in passing.
    op.drop_index("ix_views_owner_user_id", table_name="workspaces")
    op.create_index("ix_workspaces_owner_user_id", "workspaces", ["owner_user_id"])

    conn = op.get_bind()
    surviving_sessions = set(
        conn.execute(sa.text("SELECT id FROM sessions")).scalars().all()
    )
    rows = conn.execute(
        sa.text("SELECT id, owner_user_id, name, layout FROM workspaces")
    ).fetchall()

    by_owner: dict[str, list] = {}
    for row in rows:
        by_owner.setdefault(row.owner_user_id, []).append(row)
    for owner_rows in by_owner.values():
        ordered = sorted(owner_rows, key=lambda row: (row.name, row.id))
        for position, row in enumerate(ordered):
            conn.execute(
                sa.text("UPDATE workspaces SET position = :position WHERE id = :id"),
                {"position": position, "id": row.id},
            )

    for row in rows:
        root = _normalize_v1_node(
            _parse_layout(row.layout).get("root"), surviving_sessions, set()
        )
        with _era_grid():
            tiles = grid.from_split_tree(root)
        conn.execute(
            sa.text("UPDATE workspaces SET layout = :layout WHERE id = :id"),
            {"layout": json.dumps({"version": 2, "tiles": tiles}), "id": row.id},
        )


def _tiles_to_v1_tree(tiles: list[dict]) -> dict | None:
    """Fold tiles (reading order) into nested column splits — enough for the
    downgraded split-tree renderer, not a faithful geometric inverse."""
    ordered = sorted(tiles, key=lambda tile: (tile["y"], tile["x"]))
    ids = [tile["session_id"] for tile in ordered]

    def build(remaining: list[str]) -> dict:
        if len(remaining) == 1:
            return {"type": "pane", "agent_id": remaining[0]}
        ratio = min(0.95, max(0.05, 1.0 / len(remaining)))
        return {
            "type": "split",
            "direction": "column",
            "ratio": ratio,
            "a": {"type": "pane", "agent_id": remaining[0]},
            "b": build(remaining[1:]),
        }

    return build(ids) if ids else None


def downgrade() -> None:
    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id, layout FROM workspaces")).fetchall()
    for row in rows:
        layout = _parse_layout(row.layout)
        tiles = layout.get("tiles") if isinstance(layout.get("tiles"), list) else []
        conn.execute(
            sa.text("UPDATE workspaces SET layout = :layout WHERE id = :id"),
            {"layout": json.dumps({"root": _tiles_to_v1_tree(tiles)}), "id": row.id},
        )

    op.drop_index("ix_workspaces_owner_user_id", table_name="workspaces")
    with op.batch_alter_table("workspaces") as batch:
        batch.drop_column("position")
        batch.add_column(
            sa.Column("ephemeral", sa.Boolean(), nullable=False, server_default=sa.false())
        )
        batch.add_column(sa.Column("pinned_at", sa.DateTime(timezone=True), nullable=True))
    op.rename_table("workspaces", "screens")
    op.create_index("ix_views_owner_user_id", "screens", ["owner_user_id"])
