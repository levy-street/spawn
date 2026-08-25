//! Websocket client glue.
//!
//! Owns the WS connection lifecycle: connect, register, fan inbound frames
//! to the dispatch loop, and a single sender task that owns the write half
//! and is fed by an mpsc channel from any number of per-session reader tasks.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::proto::{Inbound, Outbound};
use crate::pty::WsOutbound;
use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use socket2::{SockRef, TcpKeepalive};
use tokio::net::{lookup_host, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderMap, HeaderValue};
use tokio_tungstenite::tungstenite::protocol::{Message, WebSocketConfig};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use url::Url;

pub type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

const SUBPROTOCOL: &str = "spawn.control.v3";
const PROTOCOL_REQUIRED_CLOSE_CODE: u16 = 4003;
const DNS_TIMEOUT: Duration = Duration::from_secs(5);
const ADDRESS_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const TOTAL_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseDisposition {
    Reconnect,
    Superseded,
    Unauthorized,
    ClientBug,
    ProtocolRequired,
    ImmediateReconnect,
}

#[derive(Debug, thiserror::Error)]
#[error("daemon control websocket closed")]
struct ControlClose(CloseDisposition);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthRefusal {
    Expired,
    Revoked,
    Invalid,
}

impl AuthRefusal {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Expired => "token_expired",
            Self::Revoked => "token_revoked",
            Self::Invalid => "token_invalid",
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("daemon control websocket authentication rejected")]
struct AuthControlClose(AuthRefusal);

#[derive(Debug, thiserror::Error)]
#[error("daemon control websocket connection failed")]
struct ConnectFailure(&'static str);

#[derive(Debug, thiserror::Error)]
#[error("server did not select the required websocket subprotocol")]
struct ProtocolRequired;

pub fn is_protocol_required(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| cause.is::<ProtocolRequired>())
}

pub fn protocol_required_error() -> anyhow::Error {
    ProtocolRequired.into()
}

pub fn close_error(disposition: CloseDisposition) -> anyhow::Error {
    if disposition == CloseDisposition::ProtocolRequired {
        return protocol_required_error();
    }
    ControlClose(disposition).into()
}

pub fn close_error_with_auth(
    disposition: CloseDisposition,
    auth: Option<AuthRefusal>,
) -> anyhow::Error {
    if let Some(auth) = auth {
        return AuthControlClose(auth).into();
    }
    close_error(disposition)
}

pub fn auth_refusal(error: &anyhow::Error) -> Option<AuthRefusal> {
    error
        .chain()
        .find_map(|cause| cause.downcast_ref::<AuthControlClose>().map(|auth| auth.0))
}

pub fn close_disposition(error: &anyhow::Error) -> Option<CloseDisposition> {
    let disposition = error
        .chain()
        .find_map(|cause| cause.downcast_ref::<ControlClose>().map(|close| close.0));
    disposition.or_else(|| auth_refusal(error).map(|_| CloseDisposition::Unauthorized))
}

pub fn failure_class(error: &anyhow::Error) -> &'static str {
    if is_protocol_required(error) {
        return "protocol_required";
    }
    if auth_refusal(error).is_some()
        || close_disposition(error) == Some(CloseDisposition::Unauthorized)
    {
        return "unauthorized";
    }
    error
        .chain()
        .find_map(|cause| {
            cause
                .downcast_ref::<ConnectFailure>()
                .map(|failure| failure.0)
        })
        .unwrap_or("handshake")
}

/// Open a WS/WSS connection with `Authorization: Bearer <token>` and
/// `Sec-WebSocket-Protocol: spawn.control.v3`. We TCP-connect manually first so we
/// can enable TCP keepalive on the socket — without it, a half-dead remote
/// (e.g. `uvicorn` shut down without a clean WS close) leaves the daemon's
/// socket in `CLOSE-WAIT` indefinitely with no way for tungstenite to
/// notice. With keepalive at 30s/5s/3 (idle/interval/probes), the kernel
/// surfaces the death within ~45s and read/write start failing.
pub async fn connect(ws_url: &Url, token: &str) -> Result<WsStream> {
    connect_with_timeout(ws_url, token, TOTAL_CONNECT_TIMEOUT).await
}

async fn connect_with_timeout(ws_url: &Url, token: &str, total: Duration) -> Result<WsStream> {
    tokio::time::timeout(total, connect_inner(ws_url, token))
        .await
        .map_err(|_| ConnectFailure("timeout"))?
}

