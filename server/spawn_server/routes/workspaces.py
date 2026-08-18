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


def _utcnow() -> datetime:
    return datetime.now(UTC)


def parse_workspace_layout(raw: object) -> dict:
    """The stored layout as a plain v2 dict; malformed/legacy rows read empty."""
    if isinstance(raw, dict) and raw.get("version") == 2 and isinstance(
        raw.get("tiles"), list
    ):
        return {"version": 2, "tiles": [dict(tile) for tile in raw["tiles"]]}
    return {"version": 2, "tiles": []}


async def prune_workspace_tiles(db: AsyncSession, user: User, layout: dict) -> dict:
    """Drop tiles whose session is unowned/gone, and duplicate session ids."""
    tiles = layout["tiles"]
    referenced = [
        tile.get("session_id") for tile in tiles if isinstance(tile.get("session_id"), str)
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
    kept: list[dict] = []
    for tile in tiles:
        session_id = tile.get("session_id")
        if session_id not in owned or session_id in seen:
            continue
        seen.add(session_id)
        kept.append(dict(tile))
    return {"version": 2, "tiles": kept}


async def _validated_layout(
    db: AsyncSession, user: User, layout: schemas.WorkspaceLayout
) -> dict:
    pruned = await prune_workspace_tiles(db, user, layout.model_dump(mode="json"))
    if not grid.validate(pruned):
        raise HTTPException(status_code=400, detail="layout violates the grid invariants")
    return pruned


def _to_out(workspace: Workspace) -> schemas.WorkspaceOut:
    return schemas.WorkspaceOut(
        id=workspace.id,
        name=workspace.name,
        layout=schemas.WorkspaceLayout.model_validate(parse_workspace_layout(workspace.layout)),
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
    name = body.name.strip() if body.name and body.name.strip() else None
    if name is None:
        name = _next_free_name({row.name for row in existing})

    host: Host | None = None
    if body.first_session is not None:
        host = await db.get(Host, body.first_session.host_id)
        if host is None or host.owner_user_id != user.id:
            raise HTTPException(status_code=404, detail="host not found")

    workspace = Workspace(
        owner_user_id=user.id,
        name=name,
        layout={"version": 2, "tiles": []},
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
        workspace.layout = {
            "version": 2,
            "tiles": [{"session_id": session_row.id, **FIRST_SESSION_TILE}],
        }

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
        tile["session_id"] for tile in layout["tiles"] if isinstance(tile.get("session_id"), str)
    ]
    for session_id in referenced:
        session_row = await db.get(Session, session_id)
        if session_row is not None and session_row.owner_user_id == user.id:
            await kill_and_delete_session(db, session_row)
    await db.delete(workspace)
    await db.commit()
