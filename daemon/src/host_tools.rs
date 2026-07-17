//! Endpoint-owned interactive tool checks and installs for `spawn.host.ctl`.
//!
//! The browser selects a stable tool kind. It never supplies an executable
//! path, shell string, or argv. Every executed program/argument vector comes
//! from the fixed policy below and is resolved against the endpoint's PATH.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
#[cfg(target_os = "linux")]
use std::fs::{File, OpenOptions};
use std::future::Future;
#[cfg(target_os = "linux")]
use std::io::Read as _;
#[cfg(target_os = "linux")]
use std::os::unix::fs::MetadataExt as _;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
#[cfg(test)]
use std::sync::atomic::AtomicBool;
#[cfg(target_os = "linux")]
use std::sync::atomic::AtomicU64;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;

#[cfg(target_os = "linux")]
use std::ffi::CString;
#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, FromRawFd};

use futures_util::{stream::FuturesUnordered, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, Notify, OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

pub(crate) const MAX_TARGETS: usize = 8;
const MAX_TARGET_ID_BYTES: usize = 128;
const MAX_TOOL_BYTES: usize = 64;
const MAX_PATH_BYTES: usize = 512;
const MAX_VERSION_BYTES: usize = 240;
const MAX_DETAIL_BYTES: usize = 512;
pub(crate) const OUTPUT_TAIL_BYTES: usize = 4 * 1024;
const CHECK_TIMEOUT: Duration = Duration::from_secs(5);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(180);
const PIPE_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const CONTAINMENT_CLEANUP_TIMEOUT: Duration = Duration::from_millis(250);
const QUARANTINE_RETRY_INTERVAL: Duration = Duration::from_millis(10);
const MAX_CONTAINMENT_TREE_DEPTH: usize = 64;
const MAX_CONTAINMENT_TREE_ENTRIES: usize = 4_096;
const MAX_PROC_SCAN_ENTRIES: usize = 65_536;
const MAX_CONTAINMENT_PIDS: usize = 64;
const MAX_CONTAINMENT_PID_BYTES: u64 = (MAX_CONTAINMENT_PIDS * 16) as u64;
const MAX_MANAGER_CGROUP_PIDS: usize = 4_096;
const MAX_MANAGER_CGROUP_PID_BYTES: u64 = (MAX_MANAGER_CGROUP_PIDS * 16) as u64;
const TOOL_CGROUP_MANAGER_NAME: &str = "spawn-manager";
const TOOL_CGROUP_ATTEMPTS_NAME: &str = "spawn-tool-attempts";
const TOOL_CGROUP_RECOVERY_TIMEOUT: Duration = Duration::from_secs(2);
const SPAWN_BUSY_RETRIES: usize = 3;
const SPAWN_BUSY_RETRY_DELAY: Duration = Duration::from_millis(5);
pub(crate) const MAX_PROCESSES: usize = 4;
#[cfg(target_os = "linux")]
static TOOL_CGROUP_SEQUENCE: AtomicU64 = AtomicU64::new(1);
#[cfg(target_os = "linux")]
static TOOL_CGROUP_ATTEMPTS_ROOT: StdMutex<Option<PathBuf>> = StdMutex::new(None);

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct ToolTarget {
    pub target_id: String,
    pub tool: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolCheckPayload {
    targets: Vec<ToolTarget>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolInstallPayload {
    target: ToolTarget,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ToolStatus {
    pub target_id: String,
    pub tool: String,
    pub command: Vec<String>,
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_available: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ToolInstallResult {
    pub target_id: String,
    pub tool: String,
    pub command: Vec<String>,
    pub install_argv: Vec<String>,
    pub outcome: &'static str,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub output_truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<ToolStatus>,
}

#[derive(Debug)]
pub(crate) struct ToolError {
    pub code: &'static str,
    pub detail: String,
}

impl ToolError {
    fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: bounded(detail.into(), MAX_DETAIL_BYTES),
        }
    }
}

#[derive(Clone, Copy)]
enum LatestPolicy {
    Npm(&'static str),
    Pip(&'static str),
}

#[derive(Clone, Copy)]
enum InstallPolicy {
    Npm(&'static str),
    Pip(&'static str),
}

#[derive(Clone, Copy)]
struct ToolPolicy {
    tool: &'static str,
    executable: &'static str,
    version_args: &'static [&'static str],
    latest: Option<LatestPolicy>,
    install: Option<InstallPolicy>,
}

const POLICIES: &[ToolPolicy] = &[
    ToolPolicy {
        tool: "claude-code",
        executable: "claude",
        version_args: &["--version"],
        latest: Some(LatestPolicy::Npm("@anthropic-ai/claude-code")),
        install: Some(InstallPolicy::Npm("@anthropic-ai/claude-code")),
    },
    ToolPolicy {
        tool: "codex",
        executable: "codex",
        version_args: &["--version"],
        latest: Some(LatestPolicy::Npm("@openai/codex")),
        install: Some(InstallPolicy::Npm("@openai/codex")),
    },
    ToolPolicy {
        tool: "opencode",
        executable: "opencode",
        version_args: &["--version"],
        latest: Some(LatestPolicy::Npm("opencode-ai")),
        install: Some(InstallPolicy::Npm("opencode-ai")),
    },
    ToolPolicy {
        // Tool policy is keyed by the disclosed preset `agent_kind`, not by a
        // particular built-in preset name. The built-in Aider preset is named
        // `aider-sonnet` but canonically discloses `agent_kind = "aider"`.
        tool: "aider",
        executable: "aider",
        version_args: &["--version"],
        latest: Some(LatestPolicy::Pip("aider-chat")),
        install: Some(InstallPolicy::Pip("aider-chat")),
    },
    ToolPolicy {
        tool: "shell",
        executable: "bash",
        version_args: &["--version"],
        latest: None,
        install: None,
    },
];

fn policy_for(tool: &str) -> Option<ToolPolicy> {
    POLICIES.iter().copied().find(|policy| policy.tool == tool)
}

pub(crate) struct HostToolService {
    processes: Arc<Semaphore>,
    residue_supervisor: Arc<ToolResidueSupervisor>,
    install_state: StdMutex<ToolInstallState>,
    operations: Arc<HostToolOperations>,
    lifecycle_hooks: Arc<HostToolLifecycleHooks>,
}

#[derive(Default)]
struct ToolInstallState {
    active: HashSet<&'static str>,
    reconciliation_required: HashSet<&'static str>,
    effect_generation: HashMap<&'static str, u64>,
}

#[derive(Clone, Copy)]
struct ReconciliationCheck {
    tool: &'static str,
    effect_generation: u64,
}

#[derive(Default)]
struct HostToolLifecycleHooks {
    #[cfg(test)]
    after_kill: AsyncPause,
    #[cfg(test)]
    pipe_drain: AsyncPause,
    #[cfg(test)]
    reconciliation_clear: AsyncPause,
    #[cfg(test)]
    cleanup_freeze: AsyncPause,
    #[cfg(test)]
    cleanup_inventory: AsyncPause,
    #[cfg(test)]
    cleanup_populated: AsyncPause,
    #[cfg(test)]
    cleanup_reap: AsyncPause,
    #[cfg(test)]
    cleanup_remove: AsyncPause,
    #[cfg(test)]
    cleanup_owned_child: AsyncPause,
    #[cfg(test)]
    quarantine_reaper: AsyncPause,
    #[cfg(test)]
    fail_pre_spawn: AtomicBool,
    #[cfg(all(test, target_os = "linux"))]
    containment_path: StdMutex<Option<PathBuf>>,
}

#[cfg(test)]
#[derive(Default)]
struct AsyncPause {
    armed: AtomicBool,
    entered: Notify,
    release: Notify,
}

#[cfg(test)]
impl AsyncPause {
    fn arm(&self) {
        self.armed.store(true, Ordering::Release);
    }

    async fn wait_until_entered(&self) {
        self.entered.notified().await;
    }

    fn release(&self) {
        self.release.notify_one();
    }

    async fn pause_until(&self, deadline: tokio::time::Instant) -> bool {
        if !self.armed.swap(false, Ordering::AcqRel) {
            return true;
        }
        self.entered.notify_one();
        tokio::time::timeout_at(deadline, self.release.notified())
            .await
            .is_ok()
    }
}

impl HostToolLifecycleHooks {
    #[cfg(all(test, target_os = "linux"))]
    fn record_containment_path(&self, path: PathBuf) {
        *self
            .containment_path
            .lock()
            .expect("containment path hook lock") = Some(path);
    }

    #[cfg(all(test, target_os = "linux"))]
    fn containment_path(&self) -> PathBuf {
        self.containment_path
            .lock()
            .expect("containment path hook lock")
            .clone()
            .expect("tool containment path was not recorded")
    }

    async fn pause_after_kill(&self) {
        #[cfg(test)]
        if self.after_kill.armed.swap(false, Ordering::AcqRel) {
            self.after_kill.entered.notify_one();
            self.after_kill.release.notified().await;
        }
    }

    async fn pause_pipe_drain(&self) {
        #[cfg(test)]
        if self.pipe_drain.armed.swap(false, Ordering::AcqRel) {
            self.pipe_drain.entered.notify_one();
            self.pipe_drain.release.notified().await;
        }
    }

    async fn pause_reconciliation_clear(&self) {
        #[cfg(test)]
        if self
            .reconciliation_clear
            .armed
            .swap(false, Ordering::AcqRel)
        {
            self.reconciliation_clear.entered.notify_one();
            self.reconciliation_clear.release.notified().await;
        }
    }

    async fn cleanup_freeze_until(&self, _deadline: tokio::time::Instant) -> bool {
        #[cfg(test)]
        return self.cleanup_freeze.pause_until(_deadline).await;
        #[cfg(not(test))]
        true
    }

    async fn cleanup_populated_until(&self, _deadline: tokio::time::Instant) -> bool {
        #[cfg(test)]
        return self.cleanup_populated.pause_until(_deadline).await;
        #[cfg(not(test))]
        true
    }

    async fn pause_cleanup_inventory_io(&self) {
        #[cfg(test)]
        if self.cleanup_inventory.armed.swap(false, Ordering::AcqRel) {
            self.cleanup_inventory.entered.notify_one();
            self.cleanup_inventory.release.notified().await;
        }
    }

    async fn cleanup_reap_until(&self, _deadline: tokio::time::Instant) -> bool {
        #[cfg(test)]
        return self.cleanup_reap.pause_until(_deadline).await;
        #[cfg(not(test))]
        true
    }

    async fn pause_cleanup_remove_io(&self) {
        #[cfg(test)]
        if self.cleanup_remove.armed.swap(false, Ordering::AcqRel) {
            self.cleanup_remove.entered.notify_one();
            self.cleanup_remove.release.notified().await;
        }
    }

    async fn cleanup_owned_child_until(&self, _deadline: tokio::time::Instant) -> bool {
        #[cfg(test)]
        return self.cleanup_owned_child.pause_until(_deadline).await;
        #[cfg(not(test))]
        true
    }

    async fn pause_quarantine_reaper(&self) {
        #[cfg(test)]
        if self.quarantine_reaper.armed.swap(false, Ordering::AcqRel) {
            self.quarantine_reaper.entered.notify_one();
            self.quarantine_reaper.release.notified().await;
        }
    }

    fn take_pre_spawn_failure(&self) -> bool {
        #[cfg(test)]
        return self.fail_pre_spawn.swap(false, Ordering::AcqRel);
        #[cfg(not(test))]
        false
    }
}

#[derive(Default)]
pub(crate) struct HostToolOperations {
    active: AtomicUsize,
    idle: Notify,
}

struct HostToolOperationPermit {
    operations: Arc<HostToolOperations>,
}

struct CancelOperationOnDrop(CancellationToken);

#[derive(Default)]
struct ToolResidueState {
    admissions: usize,
    quarantined: usize,
}

#[derive(Default)]
struct ToolResidueSupervisor {
    state: StdMutex<ToolResidueState>,
    idle: Notify,
}

struct ToolResidueAdmission {
    supervisor: Arc<ToolResidueSupervisor>,
    active: bool,
}

impl ToolResidueSupervisor {
    fn admit(self: &Arc<Self>) -> Result<ToolResidueAdmission, ToolError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ToolError::new("closed", "tool residue registry is unavailable"))?;
        if state.quarantined != 0 {
            return Err(ToolError::new(
                "containment_failed",
                "tool execution is blocked while prior containment residue is quarantined",
            ));
        }
        if state.admissions >= MAX_PROCESSES {
            return Err(ToolError::new(
                "tool_busy",
                "endpoint tool process capacity is exhausted",
            ));
        }
        state.admissions += 1;
        Ok(ToolResidueAdmission {
            supervisor: Arc::clone(self),
            active: true,
        })
    }

    fn is_idle(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.quarantined == 0)
            .unwrap_or(false)
    }

    #[cfg(test)]
    fn quarantined(&self) -> usize {
        self.state
            .lock()
            .expect("tool residue registry")
            .quarantined
    }

    #[cfg(test)]
    async fn wait_for_idle_until(&self, deadline: tokio::time::Instant) -> bool {
        loop {
            let notified = self.idle.notified();
            if self.is_idle() {
                return true;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return self.is_idle();
            }
        }
    }
}

impl Drop for ToolResidueAdmission {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        if let Ok(mut state) = self.supervisor.state.lock() {
            state.admissions = state.admissions.saturating_sub(1);
            if state.admissions == 0 && state.quarantined == 0 {
                self.supervisor.idle.notify_waiters();
            }
        }
    }
}

impl HostToolOperations {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn admit(self: &Arc<Self>) -> HostToolOperationPermit {
        self.active.fetch_add(1, Ordering::AcqRel);
        HostToolOperationPermit {
            operations: Arc::clone(self),
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

    #[cfg(test)]
    fn active(&self) -> usize {
        self.active.load(Ordering::Acquire)
    }
}

impl Drop for HostToolOperationPermit {
    fn drop(&mut self) {
        if self.operations.active.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.operations.idle.notify_waiters();
        }
    }
}

impl Drop for CancelOperationOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

impl HostToolService {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            processes: Arc::new(Semaphore::new(MAX_PROCESSES)),
            residue_supervisor: Arc::new(ToolResidueSupervisor::default()),
            install_state: StdMutex::new(ToolInstallState::default()),
            operations: HostToolOperations::new(),
            lifecycle_hooks: Arc::new(HostToolLifecycleHooks::default()),
        })
    }

    pub(crate) fn shared() -> Arc<Self> {
        static SERVICE: OnceLock<Arc<HostToolService>> = OnceLock::new();
        Arc::clone(SERVICE.get_or_init(Self::new))
    }

    #[cfg(test)]
    pub(crate) fn arm_pipe_drain_pause(&self) {
        self.lifecycle_hooks.pipe_drain.arm();
    }

    #[cfg(test)]
    pub(crate) async fn wait_for_pipe_drain_pause(&self) {
        self.lifecycle_hooks.pipe_drain.wait_until_entered().await;
    }

    #[cfg(test)]
    pub(crate) fn release_pipe_drain_pause(&self) {
        self.lifecycle_hooks.pipe_drain.release();
    }

    #[cfg(test)]
    pub(crate) fn active_operations(&self) -> usize {
        self.operations.active()
    }

    #[cfg(test)]
    pub(crate) async fn wait_for_operations_idle_until(
        &self,
        deadline: tokio::time::Instant,
    ) -> bool {
        self.operations.wait_for_idle_until(deadline).await
    }

    pub(crate) fn parse_check(payload: &serde_json::Value) -> Result<Vec<ToolTarget>, ToolError> {
        let parsed: ToolCheckPayload = serde_json::from_value(payload.clone())
            .map_err(|_| ToolError::new("invalid_request", "invalid tool check payload"))?;
        if parsed.targets.is_empty() || parsed.targets.len() > MAX_TARGETS {
            return Err(ToolError::new(
                "invalid_request",
                "tool check target count is outside the allowed range",
            ));
        }
        let mut ids = HashSet::new();
        for target in &parsed.targets {
            validate_target(target)?;
            if !ids.insert(target.target_id.as_str()) {
                return Err(ToolError::new(
                    "invalid_request",
                    "tool check target IDs must be unique",
                ));
            }
        }
        Ok(parsed.targets)
    }

    pub(crate) fn parse_install(payload: &serde_json::Value) -> Result<ToolTarget, ToolError> {
        let parsed: ToolInstallPayload = serde_json::from_value(payload.clone())
            .map_err(|_| ToolError::new("invalid_request", "invalid tool install payload"))?;
        validate_target(&parsed.target)?;
        Ok(parsed.target)
    }

    pub(crate) async fn check(
        self: &Arc<Self>,
        targets: Vec<ToolTarget>,
        cancelled: CancellationToken,
        shutdown: CancellationToken,
        session_operations: Arc<HostToolOperations>,
        session_permit: OwnedSemaphorePermit,
    ) -> Result<Vec<ToolStatus>, ToolError> {
        let service = Arc::clone(self);
        let operation_cancelled = cancelled.clone();
        self.run_owned(session_operations, session_permit, cancelled, async move {
            let env = Arc::new(endpoint_command_env());
            service
                .check_inner(targets, env, operation_cancelled, shutdown)
                .await
        })
        .await
    }

    async fn check_inner(
        self: &Arc<Self>,
        targets: Vec<ToolTarget>,
        env: Arc<BTreeMap<String, String>>,
        cancelled: CancellationToken,
        shutdown: CancellationToken,
    ) -> Result<Vec<ToolStatus>, ToolError> {
        let operation_cancelled = cancelled.child_token();
        let mut checks = FuturesUnordered::new();
        for (index, target) in targets.into_iter().enumerate() {
            let reconciliation = self.begin_reconciliation_check(&target.tool)?;
            let service = Arc::clone(self);
            let env = Arc::clone(&env);
            let cancelled = operation_cancelled.clone();
            let shutdown = shutdown.clone();
            checks.push(async move {
                (
                    index,
                    reconciliation,
                    service.check_one(target, &env, &cancelled, &shutdown).await,
                )
            });
        }
        let mut ordered = Vec::with_capacity(checks.len());
        ordered.resize_with(checks.len(), || None);
        let mut first_error = None;
        let mut reconciliation_checks = Vec::with_capacity(checks.len());
        reconciliation_checks.resize(checks.len(), None);
        while let Some((index, reconciliation, result)) = checks.next().await {
            if let Some(slot) = reconciliation_checks.get_mut(index) {
                *slot = reconciliation;
            }
            match result {
                Ok(status) => {
                    if let Some(slot) = ordered.get_mut(index) {
                        *slot = Some(status);
                    }
                }
                Err(error) => {
                    operation_cancelled.cancel();
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
        }
        if let Some(error) = first_error {
            return Err(error);
        }
        let statuses = ordered.into_iter().flatten().collect::<Vec<_>>();
        self.lifecycle_hooks.pause_reconciliation_clear().await;
        for (status, reconciliation) in statuses.iter().zip(reconciliation_checks) {
            if definitive_status(status) {
                self.complete_reconciliation_check(reconciliation)?;
            }
        }
        Ok(statuses)
    }

    pub(crate) async fn install(
        self: &Arc<Self>,
        target: ToolTarget,
        cancelled: CancellationToken,
        shutdown: CancellationToken,
        session_operations: Arc<HostToolOperations>,
        session_permit: OwnedSemaphorePermit,
    ) -> Result<ToolInstallResult, ToolError> {
        let service = Arc::clone(self);
        let operation_cancelled = cancelled.clone();
        self.run_owned(session_operations, session_permit, cancelled, async move {
            let env = endpoint_command_env();
            service
                .install_with_env(target, &env, operation_cancelled, shutdown)
                .await
        })
        .await
    }

    async fn run_owned<T, F>(
        self: &Arc<Self>,
        session_operations: Arc<HostToolOperations>,
        session_permit: OwnedSemaphorePermit,
        cancelled: CancellationToken,
        operation: F,
    ) -> Result<T, ToolError>
    where
        T: Send + 'static,
        F: Future<Output = Result<T, ToolError>> + Send + 'static,
    {
        let service_permit = self.operations.admit();
        let session_operation_permit = session_operations.admit();
        let (result_tx, result_rx) = oneshot::channel();
        tokio::spawn(async move {
            let _ownership = (service_permit, session_operation_permit, session_permit);
            let _ = result_tx.send(operation.await);
        });
        let _cancel_if_abandoned = CancelOperationOnDrop(cancelled);
        result_rx.await.map_err(|_| {
            ToolError::new(
                "closed",
                "endpoint tool operation owner stopped before reporting a result",
            )
        })?
    }

    async fn install_with_env(
        self: &Arc<Self>,
        target: ToolTarget,
        env: &BTreeMap<String, String>,
        cancelled: CancellationToken,
        shutdown: CancellationToken,
    ) -> Result<ToolInstallResult, ToolError> {
        self.install_with_env_and_check_timeout(target, env, cancelled, shutdown, CHECK_TIMEOUT)
            .await
    }

    async fn install_with_env_and_check_timeout(
        self: &Arc<Self>,
        target: ToolTarget,
        env: &BTreeMap<String, String>,
        cancelled: CancellationToken,
        shutdown: CancellationToken,
        reconciliation_timeout: Duration,
    ) -> Result<ToolInstallResult, ToolError> {
        let policy = policy_for(&target.tool).ok_or_else(|| {
            ToolError::new("unsupported_tool", "tool is not in the endpoint policy")
        })?;
        let install = policy.install.ok_or_else(|| {
            ToolError::new("install_unavailable", "tool has no endpoint install policy")
        })?;
        let _claim = self.claim_install(policy.tool)?;
        if cancelled.is_cancelled() || shutdown.is_cancelled() {
            return Err(ToolError::new("cancelled", "tool install was cancelled"));
        }
        let (program, args) = install_argv(install);
        let resolved = resolve_executable(program, env).ok_or_else(|| {
            ToolError::new(
                "installer_unavailable",
                format!("endpoint could not resolve allowlisted installer {program}"),
            )
        })?;
        self.require_reconciliation(policy.tool)?;
        let capture = match run_program_capture(
            Arc::clone(&self.processes),
            Arc::clone(&self.residue_supervisor),
            Arc::clone(&self.lifecycle_hooks),
            &resolved,
            &args,
            env,
            ProgramCancellation {
                timeout: INSTALL_TIMEOUT,
                request: &cancelled,
                shutdown: &shutdown,
            },
        )
        .await
        {
            Ok(capture) => capture,
            Err(error) => {
                self.clear_reconciliation_after_pre_effect_failure(policy.tool)?;
                return Err(error);
            }
        };
        let install_argv = std::iter::once(program.to_string())
            .chain(args.iter().map(|arg| (*arg).to_string()))
            .collect::<Vec<_>>();
        let command = vec![policy.executable.to_string()];
        let execution_uncertain = capture.failure.is_some();
        let mut result = ToolInstallResult {
            target_id: target.target_id.clone(),
            tool: target.tool.clone(),
            command,
            install_argv,
            outcome: "unknown",
            success: false,
            exit_code: capture.status.and_then(|status| status.code()),
            stdout: capture.stdout.text,
            stderr: capture.stderr.text,
            output_truncated: capture.stdout.truncated || capture.stderr.truncated,
            error: capture
                .failure
                .map(|failure| bounded(failure, MAX_DETAIL_BYTES)),
            status: None,
        };
        if execution_uncertain || !capture.status.is_some_and(|status| status.success()) {
            result.error.get_or_insert_with(|| {
                "installer exited without a definitive successful outcome".to_string()
            });
            return Ok(result);
        }

        match self
            .check_one_with_timeout(target, env, &cancelled, &shutdown, reconciliation_timeout)
            .await
        {
            Ok(status)
                if status.installed
                    && status.error.is_none()
                    && status.version.is_some()
                    && status.latest_version.is_some()
                    && status.update_available == Some(false) =>
            {
                result.outcome = "succeeded";
                result.success = true;
                result.status = Some(status);
            }
            Ok(status) => {
                result.error = Some(
                    "installer exited successfully but endpoint reconciliation did not positively observe the required version"
                        .into(),
                );
                result.status = Some(status);
            }
            Err(error) => result.error = Some(error.detail),
        }
        Ok(result)
    }

    fn claim_install(self: &Arc<Self>, tool: &'static str) -> Result<InstallClaim, ToolError> {
        let mut state = self
            .install_state
            .lock()
            .map_err(|_| ToolError::new("closed", "tool install registry is unavailable"))?;
        if !state.active.insert(tool) {
            return Err(ToolError::new(
                "tool_busy",
                "an install for this tool is already active",
            ));
        }
        if state.reconciliation_required.contains(tool) {
            state.active.remove(tool);
            return Err(ToolError::new(
                "reconciliation_required",
                "a prior interactive install must be reconciled by endpoint check",
            ));
        }
        Ok(InstallClaim {
            tool,
            service: Arc::clone(self),
        })
    }

    pub(crate) fn claim_legacy_install(
        self: &Arc<Self>,
        tool: &str,
    ) -> Result<Option<InstallClaim>, ToolError> {
        let Some(policy) = policy_for(tool) else {
            return Ok(None);
        };
        self.claim_install(policy.tool).map(Some)
    }

    pub(crate) fn claim_legacy_executable_install(
        self: &Arc<Self>,
        executable: &str,
    ) -> Result<Option<InstallClaim>, ToolError> {
        let Some(policy) = POLICIES
            .iter()
            .copied()
            .find(|policy| policy.executable == executable)
        else {
            return Ok(None);
        };
        self.claim_install(policy.tool).map(Some)
    }

    fn require_reconciliation(&self, tool: &'static str) -> Result<(), ToolError> {
        let mut state = self
            .install_state
            .lock()
            .map_err(|_| ToolError::new("closed", "tool install registry is unavailable"))?;
        let generation = state.effect_generation.entry(tool).or_default();
        *generation = generation.checked_add(1).ok_or_else(|| {
            ToolError::new(
                "closed",
                "tool effect generation exhausted; restart the endpoint before installing",
            )
        })?;
        state.reconciliation_required.insert(tool);
        Ok(())
    }

    fn clear_reconciliation_after_pre_effect_failure(
        &self,
        tool: &'static str,
    ) -> Result<(), ToolError> {
        let mut state = self
            .install_state
            .lock()
            .map_err(|_| ToolError::new("closed", "tool install registry is unavailable"))?;
        state.reconciliation_required.remove(tool);
        Ok(())
    }

    fn begin_reconciliation_check(
        &self,
        tool: &str,
    ) -> Result<Option<ReconciliationCheck>, ToolError> {
        let Some(tool) = policy_for(tool).map(|policy| policy.tool) else {
            return Ok(None);
        };
        let state = self
            .install_state
            .lock()
            .map_err(|_| ToolError::new("closed", "tool install registry is unavailable"))?;
        if state.active.contains(tool) {
            return Ok(None);
        }
        Ok(Some(ReconciliationCheck {
            tool,
            effect_generation: state
                .effect_generation
                .get(tool)
                .copied()
                .unwrap_or_default(),
        }))
    }

    fn complete_reconciliation_check(
        &self,
        reconciliation: Option<ReconciliationCheck>,
    ) -> Result<(), ToolError> {
        let Some(reconciliation) = reconciliation else {
            return Ok(());
        };
        let mut state = self
            .install_state
            .lock()
            .map_err(|_| ToolError::new("closed", "tool install registry is unavailable"))?;
        let generation = state
            .effect_generation
            .get(reconciliation.tool)
            .copied()
            .unwrap_or_default();
        if !state.active.contains(reconciliation.tool)
            && generation == reconciliation.effect_generation
            && self.residue_supervisor.is_idle()
        {
            state.reconciliation_required.remove(reconciliation.tool);
        }
        Ok(())
    }

    async fn check_one(
        &self,
        target: ToolTarget,
        env: &BTreeMap<String, String>,
        cancelled: &CancellationToken,
        shutdown: &CancellationToken,
    ) -> Result<ToolStatus, ToolError> {
        self.check_one_with_timeout(target, env, cancelled, shutdown, CHECK_TIMEOUT)
            .await
    }

    async fn check_one_with_timeout(
        &self,
        target: ToolTarget,
        env: &BTreeMap<String, String>,
        cancelled: &CancellationToken,
        shutdown: &CancellationToken,
        check_timeout: Duration,
    ) -> Result<ToolStatus, ToolError> {
        let policy = policy_for(&target.tool).ok_or_else(|| {
            ToolError::new("unsupported_tool", "tool is not in the endpoint policy")
        })?;
        let command = vec![policy.executable.to_string()];
        let Some(path) = resolve_executable(policy.executable, env) else {
            let latest_version = match self
                .latest_version(policy.latest, env, cancelled, shutdown, check_timeout)
                .await
            {
                Ok(latest) => latest,
                Err(error) => {
                    return Ok(failed_tool_status(target, command, error.detail));
                }
            };
            return Ok(ToolStatus {
                target_id: target.target_id,
                tool: target.tool,
                command,
                installed: false,
                path: None,
                version: None,
                latest_version,
                update_available: None,
                error: None,
            });
        };
        let capture = run_program_capture(
            Arc::clone(&self.processes),
            Arc::clone(&self.residue_supervisor),
            Arc::clone(&self.lifecycle_hooks),
            &path,
            policy.version_args,
            env,
            ProgramCancellation {
                timeout: check_timeout,
                request: cancelled,
                shutdown,
            },
        )
        .await?;
        let version = first_meaningful_line(&capture.stdout.text)
            .or_else(|| first_meaningful_line(&capture.stderr.text));
        let error = if let Some(failure) = capture.failure {
            Some(failure)
        } else if capture.stdout.truncated || capture.stderr.truncated {
            Some("version command output exceeded the conservative bound".into())
        } else if !capture.status.is_some_and(|status| status.success()) {
            Some(format!(
                "version command exited with code {}",
                capture
                    .status
                    .and_then(|status| status.code())
                    .map_or_else(|| "unknown".into(), |code| code.to_string())
            ))
        } else if version.as_deref().and_then(numeric_version).is_none() {
            Some("version command did not report a recognizable version".into())
        } else {
            None
        };
        if let Some(error) = error {
            return Ok(ToolStatus {
                target_id: target.target_id,
                tool: target.tool,
                command,
                installed: false,
                path: None,
                version: None,
                latest_version: None,
                update_available: None,
                error: Some(bounded(error, MAX_DETAIL_BYTES)),
            });
        }
        let latest_version = match self
            .latest_version(policy.latest, env, cancelled, shutdown, check_timeout)
            .await
        {
            Ok(latest) => latest,
            Err(error) => {
                return Ok(failed_tool_status(target, command, error.detail));
            }
        };
        let update_available = match (version.as_deref(), latest_version.as_deref()) {
            (Some(installed), Some(latest)) => version_suggests_update(installed, latest),
            _ => None,
        };
        Ok(ToolStatus {
            target_id: target.target_id,
            tool: target.tool,
            command,
            installed: true,
            path: Some(bounded(path.to_string_lossy(), MAX_PATH_BYTES)),
            version,
            latest_version,
            update_available,
            error: None,
        })
    }

    async fn latest_version(
        &self,
        policy: Option<LatestPolicy>,
        env: &BTreeMap<String, String>,
        cancelled: &CancellationToken,
        shutdown: &CancellationToken,
        timeout: Duration,
    ) -> Result<Option<String>, ToolError> {
        let Some(policy) = policy else {
            return Ok(None);
        };
        let (program, args, pip_package) = match policy {
            LatestPolicy::Npm(package) => ("npm", vec!["view", package, "version"], None),
            LatestPolicy::Pip(package) => (
                "python3",
                vec!["-m", "pip", "index", "versions", package],
                Some(package),
            ),
        };
        let path = resolve_executable(program, env).ok_or_else(|| {
            ToolError::new(
                "probe_unavailable",
                format!("endpoint could not resolve allowlisted latest-version probe {program}"),
            )
        })?;
        let capture = run_program_capture(
            Arc::clone(&self.processes),
            Arc::clone(&self.residue_supervisor),
            Arc::clone(&self.lifecycle_hooks),
            &path,
            &args,
            env,
            ProgramCancellation {
                timeout,
                request: cancelled,
                shutdown,
            },
        )
        .await?;
        if let Some(failure) = capture.failure {
            return Err(ToolError::new("probe_failed", failure));
        }
        if !capture.status.is_some_and(|status| status.success()) {
            return Err(ToolError::new(
                "probe_failed",
                "latest-version probe did not exit successfully",
            ));
        }
        if capture.stdout.truncated || capture.stderr.truncated {
            return Err(ToolError::new(
                "probe_failed",
                "latest-version probe output exceeded the conservative bound",
            ));
        }
        let version = match pip_package {
            Some(package) => parse_pip_latest_version(package, &capture.stdout.text),
            None => first_meaningful_line(&capture.stdout.text),
        };
        if version.as_deref().and_then(numeric_version).is_none() {
            return Err(ToolError::new(
                "probe_failed",
                "latest-version probe did not report a recognizable version",
            ));
        }
        Ok(version)
    }
}

fn failed_tool_status(target: ToolTarget, command: Vec<String>, detail: String) -> ToolStatus {
    ToolStatus {
        target_id: target.target_id,
        tool: target.tool,
        command,
        installed: false,
        path: None,
        version: None,
        latest_version: None,
        update_available: None,
        error: Some(bounded(detail, MAX_DETAIL_BYTES)),
    }
}

pub(crate) struct InstallClaim {
    tool: &'static str,
    service: Arc<HostToolService>,
}

impl InstallClaim {
    /// Mark the point immediately before a compatibility installer may begin
    /// changing endpoint state. Once marked, no install path may retry this
    /// tool until an independent endpoint-owned check observes a definitive
    /// status. This remains true even if the legacy acknowledgement is lost.
    pub(crate) fn mark_effect_started(&self) -> Result<(), ToolError> {
        self.service.require_reconciliation(self.tool)
    }

    /// A launch failure proven to have happened before the compatibility
    /// process existed cannot have changed tool state.
    pub(crate) fn clear_pre_effect_failure(&self) -> Result<(), ToolError> {
        self.service
            .clear_reconciliation_after_pre_effect_failure(self.tool)
    }
}

impl Drop for InstallClaim {
    fn drop(&mut self) {
        if let Ok(mut state) = self.service.install_state.lock() {
            state.active.remove(self.tool);
        }
    }
}

fn definitive_status(status: &ToolStatus) -> bool {
    if status.error.is_some() {
        return false;
    }
    if !status.installed {
        return true;
    }
    status.path.is_some()
        && status.version.is_some()
        && status.latest_version.is_some()
        && status.update_available.is_some()
}

fn endpoint_command_env() -> BTreeMap<String, String> {
    endpoint_command_env_from(std::env::vars().collect())
}

fn endpoint_command_env_from(mut env: BTreeMap<String, String>) -> BTreeMap<String, String> {
    env.remove("NO_COLOR");
    env.insert("TERM".into(), "xterm-256color".into());
    env.insert("COLORTERM".into(), "truecolor".into());
    env.entry("CLICOLOR".into()).or_insert_with(|| "1".into());

    // Interactive tool policy must never source a login/interactive shell.
    // Prepend only fixed, endpoint-local user-bin conventions to the service
    // PATH, preserving its existing entries without executing a probe.
    let mut preferred = Vec::new();
    if let Some(home) = env.get("HOME").filter(|value| !value.is_empty()) {
        let home = PathBuf::from(home);
        preferred.extend([
            home.join(".local/bin"),
            home.join("bin"),
            home.join(".bun/bin"),
            home.join(".cargo/bin"),
        ]);
    }
    preferred.extend(
        env.get("PATH")
            .map(|path| std::env::split_paths(path).collect::<Vec<_>>())
            .unwrap_or_default(),
    );
    let mut seen = HashSet::new();
    preferred.retain(|entry| !entry.as_os_str().is_empty() && seen.insert(entry.clone()));
    if let Ok(path) = std::env::join_paths(preferred) {
        env.insert("PATH".into(), path.to_string_lossy().into_owned());
    }
    env
}

fn validate_target(target: &ToolTarget) -> Result<(), ToolError> {
    if target.target_id.is_empty()
        || target.target_id.len() > MAX_TARGET_ID_BYTES
        || !target
            .target_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(ToolError::new("invalid_request", "invalid tool target ID"));
    }
    if target.tool.is_empty()
        || target.tool.len() > MAX_TOOL_BYTES
        || !target
            .tool
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(ToolError::new("invalid_request", "invalid tool kind"));
    }
    if policy_for(&target.tool).is_none() {
        return Err(ToolError::new(
            "unsupported_tool",
            "tool is not in the endpoint policy",
        ));
    }
    Ok(())
}

