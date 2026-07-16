use std::collections::{HashMap, VecDeque};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use nix::errno::Errno;
use nix::fcntl::{open, openat, OFlag};
use nix::sys::stat::{fchmod, mkdirat, Mode};
use nix::unistd::{fsync, linkat, unlinkat, UnlinkatFlags};
use sha2::{Digest, Sha256};
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::agents::AgentBinding;

pub const MAX_UPLOAD_BYTES: usize = 20 * 1024 * 1024;
pub const UPLOAD_CHUNK_BYTES: usize = 48 * 1024;
pub const MAX_ACTIVE_UPLOADS_PER_SESSION: usize = 4;
pub const MAX_ACTIVE_UPLOADS_TOTAL: usize = 64;
pub const MAX_COMPLETED_UPLOADS: usize = 128;
pub const COMPLETED_UPLOAD_TTL: Duration = Duration::from_secs(10 * 60);
pub const MAX_UPLOAD_NAME_BYTES: usize = 255;
pub const MAX_UPLOAD_MIME_BYTES: usize = 128;
pub const MAX_UPLOAD_PATH_BYTES: usize = 4096;

const UPLOAD_ACTIVE: u8 = 0;
const UPLOAD_CANCELLED: u8 = 1;
const UPLOAD_COMMITTING: u8 = 2;
const UPLOAD_COMPLETE: u8 = 3;

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
    pub session_id: &'a str,
    pub capability: Uuid,
    pub upload_id: Uuid,
    pub sequence: u32,
    pub last: bool,
    pub bytes: &'a [u8],
}

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct UploadKey {
    agent_id: Uuid,
    agent_generation: u64,
    upload_id: Uuid,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct UploadOwner {
    capability: Uuid,
    session_id: String,
}

struct ActiveUpload {
    owner: UploadOwner,
    manifest: UploadManifest,
    root_path: PathBuf,
    directory: Arc<OwnedFd>,
    temp_name: String,
    final_name: String,
    file: Option<fs::File>,
    hasher: Sha256,
    next_sequence: u32,
    received_bytes: usize,
}

struct ActiveEntry {
    owner: UploadOwner,
    upload: Arc<Mutex<ActiveUpload>>,
    lifecycle: Arc<AtomicU8>,
}

struct CompletedUpload {
    manifest: UploadManifest,
    result: UploadResult,
    completed_at: Instant,
}

#[derive(Default)]
struct UploadState {
    active: HashMap<UploadKey, ActiveEntry>,
    completed: HashMap<UploadKey, CompletedUpload>,
    completed_order: VecDeque<UploadKey>,
}

#[derive(Clone, Default)]
pub struct UploadHub {
    state: Arc<Mutex<UploadState>>,
}

impl UploadHub {
    #[allow(clippy::too_many_arguments)]
    pub async fn start(
        &self,
        agent: AgentBinding,
        session_id: &str,
        capability: Uuid,
        upload_id: Uuid,
        cwd: &str,
        manifest: UploadManifest,
    ) -> Result<UploadStartOutcome> {
        manifest.validate()?;
        let key = upload_key(agent, upload_id);
        let owner = UploadOwner {
            capability,
            session_id: session_id.to_string(),
        };

        let mut state = self.state.lock().await;
        prune_completed(&mut state);
        if let Some(completed) = state.completed.get(&key) {
            if completed.manifest != manifest {
                anyhow::bail!("upload id was reused with a conflicting manifest");
            }
            return Ok(UploadStartOutcome::Complete(completed.result.clone()));
        }
        if let Some(entry) = state.active.get(&key) {
            if entry.lifecycle.load(Ordering::Acquire) != UPLOAD_ACTIVE {
                anyhow::bail!("upload is being cancelled or committed");
            }
            let existing_owner = entry.owner.clone();
            let existing = Arc::clone(&entry.upload);
            drop(state);
            let existing = existing.lock().await;
            if existing_owner != owner || existing.manifest != manifest {
                anyhow::bail!("upload id is already active with another manifest or capability");
            }
            return Ok(UploadStartOutcome::Ready {
                next_sequence: existing.next_sequence,
                received_bytes: existing.received_bytes,
            });
        }
        let session_active = state
            .active
            .values()
            .filter(|entry| entry.owner.session_id == session_id)
            .count();
        if session_active >= MAX_ACTIVE_UPLOADS_PER_SESSION
            || state.active.len() >= MAX_ACTIVE_UPLOADS_TOTAL
        {
            anyhow::bail!("too many active uploads");
        }
        // Preparation performs only bounded descriptor-relative syscalls. It
        // stays inside the admission lock so concurrent viewers cannot create
        // uncounted temporary files or descriptors beyond the global cap.
        let prepared = Arc::new(Mutex::new(prepare_upload(cwd, owner.clone(), manifest)?));
        state.active.insert(
            key,
            ActiveEntry {
                owner,
                upload: prepared,
                lifecycle: Arc::new(AtomicU8::new(UPLOAD_ACTIVE)),
            },
        );
        Ok(UploadStartOutcome::Ready {
            next_sequence: 0,
            received_bytes: 0,
        })
    }

    pub async fn write_chunk(
        &self,
        agent: AgentBinding,
        request: UploadChunkRequest<'_>,
    ) -> Result<UploadChunkOutcome> {
        let UploadChunkRequest {
            session_id,
            capability,
            upload_id,
            sequence,
            last,
            bytes,
        } = request;
        let key = upload_key(agent, upload_id);
        let (active, lifecycle) = {
            let state = self.state.lock().await;
            let entry = state.active.get(&key).context("upload is not active")?;
            (Arc::clone(&entry.upload), Arc::clone(&entry.lifecycle))
        };
        let result = write_active_chunk(
            Arc::clone(&active),
            &lifecycle,
            &UploadOwner {
                capability,
                session_id: session_id.to_string(),
            },
            sequence,
            last,
            bytes,
        )
        .await;
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                self.remove_active(&key, &active).await;
                cleanup_active(active).await;
                return Err(error);
            }
        };
        let Some(result) = result else {
            return Ok(UploadChunkOutcome::Pending);
        };

        let manifest = active.lock().await.manifest.clone();
        let mut state = self.state.lock().await;
        if !state
            .active
            .get(&key)
            .is_some_and(|entry| Arc::ptr_eq(&entry.upload, &active))
        {
            anyhow::bail!("upload completion lost its active lifecycle binding");
        }
        state.active.remove(&key);
        prune_completed(&mut state);
        state.completed.insert(
            key.clone(),
            CompletedUpload {
                manifest,
                result: result.clone(),
                completed_at: Instant::now(),
            },
        );
        state.completed_order.push_back(key);
        prune_completed(&mut state);
        Ok(UploadChunkOutcome::Complete(result))
    }

    pub async fn cancel(
        &self,
        agent: AgentBinding,
        session_id: &str,
        capability: Uuid,
        upload_id: Uuid,
    ) -> Result<bool> {
        let key = upload_key(agent, upload_id);
        let (active, lifecycle) = {
            let state = self.state.lock().await;
            let Some(entry) = state.active.get(&key) else {
                return Ok(false);
            };
            if entry.owner
                != (UploadOwner {
                    capability,
                    session_id: session_id.to_string(),
                })
            {
                anyhow::bail!("upload capability does not own the active upload");
            }
            (Arc::clone(&entry.upload), Arc::clone(&entry.lifecycle))
        };
        if lifecycle
            .compare_exchange(
                UPLOAD_ACTIVE,
                UPLOAD_CANCELLED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_err()
        {
            return Ok(false);
        }
        self.remove_active(&key, &active).await;
        cleanup_active(active).await;
        Ok(true)
    }

    pub async fn cancel_session(&self, agent: AgentBinding, session_id: &str) {
        let active = {
            let state = self.state.lock().await;
            state
                .active
                .iter()
                .filter(|(key, active)| {
                    key.agent_id == agent.agent_id()
                        && key.agent_generation == agent.generation()
                        && active.owner.session_id == session_id
                })
                .map(|(key, active)| {
                    (
                        key.clone(),
                        Arc::clone(&active.upload),
                        Arc::clone(&active.lifecycle),
                    )
                })
                .collect::<Vec<_>>()
        };
        for (key, upload, lifecycle) in active {
            if lifecycle
                .compare_exchange(
                    UPLOAD_ACTIVE,
                    UPLOAD_CANCELLED,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .is_ok()
            {
                self.remove_active(&key, &upload).await;
                cleanup_active(upload).await;
            }
        }
    }

    pub async fn remove_generation(&self, agent: AgentBinding) {
        let active = {
            let state = self.state.lock().await;
            state
                .active
                .iter()
                .filter(|(key, _)| {
                    key.agent_id == agent.agent_id() && key.agent_generation == agent.generation()
                })
                .map(|(key, entry)| {
                    (
                        key.clone(),
                        Arc::clone(&entry.upload),
                        Arc::clone(&entry.lifecycle),
                    )
                })
                .collect::<Vec<_>>()
        };
        for (key, upload, lifecycle) in active {
            let _ = lifecycle.compare_exchange(
                UPLOAD_ACTIVE,
                UPLOAD_CANCELLED,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
            // Generation teardown runs after the RTC callback fence drains.
            // Locking here also makes an unexpected concurrent writer settle
            // before its map/cache state is removed.
            let guard = upload.lock().await;
            self.remove_active(&key, &upload).await;
            drop(guard);
            cleanup_active(upload).await;
        }
        {
            let mut state = self.state.lock().await;
            state.completed.retain(|key, _| {
                key.agent_id != agent.agent_id() || key.agent_generation != agent.generation()
            });
            state.completed_order.retain(|key| {
                key.agent_id != agent.agent_id() || key.agent_generation != agent.generation()
            });
        }
    }

    async fn remove_active(&self, key: &UploadKey, expected: &Arc<Mutex<ActiveUpload>>) {
        let mut state = self.state.lock().await;
        if state
            .active
            .get(key)
            .is_some_and(|entry| Arc::ptr_eq(&entry.upload, expected))
        {
            state.active.remove(key);
        }
    }

    #[cfg(test)]
    pub(crate) async fn retained_counts(&self) -> (usize, usize) {
        let state = self.state.lock().await;
        (state.active.len(), state.completed.len())
    }
}

fn upload_key(agent: AgentBinding, upload_id: Uuid) -> UploadKey {
    UploadKey {
        agent_id: agent.agent_id(),
        agent_generation: agent.generation(),
        upload_id,
    }
}

fn prune_completed(state: &mut UploadState) {
    let now = Instant::now();
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
    let raw = openat(
        Some(directory.as_raw_fd()),
        temp_name.as_str(),
        OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
        Mode::from_bits_truncate(0o600),
    )
    .context("creating private upload temporary file")?;
    let file = unsafe { std::fs::File::from_raw_fd(raw) };
    let file = fs::File::from_std(file);
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

async fn write_active_chunk(
    active: Arc<Mutex<ActiveUpload>>,
    lifecycle: &AtomicU8,
    owner: &UploadOwner,
    sequence: u32,
    last: bool,
    bytes: &[u8],
) -> Result<Option<UploadResult>> {
    let mut active = active.lock().await;
    if lifecycle.load(Ordering::Acquire) != UPLOAD_ACTIVE {
        anyhow::bail!("upload was cancelled");
    }
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
    let file = active
        .file
        .as_mut()
        .context("upload temporary file is closed")?;
    file.write_all(bytes)
        .await
        .context("writing upload chunk")?;
    active.hasher.update(bytes);
    active.received_bytes += bytes.len();
    active.next_sequence += 1;
    if !last {
        return Ok(None);
    }
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
    let mut file = active
        .file
        .take()
        .context("upload temporary file is closed")?;
    file.flush()
        .await
        .context("flushing upload temporary file")?;
    file.sync_all()
        .await
        .context("syncing upload temporary file")?;
    drop(file);
    lifecycle
        .compare_exchange(
            UPLOAD_ACTIVE,
            UPLOAD_COMMITTING,
            Ordering::AcqRel,
            Ordering::Acquire,
        )
        .map_err(|_| anyhow::anyhow!("upload was cancelled before commit"))?;
    let committed_name =
        commit_no_clobber(&active.directory, &active.temp_name, &active.final_name)?;
    let relative = match active.manifest.destination {
        UploadDestination::Cwd => PathBuf::from(&committed_name),
        UploadDestination::Attachments => PathBuf::from(".spawn")
            .join("attachments")
            .join(&committed_name),
    };
    let path = active.root_path.join(relative);
    let path = path
        .to_str()
        .expect("upload result path was validated before file creation")
        .to_string();
    debug_assert!(path.len() <= MAX_UPLOAD_PATH_BYTES);
    let result = UploadResult {
        path,
        total_bytes: active.manifest.total_bytes,
        sha256: actual_hash,
    };
    lifecycle.store(UPLOAD_COMPLETE, Ordering::Release);
    Ok(Some(result))
}

async fn cleanup_active(active: Arc<Mutex<ActiveUpload>>) {
    let mut active = active.lock().await;
    active.file.take();
    let _ = unlinkat(
        Some(active.directory.as_raw_fd()),
        active.temp_name.as_str(),
        UnlinkatFlags::NoRemoveDir,
    );
    let _ = fsync(active.directory.as_raw_fd());
}

fn commit_no_clobber(directory: &OwnedFd, temp_name: &str, desired_name: &str) -> Result<String> {
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
        match linkat(
            Some(directory.as_raw_fd()),
            temp_name,
            Some(directory.as_raw_fd()),
            candidate.as_str(),
            nix::fcntl::AtFlags::empty(),
        ) {
            Ok(()) => {
                unlinkat(
                    Some(directory.as_raw_fd()),
                    temp_name,
                    UnlinkatFlags::NoRemoveDir,
                )
                .context("removing committed upload temporary link")?;
                fsync(directory.as_raw_fd()).context("syncing upload directory")?;
                return Ok(candidate);
            }
            Err(Errno::EEXIST) => continue,
            Err(error) => return Err(error).context("committing upload without clobber"),
        }
    }
    anyhow::bail!("could not choose a free upload filename")
}

fn open_capability_root(cwd: &str) -> Result<(PathBuf, OwnedFd)> {
    if cwd.is_empty() || cwd.len() > MAX_UPLOAD_PATH_BYTES {
        anyhow::bail!("agent cwd is outside upload path limits");
    }
    let path = Path::new(cwd);
    if !path.is_absolute() {
        anyhow::bail!("agent cwd is not an absolute capability root");
    }
    let mut current = owned_fd(open(
        Path::new("/"),
        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
        Mode::empty(),
    )?);
    let mut normalized = PathBuf::from("/");
    for component in path.components() {
        match component {
            Component::RootDir => continue,
            Component::Normal(name) if !name.is_empty() => {
                current = owned_fd(
                    openat(
                        Some(current.as_raw_fd()),
                        name,
                        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
                        Mode::empty(),
                    )
                    .context("opening agent cwd capability component")?,
                );
                normalized.push(name);
            }
            _ => anyhow::bail!("agent cwd contains an ambiguous component"),
        }
    }
    Ok((normalized, current))
}

fn open_or_create_private_dir(parent: &OwnedFd, name: &str) -> Result<OwnedFd> {
    validate_leaf_name(name)?;
    match mkdirat(
        Some(parent.as_raw_fd()),
        name,
        Mode::from_bits_truncate(0o700),
    ) {
        Ok(()) | Err(Errno::EEXIST) => {}
        Err(error) => return Err(error).context("creating private upload directory"),
    }
    let directory = openat(
        Some(parent.as_raw_fd()),
        name,
        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
        Mode::empty(),
    )
    .context("opening private upload directory without following links")?;
    let directory = owned_fd(directory);
    fchmod(directory.as_raw_fd(), Mode::from_bits_truncate(0o700))
        .context("enforcing private upload directory permissions")?;
    Ok(directory)
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
    Ok(())
}

fn owned_fd(raw: std::os::fd::RawFd) -> OwnedFd {
    unsafe { OwnedFd::from_raw_fd(raw) }
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
        agent: AgentBinding,
        session: &'a str,
        capability: Uuid,
        upload_id: Uuid,
        cwd: &'a str,
        bytes: &'a [u8],
        manifest: UploadManifest,
    }

    async fn complete(hub: &UploadHub, spec: CompleteUpload<'_>) -> UploadResult {
        let CompleteUpload {
            agent,
            session,
            capability,
            upload_id,
            cwd,
            bytes,
            manifest: upload_manifest,
        } = spec;
        assert!(matches!(
            hub.start(
                agent,
                session,
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
                    agent,
                    UploadChunkRequest {
                        session_id: session,
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
        let agent = AgentBinding::new(Uuid::new_v4(), 7);
        let capability = Uuid::new_v4();
        let upload_id = Uuid::new_v4();
        let result = complete(
            &hub,
            CompleteUpload {
                agent,
                session: "viewer",
                capability,
                upload_id,
                cwd: tmp.path().to_str().unwrap(),
                bytes: &bytes,
                manifest: upload_manifest.clone(),
            },
        )
        .await;
        assert_eq!(std::fs::read(&result.path).unwrap(), bytes);
        let mode = std::fs::metadata(&result.path).unwrap().permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(mode.mode() & 0o777, 0o600);
        }
        assert!(matches!(
            hub.start(
                agent,
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
    async fn concurrent_same_destination_commits_never_clobber() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("note.txt"), b"old").unwrap();
        let hub = UploadHub::default();
        let agent = AgentBinding::new(Uuid::new_v4(), 1);
        let first = complete(
            &hub,
            CompleteUpload {
                agent,
                session: "first",
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
                agent,
                session: "second",
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
        let agent = AgentBinding::new(Uuid::new_v4(), 2);
        let capability = Uuid::new_v4();
        let upload_id = Uuid::new_v4();
        let bytes = vec![9; UPLOAD_CHUNK_BYTES + 1];
        let upload_manifest = manifest(&bytes, "file.bin", UploadDestination::Cwd);
        hub.start(
            agent,
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
                agent,
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
                agent,
                UploadChunkRequest {
                    session_id: "viewer",
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
            agent,
            "viewer",
            capability,
            second_id,
            tmp.path().to_str().unwrap(),
            upload_manifest,
        )
        .await
        .unwrap();
        assert!(hub
            .cancel(agent, "viewer", capability, second_id)
            .await
            .unwrap());
        assert_eq!(hub.retained_counts().await, (0, 0));
    }

    #[tokio::test]
    async fn checksum_failure_and_session_teardown_leave_no_files() {
        let tmp = tempfile::tempdir().unwrap();
        let hub = UploadHub::default();
        let agent = AgentBinding::new(Uuid::new_v4(), 3);
        let capability = Uuid::new_v4();
        let upload_id = Uuid::new_v4();
        let mut bad_hash = manifest(b"actual", "note.txt", UploadDestination::Cwd);
        bad_hash.sha256 = "00".repeat(32);
        hub.start(
            agent,
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
                agent,
                UploadChunkRequest {
                    session_id: "viewer",
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

        for index in 0..MAX_ACTIVE_UPLOADS_PER_SESSION {
            hub.start(
                agent,
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
                agent,
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
        hub.cancel_session(agent, "viewer").await;
        assert_eq!(hub.retained_counts().await, (0, 0));
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn cancellation_and_final_commit_have_one_fail_closed_linearization() {
        let tmp = tempfile::tempdir().unwrap();
        let hub = UploadHub::default();
        let agent = AgentBinding::new(Uuid::new_v4(), 5);
        let capability = Uuid::new_v4();
        for index in 0..32 {
            let upload_id = Uuid::new_v4();
            let name = format!("race-{index}.txt");
            hub.start(
                agent,
                "viewer",
                capability,
                upload_id,
                tmp.path().to_str().unwrap(),
                manifest(b"x", &name, UploadDestination::Cwd),
            )
            .await
            .unwrap();
            let write = hub.write_chunk(
                agent,
                UploadChunkRequest {
                    session_id: "viewer",
                    capability,
                    upload_id,
                    sequence: 0,
                    last: true,
                    bytes: b"x",
                },
            );
            let cancel = hub.cancel(agent, "viewer", capability, upload_id);
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
                agent: AgentBinding::new(Uuid::new_v4(), 1),
                session: "viewer",
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
        let agent = AgentBinding::new(Uuid::new_v4(), 1);
        assert!(hub
            .start(
                agent,
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
                AgentBinding::new(Uuid::new_v4(), 1),
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
}
