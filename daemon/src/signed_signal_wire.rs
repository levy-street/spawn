//! Strict JSON wire adapter for signed RTC offers and answers.
//!
//! This module is deliberately transport-independent. It does not install the
//! envelope on a WebSocket route or establish trust in either endpoint key.

use ed25519_dalek::{SigningKey, VerifyingKey};
use serde::{
    de::{self, Visitor},
    Deserialize, Deserializer, Serialize,
};
use std::fmt;
use thiserror::Error;

use crate::signed_signal::{
    public_key_from_wire, public_key_to_wire, sign_transcript_wire, verify_transcript_wire,
    ScopeType, SenderRole, SignalKind, SignedSignalError, SignedSignalTranscript,
    MAX_SCOPE_ID_BYTES, MAX_SDP_BYTES, MAX_SESSION_ID_BYTES,
};

pub const SIGNATURE_ALGORITHM: &str = "ed25519";
// JSON escaping can expand every byte of a bounded transcript text field to
// six ASCII bytes. The fixed allowance covers keys, names, punctuation, and
// the signature without making parser memory depend on untrusted input.
pub const MAX_SIGNED_RTC_WIRE_BYTES: usize =
    6 * (MAX_SESSION_ID_BYTES + MAX_SCOPE_ID_BYTES + MAX_SDP_BYTES) + 2048;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RtcProtocol {
    Session,
    Host,
}

impl RtcProtocol {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Session => "spawn.pty",
            Self::Host => "spawn.host.ctl",
        }
    }

    fn parse(value: &str) -> Result<Self, SignedRtcWireError> {
        match value {
            "spawn.pty" => Ok(Self::Session),
            "spawn.host.ctl" => Ok(Self::Host),
            _ => Err(SignedRtcWireError::InvalidEnum("protocol")),
        }
    }

    fn validate_scope(self, scope: ScopeType) -> Result<(), SignedRtcWireError> {
        if matches!(
            (self, scope),
            (Self::Session, ScopeType::Session) | (Self::Host, ScopeType::Host)
        ) {
            Ok(())
        } else {
            Err(SignedRtcWireError::InconsistentTuple(
                "protocol does not match scope_type",
            ))
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedRtcSignal {
    protocol: RtcProtocol,
    sender_public_key: VerifyingKey,
    transcript: SignedSignalTranscript,
}

impl VerifiedRtcSignal {
    pub fn protocol(&self) -> RtcProtocol {
        self.protocol
    }

    pub fn sender_public_key(&self) -> &VerifyingKey {
        &self.sender_public_key
    }

    pub fn transcript(&self) -> &SignedSignalTranscript {
        &self.transcript
    }
}

#[derive(Debug, Error)]
pub enum SignedRtcWireError {
    #[error("signed RTC envelope exceeds its fixed wire bound")]
    WireTooLarge,
    #[error("invalid signed RTC envelope JSON: {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("unsupported signature algorithm")]
    UnsupportedAlgorithm,
    #[error("invalid {0} value")]
    InvalidEnum(&'static str),
    #[error("inconsistent signed RTC tuple: {0}")]
    InconsistentTuple(&'static str),
    #[error("sender identity public key does not match the expected pin")]
    SenderPinMismatch,
    #[error("intended peer identity public key does not match the expected pin")]
    IntendedPeerPinMismatch,
    #[error(transparent)]
    SignedSignal(#[from] SignedSignalError),
}

impl PartialEq for SignedRtcWireError {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::WireTooLarge, Self::WireTooLarge)
            | (Self::UnsupportedAlgorithm, Self::UnsupportedAlgorithm)
            | (Self::SenderPinMismatch, Self::SenderPinMismatch)
            | (Self::IntendedPeerPinMismatch, Self::IntendedPeerPinMismatch) => true,
            (Self::InvalidEnum(left), Self::InvalidEnum(right))
            | (Self::InconsistentTuple(left), Self::InconsistentTuple(right)) => left == right,
            (Self::SignedSignal(left), Self::SignedSignal(right)) => left == right,
            (Self::InvalidJson(_), Self::InvalidJson(_)) => true,
            _ => false,
        }
    }
}

impl Eq for SignedRtcWireError {}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SignedRtcEnvelope {
    #[serde(rename = "type")]
    signal_type: String,
    signature_algorithm: String,
    sender_identity_public_key: String,
    intended_peer_identity_public_key: String,
    protocol: String,
    #[serde(deserialize_with = "deserialize_protocol_version")]
    protocol_version: u32,
    session_id: String,
    scope_type: String,
    scope_id: String,
    sender_role: String,
    sdp: String,
    signature: String,
}

fn deserialize_protocol_version<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    struct ProtocolVersionVisitor;

    impl Visitor<'_> for ProtocolVersionVisitor {
        type Value = u32;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a finite integral JSON number in 1..=2^32-1")
        }

        fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            u32::try_from(value)
                .ok()
                .filter(|value| *value != 0)
                .ok_or_else(|| E::invalid_value(de::Unexpected::Unsigned(value), &self))
        }

        fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            u32::try_from(value)
                .ok()
                .filter(|value| *value != 0)
                .ok_or_else(|| E::invalid_value(de::Unexpected::Signed(value), &self))
        }

        fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            if value.is_finite()
                && value.fract() == 0.0
                && value >= 1.0
                && value <= f64::from(u32::MAX)
            {
                Ok(value as u32)
            } else {
                Err(E::invalid_value(de::Unexpected::Float(value), &self))
            }
        }
    }

    // This deliberately follows JSON value semantics rather than retaining
    // the source token: 2, 2.0, and 2e0 all deserialize to the same u32. The
    // serializer remains canonical and emits a bare integer token.
    deserializer.deserialize_any(ProtocolVersionVisitor)
}

