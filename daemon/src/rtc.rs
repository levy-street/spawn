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
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::setting_engine::SettingEngine;
use webrtc::api::APIBuilder;
use webrtc::ice::mdns::MulticastDnsMode;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;

use crate::agents::AgentRegistry;
use crate::proto::{Outbound, RtcIceServerConfig};
use crate::pty::WsOutbound;
use crate::tmux;

const DATA_CHANNEL_LABEL: &str = "spawn.pty";

/// Peer connections that never reach `Connected` within this window are
/// reaped. Closing is the daemon's own defense: `rtc.close` delivery from the
/// browser/server is best-effort, and every unreaped peer connection holds
/// multiple UDP sockets (ICE host candidates + mDNS) until closed — webrtc-rs
/// does NOT release them on drop.
const RTC_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Grace period for a connected peer that reports `Disconnected` (transient
/// network blips) before the daemon closes it.
const RTC_DISCONNECTED_GRACE: Duration = Duration::from_secs(15);

#[derive(Default, Clone)]
pub struct RtcSessions {
    peers: Arc<Mutex<HashMap<String, Arc<RTCPeerConnection>>>>,
}

impl RtcSessions {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn handle_offer(
        &self,
        session_id: String,
        agent_id: Uuid,
        sdp: String,
        ice_servers: Vec<RtcIceServerConfig>,
        registry: AgentRegistry,
        out_tx: mpsc::Sender<WsOutbound>,
    ) {
        if !registry.contains(agent_id) {
            send_status(
                &out_tx,
                session_id,
                agent_id,
                "failed",
                Some("agent is not running on this daemon"),
            )
            .await;
            return;
        }

        if let Err(e) = self
            .create_answer(
                session_id.clone(),
                agent_id,
                sdp,
                ice_servers,
                registry,
                out_tx.clone(),
            )
            .await
        {
            tracing::warn!(%agent_id, %session_id, error = %e, "rtc offer failed");
            send_status(
                &out_tx,
                session_id,
                agent_id,
                "failed",
                Some(&format!("{e:#}")),
            )
            .await;
        }
    }

    async fn create_answer(
        &self,
        session_id: String,
        agent_id: Uuid,
        sdp: String,
        ice_servers: Vec<RtcIceServerConfig>,
        registry: AgentRegistry,
        out_tx: mpsc::Sender<WsOutbound>,
    ) -> Result<()> {
        self.close(&session_id).await;

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

        // Track the peer connection BEFORE negotiation so every exit path —
        // including negotiation errors below — can reach it and close it.
        self.peers
            .lock()
            .await
            .insert(session_id.clone(), Arc::clone(&pc));

        install_ice_handler(&pc, session_id.clone(), agent_id, out_tx.clone());
        install_data_channel_handler(&pc, session_id.clone(), agent_id, registry, out_tx.clone());
        self.install_reaper(&pc, session_id.clone(), agent_id);

        let local_sdp = match negotiate(&pc, sdp).await {
            Ok(local_sdp) => local_sdp,
            Err(e) => {
                self.close_if_same(&session_id, &pc).await;
                return Err(e);
            }
        };

        send_json(
            &out_tx,
            Outbound::RtcAnswer {
                session_id,
                agent_id,
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
                .is_some_and(|current| Arc::ptr_eq(current, pc))
            {
                peers.remove(session_id);
            }
        }
        let _ = pc.close().await;
    }

    pub async fn handle_candidate(&self, session_id: String, candidate: serde_json::Value) {
        let Some(pc) = self.peers.lock().await.get(&session_id).cloned() else {
            tracing::debug!(%session_id, "ignoring rtc candidate for unknown session");
            return;
        };
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

    pub async fn close(&self, session_id: &str) {
        let pc = self.peers.lock().await.remove(session_id);
        if let Some(pc) = pc {
            let _ = pc.close().await;
        }
    }

    pub async fn close_all(&self) {
        let peers = std::mem::take(&mut *self.peers.lock().await);
        for (_, pc) in peers {
            let _ = pc.close().await;
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
    agent_id: Uuid,
    out_tx: mpsc::Sender<WsOutbound>,
) {
    pc.on_ice_candidate(Box::new(move |candidate| {
        let out_tx = out_tx.clone();
        let session_id = session_id.clone();
        Box::pin(async move {
            let Some(candidate) = candidate else {
                return;
            };
            let candidate = match candidate.to_json() {
                Ok(candidate) => candidate,
                Err(e) => {
                    tracing::debug!(%agent_id, error = %e, "encoding rtc candidate failed");
                    return;
                }
            };
            match serde_json::to_value(candidate) {
                Ok(candidate) => {
                    send_json(
                        &out_tx,
                        Outbound::RtcCandidate {
                            session_id,
                            agent_id,
                            candidate,
                        },
                    )
                    .await;
                }
                Err(e) => {
                    tracing::debug!(%agent_id, error = %e, "serializing rtc candidate failed");
                }
            }
        })
    }));
}

fn install_data_channel_handler(
    pc: &Arc<RTCPeerConnection>,
    session_id: String,
    agent_id: Uuid,
    registry: AgentRegistry,
    out_tx: mpsc::Sender<WsOutbound>,
) {
    pc.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
        let session_id = session_id.clone();
        let registry = registry.clone();
        let out_tx = out_tx.clone();
        Box::pin(async move {
            if dc.label() != DATA_CHANNEL_LABEL {
                tracing::debug!(%agent_id, label = %dc.label(), "ignoring unknown rtc data channel");
                return;
            }

            let input_registry = registry.clone();
            let input_out_tx = out_tx.clone();
            dc.on_message(Box::new(move |msg: DataChannelMessage| {
                let registry = input_registry.clone();
                let out_tx = input_out_tx.clone();
                Box::pin(async move {
                    if msg.is_string || msg.data.is_empty() {
                        return;
                    }
                    // Cached check: never pay a tmux subprocess per keystroke.
                    // Worker-backed agents have no tmux copy-mode at all.
                    if registry.is_worker(agent_id) != Some(true) {
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
                    let mut wrote_input = false;
                    let found = registry.with_handle(agent_id, |h| match h.write_stdin(&msg.data) {
                        Ok(()) => wrote_input = true,
                        Err(e) => {
                            tracing::warn!(%agent_id, error = %e, "rtc PTY stdin write failed");
                        }
                    });
                    if !found {
                        tracing::debug!(%agent_id, "ignoring rtc stdin for unknown agent");
                    } else if wrote_input {
                        if let Some(control) = registry.control_for(agent_id) {
                            if control.note_input() {
                                crate::pty::try_emit_activity(
                                    &out_tx,
                                    agent_id,
                                    crate::pty::ActivityKind::Input,
                                );
                            }
                        }
                    }
                })
            }));

            let open_registry = registry.clone();
            let open_session_id = session_id.clone();
            let open_out_tx = out_tx.clone();
            let open_dc = Arc::clone(&dc);
            dc.on_open(Box::new(move || {
                let registry = open_registry.clone();
                let session_id = open_session_id.clone();
                let out_tx = open_out_tx.clone();
                let dc = Arc::clone(&open_dc);
                Box::pin(async move {
                    let Some(control) = registry.control_for(agent_id) else {
                        send_status(
                            &out_tx,
                            session_id,
                            agent_id,
                            "failed",
                            Some("agent is not running on this daemon"),
                        )
                        .await;
                        return;
                    };

                    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
                    control.add_direct_sink(session_id.clone(), tx).await;
                    send_status(&out_tx, session_id.clone(), agent_id, "connected", None).await;
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
    agent_id: Uuid,
    status: &str,
    message: Option<&str>,
) {
    send_json(
        out_tx,
        Outbound::RtcStatus {
            session_id,
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
