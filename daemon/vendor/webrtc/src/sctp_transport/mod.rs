#[cfg(test)]
mod sctp_transport_test;

pub mod sctp_transport_capabilities;
pub mod sctp_transport_state;

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use arc_swap::ArcSwapOption;
use data::data_channel::DataChannel;
use data::message::message_channel_open::ChannelType;
use portable_atomic::{AtomicBool, AtomicU32, AtomicU8};
use sctp::association::Association;
use sctp::chunk::chunk_payload_data::PayloadProtocolIdentifier;
use sctp::stream::Stream;
use sctp_transport_state::RTCSctpTransportState;
use tokio::sync::{Mutex, Notify};
use util::Conn;

use crate::api::setting_engine::SettingEngine;
use crate::data_channel::data_channel_parameters::DataChannelParameters;
use crate::data_channel::data_channel_state::RTCDataChannelState;
use crate::data_channel::RTCDataChannel;
use crate::dtls_transport::dtls_role::DTLSRole;
use crate::dtls_transport::*;
use crate::error::*;
use crate::sctp_transport::sctp_transport_capabilities::SCTPTransportCapabilities;
use crate::stats::stats_collector::StatsCollector;
use crate::stats::StatsReportType::{PeerConnection, SCTPTransport};
use crate::stats::{ICETransportStats, PeerConnectionStats};

const SCTP_MAX_CHANNELS: u16 = u16::MAX;

/// Streams that may fail to become data channels on one association before
/// the acceptor stops it. A peer abandons an open only when the open took
/// longer than it would wait, and anything else (a first message that is not
/// an OPEN, a label that is not UTF-8) is a peer not speaking DCEP: a
/// connection that has lost this many is better replaced than served. The
/// stop ends the acceptor as any closed association does, and its `on_error`
/// handler hears of it.
pub const MAX_FAILED_DATA_CHANNEL_STREAMS: u32 = 64;

/// Failed streams on one association that are logged one by one; the rest
/// are counted, and the stop at `MAX_FAILED_DATA_CHANNEL_STREAMS` is logged.
const LOGGED_FAILED_DATA_CHANNEL_STREAMS: u32 = 3;

/// What became of one stream the association handed the acceptor.
enum AcceptedStream {
    Channel(DataChannel),
    /// The stream never became a channel; the error says why.
    Failed(data::Error, Arc<Stream>),
    /// The association has no more streams to give: it closed.
    Ended,
}

pub type OnDataChannelHdlrFn = Box<
    dyn (FnMut(Arc<RTCDataChannel>) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>>)
        + Send
        + Sync,
>;

pub type OnDataChannelOpenedHdlrFn = Box<
    dyn (FnMut(Arc<RTCDataChannel>) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>>)
        + Send
        + Sync,
>;

#[derive(Default)]
pub(crate) struct DataChannelRegistry {
    pub(crate) channels: Vec<Arc<RTCDataChannel>>,
    closed: u32,
    // Closed is observable before the SCTP reset handshake completes. Preserve
    // the existing no-reuse policy without retaining channel objects forever.
    // The u16 namespace bounds this set independently of channel churn.
    retired_ids: HashSet<u16>,
}

impl DataChannelRegistry {
    pub(crate) fn insert(&mut self, channel: Arc<RTCDataChannel>) {
        self.channels.retain(|channel| {
            if channel.ready_state() == RTCDataChannelState::Closed {
                self.closed = self.closed.saturating_add(1);
                self.retired_ids.insert(channel.id());
                false
            } else {
                true
            }
        });
        self.channels.push(channel);
    }

    pub(crate) fn clear(&mut self) {
        self.closed = self.closed.saturating_add(self.channels.len() as u32);
        self.channels.clear();
    }
}

struct AcceptDataChannelParams {
    notify_rx: Arc<Notify>,
    sctp_association: Arc<Association>,
    data_channels: Arc<Mutex<DataChannelRegistry>>,
    on_error_handler: Arc<ArcSwapOption<Mutex<OnErrorHdlrFn>>>,
    on_data_channel_handler: Arc<ArcSwapOption<Mutex<OnDataChannelHdlrFn>>>,
    on_data_channel_opened_handler: Arc<ArcSwapOption<Mutex<OnDataChannelOpenedHdlrFn>>>,
    data_channels_opened: Arc<AtomicU32>,
    data_channels_accepted: Arc<AtomicU32>,
    setting_engine: Arc<SettingEngine>,
}

