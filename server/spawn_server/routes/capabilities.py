"""Managed skill access for agents."""

from __future__ import annotations

from collections.abc import Sequence

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, schemas
from ..db import get_session
from ..models import Agent, AgentSkillGrant, Skill, User

router = APIRouter(prefix="/api", tags=["capabilities"])


def _normalize_name(name: str) -> str:
    value = name.strip()
    if not value:
        raise HTTPException(status_code=400, detail="name is required")
    return value


async def _get_owned_skill(session: AsyncSession, skill_id: str, user: User) -> Skill:
    skill = await session.get(Skill, skill_id)
    if skill is None or skill.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="skill not found")
    return skill


async def _get_owned_agent(session: AsyncSession, agent_id: str, user: User) -> Agent:
    agent = await session.get(Agent, agent_id)
    if agent is None or agent.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="agent not found")
    return agent


async def _owned_skills_by_ids(session: AsyncSession, user: User, ids: Sequence[str]) -> list[Skill]:
    if not ids:
        return []
    rows = (
        await session.execute(select(Skill).where(Skill.owner_user_id == user.id, Skill.id.in_(ids)))
    ).scalars().all()
    by_id = {row.id: row for row in rows}
    missing = [skill_id for skill_id in ids if skill_id not in by_id]
    if missing:
        raise HTTPException(status_code=404, detail=f"skill not found: {missing[0]}")
    return [by_id[skill_id] for skill_id in ids]


async def default_skill_ids(session: AsyncSession, user: User) -> list[str]:
    rows = (
        await session.execute(
            select(Skill.id)
            .where(Skill.owner_user_id == user.id, Skill.enabled_by_default.is_(True))
            .order_by(Skill.name)
        )
    ).scalars().all()
    return list(rows)


async def set_agent_access(
    session: AsyncSession,
    *,
    user: User,
    agent: Agent,
    skill_ids: Sequence[str],
) -> None:
    await _owned_skills_by_ids(session, user, skill_ids)

    await session.execute(delete(AgentSkillGrant).where(AgentSkillGrant.agent_id == agent.id))
    for skill_id in dict.fromkeys(skill_ids):
        session.add(
            AgentSkillGrant(
                owner_user_id=user.id,
                agent_id=agent.id,
                skill_id=skill_id,
            )
        )


async def get_agent_access_payload(
    session: AsyncSession, *, user: User, agent_id: str
) -> schemas.AgentAccessOut:
    agent = await _get_owned_agent(session, agent_id, user)
    skills = (
        await session.execute(
            select(Skill)
            .join(AgentSkillGrant, AgentSkillGrant.skill_id == Skill.id)
            .where(AgentSkillGrant.agent_id == agent.id, AgentSkillGrant.owner_user_id == user.id)
            .order_by(Skill.name)
        )
    ).scalars().all()
    return schemas.AgentAccessOut(
        agent_id=agent.id,
        skills=[schemas.SkillOut.model_validate(row) for row in skills],
    )


async def get_agent_launch_capabilities(
    session: AsyncSession, *, user: User, agent_id: str
) -> list[dict]:
    access = await get_agent_access_payload(session, user=user, agent_id=agent_id)
    return [
        schemas.AgentSkillConfig(
            id=skill.id,
            name=skill.name,
            description=skill.description,
            content=skill.content,
        ).model_dump(mode="json")
        for skill in access.skills
    ]


@router.get("/skills", response_model=list[schemas.SkillOut])
async def list_skills(
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> list[schemas.SkillOut]:
    rows = (
        await session.execute(select(Skill).where(Skill.owner_user_id == user.id).order_by(Skill.name))
    ).scalars().all()
    return [schemas.SkillOut.model_validate(row) for row in rows]


@router.post("/skills", response_model=schemas.SkillOut, status_code=status.HTTP_201_CREATED)
async def create_skill(
    body: schemas.SkillCreate,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.SkillOut:
    skill = Skill(
        owner_user_id=user.id,
        name=_normalize_name(body.name),
        description=body.description.strip(),
        content=body.content,
        enabled_by_default=body.enabled_by_default,
    )
    session.add(skill)
    try:
        await session.commit()
    except IntegrityError as e:
        await session.rollback()
        raise HTTPException(status_code=409, detail="skill name already exists") from e
    await session.refresh(skill)
    return schemas.SkillOut.model_validate(skill)


@router.patch("/skills/{skill_id}", response_model=schemas.SkillOut)
async def update_skill(
    skill_id: str,
    body: schemas.SkillPatch,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.SkillOut:
    skill = await _get_owned_skill(session, skill_id, user)
    if body.name is not None:
        skill.name = _normalize_name(body.name)
    if body.description is not None:
        skill.description = body.description.strip()
    if body.content is not None:
        skill.content = body.content
    if body.enabled_by_default is not None:
        skill.enabled_by_default = body.enabled_by_default
    try:
        await session.commit()
    except IntegrityError as e:
        await session.rollback()
        raise HTTPException(status_code=409, detail="skill name already exists") from e
    await session.refresh(skill)
    return schemas.SkillOut.model_validate(skill)


@router.delete("/skills/{skill_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_skill(
    skill_id: str,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> None:
    skill = await _get_owned_skill(session, skill_id, user)
    await session.delete(skill)
    await session.commit()


@router.get("/agents/{agent_id}/access", response_model=schemas.AgentAccessOut)
async def get_agent_access(
    agent_id: str,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.AgentAccessOut:
    return await get_agent_access_payload(session, user=user, agent_id=agent_id)


@router.patch("/agents/{agent_id}/access", response_model=schemas.AgentAccessOut)
async def update_agent_access(
    agent_id: str,
    body: schemas.AgentAccessPatch,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.AgentAccessOut:
    agent = await _get_owned_agent(session, agent_id, user)
    current = await get_agent_access_payload(session, user=user, agent_id=agent.id)
    skill_ids = body.skill_ids
    if skill_ids is None:
        skill_ids = [skill.id for skill in current.skills]
    await set_agent_access(
        session,
        user=user,
        agent=agent,
        skill_ids=skill_ids,
    )
    await session.commit()
    return await get_agent_access_payload(session, user=user, agent_id=agent.id)
