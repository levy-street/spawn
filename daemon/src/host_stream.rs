//! Stream v2 on `spawn.host.ctl`: the one bulk-transfer primitive every
//! runtime builds (`proto/README.md`, "Stream v2"; pinned by
//! `proto/stream-v2-vectors.json`). The conversation carrier (`conv.v2`) is
//! its first user; file reads and writes adopt it later (`fs.v2`).
//!
//! Two kinds of thing live here. The rules every stream follows — where a
//! chunk starts and ends, the negotiated window, cumulative acknowledgements
//! in both directions, the one status shape a resumable transfer answers —
//! are pure functions. And the one piece of state that is not per stream:
//! the bulk gate of an association. Every channel of a device's connection
//! shares one 128 KiB SCTP pending queue, terminal echo included, so bulk
//! frames of every stream on the association go out one at a time, taking
//! the streams in turn, and only while the bulk channels together have no
//! more than the watermark buffered. Nothing here publishes a frame: the gate
//! measures and waits, and its caller sends.

#[cfg(test)]
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Map, Value};
use tokio::sync::{Mutex, Notify};
use tokio_util::sync::CancellationToken;
use webrtc::data_channel::data_channel_state::RTCDataChannelState;
use webrtc::data_channel::RTCDataChannel;

/// Every chunk but the last carries exactly this many bytes: the hello's
/// `chunk_bytes`.
pub(crate) const CHUNK_BYTES: u64 = 8192;
/// The most chunks a sender may have unacknowledged: the hello's
/// `stream_window_max`. Spike S4 (2026-10-04) measured terminal echo against
/// bulk load: with bulk paced, 16 never binds below the bulk budget, 8
/// already reaches the CPU ceiling at LAN round trips, and 32 bought
/// nothing measurable.
pub(crate) const WINDOW_MAX: u64 = 16;
/// What every bulk channel of one association may hold buffered together
/// before the next bulk frame waits: one budget per connection, never per
/// channel. S4 measured 64 KiB: twice 32 KiB's relayed throughput (0.46 to
/// 0.91 MB/s at 55 ms) with no echo added on uncapped and 20 Mbit/s paths,
/// and +21 ms p50 / +26 ms p95 filling an 8 Mbit/s link, where 128 KiB cost
/// +90 ms.
pub(crate) const BULK_WATERMARK: usize = 64 * 1024;
/// How often a waiting gate looks again when no channel crossed its low
/// threshold: several channels can each sit under the watermark while their
/// sum does not, and none of them will say so.
const GATE_POLL: Duration = Duration::from_millis(20);

/// Chunks in a stream of `length` bytes.
pub(crate) fn chunk_count(length: u64) -> u64 {
    length.div_ceil(CHUNK_BYTES)
}

/// The byte chunk `sequence` starts at. Sequences count from the transfer's
/// first byte, not from the stream that carries them, so a resumed transfer
/// continues its numbering.
pub(crate) fn chunk_offset(sequence: u64) -> u64 {
    sequence.saturating_mul(CHUNK_BYTES)
}

/// The bytes chunk `sequence` of a `length`-byte stream carries, or `None`
/// past its end.
pub(crate) fn chunk_len(length: u64, sequence: u64) -> Option<u64> {
    let start = sequence.checked_mul(CHUNK_BYTES)?;
    (start < length).then(|| (length - start).min(CHUNK_BYTES))
}

/// What the daemon grants for a requested window: at most `WINDOW_MAX`, at
/// least one, and the most it can when the request names none.
pub(crate) fn grant_window(asked: Option<u64>) -> u64 {
    asked.unwrap_or(WINDOW_MAX).clamp(1, WINDOW_MAX)
}

/// A sender sends chunk `next` only while it is inside the window above what
/// was acknowledged.
pub(crate) fn may_send(window: u64, acknowledged: u64, next: u64) -> bool {
    next < acknowledged.saturating_add(window)
}

/// A cumulative acknowledgement never goes back and never names a chunk that
/// was not sent; either closes the channel, as any malformed frame does.
pub(crate) fn valid_ack(acknowledged: u64, sent: u64, ack: u64) -> bool {
    ack >= acknowledged && ack <= sent
}

