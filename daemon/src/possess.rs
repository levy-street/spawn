//! `spawnd possess` / `spawnd exorcise` — one-command onboarding and teardown.
//!
//! `possess` is a single browser approval, at most. With no `--config-dir` it
//! derives a per-account instance dir `<base>/<account_id>` from the login:
//!   - exactly one existing registration → resume it silently, no auth;
//!   - otherwise → one auth flow (staged), then either promote the staged
//!     registration to `<base>/<account_id>` (new) or, if that account is
//!     already set up, drop the just-created duplicate host via
//!     `DELETE /api/hosts/self` and adopt the existing one.
//!
//! An explicit `--config-dir` bypasses derivation and targets that dir exactly.
//!
//! Both commands force the file credential store so an instance dir can be
//! relocated and enumerated without a keyring dependency (headless hosts have
//! none anyway; macOS already defaults it off).

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use reqwest::StatusCode;
use url::Url;

use crate::cli::{ExorciseArgs, LoginArgs, PossessArgs};
use crate::{config, creds, login, service};

pub async fn possess(server_cli: Option<String>, args: PossessArgs) -> Result<()> {
    force_file_store();
    let server = config::server_url(server_cli.clone())?;

    // Explicit --config-dir → that dir is the instance, no per-account derivation.
    if explicit_config_dir() {
        return possess_dir(&server, server_cli, args, &config::config_dir()?).await;
    }

    let base = default_base()?;
    // Silent resume: exactly one existing per-account registration.
    let existing = account_dirs_with_creds(&base)?;
    if existing.len() == 1 {
        let dir = &existing[0];
        service::install(dir, server.as_str()).context("starting the background service")?;
        println!(
            "spawn: already possessed ({}); daemon running in the background.",
            instance_account(dir)
        );
        return Ok(());
    }

    // One auth flow, staged, then promoted to <base>/<account_id>.
    let staging = base.join(".possess-staging");
    let _ = std::fs::remove_dir_all(&staging);
    std::env::set_var("SPAWN_CONFIG_DIR", &staging);

    let outcome = login::run(
        server_cli.clone(),
        LoginArgs {
            host_name: args.host_name,
            no_run: true,
            no_browser: args.no_browser,
        },
    )
    .await
    .context("registering this host")?;
    let account = sanitize_account(
        outcome
            .account_id
            .as_deref()
            .context("the server did not return an account id (it may be out of date)")?,
    );
    let final_dir = base.join(&account);

    if final_dir.join("credentials.json").exists() {
        // Account already registered here → drop the duplicate we just made.
        if let Ok(token) = staging_token() {
            if let Err(error) = deregister_self(&server, &token).await {
                tracing::warn!(%error, "removing the duplicate host registration");
            }
        }
        let _ = std::fs::remove_dir_all(&staging);
    } else {
        std::fs::create_dir_all(&base).ok();
        std::fs::rename(&staging, &final_dir).with_context(|| {
            format!(
                "promoting the staged registration to {}",
                final_dir.display()
            )
        })?;
    }

    std::env::set_var("SPAWN_CONFIG_DIR", &final_dir);
    service::install(&final_dir, server.as_str()).context("starting the background service")?;
    println!("spawn: possessed as {account}. daemon running in the background.");
    Ok(())
}

async fn possess_dir(
    server: &Url,
    server_cli: Option<String>,
    args: PossessArgs,
    dir: &Path,
) -> Result<()> {
    if creds::load().map(|c| c.is_logged_in()).unwrap_or(false) {
        println!("spawn: already possessed; ensuring the background daemon is running.");
    } else {
        login::run(
            server_cli,
            LoginArgs {
                host_name: args.host_name,
                no_run: true,
                no_browser: args.no_browser,
            },
        )
        .await
        .context("registering this host")?;
    }
    service::install(dir, server.as_str()).context("starting the background service")?;
    println!(
        "spawn: possessed. daemon running in the background ({}).",
        service::instance_name(dir)
    );
    Ok(())
}

