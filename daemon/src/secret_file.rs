//! Putting a secret on disk, safely, once.
//!
//! Two programs in this product keep long-lived secrets in the user's own
//! files: the daemon (`creds.rs` — its token, its Ed25519 host seed, its
//! browser pins) and the macOS companion (`desktop/src-tauri/src/storage.rs` —
//! its session token and device seed). They keep very different *records*, and
//! nothing here knows or cares what those records contain. What they must not
//! differ on is the handling: the bytes are written atomically at mode 0600,
//! reread only from a regular file this user owns with no group or other bits,
//! opened `NOFOLLOW` so a swapped symlink cannot redirect it, and serialised
//! across processes by a lock file held for the whole read-modify-write.
//!
//! Every one of those is a thing that is easy to get subtly wrong and hard to
//! notice when you have: a non-atomic write loses the token on a crash between
//! truncate and flush, a missing parent-directory fsync loses the *rename* on
//! power loss, a forgotten `NOFOLLOW` lets anything that can create a file in
//! the directory choose what gets read, and a missing lock lets two processes
//! each write a whole record over the other's. One implementation of that is
//! worth more than two correct ones, because there is only one to audit and
//! only one place a fix has to land.
//!
//! The caller supplies the vocabulary — what to call the file in an error, what
//! to name its temporaries, how large it may be — so error text stays in the
//! voice of whichever program is reporting, and two programs sharing a
//! directory can never mistake one another's temporary files for their own.

use std::io::Read;
use std::path::Path;

use anyhow::{bail, Context, Result};
use uuid::Uuid;
use zeroize::Zeroize;

/// The handling rules for one kind of secret file.
#[derive(Debug, Clone, Copy)]
pub struct SecretFile {
    /// What to call this file in an error a person might read — "credential
    /// fallback", "desktop credential file". It is the subject of the sentence.
    noun: &'static str,
    /// Prefix for this file's temporaries, including the leading dot; the
    /// suffix is always a UUID and `.tmp`. Two programs writing into the same
    /// directory must not share it, or each will sweep the other's in-flight
    /// writes as stale.
    temp_prefix: &'static str,
    /// Refusal threshold. A secret record is small; anything larger is either
    /// corruption or someone filling a disk through us.
    max_bytes: usize,
}

impl SecretFile {
    pub const fn new(noun: &'static str, temp_prefix: &'static str, max_bytes: usize) -> Self {
        Self {
            noun,
            temp_prefix,
            max_bytes,
        }
    }

    pub const fn max_bytes(&self) -> usize {
        self.max_bytes
    }

    /// Read the file, or `Ok(None)` when it does not exist yet.
    ///
    /// Opened `NOFOLLOW` and validated *through the open descriptor*, so the
    /// thing checked and the thing read are the same inode — checking the path
    /// and then opening it is the classic race this avoids.
    #[cfg(unix)]
    pub fn read(&self, path: &Path) -> Result<Option<Vec<u8>>> {
        use rustix::fs::{Mode, OFlags};

        let fd = match rustix::fs::open(
            path,
            OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
        ) {
            Ok(fd) => fd,
            Err(error) if error == rustix::io::Errno::NOENT => return Ok(None),
            Err(error) => return Err(error).with_context(|| format!("opening {}", path.display())),
        };
        let mut file = std::fs::File::from(fd);
        let metadata = file
            .metadata()
            .with_context(|| format!("inspecting {}", path.display()))?;
        self.validate_metadata(path, &metadata, rustix::process::geteuid().as_raw())?;
        if metadata.len() > self.max_bytes as u64 {
            bail!("{} is too large: {}", self.noun, path.display())
        }
        let mut raw = Vec::with_capacity(metadata.len() as usize);
        let read_result = Read::by_ref(&mut file)
            .take((self.max_bytes + 1) as u64)
            .read_to_end(&mut raw)
            .with_context(|| format!("reading {}", path.display()));
        if let Err(error) = read_result {
            raw.zeroize();
            return Err(error);
        }
        if raw.len() > self.max_bytes {
            raw.zeroize();
            bail!("{} is too large: {}", self.noun, path.display())
        }
        Ok(Some(raw))
    }

