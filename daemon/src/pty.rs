//! Per-agent terminal routing shared by `spawnd` and the mandatory session
//! worker backend.
//!
//! A `spawn-worker` owns each agent's PTY. Its output enters a bounded
//! per-agent outbox and a long-lived forwarder routes it to the current server
//! connection plus bounded direct DataChannel sinks. Workers and their PTYs
//! survive `spawnd` reconnects/restarts; `spawnd` never owns a second terminal
//! emulator or shells out to a multiplexer.

use std::collections::{BTreeMap, HashMap};
use std::future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use spawnd::sessiond::wire;
use tokio::net::UnixDatagram;
use tokio::sync::{mpsc, oneshot, watch, Mutex as AsyncMutex, Notify};
use uuid::Uuid;
use zeroize::Zeroize;

use crate::activity;
use crate::proto::Outbound;

#[derive(Clone, Debug)]
pub struct WsOutbound(String);

impl WsOutbound {
    pub(crate) fn json(text: String) -> Self {
        Self(text)
    }

    pub(crate) fn into_text(mut self) -> String {
        std::mem::take(&mut self.0)
    }

    #[cfg(test)]
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }

    pub(crate) fn wipe(&mut self) {
        self.0.zeroize();
    }
}

impl Drop for WsOutbound {
    fn drop(&mut self) {
        self.wipe();
    }
}

/// The thing the WS session hands to a per-agent forwarder so that bytes
/// route to the current connection.
pub type SessionSink = mpsc::Sender<WsOutbound>;

#[cfg(test)]
type DirectWipeProbe = Arc<dyn Fn(&[u8]) + Send + Sync>;

/// Plaintext owned by a bounded direct-viewer queue. It wipes itself whether
/// consumed normally, rejected by a full queue, or drained during teardown.
pub struct DirectPayload {
    bytes: Vec<u8>,
    #[cfg(test)]
    wipe_probe: Option<DirectWipeProbe>,
}

impl DirectPayload {
    pub(crate) fn new(bytes: Vec<u8>) -> Self {
        Self {
            bytes,
            #[cfg(test)]
            wipe_probe: None,
        }
    }

    #[cfg(test)]
    fn with_wipe_probe(bytes: Vec<u8>, wipe_probe: DirectWipeProbe) -> Self {
        Self {
            bytes,
            wipe_probe: Some(wipe_probe),
        }
    }
}

impl std::fmt::Debug for DirectPayload {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DirectPayload")
            .field("len", &self.bytes.len())
            .finish_non_exhaustive()
    }
}

impl std::ops::Deref for DirectPayload {
    type Target = [u8];

    fn deref(&self) -> &Self::Target {
        &self.bytes
    }
}

impl<const N: usize> PartialEq<&[u8; N]> for DirectPayload {
    fn eq(&self, other: &&[u8; N]) -> bool {
        self.bytes.as_slice() == other.as_slice()
    }
}

impl Drop for DirectPayload {
    fn drop(&mut self) {
        self.bytes.as_mut_slice().zeroize();
        #[cfg(test)]
        if let Some(probe) = self.wipe_probe.as_ref() {
            probe(&self.bytes);
        }
    }
}

/// A direct viewer receives bounded chunks. If it cannot keep up, the
/// forwarder disconnects it and the browser reconnects through replay.
pub struct DirectSinkReceiver {
    pub receiver: mpsc::Receiver<DirectPayload>,
    pub disconnected: watch::Receiver<bool>,
}

/// One committed-history event fanned out to a viewer: either a batch of
/// committed lines (with its epoch/offset anchor) or a scrollback wipe. The
/// stream mirrors the worker's encrypted log exactly.
pub enum HistoryUpdate {
    Delta {
        epoch: u64,
        offset: u64,
        payload: DirectPayload,
    },
    Wipe {
        epoch: u64,
    },
}

/// Committed-line batches are small (only lines that scrolled off commit),
/// but a large paste or `seq`-style flood commits one batch per 2 KiB of
/// input, so the queue is deeper than the raw-output sink's.
pub const HISTORY_SINK_QUEUE_DEPTH: usize = 256;

pub const DIRECT_SINK_QUEUE_DEPTH: usize = 128;
pub const DIRECT_SINK_CHUNK_BYTES: usize = 16 * 1024;
pub const WORKER_OUTPUT_QUEUE_DEPTH: usize = 32;
pub const WORKER_COMMAND_QUEUE_DEPTH: usize = 32;
pub const MAX_WORKER_INPUT_BYTES: usize = 64 * 1024;
const LIFECYCLE_DELIVERY_TIMEOUT: Duration = Duration::from_secs(2);

/// Immutable result of handling one output event at its producer. Immediate
/// activity and the eligibility/generation of an ambiguous idle candidate are
/// stamped before raw bytes enter the asynchronous outbox, so later input,
/// resize, or redraw suppression cannot retroactively change that event.
#[derive(Debug)]
pub(crate) struct OutputChunk {
    bytes: Vec<u8>,
    /// End watermark in the producer's byte coordinate. Worker output carries
    /// its durable log watermark.
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

