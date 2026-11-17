//! Reproduce proto/support-log-consent-v1-vectors.json with production encoding.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::SigningKey;
use serde_json::json;
use sha2::{Digest, Sha256};
use spawnd::support_consent::Consent;
use uuid::Uuid;
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn main() {
    let signer = SigningKey::from_bytes(&[7; 32]);
    let positive: Vec<_> = [false, true]
        .into_iter()
        .map(|enabled| {
            let mut consent = Consent {
                version: 1,
                account_id: Uuid::from_bytes([1; 16]).to_string(),
                signer_device_id: Uuid::from_bytes([2; 16]).to_string(),
                signer_public_key: URL_SAFE_NO_PAD.encode(signer.verifying_key().as_bytes()),
                enabled,
                issued_at_ms: 1_700_000_000_000,
                signature: String::new(),
                carried_endorsements: vec![],
            };
            consent.sign(&signer).unwrap();
            let bytes = consent.encode().unwrap();
            json!({"consent":consent,"signing_seed_hex":hex(&[7;32]),
            "transcript_hex":hex(&bytes),"transcript_sha256":hex(&Sha256::digest(bytes))})
        })
        .collect();
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "contract":"SPAWN-SUPPORT-LOG-CONSENT-V1", "version":1,
            "producer":"spawnd Rust ed25519-dalek 2.2", "positive":positive
        }))
        .unwrap()
    );
}
