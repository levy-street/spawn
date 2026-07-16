//! Endpoint-owned interactive tool checks and installs for `spawn.host.ctl`.
//!
//! The browser selects a stable tool kind. It never supplies an executable
//! path, shell string, or argv. Every executed program/argument vector comes
//! from the fixed policy below and is resolved against the endpoint's PATH.

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
#[cfg(test)]
use std::sync::atomic::AtomicBool;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;

use futures_util::{stream::FuturesUnordered, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
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
const SPAWN_BUSY_RETRIES: usize = 3;
const SPAWN_BUSY_RETRY_DELAY: Duration = Duration::from_millis(5);
pub(crate) const MAX_PROCESSES: usize = 4;

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
    installing: StdMutex<HashSet<&'static str>>,
    operations: Arc<HostToolOperations>,
    lifecycle_hooks: Arc<HostToolLifecycleHooks>,
}

#[derive(Default)]
struct HostToolLifecycleHooks {
    #[cfg(test)]
    after_kill: AsyncPause,
    #[cfg(test)]
    pipe_drain: AsyncPause,
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
}

impl HostToolLifecycleHooks {
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
            installing: StdMutex::new(HashSet::new()),
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
            let service = Arc::clone(self);
            let env = Arc::clone(&env);
            let cancelled = operation_cancelled.clone();
            let shutdown = shutdown.clone();
            checks.push(async move {
                (
                    index,
                    service.check_one(target, &env, &cancelled, &shutdown).await,
                )
            });
        }
        let mut ordered = Vec::with_capacity(checks.len());
        ordered.resize_with(checks.len(), || None);
        let mut first_error = None;
        while let Some((index, result)) = checks.next().await {
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
        Ok(ordered.into_iter().flatten().collect())
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
        let capture = run_program_capture(
            Arc::clone(&self.processes),
            Arc::clone(&self.lifecycle_hooks),
            &resolved,
            &args,
            env,
            INSTALL_TIMEOUT,
            ProgramCancellation {
                request: &cancelled,
                shutdown: &shutdown,
            },
        )
        .await?;
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
        let mut installing = self
            .installing
            .lock()
            .map_err(|_| ToolError::new("closed", "tool install registry is unavailable"))?;
        if !installing.insert(tool) {
            return Err(ToolError::new(
                "tool_busy",
                "an install for this tool is already active",
            ));
        }
        Ok(InstallClaim {
            tool,
            service: Arc::clone(self),
        })
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
            return Ok(ToolStatus {
                target_id: target.target_id,
                tool: target.tool,
                command,
                installed: false,
                path: None,
                version: None,
                latest_version: self
                    .latest_version(policy.latest, env, cancelled, shutdown, check_timeout)
                    .await,
                update_available: None,
                error: None,
            });
        };
        let capture = run_program_capture(
            Arc::clone(&self.processes),
            Arc::clone(&self.lifecycle_hooks),
            &path,
            policy.version_args,
            env,
            check_timeout,
            ProgramCancellation {
                request: cancelled,
                shutdown,
            },
        )
        .await?;
        let version = first_meaningful_line(&capture.stdout.text)
            .or_else(|| first_meaningful_line(&capture.stderr.text));
        let error = if let Some(failure) = capture.failure {
            Some(failure)
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
        let latest_version = self
            .latest_version(policy.latest, env, cancelled, shutdown, check_timeout)
            .await;
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
    ) -> Option<String> {
        let (program, args, pip_package) = match policy? {
            LatestPolicy::Npm(package) => ("npm", vec!["view", package, "version"], None),
            LatestPolicy::Pip(package) => (
                "python3",
                vec!["-m", "pip", "index", "versions", package],
                Some(package),
            ),
        };
        let path = resolve_executable(program, env)?;
        let capture = run_program_capture(
            Arc::clone(&self.processes),
            Arc::clone(&self.lifecycle_hooks),
            &path,
            &args,
            env,
            timeout,
            ProgramCancellation {
                request: cancelled,
                shutdown,
            },
        )
        .await
        .ok()?;
        if !capture.status.is_some_and(|status| status.success()) {
            return None;
        }
        match pip_package {
            Some(package) => parse_pip_latest_version(package, &capture.stdout.text),
            None => first_meaningful_line(&capture.stdout.text),
        }
    }
}

