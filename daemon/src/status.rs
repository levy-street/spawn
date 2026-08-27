//! Human and JSON status across every local account instance.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use serde::Serialize;

use crate::cli::StatusArgs;

#[derive(Debug, Serialize)]
struct StatusOutput {
    host: String,
    instances: Vec<InstanceStatus>,
}

#[derive(Debug, Serialize)]
struct InstanceStatus {
    account: String,
    config_dir: String,
    server: String,
    /// A stored daemon token exists; scripts test this instead of parsing the
    /// human layout (scripts/dev.sh, scripts/smoke-local-login.sh).
    signed_in: bool,
    connection: String,
    service: crate::service::ServiceStatus,
    sessions: usize,
    version: String,
    update: String,
    host_key: Option<String>,
    browser_pins: usize,
}

pub async fn run(
    server_cli: Option<String>,
    args: StatusArgs,
    explicit_config: bool,
    verbose: u8,
) -> Result<()> {
    let host = hostname::get()
        .ok()
        .and_then(|value| value.into_string().ok())
        .unwrap_or_else(|| "unknown-host".into());
    let dirs = instance_dirs(explicit_config)?;
    let mut instances = Vec::with_capacity(dirs.len());
    for dir in dirs {
        instances.push(inspect_instance(&dir, server_cli.clone()).await?);
    }
    let output = StatusOutput { host, instances };
    if args.json {
        println!("{}", serde_json::to_string_pretty(&output)?);
    } else {
        print!("{}", format_plain(&output, verbose));
    }
    Ok(())
}

fn instance_dirs(explicit_config: bool) -> Result<Vec<PathBuf>> {
    if explicit_config {
        return Ok(vec![crate::config::config_dir()?]);
    }
    let base = crate::possess::default_instance_base()?;
    let instances = crate::possess::account_dirs_with_creds(&base)?;
    if instances.is_empty() {
        Ok(vec![crate::config::config_dir()?])
    } else {
        Ok(instances)
    }
}

async fn inspect_instance(dir: &Path, server_cli: Option<String>) -> Result<InstanceStatus> {
    let _guard = ConfigDirGuard::set(dir);
    let stored = crate::creds::load().context("loading stored credentials")?;
    let server = crate::config::server_url_for_instance(server_cli, stored.server_url.as_deref())?;
    let heartbeat = crate::state::read(dir).ok().flatten();
    let connection = connection_text(heartbeat.as_ref());
    let sessions = heartbeat.as_ref().map_or(0, |state| state.sessions);
    let update = release_state(&server).await;
    let host_key = crate::creds::host_identity(&stored)?.map(|identity| identity.fingerprint);
    Ok(InstanceStatus {
        account: dir
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "default".into()),
        config_dir: dir.display().to_string(),
        server: server.to_string(),
        signed_in: stored.is_logged_in(),
        connection,
        service: crate::service::status(dir),
        sessions,
        version: crate::version::build_version(),
        update,
        host_key,
        browser_pins: stored.browser_pins().len(),
    })
}

fn connection_text(state: Option<&crate::state::StateFile>) -> String {
    let Some(state) = state.filter(|state| crate::state::daemon_state_is_live(state)) else {
        return "not running — start with: spawnd reconnect".into();
    };
    if state.connected {
        let age = state
            .connected_at
            .as_deref()
            .and_then(crate::state::parse_rfc3339_seconds)
            .map(format_age)
            .unwrap_or_else(|| "duration unknown".into());
        return format!("connected · {age} · last error: none");
    }
    match state.last_error.as_ref() {
        Some(error) if error.kind == "auth" => {
            "rejected by server (signed out) — fix with: spawnd login".into()
        }
        Some(error) => format!(
            "retrying ({}: {}) — see: spawnd doctor",
            error.kind, error.detail
        ),
        None => "retrying — see: spawnd doctor".into(),
    }
}

fn format_age(connected_at: i64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let seconds = now.saturating_sub(connected_at).max(0) as u64;
    if seconds < 60 {
        "under 1 min".into()
    } else if seconds < 3_600 {
        format!("{} min", seconds / 60)
    } else if seconds < 86_400 {
        format!("{} h", seconds / 3_600)
    } else {
        format!("{} d", seconds / 86_400)
    }
}

async fn release_state(server: &url::Url) -> String {
    #[derive(serde::Deserialize)]
    struct Release {
        daemon: Option<Daemon>,
    }
    #[derive(serde::Deserialize)]
    struct Daemon {
        tree: String,
    }
    let Ok(url) = crate::config::api_url(server, "/api/release") else {
        return "unknown".into();
    };
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
    else {
        return "unknown".into();
    };
    let Ok(response) = client.get(url).send().await else {
        return "unknown".into();
    };
    let Ok(release) = response.json::<Release>().await else {
        return "unknown".into();
    };
    match (release.daemon, crate::version::daemon_tree()) {
        (Some(daemon), Some(own)) if daemon.tree == own => "up to date".into(),
        (Some(_), Some(_)) => "update available".into(),
        _ => "unknown".into(),
    }
}

