//! Versioned, bounded protocol for the per-session `spawn.ctl` DataChannel.
//!
//! Control messages never transit the control-plane websocket. Requests and
//! metadata responses are JSON text messages. Potentially large replay bytes
//! are split into request-bound binary chunks so concurrent requests cannot be
//! confused and no single SCTP message needs to hold an entire replay.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, watch, Mutex};
use uuid::Uuid;
use zeroize::Zeroize;

pub const PROTOCOL_VERSION: u8 = 1;
pub const MAX_REQUEST_BYTES: usize = 16 * 1024;
pub const MAX_REPLAY_BYTES: usize = 12 * 1024 * 1024;
/// Keep the complete SCTP user message (header plus payload) at or below the
/// portable 16 KiB data-channel ceiling.
pub const CHUNK_PAYLOAD_BYTES: usize = 16 * 1024 - CHUNK_HEADER_LEN;
pub const OUTBOUND_QUEUE_DEPTH: usize = 64;
pub const OUTBOUND_ENQUEUE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);
pub const MAX_HISTORY_LINES: u16 = 10_000;
pub const MIN_COLS: u16 = 20;
pub const MAX_COLS: u16 = 400;
pub const MIN_ROWS: u16 = 5;
pub const MAX_ROWS: u16 = 200;
pub const MAX_SCROLL_LINES: i16 = 200;

const CHUNK_MAGIC: &[u8; 4] = b"SPCT";
const CHUNK_KIND_REPLAY: u8 = 1;
const CHUNK_KIND_UPLOAD: u8 = 2;
const CHUNK_HEADER_LEN: usize = 4 + 1 + 1 + 2 + 16 + 4;
const CHUNK_FLAG_LAST: u16 = 1;

#[cfg(test)]
type ControlWipeProbe = Box<dyn Fn(&[u8])>;

#[cfg(test)]
thread_local! {
    static CONTROL_WIPE_PROBE: std::cell::RefCell<Option<ControlWipeProbe>> =
        const { std::cell::RefCell::new(None) };
}

#[derive(Debug, Clone)]
pub enum ControlOutbound {
    Text(String),
    Binary(Vec<u8>),
}

impl ControlOutbound {
    fn wipe(&mut self) {
        match self {
            Self::Text(text) => text.zeroize(),
            Self::Binary(bytes) => bytes.zeroize(),
        }
    }
}

impl Drop for ControlOutbound {
    fn drop(&mut self) {
        self.wipe();
        #[cfg(test)]
        CONTROL_WIPE_PROBE.with(|slot| {
            if let Some(probe) = slot.borrow_mut().take() {
                match self {
                    Self::Text(text) => probe(text.as_bytes()),
                    Self::Binary(bytes) => probe(bytes),
                }
            }
        });
    }
}

pub type ControlSender = mpsc::Sender<ControlOutbound>;
pub type DisplaySender = watch::Sender<Option<String>>;

