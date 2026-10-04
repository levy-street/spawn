"""`/api/sessions` — shell PTYs on hosts; spawn frames go to the daemon WS."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, desc, func, select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, grid, legion, schemas
from ..db import get_session, get_sessionmaker
from ..models import (
    SESSION_MOVABLE_STATUSES,
    SESSION_MOVING,
    Agent,
    Host,
    RecentDir,
    Session,
    User,
    Workspace,
)
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
    if session_row.status == SESSION_MOVING:
        return SESSION_MOVING, "Moving"
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


async def _launch_still_addressed(session_id: str, host_id: str) -> bool:
    """Whether a launch about to go to `host_id` is still that host's to run.

    Read afresh, under the daemon's lifecycle lock, after the commit that
    asked for the launch: a move that landed in between names another host,
    a carried move that began in between is the source's own retire to settle,
    and a delete leaves nothing to start. Each kill takes the same lock
    (`send_session_kill`), so a move committed after this read sends its kill
    to the old host after this launch, never before it, and the daemon, which
    handles lifecycle frames in order, ends the worker this starts.

    A read that fails sends the launch anyway, as before this check existed:
    a window left "starting" with nothing started is worse than the race.
    """
    try:
        async with get_sessionmaker()() as fresh:
            row = (
                await fresh.execute(
                    select(Session.host_id, Session.status).where(Session.id == session_id)
                )
            ).one_or_none()
    except SQLAlchemyError as e:
        log.warning("could not re-read session=%s before its launch: %s", session_id, e)
        return True
    return row is not None and row.host_id == host_id and row.status != SESSION_MOVING


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
        if not await _launch_still_addressed(session_row.id, host.id):
            log.info(
                "%s: session=%s moved, began moving or went before its launch reached "
                "host=%s; not sent",
                frame_type,
                session_row.id,
                host.id,
            )
            return
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


async def _after_missed_write(
    db: AsyncSession, *, user: User, session_id: str
) -> tuple[str, str] | None:
    """Roll back a conditional write that matched no row, and say why from the
    row as committed now: (status, host_id), or None when the caller has no
    such window. The window is gone, a carried move is under way, or it is no
    longer where the request saw it.

    The owner's id is read before the rollback, which expires every object
    this request loaded, the user included."""
    owner_user_id = user.id
    await db.rollback()
    row = (
        await db.execute(
            select(Session.status, Session.host_id).where(
                Session.id == session_id, Session.owner_user_id == owner_user_id
            )
        )
    ).one_or_none()
    return None if row is None else (row.status, row.host_id)


def _session_not_found() -> HTTPException:
    return HTTPException(status_code=404, detail="session not found")


def _move_in_progress() -> HTTPException:
    """A carried move is under way: it ends with its commit or its abort, and
    nothing else may start, stop or delete the window meanwhile — the source
    host holds the window's conversation set aside, and only the device that
    settles the move there can put it back."""
    return HTTPException(status_code=409, detail="move_in_progress")


def _move_conflict() -> HTTPException:
    return HTTPException(status_code=409, detail="move_conflict")


async def _owned_session(db: AsyncSession, *, user: User, session_id: str) -> Session:
    session_row = await db.get(Session, session_id)
    if session_row is None or session_row.owner_user_id != user.id:
        raise _session_not_found()
    return session_row


@router.post("/{session_id}/restart", response_model=schemas.SessionOut)
async def restart_session(
    session_id: str,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.SessionOut:
    """Start the window's shell again on the host it runs on.

    Written as a compare-and-set on the host it read, so a move from another
    device that lands in between refuses this (`409 move_conflict`) instead of
    sending the restart to the host the window has left; the move has started
    the window afresh over there already. A window that is moving is refused
    with `409 move_in_progress`: its move ends with a commit or an abort, and
    "Resume" after an abort is this route.
    """
    session_row = await _owned_session(db, user=user, session_id=session_id)
    if session_row.status == SESSION_MOVING:
        raise _move_in_progress()

    host = await db.get(Host, session_row.host_id)
    if host is None or host.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="host not found")

    daemon = get_broker().get_daemon_for_host(host.id)
    if daemon is None:
        raise HTTPException(status_code=409, detail="host daemon is offline")

    result = await db.execute(
        update(Session)
        .where(
            Session.id == session_row.id,
            Session.owner_user_id == user.id,
            Session.host_id == host.id,
            Session.status != SESSION_MOVING,
        )
        .values(
            status="starting",
            started_at=_utcnow(),
            exited_at=None,
            exit_code=None,
            last_output_at=None,
            last_input_at=None,
            foreground_command=None,
        )
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        state = await _after_missed_write(db, user=user, session_id=session_id)
        if state is None:
            raise _session_not_found()
        raise _move_in_progress() if state[0] == SESSION_MOVING else _move_conflict()
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


@router.post("/{session_id}/move/begin", response_model=schemas.SessionOut)
async def begin_move(
    session_id: str,
    body: schemas.SessionMoveFence,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.SessionOut:
    """Mark a window as moving: a device is about to carry its conversation to
    another host.

    Lifecycle metadata, nothing more. The row keeps its host, folder and
    conversation id, and the server is not told where the window is going —
    the commit (`/move` with `carried`) says that. No frame reaches any host:
    the source's own retire (`conv.export`, over the device's host channel)
    stops the worker and the agent, in the order that makes it the single
    writer's fence; the server is not that fence. Whatever exit the source
    reports meanwhile is recorded (`exited_at`, `exit_code`) and the status
    stays "moving", with no session.died alert or push (`ws/daemon.py`).

    A compare-and-set on the host the client saw the window on and on a
    status a move may begin from (`SESSION_MOVABLE_STATUSES`; a stopped window
    moves too). Refused: `409 move_in_progress` when a move is already under
    way, `409 move_conflict` when the window runs somewhere else than the
    client saw, `409 source_offline` when the host it would leave is not
    connected — its conversation cannot come along, and a fresh `/move` is
    the way to start it elsewhere.

    While it is moving, restart, archive, delete, a fresh move and a second
    begin are refused with `409 move_in_progress`; only the commit or
    `/move/abort` ends it.
    """
    session_row = await _owned_session(db, user=user, session_id=session_id)
    if session_row.status == SESSION_MOVING:
        raise _move_in_progress()
    if session_row.host_id != body.expected_host_id:
        raise _move_conflict()
    if get_broker().get_daemon_for_host(session_row.host_id) is None:
        raise HTTPException(status_code=409, detail="source_offline")

    result = await db.execute(
        update(Session)
        .where(
            Session.id == session_row.id,
            Session.owner_user_id == user.id,
            Session.host_id == body.expected_host_id,
            Session.status.in_(SESSION_MOVABLE_STATUSES),
        )
        .values(status=SESSION_MOVING)
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        # Another device began a move, moved the window, or deleted it between
        # the read above and this write.
        state = await _after_missed_write(db, user=user, session_id=session_id)
        if state is None:
            raise _session_not_found()
        raise _move_in_progress() if state[0] == SESSION_MOVING else _move_conflict()
    await db.commit()
    await db.refresh(session_row)
    host = await db.get(Host, session_row.host_id)
    return _to_out(session_row, host.name if host is not None else None)


@router.post("/{session_id}/move/abort", response_model=schemas.SessionOut)
async def abort_move(
    session_id: str,
    body: schemas.SessionMoveFence,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.SessionOut:
    """End a carried move that will not commit: the window stays where it was,
    stopped.

    Any device may send it — the mover after a failed carry, or another device
    resolving a move that did not finish — and only after the target has
    confirmed it cannot commit: the source host still holds the window's
    conversation set aside until the device aborts the retire there, and the
    server neither knows nor decides that part.

    A compare-and-set on the host the client saw and on "moving": a move that
    has committed, or was aborted already, is `409 move_conflict`. The row
    reads "killed" — stopped by the owner, so the exit that confirms it raises
    no alert — keeping any exit the source already reported, and a
    best-effort `session.kill` goes to the host it names, to end whatever the
    retire did not reach (a host that is offline is told when it registers
    again). Restart then brings the window back there, resuming its
    conversation once the source has put it back.
    """
    session_row = await _owned_session(db, user=user, session_id=session_id)
    result = await db.execute(
        update(Session)
        .where(
            Session.id == session_row.id,
            Session.owner_user_id == user.id,
            Session.host_id == body.expected_host_id,
            Session.status == SESSION_MOVING,
        )
        .values(
            status="killed",
            exited_at=func.coalesce(Session.exited_at, _utcnow()),
            foreground_command=None,
        )
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        if await _after_missed_write(db, user=user, session_id=session_id) is None:
            raise _session_not_found()
        raise _move_conflict()
    await db.commit()
    await db.refresh(session_row)

    await send_session_kill(session_row.id, session_row.host_id)
    host = await db.get(Host, session_row.host_id)
    return _to_out(session_row, host.name if host is not None else None)


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

    Two kinds of move end here. A fresh move carries nothing: an agent window
    starts a new conversation over there, named by `agent_session_id`. A
    carried move's commit (`carried: true`) comes after `/move/begin` and the
    device's carry of the conversation to the target; `agent_session_id` then
    names the conversation the target has just taken in. Its compare-and-set
    also requires the row to be "moving" — begun and not aborted — so a commit
    after an abort is `409 move_conflict`. A fresh move of a window that is
    moving is `409 move_in_progress`: the carry ends with its own commit or
    abort. Either kind types a shell whose agent was started by hand
    (`agent_id`), as a create would type it, so its conversation is
    remembered too.

    The order is the point. The row is rebound first, so the old host's late
    frames — the exit the kill below provokes above all — fail the
    `host_id` fence in `ws/daemon.py` and change nothing: no "Shell exited", no
    session.died alert for a window that only moved. The kill to the old host
    is best effort; one that is offline is told to stop the worker when it
    registers again, because the row then names another host
    (`send_session_kill`). After a carry there is usually nothing left to
    kill: the retire stopped it. The target gets `session.restart`, the same
    frame and fields a restart sends, because a restart first ends any worker
    of this id already there — left by an earlier move away and back. The
    data-changed frame is published by `DataEventMiddleware` for this path,
    after the response, like every other session mutation.

    Authority is unchanged: a restart-class lifecycle request whose folder the
    operator chose, as on create. No new execution parameter reaches the host,
    and nothing of the conversation passes through here.
    """
    session_row = await _owned_session(db, user=user, session_id=session_id)
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
        raise _move_conflict()
    moving = session_row.status == SESSION_MOVING
    if body.carried and not moving:
        # Nothing to commit: never begun, or aborted since.
        raise _move_conflict()
    if not body.carried and moving:
        raise _move_in_progress()
    if target.id == session_row.host_id:
        raise HTTPException(status_code=400, detail="same_host")
    broker = get_broker()
    if broker.get_daemon_for_host(target.id) is None:
        # A carried move stays moving: the device may try the commit again,
        # or abort.
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
            Session.status == SESSION_MOVING if body.carried else Session.status != SESSION_MOVING,
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
        # Another device moved it, began or aborted a move, or deleted it
        # between the read above and this write.
        state = await _after_missed_write(db, user=user, session_id=session_id)
        if state is None:
            raise _session_not_found()
        if not body.carried and state[0] == SESSION_MOVING:
            raise _move_in_progress()
        raise _move_conflict()
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

    Sent under the daemon's lifecycle lock, as every launch is: a launch that
    re-read the row before this kill's commit reaches the daemon first, so the
    kill ends the worker it starts (`_launch_still_addressed`).
    """
    broker = get_broker()
    daemon = broker.get_daemon_for_session(session_id)
    if daemon is None or daemon.host_id != host_id:
        daemon = broker.get_daemon_for_host(host_id)
    if daemon is not None:
        async with daemon.lifecycle_lock:
            try:
                await daemon.send_text(
                    {"type": "session.kill", "session_id": session_id, "signal": "TERM"}
                )
            except Exception as e:  # noqa: BLE001
                log.warning("session.kill dispatch failed: %s", e)
    await broker.detach_session_from_host(session_id, host_id)


async def stop_session_row(db: AsyncSession, *, user: User, session_id: str) -> str | None:
    """Write a session's stopped state and keep the row: the window stays.
    Returns the host it was stopped on, or None when there is no such window
    of this user's or it is moving.

    What archiving does to each window; commit it, then `send_session_kill`
    to the host returned. The process tree, the PTY and the worker holding
    them go away — nothing of this session runs on the host any more — while
    the row it is addressed by survives, so the tile still points somewhere
    and `session.restart` can bring the same session back in the same folder.

    One statement decides and reports where: a move that lands before it is
    stopped on its new host, and one that lands after it finds the window
    stopped where this kill is sent. A moving window is left alone; the
    caller refuses with `409 move_in_progress`.
    """
    # Written here rather than waited for: the daemon confirms the exit with a
    # status frame, but an offline host never will, and a stopped workspace
    # must not read as still running because its host was unreachable.
    result = await db.execute(
        update(Session)
        .where(
            Session.id == session_id,
            Session.owner_user_id == user.id,
            Session.status != SESSION_MOVING,
        )
        .values(status="killed", exited_at=_utcnow(), foreground_command=None)
        .returning(Session.host_id)
        .execution_options(synchronize_session=False)
    )
    return result.scalar_one_or_none()


async def delete_session_row(db: AsyncSession, *, user: User, session_id: str) -> str | None:
    """Delete a window that is not moving, wherever it runs now, and return
    the host it ran on; None when there is no such window of this user's or
    it is moving. Commit, then `send_session_kill` to the host returned."""
    result = await db.execute(
        delete(Session)
        .where(
            Session.id == session_id,
            Session.owner_user_id == user.id,
            Session.status != SESSION_MOVING,
        )
        .returning(Session.host_id)
        .execution_options(synchronize_session=False)
    )
    return result.scalar_one_or_none()


@router.delete("/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session(
    session_id: str,
    db: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> None:
    """Close a window: the row goes, then its worker, on the host the row
    named when it went — a move that lands first is followed there. A window
    that is moving is `409 move_in_progress`: abort the move first, or the
    conversation the source holds set aside would have no window to return
    to."""
    host_id = await delete_session_row(db, user=user, session_id=session_id)
    if host_id is None:
        if await _after_missed_write(db, user=user, session_id=session_id) is None:
            raise _session_not_found()
        raise _move_in_progress()
    await db.commit()
    await send_session_kill(session_id, host_id)