    #[cfg(test)]
    pub(crate) fn is_activity(&self) -> bool {
        self.activity
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

impl Drop for OutputChunk {
    fn drop(&mut self) {
        self.bytes.zeroize();
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
    serde_json::to_string(&event).ok().map(WsOutbound::json)
}

/// Best-effort emission used by the WebRTC input callback. The sink accepts
/// serialized control-plane JSON only; it has no terminal-byte variant.
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
    sink: mpsc::Sender<DirectPayload>,
    disconnected: watch::Sender<bool>,
    source_origin: u64,
    bytes_sent: Arc<AtomicU64>,
}

/// Shared between an agent's forwarder task and the WS session lifecycle.
/// `slot` holds the current session's bounded outbound sink (or `None` between
/// sessions).
#[derive(Clone)]
pub struct ForwarderControl {
    slot: Arc<AsyncMutex<Option<SessionSink>>>,
    direct_sinks: Arc<AsyncMutex<HashMap<String, DirectSinkEntry>>>,
    direct_sink_notify: Arc<Notify>,
    /// Committed-history delta subscribers, keyed by viewer session. A sink
    /// that falls behind is dropped; its receiver closing tells the pump to
    /// report a gap so the client re-anchors from a fresh replay.
    history_sinks: Arc<AsyncMutex<HashMap<String, mpsc::Sender<HistoryUpdate>>>>,
    source_offset: Arc<AtomicU64>,
    source_notify: Arc<Notify>,
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

impl ForwarderControl {
    pub(crate) fn new() -> Self {
        Self {
            slot: Arc::new(AsyncMutex::new(None)),
            direct_sinks: Arc::new(AsyncMutex::new(HashMap::new())),
            direct_sink_notify: Arc::new(Notify::new()),
            history_sinks: Arc::new(AsyncMutex::new(HashMap::new())),
            source_offset: Arc::new(AtomicU64::new(0)),
            source_notify: Arc::new(Notify::new()),
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

    /// Install the current WS session's outbound sink. Output produced while
    /// no sink was present is recovered from worker replay, not retained here.
    pub async fn set_sink(&self, sink: SessionSink) {
        *self.slot.lock().await = Some(sink);
    }

    /// Clear the sink (called when the WS session ends). Direct routing keeps
    /// draining the bounded worker outbox; no legacy plaintext backlog forms.
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

    /// Subscribe a viewer to committed-history deltas. Replacing an existing
    /// subscription closes the previous receiver.
    pub async fn add_history_sink(&self, id: String) -> mpsc::Receiver<HistoryUpdate> {
        let (sink, receiver) = mpsc::channel(HISTORY_SINK_QUEUE_DEPTH);
        self.history_sinks.lock().await.insert(id, sink);
        receiver
    }

    pub async fn remove_history_sink(&self, id: &str) {
        self.history_sinks.lock().await.remove(id);
    }

    /// Fan one committed-history event out to every subscriber. A full queue
    /// drops that subscriber (closing its receiver), which the consumer
    /// surfaces to its client as a gap to heal via replay.
    pub async fn route_history(&self, epoch: u64, offset: Option<u64>, bytes: &[u8]) {
        let mut sinks = self.history_sinks.lock().await;
        sinks.retain(|_, sink| {
            let update = match offset {
                Some(offset) => HistoryUpdate::Delta {
                    epoch,
                    offset,
                    payload: DirectPayload::new(bytes.to_vec()),
                },
                None => HistoryUpdate::Wipe { epoch },
            };
            sink.try_send(update).is_ok()
        });
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
    #[cfg(test)]
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
                if entry
                    .sink
                    .try_send(DirectPayload::new(part.to_vec()))
                    .is_err()
                {
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

    #[cfg(test)]
    pub(crate) async fn route_direct_for_test(&self, chunk: &[u8]) {
        self.route_direct(chunk, None).await;
    }
}

#[cfg(test)]
type ReplayWipeProbe = Arc<dyn Fn(&[u8]) + Send + Sync>;

/// Decrypted replay owned by spawnd. The bytes wipe on every drop path,
/// including receiver cancellation after a successful oneshot send.
pub struct WorkerReplay {
    watermark: u64,
    bytes: Vec<u8>,
    /// `(epoch, offset)` of the committed-history stream at capture, when the
    /// worker streams history deltas. The offset ends on a batch boundary, so
    /// a delta with exactly this start offset appends seamlessly.
    history_anchor: Option<(u64, u64)>,
    #[cfg(test)]
    wipe_probe: Option<ReplayWipeProbe>,
}

impl WorkerReplay {
    pub(crate) fn new(watermark: u64, bytes: Vec<u8>) -> Self {
        Self {
            watermark,
            bytes,
            history_anchor: None,
            #[cfg(test)]
            wipe_probe: None,
        }
    }

    pub(crate) fn new_with_history(watermark: u64, bytes: Vec<u8>, anchor: (u64, u64)) -> Self {
        Self {
            watermark,
            bytes,
            history_anchor: Some(anchor),
            #[cfg(test)]
            wipe_probe: None,
        }
    }

    pub fn watermark(&self) -> u64 {
        self.watermark
    }

    pub fn history_anchor(&self) -> Option<(u64, u64)> {
        self.history_anchor
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    #[cfg(test)]
    pub(crate) fn with_wipe_probe(
        watermark: u64,
        bytes: Vec<u8>,
        wipe_probe: ReplayWipeProbe,
    ) -> Self {
        Self {
            watermark,
            bytes,
            history_anchor: None,
            wipe_probe: Some(wipe_probe),
        }
    }
}

impl std::fmt::Debug for WorkerReplay {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WorkerReplay")
            .field("watermark", &self.watermark)
            .field("len", &self.bytes.len())
            .finish_non_exhaustive()
    }
}

impl Drop for WorkerReplay {
    fn drop(&mut self) {
        self.bytes.as_mut_slice().zeroize();
        #[cfg(test)]
        if let Some(probe) = self.wipe_probe.as_ref() {
            probe(&self.bytes);
        }
    }
}

/// Commands routed from spawnd to a session worker's socket writer.
pub type WorkerReplayResult = Result<WorkerReplay>;
pub type WorkerReplayReceiver = oneshot::Receiver<WorkerReplayResult>;

#[derive(Debug)]
pub enum WorkerCmd {
    Input(DirectPayload),
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
}

#[derive(Clone)]
pub struct AgentLifecycle {
    socket: PathBuf,
    instance_id: Uuid,
}

impl AgentLifecycle {
    pub(crate) fn new(socket: PathBuf, instance_id: Uuid) -> Self {
        Self {
            socket,
            instance_id,
        }
    }

    pub async fn shutdown(&self, signal: wire::LifecycleSignal) -> Result<()> {
        let deadline = tokio::time::Instant::now() + LIFECYCLE_DELIVERY_TIMEOUT;
        let request = wire::encode_lifecycle_request(self.instance_id, signal);
        loop {
            if tokio::time::Instant::now() >= deadline {
                anyhow::bail!("worker lifecycle delivery deadline exceeded");
            }
            if spawnd::sessiond::endpoint::validate_private_socket(&self.socket).is_err() {
                anyhow::bail!("worker lifecycle endpoint validation failed");
            }
            let parent = self
                .socket
                .parent()
                .ok_or_else(|| anyhow::anyhow!("worker lifecycle endpoint validation failed"))?;
            let client_path = parent.join(format!(
                ".lifecycle-client-{}-{}.sock",
                std::process::id(),
                Uuid::new_v4()
            ));
            let socket = UnixDatagram::bind(&client_path)
                .map_err(|_| anyhow::anyhow!("worker lifecycle client unavailable"))?;
            let _client_identity = spawnd::sessiond::endpoint::secure_bound_socket(&client_path)
                .map_err(|_| anyhow::anyhow!("worker lifecycle client validation failed"))?;
            if socket.connect(&self.socket).is_err() {
                tokio::time::sleep_until(std::cmp::min(
                    deadline,
                    tokio::time::Instant::now() + Duration::from_millis(10),
                ))
                .await;
                continue;
            }
            match tokio::time::timeout_at(deadline, socket.send(&request)).await {
                Ok(Ok(_)) => {}
                Ok(Err(_)) => {
                    tokio::time::sleep_until(std::cmp::min(
                        deadline,
                        tokio::time::Instant::now() + Duration::from_millis(10),
                    ))
                    .await;
                    continue;
                }
                Err(_) => anyhow::bail!("worker lifecycle delivery deadline exceeded"),
            }
            let mut ack = [0u8; 2];
            let attempt_deadline = std::cmp::min(
                deadline,
                tokio::time::Instant::now() + Duration::from_millis(100),
            );
            let received = tokio::time::timeout_at(attempt_deadline, socket.recv(&mut ack)).await;
            let Ok(Ok(1)) = received else {
                tokio::time::sleep_until(std::cmp::min(
                    deadline,
                    tokio::time::Instant::now() + Duration::from_millis(10),
                ))
                .await;
                continue;
            };
            return match ack[0] {
                wire::LIFECYCLE_ACK_DELIVERED => Ok(()),
                wire::LIFECYCLE_ACK_GONE => anyhow::bail!("agent process already exited"),
                wire::LIFECYCLE_ACK_WRONG_INSTANCE => {
                    anyhow::bail!("worker lifecycle instance changed")
                }
                _ => anyhow::bail!("worker lifecycle delivery failed"),
            };
        }
    }
}

/// Per-agent runtime handle.
pub struct AgentHandle {
    pub agent_id: Uuid,
    /// Canonical cwd capability root reported by the worker that owns this
    /// exact backend generation.
    pub cwd: Arc<str>,
    /// Last size applied through this handle.
    size: Arc<Mutex<(u16, u16)>>,
    /// Held alive while the agent is alive; when dropped, the per-agent
    /// forwarder task exits after the worker connection closes.
    #[allow(dead_code)]
    outbox_tx: mpsc::Sender<OutputChunk>,
    /// Lets the WS session install/clear the forwarder's current sink.
    pub control: ForwarderControl,
    cmd_tx: mpsc::Sender<WorkerCmd>,
    lifecycle: AgentLifecycle,
    alive: Arc<AtomicBool>,
    #[cfg(test)]
    input_copies: Arc<AtomicU64>,
}

/// Everything `worker_backend` needs to assemble a worker-backed handle.
pub struct WorkerHandleParts {
    pub agent_id: Uuid,
    pub cwd: String,
    pub cmd_tx: mpsc::Sender<WorkerCmd>,
    pub lifecycle: AgentLifecycle,
    pub alive: Arc<AtomicBool>,
    pub cols: u16,
    pub rows: u16,
    pub outbox_tx: mpsc::Sender<OutputChunk>,
    pub control: ForwarderControl,
}

impl AgentHandle {
    pub fn new_worker(parts: WorkerHandleParts) -> Self {
        Self {
            agent_id: parts.agent_id,
            cwd: Arc::from(parts.cwd),
            size: Arc::new(Mutex::new((parts.cols, parts.rows))),
            outbox_tx: parts.outbox_tx,
            control: parts.control,
            cmd_tx: parts.cmd_tx,
            lifecycle: parts.lifecycle,
            alive: parts.alive,
            #[cfg(test)]
            input_copies: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn write_stdin(&self, bytes: &[u8]) -> Result<()> {
        self.validate_input(bytes.len())?;
        #[cfg(test)]
        self.input_copies.fetch_add(1, Ordering::Relaxed);
        self.write_stdin_owned(DirectPayload::new(bytes.to_vec()))
    }

    pub(crate) fn write_stdin_owned(&self, bytes: DirectPayload) -> Result<()> {
        self.validate_input(bytes.len())?;
        self.enqueue_input(bytes)
    }

    fn validate_input(&self, len: usize) -> Result<()> {
        if !self.alive.load(Ordering::Acquire) {
            anyhow::bail!("worker connection gone");
        }
        if len > MAX_WORKER_INPUT_BYTES {
            anyhow::bail!("worker input exceeds {MAX_WORKER_INPUT_BYTES} byte limit");
        }
        Ok(())
    }

    fn enqueue_input(&self, bytes: DirectPayload) -> Result<()> {
        self.cmd_tx
            .try_send(WorkerCmd::Input(bytes))
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => anyhow::anyhow!("worker command queue full"),
                mpsc::error::TrySendError::Closed(_) => anyhow::anyhow!("worker connection gone"),
            })?;
        // Only admitted input can have an echo that should suppress activity.
        self.control
            .suppress_activity(activity::INPUT_ECHO_SUPPRESS_WINDOW);
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<bool> {
        let mut size = self
            .size
            .lock()
            .map_err(|_| anyhow::anyhow!("pty size lock poisoned"))?;
        if *size == (cols, rows) {
            return Ok(false);
        }
        if !self.alive.load(Ordering::Acquire) {
            anyhow::bail!("worker connection gone");
        }
        self.cmd_tx
            .try_send(WorkerCmd::Resize { cols, rows })
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => anyhow::anyhow!("worker command queue full"),
                mpsc::error::TrySendError::Closed(_) => anyhow::anyhow!("worker connection gone"),
            })?;
        *size = (cols, rows);
        // Only an admitted resize can trigger a repaint.
        self.control
            .suppress_activity(activity::REDRAW_SUPPRESS_WINDOW);
        Ok(true)
    }

    pub fn lifecycle(&self) -> AgentLifecycle {
        self.lifecycle.clone()
    }

    #[cfg(test)]
    pub(crate) fn worker_connection_keepalive(&self) -> mpsc::Sender<WorkerCmd> {
        self.cmd_tx.clone()
    }

    #[cfg(test)]
    pub(crate) fn input_copy_count(&self) -> u64 {
        self.input_copies.load(Ordering::Relaxed)
    }

    /// Request decrypted scrollback replay from the owning worker.
    pub fn replay(&self, max_bytes: u32) -> Option<WorkerReplayReceiver> {
        if !self.alive.load(Ordering::Acquire) {
            return None;
        }
        let (resp, rx) = oneshot::channel();
        self.cmd_tx
            .try_send(WorkerCmd::Replay { max_bytes, resp })
            .ok()?;
        Some(rx)
    }
}

pub struct LaunchSpec<'a> {
    pub agent_id: Uuid,
    pub cwd: &'a str,
    pub cols: u16,
    pub rows: u16,
    pub argv: &'a [String],
    /// Final env to pass to the launched agent.
    pub env: &'a BTreeMap<String, String>,
}

/// Result of a successful launch.
pub struct Launched {
    pub handle: AgentHandle,
    /// PID of the real agent process, reported by its session worker.
    pub pid: u32,
    /// Future-style: receives the exit reason once the PTY EOFs.
    pub exit_rx: oneshot::Receiver<ExitReason>,
}

#[derive(Debug, Clone)]
pub struct ExitReason {
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
}

/// Long-lived per-agent task: route raw PTY bytes only to bounded direct
/// DataChannel sinks and emit content-free activity metadata to the current
/// control-plane session. Worker replay is the only catch-up source.
/// Exits when every bounded-outbox sender is dropped.
pub(crate) async fn run_forwarder(
    agent_id: Uuid,
    mut outbox_rx: mpsc::Receiver<OutputChunk>,
    control: ForwarderControl,
) {
    let mut idle_timer: Option<IdleResolutionTimer> = None;
    loop {
        tokio::select! {
            chunk = outbox_rx.recv() => match chunk {
                Some(chunk) => queue_output_chunk(
                    agent_id,
                    chunk,
                    &control,
                    &mut idle_timer,
                ).await,
                None => break,
            },
            generation = wait_for_idle(&mut idle_timer) => {
                idle_timer = None;
                if control.resolve_output_idle(generation) {
                    if let Some(activity) = activity_message(agent_id, ActivityKind::Output) {
                        try_mirror(&control, activity).await;
                    }
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
    idle_timer: &mut Option<IdleResolutionTimer>,
) {
    *idle_timer = chunk.idle_resolution.map(IdleResolutionTimer::new);
    control.route_direct(&chunk.bytes, chunk.source_end).await;
    if chunk.source_barrier {
        return;
    }
    if chunk.activity {
        if let Some(activity) = activity_message(agent_id, ActivityKind::Output) {
            try_mirror(control, activity).await;
        }
    }
}

async fn try_mirror(control: &ForwarderControl, message: WsOutbound) {
    let Some(sink) = control.slot.lock().await.clone() else {
        return;
    };
    if sink.try_send(message).is_ok() {
        return;
    }
    // A missing/slow legacy mirror never holds PTY plaintext hostage. Detach
    // this sink; direct viewers continue, and reconnect catch-up comes from the
    // worker's bounded replay log.
    let mut slot = control.slot.lock().await;
    if slot
        .as_ref()
        .is_some_and(|current| current.same_channel(&sink))
    {
        *slot = None;
    }
}

async fn wait_for_idle(idle_timer: &mut Option<IdleResolutionTimer>) -> u64 {
    let Some(timer) = idle_timer else {
        return future::pending().await;
    };
    timer.sleep.as_mut().await;
    timer.generation
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixDatagram as StdUnixDatagram;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

    struct ChildCleanup(std::process::Child);

    impl Drop for ChildCleanup {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn saturate_lifecycle_endpoint(
        dir: &std::path::Path,
        server_path: &std::path::Path,
    ) -> (
        StdUnixDatagram,
        StdUnixDatagram,
        spawnd::sessiond::endpoint::EndpointIdentity,
    ) {
        spawnd::sessiond::endpoint::ensure_private_dir(dir)
            .expect("secure saturated lifecycle directory");
        let server = StdUnixDatagram::bind(server_path).expect("bind saturated lifecycle server");
        let identity = spawnd::sessiond::endpoint::secure_bound_socket(server_path)
            .expect("secure saturated lifecycle server");
        let flood_path = dir.join("flood.sock");
        let flood = StdUnixDatagram::bind(&flood_path).expect("bind lifecycle flood sender");
        flood
            .connect(server_path)
            .expect("connect lifecycle flood sender");
        flood
            .set_nonblocking(true)
            .expect("set lifecycle flood sender nonblocking");
        let payload = [0u8; wire::LIFECYCLE_REQUEST_LEN];
        let mut saturated = false;
        for _ in 0..1024 {
            match flood.send(&payload) {
                Ok(size) => assert_eq!(size, payload.len()),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    saturated = true;
                    break;
                }
                Err(error) => panic!("saturating lifecycle endpoint failed: {error}"),
            }
        }
        assert!(saturated, "lifecycle endpoint did not become nonwritable");
        (server, flood, identity)
    }

    #[tokio::test]
    async fn lifecycle_shutdown_send_obeys_the_absolute_deadline() {
        let dir = tempfile::tempdir().expect("lifecycle timeout tempdir");
        let server_path = dir.path().join("lifecycle.sock");
        let (_server, _flood, _identity) = saturate_lifecycle_endpoint(dir.path(), &server_path);
        let mut unrelated = ChildCleanup(
            std::process::Command::new("sleep")
                .arg("30")
                .spawn()
                .expect("spawn unrelated sentinel process"),
        );
        let lifecycle = AgentLifecycle::new(server_path, Uuid::new_v4());
        let started = tokio::time::Instant::now();
        let error = tokio::time::timeout(
            LIFECYCLE_DELIVERY_TIMEOUT + Duration::from_secs(1),
            lifecycle.shutdown(wire::LifecycleSignal::Kill),
        )
        .await
        .expect("lifecycle send exceeded its advertised deadline")
        .expect_err("saturated lifecycle endpoint accepted shutdown");
        assert!(error
            .to_string()
            .contains("worker lifecycle delivery deadline exceeded"));
        assert!(
            started.elapsed() <= LIFECYCLE_DELIVERY_TIMEOUT + Duration::from_millis(500),
            "lifecycle send returned beyond its deadline"
        );
        assert!(
            unrelated.0.try_wait().unwrap().is_none(),
            "lifecycle timeout touched an unrelated process"
        );
    }

    fn source_output(control: &ForwarderControl, bytes: &[u8]) -> OutputChunk {
        OutputChunk::classify(bytes.to_vec(), control)
    }

    fn test_handle(
        control: ForwarderControl,
        cmd_tx: mpsc::Sender<WorkerCmd>,
        alive: Arc<AtomicBool>,
    ) -> AgentHandle {
        let (outbox_tx, _outbox_rx) = mpsc::channel(WORKER_OUTPUT_QUEUE_DEPTH);
        AgentHandle::new_worker(WorkerHandleParts {
            agent_id: Uuid::new_v4(),
            cwd: "/".into(),
            cmd_tx,
            lifecycle: AgentLifecycle::new(
                PathBuf::from("/nonexistent/spawn-test-lifecycle.sock"),
                Uuid::new_v4(),
            ),
            alive,
            cols: 80,
            rows: 24,
            outbox_tx,
            control,
        })
    }

    #[test]
    fn rejected_commands_do_not_suppress_genuine_output_activity() {
        let oversized_control = ForwarderControl::new();
        let (oversized_tx, _oversized_rx) = mpsc::channel(WORKER_COMMAND_QUEUE_DEPTH);
        let oversized = test_handle(
            oversized_control.clone(),
            oversized_tx,
            Arc::new(AtomicBool::new(true)),
        );
        assert!(oversized
            .write_stdin(&vec![b'x'; MAX_WORKER_INPUT_BYTES + 1])
            .is_err());
        assert!(source_output(&oversized_control, b"genuine oversized rejection output").activity);

        let dead_control = ForwarderControl::new();
        let (dead_tx, _dead_rx) = mpsc::channel(WORKER_COMMAND_QUEUE_DEPTH);
        let dead = test_handle(
            dead_control.clone(),
            dead_tx,
            Arc::new(AtomicBool::new(false)),
        );
        assert!(dead.write_stdin(b"rejected dead input").is_err());
        assert!(source_output(&dead_control, b"genuine dead rejection output").activity);

        for resize in [false, true] {
            let control = ForwarderControl::new();
            let (cmd_tx, _cmd_rx) = mpsc::channel(WORKER_COMMAND_QUEUE_DEPTH);
            for index in 0..WORKER_COMMAND_QUEUE_DEPTH {
                cmd_tx
                    .try_send(WorkerCmd::Resize {
                        cols: 80 + index as u16,
                        rows: 24,
                    })
                    .unwrap();
            }
            let handle = test_handle(control.clone(), cmd_tx, Arc::new(AtomicBool::new(true)));
            if resize {
                assert!(handle.resize(120, 40).is_err());
            } else {
                assert!(handle.write_stdin(b"rejected full input").is_err());
            }
            assert!(source_output(&control, b"genuine full queue rejection output").activity);
        }
    }

    #[test]
    fn admitted_input_and_resize_suppress_their_expected_echoes() {
        let input_control = ForwarderControl::new();
        let (input_tx, _input_rx) = mpsc::channel(WORKER_COMMAND_QUEUE_DEPTH);
        let input = test_handle(
            input_control.clone(),
            input_tx,
            Arc::new(AtomicBool::new(true)),
        );
        input.write_stdin(b"accepted input").unwrap();
        assert!(!source_output(&input_control, b"accepted input echo").activity);

        let resize_control = ForwarderControl::new();
        let (resize_tx, _resize_rx) = mpsc::channel(WORKER_COMMAND_QUEUE_DEPTH);
        let resize = test_handle(
            resize_control.clone(),
            resize_tx,
            Arc::new(AtomicBool::new(true)),
        );
        assert!(resize.resize(120, 40).unwrap());
        assert!(!source_output(&resize_control, b"resize repaint output").activity);
    }

    #[test]
    fn queued_direct_plaintext_wipes_on_rejection_and_teardown() {
        let observed = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
        let direct_observed = Arc::clone(&observed);
        let direct_probe: DirectWipeProbe = Arc::new(move |bytes| {
            direct_observed.lock().unwrap().push(bytes.to_vec());
        });
        let (tx, rx) = mpsc::channel(1);
        tx.try_send(DirectPayload::with_wipe_probe(
            b"queued direct plaintext".to_vec(),
            Arc::clone(&direct_probe),
        ))
        .unwrap();
        assert!(tx
            .try_send(DirectPayload::with_wipe_probe(
                b"rejected direct plaintext".to_vec(),
                direct_probe,
            ))
            .is_err());
        drop(rx);
        drop(tx);

        let observed = observed.lock().unwrap();
        assert_eq!(observed.len(), 2);
        assert!(observed
            .iter()
            .all(|bytes| bytes.iter().all(|byte| *byte == 0)));
    }

    #[tokio::test]
    async fn verbose_output_with_absent_then_stalled_mirror_keeps_direct_viewer_healthy() {
        let agent_id = Uuid::new_v4();
        let control = ForwarderControl::new();
        let direct = control.add_direct_sink("healthy".into()).await;
        let mut direct_rx = direct.receiver;
        let mut disconnected = direct.disconnected;
        let (outbox_tx, outbox_rx) = mpsc::channel(WORKER_OUTPUT_QUEUE_DEPTH);
        assert_eq!(outbox_tx.max_capacity(), WORKER_OUTPUT_QUEUE_DEPTH);
        let forwarder = tokio::spawn(run_forwarder(agent_id, outbox_rx, control.clone()));
        let received = Arc::new(AtomicUsize::new(0));
        let received_task = Arc::clone(&received);
        let chunk = vec![b'x'; 8 * 1024];
        let absent_chunks = 256usize;
        let stalled_chunks = 256usize;
        let expected_bytes = (absent_chunks + stalled_chunks) * chunk.len();
        let direct_drain = tokio::spawn(async move {
            while received_task.load(AtomicOrdering::Relaxed) < expected_bytes {
                let chunk = direct_rx.recv().await.expect("healthy direct sink closed");
                received_task.fetch_add(chunk.len(), AtomicOrdering::Relaxed);
            }
        });

        for _ in 0..absent_chunks {
            outbox_tx
                .send(source_output(&control, &chunk))
                .await
                .unwrap();
        }

        let (stalled_tx, _stalled_rx) = mpsc::channel(1);
        control.set_sink(stalled_tx).await;
        for index in 0..stalled_chunks {
            let mut output = source_output(&control, &chunk);
            // Model the next activity interval without sleeping: a full
            // content-free server queue must detach while direct PTY delivery
            // continues unaffected.
            if index <= 1 {
                output.activity = true;
            }
            outbox_tx.send(output).await.unwrap();
        }
        drop(outbox_tx);
        forwarder.await.unwrap();
        direct_drain.await.unwrap();

        assert!(!*disconnected.borrow_and_update());
        assert_eq!(
            received.load(AtomicOrdering::Relaxed),
            (absent_chunks + stalled_chunks) * chunk.len()
        );
        assert!(control.slot.lock().await.is_none());
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

        let output = rx.recv().await.unwrap();
        let output_json = output.as_str();
        let input = rx.recv().await.unwrap();
        let input_json = input.as_str();
        assert_eq!(
            output_json,
            &format!(r#"{{"type":"agent.activity","agent_id":"{agent_id}"}}"#)
        );
        assert_eq!(
            input_json,
            &format!(r#"{{"type":"agent.input_activity","agent_id":"{agent_id}"}}"#)
        );
    }

    #[tokio::test]
    async fn forwarder_keeps_output_off_server_and_emits_content_free_activity() {
        let agent_id = Uuid::new_v4();
        let control = ForwarderControl::new();
        let (sink_tx, mut sink_rx) = mpsc::channel(4);
        control.set_sink(sink_tx).await;
        let (outbox_tx, outbox_rx) = mpsc::channel(WORKER_OUTPUT_QUEUE_DEPTH);
        let forwarder = tokio::spawn(run_forwarder(agent_id, outbox_rx, control.clone()));

        outbox_tx
            .try_send(source_output(&control, b"sensitive terminal output"))
            .unwrap();
        drop(outbox_tx);

        let activity_message = sink_rx.recv().await.unwrap();
        let activity_json = activity_message.as_str();
        assert_eq!(
            activity_json,
            &format!(r#"{{"type":"agent.activity","agent_id":"{agent_id}"}}"#)
        );
        assert!(!activity_json.contains("sensitive terminal output"));
        assert!(sink_rx.try_recv().is_err());
        forwarder.await.unwrap();
    }

    #[tokio::test]
    async fn stalled_mirror_is_detached_while_direct_output_continues() {
        let agent_id = Uuid::new_v4();
        let control = ForwarderControl::new();
        let mut direct = control.add_direct_sink("test".into()).await;

        // Capacity one deliberately blocks activity metadata after its first
        // ping. Direct receipts prove terminal bytes never use that queue.
        let (sink_tx, mut sink_rx) = mpsc::channel(1);
        control.set_sink(sink_tx).await;
        let (outbox_tx, outbox_rx) = mpsc::channel(WORKER_OUTPUT_QUEUE_DEPTH);
        let forwarder = tokio::spawn(run_forwarder(agent_id, outbox_rx, control.clone()));

        let mut first_activity = source_output(&control, b"ok");
        first_activity.activity = true;
        outbox_tx.try_send(first_activity).unwrap();
        assert_eq!(direct.receiver.recv().await.unwrap(), b"ok");

        let mut next_activity = source_output(&control, b"before suppression");
        // Model the next activity interval without sleeping. No terminal
        // content is ever placed in the full server queue.
        next_activity.activity = true;
        outbox_tx.try_send(next_activity).unwrap();
        assert_eq!(direct.receiver.recv().await.unwrap(), b"before suppression");

        control.suppress_activity_at(Instant::now(), Duration::from_secs(60));
        outbox_tx
            .try_send(source_output(&control, b"during suppression"))
            .unwrap();
        assert_eq!(direct.receiver.recv().await.unwrap(), b"during suppression");

        drop(outbox_tx);
        forwarder.await.unwrap();
        let first = sink_rx.recv().await.unwrap();
        assert_eq!(
            first.as_str(),
            format!(r#"{{"type":"agent.activity","agent_id":"{agent_id}"}}"#)
        );
        assert!(sink_rx.try_recv().is_err());
        assert!(control.slot.lock().await.is_none());
    }

    #[tokio::test]
    async fn forwarder_does_not_reclassify_suppressed_output_when_sink_reconnects() {
        let agent_id = Uuid::new_v4();
        let control = ForwarderControl::new();
        let mut direct = control.add_direct_sink("test".into()).await;
        let (outbox_tx, outbox_rx) = mpsc::channel(WORKER_OUTPUT_QUEUE_DEPTH);
        let forwarder = tokio::spawn(run_forwarder(agent_id, outbox_rx, control.clone()));

        // There is intentionally no server sink while both chunks are
        // classified. A later suppression cannot erase the first decision.
        outbox_tx
            .try_send(source_output(&control, b"before suppression"))
            .unwrap();
        assert_eq!(direct.receiver.recv().await.unwrap(), b"before suppression");
        control.suppress_activity_at(Instant::now(), Duration::from_secs(60));
        outbox_tx
            .try_send(source_output(&control, b"during suppression"))
            .unwrap();
        assert_eq!(direct.receiver.recv().await.unwrap(), b"during suppression");
        control.activity.lock().unwrap().suppress_output_until = None;

        let (sink_tx, mut sink_rx) = mpsc::channel(4);
        control.set_sink(sink_tx).await;
        drop(outbox_tx);

        forwarder.await.unwrap();
        // Output observed while the legacy sink was absent is not retained in
        // spawnd. A reconnect uses worker replay instead.
        assert!(sink_rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn direct_sink_anchor_tracks_exact_source_bytes_across_capture_boundary() {
        let agent_id = Uuid::new_v4();
        let control = ForwarderControl::new();
        let (mirror_tx, mut mirror_rx) = mpsc::channel(64);
        control.set_sink(mirror_tx).await;
        tokio::spawn(async move { while mirror_rx.recv().await.is_some() {} });
        let (outbox_tx, outbox_rx) = mpsc::channel(WORKER_OUTPUT_QUEUE_DEPTH);
        let forwarder = tokio::spawn(run_forwarder(agent_id, outbox_rx, control.clone()));

        // Adoption establishes a durable worker coordinate before this viewer
        // exists; those historical bytes must not count in spawn.pty offsets.
        outbox_tx
            .try_send(OutputChunk::source_barrier(10_000))
            .unwrap();
        control.wait_source_offset(10_000).await;
        let mut direct = control.add_direct_sink("viewer".into()).await;

        let before = b"before:\xf0\x9f\x98\x80";
        let during = b"\x1b[31mduring\x1b[0m";
        let boundary = 10_000 + before.len() as u64 + during.len() as u64;
        outbox_tx
            .try_send(OutputChunk::classify_at_source(
                before.to_vec(),
                10_000 + before.len() as u64,
                &control,
            ))
            .unwrap();
        outbox_tx
            .try_send(OutputChunk::classify_at_source(
                during.to_vec(),
                boundary,
                &control,
            ))
            .unwrap();
        outbox_tx
            .try_send(OutputChunk::source_barrier(boundary))
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
            .try_send(OutputChunk::classify_at_source(
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
        let (outbox_tx, outbox_rx) = mpsc::channel(DIRECT_SINK_QUEUE_DEPTH + 1);
        let forwarder = tokio::spawn(run_forwarder(agent_id, outbox_rx, control.clone()));

        for _ in 0..=DIRECT_SINK_QUEUE_DEPTH {
            outbox_tx.send(source_output(&control, b"x")).await.unwrap();
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
    async fn producer_decision_precedes_enqueue_and_later_suppression() {
        let agent_id = Uuid::new_v4();
        let control = ForwarderControl::new();
        let (outbox_tx, outbox_rx) = mpsc::channel(WORKER_OUTPUT_QUEUE_DEPTH);

        // The producer classifies and enqueues before the forwarder exists.
        // A later control event cannot mutate the queued decision.
        let chunk = source_output(&control, b"queued before suppression");
        assert!(chunk.activity);
        outbox_tx.try_send(chunk).unwrap();
        control.suppress_activity_at(Instant::now(), Duration::from_secs(60));

        let (sink_tx, mut sink_rx) = mpsc::channel(2);
        control.set_sink(sink_tx).await;
        let forwarder = tokio::spawn(run_forwarder(agent_id, outbox_rx, control));
        drop(outbox_tx);

        assert_eq!(
            sink_rx.recv().await.unwrap().as_str(),
            format!(r#"{{"type":"agent.activity","agent_id":"{agent_id}"}}"#)
        );
        assert!(sink_rx.try_recv().is_err());
        forwarder.await.unwrap();
    }

    #[tokio::test]
    async fn suppression_preceding_producer_decision_stays_with_queued_output() {
        let agent_id = Uuid::new_v4();
        let control = ForwarderControl::new();
        let (outbox_tx, outbox_rx) = mpsc::channel(WORKER_OUTPUT_QUEUE_DEPTH);

        control.suppress_activity_at(Instant::now(), Duration::from_secs(60));
        let chunk = source_output(&control, b"queued during suppression");
        assert!(!chunk.activity);
        outbox_tx.try_send(chunk).unwrap();
        // Expiry/reconnect before forwarding must not cause reclassification.
        control.activity.lock().unwrap().suppress_output_until = None;

        let (sink_tx, mut sink_rx) = mpsc::channel(2);
        control.set_sink(sink_tx).await;
        let forwarder = tokio::spawn(run_forwarder(agent_id, outbox_rx, control));
        drop(outbox_tx);

        forwarder.await.unwrap();
        assert!(sink_rx.try_recv().is_err());
    }
}
