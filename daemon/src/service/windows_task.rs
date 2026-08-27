//! Least-privilege per-user Task Scheduler manager for Windows.

use std::path::Path;
#[cfg(windows)]
use std::time::Duration;

use anyhow::{bail, Context, Result};

pub(super) fn task_name(config_dir: &Path) -> String {
    format!("SPAWN D spawnd{}", super::instance_tag(config_dir))
}

fn scheduler_binary() -> String {
    format!("schtasks{}", std::env::consts::EXE_SUFFIX)
}

#[cfg(windows)]
fn scheduler_command() -> std::process::Command {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

    let mut command = std::process::Command::new(scheduler_binary());
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(not(windows))]
fn scheduler_command() -> std::process::Command {
    std::process::Command::new(scheduler_binary())
}

fn quote_windows_argument(value: &str) -> String {
    if !value.is_empty()
        && !value
            .chars()
            .any(|character| character.is_whitespace() || character == '"')
    {
        return value.to_owned();
    }
    let mut quoted = String::from("\"");
    let mut backslashes = 0_usize;
    for character in value.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                quoted.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                quoted.extend(std::iter::repeat_n('\\', backslashes));
                backslashes = 0;
                quoted.push(character);
            }
        }
    }
    quoted.extend(std::iter::repeat_n('\\', backslashes * 2));
    quoted.push('"');
    quoted
}

fn task_arguments(config_dir: &Path, server: &str) -> String {
    [
        "--config-dir".to_owned(),
        quote_windows_argument(&config_dir.display().to_string()),
        "--server".to_owned(),
        quote_windows_argument(server),
        "run".to_owned(),
        "--background-service".to_owned(),
    ]
    .join(" ")
}

fn task_xml(config_dir: &Path, bin: &Path, server: &str, sid: &str) -> Result<String> {
    let bin_display = bin.display().to_string();
    if !absolute_action_path(&bin_display) {
        bail!("Task Scheduler actions require an absolute spawnd path");
    }
    let working_dir = bin_display
        .rfind(['\\', '/'])
        .filter(|index| *index > 0)
        .map(|index| &bin_display[..index])
        .context("the spawnd task executable has no parent directory")?;
    let tag = super::instance_name(config_dir);
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n\
<Task version=\"1.3\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">\n\
  <RegistrationInfo>\n\
    <Author>SPAWN D</Author>\n\
    <Description>SPAWN D background daemon for account instance {tag}</Description>\n\
  </RegistrationInfo>\n\
  <Triggers>\n\
    <LogonTrigger>\n\
      <Enabled>true</Enabled>\n\
      <UserId>{sid}</UserId>\n\
    </LogonTrigger>\n\
  </Triggers>\n\
  <Principals>\n\
    <Principal id=\"SpawnUser\">\n\
      <UserId>{sid}</UserId>\n\
      <LogonType>InteractiveToken</LogonType>\n\
      <RunLevel>LeastPrivilege</RunLevel>\n\
    </Principal>\n\
  </Principals>\n\
  <Settings>\n\
    <RestartOnFailure>\n\
      <Interval>PT1M</Interval>\n\
      <Count>255</Count>\n\
    </RestartOnFailure>\n\
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\n\
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\n\
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\n\
    <AllowHardTerminate>true</AllowHardTerminate>\n\
    <StartWhenAvailable>true</StartWhenAvailable>\n\
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>\n\
    <AllowStartOnDemand>true</AllowStartOnDemand>\n\
    <Enabled>true</Enabled>\n\
    <Hidden>true</Hidden>\n\
    <RunOnlyIfIdle>false</RunOnlyIfIdle>\n\
    <WakeToRun>false</WakeToRun>\n\
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>\n\
    <Priority>7</Priority>\n\
  </Settings>\n\
  <Actions Context=\"SpawnUser\">\n\
    <Exec>\n\
      <Command>{bin}</Command>\n\
      <Arguments>{arguments}</Arguments>\n\
      <WorkingDirectory>{working_dir}</WorkingDirectory>\n\
    </Exec>\n\
  </Actions>\n\
</Task>\n",
        tag = super::xml_escape(&tag),
        sid = super::xml_escape(sid),
        bin = super::xml_escape(&bin_display),
        arguments = super::xml_escape(&task_arguments(config_dir, server)),
        working_dir = super::xml_escape(working_dir),
    ))
}

fn absolute_action_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    value.starts_with(r"\\")
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'\\' | b'/'))
        || Path::new(value).is_absolute()
}

fn utf16le_document(xml: &str) -> Vec<u8> {
    let mut bytes = vec![0xff, 0xfe];
    for code_unit in xml.encode_utf16() {
        bytes.extend_from_slice(&code_unit.to_le_bytes());
    }
    bytes
}

