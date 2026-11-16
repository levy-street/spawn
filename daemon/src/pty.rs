//! Per-session terminal routing shared by `spawnd` and the mandatory session
//! worker backend.
//!
//! A `spawn-worker` owns each session's PTY. Its output enters a bounded
//! per-session outbox and a long-lived forwarder routes it to the current
//! server connection plus bounded direct DataChannel sinks. Workers and their
//! PTYs survive `spawnd` reconnects/restarts; `spawnd` never owns a second
//! terminal emulator or shells out to a multiplexer.

use std::collections::{BTreeMap, HashMap};
use std::future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use spawnd::sessiond::wire;
#[cfg(unix)]
use tokio::net::UnixDatagram;
use tokio::sync::{mpsc, oneshot, watch, Mutex as AsyncMutex, Notify};
use uuid::Uuid;
use zeroize::Zeroize;

use crate::activity;
use crate::proto::Outbound;

#[derive(Clone, Debug)]
enum WsOutboundKind {
    Text(String),
    Ping,
    Close,
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient, PipeMode};
    use windows_sys::Win32::Foundation::ERROR_PIPE_BUSY;

    async fn open_silent_client(name: &std::ffi::OsStr) -> NamedPipeClient {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            match ClientOptions::new().pipe_mode(PipeMode::Message).open(name) {
                Ok(client) => return client,
                Err(error)
                    if (error.kind() == std::io::ErrorKind::NotFound
                        || error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32))
                        && tokio::time::Instant::now() < deadline =>
                {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Err(error) => panic!("opening silent lifecycle client failed: {error}"),
            }
        }
    }

    #[tokio::test]
    async fn lifecycle_shutdown_survives_all_silent_handler_slots() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("workers");
        spawnd::sessiond::endpoint::ensure_private_dir(&dir).unwrap();
        let endpoint = spawnd::sessiond::endpoint::endpoint_for(&dir, "", Uuid::new_v4()).unwrap();
        let reservation = match spawnd::sessiond::endpoint::try_reserve(&endpoint).unwrap() {
            spawnd::sessiond::endpoint::LockAttempt::Acquired(reservation) => reservation,
            spawnd::sessiond::endpoint::LockAttempt::Busy => {
                panic!("new lifecycle reservation was busy")
            }
        };
        let spawnd::sessiond::endpoint::BoundWorkerEndpoints {
            main: _main,
            mut lifecycle,
            identity: _identity,
        } = spawnd::sessiond::endpoint::bind_worker(&endpoint, &reservation, Uuid::new_v4())
            .unwrap();
        let mut silent = Vec::new();
        for _ in 0..7 {
            silent.push(open_silent_client(endpoint.lifecycle_arg()).await);
            tokio::task::yield_now().await;
        }

        let instance = Uuid::new_v4();
        let responder = tokio::spawn(async move {
            let exchange = spawnd::sessiond::endpoint::receive_lifecycle(&mut lifecycle)
                .await
                .unwrap();
            let (request, len) = exchange.request();
            assert_eq!(len, spawnd::sessiond::wire::LIFECYCLE_REQUEST_LEN);
            let request: &[u8; spawnd::sessiond::wire::LIFECYCLE_REQUEST_LEN] =
                request.try_into().unwrap();
            let (received_instance, signal) =
                spawnd::sessiond::wire::decode_lifecycle_request(request).unwrap();
            assert_eq!(received_instance, instance);
            assert_eq!(signal, spawnd::sessiond::wire::LifecycleSignal::Term);
            spawnd::sessiond::endpoint::acknowledge_lifecycle(
                &mut lifecycle,
                exchange,
                spawnd::sessiond::wire::LIFECYCLE_ACK_DELIVERED,
            )
            .await
            .unwrap();
        });
        let started = tokio::time::Instant::now();
        SessionLifecycle::new(endpoint, instance)
            .shutdown(spawnd::sessiond::wire::LifecycleSignal::Term)
            .await
            .unwrap();
        assert!(started.elapsed() <= LIFECYCLE_DELIVERY_TIMEOUT + Duration::from_millis(500));
        responder.await.unwrap();
        drop(silent);
    }
}

#[derive(Clone, Debug)]
pub struct WsOutbound {
    kind: WsOutboundKind,
    flushed: Option<Arc<Notify>>,
}

impl WsOutbound {
    pub(crate) fn json(text: String) -> Self {
        Self {
            kind: WsOutboundKind::Text(text),
            flushed: None,
        }
    }

    pub(crate) fn tracked_json(text: String) -> (Self, Arc<Notify>) {
        let flushed = Arc::new(Notify::new());
        (
            Self {
                kind: WsOutboundKind::Text(text),
                flushed: Some(Arc::clone(&flushed)),
            },
            flushed,
        )
    }

    pub(crate) fn tracked_close() -> (Self, Arc<Notify>) {
        let flushed = Arc::new(Notify::new());
        (
            Self {
                kind: WsOutboundKind::Close,
                flushed: Some(Arc::clone(&flushed)),
            },
            flushed,
        )
    }

    pub(crate) fn ping() -> Self {
        Self {
            kind: WsOutboundKind::Ping,
            flushed: None,
        }
    }

    pub(crate) fn into_parts(mut self) -> (Option<String>, bool, bool, Option<Arc<Notify>>) {
        let kind = std::mem::replace(&mut self.kind, WsOutboundKind::Close);
        let flushed = self.flushed.take();
        match kind {
            WsOutboundKind::Text(text) => (Some(text), false, false, flushed),
            WsOutboundKind::Ping => (None, true, false, flushed),
            WsOutboundKind::Close => (None, false, true, flushed),
        }
    }

    #[cfg(test)]
    pub(crate) fn as_str(&self) -> &str {
        match &self.kind {
            WsOutboundKind::Text(text) => text,
            WsOutboundKind::Ping => "",
            WsOutboundKind::Close => "",
        }
    }

    pub(crate) fn wipe(&mut self) {
        if let WsOutboundKind::Text(text) = &mut self.kind {
            text.zeroize();
        }
    }
}

impl Drop for WsOutbound {
    fn drop(&mut self) {
        self.wipe();
    }
}

/// The thing the WS connection hands to a per-session forwarder so that bytes
/// route to the current connection.
pub type SessionSink = mpsc::Sender<WsOutbound>;

#[cfg(all(test, unix))]
type DirectWipeProbe = Arc<dyn Fn(&[u8]) + Send + Sync>;

/// Plaintext owned by a bounded direct-viewer queue. It wipes itself whether
/// consumed normally, rejected by a full queue, or drained during teardown.
pub struct DirectPayload {
    bytes: Vec<u8>,
    #[cfg(all(test, unix))]
    wipe_probe: Option<DirectWipeProbe>,
}

impl DirectPayload {
    pub(crate) fn new(bytes: Vec<u8>) -> Self {
        Self {
            bytes,
            #[cfg(all(test, unix))]
            wipe_probe: None,
        }
    }

