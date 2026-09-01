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
    account_id: String,
    host_name: Option<String>,
    config_dir: String,
    server: String,
    /// A stored daemon token exists; scripts test this instead of parsing the
    /// human layout (scripts/dev.sh, scripts/smoke-local-login.sh).
    signed_in: bool,
    connection: String,
    service: crate::service::ServiceStatus,
    sessions: usize,
    session_workers: Vec<String>,
    version: String,
    update: String,
    host_key: Option<String>,
    /// The identity this machine registered under, for a local client that has
    /// to recognise this host in a list the server sent. Neither value is a
    /// secret — the server stores both and the approval link carries the key —
    /// but reading them from the daemon rather than from the network is what
    /// lets a client refuse a row that does not match the machine it is
    /// standing on. Absent until this instance has registered.
    host_id: Option<String>,
    host_public_key: Option<String>,
    browser_pins: usize,
    browser_connections: Vec<BrowserConnectionStatus>,
    compatibility_notes: Vec<String>,
}

#[derive(Debug, Serialize)]
struct BrowserConnectionStatus {
    pin_id: Option<String>,
    device_id: String,
    name: Option<String>,
    platform: Option<String>,
    fingerprint: Option<String>,
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
        // Only the legacy single-instance layout — credentials in the base
        // dir itself — earns the fallback. A bare or absent dir is zero
        // instances; treating it as one invented a phantom account named
        // after the folder ("account  spawn") and made `status` disagree
        // with `instances` about whether anything is signed in at all.
        let legacy = crate::config::config_dir()?;
        if legacy.join("credentials.json").is_file() {
            return Ok(vec![legacy]);
        }
        return Ok(Vec::new());
    }
    Ok(instances)
}

