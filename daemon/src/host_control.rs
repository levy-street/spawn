//! End-to-end host file protocol carried by `spawn.host.ctl`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, Mutex, Notify, Semaphore};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;

use crate::host_desktop::DesktopAction;
use crate::host_direct::{decode_write_chunk, HostDirectChannel};
use crate::host_files::{
    HostFileOperations, HostFileService, PendingWrite, WriteSessionGuard, MAX_FILE_BYTES,
    STREAM_CHUNK_BYTES,
};
use crate::host_signal::HostConnectedSignal;

const PROTOCOL: &str = "spawn.host.ctl";
const VERSION: u16 = 1;
const MAX_FRAME_BYTES: usize = 16 * 1024;
const MAX_ID_BYTES: usize = 128;
/// Finished request ids a channel still refuses to see again (see
/// `RequestWindow`).
const RECENT_REQUESTS: usize = 4096;
/// Request ids one channel may hold in flight at once. Only a client that
/// never waits for its answers gets near it; reaching it closes the channel.
const MAX_IN_FLIGHT_REQUESTS: usize = 4096;
/// Cancels kept for a request that has not arrived yet, oldest forgotten
/// first.
const MAX_EARLY_CANCELS: usize = 4096;
const MAX_NORMAL_QUEUE: usize = 64;
const MAX_FAST_QUEUE: usize = 64;
const MAX_LONG_TASKS: usize = 8;
const STREAM_WINDOW_CHUNKS: u64 = 8;
const STREAM_ACK_TIMEOUT: Duration = Duration::from_secs(15);
const WRITE_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_WRITE_STREAMS: usize = 8;
const MAX_STREAM_TOMBSTONES: usize = 4096;
const MAX_ACTIVE_PUBLICATIONS: usize = 128;
/// v2 writes one channel carries at once. Each may have a full window of
/// chunks queued behind the others, and two windows of the largest size
/// (32 frames) leave the 64-frame normal queue room for everything else; a
/// device opens a consumer channel per transfer.
const MAX_IMPORT_STREAMS: usize = 2;

#[derive(Default)]
struct ArrivalArbiter {
    next_order: u64,
    cancel_cutoffs: HashMap<String, (u64, Instant)>,
}

impl ArrivalArbiter {
    fn stamp(&mut self, value: &Value) -> Option<u64> {
        self.prune();
        let order = self.next_order;
        self.next_order = self.next_order.checked_add(1)?;
        if value
            .as_object()
            .and_then(|object| object.get("type"))
            .and_then(Value::as_str)
            == Some("stream.cancel")
        {
            let stream_id = valid_id(value.as_object()?.get("stream_id"))?;
            if !self.cancel_cutoffs.contains_key(stream_id)
                && self.cancel_cutoffs.len() >= MAX_STREAM_TOMBSTONES
            {
                return None;
            }
            self.cancel_cutoffs
                .entry(stream_id.to_string())
                .and_modify(|(cutoff, expires_at)| {
                    *cutoff = (*cutoff).min(order);
                    *expires_at = tombstone_deadline();
                })
                .or_insert_with(|| (order, tombstone_deadline()));
        }
        Some(order)
    }

    fn cutoff(&mut self, stream_id: &str) -> Option<u64> {
        self.prune();
        self.cancel_cutoffs
            .get(stream_id)
            .map(|(cutoff, _)| *cutoff)
    }

    fn prune(&mut self) {
        let now = Instant::now();
        self.cancel_cutoffs
            .retain(|_, (_, expires_at)| *expires_at > now);
    }
}

/// A bounded set of ids that forgets its oldest member first.
struct RecencySet {
    capacity: usize,
    next_stamp: u64,
    members: HashMap<String, u64>,
    /// Insertion order. An entry whose stamp no longer matches `members` was
    /// removed or re-inserted since, and is skipped when it reaches the front.
    order: VecDeque<(u64, String)>,
}

impl RecencySet {
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            next_stamp: 0,
            members: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    fn contains(&self, id: &str) -> bool {
        self.members.contains_key(id)
    }

    fn insert(&mut self, id: &str) {
        let stamp = self.next_stamp;
        self.next_stamp = self.next_stamp.wrapping_add(1);
        self.members.insert(id.to_string(), stamp);
        self.order.push_back((stamp, id.to_string()));
        while self.members.len() > self.capacity {
            let Some((stamp, id)) = self.order.pop_front() else {
                break;
            };
            if self.members.get(&id) == Some(&stamp) {
                self.members.remove(&id);
            }
        }
        // Removals leave stale entries behind; never let them outgrow the
        // live ones.
        if self.order.len() > self.capacity.saturating_mul(2) {
            let members = &self.members;
            self.order
                .retain(|(stamp, id)| members.get(id) == Some(stamp));
        }
    }

    fn remove(&mut self, id: &str) -> bool {
        self.members.remove(id).is_some()
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.members.len()
    }
}

/// The request ids a channel refuses to see again: every request still in
/// flight, plus the `RECENT_REQUESTS` most recently finished. A duplicate
/// inside that window closes the channel, as any reuse always has; an id
/// older than the window is forgotten, so a host view that stays open for
/// days is not closed at its 4,097th request (daemons before this one were).
struct RequestWindow {
    in_flight: HashSet<String>,
    finished: RecencySet,
    /// A `cancel` rides the fast queue and can overtake its request; it is
    /// kept here until the request arrives, finishes, or is forgotten.
    early_cancels: RecencySet,
}

impl Default for RequestWindow {
    fn default() -> Self {
        Self {
            in_flight: HashSet::new(),
            finished: RecencySet::new(RECENT_REQUESTS),
            early_cancels: RecencySet::new(MAX_EARLY_CANCELS),
        }
    }
}

impl RequestWindow {
    /// False for a duplicate, or when too many requests are already in
    /// flight; either closes the channel.
    fn admit(&mut self, id: &str) -> bool {
        if self.in_flight.contains(id)
            || self.finished.contains(id)
            || self.in_flight.len() >= MAX_IN_FLIGHT_REQUESTS
        {
            return false;
        }
        self.in_flight.insert(id.to_string())
    }

    fn finish(&mut self, id: &str) {
        if self.in_flight.remove(id) {
            self.finished.insert(id);
        }
        self.early_cancels.remove(id);
    }

    /// A cancel that found no read or write under its id: either its request
    /// has not reached the operation yet, or it already finished. Only the
    /// first is worth remembering.
    fn note_cancel(&mut self, id: &str) {
        if !self.finished.contains(id) {
            self.early_cancels.insert(id);
        }
    }

    fn take_cancel(&mut self, id: &str) -> bool {
        self.early_cancels.remove(id)
    }
}

/// One admitted request id. Dropping it — when the response is sent, or when
/// the read, write, or preview the request started is over — moves the id
/// from in flight into the window's recent history.
struct RequestTicket {
    id: String,
    window: Arc<StdMutex<RequestWindow>>,
}

impl Drop for RequestTicket {
    fn drop(&mut self) {
        self.window
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .finish(&self.id);
    }
}

struct QueuedFrame {
    arrival_order: u64,
    value: Value,
}

struct ActiveWrite {
    pending: Mutex<Option<PendingWrite>>,
    cancelled: CancellationToken,
    /// The write's `fs.write.begin` stays in flight until the stream is over.
    _request: RequestTicket,
}

struct WriteCleanup {
    stream_id: String,
    slot: Arc<ActiveWrite>,
    cancel_order: Option<u64>,
}

/// One stream v2 write (`conv.import.begin`): taken out of its slot by the
/// one that ends it, so nothing can write through it afterwards.
struct ActiveImport {
    stream: Mutex<Option<crate::host_conversations::ImportStream>>,
    claim: crate::host_conversations::Claim,
    last_chunk: StdMutex<Instant>,
    /// The begin stays in flight until the stream is over.
    _request: RequestTicket,
}

enum CancelledWrite {
    Cancelling {
        cancel_order: u64,
        ready: Arc<Notify>,
        expires_at: Instant,
    },
    Ready {
        cancel_order: u64,
        next_sequence: u64,
        received: u64,
        expected_length: u64,
        expected_sha256: String,
        expires_at: Instant,
    },
}

impl CancelledWrite {
    fn cancel_order(&self) -> u64 {
        match self {
            Self::Cancelling { cancel_order, .. } | Self::Ready { cancel_order, .. } => {
                *cancel_order
            }
        }
    }

    fn expires_at(&self) -> Instant {
        match self {
            Self::Cancelling { expires_at, .. } | Self::Ready { expires_at, .. } => *expires_at,
        }
    }
}

#[derive(Default)]
struct State {
    writes: HashMap<String, Arc<ActiveWrite>>,
    write_requests: HashMap<String, String>,
    cancelled_writes: HashMap<String, CancelledWrite>,
    finished_write_ids: HashMap<String, Instant>,
    reads: HashMap<String, Arc<ReadSignals>>,
    finished_read_ids: HashMap<String, Instant>,
    read_requests: HashMap<String, Arc<AtomicBool>>,
    /// Stream v2 writes carrying a conversation into this host
    /// (`conv.import.begin`), by stream id, and the request each began as.
    imports: HashMap<String, Arc<ActiveImport>>,
    import_requests: HashMap<String, String>,
    /// v2 writes that ended, kept a while: whether the device's own
    /// `stream.cancel` ended it (a chunk it sent before that is dropped),
    /// or anything else did (a later frame on it fails closed).
    ended_imports: HashMap<String, (Instant, bool)>,
    /// Locked on its own, briefly, and never across an await: a request's
    /// ticket finishes from `Drop`. Where it must agree with the maps above
    /// (an early cancel against a read or write starting), this state is
    /// held around it.
    requests: Arc<StdMutex<RequestWindow>>,
}

enum ReadSignal {
    Ack(u64),
    Cancel,
    /// An acknowledgement below one already received: the channel closes,
    /// as on any malformed frame.
    Backwards,
}

/// What a read's device has said since its pump last looked. Cumulative
/// acknowledgements coalesce to the highest, so however fast or often a
/// device sends them — once per chunk, or the same one again — nothing
/// queues, and no pace can fill a queue and close the channel (spike S4,
/// F1). A cancel stays said.
#[derive(Default)]
struct ReadSignals {
    said: StdMutex<Said>,
    changed: Notify,
}

#[derive(Default)]
struct Said {
    /// The highest acknowledgement the pump has not taken yet.
    pending: Option<u64>,
    /// The highest acknowledgement received at all.
    highest: Option<u64>,
    backwards: bool,
    cancelled: bool,
}

impl ReadSignals {
    fn said(&self) -> std::sync::MutexGuard<'_, Said> {
        self.said
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn ack(&self, sequence: u64) {
        {
            let mut said = self.said();
            if said.highest.is_some_and(|highest| sequence < highest) {
                said.backwards = true;
            } else {
                said.highest = Some(sequence);
                said.pending = Some(sequence);
            }
        }
        self.changed.notify_one();
    }

    fn cancel(&self) {
        self.said().cancelled = true;
        self.changed.notify_one();
    }

    /// What was said since the last look, if anything; a cancel first.
    fn take(&self) -> Option<ReadSignal> {
        let mut said = self.said();
        if said.cancelled {
            return Some(ReadSignal::Cancel);
        }
        if said.backwards {
            return Some(ReadSignal::Backwards);
        }
        said.pending.take().map(ReadSignal::Ack)
    }

    /// The next thing said. `notify_one` keeps a wake-up for a pump that is
    /// not waiting yet, so nothing said between a look and the wait is lost.
    async fn next(&self) -> ReadSignal {
        loop {
            if let Some(signal) = self.take() {
                return signal;
            }
            self.changed.notified().await;
        }
    }
}

#[derive(Default)]
struct PublicationState {
    closed: bool,
    next_id: u64,
    active: HashMap<u64, CancellationToken>,
}

#[derive(Default)]
struct PublicationFence {
    state: StdMutex<PublicationState>,
    idle: Notify,
}

struct PublicationPermit {
    id: u64,
    cancelled: CancellationToken,
    fence: Arc<PublicationFence>,
}

impl PublicationFence {
    fn claim(self: &Arc<Self>) -> Option<PublicationPermit> {
        let mut state = self.state.lock().ok()?;
        if state.closed || state.active.len() >= MAX_ACTIVE_PUBLICATIONS {
            return None;
        }
        let id = state.next_id;
        state.next_id = state.next_id.checked_add(1)?;
        let cancelled = CancellationToken::new();
        state.active.insert(id, cancelled.clone());
        Some(PublicationPermit {
            id,
            cancelled,
            fence: Arc::clone(self),
        })
    }

    fn close(&self) {
        let publications = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.closed = true;
            state.active.values().cloned().collect::<Vec<_>>()
        };
        for publication in publications {
            publication.cancel();
        }
    }

    async fn wait_for_idle_until(&self, deadline: tokio::time::Instant) -> bool {
        loop {
            let notified = self.idle.notified();
            let idle = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .active
                .is_empty();
            if idle {
                return true;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return self
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .active
                    .is_empty();
            }
        }
    }
}

impl Drop for PublicationPermit {
    fn drop(&mut self) {
        let idle = {
            let mut state = self
                .fence
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.active.remove(&self.id);
            state.active.is_empty()
        };
        if idle {
            self.fence.idle.notify_waiters();
        }
    }
}

