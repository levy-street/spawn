//! Clap derive structs for the `spawnd` CLI.

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(
    name = "spawnd",
    version = crate::version::BUILD_VERSION,
    about = "the SPAWN D daemon. It possesses a machine and answers to your account."
)]
pub struct Cli {
    /// Override the spawn server base URL (default: env SPAWN_SERVER_URL,
    /// else the server this instance registered with, else
    /// http://localhost:8000).
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
    #[command(visible_alias = "setup")]
    Possess(PossessArgs),
    /// Authenticate, then stop and remove this host's spawn daemon.
    #[command(visible_alias = "remove")]
    Exorcise(ExorciseArgs),
    /// Interactive device-code flow; stores a long-lived daemon token.
    Login(LoginArgs),
    /// Foreground; connects WSS and services frames.
    #[command(after_help = "Examples:\n  spawnd run")]
    Run(RunArgs),
    /// Check for and apply the latest SPAWN D daemon release once.
    #[command(after_help = "Examples:\n  spawnd update")]
    Update,
    /// Run all local health checks and print the fix for every failure.
    Doctor(DoctorArgs),
    /// Drop and re-establish the server connection right now.
    #[command(after_help = "Examples:\n  spawnd reconnect")]
    Reconnect,
    /// Stop the background daemon without removing local state.
    #[command(after_help = "Examples:\n  spawnd disconnect")]
    Disconnect,
    /// Wipe the complete stored credential record, including browser pins.
    Logout(LogoutArgs),
    /// Wipe local SPAWN D state, with an opt-in server-side host removal.
    Reset(ResetArgs),
    /// Print credential state and redacted host/browser fingerprints.
    Status(StatusArgs),
    /// Open the arrow-key menu for connections, approvals, sessions, and accounts.
    Manage,
    /// List or remove browser connections for this machine.
    Pins(PinsArgs),
    /// List or approve pending device requests for this account.
    Approvals(ApprovalsArgs),
    /// List or stop individual session workers.
    Sessions(SessionsArgs),
    /// List or remove account instances on this machine.
    Instances(InstancesArgs),
    /// Internal HKCU Run watchdog entry point.
    #[command(name = "__watchdog", hide = true)]
    Watchdog(WatchdogArgs),
    /// Internal post-update service-manager handoff.
    #[command(name = "__update-handoff", hide = true)]
    UpdateHandoff(UpdateHandoffArgs),
}

#[derive(Debug, Args)]
#[command(after_help = "Examples:\n  spawnd possess\n  spawnd possess --new-account")]
pub struct PossessArgs {
    /// Override the host name reported to the server (defaults to system
    /// hostname).
    #[arg(long)]
    pub host_name: Option<String>,

    /// Print the approval link but never open a browser for it.
    #[arg(long)]
    pub no_browser: bool,

    /// Register another isolated account even when this machine already has
    /// a SPAWN D instance.
    #[arg(long)]
    pub new_account: bool,

    /// Always render the approval URL as a terminal QR code.
    #[arg(long, conflicts_with = "no_qr")]
    pub qr: bool,

    /// Never render a terminal QR code.
    #[arg(long, conflicts_with = "qr")]
    pub no_qr: bool,

    /// Select the Windows background manager for this account instance.
    #[arg(long, value_name = "task|run")]
    pub service_mode: Option<String>,
}

#[derive(Debug, Args)]
#[command(after_help = "Examples:\n  spawnd exorcise\n  spawnd exorcise --all --yes")]
pub struct ExorciseArgs {
    /// Remove every spawn instance on this host, not just the selected one.
    #[arg(long)]
    pub all: bool,

    /// Skip the interactive confirmation.
    #[arg(long)]
    pub yes: bool,
}

#[derive(Debug, Args)]
#[command(after_help = "Examples:\n  spawnd login\n  spawnd login --no-run")]
pub struct LoginArgs {
    /// Override the host name reported to the server (defaults to system
    /// hostname).
    #[arg(long)]
    pub host_name: Option<String>,

    /// Just store the token; don't transition to `run` after login succeeds.
    #[arg(long)]
    pub no_run: bool,

    /// Print the approval link but never open a browser for it.
    #[arg(long)]
    pub no_browser: bool,

    /// Always render the approval URL as a terminal QR code.
    #[arg(long, conflicts_with = "no_qr")]
    pub qr: bool,

    /// Never render a terminal QR code.
    #[arg(long, conflicts_with = "qr")]
    pub no_qr: bool,
}

#[derive(Debug, Args)]
pub struct RunArgs {
    /// Internal marker for a Task Scheduler or Run-watchdog launch.
    #[arg(long, hide = true)]
    pub background_service: bool,
}

#[derive(Debug, Args)]
pub struct WatchdogArgs {
    #[arg(long, value_name = "8HEX")]
    pub instance: String,
}

#[derive(Debug, Args)]
pub struct UpdateHandoffArgs {
    #[arg(long)]
    pub parent_pid: u32,
}

#[derive(Debug, Args)]
#[command(after_help = "Examples:\n  spawnd status\n  spawnd status --json")]
pub struct StatusArgs {
    /// Emit stable machine-readable JSON.
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
#[command(
    after_help = "Examples:\n  spawnd pins\n  spawnd pins remove <PIN_ID>\n  spawnd pins clear --yes"
)]
pub struct PinsArgs {
    #[command(subcommand)]
    pub command: Option<PinsCommand>,
}

#[derive(Debug, Subcommand)]
pub enum PinsCommand {
    /// Remove one browser connection by pin ID.
    Remove { pin_id: String },
    /// Remove every browser connection from this machine.
    Clear {
        /// Skip the destructive confirmation.
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Debug, Args)]
#[command(after_help = "Examples:\n  spawnd approvals\n  spawnd approvals approve <REQUEST_ID>")]
pub struct ApprovalsArgs {
    #[command(subcommand)]
    pub command: Option<ApprovalsCommand>,
}

