//! Fixed server-signaling capability for the protected host-control channel.
//!
//! This complete module is guarded as one reviewed unit. The protected
//! host-control module can request only the content-free `connected` status;
//! it never receives the underlying server sender, binding, or session ID.

use crate::rtc::{try_send_host_status, HostRtcBinding, RtcWsSender};

#[derive(Clone)]
pub(crate) struct HostConnectedSignal {
    signaling: RtcWsSender,
    session_id: String,
    binding: HostRtcBinding,
}

impl HostConnectedSignal {
    pub(crate) fn new(signaling: RtcWsSender, session_id: String, binding: HostRtcBinding) -> Self {
        Self {
            signaling,
            session_id,
            binding,
        }
    }

    pub(crate) fn publish(&self) -> bool {
        try_send_host_status(
            &self.signaling,
            self.session_id.clone(),
            &self.binding,
            "connected",
        )
    }
}