#[derive(Clone)]
struct Context {
    direct: HostDirectChannel,
    files: Arc<HostFileService>,
    /// None when this build or host cannot render previews at all.
    preview: Option<Arc<crate::host_preview::PreviewService>>,
    desktop: Arc<crate::host_desktop::DesktopService>,
    state: Arc<Mutex<State>>,
    long_tasks: Arc<Semaphore>,
    background_tasks: Arc<Mutex<JoinSet<()>>>,
    file_operations: Arc<HostFileOperations>,
    cleanup_tx: mpsc::Sender<WriteCleanup>,
    arrivals: Arc<StdMutex<ArrivalArbiter>>,
    publications: Arc<PublicationFence>,
    closed: Arc<AtomicBool>,
    shutdown: CancellationToken,
    /// Present only on a channel admitted through an authenticated device
    /// pair (`rtc_pair.rs`): which shell each window's processes hang from,
    /// a stop for a window being retired, and the association's bulk gate —
    /// nothing else of the session registry. Device-intent operations are
    /// refused without it (`requires_pair`).
    pair: Option<crate::host_conversations::PairWindows>,
}

/// Effect permission is retired synchronously, before asynchronous channel
/// cleanup. Shared peers keep weak handles so closing one consumer stays local.
pub(crate) struct Lifetime {
    publications: Arc<PublicationFence>,
    status_publication_fence: Arc<StdMutex<()>>,
    closed: Arc<AtomicBool>,
    shutdown: CancellationToken,
}

impl Lifetime {
    pub(crate) fn is_retired(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    pub(crate) fn retire(&self) {
        let _publication = self
            .status_publication_fence
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.closed.store(true, Ordering::Release);
        self.publications.close();
        self.shutdown.cancel();
    }
}

impl Context {
    async fn spawn_session_task<F>(&self, task: F) -> bool
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        if self.closed.load(Ordering::Acquire) || self.shutdown.is_cancelled() {
            return false;
        }
        let mut tasks = self.background_tasks.lock().await;
        if self.closed.load(Ordering::Acquire) || self.shutdown.is_cancelled() {
            return false;
        }
        while tasks.try_join_next().is_some() {}
        tasks.spawn(task);
        true
    }

    fn arrived_after_cancel(&self, stream_id: &str, arrival_order: u64) -> bool {
        match self.arrivals.lock() {
            Ok(mut arrivals) => arrivals
                .cutoff(stream_id)
                .is_some_and(|cutoff| arrival_order > cutoff),
            Err(_) => true,
        }
    }

    fn prune_tombstones(state: &mut State) {
        let now = Instant::now();
        state
            .cancelled_writes
            .retain(|_, tombstone| tombstone.expires_at() > now);
        state
            .finished_write_ids
            .retain(|_, expires_at| *expires_at > now);
        state
            .finished_read_ids
            .retain(|_, expires_at| *expires_at > now);
        state
            .ended_imports
            .retain(|_, (expires_at, _)| *expires_at > now);
    }

    fn remember_finished_read(state: &mut State, stream_id: &str) -> bool {
        Self::prune_tombstones(state);
        if !state.finished_read_ids.contains_key(stream_id)
            && state.finished_read_ids.len() >= MAX_STREAM_TOMBSTONES
        {
            return false;
        }
        state
            .finished_read_ids
            .insert(stream_id.to_string(), tombstone_deadline());
        true
    }

    fn remember_finished_write(state: &mut State, stream_id: &str) -> bool {
        Self::prune_tombstones(state);
        if !state.finished_write_ids.contains_key(stream_id)
            && state.finished_write_ids.len() >= MAX_STREAM_TOMBSTONES
        {
            return false;
        }
        state
            .finished_write_ids
            .insert(stream_id.to_string(), tombstone_deadline());
        true
    }

    async fn send(&self, value: Value) -> bool {
        #[cfg(test)]
        let is_hello = value
            .as_object()
            .and_then(|object| object.get("type"))
            .and_then(Value::as_str)
            == Some("hello");
        let Some(publication) = Arc::clone(&self.publications).claim() else {
            return false;
        };
        #[cfg(test)]
        if is_hello
            && !self
                .files
                .write_lifecycle_test_hooks()
                .pause_open_after_publication_claim(&publication.cancelled)
                .await
        {
            self.files
                .write_lifecycle_test_hooks()
                .notify_publication_send_finished();
            return false;
        }
        let sent = self.direct.publish(value, &publication.cancelled).await;
        #[cfg(test)]
        if is_hello {
            self.files
                .write_lifecycle_test_hooks()
                .notify_publication_send_finished();
        }
        sent
    }

    async fn send_read_chunk(&self, stream_id: &str, sequence: u64, bytes: &[u8]) -> bool {
        let Some(publication) = Arc::clone(&self.publications).claim() else {
            return false;
        };
        self.direct
            .publish_read_chunk(stream_id, sequence, bytes, &publication.cancelled)
            .await
    }

    async fn response(&self, request_id: &str, result: Value) -> bool {
        self.send(json!({
            "version": VERSION,
            "type": "response",
            "request_id": request_id,
            "ok": true,
            "result": result,
        }))
        .await
    }

    async fn error(&self, request_id: &str, code: &str, detail: &str) -> bool {
        self.send(json!({
            "version": VERSION,
            "type": "response",
            "request_id": request_id,
            "ok": false,
            "error": {"code": code, "detail": detail},
        }))
        .await
    }

    async fn stream_error(&self, stream_id: &str, code: &str, detail: &str) -> bool {
        self.send(json!({
            "version": VERSION,
            "type": "stream.error",
            "stream_id": stream_id,
            "error": {"code": code, "detail": detail},
        }))
        .await
    }

    async fn admit_request(&self, request_id: &str) -> Option<RequestTicket> {
        let window = Arc::clone(&self.state.lock().await.requests);
        let admitted = window
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .admit(request_id);
        admitted.then(|| RequestTicket {
            id: request_id.to_string(),
            window,
        })
    }

    /// Whether a cancel already arrived for this request. Taken under the
    /// held `state`, so it cannot pass a cancel that is looking for this
    /// request's read or write.
    fn take_early_cancel(state: &State, request_id: &str) -> bool {
        state
            .requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take_cancel(request_id)
    }

    async fn finish_read(&self, stream_id: &str) -> bool {
        let mut state = self.state.lock().await;
        state.reads.remove(stream_id);
        Self::remember_finished_read(&mut state, stream_id)
    }

    /// `caught_up`: nothing else is waiting in the normal queue behind this
    /// frame, so a v2 write acknowledges what it holds.
    async fn handle_normal(&self, frame: QueuedFrame, caught_up: bool) -> bool {
        if self.closed.load(Ordering::Acquire) || self.shutdown.is_cancelled() {
            return false;
        }
        let QueuedFrame {
            arrival_order,
            value,
        } = frame;
        let Some(object) = value.as_object() else {
            return false;
        };
        if object.get("version").and_then(Value::as_u64) != Some(u64::from(VERSION)) {
            return false;
        }
        match object.get("type").and_then(Value::as_str) {
            Some("request") => self.handle_request(object).await,
            Some("stream.chunk") => {
                self.handle_stream_chunk(object, arrival_order, caught_up)
                    .await
            }
            Some("stream.end") => self.handle_stream_end(object, arrival_order).await,
            _ => false,
        }
    }

    async fn handle_fast(&self, frame: QueuedFrame) -> bool {
        if self.closed.load(Ordering::Acquire) || self.shutdown.is_cancelled() {
            return false;
        }
        let QueuedFrame {
            arrival_order,
            value,
        } = frame;
        let Some(object) = value.as_object() else {
            return false;
        };
        if object.get("version").and_then(Value::as_u64) != Some(u64::from(VERSION)) {
            return false;
        }
        match object.get("type").and_then(Value::as_str) {
            Some("stream.ack") => self.handle_stream_ack(object).await,
            Some("stream.cancel") => self.handle_stream_cancel(object, arrival_order).await,
            Some("cancel") => self.handle_request_cancel(object).await,
            _ => false,
        }
    }

    async fn handle_request(&self, object: &Map<String, Value>) -> bool {
        let Some(request_id) = valid_id(object.get("request_id")) else {
            return false;
        };
        // Held to the end of this arm; an operation that outlives its
        // response takes it along.
        let Some(ticket) = self.admit_request(request_id).await else {
            return false;
        };
        let Some(operation) = object.get("operation").and_then(Value::as_str) else {
            return false;
        };
        let payload = object.get("payload").and_then(Value::as_object);
        if requires_pair(operation) && self.pair.is_none() {
            return self
                .error(
                    request_id,
                    "pair_required",
                    "this operation needs an authenticated device connection",
                )
                .await;
        }
        match operation {
            "ping" => self.response(request_id, json!({"pong": true})).await,
            "fs.home" => {
                self.response(request_id, json!({"home_dir": self.files.home_dir()}))
                    .await
            }
            "fs.list" => {
                let path = payload_string(payload, "path").unwrap_or("~");
                let cursor = payload_u64(payload, "cursor").unwrap_or(0);
                let Ok(cursor) = usize::try_from(cursor) else {
                    return self
                        .error(request_id, "invalid_cursor", "cursor is too large")
                        .await;
                };
                match self
                    .files
                    .list_in_session(path, cursor, Arc::clone(&self.file_operations))
                    .await
                {
                    Ok(mut page) => loop {
                        let Ok(result) = serde_json::to_value(&page) else {
                            return false;
                        };
                        let envelope = json!({
                            "version": VERSION,
                            "type": "response",
                            "request_id": request_id,
                            "ok": true,
                            "result": result,
                        });
                        if envelope.to_string().len() <= MAX_FRAME_BYTES {
                            break self.send(envelope).await;
                        }
                        if page.entries.len() <= 1 {
                            break self
                                .error(
                                    request_id,
                                    "entry_too_large",
                                    "directory entry exceeds the control frame limit",
                                )
                                .await;
                        }
                        page.entries.pop();
                        page.next_cursor = Some(cursor.saturating_add(page.entries.len()));
                    },
                    Err(error) => self.error(request_id, error.code, &error.detail).await,
                }
            }
            "fs.stat" => {
                let Some(path) = payload_string(payload, "path") else {
                    return self
                        .error(request_id, "invalid_request", "path is required")
                        .await;
                };
                match self
                    .files
                    .stat_in_session(path, Arc::clone(&self.file_operations))
                    .await
                {
                    Ok(stat) => match serde_json::to_value(&stat) {
                        Ok(mut result) => {
                            // Name-only classification: `fs.stat` never opens
                            // the file, so there are no bytes to sniff and no
                            // evidence on which to grant `open_allowed`. The
                            // type is a hint for choosing an icon, nothing more.
                            if let Some(object) = result.as_object_mut() {
                                let guess = crate::host_mime::classify_by_extension(
                                    std::ffi::OsStr::new(&stat.name),
                                );
                                object
                                    .insert("content_type".into(), Value::from(guess.content_type));
                                object.insert(
                                    "content_type_source".into(),
                                    Value::from(guess.source),
                                );
                                object.insert(
                                    "preview_kind".into(),
                                    Value::from(guess.preview.as_wire()),
                                );
                            }
                            self.response(request_id, result).await
                        }
                        Err(_) => false,
                    },
                    Err(error) => self.error(request_id, error.code, &error.detail).await,
                }
            }
            "fs.mkdir" => {
                let Some(path) = payload_string(payload, "path") else {
                    return self
                        .error(request_id, "invalid_request", "path is required")
                        .await;
                };
                match self
                    .files
                    .mkdir_in_session(path, Arc::clone(&self.file_operations))
                    .await
                {
                    Ok(path) => self.response(request_id, json!({"path": path})).await,
                    Err(error) => self.error(request_id, error.code, &error.detail).await,
                }
            }
            "fs.rename" => {
                let (Some(path), Some(name)) = (
                    payload_string(payload, "path"),
                    payload_string(payload, "name"),
                ) else {
                    return self
                        .error(request_id, "invalid_request", "path and name are required")
                        .await;
                };
                let overwrite = payload_bool(payload, "overwrite").unwrap_or(false);
                match self
                    .files
                    .rename_in_session(path, name, overwrite, Arc::clone(&self.file_operations))
                    .await
                {
                    Ok(path) => self.response(request_id, json!({"path": path})).await,
                    Err(error) => self.error(request_id, error.code, &error.detail).await,
                }
            }
            "fs.remove" => {
                let Some(path) = payload_string(payload, "path") else {
                    return self
                        .error(request_id, "invalid_request", "path is required")
                        .await;
                };
                let recursive = payload_bool(payload, "recursive").unwrap_or(false);
                match self
                    .files
                    .remove_in_session(path, recursive, Arc::clone(&self.file_operations))
                    .await
                {
                    Ok(path) => self.response(request_id, json!({"path": path})).await,
                    Err(error) => self.error(request_id, error.code, &error.detail).await,
                }
            }
            "fs.read" => self.begin_read(request_id, payload, ticket).await,
            "fs.read.range" => self.begin_range_read(request_id, payload, ticket).await,
            "fs.preview" => self.begin_preview(request_id, payload, ticket).await,
            // Exact capacity, straight down the DataChannel. This is the
            // whole point of putting it here rather than on the heartbeat:
            // the browser gets real numbers and the control plane gets a
            // five-level bucket every thirty seconds (see `host_metrics`).
            // Cheap and synchronous — one sysinfo refresh, rate-limited
            // internally — so it answers on the normal queue like `ping`.
            "host.metrics" => match crate::host_metrics::sampler().sample() {
                Some(sample) => {
                    let spec = crate::host_metrics::sampler().spec();
                    self.response(request_id, json!({"sample": sample, "spec": spec}))
                        .await
                }
                None => {
                    self.error(
                        request_id,
                        "telemetry_disabled",
                        "this host does not report capacity",
                    )
                    .await
                }
            },
            "desktop.reveal" => {
                self.desktop_action(request_id, payload, DesktopAction::Reveal)
                    .await
            }
            "desktop.open" => {
                self.desktop_action(request_id, payload, DesktopAction::Open)
                    .await
            }
            "fs.write.begin" => self.begin_write(request_id, payload, ticket).await,
            // Where an agent left its own record of this window's
            // conversation (`host_transcripts`). Locate only: the device
            // reads what it names with `fs.read`, under the same root and
            // the same no-follow rule as every other read.
            "agent.transcripts" => {
                let Some(agent_kind) = payload_string(payload, "agent_kind") else {
                    return self
                        .error(request_id, "invalid_request", "agent_kind is required")
                        .await;
                };
                let query = crate::host_transcripts::TranscriptQuery {
                    agent_kind: agent_kind.to_string(),
                    conversation_id: payload_string(payload, "conversation_id").map(str::to_string),
                    cwd: payload_string(payload, "cwd").map(str::to_string),
                };
                match crate::host_transcripts::locate_in_session(
                    &self.files,
                    query,
                    Arc::clone(&self.file_operations),
                )
                .await
                {
                    Ok(mut report) => loop {
                        let Ok(result) = serde_json::to_value(&report) else {
                            return false;
                        };
                        let envelope = json!({
                            "version": VERSION,
                            "type": "response",
                            "request_id": request_id,
                            "ok": true,
                            "result": result,
                        });
                        if envelope.to_string().len() <= MAX_FRAME_BYTES {
                            break self.send(envelope).await;
                        }
                        // Long paths can outgrow the frame; the newest
                        // answers are kept, like a directory page.
                        if report.transcripts.len() <= 1 {
                            break self
                                .error(
                                    request_id,
                                    "entry_too_large",
                                    "transcript path exceeds the control frame limit",
                                )
                                .await;
                        }
                        report.transcripts.pop();
                        report.truncated = true;
                    },
                    Err(error) => self.error(request_id, error.code, &error.detail).await,
                }
            }
            crate::host_conv::INSPECT_OP if crate::host_conv::SUPPORTED => {
                self.inspect_conversation(request_id, payload).await
            }
            carried
                if crate::host_conversations::SUPPORTED
                    && crate::host_conversations::is_carrier_op(carried) =>
            {
                self.carry(request_id, carried, payload, ticket).await
            }
            _ => {
                self.error(
                    request_id,
                    "unsupported_operation",
                    "operation is not supported",
                )
                .await
            }
        }
    }