    #[cfg(not(unix))]
    pub fn read(&self, path: &Path) -> Result<Option<Vec<u8>>> {
        let metadata = match std::fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(error).with_context(|| format!("inspecting {}", path.display()))
            }
        };
        if !metadata.is_file() {
            bail!("{} is not a regular file: {}", self.noun, path.display())
        }
        if metadata.len() > self.max_bytes as u64 {
            bail!("{} is too large: {}", self.noun, path.display())
        }
        let mut raw = Vec::with_capacity(metadata.len() as usize);
        let read_result = std::fs::File::open(path)?
            .take((self.max_bytes + 1) as u64)
            .read_to_end(&mut raw);
        if let Err(error) = read_result {
            raw.zeroize();
            return Err(error.into());
        }
        if raw.len() > self.max_bytes {
            raw.zeroize();
            bail!("{} is too large: {}", self.noun, path.display())
        }
        Ok(Some(raw))
    }

    /// A regular file, owned by this user, with nothing readable by anyone else.
    #[cfg(unix)]
    pub fn validate_metadata(
        &self,
        path: &Path,
        metadata: &std::fs::Metadata,
        expected_uid: u32,
    ) -> Result<()> {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        if !metadata.is_file() {
            bail!("{} is not a regular file: {}", self.noun, path.display())
        }
        if metadata.uid() != expected_uid {
            bail!(
                "{} is not owned by the current user: {}",
                self.noun,
                path.display()
            )
        }
        if metadata.permissions().mode() & 0o077 != 0 {
            bail!(
                "{} has group or other permissions: {}",
                self.noun,
                path.display()
            )
        }
        Ok(())
    }

    #[cfg(not(unix))]
    pub fn validate_metadata(
        &self,
        path: &Path,
        metadata: &std::fs::Metadata,
        _expected_uid: u32,
    ) -> Result<()> {
        if !metadata.is_file() {
            bail!("{} is not a regular file: {}", self.noun, path.display())
        }
        Ok(())
    }

    /// Replace the file's contents atomically.
    pub fn write(&self, path: &Path, data: &[u8]) -> std::io::Result<()> {
        self.write_with_parent_sync(path, data, sync_parent_directory)
    }

    /// The testable form: the directory flush is injected so a test can prove
    /// what happens when the *rename succeeded but the flush did not*, which is
    /// the one failure that leaves correct contents and an unreported risk.
    pub fn write_with_parent_sync<S>(
        &self,
        path: &Path,
        data: &[u8],
        sync_parent: S,
    ) -> std::io::Result<()>
    where
        S: Fn(&Path) -> std::io::Result<()>,
    {
        // Write atomically: unique temp file in the same directory, then durable replace.
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        let mut tmp = parent.to_path_buf();
        tmp.push(format!("{}{}.tmp", self.temp_prefix, Uuid::new_v4()));
        let result = (|| {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut f = options.open(&tmp)?;
            std::io::Write::write_all(&mut f, data)?;
            f.sync_all()?;
            durable_replace(&tmp, path)?;
            sync_parent(parent)?;
            Ok(())
        })();
        if result.is_err() {
            match std::fs::remove_file(&tmp) {
                Ok(()) => {
                    let _ = sync_parent_directory(parent);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(std::io::Error::other(format!(
                        "secret write failed and temporary cleanup also failed: {error}"
                    )))
                }
            }
        }
        result
    }

    /// Remove temporaries this writer left behind after a crash.
    ///
    /// Only ones matching this file's own prefix, parseable as a canonical
    /// UUID, owned by us and still exactly 0600: anything else in the directory
    /// belongs to somebody else and is none of our business to delete.
    pub fn cleanup_stale_temporaries(&self, path: &Path) -> Result<()> {
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        let mut removed = false;
        for entry in std::fs::read_dir(parent)
            .with_context(|| format!("enumerating {}", parent.display()))?
        {
            let entry = entry.with_context(|| format!("reading {}", parent.display()))?;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let Some(record_id) = name
                .strip_prefix(self.temp_prefix)
                .and_then(|name| name.strip_suffix(".tmp"))
            else {
                continue;
            };
            let Ok(parsed) = Uuid::parse_str(record_id) else {
                continue;
            };
            if parsed.to_string() != record_id {
                continue;
            }
            let path = entry.path();
            let metadata = match std::fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(error).with_context(|| format!("inspecting {}", path.display()))
                }
            };
            if !metadata.file_type().is_file() {
                continue;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::{MetadataExt, PermissionsExt};
                if metadata.uid() != rustix::process::geteuid().as_raw()
                    || metadata.permissions().mode() & 0o777 != 0o600
                {
                    continue;
                }
            }
            std::fs::remove_file(&path)
                .with_context(|| format!("removing stale temporary {}", path.display()))?;
            removed = true;
        }
        if removed {
            sync_parent_directory(parent)
                .with_context(|| format!("syncing {}", parent.display()))?;
        }
        Ok(())
    }

    /// Hold `path` as a cross-process lock for the whole of `operation`.
    ///
    /// The lock file is a separate path from the secret, because the secret is
    /// replaced by rename and a lock on a replaced inode protects nothing.
    pub fn lock<T>(&self, path: &Path, operation: impl FnOnce() -> Result<T>) -> Result<T> {
        let file = self.open_lock(path)?;
        file.lock()
            .with_context(|| format!("locking {}", path.display()))?;
        let outcome = operation();
        let unlock = file
            .unlock()
            .with_context(|| format!("unlocking {}", path.display()));
        drop(file);
        match outcome {
            Ok(value) => {
                unlock?;
                Ok(value)
            }
            Err(error) => {
                // Closing the file releases the OS lock even if explicit unlock
                // itself failed; preserve the operation error as the primary cause.
                let _ = unlock;
                Err(error)
            }
        }
    }

    #[cfg(unix)]
    fn open_lock(&self, path: &Path) -> Result<std::fs::File> {
        use rustix::fs::{Mode, OFlags};

        let fd = rustix::fs::open(
            path,
            OFlags::RDWR | OFlags::CREATE | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::RUSR | Mode::WUSR,
        )
        .with_context(|| format!("opening lock {}", path.display()))?;
        let file = std::fs::File::from(fd);
        let metadata = file
            .metadata()
            .with_context(|| format!("inspecting lock {}", path.display()))?;
        self.validate_metadata(path, &metadata, rustix::process::geteuid().as_raw())?;
        Ok(file)
    }

    #[cfg(not(unix))]
    fn open_lock(&self, path: &Path) -> Result<std::fs::File> {
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(path)
            .with_context(|| format!("opening lock {}", path.display()))
    }
}

