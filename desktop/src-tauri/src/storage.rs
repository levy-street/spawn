//! Where the app's own secrets live.
//!
//! Two of them: the session token for each server origin, and the Ed25519 seed
//! behind this device's identity for each account. Both are kept in a private
//! JSON file next to the app's preferences, handled by
//! `spawnd::secret_file` — the same atomic write, ownership/access checks,
//! no-follow open and cross-process lock the daemon uses for its own token and
//! host seed. On Unix that means a mode-0600 file owned by this user; on
//! Windows the same API gives the file a DACL that grants only this user.
//!
//! # Why not an OS credential vault
//!
//! Older macOS builds used Keychain, and an earlier Windows port used
//! Credential Manager. The honest trade has to be stated rather than assumed,
//! because on paper the macOS Keychain is the stronger store: an item's ACL is
//! bound to a code signature, so *other processes running as this user* cannot
//! read it without a dialog, while a private file is readable by code already
//! running as this user. That is a real difference and this design gives it
//! up.
//!
//! It is worth giving up for two reasons. First, the protection was not buying
//! what it appeared to. This app installs and supervises `spawnd`, whose
//! credentials are strictly more powerful than anything here — the host key
//! that possesses this computer and the daemon token that speaks for it — and
//! those already use the same secret-file contract. Code running as this user
//! that wanted a way in would take those credentials; putting the lesser prize
//! behind a different door does not change that attacker's reach.
//!
//! Second, the macOS dialog costs more trust than it protects. "SPAWN D wants
//! to use your confidential information stored in your keychain" reads as a
//! request for passwords, especially from a product that runs agents on the
//! machine. One shared, auditable storage primitive also avoids platform vault
//! limits and keeps the companion and daemon's security fixes in lockstep.
//!
//! What is *not* given up: writes are atomic, oversized or non-regular files
//! are refused, links/reparse points are not followed, access is restricted to
//! this user by the platform implementation, and secret values are zeroized in
//! memory on the way out.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use spawnd::secret_file::SecretFile;
use url::Url;
use zeroize::{Zeroize, Zeroizing};

use crate::models::DesktopPreferences;

/// A token is a JWT and a seed is 43 characters; the whole record for every
/// origin and account a person has used is comfortably inside this. Anything
/// larger is corruption, not data.
const MAX_CREDENTIAL_BYTES: usize = 64 * 1024;

/// The temporary prefix is deliberately not the daemon's `.credentials.`: the
/// two never share a directory today, but a sweeper that cannot tell its own
/// in-flight writes from another program's is a bug waiting for the day they
/// do.
const CREDENTIAL_FILE: SecretFile = SecretFile::new(
    "the SPAWN D credential file",
    ".desktop-credentials.",
    MAX_CREDENTIAL_BYTES,
);
const CREDENTIAL_LOCK_FILE: &str = ".credentials.lock";
const CREDENTIAL_RECORD_VERSION: u8 = 1;

/// `dirs::config_dir` maps this one layout to Application Support on macOS and
/// Roaming AppData on Windows. Preferences and credentials deliberately stay
/// beside one another on both platforms.
fn support_dir() -> Result<PathBuf> {
    let base =
        dirs::config_dir().context("the application configuration directory is unavailable")?;
    Ok(base.join("dev.spawnd.desktop"))
}

fn state_path() -> Result<PathBuf> {
    Ok(support_dir()?.join("state.json"))
}

fn credentials_path() -> Result<PathBuf> {
    Ok(support_dir()?.join("credentials.json"))
}

pub fn load_preferences() -> Result<DesktopPreferences> {
    let path = state_path()?;
    match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).context("decoding desktop preferences"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Default::default()),
        Err(error) => Err(error).with_context(|| format!("reading {}", path.display())),
    }
}

pub fn save_preferences(preferences: &DesktopPreferences) -> Result<()> {
    let path = state_path()?;
    let parent = path.parent().context("desktop state path has no parent")?;
    fs::create_dir_all(parent)?;
    let temporary = path.with_extension(format!("json.tmp.{}", std::process::id()));
    let bytes = serde_json::to_vec_pretty(preferences)?;
    fs::write(&temporary, bytes)?;
    fs::rename(&temporary, &path)?;
    Ok(())
}

