"""`/api/hosts` — list, get, rename, delete."""

from __future__ import annotations

import asyncio
import base64
import logging
import uuid
from datetime import UTC, datetime, timedelta
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile, status
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, schemas
from ..db import get_session, get_sessionmaker
from ..models import Agent, Host, HostToolPolicy, Preset, User
from ..ws.broker import get_broker

router = APIRouter(prefix="/api/hosts", tags=["hosts"])
log = logging.getLogger("spawn.routes.hosts")
AUTO_UPDATE_THROTTLE = timedelta(minutes=30)
AUTO_UPDATE_CHECK_INTERVAL_SECONDS = 10 * 60
_AUTO_UPDATE_IN_FLIGHT: set[tuple[str, str, str]] = set()
_AUTO_UPDATE_CHECK_TASK: asyncio.Task[None] | None = None


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt


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


async def _policy_for_preset(
    session: AsyncSession, *, user: User, host_id: str, preset_id: str
) -> HostToolPolicy:
    policy = (
        await session.execute(
            select(HostToolPolicy).where(
                HostToolPolicy.owner_user_id == user.id,
                HostToolPolicy.host_id == host_id,
                HostToolPolicy.preset_id == preset_id,
            )
        )
    ).scalar_one_or_none()
    if policy is not None:
        return policy

    policy = HostToolPolicy(
        id=str(uuid.uuid4()),
        owner_user_id=user.id,
        host_id=host_id,
        preset_id=preset_id,
        auto_update=False,
    )
    session.add(policy)
    await session.flush()
    return policy


async def _policies_for_presets(
    session: AsyncSession, *, user: User, host_id: str, presets: list[Preset]
) -> dict[str, HostToolPolicy]:
    preset_ids = [p.id for p in presets]
    if not preset_ids:
        return {}

    existing = (
        (
            await session.execute(
                select(HostToolPolicy).where(
                    HostToolPolicy.owner_user_id == user.id,
                    HostToolPolicy.host_id == host_id,
                    HostToolPolicy.preset_id.in_(preset_ids),
                )
            )
        )
        .scalars()
        .all()
    )
    by_preset = {p.preset_id: p for p in existing}
    for preset in presets:
        if preset.id in by_preset:
            continue
        policy = HostToolPolicy(
            id=str(uuid.uuid4()),
            owner_user_id=user.id,
            host_id=host_id,
            preset_id=preset.id,
            auto_update=False,
        )
        session.add(policy)
        by_preset[preset.id] = policy
    await session.flush()
    return by_preset


def _merge_tool_policy(status: schemas.HostToolStatus, policy: HostToolPolicy) -> None:
    status.auto_update = policy.auto_update
    status.last_checked_at = policy.last_checked_at
    status.last_auto_update_at = policy.last_auto_update_at
    status.last_auto_update_error = policy.last_auto_update_error


def _should_auto_update(
    status: schemas.HostToolStatus, policy: HostToolPolicy, now: datetime
) -> bool:
    if not policy.auto_update or status.update_available is not True:
        return False
    if not (status.install or "").strip():
        return False
    key = (policy.owner_user_id, policy.host_id, policy.preset_id)
    if key in _AUTO_UPDATE_IN_FLIGHT:
        return False
    last_attempt = _aware(policy.last_auto_update_at)
    return last_attempt is None or now - last_attempt >= AUTO_UPDATE_THROTTLE


def _auto_update_error_from_result(result: schemas.HostToolInstallResult | None) -> str | None:
    if result is None:
        return "host tool install timed out"
    if result.success:
        return None
    if result.error:
        return result.error
    if result.exit_code is not None:
        return f"install exited with code {result.exit_code}"
    return "install failed"


