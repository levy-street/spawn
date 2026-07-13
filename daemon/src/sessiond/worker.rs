//! The session worker runtime: one process per agent, owning the agent's PTY.
//!
//! Lifecycle:
//! 1. `spawn-worker --socket <p> --agent-id <uuid> --log-dir <p>` binds the
//!    unix socket and waits for the supervising `spawnd` to connect.
//! 2. Every accepted connection is greeted with a `Hello` frame carrying the
//!    worker's state, so a freshly restarted `spawnd` can adopt a running
//!    worker with no persistent handshake state.
//! 3. `Start` spawns the agent argv on a PTY the worker owns. Raw output is
//!    encrypted into the scrollback log the moment it leaves the PTY read
//!    buffer, then forwarded to the current connection; the plaintext buffer
//!    is zeroized after each hop.
//! 4. On PTY EOF the worker reports `Exit`, deletes its scrollback (the key
//!    dies with the process anyway), unlinks its socket, and exits.
//!
//! The agent's fate is tied to the worker (the worker holds the PTY master),
//! but NOT to spawnd: the worker runs in its own process group and keeps
//! serving across spawnd restarts/upgrades. That is the tmux-survivability
//! property, minus tmux.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tokio::io::AsyncWriteExt;
use tokio::net::unix::OwnedWriteHalf;
use tokio::net::UnixListener;
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;
use zeroize::Zeroize;

use super::scrollback::ScrollbackLog;
use super::secret::{self, SecretBytes};
use super::wire;

/// How long a worker with no agent yet waits for `Start` before giving up.
const AWAIT_START_TIMEOUT: Duration = Duration::from_secs(120);
/// After the agent exits, how long the worker lingers to deliver `Exit` to a
/// (re)connecting spawnd before cleaning up regardless.
const EXIT_LINGER: Duration = Duration::from_secs(60);
/// Delay between the two halves of a SIGWINCH repaint nudge.
const JIGGLE_DELAY: Duration = Duration::from_millis(20);

pub struct WorkerArgs {
    pub socket: PathBuf,
    pub agent_id: Uuid,
    pub log_dir: PathBuf,
    pub segment_bytes: u64,
    pub max_log_bytes: u64,
}

pub fn parse_args<I: Iterator<Item = String>>(mut args: I) -> Result<WorkerArgs> {
    let mut socket = None;
    let mut agent_id = None;
    let mut log_dir = None;
    let mut segment_bytes = super::scrollback::DEFAULT_SEGMENT_BYTES;
    let mut max_log_bytes = super::scrollback::DEFAULT_MAX_LOG_BYTES;
    while let Some(arg) = args.next() {
        let mut value = |name: &str| -> Result<String> {
            args.next()
                .ok_or_else(|| anyhow::anyhow!("missing value for {name}"))
        };
        match arg.as_str() {
            "--socket" => socket = Some(PathBuf::from(value("--socket")?)),
            "--agent-id" => {
                agent_id = Some(Uuid::parse_str(&value("--agent-id")?).context("agent id")?)
            }
            "--log-dir" => log_dir = Some(PathBuf::from(value("--log-dir")?)),
            "--segment-bytes" => segment_bytes = value("--segment-bytes")?.parse()?,
            "--max-log-bytes" => max_log_bytes = value("--max-log-bytes")?.parse()?,
            other => bail!("unknown argument {other:?}"),
        }
    }
    Ok(WorkerArgs {
        socket: socket.context("--socket is required")?,
        agent_id: agent_id.context("--agent-id is required")?,
        log_dir: log_dir.context("--log-dir is required")?,
        segment_bytes,
        max_log_bytes,
    })
}

/// Entry point for the `spawn-worker` binary.
pub fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .with_writer(std::io::stderr)
        .init();
    let args = parse_args(std::env::args().skip(1))?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .context("building tokio runtime")?;
    runtime.block_on(run(args))
}

enum State {
    AwaitingStart,
    Running,
    Exited(wire::ExitInfo),
}

