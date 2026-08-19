"""`/api/workspaces` — named 12x12 grids of session tiles."""

from __future__ import annotations

import re
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, grid, schemas
from ..db import get_session
from ..models import Host, Session, User, Workspace
from . import capabilities
from .sessions import (
    _to_out as session_to_out,
)
from .sessions import (
    create_session_row,
    dispatch_session_launch,
    kill_and_delete_session,
)

router = APIRouter(prefix="/api/workspaces", tags=["workspaces"])

FIRST_SESSION_TILE = {"x": 0, "y": 0, "w": 12, "h": 12}
_WORKSPACE_NAME_PATTERN = re.compile(r"\AWorkspace (\d+)\Z")

# Layout schema v3 (docs/OVERHAUL.md §4.4-tabs): the stored/wire layout is an
# envelope of named tabs, each holding one v2 tile grid. The v2 algebra and
# its conformance fixtures are untouched; tabs sit above it. The deterministic
# id/name below are what a bare v2 layout upgrades into (migration 0033 and
# `parse_workspace_layout` agree on them).
DEFAULT_TAB_ID = "tab-1"
DEFAULT_TAB_NAME = "Tab 1"
MAX_TABS = 8


def _single_tab_layout(tiles: list[dict]) -> dict:
    return {
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


def _utcnow() -> datetime:
    return datetime.now(UTC)


def parse_workspace_layout(raw: object) -> dict:
    """The stored layout as a plain v3 envelope.

    v2 rows (pre-migration, or written by an old server) upgrade into a single
    default tab; anything malformed reads as one empty tab so a workspace is
    never tabless.
    """
    if isinstance(raw, dict) and raw.get("version") == 3 and isinstance(raw.get("tabs"), list):
        tabs = [
            {
                "id": tab["id"],
                "name": tab["name"],
                "layout": {
                    "version": 2,
                    "tiles": [dict(tile) for tile in tab["layout"]["tiles"]],
                },
            }
            for tab in raw["tabs"]
            if isinstance(tab, dict)
            and isinstance(tab.get("id"), str)
            and isinstance(tab.get("name"), str)
            and isinstance(tab.get("layout"), dict)
            and isinstance(tab["layout"].get("tiles"), list)
        ]
        if tabs:
            active = raw.get("active_tab")
            if not any(tab["id"] == active for tab in tabs):
                active = tabs[0]["id"]
            return {"version": 3, "active_tab": active, "tabs": tabs}
    if isinstance(raw, dict) and raw.get("version") == 2 and isinstance(
        raw.get("tiles"), list
    ):
        return _single_tab_layout([dict(tile) for tile in raw["tiles"]])
    return _single_tab_layout([])


def active_tab(layout: dict) -> dict:
    """The envelope's active tab (falling back to the first)."""
    for tab in layout["tabs"]:
        if tab["id"] == layout.get("active_tab"):
            return tab
    return layout["tabs"][0]


def layout_tiles(layout: dict) -> list[dict]:
    """Every tile across the envelope, tabs in order."""
    return [tile for tab in layout["tabs"] for tile in tab["layout"]["tiles"]]


async def prune_workspace_tiles(db: AsyncSession, user: User, layout: dict) -> dict:
    """Drop tiles whose session is unowned/gone, and duplicate session ids.

    A session lives in exactly one tab, so uniqueness is enforced across the
    whole envelope (first tab wins). Widget tiles carry no session, so only
    their id uniqueness is checked.
    """
    referenced = [
        tile.get("session_id")
        for tile in layout_tiles(layout)
        if isinstance(tile.get("session_id"), str) and tile.get("widget") is None
    ]
    owned: set[str] = set()
    if referenced:
        owned = set(
            (
                await db.execute(
                    select(Session.id).where(
                        Session.owner_user_id == user.id, Session.id.in_(set(referenced))
                    )
                )
            )
            .scalars()
            .all()
        )
    seen: set[str] = set()
    tabs: list[dict] = []
    for tab in layout["tabs"]:
        kept: list[dict] = []
        for tile in tab["layout"]["tiles"]:
            session_id = tile.get("session_id")
            if not isinstance(session_id, str) or session_id in seen:
                continue
            if tile.get("widget") is None and session_id not in owned:
                continue
            seen.add(session_id)
            kept.append(dict(tile))
        tabs.append({**tab, "layout": {"version": 2, "tiles": kept}})
    return {"version": 3, "active_tab": layout.get("active_tab"), "tabs": tabs}


async def _validated_layout(
    db: AsyncSession, user: User, layout: schemas.WorkspaceLayoutV3
) -> dict:
    pruned = await prune_workspace_tiles(db, user, layout.model_dump(mode="json"))
    tab_ids = [tab["id"] for tab in pruned["tabs"]]
    if len(set(tab_ids)) != len(tab_ids):
        raise HTTPException(status_code=400, detail="tab ids must be unique")
    if pruned.get("active_tab") is not None and pruned["active_tab"] not in tab_ids:
        raise HTTPException(status_code=400, detail="active_tab names no tab")
    for tab in pruned["tabs"]:
        if not grid.validate(tab["layout"]):
            raise HTTPException(
                status_code=400, detail="layout violates the grid invariants"
            )
    return pruned


def _to_out(workspace: Workspace) -> schemas.WorkspaceOut:
    return schemas.WorkspaceOut(
        id=workspace.id,
        name=workspace.name,
        host_id=workspace.host_id,
        cwd=workspace.cwd,
        layout=schemas.WorkspaceLayoutV3.model_validate(parse_workspace_layout(workspace.layout)),
        position=workspace.position,
        created_at=workspace.created_at,
        updated_at=workspace.updated_at,
    )


async def _get_owned_workspace(
    db: AsyncSession, workspace_id: str, user: User
) -> Workspace:
    workspace = await db.get(Workspace, workspace_id)
    if workspace is None or workspace.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="workspace not found")
    return workspace


