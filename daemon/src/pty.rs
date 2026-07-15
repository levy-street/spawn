//! Per-agent PTY + tmux session management.
//!
//! For each `agent.create`:
//!   1. `tmux new-session -d -s spawn-<name>--<id>` launches the real argv detached,
//!      with the final env injected into the pane process. Spawn does not
//!      manage agent credentials — the daemon's process env (HOME,
//!      XDG_CONFIG_HOME, PATH, etc.) flows through, and the agent CLI finds
//!      whatever it logged in with on the host.
//!   2. We open a portable_pty PTY and spawn `tmux attach -t <session>`
//!      inside it. A blocking reader thread pushes raw PTY bytes into a
//!      per-agent **outbox** (an unbounded mpsc). A long-lived per-agent
//!      **forwarder** task encodes those bytes as binary frames and ships
//!      them to the WS session's outbound sink. Stdin from the WS goes into
//!      the PTY's writer.
//!
//! The reader thread + forwarder task survive across WS reconnects: the
//! WS session installs/clears the forwarder's sink on connect/disconnect,
//! and the outbox buffers any bytes received in between. This is what makes
//! "bounce uvicorn while an agent is running" not break the agent.
//!
//! Because tmux owns the underlying agent process, the agent also survives
//! `spawnd` restarts (see `reattach`).

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex, Notify};
use uuid::Uuid;

use crate::activity;
use crate::frames;
use crate::proto::Outbound;
use crate::tmux;

#[derive(Clone, Debug)]
pub enum WsOutbound {
    /// A serialized JSON frame.
    Json(String),
    /// A binary frame already encoded (`kind|agent_id|payload`).
    Binary(Vec<u8>),
}

/// The thing the WS session hands to a per-agent forwarder so that bytes
/// route to the current connection.
pub type SessionSink = mpsc::Sender<WsOutbound>;
pub type DirectSink = mpsc::UnboundedSender<Vec<u8>>;

#[derive(Clone, Copy, Debug)]
pub(crate) enum ActivityKind {
    Output,
    Input,
}

/// The only activity serializer: its API cannot accept terminal bytes or any
/// content-carrying outbound frame.
fn activity_message(agent_id: Uuid, kind: ActivityKind) -> Option<WsOutbound> {
    let event = match kind {
        ActivityKind::Output => Outbound::AgentActivity { agent_id },
        ActivityKind::Input => Outbound::AgentInputActivity { agent_id },
    };
    serde_json::to_string(&event).ok().map(WsOutbound::Json)
}

/// Best-effort emission used by the WebRTC input callback. Output activity is
/// queued in order beside its mirrored binary frame by `run_forwarder`.
pub(crate) fn try_emit_activity(out_tx: &SessionSink, agent_id: Uuid, kind: ActivityKind) -> bool {
    let Some(message) = activity_message(agent_id, kind) else {
        return false;
    };
    out_tx.try_send(message).is_ok()
}

/// A direct terminal sink plus a cumulative count of PTY bytes queued to it.
/// The counter lets snapshot responses carry the stream position at capture
/// time, so browsers can order snapshot content against live DataChannel
/// bytes (which outrun the relayed snapshot response).
struct DirectSinkEntry {
    sink: DirectSink,
    bytes_sent: Arc<AtomicU64>,
}

/// Shared between an agent's forwarder task and the WS session lifecycle.
/// `slot` holds the current session's outbound sink (or `None` between
/// sessions). `notify` wakes the forwarder when a sink becomes available.
#[derive(Clone)]
pub struct ForwarderControl {
    slot: Arc<AsyncMutex<Option<SessionSink>>>,
    direct_sinks: Arc<AsyncMutex<HashMap<String, DirectSinkEntry>>>,
    notify: Arc<Notify>,
    /// Cached `#{pane_in_mode}` so the stdin hot path never has to spawn a
    /// tmux subprocess per keystroke; refreshed lazily in the background.
    copy_mode: Arc<AtomicBool>,
    copy_mode_checked_at: Arc<Mutex<Option<std::time::Instant>>>,
    /// Monotonic activity state. Input/output pings have independent throttle
    /// clocks; injected input/resize/redraw extend the output suppression
    /// deadline so their echoes and repaints do not count as agent work.
    activity: Arc<Mutex<ActivityState>>,
}

#[derive(Debug, Default)]
struct ActivityState {
    last_output_at: Option<Instant>,
    last_input_at: Option<Instant>,
    suppress_output_until: Option<Instant>,
    output_classifier: activity::OutputClassifier,
}

/// How stale the cached copy-mode flag may get before a background refresh
/// is kicked off. A keystroke landing within this window of the user
/// entering copy-mode may slip through uncancelled — the same best-effort
/// semantics the old always-cancel had for its own races.
const COPY_MODE_CACHE_TTL: std::time::Duration = std::time::Duration::from_millis(500);

