//! Minimal WebRTC interop probe for diagnosing browser<->webrtc-rs DataChannel
//! failures. Trickle-ICE signaling over stdio, one JSON object per line:
//!   stdin:  {"type":"offer","sdp":"..."}
//!           {"type":"candidate","candidate":{...}}
//!   stdout: {"type":"answer","sdp":"..."}
//!           {"type":"candidate","candidate":{...}}
//! Event lines go to stderr. Exits 0 once a message has been echoed,
//! 2 on timeout.

use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut media_engine = MediaEngine::default();
    media_engine.register_default_codecs()?;
    let api = APIBuilder::new().with_media_engine(media_engine).build();
    let pc = Arc::new(
        api.new_peer_connection(RTCConfiguration {
            ice_servers: vec![RTCIceServer {
                urls: vec!["stun:stun.l.google.com:19302".to_owned()],
                ..Default::default()
            }],
            ..Default::default()
        })
        .await?,
    );

    let (done_tx, mut done_rx) = mpsc::channel::<()>(1);

    pc.on_peer_connection_state_change(Box::new(move |s| {
        eprintln!("EVENT pc-state {s}");
        Box::pin(async {})
    }));
    pc.on_ice_connection_state_change(Box::new(move |s| {
        eprintln!("EVENT ice-state {s}");
        Box::pin(async {})
    }));

    // Trickle our candidates to the browser as they gather.
    pc.on_ice_candidate(Box::new(move |c| {
        Box::pin(async move {
            if let Some(c) = c {
                if let Ok(init) = c.to_json() {
                    if let Ok(js) = serde_json::to_string(&init) {
                        println!("{{\"type\":\"candidate\",\"candidate\":{js}}}");
                    }
                }
            }
        })
    }));

    pc.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
        let done_tx = done_tx.clone();
        Box::pin(async move {
            eprintln!("EVENT dc-announced {}", dc.label());
            let dc_for_msg = Arc::clone(&dc);
            dc.on_open(Box::new(move || {
                eprintln!("EVENT dc-open");
                Box::pin(async {})
            }));
            dc.on_message(Box::new(move |msg: DataChannelMessage| {
                let dc = Arc::clone(&dc_for_msg);
                let done_tx = done_tx.clone();
                Box::pin(async move {
                    let text = String::from_utf8_lossy(&msg.data).into_owned();
                    eprintln!("EVENT dc-message {text}");
                    let _ = dc.send_text(format!("echo:{text}")).await;
                    let _ = done_tx.send(()).await;
                })
            }));
        })
    }));

    // Signaling loop on stdin.
    let pc_signal = Arc::clone(&pc);
    tokio::spawn(async move {
        let mut lines = BufReader::new(tokio::io::stdin()).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            match msg.get("type").and_then(|t| t.as_str()) {
                Some("offer") => {
                    let sdp = msg.get("sdp").and_then(|s| s.as_str()).unwrap_or_default();
                    let Ok(offer) = RTCSessionDescription::offer(sdp.to_owned()) else {
                        eprintln!("EVENT bad-offer");
                        continue;
                    };
                    if let Err(e) = pc_signal.set_remote_description(offer).await {
                        eprintln!("EVENT set-remote-error {e}");
                        continue;
                    }
                    match pc_signal.create_answer(None).await {
                        Ok(answer) => {
                            let sdp_text = answer.sdp.clone();
                            if let Err(e) = pc_signal.set_local_description(answer).await {
                                eprintln!("EVENT set-local-error {e}");
                                continue;
                            }
                            let js = serde_json::json!({"type": "answer", "sdp": sdp_text});
                            println!("{js}");
                        }
                        Err(e) => eprintln!("EVENT answer-error {e}"),
                    }
                }
                Some("candidate") => {
                    if let Some(c) = msg.get("candidate") {
                        if let Ok(init) = serde_json::from_value::<RTCIceCandidateInit>(c.clone())
                        {
                            if let Err(e) = pc_signal.add_ice_candidate(init).await {
                                eprintln!("EVENT add-candidate-error {e}");
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    });

    match tokio::time::timeout(Duration::from_secs(30), done_rx.recv()).await {
        Ok(_) => {
            // Give SCTP time to flush the echo before tearing down.
            tokio::time::sleep(Duration::from_secs(3)).await;
            eprintln!("EVENT success");
            Ok(())
        }
        Err(_) => {
            eprintln!("EVENT timeout");
            std::process::exit(2);
        }
    }
}
