//! The session worker runtime: one process per agent, owning the agent's PTY.
//!
//! Lifecycle:
//! 1. `spawn-worker --socket <p> --agent-id <uuid> --log-dir <p>` binds the
//!    ordinary unix socket and an independent lifecycle socket, then waits
//!    for the supervising `spawnd` to connect.
//! 2. Every accepted connection is greeted with a `Hello` frame carrying the
//!    worker's state, so a freshly restarted `spawnd` can adopt a running
//!    worker with no persistent handshake state.
//! 3. `Start` spawns the agent argv on a PTY the worker owns. Raw output
//!    feeds a headless screen emulator (`sessiond::emulator`), is encrypted
//!    into the scrollback log before any disk write, then forwarded through a
//!    bounded connection queue; plaintext chunks and PTY scratch are zeroized
//!    after each hop/drop. Log rotations checkpoint the emulator's serialized
//!    screen — the agent process is never signaled to provoke a repaint.
//! 4. On PTY EOF the worker reports `Exit`, deletes its scrollback (the key
//!    dies with the process anyway), unlinks its socket, and exits.
//!
//! The agent's fate is tied to the worker (the worker holds the PTY master),
//! but NOT to spawnd: the worker runs in its own process group and keeps
//! serving across spawnd restarts/upgrades without an intermediate terminal
//! multiplexer.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::unix::OwnedWriteHalf;
use tokio::net::UnixListener;
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;
use zeroize::Zeroize;

use super::boundary::SeqScanner;
use super::emulator::Emulator;
use super::scrollback::{Checkpoint, ScrollbackLog};
use super::secret::{self, SecretBytes};
use super::wire;

/// A checkpoint waiting for an escape-sequence boundary in the output stream
/// (splitting a sequence across segments would garble replays).
#[derive(Clone, Copy, PartialEq)]
enum PendingCheckpoint {
    Rotate,
    Resize,
}

/// If no boundary shows up within this many deferred bytes (pathological
/// endless string), checkpoint anyway — a bounded rare glitch beats an
/// unbounded segment.
const CHECKPOINT_DEFER_CAP: usize = 32 * 1024;
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
const MAX_PTY_INPUT_FRAME_BYTES: usize = 256 * 1024;
const MAX_JSON_COMMAND_FRAME_BYTES: usize = 16 * 1024;

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

fn inbound_frame_size_allowed(frame_type: u8, len: usize) -> bool {
    match frame_type {
        wire::T_START => len <= MAX_START_FRAME_BYTES,
        wire::T_INPUT => len <= MAX_PTY_INPUT_FRAME_BYTES,
        wire::T_RESIZE => len == 4,
        wire::T_REDRAW => len == 0,
        wire::T_REPLAY_REQ => len == 4,
        wire::T_SHUTDOWN => len <= MAX_JSON_COMMAND_FRAME_BYTES,
        _ => len <= MAX_JSON_COMMAND_FRAME_BYTES,
    }
}

#[derive(Default)]
struct CheckpointGate {
    scanner: SeqScanner,
    pending: Option<PendingCheckpoint>,
    deferred_bytes: usize,
}

/// Serialize the emulator and cut the log: a rotation for size-triggered
/// checkpoints, a geometry checkpoint for resize-triggered ones.
fn checkpoint_now(
    log: &mut ScrollbackLog,
    emulator: &mut Emulator,
    kind: PendingCheckpoint,
) -> bool {
    let (cols, rows) = emulator.geometry();
    let state = emulator.serialize();
    let checkpoint = Checkpoint {
        cols,
        rows,
        state: &state,
    };
    let result = match kind {
        PendingCheckpoint::Rotate => log.rotate(&checkpoint),
        PendingCheckpoint::Resize => log.resize_checkpoint(&checkpoint),
    };
    let succeeded = match result {
        Ok(()) => true,
        Err(error) => {
            tracing::warn!(%error, "checkpoint failed; disabling replay for this worker");
            false
        }
    };
    secret::wipe_vec(state);
    succeeded
}

/// Feed bytes to the emulator and the log; a due rotation is queued on the
/// gate (checkpoints land only on sequence boundaries).
fn ingest(
    emu: &mut Emulator,
    log: &mut ScrollbackLog,
    bytes: &[u8],
    gate: &mut CheckpointGate,
) -> bool {
    if bytes.is_empty() {
        return true;
    }
    emu.feed(bytes);
    match log.append_output(bytes) {
        Ok(true) => {
            if gate.pending.is_none() {
                gate.pending = Some(PendingCheckpoint::Rotate);
            }
            true
        }
        Ok(false) => true,
        Err(error) => {
            tracing::warn!(%error, "scrollback append failed; disabling replay for this worker");
            false
        }
    }
}

