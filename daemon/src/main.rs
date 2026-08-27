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
mod doctor;
mod host_control;
mod host_desktop;
mod host_direct;
mod host_files;
mod host_metrics;
mod host_mime;
mod host_preview;
mod host_signal;
mod lifecycle;
mod login;
mod platform;
mod possess;
mod proto;
mod pty;
mod release_key;
mod rtc;
mod run;
mod service;
mod session_ctl;
mod sessions;
mod state;
mod status;
mod tui;
mod update;
mod upload;
mod version;
mod worker_backend;
mod ws;

use clap::Parser;
use cli::{Cli, Command};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if cli::print_top_help_if_requested() {
        return Ok(());
    }
    let cli = Cli::parse();
    let explicit_config = cli.config_dir.is_some()
        || std::env::var_os("SPAWN_CONFIG_DIR").is_some_and(|value| !value.is_empty());
    if let Some(dir) = cli.config_dir.as_deref() {
        // The whole daemon keys its per-host state off SPAWN_CONFIG_DIR. Set it
        // once here — single-threaded, before any config access or thread spawn
        // — so --config-dir and the env var are one mechanism.
        std::env::set_var("SPAWN_CONFIG_DIR", dir);
    }
    init_tracing(cli.verbose);

    let result = match cli.command {
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
        Command::Doctor(args) => doctor::run(cli.server.clone(), args).await,
        Command::Reconnect => lifecycle::reconnect(cli.server.clone(), explicit_config).await,
        Command::Disconnect => lifecycle::disconnect(explicit_config),
        Command::Logout(args) => lifecycle::logout(args, explicit_config).await,
        Command::Reset(args) => lifecycle::reset(args, explicit_config).await,
        Command::Status(args) => {
            status::run(cli.server.clone(), args, explicit_config, cli.verbose).await
        }
    };
    if result
        .as_ref()
        .err()
        .is_some_and(|error| error.downcast_ref::<login::LoginInterrupted>().is_some())
    {
        return Ok(());
    }
    if let Some(error) = result
        .as_ref()
        .err()
        .and_then(|error| error.downcast_ref::<login::UserFacingError>())
    {
        eprintln!("spawn: ✗ {error}");
        std::process::exit(1);
    }
    result
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
