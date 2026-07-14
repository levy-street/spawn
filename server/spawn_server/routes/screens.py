"""Saved screens: named multi-terminal split-tree arrangements of agents."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, schemas
from ..db import get_session
from ..models import Agent, Screen, User

router = APIRouter(prefix="/api/screens", tags=["screens"])

MAX_PANES_PER_SCREEN = 8
MAX_SPLIT_DEPTH = 12


def _to_out(screen: Screen) -> schemas.ScreenOut:
    return schemas.ScreenOut(
        id=screen.id,
        name=screen.name,
        layout=schemas.ScreenLayout.model_validate(screen.layout or {}),
        ephemeral=bool(screen.ephemeral),
        created_at=screen.created_at,
        updated_at=screen.updated_at,
    )


def _pane_count(layout: schemas.ScreenLayout) -> int:
    ids: list[str] = []
    _collect_agent_ids(layout.root, ids)
    return len(ids)


async def _get_owned_screen(session: AsyncSession, screen_id: str, user: User) -> Screen:
    screen = await session.get(Screen, screen_id)
    if screen is None or screen.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="screen not found")
    return screen


def _collect_agent_ids(node: schemas.LayoutNode | None, out: list[str]) -> None:
    if node is None:
        return
    if isinstance(node, schemas.LayoutPane):
        out.append(node.agent_id)
        return
    _collect_agent_ids(node.a, out)
    _collect_agent_ids(node.b, out)


def _depth(node: schemas.LayoutNode | None) -> int:
    if node is None or isinstance(node, schemas.LayoutPane):
        return 0
    return 1 + max(_depth(node.a), _depth(node.b))


def _prune(
    node: schemas.LayoutNode | None, keep: set[str], seen: set[str]
) -> schemas.LayoutNode | None:
    """Drop panes not in `keep` (foreign/duplicate agents); a split with one
    surviving child collapses to that child so the tree stays well-formed."""
    if node is None:
        return None
    if isinstance(node, schemas.LayoutPane):
        if node.agent_id not in keep or node.agent_id in seen:
            return None
        seen.add(node.agent_id)
        return node
    a = _prune(node.a, keep, seen)
    b = _prune(node.b, keep, seen)
    if a is None:
        return b
    if b is None:
        return a
    return schemas.LayoutSplit(type="split", direction=node.direction, ratio=node.ratio, a=a, b=b)


async def _sanitize_layout(
    session: AsyncSession, user: User, layout: schemas.ScreenLayout
) -> dict:
    if _depth(layout.root) > MAX_SPLIT_DEPTH:
        raise HTTPException(status_code=400, detail="layout is nested too deeply")
    referenced: list[str] = []
    _collect_agent_ids(layout.root, referenced)
    if len(referenced) > MAX_PANES_PER_SCREEN:
        raise HTTPException(
            status_code=400, detail=f"a screen holds at most {MAX_PANES_PER_SCREEN} panes"
        )

    owned: set[str] = set()
    if referenced:
        owned = set(
            (
                await session.execute(
                    select(Agent.id).where(
                        Agent.owner_user_id == user.id, Agent.id.in_(set(referenced))
                    )
                )
            )
            .scalars()
            .all()
        )
    return schemas.ScreenLayout(root=_prune(layout.root, owned, set())).model_dump(mode="json")


@router.get("", response_model=list[schemas.ScreenOut])
async def list_screens(
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> list[schemas.ScreenOut]:
    rows = (
        (
            await session.execute(
                select(Screen).where(Screen.owner_user_id == user.id).order_by(Screen.name)
            )
        )
        .scalars()
        .all()
    )
    return [_to_out(row) for row in rows]


@router.post("", response_model=schemas.ScreenOut, status_code=status.HTTP_201_CREATED)
async def create_screen(
    body: schemas.ScreenCreate,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.ScreenOut:
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    screen = Screen(
        owner_user_id=user.id,
        name=name,
        layout=await _sanitize_layout(session, user, body.layout),
        ephemeral=body.ephemeral,
    )
    session.add(screen)
    await session.commit()
    await session.refresh(screen)
    return _to_out(screen)


@router.get("/{screen_id}", response_model=schemas.ScreenOut)
async def get_screen(
    screen_id: str,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.ScreenOut:
    return _to_out(await _get_owned_screen(session, screen_id, user))


@router.patch("/{screen_id}", response_model=schemas.ScreenOut)
async def update_screen(
    screen_id: str,
    body: schemas.ScreenPatch,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.ScreenOut:
    screen = await _get_owned_screen(session, screen_id, user)
    if body.ephemeral is not None:
        screen.ephemeral = body.ephemeral
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="name is required")
        # Naming an ad-hoc screen is a commitment to keep it.
        if name != screen.name:
            screen.ephemeral = False
        screen.name = name
    if body.layout is not None:
        sanitized = await _sanitize_layout(session, user, body.layout)
        panes = _pane_count(schemas.ScreenLayout.model_validate(sanitized))
        # An ad-hoc screen emptied of panes has served its purpose — drop it
        # so the tab strip doesn't accumulate husks. Growing it past the
        # original pair is a deliberate arrangement worth persisting.
        if screen.ephemeral and panes == 0:
            await session.delete(screen)
            await session.commit()
            raise HTTPException(status_code=410, detail="ephemeral screen emptied")
        if screen.ephemeral and panes >= 3:
            screen.ephemeral = False
        screen.layout = sanitized
    await session.commit()
    await session.refresh(screen)
    return _to_out(screen)


@router.delete("/{screen_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_screen(
    screen_id: str,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> None:
    screen = await _get_owned_screen(session, screen_id, user)
    await session.delete(screen)
    await session.commit()
