//! Framed protocol between `spawnd` and a session worker over its ordinary
//! unix socket, plus the fixed-size independent lifecycle request format.
//!
//! ```text
//! +-----------+------+-----------------+
//! | len (u32) | type | payload         |
//! | LE        | u8   | len bytes       |
//! +-----------+------+-----------------+
//! ```
//!
//! `len` counts the payload only (not the type byte). Structured payloads are
//! JSON; hot-path payloads (PTY input/output, replay) are raw bytes. The
//! socket lives in a 0700 directory on the user's own host — this protocol
//! never crosses a machine boundary and never touches the control plane.

use anyhow::{bail, Context, Result};
use serde::{de, Deserialize, Deserializer, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

pub const PROTO_VERSION: u32 = 5;

/// The worker lifecycle endpoint accepts exactly one instance token and one
/// small signal code. No caller-provided string enters its bounded path.
pub const LIFECYCLE_REQUEST_LEN: usize = 17;
pub const LIFECYCLE_ACK_DELIVERED: u8 = 0;
pub const LIFECYCLE_ACK_GONE: u8 = 1;
pub const LIFECYCLE_ACK_WRONG_INSTANCE: u8 = 2;
pub const LIFECYCLE_ACK_FAILED: u8 = 3;

/// Upper bound on a single frame payload. Replay responses dominate; they are
/// capped well below this by the scrollback budget.
pub const MAX_FRAME_LEN: usize = 32 * 1024 * 1024;

// worker → daemon
pub const T_HELLO: u8 = 0x01;
pub const T_STARTED: u8 = 0x03;
pub const T_OUTPUT: u8 = 0x04;
pub const T_REPLAY: u8 = 0x09;
pub const T_EXIT: u8 = 0x0A;
pub const T_ERROR: u8 = 0x0C;

// daemon → worker
pub const T_START: u8 = 0x02;
pub const T_INPUT: u8 = 0x05;
pub const T_RESIZE: u8 = 0x06;
pub const T_REDRAW: u8 = 0x07;
pub const T_REPLAY_REQ: u8 = 0x08;
pub const T_SHUTDOWN: u8 = 0x0B;
/// Worker → daemon: one committed-line history batch, streamed live as it is
/// persisted. Unknown to old daemons, which ignore unrecognized frame types.
pub const T_HISTORY: u8 = 0x0D;
/// Worker → daemon: the app wiped its scrollback (`ED 3`); payload carries the
/// new history epoch.
pub const T_HISTORY_WIPE: u8 = 0x0E;
/// Worker → daemon: replay response with history anchor metadata. Sent instead
/// of `T_REPLAY` by workers that stream `T_HISTORY` deltas.
pub const T_REPLAY2: u8 = 0x0F;
/// Daemon → worker: subscribe to the committed-history delta stream. Sent only
/// to workers whose Hello advertises `history: true`; a worker never emits
/// `T_HISTORY`/`T_HISTORY_WIPE`/`T_REPLAY2` unsubscribed, because daemons
/// reject frame types they do not know (the connection would drop).
pub const T_HISTORY_SUB: u8 = 0x10;
/// Worker → daemon: foreground process report — the UTF-8 basename of the
/// executable whose process group owns the PTY foreground (max
/// `MAX_FOREGROUND_BASENAME_BYTES`). Sent when the polled value changes
/// (1 s cadence) and re-sent once to each new supervisor connection.
/// Additive at `PROTO_VERSION` 5: a new spawnd still adopts old workers,
/// which simply never send it, so their sessions report no foreground
/// command.
pub const T_FOREGROUND: u8 = 0x11;

/// First frame on every accepted connection, worker → daemon. Lets a
/// restarted `spawnd` adopt a running worker without any handshake state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hello {
    pub version: u32,
    /// The session this worker owns. Serialized as `session_id`; the alias
    /// keeps decoding the pre-v3 `agent_id` key so a new spawnd still adopts
    /// workers started before the rename (the wire stays `PROTO_VERSION` 5).
    #[serde(alias = "agent_id")]
    pub session_id: Uuid,
    /// Random identity of this exact worker process. Lifecycle requests carry
    /// it so a stale supervisor can never signal a replacement at the same
    /// filesystem path.
    pub instance_id: Uuid,
    /// "awaiting_start" | "running" | "exited"
    pub state: String,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub cols: u16,
    #[serde(default)]
    pub rows: u16,
    /// Canonical absolute cwd retained by this worker. Required for
    /// capability-rooted direct uploads after supervisor adoption.
    #[serde(default)]
    pub cwd: Option<String>,
    /// This worker can stream committed-history deltas (`T_HISTORY`) once the
    /// supervisor subscribes with `T_HISTORY_SUB`. Old daemons ignore the
    /// field; old workers omit it.
    #[serde(default)]
    pub history: bool,
}

