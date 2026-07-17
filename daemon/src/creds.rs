//! Token storage. We try the OS keyring first; if that fails (common on
//! headless Linux without a Secret Service / dbus session) we fall back to a
//! mode-600 JSON file at `~/.config/spawn/credentials.json`. This fallback is
//! intentionally retained for the already-supported headless Linux mode where
//! no Secret Service is available. The same secret bundle holds the daemon
//! token and Ed25519 private seed; neither is ever sent to logs or status.
//! Metadata in that file also supplies `host_id` and the configured server.

use std::io::Write;
use std::path::Path;

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
const FINGERPRINT_HASH_BYTES: usize = 12;

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
        Ok(Some(value)) => {
            // Backend unavailability may use the documented file fallback,
            // but malformed stored data must fail closed rather than rotate.
            let secrets = decode_keyring_value(&value)?;
            if secrets.access_token.is_some() {
                from_file.access_token = secrets.access_token;
            }
            if secrets.host_private_key_seed.is_some() {
                from_file.host_private_key_seed = secrets.host_private_key_seed;
            }
        }
        Ok(None) => {}
        Err(e) => {
            tracing::warn!(error = %e, "keyring read failed; using file-stored token if any");
        }
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
        getrandom::getrandom(&mut seed).context("generating Ed25519 host identity")?;
        creds.host_private_key_seed = Some(URL_SAFE_NO_PAD.encode(&seed));
        seed.zeroize();
    }
    host_identity(creds)?.context("host identity was not generated")
}

/// Derive only public presentation data from a stored seed without generating.
pub fn host_identity(creds: &StoredCreds) -> Result<Option<HostIdentity>> {
    let Some(encoded_seed) = creds.host_private_key_seed.as_deref() else {
        return Ok(None);
    };
    let mut decoded = URL_SAFE_NO_PAD
        .decode(encoded_seed)
        .context("decoding stored Ed25519 host identity")?;
    if decoded.len() != ED25519_SEED_BYTES || URL_SAFE_NO_PAD.encode(&decoded) != encoded_seed {
        decoded.zeroize();
        bail!("stored Ed25519 host identity is not canonical")
    }
    let mut seed: [u8; ED25519_SEED_BYTES] = decoded
        .as_slice()
        .try_into()
        .context("stored Ed25519 host identity has the wrong length")?;
    decoded.zeroize();
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
    if !keyring_disabled() {
        if let Err(e) = keyring_delete() {
            tracing::warn!(error = %e, "keyring delete failed (may simply have been absent)");
        }
    }
    let path = config::credentials_path()?;
    if path.exists() {
        std::fs::remove_file(&path).with_context(|| format!("removing {}", path.display()))?;
        println!("spawn: removed {}", path.display());
    } else {
        println!("spawn: no stored credentials");
    }
    Ok(())
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
    // Backward compatibility for keyrings containing the legacy raw daemon
    // token. The next save upgrades it to a secret bundle.
    if value.starts_with('{') {
        serde_json::from_str(value).context("parsing keyring daemon secret bundle")
    } else {
        Ok(StoredSecrets {
            access_token: Some(value.to_owned()),
            host_private_key_seed: None,
        })
    }
}

fn keyring_set(creds: &StoredCreds) -> Result<()> {
    let entry = keyring_entry()?;
    let bundle = StoredSecrets {
        access_token: creds.access_token.clone(),
        host_private_key_seed: creds.host_private_key_seed.clone(),
    };
    let encoded = serde_json::to_string(&bundle)?;
    entry.set_password(&encoded)?;
    Ok(())
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
    if !path.exists() {
        return Ok(StoredCreds::default());
    }
    let raw =
        std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    let creds: StoredCreds =
        serde_json::from_str(&raw).with_context(|| format!("parsing {}", path.display()))?;
    Ok(creds)
}

fn save_file(creds: &StoredCreds) -> Result<()> {
    let path = config::credentials_path()?;
    save_file_at(&path, creds)
}

fn save_file_at(path: &Path, creds: &StoredCreds) -> Result<()> {
    let json = serde_json::to_vec_pretty(creds)?;
    write_secure(path, &json).with_context(|| format!("writing {}", path.display()))?;
    Ok(())
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
}

#[cfg(unix)]
fn write_secure(path: &Path, data: &[u8]) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    // Write atomically: tmp file in same dir + rename.
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let mut tmp = parent.to_path_buf();
    tmp.push(format!(".credentials.{}.tmp", std::process::id()));
    {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(not(unix))]
fn write_secure(path: &Path, data: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, data)
}
