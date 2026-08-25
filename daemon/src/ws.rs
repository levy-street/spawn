//! Websocket client glue.
//!
//! Owns the WS connection lifecycle: connect, register, fan inbound frames
//! to the dispatch loop, and a single sender task that owns the write half
//! and is fed by an mpsc channel from any number of per-session reader tasks.

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

const SUBPROTOCOL: &str = "spawn.control.v3";
const PROTOCOL_REQUIRED_CLOSE_CODE: u16 = 4003;

#[derive(Debug, thiserror::Error)]
#[error("server did not select the required websocket subprotocol")]
struct ProtocolRequired;

pub fn is_protocol_required(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| cause.is::<ProtocolRequired>())
}

pub fn protocol_required_error() -> anyhow::Error {
    ProtocolRequired.into()
}

/// Open a WS/WSS connection with `Authorization: Bearer <token>` and
/// `Sec-WebSocket-Protocol: spawn.control.v3`. We TCP-connect manually first so we
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
        .ok_or(ProtocolRequired)?
        .to_str()
        .context("server selected a malformed websocket subprotocol")?;
    if selected != SUBPROTOCOL {
        return Err(ProtocolRequired.into());
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
    Closed {
        protocol_required: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReaderOutcome {
    Closed,
    ProtocolRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InboundFrameError {
    MalformedJson,
    BinaryForbidden,
}

/// Convert a tungstenite Message into our normalized WsInbound, or return
/// None for frames we ignore (Ping/Pong/Frame).
fn classify(msg: Message) -> std::result::Result<Option<WsInbound>, InboundFrameError> {
    match msg {
        Message::Text(t) => {
            // Never retain serde's error chain here: unknown enum values and
            // malformed tokens can be copied into its Display text. The
            // hostile server frame must not reach daemon logs.
            let frame: Inbound =
                serde_json::from_str(&t).map_err(|_| InboundFrameError::MalformedJson)?;
            Ok(Some(WsInbound::Json(Box::new(frame))))
        }
        Message::Binary(_) => Err(InboundFrameError::BinaryForbidden),
        Message::Close(frame) => Ok(Some(WsInbound::Closed {
            protocol_required: frame
                .as_ref()
                .is_some_and(|close| u16::from(close.code) == PROTOCOL_REQUIRED_CLOSE_CODE),
        })),
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
        let (text, close, flushed) = out.into_parts();
        let res = if close {
            stream_tx.close().await
        } else {
            stream_tx
                .send(Message::Text(text.expect("text outbound has payload")))
                .await
        };
        if res.is_err() {
            // A peer-initiated protocol failure can influence tungstenite's
            // error text. Do not copy it into daemon logs.
            tracing::warn!("daemon control websocket send failed; sender loop exiting");
            break;
        }
        if let Some(flushed) = flushed {
            // notify_one retains a permit if the updater has not started
            // awaiting yet, so the bounded flush cannot miss a fast send.
            flushed.notify_one();
        }
        if close {
            return;
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
) -> ReaderOutcome {
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
            return ReaderOutcome::Closed;
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
                return ReaderOutcome::Closed;
            }
        };
        let Some(msg) = msg_opt else {
            return ReaderOutcome::Closed;
        };
        let msg = match msg {
            Ok(m) => m,
            Err(_) => {
                // Tungstenite protocol errors can include peer-controlled
                // close reasons. Keep the ingress diagnostic content-free.
                tracing::warn!("daemon control websocket read failed");
                return ReaderOutcome::Closed;
            }
        };
        match classify(msg) {
            Ok(Some(WsInbound::Closed { protocol_required })) => {
                let _ = inbound_tx
                    .send(WsInbound::Closed { protocol_required })
                    .await;
                return if protocol_required {
                    ReaderOutcome::ProtocolRequired
                } else {
                    ReaderOutcome::Closed
                };
            }
            Ok(Some(other)) => {
                last_meaningful = Instant::now();
                if inbound_tx.send(other).await.is_err() {
                    return ReaderOutcome::Closed;
                }
            }
            Ok(None) => {
                // Control frame (Ping/Pong/raw Frame). Don't refresh the
                // idleness deadline — heartbeats from the server are real
                // signal but those are JSON Text and hit the branch above.
            }
            Err(InboundFrameError::MalformedJson) => {
                tracing::warn!("discarding malformed JSON daemon control frame");
            }
            Err(InboundFrameError::BinaryForbidden) => {
                tracing::warn!("discarding binary daemon control frame");
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

/// Protocol refusal needs enough space for an HTTP update attempt and avoids
/// hammering a server that this binary cannot speak to.
pub fn self_update_backoff() -> Duration {
    Duration::from_secs(5 * 60)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::{Arc, Mutex};
    use tracing::instrument::WithSubscriber;

    struct CapturedLogWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for CapturedLogWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn daemon_control_handshake_requires_exact_selected_subprotocol() {
        let mut headers = HeaderMap::new();
        let missing = require_selected_subprotocol(&headers).unwrap_err();
        assert!(is_protocol_required(&missing));

        headers.insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_str(&["spawn.control.v", "1"].concat()).unwrap(),
        );
        let wrong = require_selected_subprotocol(&headers).unwrap_err();
        assert!(is_protocol_required(&wrong));

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
    fn close_4003_is_preserved_as_a_protocol_update_trigger() {
        use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
        use tokio_tungstenite::tungstenite::protocol::CloseFrame;

        let required = classify(Message::Close(Some(CloseFrame {
            code: CloseCode::Library(PROTOCOL_REQUIRED_CLOSE_CODE),
            reason: "server-controlled reason must not be retained".into(),
        })))
        .unwrap()
        .unwrap();
        assert!(matches!(
            required,
            WsInbound::Closed {
                protocol_required: true
            }
        ));

        let ordinary = classify(Message::Close(Some(CloseFrame {
            code: CloseCode::Normal,
            reason: "ordinary".into(),
        })))
        .unwrap()
        .unwrap();
        assert!(matches!(
            ordinary,
            WsInbound::Closed {
                protocol_required: false
            }
        ));
    }

    #[test]
    fn protocol_update_backoff_is_separate_from_the_normal_ladder() {
        assert_eq!(backoff_for_attempt(99), Duration::from_secs(60));
        assert_eq!(self_update_backoff(), Duration::from_secs(5 * 60));
    }

    #[tokio::test]
    async fn tracked_sender_frames_ack_flush_then_close_cleanly() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind tracked sender test");
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_hdr_async(
                tcp,
                |_: &tokio_tungstenite::tungstenite::handshake::server::Request,
                 mut response: tokio_tungstenite::tungstenite::handshake::server::Response| {
                    response.headers_mut().insert(
                        "Sec-WebSocket-Protocol",
                        HeaderValue::from_static(SUBPROTOCOL),
                    );
                    Ok(response)
                },
            )
            .await
            .unwrap();
            let text = socket
                .next()
                .await
                .expect("tracked text")
                .expect("valid tracked text")
                .into_text()
                .expect("text frame");
            assert_eq!(text, r#"{"type":"daemon.update_result","ok":true}"#);
            assert!(matches!(
                socket.next().await,
                Some(Ok(Message::Close(_))) | None
            ));
        });

        let url = Url::parse(&format!("ws://{address}/ws/daemon")).unwrap();
        let stream = connect(&url, "tracked-test-token").await.unwrap();
        let (write_half, _read_half) = stream.split();
        let (tx, rx) = mpsc::channel(2);
        let sender = tokio::spawn(run_sender_loop(write_half, rx));
        let (frame, frame_flushed) =
            WsOutbound::tracked_json(r#"{"type":"daemon.update_result","ok":true}"#.to_string());
        tx.send(frame).await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), frame_flushed.notified())
            .await
            .expect("tracked text flush");
        let (close, close_flushed) = WsOutbound::tracked_close();
        tx.send(close).await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), close_flushed.notified())
            .await
            .expect("tracked close flush");
        sender.await.unwrap();
        server.await.unwrap();
    }

    #[test]
    fn binary_frames_fail_closed() {
        let error = classify(Message::Binary(b"terminal secret".to_vec()))
            .expect_err("binary daemon control frame must be rejected");
        assert_eq!(error, InboundFrameError::BinaryForbidden);
    }

    #[test]
    fn malformed_text_errors_retain_no_payload_or_parser_details() {
        let canary = "SIGNED_LOG_CANARY_do_not_emit";
        let error = classify(Message::Text(format!(
            r#"{{"type":"{canary}","signed_envelope":null}}"#
        )))
        .expect_err("unknown frame type must be rejected");
        assert_eq!(error, InboundFrameError::MalformedJson);
        assert!(!format!("{error:?}").contains(canary));
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

    #[tokio::test]
    #[allow(clippy::result_large_err)]
    async fn reader_logs_one_bounded_content_free_diagnostic_per_rejected_frame() {
        const CANARY: &str = "SIGNED_LOG_CANARY_do_not_emit";
        const NEAR_ROUTING_LIMIT: usize = 1100 * 1024 - 1;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind websocket log test");
        let address = listener.local_addr().unwrap();
        let (close_tx, close_rx) = tokio::sync::oneshot::channel();

        let overbound_wire = format!(
            "{CANARY}{}",
            "x".repeat(crate::proto::MAX_SIGNED_RTC_RELAY_BYTES + 1 - CANARY.len())
        );
        let mut near_limit = serde_json::json!({
            "type": "rtc.offer",
            "session_id": "018f0f77-86d2-7a8e-9b1c-1f3b847ca2a1",
            "signed_envelope": overbound_wire,
            "padding": ""
        });
        let empty_len = near_limit.to_string().len();
        near_limit["padding"] = serde_json::json!("p".repeat(NEAR_ROUTING_LIMIT - empty_len));
        let near_limit = near_limit.to_string();
        assert_eq!(near_limit.len(), NEAR_ROUTING_LIMIT);

        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.expect("accept websocket log test");
            let mut socket = tokio_tungstenite::accept_hdr_async(
                tcp,
                |_: &tokio_tungstenite::tungstenite::handshake::server::Request,
                 mut response: tokio_tungstenite::tungstenite::handshake::server::Response| {
                    response.headers_mut().insert(
                        "Sec-WebSocket-Protocol",
                        HeaderValue::from_static(SUBPROTOCOL),
                    );
                    Ok(response)
                },
            )
            .await
            .expect("websocket log test handshake");

            let session_id = "11111111-2222-4333-8444-555555555555";
            let rejected = [
                serde_json::json!({
                    "type": "rtc.offer",
                    "session_id": "018f0f77-86d2-7a8e-9b1c-1f3b847ca2a1",
                    "binding_nonce": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "binding_generation": 7,
                    "scope_type": "session",
                    "scope_id": session_id,
                    "protocol": "spawn.pty",
                    "protocol_version": 2,
                    "signed_envelope": null,
                    "sdp": format!("v=0\r\na={CANARY}\r\n")
                })
                .to_string(),
                format!(r#"{{"type":"rtc.offer","sdp":"{CANARY}","#),
                serde_json::json!({
                    "type": "rtc.offer",
                    "session_id": "018f0f77-86d2-7a8e-9b1c-1f3b847ca2a1",
                    "signed_envelope": {"unknown": CANARY}
                })
                .to_string(),
                near_limit,
            ];
            for frame in rejected {
                socket
                    .send(Message::Text(frame))
                    .await
                    .expect("send rejected text frame");
            }
            socket
                .send(Message::Binary(CANARY.as_bytes().to_vec()))
                .await
                .expect("send rejected binary frame");
            socket
                .send(Message::Text(r#"{"type":"host.heartbeat"}"#.into()))
                .await
                .expect("send valid frame after rejections");
            close_rx.await.expect("reader-alive observation");
            socket.close(None).await.expect("close websocket log test");
        });

        let url = Url::parse(&format!("ws://{address}/api/daemon/ws")).unwrap();
        let stream = connect(&url, "log-test-token")
            .await
            .expect("connect websocket log test");
        let (write_half, read_half) = stream.split();
        let (inbound_tx, mut inbound_rx) = mpsc::channel(4);
        let captured = Arc::new(Mutex::new(Vec::new()));
        let captured_writer = Arc::clone(&captured);
        let subscriber = tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .with_target(false)
            .with_max_level(tracing::Level::WARN)
            .with_writer(move || CapturedLogWriter(Arc::clone(&captured_writer)))
            .finish();
        let reader = run_reader_loop(read_half, inbound_tx).with_subscriber(subscriber);
        let reader_task = tokio::spawn(reader);

        let inbound = tokio::time::timeout(Duration::from_secs(2), inbound_rx.recv())
            .await
            .expect("reader did not survive rejected frames")
            .expect("reader channel closed after rejected frames");
        assert!(
            matches!(inbound, WsInbound::Json(frame) if matches!(*frame, Inbound::HostHeartbeat))
        );
        close_tx.send(()).expect("release websocket log test");
        tokio::time::timeout(Duration::from_secs(1), reader_task)
            .await
            .expect("reader close timeout")
            .expect("reader task");
        drop(write_half);
        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .expect("websocket log server timeout")
            .expect("websocket log server task");

        let log = String::from_utf8(captured.lock().unwrap().clone()).unwrap();
        assert_eq!(
            log.matches("discarding malformed JSON daemon control frame")
                .count(),
            4
        );
        assert_eq!(
            log.matches("discarding binary daemon control frame")
                .count(),
            1
        );
        assert!(log.len() < 512, "diagnostics must stay bounded");
        for forbidden in [
            CANARY,
            "signed_envelope",
            "raw downgrade",
            "spawn.pty",
            "018f0f77",
            "expected value",
            "unknown variant",
        ] {
            assert!(!log.contains(forbidden), "log leaked {forbidden}: {log}");
        }
    }
}
