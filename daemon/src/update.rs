//! Verified self-update for the `spawnd` supervisor and its session worker.
//!
//! The supervisor process may be replaced, but it never terminates workers:
//! they own the live sessions and the new process re-adopts them through the
//! existing discovery registry.

use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{Context, Result};
use serde::Deserialize;
use url::Url;

use crate::proto::DaemonUpdateArtifact;

#[path = "update_io.rs"]
mod update_io;
use update_io::*;

const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const VERSION_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_DOWNLOAD_BYTES: u64 = 256 * 1024 * 1024;
static UPDATE_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone)]
pub struct UpdateRequest {
    pub version: String,
    pub tree: String,
    pub target: String,
    pub spawnd: DaemonUpdateArtifact,
    pub spawn_worker: DaemonUpdateArtifact,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateStage {
    Download,
    Verify,
    Swap,
    Exec,
    Precondition,
}

impl UpdateStage {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Download => "download",
            Self::Verify => "verify",
            Self::Swap => "swap",
            Self::Exec => "exec",
            Self::Precondition => "precondition",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UpdateFailure {
    pub stage: UpdateStage,
    pub error: &'static str,
}

impl UpdateFailure {
    const fn new(stage: UpdateStage, error: &'static str) -> Self {
        Self { stage, error }
    }
}

impl fmt::Display for UpdateFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.stage.as_str(), self.error)
    }
}

impl std::error::Error for UpdateFailure {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BlockReason {
    Disabled,
    Unwritable,
    UnsupportedTarget,
    WorkerMissing,
}

impl BlockReason {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Unwritable => "unwritable",
            Self::UnsupportedTarget => "unsupported_target",
            Self::WorkerMissing => "worker_missing",
        }
    }
}

impl From<BlockReason> for UpdateFailure {
    fn from(reason: BlockReason) -> Self {
        Self::new(UpdateStage::Precondition, reason.as_str())
    }
}

pub struct Capability {
    pub self_update: bool,
    pub blocked: Option<&'static str>,
}

#[derive(Debug)]
struct Preconditions {
    daemon_path: PathBuf,
    worker_path: PathBuf,
    target: &'static str,
}

#[derive(Debug)]
pub(crate) struct UpdatePermit<'a> {
    flag: &'a AtomicBool,
}

impl Drop for UpdatePermit<'_> {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::Release);
    }
}

#[derive(Debug)]
pub struct AppliedUpdate {
    daemon_path: PathBuf,
    _permit: UpdatePermit<'static>,
}

