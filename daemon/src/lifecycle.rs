//! Local service/account recovery commands.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::cli::{LogoutArgs, ResetArgs};

pub async fn reconnect(server_cli: Option<String>, explicit_config: bool) -> Result<()> {
    for dir in selected_dirs(explicit_config)? {
        let _guard = ConfigDirGuard::set(&dir);
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

    let remove_host = args.remove_host
        || (!args.yes
            && crate::tui::prompt_choice(
                "REMOVE THE SERVER-SIDE HOST TOO?",
                &[
                    ("Keep the account entry", "wipe only this machine"),
                    (
                        "Remove it from the account",
                        "also releases this machine's claimed identity key",
                    ),
                ],
                0,
            ) == 1);

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

    let mut server_cleanup_failed = false;
    for dir in dirs {
        let _guard = ConfigDirGuard::set(&dir);
        if remove_host {
            match crate::creds::load() {
                Ok(stored) => {
                    if let (Some(token), Some(_host_id)) =
                        (stored.access_token.as_deref(), stored.host_id)
                    {
                        match crate::config::server_url_for_instance(
                            None,
                            stored.server_url.as_deref(),
                        ) {
                            Ok(server) => {
                                if let Err(error) =
                                    crate::possess::deregister_self(&server, token).await
                                {
                                    server_cleanup_failed = true;
                                    tracing::warn!(%error, "removing the server-side host during reset");
                                }
                            }
                            Err(error) => {
                                server_cleanup_failed = true;
                                tracing::warn!(%error, "resolving the server-side host during reset");
                            }
                        }
                    }
                }
                Err(error) => {
                    server_cleanup_failed = true;
                    tracing::warn!(%error, "loading the server-side host during reset");
                }
            }
        }
        let _ = crate::service::uninstall(&dir);
        crate::creds::reset_local_credentials()?;
        crate::service::purge_local_instance_data(&dir)?;
        if let Err(error) = std::fs::remove_dir_all(&dir) {
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(error).with_context(|| format!("removing {}", dir.display()));
            }
        }
    }
    if remove_host && !server_cleanup_failed {
        println!("spawn: This machine is clean, and its server-side host was removed.");
    } else if remove_host {
        println!("spawn: This machine is clean. SPAWN D could not remove every server-side host; an old entry may still appear in the app.");
    } else {
        println!("spawn: This machine is clean. Its account entry was kept on the server.");
    }
    println!("spawn: To set up again: spawnd possess.");
    Ok(())
}

fn selected_dirs(explicit_config: bool) -> Result<Vec<PathBuf>> {
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

fn instance_name(dir: &Path) -> String {
    crate::state::human_account_label(dir)
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
    fn instance_name_is_the_account_directory() {
        assert_eq!(
            instance_name(Path::new("/tmp/spawn/account-1")),
            "account-1"
        );
    }
}
