"""Saved multi-terminal views: named tab/pane arrangements of agents."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, schemas
from ..db import get_session
from ..models import Agent, User, View

router = APIRouter(prefix="/api/views", tags=["views"])


def _to_out(view: View) -> schemas.ViewOut:
    return schemas.ViewOut(
        id=view.id,
        name=view.name,
        layout=schemas.ViewLayout.model_validate(view.layout or {}),
        created_at=view.created_at,
        updated_at=view.updated_at,
    )


async def _get_owned_view(session: AsyncSession, view_id: str, user: User) -> View:
    view = await session.get(View, view_id)
    if view is None or view.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="view not found")
    return view


async def _sanitize_layout(
    session: AsyncSession, user: User, layout: schemas.ViewLayout
) -> dict:
    """Drop agent ids the user does not own so a stored view can never
    reference (and later attach to) someone else's agent."""
    referenced = {agent_id for tab in layout.tabs for agent_id in tab.agent_ids}
    owned: set[str] = set()
    if referenced:
        owned = set(
            (
                await session.execute(
                    select(Agent.id).where(
                        Agent.owner_user_id == user.id, Agent.id.in_(referenced)
                    )
                )
            )
            .scalars()
            .all()
        )
    return schemas.ViewLayout(
        tabs=[
            schemas.ViewTab(
                name=tab.name,
                agent_ids=[agent_id for agent_id in tab.agent_ids if agent_id in owned],
            )
            for tab in layout.tabs
        ]
    ).model_dump(mode="json")


@router.get("", response_model=list[schemas.ViewOut])
async def list_views(
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> list[schemas.ViewOut]:
    rows = (
        (
            await session.execute(
                select(View).where(View.owner_user_id == user.id).order_by(View.name)
            )
        )
        .scalars()
        .all()
    )
    return [_to_out(row) for row in rows]


@router.post("", response_model=schemas.ViewOut, status_code=status.HTTP_201_CREATED)
async def create_view(
    body: schemas.ViewCreate,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.ViewOut:
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    view = View(
        owner_user_id=user.id,
        name=name,
        layout=await _sanitize_layout(session, user, body.layout),
    )
    session.add(view)
    await session.commit()
    await session.refresh(view)
    return _to_out(view)


@router.get("/{view_id}", response_model=schemas.ViewOut)
async def get_view(
    view_id: str,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.ViewOut:
    return _to_out(await _get_owned_view(session, view_id, user))


@router.patch("/{view_id}", response_model=schemas.ViewOut)
async def update_view(
    view_id: str,
    body: schemas.ViewPatch,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.ViewOut:
    view = await _get_owned_view(session, view_id, user)
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="name is required")
        view.name = name
    if body.layout is not None:
        view.layout = await _sanitize_layout(session, user, body.layout)
    await session.commit()
    await session.refresh(view)
    return _to_out(view)


@router.delete("/{view_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_view(
    view_id: str,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> None:
    view = await _get_owned_view(session, view_id, user)
    await session.delete(view)
    await session.commit()
