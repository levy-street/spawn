//! Local worker endpoint ownership and access controls.
//!
//! A per-session advisory lock is held by the worker for its entire lifetime.
//! The supervisor reserves that lock before spawning and passes the locked fd
//! through `exec`, closing the create/create race without relying on a PID.

// `nix::fcntl::Flock` explicitly unlocks in Drop. We must instead close the
// supervisor's inherited duplicate without unlocking the shared open-file
// description, so this module intentionally uses the lower-level wrapper.
#![allow(deprecated)]

use std::fs::{File, OpenOptions};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use nix::fcntl::{fcntl, flock, FcntlArg, FdFlag, FlockArg};
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf, SocketAddr};
use tokio::net::{UnixDatagram, UnixListener, UnixStream};
use tokio::time::Instant;
use uuid::Uuid;

use super::{Endpoint, LockAttempt};
use crate::sessiond::wire;

#[derive(Clone, Debug)]
pub struct EndpointInner {
    dir: PathBuf,
    socket: PathBuf,
    lifecycle: PathBuf,
}

impl EndpointInner {
    pub(super) fn new(dir: &Path, _tag: &str, session_id: Uuid) -> Result<Self> {
        let socket = dir.join(format!("{session_id}.sock"));
        let lifecycle = socket.with_extension("lifecycle.sock");
        Ok(Self {
            dir: dir.to_path_buf(),
            socket,
            lifecycle,
        })
    }

    pub(super) fn main_arg(&self) -> &std::ffi::OsStr {
        self.socket.as_os_str()
    }

    pub(super) fn lifecycle_arg(&self) -> &std::ffi::OsStr {
        self.lifecycle.as_os_str()
    }

    pub(super) fn metadata_dir(&self) -> &Path {
        &self.dir
    }
}

pub type Reservation = WorkerLock;
pub type RawReservation = RawFd;
pub type WorkerSideStream = UnixStream;
pub type SupervisorSideStream = UnixStream;
pub type WorkerReadHalf = OwnedReadHalf;
pub type WorkerWriteHalf = OwnedWriteHalf;
pub type SupervisorReadHalf = OwnedReadHalf;
pub type SupervisorWriteHalf = OwnedWriteHalf;
pub type MainListener = UnixListener;
pub type LifecycleListener = UnixDatagram;

#[derive(Debug)]
pub struct WorkerLock {
    // Closing is deliberately the only unlock operation. When this open file
    // description is inherited by the worker, closing the supervisor's copy
    // must not release the lock held by the child.
    file: File,
}

#[derive(Clone, Debug)]
pub struct EndpointIdentity {
    path: PathBuf,
    device: u64,
    inode: u64,
}

pub fn lock_path(socket: &Path) -> PathBuf {
    socket.with_extension("lock")
}

pub fn ensure_private_dir(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path).context("creating private worker directory")?;
    let before = std::fs::symlink_metadata(path).context("inspecting private worker directory")?;
    if !before.file_type().is_dir() || before.file_type().is_symlink() {
        bail!("worker endpoint parent is not a private directory");
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
        .context("restricting private worker directory")?;
    validate_private_dir(path)
}

pub fn validate_private_dir(path: &Path) -> Result<()> {
    let metadata = std::fs::symlink_metadata(path).context("verifying private worker directory")?;
    if !metadata.file_type().is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != nix::unistd::Uid::effective().as_raw()
        || metadata.mode() & 0o777 != 0o700
    {
        bail!("worker endpoint directory access validation failed");
    }
    Ok(())
}

fn try_reserve_path(socket: &Path) -> Result<LockAttempt> {
    let path = lock_path(socket);
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW)
        .open(&path)
        .context("opening worker endpoint reservation")?;
    secure_regular_file(&file)?;
    match flock(file.as_raw_fd(), FlockArg::LockExclusiveNonblock) {
        Ok(()) => Ok(LockAttempt::Acquired(WorkerLock { file })),
        Err(nix::errno::Errno::EWOULDBLOCK) => Ok(LockAttempt::Busy),
        Err(error) => Err(error).context("locking worker endpoint reservation"),
    }
}

pub(super) fn try_reserve(endpoint: &Endpoint) -> Result<LockAttempt> {
    try_reserve_path(&endpoint.inner.socket)
}

/// # Safety
/// `raw` must be an owned descriptor inherited by this process.
pub(super) unsafe fn adopt_reservation(
    raw: RawReservation,
    endpoint: &Endpoint,
) -> Result<Reservation> {
    // SAFETY: the caller transfers ownership; `from_inherited` validates the
    // descriptor and its lock-path identity before returning it.
    unsafe { WorkerLock::from_inherited(raw, &endpoint.inner.socket) }
}

