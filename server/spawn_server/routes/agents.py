"""`/api/agents` — list/get/create/delete; spawn frames are sent to the daemon WS."""

from __future__ import annotations

import base64
import logging
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import agent_control, auth, schemas, transcript
from ..db import get_session
from ..models import Agent, Host, Preset, User
from ..ws.broker import get_broker
from . import capabilities

router = APIRouter(prefix="/api/agents", tags=["agents"])
log = logging.getLogger("spawn.routes.agents")
ACTIVE_OUTPUT_WINDOW = timedelta(seconds=3)
WAITING_OUTPUT_WINDOW = timedelta(seconds=8)


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _last_cwd_dir(cwd: str) -> str:
    normalized = cwd.strip().rstrip("/\\")
    if not normalized:
        return cwd.strip() or "/"
    return normalized.replace("\\", "/").rsplit("/", 1)[-1] or normalized


def _default_agent_name(host_name: str, cwd: str) -> str:
    return f"{host_name} - {_last_cwd_dir(cwd)}"[:128]


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt


def _last_activity_at(agent: Agent) -> datetime | None:
    candidates = [
        _aware(agent.last_output_at),
        _aware(agent.last_input_at),
        _aware(agent.exited_at),
        _aware(agent.started_at),
    ]
    return max((value for value in candidates if value is not None), default=None)


def _activity(agent: Agent, now: datetime | None = None) -> tuple[str, str]:
    if agent.status == "starting":
        return "starting", "Starting"
    if agent.status == "exited":
        return "exited", "Exited"
    if agent.status == "killed":
        return "killed", "Killed"
    if agent.status != "running":
        return agent.status, agent.status.replace("_", " ").title()

    now = now or _utcnow()
    last_output = _aware(agent.last_output_at)
    last_input = _aware(agent.last_input_at)

    if last_output is None:
        started = _aware(agent.started_at)
        if started is not None and now - started >= WAITING_OUTPUT_WINDOW:
            return "quiet", "Quiet"
        return "starting", "Starting"
    if now - last_output <= ACTIVE_OUTPUT_WINDOW:
        return "active", "Active"
    if last_input is not None and last_input > last_output:
        return "input_sent", "Input sent"
    if now - last_output >= WAITING_OUTPUT_WINDOW:
        return "waiting", "Awaiting input"
    return "quiet", "Quiet"


def _to_out(agent: Agent, host_name: str | None = None) -> schemas.AgentOut:
    out = schemas.AgentOut.model_validate(agent)
    out.host_name = host_name
    out.last_activity_at = _last_activity_at(agent)
    out.activity_state, out.activity_label = _activity(agent)
    return out


@router.get("", response_model=list[schemas.AgentOut])
async def list_agents(
    host_id: str | None = None,
    include_archived: bool = False,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> list[schemas.AgentOut]:
    stmt = (
        select(Agent, Host.name)
        .join(Host, Agent.host_id == Host.id)
        .where(Agent.owner_user_id == user.id)
    )
    if host_id:
        stmt = stmt.where(Agent.host_id == host_id)
    if not include_archived:
        stmt = stmt.where(Agent.archived_at.is_(None))
    stmt = stmt.order_by(desc(Agent.started_at))
    rows = (await session.execute(stmt)).all()
    return [_to_out(agent, host_name) for agent, host_name in rows]


@router.get("/{agent_id}", response_model=schemas.AgentOut)
async def get_agent(
    agent_id: str,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.AgentOut:
    a = await session.get(Agent, agent_id)
    if a is None or a.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="agent not found")
    host = await session.get(Host, a.host_id)
    return _to_out(a, host.name if host is not None else None)


async def _resolve_agent_preset(
    session: AsyncSession, preset_id: str | None, user: User
) -> Preset | None:
    if preset_id is None:
        return None
    preset = await session.get(Preset, preset_id)
    if preset is None:
        raise HTTPException(status_code=404, detail="preset not found")
    if preset.owner_user_id is not None and preset.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="preset not found")
    return preset


