//! Regenerate `proto/signed-signal-v1-vectors.json` and
//! `proto/signed-signal-wire-v1-vectors.json` with the daemon's production
//! signed-signal implementation.
//!
//! The vectors are deterministic: the only secret material is the RFC 8032
//! section 7.1 test seeds (vector 1 signs, vector 2 is the intended peer).
//! Rerun after any transcript or envelope revision — for example the
//! `TRANSCRIPT_VERSION` bump that renamed scope type 1 `agent` → `session`:
//!
//! ```text
//! cargo run --example generate_signed_signal_vectors
//! ```

use ed25519_dalek::SigningKey;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use spawnd::signed_signal::{
    public_key_to_wire, sign_transcript, sign_transcript_wire, signature_to_wire, ScopeType,
    SenderRole, SignalKind, SignedSignalTranscript,
};
use spawnd::signed_signal_wire::{sign_rtc_signal_wire, RtcProtocol};

const KEY_MATERIAL_SOURCE: &str = "RFC 8032 section 7.1 test vectors 1 and 2; test use only";
const SIGNING_SEED_HEX: &str = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const PEER_SEED_HEX: &str = "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb";

const SESSION_OFFER_SIGNAL_ID: &str = "018f0f77-86d2-7a8e-9b1c-1f3b847ca2a1";
const HOST_ANSWER_SIGNAL_ID: &str = "018f0f77-86d2-7a8e-9b1c-1f3b847ca2b2";
const SESSION_SCOPE_ID: &str = "11111111-2222-4333-8444-555555555555";
const HOST_SCOPE_ID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SESSION_SDP: &str =
    "v=0\r\no=- 461173305954868531 2 IN IP4 127.0.0.1\r\ns=spawn-session\r\nt=0 0\r\na=setup:actpass\r\n";
const HOST_SDP: &str =
    "v=0\r\no=- 461173305954868532 2 IN IP4 127.0.0.1\r\ns=spawn-host\r\nt=0 0\r\na=setup:active\r\n";

fn hex(value: impl AsRef<[u8]>) -> String {
    value
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn unhex(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

struct VectorSpec {
    id: &'static str,
    replay_signature_from: &'static str,
    kind: SignalKind,
    protocol: RtcProtocol,
    protocol_version: u32,
    signal_id: &'static str,
    scope_type: ScopeType,
    scope_id: &'static str,
    sender_role: SenderRole,
    sdp: &'static str,
}

fn transcript(spec: &VectorSpec, peer: [u8; 32]) -> SignedSignalTranscript {
    SignedSignalTranscript::new(
        spec.kind,
        spec.protocol_version,
        spec.signal_id,
        spec.scope_type,
        spec.scope_id,
        spec.sender_role,
        peer,
        spec.sdp,
    )
    .expect("golden transcript")
}

fn scope_type_str(value: ScopeType) -> &'static str {
    match value {
        ScopeType::Session => "session",
        ScopeType::Host => "host",
    }
}

fn signal_kind_str(value: SignalKind) -> &'static str {
    match value {
        SignalKind::Offer => "offer",
        SignalKind::Answer => "answer",
    }
}

fn sender_role_str(value: SenderRole) -> &'static str {
    match value {
        SenderRole::Browser => "browser",
        SenderRole::Daemon => "daemon",
    }
}

fn signal_type_str(value: SignalKind) -> &'static str {
    match value {
        SignalKind::Offer => "rtc.offer",
        SignalKind::Answer => "rtc.answer",
    }
}

