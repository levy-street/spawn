//! Endpoint-only host filesystem operations for `spawn.host.ctl`.
//!
//! The root directory is opened once as a capability. Every later operation is
//! relative to held directory handles, walks each component with no-follow
//! semantics, and never re-enters the ambient filesystem namespace.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering};
#[cfg(test)]
use std::sync::Condvar;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use cap_std::{ambient_authority, fs};
#[cfg(unix)]
use rustix::fs::{renameat, renameat_with, RenameFlags};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::fs::File;
use tokio::io::AsyncWriteExt;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;
pub const STREAM_CHUNK_BYTES: usize = 8 * 1024;
pub const MAX_LIST_ENTRIES_PER_PAGE: usize = 96;
pub const MAX_DIRECTORY_ENTRIES: usize = 1024;
/// Largest slice `fs.read.range` will hash and stream in one request.
///
/// Bounded so a hover preview costs a bounded hash. `fs.read` still hashes the
/// whole file, which is the point of keeping the two operations apart.
pub const MAX_RANGE_BYTES: u64 = 16 * 1024 * 1024;
/// Largest file the host will hand to a QuickLook generator.
pub const PREVIEW_MAX_INPUT_BYTES: u64 = 128 * 1024 * 1024;
const MAX_REGISTERED_TEMPORARIES: usize = 16;

#[derive(Debug)]
pub struct FsError {
    pub code: &'static str,
    pub detail: String,
}

impl FsError {
    pub(crate) fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

impl From<std::io::Error> for FsError {
    fn from(error: std::io::Error) -> Self {
        let code = match error.kind() {
            std::io::ErrorKind::NotFound => "not_found",
            std::io::ErrorKind::PermissionDenied => "permission_denied",
            std::io::ErrorKind::AlreadyExists => "already_exists",
            std::io::ErrorKind::InvalidInput => "invalid_path",
            _ => "io_error",
        };
        Self::new(code, error.to_string())
    }
}

pub type FsResult<T> = Result<T, FsError>;

#[derive(Clone, Debug)]
pub struct HostFileService {
    root: Arc<Dir>,
    root_display: Arc<PathBuf>,
    #[cfg(test)]
    write_lifecycle_hooks: Arc<WriteLifecycleTestHooks>,
}

#[derive(Debug, Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub kind: &'static str,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub modified_at: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct DirectoryPage {
    pub path: String,
    pub home_dir: String,
    pub parent: Option<String>,
    pub entries: Vec<DirEntry>,
    pub next_cursor: Option<usize>,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct FileStat {
    pub path: String,
    pub name: String,
    pub kind: &'static str,
    pub size: u64,
    pub modified_at: Option<i64>,
}

pub struct ReadStream {
    pub stat: FileStat,
    pub sha256: String,
    pub file: File,
}

/// A bounded slice of a file, positioned and ready to stream.
///
/// `sha256` covers exactly the `length` bytes that will be sent, not the whole
/// file — the contract that lets a preview of a 512 MiB video cost a 4 KiB hash
/// instead of a 512 MiB one.
pub struct RangeReadStream {
    pub stat: FileStat,
    /// Opaque validator over identity, size and mtime; changes whenever the
    /// file does, including a same-second rewrite or a replace-by-rename.
    pub version: String,
    pub offset: u64,
    pub length: u64,
    pub sha256: String,
    pub content_type: &'static str,
    pub content_type_source: &'static str,
    pub preview_kind: &'static str,
    pub open_allowed: bool,
    pub eof: bool,
    pub file: File,
}

pub struct PendingWrite {
    pub stream_id: String,
    pub request_id: String,
    parent: Arc<Dir>,
    destination_name: OsString,
    temporary_name: OsString,
    destination_display: PathBuf,
    file: Option<File>,
    pub expected_length: u64,
    pub expected_sha256: String,
    pub overwrite: bool,
    pub received: u64,
    pub next_sequence: u64,
    pub hasher: Sha256,
    last_activity: Instant,
    cleanup: Arc<PendingWriteCleanup>,
    operations: Arc<HostFileOperations>,
    #[cfg(test)]
    write_lifecycle_hooks: Arc<WriteLifecycleTestHooks>,
}

pub(crate) struct PendingWriteCleanup {
    parent: Arc<Dir>,
    temporary_name: OsString,
    state: AtomicU8,
}

impl PendingWriteCleanup {
    fn unlink_if_pending(&self) -> FsResult<bool> {
        if !self.claim_pending_cleanup() {
            return Ok(false);
        }
        self.finish_unlink()
    }

    fn claim_pending_cleanup(&self) -> bool {
        self.state
            .compare_exchange(
                TEMP_PENDING,
                TEMP_CLEANING,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    fn unlink_owned(&self) -> FsResult<bool> {
        loop {
            let state = self.state.load(Ordering::Acquire);
            if !matches!(state, TEMP_PENDING | TEMP_LINEARIZED) {
                return Ok(false);
            }
            if self
                .state
                .compare_exchange(state, TEMP_CLEANING, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return self.finish_unlink();
            }
        }
    }

    fn finish_unlink(&self) -> FsResult<bool> {
        match self.parent.remove_file(&self.temporary_name) {
            Ok(()) => {
                self.state.store(TEMP_CLEANED, Ordering::Release);
                Ok(true)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.state.store(TEMP_CLEANED, Ordering::Release);
                Ok(true)
            }
            Err(error) => {
                self.state.store(TEMP_PENDING, Ordering::Release);
                Err(error.into())
            }
        }
    }

    fn linearize(&self) -> bool {
        self.state
            .compare_exchange(
                TEMP_PENDING,
                TEMP_LINEARIZED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    fn commit(&self) {
        debug_assert_eq!(self.state.load(Ordering::Acquire), TEMP_LINEARIZED);
        self.state.store(TEMP_COMMITTED, Ordering::Release);
    }

    fn is_terminal(&self) -> bool {
        matches!(
            self.state.load(Ordering::Acquire),
            TEMP_CLEANED | TEMP_COMMITTED
        )
    }

    fn is_pending(&self) -> bool {
        self.state.load(Ordering::Acquire) == TEMP_PENDING
    }

    fn unlink_late_created(&self) -> FsResult<()> {
        match self.parent.remove_file(&self.temporary_name) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}

const TEMP_PENDING: u8 = 0;
const TEMP_LINEARIZED: u8 = 1;
const TEMP_CLEANING: u8 = 2;
const TEMP_CLEANED: u8 = 3;
const TEMP_COMMITTED: u8 = 4;

#[derive(Clone)]
pub(crate) struct WriteSessionGuard {
    pub cancelled: CancellationToken,
    pub closed: Arc<AtomicBool>,
    pub operations: Arc<HostFileOperations>,
}

pub(crate) struct HostFileOperations {
    closed: Arc<AtomicBool>,
    effect_fence: StdMutex<()>,
    active: AtomicUsize,
    idle: Notify,
    temporaries: StdMutex<HashMap<String, Arc<PendingWriteCleanup>>>,
    #[cfg(test)]
    effect_hooks: StdMutex<Option<Arc<WriteLifecycleTestHooks>>>,
}

struct HostFileOperationPermit {
    operations: Arc<HostFileOperations>,
}

impl HostFileOperations {
    pub(crate) fn new(closed: Arc<AtomicBool>) -> Arc<Self> {
        Arc::new(Self {
            closed,
            effect_fence: StdMutex::new(()),
            active: AtomicUsize::new(0),
            idle: Notify::new(),
            temporaries: StdMutex::new(HashMap::new()),
            #[cfg(test)]
            effect_hooks: StdMutex::new(None),
        })
    }

    #[cfg(test)]
    pub(crate) fn set_effect_test_hooks(&self, hooks: Arc<WriteLifecycleTestHooks>) {
        *self.effect_hooks.lock().expect("effect hooks lock") = Some(hooks);
    }

    pub(crate) fn cancelled(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    fn admit(self: &Arc<Self>) -> FsResult<HostFileOperationPermit> {
        if self.cancelled() {
            return Err(cancelled_error());
        }
        self.active.fetch_add(1, Ordering::AcqRel);
        let permit = HostFileOperationPermit {
            operations: Arc::clone(self),
        };
        if self.cancelled() {
            drop(permit);
            return Err(cancelled_error());
        }
        Ok(permit)
    }

    fn admit_cleanup(self: &Arc<Self>) -> HostFileOperationPermit {
        self.active.fetch_add(1, Ordering::AcqRel);
        HostFileOperationPermit {
            operations: Arc::clone(self),
        }
    }

    pub(crate) async fn cleanup_write(self: &Arc<Self>, write: PendingWrite) {
        let permit = self.admit_cleanup();
        let _ = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            drop(write);
        })
        .await;
    }

    pub(crate) fn schedule_write_cleanup(self: &Arc<Self>, write: PendingWrite) {
        let permit = self.admit_cleanup();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            drop(write);
        });
    }

    fn effect<T>(
        &self,
        kind: HostOperationKind,
        effect: impl FnOnce() -> FsResult<T>,
    ) -> FsResult<T> {
        self.effect_inner(kind, None, effect)
    }

    fn write_commit_effect<T>(
        &self,
        cleanup: &PendingWriteCleanup,
        effect: impl FnOnce() -> FsResult<T>,
    ) -> FsResult<T> {
        self.effect_inner(HostOperationKind::WriteCommit, Some(cleanup), effect)
    }

    fn effect_inner<T>(
        &self,
        kind: HostOperationKind,
        write_cleanup: Option<&PendingWriteCleanup>,
        effect: impl FnOnce() -> FsResult<T>,
    ) -> FsResult<T> {
        let _fence = self
            .effect_fence
            .lock()
            .map_err(|_| FsError::new("io_error", "filesystem effect fence is poisoned"))?;
        if self.cancelled() {
            return Err(cancelled_error());
        }
        // Close publishes `closed` before cleaning pending temporaries. A
        // write commit must atomically claim its temporary after that check
        // and while holding the global effect fence. Cleanup that wins the
        // per-temp claim prevents commit; a commit that wins may finish.
        if write_cleanup.is_some_and(|cleanup| !cleanup.linearize()) {
            return Err(cancelled_error());
        }
        // This check (plus the per-temp claim for commit) is the mutation's
        // linearization point. A closure that reaches it first may finish its
        // already-admitted syscall, while queued or stalled closures fail
        // without effects.
        #[cfg(test)]
        let hooks = self.effect_hooks.lock().expect("effect hooks lock").clone();
        #[cfg(test)]
        if let Some(hooks) = hooks {
            hooks.effect_boundary[kind.index()].pause_if_armed();
        }
        match effect() {
            Ok(value) => Ok(value),
            Err(_) if kind.has_user_visible_effect() => Err(outcome_unknown_error()),
            Err(error) => Err(error),
        }
    }

    fn register_temporary(
        &self,
        stream_id: &str,
        cleanup: Arc<PendingWriteCleanup>,
    ) -> FsResult<()> {
        let mut temporaries = self
            .temporaries
            .lock()
            .map_err(|_| FsError::new("io_error", "temporary registry is poisoned"))?;
        if self.cancelled() {
            return Err(cancelled_error());
        }
        if temporaries.len() >= MAX_REGISTERED_TEMPORARIES {
            return Err(FsError::new(
                "too_many_streams",
                "too many registered write temporaries",
            ));
        }
        match temporaries.entry(stream_id.to_string()) {
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(cleanup);
            }
            std::collections::hash_map::Entry::Occupied(_) => {
                return Err(FsError::new(
                    "io_error",
                    "temporary registry identity collision",
                ));
            }
        }
        Ok(())
    }

    fn unregister_temporary(&self, stream_id: &str, cleanup: &Arc<PendingWriteCleanup>) {
        let mut temporaries = self
            .temporaries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if temporaries
            .get(stream_id)
            .is_some_and(|current| Arc::ptr_eq(current, cleanup))
        {
            temporaries.remove(stream_id);
        }
    }

    pub(crate) async fn cleanup_temporaries_until(
        self: &Arc<Self>,
        deadline: tokio::time::Instant,
    ) {
        let temporaries = self
            .temporaries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .map(|(stream_id, cleanup)| (stream_id.clone(), Arc::clone(cleanup)))
            .collect::<Vec<_>>();
        let mut cleanups = Vec::with_capacity(temporaries.len());
        for (stream_id, cleanup) in temporaries {
            let operations = Arc::clone(self);
            let permit = self.admit_cleanup();
            #[cfg(test)]
            let hooks = self.effect_hooks.lock().expect("effect hooks lock").clone();
            cleanups.push(tokio::task::spawn_blocking(move || {
                let _permit = permit;
                let claimed = cleanup.claim_pending_cleanup();
                #[cfg(test)]
                if claimed {
                    if let Some(hooks) = hooks.as_ref() {
                        hooks.temporary_cleanup.pause_if_armed();
                    }
                }
                if claimed {
                    let _ = cleanup.finish_unlink();
                }
                if cleanup.is_terminal() {
                    operations.unregister_temporary(&stream_id, &cleanup);
                }
                #[cfg(test)]
                if let Some(hooks) = hooks {
                    hooks.temporary_cleanup.finished.notify_one();
                }
            }));
        }
        // Dropping a timed-out JoinHandle detaches its blocking closure; the
        // closure keeps its active permit and cleanup capability, so it stays
        // accounted and completes safely without extending session close.
        for cleanup in cleanups {
            if tokio::time::timeout_at(deadline, cleanup).await.is_err() {
                return;
            }
        }
    }

    pub(crate) async fn wait_for_idle_until(&self, deadline: tokio::time::Instant) -> bool {
        loop {
            let notified = self.idle.notified();
            if self.active.load(Ordering::Acquire) == 0 {
                return true;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return self.active.load(Ordering::Acquire) == 0;
            }
        }
    }
}

impl Drop for HostFileOperationPermit {
    fn drop(&mut self) {
        if self.operations.active.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.operations.idle.notify_one();
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) enum HostOperationKind {
    List,
    Stat,
    Read,
    Mkdir,
    Rename,
    Remove,
    WriteBegin,
    WriteCommit,
    ReadRange,
    Preview,
    #[cfg(target_os = "macos")]
    Desktop,
}

impl HostOperationKind {
    #[cfg(test)]
    const fn index(self) -> usize {
        self as usize
    }

