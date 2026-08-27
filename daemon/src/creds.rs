//! Token storage. We try the OS keyring first; if that fails (including Linux
//! kernel keyutils being unavailable) we fall back to a
//! mode-600 JSON file at `~/.config/spawn/credentials.json`. This fallback is
//! intentionally retained for the already-supported headless Linux mode where
//! no Secret Service is available. The same secret bundle holds the daemon
//! token and Ed25519 private seed; neither is ever sent to logs or status.
//! Metadata in that file also supplies `host_id` and the configured server.
//! Every non-legacy commit has a version, monotonic generation, and unique
//! record ID. Both backends receive a whole record; load selects one record by
//! `(generation, record_id)` and never overlays fields across copies. Writers
//! take a cross-process lock, reread both backends, and compare the durable
//! revision with the base used to build the update before writing anything.

use std::collections::HashSet;
use std::fmt::Write as FmtWrite;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::SigningKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

use crate::config;
use spawnd::browser_endorsement::{self, BrowserEndorsementTranscript};
use spawnd::host_pair_approval::{self, HostPairApprovalTranscript};
use spawnd::host_pair_possession::{
    sign_transcript, signature_to_wire, HostPairPossessionTranscript,
};
use spawnd::signed_signal::{public_key_from_wire, public_key_to_wire, SignedSignalTranscript};
use spawnd::signed_signal_wire::{sign_rtc_signal_wire, RtcProtocol};

const KEYRING_SERVICE: &str = "spawn";
/// Pre-scoping releases used this global account. Only the canonical default
/// config directory may probe it for a one-time, conflict-checked migration.
const KEYRING_USER: &str = "daemon";
const KEYRING_SCOPED_USER_PREFIX: &str = "daemon:";

pub const HOST_KEY_ALGORITHM: &str = "ed25519";
pub const BROWSER_KEY_ALGORITHM: &str = "ed25519";
pub const MAX_BROWSER_PINS: usize = 32;
const ED25519_SEED_BYTES: usize = 32;
const ED25519_SEED_B64URL_LENGTH: usize = 43;
const FINGERPRINT_HASH_BYTES: usize = 12;
const MAX_CREDENTIALS_FILE_BYTES: usize = 16 * 1024;
const MAX_ACCESS_TOKEN_BYTES: usize = 12 * 1024;
const MAX_SERVER_URL_BYTES: usize = 2048;
const CANONICAL_UUID_BYTES: usize = 36;
const PUBLIC_KEY_WIRE_BYTES: usize = 43;
const FINGERPRINT_WIRE_BYTES: usize = 23;
const CREDENTIAL_LOCK_FILE: &str = ".credentials.lock";

#[derive(Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct StoredCreds {
    /// Versioned commit identity shared by every backend copy. All three
    /// fields are absent only for legacy records and otherwise form one
    /// indivisible generation marker.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    credential_record_version: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    credential_generation: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    credential_record_id: Option<String>,
    /// Daemon access token (long-lived).
    pub access_token: Option<String>,
    /// The host_id the server assigned when we registered.
    pub host_id: Option<Uuid>,
    /// Server URL we authenticated against.
    pub server_url: Option<String>,
    /// Unpadded canonical base64url Ed25519 seed. This field is deliberately
    /// never sent to the server or included in debug/log output.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_private_key_seed: Option<String>,
    /// Browser identities explicitly approved during successful device login.
    /// Private fields keep mutation behind the conflict/cap validation API.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    browser_pins: Vec<BrowserPin>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostIdentity {
    pub algorithm: &'static str,
    pub public_key: String,
    pub fingerprint: String,
}

/// The browser's pairing approval, retained as evidence rather than reduced to
/// a stored "verified" flag. Keeping the signature means the daemon re-derives
/// the verdict from the proof on every load, so a tampered credential file or a
/// host key that no longer matches is caught instead of trusted.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BrowserApprovalProof {
    account_id: String,
    approval_nonce: String,
    signature: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BrowserPin {
    browser_device_id: String,
    browser_key_algorithm: String,
    browser_public_key: String,
    browser_key_fingerprint: String,
    // Absent for pins created before this field existed, or by a server that
    // supplies no proof. Omitted from the file entirely when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    approval_proof: Option<BrowserApprovalProof>,
}

impl BrowserPin {
    #[allow(dead_code)] // Retained for credential/status golden tests.
    pub fn device_id(&self) -> Uuid {
        // Construction and credential loading validate this exact field.
        Uuid::parse_str(&self.browser_device_id).expect("validated browser device UUID")
    }

    #[allow(dead_code)] // Consumed by the signed-offer enforcement policy.
    pub fn has_approval_proof(&self) -> bool {
        self.approval_proof.is_some()
    }

    /// Whether two pins name the same device and key, ignoring retained proof.
    fn identity_matches(&self, other: &BrowserPin) -> bool {
        self.browser_device_id == other.browser_device_id
            && self.browser_key_algorithm == other.browser_key_algorithm
            && self.browser_public_key == other.browser_public_key
            && self.browser_key_fingerprint == other.browser_key_fingerprint
    }

    /// Re-verify the retained approval proof against this host's public key.
    ///
    /// Returns whether a proof was actually checked; `Ok(false)` means none is
    /// retained. An error means one is retained and does not verify, which no
    /// benign condition produces.
    pub fn verify_approval(&self, host_public_key: &str) -> Result<bool> {
        let Some(proof) = &self.approval_proof else {
            return Ok(false);
        };
        let transcript = HostPairApprovalTranscript::from_wire(
            &proof.account_id,
            &proof.approval_nonce,
            host_public_key,
            &self.browser_public_key,
        )
        .context("decoding the retained browser approval transcript")?;
        let signature = host_pair_approval::signature_from_wire(&proof.signature)
            .context("decoding the retained browser approval signature")?;
        let browser_key = public_key_from_wire(&self.browser_public_key)
            .context("decoding the pinned browser public key")?;
        host_pair_approval::verify_transcript(&browser_key, &transcript, &signature)
            .context("verifying the retained browser approval proof")?;
        Ok(true)
    }

    /// The account this pin's retained approval proof names, once that proof
    /// re-verifies against this host's key. `None` for a pin with no proof
    /// (created before proofs were retained, or by a server that supplied
    /// none) and for one that does not verify — a verdict is re-derived from
    /// the evidence here, never read back from a stored flag.
    pub fn proven_account_id(&self, host_public_key: &str) -> Option<&str> {
        match self.verify_approval(host_public_key) {
            Ok(true) => self
                .approval_proof
                .as_ref()
                .map(|proof| proof.account_id.as_str()),
            _ => None,
        }
    }

    #[allow(dead_code)] // Retained for credential/status golden tests.
    pub fn key_algorithm(&self) -> &str {
        &self.browser_key_algorithm
    }

    #[allow(dead_code)] // Consumed by the later signed-wire verification hook.
    pub fn public_key(&self) -> &str {
        &self.browser_public_key
    }

    #[allow(dead_code)] // Retained for credential/status golden tests.
    pub fn fingerprint(&self) -> &str {
        &self.browser_key_fingerprint
    }
}

const CREDENTIAL_RECORD_VERSION: u8 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code)] // NativeKeyring is retained for non-Unix/Windows targets and policy tests.
enum BackendPolicy {
    UnixCompleteFile,
    WindowsCompleteFile,
    NativeKeyring,
}

