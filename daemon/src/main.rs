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
    detach_background_console();
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
    match &cli.command {
        Command::Run(args) if args.background_service => {
            service::prepare_background_log(&config::config_dir()?)?;
        }
        Command::Watchdog(args) => service::prepare_watchdog_log(&args.instance)?,
        Command::UpdateHandoff(_) => {
            service::prepare_background_log(&config::config_dir()?)?;
        }
        _ => {}
    }
    init_tracing(cli.verbose);
    // Only the daemon proper answers peers; the CLI subcommands keep the
    // shell's limit and its clean output.
    if matches!(cli.command, Command::Run(_) | Command::Login(_)) {
        raise_open_file_limit();
    }

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
            run::run(
                cli.server.clone(),
                cli::RunArgs {
                    background_service: false,
                },
            )
            .await
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
        Command::Watchdog(args) => service::run_watchdog(&args.instance).await,
        Command::UpdateHandoff(args) => update::relaunch_after_parent_exit(args.parent_pid),
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

#[cfg(windows)]
fn detach_background_console() {
    use std::ffi::OsStr;
    use windows_sys::Win32::System::Console::FreeConsole;

    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let internal_background = args
        .iter()
        .any(|arg| arg == OsStr::new("__watchdog") || arg == OsStr::new("__update-handoff"));
    let background_run = args.iter().any(|arg| arg == OsStr::new("run"))
        && args
            .iter()
            .any(|arg| arg == OsStr::new("--background-service"));
    if internal_background || background_run {
        // Run-key and interactive-token Task Scheduler launches may allocate a
        // console before Rust starts. Detach immediately; prepare_background_log
        // then observes that there is no console and redirects diagnostics to
        // the protected per-instance log.
        // SAFETY: FreeConsole takes no pointers. Failure only means this process
        // was already detached, which is the desired state.
        unsafe {
            FreeConsole();
        }
    }
}

#[cfg(not(windows))]
fn detach_background_console() {}

/// The soft limit on open files the daemon asks for at startup. Every peer
/// connection costs a handful of descriptors, and a peer that cannot bind a
/// socket gathers no ICE candidate at all; systemd's 1024 and launchd's 256
/// run out at a laptop's worth of sessions (#80).
const OPEN_FILE_LIMIT_TARGET: u64 = 65_536;

fn raise_open_file_limit() {
    let ceiling = |limit: &platform::OpenFileLimit| {
        limit
            .maximum
            .map_or_else(|| "unlimited".to_string(), |maximum| maximum.to_string())
    };
    match platform::raise_open_file_limit(OPEN_FILE_LIMIT_TARGET) {
        Ok(limit) if limit.after > limit.before => tracing::info!(
            before = limit.before,
            after = limit.after,
            hard = %ceiling(&limit),
            "raised the open-file limit for this daemon"
        ),
        Ok(limit) if limit.after < OPEN_FILE_LIMIT_TARGET => tracing::debug!(
            current = limit.after,
            hard = %ceiling(&limit),
            target = OPEN_FILE_LIMIT_TARGET,
            "the hard limit caps the open-file limit below the target"
        ),
        Ok(limit) => tracing::debug!(
            current = limit.after,
            hard = %ceiling(&limit),
            "the open-file limit already meets the target"
        ),
        Err(error) if error.kind() == std::io::ErrorKind::Unsupported => {}
        Err(error) => tracing::warn!(
            %error,
            target = OPEN_FILE_LIMIT_TARGET,
            "could not raise the open-file limit; sessions are capped by the inherited one"
        ),
    }
}

fn init_tracing(verbose: u8) {
    use tracing_subscriber::{fmt, EnvFilter};

    // -v => debug for spawnd, info elsewhere
    // -vv => trace for spawnd, debug elsewhere
    // The diagnostics variant starts at -v: its whole point is that the log
    // already holds the answer when something goes wrong.
    let verbose = if crate::version::DIAGNOSTICS_BUILD {
        verbose.max(1)
    } else {
        verbose
    };
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