    const fn has_user_visible_effect(self) -> bool {
        matches!(
            self,
            Self::Mkdir | Self::Rename | Self::Remove | Self::WriteCommit
        )
    }
}

#[cfg(test)]
#[derive(Debug, Default)]
struct WritePause {
    armed: AtomicBool,
    entered: Notify,
    release: Notify,
}

#[cfg(test)]
#[derive(Debug, Default)]
struct BlockingPause {
    armed: AtomicBool,
    entered: Notify,
    finished: Notify,
    released: StdMutex<bool>,
    release: Condvar,
}

#[cfg(test)]
impl BlockingPause {
    fn arm(&self) {
        *self.released.lock().expect("blocking pause lock") = false;
        self.armed.store(true, Ordering::Release);
    }

    fn pause_if_armed(&self) {
        if !self.armed.swap(false, Ordering::AcqRel) {
            return;
        }
        self.entered.notify_one();
        let mut released = self.released.lock().expect("blocking pause lock");
        while !*released {
            released = self.release.wait(released).expect("blocking pause wait");
        }
    }

    fn release(&self) {
        *self.released.lock().expect("blocking pause lock") = true;
        self.release.notify_all();
    }
}

#[cfg(test)]
impl WritePause {
    fn arm(&self) {
        self.armed.store(true, Ordering::Release);
    }

    async fn wait_until_entered(&self) {
        self.entered.notified().await;
    }

    fn release(&self) {
        self.release.notify_one();
    }

    async fn pause_if_armed(&self, cancelled: Option<&CancellationToken>) -> bool {
        if !self.armed.swap(false, Ordering::AcqRel) {
            return true;
        }
        self.entered.notify_one();
        if let Some(cancelled) = cancelled {
            tokio::select! {
                biased;
                _ = cancelled.cancelled() => false,
                _ = self.release.notified() => true,
            }
        } else {
            self.release.notified().await;
            true
        }
    }
}

#[cfg(test)]
#[derive(Debug, Default)]
pub(crate) struct WriteLifecycleTestHooks {
    begin_after_create: BlockingPause,
    open_after_context: WritePause,
    open_before_connected: WritePause,
    open_after_publication_claim: WritePause,
    publication_send_finished: Notify,
    shutdown_started: Notify,
    shutdown_returned: Notify,
    write_delay_entered: Notify,
    blocking: [BlockingPause; 11],
    effect_boundary: [BlockingPause; 11],
    temporary_cleanup: BlockingPause,
}

#[cfg(test)]
impl WriteLifecycleTestHooks {
    pub(crate) fn arm_blocking(&self, kind: HostOperationKind) {
        self.blocking[kind.index()].arm();
    }

    pub(crate) async fn wait_blocking_entered(&self, kind: HostOperationKind) {
        self.blocking[kind.index()].entered.notified().await;
    }

    pub(crate) fn release_blocking(&self, kind: HostOperationKind) {
        self.blocking[kind.index()].release();
    }

    pub(crate) async fn wait_blocking_finished(&self, kind: HostOperationKind) {
        self.blocking[kind.index()].finished.notified().await;
    }

    pub(crate) fn arm_effect_boundary(&self, kind: HostOperationKind) {
        self.effect_boundary[kind.index()].arm();
    }

    pub(crate) async fn wait_effect_boundary_entered(&self, kind: HostOperationKind) {
        self.effect_boundary[kind.index()].entered.notified().await;
    }

    pub(crate) fn release_effect_boundary(&self, kind: HostOperationKind) {
        self.effect_boundary[kind.index()].release();
    }

    pub(crate) fn arm_begin_after_create(&self) {
        self.begin_after_create.arm();
    }

    pub(crate) async fn wait_begin_after_create(&self) {
        self.begin_after_create.entered.notified().await;
    }

    pub(crate) fn release_begin_after_create(&self) {
        self.begin_after_create.release();
    }

    pub(crate) fn arm_temporary_cleanup(&self) {
        self.temporary_cleanup.arm();
    }

    pub(crate) async fn wait_temporary_cleanup_entered(&self) {
        self.temporary_cleanup.entered.notified().await;
    }

    pub(crate) fn release_temporary_cleanup(&self) {
        self.temporary_cleanup.release();
    }

    pub(crate) async fn wait_temporary_cleanup_finished(&self) {
        self.temporary_cleanup.finished.notified().await;
    }

    pub(crate) fn arm_open_after_context(&self) {
        self.open_after_context.arm();
    }

    pub(crate) async fn wait_open_after_context(&self) {
        self.open_after_context.wait_until_entered().await;
    }

    pub(crate) async fn pause_open_after_context(&self, shutdown: &CancellationToken) -> bool {
        self.open_after_context.pause_if_armed(Some(shutdown)).await
    }

    pub(crate) fn arm_open_before_connected(&self) {
        self.open_before_connected.arm();
    }

    pub(crate) async fn wait_open_before_connected(&self) {
        self.open_before_connected.wait_until_entered().await;
    }

    pub(crate) async fn pause_open_before_connected(&self, shutdown: &CancellationToken) -> bool {
        self.open_before_connected
            .pause_if_armed(Some(shutdown))
            .await
    }

    pub(crate) fn arm_open_after_publication_claim(&self) {
        self.open_after_publication_claim.arm();
    }

    pub(crate) async fn wait_open_after_publication_claim(&self) {
        self.open_after_publication_claim.wait_until_entered().await;
    }

    pub(crate) async fn pause_open_after_publication_claim(
        &self,
        cancelled: &CancellationToken,
    ) -> bool {
        self.open_after_publication_claim
            .pause_if_armed(Some(cancelled))
            .await
    }

    pub(crate) fn release_open_after_publication_claim(&self) {
        self.open_after_publication_claim.release();
    }

    pub(crate) fn notify_publication_send_finished(&self) {
        self.publication_send_finished.notify_one();
    }

    pub(crate) async fn wait_publication_send_finished(&self) {
        self.publication_send_finished.notified().await;
    }

    pub(crate) async fn wait_shutdown_returned(&self) {
        self.shutdown_returned.notified().await;
    }

    pub(crate) async fn wait_shutdown_started(&self) {
        self.shutdown_started.notified().await;
    }

    pub(crate) fn notify_shutdown_started(&self) {
        self.shutdown_started.notify_one();
    }

    pub(crate) fn notify_shutdown_returned(&self) {
        self.shutdown_returned.notify_one();
    }

    pub(crate) fn notify_write_delay_entered(&self) {
        self.write_delay_entered.notify_one();
    }

    pub(crate) async fn wait_write_delay_entered(&self) {
        self.write_delay_entered.notified().await;
    }
}

impl HostFileService {
    pub async fn discover() -> FsResult<Self> {
        let configured = dirs::home_dir()
            .or_else(|| std::env::current_dir().ok())
            .ok_or_else(|| FsError::new("home_unavailable", "home directory is unavailable"))?;
        Self::open_root(configured)
    }

    #[cfg(test)]
    pub async fn rooted_at(root: &Path) -> FsResult<Self> {
        Self::open_root(root.to_path_buf())
    }

    fn open_root(root: PathBuf) -> FsResult<Self> {
        // Ambient authority is consumed exactly once to acquire the root
        // capability. All request-time operations use `Dir` handles below.
        let root_capability = std::fs::canonicalize(root)?;
        let root = Dir::open_ambient_dir(&root_capability, ambient_authority())?;
        #[cfg(unix)]
        let root_display = root_capability;
        #[cfg(windows)]
        let root_display = windows_wire_path(&root_capability);
        Ok(Self {
            root: Arc::new(root),
            root_display: Arc::new(root_display),
            #[cfg(test)]
            write_lifecycle_hooks: Arc::new(WriteLifecycleTestHooks::default()),
        })
    }

    #[cfg(test)]
    pub(crate) fn write_lifecycle_test_hooks(&self) -> Arc<WriteLifecycleTestHooks> {
        Arc::clone(&self.write_lifecycle_hooks)
    }

