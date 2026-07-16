//! WebRTC direct terminal transport.
//!
//! The central websocket remains the authenticated control/signaling plane.
//! Once a browser and daemon establish a DataChannel, raw PTY input/output can
//! bypass the server relay path while the daemon still mirrors output to the
//! server websocket for transcripts and fallback viewers.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use bytes::Bytes;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, Mutex, Notify, Semaphore};
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

use crate::agents::AgentRegistry;
use crate::host_files::{HostFileService, PendingWrite, STREAM_CHUNK_BYTES};
use crate::proto::{Outbound, RtcIceServerConfig};
use crate::pty::WsOutbound;
use crate::tmux;

const AGENT_DATA_CHANNEL_LABEL: &str = "spawn.pty";
const HOST_CONTROL_LABEL: &str = "spawn.host.ctl";
const RTC_PROTOCOL_VERSION: u16 = 1;
const HOST_CONTROL_MAX_FRAME_BYTES: usize = 16 * 1024;
const HOST_CONTROL_MAX_REQUEST_ID_BYTES: usize = 128;
const HOST_CONTROL_MAX_IN_FLIGHT: usize = 32;
const HOST_CONTROL_MAX_SEEN_REQUESTS: usize = 4096;
const HOST_STREAM_WINDOW_CHUNKS: u64 = 8;
const HOST_STREAM_ACK_TIMEOUT: Duration = Duration::from_secs(15);
const HOST_WRITE_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const HOST_MAX_WRITE_STREAMS: usize = 8;
const MAX_RTC_PEERS: usize = 128;
const MAX_HOST_RTC_PEERS: usize = 64;

/// Peer connections that never reach `Connected` within this window are
/// reaped. Closing is the daemon's own defense: `rtc.close` delivery from the
/// browser/server is best-effort, and every unreaped peer connection holds
/// multiple UDP sockets (ICE host candidates + mDNS) until closed — webrtc-rs
/// does NOT release them on drop.
const RTC_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Grace period for a connected peer that reports `Disconnected` (transient
/// network blips) before the daemon closes it.
const RTC_DISCONNECTED_GRACE: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, Eq, PartialEq)]
enum RtcScope {
    Agent(Uuid),
    Host(Uuid),
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RtcBinding {
    scope: RtcScope,
    protocol: String,
    protocol_version: u16,
    binding_nonce: Option<String>,
}

impl RtcBinding {
    fn from_signal(
        agent_id: Option<Uuid>,
        scope_type: Option<&str>,
        scope_id: Option<Uuid>,
        protocol: Option<&str>,
        protocol_version: Option<u16>,
        binding_nonce: Option<String>,
    ) -> Option<Self> {
        if binding_nonce.as_deref().is_some_and(|nonce| {
            nonce.len() != 32
                || !nonce
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        }) {
            return None;
        }
        match (agent_id, scope_type, scope_id, protocol, protocol_version) {
            // Legacy agent signaling remains accepted during the v1 rollout.
            (Some(agent_id), None, None, None, None) => Some(Self {
                scope: RtcScope::Agent(agent_id),
                protocol: AGENT_DATA_CHANNEL_LABEL.to_string(),
                protocol_version: RTC_PROTOCOL_VERSION,
                binding_nonce,
            }),
            (Some(agent_id), Some("agent"), Some(scope_id), Some(protocol), Some(version))
                if agent_id == scope_id
                    && protocol == AGENT_DATA_CHANNEL_LABEL
                    && version == RTC_PROTOCOL_VERSION =>
            {
                Some(Self {
                    scope: RtcScope::Agent(agent_id),
                    protocol: protocol.to_string(),
                    protocol_version: version,
                    binding_nonce,
                })
            }
            (None, Some("host"), Some(host_id), Some(protocol), Some(version))
                if protocol == HOST_CONTROL_LABEL && version == RTC_PROTOCOL_VERSION =>
            {
                Some(Self {
                    scope: RtcScope::Host(host_id),
                    protocol: protocol.to_string(),
                    protocol_version: version,
                    binding_nonce,
                })
            }
            _ => None,
        }
    }

    fn id(&self) -> Uuid {
        match self.scope {
            RtcScope::Agent(id) | RtcScope::Host(id) => id,
        }
    }

    fn data_channel_label(&self) -> &'static str {
        match self.scope {
            RtcScope::Agent(_) => AGENT_DATA_CHANNEL_LABEL,
            RtcScope::Host(_) => HOST_CONTROL_LABEL,
        }
    }
}

#[derive(Clone)]
struct RtcPeer {
    pc: Arc<RTCPeerConnection>,
    binding: RtcBinding,
}

fn rtc_capacity_available<'a>(
    bindings: impl Iterator<Item = &'a RtcBinding>,
    requested: &RtcBinding,
) -> bool {
    let mut total = 0;
    let mut hosts = 0;
    for binding in bindings {
        total += 1;
        if matches!(binding.scope, RtcScope::Host(_)) {
            hosts += 1;
        }
    }
    total < MAX_RTC_PEERS
        && (!matches!(requested.scope, RtcScope::Host(_)) || hosts < MAX_HOST_RTC_PEERS)
}

fn accept_first_host_channel(accepted: &AtomicBool) -> bool {
    !accepted.swap(true, Ordering::AcqRel)
}

pub struct RtcOfferSignal {
    pub session_id: String,
    pub binding_nonce: Option<String>,
    pub agent_id: Option<Uuid>,
    pub scope_type: Option<String>,
    pub scope_id: Option<Uuid>,
    pub protocol: Option<String>,
    pub protocol_version: Option<u16>,
    pub sdp: String,
    pub ice_servers: Vec<RtcIceServerConfig>,
    pub ice_transport_policy: Option<String>,
}

pub struct RtcCandidateSignal {
    pub session_id: String,
    pub binding_nonce: Option<String>,
    pub agent_id: Option<Uuid>,
    pub scope_type: Option<String>,
    pub scope_id: Option<Uuid>,
    pub protocol: Option<String>,
    pub protocol_version: Option<u16>,
    pub candidate: Value,
}

pub struct RtcCloseSignal {
    pub session_id: String,
    pub binding_nonce: Option<String>,
    pub agent_id: Option<Uuid>,
    pub scope_type: Option<String>,
    pub scope_id: Option<Uuid>,
    pub protocol: Option<String>,
    pub protocol_version: Option<u16>,
}

struct BoundRtcOffer {
    session_id: String,
    binding: RtcBinding,
    sdp: String,
    ice_servers: Vec<RtcIceServerConfig>,
    ice_transport_policy: Option<String>,
}

#[derive(Default, Clone)]
pub struct RtcSessions {
    peers: Arc<Mutex<HashMap<String, RtcPeer>>>,
    registered_host_id: Arc<Mutex<Option<Uuid>>>,
}

