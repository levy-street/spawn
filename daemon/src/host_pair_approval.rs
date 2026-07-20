//! Browser-signed approval proof for one device-pairing ceremony.
//!
//! The browser signs this transcript with its device key when the operator
//! approves a `spawnd login` code. It binds, in one signature: the account, the
//! server-issued approval nonce (replay protection), the daemon's own host
//! public key, and the browser's own public key.
//!
//! The daemon verifies it so a browser pin is accepted only with evidence the
//! browser actually consented to *this* host in *this* ceremony, rather than on
//! the server's say-so alone. Note what this does and does not buy: because the
//! transcript commits to the signer's own key, a server that substitutes its
//! own keypair can still produce a self-consistent proof. Verification alone
//! therefore does not defeat a hostile server — it defeats replay, cross-host
//! reuse, and cross-ceremony reuse, and it makes the operator's out-of-band
//! fingerprint comparison the single remaining check.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use thiserror::Error;
use uuid::Uuid;

use crate::signed_signal::public_key_from_wire;

pub const HOST_PAIR_APPROVAL_MAGIC: &[u8] = b"SPAWN-HOST-PAIR-APPROVE-V1";
pub const HOST_PAIR_APPROVAL_VERSION: u8 = 1;
pub const USER_ID_BYTES: usize = 16;
pub const APPROVAL_NONCE_BYTES: usize = 32;
pub const PUBLIC_KEY_BYTES: usize = 32;
pub const SIGNATURE_BYTES: usize = 64;
pub const FIXED_WIRE_LENGTH: usize = 43;
pub const SIGNATURE_WIRE_LENGTH: usize = 86;