struct Pty {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    input_tx: mpsc::UnboundedSender<Vec<u8>>,
    pid: u32,
    /// Desired size; jiggles always restore to this.
    size: Arc<Mutex<(u16, u16)>>,
}

/// Frames from the *current* connection's reader task, tagged with the
/// connection generation so frames from a displaced connection are ignored.
struct ConnFrame {
    generation: u64,
    frame: Option<(u8, Vec<u8>)>,
}

pub async fn run(args: WorkerArgs) -> Result<()> {
    let key = SecretBytes::random(32).context("generating scrollback key")?;
    if !key.is_locked() {
        tracing::warn!("mlock failed for scrollback key; key may be swappable (RLIMIT_MEMLOCK?)");
    }
    let mut log =
        ScrollbackLog::with_limits(&args.log_dir, &key, args.segment_bytes, args.max_log_bytes)
            .context("opening scrollback log")?;

    if let Some(parent) = args.socket.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
    }
    let _ = std::fs::remove_file(&args.socket);
    let listener = UnixListener::bind(&args.socket)
        .with_context(|| format!("binding {}", args.socket.display()))?;
    tracing::info!(agent_id = %args.agent_id, socket = %args.socket.display(), "worker listening");

    let (frame_tx, mut frame_rx) = mpsc::unbounded_channel::<ConnFrame>();
    let (pty_tx, mut pty_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (exit_tx, mut exit_rx) = oneshot::channel::<wire::ExitInfo>();
    let mut exit_tx = Some(exit_tx);
    let mut pty_tx = Some(pty_tx);

    let mut state = State::AwaitingStart;
    let mut pty: Option<Pty> = None;
    let mut conn_write: Option<OwnedWriteHalf> = None;
    let mut generation: u64 = 0;
    let mut pty_open = false;
    let mut exit_reported = false;

    let started_at = tokio::time::Instant::now();
    let mut exited_at: Option<tokio::time::Instant> = None;

    loop {
        // Deadlines: give up waiting for Start / linger after exit.
        let deadline = match (&state, exited_at) {
            (State::AwaitingStart, _) => Some(started_at + AWAIT_START_TIMEOUT),
            (State::Exited(_), Some(at)) => Some(at + EXIT_LINGER),
            _ => None,
        };
        let timeout = async {
            match deadline {
                Some(d) => tokio::time::sleep_until(d).await,
                None => std::future::pending::<()>().await,
            }
        };

        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted.context("accepting connection")?;
                generation += 1;
                let (read_half, mut write_half) = stream.into_split();
                let hello = wire::Hello {
                    version: wire::PROTO_VERSION,
                    agent_id: args.agent_id,
                    state: match &state {
                        State::AwaitingStart => "awaiting_start".into(),
                        State::Running => "running".into(),
                        State::Exited(_) => "exited".into(),
                    },
                    pid: pty.as_ref().map(|p| p.pid),
                    cols: pty.as_ref().map(|p| p.size.lock().unwrap().0).unwrap_or(0),
                    rows: pty.as_ref().map(|p| p.size.lock().unwrap().1).unwrap_or(0),
                };
                if wire::write_json_frame(&mut write_half, wire::T_HELLO, &hello).await.is_err() {
                    continue;
                }
                // If the agent already exited, deliver Exit immediately.
                if let State::Exited(info) = &state {
                    let _ = wire::write_json_frame(&mut write_half, wire::T_EXIT, info).await;
                    tracing::info!("delivered exit to late connection; cleaning up");
                    let _ = write_half.shutdown().await;
                    break;
                }
                conn_write = Some(write_half);
                spawn_conn_reader(read_half, generation, frame_tx.clone());
                tracing::debug!(generation, "connection accepted");
            }

            Some(conn_frame) = frame_rx.recv() => {
                if conn_frame.generation != generation {
                    continue; // frame from a displaced connection
                }
                let Some((frame_type, payload)) = conn_frame.frame else {
                    tracing::debug!("connection closed by peer");
                    conn_write = None;
                    continue;
                };
                match handle_frame(
                    frame_type,
                    payload,
                    &mut state,
                    &mut pty,
                    &mut conn_write,
                    &mut log,
                    &mut pty_tx,
                    &mut exit_tx,
                ).await {
                    Ok(LoopAction::Continue) => {}
                    Ok(LoopAction::PtyStarted) => pty_open = true,
                    Ok(LoopAction::Quit) => break,
                    Err(e) => {
                        tracing::warn!(error = %e, "frame handling failed");
                        if let Some(w) = conn_write.as_mut() {
                            let _ = wire::write_json_frame(
                                w,
                                wire::T_ERROR,
                                &wire::WorkerError { message: format!("{e:#}") },
                            ).await;
                        }
                    }
                }
            }

            chunk = pty_rx.recv(), if pty_open => {
                match chunk {
                    Some(mut chunk) => {
                        // Encrypt-on-read: log first, then forward live.
                        match log.append_output(&chunk) {
                            Ok(true) => {
                                if let Err(e) = log.rotate() {
                                    tracing::warn!(error = %e, "scrollback rotate failed");
                                } else if let Some(p) = &pty {
                                    // Fresh segment: nudge a full repaint so the
                                    // checkpoint is a coherent replay start.
                                    spawn_jiggle(p.master.clone(), p.size.clone());
                                }
                            }
                            Ok(false) => {}
                            Err(e) => tracing::warn!(error = %e, "scrollback append failed"),
                        }
                        if let Some(w) = conn_write.as_mut() {
                            if wire::write_frame(w, wire::T_OUTPUT, &chunk).await.is_err() {
                                conn_write = None;
                            }
                        }
                        chunk.zeroize();
                    }
                    None => {
                        // Reader thread finished: PTY EOF. Wait for the exit
                        // report on exit_rx (or synthesize one).
                        pty_open = false;
                        let info = (&mut exit_rx).await.unwrap_or(wire::ExitInfo {
                            exit_code: None,
                            signal: None,
                        });
                        tracing::info!(exit_code = ?info.exit_code, signal = ?info.signal, "agent exited");
                        exited_at = Some(tokio::time::Instant::now());
                        if let Some(w) = conn_write.as_mut() {
                            if wire::write_json_frame(w, wire::T_EXIT, &info).await.is_ok() {
                                exit_reported = true;
                            }
                        }
                        state = State::Exited(info);
                        if exit_reported {
                            break;
                        }
                        // No live connection: linger so a reconnecting spawnd
                        // can pick the exit up.
                    }
                }
            }

            _ = timeout => {
                match &state {
                    State::AwaitingStart => {
                        tracing::warn!("no Start received; exiting");
                    }
                    State::Exited(_) => {
                        tracing::info!("exit linger elapsed without a connection; cleaning up");
                    }
                    State::Running => unreachable!("no deadline while running"),
                }
                break;
            }
        }
    }

    if let Some(mut w) = conn_write.take() {
        let _ = w.shutdown().await;
    }
    log.destroy();
    let _ = std::fs::remove_file(&args.socket);
    Ok(())
}

