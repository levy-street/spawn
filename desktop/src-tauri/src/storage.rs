use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use keyring::Entry;
use sha2::{Digest, Sha256};
use url::Url;
use zeroize::Zeroizing;

use crate::models::DesktopPreferences;

const KEYRING_SERVICE: &str = "spawn";

fn state_path() -> Result<PathBuf> {
    let base =
        dirs::config_dir().context("the macOS application-support directory is unavailable")?;
    Ok(base.join("dev.spawnd.desktop").join("state.json"))
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

fn scoped_keyring_user(prefix: &str, scope: &str) -> String {
    let digest = Sha256::digest(scope.as_bytes());
    format!("desktop-{prefix}-{}", hex::encode(&digest[..12]))
}

fn entry(prefix: &str, scope: &str) -> Result<Entry> {
    Entry::new(KEYRING_SERVICE, &scoped_keyring_user(prefix, scope))
        .context("opening the SPAWN D keychain item")
}

pub fn set_token(origin: &str, token: &str) -> Result<()> {
    entry("token", origin)?
        .set_password(token)
        .context("saving the SPAWN D session in Keychain")
}

pub fn token(origin: &str) -> Result<Zeroizing<String>> {
    entry("token", origin)?
        .get_password()
        .map(Zeroizing::new)
        .context("reading the SPAWN D session from Keychain")
}

pub fn clear_token(origin: &str) -> Result<()> {
    match entry("token", origin)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error).context("removing the SPAWN D session from Keychain"),
    }
}

pub fn set_device_seed(account_id: &str, seed_wire: &str) -> Result<()> {
    entry("device", account_id)?
        .set_password(seed_wire)
        .context("saving the SPAWN D device identity in Keychain")
}

pub fn device_seed(account_id: &str) -> Result<Option<Zeroizing<String>>> {
    match entry("device", account_id)?.get_password() {
        Ok(value) => Ok(Some(Zeroizing::new(value))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error).context("reading the SPAWN D device identity from Keychain"),
    }
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
}
