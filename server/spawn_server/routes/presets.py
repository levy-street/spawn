"""`/api/presets` — list built-ins + user, create/update/delete user presets."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, schemas
from ..db import get_session
from ..models import Preset, User

router = APIRouter(prefix="/api/presets", tags=["presets"])


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


async def _commit_preset(session: AsyncSession) -> None:
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(status_code=409, detail="preset name already exists") from exc


@router.get("", response_model=list[schemas.PresetOut])
async def list_presets(
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> list[schemas.PresetOut]:
    rows = (
        (
            await session.execute(
                select(Preset).where(
                    or_(Preset.owner_user_id.is_(None), Preset.owner_user_id == user.id)
                )
            )
        )
        .scalars()
        .all()
    )
    return [schemas.PresetOut.model_validate(r) for r in rows]


@router.post("", response_model=schemas.PresetOut, status_code=status.HTTP_201_CREATED)
async def create_preset(
    body: schemas.PresetCreate,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.PresetOut:
    p = Preset(
        owner_user_id=user.id,
        name=_clean_required(body.name, "preset name"),
        agent_kind=_clean_required(body.agent_kind, "agent kind"),
        default_argv=list(body.default_argv),
        env_template=dict(body.env_template),
        install=_clean_optional(body.install),
    )
    session.add(p)
    await _commit_preset(session)
    await session.refresh(p)
    return schemas.PresetOut.model_validate(p)


@router.patch("/{preset_id}", response_model=schemas.PresetOut)
async def update_preset(
    preset_id: str,
    body: schemas.PresetPatch,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.PresetOut:
    p = await session.get(Preset, preset_id)
    if p is None or p.owner_user_id != user.id:
        # Built-ins (owner_user_id=None) cannot be edited by any user.
        raise HTTPException(status_code=404, detail="preset not found")

    fields = body.model_fields_set
    if "name" in fields:
        if body.name is None:
            raise HTTPException(status_code=400, detail="preset name is required")
        p.name = _clean_required(body.name, "preset name")
    if "agent_kind" in fields:
        if body.agent_kind is None:
            raise HTTPException(status_code=400, detail="agent kind is required")
        p.agent_kind = _clean_required(body.agent_kind, "agent kind")
    if "default_argv" in fields:
        p.default_argv = list(body.default_argv or [])
    if "env_template" in fields:
        p.env_template = dict(body.env_template or {})
    if "install" in fields:
        p.install = _clean_optional(body.install)

    await _commit_preset(session)
    await session.refresh(p)
    return schemas.PresetOut.model_validate(p)


@router.delete("/{preset_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_preset(
    preset_id: str,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> None:
    p = await session.get(Preset, preset_id)
    if p is None or p.owner_user_id != user.id:
        # Built-ins (owner_user_id=None) cannot be deleted by any user.
        raise HTTPException(status_code=404, detail="preset not found")
    await session.delete(p)
    await session.commit()
