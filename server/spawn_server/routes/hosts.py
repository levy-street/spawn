"""`/api/hosts` — list, get, rename, delete, agent availability, recent dirs."""

from __future__ import annotations

import logging
import shlex
import time
import uuid
from datetime import UTC, datetime

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Response,
    status,
)
from sqlalchemy import delete, desc, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, release, schemas
from ..db import get_session
from ..host_key_claims import lock_host_key_claim
from ..host_status import derived_host_status, stamp_stale_disconnect
from ..models import (
    Agent,
    DeviceCode,
    Host,
    HostAgentPolicy,
    HostBrowserPin,
    RecentDir,
    Session,
    User,
)
from ..ws.broker import get_broker

router = APIRouter(prefix="/api/hosts", tags=["hosts"])
log = logging.getLogger("spawn.routes.hosts")
MAX_RECENT_DIRS = 8
AGENT_INSTALL_UNAVAILABLE = 'Agent installation and auto update are unavailable here. Install or update agents in a trusted terminal on this host.'
DAEMON_UPDATE_RATE_SECONDS = 15.0
_DAEMON_UPDATE_REQUESTED_AT: dict[str, float] = {}


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _to_out(host: Host, session_count: int, *, now: datetime | None = None) -> schemas.HostOut:
    derived_status = derived_host_status(host, now)
    return schemas.HostOut(
        id=host.id,
        name=host.name,
        os=host.os,
        arch=host.arch,
        version=host.version,
        daemon_tree=host.daemon_tree,
        update=release.host_update_state(host),
        host_key_algorithm=host.host_key_algorithm,
        host_public_key=host.host_public_key,
        status=derived_status,
        last_seen_at=host.last_seen_at,
        last_disconnect=schemas.HostDisconnectOut(
            at=host.last_disconnect_at,
            reason=host.last_disconnect_reason,
        ),
        session_count=session_count,
        supports_account_chains=host.supports_account_chains,
        cpu_cores=host.cpu_cores,
        cpu_physical_cores=host.cpu_physical_cores,
        cpu_model=host.cpu_model,
        memory_bytes=host.memory_bytes,
        gpu=host.gpu,
        # An offline host's last reading is a stale reading. Reporting it would
        # draw a live-looking meter for a machine that is gone, so the buckets
        # go with the daemon and only the spec (which is still true) stays.
        cpu_bucket=host.cpu_bucket if derived_status == "online" else None,
        mem_bucket=host.mem_bucket if derived_status == "online" else None,
        capacity_at=host.capacity_at,
    )


def _command_binary(command: str) -> str:
    """First word of the agent's command string — the binary to `which`."""
    try:
        tokens = shlex.split(command)
    except ValueError:
        tokens = command.split()
    return tokens[0] if tokens else ""


def _agent_to_target(agent: Agent) -> schemas.HostAgentTarget:
    return schemas.HostAgentTarget(
        agent_id=agent.id,
        agent_name=agent.name,
        agent_kind=agent.kind,
        command=_command_binary(agent.command),
        install=agent.install,
    )


async def _session_count(session: AsyncSession, host: Host, user: User) -> int:
    return (
        await session.execute(
            select(func.count(Session.id)).where(
                Session.host_id == host.id,
                Session.owner_user_id == user.id,
            )
        )
    ).scalar_one()


async def _get_owned_host(session: AsyncSession, host_id: str, user: User) -> Host:
    host = await session.get(Host, host_id)
    if host is None or host.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="host not found")
    return host