async fn inspect_instance(dir: &Path, server_cli: Option<String>) -> Result<InstanceStatus> {
    let _guard = ConfigDirGuard::set(dir);
    let stored = crate::creds::load().context("loading stored credentials")?;
    let server =
        crate::config::server_url_for_instance(server_cli.clone(), stored.server_url.as_deref())?;
    let heartbeat = crate::state::read(dir).ok().flatten();
    let connection = connection_text(heartbeat.as_ref());
    let sessions = heartbeat.as_ref().map_or(0, |state| state.sessions);
    let update = release_state(&server).await;
    let identity = crate::creds::host_identity(&stored)?;
    let host_key = identity
        .as_ref()
        .map(|identity| identity.fingerprint.clone());
    let host_public_key = identity.map(|identity| identity.public_key);
    let host_id = stored.host_id.map(|id| id.to_string());
    let mut account_id = dir
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "default".into());
    let mut account = crate::state::human_account_label(dir);
    let mut host_name = None;
    let mut compatibility_notes = Vec::new();
    let mut browser_connections = stored
        .browser_pins()
        .iter()
        .map(|pin| BrowserConnectionStatus {
            pin_id: None,
            device_id: pin.device_id().to_string(),
            name: None,
            platform: None,
            fingerprint: Some(pin.fingerprint().to_owned()),
        })
        .collect::<Vec<_>>();
    if stored.is_logged_in() {
        match crate::manage::HostClient::load(server_cli) {
            Ok(client) => {
                let (host_result, pins_result) = tokio::join!(client.host(), client.pins());
                match host_result {
                    Ok(Some(host)) => {
                        account_id = host.account.id.clone();
                        account = crate::state::shorten_account_id(host.account_label());
                        if let Err(error) =
                            crate::state::remember_account_label(dir, host.account_label())
                        {
                            tracing::warn!(%error, "caching the account label");
                        }
                        host_name = Some(host.name);
                    }
                    Ok(None) => compatibility_notes.push(
                        "your server doesn't support named account details yet; showing a shortened account ID"
                            .into(),
                    ),
                    Err(error) => compatibility_notes
                        .push(format!("named account details unavailable: {error}")),
                }
                match pins_result {
                    Ok(Some(pins)) => {
                        browser_connections = pins
                            .into_iter()
                            .map(|pin| BrowserConnectionStatus {
                                pin_id: Some(pin.pin_id),
                                device_id: pin.device_id,
                                name: pin.name,
                                platform: pin.platform,
                                fingerprint: None,
                            })
                            .collect();
                    }
                    Ok(None) => compatibility_notes.push(
                        "your server doesn't support named browser connections yet; showing local identities"
                            .into(),
                    ),
                    Err(error) => compatibility_notes
                        .push(format!("named browser connections unavailable: {error}")),
                }
            }
            Err(error) => {
                compatibility_notes.push(format!("server inventory unavailable: {error}"))
            }
        }
    }
    let mut session_workers = crate::worker_backend::discover_ids()
        .into_iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>();
    session_workers.sort();
    Ok(InstanceStatus {
        account,
        account_id,
        host_name,
        config_dir: dir.display().to_string(),
        server: server.to_string(),
        signed_in: stored.is_logged_in(),
        connection,
        service: crate::service::status(dir),
        sessions,
        session_workers,
        version: crate::version::build_version(),
        update,
        host_key,
        host_id,
        host_public_key,
        browser_pins: browser_connections.len(),
        browser_connections,
        compatibility_notes,
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
    if crate::version::is_local_build()
        && !std::env::var("SPAWND_ALLOW_LOCAL_SELF_UPDATE")
            .is_ok_and(|value| value == "1" || value.eq_ignore_ascii_case("true"))
    {
        return "local build; automatic update disabled (override: SPAWND_ALLOW_LOCAL_SELF_UPDATE=1)"
            .into();
    }
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
    let _ = writeln!(text, "SPAWN D on {}", output.host);
    let _ = writeln!(
        text,
        "Account instances on this machine: {}",
        output.instances.len()
    );
    if output.instances.is_empty() {
        let _ = writeln!(
            text,
            "\n  No account is signed in on this machine yet — `spawnd possess` links it to one."
        );
    }
    for (index, instance) in output.instances.iter().enumerate() {
        text.push('\n');
        if output.instances.len() > 1 {
            let _ = writeln!(text, "Instance {}", index + 1);
        }
        let _ = writeln!(text, "  account      {}", instance.account);
        if let Some(host_name) = &instance.host_name {
            let _ = writeln!(text, "  machine      {host_name}");
        }
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
        let _ = writeln!(
            text,
            "  sessions     {} reported running",
            instance.sessions
        );
        for worker in &instance.session_workers {
            let _ = writeln!(text, "               session {worker}");
        }
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
        let _ = writeln!(
            text,
            "  browsers     {} approved connection(s)",
            instance.browser_pins
        );
        for pin in &instance.browser_connections {
            let name = pin
                .name
                .as_deref()
                .filter(|name| !name.trim().is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("browser {}", abbreviate(&pin.device_id)));
            let detail = pin
                .platform
                .as_deref()
                .filter(|platform| !platform.trim().is_empty())
                .or(pin.fingerprint.as_deref())
                .unwrap_or("details unavailable");
            let _ = writeln!(text, "               {name} — {detail}");
        }
        for note in &instance.compatibility_notes {
            let _ = writeln!(text, "  note         {note}");
        }
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
                account: "9f1c2d3e…4e5f".into(),
                account_id: "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f".into(),
                host_name: Some("mac-studio".into()),
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
                session_workers: vec!["00000000-0000-0000-0000-000000000001".into()],
                version: "0.4.2".into(),
                update: "up to date".into(),
                host_key: Some("SHA256:Yr0kQmVd12345678".into()),
                host_id: Some("11111111-2222-3333-4444-555555555555".into()),
                host_public_key: Some("jjR72AS1hifOv_I33o9frsYX3Ac9eCylvIxHOyYdNEc".into()),
                browser_pins: 3,
                browser_connections: vec![BrowserConnectionStatus {
                    pin_id: Some("pin-1".into()),
                    device_id: "device-1".into(),
                    name: Some("Charlie's MacBook".into()),
                    platform: Some("macOS".into()),
                    fingerprint: None,
                }],
                compatibility_notes: Vec::new(),
            }],
        };
        let plain = format_plain(&output, 0);
        assert!(plain.starts_with("SPAWN D on mac-studio\n"));
        assert!(plain.contains("Account instances on this machine: 1\n"));
        assert!(plain.contains("  connection   connected · 42 min · last error: none\n"));
        assert!(plain.contains("  service      running (launchd app.spawn.spawnd.3f9ac3e1)\n"));
        assert!(plain.contains("Charlie's MacBook — macOS\n"));
        assert!(plain.contains("  account      9f1c2d3e…4e5f\n"));
        assert!(!plain.contains("9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f"));
        assert!(!plain.contains("Other instances on this machine"));

        let json = serde_json::to_value(&output).unwrap();
        assert_eq!(json["host"], "mac-studio");
        assert_eq!(json["instances"][0]["sessions"], 2);
        assert_eq!(
            json["instances"][0]["session_workers"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(json["instances"][0]["service"]["running"], true);
        assert_eq!(json["instances"][0]["browser_pins"], 3);
        assert_eq!(
            json["instances"][0]["account_id"],
            "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f"
        );
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
