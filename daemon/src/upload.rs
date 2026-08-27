use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
#[cfg(test)]
use std::sync::{Barrier, Condvar};
use std::time::{Duration, Instant as StdInstant};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use cap_fs_ext::DirExt;
use cap_std::fs::Dir;
use cap_std::{ambient_authority, fs::Dir as CapDir};
use sha2::{Digest, Sha256};
#[cfg(test)]
use tokio::fs;
use tokio::sync::Notify;
use tokio::time::Instant as TokioInstant;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::sessions::SessionBinding;

pub const MAX_UPLOAD_BYTES: usize = 20 * 1024 * 1024;
pub const UPLOAD_CHUNK_BYTES: usize = 48 * 1024;
pub const MAX_ACTIVE_UPLOADS_PER_VIEWER: usize = 4;
pub const MAX_ACTIVE_UPLOADS_TOTAL: usize = 64;
pub const MAX_COMPLETED_UPLOADS: usize = 128;
pub const MAX_RETIRED_UPLOAD_GENERATIONS: usize = 1024;
pub const COMPLETED_UPLOAD_TTL: Duration = Duration::from_secs(10 * 60);
pub const MAX_UPLOAD_NAME_BYTES: usize = 255;
pub const MAX_UPLOAD_MIME_BYTES: usize = 128;
pub const MAX_UPLOAD_PATH_BYTES: usize = 4096;

const UPLOAD_PREPARING: u8 = 0;
const UPLOAD_ACTIVE: u8 = 1;
const UPLOAD_CANCELLED: u8 = 2;
const UPLOAD_COMMITTING: u8 = 3;
const UPLOAD_PUBLISHED: u8 = 4;
const UPLOAD_COMPLETE: u8 = 5;

pub const UPLOAD_CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

/// Cap for explorer fs.read / fs.write payloads (raw bytes, pre-base64).
#[cfg(test)]
pub const MAX_FS_BYTES: usize = 32 * 1024 * 1024;

/// Save raw bytes into `dir` under a sanitized `name`. When `overwrite` is
/// false a free `name-N.ext` variant is chosen instead of clobbering.
#[cfg(test)]
pub async fn save_file_in_dir(
    dir: &Path,
    name: &str,
    bytes: &[u8],
    overwrite: bool,
) -> Result<PathBuf> {
    if bytes.len() > MAX_FS_BYTES {
        anyhow::bail!("file exceeds 32 MB");
    }
    fs::create_dir_all(dir)
        .await
        .with_context(|| format!("creating directory {}", dir.display()))?;
    let file_name = sanitized_file_name(name, "", "file", false);
    let path = if overwrite {
        dir.join(&file_name)
    } else {
        available_upload_path(dir, &file_name).await?
    };
    fs::write(&path, bytes)
        .await
        .with_context(|| format!("writing file {}", path.display()))?;
    Ok(path)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UploadDestination {
    Attachments,
    Cwd,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UploadManifest {
    pub name: String,
    pub mime_type: String,
    pub destination: UploadDestination,
    pub total_bytes: usize,
    pub chunks: u32,
    pub sha256: String,
}

impl UploadManifest {
    pub fn validate(&self) -> Result<()> {
        validate_leaf_name(&self.name)?;
        if self.mime_type.is_empty()
            || self.mime_type.len() > MAX_UPLOAD_MIME_BYTES
            || !self
                .mime_type
                .bytes()
                .all(|byte| byte.is_ascii_graphic() && byte != b';')
        {
            anyhow::bail!("invalid upload MIME type");
        }
        if self.destination == UploadDestination::Attachments
            && !(self.mime_type.starts_with("image/") || self.mime_type == "application/json")
        {
            anyhow::bail!("attachment upload type is not allowed");
        }
        if self.total_bytes == 0 || self.total_bytes > MAX_UPLOAD_BYTES {
            anyhow::bail!("upload size is outside protocol limits");
        }
        let expected_chunks = self.total_bytes.div_ceil(UPLOAD_CHUNK_BYTES);
        if self.chunks == 0 || self.chunks as usize != expected_chunks {
            anyhow::bail!("upload chunk count does not match declared length");
        }
        if self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            anyhow::bail!("upload SHA-256 is invalid");
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct UploadResult {
    pub path: String,
    pub total_bytes: usize,
    pub sha256: String,
}

#[derive(Clone, Debug)]
pub enum UploadStartOutcome {
    Ready {
        next_sequence: u32,
        received_bytes: usize,
    },
    Complete(UploadResult),
}

#[derive(Clone, Debug)]
pub enum UploadChunkOutcome {
    Pending,
    Complete(UploadResult),
}

pub struct UploadChunkRequest<'a> {
    pub viewer_id: &'a str,
    pub capability: Uuid,
    pub upload_id: Uuid,
    pub sequence: u32,
    pub last: bool,
    pub bytes: &'a [u8],
}

#[derive(Debug)]
pub struct UploadError {
    pub code: &'static str,
    pub detail: String,
}

impl UploadError {
    fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }

    fn failed(error: impl std::fmt::Display) -> Self {
        Self::new("upload_failed", error.to_string())
    }

    fn cancelled() -> Self {
        Self::new("cancelled", "upload was cancelled before publication")
    }

    fn outcome_unknown(detail: impl std::fmt::Display) -> Self {
        Self::new(
            "outcome_unknown",
            format!(
                "upload may have been published; reconcile the destination before retrying: {detail}"
            ),
        )
    }
}

impl std::fmt::Display for UploadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.detail)
    }
}

impl std::error::Error for UploadError {}

pub type UploadOpResult<T> = std::result::Result<T, UploadError>;

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct UploadKey {
    session_id: Uuid,
    session_generation: u64,
    upload_id: Uuid,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct UploadOwner {
    capability: Uuid,
    viewer_id: String,
}

struct ActiveUpload {
    owner: UploadOwner,
    manifest: UploadManifest,
    root_path: PathBuf,
    directory: Arc<Dir>,
    temp_name: String,
    final_name: String,
    file: Option<std::fs::File>,
    hasher: Sha256,
    next_sequence: u32,
    received_bytes: usize,
}

struct ActiveEntry {
    owner: UploadOwner,
    manifest: UploadManifest,
    upload: StdMutex<Option<ActiveUpload>>,
    lifecycle: AtomicU8,
    cancelled: CancellationToken,
    cleanup_scheduled: AtomicBool,
    removed: AtomicBool,
    changed: Notify,
}

enum UploadAdmission {
    Inserted(Arc<ActiveEntry>),
    Existing(Arc<ActiveEntry>),
    Complete(UploadResult),
}

struct CompletedUpload {
    manifest: UploadManifest,
    result: UploadResult,
    completed_at: StdInstant,
}

#[derive(Default)]
struct UploadState {
    active: HashMap<UploadKey, Arc<ActiveEntry>>,
    completed: HashMap<UploadKey, CompletedUpload>,
    completed_order: VecDeque<UploadKey>,
    retired_generations: HashSet<(Uuid, u64)>,
    retired_generation_order: VecDeque<(Uuid, u64)>,
}

#[derive(Default)]
struct UploadOperations {
    active: AtomicUsize,
    idle: Notify,
}

struct UploadOperationPermit {
    operations: Arc<UploadOperations>,
}

#[derive(Default)]
struct UploadLifecycleHooks {
    #[cfg(test)]
    admit: StdMutex<Option<Arc<AdmissionBarrier>>>,
    #[cfg(test)]
    prepare: BlockingPause,
    #[cfg(test)]
    prepare_count: AtomicUsize,
    #[cfg(test)]
    ready_return: BlockingPause,
    #[cfg(test)]
    write_sync: BlockingPause,
    #[cfg(test)]
    commit: BlockingPause,
    #[cfg(test)]
    cleanup: BlockingPause,
    #[cfg(test)]
    fail_unlink_count: AtomicUsize,
    #[cfg(test)]
    fail_fsync_count: AtomicUsize,
}

impl UploadLifecycleHooks {
    #[cfg(test)]
    fn arm_admit_barrier(&self, participants: usize) {
        assert!(participants > 1);
        *self
            .admit
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some(Arc::new(AdmissionBarrier {
                barrier: Barrier::new(participants),
                remaining: AtomicUsize::new(participants),
            }));
    }

    fn pause_admit(&self) {
        #[cfg(test)]
        {
            let pause = self
                .admit
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            if let Some(pause) = pause {
                pause.barrier.wait();
                if pause.remaining.fetch_sub(1, Ordering::AcqRel) == 1 {
                    let mut armed = self
                        .admit
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    if armed
                        .as_ref()
                        .is_some_and(|current| Arc::ptr_eq(current, &pause))
                    {
                        *armed = None;
                    }
                }
            }
        }
    }

    fn pause_prepare(&self) {
        #[cfg(test)]
        {
            self.prepare_count.fetch_add(1, Ordering::AcqRel);
            self.prepare.pause_if_armed();
        }
    }

    fn pause_ready_return(&self) {
        #[cfg(test)]
        self.ready_return.pause_if_armed();
    }

    fn pause_write_sync(&self) {
        #[cfg(test)]
        self.write_sync.pause_if_armed();
    }

    fn pause_commit(&self) {
        #[cfg(test)]
        self.commit.pause_if_armed();
    }

    fn pause_cleanup(&self) {
        #[cfg(test)]
        self.cleanup.pause_if_armed();
    }

    fn fail_unlink(&self) -> bool {
        #[cfg(test)]
        return self
            .fail_unlink_count
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |remaining| {
                remaining.checked_sub(1)
            })
            .is_ok();
        #[cfg(not(test))]
        false
    }

    fn fail_fsync(&self) -> bool {
        #[cfg(test)]
        return self
            .fail_fsync_count
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |remaining| {
                remaining.checked_sub(1)
            })
            .is_ok();
        #[cfg(not(test))]
        false
    }
}

#[cfg(test)]
struct AdmissionBarrier {
    barrier: Barrier,
    remaining: AtomicUsize,
}

#[cfg(test)]
#[derive(Default)]
struct BlockingPause {
    armed: AtomicBool,
    entered: Notify,
    released: StdMutex<bool>,
    release: Condvar,
}

#[cfg(test)]
impl BlockingPause {
    fn arm(&self) {
        *self.released.lock().expect("upload pause lock") = false;
        self.armed.store(true, Ordering::Release);
    }

    fn pause_if_armed(&self) {
        if !self.armed.swap(false, Ordering::AcqRel) {
            return;
        }
        self.entered.notify_one();
        let mut released = self.released.lock().expect("upload pause lock");
        while !*released {
            released = self.release.wait(released).expect("upload pause wait");
        }
    }

    async fn wait_until_entered(&self) {
        self.entered.notified().await;
    }

    fn release(&self) {
        *self.released.lock().expect("upload pause lock") = true;
        self.release.notify_all();
    }
}

