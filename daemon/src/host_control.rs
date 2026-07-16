//! End-to-end host file protocol carried by `spawn.host.ctl`.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, Mutex, Semaphore};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
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
const MAX_SEEN_REQUESTS: usize = 4096;
const MAX_NORMAL_QUEUE: usize = 64;
const MAX_FAST_QUEUE: usize = 64;
const MAX_LONG_TASKS: usize = 8;
const MAX_READ_SIGNALS: usize = 16;
const STREAM_WINDOW_CHUNKS: u64 = 8;
const STREAM_ACK_TIMEOUT: Duration = Duration::from_secs(15);
const WRITE_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_WRITE_STREAMS: usize = 8;

#[derive(Default)]
struct State {
    writes: HashMap<String, Arc<Mutex<Option<PendingWrite>>>>,
    write_requests: HashMap<String, String>,
    reads: HashMap<String, mpsc::Sender<ReadSignal>>,
    finished_read_ids: HashSet<String>,
    read_requests: HashMap<String, Arc<AtomicBool>>,
    cancelled_request_ids: HashSet<String>,
    seen_request_ids: HashSet<String>,
}

enum ReadSignal {
    Ack(u64),
    Cancel,
}

#[derive(Clone)]
struct Context {
    dc: Arc<RTCDataChannel>,
    files: Arc<HostFileService>,
    state: Arc<Mutex<State>>,
    long_tasks: Arc<Semaphore>,
    read_tasks: Arc<Mutex<JoinSet<()>>>,
    closed: Arc<AtomicBool>,
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

    async fn finish_read(&self, stream_id: &str) {
        let mut state = self.state.lock().await;
        state.reads.remove(stream_id);
        if state.finished_read_ids.len() >= MAX_SEEN_REQUESTS {
            state.finished_read_ids.clear();
        }
        state.finished_read_ids.insert(stream_id.to_string());
    }

