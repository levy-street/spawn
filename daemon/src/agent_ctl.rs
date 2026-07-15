//! Versioned, bounded protocol for the per-agent `spawn.ctl` DataChannel.
//!
//! Control messages never transit the control-plane websocket. Requests and
//! metadata responses are JSON text messages. Potentially large replay bytes
//! are split into request-bound binary chunks so concurrent requests cannot be
//! confused and no single SCTP message needs to hold an entire replay.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

pub const PROTOCOL_VERSION: u8 = 1;
pub const MAX_REQUEST_BYTES: usize = 16 * 1024;
pub const MAX_REPLAY_BYTES: usize = 12 * 1024 * 1024;
pub const CHUNK_PAYLOAD_BYTES: usize = 48 * 1024;
pub const OUTBOUND_QUEUE_DEPTH: usize = 64;
pub const MAX_HISTORY_LINES: u16 = 10_000;
pub const MIN_COLS: u16 = 20;
pub const MAX_COLS: u16 = 400;
pub const MIN_ROWS: u16 = 5;
pub const MAX_ROWS: u16 = 200;
pub const MAX_SCROLL_LINES: i16 = 200;

const CHUNK_MAGIC: &[u8; 4] = b"SPCT";
const CHUNK_KIND_REPLAY: u8 = 1;
const CHUNK_HEADER_LEN: usize = 4 + 1 + 1 + 2 + 16 + 4;
const CHUNK_FLAG_LAST: u16 = 1;

#[derive(Debug, Clone)]
pub enum ControlOutbound {
    Text(String),
    Binary(Vec<u8>),
}

pub type ControlSender = mpsc::Sender<ControlOutbound>;

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
        let invalid = match self.operation {
            ControlOperation::History {
                lines, cols, rows, ..
            } => {
                lines == 0
                    || lines > MAX_HISTORY_LINES
                    || cols
                        .zip(rows)
                        .is_some_and(|(cols, rows)| invalid_size(cols, rows))
                    || cols.is_some() != rows.is_some()
            }
            ControlOperation::Snapshot { lines, .. } => lines == 0 || lines > MAX_HISTORY_LINES,
            ControlOperation::Resize { cols, rows }
            | ControlOperation::TakeControl { cols, rows } => invalid_size(cols, rows),
            ControlOperation::Scroll { lines } => {
                lines == 0 || !(-MAX_SCROLL_LINES..=MAX_SCROLL_LINES).contains(&lines)
            }
            ControlOperation::Redraw => false,
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
        match self.operation {
            ControlOperation::History { .. } => "history",
            ControlOperation::Snapshot { .. } => "snapshot",
            ControlOperation::Resize { .. } => "resize",
            ControlOperation::Scroll { .. } => "scroll",
            ControlOperation::Redraw => "redraw",
            ControlOperation::TakeControl { .. } => "take_control",
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
        let _ = sender.send(ControlOutbound::Text(text)).await;
    }
}

pub async fn send_ack(sender: &ControlSender, request_id: Uuid, operation: &str) {
    let response = AckResponse {
        version: PROTOCOL_VERSION,
        kind: "response",
        request_id,
        operation,
        ok: true,
    };
    if let Ok(text) = serde_json::to_string(&response) {
        let _ = sender.send(ControlOutbound::Text(text)).await;
    }
}