impl UploadOperations {
    fn admit(self: &Arc<Self>) -> UploadOperationPermit {
        self.active.fetch_add(1, Ordering::AcqRel);
        UploadOperationPermit {
            operations: Arc::clone(self),
        }
    }

    #[cfg(test)]
    async fn wait_for_idle_until(&self, deadline: TokioInstant) -> bool {
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

impl Drop for UploadOperationPermit {
    fn drop(&mut self) {
        if self.operations.active.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.operations.idle.notify_waiters();
        }
    }
}

struct UploadHubInner {
    state: StdMutex<UploadState>,
    operations: Arc<UploadOperations>,
    hooks: Arc<UploadLifecycleHooks>,
}

impl Default for UploadHubInner {
    fn default() -> Self {
        Self {
            state: StdMutex::new(UploadState::default()),
            operations: Arc::new(UploadOperations::default()),
            hooks: Arc::new(UploadLifecycleHooks::default()),
        }
    }
}

#[derive(Clone, Default)]
pub struct UploadHub {
    inner: Arc<UploadHubInner>,
}

impl UploadHub {
    #[allow(clippy::too_many_arguments)]
    pub async fn start(
        &self,
        session: SessionBinding,
        viewer_id: &str,
        capability: Uuid,
        upload_id: Uuid,
        cwd: &str,
        manifest: UploadManifest,
    ) -> UploadOpResult<UploadStartOutcome> {
        manifest.validate().map_err(UploadError::failed)?;
        let key = upload_key(session, upload_id);
        let owner = UploadOwner {
            capability,
            viewer_id: viewer_id.to_string(),
        };
        let entry = match self.admit(key.clone(), owner.clone(), manifest.clone())? {
            UploadAdmission::Inserted(entry) => entry,
            UploadAdmission::Complete(result) => {
                return Ok(UploadStartOutcome::Complete(result));
            }
            UploadAdmission::Existing(existing) => {
                if existing.owner != owner || existing.manifest != manifest {
                    return Err(UploadError::failed(
                        "upload id is already active with another manifest or capability",
                    ));
                }
                loop {
                    match existing.lifecycle.load(Ordering::Acquire) {
                        UPLOAD_PREPARING => {
                            let changed = existing.changed.notified();
                            if existing.lifecycle.load(Ordering::Acquire) == UPLOAD_PREPARING {
                                changed.await;
                            }
                        }
                        UPLOAD_ACTIVE => {
                            let upload = existing.upload.try_lock().map_err(|_| {
                                UploadError::failed("upload operation is already in progress")
                            })?;
                            let upload = upload.as_ref().ok_or_else(|| {
                                UploadError::failed("upload preparation is incomplete")
                            })?;
                            return Ok(UploadStartOutcome::Ready {
                                next_sequence: upload.next_sequence,
                                received_bytes: upload.received_bytes,
                            });
                        }
                        UPLOAD_COMMITTING | UPLOAD_PUBLISHED => {
                            return Err(UploadError::outcome_unknown(
                                "the final upload operation has no acknowledged result",
                            ));
                        }
                        _ => return Err(UploadError::cancelled()),
                    }
                }
            }
        };

        let cwd = cwd.to_string();
        let operation_entry = Arc::clone(&entry);
        let hub = self.clone();
        let operation_key = key.clone();
        let permit = self.inner.operations.admit();
        let operation = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            // Holding this mutex across preparation makes cleanup wait for any
            // descriptor/temp created by the blocking closure before it can
            // release the admission charge.
            let mut slot = operation_entry
                .upload
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            hub.inner.hooks.pause_prepare();
            let prepared = prepare_upload(
                &cwd,
                operation_entry.owner.clone(),
                operation_entry.manifest.clone(),
            )
            .map_err(UploadError::failed);
            match prepared {
                Ok(upload) => {
                    *slot = Some(upload);
                    // Make the prepared slot observable before publishing the
                    // ACTIVE lifecycle. A same-owner start may use try_lock as
                    // soon as it observes ACTIVE, so publishing in the reverse
                    // order creates a transient false "operation in progress"
                    // result even though preparation has completed.
                    drop(slot);
                    if operation_entry
                        .lifecycle
                        .compare_exchange(
                            UPLOAD_PREPARING,
                            UPLOAD_ACTIVE,
                            Ordering::AcqRel,
                            Ordering::Acquire,
                        )
                        .is_err()
                    {
                        operation_entry.changed.notify_waiters();
                        hub.schedule_cleanup(operation_key, Arc::clone(&operation_entry));
                        return Err(UploadError::cancelled());
                    }
                    operation_entry.changed.notify_waiters();
                    hub.inner.hooks.pause_ready_return();
                    Ok(UploadStartOutcome::Ready {
                        next_sequence: 0,
                        received_bytes: 0,
                    })
                }
                Err(error) => {
                    operation_entry
                        .lifecycle
                        .store(UPLOAD_CANCELLED, Ordering::Release);
                    drop(slot);
                    hub.release_entry(&operation_key, &operation_entry);
                    operation_entry.changed.notify_waiters();
                    Err(error)
                }
            }
        });
        tokio::select! {
            biased;
            result = operation => match result {
                Ok(result) => result,
                Err(error) => {
                    entry.lifecycle.store(UPLOAD_CANCELLED, Ordering::Release);
                    entry.cancelled.cancel();
                    self.schedule_cleanup(key, Arc::clone(&entry));
                    Err(UploadError::failed(format!("upload preparation task failed: {error}")))
                }
            },
            _ = entry.cancelled.cancelled() => Err(UploadError::cancelled()),
        }
    }

    pub async fn write_chunk(
        &self,
        session: SessionBinding,
        request: UploadChunkRequest<'_>,
    ) -> UploadOpResult<UploadChunkOutcome> {
        let UploadChunkRequest {
            viewer_id,
            capability,
            upload_id,
            sequence,
            last,
            bytes,
        } = request;
        let key = upload_key(session, upload_id);
        let entry = {
            let state = self
                .inner
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.active.get(&key).cloned()
        };
        let Some(entry) = entry else {
            let state = self
                .inner
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(completed) = state.completed.get(&key) {
                return Ok(UploadChunkOutcome::Complete(completed.result.clone()));
            }
            return Err(UploadError::failed("upload is not active"));
        };
        let owner = UploadOwner {
            capability,
            viewer_id: viewer_id.to_string(),
        };
        if entry.owner != owner {
            return Err(UploadError::failed(
                "upload capability does not own the active upload",
            ));
        }
        if entry.lifecycle.load(Ordering::Acquire) != UPLOAD_ACTIVE {
            return match entry.lifecycle.load(Ordering::Acquire) {
                UPLOAD_COMMITTING | UPLOAD_PUBLISHED => Err(UploadError::outcome_unknown(
                    "the final upload operation has no acknowledged result",
                )),
                _ => Err(UploadError::cancelled()),
            };
        }
        let payload = bytes.to_vec();
        let operation_entry = Arc::clone(&entry);
        let operation_key = key.clone();
        let hub = self.clone();
        let permit = self.inner.operations.admit();
        let operation = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let outcome = hub.write_chunk_sync(
                &operation_key,
                &operation_entry,
                &owner,
                sequence,
                last,
                &payload,
            );
            if outcome.is_err()
                && operation_entry.lifecycle.load(Ordering::Acquire) < UPLOAD_COMMITTING
            {
                operation_entry
                    .lifecycle
                    .store(UPLOAD_CANCELLED, Ordering::Release);
                hub.cleanup_entry_sync(&operation_key, &operation_entry);
            }
            operation_entry.changed.notify_waiters();
            outcome
        });
        tokio::select! {
            biased;
            result = operation => match result {
                Ok(result) => result,
                Err(error) => {
                    let lifecycle = entry.lifecycle.load(Ordering::Acquire);
                    if lifecycle < UPLOAD_COMMITTING {
                        entry.lifecycle.store(UPLOAD_CANCELLED, Ordering::Release);
                        entry.cancelled.cancel();
                    }
                    self.schedule_cleanup(key, Arc::clone(&entry));
                    if lifecycle >= UPLOAD_COMMITTING {
                        Err(UploadError::outcome_unknown(format!("upload write task failed: {error}")))
                    } else {
                        Err(UploadError::failed(format!("upload write task failed: {error}")))
                    }
                }
            },
            _ = entry.cancelled.cancelled() => Err(UploadError::cancelled()),
        }
    }

    pub async fn cancel(
        &self,
        session: SessionBinding,
        viewer_id: &str,
        capability: Uuid,
        upload_id: Uuid,
    ) -> UploadOpResult<bool> {
        let key = upload_key(session, upload_id);
        let entry = {
            let state = self
                .inner
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let Some(entry) = state.active.get(&key) else {
                return Ok(false);
            };
            if entry.owner
                != (UploadOwner {
                    capability,
                    viewer_id: viewer_id.to_string(),
                })
            {
                return Err(UploadError::failed(
                    "upload capability does not own the active upload",
                ));
            }
            Arc::clone(entry)
        };
        let cancelled = self.cancel_entry(key.clone(), Arc::clone(&entry));
        if cancelled {
            self.wait_entries_until(
                vec![(key, entry)],
                TokioInstant::now() + upload_close_timeout(),
            )
            .await;
        }
        Ok(cancelled)
    }

    #[cfg(test)]
    async fn cancel_viewer(&self, session: SessionBinding, viewer_id: &str) {
        let deadline = TokioInstant::now() + upload_close_timeout();
        self.cancel_viewer_until(session, viewer_id, deadline).await;
    }

    #[cfg(test)]
    pub async fn cancel_viewer_until(
        &self,
        session: SessionBinding,
        viewer_id: &str,
        deadline: TokioInstant,
    ) {
        let active = self.viewer_entries(session, viewer_id);
        for (key, entry) in &active {
            self.cancel_entry(key.clone(), Arc::clone(entry));
        }
        self.wait_entries_until(active, deadline).await;
    }

    /// Publish cancellation/retry once, then retain the caller until every
    /// matching descriptor/temp and its admission charge have actually
    /// drained. Peer cleanup owns this wait after its externally visible
    /// deadline has expired; a later teardown can safely schedule another
    /// retry for a retained published entry.
    pub async fn cancel_viewer_and_wait(&self, session: SessionBinding, viewer_id: &str) {
        let active = self.viewer_entries(session, viewer_id);
        for (key, entry) in &active {
            self.cancel_entry(key.clone(), Arc::clone(entry));
        }
        for (_, entry) in active {
            loop {
                let changed = entry.changed.notified();
                if entry.removed.load(Ordering::Acquire) {
                    break;
                }
                changed.await;
            }
        }
    }

    pub fn cancel_viewer_now(&self, session: SessionBinding, viewer_id: &str) {
        for (key, entry) in self.viewer_entries(session, viewer_id) {
            self.cancel_entry(key, entry);
        }
    }

    fn viewer_entries(
        &self,
        session: SessionBinding,
        viewer_id: &str,
    ) -> Vec<(UploadKey, Arc<ActiveEntry>)> {
        self.matching_entries(|key, entry| {
            key.session_id == session.session_id()
                && key.session_generation == session.generation()
                && entry.owner.viewer_id == viewer_id
        })
    }

    pub async fn remove_generation_until(&self, session: SessionBinding, deadline: TokioInstant) {
        self.retire_generation(session);
        let active = self.generation_entries(session);
        for (key, entry) in &active {
            self.cancel_entry(key.clone(), Arc::clone(entry));
        }
        self.wait_entries_until(active, deadline).await;
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.completed.retain(|key, _| {
            key.session_id != session.session_id() || key.session_generation != session.generation()
        });
        state.completed_order.retain(|key| {
            key.session_id != session.session_id() || key.session_generation != session.generation()
        });
    }

    pub fn remove_generation_now(&self, session: SessionBinding) {
        self.retire_generation(session);
        for (key, entry) in self.generation_entries(session) {
            self.cancel_entry(key, entry);
        }
    }

    fn generation_entries(&self, session: SessionBinding) -> Vec<(UploadKey, Arc<ActiveEntry>)> {
        self.matching_entries(|key, _| {
            key.session_id == session.session_id() && key.session_generation == session.generation()
        })
    }

    fn retire_generation(&self, session: SessionBinding) {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let retired = (session.session_id(), session.generation());
        if state.retired_generations.insert(retired) {
            state.retired_generation_order.push_back(retired);
        }
        while state.retired_generation_order.len() > MAX_RETIRED_UPLOAD_GENERATIONS {
            if let Some(expired) = state.retired_generation_order.pop_front() {
                state.retired_generations.remove(&expired);
            }
        }
    }

    #[cfg(test)]
    pub(crate) async fn retained_counts(&self) -> (usize, usize) {
        let state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (state.active.len(), state.completed.len())
    }

    #[cfg(test)]
    fn lifecycle_hooks(&self) -> Arc<UploadLifecycleHooks> {
        Arc::clone(&self.inner.hooks)
    }

    #[cfg(test)]
    pub(crate) fn arm_commit_pause_for_test(&self) {
        self.inner.hooks.commit.arm();
    }

    #[cfg(test)]
    pub(crate) async fn wait_commit_pause_for_test(&self) {
        self.inner.hooks.commit.wait_until_entered().await;
    }

    #[cfg(test)]
    pub(crate) fn release_commit_pause_for_test(&self) {
        self.inner.hooks.commit.release();
    }

    #[cfg(test)]
    pub(crate) fn arm_cleanup_pause_for_test(&self) {
        self.inner.hooks.cleanup.arm();
    }

    #[cfg(test)]
    pub(crate) async fn wait_cleanup_pause_for_test(&self) {
        self.inner.hooks.cleanup.wait_until_entered().await;
    }

    #[cfg(test)]
    pub(crate) fn release_cleanup_pause_for_test(&self) {
        self.inner.hooks.cleanup.release();
    }

    #[cfg(test)]
    pub(crate) fn operation_count(&self) -> usize {
        self.inner.operations.active.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub(crate) async fn wait_for_operations(&self, deadline: TokioInstant) -> bool {
        self.inner.operations.wait_for_idle_until(deadline).await
    }

    #[cfg(test)]
    fn age_completed(&self, age: Duration) {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for completed in state.completed.values_mut() {
            completed.completed_at = completed
                .completed_at
                .checked_sub(age)
                .expect("test completion age is representable");
        }
    }

    fn admit(
        &self,
        key: UploadKey,
        owner: UploadOwner,
        manifest: UploadManifest,
    ) -> UploadOpResult<UploadAdmission> {
        self.inner.hooks.pause_admit();
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        prune_completed(&mut state);
        if state
            .retired_generations
            .contains(&(key.session_id, key.session_generation))
        {
            return Err(UploadError::new(
                "stale_agent_generation",
                "the upload belongs to a replaced session backend",
            ));
        }
        if let Some(completed) = state.completed.get(&key) {
            if completed.manifest != manifest {
                return Err(UploadError::failed(
                    "upload id was reused with a conflicting manifest",
                ));
            }
            return Ok(UploadAdmission::Complete(completed.result.clone()));
        }
        if let Some(entry) = state.active.get(&key) {
            return Ok(UploadAdmission::Existing(Arc::clone(entry)));
        }
        let viewer_active = state
            .active
            .values()
            .filter(|entry| entry.owner.viewer_id == owner.viewer_id)
            .count();
        if viewer_active >= MAX_ACTIVE_UPLOADS_PER_VIEWER
            || state.active.len() >= MAX_ACTIVE_UPLOADS_TOTAL
        {
            return Err(UploadError::failed("too many active uploads"));
        }
        let entry = Arc::new(ActiveEntry {
            owner,
            manifest,
            upload: StdMutex::new(None),
            lifecycle: AtomicU8::new(UPLOAD_PREPARING),
            cancelled: CancellationToken::new(),
            cleanup_scheduled: AtomicBool::new(false),
            removed: AtomicBool::new(false),
            changed: Notify::new(),
        });
        state.active.insert(key, Arc::clone(&entry));
        Ok(UploadAdmission::Inserted(entry))
    }

    fn matching_entries(
        &self,
        predicate: impl Fn(&UploadKey, &ActiveEntry) -> bool,
    ) -> Vec<(UploadKey, Arc<ActiveEntry>)> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .active
            .iter()
            .filter(|(key, entry)| predicate(key, entry))
            .map(|(key, entry)| (key.clone(), Arc::clone(entry)))
            .collect()
    }

    fn cancel_entry(&self, key: UploadKey, entry: Arc<ActiveEntry>) -> bool {
        loop {
            let lifecycle = entry.lifecycle.load(Ordering::Acquire);
            if lifecycle == UPLOAD_PUBLISHED {
                // Publication is irreversible, but unlink/fsync of the private
                // temporary name may still be pending. Every later teardown
                // is a retry opportunity; keeping the entry resident retains
                // its admission charge until cleanup actually succeeds.
                self.schedule_cleanup(key, entry);
                return false;
            }
            if !matches!(lifecycle, UPLOAD_PREPARING | UPLOAD_ACTIVE) {
                return false;
            }
            if entry
                .lifecycle
                .compare_exchange(
                    lifecycle,
                    UPLOAD_CANCELLED,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .is_ok()
            {
                entry.cancelled.cancel();
                entry.changed.notify_waiters();
                self.schedule_cleanup(key, entry);
                return true;
            }
        }
    }

    fn schedule_cleanup(&self, key: UploadKey, entry: Arc<ActiveEntry>) {
        if entry.cleanup_scheduled.swap(true, Ordering::AcqRel) {
            return;
        }
        let hub = self.clone();
        let permit = self.inner.operations.admit();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            hub.finish_claimed_cleanup(&key, &entry);
            entry.changed.notify_waiters();
        });
    }

    fn cleanup_entry_sync(&self, key: &UploadKey, entry: &Arc<ActiveEntry>) {
        if entry
            .cleanup_scheduled
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            self.finish_claimed_cleanup(key, entry);
        }
    }

    fn finish_claimed_cleanup(&self, key: &UploadKey, entry: &Arc<ActiveEntry>) {
        let cleanup = {
            let mut slot = entry
                .upload
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match slot.as_mut() {
                Some(upload) => cleanup_active_sync(upload, &self.inner.hooks),
                None => Ok(()),
            }
        };
        if cleanup.is_ok() {
            self.release_entry(key, entry);
        } else {
            // Keep both the admission charge and cleanup capability. A later
            // session/generation teardown can retry it safely.
            entry.cleanup_scheduled.store(false, Ordering::Release);
        }
    }

    fn release_entry(&self, key: &UploadKey, entry: &Arc<ActiveEntry>) {
        // A retired entry must not own descriptors: the releasing operation's
        // permit signals idle before the entry's last Arc drops, so anything
        // still in the slot (the directory fd) would outlive the drain the
        // permit vouches for. Taken before the state lock — record_published
        // establishes the upload→state lock order and this must not invert it.
        drop(
            entry
                .upload
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take(),
        );
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state
            .active
            .get(key)
            .is_some_and(|current| Arc::ptr_eq(current, entry))
        {
            state.active.remove(key);
            entry.removed.store(true, Ordering::Release);
            entry.changed.notify_waiters();
        }
    }

    async fn wait_entries_until(
        &self,
        entries: Vec<(UploadKey, Arc<ActiveEntry>)>,
        deadline: TokioInstant,
    ) {
        for (_, entry) in entries {
            loop {
                let changed = entry.changed.notified();
                if entry.removed.load(Ordering::Acquire) {
                    break;
                }
                if tokio::time::timeout_at(deadline, changed).await.is_err() {
                    return;
                }
            }
        }
    }

    fn record_published(&self, key: &UploadKey, entry: &Arc<ActiveEntry>, result: UploadResult) {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state
            .retired_generations
            .contains(&(key.session_id, key.session_generation))
        {
            return;
        }
        prune_completed(&mut state);
        state.completed.insert(
            key.clone(),
            CompletedUpload {
                manifest: entry.manifest.clone(),
                result,
                completed_at: StdInstant::now(),
            },
        );
        state.completed_order.push_back(key.clone());
        prune_completed(&mut state);
    }

    fn write_chunk_sync(
        &self,
        key: &UploadKey,
        entry: &Arc<ActiveEntry>,
        owner: &UploadOwner,
        sequence: u32,
        last: bool,
        bytes: &[u8],
    ) -> UploadOpResult<UploadChunkOutcome> {
        let mut slot = entry
            .upload
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if entry.lifecycle.load(Ordering::Acquire) != UPLOAD_ACTIVE {
            return Err(UploadError::cancelled());
        }
        let active = slot
            .as_mut()
            .ok_or_else(|| UploadError::failed("upload preparation is incomplete"))?;
        validate_chunk(active, owner, sequence, last, bytes).map_err(UploadError::failed)?;
        active
            .file
            .as_mut()
            .context("upload temporary file is closed")
            .and_then(|file| file.write_all(bytes).context("writing upload chunk"))
            .map_err(UploadError::failed)?;
        active.hasher.update(bytes);
        active.received_bytes += bytes.len();
        active.next_sequence += 1;
        if !last {
            return Ok(UploadChunkOutcome::Pending);
        }
        let actual_hash = final_hash(active).map_err(UploadError::failed)?;
        self.inner.hooks.pause_write_sync();
        let file = active
            .file
            .as_mut()
            .ok_or_else(|| UploadError::failed("upload temporary file is closed"))?;
        file.flush().map_err(UploadError::failed)?;
        file.sync_all().map_err(UploadError::failed)?;
        drop(active.file.take());
        entry
            .lifecycle
            .compare_exchange(
                UPLOAD_ACTIVE,
                UPLOAD_COMMITTING,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .map_err(|_| UploadError::cancelled())?;
        self.inner.hooks.pause_commit();
        let committed_name =
            link_no_clobber(&active.directory, &active.temp_name, &active.final_name)
                .map_err(UploadError::failed)?;
        entry.lifecycle.store(UPLOAD_PUBLISHED, Ordering::Release);
        let result = upload_result(active, &committed_name, actual_hash);
        // Publication is durable protocol state even if the acknowledgement or
        // removal/fsync cleanup is lost. Record it before any fallible
        // post-effect step so a retry with the stable id reconciles instead of
        // publishing a duplicate.
        self.record_published(key, entry, result.clone());
        let cleanup = cleanup_active_sync(active, &self.inner.hooks);
        drop(slot);
        match cleanup {
            Ok(()) => {
                entry.lifecycle.store(UPLOAD_COMPLETE, Ordering::Release);
                self.release_entry(key, entry);
                Ok(UploadChunkOutcome::Complete(result))
            }
            Err(error) => {
                self.schedule_cleanup(key.clone(), Arc::clone(entry));
                Err(UploadError::outcome_unknown(error))
            }
        }
    }
}

