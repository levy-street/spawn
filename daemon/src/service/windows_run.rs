//! HKCU Run bootstrap and watchdog fallback for Windows installations whose
//! Task Scheduler job denies worker breakaway.

use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::time::Duration;

#[cfg(windows)]
use anyhow::Context;
use anyhow::{bail, Result};

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

pub(super) fn value_name(config_dir: &Path) -> String {
    format!("SPAWN D spawnd{}", super::instance_tag(config_dir))
}

#[derive(Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
struct LaunchRecord {
    version: u8,
    instance: String,
    config_dir: PathBuf,
    server: String,
    executable: PathBuf,
}

fn launch_record_path(config_dir: &Path) -> Result<PathBuf> {
    Ok(super::instance_state_dir(config_dir)?.join("launch.json"))
}

#[cfg(windows)]
fn launch_record_path_for_instance(instance: &str) -> Result<PathBuf> {
    if instance.len() != 8
        || !instance
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("invalid SPAWN D watchdog instance tag");
    }
    Ok(dirs::data_local_dir()
        .context("cannot resolve the local application data directory")?
        .join("spawn")
        .join("state")
        .join(instance)
        .join("launch.json"))
}

#[cfg(windows)]
fn shared_bin_dir() -> Result<PathBuf> {
    Ok(dirs::data_local_dir()
        .context("cannot resolve the local application data directory")?
        .join("spawn")
        .join("bin"))
}

/// The legacy shared daemon path every instance used to launch from.
#[cfg(windows)]
fn legacy_daemon() -> Result<PathBuf> {
    Ok(shared_bin_dir()?.join(format!("spawnd{}", std::env::consts::EXE_SUFFIX)))
}

/// Whether `executable` is a path this instance may be launched from: its
/// constant launch path in the release store, or the legacy shared binary a
/// registration made before the store still names.
#[cfg(windows)]
fn acceptable_daemon(config_dir: &Path, executable: &Path) -> Result<bool> {
    if !executable.is_absolute() {
        return Ok(false);
    }
    if let Ok(layout) = crate::install::layout_for_instance(config_dir) {
        if same_windows_path(
            executable,
            &crate::install::launch_path(&layout, config_dir),
        ) {
            return Ok(true);
        }
    }
    Ok(same_windows_path(executable, &legacy_daemon()?))
}

/// The daemon the Run registration's launch record names, when one exists.
#[cfg(windows)]
pub(super) fn registered_binary(config_dir: &Path) -> Option<PathBuf> {
    let record = read_launch_record(&launch_record_path(config_dir).ok()?).ok()?;
    Some(record.executable)
}

/// Whether any launch record under this user's state directory names
/// `binary` — the installer's question before it replaces the legacy pair.
#[cfg(windows)]
pub(super) fn any_record_names(binary: &str) -> bool {
    let Some(state) = dirs::data_local_dir().map(|dir| dir.join("spawn").join("state")) else {
        return false;
    };
    let Ok(entries) = std::fs::read_dir(state) else {
        return false;
    };
    entries.flatten().any(|entry| {
        read_launch_record(&entry.path().join("launch.json"))
            .is_ok_and(|record| same_windows_path(&record.executable, Path::new(binary)))
    })
}

#[cfg(windows)]
fn same_windows_path(left: &Path, right: &Path) -> bool {
    let left = std::fs::canonicalize(left).unwrap_or_else(|_| left.to_path_buf());
    let right = std::fs::canonicalize(right).unwrap_or_else(|_| right.to_path_buf());
    normalize_path(&left.display().to_string()) == normalize_path(&right.display().to_string())
}

fn normalize_path(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .trim_end_matches(['\\', '/'])
        .replace('/', "\\")
        .to_lowercase()
}

#[cfg(windows)]
fn watchdog_command(executable: &Path, instance: &str) -> String {
    format!(
        "\"{}\" __watchdog --instance {instance}",
        executable.display()
    )
}

