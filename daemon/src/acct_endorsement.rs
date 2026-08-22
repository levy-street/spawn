//! Account-scoped endorsement: one device vouching for another device's key
//! *for the whole account*, not for a single host.
//!
//! This is the primitive the device trust mesh is built on (see
//! `docs/TRUST_DEVICE_MESH.md` §3). It is the deliberate successor to the
//! per-host [`crate::browser_endorsement`]: that binds an endorsement to one
//! host's key, so a device admitted to host A gains nothing on host B and the
//! operator re-runs a ceremony per host. An account-scoped endorsement drops the
//! host binding, so a single endorsement is *carried by the device* and presented
//! to every host — the mesh's "one human check per device" property (P4).
//!
//! The transcript still binds:
//!   - the **account** (`account_id`), so an endorsement minted under one account
//!     cannot be replayed under another;
//!   - the **endorser** and **endorsed** keys, so the server (which relays but
//!     holds no private key) can neither forge nor re-key it;
//!   - the endorsed **device id**, so the server cannot silently re-point a valid
//!     endorsement at a different device record in its roster — the roster the
//!     operator audits stays honest (R4). The host does *not* consult device ids
//!     when admitting (it validates keys); this field protects roster integrity.
//!
//! What a single endorsement does NOT establish is that `endorsed_public_key`
//! belongs to the operator's real new device rather than one the server
//! substituted while relaying. Only the committed-ephemeral SAS number-match at
//! endorsement time settles that (see [`crate::sas`] and the doc's A5); this
//! module is the signed artifact that ceremony produces.
//!
//! [`verify_endorsement`] checks a **single edge** against a candidate set of
//! trusted endorser keys. Multi-hop chain validation to a host's anchors (the
//! full admission rule, doc §3) is [`crate::endorsement_chain`], which the
//! connect path (`run.rs`) invokes per signed-RTC offer; it verifies each edge
//! through this module.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use thiserror::Error;
use uuid::Uuid;

use crate::signed_signal::public_key_from_wire;

pub const ACCT_ENDORSEMENT_MAGIC: &[u8] = b"SPAWN-ACCT-ENDORSE-V1";
pub const ACCT_ENDORSEMENT_VERSION: u8 = 1;
pub const UUID_BYTES: usize = 16;
pub const PUBLIC_KEY_BYTES: usize = 32;
pub const SIGNATURE_BYTES: usize = 64;
pub const SIGNATURE_WIRE_LENGTH: usize = 86;
/// magic(21) + version(1) + account_id(16) + endorser(32) + endorsed(32) + device_id(16)
pub const ACCT_ENDORSEMENT_TRANSCRIPT_BYTES: usize =
    21 + 1 + UUID_BYTES + PUBLIC_KEY_BYTES * 2 + UUID_BYTES;