impl BackendPolicy {
    fn complete_file(self) -> bool {
        matches!(self, Self::UnixCompleteFile | Self::WindowsCompleteFile)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct KeyringScope {
    user: String,
    migrate_legacy_global: bool,
}

#[derive(Clone, PartialEq, Eq)]
pub struct CredentialRevision {
    kind: CredentialRevisionKind,
}

#[derive(Clone, PartialEq, Eq)]
enum CredentialRevisionKind {
    Current {
        version: u8,
        generation: u64,
        record_id: Uuid,
    },
    Legacy([u8; 32]),
}

impl StoredCreds {
    pub fn is_logged_in(&self) -> bool {
        self.access_token.as_deref().is_some_and(|t| !t.is_empty())
    }

    pub fn browser_pins(&self) -> &[BrowserPin] {
        &self.browser_pins
    }

    /// This host's account as its own pins prove it: the account id each
    /// retained browser approval was signed over, re-verified against this
    /// host's key. It is the one locally anchored answer to "whose host is
    /// this", so the server's claim about it is checked against this rather
    /// than taken. `None` while no pin carries a proof.
    pub fn proven_account_id(&self) -> Option<String> {
        let identity = host_identity(self).ok().flatten()?;
        self.browser_pins
            .iter()
            .find_map(|pin| pin.proven_account_id(&identity.public_key))
            .map(str::to_owned)
    }

    #[allow(dead_code)] // Consumed by the later signed-wire verification hook.
    pub fn browser_pin(&self, device_id: Uuid) -> Option<&BrowserPin> {
        let canonical = device_id.to_string();
        self.browser_pins
            .iter()
            .find(|pin| pin.browser_device_id == canonical)
    }

    fn wipe_sensitive_fields(&mut self) {
        if let Some(value) = self.access_token.as_mut() {
            value.zeroize();
        }
        if let Some(value) = self.host_private_key_seed.as_mut() {
            value.zeroize();
        }
    }
}

impl CredentialRevision {
    /// Return the monotonic identity of a complete current record. Live
    /// authorization refuses legacy revisions because they cannot distinguish
    /// a legitimate reload from rollback or same-revision substitution.
    pub(crate) fn current_parts(&self) -> Option<(u64, Uuid)> {
        match self.kind {
            CredentialRevisionKind::Current {
                generation,
                record_id,
                ..
            } => Some((generation, record_id)),
            CredentialRevisionKind::Legacy(_) => None,
        }
    }
}

impl Drop for StoredCreds {
    fn drop(&mut self) {
        self.wipe_sensitive_fields();
    }
}

pub fn browser_pin_from_approval(
    browser_device_id: &str,
    browser_key_algorithm: &str,
    browser_public_key: &str,
    supplied_fingerprint: &str,
) -> Result<BrowserPin> {
    if browser_device_id.len() != CANONICAL_UUID_BYTES {
        bail!("approved browser device ID is not a canonical UUID")
    }
    let device_id =
        Uuid::parse_str(browser_device_id).context("parsing approved browser device ID")?;
    if device_id.to_string() != browser_device_id {
        bail!("approved browser device ID is not canonical")
    }
    if browser_key_algorithm != BROWSER_KEY_ALGORITHM {
        bail!("approved browser key algorithm is unsupported")
    }
    let expected_fingerprint = browser_key_fingerprint(browser_public_key)?;
    if supplied_fingerprint.len() != FINGERPRINT_WIRE_BYTES
        || supplied_fingerprint != expected_fingerprint
    {
        bail!("approved browser key fingerprint does not match its public key")
    }
    Ok(BrowserPin {
        browser_device_id: device_id.to_string(),
        browser_key_algorithm: BROWSER_KEY_ALGORITHM.to_owned(),
        browser_public_key: browser_public_key.to_owned(),
        browser_key_fingerprint: expected_fingerprint,
        approval_proof: None,
    })
}

/// Attach the browser's approval proof to a validated pin.
///
/// Only canonical wire forms are retained, so a malformed proof is rejected
/// here rather than at some later verification that might be skipped.
pub fn attach_browser_approval_proof(
    pin: BrowserPin,
    account_id: &str,
    approval_nonce: &str,
    signature: &str,
) -> Result<BrowserPin> {
    if host_pair_approval::account_id_bytes(account_id).is_err() {
        bail!("approval proof account ID is not a canonical UUID")
    }
    if host_pair_approval::approval_nonce_bytes(approval_nonce).is_err() {
        bail!("approval proof nonce is not a canonical 32-byte value")
    }
    if host_pair_approval::signature_from_wire(signature).is_err() {
        bail!("approval proof signature is not a canonical Ed25519 signature")
    }
    Ok(BrowserPin {
        approval_proof: Some(BrowserApprovalProof {
            account_id: account_id.to_owned(),
            approval_nonce: approval_nonce.to_owned(),
            signature: signature.to_owned(),
        }),
        ..pin
    })
}

pub fn validate_login_access_token(access_token: &str) -> Result<()> {
    if access_token.is_empty() || access_token.len() > MAX_ACCESS_TOKEN_BYTES {
        bail!("device/poll access token has an invalid length")
    }
    Ok(())
}

/// Commit a server-rotated daemon token as a new whole credential generation.
/// The remaining host identity, pins, server, and Host ID move atomically with
/// it through the same conflict-checked path used by login.
pub fn replace_access_token(access_token: &str) -> Result<()> {
    validate_login_access_token(access_token)?;
    let mut stored = load().context("loading credentials for daemon token rotation")?;
    let expected = credential_revision(&stored)?;
    if stored.access_token.as_deref() == Some(access_token) {
        return Ok(());
    }
    if let Some(old) = stored.access_token.as_mut() {
        old.zeroize();
    }
    stored.access_token = Some(access_token.to_owned());
    save(&mut stored, &expected).context("persisting rotated daemon token")
}

pub fn browser_key_fingerprint(public_key: &str) -> Result<String> {
    if public_key.len() != PUBLIC_KEY_WIRE_BYTES {
        bail!("approved browser public key has the wrong encoded length")
    }
    let verifying_key =
        public_key_from_wire(public_key).context("decoding approved browser Ed25519 public key")?;
    // Re-encoding makes canonicality an explicit part of the local trust input.
    if public_key_to_wire(&verifying_key) != public_key {
        bail!("approved browser public key is not canonical")
    }
    let digest = Sha256::digest(verifying_key.as_bytes());
    Ok(format!(
        "SHA256:{}",
        URL_SAFE_NO_PAD.encode(&digest[..FINGERPRINT_HASH_BYTES])
    ))
}

/// Drop local browser pins the server no longer lists for this host.
///
/// Removal is the one direction it is safe to take from the server: it can only
/// reduce access, and a server that lies here causes a denial of service it
/// could already cause by refusing to relay at all. Additions are never taken
/// from this list — those require an approval proof and the operator's
/// fingerprint comparison at pairing.
///
/// Returns how many pins were dropped.
pub fn prune_browser_pins_to_live_set(live_device_ids: &[String]) -> Result<usize> {
    let mut stored = load().context("loading credentials to reconcile browser pins")?;
    let expected = credential_revision(&stored)?;
    let removed = retain_live_browser_pins(&mut stored, live_device_ids);
    if removed == 0 {
        return Ok(0);
    }
    save(&mut stored, &expected).context("persisting reconciled browser pins")?;
    Ok(removed)
}

/// Retain only the pins named by the live set, returning how many were dropped.
fn retain_live_browser_pins(creds: &mut StoredCreds, live_device_ids: &[String]) -> usize {
    let live: HashSet<&str> = live_device_ids.iter().map(String::as_str).collect();
    let before = creds.browser_pins.len();
    creds
        .browser_pins
        .retain(|pin| live.contains(pin.browser_device_id.as_str()));
    before - creds.browser_pins.len()
}

/// Adopt browser pins the server reports, but only on an endorsement this
/// daemon can verify against a key it already trusts.
///
/// This is the one path by which the pin set grows without a terminal ceremony.
/// The server may propose; it may not authorize. A record without an
/// endorsement, or with one signed by a key outside the current pin set, is
/// ignored rather than adopted -- so a hostile server cannot admit its own
/// browser to this host no matter what it puts in the frame.
///
/// Returns how many pins were adopted.
#[allow(dead_code)] // Compatibility wrapper used by focused credential tests.
pub fn adopt_endorsed_browser_pins(
    account_id: &str,
    proposed: &[ProposedBrowserPin],
) -> Result<usize> {
    Ok(adopt_endorsed_browser_pins_report(account_id, proposed)?
        .into_iter()
        .filter(|outcome| outcome.newly_adopted)
        .count())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinAdoptionOutcome {
    pub device_id: String,
    pub newly_adopted: bool,
    pub reason: Option<&'static str>,
}

/// Adopt proposed pins while retaining a per-device acknowledgement result for
/// the control plane. Invalid proposals never mutate the pin store.
pub fn adopt_endorsed_browser_pins_report(
    account_id: &str,
    proposed: &[ProposedBrowserPin],
) -> Result<Vec<PinAdoptionOutcome>> {
    let mut stored = load().context("loading credentials to adopt endorsed browser pins")?;
    let expected = credential_revision(&stored)?;
    let Some(identity) = host_identity(&stored)? else {
        return Ok(proposed
            .iter()
            .map(|candidate| PinAdoptionOutcome {
                device_id: candidate.device_id.clone(),
                newly_adopted: false,
                reason: Some("invalid_chain"),
            })
            .collect());
    };
    let host_key = public_key_from_wire(&identity.public_key)
        .context("decoding the stored host public key")?;

    // Snapshot the trusted set before adopting anything: a pin admitted in this
    // pass must not become an endorser within it, or one forged record could
    // bootstrap a chain of them.
    let trusted: Vec<_> = stored
        .browser_pins
        .iter()
        .filter_map(|pin| public_key_from_wire(&pin.browser_public_key).ok())
        .collect();

    let mut outcomes = Vec::with_capacity(proposed.len());
    let mut adopted = 0usize;
    for candidate in proposed {
        if stored
            .browser_pins
            .iter()
            .any(|pin| pin.browser_device_id == candidate.device_id)
        {
            outcomes.push(PinAdoptionOutcome {
                device_id: candidate.device_id.clone(),
                newly_adopted: false,
                reason: None,
            });
            continue;
        }
        let (Some(endorser), Some(signature_wire)) = (
            &candidate.endorser_public_key,
            &candidate.endorsement_signature,
        ) else {
            outcomes.push(PinAdoptionOutcome {
                device_id: candidate.device_id.clone(),
                newly_adopted: false,
                reason: Some("invalid_chain"),
            });
            continue;
        };
        let Ok(transcript) = BrowserEndorsementTranscript::from_wire(
            account_id,
            &identity.public_key,
            endorser,
            &candidate.public_key,
            &candidate.device_id,
        ) else {
            outcomes.push(PinAdoptionOutcome {
                device_id: candidate.device_id.clone(),
                newly_adopted: false,
                reason: Some("invalid_chain"),
            });
            continue;
        };
        let Ok(signature) = browser_endorsement::signature_from_wire(signature_wire) else {
            outcomes.push(PinAdoptionOutcome {
                device_id: candidate.device_id.clone(),
                newly_adopted: false,
                reason: Some("invalid_chain"),
            });
            continue;
        };
        if browser_endorsement::verify_endorsement(&transcript, &signature, &host_key, &trusted)
            .is_err()
        {
            outcomes.push(PinAdoptionOutcome {
                device_id: candidate.device_id.clone(),
                newly_adopted: false,
                reason: Some("invalid_chain"),
            });
            continue;
        }
        let Ok(pin) = browser_pin_from_approval(
            &candidate.device_id,
            &candidate.key_algorithm,
            &candidate.public_key,
            &candidate.fingerprint,
        ) else {
            outcomes.push(PinAdoptionOutcome {
                device_id: candidate.device_id.clone(),
                newly_adopted: false,
                reason: Some("invalid_chain"),
            });
            continue;
        };
        if stored.browser_pins.len() >= MAX_BROWSER_PINS {
            outcomes.push(PinAdoptionOutcome {
                device_id: candidate.device_id.clone(),
                newly_adopted: false,
                reason: Some("pin_limit"),
            });
            continue;
        }
        if merge_browser_pin(&mut stored, pin).is_err() {
            outcomes.push(PinAdoptionOutcome {
                device_id: candidate.device_id.clone(),
                newly_adopted: false,
                reason: Some("other"),
            });
            continue;
        } else {
            adopted += 1;
            outcomes.push(PinAdoptionOutcome {
                device_id: candidate.device_id.clone(),
                newly_adopted: true,
                reason: None,
            });
        }
    }
    if adopted > 0 {
        save(&mut stored, &expected).context("persisting adopted browser pins")?;
    }
    Ok(outcomes)
}

/// A pin the server proposes, before any verification.
pub struct ProposedBrowserPin {
    pub device_id: String,
    pub key_algorithm: String,
    pub public_key: String,
    pub fingerprint: String,
    pub endorser_public_key: Option<String>,
    pub endorsement_signature: Option<String>,
}

pub fn merge_browser_pin(creds: &mut StoredCreds, pin: BrowserPin) -> Result<bool> {
    validate_browser_pins(&creds.browser_pins)?;
    validate_browser_pin(&pin)?;
    for index in 0..creds.browser_pins.len() {
        let existing = &creds.browser_pins[index];
        if existing.browser_device_id == pin.browser_device_id {
            if existing == &pin {
                return Ok(false);
            }
            // Same device and same key, differing only in retained evidence.
            // Re-pairing an already-pinned browser against a server that can
            // now supply the proof is an upgrade, not a key conflict — and a
            // proof already held is never dropped for one that is absent.
            if existing.identity_matches(&pin) {
                if pin.approval_proof.is_none() {
                    return Ok(false);
                }
                creds.browser_pins[index] = pin;
                return Ok(true);
            }
            bail!("browser device ID is already pinned to a different key")
        }
        if existing.browser_public_key == pin.browser_public_key {
            bail!("browser public key is already pinned to a different device ID")
        }
    }
    if creds.browser_pins.len() >= MAX_BROWSER_PINS {
        bail!("browser pin capacity of {MAX_BROWSER_PINS} is exhausted")
    }
    creds.browser_pins.push(pin);
    creds
        .browser_pins
        .sort_by(|left, right| left.browser_device_id.cmp(&right.browser_device_id));
    Ok(true)
}

pub fn commit_login_update<F>(
    current: &mut StoredCreds,
    access_token: String,
    host_id: Uuid,
    server_url: String,
    browser_pin: BrowserPin,
    persist: F,
) -> Result<bool>
where
    F: FnOnce(&mut StoredCreds, &CredentialRevision) -> Result<()>,
{
    commit_login_update_observed(
        current,
        access_token,
        host_id,
        server_url,
        browser_pin,
        persist,
        |_| {},
    )
}

fn commit_login_update_observed<F, O>(
    current: &mut StoredCreds,
    access_token: String,
    host_id: Uuid,
    server_url: String,
    browser_pin: BrowserPin,
    persist: F,
    observe_wiped_token: O,
) -> Result<bool>
where
    F: FnOnce(&mut StoredCreds, &CredentialRevision) -> Result<()>,
    O: FnOnce(&str),
{
    let mut access_token = Zeroizing::new(access_token);
    if let Err(error) = validate_pin_trust_domain(current, host_id, &server_url) {
        access_token.zeroize();
        observe_wiped_token(access_token.as_str());
        return Err(error);
    }
    let expected = credential_revision(current)?;
    let mut candidate = current.clone();
    let inserted = match merge_browser_pin(&mut candidate, browser_pin) {
        Ok(inserted) => inserted,
        Err(error) => {
            zeroize_stored_creds(&mut candidate);
            access_token.zeroize();
            observe_wiped_token(access_token.as_str());
            return Err(error);
        }
    };
    if let Some(previous) = candidate.access_token.as_mut() {
        previous.zeroize();
    }
    candidate.access_token = Some(std::mem::take(&mut *access_token));
    candidate.host_id = Some(host_id);
    candidate.server_url = Some(server_url);
    if let Err(error) =
        validate_loaded_creds(&candidate).and_then(|()| persist(&mut candidate, &expected))
    {
        zeroize_stored_creds(&mut candidate);
        observe_wiped_token(candidate.access_token.as_deref().unwrap_or(""));
        return Err(error);
    }
    let mut previous = std::mem::replace(current, candidate);
    zeroize_stored_creds(&mut previous);
    Ok(inserted)
}

pub(crate) fn canonical_server_origin(server_url: &str) -> Result<String> {
    let parsed = url::Url::parse(server_url).context("parsing credential server URL")?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        bail!("credential server URL must be an HTTP(S) origin without user information")
    }
    Ok(parsed.origin().ascii_serialization())
}

fn validate_pin_trust_domain(
    current: &StoredCreds,
    next_host_id: Uuid,
    next_server_url: &str,
) -> Result<()> {
    if current.browser_pins.is_empty() {
        return Ok(());
    }
    let current_host_id = current
        .host_id
        .context("stored browser pins have no host trust domain")?;
    let current_server_url = current
        .server_url
        .as_deref()
        .context("stored browser pins have no server trust domain")?;
    if current_host_id != next_host_id
        || canonical_server_origin(current_server_url)? != canonical_server_origin(next_server_url)?
    {
        bail!(
            "browser pins belong to a different server origin or host; run `spawnd logout` to reset trust, or use a separate SPAWN_CONFIG_DIR to pair independently"
        )
    }
    Ok(())
}

fn platform_policy() -> BackendPolicy {
    #[cfg(unix)]
    {
        BackendPolicy::UnixCompleteFile
    }
    #[cfg(windows)]
    {
        BackendPolicy::WindowsCompleteFile
    }
    #[cfg(not(any(unix, windows)))]
    {
        BackendPolicy::NativeKeyring
    }
}

fn keyring_scope() -> Result<KeyringScope> {
    let configured = config::config_dir()?;
    let default =
        crate::platform::default_config_base().context("cannot resolve default user config dir")?;
    keyring_scope_at(&configured, &default)
}

fn keyring_scope_at(configured: &Path, default: &Path) -> Result<KeyringScope> {
    // Reject a final-component symlink before canonicalizing. Symlinked parent
    // aliases intentionally collapse to one scope, while a config directory
    // that is itself replaceable through a symlink is not accepted.
    validate_credential_directory(configured)?;
    let canonical = std::fs::canonicalize(configured)
        .with_context(|| format!("canonicalizing config directory {}", configured.display()))?;
    let canonical_default = if default.exists() {
        Some(std::fs::canonicalize(default).with_context(|| {
            format!(
                "canonicalizing default config directory {}",
                default.display()
            )
        })?)
    } else {
        None
    };
    let digest = Sha256::digest(config_directory_identity_bytes(&canonical));
    let mut user = String::with_capacity(KEYRING_SCOPED_USER_PREFIX.len() + digest.len() * 2);
    user.push_str(KEYRING_SCOPED_USER_PREFIX);
    for byte in digest {
        write!(&mut user, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(KeyringScope {
        user,
        migrate_legacy_global: canonical_default.as_ref() == Some(&canonical),
    })
}

#[cfg(unix)]
fn config_directory_identity_bytes(path: &Path) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    path.as_os_str().as_bytes().to_vec()
}

#[cfg(windows)]
fn config_directory_identity_bytes(path: &Path) -> Vec<u8> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str()
        .encode_wide()
        .flat_map(u16::to_le_bytes)
        .collect()
}

#[cfg(not(any(unix, windows)))]
fn config_directory_identity_bytes(path: &Path) -> Vec<u8> {
    path.as_os_str().to_string_lossy().as_bytes().to_vec()
}

fn load_without_keyring(from_file: Option<StoredCreds>) -> Result<StoredCreds> {
    let Some(mut from_file) = from_file else {
        return Ok(StoredCreds::default());
    };
    if !platform_policy().complete_file() && !record_is_empty(&from_file) {
        zeroize_stored_creds(&mut from_file);
        bail!("native credential metadata requires its matching OS keyring record")
    }
    Ok(from_file)
}

fn advance_credential_generation(creds: &mut StoredCreds) -> Result<()> {
    let next = record_order(creds)?.map_or(Ok(1_u64), |(generation, _)| {
        generation
            .checked_add(1)
            .context("credential generation exhausted")
    })?;
    creds.credential_record_version = Some(CREDENTIAL_RECORD_VERSION);
    creds.credential_generation = Some(next);
    creds.credential_record_id = Some(Uuid::new_v4().to_string());
    Ok(())
}

fn record_order(creds: &StoredCreds) -> Result<Option<(u64, Uuid)>> {
    match (
        creds.credential_record_version,
        creds.credential_generation,
        creds.credential_record_id.as_deref(),
    ) {
        (None, None, None) => Ok(None),
        (Some(CREDENTIAL_RECORD_VERSION), Some(generation), Some(record_id)) if generation > 0 => {
            if record_id.len() != CANONICAL_UUID_BYTES {
                bail!("credential record ID is not a canonical UUID")
            }
            let parsed = Uuid::parse_str(record_id).context("parsing credential record ID")?;
            if parsed.to_string() != record_id {
                bail!("credential record ID is not canonical")
            }
            Ok(Some((generation, parsed)))
        }
        (Some(version), Some(_), Some(_)) if version != CREDENTIAL_RECORD_VERSION => {
            bail!("unsupported credential record version {version}")
        }
        _ => bail!("credential record has a partial or malformed generation marker"),
    }
}

pub fn credential_revision(creds: &StoredCreds) -> Result<CredentialRevision> {
    if let Some((generation, record_id)) = record_order(creds)? {
        return Ok(CredentialRevision {
            kind: CredentialRevisionKind::Current {
                version: CREDENTIAL_RECORD_VERSION,
                generation,
                record_id,
            },
        });
    }
    let mut encoded = serde_json::to_vec(creds)?;
    let digest = Sha256::digest(&encoded);
    encoded.zeroize();
    Ok(CredentialRevision {
        kind: CredentialRevisionKind::Legacy(digest.into()),
    })
}

/// Revalidate a complete record at a live authorization boundary. `load()`
/// already performs these checks, but callers deliberately repeat them before
/// admitting a revision so injected/test loaders and future backends cannot
/// bypass canonical pin, key, domain, or generation validation.
pub(crate) fn validate_live_record(creds: &StoredCreds) -> Result<()> {
    validate_loaded_creds(creds)?;
    validate_complete_current_record(creds)
}

fn reconcile_backend_records(
    from_file: Option<StoredCreds>,
    from_keyring: Option<StoredCreds>,
    policy: BackendPolicy,
) -> Result<StoredCreds> {
    let file_order = from_file.as_ref().map(record_order).transpose()?.flatten();
    let keyring_order = from_keyring
        .as_ref()
        .map(record_order)
        .transpose()?
        .flatten();
    match (from_file, from_keyring, file_order, keyring_order) {
        (None, None, _, _) => Ok(StoredCreds::default()),
        (Some(file), None, _, _) => match policy {
            BackendPolicy::UnixCompleteFile | BackendPolicy::WindowsCompleteFile => Ok(file),
            BackendPolicy::NativeKeyring if record_is_empty(&file) => Ok(file),
            BackendPolicy::NativeKeyring => {
                let mut file = file;
                zeroize_stored_creds(&mut file);
                bail!("versioned native credential file has no matching complete keyring record")
            }
        },
        (None, Some(keyring), _, _) => Ok(keyring),
        (Some(file), Some(keyring), None, None) => reconcile_legacy_records(file, keyring, policy),
        (Some(mut file), Some(keyring), Some(_), None) => match policy {
            BackendPolicy::UnixCompleteFile | BackendPolicy::WindowsCompleteFile => {
                let mut keyring = keyring;
                zeroize_stored_creds(&mut keyring);
                Ok(file)
            }
            BackendPolicy::NativeKeyring => {
                zeroize_stored_creds(&mut file);
                let mut keyring = keyring;
                zeroize_stored_creds(&mut keyring);
                bail!("native keyring is legacy while its metadata file is versioned")
            }
        },
        (Some(mut file), Some(keyring), None, Some(_)) => match policy {
            BackendPolicy::UnixCompleteFile | BackendPolicy::WindowsCompleteFile
                if file.access_token.is_some() || file.host_private_key_seed.is_some() =>
            {
                let mut keyring = keyring;
                zeroize_stored_creds(&mut keyring);
                Ok(file)
            }
            _ => {
                zeroize_stored_creds(&mut file);
                Ok(keyring)
            }
        },
        (Some(file), Some(keyring), Some(file_order), Some(keyring_order)) => match policy {
            BackendPolicy::UnixCompleteFile | BackendPolicy::WindowsCompleteFile => {
                choose_complete_record(file, keyring, file_order, keyring_order)
            }
            BackendPolicy::NativeKeyring => {
                if file_order == keyring_order {
                    let mut projection = file_creds_without_private_seed(&keyring);
                    let matches = projection == file;
                    zeroize_stored_creds(&mut projection);
                    if !matches {
                        let mut file = file;
                        let mut keyring = keyring;
                        zeroize_stored_creds(&mut file);
                        zeroize_stored_creds(&mut keyring);
                        bail!("native credential backends disagree within one generation")
                    }
                }
                let mut file = file;
                zeroize_stored_creds(&mut file);
                Ok(keyring)
            }
        },
    }
}

fn record_is_empty(creds: &StoredCreds) -> bool {
    creds.credential_record_version.is_none()
        && creds.credential_generation.is_none()
        && creds.credential_record_id.is_none()
        && creds.access_token.is_none()
        && creds.host_id.is_none()
        && creds.server_url.is_none()
        && creds.host_private_key_seed.is_none()
        && creds.browser_pins.is_empty()
}

fn choose_complete_record(
    mut file: StoredCreds,
    mut keyring: StoredCreds,
    file_order: (u64, Uuid),
    keyring_order: (u64, Uuid),
) -> Result<StoredCreds> {
    if file_order == keyring_order && file != keyring {
        zeroize_stored_creds(&mut file);
        zeroize_stored_creds(&mut keyring);
        bail!("credential backends disagree within one record identity")
    }
    // The complete mode-0600 Unix file is the commit point. A keyring write can
    // succeed before the atomic file replacement fails, so a higher keyring
    // generation is only a partial attempt and must never roll the file forward.
    zeroize_stored_creds(&mut keyring);
    Ok(file)
}

fn reconcile_legacy_records(
    mut file: StoredCreds,
    mut keyring: StoredCreds,
    policy: BackendPolicy,
) -> Result<StoredCreds> {
    // Current Unix releases wrote a complete fallback even when keyring writes
    // succeeded. Prefer that coherent legacy set rather than allowing a stale
    // keyring token to override it. Older metadata-only/native layouts fill
    // only absent fields and reject every conflicting value.
    if policy.complete_file()
        && (file.access_token.is_some() || file.host_private_key_seed.is_some())
    {
        zeroize_stored_creds(&mut keyring);
        return Ok(file);
    }
    let merge_result = (|| {
        merge_legacy_field(
            &mut file.access_token,
            &mut keyring.access_token,
            "access token",
        )?;
        merge_legacy_field(&mut file.host_id, &mut keyring.host_id, "host ID")?;
        merge_legacy_field(&mut file.server_url, &mut keyring.server_url, "server URL")?;
        merge_legacy_field(
            &mut file.host_private_key_seed,
            &mut keyring.host_private_key_seed,
            "host private identity",
        )?;
        for pin in std::mem::take(&mut keyring.browser_pins) {
            merge_browser_pin(&mut file, pin).context("merging legacy keyring browser pins")?;
        }
        Ok(())
    })();
    if let Err(error) = merge_result {
        zeroize_stored_creds(&mut file);
        zeroize_stored_creds(&mut keyring);
        return Err(error);
    }
    zeroize_stored_creds(&mut keyring);
    Ok(file)
}

/// Build the one record that may be moved from the pre-scoping global keyring
/// account into the canonical default directory's scoped account. Unlike
/// ordinary Unix reconciliation, migration never silently prefers one side:
/// every overlapping field and pin must agree.
fn legacy_migration_record(
    from_file: Option<StoredCreds>,
    mut legacy_keyring: StoredCreds,
    policy: BackendPolicy,
) -> Result<StoredCreds> {
    let Some(mut file) = from_file else {
        return Ok(legacy_keyring);
    };
    let file_order = record_order(&file)?;
    let keyring_order = record_order(&legacy_keyring)?;
    match (file_order, keyring_order) {
        (Some(_), Some(_)) => {
            let matches = match policy {
                BackendPolicy::UnixCompleteFile | BackendPolicy::WindowsCompleteFile => {
                    file == legacy_keyring
                }
                BackendPolicy::NativeKeyring => {
                    let mut projection = file_creds_without_private_seed(&legacy_keyring);
                    let matches = projection == file;
                    zeroize_stored_creds(&mut projection);
                    matches
                }
            };
            if !matches {
                zeroize_stored_creds(&mut file);
                zeroize_stored_creds(&mut legacy_keyring);
                bail!("default config file conflicts with the legacy global keyring record")
            }
            match policy {
                BackendPolicy::UnixCompleteFile | BackendPolicy::WindowsCompleteFile => {
                    zeroize_stored_creds(&mut legacy_keyring);
                    Ok(file)
                }
                BackendPolicy::NativeKeyring => {
                    zeroize_stored_creds(&mut file);
                    Ok(legacy_keyring)
                }
            }
        }
        (Some(_), None) => {
            if !legacy_record_is_subset(&legacy_keyring, &file) {
                zeroize_stored_creds(&mut file);
                zeroize_stored_creds(&mut legacy_keyring);
                bail!("default config file conflicts with the legacy global keyring record")
            }
            zeroize_stored_creds(&mut legacy_keyring);
            Ok(file)
        }
        (None, Some(_)) => {
            if !legacy_record_is_subset(&file, &legacy_keyring) {
                zeroize_stored_creds(&mut file);
                zeroize_stored_creds(&mut legacy_keyring);
                bail!("default config file conflicts with the legacy global keyring record")
            }
            zeroize_stored_creds(&mut file);
            Ok(legacy_keyring)
        }
        (None, None) => reconcile_legacy_records_strict(file, legacy_keyring),
    }
}

fn legacy_record_is_subset(subset: &StoredCreds, complete: &StoredCreds) -> bool {
    fn field_is_subset<T: PartialEq>(subset: &Option<T>, complete: &Option<T>) -> bool {
        subset
            .as_ref()
            .is_none_or(|value| complete.as_ref() == Some(value))
    }
    field_is_subset(&subset.access_token, &complete.access_token)
        && field_is_subset(&subset.host_id, &complete.host_id)
        && field_is_subset(&subset.server_url, &complete.server_url)
        && field_is_subset(
            &subset.host_private_key_seed,
            &complete.host_private_key_seed,
        )
        && subset
            .browser_pins
            .iter()
            .all(|pin| complete.browser_pins.contains(pin))
}

fn reconcile_legacy_records_strict(
    mut file: StoredCreds,
    mut keyring: StoredCreds,
) -> Result<StoredCreds> {
    let merge_result = (|| {
        merge_legacy_field(
            &mut file.access_token,
            &mut keyring.access_token,
            "access token",
        )?;
        merge_legacy_field(&mut file.host_id, &mut keyring.host_id, "host ID")?;
        merge_legacy_field(&mut file.server_url, &mut keyring.server_url, "server URL")?;
        merge_legacy_field(
            &mut file.host_private_key_seed,
            &mut keyring.host_private_key_seed,
            "host private identity",
        )?;
        for pin in std::mem::take(&mut keyring.browser_pins) {
            merge_browser_pin(&mut file, pin).context("merging legacy keyring browser pins")?;
        }
        validate_loaded_creds(&file)
    })();
    if let Err(error) = merge_result {
        zeroize_stored_creds(&mut file);
        zeroize_stored_creds(&mut keyring);
        return Err(error);
    }
    zeroize_stored_creds(&mut keyring);
    Ok(file)
}

fn merge_legacy_field<T: PartialEq>(
    target: &mut Option<T>,
    source: &mut Option<T>,
    label: &str,
) -> Result<()> {
    match (target.as_ref(), source.as_ref()) {
        (Some(left), Some(right)) if left != right => {
            bail!("legacy credential backends conflict on {label}")
        }
        (None, Some(_)) => *target = source.take(),
        _ => {}
    }
    Ok(())
}

fn with_credential_lock<T>(operation: impl FnOnce() -> Result<T>) -> Result<T> {
    let path = config::config_dir()?.join(CREDENTIAL_LOCK_FILE);
    with_credential_lock_at(&path, operation)
}

fn with_credential_lock_at<T>(path: &Path, operation: impl FnOnce() -> Result<T>) -> Result<T> {
    validate_credential_directory(path.parent().unwrap_or_else(|| Path::new(".")))?;
    let file = open_credential_lock(path)?;
    file.lock()
        .with_context(|| format!("locking {}", path.display()))?;
    let outcome = operation();
    let unlock = file
        .unlock()
        .with_context(|| format!("unlocking {}", path.display()));
    drop(file);
    match outcome {
        Ok(value) => {
            unlock?;
            Ok(value)
        }
        Err(error) => {
            // Closing the file releases the OS lock even if explicit unlock
            // itself failed; preserve the operation error as the primary cause.
            let _ = unlock;
            Err(error)
        }
    }
}

#[cfg(unix)]
fn open_credential_lock(path: &Path) -> Result<std::fs::File> {
    use rustix::fs::{Mode, OFlags};

    let fd = rustix::fs::open(
        path,
        OFlags::RDWR | OFlags::CREATE | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::RUSR | Mode::WUSR,
    )
    .with_context(|| format!("opening credential lock {}", path.display()))?;
    let file = std::fs::File::from(fd);
    let metadata = file
        .metadata()
        .with_context(|| format!("inspecting credential lock {}", path.display()))?;
    validate_unix_credentials_metadata(path, &metadata, rustix::process::geteuid().as_raw())?;
    Ok(file)
}

#[cfg(windows)]
fn open_credential_lock(path: &Path) -> Result<std::fs::File> {
    match crate::platform::create_private_file_new(path) {
        Ok(file) => Ok(file),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            crate::platform::open_private_file(path, true)
        }
        Err(error) => Err(error),
    }
    .with_context(|| format!("opening credential lock {}", path.display()))
}

#[cfg(not(any(unix, windows)))]
fn open_credential_lock(path: &Path) -> Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(path)
        .with_context(|| format!("opening credential lock {}", path.display()))
}

