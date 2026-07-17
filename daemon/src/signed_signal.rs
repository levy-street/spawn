//! Canonical transcript and Ed25519 primitives for signed RTC signaling.
//!
//! This module intentionally does not persist keys or integrate with the live
//! signaling route. It only defines the bytes that later integration work can
//! sign and verify.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use curve25519_dalek::edwards::CompressedEdwardsY;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use thiserror::Error;
use uuid::Uuid;

pub const TRANSCRIPT_MAGIC: &[u8] = b"SPAWN-RTC-SIGNAL-SIG-V1";
pub const TRANSCRIPT_VERSION: u8 = 1;
pub const ED25519_PUBLIC_KEY_BYTES: usize = 32;
pub const ED25519_SIGNATURE_BYTES: usize = 64;
pub const MAX_SESSION_ID_BYTES: usize = 36;
pub const MAX_SCOPE_ID_BYTES: usize = 36;
pub const MAX_SDP_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum SignalKind {
    Offer = 1,
    Answer = 2,
}

impl TryFrom<u8> for SignalKind {
    type Error = SignedSignalError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::Offer),
            2 => Ok(Self::Answer),
            _ => Err(SignedSignalError::InvalidEnum {
                field: "signal_kind",
                value,
            }),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum ScopeType {
    Agent = 1,
    Host = 2,
}

impl TryFrom<u8> for ScopeType {
    type Error = SignedSignalError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::Agent),
            2 => Ok(Self::Host),
            _ => Err(SignedSignalError::InvalidEnum {
                field: "scope_type",
                value,
            }),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum SenderRole {
    Browser = 1,
    Daemon = 2,
}

impl TryFrom<u8> for SenderRole {
    type Error = SignedSignalError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::Browser),
            2 => Ok(Self::Daemon),
            _ => Err(SignedSignalError::InvalidEnum {
                field: "sender_role",
                value,
            }),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignedSignalTranscript {
    signal_kind: SignalKind,
    protocol_version: u32,
    session_id: String,
    scope_type: ScopeType,
    scope_id: String,
    sender_role: SenderRole,
    intended_peer_public_key: [u8; ED25519_PUBLIC_KEY_BYTES],
    sdp: String,
}