pub async fn exorcise(server_cli: Option<String>, args: ExorciseArgs) -> Result<()> {
    force_file_store();
    let server = config::server_url(server_cli.clone())?;

    if args.all {
        let base = default_base()?;
        let mut removed = 0;
        for dir in account_dirs_with_creds(&base)? {
            exorcise_one(&server, &dir).await;
            removed += 1;
        }
        println!("spawn: exorcised {removed} instance(s).");
        return Ok(());
    }

    let dir = if explicit_config_dir() {
        config::config_dir()?
    } else {
        let base = default_base()?;
        let mut existing = account_dirs_with_creds(&base)?;
        match existing.len() {
            0 => config::config_dir()?, // legacy single instance in the base
            1 => existing.pop().unwrap(),
            _ => bail!("multiple instances on this host; pass --config-dir <dir> or --all"),
        }
    };
    exorcise_one(&server, &dir).await;
    println!("spawn: exorcised.");
    Ok(())
}

async fn exorcise_one(server: &Url, dir: &Path) {
    std::env::set_var("SPAWN_CONFIG_DIR", dir);
    if let Ok(creds) = creds::load() {
        if let Some(token) = creds.access_token.as_deref() {
            if let Err(error) = deregister_self(server, token).await {
                tracing::warn!(%error, dir = %dir.display(), "deregistering host");
            }
        }
    }
    if let Err(error) = service::uninstall(dir) {
        tracing::warn!(%error, "removing the background service");
    }
    let _ = creds::logout().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// A daemon revokes its own host registration. 401/404 are treated as success
/// (the registration is already gone).
async fn deregister_self(server: &Url, token: &str) -> Result<()> {
    let url = config::api_url(server, "/api/hosts/self")?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;
    let status = client
        .delete(url.as_str())
        .bearer_auth(token)
        .send()
        .await
        .context("DELETE /api/hosts/self")?
        .status();
    if status.is_success() || status == StatusCode::NOT_FOUND || status == StatusCode::UNAUTHORIZED
    {
        Ok(())
    } else {
        bail!("host deregister failed: HTTP {status}")
    }
}

fn force_file_store() {
    if std::env::var_os("SPAWN_DISABLE_KEYRING").is_none() {
        std::env::set_var("SPAWN_DISABLE_KEYRING", "1");
    }
}

fn explicit_config_dir() -> bool {
    std::env::var_os("SPAWN_CONFIG_DIR")
        .filter(|v| !v.is_empty())
        .is_some()
}

fn default_base() -> Result<PathBuf> {
    Ok(dirs::config_dir()
        .context("cannot resolve the user config directory")?
        .join("spawn"))
}

/// Immediate subdirectories of `base` that hold a `credentials.json` — i.e. the
/// per-account instances. Hidden dirs (the staging dir) are skipped.
fn account_dirs_with_creds(base: &Path) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    let Ok(read) = std::fs::read_dir(base) else {
        return Ok(out);
    };
    for entry in read.flatten() {
        let path = entry.path();
        if !path.is_dir() || entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        if path.join("credentials.json").is_file() {
            out.push(path);
        }
    }
    out.sort();
    Ok(out)
}

fn staging_token() -> Result<String> {
    // SPAWN_CONFIG_DIR points at the staging dir here. Clone rather than move
    // the field out of StoredCreds (it implements Drop for zeroization).
    let creds = creds::load()?;
    creds
        .access_token
        .clone()
        .context("staged login has no access token")
}

fn instance_account(dir: &Path) -> String {
    dir.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Keep an account id safe as a directory component. Server account ids are
/// UUID-like, but never trust that for a path.
fn sanitize_account(account: &str) -> String {
    let cleaned: String = account
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches('_').to_string();
    if cleaned.is_empty() {
        "account".to_string()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_account_keeps_uuids_and_neutralizes_paths() {
        assert_eq!(
            sanitize_account("9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f"),
            "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f"
        );
        assert_eq!(sanitize_account("../../etc/passwd"), "etc_passwd");
        assert_eq!(sanitize_account("///"), "account");
    }

    #[test]
    fn account_dirs_lists_only_registered_subdirs() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path();
        let acct = base.join("acct-1");
        std::fs::create_dir_all(&acct).unwrap();
        std::fs::write(acct.join("credentials.json"), b"{}").unwrap();
        std::fs::create_dir_all(base.join("empty")).unwrap(); // no creds → skipped
        std::fs::create_dir_all(base.join(".possess-staging")).unwrap(); // hidden → skipped
        std::fs::write(
            base.join(".possess-staging").join("credentials.json"),
            b"{}",
        )
        .unwrap();

        let found = account_dirs_with_creds(base).unwrap();
        assert_eq!(found, vec![acct]);
    }
}
