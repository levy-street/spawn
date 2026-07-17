//! Token storage. We try the OS keyring first; if that fails (common on
//! headless Linux without a Secret Service / dbus session) we fall back to a
//! mode-600 JSON file at `~/.config/spawn/credentials.json`. This fallback is
//! intentionally retained for the already-supported headless Linux mode where
//! no Secret Service is available. The same secret bundle holds the daemon
//! token and Ed25519 private seed; neither is ever sent to logs or status.
//! Metadata in that file also supplies `host_id` and the configured server.

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
use zeroize::Zeroize;

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

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct StoredCreds {
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

#[derive(Serialize, Deserialize)]
struct StoredSecrets {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    access_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    host_private_key_seed: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    browser_pins: Option<Vec<BrowserPin>>,
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
    F: FnOnce(&StoredCreds) -> Result<()>,
{
    let mut candidate = current.clone();
    let inserted = match merge_browser_pin(&mut candidate, browser_pin) {
        Ok(inserted) => inserted,
        Err(error) => {
            zeroize_stored_creds(&mut candidate);
            return Err(error);
        }
    };
    if let Some(previous) = candidate.access_token.as_mut() {
        previous.zeroize();
    }
    candidate.access_token = Some(access_token);
    candidate.host_id = Some(host_id);
    candidate.server_url = Some(server_url);
    if let Err(error) = validate_persistable_creds(&candidate).and_then(|()| persist(&candidate)) {
        zeroize_stored_creds(&mut candidate);
        return Err(error);
    }
    let mut previous = std::mem::replace(current, candidate);
    zeroize_stored_creds(&mut previous);
    Ok(inserted)
}

/// Load stored creds. Tries keyring first for the token; reads the file for
/// metadata regardless. Missing creds returns `Ok(StoredCreds::default())`.
pub fn load() -> Result<StoredCreds> {
    // A malformed file must not silently rotate a host identity.
    let mut from_file = load_file()?;

    if keyring_disabled() {
        return Ok(from_file);
    }

    match keyring_get() {
        Ok(Some(mut value)) => {
            // Backend unavailability may use the documented file fallback,
            // but malformed stored data must fail closed rather than rotate.
            merge_keyring_value(&mut from_file, &mut value)?;
        }
        Ok(None) => {}
        Err(e) => {
            tracing::warn!(error = %e, "keyring read failed; using file-stored token if any");
        }
    }
    if let Err(error) = validate_loaded_creds(&from_file) {
        zeroize_stored_creds(&mut from_file);
        return Err(error);
    }
    Ok(from_file)
}

/// Persist credentials. The existing 0600 headless fallback stores the same
/// token/private-seed bundle that is written to the OS keyring when available.
pub fn save(creds: &StoredCreds) -> Result<()> {
    // Validate the complete coherent record, including both serialized backend
    // bounds, before either backend can observe an update.
    validate_persistable_creds(creds)?;
    let keyring_saved = if keyring_disabled() {
        false
    } else if let Err(e) = keyring_set(creds) {
        tracing::warn!(error = %e, "keyring write failed; using the supported Unix file fallback when available");
        false
    } else {
        true
    };
    #[cfg(not(unix))]
    if creds.host_private_key_seed.is_some() && !keyring_saved {
        bail!("cannot securely persist host identity without the OS keyring")
    }
    save_file_for_platform(creds, keyring_saved)
}

#[cfg(unix)]
fn save_file_for_platform(creds: &StoredCreds, _keyring_saved: bool) -> Result<()> {
    save_file(creds)
}

#[cfg(not(unix))]
fn save_file_for_platform(creds: &StoredCreds, _keyring_saved: bool) -> Result<()> {
    // Non-Unix platforms do not have this module's audited mode-0600 fallback.
    // Keep public metadata and the legacy token fallback, but the private seed
    // is stored only in the native keyring.
    let mut file_creds = file_creds_without_private_seed(creds);
    let result = save_file(&file_creds);
    zeroize_stored_creds(&mut file_creds);
    result
}

#[cfg(any(not(unix), test))]
fn file_creds_without_private_seed(creds: &StoredCreds) -> StoredCreds {
    // Construct this field-by-field: cloning the whole value would transiently
    // copy the private seed before replacing it with None.
    StoredCreds {
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
    let outcome = clear_stored_credentials(config::credentials_path(), keyring_delete, |path| {
        std::fs::remove_file(path)
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

fn decode_keyring_value(value: &str) -> Result<StoredSecrets> {
    if value.len() > MAX_CREDENTIALS_FILE_BYTES {
        bail!("stored keyring credential bundle is too large")
    }
    // Backward compatibility for keyrings containing the legacy raw daemon
    // token. The next save upgrades it to a secret bundle.
    if value.starts_with('{') {
        let mut secrets: StoredSecrets =
            serde_json::from_str(value).context("parsing keyring daemon secret bundle")?;
        if let Err(error) = validate_secret_bounds(
            secrets.access_token.as_deref(),
            secrets.host_private_key_seed.as_deref(),
        ) {
            zeroize_secrets(&mut secrets);
            return Err(error);
        }
        Ok(secrets)
    } else {
        if value.len() > MAX_ACCESS_TOKEN_BYTES {
            bail!("stored keyring access token is too large")
        }
        Ok(StoredSecrets {
            access_token: Some(value.to_owned()),
            host_private_key_seed: None,
            browser_pins: None,
        })
    }
}

fn merge_keyring_value(from_file: &mut StoredCreds, value: &mut String) -> Result<()> {
    let decoded = decode_keyring_value(value);
    value.zeroize();
    let mut secrets = match decoded {
        Ok(secrets) => secrets,
        Err(error) => {
            // `from_file` may already contain a fallback token and private seed.
            // A malformed keyring entry must fail closed without dropping those
            // loaded secret buffers unwiped on this early return.
            zeroize_stored_creds(from_file);
            return Err(error);
        }
    };
    if let Some(access_token) = secrets.access_token.take() {
        if let Some(previous) = from_file.access_token.as_mut() {
            previous.zeroize();
        }
        from_file.access_token = Some(access_token);
    }
    if let Some(seed) = secrets.host_private_key_seed.take() {
        if let Some(previous) = from_file.host_private_key_seed.as_mut() {
            previous.zeroize();
        }
        from_file.host_private_key_seed = Some(seed);
    }
    if let Some(pins) = secrets.browser_pins.take() {
        if let Err(error) = validate_browser_pins(&pins) {
            zeroize_secrets(&mut secrets);
            zeroize_stored_creds(from_file);
            return Err(error);
        }
        // A process interruption or temporarily unavailable backend may leave
        // one protected copy one successful login behind the other. Merge only
        // exact compatible records; ID/key conflicts still fail closed.
        for pin in pins {
            if let Err(error) = merge_browser_pin(from_file, pin) {
                zeroize_secrets(&mut secrets);
                zeroize_stored_creds(from_file);
                return Err(error).context("merging keyring browser pins");
            }
        }
    }
    zeroize_secrets(&mut secrets);
    Ok(())
}

fn keyring_set(creds: &StoredCreds) -> Result<()> {
    let entry = keyring_entry()?;
    let mut bundle = StoredSecrets {
        access_token: creds.access_token.clone(),
        host_private_key_seed: creds.host_private_key_seed.clone(),
        browser_pins: Some(creds.browser_pins.clone()),
    };
    let mut encoded = match serde_json::to_string(&bundle) {
        Ok(encoded) => encoded,
        Err(error) => {
            zeroize_secrets(&mut bundle);
            return Err(error.into());
        }
    };
    if encoded.len() > MAX_CREDENTIALS_FILE_BYTES {
        encoded.zeroize();
        zeroize_secrets(&mut bundle);
        bail!("keyring credential bundle is too large")
    }
    let result = entry.set_password(&encoded);
    encoded.zeroize();
    zeroize_secrets(&mut bundle);
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

fn load_file() -> Result<StoredCreds> {
    let path = config::credentials_path()?;
    load_file_at(&path)
}

fn load_file_at(path: &Path) -> Result<StoredCreds> {
    let Some(mut raw) = read_credentials_file(path)? else {
        return Ok(StoredCreds::default());
    };
    let parsed = serde_json::from_slice(&raw);
    raw.zeroize();
    let mut creds: StoredCreds = parsed.with_context(|| format!("parsing {}", path.display()))?;
    if let Err(error) = validate_loaded_creds(&creds) {
        zeroize_stored_creds(&mut creds);
        return Err(error);
    }
    Ok(creds)
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

fn validate_persistable_creds(creds: &StoredCreds) -> Result<()> {
    validate_loaded_creds(creds)?;
    let mut file_json = serde_json::to_vec_pretty(creds)?;
    let file_len = file_json.len();
    file_json.zeroize();
    if file_len > MAX_CREDENTIALS_FILE_BYTES {
        bail!("credential record is too large")
    }
    let mut bundle = StoredSecrets {
        access_token: creds.access_token.clone(),
        host_private_key_seed: creds.host_private_key_seed.clone(),
        browser_pins: Some(creds.browser_pins.clone()),
    };
    let mut keyring_json = match serde_json::to_string(&bundle) {
        Ok(json) => json,
        Err(error) => {
            zeroize_secrets(&mut bundle);
            return Err(error.into());
        }
    };
    let keyring_len = keyring_json.len();
    keyring_json.zeroize();
    zeroize_secrets(&mut bundle);
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

fn zeroize_secrets(secrets: &mut StoredSecrets) {
    if let Some(value) = secrets.access_token.as_mut() {
        value.zeroize();
    }
    if let Some(value) = secrets.host_private_key_seed.as_mut() {
        value.zeroize();
    }
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

    const RFC_KEY_ONE: &str = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
    const RFC_KEY_TWO: &str = "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw";

    fn fixed_creds() -> StoredCreds {
        StoredCreds {
            host_private_key_seed: Some(URL_SAFE_NO_PAD.encode([7_u8; ED25519_SEED_BYTES])),
            ..StoredCreds::default()
        }
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
            |_| {
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
            |candidate| {
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
            |_| {
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
            |_| Ok(()),
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
            |_| Ok(()),
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
    fn malformed_keyring_bundle_wipes_loaded_fallback_secrets() {
        let mut fallback = fixed_creds();
        fallback.access_token = Some("fallback-access-token".into());
        let mut malformed = "{not-json".to_string();

        assert!(merge_keyring_value(&mut fallback, &mut malformed).is_err());
        assert!(malformed.bytes().all(|byte| byte == 0));
        assert!(fallback
            .access_token
            .as_deref()
            .expect("the allocation remains available for inspection")
            .bytes()
            .all(|byte| byte == 0));
        assert!(fallback
            .host_private_key_seed
            .as_deref()
            .expect("the allocation remains available for inspection")
            .bytes()
            .all(|byte| byte == 0));
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
        let expected = host_identity(&original).unwrap();
        save_file_at(&path, &original).unwrap();
        let restored = load_file_at(&path).unwrap();
        assert_eq!(
            restored.host_private_key_seed,
            original.host_private_key_seed
        );
        assert_eq!(host_identity(&restored).unwrap(), expected);
        assert_eq!(restored.browser_pins(), original.browser_pins());
    }

    #[test]
    fn keyring_bundle_merges_compatible_pins_and_rejects_conflicts() {
        let first = browser_pin(Uuid::from_u128(1), RFC_KEY_ONE);
        let second = browser_pin(Uuid::from_u128(2), RFC_KEY_TWO);
        let mut fallback = fixed_creds();
        merge_browser_pin(&mut fallback, first.clone()).unwrap();
        let bundle = StoredSecrets {
            access_token: Some("keyring-token".into()),
            host_private_key_seed: None,
            browser_pins: Some(vec![first.clone(), second.clone()]),
        };
        let mut encoded = serde_json::to_string(&bundle).unwrap();
        merge_keyring_value(&mut fallback, &mut encoded).unwrap();
        assert_eq!(fallback.access_token.as_deref(), Some("keyring-token"));
        assert_eq!(fallback.browser_pins(), &[first.clone(), second]);
        assert!(encoded.bytes().all(|byte| byte == 0));

        let mut conflicting = fixed_creds();
        merge_browser_pin(&mut conflicting, first.clone()).unwrap();
        let bundle = StoredSecrets {
            access_token: None,
            host_private_key_seed: None,
            browser_pins: Some(vec![browser_pin(Uuid::from_u128(1), RFC_KEY_TWO)]),
        };
        let mut encoded = serde_json::to_string(&bundle).unwrap();
        assert!(merge_keyring_value(&mut conflicting, &mut encoded).is_err());
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