    pub(crate) async fn run_blocking<T, F>(
        &self,
        operations: Arc<HostFileOperations>,
        kind: HostOperationKind,
        operation: F,
    ) -> FsResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&HostFileOperations) -> FsResult<T> + Send + 'static,
    {
        #[cfg(not(test))]
        let _ = kind;
        let permit = operations.admit()?;
        #[cfg(test)]
        let hooks = Arc::clone(&self.write_lifecycle_hooks);
        let operation_context = Arc::clone(&operations);
        let result = tokio::task::spawn_blocking(move || {
            // The permit is deliberately owned by the blocking closure, not
            // its async JoinHandle. Aborting the waiter cannot detach the
            // underlying filesystem job from session accounting.
            let _permit = permit;
            #[cfg(test)]
            hooks.blocking[kind.index()].pause_if_armed();
            let result = if operation_context.cancelled() {
                Err(cancelled_error())
            } else {
                operation(&operation_context)
            };
            #[cfg(test)]
            hooks.blocking[kind.index()].finished.notify_one();
            result
        })
        .await
        .map_err(join_error)?;
        if operations.cancelled() {
            return Err(cancelled_error());
        }
        result
    }

    pub fn home_dir(&self) -> String {
        self.root_display.to_string_lossy().into_owned()
    }

    pub(crate) fn relative_components(&self, input: &str) -> FsResult<Vec<OsString>> {
        if input.as_bytes().contains(&0) {
            return Err(FsError::new("invalid_path", "path contains a NUL byte"));
        }
        let trimmed = input.trim();
        let relative = if trimmed.is_empty() || trimmed == "~" {
            PathBuf::new()
        } else if let Some(rest) = trimmed
            .strip_prefix("~/")
            .or_else(|| trimmed.strip_prefix("~\\"))
        {
            PathBuf::from(rest)
        } else {
            let path = Path::new(trimmed);
            if path.is_absolute() {
                relative_to_root(self.root_display.as_ref(), path)?
            } else {
                path.to_path_buf()
            }
        };
        let mut components = Vec::new();
        for component in relative.components() {
            match component {
                Component::Normal(value) => components.push(value.to_os_string()),
                Component::CurDir => {}
                Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                    return Err(FsError::new(
                        "traversal_rejected",
                        "parent traversal is not allowed",
                    ));
                }
            }
        }
        Ok(components)
    }

    pub(crate) fn display_path(&self, components: &[OsString]) -> PathBuf {
        let mut path = self.root_display.as_ref().clone();
        for component in components {
            path.push(component);
        }
        path
    }

    pub(crate) fn open_dir_components(&self, components: &[OsString]) -> FsResult<Dir> {
        let mut current = self.root.try_clone()?;
        for component in components {
            let metadata = current.symlink_metadata(component)?;
            if metadata.file_type().is_symlink() {
                return Err(symlink_error());
            }
            if !metadata.is_dir() {
                return Err(FsError::new(
                    "not_directory",
                    "path component is not a directory",
                ));
            }
            current = current
                .open_dir_nofollow(component)
                .map_err(nofollow_error)?;
        }
        Ok(current)
    }

    fn open_parent(&self, components: &[OsString]) -> FsResult<(Dir, OsString)> {
        let (name, parents) = components
            .split_last()
            .ok_or_else(|| FsError::new("root_protected", "home root is protected"))?;
        Ok((self.open_dir_components(parents)?, name.clone()))
    }

    #[cfg(test)]
    pub async fn list(&self, input: &str, cursor: usize) -> FsResult<DirectoryPage> {
        self.list_in_session(
            input,
            cursor,
            HostFileOperations::new(Arc::new(AtomicBool::new(false))),
        )
        .await
    }

    pub(crate) async fn list_in_session(
        &self,
        input: &str,
        cursor: usize,
        operations: Arc<HostFileOperations>,
    ) -> FsResult<DirectoryPage> {
        let service = self.clone();
        let input = input.to_string();
        self.run_blocking(operations, HostOperationKind::List, move |operations| {
            service.list_sync(&input, cursor, operations)
        })
        .await
    }

    fn list_sync(
        &self,
        input: &str,
        cursor: usize,
        operations: &HostFileOperations,
    ) -> FsResult<DirectoryPage> {
        if operations.cancelled() {
            return Err(cancelled_error());
        }
        if cursor > MAX_DIRECTORY_ENTRIES {
            return Err(FsError::new("invalid_cursor", "directory cursor is stale"));
        }
        let components = self.relative_components(input)?;
        let target = self.open_dir_components(&components)?;
        let mut entries = Vec::with_capacity(MAX_LIST_ENTRIES_PER_PAGE);
        let mut next_cursor = None;
        let mut truncated = false;
        for (index, entry) in target.entries()?.enumerate() {
            if operations.cancelled() {
                return Err(cancelled_error());
            }
            let entry = entry?;
            if index < cursor {
                continue;
            }
            if index >= MAX_DIRECTORY_ENTRIES {
                truncated = true;
                break;
            }
            if entries.len() == MAX_LIST_ENTRIES_PER_PAGE {
                next_cursor = Some(index);
                break;
            }
            let name_os = entry.file_name();
            if name_os == OsStr::new(".") || name_os == OsStr::new("..") {
                continue;
            }
            let file_type = entry.file_type()?;
            let metadata = entry.metadata()?;
            let (kind, is_dir) = if file_type.is_symlink() {
                ("symlink", false)
            } else if file_type.is_dir() {
                ("directory", true)
            } else if file_type.is_file() {
                ("file", false)
            } else {
                ("other", false)
            };
            let mut entry_components = components.clone();
            entry_components.push(name_os.clone());
            entries.push(DirEntry {
                name: name_os.to_string_lossy().into_owned(),
                path: self
                    .display_path(&entry_components)
                    .to_string_lossy()
                    .into_owned(),
                kind,
                is_dir,
                size: file_type.is_file().then_some(metadata.len()),
                modified_at: modified_seconds(&metadata),
            });
        }
        Ok(DirectoryPage {
            path: self
                .display_path(&components)
                .to_string_lossy()
                .into_owned(),
            home_dir: self.home_dir(),
            parent: (!components.is_empty()).then(|| {
                self.display_path(&components[..components.len() - 1])
                    .to_string_lossy()
                    .into_owned()
            }),
            entries,
            next_cursor,
            truncated,
        })
    }

    #[cfg(all(test, unix))]
    pub async fn stat(&self, input: &str) -> FsResult<FileStat> {
        self.stat_in_session(
            input,
            HostFileOperations::new(Arc::new(AtomicBool::new(false))),
        )
        .await
    }

    pub(crate) async fn stat_in_session(
        &self,
        input: &str,
        operations: Arc<HostFileOperations>,
    ) -> FsResult<FileStat> {
        let service = self.clone();
        let input = input.to_string();
        self.run_blocking(operations, HostOperationKind::Stat, move |operations| {
            service.stat_sync(&input, operations)
        })
        .await
    }

    fn stat_sync(&self, input: &str, operations: &HostFileOperations) -> FsResult<FileStat> {
        if operations.cancelled() {
            return Err(cancelled_error());
        }
        let components = self.relative_components(input)?;
        let (metadata, name) = if components.is_empty() {
            (self.root.dir_metadata()?, "file".to_string())
        } else {
            let (parent, name) = self.open_parent(&components)?;
            let metadata = parent.symlink_metadata(&name)?;
            if metadata.file_type().is_symlink() {
                return Err(symlink_error());
            }
            (metadata, name.to_string_lossy().into_owned())
        };
        let kind = if metadata.is_dir() {
            "directory"
        } else if metadata.is_file() {
            "file"
        } else {
            "other"
        };
        if operations.cancelled() {
            return Err(cancelled_error());
        }
        Ok(FileStat {
            path: self
                .display_path(&components)
                .to_string_lossy()
                .into_owned(),
            name,
            kind,
            size: metadata.len(),
            modified_at: modified_seconds(&metadata),
        })
    }

    #[cfg(test)]
    pub async fn open_range_read(
        &self,
        input: &str,
        offset: u64,
        length: u64,
        if_version: Option<String>,
    ) -> FsResult<RangeReadStream> {
        self.open_range_read_in_session(
            input,
            offset,
            length,
            if_version,
            Arc::new(AtomicBool::new(false)),
            HostFileOperations::new(Arc::new(AtomicBool::new(false))),
        )
        .await
    }

    #[cfg(test)]
    pub async fn open_preview_source(&self, input: &str) -> FsResult<PreviewSource> {
        self.open_preview_source_in_session(
            input,
            None,
            HostFileOperations::new(Arc::new(AtomicBool::new(false))),
        )
        .await
    }

    #[cfg(all(test, target_os = "macos"))]
    pub async fn open_launch_target(
        &self,
        input: &str,
        require_file: bool,
    ) -> FsResult<LaunchTarget> {
        self.open_launch_target_in_session(
            input,
            require_file,
            HostFileOperations::new(Arc::new(AtomicBool::new(false))),
        )
        .await
    }

    #[cfg(test)]
    pub async fn open_read(&self, input: &str) -> FsResult<ReadStream> {
        self.open_read_in_session(
            input,
            Arc::new(AtomicBool::new(false)),
            HostFileOperations::new(Arc::new(AtomicBool::new(false))),
        )
        .await
    }

    pub(crate) async fn open_read_in_session(
        &self,
        input: &str,
        cancelled: Arc<AtomicBool>,
        operations: Arc<HostFileOperations>,
    ) -> FsResult<ReadStream> {
        let service = self.clone();
        let input = input.to_string();
        self.run_blocking(operations, HostOperationKind::Read, move |operations| {
            service.open_read_sync(&input, &cancelled, operations)
        })
        .await
    }

    fn open_read_sync(
        &self,
        input: &str,
        cancelled: &AtomicBool,
        operations: &HostFileOperations,
    ) -> FsResult<ReadStream> {
        if operations.cancelled() {
            return Err(cancelled_error());
        }
        let components = self.relative_components(input)?;
        let (parent, name) = self.open_parent(&components)?;
        #[cfg(windows)]
        {
            // Windows refuses a directory opened with ordinary file-read
            // access before we can classify the resulting handle. Preserve
            // the endpoint's `not_file` contract with a directory-entry
            // preflight, then still re-check the opened handle below so a
            // replacement race cannot make a non-file usable.
            let metadata = parent.symlink_metadata(&name)?;
            if metadata.file_type().is_symlink() {
                return Err(symlink_error());
            }
            if !metadata.is_file() {
                return Err(FsError::new("not_file", "path is not a regular file"));
            }
        }
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        let mut file = parent
            .open_with(&name, &options)
            .map_err(nofollow_error)?
            .into_std();
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(FsError::new("not_file", "path is not a regular file"));
        }
        if metadata.len() > MAX_FILE_BYTES {
            return Err(FsError::new(
                "file_too_large",
                "file exceeds the stream limit",
            ));
        }
        let mut buffer = vec![0_u8; 64 * 1024];
        let mut hasher = Sha256::new();
        let mut length = 0_u64;
        loop {
            if cancelled.load(Ordering::Acquire) || operations.cancelled() {
                return Err(FsError::new("cancelled", "file read was cancelled"));
            }
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            length = length.saturating_add(read as u64);
            if length > metadata.len() || length > MAX_FILE_BYTES {
                return Err(FsError::new("file_changed", "file changed while hashing"));
            }
            hasher.update(&buffer[..read]);
            #[cfg(test)]
            std::thread::yield_now();
        }
        if length != metadata.len() {
            return Err(FsError::new("file_changed", "file changed while hashing"));
        }
        file.seek(SeekFrom::Start(0))?;
        if operations.cancelled() {
            return Err(cancelled_error());
        }
        Ok(ReadStream {
            stat: FileStat {
                path: self
                    .display_path(&components)
                    .to_string_lossy()
                    .into_owned(),
                name: name.to_string_lossy().into_owned(),
                kind: "file",
                size: metadata.len(),
                modified_at: metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .and_then(|duration| i64::try_from(duration.as_secs()).ok()),
            },
            sha256: format!("{:x}", hasher.finalize()),
            file: File::from_std(file),
        })
    }