/// Sign and serialize a trusted local transcript. The sender identity is
/// always derived from `signing_key`; callers cannot supply a sender-key field.
pub fn sign_rtc_signal_wire(
    signing_key: &SigningKey,
    protocol: RtcProtocol,
    transcript: &SignedSignalTranscript,
) -> Result<String, SignedRtcWireError> {
    validate_tuple(protocol, transcript)?;
    // Revalidate the peer bytes with the same strict canonical/small-order
    // checks used at an untrusted wire boundary.
    let intended_peer = public_key_from_wire(&base64_key(transcript.intended_peer_public_key()))?;
    let sender = signing_key.verifying_key();
    public_key_from_wire(&public_key_to_wire(&sender))?;
    let envelope = SignedRtcEnvelope {
        signal_type: signal_type(transcript.signal_kind()).to_owned(),
        signature_algorithm: SIGNATURE_ALGORITHM.to_owned(),
        sender_identity_public_key: public_key_to_wire(&sender),
        intended_peer_identity_public_key: public_key_to_wire(&intended_peer),
        protocol: protocol.as_str().to_owned(),
        protocol_version: transcript.protocol_version(),
        session_id: transcript.session_id().to_owned(),
        scope_type: scope_type(transcript.scope_type()).to_owned(),
        scope_id: transcript.scope_id().to_owned(),
        sender_role: sender_role(transcript.sender_role()).to_owned(),
        sdp: transcript.sdp().to_owned(),
        signature: sign_transcript_wire(signing_key, transcript)?,
    };
    let encoded = serde_json::to_string(&envelope)?;
    if encoded.len() > MAX_SIGNED_RTC_WIRE_BYTES {
        return Err(SignedRtcWireError::WireTooLarge);
    }
    Ok(encoded)
}

/// Parse, pin-check, reconstruct, and verify an untrusted signed RTC envelope.
/// A value is returned only after every operation succeeds.
pub fn verify_rtc_signal_wire(
    wire: &str,
    expected_sender: &VerifyingKey,
    expected_intended_peer: &VerifyingKey,
) -> Result<VerifiedRtcSignal, SignedRtcWireError> {
    if wire.len() > MAX_SIGNED_RTC_WIRE_BYTES {
        return Err(SignedRtcWireError::WireTooLarge);
    }
    // Validate caller pins as strictly as the envelope keys. VerifyingKey can
    // otherwise be constructed by code that follows dalek's broader ZIP-215
    // acceptance policy.
    let expected_sender = public_key_from_wire(&public_key_to_wire(expected_sender))?;
    let expected_intended_peer = public_key_from_wire(&public_key_to_wire(expected_intended_peer))?;
    let envelope: SignedRtcEnvelope = serde_json::from_str(wire)?;
    if envelope.signature_algorithm != SIGNATURE_ALGORITHM {
        return Err(SignedRtcWireError::UnsupportedAlgorithm);
    }
    let kind = parse_signal_type(&envelope.signal_type)?;
    let scope = parse_scope_type(&envelope.scope_type)?;
    let role = parse_sender_role(&envelope.sender_role)?;
    let protocol = RtcProtocol::parse(&envelope.protocol)?;
    let sender = public_key_from_wire(&envelope.sender_identity_public_key)?;
    let intended_peer = public_key_from_wire(&envelope.intended_peer_identity_public_key)?;
    if sender.as_bytes() != expected_sender.as_bytes() {
        return Err(SignedRtcWireError::SenderPinMismatch);
    }
    if intended_peer.as_bytes() != expected_intended_peer.as_bytes() {
        return Err(SignedRtcWireError::IntendedPeerPinMismatch);
    }
    let transcript = SignedSignalTranscript::new(
        kind,
        envelope.protocol_version,
        envelope.session_id,
        scope,
        envelope.scope_id,
        role,
        *intended_peer.as_bytes(),
        envelope.sdp,
    )?;
    validate_tuple(protocol, &transcript)?;
    verify_transcript_wire(&sender, &transcript, &envelope.signature)?;
    Ok(VerifiedRtcSignal {
        protocol,
        sender_public_key: sender,
        transcript,
    })
}