/// daemon → worker: spawn the session command. Sent over the private socket rather than
/// argv so env values (which may hold real secrets) never appear in `/proc`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartSpec {
    pub cwd: String,
    pub argv: Vec<String>,
    pub env: std::collections::BTreeMap<String, String>,
    pub cols: u16,
    pub rows: u16,
}

impl Drop for StartSpec {
    fn drop(&mut self) {
        self.cwd.zeroize();
        self.argv.zeroize();
        for (mut key, mut value) in std::mem::take(&mut self.env) {
            key.zeroize();
            value.zeroize();
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Started {
    pub pid: u32,
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExitInfo {
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub signal: Option<String>,
}

/// Signals accepted from the control plane and by the private worker
/// lifecycle endpoint. Keeping the set deliberately small makes every queued
/// request a fixed-size, content-free value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum LifecycleSignal {
    #[serde(rename = "TERM")]
    Term,
    #[serde(rename = "KILL")]
    Kill,
}

impl LifecycleSignal {
    pub const fn code(self) -> u8 {
        match self {
            Self::Term => 1,
            Self::Kill => 2,
        }
    }

    pub fn from_code(code: u8) -> Result<Self> {
        match code {
            1 => Ok(Self::Term),
            2 => Ok(Self::Kill),
            _ => bail!("unsupported lifecycle signal code"),
        }
    }
}

impl<'de> Deserialize<'de> for LifecycleSignal {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct SignalVisitor;

        impl de::Visitor<'_> for SignalVisitor {
            type Value = LifecycleSignal;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("TERM or KILL")
            }

            fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
            where
                E: de::Error,
            {
                match value {
                    "TERM" | "SIGTERM" => Ok(LifecycleSignal::Term),
                    "KILL" | "SIGKILL" => Ok(LifecycleSignal::Kill),
                    _ => Err(E::custom("unsupported lifecycle signal")),
                }
            }
        }

        deserializer.deserialize_str(SignalVisitor)
    }
}

pub fn encode_lifecycle_request(
    instance_id: Uuid,
    signal: LifecycleSignal,
) -> [u8; LIFECYCLE_REQUEST_LEN] {
    let mut request = [0; LIFECYCLE_REQUEST_LEN];
    request[..16].copy_from_slice(instance_id.as_bytes());
    request[16] = signal.code();
    request
}

pub fn decode_lifecycle_request(
    request: &[u8; LIFECYCLE_REQUEST_LEN],
) -> Result<(Uuid, LifecycleSignal)> {
    let instance_id = Uuid::from_bytes(request[..16].try_into().expect("fixed request length"));
    Ok((instance_id, LifecycleSignal::from_code(request[16])?))
}