impl WorkerLock {
    /// Adopt the exact locked open file description inherited from the
    /// supervisor. The path identity check prevents fd substitution.
    ///
    /// # Safety
    /// `fd` must be an owned, valid descriptor inherited by this process.
    pub unsafe fn from_inherited(fd: RawFd, socket: &Path) -> Result<Self> {
        if fd <= 2 || fcntl(fd, FcntlArg::F_GETFD).is_err() {
            bail!("worker reservation descriptor validation failed");
        }
        let file = File::from_raw_fd(fd);
        secure_regular_file(&file)?;
        let by_fd = file
            .metadata()
            .context("inspecting inherited worker reservation")?;
        let by_path = std::fs::symlink_metadata(lock_path(socket))
            .context("inspecting worker reservation path")?;
        if by_fd.dev() != by_path.dev() || by_fd.ino() != by_path.ino() {
            bail!("worker reservation identity validation failed");
        }
        match flock(file.as_raw_fd(), FlockArg::LockExclusiveNonblock) {
            Ok(()) => {}
            Err(nix::errno::Errno::EWOULDBLOCK) => {
                bail!("worker endpoint reservation is not owned")
            }
            Err(error) => return Err(error).context("validating worker endpoint reservation"),
        }
        let lock = Self { file };
        lock.set_inheritable(false)?;
        Ok(lock)
    }

    pub fn raw_fd(&self) -> RawFd {
        self.file.as_raw_fd()
    }

    pub fn set_inheritable(&self, inheritable: bool) -> Result<()> {
        let raw = fcntl(self.file.as_raw_fd(), FcntlArg::F_GETFD)
            .context("reading worker reservation fd flags")?;
        let mut flags = FdFlag::from_bits_truncate(raw);
        flags.set(FdFlag::FD_CLOEXEC, !inheritable);
        fcntl(self.file.as_raw_fd(), FcntlArg::F_SETFD(flags))
            .context("setting worker reservation fd flags")?;
        Ok(())
    }
}

fn secure_regular_file(file: &File) -> Result<()> {
    file.set_permissions(std::fs::Permissions::from_mode(0o600))
        .context("restricting worker reservation")?;
    let metadata = file.metadata().context("verifying worker reservation")?;
    if !metadata.file_type().is_file()
        || metadata.uid() != nix::unistd::Uid::effective().as_raw()
        || metadata.mode() & 0o777 != 0o600
    {
        bail!("worker reservation access validation failed");
    }
    Ok(())
}

/// Remove endpoints left by a crashed worker. Callers must hold the per-session
/// lock, which proves that no live conforming worker owns either pathname.
pub fn remove_stale_socket(path: &Path) -> Result<()> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error).context("inspecting stale worker endpoint"),
    };
    if !metadata.file_type().is_socket() || metadata.uid() != nix::unistd::Uid::effective().as_raw()
    {
        bail!("refusing to replace an untrusted worker endpoint");
    }
    std::fs::remove_file(path).context("removing stale worker endpoint")
}

pub fn secure_bound_socket(path: &Path) -> Result<EndpointIdentity> {
    let metadata = std::fs::symlink_metadata(path).context("recording worker endpoint identity")?;
    let identity = EndpointIdentity {
        path: path.to_path_buf(),
        device: metadata.dev(),
        inode: metadata.ino(),
    };
    let secured = (|| {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .context("restricting worker endpoint")?;
        validate_private_socket(path)
    })();
    if let Err(error) = secured {
        let _ = identity.cleanup();
        return Err(error);
    }
    Ok(identity)
}

pub fn validate_private_socket(path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("worker endpoint access validation failed"))?;
    validate_private_dir(parent)?;
    let metadata = std::fs::symlink_metadata(path).context("inspecting worker endpoint")?;
    if !metadata.file_type().is_socket()
        || metadata.uid() != nix::unistd::Uid::effective().as_raw()
        || metadata.mode() & 0o777 != 0o600
    {
        bail!("worker endpoint access validation failed");
    }
    Ok(())
}

pub fn validate_stream_peer(stream: &tokio::net::UnixStream) -> Result<()> {
    let credentials = stream
        .peer_cred()
        .context("reading worker peer credentials")?;
    if credentials.uid() != nix::unistd::Uid::effective().as_raw() {
        bail!("worker peer ownership validation failed");
    }
    Ok(())
}

pub struct BoundWorkerEndpoints {
    pub main: MainListener,
    pub lifecycle: LifecycleListener,
    pub identity: EndpointIdentitySet,
}