fn format_plain(output: &StatusOutput, verbose: u8) -> String {
    use std::fmt::Write;

    let mut text = String::new();
    for (index, instance) in output.instances.iter().enumerate() {
        if index > 0 {
            text.push('\n');
        }
        let _ = writeln!(text, "SPAWN D on {}", output.host);
        let _ = writeln!(text, "  account      {}", instance.account);
        let _ = writeln!(text, "  server       {}", instance.server);
        let _ = writeln!(text, "  connection   {}", instance.connection);
        let service = if instance.service.running {
            format!("running ({})", instance.service.name)
        } else if instance.service.installed {
            format!("stopped ({})", instance.service.name)
        } else {
            "not installed".into()
        };
        let _ = writeln!(text, "  service      {service}");
        let _ = writeln!(text, "  sessions     {} running", instance.sessions);
        let _ = writeln!(
            text,
            "  version      {} · {}",
            instance.version, instance.update
        );
        let fingerprint = instance.host_key.as_deref().unwrap_or("(none)");
        let shown = if verbose > 0 {
            fingerprint.to_string()
        } else {
            abbreviate(fingerprint)
        };
        let _ = writeln!(text, "  host key     {shown}");
        let _ = writeln!(text, "  browser pins {}", instance.browser_pins);
    }
    let others = output.instances.len().saturating_sub(1);
    if others == 0 {
        text.push_str("\nOther instances on this machine: none\n");
    } else {
        let _ = writeln!(text, "\nOther instances on this machine: {others}");
    }
    text
}

fn abbreviate(value: &str) -> String {
    if value.chars().count() <= 16 {
        return value.to_owned();
    }
    format!("{}…", value.chars().take(16).collect::<String>())
}

struct ConfigDirGuard(Option<std::ffi::OsString>);

impl ConfigDirGuard {
    fn set(dir: &Path) -> Self {
        let previous = std::env::var_os("SPAWN_CONFIG_DIR");
        std::env::set_var("SPAWN_CONFIG_DIR", dir);
        Self(previous)
    }
}

impl Drop for ConfigDirGuard {
    fn drop(&mut self) {
        match self.0.take() {
            Some(previous) => std::env::set_var("SPAWN_CONFIG_DIR", previous),
            None => std::env::remove_var("SPAWN_CONFIG_DIR"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_heartbeat_has_the_exact_status_remedy() {
        let state = crate::state::StateFile {
            pid: std::process::id(),
            process_started_100ns: None,
            task_breakaway_denied: None,
            version: "0.1.0".into(),
            connected: false,
            connected_at: None,
            server: "https://spawnd.dev".into(),
            last_error: Some(crate::state::LastError {
                kind: "auth".into(),
                detail: "token_revoked".into(),
                at: "2026-08-25T00:00:00Z".into(),
            }),
            sessions: 1,
        };
        assert_eq!(
            connection_text(Some(&state)),
            "rejected by server (signed out) — fix with: spawnd login"
        );
    }

    #[test]
    fn plain_status_format_is_stable() {
        let output = StatusOutput {
            host: "mac-studio".into(),
            instances: vec![InstanceStatus {
                account: "9f1c2d3e".into(),
                config_dir: "/tmp/spawn/9f1c2d3e".into(),
                server: "https://spawnd.dev/".into(),
                signed_in: true,
                connection: "connected · 42 min · last error: none".into(),
                service: crate::service::ServiceStatus {
                    installed: true,
                    running: true,
                    name: "launchd app.spawn.spawnd.3f9ac3e1".into(),
                    manager: None,
                    stdout_log: None,
                    stderr_log: None,
                },
                sessions: 2,
                version: "0.4.2".into(),
                update: "up to date".into(),
                host_key: Some("SHA256:Yr0kQmVd12345678".into()),
                browser_pins: 3,
            }],
        };
        let plain = format_plain(&output, 0);
        assert!(plain.starts_with("SPAWN D on mac-studio\n"));
        assert!(plain.contains("  connection   connected · 42 min · last error: none\n"));
        assert!(plain.contains("  service      running (launchd app.spawn.spawnd.3f9ac3e1)\n"));
        assert!(plain.ends_with("Other instances on this machine: none\n"));

        let json = serde_json::to_value(&output).unwrap();
        assert_eq!(json["host"], "mac-studio");
        assert_eq!(json["instances"][0]["sessions"], 2);
        assert_eq!(json["instances"][0]["service"]["running"], true);
        assert_eq!(json["instances"][0]["browser_pins"], 3);
    }

    #[test]
    fn windows_service_diagnostics_keep_exact_manager_name_and_log_fields() {
        let service = crate::service::ServiceStatus {
            installed: true,
            running: true,
            name: "SPAWN D spawnd-deadbeef".into(),
            manager: Some("task-scheduler".into()),
            stdout_log: Some(r"C:\Users\alice\AppData\Local\spawn\logs\deadbeef\spawnd.log".into()),
            stderr_log: Some(r"C:\Users\alice\AppData\Local\spawn\logs\deadbeef\spawnd.log".into()),
        };

        let json = serde_json::to_value(service).unwrap();
        assert_eq!(json["manager"], "task-scheduler");
        assert_eq!(json["name"], "SPAWN D spawnd-deadbeef");
        assert_eq!(json["stdout_log"], json["stderr_log"]);
    }
}