impl RtcSessions {
    pub fn new() -> Self {
        Self::default()
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
        offer: RtcOfferSignal,
        registry: AgentRegistry,
        out_tx: mpsc::Sender<WsOutbound>,
    ) {
        let Some(binding) = RtcBinding::from_signal(
            offer.agent_id,
            offer.scope_type.as_deref(),
            offer.scope_id,
            offer.protocol.as_deref(),
            offer.protocol_version,
            offer.binding_nonce,
        ) else {
            tracing::warn!(session_id = %offer.session_id, "rejecting unbound rtc offer metadata");
            return;
        };
        match binding.scope {
            RtcScope::Agent(agent_id) if !registry.contains(agent_id) => {
                send_status(
                    &out_tx,
                    offer.session_id,
                    &binding,
                    "failed",
                    Some("agent is not running on this daemon".to_string()),
                )
                .await;
                return;
            }
            RtcScope::Host(host_id) if *self.registered_host_id.lock().await != Some(host_id) => {
                tracing::warn!(%host_id, session_id = %offer.session_id, "rejecting rtc offer for another host");
                return;
            }
            _ => {}
        }
        let peers = self.peers.lock().await;
        let repeated = peers.contains_key(&offer.session_id);
        let at_capacity =
            !rtc_capacity_available(peers.values().map(|peer| &peer.binding), &binding);
        drop(peers);
        if repeated {
            tracing::warn!(session_id = %offer.session_id, "rejecting repeated rtc offer");
            send_status(&out_tx, offer.session_id, &binding, "failed", None).await;
            return;
        }
        if at_capacity {
            tracing::warn!(session_id = %offer.session_id, "rejecting rtc offer at peer capacity");
            send_status(&out_tx, offer.session_id, &binding, "failed", None).await;
            return;
        }

        let offer = BoundRtcOffer {
            session_id: offer.session_id,
            binding: binding.clone(),
            sdp: offer.sdp,
            ice_servers: offer.ice_servers,
            ice_transport_policy: offer.ice_transport_policy,
        };

        if let Err(e) = self.create_answer(&offer, registry, out_tx.clone()).await {
            tracing::warn!(scope_id = %binding.id(), session_id = %offer.session_id, error = %e, "rtc offer failed");
            // Status is intentionally content-free for host sessions. The
            // signaling server must not receive detailed endpoint errors.
            let message = matches!(binding.scope, RtcScope::Agent(_)).then(|| format!("{e:#}"));
            send_status(&out_tx, offer.session_id, &binding, "failed", message).await;
        }
    }

    async fn create_answer(
        &self,
        offer: &BoundRtcOffer,
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
        let ice_transport_policy =
            parse_ice_transport_policy(offer.ice_transport_policy.as_deref())?;
        let pc = Arc::new(
            api.new_peer_connection(RTCConfiguration {
                ice_servers: offer
                    .ice_servers
                    .iter()
                    .cloned()
                    .map(to_webrtc_ice_server)
                    .collect(),
                ice_transport_policy,
                ..Default::default()
            })
            .await
            .context("creating peer connection")?,
        );

        // Track the peer connection BEFORE negotiation so every exit path —
        // including negotiation errors below — can reach it and close it.
        self.peers.lock().await.insert(
            offer.session_id.clone(),
            RtcPeer {
                pc: Arc::clone(&pc),
                binding: offer.binding.clone(),
            },
        );

        install_ice_handler(
            &pc,
            offer.session_id.clone(),
            offer.binding.clone(),
            out_tx.clone(),
        );
        install_data_channel_handler(
            &pc,
            offer.session_id.clone(),
            offer.binding.clone(),
            registry,
            out_tx.clone(),
            Arc::new(AtomicBool::new(false)),
            None,
        );
        self.install_reaper(&pc, offer.session_id.clone(), offer.binding.id());

        let local_sdp = match negotiate(&pc, offer.sdp.clone()).await {
            Ok(local_sdp) => local_sdp,
            Err(e) => {
                self.close_if_same(&offer.session_id, &pc).await;
                return Err(e);
            }
        };

        send_json(
            &out_tx,
            rtc_answer_frame(offer.session_id.clone(), &offer.binding, local_sdp),
        )
        .await;
        Ok(())
    }

