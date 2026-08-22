"""Untrusted structural checks for opaque signed RTC relay envelopes.

The server never verifies a signature or supplies a key pin.  It only rejects
shapes that the endpoint wire adapters cannot possibly accept, checks that the
signed routing tuple is the tuple selected by the outer authorized route, and
returns the original string for forwarding.  Endpoint verification remains
mandatory before any SDP is consumed.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException

from ..browser_registration import decode_ed25519_signature
from ..host_identity import decode_ed25519_public_key

# A signed envelope is nested as a JSON string in a routing frame.  JSON string
# escaping can double every input byte, so 512 KiB plus 64 KiB of routing
# allowance remains below both the 1,100 KiB WebSocket-frame limit and the
# 1,200 KiB Redis dispatch limit used by all live RTC routes.
MAX_SIGNED_RTC_RELAY_BYTES = 512 * 1024
MAX_RTC_ROUTING_FRAME_BYTES = 1100 * 1024
MAX_RTC_ROUTING_METADATA_BYTES = 64 * 1024
MAX_SIGNED_RTC_SDP_BYTES = 1024 * 1024
if (
    2 * MAX_SIGNED_RTC_RELAY_BYTES + MAX_RTC_ROUTING_METADATA_BYTES + 12 * 1024
    > MAX_RTC_ROUTING_FRAME_BYTES
):
    raise RuntimeError("signed RTC relay bounds do not fit the routing frame")

SIGNED_ENVELOPE_FIELD = "signed_envelope"

# A device carries its account endorsement edge-set on an offer so a daemon can
# admit it via a chain to an anchor (device mesh §3). The server relays these
# opaquely — the daemon re-verifies every signature and finds the chain — and
# only bounds the shape so a hostile client cannot inflate a routing frame. The
# path a daemon accepts is short, but the carried SET is the account's edges, so
# the cap is generous.
CARRIED_ENDORSEMENTS_FIELD = "carried_endorsements"
MAX_RELAYED_ENDORSEMENTS = 64
_ENDORSEMENT_KEYS = (
    "account_id",
    "endorser_public_key",
    "endorsed_public_key",
    "endorsed_device_id",
    "signature",
)
_MAX_ENDORSEMENT_FIELD_LEN = 128
# Every legitimate field value is a canonical UUID, base64url key, or base64url
# signature, so this token alphabet loses nothing — and it is what makes the
# worst-case arithmetic below honest: each accepted character is exactly one
# UTF-8 byte and never JSON-escaped (json.dumps with ensure_ascii=False), so
# serialized bytes == character count. Without it a 128-char field of control
# characters would serialize as up to 6 bytes each and the fit proof would be
# false.
_ENDORSEMENT_FIELD_TOKEN = re.compile(rf"\A[0-9A-Za-z_-]{{1,{_MAX_ENDORSEMENT_FIELD_LEN}}}\Z")

# Compile-time fit proof (hardening B4), mirroring the frame-bound RuntimeError
# above: a maximal sanitizer-accepted endorsement set must fit the routing
# metadata bound enforced downstream at validate_signed_relay_container,
# otherwise the largest LEGITIMATE chain-carrying offer would be silently
# droppable at the container boundary. Exact worst-case serialized-JSON bytes
# (compact separators, ensure_ascii=False, token-alphabet values):
#   per field: "key":"value"  -> len(key) + 3 punctuation + value + 2 quotes
#   per edge:  {} + 4 commas + the 5 fields
#   list:      [] + (n-1) commas + n edges
#   container: ,"carried_endorsements": -> len(field name) + 4 punctuation
_WORST_ENDORSEMENT_EDGE_BYTES = (
    2  # braces
    + (len(_ENDORSEMENT_KEYS) - 1)  # commas between fields
    + sum(len(key) + 3 + 2 + _MAX_ENDORSEMENT_FIELD_LEN for key in _ENDORSEMENT_KEYS)
)
_WORST_CARRIED_ENDORSEMENTS_BYTES = (
    len(CARRIED_ENDORSEMENTS_FIELD) + 4  # ,"carried_endorsements":
    + 2  # brackets
    + (MAX_RELAYED_ENDORSEMENTS - 1)  # commas between edges
    + MAX_RELAYED_ENDORSEMENTS * _WORST_ENDORSEMENT_EDGE_BYTES
)
# 8 KiB allowance for everything else in the routing frame (type, UUIDs,
# nonces, protocol tuple, and the TURN ice_servers block with credentials).
if _WORST_CARRIED_ENDORSEMENTS_BYTES + 8 * 1024 > MAX_RTC_ROUTING_METADATA_BYTES:
    raise RuntimeError("carried endorsements cannot fit the RTC routing metadata bound")


def sanitize_carried_endorsements(value: Any) -> list[dict[str, str]] | None:
    """Structural check only — never a signature or key check. Returns the edge
    list to relay, or None if the shape is unusable (then the relay omits the
    field and the daemon falls back to its directly-pinned keys)."""

    if not isinstance(value, list) or not value or len(value) > MAX_RELAYED_ENDORSEMENTS:
        return None
    sanitized: list[dict[str, str]] = []
    for item in value:
        if not isinstance(item, dict):
            return None
        edge: dict[str, str] = {}
        for key in _ENDORSEMENT_KEYS:
            field = item.get(key)
            if not isinstance(field, str) or _ENDORSEMENT_FIELD_TOKEN.fullmatch(field) is None:
                return None
            edge[key] = field
        sanitized.append(edge)
    return sanitized


_CANONICAL_UUID = re.compile(r"\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
_FIELDS = frozenset(
    {
        "type",
        "signature_algorithm",
        "sender_identity_public_key",
        "intended_peer_identity_public_key",
        "protocol",
        "protocol_version",
        "session_id",
        "scope_type",
        "scope_id",
        "sender_role",
        "sdp",
        "signature",
    }
)


class SignedRtcRelayError(ValueError):
    """The opaque value cannot be safely carried as a signed RTC envelope."""


@dataclass(frozen=True)
class SignedRtcRelayEnvelope:
    """Untrusted routing metadata parsed without changing ``wire``."""

    wire: str
    signal_type: str
    protocol: str
    protocol_version: int
    session_id: str
    scope_type: str
    scope_id: str


def _reject_constant(value: str) -> Any:
    raise SignedRtcRelayError(f"non-JSON numeric constant {value}")


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise SignedRtcRelayError("duplicate signed RTC envelope field")
        value[key] = item
    return value


def _utf8_length(value: str, field: str) -> int:
    try:
        return len(value.encode("utf-8", errors="strict"))
    except UnicodeEncodeError as exc:
        raise SignedRtcRelayError(f"{field} is not strict UTF-8") from exc


def _strict_key(value: object, field: str) -> None:
    if not isinstance(value, str):
        raise SignedRtcRelayError(f"{field} must be a string")
    try:
        decode_ed25519_public_key(value)
    except HTTPException as exc:
        raise SignedRtcRelayError(f"{field} is not a canonical Ed25519 key") from exc


def _strict_signature(value: object) -> None:
    if not isinstance(value, str):
        raise SignedRtcRelayError("signature must be a string")
    try:
        decode_ed25519_signature(value)
    except HTTPException as exc:
        raise SignedRtcRelayError("signature is not canonical Ed25519 wire data") from exc


def validate_signed_rtc_relay_envelope(
    wire: object,
    *,
    expected_type: str,
    expected_session_id: str,
    expected_scope_type: str,
    expected_scope_id: str,
    expected_protocol: str,
    expected_protocol_version: int,
) -> SignedRtcRelayEnvelope:
    """Validate an opaque envelope's shape and exact authorized routing tuple.

    This deliberately does not verify ``signature`` and does not return SDP.
    Callers must forward ``result.wire`` unchanged; only an endpoint verifier
    may turn its contents into a trusted signal.
    """

    if not isinstance(wire, str):
        raise SignedRtcRelayError("signed RTC envelope must be a string")
    if _utf8_length(wire, "signed RTC envelope") > MAX_SIGNED_RTC_RELAY_BYTES:
        raise SignedRtcRelayError("signed RTC envelope exceeds its live relay bound")
    try:
        value = json.loads(
            wire,
            object_pairs_hook=_unique_object,
            parse_constant=_reject_constant,
        )
    except SignedRtcRelayError:
        raise
    except (json.JSONDecodeError, OverflowError, RecursionError, ValueError) as exc:
        raise SignedRtcRelayError("invalid signed RTC envelope JSON") from exc
    if not isinstance(value, dict) or set(value) != _FIELDS:
        raise SignedRtcRelayError("signed RTC envelope fields are not exact")

    for field in _FIELDS - {"protocol_version"}:
        if not isinstance(value[field], str):
            raise SignedRtcRelayError(f"{field} must be a string")
    protocol_version = value["protocol_version"]
    valid_protocol_version = False
    if not isinstance(protocol_version, bool):
        if isinstance(protocol_version, int):
            valid_protocol_version = 1 <= protocol_version <= 0xFFFF_FFFF
        elif isinstance(protocol_version, float):
            valid_protocol_version = (
                math.isfinite(protocol_version)
                and protocol_version.is_integer()
                and 1 <= protocol_version <= 0xFFFF_FFFF
            )
    if not valid_protocol_version:
        raise SignedRtcRelayError("protocol_version is not an accepted integer")
    protocol_version = int(protocol_version)

    if value["signature_algorithm"] != "ed25519":
        raise SignedRtcRelayError("unsupported signed RTC algorithm")
    if value["type"] not in {"rtc.offer", "rtc.answer"}:
        raise SignedRtcRelayError("invalid signed RTC signal type")
    if value["sender_role"] not in {"browser", "daemon"}:
        raise SignedRtcRelayError("invalid signed RTC sender role")
    if (value["type"], value["sender_role"]) not in {
        ("rtc.offer", "browser"),
        ("rtc.answer", "daemon"),
    }:
        raise SignedRtcRelayError("signed RTC type does not match sender role")
    if value["scope_type"] not in {"agent", "host"}:
        raise SignedRtcRelayError("invalid signed RTC scope type")
    if value["protocol"] not in {"spawn.pty", "spawn.host.ctl"}:
        raise SignedRtcRelayError("invalid signed RTC protocol")
    expected_topology = {
        "agent": ("spawn.pty", 2),
        "host": ("spawn.host.ctl", 1),
    }[value["scope_type"]]
    if (value["protocol"], protocol_version) != expected_topology:
        raise SignedRtcRelayError("signed RTC protocol topology is inconsistent")

    for field in ("session_id", "scope_id"):
        if not _CANONICAL_UUID.fullmatch(value[field]):
            raise SignedRtcRelayError(f"{field} is not a canonical UUID")
    sdp = value["sdp"]
    sdp_bytes = _utf8_length(sdp, "sdp")
    if sdp_bytes < 1 or sdp_bytes > MAX_SIGNED_RTC_SDP_BYTES:
        raise SignedRtcRelayError("signed RTC SDP length is invalid")
    _strict_key(value["sender_identity_public_key"], "sender_identity_public_key")
    _strict_key(
        value["intended_peer_identity_public_key"],
        "intended_peer_identity_public_key",
    )
    _strict_signature(value["signature"])

    expected = (
        expected_type,
        expected_protocol,
        expected_protocol_version,
        expected_session_id,
        expected_scope_type,
        expected_scope_id,
    )
    actual = (
        value["type"],
        value["protocol"],
        protocol_version,
        value["session_id"],
        value["scope_type"],
        value["scope_id"],
    )
    if actual != expected:
        raise SignedRtcRelayError("signed RTC envelope does not match its authorized route")

    return SignedRtcRelayEnvelope(
        wire=wire,
        signal_type=value["type"],
        protocol=value["protocol"],
        protocol_version=protocol_version,
        session_id=value["session_id"],
        scope_type=value["scope_type"],
        scope_id=value["scope_id"],
    )


def signed_mode_selected(frame: dict[str, Any]) -> bool:
    """Presence selects signed mode even when the value is malformed."""

    return SIGNED_ENVELOPE_FIELD in frame


def reject_raw_sdp_in_signed_mode(frame: dict[str, Any]) -> None:
    """Prevent a malformed signed signal from falling through to raw SDP."""

    if "sdp" in frame:
        raise SignedRtcRelayError("signed RTC frames must not carry raw SDP")


def validate_signed_relay_container(frame: dict[str, Any]) -> None:
    """Apply the mode and byte bound at an outer WS/Redis container boundary."""

    if not signed_mode_selected(frame):
        return
    if frame.get("type") not in {"rtc.offer", "rtc.answer"}:
        raise SignedRtcRelayError("signed RTC envelope is invalid on this frame type")
    reject_raw_sdp_in_signed_mode(frame)
    wire = frame[SIGNED_ENVELOPE_FIELD]
    if not isinstance(wire, str):
        raise SignedRtcRelayError("signed RTC envelope must be a string")
    if _utf8_length(wire, "signed RTC envelope") > MAX_SIGNED_RTC_RELAY_BYTES:
        raise SignedRtcRelayError("signed RTC envelope exceeds its live relay bound")
    routing = {key: value for key, value in frame.items() if key != SIGNED_ENVELOPE_FIELD}
    try:
        routing_bytes = len(
            json.dumps(routing, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        )
    except (TypeError, UnicodeEncodeError, ValueError) as exc:
        raise SignedRtcRelayError("invalid signed RTC routing metadata") from exc
    if routing_bytes > MAX_RTC_ROUTING_METADATA_BYTES:
        raise SignedRtcRelayError("signed RTC routing metadata exceeds its live bound")