fn upload_key(session: SessionBinding, upload_id: Uuid) -> UploadKey {
    UploadKey {
        session_id: session.session_id(),
        session_generation: session.generation(),
        upload_id,
    }
}

fn prune_completed(state: &mut UploadState) {
    let now = StdInstant::now();
    state
        .completed
        .retain(|_, upload| now.duration_since(upload.completed_at) <= COMPLETED_UPLOAD_TTL);
    state
        .completed_order
        .retain(|key| state.completed.contains_key(key));
    while state.completed_order.len() > MAX_COMPLETED_UPLOADS {
        if let Some(key) = state.completed_order.pop_front() {
            state.completed.remove(&key);
        }
    }
}

fn prepare_upload(cwd: &str, owner: UploadOwner, manifest: UploadManifest) -> Result<ActiveUpload> {
    let (root_path, root) = open_capability_root(cwd)?;
    let final_name = match manifest.destination {
        UploadDestination::Cwd => manifest.name.clone(),
        UploadDestination::Attachments => unique_file_name(&manifest.name, &manifest.mime_type),
    };
    validate_leaf_name(&final_name)?;
    let relative = match manifest.destination {
        UploadDestination::Cwd => PathBuf::from(&final_name),
        UploadDestination::Attachments => PathBuf::from(".spawn")
            .join("attachments")
            .join(&final_name),
    };
    let result_path = root_path.join(relative);
    if result_path.to_str().is_none_or(|path| {
        // Leave room for the no-clobber suffix selected at commit time.
        path.len().saturating_add(8) > MAX_UPLOAD_PATH_BYTES
    }) {
        anyhow::bail!("upload result path is outside protocol limits");
    }
    let directory = match manifest.destination {
        UploadDestination::Cwd => Arc::new(root),
        UploadDestination::Attachments => {
            let spawn = open_or_create_private_dir(&root, ".spawn")?;
            Arc::new(open_or_create_private_dir(&spawn, "attachments")?)
        }
    };
    let temp_name = format!(".spawn-upload-{}.part", Uuid::new_v4().simple());
    let file = crate::platform::create_private_file_new_at(&directory, Path::new(&temp_name))
        .context("creating private upload temporary file")?;
    Ok(ActiveUpload {
        owner,
        manifest,
        root_path,
        directory,
        temp_name,
        final_name,
        file: Some(file),
        hasher: Sha256::new(),
        next_sequence: 0,
        received_bytes: 0,
    })
}