async def _owned_workspaces(db: AsyncSession, user: User) -> list[Workspace]:
    return list(
        (
            await db.execute(
                select(Workspace)
                .where(Workspace.owner_user_id == user.id)
                .order_by(Workspace.position, Workspace.created_at, Workspace.id)
            )
        )
        .scalars()
        .all()
    )


def _next_free_name(existing_names: set[str]) -> str:
    used = {
        int(match.group(1))
        for name in existing_names
        if (match := _WORKSPACE_NAME_PATTERN.match(name)) is not None
    }
    n = 1
    while n in used:
        n += 1
    return f"Workspace {n}"


def name_from_cwd(cwd: str) -> str | None:
    """The folder a workspace was opened in, as its default name.

    "~/dev/singingcoach" names the workspace "singingcoach"; a bare home
    directory names it "Home". Paths with no folder to name it after (the
    filesystem root, an empty string) return None so the caller falls back to
    the numbered default.
    """
    trimmed = cwd.strip().replace("\\", "/").rstrip("/")
    if not trimmed:
        return None
    if trimmed == "~":
        return "Home"
    leaf = trimmed.rsplit("/", 1)[-1]
    return leaf or None


def _unique_name(base: str, existing_names: set[str]) -> str:
    """`base`, or the first "base N" suffix that is not taken."""
    if base not in existing_names:
        return base
    n = 2
    while f"{base} {n}" in existing_names:
        n += 1
    return f"{base} {n}"


