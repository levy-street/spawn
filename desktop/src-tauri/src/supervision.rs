use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};

use crate::api::ApiClient;
use crate::models::{HeartbeatState, LocalStatus};
use crate::storage;

#[cfg(target_os = "macos")]
#[path = "supervision/macos.rs"]
mod platform_supervision;
#[cfg(target_os = "windows")]
#[path = "supervision/windows.rs"]
mod platform_supervision;

pub fn daemon_path() -> Result<PathBuf> {
    #[cfg(target_os = "macos")]
    let path = dirs::home_dir()
        .context("the home directory is unavailable")?
        .join(".local/bin/spawnd");
    #[cfg(target_os = "windows")]
    let path = dirs::data_local_dir()
        .context("the Windows local application-data directory is unavailable")?
        .join("spawn/bin/spawnd.exe");
    Ok(path)
}

pub async fn local_status(include_doctor: bool) -> Result<LocalStatus> {
    let preferences = storage::load_preferences()?;
    let spawnd = daemon_path()?;
    let status = command_json(&spawnd, &["status", "--json"])
        .unwrap_or_else(|error| serde_json::json!({ "error": error.to_string(), "instances": [] }));
    let doctor = include_doctor
        .then(|| command_json(&spawnd, &["doctor", "--json"]).ok())
        .flatten();
    let config_dir = status
        .pointer("/instances/0/config_dir")
        .and_then(serde_json::Value::as_str)
        .map(PathBuf::from);
    let heartbeat = config_dir
        .as_deref()
        .and_then(|dir| read_heartbeat(&dir.join("state.json")).ok())
        .flatten();
    let (service, log_tail) = platform_supervision::diagnostics(&status);
    let api = ApiClient::new(&preferences.server_origin)?;
    let hosts = api
        .authenticated_get("/api/hosts")
        .await
        .unwrap_or_else(|error| serde_json::json!({ "error": error.to_string() }));
    let release = api
        .optional_authenticated_get("/api/release")
        .await?
        .unwrap_or(serde_json::Value::Null);
    Ok(LocalStatus {
        status,
        doctor,
        heartbeat,
        service,
        hosts,
        release,
        log_tail,
    })
}

pub fn repair_resume() -> Result<String> {
    let preferences = storage::load_preferences()?;
    let output = Command::new(daemon_path()?)
        .arg("--server")
        .arg(preferences.server_origin)
        .arg("possess")
        .arg("--no-qr")
        .env("NO_COLOR", "1")
        .output()
        .context("re-running spawnd possess")?;
    let text = combine_output(&output);
    if !output.status.success() {
        bail!("{text}")
    }
    Ok(text)
}

pub fn stop_possessing() -> Result<String> {
    let preferences = storage::load_preferences()?;
    let output = Command::new(daemon_path()?)
        .arg("--server")
        .arg(preferences.server_origin)
        .arg("exorcise")
        .arg("--yes")
        .env("NO_COLOR", "1")
        .output()
        .context("running spawnd exorcise --yes")?;
    let text = combine_output(&output);
    if !output.status.success() {
        bail!("{text}")
    }
    Ok(text)
}

fn command_json(path: &Path, args: &[&str]) -> Result<serde_json::Value> {
    let output = Command::new(path)
        .args(args)
        .env("NO_COLOR", "1")
        .output()
        .with_context(|| format!("running {} {}", path.display(), args.join(" ")))?;
    if !output.status.success() {
        bail!("{}", combine_output(&output))
    }
    serde_json::from_slice(&output.stdout).context("decoding spawnd JSON output")
}

fn combine_output(output: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    format!("{stdout}{stderr}").trim().to_owned()
}

fn read_heartbeat(path: &Path) -> Result<Option<HeartbeatState>> {
    match std::fs::read(path) {
        Ok(bytes) if bytes.len() <= 16 * 1024 => Ok(Some(serde_json::from_slice(&bytes)?)),
        Ok(_) => bail!("state.json is oversized"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heartbeat_contract_rejects_oversized_or_unknown_shapes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        std::fs::write(
            &path,
            br#"{"pid":1,"version":"0.1.0","connected":false,"connected_at":null,"server":"https://spawnd.dev/","last_error":null,"sessions":0}"#,
        )
        .unwrap();
        assert_eq!(read_heartbeat(&path).unwrap().unwrap().sessions, 0);
        std::fs::write(&path, vec![b'x'; 16 * 1024 + 1]).unwrap();
        assert!(read_heartbeat(&path).is_err());
    }
}