    /// Which conversation a window is in, read from its own processes and
    /// the agent's live-session registry (`host_conv`). Read-only; the walk
    /// runs off the control loop, under this channel's operation accounting.
    async fn inspect_conversation(
        &self,
        request_id: &str,
        payload: Option<&Map<String, Value>>,
    ) -> bool {
        let Some(windows) = self.pair.clone() else {
            return self
                .error(
                    request_id,
                    "pair_required",
                    "this operation needs an authenticated device connection",
                )
                .await;
        };
        let Some(session_id) = payload_string(payload, "session_id").and_then(|id| {
            Uuid::parse_str(id)
                .ok()
                .filter(|uuid| uuid.to_string() == id)
        }) else {
            return self
                .error(
                    request_id,
                    "invalid_request",
                    "session_id must be a session UUID",
                )
                .await;
        };
        let Some(shell_pid) = windows.shell_pid(session_id) else {
            return self
                .error(
                    request_id,
                    "session_not_found",
                    "no window with this id is running on this host",
                )
                .await;
        };
        let inspected = self
            .files
            .run_blocking(
                Arc::clone(&self.file_operations),
                crate::host_files::HostOperationKind::List,
                move |_| Ok(crate::host_conv::inspect_window(shell_pid)),
            )
            .await;
        match inspected {
            Ok(inspection) => match serde_json::to_value(&inspection) {
                Ok(result) => self.response(request_id, result).await,
                Err(_) => false,
            },
            Err(error) => self.error(request_id, error.code, &error.detail).await,
        }
    }

    /// The conversation carrier's operations (`host_conversations`), on a
    /// pair-admitted channel only.
    async fn carry(
        &self,
        request_id: &str,
        operation: &str,
        payload: Option<&Map<String, Value>>,
        ticket: RequestTicket,
    ) -> bool {
        use crate::host_conversations as conv;
        let Some(carrier) = self.carrier() else {
            return self
                .error(
                    request_id,
                    "pair_required",
                    "this operation needs an authenticated device connection",
                )
                .await;
        };
        let answer = match operation {
            conv::EXPORT_OP => {
                return self
                    .begin_export(request_id, payload, ticket, carrier)
                    .await
            }
            conv::IMPORT_BEGIN_OP => {
                return self
                    .begin_import(request_id, payload, ticket, carrier)
                    .await
            }
            conv::PROBE_OP => match conv::ProbeRequest::parse(payload) {
                Ok(request) => carrier.probe(request).await,
                Err(error) => Err(error),
            },
            conv::IMPORT_STATUS_OP => match conv::parse_transfer(payload) {
                Ok(transfer) => carrier
                    .import_status(transfer)
                    .await
                    .map(|status| json!(status)),
                Err(error) => Err(error),
            },
            conv::IMPORT_CANCEL_OP => match conv::parse_transfer(payload) {
                Ok(transfer) => carrier
                    .cancel_import(transfer)
                    .await
                    .map(|status| json!(status)),
                Err(error) => Err(error),
            },
            conv::RETIRE_COMMIT_OP => match conv::RetireCommit::parse(payload) {
                Ok(request) => carrier.retire_commit(request).await,
                Err(error) => Err(error),
            },
            conv::RETIRE_ABORT_OP => match conv::parse_transfer(payload) {
                Ok(transfer) => carrier.retire_abort(transfer).await,
                Err(error) => Err(error),
            },
            conv::TRANSFERS_OP => carrier.transfers().await,
            _ => {
                return self
                    .error(
                        request_id,
                        "unsupported_operation",
                        "operation is not supported",
                    )
                    .await
            }
        };
        match answer {
            Ok(result) => self.fitted_response(request_id, result).await,
            Err(error) => self.error(request_id, error.code, &error.detail).await,
        }
    }

    fn carrier(&self) -> Option<crate::host_conversations::Carrier> {
        let pair = self.pair.clone()?;
        Some(crate::host_conversations::Carrier::new(
            (*self.files).clone(),
            Arc::clone(&self.file_operations),
            pair,
        ))
    }

    /// A response that fits one control frame: a list too long for one (the
    /// copies a probe found, the transfers a host holds) is cut from its
    /// end, and the answer says it was truncated.
    async fn fitted_response(&self, request_id: &str, mut result: Value) -> bool {
        loop {
            let envelope = json!({
                "version": VERSION,
                "type": "response",
                "request_id": request_id,
                "ok": true,
                "result": result,
            });
            if envelope.to_string().len() <= MAX_FRAME_BYTES {
                return self.send(envelope).await;
            }
            let Some(object) = result.as_object_mut() else {
                return false;
            };
            let longest = ["duplicates", "outgoing", "incoming"]
                .into_iter()
                .filter_map(|key| {
                    let len = object.get(key).and_then(Value::as_array).map(Vec::len)?;
                    (len > 0).then_some((len, key))
                })
                .max();
            let Some((_, key)) = longest else {
                return self
                    .error(
                        request_id,
                        "entry_too_large",
                        "the answer exceeds the control frame limit",
                    )
                    .await;
            };
            if let Some(list) = object.get_mut(key).and_then(Value::as_array_mut) {
                list.pop();
            }
            let flag = if key == "duplicates" {
                "duplicates_truncated"
            } else {
                "truncated"
            };
            object.insert(flag.into(), Value::Bool(true));
        }
    }

    /// `conv.export`: prepared off the control loop (a retire stops a window
    /// and moves files), then streamed as a v2 read paced on the
    /// association's bulk gate.
    async fn begin_export(
        &self,
        request_id: &str,
        payload: Option<&Map<String, Value>>,
        ticket: RequestTicket,
        carrier: crate::host_conversations::Carrier,
    ) -> bool {
        let request = match crate::host_conversations::ExportRequest::parse(payload) {
            Ok(request) => request,
            Err(error) => return self.error(request_id, error.code, &error.detail).await,
        };
        let Ok(permit) = Arc::clone(&self.long_tasks).try_acquire_owned() else {
            return self
                .error(
                    request_id,
                    "too_many_tasks",
                    "too many long-running host operations",
                )
                .await;
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let mut state = self.state.lock().await;
            if Self::take_early_cancel(&state, request_id) {
                drop(state);
                return self
                    .error(request_id, "cancelled", "the export was cancelled")
                    .await;
            }
            state
                .read_requests
                .insert(request_id.to_string(), Arc::clone(&cancelled));
        }
        let context = self.clone();
        let request_id = request_id.to_string();
        let cleanup_request_id = request_id.clone();
        let task = async move {
            let _permit = permit;
            let _ticket = ticket;
            let sent = context
                .send_export(&request_id, request, carrier, cancelled)
                .await;
            context.state.lock().await.read_requests.remove(&request_id);
            if !sent && !context.closed.load(Ordering::Acquire) {
                close_with_deadline_later(context.direct.transport());
            }
        };
        if self.spawn_session_task(task).await {
            true
        } else {
            self.state
                .lock()
                .await
                .read_requests
                .remove(&cleanup_request_id);
            false
        }
    }

    async fn send_export(
        &self,
        request_id: &str,
        request: crate::host_conversations::ExportRequest,
        carrier: crate::host_conversations::Carrier,
        cancelled: Arc<AtomicBool>,
    ) -> bool {
        let Some(pair) = self.pair.clone() else {
            return false;
        };
        let stream_id = Uuid::new_v4().to_string();
        let window = request.stream.window;
        let digest_at_start = request.stream.digest == crate::host_stream::DigestAt::Start;
        let from = request.from_sequence;
        let transfer = request.transfer_id;
        let prepared = match carrier.prepare_export(request, &stream_id).await {
            Ok(prepared) => prepared,
            Err(error) => return self.error(request_id, error.code, &error.detail).await,
        };
        let crate::host_conversations::PreparedExport {
            source,
            sha256,
            entries,
            skipped,
            stopped,
            claim,
        } = prepared;
        if cancelled.load(Ordering::Acquire) {
            claim.release().await;
            return self
                .error(request_id, "cancelled", "the export was cancelled")
                .await;
        }
        let signals = Arc::new(ReadSignals::default());
        self.state
            .lock()
            .await
            .reads
            .insert(stream_id.clone(), Arc::clone(&signals));
        let length = source.length();
        if !self
            .response(
                request_id,
                json!({
                    "stream_id": stream_id,
                    "transfer_id": transfer.to_string(),
                    // Forwarded by the device in the target's begin: a
                    // target imports only what a retire carried.
                    "mode": "retire",
                    "length": length,
                    "sha256": if digest_at_start { Some(sha256.as_str()) } else { None },
                    "window": window,
                    "next_sequence": from,
                    "entries": entries,
                    "skipped": skipped,
                    "stopped": stopped,
                }),
            )
            .await
        {
            claim.release().await;
            let _ = self.finish_read(&stream_id).await;
            return false;
        }
        self.pump_export(
            &stream_id,
            source,
            &sha256,
            window,
            from,
            &claim,
            pair.bulk(),
            &signals,
            &cancelled,
        )
        .await
    }

