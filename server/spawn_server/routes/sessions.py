"""`/api/sessions` — shell PTYs on hosts; spawn frames go to the daemon WS."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import desc, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, grid, legion, schemas
from ..db import get_session
from ..models import Agent, Host, RecentDir, Session, User, Workspace
from ..ws.broker import get_broker
from . import capabilities

router = APIRouter(prefix="/api/sessions", tags=["sessions"])
log = logging.getLogger("spawn.routes.sessions")
ACTIVE_OUTPUT_WINDOW = timedelta(seconds=3)
WAITING_OUTPUT_WINDOW = timedelta(seconds=8)
MAX_RECENT_DIRS_PER_HOST = 8


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt


def _last_activity_at(session_row: Session) -> datetime | None:
    candidates = [
        _aware(session_row.last_output_at),
        _aware(session_row.last_input_at),
        _aware(session_row.exited_at),
        _aware(session_row.started_at),
    ]
    return max((value for value in candidates if value is not None), default=None)


def _activity(session_row: Session, now: datetime | None = None) -> tuple[str, str]:
    if session_row.status == "starting":
        return "starting", "Starting"
    if session_row.status == "exited":
        return "exited", "Exited"
    if session_row.status == "killed":
        return "killed", "Killed"
    if session_row.status != "running":
        return session_row.status, session_row.status.replace("_", " ").title()

    now = now or _utcnow()
    last_output = _aware(session_row.last_output_at)
    last_input = _aware(session_row.last_input_at)

    if last_output is None:
        started = _aware(session_row.started_at)
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


def _to_out(session_row: Session, host_name: str | None = None) -> schemas.SessionOut:
    out = schemas.SessionOut.model_validate(session_row)
    out.host_name = host_name
    out.last_activity_at = _last_activity_at(session_row)
    out.activity_state, out.activity_label = _activity(session_row)
    return out


async def upsert_recent_dir(db: AsyncSession, *, user: User, host_id: str, path: str) -> None:
    """Record `path` as most recent for (owner, host), keeping at most 8."""
    now = _utcnow()
    existing = (
        await db.execute(
            select(RecentDir).where(
                RecentDir.owner_user_id == user.id,
                RecentDir.host_id == host_id,
                RecentDir.path == path,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        existing.last_used_at = now
        return
    db.add(RecentDir(owner_user_id=user.id, host_id=host_id, path=path, last_used_at=now))
    await db.flush()
    rows = (
        (
            await db.execute(
                select(RecentDir)
                .where(RecentDir.owner_user_id == user.id, RecentDir.host_id == host_id)
                .order_by(desc(RecentDir.last_used_at), RecentDir.id)
            )
        )
        .scalars()
        .all()
    )
    for stale in rows[MAX_RECENT_DIRS_PER_HOST:]:
        await db.delete(stale)


async def dispatch_session_launch(
    *,
    frame_type: str,
    session_row: Session,
    host: Host,
    create_cwd: bool,
    skills: list[dict] | None = None,
) -> None:
    broker = get_broker()
    daemon = broker.get_daemon_for_host(host.id)
    if daemon is None:
        log.warning("%s: no daemon connection for host=%s", frame_type, host.id)
        return

    # Held while registration decides which of this daemon's workers to stop
    # and sends those kills (`DaemonConn.lifecycle_lock`): a launch committed
    # after that decision goes out after the kills, never before them.
    async with daemon.lifecycle_lock:
        await broker.attach_session_to_daemon(session_row.id, daemon)
        try:
            await daemon.send_text(
                {
                    "type": frame_type,
                    "session_id": session_row.id,
                    "cwd": session_row.cwd,
                    "skills": skills or [],
                    "create_cwd": create_cwd,
                }
            )
        except Exception as e:  # noqa: BLE001
            log.warning("%s dispatch failed: %s", frame_type, e)


async def resolve_agent_id(db: AsyncSession, *, user: User, agent_id: str | None) -> str | None:
    """The agent a window is being opened as, checked against what this user
    can see: their own definitions and the built-ins (owner NULL). An id that
    names neither is refused rather than stored, so a window never claims to be
    a type nothing can launch."""
    if agent_id is None:
        return None
    agent = await db.get(Agent, agent_id)
    if agent is None or agent.owner_user_id not in (None, user.id):
        raise HTTPException(status_code=404, detail="agent not found")
    return agent.id


async def create_session_row(
    db: AsyncSession,
    *,
    user: User,
    host: Host,
    cwd: str,
    name: str | None,
    skill_ids: list[str] | None,
    agent_id: str | None = None,
    agent_session_id: str | None = None,
) -> Session:
    """Add the Session row and its skill grants inside the open transaction."""
    explicit_name = name.strip() if name and name.strip() else None
    resolved_agent_id = await resolve_agent_id(db, user=user, agent_id=agent_id)
    session_row = Session(
        owner_user_id=user.id,
        host_id=host.id,
        cwd=cwd,
        # No name until someone gives it one: the host and folder are shown
        # beside it already, and a name that repeats them read as a duplicate.
        name=explicit_name or None,
        status="starting",
        agent_id=resolved_agent_id,
        # A conversation belongs to an agent; without one there is nothing it
        # could name.
        agent_session_id=agent_session_id if resolved_agent_id is not None else None,
    )
    db.add(session_row)
    await db.flush()
    resolved_skill_ids = (
        await capabilities.default_skill_ids(db, user) if skill_ids is None else skill_ids
    )
    await capabilities.set_session_access(
        db, user=user, session_row=session_row, skill_ids=resolved_skill_ids
    )
    await upsert_recent_dir(db, user=user, host_id=host.id, path=cwd)
    return session_row


def _append_tile(layout: dict, *, session_id: str, tile: schemas.TilePlacement | None) -> dict:
    """Append the new session's tile to the envelope's active tab, auto-placing
    when no explicit tile is given. `layout` is a v3 envelope (see
    workspaces.parse_workspace_layout); the returned envelope shares every
    other tab untouched."""
    from . import workspaces as workspaces_routes

    target = workspaces_routes.active_tab(layout)
    tiles = target["layout"]["tiles"]
    if tile is not None:
        placed_tiles = tiles + [{"session_id": session_id, **tile.model_dump()}]
        if not grid.validate_tiles(placed_tiles):
            raise HTTPException(status_code=400, detail="tile placement is invalid")
    else:
        placed, rect = grid.auto_place(tiles)
        if rect is None:
            raise HTTPException(status_code=409, detail="workspace_full")
        placed.append({"session_id": session_id, **rect})
        placed_tiles = placed
    tabs = [
        {**item, "layout": {"version": grid.LAYOUT_VERSION, "tiles": placed_tiles}}
        if item["id"] == target["id"]
        else item
        for item in layout["tabs"]
    ]
    return {"version": 3, "active_tab": layout.get("active_tab"), "tabs": tabs}


@router.get("", response_model=list[schemas.SessionOut])
async def list_sessions(
    host_id: str | None = None,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> list[schemas.SessionOut]:
    stmt = (
        select(Session, Host.name)
        .join(Host, Session.host_id == Host.id)
        .where(Session.owner_user_id == user.id)
    )
    if host_id:
        stmt = stmt.where(Session.host_id == host_id)
    stmt = stmt.order_by(desc(Session.started_at))
    rows = (await db.execute(stmt)).all()
    return [_to_out(session_row, host_name) for session_row, host_name in rows]


@router.get("/{session_id}", response_model=schemas.SessionOut)
async def get_session_route(
    session_id: str,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.SessionOut:
    session_row = await db.get(Session, session_id)
    if session_row is None or session_row.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="session not found")
    host = await db.get(Host, session_row.host_id)
    return _to_out(session_row, host.name if host is not None else None)


@router.patch("/{session_id}", response_model=schemas.SessionOut)
async def patch_session(
    session_id: str,
    body: schemas.SessionPatch,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.SessionOut:
    session_row = await db.get(Session, session_id)
    if session_row is None or session_row.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="session not found")

    if "name" in body.model_fields_set:
        next_name = body.name.strip() if body.name is not None else ""
        session_row.name = next_name or None

    # An explicit null is how a window that has been stopped back to a bare
    # prompt says it is a shell again; omitting the field leaves the type be.
    if "agent_id" in body.model_fields_set:
        session_row.agent_id = await resolve_agent_id(db, user=user, agent_id=body.agent_id)
        # A new launch is a new conversation and a stop is the end of one, so
        # a retype that says nothing about the conversation clears it rather
        # than leaving a resume pointed at a thread this window is no longer in.
        session_row.agent_session_id = None
    if "agent_session_id" in body.model_fields_set:
        # Only an agent window has a conversation to name.
        session_row.agent_session_id = (
            body.agent_session_id if session_row.agent_id is not None else None
        )

    await db.commit()
    await db.refresh(session_row)
    host = await db.get(Host, session_row.host_id)
    return _to_out(session_row, host.name if host is not None else None)


@router.post("", response_model=schemas.SessionOut, status_code=status.HTTP_201_CREATED)
async def create_session(
    body: schemas.SessionCreate,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.SessionOut:
    host = await db.get(Host, body.host_id)
    if host is None or host.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="host not found")

    if body.tile is not None and body.workspace_id is None:
        raise HTTPException(status_code=400, detail="tile requires workspace_id")

    workspace: Workspace | None = None
    if body.workspace_id is not None:
        workspace = await db.get(Workspace, body.workspace_id)
        if workspace is None or workspace.owner_user_id != user.id:
            raise HTTPException(status_code=404, detail="workspace not found")
        # Nothing runs in an archived workspace — that is what archiving is
        # for — so a new session would quietly undo it. Restore first.
        if workspace.archived_at is not None:
            raise HTTPException(status_code=409, detail="workspace_archived")

    session_row = await create_session_row(
        db,
        user=user,
        host=host,
        cwd=body.cwd,
        name=body.name,
        skill_ids=body.skill_ids,
        agent_id=body.agent_id,
        agent_session_id=body.agent_session_id,
    )

    if workspace is not None:
        # Imported here: workspaces.py needs this module's session helpers.
        from . import workspaces as workspaces_routes

        layout = await workspaces_routes.prune_workspace_tiles(
            db, user, workspaces_routes.parse_workspace_layout(workspace.layout)
        )
        workspace.layout = _append_tile(layout, session_id=session_row.id, tile=body.tile)
        workspace.updated_at = _utcnow()

    await db.commit()
    await db.refresh(session_row)

    # The durable record of the summoning. Booked after the commit and before
    # the dispatch: the session row exists by now, and a rollup that cannot be
    # written must not be able to stop a session from starting (see legion).
    await legion.record_session_started(user.id)
    live_sessions, hosts_online = await legion.live_counts(db, user.id)
    await legion.record_peaks(user.id, sessions=live_sessions, hosts_online=hosts_online)

    skills = await capabilities.get_session_launch_capabilities(
        db, user=user, session_id=session_row.id
    )

    # Dispatch session.create to the daemon; it spawns the user's login shell.
    await dispatch_session_launch(
        frame_type="session.create",
        session_row=session_row,
        host=host,
        create_cwd=True,
        skills=skills,
    )

    return _to_out(session_row, host.name)


@router.post("/{session_id}/restart", response_model=schemas.SessionOut)
async def restart_session(
    session_id: str,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.SessionOut:
    session_row = await db.get(Session, session_id)
    if session_row is None or session_row.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="session not found")

    host = await db.get(Host, session_row.host_id)
    if host is None or host.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="host not found")

    daemon = get_broker().get_daemon_for_host(host.id)
    if daemon is None:
        raise HTTPException(status_code=409, detail="host daemon is offline")

    now = _utcnow()
    session_row.status = "starting"
    session_row.started_at = now
    session_row.exited_at = None
    session_row.exit_code = None
    session_row.last_output_at = None
    session_row.last_input_at = None
    session_row.foreground_command = None
    await db.commit()
    await db.refresh(session_row)
    skills = await capabilities.get_session_launch_capabilities(
        db, user=user, session_id=session_row.id
    )

    await dispatch_session_launch(
        frame_type="session.restart",
        session_row=session_row,
        host=host,
        create_cwd=True,
        skills=skills,
    )
    return _to_out(session_row, host.name)


@router.post("/{session_id}/move", response_model=schemas.SessionOut)
async def move_session(
    session_id: str,
    body: schemas.SessionMove,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.SessionOut:
    """Run the same window on another host.

    The row is the window, so it stays: its id, name, agent, skill grants, and
    everything clients key by its id — the tile, mutes, notification settings.
    Only the incarnation changes, one worker and PTY on one host for another.
    Nothing of the old incarnation travels; an agent window starts a new
    conversation over there, named by `agent_session_id`. A shell whose agent
    was started by hand is typed by the move (`agent_id`), as a create would
    type it, so that conversation is remembered too.

    The order is the point. The row is rebound first, so the old host's late
    frames — the exit the kill below provokes above all — fail the
    `host_id` fence in `ws/daemon.py` and change nothing: no "Shell exited", no
    session.died alert for a window that only moved. The kill to the old host
    is best effort; one that is offline is told to stop the worker when it
    registers again, because the row then names another host
    (`send_session_kill`). The target gets `session.restart`, the same frame
    and fields a restart
    sends, because a restart first ends any worker of this id already there —
    left by an earlier move away and back. The data-changed frame is published
    by `DataEventMiddleware` for this path, after the response, like every
    other session mutation.

    Authority is unchanged: a restart-class lifecycle request whose folder the
    operator chose, as on create. No new execution parameter reaches the host.
    """
    session_row = await db.get(Session, session_id)
    if session_row is None or session_row.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="session not found")
    target = await db.get(Host, body.host_id)
    if target is None or target.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="host not found")
    # The agent the mover starts over there types the window, as on create —
    # a shell someone started an agent in by hand becomes that agent's window,
    # so its conversation is kept and a restart can resume it.
    retyped = (
        {"agent_id": await resolve_agent_id(db, user=user, agent_id=body.agent_id)}
        if body.agent_id is not None
        else {}
    )
    agent_id = retyped.get("agent_id", session_row.agent_id)
    # Compare first: a client that saw the window somewhere it no longer runs
    # is acting on a stale picture, even when it happens to name the host the
    # window has since moved to.
    if session_row.host_id != body.expected_host_id:
        raise HTTPException(status_code=409, detail="move_conflict")
    if target.id == session_row.host_id:
        raise HTTPException(status_code=400, detail="same_host")
    broker = get_broker()
    if broker.get_daemon_for_host(target.id) is None:
        raise HTTPException(status_code=409, detail="target_offline")

    source_host_id = session_row.host_id
    # Only an agent window has a conversation to name.
    conversation = body.agent_session_id if agent_id is not None else None
    result = await db.execute(
        update(Session)
        .where(
            Session.id == session_row.id,
            Session.owner_user_id == user.id,
            Session.host_id == body.expected_host_id,
        )
        .values(
            host_id=target.id,
            cwd=body.cwd,
            status="starting",
            started_at=_utcnow(),
            exited_at=None,
            exit_code=None,
            last_output_at=None,
            last_input_at=None,
            foreground_command=None,
            agent_session_id=conversation,
            **retyped,
        )
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        # Another device moved it between the read above and this write.
        await db.rollback()
        raise HTTPException(status_code=409, detail="move_conflict")
    await upsert_recent_dir(db, user=user, host_id=target.id, path=body.cwd)
    await db.commit()
    await db.refresh(session_row)

    # Addressed to the host the window left only: its routing there goes, and
    # the launch below attaches the window to the target.
    await send_session_kill(session_row.id, source_host_id)

    skills = await capabilities.get_session_launch_capabilities(
        db, user=user, session_id=session_row.id
    )
    await dispatch_session_launch(
        frame_type="session.restart",
        session_row=session_row,
        host=target,
        create_cwd=True,
        skills=skills,
    )
    return _to_out(session_row, target.name)


async def send_session_kill(session_id: str, host_id: str) -> None:
    """Ask `host_id`'s daemon to end the session's worker there (best effort)
    and stop routing the session to that daemon.

    Sent only after the commit that stopped, deleted or moved the row. The
    daemon confirms with `session.exit`, and that handler reads the row: one
    still marked running reads as a crash and pages the owner with "was
    killed". An offline host is sent nothing; when it registers again it is
    told to stop any worker whose row says stopped or names another host
    (`_stop_workers_left_running` in `ws/daemon.py`). A row deleted while its
    host is offline leaves nothing to compare against, so that worker runs on.

    Only `host_id` is addressed. For a move, pass the host the window left:
    the session may already be routed to its new host (a launch there
    attaches it), and that worker and its routing are left alone whichever
    order the two are sent in.
    """
    broker = get_broker()
    daemon = broker.get_daemon_for_session(session_id)
    if daemon is None or daemon.host_id != host_id:
        daemon = broker.get_daemon_for_host(host_id)
    if daemon is not None:
        try:
            await daemon.send_text(
                {"type": "session.kill", "session_id": session_id, "signal": "TERM"}
            )
        except Exception as e:  # noqa: BLE001
            log.warning("session.kill dispatch failed: %s", e)
    await broker.detach_session_from_host(session_id, host_id)


def mark_session_stopped(session_row: Session) -> None:
    """Write a session's stopped state and keep the row: the window stays.

    What archiving does to each window; commit it, then `send_session_kill`.
    The process tree, the PTY and the worker holding them go away — nothing of
    this session runs on the host any more — while the row it is addressed by
    survives, so the tile still points somewhere and `session.restart` can
    bring the same session back in the same folder.
    """
    # Written here rather than waited for: the daemon confirms the exit with a
    # status frame, but an offline host never will, and a stopped workspace
    # must not read as still running because its host was unreachable.
    session_row.status = "killed"
    session_row.exited_at = _utcnow()
    session_row.foreground_command = None


@router.delete("/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session(
    session_id: str,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> None:
    session_row = await db.get(Session, session_id)
    if session_row is None or session_row.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="session not found")
    host_id = session_row.host_id
    await db.delete(session_row)
    await db.commit()
    await send_session_kill(session_id, host_id)
