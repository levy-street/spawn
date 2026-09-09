//! Human and JSON status across every local account instance.
//!
//! Every line here is about the *instance*: the daemon that is running for
//! it, the release it is pointed at, and whether the pair it runs matches.
//! The command producing the report is one more binary on the machine and
//! says so under `cli_version`; it never speaks for a daemon. On 2026-09-09 a
//! shared `spawnd status` reported its own version and "up to date" for an
//! instance whose daemon was a different build, refusing every new session.

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
    /// The build this instance runs: its live daemon's, else the release it
    /// is pointed at, else — with neither — this command's own.
    version: String,
    update: String,
    host_key: Option<String>,
    browser_pins: usize,
    /// The build of the command printing this. Not the daemon's.
    cli_version: String,
    /// The daemon process alive for this instance, when there is one.
    running: Option<RunningBuild>,
    /// The release the instance is pointed at in the store, when it is.
    release: Option<SelectedRelease>,
    /// Where the instance launches from: `release store`, `legacy shared
    /// binary`, `custom path`, or `not running`.
    launch: String,
    /// Whether the running daemon's spawn-worker matches it.
    pair: String,
}

#[derive(Debug, Serialize)]
struct RunningBuild {
    pid: u32,
    version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tree: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exe: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    release: Option<String>,
    worker_mismatch: bool,
}

#[derive(Debug, Serialize)]
struct SelectedRelease {
    id: String,
    version: String,
    variant: String,
    dir: String,
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

/// What an instance runs and what it is pointed at, read from the machine
/// rather than assumed from the command. Shared with `doctor`.
pub(crate) struct InstanceBuild {
    pub(crate) state: Option<crate::state::StateFile>,
    pub(crate) selected: Option<crate::install::Release>,
    /// The version to report for the instance.
    pub(crate) version: String,
    /// The daemon tree to judge the server's release against; `None` when
    /// the machine offers no way to know it.
    pub(crate) tree: Option<String>,
}

impl InstanceBuild {
    pub(crate) fn live(&self) -> Option<&crate::state::StateFile> {
        self.state
            .as_ref()
            .filter(|state| crate::state::daemon_state_is_live(state))
    }
}

pub(crate) fn instance_build(config_dir: &Path) -> InstanceBuild {
    let state = crate::state::read(config_dir).ok().flatten();
    let live = state
        .as_ref()
        .filter(|state| crate::state::daemon_state_is_live(state));
    let selected = crate::install::layout_for_instance(config_dir)
        .ok()
        .and_then(|layout| crate::install::selected(&layout, config_dir).ok().flatten());
    let own_version = crate::version::build_version();
    let version = live
        .map(|state| state.version.clone())
        .or_else(|| {
            selected
                .as_ref()
                .map(|release| release.meta.version.clone())
        })
        .unwrap_or_else(|| own_version.clone());
    // A daemon that predates the heartbeat's `tree` field still has one thing
    // to go on: when it reports this command's commit — the variant segment
    // aside, a diagnostics build and its release share a tree — it is this
    // command's build. A dirty checkout's tree names nothing else's.
    let tree = live
        .and_then(|state| state.tree.clone())
        .or_else(|| {
            selected
                .as_ref()
                .map(|release| release.meta.tree.clone())
                .filter(|tree| !tree.is_empty())
        })
        .or_else(|| {
            (crate::install::base_version(&version) == crate::install::base_version(&own_version))
                .then(|| {
                    crate::version::daemon_tree()
                        .filter(|tree| !tree.ends_with("-dirty"))
                        .map(str::to_owned)
                })
                .flatten()
        });
    InstanceBuild {
        state,
        selected,
        version,
        tree,
    }
}

async fn inspect_instance(dir: &Path, server_cli: Option<String>) -> Result<InstanceStatus> {
    let _guard = crate::lifecycle::ConfigDirGuard::set(dir);
    let stored = crate::creds::load().context("loading stored credentials")?;
    let server = crate::config::server_url_for_instance(server_cli, stored.server_url.as_deref())?;
    let build = instance_build(dir);
    let heartbeat = build.state.as_ref();
    let connection = connection_text(heartbeat);
    let sessions = heartbeat.map_or(0, |state| state.sessions);
    let update = release_state(&server, build.tree.as_deref()).await;
    let host_key = crate::creds::host_identity(&stored)?.map(|identity| identity.fingerprint);
    let running = build.live().map(|state| RunningBuild {
        pid: state.pid,
        version: state.version.clone(),
        tree: state.tree.clone(),
        exe: state.exe.clone(),
        release: state.release.clone(),
        worker_mismatch: state.worker_mismatch,
    });
    let release = build.selected.as_ref().map(|release| SelectedRelease {
        id: release.meta.id.clone(),
        version: release.meta.version.clone(),
        variant: release.meta.variant.clone(),
        dir: release.dir.display().to_string(),
    });
    let launch = launch_text(build.live());
    let pair = pair_text(build.live());
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
        version: build.version,
        update,
        host_key,
        browser_pins: stored.browser_pins().len(),
        cli_version: crate::version::build_version(),
        running,
        release,
        launch,
        pair,
    })
}

