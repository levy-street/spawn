//! Authenticated device–daemon connections (host signalling version 2).
//!
//! A terminal attachment owns channels and a backend-generation fence, never
//! the peer connection. The signed host transcript authenticates the device;
//! channel labels select only sessions in this daemon's local registry.

use super::*;

const MAX_PAIR_SESSIONS: usize = 128;
const MAX_PAIR_CONTROLS: usize = 32;
/// Channels of one device connection whose admission has begun and not been
/// decided — each waiting on the admission lock or a session's transition,
/// holding its channel, its stream and the peer connection. A channel past
/// this is refused at once. Every channel a pair can hold at one time —
/// both channels of each of its terminal attachments, its host consumers
/// and its root — may arrive together (a device re-attaching every view
/// after a reconnect does), so the bound is that many and refuses nothing
/// the caps above could all admit. Before admission ran in a task per
/// channel, SCTP's own backpressure kept this to one channel in the handler
/// and sixteen streams queued; without a bound a device could park one
/// task per stream id, some 65,000, each on a lock.
const MAX_PAIR_PENDING_CHANNELS: usize = 2 * MAX_PAIR_SESSIONS + MAX_PAIR_CONTROLS + 1;

pub(super) struct PairContext {
    pub(super) device_key: [u8; 32],
    registry: SessionRegistry,
    /// The control connection the offer arrived on. The pair outlives it:
    /// after a reconnect nobody reads this, so nothing an attachment says
    /// later may go through it (`RtcSessions::registered_sender`).
    out_tx: mpsc::Sender<WsOutbound>,
    trust_epoch: u64,
    ice_restart: bool,
    remote_ufrags: Mutex<HashSet<String>>,
    restart: Mutex<()>,
    retired: AtomicBool,
    host_channels: std::sync::Mutex<Vec<Weak<crate::host_control::Lifetime>>>,
    /// How many of this connection's channels are being admitted now
    /// (`PendingChannel`), at most `MAX_PAIR_PENDING_CHANNELS`.
    pending_channels: AtomicUsize,
}

/// One device channel from the moment its handler is called until its
/// admission is decided, counted against `MAX_PAIR_PENDING_CHANNELS`.
struct PendingChannel(Arc<PairContext>);

impl PendingChannel {
    fn begin(pair: &Arc<PairContext>) -> Option<Self> {
        pair.pending_channels
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |pending| {
                (pending < MAX_PAIR_PENDING_CHANNELS).then_some(pending + 1)
            })
            .ok()
            .map(|_| Self(Arc::clone(pair)))
    }
}