/// SCTPTransport provides details about the SCTP transport.
#[derive(Default)]
pub struct RTCSctpTransport {
    pub(crate) dtls_transport: Arc<RTCDtlsTransport>,

    // State represents the current state of the SCTP transport.
    state: AtomicU8, // RTCSctpTransportState

    // SCTPTransportState doesn't have an enum to distinguish between New/Connecting
    // so we need a dedicated field
    is_started: AtomicBool,

    // max_channels represents the maximum amount of DataChannel's that can
    // be used simultaneously.
    max_channels: u16,

    sctp_association: Mutex<Option<Arc<Association>>>,

    on_error_handler: Arc<ArcSwapOption<Mutex<OnErrorHdlrFn>>>,
    on_data_channel_handler: Arc<ArcSwapOption<Mutex<OnDataChannelHdlrFn>>>,
    on_data_channel_opened_handler: Arc<ArcSwapOption<Mutex<OnDataChannelOpenedHdlrFn>>>,

    // DataChannels
    pub(crate) data_channels: Arc<Mutex<DataChannelRegistry>>,
    pub(crate) data_channels_opened: Arc<AtomicU32>,
    pub(crate) data_channels_requested: Arc<AtomicU32>,
    data_channels_accepted: Arc<AtomicU32>,

    notify_tx: Arc<Notify>,

    setting_engine: Arc<SettingEngine>,
}

impl RTCSctpTransport {
    pub(crate) fn new(
        dtls_transport: Arc<RTCDtlsTransport>,
        setting_engine: Arc<SettingEngine>,
    ) -> Self {
        RTCSctpTransport {
            dtls_transport,
            state: AtomicU8::new(RTCSctpTransportState::Connecting as u8),
            is_started: AtomicBool::new(false),
            max_channels: SCTP_MAX_CHANNELS,
            sctp_association: Mutex::new(None),
            on_error_handler: Arc::new(ArcSwapOption::empty()),
            on_data_channel_handler: Arc::new(ArcSwapOption::empty()),
            on_data_channel_opened_handler: Arc::new(ArcSwapOption::empty()),

            data_channels: Arc::new(Mutex::new(DataChannelRegistry::default())),
            data_channels_opened: Arc::new(AtomicU32::new(0)),
            data_channels_requested: Arc::new(AtomicU32::new(0)),
            data_channels_accepted: Arc::new(AtomicU32::new(0)),

            notify_tx: Arc::new(Notify::new()),

            setting_engine,
        }
    }

    /// transport returns the DTLSTransport instance the SCTPTransport is sending over.
    pub fn transport(&self) -> Arc<RTCDtlsTransport> {
        Arc::clone(&self.dtls_transport)
    }

    /// get_capabilities returns the SCTPCapabilities of the SCTPTransport.
    pub fn get_capabilities(&self) -> SCTPTransportCapabilities {
        SCTPTransportCapabilities {
            max_message_size: 0,
        }
    }

    /// Start the SCTPTransport. Since both local and remote parties must mutually
    /// create an SCTPTransport, SCTP SO (Simultaneous Open) is used to establish
    /// a connection over SCTP.
    pub async fn start(
        &self,
        remote_caps: SCTPTransportCapabilities,
        local_port: u16,
        remote_port: u16,
    ) -> Result<()> {
        if self.is_started.load(Ordering::SeqCst) {
            return Ok(());
        }
        self.is_started.store(true, Ordering::SeqCst);

        let dtls_transport = self.transport();

        let max_message_size = Self::calc_message_size(
            remote_caps.max_message_size,
            self.setting_engine.sctp_max_message_size_can_send.as_u32(),
        );

        if let Some(net_conn) = &dtls_transport.conn().await {
            let sctp_association = loop {
                tokio::select! {
                    _ = self.notify_tx.notified() => {
                        // It seems like notify_tx is only notified on Stop so perhaps this check
                        // is redundant.
                        // TODO: Consider renaming notify_tx to shutdown_tx.
                        if self.state.load(Ordering::SeqCst) == RTCSctpTransportState::Closed as u8 {
                            return Err(Error::ErrSCTPTransportDTLS);
                        }
                    },
                    association = sctp::association::Association::client(sctp::association::Config {
                        net_conn: Arc::clone(net_conn) as Arc<dyn Conn + Send + Sync>,
                        max_receive_buffer_size: 0,
                        max_message_size,
                        mtu: 0,
                        name: String::new(),
                        local_port,
                        remote_port,
                    }) => {
                        break Arc::new(association?);
                    }
                };
            };

            {
                let mut sa = self.sctp_association.lock().await;
                *sa = Some(Arc::clone(&sctp_association));
            }
            self.state
                .store(RTCSctpTransportState::Connected as u8, Ordering::SeqCst);

            let param = AcceptDataChannelParams {
                notify_rx: self.notify_tx.clone(),
                sctp_association,
                data_channels: Arc::clone(&self.data_channels),
                on_error_handler: Arc::clone(&self.on_error_handler),
                on_data_channel_handler: Arc::clone(&self.on_data_channel_handler),
                on_data_channel_opened_handler: Arc::clone(&self.on_data_channel_opened_handler),
                data_channels_opened: Arc::clone(&self.data_channels_opened),
                data_channels_accepted: Arc::clone(&self.data_channels_accepted),
                setting_engine: Arc::clone(&self.setting_engine),
            };
            tokio::spawn(async move {
                RTCSctpTransport::accept_data_channels(param).await;
            });

            Ok(())
        } else {
            Err(Error::ErrSCTPTransportDTLS)
        }
    }

