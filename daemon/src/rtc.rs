//! WebRTC direct terminal transport.
//!
//! The central websocket remains the authenticated control/signaling plane.
//! Once a browser and daemon establish a DataChannel, raw PTY input/output can
//! bypass the server relay path while the daemon still mirrors output to the
//! server websocket for transcripts and fallback viewers.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use bytes::Bytes;
use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex, Semaphore};
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
use crate::proto::{Outbound, RtcIceServerConfig};
use crate::pty::WsOutbound;
use crate::tmux;

const AGENT_DATA_CHANNEL_LABEL: &str = "spawn.pty";
const HOST_CONTROL_LABEL: &str = "spawn.host.ctl";
const RTC_PROTOCOL_VERSION: u16 = 1;
const HOST_CONTROL_MAX_FRAME_BYTES: usize = 16 * 1024;
const HOST_CONTROL_MAX_REQUEST_ID_BYTES: usize = 128;
const HOST_CONTROL_MAX_IN_FLIGHT: usize = 32;

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
}

impl RtcBinding {
    fn from_signal(
        agent_id: Option<Uuid>,
        scope_type: Option<&str>,
        scope_id: Option<Uuid>,
        protocol: Option<&str>,
        protocol_version: Option<u16>,
    ) -> Option<Self> {
        match (agent_id, scope_type, scope_id, protocol, protocol_version) {
            // Legacy agent signaling remains accepted during the v1 rollout.
            (Some(agent_id), None, None, None, None) => Some(Self {
                scope: RtcScope::Agent(agent_id),
                protocol: AGENT_DATA_CHANNEL_LABEL.to_string(),
                protocol_version: RTC_PROTOCOL_VERSION,
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
                })
            }
            (None, Some("host"), Some(host_id), Some(protocol), Some(version))
                if protocol == HOST_CONTROL_LABEL && version == RTC_PROTOCOL_VERSION =>
            {
                Some(Self {
                    scope: RtcScope::Host(host_id),
                    protocol: protocol.to_string(),
                    protocol_version: version,
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

pub struct RtcOfferSignal {
    pub session_id: String,
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
    pub agent_id: Option<Uuid>,
    pub scope_type: Option<String>,
    pub scope_id: Option<Uuid>,
    pub protocol: Option<String>,
    pub protocol_version: Option<u16>,
    pub candidate: Value,
}

pub struct RtcCloseSignal {
    pub session_id: String,
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
        if self
            .peers
            .lock()
            .await
            .get(&offer.session_id)
            .is_some_and(|peer| peer.binding != binding)
        {
            tracing::warn!(session_id = %offer.session_id, "rejecting rtc session id reuse across scopes");
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
        self.close(&offer.session_id).await;

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
) {
    pc.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
        let session_id = session_id.clone();
        let binding = binding.clone();
        let registry = registry.clone();
        let out_tx = out_tx.clone();
        Box::pin(async move {
            if dc.label() != binding.data_channel_label() {
                tracing::warn!(scope_id = %binding.id(), label = %dc.label(), "rejecting data channel for wrong rtc scope");
                let _ = dc.close().await;
                return;
            }

            if matches!(binding.scope, RtcScope::Host(_)) {
                install_host_control_channel(dc, session_id, binding, out_tx);
                return;
            }
            let RtcScope::Agent(agent_id) = binding.scope else {
                return;
            };
            let agent_binding = RtcBinding {
                scope: RtcScope::Agent(agent_id),
                protocol: AGENT_DATA_CHANNEL_LABEL.to_string(),
                protocol_version: RTC_PROTOCOL_VERSION,
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

enum HostControlAction {
    Reply(String),
    Close,
}

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
) {
    let message_dc = Arc::clone(&dc);
    let in_flight = Arc::new(Semaphore::new(HOST_CONTROL_MAX_IN_FLIGHT));
    dc.on_message(Box::new(move |message: DataChannelMessage| {
        let dc = Arc::clone(&message_dc);
        let in_flight = Arc::clone(&in_flight);
        Box::pin(async move {
            let Ok(_permit) = in_flight.try_acquire_owned() else {
                let _ = dc.close().await;
                return;
            };
            match host_control_response(&message.data, message.is_string) {
                HostControlAction::Reply(response) => {
                    if dc.send_text(response).await.is_err() {
                        let _ = dc.close().await;
                    }
                }
                HostControlAction::Close => {
                    let _ = dc.close().await;
                }
            }
        })
    }));

    let open_dc = Arc::clone(&dc);
    dc.on_open(Box::new(move || {
        let dc = Arc::clone(&open_dc);
        let out_tx = out_tx.clone();
        let session_id = session_id.clone();
        let binding = binding.clone();
        Box::pin(async move {
            let hello = json!({
                "version": RTC_PROTOCOL_VERSION,
                "type": "hello",
                "protocol": HOST_CONTROL_LABEL,
                "capabilities": ["ping"]
            });
            if dc.send_text(hello.to_string()).await.is_ok() {
                send_status(&out_tx, session_id, &binding, "connected", None).await;
            } else {
                let _ = dc.close().await;
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
            RtcBinding::from_signal(Some(agent_id), None, None, None, None),
            Some(RtcBinding {
                scope: RtcScope::Agent(agent_id),
                protocol: AGENT_DATA_CHANNEL_LABEL.to_string(),
                protocol_version: RTC_PROTOCOL_VERSION,
            })
        );
        let host = RtcBinding::from_signal(
            None,
            Some("host"),
            Some(host_id),
            Some(HOST_CONTROL_LABEL),
            Some(RTC_PROTOCOL_VERSION),
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
        )
        .is_none());
        assert!(RtcBinding::from_signal(
            None,
            Some("host"),
            Some(host_id),
            Some(AGENT_DATA_CHANNEL_LABEL),
            Some(RTC_PROTOCOL_VERSION),
        )
        .is_none());
        assert!(RtcBinding::from_signal(
            None,
            Some("host"),
            Some(host_id),
            Some(HOST_CONTROL_LABEL),
            Some(2),
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
        assert!(host_json.get("agent_id").is_none());

        let agent_id = Uuid::new_v4();
        let agent = RtcBinding {
            scope: RtcScope::Agent(agent_id),
            protocol: AGENT_DATA_CHANNEL_LABEL.to_string(),
            protocol_version: RTC_PROTOCOL_VERSION,
        };
        let agent_json = serde_json::to_value(rtc_status_frame(
            "agent-session".into(),
            &agent,
            "connected",
            None,
        ))
        .unwrap();
        assert_eq!(agent_json["agent_id"], agent_id.to_string());
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
    async fn zero_agent_host_control_data_channel_exchanges_hello_and_ping() {
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
        let (messages_tx, mut messages_rx) = mpsc::channel::<String>(4);
        channel.on_message(Box::new(move |message: DataChannelMessage| {
            let messages_tx = messages_tx.clone();
            Box::pin(async move {
                let _ = messages_tx
                    .send(String::from_utf8_lossy(&message.data).into_owned())
                    .await;
            })
        }));

        let host_id = Uuid::new_v4();
        let binding = RtcBinding {
            scope: RtcScope::Host(host_id),
            protocol: HOST_CONTROL_LABEL.to_string(),
            protocol_version: RTC_PROTOCOL_VERSION,
        };
        let (out_tx, _out_rx) = mpsc::channel(4);
        install_data_channel_handler(
            &daemon_pc,
            "host-e2e".to_string(),
            binding,
            AgentRegistry::new(),
            out_tx,
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

        let hello = tokio::time::timeout(Duration::from_secs(10), messages_rx.recv())
            .await
            .expect("host control channel did not open")
            .expect("host control channel closed before hello");
        let hello: Value = serde_json::from_str(&hello).unwrap();
        assert_eq!(hello["type"], "hello");
        assert_eq!(hello["protocol"], HOST_CONTROL_LABEL);

        channel
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
        let response = tokio::time::timeout(Duration::from_secs(10), messages_rx.recv())
            .await
            .expect("host control ping timed out")
            .expect("host control channel closed before ping response");
        let response: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(response["request_id"], "e2e-ping");
        assert_eq!(response["result"]["pong"], true);

        browser_pc.close().await.unwrap();
        daemon_pc.close().await.unwrap();
    }
}
