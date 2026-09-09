use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use url::Url;

use super::{UpdateFailure, UpdateStage, DOWNLOAD_TIMEOUT, MAX_DOWNLOAD_BYTES, VERSION_TIMEOUT};

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

/// A scratch directory under the store's `releases/`, so the published copy
/// is one rename away on the same filesystem. Removed on drop: after a
/// successful publish the files have been copied out of it, and after any
/// failure nothing of it should remain.
pub(super) struct StagingDir {
    pub(super) dir: PathBuf,
    pub(super) daemon: PathBuf,
    pub(super) worker: PathBuf,
}

impl StagingDir {
    pub(super) fn new(layout: &crate::install::Layout) -> Result<Self, UpdateFailure> {
        let releases = layout.releases_dir();
        fs::create_dir_all(&releases)
            .map_err(|_| UpdateFailure::new(UpdateStage::Precondition, "unwritable"))?;
        let dir = releases.join(format!(
            ".staging-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir(&dir)
            .map_err(|_| UpdateFailure::new(UpdateStage::Precondition, "unwritable"))?;
        Ok(Self {
            daemon: dir.join(crate::platform::executable_name("spawnd")),
            worker: dir.join(crate::platform::executable_name("spawn-worker")),
            dir,
        })
    }
}

impl Drop for StagingDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}