    /// Stream v2's read side: chunks numbered from the transfer's first
    /// byte, at most `window` unacknowledged, each through the bulk gate;
    /// a stream another one superseded is told so and stops.
    #[allow(clippy::too_many_arguments)]
    async fn pump_export(
        &self,
        stream_id: &str,
        source: crate::host_conversations::BundleSource,
        sha256: &str,
        window: u64,
        from: u64,
        claim: &crate::host_conversations::Claim,
        bulk: &Arc<crate::host_stream::BulkGate>,
        signals: &ReadSignals,
        cancelled: &AtomicBool,
    ) -> bool {
        let channel = self.direct.transport();
        let _enrolled = bulk.enroll(&channel).await;
        let length = source.length();
        let count = crate::host_stream::chunk_count(length);
        let token = claim.token().clone();
        let mut source = Some(source);
        let mut next = from;
        let mut acknowledged = from;
        let ended = |reason: Option<&'static str>| match reason {
            Some("superseded") => ("superseded", "a resumed export carries this transfer now"),
            Some("transfer_committed") => ("transfer_committed", "the transfer was committed"),
            Some("transfer_aborted") => ("transfer_aborted", "the transfer was aborted"),
            _ => ("cancelled", "the export was ended"),
        };
        loop {
            if cancelled.load(Ordering::Acquire) {
                claim.release().await;
                return self.finish_read(stream_id).await;
            }
            if token.is_cancelled() {
                let (code, detail) = ended(claim.reason());
                if !self.finish_read(stream_id).await {
                    return false;
                }
                return self.stream_error(stream_id, code, detail).await;
            }
            while let Some(signal) = signals.take() {
                match signal {
                    ReadSignal::Ack(value)
                        if crate::host_stream::valid_ack(acknowledged, next, value) =>
                    {
                        acknowledged = value;
                    }
                    ReadSignal::Cancel => {
                        claim.release().await;
                        return self.finish_read(stream_id).await;
                    }
                    ReadSignal::Ack(_) | ReadSignal::Backwards => {
                        claim.release().await;
                        let _ = self.finish_read(stream_id).await;
                        return false;
                    }
                }
            }
            if next >= count {
                break;
            }
            if crate::host_stream::may_send(window, acknowledged, next) {
                let batch = (acknowledged + window - next).min(count - next);
                let Some(taken) = source.take() else {
                    return false;
                };
                let read = self
                    .files
                    .run_blocking(
                        Arc::clone(&self.file_operations),
                        crate::host_files::HostOperationKind::Conversation,
                        move |_| {
                            let mut taken = taken;
                            let chunks = taken.read_chunks(batch);
                            Ok((taken, chunks))
                        },
                    )
                    .await;
                let chunks = match read {
                    Ok((back, Ok(chunks))) => {
                        source = Some(back);
                        chunks
                    }
                    Ok((_, Err(error))) | Err(error) => {
                        claim.release().await;
                        if !self.finish_read(stream_id).await {
                            return false;
                        }
                        return self
                            .stream_error(stream_id, error.code, &error.detail)
                            .await;
                    }
                };
                for chunk in chunks {
                    let sequence = next;
                    let sent = bulk
                        .send(&token, || self.send_read_chunk(stream_id, sequence, &chunk))
                        .await;
                    if !sent {
                        if token.is_cancelled() {
                            break;
                        }
                        claim.release().await;
                        let _ = self.finish_read(stream_id).await;
                        return false;
                    }
                    next += 1;
                }
                continue;
            }
            let signal = tokio::select! {
                _ = token.cancelled() => continue,
                signal = tokio::time::timeout(stream_ack_timeout(), signals.next()) => signal,
            };
            match signal {
                Ok(ReadSignal::Ack(value))
                    if crate::host_stream::valid_ack(acknowledged, next, value) =>
                {
                    acknowledged = value;
                }
                Ok(ReadSignal::Cancel) => {
                    claim.release().await;
                    return self.finish_read(stream_id).await;
                }
                Ok(ReadSignal::Ack(_) | ReadSignal::Backwards) => {
                    claim.release().await;
                    let _ = self.finish_read(stream_id).await;
                    return false;
                }
                Err(_) => {
                    claim.release().await;
                    if !self.finish_read(stream_id).await {
                        return false;
                    }
                    return self
                        .stream_error(
                            stream_id,
                            "stream_timeout",
                            "stream acknowledgement timed out",
                        )
                        .await;
                }
            }
        }
        let sent = self
            .send(json!({
                "version": VERSION,
                "type": "stream.end",
                "stream_id": stream_id,
                "length": length,
                "sha256": sha256,
            }))
            .await;
        claim.release().await;
        self.finish_read(stream_id).await && sent
    }

    /// `conv.import.begin`: a v2 write stream into this host's staging, or
    /// the staged transfer resumed under a new stream.
    async fn begin_import(
        &self,
        request_id: &str,
        payload: Option<&Map<String, Value>>,
        ticket: RequestTicket,
        carrier: crate::host_conversations::Carrier,
    ) -> bool {
        let request = match crate::host_conversations::ImportRequest::parse(payload) {
            Ok(request) => request,
            Err(error) => return self.error(request_id, error.code, &error.detail).await,
        };
        {
            let state = self.state.lock().await;
            if Self::take_early_cancel(&state, request_id) {
                drop(state);
                return self
                    .error(request_id, "cancelled", "the import was cancelled")
                    .await;
            }
            if state.imports.len() >= MAX_IMPORT_STREAMS {
                drop(state);
                return self
                    .error(
                        request_id,
                        "too_many_streams",
                        "this channel already carries as many imports as it can; open another",
                    )
                    .await;
            }
        }
        let stream_id = Uuid::new_v4().to_string();
        let opened = match carrier.begin_import(request, &stream_id).await {
            Ok(opened) => opened,
            Err(error) => return self.error(request_id, error.code, &error.detail).await,
        };
        let claim = opened.stream.claim();
        let window = opened.stream.window;
        let next_sequence = opened.stream.next_sequence;
        let active = Arc::new(ActiveImport {
            stream: Mutex::new(Some(opened.stream)),
            claim: claim.clone(),
            last_chunk: StdMutex::new(Instant::now()),
            _request: ticket,
        });
        {
            let mut state = self.state.lock().await;
            if self.closed.load(Ordering::Acquire) || self.shutdown.is_cancelled() {
                drop(state);
                claim.release().await;
                return true;
            }
            state
                .import_requests
                .insert(request_id.to_string(), stream_id.clone());
            state.imports.insert(stream_id.clone(), active);
        }
        // Someone else may end this stream — a resumed begin on any
        // channel, or the transfer's cancel — and the device hears why.
        let watcher = self.clone();
        let watched = stream_id.clone();
        let watch_claim = claim.clone();
        let _ = self
            .spawn_session_task(async move {
                tokio::select! {
                    _ = watcher.shutdown.cancelled() => {}
                    _ = watch_claim.token().cancelled() => {
                        if let Some(code @ ("superseded" | "cancelled")) = watch_claim.reason() {
                            // A cancelled transfer's chunks already on their
                            // way are dropped; a superseded stream's frames
                            // fail closed, as an unknown stream's would.
                            let quiet = code == "cancelled";
                            if watcher.end_import(&watched, quiet).await.is_some() {
                                let _ = watcher
                                    .stream_error(&watched, code, "the transfer was ended elsewhere")
                                    .await;
                            }
                        }
                    }
                }
            })
            .await;
        self.response(
            request_id,
            json!({
                "stream_id": stream_id,
                "window": window,
                "next_sequence": next_sequence,
                "received": opened.received,
            }),
        )
        .await
    }

    /// Take an import stream out of service: off the channel's map, its
    /// id remembered, and the stream itself handed back (once).
    async fn end_import(
        &self,
        stream_id: &str,
        device_cancelled: bool,
    ) -> Option<crate::host_conversations::ImportStream> {
        let active = {
            let mut state = self.state.lock().await;
            let active = state.imports.remove(stream_id)?;
            state
                .import_requests
                .retain(|_, stream| stream.as_str() != stream_id);
            Self::prune_tombstones(&mut state);
            state.ended_imports.insert(
                stream_id.to_string(),
                (tombstone_deadline(), device_cancelled),
            );
            active
        };
        let stream = active.stream.lock().await.take();
        stream
    }

    /// A chunk for a v2 import: `None` when the stream is no import at all.
    async fn handle_import_chunk(
        &self,
        stream_id: &str,
        sequence: u64,
        bytes: &[u8],
        caught_up: bool,
    ) -> Option<bool> {
        let active = {
            let mut state = self.state.lock().await;
            Self::prune_tombstones(&mut state);
            match state.imports.get(stream_id) {
                Some(active) => Arc::clone(active),
                // A chunk the device sent before its own cancel is dropped;
                // one for a stream ended any other way fails closed.
                None => return state.ended_imports.get(stream_id).map(|(_, own)| *own),
            }
        };
        let carrier = self.carrier()?;
        *active
            .last_chunk
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Instant::now();
        let mut slot = active.stream.lock().await;
        let stream = slot.as_mut()?;
        match stream
            .take_chunk(&carrier, sequence, bytes, caught_up)
            .await
        {
            Ok(taken) => {
                drop(slot);
                match taken.ack {
                    Some(ack) => Some(
                        self.send(json!({
                            "version": VERSION,
                            "type": "stream.ack",
                            "stream_id": stream_id,
                            "sequence": ack,
                        }))
                        .await,
                    ),
                    None => Some(true),
                }
            }
            Err(error) => {
                let taken = slot.take();
                drop(slot);
                if let Some(stream) = taken {
                    stream.end().await;
                }
                let cancelled = error.code == "transfer_cancelled";
                let _ = self.end_import(stream_id, cancelled).await;
                if error.code == "superseded" {
                    // Refused as a frame for an unknown stream would be.
                    return Some(false);
                }
                if cancelled {
                    // Told so once, by the cancel's own `stream.error`.
                    return Some(true);
                }
                Some(
                    self.stream_error(stream_id, error.code, &error.detail)
                        .await,
                )
            }
        }
    }

    /// `stream.end` for a v2 import: verified and committed off the control
    /// loop, answered with `stream.committed` or `stream.error`.
    async fn handle_import_end(
        &self,
        stream_id: &str,
        length: Option<u64>,
        sha256: Option<&str>,
    ) -> Option<bool> {
        {
            let mut state = self.state.lock().await;
            Self::prune_tombstones(&mut state);
            if !state.imports.contains_key(stream_id) {
                return state.ended_imports.get(stream_id).map(|(_, own)| *own);
            }
        }
        let carrier = self.carrier()?;
        let Some(stream) = self.end_import(stream_id, false).await else {
            return Some(false);
        };
        let context = self.clone();
        let stream_id = stream_id.to_string();
        let sha256 = sha256.map(str::to_string);
        let task = async move {
            let declared = stream.length;
            let digest = sha256.clone();
            let sent = match stream.finish(&carrier, length, sha256.as_deref()).await {
                Ok(result) => {
                    let mut frame = json!({
                        "version": VERSION,
                        "type": "stream.committed",
                        "stream_id": stream_id,
                        "length": declared,
                        "sha256": digest,
                        "result": result,
                    });
                    if frame.to_string().len() > MAX_FRAME_BYTES {
                        // Paths too long for a frame: the device asks
                        // `conv.probe` for them.
                        frame["result"] = json!({"transfer_id": frame["result"]["transfer_id"]});
                    }
                    context.send(frame).await
                }
                Err(error) => {
                    context
                        .stream_error(&stream_id, error.code, &error.detail)
                        .await
                }
            };
            if !sent && !context.closed.load(Ordering::Acquire) {
                close_with_deadline_later(context.direct.transport());
            }
        };
        Some(self.spawn_session_task(task).await)
    }

    async fn begin_read(
        &self,
        request_id: &str,
        payload: Option<&Map<String, Value>>,
        ticket: RequestTicket,
    ) -> bool {
        let Some(path) = payload_string(payload, "path") else {
            return self
                .error(request_id, "invalid_request", "path is required")
                .await;
        };
        let Ok(permit) = Arc::clone(&self.long_tasks).try_acquire_owned() else {
            return self
                .error(
                    request_id,
                    "too_many_tasks",
                    "too many long-running host operations",
                )
                .await;
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let mut state = self.state.lock().await;
            if Self::take_early_cancel(&state, request_id) {
                drop(state);
                return self
                    .error(request_id, "cancelled", "file read was cancelled")
                    .await;
            }
            state
                .read_requests
                .insert(request_id.to_string(), Arc::clone(&cancelled));
        }
        let context = self.clone();
        let request_id = request_id.to_string();
        let cleanup_request_id = request_id.clone();
        let path = path.to_string();
        let task = async move {
            let _permit = permit;
            let _ticket = ticket;
            let sent = context.send_read(&request_id, &path, cancelled).await;
            context.state.lock().await.read_requests.remove(&request_id);
            if !sent && !context.closed.load(Ordering::Acquire) {
                close_with_deadline_later(context.direct.transport());
            }
        };
        if self.spawn_session_task(task).await {
            true
        } else {
            self.state
                .lock()
                .await
                .read_requests
                .remove(&cleanup_request_id);
            false
        }
    }

    async fn begin_range_read(
        &self,
        request_id: &str,
        payload: Option<&Map<String, Value>>,
        ticket: RequestTicket,
    ) -> bool {
        let Some(path) = payload_string(payload, "path") else {
            return self
                .error(request_id, "invalid_request", "path is required")
                .await;
        };
        let Some(length) = payload_u64(payload, "length") else {
            return self
                .error(request_id, "invalid_request", "length is required")
                .await;
        };
        let offset = payload_u64(payload, "offset").unwrap_or(0);
        if length == 0 || length > crate::host_files::MAX_RANGE_BYTES {
            return self
                .error(
                    request_id,
                    "range_too_large",
                    "range length must be between 1 byte and 16 MiB",
                )
                .await;
        }
        let if_version = payload_string(payload, "if_version").map(str::to_string);
        let Ok(permit) = Arc::clone(&self.long_tasks).try_acquire_owned() else {
            return self
                .error(
                    request_id,
                    "too_many_tasks",
                    "too many long-running host operations",
                )
                .await;
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let mut state = self.state.lock().await;
            if Self::take_early_cancel(&state, request_id) {
                drop(state);
                return self
                    .error(request_id, "cancelled", "file read was cancelled")
                    .await;
            }
            state
                .read_requests
                .insert(request_id.to_string(), Arc::clone(&cancelled));
        }
        let context = self.clone();
        let request_id = request_id.to_string();
        let cleanup_request_id = request_id.clone();
        let path = path.to_string();
        let task = async move {
            let _permit = permit;
            let _ticket = ticket;
            let sent = context
                .send_range_read(&request_id, &path, offset, length, if_version, cancelled)
                .await;
            context.state.lock().await.read_requests.remove(&request_id);
            if !sent && !context.closed.load(Ordering::Acquire) {
                close_with_deadline_later(context.direct.transport());
            }
        };
        if self.spawn_session_task(task).await {
            true
        } else {
            self.state
                .lock()
                .await
                .read_requests
                .remove(&cleanup_request_id);
            false
        }
    }

    async fn send_range_read(
        &self,
        request_id: &str,
        path: &str,
        offset: u64,
        length: u64,
        if_version: Option<String>,
        cancelled: Arc<AtomicBool>,
    ) -> bool {
        use tokio::io::AsyncReadExt;

        let stream = match self
            .files
            .open_range_read_in_session(
                path,
                offset,
                length,
                if_version,
                Arc::clone(&cancelled),
                Arc::clone(&self.file_operations),
            )
            .await
        {
            Ok(stream) => stream,
            Err(error) => return self.error(request_id, error.code, &error.detail).await,
        };
        if cancelled.load(Ordering::Acquire) {
            return self
                .error(request_id, "cancelled", "file read was cancelled")
                .await;
        }
        let stream_id = Uuid::new_v4().to_string();
        let signals = Arc::new(ReadSignals::default());
        self.state
            .lock()
            .await
            .reads
            .insert(stream_id.clone(), Arc::clone(&signals));
        if !self
            .response(
                request_id,
                json!({
                    "stream_id": stream_id,
                    "path": stream.stat.path,
                    "name": stream.stat.name,
                    "offset": stream.offset,
                    "length": stream.length,
                    "file_size": stream.stat.size,
                    "modified_at": stream.stat.modified_at,
                    "version": stream.version,
                    "sha256": stream.sha256,
                    "content_type": stream.content_type,
                    "content_type_source": stream.content_type_source,
                    "preview_kind": stream.preview_kind,
                    "open_allowed": stream.open_allowed,
                    "eof": stream.eof,
                }),
            )
            .await
        {
            let _ = self.finish_read(&stream_id).await;
            return false;
        }
        // Bounded at the reader, so the pump cannot run past the slice the
        // digest was computed over even if the file grew underneath us.
        let mut reader = stream.file.take(stream.length);
        let expected = stream.sha256.clone();
        self.pump_stream(
            &stream_id,
            &mut reader,
            &signals,
            stream.length,
            &expected,
            &cancelled,
        )
        .await
    }

    async fn begin_preview(
        &self,
        request_id: &str,
        payload: Option<&Map<String, Value>>,
        ticket: RequestTicket,
    ) -> bool {
        let Some(path) = payload_string(payload, "path") else {
            return self
                .error(request_id, "invalid_request", "path is required")
                .await;
        };
        let Some(max_pixels) = payload_u64(payload, "max_pixels") else {
            return self
                .error(request_id, "invalid_request", "max_pixels is required")
                .await;
        };
        let max_pixels = u32::try_from(max_pixels).unwrap_or(u32::MAX);
        if !crate::host_preview::is_supported_size(max_pixels) {
            return self
                .error(request_id, "invalid_request", "unsupported preview size")
                .await;
        }
        let Some(preview) = self.preview.clone() else {
            return self
                .error(
                    request_id,
                    "preview_unsupported",
                    "this host cannot render previews",
                )
                .await;
        };
        let if_version = payload_string(payload, "if_version").map(str::to_string);
        let context = self.clone();
        let request_id = request_id.to_string();
        let path = path.to_string();
        let task = async move {
            // No long-task permit is taken here. The render holds its own much
            // narrower semaphore, and streaming an in-memory PNG is not a
            // filesystem operation — taking a long-task permit around the slow
            // part is exactly the inversion that would let queued previews
            // starve reads and writes.
            let _ticket = ticket;
            let sent = context
                .send_preview(&request_id, &preview, &path, max_pixels, if_version)
                .await;
            if !sent && !context.closed.load(Ordering::Acquire) {
                close_with_deadline_later(context.direct.transport());
            }
        };
        self.spawn_session_task(task).await
    }

    async fn send_preview(
        &self,
        request_id: &str,
        preview: &crate::host_preview::PreviewService,
        path: &str,
        max_pixels: u32,
        if_version: Option<String>,
    ) -> bool {
        let image = match preview
            .render(
                &self.files,
                path,
                max_pixels,
                if_version,
                Arc::clone(&self.file_operations),
            )
            .await
        {
            Ok(image) => image,
            Err(error) => return self.error(request_id, error.code, &error.detail).await,
        };
        let digest = format!("{:x}", Sha256::digest(&image.bytes));
        let stream_id = Uuid::new_v4().to_string();
        let signals = Arc::new(ReadSignals::default());
        self.state
            .lock()
            .await
            .reads
            .insert(stream_id.clone(), Arc::clone(&signals));
        if !self
            .response(
                request_id,
                json!({
                    "stream_id": stream_id,
                    "path": image.path,
                    "name": image.name,
                    "length": image.bytes.len(),
                    "sha256": digest,
                    "content_type": image.content_type,
                    "source_content_type": image.source_content_type,
                    "width": image.width,
                    "height": image.height,
                    "version": image.version,
                }),
            )
            .await
        {
            let _ = self.finish_read(&stream_id).await;
            return false;
        }
        let length = image.bytes.len() as u64;
        let mut reader = std::io::Cursor::new(image.bytes);
        let cancelled = AtomicBool::new(false);
        self.pump_stream(
            &stream_id,
            &mut reader,
            &signals,
            length,
            &digest,
            &cancelled,
        )
        .await
    }

    async fn desktop_action(
        &self,
        request_id: &str,
        payload: Option<&Map<String, Value>>,
        action: DesktopAction,
    ) -> bool {
        if !crate::host_desktop::DESKTOP_SUPPORTED {
            return self
                .error(
                    request_id,
                    "desktop_unavailable",
                    "this host cannot open files on a desktop",
                )
                .await;
        }
        // The payload is a path and nothing else. There is no application,
        // argument or flag field to read, so nothing a client sends can name a
        // program to run.
        let Some(path) = payload_string(payload, "path") else {
            return self
                .error(request_id, "invalid_request", "path is required")
                .await;
        };
        let result = match action {
            DesktopAction::Reveal => {
                self.desktop
                    .reveal(&self.files, path, Arc::clone(&self.file_operations))
                    .await
            }
            DesktopAction::Open => {
                self.desktop
                    .open(&self.files, path, Arc::clone(&self.file_operations))
                    .await
            }
        };
        match result {
            Ok(resolved) => {
                // "dispatched", not "the application opened" — the honest
                // contract for handing something to LaunchServices.
                self.response(
                    request_id,
                    json!({ "path": resolved, "action": action.as_wire() }),
                )
                .await
            }
            Err(error) => self.error(request_id, error.code, &error.detail).await,
        }
    }

    async fn begin_write(
        &self,
        request_id: &str,
        payload: Option<&Map<String, Value>>,
        ticket: RequestTicket,
    ) -> bool {
        let (Some(dir), Some(name), Some(length), Some(sha256)) = (
            payload_string(payload, "dir"),
            payload_string(payload, "name"),
            payload_u64(payload, "length"),
            payload_string(payload, "sha256"),
        ) else {
            return self
                .error(
                    request_id,
                    "invalid_request",
                    "write declaration is incomplete",
                )
                .await;
        };
        let overwrite = payload_bool(payload, "overwrite").unwrap_or(false);
        {
            let state = self.state.lock().await;
            if Self::take_early_cancel(&state, request_id) {
                drop(state);
                return self
                    .error(request_id, "cancelled", "file write was cancelled")
                    .await;
            }
            if state.writes.len() >= MAX_WRITE_STREAMS {
                drop(state);
                return self
                    .error(
                        request_id,
                        "too_many_streams",
                        "too many pending write streams",
                    )
                    .await;
            }
        }
        match self
            .files
            .begin_write_cancellable(
                request_id.to_string(),
                dir,
                name,
                length,
                sha256,
                overwrite,
                self.shutdown.clone(),
                Arc::clone(&self.file_operations),
            )
            .await
        {
            Ok(write) => {
                let stream_id = write.stream_id.clone();
                let slot = Arc::new(ActiveWrite {
                    pending: Mutex::new(Some(write)),
                    cancelled: CancellationToken::new(),
                    _request: ticket,
                });
                let mut state = self.state.lock().await;
                if self.closed.load(Ordering::Acquire) || self.shutdown.is_cancelled() {
                    drop(state);
                    if let Some(write) = slot.pending.lock().await.take() {
                        self.file_operations.cleanup_write(write).await;
                    }
                    return true;
                }
                if Self::take_early_cancel(&state, request_id) {
                    drop(state);
                    if let Some(write) = slot.pending.lock().await.take() {
                        self.file_operations.cleanup_write(write).await;
                    }
                    return self
                        .error(request_id, "cancelled", "file write was cancelled")
                        .await;
                }
                if state.writes.len() >= MAX_WRITE_STREAMS {
                    drop(state);
                    if let Some(write) = slot.pending.lock().await.take() {
                        self.file_operations.cleanup_write(write).await;
                    }
                    return self
                        .error(
                            request_id,
                            "too_many_streams",
                            "too many pending write streams",
                        )
                        .await;
                }
                state
                    .write_requests
                    .insert(request_id.to_string(), stream_id.clone());
                state.writes.insert(stream_id.clone(), slot);
                drop(state);
                self.response(request_id, json!({"stream_id": stream_id}))
                    .await
            }
            Err(error) => self.error(request_id, error.code, &error.detail).await,
        }
    }

    async fn process_write_cleanup(&self, cleanup: WriteCleanup) -> bool {
        let Some(write) = cleanup.slot.pending.lock().await.take() else {
            return false;
        };
        if let Some(cancel_order) = cleanup.cancel_order {
            let ready = {
                let mut state = self.state.lock().await;
                state.write_requests.remove(&write.request_id);
                let ready = match state.cancelled_writes.get(&cleanup.stream_id) {
                    Some(CancelledWrite::Cancelling { ready, .. }) => Arc::clone(ready),
                    _ => return false,
                };
                state.cancelled_writes.insert(
                    cleanup.stream_id,
                    CancelledWrite::Ready {
                        cancel_order,
                        next_sequence: write.next_sequence,
                        received: write.received,
                        expected_length: write.expected_length,
                        expected_sha256: write.expected_sha256.clone(),
                        expires_at: tombstone_deadline(),
                    },
                );
                ready
            };
            ready.notify_one();
        } else {
            self.state
                .lock()
                .await
                .write_requests
                .remove(&write.request_id);
        }
        self.file_operations.cleanup_write(write).await;
        true
    }

    async fn reap_stale_writes(&self) -> bool {
        let streams = self
            .state
            .lock()
            .await
            .writes
            .iter()
            .map(|(stream_id, slot)| (stream_id.clone(), Arc::clone(slot)))
            .collect::<Vec<_>>();
        for (stream_id, slot) in streams {
            let stale = slot
                .pending
                .lock()
                .await
                .as_ref()
                .is_some_and(|write| write.idle_for() >= WRITE_IDLE_TIMEOUT);
            if !stale {
                continue;
            }
            let removed = {
                let mut state = self.state.lock().await;
                let same = state
                    .writes
                    .get(&stream_id)
                    .is_some_and(|current| Arc::ptr_eq(current, &slot));
                if !same || !Self::remember_finished_write(&mut state, &stream_id) {
                    None
                } else {
                    state.writes.remove(&stream_id)
                }
            };
            let Some(slot) = removed else {
                continue;
            };
            slot.cancelled.cancel();
            if !self
                .process_write_cleanup(WriteCleanup {
                    stream_id: stream_id.clone(),
                    slot,
                    cancel_order: None,
                })
                .await
                || !self
                    .stream_error(&stream_id, "stream_timeout", "file write timed out")
                    .await
            {
                return false;
            }
        }
        let idle_imports = self
            .state
            .lock()
            .await
            .imports
            .iter()
            .filter(|(_, active)| {
                active
                    .last_chunk
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .elapsed()
                    >= WRITE_IDLE_TIMEOUT
            })
            .map(|(stream_id, _)| stream_id.clone())
            .collect::<Vec<_>>();
        for stream_id in idle_imports {
            // The stream ends; the staged transfer stays, for a resume.
            if let Some(stream) = self.end_import(&stream_id, false).await {
                stream.end().await;
                if !self
                    .stream_error(&stream_id, "stream_timeout", "the import stream went idle")
                    .await
                {
                    return false;
                }
            }
        }
        let mut state = self.state.lock().await;
        Self::prune_tombstones(&mut state);
        if let Ok(mut arrivals) = self.arrivals.lock() {
            arrivals.prune();
        } else {
            return false;
        }
        true
    }

    async fn run_write_reaper(self, mut cleanup_rx: mpsc::Receiver<WriteCleanup>) {
        loop {
            tokio::select! {
                biased;
                cleanup = cleanup_rx.recv() => {
                    let Some(cleanup) = cleanup else { break; };
                    if !self.process_write_cleanup(cleanup).await {
                        close_with_deadline_later(self.direct.transport());
                        break;
                    }
                }
                _ = self.shutdown.cancelled() => {
                    while let Ok(cleanup) = cleanup_rx.try_recv() {
                        let _ = self.process_write_cleanup(cleanup).await;
                    }
                    break;
                }
                _ = tokio::time::sleep(write_reaper_interval()) => {
                    if !self.reap_stale_writes().await {
                        close_with_deadline_later(self.direct.transport());
                        break;
                    }
                }
            }
        }
    }

    /// Stream a source out under the ack window, verifying as it goes.
    ///
    /// Every stream-producing operation funnels through here. The window, the
    /// running digest, the cancel handling and the `file_changed` check are the
    /// most integrity-sensitive code in this file, so they exist exactly once
    /// rather than once per operation.
    async fn pump_stream<R>(
        &self,
        stream_id: &str,
        reader: &mut R,
        signals: &ReadSignals,
        expected_length: u64,
        expected_sha256: &str,
        cancelled: &AtomicBool,
    ) -> bool
    where
        R: tokio::io::AsyncRead + Unpin,
    {
        let mut sequence = 0_u64;
        let mut acknowledged = 0_u64;
        let mut length = 0_u64;
        let mut actual = Sha256::new();
        let mut buffer = vec![0_u8; STREAM_CHUNK_BYTES];
        loop {
            if cancelled.load(Ordering::Acquire) {
                return self.finish_read(stream_id).await;
            }
            while let Some(signal) = signals.take() {
                match signal {
                    ReadSignal::Ack(value) if value >= acknowledged && value <= sequence => {
                        acknowledged = value;
                    }
                    ReadSignal::Cancel => {
                        return self.finish_read(stream_id).await;
                    }
                    ReadSignal::Ack(_) | ReadSignal::Backwards => {
                        let _ = self.finish_read(stream_id).await;
                        return false;
                    }
                }
            }
            let read = match reader.read(&mut buffer).await {
                Ok(read) => read,
                Err(error) => {
                    if !self.finish_read(stream_id).await {
                        return false;
                    }
                    return self
                        .stream_error(stream_id, "io_error", &error.to_string())
                        .await;
                }
            };
            if read == 0 {
                break;
            }
            length = length.saturating_add(read as u64);
            actual.update(&buffer[..read]);
            if !self
                .send_read_chunk(stream_id, sequence, &buffer[..read])
                .await
            {
                return false;
            }
            sequence = sequence.saturating_add(1);
            while sequence.saturating_sub(acknowledged) >= STREAM_WINDOW_CHUNKS {
                let signal = tokio::time::timeout(stream_ack_timeout(), signals.next()).await;
                match signal {
                    Ok(ReadSignal::Ack(value)) if value >= acknowledged && value <= sequence => {
                        acknowledged = value;
                    }
                    Ok(ReadSignal::Cancel) => {
                        return self.finish_read(stream_id).await;
                    }
                    Ok(ReadSignal::Ack(_) | ReadSignal::Backwards) => {
                        let _ = self.finish_read(stream_id).await;
                        return false;
                    }
                    Err(_) => {
                        if !self.finish_read(stream_id).await {
                            return false;
                        }
                        return self
                            .stream_error(
                                stream_id,
                                "stream_timeout",
                                "stream acknowledgement timed out",
                            )
                            .await;
                    }
                }
                if cancelled.load(Ordering::Acquire) {
                    return self.finish_read(stream_id).await;
                }
            }
        }
        let digest = format!("{:x}", actual.finalize());
        if length != expected_length || digest != expected_sha256 {
            if !self.finish_read(stream_id).await {
                return false;
            }
            return self
                .stream_error(stream_id, "file_changed", "file changed during transfer")
                .await;
        }
        let sent = self
            .send(json!({
                "version": VERSION,
                "type": "stream.end",
                "stream_id": stream_id,
                "length": length,
                "sha256": digest,
            }))
            .await;
        self.finish_read(stream_id).await && sent
    }

    async fn send_read(&self, request_id: &str, path: &str, cancelled: Arc<AtomicBool>) -> bool {
        let stream = match self
            .files
            .open_read_in_session(
                path,
                Arc::clone(&cancelled),
                Arc::clone(&self.file_operations),
            )
            .await
        {
            Ok(stream) => stream,
            Err(error) => return self.error(request_id, error.code, &error.detail).await,
        };
        if cancelled.load(Ordering::Acquire) {
            return self
                .error(request_id, "cancelled", "file read was cancelled")
                .await;
        }
        let stream_id = Uuid::new_v4().to_string();
        let signals = Arc::new(ReadSignals::default());
        self.state
            .lock()
            .await
            .reads
            .insert(stream_id.clone(), Arc::clone(&signals));
        let stat = &stream.stat;
        if !self
            .response(
                request_id,
                json!({
                    "stream_id": stream_id,
                    "path": stat.path,
                    "name": stat.name,
                    "length": stat.size,
                    "sha256": stream.sha256,
                }),
            )
            .await
        {
            let _ = self.finish_read(&stream_id).await;
            return false;
        }
        // Bounded at the reader, as the range path is: a file that grows
        // after it was hashed streams the bytes the declaration names and
        // no more, rather than everything appended until the pump notices.
        let length = stream.stat.size;
        let mut reader = stream.file.take(length);
        self.pump_stream(
            &stream_id,
            &mut reader,
            &signals,
            length,
            &stream.sha256,
            &cancelled,
        )
        .await
    }

    async fn handle_late_write_chunk(
        &self,
        stream_id: &str,
        arrival_order: u64,
        sequence: u64,
        byte_len: usize,
    ) -> Option<bool> {
        loop {
            let wait = {
                let mut state = self.state.lock().await;
                Self::prune_tombstones(&mut state);
                if state.finished_write_ids.contains_key(stream_id) {
                    return Some(false);
                }
                let tombstone = state.cancelled_writes.get_mut(stream_id)?;
                if arrival_order >= tombstone.cancel_order() {
                    return Some(false);
                }
                match tombstone {
                    CancelledWrite::Cancelling { ready, .. } => Some(Arc::clone(ready)),
                    CancelledWrite::Ready {
                        next_sequence,
                        received,
                        expected_length,
                        ..
                    } => {
                        let next_received = received.saturating_add(byte_len as u64);
                        if sequence != *next_sequence || next_received > *expected_length {
                            return Some(false);
                        }
                        *next_sequence = next_sequence.saturating_add(1);
                        *received = next_received;
                        return Some(true);
                    }
                }
            };
            let Some(ready) = wait else {
                return Some(false);
            };
            ready.notified().await;
        }
    }

    async fn handle_late_write_end(
        &self,
        stream_id: &str,
        arrival_order: u64,
        length: Option<u64>,
        sha256: Option<&str>,
    ) -> Option<bool> {
        loop {
            let wait = {
                let mut state = self.state.lock().await;
                Self::prune_tombstones(&mut state);
                if state.finished_write_ids.contains_key(stream_id) {
                    return Some(false);
                }
                let tombstone = state.cancelled_writes.get(stream_id)?;
                if arrival_order >= tombstone.cancel_order() {
                    return Some(false);
                }
                match tombstone {
                    CancelledWrite::Cancelling { ready, .. } => Some(Arc::clone(ready)),
                    CancelledWrite::Ready {
                        received,
                        expected_length,
                        expected_sha256,
                        ..
                    } => {
                        let valid = length == Some(*expected_length)
                            && *received == *expected_length
                            && sha256 == Some(expected_sha256.as_str());
                        if valid {
                            state.cancelled_writes.remove(stream_id);
                            if !Self::remember_finished_write(&mut state, stream_id) {
                                return Some(false);
                            }
                        }
                        return Some(valid);
                    }
                }
            };
            let Some(ready) = wait else {
                return Some(false);
            };
            ready.notified().await;
        }
    }

    async fn handle_stream_chunk(
        &self,
        object: &Map<String, Value>,
        arrival_order: u64,
        caught_up: bool,
    ) -> bool {
        let Some(chunk) = decode_write_chunk(object, MAX_ID_BYTES, STREAM_CHUNK_BYTES) else {
            return false;
        };
        let stream_id = chunk.stream_id.as_str();
        let sequence = chunk.sequence;
        let bytes = chunk.bytes;
        if self.arrived_after_cancel(stream_id, arrival_order) {
            return false;
        }
        if let Some(handled) = self
            .handle_import_chunk(stream_id, sequence, &bytes, caught_up)
            .await
        {
            return handled;
        }
        if let Some(handled) = self
            .handle_late_write_chunk(stream_id, arrival_order, sequence, bytes.len())
            .await
        {
            return handled;
        }
        let slot = self.state.lock().await.writes.get(stream_id).cloned();
        let Some(slot) = slot else {
            return self
                .handle_late_write_chunk(stream_id, arrival_order, sequence, bytes.len())
                .await
                .unwrap_or(false);
        };
        let mut write_guard = tokio::select! {
            _ = slot.cancelled.cancelled() => {
                return self
                    .handle_late_write_chunk(stream_id, arrival_order, sequence, bytes.len())
                    .await
                    .unwrap_or(false);
            }
            write_guard = slot.pending.lock() => write_guard,
        };
        if slot.cancelled.is_cancelled() {
            drop(write_guard);
            return self
                .handle_late_write_chunk(stream_id, arrival_order, sequence, bytes.len())
                .await
                .unwrap_or(false);
        }
        let Some(active) = write_guard.as_mut() else {
            drop(write_guard);
            return self
                .handle_late_write_chunk(stream_id, arrival_order, sequence, bytes.len())
                .await
                .unwrap_or(false);
        };
        #[cfg(test)]
        if let Some(delay_ms) = object.get("test_delay_ms").and_then(Value::as_u64) {
            self.files
                .write_lifecycle_test_hooks()
                .notify_write_delay_entered();
            tokio::select! {
                _ = slot.cancelled.cancelled() => {
                    drop(write_guard);
                    return self
                        .handle_late_write_chunk(stream_id, arrival_order, sequence, bytes.len())
                        .await
                        .unwrap_or(false);
                }
                _ = tokio::time::sleep(Duration::from_millis(delay_ms.min(1_000))) => {}
            }
        }
        let appended = tokio::select! {
            _ = slot.cancelled.cancelled() => {
                drop(write_guard);
                return self
                    .handle_late_write_chunk(stream_id, arrival_order, sequence, bytes.len())
                    .await
                    .unwrap_or(false);
            }
            appended = active.append(sequence, &bytes) => appended,
        };
        if let Err(error) = appended {
            let write = write_guard.take().expect("active write exists");
            drop(write_guard);
            let mut state = self.state.lock().await;
            state.writes.remove(stream_id);
            state.write_requests.remove(&write.request_id);
            let remembered = Self::remember_finished_write(&mut state, stream_id);
            drop(state);
            self.file_operations.cleanup_write(write).await;
            if !remembered {
                return false;
            }
            return self
                .stream_error(stream_id, error.code, &error.detail)
                .await;
        }
        true
    }

    async fn handle_stream_end(&self, object: &Map<String, Value>, arrival_order: u64) -> bool {
        let Some(stream_id) = valid_id(object.get("stream_id")) else {
            return false;
        };
        if self.arrived_after_cancel(stream_id, arrival_order) {
            return false;
        }
        let length = object.get("length").and_then(Value::as_u64);
        let sha256 = object.get("sha256").and_then(Value::as_str);
        if let Some(handled) = self.handle_import_end(stream_id, length, sha256).await {
            return handled;
        }
        if let Some(handled) = self
            .handle_late_write_end(stream_id, arrival_order, length, sha256)
            .await
        {
            return handled;
        }
        let slot = {
            let mut state = self.state.lock().await;
            if state.writes.contains_key(stream_id)
                && Self::remember_finished_write(&mut state, stream_id)
            {
                state.writes.get(stream_id).cloned()
            } else {
                None
            }
        };
        let Some(slot) = slot else {
            return self
                .handle_late_write_end(stream_id, arrival_order, length, sha256)
                .await
                .unwrap_or(false);
        };
        let write = slot.pending.lock().await.take();
        let Some(write) = write else {
            return false;
        };
        self.state
            .lock()
            .await
            .write_requests
            .remove(&write.request_id);
        let sent = if length != Some(write.expected_length)
            || sha256 != Some(write.expected_sha256.as_str())
        {
            self.file_operations.cleanup_write(write).await;
            self.stream_error(
                stream_id,
                "declaration_mismatch",
                "stream end does not match its write declaration",
            )
            .await
        } else {
            let request_id = write.request_id.clone();
            let guard = WriteSessionGuard {
                cancelled: slot.cancelled.clone(),
                closed: Arc::clone(&self.closed),
                operations: Arc::clone(&self.file_operations),
            };
            match write.finish_guarded(guard).await {
                Ok(path) => {
                    self.send(json!({
                        "version": VERSION,
                        "type": "stream.committed",
                        "stream_id": stream_id,
                        "request_id": request_id,
                        "path": path,
                    }))
                    .await
                }
                Err(error) => {
                    self.stream_error(stream_id, error.code, &error.detail)
                        .await
                }
            }
        };
        let mut state = self.state.lock().await;
        if state
            .writes
            .get(stream_id)
            .is_some_and(|current| Arc::ptr_eq(current, &slot))
        {
            state.writes.remove(stream_id);
        }
        sent
    }

    async fn handle_stream_ack(&self, object: &Map<String, Value>) -> bool {
        let (Some(stream_id), Some(sequence)) = (
            valid_id(object.get("stream_id")),
            object.get("sequence").and_then(Value::as_u64),
        ) else {
            return false;
        };
        let (signals, finished) = {
            let state = self.state.lock().await;
            (
                state.reads.get(stream_id).cloned(),
                state.finished_read_ids.contains_key(stream_id),
            )
        };
        let Some(signals) = signals else {
            return finished;
        };
        signals.ack(sequence);
        true
    }

    async fn handle_stream_cancel(&self, object: &Map<String, Value>, arrival_order: u64) -> bool {
        let Some(stream_id) = valid_id(object.get("stream_id")) else {
            return false;
        };
        // A `stream.cancel` ends a v2 stream, not its transfer: the staged
        // bytes stay receiving, for a resume.
        if let Some(stream) = self.end_import(stream_id, true).await {
            stream.end().await;
            return true;
        }
        if self
            .state
            .lock()
            .await
            .ended_imports
            .contains_key(stream_id)
        {
            return true;
        }
        let (write, read, known) = {
            let mut state = self.state.lock().await;
            Self::prune_tombstones(&mut state);
            let known = state.cancelled_writes.contains_key(stream_id)
                || state.finished_write_ids.contains_key(stream_id)
                || state.finished_read_ids.contains_key(stream_id);
            let write = if known {
                None
            } else if state.writes.contains_key(stream_id) {
                if state.cancelled_writes.len() >= MAX_STREAM_TOMBSTONES {
                    return false;
                }
                let ready = Arc::new(Notify::new());
                state.cancelled_writes.insert(
                    stream_id.to_string(),
                    CancelledWrite::Cancelling {
                        cancel_order: arrival_order,
                        ready,
                        expires_at: tombstone_deadline(),
                    },
                );
                state.writes.remove(stream_id)
            } else {
                None
            };
            let read = state.reads.remove(stream_id);
            if read.is_some() && !Self::remember_finished_read(&mut state, stream_id) {
                return false;
            }
            (write, read, known)
        };
        if let Some(slot) = write {
            slot.cancelled.cancel();
            return self
                .cleanup_tx
                .try_send(WriteCleanup {
                    stream_id: stream_id.to_string(),
                    slot,
                    cancel_order: Some(arrival_order),
                })
                .is_ok();
        }
        if let Some(read) = read {
            read.cancel();
            return true;
        }
        known
    }

    async fn handle_request_cancel(&self, object: &Map<String, Value>) -> bool {
        let Some(request_id) = valid_id(object.get("request_id")) else {
            return false;
        };
        let import = self
            .state
            .lock()
            .await
            .import_requests
            .get(request_id)
            .cloned();
        if let Some(stream_id) = import {
            if let Some(stream) = self.end_import(&stream_id, true).await {
                stream.end().await;
            }
            return true;
        }
        let (read, write) = {
            let mut state = self.state.lock().await;
            let read = state.read_requests.get(request_id).cloned();
            let write = state
                .write_requests
                .remove(request_id)
                .and_then(|stream_id| state.writes.remove(&stream_id));
            if read.is_none() && write.is_none() {
                state
                    .requests
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .note_cancel(request_id);
            }
            (read, write)
        };
        if let Some(read) = read {
            read.store(true, Ordering::Release);
        }
        if let Some(write) = write {
            write.cancelled.cancel();
            if self
                .cleanup_tx
                .try_send(WriteCleanup {
                    stream_id: String::new(),
                    slot: write,
                    cancel_order: None,
                })
                .is_err()
            {
                return false;
            }
        }
        true
    }

    async fn abort_all(&self, deadline: tokio::time::Instant) {
        self.publications.close();
        self.closed.store(true, Ordering::Release);
        self.shutdown.cancel();
        #[cfg(test)]
        self.files
            .write_lifecycle_test_hooks()
            .notify_shutdown_started();
        let (reads, writes) = match tokio::time::timeout_at(deadline, self.state.lock()).await {
            Ok(mut state) => {
                let reads = state
                    .reads
                    .drain()
                    .map(|(_, read)| read)
                    .collect::<Vec<_>>();
                for request in state.read_requests.drain().map(|(_, request)| request) {
                    request.store(true, Ordering::Release);
                }
                state.write_requests.clear();
                state.import_requests.clear();
                for (_, import) in state.imports.drain() {
                    let claim = import.claim.clone();
                    // Released off the lock; a transfer's lock may be held
                    // by a commit for a while.
                    tokio::spawn(async move { claim.release().await });
                }
                let writes = state
                    .writes
                    .drain()
                    .map(|(_, write)| write)
                    .collect::<Vec<_>>();
                (reads, writes)
            }
            Err(_) => (Vec::new(), Vec::new()),
        };
        for read in reads {
            read.cancel();
        }
        for write in &writes {
            write.cancelled.cancel();
        }
        // The session registry owns cleanup capabilities independently of
        // PendingWrite futures and blocking commit closures. This removes
        // every still-pending temporary before waiting for task ownership;
        // a commit that already linearized has atomically claimed its temp.
        self.file_operations
            .cleanup_temporaries_until(deadline)
            .await;
        for write in writes {
            if let Ok(mut pending) = tokio::time::timeout_at(deadline, write.pending.lock()).await {
                if let Some(write) = pending.take() {
                    self.file_operations.schedule_write_cleanup(write);
                }
            }
        }
        // Do not hold the registry mutex while awaiting children. Task
        // creation rechecks shutdown after taking the mutex, so no task can
        // be published into the replacement set once shutdown starts.
        let tasks = match tokio::time::timeout_at(deadline, self.background_tasks.lock()).await {
            Ok(mut registered) => Some(std::mem::take(&mut *registered)),
            Err(_) => None,
        };
        let drain_tasks = async move {
            if let Some(mut tasks) = tasks {
                while !tasks.is_empty() {
                    match tokio::time::timeout_at(deadline, tasks.join_next()).await {
                        Ok(Some(_)) => {}
                        Ok(None) => return,
                        Err(_) => {
                            tasks.abort_all();
                            return;
                        }
                    }
                }
            }
        };
        let drain_operations = self.file_operations.wait_for_idle_until(deadline);
        let drain_publications = self.publications.wait_for_idle_until(deadline);
        let _ = tokio::join!(drain_tasks, drain_operations, drain_publications);
        #[cfg(test)]
        self.files
            .write_lifecycle_test_hooks()
            .notify_shutdown_returned();
    }
}

