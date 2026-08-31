use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use url::Url;

use super::{
    Preconditions, UpdateFailure, UpdateStage, DOWNLOAD_TIMEOUT, MAX_DOWNLOAD_BYTES,
    VERSION_TIMEOUT,
};

pub(super) fn target_for(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("macos", "aarch64") => Some("darwin-aarch64"),
        ("macos", "x86_64") => Some("darwin-x86_64"),
        ("linux", "aarch64") => Some("linux-aarch64"),
        ("linux", "x86_64") => Some("linux-x86_64"),
        ("windows", "x86_64") => Some("windows-x86_64"),
        _ => None,
    }
}

pub(super) fn resolve_file(path: PathBuf) -> Option<PathBuf> {
    let resolved = fs::canonicalize(path).ok()?;
    resolved.is_file().then_some(resolved)
}

pub(super) fn resolve_program(path: PathBuf) -> Option<PathBuf> {
    crate::platform::resolve_program(&path).map(|resolved| resolved.path)
}

pub(super) fn probe_writable(directory: &Path) -> bool {
    let probe = directory.join(format!(
        ".spawnd-update-probe.{}.{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
    {
        Ok(file) => {
            drop(file);
            fs::remove_file(probe).is_ok()
        }
        Err(_) => false,
    }
}

pub(super) fn clean_tree(tree: &str) -> bool {
    tree.len() == 40 && tree.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) fn join_install_url(server: &Url, path: &str) -> Result<Url, UpdateFailure> {
    if !matches!(server.scheme(), "http" | "https")
        || !path.starts_with("/api/install/")
        || path.contains(['?', '#', '\\'])
        || Url::parse(path).is_ok()
    {
        return Err(UpdateFailure::new(UpdateStage::Download, "invalid_path"));
    }
    let mut origin = server.clone();
    origin.set_path("/");
    origin.set_query(None);
    origin.set_fragment(None);
    let joined = origin
        .join(path)
        .map_err(|_| UpdateFailure::new(UpdateStage::Download, "invalid_path"))?;
    if joined.origin() != origin.origin() || !joined.path().starts_with("/api/install/") {
        return Err(UpdateFailure::new(UpdateStage::Download, "invalid_path"));
    }
    Ok(joined)
}

pub(super) fn http_client() -> Result<reqwest::Client, UpdateFailure> {
    reqwest::Client::builder()
        .timeout(DOWNLOAD_TIMEOUT)
        .build()
        .map_err(|_| UpdateFailure::new(UpdateStage::Download, "client_failed"))
}

pub(super) async fn download_to(
    client: &reqwest::Client,
    url: Url,
    path: &Path,
) -> Result<String, UpdateFailure> {
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| UpdateFailure::new(UpdateStage::Download, "request_failed"))?;
    if !response.status().is_success() {
        return Err(UpdateFailure::new(UpdateStage::Download, "http_status"));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_DOWNLOAD_BYTES)
    {
        return Err(UpdateFailure::new(UpdateStage::Download, "too_large"));
    }
    let mut file = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .await
        .map_err(|_| UpdateFailure::new(UpdateStage::Download, "write_failed"))?;
    let mut size = 0u64;
    let mut digest = Sha256::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| UpdateFailure::new(UpdateStage::Download, "request_failed"))?
    {
        size = size.saturating_add(chunk.len() as u64);
        if size > MAX_DOWNLOAD_BYTES {
            return Err(UpdateFailure::new(UpdateStage::Download, "too_large"));
        }
        digest.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|_| UpdateFailure::new(UpdateStage::Download, "write_failed"))?;
    }
    file.flush()
        .await
        .map_err(|_| UpdateFailure::new(UpdateStage::Download, "write_failed"))?;
    file.sync_all()
        .await
        .map_err(|_| UpdateFailure::new(UpdateStage::Download, "write_failed"))?;
    Ok(digest_hex(&digest.finalize()))
}

pub(super) fn digest_hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

pub(super) fn valid_sha256(expected: &str) -> bool {
    expected.len() == 64 && expected.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
pub(super) fn sha_matches(bytes: &[u8], expected: &str) -> bool {
    valid_sha256(expected) && digest_hex(&Sha256::digest(bytes)).eq_ignore_ascii_case(expected)
}

pub(super) fn chmod_executable(path: &Path) -> Result<(), UpdateFailure> {
    crate::platform::set_executable(path)
        .map_err(|_| UpdateFailure::new(UpdateStage::Verify, "chmod_failed"))
}

pub(super) async fn verify_version(path: &Path, expected: &str) -> Result<(), UpdateFailure> {
    if expected.is_empty() || expected.len() > 128 {
        return Err(UpdateFailure::new(UpdateStage::Verify, "invalid_version"));
    }
    let mut command = tokio::process::Command::new(path);
    command.arg("--version").kill_on_drop(true);
    let output = tokio::time::timeout(VERSION_TIMEOUT, command.output())
        .await
        .map_err(|_| UpdateFailure::new(UpdateStage::Verify, "version_timeout"))?
        .map_err(|_| UpdateFailure::new(UpdateStage::Verify, "version_check_failed"))?;
    let stdout = std::str::from_utf8(&output.stdout)
        .map_err(|_| UpdateFailure::new(UpdateStage::Verify, "version_check_failed"))?;
    if !output.status.success() || !stdout.trim_end().ends_with(expected) {
        return Err(UpdateFailure::new(UpdateStage::Verify, "version_mismatch"));
    }
    Ok(())
}

pub(super) struct TempFiles {
    pub(super) daemon: PathBuf,
    pub(super) worker: PathBuf,
}

impl TempFiles {
    pub(super) fn new(preconditions: &Preconditions) -> Result<Self, UpdateFailure> {
        let pid = std::process::id();
        let daemon =
            crate::platform::executable_variant(&preconditions.daemon_path, &format!("tmp.{pid}"))
                .map_err(|_| UpdateFailure::new(UpdateStage::Precondition, "unwritable"))?;
        let worker =
            crate::platform::executable_variant(&preconditions.worker_path, &format!("tmp.{pid}"))
                .map_err(|_| UpdateFailure::new(UpdateStage::Precondition, "unwritable"))?;
        Ok(Self { daemon, worker })
    }
}

impl Drop for TempFiles {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.daemon);
        let _ = fs::remove_file(&self.worker);
    }
}

