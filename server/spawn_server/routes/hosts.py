"""`/api/hosts` — list, get, rename, delete."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, schemas
from ..db import get_session
from ..models import Agent, Host, Preset, User
from ..ws.broker import get_broker

router = APIRouter(prefix="/api/hosts", tags=["hosts"])


def _to_out(host: Host, agent_count: int) -> schemas.HostOut:
    daemon = get_broker().get_daemon_for_host(host.id)
    return schemas.HostOut(
        id=host.id,
        name=host.name,
        os=host.os,
        arch=host.arch,
        version=host.version,
        status=host.status,
        last_seen_at=host.last_seen_at,
        agent_count=agent_count,
        home_dir=daemon.home_dir if daemon is not None else None,
    )


def _preset_to_tool_target(preset: Preset) -> schemas.HostToolTarget:
    command = str((preset.default_argv or [""])[0]).strip()
    return schemas.HostToolTarget(
        preset_id=preset.id,
        preset_name=preset.name,
        agent_kind=preset.agent_kind,
        command=command,
        install=preset.install,
    )


async def _get_owned_host(session: AsyncSession, host_id: str, user: User) -> Host:
    host = await session.get(Host, host_id)
    if host is None or host.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="host not found")
    return host


async def _list_accessible_presets(session: AsyncSession, user: User) -> list[Preset]:
    return (
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


async def _get_accessible_preset(session: AsyncSession, preset_id: str, user: User) -> Preset:
    preset = await session.get(Preset, preset_id)
    if preset is None or (preset.owner_user_id is not None and preset.owner_user_id != user.id):
        raise HTTPException(status_code=404, detail="preset not found")
    return preset


@router.get("", response_model=list[schemas.HostOut])
async def list_hosts(
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> list[schemas.HostOut]:
    rows = (
        (await session.execute(select(Host).where(Host.owner_user_id == user.id))).scalars().all()
    )
    out: list[schemas.HostOut] = []
    for h in rows:
        ac = (
            await session.execute(
                select(func.count(Agent.id)).where(
                    Agent.host_id == h.id,
                    Agent.owner_user_id == user.id,
                    Agent.archived_at.is_(None),
                )
            )
        ).scalar_one()
        out.append(_to_out(h, ac))
    return out


@router.get("/{host_id}", response_model=schemas.HostOut)
async def get_host(
    host_id: str,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.HostOut:
    h = await _get_owned_host(session, host_id, user)
    ac = (
        await session.execute(
            select(func.count(Agent.id)).where(
                Agent.host_id == h.id,
                Agent.owner_user_id == user.id,
                Agent.archived_at.is_(None),
            )
        )
    ).scalar_one()
    return _to_out(h, ac)


@router.patch("/{host_id}", response_model=schemas.HostOut)
async def patch_host(
    host_id: str,
    body: schemas.HostPatch,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.HostOut:
    h = await _get_owned_host(session, host_id, user)
    if body.name is not None:
        h.name = body.name
    await session.commit()
    await session.refresh(h)
    ac = (
        await session.execute(
            select(func.count(Agent.id)).where(
                Agent.host_id == h.id,
                Agent.owner_user_id == user.id,
                Agent.archived_at.is_(None),
            )
        )
    ).scalar_one()
    return _to_out(h, ac)


@router.get("/{host_id}/dirs", response_model=schemas.HostDirList)
async def list_host_dirs(
    host_id: str,
    path: str | None = Query(default=None, max_length=1024),
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.HostDirList:
    await _get_owned_host(session, host_id, user)

    daemon = get_broker().get_daemon_for_host(host_id)
    if daemon is None:
        raise HTTPException(status_code=409, detail="host daemon is offline")

    result = await get_broker().request_dir_list(daemon, path=path)
    if result is None:
        raise HTTPException(status_code=504, detail="host directory listing timed out")
    return schemas.HostDirList.model_validate(result)


@router.get("/{host_id}/tools", response_model=schemas.HostToolList)
async def list_host_tools(
    host_id: str,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.HostToolList:
    await _get_owned_host(session, host_id, user)

    daemon = get_broker().get_daemon_for_host(host_id)
    if daemon is None:
        raise HTTPException(status_code=409, detail="host daemon is offline")

    presets = await _list_accessible_presets(session, user)
    targets = [_preset_to_tool_target(p).model_dump() for p in presets]
    result = await get_broker().request_tool_check(daemon, targets=targets)
    if result is None:
        raise HTTPException(status_code=504, detail="host tool check timed out")
    return schemas.HostToolList.model_validate(result)


@router.post("/{host_id}/tools/{preset_id}/install", response_model=schemas.HostToolInstallResult)
async def install_host_tool(
    host_id: str,
    preset_id: str,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.HostToolInstallResult:
    await _get_owned_host(session, host_id, user)
    preset = await _get_accessible_preset(session, preset_id, user)
    target = _preset_to_tool_target(preset)

    if not (target.install or "").strip():
        raise HTTPException(status_code=400, detail="preset has no install command")

    daemon = get_broker().get_daemon_for_host(host_id)
    if daemon is None:
        raise HTTPException(status_code=409, detail="host daemon is offline")

    result = await get_broker().request_tool_install(daemon, target=target.model_dump())
    if result is None:
        raise HTTPException(status_code=504, detail="host tool install timed out")
    return schemas.HostToolInstallResult.model_validate(result.get("result", result))


@router.delete("/{host_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_host(
    host_id: str,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> None:
    h = await _get_owned_host(session, host_id, user)
    # Boot the daemon if it's connected.
    daemon = get_broker().get_daemon_for_host(host_id)
    if daemon is not None:
        try:
            await daemon.websocket.close(code=4001, reason="host revoked")
        except Exception:
            pass
    await session.delete(h)
    await session.commit()
