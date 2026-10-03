#![warn(rust_2018_idioms)]
#![allow(dead_code)]
// Rust 1.99 Clippy flags the `#[must_use]` that async_trait puts on every boxed
// future it generates (clippy::double_must_use). Local patch; see daemon/CLAUDE.md.
#![allow(clippy::double_must_use)]
pub mod agent;
pub mod candidate;
pub mod control;
mod error;
pub mod external_ip_mapper;
pub mod mdns;
pub mod network_type;
pub mod priority;
pub mod rand;
pub mod state;
pub mod stats;
pub mod tcp_type;
pub mod udp_mux;
pub mod udp_network;
pub mod url;
pub mod use_candidate;
pub mod util;

pub use error::Error;
