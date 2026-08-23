//! sessiond — the purpose-built session layer (docs/SESSIOND.md).
//!
//! A *session worker* is one process per session that owns the session's PTY,
//! keeps an encrypted-at-rest scrollback log plus a plaintext, geometry-bounded
//! headless checkpoint grid, and speaks a small framed protocol over a unix
//! domain socket to the supervising `spawnd`. The modules here are deliberately
//! self-contained (no dependency on the spawnd binary's private modules) so
//! that the worker binary and the integration tests can share them.

pub mod emulator;
pub mod endpoint;
pub mod foreground;
pub mod scrollback;
pub mod secret;
pub mod wire;
pub mod worker;