pub struct EndpointIdentitySet {
    ordinary: EndpointIdentity,
    lifecycle: EndpointIdentity,
}

impl EndpointIdentitySet {
    pub fn cleanup(&self) -> Result<()> {
        self.ordinary.cleanup()?;
        self.lifecycle.cleanup()?;
        Ok(())
    }
}

pub(super) fn remove_stale(endpoint: &Endpoint, _held: &Reservation) -> Result<()> {
    remove_stale_socket(&endpoint.inner.socket)?;
    remove_stale_socket(&endpoint.inner.lifecycle)
}

pub(super) fn bind_worker(
    endpoint: &Endpoint,
    _held: &Reservation,
    _instance_id: Uuid,
) -> Result<BoundWorkerEndpoints> {
    let main =
        UnixListener::bind(&endpoint.inner.socket).context("binding ordinary worker endpoint")?;
    let ordinary = secure_bound_socket(&endpoint.inner.socket)?;
    let lifecycle = match UnixDatagram::bind(&endpoint.inner.lifecycle) {
        Ok(listener) => listener,
        Err(error) => {
            drop(ordinary);
            return Err(error).context("binding lifecycle worker endpoint");
        }
    };
    let lifecycle_identity = secure_bound_socket(&endpoint.inner.lifecycle)?;
    Ok(BoundWorkerEndpoints {
        main,
        lifecycle,
        identity: EndpointIdentitySet {
            ordinary,
            lifecycle: lifecycle_identity,
        },
    })
}

pub(super) async fn accept_main(listener: &mut MainListener) -> Result<WorkerSideStream> {
    let (stream, _) = listener.accept().await.context("accepting connection")?;
    Ok(stream)
}

pub(super) async fn connect_main(
    endpoint: &Endpoint,
    deadline: Instant,
) -> Result<SupervisorSideStream> {
    loop {
        match UnixStream::connect(&endpoint.inner.socket).await {
            Ok(stream) => {
                if validate_private_socket(&endpoint.inner.socket).is_ok()
                    && validate_stream_peer(&stream).is_ok()
                {
                    return Ok(stream);
                }
                if Instant::now() >= deadline {
                    return Err(anyhow!("worker endpoint validation failed"));
                }
            }
            Err(_) if Instant::now() >= deadline => {
                return Err(anyhow!("worker endpoint unreachable"));
            }
            Err(_) => {}
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

pub(super) fn split_worker(stream: WorkerSideStream) -> (WorkerReadHalf, WorkerWriteHalf) {
    stream.into_split()
}

pub(super) fn split_supervisor(
    stream: SupervisorSideStream,
) -> (SupervisorReadHalf, SupervisorWriteHalf) {
    stream.into_split()
}

pub(super) fn validate_worker_peer(stream: &WorkerSideStream) -> Result<()> {
    validate_stream_peer(stream)
}

pub(super) fn validate_supervisor_peer(stream: &SupervisorSideStream) -> Result<()> {
    validate_stream_peer(stream)
}

pub(super) fn endpoint_exists(endpoint: &Endpoint) -> bool {
    endpoint.inner.socket.exists()
}

pub(super) fn discover_ids(dir: &Path, _tag: &str) -> Vec<Uuid> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let stem = name.strip_suffix(".sock")?;
            Uuid::parse_str(stem).ok()
        })
        .collect()
}

pub struct LifecycleExchange {
    request: [u8; wire::LIFECYCLE_REQUEST_LEN + 1],
    len: usize,
    peer: SocketAddr,
}

impl LifecycleExchange {
    pub fn request(&self) -> (&[u8], usize) {
        (&self.request[..self.len], self.len)
    }
}

pub(super) async fn receive_lifecycle(
    listener: &mut LifecycleListener,
) -> Result<LifecycleExchange> {
    let mut request = [0u8; wire::LIFECYCLE_REQUEST_LEN + 1];
    let (len, peer) = listener
        .recv_from(&mut request)
        .await
        .context("receiving lifecycle request")?;
    Ok(LifecycleExchange { request, len, peer })
}

pub(super) async fn acknowledge_lifecycle(
    listener: &mut LifecycleListener,
    exchange: LifecycleExchange,
    ack: u8,
) -> Result<()> {
    let Some(peer_path) = exchange.peer.as_pathname() else {
        return Ok(());
    };
    listener
        .try_send_to(&[ack], peer_path)
        .map(|_| ())
        .context("acknowledging lifecycle request")
}

