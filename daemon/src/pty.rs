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
use std::future;
use std::io::{Read, Write};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tokio::sync::{mpsc, oneshot, watch, Mutex as AsyncMutex, Notify};
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

/// A direct viewer receives bounded chunks. If it cannot keep up, the
/// forwarder disconnects it and the browser reconnects through replay.
pub struct DirectSinkReceiver {
    pub receiver: mpsc::Receiver<Vec<u8>>,
    pub disconnected: watch::Receiver<bool>,
}

pub const DIRECT_SINK_QUEUE_DEPTH: usize = 128;
pub const DIRECT_SINK_CHUNK_BYTES: usize = 16 * 1024;

/// Immutable result of handling one output event at its producer. Immediate
/// activity and the eligibility/generation of an ambiguous idle candidate are
/// stamped before raw bytes enter the asynchronous outbox, so later input,
/// resize, or redraw suppression cannot retroactively change that event.
#[derive(Debug)]
pub(crate) struct OutputChunk {
    bytes: Vec<u8>,
    /// End watermark in the producer's byte coordinate. Worker output carries
    /// its durable log watermark; tmux output assigns one in the forwarder.
    source_end: Option<u64>,
    source_barrier: bool,
    activity: bool,
    idle_resolution: Option<PendingIdleResolution>,
}

impl OutputChunk {
    pub(crate) fn classify(bytes: Vec<u8>, control: &ForwarderControl) -> Self {
        let now = Instant::now();
        let decision = control.classify_output_at(now, &bytes);
        let idle_resolution = decision
            .idle_generation
            .map(|generation| PendingIdleResolution {
                generation,
                deadline: now
                    .checked_add(activity::OUTPUT_IDLE_RESOLUTION_DELAY)
                    .unwrap_or(now),
            });
        Self {
            bytes,
            source_end: None,
            source_barrier: false,
            activity: decision.activity,
            idle_resolution,
        }
    }

    pub(crate) fn classify_at_source(
        bytes: Vec<u8>,
        source_end: u64,
        control: &ForwarderControl,
    ) -> Self {
        let mut chunk = Self::classify(bytes, control);
        chunk.source_end = Some(source_end);
        chunk
    }