async def _dispatch_agent_launch(
    *,
    frame_type: str,
    agent: Agent,
    host: Host,
    preset: Preset | None,
    cols: int,
    rows: int,
    create_cwd: bool,
    skills: list[dict] | None = None,
) -> None:
    broker = get_broker()
    daemon = broker.get_daemon_for_host(host.id)
    if daemon is None:
        log.warning("%s: no daemon connection for host=%s", frame_type, host.id)
        return

    await broker.attach_agent_to_daemon(agent.id, daemon)
    try:
        await daemon.send_text(
            {
                "type": frame_type,
                "agent_id": agent.id,
                "cwd": agent.cwd,
                "argv": agent.argv,
                "env": agent.env,
                "install": preset.install if preset is not None else None,
                "skills": skills or [],
                "cols": cols,
                "rows": rows,
                "create_cwd": create_cwd,
            }
        )
    except Exception as e:  # noqa: BLE001
        log.warning("%s dispatch failed: %s", frame_type, e)


@router.patch("/{agent_id}", response_model=schemas.AgentOut)
async def patch_agent(
    agent_id: str,
    body: schemas.AgentPatch,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.AgentOut:
    a = await session.get(Agent, agent_id)
    if a is None or a.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="agent not found")

    if "name" in body.model_fields_set:
        next_name = body.name.strip() if body.name is not None else ""
        a.name = next_name or None
    if body.pinned is not None:
        a.pinned_at = _utcnow() if body.pinned else None
    if body.archived is not None:
        a.archived_at = _utcnow() if body.archived else None

    await session.commit()
    await session.refresh(a)
    host = await session.get(Host, a.host_id)
    return _to_out(a, host.name if host is not None else None)


@router.post("", response_model=schemas.AgentOut, status_code=status.HTTP_201_CREATED)
async def create_agent(
    body: schemas.AgentCreate,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.AgentOut:
    if body.preset_id is None and not body.argv:
        raise HTTPException(status_code=400, detail="at least one of preset_id or argv is required")

    host = await session.get(Host, body.host_id)
    if host is None or host.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="host not found")

    preset = await _resolve_agent_preset(session, body.preset_id, user)

    argv = list(body.argv) if body.argv else (list(preset.default_argv) if preset else [])
    if not argv:
        raise HTTPException(status_code=400, detail="resolved argv is empty")

    env: dict[str, str] = {}
    if preset is not None:
        env.update(preset.env_template or {})
    if body.env:
        env.update(body.env)

    explicit_name = body.name.strip() if body.name and body.name.strip() else None
    agent = Agent(
        owner_user_id=user.id,
        host_id=host.id,
        preset_id=preset.id if preset is not None else None,
        cwd=body.cwd,
        argv=argv,
        env=env,
        name=explicit_name or _default_agent_name(host.name, body.cwd),
        status="starting",
    )
    session.add(agent)
    await session.flush()
    skill_ids = (
        await capabilities.default_skill_ids(session, user)
        if body.skill_ids is None
        else body.skill_ids
    )
    await capabilities.set_agent_access(
        session,
        user=user,
        agent=agent,
        skill_ids=skill_ids,
    )
    await session.commit()
    await session.refresh(agent)
    skills = await capabilities.get_agent_launch_capabilities(
        session, user=user, agent_id=agent.id
    )

    # Dispatch agent.create to the daemon. spawn does not manage agent
    # credentials — the agent CLI on the host handles its own auth.
    await _dispatch_agent_launch(
        frame_type="agent.create",
        agent=agent,
        host=host,
        preset=preset,
        cols=body.cols,
        rows=body.rows,
        create_cwd=body.create_cwd,
        skills=skills,
    )

    return _to_out(agent, host.name)


@router.post("/{agent_id}/restart", response_model=schemas.AgentOut)
async def restart_agent(
    agent_id: str,
    body: schemas.AgentRestart,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.AgentOut:
    agent = await session.get(Agent, agent_id)
    if agent is None or agent.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="agent not found")

    host = await session.get(Host, agent.host_id)
    if host is None or host.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="host not found")

    daemon = get_broker().get_daemon_for_host(host.id)
    if daemon is None:
        raise HTTPException(status_code=409, detail="host daemon is offline")

    preset = await _resolve_agent_preset(session, agent.preset_id, user)
    now = _utcnow()
    agent.status = "starting"
    agent.started_at = now
    agent.exited_at = None
    agent.exit_code = None
    agent.last_output_at = None
    agent.last_input_at = None
    await session.commit()
    await session.refresh(agent)
    skills = await capabilities.get_agent_launch_capabilities(
        session, user=user, agent_id=agent.id
    )

    await _dispatch_agent_launch(
        frame_type="agent.restart",
        agent=agent,
        host=host,
        preset=preset,
        cols=body.cols,
        rows=body.rows,
        create_cwd=body.create_cwd,
        skills=skills,
    )
    return _to_out(agent, host.name)


