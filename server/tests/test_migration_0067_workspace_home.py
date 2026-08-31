"""Migration 0067 (workspace home, second pass) adopts a live session's folder.

0047 read only the first tile in the layout and gave up when that session was
gone — the exact shape of a long-lived workspace, which then asks where every
new window should open, forever. 0067 walks the tiles in the same order but
past the gone ones, adopting the first session that still exists; rows that
already have a home, and rows with no surviving sessions, come out untouched.

Pinned to revision 0067 rather than head so later migrations reshaping the
workspaces table cannot drift under what is being tested.
"""

from __future__ import annotations

import json
from pathlib import Path

from sqlalchemy import create_engine, text

from tests.test_migrations_overhaul import _alembic, _migration_env

USER_ID = "66666666-6666-4666-8666-666666666666"
HOST_ID = "77777777-7777-4777-8777-777777777777"
LIVE_SESSION_ID = "88888888-8888-4888-8888-888888888888"
KEPT_SESSION_ID = "99999999-9999-4999-8999-999999999999"
NOW = "2026-01-01 00:00:00"

HOMELESS_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
HOMED_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
EMPTIED_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"


def _tab(tab_id: str, tiles: list[dict]) -> dict:
    return {"id": tab_id, "name": tab_id, "layout": {"version": 3, "tiles": tiles}}


def _tile(session_id: str, x: int, **extra: object) -> dict:
    return {"session_id": session_id, "x": x, "y": 0, "w": 6, "h": 24, **extra}


# Reading order meets the gone session first, then a widget, then the live
# one two tabs of walking later — the walk has to survive all three.
HOMELESS_LAYOUT = {
    "version": 3,
    "active_tab": "tab-1",
    "tabs": [
        _tab("tab-1", [_tile("long-gone", 0), _tile("widget-1", 6, widget={"kind": "files"})]),
        _tab("tab-2", [_tile(LIVE_SESSION_ID, 0)]),
    ],
}
HOMED_LAYOUT = {
    "version": 3,
    "active_tab": "tab-1",
    "tabs": [_tab("tab-1", [_tile(KEPT_SESSION_ID, 0)])],
}
EMPTIED_LAYOUT = {
    "version": 3,
    "active_tab": "tab-1",
    "tabs": [_tab("tab-1", [_tile("also-gone", 0)])],
}


def _seed(conn) -> None:
    conn.execute(
        text(
            "INSERT INTO users (id, email, password_hash, created_at)"
            " VALUES (:id, :email, 'x', :now)"
        ),
        {"id": USER_ID, "email": "home-second-pass@example.com", "now": NOW},
    )
    conn.execute(
        text(
            "INSERT INTO hosts (id, owner_user_id, name, status, created_at,"
            " daemon_generation, daemon_generation_counter)"
            " VALUES (:id, :owner, 'Mac', 'online', :now, 0, 0)"
        ),
        {"id": HOST_ID, "owner": USER_ID, "now": NOW},
    )
    for session_id, cwd in ((LIVE_SESSION_ID, "/repo/live"), (KEPT_SESSION_ID, "/repo/other")):
        conn.execute(
            text(
                "INSERT INTO sessions (id, owner_user_id, host_id, cwd, status, started_at)"
                " VALUES (:id, :owner, :host, :cwd, 'running', :now)"
            ),
            {"id": session_id, "owner": USER_ID, "host": HOST_ID, "cwd": cwd, "now": NOW},
        )
    rows = (
        (HOMELESS_ID, HOMELESS_LAYOUT, None, None),
        (HOMED_ID, HOMED_LAYOUT, HOST_ID, "/repo/kept"),
        (EMPTIED_ID, EMPTIED_LAYOUT, None, None),
    )
    for index, (workspace_id, layout, host_id, cwd) in enumerate(rows):
        conn.execute(
            text(
                "INSERT INTO workspaces (id, owner_user_id, name, layout, position,"
                " host_id, cwd, created_at, updated_at)"
                " VALUES (:id, :owner, :name, :layout, :position, :host, :cwd, :now, :now)"
            ),
            {
                "id": workspace_id,
                "owner": USER_ID,
                "name": workspace_id,
                "layout": json.dumps(layout),
                "position": index,
                "host": host_id,
                "cwd": cwd,
                "now": NOW,
            },
        )


def _home(conn, workspace_id: str) -> tuple[str | None, str | None]:
    return conn.execute(
        text("SELECT host_id, cwd FROM workspaces WHERE id = :id"), {"id": workspace_id}
    ).one()


def test_0067_adopts_the_first_surviving_session_and_touches_nothing_else(tmp_path: Path):
    db_path = tmp_path / "spawn-home-second-pass.db"
    env = _migration_env(f"sqlite+aiosqlite:///{db_path}")
    sync_url = f"sqlite:///{db_path}"

    _alembic(["upgrade", "0061"], env=env)
    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            _seed(conn)
    finally:
        engine.dispose()

    _alembic(["upgrade", "0067"], env=env)
    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            # Walked past the gone session and the widget to the live one.
            assert _home(conn, HOMELESS_ID) == (HOST_ID, "/repo/live")
            # A home already chosen is not rewritten by its own sessions.
            assert _home(conn, HOMED_ID) == (HOST_ID, "/repo/kept")
            # No surviving sessions: still homeless, and the client still asks.
            assert _home(conn, EMPTIED_ID) == (None, None)
    finally:
        engine.dispose()