@router.get("", response_model=list[schemas.WorkspaceOut])
async def list_workspaces(
    db: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> list[schemas.WorkspaceOut]:
    return [_to_out(row) for row in await _owned_workspaces(db, user)]


@router.post(
    "", response_model=schemas.WorkspaceCreateResponse, status_code=status.HTTP_201_CREATED
)
async def create_workspace(
    body: schemas.WorkspaceCreate,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.WorkspaceCreateResponse:
    existing = await _owned_workspaces(db, user)
    existing_names = {row.name for row in existing}
    name = body.name.strip() if body.name and body.name.strip() else None
    if name is None and body.first_session is not None:
        from_cwd = name_from_cwd(body.first_session.cwd)
        name = None if from_cwd is None else _unique_name(from_cwd, existing_names)
    if name is None:
        name = _next_free_name(existing_names)

    host: Host | None = None
    if body.first_session is not None:
        host = await db.get(Host, body.first_session.host_id)
        if host is None or host.owner_user_id != user.id:
            raise HTTPException(status_code=404, detail="host not found")

    workspace = Workspace(
        owner_user_id=user.id,
        name=name,
        host_id=host.id if host is not None else None,
        cwd=body.first_session.cwd if body.first_session is not None else None,
        layout=_single_tab_layout([]),
        position=len(existing),
    )
    db.add(workspace)
    await db.flush()

    session_row: Session | None = None
    if body.first_session is not None and host is not None:
        session_row = await create_session_row(
            db,
            user=user,
            host=host,
            cwd=body.first_session.cwd,
            name=None,
            skill_ids=body.first_session.skill_ids,
        )
        workspace.layout = _single_tab_layout(
            [{"session_id": session_row.id, **FIRST_SESSION_TILE}]
        )

    await db.commit()
    await db.refresh(workspace)

    session_out = None
    if session_row is not None and host is not None:
        await db.refresh(session_row)
        skills = await capabilities.get_session_launch_capabilities(
            db, user=user, session_id=session_row.id
        )
        await dispatch_session_launch(
            frame_type="session.create",
            session_row=session_row,
            host=host,
            create_cwd=True,
            skills=skills,
        )
        session_out = session_to_out(session_row, host.name)

    return schemas.WorkspaceCreateResponse(workspace=_to_out(workspace), session=session_out)


@router.get("/{workspace_id}", response_model=schemas.WorkspaceOut)
async def get_workspace(
    workspace_id: str,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.WorkspaceOut:
    return _to_out(await _get_owned_workspace(db, workspace_id, user))


@router.patch("/{workspace_id}", response_model=schemas.WorkspaceOut)
async def update_workspace(
    workspace_id: str,
    body: schemas.WorkspacePatch,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.WorkspaceOut:
    workspace = await _get_owned_workspace(db, workspace_id, user)
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="name is required")
        workspace.name = name
    if body.layout is not None:
        workspace.layout = await _validated_layout(db, user, body.layout)
    if body.host_id is not None:
        home_host = await db.get(Host, body.host_id)
        if home_host is None or home_host.owner_user_id != user.id:
            raise HTTPException(status_code=404, detail="host not found")
        workspace.host_id = home_host.id
    if body.cwd is not None:
        cwd = body.cwd.strip()
        if not cwd:
            raise HTTPException(status_code=400, detail="cwd is required")
        workspace.cwd = cwd
    if body.position is not None:
        # Reorder by removal + reinsertion so positions stay contiguous.
        rows = await _owned_workspaces(db, user)
        rows = [row for row in rows if row.id != workspace.id]
        target = min(body.position, len(rows))
        rows.insert(target, workspace)
        for index, row in enumerate(rows):
            row.position = index
    workspace.updated_at = _utcnow()
    await db.commit()
    await db.refresh(workspace)
    return _to_out(workspace)


@router.delete("/{workspace_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_workspace(
    workspace_id: str,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> None:
    workspace = await _get_owned_workspace(db, workspace_id, user)
    layout = parse_workspace_layout(workspace.layout)
    referenced = [
        tile["session_id"]
        for tile in layout_tiles(layout)
        if isinstance(tile.get("session_id"), str) and tile.get("widget") is None
    ]
    for session_id in referenced:
        session_row = await db.get(Session, session_id)
        if session_row is not None and session_row.owner_user_id == user.id:
            await kill_and_delete_session(db, session_row)
    await db.delete(workspace)
    await db.commit()