pub fn normalize_server_url(value: &str) -> std::result::Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Enter a SPAWN D server URL".into());
    }
    let lower = trimmed.to_ascii_lowercase();
    if (lower.starts_with("http:") || lower.starts_with("https:"))
        && !(lower.starts_with("http://") || lower.starts_with("https://"))
    {
        return Err("Enter a valid SPAWN D server URL".into());
    }
    let candidate = if trimmed.starts_with("//") {
        format!("https:{trimmed}")
    } else if trimmed.contains("://") {
        trimmed.to_owned()
    } else {
        format!("https://{trimmed}")
    };
    let parsed = Url::parse(&candidate).map_err(|_| "Enter a valid SPAWN D server URL")?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("SPAWN D server URL must use http or https".into());
    }
    if parsed.host_str().is_none_or(str::is_empty) {
        return Err("SPAWN D server URL must include a host".into());
    }
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("SPAWN D server URL cannot include credentials, a query, or a fragment".into());
    }
    Ok(candidate.trim_end_matches('/').to_owned())
}

/// The record on disk. Plain origins and account ids are safe map keys here;
/// the hash used by the retired vault layout existed only to make legal vault
/// account names.
#[derive(Debug, Default, Serialize, Deserialize)]
struct StoredSecrets {
    version: u8,
    /// Server origin → session token.
    #[serde(default)]
    tokens: BTreeMap<String, String>,
    /// Account id → Ed25519 seed, base64url.
    #[serde(default)]
    device_seeds: BTreeMap<String, String>,
}

impl StoredSecrets {
    /// A machine that has never stored anything. Spelled out rather than
    /// derived because `Drop` rules out struct-update syntax.
    fn empty() -> Self {
        Self {
            version: CREDENTIAL_RECORD_VERSION,
            tokens: BTreeMap::new(),
            device_seeds: BTreeMap::new(),
        }
    }
}

impl Drop for StoredSecrets {
    fn drop(&mut self) {
        for value in self
            .tokens
            .values_mut()
            .chain(self.device_seeds.values_mut())
        {
            value.zeroize();
        }
    }
}

fn read_secrets() -> Result<StoredSecrets> {
    let path = credentials_path()?;
    let Some(mut raw) = CREDENTIAL_FILE.read(&path)? else {
        return Ok(StoredSecrets::empty());
    };
    let parsed = serde_json::from_slice(&raw)
        .with_context(|| format!("decoding {}", path.display()))
        .map(|mut secrets: StoredSecrets| {
            secrets.version = CREDENTIAL_RECORD_VERSION;
            secrets
        });
    raw.zeroize();
    parsed
}

fn write_secrets(secrets: &StoredSecrets) -> Result<()> {
    let path = credentials_path()?;
    let parent = path.parent().context("credential path has no parent")?;
    fs::create_dir_all(parent)?;
    let mut json = serde_json::to_vec_pretty(secrets)?;
    let result = CREDENTIAL_FILE
        .write(&path, &json)
        .with_context(|| format!("writing {}", path.display()));
    json.zeroize();
    result
}

/// Read, change, write — with the lock held across all three.
///
/// Every writer goes through here. Two copies of the app, or an update
/// restarting one over the other, must not each read the same record and write
/// a whole copy back: the second write would silently drop what the first
/// added.
fn commit<T>(change: impl FnOnce(&mut StoredSecrets) -> Result<T>) -> Result<T> {
    let directory = support_dir()?;
    fs::create_dir_all(&directory)?;
    let lock_path = directory.join(CREDENTIAL_LOCK_FILE);
    CREDENTIAL_FILE.lock(&lock_path, || {
        CREDENTIAL_FILE.cleanup_stale_temporaries(&credentials_path()?)?;
        let mut secrets = read_secrets()?;
        let outcome = change(&mut secrets)?;
        write_secrets(&secrets)?;
        Ok(outcome)
    })
}

pub fn set_token(origin: &str, token: &str) -> Result<()> {
    commit(|secrets| {
        secrets.tokens.insert(origin.to_owned(), token.to_owned());
        Ok(())
    })
}

