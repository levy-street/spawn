//! One browser device vouching for another, so the daemon can trust a device it
//! has never met without the operator running a terminal ceremony.
//!
//! This is the half that passkeys cannot supply. A sealed trust bundle carries
//! *host* keys to a browser; nothing carries a *browser's* key to the daemon,
//! and the daemon deliberately refuses pin additions on the server's say-so.
//! The only authority it will accept is a signature from a browser key it
//! already pins.
//!
//! The transcript binds the endorsed key to this exact host, so an endorsement
//! collected for one host cannot be replayed onto another, and to the endorsed
//! device ID, so the server cannot re-point a valid endorsement at a different
//! device record.
//!
//! What this does NOT establish is that the endorsed key belongs to the
//! operator's new device rather than one the server substituted while relaying.
//! Only the operator comparing the endorsed fingerprint across both screens
//! settles that, exactly as with the host fingerprint at pairing.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use thiserror::Error;
use uuid::Uuid;

use crate::signed_signal::public_key_from_wire;

pub const BROWSER_ENDORSEMENT_MAGIC: &[u8] = b"SPAWN-BROWSER-ENDORSE-V1";
pub const BROWSER_ENDORSEMENT_VERSION: u8 = 1;
pub const UUID_BYTES: usize = 16;
pub const PUBLIC_KEY_BYTES: usize = 32;
pub const SIGNATURE_BYTES: usize = 64;
pub const SIGNATURE_WIRE_LENGTH: usize = 86;