/// Where the live daemon was launched from, as the machine reports it: the
/// process's own executable on Linux, the path it recorded elsewhere.
fn launch_text(live: Option<&crate::state::StateFile>) -> String {
    let Some(state) = live else {
        return "not running".into();
    };
    let exe = crate::install::live_exe(state.pid)
        .map(|(exe, _)| exe)
        .or_else(|| state.exe.as_deref().map(PathBuf::from));
    match exe {
        Some(exe) => match crate::install::provenance_of(&exe) {
            crate::install::Provenance::Store { .. } => "release store".into(),
            crate::install::Provenance::Legacy { .. }
                if crate::install::is_shared_legacy_pair(&exe) =>
            {
                "legacy shared binary".into()
            }
            crate::install::Provenance::Legacy { .. } => "hand-placed pair".into(),
            crate::install::Provenance::Unmanaged => "custom path".into(),
        },
        None => "unknown".into(),
    }
}

/// Whether the running daemon's worker matches it: the daemon's own verdict
/// first, then — where the machine can say which executable the process runs
/// — whether that file was replaced under it and whether the worker beside it
/// is the same build. A daemon too old to record any of this is asked about
/// through `/proc` on Linux and reported unknown elsewhere.
fn pair_text(live: Option<&crate::state::StateFile>) -> String {
    let Some(state) = live else {
        return "not running".into();
    };
    if state.worker_mismatch {
        return "MISMATCH — new sessions are refused; restart: spawnd reconnect".into();
    }
    let exe = match crate::install::live_exe(state.pid) {
        Some((_, true)) => {
            return "daemon binary was replaced on disk; restart: spawnd reconnect".into()
        }
        Some((exe, false)) => Some(exe),
        None => state.exe.as_deref().map(PathBuf::from),
    };
    let Some(exe) = exe else {
        return "unknown (this daemon predates the pair report)".into();
    };
    let worker = exe.with_file_name(crate::platform::executable_name("spawn-worker"));
    match crate::install::probe_pair(&exe, &worker) {
        Ok(identity) if identity.version == state.version => "matches".into(),
        Ok(identity) => format!(
            "MISMATCH — the pair beside the daemon is {} but the daemon is {}; restart: spawnd reconnect",
            identity.version, state.version
        ),
        Err(_) => "MISMATCH — no matching spawn-worker beside the daemon; restart: spawnd reconnect".into(),
    }
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

/// Compare the server's release with the tree *this instance* runs.
async fn release_state(server: &url::Url, instance_tree: Option<&str>) -> String {
    #[derive(serde::Deserialize)]
    struct Release {
        daemon: Option<Daemon>,
    }
    #[derive(serde::Deserialize)]
    struct Daemon {
        tree: String,
    }
    let Some(instance_tree) = instance_tree else {
        return "unknown (this daemon does not report its build)".into();
    };
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
    match release.daemon {
        Some(daemon) if daemon.tree == instance_tree => "up to date".into(),
        Some(_) => "update available".into(),
        None => "unknown".into(),
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
        match &instance.release {
            Some(release) => {
                let _ = writeln!(
                    text,
                    "  release      {} ({}) · {}",
                    release.id, release.variant, release.dir
                );
            }
            None => {
                let _ = writeln!(
                    text,
                    "  release      none selected · launch: {}",
                    instance.launch
                );
            }
        }
        let _ = writeln!(text, "  pair         {}", instance.pair);
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
    let _ = writeln!(
        text,
        "This command: spawnd {}",
        crate::version::build_version()
    );
    text
}

fn abbreviate(value: &str) -> String {
    if value.chars().count() <= 16 {
        return value.to_owned();
    }
    format!("{}…", value.chars().take(16).collect::<String>())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(version: &str, exe: Option<&str>, worker_mismatch: bool) -> crate::state::StateFile {
        crate::state::StateFile {
            pid: std::process::id(),
            process_started_100ns: None,
            task_breakaway_denied: None,
            version: version.into(),
            connected: false,
            connected_at: None,
            server: "https://spawnd.dev".into(),
            last_error: Some(crate::state::LastError {
                kind: "auth".into(),
                detail: "token_revoked".into(),
                at: "2026-08-25T00:00:00Z".into(),
            }),
            sessions: 1,
            tree: None,
            exe: exe.map(str::to_owned),
            release: None,
            worker_mismatch,
        }
    }

    #[test]
    fn auth_heartbeat_has_the_exact_status_remedy() {
        assert_eq!(
            connection_text(Some(&state("0.1.0", None, false))),
            "rejected by server (signed out) — fix with: spawnd login"
        );
    }

    /// The incident line: a running daemon whose worker no longer matches is
    /// named as such, with the remedy, whatever build this command is.
    #[test]
    fn the_pair_verdict_comes_from_the_daemon_not_the_command() {
        assert_eq!(pair_text(None), "not running");
        assert_eq!(
            pair_text(Some(&state(
                "0.1.0+gx.diagnostics",
                Some("/x/spawnd"),
                true
            ))),
            "MISMATCH — new sessions are refused; restart: spawnd reconnect"
        );
        // A live process with no recorded executable: Linux asks the kernel,
        // and this test process has no spawn-worker beside it.
        let verdict = pair_text(Some(&state("0.1.0", None, false)));
        assert!(
            verdict.starts_with("unknown") || verdict.starts_with("MISMATCH"),
            "{verdict}"
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
                version: "0.4.2+gabc.diagnostics".into(),
                update: "up to date".into(),
                host_key: Some("SHA256:Yr0kQmVd12345678".into()),
                browser_pins: 3,
                cli_version: "0.4.2+gabc".into(),
                running: Some(RunningBuild {
                    pid: 42,
                    version: "0.4.2+gabc.diagnostics".into(),
                    tree: Some("t".repeat(40)),
                    exe: Some(
                        "/Users/x/.local/lib/spawn/releases/0.4.2+gabc.diagnostics-1234abcd/spawnd"
                            .into(),
                    ),
                    release: Some("0.4.2+gabc.diagnostics-1234abcd".into()),
                    worker_mismatch: false,
                }),
                release: Some(SelectedRelease {
                    id: "0.4.2+gabc.diagnostics-1234abcd".into(),
                    version: "0.4.2+gabc.diagnostics".into(),
                    variant: "diagnostics".into(),
                    dir: "/Users/x/.local/lib/spawn/releases/0.4.2+gabc.diagnostics-1234abcd"
                        .into(),
                }),
                launch: "release store".into(),
                pair: "matches".into(),
            }],
        };
        let plain = format_plain(&output, 0);
        assert!(plain.starts_with("SPAWN D on mac-studio\n"));
        assert!(plain.contains("  connection   connected · 42 min · last error: none\n"));
        assert!(plain.contains("  service      running (launchd app.spawn.spawnd.3f9ac3e1)\n"));
        // The version line is the instance's daemon, and the release line
        // names what it is pointed at; the command's own build is one line
        // at the end, never mistaken for either.
        assert!(plain.contains("  version      0.4.2+gabc.diagnostics · up to date\n"));
        assert!(plain.contains(
            "  release      0.4.2+gabc.diagnostics-1234abcd (diagnostics) · /Users/x/.local/lib/spawn/releases/0.4.2+gabc.diagnostics-1234abcd\n"
        ));
        assert!(plain.contains("  pair         matches\n"));
        assert!(plain.contains("Other instances on this machine: none\n"));
        assert!(plain.ends_with(&format!(
            "This command: spawnd {}\n",
            crate::version::build_version()
        )));

        let json = serde_json::to_value(&output).unwrap();
        assert_eq!(json["host"], "mac-studio");
        assert_eq!(json["instances"][0]["sessions"], 2);
        assert_eq!(json["instances"][0]["service"]["running"], true);
        assert_eq!(json["instances"][0]["browser_pins"], 3);
        assert_eq!(json["instances"][0]["version"], "0.4.2+gabc.diagnostics");
        assert_eq!(json["instances"][0]["cli_version"], "0.4.2+gabc");
        assert_eq!(json["instances"][0]["running"]["worker_mismatch"], false);
        assert_eq!(json["instances"][0]["release"]["variant"], "diagnostics");
        assert_eq!(json["instances"][0]["launch"], "release store");
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