#[derive(Debug, Deserialize)]
pub struct ControlRequest {
    pub version: u8,
    #[serde(rename = "kind")]
    pub _kind: RequestKind,
    pub request_id: Uuid,
    #[serde(flatten)]
    pub operation: ControlOperation,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RequestKind {
    Request,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum ControlOperation {
    History {
        #[serde(default = "default_history_lines")]
        lines: u16,
        #[serde(default)]
        plain: bool,
        #[serde(default)]
        cols: Option<u16>,
        #[serde(default)]
        rows: Option<u16>,
    },
    Snapshot {
        #[serde(default = "default_snapshot_lines")]
        lines: u16,
        #[serde(default)]
        plain: bool,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
    Scroll {
        lines: i16,
    },
    Redraw,
    TakeControl {
        cols: u16,
        rows: u16,
    },
    UploadStart {
        capability: Uuid,
        agent_generation: u64,
        name: String,
        mime_type: String,
        #[serde(default)]
        destination: UploadDestinationRequest,
        total_bytes: usize,
        chunks: u32,
        sha256: String,
    },
    UploadCancel {
        capability: Uuid,
        agent_generation: u64,
        upload_id: Uuid,
    },
    /// Opt in to committed-history delta events (`history_delta` /
    /// `history_wipe` / `history_gap`). Push events are only sent to sessions
    /// that subscribed, so clients that predate them never see unknown kinds.
    HistorySubscribe,
}

#[derive(Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UploadDestinationRequest {
    #[default]
    Attachments,
    Cwd,
}

impl From<UploadDestinationRequest> for crate::upload::UploadDestination {
    fn from(value: UploadDestinationRequest) -> Self {
        match value {
            UploadDestinationRequest::Attachments => Self::Attachments,
            UploadDestinationRequest::Cwd => Self::Cwd,
        }
    }
}

fn default_history_lines() -> u16 {
    400
}

fn default_snapshot_lines() -> u16 {
    5_000
}

impl ControlRequest {
    pub fn decode(text: &str) -> Result<Self, ProtocolError> {
        if text.len() > MAX_REQUEST_BYTES {
            return Err(ProtocolError::new(
                None,
                "request_too_large",
                "control request exceeds 16 KiB",
            ));
        }
        let request: Self = serde_json::from_str(text).map_err(|error| {
            ProtocolError::new(
                None,
                "malformed_request",
                &format!("invalid request: {error}"),
            )
        })?;
        if request.version != PROTOCOL_VERSION {
            return Err(ProtocolError::new(
                Some(request.request_id),
                "unsupported_version",
                "unsupported spawn.ctl protocol version",
            ));
        }
        request.validate()?;
        Ok(request)
    }

    fn validate(&self) -> Result<(), ProtocolError> {
        let invalid_size = |cols: u16, rows: u16| {
            !(MIN_COLS..=MAX_COLS).contains(&cols) || !(MIN_ROWS..=MAX_ROWS).contains(&rows)
        };
        let invalid = match &self.operation {
            ControlOperation::History {
                lines, cols, rows, ..
            } => {
                *lines == 0
                    || *lines > MAX_HISTORY_LINES
                    || cols
                        .as_ref()
                        .zip(rows.as_ref())
                        .is_some_and(|(cols, rows)| invalid_size(*cols, *rows))
                    || cols.is_some() != rows.is_some()
            }
            ControlOperation::Snapshot { lines, .. } => *lines == 0 || *lines > MAX_HISTORY_LINES,
            ControlOperation::Resize { cols, rows }
            | ControlOperation::TakeControl { cols, rows } => invalid_size(*cols, *rows),
            ControlOperation::Scroll { lines } => {
                *lines == 0 || !(-MAX_SCROLL_LINES..=MAX_SCROLL_LINES).contains(lines)
            }
            ControlOperation::Redraw => false,
            ControlOperation::UploadStart {
                ref name,
                ref mime_type,
                ref sha256,
                destination,
                total_bytes,
                chunks,
                ..
            } => crate::upload::UploadManifest {
                name: name.clone(),
                mime_type: mime_type.clone(),
                destination: match destination {
                    UploadDestinationRequest::Attachments => {
                        crate::upload::UploadDestination::Attachments
                    }
                    UploadDestinationRequest::Cwd => crate::upload::UploadDestination::Cwd,
                },
                total_bytes: *total_bytes,
                chunks: *chunks,
                sha256: sha256.clone(),
            }
            .validate()
            .is_err(),
            ControlOperation::UploadCancel { .. } => false,
            ControlOperation::HistorySubscribe => false,
        };
        if invalid {
            return Err(ProtocolError::new(
                Some(self.request_id),
                "invalid_parameters",
                "control request parameters are outside protocol limits",
            ));
        }
        Ok(())
    }

    pub fn operation_name(&self) -> &'static str {
        match &self.operation {
            ControlOperation::History { .. } => "history",
            ControlOperation::Snapshot { .. } => "snapshot",
            ControlOperation::Resize { .. } => "resize",
            ControlOperation::Scroll { .. } => "scroll",
            ControlOperation::Redraw => "redraw",
            ControlOperation::UploadStart { .. } => "upload_start",
            ControlOperation::UploadCancel { .. } => "upload_cancel",
            ControlOperation::TakeControl { .. } => "take_control",
            ControlOperation::HistorySubscribe => "history_subscribe",
        }
    }
}

#[derive(Debug)]
pub struct ProtocolError {
    pub request_id: Option<Uuid>,
    pub code: &'static str,
    pub detail: String,
}

impl ProtocolError {
    pub fn new(request_id: Option<Uuid>, code: &'static str, detail: &str) -> Self {
        Self {
            request_id,
            code,
            detail: detail.chars().take(512).collect(),
        }
    }
}

#[derive(Serialize)]
struct ErrorResponse<'a> {
    version: u8,
    kind: &'static str,
    request_id: Option<Uuid>,
    ok: bool,
    error: ErrorBody<'a>,
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    code: &'a str,
    detail: &'a str,
}

#[derive(Serialize)]
struct AckResponse<'a> {
    version: u8,
    kind: &'static str,
    request_id: Uuid,
    operation: &'a str,
    ok: bool,
}

#[derive(Serialize)]
struct ReplayResponse<'a> {
    version: u8,
    kind: &'static str,
    request_id: Uuid,
    operation: &'a str,
    ok: bool,
    plain: bool,
    pty_offset: Option<u64>,
    total_bytes: usize,
    chunks: usize,
    /// Committed-history anchor at capture. The epoch is a string because it
    /// is a u64 nonce that exceeds JavaScript's safe-integer range.
    #[serde(skip_serializing_if = "Option::is_none")]
    history_epoch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    history_offset: Option<u64>,
}

/// Committed-history push event. `data` carries one base64 batch of committed
/// lines for `history_delta`; it is empty for `history_wipe` (scrollback was
/// erased) and `history_gap` (deltas were lost; re-anchor from a snapshot).
#[derive(Serialize)]
struct HistoryEventMessage<'a> {
    version: u8,
    kind: &'static str,
    event: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    history_epoch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    history_offset: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<&'a str>,
}

