//! The session worker runtime: one process per session, owning the session's PTY.
//!
//! Lifecycle:
//! 1. `spawn-worker` adopts its inherited endpoint reservation, binds the
//!    platform's ordinary and independent lifecycle endpoints, then waits for
//!    the supervising `spawnd` to connect.
//! 2. Every accepted connection is greeted with a `Hello` frame carrying the
//!    worker's state, so a freshly restarted `spawnd` can adopt a running
//!    worker with no persistent handshake state.
//! 3. `Start` spawns the session's command on a PTY the worker owns. Raw output
//!    feeds a headless screen emulator (`sessiond::emulator`), which commits
//!    lines to history exactly when they scroll off the screen; committed
//!    lines are encrypted into the scrollback log before any disk write, and
//!    the raw bytes are forwarded live through a bounded connection queue.
//!    Plaintext chunks and PTY scratch are zeroized after each hop/drop.
//!    Replays are committed history plus a screen repaint synthesized from
//!    the emulator — the session's process is never signaled to provoke one.
//! 4. On PTY EOF the worker reports `Exit`, deletes its scrollback (the key
//!    dies with the process anyway), unlinks its socket, and exits.
//!
//! The session's fate is tied to the worker (the worker holds the PTY master),
//! but NOT to spawnd: the worker owns an independent process group on Unix or
//! a detached breakaway Job Object on Windows and keeps serving across spawnd
//! restarts/upgrades without an intermediate terminal multiplexer.

#[cfg(windows)]
use std::ffi::OsString;
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::fd::RawFd;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[cfg(windows)]
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{bail, Context, Result};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use uuid::Uuid;
use zeroize::Zeroize;

use super::emulator::{Emulator, HistoryEvent};
use super::endpoint;
use super::scrollback::{geometry_marker, ScrollbackLog, REPLAY_HISTORY_SENTINEL};
use super::secret::{self, SecretBytes};
use super::wire;

const PTY_READ_CHUNK_BYTES: usize = 8 * 1024;
/// At most this many 8 KiB PTY reads may wait for the async worker loop. A
/// stalled supervisor socket therefore backpressures the kernel PTY rather
/// than accumulating plaintext Vecs in worker memory.
const PTY_OUTPUT_QUEUE_DEPTH: usize = 8;
/// Bound daemon frames waiting for the worker loop (notably PTY input).
const CONNECTION_FRAME_QUEUE_DEPTH: usize = 1;
/// Bound input waiting for a child that has stopped reading its PTY.
const PTY_INPUT_QUEUE_DEPTH: usize = 32;
const MAX_START_FRAME_BYTES: usize = 4 * 1024 * 1024;
const MAX_PTY_INPUT_FRAME_BYTES: usize = 64 * 1024;
const MAX_SHUTDOWN_FRAME_BYTES: usize = 64;
const SUPERVISOR_HELLO_TIMEOUT: Duration = Duration::from_millis(500);

#[cfg(test)]
type WipeProbe = Arc<dyn Fn(&[u8]) + Send + Sync>;

struct PlaintextChunk {
    bytes: Vec<u8>,
    #[cfg(test)]
    wipe_probe: Option<WipeProbe>,
}

impl std::fmt::Debug for PlaintextChunk {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PlaintextChunk")
            .field("len", &self.bytes.len())
            .finish_non_exhaustive()
    }
}

impl PlaintextChunk {
    fn new(bytes: Vec<u8>) -> Self {
        Self {
            bytes,
            #[cfg(test)]
            wipe_probe: None,
        }
    }

    #[cfg(test)]
    fn with_wipe_probe(bytes: Vec<u8>, wipe_probe: WipeProbe) -> Self {
        Self {
            bytes,
            wipe_probe: Some(wipe_probe),
        }
    }
}

impl std::ops::Deref for PlaintextChunk {
    type Target = [u8];

    fn deref(&self) -> &Self::Target {
        &self.bytes
    }
}

impl Drop for PlaintextChunk {
    fn drop(&mut self) {
        self.bytes.zeroize();
        #[cfg(test)]
        if let Some(probe) = self.wipe_probe.as_ref() {
            probe(&self.bytes);
        }
    }
}

fn take_pty_read(scratch: &mut [u8], len: usize) -> PlaintextChunk {
    let chunk = PlaintextChunk::new(scratch[..len].to_vec());
    secret::wipe(&mut scratch[..len]);
    chunk
}

fn pty_output_channel() -> (mpsc::Sender<PlaintextChunk>, mpsc::Receiver<PlaintextChunk>) {
    mpsc::channel(PTY_OUTPUT_QUEUE_DEPTH)
}

fn inbound_frame_limit(frame_type: u8) -> Option<usize> {
    match frame_type {
        wire::T_START => Some(MAX_START_FRAME_BYTES),
        wire::T_INPUT => Some(MAX_PTY_INPUT_FRAME_BYTES),
        wire::T_RESIZE => Some(4),
        wire::T_REDRAW => Some(0),
        wire::T_REPLAY_REQ => Some(4),
        wire::T_HISTORY_SUB => Some(0),
        wire::T_SHUTDOWN => Some(MAX_SHUTDOWN_FRAME_BYTES),
        _ => None,
    }
}

fn inbound_frame_size_exact(frame_type: u8, len: usize) -> bool {
    match frame_type {
        wire::T_RESIZE | wire::T_REPLAY_REQ => len == 4,
        wire::T_REDRAW | wire::T_HISTORY_SUB => len == 0,
        _ => true,
    }
}

#[cfg(test)]
fn inbound_frame_size_allowed(frame_type: u8, len: usize) -> bool {
    inbound_frame_limit(frame_type).is_some_and(|limit| len <= limit)
        && inbound_frame_size_exact(frame_type, len)
}

/// Persist the emulator's history effects, in order, and stream each one to
/// the supervisor as a live delta (`T_HISTORY` / `T_HISTORY_WIPE`) so attached
/// clients keep their scrollback identical to the log without replaying raw
/// bytes. Returns false when the log failed (the caller destroys it and
/// replay is disabled — the delta stream stops with it, so consumers never
/// diverge from what a replay would return); event plaintext is wiped on
/// every path.
async fn persist_events(
    log: &mut ScrollbackLog,
    events: Vec<HistoryEvent>,
    conn_write: &mut Option<endpoint::WorkerWriteHalf>,
    anchor: &mut wire::HistoryAnchor,
    subscribed: bool,
) -> bool {
    for event in events {
        match event {
            HistoryEvent::Lines(lines) => {
                if let Err(error) = log.append_history(&lines) {
                    secret::wipe_vec(lines);
                    tracing::warn!(%error, "scrollback append failed; disabling replay for this worker");
                    return false;
                }
                if subscribed {
                    if let Some(w) = conn_write.as_mut() {
                        let framed = wire::encode_history(*anchor, &lines);
                        if wire::write_frame(w, wire::T_HISTORY, &framed)
                            .await
                            .is_err()
                        {
                            *conn_write = None;
                        }
                        secret::wipe_vec(framed);
                    }
                }
                // The anchor tracks the log itself, not the subscription: a
                // replay captured later must report the true end offset.
                anchor.offset = anchor.offset.saturating_add(lines.len() as u64);
                secret::wipe_vec(lines);
            }
            HistoryEvent::Truncate => {
                if let Err(error) = log.truncate_all() {
                    tracing::warn!(%error, "scrollback truncate failed; disabling replay for this worker");
                    return false;
                }
                anchor.epoch = anchor.epoch.wrapping_add(1);
                anchor.offset = 0;
                if subscribed {
                    if let Some(w) = conn_write.as_mut() {
                        let framed = wire::encode_history_wipe(anchor.epoch);
                        if wire::write_frame(w, wire::T_HISTORY_WIPE, &framed)
                            .await
                            .is_err()
                        {
                            *conn_write = None;
                        }
                    }
                }
            }
        }
    }
    true
}