#[derive(Debug, Error, Eq, PartialEq)]
pub enum AcctEndorsementError {
    #[error("invalid canonical base64url {0}")]
    InvalidBase64Url(&'static str),
    #[error("{0} is not a canonical UUID")]
    InvalidUuid(&'static str),
    #[error("invalid Ed25519 {0} public key")]
    InvalidPublicKey(&'static str),
    #[error("endorser is not a trusted key")]
    UntrustedEndorser,
    #[error("a device may not endorse itself")]
    SelfEndorsement,
    #[error("invalid Ed25519 signature")]
    InvalidSignature,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct AcctEndorsementTranscript {
    pub account_id: [u8; UUID_BYTES],
    pub endorser_public_key: [u8; PUBLIC_KEY_BYTES],
    pub endorsed_public_key: [u8; PUBLIC_KEY_BYTES],
    pub endorsed_device_id: [u8; UUID_BYTES],
}

impl AcctEndorsementTranscript {
    pub fn from_wire(
        account_id: &str,
        endorser_public_key: &str,
        endorsed_public_key: &str,
        endorsed_device_id: &str,
    ) -> Result<Self, AcctEndorsementError> {
        let account_id = canonical_uuid_bytes(account_id, "account ID")?;
        let endorsed_device_id = canonical_uuid_bytes(endorsed_device_id, "endorsed device ID")?;
        let endorser_key = public_key_from_wire(endorser_public_key)
            .map_err(|_| AcctEndorsementError::InvalidPublicKey("endorser"))?;
        let endorsed_key = public_key_from_wire(endorsed_public_key)
            .map_err(|_| AcctEndorsementError::InvalidPublicKey("endorsed"))?;
        if endorser_key.to_bytes() == endorsed_key.to_bytes() {
            // A self-endorsement would let any key admit itself, which is exactly
            // the authority this mechanism exists to withhold.
            return Err(AcctEndorsementError::SelfEndorsement);
        }
        Ok(Self {
            account_id,
            endorser_public_key: endorser_key.to_bytes(),
            endorsed_public_key: endorsed_key.to_bytes(),
            endorsed_device_id,
        })
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut encoded = Vec::with_capacity(ACCT_ENDORSEMENT_TRANSCRIPT_BYTES);
        encoded.extend_from_slice(ACCT_ENDORSEMENT_MAGIC);
        encoded.push(ACCT_ENDORSEMENT_VERSION);
        encoded.extend_from_slice(&self.account_id);
        encoded.extend_from_slice(&self.endorser_public_key);
        encoded.extend_from_slice(&self.endorsed_public_key);
        encoded.extend_from_slice(&self.endorsed_device_id);
        encoded
    }
}

pub fn sign_transcript(
    signing_key: &SigningKey,
    transcript: &AcctEndorsementTranscript,
) -> Signature {
    signing_key.sign(&transcript.encode())
}

/// Verify a single endorsement edge against a set of candidate endorser keys.
///
/// `trusted_endorsers` is whatever set the caller currently trusts to endorse —
/// at connect time this is the intermediate keys already proven for this chain.
/// An endorsement signed by anything outside it is refused. Unlike the per-host
/// primitive there is **no host binding**: the same signed edge is valid for
/// every host of the account. Multi-hop chain validation composes this per edge.
pub fn verify_endorsement(
    transcript: &AcctEndorsementTranscript,
    signature: &Signature,
    trusted_endorsers: &[VerifyingKey],
) -> Result<(), AcctEndorsementError> {
    let endorser = trusted_endorsers
        .iter()
        .find(|key| key.to_bytes() == transcript.endorser_public_key)
        .ok_or(AcctEndorsementError::UntrustedEndorser)?;
    endorser
        .verify_strict(&transcript.encode(), signature)
        .map_err(|_| AcctEndorsementError::InvalidSignature)
}

pub fn signature_to_wire(signature: &Signature) -> String {
    URL_SAFE_NO_PAD.encode(signature.to_bytes())
}

pub fn signature_from_wire(value: &str) -> Result<Signature, AcctEndorsementError> {
    if value.len() != SIGNATURE_WIRE_LENGTH || value.contains('=') {
        return Err(AcctEndorsementError::InvalidBase64Url("signature"));
    }
    let decoded: [u8; SIGNATURE_BYTES] = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| AcctEndorsementError::InvalidBase64Url("signature"))?
        .try_into()
        .map_err(|_| AcctEndorsementError::InvalidBase64Url("signature"))?;
    if URL_SAFE_NO_PAD.encode(decoded) != value {
        return Err(AcctEndorsementError::InvalidBase64Url("signature"));
    }
    Ok(Signature::from_bytes(&decoded))
}

fn canonical_uuid_bytes(
    value: &str,
    field: &'static str,
) -> Result<[u8; UUID_BYTES], AcctEndorsementError> {
    let parsed = Uuid::parse_str(value).map_err(|_| AcctEndorsementError::InvalidUuid(field))?;
    if parsed.to_string() != value {
        return Err(AcctEndorsementError::InvalidUuid(field));
    }
    Ok(*parsed.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER: &str = "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";
    const DEVICE: &str = "11111111-2222-4333-8444-555555555555";

    fn key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn wire(key: &SigningKey) -> String {
        URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes())
    }

    fn transcript(endorser: &SigningKey, endorsed: &SigningKey) -> AcctEndorsementTranscript {
        AcctEndorsementTranscript::from_wire(USER, &wire(endorser), &wire(endorsed), DEVICE)
            .expect("valid transcript")
    }

    #[test]
    fn a_trusted_key_can_endorse_another() {
        let (endorser, endorsed) = (key(2), key(3));
        let t = transcript(&endorser, &endorsed);
        let signature = sign_transcript(&endorser, &t);
        verify_endorsement(&t, &signature, &[endorser.verifying_key()]).expect("verifies");
    }

    #[test]
    fn the_same_endorsement_is_valid_with_no_host_in_scope() {
        // The whole point of account scope: one signed edge, valid everywhere.
        // There is no host parameter to bind, so nothing can make it "wrong host".
        let (endorser, endorsed) = (key(2), key(3));
        let t = transcript(&endorser, &endorsed);
        let signature = sign_transcript(&endorser, &t);
        // Re-verify against the identical trusted set as many hosts would.
        for _ in 0..3 {
            verify_endorsement(&t, &signature, &[endorser.verifying_key()]).expect("verifies");
        }
    }

    #[test]
    fn an_untrusted_endorser_is_refused() {
        let (stranger, endorsed, trusted) = (key(9), key(3), key(2));
        let t = transcript(&stranger, &endorsed);
        let signature = sign_transcript(&stranger, &t);
        assert_eq!(
            verify_endorsement(&t, &signature, &[trusted.verifying_key()]),
            Err(AcctEndorsementError::UntrustedEndorser)
        );
    }

    #[test]
    fn a_forged_signature_is_refused() {
        let (endorser, endorsed, impostor) = (key(2), key(3), key(4));
        let t = transcript(&endorser, &endorsed);
        let signature = sign_transcript(&impostor, &t);
        assert_eq!(
            verify_endorsement(&t, &signature, &[endorser.verifying_key()]),
            Err(AcctEndorsementError::InvalidSignature)
        );
    }

    #[test]
    fn swapping_the_endorsed_key_invalidates_the_signature() {
        let (endorser, endorsed, attacker) = (key(2), key(3), key(5));
        let signed = transcript(&endorser, &endorsed);
        let signature = sign_transcript(&endorser, &signed);
        let tampered = transcript(&endorser, &attacker);
        assert_eq!(
            verify_endorsement(&tampered, &signature, &[endorser.verifying_key()]),
            Err(AcctEndorsementError::InvalidSignature)
        );
    }

    #[test]
    fn repointing_the_device_id_invalidates_the_signature() {
        let (endorser, endorsed) = (key(2), key(3));
        let signed = transcript(&endorser, &endorsed);
        let signature = sign_transcript(&endorser, &signed);
        let repointed = AcctEndorsementTranscript::from_wire(
            USER,
            &wire(&endorser),
            &wire(&endorsed),
            "22222222-3333-4444-8555-666666666666",
        )
        .expect("valid transcript");
        assert_eq!(
            verify_endorsement(&repointed, &signature, &[endorser.verifying_key()]),
            Err(AcctEndorsementError::InvalidSignature)
        );
    }

    #[test]
    fn moving_the_endorsement_to_another_account_invalidates_the_signature() {
        let (endorser, endorsed) = (key(2), key(3));
        let signed = transcript(&endorser, &endorsed);
        let signature = sign_transcript(&endorser, &signed);
        let other_account = AcctEndorsementTranscript::from_wire(
            "00000000-0000-4000-8000-000000000000",
            &wire(&endorser),
            &wire(&endorsed),
            DEVICE,
        )
        .expect("valid transcript");
        assert_eq!(
            verify_endorsement(&other_account, &signature, &[endorser.verifying_key()]),
            Err(AcctEndorsementError::InvalidSignature)
        );
    }

    #[test]
    fn a_device_may_not_endorse_itself() {
        let device = key(2);
        assert_eq!(
            AcctEndorsementTranscript::from_wire(USER, &wire(&device), &wire(&device), DEVICE)
                .unwrap_err(),
            AcctEndorsementError::SelfEndorsement
        );
    }

    #[test]
    fn any_key_in_the_trusted_set_may_endorse() {
        // Trust is a set, not a single root: the caller passes whichever keys are
        // currently proven, and any of them may be the endorser of this edge.
        let (first, second, endorsed) = (key(2), key(6), key(3));
        let t = transcript(&second, &endorsed);
        let signature = sign_transcript(&second, &t);
        verify_endorsement(
            &t,
            &signature,
            &[first.verifying_key(), second.verifying_key()],
        )
        .expect("either trusted key may endorse");
    }

    #[test]
    fn rejects_non_canonical_identifiers_and_signatures() {
        let (endorser, endorsed) = (key(2), key(3));
        assert!(matches!(
            AcctEndorsementTranscript::from_wire(
                "NOT-A-UUID",
                &wire(&endorser),
                &wire(&endorsed),
                DEVICE,
            ),
            Err(AcctEndorsementError::InvalidUuid(_))
        ));
        let t = transcript(&endorser, &endorsed);
        let signature = signature_to_wire(&sign_transcript(&endorser, &t));
        assert!(signature_from_wire(&format!("{}=", &signature[..85])).is_err());
        assert!(signature_from_wire(&signature[..85]).is_err());
        assert!(signature_from_wire(&signature).is_ok());
    }
}

#[cfg(test)]
mod cross_runtime_vector {
    use super::*;
    use sha2::{Digest, Sha256};

    /// Fixed vector shared with the browser (`acct-endorsement-transcript.ts`)
    /// and server (`acct_endorsement.py`) encoders. All three sign the same bytes
    /// or an account endorsement silently fails to verify across runtimes.
    pub const VECTOR_USER: &str = "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";
    pub const VECTOR_DEVICE: &str = "11111111-2222-4333-8444-555555555555";

    #[test]
    fn transcript_matches_the_shared_vector() {
        let endorser = SigningKey::from_bytes(&[12; 32]);
        let endorsed = SigningKey::from_bytes(&[13; 32]);
        let wire = |k: &SigningKey| URL_SAFE_NO_PAD.encode(k.verifying_key().to_bytes());

        let transcript = AcctEndorsementTranscript::from_wire(
            VECTOR_USER,
            &wire(&endorser),
            &wire(&endorsed),
            VECTOR_DEVICE,
        )
        .expect("valid transcript");

        assert_eq!(transcript.encode().len(), ACCT_ENDORSEMENT_TRANSCRIPT_BYTES);
        assert_eq!(ACCT_ENDORSEMENT_TRANSCRIPT_BYTES, 118);
        let digest = URL_SAFE_NO_PAD.encode(Sha256::digest(transcript.encode()));
        // The browser and server encoders assert this same digest. If any side
        // changes the layout, endorsements stop verifying across runtimes --
        // silently, since each side would still agree with itself.
        assert_eq!(digest, "7HXf12SEyR3WDpy4EeHKVQCsffmdTnMgMVPbq9jgnq8");
    }

    #[test]
    fn signature_matches_the_shared_vector() {
        // Ed25519 is deterministic (RFC 8032), so the endorser's signature over
        // the vector transcript is itself a cross-runtime constant.
        let endorser = SigningKey::from_bytes(&[12; 32]);
        let endorsed = SigningKey::from_bytes(&[13; 32]);
        let wire = |k: &SigningKey| URL_SAFE_NO_PAD.encode(k.verifying_key().to_bytes());
        let transcript = AcctEndorsementTranscript::from_wire(
            VECTOR_USER,
            &wire(&endorser),
            &wire(&endorsed),
            VECTOR_DEVICE,
        )
        .expect("valid transcript");
        let signature = signature_to_wire(&sign_transcript(&endorser, &transcript));
        assert_eq!(
            signature,
            "pUP6fnmcBjDOlqMsM7u9hkmH5SfNaoyYkIW7XUdw-b5uVQVfMWQicGZCJ071IDRYHBW202VVXltl_CI5YdWaAQ"
        );
    }
}
