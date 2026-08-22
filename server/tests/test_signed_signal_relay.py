from __future__ import annotations

import json
from pathlib import Path

import pytest

from spawn_server.ws.host_signal import (
    HostSignalEnvelope,
    RtcSignalDispatch,
    decode_host_signal,
    decode_rtc_signal_dispatch,
    encode_host_signal,
    encode_rtc_signal_dispatch,
)
from spawn_server.ws.signed_signal_relay import (
    MAX_RTC_ROUTING_FRAME_BYTES,
    MAX_RTC_ROUTING_METADATA_BYTES,
    MAX_SIGNED_RTC_RELAY_BYTES,
    SignedRtcRelayError,
    signed_mode_selected,
    validate_signed_relay_container,
    validate_signed_rtc_relay_envelope,
)


def _vector(vector_id: str = "agent-offer") -> dict[str, object]:
    path = Path(__file__).parents[2] / "proto" / "signed-signal-wire-v1-vectors.json"
    for vector in json.loads(path.read_text())["vectors"]:
        if vector["id"] == vector_id:
            return dict(vector["envelope"])
    raise AssertionError(f"missing vector {vector_id}")


def _wire(envelope: dict[str, object]) -> str:
    return json.dumps(envelope, separators=(",", ":"))


def _validate(wire: object):
    return validate_signed_rtc_relay_envelope(
        wire,
        expected_type="rtc.offer",
        expected_session_id="018f0f77-86d2-7a8e-9b1c-1f3b847ca2a1",
        expected_scope_type="agent",
        expected_scope_id="11111111-2222-4333-8444-555555555555",
        expected_protocol="spawn.pty",
        expected_protocol_version=2,
    )


def test_signed_relay_preserves_exact_opaque_wire_and_does_not_verify_signature():
    envelope = _vector()
    # These substitutions remain structurally canonical. A relay must carry
    # them byte-for-byte so the independently pinned endpoint, not the server,
    # makes the signature/key decision.
    sender = envelope["sender_identity_public_key"]
    peer = envelope["intended_peer_identity_public_key"]
    envelope["sender_identity_public_key"] = peer
    envelope["intended_peer_identity_public_key"] = sender
    signature = str(envelope["signature"])
    envelope["signature"] = ("A" if signature[0] != "A" else "B") + signature[1:]
    wire = " \n" + _wire(envelope) + "\t"

    accepted = _validate(wire)

    assert accepted.wire == wire
    assert accepted.session_id == envelope["session_id"]


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("type", "rtc.answer"),
        ("signature_algorithm", "Ed25519"),
        ("sender_identity_public_key", "A" * 43),
        ("intended_peer_identity_public_key", "short"),
        ("protocol", "spawn.host.ctl"),
        ("protocol_version", 1),
        ("protocol_version", True),
        ("protocol_version", 2.5),
        ("session_id", "018F0F77-86D2-7A8E-9B1C-1F3B847CA2A1"),
        ("scope_type", "host"),
        ("scope_id", "11111111222243338444555555555555"),
        ("sender_role", "daemon"),
        ("sdp", ""),
        ("signature", "A" * 85),
    ],
)
def test_signed_relay_rejects_malformed_or_route_substituted_fields(field: str, value: object):
    envelope = _vector()
    envelope[field] = value
    with pytest.raises(SignedRtcRelayError):
        _validate(_wire(envelope))


@pytest.mark.parametrize(
    "field",
    [
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
    ],
)
def test_signed_relay_rejects_every_missing_field(field: str):
    envelope = _vector()
    envelope.pop(field)
    with pytest.raises(SignedRtcRelayError):
        _validate(_wire(envelope))


def test_signed_relay_rejects_unknown_duplicate_and_parser_differential_shapes():
    envelope = _vector()
    unknown = {**envelope, "server_fingerprint": "substitute"}
    with pytest.raises(SignedRtcRelayError):
        _validate(_wire(unknown))

    valid = _wire(envelope)
    duplicate = valid.replace(
        '"type":"rtc.offer"',
        '"type":"rtc.answer","type":"rtc.offer"',
        1,
    )
    with pytest.raises(SignedRtcRelayError, match="duplicate"):
        _validate(duplicate)

    with pytest.raises(SignedRtcRelayError):
        _validate(valid.replace('"protocol_version":2', '"protocol_version":NaN'))
    with pytest.raises(SignedRtcRelayError):
        _validate(
            valid.replace(
                '"protocol_version":2',
                '"protocol_version":' + ("9" * 5000),
            )
        )