    pub(crate) fn source_barrier(source_end: u64) -> Self {
        Self {
            bytes: Vec::new(),
            source_end: Some(source_end),
            source_barrier: true,
            activity: false,
            idle_resolution: None,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct OutputDecision {
    activity: bool,
    idle_generation: Option<u64>,
}

#[derive(Clone, Copy, Debug)]
struct PendingIdleResolution {
    generation: u64,
    deadline: Instant,
}

struct IdleResolutionTimer {
    generation: u64,
    sleep: Pin<Box<tokio::time::Sleep>>,
}

impl IdleResolutionTimer {
    fn new(pending: PendingIdleResolution) -> Self {
        let remaining = pending.deadline.saturating_duration_since(Instant::now());
        Self {
            generation: pending.generation,
            sleep: Box::pin(tokio::time::sleep(remaining)),
        }
    }
}

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
    sink: mpsc::Sender<Vec<u8>>,
    disconnected: watch::Sender<bool>,
    source_origin: u64,
    bytes_sent: Arc<AtomicU64>,
}

/// Shared between an agent's forwarder task and the WS session lifecycle.
/// `slot` holds the current session's outbound sink (or `None` between
/// sessions). `notify` wakes the forwarder when a sink becomes available.
#[derive(Clone)]
pub struct ForwarderControl {
    slot: Arc<AsyncMutex<Option<SessionSink>>>,
    direct_sinks: Arc<AsyncMutex<HashMap<String, DirectSinkEntry>>>,
    direct_sink_notify: Arc<Notify>,
    source_offset: Arc<AtomicU64>,
    source_notify: Arc<Notify>,
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
    output_generation: u64,
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
            direct_sink_notify: Arc::new(Notify::new()),
            source_offset: Arc::new(AtomicU64::new(0)),
            source_notify: Arc::new(Notify::new()),
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
    #[cfg(test)]
    fn note_output_at(&self, now: Instant, chunk: &[u8]) -> bool {
        self.classify_output_at(now, chunk).activity
    }

    fn classify_output_at(&self, now: Instant, chunk: &[u8]) -> OutputDecision {
        let Ok(mut state) = self.activity.lock() else {
            return OutputDecision {
                activity: false,
                idle_generation: None,
            };
        };
        state.output_generation = state.output_generation.wrapping_add(1);
        let generation = state.output_generation;
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
            return OutputDecision {
                activity: false,
                idle_generation: state
                    .output_classifier
                    .needs_idle_resolution()
                    .then_some(generation),
            };
        }
        if meaningful {
            state.last_output_at = Some(now);
        }
        OutputDecision {
            activity: meaningful,
            idle_generation: state
                .output_classifier
                .needs_idle_resolution()
                .then_some(generation),
        }
    }

    /// Resolve only the candidate associated with the latest producer event.
    /// Stale timers are harmless, and eligibility remains the value captured
    /// when each character arrived.
    fn resolve_output_idle(&self, generation: u64) -> bool {
        let now = Instant::now();
        let Ok(mut state) = self.activity.lock() else {
            return false;
        };
        if state.output_generation != generation {
            return false;
        }
        let meaningful = state.output_classifier.resolve_idle();
        if meaningful {
            state.last_output_at = Some(now);
        }
        meaningful
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
    pub async fn add_direct_sink(&self, id: String) -> DirectSinkReceiver {
        let (sink, receiver) = mpsc::channel(DIRECT_SINK_QUEUE_DEPTH);
        let (disconnected, disconnected_rx) = watch::channel(false);
        let mut sinks = self.direct_sinks.lock().await;
        let source_origin = self.source_offset.load(Ordering::Acquire);
        let previous = sinks.insert(
            id,
            DirectSinkEntry {
                sink,
                disconnected,
                source_origin,
                bytes_sent: Arc::new(AtomicU64::new(0)),
            },
        );
        if let Some(previous) = previous {
            let _ = previous.disconnected.send(true);
        }
        drop(sinks);
        self.direct_sink_notify.notify_waiters();
        DirectSinkReceiver {
            receiver,
            disconnected: disconnected_rx,
        }
    }

    pub async fn remove_direct_sink(&self, id: &str) {
        if let Some(entry) = self.direct_sinks.lock().await.remove(id) {
            let _ = entry.disconnected.send(true);
        }
    }

    pub async fn wait_for_direct_sink(&self, id: &str, timeout: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = self.direct_sink_notify.notified();
            if self.direct_sinks.lock().await.contains_key(id) {
                return true;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return false;
            }
        }
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

    /// Translate a producer watermark into the cumulative byte coordinate
    /// observed by this viewer's `spawn.pty` channel.
    pub async fn direct_sink_anchor(&self, id: &str, source_boundary: u64) -> Option<u64> {
        let sinks = self.direct_sinks.lock().await;
        let entry = sinks.get(id)?;
        source_boundary.checked_sub(entry.source_origin)
    }

    pub fn source_offset(&self) -> u64 {
        self.source_offset.load(Ordering::Acquire)
    }

    pub async fn wait_source_offset(&self, target: u64) {
        loop {
            let notified = self.source_notify.notified();
            if self.source_offset() >= target {
                return;
            }
            notified.await;
        }
    }

    /// Wait until the producer/forwarder byte coordinate has stayed stable
    /// for `quiet`. Used after a tmux pane is stopped so capture and the live
    /// stream share an exact boundary.
    pub async fn wait_source_quiet(&self, quiet: Duration, timeout: Duration) -> Option<u64> {
        let deadline = tokio::time::Instant::now() + timeout;
        let mut observed = self.source_offset();
        loop {
            tokio::time::sleep_until((tokio::time::Instant::now() + quiet).min(deadline)).await;
            let current = self.source_offset();
            if current == observed {
                return Some(observed);
            }
            if tokio::time::Instant::now() >= deadline {
                return None;
            }
            observed = current;
        }
    }

    async fn route_direct(&self, chunk: &[u8], explicit_source_end: Option<u64>) {
        let mut sinks = self.direct_sinks.lock().await;
        let previous_source_end = self.source_offset.load(Ordering::Acquire);
        let source_end = explicit_source_end
            .unwrap_or_else(|| previous_source_end.saturating_add(chunk.len() as u64));
        let expected_start = source_end.saturating_sub(chunk.len() as u64);
        if !chunk.is_empty() && expected_start != previous_source_end {
            // A producer-coordinate discontinuity means a viewer cannot
            // safely reconcile this live stream. Disconnect every current
            // sink; reconnect performs a bounded replay from a new origin.
            for entry in sinks.values() {
                let _ = entry.disconnected.send(true);
            }
            sinks.clear();
        }
        if source_end > previous_source_end {
            self.source_offset.store(source_end, Ordering::Release);
            self.source_notify.notify_waiters();
        }
        sinks.retain(|_, entry| {
            for part in chunk.chunks(DIRECT_SINK_CHUNK_BYTES) {
                if entry.sink.try_send(part.to_vec()).is_err() {
                    let _ = entry.disconnected.send(true);
                    return false;
                }
                entry
                    .bytes_sent
                    .fetch_add(part.len() as u64, Ordering::Relaxed);
            }
            true
        });
    }
}

/// Commands routed from spawnd to a session worker's connection tasks
/// (worker backend only; see `worker_backend`).
pub type WorkerReplayResult = Result<(u64, Vec<u8>)>;
pub type WorkerReplayReceiver = oneshot::Receiver<WorkerReplayResult>;

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
        resp: oneshot::Sender<WorkerReplayResult>,
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
        alive: Arc<AtomicBool>,
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
    outbox_tx: mpsc::UnboundedSender<OutputChunk>,
    /// Lets the WS session install/clear the forwarder's current sink.
    pub control: ForwarderControl,
    backend: HandleBackend,
}

/// Everything `worker_backend` needs to assemble a worker-backed handle.
pub struct WorkerHandleParts {
    pub agent_id: Uuid,
    pub session: String,
    pub cmd_tx: mpsc::UnboundedSender<WorkerCmd>,
    pub alive: Arc<AtomicBool>,
    pub cols: u16,
    pub rows: u16,
    pub outbox_tx: mpsc::UnboundedSender<OutputChunk>,
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
                alive: parts.alive,
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
            HandleBackend::Worker { cmd_tx, alive } => {
                if !alive.load(Ordering::Acquire) {
                    anyhow::bail!("worker connection gone");
                }
                cmd_tx
                    .send(WorkerCmd::Input(bytes.to_vec()))
                    .map_err(|_| anyhow::anyhow!("worker connection gone"))
            }
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
            HandleBackend::Worker { cmd_tx, alive } => {
                if !alive.load(Ordering::Acquire) {
                    anyhow::bail!("worker connection gone");
                }
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
            HandleBackend::Worker { cmd_tx, alive } => {
                alive.load(Ordering::Acquire) && cmd_tx.send(WorkerCmd::Shutdown { signal }).is_ok()
            }
            HandleBackend::Tmux { .. } => false,
        }
    }