fn install_argv(policy: InstallPolicy) -> (&'static str, Vec<&'static str>) {
    match policy {
        InstallPolicy::Npm(package) => ("npm", vec!["install", "--global", package]),
        InstallPolicy::Pip(package) => (
            "python3",
            vec!["-m", "pip", "install", "--user", "--upgrade", package],
        ),
    }
}

fn resolve_executable(program: &str, env: &BTreeMap<String, String>) -> Option<PathBuf> {
    if program.is_empty()
        || program.contains('/')
        || program.contains('\\')
        || !program
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'+'))
    {
        return None;
    }
    let path = env.get("PATH")?;
    for directory in std::env::split_paths(path) {
        let candidate = directory.join(program);
        let Ok(metadata) = std::fs::metadata(&candidate) else {
            continue;
        };
        if !metadata.is_file() || !is_executable(&metadata) {
            continue;
        }
        if let Ok(canonical) = candidate.canonicalize() {
            return Some(canonical);
        }
    }
    None
}

#[cfg(unix)]
fn is_executable(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_metadata: &std::fs::Metadata) -> bool {
    true
}

#[derive(Debug)]
struct TailCapture {
    text: String,
    truncated: bool,
}

#[derive(Debug)]
struct ProgramCapture {
    status: Option<ExitStatus>,
    stdout: TailCapture,
    stderr: TailCapture,
    failure: Option<String>,
}

#[cfg(target_os = "linux")]
struct ToolSandbox {
    ruleset: File,
}

