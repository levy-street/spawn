//! Websocket client glue.
//!
//! Owns the WS connection lifecycle: connect, register, fan inbound frames
//! to the dispatch loop, and a single sender task that owns the write half
//! and is fed by an mpsc channel from any number of per-agent reader tasks.

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use socket2::{SockRef, TcpKeepalive};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::{Message, WebSocketConfig};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use url::Url;
use zeroize::{Zeroize, Zeroizing};

use crate::proto::{Inbound, Outbound};
use crate::pty::WsOutbound;

pub type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

const SUBPROTOCOL: &str = "spawn.v1";

/// Open a WS/WSS connection with `Authorization: Bearer <token>` and
/// `Sec-WebSocket-Protocol: spawn.v1`. We TCP-connect manually first so we
/// can enable TCP keepalive on the socket — without it, a half-dead remote
/// (e.g. `uvicorn` shut down without a clean WS close) leaves the daemon's
/// socket in `CLOSE-WAIT` indefinitely with no way for tungstenite to
/// notice. With keepalive at 30s/5s/3 (idle/interval/probes), the kernel
/// surfaces the death within ~45s and read/write start failing.
pub async fn connect(ws_url: &Url, token: &str) -> Result<WsStream> {
    let mut req = ws_url
        .as_str()
        .into_client_request()
        .context("building ws request")?;

    let headers = req.headers_mut();
    headers.insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {token}"))
            .context("token contains invalid header bytes")?,
    );
    headers.insert(
        "Sec-WebSocket-Protocol",
        HeaderValue::from_static(SUBPROTOCOL),
    );

    let scheme = ws_url.scheme();
    let host = ws_url
        .host_str()
        .ok_or_else(|| anyhow!("ws url has no host"))?;
    let port = ws_url
        .port_or_known_default()
        .ok_or_else(|| anyhow!("ws url has no resolvable port"))?;

    // Lookup + connect TCP ourselves so we can configure keepalive before
    // handing the stream to tokio-tungstenite.
    let tcp = TcpStream::connect((host, port))
        .await
        .with_context(|| format!("tcp connect {host}:{port}"))?;
    if let Err(e) = configure_keepalive(&tcp) {
        tracing::warn!(error = %e, "could not enable TCP keepalive on ws socket");
    }

    // Hand the configured TCP stream to tungstenite. For `ws://` we pass
    // the bare TCP; for `wss://` we'd need a TLS upgrade — supported by
    // `client_async_tls_with_config`, deferred until the deployment uses
    // wss in earnest.
    // Explorer fs.read/fs.write payloads can be ~43MB of base64 in a single
    // frame (the server's websockets stack doesn't fragment sends), so lift
    // tungstenite's 16MiB-frame / 64MiB-message defaults.
    let ws_config = WebSocketConfig {
        max_message_size: Some(96 * 1024 * 1024),
        max_frame_size: Some(96 * 1024 * 1024),
        ..WebSocketConfig::default()
    };

    let (stream, response) = match scheme {
        "ws" => {
            let maybe_tls = MaybeTlsStream::Plain(tcp);
            tokio_tungstenite::client_async_with_config(req, maybe_tls, Some(ws_config))
                .await
                .context("ws handshake")?
        }
        "wss" => {
            // Fall back to the convenience helper which does its own TCP
            // connect + TLS. We can't preconfigure keepalive here without
            // pulling in tokio-rustls directly; revisit when the public
            // deployment switches to TLS.
            tokio_tungstenite::connect_async_with_config(req, Some(ws_config), false)
                .await
                .context("ws connect (tls)")?
        }
        other => anyhow::bail!("unsupported ws scheme: {other}"),
    };

    // Verify the server actually accepted our subprotocol (if it sent one).
    if let Some(sp) = response.headers().get("Sec-WebSocket-Protocol") {
        if sp.to_str().unwrap_or("") != SUBPROTOCOL {
            return Err(anyhow!("server selected unexpected subprotocol: {:?}", sp));
        }
    }

    Ok(stream)
}

fn configure_keepalive(tcp: &TcpStream) -> Result<()> {
    let sock = SockRef::from(tcp);
    // 30s idle then probe every 5s; OS default retry count (9 on Linux) gets
    // us a hard close in ~75s after the remote stops responding. Enough to
    // detect uvicorn-restart kind of dropouts within ~1 min.
    let ka = TcpKeepalive::new()
        .with_time(Duration::from_secs(30))
        .with_interval(Duration::from_secs(5));
    sock.set_tcp_keepalive(&ka).context("set_tcp_keepalive")?;
    Ok(())
}

/// Send a JSON frame directly on a stream half. Currently unused — the run
/// loop fans frames in via the mpsc — but exposed for future ad-hoc sends
/// and tests.
#[allow(dead_code)]
pub async fn send_json(stream: &mut WsStream, frame: &Outbound) -> Result<()> {
    let s = serde_json::to_string(frame)?;
    stream.send(Message::Text(s)).await?;
    Ok(())
}

