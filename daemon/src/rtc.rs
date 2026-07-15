//! WebRTC direct terminal transport.
//!
//! The central websocket remains the authenticated control/signaling plane.
//! Once a browser and daemon establish a DataChannel, raw PTY input/output can
//! bypass the server relay path while the daemon still mirrors output to the
//! server websocket for transcripts and fallback viewers.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use bytes::Bytes;
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};
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
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;

use crate::agent_ctl::{
    self, AgentControlHub, ControlOperation, ControlOutbound, ControlRequest, ControlSender,
    ProtocolError,
};
use crate::agents::AgentRegistry;
use crate::proto::{Outbound, RtcIceServerConfig};
use crate::pty::WsOutbound;
use crate::tmux;

const PTY_DATA_CHANNEL_LABEL: &str = "spawn.pty";
const CONTROL_DATA_CHANNEL_LABEL: &str = "spawn.ctl";

/// Peer connections that never reach `Connected` within this window are
/// reaped. Closing is the daemon's own defense: `rtc.close` delivery from the
/// browser/server is best-effort, and every unreaped peer connection holds
/// multiple UDP sockets (ICE host candidates + mDNS) until closed — webrtc-rs
/// does NOT release them on drop.
const RTC_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Grace period for a connected peer that reports `Disconnected` (transient
/// network blips) before the daemon closes it.
const RTC_DISCONNECTED_GRACE: Duration = Duration::from_secs(15);
const DATA_CHANNEL_SEND_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Default, Clone)]
pub struct RtcSessions {
    peers: Arc<Mutex<HashMap<String, RtcPeer>>>,
    controls: AgentControlHub,
}

#[derive(Clone)]
struct RtcPeer {
    pc: Arc<RTCPeerConnection>,
    agent_id: Uuid,
    generation: String,
    active: Arc<AtomicBool>,
    lifecycle: Arc<RwLock<()>>,
}

/// Immutable identity assigned by the signaling broker to one RTC attempt.
///
/// Keeping the three binding fields together makes it difficult to
/// accidentally validate a session ID while forwarding a stale generation or
/// a different agent ID.
#[derive(Clone)]
pub struct RtcSessionBinding {
    session_id: String,
    generation: String,
    agent_id: Uuid,
}