struct InstallClaim {
    tool: &'static str,
    service: Arc<HostToolService>,
}

impl Drop for InstallClaim {
    fn drop(&mut self) {
        if let Ok(mut installing) = self.service.installing.lock() {
            installing.remove(self.tool);
        }
    }
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

#[derive(Clone, Copy)]
struct ProgramCancellation<'a> {
    request: &'a CancellationToken,
    shutdown: &'a CancellationToken,
}

async fn run_program_capture(
    processes: Arc<Semaphore>,
    lifecycle_hooks: Arc<HostToolLifecycleHooks>,
    program: &Path,
    args: &[&str],
    env: &BTreeMap<String, String>,
    timeout: Duration,
    cancellation: ProgramCancellation<'_>,
) -> Result<ProgramCapture, ToolError> {
    let ProgramCancellation {
        request: cancelled,
        shutdown,
    } = cancellation;
    let _permit = acquire_process_permit(processes, cancelled, shutdown).await?;
    if cancelled.is_cancelled() || shutdown.is_cancelled() {
        return Err(ToolError::new("cancelled", "tool operation was cancelled"));
    }
    let mut spawn_attempt = 0;
    let mut child = loop {
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
        match command.spawn() {
            Ok(child) => break child,
            Err(error)
                if error.raw_os_error() == Some(26) && spawn_attempt < SPAWN_BUSY_RETRIES =>
            {
                spawn_attempt += 1;
                tokio::select! {
                    _ = tokio::time::sleep(SPAWN_BUSY_RETRY_DELAY) => {}
                    _ = cancelled.cancelled() => return Err(ToolError::new("cancelled", "tool operation was cancelled")),
                    _ = shutdown.cancelled() => return Err(ToolError::new("cancelled", "host session closed")),
                }
            }
            Err(error) => {
                return Err(ToolError::new(
                    "spawn_failed",
                    format!("endpoint failed to start allowlisted program: {error}"),
                ));
            }
        }
    };
    let pid = child.id();
    let mut process_group = ProcessGroupGuard { pid, armed: true };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (Some(stdout), Some(stderr)) = (stdout, stderr) else {
        kill_process_group(pid);
        let _ = child.start_kill();
        let status = child.wait().await.ok();
        process_group.disarm();
        return Ok(ProgramCapture {
            status,
            stdout: empty_tail(),
            stderr: empty_tail(),
            failure: Some("tool output capture was unavailable after execution started".into()),
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
    let status = match completion {
        Completion::Exited(Ok(status)) => Some(status),
        Completion::Exited(Err(error)) => {
            failure = Some(format!(
                "endpoint could not observe tool process completion: {error}"
            ));
            kill_process_group(pid);
            let _ = child.start_kill();
            child.wait().await.ok()
        }
        Completion::Cancelled(detail) => {
            failure = Some(detail.into());
            kill_process_group(pid);
            let _ = child.start_kill();
            lifecycle_hooks.pause_after_kill().await;
            // The service-owned operation deliberately waits without a second
            // timeout. Session close may stop waiting at its one absolute
            // deadline, but this task retains the process permit and install
            // claim until the child has actually been reaped.
            child.wait().await.ok()
        }
        Completion::TimedOut => {
            failure = Some(format!(
                "tool operation timed out after {} seconds",
                timeout.as_secs()
            ));
            kill_process_group(pid);
            let _ = child.start_kill();
            lifecycle_hooks.pause_after_kill().await;
            child.wait().await.ok()
        }
    };
    process_group.disarm();
    let (stdout, stderr) = tokio::join!(finish_tail(stdout_task), finish_tail(stderr_task));
    if stdout.1 || stderr.1 {
        kill_process_group(pid);
        failure.get_or_insert_with(|| "tool output pipes did not close before deadline".into());
    }
    Ok(ProgramCapture {
        status,
        stdout: stdout.0,
        stderr: stderr.0,
        failure,
    })
}

struct ProcessGroupGuard {
    pid: Option<u32>,
    armed: bool,
}

impl ProcessGroupGuard {
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for ProcessGroupGuard {
    fn drop(&mut self) {
        if self.armed {
            kill_process_group(self.pid);
        }
    }
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

#[cfg(unix)]
fn kill_process_group(pid: Option<u32>) {
    use nix::sys::signal::{killpg, Signal};
    use nix::unistd::Pid;
    if let Some(pid) = pid.and_then(|pid| i32::try_from(pid).ok()) {
        let _ = killpg(Pid::from_raw(pid), Signal::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_process_group(_pid: Option<u32>) {}

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
        let dir = tempfile::tempdir().expect("tempdir");
        let script = executable(dir.path(), "literal", "printf '%s' \"$1\"");
        let marker = dir.path().join("must-not-exist");
        let malicious = format!("$(touch {})", marker.display());
        let env = test_env(dir.path());
        let capture = run_program_capture(
            Arc::new(Semaphore::new(1)),
            Arc::new(HostToolLifecycleHooks::default()),
            &script,
            &[&malicious],
            &env,
            Duration::from_secs(1),
            ProgramCancellation {
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
            Arc::new(HostToolLifecycleHooks::default()),
            &script,
            &[&oversized],
            &env,
            Duration::from_secs(1),
            ProgramCancellation {
                request: &CancellationToken::new(),
                shutdown: &CancellationToken::new(),
            },
        )
        .await
        .expect("capture");
        assert!(capture.stdout.truncated);
        assert_eq!(capture.stdout.text.len(), OUTPUT_TAIL_BYTES);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn slow_process_group_is_cancelled_and_reaped_within_a_bound() {
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
            Arc::new(HostToolLifecycleHooks::default()),
            &script,
            &[],
            &env,
            Duration::from_secs(5),
            ProgramCancellation {
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
            .installing
            .lock()
            .expect("install claims")
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
            .installing
            .lock()
            .expect("install claims")
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
        let dir = tempfile::tempdir().expect("tempdir");
        let script = executable(dir.path(), "pipe-drain", "printf output; printf error >&2");
        let processes = Arc::new(Semaphore::new(1));
        let hooks = Arc::new(HostToolLifecycleHooks::default());
        hooks.pipe_drain.arm();
        let task = {
            let processes = Arc::clone(&processes);
            let hooks = Arc::clone(&hooks);
            let env = test_env(dir.path());
            tokio::spawn(async move {
                run_program_capture(
                    processes,
                    hooks,
                    &script,
                    &[],
                    &env,
                    Duration::from_secs(1),
                    ProgramCancellation {
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
        let dir = tempfile::tempdir().expect("tempdir");
        let script = executable(dir.path(), "slow", "while :; do :; done");
        let env = test_env(dir.path());
        let started = std::time::Instant::now();
        let capture = run_program_capture(
            Arc::new(Semaphore::new(1)),
            Arc::new(HostToolLifecycleHooks::default()),
            &script,
            &[],
            &env,
            Duration::from_millis(20),
            ProgramCancellation {
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
    async fn post_spawn_install_failure_is_unknown_and_preserves_bounded_detail() {
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
    async fn installer_exit_zero_with_version_timeout_is_unknown_and_reaped() {
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
        let dir = tempfile::tempdir().expect("tempdir");
        executable(
            dir.path(),
            "npm",
            "if [ \"$1\" = view ]; then printf '1.2.4'; else printf 'installed'; fi",
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
            result.status.and_then(|status| status.version).as_deref(),
            Some("codex 1.2.4")
        );
    }
}