enum LoopAction {
    Continue,
    PtyStarted,
    Quit,
}

#[allow(clippy::too_many_arguments)]
async fn handle_frame(
    frame_type: u8,
    payload: Vec<u8>,
    state: &mut State,
    pty: &mut Option<Pty>,
    conn_write: &mut Option<OwnedWriteHalf>,
    log: &mut ScrollbackLog,
    pty_tx: &mut Option<mpsc::UnboundedSender<Vec<u8>>>,
    exit_tx: &mut Option<oneshot::Sender<wire::ExitInfo>>,
) -> Result<LoopAction> {
    match frame_type {
        wire::T_START => {
            if !matches!(state, State::AwaitingStart) {
                bail!("Start received but agent is already {}", state_name(state));
            }
            let spec: wire::StartSpec = wire::decode_json(&payload)?;
            let out_tx = pty_tx.take().context("pty channel already consumed")?;
            let ex_tx = exit_tx.take().context("exit channel already consumed")?;
            let started = spawn_pty(&spec, out_tx, ex_tx).context("spawning agent PTY")?;
            let pid = started.pid;
            *pty = Some(started);
            *state = State::Running;
            if let Some(w) = conn_write.as_mut() {
                let _ = wire::write_json_frame(w, wire::T_STARTED, &wire::Started { pid }).await;
            }
            tracing::info!(pid, "agent started");
            Ok(LoopAction::PtyStarted)
        }
        wire::T_INPUT => {
            if let Some(p) = pty {
                let _ = p.input_tx.send(payload);
            }
            Ok(LoopAction::Continue)
        }
        wire::T_RESIZE => {
            let (cols, rows) = wire::decode_resize(&payload)?;
            if let Some(p) = pty {
                *p.size.lock().unwrap() = (cols, rows);
                resize_master(&p.master, cols, rows);
            }
            Ok(LoopAction::Continue)
        }
        wire::T_REDRAW => {
            if let Some(p) = pty {
                spawn_jiggle(p.master.clone(), p.size.clone());
            }
            Ok(LoopAction::Continue)
        }
        wire::T_REPLAY_REQ => {
            let max_bytes = wire::decode_replay_req(&payload)?;
            let replay = log.replay(max_bytes as u64)?;
            let watermark = log.total_logged();
            if let Some(w) = conn_write.as_mut() {
                let framed = wire::encode_replay(watermark, &replay);
                let _ = wire::write_frame(w, wire::T_REPLAY, &framed).await;
                secret::wipe_vec(framed);
            }
            secret::wipe_vec(replay);
            Ok(LoopAction::Continue)
        }
        wire::T_SHUTDOWN => {
            let shutdown: wire::Shutdown =
                wire::decode_json(&payload).unwrap_or(wire::Shutdown { signal: None });
            match pty {
                Some(p) => {
                    signal_child(p.pid, shutdown.signal.as_deref());
                    // PTY EOF will drive Exit reporting and cleanup.
                    Ok(LoopAction::Continue)
                }
                None => {
                    tracing::info!("shutdown before start; exiting");
                    Ok(LoopAction::Quit)
                }
            }
        }
        other => {
            tracing::debug!(frame_type = other, "ignoring unknown frame type");
            Ok(LoopAction::Continue)
        }
    }
}

