"""`/api/agents` — launchable CLI tool definitions (built-ins + user's own)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, schemas
from ..db import get_session
from ..models import Agent, AgentPreference, User

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


async def _yolo_by_agent(session: AsyncSession, user: User) -> dict[str, bool]:
    """This user's yolo choices, keyed by agent id. Absent rows read as off."""
    rows = (
        (
            await session.execute(
                select(AgentPreference).where(AgentPreference.owner_user_id == user.id)
            )
        )
        .scalars()
        .all()
    )
    return {row.agent_id: row.yolo for row in rows}


def _out(agent: Agent, yolo: bool) -> schemas.AgentOut:
    """`AgentOut` is the definition plus the reading user's preferences, and
    the preferences live in another table — so it is never validated straight
    off the ORM row."""
    out = schemas.AgentOut.model_validate(agent)
    out.yolo = yolo
    return out


async def _visible_agent(session: AsyncSession, user: User, agent_id: str) -> Agent:
    """Any agent the user can see: their own, or a built-in."""
    agent = await session.get(Agent, agent_id)
    if agent is None or (agent.owner_user_id is not None and agent.owner_user_id != user.id):
        raise HTTPException(status_code=404, detail="agent not found")
    return agent


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
    yolo = await _yolo_by_agent(session, user)
    return [_out(row, yolo.get(row.id, False)) for row in rows]


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
        yolo_args=_clean_optional(body.yolo_args),
        yolo_env=dict(body.yolo_env),
    )
    session.add(agent)
    await _commit_agent(session)
    await session.refresh(agent)
    return _out(agent, False)


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
    if "yolo_args" in fields:
        agent.yolo_args = _clean_optional(body.yolo_args)
    if "yolo_env" in fields:
        agent.yolo_env = dict(body.yolo_env or {})

    await _commit_agent(session)
    await session.refresh(agent)
    yolo = await _yolo_by_agent(session, user)
    return _out(agent, yolo.get(agent.id, False))


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


@router.patch("/{agent_id}/preferences", response_model=schemas.AgentOut)
async def update_agent_preferences(
    agent_id: str,
    body: schemas.AgentPreferencePatch,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.AgentOut:
    """Set the caller's own settings for an agent.

    Unlike PATCH on the definition this accepts built-ins: the row written is
    the caller's, not the shared definition, so a preference on `claude-code`
    is not a write to everyone's `claude-code`.
    """
    agent = await _visible_agent(session, user, agent_id)

    preference = (
        await session.execute(
            select(AgentPreference).where(
                AgentPreference.owner_user_id == user.id,
                AgentPreference.agent_id == agent.id,
            )
        )
    ).scalar_one_or_none()
    if preference is None:
        preference = AgentPreference(owner_user_id=user.id, agent_id=agent.id)
        session.add(preference)

    if "yolo" in body.model_fields_set:
        if body.yolo is None:
            raise HTTPException(status_code=400, detail="yolo must be true or false")
        # Nothing to turn on when the definition has no way to say it.
        if body.yolo and not (agent.yolo_args or agent.yolo_env):
            raise HTTPException(status_code=400, detail="agent has no yolo mode")
        preference.yolo = body.yolo

    await session.commit()
    await session.refresh(preference)
    return _out(agent, preference.yolo)