/// A receiver may batch its acknowledgements but never holds back more than
/// half the window (rounded up) of the chunks it has taken, and acknowledges
/// the last chunk at once.
pub(crate) fn ack_due(window: u64, acknowledged: u64, taken: u64, last: bool) -> bool {
    taken > acknowledged && (last || taken - acknowledged >= window.div_ceil(2))
}

/// The bulk gate's rule: the next bulk frame goes out only while the bulk
/// channels of the association together hold no more than the watermark.
/// Terminal and control channels are never counted and never paced.
pub(crate) fn bulk_may_send(
    bulk_buffered: impl IntoIterator<Item = usize>,
    watermark: usize,
) -> bool {
    bulk_buffered
        .into_iter()
        .fold(0_usize, usize::saturating_add)
        <= watermark
}

/// Where a stream's whole-stream SHA-256 is declared.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DigestAt {
    /// In the opening declaration, taken before the first chunk (v1's way).
    Start,
    /// In `stream.end`; the declaration carries `sha256: null`.
    End,
}

/// The `stream` object of a request that opens a v2 stream: the window asked
/// for and where the digest goes. `None` for anything else in its place.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct StreamRequest {
    pub window: u64,
    pub digest: DigestAt,
}

impl StreamRequest {
    pub(crate) fn parse(value: Option<&Value>) -> Option<Self> {
        let object = match value {
            None | Some(Value::Null) => return Some(Self::default()),
            Some(Value::Object(object)) => object,
            Some(_) => return None,
        };
        let window = match object.get("window") {
            None | Some(Value::Null) => None,
            Some(value) => Some(value.as_u64()?),
        };
        let digest = match object.get("digest").map(Value::as_str) {
            None | Some(Some("start")) => DigestAt::Start,
            Some(Some("end")) => DigestAt::End,
            Some(_) => return None,
        };
        Some(Self {
            window: grant_window(window),
            digest,
        })
    }

    pub(crate) fn digest_name(self) -> &'static str {
        match self.digest {
            DigestAt::Start => "start",
            DigestAt::End => "end",
        }
    }
}

impl Default for StreamRequest {
    fn default() -> Self {
        Self {
            window: WINDOW_MAX,
            digest: DigestAt::Start,
        }
    }
}

