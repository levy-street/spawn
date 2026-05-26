//! WebRTC direct terminal transport.
//!
//! The central websocket remains the authenticated control/signaling plane.
//! Once a browser and daemon establish a DataChannel, raw PTY input/output can
//! bypass the server relay path while the daemon still mirrors output to the
//! server websocket for transcripts and fallback viewers.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{Context, Result};
use bytes::Bytes;
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_credential_type::RTCIceCredentialType;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;

use crate::agents::AgentRegistry;
use crate::proto::{Outbound, RtcIceServerConfig};
use crate::pty::WsOutbound;
use crate::tmux;

const DATA_CHANNEL_LABEL: &str = "spawn.pty";

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
        let api = APIBuilder::new().with_media_engine(media_engine).build();
        let pc = Arc::new(
            api.new_peer_connection(RTCConfiguration {
                ice_servers: ice_servers.into_iter().map(to_webrtc_ice_server).collect(),
                ..Default::default()
            })
            .await
            .context("creating peer connection")?,
        );

        install_ice_handler(&pc, session_id.clone(), agent_id, out_tx.clone());
        install_data_channel_handler(&pc, session_id.clone(), agent_id, registry, out_tx.clone());

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

        self.peers.lock().await.insert(session_id.clone(), pc);
        send_json(
            &out_tx,
            Outbound::RtcAnswer {
                session_id,
                agent_id,
                sdp: local.sdp,
            },
        )
        .await;
        Ok(())
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
            dc.on_message(Box::new(move |msg: DataChannelMessage| {
                let registry = input_registry.clone();
                Box::pin(async move {
                    if msg.is_string {
                        return;
                    }
                    if let Some(session) = registry.session_for(agent_id) {
                        tmux::cancel_copy_mode(&session).await;
                    }
                    let found = registry.with_handle(agent_id, |h| {
                        if let Err(e) = h.write_stdin(&msg.data) {
                            tracing::warn!(%agent_id, error = %e, "rtc PTY stdin write failed");
                        }
                    });
                    if !found {
                        tracing::debug!(%agent_id, "ignoring rtc stdin for unknown agent");
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
    let username = config.username.unwrap_or_default();
    let credential = config.credential.unwrap_or_default();
    let credential_type = if !username.is_empty() || !credential.is_empty() {
        RTCIceCredentialType::Password
    } else {
        RTCIceCredentialType::Unspecified
    };
    RTCIceServer {
        urls: config.urls,
        username,
        credential,
        credential_type,
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