#[cfg(target_os = "linux")]
impl ToolSandbox {
    fn create(env: &BTreeMap<String, String>) -> Result<Self, ToolError> {
        const LANDLOCK_CREATE_RULESET_VERSION: u32 = 1;
        const LANDLOCK_RULE_PATH_BENEATH: i32 = 1;
        const WRITE_FILE: u64 = 1 << 1;
        const REMOVE_DIR: u64 = 1 << 4;
        const REMOVE_FILE: u64 = 1 << 5;
        const MAKE_CHAR: u64 = 1 << 6;
        const MAKE_DIR: u64 = 1 << 7;
        const MAKE_REG: u64 = 1 << 8;
        const MAKE_SOCK: u64 = 1 << 9;
        const MAKE_FIFO: u64 = 1 << 10;
        const MAKE_BLOCK: u64 = 1 << 11;
        const MAKE_SYM: u64 = 1 << 12;
        const REFER: u64 = 1 << 13;
        const TRUNCATE: u64 = 1 << 14;

        #[repr(C)]
        struct RulesetAttr {
            handled_access_fs: u64,
        }
        #[repr(C)]
        struct PathBeneathAttr {
            allowed_access: u64,
            parent_fd: i32,
        }

        let abi = unsafe {
            nix::libc::syscall(
                nix::libc::SYS_landlock_create_ruleset,
                std::ptr::null::<RulesetAttr>(),
                0usize,
                LANDLOCK_CREATE_RULESET_VERSION,
            )
        };
        if abi < 3 {
            return Err(ToolError::new(
                "containment_unavailable",
                "endpoint requires Landlock ABI 3 or newer for tool filesystem confinement",
            ));
        }
        let mut handled_access_fs = WRITE_FILE
            | REMOVE_DIR
            | REMOVE_FILE
            | MAKE_CHAR
            | MAKE_DIR
            | MAKE_REG
            | MAKE_SOCK
            | MAKE_FIFO
            | MAKE_BLOCK
            | MAKE_SYM
            | REFER
            | TRUNCATE;
        // The first three ABIs contain every mutation right used here. Do not
        // request newer rights unless their semantics are reviewed.
        if abi < 2 {
            handled_access_fs &= !REFER;
        }
        if abi < 3 {
            handled_access_fs &= !TRUNCATE;
        }
        let attr = RulesetAttr { handled_access_fs };
        let fd = unsafe {
            nix::libc::syscall(
                nix::libc::SYS_landlock_create_ruleset,
                &attr as *const RulesetAttr,
                std::mem::size_of::<RulesetAttr>(),
                0u32,
            )
        };
        if fd < 0 {
            return Err(ToolError::new(
                "containment_unavailable",
                format!(
                    "endpoint cannot create the tool Landlock ruleset: {}",
                    std::io::Error::last_os_error()
                ),
            ));
        }
        let ruleset = unsafe { File::from_raw_fd(fd as i32) };
        set_close_on_exec(&ruleset).map_err(|error| {
            ToolError::new(
                "containment_unavailable",
                format!("endpoint cannot protect the tool Landlock descriptor: {error}"),
            )
        })?;

        let mut writable_roots = HashMap::new();
        for path in [
            Some(PathBuf::from("/tmp")),
            Some(PathBuf::from("/var/tmp")),
            env.get("HOME").map(PathBuf::from),
            env.get("TMPDIR").map(PathBuf::from),
            env.get("XDG_CACHE_HOME").map(PathBuf::from),
            env.get("XDG_CONFIG_HOME").map(PathBuf::from),
            env.get("XDG_DATA_HOME").map(PathBuf::from),
            env.get("XDG_STATE_HOME").map(PathBuf::from),
            env.get("XDG_RUNTIME_DIR").map(PathBuf::from),
        ]
        .into_iter()
        .flatten()
        {
            let canonical = path.canonicalize().map_err(|error| {
                ToolError::new(
                    "containment_unavailable",
                    format!(
                        "endpoint cannot resolve a tool sandbox writable root {}: {error}",
                        path.display()
                    ),
                )
            })?;
            if canonical == Path::new("/") || canonical.starts_with("/sys") {
                return Err(ToolError::new(
                    "containment_unavailable",
                    "tool sandbox writable roots cannot include the filesystem or cgroup hierarchy root",
                ));
            }
            writable_roots.insert(canonical, (handled_access_fs, true));
        }
        let dev_null = PathBuf::from("/dev/null").canonicalize().map_err(|error| {
            ToolError::new(
                "containment_unavailable",
                format!("endpoint cannot resolve /dev/null for tool confinement: {error}"),
            )
        })?;
        writable_roots.insert(dev_null, (WRITE_FILE | TRUNCATE, false));
        for (path, (allowed_access, directory)) in writable_roots {
            let c_path = CString::new(path.as_os_str().as_encoded_bytes()).map_err(|_| {
                ToolError::new(
                    "containment_unavailable",
                    "tool sandbox writable root contains an invalid NUL byte",
                )
            })?;
            let path_fd = unsafe {
                nix::libc::open(
                    c_path.as_ptr(),
                    nix::libc::O_PATH
                        | nix::libc::O_CLOEXEC
                        | if directory { nix::libc::O_DIRECTORY } else { 0 },
                )
            };
            if path_fd < 0 {
                return Err(ToolError::new(
                    "containment_unavailable",
                    format!(
                        "endpoint cannot open tool sandbox writable root {}: {}",
                        path.display(),
                        std::io::Error::last_os_error()
                    ),
                ));
            }
            let path_fd = unsafe { File::from_raw_fd(path_fd) };
            let path_attr = PathBeneathAttr {
                allowed_access,
                parent_fd: path_fd.as_raw_fd(),
            };
            let result = unsafe {
                nix::libc::syscall(
                    nix::libc::SYS_landlock_add_rule,
                    ruleset.as_raw_fd(),
                    LANDLOCK_RULE_PATH_BENEATH,
                    &path_attr as *const PathBeneathAttr,
                    0u32,
                )
            };
            if result != 0 {
                return Err(ToolError::new(
                    "containment_unavailable",
                    format!(
                        "endpoint cannot add tool sandbox writable root {}: {}",
                        path.display(),
                        std::io::Error::last_os_error()
                    ),
                ));
            }
        }
        Ok(Self { ruleset })
    }

    fn attach(self, command: &mut Command) {
        let ruleset = self.ruleset;
        unsafe {
            command.pre_exec(move || {
                if nix::libc::prctl(nix::libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if nix::libc::syscall(
                    nix::libc::SYS_landlock_restrict_self,
                    ruleset.as_raw_fd(),
                    0u32,
                ) != 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                if nix::libc::syscall(
                    nix::libc::SYS_close_range,
                    3u32,
                    u32::MAX,
                    nix::libc::CLOSE_RANGE_CLOEXEC,
                ) != 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                install_tool_seccomp_filter()?;
                Ok(())
            });
        }
    }
}

#[cfg(target_os = "linux")]
fn set_close_on_exec(file: &File) -> std::io::Result<()> {
    let flags = unsafe { nix::libc::fcntl(file.as_raw_fd(), nix::libc::F_GETFD) };
    if flags < 0 {
        return Err(std::io::Error::last_os_error());
    }
    if unsafe {
        nix::libc::fcntl(
            file.as_raw_fd(),
            nix::libc::F_SETFD,
            flags | nix::libc::FD_CLOEXEC,
        )
    } < 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const TOOL_AUDIT_ARCH: u32 = 0xc000_003e;
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const TOOL_AUDIT_ARCH: u32 = 0xc000_00b7;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const X32_SYSCALL_BIT: u32 = 0x4000_0000;

#[cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
const BPF_LD_W_ABS: u16 = 0x20;
#[cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
const BPF_ALU_AND_K: u16 = 0x54;
#[cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
const BPF_JMP_JEQ_K: u16 = 0x15;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const BPF_JMP_JSET_K: u16 = 0x45;
#[cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
const BPF_RET_K: u16 = 0x06;
#[cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;
#[cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
#[cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
#[cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
const SECCOMP_NR_OFFSET: u32 = 0;
#[cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
const SECCOMP_ARCH_OFFSET: u32 = 4;
#[cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
const SECCOMP_ARG0_OFFSET: u32 = 16;

#[cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
fn install_tool_seccomp_filter() -> std::io::Result<()> {
    let mut filters = tool_seccomp_filter();
    let program = nix::libc::sock_fprog {
        len: filters.len().try_into().map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "seccomp filter too large")
        })?,
        filter: filters.as_mut_ptr(),
    };
    if unsafe {
        nix::libc::prctl(
            nix::libc::PR_SET_SECCOMP,
            nix::libc::SECCOMP_MODE_FILTER,
            &program as *const nix::libc::sock_fprog,
        )
    } != 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
fn tool_seccomp_filter() -> Vec<nix::libc::sock_filter> {
    fn stmt(code: u16, k: u32) -> nix::libc::sock_filter {
        nix::libc::sock_filter {
            code,
            jt: 0,
            jf: 0,
            k,
        }
    }
    fn jump(code: u16, k: u32, jt: u8, jf: u8) -> nix::libc::sock_filter {
        nix::libc::sock_filter { code, jt, jf, k }
    }
    fn deny(filters: &mut Vec<nix::libc::sock_filter>, syscall: i64, errno: i32) {
        filters.push(jump(BPF_JMP_JEQ_K, syscall as u32, 0, 1));
        filters.push(stmt(BPF_RET_K, SECCOMP_RET_ERRNO | errno as u32));
    }

    let mut filters = vec![
        stmt(BPF_LD_W_ABS, SECCOMP_ARCH_OFFSET),
        jump(BPF_JMP_JEQ_K, TOOL_AUDIT_ARCH, 1, 0),
        stmt(BPF_RET_K, SECCOMP_RET_KILL_PROCESS),
        stmt(BPF_LD_W_ABS, SECCOMP_NR_OFFSET),
    ];
    #[cfg(target_arch = "x86_64")]
    {
        // x32 uses the x86_64 audit architecture with this tag in the syscall
        // number. Reject it before any native-number dispatch or default allow.
        filters.push(jump(BPF_JMP_JSET_K, X32_SYSCALL_BIT, 0, 1));
        filters.push(stmt(BPF_RET_K, SECCOMP_RET_KILL_PROCESS));
    }
    deny(&mut filters, nix::libc::SYS_clone3, nix::libc::ENOSYS);
    let namespace_flags = (nix::libc::CLONE_NEWNS
        | nix::libc::CLONE_NEWCGROUP
        | nix::libc::CLONE_NEWUTS
        | nix::libc::CLONE_NEWIPC
        | nix::libc::CLONE_NEWUSER
        | nix::libc::CLONE_NEWPID
        | nix::libc::CLONE_NEWNET
        | nix::libc::CLONE_NEWTIME) as u32;
    filters.push(jump(BPF_JMP_JEQ_K, nix::libc::SYS_clone as u32, 0, 4));
    filters.push(stmt(BPF_LD_W_ABS, SECCOMP_ARG0_OFFSET));
    filters.push(stmt(BPF_ALU_AND_K, namespace_flags));
    filters.push(jump(BPF_JMP_JEQ_K, 0, 1, 0));
    filters.push(stmt(BPF_RET_K, SECCOMP_RET_ERRNO | nix::libc::EPERM as u32));
    filters.push(stmt(BPF_LD_W_ABS, SECCOMP_NR_OFFSET));
    for syscall in [
        nix::libc::SYS_unshare,
        nix::libc::SYS_setns,
        nix::libc::SYS_mount,
        nix::libc::SYS_umount2,
        nix::libc::SYS_pivot_root,
        nix::libc::SYS_chroot,
        nix::libc::SYS_open_tree,
        nix::libc::SYS_move_mount,
        nix::libc::SYS_fsopen,
        nix::libc::SYS_fsmount,
        nix::libc::SYS_ptrace,
        nix::libc::SYS_process_vm_readv,
        nix::libc::SYS_process_vm_writev,
        nix::libc::SYS_pidfd_getfd,
        nix::libc::SYS_bpf,
        nix::libc::SYS_perf_event_open,
        nix::libc::SYS_io_uring_setup,
        nix::libc::SYS_userfaultfd,
        nix::libc::SYS_kcmp,
    ] {
        deny(&mut filters, syscall, nix::libc::EPERM);
    }
    for syscall in [nix::libc::SYS_socket, nix::libc::SYS_socketpair] {
        filters.push(jump(BPF_JMP_JEQ_K, syscall as u32, 0, 3));
        filters.push(stmt(BPF_LD_W_ABS, SECCOMP_ARG0_OFFSET));
        filters.push(jump(BPF_JMP_JEQ_K, nix::libc::AF_UNIX as u32, 0, 1));
        filters.push(stmt(BPF_RET_K, SECCOMP_RET_ERRNO | nix::libc::EPERM as u32));
        filters.push(stmt(BPF_LD_W_ABS, SECCOMP_NR_OFFSET));
    }
    filters.push(stmt(BPF_RET_K, SECCOMP_RET_ALLOW));
    filters
}

#[cfg(all(
    target_os = "linux",
    not(any(target_arch = "x86_64", target_arch = "aarch64"))
))]
fn install_tool_seccomp_filter() -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "interactive tool execution requires a reviewed seccomp architecture",
    ))
}

#[cfg(not(target_os = "linux"))]
struct ToolSandbox;

#[cfg(not(target_os = "linux"))]
impl ToolSandbox {
    fn create(_env: &BTreeMap<String, String>) -> Result<Self, ToolError> {
        Err(ToolError::new(
            "containment_unavailable",
            "interactive tool execution requires reviewed Linux filesystem and syscall confinement",
        ))
    }

    fn attach(self, _command: &mut Command) {}
}

#[cfg(target_os = "linux")]
struct ContainmentInventory {
    pids: HashSet<i32>,
    error: Option<String>,
}

#[cfg(target_os = "linux")]
struct ToolContainment {
    path: PathBuf,
    cleaned: bool,
    reap_pids: HashSet<i32>,
    reaped_owned_pid: Option<i32>,
    pending_child: Option<Child>,
    pending_inventory: Option<tokio::task::JoinHandle<ContainmentInventory>>,
    pending_removal: Option<tokio::task::JoinHandle<Result<(), String>>>,
    lifecycle_hooks: Arc<HostToolLifecycleHooks>,
}

#[cfg(target_os = "linux")]
fn current_cgroup_path() -> Result<PathBuf, String> {
    let membership = std::fs::read_to_string("/proc/self/cgroup")
        .map_err(|error| format!("endpoint cannot read its cgroup membership: {error}"))?;
    let relative = membership
        .lines()
        .find_map(|line| line.strip_prefix("0::"))
        .filter(|value| {
            value.starts_with('/') && !value.contains("..") && !value.contains(" (deleted)")
        })
        .ok_or_else(|| "endpoint is not running in a reviewed cgroup v2 hierarchy".to_string())?;
    let mount = Path::new("/sys/fs/cgroup");
    let path = mount.join(relative.trim_start_matches('/'));
    let canonical = std::fs::canonicalize(&path)
        .map_err(|error| format!("endpoint cannot resolve its cgroup membership: {error}"))?;
    if !canonical.starts_with(mount) {
        return Err("endpoint cgroup membership escaped the cgroup v2 mount".into());
    }
    Ok(canonical)
}

#[cfg(target_os = "linux")]
fn service_cgroup_root(current: &Path) -> Result<PathBuf, String> {
    if current.file_name().and_then(|name| name.to_str()) == Some(TOOL_CGROUP_MANAGER_NAME) {
        current
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "endpoint manager cgroup has no delegated parent".to_string())
    } else if current
        .components()
        .any(|part| part.as_os_str() == TOOL_CGROUP_ATTEMPTS_NAME)
    {
        Err("endpoint process is inside the tool-attempt cgroup subtree".into())
    } else {
        Ok(current.to_path_buf())
    }
}