@router.post("/{agent_id}/input", response_model=schemas.AgentInputResult)
async def input_agent(
    agent_id: str,
    body: schemas.AgentInput,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.AgentInputResult:
    result = await agent_control.send_agent_input(
        session=session,
        user=user,
        agent_id=agent_id,
        text=body.text,
        bytes_b64=body.bytes_b64,
    )
    return schemas.AgentInputResult.model_validate(result)


@router.post("/{agent_id}/resize", response_model=schemas.AgentResizeResult)
async def resize_agent(
    agent_id: str,
    body: schemas.AgentResize,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.AgentResizeResult:
    result = await agent_control.resize_agent(
        session=session,
        user=user,
        agent_id=agent_id,
        cols=body.cols,
        rows=body.rows,
    )
    return schemas.AgentResizeResult.model_validate(result)


@router.post("/{agent_id}/scroll", response_model=schemas.AgentScrollResult)
async def scroll_agent(
    agent_id: str,
    body: schemas.AgentScroll,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.AgentScrollResult:
    result = await agent_control.scroll_agent(
        session=session,
        user=user,
        agent_id=agent_id,
        lines=body.lines,
    )
    return schemas.AgentScrollResult.model_validate(result)


@router.post("/{agent_id}/redraw", response_model=schemas.AgentRedrawResult)
async def redraw_agent(
    agent_id: str,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.AgentRedrawResult:
    result = await agent_control.redraw_agent(session=session, user=user, agent_id=agent_id)
    return schemas.AgentRedrawResult.model_validate(result)


@router.post("/{agent_id}/snapshot", response_model=schemas.AgentSnapshotOut)
async def snapshot_agent(
    agent_id: str,
    body: schemas.AgentSnapshotRequest,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.AgentSnapshotOut:
    result = await agent_control.snapshot_agent(
        session=session,
        user=user,
        agent_id=agent_id,
        lines=body.lines,
        plain=body.plain,
    )
    return schemas.AgentSnapshotOut.model_validate(result)


@router.post("/{agent_id}/upload", response_model=schemas.AgentUploadOut)
async def upload_agent(
    agent_id: str,
    body: schemas.AgentUploadRequest,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.AgentUploadOut:
    result = await agent_control.upload_agent_file(
        session=session,
        user=user,
        agent_id=agent_id,
        name=body.name,
        mime_type=body.mime_type,
        bytes_b64=body.bytes_b64,
        paste=body.paste,
        destination=body.destination,
        client_id=body.client_id,
    )
    return schemas.AgentUploadOut.model_validate(result)


@router.post("/{agent_id}/upload-file", response_model=schemas.AgentUploadOut)
async def upload_agent_multipart(
    agent_id: str,
    file: UploadFile = File(...),
    paste: bool = Form(default=True),
    destination: str | None = Form(default=None),
    client_id: str | None = Form(default=None),
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.AgentUploadOut:
    data = await file.read(agent_control.MAX_UPLOAD_BYTES + 1)
    if len(data) > agent_control.MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="Upload is too large; the limit is 20 MB.")
    result = await agent_control.upload_agent_file(
        session=session,
        user=user,
        agent_id=agent_id,
        name=file.filename,
        mime_type=file.content_type,
        bytes_b64=base64.b64encode(data).decode("ascii"),
        paste=paste,
        destination=destination,
        client_id=client_id,
    )
    return schemas.AgentUploadOut.model_validate(result)


@router.delete("/{agent_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_agent(
    agent_id: str,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> None:
    a = await session.get(Agent, agent_id)
    if a is None or a.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="agent not found")
    daemon = get_broker().get_daemon_for_agent(agent_id) or get_broker().get_daemon_for_host(
        a.host_id
    )
    if daemon is not None:
        try:
            await daemon.send_text({"type": "agent.kill", "agent_id": agent_id, "signal": "TERM"})
        except Exception as e:  # noqa: BLE001
            log.warning("agent.kill dispatch failed: %s", e)
    await get_broker().detach_agent(agent_id)
    await session.delete(a)
    await session.commit()
    await transcript.clear(agent_id)