def test_signed_relay_enforces_exact_live_byte_bound():
    envelope = _vector()
    envelope["sdp"] = ""
    empty_wire = _wire(envelope)
    envelope["sdp"] = "a" * (MAX_SIGNED_RTC_RELAY_BYTES - len(empty_wire.encode()))
    exact = _wire(envelope)
    assert len(exact.encode()) == MAX_SIGNED_RTC_RELAY_BYTES
    assert _validate(exact).wire == exact

    envelope["sdp"] = str(envelope["sdp"]) + "a"
    with pytest.raises(SignedRtcRelayError, match="live relay bound"):
        _validate(_wire(envelope))


def test_nested_bound_and_routing_allowance_fit_the_live_frame_limit():
    # Backslashes are the worst ASCII case when the opaque JSON text is nested
    # as a JSON string: every byte doubles. Production serializers explicitly
    # retain UTF-8 rather than expanding non-ASCII to six-byte escapes.
    signal = {
        "type": "rtc.offer",
        "signed_envelope": "\\" * MAX_SIGNED_RTC_RELAY_BYTES,
        "padding": "a" * (MAX_RTC_ROUTING_METADATA_BYTES - 64),
    }
    validate_signed_relay_container(signal)
    nested = json.dumps(signal, separators=(",", ":"), ensure_ascii=False).encode()
    assert len(nested) <= MAX_RTC_ROUTING_FRAME_BYTES

    signal["padding"] = str(signal["padding"]) + ("b" * 128)
    with pytest.raises(SignedRtcRelayError, match="routing metadata"):
        validate_signed_relay_container(signal)

    with pytest.raises(SignedRtcRelayError, match="frame type"):
        validate_signed_relay_container(
            {"type": "rtc.candidate", "signed_envelope": "{}"}
        )


@pytest.mark.parametrize(
    "frame",
    [
        {"type": "rtc.offer", "signed_envelope": None},
        {
            "type": "rtc.offer",
            "signed_envelope": None,
            "sdp": "v=0\r\nraw downgrade",
        },
        {"type": "rtc.answer", "signed_envelope": {"unknown": True}},
        {"type": "rtc.answer", "signed_envelope": ["wire"]},
    ],
)
def test_present_non_string_signed_field_never_falls_through_to_legacy(frame):
    assert signed_mode_selected(frame)
    with pytest.raises(SignedRtcRelayError):
        validate_signed_relay_container(frame)


def test_absent_signed_field_remains_legacy_at_server_container_boundary():
    frame = {"type": "rtc.offer", "sdp": "v=0\r\n"}
    assert not signed_mode_selected(frame)
    validate_signed_relay_container(frame)


def test_redis_offer_and_answer_wrappers_preserve_exact_unicode_and_escapes():
    envelope = _vector()
    envelope["sdp"] = "v=0\r\na=x-unicode:\u0080\\quoted\"\r\n"
    wire = " \n" + _wire(envelope) + "\t"
    signal = {
        "type": "rtc.offer",
        "session_id": envelope["session_id"],
        "agent_id": envelope["scope_id"],
        "binding_nonce": "b" * 32,
        "binding_generation": 7,
        "scope_type": "agent",
        "scope_id": envelope["scope_id"],
        "protocol": "spawn.pty",
        "protocol_version": 2,
        "signed_envelope": wire,
    }
    host_wrapped = HostSignalEnvelope("a" * 32, 7, f"spawn:rtc:browser:{'c' * 32}", signal)
    decoded_host = decode_host_signal(encode_host_signal(host_wrapped))
    assert decoded_host is not None
    assert decoded_host.signal["signed_envelope"] == wire

    dispatch = RtcSignalDispatch(
        "host-id",
        "a" * 32,
        7,
        "b" * 32,
        "a" * 32,
        7,
        signal,
    )
    decoded_dispatch = decode_rtc_signal_dispatch(encode_rtc_signal_dispatch(dispatch))
    assert decoded_dispatch is not None
    assert decoded_dispatch.signal["signed_envelope"] == wire


# ---------------------------------------------------------------------------
# Carried endorsements (hardening B4): sanitizer alphabet + worst-case fit.
# ---------------------------------------------------------------------------