#[cfg(windows)]
fn write_launch_record(path: &Path, record: &LaunchRecord) -> Result<()> {
    let parent = path.parent().context("launch record has no parent")?;
    std::fs::create_dir_all(parent)?;
    let temporary = path.with_file_name(format!("launch.json.tmp.{}", std::process::id()));
    let bytes = serde_json::to_vec(record)?;
    let result = (|| -> Result<()> {
        std::fs::write(&temporary, bytes)
            .with_context(|| format!("writing {}", temporary.display()))?;
        super::control::protect_path(&temporary)?;
        std::fs::rename(&temporary, path)
            .with_context(|| format!("installing {}", path.display()))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

#[cfg(windows)]
fn read_launch_record(path: &Path) -> Result<LaunchRecord> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    if bytes.len() > 16 * 1024 {
        bail!("SPAWN D watchdog launch record is oversized");
    }
    serde_json::from_slice(&bytes).context("decoding SPAWN D watchdog launch record")
}

#[cfg(windows)]
pub(super) fn install(config_dir: &Path, server: &str) -> Result<()> {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

    let executable = super::launch_bin(config_dir)?;
    if !acceptable_daemon(config_dir, &executable)? {
        bail!(
            "the Run watchdog must use this instance's launch path, not {}",
            executable.display()
        );
    }
    let instance = super::instance_name(config_dir);
    let record = LaunchRecord {
        version: 1,
        instance: instance.clone(),
        config_dir: config_dir.to_path_buf(),
        server: server.to_owned(),
        executable: executable.clone(),
    };
    write_launch_record(&launch_record_path(config_dir)?, &record)?;
    let command_line = watchdog_command(&executable, &instance);
    if command_line.encode_utf16().count() + 1 > 260 {
        bail!("the SPAWN D Run-key command exceeds Windows' 260-character limit");
    }
    registry_set_string(RUN_KEY, &value_name(config_dir), &command_line, None)?;
    let mut command = std::process::Command::new(&executable);
    command.args(["__watchdog", "--instance", &instance]);
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .spawn()
        .context("starting the SPAWN D Run watchdog")?;
    if super::control::wait_for_ping(config_dir, Duration::from_secs(5)).is_none() {
        bail!("the Run watchdog started, but its daemon control pipe did not answer");
    }
    Ok(())
}

#[cfg(windows)]
pub(super) fn uninstall(config_dir: &Path) -> Result<()> {
    registry_delete_value(RUN_KEY, &value_name(config_dir))?;
    let _ = super::control::send(config_dir, super::control::ControlCommand::Shutdown);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        if super::control::ping(config_dir).is_none() && watchdog_lock_is_free(config_dir) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

#[cfg(windows)]
pub(super) fn reconnect(config_dir: &Path, server: &str) -> Result<()> {
    if super::control::send(config_dir, super::control::ControlCommand::Reconnect).is_ok() {
        return Ok(());
    }
    if registry_get_string(RUN_KEY, &value_name(config_dir))?.is_none() {
        return install(config_dir, server);
    }
    let record = read_launch_record(&launch_record_path(config_dir)?)?;
    start_watchdog(&record)?;
    if super::control::wait_for_ping(config_dir, Duration::from_secs(5)).is_none() {
        bail!("the Run watchdog restarted, but its daemon control pipe did not answer");
    }
    Ok(())
}

#[cfg(windows)]
fn start_watchdog(record: &LaunchRecord) -> Result<()> {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

    let mut command = std::process::Command::new(&record.executable);
    command.args(["__watchdog", "--instance", &record.instance]);
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .spawn()
        .context("starting the SPAWN D Run watchdog")?;
    Ok(())
}

#[cfg(windows)]
pub(super) fn status(config_dir: &Path) -> super::ServiceStatus {
    let installed = registry_get_string(RUN_KEY, &value_name(config_dir))
        .ok()
        .flatten()
        .is_some();
    let pipe_pid = super::control::ping(config_dir);
    let running = pipe_pid.is_some_and(|pid| {
        let state = crate::state::read(config_dir).ok().flatten();
        match state {
            Some(state) => {
                state.pid == pid
                    && crate::state::daemon_state_is_live(config_dir, &state)
                    && crate::state::heartbeat_is_fresh(config_dir, Duration::from_secs(90))
            }
            None => crate::state::pid_matches_instance_daemon(config_dir, pid, None),
        }
    });
    let (stdout_log, stderr_log) = super::service_log_paths(config_dir);
    super::ServiceStatus {
        installed,
        running,
        name: value_name(config_dir),
        manager: Some("run-watchdog".into()),
        stdout_log,
        stderr_log,
    }
}

#[cfg(windows)]
pub(super) fn diagnostic(config_dir: &Path) -> Option<String> {
    let actual = registry_get_string(RUN_KEY, &value_name(config_dir))
        .ok()
        .flatten()?;
    let record = launch_record_path(config_dir)
        .ok()
        .and_then(|path| read_launch_record(&path).ok());
    let Some(record) = record else {
        return Some("the SPAWN D watchdog launch record is missing or unreadable".into());
    };
    let expected = watchdog_command(&record.executable, &record.instance);
    if actual != expected {
        return Some("the HKCU Run value differs from SPAWN D's canonical watchdog command".into());
    }
    if validate_record(&record).is_err() {
        return Some("the SPAWN D watchdog launch record is invalid".into());
    }
    None
}

#[cfg(windows)]
fn validate_record(record: &LaunchRecord) -> Result<()> {
    if record.version != 1 || record.instance != super::instance_name(&record.config_dir) {
        bail!("watchdog launch record does not match its config root");
    }
    if !acceptable_daemon(&record.config_dir, &record.executable)? {
        bail!("watchdog launch record names an unexpected executable");
    }
    let stored = super::registered_server(&record.config_dir, &record.server);
    if !super::same_origin(&stored, &record.server) {
        bail!("watchdog launch record names the wrong server origin");
    }
    Ok(())
}

#[cfg(windows)]
pub(super) async fn watchdog(instance: &str) -> Result<()> {
    use std::process::Stdio;

    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

    let record_path = launch_record_path_for_instance(instance)?;
    let record = read_launch_record(&record_path)?;
    validate_record(&record)?;
    acquire_watchdog_lock(&record_path)?;
    super::prepare_background_log(&record.config_dir)?;
    let update_ready = record_path.with_file_name("watchdog-update-ready");
    let _ = std::fs::remove_file(&update_ready);
    let watchdog_pid = std::process::id();
    tracing::info!(
        watchdog_pid,
        instance,
        "SPAWN D watchdog supervision started"
    );

    let mut delay = Duration::from_secs(1);
    loop {
        if !watchdog_registration_matches(&record, "before_launch") {
            return Ok(());
        }
        let mut command = tokio::process::Command::new(&record.executable);
        command
            .args(["--config-dir"])
            .arg(&record.config_dir)
            .args(["--server", &record.server, "run", "--background-service"])
            // The watchdog may have detached a console allocated by the Run
            // key before reaching here. Never inherit those now-invalid
            // handles: CreateProcess rejects them with ERROR_NOT_SUPPORTED.
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        let mut daemon_pid = None;
        let result = match command.spawn() {
            Ok(mut child) => {
                daemon_pid = child.id();
                tracing::info!(
                    watchdog_pid,
                    ?daemon_pid,
                    instance,
                    "SPAWN D watchdog launched daemon"
                );
                let mut registration_poll = tokio::time::interval(Duration::from_millis(100));
                loop {
                    tokio::select! {
                        result = child.wait() => break result,
                        _ = registration_poll.tick() => {
                            if !watchdog_registration_matches(&record, "child_running") {
                                // This retained Child handle is the authority:
                                // never recover a PID from state to stop it.
                                tracing::info!(
                                    watchdog_pid, ?daemon_pid, instance,
                                    "SPAWN D watchdog is stopping its daemon"
                                );
                                if let Err(error) = child.kill().await {
                                    tracing::warn!(
                                        watchdog_pid, ?daemon_pid, instance, %error,
                                        "SPAWN D watchdog could not stop its daemon"
                                    );
                                }
                                log_daemon_exit(watchdog_pid, daemon_pid, instance, &child.wait().await);
                                return Ok(());
                            }
                        }
                    }
                }
            }
            Err(error) => Err(error),
        };
        log_daemon_exit(watchdog_pid, daemon_pid, instance, &result);
        match result {
            Ok(status) if status.success() => {
                // A graceful pipe shutdown exits zero and stops the watchdog.
                // During self-update the probation marker asks the watchdog to
                // launch the newly swapped pair instead.
                if !record.executable.with_file_name("spawnd.updating").exists() {
                    tracing::info!(
                        watchdog_pid,
                        ?daemon_pid,
                        instance,
                        reason = "daemon_exit_zero",
                        "SPAWN D watchdog is exiting"
                    );
                    return Ok(());
                }
                // The helper owns the swap. Do not start either the old or a
                // half-swapped pair until it calls service::relaunch_after_update.
                let ready_deadline = tokio::time::Instant::now() + Duration::from_secs(120);
                tracing::info!(
                    watchdog_pid,
                    instance,
                    "SPAWN D watchdog is waiting for the update helper"
                );
                loop {
                    if !watchdog_registration_matches(&record, "update_wait") {
                        return Ok(());
                    }
                    if update_ready.exists() {
                        let _ = std::fs::remove_file(&update_ready);
                        tracing::info!(
                            watchdog_pid,
                            instance,
                            "SPAWN D update helper released watchdog relaunch"
                        );
                        break;
                    }
                    if tokio::time::Instant::now() >= ready_deadline {
                        tracing::error!(
                            watchdog_pid,
                            instance,
                            reason = "update_wait_timeout",
                            "SPAWN D watchdog is exiting"
                        );
                        bail!("the update helper did not release the Run watchdog relaunch gate");
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                delay = Duration::from_millis(500);
            }
            Ok(status) => {
                tracing::warn!(
                    watchdog_pid,
                    ?daemon_pid,
                    instance,
                    ?status,
                    "SPAWN D daemon exited; watchdog will restart it"
                )
            }
            Err(_) => {}
        }
        tracing::info!(
            watchdog_pid,
            instance,
            ?delay,
            "SPAWN D watchdog is waiting to relaunch daemon"
        );
        let backoff_deadline = tokio::time::Instant::now() + delay;
        while tokio::time::Instant::now() < backoff_deadline {
            if !watchdog_registration_matches(&record, "restart_backoff") {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        delay = (delay * 2).min(Duration::from_secs(30));
    }
}

#[cfg(windows)]
fn log_daemon_exit(
    watchdog_pid: u32,
    daemon_pid: Option<u32>,
    instance: &str,
    result: &std::io::Result<std::process::ExitStatus>,
) {
    match result {
        Ok(status) => tracing::info!(
            watchdog_pid,
            ?daemon_pid,
            instance,
            exit_code = ?status.code(),
            success = status.success(),
            "SPAWN D watchdog observed daemon exit"
        ),
        Err(error) => tracing::error!(
            watchdog_pid,
            ?daemon_pid,
            instance,
            %error,
            "SPAWN D watchdog daemon launch or wait failed"
        ),
    }
}

#[cfg(windows)]
fn watchdog_registration_matches(record: &LaunchRecord, phase: &str) -> bool {
    let watchdog_pid = std::process::id();
    let instance = record.instance.as_str();
    // Keep the stop decision unchanged, but distinguish an explicit removal
    // from a changed value or a registry error. Never log the registry value.
    let reason = match registry_get_string(RUN_KEY, &value_name(&record.config_dir)) {
        Ok(Some(actual)) if actual == watchdog_command(&record.executable, &record.instance) => {
            return true;
        }
        Ok(Some(_)) => "registration_changed",
        Ok(None) => "registration_removed",
        Err(error) => {
            tracing::error!(
                watchdog_pid, instance, phase,
                reason = "registration_unreadable",
                error = %format_args!("{error:#}"),
                "SPAWN D watchdog is stopping"
            );
            return false;
        }
    };
    tracing::info!(
        watchdog_pid,
        instance,
        phase,
        reason,
        "SPAWN D watchdog is stopping"
    );
    false
}

#[cfg(windows)]
pub(super) fn signal_update_ready(config_dir: &Path) -> Result<()> {
    let path = super::instance_state_dir(config_dir)?.join("watchdog-update-ready");
    std::fs::write(&path, b"ready\n").with_context(|| format!("writing {}", path.display()))?;
    super::control::protect_path(&path)
}

#[cfg(windows)]
pub(super) fn prepare_watchdog_log(instance: &str) -> Result<()> {
    let record_path = launch_record_path_for_instance(instance)?;
    let record = read_launch_record(&record_path)?;
    validate_record(&record)?;
    acquire_watchdog_lock(&record_path)?;
    super::prepare_background_log(&record.config_dir)
}

#[cfg(windows)]
fn acquire_watchdog_lock(record_path: &Path) -> Result<()> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::sync::OnceLock;

    static WATCHDOG_LOCK: OnceLock<std::fs::File> = OnceLock::new();
    if WATCHDOG_LOCK.get().is_some() {
        return Ok(());
    }
    let lock_path = record_path.with_file_name("watchdog.lock");
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .share_mode(0)
        .open(&lock_path)
        .with_context(|| format!("another watchdog already owns {}", lock_path.display()))?;
    WATCHDOG_LOCK
        .set(lock)
        .map_err(|_| anyhow::anyhow!("watchdog lock was initialized concurrently"))?;
    Ok(())
}

#[cfg(windows)]
fn watchdog_lock_is_free(config_dir: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;

    let Ok(path) = launch_record_path(config_dir) else {
        return true;
    };
    std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .share_mode(0)
        .open(path.with_file_name("watchdog.lock"))
        .is_ok()
}

#[cfg(not(windows))]
pub(super) async fn watchdog(instance: &str) -> Result<()> {
    let _ = instance;
    bail!("the Run watchdog is only available on Windows")
}

#[cfg(not(windows))]
pub(super) fn prepare_watchdog_log(instance: &str) -> Result<()> {
    let _ = instance;
    bail!("the Run watchdog is only available on Windows")
}

#[cfg(windows)]
pub(super) fn ensure_user_path() -> Result<()> {
    use windows_sys::Win32::System::Registry::{REG_EXPAND_SZ, REG_SZ};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
    };

    let bin = shared_bin_dir()?;
    std::fs::create_dir_all(&bin)?;
    let bin = bin.display().to_string();
    let existing = registry_get_raw(r"Environment", "Path")?;
    let (kind, current) = match existing {
        Some(raw) => {
            let kind = if raw.kind == REG_SZ || raw.kind == REG_EXPAND_SZ {
                raw.kind
            } else {
                REG_EXPAND_SZ
            };
            (kind, decode_registry_string(&raw.data)?)
        }
        None => (REG_EXPAND_SZ, String::new()),
    };
    let already_present = current.split(';').any(|entry| {
        normalize_path(entry) == normalize_path(&bin)
            || expand_environment(entry)
                .is_ok_and(|expanded| normalize_path(&expanded) == normalize_path(&bin))
    });
    if !already_present {
        let updated = if current.trim().is_empty() {
            bin.clone()
        } else {
            format!("{};{bin}", current.trim_end_matches(';'))
        };
        registry_set_string(r"Environment", "Path", &updated, Some(kind))?;
        let environment = to_utf16("Environment");
        let mut ignored = 0_usize;
        // SAFETY: all scalar parameters follow SendMessageTimeoutW's contract;
        // lParam points to a NUL-terminated string for the synchronous call.
        unsafe {
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                environment.as_ptr() as isize,
                SMTO_ABORTIFHUNG,
                5000,
                &mut ignored,
            );
        }
    }
    append_process_path(&bin);
    Ok(())
}

#[cfg(not(windows))]
pub(super) fn ensure_user_path() -> Result<()> {
    Ok(())
}

#[cfg(windows)]
pub(super) fn refresh_user_path() -> Result<()> {
    let Some(raw) = registry_get_raw(r"Environment", "Path")? else {
        return Ok(());
    };
    let user_path = expand_environment(&decode_registry_string(&raw.data)?)?;
    let bin = shared_bin_dir()?.display().to_string();
    let mut entries = std::env::var_os("PATH")
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default()
        .split(';')
        .map(str::to_owned)
        .collect::<Vec<_>>();
    entries.extend(user_path.split(';').map(str::to_owned));
    entries.push(bin);
    let mut seen = std::collections::HashSet::new();
    entries.retain(|entry| !entry.trim().is_empty() && seen.insert(normalize_path(entry)));
    std::env::set_var("PATH", entries.join(";"));
    Ok(())
}

#[cfg(not(windows))]
pub(super) fn refresh_user_path() -> Result<()> {
    Ok(())
}

#[cfg(windows)]
fn append_process_path(entry: &str) {
    let mut entries = std::env::var_os("PATH")
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default()
        .split(';')
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if !entries
        .iter()
        .any(|existing| normalize_path(existing) == normalize_path(entry))
    {
        entries.push(entry.to_owned());
        std::env::set_var("PATH", entries.join(";"));
    }
}

#[cfg(windows)]
fn expand_environment(value: &str) -> Result<String> {
    use windows_sys::Win32::System::Environment::ExpandEnvironmentStringsW;

    let source = to_utf16(value);
    // SAFETY: source is NUL-terminated; null destination requests the size.
    let needed = unsafe { ExpandEnvironmentStringsW(source.as_ptr(), std::ptr::null_mut(), 0) };
    if needed == 0 {
        return Err(std::io::Error::last_os_error()).context("sizing expanded user PATH");
    }
    let mut expanded = vec![0_u16; needed as usize];
    // SAFETY: the destination is exactly the size returned above.
    let written = unsafe {
        ExpandEnvironmentStringsW(
            source.as_ptr(),
            expanded.as_mut_ptr(),
            expanded.len() as u32,
        )
    };
    if written == 0 || written > expanded.len() as u32 {
        return Err(std::io::Error::last_os_error()).context("expanding the user PATH");
    }
    expanded.truncate(written.saturating_sub(1) as usize);
    String::from_utf16(&expanded).context("decoding the expanded user PATH")
}

#[cfg(windows)]
struct RegistryValue {
    kind: u32,
    data: Vec<u8>,
}

#[cfg(windows)]
struct RegistryKey(windows_sys::Win32::System::Registry::HKEY);

#[cfg(windows)]
impl Drop for RegistryKey {
    fn drop(&mut self) {
        // SAFETY: this wrapper uniquely owns the opened registry key.
        unsafe { windows_sys::Win32::System::Registry::RegCloseKey(self.0) };
    }
}

#[cfg(windows)]
fn open_registry_key(path: &str, access: u32, create: bool) -> Result<Option<RegistryKey>> {
    use windows_sys::Win32::Foundation::{
        ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS,
    };
    use windows_sys::Win32::System::Registry::{
        RegCreateKeyExW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, REG_OPTION_NON_VOLATILE,
    };

    let path = to_utf16(path);
    let mut key: HKEY = std::ptr::null_mut();
    let result = if create {
        // SAFETY: path is NUL-terminated and output points at a valid HKEY slot.
        unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                path.as_ptr(),
                0,
                std::ptr::null(),
                REG_OPTION_NON_VOLATILE,
                access,
                std::ptr::null(),
                &mut key,
                std::ptr::null_mut(),
            )
        }
    } else {
        // SAFETY: path is NUL-terminated and output points at a valid HKEY slot.
        unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, path.as_ptr(), 0, access, &mut key) }
    };
    if result == ERROR_SUCCESS {
        Ok(Some(RegistryKey(key)))
    } else if !create && (result == ERROR_FILE_NOT_FOUND || result == ERROR_PATH_NOT_FOUND) {
        Ok(None)
    } else {
        Err(std::io::Error::from_raw_os_error(result as i32))
            .with_context(|| format!("opening HKCU\\{path:?}"))
    }
}