#[cfg(target_os = "linux")]
fn validate_cgroup_owner(path: &Path, label: &str) -> Result<(), String> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| format!("cannot inspect {label} cgroup ownership: {error}"))?;
    let endpoint_uid = unsafe { nix::libc::geteuid() };
    if !metadata.is_dir() || metadata.uid() != endpoint_uid {
        return Err(format!(
            "{label} cgroup is not owned by the endpoint uid {endpoint_uid}"
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn cgroup_has_token(path: &Path, file: &str, token: &str) -> Result<bool, String> {
    let contents = std::fs::read_to_string(path.join(file))
        .map_err(|error| format!("cannot read {file} for {}: {error}", path.display()))?;
    Ok(contents.split_whitespace().any(|value| value == token))
}

#[cfg(target_os = "linux")]
fn ensure_pids_subtree_control(path: &Path, label: &str) -> Result<(), String> {
    if !cgroup_has_token(path, "cgroup.controllers", "pids")? {
        return Err(format!(
            "{label} cgroup was not delegated the pids controller"
        ));
    }
    if !cgroup_has_token(path, "cgroup.subtree_control", "pids")? {
        std::fs::write(path.join("cgroup.subtree_control"), b"+pids\n")
            .map_err(|error| format!("cannot enable pids for {label} cgroup: {error}"))?;
    }
    if !cgroup_has_token(path, "cgroup.subtree_control", "pids")? {
        return Err(format!(
            "{label} cgroup did not retain pids subtree delegation"
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn read_manager_cgroup_pids(path: &Path) -> Result<Vec<i32>, String> {
    let file = File::open(path.join("cgroup.procs"))
        .map_err(|error| format!("cannot read delegated service cgroup processes: {error}"))?;
    let mut contents = String::new();
    file.take(MAX_MANAGER_CGROUP_PID_BYTES + 1)
        .read_to_string(&mut contents)
        .map_err(|error| format!("cannot read delegated service cgroup processes: {error}"))?;
    if contents.len() as u64 > MAX_MANAGER_CGROUP_PID_BYTES {
        return Err("delegated service cgroup process inventory exceeded its byte limit".into());
    }
    let mut pids = Vec::new();
    for raw in contents.lines() {
        let pid = raw
            .parse::<i32>()
            .ok()
            .filter(|pid| *pid > 0)
            .ok_or_else(|| "delegated service cgroup reported an invalid PID".to_string())?;
        if !pids.contains(&pid) {
            if pids.len() >= MAX_MANAGER_CGROUP_PIDS {
                return Err("delegated service cgroup process inventory exceeded its limit".into());
            }
            pids.push(pid);
        }
    }
    Ok(pids)
}

#[cfg(target_os = "linux")]
fn move_service_processes_to_manager(root: &Path, manager: &Path) -> Result<(), String> {
    for _ in 0..16 {
        let pids = read_manager_cgroup_pids(root)?;
        if pids.is_empty() {
            return Ok(());
        }
        for pid in pids {
            if let Err(error) = std::fs::write(manager.join("cgroup.procs"), format!("{pid}\n")) {
                if error.raw_os_error() != Some(nix::libc::ESRCH) {
                    return Err(format!(
                        "cannot move service process {pid} into the manager leaf: {error}"
                    ));
                }
            }
        }
    }
    if read_manager_cgroup_pids(root)?.is_empty() {
        Ok(())
    } else {
        Err("delegated service cgroup remained internally populated".into())
    }
}

#[cfg(target_os = "linux")]
fn stale_tool_attempt_paths(attempts: &Path) -> Result<Vec<PathBuf>, String> {
    let entries = std::fs::read_dir(attempts)
        .map_err(|error| format!("cannot inspect prior tool-attempt cgroups: {error}"))?;
    let mut entries_seen = 0;
    let mut paths = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("cannot inspect prior tool attempt: {error}"))?;
        if !entry
            .file_type()
            .map_err(|error| format!("cannot inspect prior tool-attempt type: {error}"))?
            .is_dir()
        {
            continue;
        }
        entries_seen += 1;
        if entries_seen > MAX_CONTAINMENT_TREE_ENTRIES {
            return Err("prior tool-attempt inventory exceeded its entry limit".into());
        }
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with("spawn-tool-") {
            return Err(format!(
                "delegated attempts subtree contains an unowned cgroup {}",
                name.to_string_lossy()
            ));
        }
        paths.push(entry.path());
    }
    Ok(paths)
}

#[cfg(target_os = "linux")]
fn cleanup_stale_tool_attempts(
    attempts: &Path,
    deadline: tokio::time::Instant,
) -> Result<(), String> {
    for path in stale_tool_attempt_paths(attempts)? {
        if tokio::time::Instant::now() >= deadline {
            return Err("prior tool-attempt cleanup exceeded its deadline".into());
        }
        std::fs::write(path.join("cgroup.kill"), b"1\n")
            .map_err(|error| format!("cannot kill a prior tool-attempt cgroup: {error}"))?;
        loop {
            if tokio::time::Instant::now() >= deadline {
                return Err("prior tool-attempt cleanup exceeded its deadline".into());
            }
            let events = std::fs::read_to_string(path.join("cgroup.events"))
                .map_err(|error| format!("cannot read prior tool-attempt state: {error}"))?;
            let populated = events
                .lines()
                .find_map(|line| line.strip_prefix("populated "))
                .ok_or_else(|| "prior tool-attempt state omitted populated".to_string())?;
            if populated == "0" {
                break;
            }
            if populated != "1" {
                return Err("prior tool-attempt state reported invalid populated value".into());
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        remove_cgroup_tree_until(&path, deadline)?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn provision_tool_attempts_root() -> Result<PathBuf, String> {
    let current = current_cgroup_path()?;
    let root = service_cgroup_root(&current)?;
    validate_cgroup_owner(&root, "delegated service")?;

    let manager = root.join(TOOL_CGROUP_MANAGER_NAME);
    let manager_created = match std::fs::create_dir(&manager) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
        Err(error) => return Err(format!("cannot create endpoint manager cgroup: {error}")),
    };
    if let Err(error) = validate_cgroup_owner(&manager, "endpoint manager")
        .and_then(|()| move_service_processes_to_manager(&root, &manager))
    {
        if manager_created {
            let _ = std::fs::remove_dir(&manager);
        }
        return Err(error);
    }
    if current_cgroup_path()? != manager {
        return Err("endpoint did not enter its stable manager cgroup".into());
    }
    ensure_pids_subtree_control(&root, "delegated service")?;

    let attempts = root.join(TOOL_CGROUP_ATTEMPTS_NAME);
    let attempts_created = match std::fs::create_dir(&attempts) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
        Err(error) => return Err(format!("cannot create tool-attempts cgroup: {error}")),
    };
    let setup = validate_cgroup_owner(&attempts, "tool-attempts")
        .and_then(|()| {
            if read_manager_cgroup_pids(&attempts)?.is_empty() {
                Ok(())
            } else {
                Err("tool-attempts cgroup is internally populated".into())
            }
        })
        .and_then(|()| ensure_pids_subtree_control(&attempts, "tool-attempts"))
        .and_then(|()| {
            cleanup_stale_tool_attempts(
                &attempts,
                tokio::time::Instant::now() + TOOL_CGROUP_RECOVERY_TIMEOUT,
            )
        });
    if let Err(error) = setup {
        if attempts_created {
            let _ = std::fs::remove_dir(&attempts);
        }
        return Err(error);
    }
    Ok(attempts)
}

#[cfg(target_os = "linux")]
fn allocate_tool_cgroup() -> Result<PathBuf, String> {
    let mut cached = TOOL_CGROUP_ATTEMPTS_ROOT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let attempts = if let Some(path) = cached.as_ref() {
        validate_cgroup_owner(path, "tool-attempts")?;
        if !cgroup_has_token(path, "cgroup.subtree_control", "pids")? {
            return Err("tool-attempts cgroup lost pids subtree delegation".into());
        }
        path.clone()
    } else {
        let path = provision_tool_attempts_root()?;
        *cached = Some(path.clone());
        path
    };
    for _ in 0..16 {
        let sequence = TOOL_CGROUP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = attempts.join(format!("spawn-tool-{}-{sequence}", std::process::id()));
        match std::fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "endpoint cannot create a delegated tool cgroup: {error}"
                ));
            }
        }
    }
    Err("endpoint could not allocate a unique delegated tool cgroup".into())
}

#[cfg(target_os = "linux")]
impl ToolContainment {
    async fn create(lifecycle_hooks: Arc<HostToolLifecycleHooks>) -> Result<Self, ToolError> {
        static SUBREAPER: OnceLock<Result<(), String>> = OnceLock::new();
        if let Err(error) = SUBREAPER.get_or_init(|| {
            nix::sys::prctl::set_child_subreaper(true)
                .map_err(|failure| format!("cannot enable endpoint child subreaping: {failure}"))
        }) {
            return Err(ToolError::new("containment_unavailable", error.clone()));
        }
        let path = tokio::task::spawn_blocking(allocate_tool_cgroup)
            .await
            .map_err(|error| {
                ToolError::new(
                    "containment_unavailable",
                    format!("endpoint cgroup setup task failed: {error}"),
                )
            })?
            .map_err(|error| ToolError::new("containment_unavailable", error))?;
        Ok(Self {
            path,
            cleaned: false,
            reap_pids: HashSet::new(),
            reaped_owned_pid: None,
            pending_child: None,
            pending_inventory: None,
            pending_removal: None,
            lifecycle_hooks,
        })
    }

    fn validate_files(&self) -> Result<(), ToolError> {
        for name in [
            "cgroup.procs",
            "cgroup.kill",
            "cgroup.freeze",
            "cgroup.events",
            "pids.max",
        ] {
            let path = self.path.join(name);
            if !path.is_file() {
                return Err(ToolError::new(
                    "containment_unavailable",
                    format!("delegated tool cgroup is missing {name}"),
                ));
            }
        }
        OpenOptions::new()
            .write(true)
            .open(self.path.join("cgroup.kill"))
            .map_err(|error| {
                ToolError::new(
                    "containment_unavailable",
                    format!("delegated tool cgroup cannot be killed: {error}"),
                )
            })?;
        let pids_max = self.path.join("pids.max");
        std::fs::write(&pids_max, format!("{MAX_CONTAINMENT_PIDS}\n")).map_err(|error| {
            ToolError::new(
                "containment_unavailable",
                format!("delegated tool cgroup cannot program pids.max: {error}"),
            )
        })?;
        let configured = std::fs::read_to_string(&pids_max).map_err(|error| {
            ToolError::new(
                "containment_unavailable",
                format!("delegated tool cgroup cannot verify pids.max: {error}"),
            )
        })?;
        validate_containment_pids_max(&configured)
    }

    fn membership_file(&self) -> Result<File, ToolError> {
        let file = OpenOptions::new()
            .write(true)
            .open(self.path.join("cgroup.procs"))
            .map_err(|error| {
                ToolError::new(
                    "containment_unavailable",
                    format!("delegated tool cgroup cannot admit a child: {error}"),
                )
            })?;
        set_close_on_exec(&file).map_err(|error| {
            ToolError::new(
                "containment_unavailable",
                format!("tool cgroup admission descriptor is not close-on-exec: {error}"),
            )
        })?;
        Ok(file)
    }

    fn attach(&self, command: &mut Command) -> Result<(), ToolError> {
        use std::os::fd::AsRawFd;

        let membership = self.membership_file()?;
        unsafe {
            command.pre_exec(move || {
                let bytes = b"0\n";
                let written = nix::libc::write(
                    membership.as_raw_fd(),
                    bytes.as_ptr().cast::<nix::libc::c_void>(),
                    bytes.len(),
                );
                if written == bytes.len() as isize {
                    Ok(())
                } else {
                    Err(std::io::Error::last_os_error())
                }
            });
        }
        Ok(())
    }

    fn event(&self, name: &str) -> Result<bool, String> {
        let events = std::fs::read_to_string(self.path.join("cgroup.events"))
            .map_err(|error| format!("cannot read tool containment state: {error}"))?;
        events
            .lines()
            .find_map(|line| line.strip_prefix(&format!("{name} ")))
            .map(|value| value == "1")
            .ok_or_else(|| format!("tool containment state omitted {name}"))
    }

    fn populated(&self) -> Result<bool, String> {
        self.event("populated")
    }

    fn kill_now(&self) -> Result<(), String> {
        std::fs::write(self.path.join("cgroup.kill"), b"1\n")
            .map_err(|error| format!("cannot kill tool containment: {error}"))
    }

    async fn inventory_pids_until(&mut self, deadline: tokio::time::Instant) -> Result<(), String> {
        let mut task = self.pending_inventory.take().unwrap_or_else(|| {
            let path = self.path.clone();
            let lifecycle_hooks = Arc::clone(&self.lifecycle_hooks);
            tokio::spawn(async move {
                lifecycle_hooks.pause_cleanup_inventory_io().await;
                match tokio::task::spawn_blocking(move || {
                    inventory_containment_pids_until(&path, deadline)
                })
                .await
                {
                    Ok(inventory) => inventory,
                    Err(error) => ContainmentInventory {
                        pids: HashSet::new(),
                        error: Some(format!(
                            "tool containment PID inventory blocking task failed: {error}"
                        )),
                    },
                }
            })
        });
        match tokio::time::timeout_at(deadline, &mut task).await {
            Ok(Ok(inventory)) => {
                self.merge_inventory_pids(inventory.pids);
                if tokio::time::Instant::now() >= deadline {
                    Err(
                        "tool containment PID inventory completed after its cleanup deadline"
                            .into(),
                    )
                } else if let Some(error) = inventory.error {
                    Err(error)
                } else {
                    Ok(())
                }
            }
            Ok(Err(error)) => Err(format!(
                "tool containment PID inventory task failed: {error}"
            )),
            Err(_) => {
                self.pending_inventory = Some(task);
                Err("tool containment PID inventory exceeded its cleanup deadline".into())
            }
        }
    }

    fn forget_reaped_owned_pid(&mut self, pid: Option<u32>) {
        let Some(pid) = pid.and_then(|pid| i32::try_from(pid).ok()) else {
            return;
        };
        self.reaped_owned_pid = Some(pid);
        self.reap_pids.remove(&pid);
    }

    fn merge_inventory_pids(&mut self, pids: HashSet<i32>) {
        self.reap_pids.extend(
            pids.into_iter()
                .filter(|pid| Some(*pid) != self.reaped_owned_pid),
        );
    }

    fn retain_owned_child(&mut self, child: Child) {
        debug_assert!(self.pending_child.is_none());
        self.pending_child = Some(child);
    }

    async fn reap_owned_child_until(
        &mut self,
        deadline: tokio::time::Instant,
    ) -> Result<(), String> {
        let Some(mut child) = self.pending_child.take() else {
            return Ok(());
        };
        let pid = child.id();
        let _ = child.start_kill();
        if !self
            .lifecycle_hooks
            .cleanup_owned_child_until(deadline)
            .await
        {
            self.pending_child = Some(child);
            return Err("direct tool process was not reaped before the cleanup deadline".into());
        }
        match tokio::time::timeout_at(deadline, child.wait()).await {
            Ok(Ok(_)) => {
                self.forget_reaped_owned_pid(pid);
                Ok(())
            }
            Ok(Err(error)) => {
                self.pending_child = Some(child);
                Err(format!(
                    "endpoint could not reap direct tool process: {error}"
                ))
            }
            Err(_) => {
                self.pending_child = Some(child);
                Err("direct tool process was not reaped before the cleanup deadline".into())
            }
        }
    }

    async fn remove_until(&mut self, deadline: tokio::time::Instant) -> Result<(), String> {
        let mut task = self.pending_removal.take().unwrap_or_else(|| {
            let path = self.path.clone();
            let lifecycle_hooks = Arc::clone(&self.lifecycle_hooks);
            tokio::spawn(async move {
                lifecycle_hooks.pause_cleanup_remove_io().await;
                tokio::task::spawn_blocking(move || remove_cgroup_tree_until(&path, deadline))
                    .await
                    .map_err(|error| {
                        format!("tool containment removal blocking task failed: {error}")
                    })?
            })
        });
        match tokio::time::timeout_at(deadline, &mut task).await {
            Ok(Ok(Ok(()))) => {
                self.cleaned = true;
                if tokio::time::Instant::now() >= deadline {
                    Err("tool containment removal completed after its cleanup deadline".into())
                } else {
                    Ok(())
                }
            }
            Ok(Ok(Err(error))) => Err(error),
            Ok(Err(error)) => Err(format!("tool containment removal task failed: {error}")),
            Err(_) => {
                self.pending_removal = Some(task);
                Err("tool containment removal exceeded its cleanup deadline".into())
            }
        }
    }

    async fn kill_if_populated_until(
        &mut self,
        deadline: tokio::time::Instant,
    ) -> Result<bool, String> {
        if tokio::time::Instant::now() >= deadline {
            let _ = self.kill_now();
            return Err("tool containment cleanup deadline elapsed before population check".into());
        }
        let populated = self.populated()?;
        if populated {
            if tokio::time::Instant::now() >= deadline {
                let _ = self.kill_now();
                return Err("tool containment cleanup deadline elapsed before freeze".into());
            }
            std::fs::write(self.path.join("cgroup.freeze"), b"1\n")
                .map_err(|error| format!("cannot freeze tool containment: {error}"))?;
            let freeze_hook_completed = self.lifecycle_hooks.cleanup_freeze_until(deadline).await;
            let mut freeze_timed_out = !freeze_hook_completed;
            while !freeze_timed_out && !self.event("frozen")? {
                if tokio::time::Instant::now() >= deadline {
                    freeze_timed_out = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
            let inventory_result = self.inventory_pids_until(deadline).await;
            // Killing is attempted even when freeze or inventory failed. The
            // inventory is bounded by the same absolute deadline, so it cannot
            // turn a stalled freeze into an unbounded pre-kill traversal.
            let kill_result = self.kill_now();
            if freeze_timed_out {
                let suffix = kill_result
                    .err()
                    .map(|error| format!("; cgroup.kill also failed: {error}"))
                    .unwrap_or_default();
                return Err(format!(
                    "tool containment freeze did not complete before the cleanup deadline{suffix}"
                ));
            }
            inventory_result?;
            kill_result?;
        }
        Ok(populated)
    }

    async fn settle_until(&mut self, deadline: tokio::time::Instant) -> Result<(), String> {
        self.reap_owned_child_until(deadline).await?;
        if self.cleaned {
            return Ok(());
        }
        if self.pending_removal.is_some() {
            return self.remove_until(deadline).await;
        }
        if self.pending_inventory.is_some() {
            if let Err(error) = self.inventory_pids_until(deadline).await {
                let _ = self.kill_now();
                return Err(error);
            }
        }
        let initial_kill = self.kill_if_populated_until(deadline).await;
        if tokio::time::Instant::now() >= deadline {
            return Err(initial_kill.err().unwrap_or_else(|| {
                "tool containment cleanup exceeded its deadline after kill".into()
            }));
        }
        if !self.lifecycle_hooks.cleanup_populated_until(deadline).await {
            let _ = self.kill_now();
            return Err("tool containment remained populated past the cleanup deadline".into());
        }
        loop {
            if tokio::time::Instant::now() >= deadline {
                let _ = self.kill_now();
                return Err("tool containment remained populated past the cleanup deadline".into());
            }
            if !self.populated()? {
                break;
            }
            self.kill_now()?;
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        initial_kill?;
        // cgroup.procs excludes zombies. A second containment inventory after
        // cgroup.kill scans /proc membership too, so adopted descendants remain
        // reapable even if the pre-kill inventory timed out or was partial.
        self.inventory_pids_until(deadline).await?;
        if !self.lifecycle_hooks.cleanup_reap_until(deadline).await {
            return Err("tool descendants were not reaped before the cleanup deadline".into());
        }
        let reap_pids = self.reap_pids.iter().copied().collect::<Vec<_>>();
        for raw_pid in reap_pids {
            let pid = nix::unistd::Pid::from_raw(raw_pid);
            loop {
                if tokio::time::Instant::now() >= deadline {
                    return Err(
                        "tool descendants were not reaped before the cleanup deadline".into(),
                    );
                }
                match nix::sys::wait::waitpid(pid, Some(nix::sys::wait::WaitPidFlag::WNOHANG)) {
                    Ok(nix::sys::wait::WaitStatus::StillAlive) => {
                        tokio::time::sleep(Duration::from_millis(1)).await;
                    }
                    Ok(_) | Err(nix::errno::Errno::ECHILD) => {
                        self.reap_pids.remove(&raw_pid);
                        break;
                    }
                    Err(error) => {
                        return Err(format!("cannot reap contained tool process: {error}"));
                    }
                }
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("tool containment cleanup exceeded its deadline".into());
        }
        self.remove_until(deadline).await
    }
}

#[cfg(target_os = "linux")]
fn validate_containment_pids_max(configured: &str) -> Result<(), ToolError> {
    if configured.trim() == MAX_CONTAINMENT_PIDS.to_string() {
        Ok(())
    } else {
        Err(ToolError::new(
            "containment_unavailable",
            "delegated tool cgroup did not retain the reviewed pids.max",
        ))
    }
}

#[cfg(target_os = "linux")]
impl ToolResidueAdmission {
    fn quarantine(mut self, mut containment: ToolContainment) {
        {
            let mut state = self
                .supervisor
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.admissions = state.admissions.saturating_sub(1);
            state.quarantined += 1;
            debug_assert!(
                state.quarantined <= MAX_PROCESSES,
                "tool residue quarantine exceeded process capacity"
            );
            self.active = false;
        }
        let supervisor = Arc::clone(&self.supervisor);
        tokio::spawn(async move {
            containment.lifecycle_hooks.pause_quarantine_reaper().await;
            loop {
                let deadline = tokio::time::Instant::now() + CONTAINMENT_CLEANUP_TIMEOUT;
                if containment.settle_until(deadline).await.is_ok() {
                    break;
                }
                let _ = containment.kill_now();
                tokio::time::sleep(QUARANTINE_RETRY_INTERVAL).await;
            }
            if let Ok(mut state) = supervisor.state.lock() {
                state.quarantined = state.quarantined.saturating_sub(1);
                if state.admissions == 0 && state.quarantined == 0 {
                    supervisor.idle.notify_waiters();
                }
            }
        });
    }
}

#[cfg(target_os = "linux")]
fn inventory_containment_pids_until(
    path: &Path,
    deadline: tokio::time::Instant,
) -> ContainmentInventory {
    let mut pids = HashSet::new();
    let mut entries_seen = 0;
    let cgroup_error =
        inventory_cgroup_pids_inner(path, &mut pids, deadline, 0, &mut entries_seen).err();
    let proc_error = inventory_proc_cgroup_members_until(path, &mut pids, deadline).err();
    let error = match (cgroup_error, proc_error) {
        (Some(first), Some(second)) => Some(format!("{first}; {second}")),
        (Some(error), None) | (None, Some(error)) => Some(error),
        (None, None) => None,
    };
    ContainmentInventory { pids, error }
}

#[cfg(target_os = "linux")]
fn record_containment_pid(pids: &mut HashSet<i32>, raw: &str) -> Result<(), String> {
    let pid = raw
        .parse::<i32>()
        .ok()
        .filter(|pid| *pid > 0)
        .ok_or_else(|| "tool containment reported an invalid PID".to_string())?;
    if !pids.contains(&pid) && pids.len() >= MAX_CONTAINMENT_PIDS {
        return Err("tool containment PID inventory exceeded its process limit".into());
    }
    pids.insert(pid);
    Ok(())
}

#[cfg(target_os = "linux")]
fn read_containment_pids(path: &Path) -> Result<String, String> {
    let file = File::open(path.join("cgroup.procs"))
        .map_err(|error| format!("cannot inventory contained tool processes: {error}"))?;
    let mut procs = String::new();
    file.take(MAX_CONTAINMENT_PID_BYTES + 1)
        .read_to_string(&mut procs)
        .map_err(|error| format!("cannot inventory contained tool processes: {error}"))?;
    if procs.len() as u64 > MAX_CONTAINMENT_PID_BYTES {
        return Err("tool containment PID inventory exceeded its byte limit".into());
    }
    Ok(procs)
}

#[cfg(target_os = "linux")]
fn inventory_cgroup_pids_inner(
    path: &Path,
    pids: &mut HashSet<i32>,
    deadline: tokio::time::Instant,
    depth: usize,
    entries_seen: &mut usize,
) -> Result<(), String> {
    if tokio::time::Instant::now() >= deadline {
        return Err("tool containment PID inventory exceeded its cleanup deadline".into());
    }
    if depth > MAX_CONTAINMENT_TREE_DEPTH {
        return Err("tool containment PID inventory exceeded its depth limit".into());
    }
    let procs = read_containment_pids(path)?;
    for raw_pid in procs.lines() {
        record_containment_pid(pids, raw_pid)?;
    }
    if tokio::time::Instant::now() >= deadline {
        return Err("tool containment PID inventory exceeded its cleanup deadline".into());
    }
    let entries = std::fs::read_dir(path)
        .map_err(|error| format!("cannot enumerate nested tool containment: {error}"))?;
    for entry in entries {
        if tokio::time::Instant::now() >= deadline {
            return Err("tool containment PID inventory exceeded its cleanup deadline".into());
        }
        *entries_seen += 1;
        if *entries_seen > MAX_CONTAINMENT_TREE_ENTRIES {
            return Err("tool containment PID inventory exceeded its entry limit".into());
        }
        let entry = entry.map_err(|error| format!("cannot inspect nested containment: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("cannot inspect nested containment entry: {error}"))?;
        if file_type.is_dir() {
            inventory_cgroup_pids_inner(&entry.path(), pids, deadline, depth + 1, entries_seen)?;
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn inventory_proc_cgroup_members_until(
    path: &Path,
    pids: &mut HashSet<i32>,
    deadline: tokio::time::Instant,
) -> Result<(), String> {
    let relative = path
        .strip_prefix("/sys/fs/cgroup")
        .map_err(|_| "tool containment is outside the cgroup v2 mount".to_string())?;
    let membership = format!("0::/{}", relative.to_string_lossy().trim_start_matches('/'));
    let entries = std::fs::read_dir("/proc")
        .map_err(|error| format!("cannot enumerate process membership: {error}"))?;
    let mut entries_seen = 0;
    for entry in entries {
        if tokio::time::Instant::now() >= deadline {
            return Err("tool containment process scan exceeded its cleanup deadline".into());
        }
        entries_seen += 1;
        if entries_seen > MAX_PROC_SCAN_ENTRIES {
            return Err("tool containment process scan exceeded its entry limit".into());
        }
        let Ok(entry) = entry else {
            continue;
        };
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|value| value.parse::<i32>().ok())
        else {
            continue;
        };
        let contents = match std::fs::read_to_string(entry.path().join("cgroup")) {
            Ok(contents) => contents,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
                ) =>
            {
                continue;
            }
            Err(error) => {
                return Err(format!("cannot inspect process cgroup membership: {error}"));
            }
        };
        if contents.lines().any(|line| line == membership) {
            record_containment_pid(pids, &pid.to_string())?;
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
impl Drop for ToolContainment {
    fn drop(&mut self) {
        if let Some(child) = self.pending_child.as_mut() {
            let _ = child.start_kill();
        }
        if self.cleaned {
            return;
        }
        // Normal paths settle or quarantine before dropping. Drop itself must
        // never run recursive filesystem work on the async runtime, and a
        // timed-out removal task remains the sole owner of that mutation.
        let _ = self.kill_now();
        if self.pending_removal.is_none() {
            // This constant, non-recursive leaf attempt only covers unwind.
            // Every ordinary post-create failure is settled or quarantined.
            let _ = std::fs::remove_dir(&self.path);
        }
    }
}

#[cfg(target_os = "linux")]
fn remove_cgroup_tree_until(path: &Path, deadline: tokio::time::Instant) -> Result<(), String> {
    let mut entries_seen = 0;
    remove_cgroup_tree_inner(path, deadline, 0, &mut entries_seen)
}

#[cfg(target_os = "linux")]
fn remove_cgroup_tree_inner(
    path: &Path,
    deadline: tokio::time::Instant,
    depth: usize,
    entries_seen: &mut usize,
) -> Result<(), String> {
    if tokio::time::Instant::now() >= deadline {
        return Err("tool containment removal exceeded its cleanup deadline".into());
    }
    if depth > MAX_CONTAINMENT_TREE_DEPTH {
        return Err("tool containment removal exceeded its depth limit".into());
    }
    let entries = std::fs::read_dir(path)
        .map_err(|error| format!("cannot enumerate tool containment: {error}"))?;
    for entry in entries {
        if tokio::time::Instant::now() >= deadline {
            return Err("tool containment removal exceeded its cleanup deadline".into());
        }
        *entries_seen += 1;
        if *entries_seen > MAX_CONTAINMENT_TREE_ENTRIES {
            return Err("tool containment removal exceeded its entry limit".into());
        }
        let entry = entry.map_err(|error| format!("cannot inspect tool containment: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("cannot inspect tool containment entry: {error}"))?;
        if file_type.is_dir() {
            remove_cgroup_tree_inner(&entry.path(), deadline, depth + 1, entries_seen)?;
        }
    }
    if tokio::time::Instant::now() >= deadline {
        return Err("tool containment removal exceeded its cleanup deadline".into());
    }
    std::fs::remove_dir(path)
        .map_err(|error| format!("cannot remove empty tool containment: {error}"))
}

#[cfg(not(target_os = "linux"))]
struct ToolContainment;

#[cfg(not(target_os = "linux"))]
impl ToolContainment {
    async fn create(_lifecycle_hooks: Arc<HostToolLifecycleHooks>) -> Result<Self, ToolError> {
        Err(ToolError::new(
            "containment_unavailable",
            "interactive tool execution requires reviewed Linux cgroup v2 containment",
        ))
    }

    fn attach(&self, _command: &mut Command) -> Result<(), ToolError> {
        Err(ToolError::new(
            "containment_unavailable",
            "interactive tool execution requires reviewed Linux cgroup v2 containment",
        ))
    }

    fn kill_now(&self) -> Result<(), String> {
        Err("tool containment is unavailable".into())
    }

    fn forget_reaped_owned_pid(&mut self, _pid: Option<u32>) {}

    fn retain_owned_child(&mut self, mut child: Child) {
        let _ = child.start_kill();
    }

    async fn kill_if_populated_until(
        &mut self,
        _deadline: tokio::time::Instant,
    ) -> Result<bool, String> {
        Err("tool containment is unavailable".into())
    }

    async fn settle_until(&mut self, _deadline: tokio::time::Instant) -> Result<(), String> {
        Err("tool containment is unavailable".into())
    }
}

#[derive(Clone, Copy)]
struct ProgramCancellation<'a> {
    request: &'a CancellationToken,
    shutdown: &'a CancellationToken,
    timeout: Duration,
}

async fn run_program_capture(
    processes: Arc<Semaphore>,
    residue_supervisor: Arc<ToolResidueSupervisor>,
    lifecycle_hooks: Arc<HostToolLifecycleHooks>,
    program: &Path,
    args: &[&str],
    env: &BTreeMap<String, String>,
    cancellation: ProgramCancellation<'_>,
) -> Result<ProgramCapture, ToolError> {
    let ProgramCancellation {
        request: cancelled,
        shutdown,
        timeout,
    } = cancellation;
    let _permit = acquire_process_permit(processes, cancelled, shutdown).await?;
    let mut residue_admission = Some(residue_supervisor.admit()?);
    if cancelled.is_cancelled() || shutdown.is_cancelled() {
        return Err(ToolError::new("cancelled", "tool operation was cancelled"));
    }
    let mut spawn_attempt = 0;
    let (mut child, mut containment) = loop {
        let sandbox = ToolSandbox::create(env)?;
        let containment = ToolContainment::create(Arc::clone(&lifecycle_hooks)).await?;
        #[cfg(all(test, target_os = "linux"))]
        lifecycle_hooks.record_containment_path(containment.path.clone());
        let validation = if lifecycle_hooks.take_pre_spawn_failure() {
            Err(ToolError::new(
                "containment_unavailable",
                "forced pre-spawn containment validation failure",
            ))
        } else {
            containment.validate_files()
        };
        if let Err(error) = validation {
            return match settle_or_quarantine(
                containment,
                tokio::time::Instant::now() + CONTAINMENT_CLEANUP_TIMEOUT,
                &mut residue_admission,
            )
            .await
            {
                Ok(()) => Err(error),
                Err(cleanup) => Err(ToolError::new(
                    "containment_failed",
                    format!(
                        "endpoint could not clean a pre-spawn containment failure: {cleanup}; prior error: {}",
                        error.detail
                    ),
                )),
            };
        }
        let mut command = Command::new(program);
        command
            .args(args)
            .envs(env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        {
            command.process_group(0);
        }
        if let Err(error) = containment.attach(&mut command) {
            return match settle_or_quarantine(
                containment,
                tokio::time::Instant::now() + CONTAINMENT_CLEANUP_TIMEOUT,
                &mut residue_admission,
            )
            .await
            {
                Ok(()) => Err(error),
                Err(cleanup) => Err(ToolError::new(
                    "containment_failed",
                    format!(
                        "endpoint could not clean a pre-spawn attach failure: {cleanup}; prior error: {}",
                        error.detail
                    ),
                )),
            };
        }
        sandbox.attach(&mut command);
        match command.spawn() {
            Ok(child) => break (child, containment),
            Err(error)
                if error.raw_os_error() == Some(26) && spawn_attempt < SPAWN_BUSY_RETRIES =>
            {
                settle_or_quarantine(
                    containment,
                    tokio::time::Instant::now() + CONTAINMENT_CLEANUP_TIMEOUT,
                    &mut residue_admission,
                )
                .await
                .map_err(|failure| {
                    ToolError::new(
                        "containment_failed",
                        format!("endpoint could not settle a failed spawn: {failure}"),
                    )
                })?;
                spawn_attempt += 1;
                tokio::select! {
                    _ = tokio::time::sleep(SPAWN_BUSY_RETRY_DELAY) => {}
                    _ = cancelled.cancelled() => return Err(ToolError::new("cancelled", "tool operation was cancelled")),
                    _ = shutdown.cancelled() => return Err(ToolError::new("cancelled", "host session closed")),
                }
            }
            Err(error) => {
                settle_or_quarantine(
                    containment,
                    tokio::time::Instant::now() + CONTAINMENT_CLEANUP_TIMEOUT,
                    &mut residue_admission,
                )
                .await
                .map_err(|failure| {
                    ToolError::new(
                        "containment_failed",
                        format!("endpoint could not settle a failed spawn: {failure}"),
                    )
                })?;
                return Err(ToolError::new(
                    "spawn_failed",
                    format!("endpoint failed to start allowlisted program: {error}"),
                ));
            }
        }
    };
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (Some(stdout), Some(stderr)) = (stdout, stderr) else {
        let cleanup_deadline = tokio::time::Instant::now() + CONTAINMENT_CLEANUP_TIMEOUT;
        let containment_failure = containment
            .kill_if_populated_until(cleanup_deadline)
            .await
            .err();
        let _ = child.start_kill();
        let (status, child_failure) = match wait_child_until(&mut child, cleanup_deadline).await {
            Ok(status) => {
                containment.forget_reaped_owned_pid(pid);
                (Some(status), None)
            }
            Err(error) => {
                containment.retain_owned_child(child);
                (None, Some(error))
            }
        };
        let containment_failure = containment_failure
            .or(child_failure)
            .or(
                settle_or_quarantine(containment, cleanup_deadline, &mut residue_admission)
                    .await
                    .err(),
            );
        return Ok(ProgramCapture {
            status,
            stdout: empty_tail(),
            stderr: empty_tail(),
            failure: Some(containment_failure.map_or_else(
                || "tool output capture was unavailable after execution started".into(),
                |failure| {
                    format!("tool output capture failed and containment cleanup failed: {failure}")
                },
            )),
        });
    };
    let stdout_hooks = Arc::clone(&lifecycle_hooks);
    let stderr_hooks = Arc::clone(&lifecycle_hooks);
    let stdout_task = tokio::spawn(async move {
        let capture = read_tail(stdout).await;
        stdout_hooks.pause_pipe_drain().await;
        capture
    });
    let stderr_task = tokio::spawn(async move {
        let capture = read_tail(stderr).await;
        stderr_hooks.pause_pipe_drain().await;
        capture
    });
    let mut failure = None;
    let mut containment_was_populated = false;
    enum Completion {
        Exited(std::io::Result<ExitStatus>),
        Cancelled(&'static str),
        TimedOut,
    }
    let completion = tokio::select! {
        result = child.wait() => Completion::Exited(result),
        _ = cancelled.cancelled() => {
            Completion::Cancelled("tool operation was cancelled after execution started")
        }
        _ = shutdown.cancelled() => {
            Completion::Cancelled("host session closed after execution started")
        }
        _ = tokio::time::sleep(timeout) => {
            Completion::TimedOut
        }
    };
    let cleanup_deadline = tokio::time::Instant::now() + CONTAINMENT_CLEANUP_TIMEOUT;
    let status = match completion {
        Completion::Exited(Ok(status)) => {
            containment.forget_reaped_owned_pid(pid);
            Some(status)
        }
        Completion::Exited(Err(error)) => {
            failure = Some(format!(
                "endpoint could not observe tool process completion: {error}"
            ));
            match containment.kill_if_populated_until(cleanup_deadline).await {
                Ok(populated) => containment_was_populated |= populated,
                Err(error) => {
                    failure.get_or_insert(error);
                }
            }
            let _ = child.start_kill();
            match wait_child_until(&mut child, cleanup_deadline).await {
                Ok(status) => {
                    containment.forget_reaped_owned_pid(pid);
                    Some(status)
                }
                Err(error) => {
                    failure.get_or_insert(error);
                    containment.retain_owned_child(child);
                    None
                }
            }
        }
        Completion::Cancelled(detail) => {
            failure = Some(detail.into());
            match containment.kill_if_populated_until(cleanup_deadline).await {
                Ok(populated) => containment_was_populated |= populated,
                Err(error) => {
                    failure.get_or_insert(error);
                }
            }
            let _ = child.start_kill();
            lifecycle_hooks.pause_after_kill().await;
            match wait_child_until(&mut child, cleanup_deadline).await {
                Ok(status) => {
                    containment.forget_reaped_owned_pid(pid);
                    Some(status)
                }
                Err(error) => {
                    failure.get_or_insert(error);
                    containment.retain_owned_child(child);
                    None
                }
            }
        }
        Completion::TimedOut => {
            failure = Some(format!(
                "tool operation timed out after {} seconds",
                timeout.as_secs()
            ));
            match containment.kill_if_populated_until(cleanup_deadline).await {
                Ok(populated) => containment_was_populated |= populated,
                Err(error) => {
                    failure.get_or_insert(error);
                }
            }
            let _ = child.start_kill();
            lifecycle_hooks.pause_after_kill().await;
            match wait_child_until(&mut child, cleanup_deadline).await {
                Ok(status) => {
                    containment.forget_reaped_owned_pid(pid);
                    Some(status)
                }
                Err(error) => {
                    failure.get_or_insert(error);
                    containment.retain_owned_child(child);
                    None
                }
            }
        }
    };
    let descendants_remained = match containment.kill_if_populated_until(cleanup_deadline).await {
        Ok(remained) => containment_was_populated || remained,
        Err(containment_failure) => {
            failure.get_or_insert(containment_failure);
            true
        }
    };
    if descendants_remained {
        lifecycle_hooks.pause_after_kill().await;
    }
    let (stdout, stderr) = tokio::join!(finish_tail(stdout_task), finish_tail(stderr_task));
    if stdout.1 || stderr.1 {
        failure.get_or_insert_with(|| "tool output pipes did not close before deadline".into());
    }
    if descendants_remained {
        failure.get_or_insert_with(|| {
            "tool containment remained populated after the direct command exited".into()
        });
    }
    if let Err(containment_failure) =
        settle_or_quarantine(containment, cleanup_deadline, &mut residue_admission).await
    {
        failure = Some(match failure.take() {
            Some(prior) => {
                format!("containment_failed: {containment_failure}; prior tool outcome: {prior}")
            }
            None => format!("containment_failed: {containment_failure}"),
        });
    }
    Ok(ProgramCapture {
        status,
        stdout: stdout.0,
        stderr: stderr.0,
        failure,
    })
}

async fn wait_child_until(
    child: &mut Child,
    deadline: tokio::time::Instant,
) -> Result<ExitStatus, String> {
    match tokio::time::timeout_at(deadline, child.wait()).await {
        Ok(Ok(status)) => Ok(status),
        Ok(Err(error)) => Err(format!(
            "endpoint could not reap direct tool process: {error}"
        )),
        Err(_) => Err("direct tool process was not reaped before the cleanup deadline".into()),
    }
}

#[cfg(target_os = "linux")]
async fn settle_or_quarantine(
    mut containment: ToolContainment,
    deadline: tokio::time::Instant,
    residue_admission: &mut Option<ToolResidueAdmission>,
) -> Result<(), String> {
    match containment.settle_until(deadline).await {
        Ok(()) => Ok(()),
        Err(error) => {
            let admission = residue_admission
                .take()
                .ok_or_else(|| "tool containment residue was already quarantined".to_string())?;
            admission.quarantine(containment);
            Err(format!(
                "{error}; residual cgroup and PIDs were quarantined for background reaping"
            ))
        }
    }
}

#[cfg(not(target_os = "linux"))]
async fn settle_or_quarantine(
    mut containment: ToolContainment,
    deadline: tokio::time::Instant,
    _residue_admission: &mut Option<ToolResidueAdmission>,
) -> Result<(), String> {
    containment.settle_until(deadline).await
}

async fn finish_tail(mut task: tokio::task::JoinHandle<TailCapture>) -> (TailCapture, bool) {
    match tokio::time::timeout(PIPE_DRAIN_TIMEOUT, &mut task).await {
        Ok(Ok(capture)) => (capture, false),
        Ok(Err(_)) => (empty_tail(), false),
        Err(_) => {
            task.abort();
            let _ = task.await;
            (empty_tail(), true)
        }
    }
}

async fn acquire_process_permit(
    processes: Arc<Semaphore>,
    cancelled: &CancellationToken,
    shutdown: &CancellationToken,
) -> Result<OwnedSemaphorePermit, ToolError> {
    tokio::select! {
        permit = processes.acquire_owned() => permit.map_err(|_| ToolError::new("closed", "tool process limiter is closed")),
        _ = cancelled.cancelled() => Err(ToolError::new("cancelled", "tool operation was cancelled")),
        _ = shutdown.cancelled() => Err(ToolError::new("cancelled", "host session closed")),
    }
}

async fn read_tail<R: AsyncRead + Unpin>(mut reader: R) -> TailCapture {
    let mut tail = VecDeque::with_capacity(OUTPUT_TAIL_BYTES);
    let mut truncated = false;
    let mut buffer = [0u8; 4096];
    while let Ok(read) = reader.read(&mut buffer).await {
        if read == 0 {
            break;
        }
        for byte in &buffer[..read] {
            if tail.len() == OUTPUT_TAIL_BYTES {
                tail.pop_front();
                truncated = true;
            }
            tail.push_back(*byte);
        }
    }
    let bytes = tail.into_iter().collect::<Vec<_>>();
    let text = String::from_utf8_lossy(&bytes);
    let text = text.trim();
    let decoded_truncated = text.len() > OUTPUT_TAIL_BYTES;
    TailCapture {
        text: bounded(text, OUTPUT_TAIL_BYTES),
        truncated: truncated || decoded_truncated,
    }
}

fn empty_tail() -> TailCapture {
    TailCapture {
        text: String::new(),
        truncated: false,
    }
}

fn first_meaningful_line(output: &str) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| bounded(line, MAX_VERSION_BYTES))
}

fn parse_pip_latest_version(package: &str, output: &str) -> Option<String> {
    let first = first_meaningful_line(output)?;
    let prefix = format!("{package} (");
    first
        .strip_prefix(&prefix)
        .and_then(|rest| rest.split(')').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| bounded(value, MAX_VERSION_BYTES))
}

fn version_suggests_update(installed: &str, latest: &str) -> Option<bool> {
    let installed = numeric_version(installed)?;
    let latest = numeric_version(latest)?;
    Some(compare_versions(&installed, &latest) == std::cmp::Ordering::Less)
}

fn numeric_version(text: &str) -> Option<Vec<u64>> {
    let mut best = Vec::new();
    for raw in text.split(|character: char| !character.is_ascii_alphanumeric() && character != '.')
    {
        let candidate = raw.trim_start_matches('v');
        if !candidate.starts_with(|character: char| character.is_ascii_digit()) {
            continue;
        }
        let parts = candidate
            .split('.')
            .take_while(|part| {
                !part.is_empty() && part.chars().all(|character| character.is_ascii_digit())
            })
            .filter_map(|part| part.parse::<u64>().ok())
            .collect::<Vec<_>>();
        if parts.len() > best.len() {
            best = parts;
        }
    }
    (!best.is_empty()).then_some(best)
}

fn compare_versions(left: &[u64], right: &[u64]) -> std::cmp::Ordering {
    for index in 0..left.len().max(right.len()) {
        match left
            .get(index)
            .copied()
            .unwrap_or(0)
            .cmp(&right.get(index).copied().unwrap_or(0))
        {
            std::cmp::Ordering::Equal => {}
            ordering => return ordering,
        }
    }
    std::cmp::Ordering::Equal
}

fn bounded(value: impl AsRef<str>, limit: usize) -> String {
    let value = value.as_ref();
    if value.len() <= limit {
        return value.to_string();
    }
    let mut end = 0;
    for (index, character) in value.char_indices() {
        let next = index + character.len_utf8();
        if next > limit {
            break;
        }
        end = next;
    }
    value[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[cfg(unix)]
    fn executable(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\nset -eu\n{body}\n")).expect("write script");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .expect("chmod script");
        path
    }

    fn test_env(dir: &Path) -> BTreeMap<String, String> {
        BTreeMap::from([
            ("PATH".into(), dir.to_string_lossy().into_owned()),
            ("HOME".into(), dir.to_string_lossy().into_owned()),
        ])
    }

    fn tool_pids_controller_is_delegated() -> bool {
        #[cfg(target_os = "linux")]
        {
            let Ok(current) = current_cgroup_path() else {
                return false;
            };
            let Ok(root) = service_cgroup_root(&current) else {
                return false;
            };
            let systemd_manager_leaf = current.file_name().and_then(|name| name.to_str())
                == Some(TOOL_CGROUP_MANAGER_NAME);
            cgroup_has_token(&root, "cgroup.subtree_control", "pids").unwrap_or(false)
                || (systemd_manager_leaf
                    && cgroup_has_token(&root, "cgroup.controllers", "pids").unwrap_or(false))
        }
        #[cfg(not(target_os = "linux"))]
        false
    }

    macro_rules! require_tool_pids_controller {
        () => {
            if !tool_pids_controller_is_delegated() {
                eprintln!("skipped: the test cgroup does not delegate the pids controller");
                return;
            }
        };
    }

    #[cfg(unix)]
    async fn wait_for_nonempty_file(path: &Path) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while std::fs::read_to_string(path)
                .ok()
                .is_none_or(|contents| contents.trim().is_empty())
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("process marker was not written");
    }

    #[cfg(target_os = "linux")]
    #[derive(Clone, Copy, Debug)]
    enum StalledCleanupPhase {
        Freeze,
        Inventory,
        Populated,
        Reap,
        Remove,
    }

    #[cfg(target_os = "linux")]
    async fn assert_stalled_cleanup_is_quarantined(phase: StalledCleanupPhase) {
        let dir = tempfile::tempdir().expect("tempdir");
        let pid_file = dir.path().join("tool-pid");
        let spawn_marker = dir.path().join("blocked-spawn");
        let script = executable(
            dir.path(),
            "stalled-cleanup",
            &format!(
                "setsid sh -c 'while :; do :; done' & descendant=$!; printf '%s %s' $$ \"$descendant\" > '{}'; while :; do :; done",
                pid_file.display()
            ),
        );
        let blocked_script = executable(
            dir.path(),
            "must-not-spawn",
            &format!("printf spawned > '{}'", spawn_marker.display()),
        );
        let hooks = Arc::new(HostToolLifecycleHooks::default());
        match phase {
            StalledCleanupPhase::Freeze => hooks.cleanup_freeze.arm(),
            StalledCleanupPhase::Inventory => hooks.cleanup_inventory.arm(),
            StalledCleanupPhase::Populated => hooks.cleanup_populated.arm(),
            StalledCleanupPhase::Reap => hooks.cleanup_reap.arm(),
            StalledCleanupPhase::Remove => hooks.cleanup_remove.arm(),
        }
        hooks.quarantine_reaper.arm();
        let processes = Arc::new(Semaphore::new(1));
        let supervisor = Arc::new(ToolResidueSupervisor::default());
        let started = std::time::Instant::now();
        let capture = run_program_capture(
            Arc::clone(&processes),
            Arc::clone(&supervisor),
            Arc::clone(&hooks),
            &script,
            &[],
            &test_env(dir.path()),
            ProgramCancellation {
                timeout: Duration::from_millis(20),
                request: &CancellationToken::new(),
                shutdown: &CancellationToken::new(),
            },
        )
        .await
        .expect("post-effect cleanup failure must be structured");
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "{phase:?} cleanup exceeded its request bound"
        );
        assert!(capture.failure.as_deref().is_some_and(|error| {
            error.contains("containment_failed") && error.contains("quarantined")
        }));
        tokio::time::timeout(
            Duration::from_secs(1),
            hooks.quarantine_reaper.wait_until_entered(),
        )
        .await
        .expect("background quarantine reaper was not scheduled");
        assert_eq!(supervisor.quarantined(), 1);
        assert_eq!(processes.available_permits(), 1);

        for _ in 0..(MAX_PROCESSES * 2) {
            let error = run_program_capture(
                Arc::clone(&processes),
                Arc::clone(&supervisor),
                Arc::clone(&hooks),
                &blocked_script,
                &[],
                &test_env(dir.path()),
                ProgramCancellation {
                    timeout: Duration::from_secs(1),
                    request: &CancellationToken::new(),
                    shutdown: &CancellationToken::new(),
                },
            )
            .await
            .expect_err("quarantine must gate every new process admission");
            assert_eq!(error.code, "containment_failed");
        }
        assert_eq!(supervisor.quarantined(), 1);
        assert!(!spawn_marker.exists());

        let containment_path = hooks.containment_path();
        match phase {
            StalledCleanupPhase::Inventory => hooks.cleanup_inventory.release(),
            StalledCleanupPhase::Remove => hooks.cleanup_remove.release(),
            StalledCleanupPhase::Freeze
            | StalledCleanupPhase::Populated
            | StalledCleanupPhase::Reap => {}
        }
        hooks.quarantine_reaper.release();
        assert!(
            supervisor
                .wait_for_idle_until(tokio::time::Instant::now() + Duration::from_secs(2),)
                .await,
            "{phase:?} quarantine did not eventually drain"
        );
        assert!(!containment_path.exists());
        let pids = std::fs::read_to_string(pid_file).expect("tool pids");
        for pid in pids.split_whitespace() {
            assert!(
                !Path::new("/proc").join(pid).exists(),
                "{phase:?} cleanup left adopted process or zombie {pid}"
            );
        }

        let capture = run_program_capture(
            processes,
            supervisor,
            hooks,
            &blocked_script,
            &[],
            &test_env(dir.path()),
            ProgramCancellation {
                timeout: Duration::from_secs(1),
                request: &CancellationToken::new(),
                shutdown: &CancellationToken::new(),
            },
        )
        .await
        .expect("process admission must resume only after quarantine drain");
        assert!(capture.status.is_some_and(|status| status.success()));
        assert!(spawn_marker.exists());
    }

    #[test]
    fn payloads_reject_arbitrary_execution_fields_and_invalid_targets() {
        assert!(HostToolService::parse_check(&json!({
            "targets": [{"target_id": "p", "tool": "codex", "argv": ["sh", "-c", "secret"]}]
        }))
        .is_err());
        assert!(HostToolService::parse_install(&json!({
            "target": {"target_id": "p", "tool": "../../bin/sh"}
        }))
        .is_err());
        assert!(HostToolService::parse_install(&json!({
            "target": {"target_id": "p", "tool": "unknown"}
        }))
        .is_err());
    }

    #[test]
    fn policy_uses_direct_allowlisted_argv() {
        assert_eq!(
            install_argv(InstallPolicy::Npm("pkg")),
            ("npm", vec!["install", "--global", "pkg"])
        );
        assert_eq!(
            install_argv(InstallPolicy::Pip("pkg")),
            (
                "python3",
                vec!["-m", "pip", "install", "--user", "--upgrade", "pkg"]
            )
        );
        assert!(POLICIES
            .iter()
            .all(|policy| !policy.executable.contains(' ')));
        assert_eq!(
            POLICIES
                .iter()
                .map(|policy| policy.tool)
                .collect::<HashSet<_>>(),
            HashSet::from(["claude-code", "codex", "opencode", "aider", "shell"])
        );
        assert_eq!(
            policy_for("aider").map(|policy| policy.executable),
            Some("aider")
        );
        assert!(policy_for("aider-sonnet").is_none());
        assert!(Arc::ptr_eq(
            &HostToolService::shared(),
            &HostToolService::shared()
        ));
    }

    #[cfg(all(
        target_os = "linux",
        any(target_arch = "x86_64", target_arch = "aarch64")
    ))]
    fn evaluate_seccomp_filter(arch: u32, syscall: u32, arg0: u32) -> u32 {
        let filters = tool_seccomp_filter();
        let mut accumulator = 0u32;
        let mut index = 0usize;
        loop {
            let instruction = filters
                .get(index)
                .unwrap_or_else(|| panic!("seccomp program fell through at instruction {index}"));
            match instruction.code {
                BPF_LD_W_ABS => {
                    accumulator = match instruction.k {
                        SECCOMP_NR_OFFSET => syscall,
                        SECCOMP_ARCH_OFFSET => arch,
                        SECCOMP_ARG0_OFFSET => arg0,
                        offset => panic!("unexpected seccomp data offset {offset}"),
                    };
                    index += 1;
                }
                BPF_ALU_AND_K => {
                    accumulator &= instruction.k;
                    index += 1;
                }
                BPF_JMP_JEQ_K => {
                    index += 1 + if accumulator == instruction.k {
                        instruction.jt as usize
                    } else {
                        instruction.jf as usize
                    };
                }
                #[cfg(target_arch = "x86_64")]
                BPF_JMP_JSET_K => {
                    index += 1 + if accumulator & instruction.k != 0 {
                        instruction.jt as usize
                    } else {
                        instruction.jf as usize
                    };
                }
                BPF_RET_K => return instruction.k,
                code => panic!("unexpected seccomp BPF opcode {code:#x}"),
            }
        }
    }

    #[cfg(all(
        target_os = "linux",
        any(target_arch = "x86_64", target_arch = "aarch64")
    ))]
    #[test]
    fn seccomp_dispatch_accepts_only_the_reviewed_native_abi() {
        assert_eq!(
            evaluate_seccomp_filter(TOOL_AUDIT_ARCH, nix::libc::SYS_getpid as u32, 0),
            SECCOMP_RET_ALLOW
        );
        assert_eq!(
            evaluate_seccomp_filter(TOOL_AUDIT_ARCH ^ 1, nix::libc::SYS_getpid as u32, 0),
            SECCOMP_RET_KILL_PROCESS
        );
        #[cfg(target_arch = "x86_64")]
        {
            assert_eq!(
                evaluate_seccomp_filter(
                    TOOL_AUDIT_ARCH,
                    X32_SYSCALL_BIT | nix::libc::SYS_getpid as u32,
                    0,
                ),
                SECCOMP_RET_KILL_PROCESS
            );
            assert_eq!(
                evaluate_seccomp_filter(
                    TOOL_AUDIT_ARCH,
                    X32_SYSCALL_BIT | nix::libc::SYS_ptrace as u32,
                    0,
                ),
                SECCOMP_RET_KILL_PROCESS,
                "x32-tagged calls must die before native deny/allow dispatch"
            );
        }
    }

    #[test]
    fn endpoint_tool_env_never_invokes_or_depends_on_a_login_shell() {
        let source = BTreeMap::from([
            ("HOME".into(), "/home/endpoint".into()),
            ("PATH".into(), "/service/bin:/usr/bin".into()),
            ("SHELL".into(), "/tmp/stalled-profile-shell".into()),
            ("NO_COLOR".into(), "1".into()),
        ]);
        let env = endpoint_command_env_from(source);
        assert_eq!(
            env.get("SHELL").map(String::as_str),
            Some("/tmp/stalled-profile-shell")
        );
        assert_eq!(env.get("TERM").map(String::as_str), Some("xterm-256color"));
        assert!(!env.contains_key("NO_COLOR"));
        assert_eq!(
            env.get("PATH").map(String::as_str),
            Some(
                "/home/endpoint/.local/bin:/home/endpoint/bin:/home/endpoint/.bun/bin:/home/endpoint/.cargo/bin:/service/bin:/usr/bin"
            )
        );
    }

    #[tokio::test]
    async fn output_tail_is_bounded_and_marks_truncation() {
        let input = vec![b'x'; OUTPUT_TAIL_BYTES + 513];
        let capture = read_tail(std::io::Cursor::new(input)).await;
        assert!(capture.truncated);
        assert_eq!(capture.text.len(), OUTPUT_TAIL_BYTES);

        let invalid_utf8 = read_tail(std::io::Cursor::new(vec![0xff; OUTPUT_TAIL_BYTES])).await;
        assert!(invalid_utf8.truncated);
        assert!(invalid_utf8.text.len() <= OUTPUT_TAIL_BYTES);
    }

    #[test]
    fn versions_compare_without_executing_input() {
        assert_eq!(version_suggests_update("codex 1.2.3", "1.2.4"), Some(true));
        assert_eq!(version_suggests_update("v2", "1.99"), Some(false));
        assert_eq!(version_suggests_update("not-a-version", "1.0"), None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn direct_argv_is_literal_and_output_memory_is_bounded() {
        require_tool_pids_controller!();
        let dir = tempfile::tempdir().expect("tempdir");
        let script = executable(dir.path(), "literal", "printf '%s' \"$1\"");
        let marker = dir.path().join("must-not-exist");
        let malicious = format!("$(touch {})", marker.display());
        let env = test_env(dir.path());
        let capture = run_program_capture(
            Arc::new(Semaphore::new(1)),
            Arc::new(ToolResidueSupervisor::default()),
            Arc::new(HostToolLifecycleHooks::default()),
            &script,
            &[&malicious],
            &env,
            ProgramCancellation {
                timeout: Duration::from_secs(1),
                request: &CancellationToken::new(),
                shutdown: &CancellationToken::new(),
            },
        )
        .await
        .expect("capture");
        assert_eq!(capture.stdout.text, malicious);
        assert!(!marker.exists());

        let oversized = "x".repeat(OUTPUT_TAIL_BYTES + 511);
        let capture = run_program_capture(
            Arc::new(Semaphore::new(1)),
            Arc::new(ToolResidueSupervisor::default()),
            Arc::new(HostToolLifecycleHooks::default()),
            &script,
            &[&oversized],
            &env,
            ProgramCancellation {
                timeout: Duration::from_secs(1),
                request: &CancellationToken::new(),
                shutdown: &CancellationToken::new(),
            },
        )
        .await
        .expect("capture");
        assert!(capture.stdout.truncated);
        assert_eq!(capture.stdout.text.len(), OUTPUT_TAIL_BYTES);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn sandbox_blocks_direct_and_manager_assisted_cgroup_escape_after_fork_and_exec() {
        require_tool_pids_controller!();
        use std::os::unix::net::UnixListener;
        use std::sync::atomic::AtomicBool;

        let dir = tempfile::tempdir().expect("tempdir");
        let direct_escape = dir.path().join("direct-escape");
        let manager_request = dir.path().join("manager-request");
        let manager_escape = dir.path().join("manager-escape");
        let normal_write = dir.path().join("normal-write");
        let manager_socket = dir.path().join("manager.sock");
        let listener = UnixListener::bind(&manager_socket).expect("test manager socket");
        listener
            .set_nonblocking(true)
            .expect("nonblocking manager socket");
        let manager_done = Arc::new(AtomicBool::new(false));
        let manager = std::thread::spawn({
            let manager_done = Arc::clone(&manager_done);
            let manager_escape = manager_escape.clone();
            move || loop {
                match listener.accept() {
                    Ok((_stream, _address)) => {
                        let status = std::process::Command::new("/bin/sh")
                            .args([
                                "-c",
                                &format!("printf escaped > '{}'", manager_escape.display()),
                            ])
                            .status()
                            .expect("manager-assisted launch");
                        assert!(status.success(), "manager-assisted launch failed");
                        return;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if manager_done.load(Ordering::Acquire) {
                            return;
                        }
                        std::thread::yield_now();
                    }
                    Err(error) => panic!("test manager accept failed: {error}"),
                }
            }
        });
        let python = format!(
            "import socket; s=socket.socket(socket.AF_UNIX); s.connect({:?}); s.sendall(b\"spawn\")",
            manager_socket.to_string_lossy()
        );
        let script = executable(
            dir.path(),
            "escape-attempts",
            &format!(
                "/bin/sh -c 'IFS= read -r membership < /proc/self/cgroup; relative=${{membership#0::}}; parent=${{relative%/*}}; printf \"0\\n\" > \"/sys/fs/cgroup$parent/cgroup.procs\"' 2>/dev/null && printf escaped > '{}' || :; \
                 /usr/bin/python3 -c '{}' 2>/dev/null && printf requested > '{}' || :; \
                 /usr/bin/python3 -c 'import socket; s=socket.socket(socket.AF_INET); s.close()'; \
                 printf allowed > '{}'; printf 'codex 1.2.4'",
                direct_escape.display(),
                python,
                manager_request.display(),
                normal_write.display(),
            ),
        );
        let hooks = Arc::new(HostToolLifecycleHooks::default());
        let capture = run_program_capture(
            Arc::new(Semaphore::new(1)),
            Arc::new(ToolResidueSupervisor::default()),
            Arc::clone(&hooks),
            &script,
            &[],
            &test_env(dir.path()),
            ProgramCancellation {
                timeout: Duration::from_secs(2),
                request: &CancellationToken::new(),
                shutdown: &CancellationToken::new(),
            },
        )
        .await
        .expect("sandboxed escape attempts");
        manager_done.store(true, Ordering::Release);
        manager.join().expect("test manager thread");

        assert!(capture.status.is_some_and(|status| status.success()));
        assert_eq!(capture.stdout.text, "codex 1.2.4");
        assert!(
            normal_write.is_file(),
            "HOME mutation was unexpectedly blocked"
        );
        assert!(
            !direct_escape.exists(),
            "direct parent-cgroup escape succeeded"
        );
        assert!(
            !manager_request.exists() && !manager_escape.exists(),
            "user-manager-assisted escape request succeeded"
        );
        assert!(
            !hooks.containment_path().exists(),
            "escape-attempt containment residue remained"
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn successful_parent_cannot_release_a_closed_pipe_setsid_descendant_or_process_permit() {
        require_tool_pids_controller!();
        let dir = tempfile::tempdir().expect("tempdir");
        let child_pid = dir.path().join("child-pid");
        let script = executable(
            dir.path(),
            "fork-and-exit",
            &format!(
                "/usr/bin/setsid /bin/sh -c 'exec </dev/null >/dev/null 2>&1; printf \"%s\" $$ > {}; while :; do :; done' & \
                 while [ ! -s {} ]; do :; done; exit 0",
                child_pid.display(),
                child_pid.display(),
            ),
        );
        let permits = Arc::new(Semaphore::new(1));
        let residue = Arc::new(ToolResidueSupervisor::default());
        let hooks = Arc::new(HostToolLifecycleHooks::default());
        hooks.after_kill.arm();
        let cancelled = CancellationToken::new();
        let shutdown = CancellationToken::new();
        let started = std::time::Instant::now();
        let task = tokio::spawn({
            let permits = Arc::clone(&permits);
            let residue = Arc::clone(&residue);
            let hooks = Arc::clone(&hooks);
            let env = test_env(dir.path());
            async move {
                run_program_capture(
                    permits,
                    residue,
                    hooks,
                    &script,
                    &[],
                    &env,
                    ProgramCancellation {
                        timeout: Duration::from_secs(1),
                        request: &cancelled,
                        shutdown: &shutdown,
                    },
                )
                .await
            }
        });
        hooks.after_kill.wait_until_entered().await;
        assert_eq!(permits.available_permits(), 0);
        let containment_path = hooks.containment_path();
        assert!(containment_path.exists());
        assert_eq!(
            std::fs::read_to_string(containment_path.join("pids.max"))
                .expect("configured pids.max")
                .trim(),
            MAX_CONTAINMENT_PIDS.to_string()
        );
        hooks.after_kill.release();
        let capture = task.await.expect("capture task").expect("capture");
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(
            capture.status.is_some_and(|status| status.success()),
            "unexpected direct status {:?}, stderr {:?}, failure {:?}",
            capture.status,
            capture.stderr.text,
            capture.failure
        );
        assert!(capture
            .failure
            .as_deref()
            .is_some_and(|failure| failure.contains("containment remained populated")));
        assert_eq!(permits.available_permits(), 1);

        let pid = std::fs::read_to_string(child_pid).expect("descendant pid");
        assert!(
            !Path::new("/proc").join(pid.trim()).exists(),
            "closed-pipe descendant remained as a process or zombie"
        );
        assert!(!containment_path.exists(), "tool cgroup residue remained");
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn latest_probe_with_exit_zero_setsid_descendant_is_unknown_and_leaves_no_residue() {
        require_tool_pids_controller!();
        let dir = tempfile::tempdir().expect("tempdir");
        let child_pid = dir.path().join("latest-child-pid");
        executable(
            dir.path(),
            "npm",
            &format!(
                "/usr/bin/setsid /bin/sh -c 'exec </dev/null >/dev/null 2>&1; printf \"%s\" $$ > {}; while :; do :; done' & \
                 while [ ! -s {} ]; do :; done; printf '1.2.4'; exit 0",
                child_pid.display(),
                child_pid.display(),
            ),
        );
        let service = HostToolService::new();
        let hooks = Arc::clone(&service.lifecycle_hooks);
        let error = service
            .latest_version(
                Some(LatestPolicy::Npm("@openai/codex")),
                &test_env(dir.path()),
                &CancellationToken::new(),
                &CancellationToken::new(),
                Duration::from_secs(1),
            )
            .await
            .expect_err("detached latest-probe descendant must prevent a definitive version");
        assert_eq!(error.code, "probe_failed");
        assert!(
            error.detail.contains("containment remained populated"),
            "unexpected latest probe failure: {}",
            error.detail
        );

        let pid = std::fs::read_to_string(child_pid).expect("descendant pid");
        assert!(
            !Path::new("/proc").join(pid.trim()).exists(),
            "latest probe descendant remained as a process or zombie"
        );
        assert!(
            !hooks.containment_path().exists(),
            "latest probe cgroup residue remained"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn incomplete_cgroup_delegation_fails_closed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let containment = ToolContainment {
            path: dir.path().to_path_buf(),
            cleaned: true,
            reap_pids: HashSet::new(),
            reaped_owned_pid: None,
            pending_child: None,
            pending_inventory: None,
            pending_removal: None,
            lifecycle_hooks: Arc::new(HostToolLifecycleHooks::default()),
        };
        let error = containment
            .validate_files()
            .expect_err("ordinary directory must not be accepted as delegated containment");
        assert_eq!(error.code, "containment_unavailable");
        assert!(error.detail.contains("cgroup.procs"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn missing_pids_controller_fails_closed_before_child_admission() {
        let dir = tempfile::tempdir().expect("tempdir");
        for name in [
            "cgroup.procs",
            "cgroup.kill",
            "cgroup.freeze",
            "cgroup.events",
        ] {
            std::fs::write(dir.path().join(name), b"").expect("fake cgroup file");
        }
        let containment = ToolContainment {
            path: dir.path().to_path_buf(),
            cleaned: true,
            reap_pids: HashSet::new(),
            reaped_owned_pid: None,
            pending_child: None,
            pending_inventory: None,
            pending_removal: None,
            lifecycle_hooks: Arc::new(HostToolLifecycleHooks::default()),
        };
        let error = containment
            .validate_files()
            .expect_err("containment without pids.max must fail closed");
        assert_eq!(error.code, "containment_unavailable");
        assert!(error.detail.contains("pids.max"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn pids_max_verification_rejects_unlimited_and_write_read_mismatch() {
        for configured in ["max\n", "63\n"] {
            let error = validate_containment_pids_max(configured)
                .expect_err("unlimited or mismatched pids.max must fail closed");
            assert_eq!(error.code, "containment_unavailable");
            assert!(error.detail.contains("did not retain"));
        }
        validate_containment_pids_max(&format!("{MAX_CONTAINMENT_PIDS}\n"))
            .expect("the exact reviewed pids.max must be accepted");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn delegated_layout_requires_pids_and_kernel_style_enable_readback() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("cgroup.controllers"), b"memory\n")
            .expect("fake controllers");
        std::fs::write(dir.path().join("cgroup.subtree_control"), b"")
            .expect("fake subtree control");
        let error = ensure_pids_subtree_control(dir.path(), "mock service")
            .expect_err("missing pids delegation must fail closed");
        assert!(error.contains("was not delegated"));

        std::fs::write(dir.path().join("cgroup.controllers"), b"pids\n").expect("fake controllers");
        let error = ensure_pids_subtree_control(dir.path(), "mock service")
            .expect_err("a write without kernel-style readback must fail closed");
        assert!(error.contains("did not retain"));

        std::fs::write(dir.path().join("cgroup.subtree_control"), b"pids\n")
            .expect("fake subtree control");
        ensure_pids_subtree_control(dir.path(), "mock service").expect("verified pids delegation");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn manager_leaf_and_restart_attempt_inventory_are_strict() {
        let root = Path::new("/sys/fs/cgroup/example.service");
        assert_eq!(
            service_cgroup_root(&root.join(TOOL_CGROUP_MANAGER_NAME)).expect("manager root"),
            root
        );
        assert_eq!(
            service_cgroup_root(root).expect("pre-subgroup fallback root"),
            root
        );
        assert!(service_cgroup_root(
            &root
                .join(TOOL_CGROUP_ATTEMPTS_NAME)
                .join("spawn-tool-stale")
        )
        .is_err());

        let dir = tempfile::tempdir().expect("tempdir");
        let owned = dir.path().join("spawn-tool-123-1");
        std::fs::create_dir(&owned).expect("owned stale attempt");
        assert_eq!(
            stale_tool_attempt_paths(dir.path()).expect("owned restart inventory"),
            vec![owned]
        );
        std::fs::create_dir(dir.path().join("foreign-control-group"))
            .expect("foreign cgroup fixture");
        let error = stale_tool_attempt_paths(dir.path())
            .expect_err("restart recovery must not mutate an unknown cgroup");
        assert!(error.contains("unowned cgroup"));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn restart_recovery_kills_and_removes_an_owned_stale_attempt() {
        require_tool_pids_controller!();
        let allocated = tokio::task::spawn_blocking(allocate_tool_cgroup)
            .await
            .expect("cgroup setup task")
            .expect("delegated tool cgroup");
        let attempts = allocated.parent().expect("attempts root").to_path_buf();
        std::fs::remove_dir(&allocated).expect("remove unused allocated attempt");
        let service_root = attempts.parent().expect("delegated service root");
        let sequence = TOOL_CGROUP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let recovery_root = service_root.join(format!(
            "spawn-recovery-test-{}-{sequence}",
            std::process::id()
        ));
        std::fs::create_dir(&recovery_root).expect("recovery root cgroup");
        let stale = recovery_root.join(format!("spawn-tool-{}-stale", std::process::id()));
        std::fs::create_dir(&stale).expect("stale attempt cgroup");

        let containment = ToolContainment {
            path: stale.clone(),
            cleaned: true,
            reap_pids: HashSet::new(),
            reaped_owned_pid: None,
            pending_child: None,
            pending_inventory: None,
            pending_removal: None,
            lifecycle_hooks: Arc::new(HostToolLifecycleHooks::default()),
        };
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "while :; do :; done"])
            .kill_on_drop(true);
        containment
            .attach(&mut command)
            .expect("attach stale child");
        let mut child = command.spawn().expect("stale child");

        tokio::task::spawn_blocking({
            let recovery_root = recovery_root.clone();
            move || {
                cleanup_stale_tool_attempts(
                    &recovery_root,
                    tokio::time::Instant::now() + TOOL_CGROUP_RECOVERY_TIMEOUT,
                )
            }
        })
        .await
        .expect("restart recovery task")
        .expect("restart recovery");
        tokio::time::timeout(Duration::from_secs(2), child.wait())
            .await
            .expect("stale child wait deadline")
            .expect("reap stale child");
        assert!(!stale.exists(), "stale attempt cgroup remained");
        std::fs::remove_dir(&recovery_root).expect("remove recovery root cgroup");
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn older_systemd_fallback_moves_service_processes_to_the_manager_leaf() {
        if std::env::var_os("SPAWN_TEST_MANUAL_CGROUP_FALLBACK").is_none() {
            eprintln!("skipped: manual manager-leaf fallback test was not requested");
            return;
        }
        let before = current_cgroup_path().expect("initial service cgroup");
        assert_ne!(
            before.file_name().and_then(|name| name.to_str()),
            Some(TOOL_CGROUP_MANAGER_NAME),
            "fallback fixture unexpectedly started in a systemd manager leaf"
        );
        let allocated = tokio::task::spawn_blocking(allocate_tool_cgroup)
            .await
            .expect("fallback cgroup setup task")
            .expect("fallback delegated tool cgroup");
        let after = current_cgroup_path().expect("manager cgroup membership");
        assert_eq!(
            after.file_name().and_then(|name| name.to_str()),
            Some(TOOL_CGROUP_MANAGER_NAME)
        );
        let root = service_cgroup_root(&after).expect("delegated service root");
        assert!(cgroup_has_token(&root, "cgroup.subtree_control", "pids")
            .expect("pids subtree readback"));
        assert!(allocated.join("pids.max").is_file());
        std::fs::remove_dir(allocated).expect("remove fallback attempt cgroup");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn containment_pid_inventory_accepts_the_cap_and_rejects_cap_plus_one() {
        let dir = tempfile::tempdir().expect("tempdir");
        let at_cap = (1..=MAX_CONTAINMENT_PIDS)
            .map(|pid| pid.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(dir.path().join("cgroup.procs"), format!("{at_cap}\n"))
            .expect("fake cgroup.procs");
        let mut pids = HashSet::new();
        inventory_cgroup_pids_inner(
            dir.path(),
            &mut pids,
            tokio::time::Instant::now() + Duration::from_secs(1),
            0,
            &mut 0,
        )
        .expect("the reviewed PID cap must be accepted");
        assert_eq!(pids.len(), MAX_CONTAINMENT_PIDS);

        std::fs::write(
            dir.path().join("cgroup.procs"),
            format!("{at_cap}\n{}\n", MAX_CONTAINMENT_PIDS + 1),
        )
        .expect("fake cgroup.procs");
        let error = inventory_cgroup_pids_inner(
            dir.path(),
            &mut HashSet::new(),
            tokio::time::Instant::now() + Duration::from_secs(1),
            0,
            &mut 0,
        )
        .expect_err("PID cap plus one must fail closed");
        assert!(error.contains("process limit"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn containment_pid_inventory_rejects_oversized_membership_bytes() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("cgroup.procs"),
            "1\n".repeat((MAX_CONTAINMENT_PID_BYTES as usize / 2) + 1),
        )
        .expect("fake cgroup.procs");
        let error = read_containment_pids(dir.path())
            .expect_err("oversized cgroup membership must fail closed");
        assert!(error.contains("byte limit"));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn owned_child_handle_survives_timeout_and_stale_pid_inventory_is_filtered() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "while :; do :; done"])
            .kill_on_drop(true);
        let child = command.spawn().expect("test child");
        let raw_pid = i32::try_from(child.id().expect("test child pid")).expect("i32 pid");
        let mut containment = ToolContainment {
            path: dir.path().to_path_buf(),
            cleaned: true,
            reap_pids: HashSet::from([raw_pid]),
            reaped_owned_pid: None,
            pending_child: None,
            pending_inventory: None,
            pending_removal: None,
            lifecycle_hooks: Arc::new(HostToolLifecycleHooks::default()),
        };
        containment.retain_owned_child(child);
        containment.lifecycle_hooks.cleanup_owned_child.arm();

        containment
            .reap_owned_child_until(tokio::time::Instant::now() + Duration::from_millis(20))
            .await
            .expect_err("expired cleanup window must retain the owned child");
        assert!(containment.pending_child.is_some());

        containment
            .reap_owned_child_until(tokio::time::Instant::now() + Duration::from_secs(2))
            .await
            .expect("owned child must be reaped through its stable handle");
        assert!(containment.pending_child.is_none());
        assert_eq!(containment.reaped_owned_pid, Some(raw_pid));
        assert!(!containment.reap_pids.contains(&raw_pid));

        let synthetic_descendant = raw_pid.checked_add(1).expect("synthetic descendant pid");
        containment.merge_inventory_pids(HashSet::from([raw_pid, synthetic_descendant]));
        assert!(
            !containment.reap_pids.contains(&raw_pid),
            "a delayed inventory must not turn the reaped direct PID into raw waitpid input"
        );
        assert!(containment.reap_pids.contains(&synthetic_descendant));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn stalled_cleanup_phases_are_bounded_quarantined_and_capacity_gated() {
        require_tool_pids_controller!();
        for phase in [
            StalledCleanupPhase::Freeze,
            StalledCleanupPhase::Inventory,
            StalledCleanupPhase::Populated,
            StalledCleanupPhase::Reap,
            StalledCleanupPhase::Remove,
        ] {
            assert_stalled_cleanup_is_quarantined(phase).await;
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn pre_spawn_containment_failure_removes_the_empty_cgroup_and_releases_capacity() {
        require_tool_pids_controller!();
        let dir = tempfile::tempdir().expect("tempdir");
        let spawn_marker = dir.path().join("must-not-spawn");
        let script = executable(
            dir.path(),
            "pre-spawn-failure",
            &format!("printf spawned > '{}'", spawn_marker.display()),
        );
        let hooks = Arc::new(HostToolLifecycleHooks::default());
        let processes = Arc::new(Semaphore::new(1));
        let supervisor = Arc::new(ToolResidueSupervisor::default());
        for _ in 0..(MAX_PROCESSES * 2) {
            hooks.fail_pre_spawn.store(true, Ordering::Release);
            let error = run_program_capture(
                Arc::clone(&processes),
                Arc::clone(&supervisor),
                hooks.clone(),
                &script,
                &[],
                &test_env(dir.path()),
                ProgramCancellation {
                    timeout: Duration::from_secs(1),
                    request: &CancellationToken::new(),
                    shutdown: &CancellationToken::new(),
                },
            )
            .await
            .expect_err("forced pre-spawn validation failure must fail closed");
            assert_eq!(error.code, "containment_unavailable");
            assert!(!spawn_marker.exists());
            assert!(!hooks.containment_path().exists());
            assert_eq!(processes.available_permits(), 1);
            assert_eq!(supervisor.quarantined(), 0);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn slow_process_group_is_cancelled_and_reaped_within_a_bound() {
        require_tool_pids_controller!();
        let dir = tempfile::tempdir().expect("tempdir");
        let script = executable(dir.path(), "slow", "while :; do :; done");
        let env = test_env(dir.path());
        let cancelled = CancellationToken::new();
        let cancel = cancelled.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            cancel.cancel();
        });
        let started = std::time::Instant::now();
        let capture = run_program_capture(
            Arc::new(Semaphore::new(1)),
            Arc::new(ToolResidueSupervisor::default()),
            Arc::new(HostToolLifecycleHooks::default()),
            &script,
            &[],
            &env,
            ProgramCancellation {
                timeout: Duration::from_secs(5),
                request: &cancelled,
                shutdown: &CancellationToken::new(),
            },
        )
        .await
        .expect("capture");
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(capture
            .failure
            .as_deref()
            .is_some_and(|failure| failure.contains("cancelled")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn aborted_request_keeps_process_claims_until_owned_reap_finishes() {
        require_tool_pids_controller!();
        let dir = tempfile::tempdir().expect("tempdir");
        let pid_file = dir.path().join("installer-pid");
        executable(
            dir.path(),
            "npm",
            &format!(
                "printf '%s' $$ > '{}'; while :; do :; done",
                pid_file.display()
            ),
        );
        executable(dir.path(), "codex", "printf 'codex 1.0.0'");
        let env = test_env(dir.path());
        let service = HostToolService::new();
        service.lifecycle_hooks.after_kill.arm();
        let session_operations = HostToolOperations::new();
        let long_tasks = Arc::new(Semaphore::new(1));
        let long_permit = Arc::clone(&long_tasks)
            .acquire_owned()
            .await
            .expect("long task permit");
        let cancelled = CancellationToken::new();
        let request = {
            let owner = Arc::clone(&service);
            let operation_service = Arc::clone(&service);
            let operation_cancelled = cancelled.clone();
            let session_operations = Arc::clone(&session_operations);
            tokio::spawn(async move {
                owner
                    .run_owned(session_operations, long_permit, cancelled, async move {
                        operation_service
                            .install_with_env(
                                ToolTarget {
                                    target_id: "preset-1".into(),
                                    tool: "codex".into(),
                                },
                                &env,
                                operation_cancelled,
                                CancellationToken::new(),
                            )
                            .await
                    })
                    .await
            })
        };
        tokio::time::timeout(Duration::from_secs(2), async {
            while std::fs::read_to_string(&pid_file)
                .ok()
                .is_none_or(|pid| pid.trim().is_empty())
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("installer did not start");
        let pid: u32 = std::fs::read_to_string(&pid_file)
            .expect("read installer pid")
            .parse()
            .expect("installer pid");

        request.abort();
        let _ = request.await;
        tokio::time::timeout(
            Duration::from_secs(2),
            service.lifecycle_hooks.after_kill.wait_until_entered(),
        )
        .await
        .expect("owned cleanup did not reach reap gate");
        assert_eq!(service.operations.active(), 1);
        assert_eq!(session_operations.active(), 1);
        assert_eq!(service.processes.available_permits(), MAX_PROCESSES - 1);
        assert_eq!(long_tasks.available_permits(), 0);
        assert!(service
            .install_state
            .lock()
            .expect("install claims")
            .active
            .contains("codex"));
        assert!(Path::new("/proc").join(pid.to_string()).exists());
        assert!(
            !session_operations
                .wait_for_idle_until(tokio::time::Instant::now() + Duration::from_millis(10))
                .await,
            "session operation escaped its close deadline accounting"
        );
        let busy = service
            .install_with_env(
                ToolTarget {
                    target_id: "preset-2".into(),
                    tool: "codex".into(),
                },
                &test_env(dir.path()),
                CancellationToken::new(),
                CancellationToken::new(),
            )
            .await
            .expect_err("same-tool claim released before reap");
        assert_eq!(busy.code, "tool_busy");

        service.lifecycle_hooks.after_kill.release();
        assert!(
            session_operations
                .wait_for_idle_until(tokio::time::Instant::now() + Duration::from_secs(2))
                .await
        );
        assert_eq!(service.operations.active(), 0);
        assert_eq!(service.processes.available_permits(), MAX_PROCESSES);
        assert_eq!(long_tasks.available_permits(), 1);
        assert!(service
            .install_state
            .lock()
            .expect("install claims")
            .active
            .is_empty());
        tokio::time::timeout(Duration::from_secs(2), async {
            while Path::new("/proc").join(pid.to_string()).exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("installer remained as a child or zombie after owned reap");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn process_permit_is_held_until_owned_pipe_drains_finish() {
        require_tool_pids_controller!();
        let dir = tempfile::tempdir().expect("tempdir");
        let script = executable(dir.path(), "pipe-drain", "printf output; printf error >&2");
        let processes = Arc::new(Semaphore::new(1));
        let residue = Arc::new(ToolResidueSupervisor::default());
        let hooks = Arc::new(HostToolLifecycleHooks::default());
        hooks.pipe_drain.arm();
        let task = {
            let processes = Arc::clone(&processes);
            let residue = Arc::clone(&residue);
            let hooks = Arc::clone(&hooks);
            let env = test_env(dir.path());
            tokio::spawn(async move {
                run_program_capture(
                    processes,
                    residue,
                    hooks,
                    &script,
                    &[],
                    &env,
                    ProgramCancellation {
                        timeout: Duration::from_secs(1),
                        request: &CancellationToken::new(),
                        shutdown: &CancellationToken::new(),
                    },
                )
                .await
            })
        };
        tokio::time::timeout(
            Duration::from_secs(2),
            hooks.pipe_drain.wait_until_entered(),
        )
        .await
        .expect("pipe drain did not reach ownership gate");
        assert_eq!(processes.available_permits(), 0);
        hooks.pipe_drain.release();
        let capture = task.await.expect("capture task").expect("capture result");
        assert_eq!(capture.stdout.text, "output");
        assert_eq!(capture.stderr.text, "error");
        assert_eq!(processes.available_permits(), 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn multi_target_failure_cancels_and_drains_started_siblings() {
        require_tool_pids_controller!();
        let dir = tempfile::tempdir().expect("tempdir");
        let pid_file = dir.path().join("check-pid");
        executable(
            dir.path(),
            "codex",
            &format!(
                "printf '%s' $$ > '{}'; while :; do :; done",
                pid_file.display()
            ),
        );
        let service = HostToolService::new();
        service.lifecycle_hooks.after_kill.arm();
        let check = {
            let service = Arc::clone(&service);
            let env = Arc::new(test_env(dir.path()));
            tokio::spawn(async move {
                service
                    .check_inner(
                        vec![
                            ToolTarget {
                                target_id: "started".into(),
                                tool: "codex".into(),
                            },
                            ToolTarget {
                                target_id: "failing".into(),
                                tool: "unknown".into(),
                            },
                        ],
                        env,
                        CancellationToken::new(),
                        CancellationToken::new(),
                    )
                    .await
            })
        };
        tokio::time::timeout(
            Duration::from_secs(2),
            service.lifecycle_hooks.after_kill.wait_until_entered(),
        )
        .await
        .expect("started sibling was not cancelled");
        assert!(!check.is_finished(), "check returned before sibling reap");
        assert_eq!(service.processes.available_permits(), MAX_PROCESSES - 1);
        service.lifecycle_hooks.after_kill.release();
        let error = check
            .await
            .expect("check task")
            .expect_err("unsupported sibling must fail the batch");
        assert_eq!(error.code, "unsupported_tool");
        assert_eq!(service.processes.available_permits(), MAX_PROCESSES);
        if let Ok(pid) = std::fs::read_to_string(&pid_file) {
            let pid = pid.trim();
            if !pid.is_empty() {
                assert!(
                    !Path::new("/proc").join(pid).exists(),
                    "cancelled sibling remained as a process or zombie"
                );
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn concurrent_large_output_checks_obey_one_process_cap_and_reap_descendants_on_close() {
        require_tool_pids_controller!();
        let dir = tempfile::tempdir().expect("tempdir");
        let markers = dir.path().join("markers");
        std::fs::create_dir(&markers).expect("marker directory");
        let large_output = "x".repeat(OUTPUT_TAIL_BYTES * 4);
        executable(
            dir.path(),
            "codex",
            &format!(
                "printf '{large_output}'; printf '%s' $$ > '{markers}/parent-'$$; \
                 /bin/sh -c 'printf \"%s\" $$ > {markers}/child-$$; while :; do :; done' & \
                 while :; do :; done",
                markers = markers.display(),
            ),
        );
        let service = HostToolService::new();
        let shutdown = CancellationToken::new();
        let check = {
            let service = Arc::clone(&service);
            let env = Arc::new(test_env(dir.path()));
            let shutdown = shutdown.clone();
            tokio::spawn(async move {
                service
                    .check_inner(
                        (0..MAX_TARGETS)
                            .map(|index| ToolTarget {
                                target_id: format!("target-{index}"),
                                tool: "codex".into(),
                            })
                            .collect(),
                        env,
                        CancellationToken::new(),
                        shutdown,
                    )
                    .await
            })
        };
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let names = std::fs::read_dir(&markers)
                    .expect("marker entries")
                    .filter_map(Result::ok)
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .collect::<Vec<_>>();
                if names
                    .iter()
                    .filter(|name| name.starts_with("parent-"))
                    .count()
                    == MAX_PROCESSES
                    && names
                        .iter()
                        .filter(|name| name.starts_with("child-"))
                        .count()
                        == MAX_PROCESSES
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the admitted process set did not reach its fixed cap");
        assert_eq!(service.processes.available_permits(), 0);
        shutdown.cancel();
        let error = check
            .await
            .expect("check task")
            .expect_err("queued checks must observe session close");
        assert_eq!(error.code, "cancelled");
        assert_eq!(service.processes.available_permits(), MAX_PROCESSES);

        let markers = std::fs::read_dir(&markers)
            .expect("marker entries")
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        assert_eq!(
            markers
                .iter()
                .filter(|entry| entry.file_name().to_string_lossy().starts_with("parent-"))
                .count(),
            MAX_PROCESSES,
            "queued targets escaped process admission"
        );
        for marker in markers {
            let pid = std::fs::read_to_string(marker.path()).expect("recorded pid");
            assert!(
                !Path::new("/proc").join(pid.trim()).exists(),
                "tool process or descendant remained after session close"
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn slow_process_group_times_out_and_is_reaped_within_a_bound() {
        require_tool_pids_controller!();
        let dir = tempfile::tempdir().expect("tempdir");
        let script = executable(dir.path(), "slow", "while :; do :; done");
        let env = test_env(dir.path());
        let started = std::time::Instant::now();
        let capture = run_program_capture(
            Arc::new(Semaphore::new(1)),
            Arc::new(ToolResidueSupervisor::default()),
            Arc::new(HostToolLifecycleHooks::default()),
            &script,
            &[],
            &env,
            ProgramCancellation {
                timeout: Duration::from_millis(20),
                request: &CancellationToken::new(),
                shutdown: &CancellationToken::new(),
            },
        )
        .await
        .expect("capture");
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(capture
            .failure
            .as_deref()
            .is_some_and(|failure| failure.contains("timed out")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pre_effect_cancellation_never_starts_the_installer() {
        let dir = tempfile::tempdir().expect("tempdir");
        let marker = dir.path().join("installer-started");
        executable(
            dir.path(),
            "npm",
            &format!("touch '{}'; printf installed", marker.display()),
        );
        executable(dir.path(), "codex", "printf 'codex 1.0.0'");
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let error = HostToolService::new()
            .install_with_env(
                ToolTarget {
                    target_id: "preset-1".into(),
                    tool: "codex".into(),
                },
                &test_env(dir.path()),
                cancelled,
                CancellationToken::new(),
            )
            .await
            .expect_err("cancelled before execution");
        assert_eq!(error.code, "cancelled");
        assert!(!marker.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn concurrent_installs_for_the_same_tool_fail_closed() {
        require_tool_pids_controller!();
        let dir = tempfile::tempdir().expect("tempdir");
        executable(dir.path(), "npm", "while :; do :; done");
        executable(dir.path(), "codex", "printf 'codex 1.0.0'");
        let env = test_env(dir.path());
        let service = HostToolService::new();
        let first_cancel = CancellationToken::new();
        let first = {
            let service = Arc::clone(&service);
            let env = env.clone();
            let cancelled = first_cancel.clone();
            tokio::spawn(async move {
                service
                    .install_with_env(
                        ToolTarget {
                            target_id: "preset-1".into(),
                            tool: "codex".into(),
                        },
                        &env,
                        cancelled,
                        CancellationToken::new(),
                    )
                    .await
            })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;

        let error = service
            .install_with_env(
                ToolTarget {
                    target_id: "preset-2".into(),
                    tool: "codex".into(),
                },
                &env,
                CancellationToken::new(),
                CancellationToken::new(),
            )
            .await
            .expect_err("second same-tool install");
        assert_eq!(error.code, "tool_busy");

        first_cancel.cancel();
        let first = first
            .await
            .expect("first task")
            .expect("structured outcome");
        assert_eq!(first.outcome, "unknown");
        assert!(!first.success);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shared_install_gate_blocks_all_paths_until_a_separate_definitive_check() {
        require_tool_pids_controller!();
        let dir = tempfile::tempdir().expect("tempdir");
        executable(
            dir.path(),
            "npm",
            "if [ \"$1\" = view ]; then printf '1.2.4'; else printf failed >&2; exit 7; fi",
        );
        executable(dir.path(), "codex", "printf 'codex 1.2.4'");
        let service = HostToolService::new();
        let env = test_env(dir.path());

        let active_legacy = service
            .claim_legacy_install("codex")
            .expect("legacy claim")
            .expect("known tool claim");
        let busy = service
            .install_with_env(
                ToolTarget {
                    target_id: "preset-busy".into(),
                    tool: "codex".into(),
                },
                &env,
                CancellationToken::new(),
                CancellationToken::new(),
            )
            .await
            .expect_err("legacy update must exclude the interactive path");
        assert_eq!(busy.code, "tool_busy");
        drop(active_legacy);

        let unknown = service
            .install_with_env(
                ToolTarget {
                    target_id: "preset-unknown".into(),
                    tool: "codex".into(),
                },
                &env,
                CancellationToken::new(),
                CancellationToken::new(),
            )
            .await
            .expect("post-effect failure is a structured unknown outcome");
        assert_eq!(unknown.outcome, "unknown");

        let interactive = service
            .claim_install("codex")
            .err()
            .expect("interactive retry must await reconciliation");
        assert_eq!(interactive.code, "reconciliation_required");
        let manual = service
            .claim_legacy_install("codex")
            .err()
            .expect("legacy manual retry must await reconciliation");
        assert_eq!(manual.code, "reconciliation_required");
        let automatic = service
            .claim_legacy_executable_install("codex")
            .err()
            .expect("automatic retry must await reconciliation");
        assert_eq!(automatic.code, "reconciliation_required");

        let statuses = service
            .check_inner(
                vec![ToolTarget {
                    target_id: "preset-check".into(),
                    tool: "codex".into(),
                }],
                Arc::new(env.clone()),
                CancellationToken::new(),
                CancellationToken::new(),
            )
            .await
            .expect("separate endpoint check");
        assert!(definitive_status(&statuses[0]));
        let legacy_effect = service
            .claim_legacy_install("codex")
            .expect("definitive check clears reconciliation gate")
            .expect("known tool claim");
        legacy_effect
            .mark_effect_started()
            .expect("legacy effect enters reconciliation gate");
        drop(legacy_effect);
        let legacy_unknown = service
            .claim_install("codex")
            .err()
            .expect("legacy effect ambiguity must block interactive retry");
        assert_eq!(legacy_unknown.code, "reconciliation_required");

        service
            .check_inner(
                vec![ToolTarget {
                    target_id: "preset-legacy-check".into(),
                    tool: "codex".into(),
                }],
                Arc::new(env),
                CancellationToken::new(),
                CancellationToken::new(),
            )
            .await
            .expect("separate check clears legacy effect ambiguity");
        drop(
            service
                .claim_install("codex")
                .expect("legacy ambiguity cleared only after endpoint check"),
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn older_check_cannot_reconcile_an_effect_that_started_after_its_snapshot() {
        require_tool_pids_controller!();
        let dir = tempfile::tempdir().expect("tempdir");
        executable(dir.path(), "npm", "printf '1.2.4'");
        executable(dir.path(), "codex", "printf 'codex 1.2.4'");
        let service = HostToolService::new();
        service.lifecycle_hooks.reconciliation_clear.arm();
        let check = {
            let service = Arc::clone(&service);
            let env = Arc::new(test_env(dir.path()));
            tokio::spawn(async move {
                service
                    .check_inner(
                        vec![ToolTarget {
                            target_id: "older-check".into(),
                            tool: "codex".into(),
                        }],
                        env,
                        CancellationToken::new(),
                        CancellationToken::new(),
                    )
                    .await
            })
        };
        service
            .lifecycle_hooks
            .reconciliation_clear
            .wait_until_entered()
            .await;

        let effect = service
            .claim_install("codex")
            .expect("concurrent effect claim");
        effect
            .mark_effect_started()
            .expect("concurrent effect generation");
        drop(effect);
        service.lifecycle_hooks.reconciliation_clear.release();

        let statuses = check
            .await
            .expect("check task")
            .expect("older check result");
        assert!(definitive_status(&statuses[0]));
        let blocked = service
            .claim_install("codex")
            .err()
            .expect("older check must not reconcile a newer effect generation");
        assert_eq!(blocked.code, "reconciliation_required");

        service
            .check_inner(
                vec![ToolTarget {
                    target_id: "newer-check".into(),
                    tool: "codex".into(),
                }],
                Arc::new(test_env(dir.path())),
                CancellationToken::new(),
                CancellationToken::new(),
            )
            .await
            .expect("newer check reconciles the observed generation");
        drop(
            service
                .claim_install("codex")
                .expect("newer definitive check clears reconciliation"),
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn quarantined_effect_cannot_be_reconciled_or_retried_until_drain_and_new_check() {
        require_tool_pids_controller!();
        let dir = tempfile::tempdir().expect("tempdir");
        let install_pid = dir.path().join("install-pid");
        executable(
            dir.path(),
            "npm",
            &format!(
                "if [ \"$1\" = view ]; then printf '1.2.4'; else printf '%s' $$ > '{}'; while :; do :; done; fi",
                install_pid.display()
            ),
        );
        executable(dir.path(), "codex", "printf 'codex 1.2.4'");
        let service = HostToolService::new();
        service.lifecycle_hooks.cleanup_reap.arm();
        service.lifecycle_hooks.quarantine_reaper.arm();
        let cancelled = CancellationToken::new();
        let install = {
            let service = Arc::clone(&service);
            let cancelled = cancelled.clone();
            let env = test_env(dir.path());
            tokio::spawn(async move {
                service
                    .install_with_env(
                        ToolTarget {
                            target_id: "quarantined-effect".into(),
                            tool: "codex".into(),
                        },
                        &env,
                        cancelled,
                        CancellationToken::new(),
                    )
                    .await
            })
        };
        wait_for_nonempty_file(&install_pid).await;
        cancelled.cancel();
        let result = install
            .await
            .expect("install task")
            .expect("post-effect quarantine result");
        assert_eq!(result.outcome, "unknown");
        assert!(result
            .error
            .as_deref()
            .is_some_and(|error| error.contains("containment_failed")));
        service
            .lifecycle_hooks
            .quarantine_reaper
            .wait_until_entered()
            .await;
        assert_eq!(service.residue_supervisor.quarantined(), 1);

        let retry = service
            .claim_install("codex")
            .err()
            .expect("effect ambiguity must block retry");
        assert_eq!(retry.code, "reconciliation_required");
        let check = service
            .check_inner(
                vec![ToolTarget {
                    target_id: "blocked-check".into(),
                    tool: "codex".into(),
                }],
                Arc::new(test_env(dir.path())),
                CancellationToken::new(),
                CancellationToken::new(),
            )
            .await
            .expect_err("quarantine must gate reconciliation process admission");
        assert_eq!(check.code, "containment_failed");
        assert_eq!(
            service
                .claim_install("codex")
                .err()
                .expect("blocked check cannot clear ambiguity")
                .code,
            "reconciliation_required"
        );

        service.lifecycle_hooks.quarantine_reaper.release();
        assert!(
            service
                .residue_supervisor
                .wait_for_idle_until(tokio::time::Instant::now() + Duration::from_secs(2),)
                .await
        );
        assert_eq!(
            service
                .claim_install("codex")
                .err()
                .expect("drain alone cannot certify the effect")
                .code,
            "reconciliation_required"
        );
        service
            .check_inner(
                vec![ToolTarget {
                    target_id: "post-drain-check".into(),
                    tool: "codex".into(),
                }],
                Arc::new(test_env(dir.path())),
                CancellationToken::new(),
                CancellationToken::new(),
            )
            .await
            .expect("new post-drain check reconciles effect");
        drop(
            service
                .claim_install("codex")
                .expect("post-drain definitive check unlocks retry"),
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn post_spawn_install_failure_is_unknown_and_preserves_bounded_detail() {
        require_tool_pids_controller!();
        let dir = tempfile::tempdir().expect("tempdir");
        executable(
            dir.path(),
            "npm",
            "printf 'private stdout'; printf 'private stderr' >&2; exit 7",
        );
        executable(dir.path(), "codex", "printf 'codex 1.0.0'");
        let service = HostToolService::new();
        let result = service
            .install_with_env(
                ToolTarget {
                    target_id: "preset-1".into(),
                    tool: "codex".into(),
                },
                &test_env(dir.path()),
                CancellationToken::new(),
                CancellationToken::new(),
            )
            .await
            .expect("structured outcome");
        assert_eq!(result.outcome, "unknown");
        assert!(!result.success);
        assert_eq!(result.exit_code, Some(7));
        assert_eq!(result.stdout, "private stdout");
        assert_eq!(result.stderr, "private stderr");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn installer_exit_zero_with_nonzero_version_probe_is_unknown() {
        require_tool_pids_controller!();
        let dir = tempfile::tempdir().expect("tempdir");
        executable(dir.path(), "npm", "printf installed");
        executable(
            dir.path(),
            "codex",
            "printf 'private version failure' >&2; exit 7",
        );
        let result = HostToolService::new()
            .install_with_env(
                ToolTarget {
                    target_id: "preset-1".into(),
                    tool: "codex".into(),
                },
                &test_env(dir.path()),
                CancellationToken::new(),
                CancellationToken::new(),
            )
            .await
            .expect("structured outcome");
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.outcome, "unknown");
        assert!(!result.success);
        let status = result.status.expect("failed reconciliation status");
        assert!(!status.installed);
        assert!(status.path.is_none());
        assert!(status.version.is_none());
        assert!(status
            .error
            .as_deref()
            .is_some_and(|error| error.contains('7')));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn truncated_installed_version_output_is_not_accepted_as_authoritative() {
        require_tool_pids_controller!();
        let dir = tempfile::tempdir().expect("tempdir");
        executable(dir.path(), "npm", "printf '1.2.4'");
        executable(
            dir.path(),
            "codex",
            "i=0; while [ \"$i\" -lt 5000 ]; do printf '\\n'; i=$((i + 1)); done; printf 'codex 1.2.4'",
        );
        let statuses = HostToolService::new()
            .check_inner(
                vec![ToolTarget {
                    target_id: "truncated-version".into(),
                    tool: "codex".into(),
                }],
                Arc::new(test_env(dir.path())),
                CancellationToken::new(),
                CancellationToken::new(),
            )
            .await
            .expect("bounded version check");
        let status = &statuses[0];
        assert!(!status.installed);
        assert!(status.path.is_none());
        assert!(status.version.is_none());
        assert!(status
            .error
            .as_deref()
            .is_some_and(|error| error.contains("exceeded the conservative bound")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn installer_exit_zero_with_version_timeout_is_unknown_and_reaped() {
        require_tool_pids_controller!();
        let dir = tempfile::tempdir().expect("tempdir");
        let pid_file = dir.path().join("version-pid");
        executable(dir.path(), "npm", "printf installed");
        executable(
            dir.path(),
            "codex",
            &format!(
                "printf '%s' $$ > '{}'; while :; do :; done",
                pid_file.display()
            ),
        );
        let result = HostToolService::new()
            .install_with_env_and_check_timeout(
                ToolTarget {
                    target_id: "preset-1".into(),
                    tool: "codex".into(),
                },
                &test_env(dir.path()),
                CancellationToken::new(),
                CancellationToken::new(),
                Duration::from_millis(20),
            )
            .await
            .expect("structured outcome");
        assert_eq!(result.outcome, "unknown");
        assert!(!result.success);
        assert!(result
            .status
            .as_ref()
            .and_then(|status| status.error.as_deref())
            .is_some_and(|error| error.contains("timed out")));
        let pid = std::fs::read_to_string(&pid_file).expect("version pid");
        assert!(!Path::new("/proc").join(pid.trim()).exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn installer_exit_zero_with_cancelled_version_probe_is_unknown_and_reaped() {
        require_tool_pids_controller!();
        let dir = tempfile::tempdir().expect("tempdir");
        let pid_file = dir.path().join("version-pid");
        executable(dir.path(), "npm", "printf installed");
        executable(
            dir.path(),
            "codex",
            &format!(
                "printf '%s' $$ > '{}'; while :; do :; done",
                pid_file.display()
            ),
        );
        let service = HostToolService::new();
        let cancelled = CancellationToken::new();
        let task = {
            let service = Arc::clone(&service);
            let env = test_env(dir.path());
            let cancelled = cancelled.clone();
            tokio::spawn(async move {
                service
                    .install_with_env(
                        ToolTarget {
                            target_id: "preset-1".into(),
                            tool: "codex".into(),
                        },
                        &env,
                        cancelled,
                        CancellationToken::new(),
                    )
                    .await
            })
        };
        wait_for_nonempty_file(&pid_file).await;
        cancelled.cancel();
        let result = task
            .await
            .expect("install task")
            .expect("structured outcome");
        assert_eq!(result.outcome, "unknown");
        assert!(!result.success);
        assert!(result
            .status
            .as_ref()
            .and_then(|status| status.error.as_deref())
            .is_some_and(|error| error.contains("cancelled")));
        let pid = std::fs::read_to_string(&pid_file).expect("version pid");
        assert!(!Path::new("/proc").join(pid.trim()).exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn installer_exit_zero_with_session_close_during_version_is_unknown_and_reaped() {
        require_tool_pids_controller!();
        let dir = tempfile::tempdir().expect("tempdir");
        let pid_file = dir.path().join("version-pid");
        executable(dir.path(), "npm", "printf installed");
        executable(
            dir.path(),
            "codex",
            &format!(
                "printf '%s' $$ > '{}'; while :; do :; done",
                pid_file.display()
            ),
        );
        let service = HostToolService::new();
        let shutdown = CancellationToken::new();
        let task = {
            let service = Arc::clone(&service);
            let env = test_env(dir.path());
            let shutdown = shutdown.clone();
            tokio::spawn(async move {
                service
                    .install_with_env(
                        ToolTarget {
                            target_id: "preset-1".into(),
                            tool: "codex".into(),
                        },
                        &env,
                        CancellationToken::new(),
                        shutdown,
                    )
                    .await
            })
        };
        wait_for_nonempty_file(&pid_file).await;
        shutdown.cancel();
        let result = task
            .await
            .expect("install task")
            .expect("structured outcome");
        assert_eq!(result.outcome, "unknown");
        assert!(!result.success);
        assert!(result
            .status
            .as_ref()
            .and_then(|status| status.error.as_deref())
            .is_some_and(|error| error.contains("session closed")));
        let pid = std::fs::read_to_string(&pid_file).expect("version pid");
        assert!(!Path::new("/proc").join(pid.trim()).exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn installer_exit_zero_without_observed_latest_expectation_is_unknown() {
        require_tool_pids_controller!();
        let dir = tempfile::tempdir().expect("tempdir");
        executable(
            dir.path(),
            "npm",
            "if [ \"$1\" = view ]; then printf '1.2.4'; else printf installed; fi",
        );
        executable(dir.path(), "codex", "printf 'codex 1.2.3'");
        let result = HostToolService::new()
            .install_with_env(
                ToolTarget {
                    target_id: "preset-1".into(),
                    tool: "codex".into(),
                },
                &test_env(dir.path()),
                CancellationToken::new(),
                CancellationToken::new(),
            )
            .await
            .expect("structured outcome");
        assert_eq!(result.outcome, "unknown");
        assert!(!result.success);
        assert_eq!(
            result.status.and_then(|status| status.update_available),
            Some(true)
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn successful_allowlisted_install_is_reconciled_before_acknowledgement() {
        require_tool_pids_controller!();
        let dir = tempfile::tempdir().expect("tempdir");
        executable(
            dir.path(),
            "npm",
            "if [ \"$1\" = view ]; then printf '1.2.4'; else printf installed > \"$HOME/install-marker\"; printf installed > /dev/null; printf 'installed'; fi",
        );
        executable(dir.path(), "codex", "printf 'codex 1.2.4'");
        let service = HostToolService::new();
        let result = service
            .install_with_env(
                ToolTarget {
                    target_id: "preset-1".into(),
                    tool: "codex".into(),
                },
                &test_env(dir.path()),
                CancellationToken::new(),
                CancellationToken::new(),
            )
            .await
            .expect("successful install");
        assert_eq!(result.outcome, "succeeded");
        assert!(result.success);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("install-marker"))
                .expect("HOME install marker"),
            "installed"
        );
        assert_eq!(
            result.status.and_then(|status| status.version).as_deref(),
            Some("codex 1.2.4")
        );
    }
}
