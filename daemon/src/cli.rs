//! Clap derive structs for the `spawnd` CLI.

use clap::{Args, Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(name = "spawnd", version, about = "spawn daemon")]
pub struct Cli {
    /// Override the spawn server base URL (default: env SPAWN_SERVER_URL or
    /// https://localhost:8000).
    #[arg(long, global = true, env = "SPAWN_SERVER_URL")]
    pub server: Option<String>,

    /// Increase log verbosity (-v, -vv).
    #[arg(short, long, global = true, action = clap::ArgAction::Count)]
    pub verbose: u8,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
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
pub struct LoginArgs {
    /// Override the host name reported to the server (defaults to system
    /// hostname).
    #[arg(long)]
    pub host_name: Option<String>,

    /// Just store the token; don't transition to `run` after login succeeds.
    #[arg(long)]
    pub no_run: bool,
}

#[derive(Debug, Args)]
pub struct RunArgs {}