pub enum HttpUpdateOutcome {
    NoUpdate(&'static str),
    Applied(AppliedUpdate),
}

#[derive(Deserialize)]
struct ReleaseResponse {
    daemon: Option<ReleaseDaemon>,
}

#[derive(Deserialize)]
struct ReleaseDaemon {
    version: String,
    tree: String,
    targets: HashMap<String, ReleaseTarget>,
}

#[derive(Deserialize)]
struct ReleaseTarget {
    spawnd_sha256: String,
    spawn_worker_sha256: String,
}

pub fn capability() -> Capability {
    match evaluate_preconditions() {
        Ok(_) => Capability {
            self_update: true,
            blocked: None,
        },
        Err(reason) => Capability {
            self_update: false,
            blocked: Some(reason.as_str()),
        },
    }
}

pub async fn apply(
    server_origin: &Url,
    request: UpdateRequest,
) -> Result<AppliedUpdate, UpdateFailure> {
    log_stage(UpdateStage::Precondition);
    let permit = acquire_update()?;
    let preconditions = evaluate_preconditions().map_err(UpdateFailure::from)?;
    apply_guarded(server_origin, &request, preconditions, permit).await
}

pub async fn apply_from_release(server: &Url) -> Result<HttpUpdateOutcome, UpdateFailure> {
    log_stage(UpdateStage::Precondition);
    let permit = acquire_update()?;
    let preconditions = evaluate_preconditions().map_err(UpdateFailure::from)?;
    log_stage(UpdateStage::Download);
    let release_url = crate::config::api_url(server, "/api/release")
        .map_err(|_| UpdateFailure::new(UpdateStage::Download, "release_unavailable"))?;
    let client = http_client()?;
    let response = client
        .get(release_url)
        .send()
        .await
        .map_err(|_| UpdateFailure::new(UpdateStage::Download, "release_unavailable"))?;
    if !response.status().is_success() {
        return Err(UpdateFailure::new(
            UpdateStage::Download,
            "release_unavailable",
        ));
    }
    let release: ReleaseResponse = response
        .json()
        .await
        .map_err(|_| UpdateFailure::new(UpdateStage::Download, "release_invalid"))?;
    let Some(own_tree) = crate::version::daemon_tree().filter(|tree| clean_tree(tree)) else {
        return Ok(HttpUpdateOutcome::NoUpdate("identity_unknown"));
    };
    let Some(daemon) = release.daemon.filter(|daemon| clean_tree(&daemon.tree)) else {
        return Ok(HttpUpdateOutcome::NoUpdate("release_unavailable"));
    };
    if daemon.tree == own_tree {
        return Ok(HttpUpdateOutcome::NoUpdate("current"));
    }
    let Some(target) = daemon.targets.get(preconditions.target) else {
        return Ok(HttpUpdateOutcome::NoUpdate("target_unavailable"));
    };
    let request = UpdateRequest {
        version: daemon.version,
        tree: daemon.tree,
        target: preconditions.target.to_string(),
        spawnd: DaemonUpdateArtifact {
            path: format!("/api/install/spawnd/{}", preconditions.target),
            sha256: target.spawnd_sha256.clone(),
        },
        spawn_worker: DaemonUpdateArtifact {
            path: format!("/api/install/spawn-worker/{}", preconditions.target),
            sha256: target.spawn_worker_sha256.clone(),
        },
    };
    apply_guarded(server, &request, preconditions, permit)
        .await
        .map(HttpUpdateOutcome::Applied)
}

async fn apply_guarded(
    server_origin: &Url,
    request: &UpdateRequest,
    preconditions: Preconditions,
    permit: UpdatePermit<'static>,
) -> Result<AppliedUpdate, UpdateFailure> {
    if request.target != preconditions.target {
        return Err(BlockReason::UnsupportedTarget.into());
    }
    let daemon_url = join_install_url(server_origin, &request.spawnd.path)?;
    let worker_url = join_install_url(server_origin, &request.spawn_worker.path)?;
    if !valid_sha256(&request.spawnd.sha256) || !valid_sha256(&request.spawn_worker.sha256) {
        return Err(UpdateFailure::new(UpdateStage::Verify, "invalid_sha256"));
    }

    let temporary = TempFiles::new(&preconditions)?;
    let client = http_client()?;
    log_stage(UpdateStage::Download);
    let downloads = async {
        let daemon_hash = download_to(&client, daemon_url, &temporary.daemon).await?;
        let worker_hash = download_to(&client, worker_url, &temporary.worker).await?;
        Ok::<_, UpdateFailure>((daemon_hash, worker_hash))
    };
    let (daemon_hash, worker_hash) = tokio::time::timeout(DOWNLOAD_TIMEOUT, downloads)
        .await
        .map_err(|_| UpdateFailure::new(UpdateStage::Download, "timeout"))??;

    log_stage(UpdateStage::Verify);
    if !daemon_hash.eq_ignore_ascii_case(&request.spawnd.sha256)
        || !worker_hash.eq_ignore_ascii_case(&request.spawn_worker.sha256)
    {
        return Err(UpdateFailure::new(UpdateStage::Verify, "sha256_mismatch"));
    }
    chmod_executable(&temporary.daemon)?;
    chmod_executable(&temporary.worker)?;
    verify_version(&temporary.daemon, &request.version).await?;

    // Re-evaluate every filesystem and platform condition immediately before
    // the atomic renames. A changed resolution fails closed rather than
    // swapping a different file from the one we prepared for.
    let current = evaluate_preconditions().map_err(UpdateFailure::from)?;
    if current.daemon_path != preconditions.daemon_path
        || current.worker_path != preconditions.worker_path
        || current.target != preconditions.target
    {
        return Err(UpdateFailure::new(
            UpdateStage::Precondition,
            "preconditions_changed",
        ));
    }

    log_stage(UpdateStage::Swap);
    swap_binaries(
        &preconditions.daemon_path,
        &temporary.daemon,
        &preconditions.worker_path,
        &temporary.worker,
    )?;
    Ok(AppliedUpdate {
        daemon_path: preconditions.daemon_path,
        _permit: permit,
    })
}

pub fn exec(applied: AppliedUpdate) -> UpdateFailure {
    log_stage(UpdateStage::Exec);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let AppliedUpdate {
            daemon_path,
            _permit: permit,
        } = applied;
        let mut argv = std::env::args_os();
        let argv0 = argv.next();
        let mut command = std::process::Command::new(daemon_path);
        if let Some(argv0) = argv0 {
            command.arg0(argv0);
        }
        command.args(argv);
        // The current environment is inherited. exec replaces only spawnd;
        // spawn-worker processes keep owning their sessions and are re-adopted.
        let _exec_error = command.exec();
        drop(permit);
        UpdateFailure::new(UpdateStage::Exec, "exec_failed")
    }
    #[cfg(not(unix))]
    {
        drop(applied);
        UpdateFailure::new(UpdateStage::Exec, "unsupported_target")
    }
}

