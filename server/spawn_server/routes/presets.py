"""`/api/presets` — list built-ins + user, create user-defined, delete."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, schemas
from ..db import get_session
from ..models import Preset, User

router = APIRouter(prefix="/api/presets", tags=["presets"])


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
        name=body.name,
        agent_kind=body.agent_kind,
        default_argv=list(body.default_argv),
        env_template=dict(body.env_template),
        install=body.install,
    )
    session.add(p)
    await session.commit()
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
