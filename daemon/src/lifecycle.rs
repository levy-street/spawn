//! Local service/account recovery commands.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::cli::{LogoutArgs, ResetArgs};

pub async fn reconnect(server_cli: Option<String>, explicit_config: bool) -> Result<()> {
    for dir in selected_dirs(explicit_config)? {
        let _guard = ConfigDirGuard::set(&dir);
        #[cfg(unix)]
        {
            if let Some(state) = crate::state::read(&dir).ok().flatten() {
                if crate::state::pid_is_alive(state.pid) && send_sighup(state.pid) {
                    println!("spawn: reconnect requested for {}.", instance_name(&dir));
                    continue;
                }
            }
        }
        let stored = crate::creds::load().context("loading stored credentials")?;
        let server = crate::config::server_url_for_instance(
            server_cli.clone(),
            stored.server_url.as_deref(),
        )?;
        crate::service::reconnect(&dir, server.as_str())
            .map_err(|error| crate::login::background_service_error(&error))?;
        println!(
            "spawn: background daemon restarted for {}.",
            instance_name(&dir)
        );
    }
    Ok(())
}

pub fn disconnect(explicit_config: bool) -> Result<()> {
    for dir in selected_dirs(explicit_config)? {
        let sessions = crate::state::read(&dir)
            .ok()
            .flatten()
            .map_or(0, |state| state.sessions);
        crate::service::uninstall(&dir)?;
        println!(
            "spawn: background daemon stopped for {}.",
            instance_name(&dir)
        );
        println!("spawn: credentials and identity stay on this machine.");
        println!(
            "spawn: {sessions} running session(s) stay alive but are unreachable until reconnect."
        );
        println!("spawn: come back with: spawnd reconnect");
    }
    Ok(())
}

pub async fn logout(args: LogoutArgs, explicit_config: bool) -> Result<()> {
    for dir in selected_dirs(explicit_config)? {
        let _guard = ConfigDirGuard::set(&dir);
        crate::service::uninstall(&dir)?;
        if args.wipe_identity {
            crate::creds::logout().await?;
            println!("spawn: signed out and removed this machine's local identity.");
        } else {
            crate::creds::logout_keep_identity()?;
            println!("spawn: signed out. This machine's identity and approvals were kept.");
            println!("spawn: sign in again with: spawnd login");
        }
    }
    Ok(())
}

pub async fn reset(args: ResetArgs, explicit_config: bool) -> Result<()> {
    let dirs = selected_dirs(explicit_config)?;
    if !args.yes
        && !crate::tui::confirm(
            "Reset local SPAWN D state? Identity, sign-in, approvals, and service files will be removed.",
        )?
    {
        println!("spawn: reset cancelled.");
        return Ok(());
    }

    let mut workers = Vec::new();
    for dir in &dirs {
        let _guard = ConfigDirGuard::set(dir);
        workers.extend(
            crate::worker_backend::discover_ids()
                .into_iter()
                .map(|id| (dir.clone(), id)),
        );
    }
    if !workers.is_empty()
        && !args.yes
        && !crate::tui::confirm(&format!(
            "Terminate {} running session worker(s)?",
            workers.len()
        ))?
    {
        println!("spawn: reset cancelled; nothing was removed.");
        return Ok(());
    }

    let mut terminated = 0usize;
    for (dir, id) in workers {
        let _guard = ConfigDirGuard::set(&dir);
        if let Ok(Some(launched)) = crate::worker_backend::adopt(id).await {
            let lifecycle = launched.handle.lifecycle();
            let _ = lifecycle
                .shutdown(spawnd::sessiond::wire::LifecycleSignal::Term)
                .await;
            let mut gone = false;
            for _ in 0..15 {
                if !crate::worker_backend::socket_exists(id) {
                    gone = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            if !gone {
                let _ = lifecycle
                    .shutdown(spawnd::sessiond::wire::LifecycleSignal::Kill)
                    .await;
            }
            terminated += 1;
        }
    }
    println!("spawn: terminated {terminated} session worker(s).");

    for dir in dirs {
        let _guard = ConfigDirGuard::set(&dir);
        let _ = crate::service::uninstall(&dir);
        crate::possess::forget_release_selection(&dir);
        crate::creds::reset_local_credentials()?;
        crate::service::purge_local_instance_data(&dir)?;
        if let Err(error) = std::fs::remove_dir_all(&dir) {
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(error).with_context(|| format!("removing {}", dir.display()));
            }
        }
    }
    println!("spawn: This machine is clean. The old entry may still show under Hosts on the web — remove it there.");
    println!("spawn: To set up again: spawnd possess.");
    Ok(())
}

/// The instances a command acts on: the explicit one, else every account
/// instance under the default base, else the base itself (a legacy single
/// instance). Shared by reconnect, disconnect, logout, reset, and update.
pub(crate) fn selected_dirs(explicit_config: bool) -> Result<Vec<PathBuf>> {
    if explicit_config {
        return Ok(vec![crate::config::config_dir()?]);
    }
    let base = crate::possess::default_instance_base()?;
    let dirs = crate::possess::account_dirs_with_creds(&base)?;
    if dirs.is_empty() {
        Ok(vec![crate::config::config_dir()?])
    } else {
        Ok(dirs)
    }
}

pub(crate) fn instance_name(dir: &Path) -> String {
    dir.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "default".into())
}

