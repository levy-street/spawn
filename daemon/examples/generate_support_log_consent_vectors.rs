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
    let mut wrong_device: Consent = serde_json::from_value(positive[1]["consent"].clone()).unwrap();
    wrong_device.signer_device_id = Uuid::from_bytes([8; 16]).to_string();
    wrong_device.sign(&signer).unwrap();
    let mut wrong_chain = wrong_device.clone();
    let child = SigningKey::from_bytes(&[9; 32]);
    wrong_chain.signer_public_key = URL_SAFE_NO_PAD.encode(child.verifying_key().as_bytes());
    let edge = spawnd::acct_endorsement::AcctEndorsementTranscript::from_wire(
        &wrong_chain.account_id,
        &wrong_device.signer_public_key,
        &wrong_chain.signer_public_key,
        &Uuid::from_bytes([6; 16]).to_string(),
    )
    .unwrap();
    wrong_chain
        .carried_endorsements
        .push(spawnd::endorsement_chain::CarriedEndorsement {
            account_id: wrong_chain.account_id.clone(),
            endorser_public_key: wrong_device.signer_public_key.clone(),
            endorsed_public_key: wrong_chain.signer_public_key.clone(),
            endorsed_device_id: Uuid::from_bytes([6; 16]).to_string(),
            signature: spawnd::acct_endorsement::signature_to_wire(
                &spawnd::acct_endorsement::sign_transcript(&signer, &edge),
            ),
        });
    wrong_chain.sign(&child).unwrap();
    let negative = json!([
        {"case": "direct_device_mismatch", "consent": wrong_device, "expected": "signer_untrusted"},
        {"case": "chain_device_mismatch", "consent": wrong_chain, "expected": "signer_untrusted"}
    ]);
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "contract":"SPAWN-SUPPORT-LOG-CONSENT-V1", "version":1,
            "producer":"spawnd Rust ed25519-dalek 2.2", "positive":positive, "negative":negative,
            "trusted_device_id":Uuid::from_bytes([2;16]).to_string()
        }))
        .unwrap()
    );
}
