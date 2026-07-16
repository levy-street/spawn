//! End-to-end host file protocol carried by `spawn.host.ctl`.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, Mutex, Notify, Semaphore};
use uuid::Uuid;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;

use crate::host_files::{HostFileService, PendingWrite, MAX_FILE_BYTES, STREAM_CHUNK_BYTES};
use crate::pty::WsOutbound;
use crate::rtc::{send_host_status, HostRtcBinding};

const PROTOCOL: &str = "spawn.host.ctl";
const VERSION: u16 = 1;
const MAX_FRAME_BYTES: usize = 16 * 1024;
const MAX_ID_BYTES: usize = 128;
const MAX_IN_FLIGHT: usize = 32;
const MAX_SEEN_REQUESTS: usize = 4096;
const STREAM_WINDOW_CHUNKS: u64 = 8;
const STREAM_ACK_TIMEOUT: Duration = Duration::from_secs(15);
const WRITE_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_WRITE_STREAMS: usize = 8;

#[derive(Default)]
struct State {
    writes: HashMap<String, PendingWrite>,
    reads: HashMap<String, Arc<ReadFlow>>,
    read_requests: HashMap<String, Arc<AtomicBool>>,
    seen_request_ids: HashSet<String>,
}

#[derive(Default)]
struct ReadFlow {
    acknowledged: AtomicU64,
    sent: AtomicU64,
    cancelled: AtomicBool,
    notify: Notify,
}

#[derive(Clone)]
struct Context {
    dc: Arc<RTCDataChannel>,
    files: Arc<HostFileService>,
    state: Arc<Mutex<State>>,
}