impl Drop for PendingChannel {
    fn drop(&mut self) {
        self.0.pending_channels.fetch_sub(1, Ordering::AcqRel);
    }
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
            pending_channels: AtomicUsize::new(0),
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
            // Counted from here until the future below has decided, and
            // refused past the bound before it holds the connection.
            let pending = PendingChannel::begin(&pair);
            let sessions = sessions.clone();
            let pc = pending.as_ref().and_then(|_| weak_pc.upgrade());
            let signal_id = signal_id.clone();
            let binding = binding.clone();
            let pair = Arc::clone(&pair);
            let controls = Arc::clone(&controls);
            Box::pin(async move {
                let Some(_pending) = pending else {
                    tracing::debug!(
                        %signal_id,
                        bound = MAX_PAIR_PENDING_CHANNELS,
                        "device channel refused: as many of its connection's channels are waiting for admission already"
                    );
                    reject_channel(&dc).await;
                    return;
                };
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
                    // the windows it can already see, and only that much of
                    // the registry is handed over.
                    let registry = pair.registry.clone();
                    let windows =
                        crate::host_conv::WindowShells::new(move |id| registry.shell_pid(id));
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
        // The session's transition first, the admission lock second, here
        // and in `create_answer`: a transition is held across a whole
        // restart — the session's peers closing, TERM, the wait for its
        // worker to go — and every offer and every attach on the daemon
        // serializes on admission. Taken the other way round, one device
        // opening a restarting window held admission for all of that, and
        // every other device's channels and offers waited behind it.
        //
        // A label is the device's to choose, so a session this daemon is
        // not running, and that no launch or restart is in the middle of,
        // is refused before its transition is taken: otherwise every such
        // label would be a lock of its own, made for it and waited on
        // behind admission. Nothing is weakened: the session is checked
        // again under both locks below, and a session with a transition in
        // progress — a launch about to register it — is waited for as
        // before.
        anyhow::ensure!(
            pair.registry.binding_for(label.session).is_some()
                || pair
                    .registry
                    .generation_transition_in_progress(label.session),
            "session not running on this daemon"
        );
        let transition = pair
            .registry
            .lock_generation_transition(label.session)
            .await;
        let _admission = self.admission.lock().await;
        anyhow::ensure!(
            self.pair_is_current(parent_id, pc, pair.trust_epoch).await,
            "retired device connection"
        );
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
        drop(_admission);
        drop(transition);
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

    /// Open a host consumer channel the way a device does, and collect what
    /// the daemon says on it. The daemon's `hello` is the proof the channel
    /// was accepted and admitted.
    async fn open_host_consumer(
        pc: &Arc<RTCPeerConnection>,
    ) -> (Arc<RTCDataChannel>, mpsc::UnboundedReceiver<Value>) {
        let channel = pc
            .create_data_channel(&format!("spawn.host.ctl/{}", Uuid::new_v4()), None)
            .await
            .unwrap();
        let (tx, rx) = mpsc::unbounded_channel();
        channel.on_message(Box::new(move |message| {
            let tx = tx.clone();
            Box::pin(async move {
                if let Ok(value) = serde_json::from_slice::<Value>(&message.data) {
                    let _ = tx.send(value);
                }
            })
        }));
        (channel, rx)
    }

    async fn hello_within(rx: &mut mpsc::UnboundedReceiver<Value>, wait: Duration) -> bool {
        matches!(
            tokio::time::timeout(wait, rx.recv()).await,
            Ok(Some(value)) if value["type"] == "hello"
        )
    }

    /// Ask a host consumer something and wait for its answer: the proof of
    /// admission a test on the daemon's own multi-thread runtime uses. The
    /// daemon's `hello` is unprompted and can reach a channel before the
    /// test has put a handler on it; a request is sent after the handler
    /// is there, and waits in its stream until the daemon admits the
    /// channel. A channel the daemon refused never answers.
    async fn consumer_answers(
        channel: &Arc<RTCDataChannel>,
        rx: &mut mpsc::UnboundedReceiver<Value>,
        wait: Duration,
    ) -> bool {
        let request_id = Uuid::new_v4().to_string();
        let request = json!({
            "version": 1, "type": "request", "request_id": request_id,
            "operation": "fs.home", "payload": {}
        });
        tokio::time::timeout(wait, async {
            // A channel made before this side's association is up opens
            // when it is.
            while channel.ready_state() == RTCDataChannelState::Connecting {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            if channel.send_text(request.to_string()).await.is_err() {
                return false;
            }
            while let Some(value) = rx.recv().await {
                if value["request_id"] == request_id.as_str() {
                    return true;
                }
            }
            false
        })
        .await
        .unwrap_or(false)
    }

    /// Wait until a session control channel answers, for the same reason as
    /// `consumer_answers`: `ready` is said once, perhaps before anyone here
    /// listens. A control request is dropped until its attachment is live
    /// and answered from then on, so one is asked until one is answered.
    async fn control_answers(ctl: &Arc<RTCDataChannel>, wait: Duration) -> bool {
        let (tx, mut rx) = mpsc::unbounded_channel();
        ctl.on_message(Box::new(move |message| {
            let tx = tx.clone();
            Box::pin(async move {
                if let Ok(value) = serde_json::from_slice::<Value>(&message.data) {
                    let _ = tx.send(value);
                }
            })
        }));
        tokio::time::timeout(wait, async {
            while ctl.ready_state() == RTCDataChannelState::Connecting {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            let mut asked = HashSet::new();
            loop {
                let request_id = Uuid::new_v4().to_string();
                let request = json!({
                    "version": 1, "kind": "request", "request_id": request_id,
                    "operation": "focus_view", "cols": 100, "rows": 30,
                });
                if ctl.send_text(request.to_string()).await.is_err() {
                    return false;
                }
                asked.insert(request_id);
                let pause = tokio::time::sleep(Duration::from_millis(50));
                tokio::pin!(pause);
                loop {
                    tokio::select! {
                        _ = &mut pause => break,
                        value = rx.recv() => {
                            let Some(value) = value else { return false };
                            if value["event"] == "ready"
                                || value["request_id"].as_str().is_some_and(|id| asked.contains(id))
                            {
                                return true;
                            }
                        }
                    }
                }
            }
        })
        .await
        .unwrap_or(false)
    }

    /// `attach`, for a test on a multi-thread runtime: both channels of a
    /// new attachment to `session`, returned once its control channel
    /// answers.
    async fn attach_answered(
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
        assert!(
            control_answers(&ctl, Duration::from_secs(10)).await,
            "session attached over existing connection"
        );
        (pty, ctl)
    }

    /// A stream whose first message is not a channel OPEN never becomes a
    /// channel. The acceptor refuses that stream and goes on to the next:
    /// upstream's left its loop for good on any such error — a stream reset
    /// before its OPEN was read is another — and nothing opened on the
    /// connection again while ICE, DTLS and the root channel all stayed up.
    #[tokio::test]
    async fn a_stream_that_never_becomes_a_channel_leaves_the_pair_accepting() {
        let sessions = RtcSessions::new();
        sessions.bind_registered_host_id(Uuid::new_v4()).await;
        let registry = SessionRegistry::new();
        let pc = connect_pair(&sessions, &registry, [17; 32]).await;
        let (probe, mut probe_rx) = open_host_consumer(&pc).await;
        assert!(
            hello_within(&mut probe_rx, Duration::from_secs(5)).await,
            "a channel opens on a fresh pair"
        );

        // A channel the device calls pre-negotiated sends no OPEN. The
        // daemon negotiated no such thing, so what arrives is a stream it
        // has never heard of whose first message is the device's text.
        let stray = pc
            .create_data_channel(
                "stray",
                Some(
                    webrtc::data_channel::data_channel_init::RTCDataChannelInit {
                        negotiated: Some(1001),
                        ..Default::default()
                    },
                ),
            )
            .await
            .unwrap();
        stray.send_text("not an open").await.unwrap();
        // Answered after the stray message was sent, so the stray stream is
        // in the acceptor's queue ahead of anything opened from here on.
        probe
            .send_text(
                json!({
                    "version": 1, "type": "request", "request_id": "after-stray",
                    "operation": "fs.home", "payload": {}
                })
                .to_string(),
            )
            .await
            .unwrap();
        let reply = tokio::time::timeout(Duration::from_secs(5), probe_rx.recv())
            .await
            .expect("an admitted channel still answers")
            .unwrap();
        assert_eq!(reply["request_id"], "after-stray");

        let (_next, mut next_rx) = open_host_consumer(&pc).await;
        let accepted = hello_within(&mut next_rx, Duration::from_secs(5)).await;
        assert_eq!(pc.connection_state(), RTCPeerConnectionState::Connected);
        assert_eq!(sessions.host_peers.lock().await.len(), 1);
        sessions.close_all().await;
        let _ = pc.close().await;
        assert!(
            accepted,
            "no channel opens on a live pair after a stream failed to become one"
        );
    }

    /// A device opens a channel, gives up on it, and closes it — the web
    /// client does exactly that when an open takes longer than ten seconds —
    /// while admission is busy. That is one channel lost; it must not be
    /// every channel after it on a connection whose ICE, DTLS and root
    /// channel all stay up. While the acceptor ran admission inline, the
    /// abandoned stream was reset before its OPEN was read and the acceptor
    /// left its loop on it; now the OPEN is read at once and the reset finds
    /// a channel still waiting to be admitted.
    #[tokio::test]
    async fn a_channel_abandoned_while_admission_is_busy_leaves_the_pair_accepting() {
        let sessions = RtcSessions::new();
        sessions.bind_registered_host_id(Uuid::new_v4()).await;
        let registry = SessionRegistry::new();
        let pc = connect_pair(&sessions, &registry, [12; 32]).await;

        // Admitted before anything goes wrong. Its requests are answered by
        // its own reader whatever the acceptor is doing, which is how this
        // test knows how far the daemon's association has read.
        let (probe, mut probe_rx) = open_host_consumer(&pc).await;
        assert!(
            hello_within(&mut probe_rx, Duration::from_secs(5)).await,
            "a channel opens on a fresh pair"
        );

        // Admission is busy: every offer and every attach on the daemon
        // serializes on this lock, and the next channels wait on it.
        let admission = Arc::clone(&sessions.admission).lock_owned().await;
        let (_waiting, mut waiting_rx) = open_host_consumer(&pc).await;
        let (abandoned, _abandoned_rx) = open_host_consumer(&pc).await;
        abandoned.close().await.unwrap();

        // SCTP sends the reset behind the OPEN it follows, and a request
        // sent only after an earlier reply came back is behind both. Two
        // round trips, since the first request can share a flight with the
        // reset: once the second is answered the daemon has reset the
        // abandoned stream, with its channel still unadmitted.
        for round in 0..2 {
            let request_id = format!("drain-{round}");
            probe
                .send_text(
                    json!({
                        "version": 1, "type": "request", "request_id": request_id,
                        "operation": "fs.home", "payload": {}
                    })
                    .to_string(),
                )
                .await
                .unwrap();
            let reply = tokio::time::timeout(Duration::from_secs(5), probe_rx.recv())
                .await
                .expect("an admitted channel answers while admission is busy")
                .unwrap();
            assert_eq!(reply["request_id"], request_id);
        }
        assert!(
            waiting_rx.try_recv().is_err(),
            "the channel opened first is still waiting on admission"
        );
        drop(admission);
        assert!(
            hello_within(&mut waiting_rx, Duration::from_secs(5)).await,
            "the channel that waited on admission is admitted"
        );

        let (_next, mut next_rx) = open_host_consumer(&pc).await;
        let accepted = hello_within(&mut next_rx, Duration::from_secs(5)).await;
        assert_eq!(pc.connection_state(), RTCPeerConnectionState::Connected);
        assert_eq!(sessions.host_peers.lock().await.len(), 1);
        sessions.close_all().await;
        let _ = pc.close().await;
        assert!(
            accepted,
            "no channel opens on a live pair after one was abandoned while admission was busy"
        );
    }

    /// The association under a device connection can end while ICE stays
    /// connected: the device's SCTP goes away, or this side's write loop
    /// closes it over a send error ICE itself recovers from. Nothing opens
    /// on such a pair again and no transport state will ever say so, so the
    /// acceptor ending is the word: the pair leaves the host map and the
    /// server hears `unavailable`, which a device answers with a new
    /// connection.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_pair_whose_association_ended_is_retired_and_announced() {
        let sessions = RtcSessions::new();
        sessions.bind_registered_host_id(Uuid::new_v4()).await;
        let registry = SessionRegistry::new();
        let pc = connect_pair(&sessions, &registry, [13; 32]).await;
        let (signal_tx, mut signal_rx) = mpsc::channel(16);
        sessions.signaling.install(signal_tx);
        sessions.deferred_pruned.store(true, Ordering::Release);
        let (signal_id, peer) = sessions
            .host_peers
            .lock()
            .await
            .iter()
            .next()
            .map(|(id, peer)| (id.clone(), peer.clone()))
            .unwrap();
        assert_eq!(sessions.peer_admission.charged(), 1);
        // Both associations are up and the acceptor is running: a transport
        // can report connected before SCTP has finished its handshake.
        let (consumer, mut consumer_rx) = open_host_consumer(&pc).await;
        assert!(
            consumer_answers(&consumer, &mut consumer_rx, Duration::from_secs(5)).await,
            "a channel opens on a fresh pair"
        );

        // The device's association and the DTLS connection under it close;
        // its ICE agent keeps answering, so the daemon's reaper, which
        // watches the connection state, has nothing to act on.
        pc.sctp().stop().await.unwrap();

        // The goodbye is what is waited for, not the empty host map: the
        // peer leaves the map before its status is sent, and on the
        // daemon's own multi-thread runtime a reader of the map can get in
        // between.
        let mut announced = Vec::new();
        let said_goodbye = tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(frame) = signal_rx.recv().await {
                let value: Value = serde_json::from_str(frame.as_str()).unwrap();
                if value["type"] == "rtc.status" && value["session_id"] == signal_id.as_str() {
                    let status = value["status"].as_str().unwrap_or_default().to_owned();
                    let goodbye = status != "connected";
                    announced.push(status);
                    if goodbye {
                        break;
                    }
                }
            }
        })
        .await;
        let state = peer.pc.connection_state();
        let resident = sessions.host_peers.lock().await.len();
        sessions.close_all().await;
        let _ = pc.close().await;
        // Whatever follows the goodbye for this binding would be a second
        // word; the teardown above has run, so it is all here by now.
        while let Ok(frame) = signal_rx.try_recv() {
            let value: Value = serde_json::from_str(frame.as_str()).unwrap();
            if value["type"] == "rtc.status" && value["session_id"] == signal_id.as_str() {
                announced.push(value["status"].as_str().unwrap_or_default().to_owned());
            }
        }
        assert!(
            said_goodbye.is_ok(),
            "a pair with no association was never announced gone; its transport says {state:?}, and {resident} host peer(s) are in the map"
        );
        assert_eq!(resident, 0, "the pair left the host map before its goodbye");
        // The channels that opened said `connected`; the goodbye is the
        // last word for this binding and is said once.
        assert_eq!(
            announced.last().map(String::as_str),
            Some("unavailable"),
            "the server hears the pair is gone: {announced:?}"
        );
        assert_eq!(
            announced
                .iter()
                .filter(|status| *status != "connected")
                .count(),
            1,
            "the goodbye is said once: {announced:?}"
        );
        assert_eq!(
            sessions.peer_admission.charged(),
            0,
            "the retired pair returned its slot"
        );
    }

    /// A stand-in worker that answers the replay every attach asks for.
    fn spawn_replay_worker(registry: &SessionRegistry, id: Uuid) -> tokio::task::JoinHandle<()> {
        let (binding, mut commands) = crate::rtc::tests::insert_test_worker(registry, id);
        let control = registry.control_for_binding(binding).unwrap();
        tokio::spawn(async move {
            while let Some(command) = commands.recv().await {
                if let crate::pty::WorkerCmd::Replay { resp, .. } = command {
                    let _ = resp.send(Ok(crate::pty::WorkerReplay::new(
                        control.source_offset(),
                        vec![],
                    )));
                }
            }
        })
    }

    /// Open the first channel of an attachment to `session`, whose
    /// transition the caller holds, and return once the daemon's attach for
    /// it is parked on that transition: the lock then has a second holder,
    /// the attach's own wait. Whatever else the attach holds while it waits
    /// there, it holds from this point on.
    async fn begin_attach_that_waits(
        registry: &SessionRegistry,
        pc: &Arc<RTCPeerConnection>,
        session: Uuid,
    ) -> Arc<RTCDataChannel> {
        assert_eq!(
            registry.generation_transition_holders(session),
            1,
            "the caller holds the session's transition, and nothing else does yet"
        );
        let channel = pc
            .create_data_channel(
                &format!("spawn.pty/{session}/{}/{}", Uuid::new_v4(), Uuid::new_v4()),
                None,
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while registry.generation_transition_holders(session) < 2 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the attach reached the session's transition and is waiting on it");
        channel
    }

    /// A session that is restarting holds its generation transition for as
    /// long as its old worker takes to go: the peers close, TERM, the wait
    /// for the socket, KILL. An attach for it waits there, and must not sit
    /// on the daemon-wide admission lock while it does — every offer and
    /// every other attach on the daemon serializes on that lock, so one
    /// device opening a restarting window would stall every other device.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_attach_waiting_on_a_restarting_session_does_not_hold_admission() {
        let sessions = RtcSessions::new();
        sessions.bind_registered_host_id(Uuid::new_v4()).await;
        let registry = SessionRegistry::new();
        let steady = Uuid::new_v4();
        let restarting = Uuid::new_v4();
        let workers = [
            spawn_replay_worker(&registry, steady),
            spawn_replay_worker(&registry, restarting),
        ];
        let first = connect_pair(&sessions, &registry, [14; 32]).await;
        let second = connect_pair(&sessions, &registry, [15; 32]).await;

        let transition = registry.lock_generation_transition(restarting).await;
        let _waiting = begin_attach_that_waits(&registry, &first, restarting).await;

        let attached =
            tokio::time::timeout(Duration::from_secs(5), attach_answered(&second, steady)).await;
        let admission_free = sessions.admission.try_lock().is_ok();
        drop(transition);
        assert!(
            attached.is_ok(),
            "another device's attach to another session waited on a restarting session's transition"
        );
        assert!(
            admission_free,
            "an attach waiting on a session's transition holds the admission lock"
        );
        sessions.close_all().await;
        let _ = first.close().await;
        let _ = second.close().await;
        for worker in workers {
            worker.abort();
        }
    }

    /// One device, two windows: the one it opens first is restarting and
    /// its attach waits on that session's transition. The acceptor must not
    /// wait with it — the window opened next is on the same connection, and
    /// so is every channel the device opens until the restart is over.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_channel_waiting_on_admission_does_not_hold_up_the_next_on_its_connection() {
        let sessions = RtcSessions::new();
        sessions.bind_registered_host_id(Uuid::new_v4()).await;
        let registry = SessionRegistry::new();
        let steady = Uuid::new_v4();
        let restarting = Uuid::new_v4();
        let workers = [
            spawn_replay_worker(&registry, steady),
            spawn_replay_worker(&registry, restarting),
        ];
        let pc = connect_pair(&sessions, &registry, [16; 32]).await;

        let transition = registry.lock_generation_transition(restarting).await;
        let waiting = begin_attach_that_waits(&registry, &pc, restarting).await;

        let attached =
            tokio::time::timeout(Duration::from_secs(5), attach_answered(&pc, steady)).await;
        let (consumer, mut consumer_rx) = open_host_consumer(&pc).await;
        let consumer_admitted =
            consumer_answers(&consumer, &mut consumer_rx, Duration::from_secs(5)).await;
        let still_waiting = registry.generation_transition_holders(restarting);
        drop(transition);
        assert_eq!(
            still_waiting, 2,
            "the first window's attach is still parked on its session's transition"
        );
        assert!(
            attached.is_ok(),
            "a terminal waited behind another window's attach on the same connection"
        );
        assert!(
            consumer_admitted,
            "a host channel waited behind a window's attach on the same connection"
        );
        // The attach that waited is admitted once the restart lets go: the
        // device's second channel for it completes the attachment.
        let suffix = waiting
            .label()
            .strip_prefix("spawn.pty/")
            .unwrap()
            .to_owned();
        let ctl = pc
            .create_data_channel(&format!("spawn.ctl/{suffix}"), None)
            .await
            .unwrap();
        assert!(
            control_answers(&ctl, Duration::from_secs(5)).await,
            "the attach that waited on the transition completes after it"
        );
        drop(consumer);
        sessions.close_all().await;
        let _ = pc.close().await;
        for worker in workers {
            worker.abort();
        }
    }