#[cfg(windows)]
fn registry_get_raw(path: &str, name: &str) -> Result<Option<RegistryValue>> {
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{RegQueryValueExW, KEY_QUERY_VALUE, REG_VALUE_TYPE};

    let Some(key) = open_registry_key(path, KEY_QUERY_VALUE, false)? else {
        return Ok(None);
    };
    let name = to_utf16(name);
    let mut kind: REG_VALUE_TYPE = 0;
    let mut size = 0_u32;
    // SAFETY: this is the documented size query with a null data buffer.
    let queried = unsafe {
        RegQueryValueExW(
            key.0,
            name.as_ptr(),
            std::ptr::null(),
            &mut kind,
            std::ptr::null_mut(),
            &mut size,
        )
    };
    if queried == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if queried != ERROR_SUCCESS {
        return Err(std::io::Error::from_raw_os_error(queried as i32))
            .context("sizing a registry value");
    }
    let mut data = vec![0_u8; size as usize];
    // SAFETY: data is `size` bytes long and all pointers remain valid.
    let queried = unsafe {
        RegQueryValueExW(
            key.0,
            name.as_ptr(),
            std::ptr::null(),
            &mut kind,
            data.as_mut_ptr(),
            &mut size,
        )
    };
    if queried != ERROR_SUCCESS {
        return Err(std::io::Error::from_raw_os_error(queried as i32))
            .context("reading a registry value");
    }
    data.truncate(size as usize);
    Ok(Some(RegistryValue { kind, data }))
}