/// Send a binary frame directly on a stream half. See `send_json` re: usage.
#[allow(dead_code)]
pub async fn send_binary(stream: &mut WsStream, payload: Vec<u8>) -> Result<()> {
    stream.send(Message::Binary(payload)).await?;
    Ok(())
}

#[cfg(test)]
type InboundWipeProbe = std::sync::Arc<dyn Fn(&[u8]) + Send + Sync>;

/// Original owned legacy-WS binary frame. The payload slice is copied once
/// into a self-wiping worker input wrapper; this complete source frame then
/// wipes on normal dispatch, malformed-frame rejection, or channel teardown.
pub struct WsInboundPayload {
    frame: Vec<u8>,
    payload_offset: usize,
    #[cfg(test)]
    wipe_probe: Option<InboundWipeProbe>,
}

impl WsInboundPayload {
    fn new(frame: Vec<u8>, payload_offset: usize) -> Self {
        Self {
            frame,
            payload_offset,
            #[cfg(test)]
            wipe_probe: None,
        }
    }

    pub(crate) fn copy_to_direct(&self) -> crate::pty::DirectPayload {
        crate::pty::DirectPayload::new(self.frame[self.payload_offset..].to_vec())
    }

    #[cfg(test)]
    fn set_wipe_probe(&mut self, wipe_probe: InboundWipeProbe) {
        self.wipe_probe = Some(wipe_probe);
    }
}

impl std::fmt::Debug for WsInboundPayload {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WsInboundPayload")
            .field(
                "payload_len",
                &self.frame.len().saturating_sub(self.payload_offset),
            )
            .finish_non_exhaustive()
    }
}

impl Drop for WsInboundPayload {
    fn drop(&mut self) {
        self.frame.as_mut_slice().zeroize();
        #[cfg(test)]
        if let Some(probe) = self.wipe_probe.as_ref() {
            probe(&self.frame);
        }
    }
}

/// One inbound message from the WS, normalized.
#[derive(Debug)]
pub enum WsInbound {
    Json(Inbound),
    /// Decoded binary frame: (kind, agent_id, payload-as-owned-vec).
    Binary {
        kind: u8,
        agent_id: uuid::Uuid,
        payload: WsInboundPayload,
    },
    /// Server closed the connection.
    Closed,
}

/// Convert a tungstenite Message into our normalized WsInbound, or return
/// None for frames we ignore (Ping/Pong/Frame).
pub fn classify(msg: Message) -> Result<Option<WsInbound>> {
    match msg {
        Message::Text(t) => {
            let frame: Inbound = serde_json::from_str(&t)
                .with_context(|| format!("decoding inbound JSON frame: {t}"))?;
            Ok(Some(WsInbound::Json(frame)))
        }
        Message::Binary(b) => {
            let mut frame = Zeroizing::new(b);
            let (kind, agent_id, payload) = crate::frames::decode_binary(&frame)?;
            if kind != crate::frames::KIND_PTY_INPUT {
                anyhow::bail!("unexpected inbound binary frame kind {kind}");
            }
            if payload.len() > crate::pty::MAX_WORKER_INPUT_BYTES {
                anyhow::bail!(
                    "inbound PTY input exceeds {} byte limit",
                    crate::pty::MAX_WORKER_INPUT_BYTES
                );
            }
            let payload_offset = frame.len() - payload.len();
            Ok(Some(WsInbound::Binary {
                kind,
                agent_id,
                payload: WsInboundPayload::new(std::mem::take(&mut *frame), payload_offset),
            }))
        }
        Message::Close(_) => Ok(Some(WsInbound::Closed)),
        Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => Ok(None),
    }
}

/// Drain the outbound mpsc into the WS write half. Exits when the receiver
/// closes (registry dropped) or a send error occurs.
pub async fn run_sender_loop(
    mut stream_tx: futures_util::stream::SplitSink<WsStream, Message>,
    mut rx: mpsc::Receiver<WsOutbound>,
) {
    while let Some(mut out) = rx.recv().await {
        let res = match &mut out {
            WsOutbound::Json(text) => stream_tx.send(Message::Text(std::mem::take(text))).await,
            WsOutbound::Binary(bytes) => {
                stream_tx.send(Message::Binary(std::mem::take(bytes))).await
            }
        };
        if let Err(e) = res {
            tracing::warn!(error = %e, "ws send error; sender loop exiting");
            break;
        }
    }
    let _ = stream_tx.close().await;
}

