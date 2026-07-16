//! WebRTC direct terminal transport.
//!
//! The central websocket remains the authenticated, content-free control and
//! signaling plane. Raw PTY input/output and replay are endpoint-only.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use anyhow::{Context, Result};
use bytes::Bytes;
#[cfg(test)]
use serde_json::json;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot, Mutex, Notify};
use uuid::Uuid;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::setting_engine::SettingEngine;
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice::mdns::MulticastDnsMode;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::policy::ice_transport_policy::RTCIceTransportPolicy;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;

use crate::agent_ctl::{
    self, AgentControlHub, ControlOperation, ControlOutbound, ControlRequest, ControlSender,
    ProtocolError,
};
use crate::agents::{AgentBinding, AgentRegistry};
use crate::host_files::HostFileService;
use crate::proto::{Outbound, RtcIceServerConfig};
use crate::pty::{ForwarderControl, WsOutbound};

const PTY_DATA_CHANNEL_LABEL: &str = "spawn.pty";
const CONTROL_DATA_CHANNEL_LABEL: &str = "spawn.ctl";
const AGENT_RTC_PROTOCOL_VERSION: u16 = 2;
const HOST_CONTROL_LABEL: &str = "spawn.host.ctl";
const RTC_PROTOCOL_VERSION: u16 = 1;
#[cfg(test)]
const HOST_CONTROL_MAX_FRAME_BYTES: usize = 16 * 1024;
#[cfg(test)]
const HOST_CONTROL_MAX_REQUEST_ID_BYTES: usize = 128;
const MAX_RTC_PEERS: usize = 128;
const MAX_HOST_RTC_PEERS: usize = 64;
const MAX_SAFE_SIGNAL_GENERATION: u64 = 9_007_199_254_740_991;

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
const REQUIRED_AGENT_CHANNEL_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(test)]
const REQUIRED_AGENT_CHANNEL_TIMEOUT: Duration = Duration::from_secs(3);
const DATA_CHANNEL_SEND_TIMEOUT: Duration = Duration::from_secs(2);

type AgentCloserMap = HashMap<(Uuid, u64), Weak<Mutex<()>>>;
#[cfg(test)]
type TestEffectGateMap = HashMap<(String, TestEffectPoint), Arc<TestEffectGate>>;

#[derive(Default, Clone)]
pub struct RtcSessions {
    peers: Arc<Mutex<HashMap<String, RtcPeer>>>,
    host_peers: Arc<Mutex<HashMap<String, HostRtcPeer>>>,
    admission: Arc<Mutex<()>>,
    registered_host_id: Arc<Mutex<Option<Uuid>>>,
    agent_closers: Arc<Mutex<AgentCloserMap>>,
    controls: AgentControlHub,
    #[cfg(test)]
    peer_insert_attempted: Arc<tokio::sync::Notify>,
    #[cfg(test)]
    pty_send_gates: Arc<Mutex<HashMap<String, Arc<tokio::sync::Notify>>>>,
    #[cfg(test)]
    effect_gates: Arc<Mutex<TestEffectGateMap>>,
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
struct TestEffectGate {
    entered: Notify,
    release: Notify,
}

#[derive(Clone)]
struct HostRtcPeer {
    pc: Arc<RTCPeerConnection>,
    binding: HostRtcBinding,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct HostRtcBinding {
    pub(crate) host_id: Uuid,
    pub(crate) binding_nonce: String,
    pub(crate) protocol: String,
    pub(crate) protocol_version: u16,
}

/// Immutable host-scope identity supplied on offer/candidate/close frames.
#[derive(Clone)]
pub struct HostRtcSignal {
    pub session_id: String,
    pub binding_nonce: Option<String>,
    pub scope_type: Option<String>,
    pub scope_id: Option<Uuid>,
    pub protocol: Option<String>,
    pub protocol_version: Option<u16>,
}

impl HostRtcSignal {
    fn binding(&self) -> Option<HostRtcBinding> {
        let nonce = self.binding_nonce.as_ref()?;
        if nonce.len() != 32
            || !nonce
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || self.scope_type.as_deref() != Some("host")
            || self.protocol.as_deref() != Some(HOST_CONTROL_LABEL)
            || self.protocol_version != Some(RTC_PROTOCOL_VERSION)
        {
            return None;
        }
        Some(HostRtcBinding {
            host_id: self.scope_id?,
            binding_nonce: nonce.clone(),
            protocol: HOST_CONTROL_LABEL.to_string(),
            protocol_version: RTC_PROTOCOL_VERSION,
        })
    }
}

#[derive(Clone)]
struct RtcPeer {
    pc: Arc<RTCPeerConnection>,
    agent: AgentBinding,
    generation: String,
    active: Arc<AtomicBool>,
    control: ForwarderControl,
    channels: Arc<RequiredAgentChannels>,
    /// Replacement sets `active` false, closes the PC, then takes this write
    /// lock. Every callback holds a read lock while touching its backend, so
    /// `close_for_agent` does not return until old-generation work has drained.
    fence: Arc<tokio::sync::RwLock<()>>,
}

/// Immutable identity assigned by the signaling broker to one RTC attempt.
///
/// Keeping the three binding fields together makes it difficult to
/// accidentally validate a session ID while forwarding a stale generation or
/// a different agent ID.
#[derive(Clone)]
pub struct RtcSessionBinding {
    session_id: String,
    binding_nonce: String,
    generation: String,
    agent_id: Uuid,
}

impl RtcSessionBinding {
    #[cfg(test)]
    pub fn new(session_id: String, generation: String, agent_id: Uuid) -> Self {
        Self {
            session_id,
            binding_nonce: "a".repeat(32),
            generation,
            agent_id,
        }
    }

    /// Bind an agent RTC attempt to both the browser nonce and the durable
    /// daemon-owner generation selected by the signaling server. The
    /// composite key is daemon-local only; signaling responses echo the nonce
    /// and the server restores its own generation token.
    pub fn from_server(
        session_id: String,
        binding_nonce: String,
        binding_generation: u64,
        agent_id: Uuid,
    ) -> Option<Self> {
        if !valid_binding_nonce(&binding_nonce)
            || binding_generation == 0
            || binding_generation > MAX_SAFE_SIGNAL_GENERATION
        {
            return None;
        }
        Some(Self {
            session_id,
            generation: format!("{binding_generation}:{binding_nonce}"),
            binding_nonce,
            agent_id,
        })
    }

    pub fn into_routing_parts(self) -> (String, String, Uuid) {
        (self.session_id, self.generation, self.agent_id)
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
    signaling: RtcSessionBinding,
    agent: AgentBinding,
    control: ForwarderControl,
}

#[derive(Clone)]
struct RtcCallbackGuard {
    active: Arc<AtomicBool>,
    fence: Arc<tokio::sync::RwLock<()>>,
}

#[derive(Clone, Copy)]
enum AgentChannel {
    Pty,
    Control,
}

#[derive(Default)]
struct AgentChannelState {
    pty_seen: bool,
    control_seen: bool,
    pty_open: bool,
    control_open: bool,
    failed: bool,
}

#[derive(Default)]
struct RequiredAgentChannels {
    state: Mutex<AgentChannelState>,
    changed: Notify,
    ready: AtomicBool,
    failed: AtomicBool,
    effects: Arc<tokio::sync::RwLock<()>>,
}

struct AgentEffectPermit {
    channels: Arc<RequiredAgentChannels>,
    _guard: tokio::sync::OwnedRwLockReadGuard<()>,
}

impl AgentEffectPermit {
    fn valid(&self) -> bool {
        self.channels.ready.load(Ordering::SeqCst) && !self.channels.failed.load(Ordering::SeqCst)
    }
}

struct AgentFailurePermit {
    _guard: tokio::sync::OwnedRwLockWriteGuard<()>,
}

impl RequiredAgentChannels {
    fn ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst) && !self.failed.load(Ordering::SeqCst)
    }

    fn stop(&self) {
        self.failed.store(true, Ordering::SeqCst);
        self.ready.store(false, Ordering::SeqCst);
        self.changed.notify_waiters();
    }

    async fn permit(self: &Arc<Self>) -> Option<AgentEffectPermit> {
        if !self.ready() {
            return None;
        }
        let guard = Arc::clone(&self.effects).read_owned().await;
        if !self.ready() {
            return None;
        }
        Some(AgentEffectPermit {
            channels: Arc::clone(self),
            _guard: guard,
        })
    }

    async fn register(&self, channel: AgentChannel) -> bool {
        let mut state = self.state.lock().await;
        let seen = match channel {
            AgentChannel::Pty => &mut state.pty_seen,
            AgentChannel::Control => &mut state.control_seen,
        };
        if *seen {
            state.failed = true;
            self.stop();
            return false;
        }
        *seen = true;
        true
    }

