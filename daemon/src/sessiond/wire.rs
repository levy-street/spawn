//! Framed protocol between `spawnd` and a session worker over a unix socket.
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
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use uuid::Uuid;

pub const PROTO_VERSION: u32 = 1;

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

/// First frame on every accepted connection, worker → daemon. Lets a
/// restarted `spawnd` adopt a running worker without any handshake state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hello {
    pub version: u32,
    pub agent_id: Uuid,
    /// "awaiting_start" | "running" | "exited"
    pub state: String,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub cols: u16,
    #[serde(default)]
    pub rows: u16,
}

/// daemon → worker: spawn the agent. Sent over the private socket rather than
/// argv so env values (which may hold real secrets) never appear in `/proc`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartSpec {
    pub cwd: String,
    pub argv: Vec<String>,
    pub env: std::collections::BTreeMap<String, String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Started {
    pub pid: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExitInfo {
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub signal: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Shutdown {
    #[serde(default)]
    pub signal: Option<String>,
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
    let payload = serde_json::to_vec(value).context("encoding json frame")?;
    write_frame(w, frame_type, &payload).await
}

/// Read one frame. Returns `Ok(None)` on clean EOF at a frame boundary.
pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> Result<Option<(u8, Vec<u8>)>> {
    let mut header = [0u8; 5];
    match r.read_exact(&mut header).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e).context("reading frame header"),
    }
    let len = u32::from_le_bytes(header[..4].try_into().expect("checked length")) as usize;
    if len > MAX_FRAME_LEN {
        bail!("frame payload too large: {len} bytes");
    }
    let frame_type = header[4];
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload)
        .await
        .context("reading frame payload")?;
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
}
