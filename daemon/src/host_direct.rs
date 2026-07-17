//! Protected host-control frames and their only publication capability.
//!
//! This module intentionally has no dependency on daemon WebSocket types,
//! server queues, or any crate-local signaling module. `HostDirectChannel`
//! owns only one RTC DataChannel, so values handed to it cannot be redirected
//! to the server without changing this reviewed dependency boundary.

use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;
use webrtc::data_channel::RTCDataChannel;

const MAX_PROTECTED_FRAME_BYTES: usize = 16 * 1024;

#[derive(Clone)]
pub(crate) struct HostDirectChannel {
    dc: Arc<RTCDataChannel>,
}

pub(crate) struct HostWriteChunk {
    pub(crate) stream_id: String,
    pub(crate) sequence: u64,
    pub(crate) bytes: Vec<u8>,
}

impl HostDirectChannel {
    pub(crate) fn new(dc: Arc<RTCDataChannel>) -> Self {
        Self { dc }
    }

    pub(crate) fn transport(&self) -> Arc<RTCDataChannel> {
        Arc::clone(&self.dc)
    }

    pub(crate) async fn publish(&self, value: Value, cancelled: &CancellationToken) -> bool {
        let encoded = value.to_string();
        if encoded.len() > MAX_PROTECTED_FRAME_BYTES {
            return false;
        }
        tokio::select! {
            biased;
            _ = cancelled.cancelled() => false,
            result = self.dc.send_text(encoded) => result.is_ok(),
        }
    }

    pub(crate) async fn publish_read_chunk(
        &self,
        stream_id: &str,
        sequence: u64,
        bytes: &[u8],
        cancelled: &CancellationToken,
    ) -> bool {
        self.publish(
            json!({
                "version": 1,
                "type": "stream.chunk",
                "stream_id": stream_id,
                "sequence": sequence,
                "bytes_b64": STANDARD.encode(bytes),
            }),
            cancelled,
        )
        .await
    }
}

pub(crate) fn decode_write_chunk(
    object: &Map<String, Value>,
    max_id_bytes: usize,
    max_chunk_bytes: usize,
) -> Option<HostWriteChunk> {
    let stream_id = object.get("stream_id")?.as_str()?;
    if stream_id.is_empty()
        || stream_id.len() > max_id_bytes
        || !stream_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return None;
    }
    let sequence = object.get("sequence")?.as_u64()?;
    let encoded = object.get("bytes_b64")?.as_str()?;
    let bytes = STANDARD.decode(encoded).ok()?;
    if bytes.is_empty() || bytes.len() > max_chunk_bytes {
        return None;
    }
    Some(HostWriteChunk {
        stream_id: stream_id.to_string(),
        sequence,
        bytes,
    })
}