    async fn mark_open(&self, channel: AgentChannel) {
        let mut state = self.state.lock().await;
        match channel {
            AgentChannel::Pty => state.pty_open = true,
            AgentChannel::Control => state.control_open = true,
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

    async fn fail(self: &Arc<Self>) -> AgentFailurePermit {
        self.stop();
        let mut state = self.state.lock().await;
        state.failed = true;
        self.ready.store(false, Ordering::SeqCst);
        self.changed.notify_waiters();
        drop(state);
        AgentFailurePermit {
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

fn viewer_id(session_id: &str, generation: &str) -> String {
    format!("{session_id}:{generation}")
}

impl RtcSessions {
    pub fn new() -> Self {
        Self::default()
    }

    #[cfg(test)]
    async fn stall_effect(&self, session_id: &str, point: TestEffectPoint) -> Arc<TestEffectGate> {
        let gate = Arc::new(TestEffectGate::default());
        self.effect_gates
            .lock()
            .await
            .insert((session_id.to_string(), point), Arc::clone(&gate));
        gate
    }

    #[cfg(test)]
    async fn pause_effect(&self, session_id: &str, point: TestEffectPoint) {
        let gate = self
            .effect_gates
            .lock()
            .await
            .remove(&(session_id.to_string(), point));
        if let Some(gate) = gate {
            gate.entered.notify_one();
            gate.release.notified().await;
        }
    }

    pub async fn bind_registered_host_id(&self, host_id: Uuid) -> bool {
        let mut registered = self.registered_host_id.lock().await;
        if registered.is_some_and(|current| current != host_id) {
            return false;
        }
        *registered = Some(host_id);
        true
    }

    pub async fn handle_offer(
        &self,
        binding: RtcSessionBinding,
        sdp: String,
        ice_servers: Vec<RtcIceServerConfig>,
        registry: AgentRegistry,
        out_tx: mpsc::Sender<WsOutbound>,
    ) {
        let Some(agent) = registry.binding_for(binding.agent_id) else {
            send_status(
                &out_tx,
                binding.session_id,
                binding.binding_nonce,
                binding.agent_id,
                "failed",
                Some("agent is not running on this daemon"),
            )
            .await;
            return;
        };
        let Some(control) = registry.control_for_binding(agent) else {
            send_status(
                &out_tx,
                binding.session_id,
                binding.binding_nonce,
                binding.agent_id,
                "failed",
                Some("agent backend was replaced while binding RTC"),
            )
            .await;
            return;
        };
        let bound = BoundRtcSession {
            signaling: binding,
            agent,
            control,
        };

        if let Err(e) = self
            .create_answer(bound.clone(), sdp, ice_servers, registry, out_tx.clone())
            .await
        {
            tracing::warn!(
                agent_id = %bound.signaling.agent_id,
                session_id = %bound.signaling.session_id,
                error = %e,
                "rtc offer failed"
            );
            send_status(
                &out_tx,
                bound.signaling.session_id,
                bound.signaling.binding_nonce,
                bound.signaling.agent_id,
                "failed",
                Some(&format!("{e:#}")),
            )
            .await;
        }
    }

    async fn create_answer(
        &self,
        binding: BoundRtcSession,
        sdp: String,
        ice_servers: Vec<RtcIceServerConfig>,
        registry: AgentRegistry,
        out_tx: mpsc::Sender<WsOutbound>,
    ) -> Result<()> {
        let mut media_engine = MediaEngine::default();
        media_engine
            .register_default_codecs()
            .context("registering WebRTC codecs")?;
        let mut setting_engine = SettingEngine::default();
        // webrtc-rs 0.17 leaks one mDNS socket plus an immortal resolver task
        // per peer connection in the default QueryOnly mode (its close signal
        // for .local resolution is an unwired TODO upstream), so every browser
        // visit pinned ~12 fds until the daemon hit its fd limit and the host
        // dropped offline. Browser .local candidates never resolve across
        // networks anyway — direct connects use our real host candidates or
        // srflx/TURN.
        setting_engine.set_ice_multicast_dns_mode(MulticastDnsMode::Disabled);
        // ICE also gathers candidate sockets per interface; virtual bridges
        // multiply the socket count ~7x for candidates nothing can reach.
        setting_engine.set_interface_filter(Box::new(|name: &str| {
            !(name.starts_with("docker")
                || name.starts_with("br-")
                || name.starts_with("veth")
                || name == "lo")
        }));
        let api = APIBuilder::new()
            .with_media_engine(media_engine)
            .with_setting_engine(setting_engine)
            .build();
        let pc = Arc::new(
            api.new_peer_connection(RTCConfiguration {
                ice_servers: ice_servers.into_iter().map(to_webrtc_ice_server).collect(),
                ..Default::default()
            })
            .await
            .context("creating peer connection")?,
        );
        let active = Arc::new(AtomicBool::new(true));
        let fence = Arc::new(tokio::sync::RwLock::new(()));
        let channels = Arc::new(RequiredAgentChannels::default());

        // Linearize peer insertion with backend replacement. Construction and
        // SDP work stay outside this guard, but the captured binding is
        // revalidated while insertion is protected by the same per-agent lock
        // used to invalidate the registry entry and scan old peers.
        #[cfg(test)]
        self.peer_insert_attempted.notify_waiters();
        let _admission = self.admission.lock().await;
        let transition = registry
            .lock_generation_transition(binding.signaling.agent_id)
            .await;
        if !registry.is_current(binding.agent) {
            drop(transition);
            let _ = pc.close().await;
            anyhow::bail!("agent backend was replaced during RTC negotiation");
        }

        // Track the peer connection BEFORE SDP negotiation so every exit path
        // below can reach it and close it.
        let host_collision = self
            .host_peers
            .lock()
            .await
            .contains_key(&binding.signaling.session_id);
        let collision_or_capacity = {
            let mut peers = self.peers.lock().await;
            let total = peers.len() + self.host_peers.lock().await.len();
            if host_collision
                || peers.contains_key(&binding.signaling.session_id)
                || total >= MAX_RTC_PEERS
            {
                true
            } else {
                peers.insert(
                    binding.signaling.session_id.clone(),
                    RtcPeer {
                        pc: Arc::clone(&pc),
                        agent: binding.agent,
                        generation: binding.signaling.generation.clone(),
                        active: Arc::clone(&active),
                        control: binding.control.clone(),
                        channels: Arc::clone(&channels),
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

        install_ice_handler(&pc, binding.signaling.clone(), out_tx.clone());
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
            #[cfg(test)]
            self.pty_send_gates
                .lock()
                .await
                .remove(&binding.signaling.session_id),
            out_tx.clone(),
        );
        self.install_reaper(&pc, binding.signaling.clone());

        let local_sdp = match negotiate(&pc, sdp).await {
            Ok(local_sdp) => local_sdp,
            Err(e) => {
                self.close_if_same(
                    &binding.signaling.session_id,
                    &binding.signaling.generation,
                    &pc,
                )
                .await;
                return Err(e);
            }
        };

        send_json(
            &out_tx,
            Outbound::RtcAnswer {
                session_id: binding.signaling.session_id,
                binding_nonce: Some(binding.signaling.binding_nonce),
                agent_id: Some(binding.signaling.agent_id),
                scope_type: Some("agent".to_string()),
                scope_id: Some(binding.signaling.agent_id),
                protocol: Some(PTY_DATA_CHANNEL_LABEL.to_string()),
                protocol_version: Some(AGENT_RTC_PROTOCOL_VERSION),
                sdp: local_sdp,
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
    ) {
        let Some(binding) = signal.binding() else {
            tracing::warn!(session_id = %signal.session_id, "rejecting invalid host rtc offer binding");
            return;
        };
        if *self.registered_host_id.lock().await != Some(binding.host_id) {
            tracing::warn!(session_id = %signal.session_id, "rejecting host rtc offer for another daemon");
            return;
        }
        if let Err(error) = self
            .create_host_answer(
                signal.session_id.clone(),
                binding.clone(),
                sdp,
                ice_servers,
                ice_transport_policy,
                out_tx.clone(),
            )
            .await
        {
            tracing::warn!(session_id = %signal.session_id, %error, "host rtc offer failed");
            send_host_status(&out_tx, signal.session_id, &binding, "failed").await;
        }
    }

    async fn create_host_answer(
        &self,
        session_id: String,
        binding: HostRtcBinding,
        sdp: String,
        ice_servers: Vec<RtcIceServerConfig>,
        ice_transport_policy: Option<String>,
        out_tx: mpsc::Sender<WsOutbound>,
    ) -> Result<()> {
        let mut media_engine = MediaEngine::default();
        media_engine
            .register_default_codecs()
            .context("registering WebRTC codecs")?;
        let mut setting_engine = SettingEngine::default();
        setting_engine.set_ice_multicast_dns_mode(MulticastDnsMode::Disabled);
        setting_engine.set_interface_filter(Box::new(|name: &str| {
            !(name.starts_with("docker")
                || name.starts_with("br-")
                || name.starts_with("veth")
                || name == "lo")
        }));
        let api = APIBuilder::new()
            .with_media_engine(media_engine)
            .with_setting_engine(setting_engine)
            .build();
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
        let agent_count = self.peers.lock().await.len();
        let admitted = {
            let mut hosts = self.host_peers.lock().await;
            if hosts.contains_key(&session_id)
                || hosts.len() >= MAX_HOST_RTC_PEERS
                || agent_count + hosts.len() >= MAX_RTC_PEERS
                || self.peers.lock().await.contains_key(&session_id)
            {
                false
            } else {
                hosts.insert(
                    session_id.clone(),
                    HostRtcPeer {
                        pc: Arc::clone(&pc),
                        binding: binding.clone(),
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

        install_host_ice_handler(&pc, session_id.clone(), binding.clone(), out_tx.clone());
        install_host_data_channel_handler(
            &pc,
            session_id.clone(),
            binding.clone(),
            out_tx.clone(),
            None,
        );
        self.install_host_reaper(&pc, session_id.clone());

        let local_sdp = match negotiate(&pc, sdp).await {
            Ok(sdp) => sdp,
            Err(error) => {
                self.close_host_if_same(&session_id, &pc).await;
                return Err(error);
            }
        };
        send_json(
            &out_tx,
            Outbound::RtcAnswer {
                session_id,
                binding_nonce: Some(binding.binding_nonce),
                agent_id: None,
                scope_type: Some("host".to_string()),
                scope_id: Some(binding.host_id),
                protocol: Some(binding.protocol),
                protocol_version: Some(binding.protocol_version),
                sdp: local_sdp,
            },
        )
        .await;
        Ok(())
    }

    fn install_host_reaper(&self, pc: &Arc<RTCPeerConnection>, session_id: String) {
        let weak = Arc::downgrade(pc);
        {
            let sessions = self.clone();
            let session_id = session_id.clone();
            let weak = weak.clone();
            tokio::spawn(async move {
                tokio::time::sleep(RTC_CONNECT_TIMEOUT).await;
                let Some(pc) = weak.upgrade() else { return };
                if pc.connection_state() != RTCPeerConnectionState::Connected {
                    sessions.close_host_if_same(&session_id, &pc).await;
                }
            });
        }
        let sessions = self.clone();
        pc.on_peer_connection_state_change(Box::new(move |state| {
            let sessions = sessions.clone();
            let session_id = session_id.clone();
            let weak = weak.clone();
            Box::pin(async move {
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
                        sessions.close_host_if_same(&session_id, &pc).await;
                    }
                });
            })
        }));
    }

    async fn close_host_if_same(&self, session_id: &str, pc: &Arc<RTCPeerConnection>) {
        let removed = {
            let mut peers = self.host_peers.lock().await;
            if peers
                .get(session_id)
                .is_some_and(|peer| Arc::ptr_eq(&peer.pc, pc))
            {
                peers.remove(session_id)
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
        let Some(peer) = self
            .host_peers
            .lock()
            .await
            .get(&signal.session_id)
            .cloned()
        else {
            return;
        };
        if peer.binding != binding {
            tracing::warn!(session_id = %signal.session_id, "ignoring stale host rtc candidate binding");
            return;
        }
        if let Ok(candidate) = serde_json::from_value::<RTCIceCandidateInit>(candidate) {
            if let Err(error) = peer.pc.add_ice_candidate(candidate).await {
                tracing::debug!(session_id = %signal.session_id, %error, "adding host rtc candidate failed");
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
                .get(&signal.session_id)
                .is_some_and(|peer| peer.binding == binding)
            {
                peers.remove(&signal.session_id)
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
    fn install_reaper(&self, pc: &Arc<RTCPeerConnection>, binding: RtcSessionBinding) {
        let weak = Arc::downgrade(pc);

        {
            let sessions = self.clone();
            let binding = binding.clone();
            let weak = weak.clone();
            tokio::spawn(async move {
                tokio::time::sleep(RTC_CONNECT_TIMEOUT).await;
                let Some(pc) = weak.upgrade() else { return };
                if pc.connection_state() != RTCPeerConnectionState::Connected {
                    tracing::debug!(
                        agent_id = %binding.agent_id,
                        session_id = %binding.session_id,
                        "rtc peer never connected; reaping"
                    );
                    sessions
                        .close_if_same(&binding.session_id, &binding.generation, &pc)
                        .await;
                }
            });
        }

        let sessions = self.clone();
        pc.on_peer_connection_state_change(Box::new(move |state| {
            let sessions = sessions.clone();
            let binding = binding.clone();
            let weak = weak.clone();
            Box::pin(async move {
                match state {
                    RTCPeerConnectionState::Failed => {
                        let Some(pc) = weak.upgrade() else { return };
                        // Close from a separate task: closing the peer from
                        // inside its own event handler can deadlock.
                        tokio::spawn(async move {
                            tracing::debug!(
                                agent_id = %binding.agent_id,
                                session_id = %binding.session_id,
                                "rtc peer failed; reaping"
                            );
                            sessions
                                .close_if_same(&binding.session_id, &binding.generation, &pc)
                                .await;
                        });
                    }
                    RTCPeerConnectionState::Disconnected => {
                        let Some(pc) = weak.upgrade() else { return };
                        tokio::spawn(async move {
                            tokio::time::sleep(RTC_DISCONNECTED_GRACE).await;
                            if pc.connection_state() == RTCPeerConnectionState::Disconnected {
                                tracing::debug!(
                                    agent_id = %binding.agent_id,
                                    session_id = %binding.session_id,
                                    "rtc peer stayed disconnected; reaping"
                                );
                                sessions
                                    .close_if_same(&binding.session_id, &binding.generation, &pc)
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
        session_id: &str,
        generation: &str,
        pc: &Arc<RTCPeerConnection>,
    ) {
        let sessions = self.clone();
        let session_id = session_id.to_string();
        let generation = generation.to_string();
        let pc = Arc::clone(pc);
        tokio::spawn(async move {
            sessions.close_if_same(&session_id, &generation, &pc).await;
        });
    }

    async fn close_if_same(&self, session_id: &str, generation: &str, pc: &Arc<RTCPeerConnection>) {
        let agent = {
            let peers = self.peers.lock().await;
            peers
                .get(session_id)
                .filter(|current| current.generation == generation && Arc::ptr_eq(&current.pc, pc))
                .map(|peer| peer.agent)
        };
        let Some(agent) = agent else {
            let _ = pc.close().await;
            return;
        };
        let closer = self.agent_closer(agent).await;
        let _closing = closer.lock().await;
        let peer = {
            let peers = self.peers.lock().await;
            peers
                .get(session_id)
                .filter(|current| current.generation == generation && Arc::ptr_eq(&current.pc, pc))
                .cloned()
        };
        if let Some(peer) = peer {
            self.deactivate_peer(session_id, peer).await;
            let mut peers = self.peers.lock().await;
            if peers.get(session_id).is_some_and(|current| {
                current.generation == generation && Arc::ptr_eq(&current.pc, pc)
            }) {
                peers.remove(session_id);
            }
            return;
        }
        let _ = pc.close().await;
    }

    #[allow(clippy::too_many_arguments)]
    async fn send_agent_peer_status(
        &self,
        out_tx: &mpsc::Sender<WsOutbound>,
        session_id: &str,
        generation: &str,
        pc: &Arc<RTCPeerConnection>,
        active: &Arc<AtomicBool>,
        channels: &Arc<RequiredAgentChannels>,
        binding_nonce: &str,
        agent_id: Uuid,
        status: &str,
        message: Option<&str>,
    ) -> bool {
        let sent = {
            let peers = self.peers.lock().await;
            peers.get(session_id).is_some_and(|current| {
                current.generation == generation
                    && Arc::ptr_eq(&current.pc, pc)
                    && current.agent.agent_id() == agent_id
            }) && try_send_status(out_tx, session_id, binding_nonce, agent_id, status, message)
        };
        if !sent {
            channels.stop();
            active.store(false, Ordering::Release);
            self.schedule_close_if_same(session_id, generation, pc);
        }
        sent
    }

    pub async fn handle_candidate(
        &self,
        session_id: String,
        generation: String,
        agent_id: Uuid,
        candidate: serde_json::Value,
    ) {
        let Some(peer) = self.peers.lock().await.get(&session_id).cloned() else {
            tracing::debug!(%session_id, "ignoring rtc candidate for unknown session");
            return;
        };
        if peer.agent.agent_id() != agent_id || peer.generation != generation {
            tracing::warn!(%session_id, %agent_id, "ignoring rtc candidate with stale binding");
            return;
        }
        let pc = peer.pc;
        match serde_json::from_value::<RTCIceCandidateInit>(candidate) {
            Ok(candidate) => {
                if let Err(e) = pc.add_ice_candidate(candidate).await {
                    tracing::debug!(%session_id, error = %e, "adding rtc candidate failed");
                }
            }
            Err(e) => {
                tracing::debug!(%session_id, error = %e, "decoding rtc candidate failed");
            }
        }
    }

    pub async fn close(&self, session_id: &str, generation: &str, agent_id: Uuid) {
        let agent = {
            let peers = self.peers.lock().await;
            peers
                .get(session_id)
                .filter(|peer| peer.agent.agent_id() == agent_id && peer.generation == generation)
                .map(|peer| peer.agent)
        };
        let Some(agent) = agent else { return };
        let closer = self.agent_closer(agent).await;
        let _closing = closer.lock().await;
        let peer = {
            let peers = self.peers.lock().await;
            peers
                .get(session_id)
                .filter(|peer| peer.agent.agent_id() == agent_id && peer.generation == generation)
                .cloned()
        };
        if let Some(peer) = peer {
            self.deactivate_peer(session_id, peer).await;
            let mut peers = self.peers.lock().await;
            if peers.get(session_id).is_some_and(|peer| {
                peer.agent.agent_id() == agent_id && peer.generation == generation
            }) {
                peers.remove(session_id);
            }
        }
    }

    /// Close peers attached to one concrete backend generation. A replacement
    /// using the same UUID is deliberately not matched.
    pub async fn close_for_agent(&self, agent_id: Uuid, agent_generation: u64) {
        let agent = AgentBinding::new(agent_id, agent_generation);
        let closer = self.agent_closer(agent).await;
        let _closing = closer.lock().await;
        let closing = {
            let peers = self.peers.lock().await;
            peers
                .iter()
                .filter(|(_, peer)| {
                    peer.agent.agent_id() == agent_id && peer.agent.generation() == agent_generation
                })
                .map(|(session_id, peer)| (session_id.clone(), peer.clone()))
                .collect::<Vec<_>>()
        };
        for (session_id, peer) in closing {
            let pc = Arc::clone(&peer.pc);
            self.deactivate_peer(&session_id, peer).await;
            let mut peers = self.peers.lock().await;
            if peers
                .get(&session_id)
                .is_some_and(|current| current.agent == agent && Arc::ptr_eq(&current.pc, &pc))
            {
                peers.remove(&session_id);
            }
        }
        // An old exit task can race a replacement using the same UUID. Keep
        // the peer map locked while deciding and clearing backend-wide hub
        // state so a new generation either prevents cleanup or registers only
        // after cleanup has completed.
        let peers = self.peers.lock().await;
        if !peers.values().any(|peer| peer.agent.agent_id() == agent_id) {
            self.controls.remove_agent(agent_id).await;
        }
    }

    async fn deactivate_peer(&self, session_id: &str, peer: RtcPeer) {
        peer.channels.stop();
        peer.active.store(false, Ordering::Release);
        // Closing first is transport cancellation: it wakes bounded WebRTC
        // sends and control replies. State teardown happens only after both
        // lifecycle writers have drained every admitted effect callback.
        let _ = peer.pc.close().await;
        let _lifecycle = peer.channels.fail().await;
        let _drained = peer.fence.write().await;
        peer.control
            .remove_direct_sink(&viewer_id(session_id, &peer.generation))
            .await;
        self.controls
            .unregister_session(&viewer_id(session_id, &peer.generation))
            .await;
    }

    async fn agent_closer(&self, agent: AgentBinding) -> Arc<Mutex<()>> {
        let key = (agent.agent_id(), agent.generation());
        let mut closers = self.agent_closers.lock().await;
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
        let peers = self.peers.lock().await.clone();
        #[cfg(test)]
        for session_id in peers.keys() {
            self.pause_effect(session_id, TestEffectPoint::CloseAllSnapshot)
                .await;
        }
        for (session_id, peer) in peers {
            let closer = self.agent_closer(peer.agent).await;
            let _closing = closer.lock().await;
            let current = {
                let peers = self.peers.lock().await;
                peers
                    .get(&session_id)
                    .filter(|current| {
                        current.generation == peer.generation
                            && current.agent == peer.agent
                            && Arc::ptr_eq(&current.pc, &peer.pc)
                    })
                    .cloned()
            };
            let Some(current) = current else { continue };
            let pc = Arc::clone(&current.pc);
            let generation = current.generation.clone();
            self.deactivate_peer(&session_id, current).await;
            let mut peers = self.peers.lock().await;
            if peers.get(&session_id).is_some_and(|current| {
                current.generation == generation && Arc::ptr_eq(&current.pc, &pc)
            }) {
                peers.remove(&session_id);
            }
        }
        let host_peers = std::mem::take(&mut *self.host_peers.lock().await);
        for (_, peer) in host_peers {
            let _ = peer.pc.close().await;
        }
    }

    #[cfg(test)]
    async fn resident_session_count(&self) -> usize {
        self.peers.lock().await.len() + self.host_peers.lock().await.len()
    }

    #[cfg(test)]
    async fn stall_first_pty_send(&self, session_id: &str) -> Arc<tokio::sync::Notify> {
        let gate = Arc::new(tokio::sync::Notify::new());
        self.pty_send_gates
            .lock()
            .await
            .insert(session_id.to_string(), Arc::clone(&gate));
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

fn install_ice_handler(
    pc: &Arc<RTCPeerConnection>,
    binding: RtcSessionBinding,
    out_tx: mpsc::Sender<WsOutbound>,
) {
    pc.on_ice_candidate(Box::new(move |candidate| {
        let out_tx = out_tx.clone();
        let binding = binding.clone();
        Box::pin(async move {
            let Some(candidate) = candidate else {
                return;
            };
            let candidate = match candidate.to_json() {
                Ok(candidate) => candidate,
                Err(e) => {
                    tracing::debug!(agent_id = %binding.agent_id, error = %e, "encoding rtc candidate failed");
                    return;
                }
            };
            match serde_json::to_value(candidate) {
                Ok(candidate) => {
                    send_json(
                        &out_tx,
                        Outbound::RtcCandidate {
                            session_id: binding.session_id,
                            binding_nonce: Some(binding.binding_nonce),
                            agent_id: Some(binding.agent_id),
                            scope_type: Some("agent".to_string()),
                            scope_id: Some(binding.agent_id),
                            protocol: Some(PTY_DATA_CHANNEL_LABEL.to_string()),
                            protocol_version: Some(AGENT_RTC_PROTOCOL_VERSION),
                            candidate,
                        },
                    )
                    .await;
                }
                Err(e) => {
                    tracing::debug!(agent_id = %binding.agent_id, error = %e, "serializing rtc candidate failed");
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
    registry: AgentRegistry,
    controls: AgentControlHub,
    guard: RtcCallbackGuard,
    channels: Arc<RequiredAgentChannels>,
    #[cfg(test)] pty_send_gate: Option<Arc<tokio::sync::Notify>>,
    out_tx: mpsc::Sender<WsOutbound>,
) {
    {
        let active = Arc::clone(&guard.active);
        let channels = Arc::clone(&channels);
        let pc = Arc::clone(pc);
        let sessions = sessions.clone();
        let out_tx = out_tx.clone();
        let session_id = binding.signaling.session_id.clone();
        let generation = binding.signaling.generation.clone();
        let binding_nonce = binding.signaling.binding_nonce.clone();
        let agent_id = binding.signaling.agent_id;
        tokio::spawn(async move {
            if !matches!(
                tokio::time::timeout(REQUIRED_AGENT_CHANNEL_TIMEOUT, channels.wait_ready()).await,
                Ok(true)
            ) {
                channels.fail().await;
                let _ = sessions
                    .send_agent_peer_status(
                        &out_tx,
                        &session_id,
                        &generation,
                        &pc,
                        &active,
                        &channels,
                        &binding_nonce,
                        agent_id,
                        "failed",
                        Some("spawn.pty and spawn.ctl are both required"),
                    )
                    .await;
                sessions.close_if_same(&session_id, &generation, &pc).await;
            }
        });
    }
    let handler_pc = Arc::clone(pc);
    pc.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
        let binding = binding.clone();
        let registry = registry.clone();
        let controls = controls.clone();
        let active = Arc::clone(&guard.active);
        let fence = Arc::clone(&guard.fence);
        #[cfg(test)]
        let pty_send_gate = pty_send_gate.clone();
        let out_tx = out_tx.clone();
        let channels = Arc::clone(&channels);
        let pc = Arc::clone(&handler_pc);
        let sessions = sessions.clone();
        Box::pin(async move {
            let viewer_id = viewer_id(
                &binding.signaling.session_id,
                &binding.signaling.generation,
            );
            if !dc.ordered() {
                tracing::warn!(agent_id = %binding.signaling.agent_id, label = %dc.label(), "rejecting unordered rtc data channel");
                channels.fail().await;
                sessions.schedule_close_if_same(
                    &binding.signaling.session_id,
                    &binding.signaling.generation,
                    &pc,
                );
                return;
            }
            if dc.label() == CONTROL_DATA_CHANNEL_LABEL {
                if !channels.register(AgentChannel::Control).await {
                    sessions.schedule_close_if_same(
                        &binding.signaling.session_id,
                        &binding.signaling.generation,
                        &pc,
                    );
                    return;
                }
                install_control_data_channel(
                    dc,
                    viewer_id,
                    binding.signaling.session_id.clone(),
                    binding.agent,
                    registry,
                    controls,
                    active,
                    fence,
                    channels,
                    pc,
                    sessions,
                    binding.signaling.generation.clone(),
                );
                return;
            }
            if dc.label() != PTY_DATA_CHANNEL_LABEL {
                tracing::warn!(agent_id = %binding.signaling.agent_id, label = %dc.label(), "rejecting unknown rtc data channel");
                channels.fail().await;
                sessions.schedule_close_if_same(
                    &binding.signaling.session_id,
                    &binding.signaling.generation,
                    &pc,
                );
                return;
            }
            if !channels.register(AgentChannel::Pty).await {
                sessions.schedule_close_if_same(
                    &binding.signaling.session_id,
                    &binding.signaling.generation,
                    &pc,
                );
                return;
            }

            let agent = binding.agent;
            let agent_id = agent.agent_id();

            let input_registry = registry.clone();
            let input_out_tx = out_tx.clone();
            let input_active = Arc::clone(&active);
            let input_fence = Arc::clone(&fence);
            let input_channels = Arc::clone(&channels);
            #[cfg(test)]
            let input_sessions = sessions.clone();
            #[cfg(test)]
            let input_session_id = binding.signaling.session_id.clone();
            dc.on_message(Box::new(move |msg: DataChannelMessage| {
                let registry = input_registry.clone();
                let out_tx = input_out_tx.clone();
                let active = Arc::clone(&input_active);
                let fence = Arc::clone(&input_fence);
                let channels = Arc::clone(&input_channels);
                #[cfg(test)]
                let sessions = input_sessions.clone();
                #[cfg(test)]
                let session_id = input_session_id.clone();
                Box::pin(async move {
                    let Some(effect) = channels.permit().await else {
                        return;
                    };
                    let _callback = fence.read().await;
                    #[cfg(test)]
                    sessions
                        .pause_effect(&session_id, TestEffectPoint::PtyInput)
                        .await;
                    if !effect.valid()
                        || !active.load(Ordering::Acquire)
                        || !registry.is_current(agent)
                    {
                        return;
                    }
                    let result = forward_bound_data_channel_input(
                        agent,
                        msg.is_string,
                        &msg.data,
                        &registry,
                        &out_tx,
                    );
                    if result.is_none() {
                        tracing::debug!(%agent_id, "ignoring rtc stdin for unknown agent");
                    } else if let Some(Err(e)) = result {
                        tracing::warn!(%agent_id, error = %e, "rtc PTY stdin write failed");
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
            let open_pc = Arc::clone(&pc);
            let open_sessions = sessions.clone();
            let open_rtc_session_id = binding.signaling.session_id.clone();
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
                let pc = Arc::clone(&open_pc);
                let sessions = open_sessions.clone();
                let rtc_session_id = open_rtc_session_id.clone();
                let generation = open_generation.clone();
                Box::pin(async move {
                    if !active.load(Ordering::Acquire) || !registry.is_current(agent) {
                        let _ = dc.close().await;
                        return;
                    }
                    channels.mark_open(AgentChannel::Pty).await;
                    if !channels.wait_ready().await {
                        sessions.schedule_close_if_same(&rtc_session_id, &generation, &pc);
                        return;
                    }
                    let Some(effect) = channels.permit().await else {
                        sessions.schedule_close_if_same(&rtc_session_id, &generation, &pc);
                        return;
                    };
                    let _callback = fence.read().await;
                    if !effect.valid()
                        || !active.load(Ordering::Acquire)
                        || !registry.is_current(agent)
                    {
                        return;
                    }
                    let mut replay_rx = None;
                    registry.with_bound_handle(agent, |handle| {
                        replay_rx = handle.replay(64 * 1024);
                    });
                    let Some(replay_rx) = replay_rx else {
                        let _ = sessions
                            .send_agent_peer_status(
                                &out_tx,
                                &rtc_session_id,
                                &generation,
                                &pc,
                                &active,
                                &channels,
                                &binding_nonce,
                                agent_id,
                                "failed",
                                Some("worker replay is unavailable"),
                            )
                            .await;
                        channels.stop();
                        active.store(false, Ordering::Release);
                        sessions.schedule_close_if_same(&rtc_session_id, &generation, &pc);
                        return;
                    };
                    let Ok(Ok(Ok(replay))) =
                        tokio::time::timeout(Duration::from_secs(3), replay_rx).await
                    else {
                        let _ = sessions
                            .send_agent_peer_status(
                                &out_tx,
                                &rtc_session_id,
                                &generation,
                                &pc,
                                &active,
                                &channels,
                                &binding_nonce,
                                agent_id,
                                "failed",
                                Some("worker replay barrier failed"),
                            )
                            .await;
                        channels.stop();
                        active.store(false, Ordering::Release);
                        sessions.schedule_close_if_same(&rtc_session_id, &generation, &pc);
                        return;
                    };
                    let watermark = replay.watermark();
                    if !effect.valid()
                        || !active.load(Ordering::Acquire)
                        || !registry.is_current(agent)
                    {
                        let _ = dc.close().await;
                        return;
                    }
                    if tokio::time::timeout(
                        Duration::from_secs(3),
                        control.wait_source_offset(watermark),
                    )
                    .await
                    .is_err()
                    {
                        let _ = sessions
                            .send_agent_peer_status(
                                &out_tx,
                                &rtc_session_id,
                                &generation,
                                &pc,
                                &active,
                                &channels,
                                &binding_nonce,
                                agent_id,
                                "failed",
                                Some("worker live-stream barrier timed out"),
                            )
                            .await;
                        channels.stop();
                        active.store(false, Ordering::Release);
                        sessions.schedule_close_if_same(&rtc_session_id, &generation, &pc);
                        return;
                    }
                    if !effect.valid()
                        || !active.load(Ordering::Acquire)
                        || !registry.is_current(agent)
                    {
                        let _ = dc.close().await;
                        return;
                    }

                    #[cfg(test)]
                    sessions
                        .pause_effect(&rtc_session_id, TestEffectPoint::PtySink)
                        .await;
                    if !effect.valid()
                        || !active.load(Ordering::Acquire)
                        || !registry.is_current(agent)
                    {
                        return;
                    }
                    let mut direct = control.add_direct_sink(viewer_id.clone()).await;
                    if !effect.valid()
                        || !active.load(Ordering::Acquire)
                        || !registry.is_current(agent)
                    {
                        control.remove_direct_sink(&viewer_id).await;
                        let _ = dc.close().await;
                        return;
                    }
                    if !sessions
                        .send_agent_peer_status(
                            &out_tx,
                            &rtc_session_id,
                            &generation,
                            &pc,
                            &active,
                            &channels,
                            &binding_nonce,
                            agent_id,
                            "connected",
                            None,
                        )
                        .await
                    {
                        return;
                    }
                    if !effect.valid()
                        || !active.load(Ordering::Acquire)
                        || !registry.is_current(agent)
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
                    let output_pc = Arc::clone(&pc);
                    let output_session_id = rtc_session_id.clone();
                    let output_generation = generation.clone();
                    drop(_callback);
                    drop(effect);
                    tokio::spawn(async move {
                        #[cfg(test)]
                        let mut pty_send_gate = pty_send_gate;
                        loop {
                            let chunk = tokio::select! {
                                changed = direct.disconnected.changed() => {
                                    let _ = changed;
                                    None
                                }
                                chunk = direct.receiver.recv() => chunk,
                            };
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
                                || !rtc_output_allowed(&output_registry, agent)
                            {
                                break;
                            }
                            match tokio::time::timeout(
                                DATA_CHANNEL_SEND_TIMEOUT,
                                dc.send(&Bytes::copy_from_slice(&chunk)),
                            )
                            .await
                            {
                                Ok(Ok(_)) => {}
                                Ok(Err(error)) => {
                                    tracing::debug!(%agent_id, %error, "rtc data channel send failed");
                                    break;
                                }
                                Err(_) => {
                                    tracing::debug!(%agent_id, "rtc data channel send timed out");
                                    break;
                                }
                            }
                        }
                        output_channels.stop();
                        output_active.store(false, Ordering::Release);
                        let _ = dc.close().await;
                        output_sessions.schedule_close_if_same(
                            &output_session_id,
                            &output_generation,
                            &output_pc,
                        );
                    });
                })
            }));

            let close_active = Arc::clone(&active);
            let close_channels = Arc::clone(&channels);
            let close_pc = Arc::clone(&pc);
            let close_sessions = sessions;
            let close_session_id = binding.signaling.session_id.clone();
            let close_generation = binding.signaling.generation.clone();
            dc.on_close(Box::new(move || {
                let active = Arc::clone(&close_active);
                let channels = Arc::clone(&close_channels);
                let pc = Arc::clone(&close_pc);
                let sessions = close_sessions.clone();
                let session_id = close_session_id.clone();
                let generation = close_generation.clone();
                Box::pin(async move {
                    channels.stop();
                    active.store(false, Ordering::Release);
                    sessions.schedule_close_if_same(&session_id, &generation, &pc);
                })
            }));
        })
    }));
}

#[allow(clippy::too_many_arguments)]
fn install_control_data_channel(
    dc: Arc<RTCDataChannel>,
    session_id: String,
    rtc_session_id: String,
    agent: AgentBinding,
    registry: AgentRegistry,
    controls: AgentControlHub,
    active: Arc<AtomicBool>,
    fence: Arc<tokio::sync::RwLock<()>>,
    channels: Arc<RequiredAgentChannels>,
    pc: Arc<RTCPeerConnection>,
    sessions: RtcSessions,
    generation: String,
) {
    let agent_id = agent.agent_id();
    let (sender, mut receiver) = mpsc::channel(agent_ctl::OUTBOUND_QUEUE_DEPTH);
    let (display_sender, mut display_receiver) = tokio::sync::watch::channel(None::<String>);
    let (close_tx, mut close_rx) = oneshot::channel();
    let close_tx = Arc::new(Mutex::new(Some(close_tx)));
    let send_dc = Arc::clone(&dc);
    let send_session_id = session_id.clone();
    let send_registry = registry.clone();
    let send_active = Arc::clone(&active);
    let send_fence = Arc::clone(&fence);
    let send_channels = Arc::clone(&channels);
    let send_pc = Arc::clone(&pc);
    let send_sessions = sessions.clone();
    let send_generation = generation.clone();
    tokio::spawn(async move {
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
                || !send_registry.is_current(agent)
            {
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
            match tokio::time::timeout(DATA_CHANNEL_SEND_TIMEOUT, send).await {
                Ok(Ok(_)) => {}
                Ok(Err(error)) => {
                    tracing::debug!(%agent_id, %send_session_id, %error, "spawn.ctl send failed");
                    break;
                }
                Err(_) => {
                    tracing::debug!(%agent_id, %send_session_id, "spawn.ctl send timed out");
                    break;
                }
            }
        }
        send_channels.stop();
        send_active.store(false, Ordering::Release);
        let _ = send_dc.close().await;
        send_sessions.schedule_close_if_same(&send_session_id, &send_generation, &send_pc);
    });

    // webrtc-rs may invoke multiple message callbacks concurrently. Serialize
    // each viewer's requests so state-changing operations and their replies
    // retain the ordered DataChannel's request order.
    let request_lock = Arc::new(Mutex::new(()));
    let message_registry = registry.clone();
    let message_controls = controls.clone();
    let message_sender = sender.clone();
    let message_display_sender = display_sender.clone();
    let message_session_id = session_id.clone();
    #[cfg(test)]
    let message_sessions = sessions.clone();
    #[cfg(test)]
    let message_rtc_session_id = rtc_session_id.clone();
    let message_active = Arc::clone(&active);
    let message_fence = Arc::clone(&fence);
    let message_channels = Arc::clone(&channels);
    dc.on_message(Box::new(move |msg: DataChannelMessage| {
        let registry = message_registry.clone();
        let controls = message_controls.clone();
        let sender = message_sender.clone();
        let display_sender = message_display_sender.clone();
        let session_id = message_session_id.clone();
        let request_lock = request_lock.clone();
        let active = Arc::clone(&message_active);
        let fence = Arc::clone(&message_fence);
        let channels = Arc::clone(&message_channels);
        #[cfg(test)]
        let sessions = message_sessions.clone();
        #[cfg(test)]
        let rtc_session_id = message_rtc_session_id.clone();
        Box::pin(async move {
            let Some(effect) = channels.permit().await else {
                return;
            };
            let _callback = fence.read().await;
            if !effect.valid() || !active.load(Ordering::Acquire) || !registry.is_current(agent) {
                return;
            }
            let _guard = request_lock.lock().await;
            #[cfg(test)]
            sessions
                .pause_effect(&rtc_session_id, TestEffectPoint::ControlRequest)
                .await;
            if !effect.valid() || !active.load(Ordering::Acquire) || !registry.is_current(agent) {
                return;
            }
            if !msg.is_string {
                agent_ctl::send_error(
                    &sender,
                    &ProtocolError::new(
                        None,
                        "unexpected_binary",
                        "spawn.ctl requests must be JSON text frames",
                    ),
                )
                .await;
                return;
            }
            let text = match std::str::from_utf8(&msg.data) {
                Ok(text) => text,
                Err(_) => {
                    agent_ctl::send_error(
                        &sender,
                        &ProtocolError::new(None, "malformed_request", "request is not UTF-8"),
                    )
                    .await;
                    return;
                }
            };
            match ControlRequest::decode(text) {
                Ok(request) => {
                    let registered = controls.contains_viewer(agent_id, &session_id).await;
                    if !effect.valid()
                        || !active.load(Ordering::Acquire)
                        || !registry.is_current(agent)
                    {
                        return;
                    }
                    if !registered {
                        controls
                            .register(agent_id, session_id.clone(), display_sender.clone())
                            .await;
                        if !effect.valid()
                            || !active.load(Ordering::Acquire)
                            || !registry.is_current(agent)
                        {
                            return;
                        }
                    }
                    handle_control_request(
                        agent,
                        &session_id,
                        request,
                        &registry,
                        &controls,
                        &sender,
                        &effect,
                    )
                    .await;
                }
                Err(error) => agent_ctl::send_error(&sender, &error).await,
            }
        })
    }));

    let open_controls = controls.clone();
    let open_session_id = session_id.clone();
    let open_sender = sender;
    let open_display_sender = display_sender;
    let open_active = Arc::clone(&active);
    let open_registry = registry;
    let open_fence = fence;
    let open_channels = Arc::clone(&channels);
    let open_pc = Arc::clone(&pc);
    let open_sessions = sessions.clone();
    let open_rtc_session_id = rtc_session_id.clone();
    let open_generation = generation.clone();
    dc.on_open(Box::new(move || {
        let controls = open_controls.clone();
        let session_id = open_session_id.clone();
        let sender = open_sender.clone();
        let display_sender = open_display_sender.clone();
        let active = Arc::clone(&open_active);
        let registry = open_registry.clone();
        let fence = Arc::clone(&open_fence);
        let channels = Arc::clone(&open_channels);
        let pc = Arc::clone(&open_pc);
        let sessions = open_sessions.clone();
        let rtc_session_id = open_rtc_session_id.clone();
        let generation = open_generation.clone();
        Box::pin(async move {
            if !active.load(Ordering::Acquire) || !registry.is_current(agent) {
                return;
            }
            channels.mark_open(AgentChannel::Control).await;
            if !channels.wait_ready().await {
                sessions.schedule_close_if_same(&rtc_session_id, &generation, &pc);
                return;
            }
            let Some(effect) = channels.permit().await else {
                sessions.schedule_close_if_same(&rtc_session_id, &generation, &pc);
                return;
            };
            let _callback = fence.read().await;
            if !effect.valid() || !active.load(Ordering::Acquire) || !registry.is_current(agent) {
                return;
            }
            controls
                .register(agent_id, session_id.clone(), display_sender)
                .await;
            #[cfg(test)]
            sessions
                .pause_effect(&rtc_session_id, TestEffectPoint::Ready)
                .await;
            if !effect.valid() || !active.load(Ordering::Acquire) || !registry.is_current(agent) {
                return;
            }
            if agent_ctl::send_ready(&sender).await.is_err() {
                channels.stop();
                active.store(false, Ordering::Release);
                sessions.schedule_close_if_same(&rtc_session_id, &generation, &pc);
            }
        })
    }));

    dc.on_close(Box::new(move || {
        let close_tx = close_tx.clone();
        let channels = Arc::clone(&channels);
        let active = Arc::clone(&active);
        let pc = Arc::clone(&pc);
        let sessions = sessions.clone();
        let rtc_session_id = rtc_session_id.clone();
        let generation = generation.clone();
        Box::pin(async move {
            if let Some(close_tx) = close_tx.lock().await.take() {
                let _ = close_tx.send(());
            }
            channels.stop();
            active.store(false, Ordering::Release);
            sessions.schedule_close_if_same(&rtc_session_id, &generation, &pc);
        })
    }));
}

async fn handle_control_request(
    agent: AgentBinding,
    session_id: &str,
    request: ControlRequest,
    registry: &AgentRegistry,
    controls: &AgentControlHub,
    sender: &ControlSender,
    effect: &AgentEffectPermit,
) {
    let agent_id = agent.agent_id();
    let request_id = request.request_id;
    let transaction = controls.transaction(agent_id).await;
    let _guard = transaction.lock().await;
    if !effect.valid() {
        return;
    }
    if let Err(mut error) = execute_control_request(
        agent, session_id, request, registry, controls, sender, effect,
    )
    .await
    {
        if error.request_id.is_none() {
            error.request_id = Some(request_id);
        }
        agent_ctl::send_error(sender, &error).await;
    }
}

async fn execute_control_request(
    agent: AgentBinding,
    session_id: &str,
    request: ControlRequest,
    registry: &AgentRegistry,
    controls: &AgentControlHub,
    sender: &ControlSender,
    effect: &AgentEffectPermit,
) -> Result<(), ProtocolError> {
    let agent_id = agent.agent_id();
    if !effect.valid() || !registry.is_current(agent) {
        return Err(ProtocolError::new(
            Some(request.request_id),
            "stale_agent_generation",
            "the RTC session belongs to a replaced agent backend",
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
                if controls.is_owner(agent_id, session_id).await {
                    if !effect.valid() {
                        return Ok(());
                    }
                    resize_agent(agent, cols, rows, registry).await?;
                    if !effect.valid() {
                        return Ok(());
                    }
                    let _ = controls.update_size(agent_id, session_id, cols, rows).await;
                }
            }
            if !effect.valid() {
                return Ok(());
            }
            send_agent_replay(
                agent,
                ReplaySpec {
                    session_id,
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
            send_agent_replay(
                agent,
                ReplaySpec {
                    session_id,
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
        ControlOperation::Resize { cols, rows } => {
            if !controls.is_owner(agent_id, session_id).await {
                return Err(ProtocolError::new(
                    Some(request_id),
                    "not_display_owner",
                    "only the controlling viewer may resize the shared PTY",
                ));
            }
            if !effect.valid() {
                return Ok(());
            }
            resize_agent(agent, cols, rows, registry).await?;
            if !effect.valid() {
                return Ok(());
            }
            let _ = controls.update_size(agent_id, session_id, cols, rows).await;
            if !effect.valid() {
                return Ok(());
            }
            agent_ctl::send_ack(sender, request_id, operation_name).await?;
            Ok(())
        }
        ControlOperation::TakeControl { cols, rows } => {
            if !controls.contains_viewer(agent_id, session_id).await {
                return Err(ProtocolError::new(
                    Some(request_id),
                    "unknown_viewer",
                    "viewer is not registered on this control channel",
                ));
            }
            if !effect.valid() {
                return Ok(());
            }
            resize_agent(agent, cols, rows, registry).await?;
            if !effect.valid() {
                return Ok(());
            }
            let _ = controls
                .take_control(agent_id, session_id, cols, rows)
                .await;
            if !effect.valid() {
                return Ok(());
            }
            redraw_agent(agent, registry).await;
            if !effect.valid() {
                return Ok(());
            }
            agent_ctl::send_ack(sender, request_id, operation_name).await?;
            Ok(())
        }
        ControlOperation::Scroll { lines } => {
            if !effect.valid() {
                return Ok(());
            }
            scroll_agent(agent, lines, registry).await?;
            if !effect.valid() {
                return Ok(());
            }
            agent_ctl::send_ack(sender, request_id, operation_name).await?;
            Ok(())
        }
        ControlOperation::Redraw => {
            if !effect.valid() {
                return Ok(());
            }
            redraw_agent(agent, registry).await;
            if !effect.valid() {
                return Ok(());
            }
            agent_ctl::send_ack(sender, request_id, operation_name).await?;
            Ok(())
        }
    }
}

struct ReplaySpec<'a> {
    session_id: &'a str,
    request_id: Uuid,
    operation: &'a str,
    lines: u16,
    plain: bool,
}

async fn send_agent_replay(
    agent: AgentBinding,
    spec: ReplaySpec<'_>,
    registry: &AgentRegistry,
    sender: &ControlSender,
) -> Result<(), ProtocolError> {
    if spec.plain {
        return Err(ProtocolError::new(
            Some(spec.request_id),
            "plain_replay_unsupported",
            "plain replay is not supported; request styled terminal replay",
        ));
    }
    let Some(control) = registry.control_for_binding(agent) else {
        return Err(ProtocolError::new(
            Some(spec.request_id),
            "agent_unavailable",
            "agent is not attached to this daemon",
        ));
    };
    if !control
        .wait_for_direct_sink(spec.session_id, Duration::from_secs(3))
        .await
    {
        return Err(ProtocolError::new(
            Some(spec.request_id),
            "pty_channel_unavailable",
            "spawn.pty did not become ready for this control session",
        ));
    }
    let capture = capture_agent_replay(agent, spec.lines, spec.plain, registry, &control);
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
        .direct_sink_anchor(spec.session_id, source_boundary)
        .await
        .ok_or_else(|| {
            ProtocolError::new(
                Some(spec.request_id),
                "pty_channel_unavailable",
                "spawn.pty disconnected while replay was captured",
            )
        })?;
    agent_ctl::send_replay(
        sender,
        spec.request_id,
        spec.operation,
        spec.plain,
        Some(pty_offset),
        &replay,
    )
    .await
}

async fn capture_agent_replay(
    agent: AgentBinding,
    lines: u16,
    _plain: bool,
    registry: &AgentRegistry,
    control: &crate::pty::ForwarderControl,
) -> Result<crate::pty::WorkerReplay, ProtocolError> {
    let max_bytes = if lines == agent_ctl::MAX_HISTORY_LINES {
        8 * 1024 * 1024
    } else {
        (lines as u32)
            .saturating_mul(256)
            .clamp(64 * 1024, 8 * 1024 * 1024)
    };
    let mut replay_rx = None;
    registry.with_bound_handle(agent, |handle| {
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

async fn resize_agent(
    agent: AgentBinding,
    cols: u16,
    rows: u16,
    registry: &AgentRegistry,
) -> Result<(), ProtocolError> {
    let mut result = None;
    let found = registry.with_bound_handle(agent, |handle| {
        result = Some(handle.resize(cols, rows));
    });
    if !found {
        return Err(ProtocolError::new(
            None,
            "agent_unavailable",
            "agent is not running on this daemon",
        ));
    }
    result
        .expect("found handle sets result")
        .map_err(|error| ProtocolError::new(None, "resize_failed", &format!("{error:#}")))?;
    Ok(())
}

async fn scroll_agent(
    agent: AgentBinding,
    lines: i16,
    registry: &AgentRegistry,
) -> Result<(), ProtocolError> {
    if !registry.is_current(agent) {
        return Err(ProtocolError::new(
            None,
            "agent_unavailable",
            "agent is not running on this daemon",
        ));
    }
    tracing::debug!(agent_id = %agent.agent_id(), lines, "ignoring deprecated scroll operation");
    Ok(())
}

async fn redraw_agent(agent: AgentBinding, registry: &AgentRegistry) {
    tracing::debug!(agent_id = %agent.agent_id(), current = registry.is_current(agent), "ignoring deprecated redraw operation");
}

/// Testable core of the `spawn.pty` input callback. Activity is recorded only
/// after a successful, non-empty binary write, and the helper API exposes no
/// input bytes to the content-free activity serializer.
fn forward_bound_data_channel_input(
    agent: AgentBinding,
    is_string: bool,
    data: &[u8],
    registry: &AgentRegistry,
    out_tx: &mpsc::Sender<WsOutbound>,
) -> Option<Result<bool>> {
    let mut result = None;
    registry.with_bound_handle(agent, |handle| {
        result = Some(forward_data_channel_input(
            agent.agent_id(),
            is_string,
            data,
            &handle.control,
            out_tx,
            |bytes| handle.write_stdin(bytes),
        ));
    });
    result
}

fn rtc_output_allowed(registry: &AgentRegistry, agent: AgentBinding) -> bool {
    registry.is_current(agent)
}

fn forward_data_channel_input<W>(
    agent_id: Uuid,
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
    if control.note_input() {
        crate::pty::try_emit_activity(out_tx, agent_id, crate::pty::ActivityKind::Input);
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

fn parse_ice_transport_policy(value: Option<&str>) -> Result<RTCIceTransportPolicy> {
    match value {
        Some("relay") => Ok(RTCIceTransportPolicy::Relay),
        Some("all") | None => Ok(RTCIceTransportPolicy::All),
        Some(_) => anyhow::bail!("unsupported ICE transport policy"),
    }
}

fn install_host_ice_handler(
    pc: &Arc<RTCPeerConnection>,
    session_id: String,
    binding: HostRtcBinding,
    out_tx: mpsc::Sender<WsOutbound>,
) {
    pc.on_ice_candidate(Box::new(move |candidate| {
        let session_id = session_id.clone();
        let binding = binding.clone();
        let out_tx = out_tx.clone();
        Box::pin(async move {
            let Some(candidate) = candidate else { return };
            let Ok(candidate) = candidate.to_json() else {
                return;
            };
            let Ok(candidate) = serde_json::to_value(candidate) else {
                return;
            };
            send_json(
                &out_tx,
                Outbound::RtcCandidate {
                    session_id,
                    binding_nonce: Some(binding.binding_nonce),
                    agent_id: None,
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
    session_id: String,
    binding: HostRtcBinding,
    out_tx: mpsc::Sender<WsOutbound>,
    files_override: Option<Arc<HostFileService>>,
) {
    let accepted = Arc::new(AtomicBool::new(false));
    pc.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
        let accepted = Arc::clone(&accepted);
        let session_id = session_id.clone();
        let binding = binding.clone();
        let out_tx = out_tx.clone();
        let files = files_override.clone();
        Box::pin(async move {
            if dc.label() != HOST_CONTROL_LABEL || accepted.swap(true, Ordering::AcqRel) {
                let _ = dc.close().await;
                return;
            }
            install_host_control_channel(dc, session_id, binding, out_tx, files);
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
    session_id: String,
    binding: HostRtcBinding,
    out_tx: mpsc::Sender<WsOutbound>,
    files_override: Option<Arc<HostFileService>>,
) {
    crate::host_control::install(dc, session_id, binding, out_tx, files_override);
}

pub(crate) async fn send_host_status(
    out_tx: &mpsc::Sender<WsOutbound>,
    session_id: String,
    binding: &HostRtcBinding,
    status: &str,
) {
    send_json(
        out_tx,
        Outbound::RtcStatus {
            session_id,
            binding_nonce: Some(binding.binding_nonce.clone()),
            agent_id: None,
            scope_type: Some("host".to_string()),
            scope_id: Some(binding.host_id),
            protocol: Some(binding.protocol.clone()),
            protocol_version: Some(binding.protocol_version),
            status: status.to_string(),
            message: None,
        },
    )
    .await;
}

fn try_send_status(
    out_tx: &mpsc::Sender<WsOutbound>,
    session_id: &str,
    binding_nonce: &str,
    agent_id: Uuid,
    status: &str,
    message: Option<&str>,
) -> bool {
    let frame = Outbound::RtcStatus {
        session_id: session_id.to_string(),
        binding_nonce: Some(binding_nonce.to_string()),
        agent_id: Some(agent_id),
        scope_type: Some("agent".to_string()),
        scope_id: Some(agent_id),
        protocol: Some(PTY_DATA_CHANNEL_LABEL.to_string()),
        protocol_version: Some(AGENT_RTC_PROTOCOL_VERSION),
        status: status.to_string(),
        message: message.map(str::to_string),
    };
    let Ok(text) = serde_json::to_string(&frame) else {
        return false;
    };
    out_tx.try_send(WsOutbound::json(text)).is_ok()
}

async fn send_status(
    out_tx: &mpsc::Sender<WsOutbound>,
    session_id: String,
    binding_nonce: String,
    agent_id: Uuid,
    status: &str,
    message: Option<&str>,
) {
    send_json(
        out_tx,
        Outbound::RtcStatus {
            session_id,
            binding_nonce: Some(binding_nonce),
            agent_id: Some(agent_id),
            scope_type: Some("agent".to_string()),
            scope_id: Some(agent_id),
            protocol: Some(PTY_DATA_CHANNEL_LABEL.to_string()),
            protocol_version: Some(AGENT_RTC_PROTOCOL_VERSION),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_files::STREAM_CHUNK_BYTES;
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use sha2::{Digest, Sha256};
    use std::path::Path;

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

    async fn paired_host_endpoint(
        files: Arc<HostFileService>,
        binding: HostRtcBinding,
        session_id: &str,
    ) -> (
        Arc<RTCPeerConnection>,
        Arc<RTCPeerConnection>,
        Arc<RTCDataChannel>,
        mpsc::Receiver<(usize, String)>,
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
            .create_data_channel(HOST_CONTROL_LABEL, None)
            .await
            .unwrap();
        let (messages_tx, mut messages_rx) = mpsc::channel::<(usize, String)>(64);
        channel.on_message(Box::new(move |message: DataChannelMessage| {
            let messages_tx = messages_tx.clone();
            Box::pin(async move {
                let _ = messages_tx
                    .send((0, String::from_utf8_lossy(&message.data).into_owned()))
                    .await;
            })
        }));
        let (out_tx, _out_rx) = mpsc::channel(4);
        install_host_data_channel_handler(
            &daemon_pc,
            session_id.to_string(),
            binding,
            out_tx,
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
        registry: &AgentRegistry,
        agent_id: Uuid,
    ) -> (AgentBinding, mpsc::Receiver<crate::pty::WorkerCmd>) {
        let (cmd_tx, cmd_rx) = mpsc::channel(crate::pty::WORKER_COMMAND_QUEUE_DEPTH);
        let (outbox_tx, _outbox_rx) = mpsc::channel(crate::pty::WORKER_OUTPUT_QUEUE_DEPTH);
        let handle = crate::pty::AgentHandle::new_worker(crate::pty::WorkerHandleParts {
            agent_id,
            cmd_tx,
            lifecycle: crate::pty::AgentLifecycle::new(
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
            registry.binding_for(agent_id).expect("worker binding"),
            cmd_rx,
        )
    }

    struct RtcTestClient {
        pc: Arc<RTCPeerConnection>,
        pty: Arc<RTCDataChannel>,
        ctl: Arc<RTCDataChannel>,
        pty_messages: mpsc::Receiver<Vec<u8>>,
        ctl_messages: mpsc::Receiver<(bool, Vec<u8>)>,
    }

    #[derive(Clone, Copy)]
    struct TestAgentChannel {
        label: &'static str,
        ordered: bool,
        close_on_open: bool,
    }

    impl TestAgentChannel {
        const fn ordered(label: &'static str) -> Self {
            Self {
                label,
                ordered: true,
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
        registry: &AgentRegistry,
        agent_id: Uuid,
        session_id: &str,
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
                RtcSessionBinding::new(session_id.to_string(), generation.to_string(), agent_id),
                offer_sdp,
                Vec::new(),
                registry.clone(),
                out_tx,
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
                    if value["version"] == agent_ctl::PROTOCOL_VERSION
                        && value["kind"] == "event"
                        && value["event"] == "ready"
                    {
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
        }
    }

    async fn connect_rtc_session(
        sessions: &RtcSessions,
        registry: &AgentRegistry,
        agent_id: Uuid,
        session_id: &str,
        generation: &str,
    ) -> RtcTestClient {
        connect_rtc_session_inner(sessions, registry, agent_id, session_id, generation, true).await
    }

    async fn assert_real_agent_channels_fail_closed(
        case: &'static str,
        specs: &[TestAgentChannel],
        probe: Option<PartialPeerProbe>,
    ) {
        let agent_id = Uuid::new_v4();
        let session_id = format!("invalid-{case}-{}", Uuid::new_v4());
        let generation = "generation";
        let viewer = viewer_id(&session_id, generation);
        let registry = AgentRegistry::new();
        let (agent, mut worker_commands) = insert_test_worker(&registry, agent_id);
        let control = registry.control_for_binding(agent).expect("worker control");
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
                RtcSessionBinding::new(session_id.clone(), generation.to_string(), agent_id),
                offer_sdp,
                Vec::new(),
                registry,
                out_tx,
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
                                !sessions.controls.contains_viewer(agent_id, &viewer).await,
                                "{case}: pre-ready control frame registered a viewer"
                            );
                            assert!(
                                !sessions.controls.is_owner(agent_id, &viewer).await,
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
            !sessions.controls.contains_viewer(agent_id, &viewer).await,
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

    fn built_worker_bin() -> std::path::PathBuf {
        let exe = std::env::current_exe().expect("current_exe");
        exe.parent()
            .and_then(|deps| deps.parent())
            .map(|debug| debug.join("spawn-worker"))
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
            let dir = tempfile::tempdir().expect("worker tempdir");
            std::env::set_var("SPAWND_WORKER_DIR", dir.path());
            std::env::set_var("SPAWND_WORKER_BIN", built_worker_bin());
            Self {
                old_dir,
                old_bin,
                _dir: dir,
            }
        }

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
        agent_id: Uuid,
        lifecycle: Option<crate::pty::AgentLifecycle>,
        supervisor_keepalive: Option<mpsc::Sender<crate::pty::WorkerCmd>>,
    }

    impl WorkerCleanupGuard {
        fn new(agent_id: Uuid, handle: &crate::pty::AgentHandle) -> Self {
            Self {
                agent_id,
                lifecycle: Some(handle.lifecycle()),
                supervisor_keepalive: Some(handle.worker_connection_keepalive()),
            }
        }

        fn refresh(&mut self, handle: &crate::pty::AgentHandle) {
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
            let agent_id = self.agent_id;
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
                        while crate::worker_backend::socket_exists(agent_id)
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
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn worker_cleanup_guard_drop_is_bounded_on_a_nonwritable_endpoint() {
        let _env_lock = crate::worker_backend::WORKER_TEST_ENV_LOCK.lock().await;
        let env = WorkerTestEnv::install();
        let agent_id = Uuid::new_v4();
        spawnd::sessiond::endpoint::ensure_private_dir(env.path())
            .expect("secure guard test worker directory");
        let ordinary_path = env.path().join(format!("{agent_id}.sock"));
        let ordinary = std::os::unix::net::UnixDatagram::bind(&ordinary_path)
            .expect("bind persistent fake worker endpoint");
        let ordinary_identity = spawnd::sessiond::endpoint::secure_bound_socket(&ordinary_path)
            .expect("secure persistent fake worker endpoint");
        let lifecycle_path = spawnd::sessiond::wire::lifecycle_socket_path(&ordinary_path);
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
        let handle = crate::pty::AgentHandle::new_worker(crate::pty::WorkerHandleParts {
            agent_id,
            cmd_tx,
            lifecycle: crate::pty::AgentLifecycle::new(lifecycle_path, Uuid::new_v4()),
            alive: Arc::new(AtomicBool::new(true)),
            cols: 80,
            rows: 24,
            outbox_tx,
            control: crate::pty::ForwarderControl::new(),
        });
        let guard = WorkerCleanupGuard::new(agent_id, &handle);
        drop(handle);

        let started = std::time::Instant::now();
        drop(guard);
        assert!(
            started.elapsed() <= WORKER_TEST_CLEANUP_TIMEOUT + Duration::from_millis(500),
            "worker cleanup guard exceeded its advertised bound"
        );
        assert!(
            crate::worker_backend::socket_exists(agent_id),
            "test did not retain the deliberately stuck worker endpoint"
        );
        assert!(
            unrelated.0.try_wait().unwrap().is_none(),
            "worker cleanup guard touched an unrelated process"
        );
        drop(ordinary_identity);
        drop(ordinary);
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
                            replay.len() / agent_ctl::CHUNK_PAYLOAD_BYTES
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
    async fn real_agent_channel_gate_rejects_every_invalid_shape_without_residents() {
        let missing_pty = [TestAgentChannel::ordered(CONTROL_DATA_CHANNEL_LABEL)];
        let missing_ctl = [TestAgentChannel::ordered(PTY_DATA_CHANNEL_LABEL)];
        let duplicate_pty = [
            TestAgentChannel::ordered(PTY_DATA_CHANNEL_LABEL),
            TestAgentChannel::ordered(PTY_DATA_CHANNEL_LABEL),
            TestAgentChannel::ordered(CONTROL_DATA_CHANNEL_LABEL),
        ];
        let duplicate_ctl = [
            TestAgentChannel::ordered(PTY_DATA_CHANNEL_LABEL),
            TestAgentChannel::ordered(CONTROL_DATA_CHANNEL_LABEL),
            TestAgentChannel::ordered(CONTROL_DATA_CHANNEL_LABEL),
        ];
        let unknown = [
            TestAgentChannel::ordered(PTY_DATA_CHANNEL_LABEL),
            TestAgentChannel::ordered("spawn.unknown"),
            TestAgentChannel::ordered(CONTROL_DATA_CHANNEL_LABEL),
        ];
        let early_close = [
            TestAgentChannel {
                close_on_open: true,
                ..TestAgentChannel::ordered(PTY_DATA_CHANNEL_LABEL)
            },
            TestAgentChannel::ordered(CONTROL_DATA_CHANNEL_LABEL),
        ];
        let unordered = [
            TestAgentChannel {
                ordered: false,
                ..TestAgentChannel::ordered(PTY_DATA_CHANNEL_LABEL)
            },
            TestAgentChannel::ordered(CONTROL_DATA_CHANNEL_LABEL),
        ];

        tokio::join!(
            assert_real_agent_channels_fail_closed(
                "missing-pty",
                &missing_pty,
                Some(PartialPeerProbe::ControlRequests),
            ),
            assert_real_agent_channels_fail_closed(
                "missing-ctl",
                &missing_ctl,
                Some(PartialPeerProbe::PtyInput),
            ),
            assert_real_agent_channels_fail_closed("duplicate-pty", &duplicate_pty, None),
            assert_real_agent_channels_fail_closed("duplicate-ctl", &duplicate_ctl, None),
            assert_real_agent_channels_fail_closed("unknown", &unknown, None),
            assert_real_agent_channels_fail_closed("early-close", &early_close, None),
            assert_real_agent_channels_fail_closed("unordered", &unordered, None),
        );
    }

    async fn wait_effect_gate(gate: &TestEffectGate) {
        tokio::time::timeout(Duration::from_secs(10), gate.entered.notified())
            .await
            .expect("effect gate was not reached");
    }

    async fn wait_peer_stopped(sessions: &RtcSessions, session_id: &str) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let stopped = sessions
                    .peers
                    .lock()
                    .await
                    .get(session_id)
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
        agent_id: Uuid,
        viewer: &str,
    ) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if sessions.resident_session_count().await == 0
                    && !sessions.controls.contains_viewer(agent_id, viewer).await
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn admitted_input_and_control_abort_when_counterpart_closes() {
        let agent_id = Uuid::new_v4();
        let registry = AgentRegistry::new();
        let (agent, mut worker_commands) = insert_test_worker(&registry, agent_id);
        let control = registry.control_for_binding(agent).expect("worker control");
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

        for (session_id, point) in [
            ("close-race-control", TestEffectPoint::ControlRequest),
            ("close-race-input", TestEffectPoint::PtyInput),
        ] {
            let viewer = viewer_id(session_id, "generation");
            let client =
                connect_rtc_session(&sessions, &registry, agent_id, session_id, "generation").await;
            let gate = sessions.stall_effect(session_id, point).await;
            match point {
                TestEffectPoint::ControlRequest => {
                    sessions.controls.unregister(agent_id, &viewer).await;
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
            wait_peer_stopped(&sessions, session_id).await;
            gate.release.notify_one();
            wait_peer_cleanup(&sessions, &control, agent_id, &viewer).await;
            assert!(
                matches!(
                    observed_rx.try_recv(),
                    Err(tokio::sync::mpsc::error::TryRecvError::Empty)
                ),
                "{session_id}: admitted effect reached worker after counterpart close"
            );
            assert_eq!(sessions.controls.retained_counts().await, (0, 0));
            close_test_peer(&client.pc).await;
        }
        worker.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn admitted_sink_and_ready_abort_when_counterpart_closes() {
        let agent_id = Uuid::new_v4();
        let registry = AgentRegistry::new();
        let (agent, mut worker_commands) = insert_test_worker(&registry, agent_id);
        let control = registry.control_for_binding(agent).expect("worker control");
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

        for (session_id, point) in [
            ("close-race-sink", TestEffectPoint::PtySink),
            ("close-race-ready", TestEffectPoint::Ready),
        ] {
            let viewer = viewer_id(session_id, "generation");
            let gate = sessions.stall_effect(session_id, point).await;
            let mut client = connect_rtc_session_inner(
                &sessions,
                &registry,
                agent_id,
                session_id,
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
            wait_peer_stopped(&sessions, session_id).await;
            gate.release.notify_one();
            wait_peer_cleanup(&sessions, &control, agent_id, &viewer).await;
            assert_eq!(control.direct_sink_offset(&viewer).await, None);
            assert!(!sessions.controls.contains_viewer(agent_id, &viewer).await);
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
    async fn full_signaling_outbox_cannot_hold_teardown_or_leak_stale_status() {
        let registry = AgentRegistry::new();
        let agent_id = Uuid::new_v4();
        let (agent, _commands) = insert_test_worker(&registry, agent_id);
        let control = registry.control_for_binding(agent).expect("worker control");
        let api = APIBuilder::new().build();
        let pc = Arc::new(
            api.new_peer_connection(RTCConfiguration::default())
                .await
                .unwrap(),
        );
        let active = Arc::new(AtomicBool::new(true));
        let channels = Arc::new(RequiredAgentChannels::default());
        assert!(channels.register(AgentChannel::Pty).await);
        assert!(channels.register(AgentChannel::Control).await);
        channels.mark_open(AgentChannel::Pty).await;
        channels.mark_open(AgentChannel::Control).await;
        let fence = Arc::new(tokio::sync::RwLock::new(()));
        let sessions = RtcSessions::new();
        let session_id = "full-status-outbox";
        let generation = "old-generation";
        sessions.peers.lock().await.insert(
            session_id.to_string(),
            RtcPeer {
                pc: Arc::clone(&pc),
                agent,
                generation: generation.to_string(),
                active: Arc::clone(&active),
                control: control.clone(),
                channels: Arc::clone(&channels),
                fence: Arc::clone(&fence),
            },
        );

        let (out_tx, mut out_rx) = mpsc::channel(1);
        out_tx
            .try_send(WsOutbound::json(r#"{"type":"sentinel"}"#.to_string()))
            .expect("fill signaling outbox");
        let effect = channels.permit().await.expect("admitted PTY callback");
        let callback = fence.read().await;
        let old_nonce = "b".repeat(32);
        let sent = tokio::time::timeout(
            Duration::from_millis(100),
            sessions.send_agent_peer_status(
                &out_tx,
                session_id,
                generation,
                &pc,
                &active,
                &channels,
                &old_nonce,
                agent_id,
                "connected",
                None,
            ),
        )
        .await
        .expect("full signaling outbox blocked the lifecycle callback");
        assert!(!sent);
        assert!(channels.failed.load(Ordering::SeqCst));
        assert!(!active.load(Ordering::Acquire));

        let closing_sessions = sessions.clone();
        let close = tokio::spawn(async move {
            closing_sessions.close_all().await;
        });
        tokio::task::yield_now().await;
        drop(callback);
        drop(effect);
        tokio::time::timeout(Duration::from_secs(3), close)
            .await
            .expect("full signaling outbox wedged teardown")
            .unwrap();
        assert_eq!(sessions.resident_session_count().await, 0);
        let sentinel = out_rx.recv().await.expect("sentinel frame");
        assert_eq!(sentinel.as_str(), r#"{"type":"sentinel"}"#);
        assert!(matches!(
            out_rx.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));

        let replacement_pc = Arc::new(
            api.new_peer_connection(RTCConfiguration::default())
                .await
                .unwrap(),
        );
        let replacement_active = Arc::new(AtomicBool::new(true));
        let replacement_channels = Arc::new(RequiredAgentChannels::default());
        let replacement_fence = Arc::new(tokio::sync::RwLock::new(()));
        sessions.peers.lock().await.insert(
            session_id.to_string(),
            RtcPeer {
                pc: Arc::clone(&replacement_pc),
                agent,
                generation: "replacement-generation".to_string(),
                active: Arc::clone(&replacement_active),
                control,
                channels: Arc::clone(&replacement_channels),
                fence: replacement_fence,
            },
        );
        let (replacement_tx, mut replacement_rx) = mpsc::channel(1);
        let replacement_nonce = "c".repeat(32);
        assert!(
            sessions
                .send_agent_peer_status(
                    &replacement_tx,
                    session_id,
                    "replacement-generation",
                    &replacement_pc,
                    &replacement_active,
                    &replacement_channels,
                    &replacement_nonce,
                    agent_id,
                    "connected",
                    None,
                )
                .await
        );
        let replacement_status = replacement_rx.recv().await.expect("replacement status");
        let replacement_status: serde_json::Value =
            serde_json::from_str(replacement_status.as_str()).unwrap();
        assert_eq!(replacement_status["binding_nonce"], replacement_nonce);
        sessions.close_all().await;
    }

    #[tokio::test]
    async fn close_all_cannot_remove_a_same_session_replacement() {
        let registry = AgentRegistry::new();
        let agent_id = Uuid::new_v4();
        let (old, _old_commands) = insert_test_worker(&registry, agent_id);
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
        let session_id = "close-all-reinsert";
        let generation = "old-signal-generation";
        sessions.peers.lock().await.insert(
            session_id.to_string(),
            RtcPeer {
                pc: Arc::clone(&old_pc),
                agent: old,
                generation: generation.to_string(),
                active: Arc::clone(&old_active),
                control: old_control,
                channels: Arc::new(RequiredAgentChannels::default()),
                fence: Arc::new(tokio::sync::RwLock::new(())),
            },
        );

        let snapshot_gate = sessions
            .stall_effect(session_id, TestEffectPoint::CloseAllSnapshot)
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
                .close_if_same(session_id, generation, &close_same_pc)
                .await;
        });
        tokio::time::timeout(Duration::from_secs(3), close_same)
            .await
            .expect("exact close did not remove the old peer")
            .unwrap();
        assert!(!sessions.peers.lock().await.contains_key(session_id));

        let (replacement, _replacement_commands) = insert_test_worker(&registry, agent_id);
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
            session_id.to_string(),
            RtcPeer {
                pc: Arc::clone(&replacement_pc),
                agent: replacement,
                generation: "replacement-signal-generation".to_string(),
                active: Arc::clone(&replacement_active),
                control: replacement_control,
                channels: Arc::new(RequiredAgentChannels::default()),
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
            .get(session_id)
            .expect("replacement was silently removed");
        assert_eq!(tracked.agent, replacement);
        assert!(Arc::ptr_eq(&tracked.pc, &replacement_pc));
        drop(peers);
        assert!(replacement_active.load(Ordering::Acquire));
        assert!(!old_active.load(Ordering::Acquire));
        sessions.close_all().await;
        assert!(!replacement_active.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn real_spawn_pty_and_ctl_channels_replay_live_input_and_cleanup() {
        let agent_id = Uuid::new_v4();
        let viewer = "rtc-real:generation".to_string();
        let registry = AgentRegistry::new();
        let (agent, mut worker_commands) = insert_test_worker(&registry, agent_id);
        let control = registry.control_for_binding(agent).unwrap();
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
            connect_rtc_session(&sessions, &registry, agent_id, "rtc-real", "generation").await;
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
        assert_eq!(replay_chunk[4], agent_ctl::PROTOCOL_VERSION);
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
            connect_rtc_session(&sessions, &registry, agent_id, "rtc-second", "generation").await;
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
        sessions.close("rtc-second", "generation", agent_id).await;
        close_test_peer(&second.pc).await;
        assert_eq!(sessions.resident_session_count().await, 1);

        sessions.close("rtc-real", "generation", agent_id).await;
        assert_eq!(sessions.resident_session_count().await, 0);
        close_test_peer(&client.pc).await;
        tokio::time::timeout(Duration::from_secs(3), async {
            while sessions.controls.contains_viewer(agent_id, &viewer).await
                || control.direct_sink_offset(&viewer).await.is_some()
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("RTC viewer cleanup timed out");

        let stall_gate = sessions.stall_first_pty_send("rtc-stalled").await;
        let stalled =
            connect_rtc_session(&sessions, &registry, agent_id, "rtc-stalled", "generation").await;
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
        sessions.close("rtc-stalled", "generation", agent_id).await;
        close_test_peer(&stalled.pc).await;
        assert_eq!(sessions.resident_session_count().await, 0);
        worker.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn real_worker_cleanup_guard_kills_on_unwind() {
        let _env_lock = crate::worker_backend::WORKER_TEST_ENV_LOCK.lock().await;
        let _env = WorkerTestEnv::install();
        let agent_id = Uuid::new_v4();
        let argv = vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "exec cat".to_string(),
        ];
        let mut env = std::collections::BTreeMap::new();
        env.insert(
            "PATH".to_string(),
            std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".to_string()),
        );
        env.insert("TERM".to_string(), "xterm-256color".to_string());

        let launched = crate::worker_backend::launch(crate::pty::LaunchSpec {
            agent_id,
            cwd: "/",
            cols: 80,
            rows: 24,
            argv: &argv,
            env: &env,
        })
        .await
        .expect("launch cleanup-guard worker");
        let crate::pty::Launched {
            handle, exit_rx, ..
        } = launched;
        let cleanup = WorkerCleanupGuard::new(agent_id, &handle);

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
            !crate::worker_backend::socket_exists(agent_id),
            "cleanup guard left its worker endpoint behind"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn real_worker_rtc_launch_adopt_backpressure_catchup_and_exit() {
        let _env_lock = crate::worker_backend::WORKER_TEST_ENV_LOCK.lock().await;
        let _env = WorkerTestEnv::install();
        let agent_id = Uuid::new_v4();
        let argv = vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "printf 'rtc-worker-ready\\n'; exec cat".to_string(),
        ];
        let mut env = std::collections::BTreeMap::new();
        env.insert(
            "PATH".to_string(),
            std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".to_string()),
        );
        env.insert("TERM".to_string(), "xterm-256color".to_string());

        let launched = crate::worker_backend::launch(crate::pty::LaunchSpec {
            agent_id,
            cwd: "/",
            cols: 80,
            rows: 24,
            argv: &argv,
            env: &env,
        })
        .await
        .expect("launch real worker");
        let crate::pty::Launched {
            handle,
            exit_rx: initial_exit_rx,
            ..
        } = launched;
        let mut worker_cleanup = WorkerCleanupGuard::new(agent_id, &handle);
        let initial_control = handle.control.clone();
        let (ws_tx, mut ws_rx) = mpsc::channel(1024);
        initial_control.set_sink(ws_tx).await;
        let ws_drain = tokio::spawn(async move { while ws_rx.recv().await.is_some() {} });
        let registry = AgentRegistry::new();
        let sessions = RtcSessions::new();
        let transition = registry.lock_generation_transition(agent_id).await;
        registry.insert(handle);
        drop(transition);

        let mut first =
            connect_rtc_session(&sessions, &registry, agent_id, "worker-first", "launch").await;
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
            connect_rtc_session(&sessions, &registry, agent_id, "worker-second", "launch").await;
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

        sessions.close("worker-second", "launch", agent_id).await;
        close_test_peer(&second.pc).await;
        sessions.close("worker-first", "launch", agent_id).await;
        close_test_peer(&first.pc).await;
        assert_eq!(sessions.resident_session_count().await, 0);

        // Simulate a supervisor restart: invalidate and drain the old RTC
        // generation, drop its worker connection, then adopt the live worker.
        let old = registry.binding_for(agent_id).expect("launch binding");
        let transition = registry.lock_generation_transition(agent_id).await;
        let old_handle = registry
            .remove_if_generation(agent_id, old.generation())
            .expect("remove launch binding");
        sessions.close_for_agent(agent_id, old.generation()).await;
        drop(transition);
        drop(old_handle);
        drop(initial_exit_rx);
        tokio::time::sleep(Duration::from_millis(200)).await;

        let adopted = crate::worker_backend::adopt(agent_id)
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
        let transition = registry.lock_generation_transition(agent_id).await;
        registry.insert(handle);
        drop(transition);

        let mut reconnected =
            connect_rtc_session(&sessions, &registry, agent_id, "worker-adopted", "adopt").await;
        let adopted_history = request_history(&mut reconnected).await;
        assert!(
            adopted_history
                .windows(b"rtc-worker-input".len())
                .any(|window| window == b"rtc-worker-input"),
            "adopted replay lost pre-adoption output"
        );
        sessions.close("worker-adopted", "adopt", agent_id).await;
        close_test_peer(&reconnected.pc).await;

        // Stall the first outbound PTY send, then drive real worker output
        // until the bounded direct queue evicts this RTC viewer. The earlier
        // RTC input assertion already covers the endpoint input path; direct
        // worker injection here makes output volume deterministic.
        let stall_gate = sessions.stall_first_pty_send("worker-stalled").await;
        let stalled =
            connect_rtc_session(&sessions, &registry, agent_id, "worker-stalled", "adopt").await;
        let stalled_viewer = viewer_id("worker-stalled", "adopt");
        assert!(
            adopted_control
                .wait_for_direct_sink(&stalled_viewer, Duration::from_secs(3))
                .await
        );
        let tail_marker = format!("rtc-catchup-tail-{agent_id}");
        // Wait for each one-byte TTY echo to traverse the real worker before
        // sending the next. This deterministically creates more queue entries
        // than the stalled sink can hold without a multi-megabyte flood.
        for _ in 0..(crate::pty::DIRECT_SINK_QUEUE_DEPTH + 12) {
            let expected = adopted_control.source_offset() + 1;
            assert!(registry.with_handle(agent_id, |handle| {
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
        assert!(registry.with_handle(agent_id, |handle| {
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
        sessions.close("worker-stalled", "adopt", agent_id).await;
        close_test_peer(&stalled.pc).await;

        let mut catchup =
            connect_rtc_session(&sessions, &registry, agent_id, "worker-catchup", "adopt").await;
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
            .lifecycle_snapshot(agent_id)
            .expect("agent lifecycle");
        registry
            .shutdown_if_current(&lifecycle, spawnd::sessiond::wire::LifecycleSignal::Kill)
            .await
            .expect("KILL delivery");
        let reason = tokio::time::timeout(Duration::from_secs(15), adopted_exit_rx)
            .await
            .expect("worker exit timed out")
            .expect("worker exit sender dropped");
        assert!(reason.exit_code.is_some() || reason.signal.is_some());
        let current = registry.binding_for(agent_id).expect("adopted binding");
        let transition = registry.lock_generation_transition(agent_id).await;
        let exited_handle = registry
            .remove_if_generation(agent_id, current.generation())
            .expect("remove exited worker");
        sessions
            .close_for_agent(agent_id, current.generation())
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
                RtcSessionBinding::new(
                    "worker-after-exit".to_string(),
                    "after-exit".to_string(),
                    agent_id,
                ),
                String::new(),
                Vec::new(),
                registry.clone(),
                status_tx,
            )
            .await;
        let status_message = status_rx.recv().await.expect("post-exit status");
        let status = status_message.as_str();
        let status: serde_json::Value = serde_json::from_str(status).unwrap();
        assert_eq!(status["type"], "rtc.status");
        assert_eq!(status["status"], "failed");
        assert_eq!(sessions.resident_session_count().await, 0);

        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while crate::worker_backend::socket_exists(agent_id) {
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
        let registry = AgentRegistry::new();
        let agent_id = Uuid::new_v4();
        let (old, _old_commands) = insert_test_worker(&registry, agent_id);
        let (current, mut current_commands) = insert_test_worker(&registry, agent_id);
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
        let controls = AgentControlHub::default();
        let (sender, _receiver) = mpsc::channel(4);
        let channels = Arc::new(RequiredAgentChannels::default());
        assert!(channels.register(AgentChannel::Pty).await);
        assert!(channels.register(AgentChannel::Control).await);
        channels.mark_open(AgentChannel::Pty).await;
        channels.mark_open(AgentChannel::Control).await;
        let effect = channels.permit().await.expect("ready effect permit");
        let error = execute_control_request(
            old,
            "stale-viewer",
            request,
            &registry,
            &controls,
            &sender,
            &effect,
        )
        .await
        .expect_err("stale control must fail");
        assert_eq!(error.code, "stale_agent_generation");
        assert!(current_commands.try_recv().is_err());

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

        let registry = AgentRegistry::new();
        let agent_id = Uuid::new_v4();
        let (old, _old_commands) = insert_test_worker(&registry, agent_id);
        let sessions = RtcSessions::new();
        let transition = registry.lock_generation_transition(agent_id).await;
        let insert_attempted = sessions.peer_insert_attempted.notified();
        let (out_tx, mut out_rx) = mpsc::channel(16);
        let offer_sessions = sessions.clone();
        let offer_registry = registry.clone();
        let offer_task = tokio::spawn(async move {
            offer_sessions
                .handle_offer(
                    RtcSessionBinding::new(
                        "racing-offer".to_string(),
                        "offer-generation".to_string(),
                        agent_id,
                    ),
                    offer_sdp,
                    Vec::new(),
                    offer_registry,
                    out_tx,
                )
                .await;
        });
        tokio::time::timeout(Duration::from_secs(10), insert_attempted)
            .await
            .expect("offer did not reach guarded peer insertion");

        assert!(registry
            .remove_if_generation(agent_id, old.generation())
            .is_some());
        sessions.close_for_agent(agent_id, old.generation()).await;
        let (current, _current_commands) = insert_test_worker(&registry, agent_id);
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
        assert_eq!(status["scope_type"], "agent");
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

        let registry = AgentRegistry::new();
        let agent_id = Uuid::new_v4();
        let (old, _old_commands) = insert_test_worker(&registry, agent_id);
        let sessions = RtcSessions::new();
        let (out_tx, _out_rx) = mpsc::channel(16);
        sessions
            .handle_offer(
                RtcSessionBinding::new(
                    "inserted-offer".to_string(),
                    "offer-generation".to_string(),
                    agent_id,
                ),
                offer_sdp,
                Vec::new(),
                registry.clone(),
                out_tx,
            )
            .await;
        assert_eq!(sessions.resident_session_count().await, 1);

        let transition = registry.lock_generation_transition(agent_id).await;
        assert!(registry
            .remove_if_generation(agent_id, old.generation())
            .is_some());
        sessions.close_for_agent(agent_id, old.generation()).await;
        let (current, _current_commands) = insert_test_worker(&registry, agent_id);
        drop(transition);

        assert!(registry.is_current(current));
        assert_eq!(sessions.resident_session_count().await, 0);
        offer_pc.close().await.unwrap();
    }

    #[tokio::test]
    async fn close_for_agent_drains_only_the_matching_backend_generation() {
        let registry = AgentRegistry::new();
        let agent_id = Uuid::new_v4();
        let (old, _old_commands) = insert_test_worker(&registry, agent_id);
        let old_control = registry.control_for_binding(old).unwrap();
        let (current, _current_commands) = insert_test_worker(&registry, agent_id);
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
        let old_channels = Arc::new(RequiredAgentChannels::default());
        let current_channels = Arc::new(RequiredAgentChannels::default());
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
                    agent: old,
                    generation: "old-signal".to_string(),
                    active: Arc::clone(&old_active),
                    control: old_control,
                    channels: old_channels,
                    fence: Arc::clone(&old_fence),
                },
            ),
            (
                "current-session".to_string(),
                RtcPeer {
                    pc: current_pc,
                    agent: current,
                    generation: "current-signal".to_string(),
                    active: Arc::clone(&current_active),
                    control: current_control,
                    channels: current_channels,
                    fence: current_fence,
                },
            ),
        ]);
        let (old_display, _old_display_rx) = tokio::sync::watch::channel(None);
        let (current_display, _current_display_rx) = tokio::sync::watch::channel(None);
        sessions
            .controls
            .register(agent_id, old_viewer.clone(), old_display)
            .await;
        sessions
            .controls
            .register(agent_id, current_viewer.clone(), current_display)
            .await;

        let in_flight = old_fence.read().await;
        let closing_sessions = sessions.clone();
        let close = tokio::spawn(async move {
            closing_sessions
                .close_for_agent(agent_id, old.generation())
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
                .contains_viewer(agent_id, &old_viewer)
                .await
        );
        assert!(
            sessions
                .controls
                .contains_viewer(agent_id, &current_viewer)
                .await
        );
        sessions.close_all().await;
    }

    #[test]
    fn rtc_binary_input_writes_and_emits_one_throttled_content_free_signal() {
        let agent_id = Uuid::new_v4();
        let control = crate::pty::ForwarderControl::new();
        let (out_tx, mut out_rx) = mpsc::channel(4);
        let writes = std::sync::Mutex::new(Vec::<Vec<u8>>::new());

        for data in [b"first secret".as_slice(), b"second secret".as_slice()] {
            assert!(forward_data_channel_input(
                agent_id,
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
            &format!(r#"{{"type":"agent.input_activity","agent_id":"{agent_id}"}}"#)
        );
        assert!(!json.contains("secret"));
        assert!(out_rx.try_recv().is_err());
    }

    #[test]
    fn rtc_text_empty_and_failed_input_do_not_emit_activity() {
        let agent_id = Uuid::new_v4();
        let control = crate::pty::ForwarderControl::new();
        let (out_tx, mut out_rx) = mpsc::channel(4);
        let write_calls = std::sync::atomic::AtomicUsize::new(0);

        assert!(
            !forward_data_channel_input(agent_id, true, b"text", &control, &out_tx, |_| {
                write_calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                Ok(())
            },)
            .unwrap()
        );
        assert!(
            !forward_data_channel_input(agent_id, false, b"", &control, &out_tx, |_| {
                write_calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                Ok(())
            },)
            .unwrap()
        );
        assert!(forward_data_channel_input(
            agent_id,
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
        let agent_id = Uuid::new_v4();
        let control = crate::pty::ForwarderControl::new();
        let (cmd_tx, _cmd_rx) = mpsc::channel(crate::pty::WORKER_COMMAND_QUEUE_DEPTH);
        let (outbox_tx, _outbox_rx) = mpsc::channel(crate::pty::WORKER_OUTPUT_QUEUE_DEPTH);
        let handle = crate::pty::AgentHandle::new_worker(crate::pty::WorkerHandleParts {
            agent_id,
            cmd_tx,
            lifecycle: crate::pty::AgentLifecycle::new(
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
            agent_id,
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
    fn server_agent_binding_requires_nonce_and_safe_owner_generation() {
        let agent_id = Uuid::new_v4();
        let nonce = "a".repeat(32);
        let first =
            RtcSessionBinding::from_server("session".to_string(), nonce.clone(), 1, agent_id)
                .unwrap();
        let second =
            RtcSessionBinding::from_server("session".to_string(), nonce.clone(), 2, agent_id)
                .unwrap();
        assert_eq!(first.binding_nonce, nonce);
        assert_ne!(first.generation, second.generation);
        assert!(RtcSessionBinding::from_server(
            "session".to_string(),
            "not-a-nonce".to_string(),
            1,
            agent_id,
        )
        .is_none());
        assert!(
            RtcSessionBinding::from_server("session".to_string(), "b".repeat(32), 0, agent_id,)
                .is_none()
        );
        assert!(RtcSessionBinding::from_server(
            "session".to_string(),
            "b".repeat(32),
            MAX_SAFE_SIGNAL_GENERATION + 1,
            agent_id,
        )
        .is_none());
    }

    #[test]
    fn host_binding_requires_exact_identity_protocol_and_nonce() {
        let host_id = Uuid::new_v4();
        let valid = HostRtcSignal {
            session_id: "host-session".to_string(),
            binding_nonce: Some("c".repeat(32)),
            scope_type: Some("host".to_string()),
            scope_id: Some(host_id),
            protocol: Some(HOST_CONTROL_LABEL.to_string()),
            protocol_version: Some(RTC_PROTOCOL_VERSION),
        };
        assert_eq!(valid.binding().unwrap().host_id, host_id);

        let mut invalid = valid.clone();
        invalid.scope_type = Some("agent".to_string());
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

    #[tokio::test]
    async fn daemon_host_identity_binds_without_an_agent_and_cannot_be_rebound() {
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
            protocol: HOST_CONTROL_LABEL.to_string(),
            protocol_version: RTC_PROTOCOL_VERSION,
        };
        let destination_binding = HostRtcBinding {
            host_id: destination_host_id,
            binding_nonce: "b".repeat(32),
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
                    .decode(message["bytes_b64"].as_str().unwrap())
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
                        "bytes_b64": STANDARD.encode(chunk),
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
    async fn closing_host_channel_during_write_begin_cleans_unpublished_temporary() {
        let root = tempfile::tempdir().unwrap();
        let files = Arc::new(HostFileService::rooted_at(root.path()).await.unwrap());
        let hooks = files.write_lifecycle_test_hooks();
        let binding = HostRtcBinding {
            host_id: Uuid::new_v4(),
            binding_nonce: "e".repeat(32),
            protocol: HOST_CONTROL_LABEL.to_string(),
            protocol_version: RTC_PROTOCOL_VERSION,
        };
        let (browser_pc, daemon_pc, channel, _messages) =
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
        hooks.release_begin_after_create();
        tokio::time::timeout(Duration::from_secs(2), hooks.wait_shutdown_complete())
            .await
            .expect("host write shutdown did not terminate");
        close.await.unwrap().unwrap();

        assert!(!root.path().join("must-not-exist.bin").exists());
        assert_no_upload_temporaries(root.path());
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

        hooks.arm_finish_before_commit();
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
        tokio::time::timeout(Duration::from_secs(2), hooks.wait_finish_before_commit())
            .await
            .expect("write finish did not pause before commit");

        let closing_channel = Arc::clone(&channel);
        let close = tokio::spawn(async move { closing_channel.close().await });
        tokio::time::timeout(Duration::from_secs(2), hooks.wait_shutdown_started())
            .await
            .expect("host write shutdown did not start");
        hooks.release_finish_before_commit();
        tokio::time::timeout(Duration::from_secs(2), hooks.wait_shutdown_complete())
            .await
            .expect("host write shutdown did not terminate");
        close.await.unwrap().unwrap();

        assert!(!root.path().join("must-not-commit.bin").exists());
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
                    "bytes_b64": STANDARD.encode(b"x"),
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
        let binding = HostRtcBinding {
            host_id: Uuid::new_v4(),
            binding_nonce: "d".repeat(32),
            protocol: HOST_CONTROL_LABEL.to_string(),
            protocol_version: RTC_PROTOCOL_VERSION,
        };
        let (browser_pc, daemon_pc, channel, mut messages) =
            paired_host_endpoint(files, binding, "stalled-write-control-paths").await;

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
        let write_stream_id = write["result"]["stream_id"].as_str().unwrap();
        channel
            .send_text(
                json!({
                    "version": RTC_PROTOCOL_VERSION,
                    "type": "stream.chunk",
                    "stream_id": write_stream_id,
                    "sequence": 0,
                    "bytes_b64": STANDARD.encode(b"x"),
                    "test_delay_ms": 1_000,
                })
                .to_string(),
            )
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;

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
    async fn zero_agent_host_files_round_trip_over_paired_data_channel() {
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
            protocol: HOST_CONTROL_LABEL.to_string(),
            protocol_version: RTC_PROTOCOL_VERSION,
        };
        let (out_tx, _out_rx) = mpsc::channel(4);
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
        install_host_data_channel_handler(
            &daemon_pc,
            "host-e2e".to_string(),
            binding,
            out_tx,
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
                        "bytes_b64": STANDARD.encode(chunk),
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
                    "bytes_b64": STANDARD.encode(b"a"),
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
                        "bytes_b64": STANDARD.encode([*byte]),
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
                    .decode(message["bytes_b64"].as_str().unwrap())
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

        tokio::time::timeout(Duration::from_secs(2), browser_pc.close())
            .await
            .expect("peer close must not wait behind a read sender")
            .unwrap();
        daemon_pc.close().await.unwrap();
    }
}
