//! Token storage. We try the OS keyring first; if that fails (common on
//! headless Linux without a Secret Service / dbus session) we fall back to a
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
use spawnd::signed_signal::{public_key_from_wire, public_key_to_wire};

const KEYRING_SERVICE: &str = "spawn";
const KEYRING_USER: &str = "daemon";

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

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BrowserPin {
    browser_device_id: String,
    browser_key_algorithm: String,
    browser_public_key: String,
    browser_key_fingerprint: String,
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
}

const CREDENTIAL_RECORD_VERSION: u8 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BackendPolicy {
    UnixCompleteFile,
    NativeKeyring,
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

    #[allow(dead_code)] // Consumed by the later signed-wire verification hook.
    pub fn browser_pin(&self, device_id: Uuid) -> Option<&BrowserPin> {
        let canonical = device_id.to_string();
        self.browser_pins
            .iter()
            .find(|pin| pin.browser_device_id == canonical)
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
    })
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
    for existing in &creds.browser_pins {
        if existing.browser_device_id == pin.browser_device_id {
            if existing == &pin {
                return Ok(false);
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
            BackendPolicy::UnixCompleteFile => Ok(file),
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
            BackendPolicy::UnixCompleteFile => {
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
        (Some(mut file), Some(keyring), None, Some(_)) => {
            zeroize_stored_creds(&mut file);
            Ok(keyring)
        }
        (Some(file), Some(keyring), Some(file_order), Some(keyring_order)) => match policy {
            BackendPolicy::UnixCompleteFile => {
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
    match file_order.cmp(&keyring_order) {
        std::cmp::Ordering::Greater => {
            zeroize_stored_creds(&mut keyring);
            Ok(file)
        }
        std::cmp::Ordering::Less => {
            zeroize_stored_creds(&mut file);
            Ok(keyring)
        }
        std::cmp::Ordering::Equal if file == keyring => {
            zeroize_stored_creds(&mut keyring);
            Ok(file)
        }
        std::cmp::Ordering::Equal => {
            zeroize_stored_creds(&mut file);
            zeroize_stored_creds(&mut keyring);
            bail!("credential backends disagree within one record identity")
        }
    }
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
    load_unlocked(false)
}

fn load_unlocked(require_all_backends: bool) -> Result<StoredCreds> {
    let mut from_file = load_file_record()?;

    if keyring_disabled() {
        return load_without_keyring(from_file);
    }

    let from_keyring = match keyring_get() {
        Ok(Some(mut value)) => match decode_keyring_value_and_wipe(&mut value) {
            Ok(record) => Some(record),
            Err(error) => {
                if let Some(record) = from_file.as_mut() {
                    zeroize_stored_creds(record);
                }
                return Err(error);
            }
        },
        Ok(None) => None,
        Err(e) => {
            if require_all_backends {
                if let Some(record) = from_file.as_mut() {
                    zeroize_stored_creds(record);
                }
                return Err(e).context("rereading keyring inside credential commit lock");
            }
            #[cfg(unix)]
            {
                tracing::warn!(error = %e, "keyring read failed; using the complete Unix credential record");
                return Ok(from_file.unwrap_or_default());
            }
            #[cfg(not(unix))]
            {
                let mut from_file = from_file.unwrap_or_default();
                zeroize_stored_creds(&mut from_file);
                return Err(e).context("reading required native-keyring credential record");
            }
        }
    };
    reconcile_backend_records(from_file, from_keyring, platform_policy())
}

/// Persist one new coherent generation. On Unix the mode-0600 file is the
/// required complete fallback and the keyring is a redundant complete copy.
/// On other platforms the native keyring is required because it is the only
/// copy containing the host private seed; the metadata file is its generation-
/// matched seed-free projection.
pub fn save(creds: &mut StoredCreds, expected: &CredentialRevision) -> Result<()> {
    let policy = platform_policy();
    with_credential_lock(|| {
        save_cas_with_backends(
            creds,
            expected,
            || load_unlocked(true),
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
    let keyring_result = set_keyring(creds);
    match policy {
        BackendPolicy::UnixCompleteFile => {
            if let Err(error) = keyring_result {
                tracing::warn!(error = %error, "keyring write failed; committing the complete Unix file fallback");
            }
            save_file(creds)
        }
        BackendPolicy::NativeKeyring => {
            keyring_result.context("persisting required native-keyring credential record")?;
            save_file(creds)
        }
    }
}

#[cfg(unix)]
fn save_file_for_platform(creds: &StoredCreds) -> Result<()> {
    save_file(creds)
}

#[cfg(not(unix))]
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

/// Wipe stored creds (file + keyring).
pub async fn logout() -> Result<()> {
    let outcome = with_credential_lock(|| {
        clear_stored_credentials(config::credentials_path(), keyring_delete, |path| {
            std::fs::remove_file(path)
        })
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

fn clear_stored_credentials<K, F>(
    path_result: Result<PathBuf>,
    delete_keyring: K,
    remove_file: F,
) -> Result<ClearOutcome>
where
    K: FnOnce() -> Result<()>,
    F: FnOnce(&Path) -> std::io::Result<()>,
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
                Ok(()) => outcome.file_removed = true,
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

fn keyring_entry() -> Result<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).context("constructing keyring entry")
}

fn keyring_get() -> Result<Option<String>> {
    let entry = keyring_entry()?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
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
        Ok(StoredCreds {
            access_token: Some(value.to_owned()),
            ..StoredCreds::default()
        })
    }
}

fn decode_keyring_value_and_wipe(value: &mut String) -> Result<StoredCreds> {
    let decoded = decode_keyring_value(value);
    value.zeroize();
    decoded
}

fn keyring_set(creds: &StoredCreds) -> Result<()> {
    let entry = keyring_entry()?;
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
    let entry = keyring_entry()?;
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
    host_identity(creds)?;
    validate_browser_pins(&creds.browser_pins)?;
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
    let validated = browser_pin_from_approval(
        &pin.browser_device_id,
        &pin.browser_key_algorithm,
        &pin.browser_public_key,
        &pin.browser_key_fingerprint,
    )?;
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
    if let Some(value) = creds.access_token.as_mut() {
        value.zeroize();
    }
    if let Some(value) = creds.host_private_key_seed.as_mut() {
        value.zeroize();
    }
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

#[cfg(unix)]
fn write_secure(path: &Path, data: &[u8]) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    // Write atomically: unique mode-600 temp file in the same directory, then rename.
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let mut tmp = parent.to_path_buf();
    tmp.push(format!(".credentials.{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(not(unix))]
fn write_secure(path: &Path, data: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    const RFC_KEY_ONE: &str = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
    const RFC_KEY_TWO: &str = "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw";
    const LOCK_HELPER_PATH_ENV: &str = "SPAWN_TEST_CREDENTIAL_LOCK_PATH";
    const LOCK_HELPER_READY_ENV: &str = "SPAWN_TEST_CREDENTIAL_LOCK_READY";
    const LOCK_HELPER_ACQUIRED_ENV: &str = "SPAWN_TEST_CREDENTIAL_LOCK_ACQUIRED";

    fn fixed_creds() -> StoredCreds {
        StoredCreds {
            host_private_key_seed: Some(URL_SAFE_NO_PAD.encode([7_u8; ED25519_SEED_BYTES])),
            ..StoredCreds::default()
        }
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

        let first = browser_pin(Uuid::from_u128(1), RFC_KEY_ONE);
        let second = browser_pin(Uuid::from_u128(2), RFC_KEY_TWO);
        for pins in [
            vec![first.clone(), first.clone()],
            vec![second.clone(), first.clone()],
            vec![first.clone(), browser_pin(Uuid::from_u128(3), RFC_KEY_ONE)],
        ] {
            let creds = StoredCreds {
                browser_pins: pins,
                ..fixed_creds()
            };
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
        creds.host_id = Some(Uuid::from_u128(9));
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
        assert_eq!(creds.host_id, Some(Uuid::from_u128(9)));
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

        // Keyring commits N+1 but the required Unix file write fails. save()
        // reports failure; next load may use the newer keyring record, but it
        // must use that entire record rather than overlaying old file metadata.
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
        assert_same_coherent_record(&loaded, &keyring_new);

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
            Some(older),
            Some(newer.clone()),
            BackendPolicy::UnixCompleteFile,
        )
        .unwrap();
        assert_same_coherent_record(&loaded, &newer);

        // Two writers both derived generation 6 from the same base. Their
        // unique record IDs provide a stable total order across a split write.
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
            Some(writer_file),
            Some(writer_keyring.clone()),
            BackendPolicy::UnixCompleteFile,
        )
        .unwrap();
        assert_same_coherent_record(&first, &writer_keyring);
        assert_same_coherent_record(&second, &writer_keyring);

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
    fn stale_base_after_split_reconciliation_fails_then_fresh_retry_converges() {
        let temp = tempfile::tempdir().unwrap();
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
        let before = backends.write_counts();
        assert!(
            save_to_memory_with_lock(&lock_path, &mut stale, &old_revision, &backends).is_err()
        );
        assert_eq!(backends.write_counts(), before);
        assert_same_coherent_record(
            &backends.load(BackendPolicy::UnixCompleteFile).unwrap(),
            &partial_winner,
        );

        let mut fresh = backends.load(BackendPolicy::UnixCompleteFile).unwrap();
        let fresh_revision = credential_revision(&fresh).unwrap();
        merge_browser_pin(&mut fresh, browser_pin(Uuid::from_u128(2), RFC_KEY_TWO)).unwrap();
        save_to_memory_with_lock(&lock_path, &mut fresh, &fresh_revision, &backends).unwrap();
        assert_eq!(fresh.browser_pins().len(), 2);
        assert_same_coherent_record(
            &backends.load(BackendPolicy::UnixCompleteFile).unwrap(),
            &fresh,
        );
    }

    #[test]
    fn credential_lock_releases_after_error_and_reacquires() {
        let temp = tempfile::tempdir().unwrap();
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
            let malformed = StoredCreds {
                credential_record_version: version,
                credential_generation: generation,
                credential_record_id: record_id,
                ..fixed_creds()
            };
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
    fn ensure_host_identity_preserves_an_existing_seed() {
        let mut creds = fixed_creds();
        let before = creds.host_private_key_seed.clone();
        let expected = host_identity(&creds).unwrap().unwrap();
        assert_eq!(ensure_host_identity(&mut creds).unwrap(), expected);
        assert_eq!(creds.host_private_key_seed, before);
    }

    #[test]
    fn corrupt_stored_seed_fails_closed_without_rotation() {
        let mut creds = StoredCreds {
            host_private_key_seed: Some("not-a-canonical-seed".into()),
            ..StoredCreds::default()
        };
        let before = creds.host_private_key_seed.clone();
        assert!(ensure_host_identity(&mut creds).is_err());
        assert_eq!(creds.host_private_key_seed, before);
    }

    #[test]
    fn oversized_stored_seed_is_rejected_before_decode() {
        let creds = StoredCreds {
            host_private_key_seed: Some("A".repeat(MAX_CREDENTIALS_FILE_BYTES)),
            ..StoredCreds::default()
        };
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
        merge_browser_pin(&mut fallback, first.clone()).unwrap();
        let mut bundle = fixed_creds();
        bundle.access_token = Some("keyring-token".into());
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
        merge_browser_pin(&mut conflicting, first).unwrap();
        let bundle = StoredCreds {
            access_token: Some("keyring-token".into()),
            browser_pins: vec![browser_pin(Uuid::from_u128(1), RFC_KEY_TWO)],
            ..StoredCreds::default()
        };
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
