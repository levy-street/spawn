//! Token storage. We try the OS keyring first; if that fails (common on
//! headless Linux without a Secret Service / dbus session) we fall back to a
//! mode-600 JSON file at `~/.config/spawn/credentials.json`. The same file
//! also persists `host_id` and the server URL we logged in against, which
//! `spawnd run` and `spawnd status` consume.

use std::io::Write;
use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::config;

const KEYRING_SERVICE: &str = "spawn";
const KEYRING_USER: &str = "daemon";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StoredCreds {
    /// Daemon access token (long-lived).
    pub access_token: Option<String>,
    /// The host_id the server assigned when we registered.
    pub host_id: Option<Uuid>,
    /// Server URL we authenticated against.
    pub server_url: Option<String>,
}

impl StoredCreds {
    pub fn is_logged_in(&self) -> bool {
        self.access_token.as_deref().is_some_and(|t| !t.is_empty())
    }
}

/// Load stored creds. Tries keyring first for the token; reads the file for
/// metadata regardless. Missing creds returns `Ok(StoredCreds::default())`.
pub fn load() -> Result<StoredCreds> {
    let mut from_file = load_file().unwrap_or_default();

    if keyring_disabled() {
        return Ok(from_file);
    }

    match keyring_get() {
        Ok(Some(tok)) => from_file.access_token = Some(tok),
        Ok(None) => {}
        Err(e) => {
            tracing::warn!(error = %e, "keyring read failed; using file-stored token if any");
        }
    }
    Ok(from_file)
}

/// Persist creds. Writes the metadata (host_id, server_url, and a
/// best-effort copy of the token) to the JSON file, and tries to put the
/// token in the keyring as well.
pub fn save(creds: &StoredCreds) -> Result<()> {
    if !keyring_disabled() {
        if let Some(tok) = creds.access_token.as_deref() {
            if let Err(e) = keyring_set(tok) {
                tracing::warn!(error = %e, "keyring write failed; token will live in the file fallback only");
            }
        }
    }
    save_file(creds)
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
    let creds = load().unwrap_or_default();

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
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn keyring_set(token: &str) -> Result<()> {
    let entry = keyring_entry()?;
    entry.set_password(token)?;
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
    let json = serde_json::to_vec_pretty(creds)?;
    write_secure(&path, &json).with_context(|| format!("writing {}", path.display()))?;
    Ok(())
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