pub fn lifecycle_socket_path(socket: &std::path::Path) -> std::path::PathBuf {
    socket.with_extension("lifecycle.sock")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Shutdown {
    #[serde(default)]
    pub signal: Option<LifecycleSignal>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerError {
    pub message: String,
}

/// Payload of `T_RESIZE`: cols LE, rows LE.
pub fn encode_resize(cols: u16, rows: u16) -> [u8; 4] {
    let mut buf = [0u8; 4];
    buf[..2].copy_from_slice(&cols.to_le_bytes());
    buf[2..].copy_from_slice(&rows.to_le_bytes());
    buf
}

pub fn decode_resize(payload: &[u8]) -> Result<(u16, u16)> {
    if payload.len() != 4 {
        bail!("resize payload must be 4 bytes, got {}", payload.len());
    }
    let cols = u16::from_le_bytes([payload[0], payload[1]]);
    let rows = u16::from_le_bytes([payload[2], payload[3]]);
    Ok((cols, rows))
}

/// Payload of `T_OUTPUT`: `u64 LE watermark` (total PTY output bytes logged
/// after this chunk) followed by the raw output bytes.
pub fn encode_output(watermark: u64, bytes: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(8 + bytes.len());
    buf.extend_from_slice(&watermark.to_le_bytes());
    buf.extend_from_slice(bytes);
    buf
}

pub fn decode_output(payload: &[u8]) -> Result<(u64, &[u8])> {
    if payload.len() < 8 {
        bail!("output payload too short: {}", payload.len());
    }
    let watermark = u64::from_le_bytes(payload[..8].try_into().expect("checked length"));
    Ok((watermark, &payload[8..]))
}

/// Payload of `T_REPLAY_REQ`: max plaintext bytes the caller wants back, LE.
pub fn encode_replay_req(max_bytes: u32) -> [u8; 4] {
    max_bytes.to_le_bytes()
}

pub fn decode_replay_req(payload: &[u8]) -> Result<u32> {
    if payload.len() != 4 {
        bail!("replay_req payload must be 4 bytes, got {}", payload.len());
    }
    Ok(u32::from_le_bytes([
        payload[0], payload[1], payload[2], payload[3],
    ]))
}

/// Payload of `T_REPLAY`: `u64 LE watermark` (total PTY output bytes logged at
/// capture time) followed by the raw replay bytes.
pub fn encode_replay(watermark: u64, bytes: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(8 + bytes.len());
    buf.extend_from_slice(&watermark.to_le_bytes());
    buf.extend_from_slice(bytes);
    buf
}

pub fn decode_replay(payload: &[u8]) -> Result<(u64, &[u8])> {
    if payload.len() < 8 {
        bail!("replay payload too short: {}", payload.len());
    }
    let watermark = u64::from_le_bytes(payload[..8].try_into().expect("checked length"));
    Ok((watermark, &payload[8..]))
}

/// Anchor for the committed-history delta stream: `epoch` distinguishes
/// wipes/restarts, `offset` counts committed plaintext bytes within the epoch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HistoryAnchor {
    pub epoch: u64,
    pub offset: u64,
}

/// Payload of `T_HISTORY`: `u64 LE epoch` + `u64 LE start offset` + one
/// committed-line batch (self-contained styled text).
pub fn encode_history(anchor: HistoryAnchor, bytes: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(16 + bytes.len());
    buf.extend_from_slice(&anchor.epoch.to_le_bytes());
    buf.extend_from_slice(&anchor.offset.to_le_bytes());
    buf.extend_from_slice(bytes);
    buf
}

pub fn decode_history(payload: &[u8]) -> Result<(HistoryAnchor, &[u8])> {
    if payload.len() < 16 {
        bail!("history payload too short: {}", payload.len());
    }
    let epoch = u64::from_le_bytes(payload[..8].try_into().expect("checked length"));
    let offset = u64::from_le_bytes(payload[8..16].try_into().expect("checked length"));
    Ok((HistoryAnchor { epoch, offset }, &payload[16..]))
}

/// Payload of `T_HISTORY_WIPE`: `u64 LE` new epoch (offset restarts at 0).
pub fn encode_history_wipe(epoch: u64) -> [u8; 8] {
    epoch.to_le_bytes()
}

pub fn decode_history_wipe(payload: &[u8]) -> Result<u64> {
    if payload.len() != 8 {
        bail!(
            "history_wipe payload must be 8 bytes, got {}",
            payload.len()
        );
    }
    Ok(u64::from_le_bytes(
        payload.try_into().expect("checked length"),
    ))
}

/// Payload of `T_REPLAY2`: `u64 LE watermark` + `u64 LE history epoch` +
/// `u64 LE history end offset at capture` + the replay bytes. The end offset
/// always lands on a batch boundary, so deltas append exactly after it.
pub fn encode_replay2(watermark: u64, anchor: HistoryAnchor, bytes: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(24 + bytes.len());
    buf.extend_from_slice(&watermark.to_le_bytes());
    buf.extend_from_slice(&anchor.epoch.to_le_bytes());
    buf.extend_from_slice(&anchor.offset.to_le_bytes());
    buf.extend_from_slice(bytes);
    buf
}

pub fn decode_replay2(payload: &[u8]) -> Result<(u64, HistoryAnchor, &[u8])> {
    if payload.len() < 24 {
        bail!("replay2 payload too short: {}", payload.len());
    }
    let watermark = u64::from_le_bytes(payload[..8].try_into().expect("checked length"));
    let epoch = u64::from_le_bytes(payload[8..16].try_into().expect("checked length"));
    let offset = u64::from_le_bytes(payload[16..24].try_into().expect("checked length"));
    Ok((watermark, HistoryAnchor { epoch, offset }, &payload[24..]))
}

/// Upper bound on a `T_FOREGROUND` payload. The worker truncates to 64
/// characters; 256 bytes leaves room for multi-byte UTF-8 without letting a
/// hostile peer allocate more.
pub const MAX_FOREGROUND_BASENAME_BYTES: usize = 256;

/// Payload of `T_FOREGROUND`: the raw UTF-8 basename, no framing.
pub fn encode_foreground(basename: &str) -> Vec<u8> {
    basename.as_bytes().to_vec()
}

pub fn decode_foreground(payload: &[u8]) -> Result<&str> {
    if payload.len() > MAX_FOREGROUND_BASENAME_BYTES {
        bail!("foreground payload too large: {}", payload.len());
    }
    std::str::from_utf8(payload).map_err(|_| anyhow::anyhow!("foreground basename is not UTF-8"))
}

pub async fn write_frame<W: AsyncWrite + Unpin>(
    w: &mut W,
    frame_type: u8,
    payload: &[u8],
) -> Result<()> {
    if payload.len() > MAX_FRAME_LEN {
        bail!("frame payload too large: {} bytes", payload.len());
    }
    let mut header = [0u8; 5];
    header[..4].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    header[4] = frame_type;
    w.write_all(&header).await.context("writing frame header")?;
    w.write_all(payload)
        .await
        .context("writing frame payload")?;
    w.flush().await.context("flushing frame")?;
    Ok(())
}

pub async fn write_json_frame<W: AsyncWrite + Unpin, T: Serialize>(
    w: &mut W,
    frame_type: u8,
    value: &T,
) -> Result<()> {
    let payload = Zeroizing::new(serde_json::to_vec(value).context("encoding json frame")?);
    write_frame(w, frame_type, &payload).await
}

/// Read one frame. Returns `Ok(None)` on clean EOF at a frame boundary.
pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> Result<Option<(u8, Vec<u8>)>> {
    read_frame_limited(r, |_| Some(MAX_FRAME_LEN)).await
}

/// Read one frame after applying a type-specific allocation policy to its
/// five-byte header. A rejected type or length never allocates its declared
/// payload.
pub async fn read_frame_limited<R, F>(r: &mut R, limit_for_type: F) -> Result<Option<(u8, Vec<u8>)>>
where
    R: AsyncRead + Unpin,
    F: FnOnce(u8) -> Option<usize>,
{
    let mut header = [0u8; 5];
    match r.read_exact(&mut header).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e).context("reading frame header"),
    }
    let len = u32::from_le_bytes(header[..4].try_into().expect("checked length")) as usize;
    let frame_type = header[4];
    let Some(limit) = limit_for_type(frame_type) else {
        bail!("frame type rejected by endpoint policy");
    };
    if len > limit {
        bail!("frame payload rejected by endpoint policy");
    }
    let mut payload = vec![0u8; len];
    if let Err(error) = r.read_exact(&mut payload).await {
        payload.zeroize();
        return Err(error).context("reading frame payload");
    }
    Ok(Some((frame_type, payload)))
}