impl ForwarderControl {
    pub(crate) fn new() -> Self {
        Self {
            slot: Arc::new(AsyncMutex::new(None)),
            direct_sinks: Arc::new(AsyncMutex::new(HashMap::new())),
            notify: Arc::new(Notify::new()),
            copy_mode: Arc::new(AtomicBool::new(false)),
            copy_mode_checked_at: Arc::new(Mutex::new(None)),
            activity: Arc::new(Mutex::new(ActivityState::default())),
        }
    }

    /// Suppress output-activity classification for `window` — an injected
    /// resize/redraw or local input echo must not register as agent work.
    pub fn suppress_activity(&self, window: Duration) {
        self.suppress_activity_at(Instant::now(), window);
    }

    fn suppress_activity_at(&self, now: Instant, window: Duration) {
        let until = now.checked_add(window).unwrap_or(now);
        let Ok(mut state) = self.activity.lock() else {
            return;
        };
        if state
            .suppress_output_until
            .is_none_or(|previous| previous < until)
        {
            state.suppress_output_until = Some(until);
        }
    }

    /// Decide whether this output chunk should emit an `agent.activity` ping:
    /// outside the throttle window, not suppressed, and carrying meaningful
    /// content. Records the emit time on success. Mirrors the former
    /// server-side classifier, now content-free on the wire.
    fn note_output(&self, chunk: &[u8]) -> bool {
        self.note_output_at(Instant::now(), chunk)
    }

    fn note_output_at(&self, now: Instant, chunk: &[u8]) -> bool {
        let Ok(mut state) = self.activity.lock() else {
            return false;
        };
        let throttle_open = !state.last_output_at.is_some_and(|last| {
            now.saturating_duration_since(last) < activity::OUTPUT_TOUCH_INTERVAL
        });
        let suppressed = state.suppress_output_until.is_some_and(|until| now < until);
        if !suppressed {
            state.suppress_output_until = None;
        }

        // Always consume the bytes so UTF-8 and terminal-control state stays
        // aligned across arbitrary PTY chunk boundaries. Ineligible bytes
        // advance parsing but cannot become delayed activity later.
        let meaningful = state
            .output_classifier
            .observe(chunk, throttle_open && !suppressed);
        if !throttle_open {
            state.output_classifier.discard_meaningful_carry();
            return false;
        }
        if !meaningful {
            return false;
        }
        state.last_output_at = Some(now);
        true
    }

    /// Record local DataChannel input without revealing its contents. The
    /// caller emits `agent.input_activity` only when this returns true.
    pub fn note_input(&self) -> bool {
        self.note_input_at(Instant::now())
    }

    fn note_input_at(&self, now: Instant) -> bool {
        let Ok(mut state) = self.activity.lock() else {
            return false;
        };
        if state.last_input_at.is_some_and(|last| {
            now.saturating_duration_since(last) < activity::INPUT_TOUCH_INTERVAL
        }) {
            return false;
        }
        state.last_input_at = Some(now);
        true
    }

    /// Cached answer to "is the pane in copy-mode?", kicking off a background
    /// refresh when the cache is stale. Never blocks on tmux.
    pub fn copy_mode_cached(&self, session: &str) -> bool {
        let needs_refresh = match self.copy_mode_checked_at.lock() {
            Ok(mut guard) => match *guard {
                Some(at) if at.elapsed() < COPY_MODE_CACHE_TTL => false,
                _ => {
                    *guard = Some(std::time::Instant::now());
                    true
                }
            },
            Err(_) => false,
        };
        if needs_refresh {
            let flag = Arc::clone(&self.copy_mode);
            let session = session.to_string();
            tokio::spawn(async move {
                if let Some(in_mode) = tmux::pane_in_mode(&session).await {
                    flag.store(in_mode, Ordering::Relaxed);
                }
            });
        }
        self.copy_mode.load(Ordering::Relaxed)
    }

    /// Record that copy-mode was just cancelled without waiting for the next
    /// background refresh.
    pub fn clear_copy_mode(&self) {
        self.copy_mode.store(false, Ordering::Relaxed);
    }

    /// Install the current WS session's outbound sink. Wakes the forwarder
    /// task so any backlog drains immediately.
    pub async fn set_sink(&self, sink: SessionSink) {
        *self.slot.lock().await = Some(sink);
        self.notify.notify_one();
    }

    /// Clear the sink (called when the WS session ends). The forwarder will
    /// park on `notify` until a new sink is installed; bytes accumulate in
    /// the agent's outbox in the meantime.
    pub async fn clear_sink(&self) {
        *self.slot.lock().await = None;
    }