#[cfg(windows)]
fn schtasks(args: &[&str]) -> Result<std::process::ExitStatus> {
    scheduler_command()
        .args(args)
        .status()
        .with_context(|| format!("running {} {}", scheduler_binary(), args.join(" ")))
}

#[cfg(windows)]
fn schtasks_quiet(args: &[&str]) -> bool {
    scheduler_command()
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(windows)]
fn query_xml(config_dir: &Path) -> Option<String> {
    let output = scheduler_command()
        .args(["/Query", "/TN", &task_name(config_dir), "/XML"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(decode_command_text(&output.stdout))
}

#[cfg(windows)]
fn decode_command_text(bytes: &[u8]) -> String {
    let little_endian =
        bytes.starts_with(&[0xff, 0xfe]) || (bytes.len() >= 4 && bytes[1] == 0 && bytes[3] == 0);
    if little_endian {
        let offset = usize::from(bytes.starts_with(&[0xff, 0xfe])) * 2;
        let words = bytes[offset..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        String::from_utf16_lossy(&words)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

#[cfg(windows)]
pub(super) fn install(config_dir: &Path, server: &str) -> Result<()> {
    let bin = super::current_bin()?;
    if !bin.is_absolute() {
        bail!("the running spawnd executable path is not absolute");
    }
    let sid = super::control::current_user_sid()?;
    let xml = task_xml(config_dir, &bin, server, &sid)?;
    let temporary = super::instance_state_dir(config_dir)?.join("task.xml.tmp");
    std::fs::write(&temporary, utf16le_document(&xml))
        .with_context(|| format!("writing {}", temporary.display()))?;
    let result = (|| -> Result<()> {
        let path = temporary.to_string_lossy().into_owned();
        let name = task_name(config_dir);
        let created = schtasks(&["/Create", "/TN", &name, "/XML", &path, "/F"])?;
        if !created.success() {
            bail!("{} /Create failed for {name}", scheduler_binary());
        }
        run_registered(config_dir)?;
        let Some(pid) = super::control::wait_for_ping(config_dir, Duration::from_secs(5)) else {
            bail!("Task Scheduler started {name}, but its control pipe did not answer");
        };
        if wait_for_breakaway_marker(config_dir, pid, Duration::from_secs(5)).is_none() {
            bail!("Task Scheduler started {name}, but the worker-breakaway probe was inconclusive");
        }
        Ok(())
    })();
    let _ = std::fs::remove_file(&temporary);
    result
}

#[cfg(windows)]
fn wait_for_breakaway_marker(config_dir: &Path, pid: u32, timeout: Duration) -> Option<bool> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if let Some(denied) = crate::state::read(config_dir)
            .ok()
            .flatten()
            .filter(|state| state.pid == pid)
            .and_then(|state| state.task_breakaway_denied)
        {
            return Some(denied);
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(windows)]
pub(super) fn run_registered(config_dir: &Path) -> Result<()> {
    let name = task_name(config_dir);
    if !schtasks(&["/Run", "/TN", &name])?.success() {
        bail!("{} /Run failed for {name}", scheduler_binary());
    }
    Ok(())
}

#[cfg(windows)]
pub(super) fn uninstall(config_dir: &Path) -> Result<()> {
    let name = task_name(config_dir);
    let installed = schtasks_quiet(&["/Query", "/TN", &name, "/XML"]);
    if !installed {
        return Ok(());
    }
    let _ = schtasks(&["/Change", "/TN", &name, "/Disable"]);
    let _ = super::control::send(config_dir, super::control::ControlCommand::Shutdown);
    wait_for_daemon_exit(config_dir, Duration::from_secs(5));
    let tracked_process_alive = crate::state::read(config_dir)
        .ok()
        .flatten()
        .is_some_and(|state| crate::state::pid_is_alive(state.pid));
    if super::control::ping(config_dir).is_some() || tracked_process_alive {
        let _ = schtasks(&["/End", "/TN", &name]);
        wait_for_daemon_exit(config_dir, Duration::from_secs(5));
    }
    let deleted = schtasks(&["/Delete", "/TN", &name, "/F"])?;
    if !deleted.success() {
        bail!("{} /Delete failed for {name}", scheduler_binary());
    }
    Ok(())
}

#[cfg(windows)]
fn wait_for_daemon_exit(config_dir: &Path, timeout: Duration) {
    let tracked_pid = crate::state::read(config_dir)
        .ok()
        .flatten()
        .map(|state| state.pid);
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        let pipe_gone = super::control::ping(config_dir).is_none();
        let process_gone = tracked_pid.is_none_or(|pid| !crate::state::pid_is_alive(pid));
        if pipe_gone && process_gone {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(windows)]
pub(super) fn reconnect(config_dir: &Path, server: &str) -> Result<()> {
    if super::control::send(config_dir, super::control::ControlCommand::Reconnect).is_ok() {
        return Ok(());
    }
    if query_xml(config_dir).is_none() {
        return install(config_dir, server);
    }
    let breakaway = crate::state::read(config_dir)
        .ok()
        .flatten()
        .filter(crate::state::daemon_state_is_live)
        .filter(|_| crate::state::heartbeat_is_fresh(config_dir, Duration::from_secs(90)))
        .and_then(|state| state.task_breakaway_denied);
    if breakaway != Some(false) {
        bail!(
            "Task Scheduler worker breakaway is not available; re-run spawnd possess to choose or confirm the background mode"
        );
    }
    let name = task_name(config_dir);
    let _ = schtasks(&["/End", "/TN", &name]);
    wait_for_daemon_exit(config_dir, Duration::from_secs(5));
    run_registered(config_dir)?;
    if super::control::wait_for_ping(config_dir, Duration::from_secs(5)).is_none() {
        bail!("Task Scheduler restarted {name}, but its control pipe did not answer");
    }
    Ok(())
}

#[cfg(windows)]
pub(super) fn status(config_dir: &Path) -> super::ServiceStatus {
    let installed = query_xml(config_dir).is_some();
    let pipe_pid = super::control::ping(config_dir);
    let running = pipe_pid.is_some_and(|pid| {
        let state = crate::state::read(config_dir).ok().flatten();
        match state {
            Some(state) => {
                state.pid == pid
                    && crate::state::daemon_state_is_live(&state)
                    && crate::state::heartbeat_is_fresh(config_dir, Duration::from_secs(90))
            }
            None => crate::state::pid_matches_current_daemon(pid, None),
        }
    });
    let (stdout_log, stderr_log) = super::service_log_paths(config_dir);
    super::ServiceStatus {
        installed,
        running,
        name: task_name(config_dir),
        manager: Some("task-scheduler".into()),
        stdout_log,
        stderr_log,
    }
}

#[cfg(windows)]
pub(super) fn diagnostic(config_dir: &Path) -> Option<String> {
    let xml = query_xml(config_dir)?;
    let bin = super::current_bin().ok()?;
    let server = super::registered_server(config_dir, "");
    let sid = super::control::current_user_sid().ok()?;
    let required = [
        format!("<UserId>{}</UserId>", super::xml_escape(&sid)),
        "<LogonType>InteractiveToken</LogonType>".into(),
        "<RunLevel>LeastPrivilege</RunLevel>".into(),
        "<Interval>PT1M</Interval>".into(),
        "<Count>255</Count>".into(),
        "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>".into(),
        "<Hidden>true</Hidden>".into(),
        "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>".into(),
        format!(
            "<Command>{}</Command>",
            super::xml_escape(&bin.display().to_string())
        ),
        format!(
            "<Arguments>{}</Arguments>",
            super::xml_escape(&task_arguments(config_dir, &server))
        ),
    ];
    (!required.iter().all(|field| xml.contains(field))).then(|| {
        "the registered Task Scheduler XML differs from SPAWN D's canonical definition".into()
    })
}

#[cfg(windows)]
pub(super) fn prepare_background_log(config_dir: &Path) -> Result<()> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;

    use windows_sys::Win32::Storage::FileSystem::{
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    use windows_sys::Win32::System::Console::{
        GetConsoleWindow, SetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE,
    };

    // A foreground `spawnd run` keeps its terminal. Scheduler/watchdog starts
    // have no console and must own their diagnostics before the first event.
    // SAFETY: GetConsoleWindow takes no pointers and returns a borrowed HWND.
    if !unsafe { GetConsoleWindow() }.is_null() {
        return Ok(());
    }
    static DAEMON_LOG: OnceLock<std::fs::File> = OnceLock::new();
    if DAEMON_LOG.get().is_some() {
        return Ok(());
    }
    let path = super::instance_log_dir(config_dir)?.join("spawnd.log");
    if std::fs::metadata(&path).is_ok_and(|metadata| metadata.len() > 10 * 1024 * 1024) {
        let rotated = path.with_extension("log.1");
        let _ = std::fs::remove_file(&rotated);
        std::fs::rename(&path, &rotated).with_context(|| format!("rotating {}", path.display()))?;
    }
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .open(&path)
        .with_context(|| format!("opening {}", path.display()))?;
    let handle = file.as_raw_handle().cast();
    // SAFETY: `file` is installed into a process-lifetime OnceLock below, so
    // both standard-handle references remain live until process exit.
    if unsafe { SetStdHandle(STD_OUTPUT_HANDLE, handle) } == 0
        || unsafe { SetStdHandle(STD_ERROR_HANDLE, handle) } == 0
    {
        return Err(std::io::Error::last_os_error()).context("redirecting service output to log");
    }
    DAEMON_LOG
        .set(file)
        .map_err(|_| anyhow::anyhow!("daemon log was initialized concurrently"))?;
    Ok(())
}

#[cfg(not(windows))]
pub(super) fn prepare_background_log(config_dir: &Path) -> Result<()> {
    let _ = config_dir;
    Ok(())
}

#[cfg(windows)]
pub(super) fn probe_breakaway(config_dir: &Path) -> Option<bool> {
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;

    use windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED;
    use windows_sys::Win32::System::JobObjects::IsProcessInJob;
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, CREATE_BREAKAWAY_FROM_JOB, CREATE_NO_WINDOW,
    };

    if super::preferred_mode(config_dir) != super::ServiceMode::Task {
        return None;
    }
    let mut parent_in_job = 0;
    // SAFETY: the pseudo-handle is always valid and the result slot is live.
    if unsafe {
        IsProcessInJob(
            GetCurrentProcess(),
            std::ptr::null_mut(),
            &mut parent_in_job,
        )
    } == 0
        || parent_in_job == 0
    {
        return None;
    }
    let mut command = std::process::Command::new(super::current_bin().ok()?);
    command.arg("--version");
    command.creation_flags(CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) if error.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) => {
            tracing::warn!("Task Scheduler denied SPAWN D's worker-breakaway probe");
            return Some(true);
        }
        Err(error) => {
            tracing::warn!(%error, "SPAWN D's worker-breakaway probe was inconclusive");
            return None;
        }
    };
    let mut child_in_job = 0;
    // SAFETY: Child owns a valid process handle until it is dropped.
    let queried = unsafe {
        IsProcessInJob(
            child.as_raw_handle().cast(),
            std::ptr::null_mut(),
            &mut child_in_job,
        )
    };
    let _ = child.wait();
    if queried == 0 {
        tracing::warn!("SPAWN D could not verify its worker-breakaway probe child");
        return None;
    }
    let denied = child_in_job != 0;
    if denied {
        tracing::warn!("Task Scheduler kept SPAWN D's breakaway probe inside its job");
    } else {
        tracing::info!("Task Scheduler permits SPAWN D worker breakaway");
    }
    Some(denied)
}

#[cfg(not(windows))]
pub(super) fn probe_breakaway(config_dir: &Path) -> Option<bool> {
    let _ = config_dir;
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_xml_is_the_canonical_least_privilege_definition() {
        let config = Path::new(r"C:\Users\Al ice & Co\AppData\Roaming\spawn\帐户");
        let bin = Path::new(r"C:\Users\Al ice & Co\AppData\Local\spawn\bin\spawnd.exe");
        let xml = task_xml(
            config,
            bin,
            "https://example.test/a?x=1&name=\"quoted\"",
            "S-1-5-21-111-222-333-1001",
        )
        .unwrap();
        for required in [
            "version=\"1.3\"",
            "<LogonType>InteractiveToken</LogonType>",
            "<RunLevel>LeastPrivilege</RunLevel>",
            "<Interval>PT1M</Interval>",
            "<Count>255</Count>",
            "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
            "<Hidden>true</Hidden>",
            "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
            "run --background-service</Arguments>",
        ] {
            assert!(xml.contains(required), "missing {required}");
        }
        assert!(xml.contains("Al ice &amp; Co"));
        assert!(xml.contains("帐户"));
        assert!(xml.contains("&amp;name=\\&quot;quoted\\&quot;"));
        assert!(!xml.contains(" & "));
        let encoded = utf16le_document(&xml);
        assert_eq!(&encoded[..2], &[0xff, 0xfe]);
        let decoded = String::from_utf16(
            &encoded[2..]
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect::<Vec<_>>(),
        )
        .unwrap();
        assert_eq!(decoded, xml);
    }

    #[test]
    fn windows_quoting_handles_spaces_quotes_and_trailing_backslashes() {
        assert_eq!(quote_windows_argument("plain"), "plain");
        assert_eq!(quote_windows_argument(""), "\"\"");
        assert_eq!(quote_windows_argument("two words"), "\"two words\"");
        assert_eq!(
            quote_windows_argument(r#"C:\Program Files\say "hello"\"#),
            r#""C:\Program Files\say \"hello\"\\""#
        );
    }

    #[test]
    fn task_and_run_names_are_stable_and_distinct_by_instance() {
        let first = Path::new("/spawn/account-one");
        let second = Path::new("/spawn/account-two");
        assert!(task_name(first).starts_with("SPAWN D spawnd-"));
        assert_ne!(task_name(first), task_name(second));
        assert_eq!(
            task_name(first),
            super::super::windows_run::value_name(first)
        );
    }
}