fn log_stage(stage: UpdateStage) {
    tracing::info!(stage = stage.as_str(), "SPAWN D daemon self-update stage");
}

pub async fn run_cli(server_cli: Option<String>) -> Result<()> {
    let stored = crate::creds::load().context("loading stored credentials")?;
    let server = crate::config::server_url_for_instance(server_cli, stored.server_url.as_deref())?;
    match apply_from_release(&server).await {
        Ok(HttpUpdateOutcome::NoUpdate(reason)) => {
            println!("SPAWN D daemon update not applied ({reason}).");
            Ok(())
        }
        Ok(HttpUpdateOutcome::Applied(applied)) => {
            let failure = exec(applied);
            anyhow::bail!("SPAWN D daemon update failed: {failure}")
        }
        Err(failure) => anyhow::bail!("SPAWN D daemon update failed: {failure}"),
    }
}

pub fn cleanup_stale_previous() {
    let mut directories = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            directories.push(parent.to_path_buf());
        }
    }
    if let Some(worker) = resolve_program(crate::worker_backend::worker_bin()) {
        if let Some(parent) = worker.parent() {
            directories.push(parent.to_path_buf());
        }
    }
    directories.sort();
    directories.dedup();
    cleanup_previous_in(&directories);
}

fn cleanup_previous_in(directories: &[PathBuf]) {
    for directory in directories {
        for name in ["spawnd.prev", "spawn-worker.prev"] {
            match fs::remove_file(directory.join(name)) {
                Ok(()) => tracing::info!(stage = "cleanup", "removed stale self-update backup"),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => tracing::warn!(
                    stage = "cleanup",
                    "could not remove stale self-update backup"
                ),
            }
        }
    }
}

pub fn reinstall_command(server: &Url) -> String {
    let install = crate::config::api_url(server, "/install.sh")
        .map(|url| url.to_string())
        .unwrap_or_else(|_| server.to_string());
    format!("curl -fsSL {install} | sh")
}

pub(crate) fn acquire_update() -> Result<UpdatePermit<'static>, UpdateFailure> {
    acquire_from(&UPDATE_IN_FLIGHT)
}

fn acquire_from(flag: &AtomicBool) -> Result<UpdatePermit<'_>, UpdateFailure> {
    flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map(|_| UpdatePermit { flag })
        .map_err(|_| UpdateFailure::new(UpdateStage::Precondition, "busy"))
}

fn evaluate_preconditions() -> Result<Preconditions, BlockReason> {
    let disabled = std::env::var_os("SPAWND_NO_SELF_UPDATE").is_some_and(|value| !value.is_empty());
    let daemon_path = std::env::current_exe().ok().and_then(resolve_file);
    let worker_path = resolve_program(crate::worker_backend::worker_bin());
    classify_preconditions(
        disabled,
        daemon_path,
        worker_path,
        target_for(std::env::consts::OS, std::env::consts::ARCH),
        probe_writable,
    )
}

fn classify_preconditions<F>(
    disabled: bool,
    daemon_path: Option<PathBuf>,
    worker_path: Option<PathBuf>,
    target: Option<&'static str>,
    writable: F,
) -> Result<Preconditions, BlockReason>
where
    F: Fn(&Path) -> bool,
{
    if disabled {
        return Err(BlockReason::Disabled);
    }
    let daemon_path = daemon_path.ok_or(BlockReason::Unwritable)?;
    let daemon_dir = daemon_path.parent().ok_or(BlockReason::Unwritable)?;
    if !writable(daemon_dir) {
        return Err(BlockReason::Unwritable);
    }
    let worker_path = worker_path.ok_or(BlockReason::WorkerMissing)?;
    let worker_dir = worker_path.parent().ok_or(BlockReason::WorkerMissing)?;
    if !writable(worker_dir) {
        return Err(BlockReason::Unwritable);
    }
    let target = target.ok_or(BlockReason::UnsupportedTarget)?;
    Ok(Preconditions {
        daemon_path,
        worker_path,
        target,
    })
}

#[cfg(test)]
#[path = "update_tests.rs"]
mod tests;