#[derive(Debug, Error, Eq, PartialEq)]
pub enum HostPairApprovalError {
    #[error("invalid canonical base64url {0}")]
    InvalidBase64Url(&'static str),
    #[error("account ID is not a canonical UUID")]
    InvalidUserId,
    #[error("invalid Ed25519 {0} public key")]
    InvalidPublicKey(&'static str),
    #[error("invalid Ed25519 signature")]
    InvalidSignature,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct HostPairApprovalTranscript {
    pub user_id: [u8; USER_ID_BYTES],
    pub approval_nonce: [u8; APPROVAL_NONCE_BYTES],
    pub host_public_key: [u8; PUBLIC_KEY_BYTES],
    pub browser_public_key: [u8; PUBLIC_KEY_BYTES],
}

impl HostPairApprovalTranscript {
    pub fn from_wire(
        user_id: &str,
        approval_nonce: &str,
        host_public_key: &str,
        browser_public_key: &str,
    ) -> Result<Self, HostPairApprovalError> {
        let user_id = canonical_uuid_bytes(user_id)?;
        let approval_nonce = decode_wire_exact(approval_nonce, "approval_nonce")?;
        let host_key = public_key_from_wire(host_public_key)
            .map_err(|_| HostPairApprovalError::InvalidPublicKey("host"))?;
        let browser_key = public_key_from_wire(browser_public_key)
            .map_err(|_| HostPairApprovalError::InvalidPublicKey("browser"))?;
        Ok(Self {
            user_id,
            approval_nonce,
            host_public_key: host_key.to_bytes(),
            browser_public_key: browser_key.to_bytes(),
        })
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut encoded =
            Vec::with_capacity(HOST_PAIR_APPROVAL_MAGIC.len() + 1 + USER_ID_BYTES + 96);
        encoded.extend_from_slice(HOST_PAIR_APPROVAL_MAGIC);
        encoded.push(HOST_PAIR_APPROVAL_VERSION);
        encoded.extend_from_slice(&self.user_id);
        encoded.extend_from_slice(&self.approval_nonce);
        encoded.extend_from_slice(&self.host_public_key);
        encoded.extend_from_slice(&self.browser_public_key);
        encoded
    }
}

pub fn sign_transcript(
    signing_key: &SigningKey,
    transcript: &HostPairApprovalTranscript,
) -> Signature {
    signing_key.sign(&transcript.encode())
}

/// Verify the browser's approval signature. `verifying_key` must be the browser
/// device key named by the transcript, so a proof can never be validated
/// against a key the transcript did not commit to.
pub fn verify_transcript(
    verifying_key: &VerifyingKey,
    transcript: &HostPairApprovalTranscript,
    signature: &Signature,
) -> Result<(), HostPairApprovalError> {
    if verifying_key.to_bytes() != transcript.browser_public_key {
        return Err(HostPairApprovalError::InvalidPublicKey("browser"));
    }
    verifying_key
        .verify_strict(&transcript.encode(), signature)
        .map_err(|_| HostPairApprovalError::InvalidSignature)
}

pub fn signature_to_wire(signature: &Signature) -> String {
    URL_SAFE_NO_PAD.encode(signature.to_bytes())
}

pub fn signature_from_wire(value: &str) -> Result<Signature, HostPairApprovalError> {
    if value.len() != SIGNATURE_WIRE_LENGTH || value.contains('=') {
        return Err(HostPairApprovalError::InvalidBase64Url("signature"));
    }
    let decoded: [u8; SIGNATURE_BYTES] = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| HostPairApprovalError::InvalidBase64Url("signature"))?
        .try_into()
        .map_err(|_| HostPairApprovalError::InvalidBase64Url("signature"))?;
    if URL_SAFE_NO_PAD.encode(decoded) != value {
        return Err(HostPairApprovalError::InvalidBase64Url("signature"));
    }
    Ok(Signature::from_bytes(&decoded))
}

fn canonical_uuid_bytes(value: &str) -> Result<[u8; USER_ID_BYTES], HostPairApprovalError> {
    let parsed = Uuid::parse_str(value).map_err(|_| HostPairApprovalError::InvalidUserId)?;
    if parsed.to_string() != value {
        return Err(HostPairApprovalError::InvalidUserId);
    }
    Ok(*parsed.as_bytes())
}

fn decode_wire_exact(
    value: &str,
    field: &'static str,
) -> Result<[u8; 32], HostPairApprovalError> {
    if value.len() != FIXED_WIRE_LENGTH || value.contains('=') {
        return Err(HostPairApprovalError::InvalidBase64Url(field));
    }
    let decoded: [u8; 32] = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| HostPairApprovalError::InvalidBase64Url(field))?
        .try_into()
        .map_err(|_| HostPairApprovalError::InvalidBase64Url(field))?;
    if URL_SAFE_NO_PAD.encode(decoded) != value {
        return Err(HostPairApprovalError::InvalidBase64Url(field));
    }
    Ok(decoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER: &str = "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";

    fn key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn wire(key: &SigningKey) -> String {
        URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes())
    }

    fn nonce(seed: u8) -> String {
        URL_SAFE_NO_PAD.encode([seed; 32])
    }

    fn transcript(host: &SigningKey, browser: &SigningKey) -> HostPairApprovalTranscript {
        HostPairApprovalTranscript::from_wire(USER, &nonce(7), &wire(host), &wire(browser))
            .expect("valid transcript")
    }

    #[test]
    fn round_trips_a_browser_approval() {
        let (host, browser) = (key(1), key(2));
        let t = transcript(&host, &browser);
        let signature = sign_transcript(&browser, &t);
        let wire = signature_to_wire(&signature);
        let parsed = signature_from_wire(&wire).expect("canonical signature");
        verify_transcript(&browser.verifying_key(), &t, &parsed).expect("verifies");
    }

    #[test]
    fn rejects_a_signature_from_another_browser() {
        let (host, browser, impostor) = (key(1), key(2), key(3));
        let t = transcript(&host, &browser);
        let signature = sign_transcript(&impostor, &t);
        assert_eq!(
            verify_transcript(&browser.verifying_key(), &t, &signature),
            Err(HostPairApprovalError::InvalidSignature)
        );
    }

    #[test]
    fn rejects_verification_against_a_key_the_transcript_did_not_name() {
        let (host, browser, other) = (key(1), key(2), key(3));
        let t = transcript(&host, &browser);
        let signature = sign_transcript(&other, &t);
        // Even though `other` signed it, the transcript names `browser`.
        assert_eq!(
            verify_transcript(&other.verifying_key(), &t, &signature),
            Err(HostPairApprovalError::InvalidPublicKey("browser"))
        );
    }

    #[test]
    fn rejects_a_proof_bound_to_a_different_host() {
        let (host, other_host, browser) = (key(1), key(4), key(2));
        let signed = transcript(&host, &browser);
        let signature = sign_transcript(&browser, &signed);
        let replayed = transcript(&other_host, &browser);
        assert_eq!(
            verify_transcript(&browser.verifying_key(), &replayed, &signature),
            Err(HostPairApprovalError::InvalidSignature)
        );
    }

    #[test]
    fn rejects_a_proof_from_a_different_ceremony() {
        let (host, browser) = (key(1), key(2));
        let signed = transcript(&host, &browser);
        let signature = sign_transcript(&browser, &signed);
        let replayed =
            HostPairApprovalTranscript::from_wire(USER, &nonce(9), &wire(&host), &wire(&browser))
                .expect("valid transcript");
        assert_eq!(
            verify_transcript(&browser.verifying_key(), &replayed, &signature),
            Err(HostPairApprovalError::InvalidSignature)
        );
    }

    #[test]
    fn rejects_a_proof_for_a_different_account() {
        let (host, browser) = (key(1), key(2));
        let signed = transcript(&host, &browser);
        let signature = sign_transcript(&browser, &signed);
        let replayed = HostPairApprovalTranscript::from_wire(
            "00000000-0000-4000-8000-000000000001",
            &nonce(7),
            &wire(&host),
            &wire(&browser),
        )
        .expect("valid transcript");
        assert_eq!(
            verify_transcript(&browser.verifying_key(), &replayed, &signature),
            Err(HostPairApprovalError::InvalidSignature)
        );
    }

    #[test]
    fn rejects_non_canonical_account_ids() {
        let (host, browser) = (key(1), key(2));
        for value in [
            "9F1C2D3E-4B5A-4C6D-8E7F-0A1B2C3D4E5F",
            "9f1c2d3e4b5a4c6d8e7f0a1b2c3d4e5f",
            "urn:uuid:9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
            "",
        ] {
            assert_eq!(
                HostPairApprovalTranscript::from_wire(
                    value,
                    &nonce(7),
                    &wire(&host),
                    &wire(&browser),
                )
                .unwrap_err(),
                HostPairApprovalError::InvalidUserId,
                "accepted non-canonical account ID {value:?}"
            );
        }
    }

    #[test]
    fn rejects_non_canonical_wire_encodings() {
        let (host, browser) = (key(1), key(2));
        let padded = format!("{}=", &nonce(7)[..42]);
        assert_eq!(
            HostPairApprovalTranscript::from_wire(USER, &padded, &wire(&host), &wire(&browser))
                .unwrap_err(),
            HostPairApprovalError::InvalidBase64Url("approval_nonce")
        );
        let t = transcript(&host, &browser);
        let signature = signature_to_wire(&sign_transcript(&browser, &t));
        assert_eq!(
            signature_from_wire(&format!("{}=", &signature[..85])).unwrap_err(),
            HostPairApprovalError::InvalidBase64Url("signature")
        );
        assert_eq!(
            signature_from_wire(&signature[..85]).unwrap_err(),
            HostPairApprovalError::InvalidBase64Url("signature")
        );
    }

    #[test]
    fn encodes_the_documented_layout() {
        let (host, browser) = (key(1), key(2));
        let encoded = transcript(&host, &browser).encode();
        assert_eq!(encoded.len(), HOST_PAIR_APPROVAL_MAGIC.len() + 1 + 16 + 32 + 32 + 32);
        assert!(encoded.starts_with(HOST_PAIR_APPROVAL_MAGIC));
        assert_eq!(encoded[HOST_PAIR_APPROVAL_MAGIC.len()], HOST_PAIR_APPROVAL_VERSION);
        assert!(encoded.ends_with(&browser.verifying_key().to_bytes()));
    }
}
