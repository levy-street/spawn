//! Authenticated device–daemon connections (host signalling version 2).
//!
//! A terminal attachment owns channels and a backend-generation fence, never
//! the peer connection. The signed host transcript authenticates the device;
//! channel labels select only sessions in this daemon's local registry.

use super::*;

const MAX_PAIR_SESSIONS: usize = 128;
const MAX_PAIR_CONTROLS: usize = 32;

pub(super) struct PairContext {
    pub(super) device_key: [u8; 32],
    registry: SessionRegistry,
    out_tx: mpsc::Sender<WsOutbound>,
    trust_epoch: u64,
    ice_restart: bool,
    remote_ufrags: Mutex<HashSet<String>>,
    restart: Mutex<()>,
    retired: AtomicBool,
    host_channels: std::sync::Mutex<Vec<Weak<crate::host_control::Lifetime>>>,
}

impl PairContext {
    pub(super) fn retire(&self) {
        self.retired.store(true, Ordering::Release);
        let mut channels = self
            .host_channels
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for channel in channels.drain(..).filter_map(|channel| channel.upgrade()) {
            channel.retire();
        }
    }

    fn register_host(&self, lifetime: Arc<crate::host_control::Lifetime>) {
        let mut channels = self
            .host_channels
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.retired.load(Ordering::Acquire) {
            lifetime.retire();
        } else {
            channels.retain(|channel| {
                channel
                    .upgrade()
                    .is_some_and(|channel| !channel.is_retired())
            });
            channels.push(Arc::downgrade(&lifetime));
        }
    }
}

#[derive(Default)]
pub(super) struct SessionChannels {
    handler: Mutex<Option<OnDataChannelHdlrFn>>,
    channels: Mutex<Vec<Weak<RTCDataChannel>>>,
}

pub(super) fn is_session(signal_id: &str) -> bool {
    signal_id.starts_with("pair/")
}

pub(super) async fn close_session_transport(peer: &RtcPeer) {
    if let Some(pair) = &peer.pair_channels {
        let channels = pair.channels.lock().await.clone();
        for channel in channels.into_iter().filter_map(|channel| channel.upgrade()) {
            let _ = channel.close().await;
        }
        pair.handler.lock().await.take();
    } else {
        let _ = peer.pc.close().await;
    }
}

// webrtc invokes on_data_channel before attaching the SCTP stream. Closing
// there alone is ineffective: handle_open subsequently opens it again.
async fn reject_channel(dc: &Arc<RTCDataChannel>) {
    if dc.ready_state() == RTCDataChannelState::Connecting {
        let weak = Arc::downgrade(dc);
        dc.on_open(Box::new(move || {
            let weak = weak.clone();
            Box::pin(async move {
                if let Some(dc) = weak.upgrade() {
                    let _ = dc.close().await;
                }
            })
        }));
    } else {
        let _ = dc.close().await;
    }
}

#[derive(Debug, PartialEq)]
struct AttachmentLabel {
    session: Uuid,
    view: Uuid,
    attachment: Uuid,
}

fn attachment_label(label: &str) -> Option<AttachmentLabel> {
    let mut parts = label.split('/');
    if !matches!(
        parts.next()?,
        PTY_DATA_CHANNEL_LABEL | CONTROL_DATA_CHANNEL_LABEL
    ) {
        return None;
    }
    let mut uuid = || {
        let text = parts.next()?;
        let value = Uuid::parse_str(text).ok()?;
        (value.to_string() == text).then_some(value)
    };
    let result = AttachmentLabel {
        session: uuid()?,
        view: uuid()?,
        attachment: uuid()?,
    };
    parts.next().is_none().then_some(result)
}

impl RtcSessions {
    #[allow(clippy::too_many_arguments)]
    pub async fn handle_device_offer(
        &self,
        signal: HostRtcSignal,
        sdp: String,
        ice_servers: Vec<RtcIceServerConfig>,
        ice_transport_policy: Option<String>,
        ice_restart: bool,
        device_key: [u8; 32],
        registry: SessionRegistry,
        out_tx: mpsc::Sender<WsOutbound>,
        answer_signer: RtcAnswerSigner,
    ) {
        let Some(binding) = signal
            .binding()
            .filter(|binding| binding.protocol_version == 2)
        else {
            return;
        };
        if *self.registered_host_id.lock().await != Some(binding.host_id) {
            return;
        }
        self.signaling.install(out_tx.clone());
        let trust_epoch = self.capture_trust_epoch();
        let Some(ufrag) = ice_ufrag(&sdp) else { return };
        let pair = Arc::new(PairContext {
            device_key,
            registry,
            out_tx: out_tx.clone(),
            trust_epoch,
            ice_restart,
            remote_ufrags: Mutex::new(HashSet::from([ufrag])),
            restart: Mutex::new(()),
            retired: AtomicBool::new(false),
            host_channels: std::sync::Mutex::new(Vec::new()),
        });
        if let Err(error) = self
            .create_host_answer(
                signal.signal_id.clone(),
                binding.clone(),
                sdp,
                ice_servers,
                ice_transport_policy,
                HostRtcAdmissionContext {
                    pair: Some(pair),
                    trust_epoch,
                    out_tx: out_tx.clone(),
                },
                Some(answer_signer),
            )
            .await
        {
            tracing::debug!(%error, "device connection admission failed");
            send_host_status(&out_tx, signal.signal_id, &binding, "failed").await;
        }
    }

