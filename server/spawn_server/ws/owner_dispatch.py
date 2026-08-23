"""Generation-bound distributed result dispatch for daemon request/reply paths."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from ..limits import MAX_SAFE_FENCING_GENERATION
from ..redis import get_backend
from .host_signal import (
    HostPresenceOwner,
    encode_host_presence_owner,
    host_pending_presence_key,
    host_presence_key,
    valid_daemon_connection_id,
)

MAX_OWNER_RESULT_ENVELOPE_BYTES = 96 * 1024 * 1024
OWNER_RESULT_KINDS = frozenset(
    {
        "host.pong",
        "host.agents.check_result",
        "host.agents.install_result",
    }
)


@dataclass(frozen=True)
class OwnerResultEnvelope:
    host_id: str
    daemon_connection_id: str
    daemon_generation: int
    kind: str
    request_id: str
    payload: dict[str, Any]


def owner_result_channel(host_id: str, kind: str, request_id: str) -> str:
    if not host_id or len(host_id) > 128:
        raise ValueError("invalid result host id")
    if kind not in OWNER_RESULT_KINDS:
        raise ValueError("invalid result kind")
    if not request_id or len(request_id) > 128:
        raise ValueError("invalid result request id")
    return f"spawn:host-result:{host_id}:{kind}:{request_id}"


def encode_owner_result(envelope: OwnerResultEnvelope) -> bytes:
    payload = json.dumps(
        {
            "host_id": envelope.host_id,
            "daemon_connection_id": envelope.daemon_connection_id,
            "daemon_generation": envelope.daemon_generation,
            "kind": envelope.kind,
            "request_id": envelope.request_id,
            "payload": envelope.payload,
        },
        separators=(",", ":"),
    ).encode()
    if len(payload) > MAX_OWNER_RESULT_ENVELOPE_BYTES:
        raise ValueError("owner result envelope is too large")
    return payload


def decode_owner_result(payload: bytes) -> OwnerResultEnvelope | None:
    if not payload or len(payload) > MAX_OWNER_RESULT_ENVELOPE_BYTES:
        return None
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict):
        return None
    host_id = value.get("host_id")
    connection_id = value.get("daemon_connection_id")
    generation = value.get("daemon_generation")
    kind = value.get("kind")
    request_id = value.get("request_id")
    result = value.get("payload")
    if (
        not isinstance(host_id, str)
        or not host_id
        or len(host_id) > 128
        or not isinstance(connection_id, str)
        or not valid_daemon_connection_id(connection_id)
        or not isinstance(generation, int)
        or isinstance(generation, bool)
        or generation < 1
        or generation > MAX_SAFE_FENCING_GENERATION
        or not isinstance(kind, str)
        or kind not in OWNER_RESULT_KINDS
        or not isinstance(request_id, str)
        or not request_id
        or len(request_id) > 128
        or not isinstance(result, dict)
    ):
        return None
    return OwnerResultEnvelope(host_id, connection_id, generation, kind, request_id, result)


async def publish_owner_result(envelope: OwnerResultEnvelope) -> bool:
    owner = HostPresenceOwner(
        envelope.daemon_connection_id,
        envelope.daemon_generation,
    )
    return await get_backend().publish_if_host_owner(
        host_presence_key(envelope.host_id),
        host_pending_presence_key(envelope.host_id),
        encode_host_presence_owner(owner),
        generation=envelope.daemon_generation,
        channel=owner_result_channel(envelope.host_id, envelope.kind, envelope.request_id),
        payload=encode_owner_result(envelope),
    )
