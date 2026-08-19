//! Clap derive structs for the `spawnd` CLI.

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(name = "spawnd", version, about = "spawn daemon")]
pub struct Cli {
    /// Override the spawn server base URL (default: env SPAWN_SERVER_URL or
    /// https://localhost:8000).
    #[arg(long, global = true, env = "SPAWN_SERVER_URL")]
    pub server: Option<String>,

    /// Root directory for this instance's credentials and state (default: env
    /// SPAWN_CONFIG_DIR or the platform config dir). Give each spawn user or
    /// registration its own root to run fully isolated daemons side by side on
    /// one host.
    #[arg(long, global = true, value_name = "PATH")]
    pub config_dir: Option<PathBuf>,

    /// Increase log verbosity (-v, -vv).
    #[arg(short, long, global = true, action = clap::ArgAction::Count)]
    pub verbose: u8,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Register this host and run it in the background (idempotent). Runs the
    /// login flow if needed, installs a supervised service, then detaches;
    /// re-running an already-registered host just resumes it.
    Possess(PossessArgs),
    /// Authenticate, then stop and remove this host's spawn daemon.
    Exorcise(ExorciseArgs),
    /// Interactive device-code flow; stores a long-lived daemon token.
    Login(LoginArgs),
    /// Foreground; connects WSS and services frames.
    Run(RunArgs),
    /// Wipe the complete stored credential record, including browser pins.
    Logout,
    /// Print credential state and redacted host/browser fingerprints.
    Status,
}

#[derive(Debug, Args)]
pub struct PossessArgs {
    /// Override the host name reported to the server (defaults to system
    /// hostname).
    #[arg(long)]
    pub host_name: Option<String>,

    /// Print the approval link instead of opening a browser. Also honored as
    /// SPAWN_NO_BROWSER=1, which is the only way through `curl … | sh`.
    /// The env var is read in login.rs with shell semantics rather than by
    /// clap, which would demand a literal `true`/`false`.
    #[arg(long)]
    pub no_browser: bool,
}

#[derive(Debug, Args)]
pub struct ExorciseArgs {
    /// Remove every spawn instance on this host, not just the selected one.
    #[arg(long)]
    pub all: bool,
}

#[derive(Debug, Args)]
pub struct LoginArgs {
    /// Override the host name reported to the server (defaults to system
    /// hostname).
    #[arg(long)]
    pub host_name: Option<String>,

    /// Just store the token; don't transition to `run` after login succeeds.
    #[arg(long)]
    pub no_run: bool,

    /// Print the approval link instead of opening a browser. Also honored as
    /// SPAWN_NO_BROWSER=1, which is the only way through `curl … | sh`.
    /// The env var is read in login.rs with shell semantics rather than by
    /// clap, which would demand a literal `true`/`false`.
    #[arg(long)]
    pub no_browser: bool,
}

#[derive(Debug, Args)]
pub struct RunArgs {}