#[derive(Debug, Subcommand)]
pub enum ApprovalsCommand {
    /// Approve one pending device request by request ID.
    Approve { request_id: String },
}

#[derive(Debug, Args)]
#[command(after_help = "Examples:\n  spawnd sessions\n  spawnd sessions kill <SESSION_ID>")]
pub struct SessionsArgs {
    #[command(subcommand)]
    pub command: Option<SessionsCommand>,
}

#[derive(Debug, Subcommand)]
pub enum SessionsCommand {
    /// Stop one local session worker by session UUID.
    Kill { session_id: String },
}

#[derive(Debug, Args)]
#[command(
    after_help = "Examples:\n  spawnd instances\n  spawnd instances exorcise <ACCOUNT> --yes"
)]
pub struct InstancesArgs {
    #[command(subcommand)]
    pub command: Option<InstancesCommand>,
}

#[derive(Debug, Subcommand)]
pub enum InstancesCommand {
    /// Deregister and remove one account instance.
    Exorcise {
        /// Account/instance directory name shown by `spawnd instances`.
        instance: String,
        /// Skip the destructive confirmation.
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Debug, Args)]
#[command(
    after_help = "Examples:\n  spawnd doctor\n  spawnd doctor --json   # for scripts and support bundles"
)]
pub struct DoctorArgs {
    /// Emit `{host, version, checks, problems}` as stable JSON.
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
#[command(after_help = "Examples:\n  spawnd logout\n  spawnd logout --wipe-identity")]
pub struct LogoutArgs {
    /// Also remove the host identity and browser approvals.
    #[arg(long)]
    pub wipe_identity: bool,
}

#[derive(Debug, Args)]
#[command(
    long_about = "Wipe all local SPAWN D state, with an opt-in offer to remove the server-side host too.\n\nThis removes this machine's SPAWN D identity, sign-in, and approvals — but never your files or the sessions' working directories.",
    after_help = "Examples:\n  spawnd reset\n  spawnd reset --yes\n  spawnd reset --yes --remove-host"
)]
pub struct ResetArgs {
    /// Skip confirmations, including the running-worker confirmation.
    #[arg(long)]
    pub yes: bool,

    /// Also remove this host from the account before wiping local credentials.
    #[arg(long)]
    pub remove_host: bool,
}

pub const TOP_LEVEL_HELP: &str = r#"spawnd — the SPAWN D daemon. It possesses a machine and answers to your account.

Usage: spawnd [OPTIONS] <COMMAND>

Summoning:
  possess      Register this machine and keep it running in the background.
               Safe to re-run at any time.                       [alias: setup]
  exorcise     Deregister this machine and remove the daemon.   [alias: remove]

Every day:
  status       What this machine knows: account, connection, service, sessions.
  manage       Manage connections, approvals, sessions, and account instances.
  doctor       Run every health check; each failure comes with its fix.
  reconnect    Drop and re-establish the server connection right now.
  disconnect   Stop the background daemon. Nothing is removed.
  update       Apply the latest SPAWN D release.

Account:
  login        Re-run the browser approval for this machine.
  logout       Sign this machine out. Its identity is kept for next time.
  reset        Wipe all local SPAWN D state on this machine. Last resort.
  pins         List/remove this machine's approved browser connections.
  approvals    List/approve pending device requests.
  sessions     List/stop individual session workers.
  instances    List/remove account instances on this machine.

Advanced:
  run          Run the daemon in the foreground (what the service runs).

Options:
  --server <URL>       spawn server (default: the one this machine registered with)
  --config-dir <PATH>  instance directory — one per account on shared machines
  -v, -vv              more detail in logs
  -h, --help           this help;  spawnd <command> --help for one command

Examples:
  curl -fsSL https://spawnd.dev/install.sh | sh    install and possess, one line
  spawnd possess                                   set this machine up (or resume)
  spawnd doctor                                    my host shows offline — why?
  spawnd exorcise                                  undo everything possess did
"#;

pub fn print_top_help_if_requested() -> bool {
    let args = std::env::args_os().collect::<Vec<_>>();
    if args.len() == 2 && matches!(args[1].to_str(), Some("help" | "--help" | "-h")) {
        print!("{TOP_LEVEL_HELP}");
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;
    use sha2::{Digest, Sha256};

    #[test]
    fn top_level_help_is_the_design_golden() {
        assert!(TOP_LEVEL_HELP.starts_with("spawnd — the SPAWN D daemon."));
        for heading in [
            "Summoning:",
            "Every day:",
            "Account:",
            "Advanced:",
            "Examples:",
        ] {
            assert!(TOP_LEVEL_HELP.contains(heading));
        }
        assert!(TOP_LEVEL_HELP.contains("[alias: setup]"));
        assert!(TOP_LEVEL_HELP.contains("[alias: remove]"));
    }

    #[test]
    fn every_command_help_matches_the_plain_golden() {
        let command = Cli::command();
        let mut mismatches = Vec::new();
        for line in include_str!("cli_help.golden").lines() {
            let (name, expected) = line.split_once(' ').expect("name and help digest");
            let subcommand = command
                .find_subcommand(name)
                .unwrap_or_else(|| panic!("missing {name}"));
            let mut rendered = Vec::new();
            subcommand.clone().write_long_help(&mut rendered).unwrap();
            let actual = Sha256::digest(rendered)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            if actual != expected {
                mismatches.push(format!("{name} {actual}"));
            }
        }
        assert!(
            mismatches.is_empty(),
            "plain help goldens changed:\n{}",
            mismatches.join("\n")
        );
    }
}