/// Drop history events without persisting them (log already disabled).
fn discard_events(events: Vec<HistoryEvent>) {
    for event in events {
        if let HistoryEvent::Lines(lines) = event {
            secret::wipe_vec(lines);
        }
    }
}

/// How long a worker with no session command yet waits for `Start` before giving up.
const AWAIT_START_TIMEOUT: Duration = Duration::from_secs(120);
/// After the session exits, how long the worker lingers to deliver `Exit` to a
/// (re)connecting spawnd before cleaning up regardless.
const EXIT_LINGER: Duration = Duration::from_secs(60);

pub struct WorkerArgs {
    #[cfg(unix)]
    pub socket: PathBuf,
    #[cfg(windows)]
    pub pipe_name: std::ffi::OsString,
    pub session_id: Uuid,
    pub log_dir: PathBuf,
    pub segment_bytes: u64,
    pub max_log_bytes: u64,
    #[cfg(unix)]
    pub lock_fd: Option<RawFd>,
    #[cfg(windows)]
    pub reservation_handle: Option<usize>,
}

pub fn parse_args<I: Iterator<Item = String>>(mut args: I) -> Result<WorkerArgs> {
    #[cfg(unix)]
    let mut socket = None;
    #[cfg(windows)]
    let mut pipe_name = None;
    let mut session_id = None;
    let mut log_dir = None;
    let mut segment_bytes = super::scrollback::DEFAULT_SEGMENT_BYTES;
    let mut max_log_bytes = super::scrollback::DEFAULT_MAX_LOG_BYTES;
    #[cfg(unix)]
    let mut lock_fd = None;
    #[cfg(windows)]
    let mut reservation_handle = None;
    while let Some(arg) = args.next() {
        let mut value = |name: &str| -> Result<String> {
            args.next()
                .ok_or_else(|| anyhow::anyhow!("missing value for {name}"))
        };
        match arg.as_str() {
            #[cfg(unix)]
            "--socket" => socket = Some(PathBuf::from(value("--socket")?)),
            #[cfg(windows)]
            "--pipe-name" => pipe_name = Some(std::ffi::OsString::from(value("--pipe-name")?)),
            "--session-id" => {
                session_id = Some(Uuid::parse_str(&value("--session-id")?).context("session id")?)
            }
            "--log-dir" => log_dir = Some(PathBuf::from(value("--log-dir")?)),
            "--segment-bytes" => segment_bytes = value("--segment-bytes")?.parse()?,
            "--max-log-bytes" => max_log_bytes = value("--max-log-bytes")?.parse()?,
            #[cfg(unix)]
            "--lock-fd" => lock_fd = Some(value("--lock-fd")?.parse()?),
            #[cfg(windows)]
            "--reservation-handle" => {
                reservation_handle = Some(value("--reservation-handle")?.parse()?)
            }
            other => bail!("unknown argument {other:?}"),
        }
    }
    Ok(WorkerArgs {
        #[cfg(unix)]
        socket: socket.context("--socket is required")?,
        #[cfg(windows)]
        pipe_name: pipe_name.context("--pipe-name is required")?,
        session_id: session_id.context("--session-id is required")?,
        log_dir: log_dir.context("--log-dir is required")?,
        segment_bytes,
        max_log_bytes,
        #[cfg(unix)]
        lock_fd,
        #[cfg(windows)]
        reservation_handle,
    })
}

/// Entry point for the `spawn-worker` binary.
pub fn main() -> Result<()> {
    let args = parse_args(std::env::args().skip(1))?;
    #[cfg(unix)]
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .with_writer(std::io::stderr)
        .init();
    #[cfg(windows)]
    {
        let log =
            endpoint::open_worker_log(&args.log_dir).context("opening detached worker log")?;
        tracing_subscriber::fmt()
            .with_env_filter(
                tracing_subscriber::EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
            )
            .with_target(false)
            .with_writer(std::sync::Mutex::new(log))
            .init();
    }
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
    input_tx: mpsc::Sender<PlaintextChunk>,
    pid: u32,
    child: SharedChild,
    /// Desired size; jiggles always restore to this.
    size: Arc<Mutex<(u16, u16)>>,
    #[cfg(windows)]
    input_wake: std::thread::Thread,
}

type SharedChild = Arc<Mutex<ChildState>>;

#[cfg(unix)]
#[derive(Clone, Default)]
struct LifecyclePlatform;

#[cfg(windows)]
#[derive(Clone)]
struct LifecyclePlatform {
    priority_input: SharedPriorityInput,
    job: endpoint::WorkerJob,
}

#[cfg(windows)]
type SharedPriorityInput = Arc<Mutex<Option<PriorityInput>>>;

#[cfg(windows)]
#[derive(Clone)]
struct PriorityInput {
    sender: std::sync::mpsc::SyncSender<PriorityWrite>,
    wake: std::thread::Thread,
}

#[cfg(windows)]
struct PriorityWrite {
    cancelled: Arc<AtomicBool>,
    completed: oneshot::Sender<bool>,
}

/// The unreaped child handle is the stable process identity. Lifecycle
/// signaling and the exit monitor both hold this same lock, so the PID cannot
/// be reused between validation and platform tree termination, and reaping
/// cannot race a signal.
enum ChildState {
    AwaitingStart,
    Running {
        child: Box<dyn Child + Send + Sync>,
        pid: u32,
    },
    Exited,
}

/// Frames from the *current* connection's reader task, tagged with the
/// connection generation so frames from a displaced connection are ignored.
struct ConnFrame {
    generation: u64,
    frame: Option<(u8, PlaintextChunk)>,
}

/// Everything needed to open the scrollback log at `Start` time (the log's
/// initial checkpoint needs the session's geometry, which arrives with the
/// `StartSpec`).
struct LogSetup {
    dir: PathBuf,
    segment_bytes: u64,
    max_log_bytes: u64,
    key: SecretBytes,
}