    /// Worker backend: request decrypted scrollback replay. Returns None for
    /// tmux (callers use `tmux::capture_history`).
    pub fn worker_replay(&self, max_bytes: u32) -> Option<WorkerReplayReceiver> {
        match &self.backend {
            HandleBackend::Worker { cmd_tx, alive } => {
                if !alive.load(Ordering::Acquire) {
                    return None;
                }
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
    let (outbox_tx, outbox_rx) = mpsc::unbounded_channel::<OutputChunk>();
    let control = ForwarderControl::new();

    // Forwarder: outbox -> current sink (with reconnect-aware looping).
    {
        let control = control.clone();
        tokio::spawn(run_forwarder(agent_id, outbox_rx, control));
    }

    // Reader thread: raw PTY -> outbox.
    let outbox_for_reader = outbox_tx.clone();
    let control_for_reader = control.clone();
    std::thread::spawn(move || {
        run_reader_thread(
            agent_id,
            reader,
            child,
            outbox_for_reader,
            control_for_reader,
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
    outbox: mpsc::UnboundedSender<OutputChunk>,
    control: ForwarderControl,
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
                let chunk = OutputChunk::classify(buf[..n].to_vec(), &control);
                if outbox.send(chunk).is_err() {
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
    mut outbox_rx: mpsc::UnboundedReceiver<OutputChunk>,
    control: ForwarderControl,
) {
    let mut pending_mirror = VecDeque::new();
    let mut idle_timer: Option<IdleResolutionTimer> = None;
    let mut outbox_open = true;

    loop {
        // Keep content classification and eligibility at the source side of
        // the queue. Drain a bounded batch before servicing the mirror so a
        // missing/full server sink cannot defer producer decisions; the only
        // delayed step is a generation-guarded, content-free idle timeout.
        for _ in 0..64 {
            match outbox_rx.try_recv() {
                Ok(chunk) => {
                    queue_output_chunk(
                        agent_id,
                        chunk,
                        &control,
                        &mut pending_mirror,
                        &mut idle_timer,
                    )
                    .await;
                }
                Err(mpsc::error::TryRecvError::Empty) => break,
                Err(mpsc::error::TryRecvError::Disconnected) => {
                    outbox_open = false;
                    idle_timer = None;
                    break;
                }
            }
        }

        if idle_timer
            .as_ref()
            .is_some_and(|timer| timer.sleep.is_elapsed())
        {
            resolve_idle_activity(agent_id, &control, &mut pending_mirror, &mut idle_timer);
        }

        if !outbox_open && pending_mirror.is_empty() {
            break;
        }

        if pending_mirror.is_empty() {
            tokio::select! {
                chunk = outbox_rx.recv() => match chunk {
                    Some(chunk) => {
                        queue_output_chunk(
                            agent_id,
                            chunk,
                            &control,
                            &mut pending_mirror,
                            &mut idle_timer,
                        ).await;
                    }
                    None => {
                        outbox_open = false;
                        idle_timer = None;
                    }
                },
                generation = wait_for_idle(&mut idle_timer) => {
                    resolve_idle_generation(
                        agent_id,
                        generation,
                        &control,
                        &mut pending_mirror,
                        &mut idle_timer,
                    );
                }
            }
            continue;
        }

        let current = control.slot.lock().await.clone();
        let Some(sink) = current else {
            if outbox_open {
                tokio::select! {
                    chunk = outbox_rx.recv() => match chunk {
                        Some(chunk) => {
                            queue_output_chunk(
                                agent_id,
                                chunk,
                                &control,
                                &mut pending_mirror,
                                &mut idle_timer,
                            ).await;
                        }
                        None => {
                            outbox_open = false;
                            idle_timer = None;
                        }
                    },
                    _ = control.notify.notified() => {},
                    generation = wait_for_idle(&mut idle_timer) => {
                        resolve_idle_generation(
                            agent_id,
                            generation,
                            &control,
                            &mut pending_mirror,
                            &mut idle_timer,
                        );
                    },
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
                            queue_output_chunk(
                                agent_id,
                                chunk,
                                &control,
                                &mut pending_mirror,
                                &mut idle_timer,
                            ).await;
                        }
                        None => {
                            outbox_open = false;
                            idle_timer = None;
                        }
                    }
                    continue;
                },
                result = sink.send(message) => result,
                generation = wait_for_idle(&mut idle_timer) => {
                    resolve_idle_generation(
                        agent_id,
                        generation,
                        &control,
                        &mut pending_mirror,
                        &mut idle_timer,
                    );
                    continue;
                },
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
    chunk: OutputChunk,
    control: &ForwarderControl,
    pending_mirror: &mut VecDeque<WsOutbound>,
    idle_timer: &mut Option<IdleResolutionTimer>,
) {
    *idle_timer = chunk.idle_resolution.map(IdleResolutionTimer::new);
    control.route_direct(&chunk.bytes, chunk.source_end).await;
    if chunk.source_barrier {
        return;
    }
    pending_mirror.push_back(WsOutbound::Binary(frames::encode_pty_output(
        agent_id,
        &chunk.bytes,
    )));
    if chunk.activity {
        if let Some(activity) = activity_message(agent_id, ActivityKind::Output) {
            pending_mirror.push_back(activity);
        }
    }
}

async fn wait_for_idle(idle_timer: &mut Option<IdleResolutionTimer>) -> u64 {
    let Some(timer) = idle_timer else {
        return future::pending().await;
    };
    timer.sleep.as_mut().await;
    timer.generation
}

fn resolve_idle_activity(
    agent_id: Uuid,
    control: &ForwarderControl,
    pending_mirror: &mut VecDeque<WsOutbound>,
    idle_timer: &mut Option<IdleResolutionTimer>,
) {
    let generation = idle_timer
        .as_ref()
        .expect("checked elapsed idle timer")
        .generation;
    resolve_idle_generation(agent_id, generation, control, pending_mirror, idle_timer);
}

fn resolve_idle_generation(
    agent_id: Uuid,
    generation: u64,
    control: &ForwarderControl,
    pending_mirror: &mut VecDeque<WsOutbound>,
    idle_timer: &mut Option<IdleResolutionTimer>,
) {
    *idle_timer = None;
    if control.resolve_output_idle(generation) {
        if let Some(activity) = activity_message(agent_id, ActivityKind::Output) {
            pending_mirror.push_back(activity);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source_output(control: &ForwarderControl, bytes: &[u8]) -> OutputChunk {
        OutputChunk::classify(bytes.to_vec(), control)
    }

    async fn collect_direct_until(rx: &mut mpsc::Receiver<Vec<u8>>, needle: &[u8]) -> Vec<u8> {
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut bytes = Vec::new();
            loop {
                let chunk = rx.recv().await.expect("direct sink closed");
                bytes.extend_from_slice(&chunk);
                if bytes.windows(needle.len()).any(|window| window == needle) {
                    return bytes;
                }
            }
        })
        .await
        .expect("timed out waiting for direct output")
    }

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
        let forwarder = tokio::spawn(run_forwarder(agent_id, outbox_rx, control.clone()));

        outbox_tx
            .send(source_output(&control, b"sensitive terminal output"))
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
        let mut direct = control.add_direct_sink("test".into()).await;

        // Capacity one deliberately blocks the mirror after its first binary
        // frame. Subsequent direct receipts prove classification has still
        // consumed those chunks in source order.
        let (sink_tx, mut sink_rx) = mpsc::channel(1);
        control.set_sink(sink_tx).await;
        let (outbox_tx, outbox_rx) = mpsc::unbounded_channel();
        let forwarder = tokio::spawn(run_forwarder(agent_id, outbox_rx, control.clone()));

        outbox_tx.send(source_output(&control, b"ok")).unwrap();
        assert_eq!(direct.receiver.recv().await.unwrap(), b"ok");

        outbox_tx
            .send(source_output(&control, b"before suppression"))
            .unwrap();
        assert_eq!(direct.receiver.recv().await.unwrap(), b"before suppression");

        control.suppress_activity_at(Instant::now(), Duration::from_secs(60));
        outbox_tx
            .send(source_output(&control, b"during suppression"))
            .unwrap();
        assert_eq!(direct.receiver.recv().await.unwrap(), b"during suppression");

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
        let mut direct = control.add_direct_sink("test".into()).await;
        let (outbox_tx, outbox_rx) = mpsc::unbounded_channel();
        let forwarder = tokio::spawn(run_forwarder(agent_id, outbox_rx, control.clone()));

        // There is intentionally no server sink while both chunks are
        // classified. A later suppression cannot erase the first decision.
        outbox_tx
            .send(source_output(&control, b"before suppression"))
            .unwrap();
        assert_eq!(direct.receiver.recv().await.unwrap(), b"before suppression");
        control.suppress_activity_at(Instant::now(), Duration::from_secs(60));
        outbox_tx
            .send(source_output(&control, b"during suppression"))
            .unwrap();
        assert_eq!(direct.receiver.recv().await.unwrap(), b"during suppression");
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

    #[tokio::test]
    async fn direct_sink_anchor_tracks_exact_source_bytes_across_capture_boundary() {
        let agent_id = Uuid::new_v4();
        let control = ForwarderControl::new();
        let (mirror_tx, mut mirror_rx) = mpsc::channel(64);
        control.set_sink(mirror_tx).await;
        tokio::spawn(async move { while mirror_rx.recv().await.is_some() {} });
        let (outbox_tx, outbox_rx) = mpsc::unbounded_channel();
        let forwarder = tokio::spawn(run_forwarder(agent_id, outbox_rx, control.clone()));

        // Adoption establishes a durable worker coordinate before this viewer
        // exists; those historical bytes must not count in spawn.pty offsets.
        outbox_tx.send(OutputChunk::source_barrier(10_000)).unwrap();
        control.wait_source_offset(10_000).await;
        let mut direct = control.add_direct_sink("viewer".into()).await;

        let before = b"before:\xf0\x9f\x98\x80";
        let during = b"\x1b[31mduring\x1b[0m";
        let boundary = 10_000 + before.len() as u64 + during.len() as u64;
        outbox_tx
            .send(OutputChunk::classify_at_source(
                before.to_vec(),
                10_000 + before.len() as u64,
                &control,
            ))
            .unwrap();
        outbox_tx
            .send(OutputChunk::classify_at_source(
                during.to_vec(),
                boundary,
                &control,
            ))
            .unwrap();
        outbox_tx
            .send(OutputChunk::source_barrier(boundary))
            .unwrap();
        control.wait_source_offset(boundary).await;

        assert_eq!(direct.receiver.recv().await.unwrap(), before);
        assert_eq!(direct.receiver.recv().await.unwrap(), during);
        assert_eq!(
            control.direct_sink_anchor("viewer", boundary).await,
            Some((before.len() + during.len()) as u64)
        );

        let after = b"after\r\n";
        outbox_tx
            .send(OutputChunk::classify_at_source(
                after.to_vec(),
                boundary + after.len() as u64,
                &control,
            ))
            .unwrap();
        assert_eq!(direct.receiver.recv().await.unwrap(), after);

        drop(outbox_tx);
        forwarder.await.unwrap();
    }

    #[tokio::test]
    async fn stalled_direct_sink_is_bounded_and_disconnected_for_replay_catchup() {
        let agent_id = Uuid::new_v4();
        let control = ForwarderControl::new();
        let (mirror_tx, mut mirror_rx) = mpsc::channel(DIRECT_SINK_QUEUE_DEPTH * 4);
        control.set_sink(mirror_tx).await;
        tokio::spawn(async move { while mirror_rx.recv().await.is_some() {} });
        let mut direct = control.add_direct_sink("stalled".into()).await;
        let (outbox_tx, outbox_rx) = mpsc::unbounded_channel();
        let forwarder = tokio::spawn(run_forwarder(agent_id, outbox_rx, control.clone()));

        for _ in 0..=DIRECT_SINK_QUEUE_DEPTH {
            outbox_tx.send(source_output(&control, b"x")).unwrap();
        }
        tokio::time::timeout(Duration::from_secs(1), direct.disconnected.changed())
            .await
            .expect("stalled viewer was not disconnected")
            .expect("disconnect watch closed");
        assert!(*direct.disconnected.borrow());
        assert!(direct.receiver.len() <= DIRECT_SINK_QUEUE_DEPTH);
        assert_eq!(control.direct_sink_offset("stalled").await, None);

        drop(outbox_tx);
        forwarder.await.unwrap();
    }

    #[tokio::test]
    async fn tmux_capture_boundary_and_reattach_keep_live_stream_exact() {
        let agent_id = Uuid::new_v4();
        let session = format!("spawn-test-boundary-{agent_id}");
        let argv = vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "printf 'tmux-ready\\n'; exec cat".to_string(),
        ];
        let env = [
            (
                "PATH".to_string(),
                std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into()),
            ),
            ("TERM".to_string(), "xterm-256color".to_string()),
        ]
        .into_iter()
        .collect::<BTreeMap<_, _>>();
        let mut launched = launch(LaunchSpec {
            agent_id,
            session: &session,
            cwd: "/",
            cols: 80,
            rows: 24,
            argv: &argv,
            env: &env,
        })
        .await
        .expect("launch tmux agent");
        let (mirror_tx, mut mirror_rx) = mpsc::channel(128);
        launched.handle.control.set_sink(mirror_tx).await;
        tokio::spawn(async move { while mirror_rx.recv().await.is_some() {} });
        let mut direct = launched
            .handle
            .control
            .add_direct_sink("viewer".into())
            .await;

        launched.handle.write_stdin(b"before-capture\n").unwrap();
        collect_direct_until(&mut direct.receiver, b"before-capture").await;
        let paused = tmux::pause_pane(&session).await.expect("pause pane");
        launched
            .handle
            .control
            .wait_source_quiet(Duration::from_millis(25), Duration::from_secs(1))
            .await
            .expect("drain pre-capture output");
        launched.handle.write_stdin(b"during-capture\n").unwrap();
        let replay = tmux::capture_history(&session, 400, true)
            .await
            .expect("capture pane");
        assert!(String::from_utf8_lossy(&replay).contains("before-capture"));
        // TTY echo can still be rendered while the process group is stopped;
        // sampling after capture anchors those exact bytes instead of
        // duplicating them when the browser applies replay.
        assert!(String::from_utf8_lossy(&replay).contains("during-capture"));
        let boundary = launched
            .handle
            .control
            .wait_source_quiet(Duration::from_millis(25), Duration::from_secs(1))
            .await
            .expect("capture boundary");
        assert_eq!(
            launched
                .handle
                .control
                .direct_sink_anchor("viewer", boundary)
                .await,
            launched.handle.control.direct_sink_offset("viewer").await
        );
        paused.resume();
        tmux::force_repaint(&session).await;
        collect_direct_until(&mut direct.receiver, b"during-capture").await;
        launched.handle.write_stdin(b"after-capture\n").unwrap();
        collect_direct_until(&mut direct.receiver, b"after-capture").await;

        tmux::detach_clients(&session)
            .await
            .expect("detach old daemon client");
        launched.handle.cancel();
        drop(launched);
        tokio::time::sleep(Duration::from_millis(100)).await;
        let reattached = reattach(agent_id, &session)
            .await
            .expect("reattach tmux agent");
        let (mirror_tx, mut mirror_rx) = mpsc::channel(128);
        reattached.handle.control.set_sink(mirror_tx).await;
        tokio::spawn(async move { while mirror_rx.recv().await.is_some() {} });
        let mut reattached_direct = reattached
            .handle
            .control
            .add_direct_sink("reattached".into())
            .await;
        reattached.handle.write_stdin(b"after-reattach\n").unwrap();
        collect_direct_until(&mut reattached_direct.receiver, b"after-reattach").await;

        tmux::kill_session(&session)
            .await
            .expect("cleanup tmux session");
    }

    #[tokio::test]
    async fn producer_decision_precedes_enqueue_and_later_suppression() {
        let agent_id = Uuid::new_v4();
        let control = ForwarderControl::new();
        let (outbox_tx, outbox_rx) = mpsc::unbounded_channel();

        // The producer classifies and enqueues before the forwarder exists.
        // A later control event cannot mutate the queued decision.
        let chunk = source_output(&control, b"queued before suppression");
        assert!(chunk.activity);
        outbox_tx.send(chunk).unwrap();
        control.suppress_activity_at(Instant::now(), Duration::from_secs(60));

        let (sink_tx, mut sink_rx) = mpsc::channel(2);
        control.set_sink(sink_tx).await;
        let forwarder = tokio::spawn(run_forwarder(agent_id, outbox_rx, control));
        drop(outbox_tx);

        assert!(matches!(
            sink_rx.recv().await.unwrap(),
            WsOutbound::Binary(_)
        ));
        assert!(matches!(sink_rx.recv().await.unwrap(), WsOutbound::Json(_)));
        forwarder.await.unwrap();
    }

    #[tokio::test]
    async fn suppression_preceding_producer_decision_stays_with_queued_output() {
        let agent_id = Uuid::new_v4();
        let control = ForwarderControl::new();
        let (outbox_tx, outbox_rx) = mpsc::unbounded_channel();

        control.suppress_activity_at(Instant::now(), Duration::from_secs(60));
        let chunk = source_output(&control, b"queued during suppression");
        assert!(!chunk.activity);
        outbox_tx.send(chunk).unwrap();
        // Expiry/reconnect before forwarding must not cause reclassification.
        control.activity.lock().unwrap().suppress_output_until = None;

        let (sink_tx, mut sink_rx) = mpsc::channel(2);
        control.set_sink(sink_tx).await;
        let forwarder = tokio::spawn(run_forwarder(agent_id, outbox_rx, control));
        drop(outbox_tx);

        assert!(matches!(
            sink_rx.recv().await.unwrap(),
            WsOutbound::Binary(_)
        ));
        forwarder.await.unwrap();
        assert!(sink_rx.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn short_ambiguous_output_emits_after_bounded_idle_without_blocking_bytes() {
        for payload in [b"12:34".as_slice(), b" \"quoted real output\"".as_slice()] {
            let agent_id = Uuid::new_v4();
            let control = ForwarderControl::new();
            let (sink_tx, mut sink_rx) = mpsc::channel(4);
            control.set_sink(sink_tx).await;
            let (outbox_tx, outbox_rx) = mpsc::unbounded_channel();
            let forwarder = tokio::spawn(run_forwarder(agent_id, outbox_rx, control.clone()));

            let chunk = source_output(&control, payload);
            assert!(!chunk.activity);
            assert!(chunk.idle_resolution.is_some());
            outbox_tx.send(chunk).unwrap();

            // Terminal bytes are never held behind the classification debounce.
            assert!(matches!(
                sink_rx.recv().await.unwrap(),
                WsOutbound::Binary(_)
            ));
            assert!(sink_rx.try_recv().is_err());

            tokio::time::advance(activity::OUTPUT_IDLE_RESOLUTION_DELAY / 2).await;
            tokio::task::yield_now().await;
            assert!(sink_rx.try_recv().is_err());

            tokio::time::advance(activity::OUTPUT_IDLE_RESOLUTION_DELAY).await;
            tokio::task::yield_now().await;
            let WsOutbound::Json(json) = sink_rx.try_recv().expect("idle activity") else {
                panic!("expected idle activity JSON")
            };
            assert_eq!(
                json,
                format!(r#"{{"type":"agent.activity","agent_id":"{agent_id}"}}"#)
            );

            drop(outbox_tx);
            forwarder.await.unwrap();
        }
    }

    #[tokio::test(start_paused = true)]
    async fn delayed_decision_preserves_receipt_time_suppression_ordering() {
        // Suppression after receipt cannot erase eligible candidate text.
        let agent_id = Uuid::new_v4();
        let control = ForwarderControl::new();
        let (sink_tx, mut sink_rx) = mpsc::channel(4);
        control.set_sink(sink_tx).await;
        let (outbox_tx, outbox_rx) = mpsc::unbounded_channel();
        let forwarder = tokio::spawn(run_forwarder(agent_id, outbox_rx, control.clone()));
        outbox_tx.send(source_output(&control, b"12:34")).unwrap();
        assert!(matches!(
            sink_rx.recv().await.unwrap(),
            WsOutbound::Binary(_)
        ));
        control.suppress_activity(Duration::from_secs(60));
        tokio::time::advance(activity::OUTPUT_IDLE_RESOLUTION_DELAY * 2).await;
        tokio::task::yield_now().await;
        assert!(matches!(sink_rx.try_recv().unwrap(), WsOutbound::Json(_)));
        drop(outbox_tx);
        forwarder.await.unwrap();

        // Suppression at receipt remains immutable even if it is cleared before
        // the candidate resolves.
        let agent_id = Uuid::new_v4();
        let control = ForwarderControl::new();
        control.suppress_activity(Duration::from_secs(60));
        let (sink_tx, mut sink_rx) = mpsc::channel(4);
        control.set_sink(sink_tx).await;
        let (outbox_tx, outbox_rx) = mpsc::unbounded_channel();
        let forwarder = tokio::spawn(run_forwarder(agent_id, outbox_rx, control.clone()));
        outbox_tx
            .send(source_output(&control, b" \"quoted real output\""))
            .unwrap();
        assert!(matches!(
            sink_rx.recv().await.unwrap(),
            WsOutbound::Binary(_)
        ));
        control.activity.lock().unwrap().suppress_output_until = None;
        tokio::time::advance(activity::OUTPUT_IDLE_RESOLUTION_DELAY * 2).await;
        tokio::task::yield_now().await;
        assert!(sink_rx.try_recv().is_err());
        drop(outbox_tx);
        forwarder.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn complete_tmux_status_stays_suppressed_at_every_split_with_idle_debounce() {
        for payload in [
            b"[spawn-oem] \"bash\" 12:34 15-Jul-26".as_slice(),
            b"           \"project\" 04:49 08-May-26".as_slice(),
            b"12:34 15-Jul-26".as_slice(),
        ] {
            for split in 0..=payload.len() {
                let agent_id = Uuid::new_v4();
                let control = ForwarderControl::new();
                let (sink_tx, mut sink_rx) = mpsc::channel(4);
                control.set_sink(sink_tx).await;
                let (outbox_tx, outbox_rx) = mpsc::unbounded_channel();
                let forwarder = tokio::spawn(run_forwarder(agent_id, outbox_rx, control.clone()));

                // Let the first half reach the forwarder and arm its timer,
                // then complete the status before the debounce expires.
                outbox_tx
                    .send(source_output(&control, &payload[..split]))
                    .unwrap();
                assert!(matches!(
                    sink_rx.recv().await.unwrap(),
                    WsOutbound::Binary(_)
                ));
                tokio::time::advance(activity::OUTPUT_IDLE_RESOLUTION_DELAY / 2).await;
                tokio::task::yield_now().await;
                assert!(sink_rx.try_recv().is_err());

                outbox_tx
                    .send(source_output(&control, &payload[split..]))
                    .unwrap();
                assert!(matches!(
                    sink_rx.recv().await.unwrap(),
                    WsOutbound::Binary(_)
                ));
                tokio::time::advance(activity::OUTPUT_IDLE_RESOLUTION_DELAY * 2).await;
                tokio::task::yield_now().await;
                assert!(
                    sink_rx.try_recv().is_err(),
                    "status emitted activity at split {split} for {payload:?}"
                );

                drop(outbox_tx);
                forwarder.await.unwrap();
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn pending_idle_timer_is_cancelled_when_agent_outbox_closes() {
        let agent_id = Uuid::new_v4();
        let control = ForwarderControl::new();
        let (sink_tx, mut sink_rx) = mpsc::channel(4);
        control.set_sink(sink_tx).await;
        let (outbox_tx, outbox_rx) = mpsc::unbounded_channel();
        let forwarder = tokio::spawn(run_forwarder(agent_id, outbox_rx, control.clone()));

        outbox_tx.send(source_output(&control, b"12:34")).unwrap();
        assert!(matches!(
            sink_rx.recv().await.unwrap(),
            WsOutbound::Binary(_)
        ));
        drop(outbox_tx);
        forwarder.await.unwrap();

        tokio::time::advance(activity::OUTPUT_IDLE_RESOLUTION_DELAY * 2).await;
        tokio::task::yield_now().await;
        assert!(sink_rx.try_recv().is_err());
    }
}
