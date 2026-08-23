"""Managed skills and per-session skill access."""

from __future__ import annotations

from collections.abc import Sequence

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, schemas
from ..db import get_session
from ..models import Session, SessionSkillGrant, Skill, User

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


async def _get_owned_session(db: AsyncSession, session_id: str, user: User) -> Session:
    session_row = await db.get(Session, session_id)
    if session_row is None or session_row.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="session not found")
    return session_row


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


async def set_session_access(
    db: AsyncSession,
    *,
    user: User,
    session_row: Session,
    skill_ids: Sequence[str],
) -> None:
    await _owned_skills_by_ids(db, user, skill_ids)

    await db.execute(
        delete(SessionSkillGrant).where(SessionSkillGrant.session_id == session_row.id)
    )
    for skill_id in dict.fromkeys(skill_ids):
        db.add(
            SessionSkillGrant(
                owner_user_id=user.id,
                session_id=session_row.id,
                skill_id=skill_id,
            )
        )


async def get_session_access_payload(
    db: AsyncSession, *, user: User, session_id: str
) -> schemas.SessionAccessOut:
    session_row = await _get_owned_session(db, session_id, user)
    skills = (
        await db.execute(
            select(Skill)
            .join(SessionSkillGrant, SessionSkillGrant.skill_id == Skill.id)
            .where(
                SessionSkillGrant.session_id == session_row.id,
                SessionSkillGrant.owner_user_id == user.id,
            )
            .order_by(Skill.name)
        )
    ).scalars().all()
    return schemas.SessionAccessOut(
        session_id=session_row.id,
        skills=[schemas.SkillOut.model_validate(row) for row in skills],
    )


async def get_session_launch_capabilities(
    db: AsyncSession, *, user: User, session_id: str
) -> list[dict]:
    access = await get_session_access_payload(db, user=user, session_id=session_id)
    return [
        schemas.SkillLaunchConfig(
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


@router.get("/sessions/{session_id}/access", response_model=schemas.SessionAccessOut)
async def get_session_access(
    session_id: str,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.SessionAccessOut:
    return await get_session_access_payload(session, user=user, session_id=session_id)


@router.patch("/sessions/{session_id}/access", response_model=schemas.SessionAccessOut)
async def update_session_access(
    session_id: str,
    body: schemas.SessionAccessPatch,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.SessionAccessOut:
    session_row = await _get_owned_session(session, session_id, user)
    current = await get_session_access_payload(session, user=user, session_id=session_row.id)
    skill_ids = body.skill_ids
    if skill_ids is None:
        skill_ids = [skill.id for skill in current.skills]
    await set_session_access(
        session,
        user=user,
        session_row=session_row,
        skill_ids=skill_ids,
    )
    await session.commit()
    return await get_session_access_payload(session, user=user, session_id=session_row.id)