pub async fn run(args: WorkerArgs) -> Result<()> {
    let key = SecretBytes::random(32).context("generating scrollback key")?;
    if !key.is_locked() {
        #[cfg(unix)]
        tracing::warn!("mlock failed for scrollback key; key may be swappable (RLIMIT_MEMLOCK?)");
        #[cfg(windows)]
        tracing::warn!("VirtualLock failed for scrollback key; key may be swappable");
    }
    let setup = LogSetup {
        dir: args.log_dir.clone(),
        segment_bytes: args.segment_bytes,
        max_log_bytes: args.max_log_bytes,
        key,
    };
    let mut log: Option<ScrollbackLog> = None;
    let mut emulator: Option<Emulator> = None;

    let parent = args
        .log_dir
        .parent()
        .context("worker log directory has no parent")?;
    super::endpoint::ensure_private_dir(parent)?;
    let worker_endpoint = {
        #[cfg(unix)]
        let supplied = args.socket.as_os_str();
        #[cfg(windows)]
        let supplied = args.pipe_name.as_os_str();
        endpoint::endpoint_from_worker_arg(
            parent,
            &endpoint::config_root_tag(),
            args.session_id,
            supplied,
        )?
    };

    let endpoint_lock = {
        #[cfg(unix)]
        let inherited = args.lock_fd;
        #[cfg(windows)]
        let inherited = args.reservation_handle;
        match inherited {
            Some(fd) => {
                // SAFETY: production launch passes an owned descriptor inherited
                // across exec. Identity and lock ownership are revalidated before
                // either endpoint is touched.
                unsafe { endpoint::adopt_reservation(fd, &worker_endpoint) }?
            }
            None => match endpoint::try_reserve(&worker_endpoint)? {
                super::endpoint::LockAttempt::Acquired(lock) => lock,
                super::endpoint::LockAttempt::Busy => bail!("worker endpoint is already owned"),
            },
        }
    };
    #[cfg(unix)]
    let lifecycle_platform = LifecyclePlatform;
    #[cfg(windows)]
    let lifecycle_platform = LifecyclePlatform {
        priority_input: Arc::new(Mutex::new(None)),
        // The inherited reservation is validated before this process joins
        // its own kill-on-close job, and both precede endpoint publication.
        job: endpoint::create_worker_job()?,
    };
    let instance_id = Uuid::new_v4();
    endpoint::remove_stale(&worker_endpoint, &endpoint_lock)?;
    let endpoint::BoundWorkerEndpoints {
        mut main,
        lifecycle,
        identity,
    } = endpoint::bind_worker(&worker_endpoint, &endpoint_lock, instance_id)?;
    let child_state = Arc::new(Mutex::new(ChildState::AwaitingStart));
    let lifecycle_task = tokio::spawn(run_lifecycle_listener(
        lifecycle,
        instance_id,
        Arc::clone(&child_state),
        args.session_id,
        lifecycle_platform.clone(),
    ));
    tracing::info!(session_id = %args.session_id, endpoint = ?worker_endpoint.main_arg(), "worker listening");

    let (frame_tx, mut frame_rx) = mpsc::channel::<ConnFrame>(CONNECTION_FRAME_QUEUE_DEPTH);
    let (pty_tx, mut pty_rx) = pty_output_channel();
    let (exit_tx, mut exit_rx) = oneshot::channel::<wire::ExitInfo>();
    let mut exit_tx = Some(exit_tx);
    let mut pty_tx = Some(pty_tx);

    let mut state = State::AwaitingStart;
    let mut pty: Option<Pty> = None;
    let mut conn_write: Option<endpoint::WorkerWriteHalf> = None;
    let mut conn_reader: Option<JoinHandle<()>> = None;
    let mut generation: u64 = 0;
    let mut pty_open = false;
    let mut exit_reported = false;
    let mut pty_source_offset = 0u64;
    let mut session_cwd: Option<String> = None;
    // Committed-history delta anchor. The epoch is a per-process nonce so a
    // reconnecting client can tell a worker restart (or `ED 3` wipe, which
    // bumps it) from a continuation; the offset counts committed plaintext
    // bytes within the epoch and always lands on batch boundaries.
    let mut history_anchor = wire::HistoryAnchor {
        epoch: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(1),
        offset: 0,
    };
    // Whether the CURRENT supervisor connection subscribed to history deltas
    // (`T_HISTORY_SUB`). Never emit new-protocol frames unsubscribed: an old
    // daemon rejects unknown frame types and drops the whole connection.
    let mut history_sub = false;

    // Foreground reporting: poll the PTY's foreground process group once per
    // second and send `T_FOREGROUND` only when the basename changes. Reset on
    // every new supervisor connection so an adopting spawnd learns the current
    // value without waiting for a change. The first tick is deferred one full
    // interval: polling in the fork→exec window would resolve the pre-exec
    // child to this worker's own image name, and any residual race
    // self-corrects on the next change-triggered report anyway.
    let mut foreground_poll = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(1),
        Duration::from_secs(1),
    );
    foreground_poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut foreground_sent: Option<String> = None;

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
            accepted = endpoint::accept_main(&mut main) => {
                let stream = accepted?;
                if endpoint::validate_worker_peer(&stream).is_err() {
                    tracing::warn!("rejecting worker supervisor with invalid peer ownership");
                    continue;
                }
                let (read_half, mut write_half) = endpoint::split_worker(stream);
                let hello = wire::Hello {
                    version: wire::PROTO_VERSION,
                    session_id: args.session_id,
                    instance_id,
                    state: match &state {
                        State::AwaitingStart => "awaiting_start".into(),
                        State::Running => "running".into(),
                        State::Exited(_) => "exited".into(),
                    },
                    pid: pty.as_ref().map(|p| p.pid),
                    cols: pty.as_ref().map(|p| p.size.lock().unwrap().0).unwrap_or(0),
                    rows: pty.as_ref().map(|p| p.size.lock().unwrap().1).unwrap_or(0),
                    cwd: session_cwd.clone(),
                    history: true,
                };
                let hello_sent = tokio::time::timeout(
                    SUPERVISOR_HELLO_TIMEOUT,
                    wire::write_json_frame(&mut write_half, wire::T_HELLO, &hello),
                )
                .await;
                if !matches!(hello_sent, Ok(Ok(()))) {
                    continue;
                }
                // If the session already exited, deliver Exit immediately.
                if let State::Exited(info) = &state {
                    let _ = wire::write_json_frame(&mut write_half, wire::T_EXIT, info).await;
                    tracing::info!("delivered exit to late connection; cleaning up");
                    let _ = write_half.shutdown().await;
                    break;
                }
                // The candidate is now authenticated and has accepted its
                // Hello. Fully close and await the previous connection before
                // allowing the new reader to feed the command queue.
                close_supervisor_connection(&mut conn_write, &mut conn_reader).await;
                generation = generation.wrapping_add(1);
                conn_write = Some(write_half);
                conn_reader = Some(spawn_conn_reader(read_half, generation, frame_tx.clone()));
                // Subscriptions are per-connection; the replacement daemon
                // re-subscribes if it speaks the delta protocol.
                history_sub = false;
                foreground_sent = None;
                tracing::debug!(generation, "connection accepted");
            }

            Some(mut conn_frame) = frame_rx.recv() => {
                if conn_frame.generation != generation {
                    continue; // frame from a displaced connection
                }
                let Some((frame_type, payload)) = conn_frame.frame.take() else {
                    tracing::debug!("connection closed by peer");
                    close_supervisor_connection(&mut conn_write, &mut conn_reader).await;
                    continue;
                };
                match handle_frame(
                    frame_type,
                    payload,
                    &mut state,
                    &mut pty,
                    &mut conn_write,
                    &mut log,
                    &mut emulator,
                    &setup,
                    &mut pty_tx,
                    &mut exit_tx,
                    &child_state,
                    &mut session_cwd,
                    pty_source_offset,
                    &mut history_anchor,
                    &mut history_sub,
                    &lifecycle_platform,
                ).await {
                    Ok(LoopAction::Continue) => {}
                    Ok(LoopAction::PtyStarted) => {
                        pty_open = true;
                        // First poll a full interval after exec, not on an
                        // overdue tick that raced the fork→exec window.
                        foreground_poll.reset();
                    }
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
                    Some(chunk) => {
                        // Feed the screen emulator; lines it commits (or
                        // truncates) are persisted encrypted before the raw
                        // bytes are forwarded live. The session's process is
                        // never signaled or disturbed by any of it.
                        let mut replay_failed = false;
                        if let Some(emu) = emulator.as_mut() {
                            let events = emu.feed_output(&chunk);
                            match log.as_mut() {
                                Some(active_log) => {
                                    replay_failed = !persist_events(
                                        active_log,
                                        events,
                                        &mut conn_write,
                                        &mut history_anchor,
                                        history_sub,
                                    )
                                    .await;
                                }
                                None => discard_events(events),
                            }
                        }
                        if replay_failed {
                            if let Some(failed_log) = log.take() {
                                failed_log.destroy();
                            }
                        }
                        pty_source_offset = pty_source_offset.saturating_add(chunk.len() as u64);
                        if let Some(w) = conn_write.as_mut() {
                            let framed = wire::encode_output(pty_source_offset, &chunk);
                            if wire::write_frame(w, wire::T_OUTPUT, &framed).await.is_err() {
                                conn_write = None;
                            }
                            secret::wipe_vec(framed);
                        }
                    }
                    None => {
                        // Reader thread finished: PTY EOF. Wait for the exit
                        // report on exit_rx (or synthesize one).
                        pty_open = false;
                        let info = (&mut exit_rx).await.unwrap_or(wire::ExitInfo {
                            exit_code: None,
                            signal: None,
                        });
                        tracing::info!(exit_code = ?info.exit_code, signal = ?info.signal, "session exited");
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

            _ = foreground_poll.tick(), if pty_open => {
                if !matches!(state, State::Running) {
                    continue;
                }
                let Some(name) = foreground_name(pty.as_ref()) else {
                    continue;
                };
                if foreground_sent.as_deref() == Some(name.as_str()) {
                    continue;
                }
                if let Some(w) = conn_write.as_mut() {
                    let framed = wire::encode_foreground(&name);
                    if wire::write_frame(w, wire::T_FOREGROUND, &framed).await.is_err() {
                        conn_write = None;
                    } else {
                        foreground_sent = Some(name);
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

    close_supervisor_connection(&mut conn_write, &mut conn_reader).await;
    if let Some(log) = log {
        log.destroy();
    }
    lifecycle_task.abort();
    let _ = lifecycle_task.await;
    identity.cleanup()?;
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
    payload: PlaintextChunk,
    state: &mut State,
    pty: &mut Option<Pty>,
    conn_write: &mut Option<endpoint::WorkerWriteHalf>,
    log: &mut Option<ScrollbackLog>,
    emulator: &mut Option<Emulator>,
    setup: &LogSetup,
    pty_tx: &mut Option<mpsc::Sender<PlaintextChunk>>,
    exit_tx: &mut Option<oneshot::Sender<wire::ExitInfo>>,
    child_state: &SharedChild,
    session_cwd: &mut Option<String>,
    pty_source_offset: u64,
    history_anchor: &mut wire::HistoryAnchor,
    history_sub: &mut bool,
    lifecycle_platform: &LifecyclePlatform,
) -> Result<LoopAction> {
    match frame_type {
        wire::T_START => {
            if !matches!(state, State::AwaitingStart) {
                bail!(
                    "Start received but session is already {}",
                    state_name(state)
                );
            }
            let mut spec: wire::StartSpec = wire::decode_json(&payload)?;
            let canonical_cwd = std::fs::canonicalize(&spec.cwd)
                .context("resolving session cwd capability root")?;
            if !canonical_cwd.is_dir() {
                bail!("session cwd capability root is not a directory");
            }
            spec.cwd = canonical_cwd
                .to_str()
                .context("session cwd capability root is not UTF-8")?
                .to_string();
            let (cols, rows) = (spec.cols.max(1), spec.rows.max(1));
            let opened = ScrollbackLog::with_limits(
                &setup.dir,
                &setup.key,
                setup.segment_bytes,
                setup.max_log_bytes,
            )
            .context("opening scrollback log");
            *log = Some(opened?);
            *emulator = Some(Emulator::new(cols, rows));
            let out_tx = pty_tx.take().context("pty channel already consumed")?;
            let ex_tx = exit_tx.take().context("exit channel already consumed")?;
            let started = spawn_pty(
                &spec,
                out_tx,
                ex_tx,
                Arc::clone(child_state),
                lifecycle_platform,
            )
            .context("spawning session PTY")?;
            let pid = started.pid;
            *session_cwd = Some(spec.cwd.clone());
            *pty = Some(started);
            *state = State::Running;
            if let Some(w) = conn_write.as_mut() {
                let _ = wire::write_json_frame(
                    w,
                    wire::T_STARTED,
                    &wire::Started {
                        pid,
                        cwd: spec.cwd.clone(),
                    },
                )
                .await;
            }
            tracing::info!(pid, "session started");
            Ok(LoopAction::PtyStarted)
        }
        wire::T_INPUT => {
            if let Some(p) = pty {
                p.input_tx
                    .send(payload)
                    .await
                    .map_err(|_| anyhow::anyhow!("session PTY input channel closed"))?;
                #[cfg(windows)]
                p.input_wake.unpark();
            }
            Ok(LoopAction::Continue)
        }
        wire::T_RESIZE => {
            let (cols, rows) = wire::decode_resize(&payload)?;
            if let Some(p) = pty {
                *p.size.lock().unwrap() = (cols, rows);
                resize_master(&p.master, cols, rows);
            }
            // Narrowing can reflow wrapped screen rows off the top; the
            // emulator commits those displaced lines and they are persisted
            // like any scroll-off. Nothing already committed is touched.
            if let Some(emu) = emulator.as_mut() {
                let events = emu.resize(cols, rows);
                let mut replay_failed = false;
                match log.as_mut() {
                    Some(active_log) => {
                        replay_failed = !persist_events(
                            active_log,
                            events,
                            conn_write,
                            history_anchor,
                            *history_sub,
                        )
                        .await;
                    }
                    None => discard_events(events),
                }
                if replay_failed {
                    if let Some(failed_log) = log.take() {
                        failed_log.destroy();
                    }
                }
            }
            Ok(LoopAction::Continue)
        }
        wire::T_REDRAW => {
            // Obsolete: repaints are synthesized from the emulator via replay
            // (`T_REPLAY_REQ`); the session's process is never disturbed.
            tracing::debug!("ignoring redraw request (emulator-backed worker)");
            Ok(LoopAction::Continue)
        }
        wire::T_HISTORY_SUB => {
            *history_sub = true;
            Ok(LoopAction::Continue)
        }
        wire::T_REPLAY_REQ => {
            let max_bytes = wire::decode_replay_req(&payload)?;
            let active_log = log
                .as_mut()
                .context("worker replay is unavailable for this session")?;
            let emu = emulator
                .as_mut()
                .context("worker replay is unavailable before start")?;
            // Self-describing v2 stream: geometry marker + history sentinel +
            // committed lines, then geometry marker + synthesized live screen.
            // The final chunk alone still seeds a live terminal, exactly like
            // the checkpoint-based format it replaces.
            let history = active_log.replay(max_bytes as u64)?;
            let screen = emu.serialize();
            let (cols, rows) = emu.geometry();
            let marker = geometry_marker(cols, rows);
            let mut replay = Vec::with_capacity(
                2 * marker.len() + REPLAY_HISTORY_SENTINEL.len() + history.len() + screen.len(),
            );
            replay.extend_from_slice(&marker);
            replay.extend_from_slice(REPLAY_HISTORY_SENTINEL);
            replay.extend_from_slice(&history);
            replay.extend_from_slice(&marker);
            replay.extend_from_slice(&screen);
            secret::wipe_vec(history);
            secret::wipe_vec(screen);
            if let Some(w) = conn_write.as_mut() {
                // Subscribed supervisors get T_REPLAY2, which carries the
                // history anchor at capture so the client can append later
                // deltas exactly after this replay's content. Unsubscribed
                // (old) daemons would drop the connection on an unknown frame
                // type, so they get the legacy shape.
                let framed = if *history_sub {
                    wire::encode_replay2(pty_source_offset, *history_anchor, &replay)
                } else {
                    wire::encode_replay(pty_source_offset, &replay)
                };
                let frame_type = if *history_sub {
                    wire::T_REPLAY2
                } else {
                    wire::T_REPLAY
                };
                let _ = wire::write_frame(w, frame_type, &framed).await;
                secret::wipe_vec(framed);
            }
            secret::wipe_vec(replay);
            Ok(LoopAction::Continue)
        }
        wire::T_SHUTDOWN => {
            let shutdown: wire::Shutdown = wire::decode_json(&payload)?;
            match pty {
                Some(p) => {
                    let signal = shutdown.signal.unwrap_or(wire::LifecycleSignal::Term);
                    match deliver_signal(&p.child, signal, lifecycle_platform).await {
                        LifecycleOutcome::Delivered | LifecycleOutcome::Gone => {}
                        LifecycleOutcome::Failed => bail!("worker lifecycle delivery failed"),
                    }
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

async fn close_supervisor_connection(
    writer: &mut Option<endpoint::WorkerWriteHalf>,
    reader: &mut Option<JoinHandle<()>>,
) {
    if let Some(mut writer) = writer.take() {
        let _ = writer.shutdown().await;
    }
    if let Some(reader) = reader.take() {
        reader.abort();
        let _ = reader.await;
    }
}

fn spawn_conn_reader(
    mut read_half: endpoint::WorkerReadHalf,
    generation: u64,
    frame_tx: mpsc::Sender<ConnFrame>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            match wire::read_frame_limited(&mut read_half, inbound_frame_limit).await {
                Ok(Some(frame)) => {
                    let (frame_type, payload) = frame;
                    let payload = PlaintextChunk::new(payload);
                    if !inbound_frame_size_exact(frame_type, payload.len()) {
                        tracing::warn!(
                            frame_type,
                            payload_len = payload.len(),
                            "rejecting oversized or malformed worker command frame"
                        );
                        let _ = frame_tx
                            .send(ConnFrame {
                                generation,
                                frame: None,
                            })
                            .await;
                        break;
                    }
                    if frame_tx
                        .send(ConnFrame {
                            generation,
                            frame: Some((frame_type, payload)),
                        })
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(None) | Err(_) => {
                    let _ = frame_tx
                        .send(ConnFrame {
                            generation,
                            frame: None,
                        })
                        .await;
                    break;
                }
            }
        }
    })
}

#[cfg(unix)]
fn command_for_start(spec: &wire::StartSpec) -> Result<(CommandBuilder, String)> {
    let mut command = CommandBuilder::new(&spec.argv[0]);
    command.args(&spec.argv[1..]);
    let basename = std::path::Path::new(&spec.argv[0])
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&spec.argv[0])
        .to_owned();
    Ok((command, basename))
}

#[cfg(windows)]
fn command_for_start(spec: &wire::StartSpec) -> Result<(CommandBuilder, String)> {
    let resolved = resolve_windows_start_program(spec)?;
    let basename = resolved
        .file_name()
        .and_then(|name| name.to_str())
        .context("resolved session command basename is not UTF-8")?
        .to_owned();
    let extension = resolved
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default();
    if extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat") {
        let comspec = env_value_case_insensitive(&spec.env, "ComSpec")
            .unwrap_or_else(|| "cmd.exe".to_owned());
        let command_line = batch_command_string(&resolved, &spec.argv[1..])?;
        let mut command = CommandBuilder::new(comspec);
        command.args(["/e:ON", "/v:OFF", "/d", "/s", "/c"]);
        command.arg(command_line);
        Ok((command, basename))
    } else {
        let mut command = CommandBuilder::new(&resolved);
        command.args(&spec.argv[1..]);
        Ok((command, basename))
    }
}

#[cfg(windows)]
fn resolve_windows_start_program(spec: &wire::StartSpec) -> Result<PathBuf> {
    let requested = std::path::Path::new(&spec.argv[0]);
    let path_ext = env_value_case_insensitive(&spec.env, "PATHEXT")
        .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_owned());
    let extensions: Vec<&str> = path_ext
        .split(';')
        .filter(|extension| !extension.is_empty())
        .collect();

    let mut bases = Vec::new();
    if requested.is_absolute() {
        bases.push(requested.to_path_buf());
    } else if requested.components().count() > 1 {
        bases.push(std::path::Path::new(&spec.cwd).join(requested));
    } else {
        bases.push(std::path::Path::new(&spec.cwd).join(requested));
        if let Some(path) = env_value_case_insensitive(&spec.env, "PATH") {
            bases.extend(
                std::env::split_paths(&OsString::from(path)).map(|dir| dir.join(requested)),
            );
        }
    }

    for base in bases {
        if base.is_file() {
            return Ok(base);
        }
        if base.extension().is_none() {
            for extension in &extensions {
                let extension = extension.strip_prefix('.').unwrap_or(extension);
                let candidate = base.with_extension(extension);
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
    }
    bail!("session command was not found in START PATH/PATHEXT")
}

#[cfg(windows)]
fn env_value_case_insensitive(
    env: &std::collections::BTreeMap<String, String>,
    key: &str,
) -> Option<String> {
    env.iter()
        .find(|(candidate, _)| candidate.eq_ignore_ascii_case(key))
        .map(|(_, value)| value.clone())
}

#[cfg(windows)]
fn batch_command_string(script: &std::path::Path, args: &[String]) -> Result<String> {
    let script = script.to_str().context("batch command path is not UTF-8")?;
    let script = if let Some(unc) = script.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else if let Some(dos) = script.strip_prefix(r"\\?\") {
        dos.to_owned()
    } else {
        script.to_owned()
    };
    if script.contains('"') || script.ends_with('\\') {
        bail!("batch command path is invalid");
    }
    let mut command = String::from("\"");
    append_batch_arg(&mut command, &script, true)?;
    for arg in args {
        command.push(' ');
        append_batch_arg(&mut command, arg, false)?;
    }
    command.push('"');
    Ok(command)
}

#[cfg(windows)]
fn append_batch_arg(command: &mut String, arg: &str, mut quote: bool) -> Result<()> {
    if arg
        .chars()
        .any(|character| matches!(character, '\0' | '\r' | '\n'))
    {
        bail!("batch command argument is invalid");
    }
    if arg.is_empty() || arg.ends_with('\\') {
        quote = true;
    }
    const SAFE_PUNCTUATION: &str = r"#$*+-./:?@\_";
    if arg.chars().any(|character| {
        (character.is_ascii()
            && !(character.is_ascii_alphanumeric() || SAFE_PUNCTUATION.contains(character)))
            || character.is_control()
    }) {
        quote = true;
    }
    if quote {
        command.push('"');
    }
    let mut backslashes = 0usize;
    for character in arg.chars() {
        if character == '\\' {
            backslashes += 1;
            continue;
        }
        if character == '"' {
            command.extend(std::iter::repeat_n('\\', backslashes * 2));
            command.push('"');
        } else {
            command.extend(std::iter::repeat_n('\\', backslashes));
            if character == '%' || character == '\r' {
                command.push_str("%%cd:~,");
            }
        }
        backslashes = 0;
        command.push(character);
    }
    if quote {
        command.extend(std::iter::repeat_n('\\', backslashes * 2));
        command.push('"');
    } else {
        command.extend(std::iter::repeat_n('\\', backslashes));
    }
    Ok(())
}

fn spawn_pty(
    spec: &wire::StartSpec,
    out_tx: mpsc::Sender<PlaintextChunk>,
    exit_tx: oneshot::Sender<wire::ExitInfo>,
    child_state: SharedChild,
    lifecycle_platform: &LifecyclePlatform,
) -> Result<Pty> {
    #[cfg(unix)]
    let _ = lifecycle_platform;
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

    let (mut cmd, _root_foreground) = command_for_start(spec)?;
    // The daemon computes and ships the *complete* environment; do not leak
    // the worker's own env (it may differ after upgrades).
    cmd.env_clear();
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }
    cmd.cwd(&spec.cwd);

    let child = pair
        .slave
        .spawn_command(cmd)
        .context("spawning session command in PTY")?;
    let pid = child.process_id().unwrap_or(0);
    if pid <= 1 || i32::try_from(pid).is_err() {
        bail!("session PTY returned an invalid process id");
    }
    drop(pair.slave);

    {
        let mut state = child_state
            .lock()
            .map_err(|_| anyhow::anyhow!("child state lock poisoned"))?;
        if !matches!(*state, ChildState::AwaitingStart) {
            bail!("session child state is already occupied");
        }
        *state = ChildState::Running { child, pid };
    }

    let mut reader = pair
        .master
        .try_clone_reader()
        .context("cloning PTY reader")?;
    let mut writer = pair.master.take_writer().context("taking PTY writer")?;

    // Blocking writer thread: PTY input can block when the session's process stops
    // reading; keep that off the async loop.
    let (input_tx, mut input_rx) = mpsc::channel::<PlaintextChunk>(PTY_INPUT_QUEUE_DEPTH);
    #[cfg(unix)]
    std::thread::spawn(move || {
        while let Some(bytes) = input_rx.blocking_recv() {
            if writer.write_all(&bytes).is_err() {
                break;
            }
            let _ = writer.flush();
        }
    });
    #[cfg(windows)]
    let input_wake = {
        let (priority_tx, priority_rx) = std::sync::mpsc::sync_channel::<PriorityWrite>(1);
        let thread = std::thread::spawn(move || {
            let mut ordinary_closed = false;
            loop {
                match priority_rx.try_recv() {
                    Ok(control) => {
                        let delivered = if control.cancelled.load(Ordering::Acquire) {
                            false
                        } else {
                            writer.write_all(&[0x03]).is_ok() && writer.flush().is_ok()
                        };
                        let _ = control.completed.send(delivered);
                        continue;
                    }
                    Err(std::sync::mpsc::TryRecvError::Disconnected) if ordinary_closed => break,
                    Err(_) => {}
                }
                if ordinary_closed {
                    std::thread::park_timeout(Duration::from_millis(10));
                    continue;
                }
                match input_rx.try_recv() {
                    Ok(bytes) => {
                        if writer.write_all(&bytes).is_err() {
                            break;
                        }
                        let _ = writer.flush();
                    }
                    Err(mpsc::error::TryRecvError::Empty) => {
                        std::thread::park_timeout(Duration::from_millis(10));
                    }
                    Err(mpsc::error::TryRecvError::Disconnected) => {
                        ordinary_closed = true;
                        std::thread::park_timeout(Duration::from_millis(10));
                    }
                }
            }
        });
        let wake = thread.thread().clone();
        *lifecycle_platform
            .priority_input
            .lock()
            .map_err(|_| anyhow::anyhow!("priority PTY input lock poisoned"))? =
            Some(PriorityInput {
                sender: priority_tx,
                wake: wake.clone(),
            });
        drop(thread);
        wake
    };

    // Blocking reader thread: PTY output -> async loop. Child reaping is
    // intentionally separate so it can share stable ownership with the
    // independent lifecycle listener.
    std::thread::spawn(move || {
        let mut buf = [0u8; PTY_READ_CHUNK_BYTES];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = take_pty_read(&mut buf, n);
                    if out_tx.blocking_send(chunk).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        buf.zeroize();
        drop(out_tx); // closes the channel: signals PTY EOF to the main loop
    });

    let monitor_child = Arc::clone(&child_state);
    tokio::spawn(monitor_child_exit(monitor_child, exit_tx));

    Ok(Pty {
        master: Arc::new(Mutex::new(pair.master)),
        input_tx,
        pid,
        child: child_state,
        size: Arc::new(Mutex::new((spec.cols, spec.rows))),
        #[cfg(windows)]
        input_wake,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LifecycleOutcome {
    Delivered,
    Gone,
    Failed,
}

#[cfg(unix)]
fn signal_owned_child_unix(
    child_state: &SharedChild,
    signal: wire::LifecycleSignal,
) -> LifecycleOutcome {
    use nix::errno::Errno;
    use nix::sys::signal::{killpg, Signal};
    use nix::unistd::Pid;
    let Ok(mut state) = child_state.lock() else {
        return LifecycleOutcome::Failed;
    };
    let ChildState::Running { child, pid } = &mut *state else {
        return LifecycleOutcome::Gone;
    };
    if child.process_id() != Some(*pid) {
        return LifecycleOutcome::Failed;
    }
    let signal = match signal {
        wire::LifecycleSignal::Term => Signal::SIGTERM,
        wire::LifecycleSignal::Kill => Signal::SIGKILL,
    };
    // portable-pty makes this child a session leader, so pgid == pid. The
    // unreaped Child remains locked across validation and this syscall: the
    // numeric identity cannot be recycled. ESRCH is a safe already-gone
    // result. Never fall back to signalling the bare numeric PID.
    match killpg(Pid::from_raw(*pid as i32), signal) {
        Ok(()) => LifecycleOutcome::Delivered,
        Err(Errno::ESRCH) => LifecycleOutcome::Gone,
        Err(error) => {
            tracing::warn!(pid = *pid, %error, "session process-group signal failed");
            LifecycleOutcome::Failed
        }
    }
}

fn validate_owned_child(child_state: &SharedChild) -> LifecycleOutcome {
    let Ok(mut state) = child_state.lock() else {
        return LifecycleOutcome::Failed;
    };
    let ChildState::Running { child, pid } = &mut *state else {
        return LifecycleOutcome::Gone;
    };
    if child.process_id() != Some(*pid) {
        return LifecycleOutcome::Failed;
    }
    LifecycleOutcome::Delivered
}

async fn deliver_signal(
    child_state: &SharedChild,
    signal: wire::LifecycleSignal,
    platform: &LifecyclePlatform,
) -> LifecycleOutcome {
    #[cfg(unix)]
    {
        let _ = platform;
        signal_owned_child_unix(child_state, signal)
    }
    #[cfg(windows)]
    {
        match signal {
            wire::LifecycleSignal::Term => deliver_windows_term(child_state, platform).await,
            wire::LifecycleSignal::Kill => {
                let outcome = validate_owned_child(child_state);
                if outcome == LifecycleOutcome::Delivered && platform.job.terminate().is_err() {
                    return LifecycleOutcome::Failed;
                }
                outcome
            }
        }
    }
}

#[cfg(windows)]
async fn deliver_windows_term(
    child_state: &SharedChild,
    platform: &LifecyclePlatform,
) -> LifecycleOutcome {
    let outcome = validate_owned_child(child_state);
    if outcome != LifecycleOutcome::Delivered {
        return outcome;
    }
    let priority = match platform.priority_input.lock() {
        Ok(priority) => priority.clone(),
        Err(_) => return LifecycleOutcome::Failed,
    };
    let Some(priority) = priority else {
        return LifecycleOutcome::Gone;
    };
    let cancelled = Arc::new(AtomicBool::new(false));
    let (completed, response) = oneshot::channel();
    if priority
        .sender
        .try_send(PriorityWrite {
            cancelled: Arc::clone(&cancelled),
            completed,
        })
        .is_err()
    {
        return LifecycleOutcome::Failed;
    }
    priority.wake.unpark();
    match tokio::time::timeout(Duration::from_millis(100), response).await {
        Ok(Ok(true)) => LifecycleOutcome::Delivered,
        Ok(_) => LifecycleOutcome::Failed,
        Err(_) => {
            cancelled.store(true, Ordering::Release);
            LifecycleOutcome::Failed
        }
    }
}

#[cfg(unix)]
fn foreground_name(pty: Option<&Pty>) -> Option<String> {
    let master_fd =
        pty.and_then(|pty| pty.master.lock().ok().and_then(|master| master.as_raw_fd()))?;
    super::foreground::foreground_basename(master_fd)
}

#[cfg(windows)]
fn foreground_name(pty: Option<&Pty>) -> Option<String> {
    pty.and_then(|pty| super::foreground::foreground_basename(pty.pid))
}

async fn monitor_child_exit(child_state: SharedChild, exit_tx: oneshot::Sender<wire::ExitInfo>) {
    loop {
        let info = match child_state.lock() {
            Err(_) => Some(wire::ExitInfo {
                exit_code: None,
                signal: Some("wait_failed".into()),
            }),
            Ok(mut state) => match &mut *state {
                ChildState::Running { child, .. } => match child.try_wait() {
                    Ok(Some(status)) => {
                        let info = wire::ExitInfo {
                            exit_code: Some(status.exit_code() as i32),
                            signal: None,
                        };
                        *state = ChildState::Exited;
                        Some(info)
                    }
                    Ok(None) => None,
                    Err(_) => {
                        *state = ChildState::Exited;
                        Some(wire::ExitInfo {
                            exit_code: None,
                            signal: Some("wait_failed".into()),
                        })
                    }
                },
                ChildState::Exited => return,
                ChildState::AwaitingStart => None,
            },
        };
        if let Some(info) = info {
            let _ = exit_tx.send(info);
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn run_lifecycle_listener(
    mut listener: endpoint::LifecycleListener,
    instance_id: Uuid,
    child_state: SharedChild,
    session_id: Uuid,
    platform: LifecyclePlatform,
) {
    // The endpoint owns the fixed-size receive buffers and platform resource
    // bounds: one atomic datagram task on Unix, or seven expiring message-pipe
    // handlers on Windows. This loop allocates nothing per request.
    loop {
        let Ok(exchange) = endpoint::receive_lifecycle(&mut listener).await else {
            break;
        };
        let (request, len) = exchange.request();
        #[cfg(windows)]
        let mut terminate_after_ack = false;
        let ack = if len != wire::LIFECYCLE_REQUEST_LEN {
            wire::LIFECYCLE_ACK_FAILED
        } else {
            let exact: &[u8; wire::LIFECYCLE_REQUEST_LEN] = request[..len]
                .try_into()
                .expect("validated lifecycle datagram length");
            match wire::decode_lifecycle_request(exact) {
                Ok((requested_instance, _)) if requested_instance != instance_id => {
                    wire::LIFECYCLE_ACK_WRONG_INSTANCE
                }
                Ok((_, signal)) => {
                    #[cfg(windows)]
                    let defer_kill = signal == wire::LifecycleSignal::Kill;
                    #[cfg(unix)]
                    let defer_kill = false;
                    let outcome = if defer_kill {
                        validate_owned_child(&child_state)
                    } else {
                        deliver_signal(&child_state, signal, &platform).await
                    };
                    #[cfg(windows)]
                    if defer_kill && outcome == LifecycleOutcome::Delivered {
                        terminate_after_ack = true;
                    }
                    match outcome {
                        LifecycleOutcome::Delivered => wire::LIFECYCLE_ACK_DELIVERED,
                        LifecycleOutcome::Gone => wire::LIFECYCLE_ACK_GONE,
                        LifecycleOutcome::Failed => wire::LIFECYCLE_ACK_FAILED,
                    }
                }
                Err(_) => wire::LIFECYCLE_ACK_FAILED,
            }
        };
        if endpoint::acknowledge_lifecycle(&mut listener, exchange, ack)
            .await
            .is_err()
        {
            tracing::debug!(%session_id, "lifecycle requester closed before acknowledgement");
        }
        #[cfg(windows)]
        if terminate_after_ack && ack == wire::LIFECYCLE_ACK_DELIVERED {
            let _ = platform.job.terminate();
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::net::UnixDatagram;

    #[test]
    fn parse_args_requires_the_essentials() {
        let args = |list: &[&str]| parse_args(list.iter().map(|s| s.to_string()));
        assert!(args(&["--socket", "/tmp/x.sock"]).is_err());
        let ok = args(&[
            "--socket",
            "/tmp/x.sock",
            "--session-id",
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

    #[test]
    fn pty_read_scratch_is_wiped_immediately() {
        let mut scratch = [0u8; 32];
        scratch[..9].copy_from_slice(b"sensitive");
        let chunk = take_pty_read(&mut scratch, 9);
        assert_eq!(&*chunk, b"sensitive");
        assert!(scratch[..9].iter().all(|byte| *byte == 0));
    }

    #[test]
    fn worker_command_frames_have_type_specific_limits() {
        assert!(inbound_frame_size_allowed(
            wire::T_START,
            MAX_START_FRAME_BYTES
        ));
        assert!(!inbound_frame_size_allowed(
            wire::T_START,
            MAX_START_FRAME_BYTES + 1
        ));
        assert!(inbound_frame_size_allowed(
            wire::T_INPUT,
            MAX_PTY_INPUT_FRAME_BYTES
        ));
        assert!(!inbound_frame_size_allowed(
            wire::T_INPUT,
            MAX_PTY_INPUT_FRAME_BYTES + 1
        ));
        assert!(inbound_frame_size_allowed(wire::T_RESIZE, 4));
        assert!(!inbound_frame_size_allowed(wire::T_RESIZE, 5));
        assert!(!inbound_frame_size_allowed(wire::T_REDRAW, 1));
    }

    #[tokio::test]
    async fn stalled_consumer_caps_chunks_and_zeroizes_drops() {
        let (tx, mut rx) = pty_output_channel();
        for index in 0..PTY_OUTPUT_QUEUE_DEPTH {
            tx.try_send(PlaintextChunk::new(vec![index as u8; PTY_READ_CHUNK_BYTES]))
                .unwrap();
        }
        assert_eq!(tx.capacity(), 0);

        let wiped = Arc::new(AtomicBool::new(false));
        let wiped_probe = Arc::clone(&wiped);
        let rejected = PlaintextChunk::with_wipe_probe(
            b"must-wipe-on-backpressure".to_vec(),
            Arc::new(move |bytes| {
                wiped_probe.store(bytes.iter().all(|byte| *byte == 0), Ordering::Release);
            }),
        );
        let error = tx.try_send(rejected).unwrap_err();
        assert!(matches!(error, mpsc::error::TrySendError::Full(_)));
        drop(error);
        assert!(wiped.load(Ordering::Acquire));

        // Releasing exactly one slot admits exactly one more fixed-size read;
        // no hidden unbounded side queue exists in the production handoff.
        drop(rx.recv().await.unwrap());
        assert_eq!(tx.capacity(), 1);
        tx.try_send(PlaintextChunk::new(vec![0x5a; PTY_READ_CHUNK_BYTES]))
            .unwrap();
        assert_eq!(tx.capacity(), 0);
    }

    #[tokio::test]
    async fn exited_child_identity_cannot_signal_an_unrelated_process_after_pid_churn() {
        use std::os::unix::process::CommandExt;

        let child = std::process::Command::new("/usr/bin/true")
            .process_group(0)
            .spawn()
            .expect("short-lived child");
        let pid = child.id();
        let child_state = Arc::new(Mutex::new(ChildState::Running {
            child: Box::new(child),
            pid,
        }));
        let (exit_tx, exit_rx) = oneshot::channel();
        let monitor_state = Arc::clone(&child_state);
        tokio::spawn(monitor_child_exit(monitor_state, exit_tx));
        tokio::time::timeout(Duration::from_secs(3), exit_rx)
            .await
            .expect("child reap timed out")
            .expect("exit monitor dropped");

        // Exercise allocator/PID churn after the stable child was reaped.
        for _ in 0..128 {
            std::process::Command::new("/usr/bin/true")
                .status()
                .expect("pid churn child");
        }
        let mut unrelated = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("while :; do sleep 1; done")
            .process_group(0)
            .spawn()
            .expect("unrelated sentinel");

        assert_eq!(
            signal_owned_child_unix(&child_state, wire::LifecycleSignal::Kill),
            LifecycleOutcome::Gone
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            unrelated.try_wait().expect("sentinel status").is_none(),
            "late KILL reached an unrelated process"
        );
        unrelated.kill().expect("clean sentinel");
        unrelated.wait().expect("reap sentinel");
    }

    #[tokio::test]
    async fn lifecycle_listener_rejects_a_stale_worker_instance_without_signaling() {
        use std::os::unix::process::CommandExt;

        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("session.lifecycle.sock");
        let listener = UnixDatagram::bind(&socket).unwrap();
        let child = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("while :; do sleep 1; done")
            .process_group(0)
            .spawn()
            .expect("worker-owned sentinel");
        let pid = child.id();
        let child_state = Arc::new(Mutex::new(ChildState::Running {
            child: Box::new(child),
            pid,
        }));
        let current_instance = Uuid::new_v4();
        let task = tokio::spawn(run_lifecycle_listener(
            listener,
            current_instance,
            Arc::clone(&child_state),
            Uuid::new_v4(),
            LifecyclePlatform,
        ));

        let client_path = dir.path().join("client.sock");
        let client = UnixDatagram::bind(&client_path).unwrap();
        client
            .send_to(
                &wire::encode_lifecycle_request(Uuid::new_v4(), wire::LifecycleSignal::Kill),
                &socket,
            )
            .await
            .unwrap();
        let mut ack = [0u8; 1];
        client.recv(&mut ack).await.unwrap();
        assert_eq!(ack[0], wire::LIFECYCLE_ACK_WRONG_INSTANCE);

        {
            let mut state = child_state.lock().unwrap();
            let ChildState::Running { child, .. } = &mut *state else {
                panic!("stale instance changed child state");
            };
            assert!(child.try_wait().unwrap().is_none());
        }
        assert_eq!(
            signal_owned_child_unix(&child_state, wire::LifecycleSignal::Kill),
            LifecycleOutcome::Delivered
        );
        let mut owned =
            match std::mem::replace(&mut *child_state.lock().unwrap(), ChildState::Exited) {
                ChildState::Running { child, .. } => child,
                _ => panic!("missing owned child"),
            };
        owned.wait().expect("reap worker-owned sentinel");
        task.abort();
    }

    #[tokio::test]
    async fn lifecycle_datagrams_remain_fair_under_replenished_partial_flood() {
        use std::os::unix::process::CommandExt;

        let dir = tempfile::tempdir().unwrap();
        let server_path = dir.path().join("session.lifecycle.sock");
        let listener = UnixDatagram::bind(&server_path).unwrap();
        let child = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("trap '' TERM; while :; do sleep 1; done")
            .process_group(0)
            .spawn()
            .expect("signal-resistant child");
        let pid = child.id();
        let child_state = Arc::new(Mutex::new(ChildState::Running {
            child: Box::new(child),
            pid,
        }));
        let instance = Uuid::new_v4();
        let server = tokio::spawn(run_lifecycle_listener(
            listener,
            instance,
            Arc::clone(&child_state),
            Uuid::new_v4(),
            LifecyclePlatform,
        ));

        let attacker_path = dir.path().join("attacker.sock");
        let attacker = UnixDatagram::bind(&attacker_path).unwrap();
        let attack_server = server_path.clone();
        let flood = tokio::spawn(async move {
            let until = tokio::time::Instant::now() + Duration::from_millis(750);
            while tokio::time::Instant::now() < until {
                let _ = attacker.try_send_to(&[0xAA], &attack_server);
                tokio::task::yield_now().await;
            }
        });

        let client_path = dir.path().join("legitimate.sock");
        let client = UnixDatagram::bind(&client_path).unwrap();
        client.connect(&server_path).unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;

        async fn deliver(client: &UnixDatagram, request: &[u8; wire::LIFECYCLE_REQUEST_LEN]) -> u8 {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
            loop {
                assert!(tokio::time::Instant::now() < deadline, "delivery starved");
                if client.send(request).await.is_ok() {
                    let mut ack = [0u8; 2];
                    if let Ok(Ok(1)) =
                        tokio::time::timeout(Duration::from_millis(100), client.recv(&mut ack))
                            .await
                    {
                        return ack[0];
                    }
                }
                tokio::task::yield_now().await;
            }
        }

        assert_eq!(
            deliver(
                &client,
                &wire::encode_lifecycle_request(instance, wire::LifecycleSignal::Term),
            )
            .await,
            wire::LIFECYCLE_ACK_DELIVERED
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
        {
            let mut state = child_state.lock().unwrap();
            let ChildState::Running { child, .. } = &mut *state else {
                panic!("TERM changed stable child ownership");
            };
            assert!(child.try_wait().unwrap().is_none(), "TERM was not ignored");
        }
        assert_eq!(
            deliver(
                &client,
                &wire::encode_lifecycle_request(instance, wire::LifecycleSignal::Kill),
            )
            .await,
            wire::LIFECYCLE_ACK_DELIVERED
        );

        let mut owned =
            match std::mem::replace(&mut *child_state.lock().unwrap(), ChildState::Exited) {
                ChildState::Running { child, .. } => child,
                _ => panic!("missing stable child after KILL"),
            };
        owned.wait().expect("reap killed child");
        flood.await.unwrap();
        server.abort();
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    #[test]
    fn batch_wrapper_quotes_spaces_and_neutralizes_metacharacters() {
        let command = batch_command_string(
            std::path::Path::new(r"C:\Program Files\SPAWN D\claude.cmd"),
            &["two words".into(), "a&b|c<d>e^f(g)h%i!j".into()],
        )
        .unwrap();
        assert!(command.starts_with(r#"""C:\Program Files\SPAWN D\claude.cmd""#));
        assert!(command.contains(r#""two words""#));
        assert!(command.contains("%%cd:~,%"));
        assert!(!command.contains("%%cd:~,%%"));
        assert!(command.ends_with('"'));
    }

    #[test]
    fn batch_wrapper_rejects_line_break_injection() {
        assert!(batch_command_string(
            std::path::Path::new(r"C:\spawn\claude.cmd"),
            &["safe\r\nwhoami".into()],
        )
        .is_err());
    }

    #[test]
    fn batch_wrapper_converts_verbatim_unc_paths_for_cmd() {
        let command = batch_command_string(
            std::path::Path::new(r"\\?\UNC\server\share\claude.cmd"),
            &[],
        )
        .unwrap();
        assert!(command.contains(r"\\server\share\claude.cmd"));
        assert!(!command.contains(r"\\?\UNC"));
    }
}
