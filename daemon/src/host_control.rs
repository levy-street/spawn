//! End-to-end host file protocol carried by `spawn.host.ctl`.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, Mutex, Notify, Semaphore};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;

use crate::host_files::{
    HostFileOperations, HostFileService, PendingWrite, WriteSessionGuard, MAX_FILE_BYTES,
    STREAM_CHUNK_BYTES,
};
use crate::host_tools::HostToolService;
use crate::pty::WsOutbound;
use crate::rtc::{try_send_host_status, HostRtcBinding};

const PROTOCOL: &str = "spawn.host.ctl";
const VERSION: u16 = 1;
const MAX_FRAME_BYTES: usize = 16 * 1024;
const MAX_ID_BYTES: usize = 128;
const MAX_SEEN_REQUESTS: usize = 4096;
const MAX_NORMAL_QUEUE: usize = 64;
const MAX_FAST_QUEUE: usize = 64;
const MAX_LONG_TASKS: usize = 8;
const MAX_READ_SIGNALS: usize = 16;
const STREAM_WINDOW_CHUNKS: u64 = 8;
const STREAM_ACK_TIMEOUT: Duration = Duration::from_secs(15);
const WRITE_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_WRITE_STREAMS: usize = 8;
const MAX_STREAM_TOMBSTONES: usize = 4096;
const MAX_ACTIVE_PUBLICATIONS: usize = 128;

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

struct QueuedFrame {
    arrival_order: u64,
    value: Value,
}

struct ActiveWrite {
    pending: Mutex<Option<PendingWrite>>,
    cancelled: CancellationToken,
}

struct WriteCleanup {
    stream_id: String,
    slot: Arc<ActiveWrite>,
    cancel_order: Option<u64>,
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
    reads: HashMap<String, mpsc::Sender<ReadSignal>>,
    finished_read_ids: HashMap<String, Instant>,
    read_requests: HashMap<String, Arc<AtomicBool>>,
    tool_requests: HashMap<String, CancellationToken>,
    cancelled_request_ids: HashSet<String>,
    seen_request_ids: HashSet<String>,
}

enum ReadSignal {
    Ack(u64),
    Cancel,
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
    dc: Arc<RTCDataChannel>,
    files: Arc<HostFileService>,
    tools: Arc<HostToolService>,
    state: Arc<Mutex<State>>,
    long_tasks: Arc<Semaphore>,
    background_tasks: Arc<Mutex<JoinSet<()>>>,
    file_operations: Arc<HostFileOperations>,
    cleanup_tx: mpsc::Sender<WriteCleanup>,
    arrivals: Arc<StdMutex<ArrivalArbiter>>,
    publications: Arc<PublicationFence>,
    closed: Arc<AtomicBool>,
    shutdown: CancellationToken,
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
        let encoded = value.to_string();
        let sent = if encoded.len() > MAX_FRAME_BYTES {
            false
        } else {
            tokio::select! {
                biased;
                _ = publication.cancelled.cancelled() => false,
                result = self.dc.send_text(encoded) => result.is_ok(),
            }
        };
        #[cfg(test)]
        if is_hello {
            self.files
                .write_lifecycle_test_hooks()
                .notify_publication_send_finished();
        }
        sent
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

    async fn mark_request(&self, request_id: &str) -> bool {
        let mut state = self.state.lock().await;
        if state.seen_request_ids.contains(request_id)
            || state.seen_request_ids.len() >= MAX_SEEN_REQUESTS
        {
            return false;
        }
        state.seen_request_ids.insert(request_id.to_string())
    }

    async fn finish_read(&self, stream_id: &str) -> bool {
        let mut state = self.state.lock().await;
        state.reads.remove(stream_id);
        Self::remember_finished_read(&mut state, stream_id)
    }