    pub(crate) async fn open_range_read_in_session(
        &self,
        input: &str,
        offset: u64,
        length: u64,
        if_version: Option<String>,
        cancelled: Arc<AtomicBool>,
        operations: Arc<HostFileOperations>,
    ) -> FsResult<RangeReadStream> {
        let service = self.clone();
        let input = input.to_string();
        self.run_blocking(
            operations,
            HostOperationKind::ReadRange,
            move |operations| {
                service.open_range_read_sync(
                    &input, offset, length, if_version, &cancelled, operations,
                )
            },
        )
        .await
    }

    /// Hash and position a bounded slice of a file.
    ///
    /// Unlike `open_read_sync` this never touches more than `length` bytes, so
    /// the cost of answering a preview does not scale with the size of the
    /// file. The digest it returns covers exactly the slice that will be
    /// streamed, which keeps the client's existing verification loop honest.
    fn open_range_read_sync(
        &self,
        input: &str,
        offset: u64,
        length: u64,
        if_version: Option<String>,
        cancelled: &AtomicBool,
        operations: &HostFileOperations,
    ) -> FsResult<RangeReadStream> {
        if operations.cancelled() {
            return Err(cancelled_error());
        }
        if length == 0 || length > MAX_RANGE_BYTES {
            return Err(FsError::new(
                "range_too_large",
                "range length must be between 1 byte and 16 MiB",
            ));
        }
        let components = self.relative_components(input)?;
        let (parent, name) = self.open_parent(&components)?;
        #[cfg(windows)]
        {
            let metadata = parent.symlink_metadata(&name)?;
            if metadata.file_type().is_symlink() {
                return Err(symlink_error());
            }
            if !metadata.is_file() {
                return Err(FsError::new("not_file", "path is not a regular file"));
            }
        }
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        let mut file = parent
            .open_with(&name, &options)
            .map_err(nofollow_error)?
            .into_std();
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(FsError::new("not_file", "path is not a regular file"));
        }
        let size = metadata.len();
        let version = file_version(&file)?;
        if let Some(expected) = if_version {
            if expected != version {
                return Err(FsError::new(
                    "version_changed",
                    "file changed since the cached preview",
                ));
            }
        }
        if offset > size {
            return Err(FsError::new(
                "range_not_satisfiable",
                "range offset is past the end of the file",
            ));
        }

        // Classification wants the head of the file, which is rarely the slice
        // being asked for; read it first, then position for the real work.
        let mut head = vec![0_u8; crate::host_mime::SNIFF_BYTES.min(size as usize)];
        if !head.is_empty() {
            let filled = read_fully(&mut file, &mut head)?;
            head.truncate(filled);
        }

        let effective = length.min(size - offset);
        file.seek(SeekFrom::Start(offset))?;
        let mut hasher = Sha256::new();
        let mut remaining = effective;
        let mut buffer = vec![0_u8; 64 * 1024];
        while remaining > 0 {
            if cancelled.load(Ordering::Acquire) || operations.cancelled() {
                return Err(FsError::new("cancelled", "file read was cancelled"));
            }
            let want = buffer.len().min(remaining as usize);
            let read = file.read(&mut buffer[..want])?;
            if read == 0 {
                return Err(FsError::new("file_changed", "file changed while hashing"));
            }
            hasher.update(&buffer[..read]);
            remaining -= read as u64;
            #[cfg(test)]
            std::thread::yield_now();
        }
        // A file swapped underneath us between the stat and the hash would
        // otherwise be streamed with a digest describing different bytes.
        if file_version(&file)? != version {
            return Err(FsError::new("file_changed", "file changed while hashing"));
        }
        file.seek(SeekFrom::Start(offset))?;
        if operations.cancelled() {
            return Err(cancelled_error());
        }