    /// A device can open channels faster than they are admitted, and while
    /// admission is held — another device's offer, trust invalidation —
    /// each one waits there, holding its channel, its stream and the
    /// connection. No more wait than the pair could hold at once: the rest
    /// are refused there and then, admission still held, and the pair
    /// works as before once admission is free.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn channels_past_the_admission_bound_are_refused_and_the_pair_keeps_working() {
        const EXCESS: usize = 8;
        let sessions = RtcSessions::new();
        sessions.bind_registered_host_id(Uuid::new_v4()).await;
        let registry = SessionRegistry::new();
        let session = Uuid::new_v4();
        let worker = spawn_replay_worker(&registry, session);
        let pc = connect_pair(&sessions, &registry, [19; 32]).await;
        let pair = sessions
            .host_peers
            .lock()
            .await
            .values()
            .next()
            .and_then(|peer| peer.pair.clone())
            .unwrap();
        let (probe, mut probe_rx) = open_host_consumer(&pc).await;
        assert!(
            consumer_answers(&probe, &mut probe_rx, Duration::from_secs(5)).await,
            "a channel opens on a fresh pair"
        );

        let refused = |flood: &[Arc<RTCDataChannel>]| {
            flood
                .iter()
                .filter(|channel| channel.ready_state() == RTCDataChannelState::Closed)
                .count()
        };
        let admission = Arc::clone(&sessions.admission).lock_owned().await;
        // Opened a few at a time, each few accounted for — waiting or
        // refused — before the next: the association queues sixteen new
        // streams for its acceptor and drops the DATA of any more until
        // the device retransmits, which would make this test's pace SCTP's
        // retransmission backoff.
        let mut flood = Vec::new();
        let settled = tokio::time::timeout(Duration::from_secs(60), async {
            while flood.len() < MAX_PAIR_PENDING_CHANNELS + EXCESS {
                let batch = (MAX_PAIR_PENDING_CHANNELS + EXCESS - flood.len()).min(8);
                for _ in 0..batch {
                    flood.push(
                        pc.create_data_channel(&format!("spawn.host.ctl/{}", Uuid::new_v4()), None)
                            .await
                            .unwrap(),
                    );
                }
                while refused(&flood) + pair.pending_channels.load(Ordering::Acquire) < flood.len()
                {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            }
        })
        .await;
        let (closed, waiting) = (
            refused(&flood),
            pair.pending_channels.load(Ordering::Acquire),
        );
        drop(admission);

        // The channels that waited are decided once admission is free (the
        // host consumers among them up to their own cap), and then a window
        // opens on the pair as on any other.
        let drained = tokio::time::timeout(Duration::from_secs(30), async {
            while pair.pending_channels.load(Ordering::Acquire) > 0 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        let attached =
            tokio::time::timeout(Duration::from_secs(10), attach_answered(&pc, session)).await;
        let probe_answers = consumer_answers(&probe, &mut probe_rx, Duration::from_secs(5)).await;
        let resident = sessions.host_peers.lock().await.len();
        sessions.close_all().await;
        let _ = pc.close().await;
        worker.abort();
        assert!(
            settled.is_ok(),
            "{closed} channel(s) refused and {waiting} waiting of {} opened with admission held",
            flood.len()
        );
        assert_eq!(
            (closed, waiting),
            (EXCESS, MAX_PAIR_PENDING_CHANNELS),
            "exactly the channels past the bound are refused while admission is held"
        );
        assert!(
            drained.is_ok(),
            "the waiting channels were decided once admission was free"
        );
        assert!(
            attached.is_ok(),
            "a window opens on the pair after the flood"
        );
        assert!(
            probe_answers,
            "a channel admitted before the flood still answers"
        );
        assert_eq!(resident, 1, "the pair stayed in service");
    }

    /// A terminal's label names its session, and the device chooses it. One
    /// naming no session this daemon runs is refused at once: it takes no
    /// transition, which would otherwise be a lock made for that id alone,
    /// held while it waits behind admission and scanned by every later
    /// transition on the daemon.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_attach_for_a_session_this_daemon_does_not_run_is_refused_without_waiting() {
        let sessions = RtcSessions::new();
        sessions.bind_registered_host_id(Uuid::new_v4()).await;
        let registry = SessionRegistry::new();
        let pc = connect_pair(&sessions, &registry, [20; 32]).await;

        let admission = Arc::clone(&sessions.admission).lock_owned().await;
        let unknown = Uuid::new_v4();
        let channel = pc
            .create_data_channel(
                &format!("spawn.pty/{unknown}/{}/{}", Uuid::new_v4(), Uuid::new_v4()),
                None,
            )
            .await
            .unwrap();
        let refused = tokio::time::timeout(Duration::from_secs(5), async {
            while channel.ready_state() != RTCDataChannelState::Closed {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await;
        let holders = registry.generation_transition_holders(unknown);
        drop(admission);
        sessions.close_all().await;
        let _ = pc.close().await;
        assert!(
            refused.is_ok(),
            "an attach for a session nobody runs waited behind admission"
        );
        assert_eq!(
            holders, 0,
            "an attach for a session nobody runs took its transition"
        );
    }

    /// The other side of the refusal above: a session that is not
    /// registered yet but whose launch holds its transition is about to
    /// exist, and an attach for it waits for the launch as it always has.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_attach_for_a_session_being_launched_waits_for_the_launch() {
        let sessions = RtcSessions::new();
        sessions.bind_registered_host_id(Uuid::new_v4()).await;
        let registry = SessionRegistry::new();
        let launching = Uuid::new_v4();
        let pc = connect_pair(&sessions, &registry, [21; 32]).await;

        let launch = registry.lock_generation_transition(launching).await;
        let waiting = begin_attach_that_waits(&registry, &pc, launching).await;
        let worker = spawn_replay_worker(&registry, launching);
        drop(launch);

        let suffix = waiting
            .label()
            .strip_prefix("spawn.pty/")
            .unwrap()
            .to_owned();
        let ctl = pc
            .create_data_channel(&format!("spawn.ctl/{suffix}"), None)
            .await
            .unwrap();
        let attached = control_answers(&ctl, Duration::from_secs(5)).await;
        sessions.close_all().await;
        let _ = pc.close().await;
        worker.abort();
        assert!(
            attached,
            "an attach for a session being launched was refused"
        );
    }

    /// A device connection outlives the control connection its offer came
    /// on: the daemon keeps its peers across a reconnect. A window attached
    /// on it afterwards works, and what the daemon reports for it — that
    /// someone is typing, which is all the server ever learns of input —
    /// goes out on the connection that is live now, once that connection is
    /// registered, not on the one the offer arrived on.
    #[tokio::test]
    async fn a_pair_admitted_before_a_reconnect_reports_input_on_the_live_connection() {
        let sessions = RtcSessions::new();
        sessions.bind_registered_host_id(Uuid::new_v4()).await;
        let registry = SessionRegistry::new();
        let early = Uuid::new_v4();
        let late = Uuid::new_v4();
        let (input_tx, mut input_rx) = mpsc::unbounded_channel();
        let mut workers = Vec::new();
        for id in [early, late] {
            let (binding, mut commands) = crate::rtc::tests::insert_test_worker(&registry, id);
            let control = registry.control_for_binding(binding).unwrap();
            let input_tx = input_tx.clone();
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
                            let _ = input_tx.send((id, bytes.to_vec()));
                        }
                        _ => {}
                    }
                }
            }));
        }
        // The control connection the offer arrives on ends with this call:
        // its receiving half is dropped when the pair is connected.
        let pc = connect_pair(&sessions, &registry, [18; 32]).await;
        assert_eq!(sessions.host_peers.lock().await.len(), 1);

        // The control socket drops and a new one connects. Its `register`
        // is not acknowledged yet.
        sessions.clear_ws_sender();
        let (live_tx, mut live_rx) = mpsc::channel(64);
        sessions.install_ws_sender(live_tx);
        let mut input_activity = move || {
            let mut reported = Vec::new();
            while let Ok(frame) = live_rx.try_recv() {
                let value: Value = serde_json::from_str(frame.as_str()).unwrap();
                if value["type"] == "session.input_activity" {
                    reported.push(value["session_id"].as_str().unwrap().to_owned());
                }
            }
            reported
        };

        let (early_pty, _early_ctl) = attach(&pc, early).await;
        early_pty.send(&Bytes::from_static(b"typed")).await.unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), input_rx.recv())
                .await
                .expect("input reaches the session while the control connection registers")
                .unwrap(),
            (early, b"typed".to_vec())
        );
        assert!(
            input_activity().is_empty(),
            "nothing but `register` goes out before the server acknowledges it"
        );

        // Registered: the replay has run.
        sessions.reannounce_live_statuses(&HashSet::new()).await;
        let (late_pty, _late_ctl) = attach(&pc, late).await;
        late_pty.send(&Bytes::from_static(b"typed")).await.unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), input_rx.recv())
                .await
                .expect("input reaches the session after the reconnect")
                .unwrap(),
            (late, b"typed".to_vec())
        );
        let reported = input_activity();
        sessions.close_all().await;
        let _ = pc.close().await;
        for worker in workers {
            worker.abort();
        }
        assert_eq!(
            reported,
            [late.to_string()],
            "input on a pair admitted before the reconnect is reported on the live control connection"
        );
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
            pending_channels: AtomicUsize::new(0),
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
}