async fn connect_inner(ws_url: &Url, token: &str) -> Result<WsStream> {
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

    if !matches!(ws_url.scheme(), "ws" | "wss") {
        return Err(ConnectFailure("handshake").into());
    }
    let host = ws_url
        .host_str()
        .ok_or_else(|| anyhow!("ws url has no host"))?;
    let port = ws_url
        .port_or_known_default()
        .ok_or_else(|| anyhow!("ws url has no resolvable port"))?;

    // Lookup + connect TCP ourselves so we can configure keepalive before
    // handing the stream to tokio-tungstenite.
    let resolved = tokio::time::timeout(DNS_TIMEOUT, lookup_host((host, port)))
        .await
        .map_err(|_| ConnectFailure("dns"))?
        .map_err(|_| ConnectFailure("dns"))?
        .collect::<Vec<_>>();
    let addresses = alternate_address_families(resolved);
    if addresses.is_empty() {
        return Err(ConnectFailure("dns").into());
    }
    let mut tcp = None;
    for address in addresses {
        if let Ok(Ok(stream)) =
            tokio::time::timeout(ADDRESS_CONNECT_TIMEOUT, TcpStream::connect(address)).await
        {
            tcp = Some(stream);
            break;
        }
    }
    let tcp = tcp.ok_or(ConnectFailure("tcp"))?;
    tcp.set_nodelay(true).map_err(|_| ConnectFailure("tcp"))?;
    if let Err(e) = configure_keepalive(&tcp) {
        tracing::warn!(error = %e, "could not enable TCP keepalive on ws socket");
    }

    // Hand the configured TCP stream to tungstenite. The helper preserves a
    // bare stream for `ws://` and performs the TLS upgrade for `wss://`.
    // Explorer fs.read/fs.write payloads can be ~43MB of base64 in a single
    // frame (the server's websockets stack doesn't fragment sends), so lift
    // tungstenite's 16MiB-frame / 64MiB-message defaults.
    let ws_config = WebSocketConfig {
        max_message_size: Some(96 * 1024 * 1024),
        max_frame_size: Some(96 * 1024 * 1024),
        ..WebSocketConfig::default()
    };

    let (stream, response) =
        tokio_tungstenite::client_async_tls_with_config(req, tcp, Some(ws_config), None)
            .await
            .map_err(|error| match error {
                tokio_tungstenite::tungstenite::Error::Tls(_) => ConnectFailure("tls"),
                tokio_tungstenite::tungstenite::Error::Http(ref response)
                    if matches!(response.status().as_u16(), 401 | 403) =>
                {
                    ConnectFailure("unauthorized")
                }
                _ => ConnectFailure("handshake"),
            })?;

    require_selected_subprotocol(response.headers())?;

    Ok(stream)
}

fn alternate_address_families(addresses: Vec<SocketAddr>) -> Vec<SocketAddr> {
    let mut v6 = addresses.iter().copied().filter(SocketAddr::is_ipv6);
    let mut v4 = addresses.iter().copied().filter(SocketAddr::is_ipv4);
    let prefer_v6 = addresses.first().is_some_and(SocketAddr::is_ipv6);
    let mut result = Vec::with_capacity(addresses.len());
    loop {
        let (first, second) = if prefer_v6 {
            (v6.next(), v4.next())
        } else {
            (v4.next(), v6.next())
        };
        if first.is_none() && second.is_none() {
            break;
        }
        result.extend(first);
        result.extend(second);
    }
    result
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
        disposition: CloseDisposition,
        auth_refusal: Option<AuthRefusal>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReaderOutcome {
    Closed(CloseDisposition, Option<AuthRefusal>),
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
        Message::Close(frame) => {
            let code = frame.as_ref().map_or(1006, |close| u16::from(close.code));
            let auth_refusal = frame.as_ref().and_then(|close| {
                if code != 1008 {
                    return None;
                }
                match close.reason.as_ref() {
                    "token_expired" => Some(AuthRefusal::Expired),
                    "token_revoked" => Some(AuthRefusal::Revoked),
                    "token_invalid" => Some(AuthRefusal::Invalid),
                    _ => None,
                }
            });
            Ok(Some(WsInbound::Closed {
                disposition: close_disposition_for_code(code),
                auth_refusal,
            }))
        }
        Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => Ok(None),
    }
}

