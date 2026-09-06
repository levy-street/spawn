//! Per-instance background service management.
//!
//! `possess` registers a host and then hands off to a supervised background
//! daemon; `exorcise` tears that down. Rather than reach back into the hosted
//! installer's shell, the daemon owns its own service lifecycle here: it writes
//! and enables a **systemd user unit** on Linux or a **LaunchAgent** on macOS
//! that runs `spawnd --config-dir <root> run`, and removes it again.
//!
//! Everything is keyed to the instance's config root, so multiple registrations
//! under one OS user (each its own `--config-dir`) get distinct, non-colliding
//! units — `spawn` / `spawn-<tag>` on systemd, `app.spawn.spawnd[.<tag>]` on
//! launchd — matching the per-root worker-dir isolation.
//!
//! Both platforms' generators/installers compile everywhere (so a change to the
//! launchd path is type-checked on Linux CI too), but only one set runs per
//! host — hence the module-scoped dead-code allowance.
#![allow(dead_code)]

mod control;
mod windows_run;
mod windows_task;

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};

/// Short per-config-root suffix, e.g. `-3f9ac3e1`, so each instance gets its
/// own non-colliding unit/label. Derived from the canonical config root.
pub(super) fn instance_tag(config_dir: &Path) -> String {
    let canonical = std::fs::canonicalize(config_dir).unwrap_or_else(|_| config_dir.to_path_buf());
    let digest = Sha256::digest(canonical.as_os_str().as_encoded_bytes());
    format!(
        "-{:02x}{:02x}{:02x}{:02x}",
        digest[0], digest[1], digest[2], digest[3]
    )
}

/// Human label for logs/messages: the tag without its leading dash.
pub fn instance_name(config_dir: &Path) -> String {
    instance_tag(config_dir).trim_start_matches('-').to_string()
}

fn state_dir(tag: &str) -> Result<PathBuf> {
    #[cfg(windows)]
    let base = dirs::data_local_dir()
        .context("cannot resolve the local application data directory")?
        .join("spawn")
        .join("state");
    #[cfg(not(windows))]
    let base = dirs::state_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join(".local").join("state")))
        .context("cannot resolve a state directory")?
        .join("spawn");
    let dir = if tag.is_empty() {
        base
    } else {
        base.join(tag.trim_start_matches('-'))
    };
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    #[cfg(windows)]
    control::protect_path(&dir)?;
    Ok(dir)
}

fn current_bin() -> Result<PathBuf> {
    std::env::current_exe().context("resolving the running spawnd binary path")
}

/// Local, non-roaming state for one account instance. Windows deliberately
/// keeps live PIDs, launch records, helpers, and endpoints out of `%APPDATA%`.
pub fn instance_state_path(config_dir: &Path) -> Result<PathBuf> {
    #[cfg(windows)]
    let base = dirs::data_local_dir()
        .context("cannot resolve the local application data directory")?
        .join("spawn")
        .join("state");
    #[cfg(not(windows))]
    let base = dirs::state_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join(".local").join("state")))
        .context("cannot resolve a state directory")?
        .join("spawn");
    Ok(base.join(instance_name(config_dir)))
}

pub fn instance_state_dir(config_dir: &Path) -> Result<PathBuf> {
    let dir = instance_state_path(config_dir)?;
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    #[cfg(windows)]
    control::protect_path(&dir)?;
    Ok(dir)
}

/// Per-instance daemon log directory. On Windows this is
/// `%LOCALAPPDATA%\\spawn\\logs\\<tag>`.
pub fn instance_log_path(config_dir: &Path) -> Result<PathBuf> {
    #[cfg(windows)]
    let base = dirs::data_local_dir()
        .context("cannot resolve the local application data directory")?
        .join("spawn")
        .join("logs");
    #[cfg(not(windows))]
    let base = state_dir("")?.join("logs");
    Ok(base.join(instance_name(config_dir)))
}

pub fn instance_log_dir(config_dir: &Path) -> Result<PathBuf> {
    let dir = instance_log_path(config_dir)?;
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    #[cfg(windows)]
    control::protect_path(&dir)?;
    Ok(dir)
}

