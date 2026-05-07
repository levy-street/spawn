"""`/api/hosts` — list, get, rename, delete."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, schemas
from ..db import get_session
from ..models import Agent, Host, User
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
    h = await session.get(Host, host_id)
    if h is None or h.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="host not found")
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
    h = await session.get(Host, host_id)
    if h is None or h.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="host not found")
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
    h = await session.get(Host, host_id)
    if h is None or h.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="host not found")

    daemon = get_broker().get_daemon_for_host(host_id)
    if daemon is None:
        raise HTTPException(status_code=409, detail="host daemon is offline")

    result = await get_broker().request_dir_list(daemon, path=path)
    if result is None:
        raise HTTPException(status_code=504, detail="host directory listing timed out")
    return schemas.HostDirList.model_validate(result)


@router.delete("/{host_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_host(
    host_id: str,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> None:
    h = await session.get(Host, host_id)
    if h is None or h.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="host not found")
    # Boot the daemon if it's connected.
    daemon = get_broker().get_daemon_for_host(host_id)
    if daemon is not None:
        try:
            await daemon.websocket.close(code=4001, reason="host revoked")
        except Exception:
            pass
    await session.delete(h)
    await session.commit()