impl Context {
    async fn send(&self, value: Value) -> bool {
        let encoded = value.to_string();
        encoded.len() <= MAX_FRAME_BYTES && self.dc.send_text(encoded).await.is_ok()
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

    async fn handle(&self, value: Value) -> bool {
        let Some(object) = value.as_object() else {
            return false;
        };
        if object.get("version").and_then(Value::as_u64) != Some(u64::from(VERSION)) {
            return false;
        }
        match object.get("type").and_then(Value::as_str) {
            Some("request") => self.handle_request(object).await,
            Some("stream.chunk") => self.handle_stream_chunk(object).await,
            Some("stream.end") => self.handle_stream_end(object).await,
            Some("stream.ack") => self.handle_stream_ack(object).await,
            Some("stream.cancel") => self.handle_stream_cancel(object).await,
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
                match self.files.list(path, cursor).await {
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
                match self.files.stat(path).await {
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
                match self.files.mkdir(path).await {
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
                match self.files.rename(path, name, overwrite).await {
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
                match self.files.remove(path, recursive).await {
                    Ok(path) => self.response(request_id, json!({"path": path})).await,
                    Err(error) => self.error(request_id, error.code, &error.detail).await,
                }
            }
            "fs.read" => self.begin_read(request_id, payload).await,
            "fs.write.begin" => self.begin_write(request_id, payload).await,
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

    async fn begin_read(&self, request_id: &str, payload: Option<&Map<String, Value>>) -> bool {
        let Some(path) = payload_string(payload, "path") else {
            return self
                .error(request_id, "invalid_request", "path is required")
                .await;
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        self.state
            .lock()
            .await
            .read_requests
            .insert(request_id.to_string(), Arc::clone(&cancelled));
        let sent = self.send_read(request_id, path, &cancelled).await;
        self.state.lock().await.read_requests.remove(request_id);
        sent
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
        if self.state.lock().await.writes.len() >= MAX_WRITE_STREAMS {
            return self
                .error(
                    request_id,
                    "too_many_streams",
                    "too many pending write streams",
                )
                .await;
        }
        match self
            .files
            .begin_write(request_id.to_string(), dir, name, length, sha256, overwrite)
            .await
        {
            Ok(write) => {
                let stream_id = write.stream_id.clone();
                let mut state = self.state.lock().await;
                if state.writes.len() >= MAX_WRITE_STREAMS {
                    drop(state);
                    write.abort().await;
                    return self
                        .error(
                            request_id,
                            "too_many_streams",
                            "too many pending write streams",
                        )
                        .await;
                }
                state.writes.insert(stream_id.clone(), write);
                drop(state);
                self.spawn_write_cleanup(stream_id.clone());
                self.response(request_id, json!({"stream_id": stream_id}))
                    .await
            }
            Err(error) => self.error(request_id, error.code, &error.detail).await,
        }
    }

    fn spawn_write_cleanup(&self, stream_id: String) {
        let context = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(WRITE_IDLE_TIMEOUT).await;
                let (exists, stale_write) = {
                    let mut state = context.state.lock().await;
                    let exists = state.writes.contains_key(&stream_id);
                    let stale = state
                        .writes
                        .get(&stream_id)
                        .is_some_and(|write| write.idle_for() >= WRITE_IDLE_TIMEOUT);
                    let write = stale.then(|| state.writes.remove(&stream_id)).flatten();
                    (exists, write)
                };
                if let Some(write) = stale_write {
                    write.abort().await;
                    break;
                }
                if !exists {
                    break;
                }
            }
        });
    }

    async fn send_read(&self, request_id: &str, path: &str, cancelled: &AtomicBool) -> bool {
        let mut stream = match self.files.open_read_cancellable(path, cancelled).await {
            Ok(stream) => stream,
            Err(error) => return self.error(request_id, error.code, &error.detail).await,
        };
        let stream_id = Uuid::new_v4().to_string();
        let flow = Arc::new(ReadFlow::default());
        self.state
            .lock()
            .await
            .reads
            .insert(stream_id.clone(), Arc::clone(&flow));
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
            self.state.lock().await.reads.remove(&stream_id);
            return false;
        }

        let mut sequence = 0_u64;
        let mut length = 0_u64;
        let mut actual = Sha256::new();
        let mut buffer = vec![0_u8; STREAM_CHUNK_BYTES];
        loop {
            if flow.cancelled.load(Ordering::Acquire) {
                self.state.lock().await.reads.remove(&stream_id);
                return true;
            }
            let read = match stream.file.read(&mut buffer).await {
                Ok(read) => read,
                Err(error) => {
                    self.state.lock().await.reads.remove(&stream_id);
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
            flow.sent.store(sequence, Ordering::Release);
            if sequence.saturating_sub(flow.acknowledged.load(Ordering::Acquire))
                >= STREAM_WINDOW_CHUNKS
            {
                let wait = async {
                    loop {
                        if flow.cancelled.load(Ordering::Acquire)
                            || sequence.saturating_sub(flow.acknowledged.load(Ordering::Acquire))
                                < STREAM_WINDOW_CHUNKS
                        {
                            break;
                        }
                        flow.notify.notified().await;
                    }
                };
                if tokio::time::timeout(STREAM_ACK_TIMEOUT, wait)
                    .await
                    .is_err()
                    || flow.cancelled.load(Ordering::Acquire)
                {
                    self.state.lock().await.reads.remove(&stream_id);
                    return self
                        .stream_error(
                            &stream_id,
                            "stream_timeout",
                            "stream acknowledgement timed out",
                        )
                        .await;
                }
            }
        }
        let digest = format!("{:x}", actual.finalize());
        if length != stream.stat.size || digest != stream.sha256 {
            self.state.lock().await.reads.remove(&stream_id);
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
        self.state.lock().await.reads.remove(&stream_id);
        sent
    }

    async fn handle_stream_chunk(&self, object: &Map<String, Value>) -> bool {
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
        let mut state = self.state.lock().await;
        let Some(write) = state.writes.get_mut(stream_id) else {
            return false;
        };
        if let Err(error) = write.append(sequence, &bytes).await {
            let write = state.writes.remove(stream_id).expect("write exists");
            drop(state);
            write.abort().await;
            return self
                .stream_error(stream_id, error.code, &error.detail)
                .await;
        }
        true
    }

    async fn handle_stream_end(&self, object: &Map<String, Value>) -> bool {
        let Some(stream_id) = valid_id(object.get("stream_id")) else {
            return false;
        };
        let write = self.state.lock().await.writes.remove(stream_id);
        let Some(write) = write else {
            return false;
        };
        if object.get("length").and_then(Value::as_u64) != Some(write.expected_length)
            || object.get("sha256").and_then(Value::as_str) != Some(write.expected_sha256.as_str())
        {
            write.abort().await;
            return self
                .stream_error(
                    stream_id,
                    "declaration_mismatch",
                    "stream end does not match its write declaration",
                )
                .await;
        }
        let request_id = write.request_id.clone();
        match write.finish().await {
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
    }

    async fn handle_stream_ack(&self, object: &Map<String, Value>) -> bool {
        let (Some(stream_id), Some(sequence)) = (
            valid_id(object.get("stream_id")),
            object.get("sequence").and_then(Value::as_u64),
        ) else {
            return false;
        };
        let flow = self.state.lock().await.reads.get(stream_id).cloned();
        let Some(flow) = flow else {
            return false;
        };
        let current = flow.acknowledged.load(Ordering::Acquire);
        if sequence < current || sequence > flow.sent.load(Ordering::Acquire) {
            return false;
        }
        flow.acknowledged.store(sequence, Ordering::Release);
        flow.notify.notify_waiters();
        true
    }

    async fn handle_stream_cancel(&self, object: &Map<String, Value>) -> bool {
        let Some(stream_id) = valid_id(object.get("stream_id")) else {
            return false;
        };
        if let Some(write) = self.state.lock().await.writes.remove(stream_id) {
            write.abort().await;
        }
        if let Some(read) = self.state.lock().await.reads.remove(stream_id) {
            read.cancelled.store(true, Ordering::Release);
            read.notify.notify_waiters();
        }
        true
    }

    async fn handle_request_cancel(&self, object: &Map<String, Value>) -> bool {
        let Some(request_id) = valid_id(object.get("request_id")) else {
            return false;
        };
        if let Some(read) = self
            .state
            .lock()
            .await
            .read_requests
            .get(request_id)
            .cloned()
        {
            read.store(true, Ordering::Release);
        }
        let stream_id = {
            let state = self.state.lock().await;
            state.writes.iter().find_map(|(stream_id, write)| {
                (write.request_id == request_id).then(|| stream_id.clone())
            })
        };
        if let Some(stream_id) = stream_id {
            if let Some(write) = self.state.lock().await.writes.remove(&stream_id) {
                write.abort().await;
            }
        }
        true
    }

    async fn abort_all(&self) {
        let writes = {
            let mut state = self.state.lock().await;
            for read in state.reads.drain().map(|(_, read)| read) {
                read.cancelled.store(true, Ordering::Release);
                read.notify.notify_waiters();
            }
            for request in state.read_requests.drain().map(|(_, request)| request) {
                request.store(true, Ordering::Release);
            }
            state
                .writes
                .drain()
                .map(|(_, write)| write)
                .collect::<Vec<_>>()
        };
        for write in writes {
            write.abort().await;
        }
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
    let in_flight = Arc::new(Semaphore::new(MAX_IN_FLIGHT));
    let context_slot = Arc::new(Mutex::new(None::<Context>));
    let message_context = Arc::clone(&context_slot);
    dc.on_message(Box::new(move |message: DataChannelMessage| {
        let dc = Arc::clone(&message_dc);
        let in_flight = Arc::clone(&in_flight);
        let context_slot = Arc::clone(&message_context);
        Box::pin(async move {
            let Ok(_permit) = in_flight.try_acquire_owned() else {
                let _ = dc.close().await;
                return;
            };
            if !message.is_string || message.data.is_empty() || message.data.len() > MAX_FRAME_BYTES
            {
                let _ = dc.close().await;
                return;
            }
            let Ok(value) = serde_json::from_slice::<Value>(&message.data) else {
                let _ = dc.close().await;
                return;
            };
            let Some(context) = context_slot.lock().await.clone() else {
                let _ = dc.close().await;
                return;
            };
            if !context.handle(value).await {
                let _ = dc.close().await;
            }
        })
    }));

    let open_dc = Arc::clone(&dc);
    let open_context = Arc::clone(&context_slot);
    dc.on_open(Box::new(move || {
        let dc = Arc::clone(&open_dc);
        let context_slot = Arc::clone(&open_context);
        let out_tx = out_tx.clone();
        let session_id = session_id.clone();
        let binding = binding.clone();
        let files = files_override.clone();
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
            *context_slot.lock().await = Some(Context {
                dc: Arc::clone(&dc),
                files,
                state: Arc::new(Mutex::new(State::default())),
            });
            let hello = json!({
                "version": VERSION,
                "type": "hello",
                "protocol": PROTOCOL,
                "capabilities": [
                    "ping", "fs.home", "fs.list", "fs.stat", "fs.read",
                    "fs.write.begin", "fs.mkdir", "fs.rename", "fs.remove"
                ],
                "limits": {
                    "frame_bytes": MAX_FRAME_BYTES,
                    "chunk_bytes": STREAM_CHUNK_BYTES,
                    "file_bytes": MAX_FILE_BYTES,
                }
            });
            if dc.send_text(hello.to_string()).await.is_ok() {
                send_host_status(&out_tx, session_id, &binding, "connected").await;
            } else {
                let _ = dc.close().await;
            }
        })
    }));

    let close_context = Arc::clone(&context_slot);
    dc.on_close(Box::new(move || {
        let context_slot = Arc::clone(&close_context);
        Box::pin(async move {
            if let Some(context) = context_slot.lock().await.take() {
                context.abort_all().await;
            }
        })
    }));
}