fn main() {
    let signing_key = SigningKey::from_bytes(&unhex(SIGNING_SEED_HEX).try_into().unwrap());
    let peer_key = SigningKey::from_bytes(&unhex(PEER_SEED_HEX).try_into().unwrap());
    let peer_public = peer_key.verifying_key();
    let peer_bytes = peer_public.to_bytes();

    let specs = [
        VectorSpec {
            id: "session-offer",
            replay_signature_from: "host-answer",
            kind: SignalKind::Offer,
            protocol: RtcProtocol::Session,
            protocol_version: 2,
            signal_id: SESSION_OFFER_SIGNAL_ID,
            scope_type: ScopeType::Session,
            scope_id: SESSION_SCOPE_ID,
            sender_role: SenderRole::Browser,
            sdp: SESSION_SDP,
        },
        VectorSpec {
            id: "host-answer",
            replay_signature_from: "session-offer",
            kind: SignalKind::Answer,
            protocol: RtcProtocol::Host,
            protocol_version: 1,
            signal_id: HOST_ANSWER_SIGNAL_ID,
            scope_type: ScopeType::Host,
            scope_id: HOST_SCOPE_ID,
            sender_role: SenderRole::Daemon,
            sdp: HOST_SDP,
        },
    ];

    // --- transcript vectors ---
    let transcript_vectors: Vec<Value> = specs
        .iter()
        .map(|spec| {
            let transcript = transcript(spec, peer_bytes);
            let encoded = transcript.encode().expect("encode golden transcript");
            let signature = sign_transcript(&signing_key, &transcript).expect("sign transcript");
            json!({
                "id": spec.id,
                "signal_kind": signal_kind_str(spec.kind),
                "protocol_version": spec.protocol_version,
                "session_id": spec.signal_id,
                "scope_type": scope_type_str(spec.scope_type),
                "scope_id": spec.scope_id,
                "sender_role": sender_role_str(spec.sender_role),
                "intended_peer_public_key_hex": hex(peer_bytes),
                "sdp": spec.sdp,
                "transcript_hex": hex(&encoded),
                "sha256_hex": hex(Sha256::digest(&encoded)),
                "signature_hex": hex(signature.to_bytes()),
                "signature_wire": signature_to_wire(&signature),
                "replay_signature_from": spec.replay_signature_from,
            })
        })
        .collect();

    let transcript_file = json!({
        "format": "spawn-signed-signal-v1",
        "key_material_source": KEY_MATERIAL_SOURCE,
        "signing_key": {
            "seed_hex": SIGNING_SEED_HEX,
            "public_key_hex": hex(signing_key.verifying_key().to_bytes()),
            "public_key_wire": public_key_to_wire(&signing_key.verifying_key()),
        },
        "intended_peer_key": {
            "public_key_hex": hex(peer_bytes),
            "public_key_wire": public_key_to_wire(&peer_public),
        },
        "mutation_fields": [
            "signal_kind",
            "protocol_version",
            "session_id",
            "scope_type",
            "scope_id",
            "sender_role",
            "intended_peer_public_key",
            "sdp",
        ],
        "vectors": transcript_vectors,
    });

    // --- wire envelope vectors ---
    let wire_vectors: Vec<Value> = specs
        .iter()
        .map(|spec| {
            let transcript = transcript(spec, peer_bytes);
            let wire = sign_rtc_signal_wire(&signing_key, spec.protocol, &transcript)
                .expect("sign wire envelope");
            json!({
                "id": spec.id,
                "envelope": serde_json::from_str::<Value>(&wire).expect("wire envelope json"),
            })
        })
        .collect();

    // Correctly signed but topology-invalid envelopes: the exact current
    // protocol/version mapping must reject them even though the signature
    // verifies. `sign_rtc_signal_wire` refuses to produce them, so the
    // envelope is assembled by hand around a directly signed transcript.
    let wrong_topology_vectors: Vec<Value> = [
        ("session-offer-wrong-version-1", &specs[0], 1_u32),
        ("host-answer-wrong-version-2", &specs[1], 2_u32),
    ]
    .into_iter()
    .map(|(id, spec, wrong_version)| {
        let transcript = SignedSignalTranscript::new(
            spec.kind,
            wrong_version,
            spec.signal_id,
            spec.scope_type,
            spec.scope_id,
            spec.sender_role,
            peer_bytes,
            spec.sdp,
        )
        .expect("wrong-topology transcript");
        let signature =
            sign_transcript_wire(&signing_key, &transcript).expect("sign wrong-topology");
        json!({
            "id": id,
            "envelope": {
                "type": signal_type_str(spec.kind),
                "signature_algorithm": "ed25519",
                "sender_identity_public_key": public_key_to_wire(&signing_key.verifying_key()),
                "intended_peer_identity_public_key": public_key_to_wire(&peer_public),
                "protocol": spec.protocol.as_str(),
                "protocol_version": wrong_version,
                "session_id": spec.signal_id,
                "scope_type": scope_type_str(spec.scope_type),
                "scope_id": spec.scope_id,
                "sender_role": sender_role_str(spec.sender_role),
                "sdp": spec.sdp,
                "signature": signature,
            },
        })
    })
    .collect();

    let wire_file = json!({
        "format": "spawn-signed-signal-wire-v1",
        "key_material_source": KEY_MATERIAL_SOURCE,
        "signing_seed_hex": SIGNING_SEED_HEX,
        "sender_public_key_wire": public_key_to_wire(&signing_key.verifying_key()),
        "intended_peer_public_key_wire": public_key_to_wire(&peer_public),
        "mutation_fields": [
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
        "protocol_version_json_tokens": {
            "session_accepted": ["2", "2.0", "2e0", "2E+0"],
            "host_accepted": ["1", "1.0", "1e0", "1E+0"],
            "rejected": ["0", "-1", "1.5", "2.5", "4294967296", "1e309", "NaN"],
        },
        "vectors": wire_vectors,
        "wrong_topology_vectors": wrong_topology_vectors,
    });

    let proto_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../proto");
    write_pretty(
        &proto_dir.join("signed-signal-v1-vectors.json"),
        &transcript_file,
    );
    write_pretty(
        &proto_dir.join("signed-signal-wire-v1-vectors.json"),
        &wire_file,
    );
}

fn write_pretty(path: &std::path::Path, value: &Value) {
    let mut text = serde_json::to_string_pretty(value).expect("serialize vectors");
    text.push('\n');
    std::fs::write(path, text).unwrap_or_else(|error| {
        panic!("writing {}: {error}", path.display());
    });
    println!("wrote {}", path.display());
}
