"""Flatten screens: drop the tab layer; each former tab becomes a screen."""

from __future__ import annotations

import json
import uuid

import sqlalchemy as sa

from alembic import op

# revision identifiers
revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    rows = conn.execute(
        sa.text("SELECT id, owner_user_id, name, layout, created_at, updated_at FROM screens")
    ).fetchall()
    for row in rows:
        layout = row.layout if isinstance(row.layout, dict) else json.loads(row.layout or "{}")
        if "tabs" not in layout:
            continue  # already flat
        tabs = layout.get("tabs") or []
        first_root = tabs[0].get("root") if tabs else None
        conn.execute(
            sa.text("UPDATE screens SET layout = :layout WHERE id = :id"),
            {"layout": json.dumps({"root": first_root}), "id": row.id},
        )
        # Extra tabs graduate into screens of their own so no layout is lost.
        for index, tab in enumerate(tabs[1:], start=2):
            tab_name = (tab.get("name") or "").strip()
            name = f"{row.name} · {tab_name}" if tab_name else f"{row.name} {index}"
            conn.execute(
                sa.text(
                    "INSERT INTO screens (id, owner_user_id, name, layout, created_at, updated_at)"
                    " VALUES (:id, :owner, :name, :layout, :created_at, :updated_at)"
                ),
                {
                    "id": str(uuid.uuid4()),
                    "owner": row.owner_user_id,
                    "name": name[:128],
                    "layout": json.dumps({"root": tab.get("root")}),
                    "created_at": row.created_at,
                    "updated_at": row.updated_at,
                },
            )


def downgrade() -> None:
    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id, layout FROM screens")).fetchall()
    for row in rows:
        layout = row.layout if isinstance(row.layout, dict) else json.loads(row.layout or "{}")
        if "root" not in layout:
            continue
        conn.execute(
            sa.text("UPDATE screens SET layout = :layout WHERE id = :id"),
            {
                "layout": json.dumps({"tabs": [{"name": None, "root": layout.get("root")}]}),
                "id": row.id,
            },
        )