    async fn handle_normal(&self, frame: QueuedFrame) -> bool {
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
            Some("stream.chunk") => self.handle_stream_chunk(object, arrival_order).await,
            Some("stream.end") => self.handle_stream_end(object, arrival_order).await,
            _ => false,
        }
    }

    async fn handle_fast(&self, frame: QueuedFrame) -> bool {
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
        if !self.mark_request(request_id).await {
            return false;
        }
        let Some(operation) = object.get("operation").and_then(Value::as_str) else {
            return false;
        };
        let payload = object.get("payload").and_then(Value::as_object);
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
                    Ok(stat) => match serde_json::to_value(stat) {
                        Ok(result) => self.response(request_id, result).await,
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
            "fs.read" => self.begin_read(request_id, payload).await,
            "fs.write.begin" => self.begin_write(request_id, payload).await,
            "tool.check" => self.begin_tool_check(request_id, payload).await,
            "tool.install" => self.begin_tool_install(request_id, payload).await,
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

    async fn begin_tool_check(
        &self,
        request_id: &str,
        payload: Option<&Map<String, Value>>,
    ) -> bool {
        let Some(payload) = payload else {
            return self
                .error(
                    request_id,
                    "invalid_request",
                    "tool check payload is required",
                )
                .await;
        };
        let targets = match HostToolService::parse_check(&Value::Object(payload.clone())) {
            Ok(targets) => targets,
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
        let cancelled = CancellationToken::new();
        {
            let mut state = self.state.lock().await;
            if state.cancelled_request_ids.remove(request_id) {
                drop(state);
                return self
                    .error(request_id, "cancelled", "tool check was cancelled")
                    .await;
            }
            state
                .tool_requests
                .insert(request_id.to_string(), cancelled.clone());
        }
        let context = self.clone();
        let request_id = request_id.to_string();
        let cleanup_request_id = request_id.clone();
        let task = async move {
            let _permit = permit;
            let result = context
                .tools
                .check(targets, cancelled, context.shutdown.child_token())
                .await;
            context.state.lock().await.tool_requests.remove(&request_id);
            let sent = match result {
                Ok(tools) => match serde_json::to_value(tools) {
                    Ok(tools) => context.response(&request_id, json!({"tools": tools})).await,
                    Err(_) => false,
                },
                Err(error) => context.error(&request_id, error.code, &error.detail).await,
            };
            if !sent && !context.closed.load(Ordering::Acquire) {
                close_with_deadline_later(Arc::clone(&context.dc));
            }
        };
        if self.spawn_session_task(task).await {
            true
        } else {
            self.state
                .lock()
                .await
                .tool_requests
                .remove(&cleanup_request_id);
            false
        }
    }

    async fn begin_tool_install(
        &self,
        request_id: &str,
        payload: Option<&Map<String, Value>>,
    ) -> bool {
        let Some(payload) = payload else {
            return self
                .error(
                    request_id,
                    "invalid_request",
                    "tool install payload is required",
                )
                .await;
        };
        let target = match HostToolService::parse_install(&Value::Object(payload.clone())) {
            Ok(target) => target,
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
        let cancelled = CancellationToken::new();
        {
            let mut state = self.state.lock().await;
            if state.cancelled_request_ids.remove(request_id) {
                drop(state);
                return self
                    .error(request_id, "cancelled", "tool install was cancelled")
                    .await;
            }
            state
                .tool_requests
                .insert(request_id.to_string(), cancelled.clone());
        }
        let context = self.clone();
        let request_id = request_id.to_string();
        let cleanup_request_id = request_id.clone();
        let task = async move {
            let _permit = permit;
            let result = context
                .tools
                .install(target, cancelled, context.shutdown.child_token())
                .await;
            context.state.lock().await.tool_requests.remove(&request_id);
            let sent = match result {
                Ok(result) => match serde_json::to_value(result) {
                    Ok(result) => context.response(&request_id, result).await,
                    Err(_) => false,
                },
                Err(error) => context.error(&request_id, error.code, &error.detail).await,
            };
            if !sent && !context.closed.load(Ordering::Acquire) {
                close_with_deadline_later(Arc::clone(&context.dc));
            }
        };
        if self.spawn_session_task(task).await {
            true
        } else {
            self.state
                .lock()
                .await
                .tool_requests
                .remove(&cleanup_request_id);
            false
        }
    }

    async fn begin_read(&self, request_id: &str, payload: Option<&Map<String, Value>>) -> bool {
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
            if state.cancelled_request_ids.remove(request_id) {
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
            let sent = context.send_read(&request_id, &path, cancelled).await;
            context.state.lock().await.read_requests.remove(&request_id);
            if !sent && !context.closed.load(Ordering::Acquire) {
                close_with_deadline_later(Arc::clone(&context.dc));
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

    async fn begin_write(&self, request_id: &str, payload: Option<&Map<String, Value>>) -> bool {
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
            let mut state = self.state.lock().await;
            if state.cancelled_request_ids.remove(request_id) {
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
                });
                let mut state = self.state.lock().await;
                if self.closed.load(Ordering::Acquire) || self.shutdown.is_cancelled() {
                    drop(state);
                    if let Some(write) = slot.pending.lock().await.take() {
                        self.file_operations.cleanup_write(write).await;
                    }
                    return true;
                }
                if state.cancelled_request_ids.remove(request_id) {
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
                        close_with_deadline_later(Arc::clone(&self.dc));
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
                        close_with_deadline_later(Arc::clone(&self.dc));
                        break;
                    }
                }
            }
        }
    }

    async fn send_read(&self, request_id: &str, path: &str, cancelled: Arc<AtomicBool>) -> bool {
        let mut stream = match self
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
        let (signal_tx, mut signal_rx) = mpsc::channel(MAX_READ_SIGNALS);
        self.state
            .lock()
            .await
            .reads
            .insert(stream_id.clone(), signal_tx);
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

        let mut sequence = 0_u64;
        let mut acknowledged = 0_u64;
        let mut length = 0_u64;
        let mut actual = Sha256::new();
        let mut buffer = vec![0_u8; STREAM_CHUNK_BYTES];
        loop {
            if cancelled.load(Ordering::Acquire) {
                return self.finish_read(&stream_id).await;
            }
            while let Ok(signal) = signal_rx.try_recv() {
                match signal {
                    ReadSignal::Ack(value) if value >= acknowledged && value <= sequence => {
                        acknowledged = value;
                    }
                    ReadSignal::Cancel => {
                        return self.finish_read(&stream_id).await;
                    }
                    ReadSignal::Ack(_) => {
                        let _ = self.finish_read(&stream_id).await;
                        return false;
                    }
                }
            }
            let read = match stream.file.read(&mut buffer).await {
                Ok(read) => read,
                Err(error) => {
                    if !self.finish_read(&stream_id).await {
                        return false;
                    }
                    return self
                        .stream_error(&stream_id, "io_error", &error.to_string())
                        .await;
                }
            };
            if read == 0 {
                break;
            }
            length = length.saturating_add(read as u64);
            actual.update(&buffer[..read]);
            if !self
                .send(json!({
                    "version": VERSION,
                    "type": "stream.chunk",
                    "stream_id": stream_id,
                    "sequence": sequence,
                    "bytes_b64": STANDARD.encode(&buffer[..read]),
                }))
                .await
            {
                return false;
            }
            sequence = sequence.saturating_add(1);
            while sequence.saturating_sub(acknowledged) >= STREAM_WINDOW_CHUNKS {
                let signal = tokio::time::timeout(stream_ack_timeout(), signal_rx.recv()).await;
                match signal {
                    Ok(Some(ReadSignal::Ack(value)))
                        if value >= acknowledged && value <= sequence =>
                    {
                        acknowledged = value;
                    }
                    Ok(Some(ReadSignal::Cancel)) => {
                        return self.finish_read(&stream_id).await;
                    }
                    Ok(Some(ReadSignal::Ack(_))) | Ok(None) => {
                        let _ = self.finish_read(&stream_id).await;
                        return false;
                    }
                    Err(_) => {
                        if !self.finish_read(&stream_id).await {
                            return false;
                        }
                        return self
                            .stream_error(
                                &stream_id,
                                "stream_timeout",
                                "stream acknowledgement timed out",
                            )
                            .await;
                    }
                }
                if cancelled.load(Ordering::Acquire) {
                    return self.finish_read(&stream_id).await;
                }
            }
        }
        let digest = format!("{:x}", actual.finalize());
        if length != stream.stat.size || digest != stream.sha256 {
            if !self.finish_read(&stream_id).await {
                return false;
            }
            return self
                .stream_error(&stream_id, "file_changed", "file changed during transfer")
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
        self.finish_read(&stream_id).await && sent
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

    async fn handle_stream_chunk(&self, object: &Map<String, Value>, arrival_order: u64) -> bool {
        let (Some(stream_id), Some(sequence), Some(encoded)) = (
            valid_id(object.get("stream_id")),
            object.get("sequence").and_then(Value::as_u64),
            object.get("bytes_b64").and_then(Value::as_str),
        ) else {
            return false;
        };
        let bytes = match STANDARD.decode(encoded) {
            Ok(bytes) if !bytes.is_empty() && bytes.len() <= STREAM_CHUNK_BYTES => bytes,
            _ => return false,
        };
        if self.arrived_after_cancel(stream_id, arrival_order) {
            return false;
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
        let (sender, finished) = {
            let state = self.state.lock().await;
            (
                state.reads.get(stream_id).cloned(),
                state.finished_read_ids.contains_key(stream_id),
            )
        };
        let Some(sender) = sender else {
            return finished;
        };
        sender.try_send(ReadSignal::Ack(sequence)).is_ok()
    }

    async fn handle_stream_cancel(&self, object: &Map<String, Value>, arrival_order: u64) -> bool {
        let Some(stream_id) = valid_id(object.get("stream_id")) else {
            return false;
        };
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
            return read.try_send(ReadSignal::Cancel).is_ok();
        }
        known
    }

    async fn handle_request_cancel(&self, object: &Map<String, Value>) -> bool {
        let Some(request_id) = valid_id(object.get("request_id")) else {
            return false;
        };
        let (read, write, tool) = {
            let mut state = self.state.lock().await;
            let read = state.read_requests.get(request_id).cloned();
            let write = state
                .write_requests
                .remove(request_id)
                .and_then(|stream_id| state.writes.remove(&stream_id));
            let tool = state.tool_requests.get(request_id).cloned();
            if read.is_none() && write.is_none() && tool.is_none() {
                if state.cancelled_request_ids.len() >= MAX_SEEN_REQUESTS {
                    return false;
                }
                state.cancelled_request_ids.insert(request_id.to_string());
            }
            (read, write, tool)
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
        if let Some(tool) = tool {
            tool.cancel();
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
        let (reads, writes, tools) =
            match tokio::time::timeout_at(deadline, self.state.lock()).await {
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
                    let writes = state
                        .writes
                        .drain()
                        .map(|(_, write)| write)
                        .collect::<Vec<_>>();
                    let tools = state
                        .tool_requests
                        .drain()
                        .map(|(_, tool)| tool)
                        .collect::<Vec<_>>();
                    (reads, writes, tools)
                }
                Err(_) => (Vec::new(), Vec::new(), Vec::new()),
            };
        for read in reads {
            let _ = read.try_send(ReadSignal::Cancel);
        }
        for write in &writes {
            write.cancelled.cancel();
        }
        for tool in tools {
            tool.cancel();
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

pub(crate) fn install(
    dc: Arc<RTCDataChannel>,
    session_id: String,
    binding: HostRtcBinding,
    out_tx: mpsc::Sender<WsOutbound>,
    files_override: Option<Arc<HostFileService>>,
) {
    let message_dc = Arc::clone(&dc);
    let context_slot = Arc::new(Mutex::new(None::<Context>));
    let publications = Arc::new(PublicationFence::default());
    let status_publication_fence = Arc::new(StdMutex::new(()));
    let shutdown = CancellationToken::new();
    let context_shutdown = shutdown.child_token();
    let closed = Arc::new(AtomicBool::new(false));
    let arrivals = Arc::new(StdMutex::new(ArrivalArbiter::default()));
    let (normal_tx, normal_rx) = mpsc::channel::<QueuedFrame>(MAX_NORMAL_QUEUE);
    let (fast_tx, fast_rx) = mpsc::channel::<QueuedFrame>(MAX_FAST_QUEUE);
    let normal_rx = Arc::new(StdMutex::new(Some(normal_rx)));
    let fast_rx = Arc::new(StdMutex::new(Some(fast_rx)));

    let message_arrivals = Arc::clone(&arrivals);
    let message_closed = Arc::clone(&closed);
    dc.on_message(Box::new(move |message: DataChannelMessage| {
        let dc = Arc::clone(&message_dc);
        let normal_tx = normal_tx.clone();
        let fast_tx = fast_tx.clone();
        let arrivals = Arc::clone(&message_arrivals);
        let closed = Arc::clone(&message_closed);
        Box::pin(async move {
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

    let open_dc = Arc::clone(&dc);
    let open_context = Arc::clone(&context_slot);
    let open_publications = Arc::clone(&publications);
    let open_status_publication_fence = Arc::clone(&status_publication_fence);
    let open_shutdown = context_shutdown;
    let open_arrivals = Arc::clone(&arrivals);
    let open_closed = Arc::clone(&closed);
    let open_normal_rx = Arc::clone(&normal_rx);
    let open_fast_rx = Arc::clone(&fast_rx);
    dc.on_open(Box::new(move || {
        let dc = Arc::clone(&open_dc);
        let context_slot = Arc::clone(&open_context);
        let publications = Arc::clone(&open_publications);
        let status_publication_fence = Arc::clone(&open_status_publication_fence);
        let out_tx = out_tx.clone();
        let session_id = session_id.clone();
        let binding = binding.clone();
        let files = files_override.clone();
        let shutdown = open_shutdown.clone();
        let arrivals = Arc::clone(&open_arrivals);
        let closed = Arc::clone(&open_closed);
        let normal_rx = Arc::clone(&open_normal_rx);
        let fast_rx = Arc::clone(&open_fast_rx);
        Box::pin(async move {
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
            let context = Context {
                dc: Arc::clone(&dc),
                files,
                tools: HostToolService::shared(),
                state: Arc::new(Mutex::new(State::default())),
                long_tasks: Arc::new(Semaphore::new(MAX_LONG_TASKS)),
                background_tasks: Arc::new(Mutex::new(JoinSet::new())),
                file_operations,
                cleanup_tx,
                arrivals,
                publications,
                closed,
                shutdown,
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
                        if !normal_context.handle_normal(value).await {
                            close_with_deadline_later(Arc::clone(&normal_context.dc));
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
                            close_with_deadline_later(Arc::clone(&fast_context.dc));
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
            let hello = json!({
                "version": VERSION,
                "type": "hello",
                "protocol": PROTOCOL,
                "capabilities": [
                    "ping", "fs.home", "fs.list", "fs.stat", "fs.read",
                    "fs.write.begin", "fs.mkdir", "fs.rename", "fs.remove",
                    "tool.check", "tool.install"
                ],
                "limits": {
                    "frame_bytes": MAX_FRAME_BYTES,
                    "chunk_bytes": STREAM_CHUNK_BYTES,
                    "file_bytes": MAX_FILE_BYTES,
                    "directory_entries": crate::host_files::MAX_DIRECTORY_ENTRIES,
                    "normal_queue": MAX_NORMAL_QUEUE,
                    "fast_queue": MAX_FAST_QUEUE,
                    "long_tasks": MAX_LONG_TASKS,
                    "tool_targets": crate::host_tools::MAX_TARGETS,
                    "tool_processes": crate::host_tools::MAX_PROCESSES,
                    "tool_output_bytes": crate::host_tools::OUTPUT_TAIL_BYTES,
                    "write_reapers": 1,
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
                        && try_send_host_status(&out_tx, session_id, &binding, "connected")
                }
                Err(_) => false,
            };
            if !connected {
                close_with_deadline_later(Arc::clone(&dc));
            }
        })
    }));

    let close_context = Arc::clone(&context_slot);
    let close_publications = publications;
    let close_status_publication_fence = status_publication_fence;
    let close_shutdown = shutdown;
    let close_closed = Arc::clone(&closed);
    dc.on_close(Box::new(move || {
        let context_slot = Arc::clone(&close_context);
        let publications = Arc::clone(&close_publications);
        let status_publication_fence = Arc::clone(&close_status_publication_fence);
        let shutdown = close_shutdown.clone();
        let closed = Arc::clone(&close_closed);
        Box::pin(async move {
            let deadline = tokio::time::Instant::now() + session_close_timeout();
            {
                let _publication = status_publication_fence
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                publications.close();
                closed.store(true, Ordering::Release);
                shutdown.cancel();
            }
            let context = match tokio::time::timeout_at(deadline, context_slot.lock()).await {
                Ok(mut context_slot) => context_slot.take(),
                Err(_) => None,
            };
            if let Some(context) = context {
                context.abort_all(deadline).await;
            }
        })
    }));
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

    #[tokio::test]
    async fn detached_close_invoker_has_a_hard_lifetime_bound() {
        let task = spawn_bounded_close(std::future::pending());
        tokio::time::timeout(Duration::from_millis(500), task)
            .await
            .expect("bounded close task exceeded its advertised deadline")
            .expect("bounded close task panicked");
    }
}