/// Queue one committed-history push event. Failures mean the control channel
/// is going away; the caller stops its pump.
pub async fn send_history_event(
    sender: &ControlSender,
    event: HistoryEvent<'_>,
) -> Result<(), ProtocolError> {
    let message = match event {
        HistoryEvent::Delta {
            epoch,
            offset,
            data,
        } => HistoryEventMessage {
            version: PROTOCOL_VERSION,
            kind: "event",
            event: "history_delta",
            history_epoch: Some(epoch.to_string()),
            history_offset: Some(offset),
            data: Some(data),
        },
        HistoryEvent::Wipe { epoch } => HistoryEventMessage {
            version: PROTOCOL_VERSION,
            kind: "event",
            event: "history_wipe",
            history_epoch: Some(epoch.to_string()),
            history_offset: None,
            data: None,
        },
        HistoryEvent::Gap => HistoryEventMessage {
            version: PROTOCOL_VERSION,
            kind: "event",
            event: "history_gap",
            history_epoch: None,
            history_offset: None,
            data: None,
        },
    };
    let text = serde_json::to_string(&message).map_err(|error| {
        ProtocolError::new(
            None,
            "encode_failed",
            &format!("encoding history event failed: {error}"),
        )
    })?;
    enqueue(sender, ControlOutbound::Text(text), None).await
}

pub enum HistoryEvent<'a> {
    Delta {
        epoch: u64,
        offset: u64,
        data: &'a str,
    },
    Wipe {
        epoch: u64,
    },
    Gap,
}

pub async fn send_pty_gap(sender: &ControlSender, offset: u64) -> Result<(), ProtocolError> {
    let text = serde_json::json!({"type": "pty_gap", "offset": offset}).to_string();
    enqueue(sender, ControlOutbound::Text(text), None).await
}

#[derive(Serialize)]
struct ReadyEvent {
    version: u8,
    kind: &'static str,
    event: &'static str,
    upload_capability: Uuid,
    agent_generation: u64,
    upload_max_bytes: usize,
    upload_chunk_bytes: usize,
}

#[derive(Serialize)]
struct UploadReadyResponse {
    version: u8,
    kind: &'static str,
    request_id: Uuid,
    operation: &'static str,
    ok: bool,
    state: &'static str,
    next_sequence: u32,
    received_bytes: usize,
}

#[derive(Serialize)]
struct UploadCompleteResponse<'a> {
    version: u8,
    kind: &'static str,
    request_id: Uuid,
    operation: &'static str,
    ok: bool,
    state: &'static str,
    path: &'a str,
    total_bytes: usize,
    sha256: &'a str,
}

async fn enqueue(
    sender: &ControlSender,
    message: ControlOutbound,
    request_id: Option<Uuid>,
) -> Result<(), ProtocolError> {
    sender
        .send_timeout(message, OUTBOUND_ENQUEUE_TIMEOUT)
        .await
        .map_err(|mut error| {
            let code = match &mut error {
                mpsc::error::SendTimeoutError::Timeout(message) => {
                    message.wipe();
                    "viewer_backpressure"
                }
                mpsc::error::SendTimeoutError::Closed(message) => {
                    message.wipe();
                    "channel_closed"
                }
            };
            ProtocolError::new(
                request_id,
                code,
                "spawn.ctl viewer is not accepting responses",
            )
        })
}

pub async fn send_error(sender: &ControlSender, error: &ProtocolError) {
    let response = ErrorResponse {
        version: PROTOCOL_VERSION,
        kind: "response",
        request_id: error.request_id,
        ok: false,
        error: ErrorBody {
            code: error.code,
            detail: &error.detail,
        },
    };
    if let Ok(text) = serde_json::to_string(&response) {
        let _ = enqueue(sender, ControlOutbound::Text(text), error.request_id).await;
    }
}

pub async fn send_ack(
    sender: &ControlSender,
    request_id: Uuid,
    operation: &str,
) -> Result<(), ProtocolError> {
    let response = AckResponse {
        version: PROTOCOL_VERSION,
        kind: "response",
        request_id,
        operation,
        ok: true,
    };
    let text = serde_json::to_string(&response).map_err(|error| {
        ProtocolError::new(
            Some(request_id),
            "encode_failed",
            &format!("encoding acknowledgement failed: {error}"),
        )
    })?;
    enqueue(sender, ControlOutbound::Text(text), Some(request_id)).await
}

pub async fn send_ready(
    sender: &ControlSender,
    upload_capability: Uuid,
    agent_generation: u64,
) -> Result<(), ProtocolError> {
    let event = ReadyEvent {
        version: PROTOCOL_VERSION,
        kind: "event",
        event: "ready",
        upload_capability,
        agent_generation,
        upload_max_bytes: crate::upload::MAX_UPLOAD_BYTES,
        upload_chunk_bytes: crate::upload::UPLOAD_CHUNK_BYTES,
    };
    let text = serde_json::to_string(&event).map_err(|error| {
        ProtocolError::new(
            None,
            "encode_failed",
            &format!("encoding channel readiness failed: {error}"),
        )
    })?;
    enqueue(sender, ControlOutbound::Text(text), None).await
}

pub async fn send_upload_ready(
    sender: &ControlSender,
    request_id: Uuid,
    next_sequence: u32,
    received_bytes: usize,
) -> Result<(), ProtocolError> {
    let response = UploadReadyResponse {
        version: PROTOCOL_VERSION,
        kind: "response",
        request_id,
        operation: "upload_start",
        ok: true,
        state: "ready",
        next_sequence,
        received_bytes,
    };
    let text = serde_json::to_string(&response).map_err(|error| {
        ProtocolError::new(
            Some(request_id),
            "encode_failed",
            &format!("encoding upload readiness failed: {error}"),
        )
    })?;
    enqueue(sender, ControlOutbound::Text(text), Some(request_id)).await
}