from spawn_server.ws.signed_signal_relay import (  # noqa: E402
    _WORST_CARRIED_ENDORSEMENTS_BYTES,
    CARRIED_ENDORSEMENTS_FIELD,
    MAX_RELAYED_ENDORSEMENTS,
    sanitize_carried_endorsements,
)


def _edge(**overrides: str) -> dict[str, str]:
    edge = {
        "account_id": "018f0f77-86d2-7a8e-9b1c-1f3b847ca2a1",
        "endorser_public_key": "A" * 43,
        "endorsed_public_key": "B" * 43,
        "endorsed_device_id": "11111111-2222-4333-8444-555555555555",
        "signature": "C" * 86,
    }
    edge.update(overrides)
    return edge


def test_sanitize_accepts_realistic_edges_and_bounds_count():
    edges = [_edge() for _ in range(MAX_RELAYED_ENDORSEMENTS)]
    assert sanitize_carried_endorsements(edges) == edges
    assert sanitize_carried_endorsements(edges + [_edge()]) is None
    assert sanitize_carried_endorsements([]) is None
    assert sanitize_carried_endorsements("edges") is None
    assert sanitize_carried_endorsements([_edge(), "edge"]) is None


def test_sanitize_rejects_fields_outside_the_token_alphabet():
    # The token alphabet is what makes the fit arithmetic honest: any character
    # that JSON-escapes or encodes to more than one UTF-8 byte must be refused.
    for bad in ['"', "\\", "\n", " ", "é", "\U0001f600", "a b", "="]:
        assert sanitize_carried_endorsements([_edge(signature="C" * 10 + bad)]) is None
    assert sanitize_carried_endorsements([_edge(signature="")]) is None
    assert sanitize_carried_endorsements([_edge(signature="C" * 129)]) is None
    assert sanitize_carried_endorsements([_edge(signature=42)]) is None  # type: ignore[arg-type]
    missing = _edge()
    del missing["signature"]
    assert sanitize_carried_endorsements([missing]) is None


def test_worst_case_carried_endorsements_arithmetic_is_exact_and_fits():
    # Build the literal worst case the sanitizer can accept and measure it the
    # way validate_signed_relay_container does. The module-load constant must
    # be EXACTLY that measurement -- an overclaim wastes budget, an underclaim
    # voids the fit proof.
    worst_edges = [
        {
            "account_id": "a" * 128,
            "endorser_public_key": "b" * 128,
            "endorsed_public_key": "c" * 128,
            "endorsed_device_id": "d" * 128,
            "signature": "e" * 128,
        }
        for _ in range(MAX_RELAYED_ENDORSEMENTS)
    ]
    assert sanitize_carried_endorsements(worst_edges) == worst_edges
    serialized = json.dumps(
        {CARRIED_ENDORSEMENTS_FIELD: worst_edges},
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    # The container serializes the whole routing dict; the module constant
    # counts this field's contribution inside a larger object, i.e. a leading
    # comma instead of the surrounding braces.
    field_contribution = len(serialized) - 2 + 1
    assert field_contribution == _WORST_CARRIED_ENDORSEMENTS_BYTES
    assert _WORST_CARRIED_ENDORSEMENTS_BYTES + 8 * 1024 <= MAX_RTC_ROUTING_METADATA_BYTES


def test_container_bound_admits_a_maximal_sanitized_offer():
    envelope = _vector()
    worst_edges = [
        {
            "account_id": "a" * 128,
            "endorser_public_key": "b" * 128,
            "endorsed_public_key": "c" * 128,
            "endorsed_device_id": "d" * 128,
            "signature": "e" * 128,
        }
        for _ in range(MAX_RELAYED_ENDORSEMENTS)
    ]
    frame = {
        "type": "rtc.offer",
        "session_id": envelope["session_id"],
        "agent_id": envelope["scope_id"],
        "binding_nonce": "b" * 32,
        "binding_generation": 7,
        "scope_type": "agent",
        "scope_id": envelope["scope_id"],
        "protocol": "spawn.pty",
        "protocol_version": 2,
        "signed_envelope": _wire(envelope),
        CARRIED_ENDORSEMENTS_FIELD: worst_edges,
    }
    assert sanitize_carried_endorsements(worst_edges) == worst_edges
    # Must not raise: the maximal sanitizer-accepted set fits the container
    # bound with room for the rest of the routing metadata.
    validate_signed_relay_container(frame)