/// Purge only this instance's non-roaming Windows state and logs. Ordinary
/// disconnect never calls this; exorcise/reset do so after manager/workers.
pub fn purge_local_instance_data(config_dir: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        for path in [
            instance_state_path(config_dir)?,
            instance_log_path(config_dir)?,
        ] {
            if let Err(error) = std::fs::remove_dir_all(&path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    return Err(error).with_context(|| format!("removing {}", path.display()));
                }
            }
        }
    }
    #[cfg(not(windows))]
    let _ = config_dir;
    Ok(())
}

/// A conservative PATH so agent CLIs the daemon launches remain resolvable when
/// the service starts with a minimal environment.
fn service_path() -> String {
    let home = dirs::home_dir()
        .map(|h| h.display().to_string())
        .unwrap_or_default();
    let mut entries = vec![
        format!("{home}/.local/bin"),
        format!("{home}/.cargo/bin"),
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/bin".to_string(),
        "/bin".to_string(),
        "/usr/sbin".to_string(),
        "/sbin".to_string(),
    ];
    entries.retain(|e| !e.starts_with("/.")); // drop empties when HOME is unknown
    entries.join(":")
}

// ---------------------------------------------------------------------------
// systemd (Linux)
// ---------------------------------------------------------------------------

fn systemd_unit_name(config_dir: &Path) -> String {
    format!("spawn{}.service", instance_tag(config_dir))
}

/// Quote a value for use inside a systemd unit.
///
/// A unit file is a config format, not a shell, and every one of its hazards
/// is silent. An unquoted `ExecStart` argument splits on whitespace, so a
/// server URL or a config path containing a space becomes two arguments. `%`
/// introduces a specifier systemd expands before anything sees it — `%h` is
/// the home directory, `%%` is how you write a literal percent. And a newline
/// simply ends the directive, so a value carrying one does not corrupt a
/// setting, it *adds* settings. The launchd plist and the Windows task XML
/// both escape their values already; this is systemd catching up with them.
fn systemd_quote(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('"');
    for character in value.chars() {
        match character {
            '"' | '\\' => {
                quoted.push('\\');
                quoted.push(character);
            }
            '%' => quoted.push_str("%%"),
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            '\t' => quoted.push_str("\\t"),
            _ => quoted.push(character),
        }
    }
    quoted.push('"');
    quoted
}

/// `Description=` is free text rather than an argument list, so it is not
/// quoted — but it still expands specifiers and still ends at a newline.
fn systemd_description(value: &str) -> String {
    value.replace('%', "%%").replace(['\n', '\r'], " ")
}

fn systemd_unit_contents(config_dir: &Path, bin: &Path, server: &str) -> String {
    // KillMode=process: the agent workers run in their own process groups and
    // must survive `systemctl restart` / upgrades (docs/SESSIOND.md).
    format!(
        "[Unit]\n\
         Description=spawnd ({name})\n\
         After=network-online.target\n\
         Wants=network-online.target\n\
         \n\
         [Service]\n\
         Environment={path}\n\
         Environment=SPAWN_DISABLE_KEYRING=1\n\
         ExecStart={bin} --config-dir {config_dir} --server {server} run\n\
         Restart=on-failure\n\
         RestartSec=3\n\
         KillMode=process\n\
         LimitNOFILE=65536:524288\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n",
        name = systemd_description(&instance_name(config_dir)),
        path = systemd_quote(&format!("PATH={}", service_path())),
        bin = systemd_quote(&bin.display().to_string()),
        config_dir = systemd_quote(&config_dir.display().to_string()),
        server = systemd_quote(server),
    )
}

fn systemd_unit_path(config_dir: &Path) -> Result<PathBuf> {
    let dir = dirs::config_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join(".config")))
        .context("cannot resolve the user config directory")?
        .join("systemd")
        .join("user");
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    Ok(dir.join(systemd_unit_name(config_dir)))
}

fn systemctl(args: &[&str]) -> Result<bool> {
    let status = Command::new("systemctl")
        .arg("--user")
        .args(args)
        .status()
        .context("running systemctl --user")?;
    Ok(status.success())
}

