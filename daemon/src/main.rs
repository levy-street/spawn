// spawnd — the spawn daemon.
//
// `spawnd` is the small static binary that runs on a user's host. It dials WSS
// out to the central spawn-server, registers the host, and accepts session
// lifecycle frames. For each session it launches a purpose-built session worker
// that owns the PTY and multiplexes control through spawnd. Agent provider auth
// (e.g. `claude /login`) is handled by each CLI itself on the host — spawn does
// not manage agent-CLI credentials.
//
// Process model: one spawn-worker owns each session process and survives `spawnd`
// restarts. On reconnect the daemon adopts live workers and re-registers them.

mod activity;
mod cli;
mod config;
mod cpu_scopes;
mod creds;
mod host_control;
mod host_desktop;
mod host_direct;
mod host_files;
mod host_metrics;
mod host_mime;
mod host_preview;
mod host_signal;
mod login;
mod possess;
mod proto;
mod pty;
mod rtc;
mod run;
mod service;
mod session_ctl;
mod sessions;
mod update;
mod upload;
mod version;
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
        Command::Update => update::run_cli(cli.server.clone()).await,
        Command::Logout => creds::logout().await,
        Command::Status => creds::status(cli.server.clone()).await,
    }
}

fn init_tracing(verbose: u8) {
    use tracing_subscriber::{fmt, EnvFilter};

    // -v => debug for spawnd, info elsewhere
    // -vv => trace for spawnd, debug elsewhere
    let default = match verbose {
        0 => "info,webrtc=warn,webrtc_sctp=warn,webrtc_ice=warn",
        1 => "info,spawnd=debug,webrtc=warn,webrtc_sctp=warn,webrtc_ice=warn",
        _ => "debug,spawnd=trace,webrtc=warn,webrtc_sctp=warn,webrtc_ice=warn",
    };
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(default));

    let subscriber = fmt()
        .with_env_filter(filter)
        .with_target(false)
        .with_writer(std::io::stderr)
        .finish();
    // Install the subscriber before LogTracer: tracing-subscriber's `.init()`
    // also installs a tracer, so calling both initialization helpers would
    // make the second one fail. webrtc-rs uses the `log` facade; this explicit
    // bridge carries its transport warnings into the filtered subscriber.
    tracing::subscriber::set_global_default(subscriber)
        .expect("failed to set global tracing subscriber");
    tracing_log::LogTracer::init().expect("failed to install log-to-tracing bridge");
}