/// How long a worker with no agent yet waits for `Start` before giving up.
const AWAIT_START_TIMEOUT: Duration = Duration::from_secs(120);
/// After the agent exits, how long the worker lingers to deliver `Exit` to a
/// (re)connecting spawnd before cleaning up regardless.
const EXIT_LINGER: Duration = Duration::from_secs(60);

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
    input_tx: mpsc::Sender<PlaintextChunk>,
    pid: u32,
    child: SharedChild,
    /// Desired size; jiggles always restore to this.
    size: Arc<Mutex<(u16, u16)>>,
}

type SharedChild = Arc<Mutex<ChildState>>;

/// The unreaped child handle is the stable process identity. Lifecycle
/// signaling and the exit monitor both hold this same lock, so the PID cannot
/// be reused between validation and `killpg` and reaping cannot race a signal.
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
/// initial checkpoint needs the agent's geometry, which arrives with the
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
        tracing::warn!("mlock failed for scrollback key; key may be swappable (RLIMIT_MEMLOCK?)");
    }
    let setup = LogSetup {
        dir: args.log_dir.clone(),
        segment_bytes: args.segment_bytes,
        max_log_bytes: args.max_log_bytes,
        key,
    };
    let mut log: Option<ScrollbackLog> = None;
    let mut emulator: Option<Emulator> = None;
    let mut gate = CheckpointGate::default();

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
    let lifecycle_socket = wire::lifecycle_socket_path(&args.socket);
    let _ = std::fs::remove_file(&lifecycle_socket);
    let listener = UnixListener::bind(&args.socket)
        .with_context(|| format!("binding {}", args.socket.display()))?;
    let lifecycle_listener = UnixListener::bind(&lifecycle_socket)
        .with_context(|| format!("binding {}", lifecycle_socket.display()))?;
    let instance_id = Uuid::new_v4();
    let child_state = Arc::new(Mutex::new(ChildState::AwaitingStart));
    let lifecycle_task = tokio::spawn(run_lifecycle_listener(
        lifecycle_listener,
        instance_id,
        Arc::clone(&child_state),
        args.agent_id,
    ));
    tracing::info!(agent_id = %args.agent_id, socket = %args.socket.display(), "worker listening");

    let (frame_tx, mut frame_rx) = mpsc::channel::<ConnFrame>(CONNECTION_FRAME_QUEUE_DEPTH);
    let (pty_tx, mut pty_rx) = pty_output_channel();
    let (exit_tx, mut exit_rx) = oneshot::channel::<wire::ExitInfo>();
    let mut exit_tx = Some(exit_tx);
    let mut pty_tx = Some(pty_tx);

    let mut state = State::AwaitingStart;
    let mut pty: Option<Pty> = None;
    let mut conn_write: Option<OwnedWriteHalf> = None;
    let mut generation: u64 = 0;
    let mut pty_open = false;
    let mut exit_reported = false;
    let mut pty_source_offset = 0u64;

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
                    instance_id,
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

            Some(mut conn_frame) = frame_rx.recv() => {
                if conn_frame.generation != generation {
                    continue; // frame from a displaced connection
                }
                let Some((frame_type, payload)) = conn_frame.frame.take() else {
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
                    &mut emulator,
                    &mut gate,
                    &setup,
                    &mut pty_tx,
                    &mut exit_tx,
                    &child_state,
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
                    Some(chunk) => {
                        // Feed the screen emulator, encrypt before any disk
                        // write, then forward live. Checkpoints only land
                        // on escape-sequence boundaries; the agent process is
                        // never signaled or disturbed by any of it.
                        let mut replay_failed = false;
                        if let (Some(emu), Some(active_log)) = (emulator.as_mut(), log.as_mut()) {
                            let split = match gate.pending {
                                Some(_) => gate.scanner.first_boundary(&chunk),
                                None => {
                                    gate.scanner.scan(&chunk);
                                    None
                                }
                            };
                            match (gate.pending, split) {
                                (Some(kind), Some(i)) => {
                                    replay_failed = !ingest(emu, active_log, &chunk[..i], &mut gate);
                                    if !replay_failed {
                                        replay_failed = !checkpoint_now(active_log, emu, kind);
                                    }
                                    if !replay_failed {
                                        gate.pending = None;
                                        gate.deferred_bytes = 0;
                                        replay_failed =
                                            !ingest(emu, active_log, &chunk[i..], &mut gate);
                                    }
                                }
                                (Some(kind), None) => {
                                    replay_failed = !ingest(emu, active_log, &chunk, &mut gate);
                                    if !replay_failed {
                                        gate.deferred_bytes += chunk.len();
                                    }
                                    if !replay_failed && gate.deferred_bytes > CHECKPOINT_DEFER_CAP {
                                        replay_failed = !checkpoint_now(active_log, emu, kind);
                                        gate.pending = None;
                                        gate.deferred_bytes = 0;
                                    }
                                }
                                (None, _) => {
                                    replay_failed = !ingest(emu, active_log, &chunk, &mut gate);
                                }
                            }
                            // A checkpoint that became due in this chunk can
                            // land right away when the stream sits at a
                            // sequence boundary.
                            if !replay_failed && gate.scanner.at_boundary() {
                                if let Some(kind) = gate.pending {
                                    replay_failed = !checkpoint_now(active_log, emu, kind);
                                    gate.pending = None;
                                    gate.deferred_bytes = 0;
                                }
                            }
                        }
                        if replay_failed {
                            gate.pending = None;
                            gate.deferred_bytes = 0;
                            if let Some(failed_log) = log.take() {
                                failed_log.destroy();
                            }
                        }
                        pty_source_offset = pty_source_offset.saturating_add(chunk.len() as u64);
                        debug_assert!(log
                            .as_ref()
                            .is_none_or(|active_log| active_log.total_logged() == pty_source_offset));
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
    if let Some(log) = log {
        log.destroy();
    }
    lifecycle_task.abort();
    let _ = std::fs::remove_file(&args.socket);
    let _ = std::fs::remove_file(&lifecycle_socket);
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
    conn_write: &mut Option<OwnedWriteHalf>,
    log: &mut Option<ScrollbackLog>,
    emulator: &mut Option<Emulator>,
    gate: &mut CheckpointGate,
    setup: &LogSetup,
    pty_tx: &mut Option<mpsc::Sender<PlaintextChunk>>,
    exit_tx: &mut Option<oneshot::Sender<wire::ExitInfo>>,
    child_state: &SharedChild,
) -> Result<LoopAction> {
    match frame_type {
        wire::T_START => {
            if !matches!(state, State::AwaitingStart) {
                bail!("Start received but agent is already {}", state_name(state));
            }
            let spec: wire::StartSpec = wire::decode_json(&payload)?;
            let (cols, rows) = (spec.cols.max(1), spec.rows.max(1));
            let mut emu = Emulator::new(cols, rows);
            let initial = emu.serialize();
            let opened = ScrollbackLog::with_limits(
                &setup.dir,
                &setup.key,
                setup.segment_bytes,
                setup.max_log_bytes,
                Checkpoint {
                    cols,
                    rows,
                    state: &initial,
                },
            )
            .context("opening scrollback log");
            secret::wipe_vec(initial);
            *log = Some(opened?);
            *emulator = Some(emu);
            let out_tx = pty_tx.take().context("pty channel already consumed")?;
            let ex_tx = exit_tx.take().context("exit channel already consumed")?;
            let started = spawn_pty(&spec, out_tx, ex_tx, Arc::clone(child_state))
                .context("spawning agent PTY")?;
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
                p.input_tx
                    .send(payload)
                    .await
                    .map_err(|_| anyhow::anyhow!("agent PTY input channel closed"))?;
            }
            Ok(LoopAction::Continue)
        }
        wire::T_RESIZE => {
            let (cols, rows) = wire::decode_resize(&payload)?;
            if let Some(p) = pty {
                *p.size.lock().unwrap() = (cols, rows);
                resize_master(&p.master, cols, rows);
            }
            // A resize forces a checkpoint at the new geometry so every log
            // segment stays single-geometry and the final replay chunk is
            // always self-contained at the current size. Deferred to the
            // next escape-sequence boundary when the stream is mid-sequence;
            // a resize supersedes a pending size rotation (it rotates too).
            if let Some(emu) = emulator.as_mut() {
                emu.resize(cols, rows);
                let mut replay_failed = false;
                if let Some(active_log) = log.as_mut() {
                    if gate.pending.is_none() && gate.scanner.at_boundary() {
                        replay_failed = !checkpoint_now(active_log, emu, PendingCheckpoint::Resize);
                    } else {
                        gate.pending = Some(PendingCheckpoint::Resize);
                    }
                }
                if replay_failed {
                    gate.pending = None;
                    gate.deferred_bytes = 0;
                    if let Some(failed_log) = log.take() {
                        failed_log.destroy();
                    }
                }
            }
            Ok(LoopAction::Continue)
        }
        wire::T_REDRAW => {
            // Obsolete: repaints are synthesized from the emulator via replay
            // (`T_REPLAY_REQ`); the agent process is never disturbed.
            tracing::debug!("ignoring redraw request (emulator-backed worker)");
            Ok(LoopAction::Continue)
        }
        wire::T_REPLAY_REQ => {
            let max_bytes = wire::decode_replay_req(&payload)?;
            let active_log = log
                .as_mut()
                .context("worker replay is unavailable for this agent")?;
            let replay = active_log.replay(max_bytes as u64)?;
            let watermark = active_log.total_logged();
            if let Some(w) = conn_write.as_mut() {
                let framed = wire::encode_replay(watermark, &replay);
                let _ = wire::write_frame(w, wire::T_REPLAY, &framed).await;
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
                    match signal_owned_child(&p.child, signal) {
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

fn spawn_conn_reader(
    mut read_half: tokio::net::unix::OwnedReadHalf,
    generation: u64,
    frame_tx: mpsc::Sender<ConnFrame>,
) {
    tokio::spawn(async move {
        loop {
            match wire::read_frame(&mut read_half).await {
                Ok(Some(frame)) => {
                    let (frame_type, payload) = frame;
                    let payload = PlaintextChunk::new(payload);
                    if !inbound_frame_size_allowed(frame_type, payload.len()) {
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
    });
}

fn spawn_pty(
    spec: &wire::StartSpec,
    out_tx: mpsc::Sender<PlaintextChunk>,
    exit_tx: oneshot::Sender<wire::ExitInfo>,
    child_state: SharedChild,
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

    let child = pair
        .slave
        .spawn_command(cmd)
        .context("spawning agent in PTY")?;
    let pid = child.process_id().unwrap_or(0);
    if pid <= 1 || i32::try_from(pid).is_err() {
        bail!("agent PTY returned an invalid process id");
    }
    drop(pair.slave);

    {
        let mut state = child_state
            .lock()
            .map_err(|_| anyhow::anyhow!("child state lock poisoned"))?;
        if !matches!(*state, ChildState::AwaitingStart) {
            bail!("agent child state is already occupied");
        }
        *state = ChildState::Running { child, pid };
    }

    let mut reader = pair
        .master
        .try_clone_reader()
        .context("cloning PTY reader")?;
    let mut writer = pair.master.take_writer().context("taking PTY writer")?;

    // Blocking writer thread: PTY input can block when the agent stops
    // reading; keep that off the async loop.
    let (input_tx, mut input_rx) = mpsc::channel::<PlaintextChunk>(PTY_INPUT_QUEUE_DEPTH);
    std::thread::spawn(move || {
        while let Some(bytes) = input_rx.blocking_recv() {
            if writer.write_all(&bytes).is_err() {
                break;
            }
            let _ = writer.flush();
        }
    });

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

fn signal_owned_child(
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
            tracing::warn!(pid = *pid, %error, "agent process-group signal failed");
            LifecycleOutcome::Failed
        }
    }
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
    listener: UnixListener,
    instance_id: Uuid,
    child_state: SharedChild,
    agent_id: Uuid,
) {
    loop {
        let Ok((mut stream, _)) = listener.accept().await else {
            break;
        };
        let mut request = [0u8; wire::LIFECYCLE_REQUEST_LEN];
        let ack =
            match tokio::time::timeout(Duration::from_millis(500), stream.read_exact(&mut request))
                .await
            {
                Ok(Ok(_)) => match wire::decode_lifecycle_request(&request) {
                    Ok((requested_instance, _)) if requested_instance != instance_id => {
                        wire::LIFECYCLE_ACK_WRONG_INSTANCE
                    }
                    Ok((_, signal)) => match signal_owned_child(&child_state, signal) {
                        LifecycleOutcome::Delivered => wire::LIFECYCLE_ACK_DELIVERED,
                        LifecycleOutcome::Gone => wire::LIFECYCLE_ACK_GONE,
                        LifecycleOutcome::Failed => wire::LIFECYCLE_ACK_FAILED,
                    },
                    Err(_) => wire::LIFECYCLE_ACK_FAILED,
                },
                _ => wire::LIFECYCLE_ACK_FAILED,
            };
        if stream.write_all(&[ack]).await.is_err() {
            tracing::debug!(%agent_id, "lifecycle requester closed before acknowledgement");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

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

        let child = std::process::Command::new("/bin/true")
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
            std::process::Command::new("/bin/true")
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
            signal_owned_child(&child_state, wire::LifecycleSignal::Kill),
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
        let socket = dir.path().join("agent.lifecycle.sock");
        let listener = UnixListener::bind(&socket).unwrap();
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
        ));

        let mut stream = tokio::net::UnixStream::connect(&socket).await.unwrap();
        stream
            .write_all(&wire::encode_lifecycle_request(
                Uuid::new_v4(),
                wire::LifecycleSignal::Kill,
            ))
            .await
            .unwrap();
        let mut ack = [0u8; 1];
        stream.read_exact(&mut ack).await.unwrap();
        assert_eq!(ack[0], wire::LIFECYCLE_ACK_WRONG_INSTANCE);

        {
            let mut state = child_state.lock().unwrap();
            let ChildState::Running { child, .. } = &mut *state else {
                panic!("stale instance changed child state");
            };
            assert!(child.try_wait().unwrap().is_none());
        }
        assert_eq!(
            signal_owned_child(&child_state, wire::LifecycleSignal::Kill),
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
}
