//! Endpoint-owned interactive tool checks and installs for `spawn.host.ctl`.
//!
//! The browser selects a stable tool kind. It never supplies an executable
//! path, shell string, or argv. Every executed program/argument vector comes
//! from the fixed policy below and is resolved against the endpoint's PATH.

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;

use futures_util::{stream::FuturesUnordered, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
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
const PROCESS_REAP_TIMEOUT: Duration = Duration::from_secs(2);
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
        tool: "aider-sonnet",
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
}

impl HostToolService {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            processes: Arc::new(Semaphore::new(MAX_PROCESSES)),
            installing: StdMutex::new(HashSet::new()),
        })
    }

    pub(crate) fn shared() -> Arc<Self> {
        static SERVICE: OnceLock<Arc<HostToolService>> = OnceLock::new();
        Arc::clone(SERVICE.get_or_init(Self::new))
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
    ) -> Result<Vec<ToolStatus>, ToolError> {
        let env = Arc::new(crate::run::resolved_command_env().await);
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
    ) -> Result<ToolInstallResult, ToolError> {
        let env = crate::run::resolved_command_env().await;
        self.install_with_env(target, &env, cancelled, shutdown)
            .await
    }

    async fn install_with_env(
        self: &Arc<Self>,
        target: ToolTarget,
        env: &BTreeMap<String, String>,
        cancelled: CancellationToken,
        shutdown: CancellationToken,
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
            &resolved,
            &args,
            env,
            INSTALL_TIMEOUT,
            &cancelled,
            &shutdown,
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

        match self.check_one(target, env, &cancelled, &shutdown).await {
            Ok(status) if status.installed => {
                result.outcome = "succeeded";
                result.success = true;
                result.status = Some(status);
            }
            Ok(status) => {
                result.error =
                    Some("installer exited successfully but the tool is not resolvable".into());
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
                    .latest_version(policy.latest, env, cancelled, shutdown)
                    .await,
                update_available: None,
                error: None,
            });
        };
        let capture = run_program_capture(
            Arc::clone(&self.processes),
            &path,
            policy.version_args,
            env,
            CHECK_TIMEOUT,
            cancelled,
            shutdown,
        )
        .await?;
        let version = first_meaningful_line(&capture.stdout.text)
            .or_else(|| first_meaningful_line(&capture.stderr.text));
        let error = if capture.status.is_some_and(|status| status.success()) {
            capture.failure
        } else {
            Some(capture.failure.unwrap_or_else(|| {
                format!(
                    "version command exited with code {}",
                    capture
                        .status
                        .and_then(|status| status.code())
                        .map_or_else(|| "unknown".into(), |code| code.to_string())
                )
            }))
        };
        let latest_version = self
            .latest_version(policy.latest, env, cancelled, shutdown)
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
            error: error.map(|detail| bounded(detail, MAX_DETAIL_BYTES)),
        })
    }

    async fn latest_version(
        &self,
        policy: Option<LatestPolicy>,
        env: &BTreeMap<String, String>,
        cancelled: &CancellationToken,
        shutdown: &CancellationToken,
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
            &path,
            &args,
            env,
            CHECK_TIMEOUT,
            cancelled,
            shutdown,
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

async fn run_program_capture(
    processes: Arc<Semaphore>,
    program: &Path,
    args: &[&str],
    env: &BTreeMap<String, String>,
    timeout: Duration,
    cancelled: &CancellationToken,
    shutdown: &CancellationToken,
) -> Result<ProgramCapture, ToolError> {
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
        let status = tokio::time::timeout(PROCESS_REAP_TIMEOUT, child.wait())
            .await
            .ok()
            .and_then(Result::ok);
        process_group.disarm();
        return Ok(ProgramCapture {
            status,
            stdout: empty_tail(),
            stderr: empty_tail(),
            failure: Some("tool output capture was unavailable after execution started".into()),
        });
    };
    let stdout_task = tokio::spawn(read_tail(stdout));
    let stderr_task = tokio::spawn(read_tail(stderr));
    let mut wait = Box::pin(child.wait());
    let mut failure = None;
    let status = tokio::select! {
        result = &mut wait => match result {
            Ok(status) => Some(status),
            Err(error) => {
                failure = Some(format!("endpoint could not observe tool process completion: {error}"));
                kill_process_group(pid);
                None
            }
        },
        _ = cancelled.cancelled() => {
            failure = Some("tool operation was cancelled after execution started".into());
            kill_process_group(pid);
            tokio::time::timeout(PROCESS_REAP_TIMEOUT, &mut wait).await.ok().and_then(Result::ok)
        }
        _ = shutdown.cancelled() => {
            failure = Some("host session closed after execution started".into());
            kill_process_group(pid);
            tokio::time::timeout(PROCESS_REAP_TIMEOUT, &mut wait).await.ok().and_then(Result::ok)
        }
        _ = tokio::time::sleep(timeout) => {
            failure = Some(format!("tool operation timed out after {} seconds", timeout.as_secs()));
            kill_process_group(pid);
            tokio::time::timeout(PROCESS_REAP_TIMEOUT, &mut wait).await.ok().and_then(Result::ok)
        }
    };
    drop(wait);
    if failure.is_some() {
        let _ = child.start_kill();
        process_group.disarm();
    }
    let (stdout, stderr) = tokio::join!(finish_tail(stdout_task), finish_tail(stderr_task));
    if stdout.1 || stderr.1 {
        kill_process_group(pid);
        failure.get_or_insert_with(|| "tool output pipes did not close before deadline".into());
    }
    process_group.disarm();
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
    match tokio::time::timeout(PROCESS_REAP_TIMEOUT, &mut task).await {
        Ok(Ok(capture)) => (capture, false),
        Ok(Err(_)) => (empty_tail(), false),
        Err(_) => {
            task.abort();
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
        assert!(Arc::ptr_eq(
            &HostToolService::shared(),
            &HostToolService::shared()
        ));
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
            &script,
            &[&malicious],
            &env,
            Duration::from_secs(1),
            &CancellationToken::new(),
            &CancellationToken::new(),
        )
        .await
        .expect("capture");
        assert_eq!(capture.stdout.text, malicious);
        assert!(!marker.exists());

        let oversized = "x".repeat(OUTPUT_TAIL_BYTES + 511);
        let capture = run_program_capture(
            Arc::new(Semaphore::new(1)),
            &script,
            &[&oversized],
            &env,
            Duration::from_secs(1),
            &CancellationToken::new(),
            &CancellationToken::new(),
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
            &script,
            &[],
            &env,
            Duration::from_secs(5),
            &cancelled,
            &CancellationToken::new(),
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
    async fn aborting_capture_future_kills_the_descendant_process_group() {
        let dir = tempfile::tempdir().expect("tempdir");
        let ready = dir.path().join("child-ready");
        let survived = dir.path().join("child-survived");
        let script = executable(
            dir.path(),
            "abortable",
            &format!(
                "(sleep 0.1; touch '{}') & printf ready > '{}'; while :; do :; done",
                survived.display(),
                ready.display()
            ),
        );
        let env = test_env(dir.path());
        let task = tokio::spawn(async move {
            run_program_capture(
                Arc::new(Semaphore::new(1)),
                &script,
                &[],
                &env,
                Duration::from_secs(5),
                &CancellationToken::new(),
                &CancellationToken::new(),
            )
            .await
        });
        for _ in 0..100 {
            if ready.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        assert!(ready.exists(), "child process never started");
        task.abort();
        let _ = task.await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!survived.exists(), "descendant survived task abortion");
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
            &script,
            &[],
            &env,
            Duration::from_millis(20),
            &CancellationToken::new(),
            &CancellationToken::new(),
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
