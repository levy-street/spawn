//! Reproduce `proto/host-pair-possession-v1-vectors.json` with the daemon's
//! production Rust transcript/signature implementation.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::SigningKey;
use serde_json::json;
use sha2::{Digest, Sha256};
use spawnd::host_pair_possession::{
    sign_transcript, signature_to_wire, HostPairPossessionTranscript, HOST_PAIR_POSSESSION_VERSION,
};

fn hex(value: &[u8]) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn main() {
    let seed = [
        0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60, 0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec, 0x2c,
        0xc4, 0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19, 0x70, 0x3b, 0xac, 0x03, 0x1c, 0xae,
        0x7f, 0x60,
    ];
    let signing_key = SigningKey::from_bytes(&seed);
    let device_code = std::array::from_fn(|index| index as u8);
    let approval_nonce = std::array::from_fn(|index| (index + 32) as u8);
    let transcript = HostPairPossessionTranscript {
        device_code,
        approval_nonce,
        host_public_key: signing_key.verifying_key().to_bytes(),
    };
    let encoded = transcript.encode();
    let output = json!({
        "contract": "SPAWN-HOST-PAIR-POSSESSION-V1",
        "version": HOST_PAIR_POSSESSION_VERSION,
        "producer": "spawnd Rust ed25519-dalek 2.2",
        "positive": {
            "signing_seed_hex": hex(&seed),
            "device_code": URL_SAFE_NO_PAD.encode(device_code),
            "approval_nonce": URL_SAFE_NO_PAD.encode(approval_nonce),
            "host_public_key": URL_SAFE_NO_PAD.encode(signing_key.verifying_key().to_bytes()),
            "transcript_hex": hex(&encoded),
            "transcript_sha256": hex(&Sha256::digest(&encoded)),
            "signature": signature_to_wire(&sign_transcript(&signing_key, &transcript)),
        },
    });
    println!("{}", serde_json::to_string_pretty(&output).unwrap());
}