    /// Add a direct terminal transport sink, such as a browser WebRTC
    /// DataChannel. These sinks receive raw PTY output bytes without the
    /// daemon->server->browser relay hop.
    pub async fn add_direct_sink(&self, id: String, sink: DirectSink) {
        self.direct_sinks.lock().await.insert(
            id,
            DirectSinkEntry {
                sink,
                bytes_sent: Arc::new(AtomicU64::new(0)),
            },
        );
    }

    pub async fn remove_direct_sink(&self, id: &str) {
        self.direct_sinks.lock().await.remove(id);
    }

    /// Cumulative bytes queued to the given direct sink, or None if the sink
    /// is not registered.
    pub async fn direct_sink_offset(&self, id: &str) -> Option<u64> {
        self.direct_sinks
            .lock()
            .await
            .get(id)
            .map(|entry| entry.bytes_sent.load(Ordering::Relaxed))
    }

    async fn send_direct(&self, chunk: &[u8]) {
        let mut sinks = self.direct_sinks.lock().await;
        sinks.retain(|_, entry| {
            if entry.sink.send(chunk.to_vec()).is_ok() {
                entry
                    .bytes_sent
                    .fetch_add(chunk.len() as u64, Ordering::Relaxed);
                true
            } else {
                false
            }
        });
    }
}

/// Commands routed from spawnd to a session worker's connection tasks
/// (worker backend only; see `worker_backend`).
#[derive(Debug)]
pub enum WorkerCmd {
    Input(Vec<u8>),
    Resize {
        cols: u16,
        rows: u16,
    },
    /// Fetch decrypted scrollback for a snapshot/reattach seed. Responds with
    /// `(watermark, bytes)` — watermark = total PTY output bytes logged at
    /// capture time.
    Replay {
        max_bytes: u32,
        resp: oneshot::Sender<Result<(u64, Vec<u8>)>>,
    },
    Shutdown {
        signal: Option<String>,
    },
}

/// What actually carries stdin/resize/etc. for this agent.
enum HandleBackend {
    /// `tmux attach` running inside a daemon-owned PTY.
    Tmux {
        /// Stdin into the PTY (writer half).
        stdin: Arc<Mutex<Box<dyn Write + Send>>>,
        /// Master PTY (kept alive so resize works).
        master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    },
    /// A spawn-worker process owning the PTY, reached over a unix socket.
    Worker {
        cmd_tx: mpsc::UnboundedSender<WorkerCmd>,
    },
}

/// Per-agent runtime handle.
pub struct AgentHandle {
    pub agent_id: Uuid,
    /// tmux session name (e.g. "spawn-palette--<uuid>"). For the worker
    /// backend this is a display label only; nothing shells out with it.
    session: Arc<Mutex<String>>,
    /// Optional token used to cancel the read thread; consumed on shutdown.
    #[allow(dead_code)]
    cancel_tx: Option<oneshot::Sender<()>>,
    /// Last size applied through this handle. Used to avoid expensive tmux
    /// refreshes when browsers repeat the same geometry.
    size: Arc<Mutex<(u16, u16)>>,
    /// Reader thread pushes raw PTY bytes here. Held alive while the agent
    /// is alive; when dropped, the per-agent forwarder task exits.
    #[allow(dead_code)]
    outbox_tx: mpsc::UnboundedSender<Vec<u8>>,
    /// Lets the WS session install/clear the forwarder's current sink.
    pub control: ForwarderControl,
    backend: HandleBackend,
}

/// Everything `worker_backend` needs to assemble a worker-backed handle.
pub struct WorkerHandleParts {
    pub agent_id: Uuid,
    pub session: String,
    pub cmd_tx: mpsc::UnboundedSender<WorkerCmd>,
    pub cols: u16,
    pub rows: u16,
    pub outbox_tx: mpsc::UnboundedSender<Vec<u8>>,
    pub control: ForwarderControl,
}

impl AgentHandle {
    pub fn new_worker(parts: WorkerHandleParts) -> Self {
        Self {
            agent_id: parts.agent_id,
            session: Arc::new(Mutex::new(parts.session)),
            cancel_tx: None,
            size: Arc::new(Mutex::new((parts.cols, parts.rows))),
            outbox_tx: parts.outbox_tx,
            control: parts.control,
            backend: HandleBackend::Worker {
                cmd_tx: parts.cmd_tx,
            },
        }
    }

    pub fn is_worker(&self) -> bool {
        matches!(self.backend, HandleBackend::Worker { .. })
    }

    pub fn session(&self) -> Result<String> {
        self.session
            .lock()
            .map(|s| s.clone())
            .map_err(|_| anyhow::anyhow!("tmux session lock poisoned"))
    }