#[cfg(windows)]
fn registry_get_string(path: &str, name: &str) -> Result<Option<String>> {
    registry_get_raw(path, name)?
        .map(|raw| decode_registry_string(&raw.data))
        .transpose()
}

#[cfg(windows)]
fn decode_registry_string(bytes: &[u8]) -> Result<String> {
    if !bytes.len().is_multiple_of(2) {
        bail!("registry string has an odd byte length");
    }
    let mut words = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect::<Vec<_>>();
    while words.last() == Some(&0) {
        words.pop();
    }
    String::from_utf16(&words).context("decoding a registry string")
}

#[cfg(windows)]
fn registry_set_string(path: &str, name: &str, value: &str, kind: Option<u32>) -> Result<()> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegSetValueExW, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_SZ,
    };

    let key = open_registry_key(path, KEY_QUERY_VALUE | KEY_SET_VALUE, true)?
        .context("created registry key was not returned")?;
    let name = to_utf16(name);
    let words = to_utf16(value);
    // SAFETY: words is a live contiguous UTF-16 allocation; the byte view has
    // identical lifetime/alignment requirements and includes the NUL word.
    let bytes = unsafe {
        std::slice::from_raw_parts(words.as_ptr().cast::<u8>(), words.len() * size_of::<u16>())
    };
    // SAFETY: name and value are NUL-terminated and all pointers are live.
    let result = unsafe {
        RegSetValueExW(
            key.0,
            name.as_ptr(),
            0,
            kind.unwrap_or(REG_SZ),
            bytes.as_ptr(),
            bytes.len() as u32,
        )
    };
    if result != ERROR_SUCCESS {
        return Err(std::io::Error::from_raw_os_error(result as i32))
            .context("writing a registry value");
    }
    Ok(())
}