    pub(super) async fn restart_pair(
        &self,
        signal_id: &str,
        binding: &HostRtcBinding,
        proposed: &PairContext,
        sdp: &str,
        signer: &Option<RtcAnswerSigner>,
        out_tx: &mpsc::Sender<WsOutbound>,
    ) -> Result<bool> {
        let existing = self.host_peers.lock().await.get(signal_id).cloned();
        let Some(existing) = existing else {
            anyhow::ensure!(
                !proposed.ice_restart,
                "restart of unknown device connection"
            );
            return Ok(false);
        };
        let pair = existing.pair.as_ref().context("not a device connection")?;
        let _restart = pair.restart.lock().await;
        let ufrag = ice_ufrag(sdp).context("missing ICE ufrag")?;
        anyhow::ensure!(
            proposed.ice_restart
                && existing.binding == *binding
                && pair.device_key == proposed.device_key
                && !pair.retired.load(Ordering::Acquire)
                && self.trust_epoch_is_current(pair.trust_epoch)
                && !pair.remote_ufrags.lock().await.contains(&ufrag),
            "stale device restart"
        );
        let local = negotiate(&existing.pc, sdp.to_string()).await?;
        anyhow::ensure!(
            !pair.retired.load(Ordering::Acquire) && self.trust_epoch_is_current(pair.trust_epoch),
            "trust changed during restart"
        );
        pair.remote_ufrags.lock().await.insert(ufrag);
        let (sdp, signed_envelope) = sign_answer(&local, signer)?;
        send_json(
            out_tx,
            Outbound::RtcAnswer {
                session_id: signal_id.to_string(),
                binding_nonce: Some(binding.binding_nonce.clone()),
                scope_type: Some("host".into()),
                scope_id: Some(binding.host_id),
                protocol: Some(binding.protocol.clone()),
                protocol_version: Some(2),
                sdp,
                signed_envelope,
            },
        )
        .await;
        Ok(true)
    }