#[cfg(unix)]
fn send_sighup(pid: u32) -> bool {
    i32::try_from(pid).is_ok_and(|pid| {
        nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(pid),
            Some(nix::sys::signal::Signal::SIGHUP),
        )
        .is_ok()
    })
}

/// Point `SPAWN_CONFIG_DIR` at one instance for the guard's lifetime, so the
/// ambient-config helpers (`creds::load`, `config::config_dir`) act on it.
pub(crate) struct ConfigDirGuard(Option<std::ffi::OsString>);

impl ConfigDirGuard {
    pub(crate) fn set(dir: &Path) -> Self {
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
    fn instance_name_is_the_account_directory() {
        assert_eq!(
            instance_name(Path::new("/tmp/spawn/account-1")),
            "account-1"
        );
    }
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn support_cleanup_failures_preserve_real_logout_and_reset_commands() {
        crate::support::tests::bounded(async {
            for action in [
                "keep",
                "wipe",
                "reset",
                "keep-error",
                "wipe-error",
                "reset-error",
                "status",
            ] {
                let tmp = crate::support_log::capture::private_tempdir();
                let output = tokio::process::Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "lifecycle::tests::support_cleanup_command_child",
                        "--nocapture",
                    ])
                    .env("SPAWN_TEST_SUPPORT_CLEANUP", action)
                    .env("SPAWN_TEST_TEMP_ROOT", tmp.path())
                    .env("SPAWN_CONFIG_DIR", tmp.path().join("config"))
                    .env("SPAWN_INSTALL_ROOT", tmp.path().join("install"))
                    .env("SPAWND_WORKER_DIR", tmp.path().join("workers"))
                    .env("XDG_RUNTIME_DIR", tmp.path().join("runtime"))
                    .env("XDG_CONFIG_HOME", tmp.path().join("settings"))
                    .env("XDG_STATE_HOME", tmp.path().join("state"))
                    .env("LOCALAPPDATA", tmp.path().join("local"))
                    .env("SPAWND_NO_SERVICE", "1")
                    .env("SPAWN_DISABLE_KEYRING", "1")
                    .kill_on_drop(true)
                    .output()
                    .await
                    .unwrap();
                assert!(
                    output.status.success(),
                    "{}",
                    String::from_utf8_lossy(&output.stderr)
                );
                if action == "status" {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    assert!(stdout.contains("sharing      off"));
                    assert!(stdout.contains("kept on this machine"));
                    assert!(!stdout.contains("collector unavailable"));
                    continue;
                }
                assert!(String::from_utf8_lossy(&output.stderr)
                    .contains("support sharing cleanup failed"));
                let stdout = String::from_utf8_lossy(&output.stdout);
                if !action.ends_with("error") {
                    assert!(stdout.contains(match action {
                        "keep" => "signed out. This machine's identity and approvals were kept.",
                        "wipe" => "signed out and removed this machine's local identity.",
                        _ => "This machine is clean.",
                    }));
                } else {
                    assert!(
                        !stdout.contains("signed out.")
                            && !stdout.contains("This machine is clean.")
                    );
                }
            }
        })
        .await;
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn support_cleanup_command_child() {
        let Ok(action) = std::env::var("SPAWN_TEST_SUPPORT_CLEANUP") else {
            return;
        };
        // This child owns its entire process environment. The real command and
        // complete-file credential paths run; native keyring calls use its mock
        // provider, and the existing service-disable flag prevents OS effects.
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        let config = crate::config::config_path().unwrap();
        let root =
            PathBuf::from(std::env::var_os("SPAWN_TEST_TEMP_ROOT").expect("isolated test root"));
        // Resolve exactly the helpers the real commands use, before invoking
        // any command. On other platforms the tests are disabled: XDG cannot
        // redirect native state/log locations there.
        for path in [
            config.clone(),
            config.join("credentials.json"),
            dirs::config_dir().unwrap(),
            PathBuf::from(std::env::var_os("SPAWND_WORKER_DIR").expect("isolated worker path")),
            crate::service::instance_state_path(&config).unwrap(),
            crate::service::instance_log_path(&config).unwrap(),
            crate::support_log::support_dir(&config).unwrap(),
            crate::install::layout_for_instance(&config)
                .unwrap()
                .root()
                .to_owned(),
        ] {
            assert!(
                path.starts_with(&root) && path != root,
                "command path escapes test root"
            );
        }
        if action == "status" {
            let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
                .await
                .unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            drop(listener); // only loopback can be contacted, and it refuses at once
            crate::status::run(
                Some(origin.clone()),
                crate::cli::StatusArgs { json: false },
                true,
                0,
            )
            .await
            .unwrap();
            assert_eq!(
                std::fs::read_dir(&root).unwrap().count(),
                0,
                "status created a path"
            );
            crate::platform::create_private_dir_all(&config).unwrap();
            spawnd::secret_file::SecretFile::new("test", ".test.", 4096)
                .write(&config.join("credentials.json"), b"{}")
                .unwrap();
            crate::status::run(
                Some(origin),
                crate::cli::StatusArgs { json: false },
                true,
                0,
            )
            .await
            .unwrap();
            assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
            assert_eq!(
                std::fs::read_dir(&config).unwrap().count(),
                1,
                "status created a file or lock"
            );
            return;
        }
        crate::platform::create_private_dir_all(&config).unwrap();
        let mut record = crate::creds::StoredCreds::default();
        let revision = crate::creds::credential_revision(&record).unwrap();
        record.access_token = Some("test-token".into());
        record.host_private_key_seed = Some(base64::Engine::encode(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
            [5; 32],
        ));
        crate::creds::save(&mut record, &revision).unwrap();
        let identity = crate::creds::host_identity(&record).unwrap();
        std::fs::write(config.join("support-log-consent.json"), b"{}").unwrap();
        std::fs::create_dir(config.join("support-log-consent.lock")).unwrap();
        let credential_error = action.ends_with("error");
        let credential_path = crate::config::credentials_path().unwrap();
        if credential_error {
            std::fs::remove_file(&credential_path).unwrap();
            std::fs::create_dir(&credential_path).unwrap();
        }
        let result = if action.starts_with("reset") {
            assert!(crate::worker_backend::worker_dir()
                .unwrap()
                .starts_with(&root));
            reset(ResetArgs { yes: true }, true).await
        } else {
            logout(
                LogoutArgs {
                    wipe_identity: action.starts_with("wipe"),
                },
                true,
            )
            .await
        };
        assert_eq!(result.is_err(), credential_error);
        if credential_error {
            // Master stops on an ordinary credential error, preserving the
            // directory and subsequent cleanup steps for explicit recovery.
            assert!(config.exists());
            assert!(credential_path.is_dir());
        } else if action == "keep" {
            let stored = crate::creds::load().unwrap();
            assert!(stored.access_token.is_none());
            assert_eq!(
                crate::creds::host_identity(&stored)
                    .unwrap()
                    .map(|v| v.public_key),
                identity.map(|v| v.public_key)
            );
        } else if action == "wipe" {
            assert!(!credential_path.exists());
        } else {
            assert!(!config.exists());
        }
    }
}