        let classification = crate::host_mime::classify(&name, &head);
        Ok(RangeReadStream {
            stat: FileStat {
                path: self
                    .display_path(&components)
                    .to_string_lossy()
                    .into_owned(),
                name: name.to_string_lossy().into_owned(),
                kind: "file",
                size,
                modified_at: metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .and_then(|duration| i64::try_from(duration.as_secs()).ok()),
            },
            version,
            offset,
            length: effective,
            sha256: format!("{:x}", hasher.finalize()),
            content_type: classification.content_type,
            content_type_source: classification.source,
            preview_kind: classification.preview.as_wire(),
            open_allowed: classification.open_allowed,
            eof: offset + effective >= size,
            file: File::from_std(file),
        })
    }

    #[cfg(target_os = "macos")]
    pub(crate) async fn open_launch_target_in_session(
        &self,
        input: &str,
        require_file: bool,
        operations: Arc<HostFileOperations>,
    ) -> FsResult<LaunchTarget> {
        let service = self.clone();
        let input = input.to_string();
        self.run_blocking(operations, HostOperationKind::Desktop, move |operations| {
            service.open_launch_target_sync(&input, require_file, operations)
        })
        .await
    }

    /// Resolve a path the desktop can be told about, with two independent gates.
    ///
    /// The capability walk proves the target is inside the root and that no
    /// component was a symlink. `F_GETPATH` on the resulting descriptor then
    /// proves the *string* we are about to hand to another process names the
    /// exact vnode we just validated — reconstructing the path from components
    /// would produce a string the kernel never resolved, which a symlink swap
    /// between validation and the child's `open()` could redirect.
    #[cfg(target_os = "macos")]
    fn open_launch_target_sync(
        &self,
        input: &str,
        require_file: bool,
        operations: &HostFileOperations,
    ) -> FsResult<LaunchTarget> {
        use std::os::fd::AsFd;

        if operations.cancelled() {
            return Err(cancelled_error());
        }
        let components = self.relative_components(input)?;

        // The home root itself is a legitimate reveal target; it is never an
        // open target because it is not a regular file.
        if components.is_empty() {
            if require_file {
                return Err(FsError::new("not_file", "path is not a regular file"));
            }
            let display = real_path_of(self.root.as_ref().as_fd())?;
            self.assert_within_root(&display)?;
            return Ok(LaunchTarget {
                display,
                is_dir: true,
                mode: 0,
                name: OsString::from(""),
                head: Vec::new(),
            });
        }

        let (parent, name) = self.open_parent(&components)?;
        let entry = parent.symlink_metadata(&name)?;
        if entry.file_type().is_symlink() {
            return Err(symlink_error());
        }
        if entry.is_dir() {
            if require_file {
                return Err(FsError::new("not_file", "path is not a regular file"));
            }
            let dir = parent.open_dir_nofollow(&name).map_err(nofollow_error)?;
            let before = rustix::fs::fstat(dir.as_fd())
                .map_err(|_| FsError::new("io_error", "could not stat the directory"))?;
            let display = real_path_of(dir.as_fd())?;
            self.assert_within_root(&display)?;
            let after = rustix::fs::fstat(dir.as_fd())
                .map_err(|_| FsError::new("io_error", "could not stat the directory"))?;
            if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino) {
                return Err(FsError::new(
                    "file_changed",
                    "target changed during resolution",
                ));
            }
            return Ok(LaunchTarget {
                display,
                is_dir: true,
                mode: u32::from(before.st_mode),
                name,
                head: Vec::new(),
            });
        }
        if !entry.is_file() {
            return Err(FsError::new("not_file", "path is not a regular file"));
        }

        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        let mut file = parent
            .open_with(&name, &options)
            .map_err(nofollow_error)?
            .into_std();
        let before = rustix::fs::fstat(file.as_fd())
            .map_err(|_| FsError::new("io_error", "could not stat the file"))?;
        // Re-checked on the descriptor itself, not on the directory entry we
        // looked at a moment ago.
        if !file.metadata()?.is_file() {
            return Err(FsError::new("not_file", "path is not a regular file"));
        }
        let display = real_path_of(file.as_fd())?;
        self.assert_within_root(&display)?;
        let after = rustix::fs::fstat(file.as_fd())
            .map_err(|_| FsError::new("io_error", "could not stat the file"))?;
        if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino) {
            return Err(FsError::new(
                "file_changed",
                "target changed during resolution",
            ));
        }

        let size = before.st_size.max(0) as u64;
        let mut head = vec![0_u8; crate::host_mime::SNIFF_BYTES.min(size as usize)];
        if !head.is_empty() {
            let filled = read_fully(&mut file, &mut head)?;
            head.truncate(filled);
        }

        Ok(LaunchTarget {
            display,
            is_dir: false,
            mode: u32::from(before.st_mode),
            name,
            head,
        })
    }

    /// Refuse any resolved path that is not the root or beneath it.
    #[cfg(target_os = "macos")]
    fn assert_within_root(&self, candidate: &Path) -> FsResult<()> {
        if is_within_root(self.root_display.as_ref(), candidate) {
            return Ok(());
        }
        // macOS firmlinks can render the same directory under two spellings, so
        // give the kernel a second chance to agree before refusing. The path is
        // already pinned by a descriptor we hold, so this re-resolution cannot
        // change which object we act on.
        if let Ok(resolved) = std::fs::canonicalize(candidate) {
            if is_within_root(self.root_display.as_ref(), &resolved) {
                return Ok(());
            }
        }
        Err(FsError::new(
            "outside_root",
            "path is outside the home root",
        ))
    }

    pub(crate) async fn open_preview_source_in_session(
        &self,
        input: &str,
        if_version: Option<String>,
        operations: Arc<HostFileOperations>,
    ) -> FsResult<PreviewSource> {
        let service = self.clone();
        let input = input.to_string();
        self.run_blocking(operations, HostOperationKind::Preview, move |operations| {
            service.open_preview_source_sync(&input, if_version, operations)
        })
        .await
    }

    /// Open a file for rendering, keeping hold of everything needed to place it
    /// somewhere a renderer can reach without ever naming it by path.
    ///
    /// The parent directory handle comes back with the file because staging is
    /// done with `linkat` from that handle — the renderer needs a real path, and
    /// the only safe way to give it one is to make a new name for the exact
    /// inode we already validated.
    fn open_preview_source_sync(
        &self,
        input: &str,
        if_version: Option<String>,
        operations: &HostFileOperations,
    ) -> FsResult<PreviewSource> {
        if operations.cancelled() {
            return Err(cancelled_error());
        }
        let components = self.relative_components(input)?;
        let (parent, name) = self.open_parent(&components)?;
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        let mut file = parent
            .open_with(&name, &options)
            .map_err(nofollow_error)?
            .into_std();
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(FsError::new("not_file", "path is not a regular file"));
        }
        let size = metadata.len();
        if size > PREVIEW_MAX_INPUT_BYTES {
            return Err(FsError::new(
                "preview_too_large",
                "file is too large to render a preview for",
            ));
        }
        let version = file_version(&file)?;
        if let Some(expected) = if_version {
            if expected != version {
                return Err(FsError::new(
                    "version_changed",
                    "file changed since the cached preview",
                ));
            }
        }
        let mut head = vec![0_u8; crate::host_mime::SNIFF_BYTES.min(size as usize)];
        if !head.is_empty() {
            let filled = read_fully(&mut file, &mut head)?;
            head.truncate(filled);
        }
        let identity = crate::platform::file_identity(&file)?;
        Ok(PreviewSource {
            parent,
            name: name.clone(),
            file,
            identity,
            size,
            head,
            version,
            display: self
                .display_path(&components)
                .to_string_lossy()
                .into_owned(),
            leaf: name.to_string_lossy().into_owned(),
        })
    }

    #[cfg(all(test, unix))]
    pub async fn mkdir(&self, input: &str) -> FsResult<String> {
        self.mkdir_in_session(
            input,
            HostFileOperations::new(Arc::new(AtomicBool::new(false))),
        )
        .await
    }

    pub(crate) async fn mkdir_in_session(
        &self,
        input: &str,
        operations: Arc<HostFileOperations>,
    ) -> FsResult<String> {
        let service = self.clone();
        let components = self.relative_components(input)?;
        self.run_blocking(operations, HostOperationKind::Mkdir, move |operations| {
            operations.effect(HostOperationKind::Mkdir, || service.mkdir_sync(&components))
        })
        .await
    }

    fn mkdir_sync(&self, components: &[OsString]) -> FsResult<String> {
        let mut current = self.root.try_clone()?;
        for component in components {
            current = match current.symlink_metadata(component) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return Err(symlink_error());
                }
                Ok(metadata) if metadata.is_dir() => current
                    .open_dir_nofollow(component)
                    .map_err(nofollow_error)?,
                Ok(_) => {
                    return Err(FsError::new(
                        "not_directory",
                        "path component is not a directory",
                    ));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    match current.create_dir(component) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                        Err(error) => return Err(error.into()),
                    }
                    current
                        .open_dir_nofollow(component)
                        .map_err(nofollow_error)?
                }
                Err(error) => return Err(error.into()),
            };
        }
        Ok(self.display_path(components).to_string_lossy().into_owned())
    }

    #[cfg(test)]
    pub async fn rename(&self, input: &str, name: &str, overwrite: bool) -> FsResult<String> {
        self.rename_in_session(
            input,
            name,
            overwrite,
            HostFileOperations::new(Arc::new(AtomicBool::new(false))),
        )
        .await
    }

    pub(crate) async fn rename_in_session(
        &self,
        input: &str,
        name: &str,
        overwrite: bool,
        operations: Arc<HostFileOperations>,
    ) -> FsResult<String> {
        validate_name(name)?;
        let components = self.relative_components(input)?;
        if components.is_empty() {
            return Err(FsError::new("root_protected", "home root is protected"));
        }
        let service = self.clone();
        let name = OsString::from(name);
        self.run_blocking(operations, HostOperationKind::Rename, move |operations| {
            operations.effect(HostOperationKind::Rename, || {
                service.rename_sync(components, &name, overwrite)
            })
        })
        .await
    }

    fn rename_sync(
        &self,
        components: Vec<OsString>,
        name: &OsStr,
        overwrite: bool,
    ) -> FsResult<String> {
        let (parent, source_name) = self.open_parent(&components)?;
        let source_metadata = parent.symlink_metadata(&source_name)?;
        if source_metadata.file_type().is_symlink() {
            return Err(symlink_error());
        }
        if let Ok(destination_metadata) = parent.symlink_metadata(name) {
            if destination_metadata.file_type().is_symlink() {
                return Err(symlink_error());
            }
        }
        if overwrite {
            atomic_rename_replace(&parent, &source_name, name)?;
        } else {
            atomic_rename_noreplace(&parent, &source_name, name)?;
        }
        let mut destination_components = components;
        *destination_components
            .last_mut()
            .expect("parent requires a name") = name.to_os_string();
        sync_directory(&parent)?;
        Ok(self
            .display_path(&destination_components)
            .to_string_lossy()
            .into_owned())
    }

    #[cfg(test)]
    pub async fn remove(&self, input: &str, recursive: bool) -> FsResult<String> {
        self.remove_in_session(
            input,
            recursive,
            HostFileOperations::new(Arc::new(AtomicBool::new(false))),
        )
        .await
    }

    pub(crate) async fn remove_in_session(
        &self,
        input: &str,
        recursive: bool,
        operations: Arc<HostFileOperations>,
    ) -> FsResult<String> {
        let components = self.relative_components(input)?;
        if components.is_empty() {
            return Err(FsError::new("root_protected", "home root is protected"));
        }
        let service = self.clone();
        self.run_blocking(operations, HostOperationKind::Remove, move |operations| {
            operations.effect(HostOperationKind::Remove, || {
                service.remove_sync(&components, recursive)
            })
        })
        .await
    }

    fn remove_sync(&self, components: &[OsString], recursive: bool) -> FsResult<String> {
        let (parent, name) = self.open_parent(components)?;
        let metadata = parent.symlink_metadata(&name)?;
        if metadata.file_type().is_symlink() {
            return Err(symlink_error());
        }
        if metadata.is_dir() {
            if recursive {
                parent.remove_dir_all(&name)?;
            } else {
                parent.remove_dir(&name)?;
            }
        } else {
            parent.remove_file(&name)?;
        }
        sync_directory(&parent)?;
        Ok(self.display_path(components).to_string_lossy().into_owned())
    }

    #[allow(clippy::too_many_arguments)]
    #[cfg(test)]
    pub async fn begin_write(
        &self,
        request_id: String,
        dir: &str,
        name: &str,
        expected_length: u64,
        expected_sha256: &str,
        overwrite: bool,
    ) -> FsResult<PendingWrite> {
        self.begin_write_inner(
            request_id,
            dir,
            name,
            expected_length,
            expected_sha256,
            overwrite,
            None,
            HostFileOperations::new(Arc::new(AtomicBool::new(false))),
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn begin_write_cancellable(
        &self,
        request_id: String,
        dir: &str,
        name: &str,
        expected_length: u64,
        expected_sha256: &str,
        overwrite: bool,
        cancelled: CancellationToken,
        operations: Arc<HostFileOperations>,
    ) -> FsResult<PendingWrite> {
        self.begin_write_inner(
            request_id,
            dir,
            name,
            expected_length,
            expected_sha256,
            overwrite,
            Some(cancelled),
            operations,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn begin_write_inner(
        &self,
        request_id: String,
        dir: &str,
        name: &str,
        expected_length: u64,
        expected_sha256: &str,
        overwrite: bool,
        cancelled: Option<CancellationToken>,
        operations: Arc<HostFileOperations>,
    ) -> FsResult<PendingWrite> {
        if cancelled
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            return Err(FsError::new("cancelled", "file write was cancelled"));
        }
        let service = self.clone();
        let request_id = request_id.to_string();
        let dir = dir.to_string();
        let name = name.to_string();
        let expected_sha256 = expected_sha256.to_string();
        let cleanup_operations = Arc::clone(&operations);
        let write_operations = Arc::clone(&operations);
        let write = self
            .run_blocking(
                operations,
                HostOperationKind::WriteBegin,
                move |operations| {
                    operations.effect(HostOperationKind::WriteBegin, || {
                        service.begin_write_sync(
                            request_id,
                            &dir,
                            &name,
                            expected_length,
                            &expected_sha256,
                            overwrite,
                            write_operations,
                        )
                    })
                },
            )
            .await?;
        if cancelled
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            cleanup_operations.cleanup_write(write).await;
            return Err(cancelled_error());
        }
        Ok(write)
    }

    #[allow(clippy::too_many_arguments)]
    fn begin_write_sync(
        &self,
        request_id: String,
        dir: &str,
        name: &str,
        expected_length: u64,
        expected_sha256: &str,
        overwrite: bool,
        operations: Arc<HostFileOperations>,
    ) -> FsResult<PendingWrite> {
        validate_name(name)?;
        if expected_length > MAX_FILE_BYTES {
            return Err(FsError::new(
                "file_too_large",
                "file exceeds the stream limit",
            ));
        }
        if expected_sha256.len() != 64
            || !expected_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(FsError::new("invalid_hash", "expected SHA-256 is invalid"));
        }
        let components = self.relative_components(dir)?;
        let parent = Arc::new(self.open_dir_components(&components)?);
        let destination_name = OsString::from(name);
        if let Ok(metadata) = parent.symlink_metadata(&destination_name) {
            if metadata.file_type().is_symlink() {
                return Err(symlink_error());
            }
            if !overwrite {
                return Err(FsError::new("already_exists", "destination already exists"));
            }
        }
        let stream_id = Uuid::new_v4().to_string();
        let temporary_name = OsString::from(format!(".spawn-upload-{stream_id}.tmp"));
        let cleanup = Arc::new(PendingWriteCleanup {
            parent: Arc::clone(&parent),
            temporary_name: temporary_name.clone(),
            state: AtomicU8::new(TEMP_PENDING),
        });
        operations.register_temporary(&stream_id, Arc::clone(&cleanup))?;
        if operations.cancelled() || !cleanup.is_pending() {
            operations.unregister_temporary(&stream_id, &cleanup);
            return Err(cancelled_error());
        }
        let mut options = OpenOptions::new();
        options
            .create_new(true)
            .write(true)
            .follow(FollowSymlinks::No);
        let file = match parent.open_with(&temporary_name, &options) {
            Ok(file) => file.into_std(),
            Err(error) => {
                let error = nofollow_error(error);
                let _ = cleanup.unlink_owned();
                operations.unregister_temporary(&stream_id, &cleanup);
                return Err(error);
            }
        };
        #[cfg(test)]
        self.write_lifecycle_hooks
            .begin_after_create
            .pause_if_armed();
        if operations.cancelled() || !cleanup.is_pending() {
            drop(file);
            let _ = cleanup.unlink_late_created();
            let _ = cleanup.unlink_if_pending();
            operations.unregister_temporary(&stream_id, &cleanup);
            return Err(cancelled_error());
        }
        let mut destination_components = components;
        destination_components.push(destination_name.clone());
        Ok(PendingWrite {
            stream_id,
            request_id,
            parent,
            destination_name,
            temporary_name,
            destination_display: self.display_path(&destination_components),
            file: Some(File::from_std(file)),
            expected_length,
            expected_sha256: expected_sha256.to_ascii_lowercase(),
            overwrite,
            received: 0,
            next_sequence: 0,
            hasher: Sha256::new(),
            last_activity: Instant::now(),
            cleanup,
            operations,
            #[cfg(test)]
            write_lifecycle_hooks: Arc::clone(&self.write_lifecycle_hooks),
        })
    }
}

#[cfg(windows)]
fn windows_wire_path(path: &Path) -> PathBuf {
    use std::path::Prefix;

    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return path.to_path_buf();
    };
    let mut output = match prefix.kind() {
        Prefix::VerbatimDisk(drive) | Prefix::Disk(drive) => {
            PathBuf::from(format!("{}:\\", drive as char))
        }
        Prefix::VerbatimUNC(server, share) | Prefix::UNC(server, share) => {
            let mut root = OsString::from(r"\\");
            root.push(server);
            root.push("\\");
            root.push(share);
            root.push("\\");
            PathBuf::from(root)
        }
        _ => return path.to_path_buf(),
    };
    for component in components {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::CurDir => {}
            Component::ParentDir => output.push(".."),
            Component::Normal(part) => output.push(part),
        }
    }
    output
}