async def _list_accessible_agents(session: AsyncSession, user: User) -> list[Agent]:
    return (
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


async def _get_accessible_agent(session: AsyncSession, agent_id: str, user: User) -> Agent:
    agent = await session.get(Agent, agent_id)
    if agent is None or (agent.owner_user_id is not None and agent.owner_user_id != user.id):
        raise HTTPException(status_code=404, detail="agent not found")
    return agent


async def _policy_for_agent(
    session: AsyncSession, *, user: User, host_id: str, agent_id: str
) -> HostAgentPolicy:
    policy = (
        await session.execute(
            select(HostAgentPolicy).where(
                HostAgentPolicy.owner_user_id == user.id,
                HostAgentPolicy.host_id == host_id,
                HostAgentPolicy.agent_id == agent_id,
            )
        )
    ).scalar_one_or_none()
    if policy is not None:
        return policy

    policy = HostAgentPolicy(
        id=str(uuid.uuid4()),
        owner_user_id=user.id,
        host_id=host_id,
        agent_id=agent_id,
        auto_update=False,
    )
    session.add(policy)
    await session.flush()
    return policy


async def _policies_for_agents(
    session: AsyncSession, *, user: User, host_id: str, agents: list[Agent]
) -> dict[str, HostAgentPolicy]:
    agent_ids = [agent.id for agent in agents]
    if not agent_ids:
        return {}

    existing = (
        (
            await session.execute(
                select(HostAgentPolicy).where(
                    HostAgentPolicy.owner_user_id == user.id,
                    HostAgentPolicy.host_id == host_id,
                    HostAgentPolicy.agent_id.in_(agent_ids),
                )
            )
        )
        .scalars()
        .all()
    )
    by_agent = {policy.agent_id: policy for policy in existing}
    for agent in agents:
        if agent.id in by_agent:
            continue
        policy = HostAgentPolicy(
            id=str(uuid.uuid4()),
            owner_user_id=user.id,
            host_id=host_id,
            agent_id=agent.id,
            auto_update=False,
        )
        session.add(policy)
        by_agent[agent.id] = policy
    await session.flush()
    return by_agent


def _merge_agent_policy(status: schemas.HostAgentStatus, policy: HostAgentPolicy) -> None:
    # Stored policy is historical metadata, never endpoint execution consent.
    status.auto_update = False
    status.last_checked_at = policy.last_checked_at
    status.last_auto_update_at = policy.last_auto_update_at
    status.last_auto_update_error = policy.last_auto_update_error


@router.get("", response_model=list[schemas.HostOut])
async def list_hosts(
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> list[schemas.HostOut]:
    rows = (
        (await session.execute(select(Host).where(Host.owner_user_id == user.id))).scalars().all()
    )
    now = _utcnow()
    changed = False
    for host in rows:
        changed = stamp_stale_disconnect(host, now) or changed
    if changed:
        await session.commit()
    out: list[schemas.HostOut] = []
    for h in rows:
        out.append(_to_out(h, await _session_count(session, h, user), now=now))
    return out


@router.get("/{host_id}", response_model=schemas.HostOut)
async def get_host(
    host_id: str,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.HostOut:
    h = await _get_owned_host(session, host_id, user)
    now = _utcnow()
    if stamp_stale_disconnect(h, now):
        await session.commit()
    return _to_out(h, await _session_count(session, h, user), now=now)


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
    now = _utcnow()
    if stamp_stale_disconnect(h, now):
        await session.commit()
    return _to_out(h, await _session_count(session, h, user), now=now)


def _enforce_daemon_update_rate(host_id: str) -> None:
    now = time.monotonic()
    previous = _DAEMON_UPDATE_REQUESTED_AT.get(host_id)
    if previous is not None and now - previous < DAEMON_UPDATE_RATE_SECONDS:
        raise HTTPException(status_code=429, detail="daemon update requested too recently")
    _DAEMON_UPDATE_REQUESTED_AT[host_id] = now
    if len(_DAEMON_UPDATE_REQUESTED_AT) > 10_000:
        cutoff = now - DAEMON_UPDATE_RATE_SECONDS
        stale = [
            key
            for key, requested_at in _DAEMON_UPDATE_REQUESTED_AT.items()
            if requested_at < cutoff
        ]
        for key in stale:
            _DAEMON_UPDATE_REQUESTED_AT.pop(key, None)


@router.post(
    "/{host_id}/update",
    response_model=schemas.HostUpdateResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def update_host_daemon(
    host_id: str,
    response: Response,
    body: schemas.HostUpdateRequest | None = None,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.HostUpdateResponse:
    host = await _get_owned_host(session, host_id, user)
    _enforce_daemon_update_rate(host_id)
    manifest = release.read_prebuilt_manifest()
    update_state = release.host_update_state(host, manifest)
    if update_state.state == "current" and not host.worker_mismatch:
        response.status_code = status.HTTP_200_OK
        return schemas.HostUpdateResponse(update=update_state)

    daemon = get_broker().get_daemon_for_host(host_id)
    if host.status != "online" or daemon is None:
        raise HTTPException(status_code=409, detail="host daemon is offline")
    if update_state.state in {"unsupported", "unknown"}:
        detail = update_state.error or "daemon release information is unavailable"
        raise HTTPException(status_code=409, detail=detail)
    if update_state.state == "updating":
        return schemas.HostUpdateResponse(update=update_state)
    if manifest is None:
        raise HTTPException(status_code=409, detail="daemon release information is unavailable")

    payload = release.mark_update_requested(
        host,
        manifest,
        allow_downgrade=body.allow_downgrade if body is not None else False,
    )
    if payload is None:
        raise HTTPException(
            status_code=409,
            detail="no update is available for this daemon target",
        )
    await session.commit()
    await session.refresh(host)

    if not await get_broker().request_daemon_update(daemon, payload):
        host.update_state = "failed"
        host.update_error = "update request could not be delivered"
        await session.commit()
        raise HTTPException(status_code=409, detail="host daemon is offline")

    return schemas.HostUpdateResponse(update=release.host_update_state(host, manifest))


@router.get("/{host_id}/agents", response_model=schemas.HostAgentList)
async def list_host_agents(
    host_id: str,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.HostAgentList:
    await _get_owned_host(session, host_id, user)

    daemon = get_broker().get_daemon_for_host(host_id)
    if daemon is None:
        raise HTTPException(status_code=409, detail="host daemon is offline")

    agents = await _list_accessible_agents(session, user)
    policies = await _policies_for_agents(session, user=user, host_id=host_id, agents=agents)
    targets_by_agent = {agent.id: _agent_to_target(agent) for agent in agents}
    targets = [target.model_dump() for target in targets_by_agent.values()]
    await session.commit()

    result = await get_broker().request_agent_check(daemon, targets=targets)
    if result is None:
        raise HTTPException(status_code=504, detail="host agent check timed out")
    checked = schemas.HostAgentList.model_validate(result)
    now = _utcnow()
    for agent_status in checked.agents:
        policy = policies.get(agent_status.agent_id)
        if policy is None:
            continue
        policy.last_checked_at = now
        _merge_agent_policy(agent_status, policy)
    await session.commit()
    return checked


@router.get("/{host_id}/recent-dirs", response_model=schemas.RecentDirList)
async def list_recent_dirs(
    host_id: str,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.RecentDirList:
    await _get_owned_host(session, host_id, user)
    rows = (
        (
            await session.execute(
                select(RecentDir)
                .where(RecentDir.owner_user_id == user.id, RecentDir.host_id == host_id)
                .order_by(desc(RecentDir.last_used_at), RecentDir.id)
                .limit(MAX_RECENT_DIRS)
            )
        )
        .scalars()
        .all()
    )
    return schemas.RecentDirList(
        dirs=[schemas.RecentDirOut(path=row.path, last_used_at=row.last_used_at) for row in rows]
    )


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


@router.post("/{host_id}/agents/{agent_id}/install", response_model=schemas.HostAgentInstallResult)
async def install_host_agent(
    host_id: str,
    agent_id: str,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.HostAgentInstallResult:
    await _get_owned_host(session, host_id, user)
    await _get_accessible_agent(session, agent_id, user)
    # Refuse before daemon lookup/dispatch, including for old daemon versions.
    raise HTTPException(status_code=409, detail=AGENT_INSTALL_UNAVAILABLE)


@router.patch(
    "/{host_id}/agents/{agent_id}/policy",
    response_model=schemas.HostAgentPolicyOut,
)
async def patch_host_agent_policy(
    host_id: str,
    agent_id: str,
    body: schemas.HostAgentPolicyPatch,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.HostAgentPolicyOut:
    await _get_owned_host(session, host_id, user)
    await _get_accessible_agent(session, agent_id, user)
    if body.auto_update is True:
        raise HTTPException(status_code=409, detail=AGENT_INSTALL_UNAVAILABLE)
    policy = await _policy_for_agent(session, user=user, host_id=host_id, agent_id=agent_id)
    if body.auto_update is not None:
        policy.auto_update = body.auto_update
        if not body.auto_update:
            policy.last_auto_update_error = None
    await session.commit()
    await session.refresh(policy)
    result = schemas.HostAgentPolicyOut.model_validate(policy)
    result.auto_update = False
    return result


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