fn systemd_install(config_dir: &Path, server: &str) -> Result<()> {
    let bin = current_bin()?;
    let unit_path = systemd_unit_path(config_dir)?;
    let contents = systemd_unit_contents(config_dir, &bin, server);
    std::fs::write(&unit_path, contents)
        .with_context(|| format!("writing {}", unit_path.display()))?;

    // Best-effort so the service survives logout; harmless if already enabled.
    let _ = Command::new("loginctl").args(["enable-linger"]).status();
    systemctl(&["daemon-reload"])?;
    let unit = systemd_unit_name(config_dir);
    if !systemctl(&["enable", "--now", &unit])? {
        bail!("systemctl --user enable --now {unit} failed");
    }
    Ok(())
}

fn systemd_uninstall(config_dir: &Path) -> Result<()> {
    let unit = systemd_unit_name(config_dir);
    let _ = systemctl(&["disable", "--now", &unit]);
    if let Ok(path) = systemd_unit_path(config_dir) {
        let _ = std::fs::remove_file(&path);
    }
    let _ = systemctl(&["daemon-reload"]);
    Ok(())
}

// ---------------------------------------------------------------------------
// launchd (macOS)
// ---------------------------------------------------------------------------

fn launchd_label(config_dir: &Path) -> String {
    let tag = instance_tag(config_dir);
    if tag.is_empty() {
        "app.spawn.spawnd".to_string()
    } else {
        format!("app.spawn.spawnd.{}", tag.trim_start_matches('-'))
    }
}

pub(super) fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn launchd_plist(config_dir: &Path, bin: &Path, server: &str, state: &Path) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n\
         <dict>\n\
         \t<key>Label</key><string>{label}</string>\n\
         \t<key>ProgramArguments</key>\n\
         \t<array>\n\
         \t\t<string>{bin}</string>\n\
         \t\t<string>--config-dir</string>\n\
         \t\t<string>{config_dir}</string>\n\
         \t\t<string>--server</string>\n\
         \t\t<string>{server}</string>\n\
         \t\t<string>run</string>\n\
         \t</array>\n\
         \t<key>EnvironmentVariables</key>\n\
         \t<dict><key>PATH</key><string>{path}</string><key>SPAWN_DISABLE_KEYRING</key><string>1</string></dict>\n\
         \t<key>RunAtLoad</key><true/>\n\
         \t<key>KeepAlive</key><true/>\n\
         \t<key>SoftResourceLimits</key><dict><key>NumberOfFiles</key><integer>16384</integer></dict>\n\
         \t<key>StandardOutPath</key><string>{out}</string>\n\
         \t<key>StandardErrorPath</key><string>{err}</string>\n\
         </dict>\n\
         </plist>\n",
        label = xml_escape(&launchd_label(config_dir)),
        bin = xml_escape(&bin.display().to_string()),
        config_dir = xml_escape(&config_dir.display().to_string()),
        server = xml_escape(server),
        path = xml_escape(&service_path()),
        out = xml_escape(&state.join("spawnd.out.log").display().to_string()),
        err = xml_escape(&state.join("spawnd.err.log").display().to_string()),
    )
}

fn launchd_plist_path(config_dir: &Path) -> Result<PathBuf> {
    let dir = dirs::home_dir()
        .context("cannot resolve the home directory")?
        .join("Library")
        .join("LaunchAgents");
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    Ok(dir.join(format!("{}.plist", launchd_label(config_dir))))
}

#[cfg(unix)]
fn effective_user_id() -> u32 {
    nix::unistd::Uid::effective().as_raw()
}

#[cfg(not(unix))]
fn effective_user_id() -> u32 {
    unreachable!("launchd user IDs are unavailable off Unix")
}

fn launchd_install(config_dir: &Path, server: &str) -> Result<()> {
    let bin = current_bin()?;
    let state = state_dir(&instance_tag(config_dir))?;
    let plist_path = launchd_plist_path(config_dir)?;
    std::fs::write(&plist_path, launchd_plist(config_dir, &bin, server, &state))
        .with_context(|| format!("writing {}", plist_path.display()))?;

    let uid = effective_user_id();
    let domain = format!("gui/{uid}");
    let label = launchd_label(config_dir);
    let _ = Command::new("launchctl")
        .args(["bootout", &domain])
        .arg(&plist_path)
        .status();
    let bootstrapped = Command::new("launchctl")
        .args(["bootstrap", &domain])
        .arg(&plist_path)
        .status()
        .context("running launchctl bootstrap")?;
    if !bootstrapped.success() {
        // Older macOS: fall back to the legacy loader.
        let _ = Command::new("launchctl")
            .arg("load")
            .arg(&plist_path)
            .status();
    }
    let _ = Command::new("launchctl")
        .args(["kickstart", "-k", &format!("{domain}/{label}")])
        .status();
    Ok(())
}