    pub fn set_session(&self, next: String) -> Result<()> {
        let mut session = self
            .session
            .lock()
            .map_err(|_| anyhow::anyhow!("tmux session lock poisoned"))?;
        *session = next;
        Ok(())
    }

    pub fn write_stdin(&self, bytes: &[u8]) -> Result<()> {
        // The echo of this input shouldn't count as agent output-activity.
        self.control
            .suppress_activity(activity::INPUT_ECHO_SUPPRESS_WINDOW);
        match &self.backend {
            HandleBackend::Tmux { stdin, .. } => {
                let mut stdin = stdin
                    .lock()
                    .map_err(|_| anyhow::anyhow!("pty stdin lock poisoned"))?;
                stdin.write_all(bytes).context("writing PTY stdin")?;
                stdin.flush().ok();
                Ok(())
            }
            HandleBackend::Worker { cmd_tx } => cmd_tx
                .send(WorkerCmd::Input(bytes.to_vec()))
                .map_err(|_| anyhow::anyhow!("worker connection gone")),
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<bool> {
        let mut size = self
            .size
            .lock()
            .map_err(|_| anyhow::anyhow!("pty size lock poisoned"))?;
        if *size == (cols, rows) {
            return Ok(false);
        }
        // The repaint this resize triggers shouldn't count as agent activity.
        self.control
            .suppress_activity(activity::REDRAW_SUPPRESS_WINDOW);
        match &self.backend {
            HandleBackend::Tmux { master, .. } => {
                let master = master
                    .lock()
                    .map_err(|_| anyhow::anyhow!("pty master lock poisoned"))?;
                master
                    .resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .context("resizing PTY")?;
            }
            HandleBackend::Worker { cmd_tx } => {
                cmd_tx
                    .send(WorkerCmd::Resize { cols, rows })
                    .map_err(|_| anyhow::anyhow!("worker connection gone"))?;
            }
        }
        *size = (cols, rows);
        Ok(true)
    }

    /// Worker backend: signal the agent process. Returns false for tmux.
    pub fn worker_shutdown(&self, signal: Option<String>) -> bool {
        match &self.backend {
            HandleBackend::Worker { cmd_tx } => cmd_tx.send(WorkerCmd::Shutdown { signal }).is_ok(),
            HandleBackend::Tmux { .. } => false,
        }
    }

    /// Worker backend: request decrypted scrollback replay. Returns None for
    /// tmux (callers use `tmux::capture_history`).
    pub fn worker_replay(
        &self,
        max_bytes: u32,
    ) -> Option<oneshot::Receiver<Result<(u64, Vec<u8>)>>> {
        match &self.backend {
            HandleBackend::Worker { cmd_tx } => {
                let (resp, rx) = oneshot::channel();
                cmd_tx.send(WorkerCmd::Replay { max_bytes, resp }).ok()?;
                Some(rx)
            }
            HandleBackend::Tmux { .. } => None,
        }
    }

    /// Drop the cancel channel so the reader exits next iteration.
    #[allow(dead_code)]
    pub fn cancel(&mut self) {
        if let Some(tx) = self.cancel_tx.take() {
            let _ = tx.send(());
        }
    }
}

pub struct LaunchSpec<'a> {
    pub agent_id: Uuid,
    pub session: &'a str,
    pub cwd: &'a str,
    pub cols: u16,
    pub rows: u16,
    pub argv: &'a [String],
    /// Final env to pass to the launched agent (and to tmux via `-e`).
    pub env: &'a BTreeMap<String, String>,
}

/// Result of a successful launch.
pub struct Launched {
    pub handle: AgentHandle,
    /// PID of the `tmux attach` we spawned in the PTY (reported via
    /// `agent.started`). Note this is NOT the agent's pid; the real agent
    /// runs under tmux.
    pub pid: u32,
    /// Future-style: receives the exit reason once the PTY EOFs.
    pub exit_rx: oneshot::Receiver<ExitReason>,
}

#[derive(Debug, Clone)]
pub struct ExitReason {
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
}

/// 1) tmux new-session -d
/// 2) attach in a portable-pty
/// 3) spawn a reader thread (raw bytes -> outbox)
/// 4) spawn a forwarder task (outbox -> current WS sink)
pub async fn launch(spec: LaunchSpec<'_>) -> Result<Launched> {
    let session = spec.session;

    tmux::new_session_detached(session, spec.cwd, spec.cols, spec.rows, spec.argv, spec.env)
        .await
        .context("starting tmux session")?;

    // If the agent's argv exits within a few hundred ms (bad binary, missing
    // flag, smart-quote garbage), the tmux session is already gone by the
    // time we try to attach — and the user just sees a confusing
    // "can't find session" from `tmux attach`. Detect that case here and
    // surface a clearer error.
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    if !tmux::has_session(session).await {
        anyhow::bail!(
            "agent process exited before we could attach — check argv: {:?}",
            spec.argv
        );
    }

    attach_to_session(spec.agent_id, session, spec.cwd, spec.cols, spec.rows)
}

/// Re-attach to an existing tmux session that was started by a previous
/// `spawnd` instance. Used during daemon discovery on startup so agents
/// survive daemon restarts without losing state.
pub async fn reattach(agent_id: uuid::Uuid, session: &str) -> Result<Launched> {
    if !tmux::has_session(session).await {
        anyhow::bail!("tmux session {session:?} not found");
    }
    let (cols, rows) = tmux::window_size(session).await.unwrap_or((120, 32));
    // We don't know the original cwd; default to the current daemon's working
    // directory (which is typically the user's home). The PTY child only
    // needs cwd to be a valid dir; the agent's actual cwd is preserved by
    // tmux.
    let cwd = std::env::current_dir()
        .ok()
        .and_then(|p| p.to_str().map(String::from))
        .unwrap_or_else(|| "/".to_string());
    tracing::info!(%agent_id, %session, cols, rows, "reattaching to existing tmux session");
    attach_to_session(agent_id, session, &cwd, cols, rows)
}

/// Shared core: open a portable-pty, run `tmux attach` in it, start the
/// reader thread + per-agent forwarder task. Returns once the structures
/// are wired up; bytes will start flowing as soon as the WS session installs
/// a sink via `handle.control.set_sink(...)`.
fn attach_to_session(
    agent_id: uuid::Uuid,
    session: &str,
    cwd: &str,
    cols: u16,
    rows: u16,
) -> Result<Launched> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("openpty")?;

