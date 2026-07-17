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
use spawnd::host_pair_possession::{
    sign_transcript, signature_to_wire, HostPairPossessionTranscript,
};
use spawnd::signed_signal::{public_key_from_wire, public_key_to_wire};

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
    /// Runtime-only health for the native seed-free metadata projection. The
    /// complete keyring record remains authoritative and this flag is never
    /// persisted or allowed to affect its schema.
    #[serde(skip)]
    native_projection_degraded: bool,
    /// Runtime-only health for Unix's optional redundant keyring copy. The
    /// complete mode-0600 file remains authoritative.
    #[serde(skip)]
    unix_keyring_degraded: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostIdentity {
    pub algorithm: &'static str,
    pub public_key: String,
    pub fingerprint: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BrowserPin {
    browser_device_id: String,
    browser_key_algorithm: String,
    browser_public_key: String,
    browser_key_fingerprint: String,
    /// Absent pins predate reciprocal OOB confirmation and are retained only
    /// as conflict/tombstone-like history until explicitly promoted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    oob_confirmation_version: Option<u8>,
}

impl BrowserPin {
    pub fn device_id(&self) -> Uuid {
        // Construction and credential loading validate this exact field.
        Uuid::parse_str(&self.browser_device_id).expect("validated browser device UUID")
    }

    pub fn key_algorithm(&self) -> &str {
        &self.browser_key_algorithm
    }

    #[allow(dead_code)] // Consumed by the later signed-wire verification hook.
    pub fn public_key(&self) -> &str {
        &self.browser_public_key
    }

    pub fn fingerprint(&self) -> &str {
        &self.browser_key_fingerprint
    }

    pub fn is_oob_confirmed(&self) -> bool {
        self.oob_confirmation_version == Some(1)
    }

    fn with_oob_confirmation(mut self) -> Self {
        self.oob_confirmation_version = Some(1);
        self
    }

    fn same_identity(&self, other: &Self) -> bool {
        self.browser_device_id == other.browser_device_id
            && self.browser_key_algorithm == other.browser_key_algorithm
            && self.browser_public_key == other.browser_public_key
            && self.browser_key_fingerprint == other.browser_key_fingerprint
    }
}

const CREDENTIAL_RECORD_VERSION: u8 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BackendPolicy {
    UnixCompleteFile,
    NativeKeyring,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CredentialSaveOutcome {
    Committed,
    CommittedProjectionDegraded,
    CommittedRedundancyDegraded,
    CommittedDurabilityDegraded,
    CommittedDurabilityAndRedundancyDegraded,
}

impl CredentialSaveOutcome {
    pub fn warning_message(self) -> Option<&'static str> {
        match self {
            Self::Committed => None,
            Self::CommittedProjectionDegraded => Some(
                "credentials committed to the OS keyring, but the local metadata projection is degraded; run `spawnd status` to validate or repair it",
            ),
            Self::CommittedRedundancyDegraded => Some(
                "credentials committed to the complete credential file, but the optional OS-keyring copy is degraded; run `spawnd status` to retry repair",
            ),
            Self::CommittedDurabilityDegraded => Some(
                "credentials were committed, but the credential directory durability sync failed; verify storage health before reboot",
            ),
            Self::CommittedDurabilityAndRedundancyDegraded => Some(
                "credentials are visible in the complete credential file, but its directory durability is uncertain and the optional OS-keyring copy is degraded; verify storage health before reboot, then run `spawnd status` to retry keyring repair",
            ),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CredentialFileWriteOutcome {
    Committed,
    CommittedDirectorySyncDegraded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LoginCommitOutcome {
    pub pin_inserted: bool,
    pub save: CredentialSaveOutcome,
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
        // Storage/status inventory only. Authorization must use the filtered
        // selector below so migrated legacy records cannot become trust.
        &self.browser_pins
    }

    pub fn oob_confirmed_browser_pins(&self) -> impl Iterator<Item = &BrowserPin> {
        self.browser_pins
            .iter()
            .filter(|pin| pin.is_oob_confirmed())
    }

    #[allow(dead_code)] // Consumed by the later signed-wire verification hook.
    pub fn browser_pin(&self, device_id: Uuid) -> Option<&BrowserPin> {
        let canonical = device_id.to_string();
        self.oob_confirmed_browser_pins()
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
        oob_confirmation_version: None,
    })
}

pub fn confirm_browser_pin(pin: BrowserPin) -> BrowserPin {
    pin.with_oob_confirmation()
}

pub fn validate_login_access_token(access_token: &str) -> Result<()> {
    if access_token.is_empty() || access_token.len() > MAX_ACCESS_TOKEN_BYTES {
        bail!("device/poll access token has an invalid length")
    }
    Ok(())
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

pub fn merge_browser_pin(creds: &mut StoredCreds, pin: BrowserPin) -> Result<bool> {
    validate_browser_pins(&creds.browser_pins)?;
    validate_browser_pin(&pin)?;
    for index in 0..creds.browser_pins.len() {
        let existing = &creds.browser_pins[index];
        if existing.browser_device_id == pin.browser_device_id {
            if !existing.same_identity(&pin) {
                bail!("browser device ID is already pinned to a different key")
            }
            if existing.is_oob_confirmed() || !pin.is_oob_confirmed() {
                return Ok(false);
            }
            // The identity tuple remains immutable. This one-way state change
            // only records that the operator independently confirmed it.
            creds.browser_pins[index] = pin;
            return Ok(true);
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

/// Validate whether a returned browser tuple is already authorized in this
/// exact local trust domain. `true` means first-contact OOB confirmation is
/// still required; `false` means the exact device-ID/key pin is already
/// durable. This function never mutates or persists the credential record.
pub fn browser_pin_requires_confirmation(
    current: &StoredCreds,
    host_id: Uuid,
    server_url: &str,
    pin: &BrowserPin,
) -> Result<bool> {
    validate_pin_trust_domain(current, host_id, server_url)?;
    let mut candidate = current.clone();
    let result = merge_browser_pin(&mut candidate, confirm_browser_pin(pin.clone()));
    zeroize_stored_creds(&mut candidate);
    result
}

pub fn commit_login_update<F>(
    current: &mut StoredCreds,
    access_token: String,
    host_id: Uuid,
    server_url: String,
    browser_pin: BrowserPin,
    persist: F,
) -> Result<LoginCommitOutcome>
where
    F: FnOnce(&mut StoredCreds, &CredentialRevision) -> Result<CredentialSaveOutcome>,
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
) -> Result<LoginCommitOutcome>
where
    F: FnOnce(&mut StoredCreds, &CredentialRevision) -> Result<CredentialSaveOutcome>,
    O: FnOnce(&str),
{
    let mut access_token = Zeroizing::new(access_token);
    if !browser_pin.is_oob_confirmed() {
        access_token.zeroize();
        observe_wiped_token(access_token.as_str());
        bail!("login commit refused a browser pin without OOB confirmation version 1")
    }
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
    let save =
        match validate_loaded_creds(&candidate).and_then(|()| persist(&mut candidate, &expected)) {
            Ok(outcome) => outcome,
            Err(error) => {
                zeroize_stored_creds(&mut candidate);
                observe_wiped_token(candidate.access_token.as_deref().unwrap_or(""));
                return Err(error);
            }
        };
    let mut previous = std::mem::replace(current, candidate);
    zeroize_stored_creds(&mut previous);
    Ok(LoginCommitOutcome {
        pin_inserted: inserted,
        save,
    })
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
    #[cfg(not(unix))]
    {
        BackendPolicy::NativeKeyring
    }
}

fn keyring_scope() -> Result<KeyringScope> {
    let configured = config::config_dir()?;
    let default = dirs::config_dir()
        .context("cannot resolve default user config dir")?
        .join("spawn");
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
    if platform_policy() == BackendPolicy::NativeKeyring && !record_is_empty(&from_file) {
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
    mut from_file: Option<StoredCreds>,
    mut from_keyring: Option<StoredCreds>,
    policy: BackendPolicy,
) -> Result<StoredCreds> {
    let file_order = from_file.as_ref().map(record_order).transpose()?.flatten();
    let keyring_order = from_keyring
        .as_ref()
        .map(record_order)
        .transpose()?
        .flatten();

    if policy == BackendPolicy::UnixCompleteFile {
        // The complete mode-0600 file is the sole Unix commit point. An
        // optional keyring record is only a redundant projection and can
        // never select, advance, or merge over an existing file -- even when
        // it carries a higher generation or the file is an empty legacy
        // record. A versioned keyring without any file has no authoritative
        // commit evidence and is rejected; only pre-versioning keyring-only
        // credentials remain eligible for one-time migration on next save.
        return match (from_file.take(), from_keyring.take(), keyring_order) {
            (Some(file), Some(mut keyring), _) => {
                zeroize_stored_creds(&mut keyring);
                Ok(file)
            }
            (Some(file), None, _) => Ok(file),
            (None, None, _) => Ok(StoredCreds::default()),
            (None, Some(mut keyring), Some(_)) => {
                zeroize_stored_creds(&mut keyring);
                bail!("versioned Unix keyring record has no authoritative complete credential file")
            }
            (None, Some(keyring), None) => Ok(keyring),
        };
    }

    match (from_file, from_keyring, file_order, keyring_order) {
        (None, None, _, _) => Ok(StoredCreds::default()),
        (Some(file), None, _, _) => {
            if record_is_empty(&file) {
                Ok(file)
            } else {
                let mut file = file;
                zeroize_stored_creds(&mut file);
                bail!("versioned native credential file has no matching complete keyring record")
            }
        }
        (None, Some(keyring), _, _) => Ok(keyring),
        (Some(file), Some(keyring), None, None) => {
            reconcile_legacy_records(file, keyring, BackendPolicy::NativeKeyring)
        }
        (Some(mut file), Some(mut keyring), Some(_), None) => {
            zeroize_stored_creds(&mut file);
            zeroize_stored_creds(&mut keyring);
            bail!("native keyring is legacy while its metadata file is versioned")
        }
        (Some(mut file), Some(keyring), None, Some(_)) => {
            zeroize_stored_creds(&mut file);
            Ok(keyring)
        }
        (Some(file), Some(keyring), Some(file_order), Some(keyring_order)) => {
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

fn reconcile_legacy_records(
    mut file: StoredCreds,
    mut keyring: StoredCreds,
    policy: BackendPolicy,
) -> Result<StoredCreds> {
    // Current Unix releases wrote a complete fallback even when keyring writes
    // succeeded. Prefer that coherent legacy set rather than allowing a stale
    // keyring token to override it. Older metadata-only/native layouts fill
    // only absent fields and reject every conflicting value.
    if policy == BackendPolicy::UnixCompleteFile
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
                BackendPolicy::UnixCompleteFile => file == legacy_keyring,
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
                BackendPolicy::UnixCompleteFile => {
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

#[cfg(not(unix))]
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
    #[cfg(unix)]
    let from_file = load_file_record()?;
    #[cfg(not(unix))]
    let mut from_file = load_file_record();

    if keyring_disabled() {
        #[cfg(unix)]
        return load_without_keyring(from_file);
        #[cfg(not(unix))]
        return load_without_keyring(from_file?);
    }

    let scope = keyring_scope()?;
    #[cfg(unix)]
    let file_for_migration = from_file.as_ref();
    #[cfg(not(unix))]
    let file_for_migration = from_file.as_ref().ok().and_then(Option::as_ref);
    let keyring_result = read_scoped_keyring_record(&scope, file_for_migration, platform_policy());
    #[cfg(unix)]
    {
        resolve_unix_keyring_read_with_warning(
            from_file,
            keyring_result,
            _warn_unix_keyring_unavailable,
            |record| keyring_set_for_user(&scope.user, record),
        )
    }
    #[cfg(not(unix))]
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
    repair_and_warn: bool,
    repair_keyring: impl FnOnce(&StoredCreds) -> Result<()>,
) -> Result<StoredCreds> {
    match keyring_result {
        Ok(from_keyring) => {
            reconcile_unix_redundancy(from_file, from_keyring, repair_and_warn, repair_keyring)
        }
        Err(failure) if failure.unavailable => {
            if repair_and_warn {
                tracing::warn!(error = %failure.error, "keyring read failed; using the complete Unix credential record");
            }
            let mut selected = from_file.unwrap_or_default();
            if !record_is_empty(&selected) {
                selected.unix_keyring_degraded = true;
            }
            Ok(selected)
        }
        Err(failure) => {
            if let Some(record) = from_file.as_mut() {
                zeroize_stored_creds(record);
            }
            Err(failure.error)
        }
    }
}

#[cfg(any(unix, test))]
fn reconcile_unix_redundancy<F>(
    from_file: Option<StoredCreds>,
    from_keyring: Option<StoredCreds>,
    attempt_repair: bool,
    repair_keyring: F,
) -> Result<StoredCreds>
where
    F: FnOnce(&StoredCreds) -> Result<()>,
{
    let file_is_authoritative = from_file.is_some();
    let repair_needed = match (&from_file, &from_keyring) {
        (Some(file), Some(keyring)) => file != keyring,
        (Some(file), None) => !record_is_empty(file),
        (None, _) => false,
    };
    let mut selected =
        reconcile_backend_records(from_file, from_keyring, BackendPolicy::UnixCompleteFile)?;
    if file_is_authoritative && repair_needed && attempt_repair {
        match repair_keyring(&selected) {
            Ok(()) => selected.unix_keyring_degraded = false,
            Err(error) => {
                selected.unix_keyring_degraded = true;
                tracing::warn!(error = %error, "optional Unix keyring copy remains degraded; the complete credential file is authoritative");
            }
        }
    } else if file_is_authoritative && repair_needed {
        // Live trust reloads are frequent and must not retry a persistently
        // unavailable optional keyring on every bounded refresh. The normal
        // interactive load/status path attempts and reports the repair.
        selected.unix_keyring_degraded = true;
    }
    Ok(selected)
}

#[cfg(any(not(unix), test))]
fn reconcile_native_projection<F>(
    from_file: Result<Option<StoredCreds>>,
    mut from_keyring: Option<StoredCreds>,
    save_projection: F,
) -> Result<StoredCreds>
where
    F: FnOnce(&StoredCreds) -> Result<CredentialFileWriteOutcome>,
{
    match from_file {
        Ok(from_file) => {
            let mut selected = reconcile_backend_records(
                from_file.clone(),
                from_keyring,
                BackendPolicy::NativeKeyring,
            )?;
            let mut expected_projection = file_creds_without_private_seed(&selected);
            let projection_matches = from_file.as_ref() == Some(&expected_projection);
            zeroize_stored_creds(&mut expected_projection);
            if !record_is_empty(&selected) && !projection_matches {
                match save_projection(&selected) {
                    Ok(CredentialFileWriteOutcome::Committed) => {
                        selected.native_projection_degraded = false;
                    }
                    Ok(CredentialFileWriteOutcome::CommittedDirectorySyncDegraded) | Err(_) => {
                        selected.native_projection_degraded = true;
                        tracing::warn!("native credential metadata projection remains degraded; the complete OS-keyring record is authoritative");
                    }
                }
            }
            Ok(selected)
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
            let rebuilt = match save_projection(keyring) {
                Ok(CredentialFileWriteOutcome::Committed) => {
                    keyring.native_projection_degraded = false;
                    true
                }
                Ok(CredentialFileWriteOutcome::CommittedDirectorySyncDegraded) | Err(_) => {
                    keyring.native_projection_degraded = true;
                    tracing::warn!("native credential metadata projection remains degraded; the complete OS-keyring record is authoritative");
                    false
                }
            };
            if rebuilt {
                tracing::warn!(error = %file_error, "rebuilt torn native credential projection from the complete keyring record");
            }
            Ok(from_keyring.expect("validated complete keyring record remains present"))
        }
    }
}

/// Persist one new coherent generation. On Unix the mode-0600 file is the
/// required complete fallback and the keyring is a redundant complete copy.
/// On other platforms the native keyring is required because it is the only
/// copy containing the host private seed; the metadata file is its generation-
/// matched seed-free projection.
pub fn save(
    creds: &mut StoredCreds,
    expected: &CredentialRevision,
) -> Result<CredentialSaveOutcome> {
    let policy = platform_policy();
    with_credential_lock(|| {
        cleanup_stale_credential_temps(config::credentials_path()?.as_path())?;
        save_cas_with_backends(
            creds,
            expected,
            load_unlocked,
            policy,
            |candidate| {
                if keyring_disabled() {
                    if policy == BackendPolicy::UnixCompleteFile {
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
) -> Result<CredentialSaveOutcome>
where
    L: FnOnce() -> Result<StoredCreds>,
    K: FnOnce(&StoredCreds) -> Result<()>,
    F: FnOnce(&StoredCreds) -> Result<CredentialFileWriteOutcome>,
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
    let outcome = match save_with_backends(&mut committed, policy, set_keyring, save_file) {
        Ok(outcome) => outcome,
        Err(error) => {
            zeroize_stored_creds(&mut committed);
            return Err(error);
        }
    };
    let mut previous = std::mem::replace(candidate, committed);
    zeroize_stored_creds(&mut previous);
    Ok(outcome)
}

fn save_with_backends<K, F>(
    creds: &mut StoredCreds,
    policy: BackendPolicy,
    set_keyring: K,
    save_file: F,
) -> Result<CredentialSaveOutcome>
where
    K: FnOnce(&StoredCreds) -> Result<()>,
    F: FnOnce(&StoredCreds) -> Result<CredentialFileWriteOutcome>,
{
    advance_credential_generation(creds)?;
    // Validate the complete coherent record, including both serialized backend
    // bounds, before either backend can observe an update.
    validate_persistable_creds(creds)?;
    validate_complete_current_record(creds)?;
    match policy {
        BackendPolicy::UnixCompleteFile => {
            // The complete file is authoritative on Unix. Do not expose N+1
            // to the optional keyring until the atomic file replacement has
            // crossed its commit point.
            let file_outcome = save_file(creds)?;
            match set_keyring(creds) {
                Ok(()) => {
                    creds.unix_keyring_degraded = false;
                    match file_outcome {
                        CredentialFileWriteOutcome::Committed => {
                            Ok(CredentialSaveOutcome::Committed)
                        }
                        CredentialFileWriteOutcome::CommittedDirectorySyncDegraded => {
                            Ok(CredentialSaveOutcome::CommittedDurabilityDegraded)
                        }
                    }
                }
                Err(error) => {
                    creds.unix_keyring_degraded = true;
                    tracing::warn!(error = %error, "optional Unix keyring update failed after the complete credential file committed");
                    match file_outcome {
                        CredentialFileWriteOutcome::Committed => {
                            Ok(CredentialSaveOutcome::CommittedRedundancyDegraded)
                        }
                        CredentialFileWriteOutcome::CommittedDirectorySyncDegraded => {
                            Ok(CredentialSaveOutcome::CommittedDurabilityAndRedundancyDegraded)
                        }
                    }
                }
            }
        }
        BackendPolicy::NativeKeyring => {
            set_keyring(creds).context("persisting required native-keyring credential record")?;
            match save_file(creds) {
                Ok(CredentialFileWriteOutcome::Committed) => {
                    creds.native_projection_degraded = false;
                    Ok(CredentialSaveOutcome::Committed)
                }
                Ok(CredentialFileWriteOutcome::CommittedDirectorySyncDegraded) | Err(_) => {
                    // The complete keyring write above is the authoritative
                    // commit point. A projection error cannot roll it back or
                    // be returned as a failed credential commit.
                    creds.native_projection_degraded = true;
                    Ok(CredentialSaveOutcome::CommittedProjectionDegraded)
                }
            }
        }
    }
}

#[cfg(unix)]
fn save_file_for_platform(creds: &StoredCreds) -> Result<CredentialFileWriteOutcome> {
    save_file(creds)
}

#[cfg(not(unix))]
fn save_file_for_platform(creds: &StoredCreds) -> Result<CredentialFileWriteOutcome> {
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
        native_projection_degraded: false,
        unix_keyring_degraded: false,
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
    let outcome = with_credential_lock(|| {
        let path = config::credentials_path()?;
        cleanup_stale_credential_temps(&path)?;
        clear_stored_credentials(
            Ok(path),
            keyring_delete,
            |path| std::fs::remove_file(path),
            sync_parent_directory,
        )
    })?;
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

struct ClearOutcome {
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
    std::env::var("SPAWN_DISABLE_KEYRING")
        .ok()
        .map(|value| {
            let value = value.trim().to_ascii_lowercase();
            matches!(value.as_str(), "1" | "true" | "yes" | "on")
        })
        .unwrap_or(false)
}

/// `spawnd status` — print what we know.
pub async fn status(server_cli: Option<String>) -> Result<()> {
    let server = config::server_url(server_cli.clone())?;
    let creds = load().context("loading stored credentials")?;
    print!("{}", format_status(server.as_ref(), &creds)?);
    Ok(())
}

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
            "browser pin:  {} {} {} {}",
            pin.device_id(),
            pin.key_algorithm(),
            pin.fingerprint(),
            if pin.is_oob_confirmed() {
                "oob-confirmed"
            } else {
                "confirmation-required"
            }
        )?;
    }
    if creds.native_projection_degraded {
        writeln!(
            &mut output,
            "warning:     native credential metadata projection is degraded; the complete OS-keyring record remains authoritative and a later status/load will retry repair"
        )?;
    }
    if creds.unix_keyring_degraded {
        writeln!(
            &mut output,
            "warning:     optional OS-keyring copy is degraded; the complete credential file remains authoritative and a later status/load will retry repair"
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

fn keyring_delete() -> Result<()> {
    let scope = keyring_scope()?;
    delete_keyring_scope_with(&scope, keyring_delete_for_user)
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
    #[cfg(unix)]
    if let Err(error) = validate_complete_current_record(&creds) {
        zeroize_stored_creds(&mut creds);
        return Err(error);
    }
    Ok(Some(creds))
}

fn save_file(creds: &StoredCreds) -> Result<CredentialFileWriteOutcome> {
    let path = config::credentials_path()?;
    save_file_at(&path, creds)
}

fn save_file_at(path: &Path, creds: &StoredCreds) -> Result<CredentialFileWriteOutcome> {
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
    host_identity(creds)?;
    validate_browser_pins(&creds.browser_pins)?;
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
    if !matches!(pin.oob_confirmation_version, None | Some(1)) {
        bail!("stored browser pin has an unsupported OOB confirmation version")
    }
    let mut validated = browser_pin_from_approval(
        &pin.browser_device_id,
        &pin.browser_key_algorithm,
        &pin.browser_public_key,
        &pin.browser_key_fingerprint,
    )?;
    validated.oob_confirmation_version = pin.oob_confirmation_version;
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

#[cfg(not(unix))]
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

fn write_secure(path: &Path, data: &[u8]) -> std::io::Result<CredentialFileWriteOutcome> {
    write_secure_with_parent_sync(path, data, sync_parent_directory)
}

fn write_secure_with_parent_sync<S>(
    path: &Path,
    data: &[u8],
    sync_parent: S,
) -> std::io::Result<CredentialFileWriteOutcome>
where
    S: Fn(&Path) -> std::io::Result<()>,
{
    // Write atomically: unique temp file in the same directory, then durable replace.
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let mut tmp = parent.to_path_buf();
    tmp.push(format!(".credentials.{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut f = options.open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        durable_replace(&tmp, path)?;
        match sync_parent(parent) {
            Ok(()) => Ok(CredentialFileWriteOutcome::Committed),
            Err(_) => Ok(CredentialFileWriteOutcome::CommittedDirectorySyncDegraded),
        }
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

#[cfg(not(windows))]
fn durable_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::rename(from, to)
}

#[cfg(windows)]
fn durable_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: both inputs are stable, NUL-terminated UTF-16 buffers for the
    // duration of the call. Flags request atomic replacement and write-through.
    let replaced = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
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
            native_projection_degraded: false,
            unix_keyring_degraded: false,
        }
    }

    fn assert_same_coherent_record(actual: &StoredCreds, expected: &StoredCreds) {
        // Runtime-only backend health is deliberately outside the coherent
        // serialized credential record and is asserted separately where it
        // matters.
        assert_eq!(
            serde_json::to_vec(actual).unwrap(),
            serde_json::to_vec(expected).unwrap()
        );
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
    ) -> Result<CredentialSaveOutcome> {
        with_credential_lock_at(lock_path, || {
            save_cas_with_backends(
                candidate,
                expected,
                || backends.load(BackendPolicy::UnixCompleteFile),
                BackendPolicy::UnixCompleteFile,
                |record| backends.write_keyring(record),
                |record| {
                    backends.write_file(record)?;
                    Ok(CredentialFileWriteOutcome::Committed)
                },
            )
        })
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
        let _ = path;
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
        resolve_unix_keyring_read_with_warning(from_file, keyring_result, true, |_| {
            Err(anyhow::anyhow!(
                "unexpected keyring repair during forced failure"
            ))
        })
    }

    #[cfg(unix)]
    fn save_with_forced_keyring_error(
        path: &Path,
        candidate: &mut StoredCreds,
        expected: &CredentialRevision,
    ) -> Result<CredentialSaveOutcome> {
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
        assert!(creds.browser_pin(first_id).is_none());

        let confirmed_first = confirm_browser_pin(first.clone());
        assert!(merge_browser_pin(&mut creds, confirmed_first.clone()).unwrap());
        assert_eq!(creds.browser_pin(first_id), Some(&confirmed_first));
        assert!(!merge_browser_pin(&mut creds, first.clone()).unwrap());
        assert_eq!(creds.browser_pin(first_id), Some(&confirmed_first));
        assert!(!merge_browser_pin(&mut creds, confirmed_first.clone()).unwrap());

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
            confirm_browser_pin(generated_browser_pin(MAX_BROWSER_PINS as u8)),
            |_, _| {
                persist_called.set(true);
                Ok(CredentialSaveOutcome::Committed)
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
        let legacy_pin = browser_pin(Uuid::from_u128(1), RFC_KEY_ONE);
        let legacy_pin_json = serde_json::to_string(&legacy_pin).unwrap();
        assert!(!legacy_pin_json.contains("oob_confirmation_version"));
        let restored_legacy_pin: BrowserPin = serde_json::from_str(&legacy_pin_json).unwrap();
        assert!(!restored_legacy_pin.is_oob_confirmed());

        let mut future_pin = serde_json::to_value(confirm_browser_pin(legacy_pin)).unwrap();
        future_pin["oob_confirmation_version"] = serde_json::json!(2);
        let future_pin: BrowserPin = serde_json::from_value(future_pin).unwrap();
        assert!(validate_browser_pin(&future_pin).is_err());
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
        let new_pin = confirm_browser_pin(browser_pin(Uuid::from_u128(2), RFC_KEY_TWO));
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
                Ok(CredentialSaveOutcome::Committed)
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
            confirm_browser_pin(browser_pin(Uuid::from_u128(1), RFC_KEY_ONE)),
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
    fn unix_first_save_failure_never_publishes_n_plus_one_to_the_optional_keyring() {
        use std::cell::{Cell, RefCell};

        // No file yet: a legacy keyring-only record may be read for migration,
        // but a failed first authoritative file write must happen before any
        // N+1 keyring update. Restart therefore sees the old legacy record.
        let mut old = fixed_creds();
        old.access_token = Some("old-token".into());
        bind_pin_domain(&mut old, 10, "https://server.example/");
        let old_bytes = serde_json::to_vec(&old).unwrap();
        let file = RefCell::new(None);
        let keyring = RefCell::new(Some(old.clone()));
        let keyring_called = Cell::new(false);
        let file_called = Cell::new(false);
        let mut current = old.clone();
        let error = commit_login_update(
            &mut current,
            "new-token".into(),
            Uuid::from_u128(10),
            "https://server.example/".into(),
            confirm_browser_pin(browser_pin(Uuid::from_u128(1), RFC_KEY_ONE)),
            |candidate, expected| {
                save_cas_with_backends(
                    candidate,
                    expected,
                    || {
                        reconcile_backend_records(
                            file.borrow().clone(),
                            keyring.borrow().clone(),
                            BackendPolicy::UnixCompleteFile,
                        )
                    },
                    BackendPolicy::UnixCompleteFile,
                    |_| {
                        keyring_called.set(true);
                        Ok(())
                    },
                    |_| {
                        file_called.set(true);
                        bail!("injected first authoritative file failure")
                    },
                )
            },
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("authoritative file failure"));
        assert!(file_called.get());
        assert!(!keyring_called.get());
        assert!(file.borrow().is_none());
        assert_eq!(serde_json::to_vec(&current).unwrap(), old_bytes);
        assert_eq!(
            serde_json::to_vec(keyring.borrow().as_ref().unwrap()).unwrap(),
            old_bytes
        );
        let restarted = reconcile_backend_records(
            file.borrow().clone(),
            keyring.borrow().clone(),
            BackendPolicy::UnixCompleteFile,
        )
        .unwrap();
        assert_eq!(serde_json::to_vec(&restarted).unwrap(), old_bytes);
        assert!(record_order(&restarted).unwrap().is_none());
        assert!(restarted.browser_pins().is_empty());

        // An existing empty legacy file is still authoritative. Even a
        // well-formed future keyring generation cannot become the base or win
        // after another failed first file write.
        let empty = StoredCreds::default();
        let future_keyring =
            complete_record(99, 99, "future-token", 99, "https://future.example/", 9);
        let file = RefCell::new(Some(empty.clone()));
        let keyring = RefCell::new(Some(future_keyring.clone()));
        let selected = reconcile_backend_records(
            file.borrow().clone(),
            keyring.borrow().clone(),
            BackendPolicy::UnixCompleteFile,
        )
        .unwrap();
        assert_same_coherent_record(&selected, &empty);
        let expected = credential_revision(&selected).unwrap();
        let mut first_identity = selected;
        ensure_host_identity(&mut first_identity).unwrap();
        let keyring_called = Cell::new(false);
        assert!(save_cas_with_backends(
            &mut first_identity,
            &expected,
            || {
                reconcile_backend_records(
                    file.borrow().clone(),
                    keyring.borrow().clone(),
                    BackendPolicy::UnixCompleteFile,
                )
            },
            BackendPolicy::UnixCompleteFile,
            |_| {
                keyring_called.set(true);
                Ok(())
            },
            |_| bail!("injected empty-file first commit failure"),
        )
        .is_err());
        assert!(!keyring_called.get());
        assert_same_coherent_record(file.borrow().as_ref().unwrap(), &empty);
        assert_same_coherent_record(keyring.borrow().as_ref().unwrap(), &future_keyring);
        let restarted = reconcile_backend_records(
            file.into_inner(),
            keyring.into_inner(),
            BackendPolicy::UnixCompleteFile,
        )
        .unwrap();
        assert_same_coherent_record(&restarted, &empty);
        let repaired_keyring = RefCell::new(Some(future_keyring.clone()));
        let file_snapshot = Some(empty.clone());
        let keyring_snapshot = repaired_keyring.borrow().clone();
        let selected = reconcile_unix_redundancy(file_snapshot, keyring_snapshot, true, |record| {
            *repaired_keyring.borrow_mut() = Some(record.clone());
            Ok(())
        })
        .unwrap();
        assert_same_coherent_record(&selected, &empty);
        assert_same_coherent_record(repaired_keyring.borrow().as_ref().unwrap(), &empty);
        assert!(reconcile_backend_records(
            None,
            Some(future_keyring),
            BackendPolicy::UnixCompleteFile,
        )
        .is_err());
    }

    #[test]
    fn unix_file_commit_survives_keyring_failure_and_reload_repairs_without_downgrade() {
        use std::cell::RefCell;

        let device_id = Uuid::from_u128(1);
        let legacy_pin = browser_pin(device_id, RFC_KEY_ONE);
        let confirmed_pin = confirm_browser_pin(legacy_pin.clone());
        let mut old = complete_record(1, 1, "old-token", 10, "https://server.example/", 1);
        merge_browser_pin(&mut old, legacy_pin).unwrap();
        let file = RefCell::new(Some(old.clone()));
        let keyring = RefCell::new(Some(old.clone()));
        let mut current = old.clone();

        let outcome = commit_login_update(
            &mut current,
            "new-token".into(),
            Uuid::from_u128(10),
            "https://server.example/".into(),
            confirmed_pin.clone(),
            |candidate, expected| {
                save_cas_with_backends(
                    candidate,
                    expected,
                    || {
                        reconcile_backend_records(
                            file.borrow().clone(),
                            keyring.borrow().clone(),
                            BackendPolicy::UnixCompleteFile,
                        )
                    },
                    BackendPolicy::UnixCompleteFile,
                    |_| bail!("injected optional keyring update failure"),
                    |record| {
                        *file.borrow_mut() = Some(record.clone());
                        Ok(CredentialFileWriteOutcome::Committed)
                    },
                )
            },
        )
        .unwrap();
        assert_eq!(
            outcome.save,
            CredentialSaveOutcome::CommittedRedundancyDegraded
        );
        assert!(outcome.pin_inserted);
        assert!(current.unix_keyring_degraded);
        assert_eq!(current.access_token.as_deref(), Some("new-token"));
        assert_eq!(current.browser_pin(device_id), Some(&confirmed_pin));
        assert_eq!(
            serde_json::to_vec(file.borrow().as_ref().unwrap()).unwrap(),
            serde_json::to_vec(&current).unwrap()
        );
        assert_same_coherent_record(keyring.borrow().as_ref().unwrap(), &old);

        let failed_repair = reconcile_unix_redundancy(
            file.borrow().clone(),
            keyring.borrow().clone(),
            true,
            |_| bail!("injected reload repair failure"),
        )
        .unwrap();
        assert!(failed_repair.unix_keyring_degraded);
        assert_eq!(failed_repair.browser_pin(device_id), Some(&confirmed_pin));
        let status = format_status("https://server.example/", &failed_repair).unwrap();
        assert!(status.contains("optional OS-keyring copy is degraded"));
        for secret in [
            "new-token",
            failed_repair.host_private_key_seed.as_deref().unwrap(),
            confirmed_pin.public_key(),
        ] {
            assert!(!status.contains(secret));
            assert!(!outcome.save.warning_message().unwrap().contains(secret));
        }

        let bounded_live_reload = reconcile_unix_redundancy(
            file.borrow().clone(),
            keyring.borrow().clone(),
            false,
            |_| panic!("live reload must not retry optional-keyring repair"),
        )
        .unwrap();
        assert!(bounded_live_reload.unix_keyring_degraded);
        assert_same_coherent_record(&bounded_live_reload, &current);

        let file_snapshot = file.borrow().clone();
        let keyring_snapshot = keyring.borrow().clone();
        let repaired = reconcile_unix_redundancy(file_snapshot, keyring_snapshot, true, |record| {
            *keyring.borrow_mut() = Some(record.clone());
            Ok(())
        })
        .unwrap();
        assert!(!repaired.unix_keyring_degraded);
        assert_same_coherent_record(&repaired, &current);
        assert_same_coherent_record(keyring.borrow().as_ref().unwrap(), &current);

        let mut future =
            complete_record(500, 500, "future-token", 500, "https://future.example/", 5);
        merge_browser_pin(
            &mut future,
            confirm_browser_pin(browser_pin(Uuid::from_u128(2), RFC_KEY_TWO)),
        )
        .unwrap();
        *keyring.borrow_mut() = Some(future);
        let file_snapshot = file.borrow().clone();
        let keyring_snapshot = keyring.borrow().clone();
        let selected = reconcile_unix_redundancy(file_snapshot, keyring_snapshot, true, |record| {
            *keyring.borrow_mut() = Some(record.clone());
            Ok(())
        })
        .unwrap();
        assert_same_coherent_record(&selected, &current);
        assert_eq!(selected.browser_pin(device_id), Some(&confirmed_pin));
        assert_same_coherent_record(keyring.borrow().as_ref().unwrap(), &current);
    }

    #[test]
    fn unix_partial_backend_orders_select_one_whole_generation_and_retry_converges() {
        use std::cell::{Cell, RefCell};

        let old = complete_record(1, 1, "old-token", 10, "https://old.example/", 7);

        // A required Unix file failure happens before the optional keyring can
        // observe N+1. Reload therefore sees only the old complete generation.
        let mut keyring_first = old.clone();
        keyring_first.access_token = Some("keyring-new-token".into());
        keyring_first.host_id = Some(Uuid::from_u128(20));
        keyring_first.server_url = Some("https://keyring-new.example/".into());
        keyring_first.host_private_key_seed =
            Some(URL_SAFE_NO_PAD.encode([8_u8; ED25519_SEED_BYTES]));
        merge_browser_pin(
            &mut keyring_first,
            confirm_browser_pin(browser_pin(Uuid::from_u128(1), RFC_KEY_ONE)),
        )
        .unwrap();
        let keyring_called = Cell::new(false);
        assert!(save_with_backends(
            &mut keyring_first,
            BackendPolicy::UnixCompleteFile,
            |_| {
                keyring_called.set(true);
                Ok(())
            },
            |_| bail!("injected file failure"),
        )
        .is_err());
        assert!(!keyring_called.get());
        let loaded = reconcile_backend_records(
            Some(old.clone()),
            Some(old.clone()),
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
            confirm_browser_pin(browser_pin(Uuid::from_u128(2), RFC_KEY_TWO)),
        )
        .unwrap();
        let written_file = RefCell::new(None);
        let write_order = RefCell::new(Vec::new());
        let outcome = save_with_backends(
            &mut file_first,
            BackendPolicy::UnixCompleteFile,
            |_| {
                write_order.borrow_mut().push("keyring");
                bail!("injected keyring failure")
            },
            |record| {
                write_order.borrow_mut().push("file");
                *written_file.borrow_mut() = Some(record.clone());
                Ok(CredentialFileWriteOutcome::Committed)
            },
        )
        .unwrap();
        assert_eq!(outcome, CredentialSaveOutcome::CommittedRedundancyDegraded);
        assert_eq!(&*write_order.borrow(), &["file", "keyring"]);
        assert!(file_first.unix_keyring_degraded);
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
                Ok(CredentialFileWriteOutcome::Committed)
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
        let mut older = complete_record(4, 4, "older-token", 40, "https://older.example/", 4);
        merge_browser_pin(&mut older, browser_pin(Uuid::from_u128(1), RFC_KEY_ONE)).unwrap();
        merge_browser_pin(
            &mut older,
            confirm_browser_pin(browser_pin(Uuid::from_u128(2), RFC_KEY_TWO)),
        )
        .unwrap();
        let mut newer = complete_record(5, 1, "newer-token", 50, "https://newer.example/", 5);
        merge_browser_pin(
            &mut newer,
            confirm_browser_pin(browser_pin(Uuid::from_u128(1), RFC_KEY_ONE)),
        )
        .unwrap();
        let loaded = reconcile_backend_records(
            Some(older.clone()),
            Some(newer.clone()),
            BackendPolicy::UnixCompleteFile,
        )
        .unwrap();
        assert_same_coherent_record(&loaded, &older);
        assert!(!loaded.browser_pins()[0].is_oob_confirmed());
        assert!(loaded.browser_pins()[1].is_oob_confirmed());

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

        let mut conflicting_keyring = writer_keyring.clone();
        conflicting_keyring.server_url = Some("https://corrupt.example/".into());
        let selected = reconcile_backend_records(
            Some(writer_keyring.clone()),
            Some(conflicting_keyring),
            BackendPolicy::UnixCompleteFile,
        )
        .unwrap();
        assert_same_coherent_record(&selected, &writer_keyring);
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
                    Ok(CredentialFileWriteOutcome::Committed)
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
            confirm_browser_pin(browser_pin(Uuid::from_u128(1), RFC_KEY_ONE)),
            |candidate, expected| save_with_forced_keyring_error(&path, candidate, expected),
        )
        .unwrap();
        let mut reloaded = load_with_forced_keyring_error(&path).unwrap();
        commit_login_update(
            &mut reloaded,
            "second-subprocess-token".to_owned(),
            host_id,
            "https://server.example/same-origin-path".to_owned(),
            confirm_browser_pin(browser_pin(Uuid::from_u128(2), RFC_KEY_TWO)),
            |candidate, expected| save_with_forced_keyring_error(&path, candidate, expected),
        )
        .unwrap();
        let final_record = load_with_forced_keyring_error(&path).unwrap();
        assert_eq!(
            final_record.browser_pins(),
            &[
                confirm_browser_pin(browser_pin(Uuid::from_u128(1), RFC_KEY_ONE)),
                confirm_browser_pin(browser_pin(Uuid::from_u128(2), RFC_KEY_TWO)),
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
    fn native_commit_outcomes_keep_memory_keyring_projection_and_oob_marker_coherent() {
        use std::cell::{Cell, RefCell};

        let device_id = Uuid::from_u128(1);
        let legacy_pin = browser_pin(device_id, RFC_KEY_ONE);
        let confirmed_pin = confirm_browser_pin(legacy_pin.clone());
        let mut old = complete_record(1, 1, "old-token", 10, "https://server.example/", 1);
        merge_browser_pin(&mut old, legacy_pin.clone()).unwrap();
        let old_bytes = serde_json::to_vec(&old).unwrap();

        // A failure before the authoritative keyring write is an actual Err:
        // the projection is not attempted, memory remains byte-equivalent to
        // the legacy record, and a reload selects that same old generation.
        let keyring = RefCell::new(Some(old.clone()));
        let projection = RefCell::new(Some(file_creds_without_private_seed(&old)));
        let projection_called = Cell::new(false);
        let mut current = old.clone();
        let error = commit_login_update(
            &mut current,
            "new-token".into(),
            Uuid::from_u128(10),
            "https://server.example/".into(),
            confirmed_pin.clone(),
            |candidate, expected| {
                save_cas_with_backends(
                    candidate,
                    expected,
                    || {
                        reconcile_backend_records(
                            projection.borrow().clone(),
                            keyring.borrow().clone(),
                            BackendPolicy::NativeKeyring,
                        )
                    },
                    BackendPolicy::NativeKeyring,
                    |_| bail!("injected pre-authoritative keyring failure"),
                    |_| {
                        projection_called.set(true);
                        Ok(CredentialFileWriteOutcome::Committed)
                    },
                )
            },
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("pre-authoritative"));
        assert!(!projection_called.get());
        assert_eq!(serde_json::to_vec(&current).unwrap(), old_bytes);
        assert!(!current.browser_pins()[0].is_oob_confirmed());
        let reloaded_old = reconcile_backend_records(
            projection.borrow().clone(),
            keyring.borrow().clone(),
            BackendPolicy::NativeKeyring,
        )
        .unwrap();
        assert_eq!(serde_json::to_vec(&reloaded_old).unwrap(), old_bytes);

        // Once the complete keyring write succeeds, projection failure is a
        // committed-degraded success. Memory advances to the exact durable
        // generation and the v1 OOB marker; an old projection cannot roll it
        // back or turn the login into a reported failure.
        let outcome = commit_login_update(
            &mut current,
            "new-token".into(),
            Uuid::from_u128(10),
            "https://server.example/".into(),
            confirmed_pin.clone(),
            |candidate, expected| {
                save_cas_with_backends(
                    candidate,
                    expected,
                    || {
                        reconcile_backend_records(
                            projection.borrow().clone(),
                            keyring.borrow().clone(),
                            BackendPolicy::NativeKeyring,
                        )
                    },
                    BackendPolicy::NativeKeyring,
                    |record| {
                        *keyring.borrow_mut() = Some(record.clone());
                        Ok(())
                    },
                    |_| bail!("injected post-keyring projection failure"),
                )
            },
        )
        .unwrap();
        assert!(outcome.pin_inserted);
        assert_eq!(
            outcome.save,
            CredentialSaveOutcome::CommittedProjectionDegraded
        );
        assert!(current.native_projection_degraded);
        assert_eq!(current.access_token.as_deref(), Some("new-token"));
        assert!(current.browser_pins()[0].is_oob_confirmed());
        assert_eq!(current.browser_pin(device_id), Some(&confirmed_pin));
        let durable_keyring = keyring.borrow().clone().unwrap();
        assert_eq!(
            serde_json::to_vec(&durable_keyring).unwrap(),
            serde_json::to_vec(&current).unwrap()
        );
        assert_eq!(
            projection.borrow().as_ref().unwrap().credential_generation,
            old.credential_generation
        );

        let reload_with_failed_repair = reconcile_native_projection(
            Ok(projection.borrow().clone()),
            Some(durable_keyring.clone()),
            |_| bail!("injected projection repair failure"),
        )
        .unwrap();
        assert!(reload_with_failed_repair.native_projection_degraded);
        assert_eq!(
            serde_json::to_vec(&reload_with_failed_repair).unwrap(),
            serde_json::to_vec(&current).unwrap()
        );
        let status = format_status("https://server.example/", &reload_with_failed_repair).unwrap();
        assert!(status.contains("metadata projection is degraded"));
        for secret in [
            "new-token",
            reload_with_failed_repair
                .host_private_key_seed
                .as_deref()
                .unwrap(),
            confirmed_pin.public_key(),
        ] {
            assert!(!status.contains(secret));
            assert!(!outcome.save.warning_message().unwrap().contains(secret));
        }

        // A later load can repair the seed-free projection from the complete
        // keyring. Exact legacy or v1 repeats cannot downgrade or promote the
        // already-v1 marker a second time.
        let repaired_projection = RefCell::new(None);
        let repaired = reconcile_native_projection(
            Ok(projection.borrow().clone()),
            Some(durable_keyring.clone()),
            |record| {
                *repaired_projection.borrow_mut() = Some(file_creds_without_private_seed(record));
                Ok(CredentialFileWriteOutcome::Committed)
            },
        )
        .unwrap();
        assert!(!repaired.native_projection_degraded);
        assert!(repaired.browser_pins()[0].is_oob_confirmed());
        let generation_after_promotion = repaired.credential_generation;
        let mut idempotent = repaired.clone();
        assert!(!merge_browser_pin(&mut idempotent, legacy_pin).unwrap());
        assert!(!merge_browser_pin(&mut idempotent, confirmed_pin).unwrap());
        assert_eq!(idempotent.credential_generation, generation_after_promotion);
        assert!(idempotent.browser_pins()[0].is_oob_confirmed());
        let converged = reconcile_native_projection(
            Ok(repaired_projection.into_inner()),
            Some(durable_keyring),
            |_| panic!("matching repaired projection must not be rewritten"),
        )
        .unwrap();
        assert!(!converged.native_projection_degraded);
        assert!(converged.browser_pins()[0].is_oob_confirmed());
    }

    #[test]
    fn unix_file_commit_outcomes_distinguish_precommit_error_from_postrename_degradation() {
        use std::cell::RefCell;

        let old = complete_record(4, 4, "old-token", 10, "https://server.example/", 4);
        let old_bytes = serde_json::to_vec(&old).unwrap();
        let file = RefCell::new(old.clone());
        let mut candidate = old.clone();
        candidate.access_token = Some("new-token".into());
        let expected = credential_revision(&old).unwrap();

        let error = save_cas_with_backends(
            &mut candidate,
            &expected,
            || Ok(file.borrow().clone()),
            BackendPolicy::UnixCompleteFile,
            |_| Ok(()),
            |_| bail!("injected pre-rename file failure"),
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("pre-rename"));
        assert_eq!(serde_json::to_vec(&candidate).unwrap(), {
            let mut intended = old.clone();
            intended.access_token = Some("new-token".into());
            serde_json::to_vec(&intended).unwrap()
        });
        assert_eq!(serde_json::to_vec(&*file.borrow()).unwrap(), old_bytes);

        let outcome = save_cas_with_backends(
            &mut candidate,
            &expected,
            || Ok(file.borrow().clone()),
            BackendPolicy::UnixCompleteFile,
            |_| Ok(()),
            |record| {
                *file.borrow_mut() = record.clone();
                Ok(CredentialFileWriteOutcome::CommittedDirectorySyncDegraded)
            },
        )
        .unwrap();
        assert_eq!(outcome, CredentialSaveOutcome::CommittedDurabilityDegraded);
        assert_eq!(
            serde_json::to_vec(&candidate).unwrap(),
            serde_json::to_vec(&*file.borrow()).unwrap()
        );
        assert_eq!(candidate.access_token.as_deref(), Some("new-token"));
        assert!(candidate.credential_generation.unwrap() > old.credential_generation.unwrap());
        let warning = outcome.warning_message().unwrap();
        assert!(warning.contains("durability sync failed"));
        assert!(!warning.contains("new-token"));
        assert!(!warning.contains(candidate.host_private_key_seed.as_deref().unwrap()));

        let combined_file = RefCell::new(old.clone());
        let mut combined_candidate = old.clone();
        combined_candidate.access_token = Some("combined-new-token".into());
        let combined = save_cas_with_backends(
            &mut combined_candidate,
            &expected,
            || Ok(combined_file.borrow().clone()),
            BackendPolicy::UnixCompleteFile,
            |_| bail!("injected optional keyring failure after degraded file commit"),
            |record| {
                *combined_file.borrow_mut() = record.clone();
                Ok(CredentialFileWriteOutcome::CommittedDirectorySyncDegraded)
            },
        )
        .unwrap();
        assert_eq!(
            combined,
            CredentialSaveOutcome::CommittedDurabilityAndRedundancyDegraded
        );
        assert!(combined_candidate.unix_keyring_degraded);
        assert_eq!(
            serde_json::to_vec(&combined_candidate).unwrap(),
            serde_json::to_vec(&*combined_file.borrow()).unwrap()
        );
        let warning = combined.warning_message().unwrap();
        assert!(warning.contains("directory durability is uncertain"));
        assert!(warning.contains("optional OS-keyring copy is degraded"));
        assert!(!warning.contains("combined-new-token"));
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
                Ok(CredentialFileWriteOutcome::Committed)
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

        let degraded =
            reconcile_native_projection(Err(parse_error("")), Some(keyring.clone()), |_| {
                bail!("injected torn-projection repair failure")
            })
            .unwrap();
        assert!(degraded.native_projection_degraded);
        assert_same_coherent_record(&degraded, &keyring);
        let status = format_status("https://server.example/", &degraded).unwrap();
        assert!(status.contains("metadata projection is degraded"));
        assert!(!status.contains("token"));
        assert!(!status.contains(degraded.host_private_key_seed.as_deref().unwrap()));

        let write_called = Cell::new(false);
        let result = reconcile_native_projection(
            Err(parse_error(
                r#"{"access_token":"token","unknown_projection_field":true}"#,
            )),
            Some(keyring),
            |_| {
                write_called.set(true);
                Ok(CredentialFileWriteOutcome::Committed)
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
        let second = confirm_browser_pin(browser_pin(Uuid::from_u128(2), RFC_KEY_TWO));
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
            |_, _| Ok(CredentialSaveOutcome::Committed),
        )
        .unwrap();
        assert!(inserted.pin_inserted);
        assert_eq!(inserted.save, CredentialSaveOutcome::Committed);
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
            |_, _| Ok(CredentialSaveOutcome::Committed),
        )
        .unwrap();
        assert!(!exact_repeat.pin_inserted);
        assert_eq!(exact_repeat.save, CredentialSaveOutcome::Committed);
        assert_eq!(creds.browser_pins().len(), 2);
    }

    #[test]
    fn relogin_rejects_pin_domain_changes_before_persistence() {
        use std::cell::Cell;

        let first = browser_pin(Uuid::from_u128(1), RFC_KEY_ONE);
        let second = confirm_browser_pin(browser_pin(Uuid::from_u128(2), RFC_KEY_TWO));
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
                    Ok(CredentialSaveOutcome::Committed)
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
                Ok(CredentialFileWriteOutcome::Committed)
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
        merge_browser_pin(
            &mut original,
            confirm_browser_pin(browser_pin(Uuid::from_u128(2), RFC_KEY_TWO)),
        )
        .unwrap();
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
        assert!(restored.browser_pin(Uuid::from_u128(1)).is_none());
        assert!(restored.browser_pin(Uuid::from_u128(2)).is_some());

        let mut keyring_json = serde_json::to_string(&original).unwrap();
        let keyring_restored = decode_keyring_value_and_wipe(&mut keyring_json).unwrap();
        assert_same_coherent_record(&keyring_restored, &original);
        assert_eq!(keyring_restored.browser_pins(), original.browser_pins());
        assert!(keyring_restored.browser_pin(Uuid::from_u128(1)).is_none());
        assert!(keyring_restored.browser_pin(Uuid::from_u128(2)).is_some());
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
    fn atomic_replace_types_post_rename_directory_sync_failure_as_committed_degraded() {
        use std::cell::Cell;

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("credentials.json");
        std::fs::write(&path, b"old-secret").unwrap();
        let sync_called = Cell::new(false);
        let outcome = write_secure_with_parent_sync(&path, b"new-secret", |_| {
            sync_called.set(true);
            Err(std::io::Error::other("injected directory sync failure"))
        })
        .unwrap();
        assert!(sync_called.get());
        assert_eq!(
            outcome,
            CredentialFileWriteOutcome::CommittedDirectorySyncDegraded
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"new-secret");
        assert!(std::fs::read_dir(temp.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".credentials.")));
    }

    #[cfg(unix)]
    #[test]
    fn atomic_replace_pre_rename_failure_leaves_authoritative_target_unchanged() {
        use std::cell::Cell;

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("credentials.json");
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("old-generation"), b"old-secret").unwrap();
        let sync_called = Cell::new(false);
        assert!(write_secure_with_parent_sync(&path, b"new-secret", |_| {
            sync_called.set(true);
            Ok(())
        })
        .is_err());
        assert!(!sync_called.get());
        assert_eq!(
            std::fs::read(path.join("old-generation")).unwrap(),
            b"old-secret"
        );
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
}