async def _run_auto_update(
    *, user_id: str, host_id: str, preset_id: str, target: dict
) -> None:
    key = (user_id, host_id, preset_id)
    try:
        daemon = get_broker().get_daemon_for_host(host_id)
        if daemon is None:
            error = "host daemon is offline"
        else:
            raw_result = await get_broker().request_tool_install(daemon, target=target)
            result = (
                schemas.HostToolInstallResult.model_validate(raw_result.get("result", raw_result))
                if raw_result is not None
                else None
            )
            error = _auto_update_error_from_result(result)
    except Exception as e:  # noqa: BLE001
        log.warning("auto update failed host=%s preset=%s: %s", host_id, preset_id, e)
        error = str(e)
    try:
        sm = get_sessionmaker()
        async with sm() as session:
            policy = (
                await session.execute(
                    select(HostToolPolicy).where(
                        HostToolPolicy.owner_user_id == user_id,
                        HostToolPolicy.host_id == host_id,
                        HostToolPolicy.preset_id == preset_id,
                    )
                )
            ).scalar_one_or_none()
            if policy is not None:
                policy.last_auto_update_at = _utcnow()
                policy.last_auto_update_error = error
                await session.commit()
    finally:
        _AUTO_UPDATE_IN_FLIGHT.discard(key)


async def run_auto_update_checks_once() -> None:
    sm = get_sessionmaker()
    async with sm() as session:
        rows = (
            await session.execute(
                select(HostToolPolicy, Preset).join(
                    Preset, HostToolPolicy.preset_id == Preset.id
                ).where(HostToolPolicy.auto_update.is_(True))
            )
        ).all()

    by_host: dict[str, list[tuple[str, str, str, dict]]] = {}
    for policy, preset in rows:
        target = _preset_to_tool_target(preset).model_dump()
        by_host.setdefault(policy.host_id, []).append(
            (policy.id, policy.owner_user_id, policy.preset_id, target)
        )

    for host_id, items in by_host.items():
        daemon = get_broker().get_daemon_for_host(host_id)
        if daemon is None:
            continue
        targets = [target for _, _, _, target in items]
        result = await get_broker().request_tool_check(daemon, targets=targets)
        if result is None:
            continue
        checked = schemas.HostToolList.model_validate(result)
        now = _utcnow()
        by_preset = {
            preset_id: (policy_id, user_id, target)
            for policy_id, user_id, preset_id, target in items
        }

        async with sm() as session:
            for tool in checked.tools:
                policy_info = by_preset.get(tool.preset_id)
                if policy_info is None:
                    continue
                policy_id, user_id, target = policy_info
                policy = await session.get(HostToolPolicy, policy_id)
                if policy is None or not policy.auto_update:
                    continue
                policy.last_checked_at = now
                if _should_auto_update(tool, policy, now):
                    key = (user_id, host_id, tool.preset_id)
                    _AUTO_UPDATE_IN_FLIGHT.add(key)
                    policy.last_auto_update_at = now
                    policy.last_auto_update_error = None
                    asyncio.create_task(
                        _run_auto_update(
                            user_id=user_id,
                            host_id=host_id,
                            preset_id=tool.preset_id,
                            target=target,
                        )
                    )
            await session.commit()


async def _auto_update_check_loop() -> None:
    await asyncio.sleep(60)
    while True:
        try:
            await run_auto_update_checks_once()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.warning("auto update check failed: %s", e)
        await asyncio.sleep(AUTO_UPDATE_CHECK_INTERVAL_SECONDS)


def start_auto_update_checker() -> None:
    global _AUTO_UPDATE_CHECK_TASK
    if _AUTO_UPDATE_CHECK_TASK is not None and not _AUTO_UPDATE_CHECK_TASK.done():
        return
    _AUTO_UPDATE_CHECK_TASK = asyncio.create_task(_auto_update_check_loop())


async def stop_auto_update_checker() -> None:
    global _AUTO_UPDATE_CHECK_TASK
    task = _AUTO_UPDATE_CHECK_TASK
    _AUTO_UPDATE_CHECK_TASK = None
    if task is None:
        return
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


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
    await session.commit()

    daemon = get_broker().get_daemon_for_host(host_id)
    if daemon is None:
        raise HTTPException(status_code=409, detail="host daemon is offline")

    result = await get_broker().request_dir_list(daemon, path=path)
    if result is None:
        raise HTTPException(status_code=504, detail="host directory listing timed out")
    return schemas.HostDirList.model_validate(result)