/// Load one complete credential generation. Backend records are never overlaid:
/// reconciliation selects an entire versioned record, so tokens, host metadata,
/// private identity, and browser pins cannot come from different commits.
pub fn load() -> Result<StoredCreds> {
    with_credential_lock(|| {
        cleanup_stale_credential_temps(config::credentials_path()?.as_path())?;
        load_unlocked()
    })
}

fn load_unlocked() -> Result<StoredCreds> {
    load_unlocked_with_keyring_warning(true)
}

/// Reload for the live supervisor. The ordinary initial load reports a Unix
/// keyring outage once; a 500 ms monitor must not repeat that same warning
/// indefinitely when the complete mode-0600 Unix record is the designed
/// authoritative fallback.
pub(crate) fn load_for_live_reload() -> Result<StoredCreds> {
    with_credential_lock(|| {
        cleanup_stale_credential_temps(config::credentials_path()?.as_path())?;
        load_unlocked_with_keyring_warning(false)
    })
}

fn load_unlocked_with_keyring_warning(_warn_unix_keyring_unavailable: bool) -> Result<StoredCreds> {
    #[cfg(windows)]
    {
        return load_without_keyring(load_file_record()?);
    }

    #[cfg(unix)]
    let from_file = load_file_record()?;
    #[cfg(not(any(unix, windows)))]
    let mut from_file = load_file_record();

    #[cfg(not(windows))]
    if keyring_disabled() {
        #[cfg(unix)]
        return load_without_keyring(from_file);
        #[cfg(not(any(unix, windows)))]
        return load_without_keyring(from_file?);
    }

    #[cfg(not(windows))]
    let scope = keyring_scope()?;
    #[cfg(unix)]
    let file_for_migration = from_file.as_ref();
    #[cfg(not(any(unix, windows)))]
    let file_for_migration = from_file.as_ref().ok().and_then(Option::as_ref);
    #[cfg(not(windows))]
    let keyring_result = read_scoped_keyring_record(&scope, file_for_migration, platform_policy());
    #[cfg(unix)]
    {
        resolve_unix_keyring_read_with_warning(
            from_file,
            keyring_result,
            _warn_unix_keyring_unavailable,
        )
    }
    #[cfg(not(any(unix, windows)))]
    {
        let from_keyring = match keyring_result {
            Ok(record) => record,
            Err(failure) => {
                if let Ok(Some(record)) = from_file.as_mut() {
                    zeroize_stored_creds(record);
                }
                if failure.unavailable {
                    return Err(failure.error)
                        .context("reading required native-keyring credential record");
                }
                return Err(failure.error);
            }
        };
        reconcile_native_projection(from_file, from_keyring, save_file_for_platform)
    }
}

#[cfg(unix)]
fn resolve_unix_keyring_read_with_warning(
    mut from_file: Option<StoredCreds>,
    keyring_result: std::result::Result<Option<StoredCreds>, KeyringReadFailure>,
    warn_unavailable: bool,
) -> Result<StoredCreds> {
    match keyring_result {
        Ok(from_keyring) => {
            reconcile_backend_records(from_file, from_keyring, BackendPolicy::UnixCompleteFile)
        }
        Err(failure) if failure.unavailable => {
            if warn_unavailable {
                tracing::warn!(error = %failure.error, "keyring read failed; using the complete Unix credential record");
            }
            Ok(from_file.unwrap_or_default())
        }
        Err(failure) => {
            if let Some(record) = from_file.as_mut() {
                zeroize_stored_creds(record);
            }
            Err(failure.error)
        }
    }
}

#[cfg(any(not(any(unix, windows)), test))]
fn reconcile_native_projection<F>(
    from_file: Result<Option<StoredCreds>>,
    mut from_keyring: Option<StoredCreds>,
    save_projection: F,
) -> Result<StoredCreds>
where
    F: FnOnce(&StoredCreds) -> Result<()>,
{
    match from_file {
        Ok(from_file) => {
            reconcile_backend_records(from_file, from_keyring, BackendPolicy::NativeKeyring)
        }
        Err(file_error) => {
            let recoverable_torn_projection = file_error.chain().any(|cause| {
                cause
                    .downcast_ref::<serde_json::Error>()
                    .is_some_and(serde_json::Error::is_eof)
            });
            if !recoverable_torn_projection {
                if let Some(keyring) = from_keyring.as_mut() {
                    zeroize_stored_creds(keyring);
                }
                return Err(file_error)
                    .context("native credential projection failed strict validation");
            }
            let Some(keyring) = from_keyring.as_mut() else {
                return Err(file_error).context(
                    "native credential projection is corrupt and no complete keyring record exists",
                );
            };
            if let Err(error) = save_projection(keyring) {
                zeroize_stored_creds(keyring);
                return Err(error).context("rebuilding native credential projection from keyring");
            }
            tracing::warn!(error = %file_error, "rebuilt torn native credential projection from the complete keyring record");
            Ok(from_keyring.expect("validated complete keyring record remains present"))
        }
    }
}

/// Persist one new coherent generation. Unix uses the mode-0600 complete file
/// as its commit point and may mirror to a keyring. Windows uses only its
/// owner-DACL-protected complete file because Credential Manager cannot hold
/// the accepted record size. Other platforms retain the native-keyring policy.
pub fn save(creds: &mut StoredCreds, expected: &CredentialRevision) -> Result<()> {
    let policy = platform_policy();
    with_credential_lock(|| {
        cleanup_stale_credential_temps(config::credentials_path()?.as_path())?;
        save_cas_with_backends(
            creds,
            expected,
            load_unlocked,
            policy,
            |candidate| {
                if policy == BackendPolicy::WindowsCompleteFile {
                    return Ok(());
                }
                if keyring_disabled() {
                    if policy.complete_file() {
                        return Ok(());
                    }
                    bail!("OS keyring is disabled")
                }
                keyring_set(candidate)
            },
            save_file_for_platform,
        )
    })
}

fn save_cas_with_backends<L, K, F>(
    candidate: &mut StoredCreds,
    expected: &CredentialRevision,
    load_current: L,
    policy: BackendPolicy,
    set_keyring: K,
    save_file: F,
) -> Result<()>
where
    L: FnOnce() -> Result<StoredCreds>,
    K: FnOnce(&StoredCreds) -> Result<()>,
    F: FnOnce(&StoredCreds) -> Result<()>,
{
    let candidate_matches_base = match &expected.kind {
        CredentialRevisionKind::Current { .. } => &credential_revision(candidate)? == expected,
        CredentialRevisionKind::Legacy(_) => record_order(candidate)?.is_none(),
    };
    if !candidate_matches_base {
        bail!("credential update base changed before commit")
    }
    let mut durable = load_current().context("rereading credentials inside commit lock")?;
    let durable_revision = match credential_revision(&durable) {
        Ok(revision) => revision,
        Err(error) => {
            zeroize_stored_creds(&mut durable);
            return Err(error);
        }
    };
    zeroize_stored_creds(&mut durable);
    if durable_revision != *expected {
        bail!("credential update is stale; reload credentials and retry")
    }

    let mut committed = candidate.clone();
    if let Err(error) = save_with_backends(&mut committed, policy, set_keyring, save_file) {
        zeroize_stored_creds(&mut committed);
        return Err(error);
    }
    let mut previous = std::mem::replace(candidate, committed);
    zeroize_stored_creds(&mut previous);
    Ok(())
}

fn save_with_backends<K, F>(
    creds: &mut StoredCreds,
    policy: BackendPolicy,
    set_keyring: K,
    save_file: F,
) -> Result<()>
where
    K: FnOnce(&StoredCreds) -> Result<()>,
    F: FnOnce(&StoredCreds) -> Result<()>,
{
    advance_credential_generation(creds)?;
    // Validate the complete coherent record, including both serialized backend
    // bounds, before either backend can observe an update.
    validate_persistable_creds(creds)?;
    validate_complete_current_record(creds)?;
    match policy {
        BackendPolicy::UnixCompleteFile => {
            if let Err(error) = set_keyring(creds) {
                tracing::warn!(error = %error, "keyring write failed; committing the complete Unix file fallback");
            }
            save_file(creds)
        }
        BackendPolicy::WindowsCompleteFile => save_file(creds),
        BackendPolicy::NativeKeyring => {
            set_keyring(creds).context("persisting required native-keyring credential record")?;
            save_file(creds)
        }
    }
}

#[cfg(any(unix, windows))]
fn save_file_for_platform(creds: &StoredCreds) -> Result<()> {
    save_file(creds)
}

#[cfg(not(any(unix, windows)))]
fn save_file_for_platform(creds: &StoredCreds) -> Result<()> {
    // Non-Unix platforms do not have this module's audited mode-0600 fallback.
    // Keep public metadata and the legacy token fallback, but the private seed
    // is stored only in the native keyring.
    let mut file_creds = file_creds_without_private_seed(creds);
    let result = save_file(&file_creds);
    zeroize_stored_creds(&mut file_creds);
    result
}

fn file_creds_without_private_seed(creds: &StoredCreds) -> StoredCreds {
    // Construct this field-by-field: cloning the whole value would transiently
    // copy the private seed before replacing it with None.
    StoredCreds {
        credential_record_version: creds.credential_record_version,
        credential_generation: creds.credential_generation,
        credential_record_id: creds.credential_record_id.clone(),
        access_token: creds.access_token.clone(),
        host_id: creds.host_id,
        server_url: creds.server_url.clone(),
        host_private_key_seed: None,
        browser_pins: creds.browser_pins.clone(),
    }
}

/// Return the existing host identity, or generate and attach one exactly once.
/// Callers persist the updated credentials before beginning device approval.
pub fn ensure_host_identity(creds: &mut StoredCreds) -> Result<HostIdentity> {
    if creds.host_private_key_seed.is_none() {
        let mut seed = [0_u8; ED25519_SEED_BYTES];
        if let Err(error) = getrandom::getrandom(&mut seed) {
            seed.zeroize();
            return Err(error).context("generating Ed25519 host identity");
        }
        creds.host_private_key_seed = Some(URL_SAFE_NO_PAD.encode(seed));
        seed.zeroize();
    }
    host_identity(creds)?.context("host identity was not generated")
}

/// Derive only public presentation data from a stored seed without generating.
pub fn host_identity(creds: &StoredCreds) -> Result<Option<HostIdentity>> {
    let Some(signing_key) = host_signing_key(creds)? else {
        return Ok(None);
    };
    let public_bytes = signing_key.verifying_key().to_bytes();
    let public_key = URL_SAFE_NO_PAD.encode(public_bytes);
    let digest = Sha256::digest(public_bytes);
    let fingerprint = format!(
        "SHA256:{}",
        URL_SAFE_NO_PAD.encode(&digest[..FINGERPRINT_HASH_BYTES])
    );
    Ok(Some(HostIdentity {
        algorithm: HOST_KEY_ALGORITHM,
        public_key,
        fingerprint,
    }))
}

/// Sign the exact server-issued ceremony challenge without exposing the seed.
pub fn sign_host_pair_possession(
    creds: &StoredCreds,
    device_code: &str,
    approval_nonce: &str,
) -> Result<String> {
    let signing_key = host_signing_key(creds)?.context("host identity was not generated")?;
    let host_public_key = URL_SAFE_NO_PAD.encode(signing_key.verifying_key().to_bytes());
    let transcript =
        HostPairPossessionTranscript::from_wire(device_code, approval_nonce, &host_public_key)
            .context("constructing host-pair possession transcript")?;
    Ok(signature_to_wire(&sign_transcript(
        &signing_key,
        &transcript,
    )))
}

/// An owned, `'static` capability to sign RTC answer transcripts with the host
/// identity key. It exposes only a signing method (never the seed) so it can be
/// moved into the async negotiation task that produces the answer SDP.
#[derive(Clone)]
pub struct HostRtcAnswerSigner {
    signing_key: SigningKey,
}

impl HostRtcAnswerSigner {
    /// Sign a negotiated answer transcript, returning the opaque wire envelope.
    pub fn sign(
        &self,
        protocol: RtcProtocol,
        transcript: &SignedSignalTranscript,
    ) -> Result<String> {
        sign_rtc_signal_wire(&self.signing_key, protocol, transcript)
            .context("signing RTC answer transcript")
    }
}

/// Derive an owned host RTC answer signer from the loaded record, or `None` when
/// no host identity has been generated yet. Seed decoding stays in `creds`;
/// callers receive only the sign capability.
pub fn host_rtc_answer_signer(creds: &StoredCreds) -> Result<Option<HostRtcAnswerSigner>> {
    let Some(signing_key) = host_signing_key(creds)? else {
        return Ok(None);
    };
    Ok(Some(HostRtcAnswerSigner { signing_key }))
}

fn host_signing_key(creds: &StoredCreds) -> Result<Option<SigningKey>> {
    let Some(encoded_seed) = creds.host_private_key_seed.as_deref() else {
        return Ok(None);
    };
    if encoded_seed.len() != ED25519_SEED_B64URL_LENGTH {
        bail!("stored Ed25519 host identity has the wrong encoded length")
    }
    let mut seed = [0_u8; ED25519_SEED_BYTES];
    let decoded_len = match URL_SAFE_NO_PAD.decode_slice(encoded_seed, &mut seed) {
        Ok(decoded_len) => decoded_len,
        Err(error) => {
            seed.zeroize();
            return Err(error).context("decoding stored Ed25519 host identity");
        }
    };
    let mut canonical = URL_SAFE_NO_PAD.encode(seed);
    let canonical_matches = decoded_len == ED25519_SEED_BYTES && canonical == encoded_seed;
    canonical.zeroize();
    if !canonical_matches {
        seed.zeroize();
        bail!("stored Ed25519 host identity is not canonical")
    }
    let signing_key = SigningKey::from_bytes(&seed);
    seed.zeroize();
    Ok(Some(signing_key))
}

/// Wipe stored creds (file + keyring).
pub async fn logout() -> Result<()> {
    let outcome = reset_local_credentials()?;
    if outcome.file_removed {
        let path = outcome
            .path
            .expect("a removed credential file always has a path");
        println!("spawn: removed {}", path.display());
    } else {
        println!("spawn: no stored credentials");
    }
    Ok(())
}

/// Clear both credential backends without presentation output. Recovery
/// commands use this before removing the rest of the instance directory.
pub(crate) fn reset_local_credentials() -> Result<ClearOutcome> {
    with_credential_lock(|| {
        let path = config::credentials_path()?;
        cleanup_stale_credential_temps(&path)?;
        clear_stored_credentials(
            Ok(path),
            keyring_delete,
            |path| std::fs::remove_file(path),
            sync_parent_directory,
        )
    })
}

/// Remove only the daemon token while retaining the host identity, server,
/// Host ID, and browser pins for a one-approval re-attachment.
pub fn logout_keep_identity() -> Result<()> {
    let mut stored = load().context("loading credentials to sign out")?;
    let expected = credential_revision(&stored)?;
    if let Some(token) = stored.access_token.as_mut() {
        token.zeroize();
    }
    stored.access_token = None;
    save(&mut stored, &expected).context("persisting signed-out host identity")
}

pub(crate) struct ClearOutcome {
    path: Option<PathBuf>,
    file_removed: bool,
}