    /// Called under admission: a new authenticated connection fences the old
    /// one before it is admitted, including after browser owner handover.
    pub(super) async fn retire_device_pair(&self, device_key: [u8; 32]) {
        let retired = {
            let mut hosts = self.host_peers.lock().await;
            let ids = hosts
                .iter()
                .filter(|(_, peer)| {
                    peer.pair
                        .as_ref()
                        .is_some_and(|pair| pair.device_key == device_key)
                })
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| hosts.remove(&id))
                .inspect(|peer| {
                    if let Some(pair) = &peer.pair {
                        pair.retire();
                    }
                })
                .collect::<Vec<_>>()
        };
        for peer in retired {
            self.close_pair_sessions(&peer.pc).await;
            let _ = peer.pc.close().await;
        }
    }

    pub(super) async fn close_pair_sessions(&self, pc: &Arc<RTCPeerConnection>) {
        let children = self
            .peers
            .lock()
            .await
            .iter()
            .filter(|(_, peer)| peer.pair_channels.is_some() && Arc::ptr_eq(&peer.pc, pc))
            .map(|(id, peer)| (id.clone(), peer.clone()))
            .collect::<Vec<_>>();
        // Stop every child before waiting for any one child's cleanup.
        for (_, peer) in &children {
            peer.active.store(false, Ordering::Release);
            peer.channels.stop();
            peer.close.initiate();
        }
        for (id, peer) in children {
            self.close(&id, &peer.generation, peer.session.session_id())
                .await;
        }
    }

    pub(super) fn install_pair_channels(
        &self,
        pc: &Arc<RTCPeerConnection>,
        signal_id: String,
        binding: HostRtcBinding,
        pair: Arc<PairContext>,
    ) {
        let sessions = self.clone();
        let weak_pc = Arc::downgrade(pc);
        let controls = Arc::new(Mutex::new(HashMap::<String, Weak<RTCDataChannel>>::new()));
        pc.on_data_channel(Box::new(move |dc| {
            let sessions = sessions.clone();
            let pc = weak_pc.upgrade();
            let signal_id = signal_id.clone();
            let binding = binding.clone();
            let pair = Arc::clone(&pair);
            let controls = Arc::clone(&controls);
            Box::pin(async move {
                let Some(pc) = pc else { return };
                let reliable = dc.ordered()
                    && dc.max_packet_lifetime().is_none()
                    && dc.max_retransmits().is_none();
                if !reliable
                    || pair.retired.load(Ordering::Acquire)
                    || !sessions.trust_epoch_is_current(pair.trust_epoch)
                {
                    reject_channel(&dc).await;
                    return;
                }
                let label = dc.label();
                if label == HOST_CONTROL_LABEL
                    || label.strip_prefix("spawn.host.ctl/").is_some_and(|id| {
                        Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id)
                    })
                {
                    let _admission = sessions.admission.lock().await;
                    if !sessions
                        .pair_is_current(&signal_id, &pc, pair.trust_epoch)
                        .await
                    {
                        reject_channel(&dc).await;
                        return;
                    }
                    let mut live = controls.lock().await;
                    live.retain(|_, channel| {
                        channel.upgrade().is_some_and(|channel| {
                            channel.ready_state() != RTCDataChannelState::Closed
                        })
                    });
                    if live.contains_key(label)
                        || (label != HOST_CONTROL_LABEL
                            && live
                                .keys()
                                .filter(|key| key.as_str() != HOST_CONTROL_LABEL)
                                .count()
                                >= MAX_PAIR_CONTROLS)
                    {
                        reject_channel(&dc).await;
                        return;
                    }
                    live.insert(label.to_string(), Arc::downgrade(&dc));
                    pair.register_host(install_host_control_channel(
                        dc,
                        signal_id,
                        binding,
                        sessions.signaling.clone(),
                        None,
                    ));
                    return;
                }
                let Some(label) = attachment_label(label) else {
                    reject_channel(&dc).await;
                    return;
                };
                if let Err(error) = sessions
                    .attach_pair_channel(&signal_id, &pc, &pair, label, Arc::clone(&dc))
                    .await
                {
                    tracing::debug!(%error, "session attachment refused");
                    reject_channel(&dc).await;
                }
            })
        }));
    }

    async fn pair_is_current(&self, id: &str, pc: &Arc<RTCPeerConnection>, epoch: u64) -> bool {
        self.trust_epoch_is_current(epoch)
            && self
                .host_peers
                .lock()
                .await
                .get(id)
                .is_some_and(|peer| Arc::ptr_eq(&peer.pc, pc))
    }

    async fn attach_pair_channel(
        &self,
        parent_id: &str,
        pc: &Arc<RTCPeerConnection>,
        pair: &PairContext,
        label: AttachmentLabel,
        dc: Arc<RTCDataChannel>,
    ) -> Result<()> {
        let _admission = self.admission.lock().await;
        anyhow::ensure!(
            self.pair_is_current(parent_id, pc, pair.trust_epoch).await,
            "retired device connection"
        );
        let transition = pair
            .registry
            .lock_generation_transition(label.session)
            .await;
        let parent = self
            .host_peers
            .lock()
            .await
            .get(parent_id)
            .cloned()
            .context("retired parent")?;
        let id = format!(
            "pair/{}/{}/{}/{}",
            pair.device_key
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>(),
            label.view,
            label.session,
            label.attachment
        );
        let generation = format!(
            "{}:{}",
            parent.binding.binding_generation, parent.binding.binding_nonce
        );
        let existing = self.peers.lock().await.get(&id).cloned();
        let child = if let Some(child) = existing {
            anyhow::ensure!(
                Arc::ptr_eq(&child.pc, pc)
                    && child.generation == generation
                    && child.active.load(Ordering::Acquire)
                    && pair.registry.is_current(child.session),
                "stale attachment"
            );
            child
        } else {
            let count = self
                .peers
                .lock()
                .await
                .values()
                .filter(|peer| Arc::ptr_eq(&peer.pc, pc))
                .count();
            anyhow::ensure!(count < MAX_PAIR_SESSIONS, "too many terminal views");
            let session = pair
                .registry
                .binding_for(label.session)
                .context("session not running on this daemon")?;
            let control = pair
                .registry
                .control_for_binding(session)
                .context("session was replaced")?;
            let active = Arc::new(AtomicBool::new(true));
            let fence = Arc::new(tokio::sync::RwLock::new(()));
            let channels = Arc::new(RequiredSessionChannels::default());
            let close = Arc::new(PeerCloseCoordinator::default());
            let pair_channels = Arc::new(SessionChannels::default());
            let child = RtcPeer {
                pc: Arc::clone(pc),
                pair_channels: Some(Arc::clone(&pair_channels)),
                session,
                generation: generation.clone(),
                active: Arc::clone(&active),
                control: control.clone(),
                channels: Arc::clone(&channels),
                close: Arc::clone(&close),
                offer_key: Some(pair.device_key),
                remote_ufrags: Arc::new(Mutex::new(HashSet::new())),
                restart_lock: Arc::new(Mutex::new(())),
                _admission_permit: Arc::clone(&parent._admission_permit),
                fence: Arc::clone(&fence),
            };
            self.peers.lock().await.insert(id.clone(), child.clone());
            let handler = session_data_channel_handler(
                pc,
                self.clone(),
                BoundRtcSession {
                    signaling: RtcSignalBinding {
                        signal_id: id,
                        binding_nonce: parent.binding.binding_nonce.clone(),
                        generation,
                        session_id: label.session,
                    },
                    session,
                    control,
                    trust_epoch: pair.trust_epoch,
                },
                pair.registry.clone(),
                self.controls.clone(),
                RtcCallbackGuard { active, fence },
                channels,
                close,
                #[cfg(test)]
                None,
                #[cfg(test)]
                None,
                #[cfg(test)]
                None,
                pair.out_tx.clone(),
            );
            *pair_channels.handler.lock().await = Some(handler);
            child
        };
        let pair_channels = child
            .pair_channels
            .as_ref()
            .context("not a shared attachment")?;
        {
            let mut channels = pair_channels.channels.lock().await;
            anyhow::ensure!(channels.len() < 2, "attachment already has both channels");
            channels.push(Arc::downgrade(&dc));
        }
        let future = pair_channels
            .handler
            .lock()
            .await
            .as_mut()
            .context("closed attachment")?(dc);
        drop(transition);
        drop(_admission);
        future.await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn input_waiting_for_owner_lock_is_discarded_on_parent_retirement() {
        let sessions = RtcSessions::new();
        sessions.bind_registered_host_id(Uuid::new_v4()).await;
        let registry = SessionRegistry::new();
        let id = Uuid::new_v4();
        let (binding, mut commands) = crate::rtc::tests::insert_test_worker(&registry, id);
        let control = registry.control_for_binding(binding).unwrap();
        let (input_tx, mut input_rx) = mpsc::unbounded_channel();
        let worker = tokio::spawn(async move {
            while let Some(command) = commands.recv().await {
                match command {
                    crate::pty::WorkerCmd::Replay { resp, .. } => {
                        let _ = resp.send(Ok(crate::pty::WorkerReplay::new(
                            control.source_offset(),
                            vec![],
                        )));
                    }
                    crate::pty::WorkerCmd::Input(bytes) => {
                        let _ = input_tx.send(bytes.to_vec());
                    }
                    _ => {}
                }
            }
        });
        let pc = connect_pair(&sessions, &registry, [91; 32]).await;
        let (pty, _ctl) = attach(&pc, id).await;
        pty.send(&Bytes::from_static(b"before")).await.unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), input_rx.recv())
                .await
                .unwrap()
                .unwrap(),
            b"before"
        );
        let peer = sessions.peers.lock().await.values().next().unwrap().clone();
        let owner_lock = sessions.controls.lock_input_owners_for_test().await;
        pty.send(&Bytes::from_static(b"must be discarded"))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if peer.fence.try_write().is_err() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("input callback reached owner lock");
        let closing_sessions = sessions.clone();
        let closing_pc = Arc::clone(&peer.pc);
        let closing = tokio::spawn(async move {
            closing_sessions.close_pair_sessions(&closing_pc).await;
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while peer.active.load(Ordering::Acquire) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(!peer.channels.ready());
        drop(owner_lock);
        let leaked = tokio::time::timeout(Duration::from_millis(250), input_rx.recv()).await;
        closing.await.unwrap();
        sessions.close_all().await;
        pc.close().await.unwrap();
        worker.abort();
        assert!(
            leaked.is_err(),
            "input executed after parent retirement: {leaked:?}"
        );
    }

    #[tokio::test]
    async fn host_consumer_churn_releases_closed_channels_and_lifetimes() {
        let sessions = RtcSessions::new();
        sessions.bind_registered_host_id(Uuid::new_v4()).await;
        let registry = SessionRegistry::new();
        let pc = connect_pair(&sessions, &registry, [8; 32]).await;
        let (signal_tx, mut signal_rx) = mpsc::channel(128);
        sessions.signaling.install(signal_tx);
        let signal_sink = tokio::spawn(async move { while signal_rx.recv().await.is_some() {} });
        let peer = sessions
            .host_peers
            .lock()
            .await
            .values()
            .next()
            .unwrap()
            .clone();
        let mut lifetimes = Vec::new();
        let mut local_channels = Vec::new();
        let mut local_ids = HashSet::new();
        for _ in 0..256 {
            let channel = pc
                .create_data_channel(&format!("spawn.host.ctl/{}", Uuid::new_v4()), None)
                .await
                .unwrap();
            let (tx, mut rx) = mpsc::unbounded_channel();
            channel.on_message(Box::new(move |message| {
                let tx = tx.clone();
                Box::pin(async move {
                    let _ = tx.send(serde_json::from_slice::<Value>(&message.data).unwrap());
                })
            }));
            let hello = tokio::time::timeout(Duration::from_secs(5), rx.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(hello["type"], "hello");
            assert!(
                local_ids.insert(channel.id()),
                "pruning reused an allocated stream ID"
            );
            channel
                .send_text(
                    json!({
                        "version": 1, "type": "request", "request_id": "churn",
                        "operation": "fs.home", "payload": {}
                    })
                    .to_string(),
                )
                .await
                .unwrap();
            let reply = tokio::time::timeout(Duration::from_secs(5), rx.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(reply["request_id"], "churn");
            assert_eq!(reply["ok"], true);
            let lifetime = peer
                .pair
                .as_ref()
                .unwrap()
                .host_channels
                .lock()
                .unwrap()
                .last()
                .unwrap()
                .clone();
            channel.close().await.unwrap();
            tokio::time::timeout(Duration::from_secs(5), async {
                while channel.ready_state() != RTCDataChannelState::Closed
                    || lifetime
                        .upgrade()
                        .is_some_and(|lifetime| !lifetime.is_retired())
                {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("host consumer retired after close");
            local_channels.push(Arc::downgrade(&channel));
            lifetimes.push(lifetime);
        }
        // Admission removes the preceding closed channel; the final one may
        // remain until another admission or parent close. Cleanup tasks can
        // briefly hold references after retirement while they drain.
        tokio::time::timeout(Duration::from_secs(5), async {
            while lifetimes
                .iter()
                .filter(|lifetime| lifetime.upgrade().is_some())
                .count()
                > 1
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("closed consumers accumulated on a live shared parent");
        assert!(
            local_channels
                .iter()
                .filter(|channel| channel.upgrade().is_some())
                .count()
                <= 1
        );
        let stats = peer.pc.get_stats().await;
        let closed_channels = stats
            .reports
            .values()
            .filter(|report| {
                matches!(
                    report, webrtc::stats::StatsReportType::DataChannel(channel)
                        if channel.state == RTCDataChannelState::Closed
                )
            })
            .count();
        assert!(
            closed_channels <= 1,
            "closed transport registry grew with consumer history"
        );
        let closed_total = stats.reports.values().find_map(|report| match report {
            webrtc::stats::StatsReportType::PeerConnection(peer) => Some(peer.data_channels_closed),
            _ => None,
        });
        assert_eq!(
            closed_total,
            Some(256),
            "pruning lost cumulative close statistics"
        );
        assert_eq!(pc.connection_state(), RTCPeerConnectionState::Connected);
        sessions.close_all().await;
        pc.close().await.unwrap();
        drop(peer);
        tokio::time::timeout(Duration::from_secs(5), async {
            while lifetimes
                .iter()
                .any(|lifetime| lifetime.upgrade().is_some())
                || local_channels
                    .iter()
                    .any(|channel| channel.upgrade().is_some())
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("host callbacks retained consumer state after parent close");
        signal_sink.abort();
    }

    #[test]
    fn attachment_labels_are_exact_and_canonical() {
        let session = Uuid::new_v4();
        let view = Uuid::new_v4();
        let attachment = Uuid::new_v4();
        let label = format!("spawn.pty/{session}/{view}/{attachment}");
        assert_eq!(
            attachment_label(&label),
            Some(AttachmentLabel {
                session,
                view,
                attachment
            })
        );
        for bad in [
            format!("{label}/extra"),
            label.to_uppercase(),
            "spawn.pty".into(),
            format!("spawn.ctl/{session}/{view}"),
        ] {
            assert!(attachment_label(&bad).is_none(), "{bad}");
        }
    }
    async fn connect_pair(
        sessions: &RtcSessions,
        registry: &SessionRegistry,
        key: [u8; 32],
    ) -> Arc<RTCPeerConnection> {
        let host_id = sessions.registered_host_id.lock().await.unwrap();
        let pc = Arc::new(
            webrtc::api::APIBuilder::new()
                .build()
                .new_peer_connection(RTCConfiguration::default())
                .await
                .unwrap(),
        );
        pc.create_data_channel(HOST_CONTROL_LABEL, None)
            .await
            .unwrap();
        let offer = pc.create_offer(None).await.unwrap();
        let mut gathered = pc.gathering_complete_promise().await;
        pc.set_local_description(offer).await.unwrap();
        gathered.recv().await;
        let (tx, mut rx) = mpsc::channel(128);
        sessions
            .handle_device_offer(
                HostRtcSignal {
                    signal_id: Uuid::new_v4().to_string(),
                    binding_nonce: Some("a".repeat(32)),
                    binding_generation: Some(1),
                    scope_type: Some("host".into()),
                    scope_id: Some(host_id),
                    protocol: Some(HOST_CONTROL_LABEL.into()),
                    protocol_version: Some(2),
                },
                pc.local_description().await.unwrap().sdp,
                vec![],
                None,
                false,
                key,
                registry.clone(),
                tx,
                Arc::new(|sdp| Ok(json!({"sdp": sdp}).to_string())),
            )
            .await;
        let mut pending = Vec::new();
        let mut answered = false;
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                tokio::select! {
                    Some(frame) = rx.recv() => {
                        let value: Value = serde_json::from_str(frame.as_str()).unwrap();
                        match value["type"].as_str() {
                            Some("rtc.answer") => {
                                let wire: Value = serde_json::from_str(value["signed_envelope"].as_str().unwrap()).unwrap();
                                pc.set_remote_description(RTCSessionDescription::answer(wire["sdp"].as_str().unwrap().into()).unwrap()).await.unwrap();
                                answered = true;
                                for candidate in pending.drain(..) { pc.add_ice_candidate(candidate).await.unwrap(); }
                            }
                            Some("rtc.candidate") => {
                                let candidate = serde_json::from_value(value["candidate"].clone()).unwrap();
                                if answered { pc.add_ice_candidate(candidate).await.unwrap(); } else { pending.push(candidate); }
                            }
                            Some("rtc.status") => assert_ne!(value["status"], "failed"),
                            _ => {}
                        }
                    }
                    _ = tokio::time::sleep(Duration::from_millis(10)) => {
                        if pc.connection_state() == RTCPeerConnectionState::Connected { break; }
                    }
                }
            }
        }).await.expect("device connection connected");
        pc
    }

    async fn attach(
        pc: &Arc<RTCPeerConnection>,
        session: Uuid,
    ) -> (Arc<RTCDataChannel>, Arc<RTCDataChannel>) {
        let suffix = format!("{session}/{}/{}", Uuid::new_v4(), Uuid::new_v4());
        let pty = pc
            .create_data_channel(&format!("spawn.pty/{suffix}"), None)
            .await
            .unwrap();
        let ctl = pc
            .create_data_channel(&format!("spawn.ctl/{suffix}"), None)
            .await
            .unwrap();
        let (tx, mut rx) = mpsc::channel(64);
        ctl.on_message(Box::new(move |message| {
            let tx = tx.clone();
            Box::pin(async move {
                let _ = tx.send(message.data.to_vec()).await;
            })
        }));
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let frame = rx.recv().await.expect("control event");
                let value: Value = serde_json::from_slice(&frame).unwrap();
                if value["event"] == "ready" {
                    break;
                }
            }
        })
        .await
        .expect("session ready over existing connection");
        (pty, ctl)
    }

    async fn restart_connected_pair(sessions: &RtcSessions, pc: &Arc<RTCPeerConnection>) {
        let (signal_id, peer) = sessions
            .host_peers
            .lock()
            .await
            .iter()
            .next()
            .map(|(id, peer)| (id.clone(), peer.clone()))
            .unwrap();
        let offer = pc
            .create_offer(Some(
                webrtc::peer_connection::offer_answer_options::RTCOfferOptions {
                    ice_restart: true,
                    ..Default::default()
                },
            ))
            .await
            .unwrap();
        let mut gathered = pc.gathering_complete_promise().await;
        pc.set_local_description(offer).await.unwrap();
        gathered.recv().await;
        let (tx, mut rx) = mpsc::channel(128);
        let pair = peer.pair.as_ref().unwrap();
        sessions
            .handle_device_offer(
                HostRtcSignal {
                    signal_id: signal_id.clone(),
                    binding_nonce: Some(peer.binding.binding_nonce.clone()),
                    binding_generation: Some(peer.binding.binding_generation),
                    scope_type: Some("host".into()),
                    scope_id: Some(peer.binding.host_id),
                    protocol: Some(HOST_CONTROL_LABEL.into()),
                    protocol_version: Some(2),
                },
                pc.local_description().await.unwrap().sdp,
                vec![],
                None,
                true,
                pair.device_key,
                pair.registry.clone(),
                tx,
                Arc::new(|sdp| Ok(json!({"sdp": sdp}).to_string())),
            )
            .await;
        let mut answered = false;
        let mut candidates = Vec::new();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                tokio::select! {
                    Some(frame) = rx.recv() => {
                        let value: Value = serde_json::from_str(frame.as_str()).unwrap();
                        match value["type"].as_str() {
                            Some("rtc.answer") => {
                                assert_eq!(value["protocol_version"], 2);
                                let wire: Value = serde_json::from_str(value["signed_envelope"].as_str().unwrap()).unwrap();
                                pc.set_remote_description(RTCSessionDescription::answer(wire["sdp"].as_str().unwrap().into()).unwrap()).await.unwrap();
                                answered = true;
                                for candidate in candidates.drain(..) { pc.add_ice_candidate(candidate).await.unwrap(); }
                            }
                            Some("rtc.candidate") => {
                                let candidate = serde_json::from_value(value["candidate"].clone()).unwrap();
                                if answered { pc.add_ice_candidate(candidate).await.unwrap(); } else { candidates.push(candidate); }
                            }
                            Some("rtc.status") => assert_ne!(value["status"], "failed"),
                            _ => {}
                        }
                    }
                    _ = tokio::time::sleep(Duration::from_millis(10)) => {
                        if answered && pc.connection_state() == RTCPeerConnectionState::Connected { break; }
                    }
                }
            }
        }).await.expect("existing device peer recovers with fresh ICE credentials");
        assert_eq!(sessions.host_peers.lock().await.len(), 1);
        assert!(Arc::ptr_eq(
            &sessions.host_peers.lock().await[&signal_id].pc,
            &peer.pc
        ));
    }

    #[tokio::test]
    async fn multiple_sessions_share_one_peer_and_teardown_is_local() {
        if std::env::var_os("SPAWND_RTC_TEST_TRACE").is_some() {
            let _ = tracing_subscriber::fmt()
                .with_env_filter(
                    "spawnd::rtc=debug,webrtc=debug,webrtc_sctp=debug,webrtc_data=debug",
                )
                .with_test_writer()
                .try_init();
        }
        let sessions = RtcSessions::new();
        sessions.bind_registered_host_id(Uuid::new_v4()).await;
        let registry = SessionRegistry::new();
        let mut workers = Vec::new();
        let (input_tx, mut input_rx) = mpsc::unbounded_channel();
        let ids = [Uuid::new_v4(), Uuid::new_v4()];
        for id in ids {
            let (binding, mut commands) = crate::rtc::tests::insert_test_worker(&registry, id);
            let control = registry.control_for_binding(binding).unwrap();
            let tx = input_tx.clone();
            workers.push(tokio::spawn(async move {
                while let Some(command) = commands.recv().await {
                    match command {
                        crate::pty::WorkerCmd::Replay { resp, .. } => {
                            let _ = resp.send(Ok(crate::pty::WorkerReplay::new(
                                control.source_offset(),
                                vec![],
                            )));
                        }
                        crate::pty::WorkerCmd::Input(bytes) => {
                            let _ = tx.send((id, bytes.to_vec()));
                        }
                        _ => {}
                    }
                }
            }));
        }
        let pc = connect_pair(&sessions, &registry, [1; 32]).await;
        let (first, first_ctl) = attach(&pc, ids[0]).await;
        let (second, _second_ctl) = attach(&pc, ids[1]).await;
        assert_eq!(sessions.host_peers.lock().await.len(), 1);
        assert_eq!(sessions.peers.lock().await.len(), 2);
        assert_eq!(sessions.peer_admission.charged(), 1);
        assert_eq!(
            sessions.live_bindings().await.len(),
            1,
            "attachments never become signalling routes"
        );
        first.send(&Bytes::from_static(b"first")).await.unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), input_rx.recv())
                .await
                .unwrap()
                .unwrap(),
            (ids[0], b"first".to_vec())
        );
        first_ctl.close().await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while sessions.peers.lock().await.len() != 1 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("only the first attachment retires");
        assert_eq!(pc.connection_state(), RTCPeerConnectionState::Connected);
        second.send(&Bytes::from_static(b"second")).await.unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), input_rx.recv())
                .await
                .unwrap()
                .unwrap(),
            (ids[1], b"second".to_vec())
        );
        // A separate authenticated device may watch, but focus and input must
        // not acquire the existing device's lease. Only an explicit take does.
        restart_connected_pair(&sessions, &pc).await;
        second
            .send(&Bytes::from_static(b"after ICE restart"))
            .await
            .unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), input_rx.recv())
                .await
                .unwrap()
                .unwrap(),
            (ids[1], b"after ICE restart".to_vec())
        );
        let observer = connect_pair(&sessions, &registry, [2; 32]).await;
        let (observer_pty, observer_ctl) = attach(&observer, ids[1]).await;
        let (events_tx, mut events_rx) = mpsc::unbounded_channel();
        observer_ctl.on_message(Box::new(move |message| {
            let events_tx = events_tx.clone();
            Box::pin(async move {
                if let Ok(value) = serde_json::from_slice::<Value>(&message.data) {
                    let _ = events_tx.send(value);
                }
            })
        }));
        let focus_id = Uuid::new_v4();
        observer_ctl
            .send_text(
                serde_json::json!({
                    "version": 1, "kind": "request", "request_id": focus_id,
                    "operation": "focus_view", "cols": 100, "rows": 30,
                })
                .to_string(),
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let event = events_rx.recv().await.unwrap();
                if event["request_id"] == focus_id.to_string() {
                    assert_eq!(event["error"]["code"], "not_display_owner");
                    break;
                }
            }
        })
        .await
        .unwrap();
        observer_pty
            .send(&Bytes::from_static(b"denied"))
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(150), input_rx.recv())
                .await
                .is_err()
        );
        observer_ctl
            .send_text(
                serde_json::json!({
                    "version": 1, "kind": "request", "request_id": Uuid::new_v4(),
                    "operation": "take_control", "cols": 100, "rows": 30,
                })
                .to_string(),
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let event = events_rx.recv().await.unwrap();
                if event["event"] == "display_state" && event["owner"] == true {
                    break;
                }
            }
        })
        .await
        .unwrap();
        observer_pty
            .send(&Bytes::from_static(b"explicit control"))
            .await
            .unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), input_rx.recv())
                .await
                .unwrap()
                .unwrap(),
            (ids[1], b"explicit control".to_vec())
        );
        second
            .send(&Bytes::from_static(b"former owner"))
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(150), input_rx.recv())
                .await
                .is_err()
        );
        let missing = pc
            .create_data_channel(
                &format!(
                    "spawn.pty/{}/{}/{}",
                    Uuid::new_v4(),
                    Uuid::new_v4(),
                    Uuid::new_v4()
                ),
                None,
            )
            .await
            .unwrap();
        let refused = tokio::time::timeout(Duration::from_secs(3), async {
            while missing.ready_state() != RTCDataChannelState::Closed {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        if refused.is_err() {
            eprintln!(
                "unknown session channel {} is {:?}; client peer is {:?}",
                missing.id(),
                missing.ready_state(),
                pc.connection_state()
            );
            let peers = sessions
                .host_peers
                .lock()
                .await
                .values()
                .cloned()
                .collect::<Vec<_>>();
            for peer in peers {
                eprintln!("daemon peer state: {:?}", peer.pc.connection_state());
                for report in peer.pc.get_stats().await.reports.values() {
                    if let webrtc::stats::StatsReportType::DataChannel(channel) = report {
                        eprintln!("daemon channel: {channel:?}");
                    }
                }
            }
            let late_started = std::time::Instant::now();
            let late = tokio::time::timeout(Duration::from_secs(10), async {
                while missing.ready_state() != RTCDataChannelState::Closed {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await;
            eprintln!(
                "closure after the failed deadline: {late:?}, extra wait {:?}, state {:?}",
                late_started.elapsed(),
                missing.ready_state()
            );
        }
        refused.expect("unknown local session refused");
        assert_eq!(pc.connection_state(), RTCPeerConnectionState::Connected);
        sessions.invalidate_trust_and_close_all().await;
        assert!(sessions.peers.lock().await.is_empty());
        assert!(sessions.host_peers.lock().await.is_empty());
        let _ = pc.close().await;
        let _ = observer.close().await;
        for worker in workers {
            worker.abort();
        }
    }

    #[tokio::test]
    async fn device_handover_replaces_only_the_same_device_connection() {
        let sessions = RtcSessions::new();
        sessions.bind_registered_host_id(Uuid::new_v4()).await;
        let registry = SessionRegistry::new();
        let first = connect_pair(&sessions, &registry, [1; 32]).await;
        let other = connect_pair(&sessions, &registry, [2; 32]).await;
        let successor = connect_pair(&sessions, &registry, [1; 32]).await;
        assert_eq!(sessions.host_peers.lock().await.len(), 2);
        assert_eq!(other.connection_state(), RTCPeerConnectionState::Connected);
        assert_eq!(
            successor.connection_state(),
            RTCPeerConnectionState::Connected
        );
        sessions.close_all().await;
        for pc in [first, other, successor] {
            let _ = pc.close().await;
        }
    }
    #[tokio::test]
    async fn parent_retirement_fences_host_consumers_before_blocked_terminal_cleanup() {
        let sessions = RtcSessions::new();
        sessions.bind_registered_host_id(Uuid::new_v4()).await;
        let registry = SessionRegistry::new();
        let id = Uuid::new_v4();
        let (binding, mut commands) = crate::rtc::tests::insert_test_worker(&registry, id);
        let control = registry.control_for_binding(binding).unwrap();
        let worker = tokio::spawn(async move {
            while let Some(command) = commands.recv().await {
                if let crate::pty::WorkerCmd::Replay { resp, .. } = command {
                    let _ = resp.send(Ok(crate::pty::WorkerReplay::new(
                        control.source_offset(),
                        vec![],
                    )));
                }
            }
        });
        let pc = connect_pair(&sessions, &registry, [7; 32]).await;
        // connect_pair's signaling receiver has gone away; install a live sink.
        let (signal_tx, mut signal_rx) = mpsc::channel(128);
        sessions.signaling.install(signal_tx);
        let signal_sink = tokio::spawn(async move { while signal_rx.recv().await.is_some() {} });
        let (_pty, _ctl) = attach(&pc, id).await;
        let host = pc
            .create_data_channel(&format!("spawn.host.ctl/{}", Uuid::new_v4()), None)
            .await
            .unwrap();
        let (tx, mut rx) = mpsc::channel(64);
        host.on_message(Box::new(move |message| {
            let tx = tx.clone();
            Box::pin(async move {
                let _ = tx
                    .send(serde_json::from_slice::<Value>(&message.data).unwrap())
                    .await;
            })
        }));
        let hello = tokio::time::timeout(Duration::from_secs(3), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(hello["type"], "hello");
        let closer = sessions.session_closer(binding).await;
        let guard = closer.lock().await;
        let retire_sessions = sessions.clone();
        let retiring = tokio::spawn(async move {
            retire_sessions.retire_device_pair([7; 32]).await;
        });
        tokio::time::timeout(Duration::from_secs(3), async {
            while !sessions.host_peers.lock().await.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(!retiring.is_finished());
        host.send_text(json!({"version":1,"type":"request","request_id":"after-retire","operation":"fs.home","payload":{}}).to_string()).await.unwrap();
        let response = tokio::time::timeout(Duration::from_millis(200), rx.recv()).await;
        drop(guard);
        retiring.await.unwrap();
        let _ = pc.close().await;
        worker.abort();
        signal_sink.abort();
        assert!(
            response.is_err(),
            "retired parent published a host response: {response:?}"
        );
    }
}
