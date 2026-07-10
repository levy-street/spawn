//! Resolved daemon configuration.

use std::path::PathBuf;

use anyhow::{Context, Result};
use url::Url;

// Dev default uses plain http; deployments should pass --server or set
// SPAWN_SERVER_URL to the public https endpoint.
const DEFAULT_SERVER: &str = "http://localhost:8000";

/// Resolve the server base URL: explicit `--server` flag wins, then
/// `SPAWN_SERVER_URL` env (clap already wired this), then default.
pub fn server_url(cli_value: Option<String>) -> Result<Url> {
    let raw = cli_value.unwrap_or_else(|| DEFAULT_SERVER.to_string());
    Url::parse(&raw).with_context(|| format!("invalid server URL {raw:?}"))
}

/// Returns the daemon config dir, creating it if missing. Defaults to
/// `~/.config/spawn/`; `SPAWN_CONFIG_DIR` overrides it so multiple daemons
/// (e.g. one per server) can coexist on a host without sharing credentials.
pub fn config_dir() -> Result<PathBuf> {
    let dir = match std::env::var_os("SPAWN_CONFIG_DIR").filter(|v| !v.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => dirs::config_dir()
            .context("cannot resolve user config dir")?
            .join("spawn"),
    };
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    Ok(dir)
}

pub fn credentials_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("credentials.json"))
}

/// Build the websocket URL for `/ws/daemon` from the server URL.
pub fn ws_url(server: &Url) -> Result<Url> {
    let mut ws = server.clone();
    let scheme = match server.scheme() {
        "https" => "wss",
        "http" => "ws",
        other => anyhow::bail!("unsupported server scheme {other:?}"),
    };
    ws.set_scheme(scheme)
        .map_err(|_| anyhow::anyhow!("could not set ws scheme"))?;
    // Append /ws/daemon to whatever base path the server URL has.
    let mut path = ws.path().trim_end_matches('/').to_string();
    path.push_str("/ws/daemon");
    ws.set_path(&path);
    Ok(ws)
}

/// Build a REST URL by joining `path` (which begins with `/`) onto the
/// configured server base URL.
pub fn api_url(server: &Url, path: &str) -> Result<Url> {
    debug_assert!(path.starts_with('/'));
    // Url::join replaces the path; combine manually to respect a base path on
    // the server URL (rare, but cheap to support).
    let mut joined = server.clone();
    let base = joined.path().trim_end_matches('/').to_string();
    joined.set_path(&format!("{base}{path}"));
    Ok(joined)
}
