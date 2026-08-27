//! Platform-local supervisor ↔ worker endpoints.
//!
//! Unix keeps the established filesystem socket and inherited `flock`
//! contract. Windows uses owner-only named pipes plus an inherited exclusive
//! reservation handle. The wire framing above either transport is identical.

use std::ffi::OsStr;
#[cfg(test)]
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use anyhow::{bail, Result};
use sha2::{Digest, Sha256};
use tokio::time::Instant;
use uuid::Uuid;

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
use unix as imp;
#[cfg(windows)]
use windows as imp;

pub use imp::*;

#[derive(Clone, Debug)]
pub struct Endpoint {
    pub session_id: Uuid,
    inner: imp::EndpointInner,
}

impl Endpoint {
    pub fn main_arg(&self) -> &OsStr {
        self.inner.main_arg()
    }

    pub fn lifecycle_arg(&self) -> &OsStr {
        self.inner.lifecycle_arg()
    }

    pub fn metadata_dir(&self) -> &Path {
        self.inner.metadata_dir()
    }
}

#[derive(Debug)]
pub enum LockAttempt {
    Acquired(Reservation),
    Busy,
}

pub fn endpoint_for(dir: &Path, tag: &str, session_id: Uuid) -> Result<Endpoint> {
    validate_root_tag(tag)?;
    Ok(Endpoint {
        session_id,
        inner: imp::EndpointInner::new(dir, tag, session_id)?,
    })
}

/// Reconstruct an endpoint from worker argv, rejecting any name that is not
/// the deterministic endpoint for this user/config-root/session tuple.
pub fn endpoint_from_worker_arg(
    dir: &Path,
    tag: &str,
    session_id: Uuid,
    supplied: &OsStr,
) -> Result<Endpoint> {
    let endpoint = endpoint_for(dir, tag, session_id)?;
    if endpoint.main_arg() != supplied {
        bail!("worker endpoint argument validation failed");
    }
    Ok(endpoint)
}

pub fn try_reserve(endpoint: &Endpoint) -> Result<LockAttempt> {
    imp::try_reserve(endpoint)
}

/// Adopt the exact reservation object inherited from the supervisor.
///
/// # Safety
/// `raw` must designate an owned reservation inherited by this process. Each
/// platform validates its identity before the endpoint is published.
pub unsafe fn adopt_reservation(raw: RawReservation, endpoint: &Endpoint) -> Result<Reservation> {
    // SAFETY: upheld by this function's caller and revalidated by the
    // platform implementation before it constructs the owned wrapper.
    unsafe { imp::adopt_reservation(raw, endpoint) }
}

pub fn remove_stale(endpoint: &Endpoint, held: &Reservation) -> Result<()> {
    imp::remove_stale(endpoint, held)
}

pub fn bind_worker(
    endpoint: &Endpoint,
    held: &Reservation,
    instance_id: Uuid,
) -> Result<BoundWorkerEndpoints> {
    imp::bind_worker(endpoint, held, instance_id)
}

pub async fn accept_main(listener: &mut MainListener) -> Result<WorkerSideStream> {
    imp::accept_main(listener).await
}

pub async fn connect_main(endpoint: &Endpoint, deadline: Instant) -> Result<SupervisorSideStream> {
    imp::connect_main(endpoint, deadline).await
}

pub fn split_worker(stream: WorkerSideStream) -> (WorkerReadHalf, WorkerWriteHalf) {
    imp::split_worker(stream)
}

pub fn split_supervisor(stream: SupervisorSideStream) -> (SupervisorReadHalf, SupervisorWriteHalf) {
    imp::split_supervisor(stream)
}

pub fn validate_worker_peer(stream: &WorkerSideStream) -> Result<()> {
    imp::validate_worker_peer(stream)
}

pub fn validate_supervisor_peer(stream: &SupervisorSideStream) -> Result<()> {
    imp::validate_supervisor_peer(stream)
}

pub fn endpoint_exists(endpoint: &Endpoint) -> bool {
    imp::endpoint_exists(endpoint)
}

pub fn discover_ids(dir: &Path, tag: &str) -> Vec<Uuid> {
    imp::discover_ids(dir, tag)
}

pub async fn receive_lifecycle(listener: &mut LifecycleListener) -> Result<LifecycleExchange> {
    imp::receive_lifecycle(listener).await
}

pub async fn acknowledge_lifecycle(
    listener: &mut LifecycleListener,
    exchange: LifecycleExchange,
    ack: u8,
) -> Result<()> {
    imp::acknowledge_lifecycle(listener, exchange, ack).await
}

pub async fn send_lifecycle(
    endpoint: &Endpoint,
    request: &[u8; super::wire::LIFECYCLE_REQUEST_LEN],
    deadline: Instant,
) -> Result<u8> {
    imp::send_lifecycle(endpoint, request, deadline).await
}

pub fn config_root_tag() -> String {
    root_tag_for(
        std::env::var_os("SPAWN_CONFIG_DIR")
            .filter(|value| !value.is_empty())
            .as_deref(),
    )
}

pub fn root_tag_for(root: Option<&OsStr>) -> String {
    match root {
        None => String::new(),
        Some(root) => {
            let canonical = std::fs::canonicalize(root).unwrap_or_else(|_| PathBuf::from(root));
            let digest = Sha256::digest(canonical.as_os_str().as_encoded_bytes());
            format!(
                "-{:02x}{:02x}{:02x}{:02x}",
                digest[0], digest[1], digest[2], digest[3]
            )
        }
    }
}

fn validate_root_tag(tag: &str) -> Result<()> {
    let valid = tag.is_empty()
        || (tag.len() == 9
            && tag.starts_with('-')
            && tag[1..].bytes().all(|byte| byte.is_ascii_hexdigit()));
    if !valid || tag.bytes().any(|byte| byte.is_ascii_uppercase()) {
        bail!("worker endpoint config tag validation failed");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_root_tags_are_stable_and_isolate_roots() {
        assert_eq!(root_tag_for(None), "");
        let alice = root_tag_for(Some(OsStr::new("/srv/spawn/alice")));
        let bob = root_tag_for(Some(OsStr::new("/srv/spawn/bob")));
        assert_ne!(alice, bob);
        assert!(alice.starts_with('-') && alice.len() == 9);
    }

    #[test]
    fn endpoint_rejects_untrusted_tags() {
        let dir = Path::new("/tmp");
        assert!(endpoint_for(dir, "-ABCDEF12", Uuid::nil()).is_err());
        assert!(endpoint_for(dir, "-../bad!", Uuid::nil()).is_err());
    }

    #[test]
    fn endpoint_main_argument_must_be_deterministic() {
        let dir = Path::new("/tmp");
        let endpoint = endpoint_for(dir, "", Uuid::nil()).unwrap();
        assert!(endpoint_from_worker_arg(dir, "", Uuid::nil(), endpoint.main_arg()).is_ok());
        assert!(endpoint_from_worker_arg(dir, "", Uuid::nil(), &OsString::from("wrong")).is_err());
    }
}