MAX_FS_BYTES = 32 * 1024 * 1024


async def _online_daemon(session: AsyncSession, host_id: str, user: User):
    await _get_owned_host(session, host_id, user)
    daemon = get_broker().get_daemon_for_host(host_id)
    if daemon is None:
        raise HTTPException(status_code=409, detail="host daemon is offline")
    return daemon


def _fs_op_out(result: dict | None, *, timeout_detail: str) -> schemas.HostFileOpOut:
    if result is None:
        raise HTTPException(status_code=504, detail=timeout_detail)
    error = result.get("error")
    if error:
        raise HTTPException(status_code=400, detail=str(error))
    return schemas.HostFileOpOut(path=result.get("path"))


@router.get("/{host_id}/files", response_model=schemas.HostDirList)
async def list_host_files(
    host_id: str,
    path: str | None = Query(default=None, max_length=1024),
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.HostDirList:
    daemon = await _online_daemon(session, host_id, user)
    await session.commit()

    result = await get_broker().request_dir_list(
        daemon, path=path, include_files=True, timeout=10.0
    )
    if result is None:
        raise HTTPException(status_code=504, detail="host file listing timed out")
    return schemas.HostDirList.model_validate(result)


@router.get("/{host_id}/files/download")
async def download_host_file(
    host_id: str,
    path: str = Query(min_length=1, max_length=1024),
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> Response:
    daemon = await _online_daemon(session, host_id, user)
    await session.commit()

    result = await get_broker().request_fs_read(daemon, path=path)
    if result is None:
        raise HTTPException(status_code=504, detail="host file download timed out")
    error = result.get("error")
    if error:
        raise HTTPException(status_code=400, detail=str(error))
    try:
        data = base64.b64decode(result.get("bytes_b64") or "")
    except Exception:
        raise HTTPException(status_code=502, detail="host sent an invalid file payload") from None

    name = str(result.get("name") or path.rsplit("/", 1)[-1] or "file")
    ascii_name = name.encode("ascii", "replace").decode("ascii").replace('"', "_")
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(name)}'
            )
        },
    )