fn valid_id(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|id| {
        !id.is_empty()
            && id.len() <= MAX_ID_BYTES
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    })
}

fn payload_string<'a>(payload: Option<&'a Map<String, Value>>, key: &str) -> Option<&'a str> {
    payload?
        .get(key)?
        .as_str()
        .filter(|value| value.len() <= 4096)
}

fn payload_u64(payload: Option<&Map<String, Value>>, key: &str) -> Option<u64> {
    payload?.get(key)?.as_u64()
}

fn payload_bool(payload: Option<&Map<String, Value>>, key: &str) -> Option<bool> {
    payload?.get(key)?.as_bool()
}

/// Operation families that carry a device's intent for this host: its
/// conversations now; launch contexts, agent accounts, screens and boxes as
/// they arrive. A legacy (protocol 1) host channel is admitted on the
/// server's binding alone, with no authenticated device behind it
/// (`rtc.rs`, `pair: None`), so every family here is refused on it whatever
/// a client sends. A new family is added here before its first operation.
const DEVICE_INTENT_FAMILIES: [&str; 5] = [
    "conv.",
    "session.launch.",
    "agent.accounts.",
    "screen.",
    "box.",
];

fn requires_pair(operation: &str) -> bool {
    DEVICE_INTENT_FAMILIES
        .iter()
        .any(|family| operation.starts_with(family))
}

