//! `spawnd possess` / `spawnd exorcise` — one-command onboarding and teardown.
//!
//! `possess` is idempotent: it runs the login flow only if this instance isn't
//! already registered, then installs a supervised background service and
//! detaches. `exorcise` stops and removes the instance. Both operate on the
//! config root selected by `--config-dir` (default: the platform config dir).
//!
//! Not yet wired (tracked): deriving the per-account config dir from the login
//! response — that needs the server to return `account_id` on poll success, at
//! which point bare `spawnd possess` lands each spawn user in
//! `<base>/<account_id>` automatically. `exorcise --all` and its auth gate ride
//! the same follow-up.

use anyhow::{Context, Result};

use crate::cli::{ExorciseArgs, LoginArgs, PossessArgs};
use crate::{config, creds, login, service};

pub async fn possess(server_cli: Option<String>, args: PossessArgs) -> Result<()> {
    let server = config::server_url(server_cli.clone())?;
    let config_dir = config::config_dir().context("resolving the config directory")?;

    let already = creds::load()
        .context("loading stored credentials")?
        .is_logged_in();
    if already {
        println!("spawn: host already possessed; ensuring the background daemon is running.");
    } else {
        login::run(
            server_cli.clone(),
            LoginArgs {
                host_name: args.host_name,
                no_run: true,
            },
        )
        .await
        .context("registering this host")?;
    }

    service::install(&config_dir, server.as_str()).context("installing the background service")?;
    println!(
        "spawn: possessed. the daemon is running in the background (instance {}).",
        service::instance_name(&config_dir)
    );
    println!("spawn: stop it any time with `spawnd exorcise`.");
    Ok(())
}

pub async fn exorcise(_server_cli: Option<String>, args: ExorciseArgs) -> Result<()> {
    let config_dir = config::config_dir().context("resolving the config directory")?;
    if args.all {
        // TODO(possess follow-up): enumerate and remove every instance on the host.
        println!("spawn: note: --all is not implemented yet; removing the selected instance only.");
    }

    // Best-effort service teardown before wiping creds, so the supervisor can't
    // relaunch against a half-removed record.
    if let Err(error) = service::uninstall(&config_dir) {
        tracing::warn!(%error, "removing the background service");
    }
    creds::logout().await.context("wiping stored credentials")?;
    println!(
        "spawn: exorcised. stopped the background daemon and wiped credentials (instance {}).",
        service::instance_name(&config_dir)
    );
    Ok(())
}