pub(super) async fn send_lifecycle(
    endpoint: &Endpoint,
    request: &[u8; wire::LIFECYCLE_REQUEST_LEN],
    deadline: Instant,
) -> Result<u8> {
    loop {
        if Instant::now() >= deadline {
            bail!("worker lifecycle delivery deadline exceeded");
        }
        if validate_private_socket(&endpoint.inner.lifecycle).is_err() {
            bail!("worker lifecycle endpoint validation failed");
        }
        let client_path = endpoint.inner.dir.join(format!(
            ".lifecycle-client-{}-{}.sock",
            std::process::id(),
            Uuid::new_v4()
        ));
        let socket = UnixDatagram::bind(&client_path)
            .map_err(|_| anyhow!("worker lifecycle client unavailable"))?;
        let _client_identity = secure_bound_socket(&client_path)
            .map_err(|_| anyhow!("worker lifecycle client validation failed"))?;
        if socket.connect(&endpoint.inner.lifecycle).is_err() {
            tokio::time::sleep_until(std::cmp::min(
                deadline,
                Instant::now() + Duration::from_millis(10),
            ))
            .await;
            continue;
        }
        match tokio::time::timeout_at(deadline, socket.send(request)).await {
            Ok(Ok(_)) => {}
            Ok(Err(_)) => {
                tokio::time::sleep_until(std::cmp::min(
                    deadline,
                    Instant::now() + Duration::from_millis(10),
                ))
                .await;
                continue;
            }
            Err(_) => bail!("worker lifecycle delivery deadline exceeded"),
        }
        let mut ack = [0u8; 2];
        let attempt_deadline = std::cmp::min(deadline, Instant::now() + Duration::from_millis(100));
        let received = tokio::time::timeout_at(attempt_deadline, socket.recv(&mut ack)).await;
        let Ok(Ok(1)) = received else {
            tokio::time::sleep_until(std::cmp::min(
                deadline,
                Instant::now() + Duration::from_millis(10),
            ))
            .await;
            continue;
        };
        return Ok(ack[0]);
    }
}

impl EndpointIdentity {
    /// Unlink only if this pathname still names the exact socket we created.
    /// A delayed old worker therefore cannot remove a replacement endpoint.
    pub fn cleanup(&self) -> Result<bool> {
        let metadata = match std::fs::symlink_metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error).context("inspecting worker endpoint during cleanup"),
        };
        if !metadata.file_type().is_socket()
            || metadata.dev() != self.device
            || metadata.ino() != self.inode
        {
            return Ok(false);
        }
        std::fs::remove_file(&self.path).context("cleaning up worker endpoint")?;
        Ok(true)
    }
}

impl Drop for EndpointIdentity {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn private_directory_and_socket_modes_are_enforced() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("workers");
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).unwrap();
        ensure_private_dir(&dir).unwrap();
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );

        let socket = dir.join("session.sock");
        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let identity = secure_bound_socket(&socket).unwrap();
        assert_eq!(
            std::fs::metadata(&socket).unwrap().permissions().mode() & 0o777,
            0o600
        );
        drop(listener);
        assert!(identity.cleanup().unwrap());
    }

    #[test]
    fn symlinked_endpoint_directory_is_rejected_fail_closed() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let real = root.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let alias = root.path().join("alias");
        symlink(&real, &alias).unwrap();
        let error = ensure_private_dir(&alias).unwrap_err().to_string();
        assert_eq!(error, "worker endpoint parent is not a private directory");
    }

    #[test]
    fn stale_owner_cleanup_cannot_unlink_a_replacement_inode() {
        let root = tempfile::tempdir().unwrap();
        ensure_private_dir(root.path()).unwrap();
        let socket = root.path().join("session.sock");
        let old = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let old_identity = secure_bound_socket(&socket).unwrap();
        std::fs::remove_file(&socket).unwrap();
        let replacement = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let replacement_identity = secure_bound_socket(&socket).unwrap();
        assert!(!old_identity.cleanup().unwrap());
        assert!(socket.exists());
        drop(old);
        drop(replacement);
        assert!(replacement_identity.cleanup().unwrap());
    }

    #[test]
    fn exclusive_reservation_recovers_after_owner_close() {
        let root = tempfile::tempdir().unwrap();
        ensure_private_dir(root.path()).unwrap();
        let socket = root.path().join("session.sock");
        let first = match try_reserve_path(&socket).unwrap() {
            LockAttempt::Acquired(lock) => lock,
            LockAttempt::Busy => panic!("first reservation was busy"),
        };
        assert!(matches!(
            try_reserve_path(&socket).unwrap(),
            LockAttempt::Busy
        ));
        drop(first);
        assert!(matches!(
            try_reserve_path(&socket).unwrap(),
            LockAttempt::Acquired(_)
        ));
    }
}