impl RtcSessionBinding {
    pub fn new(session_id: String, generation: String, agent_id: Uuid) -> Self {
        Self {
            session_id,
            generation,
            agent_id,
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

    pub async fn handle_offer(
        &self,
        binding: RtcSessionBinding,
        sdp: String,
        ice_servers: Vec<RtcIceServerConfig>,
        registry: AgentRegistry,
        out_tx: mpsc::Sender<WsOutbound>,
    ) {
        if !registry.contains(binding.agent_id) {
            send_status(
                &out_tx,
                binding.session_id,
                binding.generation,
                binding.agent_id,
                "failed",
                Some("agent is not running on this daemon"),
            )
            .await;
            return;
        }

        if let Err(e) = self
            .create_answer(binding.clone(), sdp, ice_servers, registry, out_tx.clone())
            .await
        {
            tracing::warn!(
                agent_id = %binding.agent_id,
                session_id = %binding.session_id,
                error = %e,
                "rtc offer failed"
            );
            send_status(
                &out_tx,
                binding.session_id,
                binding.generation,
                binding.agent_id,
                "failed",
                Some(&format!("{e:#}")),
            )
            .await;
        }
    }

    async fn create_answer(
        &self,
        binding: RtcSessionBinding,
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
        let lifecycle = Arc::new(RwLock::new(()));

        // Track the peer connection BEFORE negotiation so every exit path —
        // including negotiation errors below — can reach it and close it.
        let collision = {
            let mut peers = self.peers.lock().await;
            if peers.contains_key(&binding.session_id) {
                true
            } else {
                peers.insert(
                    binding.session_id.clone(),
                    RtcPeer {
                        pc: Arc::clone(&pc),
                        agent_id: binding.agent_id,
                        generation: binding.generation.clone(),
                        active: Arc::clone(&active),
                        lifecycle: Arc::clone(&lifecycle),
                    },
                );
                false
            }
        };
        if collision {
            let _ = pc.close().await;
            anyhow::bail!("rtc session id is already active");
        }

        install_ice_handler(&pc, binding.clone(), out_tx.clone());
        install_data_channel_handler(
            &pc,
            binding.clone(),
            registry,
            self.controls.clone(),
            Arc::clone(&active),
            Arc::clone(&lifecycle),
            out_tx.clone(),
        );
        self.install_reaper(&pc, binding.clone());

        let local_sdp = match negotiate(&pc, sdp).await {
            Ok(local_sdp) => local_sdp,
            Err(e) => {
                self.close_if_same(&binding.session_id, &binding.generation, &pc)
                    .await;
                return Err(e);
            }
        };

        send_json(
            &out_tx,
            Outbound::RtcAnswer {
                session_id: binding.session_id,
                generation: binding.generation,
                agent_id: binding.agent_id,
                sdp: local_sdp,
            },
        )
        .await;
        Ok(())
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
    async fn close_if_same(&self, session_id: &str, generation: &str, pc: &Arc<RTCPeerConnection>) {
        let removed = {
            let mut peers = self.peers.lock().await;
            if peers.get(session_id).is_some_and(|current| {
                current.generation == generation && Arc::ptr_eq(&current.pc, pc)
            }) {
                peers.remove(session_id)
            } else {
                None
            }
        };
        if let Some(peer) = removed {
            peer.active.store(false, Ordering::Release);
            let _lifecycle = peer.lifecycle.write().await;
            self.controls
                .unregister_session(&viewer_id(session_id, generation))
                .await;
        }
        let _ = pc.close().await;
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
        if peer.agent_id != agent_id || peer.generation != generation {
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
        let peer = {
            let mut peers = self.peers.lock().await;
            if peers
                .get(session_id)
                .is_some_and(|peer| peer.agent_id == agent_id && peer.generation == generation)
            {
                peers.remove(session_id)
            } else {
                None
            }
        };
        if let Some(peer) = peer {
            peer.active.store(false, Ordering::Release);
            let _lifecycle = peer.lifecycle.write().await;
            self.controls
                .unregister_session(&viewer_id(session_id, generation))
                .await;
            let _ = peer.pc.close().await;
        }
    }

    pub async fn close_all(&self) {
        let peers = std::mem::take(&mut *self.peers.lock().await);
        for (session_id, peer) in peers {
            peer.active.store(false, Ordering::Release);
            let _lifecycle = peer.lifecycle.write().await;
            self.controls
                .unregister_session(&viewer_id(&session_id, &peer.generation))
                .await;
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
                            generation: binding.generation,
                            agent_id: binding.agent_id,
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

fn install_data_channel_handler(
    pc: &Arc<RTCPeerConnection>,
    binding: RtcSessionBinding,
    registry: AgentRegistry,
    controls: AgentControlHub,
    active: Arc<AtomicBool>,
    lifecycle: Arc<RwLock<()>>,
    out_tx: mpsc::Sender<WsOutbound>,
) {
    pc.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
        let binding = binding.clone();
        let registry = registry.clone();
        let controls = controls.clone();
        let active = Arc::clone(&active);
        let lifecycle = Arc::clone(&lifecycle);
        let out_tx = out_tx.clone();
        Box::pin(async move {
            let _lifecycle = lifecycle.read().await;
            if !active.load(Ordering::Acquire) {
                let _ = dc.close().await;
                return;
            }
            let viewer_id = viewer_id(&binding.session_id, &binding.generation);
            if dc.label() == CONTROL_DATA_CHANNEL_LABEL {
                install_control_data_channel(
                    dc,
                    viewer_id,
                    binding.agent_id,
                    registry,
                    controls,
                    active,
                    lifecycle.clone(),
                );
                return;
            }
            if dc.label() != PTY_DATA_CHANNEL_LABEL {
                tracing::debug!(agent_id = %binding.agent_id, label = %dc.label(), "ignoring unknown rtc data channel");
                return;
            }

            let agent_id = binding.agent_id;

            let input_registry = registry.clone();
            let input_out_tx = out_tx.clone();
            let input_active = Arc::clone(&active);
            let input_lifecycle = Arc::clone(&lifecycle);
            dc.on_message(Box::new(move |msg: DataChannelMessage| {
                let registry = input_registry.clone();
                let out_tx = input_out_tx.clone();
                let active = Arc::clone(&input_active);
                let lifecycle = Arc::clone(&input_lifecycle);
                Box::pin(async move {
                    if !active.load(Ordering::Acquire) {
                        return;
                    }
                    let _lifecycle = lifecycle.read().await;
                    if !active.load(Ordering::Acquire) {
                        return;
                    }
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
            let open_session_id = binding.session_id.clone();
            let open_generation = binding.generation.clone();
            let open_viewer_id = viewer_id.clone();
            let open_out_tx = out_tx.clone();
            let open_dc = Arc::clone(&dc);
            let open_active = Arc::clone(&active);
            let open_lifecycle = Arc::clone(&lifecycle);
            dc.on_open(Box::new(move || {
                let registry = open_registry.clone();
                let session_id = open_session_id.clone();
                let generation = open_generation.clone();
                let viewer_id = open_viewer_id.clone();
                let out_tx = open_out_tx.clone();
                let dc = Arc::clone(&open_dc);
                let active = Arc::clone(&open_active);
                let lifecycle = Arc::clone(&open_lifecycle);
                Box::pin(async move {
                    if !active.load(Ordering::Acquire) {
                        let _ = dc.close().await;
                        return;
                    }
                    let _lifecycle = lifecycle.read().await;
                    if !active.load(Ordering::Acquire) {
                        let _ = dc.close().await;
                        return;
                    }
                    let Some(control) = registry.control_for(agent_id) else {
                        send_status(
                            &out_tx,
                            session_id,
                            generation,
                            agent_id,
                            "failed",
                            Some("agent is not running on this daemon"),
                        )
                        .await;
                        return;
                    };

                    if registry.is_worker(agent_id) == Some(true) {
                        let mut replay_rx = None;
                        registry.with_handle(agent_id, |handle| {
                            replay_rx = handle.worker_replay(64 * 1024);
                        });
                        let Some(replay_rx) = replay_rx else {
                            send_status(
                                &out_tx,
                                session_id,
                                generation,
                                agent_id,
                                "failed",
                                Some("worker replay is unavailable"),
                            )
                            .await;
                            return;
                        };
                        let Ok(Ok(Ok((watermark, _)))) =
                            tokio::time::timeout(Duration::from_secs(3), replay_rx).await
                        else {
                            send_status(
                                &out_tx,
                                session_id,
                                generation,
                                agent_id,
                                "failed",
                                Some("worker replay barrier failed"),
                            )
                            .await;
                            return;
                        };
                        if tokio::time::timeout(
                            Duration::from_secs(3),
                            control.wait_source_offset(watermark),
                        )
                        .await
                        .is_err()
                        {
                            send_status(
                                &out_tx,
                                session_id,
                                generation,
                                agent_id,
                                "failed",
                                Some("worker live-stream barrier timed out"),
                            )
                            .await;
                            return;
                        }
                    }

                    let mut direct = control.add_direct_sink(viewer_id.clone()).await;
                    send_status(
                        &out_tx,
                        session_id.clone(),
                        generation,
                        agent_id,
                        "connected",
                        None,
                    )
                    .await;
                    tokio::spawn(async move {
                        loop {
                            let chunk = tokio::select! {
                                changed = direct.disconnected.changed() => {
                                    let _ = changed;
                                    None
                                }
                                chunk = direct.receiver.recv() => chunk,
                            };
                            let Some(chunk) = chunk else { break };
                            match tokio::time::timeout(
                                DATA_CHANNEL_SEND_TIMEOUT,
                                dc.send(&Bytes::from(chunk)),
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
                        control.remove_direct_sink(&viewer_id).await;
                        let _ = dc.close().await;
                    });
                })
            }));

            let close_registry = registry.clone();
            let close_viewer_id = viewer_id;
            dc.on_close(Box::new(move || {
                let registry = close_registry.clone();
                let viewer_id = close_viewer_id.clone();
                Box::pin(async move {
                    if let Some(control) = registry.control_for(agent_id) {
                        control.remove_direct_sink(&viewer_id).await;
                    }
                })
            }));
        })
    }));
}

fn install_control_data_channel(
    dc: Arc<RTCDataChannel>,
    session_id: String,
    agent_id: Uuid,
    registry: AgentRegistry,
    controls: AgentControlHub,
    active: Arc<AtomicBool>,
    lifecycle: Arc<RwLock<()>>,
) {
    let (sender, mut receiver) = mpsc::channel(agent_ctl::OUTBOUND_QUEUE_DEPTH);
    let (display_sender, mut display_receiver) = tokio::sync::watch::channel(None::<String>);
    let (close_tx, mut close_rx) = oneshot::channel();
    let close_tx = Arc::new(Mutex::new(Some(close_tx)));
    let send_dc = Arc::clone(&dc);
    let send_controls = controls.clone();
    let send_session_id = session_id.clone();
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
            let Some(message) = message else {
                break;
            };
            let send = async {
                match message {
                    ControlOutbound::Text(text) => send_dc.send_text(text).await,
                    ControlOutbound::Binary(bytes) => send_dc.send(&Bytes::from(bytes)).await,
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
        send_controls.unregister(agent_id, &send_session_id).await;
        let _ = send_dc.close().await;
    });

    // webrtc-rs may invoke multiple message callbacks concurrently. Serialize
    // each viewer's requests so state-changing operations and their replies
    // retain the ordered DataChannel's request order.
    let request_lock = Arc::new(Mutex::new(()));
    let message_registry = registry;
    let message_controls = controls.clone();
    let message_sender = sender.clone();
    let message_display_sender = display_sender.clone();
    let message_session_id = session_id.clone();
    let message_active = Arc::clone(&active);
    let message_lifecycle = Arc::clone(&lifecycle);
    dc.on_message(Box::new(move |msg: DataChannelMessage| {
        let registry = message_registry.clone();
        let controls = message_controls.clone();
        let sender = message_sender.clone();
        let display_sender = message_display_sender.clone();
        let session_id = message_session_id.clone();
        let request_lock = request_lock.clone();
        let active = Arc::clone(&message_active);
        let lifecycle = Arc::clone(&message_lifecycle);
        Box::pin(async move {
            if !active.load(Ordering::Acquire) {
                return;
            }
            let _lifecycle = lifecycle.read().await;
            if !active.load(Ordering::Acquire) {
                return;
            }
            let _guard = request_lock.lock().await;
            if !active.load(Ordering::Acquire) {
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
                    if !controls.contains_viewer(agent_id, &session_id).await {
                        controls
                            .register(agent_id, session_id.clone(), display_sender)
                            .await;
                    }
                    handle_control_request(
                        agent_id,
                        &session_id,
                        request,
                        &registry,
                        &controls,
                        &sender,
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
    let open_lifecycle = Arc::clone(&lifecycle);
    dc.on_open(Box::new(move || {
        let controls = open_controls.clone();
        let session_id = open_session_id.clone();
        let _sender = open_sender.clone();
        let display_sender = open_display_sender.clone();
        let active = Arc::clone(&open_active);
        let lifecycle = Arc::clone(&open_lifecycle);
        Box::pin(async move {
            if !active.load(Ordering::Acquire) {
                return;
            }
            let _lifecycle = lifecycle.read().await;
            if !active.load(Ordering::Acquire) {
                return;
            }
            controls
                .register(agent_id, session_id, display_sender)
                .await;
        })
    }));

    dc.on_close(Box::new(move || {
        let controls = controls.clone();
        let session_id = session_id.clone();
        let close_tx = close_tx.clone();
        Box::pin(async move {
            if let Some(close_tx) = close_tx.lock().await.take() {
                let _ = close_tx.send(());
            }
            controls.unregister(agent_id, &session_id).await;
        })
    }));
}

async fn handle_control_request(
    agent_id: Uuid,
    session_id: &str,
    request: ControlRequest,
    registry: &AgentRegistry,
    controls: &AgentControlHub,
    sender: &ControlSender,
) {
    let request_id = request.request_id;
    let transaction = controls.transaction(agent_id).await;
    let _guard = transaction.lock().await;
    if let Err(mut error) =
        execute_control_request(agent_id, session_id, request, registry, controls, sender).await
    {
        if error.request_id.is_none() {
            error.request_id = Some(request_id);
        }
        agent_ctl::send_error(sender, &error).await;
    }
}

async fn execute_control_request(
    agent_id: Uuid,
    session_id: &str,
    request: ControlRequest,
    registry: &AgentRegistry,
    controls: &AgentControlHub,
    sender: &ControlSender,
) -> Result<(), ProtocolError> {
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
                    resize_agent(agent_id, cols, rows, registry).await?;
                    let _ = controls.update_size(agent_id, session_id, cols, rows).await;
                    // tmux reflows asynchronously after refresh-client.
                    if registry.is_worker(agent_id) != Some(true) {
                        tokio::time::sleep(Duration::from_millis(150)).await;
                    }
                }
            }
            send_agent_replay(
                agent_id,
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
            send_agent_replay(
                agent_id,
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
            resize_agent(agent_id, cols, rows, registry).await?;
            let _ = controls.update_size(agent_id, session_id, cols, rows).await;
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
            resize_agent(agent_id, cols, rows, registry).await?;
            let _ = controls
                .take_control(agent_id, session_id, cols, rows)
                .await;
            redraw_agent(agent_id, registry).await;
            agent_ctl::send_ack(sender, request_id, operation_name).await?;
            Ok(())
        }
        ControlOperation::Scroll { lines } => {
            scroll_agent(agent_id, lines, registry).await?;
            agent_ctl::send_ack(sender, request_id, operation_name).await?;
            Ok(())
        }
        ControlOperation::Redraw => {
            redraw_agent(agent_id, registry).await;
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
    agent_id: Uuid,
    spec: ReplaySpec<'_>,
    registry: &AgentRegistry,
    sender: &ControlSender,
) -> Result<(), ProtocolError> {
    let Some(control) = registry.control_for(agent_id) else {
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
    let capture = capture_agent_replay(agent_id, spec.lines, spec.plain, registry, &control);
    tokio::pin!(capture);
    let (source_boundary, bytes) = tokio::select! {
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
        bytes,
    )
    .await
}

async fn capture_agent_replay(
    agent_id: Uuid,
    lines: u16,
    plain: bool,
    registry: &AgentRegistry,
    control: &crate::pty::ForwarderControl,
) -> Result<(u64, Vec<u8>), ProtocolError> {
    if registry.is_worker(agent_id) == Some(true) {
        let max_bytes = if lines == agent_ctl::MAX_HISTORY_LINES {
            8 * 1024 * 1024
        } else {
            (lines as u32)
                .saturating_mul(256)
                .clamp(64 * 1024, 8 * 1024 * 1024)
        };
        let mut replay_rx = None;
        registry.with_handle(agent_id, |handle| {
            replay_rx = handle.worker_replay(max_bytes);
        });
        return match replay_rx {
            Some(receiver) => match receiver.await {
                Ok(Ok((watermark, bytes))) => {
                    control.wait_source_offset(watermark).await;
                    Ok((watermark, bytes))
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
        };
    }

    let (source_boundary, bytes) = control
        .exact_replay_snapshot(plain)
        .await
        .map_err(|error| {
            ProtocolError::new(
                None,
                "replay_unavailable",
                &format!("exact tmux replay is unavailable: {error:#}"),
            )
        })?;
    Ok((source_boundary, bytes))
}

async fn resize_agent(
    agent_id: Uuid,
    cols: u16,
    rows: u16,
    registry: &AgentRegistry,
) -> Result<(), ProtocolError> {
    let mut result = None;
    let found = registry.with_handle(agent_id, |handle| {
        result = Some(handle.resize(cols, rows));
    });
    if !found {
        return Err(ProtocolError::new(
            None,
            "agent_unavailable",
            "agent is not running on this daemon",
        ));
    }
    let changed = result
        .expect("found handle sets result")
        .map_err(|error| ProtocolError::new(None, "resize_failed", &format!("{error:#}")))?;
    if changed && registry.is_worker(agent_id) != Some(true) {
        if let Some(session) = registry.session_for(agent_id) {
            tmux::refresh_client(&session, cols, rows).await;
        }
    }
    Ok(())
}

async fn scroll_agent(
    agent_id: Uuid,
    lines: i16,
    registry: &AgentRegistry,
) -> Result<(), ProtocolError> {
    if registry.is_worker(agent_id) == Some(true) {
        return Ok(());
    }
    let Some(session) = registry.session_for(agent_id) else {
        return Err(ProtocolError::new(
            None,
            "agent_unavailable",
            "agent is not running on this daemon",
        ));
    };
    if let Some(control) = registry.control_for(agent_id) {
        control.suppress_activity(crate::activity::REDRAW_SUPPRESS_WINDOW);
    }
    tmux::scroll_history(&session, lines)
        .await
        .map_err(|error| {
            ProtocolError::new(None, "scroll_failed", &format!("scroll failed: {error:#}"))
        })
}

async fn redraw_agent(agent_id: Uuid, registry: &AgentRegistry) {
    if registry.is_worker(agent_id) == Some(true) {
        return;
    }
    let Some(session) = registry.session_for(agent_id) else {
        return;
    };
    if let Some(control) = registry.control_for(agent_id) {
        control.suppress_activity(crate::activity::REDRAW_SUPPRESS_WINDOW);
    }
    tmux::force_repaint(&session).await;
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

async fn send_status(
    out_tx: &mpsc::Sender<WsOutbound>,
    session_id: String,
    generation: String,
    agent_id: Uuid,
    status: &str,
    message: Option<&str>,
) {
    send_json(
        out_tx,
        Outbound::RtcStatus {
            session_id,
            generation,
            agent_id,
            status: status.to_string(),
            message: message.map(str::to_string),
        },
    )
    .await;
}

async fn send_json(out_tx: &mpsc::Sender<WsOutbound>, frame: Outbound) {
    if let Ok(s) = serde_json::to_string(&frame) {
        let _ = out_tx.send(WsOutbound::Json(s)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn connect_peer_pair(
        offer_pc: &Arc<RTCPeerConnection>,
        answer_pc: &Arc<RTCPeerConnection>,
    ) {
        let offer = offer_pc.create_offer(None).await.unwrap();
        let mut offer_gathered = offer_pc.gathering_complete_promise().await;
        offer_pc.set_local_description(offer).await.unwrap();
        let _ = offer_gathered.recv().await;
        answer_pc
            .set_remote_description(offer_pc.local_description().await.unwrap())
            .await
            .unwrap();
        let answer = answer_pc.create_answer(None).await.unwrap();
        let mut answer_gathered = answer_pc.gathering_complete_promise().await;
        answer_pc.set_local_description(answer).await.unwrap();
        let _ = answer_gathered.recv().await;
        offer_pc
            .set_remote_description(answer_pc.local_description().await.unwrap())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn real_spawn_ctl_data_channel_routes_versioned_request_and_cleans_up() {
        let mut media_engine = MediaEngine::default();
        media_engine.register_default_codecs().unwrap();
        let api = APIBuilder::new().with_media_engine(media_engine).build();
        let offer_pc = Arc::new(
            api.new_peer_connection(RTCConfiguration::default())
                .await
                .unwrap(),
        );
        let answer_pc = Arc::new(
            api.new_peer_connection(RTCConfiguration::default())
                .await
                .unwrap(),
        );
        let client_dc = offer_pc
            .create_data_channel(CONTROL_DATA_CHANNEL_LABEL, None)
            .await
            .unwrap();
        let (open_tx, open_rx) = oneshot::channel();
        let open_tx = Arc::new(Mutex::new(Some(open_tx)));
        let open_signal = Arc::clone(&open_tx);
        client_dc.on_open(Box::new(move || {
            let open_signal = Arc::clone(&open_signal);
            Box::pin(async move {
                if let Some(tx) = open_signal.lock().await.take() {
                    let _ = tx.send(());
                }
            })
        }));
        let (message_tx, mut message_rx) = mpsc::channel::<String>(8);
        client_dc.on_message(Box::new(move |message| {
            let message_tx = message_tx.clone();
            Box::pin(async move {
                if message.is_string {
                    if let Ok(text) = String::from_utf8(message.data.to_vec()) {
                        let _ = message_tx.send(text).await;
                    }
                }
            })
        }));

        let agent_id = Uuid::new_v4();
        let viewer = "rtc-real:generation".to_string();
        let hub = AgentControlHub::default();
        let server_hub = hub.clone();
        let server_viewer = viewer.clone();
        answer_pc.on_data_channel(Box::new(move |dc| {
            install_control_data_channel(
                dc,
                server_viewer.clone(),
                agent_id,
                AgentRegistry::new(),
                server_hub.clone(),
                Arc::new(AtomicBool::new(true)),
                Arc::new(RwLock::new(())),
            );
            Box::pin(async {})
        }));

        connect_peer_pair(&offer_pc, &answer_pc).await;
        tokio::time::timeout(Duration::from_secs(10), open_rx)
            .await
            .expect("spawn.ctl did not open")
            .expect("open callback dropped");
        let request_id = Uuid::new_v4();
        client_dc
            .send_text(format!(
                r#"{{"version":1,"kind":"request","request_id":"{request_id}","operation":"redraw"}}"#
            ))
            .await
            .unwrap();

        let response = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let text = message_rx.recv().await.expect("spawn.ctl closed");
                if text.contains(&request_id.to_string()) {
                    break text;
                }
            }
        })
        .await
        .expect("spawn.ctl response timed out");
        assert!(response.contains("\"operation\":\"redraw\""));
        assert!(response.contains("\"ok\":true"));

        client_dc.close().await.unwrap();
        offer_pc.close().await.unwrap();
        answer_pc.close().await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while hub.contains_viewer(agent_id, &viewer).await {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("spawn.ctl viewer cleanup timed out");
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
}
