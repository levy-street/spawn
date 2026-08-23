"""`/ws/alerts` — owner-scoped attention events.

Why this exists as its own socket: `/ws/browser` is per PTY session and only
opens for a session with a pane on screen, which is exactly the session you do
*not* need telling about. An alert has to arrive for a session nobody is
looking at, so it is scoped to the owner, opened once per tab, and carries
nothing but lifecycle metadata.

Content discipline (see `docs/TRUST.md`): the only session-derived string on
this socket is `command` — the foreground process basename the server already
stores and already returns from `GET /api/sessions`. It is the same documented
exception, not a new one. No terminal bytes, no argv, no cwd, no output.

The transitions themselves are detected at the write site in `ws/daemon.py`,
where the previous value is still in hand, and published here. That is what
makes an alert arrive in about a second instead of on the next poll.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from ..redis import get_backend, user_alert_channel
from ..trust_events import forwardable_trust_frame
from .browser import _resolve_user

router = APIRouter()
log = logging.getLogger("spawn.ws.alerts")

ALERTS_WS_PROTOCOL = "spawn.alerts.v1"
WS_CLOSE_PROTOCOL_REQUIRED = 4003

#: Idle keepalive. Proxies drop a silent WebSocket well before an agent run
#: ends, and a browser that never hears anything cannot tell a quiet link from
#: a dead one. Both problems go away with a periodic frame.
ALERT_KEEPALIVE_SECONDS = 25.0

#: Frame kinds a browser is allowed to see on this socket. Anything else that
#: reaches the channel is dropped rather than forwarded.
ALERT_EVENTS = frozenset({"agent.finished", "agent.awaiting_input", "session.died"})

#: How long an agent must produce nothing before it counts as waiting on you.
#:
#: Held equal to `WAITING_OUTPUT_WINDOW` in `routes/sessions.py`, which is the
#: rule the status dot already uses — so the dot turning "Awaiting input" and
#: the alert arriving are the same event, said twice. `test_ws_alerts.py` pins
#: them together so they cannot drift.
#:
#: This started at 30 s to protect against firing during a thinking pause, and
#: that was the wrong trade: agent turns are frequently shorter than the window
#: itself, so the alert either arrived after the operator had already come back
#: or was cancelled by them typing again — the feature silently did nothing for
#: exactly the workflow it was built for. The protection was also redundant.
#: The daemon only counts output carrying at least three printable characters
#: (`MIN_MEANINGFUL_OUTPUT_CHARS` in `daemon/src/activity.rs`), and agent CLIs
#: animate while they work, so a live spinner keeps resetting this and only a
#: genuine stop runs it down.
ALERT_QUIET_SECONDS = 8.0

_SHELL_COMMANDS = frozenset({"bash", "zsh", "fish", "sh", "dash"})


def is_shell_command(command: str | None) -> bool:
    """True when a reported foreground basename is a shell.

    Mirrors `isShellCommand` in `web/src/lib/sessions.ts`, including the login
    shell's leading "-" (argv[0] is "-zsh"), so the browser and the server
    agree on what "back at a prompt" means.
    """
    if not command:
        return False
    name = command[1:] if command.startswith("-") else command
    return name.lower() in _SHELL_COMMANDS


def is_agent_finish(previous: str | None, current: str | None, status: str) -> bool:
    """Whether a foreground change means "the thing you were waiting on ended".

    Deliberately narrow. Four cases that look like a finish and are not:

    - `status` has left "running". A crash nulls `foreground_command` in the
      same update that writes "exited" (see `session.exit` in `ws/daemon.py`),
      and restart and archive null it too. Those are `session.died`, or they
      are something the user just asked for — never a finish.
    - Nothing was running: a null or shell `previous`.
    - The foreground was handed to another program rather than back to the
      shell. `claude` -> `vim` is not a finish.
    - A worker that predates foreground reporting, which never leaves null.

    A `current` of None is treated as a finish, and safely so: the worker
    skips the report entirely when `foreground_basename` cannot resolve the
    process group (`daemon/src/sessiond/worker.rs`), so a transient lookup
    failure mid-run never reaches here as a null.
    """
    if status != "running":
        return False
    if previous is None or is_shell_command(previous):
        return False
    return current is None or is_shell_command(current)


def agent_finished_payload(session_id: str, command: str) -> dict[str, object]:
    return {
        "type": "alert",
        "event": "agent.finished",
        "session_id": session_id,
        "command": command,
        "at": datetime.now(UTC).isoformat(),
    }


def agent_awaiting_input_payload(session_id: str, command: str) -> dict[str, object]:
    return {
        "type": "alert",
        "event": "agent.awaiting_input",
        "session_id": session_id,
        "command": command,
        "at": datetime.now(UTC).isoformat(),
    }


class QuietWatch:
    """One pending "this agent has gone quiet" timer per session.

    Owned by a daemon connection, because a session is attached to exactly one
    of those and therefore to exactly one server worker — so the timer is
    naturally singular without any cross-worker coordination, and it dies with
    the connection rather than outliving the host it describes.

    Unlike `agent.finished`, this transition has no write to hang off: the
    server derives "waiting" lazily from timestamps whenever someone reads a
    session, so nothing ever *happens* at the moment a session goes quiet.
    A timer, rearmed on every activity ping, is what turns that derived state
    into an event.
    """

    def __init__(
        self,
        on_quiet: Callable[[str], Awaitable[None]],
        *,
        delay: float = ALERT_QUIET_SECONDS,
    ) -> None:
        self._on_quiet = on_quiet
        self._delay = delay
        self._timers: dict[str, asyncio.Task[None]] = {}

    def touch(self, session_id: str) -> None:
        """Activity seen — restart the clock for this session."""
        self.cancel(session_id)
        self._timers[session_id] = asyncio.create_task(self._wait(session_id))

    def cancel(self, session_id: str) -> None:
        timer = self._timers.pop(session_id, None)
        if timer is not None:
            timer.cancel()

    def shutdown(self) -> None:
        for timer in self._timers.values():
            timer.cancel()
        self._timers.clear()

    @property
    def pending(self) -> int:
        return len(self._timers)

    async def _wait(self, session_id: str) -> None:
        try:
            await asyncio.sleep(self._delay)
            await self._on_quiet(session_id)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.warning("quiet watch failed for session %s: %s", session_id, e)
        finally:
            # Only retire the slot if it still holds *this* task. Cancellation
            # is delivered asynchronously, so a timer cancelled by `touch` runs
            # its teardown after the replacement is already registered — and an
            # unguarded pop would evict that replacement, leaving it
            # uncancellable and letting the next touch stack a second timer on
            # the same session. That is a duplicate alert per rearm.
            #
            # Not rearmed here either: staying quiet is one event, not a
            # repeating one. Only fresh activity starts the clock again.
            if self._timers.get(session_id) is asyncio.current_task():
                self._timers.pop(session_id, None)


def session_died_payload(
    session_id: str,
    command: str | None,
    *,
    exit_code: int | None,
    signal: str | None,
) -> dict[str, object]:
    return {
        "type": "alert",
        "event": "session.died",
        "session_id": session_id,
        "command": command,
        "exit_code": exit_code,
        "signal": signal,
        "at": datetime.now(UTC).isoformat(),
    }


def _forwardable(event: object) -> dict[str, object] | None:
    """Whitelist a channel payload before it reaches a browser."""
    if not isinstance(event, dict):
        return None
    if event.get("type") != "alert":
        return None
    if event.get("event") not in ALERT_EVENTS:
        return None
    session_id = event.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        return None
    command = event.get("command")
    if command is not None and (not isinstance(command, str) or len(command) > 64):
        return None
    return event


@router.websocket("/ws/alerts")
async def alerts_ws(websocket: WebSocket, token: str | None = Query(default=None)) -> None:
    offered = websocket.scope.get("subprotocols") or []
    if ALERTS_WS_PROTOCOL not in offered:
        await websocket.accept()
        await websocket.send_json(
            {"type": "protocol.required", "protocol": ALERTS_WS_PROTOCOL, "version": 1}
        )
        await websocket.close(code=WS_CLOSE_PROTOCOL_REQUIRED, reason="protocol upgrade required")
        return
    await websocket.accept(subprotocol=ALERTS_WS_PROTOCOL)
    user = await _resolve_user(websocket, token)
    if user is None:
        return

    # Two producers share the socket, so sends are serialized.
    send_lock = asyncio.Lock()

    async def _send(payload: dict[str, object]) -> None:
        async with send_lock:
            await websocket.send_text(json.dumps(payload, separators=(",", ":")))

    ready = asyncio.Event()

    async def _pump_alerts() -> None:
        try:
            async with get_backend().subscribe_channel(user_alert_channel(user.id)) as stream:
                ready.set()
                async for raw_event in stream:
                    try:
                        event = json.loads(raw_event)
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        continue
                    # Two families share this channel and are validated apart,
                    # so the alert whitelist stays exactly as narrow as it was.
                    forwardable = _forwardable(event) or forwardable_trust_frame(event)
                    if forwardable is None:
                        continue
                    await _send(forwardable)
        except (WebSocketDisconnect, RuntimeError):
            return
        except Exception as e:  # noqa: BLE001
            log.warning("alert subscribe loop crashed: %s", e)
        finally:
            ready.set()

    async def _keepalive() -> None:
        try:
            while True:
                await asyncio.sleep(ALERT_KEEPALIVE_SECONDS)
                await _send({"type": "alerts.ping"})
        except (WebSocketDisconnect, RuntimeError):
            return

    log.info("alert stream attached user=%s", user.id)
    pump_task = asyncio.create_task(_pump_alerts())
    keepalive_task = asyncio.create_task(_keepalive())
    try:
        await asyncio.wait_for(ready.wait(), timeout=1.0)
    except TimeoutError:
        pass

    try:
        # Nothing is expected inbound; receiving is how a disconnect is seen.
        # A client that sends anyway is ignored rather than closed on: this
        # socket has no command surface to protect.
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
            if message.get("bytes") is not None:
                log.warning("binary frame on alert socket; ignoring")
    except WebSocketDisconnect:
        pass
    except Exception as e:  # noqa: BLE001
        log.warning("alert ws crashed: %s", e)
    finally:
        for task in (pump_task, keepalive_task):
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        log.info("alert stream detached user=%s", user.id)