pub async fn send_replay(
    sender: &ControlSender,
    request_id: Uuid,
    operation: &str,
    plain: bool,
    pty_offset: Option<u64>,
    bytes: Vec<u8>,
) -> Result<(), ProtocolError> {
    if bytes.len() > MAX_REPLAY_BYTES {
        return Err(ProtocolError::new(
            Some(request_id),
            "response_too_large",
            "replay exceeds the 12 MiB spawn.ctl response limit",
        ));
    }
    let chunks = bytes.len().div_ceil(CHUNK_PAYLOAD_BYTES);
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
    };
    let text = serde_json::to_string(&response).map_err(|error| {
        ProtocolError::new(
            Some(request_id),
            "encode_failed",
            &format!("encoding replay metadata failed: {error}"),
        )
    })?;
    sender
        .send(ControlOutbound::Text(text))
        .await
        .map_err(|_| ProtocolError::new(Some(request_id), "channel_closed", "channel closed"))?;
    for (sequence, payload) in bytes.chunks(CHUNK_PAYLOAD_BYTES).enumerate() {
        let last = sequence + 1 == chunks;
        sender
            .send(ControlOutbound::Binary(encode_chunk(
                request_id,
                sequence as u32,
                last,
                payload,
            )))
            .await
            .map_err(|_| {
                ProtocolError::new(Some(request_id), "channel_closed", "channel closed")
            })?;
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

#[derive(Clone, Default)]
pub struct AgentControlHub {
    inner: Arc<Mutex<HashMap<Uuid, DisplayState>>>,
}

#[derive(Default)]
struct DisplayState {
    viewers: HashMap<String, ControlSender>,
    order: Vec<String>,
    owner: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
}

impl AgentControlHub {
    pub async fn register(&self, agent_id: Uuid, session_id: String, sender: ControlSender) {
        {
            let mut states = self.inner.lock().await;
            let state = states.entry(agent_id).or_default();
            if !state.viewers.contains_key(&session_id) {
                state.order.push(session_id.clone());
            }
            state.viewers.insert(session_id.clone(), sender);
            state.order.retain(|id| state.viewers.contains_key(id));
            if state
                .owner
                .as_ref()
                .is_none_or(|id| !state.viewers.contains_key(id))
            {
                state.owner = state.order.first().cloned();
            }
        }
        self.broadcast(agent_id).await;
    }

    pub async fn unregister(&self, agent_id: Uuid, session_id: &str) {
        let should_broadcast = {
            let mut states = self.inner.lock().await;
            let Some(state) = states.get_mut(&agent_id) else {
                return;
            };
            state.viewers.remove(session_id);
            state.order.retain(|id| id != session_id);
            if state.owner.as_deref() == Some(session_id) {
                state.owner = state.order.first().cloned();
            }
            if state.viewers.is_empty() {
                states.remove(&agent_id);
                false
            } else {
                true
            }
        };
        if should_broadcast {
            self.broadcast(agent_id).await;
        }
    }

    pub async fn unregister_session(&self, session_id: &str) {
        let agent_ids = {
            let states = self.inner.lock().await;
            states
                .iter()
                .filter_map(|(agent_id, state)| {
                    state.viewers.contains_key(session_id).then_some(*agent_id)
                })
                .collect::<Vec<_>>()
        };
        for agent_id in agent_ids {
            self.unregister(agent_id, session_id).await;
        }
    }

    pub async fn is_owner(&self, agent_id: Uuid, session_id: &str) -> bool {
        self.inner
            .lock()
            .await
            .get(&agent_id)
            .is_some_and(|state| state.owner.as_deref() == Some(session_id))
    }

    pub async fn contains_viewer(&self, agent_id: Uuid, session_id: &str) -> bool {
        self.inner
            .lock()
            .await
            .get(&agent_id)
            .is_some_and(|state| state.viewers.contains_key(session_id))
    }

    pub async fn take_control(
        &self,
        agent_id: Uuid,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> bool {
        let changed = {
            let mut states = self.inner.lock().await;
            let Some(state) = states.get_mut(&agent_id) else {
                return false;
            };
            if !state.viewers.contains_key(session_id) {
                return false;
            }
            let changed = state.owner.as_deref() != Some(session_id)
                || state.cols != Some(cols)
                || state.rows != Some(rows);
            state.owner = Some(session_id.to_string());
            state.cols = Some(cols);
            state.rows = Some(rows);
            changed
        };
        self.broadcast(agent_id).await;
        changed
    }

    pub async fn update_size(
        &self,
        agent_id: Uuid,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Option<bool> {
        let changed = {
            let mut states = self.inner.lock().await;
            let state = states.get_mut(&agent_id)?;
            if state.owner.as_deref() != Some(session_id) {
                return None;
            }
            let changed = state.cols != Some(cols) || state.rows != Some(rows);
            state.cols = Some(cols);
            state.rows = Some(rows);
            changed
        };
        if changed {
            self.broadcast(agent_id).await;
        }
        Some(changed)
    }

    async fn broadcast(&self, agent_id: Uuid) {
        let messages = {
            let states = self.inner.lock().await;
            let Some(state) = states.get(&agent_id) else {
                return;
            };
            let viewers = state.viewers.len();
            state
                .viewers
                .iter()
                .filter_map(|(session_id, sender)| {
                    let event = DisplayEvent {
                        version: PROTOCOL_VERSION,
                        kind: "event",
                        event: "display_state",
                        owner: state.owner.as_deref() == Some(session_id),
                        cols: state.cols,
                        rows: state.rows,
                        viewers,
                    };
                    serde_json::to_string(&event)
                        .ok()
                        .map(|text| (sender.clone(), text))
                })
                .collect::<Vec<_>>()
        };
        for (sender, text) in messages {
            // Preserve state transitions behind any already-queued response
            // chunks for this viewer. The queue is bounded; a closed channel
            // fails immediately and its RTC cleanup removes the viewer.
            let _ = sender.send(ControlOutbound::Text(text)).await;
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
    }

    #[tokio::test]
    async fn replay_is_request_bound_chunked_and_bounded() {
        let id = Uuid::new_v4();
        let (tx, mut rx) = mpsc::channel(8);
        let bytes = vec![7; CHUNK_PAYLOAD_BYTES + 3];
        send_replay(&tx, id, "snapshot", false, Some(42), bytes.clone())
            .await
            .unwrap();
        let ControlOutbound::Text(metadata) = rx.recv().await.unwrap() else {
            panic!("expected metadata")
        };
        assert!(metadata.contains("\"chunks\":2"));
        for (sequence, expected_len) in [(0_u32, CHUNK_PAYLOAD_BYTES), (1, 3)] {
            let ControlOutbound::Binary(frame) = rx.recv().await.unwrap() else {
                panic!("expected binary chunk")
            };
            assert_eq!(&frame[..4], CHUNK_MAGIC);
            assert_eq!(&frame[8..24], id.as_bytes());
            assert_eq!(
                u32::from_le_bytes(frame[24..28].try_into().unwrap()),
                sequence
            );
            assert_eq!(frame.len() - CHUNK_HEADER_LEN, expected_len);
        }

        assert_eq!(
            send_replay(
                &tx,
                id,
                "snapshot",
                false,
                None,
                vec![0; MAX_REPLAY_BYTES + 1],
            )
            .await
            .unwrap_err()
            .code,
            "response_too_large"
        );
    }

    #[tokio::test]
    async fn display_ownership_promotes_and_notifies_multiple_viewers() {
        let hub = AgentControlHub::default();
        let agent_id = Uuid::new_v4();
        let (first_tx, mut first_rx) = mpsc::channel(8);
        let (second_tx, mut second_rx) = mpsc::channel(8);
        hub.register(agent_id, "first".into(), first_tx).await;
        assert!(hub.is_owner(agent_id, "first").await);
        hub.register(agent_id, "second".into(), second_tx).await;
        assert!(!hub.is_owner(agent_id, "second").await);
        hub.take_control(agent_id, "second", 132, 40).await;
        assert!(hub.is_owner(agent_id, "second").await);
        hub.unregister(agent_id, "second").await;
        assert!(hub.is_owner(agent_id, "first").await);

        let mut first_events = Vec::new();
        while let Ok(ControlOutbound::Text(text)) = first_rx.try_recv() {
            first_events.push(text);
        }
        assert!(first_events
            .iter()
            .any(|text| { text.contains("\"owner\":false") && text.contains("\"viewers\":2") }));
        assert!(first_events.last().unwrap().contains("\"owner\":true"));
        let mut second_events = Vec::new();
        while let Ok(ControlOutbound::Text(text)) = second_rx.try_recv() {
            second_events.push(text);
        }
        assert!(second_events
            .iter()
            .any(|text| text.contains("\"owner\":true")));
    }
}
