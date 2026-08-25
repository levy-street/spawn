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
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

use crate::proto::DaemonUpdateArtifact;

#[path = "update_io.rs"]
mod update_io;
use update_io::*;

const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const VERSION_TIMEOUT: Duration = Duration::from_secs(15);
const PROBATION_WINDOW: Duration = Duration::from_secs(5 * 60);
const MAX_DOWNLOAD_BYTES: u64 = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES: usize = 64 * 1024;
static UPDATE_IN_FLIGHT: AtomicBool = AtomicBool::new(false);
static WORKER_MISMATCH: AtomicBool = AtomicBool::new(false);
static UNSIGNED_WARNING_LOGGED: AtomicBool = AtomicBool::new(false);
static PROBATION: OnceLock<Arc<Mutex<Option<ProbationRuntime>>>> = OnceLock::new();

#[derive(Debug, Clone)]
pub struct UpdateRequest {
    pub request_id: Option<String>,
    pub version: String,
    pub tree: String,
    pub target: String,
    pub spawnd: DaemonUpdateArtifact,
    pub spawn_worker: DaemonUpdateArtifact,
    pub allow_downgrade: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateStage {
    Download,
    Verify,
    Swap,
    Exec,
    Health,
    Precondition,
}

impl UpdateStage {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Download => "download",
            Self::Verify => "verify",
            Self::Swap => "swap",
            Self::Exec => "exec",
            Self::Health => "health",
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProbationMarker {
    attempts: u32,
    old_tree: String,
    deadline_unix_ms: u64,
    attempted_tree: String,
    version_before: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    worker_path: PathBuf,
    #[serde(default)]
    reverted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProbationDecision {
    Continue,
    Revert,
    ReportRevert,
}

#[derive(Debug)]
struct ProbationRuntime {
    marker_path: PathBuf,
    marker: ProbationMarker,
    daemon_path: PathBuf,
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

#[derive(Debug, Deserialize)]
struct ReleaseTarget {
    spawnd_sha256: String,
    spawn_worker_sha256: String,
}

#[derive(Debug, Deserialize)]
struct SignedReleaseManifest {
    tree: String,
    release_counter: u64,
    #[serde(default)]
    signing_key_id: Option<String>,
    targets: HashMap<String, ReleaseTarget>,
}

async fn fetch_bounded_metadata(
    client: &reqwest::Client,
    server_origin: &Url,
    path: &str,
    missing_error: &'static str,
) -> Result<Vec<u8>, UpdateFailure> {
    let url = join_install_url(server_origin, path)?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| UpdateFailure::new(UpdateStage::Verify, missing_error))?;
    if !response.status().is_success() {
        return Err(UpdateFailure::new(UpdateStage::Verify, missing_error));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_MANIFEST_BYTES as u64)
    {
        return Err(UpdateFailure::new(UpdateStage::Verify, "manifest_mismatch"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| UpdateFailure::new(UpdateStage::Verify, missing_error))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_MANIFEST_BYTES {
            return Err(UpdateFailure::new(UpdateStage::Verify, "manifest_mismatch"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn allow_unsigned_update() -> bool {
    let allowed =
        std::env::var_os("SPAWND_ALLOW_UNSIGNED_UPDATE").is_some_and(|value| value == "1");
    if allowed && !UNSIGNED_WARNING_LOGGED.swap(true, Ordering::AcqRel) {
        tracing::warn!(
            "SPAWND_ALLOW_UNSIGNED_UPDATE=1: release signature and downgrade checks are disabled"
        );
    }
    allowed
}

async fn verify_release_manifest(
    client: &reqwest::Client,
    server_origin: &Url,
    request: &UpdateRequest,
    target: &str,
) -> Result<(), UpdateFailure> {
    let allow_unsigned = allow_unsigned_update();
    let manifest = fetch_bounded_metadata(
        client,
        server_origin,
        "/api/install/manifest.json",
        "manifest_missing",
    )
    .await?;
    let signature = if allow_unsigned {
        None
    } else {
        Some(
            fetch_bounded_metadata(
                client,
                server_origin,
                "/api/install/manifest.json.sig",
                "manifest_unsigned",
            )
            .await?,
        )
    };
    let keys: Vec<&str> = crate::release_key::effective_release_signing_public_keys().collect();
    verify_manifest_bytes(
        &manifest,
        signature.as_deref(),
        request,
        target,
        allow_unsigned,
        &keys,
        crate::version::build_counter(),
    )
}

fn verify_manifest_bytes(
    manifest_bytes: &[u8],
    signature_bytes: Option<&[u8]>,
    request: &UpdateRequest,
    target: &str,
    allow_unsigned: bool,
    public_keys: &[&str],
    build_counter: Option<u64>,
) -> Result<(), UpdateFailure> {
    let manifest: SignedReleaseManifest = serde_json::from_slice(manifest_bytes)
        .map_err(|_| UpdateFailure::new(UpdateStage::Verify, "manifest_mismatch"))?;

    if !allow_unsigned {
        let Some(signing_key_id) = manifest.signing_key_id.as_deref() else {
            return Err(UpdateFailure::new(
                UpdateStage::Verify,
                "manifest_bad_signature",
            ));
        };
        let signature_bytes = signature_bytes
            .ok_or_else(|| UpdateFailure::new(UpdateStage::Verify, "manifest_unsigned"))?;
        let signature_wire = std::str::from_utf8(signature_bytes)
            .map(str::trim)
            .map_err(|_| UpdateFailure::new(UpdateStage::Verify, "manifest_bad_signature"))?;
        let signature_raw = URL_SAFE_NO_PAD
            .decode(signature_wire)
            .map_err(|_| UpdateFailure::new(UpdateStage::Verify, "manifest_bad_signature"))?;
        let signature_raw: [u8; 64] = signature_raw
            .try_into()
            .map_err(|_| UpdateFailure::new(UpdateStage::Verify, "manifest_bad_signature"))?;
        let signature = Signature::from_bytes(&signature_raw);
        let verified = public_keys.iter().any(|wire| {
            let Ok(raw) = URL_SAFE_NO_PAD.decode(wire) else {
                return false;
            };
            let Ok(raw) = <[u8; 32]>::try_from(raw) else {
                return false;
            };
            let key_id = &digest_hex(&Sha256::digest(raw))[..8];
            if signing_key_id != key_id {
                return false;
            }
            VerifyingKey::from_bytes(&raw)
                .is_ok_and(|key| key.verify(manifest_bytes, &signature).is_ok())
        });
        if !verified {
            return Err(UpdateFailure::new(
                UpdateStage::Verify,
                "manifest_bad_signature",
            ));
        }
    }

    let Some(artifacts) = manifest.targets.get(target) else {
        return Err(UpdateFailure::new(UpdateStage::Verify, "manifest_mismatch"));
    };
    if manifest.tree != request.tree
        || !artifacts
            .spawnd_sha256
            .eq_ignore_ascii_case(&request.spawnd.sha256)
        || !artifacts
            .spawn_worker_sha256
            .eq_ignore_ascii_case(&request.spawn_worker.sha256)
    {
        return Err(UpdateFailure::new(UpdateStage::Verify, "manifest_mismatch"));
    }
    if !allow_unsigned
        && !request.allow_downgrade
        && build_counter.is_some_and(|counter| manifest.release_counter < counter)
    {
        return Err(UpdateFailure::new(UpdateStage::Precondition, "downgrade"));
    }
    Ok(())
}

fn same_tree_is_current(release_tree: &str, own_tree: &str, worker_mismatch: bool) -> bool {
    release_tree == own_tree && !worker_mismatch
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
    if same_tree_is_current(&daemon.tree, own_tree, worker_mismatch()) {
        return Ok(HttpUpdateOutcome::NoUpdate("current"));
    }
    let Some(target) = daemon.targets.get(preconditions.target) else {
        return Ok(HttpUpdateOutcome::NoUpdate("target_unavailable"));
    };
    let request = UpdateRequest {
        request_id: None,
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
        allow_downgrade: false,
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

    let client = http_client()?;
    verify_release_manifest(&client, server_origin, request, preconditions.target).await?;

    let temporary = TempFiles::new(&preconditions)?;
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
    let marker_path = marker_path(&preconditions.daemon_path);
    let marker = ProbationMarker {
        attempts: 0,
        old_tree: crate::version::daemon_tree()
            .unwrap_or_default()
            .to_string(),
        deadline_unix_ms: unix_millis().saturating_add(PROBATION_WINDOW.as_millis() as u64),
        attempted_tree: request.tree.clone(),
        version_before: crate::version::build_version(),
        request_id: request.request_id.clone(),
        worker_path: preconditions.worker_path.clone(),
        reverted: false,
    };
    write_marker(&marker_path, &marker)
        .map_err(|_| UpdateFailure::new(UpdateStage::Swap, "marker_write_failed"))?;
    if let Err(failure) = swap_binaries(
        &preconditions.daemon_path,
        &temporary.daemon,
        &preconditions.worker_path,
        &temporary.worker,
    ) {
        let _ = fs::remove_file(&marker_path);
        return Err(failure);
    }
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
    let spinner = crate::tui::Spinner::start("checking for an update");
    match apply_from_release(&server).await {
        Ok(HttpUpdateOutcome::NoUpdate(reason)) => {
            spinner.finish(true, "update check complete");
            println!("{}", cli_no_update_line(reason));
            Ok(())
        }
        Ok(HttpUpdateOutcome::Applied(applied)) => {
            spinner.finish(true, "update verified; restarting");
            let failure = exec(applied);
            anyhow::bail!("SPAWN D daemon update failed: {failure}")
        }
        Err(failure) => {
            spinner.finish(false, "update not applied");
            anyhow::bail!("SPAWN D daemon update failed: {failure}")
        }
    }
}

fn cli_no_update_line(reason: &str) -> String {
    format!("SPAWN D daemon update not applied ({reason}).")
}

/// Re-check the co-installed worker identity and publish the result through
/// the existing self-update capability fields on the next register.
pub async fn refresh_worker_pair_status() -> bool {
    let (matches, mismatch) = match resolve_program(crate::worker_backend::worker_bin()) {
        Some(worker) => {
            let matches = worker_pair_matches(&worker).await;
            (matches, !matches)
        }
        None => (false, false),
    };
    WORKER_MISMATCH.store(mismatch, Ordering::Release);
    if mismatch {
        tracing::error!(
            "spawn-worker identity does not match spawnd; refusing new sessions until the installed pair is repaired"
        );
    }
    matches
}

pub fn worker_mismatch() -> bool {
    WORKER_MISMATCH.load(Ordering::Acquire)
}

pub async fn ensure_worker_pair() -> Result<()> {
    if refresh_worker_pair_status().await {
        Ok(())
    } else {
        anyhow::bail!("installed spawn-worker does not match this spawnd build")
    }
}

async fn worker_pair_matches(worker: &Path) -> bool {
    let mut command = tokio::process::Command::new(worker);
    command.arg("--version").kill_on_drop(true);
    let Ok(Ok(output)) = tokio::time::timeout(VERSION_TIMEOUT, command.output()).await else {
        return false;
    };
    output.status.success()
        && std::str::from_utf8(&output.stdout)
            .is_ok_and(|stdout| stdout.trim_end() == crate::version::worker_identity_line())
}

fn marker_path(daemon_path: &Path) -> PathBuf {
    daemon_path.with_file_name("spawnd.updating")
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn probation_decision(marker: &ProbationMarker, now_unix_ms: u64) -> ProbationDecision {
    if marker.reverted {
        ProbationDecision::ReportRevert
    } else if now_unix_ms >= marker.deadline_unix_ms || marker.attempts.saturating_add(1) >= 2 {
        ProbationDecision::Revert
    } else {
        ProbationDecision::Continue
    }
}

fn write_marker(path: &Path, marker: &ProbationMarker) -> std::io::Result<()> {
    use std::io::Write;

    let bytes = serde_json::to_vec(marker).map_err(std::io::Error::other)?;
    let temporary = path.with_file_name(format!("spawnd.updating.tmp.{}", std::process::id()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn read_marker(path: &Path) -> Result<ProbationMarker> {
    let bytes = fs::read(path).context("reading self-update probation marker")?;
    if bytes.len() > 16 * 1024 {
        anyhow::bail!("self-update probation marker is oversized");
    }
    serde_json::from_slice(&bytes).context("decoding self-update probation marker")
}

/// Enter update probation before a daemon control connection is attempted.
/// A second startup or an expired deadline restores the complete prior pair.
pub fn prepare_probation() -> Result<()> {
    let daemon_path = std::env::current_exe()
        .ok()
        .and_then(resolve_file)
        .context("resolving spawnd for update probation")?;
    let marker_path = marker_path(&daemon_path);
    let state = PROBATION.get_or_init(|| Arc::new(Mutex::new(None)));
    if !marker_path.exists() {
        return Ok(());
    }

    let mut marker = match read_marker(&marker_path) {
        Ok(marker) => marker,
        Err(error) => {
            let worker_path = previous_worker_path_for_recovery(&daemon_path);
            tracing::warn!(stage = "health", %error, "self-update probation marker is unreadable");
            if let Some(worker_path) = worker_path {
                let recovered = ProbationMarker {
                    attempts: 2,
                    old_tree: String::new(),
                    deadline_unix_ms: unix_millis(),
                    attempted_tree: crate::version::daemon_tree()
                        .unwrap_or_default()
                        .to_string(),
                    version_before: crate::version::build_version(),
                    request_id: None,
                    worker_path,
                    reverted: false,
                };
                return revert_and_exec(ProbationRuntime {
                    marker_path,
                    marker: recovered,
                    daemon_path,
                });
            }
            if let Err(remove_error) = fs::remove_file(&marker_path) {
                if remove_error.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(
                        stage = "health",
                        "could not delete unreadable probation marker"
                    );
                }
            }
            return Ok(());
        }
    };
    match probation_decision(&marker, unix_millis()) {
        ProbationDecision::Continue => {
            marker.attempts = marker.attempts.saturating_add(1);
            write_marker(&marker_path, &marker)
                .context("updating self-update probation attempt")?;
            *state.lock().expect("probation state lock") = Some(ProbationRuntime {
                marker_path,
                marker,
                daemon_path,
            });
            Ok(())
        }
        ProbationDecision::ReportRevert => {
            *state.lock().expect("probation state lock") = Some(ProbationRuntime {
                marker_path,
                marker,
                daemon_path,
            });
            Ok(())
        }
        ProbationDecision::Revert => revert_and_exec(ProbationRuntime {
            marker_path,
            marker,
            daemon_path,
        }),
    }
}

fn complete_previous_pair(daemon_path: &Path, worker_path: &Path) -> bool {
    previous_path(daemon_path).is_file() && previous_path(worker_path).is_file()
}

fn previous_worker_path_for_recovery(daemon_path: &Path) -> Option<PathBuf> {
    let configured = crate::worker_backend::worker_bin();
    let mut candidates = Vec::new();
    if let Some(parent) = daemon_path.parent() {
        candidates.push(parent.join("spawn-worker"));
    }
    if configured.is_absolute() {
        candidates.push(configured.clone());
    } else if let Some(parent) = daemon_path.parent() {
        candidates.push(parent.join(&configured));
    }
    if let Some(resolved) = resolve_program(configured) {
        candidates.push(resolved);
    }
    candidates
        .into_iter()
        .find(|worker| complete_previous_pair(daemon_path, worker))
}

/// Arm the five-minute health deadline. Registration removes this task's
/// shared state before it wakes, making success and revert mutually exclusive.
pub fn arm_probation_deadline() {
    let Some(state) = PROBATION.get().cloned() else {
        return;
    };
    tokio::spawn(async move {
        let deadline = {
            let guard = state.lock().expect("probation state lock");
            guard.as_ref().and_then(|runtime| {
                (!runtime.marker.reverted).then_some(runtime.marker.deadline_unix_ms)
            })
        };
        let Some(deadline) = deadline else { return };
        tokio::time::sleep(Duration::from_millis(
            deadline.saturating_sub(unix_millis()),
        ))
        .await;
        let runtime = state.lock().expect("probation state lock").take();
        if let Some(runtime) = runtime {
            if let Err(error) = revert_and_exec(runtime) {
                tracing::error!(stage = "health", %error, "SPAWN D daemon health revert failed");
            }
        }
    });
}

fn revert_and_exec(mut runtime: ProbationRuntime) -> Result<()> {
    revert_binaries(&runtime.daemon_path, &runtime.marker.worker_path)
        .context("restoring previous daemon binaries")?;
    runtime.marker.reverted = true;
    write_marker(&runtime.marker_path, &runtime.marker)
        .context("recording completed daemon health revert")?;
    tracing::error!(
        stage = "health",
        "updated daemon did not register; reverting"
    );
    exec_path(&runtime.daemon_path)
}

#[cfg(unix)]
fn exec_path(path: &Path) -> Result<()> {
    use std::os::unix::process::CommandExt;
    let mut argv = std::env::args_os();
    let argv0 = argv.next();
    let mut command = std::process::Command::new(path);
    if let Some(argv0) = argv0 {
        command.arg0(argv0);
    }
    command.args(argv);
    let error = command.exec();
    Err(error).context("execing reverted spawnd")
}

#[cfg(not(unix))]
fn exec_path(_path: &Path) -> Result<()> {
    anyhow::bail!("health revert exec is unsupported on this target")
}

/// Commit a healthy update after registration, or report a completed revert
/// before deleting its durable marker.
pub async fn registered(out_tx: &tokio::sync::mpsc::Sender<crate::pty::WsOutbound>) {
    let Some(state) = PROBATION.get() else { return };
    let Some(runtime) = state.lock().expect("probation state lock").take() else {
        return;
    };
    if runtime.marker.reverted {
        let result = health_failure_result(&runtime.marker);
        let Ok(frame) = serde_json::to_string(&result) else {
            return;
        };
        let delivered = tokio::time::timeout(Duration::from_secs(2), async {
            let (frame, flushed) = crate::pty::WsOutbound::tracked_json(frame);
            out_tx.send(frame).await.map_err(|_| ())?;
            flushed.notified().await;
            Ok::<(), ()>(())
        })
        .await;
        if !matches!(delivered, Ok(Ok(()))) {
            *state.lock().expect("probation state lock") = Some(runtime);
            return;
        }
    }

    if let Err(error) = fs::remove_file(&runtime.marker_path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(
                stage = "health",
                "could not remove self-update probation marker"
            );
            *state.lock().expect("probation state lock") = Some(runtime);
            return;
        }
    }
    cleanup_previous_paths(&runtime.daemon_path, &runtime.marker.worker_path);
    tracing::info!(
        stage = "health",
        "daemon update passed post-register health gate"
    );
}

fn health_failure_result(marker: &ProbationMarker) -> crate::proto::Outbound {
    crate::proto::Outbound::DaemonUpdateResult {
        request_id: marker
            .request_id
            .clone()
            .unwrap_or_else(|| format!("health-{}", marker.attempted_tree)),
        ok: false,
        tree: marker.attempted_tree.clone(),
        version_before: marker.version_before.clone(),
        stage: Some(UpdateStage::Health.as_str().to_string()),
        error: Some("registration_failed".to_string()),
    }
}

fn cleanup_previous_paths(daemon_path: &Path, worker_path: &Path) {
    for previous in [previous_path(daemon_path), previous_path(worker_path)] {
        match fs::remove_file(previous) {
            Ok(()) => tracing::info!(stage = "cleanup", "removed self-update backup"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => tracing::warn!(stage = "cleanup", "could not remove self-update backup"),
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
