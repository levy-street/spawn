use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};

use crate::api::ApiClient;
use crate::models::{HeartbeatState, LocalStatus};
use crate::storage;

pub fn daemon_path() -> Result<PathBuf> {
    Ok(dirs::home_dir()
        .context("the home directory is unavailable")?
        .join(".local/bin/spawnd"))
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
    let service_name = status
        .pointer("/instances/0/service/name")
        .and_then(serde_json::Value::as_str);
    let launchctl = launchctl_status(service_name);
    let log_tail = service_name.map(log_tail).unwrap_or_default();
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
        launchctl,
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

fn launchctl_status(service_name: Option<&str>) -> String {
    let Some(service_name) = service_name else {
        return "service name unavailable".into();
    };
    let uid = Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned());
    let Some(uid) = uid else {
        return "could not resolve launchctl user domain".into();
    };
    let label = service_name
        .strip_prefix("launchd ")
        .unwrap_or(service_name);
    Command::new("launchctl")
        .arg("print")
        .arg(format!("gui/{uid}/{label}"))
        .output()
        .map(|output| combine_output(&output))
        .unwrap_or_else(|error| format!("launchctl print failed: {error}"))
}

fn log_tail(service_name: &str) -> String {
    let Some(instance) = service_name.strip_prefix("launchd app.spawn.spawnd.") else {
        return String::new();
    };
    let Some(home) = dirs::home_dir() else {
        return String::new();
    };
    let state_dir = dirs::state_dir()
        .unwrap_or_else(|| home.join(".local/state"))
        .join("spawn")
        .join(instance);
    ["spawnd.out.log", "spawnd.err.log"]
        .into_iter()
        .filter_map(|name| {
            let path = state_dir.join(name);
            let bytes = std::fs::read(&path).ok()?;
            let text = String::from_utf8_lossy(&bytes);
            let lines = text.lines().rev().take(60).collect::<Vec<_>>();
            Some(format!(
                "{name}\n{}",
                lines.into_iter().rev().collect::<Vec<_>>().join("\n")
            ))
        })
        .collect::<Vec<_>>()
        .join("\n\n")
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