    #[cfg(all(test, unix))]
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
        #[cfg(all(test, unix))]
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
    pub gap_offset: Arc<AtomicU64>,
    pub source_origin: u64,
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
/// `session.foreground` emits at most this often per session, however fast
/// worker reports arrive (reconnect re-sends can beat the worker's 1 s poll).
pub(crate) const FOREGROUND_MIN_INTERVAL: Duration = Duration::from_secs(1);
/// Server-visible foreground command bound: a bare basename, nothing longer.
pub(crate) const MAX_FOREGROUND_COMMAND_CHARS: usize = 64;

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
fn activity_message(session_id: Uuid, kind: ActivityKind) -> Option<WsOutbound> {
    let event = match kind {
        ActivityKind::Output => Outbound::SessionActivity { session_id },
        ActivityKind::Input => Outbound::SessionInputActivity { session_id },
    };
    serde_json::to_string(&event).ok().map(WsOutbound::json)
}

/// Best-effort emission used by the WebRTC input callback. The sink accepts
/// serialized control-plane JSON only; it has no terminal-byte variant.
pub(crate) fn try_emit_activity(
    out_tx: &SessionSink,
    session_id: Uuid,
    kind: ActivityKind,
) -> bool {
    let Some(message) = activity_message(session_id, kind) else {
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
    gap_offset: Arc<AtomicU64>,
}

/// Shared between a session's forwarder task and the WS connection lifecycle.
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
    /// How many times the worker has reported wiping its history
    /// (`T_HISTORY_WIPE`). A replay budget learned before a wipe is void.
    history_wipes: Arc<AtomicU64>,
    /// Monotonic activity state. Input/output pings have independent throttle
    /// clocks; injected input/resize/redraw extend the output suppression
    /// deadline so their echoes and repaints do not count as session work.
    activity: Arc<Mutex<ActivityState>>,
    /// Foreground-report state: the latest worker-observed basename and the
    /// change-only, rate-limited emission bookkeeping behind
    /// `session.foreground`.
    foreground: Arc<Mutex<ForegroundState>>,
}

#[derive(Debug, Default)]
struct ForegroundState {
    /// Latest basename observed by the worker (already re-sent by the worker
    /// on reconnection, so this survives supervisor restarts).
    observed: Option<String>,
    /// Latest basename actually emitted to the server.
    emitted: Option<String>,
    last_emit_at: Option<Instant>,
    /// A delayed emit task is already scheduled; it reads `observed` when the
    /// rate-limit window closes, so later observations need no new task.
    delayed: bool,
}

#[derive(Debug, Default)]
struct ActivityState {
    last_output_at: Option<Instant>,
    last_input_at: Option<Instant>,
    suppress_output_until: Option<Instant>,
    output_classifier: activity::OutputClassifier,
    input_classifier: activity::InputClassifier,
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
            history_wipes: Arc::new(AtomicU64::new(0)),
            activity: Arc::new(Mutex::new(ActivityState::default())),
            foreground: Arc::new(Mutex::new(ForegroundState::default())),
        }
    }

    /// The basename the worker last reported in the foreground, if any.
    pub(crate) fn foreground(&self) -> Option<String> {
        self.foreground.lock().ok()?.observed.clone()
    }

    /// Record a worker foreground report and relay it to the server as
    /// `session.foreground`: emitted only when the basename changes, at most
    /// once per `FOREGROUND_MIN_INTERVAL` per session. A change that lands
    /// inside the window is deferred, never dropped, so the server always
    /// converges on the latest value.
    pub(crate) async fn note_foreground(&self, session_id: Uuid, command: &str) {
        let command: String = command.chars().take(MAX_FOREGROUND_COMMAND_CHARS).collect();
        let emit_now = {
            let Ok(mut state) = self.foreground.lock() else {
                return;
            };
            if state.observed.as_deref() == Some(command.as_str()) {
                return;
            }
            state.observed = Some(command.clone());
            if state.delayed {
                return;
            }
            let now = Instant::now();
            let wait = state
                .last_emit_at
                .map(|last| {
                    FOREGROUND_MIN_INTERVAL.saturating_sub(now.saturating_duration_since(last))
                })
                .unwrap_or(Duration::ZERO);
            if wait.is_zero() {
                if state.emitted.as_deref() == Some(command.as_str()) {
                    return;
                }
                state.emitted = Some(command.clone());
                state.last_emit_at = Some(now);
                true
            } else {
                state.delayed = true;
                let control = self.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(wait).await;
                    control.flush_delayed_foreground(session_id).await;
                });
                false
            }
        };
        if emit_now {
            emit_foreground(self, session_id, command).await;
        }
    }

    async fn flush_delayed_foreground(&self, session_id: Uuid) {
        let pending = {
            let Ok(mut state) = self.foreground.lock() else {
                return;
            };
            state.delayed = false;
            if state.observed == state.emitted {
                None
            } else {
                let command = state.observed.clone();
                state.emitted = command.clone();
                state.last_emit_at = Some(Instant::now());
                command
            }
        };
        if let Some(command) = pending {
            emit_foreground(self, session_id, command).await;
        }
    }

    /// Re-announce the current foreground command through a freshly installed
    /// server sink. Frames emitted while no WS connection existed were
    /// dropped; this heals the server's copy without waiting for a change,
    /// under the same per-session rate limit as ordinary reports.
    pub(crate) async fn resend_foreground(&self, session_id: Uuid) {
        let command = {
            let Ok(mut state) = self.foreground.lock() else {
                return;
            };
            state.emitted = None;
            if state.delayed || state.observed.is_none() {
                None
            } else {
                let now = Instant::now();
                let wait = state
                    .last_emit_at
                    .map(|last| {
                        FOREGROUND_MIN_INTERVAL.saturating_sub(now.saturating_duration_since(last))
                    })
                    .unwrap_or(Duration::ZERO);
                if wait.is_zero() {
                    let command = state.observed.clone();
                    state.emitted = command.clone();
                    state.last_emit_at = Some(now);
                    command
                } else {
                    state.delayed = true;
                    let control = self.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(wait).await;
                        control.flush_delayed_foreground(session_id).await;
                    });
                    None
                }
            }
        };
        if let Some(command) = command {
            emit_foreground(self, session_id, command).await;
        }
    }

    /// Suppress output-activity classification for `window` — an injected
    /// resize/redraw or local input echo must not register as session work.
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

    /// Decide whether this output chunk should emit a `session.activity` ping:
    /// outside the throttle window, not suppressed, and carrying meaningful
    /// content. Records the emit time on success. Mirrors the former
    /// server-side classifier, now content-free on the wire.
    #[cfg(all(test, unix))]
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
    /// caller emits `session.input_activity` only when this returns true.
    ///
    /// `bytes` is inspected but never retained or forwarded: the classifier
    /// answers one question — was a person responsible for this — and the
    /// answer is a bool. The bytes still reach the session either way; only the
    /// activity ping is withheld, because a terminal answering a question the
    /// application asked it is not the user doing anything.
    pub fn note_input(&self, bytes: &[u8]) -> bool {
        self.note_input_at(Instant::now(), bytes)
    }

    fn note_input_at(&self, now: Instant, bytes: &[u8]) -> bool {
        let Ok(mut state) = self.activity.lock() else {
            return false;
        };
        // Observe before the throttle check: the parser must see every byte in
        // order, or a sequence split across a throttled boundary leaves it
        // misaligned and the next reply reads as typing.
        let user_input = state.input_classifier.observe(bytes);
        if !user_input {
            return false;
        }
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
        let source_origin = self.source_offset.load(Ordering::Acquire);
        self.add_direct_sink_from(id, source_origin).await
    }

    pub async fn add_direct_sink_from(&self, id: String, source_origin: u64) -> DirectSinkReceiver {
        let (sink, receiver) = mpsc::channel(DIRECT_SINK_QUEUE_DEPTH);
        let (disconnected, disconnected_rx) = watch::channel(false);
        let gap_offset = Arc::new(AtomicU64::new(0));
        let mut sinks = self.direct_sinks.lock().await;
        let previous = sinks.insert(
            id,
            DirectSinkEntry {
                sink,
                disconnected,
                source_origin,
                bytes_sent: Arc::new(AtomicU64::new(0)),
                gap_offset: Arc::clone(&gap_offset),
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
            gap_offset,
            source_origin,
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
        if offset.is_none() {
            self.history_wipes.fetch_add(1, Ordering::AcqRel);
        }
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

    /// History wipes the worker has reported on this connection.
    pub(crate) fn history_wipes(&self) -> u64 {
        self.history_wipes.load(Ordering::Acquire)
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
                entry.gap_offset.store(
                    source_end.saturating_sub(entry.source_origin),
                    Ordering::Release,
                );
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
                    entry.gap_offset.store(
                        source_end.saturating_sub(entry.source_origin),
                        Ordering::Release,
                    );
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

#[cfg(all(test, unix))]
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
    /// False for a replay spawnd made itself because the worker could read no
    /// history: it carries no screen either, so the viewer starts blank.
    screen: bool,
    #[cfg(all(test, unix))]
    wipe_probe: Option<ReplayWipeProbe>,
}

impl WorkerReplay {
    pub(crate) fn new(watermark: u64, bytes: Vec<u8>) -> Self {
        Self {
            watermark,
            bytes,
            history_anchor: None,
            screen: true,
            #[cfg(all(test, unix))]
            wipe_probe: None,
        }
    }

    /// An empty replay at the live stream's `watermark`: no history and no
    /// screen, only the promise that what follows is live.
    pub(crate) fn live_only(watermark: u64) -> Self {
        Self {
            watermark,
            bytes: Vec::new(),
            history_anchor: None,
            screen: false,
            #[cfg(all(test, unix))]
            wipe_probe: None,
        }
    }

    /// Whether the replay carries the live screen. Every replay a worker
    /// makes does; one spawnd made in its place does not.
    pub fn has_screen(&self) -> bool {
        self.screen
    }

    pub(crate) fn new_with_history(watermark: u64, bytes: Vec<u8>, anchor: (u64, u64)) -> Self {
        Self {
            watermark,
            bytes,
            history_anchor: Some(anchor),
            screen: true,
            #[cfg(all(test, unix))]
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

    #[cfg(all(test, unix))]
    pub(crate) fn with_wipe_probe(
        watermark: u64,
        bytes: Vec<u8>,
        wipe_probe: ReplayWipeProbe,
    ) -> Self {
        Self {
            watermark,
            bytes,
            history_anchor: None,
            screen: true,
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
        #[cfg(all(test, unix))]
        if let Some(probe) = self.wipe_probe.as_ref() {
            probe(&self.bytes);
        }
    }
}

/// Commands routed from spawnd to a session worker's socket writer.
pub type WorkerReplayResult = Result<WorkerReplay>;
pub type WorkerReplayReceiver = oneshot::Receiver<WorkerReplayResult>;

/// A replay the worker refused (`T_ERROR`), in the worker's own words, so a
/// viewer replay can tell history the worker can no longer read from a
/// failure that must stay a failure.
#[derive(Debug)]
pub struct WorkerReplayRefused {
    message: String,
}

impl WorkerReplayRefused {
    pub(crate) fn new(message: String) -> Self {
        Self { message }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl std::fmt::Display for WorkerReplayRefused {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "worker replay failed: {}", self.message)
    }
}

impl std::error::Error for WorkerReplayRefused {}

/// Why a worker could not replay history that was not tampered with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UnreadableHistory {
    /// A segment file is gone from disk (the OS temp cleaner deletes one
    /// nothing has touched for days). Replay walks segments newest-first and
    /// stops once the budget is full, so a smaller budget can stop before it.
    MissingSegment,
    /// The worker has disabled its log (an append found its newest segment
    /// gone, say). A worker never re-enables it, so nothing will replay again.
    LogDisabled,
}

/// The start of a worker's refusal once its log is disabled. Workers say
/// [`spawnd::sessiond::worker::REPLAY_UNAVAILABLE`] ("… for this session");
/// those started from 2026-07-16 to 2026-08-19 run the same protocol and say
/// "… for this agent".
const REPLAY_UNAVAILABLE_PREFIX: &str = "worker replay is unavailable for this ";

/// The end of a failed read's message when the file does not exist: the
/// standard library's text for ENOENT (`ERROR_FILE_NOT_FOUND` on Windows).
const NOT_FOUND_SUFFIX: &str = "(os error 2)";

/// Classify a worker's refusal by the words deployed `spawn-worker`s use
/// (`sessiond::scrollback` reading a segment by path, and `sessiond::worker`
/// without a log). Running workers keep the binary they started with, so
/// their words are the contract. Anything else — failed authentication, a
/// sequence gap or overlap, a malformed record, any other read error — is
/// `None`, and the replay fails closed as it always has.
pub(crate) fn unreadable_history(message: &str) -> Option<UnreadableHistory> {
    use spawnd::sessiond::scrollback::{SEGMENT_PREFIX, SEGMENT_READ_CONTEXT, SEGMENT_SUFFIX};

    if message.starts_with(REPLAY_UNAVAILABLE_PREFIX) {
        return Some(UnreadableHistory::LogDisabled);
    }
    let missing_segment = message
        .strip_prefix(SEGMENT_READ_CONTEXT)
        .and_then(|rest| rest.strip_suffix(NOT_FOUND_SUFFIX))
        .and_then(|rest| rest.split_once(&format!("{SEGMENT_SUFFIX}: ")))
        .is_some_and(|(path, _)| {
            path.rsplit(['/', '\\'])
                .next()
                .is_some_and(|leaf| leaf.starts_with(SEGMENT_PREFIX))
        });
    missing_segment.then_some(UnreadableHistory::MissingSegment)
}

/// A viewer replay that is still resolving; `None` when the worker
/// connection went away before it answered.
pub type ViewerReplay =
    Pin<Box<dyn future::Future<Output = Option<WorkerReplayResult>> + Send + 'static>>;

/// How long a budget learned by shrinking past a missing segment is reused.
/// One attach asks for a replay two or three times within seconds (the
/// barrier, the first history request, a snapshot), and a second device or a
/// reconnect follows within a minute or two: five minutes spares those the
/// old worker's refusals. After it, a request asks for its full budget again,
/// so a session whose readable history has grown, or whose gap the worker
/// has since evicted, is never held at the old figure for longer.
pub(crate) const REPLAY_HINT_TTL: Duration = Duration::from_secs(5 * 60);

/// A budget that replayed after a larger one in the same request reached a
/// missing segment, and when that was learned.
#[derive(Clone, Copy)]
struct ReplayHint {
    budget: u32,
    learned: tokio::time::Instant,
    /// The connection's history-wipe count when the request began: a wipe
    /// unlinks every segment, the gap with them, so the hint no longer applies.
    wipes: u64,
}

/// What one worker connection's viewer replays have learned about its log.
#[derive(Default)]
struct ViewerHistory {
    hint: Mutex<Option<ReplayHint>>,
    /// The worker said its log is disabled. Nothing will replay again, so
    /// viewers get the live stream without the worker being asked.
    disabled: AtomicBool,
    warned_truncated: AtomicBool,
    warned_unreadable: AtomicBool,
}

impl ViewerHistory {
    /// The budget to ask the worker for first: the request's own, unless a
    /// fresh hint from this connection says less is what can be read.
    fn first_budget(&self, max_bytes: u32, wipes: u64) -> u32 {
        let Ok(mut hint) = self.hint.lock() else {
            return max_bytes;
        };
        match *hint {
            Some(known) if known.wipes == wipes && known.learned.elapsed() < REPLAY_HINT_TTL => {
                max_bytes.min(known.budget)
            }
            Some(_) => {
                *hint = None;
                max_bytes
            }
            None => max_bytes,
        }
    }

    /// Remember a budget only once it has replayed. Its age runs from now
    /// and is not renewed by use.
    fn learn(&self, budget: u32, wipes: u64) {
        if let Ok(mut hint) = self.hint.lock() {
            *hint = Some(ReplayHint {
                budget,
                learned: tokio::time::Instant::now(),
                wipes,
            });
        }
    }

    fn forget(&self) {
        if let Ok(mut hint) = self.hint.lock() {
            *hint = None;
        }
    }

    /// Say once per worker connection that its history is truncated, and once
    /// that none of it could be read; later viewers say it at debug.
    fn report(&self, session_id: Uuid, truncated: bool, error: &anyhow::Error) {
        let flag = if truncated {
            &self.warned_truncated
        } else {
            &self.warned_unreadable
        };
        match (!flag.swap(true, Ordering::AcqRel), truncated) {
            (true, true) => tracing::warn!(
                %session_id,
                reason = %error,
                "session history truncated: older scrollback is gone from disk; viewers get the newest history still readable"
            ),
            (true, false) => tracing::warn!(
                %session_id,
                reason = %error,
                "session history unreadable: viewers open on the live terminal with no history"
            ),
            (false, _) => {
                tracing::debug!(%session_id, reason = %error, truncated, "session history still degraded")
            }
        }
    }
}

/// The next, smaller budget after one that reached a missing segment.
fn smaller_replay_budget(budget: u32) -> u32 {
    (budget / 4).max(1)
}

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
pub struct SessionLifecycle {
    target: SessionLifecycleTarget,
    instance_id: Uuid,
}

#[derive(Clone)]
pub(crate) enum SessionLifecycleTarget {
    Endpoint(spawnd::sessiond::endpoint::Endpoint),
    // Compatibility for test fixtures outside the endpoint module. Production
    // connections always carry the complete deterministic Endpoint.
    LegacyPath(PathBuf),
}

impl From<spawnd::sessiond::endpoint::Endpoint> for SessionLifecycleTarget {
    fn from(endpoint: spawnd::sessiond::endpoint::Endpoint) -> Self {
        Self::Endpoint(endpoint)
    }
}

impl From<PathBuf> for SessionLifecycleTarget {
    fn from(path: PathBuf) -> Self {
        Self::LegacyPath(path)
    }
}

impl SessionLifecycle {
    pub(crate) fn new(target: impl Into<SessionLifecycleTarget>, instance_id: Uuid) -> Self {
        Self {
            target: target.into(),
            instance_id,
        }
    }

    pub async fn shutdown(&self, signal: wire::LifecycleSignal) -> Result<()> {
        let deadline = tokio::time::Instant::now() + LIFECYCLE_DELIVERY_TIMEOUT;
        let request = wire::encode_lifecycle_request(self.instance_id, signal);
        let ack = match &self.target {
            SessionLifecycleTarget::Endpoint(endpoint) => {
                spawnd::sessiond::endpoint::send_lifecycle(endpoint, &request, deadline).await?
            }
            SessionLifecycleTarget::LegacyPath(socket) => {
                send_lifecycle_legacy(socket, &request, deadline).await?
            }
        };
        match ack {
            wire::LIFECYCLE_ACK_DELIVERED => Ok(()),
            wire::LIFECYCLE_ACK_GONE => anyhow::bail!("session process already exited"),
            wire::LIFECYCLE_ACK_WRONG_INSTANCE => {
                anyhow::bail!("worker lifecycle instance changed")
            }
            _ => anyhow::bail!("worker lifecycle delivery failed"),
        }
    }
}

#[cfg(unix)]
async fn send_lifecycle_legacy(
    socket_path: &std::path::Path,
    request: &[u8; wire::LIFECYCLE_REQUEST_LEN],
    deadline: tokio::time::Instant,
) -> Result<u8> {
    loop {
        if tokio::time::Instant::now() >= deadline {
            anyhow::bail!("worker lifecycle delivery deadline exceeded");
        }
        if spawnd::sessiond::endpoint::validate_private_socket(socket_path).is_err() {
            anyhow::bail!("worker lifecycle endpoint validation failed");
        }
        let parent = socket_path
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
        if socket.connect(socket_path).is_err() {
            tokio::time::sleep_until(std::cmp::min(
                deadline,
                tokio::time::Instant::now() + Duration::from_millis(10),
            ))
            .await;
            continue;
        }
        match tokio::time::timeout_at(deadline, socket.send(request)).await {
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
        return Ok(ack[0]);
    }
}

#[cfg(windows)]
async fn send_lifecycle_legacy(
    _socket_path: &std::path::Path,
    _request: &[u8; wire::LIFECYCLE_REQUEST_LEN],
    _deadline: tokio::time::Instant,
) -> Result<u8> {
    anyhow::bail!("legacy lifecycle paths are unavailable on Windows")
}

/// The PTY size the worker was last told, through this handle.
#[derive(Clone, Copy, Debug)]
struct PtySize {
    cols: u16,
    rows: u16,
    /// The repaint nudge that set this size and will put the size it
    /// replaced back, if one did. A viewer's resize clears it.
    nudge: Option<u64>,
    /// Widths viewers have applied on this connection. Only a width change
    /// makes every program repaint: an inline renderer lays out against the
    /// width and may draw nothing when only the height changes.
    width_changes: u64,
}

/// One worker connection's repaint nudges, and the budget that bounds them.
#[derive(Default)]
struct RepaintSchedule {
    /// A nudge is waiting to start; empty replays handed out meanwhile join it.
    scheduled: bool,
    /// When the last nudge narrowed the PTY.
    last_started: Option<tokio::time::Instant>,
    /// Nudges counted against [`REPAINT_BUDGET`], at most one beyond it; one
    /// is given back every [`REPAINT_REFILL`] after `refilled_at`.
    spent: u32,
    refilled_at: Option<tokio::time::Instant>,
    /// `PtySize::width_changes` when the latest empty replay that joined was
    /// handed out. A viewer's width change after it makes the program
    /// repaint anyway.
    width_changes_at_request: u64,
}

impl RepaintSchedule {
    /// Give back what [`REPAINT_REFILL`] has earned since `refilled_at`.
    fn refill(&mut self, now: tokio::time::Instant) {
        let Some(since) = self.refilled_at else {
            return;
        };
        let earned = now.duration_since(since).as_millis() / REPAINT_REFILL.as_millis();
        let back = u32::try_from(earned).unwrap_or(u32::MAX).min(self.spent);
        if back == 0 {
            return;
        }
        self.spent -= back;
        self.refilled_at = (self.spent > 0).then(|| since + REPAINT_REFILL * back);
    }

    /// The earliest a nudge may start, as of `now`.
    fn earliest(&mut self, now: tokio::time::Instant) -> tokio::time::Instant {
        self.refill(now);
        let Some(last) = self.last_started else {
            return now;
        };
        let interval = if self.spent < REPAINT_BUDGET {
            REPAINT_MIN_INTERVAL
        } else {
            REPAINT_MAX_INTERVAL
        };
        (last + interval).max(now)
    }

    /// Count a nudge that narrowed the PTY at `now`. Once the budget is
    /// spent, each nudge still counts one beyond it, so a viewer that keeps
    /// reattaching stays at the slower pace until it stops for a while.
    fn started(&mut self, now: tokio::time::Instant) {
        self.refill(now);
        if self.spent == 0 {
            self.refilled_at = Some(now);
        }
        self.spent = (self.spent + 1).min(REPAINT_BUDGET + 1);
        self.last_started = Some(now);
    }
}

/// How long a nudge waits after the empty replay that asked for it: the
/// viewer's own size message (`take_control`, `resize`) follows its seed
/// within this, and a width that changes after the seed repaints by itself.
pub(crate) const REPAINT_SETTLE: Duration = Duration::from_millis(150);
/// A session's nudges come at least [`REPAINT_MIN_INTERVAL`] apart while its
/// budget lasts: [`REPAINT_BUDGET`] nudges, one given back every
/// [`REPAINT_REFILL`] (four per five minutes). Once it is spent they come at
/// least [`REPAINT_MAX_INTERVAL`] apart, so a viewer that reattaches in a
/// loop costs every viewer two repaints, and activity detection the
/// suppression around them, about once a minute, while people opening a
/// session at a human pace are never kept waiting.
pub(crate) const REPAINT_MIN_INTERVAL: Duration = Duration::from_secs(2);
pub(crate) const REPAINT_MAX_INTERVAL: Duration = Duration::from_secs(60);
pub(crate) const REPAINT_BUDGET: u32 = 4;
pub(crate) const REPAINT_REFILL: Duration = Duration::from_secs(75);
/// How long the narrower size stands: until the program's first output after
/// it (its repaint beginning, at best), but no less than the first figure, so
/// the program has read the new size, and no more than the second, for a
/// program that does not repaint (a shell at its prompt).
pub(crate) const REPAINT_HOLD_MIN: Duration = Duration::from_millis(50);
pub(crate) const REPAINT_HOLD_MAX: Duration = Duration::from_millis(300);
/// A restore the worker's full command queue refused is retried after the
/// first figure, doubling up to the second.
pub(crate) const REPAINT_RESTORE_RETRY_MIN: Duration = Duration::from_millis(10);
pub(crate) const REPAINT_RESTORE_RETRY_MAX: Duration = Duration::from_secs(1);

static NEXT_REPAINT_NUDGE: AtomicU64 = AtomicU64::new(1);

/// One scheduled repaint nudge (`SessionHandle::repaint_after_empty_replay`).
struct RepaintNudge {
    session_id: Uuid,
    /// Weak, upgraded only for each send, so a nudge never keeps a worker
    /// connection open that its handle has let go of.
    cmd_tx: mpsc::WeakSender<WorkerCmd>,
    size: Arc<Mutex<PtySize>>,
    schedule: Arc<Mutex<RepaintSchedule>>,
    alive: Arc<AtomicBool>,
    control: ForwarderControl,
    /// [`REPAINT_HOLD_MAX`], unless a test waits for the program instead.
    hold_max: Duration,
}

impl RepaintNudge {
    /// Wait until `due`; then, unless a viewer changed the width after the
    /// last empty replay (a repaint is coming anyway) or the session has
    /// gone, set the PTY one column narrower, hold it while the program reads
    /// it, and put the size back. The restore is retried, backing off, for as
    /// long as the worker connection lives, and is skipped only when a
    /// viewer's resize has replaced the narrower size meanwhile: that size
    /// stands.
    async fn run(self, mut due: tokio::time::Instant) {
        // Checked again on waking: a nudge that started after this one was
        // scheduled moves the earliest start on.
        let width_changes_at_request = loop {
            tokio::time::sleep_until(due).await;
            let now = tokio::time::Instant::now();
            let Ok(mut schedule) = self.schedule.lock() else {
                return;
            };
            let earliest = schedule.earliest(now);
            if earliest <= now {
                schedule.scheduled = false;
                break schedule.width_changes_at_request;
            }
            due = earliest;
        };
        let Ok(width_changes) = self.size.lock().map(|size| size.width_changes) else {
            return;
        };
        let resized_since = width_changes != width_changes_at_request;
        let session_id = self.session_id;
        if resized_since || !self.alive.load(Ordering::Acquire) {
            tracing::debug!(%session_id, resized_since, "repaint nudge not needed");
            return;
        }
        let Some(cmd_tx) = self.cmd_tx.upgrade() else {
            return;
        };
        let nudge = NEXT_REPAINT_NUDGE.fetch_add(1, Ordering::Relaxed);
        // Taken before the narrower size is sent, so the program's answer to
        // it can never be counted as earlier output.
        let output = self.control.source_offset();
        let original = {
            let Ok(mut size) = self.size.lock() else {
                return;
            };
            if size.nudge.is_some() {
                return;
            }
            let original = (size.cols, size.rows);
            let cols = if original.0 > 1 {
                original.0 - 1
            } else {
                original.0 + 1
            };
            if cmd_tx
                .try_send(WorkerCmd::Resize {
                    cols,
                    rows: original.1,
                })
                .is_err()
            {
                tracing::debug!(%session_id, "repaint nudge: worker command queue full");
                return;
            }
            size.cols = cols;
            size.nudge = Some(nudge);
            original
        };
        drop(cmd_tx);
        let held = tokio::time::Instant::now();
        // Only a nudge that narrowed the PTY counts, so one that was skipped
        // never delays the next viewer's.
        if let Ok(mut schedule) = self.schedule.lock() {
            schedule.started(held);
        }
        self.control
            .suppress_activity(activity::REDRAW_SUPPRESS_WINDOW);
        tracing::debug!(%session_id, cols = original.0, rows = original.1, "repaint nudge: one column narrower");

        let _ = tokio::time::timeout(
            self.hold_max,
            self.control.wait_source_offset(output.saturating_add(1)),
        )
        .await;
        tokio::time::sleep_until(held + REPAINT_HOLD_MIN).await;

        let mut retry = REPAINT_RESTORE_RETRY_MIN;
        loop {
            {
                let Ok(mut size) = self.size.lock() else {
                    return;
                };
                if size.nudge != Some(nudge) {
                    tracing::debug!(%session_id, "repaint nudge: a viewer's size replaced it");
                    return;
                }
                // The handle gone means its connection is closing; a daemon
                // that adopts the worker again reads the PTY's real size from
                // its hello, so the next viewer's size message puts it right.
                let Some(cmd_tx) = self.cmd_tx.upgrade() else {
                    return;
                };
                match cmd_tx.try_send(WorkerCmd::Resize {
                    cols: original.0,
                    rows: original.1,
                }) {
                    Ok(()) => {
                        (size.cols, size.rows) = original;
                        size.nudge = None;
                        self.control
                            .suppress_activity(activity::REDRAW_SUPPRESS_WINDOW);
                        return;
                    }
                    Err(mpsc::error::TrySendError::Closed(_)) => return,
                    Err(mpsc::error::TrySendError::Full(_)) => {}
                }
            }
            if !self.alive.load(Ordering::Acquire) {
                return;
            }
            tokio::time::sleep(retry).await;
            retry = (retry * 2).min(REPAINT_RESTORE_RETRY_MAX);
        }
    }
}

/// Per-session runtime handle.
pub struct SessionHandle {
    pub session_id: Uuid,
    /// Canonical cwd capability root reported by the worker that owns this
    /// exact backend generation.
    pub cwd: Arc<str>,
    /// The session's shell, as its worker reported it; 0 when the worker did
    /// not say. Read only to find the window's own processes (`host_conv`).
    shell_pid: u32,
    /// Last size applied through this handle, and any repaint nudge holding it.
    size: Arc<Mutex<PtySize>>,
    repaint: Arc<Mutex<RepaintSchedule>>,
    /// How long a repaint nudge holds the narrower size at most.
    repaint_hold_max: Duration,
    /// Held alive while the session is alive; when dropped, the per-session
    /// forwarder task exits after the worker connection closes.
    #[allow(dead_code)]
    outbox_tx: mpsc::Sender<OutputChunk>,
    /// Lets the WS session install/clear the forwarder's current sink.
    pub control: ForwarderControl,
    cmd_tx: mpsc::Sender<WorkerCmd>,
    lifecycle: SessionLifecycle,
    alive: Arc<AtomicBool>,
    history: Arc<ViewerHistory>,
    #[cfg(test)]
    input_copies: Arc<AtomicU64>,
}

/// Everything `worker_backend` needs to assemble a worker-backed handle.
pub struct WorkerHandleParts {
    pub session_id: Uuid,
    pub cwd: String,
    pub cmd_tx: mpsc::Sender<WorkerCmd>,
    pub lifecycle: SessionLifecycle,
    pub alive: Arc<AtomicBool>,
    pub cols: u16,
    pub rows: u16,
    pub outbox_tx: mpsc::Sender<OutputChunk>,
    pub control: ForwarderControl,
}

impl SessionHandle {
    pub fn new_worker(parts: WorkerHandleParts) -> Self {
        Self {
            session_id: parts.session_id,
            cwd: Arc::from(parts.cwd),
            shell_pid: 0,
            size: Arc::new(Mutex::new(PtySize {
                cols: parts.cols,
                rows: parts.rows,
                nudge: None,
                width_changes: 0,
            })),
            repaint: Arc::default(),
            repaint_hold_max: REPAINT_HOLD_MAX,
            outbox_tx: parts.outbox_tx,
            control: parts.control,
            cmd_tx: parts.cmd_tx,
            lifecycle: parts.lifecycle,
            alive: parts.alive,
            history: Arc::default(),
            #[cfg(test)]
            input_copies: Arc::new(AtomicU64::new(0)),
        }
    }

    /// The shell pid the worker reported at start or adoption.
    pub fn with_shell_pid(mut self, pid: u32) -> Self {
        self.shell_pid = pid;
        self
    }

    /// The window's shell, or `None` when its worker never said.
    pub fn shell_pid(&self) -> Option<u32> {
        (self.shell_pid != 0).then_some(self.shell_pid)
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

    /// Apply a viewer's size. True when it changed the width, which is what
    /// makes every program repaint; a height change alone is applied but
    /// returns false.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<bool> {
        let mut size = self
            .size
            .lock()
            .map_err(|_| anyhow::anyhow!("pty size lock poisoned"))?;
        if (size.cols, size.rows) == (cols, rows) {
            // A viewer asking for the size a repaint nudge is passing through
            // makes it theirs: the nudge no longer restores over it.
            size.nudge = None;
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
        let width_changed = size.cols != cols;
        // A viewer's size always wins over a nudge in progress.
        *size = PtySize {
            cols,
            rows,
            nudge: None,
            width_changes: size.width_changes.wrapping_add(u64::from(width_changed)),
        };
        // Only an admitted resize can trigger a repaint.
        self.control
            .suppress_activity(activity::REDRAW_SUPPRESS_WINDOW);
        Ok(width_changed)
    }

    /// Make the session's program repaint, for a viewer that was handed a
    /// replay with no screen ([`WorkerReplay::has_screen`]) and would
    /// otherwise look at a blank pane until the program next draws.
    ///
    /// Workers already running take no repaint command (`T_REDRAW` is
    /// ignored) and must never be sent keystrokes on a person's behalf, so
    /// the lever is the PTY size: one column narrower, then back. The kernel
    /// signals `SIGWINCH` only for a real change, and every full-screen
    /// program redraws on one; the width is what any renderer lays out
    /// against, so inline ones re-layout too. See [`RepaintNudge`] for the
    /// steps and their bounds. Empty replays handed out before a scheduled
    /// nudge starts, or while it holds the narrower size, join it, so viewers
    /// attaching together share one; the next one waits for the session's
    /// budget to allow it ([`REPAINT_MIN_INTERVAL`]).
    pub fn repaint_after_empty_replay(&self) {
        if !self.alive.load(Ordering::Acquire) {
            return;
        }
        let Ok((width_changes, holding)) = self
            .size
            .lock()
            .map(|size| (size.width_changes, size.nudge.is_some()))
        else {
            return;
        };
        if holding {
            // A nudge holds the narrower size: its restore is sent after this
            // replay's anchor, or a viewer's resize replaces it, and either
            // way the program repaints where this viewer sees it.
            return;
        }
        let due = {
            let Ok(mut schedule) = self.repaint.lock() else {
                return;
            };
            schedule.width_changes_at_request = width_changes;
            if schedule.scheduled {
                return;
            }
            schedule.scheduled = true;
            let now = tokio::time::Instant::now();
            (now + REPAINT_SETTLE).max(schedule.earliest(now))
        };
        let nudge = RepaintNudge {
            session_id: self.session_id,
            cmd_tx: self.cmd_tx.downgrade(),
            size: Arc::clone(&self.size),
            schedule: Arc::clone(&self.repaint),
            alive: Arc::clone(&self.alive),
            control: self.control.clone(),
            hold_max: self.repaint_hold_max,
        };
        tokio::spawn(nudge.run(due));
    }

    /// Hold a repaint nudge's narrower size until the program's own output
    /// arrives, however long that takes, so a test against a real program
    /// follows the program rather than a timer.
    #[cfg(all(test, unix))]
    pub(crate) fn hold_repaint_until_output_for_test(&mut self) {
        self.repaint_hold_max = Duration::from_secs(3600);
    }

    #[cfg(all(test, unix))]
    pub(crate) fn applied_size(&self) -> (u16, u16) {
        let size = self.size.lock().expect("pty size lock");
        (size.cols, size.rows)
    }

    pub fn lifecycle(&self) -> SessionLifecycle {
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

    /// Replay for a viewer: the attach barrier and the `spawn.ctl` history and
    /// snapshot requests. Like [`Self::replay`], except that history the
    /// worker can no longer read does not keep the terminal from opening.
    ///
    /// A replay that reached a segment file gone from disk is asked again
    /// with a quarter of the budget, down to one byte, until the walk stops
    /// short of it: the viewer gets the live screen and the newest contiguous
    /// run of history, never history with a hole in it. A budget that
    /// replayed this way is a hint for this connection's next requests, which
    /// start there instead of being refused again — for
    /// [`REPLAY_HINT_TTL`] from when it was learned, and only until the worker
    /// reports wiping its history. When even one byte reaches a missing
    /// segment, this viewer gets an empty replay at the current live-stream
    /// offset and the terminal opens on what the session prints next; the
    /// next request asks the worker again, since a line committed meanwhile
    /// or a `clear` can make history readable. Only a worker that says its
    /// log is disabled is not asked again. Every other refusal (failed
    /// authentication, a sequence gap, a malformed record) fails, exactly as
    /// [`Self::replay`].
    pub fn viewer_replay(&self, max_bytes: u32) -> Option<ViewerReplay> {
        if !self.alive.load(Ordering::Acquire) {
            return None;
        }
        let control = self.control.clone();
        let history = Arc::clone(&self.history);
        if history.disabled.load(Ordering::Acquire) {
            return Some(Box::pin(async move {
                Some(Ok(WorkerReplay::live_only(control.source_offset())))
            }));
        }
        let wipes = control.history_wipes();
        let mut budget = history.first_budget(max_bytes, wipes);
        let mut receiver = self.replay(budget)?;
        let cmd_tx = self.cmd_tx.clone();
        let session_id = self.session_id;
        Some(Box::pin(async move {
            let mut shrunk = false;
            loop {
                let error = match receiver.await {
                    Ok(Ok(replay)) => {
                        if shrunk {
                            history.learn(budget, wipes);
                        }
                        return Some(Ok(replay));
                    }
                    Ok(Err(error)) => error,
                    Err(_) => return None,
                };
                let unreadable = error
                    .downcast_ref::<WorkerReplayRefused>()
                    .and_then(|refused| unreadable_history(refused.message()));
                match unreadable {
                    None => return Some(Err(error)),
                    Some(UnreadableHistory::MissingSegment) if budget > 1 => {
                        history.report(session_id, true, &error);
                        budget = smaller_replay_budget(budget);
                        shrunk = true;
                        let (resp, next) = oneshot::channel();
                        cmd_tx
                            .send(WorkerCmd::Replay {
                                max_bytes: budget,
                                resp,
                            })
                            .await
                            .ok()?;
                        receiver = next;
                    }
                    Some(unreadable) => {
                        history.report(session_id, false, &error);
                        history.forget();
                        if unreadable == UnreadableHistory::LogDisabled {
                            history.disabled.store(true, Ordering::Release);
                        }
                        return Some(Ok(WorkerReplay::live_only(control.source_offset())));
                    }
                }
            }
        }))
    }
}

pub struct LaunchSpec<'a> {
    pub session_id: Uuid,
    pub cwd: &'a str,
    pub cols: u16,
    pub rows: u16,
    pub argv: &'a [String],
    /// Final env to pass to the session's login shell.
    pub env: &'a BTreeMap<String, String>,
}

/// Result of a successful launch.
pub struct Launched {
    pub handle: SessionHandle,
    /// PID of the session's shell process, reported by its session worker.
    pub pid: u32,
    /// Future-style: receives the exit reason once the PTY EOFs.
    pub exit_rx: oneshot::Receiver<ExitReason>,
}

#[derive(Debug, Clone)]
pub struct ExitReason {
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
}

/// Long-lived per-session task: route raw PTY bytes only to bounded direct
/// DataChannel sinks and emit content-free activity metadata to the current
/// control-plane session. Worker replay is the only catch-up source.
/// Exits when every bounded-outbox sender is dropped.
pub(crate) async fn run_forwarder(
    session_id: Uuid,
    mut outbox_rx: mpsc::Receiver<OutputChunk>,
    control: ForwarderControl,
) {
    let mut idle_timer: Option<IdleResolutionTimer> = None;
    loop {
        tokio::select! {
            chunk = outbox_rx.recv() => match chunk {
                Some(chunk) => queue_output_chunk(
                    session_id,
                    chunk,
                    &control,
                    &mut idle_timer,
                ).await,
                None => break,
            },
            generation = wait_for_idle(&mut idle_timer) => {
                idle_timer = None;
                if control.resolve_output_idle(generation) {
                    if let Some(activity) = activity_message(session_id, ActivityKind::Output) {
                        try_mirror(&control, activity).await;
                    }
                }
            }
        }
    }
    tracing::debug!(%session_id, "forwarder exiting (outbox closed)");
}

async fn queue_output_chunk(
    session_id: Uuid,
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
        if let Some(activity) = activity_message(session_id, ActivityKind::Output) {
            try_mirror(control, activity).await;
        }
    }
}

async fn emit_foreground(control: &ForwarderControl, session_id: Uuid, command: String) {
    let frame = Outbound::SessionForeground {
        session_id,
        command,
    };
    if let Ok(text) = serde_json::to_string(&frame) {
        try_mirror(control, WsOutbound::json(text)).await;
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

#[cfg(all(test, unix))]
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
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        || error.raw_os_error() == Some(nix::libc::ENOBUFS) =>
                {
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
        let dir = tempfile::Builder::new()
            .prefix("spawn-lc-")
            .tempdir_in("/tmp")
            .expect("short lifecycle timeout tempdir");
        let server_path = dir.path().join("lifecycle.sock");
        let (_server, _flood, _identity) = saturate_lifecycle_endpoint(dir.path(), &server_path);
        let mut unrelated = ChildCleanup(
            std::process::Command::new("sleep")
                .arg("30")
                .spawn()
                .expect("spawn unrelated sentinel process"),
        );
        let lifecycle = SessionLifecycle::new(server_path, Uuid::new_v4());
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

    /// Answer the viewer replay's worker requests from `answer` until it
    /// resolves; returns its result and every budget it asked for.
    async fn drive_viewer_replay(
        replay: ViewerReplay,
        cmd_rx: &mut mpsc::Receiver<WorkerCmd>,
        answer: impl Fn(u32) -> WorkerReplayResult,
    ) -> (Option<WorkerReplayResult>, Vec<u32>) {
        let mut asked = Vec::new();
        tokio::pin!(replay);
        loop {
            tokio::select! {
                result = &mut replay => return (result, asked),
                command = cmd_rx.recv() => match command.expect("handle dropped") {
                    WorkerCmd::Replay { max_bytes, resp } => {
                        asked.push(max_bytes);
                        let _ = resp.send(answer(max_bytes));
                    }
                    other => panic!("unexpected worker command {other:?}"),
                },
            }
        }
    }

    fn refused(message: &str) -> WorkerReplayResult {
        Err(anyhow::Error::new(WorkerReplayRefused::new(
            message.to_string(),
        )))
    }

    const MISSING_OLDEST: &str = "reading /tmp/spawn-501/workers/7c9e6679-7425-40de-944b-e07fc1f90ae7.scrollback/seg-00000001.log: No such file or directory (os error 2)";

    /// The rescue for a session whose oldest scrollback the OS deleted: the
    /// replay shrinks until it stops short of the hole, the budget that
    /// worked is kept, and a tampered segment still fails closed.
    #[tokio::test]
    async fn viewer_replay_stops_short_of_a_missing_segment_and_fails_closed_on_tampering() {
        let control = ForwarderControl::new();
        let (cmd_tx, mut cmd_rx) = mpsc::channel(WORKER_COMMAND_QUEUE_DEPTH);
        let handle = test_handle(control.clone(), cmd_tx, Arc::new(AtomicBool::new(true)));
        // A worker whose newest readable history holds 5,000 bytes: a walk
        // with more budget than that goes on to the deleted segment.
        let truncated = |budget: u32| {
            if budget > 5_000 {
                refused(MISSING_OLDEST)
            } else {
                Ok(WorkerReplay::new(
                    9,
                    b"newest history + live screen".to_vec(),
                ))
            }
        };

        let (result, asked) = drive_viewer_replay(
            handle.viewer_replay(64 * 1024).unwrap(),
            &mut cmd_rx,
            truncated,
        )
        .await;
        let replay = result.expect("answered").expect("truncated replay");
        assert_eq!(replay.bytes(), b"newest history + live screen");
        assert_eq!(replay.watermark(), 9);
        assert_eq!(asked, [65_536, 16_384, 4_096]);

        // A later viewer starts at the budget that worked: no worker refusal
        // (and no worker log line) per attach.
        let (result, asked) = drive_viewer_replay(
            handle.viewer_replay(8 << 20).unwrap(),
            &mut cmd_rx,
            truncated,
        )
        .await;
        assert!(result.expect("answered").is_ok());
        assert_eq!(asked, [4_096]);

        // Tampering is not truncation: failed authentication is returned as
        // it always was, and never retried with a smaller budget.
        let tampered = |_| {
            refused("scrollback record failed authentication in /tmp/spawn-501/workers/x.scrollback/seg-00000002.log")
        };
        let (result, asked) = drive_viewer_replay(
            handle.viewer_replay(64 * 1024).unwrap(),
            &mut cmd_rx,
            tampered,
        )
        .await;
        let error = result
            .expect("answered")
            .expect_err("tampered history replayed");
        assert!(
            error.to_string().contains("failed authentication"),
            "{error}"
        );
        assert_eq!(asked, [4_096]);
        for message in [
            "parsing /tmp/w/x.scrollback/seg-00000002.log: truncated record header",
            "scrollback sequence gap in /tmp/w/x.scrollback/seg-00000002.log (expected Some(4), got 9)",
            "reading /tmp/w/x.scrollback/seg-00000002.log: Permission denied (os error 13)",
            "reading /tmp/w/x.scrollback/notes.txt: No such file or directory (os error 2)",
            "replay budget must be non-zero",
        ] {
            let (result, asked) = drive_viewer_replay(
                handle.viewer_replay(64 * 1024).unwrap(),
                &mut cmd_rx,
                |_| refused(message),
            )
            .await;
            assert!(result.expect("answered").is_err(), "{message}");
            assert_eq!(asked.len(), 1, "{message} was retried");
        }
    }

    /// When nothing can be read, the viewer still gets a replay: empty, at
    /// the live stream's current offset, so the terminal opens on what the
    /// session prints next. Only a worker that says its log is disabled is
    /// never asked again — in either wording deployed workers use; a log that
    /// merely could not be read this time is asked again by the next viewer.
    #[tokio::test(start_paused = true)]
    async fn viewer_replay_opens_on_the_live_stream_when_no_history_is_readable() {
        const LADDER: [u32; 9] = [65_536, 16_384, 4_096, 1_024, 256, 64, 16, 4, 1];
        for (case, refusal) in [
            ("every segment gone", MISSING_OLDEST),
            (
                "log disabled",
                "worker replay is unavailable for this session",
            ),
            (
                "log disabled, older worker",
                "worker replay is unavailable for this agent",
            ),
        ] {
            let control = ForwarderControl::new();
            control.route_direct_for_test(b"already streamed").await;
            let (cmd_tx, mut cmd_rx) = mpsc::channel(WORKER_COMMAND_QUEUE_DEPTH);
            let handle = test_handle(control.clone(), cmd_tx, Arc::new(AtomicBool::new(true)));
            let (result, asked) = drive_viewer_replay(
                handle.viewer_replay(64 * 1024).unwrap(),
                &mut cmd_rx,
                |_| refused(refusal),
            )
            .await;
            let replay = result.expect("answered").expect(case);
            assert!(replay.bytes().is_empty(), "{case}");
            assert_eq!(replay.watermark(), control.source_offset(), "{case}");
            assert_eq!(replay.history_anchor(), None, "{case}");
            let disabled = case.starts_with("log disabled");
            if disabled {
                assert_eq!(asked, [65_536], "{case}");
            } else {
                assert_eq!(asked, LADDER, "{case}");
            }

            // Later, past any hint's life: a disabled log is still not asked;
            // an unreadable one is asked again, from the full budget.
            tokio::time::advance(REPLAY_HINT_TTL * 2).await;
            let (result, asked) = drive_viewer_replay(
                handle.viewer_replay(64 * 1024).unwrap(),
                &mut cmd_rx,
                |_| refused(refusal),
            )
            .await;
            assert!(result.expect("answered").expect(case).bytes().is_empty());
            if disabled {
                assert!(asked.is_empty(), "{case}: a disabled log was asked again");
            } else {
                assert_eq!(asked, LADDER, "{case}: an unreadable log was given up on");
            }
        }

        // A handle whose worker is gone still has no replay to offer.
        let (cmd_tx, _cmd_rx) = mpsc::channel(WORKER_COMMAND_QUEUE_DEPTH);
        let gone = test_handle(
            ForwarderControl::new(),
            cmd_tx,
            Arc::new(AtomicBool::new(false)),
        );
        assert!(gone.viewer_replay(64 * 1024).is_none());
    }

    /// A budget learned by shrinking is a hint, not a cap: it is learned only
    /// from a replay that succeeded, it is not renewed by use, it lapses after
    /// `REPLAY_HINT_TTL`, and a history wipe voids it. Each time, the full
    /// budget is asked for again.
    #[tokio::test(start_paused = true)]
    async fn a_learned_replay_budget_lapses_and_a_wipe_voids_it() {
        let control = ForwarderControl::new();
        let (cmd_tx, mut cmd_rx) = mpsc::channel(WORKER_COMMAND_QUEUE_DEPTH);
        let handle = test_handle(control.clone(), cmd_tx, Arc::new(AtomicBool::new(true)));
        let truncated = |budget: u32| {
            if budget > 5_000 {
                refused(MISSING_OLDEST)
            } else {
                Ok(WorkerReplay::new(0, b"newest".to_vec()))
            }
        };
        let healed = |_| Ok(WorkerReplay::new(0, b"all of it".to_vec()));
        let ask = |max_bytes: u32| handle.viewer_replay(max_bytes).unwrap();

        // Nothing is learned from refusals alone: a request whose every
        // budget was refused leaves the next one starting at its own.
        let (_, asked) =
            drive_viewer_replay(ask(64 * 1024), &mut cmd_rx, |_| refused(MISSING_OLDEST)).await;
        assert_eq!(asked.last(), Some(&1));
        let (_, asked) = drive_viewer_replay(ask(8 << 20), &mut cmd_rx, truncated).await;
        assert_eq!(
            asked,
            [
                8 << 20,
                2 << 20,
                512 << 10,
                128 << 10,
                32 << 10,
                8 << 10,
                2 << 10
            ]
        );

        // While fresh, the hint is where requests start.
        let (_, asked) = drive_viewer_replay(ask(8 << 20), &mut cmd_rx, truncated).await;
        assert_eq!(asked, [2 << 10]);

        // (a) The worker wipes its history: every segment, and the gap with
        // them, is gone. The full budget is asked for at once.
        control.route_history(1, None, &[]).await;
        let (result, asked) = drive_viewer_replay(ask(8 << 20), &mut cmd_rx, healed).await;
        assert_eq!(asked, [8 << 20]);
        assert_eq!(result.unwrap().unwrap().bytes(), b"all of it");

        // (b) Learned again, then left to lapse: using it does not renew it.
        let (_, asked) = drive_viewer_replay(ask(8 << 20), &mut cmd_rx, truncated).await;
        assert_eq!(asked.last(), Some(&(2 << 10)));
        tokio::time::advance(REPLAY_HINT_TTL / 2).await;
        let (_, asked) = drive_viewer_replay(ask(8 << 20), &mut cmd_rx, truncated).await;
        assert_eq!(asked, [2 << 10]);
        tokio::time::advance(REPLAY_HINT_TTL / 2 + Duration::from_secs(1)).await;
        let (result, asked) = drive_viewer_replay(ask(8 << 20), &mut cmd_rx, healed).await;
        assert_eq!(asked, [8 << 20]);
        assert_eq!(result.unwrap().unwrap().bytes(), b"all of it");
    }

    /// The cases a remembered "nothing readable" used to leave blank for good,
    /// against a real scrollback log: the full segment gone while the empty
    /// one rotation left survives (an empty segment has no records, so even
    /// one byte walks on to the gap), and the newest segment gone before a
    /// `clear`. Each viewer opens; once history is readable again, the next
    /// one gets it from the worker.
    #[tokio::test]
    async fn a_log_that_becomes_readable_again_is_read_again() {
        use spawnd::sessiond::scrollback::ScrollbackLog;

        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("session.scrollback");
        let key = spawnd::sessiond::secret::SecretBytes::random(32).unwrap();
        let log = std::cell::RefCell::new(
            ScrollbackLog::with_limits(&dir, &key, 4 * 1024, 64 * 1024).unwrap(),
        );
        let line = "\x1b[0mcommitted line of terminal history\r\n".repeat(16);
        while log.borrow().segment_count() < 2 {
            log.borrow_mut().append_history(line.as_bytes()).unwrap();
        }
        // Rotation left seg-2 empty; the cleaner takes the full seg-1.
        assert_eq!(
            std::fs::metadata(dir.join("seg-00000002.log"))
                .unwrap()
                .len(),
            0
        );
        std::fs::remove_file(dir.join("seg-00000001.log")).unwrap();
        let worker = |budget: u32| match log.borrow_mut().replay(u64::from(budget)) {
            Ok(history) => Ok(WorkerReplay::new(
                0,
                [b"worker:".as_slice(), &history].concat(),
            )),
            Err(error) => refused(&format!("{error:#}")),
        };

        let control = ForwarderControl::new();
        let (cmd_tx, mut cmd_rx) = mpsc::channel(WORKER_COMMAND_QUEUE_DEPTH);
        let handle = test_handle(control, cmd_tx, Arc::new(AtomicBool::new(true)));
        let (result, asked) = drive_viewer_replay(
            handle.viewer_replay(64 * 1024).unwrap(),
            &mut cmd_rx,
            worker,
        )
        .await;
        assert!(result.unwrap().unwrap().bytes().is_empty());
        assert_eq!(asked.last(), Some(&1));

        // Lines commit into the empty segment: it is readable now (enough of
        // them that a quarter-step budget holds some).
        for _ in 0..4 {
            log.borrow_mut()
                .append_history(b"\x1b[0mthe newest line\r\n")
                .unwrap();
        }
        let (result, _) = drive_viewer_replay(
            handle.viewer_replay(64 * 1024).unwrap(),
            &mut cmd_rx,
            worker,
        )
        .await;
        let replay = result.unwrap().unwrap();
        assert!(replay.bytes().starts_with(b"worker:"));
        assert!(String::from_utf8_lossy(replay.bytes()).contains("the newest line"));

        // The newest segment goes too, then the app clears its scrollback:
        // the worker starts a fresh segment and replays again.
        for entry in std::fs::read_dir(&dir).unwrap() {
            std::fs::remove_file(entry.unwrap().path()).unwrap();
        }
        let (result, asked) = drive_viewer_replay(
            handle.viewer_replay(64 * 1024).unwrap(),
            &mut cmd_rx,
            worker,
        )
        .await;
        assert!(result.unwrap().unwrap().bytes().is_empty());
        assert_eq!(asked.last(), Some(&1));
        log.borrow_mut().truncate_all().unwrap();
        let (result, asked) = drive_viewer_replay(
            handle.viewer_replay(64 * 1024).unwrap(),
            &mut cmd_rx,
            worker,
        )
        .await;
        assert_eq!(result.unwrap().unwrap().bytes(), b"worker:");
        assert_eq!(asked, [65_536]);
    }

    /// The words spawnd reads are the words deployed workers say. Running
    /// workers keep their binary, so changing a constant here or in the
    /// worker does not change what they say: these literals are the contract.
    #[test]
    fn the_refusal_words_spawnd_reads_are_the_ones_workers_say() {
        use spawnd::sessiond::scrollback::{SEGMENT_PREFIX, SEGMENT_READ_CONTEXT, SEGMENT_SUFFIX};
        use spawnd::sessiond::worker::REPLAY_UNAVAILABLE;

        assert_eq!(
            REPLAY_UNAVAILABLE,
            "worker replay is unavailable for this session"
        );
        assert_eq!(SEGMENT_READ_CONTEXT, "reading ");
        assert_eq!(SEGMENT_PREFIX, "seg-");
        assert_eq!(SEGMENT_SUFFIX, ".log");
        for disabled in [
            REPLAY_UNAVAILABLE,
            // Workers started from 2026-08-19 (control protocol v3).
            "worker replay is unavailable for this session",
            // Workers started from 2026-07-16 to 2026-08-19: same protocol.
            "worker replay is unavailable for this agent",
        ] {
            assert_eq!(
                unreadable_history(disabled),
                Some(UnreadableHistory::LogDisabled),
                "{disabled}"
            );
        }
        assert_eq!(
            unreadable_history("worker replay is unavailable before start"),
            None
        );
        for missing in [
            MISSING_OLDEST,
            "reading C:\\Users\\u\\AppData\\Local\\spawn\\logs\\x\\workers\\s.scrollback\\history\\seg-00000007.log: The system cannot find the file specified. (os error 2)",
        ] {
            assert_eq!(
                unreadable_history(missing),
                Some(UnreadableHistory::MissingSegment),
                "{missing}"
            );
        }
    }

    /// The classifier reads the words the scrollback log itself produces:
    /// a deleted segment is unreadable history; a tampered or truncated one
    /// is not.
    #[test]
    fn unreadable_history_matches_what_the_scrollback_log_says() {
        use spawnd::sessiond::scrollback::ScrollbackLog;

        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("session.scrollback");
        let key = spawnd::sessiond::secret::SecretBytes::random(32).unwrap();
        let mut log = ScrollbackLog::with_limits(&dir, &key, 4 * 1024, 64 * 1024).unwrap();
        let line = "\x1b[0mcommitted line of terminal history\r\n".repeat(16);
        while log.segment_count() < 3 {
            log.append_history(line.as_bytes()).unwrap();
        }
        let oldest = dir.join("seg-00000001.log");
        assert!(oldest.exists());
        let refusal =
            |log: &mut ScrollbackLog| format!("{:#}", log.replay(u32::MAX as u64).unwrap_err());

        std::fs::remove_file(&oldest).unwrap();
        let missing = refusal(&mut log);
        assert_eq!(
            unreadable_history(&missing),
            Some(UnreadableHistory::MissingSegment),
            "{missing}"
        );

        // Rotation leaves the newest segment empty; the one before it is
        // read first and holds records.
        let full = dir.join("seg-00000002.log");
        let mut bytes = std::fs::read(&full).unwrap();
        assert!(bytes.len() > 20);
        bytes[20] ^= 0xff;
        std::fs::write(&full, &bytes).unwrap();
        let tampered = refusal(&mut log);
        assert!(tampered.contains("failed authentication"), "{tampered}");
        assert_eq!(unreadable_history(&tampered), None);

        std::fs::write(&full, &bytes[..5]).unwrap();
        let truncated = refusal(&mut log);
        assert!(truncated.contains("truncated record"), "{truncated}");
        assert_eq!(unreadable_history(&truncated), None);
    }

    /// The next resize the handle sends its worker, and when, or `None` if
    /// none comes within two (paused, auto-advancing) minutes: longer than
    /// any interval, settle or hold.
    async fn next_resize(
        cmd_rx: &mut mpsc::Receiver<WorkerCmd>,
    ) -> Option<((u16, u16), tokio::time::Instant)> {
        loop {
            match tokio::time::timeout(Duration::from_secs(120), cmd_rx.recv()).await {
                Ok(Some(WorkerCmd::Resize { cols, rows })) => {
                    return Some(((cols, rows), tokio::time::Instant::now()))
                }
                Ok(Some(_)) => continue,
                Ok(None) | Err(_) => return None,
            }
        }
    }

    fn nudge_test_handle() -> (ForwarderControl, mpsc::Receiver<WorkerCmd>, SessionHandle) {
        let control = ForwarderControl::new();
        let (cmd_tx, cmd_rx) = mpsc::channel(WORKER_COMMAND_QUEUE_DEPTH);
        let handle = test_handle(control.clone(), cmd_tx, Arc::new(AtomicBool::new(true)));
        (control, cmd_rx, handle)
    }

    /// An empty replay makes the program repaint: after the settle, one
    /// column narrower, held until the program's output and no less than the
    /// minimum, then back where it was — once, and never again by itself.
    #[tokio::test(start_paused = true)]
    async fn an_empty_replay_nudges_the_size_once_and_puts_it_back() {
        let (control, mut cmd_rx, handle) = nudge_test_handle();
        let asked = tokio::time::Instant::now();
        handle.repaint_after_empty_replay();

        let (narrow, at) = next_resize(&mut cmd_rx).await.expect("nudge");
        assert_eq!(narrow, (79, 24));
        assert_eq!(at - asked, REPAINT_SETTLE);
        assert_eq!(handle.applied_size(), (79, 24));
        // The program repaints at once; the size still stands the minimum.
        control
            .route_direct_for_test(b"repaint at 79 columns")
            .await;
        let (restored, back) = next_resize(&mut cmd_rx).await.expect("restore");
        assert_eq!(restored, (80, 24));
        assert_eq!(back - at, REPAINT_HOLD_MIN);
        assert_eq!(handle.applied_size(), (80, 24));
        assert!(next_resize(&mut cmd_rx).await.is_none(), "nudged again");

        // A program that does not repaint (a shell at its prompt) is given
        // the longest hold, then the size comes back all the same.
        handle.repaint_after_empty_replay();
        let (_, at) = next_resize(&mut cmd_rx).await.expect("nudge");
        let (restored, back) = next_resize(&mut cmd_rx).await.expect("restore");
        assert_eq!(restored, (80, 24));
        assert_eq!(back - at, REPAINT_HOLD_MAX);
    }

    /// Viewers attaching together share one nudge, including one handed its
    /// replay while the narrower size stands; one that comes after the
    /// restore gets its own, no sooner than the interval allows.
    #[tokio::test(start_paused = true)]
    async fn viewers_attaching_together_share_one_nudge() {
        let (control, mut cmd_rx, handle) = nudge_test_handle();
        handle.repaint_after_empty_replay();
        tokio::time::advance(REPAINT_SETTLE / 2).await;
        handle.repaint_after_empty_replay();
        let (narrow, first) = next_resize(&mut cmd_rx).await.expect("nudge");
        assert_eq!(narrow, (79, 24));
        // One handed out while the narrower size stands: the restore's
        // repaint reaches it.
        handle.repaint_after_empty_replay();
        control.route_direct_for_test(b"repaint").await;
        let (restored, _) = next_resize(&mut cmd_rx).await.expect("restore");
        assert_eq!(restored, (80, 24));

        handle.repaint_after_empty_replay();
        handle.repaint_after_empty_replay();
        let (narrow, second) = next_resize(&mut cmd_rx).await.expect("second nudge");
        assert_eq!(narrow, (79, 24));
        assert_eq!(second, first + REPAINT_MIN_INTERVAL);
        assert_eq!(
            next_resize(&mut cmd_rx).await.map(|(size, _)| size),
            Some((80, 24))
        );
        assert!(
            next_resize(&mut cmd_rx).await.is_none(),
            "more nudges than asked for"
        );
    }

    /// Ask for a repaint at each of `asks` (offsets from the start), with a
    /// program that answers every narrowing at once; when each nudge
    /// narrowed the PTY, as offsets from the start.
    async fn nudge_starts(asks: &[Duration]) -> Vec<Duration> {
        let (control, mut cmd_rx, handle) = nudge_test_handle();
        let begin = tokio::time::Instant::now();
        let program = tokio::spawn(async move {
            let mut starts = Vec::new();
            while let Some(command) = cmd_rx.recv().await {
                if let WorkerCmd::Resize { cols: 79, .. } = command {
                    starts.push(tokio::time::Instant::now() - begin);
                    control.route_direct_for_test(b"repaint").await;
                }
            }
            starts
        });
        for ask in asks {
            tokio::time::sleep_until(begin + *ask).await;
            handle.repaint_after_empty_replay();
        }
        tokio::time::sleep(REPAINT_MAX_INTERVAL * 2).await;
        drop(handle);
        program.await.expect("program")
    }

    /// A viewer reattaching every 16 s: the budget's four nudges come at
    /// once, then about one a minute for as long as it keeps on; once it
    /// stops for a few minutes, the next viewer is prompt again.
    #[tokio::test(start_paused = true)]
    async fn a_reattach_loop_is_held_to_about_one_nudge_a_minute() {
        let secs = Duration::from_secs;
        let mut asks: Vec<Duration> = (0..40).map(|n| secs(16 * n)).collect();
        let after = secs(16 * 39) + secs(300);
        asks.push(after);
        let starts = nudge_starts(&asks).await;
        for n in 0..4 {
            assert_eq!(starts[n], asks[n] + REPAINT_SETTLE, "{starts:?}");
        }
        let storm = &starts[..starts.len() - 1];
        for pair in storm[3..].windows(2) {
            assert!(pair[1] - pair[0] >= REPAINT_MAX_INTERVAL, "{starts:?}");
        }
        // 4 at once, then one a minute over the remaining ten minutes.
        assert!(storm.len() <= 4 + 11, "{} nudges: {starts:?}", storm.len());
        assert_eq!(starts.last(), Some(&(after + REPAINT_SETTLE)), "{starts:?}");
    }

    /// People opening a session at a human pace — a few at once (a reload,
    /// a second device), then every couple of minutes — are never kept
    /// waiting: every nudge comes at the settle.
    #[tokio::test(start_paused = true)]
    async fn ordinary_use_is_never_kept_waiting() {
        let secs = Duration::from_secs;
        let mut asks = vec![secs(0), secs(10), secs(20), secs(30)];
        asks.extend((1..15).map(|n| secs(30 + 120 * n)));
        let starts = nudge_starts(&asks).await;
        let expected: Vec<Duration> = asks.iter().map(|ask| *ask + REPAINT_SETTLE).collect();
        assert_eq!(starts, expected);
    }

    /// A viewer's resize while the narrower size stands is never undone:
    /// the restore stands down, whether the viewer chose another size or
    /// the very size the nudge was passing through.
    #[tokio::test(start_paused = true)]
    async fn a_viewer_resize_during_a_nudge_wins() {
        for wanted in [(100, 30), (79, 24)] {
            let (_control, mut cmd_rx, handle) = nudge_test_handle();
            handle.repaint_after_empty_replay();
            assert_eq!(
                next_resize(&mut cmd_rx).await.map(|(size, _)| size),
                Some((79, 24))
            );
            // (100, 30) differs from the narrower size and is sent; (79, 24)
            // is the narrower size itself, so nothing is sent, but it is
            // the viewer's now.
            handle.resize(wanted.0, wanted.1).expect("viewer resize");
            if wanted != (79, 24) {
                assert_eq!(
                    next_resize(&mut cmd_rx).await.map(|(size, _)| size),
                    Some(wanted)
                );
            }
            assert!(
                next_resize(&mut cmd_rx).await.is_none(),
                "{wanted:?} was undone"
            );
            assert_eq!(handle.applied_size(), wanted);
        }
    }

    /// The viewer's own width change after its seed makes the program
    /// repaint, past the seed's anchor: no nudge then. One applied before
    /// the seed (the history request's own size) does not count here.
    #[tokio::test(start_paused = true)]
    async fn a_width_change_after_the_empty_replay_makes_the_nudge_unneeded() {
        let (_control, mut cmd_rx, handle) = nudge_test_handle();
        assert!(handle.resize(90, 24).unwrap());
        assert_eq!(
            next_resize(&mut cmd_rx).await.map(|(size, _)| size),
            Some((90, 24))
        );
        handle.repaint_after_empty_replay();
        assert_eq!(
            next_resize(&mut cmd_rx).await.map(|(size, _)| size),
            Some((89, 24))
        );
        assert_eq!(
            next_resize(&mut cmd_rx).await.map(|(size, _)| size),
            Some((90, 24))
        );

        handle.repaint_after_empty_replay();
        assert!(handle.resize(100, 30).unwrap());
        assert_eq!(
            next_resize(&mut cmd_rx).await.map(|(size, _)| size),
            Some((100, 30))
        );
        assert!(
            next_resize(&mut cmd_rx).await.is_none(),
            "nudged after a real resize"
        );
        assert_eq!(handle.applied_size(), (100, 30));
    }

    /// A height change alone (a phone's keyboard opening) is applied, but an
    /// inline program may draw nothing for it: the nudge still comes.
    #[tokio::test(start_paused = true)]
    async fn a_height_change_alone_does_not_make_the_nudge_unneeded() {
        let (_control, mut cmd_rx, handle) = nudge_test_handle();
        handle.repaint_after_empty_replay();
        assert!(!handle.resize(80, 30).unwrap(), "only the height changed");
        let sizes = [
            next_resize(&mut cmd_rx).await,
            next_resize(&mut cmd_rx).await,
            next_resize(&mut cmd_rx).await,
        ]
        .map(|resize| resize.map(|(size, _)| size));
        assert_eq!(sizes, [Some((80, 30)), Some((79, 30)), Some((80, 30))]);
        assert_eq!(handle.applied_size(), (80, 30));
    }

    /// No nudge for a session that is not running, nor once it stops
    /// before the nudge starts.
    #[tokio::test(start_paused = true)]
    async fn no_nudge_when_the_session_is_not_running() {
        let (cmd_tx, mut cmd_rx) = mpsc::channel(WORKER_COMMAND_QUEUE_DEPTH);
        let alive = Arc::new(AtomicBool::new(false));
        let stopped = test_handle(ForwarderControl::new(), cmd_tx, Arc::clone(&alive));
        stopped.repaint_after_empty_replay();
        assert!(next_resize(&mut cmd_rx).await.is_none());

        let (cmd_tx, mut cmd_rx) = mpsc::channel(WORKER_COMMAND_QUEUE_DEPTH);
        let alive = Arc::new(AtomicBool::new(true));
        let stopping = test_handle(ForwarderControl::new(), cmd_tx, Arc::clone(&alive));
        stopping.repaint_after_empty_replay();
        alive.store(false, Ordering::Release);
        assert!(next_resize(&mut cmd_rx).await.is_none());
    }

    /// The nudge does not depend on the viewer that asked: with its
    /// `spawn.pty` gone, the size still comes back.
    #[tokio::test(start_paused = true)]
    async fn the_restore_does_not_wait_for_the_viewer_that_asked() {
        let (control, mut cmd_rx, handle) = nudge_test_handle();
        let viewer = control.add_direct_sink("leaving".into()).await;
        handle.repaint_after_empty_replay();
        control.remove_direct_sink("leaving").await;
        drop(viewer);
        assert_eq!(
            next_resize(&mut cmd_rx).await.map(|(size, _)| size),
            Some((79, 24))
        );
        control.route_direct_for_test(b"repaint").await;
        assert_eq!(
            next_resize(&mut cmd_rx).await.map(|(size, _)| size),
            Some((80, 24))
        );
        assert_eq!(handle.applied_size(), (80, 24));
    }

    /// A handle let go of while the narrower size stands: the nudge holds
    /// none of its connection open and sends nothing more. The daemon that
    /// adopts the worker next reads its real size from the hello.
    #[tokio::test(start_paused = true)]
    async fn a_handle_dropped_mid_hold_is_not_kept_open() {
        let (_control, mut cmd_rx, handle) = nudge_test_handle();
        handle.repaint_after_empty_replay();
        assert_eq!(
            next_resize(&mut cmd_rx).await.map(|(size, _)| size),
            Some((79, 24))
        );
        drop(handle);
        let closed = tokio::time::timeout(REPAINT_HOLD_MAX * 3, cmd_rx.recv()).await;
        assert!(
            matches!(closed, Ok(None)),
            "the connection stayed open or was sent more"
        );
    }

    /// A narrowing the full command queue refuses is a nudge skipped: the
    /// size is untouched, and the next viewer's nudge is not delayed by it.
    #[tokio::test(start_paused = true)]
    async fn a_refused_narrowing_skips_the_nudge_without_delaying_the_next() {
        let control = ForwarderControl::new();
        let (cmd_tx, mut cmd_rx) = mpsc::channel(WORKER_COMMAND_QUEUE_DEPTH);
        let filler = cmd_tx.clone();
        let handle = test_handle(control, cmd_tx, Arc::new(AtomicBool::new(true)));
        while filler
            .try_send(WorkerCmd::Input(DirectPayload::new(b"x".to_vec())))
            .is_ok()
        {}
        handle.repaint_after_empty_replay();
        tokio::time::sleep(REPAINT_SETTLE * 2).await;
        while let Ok(command) = cmd_rx.try_recv() {
            assert!(
                !matches!(command, WorkerCmd::Resize { .. }),
                "resized through a full queue"
            );
        }
        assert_eq!(handle.applied_size(), (80, 24));

        let asked = tokio::time::Instant::now();
        handle.repaint_after_empty_replay();
        let (narrow, at) = next_resize(&mut cmd_rx).await.expect("nudge");
        assert_eq!(narrow, (79, 24));
        assert_eq!(at - asked, REPAINT_SETTLE);
    }

    /// The restore waits for room in a full command queue rather than give
    /// up and leave the session narrower, and backs off while it waits
    /// rather than spin.
    #[tokio::test(start_paused = true)]
    async fn the_restore_waits_for_room_in_a_full_queue() {
        let control = ForwarderControl::new();
        let (cmd_tx, mut cmd_rx) = mpsc::channel(WORKER_COMMAND_QUEUE_DEPTH);
        let filler = cmd_tx.clone();
        let handle = test_handle(control, cmd_tx, Arc::new(AtomicBool::new(true)));
        handle.repaint_after_empty_replay();
        assert_eq!(
            next_resize(&mut cmd_rx).await.map(|(size, _)| size),
            Some((79, 24))
        );
        while filler
            .try_send(WorkerCmd::Input(DirectPayload::new(b"x".to_vec())))
            .is_ok()
        {}
        tokio::time::sleep(REPAINT_HOLD_MAX * 3).await;
        assert_eq!(
            handle.applied_size(),
            (79, 24),
            "restored without room to send it"
        );
        // Room now: the restore lands on its next retry, which by now is
        // spaced well beyond the first and no further than the last.
        let room = tokio::time::Instant::now();
        let (restored, at) = next_resize(&mut cmd_rx).await.expect("restore");
        assert_eq!(restored, (80, 24));
        assert!(at - room > REPAINT_RESTORE_RETRY_MIN, "{:?}", at - room);
        assert!(at - room <= REPAINT_RESTORE_RETRY_MAX, "{:?}", at - room);
        assert_eq!(handle.applied_size(), (80, 24));
    }

    #[test]
    fn only_a_replay_spawnd_made_has_no_screen() {
        assert!(WorkerReplay::new(1, b"screen".to_vec()).has_screen());
        assert!(WorkerReplay::new_with_history(1, b"screen".to_vec(), (0, 0)).has_screen());
        assert!(!WorkerReplay::live_only(1).has_screen());
    }

    fn test_handle(
        control: ForwarderControl,
        cmd_tx: mpsc::Sender<WorkerCmd>,
        alive: Arc<AtomicBool>,
    ) -> SessionHandle {
        let (outbox_tx, _outbox_rx) = mpsc::channel(WORKER_OUTPUT_QUEUE_DEPTH);
        SessionHandle::new_worker(WorkerHandleParts {
            session_id: Uuid::new_v4(),
            cwd: "/".into(),
            cmd_tx,
            lifecycle: SessionLifecycle::new(
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
        let session_id = Uuid::new_v4();
        let control = ForwarderControl::new();
        let direct = control.add_direct_sink("healthy".into()).await;
        let mut direct_rx = direct.receiver;
        let mut disconnected = direct.disconnected;
        let (outbox_tx, outbox_rx) = mpsc::channel(WORKER_OUTPUT_QUEUE_DEPTH);
        assert_eq!(outbox_tx.max_capacity(), WORKER_OUTPUT_QUEUE_DEPTH);
        let forwarder = tokio::spawn(run_forwarder(session_id, outbox_rx, control.clone()));
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

        assert!(control.note_input_at(start, b"a"));
        assert!(!control.note_input_at(
            start + activity::INPUT_TOUCH_INTERVAL - Duration::from_millis(1),
            b"b"
        ));
        assert!(control.note_input_at(start + activity::INPUT_TOUCH_INTERVAL, b"c"));
        assert!(control.note_output_at(start, b"independent output"));
    }

    #[test]
    fn terminal_replies_never_register_as_input() {
        // Clicking a session to see what it is doing makes xterm.js send focus
        // and mouse reports. Counting those made the badge say "Input sent"
        // because somebody looked at it.
        let control = ForwarderControl::new();
        let start = Instant::now();

        assert!(!control.note_input_at(start, b"\x1b[I"));
        assert!(!control.note_input_at(start + Duration::from_secs(5), b"\x1b[<0;40;12M"));
        assert!(!control.note_input_at(start + Duration::from_secs(10), b"\x1b[24;80R"));

        // …and a real keystroke still counts, on the very next chunk.
        assert!(control.note_input_at(start + Duration::from_secs(15), b"x"));
    }

    #[test]
    fn a_reply_split_across_chunks_stays_a_reply() {
        // The parser has to see every byte in order; a throttled or partial
        // chunk that skipped it would leave the next reply looking like input.
        let control = ForwarderControl::new();
        let start = Instant::now();

        assert!(!control.note_input_at(start, b"\x1b["));
        assert!(!control.note_input_at(start + Duration::from_secs(5), b"I"));
        assert!(!control.note_input_at(start + Duration::from_secs(10), b"\x1b[<0;1;1"));
        assert!(!control.note_input_at(start + Duration::from_secs(15), b"M"));
    }

    #[tokio::test(start_paused = true)]
    async fn foreground_reports_are_change_only_rate_limited_and_truncated() {
        let control = ForwarderControl::new();
        let (tx, mut rx) = mpsc::channel(8);
        control.set_sink(tx).await;
        let session_id = Uuid::new_v4();

        control.note_foreground(session_id, "zsh").await;
        let first = rx.recv().await.unwrap();
        assert!(first.as_str().contains("session.foreground"));
        assert!(first.as_str().contains("\"zsh\""));
        assert!(first.as_str().contains(&session_id.to_string()));

        // The same observation again is not re-emitted.
        control.note_foreground(session_id, "zsh").await;
        assert!(rx.try_recv().is_err());

        // A change inside the rate-limit window is deferred, never dropped,
        // and the deferred emit carries the LATEST observation.
        control.note_foreground(session_id, "claude").await;
        control.note_foreground(session_id, "vim").await;
        assert!(rx.try_recv().is_err());
        tokio::time::sleep(FOREGROUND_MIN_INTERVAL + Duration::from_millis(50)).await;
        let second = rx.recv().await.unwrap();
        assert!(second.as_str().contains("\"vim\""));
        assert!(rx.try_recv().is_err());

        // Basenames are truncated to the documented 64-character bound.
        tokio::time::sleep(FOREGROUND_MIN_INTERVAL).await;
        let long = "x".repeat(100);
        control.note_foreground(session_id, &long).await;
        let third = rx.recv().await.unwrap();
        assert!(third
            .as_str()
            .contains(&"x".repeat(MAX_FOREGROUND_COMMAND_CHARS)));
        assert!(!third
            .as_str()
            .contains(&"x".repeat(MAX_FOREGROUND_COMMAND_CHARS + 1)));
    }

    #[tokio::test(start_paused = true)]
    async fn foreground_resend_reannounces_after_reconnect_within_the_rate_limit() {
        let control = ForwarderControl::new();
        let (tx, mut rx) = mpsc::channel(8);
        control.set_sink(tx).await;
        let session_id = Uuid::new_v4();

        control.note_foreground(session_id, "claude").await;
        assert!(rx.recv().await.unwrap().as_str().contains("\"claude\""));

        // Reconnect: a fresh sink is installed and the current value is
        // re-announced, but not inside the one-second window.
        let (tx, mut rx) = mpsc::channel(8);
        control.set_sink(tx).await;
        control.resend_foreground(session_id).await;
        assert!(rx.try_recv().is_err());
        tokio::time::sleep(FOREGROUND_MIN_INTERVAL + Duration::from_millis(50)).await;
        assert!(rx.recv().await.unwrap().as_str().contains("\"claude\""));

        // A later reconnect outside the window re-announces immediately.
        tokio::time::sleep(FOREGROUND_MIN_INTERVAL).await;
        let (tx, mut rx) = mpsc::channel(8);
        control.set_sink(tx).await;
        control.resend_foreground(session_id).await;
        assert!(rx.recv().await.unwrap().as_str().contains("\"claude\""));
    }

    #[tokio::test]
    async fn activity_frames_serialize_without_terminal_content() {
        let session_id = Uuid::new_v4();
        let (tx, mut rx) = mpsc::channel(2);

        assert!(try_emit_activity(&tx, session_id, ActivityKind::Output));
        assert!(try_emit_activity(&tx, session_id, ActivityKind::Input));

        let output = rx.recv().await.unwrap();
        let output_json = output.as_str();
        let input = rx.recv().await.unwrap();
        let input_json = input.as_str();
        assert_eq!(
            output_json,
            &format!(r#"{{"type":"session.activity","session_id":"{session_id}"}}"#)
        );
        assert_eq!(
            input_json,
            &format!(r#"{{"type":"session.input_activity","session_id":"{session_id}"}}"#)
        );
    }

    #[tokio::test]
    async fn forwarder_keeps_output_off_server_and_emits_content_free_activity() {
        let session_id = Uuid::new_v4();
        let control = ForwarderControl::new();
        let (sink_tx, mut sink_rx) = mpsc::channel(4);
        control.set_sink(sink_tx).await;
        let (outbox_tx, outbox_rx) = mpsc::channel(WORKER_OUTPUT_QUEUE_DEPTH);
        let forwarder = tokio::spawn(run_forwarder(session_id, outbox_rx, control.clone()));

        outbox_tx
            .try_send(source_output(&control, b"sensitive terminal output"))
            .unwrap();
        drop(outbox_tx);

        let activity_message = sink_rx.recv().await.unwrap();
        let activity_json = activity_message.as_str();
        assert_eq!(
            activity_json,
            &format!(r#"{{"type":"session.activity","session_id":"{session_id}"}}"#)
        );
        assert!(!activity_json.contains("sensitive terminal output"));
        assert!(sink_rx.try_recv().is_err());
        forwarder.await.unwrap();
    }

    #[tokio::test]
    async fn stalled_mirror_is_detached_while_direct_output_continues() {
        let session_id = Uuid::new_v4();
        let control = ForwarderControl::new();
        let mut direct = control.add_direct_sink("test".into()).await;

        // Capacity one deliberately blocks activity metadata after its first
        // ping. Direct receipts prove terminal bytes never use that queue.
        let (sink_tx, mut sink_rx) = mpsc::channel(1);
        control.set_sink(sink_tx).await;
        let (outbox_tx, outbox_rx) = mpsc::channel(WORKER_OUTPUT_QUEUE_DEPTH);
        let forwarder = tokio::spawn(run_forwarder(session_id, outbox_rx, control.clone()));

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
            format!(r#"{{"type":"session.activity","session_id":"{session_id}"}}"#)
        );
        assert!(sink_rx.try_recv().is_err());
        assert!(control.slot.lock().await.is_none());
    }

    #[tokio::test]
    async fn forwarder_does_not_reclassify_suppressed_output_when_sink_reconnects() {
        let session_id = Uuid::new_v4();
        let control = ForwarderControl::new();
        let mut direct = control.add_direct_sink("test".into()).await;
        let (outbox_tx, outbox_rx) = mpsc::channel(WORKER_OUTPUT_QUEUE_DEPTH);
        let forwarder = tokio::spawn(run_forwarder(session_id, outbox_rx, control.clone()));

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
        let session_id = Uuid::new_v4();
        let control = ForwarderControl::new();
        let (mirror_tx, mut mirror_rx) = mpsc::channel(64);
        control.set_sink(mirror_tx).await;
        tokio::spawn(async move { while mirror_rx.recv().await.is_some() {} });
        let (outbox_tx, outbox_rx) = mpsc::channel(WORKER_OUTPUT_QUEUE_DEPTH);
        let forwarder = tokio::spawn(run_forwarder(session_id, outbox_rx, control.clone()));

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
        let session_id = Uuid::new_v4();
        let control = ForwarderControl::new();
        let (mirror_tx, mut mirror_rx) = mpsc::channel(DIRECT_SINK_QUEUE_DEPTH * 4);
        control.set_sink(mirror_tx).await;
        tokio::spawn(async move { while mirror_rx.recv().await.is_some() {} });
        let mut direct = control.add_direct_sink("stalled".into()).await;
        let (outbox_tx, outbox_rx) = mpsc::channel(DIRECT_SINK_QUEUE_DEPTH + 1);
        let forwarder = tokio::spawn(run_forwarder(session_id, outbox_rx, control.clone()));

        for _ in 0..=DIRECT_SINK_QUEUE_DEPTH {
            outbox_tx.send(source_output(&control, b"x")).await.unwrap();
        }
        tokio::time::timeout(Duration::from_secs(1), direct.disconnected.changed())
            .await
            .expect("stalled viewer was not disconnected")
            .expect("disconnect watch closed");
        assert!(*direct.disconnected.borrow());
        let gap_offset = direct.gap_offset.load(Ordering::Acquire);
        assert!(gap_offset > 0);
        assert!(gap_offset <= control.source_offset());
        assert!(direct.receiver.len() <= DIRECT_SINK_QUEUE_DEPTH);
        assert_eq!(control.direct_sink_offset("stalled").await, None);

        let origin = direct.source_origin;
        let healed = control.add_direct_sink_from("stalled".into(), origin).await;
        assert_eq!(healed.source_origin, origin);
        assert_eq!(
            control
                .direct_sink_anchor("stalled", control.source_offset())
                .await,
            Some(control.source_offset().saturating_sub(origin))
        );

        drop(outbox_tx);
        forwarder.await.unwrap();
    }

    #[tokio::test]
    async fn producer_decision_precedes_enqueue_and_later_suppression() {
        let session_id = Uuid::new_v4();
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
        let forwarder = tokio::spawn(run_forwarder(session_id, outbox_rx, control));
        drop(outbox_tx);

        assert_eq!(
            sink_rx.recv().await.unwrap().as_str(),
            format!(r#"{{"type":"session.activity","session_id":"{session_id}"}}"#)
        );
        assert!(sink_rx.try_recv().is_err());
        forwarder.await.unwrap();
    }

    #[tokio::test]
    async fn suppression_preceding_producer_decision_stays_with_queued_output() {
        let session_id = Uuid::new_v4();
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
        let forwarder = tokio::spawn(run_forwarder(session_id, outbox_rx, control));
        drop(outbox_tx);

        forwarder.await.unwrap();
        assert!(sink_rx.try_recv().is_err());
    }
}