fn state_name(state: &State) -> &'static str {
    match state {
        State::AwaitingStart => "awaiting_start",
        State::Running => "running",
        State::Exited(_) => "exited",
    }
}

fn spawn_conn_reader(
    mut read_half: tokio::net::unix::OwnedReadHalf,
    generation: u64,
    frame_tx: mpsc::UnboundedSender<ConnFrame>,
) {
    tokio::spawn(async move {
        loop {
            match wire::read_frame(&mut read_half).await {
                Ok(Some(frame)) => {
                    if frame_tx
                        .send(ConnFrame {
                            generation,
                            frame: Some(frame),
                        })
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(None) | Err(_) => {
                    let _ = frame_tx.send(ConnFrame {
                        generation,
                        frame: None,
                    });
                    break;
                }
            }
        }
    });
}

fn spawn_pty(
    spec: &wire::StartSpec,
    out_tx: mpsc::UnboundedSender<Vec<u8>>,
    exit_tx: oneshot::Sender<wire::ExitInfo>,
) -> Result<Pty> {
    if spec.argv.is_empty() {
        bail!("argv is empty");
    }
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: spec.rows.max(1),
            cols: spec.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("openpty")?;

    let mut cmd = CommandBuilder::new(&spec.argv[0]);
    cmd.args(&spec.argv[1..]);
    // The daemon computes and ships the *complete* environment; do not leak
    // the worker's own env (it may differ after upgrades).
    cmd.env_clear();
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }
    cmd.cwd(&spec.cwd);

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .context("spawning agent in PTY")?;
    let pid = child.process_id().unwrap_or(0);
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .context("cloning PTY reader")?;
    let mut writer = pair.master.take_writer().context("taking PTY writer")?;

    // Blocking writer thread: PTY input can block when the agent stops
    // reading; keep that off the async loop.
    let (input_tx, mut input_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    std::thread::spawn(move || {
        while let Some(mut bytes) = input_rx.blocking_recv() {
            if writer.write_all(&bytes).is_err() {
                break;
            }
            let _ = writer.flush();
            bytes.zeroize();
        }
    });

    // Blocking reader thread: PTY output -> async loop.
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if out_tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        buf.zeroize();
        drop(out_tx); // closes the channel: signals PTY EOF to the main loop
        let info = match child.wait() {
            Ok(status) => wire::ExitInfo {
                exit_code: Some(status.exit_code() as i32),
                signal: None,
            },
            Err(_) => wire::ExitInfo {
                exit_code: None,
                signal: Some("wait_failed".into()),
            },
        };
        let _ = exit_tx.send(info);
    });

    Ok(Pty {
        master: Arc::new(Mutex::new(pair.master)),
        input_tx,
        pid,
        size: Arc::new(Mutex::new((spec.cols, spec.rows))),
    })
}

