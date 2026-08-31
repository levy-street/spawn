//! Small atomic heartbeat used by local CLI health commands.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LastError {
    pub kind: String,
    pub detail: String,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StateFile {
    pub pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_started_100ns: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_breakaway_denied: Option<bool>,
    pub version: String,
    pub connected: bool,
    pub connected_at: Option<String>,
    pub server: String,
    pub last_error: Option<LastError>,
    pub sessions: usize,
}

pub struct StateStore {
    path: PathBuf,
    state: Mutex<StateFile>,
}

static ACTIVE_STATE: OnceLock<Arc<StateStore>> = OnceLock::new();

pub fn install_active(store: Arc<StateStore>) {
    let _ = ACTIVE_STATE.set(store);
}

pub fn active_connected(sessions: usize) {
    if let Some(store) = ACTIVE_STATE.get() {
        store.connected(sessions);
    }
}

pub fn active_disconnected(kind: &str, detail: &str, sessions: usize) {
    if let Some(store) = ACTIVE_STATE.get() {
        store.disconnected(kind, detail, sessions);
    }
}

pub fn active_heartbeat(sessions: usize) {
    if let Some(store) = ACTIVE_STATE.get() {
        store.heartbeat(sessions);
    }
}

pub fn connection_error_class(class: &str) -> (&'static str, &'static str) {
    match class {
        "dns" => ("dns", "dns"),
        "tcp" => ("tcp", "tcp"),
        "timeout" => ("tcp", "timeout"),
        "tls" => ("tls", "tls"),
        "unauthorized" => ("auth", "token_invalid"),
        "protocol_required" => ("protocol", "protocol_required"),
        _ => ("http", "websocket_handshake"),
    }
}

impl StateStore {
    #[allow(dead_code)]
    pub fn new(config_dir: &Path, server: &str) -> Self {
        Self::new_with_breakaway(config_dir, server, None)
    }

    pub fn new_with_breakaway(
        config_dir: &Path,
        server: &str,
        task_breakaway_denied: Option<bool>,
    ) -> Self {
        Self {
            path: state_path(config_dir),
            state: Mutex::new(StateFile {
                pid: std::process::id(),
                process_started_100ns: current_process_started_100ns(),
                task_breakaway_denied,
                version: crate::version::build_version(),
                connected: false,
                connected_at: None,
                server: server.to_owned(),
                last_error: None,
                sessions: 0,
            }),
        }
    }

    pub fn connected(&self, sessions: usize) {
        let mut state = self.state.lock().expect("state heartbeat lock");
        state.connected = true;
        state.connected_at = Some(now_rfc3339());
        state.last_error = None;
        state.sessions = sessions;
        if let Err(error) = write_atomic(&self.path, &state) {
            tracing::warn!(%error, "could not write SPAWN D heartbeat state");
        }
    }

    pub fn disconnected(&self, kind: &str, detail: &str, sessions: usize) {
        let mut state = self.state.lock().expect("state heartbeat lock");
        state.connected = false;
        state.connected_at = None;
        state.last_error = Some(LastError {
            kind: kind.to_owned(),
            detail: detail.to_owned(),
            at: now_rfc3339(),
        });
        state.sessions = sessions;
        if let Err(error) = write_atomic(&self.path, &state) {
            tracing::warn!(%error, "could not write SPAWN D heartbeat state");
        }
    }

    pub fn heartbeat(&self, sessions: usize) {
        let mut state = self.state.lock().expect("state heartbeat lock");
        state.sessions = sessions;
        if let Err(error) = write_atomic(&self.path, &state) {
            tracing::warn!(%error, "could not write SPAWN D heartbeat state");
        }
    }
}

pub fn state_path(config_dir: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        crate::service::instance_state_path(config_dir)
            .expect("Windows local application data directory must resolve")
            .join("state.json")
    }
    #[cfg(not(windows))]
    {
        config_dir.join("state.json")
    }
}

pub fn read(config_dir: &Path) -> Result<Option<StateFile>> {
    let path = state_path(config_dir);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("reading {}", path.display())),
    };
    if bytes.len() > 16 * 1024 {
        anyhow::bail!("heartbeat state is oversized")
    }
    serde_json::from_slice(&bytes)
        .with_context(|| format!("decoding {}", path.display()))
        .map(Some)
}

const ICE_SERVER_CACHE: &str = "ice-server-urls.json";