fn clear_stored_credentials<K, F, S>(
    path_result: Result<PathBuf>,
    delete_keyring: K,
    remove_file: F,
    sync_parent: S,
) -> Result<ClearOutcome>
where
    K: FnOnce() -> Result<()>,
    F: FnOnce(&Path) -> std::io::Result<()>,
    S: FnOnce(&Path) -> std::io::Result<()>,
{
    let mut failures = Vec::new();
    if let Err(error) = delete_keyring() {
        failures.push(format!("keyring: {error:#}"));
    }

    let mut outcome = ClearOutcome {
        path: None,
        file_removed: false,
    };
    match path_result {
        Ok(path) => {
            match remove_file(&path) {
                Ok(()) => {
                    outcome.file_removed = true;
                    let parent = path.parent().unwrap_or_else(|| Path::new("."));
                    if let Err(error) = sync_parent(parent) {
                        failures.push(format!("syncing {}: {error}", parent.display()));
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => failures.push(format!("{}: {error}", path.display())),
            }
            outcome.path = Some(path);
        }
        Err(error) => failures.push(format!("credential file path: {error:#}")),
    }

    if failures.is_empty() {
        Ok(outcome)
    } else {
        bail!("credential reset incomplete: {}", failures.join("; "))
    }
}

fn keyring_disabled() -> bool {
    // An explicit override wins in both directions.
    if let Ok(value) = std::env::var("SPAWN_DISABLE_KEYRING") {
        match value.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => return true,
            "0" | "false" | "no" | "off" => return false,
            _ => {}
        }
    }
    // Default off on macOS: the login Keychain re-prompts on every access for a
    // binary without a stable Developer ID signature (our prebuilts are only
    // ad-hoc signed), and the daemon's 500 ms live-reload monitor turns that
    // into an unusable password-prompt storm. The complete mode-0600 file is
    // the authoritative credential record on Unix regardless, so fall to it.
    // Other platforms keep the keyring by default; a signed macOS build can opt
    // back in with SPAWN_DISABLE_KEYRING=0.
    cfg!(target_os = "macos")
}

/// `spawnd status` — print what we know. The "server:" line shows the URL the
/// other commands would actually use: explicit flag/env, else the stored one.
#[allow(dead_code)] // Pre-TUI formatter retained for byte-equality regression tests.
pub async fn status(server_cli: Option<String>) -> Result<()> {
    let creds = load().context("loading stored credentials")?;
    let server = config::server_url_for_instance(server_cli, creds.server_url.as_deref())?;
    print!("{}", format_status(server.as_ref(), &creds)?);
    Ok(())
}

#[allow(dead_code)]
fn format_status(server: &str, creds: &StoredCreds) -> Result<String> {
    let mut output = String::new();
    writeln!(&mut output, "server:     {server}")?;
    writeln!(
        &mut output,
        "configured: {}",
        creds.server_url.as_deref().unwrap_or("(none)")
    )?;
    writeln!(
        &mut output,
        "logged in:  {}",
        if creds.is_logged_in() { "yes" } else { "no" }
    )?;
    writeln!(
        &mut output,
        "host_id:    {}",
        creds
            .host_id
            .map(|host_id| host_id.to_string())
            .unwrap_or_else(|| "(none)".into())
    )?;
    match host_identity(creds)? {
        Some(identity) => {
            writeln!(
                &mut output,
                "host key:   {} {}",
                identity.algorithm, identity.public_key
            )?;
            writeln!(&mut output, "fingerprint: {}", identity.fingerprint)?;
        }
        None => {
            writeln!(&mut output, "host key:   (none; run `spawnd login`)")?;
            writeln!(&mut output, "fingerprint: (none)")?;
        }
    }
    writeln!(&mut output, "browser pins: {}", creds.browser_pins().len())?;
    for pin in creds.browser_pins() {
        writeln!(
            &mut output,
            "browser pin:  {} {} {}",
            pin.device_id(),
            pin.key_algorithm(),
            pin.fingerprint()
        )?;
    }
    Ok(output)
}

// ---------------------------------------------------------------------------
// keyring
// ---------------------------------------------------------------------------

fn keyring_entry(user: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, user).context("constructing keyring entry")
}

fn keyring_get_for_user(user: &str) -> Result<Option<String>> {
    let entry = keyring_entry(user)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

#[derive(Debug)]
struct KeyringReadFailure {
    error: anyhow::Error,
    /// Only raw backend reads are eligible for Unix's complete-file fallback.
    /// Corrupt values, conflicts, and incomplete migrations remain fatal.
    unavailable: bool,
}

fn read_scoped_keyring_record(
    scope: &KeyringScope,
    from_file: Option<&StoredCreds>,
    policy: BackendPolicy,
) -> std::result::Result<Option<StoredCreds>, KeyringReadFailure> {
    read_scoped_keyring_record_with(
        scope,
        from_file,
        policy,
        keyring_get_for_user,
        keyring_set_for_user,
        keyring_delete_for_user,
    )
}

fn read_scoped_keyring_record_with<G, S, D>(
    scope: &KeyringScope,
    from_file: Option<&StoredCreds>,
    policy: BackendPolicy,
    mut get: G,
    mut set: S,
    mut delete: D,
) -> std::result::Result<Option<StoredCreds>, KeyringReadFailure>
where
    G: FnMut(&str) -> Result<Option<String>>,
    S: FnMut(&str, &StoredCreds) -> Result<()>,
    D: FnMut(&str) -> Result<()>,
{
    let scoped = get(&scope.user).map_err(|error| KeyringReadFailure {
        error,
        unavailable: true,
    })?;
    if let Some(mut value) = scoped {
        return decode_keyring_value_and_wipe(&mut value)
            .map(Some)
            .map_err(|error| KeyringReadFailure {
                error,
                unavailable: false,
            });
    }
    if !scope.migrate_legacy_global {
        return Ok(None);
    }
    let Some(mut legacy_value) = get(KEYRING_USER).map_err(|error| KeyringReadFailure {
        error,
        unavailable: true,
    })?
    else {
        return Ok(None);
    };
    let legacy =
        decode_keyring_value_and_wipe(&mut legacy_value).map_err(|error| KeyringReadFailure {
            error,
            unavailable: false,
        })?;
    let mut migrated =
        legacy_migration_record(from_file.cloned(), legacy, policy).map_err(|error| {
            KeyringReadFailure {
                error,
                unavailable: false,
            }
        })?;
    if let Err(error) = set(&scope.user, &migrated) {
        zeroize_stored_creds(&mut migrated);
        return Err(KeyringReadFailure {
            error: error.context("writing scoped keyring record during legacy migration"),
            unavailable: false,
        });
    }
    if let Err(error) = delete(KEYRING_USER) {
        zeroize_stored_creds(&mut migrated);
        return Err(KeyringReadFailure {
            error: error.context("deleting legacy global keyring record after scoped migration"),
            unavailable: false,
        });
    }
    Ok(Some(migrated))
}

fn decode_keyring_value(value: &str) -> Result<StoredCreds> {
    if value.len() > MAX_CREDENTIALS_FILE_BYTES {
        bail!("stored keyring credential bundle is too large")
    }
    // Backward compatibility: legacy JSON secret bundles are a strict subset
    // of StoredCreds, while an older raw daemon token remains supported. The
    // next save upgrades either form to a complete versioned record.
    if value.trim_start().starts_with('{') {
        let mut creds: StoredCreds =
            serde_json::from_str(value).context("parsing keyring credential record")?;
        if let Err(error) = validate_loaded_creds(&creds) {
            zeroize_stored_creds(&mut creds);
            return Err(error);
        }
        if let Err(error) = validate_complete_current_record(&creds) {
            zeroize_stored_creds(&mut creds);
            return Err(error);
        }
        Ok(creds)
    } else {
        if value.len() > MAX_ACCESS_TOKEN_BYTES {
            bail!("stored keyring access token is too large")
        }
        let mut creds = StoredCreds::default();
        creds.access_token = Some(value.to_owned());
        Ok(creds)
    }
}

fn decode_keyring_value_and_wipe(value: &mut String) -> Result<StoredCreds> {
    let decoded = decode_keyring_value(value);
    value.zeroize();
    decoded
}

fn keyring_set(creds: &StoredCreds) -> Result<()> {
    let scope = keyring_scope()?;
    keyring_set_for_user(&scope.user, creds)
}

fn keyring_set_for_user(user: &str, creds: &StoredCreds) -> Result<()> {
    let entry = keyring_entry(user)?;
    let mut record = creds.clone();
    let mut encoded = match serde_json::to_string(&record) {
        Ok(encoded) => encoded,
        Err(error) => {
            zeroize_stored_creds(&mut record);
            return Err(error.into());
        }
    };
    if encoded.len() > MAX_CREDENTIALS_FILE_BYTES {
        encoded.zeroize();
        zeroize_stored_creds(&mut record);
        bail!("keyring credential bundle is too large")
    }
    let result = entry.set_password(&encoded);
    encoded.zeroize();
    zeroize_stored_creds(&mut record);
    result.map_err(Into::into)
}

#[cfg(not(windows))]
fn keyring_delete() -> Result<()> {
    let scope = keyring_scope()?;
    delete_keyring_scope_with(&scope, keyring_delete_for_user)
}

#[cfg(windows)]
fn keyring_delete() -> Result<()> {
    // Windows credentials are authoritative only in the protected complete
    // file; SPAWN D never creates a Credential Manager mirror.
    Ok(())
}

fn delete_keyring_scope_with<D>(scope: &KeyringScope, mut delete: D) -> Result<()>
where
    D: FnMut(&str) -> Result<()>,
{
    let mut failures = Vec::new();
    if let Err(error) = delete(&scope.user) {
        failures.push(format!("scoped keyring: {error:#}"));
    }
    if scope.migrate_legacy_global {
        if let Err(error) = delete(KEYRING_USER) {
            failures.push(format!("legacy default keyring: {error:#}"));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        bail!("keyring reset incomplete: {}", failures.join("; "))
    }
}

fn keyring_delete_for_user(user: &str) -> Result<()> {
    let entry = keyring_entry(user)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

// ---------------------------------------------------------------------------
// file fallback
// ---------------------------------------------------------------------------

fn load_file_record() -> Result<Option<StoredCreds>> {
    let path = config::credentials_path()?;
    load_file_record_at(&path)
}

#[cfg(test)]
fn load_file_at(path: &Path) -> Result<StoredCreds> {
    Ok(load_file_record_at(path)?.unwrap_or_default())
}

fn load_file_record_at(path: &Path) -> Result<Option<StoredCreds>> {
    let Some(mut raw) = read_credentials_file(path)? else {
        return Ok(None);
    };
    let parsed = serde_json::from_slice(&raw);
    raw.zeroize();
    let mut creds: StoredCreds = parsed.with_context(|| format!("parsing {}", path.display()))?;
    if let Err(error) = validate_loaded_creds(&creds) {
        zeroize_stored_creds(&mut creds);
        return Err(error);
    }
    #[cfg(any(unix, windows))]
    if let Err(error) = validate_complete_current_record(&creds) {
        zeroize_stored_creds(&mut creds);
        return Err(error);
    }
    Ok(Some(creds))
}

fn save_file(creds: &StoredCreds) -> Result<()> {
    let path = config::credentials_path()?;
    save_file_at(&path, creds)
}

fn save_file_at(path: &Path, creds: &StoredCreds) -> Result<()> {
    validate_persistable_creds(creds)?;
    let mut json = serde_json::to_vec_pretty(creds)?;
    let result = write_secure(path, &json).with_context(|| format!("writing {}", path.display()));
    json.zeroize();
    result
}

fn validate_secret_bounds(access_token: Option<&str>, encoded_seed: Option<&str>) -> Result<()> {
    if access_token.is_some_and(|value| value.len() > MAX_ACCESS_TOKEN_BYTES) {
        bail!("stored access token is too large")
    }
    if encoded_seed.is_some_and(|value| value.len() != ED25519_SEED_B64URL_LENGTH) {
        bail!("stored Ed25519 host identity has the wrong encoded length")
    }
    Ok(())
}

fn validate_loaded_creds(creds: &StoredCreds) -> Result<()> {
    record_order(creds)?;
    validate_secret_bounds(
        creds.access_token.as_deref(),
        creds.host_private_key_seed.as_deref(),
    )?;
    if creds
        .server_url
        .as_deref()
        .is_some_and(|value| value.len() > MAX_SERVER_URL_BYTES)
    {
        bail!("stored server URL is too large")
    }
    let identity = host_identity(creds)?;
    validate_browser_pins(&creds.browser_pins)?;
    // Re-derive every retained verdict from its proof. A credential file whose
    // approval evidence no longer matches its host key fails to load rather
    // than serving a pin whose provenance silently stopped being true.
    if let Some(identity) = &identity {
        for pin in &creds.browser_pins {
            pin.verify_approval(&identity.public_key).with_context(|| {
                format!(
                    "re-verifying the retained approval proof for browser device {}",
                    pin.browser_device_id
                )
            })?;
        }
    }
    if !creds.browser_pins.is_empty() {
        creds
            .host_id
            .context("stored browser pins have no host trust domain")?;
        canonical_server_origin(
            creds
                .server_url
                .as_deref()
                .context("stored browser pins have no server trust domain")?,
        )?;
    }
    Ok(())
}

fn validate_complete_current_record(creds: &StoredCreds) -> Result<()> {
    if record_order(creds)?.is_some() && creds.host_private_key_seed.is_none() {
        bail!("versioned complete credential record omitted the host private identity")
    }
    Ok(())
}

fn validate_persistable_creds(creds: &StoredCreds) -> Result<()> {
    validate_loaded_creds(creds)?;
    let mut file_json = serde_json::to_vec_pretty(creds)?;
    let file_len = file_json.len();
    file_json.zeroize();
    if file_len > MAX_CREDENTIALS_FILE_BYTES {
        bail!("credential record is too large")
    }
    let mut keyring_record = creds.clone();
    let mut keyring_json = match serde_json::to_string(&keyring_record) {
        Ok(json) => json,
        Err(error) => {
            zeroize_stored_creds(&mut keyring_record);
            return Err(error.into());
        }
    };
    let keyring_len = keyring_json.len();
    keyring_json.zeroize();
    zeroize_stored_creds(&mut keyring_record);
    if keyring_len > MAX_CREDENTIALS_FILE_BYTES {
        bail!("keyring credential bundle is too large")
    }
    Ok(())
}

fn validate_browser_pin(pin: &BrowserPin) -> Result<()> {
    let mut validated = browser_pin_from_approval(
        &pin.browser_device_id,
        &pin.browser_key_algorithm,
        &pin.browser_public_key,
        &pin.browser_key_fingerprint,
    )?;
    if let Some(proof) = &pin.approval_proof {
        validated = attach_browser_approval_proof(
            validated,
            &proof.account_id,
            &proof.approval_nonce,
            &proof.signature,
        )
        .context("validating the retained browser approval proof")?;
    }
    if &validated != pin {
        bail!("stored browser pin is not canonical")
    }
    Ok(())
}

fn validate_browser_pins(pins: &[BrowserPin]) -> Result<()> {
    if pins.len() > MAX_BROWSER_PINS {
        bail!("stored browser pin capacity exceeds {MAX_BROWSER_PINS}")
    }
    let mut device_ids = HashSet::with_capacity(pins.len());
    let mut public_keys = HashSet::with_capacity(pins.len());
    let mut previous_device_id: Option<&str> = None;
    for pin in pins {
        validate_browser_pin(pin)?;
        if previous_device_id.is_some_and(|previous| previous >= pin.browser_device_id.as_str()) {
            bail!("stored browser pins are duplicated or not deterministically ordered")
        }
        if !device_ids.insert(pin.browser_device_id.as_str()) {
            bail!("stored browser pin has a duplicate device ID")
        }
        if !public_keys.insert(pin.browser_public_key.as_str()) {
            bail!("stored browser pin has a duplicate public key")
        }
        previous_device_id = Some(pin.browser_device_id.as_str());
    }
    Ok(())
}

fn zeroize_stored_creds(creds: &mut StoredCreds) {
    creds.wipe_sensitive_fields();
}

fn validate_credential_directory(path: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        return crate::platform::validate_private_dir(path)
            .with_context(|| format!("validating credential directory {}", path.display()));
    }

    let metadata = std::fs::symlink_metadata(path)
        .with_context(|| format!("inspecting credential directory {}", path.display()))?;
    if !metadata.file_type().is_dir() {
        bail!(
            "credential directory is not a real directory: {}",
            path.display()
        )
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != rustix::process::geteuid().as_raw() {
            bail!(
                "credential directory is not owned by the current user: {}",
                path.display()
            )
        }
        if metadata.permissions().mode() & 0o022 != 0 {
            bail!(
                "credential directory is writable by group or other users: {}",
                path.display()
            )
        }
    }
    Ok(())
}

fn sync_parent_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::fs::File::open(path)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        // The Windows replacement primitive below requests write-through. Some
        // other platforms cannot open directories as files, so there is no
        // additional portable directory handle to flush here.
        let _ = path;
        Ok(())
    }
}

fn cleanup_stale_credential_temps(credentials_path: &Path) -> Result<()> {
    let parent = credentials_path.parent().unwrap_or_else(|| Path::new("."));
    validate_credential_directory(parent)?;
    let mut removed = false;
    for entry in std::fs::read_dir(parent)
        .with_context(|| format!("enumerating credential directory {}", parent.display()))?
    {
        let entry = entry.with_context(|| format!("reading {}", parent.display()))?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(record_id) = name
            .strip_prefix(".credentials.")
            .and_then(|name| name.strip_suffix(".tmp"))
        else {
            continue;
        };
        let Ok(parsed) = Uuid::parse_str(record_id) else {
            continue;
        };
        if parsed.to_string() != record_id {
            continue;
        }
        let path = entry.path();
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(error).with_context(|| format!("inspecting {}", path.display()))
            }
        };
        if !metadata.file_type().is_file() {
            continue;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if metadata.uid() != rustix::process::geteuid().as_raw()
                || metadata.permissions().mode() & 0o777 != 0o600
            {
                continue;
            }
        }
        #[cfg(windows)]
        if crate::platform::open_private_file(&path, false).is_err() {
            // Never follow or remove an attacker-controlled reparse point or a
            // file whose owner-only DACL cannot be proven.
            continue;
        }
        std::fs::remove_file(&path)
            .with_context(|| format!("removing stale credential temporary {}", path.display()))?;
        removed = true;
    }
    if removed {
        sync_parent_directory(parent)
            .with_context(|| format!("syncing credential directory {}", parent.display()))?;
    }
    Ok(())
}

#[cfg(unix)]
fn read_credentials_file(path: &Path) -> Result<Option<Vec<u8>>> {
    use rustix::fs::{Mode, OFlags};

    let fd = match rustix::fs::open(
        path,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    ) {
        Ok(fd) => fd,
        Err(error) if error == rustix::io::Errno::NOENT => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("opening {}", path.display())),
    };
    let mut file = std::fs::File::from(fd);
    let metadata = file
        .metadata()
        .with_context(|| format!("inspecting {}", path.display()))?;
    validate_unix_credentials_metadata(path, &metadata, rustix::process::geteuid().as_raw())?;
    if metadata.len() > MAX_CREDENTIALS_FILE_BYTES as u64 {
        bail!("credential fallback is too large: {}", path.display())
    }
    let mut raw = Vec::with_capacity(metadata.len() as usize);
    let read_result = Read::by_ref(&mut file)
        .take((MAX_CREDENTIALS_FILE_BYTES + 1) as u64)
        .read_to_end(&mut raw)
        .with_context(|| format!("reading {}", path.display()));
    if let Err(error) = read_result {
        raw.zeroize();
        return Err(error);
    }
    if raw.len() > MAX_CREDENTIALS_FILE_BYTES {
        raw.zeroize();
        bail!("credential fallback is too large: {}", path.display())
    }
    Ok(Some(raw))
}

#[cfg(unix)]
fn validate_unix_credentials_metadata(
    path: &Path,
    metadata: &std::fs::Metadata,
    expected_uid: u32,
) -> Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    if !metadata.is_file() {
        bail!(
            "credential fallback is not a regular file: {}",
            path.display()
        )
    }
    if metadata.uid() != expected_uid {
        bail!(
            "credential fallback is not owned by the current user: {}",
            path.display()
        )
    }
    if metadata.permissions().mode() & 0o077 != 0 {
        bail!(
            "credential fallback has group or other permissions: {}",
            path.display()
        )
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn read_credentials_file(path: &Path) -> Result<Option<Vec<u8>>> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("inspecting {}", path.display())),
    };
    if !metadata.is_file() {
        bail!(
            "credential fallback is not a regular file: {}",
            path.display()
        )
    }
    if metadata.len() > MAX_CREDENTIALS_FILE_BYTES as u64 {
        bail!("credential fallback is too large: {}", path.display())
    }
    let mut raw = Vec::with_capacity(metadata.len() as usize);
    let read_result = std::fs::File::open(path)?
        .take((MAX_CREDENTIALS_FILE_BYTES + 1) as u64)
        .read_to_end(&mut raw);
    if let Err(error) = read_result {
        raw.zeroize();
        return Err(error.into());
    }
    if raw.len() > MAX_CREDENTIALS_FILE_BYTES {
        raw.zeroize();
        bail!("credential fallback is too large: {}", path.display())
    }
    Ok(Some(raw))
}

