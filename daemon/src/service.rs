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

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};

/// Short per-config-root suffix, e.g. `-3f9ac3e1`, so each instance gets its
/// own non-colliding unit/label. Derived from the canonical config root.
fn instance_tag(config_dir: &Path) -> String {
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
    Ok(dir)
}

fn current_bin() -> Result<PathBuf> {
    std::env::current_exe().context("resolving the running spawnd binary path")
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
         Environment=PATH={path}\n\
         ExecStart={bin} --config-dir {config_dir} --server {server} run\n\
         Restart=on-failure\n\
         RestartSec=3\n\
         KillMode=process\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n",
        name = instance_name(config_dir),
        path = service_path(),
        bin = bin.display(),
        config_dir = config_dir.display(),
        server = server,
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

fn xml_escape(value: &str) -> String {
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
         \t<dict><key>PATH</key><string>{path}</string></dict>\n\
         \t<key>RunAtLoad</key><true/>\n\
         \t<key>KeepAlive</key><true/>\n\
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

fn launchd_install(config_dir: &Path, server: &str) -> Result<()> {
    let bin = current_bin()?;
    let state = state_dir(&instance_tag(config_dir))?;
    let plist_path = launchd_plist_path(config_dir)?;
    std::fs::write(&plist_path, launchd_plist(config_dir, &bin, server, &state))
        .with_context(|| format!("writing {}", plist_path.display()))?;

    let uid = nix::unistd::Uid::effective().as_raw();
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
    let uid = nix::unistd::Uid::effective().as_raw();
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

/// Write + enable the background service for `config_dir` against `server`.
pub fn install(config_dir: &Path, server: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        return launchd_install(config_dir, server);
    }
    #[cfg(target_os = "linux")]
    {
        return systemd_install(config_dir, server);
    }
    #[allow(unreachable_code)]
    {
        let _ = (config_dir, server);
        bail!("no supported service manager on this platform");
    }
}

/// Stop + remove the background service for `config_dir`. Best-effort.
pub fn uninstall(config_dir: &Path) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        return launchd_uninstall(config_dir);
    }
    #[cfg(target_os = "linux")]
    {
        return systemd_uninstall(config_dir);
    }
    #[allow(unreachable_code)]
    {
        let _ = config_dir;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(unit.contains("ExecStart=/usr/bin/spawnd --config-dir /srv/spawn/alice --server https://spawnd.dev run"));
        assert!(unit.contains("KillMode=process")); // workers survive restarts
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
    }
}