pub(crate) fn install(
    dc: Arc<RTCDataChannel>,
    connected_signal: HostConnectedSignal,
    files_override: Option<Arc<HostFileService>>,
    pair: Option<crate::host_conversations::PairWindows>,
) -> Arc<Lifetime> {
    // Stored handlers must not own their channel: close does not clear them.
    let message_dc = Arc::downgrade(&dc);
    let context_slot = Arc::new(Mutex::new(None::<Context>));
    let publications = Arc::new(PublicationFence::default());
    let status_publication_fence = Arc::new(StdMutex::new(()));
    let shutdown = CancellationToken::new();
    let context_shutdown = shutdown.child_token();
    let closed = Arc::new(AtomicBool::new(false));
    let lifetime = Arc::new(Lifetime {
        publications: Arc::clone(&publications),
        status_publication_fence: Arc::clone(&status_publication_fence),
        closed: Arc::clone(&closed),
        shutdown: shutdown.clone(),
    });
    let arrivals = Arc::new(StdMutex::new(ArrivalArbiter::default()));
    let (normal_tx, normal_rx) = mpsc::channel::<QueuedFrame>(MAX_NORMAL_QUEUE);
    let (fast_tx, fast_rx) = mpsc::channel::<QueuedFrame>(MAX_FAST_QUEUE);
    let normal_rx = Arc::new(StdMutex::new(Some(normal_rx)));
    let fast_rx = Arc::new(StdMutex::new(Some(fast_rx)));

    let message_arrivals = Arc::clone(&arrivals);
    let message_closed = Arc::clone(&closed);
    dc.on_message(Box::new(move |message: DataChannelMessage| {
        let dc = message_dc.upgrade();
        let normal_tx = normal_tx.clone();
        let fast_tx = fast_tx.clone();
        let arrivals = Arc::clone(&message_arrivals);
        let closed = Arc::clone(&message_closed);
        Box::pin(async move {
            let Some(dc) = dc else { return };
            if closed.load(Ordering::Acquire) {
                return;
            }
            if !message.is_string || message.data.is_empty() || message.data.len() > MAX_FRAME_BYTES
            {
                close_with_deadline_later(dc);
                return;
            }
            let Ok(value) = serde_json::from_slice::<Value>(&message.data) else {
                close_with_deadline_later(dc);
                return;
            };
            let fast = value.as_object().is_some_and(|object| {
                matches!(
                    object.get("type").and_then(Value::as_str),
                    Some("stream.ack" | "stream.cancel" | "cancel")
                )
            });
            let Some(order) = arrivals
                .lock()
                .ok()
                .and_then(|mut arrivals| arrivals.stamp(&value))
            else {
                close_with_deadline_later(dc);
                return;
            };
            let frame = QueuedFrame {
                arrival_order: order,
                value,
            };
            let queued = if fast {
                fast_tx.try_send(frame)
            } else {
                normal_tx.try_send(frame)
            };
            if queued.is_err() {
                close_with_deadline_later(dc);
            }
        })
    }));

    let open_dc = Arc::downgrade(&dc);
    let open_context = Arc::clone(&context_slot);
    let open_publications = Arc::clone(&publications);
    let open_status_publication_fence = Arc::clone(&status_publication_fence);
    let open_shutdown = context_shutdown;
    let open_arrivals = Arc::clone(&arrivals);
    let open_closed = Arc::clone(&closed);
    let open_normal_rx = Arc::clone(&normal_rx);
    let open_fast_rx = Arc::clone(&fast_rx);
    let open_pair = pair;
    dc.on_open(Box::new(move || {
        let dc = open_dc.upgrade();
        let context_slot = Arc::clone(&open_context);
        let publications = Arc::clone(&open_publications);
        let status_publication_fence = Arc::clone(&open_status_publication_fence);
        let connected_signal = connected_signal.clone();
        let files = files_override.clone();
        let shutdown = open_shutdown.clone();
        let arrivals = Arc::clone(&open_arrivals);
        let closed = Arc::clone(&open_closed);
        let normal_rx = Arc::clone(&open_normal_rx);
        let fast_rx = Arc::clone(&open_fast_rx);
        let pair = open_pair.clone();
        Box::pin(async move {
            let Some(dc) = dc else { return };
            let files = match files {
                Some(files) => files,
                None => match HostFileService::discover().await {
                    Ok(files) => Arc::new(files),
                    Err(_) => {
                        let _ = dc.close().await;
                        return;
                    }
                },
            };
            if closed.load(Ordering::Acquire) || shutdown.is_cancelled() {
                return;
            }
            let (cleanup_tx, cleanup_rx) = mpsc::channel(MAX_WRITE_STREAMS);
            let file_operations = HostFileOperations::new(Arc::clone(&closed));
            #[cfg(test)]
            file_operations.set_effect_test_hooks(files.write_lifecycle_test_hooks());
            #[cfg(target_os = "macos")]
            let preview = crate::host_preview::PreviewService::new(Arc::new(
                crate::host_preview::QlmanageRenderer,
            ))
            .ok()
            .map(Arc::new);
            // A host with no renderer simply never advertises `fs.preview`, so
            // the UI shows metadata cards and asks for nothing it cannot get.
            #[cfg(not(target_os = "macos"))]
            let preview: Option<Arc<crate::host_preview::PreviewService>> = None;
            let context = Context {
                direct: HostDirectChannel::new(Arc::clone(&dc)),
                files,
                preview,
                desktop: Arc::new(crate::host_desktop::DesktopService::new()),
                state: Arc::new(Mutex::new(State::default())),
                long_tasks: Arc::new(Semaphore::new(MAX_LONG_TASKS)),
                background_tasks: Arc::new(Mutex::new(JoinSet::new())),
                file_operations,
                cleanup_tx,
                arrivals,
                publications,
                closed,
                shutdown,
                pair,
            };
            let mut context_slot = context_slot.lock().await;
            if context.closed.load(Ordering::Acquire) || context.shutdown.is_cancelled() {
                return;
            }
            let Some(mut normal_rx) = normal_rx
                .lock()
                .ok()
                .and_then(|mut receiver| receiver.take())
            else {
                drop(context_slot);
                close_with_deadline_later(Arc::clone(&dc));
                return;
            };
            let Some(mut fast_rx) = fast_rx
                .lock()
                .ok()
                .and_then(|mut receiver| receiver.take())
            else {
                drop(context_slot);
                close_with_deadline_later(Arc::clone(&dc));
                return;
            };
            {
                let mut tasks = context.background_tasks.lock().await;
                tasks.spawn(context.clone().run_write_reaper(cleanup_rx));
                let normal_context = context.clone();
                tasks.spawn(async move {
                    loop {
                        let value = tokio::select! {
                            _ = normal_context.shutdown.cancelled() => break,
                            value = normal_rx.recv() => value,
                        };
                        let Some(value) = value else { break; };
                        let caught_up = normal_rx.is_empty();
                        if !normal_context.handle_normal(value, caught_up).await {
                            close_with_deadline_later(normal_context.direct.transport());
                            break;
                        }
                    }
                });
                let fast_context = context.clone();
                tasks.spawn(async move {
                    loop {
                        let value = tokio::select! {
                            _ = fast_context.shutdown.cancelled() => break,
                            value = fast_rx.recv() => value,
                        };
                        let Some(value) = value else { break; };
                        #[cfg(test)]
                        if let Some(delay_ms) = value
                            .value
                            .as_object()
                            .and_then(|object| object.get("test_delay_ms"))
                            .and_then(Value::as_u64)
                        {
                            tokio::select! {
                                _ = fast_context.shutdown.cancelled() => break,
                                _ = tokio::time::sleep(Duration::from_millis(delay_ms.min(1_000))) => {}
                            }
                        }
                        if !fast_context.handle_fast(value).await {
                            close_with_deadline_later(fast_context.direct.transport());
                            break;
                        }
                    }
                });
            }
            let publication_context = context.clone();
            *context_slot = Some(context);
            drop(context_slot);
            #[cfg(test)]
            if !publication_context
                .files
                .write_lifecycle_test_hooks()
                .pause_open_after_context(&publication_context.shutdown)
                .await
            {
                return;
            }
            // Built rather than literal: what this daemon can do depends on the
            // platform and on whether a renderer could be started. The client
            // gates every new action on this list and never on the reported OS,
            // so an old daemon on a Mac correctly offers nothing extra and a
            // future Linux daemon lights up with no client change.
            let mut capabilities = vec![
                "session.transport.v1",
                "ping",
                "fs.home",
                "fs.list",
                "fs.stat",
                "fs.read",
                "fs.read.range",
                "fs.write.begin",
                "fs.mkdir",
                "fs.rename",
                "fs.remove",
                "agent.transcripts",
            ];
            if publication_context.preview.is_some() {
                capabilities.push("fs.preview");
            }
            // Advertised, not assumed: a host with `SPAWND_NO_TELEMETRY` set
            // looks to the browser exactly like a daemon too old to have the
            // operation, and the UI draws no meters for either.
            if crate::host_metrics::enabled() {
                capabilities.push("host.metrics");
            }
            if crate::host_desktop::DESKTOP_SUPPORTED {
                capabilities.push("desktop.reveal");
                capabilities.push("desktop.open");
            }
            // New operation families are advertised as one versioned family
            // capability (`conv.v1`), not a name per operation: clients cap
            // the list they accept, and a family stays far from that cap.
            // Device-intent families appear only where they are answered —
            // on a pair-admitted channel, on a platform that supports them.
            if publication_context.pair.is_some() && crate::host_conv::SUPPORTED {
                capabilities.push(crate::host_conv::CAPABILITY);
            }
            // The carrier (`conv.probe`, `conv.export`, `conv.import.*`,
            // `conv.retire.*`, `conv.transfers`) on stream v2: a family of
            // its own, so a client that knows `conv.v1` never assumes it.
            if publication_context.pair.is_some() && crate::host_conversations::SUPPORTED {
                capabilities.push(crate::host_conversations::CAPABILITY);
            }
            let hello = json!({
                "version": VERSION,
                "type": "hello",
                "protocol": PROTOCOL,
                "capabilities": capabilities,
                "limits": {
                    "frame_bytes": MAX_FRAME_BYTES,
                    "chunk_bytes": STREAM_CHUNK_BYTES,
                    "file_bytes": MAX_FILE_BYTES,
                    "directory_entries": crate::host_files::MAX_DIRECTORY_ENTRIES,
                    "range_bytes": crate::host_files::MAX_RANGE_BYTES,
                    "preview_bytes": crate::host_preview::MAX_PREVIEW_BYTES,
                    "preview_pixels": crate::host_preview::PREVIEW_PIXEL_SIZES,
                    "normal_queue": MAX_NORMAL_QUEUE,
                    "fast_queue": MAX_FAST_QUEUE,
                    "long_tasks": MAX_LONG_TASKS,
                    "write_reapers": 1,
                    "stream_window_max": crate::host_stream::WINDOW_MAX,
                }
            });
            if !publication_context.send(hello).await {
                close_with_deadline_later(Arc::clone(&dc));
                return;
            }
            #[cfg(test)]
            if !publication_context
                .files
                .write_lifecycle_test_hooks()
                .pause_open_before_connected(&publication_context.shutdown)
                .await
            {
                return;
            }
            let connected = match status_publication_fence.lock() {
                Ok(_publication) => {
                    !publication_context.closed.load(Ordering::Acquire)
                        && !publication_context.shutdown.is_cancelled()
                        && connected_signal.publish()
                }
                Err(_) => false,
            };
            if !connected {
                close_with_deadline_later(Arc::clone(&dc));
            }
        })
    }));

    let close_context = Arc::clone(&context_slot);
    let close_lifetime = Arc::clone(&lifetime);
    dc.on_close(Box::new(move || {
        let context_slot = Arc::clone(&close_context);
        let lifetime = Arc::clone(&close_lifetime);
        Box::pin(async move {
            let deadline = tokio::time::Instant::now() + session_close_timeout();
            lifetime.retire();
            let context = match tokio::time::timeout_at(deadline, context_slot.lock()).await {
                Ok(mut context_slot) => context_slot.take(),
                Err(_) => None,
            };
            if let Some(context) = context {
                context.abort_all(deadline).await;
            }
        })
    }));
    lifetime
}

