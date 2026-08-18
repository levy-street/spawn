"""`/api/agents` — launchable CLI tool definitions (built-ins + user's own)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, schemas
from ..db import get_session
from ..models import Agent, User

router = APIRouter(prefix="/api/agents", tags=["agents"])


def _clean_required(value: str, field: str) -> str:
    clean = value.strip()
    if not clean:
        raise HTTPException(status_code=400, detail=f"{field} is required")
    return clean


def _clean_optional(value: str | None) -> str | None:
    if value is None:
        return None
    clean = value.strip()
    return clean or None


async def _commit_agent(session: AsyncSession) -> None:
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(status_code=409, detail="agent name already exists") from exc


@router.get("", response_model=list[schemas.AgentOut])
async def list_agents(
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> list[schemas.AgentOut]:
    rows = (
        (
            await session.execute(
                select(Agent).where(
                    or_(Agent.owner_user_id.is_(None), Agent.owner_user_id == user.id)
                )
            )
        )
        .scalars()
        .all()
    )
    return [schemas.AgentOut.model_validate(row) for row in rows]


@router.post("", response_model=schemas.AgentOut, status_code=status.HTTP_201_CREATED)
async def create_agent(
    body: schemas.AgentCreate,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.AgentOut:
    agent = Agent(
        owner_user_id=user.id,
        name=_clean_required(body.name, "agent name"),
        kind=_clean_required(body.kind, "agent kind"),
        command=_clean_required(body.command, "command"),
        env=dict(body.env),
        install=_clean_optional(body.install),
    )
    session.add(agent)
    await _commit_agent(session)
    await session.refresh(agent)
    return schemas.AgentOut.model_validate(agent)


@router.patch("/{agent_id}", response_model=schemas.AgentOut)
async def update_agent(
    agent_id: str,
    body: schemas.AgentPatch,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.AgentOut:
    agent = await session.get(Agent, agent_id)
    if agent is None or agent.owner_user_id != user.id:
        # Built-ins (owner_user_id=None) cannot be edited by any user.
        raise HTTPException(status_code=404, detail="agent not found")

    fields = body.model_fields_set
    if "name" in fields:
        if body.name is None:
            raise HTTPException(status_code=400, detail="agent name is required")
        agent.name = _clean_required(body.name, "agent name")
    if "kind" in fields:
        if body.kind is None:
            raise HTTPException(status_code=400, detail="agent kind is required")
        agent.kind = _clean_required(body.kind, "agent kind")
    if "command" in fields:
        if body.command is None:
            raise HTTPException(status_code=400, detail="command is required")
        agent.command = _clean_required(body.command, "command")
    if "env" in fields:
        agent.env = dict(body.env or {})
    if "install" in fields:
        agent.install = _clean_optional(body.install)

    await _commit_agent(session)
    await session.refresh(agent)
    return schemas.AgentOut.model_validate(agent)


@router.delete("/{agent_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_agent(
    agent_id: str,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> None:
    agent = await session.get(Agent, agent_id)
    if agent is None or agent.owner_user_id != user.id:
        # Built-ins (owner_user_id=None) cannot be deleted by any user.
        raise HTTPException(status_code=404, detail="agent not found")
    await session.delete(agent)
    await session.commit()