fn validate_chunk(
    active: &ActiveUpload,
    owner: &UploadOwner,
    sequence: u32,
    last: bool,
    bytes: &[u8],
) -> Result<()> {
    if &active.owner != owner {
        anyhow::bail!("upload capability does not own the active upload");
    }
    if sequence != active.next_sequence {
        anyhow::bail!("upload chunk is duplicate or out of order");
    }
    let final_sequence = active.manifest.chunks - 1;
    let expected_len = if sequence == final_sequence {
        active.manifest.total_bytes - UPLOAD_CHUNK_BYTES * final_sequence as usize
    } else {
        UPLOAD_CHUNK_BYTES
    };
    if bytes.len() != expected_len || last != (sequence == final_sequence) {
        anyhow::bail!("upload chunk length or final flag is invalid");
    }
    if active.received_bytes + bytes.len() > active.manifest.total_bytes {
        anyhow::bail!("upload exceeds declared length");
    }
    Ok(())
}

fn final_hash(active: &ActiveUpload) -> Result<String> {
    if active.received_bytes != active.manifest.total_bytes
        || active.next_sequence != active.manifest.chunks
    {
        anyhow::bail!("upload ended before its declared length");
    }
    let digest = active.hasher.clone().finalize();
    let actual_hash = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if actual_hash != active.manifest.sha256 {
        anyhow::bail!("upload checksum mismatch");
    }
    Ok(actual_hash)
}

fn upload_result(active: &ActiveUpload, committed_name: &str, actual_hash: String) -> UploadResult {
    let relative = match active.manifest.destination {
        UploadDestination::Cwd => PathBuf::from(committed_name),
        UploadDestination::Attachments => PathBuf::from(".spawn")
            .join("attachments")
            .join(committed_name),
    };
    let path = active.root_path.join(relative);
    let path = path
        .to_str()
        .expect("upload result path was validated before file creation")
        .to_string();
    debug_assert!(path.len() <= MAX_UPLOAD_PATH_BYTES);
    UploadResult {
        path,
        total_bytes: active.manifest.total_bytes,
        sha256: actual_hash,
    }
}

fn cleanup_active_sync(active: &mut ActiveUpload, hooks: &UploadLifecycleHooks) -> Result<()> {
    active.file.take();
    hooks.pause_cleanup();
    if hooks.fail_unlink() {
        anyhow::bail!("injected upload temporary unlink failure");
    }
    match active.directory.remove_file(&active.temp_name) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("removing upload temporary file"),
    }
    if hooks.fail_fsync() {
        anyhow::bail!("injected upload directory fsync failure");
    }
    crate::platform::fsync_dir(&active.directory).context("syncing upload directory cleanup")?;
    Ok(())
}

fn link_no_clobber(directory: &Dir, temp_name: &str, desired_name: &str) -> Result<String> {
    let file_path = Path::new(desired_name);
    let stem = file_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .unwrap_or("file");
    let extension = file_path
        .extension()
        .and_then(|extension| extension.to_str());
    for index in 1..10_000 {
        let candidate = if index == 1 {
            desired_name.to_string()
        } else {
            match extension {
                Some(extension) if !extension.is_empty() => {
                    format!("{stem}-{index}.{extension}")
                }
                _ => format!("{stem}-{index}"),
            }
        };
        validate_leaf_name(&candidate)?;
        match crate::platform::hard_link_noreplace_at(
            directory,
            Path::new(temp_name),
            directory,
            Path::new(&candidate),
        ) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error).context("committing upload without clobber"),
        }
    }
    anyhow::bail!("could not choose a free upload filename")
}

fn upload_close_timeout() -> Duration {
    if cfg!(test) {
        Duration::from_millis(100)
    } else {
        UPLOAD_CLOSE_TIMEOUT
    }
}

fn open_capability_root(cwd: &str) -> Result<(PathBuf, Dir)> {
    if cwd.is_empty() || cwd.len() > MAX_UPLOAD_PATH_BYTES {
        anyhow::bail!("session cwd is outside upload path limits");
    }
    let path = Path::new(cwd);
    if !path.is_absolute() {
        anyhow::bail!("session cwd is not an absolute capability root");
    }
    #[cfg(unix)]
    let (mut normalized, mut current) = (
        PathBuf::from("/"),
        CapDir::open_ambient_dir(Path::new("/"), ambient_authority())?,
    );
    #[cfg(windows)]
    let (mut normalized, mut current) = {
        use std::path::Prefix;
        let mut components = path.components();
        let Component::Prefix(prefix) = components
            .next()
            .context("Windows upload root has no drive prefix")?
        else {
            anyhow::bail!("Windows upload root has no drive prefix");
        };
        match prefix.kind() {
            Prefix::Disk(_) | Prefix::VerbatimDisk(_) => {}
            _ => anyhow::bail!("UNC and device upload roots are unavailable in this release"),
        }
        if !matches!(components.next(), Some(Component::RootDir)) {
            anyhow::bail!("Windows upload root is not drive-absolute");
        }
        let mut root = PathBuf::new();
        root.push(prefix.as_os_str());
        root.push("\\");
        let current = CapDir::open_ambient_dir(&root, ambient_authority())?;
        (root, current)
    };
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => continue,
            Component::Normal(name) if !name.is_empty() => {
                current = current
                    .open_dir_nofollow(name)
                    .context("opening session cwd capability component")?;
                normalized.push(name);
            }
            _ => anyhow::bail!("session cwd contains an ambiguous component"),
        }
    }
    Ok((normalized, current))
}

fn open_or_create_private_dir(parent: &Dir, name: &str) -> Result<Dir> {
    validate_leaf_name(name)?;
    crate::platform::open_or_create_private_dir_at(parent, Path::new(name))
        .context("opening private upload directory without following links")
}

fn validate_leaf_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > MAX_UPLOAD_NAME_BYTES
        || name.as_bytes().contains(&0)
        || name.contains('\\')
        || name.chars().any(char::is_control)
        || Path::new(name).is_absolute()
        || !matches!(
            Path::new(name).components().collect::<Vec<_>>().as_slice(),
            [Component::Normal(_)]
        )
        || matches!(name, "." | "..")
    {
        anyhow::bail!("upload name is not one unambiguous relative component");
    }
    #[cfg(windows)]
    {
        let base = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
        let reserved = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || base
                .strip_prefix("COM")
                .or_else(|| base.strip_prefix("LPT"))
                .is_some_and(|suffix| {
                    suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9')
                });
        if name.ends_with(['.', ' '])
            || name
                .chars()
                .any(|ch| matches!(ch, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
            || reserved
        {
            anyhow::bail!("upload name is not a valid Windows file name");
        }
    }
    Ok(())
}

fn unique_file_name(name: &str, mime_type: &str) -> String {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let unique = Uuid::new_v4().simple().to_string();
    format!(
        "{stamp}-{}-{}",
        &unique[..8],
        sanitized_file_name(name, mime_type, "image", true)
    )
}

fn sanitized_file_name(
    name: &str,
    mime_type: &str,
    default_name: &str,
    add_image_extension: bool,
) -> String {
    let base = Path::new(name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(default_name);
    let mut safe = String::with_capacity(base.len());
    for ch in base.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
            safe.push(ch);
        } else {
            safe.push('_');
        }
        if safe.len() >= 96 {
            break;
        }
    }

    let safe = safe.trim_matches(['.', '_', '-']).to_string();
    let mut safe = if safe.is_empty() {
        default_name.to_string()
    } else {
        safe
    };
    if add_image_extension && Path::new(&safe).extension().is_none() {
        safe.push('.');
        safe.push_str(extension_for_mime(mime_type));
    }
    safe
}

