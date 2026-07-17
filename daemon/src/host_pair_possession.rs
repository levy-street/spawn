//! Fixed-width daemon host-key proof for one device-pairing ceremony.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use thiserror::Error;

use crate::signed_signal::public_key_from_wire;

pub const HOST_PAIR_POSSESSION_MAGIC: &[u8] = b"SPAWN-HOST-PAIR-POSSESSION-V1";
pub const HOST_PAIR_POSSESSION_VERSION: u8 = 1;
pub const DEVICE_CODE_BYTES: usize = 32;
pub const APPROVAL_NONCE_BYTES: usize = 32;
pub const HOST_PUBLIC_KEY_BYTES: usize = 32;
pub const SIGNATURE_BYTES: usize = 64;
pub const FIXED_WIRE_LENGTH: usize = 43;
pub const SIGNATURE_WIRE_LENGTH: usize = 86;

#[derive(Debug, Error, Eq, PartialEq)]
pub enum HostPairPossessionError {
    #[error("invalid canonical base64url {0}")]
    InvalidBase64Url(&'static str),
    #[error("invalid Ed25519 host public key")]
    InvalidPublicKey,
    #[error("invalid Ed25519 signature")]
    InvalidSignature,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct HostPairPossessionTranscript {
    pub device_code: [u8; DEVICE_CODE_BYTES],
    pub approval_nonce: [u8; APPROVAL_NONCE_BYTES],
    pub host_public_key: [u8; HOST_PUBLIC_KEY_BYTES],
}

impl HostPairPossessionTranscript {
    pub fn from_wire(
        device_code: &str,
        approval_nonce: &str,
        host_public_key: &str,
    ) -> Result<Self, HostPairPossessionError> {
        let device_code = decode_wire_exact(device_code, "device_code")?;
        let approval_nonce = decode_wire_exact(approval_nonce, "approval_nonce")?;
        let verifying_key = public_key_from_wire(host_public_key)
            .map_err(|_| HostPairPossessionError::InvalidPublicKey)?;
        Ok(Self {
            device_code,
            approval_nonce,
            host_public_key: verifying_key.to_bytes(),
        })
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut encoded = Vec::with_capacity(HOST_PAIR_POSSESSION_MAGIC.len() + 1 + 96);
        encoded.extend_from_slice(HOST_PAIR_POSSESSION_MAGIC);
        encoded.push(HOST_PAIR_POSSESSION_VERSION);
        encoded.extend_from_slice(&self.device_code);
        encoded.extend_from_slice(&self.approval_nonce);
        encoded.extend_from_slice(&self.host_public_key);
        encoded
    }
}

pub fn sign_transcript(
    signing_key: &SigningKey,
    transcript: &HostPairPossessionTranscript,
) -> Signature {
    signing_key.sign(&transcript.encode())
}

pub fn verify_transcript(
    verifying_key: &VerifyingKey,
    transcript: &HostPairPossessionTranscript,
    signature: &Signature,
) -> Result<(), HostPairPossessionError> {
    verifying_key
        .verify_strict(&transcript.encode(), signature)
        .map_err(|_| HostPairPossessionError::InvalidSignature)
}

pub fn signature_to_wire(signature: &Signature) -> String {
    URL_SAFE_NO_PAD.encode(signature.to_bytes())
}

pub fn signature_from_wire(value: &str) -> Result<Signature, HostPairPossessionError> {
    if value.len() != SIGNATURE_WIRE_LENGTH || value.contains('=') {
        return Err(HostPairPossessionError::InvalidBase64Url("signature"));
    }
    let decoded: [u8; SIGNATURE_BYTES] = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| HostPairPossessionError::InvalidBase64Url("signature"))?
        .try_into()
        .map_err(|_| HostPairPossessionError::InvalidBase64Url("signature"))?;
    if URL_SAFE_NO_PAD.encode(decoded) != value {
        return Err(HostPairPossessionError::InvalidBase64Url("signature"));
    }
    Ok(Signature::from_bytes(&decoded))
}

fn decode_wire_exact(
    value: &str,
    field: &'static str,
) -> Result<[u8; 32], HostPairPossessionError> {
    if value.len() != FIXED_WIRE_LENGTH || value.contains('=') {
        return Err(HostPairPossessionError::InvalidBase64Url(field));
    }
    let decoded: [u8; 32] = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| HostPairPossessionError::InvalidBase64Url(field))?
        .try_into()
        .map_err(|_| HostPairPossessionError::InvalidBase64Url(field))?;
    if URL_SAFE_NO_PAD.encode(decoded) != value {
        return Err(HostPairPossessionError::InvalidBase64Url(field));
    }
    Ok(decoded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use sha2::{Digest, Sha256};

    #[derive(Deserialize)]
    struct Vectors {
        contract: String,
        version: u8,
        producer: String,
        positive: Positive,
    }

    #[derive(Deserialize)]
    struct Positive {
        signing_seed_hex: String,
        device_code: String,
        approval_nonce: String,
        host_public_key: String,
        transcript_hex: String,
        transcript_sha256: String,
        signature: String,
    }

    fn decode_hex<const N: usize>(value: &str) -> [u8; N] {
        assert_eq!(value.len(), N * 2);
        let mut decoded = [0_u8; N];
        for (index, byte) in decoded.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).unwrap();
        }
        decoded
    }

    fn encode_hex(value: &[u8]) -> String {
        value.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    #[test]
    fn shared_rust_produced_vector_is_exact_and_verifiable() {
        let vectors: Vectors = serde_json::from_str(include_str!(
            "../../proto/host-pair-possession-v1-vectors.json"
        ))
        .unwrap();
        assert_eq!(vectors.contract, "SPAWN-HOST-PAIR-POSSESSION-V1");
        assert_eq!(vectors.version, HOST_PAIR_POSSESSION_VERSION);
        assert_eq!(vectors.producer, "spawnd Rust ed25519-dalek 2.2");

        let transcript = HostPairPossessionTranscript::from_wire(
            &vectors.positive.device_code,
            &vectors.positive.approval_nonce,
            &vectors.positive.host_public_key,
        )
        .unwrap();
        let signing_key = SigningKey::from_bytes(&decode_hex(&vectors.positive.signing_seed_hex));
        assert_eq!(
            URL_SAFE_NO_PAD.encode(signing_key.verifying_key().to_bytes()),
            vectors.positive.host_public_key
        );
        assert_eq!(
            encode_hex(&transcript.encode()),
            vectors.positive.transcript_hex
        );
        assert_eq!(
            encode_hex(&Sha256::digest(transcript.encode())),
            vectors.positive.transcript_sha256
        );

        let rust_signature = sign_transcript(&signing_key, &transcript);
        assert_eq!(
            signature_to_wire(&rust_signature),
            vectors.positive.signature
        );
        verify_transcript(&signing_key.verifying_key(), &transcript, &rust_signature).unwrap();
        verify_transcript(
            &signing_key.verifying_key(),
            &transcript,
            &signature_from_wire(&vectors.positive.signature).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn transcript_rejects_noncanonical_fixed_width_wire_values() {
        let valid = URL_SAFE_NO_PAD.encode([7_u8; 32]);
        assert!(
            HostPairPossessionTranscript::from_wire(&format!("{valid}="), &valid, &valid,).is_err()
        );
        assert!(signature_from_wire(&URL_SAFE_NO_PAD.encode([0_u8; 63])).is_err());
    }
}
