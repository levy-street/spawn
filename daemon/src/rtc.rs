//! WebRTC direct terminal transport.
//!
//! The central websocket remains the authenticated, content-free control and
//! signaling plane. Raw PTY input/output and replay are endpoint-only.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use anyhow::{Context, Result};
use arc_swap::ArcSwapOption;
use bytes::Bytes;
#[cfg(test)]
use serde_json::json;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot, Mutex, Notify, OwnedSemaphorePermit, Semaphore};
use uuid::Uuid;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::setting_engine::{SctpMaxMessageSize, SettingEngine};
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::data_channel_state::RTCDataChannelState;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice::mdns::MulticastDnsMode;
use webrtc::ice::udp_network::{EphemeralUDP, UDPNetwork};
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::policy::ice_transport_policy::RTCIceTransportPolicy;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;

use crate::host_files::HostFileService;
use crate::host_signal::HostConnectedSignal;
use crate::proto::{LiveRtcBinding, Outbound, RtcIceServerConfig};
use crate::pty::{ForwarderControl, WsOutbound};
use crate::session_ctl::{
    self, ControlOperation, ControlOutbound, ControlRequest, ControlSender, ProtocolError,
    SessionControlHub,
};
use crate::sessions::{SessionBinding, SessionRegistry};
use crate::upload::{
    UploadChunkOutcome, UploadChunkRequest, UploadHub, UploadManifest, UploadStartOutcome,
    UPLOAD_CLOSE_TIMEOUT,
};

/// Signs a negotiated answer SDP, returning the opaque signed-signal wire
/// envelope. Present only for a verified signed offer; absent leaves the answer
/// as raw SDP. Owned and `Send + Sync` so it can move into the negotiation task.
pub type RtcAnswerSigner = Arc<dyn Fn(&str) -> Result<String> + Send + Sync>;

const PTY_DATA_CHANNEL_LABEL: &str = "spawn.pty";
const CONTROL_DATA_CHANNEL_LABEL: &str = "spawn.ctl";
const SESSION_RTC_PROTOCOL_VERSION: u16 = 2;
const HOST_CONTROL_LABEL: &str = "spawn.host.ctl";
const RTC_PROTOCOL_VERSION: u16 = 1;
#[cfg(test)]
const HOST_CONTROL_MAX_FRAME_BYTES: usize = 16 * 1024;
#[cfg(test)]
const HOST_CONTROL_MAX_REQUEST_ID_BYTES: usize = 128;
const MAX_RTC_PEERS: usize = 128;
const MAX_HOST_RTC_PEERS: usize = 64;
const MAX_SAFE_SIGNAL_GENERATION: u64 = 9_007_199_254_740_991;

fn upload_teardown_deadline() -> tokio::time::Instant {
    let timeout = if cfg!(test) {
        Duration::from_millis(100)
    } else {
        UPLOAD_CLOSE_TIMEOUT
    };
    tokio::time::Instant::now() + timeout
}

/// Peer connections that never reach `Connected` within this window are
/// reaped. Closing is the daemon's own defense: `rtc.close` delivery from the
/// browser/server is best-effort, and every unreaped peer connection holds
/// multiple UDP sockets (ICE host candidates + mDNS) until closed — webrtc-rs
/// does NOT release them on drop.
const RTC_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Grace period for a connected peer that reports `Disconnected` (transient
/// network blips) before the daemon closes it.
const RTC_DISCONNECTED_GRACE: Duration = Duration::from_secs(15);
#[cfg(not(test))]
const REQUIRED_SESSION_CHANNEL_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(test)]
const REQUIRED_SESSION_CHANNEL_TIMEOUT: Duration = Duration::from_secs(3);
/// How long the daemon waits for one obfuscated `<name>.local` candidate to
/// resolve.
///
/// A hit is immediate once the responder has answered once, but the first
/// query of a connection is a multicast round trip and was measured taking
/// over a second and a half on a quiet LAN — a shorter bound than this threw
/// away the first candidate of every connection and left ICE waiting for the
/// client to try again. macOS gives up on a name nobody answers for after
/// five seconds, so the cost of a miss is bounded either way, and the peer
/// connection has [`RTC_CONNECT_TIMEOUT`] to spare.
const MDNS_CANDIDATE_RESOLVE_TIMEOUT: Duration = Duration::from_secs(4);
const DATA_CHANNEL_MESSAGE_BYTES: usize = 16 * 1024;
const DATA_CHANNEL_BUFFER_LOW: usize = 64 * 1024;
const DATA_CHANNEL_BUFFER_HIGH: usize = 512 * 1024;
const RTC_UDP_PORT_MIN: u16 = 50_000;
const RTC_UDP_PORT_MAX: u16 = 50_100;
static RTC_NETWORK_POLICY_LOGGED: AtomicBool = AtomicBool::new(false);
static TURN_UDP_WARNING_LOGGED: AtomicBool = AtomicBool::new(false);

type SessionCloserMap = HashMap<(Uuid, u64), Weak<Mutex<()>>>;
#[cfg(test)]
type TestEffectGateMap = HashMap<(String, TestEffectPoint), Arc<TestEffectGate>>;
#[cfg(test)]
type TestSenderCloseGateMap = HashMap<(String, SessionChannel), Arc<TestSenderCloseGate>>;

#[derive(Clone, Default)]
pub struct RtcSessions {
    peers: Arc<Mutex<HashMap<String, RtcPeer>>>,
    host_peers: Arc<Mutex<HashMap<String, HostRtcPeer>>>,
    admission: Arc<Mutex<()>>,
    /// Changes before trust-reload teardown. Offers capture this value before
    /// RTC construction and must still match while admission is serialized.
    trust_epoch: Arc<AtomicU64>,
    registered_host_id: Arc<Mutex<Option<Uuid>>>,
    session_closers: Arc<Mutex<SessionCloserMap>>,
    controls: SessionControlHub,
    uploads: UploadHub,
    peer_cleanup_tasks: Arc<Mutex<tokio::task::JoinSet<()>>>,
    closing_peers: Arc<Mutex<HashMap<(String, String), RtcPeer>>>,
    peer_admission: RtcPeerAdmission,
    api: Arc<OnceLock<webrtc::api::API>>,
    signaling: RtcWsSender,
    deferred_statuses: Arc<Mutex<HashMap<String, Outbound>>>,
    #[cfg(test)]
    peer_insert_attempted: Arc<tokio::sync::Notify>,
    #[cfg(test)]
    pty_send_gates: Arc<Mutex<HashMap<String, Arc<tokio::sync::Notify>>>>,
    #[cfg(test)]
    effect_gates: Arc<Mutex<TestEffectGateMap>>,
    #[cfg(test)]
    slow_close_all_gate: Arc<Mutex<Option<Arc<TestEffectGate>>>>,
    #[cfg(test)]
    sender_close_gates: Arc<Mutex<TestSenderCloseGateMap>>,
}

#[derive(Clone, Default)]
pub(crate) struct RtcWsSender {
    current: Arc<ArcSwapOption<mpsc::Sender<WsOutbound>>>,
}

impl RtcWsSender {
    fn install(&self, sender: mpsc::Sender<WsOutbound>) {
        self.current.store(Some(Arc::new(sender)));
    }

    fn clear(&self) {
        self.current.store(None);
    }

    fn load(&self) -> Option<Arc<mpsc::Sender<WsOutbound>>> {
        self.current.load_full()
    }

    pub(crate) fn try_send(&self, frame: Outbound) -> bool {
        let Ok(text) = serde_json::to_string(&frame) else {
            return false;
        };
        let Some(sender) = self.load() else {
            return true;
        };
        match sender.try_send(WsOutbound::json(text)) {
            Ok(())
            | Err(tokio::sync::mpsc::error::TrySendError::Full(_))
            | Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => true,
        }
    }
}

#[derive(Clone)]
struct RtcPeerAdmission {
    slots: Arc<Semaphore>,
}

impl Default for RtcPeerAdmission {
    fn default() -> Self {
        Self {
            slots: Arc::new(Semaphore::new(MAX_RTC_PEERS)),
        }
    }
}

struct RtcPeerAdmissionPermit {
    _permit: OwnedSemaphorePermit,
}

impl RtcPeerAdmission {
    fn try_acquire(&self) -> Option<Arc<RtcPeerAdmissionPermit>> {
        Arc::clone(&self.slots)
            .try_acquire_owned()
            .ok()
            .map(|permit| Arc::new(RtcPeerAdmissionPermit { _permit: permit }))
    }

    #[cfg(test)]
    fn charged(&self) -> usize {
        MAX_RTC_PEERS - self.slots.available_permits()
    }
}

#[derive(Default)]
struct PeerCloseCoordinator {
    deadline: OnceLock<tokio::time::Instant>,
}

impl PeerCloseCoordinator {
    fn initiate(&self) -> tokio::time::Instant {
        *self.deadline.get_or_init(upload_teardown_deadline)
    }

    #[cfg(test)]
    fn initiated_deadline(&self) -> Option<tokio::time::Instant> {
        self.deadline.get().copied()
    }
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum TestEffectPoint {
    CloseAllSnapshot,
    ControlRequest,
    PtyInput,
    PtySink,
    Ready,
}

#[cfg(test)]
#[derive(Default)]
pub(crate) struct TestEffectGate {
    entered: Notify,
    release: Notify,
}

#[cfg(test)]
impl TestEffectGate {
    pub(crate) async fn wait_entered(&self) {
        self.entered.notified().await;
    }

    pub(crate) fn release(&self) {
        self.release.notify_one();
    }
}

#[cfg(test)]
#[derive(Default)]
struct TestSenderCloseGate {
    exit: Notify,
    entered: Notify,
    release: Notify,
    failure_at: OnceLock<tokio::time::Instant>,
    deadline: OnceLock<tokio::time::Instant>,
}

#[cfg(test)]
async fn wait_test_sender_exit(gate: &Option<Arc<TestSenderCloseGate>>) {
    match gate {
        Some(gate) => {
            gate.exit.notified().await;
            let _ = gate.failure_at.set(tokio::time::Instant::now());
        }
        None => std::future::pending().await,
    }
}

#[cfg(test)]
async fn pause_test_sender_close(
    gate: &Option<Arc<TestSenderCloseGate>>,
    close: &PeerCloseCoordinator,
) {
    if let Some(gate) = gate {
        gate.deadline
            .set(close.initiated_deadline().expect("sender close deadline"))
            .expect("sender close deadline only recorded once");
        gate.entered.notify_one();
        gate.release.notified().await;
    }
}

#[derive(Clone)]
struct HostRtcPeer {
    pc: Arc<RTCPeerConnection>,
    binding: HostRtcBinding,
    _admission_permit: Arc<RtcPeerAdmissionPermit>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct HostRtcBinding {
    pub(crate) host_id: Uuid,
    pub(crate) binding_nonce: String,
    /// Zero only for a legacy server that did not include the daemon-owner
    /// generation on host-scope frames. New servers provide the exact value so
    /// the binding can be reconciled across control-WebSocket reconnects.
    pub(crate) binding_generation: u64,
    pub(crate) protocol: String,
    pub(crate) protocol_version: u16,
}

/// Immutable host-scope identity supplied on offer/candidate/close frames.
#[derive(Clone)]
pub struct HostRtcSignal {
    pub signal_id: String,
    pub binding_nonce: Option<String>,
    pub binding_generation: Option<u64>,
    pub scope_type: Option<String>,
    pub scope_id: Option<Uuid>,
    pub protocol: Option<String>,
    pub protocol_version: Option<u16>,
}

impl HostRtcSignal {
    fn binding(&self) -> Option<HostRtcBinding> {
        let nonce = self.binding_nonce.as_ref()?;
        let generation = self.binding_generation.unwrap_or(0);
        if nonce.len() != 32
            || !nonce
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || self.scope_type.as_deref() != Some("host")
            || self.protocol.as_deref() != Some(HOST_CONTROL_LABEL)
            || self.protocol_version != Some(RTC_PROTOCOL_VERSION)
            || generation > MAX_SAFE_SIGNAL_GENERATION
        {
            return None;
        }
        Some(HostRtcBinding {
            host_id: self.scope_id?,
            binding_nonce: nonce.clone(),
            binding_generation: generation,
            protocol: HOST_CONTROL_LABEL.to_string(),
            protocol_version: RTC_PROTOCOL_VERSION,
        })
    }
}

#[derive(Clone)]
struct RtcPeer {
    pc: Arc<RTCPeerConnection>,
    session: SessionBinding,
    generation: String,
    active: Arc<AtomicBool>,
    control: ForwarderControl,
    channels: Arc<RequiredSessionChannels>,
    close: Arc<PeerCloseCoordinator>,
    offer_key: Option<[u8; 32]>,
    remote_ufrags: Arc<Mutex<HashSet<String>>>,
    restart_lock: Arc<Mutex<()>>,
    _admission_permit: Arc<RtcPeerAdmissionPermit>,
    /// Replacement sets `active` false, closes the PC, then takes this write
    /// lock. Every callback holds a read lock while touching its backend, so
    /// `close_for_session` does not return until old-generation work has drained.
    fence: Arc<tokio::sync::RwLock<()>>,
}

/// Immutable identity assigned by the signaling broker to one RTC attempt.
///
/// Keeping the three binding fields together makes it difficult to
/// accidentally validate a session ID while forwarding a stale generation or
/// a different session ID.
#[derive(Clone)]
pub struct RtcSignalBinding {
    signal_id: String,
    binding_nonce: String,
    generation: String,
    session_id: Uuid,
}

impl RtcSignalBinding {
    pub(crate) fn signal_id(&self) -> &str {
        &self.signal_id
    }

    #[cfg(test)]
    pub fn new(signal_id: String, generation: String, session_id: Uuid) -> Self {
        Self {
            signal_id,
            binding_nonce: "a".repeat(32),
            generation,
            session_id,
        }
    }

    /// Bind a session RTC attempt to both the browser nonce and the durable
    /// daemon-owner generation selected by the signaling server. The
    /// composite key is daemon-local only; signaling responses echo the nonce
    /// and the server restores its own generation token.
    pub fn from_server(
        signal_id: String,
        binding_nonce: String,
        binding_generation: u64,
        session_id: Uuid,
    ) -> Option<Self> {
        if !valid_binding_nonce(&binding_nonce)
            || binding_generation == 0
            || binding_generation > MAX_SAFE_SIGNAL_GENERATION
        {
            return None;
        }
        Some(Self {
            signal_id,
            generation: format!("{binding_generation}:{binding_nonce}"),
            binding_nonce,
            session_id,
        })
    }

    pub fn into_routing_parts(self) -> (String, String, Uuid) {
        (self.signal_id, self.generation, self.session_id)
    }
}

fn valid_binding_nonce(nonce: &str) -> bool {
    nonce.len() == 32
        && nonce
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Clone)]
struct BoundRtcSession {
    signaling: RtcSignalBinding,
    session: SessionBinding,
    control: ForwarderControl,
    trust_epoch: u64,
}

struct HostRtcAdmissionContext {
    trust_epoch: u64,
    out_tx: mpsc::Sender<WsOutbound>,
}

#[derive(Clone)]
struct RtcCallbackGuard {
    active: Arc<AtomicBool>,
    fence: Arc<tokio::sync::RwLock<()>>,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum SessionChannel {
    Pty,
    Control,
}

#[derive(Default)]
struct SessionChannelState {
    pty_seen: bool,
    control_seen: bool,
    pty_open: bool,
    control_open: bool,
    failed: bool,
}

#[derive(Default)]
struct RequiredSessionChannels {
    state: Mutex<SessionChannelState>,
    changed: Notify,
    ready: AtomicBool,
    failed: AtomicBool,
    effects: Arc<tokio::sync::RwLock<()>>,
    control_sender: std::sync::Mutex<Option<ControlSender>>,
}

struct SessionEffectPermit {
    channels: Arc<RequiredSessionChannels>,
    _guard: tokio::sync::OwnedRwLockReadGuard<()>,
}

impl SessionEffectPermit {
    fn valid(&self) -> bool {
        self.channels.ready.load(Ordering::SeqCst) && !self.channels.failed.load(Ordering::SeqCst)
    }
}

struct SessionFailurePermit {
    _guard: tokio::sync::OwnedRwLockWriteGuard<()>,
}

impl RequiredSessionChannels {
    fn ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst) && !self.failed.load(Ordering::SeqCst)
    }

    fn stop(&self) {
        self.failed.store(true, Ordering::SeqCst);
        self.ready.store(false, Ordering::SeqCst);
        self.changed.notify_waiters();
    }

    fn set_control_sender(&self, sender: ControlSender) {
        *self.control_sender.lock().expect("control sender lock") = Some(sender);
    }

    fn control_sender(&self) -> Option<ControlSender> {
        self.control_sender
            .lock()
            .expect("control sender lock")
            .clone()
    }

    async fn permit(self: &Arc<Self>) -> Option<SessionEffectPermit> {
        if !self.ready() {
            return None;
        }
        let guard = Arc::clone(&self.effects).read_owned().await;
        if !self.ready() {
            return None;
        }
        Some(SessionEffectPermit {
            channels: Arc::clone(self),
            _guard: guard,
        })
    }

    async fn register(&self, channel: SessionChannel) -> bool {
        let mut state = self.state.lock().await;
        let seen = match channel {
            SessionChannel::Pty => &mut state.pty_seen,
            SessionChannel::Control => &mut state.control_seen,
        };
        if *seen {
            state.failed = true;
            self.stop();
            return false;
        }
        *seen = true;
        true
    }

    async fn mark_open(&self, channel: SessionChannel) {
        let mut state = self.state.lock().await;
        match channel {
            SessionChannel::Pty => state.pty_open = true,
            SessionChannel::Control => state.control_open = true,
        }
        if !state.failed
            && !self.failed.load(Ordering::SeqCst)
            && state.pty_open
            && state.control_open
        {
            self.ready.store(true, Ordering::SeqCst);
            if self.failed.load(Ordering::SeqCst) {
                self.ready.store(false, Ordering::SeqCst);
            }
        }
        self.changed.notify_waiters();
    }

    async fn fail(self: &Arc<Self>) -> SessionFailurePermit {
        self.stop();
        let mut state = self.state.lock().await;
        state.failed = true;
        self.ready.store(false, Ordering::SeqCst);
        self.changed.notify_waiters();
        drop(state);
        SessionFailurePermit {
            _guard: Arc::clone(&self.effects).write_owned().await,
        }
    }

    async fn wait_ready(&self) -> bool {
        loop {
            let changed = self.changed.notified();
            {
                let state = self.state.lock().await;
                if state.failed || self.failed.load(Ordering::SeqCst) {
                    return false;
                }
                if self.ready() {
                    return true;
                }
            }
            changed.await;
        }
    }
}

fn viewer_id(signal_id: &str, generation: &str) -> String {
    format!("{signal_id}:{generation}")
}

impl RtcSessions {
    pub fn new() -> Self {
        let sessions = Self::default();
        sessions
            .api
            .set(build_api().expect("static WebRTC API configuration"))
            .ok();
        sessions
    }

    pub fn install_ws_sender(&self, sender: mpsc::Sender<WsOutbound>) {
        self.signaling.install(sender);
    }

    pub fn clear_ws_sender(&self) {
        self.signaling.clear();
    }

    pub async fn live_bindings(&self) -> Vec<LiveRtcBinding> {
        let sessions = self.peers.lock().await;
        let mut live = sessions
            .iter()
            .map(|(signal_id, peer)| LiveRtcBinding {
                session_id: signal_id.clone(),
                binding_nonce: peer
                    .generation
                    .split_once(':')
                    .map_or_else(String::new, |(_, nonce)| nonce.to_string()),
                binding_generation: peer
                    .generation
                    .split_once(':')
                    .and_then(|(generation, _)| generation.parse().ok())
                    .unwrap_or(0),
                scope_type: "session".to_string(),
                scope_id: peer.session.session_id(),
                protocol: PTY_DATA_CHANNEL_LABEL.to_string(),
                protocol_version: SESSION_RTC_PROTOCOL_VERSION,
            })
            .collect::<Vec<_>>();
        drop(sessions);
        live.extend(
            self.host_peers
                .lock()
                .await
                .iter()
                .map(|(signal_id, peer)| LiveRtcBinding {
                    session_id: signal_id.clone(),
                    binding_nonce: peer.binding.binding_nonce.clone(),
                    binding_generation: peer.binding.binding_generation,
                    scope_type: "host".to_string(),
                    scope_id: peer.binding.host_id,
                    protocol: peer.binding.protocol.clone(),
                    protocol_version: peer.binding.protocol_version,
                }),
        );
        live
    }

    pub async fn reannounce_live_statuses(&self) {
        let pending = std::mem::take(&mut *self.deferred_statuses.lock().await);
        for (_, frame) in pending {
            self.send_or_defer_status(frame).await;
        }
        let peers = self.peers.lock().await.clone();
        for (signal_id, peer) in peers {
            if peer.channels.ready() {
                let nonce = peer
                    .generation
                    .split_once(':')
                    .map_or("", |(_, nonce)| nonce);
                self.send_or_defer_status(session_status_frame(
                    &signal_id,
                    nonce,
                    peer.session.session_id(),
                    "connected",
                    None,
                ))
                .await;
            }
        }
        let hosts = self.host_peers.lock().await.clone();
        for (signal_id, peer) in hosts {
            if peer.pc.connection_state() == RTCPeerConnectionState::Connected {
                self.send_or_defer_status(host_status_frame(signal_id, &peer.binding, "connected"))
                    .await;
            }
        }
    }

    async fn send_or_defer_status(&self, frame: Outbound) -> bool {
        let key = match &frame {
            Outbound::RtcStatus { session_id, .. } => session_id.clone(),
            _ => return false,
        };
        let Some(sender) = self.signaling.load() else {
            self.deferred_statuses.lock().await.insert(key, frame);
            return true;
        };
        let Ok(text) = serde_json::to_string(&frame) else {
            return false;
        };
        match sender.try_send(WsOutbound::json(text)) {
            Ok(()) => true,
            Err(tokio::sync::mpsc::error::TrySendError::Full(_))
            | Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                self.deferred_statuses.lock().await.insert(key, frame);
                true
            }
        }
    }

    fn capture_trust_epoch(&self) -> u64 {
        self.trust_epoch.load(Ordering::SeqCst)
    }

    fn trust_epoch_is_current(&self, captured: u64) -> bool {
        self.capture_trust_epoch() == captured
    }

    #[cfg(test)]
    async fn stall_effect(&self, signal_id: &str, point: TestEffectPoint) -> Arc<TestEffectGate> {
        let gate = Arc::new(TestEffectGate::default());
        self.effect_gates
            .lock()
            .await
            .insert((signal_id.to_string(), point), Arc::clone(&gate));
        gate
    }

    #[cfg(test)]
    pub(crate) async fn stall_next_close_all_for_test(&self) -> Arc<TestEffectGate> {
        let gate = Arc::new(TestEffectGate::default());
        *self.slow_close_all_gate.lock().await = Some(Arc::clone(&gate));
        gate
    }

    #[cfg(test)]
    async fn pause_effect(&self, signal_id: &str, point: TestEffectPoint) {
        let gate = self
            .effect_gates
            .lock()
            .await
            .remove(&(signal_id.to_string(), point));
        if let Some(gate) = gate {
            gate.entered.notify_one();
            gate.release.notified().await;
        }
    }

    #[cfg(test)]
    async fn stall_sender_close(
        &self,
        signal_id: &str,
        channel: SessionChannel,
    ) -> Arc<TestSenderCloseGate> {
        let gate = Arc::new(TestSenderCloseGate::default());
        self.sender_close_gates
            .lock()
            .await
            .insert((signal_id.to_string(), channel), Arc::clone(&gate));
        gate
    }

    pub async fn bind_registered_host_id(&self, host_id: Uuid) -> bool {
        let mut registered = self.registered_host_id.lock().await;
        if registered.is_some_and(|current| current != host_id) {
            return false;
        }
        *registered = Some(host_id);
        true
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn handle_offer(
        &self,
        binding: RtcSignalBinding,
        sdp: String,
        ice_servers: Vec<RtcIceServerConfig>,
        ice_transport_policy: Option<String>,
        ice_restart: bool,
        offer_key: Option<[u8; 32]>,
        registry: SessionRegistry,
        out_tx: mpsc::Sender<WsOutbound>,
        answer_signer: Option<RtcAnswerSigner>,
    ) {
        self.signaling.install(out_tx.clone());
        let trust_epoch = self.capture_trust_epoch();
        let Some(session) = registry.binding_for(binding.session_id) else {
            send_status(
                &out_tx,
                binding.signal_id,
                binding.binding_nonce,
                binding.session_id,
                "failed",
                Some("session is not running on this daemon"),
            )
            .await;
            return;
        };
        let Some(control) = registry.control_for_binding(session) else {
            send_status(
                &out_tx,
                binding.signal_id,
                binding.binding_nonce,
                binding.session_id,
                "failed",
                Some("session backend was replaced while binding RTC"),
            )
            .await;
            return;
        };
        let bound = BoundRtcSession {
            signaling: binding,
            session,
            control,
            trust_epoch,
        };

        if let Err(e) = self
            .create_answer(
                bound.clone(),
                sdp,
                ice_servers,
                ice_transport_policy,
                ice_restart,
                offer_key,
                registry,
                out_tx.clone(),
                answer_signer,
            )
            .await
        {
            tracing::warn!(
                session_id = %bound.signaling.session_id,
                signal_id = %bound.signaling.signal_id,
                class = "negotiation",
                "rtc offer failed"
            );
            tracing::debug!(
                session_id = %bound.signaling.session_id,
                signal_id = %bound.signaling.signal_id,
                error = %e,
                "rtc offer failure detail"
            );
            send_status(
                &out_tx,
                bound.signaling.signal_id,
                bound.signaling.binding_nonce,
                bound.signaling.session_id,
                "failed",
                Some("RTC negotiation failed"),
            )
            .await;
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn create_answer(
        &self,
        binding: BoundRtcSession,
        sdp: String,
        ice_servers: Vec<RtcIceServerConfig>,
        ice_transport_policy: Option<String>,
        ice_restart: bool,
        offer_key: Option<[u8; 32]>,
        registry: SessionRegistry,
        out_tx: mpsc::Sender<WsOutbound>,
        answer_signer: Option<RtcAnswerSigner>,
    ) -> Result<()> {
        let remote_ufrag = ice_ufrag(&sdp).context("offer SDP has no ICE ufrag")?;
        if let Some(existing) = self
            .peers
            .lock()
            .await
            .get(&binding.signaling.signal_id)
            .cloned()
        {
            let _restart = existing.restart_lock.lock().await;
            let ufrags = existing.remote_ufrags.lock().await;
            if !restart_offer_is_acceptable(
                ice_restart,
                existing.generation == binding.signaling.generation,
                existing.session == binding.session,
                existing.offer_key,
                offer_key,
                restart_ufrag_is_fresh(&ufrags, &remote_ufrag),
            ) {
                anyhow::bail!("rtc restart offer was rejected");
            }
            drop(ufrags);
            let local_sdp = negotiate(&existing.pc, sdp).await?;
            existing.remote_ufrags.lock().await.insert(remote_ufrag);
            let (answer_sdp, answer_signed_envelope) = sign_answer(&local_sdp, &answer_signer)
                .context("signing restarted session RTC answer")?;
            send_json(
                &out_tx,
                Outbound::RtcAnswer {
                    session_id: binding.signaling.signal_id,
                    binding_nonce: Some(binding.signaling.binding_nonce),
                    scope_type: Some("session".to_string()),
                    scope_id: Some(binding.signaling.session_id),
                    protocol: Some(PTY_DATA_CHANNEL_LABEL.to_string()),
                    protocol_version: Some(SESSION_RTC_PROTOCOL_VERSION),
                    sdp: answer_sdp,
                    signed_envelope: answer_signed_envelope,
                },
            )
            .await;
            return Ok(());
        }
        if ice_restart {
            anyhow::bail!("rtc restart refers to an unknown binding");
        }

        let admission_permit = self
            .peer_admission
            .try_acquire()
            .context("rtc session admission capacity exhausted")?;
        warn_if_no_udp_turn(&ice_servers);
        let api = self.api.get().context("WebRTC API was not initialized")?;
        let pc = Arc::new(
            api.new_peer_connection(RTCConfiguration {
                ice_servers: ice_servers.into_iter().map(to_webrtc_ice_server).collect(),
                ice_transport_policy: parse_ice_transport_policy(ice_transport_policy.as_deref())?,
                ..Default::default()
            })
            .await
            .context("creating peer connection")?,
        );
        let active = Arc::new(AtomicBool::new(true));
        let fence = Arc::new(tokio::sync::RwLock::new(()));
        let channels = Arc::new(RequiredSessionChannels::default());
        let close = Arc::new(PeerCloseCoordinator::default());

        // Linearize peer insertion with backend replacement. Construction and
        // SDP work stay outside this guard, but the captured binding is
        // revalidated while insertion is protected by the same per-session lock
        // used to invalidate the registry entry and scan old peers.
        #[cfg(test)]
        self.peer_insert_attempted.notify_waiters();
        let _admission = self.admission.lock().await;
        if !self.trust_epoch_is_current(binding.trust_epoch) {
            let _ = pc.close().await;
            anyhow::bail!("credential trust changed during RTC negotiation");
        }
        let transition = registry
            .lock_generation_transition(binding.signaling.session_id)
            .await;
        if !registry.is_current(binding.session) {
            drop(transition);
            let _ = pc.close().await;
            anyhow::bail!("session backend was replaced during RTC negotiation");
        }

        // Track the peer connection BEFORE SDP negotiation so every exit path
        // below can reach it and close it.
        let host_collision = self
            .host_peers
            .lock()
            .await
            .contains_key(&binding.signaling.signal_id);
        let cleanup_collision = self.closing_peers.lock().await.contains_key(&(
            binding.signaling.signal_id.clone(),
            binding.signaling.generation.clone(),
        ));
        let collision_or_capacity = {
            let mut peers = self.peers.lock().await;
            if host_collision
                || cleanup_collision
                || peers.contains_key(&binding.signaling.signal_id)
            {
                true
            } else {
                peers.insert(
                    binding.signaling.signal_id.clone(),
                    RtcPeer {
                        pc: Arc::clone(&pc),
                        session: binding.session,
                        generation: binding.signaling.generation.clone(),
                        active: Arc::clone(&active),
                        control: binding.control.clone(),
                        channels: Arc::clone(&channels),
                        close: Arc::clone(&close),
                        offer_key,
                        remote_ufrags: Arc::new(Mutex::new(HashSet::from([remote_ufrag]))),
                        restart_lock: Arc::new(Mutex::new(())),
                        _admission_permit: admission_permit,
                        fence: Arc::clone(&fence),
                    },
                );
                false
            }
        };
        drop(transition);
        if collision_or_capacity {
            let _ = pc.close().await;
            anyhow::bail!("rtc session admission rejected");
        }
        drop(_admission);

        install_ice_handler(&pc, binding.signaling.clone(), self.signaling.clone());
        #[cfg(test)]
        let pty_send_gate = self
            .pty_send_gates
            .lock()
            .await
            .remove(&binding.signaling.signal_id);
        #[cfg(test)]
        let pty_sender_close_gate = self
            .sender_close_gates
            .lock()
            .await
            .remove(&(binding.signaling.signal_id.clone(), SessionChannel::Pty));
        #[cfg(test)]
        let control_sender_close_gate = self
            .sender_close_gates
            .lock()
            .await
            .remove(&(binding.signaling.signal_id.clone(), SessionChannel::Control));
        install_data_channel_handler(
            &pc,
            self.clone(),
            binding.clone(),
            registry,
            self.controls.clone(),
            RtcCallbackGuard {
                active: Arc::clone(&active),
                fence,
            },
            channels,
            Arc::clone(&close),
            #[cfg(test)]
            pty_send_gate,
            #[cfg(test)]
            pty_sender_close_gate,
            #[cfg(test)]
            control_sender_close_gate,
            out_tx.clone(),
        );
        self.install_reaper(&pc, binding.signaling.clone(), close);

        let local_sdp = match negotiate(&pc, sdp).await {
            Ok(local_sdp) => local_sdp,
            Err(e) => {
                self.close_if_same(
                    &binding.signaling.signal_id,
                    &binding.signaling.generation,
                    &pc,
                )
                .await;
                return Err(e);
            }
        };

        // Sign the negotiated answer when the offer was verified-signed, and
        // never emit a raw sibling SDP alongside it. A signing failure seals
        // the peer rather than downgrading to an unauthenticated answer.
        let (answer_sdp, answer_signed_envelope) = match &answer_signer {
            Some(sign) => match sign(&local_sdp) {
                Ok(wire) => (None, Some(wire)),
                Err(e) => {
                    self.close_if_same(
                        &binding.signaling.signal_id,
                        &binding.signaling.generation,
                        &pc,
                    )
                    .await;
                    return Err(e.context("signing session RTC answer"));
                }
            },
            None => (Some(local_sdp), None),
        };

        send_json(
            &out_tx,
            Outbound::RtcAnswer {
                session_id: binding.signaling.signal_id,
                binding_nonce: Some(binding.signaling.binding_nonce),
                scope_type: Some("session".to_string()),
                scope_id: Some(binding.signaling.session_id),
                protocol: Some(PTY_DATA_CHANNEL_LABEL.to_string()),
                protocol_version: Some(SESSION_RTC_PROTOCOL_VERSION),
                sdp: answer_sdp,
                signed_envelope: answer_signed_envelope,
            },
        )
        .await;
        Ok(())
    }

    pub async fn handle_host_offer(
        &self,
        signal: HostRtcSignal,
        sdp: String,
        ice_servers: Vec<RtcIceServerConfig>,
        ice_transport_policy: Option<String>,
        out_tx: mpsc::Sender<WsOutbound>,
        answer_signer: Option<RtcAnswerSigner>,
    ) {
        self.signaling.install(out_tx.clone());
        let trust_epoch = self.capture_trust_epoch();
        let Some(binding) = signal.binding() else {
            tracing::warn!(signal_id = %signal.signal_id, "rejecting invalid host rtc offer binding");
            return;
        };
        if *self.registered_host_id.lock().await != Some(binding.host_id) {
            tracing::warn!(signal_id = %signal.signal_id, "rejecting host rtc offer for another daemon");
            return;
        }
        if let Err(error) = self
            .create_host_answer(
                signal.signal_id.clone(),
                binding.clone(),
                sdp,
                ice_servers,
                ice_transport_policy,
                HostRtcAdmissionContext {
                    trust_epoch,
                    out_tx: out_tx.clone(),
                },
                answer_signer,
            )
            .await
        {
            tracing::warn!(signal_id = %signal.signal_id, class = "negotiation", "host rtc offer failed");
            tracing::debug!(signal_id = %signal.signal_id, %error, "host rtc offer failure detail");
            send_host_status(&out_tx, signal.signal_id, &binding, "failed").await;
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn create_host_answer(
        &self,
        signal_id: String,
        binding: HostRtcBinding,
        sdp: String,
        ice_servers: Vec<RtcIceServerConfig>,
        ice_transport_policy: Option<String>,
        admission: HostRtcAdmissionContext,
        answer_signer: Option<RtcAnswerSigner>,
    ) -> Result<()> {
        let admission_permit = self
            .peer_admission
            .try_acquire()
            .context("rtc session admission capacity exhausted")?;
        warn_if_no_udp_turn(&ice_servers);
        let api = self.api.get().context("WebRTC API was not initialized")?;
        let pc = Arc::new(
            api.new_peer_connection(RTCConfiguration {
                ice_servers: ice_servers.into_iter().map(to_webrtc_ice_server).collect(),
                ice_transport_policy: parse_ice_transport_policy(ice_transport_policy.as_deref())?,
                ..Default::default()
            })
            .await
            .context("creating host peer connection")?,
        );

        let _admission = self.admission.lock().await;
        if !self.trust_epoch_is_current(admission.trust_epoch) {
            let _ = pc.close().await;
            anyhow::bail!("credential trust changed during host RTC negotiation");
        }
        let admitted = {
            let mut hosts = self.host_peers.lock().await;
            if hosts.contains_key(&signal_id)
                || hosts.len() >= MAX_HOST_RTC_PEERS
                || self.peers.lock().await.contains_key(&signal_id)
            {
                false
            } else {
                hosts.insert(
                    signal_id.clone(),
                    HostRtcPeer {
                        pc: Arc::clone(&pc),
                        binding: binding.clone(),
                        _admission_permit: admission_permit,
                    },
                );
                true
            }
        };
        if !admitted {
            let _ = pc.close().await;
            anyhow::bail!("host rtc session admission rejected");
        }
        drop(_admission);

        install_host_ice_handler(
            &pc,
            signal_id.clone(),
            binding.clone(),
            self.signaling.clone(),
        );
        install_host_data_channel_handler(
            &pc,
            signal_id.clone(),
            binding.clone(),
            self.signaling.clone(),
            None,
        );
        self.install_host_reaper(&pc, signal_id.clone());

        let local_sdp = match negotiate(&pc, sdp).await {
            Ok(sdp) => sdp,
            Err(error) => {
                self.close_host_if_same(&signal_id, &pc).await;
                return Err(error);
            }
        };
        // Sign the negotiated host answer when the offer was verified-signed;
        // never emit a raw sibling SDP. A signing failure seals the peer.
        let (answer_sdp, answer_signed_envelope) = match &answer_signer {
            Some(sign) => match sign(&local_sdp) {
                Ok(wire) => (None, Some(wire)),
                Err(e) => {
                    self.close_host_if_same(&signal_id, &pc).await;
                    return Err(e.context("signing host RTC answer"));
                }
            },
            None => (Some(local_sdp), None),
        };
        send_json(
            &admission.out_tx,
            Outbound::RtcAnswer {
                session_id: signal_id,
                binding_nonce: Some(binding.binding_nonce),
                scope_type: Some("host".to_string()),
                scope_id: Some(binding.host_id),
                protocol: Some(binding.protocol),
                protocol_version: Some(binding.protocol_version),
                sdp: answer_sdp,
                signed_envelope: answer_signed_envelope,
            },
        )
        .await;
        Ok(())
    }

    fn install_host_reaper(&self, pc: &Arc<RTCPeerConnection>, signal_id: String) {
        let weak = Arc::downgrade(pc);
        {
            let sessions = self.clone();
            let signal_id = signal_id.clone();
            let weak = weak.clone();
            tokio::spawn(async move {
                tokio::time::sleep(RTC_CONNECT_TIMEOUT).await;
                let Some(pc) = weak.upgrade() else { return };
                if pc.connection_state() != RTCPeerConnectionState::Connected {
                    sessions.close_host_if_same(&signal_id, &pc).await;
                }
            });
        }
        let sessions = self.clone();
        pc.on_peer_connection_state_change(Box::new(move |state| {
            let sessions = sessions.clone();
            let signal_id = signal_id.clone();
            let weak = weak.clone();
            Box::pin(async move {
                if state == RTCPeerConnectionState::Connected {
                    if let Some(pc) = weak.upgrade() {
                        log_selected_candidate_pair(&pc, "host", &signal_id).await;
                    }
                }
                let delay = match state {
                    RTCPeerConnectionState::Failed => Some(Duration::ZERO),
                    RTCPeerConnectionState::Disconnected => Some(RTC_DISCONNECTED_GRACE),
                    _ => None,
                };
                let Some(delay) = delay else { return };
                let Some(pc) = weak.upgrade() else { return };
                tokio::spawn(async move {
                    tokio::time::sleep(delay).await;
                    if delay.is_zero()
                        || pc.connection_state() == RTCPeerConnectionState::Disconnected
                    {
                        sessions.close_host_if_same(&signal_id, &pc).await;
                    }
                });
            })
        }));
    }

    async fn close_host_if_same(&self, signal_id: &str, pc: &Arc<RTCPeerConnection>) {
        let removed = {
            let mut peers = self.host_peers.lock().await;
            if peers
                .get(signal_id)
                .is_some_and(|peer| Arc::ptr_eq(&peer.pc, pc))
            {
                peers.remove(signal_id)
            } else {
                None
            }
        };
        if let Some(peer) = removed {
            let _ = peer.pc.close().await;
        } else {
            let _ = pc.close().await;
        }
    }

    pub async fn handle_host_candidate(&self, signal: HostRtcSignal, candidate: Value) {
        let Some(binding) = signal.binding() else {
            return;
        };
        let Some(peer) = self.host_peers.lock().await.get(&signal.signal_id).cloned() else {
            return;
        };
        if peer.binding != binding {
            tracing::warn!(signal_id = %signal.signal_id, "ignoring stale host rtc candidate binding");
            return;
        }
        if let Ok(candidate) = serde_json::from_value::<RTCIceCandidateInit>(candidate) {
            let candidate = resolve_mdns_candidate(candidate).await;
            if let Err(error) = peer.pc.add_ice_candidate(candidate).await {
                tracing::debug!(signal_id = %signal.signal_id, %error, "adding host rtc candidate failed");
            }
        }
    }

    pub async fn close_host(&self, signal: HostRtcSignal) {
        let Some(binding) = signal.binding() else {
            return;
        };
        let peer = {
            let mut peers = self.host_peers.lock().await;
            if peers
                .get(&signal.signal_id)
                .is_some_and(|peer| peer.binding == binding)
            {
                peers.remove(&signal.signal_id)
            } else {
                None
            }
        };
        if let Some(peer) = peer {
            let _ = peer.pc.close().await;
        }
    }

    /// Self-defense against missed `rtc.close` signals: close the peer if it
    /// fails, stays disconnected past a grace period, or never connects at
    /// all. The handlers hold only weak references so they don't keep the
    /// peer connection (and its sockets) alive on their own.
    fn install_reaper(
        &self,
        pc: &Arc<RTCPeerConnection>,
        binding: RtcSignalBinding,
        close: Arc<PeerCloseCoordinator>,
    ) {
        let weak = Arc::downgrade(pc);

        {
            let sessions = self.clone();
            let binding = binding.clone();
            let weak = weak.clone();
            let close = Arc::clone(&close);
            tokio::spawn(async move {
                tokio::time::sleep(RTC_CONNECT_TIMEOUT).await;
                let Some(pc) = weak.upgrade() else { return };
                if pc.connection_state() != RTCPeerConnectionState::Connected {
                    tracing::debug!(
                        session_id = %binding.session_id,
                        signal_id = %binding.signal_id,
                        "rtc peer never connected; reaping"
                    );
                    let deadline = close.initiate();
                    sessions
                        .close_if_same_until(&binding.signal_id, &binding.generation, &pc, deadline)
                        .await;
                }
            });
        }

        let sessions = self.clone();
        pc.on_peer_connection_state_change(Box::new(move |state| {
            let sessions = sessions.clone();
            let binding = binding.clone();
            let weak = weak.clone();
            let close = Arc::clone(&close);
            let initiating_deadline =
                (state == RTCPeerConnectionState::Failed).then(|| close.initiate());
            Box::pin(async move {
                if state == RTCPeerConnectionState::Connected {
                    if let Some(pc) = weak.upgrade() {
                        log_selected_candidate_pair(&pc, "session", &binding.signal_id).await;
                    }
                }
                match state {
                    RTCPeerConnectionState::Failed => {
                        let Some(pc) = weak.upgrade() else { return };
                        let deadline = initiating_deadline.expect("failed state deadline");
                        // Close from a separate task: closing the peer from
                        // inside its own event handler can deadlock.
                        tokio::spawn(async move {
                            tracing::debug!(
                                session_id = %binding.session_id,
                                signal_id = %binding.signal_id,
                                "rtc peer failed; reaping"
                            );
                            sessions
                                .close_if_same_until(
                                    &binding.signal_id,
                                    &binding.generation,
                                    &pc,
                                    deadline,
                                )
                                .await;
                        });
                    }
                    RTCPeerConnectionState::Disconnected => {
                        let Some(pc) = weak.upgrade() else { return };
                        tokio::spawn(async move {
                            tokio::time::sleep(RTC_DISCONNECTED_GRACE).await;
                            if pc.connection_state() == RTCPeerConnectionState::Disconnected {
                                let deadline = close.initiate();
                                tracing::debug!(
                                    session_id = %binding.session_id,
                                    signal_id = %binding.signal_id,
                                    "rtc peer stayed disconnected; reaping"
                                );
                                sessions
                                    .close_if_same_until(
                                        &binding.signal_id,
                                        &binding.generation,
                                        &pc,
                                        deadline,
                                    )
                                    .await;
                            }
                        });
                    }
                    _ => {}
                }
            })
        }));
    }

    /// Close `pc`, removing its map entry only if the entry still refers to
    /// this same instance (a newer offer may have replaced it).
    fn schedule_close_if_same(
        &self,
        signal_id: &str,
        generation: &str,
        pc: &Arc<RTCPeerConnection>,
        close: &Arc<PeerCloseCoordinator>,
    ) {
        let upload_deadline = close.initiate();
        let sessions = self.clone();
        let signal_id = signal_id.to_string();
        let generation = generation.to_string();
        let pc = Arc::clone(pc);
        tokio::spawn(async move {
            sessions
                .close_if_same_until(&signal_id, &generation, &pc, upload_deadline)
                .await;
        });
    }

    async fn close_if_same(&self, signal_id: &str, generation: &str, pc: &Arc<RTCPeerConnection>) {
        let active_deadline = {
            let peers = self.peers.lock().await;
            peers
                .get(signal_id)
                .filter(|current| current.generation == generation && Arc::ptr_eq(&current.pc, pc))
                .map(|peer| peer.close.initiate())
        };
        let deadline = if active_deadline.is_some() {
            active_deadline
        } else {
            let closing = self.closing_peers.lock().await;
            closing
                .get(&(signal_id.to_string(), generation.to_string()))
                .filter(|current| Arc::ptr_eq(&current.pc, pc))
                .map(|peer| peer.close.initiate())
        };
        if let Some(deadline) = deadline {
            self.close_if_same_until(signal_id, generation, pc, deadline)
                .await;
        } else {
            let _ = pc.close().await;
        }
    }

    async fn close_if_same_until(
        &self,
        signal_id: &str,
        generation: &str,
        pc: &Arc<RTCPeerConnection>,
        upload_deadline: tokio::time::Instant,
    ) {
        let active_session = {
            let peers = self.peers.lock().await;
            peers
                .get(signal_id)
                .filter(|current| current.generation == generation && Arc::ptr_eq(&current.pc, pc))
                .map(|peer| peer.session)
        };
        let closing_peer = if active_session.is_none() {
            self.closing_peers
                .lock()
                .await
                .get(&(signal_id.to_string(), generation.to_string()))
                .filter(|current| Arc::ptr_eq(&current.pc, pc))
                .cloned()
        } else {
            None
        };
        let Some(session) =
            active_session.or_else(|| closing_peer.as_ref().map(|peer| peer.session))
        else {
            let _ = tokio::time::timeout_at(upload_deadline, pc.close()).await;
            return;
        };
        if let Some(peer) = closing_peer {
            debug_assert_eq!(peer.close.initiate(), upload_deadline);
            self.uploads
                .cancel_viewer_now(peer.session, &viewer_id(signal_id, &peer.generation));
            let _ = tokio::time::timeout_at(upload_deadline, pc.close()).await;
            return;
        }
        let closer = self.session_closer(session).await;
        let _closing = closer.lock().await;
        let peer = {
            let peers = self.peers.lock().await;
            peers
                .get(signal_id)
                .filter(|current| current.generation == generation && Arc::ptr_eq(&current.pc, pc))
                .cloned()
        };
        if let Some(peer) = peer {
            self.deactivate_peer_until(signal_id, peer, upload_deadline)
                .await;
            let mut peers = self.peers.lock().await;
            if peers.get(signal_id).is_some_and(|current| {
                current.generation == generation && Arc::ptr_eq(&current.pc, pc)
            }) {
                peers.remove(signal_id);
            }
            return;
        }
        let _ = tokio::time::timeout_at(upload_deadline, pc.close()).await;
    }

    #[allow(clippy::too_many_arguments)]
    async fn send_session_peer_status(
        &self,
        out_tx: &mpsc::Sender<WsOutbound>,
        signal_id: &str,
        generation: &str,
        pc: &Arc<RTCPeerConnection>,
        active: &Arc<AtomicBool>,
        channels: &Arc<RequiredSessionChannels>,
        binding_nonce: &str,
        session_id: Uuid,
        status: &str,
        message: Option<&str>,
    ) -> bool {
        let (current, close) = {
            let peers = self.peers.lock().await;
            let current = peers.get(signal_id).filter(|current| {
                current.generation == generation
                    && Arc::ptr_eq(&current.pc, pc)
                    && current.session.session_id() == session_id
            });
            (
                current.is_some(),
                current.map(|peer| Arc::clone(&peer.close)),
            )
        };
        if !current {
            channels.stop();
            active.store(false, Ordering::Release);
            if let Some(close) = close {
                self.schedule_close_if_same(signal_id, generation, pc, &close);
            } else {
                let _ = pc.close().await;
            }
            return false;
        }
        let _ = out_tx;
        self.send_or_defer_status(session_status_frame(
            signal_id,
            binding_nonce,
            session_id,
            status,
            message,
        ))
        .await
    }

    pub async fn handle_candidate(
        &self,
        signal_id: String,
        generation: String,
        session_id: Uuid,
        candidate: serde_json::Value,
    ) {
        let Some(peer) = self.peers.lock().await.get(&signal_id).cloned() else {
            tracing::debug!(%signal_id, "ignoring rtc candidate for unknown session");
            return;
        };
        if peer.session.session_id() != session_id || peer.generation != generation {
            tracing::warn!(%signal_id, %session_id, "ignoring rtc candidate with stale binding");
            return;
        }
        let pc = peer.pc;
        match serde_json::from_value::<RTCIceCandidateInit>(candidate) {
            Ok(candidate) => {
                let candidate = resolve_mdns_candidate(candidate).await;
                if let Err(e) = pc.add_ice_candidate(candidate).await {
                    tracing::debug!(%signal_id, error = %e, "adding rtc candidate failed");
                }
            }
            Err(e) => {
                tracing::debug!(%signal_id, error = %e, "decoding rtc candidate failed");
            }
        }
    }

    pub async fn close(&self, signal_id: &str, generation: &str, session_id: Uuid) {
        let active = {
            let peers = self.peers.lock().await;
            peers
                .get(signal_id)
                .filter(|peer| {
                    peer.session.session_id() == session_id && peer.generation == generation
                })
                .cloned()
        };
        let closing = if active.is_none() {
            self.closing_peers
                .lock()
                .await
                .get(&(signal_id.to_string(), generation.to_string()))
                .filter(|peer| peer.session.session_id() == session_id)
                .cloned()
        } else {
            None
        };
        let Some(initial) = active.or_else(|| closing.clone()) else {
            return;
        };
        let session = initial.session;
        let upload_deadline = initial.close.initiate();
        if let Some(peer) = closing {
            self.uploads
                .cancel_viewer_now(peer.session, &viewer_id(signal_id, &peer.generation));
            let _ = tokio::time::timeout_at(upload_deadline, peer.pc.close()).await;
            return;
        }
        let closer = self.session_closer(session).await;
        let _closing = closer.lock().await;
        let peer = {
            let peers = self.peers.lock().await;
            peers
                .get(signal_id)
                .filter(|peer| {
                    peer.session.session_id() == session_id && peer.generation == generation
                })
                .cloned()
        };
        if let Some(peer) = peer {
            self.deactivate_peer_until(signal_id, peer, upload_deadline)
                .await;
            let mut peers = self.peers.lock().await;
            if peers.get(signal_id).is_some_and(|peer| {
                peer.session.session_id() == session_id && peer.generation == generation
            }) {
                peers.remove(signal_id);
            }
        }
    }

    /// Close peers attached to one concrete backend generation. A replacement
    /// using the same UUID is deliberately not matched.
    pub async fn close_for_session(&self, session_id: Uuid, generation: u64) {
        let session = SessionBinding::new(session_id, generation);
        let closing = {
            let peers = self.peers.lock().await;
            peers
                .iter()
                .filter(|(_, peer)| peer.session == session)
                .map(|(signal_id, peer)| {
                    let deadline = peer.close.initiate();
                    (signal_id.clone(), peer.clone(), deadline)
                })
                .collect::<Vec<_>>()
        };
        let retained_cleanup_deadline = {
            let closing_peers = self.closing_peers.lock().await;
            closing_peers
                .values()
                .filter(|peer| peer.session == session)
                .map(|peer| peer.close.initiate())
                .min()
        };
        let upload_deadline = closing
            .iter()
            .map(|(_, _, deadline)| *deadline)
            .chain(retained_cleanup_deadline)
            .min()
            .unwrap_or_else(upload_teardown_deadline);
        // Publish cancellation before transport/fence draining. Every later
        // upload cleanup wait for this generation shares this one deadline.
        self.uploads.remove_generation_now(session);
        let closer = self.session_closer(session).await;
        let _closing = closer.lock().await;
        for (signal_id, peer, peer_deadline) in closing {
            let pc = Arc::clone(&peer.pc);
            self.deactivate_peer_until(&signal_id, peer, peer_deadline)
                .await;
            let mut peers = self.peers.lock().await;
            if peers
                .get(&signal_id)
                .is_some_and(|current| current.session == session && Arc::ptr_eq(&current.pc, &pc))
            {
                peers.remove(&signal_id);
            }
        }
        // An old exit task can race a replacement using the same UUID. Keep
        // the peer map locked while deciding and clearing backend-wide hub
        // state so a new generation either prevents cleanup or registers only
        // after cleanup has completed.
        let peers = self.peers.lock().await;
        if !peers
            .values()
            .any(|peer| peer.session.session_id() == session_id)
        {
            self.controls.remove_session(session_id).await;
        }
        drop(peers);
        self.uploads
            .remove_generation_until(session, upload_deadline)
            .await;
    }

    async fn deactivate_peer_until(
        &self,
        signal_id: &str,
        peer: RtcPeer,
        upload_deadline: tokio::time::Instant,
    ) {
        peer.channels.stop();
        peer.active.store(false, Ordering::Release);
        let upload_viewer_id = viewer_id(signal_id, &peer.generation);
        self.uploads
            .cancel_viewer_now(peer.session, &upload_viewer_id);
        // Publish removal from the viewer/control registries immediately as
        // well. The fenced late-cleanup task repeats both operations after all
        // already-admitted callbacks drain, closing the narrow race where an
        // on-open callback passed its final active check just before teardown.
        let _ = tokio::time::timeout_at(upload_deadline, async {
            peer.control.remove_direct_sink(&upload_viewer_id).await;
            self.controls.unregister_viewer(&upload_viewer_id).await;
        })
        .await;
        // Closing transports wakes bounded WebRTC sends and control replies.
        // Own the complete late-cleanup sequence in the session registry, but
        // wait for it only until the one deadline created by the initiating
        // close event. A slow transport/fence cannot grant a second upload
        // cleanup window or keep the peer map resident; the tracked task still
        // removes generation-scoped sinks when it eventually unblocks.
        let (done_tx, done_rx) = oneshot::channel();
        let controls = self.controls.clone();
        let uploads = self.uploads.clone();
        self.closing_peers.lock().await.insert(
            (signal_id.to_string(), peer.generation.clone()),
            peer.clone(),
        );
        let closing_peers = Arc::clone(&self.closing_peers);
        let closing_key = (signal_id.to_string(), peer.generation.clone());
        {
            let mut tasks = self.peer_cleanup_tasks.lock().await;
            while tasks.try_join_next().is_some() {}
            tasks.spawn(async move {
                let pc = Arc::clone(&peer.pc);
                let closing_pc = Arc::clone(&pc);
                let closing_generation = peer.generation.clone();
                let cleanup = async move {
                    let _lifecycle = peer.channels.fail().await;
                    let _drained = peer.fence.write().await;
                    peer.control.remove_direct_sink(&upload_viewer_id).await;
                    controls.unregister_viewer(&upload_viewer_id).await;
                    uploads
                        .cancel_viewer_and_wait(peer.session, &upload_viewer_id)
                        .await;
                };
                let (_closed, ()) = tokio::join!(pc.close(), cleanup);
                let mut closing = closing_peers.lock().await;
                if closing.get(&closing_key).is_some_and(|current| {
                    current.generation == closing_generation
                        && Arc::ptr_eq(&current.pc, &closing_pc)
                }) {
                    closing.remove(&closing_key);
                }
                let _ = done_tx.send(());
            });
        }
        let _ = tokio::time::timeout_at(upload_deadline, done_rx).await;
    }

    #[cfg(test)]
    async fn peer_cleanup_task_count(&self) -> usize {
        let mut tasks = self.peer_cleanup_tasks.lock().await;
        while tasks.try_join_next().is_some() {}
        tasks.len()
    }

    async fn session_closer(&self, session: SessionBinding) -> Arc<Mutex<()>> {
        let key = (session.session_id(), session.generation());
        let mut closers = self.session_closers.lock().await;
        closers.retain(|_, closer| closer.strong_count() > 0);
        if let Some(closer) = closers.get(&key).and_then(Weak::upgrade) {
            closer
        } else {
            let closer = Arc::new(Mutex::new(()));
            closers.insert(key, Arc::downgrade(&closer));
            closer
        }
    }

    pub async fn close_all(&self) {
        #[cfg(test)]
        if let Some(gate) = self.slow_close_all_gate.lock().await.take() {
            gate.entered.notify_one();
            gate.release.notified().await;
        }
        let peers = self.peers.lock().await.clone();
        for peer in peers.values() {
            peer.close.initiate();
        }
        let retained_cleanup = self
            .closing_peers
            .lock()
            .await
            .iter()
            .map(|((signal_id, _), peer)| (signal_id.clone(), peer.clone()))
            .collect::<Vec<_>>();
        for (signal_id, peer) in retained_cleanup {
            let _ = peer.close.initiate();
            self.uploads
                .cancel_viewer_now(peer.session, &viewer_id(&signal_id, &peer.generation));
        }
        #[cfg(test)]
        for signal_id in peers.keys() {
            self.pause_effect(signal_id, TestEffectPoint::CloseAllSnapshot)
                .await;
        }
        for (signal_id, peer) in peers {
            let closer = self.session_closer(peer.session).await;
            let _closing = closer.lock().await;
            let current = {
                let peers = self.peers.lock().await;
                peers
                    .get(&signal_id)
                    .filter(|current| {
                        current.generation == peer.generation
                            && current.session == peer.session
                            && Arc::ptr_eq(&current.pc, &peer.pc)
                    })
                    .cloned()
            };
            let Some(current) = current else { continue };
            let pc = Arc::clone(&current.pc);
            let generation = current.generation.clone();
            let upload_deadline = current.close.initiate();
            self.deactivate_peer_until(&signal_id, current, upload_deadline)
                .await;
            let mut peers = self.peers.lock().await;
            if peers.get(&signal_id).is_some_and(|current| {
                current.generation == generation && Arc::ptr_eq(&current.pc, &pc)
            }) {
                peers.remove(&signal_id);
            }
        }
        let host_peers = std::mem::take(&mut *self.host_peers.lock().await);
        for (_, peer) in host_peers {
            let _ = peer.pc.close().await;
        }
    }

    /// Linearize credential invalidation against both session and host RTC
    /// insertion. Once this returns, every peer admitted under the prior
    /// whole-record credential revision is closed, and any offer that began
    /// before the revision change will fail its epoch check at admission.
    pub async fn invalidate_trust_and_close_all(&self) {
        let _admission = self.admission.lock().await;
        self.trust_epoch.fetch_add(1, Ordering::SeqCst);

        // Publish fail-closed state to every session callback before awaiting
        // any transport/fence cleanup. `close_all` has intentionally careful
        // bounded per-peer teardown, but a slow first peer must not leave a
        // later stale peer authorized after credential revocation.
        let peers = self.peers.lock().await.clone();
        for (signal_id, peer) in &peers {
            peer.channels.stop();
            peer.active.store(false, Ordering::Release);
            let _ = peer.close.initiate();
            self.uploads
                .cancel_viewer_now(peer.session, &viewer_id(signal_id, &peer.generation));
        }

        // Remove host peers from admission immediately as well. Close their
        // transports alongside the more involved session cleanup so neither
        // class delays fail-closed publication for the other.
        let host_peers = std::mem::take(&mut *self.host_peers.lock().await);
        let close_hosts = async move {
            for (_, peer) in host_peers {
                let _ = peer.pc.close().await;
            }
        };
        let (_, ()) = tokio::join!(self.close_all(), close_hosts);
    }

    #[cfg(test)]
    pub(crate) async fn resident_session_count(&self) -> usize {
        self.peers.lock().await.len() + self.host_peers.lock().await.len()
    }

    #[cfg(test)]
    pub(crate) fn trust_epoch_for_test(&self) -> u64 {
        self.trust_epoch.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    async fn stall_first_pty_send(&self, signal_id: &str) -> Arc<tokio::sync::Notify> {
        let gate = Arc::new(tokio::sync::Notify::new());
        self.pty_send_gates
            .lock()
            .await
            .insert(signal_id.to_string(), Arc::clone(&gate));
        gate
    }
}

async fn negotiate(pc: &Arc<RTCPeerConnection>, sdp: String) -> Result<String> {
    let offer = RTCSessionDescription::offer(sdp).context("decoding offer sdp")?;
    pc.set_remote_description(offer)
        .await
        .context("setting remote offer")?;
    let answer = pc.create_answer(None).await.context("creating answer")?;
    pc.set_local_description(answer)
        .await
        .context("setting local answer")?;
    let local = pc
        .local_description()
        .await
        .context("local answer missing")?;
    Ok(local.sdp)
}

fn ice_ufrag(sdp: &str) -> Option<String> {
    sdp.lines()
        .find_map(|line| line.strip_prefix("a=ice-ufrag:"))
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .map(str::to_string)
}

fn restart_ufrag_is_fresh(seen: &HashSet<String>, candidate: &str) -> bool {
    !seen.contains(candidate)
}

fn restart_offer_is_acceptable(
    restart_requested: bool,
    same_generation: bool,
    same_session: bool,
    pinned_key: Option<[u8; 32]>,
    offered_key: Option<[u8; 32]>,
    fresh_ufrag: bool,
) -> bool {
    restart_requested
        && same_generation
        && same_session
        && offered_key.is_some()
        && offered_key == pinned_key
        && fresh_ufrag
}

fn sign_answer(
    local_sdp: &str,
    answer_signer: &Option<RtcAnswerSigner>,
) -> Result<(Option<String>, Option<String>)> {
    match answer_signer {
        Some(sign) => Ok((None, Some(sign(local_sdp)?))),
        None => Ok((Some(local_sdp.to_string()), None)),
    }
}

async fn configure_data_channel_pacing(dc: &Arc<RTCDataChannel>) -> Arc<Notify> {
    let buffered_low = Arc::new(Notify::new());
    dc.set_buffered_amount_low_threshold(DATA_CHANNEL_BUFFER_LOW)
        .await;
    let notify = Arc::clone(&buffered_low);
    dc.on_buffered_amount_low(Box::new(move || {
        notify.notify_waiters();
        Box::pin(async {})
    }))
    .await;
    buffered_low
}

async fn wait_for_data_channel_capacity(
    dc: &Arc<RTCDataChannel>,
    buffered_low: &Arc<Notify>,
) -> bool {
    let ready_dc = Arc::clone(dc);
    let amount_dc = Arc::clone(dc);
    let wait_notify = Arc::clone(buffered_low);
    wait_for_pacing_capacity(
        move || ready_dc.ready_state() == RTCDataChannelState::Open,
        move || {
            let dc = Arc::clone(&amount_dc);
            async move { dc.buffered_amount().await }
        },
        move || {
            let notify = Arc::clone(&wait_notify);
            async move {
                tokio::select! {
                    _ = notify.notified() => {}
                    _ = tokio::time::sleep(Duration::from_secs(1)) => {}
                }
            }
        },
    )
    .await
}

async fn wait_for_pacing_capacity<Ready, Amount, AmountFuture, Wait, WaitFuture>(
    mut is_open: Ready,
    mut buffered_amount: Amount,
    mut wait_for_low: Wait,
) -> bool
where
    Ready: FnMut() -> bool,
    Amount: FnMut() -> AmountFuture,
    AmountFuture: Future<Output = usize>,
    Wait: FnMut() -> WaitFuture,
    WaitFuture: Future<Output = ()>,
{
    loop {
        if !is_open() {
            return false;
        }
        if buffered_amount().await < DATA_CHANNEL_BUFFER_HIGH {
            return true;
        }
        wait_for_low().await;
    }
}

async fn log_selected_candidate_pair(
    pc: &Arc<RTCPeerConnection>,
    scope: &'static str,
    signal_id: &str,
) {
    let Some(pair) = pc
        .sctp()
        .transport()
        .ice_transport()
        .get_selected_candidate_pair()
        .await
    else {
        return;
    };
    tracing::info!(
        scope,
        signal_id,
        local_type = %pair.local.typ,
        local_protocol = %pair.local.protocol,
        remote_type = %pair.remote.typ,
        remote_protocol = %pair.remote.protocol,
        "selected RTC ICE candidate pair"
    );
}

fn install_ice_handler(
    pc: &Arc<RTCPeerConnection>,
    binding: RtcSignalBinding,
    signaling: RtcWsSender,
) {
    pc.on_ice_candidate(Box::new(move |candidate| {
        let signaling = signaling.clone();
        let binding = binding.clone();
        Box::pin(async move {
            let candidate = match candidate {
                Some(candidate) => match candidate.to_json() {
                    Ok(candidate) => candidate,
                    Err(e) => {
                        tracing::debug!(session_id = %binding.session_id, error = %e, "encoding rtc candidate failed");
                        return;
                    }
                },
                None => RTCIceCandidateInit {
                    candidate: String::new(),
                    ..Default::default()
                },
            };
            match serde_json::to_value(candidate) {
                Ok(candidate) => {
                    send_json_dynamic(
                        &signaling,
                        Outbound::RtcCandidate {
                            session_id: binding.signal_id,
                            binding_nonce: Some(binding.binding_nonce),
                            scope_type: Some("session".to_string()),
                            scope_id: Some(binding.session_id),
                            protocol: Some(PTY_DATA_CHANNEL_LABEL.to_string()),
                            protocol_version: Some(SESSION_RTC_PROTOCOL_VERSION),
                            candidate,
                        },
                    )
                    .await;
                }
                Err(e) => {
                    tracing::debug!(session_id = %binding.session_id, error = %e, "serializing rtc candidate failed");
                }
            }
        })
    }));
}

#[allow(clippy::too_many_arguments)]
fn install_data_channel_handler(
    pc: &Arc<RTCPeerConnection>,
    sessions: RtcSessions,
    binding: BoundRtcSession,
    registry: SessionRegistry,
    controls: SessionControlHub,
    guard: RtcCallbackGuard,
    channels: Arc<RequiredSessionChannels>,
    close: Arc<PeerCloseCoordinator>,
    #[cfg(test)] pty_send_gate: Option<Arc<tokio::sync::Notify>>,
    #[cfg(test)] pty_sender_close_gate: Option<Arc<TestSenderCloseGate>>,
    #[cfg(test)] control_sender_close_gate: Option<Arc<TestSenderCloseGate>>,
    out_tx: mpsc::Sender<WsOutbound>,
) {
    {
        let active = Arc::clone(&guard.active);
        let channels = Arc::clone(&channels);
        let close = Arc::clone(&close);
        let pc = Arc::clone(pc);
        let sessions = sessions.clone();
        let out_tx = out_tx.clone();
        let signal_id = binding.signaling.signal_id.clone();
        let generation = binding.signaling.generation.clone();
        let binding_nonce = binding.signaling.binding_nonce.clone();
        let session_id = binding.signaling.session_id;
        tokio::spawn(async move {
            if !matches!(
                tokio::time::timeout(REQUIRED_SESSION_CHANNEL_TIMEOUT, channels.wait_ready()).await,
                Ok(true)
            ) {
                channels.fail().await;
                let _ = sessions
                    .send_session_peer_status(
                        &out_tx,
                        &signal_id,
                        &generation,
                        &pc,
                        &active,
                        &channels,
                        &binding_nonce,
                        session_id,
                        "failed",
                        Some("spawn.pty and spawn.ctl are both required"),
                    )
                    .await;
                let deadline = close.initiate();
                sessions
                    .close_if_same_until(&signal_id, &generation, &pc, deadline)
                    .await;
            }
        });
    }
    // Handlers a peer owns must never own the peer back. A strong handle in a
    // closure the peer stores is a reference cycle `close()` does not break:
    // the peer is never dropped, and a peer that is never dropped never gives
    // its ICE sockets back — 101 pinned ports, lost one browser reconnect at
    // a time, until every new session can only reach the TURN relay.
    let handler_pc = Arc::downgrade(pc);
    pc.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
        let Some(pc) = handler_pc.upgrade() else {
            return Box::pin(async {});
        };
        let binding = binding.clone();
        let registry = registry.clone();
        let controls = controls.clone();
        let active = Arc::clone(&guard.active);
        let fence = Arc::clone(&guard.fence);
        #[cfg(test)]
        let pty_send_gate = pty_send_gate.clone();
        #[cfg(test)]
        let pty_sender_close_gate = pty_sender_close_gate.clone();
        #[cfg(test)]
        let control_sender_close_gate = control_sender_close_gate.clone();
        let out_tx = out_tx.clone();
        let channels = Arc::clone(&channels);
        let close = Arc::clone(&close);
        let sessions = sessions.clone();
        let reliable = dc.ordered()
            && dc.max_packet_lifetime().is_none()
            && dc.max_retransmits().is_none();
        let known_label = matches!(dc.label(), CONTROL_DATA_CHANNEL_LABEL | PTY_DATA_CHANNEL_LABEL);
        if !reliable || !known_label {
            let _ = close.initiate();
        }
        Box::pin(async move {
            let viewer_id = viewer_id(
                &binding.signaling.signal_id,
                &binding.signaling.generation,
            );
            if !reliable {
                tracing::warn!(session_id = %binding.signaling.session_id, label = %dc.label(), "rejecting unreliable rtc data channel");
                channels.fail().await;
                sessions.schedule_close_if_same(
                    &binding.signaling.signal_id,
                    &binding.signaling.generation,
                    &pc,
                    &close,
                );
                return;
            }
            if dc.label() == CONTROL_DATA_CHANNEL_LABEL {
                if !channels.register(SessionChannel::Control).await {
                    sessions.schedule_close_if_same(
                        &binding.signaling.signal_id,
                        &binding.signaling.generation,
                        &pc,
                        &close,
                    );
                    return;
                }
                install_control_data_channel(
                    dc,
                    viewer_id,
                    binding.signaling.signal_id.clone(),
                    binding.session,
                    registry,
                    controls,
                    active,
                    fence,
                    channels,
                    pc,
                    sessions,
                    Arc::clone(&close),
                    binding.signaling.generation.clone(),
                    #[cfg(test)]
                    control_sender_close_gate,
                );
                return;
            }
            if dc.label() != PTY_DATA_CHANNEL_LABEL {
                tracing::warn!(session_id = %binding.signaling.session_id, label = %dc.label(), "rejecting unknown rtc data channel");
                channels.fail().await;
                sessions.schedule_close_if_same(
                    &binding.signaling.signal_id,
                    &binding.signaling.generation,
                    &pc,
                    &close,
                );
                return;
            }
            if !channels.register(SessionChannel::Pty).await {
                sessions.schedule_close_if_same(
                    &binding.signaling.signal_id,
                    &binding.signaling.generation,
                    &pc,
                    &close,
                );
                return;
            }

            let session = binding.session;
            let session_id = session.session_id();

            let input_registry = registry.clone();
            let input_out_tx = out_tx.clone();
            let input_active = Arc::clone(&active);
            let input_fence = Arc::clone(&fence);
            let input_channels = Arc::clone(&channels);
            #[cfg(test)]
            let input_sessions = sessions.clone();
            #[cfg(test)]
            let input_session_id = binding.signaling.signal_id.clone();
            dc.on_message(Box::new(move |msg: DataChannelMessage| {
                let registry = input_registry.clone();
                let out_tx = input_out_tx.clone();
                let active = Arc::clone(&input_active);
                let fence = Arc::clone(&input_fence);
                let channels = Arc::clone(&input_channels);
                #[cfg(test)]
                let sessions = input_sessions.clone();
                #[cfg(test)]
                let signal_id = input_session_id.clone();
                Box::pin(async move {
                    let Some(effect) = channels.permit().await else {
                        return;
                    };
                    let _callback = fence.read().await;
                    #[cfg(test)]
                    sessions
                        .pause_effect(&signal_id, TestEffectPoint::PtyInput)
                        .await;
                    if !effect.valid()
                        || !active.load(Ordering::Acquire)
                        || !registry.is_current(session)
                    {
                        return;
                    }
                    let result = forward_bound_data_channel_input(
                        session,
                        msg.is_string,
                        &msg.data,
                        &registry,
                        &out_tx,
                    );
                    if result.is_none() {
                        tracing::debug!(%session_id, "ignoring rtc stdin for unknown session");
                    } else if let Some(Err(e)) = result {
                        tracing::warn!(%session_id, error = %e, "rtc PTY stdin write failed");
                    }
                })
            }));

            let open_registry = registry.clone();
            let open_binding_nonce = binding.signaling.binding_nonce.clone();
            let open_viewer_id = viewer_id.clone();
            let open_out_tx = out_tx.clone();
            let open_dc = Arc::clone(&dc);
            let open_active = Arc::clone(&active);
            let open_fence = Arc::clone(&fence);
            let open_control = binding.control.clone();
            let open_channels = Arc::clone(&channels);
            let open_pc = Arc::downgrade(&pc);
            let open_sessions = sessions.clone();
            let open_close = Arc::clone(&close);
            let open_signal_id = binding.signaling.signal_id.clone();
            let open_generation = binding.signaling.generation.clone();
            dc.on_open(Box::new(move || {
                let registry = open_registry.clone();
                let binding_nonce = open_binding_nonce.clone();
                let viewer_id = open_viewer_id.clone();
                let out_tx = open_out_tx.clone();
                let dc = Arc::clone(&open_dc);
                let active = Arc::clone(&open_active);
                let fence = Arc::clone(&open_fence);
                let control = open_control.clone();
                let channels = Arc::clone(&open_channels);
                let pc = open_pc.clone();
                let sessions = open_sessions.clone();
                let close = Arc::clone(&open_close);
                let signal_id = open_signal_id.clone();
                let generation = open_generation.clone();
                Box::pin(async move {
                    let Some(pc) = pc.upgrade() else { return };
                    if !active.load(Ordering::Acquire) || !registry.is_current(session) {
                        let _ = dc.close().await;
                        return;
                    }
                    channels.mark_open(SessionChannel::Pty).await;
                    if !channels.wait_ready().await {
                        sessions.schedule_close_if_same(
                            &signal_id,
                            &generation,
                            &pc,
                            &close,
                        );
                        return;
                    }
                    let Some(effect) = channels.permit().await else {
                        sessions.schedule_close_if_same(
                            &signal_id,
                            &generation,
                            &pc,
                            &close,
                        );
                        return;
                    };
                    let _callback = fence.read().await;
                    if !effect.valid()
                        || !active.load(Ordering::Acquire)
                        || !registry.is_current(session)
                    {
                        return;
                    }
                    let mut replay_rx = None;
                    registry.with_bound_handle(session, |handle| {
                        replay_rx = handle.replay(64 * 1024);
                    });
                    let Some(replay_rx) = replay_rx else {
                        let _ = sessions
                            .send_session_peer_status(
                                &out_tx,
                                &signal_id,
                                &generation,
                                &pc,
                                &active,
                                &channels,
                                &binding_nonce,
                                session_id,
                                "failed",
                                Some("worker replay is unavailable"),
                            )
                            .await;
                        channels.stop();
                        active.store(false, Ordering::Release);
                        sessions.schedule_close_if_same(
                            &signal_id,
                            &generation,
                            &pc,
                            &close,
                        );
                        return;
                    };
                    let Ok(Ok(Ok(replay))) =
                        tokio::time::timeout(Duration::from_secs(10), replay_rx).await
                    else {
                        let _ = sessions
                            .send_session_peer_status(
                                &out_tx,
                                &signal_id,
                                &generation,
                                &pc,
                                &active,
                                &channels,
                                &binding_nonce,
                                session_id,
                                "failed",
                                Some("worker replay barrier failed"),
                            )
                            .await;
                        channels.stop();
                        active.store(false, Ordering::Release);
                        sessions.schedule_close_if_same(
                            &signal_id,
                            &generation,
                            &pc,
                            &close,
                        );
                        return;
                    };
                    let watermark = replay.watermark();
                    if !effect.valid()
                        || !active.load(Ordering::Acquire)
                        || !registry.is_current(session)
                    {
                        let _ = dc.close().await;
                        return;
                    }
                    if tokio::time::timeout(
                        Duration::from_secs(10),
                        control.wait_source_offset(watermark),
                    )
                    .await
                    .is_err()
                    {
                        let _ = sessions
                            .send_session_peer_status(
                                &out_tx,
                                &signal_id,
                                &generation,
                                &pc,
                                &active,
                                &channels,
                                &binding_nonce,
                                session_id,
                                "failed",
                                Some("worker live-stream barrier timed out"),
                            )
                            .await;
                        channels.stop();
                        active.store(false, Ordering::Release);
                        sessions.schedule_close_if_same(
                            &signal_id,
                            &generation,
                            &pc,
                            &close,
                        );
                        return;
                    }
                    if !effect.valid()
                        || !active.load(Ordering::Acquire)
                        || !registry.is_current(session)
                    {
                        let _ = dc.close().await;
                        return;
                    }

                    #[cfg(test)]
                    sessions
                        .pause_effect(&signal_id, TestEffectPoint::PtySink)
                        .await;
                    if !effect.valid()
                        || !active.load(Ordering::Acquire)
                        || !registry.is_current(session)
                    {
                        return;
                    }
                    let mut direct = control.add_direct_sink(viewer_id.clone()).await;
                    if !effect.valid()
                        || !active.load(Ordering::Acquire)
                        || !registry.is_current(session)
                    {
                        control.remove_direct_sink(&viewer_id).await;
                        let _ = dc.close().await;
                        return;
                    }
                    if !sessions
                        .send_session_peer_status(
                            &out_tx,
                            &signal_id,
                            &generation,
                            &pc,
                            &active,
                            &channels,
                            &binding_nonce,
                            session_id,
                            "connected",
                            None,
                        )
                        .await
                    {
                        return;
                    }
                    if !effect.valid()
                        || !active.load(Ordering::Acquire)
                        || !registry.is_current(session)
                    {
                        control.remove_direct_sink(&viewer_id).await;
                        let _ = dc.close().await;
                        return;
                    }
                    let output_registry = registry.clone();
                    let output_active = Arc::clone(&active);
                    let output_fence = Arc::clone(&fence);
                    let output_channels = Arc::clone(&channels);
                    let output_sessions = sessions.clone();
                    let output_close = Arc::clone(&close);
                    let output_pc = Arc::clone(&pc);
                    let output_signal_id = signal_id.clone();
                    let output_generation = generation.clone();
                    let output_control = control.clone();
                    let output_viewer_id = viewer_id.clone();
                    drop(_callback);
                    drop(effect);
                    tokio::spawn(async move {
                        let buffered_low = configure_data_channel_pacing(&dc).await;
                        #[cfg(test)]
                        let mut pty_send_gate = pty_send_gate;
                        #[cfg(test)]
                        let sender_exit = wait_test_sender_exit(&pty_sender_close_gate);
                        #[cfg(not(test))]
                        let sender_exit = std::future::pending::<()>();
                        tokio::pin!(sender_exit);
                        loop {
                            let chunk = tokio::select! {
                                changed = direct.disconnected.changed() => {
                                    if changed.is_ok()
                                        && direct.gap_offset.load(Ordering::Acquire) > 0
                                        && output_active.load(Ordering::Acquire)
                                        && rtc_output_allowed(&output_registry, session)
                                    {
                                        let gap_offset = direct.gap_offset.load(Ordering::Acquire);
                                        if let Some(sender) = output_channels.control_sender() {
                                            let _ = session_ctl::send_pty_gap(&sender, gap_offset).await;
                                        }
                                        let origin = direct.source_origin;
                                        direct = output_control
                                            .add_direct_sink_from(output_viewer_id.clone(), origin)
                                            .await;
                                        continue;
                                    }
                                    None
                                }
                                chunk = direct.receiver.recv() => chunk,
                                _ = &mut sender_exit => None,
                            };
                            if chunk.is_none()
                                && direct.gap_offset.load(Ordering::Acquire) > 0
                                && output_active.load(Ordering::Acquire)
                                && rtc_output_allowed(&output_registry, session)
                            {
                                let gap_offset = direct.gap_offset.load(Ordering::Acquire);
                                if let Some(sender) = output_channels.control_sender() {
                                    let _ = session_ctl::send_pty_gap(&sender, gap_offset).await;
                                }
                                let origin = direct.source_origin;
                                direct = output_control
                                    .add_direct_sink_from(output_viewer_id.clone(), origin)
                                    .await;
                                continue;
                            }
                            let Some(chunk) = chunk else { break };
                            #[cfg(test)]
                            if let Some(gate) = pty_send_gate.take() {
                                gate.notified().await;
                            }
                            let Some(effect) = output_channels.permit().await else {
                                break;
                            };
                            let _callback = output_fence.read().await;
                            if !effect.valid()
                                || !output_active.load(Ordering::Acquire)
                                || !rtc_output_allowed(&output_registry, session)
                            {
                                break;
                            }
                            if !wait_for_data_channel_capacity(&dc, &buffered_low).await {
                                break;
                            }
                            if let Err(error) = dc.send(&Bytes::copy_from_slice(&chunk)).await {
                                tracing::debug!(%session_id, %error, "rtc data channel send failed");
                                break;
                            }
                        }
                        output_channels.stop();
                        output_active.store(false, Ordering::Release);
                        output_sessions.schedule_close_if_same(
                            &output_signal_id,
                            &output_generation,
                            &output_pc,
                            &output_close,
                        );
                        #[cfg(test)]
                        pause_test_sender_close(&pty_sender_close_gate, &output_close).await;
                        let _ = dc.close().await;
                    });
                })
            }));

            let close_active = Arc::clone(&active);
            let close_channels = Arc::clone(&channels);
            let close_pc = Arc::downgrade(&pc);
            let close_sessions = sessions;
            let close_coordinator = Arc::clone(&close);
            let close_session_id = binding.signaling.signal_id.clone();
            let close_generation = binding.signaling.generation.clone();
            dc.on_close(Box::new(move || {
                let active = Arc::clone(&close_active);
                let channels = Arc::clone(&close_channels);
                let pc = close_pc.clone();
                let sessions = close_sessions.clone();
                let close = Arc::clone(&close_coordinator);
                let signal_id = close_session_id.clone();
                let generation = close_generation.clone();
                let initiating_deadline = close.initiate();
                Box::pin(async move {
                    channels.stop();
                    active.store(false, Ordering::Release);
                    debug_assert_eq!(close.initiate(), initiating_deadline);
                    if let Some(pc) = pc.upgrade() {
                        sessions.schedule_close_if_same(&signal_id, &generation, &pc, &close);
                    }
                })
            }));
        })
    }));
}

#[allow(clippy::too_many_arguments)]
fn install_control_data_channel(
    dc: Arc<RTCDataChannel>,
    viewer_id: String,
    signal_id: String,
    session: SessionBinding,
    registry: SessionRegistry,
    controls: SessionControlHub,
    active: Arc<AtomicBool>,
    fence: Arc<tokio::sync::RwLock<()>>,
    channels: Arc<RequiredSessionChannels>,
    pc: Arc<RTCPeerConnection>,
    sessions: RtcSessions,
    close: Arc<PeerCloseCoordinator>,
    generation: String,
    #[cfg(test)] sender_close_gate: Option<Arc<TestSenderCloseGate>>,
) {
    let session_id = session.session_id();
    let upload_capability = Uuid::new_v4();
    let uploads = sessions.uploads.clone();
    let (sender, mut receiver) = mpsc::channel(session_ctl::OUTBOUND_QUEUE_DEPTH);
    channels.set_control_sender(sender.clone());
    let (display_sender, mut display_receiver) = tokio::sync::watch::channel(None::<String>);
    let (close_tx, mut close_rx) = oneshot::channel();
    let close_tx = Arc::new(Mutex::new(Some(close_tx)));
    let send_dc = Arc::clone(&dc);
    let send_viewer_id = viewer_id.clone();
    let send_registry = registry.clone();
    let send_active = Arc::clone(&active);
    let send_fence = Arc::clone(&fence);
    let send_channels = Arc::clone(&channels);
    let send_pc = Arc::clone(&pc);
    let send_sessions = sessions.clone();
    let send_close = Arc::clone(&close);
    let send_generation = generation.clone();
    tokio::spawn(async move {
        let buffered_low = configure_data_channel_pacing(&send_dc).await;
        #[cfg(test)]
        let sender_exit = wait_test_sender_exit(&sender_close_gate);
        #[cfg(not(test))]
        let sender_exit = std::future::pending::<()>();
        tokio::pin!(sender_exit);
        loop {
            let message = tokio::select! {
                message = receiver.recv() => message,
                changed = display_receiver.changed() => {
                    if changed.is_err() {
                        None
                    } else {
                        display_receiver
                            .borrow_and_update()
                            .clone()
                            .map(ControlOutbound::Text)
                    }
                },
                _ = &mut close_rx => None,
                _ = &mut sender_exit => None,
            };
            let Some(mut message) = message else {
                break;
            };
            let Some(effect) = send_channels.permit().await else {
                break;
            };
            let _callback = send_fence.read().await;
            if !effect.valid()
                || !send_active.load(Ordering::Acquire)
                || !send_registry.is_current(session)
            {
                break;
            }
            let message_len = match &message {
                ControlOutbound::Text(text) => text.len(),
                ControlOutbound::Binary(bytes) => bytes.len(),
            };
            if message_len > DATA_CHANNEL_MESSAGE_BYTES {
                tracing::warn!(%session_id, %send_viewer_id, "dropping oversized spawn.ctl outbound message");
                continue;
            }
            if !wait_for_data_channel_capacity(&send_dc, &buffered_low).await {
                break;
            }
            let send = async {
                match &mut message {
                    ControlOutbound::Text(text) => send_dc.send_text(std::mem::take(text)).await,
                    ControlOutbound::Binary(bytes) => {
                        send_dc.send(&Bytes::copy_from_slice(bytes)).await
                    }
                }
            };
            match send.await {
                Ok(_) => {}
                Err(error) => {
                    tracing::debug!(%session_id, %send_viewer_id, %error, "spawn.ctl send failed");
                    break;
                }
            }
        }
        send_channels.stop();
        send_active.store(false, Ordering::Release);
        send_sessions.schedule_close_if_same(
            &send_viewer_id,
            &send_generation,
            &send_pc,
            &send_close,
        );
        #[cfg(test)]
        pause_test_sender_close(&sender_close_gate, &send_close).await;
        let _ = send_dc.close().await;
    });

    // webrtc-rs may invoke multiple message callbacks concurrently. Serialize
    // each viewer's requests so state-changing operations and their replies
    // retain the ordered DataChannel's request order.
    let request_lock = Arc::new(Mutex::new(()));
    let message_registry = registry.clone();
    let message_controls = controls.clone();
    let message_sender = sender.clone();
    let message_display_sender = display_sender.clone();
    let message_viewer_id = viewer_id.clone();
    let message_uploads = uploads.clone();
    #[cfg(test)]
    let message_sessions = sessions.clone();
    #[cfg(test)]
    let message_signal_id = signal_id.clone();
    let message_active = Arc::clone(&active);
    let message_fence = Arc::clone(&fence);
    let message_channels = Arc::clone(&channels);
    dc.on_message(Box::new(move |msg: DataChannelMessage| {
        let registry = message_registry.clone();
        let controls = message_controls.clone();
        let sender = message_sender.clone();
        let display_sender = message_display_sender.clone();
        let viewer_id = message_viewer_id.clone();
        let uploads = message_uploads.clone();
        let request_lock = request_lock.clone();
        let active = Arc::clone(&message_active);
        let fence = Arc::clone(&message_fence);
        let channels = Arc::clone(&message_channels);
        #[cfg(test)]
        let sessions = message_sessions.clone();
        #[cfg(test)]
        let signal_id = message_signal_id.clone();
        Box::pin(async move {
            let Some(effect) = channels.permit().await else {
                return;
            };
            let _callback = fence.read().await;
            if !effect.valid() || !active.load(Ordering::Acquire) || !registry.is_current(session) {
                return;
            }
            let _guard = request_lock.lock().await;
            #[cfg(test)]
            sessions
                .pause_effect(&signal_id, TestEffectPoint::ControlRequest)
                .await;
            if !effect.valid() || !active.load(Ordering::Acquire) || !registry.is_current(session) {
                return;
            }
            if !msg.is_string {
                match session_ctl::decode_upload_chunk(&msg.data) {
                    Ok(chunk) => {
                        let upload_id = chunk.upload_id;
                        let outcome = uploads
                            .write_chunk(
                                session,
                                UploadChunkRequest {
                                    viewer_id: &viewer_id,
                                    capability: upload_capability,
                                    upload_id,
                                    sequence: chunk.sequence,
                                    last: chunk.last,
                                    bytes: &chunk.payload,
                                },
                            )
                            .await;
                        if !effect.valid()
                            || !active.load(Ordering::Acquire)
                            || !registry.is_current(session)
                        {
                            let _ = uploads
                                .cancel(session, &viewer_id, upload_capability, upload_id)
                                .await;
                            return;
                        }
                        match outcome {
                            Ok(UploadChunkOutcome::Pending) => {}
                            Ok(UploadChunkOutcome::Complete(result)) => {
                                if let Err(error) =
                                    session_ctl::send_upload_complete(&sender, upload_id, &result)
                                        .await
                                {
                                    session_ctl::send_error(&sender, &error).await;
                                }
                            }
                            Err(error) => {
                                session_ctl::send_error(
                                    &sender,
                                    &ProtocolError::new(Some(upload_id), error.code, &error.detail),
                                )
                                .await;
                            }
                        }
                    }
                    Err(error) => {
                        if let Some(upload_id) = error.request_id {
                            let _ = uploads
                                .cancel(session, &viewer_id, upload_capability, upload_id)
                                .await;
                        }
                        session_ctl::send_error(&sender, &error).await;
                    }
                }
                return;
            }
            let text = match std::str::from_utf8(&msg.data) {
                Ok(text) => text,
                Err(_) => {
                    session_ctl::send_error(
                        &sender,
                        &ProtocolError::new(None, "malformed_request", "request is not UTF-8"),
                    )
                    .await;
                    return;
                }
            };
            match ControlRequest::decode(text) {
                Ok(request) => {
                    let registered = controls.contains_viewer(session_id, &viewer_id).await;
                    if !effect.valid()
                        || !active.load(Ordering::Acquire)
                        || !registry.is_current(session)
                    {
                        return;
                    }
                    if !registered {
                        controls
                            .register(session_id, viewer_id.clone(), display_sender.clone())
                            .await;
                        if !effect.valid()
                            || !active.load(Ordering::Acquire)
                            || !registry.is_current(session)
                        {
                            return;
                        }
                    }
                    handle_control_request(
                        ControlRequestContext {
                            session,
                            viewer_id: &viewer_id,
                            registry: &registry,
                            controls: &controls,
                            sender: &sender,
                            effect: &effect,
                            uploads: &uploads,
                            upload_capability,
                        },
                        request,
                    )
                    .await;
                }
                Err(error) => session_ctl::send_error(&sender, &error).await,
            }
        })
    }));

    let open_controls = controls.clone();
    let open_viewer_id = viewer_id.clone();
    let open_sender = sender;
    let open_display_sender = display_sender;
    let open_active = Arc::clone(&active);
    let open_registry = registry;
    let open_fence = fence;
    let open_channels = Arc::clone(&channels);
    let open_pc = Arc::downgrade(&pc);
    let open_sessions = sessions.clone();
    let open_close = Arc::clone(&close);
    let open_signal_id = signal_id.clone();
    let open_generation = generation.clone();
    dc.on_open(Box::new(move || {
        let controls = open_controls.clone();
        let viewer_id = open_viewer_id.clone();
        let sender = open_sender.clone();
        let display_sender = open_display_sender.clone();
        let active = Arc::clone(&open_active);
        let registry = open_registry.clone();
        let fence = Arc::clone(&open_fence);
        let channels = Arc::clone(&open_channels);
        let pc = open_pc.clone();
        let sessions = open_sessions.clone();
        let close = Arc::clone(&open_close);
        let signal_id = open_signal_id.clone();
        let generation = open_generation.clone();
        Box::pin(async move {
            let Some(pc) = pc.upgrade() else { return };
            if !active.load(Ordering::Acquire) || !registry.is_current(session) {
                return;
            }
            channels.mark_open(SessionChannel::Control).await;
            if !channels.wait_ready().await {
                sessions.schedule_close_if_same(&signal_id, &generation, &pc, &close);
                return;
            }
            let Some(effect) = channels.permit().await else {
                sessions.schedule_close_if_same(&signal_id, &generation, &pc, &close);
                return;
            };
            let _callback = fence.read().await;
            if !effect.valid() || !active.load(Ordering::Acquire) || !registry.is_current(session) {
                return;
            }
            controls
                .register(session_id, viewer_id.clone(), display_sender)
                .await;
            #[cfg(test)]
            sessions
                .pause_effect(&signal_id, TestEffectPoint::Ready)
                .await;
            if !effect.valid() || !active.load(Ordering::Acquire) || !registry.is_current(session) {
                return;
            }
            if session_ctl::send_ready(&sender, upload_capability, session.generation())
                .await
                .is_err()
            {
                channels.stop();
                active.store(false, Ordering::Release);
                sessions.schedule_close_if_same(&signal_id, &generation, &pc, &close);
            }
        })
    }));

    let close_pc = Arc::downgrade(&pc);
    dc.on_close(Box::new(move || {
        let close_tx = close_tx.clone();
        let channels = Arc::clone(&channels);
        let active = Arc::clone(&active);
        let pc = close_pc.clone();
        let sessions = sessions.clone();
        let signal_id = signal_id.clone();
        let generation = generation.clone();
        let close = Arc::clone(&close);
        let uploads = uploads.clone();
        let viewer_id = viewer_id.clone();
        // webrtc-rs close delivery differs by platform. Establish the Unix
        // deadline synchronously at callback invocation, before returning the
        // future whose polling may be independently scheduled.
        #[cfg(not(windows))]
        let upload_deadline = close.initiate();
        Box::pin(async move {
            // Windows serializes this path differently; preserve its observed
            // first-poll ordering.
            #[cfg(windows)]
            let upload_deadline = close.initiate();
            uploads.cancel_viewer_now(session, &viewer_id);
            if let Some(close_tx) = close_tx.lock().await.take() {
                let _ = close_tx.send(());
            }
            channels.stop();
            active.store(false, Ordering::Release);
            debug_assert_eq!(close.initiate(), upload_deadline);
            if let Some(pc) = pc.upgrade() {
                sessions.schedule_close_if_same(&signal_id, &generation, &pc, &close);
            }
        })
    }));
}

#[derive(Clone, Copy)]
struct ControlRequestContext<'a> {
    session: SessionBinding,
    viewer_id: &'a str,
    registry: &'a SessionRegistry,
    controls: &'a SessionControlHub,
    sender: &'a ControlSender,
    effect: &'a SessionEffectPermit,
    uploads: &'a UploadHub,
    upload_capability: Uuid,
}

async fn handle_control_request(context: ControlRequestContext<'_>, request: ControlRequest) {
    let ControlRequestContext {
        session,
        controls,
        sender,
        effect,
        ..
    } = context;
    let session_id = session.session_id();
    let request_id = request.request_id;
    let transaction = controls.transaction(session_id).await;
    let _guard = transaction.lock().await;
    if !effect.valid() {
        return;
    }
    if let Err(mut error) = execute_control_request(context, request).await {
        if error.request_id.is_none() {
            error.request_id = Some(request_id);
        }
        session_ctl::send_error(sender, &error).await;
    }
}

async fn execute_control_request(
    context: ControlRequestContext<'_>,
    request: ControlRequest,
) -> Result<(), ProtocolError> {
    let ControlRequestContext {
        session,
        viewer_id,
        registry,
        controls,
        sender,
        effect,
        uploads,
        upload_capability,
    } = context;
    let session_id = session.session_id();
    if !effect.valid() || !registry.is_current(session) {
        return Err(ProtocolError::new(
            Some(request.request_id),
            "stale_agent_generation",
            "the RTC session belongs to a replaced session backend",
        ));
    }
    let request_id = request.request_id;
    let operation_name = request.operation_name();
    match request.operation {
        ControlOperation::History {
            lines,
            plain,
            cols,
            rows,
        } => {
            if let Some((cols, rows)) = cols.zip(rows) {
                if controls.is_owner(session_id, viewer_id).await {
                    if !effect.valid() {
                        return Ok(());
                    }
                    resize_session(session, cols, rows, registry).await?;
                    if !effect.valid() {
                        return Ok(());
                    }
                    let _ = controls
                        .update_size(session_id, viewer_id, cols, rows)
                        .await;
                }
            }
            if !effect.valid() {
                return Ok(());
            }
            send_session_replay(
                session,
                ReplaySpec {
                    viewer_id,
                    request_id,
                    operation: operation_name,
                    lines,
                    plain,
                },
                registry,
                sender,
            )
            .await
        }
        ControlOperation::Snapshot { lines, plain } => {
            if !effect.valid() {
                return Ok(());
            }
            send_session_replay(
                session,
                ReplaySpec {
                    viewer_id,
                    request_id,
                    operation: operation_name,
                    lines,
                    plain,
                },
                registry,
                sender,
            )
            .await
        }
        ControlOperation::HistorySubscribe => {
            let Some(control) = registry.control_for_binding(session) else {
                return Err(ProtocolError::new(
                    Some(request_id),
                    "agent_unavailable",
                    "session is not attached to this daemon",
                ));
            };
            if !effect.valid() {
                return Ok(());
            }
            spawn_history_pump(control, sender.clone(), viewer_id.to_string());
            session_ctl::send_ack(sender, request_id, operation_name).await
        }
        ControlOperation::Resize { cols, rows } => {
            if !controls.is_owner(session_id, viewer_id).await {
                return Err(ProtocolError::new(
                    Some(request_id),
                    "not_display_owner",
                    "only the controlling viewer may resize the shared PTY",
                ));
            }
            if !effect.valid() {
                return Ok(());
            }
            resize_session(session, cols, rows, registry).await?;
            if !effect.valid() {
                return Ok(());
            }
            let _ = controls
                .update_size(session_id, viewer_id, cols, rows)
                .await;
            if !effect.valid() {
                return Ok(());
            }
            session_ctl::send_ack(sender, request_id, operation_name).await?;
            Ok(())
        }
        ControlOperation::TakeControl { cols, rows } => {
            if !controls.contains_viewer(session_id, viewer_id).await {
                return Err(ProtocolError::new(
                    Some(request_id),
                    "unknown_viewer",
                    "viewer is not registered on this control channel",
                ));
            }
            if !effect.valid() {
                return Ok(());
            }
            resize_session(session, cols, rows, registry).await?;
            if !effect.valid() {
                return Ok(());
            }
            let _ = controls
                .take_control(session_id, viewer_id, cols, rows)
                .await;
            if !effect.valid() {
                return Ok(());
            }
            redraw_session(session, registry).await;
            if !effect.valid() {
                return Ok(());
            }
            session_ctl::send_ack(sender, request_id, operation_name).await?;
            Ok(())
        }
        ControlOperation::Scroll { lines } => {
            if !effect.valid() {
                return Ok(());
            }
            scroll_session(session, lines, registry).await?;
            if !effect.valid() {
                return Ok(());
            }
            session_ctl::send_ack(sender, request_id, operation_name).await?;
            Ok(())
        }
        ControlOperation::Redraw => {
            if !effect.valid() {
                return Ok(());
            }
            redraw_session(session, registry).await;
            if !effect.valid() {
                return Ok(());
            }
            session_ctl::send_ack(sender, request_id, operation_name).await?;
            Ok(())
        }
        ControlOperation::UploadStart {
            capability,
            agent_generation,
            name,
            mime_type,
            destination,
            total_bytes,
            chunks,
            sha256,
        } => {
            if capability != upload_capability || agent_generation != session.generation() {
                return Err(ProtocolError::new(
                    Some(request_id),
                    "upload_capability_mismatch",
                    "upload capability or backend generation does not match this channel",
                ));
            }
            let cwd = registry.cwd_for_binding(session).ok_or_else(|| {
                ProtocolError::new(
                    Some(request_id),
                    "upload_root_unavailable",
                    "the bound worker did not provide a local cwd capability",
                )
            })?;
            if !effect.valid() || !registry.is_current(session) {
                return Err(ProtocolError::new(
                    Some(request_id),
                    "stale_agent_generation",
                    "the RTC session belongs to a replaced session backend",
                ));
            }
            let outcome = uploads
                .start(
                    session,
                    viewer_id,
                    upload_capability,
                    request_id,
                    &cwd,
                    UploadManifest {
                        name,
                        mime_type,
                        destination: destination.into(),
                        total_bytes,
                        chunks,
                        sha256,
                    },
                )
                .await
                .map_err(|error| ProtocolError::new(Some(request_id), error.code, &error.detail))?;
            if !effect.valid() || !registry.is_current(session) {
                let _ = uploads
                    .cancel(session, viewer_id, upload_capability, request_id)
                    .await;
                return Ok(());
            }
            match outcome {
                UploadStartOutcome::Ready {
                    next_sequence,
                    received_bytes,
                } => {
                    session_ctl::send_upload_ready(
                        sender,
                        request_id,
                        next_sequence,
                        received_bytes,
                    )
                    .await
                }
                UploadStartOutcome::Complete(result) => {
                    session_ctl::send_upload_complete(sender, request_id, &result).await
                }
            }
        }
        ControlOperation::UploadCancel {
            capability,
            agent_generation,
            upload_id,
        } => {
            if capability != upload_capability || agent_generation != session.generation() {
                return Err(ProtocolError::new(
                    Some(request_id),
                    "upload_capability_mismatch",
                    "upload capability or backend generation does not match this channel",
                ));
            }
            uploads
                .cancel(session, viewer_id, upload_capability, upload_id)
                .await
                .map_err(|error| ProtocolError::new(Some(request_id), error.code, &error.detail))?;
            if !effect.valid() || !registry.is_current(session) {
                return Ok(());
            }
            session_ctl::send_ack(sender, request_id, operation_name).await
        }
    }
}

struct ReplaySpec<'a> {
    viewer_id: &'a str,
    request_id: Uuid,
    operation: &'a str,
    lines: u16,
    plain: bool,
}

/// Relay committed-history deltas from the session's forwarder to one control
/// channel as `history_delta`/`history_wipe` events. If the per-viewer queue
/// overflows (the fan-out drops the sink), the pump re-subscribes and emits a
/// `history_gap` so the client re-anchors from a fresh snapshot. Ends when the
/// control channel closes.
fn spawn_history_pump(
    control: crate::pty::ForwarderControl,
    sender: ControlSender,
    viewer_id: String,
) {
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine;
    let key = format!("{viewer_id}:{}", Uuid::new_v4());
    tokio::spawn(async move {
        let mut resubscribed = false;
        'outer: loop {
            let mut receiver = control.add_history_sink(key.clone()).await;
            if resubscribed
                && session_ctl::send_history_event(&sender, session_ctl::HistoryEvent::Gap)
                    .await
                    .is_err()
            {
                break;
            }
            resubscribed = true;
            loop {
                let update = tokio::select! {
                    update = receiver.recv() => update,
                    _ = sender.closed() => break 'outer,
                };
                let Some(update) = update else {
                    // Dropped by the fan-out for falling behind: resubscribe
                    // and tell the client to heal the hole.
                    continue 'outer;
                };
                let sent = match update {
                    crate::pty::HistoryUpdate::Delta {
                        epoch,
                        offset,
                        payload,
                    } => {
                        // Fragment so each JSON text message stays under the
                        // 16 KiB spawn.ctl request/response cap. Offsets are
                        // byte-positions, so fragments re-anchor naturally.
                        const FRAGMENT_BYTES: usize = 8 * 1024;
                        let mut result = Ok(());
                        for (index, part) in payload.chunks(FRAGMENT_BYTES).enumerate() {
                            let data = BASE64.encode(part);
                            result = session_ctl::send_history_event(
                                &sender,
                                session_ctl::HistoryEvent::Delta {
                                    epoch,
                                    offset: offset + (index * FRAGMENT_BYTES) as u64,
                                    data: &data,
                                },
                            )
                            .await;
                            if result.is_err() {
                                break;
                            }
                        }
                        result
                    }
                    crate::pty::HistoryUpdate::Wipe { epoch } => {
                        session_ctl::send_history_event(
                            &sender,
                            session_ctl::HistoryEvent::Wipe { epoch },
                        )
                        .await
                    }
                };
                if sent.is_err() {
                    break 'outer;
                }
            }
        }
        control.remove_history_sink(&key).await;
    });
}

async fn send_session_replay(
    session: SessionBinding,
    spec: ReplaySpec<'_>,
    registry: &SessionRegistry,
    sender: &ControlSender,
) -> Result<(), ProtocolError> {
    if spec.plain {
        return Err(ProtocolError::new(
            Some(spec.request_id),
            "plain_replay_unsupported",
            "plain replay is not supported; request styled terminal replay",
        ));
    }
    let Some(control) = registry.control_for_binding(session) else {
        return Err(ProtocolError::new(
            Some(spec.request_id),
            "agent_unavailable",
            "session is not attached to this daemon",
        ));
    };
    if !control
        .wait_for_direct_sink(spec.viewer_id, Duration::from_secs(3))
        .await
    {
        return Err(ProtocolError::new(
            Some(spec.request_id),
            "pty_channel_unavailable",
            "spawn.pty did not become ready for this control session",
        ));
    }
    let capture = capture_session_replay(session, spec.lines, spec.plain, registry, &control);
    tokio::pin!(capture);
    let replay = tokio::select! {
        result = &mut capture => result?,
        _ = sender.closed() => {
            return Err(ProtocolError::new(
                Some(spec.request_id),
                "request_cancelled",
                "control channel closed while replay was in progress",
            ));
        }
        _ = tokio::time::sleep(Duration::from_secs(10)) => {
            return Err(ProtocolError::new(
                Some(spec.request_id),
                "request_timeout",
                "replay did not complete within 10 seconds",
            ));
        }
    };
    let source_boundary = replay.watermark();
    let pty_offset = control
        .direct_sink_anchor(spec.viewer_id, source_boundary)
        .await
        .ok_or_else(|| {
            ProtocolError::new(
                Some(spec.request_id),
                "pty_channel_unavailable",
                "spawn.pty disconnected while replay was captured",
            )
        })?;
    session_ctl::send_replay(
        sender,
        spec.request_id,
        spec.operation,
        spec.plain,
        Some(pty_offset),
        &replay,
    )
    .await
}

async fn capture_session_replay(
    session: SessionBinding,
    lines: u16,
    _plain: bool,
    registry: &SessionRegistry,
    control: &crate::pty::ForwarderControl,
) -> Result<crate::pty::WorkerReplay, ProtocolError> {
    let max_bytes = if lines == session_ctl::MAX_HISTORY_LINES {
        8 * 1024 * 1024
    } else {
        (lines as u32)
            .saturating_mul(256)
            .clamp(64 * 1024, 8 * 1024 * 1024)
    };
    let mut replay_rx = None;
    registry.with_bound_handle(session, |handle| {
        replay_rx = handle.replay(max_bytes);
    });
    match replay_rx {
        Some(receiver) => match receiver.await {
            Ok(Ok(replay)) => {
                control.wait_source_offset(replay.watermark()).await;
                Ok(replay)
            }
            Ok(Err(error)) => Err(ProtocolError::new(
                None,
                "replay_failed",
                &format!("worker replay failed: {error:#}"),
            )),
            Err(_) => Err(ProtocolError::new(
                None,
                "replay_unavailable",
                "worker replay channel closed",
            )),
        },
        None => Err(ProtocolError::new(
            None,
            "replay_unavailable",
            "worker replay is unavailable",
        )),
    }
}

async fn resize_session(
    session: SessionBinding,
    cols: u16,
    rows: u16,
    registry: &SessionRegistry,
) -> Result<(), ProtocolError> {
    let mut result = None;
    let found = registry.with_bound_handle(session, |handle| {
        result = Some(handle.resize(cols, rows));
    });
    if !found {
        return Err(ProtocolError::new(
            None,
            "agent_unavailable",
            "session is not running on this daemon",
        ));
    }
    result
        .expect("found handle sets result")
        .map_err(|error| ProtocolError::new(None, "resize_failed", &format!("{error:#}")))?;
    Ok(())
}

async fn scroll_session(
    session: SessionBinding,
    lines: i16,
    registry: &SessionRegistry,
) -> Result<(), ProtocolError> {
    if !registry.is_current(session) {
        return Err(ProtocolError::new(
            None,
            "agent_unavailable",
            "session is not running on this daemon",
        ));
    }
    tracing::debug!(session_id = %session.session_id(), lines, "ignoring deprecated scroll operation");
    Ok(())
}

async fn redraw_session(session: SessionBinding, registry: &SessionRegistry) {
    tracing::debug!(session_id = %session.session_id(), current = registry.is_current(session), "ignoring deprecated redraw operation");
}

/// Testable core of the `spawn.pty` input callback. Activity is recorded only
/// after a successful, non-empty binary write, and the helper API exposes no
/// input bytes to the content-free activity serializer.
fn forward_bound_data_channel_input(
    session: SessionBinding,
    is_string: bool,
    data: &[u8],
    registry: &SessionRegistry,
    out_tx: &mpsc::Sender<WsOutbound>,
) -> Option<Result<bool>> {
    let mut result = None;
    registry.with_bound_handle(session, |handle| {
        result = Some(forward_data_channel_input(
            session.session_id(),
            is_string,
            data,
            &handle.control,
            out_tx,
            |bytes| handle.write_stdin(bytes),
        ));
    });
    result
}

fn rtc_output_allowed(registry: &SessionRegistry, session: SessionBinding) -> bool {
    registry.is_current(session)
}

fn forward_data_channel_input<W>(
    session_id: Uuid,
    is_string: bool,
    data: &[u8],
    control: &crate::pty::ForwarderControl,
    out_tx: &mpsc::Sender<WsOutbound>,
    write_stdin: W,
) -> Result<bool>
where
    W: FnOnce(&[u8]) -> Result<()>,
{
    if is_string || data.is_empty() {
        return Ok(false);
    }
    write_stdin(data)?;
    // Focus-weighted scheduling: the session being typed into gets its CPU
    // scope boosted so its response wins the scheduler under host load.
    crate::cpu_scopes::note_input(session_id);
    if control.note_input(data) {
        crate::pty::try_emit_activity(out_tx, session_id, crate::pty::ActivityKind::Input);
    }
    Ok(true)
}

fn to_webrtc_ice_server(config: RtcIceServerConfig) -> RTCIceServer {
    RTCIceServer {
        urls: config.urls,
        username: config.username.unwrap_or_default(),
        credential: config.credential.unwrap_or_default(),
    }
}

fn build_api() -> Result<webrtc::api::API> {
    let mut media_engine = MediaEngine::default();
    media_engine
        .register_default_codecs()
        .context("registering WebRTC codecs")?;
    Ok(APIBuilder::new()
        .with_media_engine(media_engine)
        .with_setting_engine(setting_engine()?)
        .build())
}

/// The connection-address of an RFC 8828 obfuscated host candidate, if this
/// is one.
///
/// Every browser hides the local IP of its host candidates behind an ephemeral
/// `<uuid>.local` name and expects the peer to resolve it over mDNS. Only host
/// candidates are ever obfuscated, and the name is always a single label, so
/// anything else is left exactly as it arrived.
fn mdns_candidate_host(candidate: &str) -> Option<&str> {
    let line = candidate
        .strip_prefix("a=")
        .unwrap_or(candidate)
        .strip_prefix("candidate:")?;
    let fields: Vec<&str> = line.split_ascii_whitespace().collect();
    // foundation component transport priority address port typ type
    if fields.len() < 8 || fields[6] != "typ" || fields[7] != "host" {
        return None;
    }
    let address = fields[4];
    let name = address.strip_suffix(".local")?;
    if name.is_empty() || name.contains('.') {
        return None;
    }
    Some(address)
}

/// The same candidate with its obfuscated name replaced by the address it
/// stands for. `None` when the line is not shaped the way it was measured.
fn rewrite_candidate_host(candidate: &str, address: IpAddr) -> Option<String> {
    let (prefix, line) = match candidate.strip_prefix("a=") {
        Some(rest) => ("a=", rest),
        None => ("", candidate),
    };
    let body = line.strip_prefix("candidate:")?;
    let mut fields: Vec<&str> = body.split_ascii_whitespace().collect();
    if fields.len() < 8 {
        return None;
    }
    let resolved = address.to_string();
    fields[4] = resolved.as_str();
    Some(format!("{prefix}candidate:{}", fields.join(" ")))
}

/// Resolve an obfuscated candidate to an ordinary host candidate.
///
/// webrtc-rs can do this itself, but only in a multicast-DNS mode whose
/// resolver task outlives the connection and spins forever on a name that
/// never answers — which is most of them, since a browser's name only resolves
/// on its own network. So mDNS stays off in the [`setting_engine`] and the
/// lookup happens here instead, where it is bounded and ends with the
/// connection: the OS resolver answers `.local` on macOS, and on Linux
/// wherever nss-mdns or systemd-resolved is installed.
///
/// A name that does not resolve is passed through untouched, which is exactly
/// what arrived before this existed — webrtc-rs logs it and ignores it.
async fn resolve_mdns_candidate(init: RTCIceCandidateInit) -> RTCIceCandidateInit {
    let Some(name) = mdns_candidate_host(&init.candidate) else {
        return init;
    };
    let name = name.to_owned();
    let lookup = tokio::time::timeout(
        MDNS_CANDIDATE_RESOLVE_TIMEOUT,
        tokio::net::lookup_host((name.as_str(), 0)),
    )
    .await;
    let addresses = match lookup {
        Ok(Ok(addresses)) => addresses,
        Ok(Err(error)) => {
            tracing::debug!(%name, %error, "resolving an mDNS ICE candidate failed");
            return init;
        }
        Err(_) => {
            tracing::debug!(%name, "resolving an mDNS ICE candidate timed out");
            return init;
        }
    };
    // IPv4 first: this daemon gathers no IPv6 candidate on a host without
    // routable IPv6, and a pair needs both halves in the same family.
    let mut fallback = None;
    let mut chosen = None;
    for address in addresses {
        match address.ip() {
            IpAddr::V4(ip) => {
                chosen = Some(IpAddr::V4(ip));
                break;
            }
            IpAddr::V6(ip) => fallback = fallback.or(Some(IpAddr::V6(ip))),
        }
    }
    let Some(address) = chosen.or(fallback) else {
        tracing::debug!(%name, "an mDNS ICE candidate resolved to no address");
        return init;
    };
    let Some(candidate) = rewrite_candidate_host(&init.candidate, address) else {
        return init;
    };
    tracing::debug!(%name, "resolved an mDNS ICE candidate");
    RTCIceCandidateInit { candidate, ..init }
}

fn setting_engine() -> Result<SettingEngine> {
    let mut settings = SettingEngine::default();
    // QueryOnly leaks a resolver task/socket per peer in webrtc-rs 0.17: the
    // query loops forever on a name that never answers, and closing the agent
    // does not end it. Remote `.local` candidates are resolved in
    // [`resolve_mdns_candidate`] instead, bounded and before they get here.
    settings.set_ice_multicast_dns_mode(MulticastDnsMode::Disabled);
    settings.set_interface_filter(Box::new(interface_is_allowed));
    settings.set_ip_filter(Box::new(ip_is_allowed));
    settings.set_udp_network(UDPNetwork::Ephemeral(
        EphemeralUDP::new(RTC_UDP_PORT_MIN, RTC_UDP_PORT_MAX)
            .context("configuring the RTC UDP port range")?,
    ));
    settings.set_sctp_max_message_size_can_send(SctpMaxMessageSize::Bounded(
        DATA_CHANNEL_MESSAGE_BYTES as u32,
    ));
    if !RTC_NETWORK_POLICY_LOGGED.swap(true, Ordering::AcqRel) {
        tracing::info!(
            udp_port_min = RTC_UDP_PORT_MIN,
            udp_port_max = RTC_UDP_PORT_MAX,
            "LAN-direct WebRTC requires this inbound UDP firewall range; remote mDNS candidates are resolved by the OS resolver"
        );
    }
    Ok(settings)
}

fn interface_is_allowed(name: &str) -> bool {
    ![
        "docker", "br-", "veth", "awdl", "llw", "anpi", "bridge", "vmnet", "virbr", "zt",
    ]
    .iter()
    .any(|prefix| name.starts_with(prefix))
        && name != "lo"
}

fn ip_is_allowed(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let octets = ip.octets();
            !(octets[0] == 169 && octets[1] == 254)
        }
        IpAddr::V6(ip) => ip.segments()[0] & 0xffc0 != 0xfe80,
    }
}

fn warn_if_no_udp_turn(servers: &[RtcIceServerConfig]) {
    if !has_udp_turn(servers) && !TURN_UDP_WARNING_LOGGED.swap(true, Ordering::AcqRel) {
        tracing::warn!(
            "offered ICE configuration has no UDP turn: URL; webrtc-ice 0.17 cannot use TURN over TCP/TLS"
        );
    }
}

fn has_udp_turn(servers: &[RtcIceServerConfig]) -> bool {
    servers.iter().flat_map(|server| &server.urls).any(|url| {
        let lower = url.to_ascii_lowercase();
        lower.starts_with("turn:") && !lower.contains("transport=tcp")
    })
}

fn parse_ice_transport_policy(value: Option<&str>) -> Result<RTCIceTransportPolicy> {
    match value {
        Some("relay") => Ok(RTCIceTransportPolicy::Relay),
        Some("all") | None => Ok(RTCIceTransportPolicy::All),
        Some(_) => anyhow::bail!("unsupported ICE transport policy"),
    }
}

fn install_host_ice_handler(
    pc: &Arc<RTCPeerConnection>,
    signal_id: String,
    binding: HostRtcBinding,
    signaling: RtcWsSender,
) {
    pc.on_ice_candidate(Box::new(move |candidate| {
        let signal_id = signal_id.clone();
        let binding = binding.clone();
        let signaling = signaling.clone();
        Box::pin(async move {
            let candidate = match candidate {
                Some(candidate) => {
                    let Ok(candidate) = candidate.to_json() else {
                        return;
                    };
                    candidate
                }
                None => RTCIceCandidateInit {
                    candidate: String::new(),
                    ..Default::default()
                },
            };
            let Ok(candidate) = serde_json::to_value(candidate) else {
                return;
            };
            send_json_dynamic(
                &signaling,
                Outbound::RtcCandidate {
                    session_id: signal_id,
                    binding_nonce: Some(binding.binding_nonce),
                    scope_type: Some("host".to_string()),
                    scope_id: Some(binding.host_id),
                    protocol: Some(binding.protocol),
                    protocol_version: Some(binding.protocol_version),
                    candidate,
                },
            )
            .await;
        })
    }));
}

fn install_host_data_channel_handler(
    pc: &Arc<RTCPeerConnection>,
    signal_id: String,
    binding: HostRtcBinding,
    signaling: RtcWsSender,
    files_override: Option<Arc<HostFileService>>,
) {
    let accepted = Arc::new(AtomicBool::new(false));
    // As in install_data_channel_handler: the peer must not own a handle to
    // itself, or it is never dropped and its ICE ports never come back.
    let handler_pc = Arc::downgrade(pc);
    pc.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
        let Some(pc) = handler_pc.upgrade() else {
            return Box::pin(async {});
        };
        let accepted = Arc::clone(&accepted);
        let signal_id = signal_id.clone();
        let binding = binding.clone();
        let signaling = signaling.clone();
        let files = files_override.clone();
        Box::pin(async move {
            let reliable = dc.ordered()
                && dc.max_packet_lifetime().is_none()
                && dc.max_retransmits().is_none();
            if dc.label() != HOST_CONTROL_LABEL || !reliable {
                let _ = dc.close().await;
                let _ = pc.close().await;
                return;
            }
            if accepted.swap(true, Ordering::AcqRel) {
                let _ = dc.close().await;
                return;
            }
            install_host_control_channel(dc, signal_id, binding, signaling, files);
        })
    }));
}

#[cfg(test)]
enum HostControlAction {
    Reply(String),
    Close,
}

#[cfg(test)]
fn host_control_response(data: &[u8], is_string: bool) -> HostControlAction {
    if !is_string || data.is_empty() || data.len() > HOST_CONTROL_MAX_FRAME_BYTES {
        return HostControlAction::Close;
    }
    let Ok(value) = serde_json::from_slice::<Value>(data) else {
        return HostControlAction::Close;
    };
    let Some(object) = value.as_object() else {
        return HostControlAction::Close;
    };
    if object.get("version").and_then(Value::as_u64) != Some(u64::from(RTC_PROTOCOL_VERSION)) {
        return HostControlAction::Close;
    }
    let Some(request_id) = object.get("request_id").and_then(Value::as_str) else {
        return HostControlAction::Close;
    };
    if request_id.is_empty() || request_id.len() > HOST_CONTROL_MAX_REQUEST_ID_BYTES {
        return HostControlAction::Close;
    }
    let response = match object.get("type").and_then(Value::as_str) {
        Some("request") if object.get("operation").and_then(Value::as_str) == Some("ping") => {
            json!({
                "version": RTC_PROTOCOL_VERSION,
                "type": "response",
                "request_id": request_id,
                "ok": true,
                "result": {"pong": true}
            })
        }
        Some("cancel") => json!({
            "version": RTC_PROTOCOL_VERSION,
            "type": "response",
            "request_id": request_id,
            "ok": false,
            "error": {"code": "cancelled"}
        }),
        Some("request") => json!({
            "version": RTC_PROTOCOL_VERSION,
            "type": "response",
            "request_id": request_id,
            "ok": false,
            "error": {"code": "unsupported_operation"}
        }),
        _ => return HostControlAction::Close,
    };
    HostControlAction::Reply(response.to_string())
}

fn install_host_control_channel(
    dc: Arc<RTCDataChannel>,
    signal_id: String,
    binding: HostRtcBinding,
    signaling: RtcWsSender,
    files_override: Option<Arc<HostFileService>>,
) {
    let connected_signal = HostConnectedSignal::new(signaling, signal_id, binding);
    crate::host_control::install(dc, connected_signal, files_override);
}

pub(crate) async fn send_host_status(
    out_tx: &mpsc::Sender<WsOutbound>,
    signal_id: String,
    binding: &HostRtcBinding,
    status: &str,
) {
    send_json(out_tx, host_status_frame(signal_id, binding, status)).await;
}

pub(crate) fn try_send_host_status(
    signaling: &RtcWsSender,
    signal_id: String,
    binding: &HostRtcBinding,
    status: &str,
) -> bool {
    signaling.try_send(host_status_frame(signal_id, binding, status))
}

fn host_status_frame(signal_id: String, binding: &HostRtcBinding, status: &str) -> Outbound {
    Outbound::RtcStatus {
        session_id: signal_id,
        binding_nonce: Some(binding.binding_nonce.clone()),
        scope_type: Some("host".to_string()),
        scope_id: Some(binding.host_id),
        protocol: Some(binding.protocol.clone()),
        protocol_version: Some(binding.protocol_version),
        status: status.to_string(),
        message: None,
    }
}

fn session_status_frame(
    signal_id: &str,
    binding_nonce: &str,
    session_id: Uuid,
    status: &str,
    message: Option<&str>,
) -> Outbound {
    Outbound::RtcStatus {
        session_id: signal_id.to_string(),
        binding_nonce: Some(binding_nonce.to_string()),
        scope_type: Some("session".to_string()),
        scope_id: Some(session_id),
        protocol: Some(PTY_DATA_CHANNEL_LABEL.to_string()),
        protocol_version: Some(SESSION_RTC_PROTOCOL_VERSION),
        status: status.to_string(),
        message: message.map(str::to_string),
    }
}

async fn send_status(
    out_tx: &mpsc::Sender<WsOutbound>,
    signal_id: String,
    binding_nonce: String,
    session_id: Uuid,
    status: &str,
    message: Option<&str>,
) {
    send_json(
        out_tx,
        Outbound::RtcStatus {
            session_id: signal_id,
            binding_nonce: Some(binding_nonce),
            scope_type: Some("session".to_string()),
            scope_id: Some(session_id),
            protocol: Some(PTY_DATA_CHANNEL_LABEL.to_string()),
            protocol_version: Some(SESSION_RTC_PROTOCOL_VERSION),
            status: status.to_string(),
            message: message.map(str::to_string),
        },
    )
    .await;
}

async fn send_json(out_tx: &mpsc::Sender<WsOutbound>, frame: Outbound) {
    if let Ok(s) = serde_json::to_string(&frame) {
        let _ = out_tx.send(WsOutbound::json(s)).await;
    }
}

async fn send_json_dynamic(signaling: &RtcWsSender, frame: Outbound) {
    let Some(sender) = signaling.load() else {
        return;
    };
    if let Ok(serialized) = serde_json::to_string(&frame) {
        let _ = sender.send(WsOutbound::json(serialized)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The ports a peer's host candidates are bound to, straight from its SDP.
    fn local_candidate_addrs(sdp: &str) -> Vec<std::net::SocketAddr> {
        sdp.lines()
            .filter_map(|line| {
                let fields: Vec<&str> = line.trim_start_matches("a=").split(' ').collect();
                if !fields.first()?.starts_with("candidate:") || fields.get(7) != Some(&"host") {
                    return None;
                }
                let ip: IpAddr = fields.get(4)?.parse().ok()?;
                let port: u16 = fields.get(5)?.parse().ok()?;
                Some(std::net::SocketAddr::new(ip, port))
            })
            .collect()
    }

    /// Every ICE socket this daemon binds lives in the 101-port range
    /// [`RTC_UDP_PORT_MIN`]..=[`RTC_UDP_PORT_MAX`], shared by every peer it
    /// ever answers. A closed peer that keeps its sockets bound exhausts the
    /// range within a few browser reconnects, after which no new peer can
    /// gather a host or server-reflexive candidate and every session falls
    /// back to the TURN relay. Closing a peer must give its ports back.
    #[tokio::test]
    async fn a_closed_peer_releases_its_ice_ports() {
        let api = build_api().unwrap();
        let pc = Arc::new(
            api.new_peer_connection(RTCConfiguration::default())
                .await
                .unwrap(),
        );
        let _channel = pc.create_data_channel("probe", None).await.unwrap();
        let mut gathered = pc.gathering_complete_promise().await;
        let offer = pc.create_offer(None).await.unwrap();
        pc.set_local_description(offer).await.unwrap();
        let _ = gathered.recv().await;
        let addrs = local_candidate_addrs(&pc.local_description().await.unwrap().sdp);
        assert!(!addrs.is_empty(), "the peer gathered no host candidate");
        for addr in &addrs {
            assert!(
                (RTC_UDP_PORT_MIN..=RTC_UDP_PORT_MAX).contains(&addr.port()),
                "{addr} is outside the pinned range"
            );
            assert!(
                std::net::UdpSocket::bind(addr).is_err(),
                "{addr} is not bound while the peer is open"
            );
        }

        pc.close().await.unwrap();
        drop(pc);
        assert_ports_released(&addrs, "closed and dropped peer").await;
    }

    async fn assert_ports_released(addrs: &[std::net::SocketAddr], what: &str) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let mut held = addrs.to_vec();
        loop {
            held.retain(|addr| std::net::UdpSocket::bind(addr).is_err());
            if held.is_empty() {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "{what} still holds its ICE ports: {held:?}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn wait_for_state(pc: &RTCPeerConnection, wanted: RTCPeerConnectionState) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while pc.connection_state() != wanted {
            assert!(
                tokio::time::Instant::now() < deadline,
                "peer never reached {wanted:?}, is {:?}",
                pc.connection_state()
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    /// The same promise for a peer that actually connected: a browser-shaped
    /// offerer negotiates a data channel with a daemon-configured answerer,
    /// the pair goes Connected, and closing the answerer frees its ports —
    /// with handles to it still alive, as they are in the daemon.
    #[tokio::test]
    async fn a_closed_connected_peer_releases_its_ice_ports() {
        let browser = Arc::new(
            APIBuilder::new()
                .build()
                .new_peer_connection(RTCConfiguration::default())
                .await
                .unwrap(),
        );
        let daemon = Arc::new(
            build_api()
                .unwrap()
                .new_peer_connection(RTCConfiguration::default())
                .await
                .unwrap(),
        );
        let _channel = browser.create_data_channel("probe", None).await.unwrap();

        let mut browser_gathered = browser.gathering_complete_promise().await;
        let offer = browser.create_offer(None).await.unwrap();
        browser.set_local_description(offer).await.unwrap();
        let _ = browser_gathered.recv().await;
        let offer = browser.local_description().await.unwrap();

        daemon.set_remote_description(offer).await.unwrap();
        let mut daemon_gathered = daemon.gathering_complete_promise().await;
        let answer = daemon.create_answer(None).await.unwrap();
        daemon.set_local_description(answer).await.unwrap();
        let _ = daemon_gathered.recv().await;
        let answer = daemon.local_description().await.unwrap();
        let addrs = local_candidate_addrs(&answer.sdp);
        assert!(
            !addrs.is_empty(),
            "the daemon peer gathered no host candidate"
        );

        browser.set_remote_description(answer).await.unwrap();
        wait_for_state(&daemon, RTCPeerConnectionState::Connected).await;
        for addr in &addrs {
            assert!(
                std::net::UdpSocket::bind(addr).is_err(),
                "{addr} is not bound while the peer is connected"
            );
        }

        // webrtc-rs frees a peer's sockets when the last handle to the peer
        // drops, not when it is closed. The daemon relies on that: it must
        // hold no handle of its own once a peer is retired, or the ports stay
        // bound for as long as the daemon runs.
        daemon.close().await.unwrap();
        drop(daemon);
        assert_ports_released(&addrs, "closed and dropped connected peer").await;
        browser.close().await.unwrap();
    }

    /// The real path: a browser negotiates a session through the daemon,
    /// then goes away. Every handler and task the daemon installed on that
    /// peer must let go of it, so the peer is dropped and its pinned ICE
    /// ports are free for the next connection.
    #[tokio::test]
    async fn a_departed_browser_leaves_no_peer_and_no_bound_ports_behind() {
        let registry = SessionRegistry::new();
        let session_id = Uuid::new_v4();
        let (session, mut commands) = insert_test_worker(&registry, session_id);
        let control = registry.control_for_binding(session).unwrap();
        let worker = tokio::spawn(async move {
            while let Some(command) = commands.recv().await {
                if let crate::pty::WorkerCmd::Replay { resp, .. } = command {
                    let _ = resp.send(Ok(crate::pty::WorkerReplay::new(
                        control.source_offset(),
                        Vec::new(),
                    )));
                }
            }
        });
        let sessions = RtcSessions::new();
        let signal_id = format!("departed-browser-{}", Uuid::new_v4());
        let client =
            connect_rtc_session(&sessions, &registry, session_id, &signal_id, "generation").await;
        let (peer, addrs) = {
            let peers = sessions.peers.lock().await;
            let pc = &peers.get(&signal_id).expect("active real peer").pc;
            let answer = pc.local_description().await.expect("the daemon answered");
            (Arc::downgrade(pc), local_candidate_addrs(&answer.sdp))
        };
        assert!(
            !addrs.is_empty(),
            "the daemon peer gathered no host candidate"
        );

        // The tab closes, the laptop lid shuts: the browser is simply gone.
        close_test_peer(&client.pc).await;
        drop(client);

        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while peer.upgrade().is_some() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the daemon still holds a handle to the departed browser's peer"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_ports_released(&addrs, "the departed browser's peer").await;
        worker.abort();
    }

    /// The host-control peer has the same shape and the same promise: once
    /// the browser is gone and the peer is closed, nothing the daemon
    /// installed on it may keep it alive. The paired-endpoint harness builds
    /// the daemon peer on a plain API and has no reaper, so this test closes
    /// the peer itself, as close_host_if_same would, and its ports are
    /// ordinary ephemeral ones rather than the pinned range; the handlers
    /// under test are the real ones either way.
    #[tokio::test]
    async fn a_departed_host_control_browser_leaves_no_peer_and_no_bound_ports_behind() {
        let root = tempfile::tempdir().unwrap();
        let files = Arc::new(HostFileService::rooted_at(root.path()).await.unwrap());
        let binding = HostRtcBinding {
            host_id: Uuid::new_v4(),
            binding_nonce: "0".repeat(32),
            binding_generation: 1,
            protocol: HOST_CONTROL_LABEL.to_owned(),
            protocol_version: RTC_PROTOCOL_VERSION,
        };
        let (browser_pc, daemon_pc, channel, messages_rx) =
            paired_host_endpoint(files, binding, "departed-host-browser").await;
        let answer = daemon_pc.local_description().await.unwrap();
        let addrs = local_candidate_addrs(&answer.sdp);
        assert!(
            !addrs.is_empty(),
            "the daemon peer gathered no host candidate"
        );
        let peer = Arc::downgrade(&daemon_pc);

        browser_pc.close().await.unwrap();
        drop(channel);
        drop(messages_rx);
        drop(browser_pc);
        // What close_host_if_same does once the peer fails: close it, and let
        // go of the daemon's own handle.
        close_test_peer(&daemon_pc).await;
        drop(daemon_pc);

        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while peer.upgrade().is_some() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the daemon still holds a handle to the departed browser's host peer"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_ports_released(&addrs, "the departed browser's host peer").await;
    }

    const BROWSER_MDNS_CANDIDATE: &str =
        "candidate:842163049 1 udp 1677729535 33cde59c-1be0-47b5-9ae5-786881bd0089.local 50123 typ host generation 0 ufrag Xk4b network-cost 999";

    #[test]
    fn an_obfuscated_browser_candidate_is_recognised_and_rewritten() {
        // What every browser actually sends: the local IP replaced by an
        // ephemeral name only its own network can answer for.
        assert_eq!(
            mdns_candidate_host(BROWSER_MDNS_CANDIDATE),
            Some("33cde59c-1be0-47b5-9ae5-786881bd0089.local")
        );
        let rewritten =
            rewrite_candidate_host(BROWSER_MDNS_CANDIDATE, "192.168.1.24".parse().unwrap())
                .unwrap();
        assert_eq!(
            rewritten,
            "candidate:842163049 1 udp 1677729535 192.168.1.24 50123 typ host generation 0 ufrag Xk4b network-cost 999"
        );
        // Only the address moved; everything ICE authenticates with is intact.
        assert!(rewritten.contains("ufrag Xk4b"));
        assert!(rewritten.contains("typ host"));
        assert!(!rewritten.contains(".local"));
        // The `a=` form some clients send keeps its prefix.
        let prefixed = format!("a={BROWSER_MDNS_CANDIDATE}");
        assert_eq!(
            mdns_candidate_host(&prefixed),
            Some("33cde59c-1be0-47b5-9ae5-786881bd0089.local")
        );
        assert!(
            rewrite_candidate_host(&prefixed, "10.0.0.2".parse().unwrap())
                .unwrap()
                .starts_with("a=candidate:")
        );
    }

    #[test]
    fn nothing_else_is_touched() {
        for candidate in [
            // An ordinary host candidate.
            "candidate:1 1 udp 2130706431 192.168.1.24 50123 typ host",
            // Reflexive and relay candidates are never obfuscated, and their
            // `raddr` must never be mistaken for the connection-address.
            "candidate:2 1 udp 1694498815 203.0.113.7 50124 typ srflx raddr 192.168.1.24 rport 50123",
            "candidate:3 1 udp 16777215 198.51.100.9 3478 typ relay raddr 0.0.0.0 rport 0",
            // A multi-label name is not the RFC 8828 form: resolving it would
            // send the daemon looking up whatever a peer asked it to.
            "candidate:4 1 udp 1677729535 sneaky.internal.local 50123 typ host",
            "candidate:5 1 udp 1677729535 .local 50123 typ host",
            // Not a candidate line at all, and a truncated one.
            "candidate:6 1 udp 1677729535 33cde59c.local 50123",
            "v=0",
            "",
        ] {
            assert_eq!(mdns_candidate_host(candidate), None, "{candidate}");
        }
        assert_eq!(
            rewrite_candidate_host("v=0", "10.0.0.2".parse().unwrap()),
            None
        );
    }

    #[tokio::test]
    async fn a_name_that_never_resolves_arrives_exactly_as_it_was_sent() {
        // The failure path is the old behaviour: webrtc-rs receives the
        // obfuscated candidate, says so, and ignores it. Nothing is dropped
        // here and nothing waits longer than the bound.
        let init = RTCIceCandidateInit {
            candidate: BROWSER_MDNS_CANDIDATE.to_owned(),
            sdp_mid: Some("0".to_owned()),
            sdp_mline_index: Some(0),
            username_fragment: None,
        };
        let started = tokio::time::Instant::now();
        let resolved = resolve_mdns_candidate(init.clone()).await;
        assert_eq!(resolved.candidate, init.candidate);
        assert_eq!(resolved.sdp_mid, init.sdp_mid);
        assert!(started.elapsed() < MDNS_CANDIDATE_RESOLVE_TIMEOUT + Duration::from_millis(750));

        // A candidate that was never obfuscated is not delayed at all.
        let plain = RTCIceCandidateInit {
            candidate: "candidate:1 1 udp 2130706431 192.168.1.24 50123 typ host".to_owned(),
            ..init
        };
        let started = tokio::time::Instant::now();
        let untouched = resolve_mdns_candidate(plain.clone()).await;
        assert_eq!(untouched.candidate, plain.candidate);
        assert!(started.elapsed() < Duration::from_millis(250));
    }
    use crate::host_files::{HostOperationKind, STREAM_CHUNK_BYTES};
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use sha2::{Digest, Sha256};
    use std::path::Path;

    const DIRECT_ENDPOINT_BYTES_FIELD: &str = concat!("bytes", "_b64");

    #[cfg(windows)]
    fn test_runner_denied_worker_breakaway(error: &anyhow::Error) -> bool {
        let breakaway_denied = error
            .chain()
            .any(|cause| cause.to_string() == "worker breakaway launch was denied");
        let access_denied = error.chain().any(|cause| {
            cause.downcast_ref::<std::io::Error>().is_some_and(|error| {
                error.raw_os_error()
                    == Some(windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED as i32)
            })
        });
        breakaway_denied && access_denied
    }

    #[tokio::test]
    async fn trust_reload_invalidates_every_pre_reload_admission_capture() {
        let sessions = RtcSessions::new();
        let stale = sessions.capture_trust_epoch();
        assert!(sessions.trust_epoch_is_current(stale));

        tokio::time::timeout(
            Duration::from_secs(1),
            sessions.invalidate_trust_and_close_all(),
        )
        .await
        .expect("trust invalidation must be bounded");

        assert!(!sessions.trust_epoch_is_current(stale));
        assert!(sessions.trust_epoch_is_current(sessions.capture_trust_epoch()));
        assert_eq!(sessions.resident_session_count().await, 0);
    }

    #[tokio::test]
    async fn trust_reload_deactivates_all_stale_peers_before_slow_cleanup() {
        let registry = SessionRegistry::new();
        let session_id = Uuid::new_v4();
        let (session, _commands) = insert_test_worker(&registry, session_id);
        let control = registry
            .control_for_binding(session)
            .expect("worker control");
        let pc = Arc::new(
            APIBuilder::new()
                .build()
                .new_peer_connection(RTCConfiguration::default())
                .await
                .unwrap(),
        );
        let active = Arc::new(AtomicBool::new(true));
        let sessions = RtcSessions::new();
        let signal_id = "trust-reload-stalled-cleanup";
        sessions.peers.lock().await.insert(
            signal_id.to_owned(),
            RtcPeer {
                pc,
                session,
                generation: "old-generation".to_owned(),
                active: Arc::clone(&active),
                control,
                channels: Arc::new(RequiredSessionChannels::default()),
                close: Arc::new(PeerCloseCoordinator::default()),
                offer_key: None,
                remote_ufrags: Arc::new(Mutex::new(HashSet::new())),
                restart_lock: Arc::new(Mutex::new(())),
                _admission_permit: sessions.peer_admission.try_acquire().unwrap(),
                fence: Arc::new(tokio::sync::RwLock::new(())),
            },
        );
        let host_pc = Arc::new(
            APIBuilder::new()
                .build()
                .new_peer_connection(RTCConfiguration::default())
                .await
                .unwrap(),
        );
        sessions.host_peers.lock().await.insert(
            "trust-reload-stale-host".to_owned(),
            HostRtcPeer {
                pc: host_pc,
                binding: HostRtcBinding {
                    host_id: Uuid::new_v4(),
                    binding_nonce: "0".repeat(32),
                    binding_generation: 1,
                    protocol: HOST_CONTROL_LABEL.to_owned(),
                    protocol_version: RTC_PROTOCOL_VERSION,
                },
                _admission_permit: sessions.peer_admission.try_acquire().unwrap(),
            },
        );
        let cleanup_gate = sessions
            .stall_effect(signal_id, TestEffectPoint::CloseAllSnapshot)
            .await;
        let invalidating = sessions.clone();
        let task = tokio::spawn(async move {
            invalidating.invalidate_trust_and_close_all().await;
        });
        wait_effect_gate(&cleanup_gate).await;

        assert!(
            !active.load(Ordering::Acquire),
            "stale callback authorization survived until slow cleanup"
        );
        assert!(
            sessions.host_peers.lock().await.is_empty(),
            "stale host peer remained admitted until slow session cleanup"
        );
        cleanup_gate.release.notify_one();
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("trust cleanup timeout")
            .unwrap();
        assert_eq!(sessions.resident_session_count().await, 0);
    }

    async fn receive_host_control(
        messages: &mut mpsc::Receiver<(usize, String)>,
    ) -> (usize, Value) {
        let (index, encoded) = tokio::time::timeout(Duration::from_secs(10), messages.recv())
            .await
            .expect("host control response timed out")
            .expect("host control channel closed before response");
        (index, serde_json::from_str(&encoded).unwrap())
    }

    async fn request_host_control(
        channel: &RTCDataChannel,
        messages: &mut mpsc::Receiver<(usize, String)>,
        request_id: &str,
        operation: &str,
        payload: Value,
    ) -> Value {
        channel
            .send_text(
                json!({
                    "version": RTC_PROTOCOL_VERSION,
                    "type": "request",
                    "request_id": request_id,
                    "operation": operation,
                    "payload": payload,
                })
                .to_string(),
            )
            .await
            .unwrap();
        receive_host_control(messages).await.1
    }

    async fn start_paired_host_endpoint_with_init(
        files: Arc<HostFileService>,
        binding: HostRtcBinding,
        signal_id: &str,
        init: Option<webrtc::data_channel::data_channel_init::RTCDataChannelInit>,
    ) -> (
        Arc<RTCPeerConnection>,
        Arc<RTCPeerConnection>,
        Arc<RTCDataChannel>,
        mpsc::Receiver<(usize, String)>,
        mpsc::Receiver<WsOutbound>,
    ) {
        let mut media_engine = MediaEngine::default();
        media_engine.register_default_codecs().unwrap();
        let api = APIBuilder::new().with_media_engine(media_engine).build();
        let browser_pc = Arc::new(
            api.new_peer_connection(RTCConfiguration::default())
                .await
                .unwrap(),
        );
        let daemon_pc = Arc::new(
            api.new_peer_connection(RTCConfiguration::default())
                .await
                .unwrap(),
        );
        let channel = browser_pc
            .create_data_channel(HOST_CONTROL_LABEL, init)
            .await
            .unwrap();
        let (messages_tx, messages_rx) = mpsc::channel::<(usize, String)>(64);
        channel.on_message(Box::new(move |message: DataChannelMessage| {
            let messages_tx = messages_tx.clone();
            Box::pin(async move {
                let _ = messages_tx
                    .send((0, String::from_utf8_lossy(&message.data).into_owned()))
                    .await;
            })
        }));
        let (out_tx, out_rx) = mpsc::channel(4);
        let signaling = RtcWsSender::default();
        signaling.install(out_tx);
        install_host_data_channel_handler(
            &daemon_pc,
            signal_id.to_string(),
            binding,
            signaling,
            Some(files),
        );

        let offer = browser_pc.create_offer(None).await.unwrap();
        let mut offer_gathered = browser_pc.gathering_complete_promise().await;
        browser_pc.set_local_description(offer).await.unwrap();
        let _ = offer_gathered.recv().await;
        daemon_pc
            .set_remote_description(browser_pc.local_description().await.unwrap())
            .await
            .unwrap();
        let answer = daemon_pc.create_answer(None).await.unwrap();
        let mut answer_gathered = daemon_pc.gathering_complete_promise().await;
        daemon_pc.set_local_description(answer).await.unwrap();
        let _ = answer_gathered.recv().await;
        browser_pc
            .set_remote_description(daemon_pc.local_description().await.unwrap())
            .await
            .unwrap();
        (browser_pc, daemon_pc, channel, messages_rx, out_rx)
    }

    async fn start_paired_host_endpoint(
        files: Arc<HostFileService>,
        binding: HostRtcBinding,
        signal_id: &str,
    ) -> (
        Arc<RTCPeerConnection>,
        Arc<RTCPeerConnection>,
        Arc<RTCDataChannel>,
        mpsc::Receiver<(usize, String)>,
        mpsc::Receiver<WsOutbound>,
    ) {
        start_paired_host_endpoint_with_init(files, binding, signal_id, None).await
    }

    async fn paired_host_endpoint(
        files: Arc<HostFileService>,
        binding: HostRtcBinding,
        signal_id: &str,
    ) -> (
        Arc<RTCPeerConnection>,
        Arc<RTCPeerConnection>,
        Arc<RTCDataChannel>,
        mpsc::Receiver<(usize, String)>,
    ) {
        let (browser_pc, daemon_pc, channel, mut messages_rx, _out_rx) =
            start_paired_host_endpoint(files, binding, signal_id).await;
        let (_, hello) = receive_host_control(&mut messages_rx).await;
        assert_eq!(hello["type"], "hello");
        (browser_pc, daemon_pc, channel, messages_rx)
    }

    async fn wait_for_host_channel_close(channel: &RTCDataChannel) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while channel.ready_state()
                != webrtc::data_channel::data_channel_state::RTCDataChannelState::Closed
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("host control channel did not fail closed");
    }

    fn insert_test_worker(
        registry: &SessionRegistry,
        session_id: Uuid,
    ) -> (SessionBinding, mpsc::Receiver<crate::pty::WorkerCmd>) {
        insert_test_worker_at(registry, session_id, Path::new("/"))
    }

    fn insert_test_worker_at(
        registry: &SessionRegistry,
        session_id: Uuid,
        cwd: &Path,
    ) -> (SessionBinding, mpsc::Receiver<crate::pty::WorkerCmd>) {
        let (cmd_tx, cmd_rx) = mpsc::channel(crate::pty::WORKER_COMMAND_QUEUE_DEPTH);
        let (outbox_tx, _outbox_rx) = mpsc::channel(crate::pty::WORKER_OUTPUT_QUEUE_DEPTH);
        let handle = crate::pty::SessionHandle::new_worker(crate::pty::WorkerHandleParts {
            session_id,
            cwd: cwd.to_string_lossy().into_owned(),
            cmd_tx,
            lifecycle: crate::pty::SessionLifecycle::new(
                std::path::PathBuf::from("/nonexistent/spawn-test-lifecycle.sock"),
                Uuid::new_v4(),
            ),
            alive: Arc::new(AtomicBool::new(true)),
            cols: 80,
            rows: 24,
            outbox_tx,
            control: crate::pty::ForwarderControl::new(),
        });
        registry.insert(handle);
        (
            registry.binding_for(session_id).expect("worker binding"),
            cmd_rx,
        )
    }

    struct RtcTestClient {
        pc: Arc<RTCPeerConnection>,
        pty: Arc<RTCDataChannel>,
        ctl: Arc<RTCDataChannel>,
        pty_messages: mpsc::Receiver<Vec<u8>>,
        ctl_messages: mpsc::Receiver<(bool, Vec<u8>)>,
        upload_capability: Option<Uuid>,
        agent_generation: Option<u64>,
    }

    struct UploadCleanupPauseGuard {
        uploads: crate::upload::UploadHub,
        armed: bool,
    }

    impl UploadCleanupPauseGuard {
        fn arm(uploads: crate::upload::UploadHub) -> Self {
            uploads.arm_cleanup_pause_for_test();
            Self {
                uploads,
                armed: true,
            }
        }

        fn release(&mut self) {
            if self.armed {
                self.uploads.release_cleanup_pause_for_test();
                self.armed = false;
            }
        }
    }

    impl Drop for UploadCleanupPauseGuard {
        fn drop(&mut self) {
            self.release();
        }
    }

    #[derive(Clone, Copy)]
    struct TestSessionChannel {
        label: &'static str,
        ordered: bool,
        max_packet_life_time: Option<u16>,
        max_retransmits: Option<u16>,
        close_on_open: bool,
    }

    impl TestSessionChannel {
        const fn ordered(label: &'static str) -> Self {
            Self {
                label,
                ordered: true,
                max_packet_life_time: None,
                max_retransmits: None,
                close_on_open: false,
            }
        }
    }

    #[derive(Clone, Copy)]
    enum PartialPeerProbe {
        PtyInput,
        ControlRequests,
    }

    async fn close_test_peer(pc: &Arc<RTCPeerConnection>) {
        if let Err(error) = pc.close().await {
            // The server peer is closed first in these cleanup paths.  The
            // webrtc crate can race the corresponding SCTP shutdown and report
            // this specific reset error even though the remote close already
            // completed successfully.
            assert!(
                error
                    .to_string()
                    .contains("sending reset packet in non-Established state"),
                "closing RTC test peer failed: {error}"
            );
        }
    }

    async fn connect_rtc_session_inner(
        sessions: &RtcSessions,
        registry: &SessionRegistry,
        session_id: Uuid,
        signal_id: &str,
        generation: &str,
        await_ready: bool,
    ) -> RtcTestClient {
        let mut media_engine = MediaEngine::default();
        media_engine.register_default_codecs().unwrap();
        let api = APIBuilder::new().with_media_engine(media_engine).build();
        let pc = Arc::new(
            api.new_peer_connection(RTCConfiguration::default())
                .await
                .unwrap(),
        );
        let pty = pc
            .create_data_channel(PTY_DATA_CHANNEL_LABEL, None)
            .await
            .unwrap();
        let ctl = pc
            .create_data_channel(CONTROL_DATA_CHANNEL_LABEL, None)
            .await
            .unwrap();
        let (open_tx, mut open_rx) = mpsc::channel::<&'static str>(2);
        let pty_open_tx = open_tx.clone();
        pty.on_open(Box::new(move || {
            let open_tx = pty_open_tx.clone();
            Box::pin(async move {
                let _ = open_tx.send(PTY_DATA_CHANNEL_LABEL).await;
            })
        }));
        ctl.on_open(Box::new(move || {
            let open_tx = open_tx.clone();
            Box::pin(async move {
                let _ = open_tx.send(CONTROL_DATA_CHANNEL_LABEL).await;
            })
        }));
        let (pty_message_tx, pty_messages) = mpsc::channel::<Vec<u8>>(256);
        pty.on_message(Box::new(move |message| {
            let message_tx = pty_message_tx.clone();
            Box::pin(async move {
                let _ = message_tx.send(message.data.to_vec()).await;
            })
        }));
        let (ctl_wire_tx, mut ctl_wire_rx) = mpsc::channel::<(bool, Vec<u8>)>(256);
        ctl.on_message(Box::new(move |message| {
            let message_tx = ctl_wire_tx.clone();
            Box::pin(async move {
                let _ = message_tx
                    .send((message.is_string, message.data.to_vec()))
                    .await;
            })
        }));

        let offer = pc.create_offer(None).await.unwrap();
        let mut gathered = pc.gathering_complete_promise().await;
        pc.set_local_description(offer).await.unwrap();
        let _ = gathered.recv().await;
        let offer_sdp = pc.local_description().await.unwrap().sdp;
        let (out_tx, mut out_rx) = mpsc::channel(64);
        sessions
            .handle_offer(
                RtcSignalBinding::new(signal_id.to_string(), generation.to_string(), session_id),
                offer_sdp,
                Vec::new(),
                None,
                false,
                None,
                registry.clone(),
                out_tx,
                None,
            )
            .await;

        let mut answer_set = false;
        let mut pending_candidates = Vec::new();
        let mut pty_open = false;
        let mut ctl_open = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !pty_open || !ctl_open {
            tokio::select! {
                label = open_rx.recv() => match label.expect("RTC open channel closed") {
                    PTY_DATA_CHANNEL_LABEL => pty_open = true,
                    CONTROL_DATA_CHANNEL_LABEL => ctl_open = true,
                    _ => unreachable!(),
                },
                outbound = out_rx.recv() => {
                    let outbound = outbound.expect("RTC signaling closed");
                    let json = outbound.as_str();
                    let value: serde_json::Value = serde_json::from_str(json).unwrap();
                    match value["type"].as_str() {
                        Some("rtc.answer") => {
                            let sdp = value["sdp"].as_str().expect("answer SDP").to_string();
                            pc.set_remote_description(
                                RTCSessionDescription::answer(sdp).expect("valid answer SDP")
                            ).await.unwrap();
                            answer_set = true;
                            for candidate in pending_candidates.drain(..) {
                                pc.add_ice_candidate(candidate).await.unwrap();
                            }
                        }
                        Some("rtc.candidate") => {
                            let candidate = serde_json::from_value::<RTCIceCandidateInit>(
                                value["candidate"].clone()
                            ).unwrap();
                            if answer_set {
                                pc.add_ice_candidate(candidate).await.unwrap();
                            } else {
                                pending_candidates.push(candidate);
                            }
                        }
                        Some("rtc.status") if value["status"] == "failed" => {
                            panic!("RTC negotiation failed: {value}");
                        }
                        _ => {}
                    }
                },
                _ = tokio::time::sleep_until(deadline) => panic!("RTC channels did not open"),
            }
        }
        assert!(answer_set);
        let mut pending_ctl_messages = Vec::new();
        let mut upload_capability = None;
        let mut ready_agent_generation = None;
        if await_ready {
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    let message = ctl_wire_rx.recv().await.expect("spawn.ctl closed");
                    if !message.0 {
                        pending_ctl_messages.push(message);
                        continue;
                    }
                    let value: serde_json::Value =
                        serde_json::from_slice(&message.1).expect("spawn.ctl readiness JSON");
                    if value["version"] == session_ctl::PROTOCOL_VERSION
                        && value["kind"] == "event"
                        && value["event"] == "ready"
                    {
                        upload_capability = Some(
                            Uuid::parse_str(
                                value["upload_capability"]
                                    .as_str()
                                    .expect("readiness upload capability"),
                            )
                            .expect("valid readiness upload capability"),
                        );
                        ready_agent_generation = Some(
                            value["agent_generation"]
                                .as_u64()
                                .expect("readiness session generation"),
                        );
                        break;
                    }
                    pending_ctl_messages.push(message);
                }
            })
            .await
            .expect("server RTC readiness event timed out");
        }
        let (ctl_message_tx, ctl_messages) = mpsc::channel(256);
        for message in pending_ctl_messages {
            ctl_message_tx
                .send(message)
                .await
                .expect("spawn.ctl readiness backlog receiver");
        }
        tokio::spawn(async move {
            while let Some(message) = ctl_wire_rx.recv().await {
                if ctl_message_tx.send(message).await.is_err() {
                    break;
                }
            }
        });
        // The production WebSocket sender remains alive for the RTC session.
        // Keep draining late candidates/statuses too: dropping this receiver
        // immediately after `ready` would deliberately trigger the new
        // fail-closed signaling-backpressure path in otherwise positive tests.
        tokio::spawn(async move { while out_rx.recv().await.is_some() {} });

        RtcTestClient {
            pc,
            pty,
            ctl,
            pty_messages,
            ctl_messages,
            upload_capability,
            agent_generation: ready_agent_generation,
        }
    }

    async fn connect_rtc_session(
        sessions: &RtcSessions,
        registry: &SessionRegistry,
        session_id: Uuid,
        signal_id: &str,
        generation: &str,
    ) -> RtcTestClient {
        connect_rtc_session_inner(sessions, registry, session_id, signal_id, generation, true).await
    }

    async fn assert_real_session_channels_fail_closed(
        case: &'static str,
        specs: &[TestSessionChannel],
        probe: Option<PartialPeerProbe>,
    ) {
        let session_id = Uuid::new_v4();
        let signal_id = format!("invalid-{case}-{}", Uuid::new_v4());
        let generation = "generation";
        let viewer = viewer_id(&signal_id, generation);
        let registry = SessionRegistry::new();
        let (session, mut worker_commands) = insert_test_worker(&registry, session_id);
        let control = registry
            .control_for_binding(session)
            .expect("worker control");
        let sessions = RtcSessions::new();

        let mut media_engine = MediaEngine::default();
        media_engine.register_default_codecs().unwrap();
        let api = APIBuilder::new().with_media_engine(media_engine).build();
        let pc = Arc::new(
            api.new_peer_connection(RTCConfiguration::default())
                .await
                .unwrap(),
        );
        let mut channels = Vec::new();
        let (probe_tx, mut probe_rx) = mpsc::channel(1);
        let (partial_response_tx, mut partial_response_rx) = mpsc::channel(256);
        for spec in specs {
            let dc = pc
                .create_data_channel(
                    spec.label,
                    Some(
                        webrtc::data_channel::data_channel_init::RTCDataChannelInit {
                            ordered: Some(spec.ordered),
                            max_packet_life_time: spec.max_packet_life_time,
                            max_retransmits: spec.max_retransmits,
                            ..Default::default()
                        },
                    ),
                )
                .await
                .unwrap();
            let open_dc = Arc::clone(&dc);
            let open_probe_tx = probe_tx.clone();
            let channel_probe = match (probe, spec.label) {
                (Some(PartialPeerProbe::PtyInput), PTY_DATA_CHANNEL_LABEL) => {
                    Some(PartialPeerProbe::PtyInput)
                }
                (Some(PartialPeerProbe::ControlRequests), CONTROL_DATA_CHANNEL_LABEL) => {
                    Some(PartialPeerProbe::ControlRequests)
                }
                _ => None,
            };
            let close_on_open = spec.close_on_open;
            dc.on_open(Box::new(move || {
                let dc = Arc::clone(&open_dc);
                let probe_tx = open_probe_tx.clone();
                Box::pin(async move {
                    match channel_probe {
                        Some(PartialPeerProbe::PtyInput) => {
                            // A partial peer may flood its one open channel.
                            // Every frame must be dropped, never queued until
                            // the missing counterpart appears.
                            for _ in 0..128 {
                                dc.send(&Bytes::from_static(b"pre-ready-pty-input"))
                                    .await
                                    .expect("send partial-peer PTY input");
                            }
                            let _ = probe_tx.send(()).await;
                        }
                        Some(PartialPeerProbe::ControlRequests) => {
                            for _ in 0..32 {
                                for (operation, parameters) in [
                                    ("take_control", r#","cols":101,"rows":31"#),
                                    ("resize", r#","cols":102,"rows":32"#),
                                    ("scroll", r#","lines":-2"#),
                                    ("redraw", ""),
                                ] {
                                    dc.send_text(format!(
                                        r#"{{"version":1,"kind":"request","request_id":"{}","operation":"{operation}"{parameters}}}"#,
                                        Uuid::new_v4(),
                                    ))
                                    .await
                                    .expect("send partial-peer control request");
                                }
                            }
                            let _ = probe_tx.send(()).await;
                        }
                        None => {}
                    }
                    if close_on_open {
                        let _ = dc.close().await;
                    }
                })
            }));
            let message_tx = partial_response_tx.clone();
            dc.on_message(Box::new(move |message| {
                let message_tx = message_tx.clone();
                Box::pin(async move {
                    let _ = message_tx
                        .send((message.is_string, message.data.to_vec()))
                        .await;
                })
            }));
            channels.push(dc);
        }
        drop(probe_tx);
        drop(partial_response_tx);

        let offer = pc.create_offer(None).await.unwrap();
        let mut gathered = pc.gathering_complete_promise().await;
        pc.set_local_description(offer).await.unwrap();
        let _ = gathered.recv().await;
        let offer_sdp = pc.local_description().await.unwrap().sdp;
        let (out_tx, mut out_rx) = mpsc::channel(64);
        sessions
            .handle_offer(
                RtcSignalBinding::new(signal_id.clone(), generation.to_string(), session_id),
                offer_sdp,
                Vec::new(),
                None,
                false,
                None,
                // The registry outlives every peer in the daemon. Hold it
                // here too: once a retired peer is really dropped, a moved
                // registry would go with it, closing the worker's command
                // channel and leaving the checks below unable to tell "no
                // frame" from "no worker".
                registry.clone(),
                out_tx,
                None,
            )
            .await;
        assert_eq!(sessions.resident_session_count().await, 1, "{case}");

        let mut answer_set = false;
        let mut pending_candidates = Vec::new();
        let mut probe_checked = probe.is_none();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if sessions.resident_session_count().await == 0 {
                    break;
                }
                tokio::select! {
                    sent = probe_rx.recv(), if !probe_checked => {
                        sent.unwrap_or_else(|| panic!("{case}: partial-peer probe channel closed"));
                        // Give the remote callbacks a sustained scheduling
                        // window. No worker command or display state may be
                        // created anywhere within the missing-channel grace.
                        for _ in 0..20 {
                            assert!(
                                matches!(
                                    worker_commands.try_recv(),
                                    Err(tokio::sync::mpsc::error::TryRecvError::Empty)
                                ),
                                "{case}: pre-ready frame reached the worker"
                            );
                            assert!(
                                matches!(
                                    partial_response_rx.try_recv(),
                                    Err(tokio::sync::mpsc::error::TryRecvError::Empty)
                                ),
                                "{case}: pre-ready frame produced a channel response"
                            );
                            assert!(
                                !sessions.controls.contains_viewer(session_id, &viewer).await,
                                "{case}: pre-ready control frame registered a viewer"
                            );
                            assert!(
                                !sessions.controls.is_owner(session_id, &viewer).await,
                                "{case}: pre-ready control frame changed display ownership"
                            );
                            assert_eq!(
                                sessions.controls.retained_counts().await,
                                (0, 0),
                                "{case}: pre-ready control state was retained"
                            );
                            assert_eq!(
                                control.direct_sink_offset(&viewer).await,
                                None,
                                "{case}: partial peer installed a direct sink"
                            );
                            tokio::time::sleep(Duration::from_millis(10)).await;
                        }
                        assert_eq!(
                            sessions.resident_session_count().await,
                            1,
                            "{case}: partial peer closed before the required-channel timeout"
                        );
                        probe_checked = true;
                    }
                    outbound = out_rx.recv() => {
                        let Some(outbound) = outbound else {
                            tokio::task::yield_now().await;
                            continue;
                        };
                        let value: serde_json::Value =
                            serde_json::from_str(outbound.as_str()).unwrap();
                        match value["type"].as_str() {
                            Some("rtc.answer") => {
                                let sdp = value["sdp"].as_str().expect("answer SDP").to_string();
                                pc.set_remote_description(
                                    RTCSessionDescription::answer(sdp).expect("valid answer SDP")
                                ).await.unwrap();
                                answer_set = true;
                                for candidate in pending_candidates.drain(..) {
                                    pc.add_ice_candidate(candidate).await.unwrap();
                                }
                            }
                            Some("rtc.candidate") => {
                                let candidate = serde_json::from_value::<RTCIceCandidateInit>(
                                    value["candidate"].clone()
                                ).unwrap();
                                if answer_set {
                                    pc.add_ice_candidate(candidate).await.unwrap();
                                } else {
                                    pending_candidates.push(candidate);
                                }
                            }
                            _ => {}
                        }
                    }
                    _ = tokio::time::sleep(Duration::from_millis(10)) => {}
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("{case}: invalid RTC peer remained resident"));

        assert!(probe_checked, "{case}: partial-peer probe never ran");
        if probe.is_some() {
            assert!(
                matches!(
                    worker_commands.try_recv(),
                    Err(tokio::sync::mpsc::error::TryRecvError::Empty)
                ),
                "{case}: partial-peer frame reached the worker during cleanup"
            );
            assert!(
                matches!(
                    partial_response_rx.try_recv(),
                    Err(tokio::sync::mpsc::error::TryRecvError::Empty)
                ),
                "{case}: partial-peer frame produced a response during cleanup"
            );
        }

        assert!(
            !sessions.controls.contains_viewer(session_id, &viewer).await,
            "{case}: invalid RTC viewer remained registered"
        );
        assert_eq!(
            control.direct_sink_offset(&viewer).await,
            None,
            "{case}: invalid RTC direct sink remained registered"
        );
        assert_eq!(
            sessions.controls.retained_counts().await,
            (0, 0),
            "{case}: invalid RTC control state remained retained"
        );
        close_test_peer(&pc).await;
        drop(channels);
    }

    async fn next_ctl_json(messages: &mut mpsc::Receiver<(bool, Vec<u8>)>) -> serde_json::Value {
        loop {
            let (is_string, bytes) = tokio::time::timeout(Duration::from_secs(10), messages.recv())
                .await
                .expect("spawn.ctl message timed out")
                .expect("spawn.ctl closed");
            if is_string {
                return serde_json::from_slice(&bytes).expect("valid spawn.ctl JSON");
            }
        }
    }

    async fn next_ctl_json_for(
        messages: &mut mpsc::Receiver<(bool, Vec<u8>)>,
        request_id: Uuid,
    ) -> serde_json::Value {
        let request_id = request_id.to_string();
        loop {
            let value = next_ctl_json(messages).await;
            if value.get("request_id").and_then(Value::as_str) == Some(request_id.as_str()) {
                return value;
            }
        }
    }

    fn real_upload_hash(bytes: &[u8]) -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    async fn start_real_upload(
        client: &mut RtcTestClient,
        upload_id: Uuid,
        name: &str,
        bytes: &[u8],
    ) -> serde_json::Value {
        let capability = client.upload_capability.expect("RTC upload capability");
        let agent_generation = client.agent_generation.expect("RTC session generation");
        client
            .ctl
            .send_text(
                json!({
                    "version": session_ctl::PROTOCOL_VERSION,
                    "kind": "request",
                    "request_id": upload_id,
                    "operation": "upload_start",
                    "capability": capability,
                    "agent_generation": agent_generation,
                    "name": name,
                    "mime_type": "application/octet-stream",
                    "destination": "cwd",
                    "total_bytes": bytes.len(),
                    "chunks": bytes.len().div_ceil(crate::upload::UPLOAD_CHUNK_BYTES),
                    "sha256": real_upload_hash(bytes),
                })
                .to_string(),
            )
            .await
            .expect("send real RTC upload start");
        next_ctl_json_for(&mut client.ctl_messages, upload_id).await
    }

    fn real_upload_chunk(upload_id: Uuid, sequence: u32, last: bool, bytes: &[u8]) -> Bytes {
        let mut frame = Vec::with_capacity(28 + bytes.len());
        frame.extend_from_slice(b"SPCT");
        frame.push(session_ctl::PROTOCOL_VERSION);
        frame.push(2);
        frame.extend_from_slice(&u16::from(last).to_le_bytes());
        frame.extend_from_slice(upload_id.as_bytes());
        frame.extend_from_slice(&sequence.to_le_bytes());
        frame.extend_from_slice(bytes);
        Bytes::from(frame)
    }

    async fn send_real_upload_chunks(client: &RtcTestClient, upload_id: Uuid, bytes: &[u8]) {
        let chunks = bytes.chunks(crate::upload::UPLOAD_CHUNK_BYTES);
        let chunk_count = chunks.len();
        for (sequence, chunk) in chunks.enumerate() {
            client
                .ctl
                .send(&real_upload_chunk(
                    upload_id,
                    sequence as u32,
                    sequence + 1 == chunk_count,
                    chunk,
                ))
                .await
                .expect("send real RTC upload chunk");
        }
    }

    async fn wait_for_resident_sessions(sessions: &RtcSessions, expected: usize) {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if sessions.resident_session_count().await == expected {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("RTC resident session count did not converge");
    }

    fn built_worker_bin() -> std::path::PathBuf {
        let exe = std::env::current_exe().expect("current_exe");
        exe.parent()
            .and_then(|deps| deps.parent())
            .map(|debug| debug.join(crate::platform::executable_name("spawn-worker")))
            .expect("worker bin path")
    }

    struct WorkerTestEnv {
        old_dir: Option<std::ffi::OsString>,
        old_bin: Option<std::ffi::OsString>,
        _dir: tempfile::TempDir,
    }

    impl WorkerTestEnv {
        fn install() -> Self {
            let old_dir = std::env::var_os("SPAWND_WORKER_DIR");
            let old_bin = std::env::var_os("SPAWND_WORKER_BIN");
            #[cfg(unix)]
            let dir = tempfile::Builder::new()
                .prefix("spawn-rtc-")
                .tempdir_in("/tmp")
                .expect("short worker tempdir");
            #[cfg(windows)]
            let dir = tempfile::tempdir().expect("worker tempdir");
            #[cfg(windows)]
            let worker_dir = {
                // The runner owns its TEMP root policy. Exercise the worker
                // contract with a child carrying the exact owner-only DACL
                // SPAWN D creates rather than weakening validation for the
                // inherited runner directory.
                let worker_dir = dir.path().join("workers");
                crate::platform::create_private_dir_all(&worker_dir)
                    .expect("protected worker tempdir");
                worker_dir
            };
            #[cfg(not(windows))]
            let worker_dir = dir.path();
            std::env::set_var("SPAWND_WORKER_DIR", worker_dir);
            std::env::set_var("SPAWND_WORKER_BIN", built_worker_bin());
            Self {
                old_dir,
                old_bin,
                _dir: dir,
            }
        }

        #[cfg(unix)]
        fn path(&self) -> &std::path::Path {
            self._dir.path()
        }
    }

    impl Drop for WorkerTestEnv {
        fn drop(&mut self) {
            match self.old_dir.take() {
                Some(value) => std::env::set_var("SPAWND_WORKER_DIR", value),
                None => std::env::remove_var("SPAWND_WORKER_DIR"),
            }
            match self.old_bin.take() {
                Some(value) => std::env::set_var("SPAWND_WORKER_BIN", value),
                None => std::env::remove_var("SPAWND_WORKER_BIN"),
            }
        }
    }

    /// Keeps the test worker's supervisor connection alive until an
    /// identity-bound lifecycle KILL has been acknowledged. This makes every
    /// panic path clean up the worker before `WorkerTestEnv` removes its
    /// private endpoint directory.
    const WORKER_TEST_CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);

    struct WorkerCleanupGuard {
        session_id: Uuid,
        lifecycle: Option<crate::pty::SessionLifecycle>,
        supervisor_keepalive: Option<mpsc::Sender<crate::pty::WorkerCmd>>,
    }

    impl WorkerCleanupGuard {
        fn new(session_id: Uuid, handle: &crate::pty::SessionHandle) -> Self {
            Self {
                session_id,
                lifecycle: Some(handle.lifecycle()),
                supervisor_keepalive: Some(handle.worker_connection_keepalive()),
            }
        }

        fn refresh(&mut self, handle: &crate::pty::SessionHandle) {
            self.lifecycle = Some(handle.lifecycle());
            self.supervisor_keepalive = Some(handle.worker_connection_keepalive());
        }

        fn disarm(&mut self) {
            self.lifecycle = None;
            self.supervisor_keepalive = None;
        }
    }

    impl Drop for WorkerCleanupGuard {
        fn drop(&mut self) {
            let Some(lifecycle) = self.lifecycle.take() else {
                return;
            };
            let session_id = self.session_id;
            let cleanup = std::thread::Builder::new()
                .name("rtc-worker-test-cleanup".to_string())
                .spawn(move || {
                    let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                    else {
                        return;
                    };
                    runtime.block_on(async move {
                        let deadline = tokio::time::Instant::now() + WORKER_TEST_CLEANUP_TIMEOUT;
                        let _ = lifecycle
                            .shutdown(spawnd::sessiond::wire::LifecycleSignal::Kill)
                            .await;
                        while crate::worker_backend::socket_exists(session_id)
                            && tokio::time::Instant::now() < deadline
                        {
                            tokio::time::sleep_until(std::cmp::min(
                                deadline,
                                tokio::time::Instant::now() + Duration::from_millis(25),
                            ))
                            .await;
                        }
                    });
                });
            if let Ok(cleanup) = cleanup {
                let _ = cleanup.join();
            }
            self.supervisor_keepalive = None;
        }
    }

    struct TestChildCleanup(std::process::Child);

    impl Drop for TestChildCleanup {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[cfg(unix)]
    fn saturate_test_lifecycle_endpoint(
        dir: &std::path::Path,
        lifecycle_path: &std::path::Path,
    ) -> (
        std::os::unix::net::UnixDatagram,
        std::os::unix::net::UnixDatagram,
        spawnd::sessiond::endpoint::EndpointIdentity,
    ) {
        spawnd::sessiond::endpoint::ensure_private_dir(dir)
            .expect("secure saturated guard lifecycle directory");
        let server = std::os::unix::net::UnixDatagram::bind(lifecycle_path)
            .expect("bind saturated guard lifecycle endpoint");
        let identity = spawnd::sessiond::endpoint::secure_bound_socket(lifecycle_path)
            .expect("secure saturated guard lifecycle endpoint");
        let flood_path = dir.join("guard-flood.sock");
        let flood = std::os::unix::net::UnixDatagram::bind(&flood_path)
            .expect("bind guard lifecycle flood sender");
        flood
            .connect(lifecycle_path)
            .expect("connect guard lifecycle flood sender");
        flood
            .set_nonblocking(true)
            .expect("set guard lifecycle flood sender nonblocking");
        let payload = [0u8; spawnd::sessiond::wire::LIFECYCLE_REQUEST_LEN];
        let mut saturated = false;
        for _ in 0..1024 {
            match flood.send(&payload) {
                Ok(size) => assert_eq!(size, payload.len()),
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        || error.raw_os_error() == Some(nix::libc::ENOBUFS) =>
                {
                    saturated = true;
                    break;
                }
                Err(error) => panic!("saturating guard lifecycle endpoint failed: {error}"),
            }
        }
        assert!(
            saturated,
            "guard lifecycle endpoint did not become nonwritable"
        );
        (server, flood, identity)
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn worker_cleanup_guard_drop_is_bounded_on_a_nonwritable_endpoint() {
        let _env_lock = crate::worker_backend::WORKER_TEST_ENV_LOCK.lock().await;
        let env = WorkerTestEnv::install();
        let session_id = Uuid::new_v4();
        spawnd::sessiond::endpoint::ensure_private_dir(env.path())
            .expect("secure guard test worker directory");
        let ordinary_path = env.path().join(format!("{session_id}.sock"));
        let ordinary = std::os::unix::net::UnixDatagram::bind(&ordinary_path)
            .expect("bind persistent fake worker endpoint");
        let ordinary_identity = spawnd::sessiond::endpoint::secure_bound_socket(&ordinary_path)
            .expect("secure persistent fake worker endpoint");
        let lifecycle_path = ordinary_path.with_extension("lifecycle.sock");
        let (_lifecycle, _flood, _lifecycle_identity) =
            saturate_test_lifecycle_endpoint(env.path(), &lifecycle_path);
        let mut unrelated = TestChildCleanup(
            std::process::Command::new("sleep")
                .arg("30")
                .spawn()
                .expect("spawn guard sentinel process"),
        );
        let (cmd_tx, _cmd_rx) = mpsc::channel(crate::pty::WORKER_COMMAND_QUEUE_DEPTH);
        let (outbox_tx, _outbox_rx) = mpsc::channel(crate::pty::WORKER_OUTPUT_QUEUE_DEPTH);
        let handle = crate::pty::SessionHandle::new_worker(crate::pty::WorkerHandleParts {
            session_id,
            cwd: "/".into(),
            cmd_tx,
            lifecycle: crate::pty::SessionLifecycle::new(lifecycle_path, Uuid::new_v4()),
            alive: Arc::new(AtomicBool::new(true)),
            cols: 80,
            rows: 24,
            outbox_tx,
            control: crate::pty::ForwarderControl::new(),
        });
        let guard = WorkerCleanupGuard::new(session_id, &handle);
        drop(handle);

        let started = std::time::Instant::now();
        drop(guard);
        assert!(
            started.elapsed() <= WORKER_TEST_CLEANUP_TIMEOUT + Duration::from_millis(500),
            "worker cleanup guard exceeded its advertised bound"
        );
        assert!(
            crate::worker_backend::socket_exists(session_id),
            "test did not retain the deliberately stuck worker endpoint"
        );
        assert!(
            unrelated.0.try_wait().unwrap().is_none(),
            "worker cleanup guard touched an unrelated process"
        );
        drop(ordinary_identity);
        drop(ordinary);
    }

    #[cfg(windows)]
    async fn open_silent_lifecycle_client(
        name: &std::ffi::OsStr,
    ) -> tokio::net::windows::named_pipe::NamedPipeClient {
        use tokio::net::windows::named_pipe::{ClientOptions, PipeMode};
        use windows_sys::Win32::Foundation::ERROR_PIPE_BUSY;

        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            match ClientOptions::new().pipe_mode(PipeMode::Message).open(name) {
                Ok(client) => return client,
                Err(error)
                    if (error.kind() == std::io::ErrorKind::NotFound
                        || error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32))
                        && tokio::time::Instant::now() < deadline =>
                {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Err(error) => panic!("opening silent lifecycle client failed: {error}"),
            }
        }
    }

    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn worker_cleanup_guard_drop_is_bounded_when_all_pipe_handlers_are_silent() {
        struct EnvRestore(Option<std::ffi::OsString>);
        impl Drop for EnvRestore {
            fn drop(&mut self) {
                match self.0.take() {
                    Some(value) => std::env::set_var("SPAWND_WORKER_DIR", value),
                    None => std::env::remove_var("SPAWND_WORKER_DIR"),
                }
            }
        }

        let _env_lock = crate::worker_backend::WORKER_TEST_ENV_LOCK.lock().await;
        let temp = tempfile::tempdir().expect("guard pipe tempdir");
        let dir = temp.path().join("workers");
        spawnd::sessiond::endpoint::ensure_private_dir(&dir).expect("secure guard pipe directory");
        let _env = EnvRestore(std::env::var_os("SPAWND_WORKER_DIR"));
        std::env::set_var("SPAWND_WORKER_DIR", &dir);

        let session_id = Uuid::new_v4();
        let endpoint = spawnd::sessiond::endpoint::endpoint_for(
            &dir,
            &spawnd::sessiond::endpoint::config_root_tag(),
            session_id,
        )
        .expect("guard endpoint");
        let reservation = match spawnd::sessiond::endpoint::try_reserve(&endpoint).unwrap() {
            spawnd::sessiond::endpoint::LockAttempt::Acquired(reservation) => reservation,
            spawnd::sessiond::endpoint::LockAttempt::Busy => {
                panic!("new guard endpoint reservation was busy")
            }
        };
        let spawnd::sessiond::endpoint::BoundWorkerEndpoints {
            main: _main,
            lifecycle: _lifecycle,
            identity: _identity,
        } = spawnd::sessiond::endpoint::bind_worker(&endpoint, &reservation, Uuid::new_v4())
            .expect("bind guard pipe endpoints");
        let mut silent = Vec::new();
        for _ in 0..7 {
            silent.push(open_silent_lifecycle_client(endpoint.lifecycle_arg()).await);
            tokio::task::yield_now().await;
        }

        let comspec = std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into());
        let mut unrelated = TestChildCleanup(
            std::process::Command::new(comspec)
                .args(["/d", "/c", "ping -n 30 127.0.0.1 >NUL"])
                .spawn()
                .expect("spawn guard sentinel process"),
        );
        let (cmd_tx, _cmd_rx) = mpsc::channel(crate::pty::WORKER_COMMAND_QUEUE_DEPTH);
        let (outbox_tx, _outbox_rx) = mpsc::channel(crate::pty::WORKER_OUTPUT_QUEUE_DEPTH);
        let handle = crate::pty::SessionHandle::new_worker(crate::pty::WorkerHandleParts {
            session_id,
            cwd: "C:\\".into(),
            cmd_tx,
            lifecycle: crate::pty::SessionLifecycle::new(endpoint.clone(), Uuid::new_v4()),
            alive: Arc::new(AtomicBool::new(true)),
            cols: 80,
            rows: 24,
            outbox_tx,
            control: crate::pty::ForwarderControl::new(),
        });
        let guard = WorkerCleanupGuard::new(session_id, &handle);
        drop(handle);

        let started = std::time::Instant::now();
        drop(guard);
        assert!(
            started.elapsed() <= WORKER_TEST_CLEANUP_TIMEOUT + Duration::from_millis(500),
            "worker cleanup guard exceeded its advertised bound"
        );
        assert!(
            spawnd::sessiond::endpoint::endpoint_exists(&endpoint),
            "test did not retain the deliberately stuck worker endpoint"
        );
        assert!(
            unrelated.0.try_wait().unwrap().is_none(),
            "worker cleanup guard touched an unrelated process"
        );
        drop(silent);
    }

    async fn request_history(client: &mut RtcTestClient) -> Vec<u8> {
        let request_id = Uuid::new_v4();
        let request_id_text = request_id.to_string();
        client
            .ctl
            .send_text(format!(
                r#"{{"version":1,"kind":"request","request_id":"{request_id}","operation":"history","lines":10000,"plain":false}}"#
            ))
            .await
            .expect("history request");

        tokio::time::timeout(Duration::from_secs(20), async {
            let mut expected_chunks = None;
            let mut expected_bytes = None;
            let mut chunks = std::collections::BTreeMap::<u32, Vec<u8>>::new();
            loop {
                let (is_string, bytes) = client
                    .ctl_messages
                    .recv()
                    .await
                    .expect("spawn.ctl closed during history");
                if is_string {
                    let value: serde_json::Value =
                        serde_json::from_slice(&bytes).expect("history metadata JSON");
                    if value.get("request_id").and_then(|id| id.as_str())
                        == Some(request_id_text.as_str())
                    {
                        assert_eq!(value["ok"], true, "history failed: {value}");
                        expected_chunks =
                            Some(value["chunks"].as_u64().expect("history chunk count") as usize);
                        expected_bytes = Some(
                            value["total_bytes"].as_u64().expect("history byte count") as usize,
                        );
                    }
                } else if bytes.len() >= 28
                    && &bytes[..4] == b"SPCT"
                    && bytes.get(8..24) == Some(request_id.as_bytes())
                {
                    let sequence = u32::from_le_bytes(bytes[24..28].try_into().unwrap());
                    chunks.insert(sequence, bytes[28..].to_vec());
                }

                if expected_chunks.is_some_and(|count| chunks.len() == count) {
                    let mut replay = Vec::new();
                    for (sequence, chunk) in chunks {
                        assert_eq!(
                            sequence as usize,
                            replay.len() / session_ctl::CHUNK_PAYLOAD_BYTES
                        );
                        replay.extend_from_slice(&chunk);
                    }
                    assert_eq!(Some(replay.len()), expected_bytes);
                    return replay;
                }
            }
        })
        .await
        .expect("history response timed out")
    }

    async fn collect_pty_until(messages: &mut mpsc::Receiver<Vec<u8>>, needle: &[u8]) -> Vec<u8> {
        tokio::time::timeout(Duration::from_secs(30), async {
            let mut output = Vec::new();
            loop {
                let chunk = messages.recv().await.expect("spawn.pty closed");
                output.extend_from_slice(&chunk);
                if output.windows(needle.len()).any(|window| window == needle) {
                    return output;
                }
            }
        })
        .await
        .unwrap_or_else(|_| {
            panic!(
                "timed out waiting for PTY output {:?}",
                String::from_utf8_lossy(needle)
            )
        })
    }

    #[tokio::test]
    async fn real_session_channel_gate_rejects_every_invalid_shape_without_residents() {
        let missing_pty = [TestSessionChannel::ordered(CONTROL_DATA_CHANNEL_LABEL)];
        let missing_ctl = [TestSessionChannel::ordered(PTY_DATA_CHANNEL_LABEL)];
        let duplicate_pty = [
            TestSessionChannel::ordered(PTY_DATA_CHANNEL_LABEL),
            TestSessionChannel::ordered(PTY_DATA_CHANNEL_LABEL),
            TestSessionChannel::ordered(CONTROL_DATA_CHANNEL_LABEL),
        ];
        let duplicate_ctl = [
            TestSessionChannel::ordered(PTY_DATA_CHANNEL_LABEL),
            TestSessionChannel::ordered(CONTROL_DATA_CHANNEL_LABEL),
            TestSessionChannel::ordered(CONTROL_DATA_CHANNEL_LABEL),
        ];
        let unknown = [
            TestSessionChannel::ordered(PTY_DATA_CHANNEL_LABEL),
            TestSessionChannel::ordered("spawn.unknown"),
            TestSessionChannel::ordered(CONTROL_DATA_CHANNEL_LABEL),
        ];
        let early_close = [
            TestSessionChannel {
                close_on_open: true,
                ..TestSessionChannel::ordered(PTY_DATA_CHANNEL_LABEL)
            },
            TestSessionChannel::ordered(CONTROL_DATA_CHANNEL_LABEL),
        ];
        let unordered_pty = [
            TestSessionChannel {
                ordered: false,
                ..TestSessionChannel::ordered(PTY_DATA_CHANNEL_LABEL)
            },
            TestSessionChannel::ordered(CONTROL_DATA_CHANNEL_LABEL),
        ];
        let unordered_ctl = [
            TestSessionChannel::ordered(PTY_DATA_CHANNEL_LABEL),
            TestSessionChannel {
                ordered: false,
                ..TestSessionChannel::ordered(CONTROL_DATA_CHANNEL_LABEL)
            },
        ];
        let lifetime_pty = [
            TestSessionChannel {
                max_packet_life_time: Some(1),
                ..TestSessionChannel::ordered(PTY_DATA_CHANNEL_LABEL)
            },
            TestSessionChannel::ordered(CONTROL_DATA_CHANNEL_LABEL),
        ];
        let lifetime_ctl = [
            TestSessionChannel::ordered(PTY_DATA_CHANNEL_LABEL),
            TestSessionChannel {
                max_packet_life_time: Some(1),
                ..TestSessionChannel::ordered(CONTROL_DATA_CHANNEL_LABEL)
            },
        ];
        let retransmits_pty = [
            TestSessionChannel {
                max_retransmits: Some(1),
                ..TestSessionChannel::ordered(PTY_DATA_CHANNEL_LABEL)
            },
            TestSessionChannel::ordered(CONTROL_DATA_CHANNEL_LABEL),
        ];
        let retransmits_ctl = [
            TestSessionChannel::ordered(PTY_DATA_CHANNEL_LABEL),
            TestSessionChannel {
                max_retransmits: Some(1),
                ..TestSessionChannel::ordered(CONTROL_DATA_CHANNEL_LABEL)
            },
        ];

        tokio::join!(
            assert_real_session_channels_fail_closed(
                "missing-pty",
                &missing_pty,
                Some(PartialPeerProbe::ControlRequests),
            ),
            assert_real_session_channels_fail_closed(
                "missing-ctl",
                &missing_ctl,
                Some(PartialPeerProbe::PtyInput),
            ),
            assert_real_session_channels_fail_closed("duplicate-pty", &duplicate_pty, None),
            assert_real_session_channels_fail_closed("duplicate-ctl", &duplicate_ctl, None),
            assert_real_session_channels_fail_closed("unknown", &unknown, None),
            assert_real_session_channels_fail_closed("early-close", &early_close, None),
            assert_real_session_channels_fail_closed("unordered-pty", &unordered_pty, None),
            assert_real_session_channels_fail_closed("unordered-ctl", &unordered_ctl, None),
            assert_real_session_channels_fail_closed("lifetime-pty", &lifetime_pty, None),
            assert_real_session_channels_fail_closed("lifetime-ctl", &lifetime_ctl, None),
            assert_real_session_channels_fail_closed("retransmits-pty", &retransmits_pty, None),
            assert_real_session_channels_fail_closed("retransmits-ctl", &retransmits_ctl, None),
        );
    }

    async fn wait_effect_gate(gate: &TestEffectGate) {
        tokio::time::timeout(Duration::from_secs(10), gate.entered.notified())
            .await
            .expect("effect gate was not reached");
    }

    async fn wait_peer_stopped(sessions: &RtcSessions, signal_id: &str) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let stopped = sessions
                    .peers
                    .lock()
                    .await
                    .get(signal_id)
                    .is_none_or(|peer| peer.channels.failed.load(Ordering::SeqCst));
                if stopped {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("peer lifecycle did not stop");
    }

    async fn wait_peer_cleanup(
        sessions: &RtcSessions,
        control: &crate::pty::ForwarderControl,
        session_id: Uuid,
        viewer: &str,
    ) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if sessions.resident_session_count().await == 0
                    && !sessions.controls.contains_viewer(session_id, viewer).await
                    && control.direct_sink_offset(viewer).await.is_none()
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("peer effect cleanup timed out");
    }

    async fn insert_synthetic_peer(
        sessions: &RtcSessions,
        signal_id: &str,
        generation: &str,
        session: SessionBinding,
        control: ForwarderControl,
    ) -> (
        Arc<RTCPeerConnection>,
        Arc<PeerCloseCoordinator>,
        Arc<tokio::sync::RwLock<()>>,
    ) {
        let api = APIBuilder::new().build();
        let pc = Arc::new(
            api.new_peer_connection(RTCConfiguration::default())
                .await
                .unwrap(),
        );
        let close = Arc::new(PeerCloseCoordinator::default());
        let fence = Arc::new(tokio::sync::RwLock::new(()));
        let admission_permit = sessions
            .peer_admission
            .try_acquire()
            .expect("synthetic peer admission");
        sessions.peers.lock().await.insert(
            signal_id.to_string(),
            RtcPeer {
                pc: Arc::clone(&pc),
                session,
                generation: generation.to_string(),
                active: Arc::new(AtomicBool::new(true)),
                control,
                channels: Arc::new(RequiredSessionChannels::default()),
                close: Arc::clone(&close),
                offer_key: None,
                remote_ufrags: Arc::new(Mutex::new(HashSet::new())),
                restart_lock: Arc::new(Mutex::new(())),
                _admission_permit: admission_permit,
                fence: Arc::clone(&fence),
            },
        );
        (pc, close, fence)
    }

    #[tokio::test(start_paused = true)]
    async fn first_close_deadline_bounds_delayed_sender_state_and_duplicate_callers() {
        let registry = SessionRegistry::new();
        let session_id = Uuid::new_v4();
        let (session, _commands) = insert_test_worker(&registry, session_id);
        let control = registry.control_for_binding(session).unwrap();
        let sessions = RtcSessions::new();
        let signal_id = "first-close-deadline";
        let generation = "generation";
        let (pc, close, fence) =
            insert_synthetic_peer(&sessions, signal_id, generation, session, control).await;
        let blocked_effect = fence.read().await;

        let initiated_at = tokio::time::Instant::now();
        // This is the same synchronous entry point used by invalid channels,
        // sender shutdown, and peer-state callbacks.
        sessions.schedule_close_if_same(signal_id, generation, &pc, &close);
        assert_eq!(
            close.initiated_deadline(),
            Some(initiated_at + Duration::from_millis(100))
        );
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }

        tokio::time::advance(Duration::from_millis(70)).await;
        let duplicate_sessions = sessions.clone();
        let duplicate = tokio::spawn(async move {
            duplicate_sessions
                .close(signal_id, generation, session_id)
                .await;
        });
        // Model delayed sender-close and peer-state notifications. Neither is
        // allowed to replace the first event's deadline while waiting for the
        // per-session closer.
        sessions.schedule_close_if_same(signal_id, generation, &pc, &close);
        sessions.schedule_close_if_same(signal_id, generation, &pc, &close);
        assert_eq!(
            close.initiated_deadline(),
            Some(initiated_at + Duration::from_millis(100))
        );

        tokio::time::advance(Duration::from_millis(31)).await;
        for _ in 0..16 {
            tokio::task::yield_now().await;
        }
        assert!(
            duplicate.is_finished(),
            "duplicate close received a fresh teardown budget"
        );
        duplicate.await.unwrap();
        assert!(!sessions.peers.lock().await.contains_key(signal_id));
        assert_eq!(
            close.initiated_deadline(),
            Some(initiated_at + Duration::from_millis(100))
        );

        drop(blocked_effect);
        for _ in 0..32 {
            if sessions.peer_cleanup_task_count().await == 0 {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(sessions.peer_cleanup_task_count().await, 0);
        assert!(sessions.closing_peers.lock().await.is_empty());
        assert_eq!(sessions.peer_admission.charged(), 0);
    }

    #[tokio::test]
    async fn real_sender_exit_starts_one_deadline_before_stalled_data_channel_close() {
        for channel in [SessionChannel::Pty, SessionChannel::Control] {
            let registry = SessionRegistry::new();
            let session_id = Uuid::new_v4();
            let (session, mut commands) = insert_test_worker(&registry, session_id);
            let control = registry.control_for_binding(session).unwrap();
            let worker_control = control.clone();
            let worker = tokio::spawn(async move {
                while let Some(command) = commands.recv().await {
                    if let crate::pty::WorkerCmd::Replay { resp, .. } = command {
                        let _ = resp.send(Ok(crate::pty::WorkerReplay::new(
                            worker_control.source_offset(),
                            Vec::new(),
                        )));
                    }
                }
            });
            let sessions = RtcSessions::new();
            let signal_id = format!("real-sender-close-{channel:?}-{}", Uuid::new_v4());
            let generation = "generation";
            let viewer = viewer_id(&signal_id, generation);
            let gate = sessions.stall_sender_close(&signal_id, channel).await;
            let client =
                connect_rtc_session(&sessions, &registry, session_id, &signal_id, generation).await;
            let close = {
                let peers = sessions.peers.lock().await;
                Arc::clone(&peers.get(&signal_id).expect("active real peer").close)
            };
            assert_eq!(
                close.initiated_deadline(),
                None,
                "installing real DataChannel handlers started the close deadline"
            );
            tokio::time::timeout(Duration::from_secs(10), async {
                while control.direct_sink_offset(&viewer).await.is_none() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("PTY output sender was not installed");
            let fence = {
                let peers = sessions.peers.lock().await;
                Arc::clone(&peers.get(&signal_id).expect("active real peer").fence)
            };
            let blocked_effect = fence.read_owned().await;

            gate.exit.notify_one();
            tokio::time::timeout(Duration::from_secs(10), gate.entered.notified())
                .await
                .expect("actual sender did not reach stalled DataChannel close");
            let sender_failed_at = *gate
                .failure_at
                .get()
                .expect("actual sender failure instant");
            let first_deadline = *gate.deadline.get().expect("actual sender deadline");
            assert!(
                first_deadline <= sender_failed_at + Duration::from_millis(105),
                "actual sender received more than the one teardown budget"
            );

            tokio::time::sleep_until(first_deadline - Duration::from_millis(40)).await;
            let duplicate_sessions = sessions.clone();
            let duplicate_session_id = signal_id.clone();
            let duplicate = tokio::spawn(async move {
                duplicate_sessions
                    .close(&duplicate_session_id, generation, session_id)
                    .await;
            });
            let remote_pc = Arc::clone(&client.pc);
            let remote_close = tokio::spawn(async move {
                let _ = tokio::time::timeout(Duration::from_millis(200), remote_pc.close()).await;
            });

            tokio::time::timeout_at(first_deadline + Duration::from_millis(100), duplicate)
                .await
                .expect("duplicate close received a fresh sender teardown budget")
                .expect("duplicate close task");
            assert_eq!(
                gate.deadline.get().copied(),
                Some(first_deadline),
                "peer state/on-close or duplicate close replaced the sender deadline"
            );
            assert!(
                !sessions.peers.lock().await.contains_key(&signal_id),
                "peer map outlived the sender deadline"
            );

            gate.release.notify_one();
            drop(blocked_effect);
            remote_close.await.expect("remote close task");
            wait_peer_cleanup(&sessions, &control, session_id, &viewer).await;
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    if sessions.closing_peers.lock().await.is_empty()
                        && sessions.peer_cleanup_task_count().await == 0
                    {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("tracked sender cleanup did not settle");
            assert!(sessions.closing_peers.lock().await.is_empty());
            assert_eq!(sessions.peer_cleanup_task_count().await, 0);
            assert_eq!(sessions.peer_admission.charged(), 0);
            worker.abort();
        }
    }

    #[tokio::test(start_paused = true)]
    async fn stalled_peer_cleanup_retains_the_global_admission_slot_until_settlement() {
        let registry = SessionRegistry::new();
        let session_id = Uuid::new_v4();
        let (session, _commands) = insert_test_worker(&registry, session_id);
        let control = registry.control_for_binding(session).unwrap();
        let sessions = RtcSessions::new();
        let signal_id = "stalled-admission";
        let generation = "generation";
        let (pc, close, fence) =
            insert_synthetic_peer(&sessions, signal_id, generation, session, control).await;
        let blocked_effect = fence.read().await;

        sessions.schedule_close_if_same(signal_id, generation, &pc, &close);
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        tokio::time::advance(Duration::from_millis(101)).await;
        for _ in 0..16 {
            tokio::task::yield_now().await;
        }
        assert!(!sessions.peers.lock().await.contains_key(signal_id));
        assert_eq!(sessions.closing_peers.lock().await.len(), 1);
        assert_eq!(sessions.peer_admission.charged(), 1);

        let mut replacement_permits = Vec::new();
        while let Some(permit) = sessions.peer_admission.try_acquire() {
            replacement_permits.push(permit);
        }
        assert_eq!(replacement_permits.len(), MAX_RTC_PEERS - 1);
        for _ in 0..(MAX_RTC_PEERS * 2) {
            assert!(
                sessions.peer_admission.try_acquire().is_none(),
                "stalled invalid/replacement churn exceeded the RTC peer cap"
            );
        }
        assert_eq!(sessions.peer_admission.charged(), MAX_RTC_PEERS);

        drop(blocked_effect);
        for _ in 0..32 {
            if sessions.peer_cleanup_task_count().await == 0 {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(sessions.peer_cleanup_task_count().await, 0);
        assert!(sessions.closing_peers.lock().await.is_empty());
        // Replacement peers still own every other slot; the closing peer's
        // slot is the single permit released by actual cleanup completion.
        assert_eq!(sessions.peer_admission.charged(), MAX_RTC_PEERS - 1);
        drop(replacement_permits);
        assert_eq!(sessions.peer_admission.charged(), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn admitted_input_and_control_abort_when_counterpart_closes() {
        let session_id = Uuid::new_v4();
        let registry = SessionRegistry::new();
        let (session, mut worker_commands) = insert_test_worker(&registry, session_id);
        let control = registry
            .control_for_binding(session)
            .expect("worker control");
        let worker_control = control.clone();
        let (observed_tx, mut observed_rx) = mpsc::unbounded_channel();
        let worker = tokio::spawn(async move {
            while let Some(command) = worker_commands.recv().await {
                match command {
                    crate::pty::WorkerCmd::Replay { resp, .. } => {
                        let _ = resp.send(Ok(crate::pty::WorkerReplay::new(
                            worker_control.source_offset(),
                            Vec::new(),
                        )));
                    }
                    command => {
                        let _ = observed_tx.send(command);
                    }
                }
            }
        });
        let sessions = RtcSessions::new();

        for (signal_id, point) in [
            ("close-race-control", TestEffectPoint::ControlRequest),
            ("close-race-input", TestEffectPoint::PtyInput),
        ] {
            let viewer = viewer_id(signal_id, "generation");
            let client =
                connect_rtc_session(&sessions, &registry, session_id, signal_id, "generation")
                    .await;
            let gate = sessions.stall_effect(signal_id, point).await;
            match point {
                TestEffectPoint::ControlRequest => {
                    sessions.controls.unregister(session_id, &viewer).await;
                    let request_id = Uuid::new_v4();
                    client
                        .ctl
                        .send_text(format!(
                            r#"{{"version":1,"kind":"request","request_id":"{request_id}","operation":"take_control","cols":101,"rows":31}}"#
                        ))
                        .await
                        .expect("send admitted control request");
                    wait_effect_gate(&gate).await;
                    let _ = client.pty.close().await;
                }
                TestEffectPoint::PtyInput => {
                    client
                        .pty
                        .send(&Bytes::from_static(b"admitted-before-close"))
                        .await
                        .expect("send admitted PTY input");
                    wait_effect_gate(&gate).await;
                    let _ = client.ctl.close().await;
                }
                _ => unreachable!(),
            }
            wait_peer_stopped(&sessions, signal_id).await;
            gate.release.notify_one();
            wait_peer_cleanup(&sessions, &control, session_id, &viewer).await;
            assert!(
                matches!(
                    observed_rx.try_recv(),
                    Err(tokio::sync::mpsc::error::TryRecvError::Empty)
                ),
                "{signal_id}: admitted effect reached worker after counterpart close"
            );
            assert_eq!(sessions.controls.retained_counts().await, (0, 0));
            close_test_peer(&client.pc).await;
        }
        worker.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn admitted_sink_and_ready_abort_when_counterpart_closes() {
        let session_id = Uuid::new_v4();
        let registry = SessionRegistry::new();
        let (session, mut worker_commands) = insert_test_worker(&registry, session_id);
        let control = registry
            .control_for_binding(session)
            .expect("worker control");
        let worker_control = control.clone();
        let worker = tokio::spawn(async move {
            while let Some(command) = worker_commands.recv().await {
                if let crate::pty::WorkerCmd::Replay { resp, .. } = command {
                    let _ = resp.send(Ok(crate::pty::WorkerReplay::new(
                        worker_control.source_offset(),
                        Vec::new(),
                    )));
                }
            }
        });
        let sessions = RtcSessions::new();

        for (signal_id, point) in [
            ("close-race-sink", TestEffectPoint::PtySink),
            ("close-race-ready", TestEffectPoint::Ready),
        ] {
            let viewer = viewer_id(signal_id, "generation");
            let gate = sessions.stall_effect(signal_id, point).await;
            let mut client = connect_rtc_session_inner(
                &sessions,
                &registry,
                session_id,
                signal_id,
                "generation",
                false,
            )
            .await;
            wait_effect_gate(&gate).await;
            match point {
                TestEffectPoint::PtySink => {
                    let _ = client.ctl.close().await;
                }
                TestEffectPoint::Ready => {
                    let _ = client.pty.close().await;
                }
                _ => unreachable!(),
            }
            wait_peer_stopped(&sessions, signal_id).await;
            gate.release.notify_one();
            wait_peer_cleanup(&sessions, &control, session_id, &viewer).await;
            assert_eq!(control.direct_sink_offset(&viewer).await, None);
            assert!(!sessions.controls.contains_viewer(session_id, &viewer).await);
            if point == TestEffectPoint::Ready {
                while let Ok((is_string, bytes)) = client.ctl_messages.try_recv() {
                    if is_string {
                        let value: serde_json::Value =
                            serde_json::from_slice(&bytes).expect("control event JSON");
                        assert_ne!(value["event"], "ready", "ready emitted after close");
                    }
                }
            }
            assert_eq!(sessions.controls.retained_counts().await, (0, 0));
            close_test_peer(&client.pc).await;
        }
        worker.abort();
    }

    #[tokio::test]
    async fn full_signaling_outbox_defers_status_without_closing_the_peer() {
        let registry = SessionRegistry::new();
        let session_id = Uuid::new_v4();
        let (session, _commands) = insert_test_worker(&registry, session_id);
        let control = registry
            .control_for_binding(session)
            .expect("worker control");
        let api = APIBuilder::new().build();
        let pc = Arc::new(
            api.new_peer_connection(RTCConfiguration::default())
                .await
                .unwrap(),
        );
        let active = Arc::new(AtomicBool::new(true));
        let channels = Arc::new(RequiredSessionChannels::default());
        assert!(channels.register(SessionChannel::Pty).await);
        assert!(channels.register(SessionChannel::Control).await);
        channels.mark_open(SessionChannel::Pty).await;
        channels.mark_open(SessionChannel::Control).await;
        let fence = Arc::new(tokio::sync::RwLock::new(()));
        let sessions = RtcSessions::new();
        let signal_id = "full-status-outbox";
        let old_nonce = "b".repeat(32);
        let generation = format!("7:{old_nonce}");
        sessions.peers.lock().await.insert(
            signal_id.to_string(),
            RtcPeer {
                pc: Arc::clone(&pc),
                session,
                generation: generation.clone(),
                active: Arc::clone(&active),
                control: control.clone(),
                channels: Arc::clone(&channels),
                close: Arc::new(PeerCloseCoordinator::default()),
                offer_key: None,
                remote_ufrags: Arc::new(Mutex::new(HashSet::new())),
                restart_lock: Arc::new(Mutex::new(())),
                _admission_permit: sessions.peer_admission.try_acquire().unwrap(),
                fence: Arc::clone(&fence),
            },
        );

        let (out_tx, mut out_rx) = mpsc::channel(1);
        sessions.install_ws_sender(out_tx.clone());
        out_tx
            .try_send(WsOutbound::json(r#"{"type":"sentinel"}"#.to_string()))
            .expect("fill signaling outbox");
        let live = sessions.live_bindings().await;
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].binding_generation, 7);
        assert_eq!(live[0].binding_nonce, old_nonce);
        let sent = tokio::time::timeout(
            Duration::from_millis(100),
            sessions.send_session_peer_status(
                &out_tx,
                signal_id,
                &generation,
                &pc,
                &active,
                &channels,
                &old_nonce,
                session_id,
                "connected",
                None,
            ),
        )
        .await
        .expect("full signaling outbox blocked the lifecycle callback");
        assert!(sent);
        assert!(!channels.failed.load(Ordering::SeqCst));
        assert!(active.load(Ordering::Acquire));

        let sentinel = out_rx.recv().await.expect("sentinel frame");
        assert_eq!(sentinel.as_str(), r#"{"type":"sentinel"}"#);
        sessions.reannounce_live_statuses().await;
        let deferred = out_rx.recv().await.expect("deferred status");
        let deferred: serde_json::Value = serde_json::from_str(deferred.as_str()).unwrap();
        assert_eq!(deferred["binding_nonce"], old_nonce);
        assert!(active.load(Ordering::Acquire));
        sessions.close_all().await;
    }

    #[tokio::test]
    async fn close_all_cannot_remove_a_same_session_replacement() {
        let registry = SessionRegistry::new();
        let session_id = Uuid::new_v4();
        let (old, _old_commands) = insert_test_worker(&registry, session_id);
        let old_control = registry
            .control_for_binding(old)
            .expect("old worker control");
        let api = APIBuilder::new().build();
        let old_pc = Arc::new(
            api.new_peer_connection(RTCConfiguration::default())
                .await
                .unwrap(),
        );
        let old_active = Arc::new(AtomicBool::new(true));
        let sessions = RtcSessions::new();
        let signal_id = "close-all-reinsert";
        let generation = "old-signal-generation";
        sessions.peers.lock().await.insert(
            signal_id.to_string(),
            RtcPeer {
                pc: Arc::clone(&old_pc),
                session: old,
                generation: generation.to_string(),
                active: Arc::clone(&old_active),
                control: old_control,
                channels: Arc::new(RequiredSessionChannels::default()),
                close: Arc::new(PeerCloseCoordinator::default()),
                offer_key: None,
                remote_ufrags: Arc::new(Mutex::new(HashSet::new())),
                restart_lock: Arc::new(Mutex::new(())),
                _admission_permit: sessions.peer_admission.try_acquire().unwrap(),
                fence: Arc::new(tokio::sync::RwLock::new(())),
            },
        );

        let snapshot_gate = sessions
            .stall_effect(signal_id, TestEffectPoint::CloseAllSnapshot)
            .await;
        let close_all_sessions = sessions.clone();
        let close_all = tokio::spawn(async move {
            close_all_sessions.close_all().await;
        });
        wait_effect_gate(&snapshot_gate).await;

        let close_same_sessions = sessions.clone();
        let close_same_pc = Arc::clone(&old_pc);
        let close_same = tokio::spawn(async move {
            close_same_sessions
                .close_if_same(signal_id, generation, &close_same_pc)
                .await;
        });
        tokio::time::timeout(Duration::from_secs(3), close_same)
            .await
            .expect("exact close did not remove the old peer")
            .unwrap();
        assert!(!sessions.peers.lock().await.contains_key(signal_id));

        let (replacement, _replacement_commands) = insert_test_worker(&registry, session_id);
        let replacement_control = registry
            .control_for_binding(replacement)
            .expect("replacement worker control");
        let replacement_pc = Arc::new(
            api.new_peer_connection(RTCConfiguration::default())
                .await
                .unwrap(),
        );
        let replacement_active = Arc::new(AtomicBool::new(true));
        sessions.peers.lock().await.insert(
            signal_id.to_string(),
            RtcPeer {
                pc: Arc::clone(&replacement_pc),
                session: replacement,
                generation: "replacement-signal-generation".to_string(),
                active: Arc::clone(&replacement_active),
                control: replacement_control,
                channels: Arc::new(RequiredSessionChannels::default()),
                close: Arc::new(PeerCloseCoordinator::default()),
                offer_key: None,
                remote_ufrags: Arc::new(Mutex::new(HashSet::new())),
                restart_lock: Arc::new(Mutex::new(())),
                _admission_permit: sessions.peer_admission.try_acquire().unwrap(),
                fence: Arc::new(tokio::sync::RwLock::new(())),
            },
        );
        snapshot_gate.release.notify_one();
        tokio::time::timeout(Duration::from_secs(3), close_all)
            .await
            .expect("close_all did not finish")
            .unwrap();

        let peers = sessions.peers.lock().await;
        let tracked = peers
            .get(signal_id)
            .expect("replacement was silently removed");
        assert_eq!(tracked.session, replacement);
        assert!(Arc::ptr_eq(&tracked.pc, &replacement_pc));
        drop(peers);
        assert!(replacement_active.load(Ordering::Acquire));
        assert!(!old_active.load(Ordering::Acquire));
        sessions.close_all().await;
        assert!(!replacement_active.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn real_spawn_ctl_uploads_multiple_verified_chunks() {
        let tmp = tempfile::tempdir().unwrap();
        let session_id = Uuid::new_v4();
        let registry = SessionRegistry::new();
        let (_session, _worker_commands) = insert_test_worker_at(&registry, session_id, tmp.path());
        let sessions = RtcSessions::new();
        let mut client =
            connect_rtc_session(&sessions, &registry, session_id, "rtc-upload", "generation").await;
        let upload_id = Uuid::new_v4();
        let bytes = vec![0x5a; crate::upload::UPLOAD_CHUNK_BYTES * 2 + 17];

        let ready = start_real_upload(&mut client, upload_id, "verified.bin", &bytes).await;
        assert_eq!(ready["operation"], "upload_start");
        assert_eq!(ready["ok"], true);
        assert_eq!(ready["state"], "ready");
        assert_eq!(ready["next_sequence"], 0);
        assert_eq!(ready["received_bytes"], 0);
        send_real_upload_chunks(&client, upload_id, &bytes).await;
        let complete = next_ctl_json_for(&mut client.ctl_messages, upload_id).await;
        assert_eq!(complete["operation"], "upload_complete");
        assert_eq!(complete["ok"], true);
        assert_eq!(complete["state"], "complete");
        assert_eq!(complete["total_bytes"], bytes.len());
        assert_eq!(complete["sha256"], real_upload_hash(&bytes));
        assert_eq!(
            std::fs::read(tmp.path().join("verified.bin")).unwrap(),
            bytes
        );
        assert!(!tmp.path().join("verified-2.bin").exists());

        sessions.close("rtc-upload", "generation", session_id).await;
        close_test_peer(&client.pc).await;
        assert_eq!(sessions.resident_session_count().await, 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn real_control_close_uses_one_upload_deadline_and_isolates_replacement() {
        tokio::time::timeout(Duration::from_secs(45), async {
            let tmp = tempfile::tempdir().unwrap();
            let session_id = Uuid::new_v4();
            let registry = SessionRegistry::new();
            let (old_session, _old_worker_commands) =
                insert_test_worker_at(&registry, session_id, tmp.path());
            let sessions = RtcSessions::new();
            let mut client = tokio::time::timeout(
                Duration::from_secs(10),
                connect_rtc_session(&sessions, &registry, session_id, "rtc-close-stall", "old"),
            )
            .await
            .expect("initial RTC session did not connect within 10 seconds");
            let abandoned_id = Uuid::new_v4();
            let abandoned = b"must-not-publish";
            let ready = tokio::time::timeout(
                Duration::from_secs(10),
                start_real_upload(&mut client, abandoned_id, "abandoned.bin", abandoned),
            )
            .await
            .expect("abandoned upload did not become ready within 10 seconds");
            assert_eq!(ready["state"], "ready");
            let mut cleanup_pause = UploadCleanupPauseGuard::arm(sessions.uploads.clone());

            tokio::time::timeout(Duration::from_secs(10), client.ctl.close())
                .await
                .expect("closing the original spawn.ctl exceeded 10 seconds")
                .expect("close real spawn.ctl");
            tokio::time::timeout(
                Duration::from_secs(10),
                sessions.uploads.wait_cleanup_pause_for_test(),
            )
            .await
            .expect("control close did not reach the upload cleanup pause within 10 seconds");
            assert_eq!(sessions.uploads.retained_counts().await, (1, 0));
            assert!(sessions.uploads.operation_count() >= 1);
            let closed = tokio::time::timeout(Duration::from_millis(150), async {
                while sessions.resident_session_count().await != 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await;
            if closed.is_err() {
                cleanup_pause.release();
                panic!("control close consumed more than one upload teardown deadline");
            }
            assert!(!tmp.path().join("abandoned.bin").exists());

            let (replacement, _replacement_worker_commands) =
                insert_test_worker_at(&registry, session_id, tmp.path());
            assert_ne!(old_session, replacement);
            let mut replacement_client = tokio::time::timeout(
                Duration::from_secs(10),
                connect_rtc_session(
                    &sessions,
                    &registry,
                    session_id,
                    "rtc-close-stall",
                    "replacement",
                ),
            )
            .await
            .expect("replacement RTC session did not connect within 10 seconds");
            let replacement_id = Uuid::new_v4();
            let replacement_bytes = b"replacement-only";
            let replacement_ready = tokio::time::timeout(
                Duration::from_secs(10),
                start_real_upload(
                    &mut replacement_client,
                    replacement_id,
                    "replacement.bin",
                    replacement_bytes,
                ),
            )
            .await
            .expect("replacement upload did not become ready within 10 seconds");
            assert_eq!(replacement_ready["state"], "ready");
            tokio::time::timeout(
                Duration::from_secs(10),
                send_real_upload_chunks(&replacement_client, replacement_id, replacement_bytes),
            )
            .await
            .expect("replacement upload chunks did not send within 10 seconds");
            let replacement_complete = tokio::time::timeout(
                Duration::from_secs(10),
                next_ctl_json_for(&mut replacement_client.ctl_messages, replacement_id),
            )
            .await
            .expect("replacement upload did not complete within 10 seconds");
            assert_eq!(replacement_complete["state"], "complete");
            assert_eq!(
                std::fs::read(tmp.path().join("replacement.bin")).unwrap(),
                replacement_bytes
            );
            assert_eq!(sessions.uploads.retained_counts().await, (1, 1));

            cleanup_pause.release();
            assert!(
                sessions
                    .uploads
                    .wait_for_operations(tokio::time::Instant::now() + Duration::from_secs(5))
                    .await,
                "original upload operations did not drain within 5 seconds"
            );
            // webrtc-rs may retain the server's graceful SCTP close until the
            // remote peer settles. The stale browser fixture has finished all
            // assertions, so let transport cleanup complete before counting tasks.
            tokio::time::timeout(Duration::from_secs(10), close_test_peer(&client.pc))
                .await
                .expect("original RTC peer did not close within 10 seconds");
            let cleanup_timeout = Duration::from_secs(15);
            tokio::time::timeout(cleanup_timeout, async {
                while sessions.peer_cleanup_task_count().await != 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("tracked peer cleanup task did not drain");
            assert_eq!(sessions.uploads.retained_counts().await, (0, 1));
            assert!(!tmp.path().join("abandoned.bin").exists());
            assert!(std::fs::read_dir(tmp.path()).unwrap().all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("spawn-upload")));

            tokio::time::timeout(
                Duration::from_secs(10),
                sessions.close("rtc-close-stall", "replacement", session_id),
            )
            .await
            .expect("replacement server peer did not close within 10 seconds");
            tokio::time::timeout(
                Duration::from_secs(10),
                close_test_peer(&replacement_client.pc),
            )
            .await
            .expect("replacement client peer did not close within 10 seconds");
            tokio::time::timeout(Duration::from_secs(10), close_test_peer(&client.pc))
                .await
                .expect("original client peer did not close within 10 seconds");
        })
        .await
        .expect("real control-close fixture exceeded its 45-second overall deadline");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn real_spawn_ctl_lost_final_ack_reconciles_once_after_replacement() {
        let tmp = tempfile::tempdir().unwrap();
        let session_id = Uuid::new_v4();
        let registry = SessionRegistry::new();
        let (_session, _worker_commands) = insert_test_worker_at(&registry, session_id, tmp.path());
        let sessions = RtcSessions::new();
        let mut stale =
            connect_rtc_session(&sessions, &registry, session_id, "rtc-lost-ack", "stale").await;
        let upload_id = Uuid::new_v4();
        let bytes = b"published-exactly-once";
        let ready = start_real_upload(&mut stale, upload_id, "once.bin", bytes).await;
        assert_eq!(ready["state"], "ready");
        sessions.uploads.arm_commit_pause_for_test();
        send_real_upload_chunks(&stale, upload_id, bytes).await;
        sessions.uploads.wait_commit_pause_for_test().await;
        assert!(!tmp.path().join("once.bin").exists());

        stale.ctl.close().await.expect("close stale real spawn.ctl");
        let stale_peer_close = {
            // webrtc-rs can serialize the remote DataChannel close callback
            // behind the deliberately paused message callback.
            // Closing the peer supplies the independent endpoint-loss signal
            // while retaining the test's paused final-commit race.
            let pc = Arc::clone(&stale.pc);
            tokio::spawn(async move {
                let _ = tokio::time::timeout(Duration::from_secs(10), pc.close()).await;
            })
        };
        let stale_disabled = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let active = sessions
                    .peers
                    .lock()
                    .await
                    .get("rtc-lost-ack")
                    .is_some_and(|peer| peer.active.load(Ordering::Acquire));
                if !active {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
        sessions.uploads.release_commit_pause_for_test();
        stale_disabled.expect("stale control close did not disable endpoint effects");
        stale_peer_close.await.expect("close stale RTC peer");
        wait_for_resident_sessions(&sessions, 0).await;
        assert!(
            sessions
                .uploads
                .wait_for_operations(tokio::time::Instant::now() + Duration::from_secs(5))
                .await
        );
        assert_eq!(sessions.uploads.retained_counts().await, (0, 1));
        assert_eq!(std::fs::read(tmp.path().join("once.bin")).unwrap(), bytes);

        let stale_ack = tokio::time::timeout(Duration::from_millis(150), async {
            while let Some((is_string, message)) = stale.ctl_messages.recv().await {
                if is_string {
                    let value: Value = serde_json::from_slice(&message).unwrap();
                    if value.get("request_id").and_then(Value::as_str)
                        == Some(upload_id.to_string().as_str())
                    {
                        return true;
                    }
                }
            }
            false
        })
        .await
        .unwrap_or(false);
        assert!(
            !stale_ack,
            "stale RTC session received a late upload acknowledgement"
        );

        let mut replacement = connect_rtc_session(
            &sessions,
            &registry,
            session_id,
            "rtc-lost-ack",
            "replacement",
        )
        .await;
        let reconciled = start_real_upload(&mut replacement, upload_id, "once.bin", bytes).await;
        assert_eq!(reconciled["operation"], "upload_complete");
        assert_eq!(reconciled["state"], "complete");
        assert_eq!(
            reconciled["path"],
            tmp.path().join("once.bin").to_str().unwrap()
        );
        assert!(!tmp.path().join("once-2.bin").exists());
        assert_eq!(
            std::fs::read_dir(tmp.path())
                .unwrap()
                .filter(|entry| entry
                    .as_ref()
                    .is_ok_and(|entry| entry.file_name() == "once.bin"))
                .count(),
            1
        );

        sessions
            .close("rtc-lost-ack", "replacement", session_id)
            .await;
        close_test_peer(&replacement.pc).await;
        close_test_peer(&stale.pc).await;
    }

    #[tokio::test]
    async fn real_spawn_pty_and_ctl_channels_replay_live_input_and_cleanup() {
        let session_id = Uuid::new_v4();
        let viewer = "rtc-real:generation".to_string();
        let registry = SessionRegistry::new();
        let (session, mut worker_commands) = insert_test_worker(&registry, session_id);
        let control = registry.control_for_binding(session).unwrap();
        let worker_control = control.clone();
        let replay_bytes = b"worker-history\r\n".to_vec();
        let worker_replay_bytes = replay_bytes.clone();
        let (input_tx, mut input_rx) = mpsc::unbounded_channel();
        let worker = tokio::spawn(async move {
            while let Some(command) = worker_commands.recv().await {
                match command {
                    crate::pty::WorkerCmd::Replay { resp, .. } => {
                        let _ = resp.send(Ok(crate::pty::WorkerReplay::new(
                            worker_control.source_offset(),
                            worker_replay_bytes.clone(),
                        )));
                    }
                    crate::pty::WorkerCmd::Input(bytes) => {
                        let _ = input_tx.send(bytes);
                    }
                    crate::pty::WorkerCmd::Resize { .. } => {}
                }
            }
        });
        let sessions = RtcSessions::new();
        let mut client =
            connect_rtc_session(&sessions, &registry, session_id, "rtc-real", "generation").await;
        assert_eq!(sessions.resident_session_count().await, 1);
        client
            .pty
            .send(&Bytes::from_static(b"endpoint-input"))
            .await
            .unwrap();
        let request_id = Uuid::new_v4();
        client
            .ctl
            .send_text(format!(
                r#"{{"version":1,"kind":"request","request_id":"{request_id}","operation":"history","lines":400,"plain":false}}"#
            ))
            .await
            .unwrap();

        let metadata = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let (is_string, bytes) =
                    client.ctl_messages.recv().await.expect("spawn.ctl closed");
                if is_string {
                    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                    if value.get("request_id").and_then(|id| id.as_str())
                        == Some(&request_id.to_string())
                    {
                        break value;
                    }
                }
            }
        })
        .await
        .expect("spawn.ctl response timed out");
        assert_eq!(metadata["operation"], "history");
        assert_eq!(metadata["ok"], true);
        assert_eq!(metadata["pty_offset"], 0);
        assert_eq!(metadata["total_bytes"], replay_bytes.len());
        assert_eq!(metadata["chunks"], 1);

        let replay_chunk = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let (is_string, bytes) =
                    client.ctl_messages.recv().await.expect("spawn.ctl closed");
                if !is_string && bytes.get(8..24) == Some(request_id.as_bytes()) {
                    break bytes;
                }
            }
        })
        .await
        .expect("spawn.ctl replay chunk timed out");
        assert_eq!(&replay_chunk[..4], b"SPCT");
        assert_eq!(replay_chunk[4], session_ctl::PROTOCOL_VERSION);
        assert_eq!(&replay_chunk[28..], replay_bytes);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(10), input_rx.recv())
                .await
                .expect("first spawn.pty input timed out")
                .expect("worker command channel closed"),
            b"endpoint-input"
        );

        let plain_request_id = Uuid::new_v4();
        let plain_request_id_text = plain_request_id.to_string();
        client
            .ctl
            .send_text(format!(
                r#"{{"version":1,"kind":"request","request_id":"{plain_request_id}","operation":"history","lines":400,"plain":true}}"#
            ))
            .await
            .unwrap();
        let plain_error = loop {
            let value = next_ctl_json(&mut client.ctl_messages).await;
            if value.get("request_id").and_then(|id| id.as_str())
                == Some(plain_request_id_text.as_str())
            {
                break value;
            }
        };
        assert_eq!(plain_error["request_id"], plain_request_id.to_string());
        assert_eq!(plain_error["ok"], false);
        assert_eq!(plain_error["error"]["code"], "plain_replay_unsupported");

        let live = b"live-after-replay\r\n";
        control.route_direct_for_test(live).await;
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(10), client.pty_messages.recv())
                .await
                .expect("spawn.pty live output timed out")
                .expect("spawn.pty closed"),
            live
        );
        let mut second =
            connect_rtc_session(&sessions, &registry, session_id, "rtc-second", "generation").await;
        assert_eq!(sessions.resident_session_count().await, 2);
        loop {
            let event = next_ctl_json(&mut client.ctl_messages).await;
            if event["event"] == "display_state" && event["viewers"] == 2 {
                assert_eq!(event["owner"], true);
                break;
            }
        }
        loop {
            let event = next_ctl_json(&mut second.ctl_messages).await;
            if event["event"] == "display_state" && event["viewers"] == 2 {
                assert_eq!(event["owner"], false);
                break;
            }
        }
        let take_request = Uuid::new_v4();
        second
            .ctl
            .send_text(format!(
                r#"{{"version":1,"kind":"request","request_id":"{take_request}","operation":"take_control","cols":100,"rows":30}}"#
            ))
            .await
            .unwrap();
        let mut second_ack = false;
        let mut second_owner = false;
        while !second_ack || !second_owner {
            let message = next_ctl_json(&mut second.ctl_messages).await;
            if message["request_id"] == take_request.to_string() && message["ok"] == true {
                second_ack = true;
            }
            if message["event"] == "display_state"
                && message["viewers"] == 2
                && message["owner"] == true
            {
                second_owner = true;
            }
        }
        loop {
            let event = next_ctl_json(&mut client.ctl_messages).await;
            if event["event"] == "display_state" && event["viewers"] == 2 && event["owner"] == false
            {
                break;
            }
        }
        sessions.close("rtc-second", "generation", session_id).await;
        close_test_peer(&second.pc).await;
        assert_eq!(sessions.resident_session_count().await, 1);

        sessions.close("rtc-real", "generation", session_id).await;
        assert_eq!(sessions.resident_session_count().await, 0);
        close_test_peer(&client.pc).await;
        tokio::time::timeout(Duration::from_secs(3), async {
            while sessions.controls.contains_viewer(session_id, &viewer).await
                || control.direct_sink_offset(&viewer).await.is_some()
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("RTC viewer cleanup timed out");

        let stall_gate = sessions.stall_first_pty_send("rtc-stalled").await;
        let stalled = connect_rtc_session(
            &sessions,
            &registry,
            session_id,
            "rtc-stalled",
            "generation",
        )
        .await;
        let stalled_viewer = viewer_id("rtc-stalled", "generation");
        assert!(
            control
                .wait_for_direct_sink(&stalled_viewer, Duration::from_secs(3))
                .await
        );
        for _ in 0..=(crate::pty::DIRECT_SINK_QUEUE_DEPTH + 2) {
            control.route_direct_for_test(b"x").await;
        }
        tokio::time::timeout(Duration::from_secs(3), async {
            while control.direct_sink_offset(&stalled_viewer).await.is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("stalled RTC PTY viewer was not disconnected");
        stall_gate.notify_one();
        sessions
            .close("rtc-stalled", "generation", session_id)
            .await;
        close_test_peer(&stalled.pc).await;
        assert_eq!(sessions.resident_session_count().await, 0);
        worker.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn real_worker_cleanup_guard_kills_on_unwind() {
        let _env_lock = crate::worker_backend::WORKER_TEST_ENV_LOCK.lock().await;
        let _env = WorkerTestEnv::install();
        let session_id = Uuid::new_v4();
        #[cfg(unix)]
        let argv = vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "exec cat".to_string(),
        ];
        #[cfg(windows)]
        let argv = vec![
            std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string()),
            "/d".to_string(),
        ];
        #[cfg(unix)]
        let cwd = "/".to_string();
        #[cfg(windows)]
        let cwd = std::env::current_dir()
            .expect("current worker test directory")
            .to_string_lossy()
            .into_owned();
        #[cfg(unix)]
        let mut env = std::collections::BTreeMap::new();
        #[cfg(windows)]
        let mut env = std::env::vars().collect::<std::collections::BTreeMap<_, _>>();
        #[cfg(unix)]
        env.insert(
            "PATH".to_string(),
            std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".to_string()),
        );
        env.insert("TERM".to_string(), "xterm-256color".to_string());

        let launched = crate::worker_backend::launch(crate::pty::LaunchSpec {
            session_id,
            cwd: &cwd,
            cols: 80,
            rows: 24,
            argv: &argv,
            env: &env,
        })
        .await;
        #[cfg(windows)]
        let launched = match launched {
            Ok(launched) => launched,
            Err(error) if test_runner_denied_worker_breakaway(&error) => {
                eprintln!(
                    "skipping real worker cleanup-guard case: the test runner job denies worker breakaway"
                );
                return;
            }
            Err(error) => panic!("launch cleanup-guard worker: {error:#}"),
        };
        #[cfg(not(windows))]
        let launched = launched.expect("launch cleanup-guard worker");
        let crate::pty::Launched {
            handle, exit_rx, ..
        } = launched;
        let cleanup = WorkerCleanupGuard::new(session_id, &handle);

        let unwind = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _cleanup = cleanup;
            drop(handle);
            panic!("exercise worker cleanup guard");
        }));
        assert!(unwind.is_err(), "cleanup guard test did not unwind");
        let reason = tokio::time::timeout(Duration::from_secs(5), exit_rx)
            .await
            .expect("cleanup guard worker exit timed out")
            .expect("cleanup guard worker exit sender dropped");
        assert!(reason.exit_code.is_some() || reason.signal.is_some());
        assert!(
            !crate::worker_backend::socket_exists(session_id),
            "cleanup guard left its worker endpoint behind"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn real_worker_rtc_launch_adopt_backpressure_catchup_and_exit() {
        let _env_lock = crate::worker_backend::WORKER_TEST_ENV_LOCK.lock().await;
        let _env = WorkerTestEnv::install();
        let session_id = Uuid::new_v4();
        #[cfg(unix)]
        let argv = vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "printf 'rtc-worker-ready\\n'; exec cat".to_string(),
        ];
        #[cfg(windows)]
        let argv = vec![
            std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string()),
            "/d".to_string(),
            "/k".to_string(),
            "echo rtc-worker-ready".to_string(),
        ];
        #[cfg(unix)]
        let cwd = "/".to_string();
        #[cfg(windows)]
        let cwd = std::env::current_dir()
            .expect("current worker test directory")
            .to_string_lossy()
            .into_owned();
        #[cfg(unix)]
        let mut env = std::collections::BTreeMap::new();
        #[cfg(windows)]
        let mut env = std::env::vars().collect::<std::collections::BTreeMap<_, _>>();
        #[cfg(unix)]
        env.insert(
            "PATH".to_string(),
            std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".to_string()),
        );
        env.insert("TERM".to_string(), "xterm-256color".to_string());

        let launched = crate::worker_backend::launch(crate::pty::LaunchSpec {
            session_id,
            cwd: &cwd,
            cols: 80,
            rows: 24,
            argv: &argv,
            env: &env,
        })
        .await;
        #[cfg(windows)]
        let launched = match launched {
            Ok(launched) => launched,
            Err(error) if test_runner_denied_worker_breakaway(&error) => {
                eprintln!(
                    "skipping real worker RTC case: the test runner job denies worker breakaway"
                );
                return;
            }
            Err(error) => panic!("launch real worker: {error:#}"),
        };
        #[cfg(not(windows))]
        let launched = launched.expect("launch real worker");
        let crate::pty::Launched {
            handle,
            exit_rx: initial_exit_rx,
            ..
        } = launched;
        let mut worker_cleanup = WorkerCleanupGuard::new(session_id, &handle);
        let initial_control = handle.control.clone();
        let (ws_tx, mut ws_rx) = mpsc::channel(1024);
        initial_control.set_sink(ws_tx).await;
        let ws_drain = tokio::spawn(async move { while ws_rx.recv().await.is_some() {} });
        let registry = SessionRegistry::new();
        let sessions = RtcSessions::new();
        let transition = registry.lock_generation_transition(session_id).await;
        registry.insert(handle);
        drop(transition);

        let mut first =
            connect_rtc_session(&sessions, &registry, session_id, "worker-first", "launch").await;
        let history = request_history(&mut first).await;
        assert!(
            history
                .windows(b"rtc-worker-ready".len())
                .any(|window| window == b"rtc-worker-ready"),
            "launch history missing worker output"
        );
        first
            .pty
            .send(&Bytes::from_static(b"rtc-worker-input\n"))
            .await
            .expect("real worker input");
        collect_pty_until(&mut first.pty_messages, b"rtc-worker-input").await;

        let mut second =
            connect_rtc_session(&sessions, &registry, session_id, "worker-second", "launch").await;
        loop {
            let event = next_ctl_json(&mut first.ctl_messages).await;
            if event["event"] == "display_state" && event["viewers"] == 2 {
                assert_eq!(event["owner"], true);
                break;
            }
        }
        loop {
            let event = next_ctl_json(&mut second.ctl_messages).await;
            if event["event"] == "display_state" && event["viewers"] == 2 {
                assert_eq!(event["owner"], false);
                break;
            }
        }
        let take_request = Uuid::new_v4();
        second
            .ctl
            .send_text(format!(
                r#"{{"version":1,"kind":"request","request_id":"{take_request}","operation":"take_control","cols":100,"rows":30}}"#
            ))
            .await
            .expect("take control request");
        loop {
            let message = next_ctl_json(&mut second.ctl_messages).await;
            if message["request_id"] == take_request.to_string() && message["ok"] == true {
                break;
            }
        }

        sessions.close("worker-second", "launch", session_id).await;
        close_test_peer(&second.pc).await;
        sessions.close("worker-first", "launch", session_id).await;
        close_test_peer(&first.pc).await;
        assert_eq!(sessions.resident_session_count().await, 0);

        // Simulate a supervisor restart: invalidate and drain the old RTC
        // generation, drop its worker connection, then adopt the live worker.
        let old = registry.binding_for(session_id).expect("launch binding");
        let transition = registry.lock_generation_transition(session_id).await;
        let old_handle = registry
            .remove_if_generation(session_id, old.generation())
            .expect("remove launch binding");
        sessions
            .close_for_session(session_id, old.generation())
            .await;
        drop(transition);
        drop(old_handle);
        drop(initial_exit_rx);
        tokio::time::sleep(Duration::from_millis(200)).await;

        let adopted = crate::worker_backend::adopt(session_id)
            .await
            .expect("adopt worker")
            .expect("live worker socket");
        let crate::pty::Launched {
            handle,
            exit_rx: adopted_exit_rx,
            ..
        } = adopted;
        worker_cleanup.refresh(&handle);
        let adopted_control = handle.control.clone();
        let (adopted_ws_tx, mut adopted_ws_rx) = mpsc::channel(1024);
        adopted_control.set_sink(adopted_ws_tx).await;
        let adopted_ws_drain =
            tokio::spawn(async move { while adopted_ws_rx.recv().await.is_some() {} });
        let transition = registry.lock_generation_transition(session_id).await;
        registry.insert(handle);
        drop(transition);

        let mut reconnected =
            connect_rtc_session(&sessions, &registry, session_id, "worker-adopted", "adopt").await;
        let adopted_history = request_history(&mut reconnected).await;
        assert!(
            adopted_history
                .windows(b"rtc-worker-input".len())
                .any(|window| window == b"rtc-worker-input"),
            "adopted replay lost pre-adoption output"
        );
        sessions.close("worker-adopted", "adopt", session_id).await;
        close_test_peer(&reconnected.pc).await;

        // Stall the first outbound PTY send, then drive real worker output
        // until the bounded direct queue evicts this RTC viewer. The earlier
        // RTC input assertion already covers the endpoint input path; direct
        // worker injection here makes output volume deterministic.
        let stall_gate = sessions.stall_first_pty_send("worker-stalled").await;
        let stalled =
            connect_rtc_session(&sessions, &registry, session_id, "worker-stalled", "adopt").await;
        let stalled_viewer = viewer_id("worker-stalled", "adopt");
        assert!(
            adopted_control
                .wait_for_direct_sink(&stalled_viewer, Duration::from_secs(3))
                .await
        );
        let tail_marker = format!("rtc-catchup-tail-{session_id}");
        // Wait for each one-byte TTY echo to traverse the real worker before
        // sending the next. This deterministically creates more queue entries
        // than the stalled sink can hold without a multi-megabyte flood.
        for _ in 0..(crate::pty::DIRECT_SINK_QUEUE_DEPTH + 12) {
            let expected = adopted_control.source_offset() + 1;
            assert!(registry.with_handle(session_id, |handle| {
                handle.write_stdin(b"x").expect("flood input");
            }));
            tokio::time::timeout(
                Duration::from_secs(3),
                adopted_control.wait_source_offset(expected),
            )
            .await
            .expect("worker echo did not reach the forwarder");
        }
        let expected_tail = adopted_control.source_offset() + tail_marker.len() as u64;
        assert!(registry.with_handle(session_id, |handle| {
            handle
                .write_stdin(tail_marker.as_bytes())
                .expect("tail input");
        }));
        tokio::time::timeout(
            Duration::from_secs(3),
            adopted_control.wait_source_offset(expected_tail),
        )
        .await
        .expect("worker never logged the catch-up marker");
        tokio::time::timeout(Duration::from_secs(20), async {
            while adopted_control
                .direct_sink_offset(&stalled_viewer)
                .await
                .is_some()
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("real worker stalled viewer was not evicted");
        stall_gate.notify_one();
        sessions.close("worker-stalled", "adopt", session_id).await;
        close_test_peer(&stalled.pc).await;

        let mut catchup =
            connect_rtc_session(&sessions, &registry, session_id, "worker-catchup", "adopt").await;
        let mut caught_up = false;
        for _ in 0..10 {
            let replay = request_history(&mut catchup).await;
            if replay
                .windows(tail_marker.len())
                .any(|window| window == tail_marker.as_bytes())
            {
                caught_up = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(caught_up, "replay did not catch up the evicted viewer");

        let lifecycle = registry
            .lifecycle_snapshot(session_id)
            .expect("session lifecycle");
        registry
            .shutdown_if_current(&lifecycle, spawnd::sessiond::wire::LifecycleSignal::Kill)
            .await
            .expect("KILL delivery");
        let reason = tokio::time::timeout(Duration::from_secs(15), adopted_exit_rx)
            .await
            .expect("worker exit timed out")
            .expect("worker exit sender dropped");
        assert!(reason.exit_code.is_some() || reason.signal.is_some());
        let current = registry.binding_for(session_id).expect("adopted binding");
        let transition = registry.lock_generation_transition(session_id).await;
        let exited_handle = registry
            .remove_if_generation(session_id, current.generation())
            .expect("remove exited worker");
        sessions
            .close_for_session(session_id, current.generation())
            .await;
        drop(transition);
        if let Some(replay_after_exit) = exited_handle.replay(1 << 20) {
            assert!(
                !matches!(replay_after_exit.await, Ok(Ok(_))),
                "replay remained available after worker exit"
            );
        }
        assert_eq!(sessions.resident_session_count().await, 0);
        close_test_peer(&catchup.pc).await;

        // A fresh signaling attempt after exit fails before any peer can be
        // inserted for the now-tombstoned generation.
        let (status_tx, mut status_rx) = mpsc::channel(4);
        sessions
            .handle_offer(
                RtcSignalBinding::new(
                    "worker-after-exit".to_string(),
                    "after-exit".to_string(),
                    session_id,
                ),
                String::new(),
                Vec::new(),
                None,
                false,
                None,
                registry.clone(),
                status_tx,
                None,
            )
            .await;
        let status_message = status_rx.recv().await.expect("post-exit status");
        let status = status_message.as_str();
        let status: serde_json::Value = serde_json::from_str(status).unwrap();
        assert_eq!(status["type"], "rtc.status");
        assert_eq!(status["status"], "failed");
        assert_eq!(sessions.resident_session_count().await, 0);

        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while crate::worker_backend::socket_exists(session_id) {
            assert!(tokio::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        worker_cleanup.disarm();
        drop(exited_handle);
        ws_drain.abort();
        adopted_ws_drain.abort();
    }

    #[tokio::test]
    async fn replacement_fences_stale_peer_input_control_and_output() {
        let registry = SessionRegistry::new();
        let session_id = Uuid::new_v4();
        let (old, _old_commands) = insert_test_worker(&registry, session_id);
        let (current, mut current_commands) = insert_test_worker(&registry, session_id);
        assert_ne!(old, current);

        let (out_tx, _out_rx) = mpsc::channel(4);
        assert!(
            forward_bound_data_channel_input(old, false, b"stale input", &registry, &out_tx)
                .is_none()
        );
        assert!(current_commands.try_recv().is_err());

        assert!(forward_bound_data_channel_input(
            current,
            false,
            b"current input",
            &registry,
            &out_tx,
        )
        .expect("current binding")
        .expect("current input write"));
        assert!(matches!(
            current_commands.try_recv(),
            Ok(crate::pty::WorkerCmd::Input(bytes)) if bytes == b"current input"
        ));

        let request_id = Uuid::new_v4();
        let request = ControlRequest::decode(&format!(
            r#"{{"version":1,"kind":"request","request_id":"{request_id}","operation":"resize","cols":100,"rows":30}}"#
        ))
        .expect("valid resize request");
        let controls = SessionControlHub::default();
        let (sender, _receiver) = mpsc::channel(4);
        let channels = Arc::new(RequiredSessionChannels::default());
        assert!(channels.register(SessionChannel::Pty).await);
        assert!(channels.register(SessionChannel::Control).await);
        channels.mark_open(SessionChannel::Pty).await;
        channels.mark_open(SessionChannel::Control).await;
        let effect = channels.permit().await.expect("ready effect permit");
        let uploads = UploadHub::default();
        let error = execute_control_request(
            ControlRequestContext {
                session: old,
                viewer_id: "stale-viewer",
                registry: &registry,
                controls: &controls,
                sender: &sender,
                effect: &effect,
                uploads: &uploads,
                upload_capability: Uuid::new_v4(),
            },
            request,
        )
        .await
        .expect_err("stale control must fail");
        assert_eq!(error.code, "stale_agent_generation");
        assert!(current_commands.try_recv().is_err());

        let bound_capability = Uuid::new_v4();
        let wrong_capability = Uuid::new_v4();
        let upload_request_id = Uuid::new_v4();
        let upload_request = ControlRequest::decode(&format!(
            r#"{{"version":1,"kind":"request","request_id":"{upload_request_id}","operation":"upload_start","capability":"{wrong_capability}","agent_generation":{},"name":"note.txt","mime_type":"text/plain","destination":"cwd","total_bytes":1,"chunks":1,"sha256":"{}"}}"#,
            current.generation(),
            "00".repeat(32),
        ))
        .expect("valid upload request");
        let error = execute_control_request(
            ControlRequestContext {
                session: current,
                viewer_id: "current-viewer",
                registry: &registry,
                controls: &controls,
                sender: &sender,
                effect: &effect,
                uploads: &uploads,
                upload_capability: bound_capability,
            },
            upload_request,
        )
        .await
        .expect_err("wrong upload capability must fail before filesystem access");
        assert_eq!(error.code, "upload_capability_mismatch");
        assert_eq!(uploads.retained_counts().await, (0, 0));

        assert!(!rtc_output_allowed(&registry, old));
        assert!(rtc_output_allowed(&registry, current));
    }

    #[tokio::test]
    async fn backend_transition_rejects_offer_waiting_to_insert_old_generation() {
        let mut media_engine = MediaEngine::default();
        media_engine.register_default_codecs().unwrap();
        let api = APIBuilder::new().with_media_engine(media_engine).build();
        let offer_pc = Arc::new(
            api.new_peer_connection(RTCConfiguration::default())
                .await
                .unwrap(),
        );
        offer_pc
            .create_data_channel(PTY_DATA_CHANNEL_LABEL, None)
            .await
            .unwrap();
        let offer = offer_pc.create_offer(None).await.unwrap();
        let mut gathered = offer_pc.gathering_complete_promise().await;
        offer_pc.set_local_description(offer).await.unwrap();
        let _ = gathered.recv().await;
        let offer_sdp = offer_pc.local_description().await.unwrap().sdp;

        let registry = SessionRegistry::new();
        let session_id = Uuid::new_v4();
        let (old, _old_commands) = insert_test_worker(&registry, session_id);
        let sessions = RtcSessions::new();
        let transition = registry.lock_generation_transition(session_id).await;
        let insert_attempted = sessions.peer_insert_attempted.notified();
        let (out_tx, mut out_rx) = mpsc::channel(16);
        let offer_sessions = sessions.clone();
        let offer_registry = registry.clone();
        let offer_task = tokio::spawn(async move {
            offer_sessions
                .handle_offer(
                    RtcSignalBinding::new(
                        "racing-offer".to_string(),
                        "offer-generation".to_string(),
                        session_id,
                    ),
                    offer_sdp,
                    Vec::new(),
                    None,
                    false,
                    None,
                    offer_registry,
                    out_tx,
                    None,
                )
                .await;
        });
        tokio::time::timeout(Duration::from_secs(10), insert_attempted)
            .await
            .expect("offer did not reach guarded peer insertion");

        assert!(registry
            .remove_if_generation(session_id, old.generation())
            .is_some());
        sessions
            .close_for_session(session_id, old.generation())
            .await;
        let (current, _current_commands) = insert_test_worker(&registry, session_id);
        drop(transition);
        offer_task.await.unwrap();

        assert!(registry.is_current(current));
        assert!(!registry.is_current(old));
        assert_eq!(sessions.resident_session_count().await, 0);
        let status = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let message = out_rx.recv().await.expect("status channel closed");
                let json = message.as_str();
                let value: serde_json::Value = serde_json::from_str(json).unwrap();
                if value["type"] == "rtc.status" {
                    break value;
                }
            }
        })
        .await
        .expect("failed status timed out");
        assert_eq!(status["session_id"], "racing-offer");
        assert_eq!(status["binding_nonce"], "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        assert_eq!(status["scope_type"], "session");
        assert_eq!(status["protocol"], "spawn.pty");
        assert_eq!(status["protocol_version"], 2);
        assert_eq!(status["status"], "failed");
        assert_eq!(sessions.resident_session_count().await, 0);
        offer_pc.close().await.unwrap();
    }

    #[tokio::test]
    async fn backend_transition_closes_real_offer_inserted_before_replacement() {
        let mut media_engine = MediaEngine::default();
        media_engine.register_default_codecs().unwrap();
        let api = APIBuilder::new().with_media_engine(media_engine).build();
        let offer_pc = Arc::new(
            api.new_peer_connection(RTCConfiguration::default())
                .await
                .unwrap(),
        );
        offer_pc
            .create_data_channel(PTY_DATA_CHANNEL_LABEL, None)
            .await
            .unwrap();
        let offer = offer_pc.create_offer(None).await.unwrap();
        let mut gathered = offer_pc.gathering_complete_promise().await;
        offer_pc.set_local_description(offer).await.unwrap();
        let _ = gathered.recv().await;
        let offer_sdp = offer_pc.local_description().await.unwrap().sdp;

        let registry = SessionRegistry::new();
        let session_id = Uuid::new_v4();
        let (old, _old_commands) = insert_test_worker(&registry, session_id);
        let sessions = RtcSessions::new();
        let (out_tx, _out_rx) = mpsc::channel(16);
        sessions
            .handle_offer(
                RtcSignalBinding::new(
                    "inserted-offer".to_string(),
                    "offer-generation".to_string(),
                    session_id,
                ),
                offer_sdp,
                Vec::new(),
                None,
                false,
                None,
                registry.clone(),
                out_tx,
                None,
            )
            .await;
        assert_eq!(sessions.resident_session_count().await, 1);

        let transition = registry.lock_generation_transition(session_id).await;
        assert!(registry
            .remove_if_generation(session_id, old.generation())
            .is_some());
        sessions
            .close_for_session(session_id, old.generation())
            .await;
        let (current, _current_commands) = insert_test_worker(&registry, session_id);
        drop(transition);

        assert!(registry.is_current(current));
        assert_eq!(sessions.resident_session_count().await, 0);
        offer_pc.close().await.unwrap();
    }

    #[tokio::test]
    async fn close_for_session_drains_only_the_matching_backend_generation() {
        let registry = SessionRegistry::new();
        let session_id = Uuid::new_v4();
        let (old, _old_commands) = insert_test_worker(&registry, session_id);
        let old_control = registry.control_for_binding(old).unwrap();
        let (current, _current_commands) = insert_test_worker(&registry, session_id);
        let current_control = registry.control_for_binding(current).unwrap();
        let api = APIBuilder::new().build();
        let old_pc = Arc::new(
            api.new_peer_connection(RTCConfiguration::default())
                .await
                .unwrap(),
        );
        let current_pc = Arc::new(
            api.new_peer_connection(RTCConfiguration::default())
                .await
                .unwrap(),
        );
        let old_active = Arc::new(AtomicBool::new(true));
        let current_active = Arc::new(AtomicBool::new(true));
        let old_fence = Arc::new(tokio::sync::RwLock::new(()));
        let current_fence = Arc::new(tokio::sync::RwLock::new(()));
        let old_channels = Arc::new(RequiredSessionChannels::default());
        let current_channels = Arc::new(RequiredSessionChannels::default());
        let sessions = RtcSessions::new();
        let old_viewer = viewer_id("old-session", "old-signal");
        let current_viewer = viewer_id("current-session", "current-signal");
        let old_direct = old_control.add_direct_sink(old_viewer.clone()).await;
        let current_direct = current_control
            .add_direct_sink(current_viewer.clone())
            .await;
        sessions.peers.lock().await.extend([
            (
                "old-session".to_string(),
                RtcPeer {
                    pc: old_pc,
                    session: old,
                    generation: "old-signal".to_string(),
                    active: Arc::clone(&old_active),
                    control: old_control,
                    channels: old_channels,
                    close: Arc::new(PeerCloseCoordinator::default()),
                    offer_key: None,
                    remote_ufrags: Arc::new(Mutex::new(HashSet::new())),
                    restart_lock: Arc::new(Mutex::new(())),
                    _admission_permit: sessions.peer_admission.try_acquire().unwrap(),
                    fence: Arc::clone(&old_fence),
                },
            ),
            (
                "current-session".to_string(),
                RtcPeer {
                    pc: current_pc,
                    session: current,
                    generation: "current-signal".to_string(),
                    active: Arc::clone(&current_active),
                    control: current_control,
                    channels: current_channels,
                    close: Arc::new(PeerCloseCoordinator::default()),
                    offer_key: None,
                    remote_ufrags: Arc::new(Mutex::new(HashSet::new())),
                    restart_lock: Arc::new(Mutex::new(())),
                    _admission_permit: sessions.peer_admission.try_acquire().unwrap(),
                    fence: current_fence,
                },
            ),
        ]);
        let (old_display, _old_display_rx) = tokio::sync::watch::channel(None);
        let (current_display, _current_display_rx) = tokio::sync::watch::channel(None);
        sessions
            .controls
            .register(session_id, old_viewer.clone(), old_display)
            .await;
        sessions
            .controls
            .register(session_id, current_viewer.clone(), current_display)
            .await;

        let in_flight = old_fence.read().await;
        let closing_sessions = sessions.clone();
        let close = tokio::spawn(async move {
            closing_sessions
                .close_for_session(session_id, old.generation())
                .await;
        });
        tokio::task::yield_now().await;
        assert!(!close.is_finished(), "close returned before callback drain");
        drop(in_flight);
        close.await.unwrap();

        let peers = sessions.peers.lock().await;
        assert!(!peers.contains_key("old-session"));
        assert!(peers.contains_key("current-session"));
        drop(peers);
        assert!(!old_active.load(Ordering::Acquire));
        assert!(current_active.load(Ordering::Acquire));
        assert!(*old_direct.disconnected.borrow());
        assert!(!*current_direct.disconnected.borrow());
        assert!(
            !sessions
                .controls
                .contains_viewer(session_id, &old_viewer)
                .await
        );
        assert!(
            sessions
                .controls
                .contains_viewer(session_id, &current_viewer)
                .await
        );
        sessions.close_all().await;
    }

    #[test]
    fn rtc_binary_input_writes_and_emits_one_throttled_content_free_signal() {
        let session_id = Uuid::new_v4();
        let control = crate::pty::ForwarderControl::new();
        let (out_tx, mut out_rx) = mpsc::channel(4);
        let writes = std::sync::Mutex::new(Vec::<Vec<u8>>::new());

        for data in [b"first secret".as_slice(), b"second secret".as_slice()] {
            assert!(forward_data_channel_input(
                session_id,
                false,
                data,
                &control,
                &out_tx,
                |bytes| {
                    writes.lock().unwrap().push(bytes.to_vec());
                    Ok(())
                },
            )
            .unwrap());
        }

        assert_eq!(
            *writes.lock().unwrap(),
            vec![b"first secret".to_vec(), b"second secret".to_vec()]
        );
        let activity_message = out_rx.try_recv().unwrap();
        let json = activity_message.as_str();
        assert_eq!(
            json,
            &format!(r#"{{"type":"session.input_activity","session_id":"{session_id}"}}"#)
        );
        assert!(!json.contains("secret"));
        assert!(out_rx.try_recv().is_err());
    }

    #[test]
    fn rtc_text_empty_and_failed_input_do_not_emit_activity() {
        let session_id = Uuid::new_v4();
        let control = crate::pty::ForwarderControl::new();
        let (out_tx, mut out_rx) = mpsc::channel(4);
        let write_calls = std::sync::atomic::AtomicUsize::new(0);

        assert!(
            !forward_data_channel_input(session_id, true, b"text", &control, &out_tx, |_| {
                write_calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                Ok(())
            },)
            .unwrap()
        );
        assert!(
            !forward_data_channel_input(session_id, false, b"", &control, &out_tx, |_| {
                write_calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                Ok(())
            },)
            .unwrap()
        );
        assert!(forward_data_channel_input(
            session_id,
            false,
            b"failed secret",
            &control,
            &out_tx,
            |_| anyhow::bail!("write failed"),
        )
        .is_err());

        assert_eq!(write_calls.load(std::sync::atomic::Ordering::Relaxed), 0);
        assert!(out_rx.try_recv().is_err());
    }

    #[test]
    fn oversized_rtc_input_is_rejected_before_copy_and_does_not_suppress_output() {
        let session_id = Uuid::new_v4();
        let control = crate::pty::ForwarderControl::new();
        let (cmd_tx, _cmd_rx) = mpsc::channel(crate::pty::WORKER_COMMAND_QUEUE_DEPTH);
        let (outbox_tx, _outbox_rx) = mpsc::channel(crate::pty::WORKER_OUTPUT_QUEUE_DEPTH);
        let handle = crate::pty::SessionHandle::new_worker(crate::pty::WorkerHandleParts {
            session_id,
            cwd: "/".into(),
            cmd_tx,
            lifecycle: crate::pty::SessionLifecycle::new(
                std::path::PathBuf::from("/nonexistent/spawn-test-lifecycle.sock"),
                Uuid::new_v4(),
            ),
            alive: Arc::new(AtomicBool::new(true)),
            cols: 80,
            rows: 24,
            outbox_tx,
            control: control.clone(),
        });
        let (activity_tx, mut activity_rx) = mpsc::channel(2);
        let oversized = vec![b'x'; crate::pty::MAX_WORKER_INPUT_BYTES + 1];

        assert!(forward_data_channel_input(
            session_id,
            false,
            &oversized,
            &control,
            &activity_tx,
            |bytes| handle.write_stdin(bytes),
        )
        .is_err());
        assert_eq!(handle.input_copy_count(), 0);
        assert!(activity_rx.try_recv().is_err());
        assert!(
            crate::pty::OutputChunk::classify(b"genuine output".to_vec(), &control).is_activity()
        );
    }

    #[test]
    fn server_session_binding_requires_nonce_and_safe_owner_generation() {
        let session_id = Uuid::new_v4();
        let nonce = "a".repeat(32);
        let first =
            RtcSignalBinding::from_server("session".to_string(), nonce.clone(), 1, session_id)
                .unwrap();
        let second =
            RtcSignalBinding::from_server("session".to_string(), nonce.clone(), 2, session_id)
                .unwrap();
        assert_eq!(first.binding_nonce, nonce);
        assert_ne!(first.generation, second.generation);
        assert!(RtcSignalBinding::from_server(
            "session".to_string(),
            "not-a-nonce".to_string(),
            1,
            session_id,
        )
        .is_none());
        assert!(RtcSignalBinding::from_server(
            "session".to_string(),
            "b".repeat(32),
            0,
            session_id,
        )
        .is_none());
        assert!(RtcSignalBinding::from_server(
            "session".to_string(),
            "b".repeat(32),
            MAX_SAFE_SIGNAL_GENERATION + 1,
            session_id,
        )
        .is_none());
    }

    #[test]
    fn host_binding_requires_exact_identity_protocol_and_nonce() {
        let host_id = Uuid::new_v4();
        let valid = HostRtcSignal {
            signal_id: "host-session".to_string(),
            binding_nonce: Some("c".repeat(32)),
            binding_generation: Some(9),
            scope_type: Some("host".to_string()),
            scope_id: Some(host_id),
            protocol: Some(HOST_CONTROL_LABEL.to_string()),
            protocol_version: Some(RTC_PROTOCOL_VERSION),
        };
        assert_eq!(valid.binding().unwrap().host_id, host_id);
        assert_eq!(valid.binding().unwrap().binding_generation, 9);

        let mut legacy = valid.clone();
        legacy.binding_generation = None;
        assert_eq!(legacy.binding().unwrap().binding_generation, 0);

        let mut invalid_generation = valid.clone();
        invalid_generation.binding_generation = Some(MAX_SAFE_SIGNAL_GENERATION + 1);
        assert!(invalid_generation.binding().is_none());

        let mut invalid = valid.clone();
        invalid.scope_type = Some("session".to_string());
        assert!(invalid.binding().is_none());
        let mut invalid = valid.clone();
        invalid.protocol = Some(CONTROL_DATA_CHANNEL_LABEL.to_string());
        assert!(invalid.binding().is_none());
        let mut invalid = valid;
        invalid.binding_nonce = Some("C".repeat(32));
        assert!(invalid.binding().is_none());
    }

    #[test]
    fn host_control_is_versioned_bounded_and_request_bound() {
        let request =
            br#"{"version":1,"type":"request","request_id":"request-1","operation":"ping"}"#;
        let HostControlAction::Reply(response) = host_control_response(request, true) else {
            panic!("expected ping response")
        };
        let response: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(response["request_id"], "request-1");
        assert_eq!(response["result"]["pong"], true);

        assert!(matches!(
            host_control_response(request, false),
            HostControlAction::Close
        ));
        assert!(matches!(
            host_control_response(
                br#"{"version":2,"type":"request","request_id":"r","operation":"ping"}"#,
                true,
            ),
            HostControlAction::Close
        ));
        assert!(matches!(
            host_control_response(&vec![b'x'; HOST_CONTROL_MAX_FRAME_BYTES + 1], true),
            HostControlAction::Close
        ));
        let long_id = "x".repeat(HOST_CONTROL_MAX_REQUEST_ID_BYTES + 1);
        let frame = json!({
            "version": RTC_PROTOCOL_VERSION,
            "type": "request",
            "request_id": long_id,
            "operation": "ping"
        })
        .to_string();
        assert!(matches!(
            host_control_response(frame.as_bytes(), true),
            HostControlAction::Close
        ));
    }

    #[test]
    fn host_ice_transport_policy_fails_closed() {
        assert_eq!(
            parse_ice_transport_policy(Some("relay")).unwrap(),
            RTCIceTransportPolicy::Relay
        );
        assert_eq!(
            parse_ice_transport_policy(Some("all")).unwrap(),
            RTCIceTransportPolicy::All
        );
        assert!(parse_ice_transport_policy(Some("unknown")).is_err());
    }

    #[test]
    fn network_policy_drops_link_local_and_virtual_noise_but_keeps_vpns() {
        for interface in [
            "docker0", "br-123", "veth4", "awdl0", "llw0", "anpi1", "bridge0", "vmnet8", "virbr0",
            "ztabc", "lo",
        ] {
            assert!(!interface_is_allowed(interface), "{interface}");
        }
        for interface in ["en0", "eth0", "utun4", "wg0", "tailscale0"] {
            assert!(interface_is_allowed(interface), "{interface}");
        }

        assert!(!ip_is_allowed("169.254.10.20".parse().unwrap()));
        assert!(ip_is_allowed("169.255.10.20".parse().unwrap()));
        assert!(!ip_is_allowed("fe80::1".parse().unwrap()));
        assert!(!ip_is_allowed("febf::1".parse().unwrap()));
        assert!(ip_is_allowed("fec0::1".parse().unwrap()));

        let config = |urls: &[&str]| RtcIceServerConfig {
            urls: urls.iter().map(|url| (*url).to_string()).collect(),
            username: None,
            credential: None,
        };
        assert!(has_udp_turn(&[config(&[
            "turn:relay.test:3478?transport=udp"
        ])]));
        assert!(has_udp_turn(&[config(&["turn:relay.test:3478"])]));
        assert!(!has_udp_turn(&[config(&[
            "turn:relay.test:3478?transport=tcp"
        ])]));
        assert!(!has_udp_turn(&[config(&["turns:relay.test:5349"])]));
    }

    #[test]
    fn ice_restart_ufrag_parser_rejects_replays_and_accepts_new_generations() {
        let initial = ice_ufrag("v=0\r\na=ice-ufrag:first\r\n").unwrap();
        assert_eq!(initial, "first");
        assert!(ice_ufrag("v=0\r\n").is_none());

        let seen = HashSet::from([initial]);
        assert!(!restart_ufrag_is_fresh(&seen, "first"));
        assert!(restart_ufrag_is_fresh(&seen, "second"));

        let key = Some([7; 32]);
        assert!(restart_offer_is_acceptable(
            true, true, true, key, key, true
        ));
        for rejected in [
            restart_offer_is_acceptable(false, true, true, key, key, true),
            restart_offer_is_acceptable(true, false, true, key, key, true),
            restart_offer_is_acceptable(true, true, false, key, key, true),
            restart_offer_is_acceptable(true, true, true, key, None, true),
            restart_offer_is_acceptable(true, true, true, key, Some([8; 32]), true),
            restart_offer_is_acceptable(true, true, true, key, key, false),
        ] {
            assert!(!rejected);
        }
    }

    #[tokio::test]
    async fn pacing_loop_waits_for_a_fake_channel_to_drain_and_stops_if_closed() {
        use std::collections::VecDeque;
        use std::sync::atomic::AtomicUsize;
        use std::sync::Mutex as StdMutex;

        let amounts = Arc::new(StdMutex::new(VecDeque::from([
            DATA_CHANNEL_BUFFER_HIGH + 1,
            DATA_CHANNEL_BUFFER_HIGH,
            DATA_CHANNEL_BUFFER_HIGH - 1,
        ])));
        let waits = Arc::new(AtomicUsize::new(0));
        let drained = wait_for_pacing_capacity(
            || true,
            {
                let amounts = Arc::clone(&amounts);
                move || std::future::ready(amounts.lock().unwrap().pop_front().unwrap_or_default())
            },
            {
                let waits = Arc::clone(&waits);
                move || {
                    waits.fetch_add(1, Ordering::Relaxed);
                    std::future::ready(())
                }
            },
        )
        .await;
        assert!(drained);
        assert_eq!(waits.load(Ordering::Relaxed), 2);

        assert!(
            !wait_for_pacing_capacity(
                || false,
                || std::future::ready(0),
                || std::future::ready(())
            )
            .await
        );
    }

    #[tokio::test]
    async fn daemon_host_identity_binds_without_a_session_and_cannot_be_rebound() {
        let sessions = RtcSessions::new();
        let host_id = Uuid::new_v4();
        assert!(sessions.bind_registered_host_id(host_id).await);
        assert!(sessions.bind_registered_host_id(host_id).await);
        assert!(!sessions.bind_registered_host_id(Uuid::new_v4()).await);
        assert!(sessions.peers.lock().await.is_empty());
        assert!(sessions.host_peers.lock().await.is_empty());
    }

    #[tokio::test]
    async fn two_real_host_channels_keep_source_and_destination_capabilities_isolated() {
        let source_root = tempfile::tempdir().unwrap();
        let destination_root = tempfile::tempdir().unwrap();
        let source_bytes = (0..(STREAM_CHUNK_BYTES * 3 + 17))
            .map(|index| (index % 239) as u8)
            .collect::<Vec<_>>();
        tokio::fs::write(source_root.path().join("source.bin"), &source_bytes)
            .await
            .unwrap();
        let source_files = Arc::new(
            HostFileService::rooted_at(source_root.path())
                .await
                .unwrap(),
        );
        let destination_files = Arc::new(
            HostFileService::rooted_at(destination_root.path())
                .await
                .unwrap(),
        );
        let source_host_id = Uuid::new_v4();
        let destination_host_id = Uuid::new_v4();
        let source_binding = HostRtcBinding {
            host_id: source_host_id,
            binding_nonce: "a".repeat(32),
            binding_generation: 1,
            protocol: HOST_CONTROL_LABEL.to_string(),
            protocol_version: RTC_PROTOCOL_VERSION,
        };
        let destination_binding = HostRtcBinding {
            host_id: destination_host_id,
            binding_nonce: "b".repeat(32),
            binding_generation: 1,
            protocol: HOST_CONTROL_LABEL.to_string(),
            protocol_version: RTC_PROTOCOL_VERSION,
        };
        assert_ne!(source_binding.host_id, destination_binding.host_id);
        assert_ne!(
            source_binding.binding_nonce,
            destination_binding.binding_nonce
        );

        let (source_browser, source_daemon, source_channel, mut source_messages) =
            paired_host_endpoint(
                Arc::clone(&source_files),
                source_binding,
                "source-generation-1",
            )
            .await;
        let (
            destination_browser,
            destination_daemon,
            destination_channel,
            mut destination_messages,
        ) = paired_host_endpoint(
            Arc::clone(&destination_files),
            destination_binding,
            "destination-generation-7",
        )
        .await;
        assert!(!Arc::ptr_eq(&source_channel, &destination_channel));

        let source = request_host_control(
            &source_channel,
            &mut source_messages,
            "two-host-read",
            "fs.read",
            json!({"path": "source.bin"}),
        )
        .await;
        let source_stream_id = source["result"]["stream_id"].as_str().unwrap();
        let source_hash = source["result"]["sha256"].as_str().unwrap().to_string();
        let mut transferred = Vec::new();
        loop {
            let (_, message) = receive_host_control(&mut source_messages).await;
            if message["type"] == "stream.end" {
                break;
            }
            assert_eq!(message["stream_id"], source_stream_id);
            transferred.extend(
                STANDARD
                    .decode(message[DIRECT_ENDPOINT_BYTES_FIELD].as_str().unwrap())
                    .unwrap(),
            );
            source_channel
                .send_text(
                    json!({
                        "version": RTC_PROTOCOL_VERSION,
                        "type": "stream.ack",
                        "stream_id": source_stream_id,
                        "sequence": message["sequence"].as_u64().unwrap() + 1,
                    })
                    .to_string(),
                )
                .await
                .unwrap();
        }
        assert_eq!(transferred, source_bytes);
        assert!(!source_root.path().join("destination.bin").exists());

        let destination = request_host_control(
            &destination_channel,
            &mut destination_messages,
            "two-host-write",
            "fs.write.begin",
            json!({
                "dir": "~",
                "name": "destination.bin",
                "length": transferred.len(),
                "sha256": source_hash,
                "overwrite": false,
            }),
        )
        .await;
        let destination_stream_id = destination["result"]["stream_id"].as_str().unwrap();
        for (sequence, chunk) in transferred.chunks(STREAM_CHUNK_BYTES).enumerate() {
            destination_channel
                .send_text(
                    json!({
                        "version": RTC_PROTOCOL_VERSION,
                        "type": "stream.chunk",
                        "stream_id": destination_stream_id,
                        "sequence": sequence,
                        (DIRECT_ENDPOINT_BYTES_FIELD): STANDARD.encode(chunk),
                    })
                    .to_string(),
                )
                .await
                .unwrap();
        }
        destination_channel
            .send_text(
                json!({
                    "version": RTC_PROTOCOL_VERSION,
                    "type": "stream.end",
                    "stream_id": destination_stream_id,
                    "length": transferred.len(),
                    "sha256": source_hash,
                })
                .to_string(),
            )
            .await
            .unwrap();
        let (_, committed) = receive_host_control(&mut destination_messages).await;
        assert_eq!(committed["type"], "stream.committed");
        assert_eq!(
            tokio::fs::read(destination_root.path().join("destination.bin"))
                .await
                .unwrap(),
            source_bytes
        );
        assert!(source_root.path().join("source.bin").exists());

        destination_channel
            .send_text(
                json!({
                    "version": RTC_PROTOCOL_VERSION,
                    "type": "stream.ack",
                    "stream_id": source_stream_id,
                    "sequence": 1,
                })
                .to_string(),
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while destination_channel.ready_state()
                != webrtc::data_channel::data_channel_state::RTCDataChannelState::Closed
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("a source-host stream id must be rejected on the destination channel");
        assert_eq!(
            source_channel.ready_state(),
            webrtc::data_channel::data_channel_state::RTCDataChannelState::Open
        );

        source_browser.close().await.unwrap();
        source_daemon.close().await.unwrap();
        destination_browser.close().await.unwrap();
        destination_daemon.close().await.unwrap();
    }

    fn assert_no_upload_temporaries(root: &Path) {
        assert_eq!(
            std::fs::read_dir(root)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".spawn-upload-"))
                .count(),
            0,
            "session shutdown leaked a write temporary",
        );
    }

    #[tokio::test]
    async fn closing_after_host_context_publication_suppresses_hello_and_connected_status() {
        let root = tempfile::tempdir().unwrap();
        let files = Arc::new(HostFileService::rooted_at(root.path()).await.unwrap());
        let hooks = files.write_lifecycle_test_hooks();
        hooks.arm_open_after_context();
        let binding = HostRtcBinding {
            host_id: Uuid::new_v4(),
            binding_nonce: "d".repeat(32),
            binding_generation: 1,
            protocol: HOST_CONTROL_LABEL.to_string(),
            protocol_version: RTC_PROTOCOL_VERSION,
        };
        let (browser_pc, daemon_pc, channel, mut messages, mut statuses) =
            start_paired_host_endpoint(files, binding, "close-after-host-context").await;
        tokio::time::timeout(Duration::from_secs(2), hooks.wait_open_after_context())
            .await
            .expect("host open did not pause after context publication");

        let closing_channel = Arc::clone(&channel);
        let close = tokio::spawn(async move { closing_channel.close().await });
        tokio::time::timeout(Duration::from_millis(500), hooks.wait_shutdown_returned())
            .await
            .expect("host close exceeded its absolute deadline");
        close.await.unwrap().unwrap();
        tokio::task::yield_now().await;

        assert!(messages.try_recv().is_err(), "hello published after close");
        assert!(
            statuses.try_recv().is_err(),
            "connected status published after close"
        );
        close_test_peer(&browser_pc).await;
        close_test_peer(&daemon_pc).await;
    }

    #[tokio::test]
    async fn closing_between_hello_and_connected_suppresses_connected_status() {
        let root = tempfile::tempdir().unwrap();
        let files = Arc::new(HostFileService::rooted_at(root.path()).await.unwrap());
        let hooks = files.write_lifecycle_test_hooks();
        hooks.arm_open_before_connected();
        let binding = HostRtcBinding {
            host_id: Uuid::new_v4(),
            binding_nonce: "e".repeat(32),
            binding_generation: 1,
            protocol: HOST_CONTROL_LABEL.to_string(),
            protocol_version: RTC_PROTOCOL_VERSION,
        };
        let (browser_pc, daemon_pc, channel, mut messages, mut statuses) =
            start_paired_host_endpoint(files, binding, "close-before-connected").await;
        tokio::time::timeout(Duration::from_secs(2), hooks.wait_open_before_connected())
            .await
            .expect("host open did not pause before connected publication");
        let (_, hello) = receive_host_control(&mut messages).await;
        assert_eq!(hello.get("type").and_then(Value::as_str), Some("hello"));

        let closing_channel = Arc::clone(&channel);
        let close = tokio::spawn(async move { closing_channel.close().await });
        tokio::time::timeout(Duration::from_millis(500), hooks.wait_shutdown_returned())
            .await
            .expect("host close exceeded its absolute deadline");
        close.await.unwrap().unwrap();
        tokio::task::yield_now().await;

        assert!(
            statuses.try_recv().is_err(),
            "connected status published after close"
        );
        close_test_peer(&browser_pc).await;
        close_test_peer(&daemon_pc).await;
    }

    #[tokio::test]
    async fn close_cancels_a_presend_hello_claim_before_shutdown_returns() {
        let root = tempfile::tempdir().unwrap();
        let files = Arc::new(HostFileService::rooted_at(root.path()).await.unwrap());
        let hooks = files.write_lifecycle_test_hooks();
        hooks.arm_open_after_publication_claim();
        let binding = HostRtcBinding {
            host_id: Uuid::new_v4(),
            binding_nonce: "9".repeat(32),
            binding_generation: 1,
            protocol: HOST_CONTROL_LABEL.to_string(),
            protocol_version: RTC_PROTOCOL_VERSION,
        };
        let (browser_pc, daemon_pc, channel, mut messages, mut statuses) =
            start_paired_host_endpoint(files, binding, "close-after-hello-claim").await;
        tokio::time::timeout(
            Duration::from_secs(2),
            hooks.wait_open_after_publication_claim(),
        )
        .await
        .expect("hello did not claim publication");

        let closing_channel = Arc::clone(&channel);
        let close = tokio::spawn(async move { closing_channel.close().await });
        tokio::time::timeout(Duration::from_secs(2), hooks.wait_shutdown_started())
            .await
            .expect("close did not cancel the hello claim");
        tokio::time::timeout(Duration::from_millis(500), hooks.wait_shutdown_returned())
            .await
            .expect("claimed hello send survived the close deadline");
        tokio::time::timeout(
            Duration::from_secs(2),
            hooks.wait_publication_send_finished(),
        )
        .await
        .expect("cancelled hello claim did not drain");
        close.await.unwrap().unwrap();
        hooks.release_open_after_publication_claim();
        tokio::task::yield_now().await;
        assert!(
            messages.try_recv().is_err(),
            "hello published after shutdown returned"
        );
        assert!(
            statuses.try_recv().is_err(),
            "connected status claimed publication after close"
        );
        close_test_peer(&browser_pc).await;
        close_test_peer(&daemon_pc).await;
    }

    #[tokio::test]
    async fn host_control_rejects_unordered_and_partially_reliable_channels() {
        let cases = [
            (
                "unordered",
                webrtc::data_channel::data_channel_init::RTCDataChannelInit {
                    ordered: Some(false),
                    ..Default::default()
                },
            ),
            (
                "packet-lifetime",
                webrtc::data_channel::data_channel_init::RTCDataChannelInit {
                    max_packet_life_time: Some(1),
                    ..Default::default()
                },
            ),
            (
                "retransmits",
                webrtc::data_channel::data_channel_init::RTCDataChannelInit {
                    max_retransmits: Some(1),
                    ..Default::default()
                },
            ),
        ];
        for (label, init) in cases {
            let root = tempfile::tempdir().unwrap();
            let files = Arc::new(HostFileService::rooted_at(root.path()).await.unwrap());
            let binding = HostRtcBinding {
                host_id: Uuid::new_v4(),
                binding_nonce: "4".repeat(32),
                binding_generation: 1,
                protocol: HOST_CONTROL_LABEL.to_string(),
                protocol_version: RTC_PROTOCOL_VERSION,
            };
            let (browser_pc, daemon_pc, channel, mut messages, mut statuses) =
                start_paired_host_endpoint_with_init(
                    files,
                    binding,
                    &format!("invalid-host-channel-{label}"),
                    Some(init),
                )
                .await;
            wait_for_host_channel_close(&channel).await;
            assert!(messages.try_recv().is_err(), "{label} received a hello");
            assert!(
                statuses.try_recv().is_err(),
                "{label} published connected status"
            );
            close_test_peer(&browser_pc).await;
            close_test_peer(&daemon_pc).await;
        }
    }

    #[tokio::test]
    async fn closing_host_channel_during_write_begin_cleans_unpublished_temporary() {
        let root = tempfile::tempdir().unwrap();
        let files = Arc::new(HostFileService::rooted_at(root.path()).await.unwrap());
        let hooks = files.write_lifecycle_test_hooks();
        let binding = HostRtcBinding {
            host_id: Uuid::new_v4(),
            binding_nonce: "e".repeat(32),
            binding_generation: 1,
            protocol: HOST_CONTROL_LABEL.to_string(),
            protocol_version: RTC_PROTOCOL_VERSION,
        };
        let (browser_pc, daemon_pc, channel, mut messages) =
            paired_host_endpoint(files, binding, "close-during-write-begin").await;

        hooks.arm_begin_after_create();
        channel
            .send_text(
                json!({
                    "version": RTC_PROTOCOL_VERSION,
                    "type": "request",
                    "request_id": "close-begin",
                    "operation": "fs.write.begin",
                    "payload": {
                        "dir": "~",
                        "name": "must-not-exist.bin",
                        "length": 0,
                        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                        "overwrite": false,
                    },
                })
                .to_string(),
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), hooks.wait_begin_after_create())
            .await
            .expect("write begin did not pause after temporary creation");

        let closing_channel = Arc::clone(&channel);
        let close = tokio::spawn(async move { closing_channel.close().await });
        tokio::time::timeout(Duration::from_secs(2), hooks.wait_shutdown_started())
            .await
            .expect("host write shutdown did not start");
        tokio::time::timeout(Duration::from_millis(500), hooks.wait_shutdown_returned())
            .await
            .expect("host write shutdown did not terminate");
        assert!(!root.path().join("must-not-exist.bin").exists());
        assert_no_upload_temporaries(root.path());

        hooks.release_begin_after_create();
        close.await.unwrap().unwrap();
        tokio::task::yield_now().await;

        assert!(!root.path().join("must-not-exist.bin").exists());
        assert_no_upload_temporaries(root.path());
        assert!(
            messages.try_recv().is_err(),
            "write begin published after close"
        );
        close_test_peer(&browser_pc).await;
        close_test_peer(&daemon_pc).await;
    }

    #[tokio::test]
    async fn closing_host_channel_before_write_commit_aborts_finish_and_cleans_temporary() {
        let root = tempfile::tempdir().unwrap();
        let files = Arc::new(HostFileService::rooted_at(root.path()).await.unwrap());
        let hooks = files.write_lifecycle_test_hooks();
        let binding = HostRtcBinding {
            host_id: Uuid::new_v4(),
            binding_nonce: "f".repeat(32),
            binding_generation: 1,
            protocol: HOST_CONTROL_LABEL.to_string(),
            protocol_version: RTC_PROTOCOL_VERSION,
        };
        let (browser_pc, daemon_pc, channel, mut messages) =
            paired_host_endpoint(files, binding, "close-before-write-commit").await;
        let sha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        let write = request_host_control(
            &channel,
            &mut messages,
            "close-finish",
            "fs.write.begin",
            json!({
                "dir": "~",
                "name": "must-not-commit.bin",
                "length": 0,
                "sha256": sha256,
                "overwrite": false,
            }),
        )
        .await;
        let stream_id = write["result"]["stream_id"].as_str().unwrap();

        hooks.arm_blocking(HostOperationKind::WriteCommit);
        channel
            .send_text(
                json!({
                    "version": RTC_PROTOCOL_VERSION,
                    "type": "stream.end",
                    "stream_id": stream_id,
                    "length": 0,
                    "sha256": sha256,
                })
                .to_string(),
            )
            .await
            .unwrap();
        tokio::time::timeout(
            Duration::from_secs(2),
            hooks.wait_blocking_entered(HostOperationKind::WriteCommit),
        )
        .await
        .expect("write finish did not pause before commit");

        let closing_channel = Arc::clone(&channel);
        let close = tokio::spawn(async move { closing_channel.close().await });
        tokio::time::timeout(Duration::from_secs(2), hooks.wait_shutdown_started())
            .await
            .expect("host write shutdown did not start");
        tokio::time::timeout(Duration::from_millis(500), hooks.wait_shutdown_returned())
            .await
            .expect("host write shutdown did not terminate");
        assert!(!root.path().join("must-not-commit.bin").exists());
        assert_no_upload_temporaries(root.path());

        hooks.release_blocking(HostOperationKind::WriteCommit);
        tokio::time::timeout(
            Duration::from_secs(2),
            hooks.wait_blocking_finished(HostOperationKind::WriteCommit),
        )
        .await
        .expect("write commit operation did not finish");
        close.await.unwrap().unwrap();

        assert!(!root.path().join("must-not-commit.bin").exists());
        assert_no_upload_temporaries(root.path());
        assert!(
            messages.try_recv().is_err(),
            "write commit published after close"
        );
        close_test_peer(&browser_pc).await;
        close_test_peer(&daemon_pc).await;
    }

    #[tokio::test]
    async fn stalled_temporary_unlink_cannot_extend_close_or_resurrect_a_write() {
        let root = tempfile::tempdir().unwrap();
        let files = Arc::new(HostFileService::rooted_at(root.path()).await.unwrap());
        let hooks = files.write_lifecycle_test_hooks();
        let binding = HostRtcBinding {
            host_id: Uuid::new_v4(),
            binding_nonce: "0".repeat(32),
            binding_generation: 1,
            protocol: HOST_CONTROL_LABEL.to_string(),
            protocol_version: RTC_PROTOCOL_VERSION,
        };
        let (browser_pc, daemon_pc, channel, mut messages) =
            paired_host_endpoint(files, binding, "stalled-temp-cleanup").await;
        let write = request_host_control(
            &channel,
            &mut messages,
            "stalled-cleanup",
            "fs.write.begin",
            json!({
                "dir": "~",
                "name": "must-stay-uncommitted.bin",
                "length": 0,
                "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                "overwrite": false,
            }),
        )
        .await;
        assert!(write["result"]["stream_id"].is_string());

        hooks.arm_temporary_cleanup();
        let closing_channel = Arc::clone(&channel);
        let close = tokio::spawn(async move { closing_channel.close().await });
        tokio::time::timeout(
            Duration::from_secs(2),
            hooks.wait_temporary_cleanup_entered(),
        )
        .await
        .expect("temporary cleanup did not enter its blocking unlink");
        tokio::time::timeout(Duration::from_millis(500), hooks.wait_shutdown_returned())
            .await
            .expect("stalled temporary unlink extended the close deadline");
        close.await.unwrap().unwrap();

        assert!(!root.path().join("must-stay-uncommitted.bin").exists());
        assert!(root.path().read_dir().unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".spawn-upload-")));

        hooks.release_temporary_cleanup();
        tokio::time::timeout(
            Duration::from_secs(2),
            hooks.wait_temporary_cleanup_finished(),
        )
        .await
        .expect("late temporary cleanup did not finish");
        assert!(!root.path().join("must-stay-uncommitted.bin").exists());
        assert_no_upload_temporaries(root.path());
        assert!(
            messages.try_recv().is_err(),
            "stalled cleanup published after close"
        );
        close_test_peer(&browser_pc).await;
        close_test_peer(&daemon_pc).await;
    }

    #[tokio::test]
    async fn stalled_blocking_host_operations_cannot_outlive_close_with_effects() {
        let cases = [
            (
                HostOperationKind::List,
                "list",
                "stalled-list",
                "fs.list",
                json!({"path": "~", "cursor": 0}),
            ),
            (
                HostOperationKind::Read,
                "read",
                "stalled-read",
                "fs.read",
                json!({"path": "read.txt"}),
            ),
            (
                HostOperationKind::Mkdir,
                "mkdir",
                "stalled-mkdir",
                "fs.mkdir",
                json!({"path": "new-dir"}),
            ),
            (
                HostOperationKind::Rename,
                "rename",
                "stalled-rename",
                "fs.rename",
                json!({"path": "source.txt", "name": "renamed.txt", "overwrite": false}),
            ),
            (
                HostOperationKind::Remove,
                "remove",
                "stalled-remove",
                "fs.remove",
                json!({"path": "victim.txt", "recursive": false}),
            ),
            (
                HostOperationKind::WriteBegin,
                "write",
                "stalled-write",
                "fs.write.begin",
                json!({
                    "dir": "~",
                    "name": "blocked-write.bin",
                    "length": 0,
                    "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                    "overwrite": false,
                }),
            ),
        ];

        for (kind, label, request_id, operation, payload) in cases {
            let root = tempfile::tempdir().unwrap();
            tokio::fs::write(root.path().join("read.txt"), b"read")
                .await
                .unwrap();
            tokio::fs::write(root.path().join("source.txt"), b"source")
                .await
                .unwrap();
            tokio::fs::write(root.path().join("victim.txt"), b"victim")
                .await
                .unwrap();
            let files = Arc::new(HostFileService::rooted_at(root.path()).await.unwrap());
            let hooks = files.write_lifecycle_test_hooks();
            let binding = HostRtcBinding {
                host_id: Uuid::new_v4(),
                binding_nonce: "1".repeat(32),
                binding_generation: 1,
                protocol: HOST_CONTROL_LABEL.to_string(),
                protocol_version: RTC_PROTOCOL_VERSION,
            };
            let (browser_pc, daemon_pc, channel, mut messages) =
                paired_host_endpoint(files, binding, &format!("blocking-close-{label}")).await;

            hooks.arm_blocking(kind);
            channel
                .send_text(
                    json!({
                        "version": RTC_PROTOCOL_VERSION,
                        "type": "request",
                        "request_id": request_id,
                        "operation": operation,
                        "payload": payload,
                    })
                    .to_string(),
                )
                .await
                .unwrap();
            tokio::time::timeout(Duration::from_secs(2), hooks.wait_blocking_entered(kind))
                .await
                .unwrap_or_else(|_| panic!("{label} did not enter its blocking operation"));

            let closing_channel = Arc::clone(&channel);
            let close = tokio::spawn(async move { closing_channel.close().await });
            tokio::time::timeout(Duration::from_secs(2), hooks.wait_shutdown_started())
                .await
                .unwrap_or_else(|_| panic!("{label} shutdown did not start"));
            tokio::time::timeout(Duration::from_millis(500), hooks.wait_shutdown_returned())
                .await
                .unwrap_or_else(|_| panic!("{label} shutdown exceeded its absolute deadline"));

            assert!(!root.path().join("new-dir").exists(), "{label}");
            assert!(root.path().join("source.txt").exists(), "{label}");
            assert!(!root.path().join("renamed.txt").exists(), "{label}");
            assert!(root.path().join("victim.txt").exists(), "{label}");
            assert!(!root.path().join("blocked-write.bin").exists(), "{label}");
            assert_no_upload_temporaries(root.path());

            hooks.release_blocking(kind);
            tokio::time::timeout(Duration::from_secs(2), hooks.wait_blocking_finished(kind))
                .await
                .unwrap_or_else(|_| panic!("{label} blocking operation did not finish"));
            close.await.unwrap().unwrap();
            assert!(
                messages.try_recv().is_err(),
                "{label} published after close"
            );
            assert!(!root.path().join("new-dir").exists(), "{label}");
            assert!(root.path().join("source.txt").exists(), "{label}");
            assert!(!root.path().join("renamed.txt").exists(), "{label}");
            assert!(root.path().join("victim.txt").exists(), "{label}");
            assert!(!root.path().join("blocked-write.bin").exists(), "{label}");
            assert_no_upload_temporaries(root.path());
            close_test_peer(&browser_pc).await;
            close_test_peer(&daemon_pc).await;
        }
    }

    #[tokio::test]
    async fn linearized_mutations_may_finish_after_bounded_close_without_publication() {
        let cases = [
            (
                HostOperationKind::Mkdir,
                "mkdir",
                "linearized-mkdir",
                "fs.mkdir",
                json!({"path": "new-dir"}),
            ),
            (
                HostOperationKind::Rename,
                "rename",
                "linearized-rename",
                "fs.rename",
                json!({"path": "source.txt", "name": "renamed.txt", "overwrite": false}),
            ),
            (
                HostOperationKind::Remove,
                "remove",
                "linearized-remove",
                "fs.remove",
                json!({"path": "victim.txt", "recursive": false}),
            ),
        ];

        for (kind, label, request_id, operation, payload) in cases {
            let root = tempfile::tempdir().unwrap();
            tokio::fs::write(root.path().join("source.txt"), b"source")
                .await
                .unwrap();
            tokio::fs::write(root.path().join("victim.txt"), b"victim")
                .await
                .unwrap();
            let files = Arc::new(HostFileService::rooted_at(root.path()).await.unwrap());
            let hooks = files.write_lifecycle_test_hooks();
            let binding = HostRtcBinding {
                host_id: Uuid::new_v4(),
                binding_nonce: "2".repeat(32),
                binding_generation: 1,
                protocol: HOST_CONTROL_LABEL.to_string(),
                protocol_version: RTC_PROTOCOL_VERSION,
            };
            let (browser_pc, daemon_pc, channel, mut messages) =
                paired_host_endpoint(files, binding, &format!("effect-close-{label}")).await;

            hooks.arm_effect_boundary(kind);
            channel
                .send_text(
                    json!({
                        "version": RTC_PROTOCOL_VERSION,
                        "type": "request",
                        "request_id": request_id,
                        "operation": operation,
                        "payload": payload,
                    })
                    .to_string(),
                )
                .await
                .unwrap();
            tokio::time::timeout(
                Duration::from_secs(2),
                hooks.wait_effect_boundary_entered(kind),
            )
            .await
            .unwrap_or_else(|_| panic!("{label} did not reach the effect linearization boundary"));

            let closing_channel = Arc::clone(&channel);
            let close = tokio::spawn(async move { closing_channel.close().await });
            tokio::time::timeout(Duration::from_millis(500), hooks.wait_shutdown_returned())
                .await
                .unwrap_or_else(|_| panic!("{label} close exceeded its absolute deadline"));

            assert!(!root.path().join("new-dir").exists(), "{label}");
            assert!(root.path().join("source.txt").exists(), "{label}");
            assert!(!root.path().join("renamed.txt").exists(), "{label}");
            assert!(root.path().join("victim.txt").exists(), "{label}");
            hooks.release_effect_boundary(kind);
            tokio::time::timeout(Duration::from_secs(2), hooks.wait_blocking_finished(kind))
                .await
                .unwrap_or_else(|_| panic!("{label} authorized effect did not finish"));
            close.await.unwrap().unwrap();

            assert!(
                messages.try_recv().is_err(),
                "{label} published after close"
            );
            match label {
                "mkdir" => assert!(root.path().join("new-dir").is_dir()),
                "rename" => {
                    assert!(!root.path().join("source.txt").exists());
                    assert_eq!(
                        tokio::fs::read(root.path().join("renamed.txt"))
                            .await
                            .unwrap(),
                        b"source"
                    );
                }
                "remove" => assert!(!root.path().join("victim.txt").exists()),
                _ => unreachable!(),
            }
            assert_no_upload_temporaries(root.path());
            close_test_peer(&browser_pc).await;
            close_test_peer(&daemon_pc).await;
        }
    }

    #[tokio::test]
    async fn linearized_write_commit_finishes_after_bounded_close_without_publication_or_temp() {
        let root = tempfile::tempdir().unwrap();
        let files = Arc::new(HostFileService::rooted_at(root.path()).await.unwrap());
        let hooks = files.write_lifecycle_test_hooks();
        let binding = HostRtcBinding {
            host_id: Uuid::new_v4(),
            binding_nonce: "3".repeat(32),
            binding_generation: 1,
            protocol: HOST_CONTROL_LABEL.to_string(),
            protocol_version: RTC_PROTOCOL_VERSION,
        };
        let (browser_pc, daemon_pc, channel, mut messages) =
            paired_host_endpoint(files, binding, "linearized-write-close").await;
        let sha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        let write = request_host_control(
            &channel,
            &mut messages,
            "linearized-write",
            "fs.write.begin",
            json!({
                "dir": "~",
                "name": "committed.bin",
                "length": 0,
                "sha256": sha256,
                "overwrite": false,
            }),
        )
        .await;
        let stream_id = write["result"]["stream_id"].as_str().unwrap();

        hooks.arm_effect_boundary(HostOperationKind::WriteCommit);
        channel
            .send_text(
                json!({
                    "version": RTC_PROTOCOL_VERSION,
                    "type": "stream.end",
                    "stream_id": stream_id,
                    "length": 0,
                    "sha256": sha256,
                })
                .to_string(),
            )
            .await
            .unwrap();
        tokio::time::timeout(
            Duration::from_secs(2),
            hooks.wait_effect_boundary_entered(HostOperationKind::WriteCommit),
        )
        .await
        .expect("write did not reach the commit linearization boundary");

        let closing_channel = Arc::clone(&channel);
        let close = tokio::spawn(async move { closing_channel.close().await });
        tokio::time::timeout(Duration::from_millis(500), hooks.wait_shutdown_returned())
            .await
            .expect("linearized write close exceeded its absolute deadline");
        assert!(!root.path().join("committed.bin").exists());
        hooks.release_effect_boundary(HostOperationKind::WriteCommit);
        tokio::time::timeout(
            Duration::from_secs(2),
            hooks.wait_blocking_finished(HostOperationKind::WriteCommit),
        )
        .await
        .expect("authorized write commit did not finish");
        close.await.unwrap().unwrap();

        assert_eq!(
            tokio::fs::read(root.path().join("committed.bin"))
                .await
                .unwrap(),
            b""
        );
        assert!(messages.try_recv().is_err(), "write published after close");
        assert_no_upload_temporaries(root.path());
        close_test_peer(&browser_pc).await;
        close_test_peer(&daemon_pc).await;
    }

    #[tokio::test]
    async fn published_write_cancel_wins_while_the_fast_consumer_is_delayed() {
        for terminal in ["chunk", "end"] {
            let root = tempfile::tempdir().unwrap();
            tokio::fs::write(root.path().join("empty.bin"), [])
                .await
                .unwrap();
            let files = Arc::new(HostFileService::rooted_at(root.path()).await.unwrap());
            let binding = HostRtcBinding {
                host_id: Uuid::new_v4(),
                binding_nonce: "c".repeat(32),
                binding_generation: 1,
                protocol: HOST_CONTROL_LABEL.to_string(),
                protocol_version: RTC_PROTOCOL_VERSION,
            };
            let (browser_pc, daemon_pc, channel, mut messages) =
                paired_host_endpoint(files, binding, &format!("cancel-race-{terminal}")).await;

            let read = request_host_control(
                &channel,
                &mut messages,
                &format!("finished-read-{terminal}"),
                "fs.read",
                json!({"path": "empty.bin"}),
            )
            .await;
            let finished_read_id = read["result"]["stream_id"].as_str().unwrap();
            let (_, read_end) = receive_host_control(&mut messages).await;
            assert_eq!(read_end["type"], "stream.end");

            let (name, length, sha256) = if terminal == "chunk" {
                (
                    "late-chunk.bin",
                    1,
                    "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
                )
            } else {
                (
                    "late-end.bin",
                    0,
                    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                )
            };
            let write = request_host_control(
                &channel,
                &mut messages,
                &format!("cancelled-write-{terminal}"),
                "fs.write.begin",
                json!({
                    "dir": "~",
                    "name": name,
                    "length": length,
                    "sha256": sha256,
                    "overwrite": false,
                }),
            )
            .await;
            let stream_id = write["result"]["stream_id"].as_str().unwrap();

            channel
                .send_text(
                    json!({
                        "version": RTC_PROTOCOL_VERSION,
                        "type": "stream.ack",
                        "stream_id": finished_read_id,
                        "sequence": 0,
                        "test_delay_ms": 250,
                    })
                    .to_string(),
                )
                .await
                .unwrap();
            channel
                .send_text(
                    json!({
                        "version": RTC_PROTOCOL_VERSION,
                        "type": "stream.cancel",
                        "stream_id": stream_id,
                    })
                    .to_string(),
                )
                .await
                .unwrap();
            let terminal_frame = if terminal == "chunk" {
                json!({
                    "version": RTC_PROTOCOL_VERSION,
                    "type": "stream.chunk",
                    "stream_id": stream_id,
                    "sequence": 0,
                    (DIRECT_ENDPOINT_BYTES_FIELD): STANDARD.encode(b"x"),
                })
            } else {
                json!({
                    "version": RTC_PROTOCOL_VERSION,
                    "type": "stream.end",
                    "stream_id": stream_id,
                    "length": 0,
                    "sha256": sha256,
                })
            };
            channel.send_text(terminal_frame.to_string()).await.unwrap();

            wait_for_host_channel_close(&channel).await;
            assert!(!root.path().join(name).exists());
            assert_eq!(
                std::fs::read_dir(root.path())
                    .unwrap()
                    .filter_map(Result::ok)
                    .filter(|entry| entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".spawn-upload-"))
                    .count(),
                0,
                "cancelled write temporary was not removed",
            );
            browser_pc.close().await.unwrap();
            daemon_pc.close().await.unwrap();
        }
    }

    #[tokio::test]
    async fn stalled_write_cancel_does_not_block_read_ack_or_cancel() {
        let root = tempfile::tempdir().unwrap();
        let source_bytes = vec![b'r'; STREAM_CHUNK_BYTES * 9];
        tokio::fs::write(root.path().join("ack.bin"), &source_bytes)
            .await
            .unwrap();
        tokio::fs::write(root.path().join("cancel.bin"), &source_bytes)
            .await
            .unwrap();
        let files = Arc::new(HostFileService::rooted_at(root.path()).await.unwrap());
        let write_hooks = files.write_lifecycle_test_hooks();
        let binding = HostRtcBinding {
            host_id: Uuid::new_v4(),
            binding_nonce: "d".repeat(32),
            binding_generation: 1,
            protocol: HOST_CONTROL_LABEL.to_string(),
            protocol_version: RTC_PROTOCOL_VERSION,
        };
        let (browser_pc, daemon_pc, channel, mut messages) =
            paired_host_endpoint(files, binding, "stalled-write-control-paths").await;

        // Establish the write stream before either read can publish chunks.
        // This request is setup, not part of the fast-path ordering under test.
        let write = request_host_control(
            &channel,
            &mut messages,
            "stalled-write",
            "fs.write.begin",
            json!({
                "dir": "~",
                "name": "stalled-write.bin",
                "length": 1,
                "sha256": "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
                "overwrite": false,
            }),
        )
        .await;
        let write_stream_id = write["result"]["stream_id"]
            .as_str()
            .unwrap_or_else(|| panic!("write setup did not return a stream id: {write}"));

        let ack_read = request_host_control(
            &channel,
            &mut messages,
            "concurrent-ack-read",
            "fs.read",
            json!({"path": "ack.bin"}),
        )
        .await;
        let ack_stream_id = ack_read["result"]["stream_id"].as_str().unwrap();
        for sequence in 0..8 {
            let (_, chunk) = receive_host_control(&mut messages).await;
            assert_eq!(chunk["stream_id"], ack_stream_id);
            assert_eq!(chunk["sequence"], sequence);
        }

        let cancel_read = request_host_control(
            &channel,
            &mut messages,
            "concurrent-cancel-read",
            "fs.read",
            json!({"path": "cancel.bin"}),
        )
        .await;
        let cancel_stream_id = cancel_read["result"]["stream_id"].as_str().unwrap();
        for sequence in 0..8 {
            let (_, chunk) = receive_host_control(&mut messages).await;
            assert_eq!(chunk["stream_id"], cancel_stream_id);
            assert_eq!(chunk["sequence"], sequence);
        }

        channel
            .send_text(
                json!({
                    "version": RTC_PROTOCOL_VERSION,
                    "type": "stream.chunk",
                    "stream_id": write_stream_id,
                    "sequence": 0,
                    (DIRECT_ENDPOINT_BYTES_FIELD): STANDARD.encode(b"x"),
                    "test_delay_ms": 1_000,
                })
                .to_string(),
            )
            .await
            .unwrap();
        tokio::time::timeout(
            Duration::from_secs(2),
            write_hooks.wait_write_delay_entered(),
        )
        .await
        .expect("stalled write chunk did not enter its delayed normal path");

        for frame in [
            json!({
                "version": RTC_PROTOCOL_VERSION,
                "type": "stream.cancel",
                "stream_id": write_stream_id,
            }),
            json!({
                "version": RTC_PROTOCOL_VERSION,
                "type": "stream.ack",
                "stream_id": ack_stream_id,
                "sequence": 8,
            }),
            json!({
                "version": RTC_PROTOCOL_VERSION,
                "type": "stream.cancel",
                "stream_id": cancel_stream_id,
            }),
            json!({
                "version": RTC_PROTOCOL_VERSION,
                "type": "request",
                "request_id": "after-stalled-write-cancel",
                "operation": "ping",
                "payload": {},
            }),
        ] {
            channel.send_text(frame.to_string()).await.unwrap();
        }

        let mut saw_final_ack_chunk = false;
        let mut saw_ack_end = false;
        let mut saw_ping = false;
        tokio::time::timeout(Duration::from_millis(750), async {
            while !(saw_final_ack_chunk && saw_ack_end && saw_ping) {
                let (_, message) = receive_host_control(&mut messages).await;
                if message["request_id"] == "after-stalled-write-cancel" {
                    assert_eq!(message["result"]["pong"], true);
                    saw_ping = true;
                } else if message["stream_id"] == ack_stream_id && message["type"] == "stream.chunk"
                {
                    assert_eq!(message["sequence"], 8);
                    saw_final_ack_chunk = true;
                } else if message["stream_id"] == ack_stream_id && message["type"] == "stream.end" {
                    saw_ack_end = true;
                } else {
                    panic!("unexpected host-control message: {message}");
                }
            }
        })
        .await
        .expect("write cancellation blocked an unrelated fast control path");
        assert_eq!(
            channel.ready_state(),
            webrtc::data_channel::data_channel_state::RTCDataChannelState::Open
        );
        tokio::time::timeout(Duration::from_millis(750), async {
            while std::fs::read_dir(root.path())
                .unwrap()
                .filter_map(Result::ok)
                .any(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".spawn-upload-")
                })
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancelled write cleanup did not drain promptly");
        assert!(!root.path().join("stalled-write.bin").exists());

        browser_pc.close().await.unwrap();
        daemon_pc.close().await.unwrap();
    }

    #[tokio::test]
    async fn zero_session_host_files_round_trip_over_paired_data_channel() {
        let mut media_engine = MediaEngine::default();
        media_engine.register_default_codecs().unwrap();
        let api = APIBuilder::new().with_media_engine(media_engine).build();
        let browser_pc = Arc::new(
            api.new_peer_connection(RTCConfiguration::default())
                .await
                .unwrap(),
        );
        let daemon_pc = Arc::new(
            api.new_peer_connection(RTCConfiguration::default())
                .await
                .unwrap(),
        );
        let channel = browser_pc
            .create_data_channel(HOST_CONTROL_LABEL, None)
            .await
            .unwrap();
        let extra_channel = browser_pc
            .create_data_channel(HOST_CONTROL_LABEL, None)
            .await
            .unwrap();
        let (messages_tx, mut messages_rx) = mpsc::channel::<(usize, String)>(32);
        for (index, data_channel) in [(0, &channel), (1, &extra_channel)] {
            let messages_tx = messages_tx.clone();
            data_channel.on_message(Box::new(move |message: DataChannelMessage| {
                let messages_tx = messages_tx.clone();
                Box::pin(async move {
                    let _ = messages_tx
                        .send((index, String::from_utf8_lossy(&message.data).into_owned()))
                        .await;
                })
            }));
        }

        let host_id = Uuid::new_v4();
        let binding = HostRtcBinding {
            host_id,
            binding_nonce: "d".repeat(32),
            binding_generation: 1,
            protocol: HOST_CONTROL_LABEL.to_string(),
            protocol_version: RTC_PROTOCOL_VERSION,
        };
        let (out_tx, mut out_rx) = mpsc::channel(4);
        let file_root = tempfile::tempdir().unwrap();
        tokio::fs::write(file_root.path().join("source.txt"), b"source body")
            .await
            .unwrap();
        tokio::fs::write(
            file_root.path().join("hash-cancel.bin"),
            vec![b'h'; 16 * 1024 * 1024],
        )
        .await
        .unwrap();
        let files = Arc::new(HostFileService::rooted_at(file_root.path()).await.unwrap());
        let signaling = RtcWsSender::default();
        signaling.install(out_tx);
        install_host_data_channel_handler(
            &daemon_pc,
            "host-e2e".to_string(),
            binding,
            signaling,
            Some(Arc::clone(&files)),
        );

        let offer = browser_pc.create_offer(None).await.unwrap();
        let mut offer_gathered = browser_pc.gathering_complete_promise().await;
        browser_pc.set_local_description(offer).await.unwrap();
        let _ = offer_gathered.recv().await;
        daemon_pc
            .set_remote_description(browser_pc.local_description().await.unwrap())
            .await
            .unwrap();
        let answer = daemon_pc.create_answer(None).await.unwrap();
        let mut answer_gathered = daemon_pc.gathering_complete_promise().await;
        daemon_pc.set_local_description(answer).await.unwrap();
        let _ = answer_gathered.recv().await;
        browser_pc
            .set_remote_description(daemon_pc.local_description().await.unwrap())
            .await
            .unwrap();

        let (accepted_index, hello) =
            tokio::time::timeout(Duration::from_secs(10), messages_rx.recv())
                .await
                .expect("host control channel did not open")
                .expect("host control channel closed before hello");
        let hello: Value = serde_json::from_str(&hello).unwrap();
        assert_eq!(hello["type"], "hello");
        assert_eq!(hello["protocol"], HOST_CONTROL_LABEL);
        assert_eq!(hello["limits"]["normal_queue"], 64);
        assert_eq!(hello["limits"]["fast_queue"], 64);
        assert_eq!(hello["limits"]["long_tasks"], 8);
        assert_eq!(hello["limits"]["write_reapers"], 1);
        assert_eq!(hello["limits"]["directory_entries"], 1024);
        assert!(
            tokio::time::timeout(Duration::from_millis(250), messages_rx.recv())
                .await
                .is_err()
        );
        let server_frame = tokio::time::timeout(Duration::from_secs(2), out_rx.recv())
            .await
            .expect("host connected signal was not published")
            .expect("host server uplink closed before connected signal");
        let server_frame: Value = serde_json::from_str(server_frame.as_str()).unwrap();
        assert_eq!(server_frame["type"], "rtc.status");
        assert_eq!(server_frame["session_id"], "host-e2e");
        assert_eq!(server_frame["scope_type"], "host");
        assert_eq!(server_frame["scope_id"], host_id.to_string());
        assert_eq!(server_frame["protocol"], HOST_CONTROL_LABEL);
        assert_eq!(server_frame["protocol_version"], RTC_PROTOCOL_VERSION);
        assert_eq!(server_frame["status"], "connected");

        let accepted_channel = if accepted_index == 0 {
            &channel
        } else {
            &extra_channel
        };
        accepted_channel
            .send_text(
                json!({
                    "version": RTC_PROTOCOL_VERSION,
                    "type": "request",
                    "request_id": "e2e-ping",
                    "operation": "ping"
                })
                .to_string(),
            )
            .await
            .unwrap();
        let (_, response) = tokio::time::timeout(Duration::from_secs(10), messages_rx.recv())
            .await
            .expect("host control ping timed out")
            .expect("host control channel closed before ping response");
        let response: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(response["request_id"], "e2e-ping");
        assert_eq!(response["result"]["pong"], true);

        let listing = request_host_control(
            accepted_channel,
            &mut messages_rx,
            "e2e-list",
            "fs.list",
            json!({"path": "~", "cursor": 0}),
        )
        .await;
        assert_eq!(listing["result"]["home_dir"], files.home_dir());
        assert!(listing["result"]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["name"] == "source.txt"));

        let upload = (0..(STREAM_CHUNK_BYTES * 20 + 73))
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        let upload_hash = format!("{:x}", Sha256::digest(&upload));
        let write_started = request_host_control(
            accepted_channel,
            &mut messages_rx,
            "e2e-write",
            "fs.write.begin",
            json!({
                "dir": "~",
                "name": "uploaded.txt",
                "length": upload.len(),
                "sha256": upload_hash,
                "overwrite": false,
            }),
        )
        .await;
        let write_stream_id = write_started["result"]["stream_id"].as_str().unwrap();
        for (sequence, chunk) in upload.chunks(STREAM_CHUNK_BYTES).enumerate() {
            accepted_channel
                .send_text(
                    json!({
                        "version": RTC_PROTOCOL_VERSION,
                        "type": "stream.chunk",
                        "stream_id": write_stream_id,
                        "sequence": sequence,
                        (DIRECT_ENDPOINT_BYTES_FIELD): STANDARD.encode(chunk),
                    })
                    .to_string(),
                )
                .await
                .unwrap();
        }
        accepted_channel
            .send_text(
                json!({
                    "version": RTC_PROTOCOL_VERSION,
                    "type": "stream.end",
                    "stream_id": write_stream_id,
                    "length": upload.len(),
                    "sha256": upload_hash,
                })
                .to_string(),
            )
            .await
            .unwrap();
        let (_, committed) = receive_host_control(&mut messages_rx).await;
        assert_eq!(committed["type"], "stream.committed");
        assert_eq!(
            tokio::fs::read(file_root.path().join("uploaded.txt"))
                .await
                .unwrap(),
            upload,
        );

        let cancelled_write = request_host_control(
            accepted_channel,
            &mut messages_rx,
            "e2e-active-write-cancel",
            "fs.write.begin",
            json!({
                "dir": "~",
                "name": "cancelled-write.bin",
                "length": 2,
                "sha256": "fb8e20fc2e4c3f248c60c39bd652f3c1347298bb977b8b4d5903b85055620603",
                "overwrite": false,
            }),
        )
        .await;
        let cancelled_write_id = cancelled_write["result"]["stream_id"].as_str().unwrap();
        accepted_channel
            .send_text(
                json!({
                    "version": RTC_PROTOCOL_VERSION,
                    "type": "stream.chunk",
                    "stream_id": cancelled_write_id,
                    "sequence": 0,
                    (DIRECT_ENDPOINT_BYTES_FIELD): STANDARD.encode(b"a"),
                })
                .to_string(),
            )
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        accepted_channel
            .send_text(
                json!({
                    "version": RTC_PROTOCOL_VERSION,
                    "type": "stream.cancel",
                    "stream_id": cancelled_write_id,
                })
                .to_string(),
            )
            .await
            .unwrap();
        let after_active_cancel = request_host_control(
            accepted_channel,
            &mut messages_rx,
            "e2e-after-active-write-cancel",
            "ping",
            json!({}),
        )
        .await;
        assert_eq!(after_active_cancel["result"]["pong"], true);
        assert!(!file_root.path().join("cancelled-write.bin").exists());

        let backlog_bytes = vec![b'z'; 24];
        let backlog_hash = format!("{:x}", Sha256::digest(&backlog_bytes));
        let backlog_write = request_host_control(
            accepted_channel,
            &mut messages_rx,
            "e2e-backlog-write-cancel",
            "fs.write.begin",
            json!({
                "dir": "~",
                "name": "backlog-write.bin",
                "length": backlog_bytes.len(),
                "sha256": backlog_hash,
                "overwrite": false,
            }),
        )
        .await;
        let backlog_stream_id = backlog_write["result"]["stream_id"].as_str().unwrap();
        for (sequence, byte) in backlog_bytes.iter().enumerate() {
            accepted_channel
                .send_text(
                    json!({
                        "version": RTC_PROTOCOL_VERSION,
                        "type": "stream.chunk",
                        "stream_id": backlog_stream_id,
                        "sequence": sequence,
                        (DIRECT_ENDPOINT_BYTES_FIELD): STANDARD.encode([*byte]),
                    })
                    .to_string(),
                )
                .await
                .unwrap();
        }
        accepted_channel
            .send_text(
                json!({
                    "version": RTC_PROTOCOL_VERSION,
                    "type": "stream.end",
                    "stream_id": backlog_stream_id,
                    "length": backlog_bytes.len(),
                    "sha256": backlog_hash,
                })
                .to_string(),
            )
            .await
            .unwrap();
        accepted_channel
            .send_text(
                json!({
                    "version": RTC_PROTOCOL_VERSION,
                    "type": "stream.cancel",
                    "stream_id": backlog_stream_id,
                })
                .to_string(),
            )
            .await
            .unwrap();
        let mut after_backlog_cancel = request_host_control(
            accepted_channel,
            &mut messages_rx,
            "e2e-after-backlog-cancel",
            "ping",
            json!({}),
        )
        .await;
        while after_backlog_cancel["request_id"] != "e2e-after-backlog-cancel" {
            after_backlog_cancel = receive_host_control(&mut messages_rx).await.1;
        }
        assert_eq!(after_backlog_cancel["result"]["pong"], true);

        let read_started = request_host_control(
            accepted_channel,
            &mut messages_rx,
            "e2e-read",
            "fs.read",
            json!({"path": "uploaded.txt"}),
        )
        .await;
        assert_eq!(read_started["result"]["length"], upload.len());
        assert_eq!(read_started["result"]["sha256"], upload_hash);
        let read_stream_id = read_started["result"]["stream_id"].as_str().unwrap();
        let mut downloaded = Vec::new();
        let ended = loop {
            let (_, message) = receive_host_control(&mut messages_rx).await;
            if message["type"] == "stream.end" {
                break message;
            }
            assert_eq!(message["type"], "stream.chunk");
            assert_eq!(message["stream_id"], read_stream_id);
            downloaded.extend(
                STANDARD
                    .decode(message[DIRECT_ENDPOINT_BYTES_FIELD].as_str().unwrap())
                    .unwrap(),
            );
            accepted_channel
                .send_text(
                    json!({
                        "version": RTC_PROTOCOL_VERSION,
                        "type": "stream.ack",
                        "stream_id": read_stream_id,
                        "sequence": message["sequence"].as_u64().unwrap() + 1,
                    })
                    .to_string(),
                )
                .await
                .unwrap();
        };
        assert_eq!(downloaded, upload);
        assert_eq!(ended["type"], "stream.end");
        assert_eq!(ended["length"], upload.len());
        assert_eq!(ended["sha256"], upload_hash);

        let stalled = request_host_control(
            accepted_channel,
            &mut messages_rx,
            "e2e-stalled-read",
            "fs.read",
            json!({"path": "uploaded.txt"}),
        )
        .await;
        let stalled_stream_id = stalled["result"]["stream_id"].as_str().unwrap();
        for sequence in 0..8 {
            let (_, chunk) = receive_host_control(&mut messages_rx).await;
            assert_eq!(chunk["type"], "stream.chunk");
            assert_eq!(chunk["stream_id"], stalled_stream_id);
            assert_eq!(chunk["sequence"], sequence);
        }
        let (_, timeout_error) = receive_host_control(&mut messages_rx).await;
        assert_eq!(timeout_error["type"], "stream.error");
        assert_eq!(timeout_error["stream_id"], stalled_stream_id);
        assert_eq!(timeout_error["error"]["code"], "stream_timeout");

        accepted_channel
            .send_text(
                json!({
                    "version": RTC_PROTOCOL_VERSION,
                    "type": "request",
                    "request_id": "e2e-hash-cancel",
                    "operation": "fs.read",
                    "payload": {"path": "hash-cancel.bin"},
                })
                .to_string(),
            )
            .await
            .unwrap();
        accepted_channel
            .send_text(
                json!({
                    "version": RTC_PROTOCOL_VERSION,
                    "type": "cancel",
                    "request_id": "e2e-hash-cancel",
                })
                .to_string(),
            )
            .await
            .unwrap();
        let (_, cancelled_hash) = receive_host_control(&mut messages_rx).await;
        assert_eq!(cancelled_hash["type"], "response");
        assert_eq!(cancelled_hash["request_id"], "e2e-hash-cancel");
        assert_eq!(cancelled_hash["ok"], false);
        assert_eq!(cancelled_hash["error"]["code"], "cancelled");

        let cancelled = request_host_control(
            accepted_channel,
            &mut messages_rx,
            "e2e-send-cancel",
            "fs.read",
            json!({"path": "uploaded.txt"}),
        )
        .await;
        let cancelled_stream_id = cancelled["result"]["stream_id"].as_str().unwrap();
        accepted_channel
            .send_text(
                json!({
                    "version": RTC_PROTOCOL_VERSION,
                    "type": "stream.cancel",
                    "stream_id": cancelled_stream_id,
                })
                .to_string(),
            )
            .await
            .unwrap();
        let mut queued_after_cancel = 0;
        while let Ok(Some((_, encoded))) =
            tokio::time::timeout(Duration::from_millis(100), messages_rx.recv()).await
        {
            let message: Value = serde_json::from_str(&encoded).unwrap();
            assert_eq!(message["type"], "stream.chunk");
            assert_eq!(message["stream_id"], cancelled_stream_id);
            queued_after_cancel += 1;
        }
        assert!(queued_after_cancel <= 8);
        assert!(
            tokio::time::timeout(Duration::from_millis(200), messages_rx.recv())
                .await
                .is_err()
        );

        let made = request_host_control(
            accepted_channel,
            &mut messages_rx,
            "e2e-mkdir",
            "fs.mkdir",
            json!({"path": "folder"}),
        )
        .await;
        assert_eq!(made["ok"], true);
        let renamed = request_host_control(
            accepted_channel,
            &mut messages_rx,
            "e2e-rename",
            "fs.rename",
            json!({"path": "uploaded.txt", "name": "renamed.txt"}),
        )
        .await;
        assert!(renamed["result"]["path"]
            .as_str()
            .unwrap()
            .ends_with("renamed.txt"));
        let stat = request_host_control(
            accepted_channel,
            &mut messages_rx,
            "e2e-stat",
            "fs.stat",
            json!({"path": "renamed.txt"}),
        )
        .await;
        assert_eq!(stat["result"]["kind"], "file");
        assert_eq!(stat["result"]["size"], upload.len());
        for (request_id, path) in [
            ("e2e-remove-file", "renamed.txt"),
            ("e2e-remove-directory", "folder"),
        ] {
            let removed = request_host_control(
                accepted_channel,
                &mut messages_rx,
                request_id,
                "fs.remove",
                json!({"path": path, "recursive": false}),
            )
            .await;
            assert_eq!(removed["ok"], true);
        }
        assert!(!file_root.path().join("renamed.txt").exists());
        assert!(!file_root.path().join("folder").exists());

        let empty_hash = format!("{:x}", Sha256::digest([]));
        for index in 0..64 {
            let request_id = format!("e2e-write-churn-{index}");
            let name = format!("write-churn-{index}.bin");
            let started = request_host_control(
                accepted_channel,
                &mut messages_rx,
                &request_id,
                "fs.write.begin",
                json!({
                    "dir": "~",
                    "name": name,
                    "length": 0,
                    "sha256": empty_hash,
                    "overwrite": false,
                }),
            )
            .await;
            let stream_id = started["result"]["stream_id"].as_str().unwrap();
            accepted_channel
                .send_text(
                    json!({
                        "version": RTC_PROTOCOL_VERSION,
                        "type": "stream.end",
                        "stream_id": stream_id,
                        "length": 0,
                        "sha256": empty_hash,
                    })
                    .to_string(),
                )
                .await
                .unwrap();
            let (_, committed) = receive_host_control(&mut messages_rx).await;
            assert_eq!(committed["type"], "stream.committed");
            assert_eq!(committed["stream_id"], stream_id);
        }
        assert_eq!(
            std::fs::read_dir(file_root.path())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".spawn-upload-"))
                .count(),
            0,
            "rapid write churn must not retain upload temporaries",
        );

        let closing = request_host_control(
            accepted_channel,
            &mut messages_rx,
            "e2e-peer-close",
            "fs.read",
            json!({"path": "hash-cancel.bin"}),
        )
        .await;
        assert_eq!(closing["ok"], true);
        assert!(
            out_rx.try_recv().is_err(),
            "host filesystem traffic escaped through the server uplink"
        );

        tokio::time::timeout(Duration::from_secs(2), browser_pc.close())
            .await
            .expect("peer close must not wait behind a read sender")
            .unwrap();
        daemon_pc.close().await.unwrap();
    }
}
