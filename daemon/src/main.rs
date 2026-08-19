// spawnd — the spawn daemon.
//
// `spawnd` is the small static binary that runs on a user's host. It dials WSS
// out to the central spawn-server, registers the host, and accepts agent
// lifecycle frames. For each agent it launches a purpose-built session worker
// that owns the PTY and multiplexes control through spawnd. Agent provider auth
// (e.g. `claude /login`) is handled by each CLI itself on the host — spawn does
// not manage agent credentials.
//
// Process model: one spawn-worker owns each agent process and survives `spawnd`
// restarts. On reconnect the daemon adopts live workers and re-registers them.

mod activity;
mod agent_ctl;
mod agents;
mod cli;
mod config;
mod cpu_scopes;
mod creds;
mod gpu;
mod host_control;
mod host_direct;
mod host_files;
mod host_signal;
mod login;
mod possess;
mod proto;
mod pty;
mod rtc;
mod run;
mod service;
mod upload;
mod worker_backend;
mod ws;

use clap::Parser;
use cli::{Cli, Command};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    if let Some(dir) = cli.config_dir.as_deref() {
        // The whole daemon keys its per-host state off SPAWN_CONFIG_DIR. Set it
        // once here — single-threaded, before any config access or thread spawn
        // — so --config-dir and the env var are one mechanism.
        std::env::set_var("SPAWN_CONFIG_DIR", dir);
    }
    init_tracing(cli.verbose);

    match cli.command {
        Command::Possess(args) => possess::possess(cli.server.clone(), args).await,
        Command::Exorcise(args) => possess::exorcise(cli.server.clone(), args).await,
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