    /// Stop stops the SCTPTransport
    pub async fn stop(&self) -> Result<()> {
        {
            let mut sctp_association = self.sctp_association.lock().await;
            if let Some(sa) = sctp_association.take() {
                sa.close().await?;
            }
        }

        self.state
            .store(RTCSctpTransportState::Closed as u8, Ordering::SeqCst);

        self.notify_tx.notify_waiters();

        Ok(())
    }

    /// `DataChannel::accept`, keeping hold of a stream that fails to become a
    /// channel so that the caller can reset it: the same steps, in the same
    /// order, with the same result for every stream that does.
    async fn accept_stream(
        association: &Arc<Association>,
        config: data::data_channel::Config,
        existing_channels: &[Arc<DataChannel>],
    ) -> AcceptedStream {
        let Some(stream) = association.accept_stream().await else {
            return AcceptedStream::Ended;
        };
        stream.set_default_payload_type(PayloadProtocolIdentifier::Binary);
        if let Some(existing) = existing_channels
            .iter()
            .find(|channel| channel.stream_identifier() == stream.stream_identifier())
        {
            return AcceptedStream::Channel(DataChannel::clone(existing));
        }
        match DataChannel::server(Arc::clone(&stream), config).await {
            Ok(dc) => AcceptedStream::Channel(dc),
            Err(err) => AcceptedStream::Failed(err, stream),
        }
    }