fn relative_to_root(root: &Path, candidate: &Path) -> FsResult<PathBuf> {
    #[cfg(unix)]
    {
        candidate
            .strip_prefix(root)
            .map(Path::to_path_buf)
            .map_err(|_| FsError::new("outside_root", "path is outside the home root"))
    }
    #[cfg(windows)]
    {
        let mut root_parts = root.components();
        let mut candidate_parts = candidate.components();
        loop {
            match (root_parts.next(), candidate_parts.next()) {
                (Some(left), Some(right))
                    if left
                        .as_os_str()
                        .to_string_lossy()
                        .eq_ignore_ascii_case(&right.as_os_str().to_string_lossy()) => {}
                (None, next) => {
                    let mut relative = PathBuf::new();
                    if let Some(next) = next {
                        relative.push(next.as_os_str());
                    }
                    for component in candidate_parts {
                        relative.push(component.as_os_str());
                    }
                    return Ok(relative);
                }
                _ => {
                    return Err(FsError::new(
                        "outside_root",
                        "path is outside the home root",
                    ))
                }
            }
        }
    }
}

impl PendingWrite {
    pub async fn append(&mut self, sequence: u64, bytes: &[u8]) -> FsResult<()> {
        if sequence != self.next_sequence {
            return Err(FsError::new(
                "invalid_sequence",
                "stream sequence is out of order",
            ));
        }
        if bytes.is_empty() || bytes.len() > STREAM_CHUNK_BYTES {
            return Err(FsError::new(
                "invalid_chunk",
                "stream chunk has an invalid size",
            ));
        }
        let received = self.received.saturating_add(bytes.len() as u64);
        if received > self.expected_length || received > MAX_FILE_BYTES {
            return Err(FsError::new(
                "length_mismatch",
                "stream exceeds declared length",
            ));
        }
        self.file
            .as_mut()
            .expect("active write retains its temporary file")
            .write_all(bytes)
            .await?;
        self.hasher.update(bytes);
        self.received = received;
        self.next_sequence = self.next_sequence.saturating_add(1);
        self.last_activity = Instant::now();
        Ok(())
    }

    pub fn idle_for(&self) -> Duration {
        self.last_activity.elapsed()
    }

    #[cfg(test)]
    pub async fn finish(self) -> FsResult<String> {
        self.finish_inner(None).await
    }

    pub(crate) async fn finish_guarded(self, guard: WriteSessionGuard) -> FsResult<String> {
        self.finish_inner(Some(guard)).await
    }

    async fn finish_inner(mut self, guard: Option<WriteSessionGuard>) -> FsResult<String> {
        if self.received != self.expected_length {
            return Err(FsError::new(
                "length_mismatch",
                "stream length does not match declaration",
            ));
        }
        let actual = format!("{:x}", self.hasher.finalize_reset());
        if actual != self.expected_sha256 {
            return Err(FsError::new(
                "hash_mismatch",
                "stream SHA-256 does not match declaration",
            ));
        }
        let flush = if let Some(guard) = guard.as_ref() {
            tokio::select! {
                biased;
                _ = guard.cancelled.cancelled() => {
                    return Err(FsError::new("cancelled", "file write was cancelled"));
                }
                result = self.file.as_mut().expect("write file exists").flush() => result,
            }
        } else {
            self.file.as_mut().expect("write file exists").flush().await
        };
        if let Err(error) = flush {
            return Err(error.into());
        }
        let sync = if let Some(guard) = guard.as_ref() {
            tokio::select! {
                biased;
                _ = guard.cancelled.cancelled() => {
                    return Err(FsError::new("cancelled", "file write was cancelled"));
                }
                result = self.file.as_mut().expect("write file exists").sync_all() => result,
            }
        } else {
            self.file
                .as_mut()
                .expect("write file exists")
                .sync_all()
                .await
        };
        if let Err(error) = sync {
            return Err(error.into());
        }
        drop(self.file.take());
        if let Some(guard) = guard {
            if guard.cancelled.is_cancelled() || guard.closed.load(Ordering::Acquire) {
                return Err(cancelled_error());
            }
            let permit = guard.operations.admit()?;
            let operations = Arc::clone(&guard.operations);
            let cancelled = guard.cancelled;
            #[cfg(test)]
            let hooks = Arc::clone(&self.write_lifecycle_hooks);
            let result = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                #[cfg(test)]
                hooks.blocking[HostOperationKind::WriteCommit.index()].pause_if_armed();
                let result = if cancelled.is_cancelled() || operations.cancelled() {
                    Err(cancelled_error())
                } else {
                    let cleanup = Arc::clone(&self.cleanup);
                    operations.write_commit_effect(&cleanup, || self.commit_sync())
                };
                #[cfg(test)]
                hooks.blocking[HostOperationKind::WriteCommit.index()]
                    .finished
                    .notify_one();
                result
            })
            .await
            .map_err(join_error)?;
            if guard.closed.load(Ordering::Acquire) {
                return Err(cancelled_error());
            }
            return result;
        }
        let operations = Arc::clone(&self.operations);
        let cleanup = Arc::clone(&self.cleanup);
        operations.write_commit_effect(&cleanup, || self.commit_sync())
    }

    fn commit_sync(mut self) -> FsResult<String> {
        drop(self.file.take());
        let commit = if self.overwrite {
            if let Ok(metadata) = self.parent.symlink_metadata(&self.destination_name) {
                if metadata.file_type().is_symlink() {
                    Err(symlink_error())
                } else {
                    atomic_rename_replace(
                        self.parent.as_ref(),
                        &self.temporary_name,
                        &self.destination_name,
                    )
                }
            } else {
                atomic_rename_replace(
                    self.parent.as_ref(),
                    &self.temporary_name,
                    &self.destination_name,
                )
            }
        } else {
            atomic_rename_noreplace(
                self.parent.as_ref(),
                &self.temporary_name,
                &self.destination_name,
            )
        };
        commit?;
        self.cleanup.commit();
        self.operations
            .unregister_temporary(&self.stream_id, &self.cleanup);
        sync_directory(self.parent.as_ref())?;
        Ok(self.destination_display.to_string_lossy().into_owned())
    }
}

impl Drop for PendingWrite {
    fn drop(&mut self) {
        // The temporary remains owned until the atomic rename succeeds. This
        // is the final safety net for cancelled futures and cleanup messages
        // dropped while a session is shutting down.
        drop(self.file.take());
        if self.cleanup.unlink_owned().is_ok() && self.cleanup.is_terminal() {
            self.operations
                .unregister_temporary(&self.stream_id, &self.cleanup);
        }
    }
}

fn atomic_rename_noreplace(parent: &Dir, source: &OsStr, destination: &OsStr) -> FsResult<()> {
    #[cfg(unix)]
    match renameat_with(parent, source, parent, destination, RenameFlags::NOREPLACE) {
        Ok(()) => Ok(()),
        Err(rustix::io::Errno::NOSYS | rustix::io::Errno::INVAL | rustix::io::Errno::NOTSUP) => {
            Err(FsError::new(
                "atomic_no_clobber_unsupported",
                "atomic no-clobber rename is unavailable on this filesystem",
            ))
        }
        Err(error) => Err(rustix_io_error(error)),
    }
    #[cfg(windows)]
    {
        crate::platform::rename_noreplace_at(parent, Path::new(source), Path::new(destination))
            .map_err(Into::into)
    }
}

#[cfg(unix)]
fn rustix_io_error(error: rustix::io::Errno) -> FsError {
    std::io::Error::from_raw_os_error(error.raw_os_error()).into()
}

fn atomic_rename_replace(parent: &Dir, source: &OsStr, destination: &OsStr) -> FsResult<()> {
    #[cfg(unix)]
    {
        renameat(parent, source, parent, destination).map_err(rustix_io_error)
    }
    #[cfg(windows)]
    {
        crate::platform::durable_replace_at(parent, Path::new(source), Path::new(destination))
            .map_err(Into::into)
    }
}

pub(crate) fn nofollow_error(error: std::io::Error) -> FsError {
    if matches!(error.raw_os_error(), Some(40)) {
        symlink_error()
    } else {
        error.into()
    }
}

fn sync_directory(directory: &Dir) -> FsResult<()> {
    crate::platform::fsync_dir(directory)?;
    Ok(())
}

fn symlink_error() -> FsError {
    FsError::new("symlink_rejected", "symbolic links are not followed")
}

fn join_error(error: tokio::task::JoinError) -> FsError {
    FsError::new("io_error", format!("filesystem task failed: {error}"))
}

pub(crate) fn cancelled_error() -> FsError {
    FsError::new("cancelled", "filesystem operation was cancelled")
}

fn outcome_unknown_error() -> FsError {
    FsError::new(
        "outcome_unknown",
        "filesystem mutation may have completed; reconcile host state before retrying",
    )
}

/// A file opened for rendering, plus the handle needed to stage it safely.
pub struct PreviewSource {
    /// Directory handle the file lives in, for `linkat`.
    pub parent: Dir,
    pub name: OsString,
    pub file: std::fs::File,
    pub identity: crate::platform::FileIdentity,
    pub size: u64,
    pub head: Vec<u8>,
    pub version: String,
    pub display: String,
    pub leaf: String,
}

/// A validated desktop target: a real path plus what the daemon needs to
/// decide whether handing it to LaunchServices is acceptable.
#[cfg(target_os = "macos")]
pub struct LaunchTarget {
    pub display: PathBuf,
    pub is_dir: bool,
    pub mode: u32,
    pub name: OsString,
    pub head: Vec<u8>,
}

/// The kernel's own name for the object behind a descriptor.
#[cfg(target_os = "macos")]
fn real_path_of(handle: std::os::fd::BorrowedFd<'_>) -> FsResult<PathBuf> {
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStringExt;

    let mut buffer = vec![0_u8; nix::libc::PATH_MAX as usize];
    // SAFETY: the descriptor is live for the call and the buffer is PATH_MAX,
    // which is what F_GETPATH documents it writes into.
    let result = unsafe {
        nix::libc::fcntl(
            handle.as_raw_fd(),
            nix::libc::F_GETPATH,
            buffer.as_mut_ptr().cast::<nix::libc::c_char>(),
        )
    };
    if result == -1 {
        return Err(FsError::new(
            "io_error",
            "could not resolve the target path",
        ));
    }
    let end = buffer
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(buffer.len());
    buffer.truncate(end);
    Ok(PathBuf::from(OsString::from_vec(buffer)))
}

/// Component-wise containment. Deliberately not a string prefix test, which
/// would let `/Users/mel` pass as inside `/Users/me`.
#[cfg(target_os = "macos")]
fn is_within_root(root: &Path, candidate: &Path) -> bool {
    let mut root_parts = root.components();
    let mut candidate_parts = candidate.components();
    loop {
        match (root_parts.next(), candidate_parts.next()) {
            (Some(left), Some(right)) if left == right => continue,
            (None, _) => return true,
            _ => return false,
        }
    }
}

/// Read until the buffer is full or the file ends; returns bytes filled.
///
/// `Read::read` is free to return a short count for any reason, so a single
/// call is not a sniff window.
fn read_fully(file: &mut std::fs::File, buffer: &mut [u8]) -> FsResult<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        let read = file.read(&mut buffer[filled..])?;
        if read == 0 {
            break;
        }
        filled += read;
    }
    Ok(filled)
}