pub async fn send_upload_complete(
    sender: &ControlSender,
    request_id: Uuid,
    result: &crate::upload::UploadResult,
) -> Result<(), ProtocolError> {
    let response = UploadCompleteResponse {
        version: PROTOCOL_VERSION,
        kind: "response",
        request_id,
        operation: "upload_complete",
        ok: true,
        state: "complete",
        path: &result.path,
        total_bytes: result.total_bytes,
        sha256: &result.sha256,
    };
    let text = serde_json::to_string(&response).map_err(|error| {
        ProtocolError::new(
            Some(request_id),
            "encode_failed",
            &format!("encoding upload completion failed: {error}"),
        )
    })?;
    enqueue(sender, ControlOutbound::Text(text), Some(request_id)).await
}

pub async fn send_replay(
    sender: &ControlSender,
    request_id: Uuid,
    operation: &str,
    plain: bool,
    pty_offset: Option<u64>,
    replay: &crate::pty::WorkerReplay,
) -> Result<(), ProtocolError> {
    let bytes = replay.bytes();
    if bytes.len() > MAX_REPLAY_BYTES {
        return Err(ProtocolError::new(
            Some(request_id),
            "response_too_large",
            "replay exceeds the 12 MiB spawn.ctl response limit",
        ));
    }
    let chunks = bytes.len().div_ceil(CHUNK_PAYLOAD_BYTES);
    let history_anchor = replay.history_anchor();
    let response = ReplayResponse {
        version: PROTOCOL_VERSION,
        kind: "response",
        request_id,
        operation,
        ok: true,
        plain,
        pty_offset,
        total_bytes: bytes.len(),
        chunks,
        history_epoch: history_anchor.map(|(epoch, _)| epoch.to_string()),
        history_offset: history_anchor.map(|(_, offset)| offset),
    };
    let text = serde_json::to_string(&response).map_err(|error| {
        ProtocolError::new(
            Some(request_id),
            "encode_failed",
            &format!("encoding replay metadata failed: {error}"),
        )
    })?;
    enqueue(sender, ControlOutbound::Text(text), Some(request_id)).await?;
    for (sequence, payload) in bytes.chunks(CHUNK_PAYLOAD_BYTES).enumerate() {
        let last = sequence + 1 == chunks;
        enqueue(
            sender,
            ControlOutbound::Binary(encode_chunk(request_id, sequence as u32, last, payload)),
            Some(request_id),
        )
        .await?;
    }
    Ok(())
}

fn encode_chunk(request_id: Uuid, sequence: u32, last: bool, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(CHUNK_HEADER_LEN + payload.len());
    frame.extend_from_slice(CHUNK_MAGIC);
    frame.push(PROTOCOL_VERSION);
    frame.push(CHUNK_KIND_REPLAY);
    let flags = if last { CHUNK_FLAG_LAST } else { 0_u16 };
    frame.extend_from_slice(&flags.to_le_bytes());
    frame.extend_from_slice(request_id.as_bytes());
    frame.extend_from_slice(&sequence.to_le_bytes());
    frame.extend_from_slice(payload);
    frame
}

pub struct UploadChunk {
    pub upload_id: Uuid,
    pub sequence: u32,
    pub last: bool,
    pub payload: Vec<u8>,
}

impl Drop for UploadChunk {
    fn drop(&mut self) {
        self.payload.zeroize();
    }
}

pub fn decode_upload_chunk(bytes: &[u8]) -> Result<UploadChunk, ProtocolError> {
    let request_id = (bytes.len() >= 24)
        .then(|| Uuid::from_slice(&bytes[8..24]).ok())
        .flatten();
    if bytes.len() <= CHUNK_HEADER_LEN
        || bytes.len() > CHUNK_HEADER_LEN + crate::upload::UPLOAD_CHUNK_BYTES
        || &bytes[..bytes.len().min(4)] != CHUNK_MAGIC
        || bytes.get(4) != Some(&PROTOCOL_VERSION)
        || bytes.get(5) != Some(&CHUNK_KIND_UPLOAD)
    {
        return Err(ProtocolError::new(
            request_id,
            "malformed_upload_chunk",
            "upload chunk framing is invalid",
        ));
    }
    let flags = u16::from_le_bytes(bytes[6..8].try_into().unwrap());
    if flags & !CHUNK_FLAG_LAST != 0 {
        return Err(ProtocolError::new(
            request_id,
            "malformed_upload_chunk",
            "upload chunk flags are invalid",
        ));
    }
    let Some(upload_id) = request_id else {
        return Err(ProtocolError::new(
            None,
            "malformed_upload_chunk",
            "upload chunk id is invalid",
        ));
    };
    Ok(UploadChunk {
        upload_id,
        sequence: u32::from_le_bytes(bytes[24..28].try_into().unwrap()),
        last: flags & CHUNK_FLAG_LAST != 0,
        payload: bytes[CHUNK_HEADER_LEN..].to_vec(),
    })
}