fn validate_tuple(
    protocol: RtcProtocol,
    transcript: &SignedSignalTranscript,
) -> Result<(), SignedRtcWireError> {
    protocol.validate_scope(transcript.scope_type())?;
    let exact_version = match protocol {
        RtcProtocol::Session => 2,
        RtcProtocol::Host => 1,
    };
    if transcript.protocol_version() != exact_version {
        return Err(SignedRtcWireError::InconsistentTuple(
            "protocol_version does not match the current protocol",
        ));
    }
    match (transcript.signal_kind(), transcript.sender_role()) {
        (SignalKind::Offer, SenderRole::Browser) | (SignalKind::Answer, SenderRole::Daemon) => {
            Ok(())
        }
        _ => Err(SignedRtcWireError::InconsistentTuple(
            "rtc.offer must be browser-signed and rtc.answer must be daemon-signed",
        )),
    }
}

fn signal_type(value: SignalKind) -> &'static str {
    match value {
        SignalKind::Offer => "rtc.offer",
        SignalKind::Answer => "rtc.answer",
    }
}

fn parse_signal_type(value: &str) -> Result<SignalKind, SignedRtcWireError> {
    match value {
        "rtc.offer" => Ok(SignalKind::Offer),
        "rtc.answer" => Ok(SignalKind::Answer),
        _ => Err(SignedRtcWireError::InvalidEnum("type")),
    }
}

fn scope_type(value: ScopeType) -> &'static str {
    match value {
        ScopeType::Session => "session",
        ScopeType::Host => "host",
    }
}

fn parse_scope_type(value: &str) -> Result<ScopeType, SignedRtcWireError> {
    match value {
        "session" => Ok(ScopeType::Session),
        "host" => Ok(ScopeType::Host),
        _ => Err(SignedRtcWireError::InvalidEnum("scope_type")),
    }
}

fn sender_role(value: SenderRole) -> &'static str {
    match value {
        SenderRole::Browser => "browser",
        SenderRole::Daemon => "daemon",
    }
}

fn parse_sender_role(value: &str) -> Result<SenderRole, SignedRtcWireError> {
    match value {
        "browser" => Ok(SenderRole::Browser),
        "daemon" => Ok(SenderRole::Daemon),
        _ => Err(SignedRtcWireError::InvalidEnum("sender_role")),
    }
}

