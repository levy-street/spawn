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
