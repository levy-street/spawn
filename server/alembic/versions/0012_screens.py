"""Rename views to screens and convert layouts to split trees."""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op

# revision identifiers
revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def _tree_from_agent_ids(agent_ids: list[str]) -> dict | None:
    """Mirror the old count-based auto-grid: 2 side-by-side, 3 with a tall
    lead pane, 4 as a 2x2."""
    panes = [{"type": "pane", "agent_id": agent_id} for agent_id in agent_ids]
    if not panes:
        return None
    if len(panes) == 1:
        return panes[0]

    def split(direction: str, a: dict, b: dict) -> dict:
        return {"type": "split", "direction": direction, "ratio": 0.5, "a": a, "b": b}

    if len(panes) == 2:
        return split("row", panes[0], panes[1])
    if len(panes) == 3:
        return split("row", panes[0], split("column", panes[1], panes[2]))
    # 4+ (old cap was 4): pair into columns, then rows of pairs.
    rows: list[dict] = []
    for i in range(0, len(panes), 2):
        pair = panes[i : i + 2]
        rows.append(pair[0] if len(pair) == 1 else split("row", pair[0], pair[1]))
    root = rows[0]
    for row in rows[1:]:
        root = split("column", root, row)
    return root


def upgrade() -> None:
    op.rename_table("views", "screens")

    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id, layout FROM screens")).fetchall()
    for row in rows:
        layout = row.layout if isinstance(row.layout, dict) else json.loads(row.layout or "{}")
        tabs = layout.get("tabs") or []
        converted = {
            "tabs": [
                {
                    "name": tab.get("name"),
                    "root": _tree_from_agent_ids(tab.get("agent_ids") or [])
                    if "agent_ids" in tab
                    else tab.get("root"),
                }
                for tab in tabs
            ]
        }
        conn.execute(
            sa.text("UPDATE screens SET layout = :layout WHERE id = :id"),
            {"layout": json.dumps(converted), "id": row.id},
        )


def downgrade() -> None:
    op.rename_table("screens", "views")
