"""Migration 0050 (12x12 grid -> 24x24) is safe whatever order things deploy in.

Scaling coordinates is not idempotent, and a doubled layout is indistinguishable
from an un-doubled one by inspection — so 0050 keys off the per-grid `version`
field instead. These tests pin the three cases that matter in production:

* a v2 grid is lifted exactly once,
* re-running the migration changes nothing,
* a v3 grid that reached the database ahead of the migration (new application
  code deployed before `alembic upgrade`, its writes lifted by the API) is left
  alone rather than doubled a second time.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

from sqlalchemy import create_engine, text

from tests.test_migrations_overhaul import _alembic, _migration_env

USER_ID = "11111111-1111-4111-8111-111111111111"


def _seed_workspace(conn, name: str, layout: dict) -> str:
    workspace_id = str(uuid.uuid4())
    conn.execute(
        text(
            "INSERT INTO workspaces (id, owner_user_id, name, layout, position,"
            " created_at, updated_at)"
            " VALUES (:id, :owner, :name, :layout, 0, :now, :now)"
        ),
        {
            "id": workspace_id,
            "owner": USER_ID,
            "name": name,
            "layout": json.dumps(layout),
            "now": "2026-01-01 00:00:00",
        },
    )
    return workspace_id


def _envelope(version: int, tiles: list[dict]) -> dict:
    return {
        "version": 3,
        "active_tab": "tab-1",
        "tabs": [{"id": "tab-1", "name": "Tab 1", "layout": {"version": version, "tiles": tiles}}],
    }


def _grid(conn, workspace_id: str) -> dict:
    raw = conn.execute(
        text("SELECT layout FROM workspaces WHERE id = :id"), {"id": workspace_id}
    ).scalar_one()
    return json.loads(raw)["tabs"][0]["layout"]


def _rects(grid_layout: dict) -> list[tuple[int, int, int, int]]:
    return [(t["x"], t["y"], t["w"], t["h"]) for t in grid_layout["tiles"]]


def _seed_user(conn) -> None:
    conn.execute(
        text(
            "INSERT INTO users (id, email, password_hash, created_at)"
            " VALUES (:id, :email, 'x', :now)"
        ),
        {"id": USER_ID, "email": "grid@example.com", "now": "2026-01-01 00:00:00"},
    )


def test_0050_lifts_v2_once_and_leaves_v3_alone(tmp_path: Path):
    db_path = tmp_path / "spawn-grid-24.db"
    env = _migration_env(f"sqlite+aiosqlite:///{db_path}")
    sync_url = f"sqlite:///{db_path}"

    _alembic(["upgrade", "0049"], env=env)
    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            _seed_user(conn)
            old = _seed_workspace(
                conn,
                "still v2",
                _envelope(2, [{"session_id": "a", "x": 0, "y": 0, "w": 6, "h": 12}]),
            )
            # Written by application code that shipped ahead of the migration:
            # already in the new space, already stamped v3.
            ahead = _seed_workspace(
                conn,
                "already v3",
                _envelope(3, [{"session_id": "b", "x": 0, "y": 0, "w": 12, "h": 24}]),
            )
    finally:
        engine.dispose()

    _alembic(["upgrade", "head"], env=env)

    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            lifted = _grid(conn, old)
            assert lifted["version"] == 3
            assert _rects(lifted) == [(0, 0, 12, 24)]
            untouched = _grid(conn, ahead)
            assert untouched["version"] == 3
            assert _rects(untouched) == [(0, 0, 12, 24)], "a v3 grid must not be scaled again"
    finally:
        engine.dispose()

    # Re-running the whole chain is a no-op: nothing is stamped v2 any more.
    _alembic(["upgrade", "head"], env=env)
    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            assert _rects(_grid(conn, old)) == [(0, 0, 12, 24)]
            assert _rects(_grid(conn, ahead)) == [(0, 0, 12, 24)]
    finally:
        engine.dispose()


def test_0050_downgrade_returns_the_old_space_and_is_also_idempotent(tmp_path: Path):
    db_path = tmp_path / "spawn-grid-24-down.db"
    env = _migration_env(f"sqlite+aiosqlite:///{db_path}")
    sync_url = f"sqlite:///{db_path}"

    _alembic(["upgrade", "0049"], env=env)
    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            _seed_user(conn)
            workspace = _seed_workspace(
                conn,
                "round trip",
                _envelope(
                    2,
                    [
                        {"session_id": "a", "x": 0, "y": 0, "w": 6, "h": 12},
                        {"session_id": "b", "x": 6, "y": 0, "w": 6, "h": 12},
                    ],
                ),
            )
    finally:
        engine.dispose()

    _alembic(["upgrade", "head"], env=env)
    _alembic(["downgrade", "0049"], env=env)

    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            back = _grid(conn, workspace)
            assert back["version"] == 2
            assert _rects(back) == [(0, 0, 6, 12), (6, 0, 6, 12)]
    finally:
        engine.dispose()

    # A second downgrade must not halve what is already back in the old space.
    _alembic(["downgrade", "0049"], env=env)
    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            assert _rects(_grid(conn, workspace)) == [(0, 0, 6, 12), (6, 0, 6, 12)]
    finally:
        engine.dispose()
