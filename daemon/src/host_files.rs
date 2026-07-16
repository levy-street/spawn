//! Endpoint-only host filesystem operations for `spawn.host.ctl`.
//!
//! The signaling websocket must never receive values produced by this module.
//! Paths are confined to the daemon user's home directory, `..` is rejected
//! instead of normalized, and symlinks are not followed. This deliberately
//! trades broad machine browsing for an auditable endpoint boundary.

use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::fs::{self, File, OpenOptions};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

pub const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;
pub const STREAM_CHUNK_BYTES: usize = 8 * 1024;
pub const MAX_LIST_ENTRIES_PER_PAGE: usize = 96;

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
    root: PathBuf,
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
    pub destination: PathBuf,
    pub temporary: PathBuf,
    pub file: File,
    pub expected_length: u64,
    pub expected_sha256: String,
    pub overwrite: bool,
    pub received: u64,
    pub next_sequence: u64,
    pub hasher: Sha256,
    last_activity: Instant,
}

impl HostFileService {
    pub async fn discover() -> FsResult<Self> {
        let configured = dirs::home_dir()
            .or_else(|| std::env::current_dir().ok())
            .ok_or_else(|| FsError::new("home_unavailable", "home directory is unavailable"))?;
        let root = fs::canonicalize(configured).await?;
        Ok(Self { root })
    }

    #[cfg(test)]
    pub async fn rooted_at(root: &Path) -> FsResult<Self> {
        Ok(Self {
            root: fs::canonicalize(root).await?,
        })
    }

    pub fn home_dir(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }

    fn lexical_path(&self, input: &str) -> FsResult<PathBuf> {
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
                path.strip_prefix(&self.root)
                    .map(Path::to_path_buf)
                    .map_err(|_| FsError::new("outside_root", "path is outside the home root"))?
            } else {
                path.to_path_buf()
            }
        };
        if relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return Err(FsError::new(
                "traversal_rejected",
                "parent traversal is not allowed",
            ));
        }
        Ok(self.root.join(relative))
    }

    async fn reject_symlink_prefixes(&self, target: &Path, allow_missing: bool) -> FsResult<()> {
        let relative = target
            .strip_prefix(&self.root)
            .map_err(|_| FsError::new("outside_root", "path is outside the home root"))?;
        let mut current = self.root.clone();
        for component in relative.components() {
            current.push(component.as_os_str());
            match fs::symlink_metadata(&current).await {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return Err(FsError::new(
                        "symlink_rejected",
                        "symbolic links are not followed",
                    ));
                }
                Ok(_) => {}
                Err(error) if allow_missing && error.kind() == std::io::ErrorKind::NotFound => {
                    break;
                }
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    async fn existing_path(&self, input: &str) -> FsResult<PathBuf> {
        let target = self.lexical_path(input)?;
        self.reject_symlink_prefixes(&target, false).await?;
        Ok(target)
    }

    async fn new_path(&self, input: &str) -> FsResult<PathBuf> {
        let target = self.lexical_path(input)?;
        self.reject_symlink_prefixes(&target, true).await?;
        Ok(target)
    }

    pub async fn list(&self, input: &str, cursor: usize) -> FsResult<DirectoryPage> {
        let target = self.existing_path(input).await?;
        let metadata = fs::symlink_metadata(&target).await?;
        if !metadata.is_dir() {
            return Err(FsError::new("not_directory", "path is not a directory"));
        }
        let mut reader = fs::read_dir(&target).await?;
        let mut entries = Vec::new();
        while let Some(entry) = reader.next_entry().await? {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == "." || name == ".." {
                continue;
            }
            let metadata = fs::symlink_metadata(entry.path()).await?;
            let file_type = metadata.file_type();
            let (kind, is_dir) = if file_type.is_symlink() {
                ("symlink", false)
            } else if metadata.is_dir() {
                ("directory", true)
            } else if metadata.is_file() {
                ("file", false)
            } else {
                ("other", false)
            };
            entries.push(DirEntry {
                name,
                path: entry.path().to_string_lossy().into_owned(),
                kind,
                is_dir,
                size: metadata.is_file().then_some(metadata.len()),
                modified_at: metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .and_then(|duration| i64::try_from(duration.as_secs()).ok()),
            });
        }
        entries.sort_by(|left, right| {
            right
                .is_dir
                .cmp(&left.is_dir)
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
                .then_with(|| left.name.cmp(&right.name))
        });
        if cursor > entries.len() {
            return Err(FsError::new("invalid_cursor", "directory cursor is stale"));
        }
        let end = entries
            .len()
            .min(cursor.saturating_add(MAX_LIST_ENTRIES_PER_PAGE));
        let next_cursor = (end < entries.len()).then_some(end);
        let entries = entries.drain(cursor..end).collect();
        Ok(DirectoryPage {
            path: target.to_string_lossy().into_owned(),
            home_dir: self.home_dir(),
            parent: (target != self.root)
                .then(|| target.parent())
                .flatten()
                .map(|path| path.to_string_lossy().into_owned()),
            entries,
            next_cursor,
        })
    }

    pub async fn stat(&self, input: &str) -> FsResult<FileStat> {
        let target = self.existing_path(input).await?;
        let metadata = fs::symlink_metadata(&target).await?;
        let kind = if metadata.is_dir() {
            "directory"
        } else if metadata.is_file() {
            "file"
        } else {
            "other"
        };
        Ok(FileStat {
            path: target.to_string_lossy().into_owned(),
            name: target
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "file".to_string()),
            kind,
            size: metadata.len(),
            modified_at: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .and_then(|duration| i64::try_from(duration.as_secs()).ok()),
        })
    }

    #[cfg(test)]
    pub async fn open_read(&self, input: &str) -> FsResult<ReadStream> {
        let cancelled = AtomicBool::new(false);
        self.open_read_cancellable(input, &cancelled).await
    }

    pub async fn open_read_cancellable(
        &self,
        input: &str,
        cancelled: &AtomicBool,
    ) -> FsResult<ReadStream> {
        let stat = self.stat(input).await?;
        if stat.kind != "file" {
            return Err(FsError::new("not_file", "path is not a regular file"));
        }
        if stat.size > MAX_FILE_BYTES {
            return Err(FsError::new(
                "file_too_large",
                "file exceeds the stream limit",
            ));
        }
        let target = PathBuf::from(&stat.path);
        let mut hash_file = File::open(&target).await?;
        let mut buffer = vec![0_u8; 64 * 1024];
        let mut hasher = Sha256::new();
        let mut length = 0_u64;
        loop {
            if cancelled.load(Ordering::Acquire) {
                return Err(FsError::new("cancelled", "file read was cancelled"));
            }
            let read = hash_file.read(&mut buffer).await?;
            if read == 0 {
                break;
            }
            length = length.saturating_add(read as u64);
            if length > stat.size || length > MAX_FILE_BYTES {
                return Err(FsError::new("file_changed", "file changed while hashing"));
            }
            hasher.update(&buffer[..read]);
        }
        if length != stat.size {
            return Err(FsError::new("file_changed", "file changed while hashing"));
        }
        Ok(ReadStream {
            stat,
            sha256: format!("{:x}", hasher.finalize()),
            file: File::open(target).await?,
        })
    }

    pub async fn mkdir(&self, input: &str) -> FsResult<String> {
        let target = self.new_path(input).await?;
        fs::create_dir_all(&target).await?;
        self.reject_symlink_prefixes(&target, false).await?;
        Ok(target.to_string_lossy().into_owned())
    }

    pub async fn rename(&self, input: &str, name: &str, overwrite: bool) -> FsResult<String> {
        validate_name(name)?;
        let source = self.existing_path(input).await?;
        if source == self.root {
            return Err(FsError::new(
                "root_protected",
                "home root cannot be renamed",
            ));
        }
        let destination = source
            .parent()
            .ok_or_else(|| FsError::new("invalid_path", "source has no parent"))?
            .join(name);
        self.reject_symlink_prefixes(&destination, true).await?;
        if !overwrite && fs::try_exists(&destination).await? {
            return Err(FsError::new("already_exists", "destination already exists"));
        }
        fs::rename(&source, &destination).await?;
        Ok(destination.to_string_lossy().into_owned())
    }

    pub async fn remove(&self, input: &str, recursive: bool) -> FsResult<String> {
        let target = self.existing_path(input).await?;
        if target == self.root {
            return Err(FsError::new(
                "root_protected",
                "home root cannot be removed",
            ));
        }
        let metadata = fs::symlink_metadata(&target).await?;
        if metadata.is_dir() {
            if recursive {
                fs::remove_dir_all(&target).await?;
            } else {
                fs::remove_dir(&target).await?;
            }
        } else {
            fs::remove_file(&target).await?;
        }
        Ok(target.to_string_lossy().into_owned())
    }

    pub async fn begin_write(
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
        let directory = self.existing_path(dir).await?;
        if !fs::symlink_metadata(&directory).await?.is_dir() {
            return Err(FsError::new(
                "not_directory",
                "destination is not a directory",
            ));
        }
        let destination = directory.join(name);
        self.reject_symlink_prefixes(&destination, true).await?;
        if !overwrite && fs::try_exists(&destination).await? {
            return Err(FsError::new("already_exists", "destination already exists"));
        }
        let stream_id = Uuid::new_v4().to_string();
        let temporary = directory.join(format!(".spawn-upload-{stream_id}.tmp"));
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .await?;
        Ok(PendingWrite {
            stream_id,
            request_id,
            destination,
            temporary,
            file,
            expected_length,
            expected_sha256: expected_sha256.to_ascii_lowercase(),
            overwrite,
            received: 0,
            next_sequence: 0,
            hasher: Sha256::new(),
            last_activity: Instant::now(),
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
        self.file.write_all(bytes).await?;
        self.hasher.update(bytes);
        self.received = received;
        self.next_sequence = self.next_sequence.saturating_add(1);
        self.last_activity = Instant::now();
        Ok(())
    }

    pub fn idle_for(&self) -> Duration {
        self.last_activity.elapsed()
    }

    pub async fn finish(self) -> FsResult<String> {
        let PendingWrite {
            destination,
            temporary,
            mut file,
            expected_length,
            expected_sha256,
            overwrite,
            received,
            mut hasher,
            ..
        } = self;
        if received != expected_length {
            drop(file);
            let _ = fs::remove_file(&temporary).await;
            return Err(FsError::new(
                "length_mismatch",
                "stream length does not match declaration",
            ));
        }
        let actual = format!("{:x}", hasher.finalize_reset());
        if actual != expected_sha256 {
            drop(file);
            let _ = fs::remove_file(&temporary).await;
            return Err(FsError::new(
                "hash_mismatch",
                "stream SHA-256 does not match declaration",
            ));
        }
        for result in [file.flush().await, file.sync_all().await] {
            if let Err(error) = result {
                drop(file);
                let _ = fs::remove_file(&temporary).await;
                return Err(error.into());
            }
        }
        drop(file);
        if overwrite {
            #[cfg(windows)]
            if fs::try_exists(&destination).await? {
                let _ = fs::remove_file(&temporary).await;
                return Err(FsError::new(
                    "atomic_overwrite_unsupported",
                    "atomic replacement of an existing file is unavailable on this platform",
                ));
            }
            if let Err(error) = fs::rename(&temporary, &destination).await {
                let _ = fs::remove_file(&temporary).await;
                return Err(error.into());
            }
        } else {
            // Linking into the final name is an atomic create-if-absent. A
            // check followed by rename would clobber a destination created in
            // the race window on Unix even when overwrite=false.
            if let Err(error) = fs::hard_link(&temporary, &destination).await {
                let _ = fs::remove_file(&temporary).await;
                return Err(error.into());
            }
            if let Err(error) = fs::remove_file(&temporary).await {
                let _ = fs::remove_file(&destination).await;
                return Err(error.into());
            }
        }
        if let Some(parent) = destination.parent() {
            if let Ok(directory) = File::open(parent).await {
                let _ = directory.sync_all().await;
            }
        }
        Ok(destination.to_string_lossy().into_owned())
    }

    pub async fn abort(self) {
        let PendingWrite {
            temporary,
            mut file,
            ..
        } = self;
        let _ = file.flush().await;
        drop(file);
        let _ = fs::remove_file(&temporary).await;
    }
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

    #[tokio::test]
    async fn confines_paths_and_rejects_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("safe")).await.unwrap();
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
    async fn atomic_write_verifies_length_and_hash() {
        let temp = tempfile::tempdir().unwrap();
        let service = HostFileService::rooted_at(temp.path()).await.unwrap();
        let expected = format!("{:x}", Sha256::digest(b"hello"));
        let mut write = service
            .begin_write("req".into(), "~", "hello.txt", 5, &expected, false)
            .await
            .unwrap();
        write.append(0, b"hello").await.unwrap();
        let path = write.finish().await.unwrap();
        assert_eq!(fs::read(path).await.unwrap(), b"hello");

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

        let mut corrupt = service
            .begin_write("corrupt".into(), "~", "corrupt.txt", 5, &expected, false)
            .await
            .unwrap();
        corrupt.append(0, b"HELLO").await.unwrap();
        assert_eq!(corrupt.finish().await.unwrap_err().code, "hash_mismatch");
        assert!(!temp.path().join("corrupt.txt").exists());
    }

    #[tokio::test]
    async fn lists_reads_renames_and_removes_without_following_metadata_paths() {
        let temp = tempfile::tempdir().unwrap();
        for index in 0..100 {
            fs::write(temp.path().join(format!("file-{index:03}.txt")), b"body")
                .await
                .unwrap();
        }
        fs::create_dir(temp.path().join("folder")).await.unwrap();
        let service = HostFileService::rooted_at(temp.path()).await.unwrap();
        let first = service.list("~", 0).await.unwrap();
        assert_eq!(first.entries.len(), MAX_LIST_ENTRIES_PER_PAGE);
        assert_eq!(first.next_cursor, Some(MAX_LIST_ENTRIES_PER_PAGE));
        assert!(first.entries[0].is_dir);
        let second = service.list("~", first.next_cursor.unwrap()).await.unwrap();
        assert_eq!(first.entries.len() + second.entries.len(), 101);

        let mut read = service.open_read("file-000.txt").await.unwrap();
        let mut bytes = Vec::new();
        read.file.read_to_end(&mut bytes).await.unwrap();
        assert_eq!(bytes, b"body");
        assert_eq!(read.sha256, format!("{:x}", Sha256::digest(b"body")));

        let renamed = service
            .rename("file-000.txt", "renamed.txt", false)
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
}
