// spawnd — the spawn daemon.
//
// `spawnd` is the small static binary that runs on a user's host. It dials WSS
// out to the central spawn-server, registers the host, and accepts agent
// lifecycle frames. For each agent it launches the agent inside its own tmux
// session, attaches a PTY for streaming, and multiplexes PTY I/O over the
// single WS. Agent provider auth (e.g. `claude /login`) is handled by each
// CLI itself on the host — spawn does not manage agent credentials.
//
// Process model: tmux owns the agent process, so the agent survives `spawnd`
// restarts. On reconnect the daemon re-registers with the list of agents it
// still owns, and the server resyncs its routing map without disturbing them.

mod activity;
mod agents;
mod cli;
mod config;
mod creds;
mod frames;
mod host_files;
mod login;
mod proto;
mod pty;
mod rtc;
mod run;
mod tmux;
mod upload;
mod worker_backend;
mod ws;

use clap::Parser;
use cli::{Cli, Command};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    init_tracing(cli.verbose);

    match cli.command {
        Command::Login(args) => {
            let no_run = args.no_run;
            login::run(cli.server.clone(), args).await?;
            if no_run {
                return Ok(());
            }
            tracing::info!("login complete; transitioning to run");
            run::run(cli.server.clone(), cli::RunArgs {}).await
        }
        Command::Run(args) => run::run(cli.server.clone(), args).await,
        Command::Logout => creds::logout().await,
        Command::Status => creds::status(cli.server.clone()).await,
    }
}

fn init_tracing(verbose: u8) {
    use tracing_subscriber::{fmt, EnvFilter};

    // -v => debug for spawnd, info elsewhere
    // -vv => trace for spawnd, debug elsewhere
    let default = match verbose {
        0 => "info",
        1 => "info,spawnd=debug",
        _ => "debug,spawnd=trace",
    };
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(default));

    fmt()
        .with_env_filter(filter)
        .with_target(false)
        .with_writer(std::io::stderr)
        .init();
}