    async fn accept_data_channels(param: AcceptDataChannelParams) {
        let dcs = param.data_channels.lock().await;
        let mut existing_data_channels = Vec::new();
        for dc in &dcs.channels {
            if let Some(dc) = dc.data_channel.lock().await.clone() {
                existing_data_channels.push(dc);
            }
        }
        drop(dcs);

        let mut failed_streams = 0u32;
        loop {
            let dc = tokio::select! {
                _ = param.notify_rx.notified() => break,
                accepted = Self::accept_stream(
                    &param.sctp_association,
                    data::data_channel::Config {
                        max_message_size: param.sctp_association.max_message_size(),
                        ..data::data_channel::Config::default()
                    },
                    &existing_data_channels,
                ) => {
                    match accepted {
                        AcceptedStream::Channel(dc) => dc,
                        // The association has no more streams to give:
                        // it closed. That is how every peer connection
                        // ends, so it is not logged as an error here;
                        // `on_error` hears of it, and whoever installed a
                        // handler knows whether the close was its own.
                        AcceptedStream::Ended => {
                            let err = data::Error::ErrStreamClosed;
                            log::debug!("Data channel acceptor ended: {err}");
                            if let Some(handler) = &*param.on_error_handler.load() {
                                let mut f = handler.lock().await;
                                f(err.into()).await;
                            }
                            break;
                        }
                        // One stream never became a channel: reset before
                        // its OPEN was read, a first message that was not an
                        // OPEN, an acknowledgement its stream refused. That
                        // is the end of that stream, not of the acceptor:
                        // upstream broke out here, without a word, and the
                        // connection accepted nothing ever again.
                        AcceptedStream::Failed(err, stream) => {
                            failed_streams += 1;
                            if failed_streams <= LOGGED_FAILED_DATA_CHANNEL_STREAMS {
                                log::warn!(
                                    "Failed to accept one data channel; still accepting: {err}"
                                );
                                if failed_streams == LOGGED_FAILED_DATA_CHANNEL_STREAMS {
                                    log::warn!(
                                        "Further streams that fail to become data channels on this association are counted, not logged"
                                    );
                                }
                            }
                            // Reset, so the peer learns the stream is gone
                            // and both associations forget it; upstream left
                            // it registered with nobody reading it. A stream
                            // the peer reset already is unregistered, and
                            // this is a no-op for it. In a task of its own:
                            // the reset queues behind a writer waiting for
                            // room, as an ACK does, and must not hold the
                            // acceptor there.
                            tokio::spawn(async move {
                                let _ = stream.shutdown(std::net::Shutdown::Both).await;
                            });
                            if failed_streams == MAX_FAILED_DATA_CHANNEL_STREAMS {
                                log::warn!(
                                    "{failed_streams} streams failed to become data channels on this association; stopping it"
                                );
                                // What is still queued drains as failures,
                                // and then the acceptor ends as above.
                                let _ = param.sctp_association.close().await;
                            }
                            continue;
                        }
                    }
                }
            };

            let mut max_retransmits = None;
            let mut max_packet_life_time = None;
            let val = dc.config.reliability_parameter as u16;
            let ordered;

            match dc.config.channel_type {
                ChannelType::Reliable => {
                    ordered = true;
                }
                ChannelType::ReliableUnordered => {
                    ordered = false;
                }
                ChannelType::PartialReliableRexmit => {
                    ordered = true;
                    max_retransmits = Some(val);
                }
                ChannelType::PartialReliableRexmitUnordered => {
                    ordered = false;
                    max_retransmits = Some(val);
                }
                ChannelType::PartialReliableTimed => {
                    ordered = true;
                    max_packet_life_time = Some(val);
                }
                ChannelType::PartialReliableTimedUnordered => {
                    ordered = false;
                    max_packet_life_time = Some(val);
                }
            };

            let negotiated = if dc.config.negotiated {
                Some(dc.stream_identifier())
            } else {
                None
            };
            let rtc_dc = Arc::new(RTCDataChannel::new(
                DataChannelParameters {
                    label: dc.config.label.clone(),
                    protocol: dc.config.protocol.clone(),
                    negotiated,
                    ordered,
                    max_packet_life_time,
                    max_retransmits,
                },
                Arc::clone(&param.setting_engine),
            ));

            // This transport's handler is called here, in the order channels
            // arrive, and what it returns runs in a task of the channel's
            // own. In a peer connection that handler is a wrapper that only
            // builds a future: the application's `on_data_channel` handler
            // is first called inside it, in the channel's task, so in
            // whatever order the scheduler runs those tasks, not strictly
            // in arrival order (PATCHES.md). Upstream awaited the future in
            // this loop, so one channel whose admission waited — on a lock,
            // on anything — held up every channel behind it on the
            // connection, and a peer that gave up on those and reset them
            // was resetting streams nobody had read yet. Each channel still
            // sees its own steps in upstream's order: the handler's future
            // completes, the channel is registered, and only then is it
            // opened and read.
            let admission = match &*param.on_data_channel_handler.load() {
                Some(handler) => {
                    let mut f = handler.lock().await;
                    Some(f(Arc::clone(&rtc_dc)))
                }
                None => None,
            };
            let data_channels = Arc::clone(&param.data_channels);
            let data_channels_accepted = Arc::clone(&param.data_channels_accepted);
            let data_channels_opened = Arc::clone(&param.data_channels_opened);
            let on_data_channel_opened_handler = Arc::clone(&param.on_data_channel_opened_handler);
            tokio::spawn(async move {
                if let Some(admission) = admission {
                    admission.await;

                    data_channels_accepted.fetch_add(1, Ordering::SeqCst);

                    let mut dcs = data_channels.lock().await;
                    dcs.insert(Arc::clone(&rtc_dc));
                }

                rtc_dc.handle_open(Arc::new(dc)).await;

                if let Some(handler) = &*on_data_channel_opened_handler.load() {
                    let mut f = handler.lock().await;
                    f(rtc_dc).await;
                    data_channels_opened.fetch_add(1, Ordering::SeqCst);
                }
            });
        }
    }