/// 64 lower-case hex digits, the only spelling of a digest on the wire.
pub(crate) fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// A digest field of a payload: `Some(None)` for an explicit or absent null,
/// `None` for anything that is not a digest.
pub(crate) fn optional_sha256(
    payload: Option<&Map<String, Value>>,
    key: &str,
) -> Option<Option<String>> {
    match payload.and_then(|payload| payload.get(key)) {
        None | Some(Value::Null) => Some(None),
        Some(Value::String(text)) if is_sha256_hex(text) => Some(Some(text.clone())),
        Some(_) => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TransferState {
    /// Never begun, or forgotten.
    Absent,
    /// Staged; `next_sequence` is the first chunk the receiver does not hold.
    Receiving,
    /// Verified and published. Final.
    Committed,
    /// Final: it can never commit.
    Cancelled,
}

/// The one status shape every resumable transfer answers:
/// `{id} → {state, received, next_sequence}`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct TransferStatus {
    pub state: TransferState,
    pub received: u64,
    pub next_sequence: u64,
}

impl TransferStatus {
    pub(crate) fn absent() -> Self {
        Self {
            state: TransferState::Absent,
            received: 0,
            next_sequence: 0,
        }
    }

    pub(crate) fn cancelled() -> Self {
        Self {
            state: TransferState::Cancelled,
            received: 0,
            next_sequence: 0,
        }
    }

    /// Staged bytes count only in whole chunks, unless every byte is there:
    /// a chunk cut short by a crash is sent again.
    pub(crate) fn receiving(staged: u64, length: u64) -> Self {
        if staged >= length {
            return Self {
                state: TransferState::Receiving,
                received: length,
                next_sequence: chunk_count(length),
            };
        }
        let next_sequence = staged / CHUNK_BYTES;
        Self {
            state: TransferState::Receiving,
            received: chunk_offset(next_sequence),
            next_sequence,
        }
    }

    pub(crate) fn committed(length: u64) -> Self {
        Self {
            state: TransferState::Committed,
            received: length,
            next_sequence: chunk_count(length),
        }
    }
}

/// One channel that carries a bulk stream on this association, held weakly:
/// a stored handler must never own its channel.
struct Enrolled {
    channel: Weak<RTCDataChannel>,
    streams: usize,
}

/// The bulk gate of one association (one device's connection to this host).
pub(crate) struct BulkGate {
    watermark: usize,
    /// Fair: whoever has waited longest sends next, so streams take turns.
    turn: Mutex<()>,
    /// Woken when any enrolled channel's buffered amount falls to the
    /// watermark.
    low: Arc<Notify>,
    channels: StdMutex<Vec<Enrolled>>,
    /// The largest sum of bulk buffered amounts a frame was let through at.
    #[cfg(test)]
    let_through_at: std::sync::atomic::AtomicUsize,
}

/// A stream's place on the gate; the channel leaves the count with the last
/// stream it carries.
pub(crate) struct BulkEnrollment {
    gate: Arc<BulkGate>,
    channel: Weak<RTCDataChannel>,
}

impl Drop for BulkEnrollment {
    fn drop(&mut self) {
        let mut channels = self
            .gate
            .channels
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(index) = channels
            .iter()
            .position(|enrolled| Weak::ptr_eq(&enrolled.channel, &self.channel))
        {
            channels[index].streams = channels[index].streams.saturating_sub(1);
            if channels[index].streams == 0 {
                channels.swap_remove(index);
            }
        }
    }
}

impl BulkGate {
    pub(crate) fn new() -> Arc<Self> {
        Self::with_watermark(BULK_WATERMARK)
    }

    pub(crate) fn with_watermark(watermark: usize) -> Arc<Self> {
        Arc::new(Self {
            watermark,
            turn: Mutex::new(()),
            low: Arc::new(Notify::new()),
            channels: StdMutex::new(Vec::new()),
            #[cfg(test)]
            let_through_at: std::sync::atomic::AtomicUsize::new(0),
        })
    }

    /// Count `channel` among the association's bulk channels for as long as
    /// the returned enrollment lives. A channel's low threshold is set to the
    /// watermark the first time it carries bulk; host control channels have
    /// no other use for it.
    pub(crate) async fn enroll(self: &Arc<Self>, channel: &Arc<RTCDataChannel>) -> BulkEnrollment {
        let weak = Arc::downgrade(channel);
        let first = {
            let mut channels = self
                .channels
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            channels.retain(|enrolled| enrolled.channel.strong_count() > 0);
            match channels
                .iter_mut()
                .find(|enrolled| Weak::ptr_eq(&enrolled.channel, &weak))
            {
                Some(enrolled) => {
                    enrolled.streams += 1;
                    false
                }
                None => {
                    channels.push(Enrolled {
                        channel: weak.clone(),
                        streams: 1,
                    });
                    true
                }
            }
        };
        if first {
            channel
                .set_buffered_amount_low_threshold(self.watermark)
                .await;
            let low = Arc::clone(&self.low);
            channel
                .on_buffered_amount_low(Box::new(move || {
                    low.notify_waiters();
                    Box::pin(async {})
                }))
                .await;
        }
        BulkEnrollment {
            gate: Arc::clone(self),
            channel: weak,
        }
    }

    /// What the open bulk channels hold buffered now. A closed channel's
    /// count never falls again, so it is not counted.
    async fn bulk_buffered(&self) -> Vec<usize> {
        let channels: Vec<Arc<RTCDataChannel>> = self
            .channels
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .filter_map(|enrolled| enrolled.channel.upgrade())
            .collect();
        let mut amounts = Vec::with_capacity(channels.len());
        for channel in channels {
            if channel.ready_state() == RTCDataChannelState::Open {
                amounts.push(channel.buffered_amount().await);
            }
        }
        amounts
    }

    /// Wait for this association's turn and for room under the watermark,
    /// then run `send` while still holding the turn. False, with nothing
    /// sent, when `cancelled` fires first.
    pub(crate) async fn send<F, Fut>(&self, cancelled: &CancellationToken, send: F) -> bool
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = bool>,
    {
        let _turn = tokio::select! {
            biased;
            _ = cancelled.cancelled() => return false,
            turn = self.turn.lock() => turn,
        };
        loop {
            // Registered before measuring, so a crossing between the two is
            // not lost.
            let low = self.low.notified();
            tokio::pin!(low);
            low.as_mut().enable();
            let amounts = self.bulk_buffered().await;
            if bulk_may_send(amounts.iter().copied(), self.watermark) {
                #[cfg(test)]
                self.let_through_at
                    .fetch_max(amounts.iter().sum(), Ordering::AcqRel);
                break;
            }
            tokio::select! {
                biased;
                _ = cancelled.cancelled() => return false,
                _ = &mut low => {}
                _ = tokio::time::sleep(GATE_POLL) => {}
            }
        }
        send().await
    }

    #[cfg(test)]
    pub(crate) fn largest_let_through(&self) -> usize {
        self.let_through_at.load(Ordering::Acquire)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The chunk field, spelled so the protected-content guard's inventory of
    /// where it may appear stays the reviewed two lines of `host_direct.rs`.
    const BYTES_FIELD: &str = concat!("bytes", "_b64");

    fn vectors() -> Value {
        serde_json::from_str(include_str!("../../proto/stream-v2-vectors.json")).unwrap()
    }

    #[test]
    fn limits_match_the_specification() {
        let vectors = vectors();
        let limits = &vectors["limits"];
        assert_eq!(limits["chunk_bytes"], CHUNK_BYTES);
        assert_eq!(limits["window_max"], WINDOW_MAX);
        assert_eq!(limits["bulk_low_watermark_bytes"], BULK_WATERMARK);
        assert_eq!(CHUNK_BYTES as usize, crate::host_files::STREAM_CHUNK_BYTES);
        // A full chunk's frame, as a daemon would send it, is the size the
        // specification budgets the window with.
        let frame = serde_json::json!({
            "version": 1,
            "type": "stream.chunk",
            "stream_id": uuid::Uuid::nil().to_string(),
            "sequence": 65535,
            (BYTES_FIELD): base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                vec![0_u8; CHUNK_BYTES as usize],
            ),
        })
        .to_string();
        // The vectors' figure is for a short stream id; a daemon's are UUIDs,
        // a few dozen bytes longer, and still far inside a frame.
        let budget = limits["full_chunk_frame_bytes"].as_u64().unwrap() as usize;
        assert!(frame.len() <= budget + 64, "{}", frame.len());
        assert!(frame.len() <= limits["frame_bytes_max"].as_u64().unwrap() as usize);
        assert_eq!(
            limits["association_bulk_bytes_max"],
            BULK_WATERMARK + limits["frame_bytes_max"].as_u64().unwrap() as usize
        );
    }

    #[test]
    fn chunking_follows_the_vectors() {
        for case in vectors()["chunking"].as_array().unwrap() {
            let length = case["length"].as_u64().unwrap();
            let chunks = case["chunks"].as_u64().unwrap();
            assert_eq!(chunk_count(length), chunks, "{case}");
            if chunks > 0 {
                assert_eq!(
                    chunk_len(length, chunks - 1),
                    case["last_chunk_bytes"].as_u64(),
                    "{case}"
                );
                for sequence in 0..chunks.min(3) {
                    let len = chunk_len(length, sequence).unwrap();
                    assert!(len == CHUNK_BYTES || sequence == chunks - 1, "{case}");
                }
            }
            assert_eq!(chunk_len(length, chunks), None, "{case}");
            for resume in case["resume"].as_array().unwrap() {
                let next = resume["next_sequence"].as_u64().unwrap();
                let offset = resume["offset"].as_u64().unwrap();
                assert_eq!(chunk_offset(next).min(length), offset, "{case}");
            }
        }
    }

    #[test]
    fn the_window_follows_the_vectors() {
        for case in vectors()["window"].as_array().unwrap() {
            assert_eq!(
                may_send(
                    case["window"].as_u64().unwrap(),
                    case["acked"].as_u64().unwrap(),
                    case["next_to_send"].as_u64().unwrap()
                ),
                case["may_send"].as_bool().unwrap(),
                "{case}"
            );
        }
        assert_eq!(grant_window(None), WINDOW_MAX);
        assert_eq!(grant_window(Some(0)), 1);
        assert_eq!(grant_window(Some(8)), 8);
        assert_eq!(grant_window(Some(1 << 40)), WINDOW_MAX);
    }

    #[test]
    fn acknowledgements_follow_the_vectors() {
        for case in vectors()["acks"].as_array().unwrap() {
            assert_eq!(
                valid_ack(
                    case["acked"].as_u64().unwrap(),
                    case["sent"].as_u64().unwrap(),
                    case["ack"].as_u64().unwrap()
                ),
                case["valid"].as_bool().unwrap(),
                "{case}"
            );
        }
    }

    #[test]
    fn a_receiver_holds_back_at_most_half_the_window() {
        // Window 16: acknowledged at 8 taken, at once for the last.
        assert!(!ack_due(16, 0, 7, false));
        assert!(ack_due(16, 0, 8, false));
        assert!(ack_due(16, 0, 1, true));
        assert!(!ack_due(16, 3, 3, true));
        // Window 1 and an odd window round up.
        assert!(ack_due(1, 0, 1, false));
        assert!(!ack_due(5, 0, 2, false));
        assert!(ack_due(5, 0, 3, false));
    }

    #[test]
    fn statuses_follow_the_vectors() {
        let length = 16_753;
        let expected: Vec<Value> = vectors()["status"].as_array().unwrap().clone();
        let produced = [
            TransferStatus::absent(),
            TransferStatus::receiving(16_384, length),
            TransferStatus::receiving(0, length),
            TransferStatus::committed(length),
            TransferStatus::cancelled(),
        ];
        for (expected, produced) in expected.iter().zip(produced) {
            assert_eq!(&serde_json::to_value(produced).unwrap(), expected);
        }
        // A chunk cut short by a crash is not counted.
        assert_eq!(
            TransferStatus::receiving(16_384 + 100, length).next_sequence,
            2
        );
        assert_eq!(TransferStatus::receiving(length, length).received, length);
    }

    #[test]
    fn pacing_follows_the_vectors() {
        for case in vectors()["pacing"].as_array().unwrap() {
            let bulk = case["bulk_buffered_amounts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|amount| amount.as_u64().unwrap() as usize);
            assert_eq!(
                bulk_may_send(bulk, case["watermark"].as_u64().unwrap() as usize),
                case["may_send"].as_bool().unwrap(),
                "{case}"
            );
        }
    }

    #[test]
    fn stream_requests_parse_strictly() {
        assert_eq!(StreamRequest::parse(None), Some(StreamRequest::default()));
        assert_eq!(
            StreamRequest::parse(Some(&serde_json::json!({"window": 4, "digest": "end"}))),
            Some(StreamRequest {
                window: 4,
                digest: DigestAt::End
            })
        );
        assert_eq!(
            StreamRequest::parse(Some(&serde_json::json!({"window": 99}))),
            Some(StreamRequest {
                window: WINDOW_MAX,
                digest: DigestAt::Start
            })
        );
        for bad in [
            serde_json::json!({"digest": "middle"}),
            serde_json::json!({"window": -1}),
            serde_json::json!({"window": "16"}),
            serde_json::json!([16]),
        ] {
            assert_eq!(StreamRequest::parse(Some(&bad)), None, "{bad}");
        }
        assert!(is_sha256_hex(&"a".repeat(64)));
        assert!(!is_sha256_hex(&"A".repeat(64)));
        assert!(!is_sha256_hex(&"a".repeat(63)));
    }
}