/// A validator that changes whenever the file's content could have.
///
/// Identity and nanosecond mtime are both load-bearing: `modified_at` has
/// one-second granularity, which misses an edit made in the same second as the
/// read, and inode identity catches the replace-by-rename that leaves mtime
/// looking plausible.
///
/// The kernel stamps mtimes from its coarse clock (one tick, typically 1–4ms),
/// so two same-size in-place rewrites inside a single tick are still
/// indistinguishable. That window is accepted: it closes on the next change to
/// the file, and closing it entirely would mean hashing content on every read.
fn file_version(file: &std::fs::File) -> FsResult<String> {
    let mut hasher = Sha256::new();
    hasher.update(crate::platform::file_stamp(file)?.version_bytes());
    let digest = format!("{:x}", hasher.finalize());
    Ok(digest[..16].to_string())
}

pub(crate) fn modified_seconds(metadata: &fs::Metadata) -> Option<i64> {
    metadata
        .modified()
        .ok()
        .map(cap_std::time::SystemTime::into_std)
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .and_then(|duration| i64::try_from(duration.as_secs()).ok())
}

fn validate_name(name: &str) -> FsResult<()> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.len() > 255
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains(['/', '\\'])
        || trimmed.chars().any(char::is_control)
    {
        return Err(FsError::new("invalid_name", "file name is invalid"));
    }
    #[cfg(windows)]
    {
        if name.ends_with(['.', ' '])
            || name
                .chars()
                .any(|ch| matches!(ch, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
            || windows_reserved_name(name)
        {
            return Err(FsError::new("invalid_name", "file name is invalid"));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn windows_reserved_name(name: &str) -> bool {
    let base = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || base
            .strip_prefix("COM")
            .or_else(|| base.strip_prefix("LPT"))
            .is_some_and(|suffix| suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::sync::atomic::AtomicBool;
    use tokio::io::AsyncReadExt;

    #[test]
    fn post_boundary_mutation_errors_are_indeterminate() {
        let operations = HostFileOperations::new(Arc::new(AtomicBool::new(false)));
        for kind in [
            HostOperationKind::Mkdir,
            HostOperationKind::Rename,
            HostOperationKind::Remove,
            HostOperationKind::WriteCommit,
        ] {
            let error = operations
                .effect::<()>(kind, || Err(FsError::new("io_error", "injected failure")))
                .unwrap_err();
            assert_eq!(error.code, "outcome_unknown");
            assert_eq!(
                error.detail,
                "filesystem mutation may have completed; reconcile host state before retrying"
            );
        }

        let error = operations
            .effect::<()>(HostOperationKind::WriteBegin, || {
                Err(FsError::new("already_exists", "injected no-effect failure"))
            })
            .unwrap_err();
        assert_eq!(error.code, "already_exists");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pending_temp_cleanup_does_not_wait_for_an_unrelated_linearized_effect() {
        let temp = tempfile::tempdir().unwrap();
        let service = HostFileService::rooted_at(temp.path()).await.unwrap();
        let hooks = service.write_lifecycle_test_hooks();
        let closed = Arc::new(AtomicBool::new(false));
        let operations = HostFileOperations::new(Arc::clone(&closed));
        operations.set_effect_test_hooks(Arc::clone(&hooks));
        let write = service
            .begin_write_cancellable(
                "registered-temp".to_string(),
                "~",
                "pending.bin",
                0,
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                false,
                CancellationToken::new(),
                Arc::clone(&operations),
            )
            .await
            .unwrap();
        assert!(temp.path().read_dir().unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".spawn-upload-")));

        hooks.arm_effect_boundary(HostOperationKind::Mkdir);
        let effect_operations = Arc::clone(&operations);
        let effect = tokio::task::spawn_blocking(move || {
            effect_operations.effect(HostOperationKind::Mkdir, || Ok(()))
        });
        hooks
            .wait_effect_boundary_entered(HostOperationKind::Mkdir)
            .await;

        closed.store(true, Ordering::Release);
        tokio::time::timeout(
            Duration::from_secs(2),
            operations.cleanup_temporaries_until(
                tokio::time::Instant::now() + Duration::from_millis(100),
            ),
        )
        .await
        .expect("pending temporary cleanup stalled behind an unrelated effect");
        assert!(!temp.path().join("pending.bin").exists());
        assert!(!temp.path().read_dir().unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".spawn-upload-")));

        hooks.release_effect_boundary(HostOperationKind::Mkdir);
        tokio::time::timeout(Duration::from_secs(2), effect)
            .await
            .expect("unrelated effect did not resume")
            .unwrap()
            .unwrap();
        drop(write);
        assert!(!temp.path().join("pending.bin").exists());
    }

    #[tokio::test]
    async fn range_read_declares_and_streams_exactly_the_requested_slice() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("data.bin"), b"0123456789").unwrap();
        let service = HostFileService::rooted_at(temp.path()).await.unwrap();

        let mut range = service
            .open_range_read("data.bin", 3, 4, None)
            .await
            .unwrap();
        assert_eq!(range.offset, 3);
        assert_eq!(range.length, 4);
        assert_eq!(range.stat.size, 10);
        assert!(!range.eof);
        // The digest covers the slice, not the file — that is the contract that
        // makes a preview of a huge file cost a small hash.
        assert_eq!(range.sha256, format!("{:x}", Sha256::digest(b"3456")));

        let mut bytes = Vec::new();
        range.file.read_to_end(&mut bytes).await.unwrap();
        assert_eq!(&bytes[..4], b"3456");
    }

    #[tokio::test]
    async fn range_read_clamps_a_short_tail_and_reports_eof() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("data.bin"), b"0123456789").unwrap();
        let service = HostFileService::rooted_at(temp.path()).await.unwrap();

        let range = service
            .open_range_read("data.bin", 8, 4096, None)
            .await
            .unwrap();
        assert_eq!(range.length, 2);
        assert!(range.eof);
        assert_eq!(range.sha256, format!("{:x}", Sha256::digest(b"89")));
    }

    #[tokio::test]
    async fn range_read_refuses_offsets_past_the_end_and_oversized_lengths() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("data.bin"), b"0123456789").unwrap();
        let service = HostFileService::rooted_at(temp.path()).await.unwrap();

        assert_eq!(
            service
                .open_range_read("data.bin", 11, 1, None)
                .await
                .map(|_| ())
                .unwrap_err()
                .code,
            "range_not_satisfiable"
        );
        assert_eq!(
            service
                .open_range_read("data.bin", 0, MAX_RANGE_BYTES + 1, None)
                .await
                .map(|_| ())
                .unwrap_err()
                .code,
            "range_too_large"
        );
        assert_eq!(
            service
                .open_range_read("data.bin", 0, 0, None)
                .await
                .map(|_| ())
                .unwrap_err()
                .code,
            "range_too_large"
        );
    }

    #[tokio::test]
    async fn range_read_refuses_a_directory() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("folder")).unwrap();
        let service = HostFileService::rooted_at(temp.path()).await.unwrap();
        assert_eq!(
            service
                .open_range_read("folder", 0, 16, None)
                .await
                .map(|_| ())
                .unwrap_err()
                .code,
            "not_file"
        );
    }

    #[tokio::test]
    async fn file_version_changes_on_a_same_second_rewrite() {
        // This is the test that justifies hashing nanoseconds and inode identity
        // rather than the second-granularity mtime the wire already carries: an
        // edit made in the same second as the read would otherwise look
        // unchanged and serve a stale preview forever.
        //
        // The mtimes are pinned rather than taken from the clock: the kernel
        // stamps writes from its coarse clock, so two natural rewrites can land
        // in one tick and carry identical nanoseconds — the exact same-second
        // rewrite this test exists to distinguish would then be invisible for a
        // reason outside the claim under test.
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("data.bin");
        let pin_mtime = |nanos: u32| {
            let file = std::fs::File::options().write(true).open(&path).unwrap();
            let modified = std::time::UNIX_EPOCH + std::time::Duration::new(1_755_000_000, nanos);
            file.set_times(std::fs::FileTimes::new().set_modified(modified))
                .unwrap();
        };
        std::fs::write(&path, b"aaaa").unwrap();
        pin_mtime(111_111_111);
        let service = HostFileService::rooted_at(temp.path()).await.unwrap();

        let first = service
            .open_range_read("data.bin", 0, 4, None)
            .await
            .unwrap();
        std::fs::write(&path, b"bbbb").unwrap();
        pin_mtime(222_222_222);
        let second = service
            .open_range_read("data.bin", 0, 4, None)
            .await
            .unwrap();
        assert_ne!(first.version, second.version);

        // And the validator is enforced, not merely reported.
        assert_eq!(
            service
                .open_range_read("data.bin", 0, 4, Some(first.version.clone()))
                .await
                .map(|_| ())
                .unwrap_err()
                .code,
            "version_changed"
        );
        service
            .open_range_read("data.bin", 0, 4, Some(second.version.clone()))
            .await
            .expect("the current version still matches");
    }

    #[tokio::test]
    async fn range_read_classifies_from_the_head_not_the_requested_slice() {
        // Classification needs the start of the file even when the slice asked
        // for is somewhere in the middle.
        let temp = tempfile::tempdir().unwrap();
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend_from_slice(&[0_u8; 64]);
        std::fs::write(temp.path().join("image.png"), &png).unwrap();
        let service = HostFileService::rooted_at(temp.path()).await.unwrap();

        let range = service
            .open_range_read("image.png", 32, 8, None)
            .await
            .unwrap();
        assert_eq!(range.content_type, "image/png");
        assert_eq!(range.content_type_source, "magic");
        assert!(range.open_allowed);
    }

    #[tokio::test]
    async fn preview_source_refuses_a_file_beyond_the_render_limit() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("huge.bin");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(PREVIEW_MAX_INPUT_BYTES + 1).unwrap();
        drop(file);
        let service = HostFileService::rooted_at(temp.path()).await.unwrap();
        assert_eq!(
            service
                .open_preview_source("huge.bin")
                .await
                .map(|_| ())
                .unwrap_err()
                .code,
            "preview_too_large"
        );
    }

    #[tokio::test]
    async fn confines_paths_and_rejects_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("safe")).unwrap();
        let service = HostFileService::rooted_at(temp.path()).await.unwrap();
        assert_eq!(
            service.list("../escape", 0).await.unwrap_err().code,
            "traversal_rejected"
        );
        let rooted_traversal = service.root_display.join("..").join("escape");
        assert_eq!(
            service
                .list(rooted_traversal.to_string_lossy().as_ref(), 0)
                .await
                .unwrap_err()
                .code,
            "traversal_rejected"
        );
        #[cfg(unix)]
        {
            assert_eq!(
                service.list("/tmp", 0).await.unwrap_err().code,
                "outside_root"
            );
            std::os::unix::fs::symlink("/tmp", temp.path().join("link")).unwrap();
            assert_eq!(
                service.list("link", 0).await.unwrap_err().code,
                "symlink_rejected"
            );
        }
        #[cfg(windows)]
        {
            assert_eq!(
                service.list(r"C:\Windows", 0).await.unwrap_err().code,
                "outside_root"
            );
            service
                .list(service.root_display.to_string_lossy().as_ref(), 0)
                .await
                .expect("the canonical advertised root is accepted as absolute input");

            // A junction is a directory reparse point standard users can make
            // without Developer Mode. Keep this case mandatory even when the
            // runner cannot create a true directory symlink.
            let junction = temp.path().join("junction");
            let status = std::process::Command::new("cmd.exe")
                .args(["/d", "/c", "mklink", "/J"])
                .arg(&junction)
                .arg(temp.path().join("safe"))
                .status()
                .expect("cmd.exe must be available on Windows CI");
            assert!(status.success(), "mklink /J failed with {status}");
            assert_eq!(
                service.list("junction", 0).await.unwrap_err().code,
                "symlink_rejected"
            );

            let link = temp.path().join("directory-symlink");
            match std::os::windows::fs::symlink_dir(temp.path().join("safe"), &link) {
                Ok(()) => assert_eq!(
                    service.list("directory-symlink", 0).await.unwrap_err().code,
                    "symlink_rejected"
                ),
                Err(error) if crate::platform::symlink_fixture_unavailable(&error) => {}
                Err(error) => panic!("creating directory symlink failed unexpectedly: {error}"),
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_native_absolute_paths_are_compared_case_insensitively() {
        assert_eq!(
            windows_wire_path(Path::new(r"\\?\C:\Users\Example\Workspace")),
            PathBuf::from(r"C:\Users\Example\Workspace")
        );
        assert_eq!(
            windows_wire_path(Path::new(r"\\?\UNC\server\share\Workspace")),
            PathBuf::from(r"\\server\share\Workspace")
        );
        let root = Path::new(r"C:\Users\Example\Workspace");
        assert_eq!(
            relative_to_root(root, Path::new(r"c:\users\example\workspace\src\main.rs")).unwrap(),
            PathBuf::from(r"src\main.rs")
        );
        assert_eq!(
            relative_to_root(root, Path::new(r"C:\Users\Example\Elsewhere"))
                .unwrap_err()
                .code,
            "outside_root"
        );
        assert_eq!(
            relative_to_root(
                Path::new(r"\\server\share\Workspace"),
                Path::new(r"\\SERVER\SHARE\workspace\notes.txt")
            )
            .unwrap(),
            PathBuf::from("notes.txt")
        );
    }

    #[tokio::test]
    async fn atomic_write_verifies_length_hash_and_no_clobber() {
        let temp = tempfile::tempdir().unwrap();
        let service = HostFileService::rooted_at(temp.path()).await.unwrap();
        let expected = format!("{:x}", Sha256::digest(b"hello"));
        let mut write = service
            .begin_write("req".into(), "~", "hello.txt", 5, &expected, false)
            .await
            .unwrap();
        write.append(0, b"hello").await.unwrap();
        let path = write.finish().await.unwrap();
        assert_eq!(std::fs::read(path).unwrap(), b"hello");

        let mut raced = service
            .begin_write("race".into(), "~", "raced.txt", 5, &expected, false)
            .await
            .unwrap();
        raced.append(0, b"hello").await.unwrap();
        std::fs::write(temp.path().join("raced.txt"), b"canary").unwrap();
        assert_eq!(raced.finish().await.unwrap_err().code, "outcome_unknown");
        assert_eq!(
            std::fs::read(temp.path().join("raced.txt")).unwrap(),
            b"canary"
        );

        let mut bad = service
            .begin_write("bad".into(), "~", "bad.txt", 6, &expected, false)
            .await
            .unwrap();
        bad.append(0, b"hello").await.unwrap();
        assert_eq!(bad.finish().await.unwrap_err().code, "length_mismatch");
        assert!(!temp.path().join("bad.txt").exists());
        assert!(std::fs::read_dir(temp.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("spawn-upload")));
    }

    #[tokio::test]
    async fn list_is_bounded_without_inventorying_or_sorting_the_directory() {
        let temp = tempfile::tempdir().unwrap();
        for index in 0..(MAX_DIRECTORY_ENTRIES + 100) {
            std::fs::write(temp.path().join(format!("file-{index:04}.txt")), b"body").unwrap();
        }
        let service = HostFileService::rooted_at(temp.path()).await.unwrap();
        let mut cursor = 0;
        let mut seen = 0;
        loop {
            let page = service.list("~", cursor).await.unwrap();
            assert!(page.entries.len() <= MAX_LIST_ENTRIES_PER_PAGE);
            seen += page.entries.len();
            if page.truncated {
                assert_eq!(seen, MAX_DIRECTORY_ENTRIES);
                assert!(page.next_cursor.is_none());
                break;
            }
            cursor = page
                .next_cursor
                .expect("large directory has another bounded page");
        }
    }

    #[tokio::test]
    async fn lists_reads_renames_and_removes_through_capabilities() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("source.txt"), b"body").unwrap();
        let service = HostFileService::rooted_at(temp.path()).await.unwrap();
        let first = service.list("~", 0).await.unwrap();
        assert_eq!(first.entries.len(), 1);

        let mut read = service.open_read("source.txt").await.unwrap();
        let mut bytes = Vec::new();
        read.file.read_to_end(&mut bytes).await.unwrap();
        assert_eq!(bytes, b"body");
        assert_eq!(read.sha256, format!("{:x}", Sha256::digest(b"body")));

        let renamed = service
            .rename("source.txt", "renamed.txt", false)
            .await
            .unwrap();
        assert!(Path::new(&renamed).exists());
        service.remove("renamed.txt", false).await.unwrap();
        assert!(!Path::new(&renamed).exists());
        assert_eq!(
            service.remove("~", true).await.unwrap_err().code,
            "root_protected"
        );
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn every_operation_resists_a_component_symlink_swap_loop() {
        const ITERATIONS: usize = 48;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let outside = temp.path().join("outside");
        let swap = root.join("swap");
        std::fs::create_dir_all(&swap).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(swap.join("inside-only"), b"inside").unwrap();
        std::fs::write(swap.join("read.txt"), b"inside").unwrap();
        std::fs::write(outside.join("outside-canary"), b"outside").unwrap();
        std::fs::write(outside.join("read.txt"), b"outside-secret").unwrap();
        for index in 0..ITERATIONS {
            std::fs::write(swap.join(format!("rename-{index}")), b"inside").unwrap();
            std::fs::write(outside.join(format!("rename-{index}")), b"outside").unwrap();
            std::fs::create_dir(swap.join(format!("remove-{index}"))).unwrap();
            std::fs::write(
                outside.join(format!("remove-{index}")),
                b"outside-remove-canary",
            )
            .unwrap();
        }
        let service = HostFileService::rooted_at(&root).await.unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let swap_stop = Arc::clone(&stop);
        let swap_root = root.clone();
        let swap_outside = outside.clone();
        let swapper = std::thread::spawn(move || {
            let swap = swap_root.join("swap");
            let held = swap_root.join("held");
            while !swap_stop.load(Ordering::Acquire) {
                if std::fs::rename(&swap, &held).is_ok() {
                    let _ = std::os::unix::fs::symlink(&swap_outside, &swap);
                    std::thread::yield_now();
                    let _ = std::fs::remove_file(&swap);
                    let _ = std::fs::rename(&held, &swap);
                }
            }
            let _ = std::fs::remove_file(&swap);
            let _ = std::fs::rename(&held, &swap);
        });

        let expected_hash = format!("{:x}", Sha256::digest(b"inside"));
        for index in 0..ITERATIONS {
            if let Ok(page) = service.list("swap", 0).await {
                assert!(page
                    .entries
                    .iter()
                    .all(|entry| entry.name != "outside-canary"));
            }
            if let Ok(stat) = service.stat("swap/read.txt").await {
                assert_eq!(stat.size, 6);
            }
            if let Ok(mut read) = service.open_read("swap/read.txt").await {
                let mut bytes = Vec::new();
                read.file.read_to_end(&mut bytes).await.unwrap();
                assert_eq!(bytes, b"inside");
            }
            // Every operation that resolves a path belongs in this loop; one
            // that is missing from it is untested against the only attack that
            // matters here.
            if let Ok(mut range) = service.open_range_read("swap/read.txt", 0, 6, None).await {
                let mut bytes = Vec::new();
                range.file.read_to_end(&mut bytes).await.unwrap();
                assert_eq!(bytes, b"inside");
                assert_eq!(range.stat.size, 6);
            }
            if let Ok(source) = service.open_preview_source("swap/read.txt").await {
                assert_eq!(source.head, b"inside");
                assert_eq!(source.size, 6);
            }
            #[cfg(target_os = "macos")]
            if let Ok(target) = service.open_launch_target("swap/read.txt", true).await {
                assert!(
                    !target.display.starts_with(&outside),
                    "a launch target must never resolve outside the root"
                );
                assert_eq!(target.head, b"inside");
            }
            let _ = service.mkdir(&format!("swap/mkdir-{index}")).await;
            let _ = service
                .rename(
                    &format!("swap/rename-{index}"),
                    &format!("renamed-{index}"),
                    false,
                )
                .await;
            let _ = service.remove(&format!("swap/remove-{index}"), true).await;
            if let Ok(mut write) = service
                .begin_write(
                    format!("swap-write-{index}"),
                    "swap",
                    &format!("upload-{index}"),
                    6,
                    &expected_hash,
                    false,
                )
                .await
            {
                write.append(0, b"inside").await.unwrap();
                let _ = write.finish().await;
            }
        }
        stop.store(true, Ordering::Release);
        swapper.join().unwrap();

        assert_eq!(
            std::fs::read(outside.join("outside-canary")).unwrap(),
            b"outside"
        );
        assert_eq!(
            std::fs::read(outside.join("read.txt")).unwrap(),
            b"outside-secret"
        );
        for index in 0..ITERATIONS {
            assert_eq!(
                std::fs::read(outside.join(format!("rename-{index}"))).unwrap(),
                b"outside"
            );
            assert_eq!(
                std::fs::read(outside.join(format!("remove-{index}"))).unwrap(),
                b"outside-remove-canary"
            );
            assert!(!outside.join(format!("mkdir-{index}")).exists());
            assert!(!outside.join(format!("renamed-{index}")).exists());
            assert!(!outside.join(format!("upload-{index}")).exists());
            assert!(!outside.read_dir().unwrap().any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("spawn-upload")));
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn no_clobber_rename_is_atomic_under_destination_creation_races() {
        let temp = tempfile::tempdir().unwrap();
        let service = HostFileService::rooted_at(temp.path()).await.unwrap();
        for index in 0..128 {
            let source_name = format!("source-{index}");
            let destination_name = format!("destination-{index}");
            std::fs::write(temp.path().join(&source_name), b"source").unwrap();
            let destination = temp.path().join(&destination_name);
            let contender_destination = destination.clone();
            let contender = tokio::task::spawn_blocking(move || {
                std::fs::OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(contender_destination)
                    .and_then(|mut file| file.write_all(b"contender"))
            });
            let renamed = service.rename(&source_name, &destination_name, false).await;
            let contender_won = contender.await.unwrap().is_ok();
            let bytes = std::fs::read(&destination).unwrap();
            if contender_won {
                assert_eq!(bytes, b"contender");
                assert_eq!(renamed.unwrap_err().code, "outcome_unknown");
                assert!(temp.path().join(&source_name).exists());
            } else {
                assert_eq!(bytes, b"source");
                assert!(renamed.is_ok());
            }
        }
    }
}
