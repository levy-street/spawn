#![warn(rust_2018_idioms)]
#![allow(dead_code)]
// Rust 1.99 Clippy flags the `#[must_use]` that async_trait puts on every boxed
// future it generates (clippy::double_must_use). Local patch; see daemon/CLAUDE.md.
#![allow(clippy::double_must_use)]
pub mod association;
pub mod chunk;
mod error;
pub mod error_cause;
pub mod packet;
pub mod param;
pub(crate) mod queue;
pub mod stream;
pub(crate) mod timer;
pub(crate) mod util;

pub use error::Error;

#[cfg(test)]
mod fuzz_artifact_test;