fn launchd_uninstall(config_dir: &Path) -> Result<()> {
    let uid = effective_user_id();
    let domain = format!("gui/{uid}");
    if let Ok(path) = launchd_plist_path(config_dir) {
        let _ = Command::new("launchctl")
            .args(["bootout", &domain])
            .arg(&path)
            .status();
        let _ = std::fs::remove_file(&path);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// platform-neutral entry points
// ---------------------------------------------------------------------------

/// Whether service management is disabled (`SPAWND_NO_SERVICE=1`) — for tests
/// and for running `possess`/`exorcise` on a host without touching its service
/// manager. Mirrors `SPAWND_NO_CPU_SCOPES`.
fn service_disabled() -> bool {
    std::env::var_os("SPAWND_NO_SERVICE").is_some_and(|v| !v.is_empty())
}

/// The server the unit must name: the one this instance registered against.
///
/// `spawnd run` refuses to start when its `--server` origin differs from the
/// origin in the stored credentials. A unit written with any other value is
/// therefore a service that boots, exits 1, and is restarted for ever by
/// launchd or systemd — while the terminal has already said "possessed, daemon
/// running in the background" and the web app waits at Online for a machine
/// that can never connect. Silent, permanent, and indistinguishable from a
/// network problem.
///
/// The credentials are the only value `run` will accept, so they decide. The
/// caller's choice stands in only for an instance that has none yet.
///
/// Read from `config_dir` rather than through `creds::load`, which resolves
/// the *ambient* `SPAWN_CONFIG_DIR`: this must describe the dir whose unit is
/// being written, even when those two have drifted apart.
fn registered_server(config_dir: &Path, chosen: &str) -> String {
    let Ok(raw) = std::fs::read_to_string(config_dir.join("credentials.json")) else {
        return chosen.to_owned();
    };
    let stored = serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|record| {
            record
                .get("server_url")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        });
    let Some(stored) = stored.filter(|url| !url.is_empty()) else {
        return chosen.to_owned();
    };
    if !same_origin(&stored, chosen) {
        // Worth saying out loud: the operator asked for one server and gets a
        // unit pointing at another, which is right but surprising.
        crate::tui::log_line(&format!(
            "this instance is registered with {stored}; keeping the background daemon on it \
             rather than {chosen}. run `spawnd login --server {chosen}` to move it."
        ));
    }
    stored
}

/// Origin comparison in the same terms `run` uses to accept or refuse a unit.
fn same_origin(left: &str, right: &str) -> bool {
    match (
        crate::creds::canonical_server_origin(left),
        crate::creds::canonical_server_origin(right),
    ) {
        (Ok(left), Ok(right)) => left == right,
        // Unparseable either way: leave the decision to `run`, which will say
        // so precisely. Claiming a mismatch here would only add noise.
        _ => true,
    }
}

/// Write + enable the background service for `config_dir` against `server`.
///
/// The unit is always written for the origin `config_dir` is registered with —
/// see [`registered_server`] — so no caller can install a daemon that cannot
/// start.
pub fn install(config_dir: &Path, server: &str) -> Result<()> {
    if service_disabled() {
        return Ok(());
    }
    let server = &registered_server(config_dir, server);
    #[cfg(target_os = "macos")]
    {
        return launchd_install(config_dir, server);
    }
    #[cfg(target_os = "linux")]
    {
        return systemd_install(config_dir, server);
    }
    #[cfg(windows)]
    {
        return install_with_mode(config_dir, server, preferred_mode(config_dir));
    }
    #[allow(unreachable_code)]
    {
        let _ = (config_dir, server);
        bail!("no supported service manager on this platform");
    }
}

/// Stop + remove the background service for `config_dir`. Best-effort.
pub fn uninstall(config_dir: &Path) -> Result<()> {
    if service_disabled() {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        return launchd_uninstall(config_dir);
    }
    #[cfg(target_os = "linux")]
    {
        return systemd_uninstall(config_dir);
    }
    #[cfg(windows)]
    {
        // Remove both registrations. This also makes a mode switch recover
        // cleanly if a prior installation was interrupted between managers.
        let task = windows_task::uninstall(config_dir);
        let run = windows_run::uninstall(config_dir);
        task.and(run)?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    {
        let _ = config_dir;
        Ok(())
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ServiceStatus {
    pub installed: bool,
    pub running: bool,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manager: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout_log: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr_log: Option<String>,
}

fn service_log_paths(config_dir: &Path) -> (Option<String>, Option<String>) {
    let log = instance_log_path(config_dir)
        .ok()
        .map(|path| path.join("spawnd.log").display().to_string());
    (log.clone(), log)
}

/// Inspect the per-instance service without changing it.
pub fn status(config_dir: &Path) -> ServiceStatus {
    #[cfg(target_os = "macos")]
    {
        let label = launchd_label(config_dir);
        let installed = launchd_plist_path(config_dir).is_ok_and(|path| path.is_file());
        let uid = nix::unistd::Uid::effective().as_raw();
        let running = Command::new("launchctl")
            .args(["print", &format!("gui/{uid}/{label}")])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
        return ServiceStatus {
            installed,
            running,
            name: format!("launchd {label}"),
            manager: None,
            stdout_log: None,
            stderr_log: None,
        };
    }
    #[cfg(target_os = "linux")]
    {
        let name = systemd_unit_name(config_dir);
        let installed = systemd_unit_path(config_dir).is_ok_and(|path| path.is_file());
        let running = Command::new("systemctl")
            .args(["--user", "is-active", "--quiet", &name])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
        return ServiceStatus {
            installed,
            running,
            name: format!("systemd {name}"),
            manager: None,
            stdout_log: None,
            stderr_log: None,
        };
    }
    #[cfg(windows)]
    {
        let mode = preferred_mode(config_dir);
        let status = match mode {
            ServiceMode::Task => windows_task::status(config_dir),
            ServiceMode::Run => windows_run::status(config_dir),
        };
        return status;
    }
    #[allow(unreachable_code)]
    ServiceStatus {
        installed: false,
        running: false,
        name: "unsupported".into(),
        manager: None,
        stdout_log: None,
        stderr_log: None,
    }
}

pub fn user_linger_enabled() -> Option<bool> {
    // Each cfg block is the whole body on its platform, so neither needs a
    // `return`; clippy 1.97 flags one as needless.
    #[cfg(target_os = "linux")]
    {
        let user = std::env::var("USER").ok()?;
        let output = Command::new("loginctl")
            .args(["show-user", &user, "-p", "Linger", "--value"])
            .output()
            .ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim() == "yes")
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

/// Restart an installed service; if none exists, install it from the supplied
/// instance data.
pub fn reconnect(config_dir: &Path, server: &str) -> Result<()> {
    let current = status(config_dir);
    if !current.installed {
        return install(config_dir, server);
    }
    #[cfg(target_os = "macos")]
    {
        let uid = nix::unistd::Uid::effective().as_raw();
        let target = format!("gui/{uid}/{}", launchd_label(config_dir));
        let result = Command::new("launchctl")
            .args(["kickstart", "-k", &target])
            .status()
            .context("running launchctl kickstart")?;
        if !result.success() {
            bail!("launchctl kickstart failed")
        }
        return Ok(());
    }
    #[cfg(windows)]
    {
        return match preferred_mode(config_dir) {
            ServiceMode::Task => windows_task::reconnect(config_dir, server),
            ServiceMode::Run => windows_run::reconnect(config_dir, server),
        };
    }
    #[cfg(target_os = "linux")]
    {
        let name = systemd_unit_name(config_dir);
        if !systemctl(&["restart", &name])? {
            bail!("systemctl --user restart {name} failed")
        }
        return Ok(());
    }
    #[allow(unreachable_code)]
    install(config_dir, server)
}

/// Windows background manager selected per account instance. The preference
/// is persisted in the roaming config root so a later `possess`, `status`, or
/// `exorcise` makes the same choice without a rebuild.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServiceMode {
    Task,
    Run,
}

impl ServiceMode {
    pub fn label(self) -> &'static str {
        match self {
            Self::Task => "Task Scheduler",
            Self::Run => "Run watchdog",
        }
    }
}

impl std::str::FromStr for ServiceMode {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "task" => Ok(Self::Task),
            "run" | "watchdog" => Ok(Self::Run),
            _ => bail!("service mode must be `task` or `run`"),
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct ServicePreference {
    mode: ServiceMode,
}

fn preference_path(config_dir: &Path) -> PathBuf {
    config_dir.join("service-mode.json")
}

pub fn preferred_mode(config_dir: &Path) -> ServiceMode {
    std::fs::read(preference_path(config_dir))
        .ok()
        .and_then(|raw| serde_json::from_slice::<ServicePreference>(&raw).ok())
        .map_or(ServiceMode::Task, |preference| preference.mode)
}

pub fn set_preferred_mode(config_dir: &Path, mode: ServiceMode) -> Result<()> {
    std::fs::create_dir_all(config_dir)
        .with_context(|| format!("creating {}", config_dir.display()))?;
    let path = preference_path(config_dir);
    let temporary = path.with_extension(format!("json.tmp.{}", std::process::id()));
    let bytes = serde_json::to_vec(&ServicePreference { mode })?;
    let result = (|| -> Result<()> {
        std::fs::write(&temporary, bytes)
            .with_context(|| format!("writing {}", temporary.display()))?;
        std::fs::rename(&temporary, &path)
            .with_context(|| format!("installing {}", path.display()))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

/// Install a specifically selected Windows manager and persist the selection.
/// On Unix the caller-facing mode selector is intentionally unavailable.
pub fn install_with_mode(config_dir: &Path, server: &str, mode: ServiceMode) -> Result<()> {
    if service_disabled() {
        return Ok(());
    }
    #[cfg(windows)]
    {
        let server = registered_server(config_dir, server);
        set_preferred_mode(config_dir, mode)?;
        match mode {
            ServiceMode::Task => {
                windows_run::uninstall(config_dir)?;
                windows_task::install(config_dir, &server)
            }
            ServiceMode::Run => {
                windows_task::uninstall(config_dir)?;
                windows_run::install(config_dir, &server)
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (config_dir, server, mode);
        bail!("selectable service modes are only available on Windows")
    }
}

/// Whether the last task-start probe proved that Scheduler prevents workers
/// from escaping its job. `possess` uses this to offer the watchdog fallback.
pub fn needs_fallback_offer(config_dir: &Path) -> bool {
    preferred_mode(config_dir) == ServiceMode::Task
        && crate::state::read(config_dir)
            .ok()
            .flatten()
            .is_some_and(|state| state.task_breakaway_denied == Some(true))
}

/// Manager-specific drift reported by doctor without parsing localized tool
/// output. `None` means the selected registration matches its canonical data.
pub fn diagnostic(config_dir: &Path) -> Option<String> {
    #[cfg(windows)]
    {
        if needs_fallback_offer(config_dir) {
            return Some(
                "Task Scheduler denied worker breakaway; SPAWN D cannot preserve sessions across daemon restarts"
                    .into(),
            );
        }
        if preferred_mode(config_dir) == ServiceMode::Task
            && windows_task::status(config_dir).installed
            && crate::state::read(config_dir)
                .ok()
                .flatten()
                .and_then(|state| state.task_breakaway_denied)
                .is_none()
        {
            return Some(
                "Task Scheduler worker breakaway has not been confirmed by the startup probe"
                    .into(),
            );
        }
        match preferred_mode(config_dir) {
            ServiceMode::Task => windows_task::diagnostic(config_dir),
            ServiceMode::Run => windows_run::diagnostic(config_dir),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = config_dir;
        None
    }
}

/// Start the per-instance Windows control listener. Unix continues to use its
/// byte-identical SIGHUP transport and never creates this pipe.
pub fn start_control_listener(
    config_dir: &Path,
    reconnect: &'static tokio::sync::Notify,
    shutdown: &'static tokio::sync::Notify,
) -> Result<()> {
    control::start_listener(config_dir, reconnect, shutdown)
}

/// Open/rotate the daemon's own Windows service log when no console exists.
pub fn prepare_background_log(config_dir: &Path) -> Result<()> {
    windows_task::prepare_background_log(config_dir)
}

/// Probe Task Scheduler's job at task-root startup. `Some(false)` records a
/// successful breakaway; `Some(true)` records denial; `None` means this was
/// not a task launch or the probe was inconclusive.
pub fn probe_task_breakaway(config_dir: &Path) -> Option<bool> {
    windows_task::probe_breakaway(config_dir)
}

/// Internal Run-key watchdog entry point, dispatched by the Windows CLI mode.
pub async fn run_watchdog(instance: &str) -> Result<()> {
    windows_run::watchdog(instance).await
}

/// Resolve and open a watchdog instance log before tracing is initialized.
pub fn prepare_watchdog_log(instance: &str) -> Result<()> {
    windows_run::prepare_watchdog_log(instance)
}

/// Add SPAWN D's shared Local AppData bin directory to the current user's PATH.
pub fn ensure_user_path() -> Result<()> {
    windows_run::ensure_user_path()
}

/// Refresh this daemon process with the user's current Windows PATH additions.
pub fn refresh_user_path() -> Result<()> {
    windows_run::refresh_user_path()
}

/// Relaunch the selected manager after a Windows update helper has completed
/// its swap. The Run watchdog performs this itself; Scheduler needs `/Run`.
pub fn relaunch_after_update(config_dir: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        match preferred_mode(config_dir) {
            ServiceMode::Task => windows_task::run_registered(config_dir),
            ServiceMode::Run => windows_run::signal_update_ready(config_dir),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = config_dir;
        bail!("Windows update relaunch requested on a non-Windows host")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn systemd_unit_values_survive_spaces_percents_and_newlines() {
        let quoted = systemd_quote("/opt/spawn d/spawnd");
        assert_eq!(quoted, "\"/opt/spawn d/spawnd\"");
        // `%h` would otherwise expand to the home directory.
        assert_eq!(systemd_quote("100%h"), "\"100%%h\"");
        // A newline must stay inside the value instead of ending the directive.
        let injected = systemd_quote("https://x/\nExecStart=/bin/sh -c evil");
        assert!(!injected.contains('\n'), "{injected}");
        assert!(injected.contains("\\n"), "{injected}");
        assert_eq!(systemd_quote("a\"b\\c"), "\"a\\\"b\\\\c\"");
        assert!(!systemd_description("spawn\nExecStart=x").contains('\n'));
        assert_eq!(systemd_description("50%"), "50%%");
    }

    #[test]
    fn systemd_unit_contents_quotes_every_interpolated_value() {
        let unit = systemd_unit_contents(
            Path::new("/srv/spawn dir"),
            Path::new("/opt/bin/spawnd"),
            "https://example.test/\nExecStart=/bin/sh",
        );
        let directives = unit
            .lines()
            .filter(|line| line.starts_with("ExecStart="))
            .count();
        assert_eq!(directives, 1, "a value started a second directive: {unit}");
        assert!(unit.contains("\"/srv/spawn dir\""), "{unit}");
    }

    #[test]
    fn distinct_roots_get_distinct_unit_names_and_labels() {
        let alice = Path::new("/srv/spawn/alice");
        let bob = Path::new("/srv/spawn/bob");
        assert_ne!(systemd_unit_name(alice), systemd_unit_name(bob));
        assert_ne!(launchd_label(alice), launchd_label(bob));
        assert!(systemd_unit_name(alice).starts_with("spawn-"));
        assert!(systemd_unit_name(alice).ends_with(".service"));
        assert!(launchd_label(alice).starts_with("app.spawn.spawnd."));
    }

    #[test]
    fn systemd_unit_embeds_config_dir_and_survives_restart() {
        let dir = Path::new("/srv/spawn/alice");
        let unit = systemd_unit_contents(dir, Path::new("/usr/bin/spawnd"), "https://spawnd.dev");
        assert!(unit.contains(
            "ExecStart=\"/usr/bin/spawnd\" --config-dir \"/srv/spawn/alice\" --server \"https://spawnd.dev\" run"
        ));
        assert!(unit.contains("KillMode=process")); // workers survive restarts

        // A user service starts at 1024 open files; a laptop of sessions needs
        // more than that before the range of ICE ports runs out (#80). The hard
        // half stays high: every shell in a SPAWN D terminal inherits it, and
        // `ulimit -n` must still work there as it does in a native terminal.
        assert!(unit.contains("LimitNOFILE=65536:524288"));
        assert!(unit.contains("WantedBy=default.target"));
    }

    #[test]
    fn launchd_plist_is_escaped_and_well_formed() {
        let dir = Path::new("/srv/spawn/alice & co");
        let plist = launchd_plist(
            dir,
            Path::new("/usr/bin/spawnd"),
            "https://spawnd.dev",
            Path::new("/state"),
        );
        assert!(plist.contains("<string>--config-dir</string>"));
        assert!(plist.contains("&amp;")); // the '&' in the path is escaped
        assert!(!plist.contains(" & ")); // no raw ampersand leaked
        assert!(plist.contains("<key>KeepAlive</key><true/>"));
        // launchd starts an agent at 256 open files (#80). Only the soft limit:
        // a hard limit would follow every shell a terminal spawns and stop
        // `ulimit -n` there.
        assert!(plist.contains(
            "<key>SoftResourceLimits</key><dict><key>NumberOfFiles</key><integer>16384</integer></dict>"
        ));
        assert!(!plist.contains("HardResourceLimits"));
    }

    fn instance_with_server(server: Option<&str>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("a temp dir");
        if let Some(server) = server {
            std::fs::write(
                dir.path().join("credentials.json"),
                format!(r#"{{"server_url":"{server}","host_id":"h"}}"#),
            )
            .expect("writing credentials");
        }
        dir
    }

    /// The regression that made a possessed machine never come online: the
    /// unit named the server the operator picked, the credentials named the
    /// one the ceremony actually ran against, and `run` exited 1 on every
    /// restart for ever.
    #[test]
    fn the_unit_follows_the_credentials_not_the_caller() {
        let dir = instance_with_server(Some("http://localhost:3000/"));
        assert_eq!(
            registered_server(dir.path(), "https://spawnd.dev"),
            "http://localhost:3000/"
        );
    }

    #[test]
    fn an_agreeing_caller_is_left_alone_and_a_fresh_instance_keeps_its_choice() {
        let same = instance_with_server(Some("https://spawnd.dev/"));
        assert!(same_origin(
            &registered_server(same.path(), "https://spawnd.dev"),
            "https://spawnd.dev"
        ));
        // No credentials yet: nothing to contradict the caller.
        let fresh = instance_with_server(None);
        assert_eq!(
            registered_server(fresh.path(), "https://spawnd.dev"),
            "https://spawnd.dev"
        );
    }

    #[test]
    fn unreadable_or_serverless_credentials_fall_back_to_the_caller() {
        let dir = tempfile::tempdir().expect("a temp dir");
        std::fs::write(dir.path().join("credentials.json"), "{not json").expect("writing");
        assert_eq!(
            registered_server(dir.path(), "https://spawnd.dev"),
            "https://spawnd.dev"
        );
        let empty = instance_with_server(Some(""));
        assert_eq!(
            registered_server(empty.path(), "https://spawnd.dev"),
            "https://spawnd.dev"
        );
    }

    /// Origin, not string: a stored URL differing only in trailing slash or
    /// default port must not print a "keeping it on the other server" notice.
    #[test]
    fn origin_comparison_ignores_path_and_trailing_slash() {
        assert!(same_origin("https://spawnd.dev", "https://spawnd.dev/"));
        assert!(!same_origin("http://localhost:3000/", "https://spawnd.dev"));
        // Unparseable inputs defer to `run` rather than guessing.
        assert!(same_origin("not a url", "https://spawnd.dev"));
    }

    #[test]
    fn service_mode_preference_defaults_to_task_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(preferred_mode(dir.path()), ServiceMode::Task);
        set_preferred_mode(dir.path(), ServiceMode::Run).unwrap();
        assert_eq!(preferred_mode(dir.path()), ServiceMode::Run);
        assert_eq!("watchdog".parse::<ServiceMode>().unwrap(), ServiceMode::Run);
        assert!("service".parse::<ServiceMode>().is_err());
    }
}
