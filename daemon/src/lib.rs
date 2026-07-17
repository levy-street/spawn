//! spawnd library surface.
//!
//! The `sessiond` subtree contains pieces shared between the supervisor and
//! worker binaries. `signed_signal` is the transport-independent identity
//! foundation shared with browser golden vectors. Everything else (WS client,
//! WebRTC, supervisor, CLI) stays private to the `spawnd` binary.

pub mod sessiond;
pub mod signed_signal;
