//! Token storage. We try the OS keyring first; if that fails (common on
//! headless Linux without a Secret Service / dbus session) we fall back to a
//! mode-600 JSON file at `~/.config/spawn/credentials.json`. This fallback is
//! intentionally retained for the already-supported headless Linux mode where
//! no Secret Service is available. The same secret bundle holds the daemon
//! token and Ed25519 private seed; neither is ever sent to logs or status.
//! Metadata in that file also supplies `host_id` and the configured server.

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

const KEYRING_SERVICE: &str = "spawn";
const KEYRING_USER: &str = "daemon";

pub const HOST_KEY_ALGORITHM: &str = "ed25519";
const ED25519_SEED_BYTES: usize = 32;
const ED25519_SEED_B64URL_LENGTH: usize = 43;
const FINGERPRINT_HASH_BYTES: usize = 12;
const MAX_CREDENTIALS_FILE_BYTES: usize = 16 * 1024;
const MAX_ACCESS_TOKEN_BYTES: usize = 12 * 1024;
const MAX_SERVER_URL_BYTES: usize = 2048;

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
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostIdentity {
    pub algorithm: &'static str,
    pub public_key: String,
    pub fingerprint: String,
}

#[derive(Serialize, Deserialize)]
struct StoredSecrets {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    access_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    host_private_key_seed: Option<String>,
}

impl StoredCreds {
    pub fn is_logged_in(&self) -> bool {
        self.access_token.as_deref().is_some_and(|t| !t.is_empty())
    }
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
            let decoded = decode_keyring_value(&value);
            value.zeroize();
            let mut secrets = decoded?;
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
    let mut metadata = creds.clone();
    metadata.host_private_key_seed = None;
    save_file(&metadata)
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

    println!("server:     {}", server);
    println!(
        "configured: {}",
        creds.server_url.as_deref().unwrap_or("(none)")
    );
    println!(
        "logged in:  {}",
        if creds.is_logged_in() { "yes" } else { "no" }
    );
    println!(
        "host_id:    {}",
        creds
            .host_id
            .map(|h| h.to_string())
            .unwrap_or_else(|| "(none)".into())
    );
    match host_identity(&creds)? {
        Some(identity) => {
            println!("host key:   {} {}", identity.algorithm, identity.public_key);
            println!("fingerprint: {}", identity.fingerprint);
        }
        None => {
            println!("host key:   (none; run `spawnd login`)");
            println!("fingerprint: (none)");
        }
    }
    Ok(())
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
        })
    }
}

fn keyring_set(creds: &StoredCreds) -> Result<()> {
    let entry = keyring_entry()?;
    let mut bundle = StoredSecrets {
        access_token: creds.access_token.clone(),
        host_private_key_seed: creds.host_private_key_seed.clone(),
    };
    let mut encoded = match serde_json::to_string(&bundle) {
        Ok(encoded) => encoded,
        Err(error) => {
            zeroize_secrets(&mut bundle);
            return Err(error.into());
        }
    };
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
    validate_loaded_creds(creds)?;
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

    fn fixed_creds() -> StoredCreds {
        StoredCreds {
            host_private_key_seed: Some(URL_SAFE_NO_PAD.encode([7_u8; ED25519_SEED_BYTES])),
            ..StoredCreds::default()
        }
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
    fn credentials_json_does_not_mislabel_private_material_as_public() {
        let creds = fixed_creds();
        let json = serde_json::to_string(&creds).unwrap();
        assert!(json.contains("host_private_key_seed"));
        assert!(!json.contains("host_public_key"));
        assert!(!json.contains("fingerprint"));
    }

    #[test]
    fn file_fallback_round_trip_preserves_identity() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("credentials.json");
        let original = fixed_creds();
        let expected = host_identity(&original).unwrap();
        save_file_at(&path, &original).unwrap();
        let restored = load_file_at(&path).unwrap();
        assert_eq!(
            restored.host_private_key_seed,
            original.host_private_key_seed
        );
        assert_eq!(host_identity(&restored).unwrap(), expected);
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