#[cfg(windows)]
fn registry_delete_value(path: &str, name: &str) -> Result<()> {
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{RegDeleteValueW, KEY_SET_VALUE};

    let Some(key) = open_registry_key(path, KEY_SET_VALUE, false)? else {
        return Ok(());
    };
    let name = to_utf16(name);
    // SAFETY: name is a live NUL-terminated registry value name.
    let result = unsafe { RegDeleteValueW(key.0, name.as_ptr()) };
    if result == ERROR_SUCCESS || result == ERROR_FILE_NOT_FOUND {
        Ok(())
    } else {
        Err(std::io::Error::from_raw_os_error(result as i32)).context("deleting a registry value")
    }
}

#[cfg(windows)]
fn to_utf16(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
use std::mem::size_of;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_value_names_are_stable_and_per_instance() {
        let first = Path::new("/spawn/account-one");
        let second = Path::new("/spawn/account-two");
        assert!(value_name(first).starts_with("SPAWN D spawnd-"));
        assert_ne!(value_name(first), value_name(second));
    }

    #[test]
    fn path_normalization_is_case_and_separator_insensitive() {
        assert_eq!(
            normalize_path(r#""C:/Users/Alice/AppData/Local/spawn/bin/""#),
            normalize_path(r"c:\users\alice\appdata\local\spawn\bin")
        );
    }

    #[test]
    fn launch_records_recompute_the_instance_tag() {
        let config = PathBuf::from("/spawn/account-one");
        let record = LaunchRecord {
            version: 1,
            instance: super::super::instance_name(&config),
            config_dir: config,
            server: "https://spawnd.dev".into(),
            executable: PathBuf::from(format!(r"C:\spawn\spawnd{}", std::env::consts::EXE_SUFFIX)),
        };
        let value = serde_json::to_value(&record).unwrap();
        assert_eq!(value["version"], 1);
        assert_eq!(value["instance"].as_str().unwrap().len(), 8);
    }
}