fn close_disposition_for_code(code: u16) -> CloseDisposition {
    match code {
        1008 => CloseDisposition::Unauthorized,
        4000 => CloseDisposition::Superseded,
        4002 => CloseDisposition::ClientBug,
        PROTOCOL_REQUIRED_CLOSE_CODE => CloseDisposition::ProtocolRequired,
        4010 => CloseDisposition::ImmediateReconnect,
        _ => CloseDisposition::Reconnect,
    }
}

/// Drain the outbound mpsc into the WS write half. Exits when the receiver
/// closes (registry dropped) or a send error occurs.
pub async fn run_sender_loop(
    mut stream_tx: futures_util::stream::SplitSink<WsStream, Message>,
    mut rx: mpsc::Receiver<WsOutbound>,
) {
    while let Some(out) = rx.recv().await {
        let (text, ping, close, flushed) = out.into_parts();
        let res = if close {
            stream_tx.close().await
        } else if ping {
            stream_tx.send(Message::Ping(Vec::new())).await
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
    pong_count: Arc<AtomicU64>,
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
            return ReaderOutcome::Closed(CloseDisposition::Reconnect, None);
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
                return ReaderOutcome::Closed(CloseDisposition::Reconnect, None);
            }
        };
        let Some(msg) = msg_opt else {
            return ReaderOutcome::Closed(CloseDisposition::Reconnect, None);
        };
        let msg = match msg {
            Ok(m) => m,
            Err(_) => {
                // Tungstenite protocol errors can include peer-controlled
                // close reasons. Keep the ingress diagnostic content-free.
                tracing::warn!("daemon control websocket read failed");
                return ReaderOutcome::Closed(CloseDisposition::Reconnect, None);
            }
        };
        if matches!(msg, Message::Pong(_)) {
            pong_count.fetch_add(1, Ordering::Relaxed);
            last_meaningful = Instant::now();
            continue;
        }
        match classify(msg) {
            Ok(Some(WsInbound::Closed {
                disposition,
                auth_refusal,
            })) => {
                let _ = inbound_tx
                    .send(WsInbound::Closed {
                        disposition,
                        auth_refusal,
                    })
                    .await;
                return ReaderOutcome::Closed(disposition, auth_refusal);
            }
            Ok(Some(other)) => {
                last_meaningful = Instant::now();
                if inbound_tx.send(other).await.is_err() {
                    return ReaderOutcome::Closed(CloseDisposition::Reconnect, None);
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

/// AWS full-jitter backoff: uniformly select from zero through the exponential
/// ceiling (1s, 2s, 4s, ...), capped at 60s.
pub fn backoff_for_attempt(attempt: u32) -> Duration {
    let ceiling_ms = backoff_ceiling(attempt).as_millis() as u64;
    let mut random = [0_u8; 8];
    if getrandom::getrandom(&mut random).is_err() {
        return Duration::from_millis(ceiling_ms / 2);
    }
    Duration::from_millis(u64::from_le_bytes(random) % (ceiling_ms + 1))
}

/// Tracks Pong progress between Ping sends. The first tick only sends a Ping;
/// a miss is counted on the following tick, after the peer had a full interval
/// in which to answer it.
pub struct PongLiveness {
    observed: u64,
    missed: u8,
    ping_outstanding: bool,
}

impl PongLiveness {
    pub fn new(observed: u64) -> Self {
        Self {
            observed,
            missed: 0,
            ping_outstanding: false,
        }
    }

    /// Record the result of the previous Ping immediately before sending the
    /// next one. Returns true after two consecutive unanswered Pings.
    pub fn before_ping(&mut self, current: u64) -> bool {
        if self.ping_outstanding {
            if current == self.observed {
                self.missed = self.missed.saturating_add(1);
            } else {
                self.missed = 0;
                self.observed = current;
            }
        }
        self.ping_outstanding = true;
        self.missed >= 2
    }
}

fn backoff_ceiling(attempt: u32) -> Duration {
    let secs = 1_u64.checked_shl(attempt.min(6)).unwrap_or(60).min(60);
    Duration::from_secs(secs)
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
                disposition: CloseDisposition::ProtocolRequired,
                ..
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
                disposition: CloseDisposition::Reconnect,
                ..
            }
        ));
    }

    #[test]
    fn token_close_reasons_are_bounded_and_preserved_for_local_auth_health() {
        use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
        use tokio_tungstenite::tungstenite::protocol::CloseFrame;

        for (reason, expected) in [
            ("token_expired", AuthRefusal::Expired),
            ("token_revoked", AuthRefusal::Revoked),
            ("token_invalid", AuthRefusal::Invalid),
        ] {
            let classified = classify(Message::Close(Some(CloseFrame {
                code: CloseCode::Policy,
                reason: reason.into(),
            })))
            .unwrap()
            .unwrap();
            assert!(matches!(
                classified,
                WsInbound::Closed {
                    disposition: CloseDisposition::Unauthorized,
                    auth_refusal: Some(actual),
                } if actual == expected
            ));
            let error = close_error_with_auth(CloseDisposition::Unauthorized, Some(expected));
            assert_eq!(auth_refusal(&error), Some(expected));
            assert_eq!(
                close_disposition(&error),
                Some(CloseDisposition::Unauthorized)
            );
            assert_eq!(failure_class(&error), "unauthorized");
        }

        let untrusted = classify(Message::Close(Some(CloseFrame {
            code: CloseCode::Policy,
            reason: "attacker-controlled detail".into(),
        })))
        .unwrap()
        .unwrap();
        assert!(matches!(
            untrusted,
            WsInbound::Closed {
                auth_refusal: None,
                ..
            }
        ));
    }

    #[test]
    fn protocol_update_backoff_is_separate_from_the_normal_ladder() {
        assert_eq!(backoff_ceiling(0), Duration::from_secs(1));
        assert_eq!(backoff_ceiling(6), Duration::from_secs(60));
        assert_eq!(backoff_ceiling(99), Duration::from_secs(60));
        for attempt in 0..10 {
            assert!(backoff_for_attempt(attempt) <= backoff_ceiling(attempt));
        }
        assert_eq!(self_update_backoff(), Duration::from_secs(5 * 60));
    }

    #[test]
    fn pong_liveness_allows_two_complete_reply_windows() {
        let mut liveness = PongLiveness::new(0);
        assert!(!liveness.before_ping(0), "first tick only sends a ping");
        assert!(!liveness.before_ping(0), "first unanswered ping");
        assert!(liveness.before_ping(0), "second unanswered ping");

        let mut recovered = PongLiveness::new(4);
        assert!(!recovered.before_ping(4));
        assert!(!recovered.before_ping(4));
        assert!(
            !recovered.before_ping(5),
            "a pong resets consecutive misses"
        );
        assert!(!recovered.before_ping(5));
        assert!(recovered.before_ping(5));
    }

    #[test]
    fn close_codes_have_stable_reconnect_policy() {
        assert_eq!(
            close_disposition_for_code(1008),
            CloseDisposition::Unauthorized
        );
        assert_eq!(
            close_disposition_for_code(4000),
            CloseDisposition::Superseded
        );
        assert_eq!(
            close_disposition_for_code(4002),
            CloseDisposition::ClientBug
        );
        assert_eq!(
            close_disposition_for_code(4010),
            CloseDisposition::ImmediateReconnect
        );
        for code in [1000, 1001, 1006, 1012, 1013, 4008] {
            assert_eq!(
                close_disposition_for_code(code),
                CloseDisposition::Reconnect
            );
        }
    }

    #[test]
    fn resolved_addresses_alternate_families() {
        let addresses = vec![
            "[2001:db8::1]:443".parse().unwrap(),
            "[2001:db8::2]:443".parse().unwrap(),
            "192.0.2.1:443".parse().unwrap(),
            "192.0.2.2:443".parse().unwrap(),
        ];
        let ordered = alternate_address_families(addresses);
        assert!(ordered[0].is_ipv6());
        assert!(ordered[1].is_ipv4());
        assert!(ordered[2].is_ipv6());
        assert!(ordered[3].is_ipv4());
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

    #[tokio::test]
    async fn whole_connect_times_out_when_the_server_never_handshakes() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!(
            "ws://{}/ws/daemon",
            listener.local_addr().unwrap()
        ))
        .unwrap();

        let error = connect_with_timeout(&url, "test-token", Duration::from_millis(50))
            .await
            .expect_err("a server that never accepts must hit the whole-connect deadline");
        assert_eq!(failure_class(&error), "timeout");
        drop(listener);
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
        let reader = run_reader_loop(read_half, inbound_tx, Arc::new(AtomicU64::new(0)))
            .with_subscriber(subscriber);
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
