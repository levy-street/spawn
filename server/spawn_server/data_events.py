"""Owner-scoped data-change events, published onto the alert channel.

The third frame family on `/ws/alerts`, and the reason every open client shows
the same account at the same moment: a tab added on the phone, a workspace
renamed in a browser, a session started from another machine. The frame says
*what kind of thing* changed — never what it changed to — and the client
re-reads the resource it already knows how to fetch. That inherits the alert
socket's delivery contract wholesale: fire-and-forget, no replay, no sequence
numbers. The durable row is what makes a client correct; this frame is only
what makes it immediate.

Two producers:

- `DataEventMiddleware`, a pure ASGI response hook (the shape
  `SessionRenewalMiddleware` argues for in `main.py`): every 2xx mutating
  request under `/api/` whose first path segment names a client-visible
  resource publishes one frame for it. Mechanical on purpose — a new route
  under an existing resource is covered the day it lands, and a hand-wired
  publish per endpoint is exactly the kind of list that drifts.
- The daemon socket, for the writes that never ride HTTP: a session started
  or ended on the host itself, and a host's presence flipping. Those call
  [`publish_data_changed`] directly from `ws/daemon.py`.

The `origin` field carries the mutating client's self-chosen id (the
`X-Spawn-Client` header) back out to every listener, so the client that made
the change can recognise its own echo and skip a refetch it would race — an
optimistic layout write mid-drag must not fight its own broadcast. It is
advisory display-and-routing data in the `PushDevice.browser_device_id`
tradition: it decides who may *skip* work, never who is admitted to anything.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime

from .redis import get_backend, user_alert_channel

log = logging.getLogger("spawn.data.events")

DATA_FRAME_TYPE = "data"

#: First `/api/` path segments whose successful mutations fan out, and the
#: resource name a frame carries for each. Everything absent is deliberate:
#: auth and account recovery are ceremonies rather than data, admin and
#: install and release feed no client cache, and the trust cluster already
#: broadcasts richer frames of its own (`trust_events.py`) beside polls fast
#: enough to make a second family for it noise.
RESOURCES: dict[str, str] = {
    "workspaces": "workspaces",
    "workspace-templates": "workspace-templates",
    "sessions": "sessions",
    "hosts": "hosts",
    "agents": "agents",
    "profile": "profile",
}

_MUTATING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
_MAX_FIELD_LENGTH = 64

#: The header a client stamps its mutations with; echoed as `origin`.
CLIENT_HEADER = b"x-spawn-client"


def data_changed_payload(
    resource: str,
    resource_id: str | None,
    origin: str | None,
) -> dict[str, object]:
    return {
        "type": DATA_FRAME_TYPE,
        "resource": resource,
        "id": resource_id,
        "origin": origin,
        "at": datetime.now(UTC).isoformat(),
    }


async def publish_data_changed(
    user_id: str,
    resource: str,
    resource_id: str | None = None,
    origin: str | None = None,
) -> None:
    """Best effort, like every frame on this channel. A lost one costs a
    client its immediacy, not its correctness — the next poll or focus
    refetch reads the same row."""
    payload = data_changed_payload(resource, resource_id, origin)
    try:
        await get_backend().publish_channel(
            user_alert_channel(user_id),
            json.dumps(payload, separators=(",", ":")).encode(),
        )
    except Exception as e:  # noqa: BLE001
        log.warning("data event publish failed: %s", e)


def _bounded(value: object) -> str | None:
    if isinstance(value, str) and 0 < len(value) <= _MAX_FIELD_LENGTH:
        return value
    return None


def forwardable_data_frame(event: object) -> dict[str, object] | None:
    """Whitelist a channel payload before it reaches a browser.

    The boundary the alert socket commits to: ids and kind only. A frame is
    rebuilt field by field rather than passed through, so nothing a publisher
    smuggled beside the known keys ever reaches a client.
    """
    if not isinstance(event, dict):
        return None
    if event.get("type") != DATA_FRAME_TYPE:
        return None
    resource = event.get("resource")
    if resource not in RESOURCES.values():
        return None
    resource_id = event.get("id")
    if resource_id is not None and _bounded(resource_id) is None:
        return None
    origin = event.get("origin")
    if origin is not None and _bounded(origin) is None:
        return None
    at = event.get("at")
    if not isinstance(at, str):
        return None
    return {
        "type": DATA_FRAME_TYPE,
        "resource": resource,
        "id": resource_id,
        "origin": origin,
        "at": at,
    }


def resource_for_request(method: str, path: str) -> tuple[str, str | None] | None:
    """The resource a request would change, or None when none does.

    `/api/workspaces/<id>/archive` names `workspaces` and carries the id;
    a collection call carries none. The second segment is advisory — an
    action verb in that position invalidates a detail key nobody holds,
    which costs nothing.
    """
    if method not in _MUTATING_METHODS:
        return None
    parts = [part for part in path.split("/") if part]
    if len(parts) < 2 or parts[0] != "api":
        return None
    resource = RESOURCES.get(parts[1])
    if resource is None:
        return None
    resource_id = _bounded(parts[2]) if len(parts) > 2 else None
    return resource, resource_id


#: Strong references to in-flight publishes, for the same reason
#: `ws/daemon.py` keeps them for pushes: the loop alone holds only a weak one.
_publish_tasks: set[asyncio.Task[None]] = set()


class DataEventMiddleware:
    """Publish one data-changed frame per successful mutating request.

    A pure ASGI hook for the reasons `SessionRenewalMiddleware` gives: no
    task hop, no interference with streaming bodies, WebSocket scopes pass
    straight through. The user id comes from `request.state`, where
    `auth.current_user` leaves it — a request that never authenticated leaves
    nothing and publishes nothing. The publish itself is scheduled, not
    awaited: it must never hold a response open.
    """

    def __init__(self, app) -> None:  # noqa: ANN001 - ASGI app protocol
        self.app = app

    async def __call__(self, scope, receive, send) -> None:  # noqa: ANN001
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        target = resource_for_request(scope.get("method", ""), scope.get("path", ""))
        if target is None:
            await self.app(scope, receive, send)
            return
        resource, resource_id = target
        origin: str | None = None
        for name, value in scope.get("headers", []):
            if name == CLIENT_HEADER:
                origin = _bounded(value.decode("latin-1"))
                break

        async def send_and_publish(message) -> None:  # noqa: ANN001
            if message["type"] == "http.response.start" and 200 <= message["status"] < 300:
                state = scope.get("state")
                user_id = state.get("data_event_user_id") if isinstance(state, dict) else None
                if isinstance(user_id, str):
                    task = asyncio.create_task(
                        publish_data_changed(user_id, resource, resource_id, origin)
                    )
                    _publish_tasks.add(task)
                    task.add_done_callback(_publish_tasks.discard)
            await send(message)

        await self.app(scope, receive, send_and_publish)