@router.post("/{host_id}/files/upload", response_model=schemas.HostFileOpOut)
async def upload_host_file(
    host_id: str,
    file: UploadFile = File(...),
    dir: str = Form(min_length=1, max_length=1024),
    overwrite: bool = Form(default=False),
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.HostFileOpOut:
    daemon = await _online_daemon(session, host_id, user)
    await session.commit()

    data = await file.read(MAX_FS_BYTES + 1)
    if len(data) > MAX_FS_BYTES:
        raise HTTPException(status_code=400, detail="Upload is too large; the limit is 32 MB.")

    result = await get_broker().request_fs_write(
        daemon,
        dir=dir,
        name=file.filename or "file",
        bytes_b64=base64.b64encode(data).decode("ascii"),
        overwrite=overwrite,
    )
    return _fs_op_out(result, timeout_detail="host file upload timed out")


@router.post("/{host_id}/files/mkdir", response_model=schemas.HostFileOpOut)
async def mkdir_host_file(
    host_id: str,
    body: schemas.HostFileMkdirRequest,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.HostFileOpOut:
    daemon = await _online_daemon(session, host_id, user)
    await session.commit()

    result = await get_broker().request_fs_mkdir(daemon, path=body.path)
    return _fs_op_out(result, timeout_detail="host mkdir timed out")


@router.post("/{host_id}/files/rename", response_model=schemas.HostFileOpOut)
async def rename_host_file(
    host_id: str,
    body: schemas.HostFileRenameRequest,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.HostFileOpOut:
    daemon = await _online_daemon(session, host_id, user)
    await session.commit()

    result = await get_broker().request_fs_rename(daemon, path=body.path, name=body.name)
    return _fs_op_out(result, timeout_detail="host rename timed out")


@router.post("/{host_id}/files/delete", response_model=schemas.HostFileOpOut)
async def delete_host_file(
    host_id: str,
    body: schemas.HostFileDeleteRequest,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.HostFileOpOut:
    daemon = await _online_daemon(session, host_id, user)
    await session.commit()

    result = await get_broker().request_fs_remove(
        daemon, path=body.path, recursive=body.recursive
    )
    return _fs_op_out(result, timeout_detail="host delete timed out")


@router.post("/{host_id}/files/transfer", response_model=schemas.HostFileOpOut)
async def transfer_host_file(
    host_id: str,
    body: schemas.HostFileTransferRequest,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.HostFileOpOut:
    src_daemon = await _online_daemon(session, host_id, user)
    dest_daemon = await _online_daemon(session, body.dest_host_id, user)
    await session.commit()

    read = await get_broker().request_fs_read(src_daemon, path=body.path)
    if read is None:
        raise HTTPException(status_code=504, detail="source host file read timed out")
    error = read.get("error")
    if error:
        raise HTTPException(status_code=400, detail=str(error))

    name = str(read.get("name") or body.path.rsplit("/", 1)[-1] or "file")
    result = await get_broker().request_fs_write(
        dest_daemon,
        dir=body.dest_dir,
        name=name,
        bytes_b64=str(read.get("bytes_b64") or ""),
        overwrite=body.overwrite,
    )
    return _fs_op_out(result, timeout_detail="destination host file write timed out")


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
    policies = await _policies_for_presets(session, user=user, host_id=host_id, presets=presets)
    targets_by_preset = {p.id: _preset_to_tool_target(p) for p in presets}
    targets = [target.model_dump() for target in targets_by_preset.values()]
    await session.commit()

    result = await get_broker().request_tool_check(daemon, targets=targets)
    if result is None:
        raise HTTPException(status_code=504, detail="host tool check timed out")
    checked = schemas.HostToolList.model_validate(result)
    now = _utcnow()
    for tool in checked.tools:
        policy = policies.get(tool.preset_id)
        if policy is None:
            continue
        policy.last_checked_at = now
        _merge_tool_policy(tool, policy)
        if _should_auto_update(tool, policy, now):
            key = (policy.owner_user_id, policy.host_id, policy.preset_id)
            _AUTO_UPDATE_IN_FLIGHT.add(key)
            policy.last_auto_update_at = now
            policy.last_auto_update_error = None
            _merge_tool_policy(tool, policy)
            target = targets_by_preset.get(tool.preset_id)
            if target is not None:
                asyncio.create_task(
                    _run_auto_update(
                        user_id=policy.owner_user_id,
                        host_id=policy.host_id,
                        preset_id=policy.preset_id,
                        target=target.model_dump(),
                    )
                )
    await session.commit()
    return checked


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
    await session.commit()

    daemon = get_broker().get_daemon_for_host(host_id)
    if daemon is None:
        raise HTTPException(status_code=409, detail="host daemon is offline")

    result = await get_broker().request_tool_install(daemon, target=target.model_dump())
    if result is None:
        raise HTTPException(status_code=504, detail="host tool install timed out")
    return schemas.HostToolInstallResult.model_validate(result.get("result", result))


@router.patch(
    "/{host_id}/tools/{preset_id}/policy",
    response_model=schemas.HostToolPolicyOut,
)
async def patch_host_tool_policy(
    host_id: str,
    preset_id: str,
    body: schemas.HostToolPolicyPatch,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.HostToolPolicyOut:
    await _get_owned_host(session, host_id, user)
    await _get_accessible_preset(session, preset_id, user)
    policy = await _policy_for_preset(session, user=user, host_id=host_id, preset_id=preset_id)
    if body.auto_update is not None:
        policy.auto_update = body.auto_update
        if not body.auto_update:
            policy.last_auto_update_error = None
    await session.commit()
    await session.refresh(policy)
    return schemas.HostToolPolicyOut.model_validate(policy)


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