#[derive(Clone, Default)]
pub struct SessionControlHub {
    inner: Arc<Mutex<HashMap<Uuid, DisplayState>>>,
    transactions: Arc<Mutex<HashMap<Uuid, Arc<Mutex<()>>>>>,
}

#[derive(Default)]
struct DisplayState {
    viewers: HashMap<String, ViewerEntry>,
    order: Vec<String>,
    owner: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
}

struct ViewerEntry {
    display: DisplaySender,
}

impl SessionControlHub {
    pub async fn transaction(&self, session_id: Uuid) -> Arc<Mutex<()>> {
        self.transactions
            .lock()
            .await
            .entry(session_id)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub async fn register(&self, session_id: Uuid, viewer_id: String, display: DisplaySender) {
        let transaction = self.transaction(session_id).await;
        let _guard = transaction.lock().await;
        {
            let mut states = self.inner.lock().await;
            let state = states.entry(session_id).or_default();
            if !state.viewers.contains_key(&viewer_id) {
                state.order.push(viewer_id.clone());
            }
            state
                .viewers
                .insert(viewer_id.clone(), ViewerEntry { display });
            state.order.retain(|id| state.viewers.contains_key(id));
            if state
                .owner
                .as_ref()
                .is_none_or(|id| !state.viewers.contains_key(id))
            {
                state.owner = state.order.first().cloned();
            }
        }
        self.broadcast(session_id).await;
    }

    pub async fn unregister(&self, session_id: Uuid, viewer_id: &str) {
        let transaction = self.transaction(session_id).await;
        {
            let _guard = transaction.lock().await;
            self.unregister_in_transaction(session_id, viewer_id).await;
        }
        self.evict_transaction_if_idle(session_id, &transaction)
            .await;
    }

    async fn unregister_in_transaction(&self, session_id: Uuid, viewer_id: &str) {
        let should_broadcast = {
            let mut states = self.inner.lock().await;
            let Some(state) = states.get_mut(&session_id) else {
                return;
            };
            state.viewers.remove(viewer_id);
            state.order.retain(|id| id != viewer_id);
            if state.owner.as_deref() == Some(viewer_id) {
                state.owner = state.order.first().cloned();
            }
            if state.viewers.is_empty() {
                states.remove(&session_id);
                false
            } else {
                true
            }
        };
        if should_broadcast {
            self.broadcast(session_id).await;
        }
    }

    /// Remove all display/lifecycle state when a session backend is removed.
    pub async fn remove_session(&self, session_id: Uuid) {
        let transaction = self.transaction(session_id).await;
        {
            let _guard = transaction.lock().await;
            self.inner.lock().await.remove(&session_id);
        }
        self.evict_transaction_if_idle(session_id, &transaction)
            .await;
    }

    async fn evict_transaction_if_idle(&self, session_id: Uuid, transaction: &Arc<Mutex<()>>) {
        if self.inner.lock().await.contains_key(&session_id) {
            return;
        }
        let mut transactions = self.transactions.lock().await;
        if transactions.get(&session_id).is_some_and(|current| {
            Arc::ptr_eq(current, transaction) && Arc::strong_count(current) == 2
        }) {
            transactions.remove(&session_id);
        }
    }

    #[cfg(test)]
    pub(crate) async fn retained_counts(&self) -> (usize, usize) {
        (
            self.inner.lock().await.len(),
            self.transactions.lock().await.len(),
        )
    }

    pub async fn unregister_viewer(&self, viewer_id: &str) {
        let session_ids = {
            let states = self.inner.lock().await;
            states
                .iter()
                .filter_map(|(session_id, state)| {
                    state.viewers.contains_key(viewer_id).then_some(*session_id)
                })
                .collect::<Vec<_>>()
        };
        for session_id in session_ids {
            self.unregister(session_id, viewer_id).await;
        }
    }

    pub async fn is_owner(&self, session_id: Uuid, viewer_id: &str) -> bool {
        self.inner
            .lock()
            .await
            .get(&session_id)
            .is_some_and(|state| state.owner.as_deref() == Some(viewer_id))
    }

    pub async fn contains_viewer(&self, session_id: Uuid, viewer_id: &str) -> bool {
        self.inner
            .lock()
            .await
            .get(&session_id)
            .is_some_and(|state| state.viewers.contains_key(viewer_id))
    }

    pub async fn take_control(
        &self,
        session_id: Uuid,
        viewer_id: &str,
        cols: u16,
        rows: u16,
    ) -> bool {
        let changed = {
            let mut states = self.inner.lock().await;
            let Some(state) = states.get_mut(&session_id) else {
                return false;
            };
            if !state.viewers.contains_key(viewer_id) {
                return false;
            }
            let changed = state.owner.as_deref() != Some(viewer_id)
                || state.cols != Some(cols)
                || state.rows != Some(rows);
            state.owner = Some(viewer_id.to_string());
            state.cols = Some(cols);
            state.rows = Some(rows);
            changed
        };
        self.broadcast(session_id).await;
        changed
    }

    pub async fn update_size(
        &self,
        session_id: Uuid,
        viewer_id: &str,
        cols: u16,
        rows: u16,
    ) -> Option<bool> {
        let changed = {
            let mut states = self.inner.lock().await;
            let state = states.get_mut(&session_id)?;
            if state.owner.as_deref() != Some(viewer_id) {
                return None;
            }
            let changed = state.cols != Some(cols) || state.rows != Some(rows);
            state.cols = Some(cols);
            state.rows = Some(rows);
            changed
        };
        if changed {
            self.broadcast(session_id).await;
        }
        Some(changed)
    }

    async fn broadcast(&self, session_id: Uuid) {
        let messages = {
            let states = self.inner.lock().await;
            let Some(state) = states.get(&session_id) else {
                return;
            };
            let viewers = state.viewers.len();
            state
                .viewers
                .iter()
                .filter_map(|(viewer_id, viewer)| {
                    let event = DisplayEvent {
                        version: PROTOCOL_VERSION,
                        kind: "event",
                        event: "display_state",
                        owner: state.owner.as_deref() == Some(viewer_id),
                        cols: state.cols,
                        rows: state.rows,
                        viewers,
                    };
                    serde_json::to_string(&event)
                        .ok()
                        .map(|text| (viewer.display.clone(), text))
                })
                .collect::<Vec<_>>()
        };
        for (sender, text) in messages {
            // Display state is latest-value state, not an event log. A watch
            // channel coalesces updates for a stalled viewer without blocking
            // every other viewer behind its full response queue.
            sender.send_replace(Some(text));
        }
    }
}

#[derive(Serialize)]
struct DisplayEvent<'a> {
    version: u8,
    kind: &'static str,
    event: &'a str,
    owner: bool,
    cols: Option<u16>,
    rows: Option<u16>,
    viewers: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_limits_and_versions_are_enforced() {
        let id = Uuid::new_v4();
        let ok = format!(
            r#"{{"version":1,"kind":"request","request_id":"{id}","operation":"snapshot","lines":10000}}"#
        );
        assert!(ControlRequest::decode(&ok).is_ok());

        let oversized_lines = ok.replace("10000", "10001");
        assert_eq!(
            ControlRequest::decode(&oversized_lines).unwrap_err().code,
            "invalid_parameters"
        );
        let wrong_version = ok.replace("\"version\":1", "\"version\":2");
        assert_eq!(
            ControlRequest::decode(&wrong_version).unwrap_err().code,
            "unsupported_version"
        );
        assert_eq!(
            ControlRequest::decode(&"x".repeat(MAX_REQUEST_BYTES + 1))
                .unwrap_err()
                .code,
            "request_too_large"
        );
        assert_eq!(
            ControlRequest::decode("{not-json").unwrap_err().code,
            "malformed_request"
        );
        let partial_geometry = format!(
            r#"{{"version":1,"kind":"request","request_id":"{id}","operation":"history","cols":80}}"#
        );
        assert_eq!(
            ControlRequest::decode(&partial_geometry).unwrap_err().code,
            "invalid_parameters"
        );

        let capability = Uuid::new_v4();
        let upload = format!(
            r#"{{"version":1,"kind":"request","request_id":"{id}","operation":"upload_start","capability":"{capability}","agent_generation":3,"name":"note.txt","mime_type":"text/plain","destination":"cwd","total_bytes":1,"chunks":1,"sha256":"{}"}}"#,
            "00".repeat(32),
        );
        let decoded = ControlRequest::decode(&upload).unwrap();
        assert!(matches!(
            decoded.operation,
            ControlOperation::UploadStart { .. }
        ));
        assert_eq!(
            ControlRequest::decode(&upload.replace("note.txt", "../note.txt"))
                .unwrap_err()
                .code,
            "invalid_parameters"
        );
    }