#[derive(Debug, Error, Eq, PartialEq)]
pub enum BrowserEndorsementError {
    #[error("invalid canonical base64url {0}")]
    InvalidBase64Url(&'static str),
    #[error("{0} is not a canonical UUID")]
    InvalidUuid(&'static str),
    #[error("invalid Ed25519 {0} public key")]
    InvalidPublicKey(&'static str),
    #[error("endorser is not a trusted browser key")]
    UntrustedEndorser,
    #[error("endorsement is bound to a different host")]
    WrongHost,
    #[error("a device may not endorse itself")]
    SelfEndorsement,
    #[error("invalid Ed25519 signature")]
    InvalidSignature,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct BrowserEndorsementTranscript {
    pub user_id: [u8; UUID_BYTES],
    pub host_public_key: [u8; PUBLIC_KEY_BYTES],
    pub endorser_public_key: [u8; PUBLIC_KEY_BYTES],
    pub endorsed_public_key: [u8; PUBLIC_KEY_BYTES],
    pub endorsed_device_id: [u8; UUID_BYTES],
}

impl BrowserEndorsementTranscript {
    pub fn from_wire(
        user_id: &str,
        host_public_key: &str,
        endorser_public_key: &str,
        endorsed_public_key: &str,
        endorsed_device_id: &str,
    ) -> Result<Self, BrowserEndorsementError> {
        let user_id = canonical_uuid_bytes(user_id, "account ID")?;
        let endorsed_device_id = canonical_uuid_bytes(endorsed_device_id, "endorsed device ID")?;
        let host_key = public_key_from_wire(host_public_key)
            .map_err(|_| BrowserEndorsementError::InvalidPublicKey("host"))?;
        let endorser_key = public_key_from_wire(endorser_public_key)
            .map_err(|_| BrowserEndorsementError::InvalidPublicKey("endorser"))?;
        let endorsed_key = public_key_from_wire(endorsed_public_key)
            .map_err(|_| BrowserEndorsementError::InvalidPublicKey("endorsed"))?;
        if endorser_key.to_bytes() == endorsed_key.to_bytes() {
            // A self-endorsement would let any browser admit itself, which is
            // precisely the authority this mechanism exists to withhold.
            return Err(BrowserEndorsementError::SelfEndorsement);
        }
        Ok(Self {
            user_id,
            host_public_key: host_key.to_bytes(),
            endorser_public_key: endorser_key.to_bytes(),
            endorsed_public_key: endorsed_key.to_bytes(),
            endorsed_device_id,
        })
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut encoded =
            Vec::with_capacity(BROWSER_ENDORSEMENT_MAGIC.len() + 1 + UUID_BYTES * 2 + 96);
        encoded.extend_from_slice(BROWSER_ENDORSEMENT_MAGIC);
        encoded.push(BROWSER_ENDORSEMENT_VERSION);
        encoded.extend_from_slice(&self.user_id);
        encoded.extend_from_slice(&self.host_public_key);
        encoded.extend_from_slice(&self.endorser_public_key);
        encoded.extend_from_slice(&self.endorsed_public_key);
        encoded.extend_from_slice(&self.endorsed_device_id);
        encoded
    }
}

pub fn sign_transcript(
    signing_key: &SigningKey,
    transcript: &BrowserEndorsementTranscript,
) -> Signature {
    signing_key.sign(&transcript.encode())
}

/// Verify an endorsement against the keys this daemon already trusts.
///
/// `trusted_endorsers` is the daemon's current browser pin set. An endorsement
/// signed by anything outside it is refused, so the chain of trust always
/// terminates at a device the operator admitted in person.
pub fn verify_endorsement(
    transcript: &BrowserEndorsementTranscript,
    signature: &Signature,
    host_public_key: &VerifyingKey,
    trusted_endorsers: &[VerifyingKey],
) -> Result<(), BrowserEndorsementError> {
    if transcript.host_public_key != host_public_key.to_bytes() {
        return Err(BrowserEndorsementError::WrongHost);
    }
    let endorser = trusted_endorsers
        .iter()
        .find(|key| key.to_bytes() == transcript.endorser_public_key)
        .ok_or(BrowserEndorsementError::UntrustedEndorser)?;
    endorser
        .verify_strict(&transcript.encode(), signature)
        .map_err(|_| BrowserEndorsementError::InvalidSignature)
}

pub fn signature_to_wire(signature: &Signature) -> String {
    URL_SAFE_NO_PAD.encode(signature.to_bytes())
}

pub fn signature_from_wire(value: &str) -> Result<Signature, BrowserEndorsementError> {
    if value.len() != SIGNATURE_WIRE_LENGTH || value.contains('=') {
        return Err(BrowserEndorsementError::InvalidBase64Url("signature"));
    }
    let decoded: [u8; SIGNATURE_BYTES] = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| BrowserEndorsementError::InvalidBase64Url("signature"))?
        .try_into()
        .map_err(|_| BrowserEndorsementError::InvalidBase64Url("signature"))?;
    if URL_SAFE_NO_PAD.encode(decoded) != value {
        return Err(BrowserEndorsementError::InvalidBase64Url("signature"));
    }
    Ok(Signature::from_bytes(&decoded))
}

fn canonical_uuid_bytes(
    value: &str,
    field: &'static str,
) -> Result<[u8; UUID_BYTES], BrowserEndorsementError> {
    let parsed = Uuid::parse_str(value).map_err(|_| BrowserEndorsementError::InvalidUuid(field))?;
    if parsed.to_string() != value {
        return Err(BrowserEndorsementError::InvalidUuid(field));
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

    fn transcript(
        host: &SigningKey,
        endorser: &SigningKey,
        endorsed: &SigningKey,
    ) -> BrowserEndorsementTranscript {
        BrowserEndorsementTranscript::from_wire(
            USER,
            &wire(host),
            &wire(endorser),
            &wire(endorsed),
            DEVICE,
        )
        .expect("valid transcript")
    }

    #[test]
    fn a_trusted_browser_can_admit_a_new_one() {
        let (host, endorser, endorsed) = (key(1), key(2), key(3));
        let t = transcript(&host, &endorser, &endorsed);
        let signature = sign_transcript(&endorser, &t);
        verify_endorsement(
            &t,
            &signature,
            &host.verifying_key(),
            &[endorser.verifying_key()],
        )
        .expect("verifies");
    }

    #[test]
    fn an_untrusted_endorser_is_refused() {
        // The whole point: the server holding a valid signature from a key the
        // daemon does not pin gains it nothing.
        let (host, stranger, endorsed, trusted) = (key(1), key(9), key(3), key(2));
        let t = transcript(&host, &stranger, &endorsed);
        let signature = sign_transcript(&stranger, &t);
        assert_eq!(
            verify_endorsement(
                &t,
                &signature,
                &host.verifying_key(),
                &[trusted.verifying_key()]
            ),
            Err(BrowserEndorsementError::UntrustedEndorser)
        );
    }

    #[test]
    fn an_endorsement_for_another_host_is_refused() {
        let (host, other_host, endorser, endorsed) = (key(1), key(7), key(2), key(3));
        let t = transcript(&other_host, &endorser, &endorsed);
        let signature = sign_transcript(&endorser, &t);
        assert_eq!(
            verify_endorsement(
                &t,
                &signature,
                &host.verifying_key(),
                &[endorser.verifying_key()]
            ),
            Err(BrowserEndorsementError::WrongHost)
        );
    }

    #[test]
    fn a_forged_signature_is_refused() {
        let (host, endorser, endorsed, impostor) = (key(1), key(2), key(3), key(4));
        let t = transcript(&host, &endorser, &endorsed);
        let signature = sign_transcript(&impostor, &t);
        assert_eq!(
            verify_endorsement(
                &t,
                &signature,
                &host.verifying_key(),
                &[endorser.verifying_key()]
            ),
            Err(BrowserEndorsementError::InvalidSignature)
        );
    }

    #[test]
    fn swapping_the_endorsed_key_invalidates_the_signature() {
        // A server that relays a real endorsement but substitutes the key it
        // names must not produce something that verifies.
        let (host, endorser, endorsed, attacker) = (key(1), key(2), key(3), key(5));
        let signed = transcript(&host, &endorser, &endorsed);
        let signature = sign_transcript(&endorser, &signed);
        let tampered = transcript(&host, &endorser, &attacker);
        assert_eq!(
            verify_endorsement(
                &tampered,
                &signature,
                &host.verifying_key(),
                &[endorser.verifying_key()]
            ),
            Err(BrowserEndorsementError::InvalidSignature)
        );
    }

    #[test]
    fn repointing_the_device_id_invalidates_the_signature() {
        let (host, endorser, endorsed) = (key(1), key(2), key(3));
        let signed = transcript(&host, &endorser, &endorsed);
        let signature = sign_transcript(&endorser, &signed);
        let repointed = BrowserEndorsementTranscript::from_wire(
            USER,
            &wire(&host),
            &wire(&endorser),
            &wire(&endorsed),
            "22222222-3333-4444-8555-666666666666",
        )
        .expect("valid transcript");
        assert_eq!(
            verify_endorsement(
                &repointed,
                &signature,
                &host.verifying_key(),
                &[endorser.verifying_key()]
            ),
            Err(BrowserEndorsementError::InvalidSignature)
        );
    }

    #[test]
    fn a_device_may_not_endorse_itself() {
        let (host, device) = (key(1), key(2));
        assert_eq!(
            BrowserEndorsementTranscript::from_wire(
                USER,
                &wire(&host),
                &wire(&device),
                &wire(&device),
                DEVICE,
            )
            .unwrap_err(),
            BrowserEndorsementError::SelfEndorsement
        );
    }

    #[test]
    fn any_pinned_browser_may_endorse() {
        // Trust is a set, not a single root: losing one device must not strand
        // the operator with no way to admit another.
        let (host, first, second, endorsed) = (key(1), key(2), key(6), key(3));
        let t = transcript(&host, &second, &endorsed);
        let signature = sign_transcript(&second, &t);
        verify_endorsement(
            &t,
            &signature,
            &host.verifying_key(),
            &[first.verifying_key(), second.verifying_key()],
        )
        .expect("either pinned device may endorse");
    }

    #[test]
    fn rejects_non_canonical_identifiers_and_signatures() {
        let (host, endorser, endorsed) = (key(1), key(2), key(3));
        assert!(matches!(
            BrowserEndorsementTranscript::from_wire(
                "NOT-A-UUID",
                &wire(&host),
                &wire(&endorser),
                &wire(&endorsed),
                DEVICE,
            ),
            Err(BrowserEndorsementError::InvalidUuid(_))
        ));
        let t = transcript(&host, &endorser, &endorsed);
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

    /// Fixed vector shared with the browser and server encoders. All three sign
    /// the same bytes or endorsement silently fails to verify across runtimes.
    pub const VECTOR_USER: &str = "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";
    pub const VECTOR_DEVICE: &str = "11111111-2222-4333-8444-555555555555";

    #[test]
    fn transcript_matches_the_shared_vector() {
        let host = SigningKey::from_bytes(&[11; 32]);
        let endorser = SigningKey::from_bytes(&[12; 32]);
        let endorsed = SigningKey::from_bytes(&[13; 32]);
        let wire = |k: &SigningKey| URL_SAFE_NO_PAD.encode(k.verifying_key().to_bytes());

        let transcript = BrowserEndorsementTranscript::from_wire(
            VECTOR_USER,
            &wire(&host),
            &wire(&endorser),
            &wire(&endorsed),
            VECTOR_DEVICE,
        )
        .expect("valid transcript");

        let digest = URL_SAFE_NO_PAD.encode(Sha256::digest(transcript.encode()));
        assert_eq!(transcript.encode().len(), 24 + 1 + 16 + 32 * 3 + 16);
        // The browser encoder asserts this same digest. If either side changes
        // the layout, endorsements stop verifying across runtimes -- silently,
        // since each side would still agree with itself.
        assert_eq!(digest, "zWI0kvAu5asJ4YKWiXSmlbSZM2u8_z7DOiVQ6vE220Y");
    }
}