fn resize_master(master: &Arc<Mutex<Box<dyn MasterPty + Send>>>, cols: u16, rows: u16) {
    if let Ok(guard) = master.lock() {
        let _ = guard.resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        });
    }
}

/// SIGWINCH repaint nudge: briefly change the PTY size, then restore the
/// desired geometry. The kernel only signals on actual change, so a jiggle is
/// the tmux-free equivalent of `refresh-client` — full-screen apps repaint on
/// the restore.
fn spawn_jiggle(master: Arc<Mutex<Box<dyn MasterPty + Send>>>, size: Arc<Mutex<(u16, u16)>>) {
    tokio::spawn(async move {
        let (cols, rows) = *size.lock().unwrap();
        let alt_rows = if rows > 2 { rows - 1 } else { rows + 1 };
        resize_master(&master, cols, alt_rows);
        tokio::time::sleep(JIGGLE_DELAY).await;
        let (cols, rows) = *size.lock().unwrap();
        resize_master(&master, cols, rows);
    });
}

fn signal_child(pid: u32, signal: Option<&str>) {
    use nix::sys::signal::{killpg, Signal};
    use nix::unistd::Pid;
    let sig = match signal.unwrap_or("TERM").trim_start_matches("SIG") {
        "KILL" => Signal::SIGKILL,
        "INT" => Signal::SIGINT,
        "HUP" => Signal::SIGHUP,
        "QUIT" => Signal::SIGQUIT,
        _ => Signal::SIGTERM,
    };
    let pid = Pid::from_raw(pid as i32);
    // The PTY child is a session leader (setsid by the PTY layer), so its
    // pgid == pid; fall back to a direct kill if killpg fails.
    if killpg(pid, sig).is_err() {
        let _ = nix::sys::signal::kill(pid, sig);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_args_requires_the_essentials() {
        let args = |list: &[&str]| parse_args(list.iter().map(|s| s.to_string()));
        assert!(args(&["--socket", "/tmp/x.sock"]).is_err());
        let ok = args(&[
            "--socket",
            "/tmp/x.sock",
            "--agent-id",
            "00000000-0000-0000-0000-000000000001",
            "--log-dir",
            "/tmp/x.scroll",
            "--segment-bytes",
            "1024",
        ])
        .unwrap();
        assert_eq!(ok.segment_bytes, 1024);
        assert_eq!(
            ok.max_log_bytes,
            super::super::scrollback::DEFAULT_MAX_LOG_BYTES
        );
        assert!(args(&["--bogus"]).is_err());
    }
}