    #[test]
    fn upload_chunk_framing_is_strict_and_request_bound() {
        let upload_id = Uuid::new_v4();
        let payload = b"secret chunk";
        let mut frame = encode_chunk(upload_id, 7, true, payload);
        frame[5] = CHUNK_KIND_UPLOAD;
        let chunk = decode_upload_chunk(&frame).unwrap();
        assert_eq!(chunk.upload_id, upload_id);
        assert_eq!(chunk.sequence, 7);
        assert!(chunk.last);
        assert_eq!(chunk.payload, payload);

        let mut replay_kind = frame.clone();
        replay_kind[5] = CHUNK_KIND_REPLAY;
        let error = match decode_upload_chunk(&replay_kind) {
            Err(error) => error,
            Ok(_) => panic!("replay kind was accepted as an upload"),
        };
        assert_eq!(error.request_id, Some(upload_id));
        assert_eq!(error.code, "malformed_upload_chunk");

        let mut unknown_flags = frame.clone();
        unknown_flags[6..8].copy_from_slice(&2_u16.to_le_bytes());
        let error = match decode_upload_chunk(&unknown_flags) {
            Err(error) => error,
            Ok(_) => panic!("unknown upload flags were accepted"),
        };
        assert_eq!(error.request_id, Some(upload_id));
        assert!(decode_upload_chunk(&frame[..CHUNK_HEADER_LEN]).is_err());
    }