fn close_with_deadline_later(dc: Arc<RTCDataChannel>) {
    // This task is intentionally outside the session JoinSet: a dispatcher
    // cannot await a set containing itself while its close callback drains
    // that set. Unlike an ordinary detached task, the wrapper has a hard
    // lifetime bound and owns no session state beyond the channel reference.
    std::mem::drop(spawn_bounded_close(async move {
        let _ = dc.close().await;
    }));
}

fn spawn_bounded_close(
    close: impl std::future::Future<Output = ()> + Send + 'static,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let _ = tokio::time::timeout(session_close_timeout(), close).await;
    })
}

fn stream_ack_timeout() -> Duration {
    if cfg!(test) {
        Duration::from_millis(500)
    } else {
        STREAM_ACK_TIMEOUT
    }
}

fn write_reaper_interval() -> Duration {
    if cfg!(test) {
        Duration::from_millis(20)
    } else {
        Duration::from_secs(1)
    }
}

fn session_close_timeout() -> Duration {
    if cfg!(test) {
        Duration::from_millis(100)
    } else {
        Duration::from_secs(2)
    }
}

fn tombstone_deadline() -> Instant {
    let lifetime = if cfg!(test) {
        Duration::from_secs(5)
    } else {
        Duration::from_secs(120)
    };
    Instant::now() + lifetime
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ticket(window: &Arc<StdMutex<RequestWindow>>, id: &str) -> Option<RequestTicket> {
        window.lock().unwrap().admit(id).then(|| RequestTicket {
            id: id.to_string(),
            window: Arc::clone(window),
        })
    }

    #[test]
    fn a_long_open_channel_admits_every_new_request_id() {
        let window = Arc::new(StdMutex::new(RequestWindow::default()));
        // Well past the 4,096 a daemon used to remember before closing.
        for index in 0..(RECENT_REQUESTS * 3) {
            let admitted = ticket(&window, &format!("request-{index}"));
            assert!(admitted.is_some(), "request {index} was refused");
        }
        let window = window.lock().unwrap();
        assert!(window.in_flight.is_empty());
        assert_eq!(window.finished.len(), RECENT_REQUESTS);
    }

    #[test]
    fn a_duplicate_inside_the_window_is_refused() {
        let window = Arc::new(StdMutex::new(RequestWindow::default()));
        let held = ticket(&window, "held").unwrap();
        assert!(ticket(&window, "held").is_none(), "in flight");
        drop(held);
        assert!(ticket(&window, "held").is_none(), "just finished");
        for index in 0..(RECENT_REQUESTS - 1) {
            drop(ticket(&window, &format!("filler-{index}")).unwrap());
        }
        assert!(ticket(&window, "held").is_none(), "still among the recent");
        drop(ticket(&window, "one-more").unwrap());
        assert!(
            ticket(&window, "held").is_some(),
            "an id older than the window is forgotten"
        );
    }

    #[test]
    fn a_request_in_flight_is_never_forgotten() {
        let window = Arc::new(StdMutex::new(RequestWindow::default()));
        let long_read = ticket(&window, "long-read").unwrap();
        for index in 0..(RECENT_REQUESTS * 2) {
            drop(ticket(&window, &format!("short-{index}")).unwrap());
        }
        assert!(ticket(&window, "long-read").is_none());
        drop(long_read);
        assert!(ticket(&window, "long-read").is_none());
    }

    #[test]
    fn requests_in_flight_are_bounded() {
        let window = Arc::new(StdMutex::new(RequestWindow::default()));
        let held: Vec<_> = (0..MAX_IN_FLIGHT_REQUESTS)
            .map(|index| ticket(&window, &format!("held-{index}")).unwrap())
            .collect();
        assert!(ticket(&window, "one-too-many").is_none());
        drop(held);
        assert!(ticket(&window, "one-too-many").is_some());
    }

    #[test]
    fn early_cancels_wait_for_their_request_and_are_bounded() {
        let mut window = RequestWindow::default();
        // Overtaken: remembered until its request takes it.
        window.note_cancel("early");
        assert!(window.admit("early"));
        assert!(window.take_cancel("early"));
        assert!(!window.take_cancel("early"));
        window.finish("early");
        // Late: its request already finished, so there is nothing to keep.
        window.note_cancel("early");
        assert!(!window.take_cancel("early"));
        // A request that never takes its cancel (a ping) clears it when it
        // finishes.
        assert!(window.admit("ping"));
        window.note_cancel("ping");
        window.finish("ping");
        assert_eq!(window.early_cancels.len(), 0);
        // Cancels for requests that never come are forgotten oldest first
        // instead of closing the channel.
        for index in 0..(MAX_EARLY_CANCELS * 3) {
            window.note_cancel(&format!("orphan-{index}"));
        }
        assert_eq!(window.early_cancels.len(), MAX_EARLY_CANCELS);
        assert!(window.early_cancels.order.len() <= MAX_EARLY_CANCELS * 2);
        assert!(!window.take_cancel("orphan-0"));
        assert!(window.take_cancel(&format!("orphan-{}", MAX_EARLY_CANCELS * 3 - 1)));
    }

    #[test]
    fn a_reinserted_id_is_not_evicted_by_its_stale_entry() {
        let mut set = RecencySet::new(2);
        set.insert("a");
        assert!(set.remove("a"));
        set.insert("b");
        set.insert("a");
        // The stale first "a" reaches the front first; the live one stays.
        set.insert("c");
        assert!(set.contains("a"));
        assert!(set.contains("c"));
        assert!(!set.contains("b"));
    }

    #[tokio::test]
    async fn detached_close_invoker_has_a_hard_lifetime_bound() {
        let task = spawn_bounded_close(std::future::pending());
        tokio::time::timeout(Duration::from_millis(500), task)
            .await
            .expect("bounded close task exceeded its advertised deadline")
            .expect("bounded close task panicked");
    }
}