#[cfg(test)]
async fn available_upload_path(dir: &Path, file_name: &str) -> Result<PathBuf> {
    let path = dir.join(file_name);
    if !fs::try_exists(&path)
        .await
        .with_context(|| format!("checking upload path {}", path.display()))?
    {
        return Ok(path);
    }

    let file_path = Path::new(file_name);
    let stem = file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("file");
    let extension = file_path.extension().and_then(|s| s.to_str());
    for n in 2..10_000 {
        let candidate_name = match extension {
            Some(ext) if !ext.is_empty() => format!("{stem}-{n}.{ext}"),
            _ => format!("{stem}-{n}"),
        };
        let candidate = dir.join(candidate_name);
        if !fs::try_exists(&candidate)
            .await
            .with_context(|| format!("checking upload path {}", candidate.display()))?
        {
            return Ok(candidate);
        }
    }

    anyhow::bail!("could not choose a free upload filename for {}", file_name)
}

fn extension_for_mime(mime_type: &str) -> &'static str {
    match mime_type {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/heic" => "heic",
        "image/heif" => "heif",
        "image/bmp" => "bmp",
        "image/tiff" => "tiff",
        "image/svg+xml" => "svg",
        _ => "png",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(bytes: &[u8], name: &str, destination: UploadDestination) -> UploadManifest {
        let sha256 = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        UploadManifest {
            name: name.to_string(),
            mime_type: if destination == UploadDestination::Attachments {
                "image/png".to_string()
            } else {
                "application/octet-stream".to_string()
            },
            destination,
            total_bytes: bytes.len(),
            chunks: bytes.len().div_ceil(UPLOAD_CHUNK_BYTES) as u32,
            sha256,
        }
    }

    struct CompleteUpload<'a> {
        session: SessionBinding,
        viewer: &'a str,
        capability: Uuid,
        upload_id: Uuid,
        cwd: &'a str,
        bytes: &'a [u8],
        manifest: UploadManifest,
    }

    async fn complete(hub: &UploadHub, spec: CompleteUpload<'_>) -> UploadResult {
        let CompleteUpload {
            session,
            viewer,
            capability,
            upload_id,
            cwd,
            bytes,
            manifest: upload_manifest,
        } = spec;
        assert!(matches!(
            hub.start(
                session,
                viewer,
                capability,
                upload_id,
                cwd,
                upload_manifest.clone(),
            )
            .await
            .unwrap(),
            UploadStartOutcome::Ready {
                next_sequence: 0,
                received_bytes: 0
            }
        ));
        let mut result = None;
        for (sequence, chunk) in bytes.chunks(UPLOAD_CHUNK_BYTES).enumerate() {
            let outcome = hub
                .write_chunk(
                    session,
                    UploadChunkRequest {
                        viewer_id: viewer,
                        capability,
                        upload_id,
                        sequence: sequence as u32,
                        last: sequence + 1 == upload_manifest.chunks as usize,
                        bytes: chunk,
                    },
                )
                .await
                .unwrap();
            if let UploadChunkOutcome::Complete(completed) = outcome {
                result = Some(completed);
            }
        }
        result.unwrap()
    }

    #[tokio::test]
    async fn save_file_in_dir_respects_overwrite_flag() {
        let dir = std::env::temp_dir().join(format!("spawn-fs-test-{}", Uuid::new_v4().simple()));

        let first = save_file_in_dir(&dir, "../notes 1.txt", b"one", false)
            .await
            .unwrap();
        assert_eq!(first, dir.join("notes_1.txt"));

        let second = save_file_in_dir(&dir, "notes 1.txt", b"two", false)
            .await
            .unwrap();
        assert_eq!(second, dir.join("notes_1-2.txt"));

        let third = save_file_in_dir(&dir, "notes 1.txt", b"three", true)
            .await
            .unwrap();
        assert_eq!(third, first);
        assert_eq!(fs::read(&first).await.unwrap(), b"three");

        fs::remove_dir_all(&dir).await.unwrap();
    }

    #[test]
    fn sanitizes_upload_names() {
        let name = sanitized_file_name("../Screen Shot 1.png", "image/png", "image", true);
        assert_eq!(name, "Screen_Shot_1.png");

        let name = sanitized_file_name("", "image/jpeg", "image", true);
        assert_eq!(name, "image.jpg");

        let name = sanitized_file_name("../notes 1.txt", "text/plain", "file", false);
        assert_eq!(name, "notes_1.txt");
    }

    #[tokio::test]
    async fn chunked_upload_is_hash_checked_idempotent_and_private() {
        let tmp = tempfile::tempdir().unwrap();
        let bytes = vec![7; UPLOAD_CHUNK_BYTES + 5];
        let upload_manifest = manifest(&bytes, "shot.png", UploadDestination::Attachments);
        let hub = UploadHub::default();
        let session = SessionBinding::new(Uuid::new_v4(), 7);
        let capability = Uuid::new_v4();
        let upload_id = Uuid::new_v4();
        let result = complete(
            &hub,
            CompleteUpload {
                session,
                viewer: "viewer",
                capability,
                upload_id,
                cwd: tmp.path().to_str().unwrap(),
                bytes: &bytes,
                manifest: upload_manifest.clone(),
            },
        )
        .await;
        assert_eq!(std::fs::read(&result.path).unwrap(), bytes);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&result.path).unwrap().permissions();
            assert_eq!(mode.mode() & 0o777, 0o600);
        }
        #[cfg(windows)]
        crate::platform::open_private_file(Path::new(&result.path), false)
            .expect("uploaded file has a protected owner-only DACL");
        assert!(matches!(
            hub.start(
                session,
                "replacement-viewer",
                Uuid::new_v4(),
                upload_id,
                tmp.path().to_str().unwrap(),
                upload_manifest,
            )
            .await
            .unwrap(),
            UploadStartOutcome::Complete(_)
        ));
        assert_eq!(hub.retained_counts().await, (0, 1));
    }

    #[tokio::test]
    async fn partial_upload_resumes_exactly_and_conflicting_owner_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let bytes = vec![3; UPLOAD_CHUNK_BYTES + 7];
        let upload_manifest = manifest(&bytes, "resume.bin", UploadDestination::Cwd);
        let hub = UploadHub::default();
        let session = SessionBinding::new(Uuid::new_v4(), 8);
        let capability = Uuid::new_v4();
        let upload_id = Uuid::new_v4();
        hub.start(
            session,
            "viewer",
            capability,
            upload_id,
            tmp.path().to_str().unwrap(),
            upload_manifest.clone(),
        )
        .await
        .unwrap();
        assert!(matches!(
            hub.write_chunk(
                session,
                UploadChunkRequest {
                    viewer_id: "viewer",
                    capability,
                    upload_id,
                    sequence: 0,
                    last: false,
                    bytes: &bytes[..UPLOAD_CHUNK_BYTES],
                },
            )
            .await
            .unwrap(),
            UploadChunkOutcome::Pending
        ));
        assert!(matches!(
            hub.start(
                session,
                "viewer",
                capability,
                upload_id,
                tmp.path().to_str().unwrap(),
                upload_manifest.clone(),
            )
            .await
            .unwrap(),
            UploadStartOutcome::Ready {
                next_sequence: 1,
                received_bytes: UPLOAD_CHUNK_BYTES,
            }
        ));
        assert!(hub
            .start(
                session,
                "other-viewer",
                Uuid::new_v4(),
                upload_id,
                tmp.path().to_str().unwrap(),
                upload_manifest,
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("capability"));
        hub.cancel(session, "viewer", capability, upload_id)
            .await
            .unwrap();
        assert_eq!(hub.retained_counts().await, (0, 0));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_same_owner_start_prepares_once_and_resumes_the_inserted_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let hub = UploadHub::default();
        let hooks = hub.lifecycle_hooks();
        hooks.arm_admit_barrier(2);
        hooks.prepare.arm();
        hooks.ready_return.arm();
        let session = SessionBinding::new(Uuid::new_v4(), 81);
        let capability = Uuid::new_v4();
        let upload_id = Uuid::new_v4();
        let cwd = tmp.path().to_string_lossy().into_owned();
        let upload_manifest = manifest(b"same", "same.bin", UploadDestination::Cwd);

        let first_hub = hub.clone();
        let first_cwd = cwd.clone();
        let first_manifest = upload_manifest.clone();
        let first = tokio::spawn(async move {
            first_hub
                .start(
                    session,
                    "viewer",
                    capability,
                    upload_id,
                    &first_cwd,
                    first_manifest,
                )
                .await
        });
        let second_hub = hub.clone();
        let second_manifest = upload_manifest.clone();
        let second = tokio::spawn(async move {
            second_hub
                .start(
                    session,
                    "viewer",
                    capability,
                    upload_id,
                    &cwd,
                    second_manifest,
                )
                .await
        });
        hooks.prepare.wait_until_entered().await;
        tokio::task::yield_now().await;
        assert!(!second.is_finished());
        assert_eq!(hooks.prepare_count.load(Ordering::Acquire), 1);
        assert_eq!(hub.retained_counts().await.0, 1);

        hooks.prepare.release();
        hooks.ready_return.wait_until_entered().await;
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if first.is_finished() || second.is_finished() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("same-owner retry observes the prepared slot while the inserter is paused");
        assert_ne!(first.is_finished(), second.is_finished());
        hooks.ready_return.release();
        let (first, second) = tokio::join!(first, second);
        for outcome in [first.unwrap().unwrap(), second.unwrap().unwrap()] {
            assert!(matches!(
                outcome,
                UploadStartOutcome::Ready {
                    next_sequence: 0,
                    received_bytes: 0
                }
            ));
        }
        assert_eq!(hooks.prepare_count.load(Ordering::Acquire), 1);
        let private_temps = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(std::result::Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains("spawn-upload"))
            .count();
        assert_eq!(private_temps, 1);

        assert!(hub
            .cancel(session, "viewer", capability, upload_id)
            .await
            .unwrap());
        wait_for_upload_drain(&hub).await;
        assert_eq!(hub.retained_counts().await, (0, 0));
        assert!(std::fs::read_dir(tmp.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("spawn-upload")));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn repeated_same_owner_start_never_exposes_active_before_the_prepared_slot() {
        let tmp = tempfile::tempdir().unwrap();
        let hub = UploadHub::default();
        let session = SessionBinding::new(Uuid::new_v4(), 83);
        let capability = Uuid::new_v4();
        let cwd = tmp.path().to_string_lossy().into_owned();

        for iteration in 0..512 {
            let upload_id = Uuid::new_v4();
            let upload_manifest = manifest(
                b"stress",
                &format!("stress-{iteration}.bin"),
                UploadDestination::Cwd,
            );
            let first_hub = hub.clone();
            let first_cwd = cwd.clone();
            let first_manifest = upload_manifest.clone();
            let first = tokio::spawn(async move {
                first_hub
                    .start(
                        session,
                        "viewer",
                        capability,
                        upload_id,
                        &first_cwd,
                        first_manifest,
                    )
                    .await
            });
            let second_hub = hub.clone();
            let second_cwd = cwd.clone();
            let second_manifest = upload_manifest;
            let second = tokio::spawn(async move {
                second_hub
                    .start(
                        session,
                        "viewer",
                        capability,
                        upload_id,
                        &second_cwd,
                        second_manifest,
                    )
                    .await
            });
            let (first, second) = tokio::join!(first, second);
            for outcome in [first.unwrap().unwrap(), second.unwrap().unwrap()] {
                assert!(matches!(
                    outcome,
                    UploadStartOutcome::Ready {
                        next_sequence: 0,
                        received_bytes: 0
                    }
                ));
            }
            assert!(hub
                .cancel(session, "viewer", capability, upload_id)
                .await
                .unwrap());
        }

        wait_for_upload_drain(&hub).await;
        assert_eq!(hub.retained_counts().await, (0, 0));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_different_owner_start_conflicts_without_replacing_the_inserted_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let hub = UploadHub::default();
        let hooks = hub.lifecycle_hooks();
        hooks.arm_admit_barrier(2);
        hooks.prepare.arm();
        let session = SessionBinding::new(Uuid::new_v4(), 82);
        let capability = Uuid::new_v4();
        let other_capability = Uuid::new_v4();
        let upload_id = Uuid::new_v4();
        let cwd = tmp.path().to_string_lossy().into_owned();
        let upload_manifest = manifest(b"owner", "owner.bin", UploadDestination::Cwd);

        let first_hub = hub.clone();
        let first_cwd = cwd.clone();
        let first_manifest = upload_manifest.clone();
        let first = tokio::spawn(async move {
            first_hub
                .start(
                    session,
                    "viewer-a",
                    capability,
                    upload_id,
                    &first_cwd,
                    first_manifest,
                )
                .await
        });
        let second_hub = hub.clone();
        let second_cwd = cwd.clone();
        let second_manifest = upload_manifest.clone();
        let second = tokio::spawn(async move {
            second_hub
                .start(
                    session,
                    "viewer-b",
                    other_capability,
                    upload_id,
                    &second_cwd,
                    second_manifest,
                )
                .await
        });
        hooks.prepare.wait_until_entered().await;
        for _ in 0..100 {
            if first.is_finished() || second.is_finished() {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_ne!(first.is_finished(), second.is_finished());
        assert_eq!(hooks.prepare_count.load(Ordering::Acquire), 1);
        assert_eq!(hub.retained_counts().await.0, 1);

        hooks.prepare.release();
        let (first, second) = tokio::join!(first, second);
        let first = first.unwrap();
        let second = second.unwrap();
        let is_ready = |result: &UploadOpResult<UploadStartOutcome>| {
            matches!(
                result,
                Ok(UploadStartOutcome::Ready {
                    next_sequence: 0,
                    received_bytes: 0
                })
            )
        };
        assert_ne!(is_ready(&first), is_ready(&second));
        let conflict = if is_ready(&first) {
            second.as_ref().unwrap_err()
        } else {
            first.as_ref().unwrap_err()
        };
        assert!(conflict.detail.contains("another manifest or capability"));
        let (winner_session, winner_capability) = if is_ready(&first) {
            ("viewer-a", capability)
        } else {
            ("viewer-b", other_capability)
        };
        assert!(matches!(
            hub.start(
                session,
                winner_session,
                winner_capability,
                upload_id,
                &cwd,
                upload_manifest,
            )
            .await
            .unwrap(),
            UploadStartOutcome::Ready {
                next_sequence: 0,
                received_bytes: 0
            }
        ));
        assert_eq!(hooks.prepare_count.load(Ordering::Acquire), 1);
        let private_temps = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(std::result::Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains("spawn-upload"))
            .count();
        assert_eq!(private_temps, 1);

        assert!(hub
            .cancel(session, winner_session, winner_capability, upload_id)
            .await
            .unwrap());
        wait_for_upload_drain(&hub).await;
        assert_eq!(hub.retained_counts().await, (0, 0));
        assert!(std::fs::read_dir(tmp.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("spawn-upload")));
    }

    #[tokio::test]
    async fn global_admission_cap_stays_charged_until_all_cleanup_drains() {
        let tmp = tempfile::tempdir().unwrap();
        let hub = UploadHub::default();
        let session = SessionBinding::new(Uuid::new_v4(), 9);
        for index in 0..MAX_ACTIVE_UPLOADS_TOTAL {
            hub.start(
                session,
                &format!("viewer-{}", index / MAX_ACTIVE_UPLOADS_PER_VIEWER),
                Uuid::new_v4(),
                Uuid::new_v4(),
                tmp.path().to_str().unwrap(),
                manifest(
                    b"pending",
                    &format!("global-{index}.bin"),
                    UploadDestination::Cwd,
                ),
            )
            .await
            .unwrap();
        }
        assert_eq!(hub.retained_counts().await.0, MAX_ACTIVE_UPLOADS_TOTAL);
        assert!(hub
            .start(
                session,
                "overflow-viewer",
                Uuid::new_v4(),
                Uuid::new_v4(),
                tmp.path().to_str().unwrap(),
                manifest(b"pending", "overflow.bin", UploadDestination::Cwd),
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("too many"));
        hub.remove_generation_until(session, TokioInstant::now() + Duration::from_secs(5))
            .await;
        wait_for_upload_drain(&hub).await;
        assert_eq!(hub.retained_counts().await, (0, 0));
    }

    #[tokio::test]
    async fn completed_cache_is_bounded_and_ttl_pruned() {
        let tmp = tempfile::tempdir().unwrap();
        let hub = UploadHub::default();
        let session = SessionBinding::new(Uuid::new_v4(), 10);
        let mut completed = Vec::new();
        for index in 0..=MAX_COMPLETED_UPLOADS {
            let upload_id = Uuid::new_v4();
            let upload_manifest =
                manifest(b"x", &format!("cache-{index}.bin"), UploadDestination::Cwd);
            complete(
                &hub,
                CompleteUpload {
                    session,
                    viewer: "viewer",
                    capability: Uuid::new_v4(),
                    upload_id,
                    cwd: tmp.path().to_str().unwrap(),
                    bytes: b"x",
                    manifest: upload_manifest.clone(),
                },
            )
            .await;
            completed.push((upload_id, upload_manifest));
        }
        assert_eq!(hub.retained_counts().await, (0, MAX_COMPLETED_UPLOADS));
        let (first_id, first_manifest) = completed.first().unwrap();
        assert!(matches!(
            hub.start(
                session,
                "viewer",
                Uuid::new_v4(),
                *first_id,
                tmp.path().to_str().unwrap(),
                first_manifest.clone(),
            )
            .await
            .unwrap(),
            UploadStartOutcome::Ready { .. }
        ));
        hub.remove_generation_until(session, TokioInstant::now() + Duration::from_secs(5))
            .await;
        assert_eq!(hub.retained_counts().await, (0, 0));

        let session = SessionBinding::new(Uuid::new_v4(), 11);
        let ttl_id = Uuid::new_v4();
        let ttl_manifest = manifest(b"ttl", "ttl.bin", UploadDestination::Cwd);
        complete(
            &hub,
            CompleteUpload {
                session,
                viewer: "viewer",
                capability: Uuid::new_v4(),
                upload_id: ttl_id,
                cwd: tmp.path().to_str().unwrap(),
                bytes: b"ttl",
                manifest: ttl_manifest.clone(),
            },
        )
        .await;
        hub.age_completed(COMPLETED_UPLOAD_TTL + Duration::from_secs(1));
        assert!(matches!(
            hub.start(
                session,
                "viewer",
                Uuid::new_v4(),
                ttl_id,
                tmp.path().to_str().unwrap(),
                ttl_manifest,
            )
            .await
            .unwrap(),
            UploadStartOutcome::Ready { .. }
        ));
        hub.remove_generation_until(session, TokioInstant::now() + Duration::from_secs(5))
            .await;
        wait_for_upload_drain(&hub).await;
    }

    #[tokio::test]
    async fn concurrent_same_destination_commits_never_clobber() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("note.txt"), b"old").unwrap();
        let hub = UploadHub::default();
        let session = SessionBinding::new(Uuid::new_v4(), 1);
        let first = complete(
            &hub,
            CompleteUpload {
                session,
                viewer: "first",
                capability: Uuid::new_v4(),
                upload_id: Uuid::new_v4(),
                cwd: tmp.path().to_str().unwrap(),
                bytes: b"first",
                manifest: manifest(b"first", "note.txt", UploadDestination::Cwd),
            },
        )
        .await;
        let second = complete(
            &hub,
            CompleteUpload {
                session,
                viewer: "second",
                capability: Uuid::new_v4(),
                upload_id: Uuid::new_v4(),
                cwd: tmp.path().to_str().unwrap(),
                bytes: b"second",
                manifest: manifest(b"second", "note.txt", UploadDestination::Cwd),
            },
        )
        .await;
        assert_eq!(std::fs::read(tmp.path().join("note.txt")).unwrap(), b"old");
        assert_ne!(first.path, second.path);
        assert_eq!(std::fs::read(first.path).unwrap(), b"first");
        assert_eq!(std::fs::read(second.path).unwrap(), b"second");
    }

    #[tokio::test]
    async fn conflicts_bad_chunks_and_cancellation_remove_temporary_files() {
        let tmp = tempfile::tempdir().unwrap();
        let hub = UploadHub::default();
        let session = SessionBinding::new(Uuid::new_v4(), 2);
        let capability = Uuid::new_v4();
        let upload_id = Uuid::new_v4();
        let bytes = vec![9; UPLOAD_CHUNK_BYTES + 1];
        let upload_manifest = manifest(&bytes, "file.bin", UploadDestination::Cwd);
        hub.start(
            session,
            "viewer",
            capability,
            upload_id,
            tmp.path().to_str().unwrap(),
            upload_manifest.clone(),
        )
        .await
        .unwrap();
        let mut conflict = upload_manifest.clone();
        conflict.name = "other.bin".into();
        assert!(hub
            .start(
                session,
                "viewer",
                capability,
                upload_id,
                tmp.path().to_str().unwrap(),
                conflict,
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("manifest"));
        assert!(hub
            .write_chunk(
                session,
                UploadChunkRequest {
                    viewer_id: "viewer",
                    capability,
                    upload_id,
                    sequence: 1,
                    last: true,
                    bytes: &bytes[UPLOAD_CHUNK_BYTES..],
                },
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("out of order"));
        assert_eq!(hub.retained_counts().await, (0, 0));
        assert!(std::fs::read_dir(tmp.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("spawn-upload")));

        let second_id = Uuid::new_v4();
        hub.start(
            session,
            "viewer",
            capability,
            second_id,
            tmp.path().to_str().unwrap(),
            upload_manifest,
        )
        .await
        .unwrap();
        assert!(hub
            .cancel(session, "viewer", capability, second_id)
            .await
            .unwrap());
        assert_eq!(hub.retained_counts().await, (0, 0));
    }

    #[tokio::test]
    async fn checksum_failure_and_session_teardown_leave_no_files() {
        let tmp = tempfile::tempdir().unwrap();
        let hub = UploadHub::default();
        let session = SessionBinding::new(Uuid::new_v4(), 3);
        let capability = Uuid::new_v4();
        let upload_id = Uuid::new_v4();
        let mut bad_hash = manifest(b"actual", "note.txt", UploadDestination::Cwd);
        bad_hash.sha256 = "00".repeat(32);
        hub.start(
            session,
            "viewer",
            capability,
            upload_id,
            tmp.path().to_str().unwrap(),
            bad_hash,
        )
        .await
        .unwrap();
        assert!(hub
            .write_chunk(
                session,
                UploadChunkRequest {
                    viewer_id: "viewer",
                    capability,
                    upload_id,
                    sequence: 0,
                    last: true,
                    bytes: b"actual",
                },
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("checksum"));
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0);

        for index in 0..MAX_ACTIVE_UPLOADS_PER_VIEWER {
            hub.start(
                session,
                "viewer",
                capability,
                Uuid::new_v4(),
                tmp.path().to_str().unwrap(),
                manifest(
                    b"pending",
                    &format!("pending-{index}.txt"),
                    UploadDestination::Cwd,
                ),
            )
            .await
            .unwrap();
        }
        assert!(hub
            .start(
                session,
                "viewer",
                capability,
                Uuid::new_v4(),
                tmp.path().to_str().unwrap(),
                manifest(b"pending", "over-limit.txt", UploadDestination::Cwd),
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("too many"));
        hub.cancel_viewer(session, "viewer").await;
        assert_eq!(hub.retained_counts().await, (0, 0));
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn cancellation_and_final_commit_have_one_fail_closed_linearization() {
        let tmp = tempfile::tempdir().unwrap();
        let hub = UploadHub::default();
        let session = SessionBinding::new(Uuid::new_v4(), 5);
        let capability = Uuid::new_v4();
        for index in 0..32 {
            let upload_id = Uuid::new_v4();
            let name = format!("race-{index}.txt");
            hub.start(
                session,
                "viewer",
                capability,
                upload_id,
                tmp.path().to_str().unwrap(),
                manifest(b"x", &name, UploadDestination::Cwd),
            )
            .await
            .unwrap();
            let write = hub.write_chunk(
                session,
                UploadChunkRequest {
                    viewer_id: "viewer",
                    capability,
                    upload_id,
                    sequence: 0,
                    last: true,
                    bytes: b"x",
                },
            );
            let cancel = hub.cancel(session, "viewer", capability, upload_id);
            let (write, cancel) = tokio::join!(write, cancel);
            match (write, cancel.unwrap()) {
                (Ok(UploadChunkOutcome::Complete(result)), false) => {
                    assert_eq!(std::fs::read(result.path).unwrap(), b"x");
                }
                (Err(_), true) => {
                    assert!(!tmp.path().join(&name).exists());
                }
                outcome => panic!("commit/cancel race had an ambiguous outcome: {outcome:?}"),
            }
        }
        assert!(std::fs::read_dir(tmp.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("spawn-upload")));
    }

    async fn wait_for_upload_drain(hub: &UploadHub) {
        assert!(
            hub.wait_for_operations(TokioInstant::now() + Duration::from_secs(5))
                .await,
            "owned blocking upload operations did not drain"
        );
        for _ in 0..100 {
            if hub.retained_counts().await.0 == 0 {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("upload admission charge was not released after cleanup");
    }

    #[tokio::test]
    async fn stalled_prepare_is_cancelled_by_one_deadline_and_remains_charged_until_cleanup() {
        let tmp = tempfile::tempdir().unwrap();
        let hub = UploadHub::default();
        let hooks = hub.lifecycle_hooks();
        hooks.prepare.arm();
        let session = SessionBinding::new(Uuid::new_v4(), 41);
        let capability = Uuid::new_v4();
        let upload_id = Uuid::new_v4();
        let cwd = tmp.path().to_string_lossy().into_owned();
        let start_hub = hub.clone();
        let start = tokio::spawn(async move {
            start_hub
                .start(
                    session,
                    "viewer",
                    capability,
                    upload_id,
                    &cwd,
                    manifest(b"pending", "pending.txt", UploadDestination::Cwd),
                )
                .await
        });
        hooks.prepare.wait_until_entered().await;
        hub.cancel_viewer_until(
            session,
            "viewer",
            TokioInstant::now() + Duration::from_millis(20),
        )
        .await;
        assert_eq!(hub.retained_counts().await.0, 1);
        assert!(hub.operation_count() >= 1);
        hooks.prepare.release();
        assert_eq!(start.await.unwrap().unwrap_err().code, "cancelled");
        wait_for_upload_drain(&hub).await;
        assert_eq!(hub.retained_counts().await, (0, 0));
        assert!(std::fs::read_dir(tmp.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("spawn-upload")));
    }

    #[tokio::test]
    async fn stalled_sync_and_commit_obey_the_pre_post_effect_fence() {
        for commit_linearized in [false, true] {
            let tmp = tempfile::tempdir().unwrap();
            let hub = UploadHub::default();
            let hooks = hub.lifecycle_hooks();
            let pause = if commit_linearized {
                &hooks.commit
            } else {
                &hooks.write_sync
            };
            pause.arm();
            let session = SessionBinding::new(Uuid::new_v4(), 42);
            let capability = Uuid::new_v4();
            let upload_id = Uuid::new_v4();
            hub.start(
                session,
                "viewer",
                capability,
                upload_id,
                tmp.path().to_str().unwrap(),
                manifest(b"effect", "effect.txt", UploadDestination::Cwd),
            )
            .await
            .unwrap();
            let write_hub = hub.clone();
            let write = tokio::spawn(async move {
                write_hub
                    .write_chunk(
                        session,
                        UploadChunkRequest {
                            viewer_id: "viewer",
                            capability,
                            upload_id,
                            sequence: 0,
                            last: true,
                            bytes: b"effect",
                        },
                    )
                    .await
            });
            pause.wait_until_entered().await;
            hub.cancel_viewer_until(
                session,
                "viewer",
                TokioInstant::now() + Duration::from_millis(20),
            )
            .await;
            assert_eq!(hub.retained_counts().await.0, 1);
            pause.release();
            let outcome = write.await.unwrap();
            if commit_linearized {
                assert!(matches!(outcome.unwrap(), UploadChunkOutcome::Complete(_)));
                assert_eq!(
                    std::fs::read(tmp.path().join("effect.txt")).unwrap(),
                    b"effect"
                );
            } else {
                assert_eq!(outcome.unwrap_err().code, "cancelled");
                assert!(!tmp.path().join("effect.txt").exists());
            }
            wait_for_upload_drain(&hub).await;
            assert_eq!(hub.retained_counts().await.0, 0);
        }
    }

    #[tokio::test]
    async fn generation_replacement_does_not_resurrect_cache_or_late_response_state() {
        let tmp = tempfile::tempdir().unwrap();
        let hub = UploadHub::default();
        let hooks = hub.lifecycle_hooks();
        hooks.commit.arm();
        let session = SessionBinding::new(Uuid::new_v4(), 45);
        let capability = Uuid::new_v4();
        let upload_id = Uuid::new_v4();
        let upload_manifest = manifest(b"linearized", "linearized.txt", UploadDestination::Cwd);
        hub.start(
            session,
            "viewer",
            capability,
            upload_id,
            tmp.path().to_str().unwrap(),
            upload_manifest.clone(),
        )
        .await
        .unwrap();
        let write_hub = hub.clone();
        let write = tokio::spawn(async move {
            write_hub
                .write_chunk(
                    session,
                    UploadChunkRequest {
                        viewer_id: "viewer",
                        capability,
                        upload_id,
                        sequence: 0,
                        last: true,
                        bytes: b"linearized",
                    },
                )
                .await
        });
        hooks.commit.wait_until_entered().await;
        hub.remove_generation_now(session);
        hub.remove_generation_until(session, TokioInstant::now() + Duration::from_millis(20))
            .await;
        assert_eq!(hub.retained_counts().await, (1, 0));
        hooks.commit.release();
        assert!(matches!(
            write.await.unwrap().unwrap(),
            UploadChunkOutcome::Complete(_)
        ));
        wait_for_upload_drain(&hub).await;
        assert_eq!(hub.retained_counts().await, (0, 0));
        assert_eq!(
            hub.start(
                session,
                "viewer",
                capability,
                upload_id,
                tmp.path().to_str().unwrap(),
                upload_manifest,
            )
            .await
            .unwrap_err()
            .code,
            "stale_agent_generation"
        );
        assert_eq!(
            std::fs::read(tmp.path().join("linearized.txt")).unwrap(),
            b"linearized"
        );
    }

    #[tokio::test]
    async fn stalled_post_publish_cleanup_keeps_capacity_and_cannot_be_downgraded() {
        let tmp = tempfile::tempdir().unwrap();
        let hub = UploadHub::default();
        let hooks = hub.lifecycle_hooks();
        hooks.cleanup.arm();
        let session = SessionBinding::new(Uuid::new_v4(), 43);
        let capability = Uuid::new_v4();
        let upload_id = Uuid::new_v4();
        let upload_manifest = manifest(b"published", "published.txt", UploadDestination::Cwd);
        hub.start(
            session,
            "viewer",
            capability,
            upload_id,
            tmp.path().to_str().unwrap(),
            upload_manifest.clone(),
        )
        .await
        .unwrap();
        let write_hub = hub.clone();
        let write = tokio::spawn(async move {
            write_hub
                .write_chunk(
                    session,
                    UploadChunkRequest {
                        viewer_id: "viewer",
                        capability,
                        upload_id,
                        sequence: 0,
                        last: true,
                        bytes: b"published",
                    },
                )
                .await
        });
        hooks.cleanup.wait_until_entered().await;
        assert_eq!(hub.retained_counts().await, (1, 1));
        assert!(!hub
            .cancel(session, "viewer", capability, upload_id)
            .await
            .unwrap());
        assert_eq!(hub.retained_counts().await.0, 1);
        hooks.cleanup.release();
        assert!(matches!(
            write.await.unwrap().unwrap(),
            UploadChunkOutcome::Complete(_)
        ));
        wait_for_upload_drain(&hub).await;
        assert!(matches!(
            hub.start(
                session,
                "replacement-viewer",
                Uuid::new_v4(),
                upload_id,
                tmp.path().to_str().unwrap(),
                upload_manifest,
            )
            .await
            .unwrap(),
            UploadStartOutcome::Complete(_)
        ));
    }

    #[tokio::test]
    async fn post_link_unlink_and_fsync_failures_are_unknown_but_reconcile_idempotently() {
        for fail_unlink in [true, false] {
            let tmp = tempfile::tempdir().unwrap();
            let hub = UploadHub::default();
            let hooks = hub.lifecycle_hooks();
            if fail_unlink {
                hooks.fail_unlink_count.store(1, Ordering::Release);
            } else {
                hooks.fail_fsync_count.store(1, Ordering::Release);
            }
            let session = SessionBinding::new(Uuid::new_v4(), 44);
            let capability = Uuid::new_v4();
            let upload_id = Uuid::new_v4();
            let upload_manifest = manifest(b"once", "once.txt", UploadDestination::Cwd);
            hub.start(
                session,
                "viewer",
                capability,
                upload_id,
                tmp.path().to_str().unwrap(),
                upload_manifest.clone(),
            )
            .await
            .unwrap();
            let error = hub
                .write_chunk(
                    session,
                    UploadChunkRequest {
                        viewer_id: "viewer",
                        capability,
                        upload_id,
                        sequence: 0,
                        last: true,
                        bytes: b"once",
                    },
                )
                .await
                .unwrap_err();
            assert_eq!(error.code, "outcome_unknown");
            wait_for_upload_drain(&hub).await;
            let reconciled = hub
                .start(
                    session,
                    "replacement-viewer",
                    Uuid::new_v4(),
                    upload_id,
                    tmp.path().to_str().unwrap(),
                    upload_manifest,
                )
                .await
                .unwrap();
            assert!(matches!(reconciled, UploadStartOutcome::Complete(_)));
            let published = std::fs::read_dir(tmp.path())
                .unwrap()
                .filter_map(std::result::Result::ok)
                .filter(|entry| !entry.file_name().to_string_lossy().contains("spawn-upload"))
                .count();
            assert_eq!(
                published, 1,
                "stable-id reconciliation duplicated publication"
            );
        }
    }

    #[tokio::test]
    async fn teardown_retries_repeated_post_publish_cleanup_failures_until_fully_drained() {
        for (fail_unlink, remove_generation) in
            [(true, false), (false, false), (true, true), (false, true)]
        {
            let tmp = tempfile::tempdir().unwrap();
            let hub = UploadHub::default();
            let hooks = hub.lifecycle_hooks();
            if fail_unlink {
                hooks.fail_unlink_count.store(2, Ordering::Release);
            } else {
                hooks.fail_fsync_count.store(2, Ordering::Release);
            }
            let session = SessionBinding::new(Uuid::new_v4(), 45);
            let capability = Uuid::new_v4();
            let upload_id = Uuid::new_v4();
            let upload_manifest = manifest(b"retry", "retry.txt", UploadDestination::Cwd);
            hub.start(
                session,
                "viewer",
                capability,
                upload_id,
                tmp.path().to_str().unwrap(),
                upload_manifest.clone(),
            )
            .await
            .unwrap();

            let error = hub
                .write_chunk(
                    session,
                    UploadChunkRequest {
                        viewer_id: "viewer",
                        capability,
                        upload_id,
                        sequence: 0,
                        last: true,
                        bytes: b"retry",
                    },
                )
                .await
                .unwrap_err();
            assert_eq!(error.code, "outcome_unknown");
            assert!(
                hub.wait_for_operations(TokioInstant::now() + Duration::from_secs(2))
                    .await
            );
            assert_eq!(hub.retained_counts().await, (1, 1));
            assert_eq!(hub.operation_count(), 0);

            let deadline = TokioInstant::now() + Duration::from_secs(2);
            if remove_generation {
                hub.remove_generation_now(session);
                hub.remove_generation_until(session, deadline).await;
            } else {
                hub.cancel_viewer_now(session, "viewer");
                hub.cancel_viewer_until(session, "viewer", deadline).await;
            }
            assert!(hub.wait_for_operations(deadline).await);
            assert_eq!(hub.retained_counts().await.0, 0);
            assert_eq!(hub.operation_count(), 0);

            let names = std::fs::read_dir(tmp.path())
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            assert_eq!(
                names
                    .iter()
                    .filter(|name| !name.contains("spawn-upload"))
                    .count(),
                1,
                "cleanup retry duplicated the published destination"
            );
            assert!(
                names.iter().all(|name| !name.contains("spawn-upload")),
                "cleanup retry retained a private temporary name: {names:?}"
            );
            #[cfg(target_os = "linux")]
            {
                let retained_fds = std::fs::read_dir("/proc/self/fd")
                    .unwrap()
                    .filter_map(std::result::Result::ok)
                    .filter_map(|entry| std::fs::read_link(entry.path()).ok())
                    .filter(|target| target.starts_with(tmp.path()))
                    .count();
                assert_eq!(
                    retained_fds, 0,
                    "cleanup retry retained upload file descriptors"
                );
            }

            let reconciled = hub
                .start(
                    session,
                    "replacement-viewer",
                    Uuid::new_v4(),
                    upload_id,
                    tmp.path().to_str().unwrap(),
                    upload_manifest,
                )
                .await;
            if remove_generation {
                assert_eq!(reconciled.unwrap_err().code, "stale_agent_generation");
            } else {
                assert!(matches!(
                    reconciled.unwrap(),
                    UploadStartOutcome::Complete(_)
                ));
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn existing_symlink_destination_is_never_followed_or_clobbered() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let outside_file = outside.path().join("outside.txt");
        std::fs::write(&outside_file, b"outside").unwrap();
        symlink(&outside_file, tmp.path().join("note.txt")).unwrap();
        let result = complete(
            &UploadHub::default(),
            CompleteUpload {
                session: SessionBinding::new(Uuid::new_v4(), 1),
                viewer: "viewer",
                capability: Uuid::new_v4(),
                upload_id: Uuid::new_v4(),
                cwd: tmp.path().to_str().unwrap(),
                bytes: b"inside",
                manifest: manifest(b"inside", "note.txt", UploadDestination::Cwd),
            },
        )
        .await;
        assert_eq!(std::fs::read(&outside_file).unwrap(), b"outside");
        assert_ne!(Path::new(&result.path), tmp.path().join("note.txt"));
        assert_eq!(std::fs::read(&result.path).unwrap(), b"inside");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cwd_symlink_component_and_ambiguous_names_fail_before_file_creation() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), tmp.path().join("escape")).unwrap();
        let hub = UploadHub::default();
        let session = SessionBinding::new(Uuid::new_v4(), 1);
        assert!(hub
            .start(
                session,
                "viewer",
                Uuid::new_v4(),
                Uuid::new_v4(),
                tmp.path().join("escape").to_str().unwrap(),
                manifest(b"inside", "note.txt", UploadDestination::Cwd),
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("capability component"));
        for name in ["", ".", "..", "../escape", "/absolute", "a/b", "a\\b"] {
            let error = manifest(b"inside", name, UploadDestination::Cwd)
                .validate()
                .unwrap_err();
            assert!(error.to_string().contains("unambiguous"), "{name:?}");
        }
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn attachment_symlink_escape_fails_closed() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), tmp.path().join(".spawn")).unwrap();
        let hub = UploadHub::default();
        let error = hub
            .start(
                SessionBinding::new(Uuid::new_v4(), 1),
                "viewer",
                Uuid::new_v4(),
                Uuid::new_v4(),
                tmp.path().to_str().unwrap(),
                manifest(b"image", "shot.png", UploadDestination::Attachments),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("without following links"));
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
    }

    #[cfg(windows)]
    #[test]
    fn windows_upload_roots_and_names_reject_ambiguous_native_shapes() {
        for root in [
            r"\\server\share\folder",
            r"\\?\UNC\server\share\folder",
            r"\\.\C:\folder",
        ] {
            let error = open_capability_root(root)
                .err()
                .expect("UNC/device root must be unavailable");
            assert!(
                error.to_string().contains("UNC") || error.to_string().contains("device"),
                "unexpected error for {root:?}: {error:#}"
            );
        }
        for name in [
            "CON",
            "con.txt",
            "LPT9.log",
            "trailing.",
            "trailing ",
            "colon:name",
            "question?.txt",
        ] {
            let error = manifest(b"inside", name, UploadDestination::Cwd)
                .validate()
                .unwrap_err();
            assert!(error.to_string().contains("Windows file name"), "{name:?}");
        }
        for name in ["", ".", "..", r"..\escape", r"C:\absolute", "a/b", r"a\b"] {
            let error = manifest(b"inside", name, UploadDestination::Cwd)
                .validate()
                .unwrap_err();
            assert!(error.to_string().contains("unambiguous"), "{name:?}");
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_upload_refuses_file_and_directory_reparse_escapes() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let outside_file = outside.path().join("outside.txt");
        std::fs::write(&outside_file, b"outside").unwrap();
        let destination_link = tmp.path().join("note.txt");
        match std::os::windows::fs::symlink_file(&outside_file, &destination_link) {
            Ok(()) => {
                let result = complete(
                    &UploadHub::default(),
                    CompleteUpload {
                        session: SessionBinding::new(Uuid::new_v4(), 1),
                        viewer: "viewer",
                        capability: Uuid::new_v4(),
                        upload_id: Uuid::new_v4(),
                        cwd: tmp.path().to_str().unwrap(),
                        bytes: b"inside",
                        manifest: manifest(b"inside", "note.txt", UploadDestination::Cwd),
                    },
                )
                .await;
                assert_eq!(std::fs::read(&outside_file).unwrap(), b"outside");
                assert_ne!(Path::new(&result.path), destination_link);
            }
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {}
            Err(error) => panic!("creating file symlink failed unexpectedly: {error}"),
        }

        let escape = tmp.path().join("escape");
        match std::os::windows::fs::symlink_dir(outside.path(), &escape) {
            Ok(()) => {
                let error = UploadHub::default()
                    .start(
                        SessionBinding::new(Uuid::new_v4(), 1),
                        "viewer",
                        Uuid::new_v4(),
                        Uuid::new_v4(),
                        escape.to_str().unwrap(),
                        manifest(b"inside", "note.txt", UploadDestination::Cwd),
                    )
                    .await
                    .unwrap_err();
                assert!(error.to_string().contains("capability component"));
                assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 1);
            }
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {}
            Err(error) => panic!("creating directory symlink failed unexpectedly: {error}"),
        }
    }
}
