//! Account-wide, non-expiring support sharing proof. Trust admission is the
//! caller's job; this module verifies only the signed statement and its domain.
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::acct_endorsement::{signature_from_wire, signature_to_wire};
use crate::endorsement_chain::{
    deserialize_bounded_carried_endorsements, CarriedEndorsement, MAX_CARRIED_ENDORSEMENTS,
};
use crate::signed_signal::public_key_from_wire;

pub const MAGIC: &[u8; 28] = b"SPAWN-SUPPORT-LOG-CONSENT-V1";
pub const TRANSCRIPT_BYTES: usize = 102;
pub const MAX_FUTURE_MS: u64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Consent {
    pub version: u8,
    pub account_id: String,
    pub signer_public_key: String,
    pub signer_device_id: String,
    pub enabled: bool,
    pub issued_at_ms: u64,
    pub signature: String,
    #[serde(default, deserialize_with = "deserialize_bounded_carried_endorsements")]
    pub carried_endorsements: Vec<CarriedEndorsement>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ConsentError {
    #[error("invalid sharing statement")]
    Invalid,
    #[error("sharing statement belongs to another account")]
    Account,
    #[error("sharing statement is too far in the future")]
    Future,
}

impl Consent {
    pub fn encode(&self) -> Result<[u8; TRANSCRIPT_BYTES], ConsentError> {
        if self.version != 1 || self.carried_endorsements.len() > MAX_CARRIED_ENDORSEMENTS {
            return Err(ConsentError::Invalid);
        }
        let account = canonical_uuid(&self.account_id)?;
        let device = canonical_uuid(&self.signer_device_id)?;
        let signer =
            public_key_from_wire(&self.signer_public_key).map_err(|_| ConsentError::Invalid)?;
        let mut bytes = [0; TRANSCRIPT_BYTES];
        bytes[..28].copy_from_slice(MAGIC);
        bytes[28] = 1;
        bytes[29..45].copy_from_slice(account.as_bytes());
        bytes[45..77].copy_from_slice(signer.as_bytes());
        bytes[77..93].copy_from_slice(device.as_bytes());
        bytes[93] = u8::from(self.enabled);
        bytes[94..].copy_from_slice(&self.issued_at_ms.to_be_bytes());
        Ok(bytes)
    }

    pub fn sign(&mut self, signer: &SigningKey) -> Result<(), ConsentError> {
        if public_key_from_wire(&self.signer_public_key).map_err(|_| ConsentError::Invalid)?
            != signer.verifying_key()
        {
            return Err(ConsentError::Invalid);
        }
        self.signature = signature_to_wire(&signer.sign(&self.encode()?));
        Ok(())
    }

    pub fn verify(&self, account: &[u8; 16], now_ms: u64) -> Result<VerifyingKey, ConsentError> {
        let bytes = self.encode()?;
        if &bytes[29..45] != account {
            return Err(ConsentError::Account);
        }
        if self.issued_at_ms > now_ms.saturating_add(MAX_FUTURE_MS) {
            return Err(ConsentError::Future);
        }
        let signer =
            public_key_from_wire(&self.signer_public_key).map_err(|_| ConsentError::Invalid)?;
        let signature = signature_from_wire(&self.signature).map_err(|_| ConsentError::Invalid)?;
        signer
            .verify_strict(&bytes, &signature)
            .map_err(|_| ConsentError::Invalid)?;
        Ok(signer)
    }

    /// Carried paths can change without changing the signed statement.
    pub fn same_statement(&self, other: &Self) -> bool {
        self.signature == other.signature
            && self
                .encode()
                .ok()
                .zip(other.encode().ok())
                .is_some_and(|(a, b)| a == b)
    }
}

fn canonical_uuid(text: &str) -> Result<Uuid, ConsentError> {
    let id = Uuid::parse_str(text).map_err(|_| ConsentError::Invalid)?;
    if id.to_string() != text {
        return Err(ConsentError::Invalid);
    }
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

    fn fixture() -> Consent {
        let signer = SigningKey::from_bytes(&[7; 32]);
        let mut consent = Consent {
            version: 1,
            account_id: Uuid::from_bytes([1; 16]).to_string(),
            signer_device_id: Uuid::from_bytes([2; 16]).to_string(),
            signer_public_key: URL_SAFE_NO_PAD.encode(signer.verifying_key().as_bytes()),
            enabled: true,
            issued_at_ms: 1_000,
            signature: String::new(),
            carried_endorsements: vec![],
        };
        consent.sign(&signer).unwrap();
        consent
    }

    #[test]
    fn account_tampering_future_and_noncanonical_wire_are_refused() {
        let consent = fixture();
        assert!(consent.verify(&[1; 16], 1_000).is_ok());
        assert!(consent.verify(&[1; 16], u64::MAX).is_ok(), "no expiry");
        assert_eq!(consent.verify(&[3; 16], 1_000), Err(ConsentError::Account));
        let mut changed = consent.clone();
        changed.enabled = false;
        assert_eq!(changed.verify(&[1; 16], 1_000), Err(ConsentError::Invalid));
        changed = consent.clone();
        changed.issued_at_ms = MAX_FUTURE_MS + 1;
        changed.sign(&SigningKey::from_bytes(&[7; 32])).unwrap();
        assert_eq!(changed.verify(&[1; 16], 0), Err(ConsentError::Future));
        assert!(changed.verify(&[1; 16], 1).is_ok());
        changed = consent.clone();
        changed.signature.push('=');
        assert!(changed.verify(&[1; 16], 1_000).is_err());
        changed = consent;
        changed.version = 2;
        assert!(changed.encode().is_err());
    }

    #[test]
    fn golden_vectors() {
        let vectors: serde_json::Value = serde_json::from_str(include_str!(
            "../../proto/support-log-consent-v1-vectors.json"
        ))
        .unwrap();
        for vector in vectors["positive"].as_array().unwrap() {
            let consent: Consent = serde_json::from_value(vector["consent"].clone()).unwrap();
            let bytes = consent.encode().unwrap();
            let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            assert_eq!(hex, vector["transcript_hex"]);
            assert!(consent.verify(&[1; 16], consent.issued_at_ms).is_ok());
            for index in 0..bytes.len() {
                let mut tampered = bytes;
                tampered[index] ^= 1;
                let signer = public_key_from_wire(&consent.signer_public_key).unwrap();
                assert!(signer
                    .verify_strict(&tampered, &signature_from_wire(&consent.signature).unwrap())
                    .is_err());
            }
        }
    }
}
