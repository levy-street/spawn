//! Websocket client glue.
//!
//! Owns the WS connection lifecycle: connect, register, fan inbound frames
//! to the dispatch loop, and a single sender task that owns the write half
//! and is fed by an mpsc channel from any number of per-agent reader tasks.

use std::time::Duration;

use crate::proto::{Inbound, Outbound};
use crate::pty::WsOutbound;
use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use socket2::{SockRef, TcpKeepalive};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderMap, HeaderValue};
use tokio_tungstenite::tungstenite::protocol::{Message, WebSocketConfig};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use url::Url;

pub type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

const SUBPROTOCOL: &str = "spawn.control.v2";

/// Open a WS/WSS connection with `Authorization: Bearer <token>` and
/// `Sec-WebSocket-Protocol: spawn.control.v2`. We TCP-connect manually first so we
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

    require_selected_subprotocol(response.headers())?;

    Ok(stream)
}

fn require_selected_subprotocol(headers: &HeaderMap) -> Result<()> {
    let selected = headers
        .get("Sec-WebSocket-Protocol")
        .ok_or_else(|| anyhow!("server did not select the required websocket subprotocol"))?
        .to_str()
        .context("server selected a malformed websocket subprotocol")?;
    if selected != SUBPROTOCOL {
        anyhow::bail!("server did not select the required websocket subprotocol");
    }
    Ok(())
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

/// One inbound message from the WS, normalized.
#[derive(Debug)]
pub enum WsInbound {
    Json(Box<Inbound>),
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
            Ok(Some(WsInbound::Json(Box::new(frame))))
        }
        Message::Binary(_) => {
            anyhow::bail!("binary frames are forbidden on the daemon control socket")
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
    while let Some(out) = rx.recv().await {
        let res = stream_tx.send(Message::Text(out.into_text())).await;
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

    #[test]
    fn daemon_control_handshake_requires_exact_selected_subprotocol() {
        let mut headers = HeaderMap::new();
        assert!(require_selected_subprotocol(&headers).is_err());

        headers.insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_str(&["spawn.control.v", "1"].concat()).unwrap(),
        );
        assert!(require_selected_subprotocol(&headers).is_err());

        headers.insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_bytes(&[0x80]).expect("non-ASCII header value"),
        );
        assert!(require_selected_subprotocol(&headers).is_err());

        headers.insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_static(SUBPROTOCOL),
        );
        require_selected_subprotocol(&headers).expect("exact subprotocol accepted");
    }

    #[test]
    fn binary_frames_fail_closed() {
        let error = classify(Message::Binary(b"terminal secret".to_vec()))
            .expect_err("binary daemon control frame must be rejected");
        assert!(error.to_string().contains("binary frames are forbidden"));
    }

    #[test]
    fn json_control_frames_remain_supported() {
        let frame = classify(Message::Text(r#"{"type":"host.heartbeat"}"#.into()))
            .expect("classify")
            .expect("message");
        assert!(
            matches!(frame, WsInbound::Json(inner) if matches!(*inner, Inbound::HostHeartbeat))
        );

        let frame = classify(Message::Text(
            r#"{"type":"host.ping","request_id":"request-1"}"#.into(),
        ))
        .expect("classify")
        .expect("message");
        assert!(matches!(
            frame,
            WsInbound::Json(inner)
                if matches!(*inner, Inbound::HostPing { ref request_id } if request_id == "request-1")
        ));
    }
}