fn base64_key(value: &[u8; 32]) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    URL_SAFE_NO_PAD.encode(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::{json, Value};

    #[derive(Deserialize)]
    struct GoldenFile {
        format: String,
        signing_seed_hex: String,
        sender_public_key_wire: String,
        intended_peer_public_key_wire: String,
        mutation_fields: Vec<String>,
        protocol_version_json_tokens: ProtocolVersionJsonTokens,
        vectors: Vec<GoldenVector>,
        wrong_topology_vectors: Vec<GoldenVector>,
    }

    #[derive(Deserialize)]
    struct ProtocolVersionJsonTokens {
        session_accepted: Vec<String>,
        host_accepted: Vec<String>,
        rejected: Vec<String>,
    }

    #[derive(Deserialize)]
    struct GoldenVector {
        id: String,
        envelope: Value,
    }

    fn golden() -> GoldenFile {
        serde_json::from_str(include_str!(
            "../../proto/signed-signal-wire-v1-vectors.json"
        ))
        .unwrap()
    }

    fn decode_hex_32(value: &str) -> [u8; 32] {
        assert_eq!(value.len(), 64);
        let decoded: Vec<u8> = value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect();
        decoded.try_into().unwrap()
    }

    fn transcript(envelope: &Value) -> SignedSignalTranscript {
        let object = envelope.as_object().unwrap();
        let intended = public_key_from_wire(
            object["intended_peer_identity_public_key"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        SignedSignalTranscript::new(
            parse_signal_type(object["type"].as_str().unwrap()).unwrap(),
            u32::try_from(object["protocol_version"].as_u64().unwrap()).unwrap(),
            object["session_id"].as_str().unwrap(),
            parse_scope_type(object["scope_type"].as_str().unwrap()).unwrap(),
            object["scope_id"].as_str().unwrap(),
            parse_sender_role(object["sender_role"].as_str().unwrap()).unwrap(),
            *intended.as_bytes(),
            object["sdp"].as_str().unwrap(),
        )
        .unwrap()
    }

    fn mutate(value: &Value, field: &str, other: &Value) -> Value {
        let mut mutated = value.clone();
        let object = mutated.as_object_mut().unwrap();
        object[field] = match field {
            "type" => json!(if object[field] == "rtc.offer" {
                "rtc.answer"
            } else {
                "rtc.offer"
            }),
            "signature_algorithm" => json!("ed448"),
            "sender_identity_public_key" => other["intended_peer_identity_public_key"].clone(),
            "intended_peer_identity_public_key" => other["sender_identity_public_key"].clone(),
            "protocol" => json!("spawn.ctl"),
            "protocol_version" => json!(object[field].as_u64().unwrap() + 1),
            "session_id" | "scope_id" | "sdp" => {
                json!(format!("{}-mutated", object[field].as_str().unwrap()))
            }
            "scope_type" => json!(if object[field] == "session" {
                "host"
            } else {
                "session"
            }),
            "sender_role" => json!(if object[field] == "browser" {
                "daemon"
            } else {
                "browser"
            }),
            "signature" => {
                let signature = object[field].as_str().unwrap();
                let replacement = if signature.starts_with('A') { 'B' } else { 'A' };
                json!(format!("{replacement}{}", &signature[1..]))
            }
            other => panic!("uncovered mutation field {other}"),
        };
        mutated
    }

    #[test]
    fn shared_wire_vectors_sign_and_verify_in_rust() {
        let golden = golden();
        assert_eq!(golden.format, "spawn-signed-signal-wire-v1");
        assert_eq!(golden.vectors.len(), 2);
        let signing_key = SigningKey::from_bytes(&decode_hex_32(&golden.signing_seed_hex));
        let sender = public_key_from_wire(&golden.sender_public_key_wire).unwrap();
        let intended = public_key_from_wire(&golden.intended_peer_public_key_wire).unwrap();
        assert_eq!(signing_key.verifying_key(), sender);
        for vector in &golden.vectors {
            let transcript = transcript(&vector.envelope);
            let protocol =
                RtcProtocol::parse(vector.envelope["protocol"].as_str().unwrap()).unwrap();
            let signed = sign_rtc_signal_wire(&signing_key, protocol, &transcript).unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&signed).unwrap(),
                vector.envelope,
                "{}",
                vector.id
            );
            let verified = verify_rtc_signal_wire(&signed, &sender, &intended).unwrap();
            assert_eq!(verified.protocol(), protocol);
            assert_eq!(verified.sender_public_key(), &sender);
            assert_eq!(verified.transcript(), &transcript);
        }
    }

    #[test]
    fn every_wire_field_mutation_fails_closed() {
        let golden = golden();
        assert_eq!(golden.mutation_fields.len(), 12);
        let sender = public_key_from_wire(&golden.sender_public_key_wire).unwrap();
        let intended = public_key_from_wire(&golden.intended_peer_public_key_wire).unwrap();
        for (index, vector) in golden.vectors.iter().enumerate() {
            let other = &golden.vectors[1 - index].envelope;
            for field in &golden.mutation_fields {
                let mutated = mutate(&vector.envelope, field, other);
                let wire = serde_json::to_string(&mutated).unwrap();
                assert!(
                    verify_rtc_signal_wire(&wire, &sender, &intended).is_err(),
                    "{} accepted mutated {field}",
                    vector.id
                );
            }
        }
    }

    #[test]
    fn wire_ingress_rejects_noncanonical_session_and_scope_uuid_text() {
        let golden = golden();
        let sender = public_key_from_wire(&golden.sender_public_key_wire).unwrap();
        let intended = public_key_from_wire(&golden.intended_peer_public_key_wire).unwrap();
        for invalid in [
            "018F0F77-86D2-7A8E-9B1C-1F3B847CA2A1",
            "018f0f7786d27a8e9b1c1f3b847ca2a1",
            "{018f0f77-86d2-7a8e-9b1c-1f3b847ca2a1}",
            " 018f0f77-86d2-7a8e-9b1c-1f3b847ca2a1 ",
            "not-a-uuid-not-a-uuid-not-a-uuid!!!",
        ] {
            for field in ["session_id", "scope_id"] {
                let mut envelope = golden.vectors[0].envelope.clone();
                envelope[field] = json!(invalid);
                assert!(
                    verify_rtc_signal_wire(
                        &serde_json::to_string(&envelope).unwrap(),
                        &sender,
                        &intended
                    )
                    .is_err(),
                    "accepted noncanonical {field} {invalid:?}"
                );
            }
        }
    }

    #[test]
    fn protocol_version_json_value_semantics_match_shared_cases() {
        let golden = golden();
        let sender = public_key_from_wire(&golden.sender_public_key_wire).unwrap();
        let intended = public_key_from_wire(&golden.intended_peer_public_key_wire).unwrap();
        for (vector, tokens) in [
            (
                &golden.vectors[0],
                &golden.protocol_version_json_tokens.session_accepted,
            ),
            (
                &golden.vectors[1],
                &golden.protocol_version_json_tokens.host_accepted,
            ),
        ] {
            let canonical = serde_json::to_string(&vector.envelope).unwrap();
            let version = vector.envelope["protocol_version"].as_u64().unwrap();
            let needle = format!("\"protocol_version\":{version}");
            assert_eq!(canonical.matches(&needle).count(), 1);
            for token in tokens {
                let wire = canonical.replacen(&needle, &format!("\"protocol_version\":{token}"), 1);
                assert!(
                    verify_rtc_signal_wire(&wire, &sender, &intended).is_ok(),
                    "{} rejected equivalent JSON number {token}",
                    vector.id
                );
            }
        }

        let canonical = serde_json::to_string(&golden.vectors[0].envelope).unwrap();
        let needle = "\"protocol_version\":2";
        for token in &golden.protocol_version_json_tokens.rejected {
            let wire = canonical.replacen(needle, &format!("\"protocol_version\":{token}"), 1);
            assert!(
                verify_rtc_signal_wire(&wire, &sender, &intended).is_err(),
                "accepted invalid JSON number {token}"
            );
        }
    }

    #[test]
    fn valid_signatures_cannot_widen_the_current_protocol_topology() {
        let golden = golden();
        let signing_key = SigningKey::from_bytes(&decode_hex_32(&golden.signing_seed_hex));
        let sender = public_key_from_wire(&golden.sender_public_key_wire).unwrap();
        let intended = public_key_from_wire(&golden.intended_peer_public_key_wire).unwrap();
        assert_eq!(golden.wrong_topology_vectors.len(), 2);
        for vector in &golden.wrong_topology_vectors {
            let value = transcript(&vector.envelope);
            let signature = vector.envelope["signature"].as_str().unwrap();
            verify_transcript_wire(&sender, &value, signature).unwrap();
            let protocol =
                RtcProtocol::parse(vector.envelope["protocol"].as_str().unwrap()).unwrap();
            assert!(matches!(
                sign_rtc_signal_wire(&signing_key, protocol, &value),
                Err(SignedRtcWireError::InconsistentTuple(
                    "protocol_version does not match the current protocol"
                ))
            ));
            assert!(matches!(
                verify_rtc_signal_wire(
                    &serde_json::to_string(&vector.envelope).unwrap(),
                    &sender,
                    &intended
                ),
                Err(SignedRtcWireError::InconsistentTuple(
                    "protocol_version does not match the current protocol"
                ))
            ));
        }
    }

    #[test]
    fn pins_shape_duplicates_and_bounds_fail_before_trust() {
        let golden = golden();
        let wire = serde_json::to_string(&golden.vectors[0].envelope).unwrap();
        let sender = public_key_from_wire(&golden.sender_public_key_wire).unwrap();
        let intended = public_key_from_wire(&golden.intended_peer_public_key_wire).unwrap();
        assert_eq!(
            verify_rtc_signal_wire(&wire, &intended, &intended),
            Err(SignedRtcWireError::SenderPinMismatch)
        );
        assert_eq!(
            verify_rtc_signal_wire(&wire, &sender, &sender),
            Err(SignedRtcWireError::IntendedPeerPinMismatch)
        );
        let duplicate = wire.replacen("{", "{\"type\":\"rtc.answer\",", 1);
        assert!(matches!(
            verify_rtc_signal_wire(&duplicate, &sender, &intended),
            Err(SignedRtcWireError::InvalidJson(_))
        ));
        let mut unknown = golden.vectors[0].envelope.clone();
        unknown["unexpected"] = json!(true);
        assert!(matches!(
            verify_rtc_signal_wire(
                &serde_json::to_string(&unknown).unwrap(),
                &sender,
                &intended
            ),
            Err(SignedRtcWireError::InvalidJson(_))
        ));
        for (field, value) in [
            (
                "sender_identity_public_key",
                format!("{}=", golden.sender_public_key_wire),
            ),
            (
                "intended_peer_identity_public_key",
                format!("{}=", golden.intended_peer_public_key_wire),
            ),
            (
                "signature",
                format!(
                    "{}=",
                    golden.vectors[0].envelope["signature"].as_str().unwrap()
                ),
            ),
        ] {
            let mut malformed = golden.vectors[0].envelope.clone();
            malformed[field] = json!(value);
            assert!(verify_rtc_signal_wire(
                &serde_json::to_string(&malformed).unwrap(),
                &sender,
                &intended
            )
            .is_err());
        }
        let mut weak_sender = golden.vectors[0].envelope.clone();
        weak_sender["sender_identity_public_key"] = json!("A".repeat(43));
        assert!(verify_rtc_signal_wire(
            &serde_json::to_string(&weak_sender).unwrap(),
            &sender,
            &intended
        )
        .is_err());
        let mut oversized_sdp = golden.vectors[0].envelope.clone();
        oversized_sdp["sdp"] = json!("x".repeat(MAX_SDP_BYTES + 1));
        assert!(matches!(
            verify_rtc_signal_wire(
                &serde_json::to_string(&oversized_sdp).unwrap(),
                &sender,
                &intended
            ),
            Err(SignedRtcWireError::SignedSignal(
                SignedSignalError::InvalidLength { field: "sdp", .. }
            ))
        ));
        assert_eq!(
            verify_rtc_signal_wire(
                &"x".repeat(MAX_SIGNED_RTC_WIRE_BYTES + 1),
                &sender,
                &intended
            ),
            Err(SignedRtcWireError::WireTooLarge)
        );
        let huge_key = "A".repeat(16 * 1024 * 1024);
        let mut oversized_key = golden.vectors[0].envelope.clone();
        oversized_key["sender_identity_public_key"] = json!(huge_key);
        assert_eq!(
            verify_rtc_signal_wire(
                &serde_json::to_string(&oversized_key).unwrap(),
                &sender,
                &intended
            ),
            Err(SignedRtcWireError::WireTooLarge)
        );
    }

    #[test]
    fn protocol_scope_and_offer_role_pairs_are_exact() {
        let golden = golden();
        let signing_key = SigningKey::from_bytes(&decode_hex_32(&golden.signing_seed_hex));
        let session = transcript(&golden.vectors[0].envelope);
        assert_eq!(
            sign_rtc_signal_wire(&signing_key, RtcProtocol::Host, &session),
            Err(SignedRtcWireError::InconsistentTuple(
                "protocol does not match scope_type"
            ))
        );
        let wrong_version = SignedSignalTranscript::new(
            SignalKind::Offer,
            1,
            session.session_id(),
            session.scope_type(),
            session.scope_id(),
            SenderRole::Browser,
            *session.intended_peer_public_key(),
            session.sdp(),
        )
        .unwrap();
        assert_eq!(
            sign_rtc_signal_wire(&signing_key, RtcProtocol::Session, &wrong_version),
            Err(SignedRtcWireError::InconsistentTuple(
                "protocol_version does not match the current protocol"
            ))
        );
        assert_eq!(
            RtcProtocol::parse("spawn.ctl"),
            Err(SignedRtcWireError::InvalidEnum("protocol"))
        );
        let wrong_role = SignedSignalTranscript::new(
            SignalKind::Offer,
            session.protocol_version(),
            session.session_id(),
            session.scope_type(),
            session.scope_id(),
            SenderRole::Daemon,
            *session.intended_peer_public_key(),
            session.sdp(),
        )
        .unwrap();
        assert!(matches!(
            sign_rtc_signal_wire(&signing_key, RtcProtocol::Session, &wrong_role),
            Err(SignedRtcWireError::InconsistentTuple(_))
        ));
    }
}
