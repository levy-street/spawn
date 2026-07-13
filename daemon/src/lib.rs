//! spawnd library surface.
//!
//! Only the `sessiond` subtree lives here: the pieces shared between the
//! `spawnd` supervisor binary, the `spawn-worker` per-agent binary, and the
//! integration tests. Everything else (WS client, WebRTC, tmux backend, CLI)
//! stays private to the `spawnd` binary.

pub mod sessiond;
