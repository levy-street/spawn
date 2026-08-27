//! spawnd library surface.
//!
//! The `sessiond` subtree contains pieces shared between the supervisor and
//! worker binaries. `signed_signal` is the transport-independent identity
//! foundation shared with browser golden vectors. Everything else (WS client,
//! WebRTC, supervisor, CLI) stays private to the `spawnd` binary.

pub mod acct_endorsement;
pub mod browser_endorsement;
pub mod endorsement_chain;
pub mod host_pair_approval;
pub mod host_pair_possession;
/// The one macOS consent moment, and the handshake the desktop app uses to put
/// a screen in front of it. Shared for the same reason `secret_file` is: both
/// sides must agree on the files exactly.
pub mod permissions;
pub mod sas;
/// How a secret is put on disk. Shared with the macOS companion, which keeps
/// its own record in its own directory but must handle it exactly as `creds.rs`
/// handles the daemon's — atomically, 0600, `NOFOLLOW`, under a lock.
pub mod secret_file;
pub mod sessiond;
pub mod signed_signal;
pub mod signed_signal_wire;
pub mod version;