/// Remember only the non-secret URLs from the latest server-provided ICE
/// configuration. TURN usernames and credentials are deliberately never put
/// on disk; doctor needs listener reachability, not admission secrets.
pub fn remember_ice_server_urls(
    config_dir: &Path,
    urls: impl IntoIterator<Item = String>,
) -> Result<()> {
    let mut urls = urls
        .into_iter()
        .filter(|url| url.len() <= 2_048)
        .filter(|url| {
            let lower = url.to_ascii_lowercase();
            ["stun:", "stuns:", "turn:", "turns:"]
                .iter()
                .any(|prefix| lower.starts_with(prefix))
        })
        .take(32)
        .collect::<Vec<_>>();
    urls.sort();
    urls.dedup();
    if urls.is_empty() || read_ice_server_urls(config_dir).is_ok_and(|current| current == urls) {
        return Ok(());
    }
    crate::platform::create_private_dir_all(config_dir)?;
    let path = config_dir.join(ICE_SERVER_CACHE);
    let temporary = config_dir.join(format!(
        ".{ICE_SERVER_CACHE}.tmp.{}.{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let result = (|| -> Result<()> {
        let mut file = crate::platform::create_private_file_new(&temporary)?;
        file.write_all(&serde_json::to_vec(&urls)?)?;
        file.sync_all()?;
        crate::platform::durable_replace(&temporary, &path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

pub fn read_ice_server_urls(config_dir: &Path) -> Result<Vec<String>> {
    let path = config_dir.join(ICE_SERVER_CACHE);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error).with_context(|| format!("reading {}", path.display())),
    };
    if bytes.len() > 64 * 1024 {
        anyhow::bail!("ICE server URL cache is oversized")
    }
    serde_json::from_slice(&bytes).with_context(|| format!("decoding {}", path.display()))
}

pub fn heartbeat_is_fresh(config_dir: &Path, max_age: std::time::Duration) -> bool {
    fs::metadata(state_path(config_dir))
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age < max_age)
}

fn write_atomic(path: &Path, state: &StateFile) -> Result<()> {
    let parent = path.parent().context("state path has no parent")?;
    fs::create_dir_all(parent)?;
    let temporary = path.with_file_name(format!("state.json.tmp.{}", std::process::id()));
    let result = (|| -> Result<()> {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary)?;
        let bytes = serde_json::to_vec(state)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        crate::platform::durable_replace(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

pub fn pid_is_alive(pid: u32) -> bool {
    crate::platform::process_alive(pid)
}

/// Stronger Windows daemon check used by status and doctor: the process is
/// live, is the expected running `spawnd.exe`, and (when recorded) has the
/// same creation time so a recycled PID cannot satisfy the heartbeat.
pub fn pid_matches_current_daemon(pid: u32, expected_started_100ns: Option<u64>) -> bool {
    #[cfg(windows)]
    {
        let Some(process) = open_live_process(pid) else {
            return false;
        };
        if expected_started_100ns
            .is_some_and(|expected| process_started_100ns(process.0) != Some(expected))
        {
            return false;
        }
        let Some(actual) = process_image_path(process.0) else {
            return false;
        };
        let Ok(expected) = std::env::current_exe() else {
            return false;
        };
        same_windows_path(&actual, &expected)
    }
    #[cfg(not(windows))]
    {
        let _ = expected_started_100ns;
        pid_is_alive(pid)
    }
}

pub fn daemon_state_is_live(state: &StateFile) -> bool {
    pid_matches_current_daemon(state.pid, state.process_started_100ns)
}

#[cfg(windows)]
struct OwnedProcess(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Drop for OwnedProcess {
    fn drop(&mut self) {
        // SAFETY: this wrapper uniquely owns the OpenProcess handle.
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

#[cfg(windows)]
fn open_live_process(pid: u32) -> Option<OwnedProcess> {
    use windows_sys::Win32::Foundation::{STILL_ACTIVE, WAIT_TIMEOUT};
    use windows_sys::Win32::Storage::FileSystem::SYNCHRONIZE;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    // SAFETY: OpenProcess returns an owned handle or null. No PID-directed
    // action occurs; this handle is used only for identity and liveness.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        return None;
    }
    let process = OwnedProcess(handle);
    // SAFETY: process owns a valid process handle used for a nonblocking wait.
    if unsafe { WaitForSingleObject(process.0, 0) } != WAIT_TIMEOUT {
        return None;
    }
    let mut exit_code = 0_u32;
    // SAFETY: process owns a valid process handle and exit_code is writable.
    if unsafe { GetExitCodeProcess(process.0, &mut exit_code) } == 0
        || exit_code != STILL_ACTIVE as u32
    {
        return None;
    }
    Some(process)
}

#[cfg(windows)]
fn process_started_100ns(handle: windows_sys::Win32::Foundation::HANDLE) -> Option<u64> {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::GetProcessTimes;

    let mut created = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut exited = created;
    let mut kernel = created;
    let mut user = created;
    // SAFETY: all FILETIME output slots are live for this call.
    if unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) } == 0 {
        return None;
    }
    Some((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
}

#[cfg(windows)]
fn current_process_started_100ns() -> Option<u64> {
    // SAFETY: GetCurrentProcess returns a process-lifetime pseudo-handle which
    // must not be closed.
    process_started_100ns(unsafe { windows_sys::Win32::System::Threading::GetCurrentProcess() })
}

#[cfg(not(windows))]
fn current_process_started_100ns() -> Option<u64> {
    None
}

#[cfg(windows)]
fn process_image_path(handle: windows_sys::Win32::Foundation::HANDLE) -> Option<PathBuf> {
    use windows_sys::Win32::System::Threading::QueryFullProcessImageNameW;

    let mut buffer = vec![0_u16; 32_768];
    let mut length = buffer.len() as u32;
    // SAFETY: buffer and length describe writable storage; handle is live.
    if unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut length) } == 0 {
        return None;
    }
    buffer.truncate(length as usize);
    Some(PathBuf::from(String::from_utf16(&buffer).ok()?))
}

#[cfg(windows)]
fn same_windows_path(left: &Path, right: &Path) -> bool {
    fn normalized(path: &Path) -> String {
        std::fs::canonicalize(path)
            .unwrap_or_else(|_| path.to_path_buf())
            .display()
            .to_string()
            .trim_start_matches(r"\\?\")
            .replace('/', "\\")
            .to_lowercase()
    }
    normalized(left) == normalized(right)
}

pub fn now_rfc3339() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    unix_seconds_rfc3339(seconds)
}

pub fn parse_rfc3339_seconds(value: &str) -> Option<i64> {
    if value.len() != 20 || !value.ends_with('Z') {
        return None;
    }
    let year = value.get(0..4)?.parse().ok()?;
    let month = value.get(5..7)?.parse().ok()?;
    let day = value.get(8..10)?.parse().ok()?;
    let hour = value.get(11..13)?.parse().ok()?;
    let minute = value.get(14..16)?.parse().ok()?;
    let second = value.get(17..19)?.parse().ok()?;
    if value.as_bytes().get(4) != Some(&b'-')
        || value.as_bytes().get(7) != Some(&b'-')
        || value.as_bytes().get(10) != Some(&b'T')
        || value.as_bytes().get(13) != Some(&b':')
        || value.as_bytes().get(16) != Some(&b':')
    {
        return None;
    }
    utc_fields_to_unix_seconds(year, month, day, hour, minute, second)
}

pub(crate) fn utc_fields_to_unix_seconds(
    year: i64,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
) -> Option<i64> {
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let adjusted_year = year - i64::from(month <= 2);
    let era = if adjusted_year >= 0 {
        adjusted_year
    } else {
        adjusted_year - 399
    } / 400;
    let year_of_era = adjusted_year - era * 400;
    let shifted_month = i64::from(month) + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some(
        days * 86_400
            + i64::from(hour) * 3_600
            + i64::from(minute) * 60
            + i64::from(second.min(59)),
    )
}

// UTC civil-date conversion adapted from Howard Hinnant's public-domain
// civil_from_days algorithm; avoids adding a clock/date dependency to spawnd.
fn unix_seconds_rfc3339(seconds: u64) -> String {
    let days = (seconds / 86_400) as i64;
    let day_seconds = seconds % 86_400;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    let hour = day_seconds / 3_600;
    let minute = (day_seconds % 3_600) / 60;
    let second = day_seconds % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_json_has_the_stable_contract_shape_and_writes_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let store = StateStore::new(dir.path(), "https://spawnd.dev/");
        store.disconnected("auth", "token_revoked", 2);
        let state = read(dir.path()).unwrap().unwrap();
        let value = serde_json::to_value(&state).unwrap();
        assert_eq!(value["pid"], std::process::id());
        assert_eq!(value["connected"], false);
        assert_eq!(value["last_error"]["kind"], "auth");
        assert_eq!(value["sessions"], 2);
        assert!(value["last_error"]["at"].as_str().unwrap().ends_with('Z'));
        assert!(!dir
            .path()
            .join(format!("state.json.tmp.{}", std::process::id()))
            .exists());
    }

    #[test]
    fn unix_epoch_formats_as_rfc3339() {
        assert_eq!(unix_seconds_rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(unix_seconds_rfc3339(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(parse_rfc3339_seconds("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_rfc3339_seconds("2000-02-29T00:00:00Z"),
            Some(951_782_400)
        );
    }

    #[test]
    fn old_state_json_without_windows_identity_fields_stays_readable() {
        let state: StateFile = serde_json::from_str(
            r#"{"pid":7,"version":"0.1.0","connected":false,"connected_at":null,"server":"https://spawnd.dev","last_error":null,"sessions":0}"#,
        )
        .unwrap();
        assert_eq!(state.process_started_100ns, None);
        assert_eq!(state.task_breakaway_denied, None);
        let value = serde_json::to_value(state).unwrap();
        assert!(value.get("process_started_100ns").is_none());
        assert!(value.get("task_breakaway_denied").is_none());
    }
}
