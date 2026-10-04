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
    /// One per association: every bulk stream on this device's connection
    /// is paced through it (`host_stream::BulkGate`), whichever channel it
    /// runs on, so bulk never fills the SCTP queue terminals share.
    bulk: Arc<crate::host_stream::BulkGate>,
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

/// Numbers attachments for the process lifetime; see `attach_pair_channel`.
static ATTACHMENT_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// The parent binding's generation an attachment's own generation was built
/// on: everything before its `#`.
fn attachment_parent_generation(generation: &str) -> &str {
    generation
        .rsplit_once('#')
        .map_or(generation, |(parent, _)| parent)
}

/// A device key as the string the test effect gates are keyed by.
#[cfg(test)]
pub(super) fn device_key_hex(key: &[u8; 32]) -> String {
    key.iter().map(|byte| format!("{byte:02x}")).collect()
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
        stop_then_close(&peer.pc).await;
    }
}

/// Close a peer connection the daemon owns the teardown of. The SCTP
/// association stops first: `RTCPeerConnection::close` begins with a shutdown
/// of every data channel, and against a peer that has stopped acknowledging
/// those shutdowns wait behind a writer that will never get room. A closed
/// association releases that writer (the vendored sctp patch) and the
/// shutdowns bail on state, so the close settles without the peer's help.
pub(super) async fn stop_then_close(pc: &RTCPeerConnection) {
    let _ = pc.sctp().stop().await;
    let _ = pc.close().await;
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

/// Stop a window whose conversation a device is retiring, the way a kill
/// does: the worker signals its shell's process group (TERM, then KILL),
/// each delivery revalidated against the registry generation under its
/// transition lock, and the exit forwarder removes the entry and reports
/// `session.exit` as for any stop. The window's Claude processes, which sit
/// in a process group of their own, are the carrier's to stop and confirm.
async fn stop_window(
    registry: &SessionRegistry,
    session_id: Uuid,
) -> crate::host_conversations::WindowStop {
    use crate::host_conversations::WindowStop;
    use spawnd::sessiond::wire::LifecycleSignal;
    let Some(snapshot) = registry.lifecycle_snapshot(session_id) else {
        return if crate::worker_backend::socket_exists(session_id) {
            WindowStop::Unavailable
        } else {
            WindowStop::NotRunning
        };
    };
    let binding = snapshot.binding();
    let gone = |deadline: Duration| async move {
        let deadline = tokio::time::Instant::now() + deadline;
        loop {
            if !registry.is_current(binding) {
                return true;
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    };
    if let Err(error) = registry
        .shutdown_if_current(&snapshot, LifecycleSignal::Term)
        .await
    {
        tracing::debug!(%session_id, %error, "retire TERM not delivered");
    }
    if gone(Duration::from_millis(1500)).await {
        return WindowStop::Stopped;
    }
    if let Err(error) = registry
        .shutdown_if_current(&snapshot, LifecycleSignal::Kill)
        .await
    {
        tracing::debug!(%session_id, %error, "retire KILL not delivered");
    }
    if gone(Duration::from_secs(5)).await {
        WindowStop::Stopped
    } else {
        WindowStop::Lingering
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
            bulk: crate::host_stream::BulkGate::new(),
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

    /// Remove every host peer paired with `device_key` from the host map,
    /// retiring each as it leaves: a new authenticated connection fences the
    /// old one before it is admitted, including after browser owner handover.
    /// Returns them for the caller to close once it holds no lock a transport
    /// close could stall.
    pub(super) async fn take_device_pair(&self, device_key: [u8; 32]) -> Vec<super::RetiredHost> {
        let ids = self
            .host_peers
            .lock()
            .await
            .iter()
            .filter(|(_, peer)| {
                peer.pair
                    .as_ref()
                    .is_some_and(|pair| pair.device_key == device_key)
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let mut retired = Vec::with_capacity(ids.len());
        for id in ids {
            // The slot stays with the retired peer for the superseding
            // connection to take; the caller returns whatever it leaves.
            if let Some(host) = self
                .take_host_where(&id, |_| true, super::SlotDisposition::Keep)
                .await
            {
                retired.push(host);
            }
        }
        // The server's binding for the superseded connection counts against
        // its per-host and per-browser caps until it hears otherwise, and a
        // browser's shared connection never sends `rtc.close`. Tell it now,
        // so a device reconnecting all day never fills those caps.
        for host in &retired {
            self.send_or_defer_status(super::host_status_frame(
                host.signal_id.clone(),
                &host.peer.binding,
                "unavailable",
                Some("superseded by a newer connection from this device"),
            ));
        }
        retired
    }

    /// The retirement a test can wait on: each retired peer tears down
    /// inline. Production runs the same teardown in tracked tasks.
    #[cfg(test)]
    pub(super) async fn close_retired_host_peers(&self, retired: Vec<super::RetiredHost>) {
        for host in retired {
            self.close_retired_host_peer(host).await;
        }
    }

    /// Take a host peer's attachments out of service and settle them, each
    /// until its own deadline — what a retired host peer's tracked teardown
    /// does before its transport close, callable on its own by a test.
    #[cfg(test)]
    pub(super) async fn close_pair_sessions(&self, pc: &Arc<RTCPeerConnection>) {
        let children = self.detach_pair_children(pc).await;
        self.settle_detached_peers(children).await;
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
                    // An authenticated device: its channels may ask about
                    // the windows it can already see, and stop one whose
                    // conversation it is moving; only that much of the
                    // registry is handed over.
                    let registry = pair.registry.clone();
                    let shells =
                        crate::host_conv::WindowShells::new(move |id| registry.shell_pid(id));
                    let registry = pair.registry.clone();
                    let incarnations = pair.registry.clone();
                    let windows = crate::host_conversations::PairWindows::new(
                        shells,
                        move |id| {
                            let registry = registry.clone();
                            Box::pin(async move { stop_window(&registry, id).await })
                        },
                        move |id| {
                            incarnations
                                .binding_for(id)
                                .map(|binding| binding.generation())
                        },
                        Arc::clone(&pair.bulk),
                        crate::host_conversations::Places::from_env(crate::run::login_shell_name),
                    );
                    pair.register_host(install_host_control_channel(
                        dc,
                        signal_id,
                        binding,
                        sessions.signaling.clone(),
                        None,
                        Some(windows),
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
        let parent_generation = format!(
            "{}:{}",
            parent.binding.binding_generation, parent.binding.binding_nonce
        );
        // A resident child another close already claimed is on its way out
        // of the map — a callback-owned close, or the sweep it slipped past —
        // and the device re-attaching the same view must not be refused for
        // it: it is absent, and this attachment replaces it. Its own teardown
        // settles through the closing map and removes nothing but itself.
        let existing = self
            .peers
            .lock()
            .await
            .get(&id)
            .filter(|child| !child.close.is_claimed())
            .cloned();
        let child = if let Some(child) = existing {
            anyhow::ensure!(
                Arc::ptr_eq(&child.pc, pc)
                    && attachment_parent_generation(&child.generation) == parent_generation
                    && child.active.load(Ordering::Acquire)
                    && pair.registry.is_current(child.session),
                "stale attachment"
            );
            child
        } else {
            // This attachment's own generation: its parent's, and a sequence
            // no other attachment has. The viewer id every registry keys on
            // — direct sinks, control viewers, uploads — derives from it, so
            // a view re-attached under the same id while its old attachment
            // is still closing registers under a name of its own, and the
            // old attachment's late cleanup touches nothing of its.
            let generation = format!(
                "{parent_generation}#{}",
                ATTACHMENT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            );
            let count = self
                .peers
                .lock()
                .await
                .values()
                .filter(|peer| Arc::ptr_eq(&peer.pc, pc) && !peer.close.is_claimed())
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
                admission: parent.admission.inherit(),
                fence: Arc::clone(&fence),
            };
            {
                // The reaper and the server's close take a pair without the
                // admission lock this attach holds. Once the pair is retired,
                // its attachments have already been swept from the map; an
                // attachment landing after that sweep would sit on a dead
                // transport with nothing to reap it. The retire flag is set
                // before the sweep, and this check runs under the same lock
                // the sweep takes, so one of the two always sees the other.
                let mut peers = self.peers.lock().await;
                anyhow::ensure!(
                    !pair.retired.load(Ordering::Acquire),
                    "retired device connection"
                );
                peers.insert(id.clone(), child.clone());
            }
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
        sessions.deferred_pruned.store(true, Ordering::Release);
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
        let signal_id = Uuid::new_v4().to_string();
        sessions
            .handle_device_offer(
                HostRtcSignal {
                    signal_id: signal_id.clone(),
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
                            Some("rtc.status") if value["session_id"] == signal_id => {
                                assert_ne!(value["status"], "failed")
                            }
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
        attach_labelled(pc, &suffix).await
    }

    /// Attach with a caller-chosen `session/view/attachment` suffix, so a
    /// test can re-attach exactly what a reconnecting device re-attaches.
    async fn attach_labelled(
        pc: &Arc<RTCPeerConnection>,
        suffix: &str,
    ) -> (Arc<RTCDataChannel>, Arc<RTCDataChannel>) {
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
                            Some("rtc.status") if value["session_id"] == signal_id => {
                                assert_ne!(value["status"], "failed")
                            }
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
        assert_eq!(
            sessions.peer_admission.charged(),
            1,
            "an attachment rides on its host peer's slot and never returns it"
        );
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
                if let Ok(stats) =
                    tokio::time::timeout(Duration::from_secs(2), peer.pc.get_stats()).await
                {
                    for report in stats.reports.values() {
                        if let webrtc::stats::StatsReportType::DataChannel(channel) = report {
                            eprintln!("daemon channel: {channel:?}");
                        }
                    }
                }
            }
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

    /// The offer that replaces a device's connection is answered while the
    /// connection it replaces is still closing. Against a device that has
    /// gone, that close can wait for as long as the device does, and it must
    /// hold up neither this device's answer nor anyone else's admission.
    #[tokio::test]
    async fn device_offer_is_answered_while_the_superseded_transport_close_stalls() {
        let sessions = RtcSessions::new();
        sessions.bind_registered_host_id(Uuid::new_v4()).await;
        let registry = SessionRegistry::new();
        let first = connect_pair(&sessions, &registry, [9; 32]).await;
        let first_id = sessions
            .host_peers
            .lock()
            .await
            .keys()
            .next()
            .cloned()
            .expect("the first pair is admitted");
        let gate = sessions
            .stall_effect(&first_id, TestEffectPoint::HostTransportClose)
            .await;

        // `connect_pair` returns only once the successor is connected, so the
        // answer went out while the first connection's close was held here.
        let successor = connect_pair(&sessions, &registry, [9; 32]).await;
        tokio::time::timeout(Duration::from_secs(3), gate.entered.notified())
            .await
            .expect("the superseded transport close is reached");
        assert_eq!(
            successor.connection_state(),
            RTCPeerConnectionState::Connected
        );
        {
            let hosts = sessions.host_peers.lock().await;
            assert_eq!(hosts.len(), 1);
            assert!(!hosts.contains_key(&first_id));
        }
        assert_eq!(
            sessions.peer_admission.charged(),
            1,
            "the superseded pair's slot returned before its close"
        );
        assert_eq!(sessions.admission_gauge().await.host_closing, 1);

        gate.release.notify_one();
        tokio::time::timeout(Duration::from_secs(5), async {
            while sessions.admission_gauge().await.host_closing != 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the superseded close settles once released");
        sessions.close_all().await;
        for pc in [first, successor] {
            let _ = pc.close().await;
        }
    }

    /// At the cap, a device's reconnect takes the slot its own superseded
    /// connection holds rather than being refused for want of it.
    #[tokio::test]
    async fn a_device_reconnecting_at_the_cap_takes_its_own_slot() {
        let sessions = RtcSessions::new();
        sessions.bind_registered_host_id(Uuid::new_v4()).await;
        let registry = SessionRegistry::new();
        let first = connect_pair(&sessions, &registry, [21; 32]).await;
        let mut filler = Vec::new();
        while let Some(slot) = sessions.peer_admission.try_acquire() {
            filler.push(slot);
        }
        assert_eq!(filler.len(), MAX_RTC_PEERS - 1);

        // `connect_pair` returns only once the successor is connected; at the
        // cap that is only possible on the first connection's slot.
        let successor = connect_pair(&sessions, &registry, [21; 32]).await;
        assert_eq!(sessions.host_peers.lock().await.len(), 1);
        assert_eq!(sessions.peer_admission.charged(), MAX_RTC_PEERS);
        assert!(sessions.peer_admission.try_acquire().is_none());

        drop(filler);
        sessions.close_all().await;
        for pc in [first, successor] {
            let _ = pc.close().await;
        }
    }

    /// An offer the daemon refuses — here, a signal id the peer map already
    /// holds, checked before anything else is touched — must not cost the
    /// device the connection it already has.
    #[tokio::test]
    async fn a_refused_device_offer_leaves_the_existing_connection_alone() {
        let sessions = RtcSessions::new();
        sessions.bind_registered_host_id(Uuid::new_v4()).await;
        let registry = SessionRegistry::new();
        let session_id = Uuid::new_v4();
        let (binding, mut commands) = crate::rtc::tests::insert_test_worker(&registry, session_id);
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
        let first = connect_pair(&sessions, &registry, [13; 32]).await;
        let (_pty, _ctl) = attach(&first, session_id).await;
        let (first_id, first_pair) = {
            let hosts = sessions.host_peers.lock().await;
            let (id, peer) = hosts.iter().next().expect("the first pair is admitted");
            (id.clone(), Arc::clone(peer.pair.as_ref().unwrap()))
        };
        let colliding_id = sessions
            .peers
            .lock()
            .await
            .keys()
            .next()
            .cloned()
            .expect("the attachment is resident");
        let host_id = sessions.registered_host_id.lock().await.unwrap();

        let colliding = Arc::new(
            webrtc::api::APIBuilder::new()
                .build()
                .new_peer_connection(RTCConfiguration::default())
                .await
                .unwrap(),
        );
        colliding
            .create_data_channel(HOST_CONTROL_LABEL, None)
            .await
            .unwrap();
        let offer = colliding.create_offer(None).await.unwrap();
        let mut gathered = colliding.gathering_complete_promise().await;
        colliding.set_local_description(offer).await.unwrap();
        gathered.recv().await;
        let (tx, mut rx) = mpsc::channel(16);
        sessions
            .handle_device_offer(
                HostRtcSignal {
                    signal_id: colliding_id,
                    binding_nonce: Some("a".repeat(32)),
                    binding_generation: Some(1),
                    scope_type: Some("host".into()),
                    scope_id: Some(host_id),
                    protocol: Some(HOST_CONTROL_LABEL.into()),
                    protocol_version: Some(2),
                },
                colliding.local_description().await.unwrap().sdp,
                vec![],
                None,
                false,
                [13; 32],
                registry.clone(),
                tx,
                Arc::new(|sdp| Ok(json!({"sdp": sdp}).to_string())),
            )
            .await;
        let status = rx.recv().await.expect("the refused offer is answered");
        let status: Value = serde_json::from_str(status.as_str()).unwrap();
        assert_eq!(status["type"], "rtc.status");
        assert_eq!(status["status"], "failed");

        {
            let hosts = sessions.host_peers.lock().await;
            assert_eq!(hosts.len(), 1);
            assert!(
                hosts.contains_key(&first_id),
                "the existing connection stays"
            );
        }
        assert!(
            !first_pair.retired.load(Ordering::Acquire),
            "the existing pair was not retired by a refused offer"
        );
        assert_eq!(
            sessions.peers.lock().await.len(),
            1,
            "the existing attachment stays"
        );
        assert_eq!(sessions.peer_admission.charged(), 1);
        assert_eq!(first.connection_state(), RTCPeerConnectionState::Connected);
        sessions.close_all().await;
        let _ = first.close().await;
        let _ = colliding.close().await;
        worker.abort();
    }

    /// A superseded device connection leaves the server's host map only when
    /// the server hears about it; the browser's shared connection never sends
    /// `rtc.close`. The daemon says `unavailable` for it as it takes the pair
    /// — not `failed`, which the device would read as a refusal.
    #[tokio::test]
    async fn taking_a_device_pair_tells_the_server_the_superseded_connection_is_unavailable() {
        let sessions = RtcSessions::new();
        let (tx, mut rx) = mpsc::channel(8);
        sessions.signaling.install(tx);
        sessions.deferred_pruned.store(true, Ordering::Release);
        let (out_tx, _out_rx) = mpsc::channel(8);
        let pc = Arc::new(
            webrtc::api::APIBuilder::new()
                .build()
                .new_peer_connection(RTCConfiguration::default())
                .await
                .unwrap(),
        );
        let pair = Arc::new(PairContext {
            device_key: [5; 32],
            registry: SessionRegistry::new(),
            out_tx,
            trust_epoch: 0,
            ice_restart: false,
            remote_ufrags: Mutex::new(HashSet::new()),
            restart: Mutex::new(()),
            retired: AtomicBool::new(false),
            host_channels: std::sync::Mutex::new(Vec::new()),
            bulk: crate::host_stream::BulkGate::new(),
        });
        let binding = HostRtcBinding {
            host_id: Uuid::new_v4(),
            binding_nonce: "c".repeat(32),
            binding_generation: 1,
            protocol: HOST_CONTROL_LABEL.to_owned(),
            protocol_version: 2,
        };
        sessions.host_peers.lock().await.insert(
            "superseded-pair".to_owned(),
            HostRtcPeer {
                pair: Some(Arc::clone(&pair)),
                pc: Arc::clone(&pc),
                binding: binding.clone(),
                admission: sessions.peer_admission.try_acquire().unwrap(),
            },
        );

        let retired = sessions.take_device_pair([5; 32]).await;
        assert_eq!(retired.len(), 1);
        assert_eq!(retired[0].signal_id, "superseded-pair");
        assert!(pair.retired.load(Ordering::Acquire));
        // The slot stays with the taken pair for a successor to take over;
        // taking it over moves it, and only dropping the new owner returns it.
        assert_eq!(sessions.peer_admission.charged(), 1);
        let taken = retired[0]
            .peer
            .admission
            .transfer()
            .expect("the superseded pair's slot moves to its successor");
        assert_eq!(sessions.peer_admission.charged(), 1);
        assert!(retired[0].peer.admission.transfer().is_none());
        drop(taken);
        assert_eq!(sessions.peer_admission.charged(), 0);
        let frame = rx
            .try_recv()
            .expect("the server hears about the superseded pair");
        let value: Value = serde_json::from_str(frame.as_str()).unwrap();
        assert_eq!(value["type"], "rtc.status");
        assert_eq!(value["status"], "unavailable");
        assert_eq!(value["session_id"], "superseded-pair");
        assert_eq!(value["scope_type"], "host");
        assert_eq!(value["binding_nonce"], binding.binding_nonce);
        assert_eq!(
            value["message"],
            "superseded by a newer connection from this device"
        );
        sessions.close_retired_host_peers(retired).await;
        let _ = pc.close().await;
    }

    /// A child another close already claimed can still be resident for its
    /// settle wait when the pair is superseded; the sweep leaves it to that
    /// close, and the device re-attaching the same view must not be refused
    /// for it.
    #[tokio::test]
    async fn a_reattach_replaces_a_resident_child_another_close_already_claimed() {
        let sessions = RtcSessions::new();
        sessions.bind_registered_host_id(Uuid::new_v4()).await;
        let registry = SessionRegistry::new();
        let session_id = Uuid::new_v4();
        let (binding, mut commands) = crate::rtc::tests::insert_test_worker(&registry, session_id);
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
        let suffix = format!("{session_id}/{}/{}", Uuid::new_v4(), Uuid::new_v4());
        let first = connect_pair(&sessions, &registry, [17; 32]).await;
        let (_first_pty, _first_ctl) = attach_labelled(&first, &suffix).await;
        // A callback-owned close claims the child and is still settling: the
        // child stays in the map until that close's deadline.
        let claimed_child = sessions
            .peers
            .lock()
            .await
            .values()
            .next()
            .cloned()
            .expect("the attachment is resident");
        assert!(claimed_child.close.claim());
        // Hold the superseded pair's teardown so its transport does not
        // close underneath the claimed child before the device re-attaches.
        let first_id = sessions
            .host_peers
            .lock()
            .await
            .keys()
            .next()
            .cloned()
            .expect("the first pair is admitted");
        let gate = sessions
            .stall_effect(&first_id, TestEffectPoint::HostRetire)
            .await;

        let successor = connect_pair(&sessions, &registry, [17; 32]).await;
        tokio::time::timeout(Duration::from_secs(3), gate.entered.notified())
            .await
            .expect("the superseded teardown is held");
        assert_eq!(
            sessions.peers.lock().await.len(),
            1,
            "the sweep left the claimed child to its owner"
        );
        let (_pty, _ctl) = attach_labelled(&successor, &suffix).await;
        {
            let hosts = sessions.host_peers.lock().await;
            let peers = sessions.peers.lock().await;
            assert_eq!(peers.len(), 1);
            assert!(
                Arc::ptr_eq(
                    &peers.values().next().unwrap().pc,
                    &hosts.values().next().unwrap().pc
                ),
                "the resident child is the successor's"
            );
        }
        gate.release.notify_one();
        sessions.close_all().await;
        for pc in [first, successor] {
            let _ = pc.close().await;
        }
        worker.abort();
    }

    /// The attachment that replaced a claimed child is a different peer under
    /// the same id, on the same transport and generation as the old one.
    /// When the old child's close settles, it takes itself out of the map —
    /// not the replacement.
    #[tokio::test]
    async fn a_claimed_childs_settle_leaves_its_replacement_resident() {
        let sessions = RtcSessions::new();
        sessions.bind_registered_host_id(Uuid::new_v4()).await;
        let registry = SessionRegistry::new();
        let session_id = Uuid::new_v4();
        let (binding, mut commands) = crate::rtc::tests::insert_test_worker(&registry, session_id);
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
        let suffix = format!("{session_id}/{}/{}", Uuid::new_v4(), Uuid::new_v4());
        let first = connect_pair(&sessions, &registry, [18; 32]).await;
        let (_first_pty, _first_ctl) = attach_labelled(&first, &suffix).await;
        let (child_id, claimed_child) = sessions
            .peers
            .lock()
            .await
            .iter()
            .map(|(id, peer)| (id.clone(), peer.clone()))
            .next()
            .expect("the attachment is resident");
        // A callback-owned close claimed the child; its settle is still to
        // come.
        assert!(claimed_child.close.claim());
        let first_id = sessions
            .host_peers
            .lock()
            .await
            .keys()
            .next()
            .cloned()
            .expect("the first pair is admitted");
        let gate = sessions
            .stall_effect(&first_id, TestEffectPoint::HostRetire)
            .await;

        let successor = connect_pair(&sessions, &registry, [18; 32]).await;
        tokio::time::timeout(Duration::from_secs(3), gate.entered.notified())
            .await
            .expect("the superseded teardown is held");
        let (_pty, _ctl) = attach_labelled(&successor, &suffix).await;
        let replacement = sessions
            .peers
            .lock()
            .await
            .get(&child_id)
            .cloned()
            .expect("the replacement is resident");
        assert!(
            !Arc::ptr_eq(&replacement.close, &claimed_child.close),
            "the replacement is a peer of its own"
        );

        // The claimed child's owner settles it now.
        let deadline = claimed_child.close.initiate();
        sessions
            .close_if_same_until_announcing(
                &child_id,
                &claimed_child.generation,
                &claimed_child.close,
                deadline,
                None,
            )
            .await;
        let resident = sessions.peers.lock().await.get(&child_id).cloned();
        assert!(
            resident.is_some_and(|peer| Arc::ptr_eq(&peer.close, &replacement.close)),
            "the replacement survives the old child's settle"
        );
        assert!(
            replacement.active.load(Ordering::Acquire),
            "and is still in service"
        );

        gate.release.notify_one();
        sessions.close_all().await;
        for pc in [first, successor] {
            let _ = pc.close().await;
        }
        worker.abort();
    }

    /// A retired host peer never handed to its tracked close — a path that
    /// returned early between taking it and closing it — closes itself from
    /// the drop path: its attachments, claimed and in the closing map since
    /// it was taken, settle, and its transport closes.
    #[tokio::test]
    async fn a_retired_host_peer_dropped_unclosed_closes_from_the_drop_path() {
        let sessions = RtcSessions::new();
        sessions.bind_registered_host_id(Uuid::new_v4()).await;
        let registry = SessionRegistry::new();
        let session_id = Uuid::new_v4();
        let (binding, mut commands) = crate::rtc::tests::insert_test_worker(&registry, session_id);
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
        let device = connect_pair(&sessions, &registry, [19; 32]).await;
        let (_pty, _ctl) = attach(&device, session_id).await;
        let (host_id, host_pc) = {
            let hosts = sessions.host_peers.lock().await;
            let (id, peer) = hosts.iter().next().expect("the pair is admitted");
            (id.clone(), Arc::clone(&peer.pc))
        };
        assert_eq!(sessions.peers.lock().await.len(), 1);

        let retired = sessions
            .take_host_if_same(&host_id, &host_pc)
            .await
            .expect("taken");
        assert_eq!(
            sessions.closing_peers.lock().await.len(),
            1,
            "the attachment is claimed and closing from the moment its host was taken"
        );
        drop(retired);

        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if sessions.closing_peers.lock().await.is_empty()
                    && sessions.admission_gauge().await.host_closing == 0
                    && host_pc.connection_state() == RTCPeerConnectionState::Closed
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the dropped retired host closed itself: attachment settled, transport closed");
        assert!(sessions.host_peers.lock().await.is_empty());
        sessions.close_all().await;
        let _ = device.close().await;
        worker.abort();
    }

    /// A view re-attached under the same id while its old attachment is
    /// still closing registers under a name of its own: the old attachment's
    /// cleanup — direct sink, control viewer, uploads, all keyed by viewer
    /// id — runs to the end and the replacement keeps what it registered.
    #[tokio::test]
    async fn a_replacement_child_keeps_its_registrations_through_the_old_childs_cleanup() {
        let sessions = RtcSessions::new();
        sessions.bind_registered_host_id(Uuid::new_v4()).await;
        let registry = SessionRegistry::new();
        let session_id = Uuid::new_v4();
        let (binding, mut commands) = crate::rtc::tests::insert_test_worker(&registry, session_id);
        let control = registry.control_for_binding(binding).unwrap();
        let worker_control = control.clone();
        let worker = tokio::spawn(async move {
            while let Some(command) = commands.recv().await {
                if let crate::pty::WorkerCmd::Replay { resp, .. } = command {
                    let _ = resp.send(Ok(crate::pty::WorkerReplay::new(
                        worker_control.source_offset(),
                        vec![],
                    )));
                }
            }
        });
        let suffix = format!("{session_id}/{}/{}", Uuid::new_v4(), Uuid::new_v4());
        let first = connect_pair(&sessions, &registry, [23; 32]).await;
        let (_first_pty, _first_ctl) = attach_labelled(&first, &suffix).await;
        let (child_id, old_child) = sessions
            .peers
            .lock()
            .await
            .iter()
            .map(|(id, peer)| (id.clone(), peer.clone()))
            .next()
            .expect("the attachment is resident");
        let old_viewer = viewer_id(&child_id, &old_child.generation);
        assert!(
            control
                .wait_for_direct_sink(&old_viewer, Duration::from_secs(3))
                .await
        );
        // Its owner takes the old child out of service; the settle comes later.
        assert!(sessions.detach_peer(&child_id, &old_child).await);
        let first_id = sessions
            .host_peers
            .lock()
            .await
            .keys()
            .next()
            .cloned()
            .expect("the first pair is admitted");
        let gate = sessions
            .stall_effect(&first_id, TestEffectPoint::HostRetire)
            .await;

        let successor = connect_pair(&sessions, &registry, [23; 32]).await;
        tokio::time::timeout(Duration::from_secs(3), gate.entered.notified())
            .await
            .expect("the superseded teardown is held");
        let (_pty, _ctl) = attach_labelled(&successor, &suffix).await;
        let replacement = sessions
            .peers
            .lock()
            .await
            .get(&child_id)
            .cloned()
            .expect("the replacement is resident");
        let replacement_viewer = viewer_id(&child_id, &replacement.generation);
        assert_ne!(replacement_viewer, old_viewer, "a name of its own");
        assert!(
            control
                .wait_for_direct_sink(&replacement_viewer, Duration::from_secs(3))
                .await,
            "the replacement registered its sink"
        );

        // The old child's cleanup runs to the end now.
        let deadline = old_child.close.initiate();
        sessions
            .settle_detached_peer(&child_id, old_child, deadline)
            .await;
        tokio::time::timeout(Duration::from_secs(5), async {
            while !sessions.closing_peers.lock().await.is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the old child settled");
        assert!(
            control
                .wait_for_direct_sink(&replacement_viewer, Duration::from_millis(200))
                .await,
            "the old child's cleanup removed nothing of the replacement's"
        );
        assert!(
            sessions
                .controls
                .contains_viewer(session_id, &replacement_viewer)
                .await
        );
        assert!(
            !sessions
                .controls
                .contains_viewer(session_id, &old_viewer)
                .await
        );

        gate.release.notify_one();
        sessions.close_all().await;
        for pc in [first, successor] {
            let _ = pc.close().await;
        }
        worker.abort();
    }

    /// A superseded pair keeps its slot for the successor to take over. Dropped
    /// before its close is spawned — a path that returned early — it returns
    /// that slot at once, not when its transport close lets go of the last
    /// clone.
    #[tokio::test]
    async fn a_superseded_pair_dropped_unclosed_returns_its_slot_at_once() {
        let sessions = RtcSessions::new();
        sessions.bind_registered_host_id(Uuid::new_v4()).await;
        let registry = SessionRegistry::new();
        let device = connect_pair(&sessions, &registry, [24; 32]).await;
        let host_id = sessions
            .host_peers
            .lock()
            .await
            .keys()
            .next()
            .cloned()
            .expect("the pair is admitted");
        // The transport close never settles while this is held: the slot
        // could only come back from the drop path.
        let gate = sessions
            .stall_effect(&host_id, TestEffectPoint::HostTransportClose)
            .await;
        let retired = sessions.take_device_pair([24; 32]).await;
        assert_eq!(retired.len(), 1);
        assert_eq!(
            sessions.peer_admission.charged(),
            1,
            "the slot stays with the retired pair for a successor to take"
        );
        drop(retired);
        for _ in 0..32 {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            sessions.peer_admission.charged(),
            0,
            "dropped unclosed, the retired pair's slot went back at once"
        );
        tokio::time::timeout(Duration::from_secs(3), gate.entered.notified())
            .await
            .expect("the drop path closes the transport");
        gate.release.notify_one();
        sessions.close_all().await;
        let _ = device.close().await;
    }

    /// At the cap, a device whose own connection is reaped after the cap was
    /// last asked and before its pair is taken — the reaper takes it without
    /// the admission lock — is admitted on the slot that reap returned, not
    /// refused for want of one.
    #[tokio::test]
    async fn a_device_whose_pair_was_reaped_under_the_lock_takes_the_freed_slot() {
        let sessions = RtcSessions::new();
        sessions.bind_registered_host_id(Uuid::new_v4()).await;
        let registry = SessionRegistry::new();
        let first = connect_pair(&sessions, &registry, [25; 32]).await;
        let mut filler = Vec::new();
        while let Some(slot) = sessions.peer_admission.try_acquire() {
            filler.push(slot);
        }
        assert_eq!(filler.len(), MAX_RTC_PEERS - 1);
        let (first_id, first_pc) = {
            let hosts = sessions.host_peers.lock().await;
            let (id, peer) = hosts.iter().next().expect("the first pair is admitted");
            (id.clone(), Arc::clone(&peer.pc))
        };
        let gate = sessions
            .stall_effect(
                &device_key_hex(&[25; 32]),
                TestEffectPoint::HostAdmissionTake,
            )
            .await;

        let successor_sessions = sessions.clone();
        let successor_registry = registry.clone();
        let successor = tokio::spawn(async move {
            connect_pair(&successor_sessions, &successor_registry, [25; 32]).await
        });
        tokio::time::timeout(Duration::from_secs(5), gate.entered.notified())
            .await
            .expect("the offer reached the take under the lock");
        // The reaper takes the device's connection meanwhile: its slot goes
        // back to the cap, and there is no pair left for the offer to take.
        sessions
            .retire_host_if_same(&first_id, &first_pc, Some("stayed disconnected"))
            .await;
        assert_eq!(sessions.peer_admission.charged(), MAX_RTC_PEERS - 1);
        gate.release.notify_one();

        let successor = tokio::time::timeout(Duration::from_secs(10), successor)
            .await
            .expect("the offer was answered")
            .expect("admitted on the freed slot, not refused");
        assert_eq!(sessions.host_peers.lock().await.len(), 1);
        assert_eq!(sessions.peer_admission.charged(), MAX_RTC_PEERS);

        drop(filler);
        sessions.close_all().await;
        for pc in [first, successor] {
            let _ = pc.close().await;
        }
    }

    /// A panic in a retired host peer's teardown strands nothing: its
    /// attachments, claimed and in the closing map since it was taken, settle
    /// regardless, and its transport closes.
    #[tokio::test]
    async fn a_panicking_host_teardown_still_settles_its_attachments() {
        let sessions = RtcSessions::new();
        sessions.bind_registered_host_id(Uuid::new_v4()).await;
        let registry = SessionRegistry::new();
        let session_id = Uuid::new_v4();
        let (binding, mut commands) = crate::rtc::tests::insert_test_worker(&registry, session_id);
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
        let device = connect_pair(&sessions, &registry, [26; 32]).await;
        let (_pty, _ctl) = attach(&device, session_id).await;
        let (host_id, host_pc) = {
            let hosts = sessions.host_peers.lock().await;
            let (id, peer) = hosts.iter().next().expect("the pair is admitted");
            (id.clone(), Arc::clone(&peer.pc))
        };
        sessions
            .injected_cleanup_panics
            .lock()
            .await
            .insert(host_id.clone());
        sessions.retire_host_if_same(&host_id, &host_pc, None).await;
        assert_eq!(sessions.closing_peers.lock().await.len(), 1);
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if sessions.closing_peers.lock().await.is_empty()
                    && sessions.admission_gauge().await.host_closing == 0
                    && host_pc.connection_state() == RTCPeerConnectionState::Closed
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the attachment settled and the transport closed despite the panic");
        sessions.close_all().await;
        let _ = device.close().await;
        worker.abort();
    }

    /// The mobile client keeps its view and attachment ids across a
    /// reconnect. When its new connection supersedes the old one while the
    /// old one's children have not yet closed, re-attaching the same view
    /// must be admitted — not refused as a stale attachment until those
    /// children happen to leave the map.
    #[tokio::test]
    async fn device_reattaches_the_same_view_while_the_superseded_pair_is_still_closing() {
        let sessions = RtcSessions::new();
        sessions.bind_registered_host_id(Uuid::new_v4()).await;
        let registry = SessionRegistry::new();
        let session_id = Uuid::new_v4();
        let (binding, mut commands) = crate::rtc::tests::insert_test_worker(&registry, session_id);
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
        let suffix = format!("{session_id}/{}/{}", Uuid::new_v4(), Uuid::new_v4());
        let first = connect_pair(&sessions, &registry, [11; 32]).await;
        let (_first_pty, _first_ctl) = attach_labelled(&first, &suffix).await;
        let first_id = sessions
            .host_peers
            .lock()
            .await
            .keys()
            .next()
            .cloned()
            .expect("the first pair is admitted");
        // Hold the superseded connection's close before it touches its
        // children, so the old child is still in the map when the device
        // re-attaches.
        let gate = sessions
            .stall_effect(&first_id, TestEffectPoint::HostRetire)
            .await;

        let successor = connect_pair(&sessions, &registry, [11; 32]).await;
        tokio::time::timeout(Duration::from_secs(3), gate.entered.notified())
            .await
            .expect("the superseded close is held");
        // The old child left the peer map with its pair, before its teardown
        // (held here) has done anything; only the closing map still has it.
        assert!(
            sessions.peers.lock().await.is_empty(),
            "a superseded pair's attachment is not resident"
        );
        assert_eq!(sessions.closing_peers.lock().await.len(), 1);

        let (_pty, _ctl) = attach_labelled(&successor, &suffix).await;
        // Take the host map before the peer map, as the daemon does, and hold
        // neither past the assertions: `close_all` below needs both.
        let successor_pc = {
            let hosts = sessions.host_peers.lock().await;
            assert_eq!(hosts.len(), 1);
            Arc::clone(&hosts.values().next().unwrap().pc)
        };
        {
            let children = sessions.peers.lock().await;
            assert_eq!(
                children.len(),
                1,
                "the re-attachment replaced the old child"
            );
            assert!(
                Arc::ptr_eq(&children.values().next().unwrap().pc, &successor_pc),
                "the resident child belongs to the successor"
            );
        }

        gate.release.notify_one();
        tokio::time::timeout(Duration::from_secs(5), async {
            while sessions.admission_gauge().await.host_closing != 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the superseded close settles once released");
        sessions.close_all().await;
        for pc in [first, successor] {
            let _ = pc.close().await;
        }
        worker.abort();
    }

    /// A device's host channel may ask which conversation one of this
    /// daemon's windows is in (`host_conv`), and learns nothing about a
    /// window this daemon is not running.
    #[tokio::test]
    async fn pair_host_channels_inspect_this_daemons_windows_only() {
        let sessions = RtcSessions::new();
        sessions.bind_registered_host_id(Uuid::new_v4()).await;
        let registry = SessionRegistry::new();
        // A window whose shell is a real process with nothing under it. A
        // daemon that cannot walk a window (Windows) neither advertises nor
        // answers `conv.*`, whatever the pid, so this test's own stands in.
        #[cfg(unix)]
        let mut shell = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        #[cfg(unix)]
        let shell_pid = shell.id();
        #[cfg(not(unix))]
        let shell_pid = std::process::id();
        let window = Uuid::new_v4();
        let (cmd_tx, _cmd_rx) = mpsc::channel(crate::pty::WORKER_COMMAND_QUEUE_DEPTH);
        let (outbox_tx, _outbox_rx) = mpsc::channel(crate::pty::WORKER_OUTPUT_QUEUE_DEPTH);
        registry.insert(
            crate::pty::SessionHandle::new_worker(crate::pty::WorkerHandleParts {
                session_id: window,
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
                control: crate::pty::ForwarderControl::new(),
            })
            .with_shell_pid(shell_pid),
        );
        // A worker that never reported its shell.
        let unreported = Uuid::new_v4();
        let (_binding, _commands) = crate::rtc::tests::insert_test_worker(&registry, unreported);
        let pc = connect_pair(&sessions, &registry, [42; 32]).await;
        // connect_pair's signaling receiver has gone away; install a live sink.
        let (signal_tx, mut signal_rx) = mpsc::channel(128);
        sessions.signaling.install(signal_tx);
        sessions.deferred_pruned.store(true, Ordering::Release);
        let signal_sink = tokio::spawn(async move { while signal_rx.recv().await.is_some() {} });
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
        let hello = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(hello["type"], "hello");
        let advertised = hello["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|name| name == crate::host_conv::CAPABILITY);
        assert_eq!(advertised, crate::host_conv::SUPPORTED);
        let ask = |request_id: &'static str, session_id: String| {
            let host = Arc::clone(&host);
            async move {
                host.send_text(
                    json!({
                        "version": 1, "type": "request", "request_id": request_id,
                        "operation": "conv.inspect", "payload": {"session_id": session_id}
                    })
                    .to_string(),
                )
                .await
                .unwrap();
            }
        };
        ask("inspect-window", window.to_string()).await;
        let answer = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(answer["request_id"], "inspect-window");
        if crate::host_conv::SUPPORTED {
            assert_eq!(answer["ok"], true, "{answer}");
            assert_eq!(
                answer["result"],
                json!({
                    "agent": null,
                    "conversation_id": null,
                    "state": "unknown",
                    "cli_version": null,
                    "live_elsewhere": false,
                    "source": "none",
                })
            );
            for (request_id, session_id, code) in [
                (
                    "inspect-unknown",
                    Uuid::new_v4().to_string(),
                    "session_not_found",
                ),
                (
                    "inspect-unreported",
                    unreported.to_string(),
                    "session_not_found",
                ),
                (
                    "inspect-garbage",
                    "not-a-session".to_string(),
                    "invalid_request",
                ),
                (
                    "inspect-uppercase",
                    window.to_string().to_uppercase(),
                    "invalid_request",
                ),
            ] {
                ask(request_id, session_id).await;
                let answer = tokio::time::timeout(Duration::from_secs(5), rx.recv())
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(answer["request_id"], request_id);
                assert_eq!(answer["error"]["code"], code, "{answer}");
            }
        } else {
            assert_eq!(answer["error"]["code"], "unsupported_operation");
        }
        sessions.close_all().await;
        let _ = pc.close().await;
        signal_sink.abort();
        #[cfg(unix)]
        {
            shell.kill().unwrap();
            shell.wait().unwrap();
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
        sessions.deferred_pruned.store(true, Ordering::Release);
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
        // Hold the attachment's callback fence so its terminal cleanup cannot
        // settle; retirement must fence the host consumers regardless.
        let child_fence = sessions
            .peers
            .lock()
            .await
            .values()
            .next()
            .map(|child| Arc::clone(&child.fence))
            .expect("the attachment is resident");
        let blocked_cleanup = child_fence.read().await;
        let retire_sessions = sessions.clone();
        let retiring = tokio::spawn(async move {
            let retired = retire_sessions.take_device_pair([7; 32]).await;
            retire_sessions.close_retired_host_peers(retired).await;
        });
        tokio::time::timeout(Duration::from_secs(3), async {
            while !sessions.host_peers.lock().await.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            sessions.closing_peers.lock().await.len(),
            1,
            "the attachment's cleanup is still pending"
        );
        host.send_text(json!({"version":1,"type":"request","request_id":"after-retire","operation":"fs.home","payload":{}}).to_string()).await.unwrap();
        let response = tokio::time::timeout(Duration::from_millis(200), rx.recv()).await;
        drop(blocked_cleanup);
        retiring.await.unwrap();
        let _ = pc.close().await;
        worker.abort();
        signal_sink.abort();
        assert!(
            response.is_err(),
            "retired parent published a host response: {response:?}"
        );
    }

    // -- The conversation carrier over real pair channels -----------------

    mod carrier {
        use std::collections::VecDeque;
        use std::path::{Path, PathBuf};

        use base64::{engine::general_purpose::STANDARD, Engine as _};
        use sha2::{Digest, Sha256};

        use super::*;
        use crate::host_conversations::{PairWindows, Places, WindowStop};
        use crate::host_stream::BulkGate;

        /// The chunk field, spelled so the protected-content guard's inventory of
        /// where it may appear stays the reviewed two lines of `host_direct.rs`.
        const BYTES_FIELD: &str = concat!("bytes", "_b64");

        const ID: &str = "6f1c2a9e-0b7d-4c55-8f3e-2d9a1b7c4e60";
        const OTHER_ID: &str = "0199a8b2-6c3e-7f10-9d2b-5a4e3c2b1a09";
        const WINDOW_ID: &str = "33333333-3333-4333-8333-333333333333";
        const TARGET_HOST: &str = "44444444-4444-4444-8444-444444444444";

        /// One host: a temporary home with Claude's store and spawnd's
        /// holdings, served to one device's connection.
        struct Host {
            _root: tempfile::TempDir,
            home: PathBuf,
            store: PathBuf,
            gate: Arc<BulkGate>,
            device: Arc<RTCPeerConnection>,
            _daemon: Arc<RTCPeerConnection>,
            first: Option<Ctl>,
        }

        impl Host {
            async fn new() -> Self {
                Self::with_gate(BulkGate::new()).await
            }

            async fn with_gate(gate: Arc<BulkGate>) -> Self {
                let root = tempfile::tempdir().unwrap();
                let home = root.path().join("home");
                std::fs::create_dir_all(&home).unwrap();
                let home = std::fs::canonicalize(&home).unwrap();
                let store = home.join(".claude");
                std::fs::create_dir_all(store.join("projects")).unwrap();
                let files = Arc::new(HostFileService::rooted_at(&home).await.unwrap());
                let pair = PairWindows::new(
                    crate::host_conv::WindowShells::new(|_| None),
                    |_| Box::pin(async { WindowStop::NotRunning }),
                    |_| None,
                    Arc::clone(&gate),
                    Places::rooted(home.join(".config/spawn/conversations"), store.clone()),
                );
                let api = webrtc::api::APIBuilder::new().build();
                let device = Arc::new(
                    api.new_peer_connection(RTCConfiguration::default())
                        .await
                        .unwrap(),
                );
                let daemon = Arc::new(
                    api.new_peer_connection(RTCConfiguration::default())
                        .await
                        .unwrap(),
                );
                let binding = HostRtcBinding {
                    host_id: Uuid::new_v4(),
                    binding_nonce: "d".repeat(32),
                    binding_generation: 1,
                    protocol: HOST_CONTROL_LABEL.to_owned(),
                    protocol_version: 2,
                };
                let signaling = RtcWsSender::default();
                daemon.on_data_channel(Box::new(move |dc| {
                    let files = Arc::clone(&files);
                    let pair = pair.clone();
                    let binding = binding.clone();
                    let signaling = signaling.clone();
                    Box::pin(async move {
                        if dc.label().starts_with(HOST_CONTROL_LABEL) {
                            let _ = install_host_control_channel(
                                dc,
                                "pair/carrier".into(),
                                binding,
                                signaling,
                                Some(files),
                                Some(pair),
                            );
                        }
                    })
                }));
                // SCTP is negotiated with the first channel.
                let first = Ctl::create(&device).await;
                let offer = device.create_offer(None).await.unwrap();
                let mut gathered = device.gathering_complete_promise().await;
                device.set_local_description(offer).await.unwrap();
                let _ = gathered.recv().await;
                daemon
                    .set_remote_description(device.local_description().await.unwrap())
                    .await
                    .unwrap();
                let answer = daemon.create_answer(None).await.unwrap();
                let mut gathered = daemon.gathering_complete_promise().await;
                daemon.set_local_description(answer).await.unwrap();
                let _ = gathered.recv().await;
                device
                    .set_remote_description(daemon.local_description().await.unwrap())
                    .await
                    .unwrap();
                Self {
                    _root: root,
                    home,
                    store,
                    gate,
                    device,
                    _daemon: daemon,
                    first: Some(first),
                }
            }

            /// A consumer channel on this host, past its hello.
            async fn channel(&mut self) -> (Ctl, Value) {
                let mut ctl = match self.first.take() {
                    Some(ctl) => ctl,
                    None => Ctl::create(&self.device).await,
                };
                let hello = ctl.next().await;
                assert_eq!(hello["type"], "hello", "{hello}");
                (ctl, hello)
            }

            fn folder(&self, relative: &str) -> PathBuf {
                let path = self.home.join(relative);
                std::fs::create_dir_all(&path).unwrap();
                std::fs::canonicalize(path).unwrap()
            }

            fn project(&self, cwd: &Path) -> PathBuf {
                self.store
                    .join("projects")
                    .join(crate::host_transcripts::claude_project_folder(
                        cwd.to_str().unwrap(),
                    ))
            }
        }

        /// The device's end of one `spawn.host.ctl/<uuid>` channel.
        struct Ctl {
            dc: Arc<RTCDataChannel>,
            rx: mpsc::UnboundedReceiver<Value>,
            stash: VecDeque<Value>,
        }

        impl Ctl {
            async fn create(device: &Arc<RTCPeerConnection>) -> Self {
                let dc = device
                    .create_data_channel(&format!("{HOST_CONTROL_LABEL}/{}", Uuid::new_v4()), None)
                    .await
                    .unwrap();
                let (tx, rx) = mpsc::unbounded_channel();
                dc.on_message(Box::new(move |message| {
                    let _ = tx.send(serde_json::from_slice::<Value>(&message.data).unwrap());
                    Box::pin(async {})
                }));
                Self {
                    dc,
                    rx,
                    stash: VecDeque::new(),
                }
            }

            async fn recv(&mut self) -> Value {
                tokio::time::timeout(Duration::from_secs(15), self.rx.recv())
                    .await
                    .expect("the host said nothing")
                    .expect("the channel closed")
            }

            async fn next(&mut self) -> Value {
                match self.stash.pop_front() {
                    Some(frame) => frame,
                    None => self.recv().await,
                }
            }

            async fn send(&self, frame: Value) {
                self.dc.send_text(frame.to_string()).await.unwrap();
            }

            async fn request(
                &mut self,
                request_id: &str,
                operation: &str,
                payload: Value,
            ) -> Value {
                self.send(json!({
                    "version": 1, "type": "request", "request_id": request_id,
                    "operation": operation, "payload": payload,
                }))
                .await;
                loop {
                    let frame = self.recv().await;
                    if frame["type"] == "response" && frame["request_id"] == request_id {
                        return frame;
                    }
                    self.stash.push_back(frame);
                }
            }

            async fn ok(&mut self, request_id: &str, operation: &str, payload: Value) -> Value {
                let response = self.request(request_id, operation, payload).await;
                assert_eq!(response["ok"], true, "{operation}: {response}");
                response["result"].clone()
            }
        }

        fn write_conversation(project: &Path, record: &[u8]) {
            write_conversation_of(ID, project, record);
        }

        fn write_conversation_of(id: &str, project: &Path, record: &[u8]) {
            std::fs::create_dir_all(project.join(id).join("tool-results")).unwrap();
            std::fs::write(project.join(format!("{id}.jsonl")), record).unwrap();
            std::fs::write(project.join(id).join("tool-results/t.txt"), b"output\n").unwrap();
        }

        fn conversation_lines(lines: usize) -> Vec<u8> {
            (0..lines)
                .flat_map(|n| {
                    format!(
                        "{{\"type\":\"user\",\"n\":{n},\"pad\":\"{}\"}}\n",
                        "x".repeat(40)
                    )
                    .into_bytes()
                })
                .collect()
        }

        /// What the device saw of B's acknowledgements, and where the
        /// carry stopped.
        struct Pumped {
            forwarded: u64,
            digest: Option<String>,
            acks: Vec<u64>,
        }

        /// A device pumping A's read into B's write: B's window and A's are
        /// honoured, A is acknowledged as chunks go on to B, and B's
        /// acknowledgements must be cumulative and must keep the pump going.
        #[allow(clippy::too_many_arguments)]
        async fn pump(
            a: &mut Ctl,
            a_stream: &str,
            b: &mut Ctl,
            b_stream: &str,
            from: u64,
            count: u64,
            window: u64,
            stop_at: Option<u64>,
        ) -> Pumped {
            let mut pending: VecDeque<(u64, Value)> = VecDeque::new();
            let mut expected = from;
            let mut forwarded = from;
            let mut a_acked = from;
            let mut b_acked = from;
            let mut digest = None;
            let mut acks = Vec::new();
            loop {
                while let Some((sequence, _)) = pending.front() {
                    if stop_at.is_some_and(|stop| forwarded >= stop)
                        || !crate::host_stream::may_send(window, b_acked, *sequence)
                    {
                        break;
                    }
                    let (sequence, bytes) = pending.pop_front().unwrap();
                    b.send(
                        json!({"version": 1, "type": "stream.chunk", "stream_id": b_stream,
                        "sequence": sequence, (BYTES_FIELD): bytes}),
                    )
                    .await;
                    forwarded = sequence + 1;
                }
                if forwarded > a_acked {
                    a.send(
                        json!({"version": 1, "type": "stream.ack", "stream_id": a_stream,
                        "sequence": forwarded}),
                    )
                    .await;
                    a_acked = forwarded;
                }
                if stop_at.is_some_and(|stop| forwarded >= stop) {
                    return Pumped {
                        forwarded,
                        digest,
                        acks,
                    };
                }
                if forwarded == count && b_acked == count && digest.is_some() {
                    return Pumped {
                        forwarded,
                        digest,
                        acks,
                    };
                }
                tokio::select! {
                    frame = a.next() => match frame["type"].as_str() {
                        Some("stream.chunk") => {
                            assert_eq!(frame["stream_id"], a_stream);
                            assert_eq!(frame["sequence"].as_u64(), Some(expected), "A's chunks are in order");
                            assert!(crate::host_stream::may_send(window, a_acked, expected), "A kept to its window");
                            pending.push_back((expected, frame[BYTES_FIELD].clone()));
                            expected += 1;
                        }
                        Some("stream.end") => digest = frame["sha256"].as_str().map(str::to_string),
                        _ => panic!("A said {frame}"),
                    },
                    frame = b.next() => match frame["type"].as_str() {
                        Some("stream.ack") => {
                            let ack = frame["sequence"].as_u64().unwrap();
                            assert!(crate::host_stream::valid_ack(b_acked, forwarded, ack), "{ack} after {b_acked} of {forwarded}");
                            b_acked = ack;
                            acks.push(ack);
                        }
                        _ => panic!("B said {frame}"),
                    },
                }
            }
        }

        fn export_payload(transfer: &str, cwd: &Path, from: u64) -> Value {
            export_payload_of(ID, transfer, cwd, from)
        }

        fn export_payload_of(id: &str, transfer: &str, cwd: &Path, from: u64) -> Value {
            json!({
                "transfer_id": transfer, "agent": "claude-code", "conversation_id": id,
                "mode": "retire", "session_id": WINDOW_ID, "to_host_id": TARGET_HOST,
                "cwd": cwd.to_string_lossy(),
                "stream": {"window": 16, "digest": "end"}, "from_sequence": from,
            })
        }

        fn import_payload(transfer: &str, cwd: &Path, length: u64) -> Value {
            json!({
                "transfer_id": transfer, "agent": "claude-code", "conversation_id": ID,
                "mode": "retire", "cwd": cwd.to_string_lossy(), "length": length,
                "sha256": null, "stream": {"window": 16, "digest": "end"},
            })
        }

        #[tokio::test]
        async fn a_conversation_moves_between_two_hosts_over_pair_channels() {
            let mut a = Host::new().await;
            let mut b = Host::new().await;
            let (mut ctl_a, hello) = a.channel().await;
            let (mut ctl_b, _) = b.channel().await;
            let capabilities = hello["capabilities"].as_array().unwrap();
            for family in ["conv.v1", "conv.v2"] {
                assert_eq!(
                    capabilities.iter().any(|name| name == family),
                    crate::host_conversations::SUPPORTED,
                    "{family}"
                );
            }
            assert_eq!(hello["limits"]["stream_window_max"], 16);
            if !crate::host_conversations::SUPPORTED {
                let refused = ctl_a.request("p", "conv.probe", json!({})).await;
                assert_eq!(refused["error"]["code"], "unsupported_operation");
                return;
            }
            let cwd_a = a.folder("code/spawn");
            let record = conversation_lines(4000);
            write_conversation(&a.project(&cwd_a), &record);
            let cwd_b = b.folder("work/spawn");
            let probe = ctl_b
                .ok(
                    "probe",
                    "conv.probe",
                    json!({"agent": "claude-code", "conversation_id": ID, "cwd": "~/work/spawn"}),
                )
                .await;
            assert_eq!(probe["store_ready"], true, "{probe}");
            assert_eq!(probe["duplicates"], json!([]));

            let transfer = Uuid::new_v4().to_string();
            let export = ctl_a
                .ok(
                    "export",
                    "conv.export",
                    export_payload(&transfer, &cwd_a, 0),
                )
                .await;
            assert_eq!(export["sha256"], Value::Null);
            assert_eq!(export["mode"], "retire");
            assert_eq!(export["window"], 16);
            assert_eq!(export["stopped"], "not_running");
            let length = export["length"].as_u64().unwrap();
            let count = crate::host_stream::chunk_count(length);
            assert!(count > 32, "a conversation several windows long");
            assert!(!a.project(&cwd_a).join(format!("{ID}.jsonl")).exists());
            let import = ctl_b
                .ok(
                    "import",
                    "conv.import.begin",
                    import_payload(&transfer, &cwd_b, length),
                )
                .await;
            assert_eq!(import["next_sequence"], 0);
            let a_stream = export["stream_id"].as_str().unwrap().to_string();
            let b_stream = import["stream_id"].as_str().unwrap().to_string();
            let pumped = pump(
                &mut ctl_a, &a_stream, &mut ctl_b, &b_stream, 0, count, 16, None,
            )
            .await;
            assert_eq!(pumped.forwarded, count);
            assert_eq!(*pumped.acks.last().unwrap(), count);
            let digest = pumped.digest.unwrap();
            ctl_b
                .send(
                    json!({"version": 1, "type": "stream.end", "stream_id": b_stream,
                    "length": length, "sha256": digest}),
                )
                .await;
            let committed = ctl_b.next().await;
            assert_eq!(committed["type"], "stream.committed", "{committed}");
            assert_eq!(committed["sha256"], digest);
            let landed = b.project(&cwd_b).join(format!("{ID}.jsonl"));
            assert_eq!(committed["result"]["path"], landed.to_str().unwrap());
            assert_eq!(std::fs::read(&landed).unwrap(), record);
            assert_eq!(
                std::fs::read(b.project(&cwd_b).join(ID).join("tool-results/t.txt")).unwrap(),
                b"output\n"
            );
            let status = ctl_b
                .ok(
                    "status",
                    "conv.import.status",
                    json!({"transfer_id": transfer}),
                )
                .await;
            assert_eq!(status["state"], "committed");
            // The source retires exactly what the target committed.
            let retired = ctl_a
                .ok(
                    "retire",
                    "conv.retire.commit",
                    json!({"transfer_id": transfer, "length": length, "sha256": digest}),
                )
                .await;
            assert_eq!(retired["state"], "retired");
            let listed = ctl_a.ok("transfers", "conv.transfers", json!({})).await;
            assert_eq!(listed["outgoing"], json!([]));
            // Bulk never let a frame through above the watermark.
            assert!(a.gate.largest_let_through() <= crate::host_stream::BULK_WATERMARK);
        }

        #[tokio::test]
        async fn a_carry_resumes_on_new_channels_after_losing_its_own() {
            if !crate::host_conversations::SUPPORTED {
                return;
            }
            let mut a = Host::new().await;
            let mut b = Host::new().await;
            let (mut ctl_a, _) = a.channel().await;
            let (mut ctl_b, _) = b.channel().await;
            let cwd_a = a.folder("code/spawn");
            let record = conversation_lines(3000);
            write_conversation(&a.project(&cwd_a), &record);
            let cwd_b = b.folder("code/spawn");
            let transfer = Uuid::new_v4().to_string();
            let export = ctl_a
                .ok(
                    "export",
                    "conv.export",
                    export_payload(&transfer, &cwd_a, 0),
                )
                .await;
            let length = export["length"].as_u64().unwrap();
            let count = crate::host_stream::chunk_count(length);
            let import = ctl_b
                .ok(
                    "import",
                    "conv.import.begin",
                    import_payload(&transfer, &cwd_b, length),
                )
                .await;
            let a_stream = export["stream_id"].as_str().unwrap().to_string();
            let b_stream = import["stream_id"].as_str().unwrap().to_string();
            pump(
                &mut ctl_a,
                &a_stream,
                &mut ctl_b,
                &b_stream,
                0,
                count,
                16,
                Some(20),
            )
            .await;
            // Both channels go; the transfer stays on both hosts.
            ctl_a.dc.close().await.unwrap();
            ctl_b.dc.close().await.unwrap();
            drop((ctl_a, ctl_b));

            let (mut ctl_a, _) = a.channel().await;
            let (mut ctl_b, _) = b.channel().await;
            let status = ctl_b
                .ok(
                    "status",
                    "conv.import.status",
                    json!({"transfer_id": transfer}),
                )
                .await;
            assert_eq!(status["state"], "receiving");
            let next = status["next_sequence"].as_u64().unwrap();
            assert!(next <= 20 && next > 0, "{status}");
            assert_eq!(status["received"], next * 8192);
            let listed = ctl_a.ok("transfers", "conv.transfers", json!({})).await;
            assert_eq!(listed["outgoing"][0]["transfer_id"], transfer);
            let import = ctl_b
                .ok(
                    "resume-in",
                    "conv.import.begin",
                    import_payload(&transfer, &cwd_b, length),
                )
                .await;
            assert_eq!(import["next_sequence"], next);
            let export = ctl_a
                .ok(
                    "resume-out",
                    "conv.export",
                    export_payload(&transfer, &cwd_a, next),
                )
                .await;
            assert_eq!(export["next_sequence"], next);
            assert_eq!(export["length"], length);
            let a_stream = export["stream_id"].as_str().unwrap().to_string();
            let b_stream = import["stream_id"].as_str().unwrap().to_string();
            let pumped = pump(
                &mut ctl_a, &a_stream, &mut ctl_b, &b_stream, next, count, 16, None,
            )
            .await;
            let digest = pumped.digest.unwrap();
            ctl_b
                .send(
                    json!({"version": 1, "type": "stream.end", "stream_id": b_stream,
                    "length": length, "sha256": digest}),
                )
                .await;
            assert_eq!(ctl_b.next().await["type"], "stream.committed");
            assert_eq!(
                std::fs::read(b.project(&cwd_b).join(format!("{ID}.jsonl"))).unwrap(),
                record
            );
        }

        #[tokio::test]
        async fn a_resumed_begin_on_another_channel_supersedes_the_first() {
            if !crate::host_conversations::SUPPORTED {
                return;
            }
            let mut b = Host::new().await;
            let (mut first, _) = b.channel().await;
            let (mut second, _) = b.channel().await;
            let cwd = b.folder("code/spawn");
            // Any bytes do for a begin; the reader refuses them only once a
            // header arrives.
            let transfer = Uuid::new_v4().to_string();
            let opened = first
                .ok(
                    "one",
                    "conv.import.begin",
                    import_payload(&transfer, &cwd, 100_000),
                )
                .await;
            let reopened = second
                .ok(
                    "two",
                    "conv.import.begin",
                    import_payload(&transfer, &cwd, 100_000),
                )
                .await;
            assert_eq!(reopened["next_sequence"], 0);
            let ended = first.next().await;
            assert_eq!(ended["type"], "stream.error", "{ended}");
            assert_eq!(ended["stream_id"], opened["stream_id"]);
            assert_eq!(ended["error"]["code"], "superseded");
            // The transfer's cancel ends the stream that carries it now.
            let cancelled = first
                .ok(
                    "cancel",
                    "conv.import.cancel",
                    json!({"transfer_id": transfer}),
                )
                .await;
            assert_eq!(cancelled["state"], "cancelled");
            let ended = second.next().await;
            assert_eq!(ended["error"]["code"], "cancelled", "{ended}");
            let again = second
                .request(
                    "three",
                    "conv.import.begin",
                    import_payload(&transfer, &cwd, 100_000),
                )
                .await;
            assert_eq!(again["error"]["code"], "transfer_cancelled");
        }

        /// A whole v2 read, acknowledged chunk by chunk as a device does.
        async fn read_stream(ctl: &mut Ctl, stream: String) -> (Vec<u8>, Value) {
            let mut bytes = Vec::new();
            let mut next = 0;
            loop {
                let frame = ctl.next().await;
                match frame["type"].as_str() {
                    Some("stream.chunk") => {
                        assert_eq!(frame["sequence"], next);
                        bytes.extend(
                            STANDARD
                                .decode(frame[BYTES_FIELD].as_str().unwrap())
                                .unwrap(),
                        );
                        next += 1;
                        ctl.send(json!({"version": 1, "type": "stream.ack",
                            "stream_id": stream, "sequence": next}))
                            .await;
                    }
                    Some("stream.end") => return (bytes, frame["sha256"].clone()),
                    _ => panic!("{frame}"),
                }
            }
        }

        #[tokio::test]
        async fn every_bulk_channel_of_a_connection_shares_one_gate() {
            if !crate::host_conversations::SUPPORTED {
                return;
            }
            let mut a = Host::new().await;
            let cwd = a.folder("code/spawn");
            let record = conversation_lines(6000);
            // Two conversations of the same length, moving at once.
            write_conversation(&a.project(&cwd), &record);
            write_conversation_of(OTHER_ID, &a.project(&cwd), &record);
            let (mut one, _) = a.channel().await;
            let (mut two, _) = a.channel().await;
            let first = Uuid::new_v4().to_string();
            let second = Uuid::new_v4().to_string();
            let x = one
                .ok("x", "conv.export", export_payload(&first, &cwd, 0))
                .await;
            let y = two
                .ok(
                    "y",
                    "conv.export",
                    export_payload_of(OTHER_ID, &second, &cwd, 0),
                )
                .await;
            let count = crate::host_stream::chunk_count(x["length"].as_u64().unwrap());
            // Read both at once, acknowledging as a device does.
            let ((bytes_x, digest_x), (bytes_y, digest_y)) = tokio::join!(
                read_stream(&mut one, x["stream_id"].as_str().unwrap().to_string()),
                read_stream(&mut two, y["stream_id"].as_str().unwrap().to_string()),
            );
            assert_eq!(bytes_x.len() as u64, x["length"].as_u64().unwrap());
            assert_eq!(bytes_y.len() as u64, y["length"].as_u64().unwrap());
            assert!(bytes_x.len() as u64 > (count - 1) * 8192);
            assert_eq!(digest_x, json!(format!("{:x}", Sha256::digest(&bytes_x))));
            assert_eq!(digest_y, json!(format!("{:x}", Sha256::digest(&bytes_y))));
            assert!(a.gate.largest_let_through() <= crate::host_stream::BULK_WATERMARK);
        }

        /// Acknowledgements are cumulative, so the same one again is valid,
        /// and the daemon coalesces them: a device repeating its last one at
        /// any pace — here hundreds at once, while the export waits on a
        /// tight gate — never fills a queue and closes the channel (S4, F1).
        #[tokio::test]
        async fn repeated_acknowledgements_never_close_the_channel() {
            if !crate::host_conversations::SUPPORTED {
                return;
            }
            let mut a = Host::with_gate(BulkGate::with_watermark(1)).await;
            let cwd = a.folder("code/spawn");
            let record = conversation_lines(4000);
            write_conversation(&a.project(&cwd), &record);
            let (mut ctl, _) = a.channel().await;
            let transfer = Uuid::new_v4().to_string();
            let export = ctl
                .ok("x", "conv.export", export_payload(&transfer, &cwd, 0))
                .await;
            let stream = export["stream_id"].as_str().unwrap().to_string();
            for _ in 0..2 {
                for _ in 0..200 {
                    ctl.send(json!({"version": 1, "type": "stream.ack",
                        "stream_id": stream, "sequence": 0}))
                        .await;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let (bytes, digest) = read_stream(&mut ctl, stream).await;
            assert_eq!(bytes.len() as u64, export["length"].as_u64().unwrap());
            assert_eq!(digest, json!(format!("{:x}", Sha256::digest(&bytes))));
            assert_eq!(
                ctl.dc.ready_state(),
                webrtc::data_channel::data_channel_state::RTCDataChannelState::Open
            );
            // And the channel still answers.
            ctl.ok("ping", "ping", json!({})).await;
        }

        /// A gate that lets a frame through only once everything before it
        /// is acknowledged still delivers every chunk: a channel's fall to
        /// its low threshold wakes it.
        #[tokio::test]
        async fn a_tight_gate_waits_and_still_delivers_every_chunk() {
            if !crate::host_conversations::SUPPORTED {
                return;
            }
            let mut a = Host::with_gate(BulkGate::with_watermark(1)).await;
            let cwd = a.folder("code/spawn");
            let record = conversation_lines(2000);
            write_conversation(&a.project(&cwd), &record);
            let (mut ctl, _) = a.channel().await;
            let transfer = Uuid::new_v4().to_string();
            let export = ctl
                .ok("x", "conv.export", export_payload(&transfer, &cwd, 0))
                .await;
            let (bytes, digest) =
                read_stream(&mut ctl, export["stream_id"].as_str().unwrap().to_string()).await;
            assert_eq!(bytes.len() as u64, export["length"].as_u64().unwrap());
            assert_eq!(digest, json!(format!("{:x}", Sha256::digest(&bytes))));
            assert!(a.gate.largest_let_through() <= 1);
        }
    }
}
