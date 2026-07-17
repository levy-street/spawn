//! Fixed server-signaling capability for the protected host-control channel.
//!
//! This complete module is guarded as one reviewed unit. The protected
//! host-control module can request only the content-free `connected` status;
//! it never receives the underlying server sender, binding, or session ID.

use tokio::sync::mpsc;

use crate::pty::WsOutbound;
use crate::rtc::{try_send_host_status, HostRtcBinding};

#[derive(Clone)]
pub(crate) struct HostConnectedSignal {
    out_tx: mpsc::Sender<WsOutbound>,
    session_id: String,
    binding: HostRtcBinding,
}

impl HostConnectedSignal {
    pub(crate) fn new(
        out_tx: mpsc::Sender<WsOutbound>,
        session_id: String,
        binding: HostRtcBinding,
    ) -> Self {
        Self {
            out_tx,
            session_id,
            binding,
        }
    }

    pub(crate) fn publish(&self) -> bool {
        try_send_host_status(
            &self.out_tx,
            self.session_id.clone(),
            &self.binding,
            "connected",
        )
    }
}