pub fn token(origin: &str) -> Result<Zeroizing<String>> {
    read_secrets()?
        .tokens
        .get(origin)
        .cloned()
        .map(Zeroizing::new)
        .context("no SPAWN D session is stored for this server")
}

/// Forget the account signed in on this device.
///
/// Both the wizard's own "sign out" and the product face leaving the product
/// end here, so the two cannot drift: a device that has no token must not go
/// on remembering which account it belonged to, or the next launch offers a
/// signed-in shell over a session the server has already dropped.
pub fn forget_account() -> Result<()> {
    let mut preferences = load_preferences()?;
    clear_token(&preferences.server_origin)?;
    preferences.account_id = None;
    preferences.account_email = None;
    preferences.device_id = None;
    preferences.device_approved = false;
    save_preferences(&preferences)
}

pub fn clear_token(origin: &str) -> Result<()> {
    commit(|secrets| {
        if let Some(mut token) = secrets.tokens.remove(origin) {
            token.zeroize();
        }
        Ok(())
    })
}

pub fn set_device_seed(account_id: &str, seed_wire: &str) -> Result<()> {
    commit(|secrets| {
        secrets
            .device_seeds
            .insert(account_id.to_owned(), seed_wire.to_owned());
        Ok(())
    })
}

pub fn device_seed(account_id: &str) -> Result<Option<Zeroizing<String>>> {
    Ok(read_secrets()?
        .device_seeds
        .get(account_id)
        .cloned()
        .map(Zeroizing::new))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_url_validation_matches_the_native_client_contract() {
        assert_eq!(
            normalize_server_url("spawnd.dev").unwrap(),
            "https://spawnd.dev"
        );
        assert_eq!(
            normalize_server_url("http://localhost:8010/").unwrap(),
            "http://localhost:8010"
        );
        assert_eq!(
            normalize_server_url(""),
            Err("Enter a SPAWN D server URL".into())
        );
        assert_eq!(
            normalize_server_url("https:spawnd.dev"),
            Err("Enter a valid SPAWN D server URL".into())
        );
        assert!(normalize_server_url("https://user@example.com")
            .unwrap_err()
            .contains("credentials"));
        assert!(normalize_server_url("file:///tmp/spawn")
            .unwrap_err()
            .contains("http or https"));
    }

    /// The record is what actually goes to disk, so it is worth reading: a
    /// field renamed or dropped here silently signs everyone out on upgrade.
    #[test]
    fn the_record_round_trips_every_scope_it_holds() {
        let mut secrets = StoredSecrets::empty();
        secrets
            .tokens
            .insert("https://spawnd.dev".into(), "token-a".into());
        secrets
            .tokens
            .insert("http://localhost:3000".into(), "token-b".into());
        secrets
            .device_seeds
            .insert("account-1".into(), "seed-1".into());

        let json = serde_json::to_vec(&secrets).expect("encode");
        let back: StoredSecrets = serde_json::from_slice(&json).expect("decode");
        assert_eq!(back.tokens["https://spawnd.dev"], "token-a");
        assert_eq!(back.tokens["http://localhost:3000"], "token-b");
        assert_eq!(back.device_seeds["account-1"], "seed-1");
    }

    /// Older file-store builds carried a completed Keychain-migration flag.
    /// Serde must ignore it while retaining every actual credential.
    #[test]
    fn the_retired_migration_field_is_forward_compatible() {
        let older =
            br#"{"version":1,"tokens":{"https://spawnd.dev":"token"},"keychain_migrated":true}"#;
        let parsed: StoredSecrets = serde_json::from_slice(older).expect("decode");
        assert_eq!(parsed.tokens["https://spawnd.dev"], "token");
        assert!(parsed.device_seeds.is_empty());
    }

    #[test]
    fn the_credential_file_sits_beside_the_preferences() {
        let state = state_path().expect("state path");
        let credentials = credentials_path().expect("credential path");
        assert_eq!(state.parent(), credentials.parent());
        assert_eq!(
            credentials.file_name().and_then(|name| name.to_str()),
            Some("credentials.json")
        );
        assert_eq!(CREDENTIAL_FILE.max_bytes(), MAX_CREDENTIAL_BYTES);
    }
}