#[cfg(windows)]
fn read_credentials_file(path: &Path) -> Result<Option<Vec<u8>>> {
    let mut file = match crate::platform::open_private_file(path, false) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("opening {}", path.display())),
    };
    let metadata = file
        .metadata()
        .with_context(|| format!("inspecting {}", path.display()))?;
    if metadata.len() > MAX_CREDENTIALS_FILE_BYTES as u64 {
        bail!("credential fallback is too large: {}", path.display())
    }
    let mut raw = Vec::with_capacity(metadata.len() as usize);
    let read_result = Read::by_ref(&mut file)
        .take((MAX_CREDENTIALS_FILE_BYTES + 1) as u64)
        .read_to_end(&mut raw)
        .with_context(|| format!("reading {}", path.display()));
    if let Err(error) = read_result {
        raw.zeroize();
        return Err(error);
    }
    if raw.len() > MAX_CREDENTIALS_FILE_BYTES {
        raw.zeroize();
        bail!("credential fallback is too large: {}", path.display())
    }
    Ok(Some(raw))
}

fn write_secure(path: &Path, data: &[u8]) -> std::io::Result<()> {
    write_secure_with_parent_sync(path, data, sync_parent_directory)
}

fn write_secure_with_parent_sync<S>(path: &Path, data: &[u8], sync_parent: S) -> std::io::Result<()>
where
    S: Fn(&Path) -> std::io::Result<()>,
{
    // Write atomically: unique temp file in the same directory, then durable replace.
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    #[cfg(windows)]
    let private_parent = crate::platform::open_private_dir(parent)?;
    let mut tmp = parent.to_path_buf();
    tmp.push(format!(".credentials.{}.tmp", Uuid::new_v4()));
    let result = (|| {
        #[cfg(unix)]
        let mut f = {
            use std::os::unix::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&tmp)?
        };
        #[cfg(windows)]
        let mut f = crate::platform::create_private_file_new_at(
            &private_parent,
            Path::new(tmp.file_name().expect("credential temp has a leaf name")),
        )?;
        #[cfg(not(any(unix, windows)))]
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        durable_replace(&tmp, path)?;
        sync_parent(parent)?;
        Ok(())
    })();
    if result.is_err() {
        match std::fs::remove_file(&tmp) {
            Ok(()) => {
                let _ = sync_parent_directory(parent);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(std::io::Error::other(format!(
                    "credential write failed and temporary cleanup also failed: {error}"
                )))
            }
        }
    }
    result
}

