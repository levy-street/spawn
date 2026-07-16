//! Endpoint-only host filesystem operations for `spawn.host.ctl`.
//!
//! The root directory is opened once as a capability. Every later operation is
//! relative to held directory handles, walks each component with no-follow
//! semantics, and never re-enters the ambient filesystem namespace.

use std::ffi::{OsStr, OsString};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
#[cfg(test)]
use std::sync::Condvar;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use cap_std::{ambient_authority, fs};
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

#[derive(Debug)]
pub struct FsError {
    pub code: &'static str,
    pub detail: String,
}

impl FsError {
    fn new(code: &'static str, detail: impl Into<String>) -> Self {
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

pub struct PendingWrite {
    pub stream_id: String,
    pub request_id: String,
    parent: Dir,
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
    temporary_owned: bool,
    #[cfg(test)]
    write_lifecycle_hooks: Arc<WriteLifecycleTestHooks>,
}

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
        })
    }

    fn cancelled(&self) -> bool {
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

    fn effect<T>(&self, effect: impl FnOnce() -> FsResult<T>) -> FsResult<T> {
        let _fence = self
            .effect_fence
            .lock()
            .map_err(|_| FsError::new("io_error", "filesystem effect fence is poisoned"))?;
        if self.cancelled() {
            return Err(cancelled_error());
        }
        // This check is the mutation's linearization point. Close publishes
        // `closed` before waiting for operations: a closure that reaches this
        // point first may finish its already-admitted syscall, while every
        // closure that was still queued or stalled must fail without effects.
        effect()
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
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) enum HostOperationKind {
    List,
    Stat,
    Read,
    Mkdir,
    Rename,
    Remove,
    WriteBegin,
    WriteCommit,
}

#[cfg_attr(not(test), allow(dead_code))]
impl HostOperationKind {
    const fn index(self) -> usize {
        self as usize
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
    begin_after_create: WritePause,
    shutdown_started: Notify,
    shutdown_returned: Notify,
    blocking: [BlockingPause; 8],
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

    pub(crate) fn arm_begin_after_create(&self) {
        self.begin_after_create.arm();
    }

    pub(crate) async fn wait_begin_after_create(&self) {
        self.begin_after_create.wait_until_entered().await;
    }

    pub(crate) fn release_begin_after_create(&self) {
        self.begin_after_create.release();
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
        let root_display = std::fs::canonicalize(root)?;
        let root = Dir::open_ambient_dir(&root_display, ambient_authority())?;
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

    async fn run_blocking<T, F>(
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

    fn relative_components(&self, input: &str) -> FsResult<Vec<OsString>> {
        if input.as_bytes().contains(&0) {
            return Err(FsError::new("invalid_path", "path contains a NUL byte"));
        }
        let trimmed = input.trim();
        let relative = if trimmed.is_empty() || trimmed == "~" {
            PathBuf::new()
        } else if let Some(rest) = trimmed.strip_prefix("~/") {
            PathBuf::from(rest)
        } else {
            let path = Path::new(trimmed);
            if path.is_absolute() {
                path.strip_prefix(self.root_display.as_ref())
                    .map(Path::to_path_buf)
                    .map_err(|_| FsError::new("outside_root", "path is outside the home root"))?
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

    fn display_path(&self, components: &[OsString]) -> PathBuf {
        let mut path = self.root_display.as_ref().clone();
        for component in components {
            path.push(component);
        }
        path
    }

    fn open_dir_components(&self, components: &[OsString]) -> FsResult<Dir> {
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

    #[cfg(test)]
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

    #[cfg(test)]
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
        let input = input.to_string();
        self.run_blocking(operations, HostOperationKind::Mkdir, move |operations| {
            operations.effect(|| service.mkdir_sync(&input))
        })
        .await
    }

    fn mkdir_sync(&self, input: &str) -> FsResult<String> {
        let components = self.relative_components(input)?;
        let mut current = self.root.try_clone()?;
        for component in &components {
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
        Ok(self
            .display_path(&components)
            .to_string_lossy()
            .into_owned())
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
        let service = self.clone();
        let input = input.to_string();
        let name = OsString::from(name);
        self.run_blocking(operations, HostOperationKind::Rename, move |operations| {
            operations.effect(|| service.rename_sync(&input, &name, overwrite))
        })
        .await
    }

    fn rename_sync(&self, input: &str, name: &OsStr, overwrite: bool) -> FsResult<String> {
        let components = self.relative_components(input)?;
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
            renameat(&parent, &source_name, &parent, name).map_err(rustix_io_error)?;
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
        let service = self.clone();
        let input = input.to_string();
        self.run_blocking(operations, HostOperationKind::Remove, move |operations| {
            operations.effect(|| service.remove_sync(&input, recursive))
        })
        .await
    }

    fn remove_sync(&self, input: &str, recursive: bool) -> FsResult<String> {
        let components = self.relative_components(input)?;
        let (parent, name) = self.open_parent(&components)?;
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
        Ok(self
            .display_path(&components)
            .to_string_lossy()
            .into_owned())
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
        let write = self
            .run_blocking(
                operations,
                HostOperationKind::WriteBegin,
                move |operations| {
                    operations.effect(|| {
                        service.begin_write_sync(
                            request_id,
                            &dir,
                            &name,
                            expected_length,
                            &expected_sha256,
                            overwrite,
                        )
                    })
                },
            )
            .await?;
        #[cfg(test)]
        if !write
            .write_lifecycle_hooks
            .begin_after_create
            .pause_if_armed(cancelled.as_ref())
            .await
        {
            cleanup_operations.cleanup_write(write).await;
            return Err(cancelled_error());
        }
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
        let parent = self.open_dir_components(&components)?;
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
        let mut options = OpenOptions::new();
        options
            .create_new(true)
            .write(true)
            .follow(FollowSymlinks::No);
        let file = parent
            .open_with(&temporary_name, &options)
            .map_err(nofollow_error)?
            .into_std();
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
            temporary_owned: true,
            #[cfg(test)]
            write_lifecycle_hooks: Arc::clone(&self.write_lifecycle_hooks),
        })
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
                    operations.effect(|| self.commit_sync())
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
        self.commit_sync()
    }

    fn commit_sync(mut self) -> FsResult<String> {
        drop(self.file.take());
        let commit = if self.overwrite {
            if let Ok(metadata) = self.parent.symlink_metadata(&self.destination_name) {
                if metadata.file_type().is_symlink() {
                    Err(symlink_error())
                } else {
                    renameat(
                        &self.parent,
                        &self.temporary_name,
                        &self.parent,
                        &self.destination_name,
                    )
                    .map_err(rustix_io_error)
                }
            } else {
                renameat(
                    &self.parent,
                    &self.temporary_name,
                    &self.parent,
                    &self.destination_name,
                )
                .map_err(rustix_io_error)
            }
        } else {
            atomic_rename_noreplace(&self.parent, &self.temporary_name, &self.destination_name)
        };
        commit?;
        self.temporary_owned = false;
        sync_directory(&self.parent)?;
        Ok(self.destination_display.to_string_lossy().into_owned())
    }
}

impl Drop for PendingWrite {
    fn drop(&mut self) {
        // The temporary remains owned until the atomic rename succeeds. This
        // is the final safety net for cancelled futures and cleanup messages
        // dropped while a session is shutting down.
        drop(self.file.take());
        if self.temporary_owned {
            let _ = self.parent.remove_file(&self.temporary_name);
            self.temporary_owned = false;
        }
    }
}

fn atomic_rename_noreplace(parent: &Dir, source: &OsStr, destination: &OsStr) -> FsResult<()> {
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
}

fn rustix_io_error(error: rustix::io::Errno) -> FsError {
    std::io::Error::from_raw_os_error(error.raw_os_error()).into()
}

fn nofollow_error(error: std::io::Error) -> FsError {
    if matches!(error.raw_os_error(), Some(40)) {
        symlink_error()
    } else {
        error.into()
    }
}

fn sync_directory(directory: &Dir) -> FsResult<()> {
    directory.open(".")?.into_std().sync_all()?;
    Ok(())
}

fn symlink_error() -> FsError {
    FsError::new("symlink_rejected", "symbolic links are not followed")
}

fn join_error(error: tokio::task::JoinError) -> FsError {
    FsError::new("io_error", format!("filesystem task failed: {error}"))
}

fn cancelled_error() -> FsError {
    FsError::new("cancelled", "filesystem operation was cancelled")
}

fn modified_seconds(metadata: &fs::Metadata) -> Option<i64> {
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
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::sync::atomic::AtomicBool;
    use tokio::io::AsyncReadExt;

    #[tokio::test]
    async fn confines_paths_and_rejects_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("safe")).unwrap();
        let service = HostFileService::rooted_at(temp.path()).await.unwrap();
        assert_eq!(
            service.list("../escape", 0).await.unwrap_err().code,
            "traversal_rejected"
        );
        assert_eq!(
            service
                .list(&format!("{}/../escape", temp.path().display()), 0)
                .await
                .unwrap_err()
                .code,
            "traversal_rejected"
        );
        assert_eq!(
            service.list("/tmp", 0).await.unwrap_err().code,
            "outside_root"
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/tmp", temp.path().join("link")).unwrap();
            assert_eq!(
                service.list("link", 0).await.unwrap_err().code,
                "symlink_rejected"
            );
        }
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
        assert_eq!(raced.finish().await.unwrap_err().code, "already_exists");
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
                assert_eq!(renamed.unwrap_err().code, "already_exists");
            } else {
                assert_eq!(bytes, b"source");
                assert!(renamed.is_ok());
            }
        }
    }
}