    let mut cmd = CommandBuilder::new("tmux");
    cmd.args(["attach", "-t", session]);
    cmd.env("TERM", "xterm-256color");
    if let Ok(p) = std::env::var("PATH") {
        cmd.env("PATH", p);
    }
    // Match the socket resolution of every other tmux invocation: honor the
    // daemon's TMUX_TMPDIR, never an inherited $TMUX, so an attach from a
    // daemon started inside a tmux pane can't target the outer server.
    cmd.env_remove("TMUX");
    if let Ok(t) = std::env::var("TMUX_TMPDIR") {
        cmd.env("TMUX_TMPDIR", t);
    }
    cmd.cwd(cwd);

    let child = pair
        .slave
        .spawn_command(cmd)
        .context("spawning tmux attach inside PTY")?;
    let pid = child.process_id().unwrap_or(0);

    let reader = pair
        .master
        .try_clone_reader()
        .context("cloning PTY reader")?;
    let writer = pair.master.take_writer().context("taking PTY writer")?;
    let master = Arc::new(Mutex::new(pair.master));
    let stdin = Arc::new(Mutex::new(writer));

    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    let (exit_tx, exit_rx) = oneshot::channel::<ExitReason>();

    // Per-agent outbox + forwarder.
    let (outbox_tx, outbox_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let control = ForwarderControl::new();

    // Forwarder: outbox -> current sink (with reconnect-aware looping).
    {
        let control = control.clone();
        tokio::spawn(run_forwarder(agent_id, outbox_rx, control));
    }

    // Reader thread: raw PTY -> outbox.
    let outbox_for_reader = outbox_tx.clone();
    std::thread::spawn(move || {
        run_reader_thread(
            agent_id,
            reader,
            child,
            outbox_for_reader,
            cancel_rx,
            exit_tx,
        );
    });

    let handle = AgentHandle {
        agent_id,
        session: Arc::new(Mutex::new(session.to_string())),
        cancel_tx: Some(cancel_tx),
        size: Arc::new(Mutex::new((cols, rows))),
        outbox_tx,
        control,
        backend: HandleBackend::Tmux { stdin, master },
    };
    Ok(Launched {
        handle,
        pid,
        exit_rx,
    })
}

fn run_reader_thread(
    agent_id: Uuid,
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    outbox: mpsc::UnboundedSender<Vec<u8>>,
    mut cancel_rx: oneshot::Receiver<()>,
    exit_tx: oneshot::Sender<ExitReason>,
) {
    let mut buf = [0u8; 8192];
    loop {
        // Cooperative cancel check (non-blocking).
        if cancel_rx.try_recv().is_ok() {
            tracing::debug!(%agent_id, "PTY reader cancelled");
            break;
        }

        match reader.read(&mut buf) {
            Ok(0) => {
                tracing::debug!(%agent_id, "PTY EOF");
                break;
            }
            Ok(n) => {
                if outbox.send(buf[..n].to_vec()).is_err() {
                    // Forwarder gone (registry dropped this agent). We can stop.
                    tracing::debug!(%agent_id, "outbox closed; stopping reader");
                    break;
                }
            }
            Err(e) => {
                tracing::warn!(%agent_id, error = %e, "PTY read error");
                break;
            }
        }
    }

    // Drain exit status.
    let reason = match child.wait() {
        Ok(status) => {
            if status.success() {
                ExitReason {
                    exit_code: Some(0),
                    signal: None,
                }
            } else {
                ExitReason {
                    exit_code: Some(status.exit_code() as i32),
                    signal: None,
                }
            }
        }
        Err(_) => ExitReason {
            exit_code: None,
            signal: None,
        },
    };
    let _ = exit_tx.send(reason);
}

/// Long-lived per-agent task: encode raw PTY bytes into binary frames and
/// ship them to the current WS session's sink. Survives WS reconnects —
/// when the sink is None, parks on `control.notify` until a new session
/// installs one. Exits when `outbox_rx` returns None (i.e. all
/// `outbox_tx` clones — including the AgentHandle and reader thread — are
/// dropped).
pub(crate) async fn run_forwarder(
    agent_id: Uuid,
    mut outbox_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    control: ForwarderControl,
) {
    let mut pending_mirror = VecDeque::new();
    let mut outbox_open = true;

    loop {
        // Keep classification at the source side of the queue. Drain a bounded
        // batch before servicing the mirror so a missing/full server sink can
        // never defer activity decisions until after suppression state changes.
        for _ in 0..64 {
            match outbox_rx.try_recv() {
                Ok(chunk) => {
                    queue_output_chunk(agent_id, chunk, &control, &mut pending_mirror).await;
                }
                Err(mpsc::error::TryRecvError::Empty) => break,
                Err(mpsc::error::TryRecvError::Disconnected) => {
                    outbox_open = false;
                    break;
                }
            }
        }

        if !outbox_open && pending_mirror.is_empty() {
            break;
        }

        if pending_mirror.is_empty() {
            match outbox_rx.recv().await {
                Some(chunk) => {
                    queue_output_chunk(agent_id, chunk, &control, &mut pending_mirror).await;
                }
                None => outbox_open = false,
            }
            continue;
        }

        let current = control.slot.lock().await.clone();
        let Some(sink) = current else {
            if outbox_open {
                tokio::select! {
                    chunk = outbox_rx.recv() => match chunk {
                        Some(chunk) => {
                            queue_output_chunk(agent_id, chunk, &control, &mut pending_mirror).await;
                        }
                        None => outbox_open = false,
                    },
                    _ = control.notify.notified() => {},
                }
            } else {
                control.notify.notified().await;
            }
            continue;
        };

        let message = pending_mirror.front().cloned().expect("checked non-empty");
        let send_result = if outbox_open {
            tokio::select! {
                chunk = outbox_rx.recv() => {
                    match chunk {
                        Some(chunk) => {
                            queue_output_chunk(agent_id, chunk, &control, &mut pending_mirror).await;
                        }
                        None => outbox_open = false,
                    }
                    continue;
                },
                result = sink.send(message) => result,
            }
        } else {
            sink.send(message).await
        };

        match send_result {
            Ok(()) => {
                pending_mirror.pop_front();
            }
            Err(_) => {
                // Keep the unsent frame at the front for the replacement sink.
                let mut slot = control.slot.lock().await;
                if slot.as_ref().is_some_and(|current| current.is_closed()) {
                    *slot = None;
                }
            }
        }
    }
    tracing::debug!(%agent_id, "forwarder exiting (outbox closed)");
}

async fn queue_output_chunk(
    agent_id: Uuid,
    chunk: Vec<u8>,
    control: &ForwarderControl,
    pending_mirror: &mut VecDeque<WsOutbound>,
) {
    // Decide first, in PTY receipt order. Direct/browser and legacy/server
    // delivery may block or reconnect, but neither can change this decision.
    let meaningful = control.note_output(&chunk);
    control.send_direct(&chunk).await;
    pending_mirror.push_back(WsOutbound::Binary(frames::encode_pty_output(
        agent_id, &chunk,
    )));
    if meaningful {
        if let Some(activity) = activity_message(agent_id, ActivityKind::Output) {
            pending_mirror.push_back(activity);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_activity_is_throttled_with_monotonic_time() {
        let control = ForwarderControl::new();
        let start = Instant::now();

        assert!(control.note_output_at(start, b"meaningful output"));
        assert!(!control.note_output_at(
            start + activity::OUTPUT_TOUCH_INTERVAL - Duration::from_millis(1),
            b"more meaningful output"
        ));
        assert!(control.note_output_at(
            start + activity::OUTPUT_TOUCH_INTERVAL,
            b"more meaningful output"
        ));
    }

    #[test]
    fn suppression_extends_and_expires_deterministically() {
        let control = ForwarderControl::new();
        let start = Instant::now();
        control.suppress_activity_at(start, Duration::from_secs(1));
        control.suppress_activity_at(start + Duration::from_millis(100), Duration::from_secs(2));

        assert!(!control.note_output_at(start + Duration::from_secs(1), b"meaningful output"));
        assert!(!control.note_output_at(start + Duration::from_millis(2099), b"meaningful output"));
        assert!(control.note_output_at(start + Duration::from_millis(2100), b"meaningful output"));
    }

    #[test]
    fn suppressed_or_noise_output_does_not_consume_throttle() {
        let control = ForwarderControl::new();
        let start = Instant::now();
        control.suppress_activity_at(start, Duration::from_millis(10));

        assert!(!control.note_output_at(start, b"meaningful output"));
        assert!(!control.note_output_at(start + Duration::from_millis(10), b"ok"));
        assert!(control.note_output_at(start + Duration::from_millis(10), b"meaningful output"));
    }

    #[test]
    fn classifier_state_advances_while_throttled_and_suppressed() {
        let throttled = ForwarderControl::new();
        let start = Instant::now();
        assert!(throttled.note_output_at(start, b"abc"));
        assert!(
            !throttled.note_output_at(start + Duration::from_millis(10), b"\x1b]0;hidden title")
        );
        assert!(throttled.note_output_at(start + activity::OUTPUT_TOUCH_INTERVAL, b"\x07abc"));

        let suppressed = ForwarderControl::new();
        suppressed.suppress_activity_at(start, Duration::from_secs(1));
        assert!(!suppressed.note_output_at(start, b"\xe2\x80"));
        assert!(suppressed.note_output_at(start + Duration::from_secs(1), b"\xa2abc"));

        let no_delay = ForwarderControl::new();
        no_delay.suppress_activity_at(start, Duration::from_secs(1));
        assert!(!no_delay.note_output_at(start, b"ab"));
        assert!(!no_delay.note_output_at(start + Duration::from_secs(1), b"c"));
    }

    #[test]
    fn input_activity_has_an_independent_throttle() {
        let control = ForwarderControl::new();
        let start = Instant::now();

        assert!(control.note_input_at(start));
        assert!(!control
            .note_input_at(start + activity::INPUT_TOUCH_INTERVAL - Duration::from_millis(1)));
        assert!(control.note_input_at(start + activity::INPUT_TOUCH_INTERVAL));
        assert!(control.note_output_at(start, b"independent output"));
    }

    #[tokio::test]
    async fn activity_frames_serialize_without_terminal_content() {
        let agent_id = Uuid::new_v4();
        let (tx, mut rx) = mpsc::channel(2);

        assert!(try_emit_activity(&tx, agent_id, ActivityKind::Output));
        assert!(try_emit_activity(&tx, agent_id, ActivityKind::Input));

        let WsOutbound::Json(output_json) = rx.recv().await.unwrap() else {
            panic!("expected JSON output activity")
        };
        let WsOutbound::Json(input_json) = rx.recv().await.unwrap() else {
            panic!("expected JSON input activity")
        };
        assert_eq!(
            output_json,
            format!(r#"{{"type":"agent.activity","agent_id":"{agent_id}"}}"#)
        );
        assert_eq!(
            input_json,
            format!(r#"{{"type":"agent.input_activity","agent_id":"{agent_id}"}}"#)
        );
    }

    #[tokio::test]
    async fn forwarder_emits_binary_output_then_content_free_activity() {
        let agent_id = Uuid::new_v4();
        let control = ForwarderControl::new();
        let (sink_tx, mut sink_rx) = mpsc::channel(4);
        control.set_sink(sink_tx).await;
        let (outbox_tx, outbox_rx) = mpsc::unbounded_channel();
        let forwarder = tokio::spawn(run_forwarder(agent_id, outbox_rx, control));

        outbox_tx
            .send(b"sensitive terminal output".to_vec())
            .unwrap();
        drop(outbox_tx);

        let WsOutbound::Binary(binary) = sink_rx.recv().await.unwrap() else {
            panic!("expected binary PTY output")
        };
        let (kind, decoded_id, payload) = frames::decode_binary(&binary).unwrap();
        assert_eq!(kind, frames::KIND_PTY_OUTPUT);
        assert_eq!(decoded_id, agent_id);
        assert_eq!(payload, b"sensitive terminal output");

        let WsOutbound::Json(activity_json) = sink_rx.recv().await.unwrap() else {
            panic!("expected JSON output activity")
        };
        assert_eq!(
            activity_json,
            format!(r#"{{"type":"agent.activity","agent_id":"{agent_id}"}}"#)
        );
        assert!(!activity_json.contains("sensitive terminal output"));
        forwarder.await.unwrap();
    }

    #[tokio::test]
    async fn forwarder_decides_activity_before_mirror_backpressure_and_suppression() {
        let agent_id = Uuid::new_v4();
        let control = ForwarderControl::new();
        let (direct_tx, mut direct_rx) = mpsc::unbounded_channel();
        control.add_direct_sink("test".into(), direct_tx).await;

        // Capacity one deliberately blocks the mirror after its first binary
        // frame. Subsequent direct receipts prove classification has still
        // consumed those chunks in source order.
        let (sink_tx, mut sink_rx) = mpsc::channel(1);
        control.set_sink(sink_tx).await;
        let (outbox_tx, outbox_rx) = mpsc::unbounded_channel();
        let forwarder = tokio::spawn(run_forwarder(agent_id, outbox_rx, control.clone()));

        outbox_tx.send(b"ok".to_vec()).unwrap();
        assert_eq!(direct_rx.recv().await.unwrap(), b"ok");

        outbox_tx.send(b"before suppression".to_vec()).unwrap();
        assert_eq!(direct_rx.recv().await.unwrap(), b"before suppression");

        control.suppress_activity_at(Instant::now(), Duration::from_secs(60));
        outbox_tx.send(b"during suppression".to_vec()).unwrap();
        assert_eq!(direct_rx.recv().await.unwrap(), b"during suppression");

        // Simulate reconnect after the suppression window. The stored decision
        // for earlier output remains, while suppressed output cannot appear as
        // a delayed activity event.
        control.activity.lock().unwrap().suppress_output_until = None;
        drop(outbox_tx);

        let first = sink_rx.recv().await.unwrap();
        let second = sink_rx.recv().await.unwrap();
        let third = sink_rx.recv().await.unwrap();
        let fourth = sink_rx.recv().await.unwrap();
        forwarder.await.unwrap();

        let frames = [first, second, third, fourth];
        let mut binary_payloads = Vec::new();
        let mut activity_frames = Vec::new();
        for frame in frames {
            match frame {
                WsOutbound::Binary(binary) => {
                    let (_, _, payload) = frames::decode_binary(&binary).unwrap();
                    binary_payloads.push(payload.to_vec());
                }
                WsOutbound::Json(json) => activity_frames.push(json),
            }
        }
        assert_eq!(
            binary_payloads,
            vec![
                b"ok".to_vec(),
                b"before suppression".to_vec(),
                b"during suppression".to_vec()
            ]
        );
        assert_eq!(
            activity_frames,
            vec![format!(
                r#"{{"type":"agent.activity","agent_id":"{agent_id}"}}"#
            )]
        );
        assert!(sink_rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn forwarder_does_not_reclassify_suppressed_output_when_sink_reconnects() {
        let agent_id = Uuid::new_v4();
        let control = ForwarderControl::new();
        let (direct_tx, mut direct_rx) = mpsc::unbounded_channel();
        control.add_direct_sink("test".into(), direct_tx).await;
        let (outbox_tx, outbox_rx) = mpsc::unbounded_channel();
        let forwarder = tokio::spawn(run_forwarder(agent_id, outbox_rx, control.clone()));

        // There is intentionally no server sink while both chunks are
        // classified. A later suppression cannot erase the first decision.
        outbox_tx.send(b"before suppression".to_vec()).unwrap();
        assert_eq!(direct_rx.recv().await.unwrap(), b"before suppression");
        control.suppress_activity_at(Instant::now(), Duration::from_secs(60));
        outbox_tx.send(b"during suppression".to_vec()).unwrap();
        assert_eq!(direct_rx.recv().await.unwrap(), b"during suppression");
        control.activity.lock().unwrap().suppress_output_until = None;

        let (sink_tx, mut sink_rx) = mpsc::channel(4);
        control.set_sink(sink_tx).await;
        drop(outbox_tx);

        let first = sink_rx.recv().await.unwrap();
        let second = sink_rx.recv().await.unwrap();
        let third = sink_rx.recv().await.unwrap();
        forwarder.await.unwrap();

        assert!(matches!(first, WsOutbound::Binary(_)));
        let WsOutbound::Json(activity) = second else {
            panic!("pre-suppression output decision was lost")
        };
        assert_eq!(
            activity,
            format!(r#"{{"type":"agent.activity","agent_id":"{agent_id}"}}"#)
        );
        assert!(matches!(third, WsOutbound::Binary(_)));
        assert!(sink_rx.try_recv().is_err());
    }
}