/// Flush the directory entry itself, so the rename survives power loss.
pub fn sync_parent_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::fs::File::open(path)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        // The Windows replacement primitive below requests write-through. Some
        // other platforms cannot open directories as files, so there is no
        // additional portable directory handle to flush here.
        let _ = path;
        Ok(())
    }
}

#[cfg(not(windows))]
fn durable_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::rename(from, to)
}

#[cfg(windows)]
fn durable_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: both inputs are stable, NUL-terminated UTF-16 buffers for the
    // duration of the call. Flags request atomic replacement and write-through.
    let replaced = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: SecretFile = SecretFile::new("test secret", ".test-secret.", 1024);

    #[test]
    fn a_written_secret_reads_back_and_nobody_else_can_open_it() {
        let temporary = tempfile::tempdir().expect("temp dir");
        let path = temporary.path().join("secret.json");
        assert!(FIXTURE
            .read(&path)
            .expect("absent is not an error")
            .is_none());

        FIXTURE.write(&path, b"{\"token\":\"x\"}").expect("write");
        assert_eq!(
            FIXTURE.read(&path).expect("read").as_deref(),
            Some(&b"{\"token\":\"x\"}"[..])
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).expect("stat").permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "group and other must have nothing");
        }
    }

    #[test]
    fn replacing_a_secret_leaves_no_temporary_behind() {
        let temporary = tempfile::tempdir().expect("temp dir");
        let path = temporary.path().join("secret.json");
        FIXTURE.write(&path, b"first").expect("write");
        FIXTURE.write(&path, b"second").expect("replace");
        assert_eq!(
            FIXTURE.read(&path).expect("read").as_deref(),
            Some(&b"second"[..])
        );
        let leftovers: Vec<_> = std::fs::read_dir(temporary.path())
            .expect("read dir")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "left behind {leftovers:?}");
    }

    #[test]
    fn a_failed_directory_flush_is_reported_but_the_contents_still_land() {
        use std::cell::Cell;

        let temporary = tempfile::tempdir().expect("temp dir");
        let path = temporary.path().join("secret.json");
        std::fs::write(&path, b"old").expect("seed");
        let synced = Cell::new(false);
        let error = FIXTURE
            .write_with_parent_sync(&path, b"new", |_| {
                synced.set(true);
                Err(std::io::Error::other("injected directory sync failure"))
            })
            .expect_err("the flush failure must surface");
        assert!(synced.get());
        assert!(error
            .to_string()
            .contains("injected directory sync failure"));
        // The rename already happened; silently reporting success would be a
        // lie, and silently reverting would lose a secret that is on disk.
        assert_eq!(std::fs::read(&path).expect("read"), b"new");
    }

    #[test]
    fn a_secret_larger_than_its_bound_is_refused_rather_than_loaded() {
        let temporary = tempfile::tempdir().expect("temp dir");
        let path = temporary.path().join("secret.json");
        FIXTURE
            .write(&path, &vec![b'x'; FIXTURE.max_bytes() + 1])
            .expect("write");
        let error = FIXTURE.read(&path).expect_err("oversize must be refused");
        assert!(format!("{error:#}").contains("too large"));
    }

    #[cfg(unix)]
    #[test]
    fn group_or_other_permissions_disqualify_a_secret() {
        use std::os::unix::fs::PermissionsExt;

        let temporary = tempfile::tempdir().expect("temp dir");
        let path = temporary.path().join("secret.json");
        FIXTURE.write(&path, b"secret").expect("write");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).expect("chmod");
        let error = FIXTURE
            .read(&path)
            .expect_err("group-readable must be refused");
        assert!(format!("{error:#}").contains("group or other permissions"));
    }

    #[cfg(unix)]
    #[test]
    fn a_secret_owned_by_someone_else_is_refused() {
        use std::os::unix::fs::MetadataExt;

        let temporary = tempfile::tempdir().expect("temp dir");
        let path = temporary.path().join("secret.json");
        FIXTURE.write(&path, b"secret").expect("write");
        let metadata = std::fs::metadata(&path).expect("stat");
        let error = FIXTURE
            .validate_metadata(&path, &metadata, metadata.uid().wrapping_add(1))
            .expect_err("wrong owner must be refused");
        assert!(format!("{error:#}").contains("not owned by the current user"));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_is_never_followed_to_a_secret() {
        let temporary = tempfile::tempdir().expect("temp dir");
        let real = temporary.path().join("real.json");
        FIXTURE.write(&real, b"secret").expect("write");
        let link = temporary.path().join("link.json");
        std::os::unix::fs::symlink(&real, &link).expect("symlink");
        assert!(
            FIXTURE.read(&link).is_err(),
            "reading through a symlink lets whoever made it choose the file"
        );
    }

    #[test]
    fn only_this_writers_own_stale_temporaries_are_swept() {
        let temporary = tempfile::tempdir().expect("temp dir");
        let path = temporary.path().join("secret.json");
        FIXTURE.write(&path, b"secret").expect("write");

        let mine = temporary
            .path()
            .join(format!(".test-secret.{}.tmp", Uuid::new_v4()));
        let someone_elses = temporary
            .path()
            .join(format!(".credentials.{}.tmp", Uuid::new_v4()));
        let not_a_uuid = temporary.path().join(".test-secret.not-a-uuid.tmp");
        for leftover in [&mine, &someone_elses, &not_a_uuid] {
            FIXTURE.write(leftover, b"partial").expect("stage leftover");
        }

        FIXTURE.cleanup_stale_temporaries(&path).expect("cleanup");
        assert!(!mine.exists(), "our own stale temporary should be gone");
        assert!(
            someone_elses.exists(),
            "another writer's file is not ours to delete"
        );
        assert!(
            not_a_uuid.exists(),
            "only canonical UUID temporaries are ours"
        );
        assert!(path.exists(), "the secret itself is never swept");
    }

    #[test]
    fn the_lock_serialises_and_returns_the_operations_value() {
        let temporary = tempfile::tempdir().expect("temp dir");
        let lock = temporary.path().join(".secret.lock");
        assert_eq!(FIXTURE.lock(&lock, || Ok(7_u8)).expect("locked"), 7);
        // A failing operation still releases the lock, so the next caller is
        // not wedged behind it for the life of the process.
        assert!(FIXTURE
            .lock(&lock, || -> Result<()> { bail!("inner failure") })
            .is_err());
        assert_eq!(FIXTURE.lock(&lock, || Ok(8_u8)).expect("relocked"), 8);
    }
}