    #[tokio::test]
    async fn ready_event_binds_upload_limits_capability_and_generation() {
        let capability = Uuid::new_v4();
        let (tx, mut rx) = mpsc::channel(1);
        send_ready(&tx, capability, 42).await.unwrap();
        let message = rx.recv().await.unwrap();
        let ControlOutbound::Text(text) = &message else {
            panic!("expected ready text")
        };
        let value: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(value["upload_capability"], capability.to_string());
        assert_eq!(value["agent_generation"], 42);
        assert_eq!(value["upload_max_bytes"], crate::upload::MAX_UPLOAD_BYTES);
        assert_eq!(
            value["upload_chunk_bytes"],
            crate::upload::UPLOAD_CHUNK_BYTES
        );
    }

    #[test]
    fn outbound_messages_wipe_automatically_on_drop() {
        let observed = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
        CONTROL_WIPE_PROBE.with(|slot| {
            let observed = std::sync::Arc::clone(&observed);
            *slot.borrow_mut() = Some(Box::new(move |bytes| {
                observed.lock().unwrap().extend_from_slice(bytes);
            }));
        });
        drop(ControlOutbound::Binary(b"replay plaintext".to_vec()));
        assert!(observed.lock().unwrap().iter().all(|byte| *byte == 0));
    }

    #[tokio::test]
    async fn replay_is_request_bound_chunked_and_bounded() {
        let id = Uuid::new_v4();
        let (tx, mut rx) = mpsc::channel(8);
        let bytes = vec![7; CHUNK_PAYLOAD_BYTES + 3];
        let replay = crate::pty::WorkerReplay::new(0, bytes);
        send_replay(&tx, id, "snapshot", false, Some(42), &replay)
            .await
            .unwrap();
        let metadata_message = rx.recv().await.unwrap();
        let ControlOutbound::Text(metadata) = &metadata_message else {
            panic!("expected metadata")
        };
        assert!(metadata.contains("\"chunks\":2"));
        for (sequence, expected_len) in [(0_u32, CHUNK_PAYLOAD_BYTES), (1, 3)] {
            let frame_message = rx.recv().await.unwrap();
            let ControlOutbound::Binary(frame) = &frame_message else {
                panic!("expected binary chunk")
            };
            assert_eq!(&frame[..4], CHUNK_MAGIC);
            assert_eq!(&frame[8..24], id.as_bytes());
            assert_eq!(
                u32::from_le_bytes(frame[24..28].try_into().unwrap()),
                sequence
            );
            assert_eq!(frame.len() - CHUNK_HEADER_LEN, expected_len);
            assert!(frame.len() <= 16 * 1024);
        }

        let oversized = crate::pty::WorkerReplay::new(0, vec![0; MAX_REPLAY_BYTES + 1]);
        assert_eq!(
            send_replay(&tx, id, "snapshot", false, None, &oversized,)
                .await
                .unwrap_err()
                .code,
            "response_too_large"
        );
    }

    #[tokio::test]
    async fn replay_framing_matches_the_shared_vector() {
        // proto/session-ctl-replay-framing-v1-vectors.json is asserted by the
        // daemon, the web client and the mobile client alike. The chunk size
        // is the daemon's to choose; a client that assumed a different one
        // discarded every replay longer than one chunk (2026-09-05).
        let vectors: serde_json::Value = serde_json::from_str(include_str!(
            "../../proto/session-ctl-replay-framing-v1-vectors.json"
        ))
        .unwrap();
        assert_eq!(
            vectors["daemon_chunk_payload_bytes"].as_u64().unwrap() as usize,
            CHUNK_PAYLOAD_BYTES
        );
        let min = vectors["min_chunk_payload_bytes"].as_u64().unwrap() as usize;
        let max = vectors["max_chunk_payload_bytes"].as_u64().unwrap() as usize;
        assert!(min <= CHUNK_PAYLOAD_BYTES && CHUNK_PAYLOAD_BYTES <= max);
        for case in vectors["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let total = case["total_bytes"].as_u64().unwrap() as usize;
            let chunks = case["chunks"].as_u64().unwrap() as usize;
            let last = case["last_chunk_bytes"].as_u64().unwrap() as usize;
            let id = Uuid::new_v4();
            let (tx, mut rx) = mpsc::channel(1024);
            let replay = crate::pty::WorkerReplay::new(0, vec![0x41; total]);
            send_replay(&tx, id, "history", false, Some(0), &replay)
                .await
                .unwrap();
            let metadata_message = rx.recv().await.unwrap();
            let ControlOutbound::Text(metadata) = &metadata_message else {
                panic!("{name}: expected metadata")
            };
            let metadata: serde_json::Value = serde_json::from_str(metadata).unwrap();
            assert_eq!(
                metadata["total_bytes"].as_u64().unwrap() as usize,
                total,
                "{name}"
            );
            assert_eq!(
                metadata["chunks"].as_u64().unwrap() as usize,
                chunks,
                "{name}"
            );
            for sequence in 0..chunks {
                let frame_message = rx.recv().await.unwrap();
                let ControlOutbound::Binary(frame) = &frame_message else {
                    panic!("{name}: expected chunk {sequence}")
                };
                let expected = if sequence + 1 == chunks {
                    last
                } else {
                    CHUNK_PAYLOAD_BYTES
                };
                assert_eq!(
                    frame.len() - CHUNK_HEADER_LEN,
                    expected,
                    "{name} chunk {sequence}"
                );
                assert!(frame.len() <= 16 * 1024, "{name} chunk {sequence}");
            }
        }
    }

