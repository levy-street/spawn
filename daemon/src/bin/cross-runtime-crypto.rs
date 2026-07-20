//! Executable Rust half of the fresh Rust/WebCrypto interoperability gate.
//!
//! This binary is test tooling only. `produce` emits freshly signed artifacts
//! for the browser runner to verify, while `verify` accepts fresh WebCrypto
//! artifacts on stdin and checks them with the Rust production primitives.

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use spawnd::signed_signal::{
    generate_signing_key, public_key_from_wire, public_key_to_wire, sign_transcript_wire,
    signature_from_wire, signature_to_wire, verify_transcript_wire, ScopeType, SenderRole,
    SignalKind, SignedSignalTranscript,
};
use spawnd::host_pair_approval::HostPairApprovalTranscript;
use spawnd::signed_signal_wire::{sign_rtc_signal_wire, verify_rtc_signal_wire, RtcProtocol};
use std::io::{self, Read};
use uuid::Uuid;

const BROWSER_REGISTRATION_MAGIC: &[u8] = b"SPAWN-BROWSER-REGISTER-V1";
// The host-pair approval magic and layout now live in spawnd::host_pair_approval,
// so this check exercises the production encoder instead of a private copy.
const CONTRACT_VERSION: u8 = 1;
const APPROVAL_NONCE_BYTES: usize = 32;
const MAX_INPUT_BYTES: u64 = 4 * 1024 * 1024;
const DTLS_FINGERPRINT: &str =
    "9A:61:07:51:B5:42:4C:95:2B:7A:57:3D:CD:0C:12:F8:72:91:4B:72:21:6F:4B:47:9E:AC:85:F1:42:19:21:AD";

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExchangeArtifact {
    producer: String,
    browser_public_key: String,
    host_public_key: String,
    browser_key_fingerprint: String,
    host_key_fingerprint: String,
    exact_sdp: String,
    invalid_identifiers: Vec<String>,
    invalid_intended_peer_public_keys: Vec<String>,
    accepted_intended_peer_public_keys: Vec<String>,
    signal: SignalArtifact,
    wire: WireArtifact,
    live_answer: WireArtifact,
    registration: RegistrationArtifact,
    host_pair: HostPairArtifact,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SignalArtifact {
    signal_kind: String,
    protocol_version: u32,
    session_id: String,
    scope_type: String,
    scope_id: String,
    sender_role: String,
    intended_peer_public_key: String,
    sdp: String,
    canonical_bytes: String,
    canonical_sha256: String,
    signature: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireArtifact {
    envelope: String,
    envelope_sha256: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RegistrationArtifact {
    user_id: String,
    browser_public_key: String,
    canonical_bytes: String,
    canonical_sha256: String,
    signature: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HostPairArtifact {
    user_id: String,
    approval_nonce: String,
    host_public_key: String,
    browser_public_key: String,
    canonical_bytes: String,
    canonical_sha256: String,
    signature: String,
}

#[derive(Deserialize)]
struct NegativeKeyCorpus {
    weak_public_keys: Vec<NegativeKeyVector>,
    noncanonical_public_key_hex: Vec<String>,
    invalid_encodings: Vec<NegativeKeyVector>,
    accepted_mixed_torsion_public_key_hex: Vec<String>,
}

#[derive(Deserialize)]
struct NegativeKeyVector {
    public_key_hex: String,
}

fn main() -> Result<()> {
    match std::env::args().nth(1).as_deref() {
        Some("produce") => {
            let artifact = produce()?;
            serde_json::to_writer(io::stdout().lock(), &artifact)
                .context("serializing Rust exchange artifact")?;
            Ok(())
        }
        Some("verify") => verify_stdin(),
        _ => bail!("usage: cross-runtime-crypto <produce|verify>"),
    }
}

fn produce() -> Result<ExchangeArtifact> {
    let browser_key = generate_signing_key().context("generating Rust browser key")?;
    let host_key = generate_signing_key().context("generating Rust host key")?;
    let browser_public_key = public_key_to_wire(&browser_key.verifying_key());
    let host_public_key = public_key_to_wire(&host_key.verifying_key());
    let browser_key_fingerprint = key_fingerprint(&browser_public_key)?;
    let host_key_fingerprint = key_fingerprint(&host_public_key)?;
    let exact_sdp = exact_sdp(&host_key_fingerprint, &browser_key_fingerprint);
    let transcript = SignedSignalTranscript::new(
        SignalKind::Offer,
        2,
        Uuid::new_v4().to_string(),
        ScopeType::Agent,
        Uuid::new_v4().to_string(),
        SenderRole::Browser,
        *host_key.verifying_key().as_bytes(),
        exact_sdp.clone(),
    )
    .context("constructing Rust signed-signal transcript")?;
    let signal_bytes = transcript.encode().context("encoding Rust signed signal")?;
    let signal = SignalArtifact {
        signal_kind: "offer".to_owned(),
        protocol_version: transcript.protocol_version(),
        session_id: transcript.session_id().to_owned(),
        scope_type: "agent".to_owned(),
        scope_id: transcript.scope_id().to_owned(),
        sender_role: "browser".to_owned(),
        intended_peer_public_key: host_public_key.clone(),
        sdp: exact_sdp.clone(),
        canonical_bytes: canonical_wire(&signal_bytes),
        canonical_sha256: sha256_wire(&signal_bytes),
        signature: sign_transcript_wire(&browser_key, &transcript)
            .context("signing Rust signed signal")?,
    };
    let envelope = sign_rtc_signal_wire(&browser_key, RtcProtocol::Agent, &transcript)
        .context("signing Rust RTC wire envelope")?;
    let answer_transcript = SignedSignalTranscript::new(
        SignalKind::Answer,
        2,
        transcript.session_id().to_owned(),
        ScopeType::Agent,
        transcript.scope_id().to_owned(),
        SenderRole::Daemon,
        *browser_key.verifying_key().as_bytes(),
        exact_sdp.clone(),
    )
    .context("constructing Rust live answer transcript")?;
    let live_answer = sign_rtc_signal_wire(&host_key, RtcProtocol::Agent, &answer_transcript)
        .context("signing Rust live answer envelope")?;

    let user_id = Uuid::new_v4().to_string();
    let registration_bytes = encode_browser_registration(&user_id, &browser_public_key)?;
    let registration = RegistrationArtifact {
        user_id: user_id.clone(),
        browser_public_key: browser_public_key.clone(),
        canonical_bytes: canonical_wire(&registration_bytes),
        canonical_sha256: sha256_wire(&registration_bytes),
        signature: raw_signature_wire(&browser_key, &registration_bytes),
    };

    let mut nonce = [0_u8; APPROVAL_NONCE_BYTES];
    getrandom::getrandom(&mut nonce).context("generating Rust approval nonce")?;
    let approval_nonce = canonical_wire(&nonce);
    let host_pair_bytes = encode_host_pair_approval(
        &user_id,
        &approval_nonce,
        &host_public_key,
        &browser_public_key,
    )?;
    let host_pair = HostPairArtifact {
        user_id,
        approval_nonce,
        host_public_key: host_public_key.clone(),
        browser_public_key: browser_public_key.clone(),
        canonical_bytes: canonical_wire(&host_pair_bytes),
        canonical_sha256: sha256_wire(&host_pair_bytes),
        signature: raw_signature_wire(&browser_key, &host_pair_bytes),
    };
    let (invalid_intended_peer_public_keys, accepted_intended_peer_public_keys) =
        intended_peer_key_corpus()?;

    Ok(ExchangeArtifact {
        producer: "rust".to_owned(),
        browser_public_key,
        host_public_key,
        browser_key_fingerprint,
        host_key_fingerprint,
        exact_sdp,
        invalid_identifiers: invalid_identifiers(),
        invalid_intended_peer_public_keys,
        accepted_intended_peer_public_keys,
        signal,
        wire: WireArtifact {
            envelope_sha256: sha256_wire(envelope.as_bytes()),
            envelope,
        },
        live_answer: WireArtifact {
            envelope_sha256: sha256_wire(live_answer.as_bytes()),
            envelope: live_answer,
        },
        registration,
        host_pair,
    })
}

fn verify_stdin() -> Result<()> {
    let mut input = Vec::new();
    io::stdin()
        .lock()
        .take(MAX_INPUT_BYTES + 1)
        .read_to_end(&mut input)
        .context("reading WebCrypto exchange artifact")?;
    if input.len() as u64 > MAX_INPUT_BYTES {
        bail!("WebCrypto exchange artifact exceeds fixed input bound");
    }
    let artifact: ExchangeArtifact =
        serde_json::from_slice(&input).context("parsing WebCrypto exchange artifact")?;
    verify(&artifact)?;
    println!("cross-runtime-crypto: Rust verified WebCrypto artifacts");
    Ok(())
}

fn verify(artifact: &ExchangeArtifact) -> Result<()> {
    if artifact.producer != "webcrypto" {
        bail!("unexpected exchange producer");
    }
    let browser_key = public_key_from_wire(&artifact.browser_public_key)
        .context("validating WebCrypto browser public key")?;
    let host_key = public_key_from_wire(&artifact.host_public_key)
        .context("validating WebCrypto host public key")?;
    require_equal(
        "browser fingerprint",
        &artifact.browser_key_fingerprint,
        &key_fingerprint(&artifact.browser_public_key)?,
    )?;
    require_equal(
        "host fingerprint",
        &artifact.host_key_fingerprint,
        &key_fingerprint(&artifact.host_public_key)?,
    )?;
    let expected_sdp = exact_sdp(
        &artifact.host_key_fingerprint,
        &artifact.browser_key_fingerprint,
    );
    require_equal("exact SDP", &artifact.exact_sdp, &expected_sdp)?;
    require_equal("signal SDP", &artifact.signal.sdp, &expected_sdp)?;
    require_equal(
        "signal intended peer",
        &artifact.signal.intended_peer_public_key,
        &artifact.host_public_key,
    )?;
    for invalid in &artifact.invalid_identifiers {
        let invalid_session = SignedSignalTranscript::new(
            SignalKind::Offer,
            2,
            invalid,
            ScopeType::Agent,
            &artifact.signal.scope_id,
            SenderRole::Browser,
            *host_key.as_bytes(),
            &expected_sdp,
        );
        if invalid_session.is_ok() {
            bail!("Rust accepted exchanged noncanonical session UUID {invalid:?}");
        }
        let invalid_scope = SignedSignalTranscript::new(
            SignalKind::Offer,
            2,
            &artifact.signal.session_id,
            ScopeType::Agent,
            invalid,
            SenderRole::Browser,
            *host_key.as_bytes(),
            &expected_sdp,
        );
        if invalid_scope.is_ok() {
            bail!("Rust accepted exchanged noncanonical scope UUID {invalid:?}");
        }
    }
    if artifact.invalid_intended_peer_public_keys.len() != 49
        || artifact.accepted_intended_peer_public_keys.len() != 7
    {
        bail!("exchanged intended-peer point corpus has the wrong cardinality");
    }
    for invalid in &artifact.invalid_intended_peer_public_keys {
        let raw = decode_canonical_exact::<32>(invalid, "invalid intended-peer public key")?;
        if SignedSignalTranscript::new(
            SignalKind::Offer,
            2,
            &artifact.signal.session_id,
            ScopeType::Agent,
            &artifact.signal.scope_id,
            SenderRole::Browser,
            raw,
            &expected_sdp,
        )
        .is_ok()
        {
            bail!("Rust accepted exchanged invalid intended-peer point");
        }
    }
    for accepted in &artifact.accepted_intended_peer_public_keys {
        let raw = decode_canonical_exact::<32>(accepted, "accepted intended-peer public key")?;
        SignedSignalTranscript::new(
            SignalKind::Offer,
            2,
            &artifact.signal.session_id,
            ScopeType::Agent,
            &artifact.signal.scope_id,
            SenderRole::Browser,
            raw,
            &expected_sdp,
        )
        .context("Rust rejected exchanged accepted intended-peer point")?;
    }

    let transcript = signal_transcript(&artifact.signal, &host_key)?;
    let signal_bytes = transcript
        .encode()
        .context("encoding WebCrypto signed-signal transcript in Rust")?;
    verify_canonical(
        "signed signal",
        &signal_bytes,
        &artifact.signal.canonical_bytes,
        &artifact.signal.canonical_sha256,
    )?;
    verify_transcript_wire(&browser_key, &transcript, &artifact.signal.signature)
        .context("verifying WebCrypto signed-signal signature in Rust")?;

    require_equal(
        "wire hash",
        &artifact.wire.envelope_sha256,
        &sha256_wire(artifact.wire.envelope.as_bytes()),
    )?;
    let verified = verify_rtc_signal_wire(&artifact.wire.envelope, &browser_key, &host_key)
        .context("verifying WebCrypto RTC wire envelope in Rust")?;
    if verified.protocol() != RtcProtocol::Agent
        || verified.sender_public_key() != &browser_key
        || verified.transcript() != &transcript
    {
        bail!("WebCrypto RTC wire envelope changed the verified tuple");
    }
    require_equal(
        "live answer wire hash",
        &artifact.live_answer.envelope_sha256,
        &sha256_wire(artifact.live_answer.envelope.as_bytes()),
    )?;
    let expected_answer = SignedSignalTranscript::new(
        SignalKind::Answer,
        transcript.protocol_version(),
        transcript.session_id().to_owned(),
        ScopeType::Agent,
        transcript.scope_id().to_owned(),
        SenderRole::Daemon,
        *browser_key.as_bytes(),
        expected_sdp.clone(),
    )
    .context("constructing expected WebCrypto live answer")?;
    let verified_answer =
        verify_rtc_signal_wire(&artifact.live_answer.envelope, &host_key, &browser_key)
            .context("verifying WebCrypto live answer envelope in Rust")?;
    if verified_answer.protocol() != RtcProtocol::Agent
        || verified_answer.sender_public_key() != &host_key
        || verified_answer.transcript() != &expected_answer
    {
        bail!("WebCrypto live answer changed the verified tuple");
    }

    require_equal(
        "registration browser key",
        &artifact.registration.browser_public_key,
        &artifact.browser_public_key,
    )?;
    let registration_bytes = encode_browser_registration(
        &artifact.registration.user_id,
        &artifact.registration.browser_public_key,
    )?;
    verify_canonical(
        "browser registration",
        &registration_bytes,
        &artifact.registration.canonical_bytes,
        &artifact.registration.canonical_sha256,
    )?;
    verify_raw_signature(
        &browser_key,
        &registration_bytes,
        &artifact.registration.signature,
        "browser registration",
    )?;

    require_equal(
        "host-pair user",
        &artifact.host_pair.user_id,
        &artifact.registration.user_id,
    )?;
    require_equal(
        "host-pair host key",
        &artifact.host_pair.host_public_key,
        &artifact.host_public_key,
    )?;
    require_equal(
        "host-pair browser key",
        &artifact.host_pair.browser_public_key,
        &artifact.browser_public_key,
    )?;
    let host_pair_bytes = encode_host_pair_approval(
        &artifact.host_pair.user_id,
        &artifact.host_pair.approval_nonce,
        &artifact.host_pair.host_public_key,
        &artifact.host_pair.browser_public_key,
    )?;
    verify_canonical(
        "host-pair approval",
        &host_pair_bytes,
        &artifact.host_pair.canonical_bytes,
        &artifact.host_pair.canonical_sha256,
    )?;
    verify_raw_signature(
        &browser_key,
        &host_pair_bytes,
        &artifact.host_pair.signature,
        "host-pair approval",
    )
}

fn signal_transcript(
    signal: &SignalArtifact,
    host_key: &VerifyingKey,
) -> Result<SignedSignalTranscript> {
    if signal.signal_kind != "offer"
        || signal.scope_type != "agent"
        || signal.sender_role != "browser"
    {
        bail!("WebCrypto signal enums do not match the live offer contract");
    }
    SignedSignalTranscript::new(
        SignalKind::Offer,
        signal.protocol_version,
        signal.session_id.clone(),
        ScopeType::Agent,
        signal.scope_id.clone(),
        SenderRole::Browser,
        *host_key.as_bytes(),
        signal.sdp.clone(),
    )
    .context("constructing WebCrypto signed-signal transcript in Rust")
}

fn encode_browser_registration(user_id: &str, browser_public_key: &str) -> Result<Vec<u8>> {
    let user_id = canonical_uuid_bytes(user_id)?;
    let browser_key = public_key_from_wire(browser_public_key)
        .context("validating browser registration public key")?;
    let mut output = Vec::with_capacity(BROWSER_REGISTRATION_MAGIC.len() + 1 + 16 + 32);
    output.extend_from_slice(BROWSER_REGISTRATION_MAGIC);
    output.push(CONTRACT_VERSION);
    output.extend_from_slice(&user_id);
    output.extend_from_slice(browser_key.as_bytes());
    Ok(output)
}

/// Delegates to the daemon's own verifier module so this interop check proves
/// agreement against the encoder that actually runs in production, not a
/// private copy that could silently drift from it.
fn encode_host_pair_approval(
    user_id: &str,
    approval_nonce: &str,
    host_public_key: &str,
    browser_public_key: &str,
) -> Result<Vec<u8>> {
    Ok(HostPairApprovalTranscript::from_wire(
        user_id,
        approval_nonce,
        host_public_key,
        browser_public_key,
    )
    .context("encoding host-pair approval transcript")?
    .encode())
}

fn canonical_uuid_bytes(value: &str) -> Result<[u8; 16]> {
    let parsed = Uuid::parse_str(value).context("parsing canonical UUID")?;
    if parsed.to_string() != value {
        bail!("UUID is not canonical lowercase hyphenated text");
    }
    Ok(*parsed.as_bytes())
}

fn key_fingerprint(public_key: &str) -> Result<String> {
    let key = public_key_from_wire(public_key).context("validating fingerprint public key")?;
    let digest = Sha256::digest(key.as_bytes());
    Ok(format!("SHA256:{}", canonical_wire(&digest[..12])))
}

fn exact_sdp(host_fingerprint: &str, browser_fingerprint: &str) -> String {
    format!(
        "v=0\r\no=spawn 424242 2 IN IP4 127.0.0.1\r\ns=spawn cross-runtime\r\nt=0 0\r\na=fingerprint:sha-256 {DTLS_FINGERPRINT}\r\na=x-spawn-host-key-fingerprint:{host_fingerprint}\r\na=x-spawn-browser-key-fingerprint:{browser_fingerprint}\r\n"
    )
}

fn invalid_identifiers() -> Vec<String> {
    [
        "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
        "aaaaaaaabbbb4ccc8dddeeeeeeeeeeee",
        "{aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee}",
        " aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee ",
        "not-a-uuid-not-a-uuid-not-a-uuid!!!",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

fn intended_peer_key_corpus() -> Result<(Vec<String>, Vec<String>)> {
    let corpus: NegativeKeyCorpus = serde_json::from_str(include_str!(
        "../../../proto/ed25519-public-key-negative-vectors.json"
    ))
    .context("parsing shared Ed25519 point corpus")?;
    let mut invalid = Vec::new();
    invalid.extend(
        corpus
            .weak_public_keys
            .into_iter()
            .map(|vector| vector.public_key_hex),
    );
    invalid.extend(corpus.noncanonical_public_key_hex);
    invalid.extend(
        corpus
            .invalid_encodings
            .into_iter()
            .map(|vector| vector.public_key_hex),
    );
    let encode = |value: String| -> Result<String> {
        let bytes = decode_lower_hex(&value)?;
        if bytes.len() != 32 {
            bail!("Ed25519 corpus key has the wrong width");
        }
        Ok(canonical_wire(&bytes))
    };
    Ok((
        invalid
            .into_iter()
            .map(&encode)
            .collect::<Result<Vec<_>>>()?,
        corpus
            .accepted_mixed_torsion_public_key_hex
            .into_iter()
            .map(encode)
            .collect::<Result<Vec<_>>>()?,
    ))
}

fn decode_lower_hex(value: &str) -> Result<Vec<u8>> {
    if !value.len().is_multiple_of(2) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("Ed25519 corpus contains invalid hex");
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let pair = std::str::from_utf8(pair).expect("hex is ASCII");
            u8::from_str_radix(pair, 16).context("decoding Ed25519 corpus hex")
        })
        .collect()
}

fn raw_signature_wire(signing_key: &SigningKey, message: &[u8]) -> String {
    signature_to_wire(&signing_key.sign(message))
}

fn verify_raw_signature(
    key: &VerifyingKey,
    message: &[u8],
    signature: &str,
    contract: &str,
) -> Result<()> {
    let signature =
        signature_from_wire(signature).with_context(|| format!("decoding {contract} signature"))?;
    key.verify_strict(message, &signature)
        .with_context(|| format!("verifying {contract} signature"))
}

fn verify_canonical(
    contract: &str,
    actual: &[u8],
    expected_wire: &str,
    expected_hash: &str,
) -> Result<()> {
    require_equal(
        &format!("{contract} canonical bytes"),
        expected_wire,
        &canonical_wire(actual),
    )?;
    require_equal(
        &format!("{contract} canonical hash"),
        expected_hash,
        &sha256_wire(actual),
    )
}

fn require_equal(field: &str, actual: &str, expected: &str) -> Result<()> {
    if actual != expected {
        bail!("{field} mismatch");
    }
    Ok(())
}

fn canonical_wire(value: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(value)
}

fn sha256_wire(value: &[u8]) -> String {
    canonical_wire(&Sha256::digest(value))
}

fn decode_canonical_exact<const N: usize>(value: &str, field: &str) -> Result<[u8; N]> {
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .with_context(|| format!("decoding {field}"))?;
    if decoded.len() != N || canonical_wire(&decoded) != value {
        bail!("{field} is not canonical base64url with the expected width");
    }
    decoded
        .try_into()
        .map_err(|_| anyhow::anyhow!("{field} has the wrong decoded width"))
}