fn durable_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    crate::platform::durable_replace(from, to)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    const RFC_KEY_ONE: &str = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
    const RFC_KEY_TWO: &str = "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw";
    const LOCK_HELPER_PATH_ENV: &str = "SPAWN_TEST_CREDENTIAL_LOCK_PATH";
    const LOCK_HELPER_READY_ENV: &str = "SPAWN_TEST_CREDENTIAL_LOCK_READY";
    const LOCK_HELPER_ACQUIRED_ENV: &str = "SPAWN_TEST_CREDENTIAL_LOCK_ACQUIRED";
    const FALLBACK_HELPER_PATH_ENV: &str = "SPAWN_TEST_NO_KEYRING_LOGIN_PATH";
    const FALLBACK_HELPER_EVIDENCE_ENV: &str = "SPAWN_TEST_NO_KEYRING_LOGIN_EVIDENCE";

    fn fixed_creds() -> StoredCreds {
        let mut creds = StoredCreds::default();
        creds.host_private_key_seed = Some(URL_SAFE_NO_PAD.encode([7_u8; ED25519_SEED_BYTES]));
        creds
    }

    fn complete_record(
        generation: u64,
        record_id: u128,
        token: &str,
        host_id: u128,
        server: &str,
        seed_byte: u8,
    ) -> StoredCreds {
        StoredCreds {
            credential_record_version: Some(CREDENTIAL_RECORD_VERSION),
            credential_generation: Some(generation),
            credential_record_id: Some(Uuid::from_u128(record_id).to_string()),
            access_token: Some(token.into()),
            host_id: Some(Uuid::from_u128(host_id)),
            server_url: Some(server.into()),
            host_private_key_seed: Some(URL_SAFE_NO_PAD.encode([seed_byte; ED25519_SEED_BYTES])),
            browser_pins: Vec::new(),
        }
    }

    fn assert_same_coherent_record(actual: &StoredCreds, expected: &StoredCreds) {
        assert!(actual == expected);
        assert_eq!(actual.access_token, expected.access_token);
        assert_eq!(actual.host_id, expected.host_id);
        assert_eq!(actual.server_url, expected.server_url);
        assert_eq!(actual.host_private_key_seed, expected.host_private_key_seed);
        assert_eq!(actual.browser_pins, expected.browser_pins);
    }

    #[derive(Default)]
    struct MemoryCredentialBackends {
        file: Mutex<Option<StoredCreds>>,
        keyring: Mutex<Option<StoredCreds>>,
        keyring_writes: AtomicUsize,
        file_writes: AtomicUsize,
    }

    impl MemoryCredentialBackends {
        fn with_record(record: &StoredCreds) -> Self {
            Self {
                file: Mutex::new(Some(record.clone())),
                keyring: Mutex::new(Some(record.clone())),
                ..Self::default()
            }
        }

        fn load(&self, policy: BackendPolicy) -> Result<StoredCreds> {
            let file = self.file.lock().unwrap().clone();
            let keyring = self.keyring.lock().unwrap().clone();
            reconcile_backend_records(file, keyring, policy)
        }

        fn write_keyring(&self, record: &StoredCreds) -> Result<()> {
            *self.keyring.lock().unwrap() = Some(record.clone());
            self.keyring_writes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn write_file(&self, record: &StoredCreds) -> Result<()> {
            *self.file.lock().unwrap() = Some(record.clone());
            self.file_writes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn write_counts(&self) -> (usize, usize) {
            (
                self.keyring_writes.load(Ordering::SeqCst),
                self.file_writes.load(Ordering::SeqCst),
            )
        }

        fn set_split(&self, file: StoredCreds, keyring: StoredCreds) {
            *self.file.lock().unwrap() = Some(file);
            *self.keyring.lock().unwrap() = Some(keyring);
        }
    }

    fn save_to_memory_with_lock(
        lock_path: &Path,
        candidate: &mut StoredCreds,
        expected: &CredentialRevision,
        backends: &MemoryCredentialBackends,
    ) -> Result<()> {
        with_credential_lock_at(lock_path, || {
            save_cas_with_backends(
                candidate,
                expected,
                || backends.load(BackendPolicy::UnixCompleteFile),
                BackendPolicy::UnixCompleteFile,
                |record| backends.write_keyring(record),
                |record| backends.write_file(record),
            )
        })
    }

    /// Build a browser pin carrying a genuinely signed approval proof, plus the
    /// host key that proof is bound to.
    fn proven_browser_pin(index: u8) -> (BrowserPin, String, String) {
        let host_key = SigningKey::from_bytes(&[index.wrapping_add(41); 32]);
        let browser_key = SigningKey::from_bytes(&[index.wrapping_add(97); 32]);
        let host_wire = public_key_to_wire(&host_key.verifying_key());
        let browser_wire = public_key_to_wire(&browser_key.verifying_key());
        let account = "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";
        let nonce = URL_SAFE_NO_PAD.encode([index; 32]);

        let transcript =
            HostPairApprovalTranscript::from_wire(account, &nonce, &host_wire, &browser_wire)
                .expect("valid approval transcript");
        let signature = host_pair_approval::signature_to_wire(
            &host_pair_approval::sign_transcript(&browser_key, &transcript),
        );

        let pin = browser_pin(Uuid::from_u128(u128::from(index) + 1), &browser_wire);
        let proven = attach_browser_approval_proof(pin, account, &nonce, &signature)
            .expect("attaching a valid proof");
        (proven, host_wire, signature)
    }

    /// The account a pin names is re-derived from its proof each time, so it
    /// is only ever claimed for the host key the proof was signed over.
    #[test]
    fn a_proven_pin_names_its_account_and_a_plain_pin_names_none() {
        let (pin, host_wire, _) = proven_browser_pin(5);
        assert_eq!(
            pin.proven_account_id(&host_wire),
            Some("9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f")
        );
        let other_host = public_key_to_wire(&SigningKey::from_bytes(&[7; 32]).verifying_key());
        assert_eq!(pin.proven_account_id(&other_host), None);
        let plain = browser_pin(Uuid::from_u128(99), pin.public_key());
        assert_eq!(plain.proven_account_id(&host_wire), None);
    }

    #[test]
    fn a_retained_proof_reverifies_against_its_host_key() {
        let (pin, host_wire, _) = proven_browser_pin(3);
        assert!(pin.has_approval_proof());
        assert!(pin.verify_approval(&host_wire).expect("verifies"));
    }

    #[test]
    fn a_retained_proof_does_not_verify_against_another_host_key() {
        let (pin, _, _) = proven_browser_pin(4);
        let (_, other_host, _) = proven_browser_pin(5);
        let error = pin.verify_approval(&other_host).unwrap_err();
        assert!(
            format!("{error:#}").contains("approval proof"),
            "unexpected error: {error:#}"
        );
    }

    #[test]
    fn a_pin_without_a_proof_reports_no_verdict_rather_than_failing() {
        let (_, host_wire, _) = proven_browser_pin(6);
        let plain = generated_browser_pin(2);
        assert!(!plain.has_approval_proof());
        assert!(!plain
            .verify_approval(&host_wire)
            .expect("no proof retained"));
    }

    #[test]
    fn a_tampered_retained_proof_fails_validation() {
        let (pin, _, signature) = proven_browser_pin(7);
        let flipped = if signature.starts_with('A') { 'B' } else { 'A' };
        let tampered = BrowserPin {
            approval_proof: Some(BrowserApprovalProof {
                account_id: "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f".to_owned(),
                approval_nonce: URL_SAFE_NO_PAD.encode([7_u8; 32]),
                signature: format!("{flipped}{}", &signature[1..]),
            }),
            ..pin.clone()
        };
        // The shape is still canonical, so this must be caught by verification
        // against the host key, not merely by format validation.
        assert!(validate_browser_pin(&tampered).is_ok());
        let (_, host_wire, _) = proven_browser_pin(7);
        assert!(tampered.verify_approval(&host_wire).is_err());
    }

    #[test]
    fn a_malformed_retained_proof_is_rejected_on_sight() {
        let (pin, _, signature) = proven_browser_pin(8);
        for (account, nonce, sig) in [
            (
                "not-a-uuid",
                URL_SAFE_NO_PAD.encode([8_u8; 32]),
                signature.clone(),
            ),
            (
                "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
                "short".to_owned(),
                signature.clone(),
            ),
            (
                "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
                URL_SAFE_NO_PAD.encode([8_u8; 32]),
                "truncated".to_owned(),
            ),
        ] {
            assert!(
                attach_browser_approval_proof(pin.clone(), account, &nonce, &sig).is_err(),
                "accepted a malformed proof: {account} {nonce} {sig}"
            );
        }
    }

    #[test]
    fn repairing_upgrades_an_unproven_pin_and_never_downgrades_a_proven_one() {
        let (proven, _, _) = proven_browser_pin(9);
        let mut unproven = proven.clone();
        unproven.approval_proof = None;

        // Upgrade: the same device and key, now with evidence behind it.
        let mut creds = StoredCreds::default();
        creds.browser_pins = vec![unproven.clone()];
        assert!(merge_browser_pin(&mut creds, proven.clone()).unwrap());
        assert!(creds.browser_pins[0].has_approval_proof());

        // Downgrade must not happen: a proof already held survives a re-pair
        // against a server that supplies none.
        assert!(!merge_browser_pin(&mut creds, unproven).unwrap());
        assert!(creds.browser_pins[0].has_approval_proof());
    }

    #[test]
    fn reconciling_drops_only_pins_absent_from_the_live_set() {
        let mut creds = StoredCreds::default();
        let first = generated_browser_pin(1);
        let second = generated_browser_pin(2);
        creds.browser_pins = vec![first.clone(), second.clone()];
        creds
            .browser_pins
            .sort_by(|l, r| l.browser_device_id.cmp(&r.browser_device_id));

        // A revoked device disappears from the server's list.
        let live = vec![second.browser_device_id.clone()];
        assert_eq!(retain_live_browser_pins(&mut creds, &live), 1);
        assert_eq!(creds.browser_pins.len(), 1);
        assert_eq!(
            creds.browser_pins[0].browser_device_id,
            second.browser_device_id
        );

        // Reconciling again is a no-op rather than repeatedly rewriting.
        assert_eq!(retain_live_browser_pins(&mut creds, &live), 0);
    }

    #[test]
    fn reconciling_against_an_empty_live_set_drops_every_pin() {
        let mut creds = StoredCreds::default();
        creds.browser_pins = vec![generated_browser_pin(3)];
        // Only reachable when the server actually reported an empty set; the
        // absent-field case never calls this (see the Registered handler).
        assert_eq!(retain_live_browser_pins(&mut creds, &[]), 1);
        assert!(creds.browser_pins.is_empty());
    }

    #[test]
    fn reconciling_never_adds_a_pin_the_server_names() {
        let mut creds = StoredCreds::default();
        let known = generated_browser_pin(4);
        creds.browser_pins = vec![known.clone()];
        let live = vec![
            known.browser_device_id.clone(),
            Uuid::from_u128(999).to_string(),
        ];
        assert_eq!(retain_live_browser_pins(&mut creds, &live), 0);
        // The server naming an unknown device must not create trust for it.
        assert_eq!(creds.browser_pins.len(), 1);
    }

    /// Build a proposal endorsed by `endorser` for a brand-new device key.
    fn proposed_endorsement(
        host: &SigningKey,
        endorser: &SigningKey,
        endorsed: &SigningKey,
        account: &str,
        device_id: &str,
    ) -> ProposedBrowserPin {
        let endorsed_wire = public_key_to_wire(&endorsed.verifying_key());
        let transcript = BrowserEndorsementTranscript::from_wire(
            account,
            &public_key_to_wire(&host.verifying_key()),
            &public_key_to_wire(&endorser.verifying_key()),
            &endorsed_wire,
            device_id,
        )
        .expect("valid endorsement transcript");
        let signature = browser_endorsement::signature_to_wire(
            &browser_endorsement::sign_transcript(endorser, &transcript),
        );
        ProposedBrowserPin {
            device_id: device_id.to_owned(),
            key_algorithm: BROWSER_KEY_ALGORITHM.to_owned(),
            public_key: endorsed_wire.clone(),
            fingerprint: browser_key_fingerprint(&endorsed_wire).unwrap(),
            endorser_public_key: Some(public_key_to_wire(&endorser.verifying_key())),
            endorsement_signature: Some(signature),
        }
    }

    #[test]
    fn an_endorsement_from_a_pinned_browser_is_adoptable() {
        let account = "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";
        let device = "11111111-2222-4333-8444-555555555555";
        let (host, endorser, endorsed) = (
            SigningKey::from_bytes(&[21; 32]),
            SigningKey::from_bytes(&[22; 32]),
            SigningKey::from_bytes(&[23; 32]),
        );
        let proposal = proposed_endorsement(&host, &endorser, &endorsed, account, device);

        let transcript = BrowserEndorsementTranscript::from_wire(
            account,
            &public_key_to_wire(&host.verifying_key()),
            proposal.endorser_public_key.as_deref().unwrap(),
            &proposal.public_key,
            device,
        )
        .unwrap();
        let signature = browser_endorsement::signature_from_wire(
            proposal.endorsement_signature.as_deref().unwrap(),
        )
        .unwrap();

        // Trusted endorser: verifies.
        browser_endorsement::verify_endorsement(
            &transcript,
            &signature,
            &host.verifying_key(),
            &[endorser.verifying_key()],
        )
        .expect("a pinned endorser admits the device");

        // Same proposal, empty trust set: refused. This is what makes the
        // server unable to admit its own browser -- it has no pinned key.
        assert!(browser_endorsement::verify_endorsement(
            &transcript,
            &signature,
            &host.verifying_key(),
            &[],
        )
        .is_err());
    }

    #[test]
    fn a_proposal_without_an_endorsement_is_never_adopted() {
        // The plain shape a hostile server would send: a well-formed pin record
        // with no signature behind it.
        let endorsed = SigningKey::from_bytes(&[24; 32]);
        let wire = public_key_to_wire(&endorsed.verifying_key());
        let proposal = ProposedBrowserPin {
            device_id: "11111111-2222-4333-8444-555555555556".to_owned(),
            key_algorithm: BROWSER_KEY_ALGORITHM.to_owned(),
            public_key: wire.clone(),
            fingerprint: browser_key_fingerprint(&wire).unwrap(),
            endorser_public_key: None,
            endorsement_signature: None,
        };
        assert!(proposal.endorser_public_key.is_none());
        assert!(proposal.endorsement_signature.is_none());
    }

    fn browser_pin(device_id: Uuid, public_key: &str) -> BrowserPin {
        let fingerprint = browser_key_fingerprint(public_key).unwrap();
        browser_pin_from_approval(
            &device_id.to_string(),
            BROWSER_KEY_ALGORITHM,
            public_key,
            &fingerprint,
        )
        .unwrap()
    }

    fn generated_browser_pin(index: u8) -> BrowserPin {
        let signing_key = SigningKey::from_bytes(&[index.saturating_add(1); 32]);
        let public_key = public_key_to_wire(&signing_key.verifying_key());
        browser_pin(Uuid::from_u128(u128::from(index) + 1), &public_key)
    }

    fn bind_pin_domain(creds: &mut StoredCreds, host_id: u128, server_url: &str) {
        creds.host_id = Some(Uuid::from_u128(host_id));
        creds.server_url = Some(server_url.to_owned());
    }

    fn secure_test_credential_dir(path: &Path) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        #[cfg(not(unix))]
        {
            #[cfg(windows)]
            {
                std::fs::remove_dir(path).unwrap();
                crate::platform::create_private_dir_all(path).unwrap();
            }
            #[cfg(not(windows))]
            let _ = path;
        }
    }

    fn encoded_record(record: &StoredCreds) -> String {
        serde_json::to_string(record).unwrap()
    }

    fn read_memory_keyring(
        scope: &KeyringScope,
        file: Option<&StoredCreds>,
        policy: BackendPolicy,
        entries: &RefCell<HashMap<String, String>>,
    ) -> std::result::Result<Option<StoredCreds>, KeyringReadFailure> {
        read_scoped_keyring_record_with(
            scope,
            file,
            policy,
            |user| Ok(entries.borrow().get(user).cloned()),
            |user, record| {
                entries
                    .borrow_mut()
                    .insert(user.to_owned(), encoded_record(record));
                Ok(())
            },
            |user| {
                entries.borrow_mut().remove(user);
                Ok(())
            },
        )
    }

    #[cfg(unix)]
    fn load_with_forced_keyring_error(path: &Path) -> Result<StoredCreds> {
        let from_file = load_file_record_at(path)?;
        let scope = KeyringScope {
            user: format!("{KEYRING_SCOPED_USER_PREFIX}forced-error"),
            migrate_legacy_global: false,
        };
        let keyring_result = read_scoped_keyring_record_with(
            &scope,
            from_file.as_ref(),
            BackendPolicy::UnixCompleteFile,
            |_| Err(anyhow::anyhow!("injected raw keyring read failure")),
            |_, _| Err(anyhow::anyhow!("unexpected keyring write during load")),
            |_| Err(anyhow::anyhow!("unexpected keyring delete during load")),
        );
        resolve_unix_keyring_read_with_warning(from_file, keyring_result, true)
    }

    #[cfg(unix)]
    fn save_with_forced_keyring_error(
        path: &Path,
        candidate: &mut StoredCreds,
        expected: &CredentialRevision,
    ) -> Result<()> {
        save_cas_with_backends(
            candidate,
            expected,
            || load_with_forced_keyring_error(path),
            BackendPolicy::UnixCompleteFile,
            |_| Err(anyhow::anyhow!("injected raw keyring write failure")),
            |record| save_file_at(path, record),
        )
    }

    #[test]
    fn scoped_keyrings_isolate_config_directories_and_logout() {
        let temp = tempfile::tempdir().unwrap();
        let first_dir = temp.path().join("first");
        let second_dir = temp.path().join("second");
        let default_dir = temp.path().join("default");
        for path in [&first_dir, &second_dir, &default_dir] {
            std::fs::create_dir(path).unwrap();
            secure_test_credential_dir(path);
        }
        let first_scope = keyring_scope_at(&first_dir, &default_dir).unwrap();
        let second_scope = keyring_scope_at(&second_dir, &default_dir).unwrap();
        assert_ne!(first_scope.user, second_scope.user);
        assert!(!first_scope.migrate_legacy_global);
        assert!(!second_scope.migrate_legacy_global);

        let mut first = complete_record(1, 1, "first-token", 10, "https://one.example/", 1);
        first.browser_pins = vec![browser_pin(Uuid::from_u128(1), RFC_KEY_ONE)];
        let mut second = complete_record(1, 2, "second-token", 20, "https://two.example/", 2);
        second.browser_pins = vec![browser_pin(Uuid::from_u128(2), RFC_KEY_TWO)];
        let legacy = complete_record(1, 3, "legacy-token", 30, "https://legacy.example/", 3);
        let entries = RefCell::new(HashMap::from([
            (first_scope.user.clone(), encoded_record(&first)),
            (second_scope.user.clone(), encoded_record(&second)),
            (KEYRING_USER.to_owned(), encoded_record(&legacy)),
        ]));

        let loaded_first = read_memory_keyring(
            &first_scope,
            None,
            BackendPolicy::UnixCompleteFile,
            &entries,
        )
        .unwrap()
        .unwrap();
        let loaded_second = read_memory_keyring(
            &second_scope,
            None,
            BackendPolicy::UnixCompleteFile,
            &entries,
        )
        .unwrap()
        .unwrap();
        assert_same_coherent_record(&loaded_first, &first);
        assert_same_coherent_record(&loaded_second, &second);

        delete_keyring_scope_with(&first_scope, |user| {
            entries.borrow_mut().remove(user);
            Ok(())
        })
        .unwrap();
        let remaining = entries.borrow();
        assert!(!remaining.contains_key(&first_scope.user));
        assert!(remaining.contains_key(&second_scope.user));
        assert!(remaining.contains_key(KEYRING_USER));
    }

    #[test]
    fn default_scope_migrates_legacy_once_and_rejects_file_conflicts() {
        let temp = tempfile::tempdir().unwrap();
        let default_dir = temp.path().join("default");
        std::fs::create_dir(&default_dir).unwrap();
        secure_test_credential_dir(&default_dir);
        let scope = keyring_scope_at(&default_dir, &default_dir).unwrap();
        assert!(scope.migrate_legacy_global);

        let current = complete_record(7, 70, "token", 10, "https://server.example/", 7);
        let entries = RefCell::new(HashMap::from([(
            KEYRING_USER.to_owned(),
            encoded_record(&current),
        )]));
        let migrated = read_memory_keyring(
            &scope,
            Some(&current),
            BackendPolicy::UnixCompleteFile,
            &entries,
        )
        .unwrap()
        .unwrap();
        assert_same_coherent_record(&migrated, &current);
        assert!(entries.borrow().contains_key(&scope.user));
        assert!(!entries.borrow().contains_key(KEYRING_USER));

        // Once scoped, a later stale legacy value is never consulted.
        let stale = complete_record(1, 1, "stale", 99, "https://stale.example/", 1);
        entries
            .borrow_mut()
            .insert(KEYRING_USER.to_owned(), encoded_record(&stale));
        let scoped = read_memory_keyring(
            &scope,
            Some(&current),
            BackendPolicy::UnixCompleteFile,
            &entries,
        )
        .unwrap()
        .unwrap();
        assert_same_coherent_record(&scoped, &current);
        assert!(entries.borrow().contains_key(KEYRING_USER));

        entries.borrow_mut().remove(&scope.user);
        let conflict = match read_memory_keyring(
            &scope,
            Some(&current),
            BackendPolicy::UnixCompleteFile,
            &entries,
        ) {
            Err(error) => error,
            Ok(_) => panic!("conflicting legacy global record must not migrate"),
        };
        assert!(!conflict.unavailable);
        assert!(format!("{:#}", conflict.error).contains("conflicts"));
        assert!(!entries.borrow().contains_key(&scope.user));
        assert!(entries.borrow().contains_key(KEYRING_USER));

        delete_keyring_scope_with(&scope, |user| {
            entries.borrow_mut().remove(user);
            Ok(())
        })
        .unwrap();
        assert!(entries.borrow().is_empty());
    }

    #[test]
    fn keyring_scope_uses_canonical_directory_identity() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("real-parent");
        let config_dir = parent.join("config");
        let other_dir = temp.path().join("other");
        std::fs::create_dir(&parent).unwrap();
        std::fs::create_dir(&config_dir).unwrap();
        std::fs::create_dir(&other_dir).unwrap();
        for path in [&config_dir, &other_dir] {
            secure_test_credential_dir(path);
        }
        let direct = keyring_scope_at(&config_dir, &other_dir).unwrap();
        let other = keyring_scope_at(&other_dir, &other_dir).unwrap();
        assert_ne!(direct.user, other.user);

        #[cfg(unix)]
        {
            let parent_alias = temp.path().join("parent-alias");
            std::os::unix::fs::symlink(&parent, &parent_alias).unwrap();
            let aliased = keyring_scope_at(&parent_alias.join("config"), &other_dir).unwrap();
            assert_eq!(aliased.user, direct.user);

            let final_alias = temp.path().join("config-alias");
            std::os::unix::fs::symlink(&config_dir, &final_alias).unwrap();
            let error = keyring_scope_at(&final_alias, &other_dir).unwrap_err();
            assert!(format!("{error:#}").contains("not a real directory"));
        }
    }

    #[test]
    fn browser_pin_approval_is_strict_and_recomputes_fingerprint() {
        let device_id = Uuid::parse_str("11111111-2222-4333-8444-555555555555").unwrap();
        let expected = browser_key_fingerprint(RFC_KEY_ONE).unwrap();
        let pin =
            browser_pin_from_approval(&device_id.to_string(), "ed25519", RFC_KEY_ONE, &expected)
                .unwrap();
        assert_eq!(pin.device_id(), device_id);
        assert_eq!(pin.public_key(), RFC_KEY_ONE);
        assert_eq!(pin.fingerprint(), expected);

        for (id, algorithm, key, fingerprint) in [
            (
                "11111111222243338444555555555555",
                "ed25519",
                RFC_KEY_ONE,
                expected.as_str(),
            ),
            (
                "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
                "ed25519",
                RFC_KEY_ONE,
                expected.as_str(),
            ),
            (
                "11111111-2222-4333-8444-555555555555",
                "Ed25519",
                RFC_KEY_ONE,
                expected.as_str(),
            ),
            (
                "11111111-2222-4333-8444-555555555555",
                "ed25519",
                "short",
                expected.as_str(),
            ),
            (
                "11111111-2222-4333-8444-555555555555",
                "ed25519",
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                expected.as_str(),
            ),
            (
                "11111111-2222-4333-8444-555555555555",
                "ed25519",
                RFC_KEY_ONE,
                "SHA256:wrong",
            ),
        ] {
            assert!(browser_pin_from_approval(id, algorithm, key, fingerprint).is_err());
        }
    }

    #[test]
    fn browser_pin_merge_is_sorted_idempotent_and_conflict_safe() {
        let first_id = Uuid::from_u128(1);
        let second_id = Uuid::from_u128(2);
        let first = browser_pin(first_id, RFC_KEY_ONE);
        let second = browser_pin(second_id, RFC_KEY_TWO);
        let mut creds = fixed_creds();
        assert!(merge_browser_pin(&mut creds, second.clone()).unwrap());
        assert!(merge_browser_pin(&mut creds, first.clone()).unwrap());
        assert_eq!(creds.browser_pins(), &[first.clone(), second.clone()]);
        assert!(!merge_browser_pin(&mut creds, first.clone()).unwrap());
        assert_eq!(creds.browser_pin(first_id), Some(&first));

        let before = creds.browser_pins.clone();
        assert!(merge_browser_pin(&mut creds, browser_pin(first_id, RFC_KEY_TWO)).is_err());
        assert_eq!(creds.browser_pins, before);
        assert!(
            merge_browser_pin(&mut creds, browser_pin(Uuid::from_u128(3), RFC_KEY_ONE)).is_err()
        );
        assert_eq!(creds.browser_pins, before);
    }

    #[test]
    fn browser_pin_capacity_fails_before_mutation() {
        let mut creds = fixed_creds();
        for index in 0..MAX_BROWSER_PINS as u8 {
            assert!(merge_browser_pin(&mut creds, generated_browser_pin(index)).unwrap());
        }
        let before = creds.browser_pins.clone();
        let error = merge_browser_pin(&mut creds, generated_browser_pin(MAX_BROWSER_PINS as u8))
            .expect_err("cap plus one must fail");
        assert!(format!("{error:#}").contains("capacity"));
        assert_eq!(creds.browser_pins, before);

        let persist_called = std::cell::Cell::new(false);
        assert!(commit_login_update(
            &mut creds,
            "new-token".into(),
            Uuid::from_u128(99),
            "https://server.example/".into(),
            generated_browser_pin(MAX_BROWSER_PINS as u8),
            |_, _| {
                persist_called.set(true);
                Ok(())
            },
        )
        .is_err());
        assert!(!persist_called.get());
        assert_eq!(creds.browser_pins, before);
    }

    #[test]
    fn legacy_and_pin_records_load_fail_closed_at_the_schema_boundary() {
        let legacy: StoredCreds = serde_json::from_str(r#"{"access_token":"legacy"}"#).unwrap();
        assert!(legacy.browser_pins().is_empty());
        let partial = format!(
            r#"{{"browser_pins":[{{"browser_device_id":"{}"}}]}}"#,
            Uuid::from_u128(1)
        );
        assert!(serde_json::from_str::<StoredCreds>(&partial).is_err());
        assert!(serde_json::from_str::<StoredCreds>(
            r#"{"access_token":"legacy","browser_pinz":[]}"#
        )
        .is_err());

        let first = browser_pin(Uuid::from_u128(1), RFC_KEY_ONE);
        let second = browser_pin(Uuid::from_u128(2), RFC_KEY_TWO);
        for pins in [
            vec![first.clone(), first.clone()],
            vec![second.clone(), first.clone()],
            vec![first.clone(), browser_pin(Uuid::from_u128(3), RFC_KEY_ONE)],
        ] {
            let mut creds = fixed_creds();
            bind_pin_domain(&mut creds, 10, "https://server.example/");
            creds.browser_pins = pins;
            assert!(validate_loaded_creds(&creds).is_err());
        }
    }

    #[test]
    fn login_update_is_atomic_on_validation_and_save_failure() {
        use std::cell::Cell;

        let old_pin = browser_pin(Uuid::from_u128(1), RFC_KEY_ONE);
        let new_pin = browser_pin(Uuid::from_u128(2), RFC_KEY_TWO);
        let mut creds = fixed_creds();
        creds.access_token = Some("old-token".into());
        bind_pin_domain(&mut creds, 10, "https://new.example/old-path");
        merge_browser_pin(&mut creds, old_pin.clone()).unwrap();

        let persist_called = Cell::new(false);
        let failure = commit_login_update(
            &mut creds,
            "new-token".into(),
            Uuid::from_u128(10),
            "https://new.example/".into(),
            new_pin.clone(),
            |candidate, _| {
                persist_called.set(true);
                assert_eq!(
                    candidate.browser_pins(),
                    &[old_pin.clone(), new_pin.clone()]
                );
                Err(anyhow::anyhow!("injected save failure"))
            },
        );
        assert!(failure.is_err());
        assert!(persist_called.get());
        assert_eq!(creds.access_token.as_deref(), Some("old-token"));
        assert_eq!(creds.host_id, Some(Uuid::from_u128(10)));
        assert_eq!(creds.browser_pins(), std::slice::from_ref(&old_pin));

        let persist_called = Cell::new(false);
        assert!(commit_login_update(
            &mut creds,
            "x".repeat(MAX_ACCESS_TOKEN_BYTES + 1),
            Uuid::from_u128(10),
            "https://new.example/".into(),
            new_pin,
            |_, _| {
                persist_called.set(true);
                Ok(())
            },
        )
        .is_err());
        assert!(!persist_called.get());
        assert_eq!(creds.access_token.as_deref(), Some("old-token"));
        assert_eq!(creds.browser_pins(), std::slice::from_ref(&old_pin));
    }

    #[test]
    fn failed_login_commit_exposes_only_a_wiped_token_buffer() {
        let mut creds = fixed_creds();
        let observed = std::cell::Cell::new(false);
        let error = commit_login_update_observed(
            &mut creds,
            "returned-poll-secret".into(),
            Uuid::from_u128(10),
            "https://new.example/".into(),
            browser_pin(Uuid::from_u128(1), RFC_KEY_ONE),
            |_, _| bail!("injected persistence failure"),
            |wiped| {
                observed.set(true);
                // zeroize's String implementation overwrites its allocation
                // and then clears the visible length.
                assert!(wiped.is_empty());
            },
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("injected persistence failure"));
        assert!(observed.get());
        assert!(creds.access_token.is_none());
    }

    #[test]
    fn unix_partial_backend_orders_select_one_whole_generation_and_retry_converges() {
        use std::cell::RefCell;

        let old = complete_record(1, 1, "old-token", 10, "https://old.example/", 7);

        // Keyring observes N+1 but the required Unix file write fails. The
        // complete file remains the commit point, so the partial keyring
        // attempt cannot roll the durable record forward.
        let mut keyring_first = old.clone();
        keyring_first.access_token = Some("keyring-new-token".into());
        keyring_first.host_id = Some(Uuid::from_u128(20));
        keyring_first.server_url = Some("https://keyring-new.example/".into());
        keyring_first.host_private_key_seed =
            Some(URL_SAFE_NO_PAD.encode([8_u8; ED25519_SEED_BYTES]));
        merge_browser_pin(
            &mut keyring_first,
            browser_pin(Uuid::from_u128(1), RFC_KEY_ONE),
        )
        .unwrap();
        let written_keyring = RefCell::new(None);
        assert!(save_with_backends(
            &mut keyring_first,
            BackendPolicy::UnixCompleteFile,
            |record| {
                *written_keyring.borrow_mut() = Some(record.clone());
                Ok(())
            },
            |_| bail!("injected file failure"),
        )
        .is_err());
        let keyring_new = written_keyring.into_inner().unwrap();
        let loaded = reconcile_backend_records(
            Some(old.clone()),
            Some(keyring_new.clone()),
            BackendPolicy::UnixCompleteFile,
        )
        .unwrap();
        assert_same_coherent_record(&loaded, &old);

        // The inverse partial order is a supported Unix fallback: stale
        // keyring write fails, complete N+1 file succeeds and wins on load.
        let mut file_first = old.clone();
        file_first.access_token = Some("file-new-token".into());
        file_first.host_id = Some(Uuid::from_u128(30));
        file_first.server_url = Some("https://file-new.example/".into());
        file_first.host_private_key_seed = Some(URL_SAFE_NO_PAD.encode([9_u8; ED25519_SEED_BYTES]));
        merge_browser_pin(
            &mut file_first,
            browser_pin(Uuid::from_u128(2), RFC_KEY_TWO),
        )
        .unwrap();
        let written_file = RefCell::new(None);
        save_with_backends(
            &mut file_first,
            BackendPolicy::UnixCompleteFile,
            |_| bail!("injected keyring failure"),
            |record| {
                *written_file.borrow_mut() = Some(record.clone());
                Ok(())
            },
        )
        .unwrap();
        let file_new = written_file.into_inner().unwrap();
        let loaded = reconcile_backend_records(
            Some(file_new.clone()),
            Some(old),
            BackendPolicy::UnixCompleteFile,
        )
        .unwrap();
        assert_same_coherent_record(&loaded, &file_new);

        // A retry starts from the selected complete generation and writes one
        // identical higher commit to both backends.
        let mut retry = loaded;
        let retry_keyring = RefCell::new(None);
        let retry_file = RefCell::new(None);
        save_with_backends(
            &mut retry,
            BackendPolicy::UnixCompleteFile,
            |record| {
                *retry_keyring.borrow_mut() = Some(record.clone());
                Ok(())
            },
            |record| {
                *retry_file.borrow_mut() = Some(record.clone());
                Ok(())
            },
        )
        .unwrap();
        let retry_keyring = retry_keyring.into_inner().unwrap();
        let retry_file = retry_file.into_inner().unwrap();
        assert_same_coherent_record(&retry_keyring, &retry_file);
        let converged = reconcile_backend_records(
            Some(retry_file.clone()),
            Some(retry_keyring),
            BackendPolicy::UnixCompleteFile,
        )
        .unwrap();
        assert_same_coherent_record(&converged, &retry_file);
    }

    #[test]
    fn generation_reconciliation_never_hybrids_servers_hosts_or_concurrent_writers() {
        let older = complete_record(4, 4, "older-token", 40, "https://older.example/", 4);
        let newer = complete_record(5, 1, "newer-token", 50, "https://newer.example/", 5);
        let loaded = reconcile_backend_records(
            Some(older.clone()),
            Some(newer.clone()),
            BackendPolicy::UnixCompleteFile,
        )
        .unwrap();
        assert_same_coherent_record(&loaded, &older);

        // A split write never promotes the redundant keyring copy. The file
        // remains authoritative even when record IDs sort differently.
        let writer_file = complete_record(
            6,
            100,
            "file-writer-token",
            60,
            "https://file-writer.example/",
            6,
        );
        let writer_keyring = complete_record(
            6,
            200,
            "keyring-writer-token",
            70,
            "https://keyring-writer.example/",
            7,
        );
        let first = reconcile_backend_records(
            Some(writer_file.clone()),
            Some(writer_keyring.clone()),
            BackendPolicy::UnixCompleteFile,
        )
        .unwrap();
        let second = reconcile_backend_records(
            Some(writer_file.clone()),
            Some(writer_keyring.clone()),
            BackendPolicy::UnixCompleteFile,
        )
        .unwrap();
        assert_same_coherent_record(&first, &writer_file);
        assert_same_coherent_record(&second, &writer_file);

        let mut corrupt_same_id = writer_keyring.clone();
        corrupt_same_id.server_url = Some("https://corrupt.example/".into());
        assert!(reconcile_backend_records(
            Some(corrupt_same_id),
            Some(writer_keyring),
            BackendPolicy::UnixCompleteFile,
        )
        .is_err());
    }

    #[test]
    fn locked_complete_writers_stale_fail_without_deleting_each_others_pins() {
        let temp = tempfile::tempdir().unwrap();
        secure_test_credential_dir(temp.path());
        let lock_path = temp.path().join(CREDENTIAL_LOCK_FILE);
        let base = complete_record(1, 1, "base-token", 10, "https://server.example/", 1);
        let base_revision = credential_revision(&base).unwrap();
        let backends = MemoryCredentialBackends::with_record(&base);

        let mut first = base.clone();
        merge_browser_pin(&mut first, browser_pin(Uuid::from_u128(1), RFC_KEY_ONE)).unwrap();
        let mut second = base.clone();
        merge_browser_pin(&mut second, browser_pin(Uuid::from_u128(2), RFC_KEY_TWO)).unwrap();

        save_to_memory_with_lock(&lock_path, &mut first, &base_revision, &backends).unwrap();
        let counts_after_first = backends.write_counts();
        let error = save_to_memory_with_lock(&lock_path, &mut second, &base_revision, &backends)
            .unwrap_err();
        assert!(format!("{error:#}").contains("stale"));
        assert_eq!(backends.write_counts(), counts_after_first);
        let winner = backends.load(BackendPolicy::UnixCompleteFile).unwrap();
        assert_same_coherent_record(&winner, &first);
        assert_eq!(winner.browser_pins(), first.browser_pins());
        assert!(winner.browser_pin(Uuid::from_u128(2)).is_none());

        // Reloading the winner creates a valid new base. The retry can merge
        // the second immutable pin and advances exactly one generation.
        let mut retry = winner;
        let retry_base = credential_revision(&retry).unwrap();
        let before_generation = record_order(&retry).unwrap().unwrap().0;
        merge_browser_pin(&mut retry, browser_pin(Uuid::from_u128(2), RFC_KEY_TWO)).unwrap();
        save_to_memory_with_lock(&lock_path, &mut retry, &retry_base, &backends).unwrap();
        assert_eq!(
            record_order(&retry).unwrap().unwrap().0,
            before_generation + 1
        );
        assert_eq!(retry.browser_pins().len(), 2);
        assert_same_coherent_record(
            &backends.load(BackendPolicy::UnixCompleteFile).unwrap(),
            &retry,
        );

        // A delayed generation-N writer remains stale even after N+2 has
        // completed and cannot regress either durable backend.
        let before_delayed = backends.write_counts();
        let error = save_to_memory_with_lock(&lock_path, &mut second, &base_revision, &backends)
            .unwrap_err();
        assert!(format!("{error:#}").contains("stale"));
        assert_eq!(backends.write_counts(), before_delayed);
        assert_same_coherent_record(
            &backends.load(BackendPolicy::UnixCompleteFile).unwrap(),
            &retry,
        );
    }

    #[test]
    fn concurrent_first_host_identity_writers_serialize_and_one_stale_fails() {
        use std::sync::Barrier;

        let temp = tempfile::tempdir().unwrap();
        secure_test_credential_dir(temp.path());
        let lock_path = temp.path().join(CREDENTIAL_LOCK_FILE);
        let base = StoredCreds::default();
        let base_revision = credential_revision(&base).unwrap();
        let backends = Arc::new(MemoryCredentialBackends::with_record(&base));
        let barrier = Arc::new(Barrier::new(3));

        let mut handles = Vec::new();
        for _ in 0..2 {
            let mut candidate = base.clone();
            ensure_host_identity(&mut candidate).unwrap();
            let expected = base_revision.clone();
            let backends = Arc::clone(&backends);
            let barrier = Arc::clone(&barrier);
            let lock_path = lock_path.clone();
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                let result =
                    save_to_memory_with_lock(&lock_path, &mut candidate, &expected, &backends);
                (result, candidate)
            }));
        }
        barrier.wait();
        let outcomes: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(
            outcomes.iter().filter(|(result, _)| result.is_ok()).count(),
            1
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|(result, _)| result.is_err())
                .count(),
            1
        );
        assert_eq!(backends.write_counts(), (1, 1));
        let committed = outcomes
            .iter()
            .find(|(result, _)| result.is_ok())
            .map(|(_, candidate)| candidate)
            .unwrap();
        assert_same_coherent_record(
            &backends.load(BackendPolicy::UnixCompleteFile).unwrap(),
            committed,
        );
    }

    #[test]
    fn file_base_after_partial_keyring_attempt_retries_and_converges() {
        let temp = tempfile::tempdir().unwrap();
        secure_test_credential_dir(temp.path());
        let lock_path = temp.path().join(CREDENTIAL_LOCK_FILE);
        let old = complete_record(1, 1, "old-token", 10, "https://server.example/", 1);
        let old_revision = credential_revision(&old).unwrap();
        let mut partial_winner = old.clone();
        partial_winner.access_token = Some("new-token".into());
        merge_browser_pin(
            &mut partial_winner,
            browser_pin(Uuid::from_u128(1), RFC_KEY_ONE),
        )
        .unwrap();
        advance_credential_generation(&mut partial_winner).unwrap();
        let backends = MemoryCredentialBackends::default();
        backends.set_split(old.clone(), partial_winner.clone());

        let mut stale = old;
        merge_browser_pin(&mut stale, browser_pin(Uuid::from_u128(2), RFC_KEY_TWO)).unwrap();
        save_to_memory_with_lock(&lock_path, &mut stale, &old_revision, &backends).unwrap();
        assert_same_coherent_record(
            &backends.load(BackendPolicy::UnixCompleteFile).unwrap(),
            &stale,
        );

        let mut fresh = backends.load(BackendPolicy::UnixCompleteFile).unwrap();
        let fresh_revision = credential_revision(&fresh).unwrap();
        merge_browser_pin(&mut fresh, browser_pin(Uuid::from_u128(2), RFC_KEY_TWO)).unwrap();
        save_to_memory_with_lock(&lock_path, &mut fresh, &fresh_revision, &backends).unwrap();
        assert_eq!(fresh.browser_pins().len(), 1);
        assert_same_coherent_record(
            &backends.load(BackendPolicy::UnixCompleteFile).unwrap(),
            &fresh,
        );
    }

    #[test]
    fn credential_lock_releases_after_error_and_reacquires() {
        let temp = tempfile::tempdir().unwrap();
        secure_test_credential_dir(temp.path());
        let lock_path = temp.path().join(CREDENTIAL_LOCK_FILE);
        assert!(with_credential_lock_at(&lock_path, || -> Result<()> {
            bail!("injected locked-operation error")
        })
        .is_err());
        assert_eq!(
            with_credential_lock_at(&lock_path, || Ok(42_u8)).unwrap(),
            42
        );

        let mut candidate = complete_record(1, 1, "token", 1, "https://server.example/", 1);
        let expected = credential_revision(&candidate).unwrap();
        let keyring_written = std::cell::Cell::new(false);
        let file_written = std::cell::Cell::new(false);
        assert!(with_credential_lock_at(&lock_path, || {
            save_cas_with_backends(
                &mut candidate,
                &expected,
                || bail!("injected durable reread failure"),
                BackendPolicy::UnixCompleteFile,
                |_| {
                    keyring_written.set(true);
                    Ok(())
                },
                |_| {
                    file_written.set(true);
                    Ok(())
                },
            )
        })
        .is_err());
        assert!(!keyring_written.get());
        assert!(!file_written.get());
        assert_eq!(with_credential_lock_at(&lock_path, || Ok(7_u8)).unwrap(), 7);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&lock_path).unwrap().permissions().mode() & 0o777,
                0o600
            );

            let unsafe_lock = temp.path().join("unsafe.lock");
            std::fs::write(&unsafe_lock, b"").unwrap();
            std::fs::set_permissions(&unsafe_lock, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert!(with_credential_lock_at(&unsafe_lock, || Ok(())).is_err());

            let target = temp.path().join("target.lock");
            std::fs::write(&target, b"").unwrap();
            let symlink = temp.path().join("symlink.lock");
            std::os::unix::fs::symlink(&target, &symlink).unwrap();
            assert!(with_credential_lock_at(&symlink, || Ok(())).is_err());
        }
    }

    #[test]
    fn credential_lock_excludes_a_real_subprocess() {
        let temp = tempfile::tempdir().unwrap();
        secure_test_credential_dir(temp.path());
        let lock_path = temp.path().join(CREDENTIAL_LOCK_FILE);
        let ready_path = temp.path().join("child-ready");
        let acquired_path = temp.path().join("child-acquired");
        let mut child = None;
        with_credential_lock_at(&lock_path, || {
            let spawned = std::process::Command::new(std::env::current_exe().unwrap())
                .arg("--exact")
                .arg("creds::tests::credential_lock_subprocess_helper")
                .env(LOCK_HELPER_PATH_ENV, &lock_path)
                .env(LOCK_HELPER_READY_ENV, &ready_path)
                .env(LOCK_HELPER_ACQUIRED_ENV, &acquired_path)
                .spawn()
                .context("spawning credential lock helper")?;
            child = Some(spawned);
            for _ in 0..100 {
                if ready_path.exists() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            assert!(ready_path.exists());
            assert!(!acquired_path.exists());
            assert!(child.as_mut().unwrap().try_wait().unwrap().is_none());
            Ok(())
        })
        .unwrap();
        let status = child.as_mut().unwrap().wait().unwrap();
        assert!(status.success());
        assert!(acquired_path.exists());
    }

    #[test]
    fn credential_lock_subprocess_helper() {
        let Some(lock_path) = std::env::var_os(LOCK_HELPER_PATH_ENV).map(PathBuf::from) else {
            return;
        };
        let ready_path = PathBuf::from(std::env::var_os(LOCK_HELPER_READY_ENV).unwrap());
        let acquired_path = PathBuf::from(std::env::var_os(LOCK_HELPER_ACQUIRED_ENV).unwrap());
        std::fs::write(ready_path, b"ready").unwrap();
        with_credential_lock_at(&lock_path, || {
            std::fs::write(acquired_path, b"acquired")?;
            Ok(())
        })
        .unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn raw_keyring_failures_preserve_two_login_updates_in_a_real_subprocess() {
        let temp = tempfile::tempdir().unwrap();
        secure_test_credential_dir(temp.path());
        let credentials = temp.path().join("credentials.json");
        let evidence = temp.path().join("passed");
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("creds::tests::raw_keyring_failure_login_subprocess_helper")
            .env(FALLBACK_HELPER_PATH_ENV, &credentials)
            .env(FALLBACK_HELPER_EVIDENCE_ENV, &evidence)
            .status()
            .unwrap();
        assert!(status.success());
        assert_eq!(std::fs::read_to_string(evidence).unwrap(), "two-login-pass");
    }

    #[cfg(unix)]
    #[test]
    fn raw_keyring_failure_login_subprocess_helper() {
        let Some(path) = std::env::var_os(FALLBACK_HELPER_PATH_ENV).map(PathBuf::from) else {
            return;
        };
        let evidence = PathBuf::from(std::env::var_os(FALLBACK_HELPER_EVIDENCE_ENV).unwrap());
        let mut stored = StoredCreds::default();
        let initial_revision = credential_revision(&stored).unwrap();
        ensure_host_identity(&mut stored).unwrap();
        save_with_forced_keyring_error(&path, &mut stored, &initial_revision).unwrap();

        let host_id = Uuid::from_u128(10);
        commit_login_update(
            &mut stored,
            "first-subprocess-token".to_owned(),
            host_id,
            "https://server.example/".to_owned(),
            browser_pin(Uuid::from_u128(1), RFC_KEY_ONE),
            |candidate, expected| save_with_forced_keyring_error(&path, candidate, expected),
        )
        .unwrap();
        let mut reloaded = load_with_forced_keyring_error(&path).unwrap();
        commit_login_update(
            &mut reloaded,
            "second-subprocess-token".to_owned(),
            host_id,
            "https://server.example/same-origin-path".to_owned(),
            browser_pin(Uuid::from_u128(2), RFC_KEY_TWO),
            |candidate, expected| save_with_forced_keyring_error(&path, candidate, expected),
        )
        .unwrap();
        let final_record = load_with_forced_keyring_error(&path).unwrap();
        assert_eq!(
            final_record.browser_pins(),
            &[
                browser_pin(Uuid::from_u128(1), RFC_KEY_ONE),
                browser_pin(Uuid::from_u128(2), RFC_KEY_TWO),
            ]
        );
        assert_eq!(
            final_record.access_token.as_deref(),
            Some("second-subprocess-token")
        );
        assert_eq!(final_record.host_id, Some(host_id));
        std::fs::write(evidence, "two-login-pass").unwrap();
    }

    #[test]
    fn native_keyring_policy_never_uses_a_metadata_projection_as_a_complete_record() {
        use std::cell::{Cell, RefCell};

        let old = complete_record(1, 1, "old-token", 10, "https://old.example/", 1);
        let mut candidate = old.clone();
        candidate.access_token = Some("new-token".into());
        candidate.host_id = Some(Uuid::from_u128(20));
        candidate.server_url = Some("https://new.example/".into());
        let file_called = Cell::new(false);
        assert!(save_with_backends(
            &mut candidate,
            BackendPolicy::NativeKeyring,
            |_| bail!("injected required keyring failure"),
            |_| {
                file_called.set(true);
                Ok(())
            },
        )
        .is_err());
        assert!(!file_called.get());

        // Once the required complete keyring write succeeds, a later metadata
        // projection failure is still reported. The next load uses the whole
        // new keyring generation, never old-file metadata.
        let mut keyring_first = old.clone();
        keyring_first.access_token = Some("keyring-new-token".into());
        keyring_first.host_id = Some(Uuid::from_u128(30));
        keyring_first.server_url = Some("https://keyring-new.example/".into());
        let written_keyring = RefCell::new(None);
        assert!(save_with_backends(
            &mut keyring_first,
            BackendPolicy::NativeKeyring,
            |record| {
                *written_keyring.borrow_mut() = Some(record.clone());
                Ok(())
            },
            |_| bail!("injected metadata file failure"),
        )
        .is_err());
        let keyring_new = written_keyring.into_inner().unwrap();
        let old_projection = file_creds_without_private_seed(&old);
        let loaded = reconcile_backend_records(
            Some(old_projection),
            Some(keyring_new.clone()),
            BackendPolicy::NativeKeyring,
        )
        .unwrap();
        assert_same_coherent_record(&loaded, &keyring_new);

        let mut newer_file = file_creds_without_private_seed(&candidate);
        newer_file.credential_generation = Some(99);
        newer_file.credential_record_id = Some(Uuid::from_u128(99).to_string());
        let loaded = reconcile_backend_records(
            Some(newer_file),
            Some(old.clone()),
            BackendPolicy::NativeKeyring,
        )
        .unwrap();
        assert_same_coherent_record(&loaded, &old);

        let projection = file_creds_without_private_seed(&old);
        let loaded = reconcile_backend_records(
            Some(projection),
            Some(old.clone()),
            BackendPolicy::NativeKeyring,
        )
        .unwrap();
        assert_same_coherent_record(&loaded, &old);
    }

    #[test]
    fn native_projection_recovers_only_truncation_from_complete_keyring() {
        use std::cell::{Cell, RefCell};

        fn parse_error(json: &str) -> anyhow::Error {
            match serde_json::from_str::<StoredCreds>(json) {
                Ok(_) => panic!("fixture must be invalid"),
                Err(error) => error.into(),
            }
        }

        let keyring = complete_record(3, 3, "token", 10, "https://server.example/", 3);
        let written_projection = RefCell::new(None);
        let recovered = reconcile_native_projection(
            Err(parse_error(r#"{"access_token":"truncated"#)),
            Some(keyring.clone()),
            |record| {
                *written_projection.borrow_mut() = Some(file_creds_without_private_seed(record));
                Ok(())
            },
        )
        .unwrap();
        assert_same_coherent_record(&recovered, &keyring);
        let projection = written_projection.into_inner().unwrap();
        assert!(projection.host_private_key_seed.is_none());
        assert_eq!(
            record_order(&projection).unwrap(),
            record_order(&keyring).unwrap()
        );

        let write_called = Cell::new(false);
        let result = reconcile_native_projection(
            Err(parse_error(
                r#"{"access_token":"token","unknown_projection_field":true}"#,
            )),
            Some(keyring),
            |_| {
                write_called.set(true);
                Ok(())
            },
        );
        let error = result.err().expect("unknown projection fields must fail");
        assert!(!write_called.get());
        assert!(format!("{error:#}").contains("strict validation"));
    }

    #[test]
    fn malformed_or_partial_generation_markers_fail_closed() {
        let mut partial = fixed_creds();
        partial.credential_record_version = Some(CREDENTIAL_RECORD_VERSION);
        assert!(validate_loaded_creds(&partial).is_err());

        for (version, generation, record_id) in [
            (Some(2), Some(1), Some(Uuid::from_u128(1).to_string())),
            (
                Some(CREDENTIAL_RECORD_VERSION),
                Some(0),
                Some(Uuid::from_u128(1).to_string()),
            ),
            (
                Some(CREDENTIAL_RECORD_VERSION),
                Some(1),
                Some("NOT-A-CANONICAL-UUID".into()),
            ),
        ] {
            let mut malformed = fixed_creds();
            malformed.credential_record_version = version;
            malformed.credential_generation = generation;
            malformed.credential_record_id = record_id;
            assert!(validate_loaded_creds(&malformed).is_err());
        }

        let mut incomplete_keyring =
            complete_record(1, 1, "token", 1, "https://server.example/", 1);
        incomplete_keyring.host_private_key_seed = None;
        let encoded = serde_json::to_string(&incomplete_keyring).unwrap();
        assert!(decode_keyring_value(&encoded).is_err());
    }

    #[test]
    fn successful_relogin_preserves_existing_pins_and_redacts_status() {
        let first = browser_pin(Uuid::from_u128(1), RFC_KEY_ONE);
        let second = browser_pin(Uuid::from_u128(2), RFC_KEY_TWO);
        let mut creds = fixed_creds();
        creds.access_token = Some("old-secret-token".into());
        bind_pin_domain(&mut creds, 10, "https://server.example:443/old-path");
        merge_browser_pin(&mut creds, first.clone()).unwrap();
        let inserted = commit_login_update(
            &mut creds,
            "new-secret-token".into(),
            Uuid::from_u128(10),
            "https://server.example/".into(),
            second.clone(),
            |_, _| Ok(()),
        )
        .unwrap();
        assert!(inserted);
        assert_eq!(creds.browser_pins(), &[first.clone(), second.clone()]);
        let output = format_status("https://server.example/", &creds).unwrap();
        assert!(output.contains(&first.device_id().to_string()));
        assert!(output.contains(first.fingerprint()));
        assert!(output.contains(&second.device_id().to_string()));
        assert!(output.contains(second.fingerprint()));
        assert!(!output.contains(first.public_key()));
        assert!(!output.contains(second.public_key()));
        assert!(!output.contains("new-secret-token"));
        assert!(!output.contains(creds.host_private_key_seed.as_deref().unwrap()));
        assert_eq!(output.matches("browser pin:").count(), 2);

        let exact_repeat = commit_login_update(
            &mut creds,
            "third-secret-token".into(),
            Uuid::from_u128(10),
            "https://server.example/".into(),
            second,
            |_, _| Ok(()),
        )
        .unwrap();
        assert!(!exact_repeat);
        assert_eq!(creds.browser_pins().len(), 2);
    }

    #[test]
    fn relogin_rejects_pin_domain_changes_before_persistence() {
        use std::cell::Cell;

        let first = browser_pin(Uuid::from_u128(1), RFC_KEY_ONE);
        let second = browser_pin(Uuid::from_u128(2), RFC_KEY_TWO);
        let mut creds = fixed_creds();
        creds.access_token = Some("old-secret-token".into());
        bind_pin_domain(&mut creds, 10, "https://server.example/old-path");
        merge_browser_pin(&mut creds, first.clone()).unwrap();

        for (host_id, server_url) in [
            (11, "https://server.example/new-path"),
            (10, "https://other.example/"),
        ] {
            let persist_called = Cell::new(false);
            let error = commit_login_update(
                &mut creds,
                "new-secret-token".into(),
                Uuid::from_u128(host_id),
                server_url.into(),
                second.clone(),
                |_, _| {
                    persist_called.set(true);
                    Ok(())
                },
            )
            .unwrap_err();
            assert!(!persist_called.get());
            assert!(format!("{error:#}").contains("spawnd logout"));
            assert_eq!(creds.access_token.as_deref(), Some("old-secret-token"));
            assert_eq!(creds.browser_pins(), std::slice::from_ref(&first));
        }
    }

    #[test]
    fn unknown_outer_fields_fail_before_any_credential_write() {
        use std::cell::Cell;

        let unknown = r#"{"access_token":"secret","browser_pinz":[]}"#;
        assert!(decode_keyring_value(unknown).is_err());

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("credentials.json");
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            let mut file = std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&path)
                .unwrap();
            file.write_all(unknown.as_bytes()).unwrap();
        }
        #[cfg(not(unix))]
        std::fs::write(&path, unknown).unwrap();
        assert!(load_file_at(&path).is_err());

        let mut candidate = fixed_creds();
        let expected = credential_revision(&candidate).unwrap();
        let keyring_written = Cell::new(false);
        let file_written = Cell::new(false);
        assert!(save_cas_with_backends(
            &mut candidate,
            &expected,
            || decode_keyring_value(unknown),
            BackendPolicy::UnixCompleteFile,
            |_| {
                keyring_written.set(true);
                Ok(())
            },
            |_| {
                file_written.set(true);
                Ok(())
            },
        )
        .is_err());
        assert!(!keyring_written.get());
        assert!(!file_written.get());
    }

    #[test]
    fn sensitive_field_wipe_is_idempotent() {
        let mut creds = fixed_creds();
        creds.access_token = Some("top-secret-token".into());
        creds.wipe_sensitive_fields();
        creds.wipe_sensitive_fields();
        assert!(creds
            .access_token
            .as_deref()
            .unwrap()
            .bytes()
            .all(|byte| byte == 0));
        assert!(creds
            .host_private_key_seed
            .as_deref()
            .unwrap()
            .bytes()
            .all(|byte| byte == 0));
    }

    #[test]
    fn host_identity_is_stable_and_public_only() {
        let creds = fixed_creds();
        let first = host_identity(&creds).unwrap().unwrap();
        let second = host_identity(&creds).unwrap().unwrap();
        assert_eq!(first, second);
        assert_eq!(first.algorithm, "ed25519");
        assert_eq!(first.public_key.len(), 43);
        assert!(first.fingerprint.starts_with("SHA256:"));
        assert!(!first
            .public_key
            .contains(creds.host_private_key_seed.as_deref().unwrap()));
    }

    #[test]
    fn possession_signature_matches_shared_rust_vector_without_exposing_seed() {
        let seed = [
            0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60, 0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec,
            0x2c, 0xc4, 0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19, 0x70, 0x3b, 0xac, 0x03,
            0x1c, 0xae, 0x7f, 0x60,
        ];
        let mut creds = StoredCreds::default();
        creds.host_private_key_seed = Some(URL_SAFE_NO_PAD.encode(seed));
        let signature = sign_host_pair_possession(
            &creds,
            "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
            "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8",
        )
        .unwrap();
        assert_eq!(
            signature,
            "4Rpu9zkZeKI8F4WLDURpgSjsfktWicSUJEOJb7V837oP9fyyyYRwZMRLxjNG9mADRdf72S-AebxWwrdv1e-ZAQ"
        );
        assert!(!signature.contains(creds.host_private_key_seed.as_deref().unwrap()));
    }

    #[test]
    fn ensure_host_identity_preserves_an_existing_seed() {
        let mut creds = fixed_creds();
        let before = creds.host_private_key_seed.clone();
        let expected = host_identity(&creds).unwrap().unwrap();
        assert_eq!(ensure_host_identity(&mut creds).unwrap(), expected);
        assert_eq!(creds.host_private_key_seed, before);
    }

    #[test]
    fn corrupt_stored_seed_fails_closed_without_rotation() {
        let mut creds = StoredCreds::default();
        creds.host_private_key_seed = Some("not-a-canonical-seed".into());
        let before = creds.host_private_key_seed.clone();
        assert!(ensure_host_identity(&mut creds).is_err());
        assert_eq!(creds.host_private_key_seed, before);
    }

    #[test]
    fn oversized_stored_seed_is_rejected_before_decode() {
        let mut creds = StoredCreds::default();
        creds.host_private_key_seed = Some("A".repeat(MAX_CREDENTIALS_FILE_BYTES));
        let error =
            host_identity(&creds).expect_err("oversized seed must fail before base64 decoding");
        assert!(format!("{error:#}").contains("wrong encoded length"));
    }

    #[test]
    fn corrupt_keyring_bundle_fails_closed() {
        assert!(decode_keyring_value("{not-json").is_err());
    }

    #[test]
    fn malformed_keyring_bundle_is_wiped_without_touching_the_file_record() {
        let fallback = fixed_creds();
        let before = fallback.clone();
        let mut malformed = "{not-json".to_string();

        assert!(decode_keyring_value_and_wipe(&mut malformed).is_err());
        assert!(malformed.bytes().all(|byte| byte == 0));
        assert!(fallback == before);
    }

    #[test]
    fn metadata_file_credentials_never_copy_the_private_seed() {
        let mut creds = fixed_creds();
        creds.access_token = Some("legacy-file-token".into());
        let mut file_creds = file_creds_without_private_seed(&creds);
        assert!(file_creds.host_private_key_seed.is_none());
        assert_eq!(file_creds.access_token, creds.access_token);
        assert_eq!(file_creds.host_id, creds.host_id);
        assert_eq!(file_creds.server_url, creds.server_url);
        zeroize_stored_creds(&mut file_creds);
        assert!(file_creds
            .access_token
            .as_deref()
            .expect("the allocation remains available for inspection")
            .bytes()
            .all(|byte| byte == 0));
    }

    #[test]
    fn credentials_json_does_not_mislabel_private_material_as_public() {
        let creds = fixed_creds();
        let json = serde_json::to_string(&creds).unwrap();
        assert!(json.contains("host_private_key_seed"));
        assert!(!json.contains("host_public_key"));
        assert!(!json.contains("fingerprint"));
    }

    #[test]
    fn file_fallback_round_trip_preserves_identity_and_browser_pins() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("credentials.json");
        let mut original = fixed_creds();
        bind_pin_domain(&mut original, 10, "https://server.example/");
        merge_browser_pin(&mut original, browser_pin(Uuid::from_u128(1), RFC_KEY_ONE)).unwrap();
        advance_credential_generation(&mut original).unwrap();
        let expected = host_identity(&original).unwrap();
        save_file_at(&path, &original).unwrap();
        let restored = load_file_at(&path).unwrap();
        assert_same_coherent_record(&restored, &original);
        assert_eq!(
            restored.host_private_key_seed,
            original.host_private_key_seed
        );
        assert_eq!(host_identity(&restored).unwrap(), expected);
        assert_eq!(restored.browser_pins(), original.browser_pins());

        let mut keyring_json = serde_json::to_string(&original).unwrap();
        let keyring_restored = decode_keyring_value_and_wipe(&mut keyring_json).unwrap();
        assert_same_coherent_record(&keyring_restored, &original);
        assert!(keyring_json.is_empty());
    }

    #[test]
    fn legacy_keyring_bundle_migrates_compatible_pins_and_rejects_conflicts() {
        let first = browser_pin(Uuid::from_u128(1), RFC_KEY_ONE);
        let second = browser_pin(Uuid::from_u128(2), RFC_KEY_TWO);
        let mut fallback = StoredCreds::default();
        bind_pin_domain(&mut fallback, 10, "https://server.example/");
        merge_browser_pin(&mut fallback, first.clone()).unwrap();
        let mut bundle = fixed_creds();
        bundle.access_token = Some("keyring-token".into());
        bind_pin_domain(&mut bundle, 10, "https://server.example/");
        bundle.browser_pins = vec![first.clone(), second.clone()];
        let mut encoded = serde_json::to_string(&bundle).unwrap();
        let keyring = decode_keyring_value_and_wipe(&mut encoded).unwrap();
        let merged =
            reconcile_backend_records(Some(fallback), Some(keyring), BackendPolicy::NativeKeyring)
                .unwrap();
        assert_eq!(merged.access_token.as_deref(), Some("keyring-token"));
        assert_eq!(merged.browser_pins(), &[first.clone(), second]);
        assert!(encoded.bytes().all(|byte| byte == 0));

        let mut conflicting = StoredCreds::default();
        bind_pin_domain(&mut conflicting, 10, "https://server.example/");
        merge_browser_pin(&mut conflicting, first).unwrap();
        let mut bundle = StoredCreds::default();
        bundle.access_token = Some("keyring-token".into());
        bind_pin_domain(&mut bundle, 10, "https://server.example/");
        bundle.browser_pins = vec![browser_pin(Uuid::from_u128(1), RFC_KEY_TWO)];
        assert!(reconcile_backend_records(
            Some(conflicting),
            Some(bundle),
            BackendPolicy::NativeKeyring,
        )
        .is_err());
    }

    #[test]
    fn reset_removes_the_complete_record_containing_browser_pins() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("credentials.json");
        let mut creds = fixed_creds();
        bind_pin_domain(&mut creds, 10, "https://server.example/");
        merge_browser_pin(&mut creds, browser_pin(Uuid::from_u128(1), RFC_KEY_ONE)).unwrap();
        save_file_at(&path, &creds).unwrap();
        let keyring_deleted = std::cell::Cell::new(false);
        let outcome = clear_stored_credentials(
            Ok(path.clone()),
            || {
                keyring_deleted.set(true);
                Ok(())
            },
            |candidate| std::fs::remove_file(candidate),
            |_| Ok(()),
        )
        .unwrap();
        assert!(keyring_deleted.get());
        assert!(outcome.file_removed);
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn file_fallback_is_mode_600() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("credentials.json");
        save_file_at(&path, &fixed_creds()).unwrap();
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[cfg(unix)]
    #[test]
    fn atomic_replace_reports_post_rename_directory_sync_failure() {
        use std::cell::Cell;

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("credentials.json");
        std::fs::write(&path, b"old-secret").unwrap();
        let sync_called = Cell::new(false);
        let error = write_secure_with_parent_sync(&path, b"new-secret", |_| {
            sync_called.set(true);
            Err(std::io::Error::other("injected directory sync failure"))
        })
        .unwrap_err();
        assert!(sync_called.get());
        assert!(error
            .to_string()
            .contains("injected directory sync failure"));
        assert_eq!(std::fs::read(&path).unwrap(), b"new-secret");
        assert!(std::fs::read_dir(temp.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".credentials.")));
    }

    #[cfg(unix)]
    #[test]
    fn stale_temp_cleanup_removes_only_owned_mode_600_uuid_files() {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

        let temp = tempfile::tempdir().unwrap();
        secure_test_credential_dir(temp.path());
        let credentials = temp.path().join("credentials.json");
        let valid = temp
            .path()
            .join(format!(".credentials.{}.tmp", Uuid::from_u128(1)));
        let wrong_mode = temp
            .path()
            .join(format!(".credentials.{}.tmp", Uuid::from_u128(2)));
        let malformed = temp.path().join(".credentials.not-a-uuid.tmp");
        let symlink = temp
            .path()
            .join(format!(".credentials.{}.tmp", Uuid::from_u128(3)));
        for path in [&valid, &wrong_mode, &malformed] {
            let mut file = std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(path)
                .unwrap();
            file.write_all(b"orphan-secret").unwrap();
        }
        std::fs::set_permissions(&wrong_mode, std::fs::Permissions::from_mode(0o644)).unwrap();
        std::os::unix::fs::symlink(&malformed, &symlink).unwrap();

        cleanup_stale_credential_temps(&credentials).unwrap();
        assert!(!valid.exists());
        assert!(wrong_mode.exists());
        assert!(malformed.exists());
        assert!(std::fs::symlink_metadata(symlink)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn reset_reports_directory_sync_failure_after_removal() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("credentials.json");
        std::fs::write(&path, b"secret").unwrap();
        let result = clear_stored_credentials(
            Ok(path.clone()),
            || Ok(()),
            |candidate| std::fs::remove_file(candidate),
            |_| Err(std::io::Error::other("injected directory sync failure")),
        );
        assert!(result.is_err());
        assert!(!path.exists());
        let error = result
            .err()
            .expect("directory sync failure must be reported");
        assert!(format!("{error:#}").contains("directory sync failure"));
    }

    #[test]
    fn reset_attempts_file_removal_but_fails_when_keyring_cannot_be_cleared() {
        use std::cell::Cell;

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("credentials.json");
        std::fs::write(&path, b"secret").unwrap();
        let keyring_attempted = Cell::new(false);
        let file_attempted = Cell::new(false);
        let result = clear_stored_credentials(
            Ok(path.clone()),
            || {
                keyring_attempted.set(true);
                Err(anyhow::anyhow!("injected keyring delete failure"))
            },
            |candidate| {
                file_attempted.set(true);
                std::fs::remove_file(candidate)
            },
            |_| Ok(()),
        );

        assert!(result.is_err());
        assert!(keyring_attempted.get());
        assert!(file_attempted.get());
        assert!(!path.exists());
        let error = result
            .err()
            .expect("injected keyring failure must fail reset");
        assert!(format!("{error:#}").contains("credential reset incomplete"));
    }

    #[test]
    fn reset_attempts_keyring_but_fails_when_file_cannot_be_cleared() {
        use std::cell::Cell;

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("credentials.json");
        let keyring_attempted = Cell::new(false);
        let file_attempted = Cell::new(false);
        let result = clear_stored_credentials(
            Ok(path),
            || {
                keyring_attempted.set(true);
                Ok(())
            },
            |_| {
                file_attempted.set(true);
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected file delete failure",
                ))
            },
            |_| Ok(()),
        );

        assert!(result.is_err());
        assert!(keyring_attempted.get());
        assert!(file_attempted.get());
    }

    #[test]
    fn reset_treats_absent_backends_as_idempotent_success() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("missing.json");
        let result = clear_stored_credentials(
            Ok(path),
            || Ok(()),
            |_| Err(std::io::Error::from(std::io::ErrorKind::NotFound)),
            |_| Ok(()),
        )
        .unwrap();
        assert!(!result.file_removed);
    }

    #[cfg(unix)]
    fn write_test_credentials(path: &Path, bytes: &[u8]) {
        use std::os::unix::fs::OpenOptionsExt;

        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(path)
            .unwrap();
        file.write_all(bytes).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn file_fallback_rejects_group_or_other_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("credentials.json");
        save_file_at(&path, &fixed_creds()).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
        let error = load_file_at(&path)
            .err()
            .expect("insecure permissions must fail closed");
        assert!(format!("{error:#}").contains("group or other permissions"));
    }

    #[cfg(unix)]
    #[test]
    fn file_fallback_rejects_wrong_owner() {
        use std::os::unix::fs::MetadataExt;

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("credentials.json");
        save_file_at(&path, &fixed_creds()).unwrap();
        let metadata = std::fs::metadata(&path).unwrap();
        let wrong_uid = metadata.uid().wrapping_add(1);
        let error = validate_unix_credentials_metadata(&path, &metadata, wrong_uid).unwrap_err();
        assert!(format!("{error:#}").contains("not owned by the current user"));
    }

    #[cfg(unix)]
    #[test]
    fn file_fallback_rejects_symlinks() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target.json");
        let link = temp.path().join("credentials.json");
        save_file_at(&target, &fixed_creds()).unwrap();
        symlink(&target, &link).unwrap();
        assert!(load_file_at(&link).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn file_fallback_rejects_non_regular_files() {
        let temp = tempfile::tempdir().unwrap();
        assert!(load_file_at(temp.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn file_fallback_rejects_oversize_content() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("credentials.json");
        write_test_credentials(&path, &vec![b' '; MAX_CREDENTIALS_FILE_BYTES + 1]);
        let error = load_file_at(&path)
            .err()
            .expect("oversize credentials must fail closed");
        assert!(format!("{error:#}").contains("too large"));
    }

    #[cfg(unix)]
    #[test]
    fn file_fallback_rejects_corrupt_json_and_seed() {
        let temp = tempfile::tempdir().unwrap();
        let corrupt_json = temp.path().join("corrupt.json");
        write_test_credentials(&corrupt_json, b"{not-json");
        assert!(load_file_at(&corrupt_json).is_err());

        let corrupt_seed = temp.path().join("corrupt-seed.json");
        write_test_credentials(
            &corrupt_seed,
            br#"{"host_private_key_seed":"not-a-canonical-seed"}"#,
        );
        let error = load_file_at(&corrupt_seed)
            .err()
            .expect("corrupt seed must fail closed");
        assert!(format!("{error:#}").contains("wrong encoded length"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_complete_file_round_trips_large_records_without_keyring() {
        let temp = tempfile::tempdir().unwrap();
        secure_test_credential_dir(temp.path());
        let path = temp.path().join("credentials.json");
        let mut creds = complete_record(
            7,
            77,
            &"t".repeat(MAX_ACCESS_TOKEN_BYTES),
            10,
            "https://server.example/",
            7,
        );
        merge_browser_pin(&mut creds, browser_pin(Uuid::from_u128(1), RFC_KEY_ONE)).unwrap();
        merge_browser_pin(&mut creds, browser_pin(Uuid::from_u128(2), RFC_KEY_TWO)).unwrap();

        let keyring_called = std::cell::Cell::new(false);
        save_with_backends(
            &mut creds,
            BackendPolicy::WindowsCompleteFile,
            |_| {
                keyring_called.set(true);
                bail!("Credential Manager must not be used")
            },
            |record| save_file_at(&path, record),
        )
        .unwrap();

        assert!(!keyring_called.get());
        assert_eq!(load_file_at(&path).unwrap(), creds);
        assert_eq!(creds.browser_pins().len(), 2);
        crate::platform::open_private_file(&path, false).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_stale_temp_cleanup_removes_only_valid_private_files() {
        let temp = tempfile::tempdir().unwrap();
        secure_test_credential_dir(temp.path());
        let credentials = temp.path().join("credentials.json");
        let valid = temp
            .path()
            .join(format!(".credentials.{}.tmp", Uuid::from_u128(1)));
        let inherited = temp
            .path()
            .join(format!(".credentials.{}.tmp", Uuid::from_u128(2)));
        let malformed = temp.path().join(".credentials.not-a-uuid.tmp");
        crate::platform::create_private_file_new(&valid).unwrap();
        std::fs::write(&inherited, b"inherited").unwrap();
        std::fs::write(&malformed, b"malformed").unwrap();

        cleanup_stale_credential_temps(&credentials).unwrap();
        assert!(!valid.exists());
        assert!(inherited.exists());
        assert!(malformed.exists());
    }

    #[cfg(windows)]
    #[test]
    fn windows_complete_file_rejects_reparse_points_and_oversize_content() {
        let temp = tempfile::tempdir().unwrap();
        secure_test_credential_dir(temp.path());
        let target = temp.path().join("target.json");
        let link = temp.path().join("credentials.json");
        save_file_at(&target, &fixed_creds()).unwrap();
        match std::os::windows::fs::symlink_file(&target, &link) {
            Ok(()) => assert!(load_file_at(&link).is_err()),
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {}
            Err(error) => panic!("creating credential symlink failed unexpectedly: {error}"),
        }

        let oversize = temp.path().join("oversize.json");
        let mut file = crate::platform::create_private_file_new(&oversize).unwrap();
        file.write_all(&vec![b' '; MAX_CREDENTIALS_FILE_BYTES + 1])
            .unwrap();
        file.sync_all().unwrap();
        let error = load_file_at(&oversize)
            .err()
            .expect("oversize Windows credential file must fail");
        assert!(format!("{error:#}").contains("too large"));
    }
}