    /// Self-defense against missed `rtc.close` signals: close the peer if it
    /// fails, stays disconnected past a grace period, or never connects at
    /// all. The handlers hold only weak references so they don't keep the
    /// peer connection (and its sockets) alive on their own.
    fn install_reaper(&self, pc: &Arc<RTCPeerConnection>, session_id: String, agent_id: Uuid) {
        let weak = Arc::downgrade(pc);

        {
            let sessions = self.clone();
            let session_id = session_id.clone();
            let weak = weak.clone();
            tokio::spawn(async move {
                tokio::time::sleep(RTC_CONNECT_TIMEOUT).await;
                let Some(pc) = weak.upgrade() else { return };
                if pc.connection_state() != RTCPeerConnectionState::Connected {
                    tracing::debug!(%agent_id, %session_id, "rtc peer never connected; reaping");
                    sessions.close_if_same(&session_id, &pc).await;
                }
            });
        }

        let sessions = self.clone();
        pc.on_peer_connection_state_change(Box::new(move |state| {
            let sessions = sessions.clone();
            let session_id = session_id.clone();
            let weak = weak.clone();
            Box::pin(async move {
                match state {
                    RTCPeerConnectionState::Failed => {
                        let Some(pc) = weak.upgrade() else { return };
                        // Close from a separate task: closing the peer from
                        // inside its own event handler can deadlock.
                        tokio::spawn(async move {
                            tracing::debug!(%agent_id, %session_id, "rtc peer failed; reaping");
                            sessions.close_if_same(&session_id, &pc).await;
                        });
                    }
                    RTCPeerConnectionState::Disconnected => {
                        let Some(pc) = weak.upgrade() else { return };
                        tokio::spawn(async move {
                            tokio::time::sleep(RTC_DISCONNECTED_GRACE).await;
                            if pc.connection_state() == RTCPeerConnectionState::Disconnected {
                                tracing::debug!(
                                    %agent_id, %session_id,
                                    "rtc peer stayed disconnected; reaping"
                                );
                                sessions.close_if_same(&session_id, &pc).await;
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
    async fn close_if_same(&self, session_id: &str, pc: &Arc<RTCPeerConnection>) {
        {
            let mut peers = self.peers.lock().await;
            if peers
                .get(session_id)
                .is_some_and(|current| Arc::ptr_eq(&current.pc, pc))
            {
                peers.remove(session_id);
            }
        }
        let _ = pc.close().await;
    }

    pub async fn handle_candidate(&self, signal: RtcCandidateSignal) {
        let Some(signal_binding) = RtcBinding::from_signal(
            signal.agent_id,
            signal.scope_type.as_deref(),
            signal.scope_id,
            signal.protocol.as_deref(),
            signal.protocol_version,
            signal.binding_nonce,
        ) else {
            tracing::debug!(session_id = %signal.session_id, "ignoring rtc candidate with invalid binding");
            return;
        };
        let Some(peer) = self.peers.lock().await.get(&signal.session_id).cloned() else {
            tracing::debug!(session_id = %signal.session_id, "ignoring rtc candidate for unknown session");
            return;
        };
        if peer.binding != signal_binding {
            tracing::warn!(session_id = %signal.session_id, "ignoring cross-scope rtc candidate");
            return;
        }
        match serde_json::from_value::<RTCIceCandidateInit>(signal.candidate) {
            Ok(candidate) => {
                if let Err(e) = peer.pc.add_ice_candidate(candidate).await {
                    tracing::debug!(session_id = %signal.session_id, error = %e, "adding rtc candidate failed");
                }
            }
            Err(e) => {
                tracing::debug!(session_id = %signal.session_id, error = %e, "decoding rtc candidate failed");
            }
        }
    }

    pub async fn close(&self, session_id: &str) {
        let peer = self.peers.lock().await.remove(session_id);
        if let Some(peer) = peer {
            let _ = peer.pc.close().await;
        }
    }

    pub async fn close_bound(&self, signal: RtcCloseSignal) {
        let Some(signal_binding) = RtcBinding::from_signal(
            signal.agent_id,
            signal.scope_type.as_deref(),
            signal.scope_id,
            signal.protocol.as_deref(),
            signal.protocol_version,
            signal.binding_nonce,
        ) else {
            return;
        };
        let should_close = self
            .peers
            .lock()
            .await
            .get(&signal.session_id)
            .is_some_and(|peer| peer.binding == signal_binding);
        if should_close {
            self.close(&signal.session_id).await;
        }
    }

    pub async fn close_all(&self) {
        let peers = std::mem::take(&mut *self.peers.lock().await);
        for (_, peer) in peers {
            let _ = peer.pc.close().await;
        }
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
    session_id: String,
    binding: RtcBinding,
    out_tx: mpsc::Sender<WsOutbound>,
) {
    pc.on_ice_candidate(Box::new(move |candidate| {
        let out_tx = out_tx.clone();
        let session_id = session_id.clone();
        let binding = binding.clone();
        Box::pin(async move {
            let Some(candidate) = candidate else {
                return;
            };
            let candidate = match candidate.to_json() {
                Ok(candidate) => candidate,
                Err(e) => {
                    tracing::debug!(scope_id = %binding.id(), error = %e, "encoding rtc candidate failed");
                    return;
                }
            };
            match serde_json::to_value(candidate) {
                Ok(candidate) => {
                    send_json(
                        &out_tx,
                        rtc_candidate_frame(session_id, &binding, candidate),
                    )
                    .await;
                }
                Err(e) => {
                    tracing::debug!(scope_id = %binding.id(), error = %e, "serializing rtc candidate failed");
                }
            }
        })
    }));
}

fn install_data_channel_handler(
    pc: &Arc<RTCPeerConnection>,
    session_id: String,
    binding: RtcBinding,
    registry: AgentRegistry,
    out_tx: mpsc::Sender<WsOutbound>,
    host_channel_accepted: Arc<AtomicBool>,
    host_files: Option<Arc<HostFileService>>,
) {
    pc.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
        let session_id = session_id.clone();
        let binding = binding.clone();
        let registry = registry.clone();
        let out_tx = out_tx.clone();
        let host_channel_accepted = Arc::clone(&host_channel_accepted);
        let host_files = host_files.clone();
        Box::pin(async move {
            if dc.label() != binding.data_channel_label() {
                tracing::warn!(scope_id = %binding.id(), label = %dc.label(), "rejecting data channel for wrong rtc scope");
                let _ = dc.close().await;
                return;
            }

            if matches!(binding.scope, RtcScope::Host(_)) {
                if !accept_first_host_channel(&host_channel_accepted) {
                    tracing::warn!(scope_id = %binding.id(), "rejecting extra host control data channel");
                    let _ = dc.close().await;
                    return;
                }
                install_host_control_channel(dc, session_id, binding, out_tx, host_files);
                return;
            }
            let binding_nonce = binding.binding_nonce.clone();
            let RtcScope::Agent(agent_id) = binding.scope else {
                return;
            };
            let agent_binding = RtcBinding {
                scope: RtcScope::Agent(agent_id),
                protocol: AGENT_DATA_CHANNEL_LABEL.to_string(),
                protocol_version: RTC_PROTOCOL_VERSION,
                binding_nonce,
            };

            let input_registry = registry.clone();
            let input_out_tx = out_tx.clone();
            dc.on_message(Box::new(move |msg: DataChannelMessage| {
                let registry = input_registry.clone();
                let out_tx = input_out_tx.clone();
                Box::pin(async move {
                    // Cached check: never pay a tmux subprocess per keystroke.
                    // Worker-backed agents have no tmux copy-mode at all.
                    if !msg.is_string
                        && !msg.data.is_empty()
                        && registry.is_worker(agent_id) != Some(true)
                    {
                        if let Some(session) = registry.session_for(agent_id) {
                            if let Some(control) = registry.control_for(agent_id) {
                                if control.copy_mode_cached(&session) {
                                    control.suppress_activity(
                                        crate::activity::REDRAW_SUPPRESS_WINDOW,
                                    );
                                    tmux::cancel_copy_mode(&session).await;
                                    control.clear_copy_mode();
                                }
                            }
                        }
                    }
                    let mut result = None;
                    let found = registry.with_handle(agent_id, |h| {
                        result = Some(forward_data_channel_input(
                            agent_id,
                            msg.is_string,
                            &msg.data,
                            &h.control,
                            &out_tx,
                            |bytes| h.write_stdin(bytes),
                        ));
                    });
                    if !found {
                        tracing::debug!(%agent_id, "ignoring rtc stdin for unknown agent");
                    } else if let Some(Err(e)) = result {
                        tracing::warn!(%agent_id, error = %e, "rtc PTY stdin write failed");
                    }
                })
            }));

            let open_registry = registry.clone();
            let open_session_id = session_id.clone();
            let open_out_tx = out_tx.clone();
            let open_dc = Arc::clone(&dc);
            let open_binding = agent_binding.clone();
            dc.on_open(Box::new(move || {
                let registry = open_registry.clone();
                let session_id = open_session_id.clone();
                let out_tx = open_out_tx.clone();
                let dc = Arc::clone(&open_dc);
                let binding = open_binding.clone();
                Box::pin(async move {
                    let Some(control) = registry.control_for(agent_id) else {
                        send_status(
                            &out_tx,
                            session_id,
                            &binding,
                            "failed",
                            Some("agent is not running on this daemon".to_string()),
                        )
                        .await;
                        return;
                    };

                    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
                    control.add_direct_sink(session_id.clone(), tx).await;
                    send_status(&out_tx, session_id.clone(), &binding, "connected", None).await;
                    tokio::spawn(async move {
                        while let Some(chunk) = rx.recv().await {
                            if let Err(e) = dc.send(&Bytes::from(chunk)).await {
                                tracing::debug!(%agent_id, error = %e, "rtc data channel send failed");
                                break;
                            }
                        }
                        control.remove_direct_sink(&session_id).await;
                    });
                })
            }));

            let close_registry = registry.clone();
            let close_session_id = session_id.clone();
            dc.on_close(Box::new(move || {
                let registry = close_registry.clone();
                let session_id = close_session_id.clone();
                Box::pin(async move {
                    if let Some(control) = registry.control_for(agent_id) {
                        control.remove_direct_sink(&session_id).await;
                    }
                })
            }));
        })
    }));
}

#[cfg(test)]
enum HostControlAction {
    Reply(String),
    Close,
}

#[derive(Default)]
struct HostControlState {
    writes: HashMap<String, PendingWrite>,
    reads: HashMap<String, Arc<ReadFlow>>,
    read_requests: HashMap<String, Arc<AtomicBool>>,
    seen_request_ids: HashSet<String>,
}

#[derive(Default)]
struct ReadFlow {
    acknowledged: std::sync::atomic::AtomicU64,
    sent: std::sync::atomic::AtomicU64,
    cancelled: AtomicBool,
    notify: Notify,
}

#[derive(Clone)]
struct HostControlContext {
    dc: Arc<RTCDataChannel>,
    files: Arc<HostFileService>,
    state: Arc<Mutex<HostControlState>>,
}

impl HostControlContext {
    async fn send_value(&self, value: Value) -> bool {
        let encoded = value.to_string();
        if encoded.len() > HOST_CONTROL_MAX_FRAME_BYTES {
            return false;
        }
        self.dc.send_text(encoded).await.is_ok()
    }

    async fn response(&self, request_id: &str, result: Value) -> bool {
        self.send_value(json!({
            "version": RTC_PROTOCOL_VERSION,
            "type": "response",
            "request_id": request_id,
            "ok": true,
            "result": result,
        }))
        .await
    }

    async fn error(&self, request_id: &str, code: &str, detail: &str) -> bool {
        self.send_value(json!({
            "version": RTC_PROTOCOL_VERSION,
            "type": "response",
            "request_id": request_id,
            "ok": false,
            "error": {"code": code, "detail": detail},
        }))
        .await
    }

    async fn stream_error(&self, stream_id: &str, code: &str, detail: &str) -> bool {
        self.send_value(json!({
            "version": RTC_PROTOCOL_VERSION,
            "type": "stream.error",
            "stream_id": stream_id,
            "error": {"code": code, "detail": detail},
        }))
        .await
    }

    async fn mark_request(&self, request_id: &str) -> bool {
        let mut state = self.state.lock().await;
        if state.seen_request_ids.contains(request_id) {
            return false;
        }
        if state.seen_request_ids.len() >= HOST_CONTROL_MAX_SEEN_REQUESTS {
            // Bound replay state for long-lived browser tabs. Closing forces a
            // fresh, independently bound RTC session instead of forgetting
            // old request identities and accepting a replay on this one.
            return false;
        }
        state.seen_request_ids.insert(request_id.to_string())
    }

    async fn handle(&self, value: Value) -> bool {
        let Some(object) = value.as_object() else {
            return false;
        };
        if object.get("version").and_then(Value::as_u64) != Some(u64::from(RTC_PROTOCOL_VERSION)) {
            return false;
        }
        match object.get("type").and_then(Value::as_str) {
            Some("request") => self.handle_request(object).await,
            Some("stream.chunk") => self.handle_stream_chunk(object).await,
            Some("stream.end") => self.handle_stream_end(object).await,
            Some("stream.ack") => self.handle_stream_ack(object).await,
            Some("stream.cancel") => self.handle_stream_cancel(object).await,
            Some("cancel") => self.handle_request_cancel(object).await,
            _ => false,
        }
    }

    async fn handle_request(&self, object: &serde_json::Map<String, Value>) -> bool {
        let Some(request_id) = valid_control_id(object.get("request_id")) else {
            return false;
        };
        if !self.mark_request(request_id).await {
            return false;
        }
        let Some(operation) = object.get("operation").and_then(Value::as_str) else {
            return false;
        };
        let payload = object.get("payload").and_then(Value::as_object);
        match operation {
            "ping" => self.response(request_id, json!({"pong": true})).await,
            "fs.home" => {
                self.response(request_id, json!({"home_dir": self.files.home_dir()}))
                    .await
            }
            "fs.list" => {
                let path = payload_string(payload, "path").unwrap_or("~");
                let cursor = payload_u64(payload, "cursor").unwrap_or(0);
                let Ok(cursor) = usize::try_from(cursor) else {
                    return self
                        .error(request_id, "invalid_cursor", "cursor is too large")
                        .await;
                };
                match self.files.list(path, cursor).await {
                    Ok(mut page) => loop {
                        let Ok(result) = serde_json::to_value(&page) else {
                            return false;
                        };
                        let envelope = json!({
                            "version": RTC_PROTOCOL_VERSION,
                            "type": "response",
                            "request_id": request_id,
                            "ok": true,
                            "result": result,
                        });
                        if envelope.to_string().len() <= HOST_CONTROL_MAX_FRAME_BYTES {
                            break self.send_value(envelope).await;
                        }
                        if page.entries.len() <= 1 {
                            break self
                                .error(
                                    request_id,
                                    "entry_too_large",
                                    "directory entry exceeds the control frame limit",
                                )
                                .await;
                        }
                        page.entries.pop();
                        page.next_cursor = Some(cursor.saturating_add(page.entries.len()));
                    },
                    Err(error) => self.error(request_id, error.code, &error.detail).await,
                }
            }
            "fs.stat" => {
                let Some(path) = payload_string(payload, "path") else {
                    return self
                        .error(request_id, "invalid_request", "path is required")
                        .await;
                };
                match self.files.stat(path).await {
                    Ok(stat) => match serde_json::to_value(stat) {
                        Ok(result) => self.response(request_id, result).await,
                        Err(_) => false,
                    },
                    Err(error) => self.error(request_id, error.code, &error.detail).await,
                }
            }
            "fs.mkdir" => {
                let Some(path) = payload_string(payload, "path") else {
                    return self
                        .error(request_id, "invalid_request", "path is required")
                        .await;
                };
                match self.files.mkdir(path).await {
                    Ok(path) => self.response(request_id, json!({"path": path})).await,
                    Err(error) => self.error(request_id, error.code, &error.detail).await,
                }
            }
            "fs.rename" => {
                let (Some(path), Some(name)) = (
                    payload_string(payload, "path"),
                    payload_string(payload, "name"),
                ) else {
                    return self
                        .error(request_id, "invalid_request", "path and name are required")
                        .await;
                };
                let overwrite = payload_bool(payload, "overwrite").unwrap_or(false);
                match self.files.rename(path, name, overwrite).await {
                    Ok(path) => self.response(request_id, json!({"path": path})).await,
                    Err(error) => self.error(request_id, error.code, &error.detail).await,
                }
            }
            "fs.remove" => {
                let Some(path) = payload_string(payload, "path") else {
                    return self
                        .error(request_id, "invalid_request", "path is required")
                        .await;
                };
                let recursive = payload_bool(payload, "recursive").unwrap_or(false);
                match self.files.remove(path, recursive).await {
                    Ok(path) => self.response(request_id, json!({"path": path})).await,
                    Err(error) => self.error(request_id, error.code, &error.detail).await,
                }
            }
            "fs.read" => {
                let Some(path) = payload_string(payload, "path") else {
                    return self
                        .error(request_id, "invalid_request", "path is required")
                        .await;
                };
                let cancelled = Arc::new(AtomicBool::new(false));
                self.state
                    .lock()
                    .await
                    .read_requests
                    .insert(request_id.to_string(), Arc::clone(&cancelled));
                let sent = self.send_read(request_id, path, &cancelled).await;
                self.state.lock().await.read_requests.remove(request_id);
                sent
            }
            "fs.write.begin" => {
                let (Some(dir), Some(name), Some(length), Some(sha256)) = (
                    payload_string(payload, "dir"),
                    payload_string(payload, "name"),
                    payload_u64(payload, "length"),
                    payload_string(payload, "sha256"),
                ) else {
                    return self
                        .error(
                            request_id,
                            "invalid_request",
                            "write declaration is incomplete",
                        )
                        .await;
                };
                let overwrite = payload_bool(payload, "overwrite").unwrap_or(false);
                if self.state.lock().await.writes.len() >= HOST_MAX_WRITE_STREAMS {
                    return self
                        .error(
                            request_id,
                            "too_many_streams",
                            "too many pending write streams",
                        )
                        .await;
                }
                match self
                    .files
                    .begin_write(request_id.to_string(), dir, name, length, sha256, overwrite)
                    .await
                {
                    Ok(write) => {
                        let stream_id = write.stream_id.clone();
                        let mut state = self.state.lock().await;
                        if state.writes.len() >= HOST_MAX_WRITE_STREAMS {
                            drop(state);
                            write.abort().await;
                            return self
                                .error(
                                    request_id,
                                    "too_many_streams",
                                    "too many pending write streams",
                                )
                                .await;
                        }
                        state.writes.insert(stream_id.clone(), write);
                        drop(state);
                        let cleanup = self.clone();
                        let cleanup_stream_id = stream_id.clone();
                        tokio::spawn(async move {
                            loop {
                                tokio::time::sleep(HOST_WRITE_IDLE_TIMEOUT).await;
                                let (exists, stale_write) = {
                                    let mut state = cleanup.state.lock().await;
                                    let exists = state.writes.contains_key(&cleanup_stream_id);
                                    let stale =
                                        state.writes.get(&cleanup_stream_id).is_some_and(|write| {
                                            write.idle_for() >= HOST_WRITE_IDLE_TIMEOUT
                                        });
                                    let write = stale
                                        .then(|| state.writes.remove(&cleanup_stream_id))
                                        .flatten();
                                    (exists, write)
                                };
                                if let Some(write) = stale_write {
                                    write.abort().await;
                                    break;
                                }
                                if !exists {
                                    break;
                                }
                            }
                        });
                        self.response(request_id, json!({"stream_id": stream_id}))
                            .await
                    }
                    Err(error) => self.error(request_id, error.code, &error.detail).await,
                }
            }
            _ => {
                self.error(
                    request_id,
                    "unsupported_operation",
                    "operation is not supported",
                )
                .await
            }
        }
    }

    async fn send_read(&self, request_id: &str, path: &str, cancelled: &AtomicBool) -> bool {
        let mut stream = match self.files.open_read_cancellable(path, cancelled).await {
            Ok(stream) => stream,
            Err(error) => return self.error(request_id, error.code, &error.detail).await,
        };
        let stream_id = Uuid::new_v4().to_string();
        let flow = Arc::new(ReadFlow::default());
        self.state
            .lock()
            .await
            .reads
            .insert(stream_id.clone(), Arc::clone(&flow));
        let stat = &stream.stat;
        if !self
            .response(
                request_id,
                json!({
                    "stream_id": stream_id,
                    "path": stat.path,
                    "name": stat.name,
                    "length": stat.size,
                    "sha256": stream.sha256,
                }),
            )
            .await
        {
            self.state.lock().await.reads.remove(&stream_id);
            return false;
        }
        let mut sequence = 0_u64;
        let mut length = 0_u64;
        let mut actual = Sha256::new();
        let mut buffer = vec![0_u8; STREAM_CHUNK_BYTES];
        loop {
            if flow.cancelled.load(Ordering::Acquire) {
                self.state.lock().await.reads.remove(&stream_id);
                return true;
            }
            let read = match stream.file.read(&mut buffer).await {
                Ok(read) => read,
                Err(error) => {
                    self.state.lock().await.reads.remove(&stream_id);
                    return self
                        .stream_error(&stream_id, "io_error", &error.to_string())
                        .await;
                }
            };
            if read == 0 {
                break;
            }
            length = length.saturating_add(read as u64);
            actual.update(&buffer[..read]);
            if !self
                .send_value(json!({
                    "version": RTC_PROTOCOL_VERSION,
                    "type": "stream.chunk",
                    "stream_id": stream_id,
                    "sequence": sequence,
                    "bytes_b64": STANDARD.encode(&buffer[..read]),
                }))
                .await
            {
                return false;
            }
            sequence = sequence.saturating_add(1);
            flow.sent.store(sequence, Ordering::Release);
            if sequence.saturating_sub(flow.acknowledged.load(Ordering::Acquire))
                >= HOST_STREAM_WINDOW_CHUNKS
            {
                let wait = async {
                    loop {
                        if flow.cancelled.load(Ordering::Acquire)
                            || sequence.saturating_sub(flow.acknowledged.load(Ordering::Acquire))
                                < HOST_STREAM_WINDOW_CHUNKS
                        {
                            break;
                        }
                        flow.notify.notified().await;
                    }
                };
                if tokio::time::timeout(HOST_STREAM_ACK_TIMEOUT, wait)
                    .await
                    .is_err()
                    || flow.cancelled.load(Ordering::Acquire)
                {
                    self.state.lock().await.reads.remove(&stream_id);
                    return self
                        .stream_error(
                            &stream_id,
                            "stream_timeout",
                            "stream acknowledgement timed out",
                        )
                        .await;
                }
            }
        }
        let digest = format!("{:x}", actual.finalize());
        if length != stream.stat.size || digest != stream.sha256 {
            self.state.lock().await.reads.remove(&stream_id);
            return self
                .stream_error(&stream_id, "file_changed", "file changed during transfer")
                .await;
        }
        let sent = self
            .send_value(json!({
                "version": RTC_PROTOCOL_VERSION,
                "type": "stream.end",
                "stream_id": stream_id,
                "length": length,
                "sha256": digest,
            }))
            .await;
        self.state.lock().await.reads.remove(&stream_id);
        sent
    }

    async fn handle_stream_chunk(&self, object: &serde_json::Map<String, Value>) -> bool {
        let (Some(stream_id), Some(sequence), Some(encoded)) = (
            valid_control_id(object.get("stream_id")),
            object.get("sequence").and_then(Value::as_u64),
            object.get("bytes_b64").and_then(Value::as_str),
        ) else {
            return false;
        };
        let bytes = match STANDARD.decode(encoded) {
            Ok(bytes) if bytes.len() <= STREAM_CHUNK_BYTES => bytes,
            _ => return false,
        };
        let mut state = self.state.lock().await;
        let Some(write) = state.writes.get_mut(stream_id) else {
            return false;
        };
        if let Err(error) = write.append(sequence, &bytes).await {
            let write = state.writes.remove(stream_id).expect("write exists");
            drop(state);
            write.abort().await;
            return self
                .stream_error(stream_id, error.code, &error.detail)
                .await;
        }
        true
    }

    async fn handle_stream_end(&self, object: &serde_json::Map<String, Value>) -> bool {
        let Some(stream_id) = valid_control_id(object.get("stream_id")) else {
            return false;
        };
        let write = self.state.lock().await.writes.remove(stream_id);
        let Some(write) = write else {
            return false;
        };
        if object.get("length").and_then(Value::as_u64) != Some(write.expected_length)
            || object.get("sha256").and_then(Value::as_str) != Some(write.expected_sha256.as_str())
        {
            write.abort().await;
            return self
                .stream_error(
                    stream_id,
                    "declaration_mismatch",
                    "stream end does not match its write declaration",
                )
                .await;
        }
        let request_id = write.request_id.clone();
        match write.finish().await {
            Ok(path) => {
                self.send_value(json!({
                    "version": RTC_PROTOCOL_VERSION,
                    "type": "stream.committed",
                    "stream_id": stream_id,
                    "request_id": request_id,
                    "path": path,
                }))
                .await
            }
            Err(error) => {
                self.stream_error(stream_id, error.code, &error.detail)
                    .await
            }
        }
    }

    async fn handle_stream_ack(&self, object: &serde_json::Map<String, Value>) -> bool {
        let (Some(stream_id), Some(sequence)) = (
            valid_control_id(object.get("stream_id")),
            object.get("sequence").and_then(Value::as_u64),
        ) else {
            return false;
        };
        let flow = self.state.lock().await.reads.get(stream_id).cloned();
        let Some(flow) = flow else {
            return false;
        };
        let current = flow.acknowledged.load(Ordering::Acquire);
        if sequence < current || sequence > flow.sent.load(Ordering::Acquire) {
            return false;
        }
        flow.acknowledged.store(sequence, Ordering::Release);
        flow.notify.notify_waiters();
        true
    }

    async fn handle_stream_cancel(&self, object: &serde_json::Map<String, Value>) -> bool {
        let Some(stream_id) = valid_control_id(object.get("stream_id")) else {
            return false;
        };
        if let Some(write) = self.state.lock().await.writes.remove(stream_id) {
            write.abort().await;
        }
        if let Some(read) = self.state.lock().await.reads.remove(stream_id) {
            read.cancelled.store(true, Ordering::Release);
            read.notify.notify_waiters();
        }
        true
    }

    async fn handle_request_cancel(&self, object: &serde_json::Map<String, Value>) -> bool {
        let Some(request_id) = valid_control_id(object.get("request_id")) else {
            return false;
        };
        if let Some(read) = self
            .state
            .lock()
            .await
            .read_requests
            .get(request_id)
            .cloned()
        {
            read.store(true, Ordering::Release);
        }
        let stream_id = {
            let state = self.state.lock().await;
            state.writes.iter().find_map(|(stream_id, write)| {
                (write.request_id == request_id).then(|| stream_id.clone())
            })
        };
        if let Some(stream_id) = stream_id {
            if let Some(write) = self.state.lock().await.writes.remove(&stream_id) {
                write.abort().await;
            }
        }
        true
    }

    async fn abort_all(&self) {
        let writes = {
            let mut state = self.state.lock().await;
            for read in state.reads.drain().map(|(_, read)| read) {
                read.cancelled.store(true, Ordering::Release);
                read.notify.notify_waiters();
            }
            for request in state.read_requests.drain().map(|(_, request)| request) {
                request.store(true, Ordering::Release);
            }
            state
                .writes
                .drain()
                .map(|(_, write)| write)
                .collect::<Vec<_>>()
        };
        for write in writes {
            write.abort().await;
        }
    }
}

fn valid_control_id(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|id| {
        !id.is_empty()
            && id.len() <= HOST_CONTROL_MAX_REQUEST_ID_BYTES
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    })
}

fn payload_string<'a>(
    payload: Option<&'a serde_json::Map<String, Value>>,
    key: &str,
) -> Option<&'a str> {
    payload?
        .get(key)?
        .as_str()
        .filter(|value| value.len() <= 4096)
}

fn payload_u64(payload: Option<&serde_json::Map<String, Value>>, key: &str) -> Option<u64> {
    payload?.get(key)?.as_u64()
}

fn payload_bool(payload: Option<&serde_json::Map<String, Value>>, key: &str) -> Option<bool> {
    payload?.get(key)?.as_bool()
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
    binding: RtcBinding,
    out_tx: mpsc::Sender<WsOutbound>,
    files_override: Option<Arc<HostFileService>>,
) {
    let message_dc = Arc::clone(&dc);
    let in_flight = Arc::new(Semaphore::new(HOST_CONTROL_MAX_IN_FLIGHT));
    let context_slot = Arc::new(Mutex::new(None::<HostControlContext>));
    let message_context = Arc::clone(&context_slot);
    dc.on_message(Box::new(move |message: DataChannelMessage| {
        let dc = Arc::clone(&message_dc);
        let in_flight = Arc::clone(&in_flight);
        let context_slot = Arc::clone(&message_context);
        Box::pin(async move {
            let Ok(_permit) = in_flight.try_acquire_owned() else {
                let _ = dc.close().await;
                return;
            };
            if !message.is_string
                || message.data.is_empty()
                || message.data.len() > HOST_CONTROL_MAX_FRAME_BYTES
            {
                let _ = dc.close().await;
                return;
            }
            let Ok(value) = serde_json::from_slice::<Value>(&message.data) else {
                let _ = dc.close().await;
                return;
            };
            let Some(context) = context_slot.lock().await.clone() else {
                let _ = dc.close().await;
                return;
            };
            if !context.handle(value).await {
                let _ = dc.close().await;
            }
        })
    }));

    let open_dc = Arc::clone(&dc);
    let open_context = Arc::clone(&context_slot);
    let open_files = files_override;
    dc.on_open(Box::new(move || {
        let dc = Arc::clone(&open_dc);
        let context_slot = Arc::clone(&open_context);
        let out_tx = out_tx.clone();
        let session_id = session_id.clone();
        let binding = binding.clone();
        let files = open_files.clone();
        Box::pin(async move {
            let files = match files {
                Some(files) => files,
                None => match HostFileService::discover().await {
                    Ok(files) => Arc::new(files),
                    Err(_) => {
                        let _ = dc.close().await;
                        return;
                    }
                },
            };
            *context_slot.lock().await = Some(HostControlContext {
                dc: Arc::clone(&dc),
                files,
                state: Arc::new(Mutex::new(HostControlState::default())),
            });
            let hello = json!({
                "version": RTC_PROTOCOL_VERSION,
                "type": "hello",
                "protocol": HOST_CONTROL_LABEL,
                "capabilities": [
                    "ping", "fs.home", "fs.list", "fs.stat", "fs.read",
                    "fs.write.begin", "fs.mkdir", "fs.rename", "fs.remove"
                ],
                "limits": {
                    "frame_bytes": HOST_CONTROL_MAX_FRAME_BYTES,
                    "chunk_bytes": STREAM_CHUNK_BYTES,
                    "file_bytes": crate::host_files::MAX_FILE_BYTES
                }
            });
            if dc.send_text(hello.to_string()).await.is_ok() {
                send_status(&out_tx, session_id, &binding, "connected", None).await;
            } else {
                let _ = dc.close().await;
            }
        })
    }));

    let close_context = Arc::clone(&context_slot);
    dc.on_close(Box::new(move || {
        let context_slot = Arc::clone(&close_context);
        Box::pin(async move {
            if let Some(context) = context_slot.lock().await.take() {
                context.abort_all().await;
            }
        })
    }));
}

/// Testable core of the `spawn.pty` input callback. Activity is recorded only
/// after a successful, non-empty binary write, and the helper API exposes no
/// input bytes to the content-free activity serializer.
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
        Some(value) => anyhow::bail!("unsupported ICE transport policy {value}"),
    }
}

async fn send_status(
    out_tx: &mpsc::Sender<WsOutbound>,
    session_id: String,
    binding: &RtcBinding,
    status: &str,
    message: Option<String>,
) {
    send_json(
        out_tx,
        rtc_status_frame(session_id, binding, status, message),
    )
    .await;
}

fn rtc_answer_frame(session_id: String, binding: &RtcBinding, sdp: String) -> Outbound {
    let (agent_id, scope_type, scope_id, protocol, protocol_version) = rtc_frame_binding(binding);
    Outbound::RtcAnswer {
        session_id,
        binding_nonce: binding.binding_nonce.clone(),
        agent_id,
        scope_type,
        scope_id,
        protocol,
        protocol_version,
        sdp,
    }
}

fn rtc_candidate_frame(session_id: String, binding: &RtcBinding, candidate: Value) -> Outbound {
    let (agent_id, scope_type, scope_id, protocol, protocol_version) = rtc_frame_binding(binding);
    Outbound::RtcCandidate {
        session_id,
        binding_nonce: binding.binding_nonce.clone(),
        agent_id,
        scope_type,
        scope_id,
        protocol,
        protocol_version,
        candidate,
    }
}

fn rtc_status_frame(
    session_id: String,
    binding: &RtcBinding,
    status: &str,
    message: Option<String>,
) -> Outbound {
    let (agent_id, scope_type, scope_id, protocol, protocol_version) = rtc_frame_binding(binding);
    Outbound::RtcStatus {
        session_id,
        binding_nonce: binding.binding_nonce.clone(),
        agent_id,
        scope_type,
        scope_id,
        protocol,
        protocol_version,
        status: status.to_string(),
        message,
    }
}

type RtcFrameBinding = (
    Option<Uuid>,
    Option<String>,
    Option<Uuid>,
    Option<String>,
    Option<u16>,
);

fn rtc_frame_binding(binding: &RtcBinding) -> RtcFrameBinding {
    match binding.scope {
        // Keep legacy agent signaling byte-for-byte compatible. Generalized
        // agent metadata can be enabled once all browser versions understand it.
        RtcScope::Agent(agent_id) => (Some(agent_id), None, None, None, None),
        RtcScope::Host(host_id) => (
            None,
            Some("host".to_string()),
            Some(host_id),
            Some(binding.protocol.clone()),
            Some(binding.protocol_version),
        ),
    }
}

async fn send_json(out_tx: &mpsc::Sender<WsOutbound>, frame: Outbound) {
    if let Ok(s) = serde_json::to_string(&frame) {
        let _ = out_tx.send(WsOutbound::Json(s)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn receive_control(messages: &mut mpsc::Receiver<(usize, String)>) -> (usize, Value) {
        let (index, encoded) = tokio::time::timeout(Duration::from_secs(10), messages.recv())
            .await
            .expect("host control response timed out")
            .expect("host control channel closed before response");
        (index, serde_json::from_str(&encoded).unwrap())
    }

    async fn request_control(
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
                    "payload": payload
                })
                .to_string(),
            )
            .await
            .unwrap();
        receive_control(messages).await.1
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
        let WsOutbound::Json(json) = out_rx.try_recv().unwrap() else {
            panic!("expected content-free input activity JSON")
        };
        assert_eq!(
            json,
            format!(r#"{{"type":"agent.input_activity","agent_id":"{agent_id}"}}"#)
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
    fn rtc_binding_accepts_legacy_agent_and_strict_host_metadata() {
        let agent_id = Uuid::new_v4();
        let host_id = Uuid::new_v4();
        assert_eq!(
            RtcBinding::from_signal(Some(agent_id), None, None, None, None, None),
            Some(RtcBinding {
                scope: RtcScope::Agent(agent_id),
                protocol: AGENT_DATA_CHANNEL_LABEL.to_string(),
                protocol_version: RTC_PROTOCOL_VERSION,
                binding_nonce: None,
            })
        );
        let host = RtcBinding::from_signal(
            None,
            Some("host"),
            Some(host_id),
            Some(HOST_CONTROL_LABEL),
            Some(RTC_PROTOCOL_VERSION),
            None,
        )
        .unwrap();
        assert_eq!(host.scope, RtcScope::Host(host_id));
        assert_eq!(host.data_channel_label(), HOST_CONTROL_LABEL);

        assert!(RtcBinding::from_signal(
            Some(agent_id),
            Some("host"),
            Some(host_id),
            Some(HOST_CONTROL_LABEL),
            Some(RTC_PROTOCOL_VERSION),
            None,
        )
        .is_none());
        assert!(RtcBinding::from_signal(
            None,
            Some("host"),
            Some(host_id),
            Some(AGENT_DATA_CHANNEL_LABEL),
            Some(RTC_PROTOCOL_VERSION),
            None,
        )
        .is_none());
        assert!(RtcBinding::from_signal(
            None,
            Some("host"),
            Some(host_id),
            Some(HOST_CONTROL_LABEL),
            Some(2),
            None,
        )
        .is_none());
        assert!(RtcBinding::from_signal(
            None,
            Some("host"),
            Some(host_id),
            Some(HOST_CONTROL_LABEL),
            Some(RTC_PROTOCOL_VERSION),
            Some("not-a-valid-binding-nonce".to_string()),
        )
        .is_none());
    }

    #[test]
    fn host_control_ping_is_versioned_bounded_and_request_bound() {
        let request =
            br#"{"version":1,"type":"request","request_id":"request-1","operation":"ping"}"#;
        let HostControlAction::Reply(response) = host_control_response(request, true) else {
            panic!("expected ping response")
        };
        let value: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(value["version"], RTC_PROTOCOL_VERSION);
        assert_eq!(value["request_id"], "request-1");
        assert_eq!(value["ok"], true);
        assert_eq!(value["result"]["pong"], true);

        let cancel = br#"{"version":1,"type":"cancel","request_id":"request-2"}"#;
        let HostControlAction::Reply(response) = host_control_response(cancel, true) else {
            panic!("expected cancellation response")
        };
        let value: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(value["request_id"], "request-2");
        assert_eq!(value["error"]["code"], "cancelled");
    }

    #[test]
    fn host_control_rejects_binary_malformed_wrong_version_and_oversize_frames() {
        let valid = br#"{"version":1,"type":"request","request_id":"r","operation":"ping"}"#;
        assert!(matches!(
            host_control_response(valid, false),
            HostControlAction::Close
        ));
        assert!(matches!(
            host_control_response(b"not json", true),
            HostControlAction::Close
        ));
        for primitive in [b"null".as_slice(), b"7".as_slice(), br#""primitive""#] {
            assert!(matches!(
                host_control_response(primitive, true),
                HostControlAction::Close
            ));
        }
        assert!(matches!(
            host_control_response(
                br#"{"version":2,"type":"request","request_id":"r","operation":"ping"}"#,
                true
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
    fn host_signaling_frames_include_full_binding_but_agent_frames_stay_legacy() {
        let host_id = Uuid::new_v4();
        let host = RtcBinding {
            scope: RtcScope::Host(host_id),
            protocol: HOST_CONTROL_LABEL.to_string(),
            protocol_version: RTC_PROTOCOL_VERSION,
            binding_nonce: Some("a".repeat(32)),
        };
        let host_json = serde_json::to_value(rtc_status_frame(
            "host-session".into(),
            &host,
            "connected",
            None,
        ))
        .unwrap();
        assert_eq!(host_json["scope_type"], "host");
        assert_eq!(host_json["scope_id"], host_id.to_string());
        assert_eq!(host_json["protocol"], HOST_CONTROL_LABEL);
        assert_eq!(host_json["protocol_version"], RTC_PROTOCOL_VERSION);
        assert_eq!(host_json["binding_nonce"], "a".repeat(32));
        assert!(host_json.get("agent_id").is_none());

        let agent_id = Uuid::new_v4();
        let agent = RtcBinding {
            scope: RtcScope::Agent(agent_id),
            protocol: AGENT_DATA_CHANNEL_LABEL.to_string(),
            protocol_version: RTC_PROTOCOL_VERSION,
            binding_nonce: Some("b".repeat(32)),
        };
        let agent_json = serde_json::to_value(rtc_status_frame(
            "agent-session".into(),
            &agent,
            "connected",
            None,
        ))
        .unwrap();
        assert_eq!(agent_json["agent_id"], agent_id.to_string());
        assert_eq!(agent_json["binding_nonce"], "b".repeat(32));
        assert!(agent_json.get("scope_type").is_none());
    }

    #[test]
    fn turn_only_policy_is_enforced_and_unknown_policy_is_rejected() {
        assert_eq!(
            parse_ice_transport_policy(Some("relay")).unwrap(),
            RTCIceTransportPolicy::Relay
        );
        assert_eq!(
            parse_ice_transport_policy(None).unwrap(),
            RTCIceTransportPolicy::All
        );
        assert!(parse_ice_transport_policy(Some("unknown")).is_err());
    }

    #[test]
    fn rtc_peer_caps_and_single_host_channel_guard_are_deterministic() {
        let host = RtcBinding {
            scope: RtcScope::Host(Uuid::new_v4()),
            protocol: HOST_CONTROL_LABEL.to_string(),
            protocol_version: RTC_PROTOCOL_VERSION,
            binding_nonce: None,
        };
        let agent = RtcBinding {
            scope: RtcScope::Agent(Uuid::new_v4()),
            protocol: AGENT_DATA_CHANNEL_LABEL.to_string(),
            protocol_version: RTC_PROTOCOL_VERSION,
            binding_nonce: None,
        };
        let mut host_bindings = vec![host.clone(); MAX_HOST_RTC_PEERS - 1];
        assert!(rtc_capacity_available(host_bindings.iter(), &host));
        host_bindings.push(host.clone());
        assert!(!rtc_capacity_available(host_bindings.iter(), &host));
        assert!(rtc_capacity_available(host_bindings.iter(), &agent));

        let all_bindings = vec![agent.clone(); MAX_RTC_PEERS];
        assert!(!rtc_capacity_available(all_bindings.iter(), &agent));

        let accepted = AtomicBool::new(false);
        assert!(accept_first_host_channel(&accepted));
        assert!(!accept_first_host_channel(&accepted));
    }

    #[tokio::test]
    async fn daemon_host_identity_binds_without_any_agent_and_cannot_be_rebound() {
        let sessions = RtcSessions::new();
        let host_id = Uuid::new_v4();
        assert!(sessions.bind_registered_host_id(host_id).await);
        assert!(sessions.bind_registered_host_id(host_id).await);
        assert!(!sessions.bind_registered_host_id(Uuid::new_v4()).await);
        assert!(sessions.peers.lock().await.is_empty());
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
        let binding = RtcBinding {
            scope: RtcScope::Host(host_id),
            protocol: HOST_CONTROL_LABEL.to_string(),
            protocol_version: RTC_PROTOCOL_VERSION,
            binding_nonce: None,
        };
        let (out_tx, _out_rx) = mpsc::channel(4);
        let file_root = tempfile::tempdir().unwrap();
        tokio::fs::write(file_root.path().join("source.txt"), b"source body")
            .await
            .unwrap();
        let files = Arc::new(HostFileService::rooted_at(file_root.path()).await.unwrap());
        install_data_channel_handler(
            &daemon_pc,
            "host-e2e".to_string(),
            binding,
            AgentRegistry::new(),
            out_tx,
            Arc::new(AtomicBool::new(false)),
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

        accepted_channel
            .send_text(
                json!({
                    "version": RTC_PROTOCOL_VERSION,
                    "type": "request",
                    "request_id": "e2e-list",
                    "operation": "fs.list",
                    "payload": {"path": "~", "cursor": 0}
                })
                .to_string(),
            )
            .await
            .unwrap();
        let (index, listing) = receive_control(&mut messages_rx).await;
        assert_eq!(index, accepted_index);
        assert_eq!(listing["request_id"], "e2e-list");
        assert_eq!(listing["result"]["home_dir"], files.home_dir());
        assert_eq!(listing["result"]["entries"][0]["name"], "source.txt");

        let upload = b"uploaded through the paired data channel";
        let upload_hash = format!("{:x}", Sha256::digest(upload));
        accepted_channel
            .send_text(
                json!({
                    "version": RTC_PROTOCOL_VERSION,
                    "type": "request",
                    "request_id": "e2e-write",
                    "operation": "fs.write.begin",
                    "payload": {
                        "dir": "~",
                        "name": "uploaded.txt",
                        "length": upload.len(),
                        "sha256": upload_hash,
                        "overwrite": false
                    }
                })
                .to_string(),
            )
            .await
            .unwrap();
        let (_, write_started) = receive_control(&mut messages_rx).await;
        let write_stream_id = write_started["result"]["stream_id"].as_str().unwrap();
        accepted_channel
            .send_text(
                json!({
                    "version": RTC_PROTOCOL_VERSION,
                    "type": "stream.chunk",
                    "stream_id": write_stream_id,
                    "sequence": 0,
                    "bytes_b64": STANDARD.encode(upload)
                })
                .to_string(),
            )
            .await
            .unwrap();
        accepted_channel
            .send_text(
                json!({
                    "version": RTC_PROTOCOL_VERSION,
                    "type": "stream.end",
                    "stream_id": write_stream_id,
                    "length": upload.len(),
                    "sha256": upload_hash
                })
                .to_string(),
            )
            .await
            .unwrap();
        let (_, committed) = receive_control(&mut messages_rx).await;
        assert_eq!(committed["type"], "stream.committed");
        assert_eq!(
            tokio::fs::read(file_root.path().join("uploaded.txt"))
                .await
                .unwrap(),
            upload
        );

        accepted_channel
            .send_text(
                json!({
                    "version": RTC_PROTOCOL_VERSION,
                    "type": "request",
                    "request_id": "e2e-read",
                    "operation": "fs.read",
                    "payload": {"path": "uploaded.txt"}
                })
                .to_string(),
            )
            .await
            .unwrap();
        let (_, read_started) = receive_control(&mut messages_rx).await;
        assert_eq!(read_started["request_id"], "e2e-read");
        assert_eq!(read_started["result"]["length"], upload.len());
        assert_eq!(read_started["result"]["sha256"], upload_hash);
        let read_stream_id = read_started["result"]["stream_id"].as_str().unwrap();
        let (_, chunk) = receive_control(&mut messages_rx).await;
        assert_eq!(chunk["stream_id"], read_stream_id);
        assert_eq!(
            STANDARD
                .decode(chunk["bytes_b64"].as_str().unwrap())
                .unwrap(),
            upload
        );
        let (_, ended) = receive_control(&mut messages_rx).await;
        assert_eq!(ended["type"], "stream.end");
        assert_eq!(ended["length"], upload.len());
        assert_eq!(ended["sha256"], upload_hash);

        let made = request_control(
            accepted_channel,
            &mut messages_rx,
            "e2e-mkdir",
            "fs.mkdir",
            json!({"path": "folder"}),
        )
        .await;
        assert_eq!(made["ok"], true);
        let renamed = request_control(
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
        let stat = request_control(
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
            let removed = request_control(
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

        browser_pc.close().await.unwrap();
        daemon_pc.close().await.unwrap();
    }
}
