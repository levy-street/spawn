"""Migration 0040: archiving becomes suspend, so the snapshot column goes.

Under 0038 an archived workspace had its sessions deleted and its shape held
in ``archived_shape``. Archiving now stops the sessions and keeps their rows,
so the layout itself is the record and the snapshot has no reader left.

The one thing 0040 has to be careful about is a workspace archived under the
old scheme: its sessions are gone and its layout was emptied, so restoring it
would produce a blank workspace. Those rows come back active instead of
staying put away with a shape nothing will ever replay.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

from sqlalchemy import create_engine, inspect, text

from tests.test_migrations_overhaul import _alembic, _migration_env

USER_ID = "33333333-3333-4333-8333-333333333333"
LAYOUT = {
    "version": 3,
    "active_tab": "tab-1",
    "tabs": [{"id": "tab-1", "name": "Tab 1", "layout": {"version": 3, "tiles": []}}],
}


def _seed(conn, name: str, position: int) -> str:
    workspace_id = str(uuid.uuid4())
    conn.execute(
        text(
            "INSERT INTO workspaces (id, owner_user_id, name, cwd, layout, position,"
            " created_at, updated_at)"
            " VALUES (:id, :owner, :name, '/repo', :layout, :position, :now, :now)"
        ),
        {
            "id": workspace_id,
            "owner": USER_ID,
            "name": name,
            "layout": json.dumps(LAYOUT),
            "position": position,
            "now": "2026-01-01 00:00:00",
        },
    )
    return workspace_id


def test_0040_drops_the_shape_and_frees_snapshot_era_archives(tmp_path: Path):
    db_path = tmp_path / "spawn-suspend.db"
    env = _migration_env(f"sqlite+aiosqlite:///{db_path}")
    sync_url = f"sqlite:///{db_path}"

    _alembic(["upgrade", "0039"], env=env)
    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO users (id, email, password_hash, created_at)"
                    " VALUES (:id, :email, 'x', :now)"
                ),
                {"id": USER_ID, "email": "suspend@example.com", "now": "2026-01-01 00:00:00"},
            )
            active = _seed(conn, "active", 0)
            snapshot_era = _seed(conn, "put away", 1)
            conn.execute(
                text(
                    "UPDATE workspaces SET archived_at = :now, archived_shape = :shape"
                    " WHERE id = :id"
                ),
                {
                    "now": "2026-02-01 00:00:00",
                    "shape": json.dumps({"version": 1, "active_tab": None, "tabs": []}),
                    "id": snapshot_era,
                },
            )
    finally:
        engine.dispose()

    _alembic(["upgrade", "head"], env=env)

    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            assert "archived_shape" not in {
                c["name"] for c in inspect(conn).get_columns("workspaces")
            }
            rows = dict(
                conn.execute(text("SELECT id, archived_at FROM workspaces")).all()
            )
            # The old archive comes back rather than sitting on a shape that
            # nothing reads; the active workspace is untouched either way.
            assert rows[active] is None
            assert rows[snapshot_era] is None
    finally:
        engine.dispose()