    async fn handle_normal(&self, value: Value) -> bool {
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
            _ => false,
        }
    }

    async fn handle_fast(&self, value: Value) -> bool {
        let Some(object) = value.as_object() else {
            return false;
        };
        if object.get("version").and_then(Value::as_u64) != Some(u64::from(VERSION)) {
            return false;
        }
        match object.get("type").and_then(Value::as_str) {
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
        let path = path.to_string();
        let task = async move {
            let _permit = permit;
            let sent = context.send_read(&request_id, &path, cancelled).await;
            context.state.lock().await.read_requests.remove(&request_id);
            if !sent && !context.closed.load(Ordering::Acquire) {
                let _ = context.dc.close().await;
            }
        };
        let mut tasks = self.read_tasks.lock().await;
        while tasks.try_join_next().is_some() {}
        tasks.spawn(task);
        true
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
            .begin_write(request_id.to_string(), dir, name, length, sha256, overwrite)
            .await
        {
            Ok(write) => {
                let stream_id = write.stream_id.clone();
                let slot = Arc::new(Mutex::new(Some(write)));
                let mut state = self.state.lock().await;
                if state.cancelled_request_ids.remove(request_id) {
                    drop(state);
                    if let Some(write) = slot.lock().await.take() {
                        write.abort().await;
                    }
                    return self
                        .error(request_id, "cancelled", "file write was cancelled")
                        .await;
                }
                if state.writes.len() >= MAX_WRITE_STREAMS {
                    drop(state);
                    if let Some(write) = slot.lock().await.take() {
                        write.abort().await;
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
                let slot = context.state.lock().await.writes.get(&stream_id).cloned();
                let Some(slot) = slot else {
                    break;
                };
                let stale_write = {
                    let mut write = slot.lock().await;
                    if write
                        .as_ref()
                        .is_some_and(|write| write.idle_for() >= WRITE_IDLE_TIMEOUT)
                    {
                        write.take()
                    } else {
                        None
                    }
                };
                if let Some(write) = stale_write {
                    let mut state = context.state.lock().await;
                    state.writes.remove(&stream_id);
                    state.write_requests.remove(&write.request_id);
                    drop(state);
                    write.abort().await;
                    break;
                }
                if slot.lock().await.is_none() {
                    context.state.lock().await.writes.remove(&stream_id);
                    break;
                }
            }
        });
    }

    async fn send_read(&self, request_id: &str, path: &str, cancelled: Arc<AtomicBool>) -> bool {
        let mut stream = match self
            .files
            .open_read_cancellable(path, Arc::clone(&cancelled))
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
            self.finish_read(&stream_id).await;
            return false;
        }

        let mut sequence = 0_u64;
        let mut acknowledged = 0_u64;
        let mut length = 0_u64;
        let mut actual = Sha256::new();
        let mut buffer = vec![0_u8; STREAM_CHUNK_BYTES];
        loop {
            if cancelled.load(Ordering::Acquire) {
                self.finish_read(&stream_id).await;
                return true;
            }
            while let Ok(signal) = signal_rx.try_recv() {
                match signal {
                    ReadSignal::Ack(value) if value >= acknowledged && value <= sequence => {
                        acknowledged = value;
                    }
                    ReadSignal::Cancel => {
                        self.finish_read(&stream_id).await;
                        return true;
                    }
                    ReadSignal::Ack(_) => {
                        self.finish_read(&stream_id).await;
                        return false;
                    }
                }
            }
            let read = match stream.file.read(&mut buffer).await {
                Ok(read) => read,
                Err(error) => {
                    self.finish_read(&stream_id).await;
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
                        self.finish_read(&stream_id).await;
                        return true;
                    }
                    Ok(Some(ReadSignal::Ack(_))) | Ok(None) => {
                        self.finish_read(&stream_id).await;
                        return false;
                    }
                    Err(_) => {
                        self.finish_read(&stream_id).await;
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
                    self.finish_read(&stream_id).await;
                    return true;
                }
            }
        }
        let digest = format!("{:x}", actual.finalize());
        if length != stream.stat.size || digest != stream.sha256 {
            self.finish_read(&stream_id).await;
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
        self.finish_read(&stream_id).await;
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
        let slot = self.state.lock().await.writes.get(stream_id).cloned();
        let Some(slot) = slot else {
            return false;
        };
        let mut write_guard = slot.lock().await;
        let Some(active) = write_guard.as_mut() else {
            return false;
        };
        if let Err(error) = active.append(sequence, &bytes).await {
            let write = write_guard.take().expect("active write exists");
            drop(write_guard);
            let mut state = self.state.lock().await;
            state.writes.remove(stream_id);
            state.write_requests.remove(&write.request_id);
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
        let slot = self.state.lock().await.writes.remove(stream_id);
        let Some(slot) = slot else {
            return false;
        };
        let write = slot.lock().await.take();
        let Some(write) = write else {
            return false;
        };
        self.state
            .lock()
            .await
            .write_requests
            .remove(&write.request_id);
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
        let (sender, finished) = {
            let state = self.state.lock().await;
            (
                state.reads.get(stream_id).cloned(),
                state.finished_read_ids.contains(stream_id),
            )
        };
        let Some(sender) = sender else {
            return finished;
        };
        sender.try_send(ReadSignal::Ack(sequence)).is_ok()
    }

    async fn handle_stream_cancel(&self, object: &Map<String, Value>) -> bool {
        let Some(stream_id) = valid_id(object.get("stream_id")) else {
            return false;
        };
        if let Some(slot) = self.state.lock().await.writes.remove(stream_id) {
            if let Some(write) = slot.lock().await.take() {
                self.state
                    .lock()
                    .await
                    .write_requests
                    .remove(&write.request_id);
                write.abort().await;
            }
        }
        let read = {
            let mut state = self.state.lock().await;
            let read = state.reads.remove(stream_id);
            if read.is_some() {
                if state.finished_read_ids.len() >= MAX_SEEN_REQUESTS {
                    state.finished_read_ids.clear();
                }
                state.finished_read_ids.insert(stream_id.to_string());
            }
            read
        };
        if let Some(read) = read {
            return read.try_send(ReadSignal::Cancel).is_ok();
        }
        self.state
            .lock()
            .await
            .finished_read_ids
            .contains(stream_id)
    }

    async fn handle_request_cancel(&self, object: &Map<String, Value>) -> bool {
        let Some(request_id) = valid_id(object.get("request_id")) else {
            return false;
        };
        let (read, write) = {
            let mut state = self.state.lock().await;
            let read = state.read_requests.get(request_id).cloned();
            let write = state
                .write_requests
                .remove(request_id)
                .and_then(|stream_id| state.writes.remove(&stream_id));
            if read.is_none() && write.is_none() {
                if state.cancelled_request_ids.len() >= MAX_SEEN_REQUESTS {
                    return false;
                }
                state.cancelled_request_ids.insert(request_id.to_string());
            }
            (read, write)
        };
        if let Some(read) = read {
            read.store(true, Ordering::Release);
        }
        if let Some(write) = write {
            if let Some(write) = write.lock().await.take() {
                write.abort().await;
            }
        }
        true
    }

    async fn abort_all(&self) {
        self.closed.store(true, Ordering::Release);
        let (reads, writes) = {
            let mut state = self.state.lock().await;
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
            (reads, writes)
        };
        for read in reads {
            let _ = read.try_send(ReadSignal::Cancel);
        }
        for write in writes {
            if let Some(write) = write.lock().await.take() {
                write.abort().await;
            }
        }
        let mut tasks = self.read_tasks.lock().await;
        while !tasks.is_empty() {
            match tokio::time::timeout(Duration::from_secs(2), tasks.join_next()).await {
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(_) => {
                    tasks.abort_all();
                    while tasks.join_next().await.is_some() {}
                    break;
                }
            }
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
    let context_slot = Arc::new(Mutex::new(None::<Context>));
    let shutdown = CancellationToken::new();
    let (normal_tx, mut normal_rx) = mpsc::channel::<Value>(MAX_NORMAL_QUEUE);
    let (fast_tx, mut fast_rx) = mpsc::channel::<Value>(MAX_FAST_QUEUE);

    let normal_context = Arc::clone(&context_slot);
    let normal_dc = Arc::clone(&dc);
    let normal_shutdown = shutdown.clone();
    tokio::spawn(async move {
        loop {
            let value = tokio::select! {
                _ = normal_shutdown.cancelled() => break,
                value = normal_rx.recv() => value,
            };
            let Some(value) = value else {
                break;
            };
            let Some(context) = normal_context.lock().await.clone() else {
                let _ = normal_dc.close().await;
                break;
            };
            if !context.handle_normal(value).await {
                let _ = normal_dc.close().await;
                break;
            }
        }
    });

    let fast_context = Arc::clone(&context_slot);
    let fast_dc = Arc::clone(&dc);
    let fast_shutdown = shutdown.clone();
    tokio::spawn(async move {
        loop {
            let value = tokio::select! {
                _ = fast_shutdown.cancelled() => break,
                value = fast_rx.recv() => value,
            };
            let Some(value) = value else {
                break;
            };
            let Some(context) = fast_context.lock().await.clone() else {
                let _ = fast_dc.close().await;
                break;
            };
            if !context.handle_fast(value).await {
                let _ = fast_dc.close().await;
                break;
            }
        }
    });

    dc.on_message(Box::new(move |message: DataChannelMessage| {
        let dc = Arc::clone(&message_dc);
        let normal_tx = normal_tx.clone();
        let fast_tx = fast_tx.clone();
        Box::pin(async move {
            if !message.is_string || message.data.is_empty() || message.data.len() > MAX_FRAME_BYTES
            {
                close_later(dc);
                return;
            }
            let Ok(value) = serde_json::from_slice::<Value>(&message.data) else {
                close_later(dc);
                return;
            };
            let fast = value.as_object().is_some_and(|object| {
                matches!(
                    object.get("type").and_then(Value::as_str),
                    Some("stream.ack" | "stream.cancel" | "cancel")
                )
            });
            let queued = if fast {
                fast_tx.try_send(value)
            } else {
                normal_tx.try_send(value)
            };
            if queued.is_err() {
                close_later(dc);
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
                long_tasks: Arc::new(Semaphore::new(MAX_LONG_TASKS)),
                read_tasks: Arc::new(Mutex::new(JoinSet::new())),
                closed: Arc::new(AtomicBool::new(false)),
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
                    "directory_entries": crate::host_files::MAX_DIRECTORY_ENTRIES,
                    "normal_queue": MAX_NORMAL_QUEUE,
                    "fast_queue": MAX_FAST_QUEUE,
                    "long_tasks": MAX_LONG_TASKS,
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
    let close_shutdown = shutdown;
    dc.on_close(Box::new(move || {
        let context_slot = Arc::clone(&close_context);
        let shutdown = close_shutdown.clone();
        Box::pin(async move {
            shutdown.cancel();
            if let Some(context) = context_slot.lock().await.take() {
                context.abort_all().await;
            }
        })
    }));
}

fn close_later(dc: Arc<RTCDataChannel>) {
    tokio::spawn(async move {
        let _ = dc.close().await;
    });
}

fn stream_ack_timeout() -> Duration {
    if cfg!(test) {
        Duration::from_millis(500)
    } else {
        STREAM_ACK_TIMEOUT
    }
}
