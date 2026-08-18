"""`/api/hosts` — list, get, rename, delete."""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Response,
    status,
)
from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, schemas
from ..db import get_session, get_sessionmaker
from ..host_identity import host_key_fingerprint
from ..host_key_claims import lock_host_key_claim
from ..models import Agent, DeviceCode, Host, HostBrowserPin, HostToolPolicy, Preset, User
from ..ws.broker import get_broker

router = APIRouter(prefix="/api/hosts", tags=["hosts"])
log = logging.getLogger("spawn.routes.hosts")
AUTO_UPDATE_THROTTLE = timedelta(minutes=30)
AUTO_UPDATE_CHECK_INTERVAL_SECONDS = 10 * 60
AUTO_UPDATE_SHUTDOWN_DRAIN_SECONDS = 5.0
_AUTO_UPDATE_IN_FLIGHT: set[tuple[str, str, str]] = set()
_AUTO_UPDATE_TASKS: set[asyncio.Task[None]] = set()
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
    fingerprint = (
        host_key_fingerprint(host.host_key_algorithm, host.host_public_key)
        if host.host_key_algorithm is not None and host.host_public_key is not None
        else None
    )
    return schemas.HostOut(
        id=host.id,
        name=host.name,
        os=host.os,
        arch=host.arch,
        version=host.version,
        host_key_algorithm=host.host_key_algorithm,
        host_public_key=host.host_public_key,
        host_key_fingerprint=fingerprint,
        status=host.status,
        last_seen_at=host.last_seen_at,
        agent_count=agent_count,
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


async def _run_auto_update(*, user_id: str, host_id: str, preset_id: str, target: dict) -> None:
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


async def _owned_auto_update(*, user_id: str, host_id: str, preset_id: str, target: dict) -> None:
    key = (user_id, host_id, preset_id)
    try:
        await _run_auto_update(
            user_id=user_id,
            host_id=host_id,
            preset_id=preset_id,
            target=target,
        )
    finally:
        # This outer ownership boundary covers request cancellation and every
        # persistence failure, so throttling cannot retain a stuck key.
        _AUTO_UPDATE_IN_FLIGHT.discard(key)


def _auto_update_task_done(task: asyncio.Task[None]) -> None:
    _AUTO_UPDATE_TASKS.discard(task)
    if task.cancelled():
        return
    error = task.exception()
    if error is not None:
        log.error(
            "owned auto update task failed",
            exc_info=(type(error), error, error.__traceback__),
        )


def _start_auto_update(*, user_id: str, host_id: str, preset_id: str, target: dict) -> bool:
    key = (user_id, host_id, preset_id)
    if key in _AUTO_UPDATE_IN_FLIGHT:
        return False
    _AUTO_UPDATE_IN_FLIGHT.add(key)
    try:
        task = asyncio.create_task(
            _owned_auto_update(
                user_id=user_id,
                host_id=host_id,
                preset_id=preset_id,
                target=target,
            ),
            name=f"auto-update:{host_id}:{preset_id}",
        )
    except BaseException:
        _AUTO_UPDATE_IN_FLIGHT.discard(key)
        raise
    _AUTO_UPDATE_TASKS.add(task)
    task.add_done_callback(_auto_update_task_done)
    return True


async def wait_for_auto_update_tasks_idle(*, timeout: float | None = None) -> bool:
    loop = asyncio.get_running_loop()
    deadline = None if timeout is None else loop.time() + timeout
    while _AUTO_UPDATE_TASKS:
        remaining = None if deadline is None else max(0.0, deadline - loop.time())
        if remaining == 0.0:
            return False
        _, pending = await asyncio.wait(tuple(_AUTO_UPDATE_TASKS), timeout=remaining)
        if pending and deadline is not None and loop.time() >= deadline:
            return False
    return True


async def run_auto_update_checks_once() -> None:
    sm = get_sessionmaker()
    async with sm() as session:
        rows = (
            await session.execute(
                select(HostToolPolicy, Preset)
                .join(Preset, HostToolPolicy.preset_id == Preset.id)
                .where(HostToolPolicy.auto_update.is_(True))
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
                    if _start_auto_update(
                        user_id=user_id,
                        host_id=host_id,
                        preset_id=tool.preset_id,
                        target=target,
                    ):
                        policy.last_auto_update_at = now
                        policy.last_auto_update_error = None
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
    if task is not None:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    if await wait_for_auto_update_tasks_idle(timeout=AUTO_UPDATE_SHUTDOWN_DRAIN_SECONDS):
        return

    pending = tuple(_AUTO_UPDATE_TASKS)
    log.warning("cancelling %d auto update task(s) after shutdown drain", len(pending))
    for update_task in pending:
        update_task.cancel()
    await asyncio.gather(*pending, return_exceptions=True)


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
            target = targets_by_preset.get(tool.preset_id)
            if target is not None and _start_auto_update(
                user_id=policy.owner_user_id,
                host_id=policy.host_id,
                preset_id=policy.preset_id,
                target=target.model_dump(),
            ):
                policy.last_auto_update_at = now
                policy.last_auto_update_error = None
                _merge_tool_policy(tool, policy)
    await session.commit()
    return checked


@router.post("/{host_id}/control/ping", status_code=status.HTTP_204_NO_CONTENT)
async def ping_host_control(
    host_id: str,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> Response:
    await _get_owned_host(session, host_id, user)
    daemon = get_broker().get_daemon_for_host(host_id)
    if daemon is None:
        raise HTTPException(status_code=409, detail="host daemon is offline")
    await session.commit()
    if not await get_broker().request_host_ping(daemon):
        raise HTTPException(status_code=504, detail="host daemon control ping timed out")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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


# Registered before `/{host_id}` so the literal path wins the match.
@router.delete("/self", status_code=status.HTTP_204_NO_CONTENT)
async def deregister_self(
    session: AsyncSession = Depends(get_session),
    host: Host = Depends(auth.daemon_principal),
) -> None:
    """A daemon revokes its OWN host registration — used by `spawnd exorcise`
    and the possess re-identify dedup. Authenticated by the daemon token, so a
    host can only remove itself; no owning-user session is required."""
    await _revoke_host(session, host)


@router.delete("/{host_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_host(
    host_id: str,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> None:
    h = await _get_owned_host(session, host_id, user)
    await _revoke_host(session, h)


async def _revoke_host(session: AsyncSession, h: Host) -> None:
    """Durable revocation cascade shared by the user- and daemon-authenticated
    delete routes: drop the host's device codes and browser pins inside the same
    transaction as the Host row, then disconnect any live daemon."""
    if h.host_key_algorithm is not None and h.host_public_key is not None:
        claimed_owner = await lock_host_key_claim(
            session,
            host_key_algorithm=h.host_key_algorithm,
            host_public_key=h.host_public_key,
        )
        if claimed_owner != h.owner_user_id:
            # Every keyed Host is backfilled by migration 0020 or created only
            # after its durable claim commits. Missing/mismatched state must not
            # be deleted because that would release the key fail-open.
            raise HTTPException(status_code=409, detail="host key ownership claim is invalid")

        # Start, approval, and poll take the retained claim before touching a
        # DeviceCode. Keep that order here so either the ceremony commits first
        # and revocation removes its resulting authority, or deletion commits
        # first and the ceremony loses its code. The claim itself is retained:
        # only this same owner can intentionally pair the stable key again.
        await session.execute(
            delete(DeviceCode)
            .where(
                DeviceCode.host_key_algorithm == h.host_key_algorithm,
                DeviceCode.host_public_key == h.host_public_key,
            )
            .execution_options(synchronize_session=False)
        )
        # Do not rely solely on backend FK-cascade configuration for the
        # immutable authority pins. Their removal is part of this revocation
        # transaction and must hold on both production PostgreSQL and SQLite.
        await session.execute(
            delete(HostBrowserPin)
            .where(HostBrowserPin.host_id == h.id)
            .execution_options(synchronize_session=False)
        )
    host_id = h.id
    await session.delete(h)
    await session.commit()

    # External cleanup follows the durable revocation boundary. Closing first
    # could disconnect a healthy daemon even if the database transaction later
    # failed, while a committed Host deletion already invalidates its token.
    daemon = get_broker().get_daemon_for_host(host_id)
    if daemon is not None:
        try:
            await daemon.websocket.close(code=4001, reason="host revoked")
        except Exception:
            pass