    #[tokio::test]
    async fn pty_gap_uses_the_cross_client_wire_shape() {
        let (tx, mut rx) = mpsc::channel(1);
        send_pty_gap(&tx, 42).await.unwrap();
        let message = rx.recv().await.unwrap();
        let ControlOutbound::Text(frame) = &message else {
            panic!("expected text gap event")
        };
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(frame).unwrap(),
            serde_json::json!({"type": "pty_gap", "offset": 42})
        );
    }

    #[tokio::test(start_paused = true)]
    async fn stalled_control_viewer_is_disconnected_by_bounded_enqueue() {
        let request_id = Uuid::new_v4();
        let (tx, _rx) = mpsc::channel(1);
        tx.send(ControlOutbound::Text("occupied".into()))
            .await
            .unwrap();

        let blocked_tx = tx.clone();
        let blocked = tokio::spawn(async move {
            send_ack(&blocked_tx, request_id, "redraw")
                .await
                .unwrap_err()
        });
        tokio::task::yield_now().await;
        tokio::time::advance(OUTBOUND_ENQUEUE_TIMEOUT + std::time::Duration::from_millis(1)).await;

        let error = blocked.await.unwrap();
        assert_eq!(error.request_id, Some(request_id));
        assert_eq!(error.code, "viewer_backpressure");
    }

    #[tokio::test]
    async fn display_ownership_promotes_and_notifies_multiple_viewers() {
        let hub = SessionControlHub::default();
        let session_id = Uuid::new_v4();
        let (first_tx, first_rx) = watch::channel(None);
        let (second_tx, second_rx) = watch::channel(None);
        hub.register(session_id, "first".into(), first_tx).await;
        assert!(hub.is_owner(session_id, "first").await);
        hub.register(session_id, "second".into(), second_tx).await;
        assert!(!hub.is_owner(session_id, "second").await);
        assert!(first_rx
            .borrow()
            .as_ref()
            .is_some_and(|text| text.contains("\"owner\":true") && text.contains("\"viewers\":2")));
        assert!(second_rx
            .borrow()
            .as_ref()
            .is_some_and(|text| text.contains("\"owner\":false")));

        let transaction = hub.transaction(session_id).await;
        let guard = transaction.lock().await;
        hub.take_control(session_id, "second", 132, 40).await;
        assert!(hub.is_owner(session_id, "second").await);
        assert!(first_rx
            .borrow()
            .as_ref()
            .is_some_and(|text| text.contains("\"owner\":false")));
        assert!(second_rx
            .borrow()
            .as_ref()
            .is_some_and(|text| text.contains("\"owner\":true")));
        drop(guard);

        hub.unregister(session_id, "second").await;
        assert!(hub.is_owner(session_id, "first").await);
        assert!(first_rx
            .borrow()
            .as_ref()
            .is_some_and(|text| text.contains("\"owner\":true") && text.contains("\"viewers\":1")));
    }

    #[tokio::test]
    async fn ownership_backend_await_and_disconnect_are_one_session_transaction() {
        let hub = SessionControlHub::default();
        let session_id = Uuid::new_v4();
        let (first_tx, first_rx) = watch::channel(None);
        let (second_tx, second_rx) = watch::channel(None);
        hub.register(session_id, "first".into(), first_tx).await;
        hub.register(session_id, "second".into(), second_tx).await;

        let transaction = hub.transaction(session_id).await;
        let transfer_hub = hub.clone();
        let transfer_transaction = transaction.clone();
        let transfer = tokio::spawn(async move {
            let _guard = transfer_transaction.lock().await;
            // Represents the awaited backend resize. Ownership is not exposed
            // until the same transaction commits its geometry.
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            transfer_hub
                .take_control(session_id, "second", 140, 44)
                .await;
        });

        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let disconnect_hub = hub.clone();
        let disconnect = tokio::spawn(async move {
            disconnect_hub.unregister(session_id, "second").await;
        });
        assert!(!disconnect.is_finished());

        transfer.await.unwrap();
        disconnect.await.unwrap();
        assert!(hub.is_owner(session_id, "first").await);
        assert!(first_rx.borrow().as_ref().is_some_and(|text| {
            text.contains("\"owner\":true")
                && text.contains("\"cols\":140")
                && text.contains("\"viewers\":1")
        }));
        assert!(second_rx
            .borrow()
            .as_ref()
            .is_some_and(|text| text.contains("\"owner\":true")));
    }

    #[tokio::test]
    async fn idle_session_state_and_transaction_mutex_are_evicted() {
        let hub = SessionControlHub::default();
        let session_id = Uuid::new_v4();
        let (display, _events) = watch::channel(None);
        hub.register(session_id, "viewer".into(), display).await;
        assert_eq!(hub.retained_counts().await, (1, 1));

        hub.unregister(session_id, "viewer").await;
        assert_eq!(hub.retained_counts().await, (0, 0));

        let (display, _events) = watch::channel(None);
        hub.register(session_id, "replacement".into(), display)
            .await;
        hub.remove_session(session_id).await;
        assert_eq!(hub.retained_counts().await, (0, 0));
    }
}