    /// on_error sets an event handler which is invoked when
    /// the SCTP connection error occurs.
    pub fn on_error(&self, f: OnErrorHdlrFn) {
        self.on_error_handler.store(Some(Arc::new(Mutex::new(f))));
    }

    /// on_data_channel sets an event handler which is invoked when a data
    /// channel message arrives from a remote peer.
    pub fn on_data_channel(&self, f: OnDataChannelHdlrFn) {
        self.on_data_channel_handler
            .store(Some(Arc::new(Mutex::new(f))));
    }

    /// on_data_channel_opened sets an event handler which is invoked when a data
    /// channel is opened
    pub fn on_data_channel_opened(&self, f: OnDataChannelOpenedHdlrFn) {
        self.on_data_channel_opened_handler
            .store(Some(Arc::new(Mutex::new(f))));
    }

    fn calc_message_size(remote_max_message_size: u32, can_send_size: u32) -> u32 {
        if remote_max_message_size == 0 && can_send_size == 0 {
            u32::MAX
        } else if remote_max_message_size == 0 {
            can_send_size
        } else if can_send_size == 0 || can_send_size > remote_max_message_size {
            remote_max_message_size
        } else {
            can_send_size
        }
    }

    /// max_channels is the maximum number of RTCDataChannels that can be open simultaneously.
    pub fn max_channels(&self) -> u16 {
        if self.max_channels == 0 {
            SCTP_MAX_CHANNELS
        } else {
            self.max_channels
        }
    }

    /// state returns the current state of the SCTPTransport
    pub fn state(&self) -> RTCSctpTransportState {
        self.state.load(Ordering::SeqCst).into()
    }

    pub(crate) async fn collect_stats(
        &self,
        collector: &StatsCollector,
        peer_connection_id: String,
    ) {
        let dtls_transport = self.transport();

        // TODO: should this be collected?
        dtls_transport.collect_stats(collector).await;

        // data channels
        let data_channels = self.data_channels.lock().await;
        let mut data_channels_closed = data_channels.closed;
        for data_channel in &data_channels.channels {
            match data_channel.ready_state() {
                RTCDataChannelState::Connecting => (),
                RTCDataChannelState::Open => (),
                _ => data_channels_closed = data_channels_closed.saturating_add(1),
            }
            data_channel.collect_stats(collector).await;
        }

        let mut reports = HashMap::new();
        let peer_connection_stats =
            PeerConnectionStats::new(self, peer_connection_id.clone(), data_channels_closed);
        reports.insert(peer_connection_id, PeerConnection(peer_connection_stats));

        // conn
        if let Some(agent) = dtls_transport.ice_transport.gatherer.get_agent().await {
            let stats = ICETransportStats::new("sctp_transport".to_owned(), agent);
            reports.insert(stats.id.clone(), SCTPTransport(stats));
        }

        collector.merge(reports);
    }

    pub(crate) async fn generate_and_set_data_channel_id(
        &self,
        dtls_role: DTLSRole,
    ) -> Result<u16> {
        let mut id = 0u16;
        if dtls_role != DTLSRole::Client {
            id += 1;
        }

        // Create map of ids so we can compare without double-looping each time.
        let mut ids_map = HashSet::new();
        {
            let data_channels = self.data_channels.lock().await;
            ids_map.extend(data_channels.retired_ids.iter().copied());
            for dc in &data_channels.channels {
                ids_map.insert(dc.id());
            }
        }

        let max = self.max_channels();
        while id < max - 1 {
            if ids_map.contains(&id) {
                id += 2;
            } else {
                return Ok(id);
            }
        }

        Err(Error::ErrMaxDataChannelID)
    }

    pub(crate) async fn association(&self) -> Option<Arc<Association>> {
        let sctp_association = self.sctp_association.lock().await;
        sctp_association.clone()
    }

    pub(crate) fn data_channels_accepted(&self) -> u32 {
        self.data_channels_accepted.load(Ordering::SeqCst)
    }

    pub(crate) fn data_channels_opened(&self) -> u32 {
        self.data_channels_opened.load(Ordering::SeqCst)
    }

    pub(crate) fn data_channels_requested(&self) -> u32 {
        self.data_channels_requested.load(Ordering::SeqCst)
    }
}