impl SignedSignalTranscript {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        signal_kind: SignalKind,
        protocol_version: u32,
        session_id: impl Into<String>,
        scope_type: ScopeType,
        scope_id: impl Into<String>,
        sender_role: SenderRole,
        intended_peer_public_key: [u8; ED25519_PUBLIC_KEY_BYTES],
        sdp: impl Into<String>,
    ) -> Result<Self, SignedSignalError> {
        let transcript = Self {
            signal_kind,
            protocol_version,
            session_id: session_id.into(),
            scope_type,
            scope_id: scope_id.into(),
            sender_role,
            intended_peer_public_key,
            sdp: sdp.into(),
        };
        transcript.validate()?;
        Ok(transcript)
    }

    pub fn signal_kind(&self) -> SignalKind {
        self.signal_kind
    }

    pub fn protocol_version(&self) -> u32 {
        self.protocol_version
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn scope_type(&self) -> ScopeType {
        self.scope_type
    }

    pub fn scope_id(&self) -> &str {
        &self.scope_id
    }

    pub fn sender_role(&self) -> SenderRole {
        self.sender_role
    }

    pub fn intended_peer_public_key(&self) -> &[u8; ED25519_PUBLIC_KEY_BYTES] {
        &self.intended_peer_public_key
    }

    pub fn sdp(&self) -> &str {
        &self.sdp
    }

    pub fn encode(&self) -> Result<Vec<u8>, SignedSignalError> {
        self.validate()?;
        let session_id = self.session_id.as_bytes();
        let scope_id = self.scope_id.as_bytes();
        let sdp = self.sdp.as_bytes();
        let capacity = TRANSCRIPT_MAGIC
            .len()
            .checked_add(1 + 1 + 4 + 2 + 1 + 2 + 1 + ED25519_PUBLIC_KEY_BYTES + 4)
            .and_then(|value| value.checked_add(session_id.len()))
            .and_then(|value| value.checked_add(scope_id.len()))
            .and_then(|value| value.checked_add(sdp.len()))
            .ok_or(SignedSignalError::LengthOverflow)?;
        let mut encoded = Vec::with_capacity(capacity);
        encoded.extend_from_slice(TRANSCRIPT_MAGIC);
        encoded.push(TRANSCRIPT_VERSION);
        encoded.push(self.signal_kind as u8);
        encoded.extend_from_slice(&self.protocol_version.to_be_bytes());
        push_u16_field(&mut encoded, session_id, "session_id")?;
        encoded.push(self.scope_type as u8);
        push_u16_field(&mut encoded, scope_id, "scope_id")?;
        encoded.push(self.sender_role as u8);
        encoded.extend_from_slice(&self.intended_peer_public_key);
        encoded.extend_from_slice(
            &u32::try_from(sdp.len())
                .map_err(|_| SignedSignalError::LengthOverflow)?
                .to_be_bytes(),
        );
        encoded.extend_from_slice(sdp);
        Ok(encoded)
    }

    pub fn decode(encoded: &[u8]) -> Result<Self, SignedSignalError> {
        let mut reader = Reader::new(encoded);
        if reader.take(TRANSCRIPT_MAGIC.len(), "magic")? != TRANSCRIPT_MAGIC {
            return Err(SignedSignalError::InvalidMagic);
        }
        let version = reader.u8("transcript_version")?;
        if version != TRANSCRIPT_VERSION {
            return Err(SignedSignalError::UnsupportedTranscriptVersion(version));
        }
        let signal_kind = SignalKind::try_from(reader.u8("signal_kind")?)?;
        let protocol_version = reader.u32("protocol_version")?;
        let session_id = reader.utf8_u16("session_id", MAX_SESSION_ID_BYTES)?;
        let scope_type = ScopeType::try_from(reader.u8("scope_type")?)?;
        let scope_id = reader.utf8_u16("scope_id", MAX_SCOPE_ID_BYTES)?;
        let sender_role = SenderRole::try_from(reader.u8("sender_role")?)?;
        let intended_peer_public_key = reader
            .take(ED25519_PUBLIC_KEY_BYTES, "intended_peer_public_key")?
            .try_into()
            .map_err(|_| SignedSignalError::InvalidLength {
                field: "intended_peer_public_key",
                min: ED25519_PUBLIC_KEY_BYTES,
                max: ED25519_PUBLIC_KEY_BYTES,
                actual: 0,
            })?;
        let sdp_length = usize::try_from(reader.u32("sdp_length")?)
            .map_err(|_| SignedSignalError::LengthOverflow)?;
        validate_length("sdp", sdp_length, 1, MAX_SDP_BYTES)?;
        let sdp = reader.utf8_exact("sdp", sdp_length)?;
        if !reader.is_empty() {
            return Err(SignedSignalError::TrailingBytes(reader.remaining()));
        }
        Self::new(
            signal_kind,
            protocol_version,
            session_id,
            scope_type,
            scope_id,
            sender_role,
            intended_peer_public_key,
            sdp,
        )
    }

    fn validate(&self) -> Result<(), SignedSignalError> {
        if self.protocol_version == 0 {
            return Err(SignedSignalError::InvalidProtocolVersion);
        }
        validate_canonical_uuid("session_id", &self.session_id, MAX_SESSION_ID_BYTES)?;
        validate_canonical_uuid("scope_id", &self.scope_id, MAX_SCOPE_ID_BYTES)?;
        strict_verifying_key_from_bytes(&self.intended_peer_public_key)?;
        validate_length("sdp", self.sdp.len(), 1, MAX_SDP_BYTES)
    }
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum SignedSignalError {
    #[error("invalid transcript magic")]
    InvalidMagic,
    #[error("unsupported transcript version {0}")]
    UnsupportedTranscriptVersion(u8),
    #[error("invalid {field} enum value {value}")]
    InvalidEnum { field: &'static str, value: u8 },
    #[error("protocol_version must be nonzero")]
    InvalidProtocolVersion,
    #[error("invalid {field} length {actual}; expected {min}..={max} bytes")]
    InvalidLength {
        field: &'static str,
        min: usize,
        max: usize,
        actual: usize,
    },
    #[error("invalid UTF-8 in {0}")]
    InvalidUtf8(&'static str),
    #[error("{0} must be an exact lowercase-hyphenated canonical UUID")]
    InvalidCanonicalUuid(&'static str),
    #[error("truncated transcript while reading {0}")]
    Truncated(&'static str),
    #[error("transcript has {0} trailing bytes")]
    TrailingBytes(usize),
    #[error("transcript length overflow")]
    LengthOverflow,
    #[error("invalid canonical base64url {0}")]
    InvalidBase64Url(&'static str),
    #[error("invalid Ed25519 public key")]
    InvalidPublicKey,
    #[error("invalid Ed25519 signature")]
    InvalidSignature,
    #[error("operating-system randomness unavailable")]
    RandomnessUnavailable,
}

fn validate_canonical_uuid(
    field: &'static str,
    value: &str,
    exact_length: usize,
) -> Result<(), SignedSignalError> {
    validate_length(field, value.len(), exact_length, exact_length)?;
    let parsed =
        Uuid::parse_str(value).map_err(|_| SignedSignalError::InvalidCanonicalUuid(field))?;
    if parsed.to_string() != value {
        return Err(SignedSignalError::InvalidCanonicalUuid(field));
    }
    Ok(())
}

pub fn generate_signing_key() -> Result<SigningKey, SignedSignalError> {
    let mut seed = [0_u8; 32];
    getrandom::getrandom(&mut seed).map_err(|_| SignedSignalError::RandomnessUnavailable)?;
    let signing_key = SigningKey::from_bytes(&seed);
    // SigningKey owns and zeroizes its seed; clear the temporary stack copy.
    use zeroize::Zeroize;
    seed.zeroize();
    Ok(signing_key)
}

#[cfg(test)]
fn signing_key_from_seed(seed: &[u8]) -> Result<SigningKey, SignedSignalError> {
    let seed: &[u8; 32] = seed
        .try_into()
        .map_err(|_| SignedSignalError::InvalidLength {
            field: "signing_seed",
            min: 32,
            max: 32,
            actual: seed.len(),
        })?;
    Ok(SigningKey::from_bytes(seed))
}

pub fn sign_transcript(
    signing_key: &SigningKey,
    transcript: &SignedSignalTranscript,
) -> Result<Signature, SignedSignalError> {
    Ok(signing_key.sign(&transcript.encode()?))
}

pub fn verify_transcript(
    verifying_key: &VerifyingKey,
    transcript: &SignedSignalTranscript,
    signature: &Signature,
) -> Result<(), SignedSignalError> {
    verifying_key
        .verify_strict(&transcript.encode()?, signature)
        .map_err(|_| SignedSignalError::InvalidSignature)
}

pub fn public_key_to_wire(verifying_key: &VerifyingKey) -> String {
    URL_SAFE_NO_PAD.encode(verifying_key.as_bytes())
}

pub fn public_key_from_wire(value: &str) -> Result<VerifyingKey, SignedSignalError> {
    let decoded = decode_wire_exact::<ED25519_PUBLIC_KEY_BYTES>(value, "public_key")?;
    strict_verifying_key_from_bytes(&decoded)
}

fn strict_verifying_key_from_bytes(
    decoded: &[u8; ED25519_PUBLIC_KEY_BYTES],
) -> Result<VerifyingKey, SignedSignalError> {
    let compressed = CompressedEdwardsY(*decoded);
    let point = compressed
        .decompress()
        .ok_or(SignedSignalError::InvalidPublicKey)?;
    // ed25519-dalek intentionally accepts ZIP-215 encodings. Recompressing the
    // decoded point makes the RFC 8032 canonical-encoding requirement explicit
    // without maintaining field arithmetic here.
    if point.compress().to_bytes() != *decoded {
        return Err(SignedSignalError::InvalidPublicKey);
    }
    let key = VerifyingKey::from_bytes(decoded).map_err(|_| SignedSignalError::InvalidPublicKey)?;
    if key.is_weak() {
        return Err(SignedSignalError::InvalidPublicKey);
    }
    Ok(key)
}

pub fn signature_to_wire(signature: &Signature) -> String {
    URL_SAFE_NO_PAD.encode(signature.to_bytes())
}

pub fn signature_from_wire(value: &str) -> Result<Signature, SignedSignalError> {
    let decoded = decode_wire_exact::<ED25519_SIGNATURE_BYTES>(value, "signature")?;
    Ok(Signature::from_bytes(&decoded))
}

pub fn sign_transcript_wire(
    signing_key: &SigningKey,
    transcript: &SignedSignalTranscript,
) -> Result<String, SignedSignalError> {
    Ok(signature_to_wire(&sign_transcript(
        signing_key,
        transcript,
    )?))
}

pub fn verify_transcript_wire(
    verifying_key: &VerifyingKey,
    transcript: &SignedSignalTranscript,
    signature: &str,
) -> Result<(), SignedSignalError> {
    verify_transcript(verifying_key, transcript, &signature_from_wire(signature)?)
}

fn validate_length(
    field: &'static str,
    actual: usize,
    min: usize,
    max: usize,
) -> Result<(), SignedSignalError> {
    if !(min..=max).contains(&actual) {
        return Err(SignedSignalError::InvalidLength {
            field,
            min,
            max,
            actual,
        });
    }
    Ok(())
}

fn push_u16_field(
    output: &mut Vec<u8>,
    value: &[u8],
    field: &'static str,
) -> Result<(), SignedSignalError> {
    let length = u16::try_from(value.len()).map_err(|_| SignedSignalError::InvalidLength {
        field,
        min: 1,
        max: usize::from(u16::MAX),
        actual: value.len(),
    })?;
    output.extend_from_slice(&length.to_be_bytes());
    output.extend_from_slice(value);
    Ok(())
}

fn decode_wire_exact<const N: usize>(
    value: &str,
    field: &'static str,
) -> Result<[u8; N], SignedSignalError> {
    let encoded_length = (N / 3) * 4
        + match N % 3 {
            0 => 0,
            1 => 2,
            _ => 3,
        };
    // Reject wrong widths before alphabet scanning, transformation, or decode.
    // Public keys are exactly 43 characters and signatures exactly 86.
    if value.len() != encoded_length
        || value.contains('=')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(SignedSignalError::InvalidBase64Url(field));
    }
    let mut decoded = [0_u8; N];
    let decoded_length = URL_SAFE_NO_PAD
        .decode_slice(value, &mut decoded)
        .map_err(|_| SignedSignalError::InvalidBase64Url(field))?;
    if decoded_length != N || URL_SAFE_NO_PAD.encode(decoded) != value {
        return Err(SignedSignalError::InvalidBase64Url(field));
    }
    Ok(decoded)
}

struct Reader<'a> {
    input: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn new(input: &'a [u8]) -> Self {
        Self { input, offset: 0 }
    }

    fn take(&mut self, length: usize, field: &'static str) -> Result<&'a [u8], SignedSignalError> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or(SignedSignalError::LengthOverflow)?;
        let value = self
            .input
            .get(self.offset..end)
            .ok_or(SignedSignalError::Truncated(field))?;
        self.offset = end;
        Ok(value)
    }

    fn u8(&mut self, field: &'static str) -> Result<u8, SignedSignalError> {
        Ok(self.take(1, field)?[0])
    }

    fn u16(&mut self, field: &'static str) -> Result<u16, SignedSignalError> {
        let bytes: [u8; 2] = self
            .take(2, field)?
            .try_into()
            .map_err(|_| SignedSignalError::Truncated(field))?;
        Ok(u16::from_be_bytes(bytes))
    }

    fn u32(&mut self, field: &'static str) -> Result<u32, SignedSignalError> {
        let bytes: [u8; 4] = self
            .take(4, field)?
            .try_into()
            .map_err(|_| SignedSignalError::Truncated(field))?;
        Ok(u32::from_be_bytes(bytes))
    }

    fn utf8_u16(&mut self, field: &'static str, max: usize) -> Result<String, SignedSignalError> {
        let length = usize::from(self.u16(field)?);
        validate_length(field, length, 1, max)?;
        self.utf8_exact(field, length)
    }

    fn utf8_exact(
        &mut self,
        field: &'static str,
        length: usize,
    ) -> Result<String, SignedSignalError> {
        std::str::from_utf8(self.take(length, field)?)
            .map(str::to_owned)
            .map_err(|_| SignedSignalError::InvalidUtf8(field))
    }

    fn remaining(&self) -> usize {
        self.input.len() - self.offset
    }

    fn is_empty(&self) -> bool {
        self.remaining() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use sha2::{Digest, Sha256};

    const TEST_SESSION_ID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const TEST_SCOPE_ID: &str = "bbbbbbbb-2222-4333-8444-555555555555";
    const MUTATED_SESSION_ID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeef";
    const MUTATED_SCOPE_ID: &str = "11111111-2222-4333-8444-555555555556";

    #[derive(Deserialize)]
    struct GoldenFile {
        format: String,
        signing_key: GoldenKey,
        intended_peer_key: GoldenKey,
        mutation_fields: Vec<String>,
        vectors: Vec<GoldenVector>,
    }

    #[derive(Deserialize)]
    struct GoldenKey {
        #[serde(default)]
        seed_hex: String,
        public_key_hex: String,
        public_key_wire: String,
    }

    #[derive(Deserialize)]
    struct GoldenVector {
        id: String,
        signal_kind: String,
        protocol_version: u32,
        session_id: String,
        scope_type: String,
        scope_id: String,
        sender_role: String,
        intended_peer_public_key_hex: String,
        sdp: String,
        transcript_hex: String,
        sha256_hex: String,
        signature_hex: String,
        signature_wire: String,
        replay_signature_from: String,
    }

    #[derive(Deserialize)]
    struct NegativeKeyFile {
        format: String,
        weak_public_keys: Vec<NegativeKeyVector>,
        noncanonical_public_key_hex: Vec<String>,
        invalid_encodings: Vec<NegativeKeyVector>,
        accepted_mixed_torsion_public_key_hex: Vec<String>,
        universal_forgery: UniversalForgery,
    }

    #[derive(Deserialize)]
    struct NegativeKeyVector {
        id: String,
        public_key_hex: String,
    }

    #[derive(Deserialize)]
    struct UniversalForgery {
        public_key_id: String,
        signature_hex: String,
    }

    fn golden() -> GoldenFile {
        serde_json::from_str(include_str!("../../proto/signed-signal-v1-vectors.json")).unwrap()
    }

    fn negative_keys() -> NegativeKeyFile {
        serde_json::from_str(include_str!(
            "../../proto/ed25519-public-key-negative-vectors.json"
        ))
        .unwrap()
    }

    fn hex(value: &str) -> Vec<u8> {
        assert_eq!(value.len() % 2, 0);
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let text = std::str::from_utf8(pair).unwrap();
                u8::from_str_radix(text, 16).unwrap()
            })
            .collect()
    }

    fn hex_string(value: impl AsRef<[u8]>) -> String {
        value
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    fn valid_peer_key() -> [u8; ED25519_PUBLIC_KEY_BYTES] {
        hex(&golden().intended_peer_key.public_key_hex)
            .try_into()
            .unwrap()
    }

    fn transcript(vector: &GoldenVector) -> SignedSignalTranscript {
        let peer: [u8; 32] = hex(&vector.intended_peer_public_key_hex)
            .try_into()
            .unwrap();
        SignedSignalTranscript::new(
            match vector.signal_kind.as_str() {
                "offer" => SignalKind::Offer,
                "answer" => SignalKind::Answer,
                other => panic!("unknown golden signal kind: {other}"),
            },
            vector.protocol_version,
            &vector.session_id,
            match vector.scope_type.as_str() {
                "agent" => ScopeType::Agent,
                "host" => ScopeType::Host,
                other => panic!("unknown golden scope type: {other}"),
            },
            &vector.scope_id,
            match vector.sender_role.as_str() {
                "browser" => SenderRole::Browser,
                "daemon" => SenderRole::Daemon,
                other => panic!("unknown golden sender role: {other}"),
            },
            peer,
            &vector.sdp,
        )
        .unwrap()
    }

    fn mutated(original: &SignedSignalTranscript, field: &str) -> SignedSignalTranscript {
        let signal_kind = if field == "signal_kind" {
            match original.signal_kind() {
                SignalKind::Offer => SignalKind::Answer,
                SignalKind::Answer => SignalKind::Offer,
            }
        } else {
            original.signal_kind()
        };
        let protocol_version =
            original.protocol_version() + if field == "protocol_version" { 1 } else { 0 };
        let session_id = if field == "session_id" {
            MUTATED_SESSION_ID.to_owned()
        } else {
            original.session_id().to_owned()
        };
        let scope_type = if field == "scope_type" {
            match original.scope_type() {
                ScopeType::Agent => ScopeType::Host,
                ScopeType::Host => ScopeType::Agent,
            }
        } else {
            original.scope_type()
        };
        let scope_id = if field == "scope_id" {
            MUTATED_SCOPE_ID.to_owned()
        } else {
            original.scope_id().to_owned()
        };
        let sender_role = if field == "sender_role" {
            match original.sender_role() {
                SenderRole::Browser => SenderRole::Daemon,
                SenderRole::Daemon => SenderRole::Browser,
            }
        } else {
            original.sender_role()
        };
        let mut peer = *original.intended_peer_public_key();
        if field == "intended_peer_public_key" {
            peer = hex(&golden().signing_key.public_key_hex)
                .try_into()
                .unwrap();
        }
        let sdp = if field == "sdp" {
            format!("{}a=x-mutated:1\r\n", original.sdp())
        } else {
            original.sdp().to_owned()
        };
        SignedSignalTranscript::new(
            signal_kind,
            protocol_version,
            session_id,
            scope_type,
            scope_id,
            sender_role,
            peer,
            sdp,
        )
        .unwrap()
    }

    fn example() -> SignedSignalTranscript {
        SignedSignalTranscript::new(
            SignalKind::Offer,
            2,
            TEST_SESSION_ID,
            ScopeType::Agent,
            TEST_SCOPE_ID,
            SenderRole::Browser,
            valid_peer_key(),
            "v=0\r\ns=spawn\r\n",
        )
        .unwrap()
    }

    #[test]
    fn transcript_round_trip_and_domain_separation() {
        let transcript = example();
        let encoded = transcript.encode().unwrap();
        assert!(encoded.starts_with(TRANSCRIPT_MAGIC));
        assert_eq!(
            SignedSignalTranscript::decode(&encoded).unwrap(),
            transcript
        );

        let mut bad_magic = encoded.clone();
        bad_magic[0] ^= 1;
        assert_eq!(
            SignedSignalTranscript::decode(&bad_magic),
            Err(SignedSignalError::InvalidMagic)
        );
        let mut bad_version = encoded;
        bad_version[TRANSCRIPT_MAGIC.len()] = TRANSCRIPT_VERSION + 1;
        assert_eq!(
            SignedSignalTranscript::decode(&bad_version),
            Err(SignedSignalError::UnsupportedTranscriptVersion(2))
        );
    }

    #[test]
    fn session_and_scope_ids_are_exact_canonical_uuid_text_on_encode_and_decode() {
        let invalid = [
            "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
            "aaaaaaaabbbb4ccc8dddeeeeeeeeeeee",
            "{aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee}",
            " aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee ",
            "not-a-uuid-not-a-uuid-not-a-uuid!!!",
        ];
        for value in invalid {
            assert!(matches!(
                SignedSignalTranscript::new(
                    SignalKind::Offer,
                    2,
                    value,
                    ScopeType::Agent,
                    TEST_SCOPE_ID,
                    SenderRole::Browser,
                    valid_peer_key(),
                    "v=0",
                ),
                Err(SignedSignalError::InvalidLength {
                    field: "session_id",
                    ..
                }) | Err(SignedSignalError::InvalidCanonicalUuid("session_id"))
            ));
            assert!(matches!(
                SignedSignalTranscript::new(
                    SignalKind::Offer,
                    2,
                    TEST_SESSION_ID,
                    ScopeType::Agent,
                    value,
                    SenderRole::Browser,
                    valid_peer_key(),
                    "v=0",
                ),
                Err(SignedSignalError::InvalidLength {
                    field: "scope_id",
                    ..
                }) | Err(SignedSignalError::InvalidCanonicalUuid("scope_id"))
            ));
        }

        let mut uppercase_session = example().encode().unwrap();
        let session_offset = TRANSCRIPT_MAGIC.len() + 1 + 1 + 4 + 2;
        uppercase_session[session_offset] = b'A';
        assert_eq!(
            SignedSignalTranscript::decode(&uppercase_session),
            Err(SignedSignalError::InvalidCanonicalUuid("session_id"))
        );

        let mut uppercase_scope = example().encode().unwrap();
        let scope_offset = session_offset + MAX_SESSION_ID_BYTES + 1 + 2;
        uppercase_scope[scope_offset] = b'B';
        assert_eq!(
            SignedSignalTranscript::decode(&uppercase_scope),
            Err(SignedSignalError::InvalidCanonicalUuid("scope_id"))
        );
    }

    #[test]
    fn transcript_rejects_bounds_invalid_utf8_and_trailing_bytes() {
        assert!(matches!(
            SignedSignalTranscript::new(
                SignalKind::Offer,
                0,
                TEST_SESSION_ID,
                ScopeType::Agent,
                TEST_SCOPE_ID,
                SenderRole::Browser,
                valid_peer_key(),
                "v=0",
            ),
            Err(SignedSignalError::InvalidProtocolVersion)
        ));
        assert!(matches!(
            SignedSignalTranscript::new(
                SignalKind::Offer,
                1,
                "x".repeat(MAX_SESSION_ID_BYTES + 1),
                ScopeType::Agent,
                TEST_SCOPE_ID,
                SenderRole::Browser,
                valid_peer_key(),
                "v=0",
            ),
            Err(SignedSignalError::InvalidLength {
                field: "session_id",
                ..
            })
        ));
        assert!(SignedSignalTranscript::new(
            SignalKind::Answer,
            u32::MAX,
            TEST_SESSION_ID,
            ScopeType::Host,
            TEST_SCOPE_ID,
            SenderRole::Daemon,
            valid_peer_key(),
            "s".repeat(MAX_SDP_BYTES),
        )
        .is_ok());
        for (field, session, scope, sdp) in [
            (
                "session_id",
                "s".repeat(MAX_SESSION_ID_BYTES + 1),
                TEST_SCOPE_ID.to_owned(),
                "v=0".to_owned(),
            ),
            (
                "scope_id",
                TEST_SESSION_ID.to_owned(),
                "h".repeat(MAX_SCOPE_ID_BYTES + 1),
                "v=0".to_owned(),
            ),
            (
                "sdp",
                TEST_SESSION_ID.to_owned(),
                TEST_SCOPE_ID.to_owned(),
                "x".repeat(MAX_SDP_BYTES + 1),
            ),
        ] {
            assert!(matches!(
                SignedSignalTranscript::new(
                    SignalKind::Offer,
                    1,
                    session,
                    ScopeType::Agent,
                    scope,
                    SenderRole::Browser,
                    valid_peer_key(),
                    sdp,
                ),
                Err(SignedSignalError::InvalidLength { field: actual, .. }) if actual == field
            ));
        }
        let mut encoded = example().encode().unwrap();
        encoded.push(0);
        assert!(matches!(
            SignedSignalTranscript::decode(&encoded),
            Err(SignedSignalError::TrailingBytes(1))
        ));

        let session_offset = TRANSCRIPT_MAGIC.len() + 1 + 1 + 4 + 2;
        let mut invalid_utf8 = example().encode().unwrap();
        invalid_utf8[session_offset] = 0xff;
        assert_eq!(
            SignedSignalTranscript::decode(&invalid_utf8),
            Err(SignedSignalError::InvalidUtf8("session_id"))
        );
        let complete = example().encode().unwrap();
        assert!(matches!(
            SignedSignalTranscript::decode(&complete[..complete.len() - 1]),
            Err(SignedSignalError::Truncated(_))
        ));

        let mut invalid_kind = example().encode().unwrap();
        invalid_kind[TRANSCRIPT_MAGIC.len() + 1] = 0xff;
        assert!(matches!(
            SignedSignalTranscript::decode(&invalid_kind),
            Err(SignedSignalError::InvalidEnum {
                field: "signal_kind",
                value: 0xff
            })
        ));
        let valid = example().encode().unwrap();
        let session_length_offset = TRANSCRIPT_MAGIC.len() + 1 + 1 + 4;
        let session_length = usize::from(u16::from_be_bytes(
            valid[session_length_offset..session_length_offset + 2]
                .try_into()
                .unwrap(),
        ));
        let scope_type_offset = session_length_offset + 2 + session_length;
        let scope_length_offset = scope_type_offset + 1;
        let scope_length = usize::from(u16::from_be_bytes(
            valid[scope_length_offset..scope_length_offset + 2]
                .try_into()
                .unwrap(),
        ));
        let sender_role_offset = scope_length_offset + 2 + scope_length;
        for (offset, field) in [
            (scope_type_offset, "scope_type"),
            (sender_role_offset, "sender_role"),
        ] {
            let mut invalid = valid.clone();
            invalid[offset] = 0xff;
            assert!(matches!(
                SignedSignalTranscript::decode(&invalid),
                Err(SignedSignalError::InvalidEnum {
                    field: actual,
                    value: 0xff
                }) if actual == field
            ));
        }
    }

    #[test]
    fn signing_and_canonical_wire_helpers_are_strict() {
        let signing_key = generate_signing_key().unwrap();
        let verifying_key = signing_key.verifying_key();
        let transcript = example();
        let signature = sign_transcript(&signing_key, &transcript).unwrap();
        verify_transcript(&verifying_key, &transcript, &signature).unwrap();

        let public_wire = public_key_to_wire(&verifying_key);
        assert_eq!(public_key_from_wire(&public_wire).unwrap(), verifying_key);
        let signature_wire = signature_to_wire(&signature);
        verify_transcript_wire(&verifying_key, &transcript, &signature_wire).unwrap();
        assert!(public_key_from_wire(&(public_wire + "=")).is_err());
        assert!(signature_from_wire("not+base64url").is_err());
        assert!(signing_key_from_seed(&[0; 31]).is_err());
        assert!(public_key_from_wire("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").is_err());
    }

    #[test]
    fn fixed_width_wire_decode_rejects_large_input_before_decode() {
        let huge = "A".repeat(16 * 1024 * 1024);
        assert_eq!(
            public_key_from_wire(&huge),
            Err(SignedSignalError::InvalidBase64Url("public_key"))
        );
        assert_eq!(
            signature_from_wire(&huge),
            Err(SignedSignalError::InvalidBase64Url("signature"))
        );
    }

    #[test]
    fn shared_negative_public_key_corpus_is_strict_and_complete() {
        use ed25519_dalek::Verifier;

        let corpus = negative_keys();
        assert_eq!(corpus.format, "spawn-ed25519-public-key-negative-v1");
        assert_eq!(corpus.weak_public_keys.len(), 8);
        assert_eq!(corpus.noncanonical_public_key_hex.len(), 40);
        for vector in &corpus.weak_public_keys {
            let raw: [u8; ED25519_PUBLIC_KEY_BYTES] =
                hex(&vector.public_key_hex).try_into().unwrap();
            let weak = VerifyingKey::from_bytes(&raw).unwrap();
            assert!(weak.is_weak(), "{} was not a weak dalek key", vector.id);
            assert_eq!(
                public_key_from_wire(&URL_SAFE_NO_PAD.encode(raw)),
                Err(SignedSignalError::InvalidPublicKey),
                "{}",
                vector.id
            );
        }
        for (index, public_key_hex) in corpus.noncanonical_public_key_hex.iter().enumerate() {
            let raw: [u8; ED25519_PUBLIC_KEY_BYTES] = hex(public_key_hex).try_into().unwrap();
            assert_eq!(
                public_key_from_wire(&URL_SAFE_NO_PAD.encode(raw)),
                Err(SignedSignalError::InvalidPublicKey),
                "noncanonical-{index}"
            );
        }
        for vector in &corpus.invalid_encodings {
            let raw: [u8; ED25519_PUBLIC_KEY_BYTES] =
                hex(&vector.public_key_hex).try_into().unwrap();
            assert_eq!(
                public_key_from_wire(&URL_SAFE_NO_PAD.encode(raw)),
                Err(SignedSignalError::InvalidPublicKey),
                "{}",
                vector.id
            );
        }
        assert_eq!(corpus.accepted_mixed_torsion_public_key_hex.len(), 7);
        for public_key_hex in &corpus.accepted_mixed_torsion_public_key_hex {
            let raw: [u8; ED25519_PUBLIC_KEY_BYTES] = hex(public_key_hex).try_into().unwrap();
            let point = CompressedEdwardsY(raw).decompress().unwrap();
            assert!(!point.is_torsion_free());
            let accepted = public_key_from_wire(&URL_SAFE_NO_PAD.encode(raw)).unwrap();
            assert!(!accepted.is_weak());
        }

        let identity = corpus
            .weak_public_keys
            .iter()
            .find(|vector| vector.id == corpus.universal_forgery.public_key_id)
            .unwrap();
        let weak =
            VerifyingKey::from_bytes(&hex(&identity.public_key_hex).try_into().unwrap()).unwrap();
        let signature = Signature::from_bytes(
            &hex(&corpus.universal_forgery.signature_hex)
                .try_into()
                .unwrap(),
        );
        let encoded = example().encode().unwrap();
        assert!(weak.verify(&encoded, &signature).is_ok());
        assert!(weak.verify_strict(&encoded, &signature).is_err());
    }

    #[test]
    fn intended_peer_key_uses_the_full_strict_point_contract_at_every_core_boundary() {
        let corpus = negative_keys();
        let mut rejected = Vec::new();
        rejected.extend(
            corpus
                .weak_public_keys
                .iter()
                .map(|vector| (vector.id.clone(), vector.public_key_hex.clone())),
        );
        rejected.extend(
            corpus
                .noncanonical_public_key_hex
                .iter()
                .enumerate()
                .map(|(index, value)| (format!("noncanonical-{index}"), value.clone())),
        );
        rejected.extend(
            corpus
                .invalid_encodings
                .iter()
                .map(|vector| (vector.id.clone(), vector.public_key_hex.clone())),
        );
        assert_eq!(rejected.len(), 49);

        let signing_key = signing_key_from_seed(&hex(&golden().signing_key.seed_hex)).unwrap();
        let valid = example();
        let signature = sign_transcript(&signing_key, &valid).unwrap();
        let peer_offset = TRANSCRIPT_MAGIC.len()
            + 1
            + 1
            + 4
            + 2
            + MAX_SESSION_ID_BYTES
            + 1
            + 2
            + MAX_SCOPE_ID_BYTES
            + 1;
        for (id, public_key_hex) in rejected {
            let raw: [u8; ED25519_PUBLIC_KEY_BYTES] = hex(&public_key_hex).try_into().unwrap();
            assert_eq!(
                SignedSignalTranscript::new(
                    SignalKind::Offer,
                    2,
                    TEST_SESSION_ID,
                    ScopeType::Agent,
                    TEST_SCOPE_ID,
                    SenderRole::Browser,
                    raw,
                    "v=0",
                ),
                Err(SignedSignalError::InvalidPublicKey),
                "constructor: {id}"
            );

            let mut forged_core = valid.clone();
            forged_core.intended_peer_public_key = raw;
            assert_eq!(
                forged_core.encode(),
                Err(SignedSignalError::InvalidPublicKey),
                "encoder: {id}"
            );
            assert_eq!(
                sign_transcript(&signing_key, &forged_core),
                Err(SignedSignalError::InvalidPublicKey),
                "signer: {id}"
            );
            assert_eq!(
                verify_transcript(&signing_key.verifying_key(), &forged_core, &signature),
                Err(SignedSignalError::InvalidPublicKey),
                "verifier: {id}"
            );

            let mut forged_wire = valid.encode().unwrap();
            forged_wire[peer_offset..peer_offset + ED25519_PUBLIC_KEY_BYTES].copy_from_slice(&raw);
            assert_eq!(
                SignedSignalTranscript::decode(&forged_wire),
                Err(SignedSignalError::InvalidPublicKey),
                "decoder: {id}"
            );
        }

        assert_eq!(corpus.accepted_mixed_torsion_public_key_hex.len(), 7);
        for public_key_hex in &corpus.accepted_mixed_torsion_public_key_hex {
            let raw: [u8; ED25519_PUBLIC_KEY_BYTES] = hex(public_key_hex).try_into().unwrap();
            let accepted = SignedSignalTranscript::new(
                SignalKind::Offer,
                2,
                TEST_SESSION_ID,
                ScopeType::Agent,
                TEST_SCOPE_ID,
                SenderRole::Browser,
                raw,
                "v=0",
            )
            .unwrap();
            let encoded = accepted.encode().unwrap();
            assert_eq!(SignedSignalTranscript::decode(&encoded).unwrap(), accepted);
            let signature = sign_transcript(&signing_key, &accepted).unwrap();
            verify_transcript(&signing_key.verifying_key(), &accepted, &signature).unwrap();
        }
    }

    #[test]
    fn shared_golden_vectors_match_bytes_hashes_signatures_and_mutations() {
        let golden = golden();
        assert_eq!(golden.format, "spawn-signed-signal-v1");
        assert_eq!(
            golden.mutation_fields,
            [
                "signal_kind",
                "protocol_version",
                "session_id",
                "scope_type",
                "scope_id",
                "sender_role",
                "intended_peer_public_key",
                "sdp",
            ]
        );
        let signing_key = signing_key_from_seed(&hex(&golden.signing_key.seed_hex)).unwrap();
        let verifying_key = signing_key.verifying_key();
        assert_eq!(
            hex_string(verifying_key.as_bytes()),
            golden.signing_key.public_key_hex
        );
        assert_eq!(
            public_key_to_wire(&verifying_key),
            golden.signing_key.public_key_wire
        );
        assert_eq!(
            hex_string(
                public_key_from_wire(&golden.intended_peer_key.public_key_wire)
                    .unwrap()
                    .as_bytes()
            ),
            golden.intended_peer_key.public_key_hex
        );

        for vector in &golden.vectors {
            let transcript = transcript(vector);
            let encoded = transcript.encode().unwrap();
            assert_eq!(hex_string(&encoded), vector.transcript_hex, "{}", vector.id);
            assert_eq!(
                hex_string(Sha256::digest(&encoded)),
                vector.sha256_hex,
                "{}",
                vector.id
            );
            assert_eq!(
                SignedSignalTranscript::decode(&hex(&vector.transcript_hex)).unwrap(),
                transcript
            );
            let signature = sign_transcript(&signing_key, &transcript).unwrap();
            assert_eq!(
                hex_string(signature.to_bytes()),
                vector.signature_hex,
                "{}",
                vector.id
            );
            assert_eq!(
                signature_to_wire(&signature),
                vector.signature_wire,
                "{}",
                vector.id
            );
            verify_transcript_wire(&verifying_key, &transcript, &vector.signature_wire).unwrap();
            for field in &golden.mutation_fields {
                assert!(
                    verify_transcript_wire(
                        &verifying_key,
                        &mutated(&transcript, field),
                        &vector.signature_wire,
                    )
                    .is_err(),
                    "{} signature accepted mutated {field}",
                    vector.id
                );
            }
        }

        for vector in &golden.vectors {
            let replay = golden
                .vectors
                .iter()
                .find(|candidate| candidate.id == vector.replay_signature_from)
                .unwrap();
            assert!(verify_transcript_wire(
                &verifying_key,
                &transcript(vector),
                &replay.signature_wire,
            )
            .is_err());
        }
    }
}