/// Read inbound frames forever. Returns when the connection closes or
/// errors. Heartbeat is driven independently by `run::run`.
///
/// A read-idle timeout guards against the case where the server-side TCP
/// close isn't propagated up to tungstenite (we've observed sockets stuck
/// in `CLOSE-WAIT` after `uvicorn` shutdown). The server pushes nothing
/// when idle, but the daemon sends heartbeats every 30s, so receiving
/// nothing for `READ_IDLE_TIMEOUT` indicates the WS is dead. The outer
/// run loop will reconnect.
const READ_IDLE_TIMEOUT: Duration = Duration::from_secs(75);

pub async fn run_reader_loop(
    mut stream_rx: futures_util::stream::SplitStream<WsStream>,
    inbound_tx: mpsc::Sender<WsInbound>,
) {
    use std::time::Instant;
    let mut last_meaningful = Instant::now();
    loop {
        // Compute the remaining budget against the deadline, NOT a fresh
        // 75s for each iteration. Otherwise auto-handled control frames
        // (Pings/Pongs) reset the timer indefinitely on a half-dead link.
        let elapsed = last_meaningful.elapsed();
        if elapsed >= READ_IDLE_TIMEOUT {
            tracing::warn!(
                "ws read idle {:?}; treating as disconnected",
                READ_IDLE_TIMEOUT
            );
            break;
        }
        let remaining = READ_IDLE_TIMEOUT - elapsed;
        let next = tokio::time::timeout(remaining, stream_rx.next()).await;
        let msg_opt = match next {
            Ok(o) => o,
            Err(_) => {
                tracing::warn!(
                    "ws read idle {:?}; treating as disconnected",
                    READ_IDLE_TIMEOUT
                );
                break;
            }
        };
        let Some(msg) = msg_opt else { break };
        let msg = match msg {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(error = %e, "ws read error");
                break;
            }
        };
        match classify(msg) {
            Ok(Some(WsInbound::Closed)) => {
                let _ = inbound_tx.send(WsInbound::Closed).await;
                break;
            }
            Ok(Some(other)) => {
                last_meaningful = Instant::now();
                if inbound_tx.send(other).await.is_err() {
                    break;
                }
            }
            Ok(None) => {
                // Control frame (Ping/Pong/raw Frame). Don't refresh the
                // idleness deadline — heartbeats from the server are real
                // signal but those are JSON Text and hit the branch above.
            }
            Err(e) => {
                tracing::warn!(error = %e, "discarding malformed inbound frame");
            }
        }
    }
}

/// Compute backoff delay for the Nth attempt (zero-indexed). 1s, 2s, 4s, ...
/// capped at 60s.
pub fn backoff_for_attempt(attempt: u32) -> Duration {
    let secs = 1u64.checked_shl(attempt.min(6)).unwrap_or(60);
    Duration::from_secs(secs.min(60))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn observed_probe(observed: &Arc<Mutex<Vec<Vec<u8>>>>) -> InboundWipeProbe {
        let observed = Arc::clone(observed);
        Arc::new(move |bytes| observed.lock().unwrap().push(bytes.to_vec()))
    }

    #[test]
    fn binary_input_owns_and_wipes_the_complete_websocket_frame() {
        let observed = Arc::new(Mutex::new(Vec::new()));
        let frame = crate::frames::encode_binary(
            crate::frames::KIND_PTY_INPUT,
            uuid::Uuid::new_v4(),
            b"legacy websocket secret",
        );
        let Some(WsInbound::Binary { mut payload, .. }) =
            classify(Message::Binary(frame)).expect("classify")
        else {
            panic!("expected binary input");
        };
        let direct = payload.copy_to_direct();
        assert_eq!(&*direct, b"legacy websocket secret");
        payload.set_wipe_probe(observed_probe(&observed));
        drop(payload);
        drop(direct);

        let observed = observed.lock().unwrap();
        assert_eq!(observed.len(), 1);
        assert_eq!(observed[0].len(), 17 + b"legacy websocket secret".len());
        assert!(observed[0].iter().all(|byte| *byte == 0));
    }

    #[tokio::test]
    async fn inbound_channel_teardown_wipes_queued_binary_frames() {
        let observed = Arc::new(Mutex::new(Vec::new()));
        let frame = crate::frames::encode_binary(
            crate::frames::KIND_PTY_INPUT,
            uuid::Uuid::new_v4(),
            b"queued legacy websocket secret",
        );
        let Some(WsInbound::Binary {
            kind,
            agent_id,
            mut payload,
        }) = classify(Message::Binary(frame)).expect("classify")
        else {
            panic!("expected binary input");
        };
        payload.set_wipe_probe(observed_probe(&observed));
        let (tx, rx) = mpsc::channel(1);
        tx.send(WsInbound::Binary {
            kind,
            agent_id,
            payload,
        })
        .await
        .unwrap();
        drop(rx);
        drop(tx);

        let observed = observed.lock().unwrap();
        assert_eq!(observed.len(), 1);
        assert_eq!(
            observed[0].len(),
            17 + b"queued legacy websocket secret".len()
        );
        assert!(observed[0].iter().all(|byte| *byte == 0));
    }
}
