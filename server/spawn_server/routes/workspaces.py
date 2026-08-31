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
    stop_session,
)

router = APIRouter(prefix="/api/workspaces", tags=["workspaces"])

FIRST_SESSION_TILE = {"x": 0, "y": 0, "w": grid.GRID_COLS, "h": grid.GRID_ROWS}
_WORKSPACE_NAME_PATTERN = re.compile(r"\AWorkspace (\d+)\Z")

# Layout schema v3 (proto/README.md, "Layout schema v3"): the stored/wire layout is an
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
                # No folder of its own: the tab inherits the workspace's home.
                "host_id": None,
                "cwd": None,
                "layout": {"version": grid.LAYOUT_VERSION, "tiles": tiles},
            }
        ],
    }


def _utcnow() -> datetime:
    return datetime.now(UTC)


def parse_workspace_layout(raw: object) -> dict:
    """The stored layout as a plain v3 envelope, in the current grid space.

    Envelope v2 rows (pre-tabs) upgrade into a single default tab; anything
    malformed reads as one empty tab so a workspace is never tabless. A grid
    still stamped with the old 12x12 schema is *lifted* — scaled, not merely
    relabelled — so a database that has yet to run migration 0037 still serves
    geometry the client can render.
    """
    if isinstance(raw, dict) and raw.get("version") == 3 and isinstance(raw.get("tabs"), list):
        tabs = [
            {
                "id": tab["id"],
                "name": tab["name"],
                # The tab's own default host/folder; anything but a string
                # reads as "inherit the workspace's home".
                "host_id": tab["host_id"] if isinstance(tab.get("host_id"), str) else None,
                "cwd": tab["cwd"] if isinstance(tab.get("cwd"), str) else None,
                "layout": grid.lift_layout(
                    {
                        "version": tab["layout"].get("version"),
                        "tiles": [dict(tile) for tile in tab["layout"]["tiles"]],
                    }
                ),
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
    # Envelope schema v2: a bare grid, from before tabs existed.
    if isinstance(raw, dict) and raw.get("version") == 2 and isinstance(raw.get("tiles"), list):
        lifted = grid.lift_layout({"version": 2, "tiles": [dict(t) for t in raw["tiles"]]})
        return _single_tab_layout(lifted["tiles"])
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
    their id uniqueness is checked. A tab whose own host/folder is incomplete —
    half a pair, or a host that is no longer the owner's — goes back to
    inheriting the workspace's home, the same way an unowned tile is dropped
    rather than failing the write.
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
    tab_hosts = {
        tab["host_id"] for tab in layout["tabs"] if isinstance(tab.get("host_id"), str)
    }
    owned_hosts: set[str] = set()
    if tab_hosts:
        owned_hosts = set(
            (
                await db.execute(
                    select(Host.id).where(Host.owner_user_id == user.id, Host.id.in_(tab_hosts))
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
        # A tab's folder is a pair: half of one says nothing about where a
        # window would open, so an unowned host takes its folder with it.
        host_id = tab.get("host_id")
        cwd = tab.get("cwd")
        homed = host_id in owned_hosts and isinstance(cwd, str)
        tabs.append(
            {
                **tab,
                "host_id": host_id if homed else None,
                "cwd": cwd if homed else None,
                "layout": {"version": grid.LAYOUT_VERSION, "tiles": kept},
            }
        )
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
        icon=workspace.icon,
        icon_source=workspace.icon_source,
        archived_at=workspace.archived_at,
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


async def _owned_workspaces(
    db: AsyncSession, user: User, *, archived: bool | None = False
) -> list[Workspace]:
    """Owned workspaces: active by default, archived on request, or every row.

    Active rows order by `position` (the sidebar's own order). Archived rows
    have left that space, so they order most-recently-archived first and their
    stale `position` is ignored. `archived=None` returns both, and exists for
    the one thing that must span the whole account: default-name uniqueness,
    so a new workspace never takes the name of one waiting in the archive.
    """
    query = select(Workspace).where(Workspace.owner_user_id == user.id)
    if archived is True:
        query = query.where(Workspace.archived_at.is_not(None)).order_by(
            Workspace.archived_at.desc(), Workspace.created_at.desc(), Workspace.id
        )
    else:
        if archived is False:
            query = query.where(Workspace.archived_at.is_(None))
        query = query.order_by(Workspace.position, Workspace.created_at, Workspace.id)
    return list((await db.execute(query)).scalars().all())


async def _reindex_active(db: AsyncSession, user: User) -> list[Workspace]:
    """Renumber the active workspaces 0..n-1 and return them in order.

    Positions are contiguous from 0 per owner, so anything that adds to or
    removes from the sidebar has to close the gap it made.
    """
    rows = await _owned_workspaces(db, user, archived=False)
    for index, row in enumerate(rows):
        row.position = index
    return rows


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
    archived: bool = False,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> list[schemas.WorkspaceOut]:
    """The sidebar's workspaces. Active by default — `?archived=true` returns
    the put-away ones instead, newest first. The two lists never mix, so a
    client that knows nothing about archiving simply stops seeing them."""
    return [_to_out(row) for row in await _owned_workspaces(db, user, archived=archived)]


@router.post(
    "", response_model=schemas.WorkspaceCreateResponse, status_code=status.HTTP_201_CREATED
)
async def create_workspace(
    body: schemas.WorkspaceCreate,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.WorkspaceCreateResponse:
    active = await _owned_workspaces(db, user, archived=False)
    # Names are checked against the archive too, so restoring one never
    # collides with a workspace created while it was away. Positions are not:
    # archived rows have left the sidebar's ordering entirely.
    existing_names = {row.name for row in await _owned_workspaces(db, user, archived=None)}

    # The home is either the first session's, or given directly for a
    # workspace created empty; both name the workspace after its folder.
    host: Host | None = None
    home_host_id = body.first_session.host_id if body.first_session is not None else body.host_id
    home_cwd = body.first_session.cwd if body.first_session is not None else body.cwd
    if home_host_id is not None:
        host = await db.get(Host, home_host_id)
        if host is None or host.owner_user_id != user.id:
            raise HTTPException(status_code=404, detail="host not found")

    name = body.name.strip() if body.name and body.name.strip() else None
    if name is None and home_cwd is not None:
        from_cwd = name_from_cwd(home_cwd)
        name = None if from_cwd is None else _unique_name(from_cwd, existing_names)
    if name is None:
        name = _next_free_name(existing_names)

    workspace = Workspace(
        owner_user_id=user.id,
        name=name,
        host_id=host.id if host is not None else None,
        cwd=home_cwd,
        layout=_single_tab_layout([]),
        position=len(active),
        # Given only by the template flow, which hands down the mark the
        # template was saved with. Left unset, the pair stays null and the
        # browser scans the folder the first time the workspace opens.
        icon=body.icon,
        icon_source=body.icon_source,
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
    # `icon: null` clears the mark; an absent `icon` leaves it. Only
    # `model_fields_set` tells those apart, and the two fields move
    # independently: a scan that finds nothing writes the source alone.
    if "icon" in body.model_fields_set:
        workspace.icon = body.icon
    if "icon_source" in body.model_fields_set:
        workspace.icon_source = body.icon_source
    if body.position is not None:
        # Reorder by removal + reinsertion so positions stay contiguous.
        rows = await _owned_workspaces(db, user, archived=False)
        rows = [row for row in rows if row.id != workspace.id]
        target = min(body.position, len(rows))
        rows.insert(target, workspace)
        for index, row in enumerate(rows):
            row.position = index
    workspace.updated_at = _utcnow()
    await db.commit()
    await db.refresh(workspace)
    return _to_out(workspace)


@router.post("/{workspace_id}/archive", response_model=schemas.WorkspaceOut)
async def archive_workspace(
    workspace_id: str,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.WorkspaceOut:
    """Put a workspace away: stop everything in it, change nothing else.

    Archiving is suspend, not teardown. Every session is stopped — process
    tree, PTY and the worker holding them go, so an archived workspace costs
    the host nothing — but the rows survive, which means the layout keeps
    pointing at the same windows in the same places and there is no snapshot
    to take: the workspace *is* its own snapshot. `position` is left where it
    was so a restore can slot the row back in; the active rows renumber
    around it.
    """
    workspace = await _get_owned_workspace(db, workspace_id, user)
    if workspace.archived_at is not None:
        raise HTTPException(status_code=409, detail="workspace_archived")

    layout = parse_workspace_layout(workspace.layout)
    for tile in layout_tiles(layout):
        if not isinstance(tile.get("session_id"), str) or tile.get("widget") is not None:
            continue
        session_row = await db.get(Session, tile["session_id"])
        if session_row is not None and session_row.owner_user_id == user.id:
            await stop_session(db, session_row)

    workspace.archived_at = _utcnow()
    workspace.updated_at = workspace.archived_at
    await db.flush()
    await _reindex_active(db, user)
    await db.commit()
    await db.refresh(workspace)
    return _to_out(workspace)


@router.post("/{workspace_id}/unarchive", response_model=schemas.WorkspaceOut)
async def unarchive_workspace(
    workspace_id: str,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.WorkspaceOut:
    """Bring it back: the same windows, restarted where they stopped.

    Nothing is rebuilt, because nothing was taken apart — each session starts
    again under its own id, in its own folder, on its own host. A session
    whose host is offline stays stopped and can be started from its own window
    later; a restore is never refused over one unreachable host. The workspace
    returns to the sidebar slot it left from.
    """
    workspace = await _get_owned_workspace(db, workspace_id, user)
    if workspace.archived_at is None:
        raise HTTPException(status_code=409, detail="workspace_not_archived")

    slot = workspace.position
    workspace.archived_at = None
    workspace.updated_at = _utcnow()

    # Reinsertion, not an append: `position` has been holding this row's old
    # place in the sidebar for as long as it was away.
    rows = [
        row for row in await _owned_workspaces(db, user, archived=False) if row.id != workspace.id
    ]
    rows.insert(min(max(slot, 0), len(rows)), workspace)
    for index, row in enumerate(rows):
        row.position = index

    launches: list[tuple[Session, Host]] = []
    for tile in layout_tiles(parse_workspace_layout(workspace.layout)):
        if not isinstance(tile.get("session_id"), str) or tile.get("widget") is not None:
            continue
        session_row = await db.get(Session, tile["session_id"])
        if session_row is None or session_row.owner_user_id != user.id:
            continue
        host = await db.get(Host, session_row.host_id)
        if host is None or host.owner_user_id != user.id or host.status != "online":
            continue
        session_row.status = "starting"
        session_row.started_at = _utcnow()
        session_row.exited_at = None
        session_row.exit_code = None
        session_row.last_output_at = None
        session_row.last_input_at = None
        session_row.foreground_command = None
        launches.append((session_row, host))

    await db.commit()
    await db.refresh(workspace)

    # Dispatched after the commit, exactly as workspace creation does: the
    # rows are in their restarting state before any daemon can call back.
    for session_row, host in launches:
        await db.refresh(session_row)
        skills = await capabilities.get_session_launch_capabilities(
            db, user=user, session_id=session_row.id
        )
        await dispatch_session_launch(
            frame_type="session.restart",
            session_row=session_row,
            host=host,
            create_cwd=True,
            skills=skills,
        )
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