pub(super) fn previous_path(live: &Path) -> PathBuf {
    crate::platform::executable_variant(live, "prev")
        .expect("installed binary path must have a file name and target suffix")
}

pub(super) fn swap_one(live: &Path, temporary: &Path) -> std::io::Result<()> {
    let previous = previous_path(live);
    if previous.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "previous binary still exists",
        ));
    }
    crate::platform::rename_noreplace(live, &previous)?;
    if let Err(error) = crate::platform::rename_noreplace(temporary, live) {
        let _ = crate::platform::rename_noreplace(&previous, live);
        return Err(error);
    }
    Ok(())
}

fn rollback_swapped(live: &Path, temporary: &Path) {
    let previous = previous_path(live);
    if crate::platform::rename_noreplace(live, temporary).is_ok() {
        let _ = crate::platform::rename_noreplace(&previous, live);
    }
}

pub(super) fn swap_binaries(
    daemon: &Path,
    daemon_temporary: &Path,
    worker: &Path,
    worker_temporary: &Path,
) -> Result<(), UpdateFailure> {
    swap_one(daemon, daemon_temporary)
        .map_err(|_| UpdateFailure::new(UpdateStage::Swap, "swap_failed"))?;
    if swap_one(worker, worker_temporary).is_err() {
        rollback_swapped(daemon, daemon_temporary);
        return Err(UpdateFailure::new(UpdateStage::Swap, "swap_failed"));
    }
    // Both renames are atomic but not yet durable. Commit the directory
    // entries so a power loss here cannot leave the pair torn — one binary
    // swapped and the other's `.prev` half-published — which is the exact
    // state that later refuses a repair with `swap_failed`.
    let _ = crate::platform::sync_parent_dir(daemon);
    if worker.parent() != daemon.parent() {
        let _ = crate::platform::sync_parent_dir(worker);
    }
    Ok(())
}

/// Restore the complete previous daemon/worker pair. Both backups are checked
/// before the first rename, and every partial step is rolled back on failure.
pub(super) fn revert_binaries(daemon: &Path, worker: &Path) -> std::io::Result<()> {
    let daemon_previous = previous_path(daemon);
    let worker_previous = previous_path(worker);
    if !daemon_previous.is_file() || !worker_previous.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "complete previous daemon pair is unavailable",
        ));
    }
    let daemon_failed =
        crate::platform::executable_variant(daemon, &format!("failed.{}", std::process::id()))?;
    let worker_failed =
        crate::platform::executable_variant(worker, &format!("failed.{}", std::process::id()))?;
    if daemon_failed.exists() || worker_failed.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "health-revert temporary already exists",
        ));
    }

    crate::platform::rename_noreplace(daemon, &daemon_failed)?;
    if let Err(error) = crate::platform::rename_noreplace(&daemon_previous, daemon) {
        let _ = crate::platform::rename_noreplace(&daemon_failed, daemon);
        return Err(error);
    }
    if let Err(error) = crate::platform::rename_noreplace(worker, &worker_failed) {
        let _ = crate::platform::rename_noreplace(daemon, &daemon_previous);
        let _ = crate::platform::rename_noreplace(&daemon_failed, daemon);
        return Err(error);
    }
    if let Err(error) = crate::platform::rename_noreplace(&worker_previous, worker) {
        let _ = crate::platform::rename_noreplace(&worker_failed, worker);
        let _ = crate::platform::rename_noreplace(daemon, &daemon_previous);
        let _ = crate::platform::rename_noreplace(&daemon_failed, daemon);
        return Err(error);
    }

    #[cfg(not(windows))]
    {
        let _ = fs::remove_file(daemon_failed);
        let _ = fs::remove_file(worker_failed);
    }
    #[cfg(windows)]
    {
        // The failed daemon image is still mapped by this process. The
        // replacement removes both suffix-preserving failed images after it
        // registers successfully.
        let _ = (daemon_failed, worker_failed);
    }
    Ok(())
}