pub fn decode_json<'a, T: Deserialize<'a>>(payload: &'a [u8]) -> Result<T> {
    serde_json::from_slice(payload).context("decoding json frame")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frame_round_trip() {
        let (mut a, mut b) = tokio::io::duplex(1024);
        write_frame(&mut a, T_OUTPUT, b"hello").await.unwrap();
        write_frame(&mut a, T_REDRAW, b"").await.unwrap();
        drop(a);

        let (t, payload) = read_frame(&mut b).await.unwrap().unwrap();
        assert_eq!(t, T_OUTPUT);
        assert_eq!(payload, b"hello");
        let (t, payload) = read_frame(&mut b).await.unwrap().unwrap();
        assert_eq!(t, T_REDRAW);
        assert!(payload.is_empty());
        assert!(read_frame(&mut b).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn json_frame_round_trip() {
        let (mut a, mut b) = tokio::io::duplex(4096);
        let spec = StartSpec {
            cwd: "/tmp".into(),
            argv: vec!["bash".into(), "-l".into()],
            env: [("TERM".to_string(), "xterm-256color".to_string())]
                .into_iter()
                .collect(),
            cols: 120,
            rows: 32,
        };
        write_json_frame(&mut a, T_START, &spec).await.unwrap();
        let (t, payload) = read_frame(&mut b).await.unwrap().unwrap();
        assert_eq!(t, T_START);
        let decoded: StartSpec = decode_json(&payload).unwrap();
        assert_eq!(decoded.argv, spec.argv);
        assert_eq!(decoded.cols, 120);
        assert_eq!(decoded.env.get("TERM").unwrap(), "xterm-256color");
    }

    #[test]
    fn resize_round_trip() {
        let buf = encode_resize(203, 51);
        assert_eq!(decode_resize(&buf).unwrap(), (203, 51));
        assert!(decode_resize(&buf[..3]).is_err());
    }

    #[test]
    fn replay_round_trip() {
        let buf = encode_replay(987_654, b"screen bytes");
        let (watermark, bytes) = decode_replay(&buf).unwrap();
        assert_eq!(watermark, 987_654);
        assert_eq!(bytes, b"screen bytes");
        assert!(decode_replay(&buf[..7]).is_err());
    }

    #[test]
    fn output_round_trip() {
        let buf = encode_output(42, b"\xf0\x9f\x98\x80\x1b[31m");
        let (watermark, bytes) = decode_output(&buf).unwrap();
        assert_eq!(watermark, 42);
        assert_eq!(bytes, b"\xf0\x9f\x98\x80\x1b[31m");
        assert!(decode_output(&buf[..7]).is_err());
    }

    #[test]
    fn lifecycle_request_is_fixed_size_and_signal_errors_are_content_free() {
        let instance = Uuid::new_v4();
        for signal in [LifecycleSignal::Term, LifecycleSignal::Kill] {
            let request = encode_lifecycle_request(instance, signal);
            assert_eq!(request.len(), LIFECYCLE_REQUEST_LEN);
            assert_eq!(
                decode_lifecycle_request(&request).unwrap(),
                (instance, signal)
            );
        }

        let unknown = "private-unknown-signal-value";
        let error = serde_json::from_str::<LifecycleSignal>(&format!("\"{unknown}\""))
            .unwrap_err()
            .to_string();
        assert_eq!(error, "unsupported lifecycle signal at line 1 column 30");
        assert!(!error.contains(unknown));

        let oversized = "x".repeat(128 * 1024);
        let error = serde_json::from_str::<LifecycleSignal>(&format!("\"{oversized}\""))
            .unwrap_err()
            .to_string();
        assert!(error.starts_with("unsupported lifecycle signal at line 1 column "));
        assert!(!error.contains(&oversized));
    }

    #[test]
    fn history_frames_round_trip() {
        let anchor = HistoryAnchor {
            epoch: u64::MAX - 3,
            offset: 987_654_321,
        };
        let framed = encode_history(anchor, b"\x1b[0mline\r\n");
        let (decoded, bytes) = decode_history(&framed).unwrap();
        assert_eq!(decoded, anchor);
        assert_eq!(bytes, b"\x1b[0mline\r\n");
        assert!(decode_history(&framed[..15]).is_err());

        let wipe = encode_history_wipe(anchor.epoch);
        assert_eq!(decode_history_wipe(&wipe).unwrap(), anchor.epoch);
        assert!(decode_history_wipe(&wipe[..7]).is_err());

        let replay = encode_replay2(42, anchor, b"payload");
        let (watermark, decoded, bytes) = decode_replay2(&replay).unwrap();
        assert_eq!(watermark, 42);
        assert_eq!(decoded, anchor);
        assert_eq!(bytes, b"payload");
        assert!(decode_replay2(&replay[..23]).is_err());
    }

    #[test]
    fn hello_from_an_old_worker_still_decodes() {
        // An old worker's Hello names its session `agent_id` and omits
        // `history`; decoding must adopt it under the alias without failing
        // and must not accidentally enable the delta stream.
        let session = Uuid::new_v4();
        let old = serde_json::json!({
            "version": PROTO_VERSION,
            "agent_id": session,
            "instance_id": Uuid::new_v4(),
            "state": "running",
        });
        let hello: Hello = serde_json::from_value(old).unwrap();
        assert_eq!(hello.session_id, session);
        assert!(!hello.history);
    }

    #[test]
    fn foreground_round_trip_is_bounded_utf8() {
        let framed = encode_foreground("claude");
        assert_eq!(decode_foreground(&framed).unwrap(), "claude");
        assert!(decode_foreground(&[0xff, 0xfe]).is_err());
        assert!(decode_foreground(&vec![b'x'; MAX_FOREGROUND_BASENAME_BYTES + 1]).is_err());
    }

    #[tokio::test]
    async fn oversized_frame_rejected() {
        let (mut a, mut b) = tokio::io::duplex(64);
        // Hand-craft a header claiming a payload larger than MAX_FRAME_LEN.
        let mut header = [0u8; 5];
        header[..4].copy_from_slice(&((MAX_FRAME_LEN as u32) + 1).to_le_bytes());
        header[4] = T_OUTPUT;
        tokio::io::AsyncWriteExt::write_all(&mut a, &header)
            .await
            .unwrap();
        assert!(read_frame(&mut b).await.is_err());
    }

    #[tokio::test]
    async fn endpoint_limit_rejects_from_header_without_waiting_or_allocating_payload() {
        let (mut a, mut b) = tokio::io::duplex(64);
        let mut header = [0u8; 5];
        header[..4].copy_from_slice(&(64_u32 * 1024 + 1).to_le_bytes());
        header[4] = T_INPUT;
        a.write_all(&header).await.unwrap();
        let error = read_frame_limited(&mut b, |frame_type| {
            (frame_type == T_INPUT).then_some(64 * 1024)
        })
        .await
        .unwrap_err()
        .to_string();
        assert_eq!(error, "frame payload rejected by endpoint policy");

        let (mut a, mut b) = tokio::io::duplex(64);
        header[..4].copy_from_slice(&u32::MAX.to_le_bytes());
        header[4] = 0xFF;
        a.write_all(&header).await.unwrap();
        let error = read_frame_limited(&mut b, |_| None)
            .await
            .unwrap_err()
            .to_string();
        assert_eq!(error, "frame type rejected by endpoint policy");
    }
}
