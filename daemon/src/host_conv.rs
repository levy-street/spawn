//! `conv.inspect`: the agent conversation a window is actually in.
//!
//! The server's `agent_session_id` is the id SPAWN D handed the agent at
//! launch, and Claude Code moves on from it: `/clear` and `/branch` start
//! another conversation, `/resume` adopts one, and agent view (← on an empty
//! prompt) forks the window's conversation into a background job. A restart
//! that trusts the recorded id resumes a thread the window has already left.
//! The live answer is on this host: the processes under the window's shell,
//! and Claude Code's own registry of running sessions, one
//! `<config>/sessions/<pid>.json` per process (spike S1, Claude Code 2.1.288):
//!
//! * a record names the process's `sessionId`, `status` (busy, shell, idle,
//!   waiting), `version`, and the `procStart` that tells that process from a
//!   later one given the same pid. A clean exit and the worker's stop (the
//!   shell's group is killed, Claude takes the hangup and exits 129 within
//!   ~50 ms) both remove it; a SIGKILL leaves it behind, so a record is only
//!   believed while that exact process is alive.
//! * a window in agent view keeps its own record, now with a stale `sessionId`
//!   and a `parkedJobId` naming the background job that holds the
//!   conversation. Background jobs run under Claude's own supervisor in
//!   sessions of their own, and outlive the window.
//! * `claude attach` (and `--resume` of a running background session, which
//!   becomes one) writes no record; Claude notes the client's pid in
//!   `daemon/attach-journal/` while it is attached.
//!
//! "Elsewhere" means a holder the window's stop will not stop: anything that
//! is not one of the window's own processes — a descendant of its shell in
//! the shell's terminal session.
//!
//! Codex keeps no registry and cannot be launched under an id. Its threads
//! are told apart by what the process holds open (Codex 0.155.1):
//!
//! * a writer lock per thread it has loaded,
//!   `<CODEX_HOME>/thread-writer-locks/<id>.lock`, from the moment the
//!   thread starts, before anything is written to it;
//! * the thread's rollout, `…/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`,
//!   from its first message, or at once when it is resumed.
//!
//! Neither is let go when the person moves on. `/new` and `/resume` start or
//! load another thread and keep the last one, and a subagent's thread has
//! its own. So a long-lived Codex holds several. The one in front of the
//! person is the primary thread written last: starting or resuming a thread
//! writes its lock, and resuming or messaging it writes its rollout. A
//! subagent's thread is never that thread, and its rollout's first line
//! (`session_meta`) says so.
//!
//! A Codex window's thread is also remembered on this host,
//! `<window homes>/<session id>/conversation.json`. It is noted from every
//! answer and from a look every `WATCH_INTERVAL` at each window whose
//! foreground may be Codex. Then a restart after Codex has gone — it quit,
//! crashed, or the host restarted — still names the thread. A guess at "the
//! latest one in this folder" would pick whichever of the folder's windows
//! wrote last.
//!
//! Read-only and inert toward everything but that note. Nothing is executed,
//! and no process's arguments or environment are read. Every registry file
//! and rollout is hostile input: a bounded, no-follow, non-blocking read of a
//! regular file, parsed field by field with each value checked before it is
//! believed. The answer names an agent, a conversation id, a state and a
//! version — no paths, no content — and is a few hundred bytes.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use serde_json::{Map, Value};
use uuid::Uuid;

/// The family capability `spawn.host.ctl` advertises for `conv.*`.
pub(crate) const CAPABILITY: &str = "conv.v1";
/// Read-only: which conversation a window is in, and whether it is held
/// anywhere the window's restart would not reach.
pub(crate) const INSPECT_OP: &str = "conv.inspect";
/// Where a window's process tree can be walked. Elsewhere the family is
/// neither advertised nor answered, so a client keeps its old behaviour.
pub(crate) const SUPPORTED: bool = cfg!(any(target_os = "linux", target_os = "macos"));

/// Processes of one window considered, shell included.
#[cfg(any(target_os = "linux", target_os = "macos"))]
const MAX_WINDOW_PROCESSES: usize = 1024;
/// Directory entries read from one registry folder.
const MAX_REGISTRY_ENTRIES: usize = 512;
/// Claude caps its own reads at 256 KiB; its records are about 1 KiB.
const MAX_RECORD_BYTES: u64 = 64 * 1024;
/// Attach-journal entries read from one store.
const MAX_JOURNAL_ENTRIES: usize = 64;
const MAX_JOURNAL_BYTES: u64 = 16 * 1024;
/// Threads of one Codex process considered.
const MAX_CODEX_THREADS: usize = 64;
/// Rollouts whose first line is read to tell a subagent's thread from the
/// person's, newest first.
const MAX_SESSION_META_READS: usize = 16;
/// A rollout's first line, `session_meta`, carries Codex's base
/// instructions: about 22 KiB in 0.155.1.
const MAX_SESSION_META_BYTES: u64 = 256 * 1024;
/// A window's remembered thread: one small JSON object.
const MAX_MEMORY_BYTES: u64 = 1024;
const MEMORY_FILE: &str = "conversation.json";
/// How often each window whose foreground may be Codex is looked at, so its
/// remembered thread follows `/new` and `/resume`.
pub(crate) const WATCH_INTERVAL: Duration = Duration::from_secs(30);

/// Resolves a window's shell from the daemon's session registry, and nothing
/// else: the only part of that registry `spawn.host.ctl` can reach. Only a
/// channel admitted through an authenticated device pair is given one.
#[derive(Clone)]
pub(crate) struct WindowShells {
    resolve: Arc<dyn Fn(Uuid) -> Option<u32> + Send + Sync>,
}

impl WindowShells {
    pub(crate) fn new(resolve: impl Fn(Uuid) -> Option<u32> + Send + Sync + 'static) -> Self {
        Self {
            resolve: Arc::new(resolve),
        }
    }

    pub(crate) fn shell_pid(&self, session_id: Uuid) -> Option<u32> {
        (self.resolve)(session_id).filter(|pid| *pid > 1)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ConversationState {
    /// Working on a turn (Claude's `busy`, or `shell` for a `!` command).
    Running,
    /// Waiting on the person: a permission prompt or a question.
    Blocked,
    /// At its prompt.
    Idle,
    Unknown,
}

/// What the answer rests on, weakest last.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Source {
    /// Claude's record for one of the window's own processes.
    Registry,
    /// The window's Claude parked its conversation in a background job.
    Parked,
    /// The window holds a Claude attach client; the conversation is held by
    /// a background session elsewhere.
    Attach,
    /// The threads a Codex process holds open: its writer locks and
    /// rollouts.
    OpenFile,
    /// An agent's executable, and nothing more to go on.
    Process,
    /// No agent runs in the window, or the window does not run here: the
    /// Codex thread this host last saw it in.
    Remembered,
    /// No agent in the window.
    None,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct Inspection {
    /// The agent kind, as agent definitions spell it.
    pub agent: Option<&'static str>,
    pub conversation_id: Option<String>,
    pub state: ConversationState,
    pub cli_version: Option<String>,
    /// Another process outside this window — a background session, an
    /// attach target, another window — holds the conversation.
    pub live_elsewhere: bool,
    /// The window's agent is in a conversation with nothing written to it
    /// yet: there is nothing to resume, and a restart starts a new one. Its
    /// id is not named, so a client that does not know this field never
    /// types a resume of it. False wherever the host cannot tell.
    pub fresh: bool,
    pub source: Source,
}

impl Inspection {
    fn nothing() -> Self {
        Self {
            agent: None,
            conversation_id: None,
            state: ConversationState::Unknown,
            cli_version: None,
            live_elsewhere: false,
            fresh: false,
            source: Source::None,
        }
    }

    /// A Codex window, as far as `thread` tells.
    fn codex(thread: CodexThread) -> Self {
        let (conversation_id, fresh, source) = match thread {
            CodexThread::Started(id) => (Some(id), false, Source::OpenFile),
            CodexThread::Fresh => (None, true, Source::OpenFile),
            CodexThread::Unknown => (None, false, Source::Process),
        };
        Self {
            agent: Some(CODEX),
            conversation_id,
            state: ConversationState::Unknown,
            cli_version: None,
            live_elsewhere: false,
            fresh,
            source,
        }
    }

    /// The Codex thread a live answer names, the one worth remembering.
    fn codex_thread(&self) -> Option<&str> {
        (self.agent == Some(CODEX))
            .then_some(self.conversation_id.as_deref())
            .flatten()
    }
}

/// One process of a window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Process {
    pub pid: u32,
    /// What ties the process to the window's terminal: its session id on
    /// Linux, its controlling terminal on macOS. `None` for neither.
    pub terminal: Option<u64>,
}

/// The process facts inspection needs, behind a seam so tests can stand up
/// a fake tree.
pub(crate) trait ProcessTable {
    /// `root` and every process under it, breadth first (nearest the shell
    /// first), at most `MAX_WINDOW_PROCESSES`. Empty when `root` is gone.
    fn tree(&self, root: u32) -> Vec<Process>;
    fn alive(&self, pid: u32) -> bool;
    /// The value Claude records as `procStart`, where this platform can
    /// compute it the way Claude does.
    fn start_identity(&self, pid: u32) -> Option<String>;
    fn executable(&self, pid: u32) -> Option<PathBuf>;
    /// Files the process holds open; empty where that cannot be read cheaply.
    fn open_files(&self, pid: u32) -> Vec<PathBuf>;
    /// Claude's `pidDomain` for this host, when pids are only comparable
    /// inside one (Linux).
    fn pid_domain(&self) -> Option<String>;
}

/// The window behind `shell_pid`, inspected on this host.
pub(crate) fn inspect_window(shell_pid: u32) -> Inspection {
    inspect(shell_pid, &SystemProcesses, &claude_stores())
}

/// Claude Code's configuration folders this daemon can name: the one
/// `CLAUDE_CONFIG_DIR` points the daemon at, and the default `~/.claude`. A
/// window whose shell exports another is found by its executable alone.
fn claude_stores() -> Vec<PathBuf> {
    let mut stores = Vec::new();
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from) {
        if dir.is_absolute() {
            stores.push(dir);
        }
    }
    if let Some(home) = dirs::home_dir() {
        let default = home.join(".claude");
        if !stores.contains(&default) {
            stores.push(default);
        }
    }
    stores
}

pub(crate) fn inspect(shell_pid: u32, table: &dyn ProcessTable, stores: &[PathBuf]) -> Inspection {
    let tree = table.tree(shell_pid);
    let Some(shell) = tree.first().copied() else {
        return Inspection::nothing();
    };
    // The window's own processes: those its stop takes down. A descendant
    // that left the shell's terminal session (Claude's background supervisor,
    // started by a window in agent view) outlives it.
    let window: Vec<u32> = tree
        .iter()
        .filter(|process| process.terminal.is_some() && process.terminal == shell.terminal)
        .map(|process| process.pid)
        .collect();
    let in_window: HashSet<u32> = window.iter().copied().collect();
    let domain = table.pid_domain();
    let records: Vec<SessionRecord> = stores
        .iter()
        .flat_map(|store| read_records(store))
        .filter(|record| record_is_live(record, table, domain.as_deref()))
        .collect();
    let by_pid: HashMap<u32, &SessionRecord> =
        records.iter().map(|record| (record.pid, record)).collect();
    let attached: HashSet<u32> = stores
        .iter()
        .flat_map(|store| read_journal(store))
        .filter(|entry| journal_is_live(entry, table))
        .map(|entry| entry.pid)
        .collect();

    // Nearest the shell first: the agent the person is talking to, not a
    // helper it started.
    for &pid in &window {
        if let Some(record) = by_pid.get(&pid) {
            return from_record(record, &records, &in_window);
        }
        if attached.contains(&pid) {
            return Inspection {
                agent: Some(CLAUDE_CODE),
                conversation_id: None,
                state: ConversationState::Unknown,
                cli_version: None,
                live_elsewhere: true,
                fresh: false,
                source: Source::Attach,
            };
        }
        let Some(executable) = table.executable(pid) else {
            continue;
        };
        if is_codex(&executable) {
            return Inspection::codex(codex_thread(&table.open_files(pid)));
        }
        if is_claude(&executable) {
            return Inspection {
                agent: Some(CLAUDE_CODE),
                conversation_id: None,
                state: ConversationState::Unknown,
                cli_version: None,
                live_elsewhere: false,
                fresh: false,
                source: Source::Process,
            };
        }
    }
    Inspection::nothing()
}

const CLAUDE_CODE: &str = "claude-code";
const CODEX: &str = "codex";

fn from_record(
    own: &SessionRecord,
    records: &[SessionRecord],
    in_window: &HashSet<u32>,
) -> Inspection {
    match &own.parked {
        Parked::No => Inspection {
            agent: Some(CLAUDE_CODE),
            conversation_id: Some(own.conversation_id.clone()),
            state: own.state,
            cli_version: own.version.clone(),
            // A parked record's `sessionId` is the conversation that window
            // left, not one it holds: its background job holds the fork.
            live_elsewhere: records.iter().any(|other| {
                other.pid != own.pid
                    && other.parked == Parked::No
                    && !in_window.contains(&other.pid)
                    && other.conversation_id == own.conversation_id
            }),
            fresh: false,
            source: Source::Registry,
        },
        // The record's own `sessionId` is the conversation the window left
        // when it parked; the one it shows now is the background job's.
        Parked::Job(job) => {
            let holder = records
                .iter()
                .find(|other| other.job_id.as_deref() == Some(job.as_str()));
            Inspection {
                agent: Some(CLAUDE_CODE),
                conversation_id: holder.map(|holder| holder.conversation_id.clone()),
                state: holder.map_or(ConversationState::Unknown, |holder| holder.state),
                cli_version: holder
                    .and_then(|holder| holder.version.clone())
                    .or_else(|| own.version.clone()),
                live_elsewhere: holder.is_some_and(|holder| !in_window.contains(&holder.pid)),
                fresh: false,
                source: Source::Parked,
            }
        }
        Parked::Unreadable => Inspection {
            agent: Some(CLAUDE_CODE),
            conversation_id: None,
            state: ConversationState::Unknown,
            cli_version: own.version.clone(),
            live_elsewhere: false,
            fresh: false,
            source: Source::Parked,
        },
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Parked {
    No,
    Job(String),
    /// Parked, under a job name this daemon does not believe.
    Unreadable,
}

/// The fields of one `sessions/<pid>.json` this module believes, checked.
#[derive(Clone, Debug, PartialEq, Eq)]
struct SessionRecord {
    pid: u32,
    conversation_id: String,
    state: ConversationState,
    version: Option<String>,
    job_id: Option<String>,
    parked: Parked,
    proc_start: Option<String>,
    pid_domain: Option<String>,
}

fn read_records(store: &Path) -> Vec<SessionRecord> {
    let Ok(entries) = std::fs::read_dir(store.join("sessions")) else {
        return Vec::new();
    };
    entries
        .take(MAX_REGISTRY_ENTRIES)
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let pid = record_file_pid(entry.file_name().to_str()?)?;
            let bytes = read_small_file(&entry.path(), MAX_RECORD_BYTES)?;
            parse_record(pid, &bytes)
        })
        .collect()
}

/// `<pid>.json`, the pid written canonically, as Claude's own reader wants.
fn record_file_pid(name: &str) -> Option<u32> {
    let digits = name.strip_suffix(".json")?;
    canonical_pid(digits)
}

fn canonical_pid(digits: &str) -> Option<u32> {
    if digits.is_empty() || digits.len() > 10 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let pid = digits.parse::<u32>().ok()?;
    (pid > 1 && pid.to_string() == digits).then_some(pid)
}

fn parse_record(file_pid: u32, bytes: &[u8]) -> Option<SessionRecord> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let object = value.as_object()?;
    if let Some(pid) = object.get("pid") {
        if pid.as_u64() != Some(u64::from(file_pid)) {
            return None;
        }
    }
    let conversation_id = canonical_uuid(object.get("sessionId")?.as_str()?)?;
    let parked = match object.get("parkedJobId") {
        None | Some(Value::Null) => Parked::No,
        Some(value) => value
            .as_str()
            .filter(|job| valid_job_id(job))
            .map_or(Parked::Unreadable, |job| Parked::Job(job.to_string())),
    };
    Some(SessionRecord {
        pid: file_pid,
        conversation_id,
        state: object
            .get("status")
            .and_then(Value::as_str)
            .map_or(ConversationState::Unknown, claude_state),
        version: text_field(object, "version", 32)
            .filter(|version| valid_version(version))
            .map(str::to_string),
        job_id: text_field(object, "jobId", 64)
            .filter(|job| valid_job_id(job))
            .map(str::to_string),
        parked,
        proc_start: text_field(object, "procStart", 64).map(str::to_string),
        pid_domain: text_field(object, "pidDomain", 256).map(str::to_string),
    })
}

/// Claude's agent view reads `busy` and `shell` as working and `waiting` as
/// blocked; anything else is idle there, unknown here.
fn claude_state(status: &str) -> ConversationState {
    match status {
        "busy" | "shell" => ConversationState::Running,
        "waiting" => ConversationState::Blocked,
        "idle" => ConversationState::Idle,
        _ => ConversationState::Unknown,
    }
}

fn text_field<'a>(object: &'a Map<String, Value>, key: &str, max: usize) -> Option<&'a str> {
    object
        .get(key)?
        .as_str()
        .filter(|text| !text.is_empty() && text.len() <= max)
        .filter(|text| {
            text.bytes()
                .all(|byte| byte.is_ascii_graphic() || byte == b' ')
        })
}

/// Claude's conversation ids are UUIDs, lower-case and hyphenated.
fn canonical_uuid(text: &str) -> Option<String> {
    let id = Uuid::parse_str(text).ok()?;
    let canonical = id.hyphenated().to_string();
    (canonical == text).then_some(canonical)
}

fn valid_job_id(job: &str) -> bool {
    !job.is_empty()
        && job.len() <= 64
        && job
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn valid_version(version: &str) -> bool {
    version.bytes().any(|byte| byte.is_ascii_digit())
        && version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
}

/// A record speaks for its pid only while that same process runs: alive, in
/// this pid namespace, and started when the record says it was. Where the
/// start cannot be compared the way Claude wrote it, the process must at
/// least be Claude.
fn record_is_live(record: &SessionRecord, table: &dyn ProcessTable, domain: Option<&str>) -> bool {
    if let (Some(ours), Some(theirs)) = (domain, record.pid_domain.as_deref()) {
        if ours != theirs {
            return false;
        }
    }
    same_process(record.pid, record.proc_start.as_deref(), table)
}

fn same_process(pid: u32, recorded_start: Option<&str>, table: &dyn ProcessTable) -> bool {
    if !table.alive(pid) {
        return false;
    }
    match (recorded_start, table.start_identity(pid)) {
        (Some(recorded), Some(actual)) => recorded == actual,
        _ => table.executable(pid).is_some_and(|path| is_claude(&path)),
    }
}

/// One `daemon/attach-journal/*.json`: a Claude attach client's pid. The
/// file outlives a client that was killed, so it is believed only while
/// that exact process runs.
#[derive(Clone, Debug, PartialEq, Eq)]
struct JournalEntry {
    pid: u32,
    proc_start: Option<String>,
}

fn read_journal(store: &Path) -> Vec<JournalEntry> {
    let Ok(entries) = std::fs::read_dir(store.join("daemon").join("attach-journal")) else {
        return Vec::new();
    };
    entries
        .take(MAX_JOURNAL_ENTRIES)
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.ends_with(".json"))
        })
        .filter_map(|entry| {
            let bytes = read_small_file(&entry.path(), MAX_JOURNAL_BYTES)?;
            let value: Value = serde_json::from_slice(&bytes).ok()?;
            let object = value.as_object()?;
            let pid = u32::try_from(object.get("pid")?.as_u64()?)
                .ok()
                .filter(|pid| *pid > 1)?;
            Some(JournalEntry {
                pid,
                proc_start: text_field(object, "procStart", 64).map(str::to_string),
            })
        })
        .collect()
}

fn journal_is_live(entry: &JournalEntry, table: &dyn ProcessTable) -> bool {
    same_process(entry.pid, entry.proc_start.as_deref(), table)
}

/// A file read as hostile input: a regular file, reached without following
/// a link, opened without blocking (a FIFO planted in the folder cannot
/// stall the channel), and no longer than `cap`.
#[cfg(unix)]
fn read_small_file(path: &Path, cap: u64) -> Option<Vec<u8>> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;

    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > cap {
        return None;
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(cap + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= cap).then_some(bytes)
}

#[cfg(not(unix))]
fn read_small_file(_path: &Path, _cap: u64) -> Option<Vec<u8>> {
    None
}

/// The first line of a file of any length, opened as `read_small_file`
/// opens one and read no further than `cap` bytes; None when no line ends
/// within them.
#[cfg(unix)]
fn read_first_line(path: &Path, cap: u64) -> Option<Vec<u8>> {
    use std::io::{BufRead, BufReader, Read};
    use std::os::unix::fs::OpenOptionsExt;

    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut line = Vec::new();
    BufReader::new(file.take(cap))
        .read_until(b'\n', &mut line)
        .ok()?;
    line.ends_with(b"\n").then(|| {
        line.pop();
        line
    })
}

#[cfg(not(unix))]
fn read_first_line(_path: &Path, _cap: u64) -> Option<Vec<u8>> {
    None
}

/// The executable's own name; Linux appends " (deleted)" to one an update
/// replaced while it ran.
fn executable_name(path: &Path) -> Option<&str> {
    let name = path.file_name()?.to_str()?;
    Some(name.strip_suffix(" (deleted)").unwrap_or(name))
}

/// `claude`, or a native install's version-named release file
/// (`~/.local/share/claude/versions/2.1.288`).
fn is_claude(path: &Path) -> bool {
    let Some(name) = executable_name(path) else {
        return false;
    };
    if name.eq_ignore_ascii_case("claude") || name.eq_ignore_ascii_case("claude.exe") {
        return true;
    }
    let versioned = !name.is_empty() && !name.chars().any(char::is_alphabetic);
    let mut ancestors = path.ancestors().skip(1).filter_map(|dir| dir.file_name());
    versioned
        && ancestors.next().is_some_and(|dir| dir == "versions")
        && ancestors.next().is_some_and(|dir| dir == "claude")
}

/// Codex's native binary, whether started directly or by its npm launcher.
fn is_codex(path: &Path) -> bool {
    executable_name(path).is_some_and(|name| name == "codex" || name == "codex.exe")
}

/// The id at the end of a rollout Codex holds open:
/// `…/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl`.
fn codex_rollout_id(path: &Path) -> Option<String> {
    let name = executable_name(path)?;
    let rest = name.strip_prefix("rollout-")?.strip_suffix(".jsonl")?;
    let id = rest
        .len()
        .checked_sub(36)
        .and_then(|start| rest.get(start..))?;
    rest.len()
        .checked_sub(37)
        .and_then(|dash| rest.as_bytes().get(dash))
        .filter(|byte| **byte == b'-')?;
    canonical_uuid(id)
}

/// The id of a thread whose writer lock Codex holds:
/// `<CODEX_HOME>/thread-writer-locks/<uuid>.lock`.
fn codex_lock_id(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let id = name.strip_suffix(".lock")?;
    let folder = path.parent()?.file_name()?;
    (folder == "thread-writer-locks").then(|| canonical_uuid(id))?
}

/// Which of the threads a Codex process holds is the one in front of the
/// person.
#[derive(Clone, Debug, PartialEq, Eq)]
enum CodexThread {
    /// A thread with a rollout: something to resume.
    Started(String),
    /// A thread with nothing written to it yet: there is nothing to resume.
    Fresh,
    /// Nothing held, or nothing to tell the threads it holds apart.
    Unknown,
}

#[derive(Default)]
struct HeldThread<'a> {
    lock: Option<&'a Path>,
    rollout: Option<&'a Path>,
}

impl HeldThread<'_> {
    /// When the thread was last started, loaded or written: the later of its
    /// lock's and its rollout's modification times.
    fn last_written(&self) -> Option<SystemTime> {
        [self.lock, self.rollout]
            .into_iter()
            .flatten()
            .filter_map(|path| std::fs::symlink_metadata(path).ok()?.modified().ok())
            .max()
    }
}

/// The thread a Codex process is in, from the files it holds open: the
/// primary thread written last (see the module notes). A thread whose newest
/// mark is its lock alone has had nothing written to it.
fn codex_thread(open: &[PathBuf]) -> CodexThread {
    let mut held: BTreeMap<String, HeldThread> = BTreeMap::new();
    for path in open {
        if let Some(id) = codex_rollout_id(path) {
            if held.len() < MAX_CODEX_THREADS || held.contains_key(&id) {
                held.entry(id).or_default().rollout = Some(path);
            }
        } else if let Some(id) = codex_lock_id(path) {
            if held.len() < MAX_CODEX_THREADS || held.contains_key(&id) {
                held.entry(id).or_default().lock = Some(path);
            }
        }
    }
    let mut threads: Vec<(Option<SystemTime>, String, HeldThread)> = held
        .into_iter()
        .map(|(id, thread)| (thread.last_written(), id, thread))
        .collect();
    // Newest first; a thread whose time cannot be read goes last, and ids
    // (time-ordered UUIDs) settle a tie.
    threads.sort_by(|a, b| (b.0, &b.1).cmp(&(a.0, &a.1)));
    let mut reads = 0..MAX_SESSION_META_READS;
    for (_, id, thread) in threads {
        let Some(rollout) = thread.rollout else {
            return CodexThread::Fresh;
        };
        if reads.next().is_none() {
            break;
        }
        if !is_subagent_rollout(rollout) {
            return CodexThread::Started(id);
        }
    }
    CodexThread::Unknown
}

/// Whether a rollout is a subagent's thread, by its first line:
/// `{"type":"session_meta","payload":{…,"source":{"subagent":…},
/// "thread_source":"subagent",…}}`. Unreadable or unrecognised, it is taken
/// for the person's own.
fn is_subagent_rollout(path: &Path) -> bool {
    let Some(line) = read_first_line(path, MAX_SESSION_META_BYTES) else {
        return false;
    };
    let Ok(Value::Object(line)) = serde_json::from_slice::<Value>(&line) else {
        return false;
    };
    if line.get("type").and_then(Value::as_str) != Some("session_meta") {
        return false;
    }
    let Some(meta) = line.get("payload").and_then(Value::as_object) else {
        return false;
    };
    meta.get("thread_source").and_then(Value::as_str) == Some("subagent")
        || meta
            .get("source")
            .and_then(Value::as_object)
            .is_some_and(|source| source.contains_key("subagent"))
}

/// What this host last saw each Codex window in: `<homes>/<session
/// id>/conversation.json`, beside whatever else spawnd keeps for the window
/// (its skills, its own Codex home). Noted from live answers only and never
/// trusted further than a canonical UUID; a note that cannot be written is
/// a restart that falls back to what it did before.
#[derive(Clone, Debug)]
pub(crate) struct ConversationMemory {
    homes: PathBuf,
}

impl ConversationMemory {
    pub(crate) fn new(homes: PathBuf) -> Self {
        Self { homes }
    }

    /// The memory of this daemon instance, in its window homes.
    pub(crate) fn for_this_instance() -> Option<Self> {
        crate::config::window_homes_dir().ok().map(Self::new)
    }

    fn path(&self, session_id: Uuid) -> PathBuf {
        self.homes.join(session_id.to_string()).join(MEMORY_FILE)
    }

    /// Note the Codex thread a live answer names, when it is not the one
    /// already noted.
    pub(crate) fn note(&self, session_id: Uuid, inspection: &Inspection) {
        let Some(thread) = inspection.codex_thread() else {
            return;
        };
        if self.recall_thread(session_id).as_deref() == Some(thread) {
            return;
        }
        let body = serde_json::json!({ "agent": CODEX, "conversation_id": thread });
        if let Err(error) = self.write(session_id, body.to_string().as_bytes()) {
            tracing::debug!(%session_id, %error, "could not note the window's Codex thread");
        }
    }

    /// The answer for a window no agent runs in, from what was noted.
    pub(crate) fn recall(&self, session_id: Uuid) -> Option<Inspection> {
        Some(Inspection {
            agent: Some(CODEX),
            conversation_id: Some(self.recall_thread(session_id)?),
            state: ConversationState::Unknown,
            cli_version: None,
            live_elsewhere: false,
            fresh: false,
            source: Source::Remembered,
        })
    }

    fn recall_thread(&self, session_id: Uuid) -> Option<String> {
        let bytes = read_small_file(&self.path(session_id), MAX_MEMORY_BYTES)?;
        let value: Value = serde_json::from_slice(&bytes).ok()?;
        let object = value.as_object()?;
        if object.get("agent")?.as_str()? != CODEX {
            return None;
        }
        canonical_uuid(object.get("conversation_id")?.as_str()?)
    }

    fn write(&self, session_id: Uuid, bytes: &[u8]) -> std::io::Result<()> {
        use std::io::Write;

        let path = self.path(session_id);
        let folder = path.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
        crate::platform::create_private_dir_all(folder)?;
        let temporary = folder.join(format!("{MEMORY_FILE}.{}.tmp", Uuid::new_v4()));
        let written = (|| {
            let mut file = crate::platform::create_private_file_new(&temporary)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            crate::platform::durable_replace(&temporary, &path)
        })();
        if written.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        written
    }
}

/// A live answer for a window, where one is to be had, falling back on what
/// was noted when no agent runs in it; and the note brought up to date. None
/// for a window that does not run here and was never noted.
pub(crate) fn answer_for_window(
    session_id: Uuid,
    shell_pid: Option<u32>,
    memory: Option<&ConversationMemory>,
) -> Option<Inspection> {
    answer(session_id, shell_pid.map(inspect_window), memory)
}

fn answer(
    session_id: Uuid,
    live: Option<Inspection>,
    memory: Option<&ConversationMemory>,
) -> Option<Inspection> {
    if let (Some(memory), Some(live)) = (memory, live.as_ref()) {
        memory.note(session_id, live);
    }
    match live {
        Some(live) if live.agent.is_some() => Some(live),
        live => memory.and_then(|memory| memory.recall(session_id)).or(live),
    }
}

/// Foreground names a Codex window shows: Codex's own binary, or node for
/// npm's launcher.
fn may_be_codex(foreground: &str) -> bool {
    matches!(foreground, "codex" | "node")
}

/// Keep each Codex window's note current. Every `WATCH_INTERVAL`, `windows`
/// lists this host's windows as (session, shell, foreground); those whose
/// foreground may be Codex are inspected off the runtime and their notes
/// updated. Runs for the life of the daemon.
pub(crate) async fn watch(
    windows: impl Fn() -> Vec<(Uuid, u32, String)> + Send + 'static,
    memory: ConversationMemory,
) {
    let mut interval = tokio::time::interval(WATCH_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        let candidates: Vec<(Uuid, u32)> = windows()
            .into_iter()
            .filter(|(_, _, foreground)| may_be_codex(foreground))
            .map(|(session_id, shell, _)| (session_id, shell))
            .collect();
        if candidates.is_empty() {
            continue;
        }
        let memory = memory.clone();
        let _ = tokio::task::spawn_blocking(move || {
            for (session_id, shell) in candidates {
                memory.note(session_id, &inspect_window(shell));
            }
        })
        .await;
    }
}

/// This host's processes.
struct SystemProcesses;

#[cfg(target_os = "linux")]
mod system {
    use std::collections::VecDeque;
    use std::io::Read;

    use super::*;

    /// `/proc` entries read to find a window's children.
    const MAX_PROC_ENTRIES: usize = 65_536;
    /// Open descriptors looked at to find a Codex rollout.
    const MAX_OPEN_FILES: usize = 1024;

    pub(super) struct Stat {
        pub ppid: u32,
        pub session: u32,
        pub zombie: bool,
        /// Field 22, clock ticks after boot: what Claude records as
        /// `procStart` on Linux.
        pub start: String,
    }

    pub(super) fn stat(pid: u32) -> Option<Stat> {
        let bytes = read_small_file(Path::new(&format!("/proc/{pid}/stat")), 4096)?;
        parse_stat(std::str::from_utf8(&bytes).ok()?)
    }

    /// The fields after the command name, which may itself hold spaces and
    /// parentheses: split after the last `)`.
    pub(super) fn parse_stat(text: &str) -> Option<Stat> {
        let rest = text.get(text.rfind(')')? + 1..)?;
        let fields: Vec<&str> = rest.split_ascii_whitespace().collect();
        let start = (*fields.get(19)?).to_string();
        if start.is_empty() || !start.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        Some(Stat {
            zombie: *fields.first()? == "Z",
            ppid: fields.get(1)?.parse().ok()?,
            session: fields.get(3)?.parse().ok()?,
            start,
        })
    }

    impl ProcessTable for SystemProcesses {
        fn tree(&self, root: u32) -> Vec<Process> {
            let Ok(entries) = std::fs::read_dir("/proc") else {
                return Vec::new();
            };
            let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
            let mut sessions: HashMap<u32, u32> = HashMap::new();
            for entry in entries.take(MAX_PROC_ENTRIES).filter_map(Result::ok) {
                let Some(pid) = entry
                    .file_name()
                    .to_str()
                    .and_then(|name| name.parse::<u32>().ok())
                else {
                    continue;
                };
                let Some(stat) = stat(pid).filter(|stat| !stat.zombie) else {
                    continue;
                };
                children.entry(stat.ppid).or_default().push(pid);
                sessions.insert(pid, stat.session);
            }
            walk(root, &children, &sessions)
        }

        fn alive(&self, pid: u32) -> bool {
            stat(pid).is_some_and(|stat| !stat.zombie)
        }

        fn start_identity(&self, pid: u32) -> Option<String> {
            stat(pid).map(|stat| stat.start)
        }

        fn executable(&self, pid: u32) -> Option<PathBuf> {
            std::fs::read_link(format!("/proc/{pid}/exe")).ok()
        }

        fn open_files(&self, pid: u32) -> Vec<PathBuf> {
            let Ok(entries) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
                return Vec::new();
            };
            entries
                .take(MAX_OPEN_FILES)
                .filter_map(Result::ok)
                .filter_map(|entry| std::fs::read_link(entry.path()).ok())
                .collect()
        }

        /// `linux:<machine-id>:<pid namespace>`, exactly as Claude writes it
        /// (it follows a linked `/etc/machine-id`, so this does too). `None`
        /// when either half cannot be read: a domain this daemon got wrong
        /// would disown every record on the host.
        fn pid_domain(&self) -> Option<String> {
            let mut machine = String::new();
            std::fs::File::open("/etc/machine-id")
                .ok()?
                .take(256)
                .read_to_string(&mut machine)
                .ok()?;
            let machine = machine.trim();
            let namespace = std::fs::read_link("/proc/self/ns/pid").ok()?;
            let namespace = namespace.to_str()?;
            (!machine.is_empty() && !namespace.is_empty())
                .then(|| format!("linux:{machine}:{namespace}"))
        }
    }

    fn walk(
        root: u32,
        children: &HashMap<u32, Vec<u32>>,
        sessions: &HashMap<u32, u32>,
    ) -> Vec<Process> {
        let Some(root_session) = sessions.get(&root) else {
            return Vec::new();
        };
        let mut found = vec![Process {
            pid: root,
            terminal: Some(u64::from(*root_session)),
        }];
        let mut queue = VecDeque::from([root]);
        let mut seen = HashSet::from([root]);
        while let Some(parent) = queue.pop_front() {
            for &child in children.get(&parent).into_iter().flatten() {
                if found.len() >= MAX_WINDOW_PROCESSES {
                    return found;
                }
                if !seen.insert(child) {
                    continue;
                }
                found.push(Process {
                    pid: child,
                    terminal: sessions.get(&child).map(|session| u64::from(*session)),
                });
                queue.push_back(child);
            }
        }
        found
    }
}

#[cfg(target_os = "macos")]
mod system {
    use std::collections::VecDeque;

    use nix::libc;

    use super::*;

    /// `NODEV`: no controlling terminal.
    const NO_TERMINAL: u32 = u32::MAX;
    /// `SZOMB` in `pbi_status`.
    const ZOMBIE: u32 = 5;
    /// Children listed per process.
    const MAX_CHILDREN: usize = 1024;

    fn bsd_info(pid: u32) -> Option<libc::proc_bsdinfo> {
        let pid = libc::c_int::try_from(pid).ok()?;
        // SAFETY: `proc_bsdinfo` is a plain C struct of integers and byte
        // arrays, for which all-zero is a valid value.
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        // SAFETY: `info` is writable for exactly `size` bytes and outlives the
        // synchronous call.
        let written = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                (&mut info as *mut libc::proc_bsdinfo).cast(),
                size,
            )
        };
        (written == size).then_some(info)
    }

    /// Children of `parent`, each confirmed by its own parent pid: the count
    /// `proc_listchildpids` returns is read only as an upper bound.
    fn children(parent: u32) -> Vec<u32> {
        let Ok(parent_pid) = libc::pid_t::try_from(parent) else {
            return Vec::new();
        };
        let mut buffer: Vec<libc::pid_t> = vec![0; MAX_CHILDREN];
        let bytes = (buffer.len() * std::mem::size_of::<libc::pid_t>()) as libc::c_int;
        // SAFETY: `buffer` is writable for `bytes` and outlives the call.
        let listed =
            unsafe { libc::proc_listchildpids(parent_pid, buffer.as_mut_ptr().cast(), bytes) };
        let listed = usize::try_from(listed).unwrap_or(0).min(buffer.len());
        buffer[..listed]
            .iter()
            .filter_map(|pid| u32::try_from(*pid).ok())
            .filter(|pid| *pid > 1)
            .filter(|pid| bsd_info(*pid).is_some_and(|info| info.pbi_ppid == parent))
            .collect()
    }

    fn terminal(info: &libc::proc_bsdinfo) -> Option<u64> {
        (info.e_tdev != NO_TERMINAL).then_some(u64::from(info.e_tdev))
    }

    impl ProcessTable for SystemProcesses {
        fn tree(&self, root: u32) -> Vec<Process> {
            let Some(info) = bsd_info(root).filter(|info| info.pbi_status != ZOMBIE) else {
                return Vec::new();
            };
            let mut found = vec![Process {
                pid: root,
                terminal: terminal(&info),
            }];
            let mut queue = VecDeque::from([root]);
            let mut seen = HashSet::from([root]);
            while let Some(parent) = queue.pop_front() {
                for child in children(parent) {
                    if found.len() >= MAX_WINDOW_PROCESSES {
                        return found;
                    }
                    if !seen.insert(child) {
                        continue;
                    }
                    let Some(info) = bsd_info(child).filter(|info| info.pbi_status != ZOMBIE)
                    else {
                        continue;
                    };
                    found.push(Process {
                        pid: child,
                        terminal: terminal(&info),
                    });
                    queue.push_back(child);
                }
            }
            found
        }

        fn alive(&self, pid: u32) -> bool {
            bsd_info(pid).is_some_and(|info| info.pbi_status != ZOMBIE)
        }

        /// Claude records `ps -o lstart` text here on macOS. It is not
        /// reproduced: liveness falls back to the executable being Claude.
        fn start_identity(&self, _pid: u32) -> Option<String> {
            None
        }

        fn executable(&self, pid: u32) -> Option<PathBuf> {
            let pid = libc::c_int::try_from(pid).ok()?;
            let mut buffer = [0u8; 4096];
            // SAFETY: `buffer` is writable for its length and outlives the call.
            let len =
                unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
            let len = usize::try_from(len).ok().filter(|len| *len > 0)?;
            let path = std::str::from_utf8(buffer.get(..len)?).ok()?;
            Some(PathBuf::from(path))
        }

        /// Each vnode descriptor's path, from libproc: the descriptors
        /// (`PROC_PIDLISTFDS`), then each file one's path
        /// (`PROC_PIDFDVNODEPATHINFO`). Only a process of the same user
        /// answers.
        fn open_files(&self, pid: u32) -> Vec<PathBuf> {
            let Ok(pid) = libc::c_int::try_from(pid) else {
                return Vec::new();
            };
            let empty = libc::proc_fdinfo {
                proc_fd: 0,
                proc_fdtype: 0,
            };
            let mut descriptors = vec![empty; MAX_OPEN_FILES];
            let size = std::mem::size_of::<libc::proc_fdinfo>();
            let Ok(bytes) = libc::c_int::try_from(descriptors.len() * size) else {
                return Vec::new();
            };
            // SAFETY: `descriptors` is writable for `bytes` and outlives the
            // synchronous call.
            let written = unsafe {
                libc::proc_pidinfo(
                    pid,
                    libc::PROC_PIDLISTFDS,
                    0,
                    descriptors.as_mut_ptr().cast(),
                    bytes,
                )
            };
            let listed = usize::try_from(written).unwrap_or(0) / size;
            descriptors
                .iter()
                .take(listed.min(MAX_OPEN_FILES))
                .filter(|descriptor| {
                    u32::try_from(libc::PROX_FDTYPE_VNODE).ok() == Some(descriptor.proc_fdtype)
                })
                .filter_map(|descriptor| vnode_path(pid, descriptor.proc_fd))
                .collect()
        }

        fn pid_domain(&self) -> Option<String> {
            None
        }
    }

    /// Descriptors looked at to find a Codex thread.
    const MAX_OPEN_FILES: usize = 1024;
    /// `PROC_PIDFDVNODEPATHINFO`, from `<sys/proc_info.h>`.
    const PROC_PIDFDVNODEPATHINFO: libc::c_int = 2;

    /// `struct proc_fileinfo`, from `<sys/proc_info.h>`: laid out for the
    /// kernel to fill, never read here.
    #[allow(dead_code)]
    #[repr(C)]
    struct ProcFileInfo {
        fi_openflags: u32,
        fi_status: u32,
        fi_offset: libc::off_t,
        fi_type: i32,
        fi_guardflags: u32,
    }

    /// `struct vnode_fdinfowithpath`, `PROC_PIDFDVNODEPATHINFO_SIZE` bytes.
    #[allow(dead_code)]
    #[repr(C)]
    struct VnodeFdInfoWithPath {
        pfi: ProcFileInfo,
        pvip: libc::vnode_info_path,
    }

    const _: () = assert!(std::mem::size_of::<VnodeFdInfoWithPath>() == 1200);

    fn vnode_path(pid: libc::c_int, fd: i32) -> Option<PathBuf> {
        use std::os::unix::ffi::OsStrExt;

        // SAFETY: both halves are plain C structs of integers and byte
        // arrays, for which all-zero is a valid value.
        let mut info: VnodeFdInfoWithPath = unsafe { std::mem::zeroed() };
        let size = libc::c_int::try_from(std::mem::size_of::<VnodeFdInfoWithPath>()).ok()?;
        // SAFETY: `info` is writable for exactly `size` bytes and outlives
        // the synchronous call.
        let written = unsafe {
            libc::proc_pidfdinfo(
                pid,
                fd,
                PROC_PIDFDVNODEPATHINFO,
                (&mut info as *mut VnodeFdInfoWithPath).cast(),
                size,
            )
        };
        if written != size {
            return None;
        }
        // SAFETY: `vip_path` is `MAXPATHLEN` contiguous bytes inside `info`,
        // which outlives the slice.
        let bytes: &[u8] = unsafe {
            std::slice::from_raw_parts(
                info.pvip.vip_path.as_ptr().cast::<u8>(),
                std::mem::size_of_val(&info.pvip.vip_path),
            )
        };
        let end = bytes.iter().position(|byte| *byte == 0)?;
        (end > 0).then(|| PathBuf::from(std::ffi::OsStr::from_bytes(&bytes[..end])))
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
impl ProcessTable for SystemProcesses {
    fn tree(&self, _root: u32) -> Vec<Process> {
        Vec::new()
    }

    fn alive(&self, _pid: u32) -> bool {
        false
    }

    fn start_identity(&self, _pid: u32) -> Option<String> {
        None
    }

    fn executable(&self, _pid: u32) -> Option<PathBuf> {
        None
    }

    fn open_files(&self, _pid: u32) -> Vec<PathBuf> {
        Vec::new()
    }

    fn pid_domain(&self) -> Option<String> {
        None
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::collections::VecDeque;

    use super::*;

    const SHELL: u32 = 1000;
    const WINDOW_TTY: u64 = 1000;

    /// A fake host: a process tree, the processes that run, and what each
    /// one is.
    #[derive(Default)]
    struct FakeTable {
        /// (pid, parent, terminal session)
        processes: Vec<(u32, u32, Option<u64>)>,
        dead: HashSet<u32>,
        starts: HashMap<u32, String>,
        executables: HashMap<u32, PathBuf>,
        open: HashMap<u32, Vec<PathBuf>>,
        domain: Option<String>,
    }

    impl FakeTable {
        fn window() -> Self {
            let mut table = Self::default();
            table.spawn(SHELL, 1, Some(WINDOW_TTY), "/bin/bash", "10");
            table
        }

        fn spawn(&mut self, pid: u32, parent: u32, terminal: Option<u64>, exe: &str, start: &str) {
            self.processes.push((pid, parent, terminal));
            self.executables.insert(pid, PathBuf::from(exe));
            self.starts.insert(pid, start.to_string());
        }
    }

    impl ProcessTable for FakeTable {
        fn tree(&self, root: u32) -> Vec<Process> {
            let alive = |pid: &u32| !self.dead.contains(pid);
            let Some(&(_, _, terminal)) = self
                .processes
                .iter()
                .find(|(pid, _, _)| *pid == root && alive(pid))
            else {
                return Vec::new();
            };
            let mut found = vec![Process {
                pid: root,
                terminal,
            }];
            let mut queue = VecDeque::from([root]);
            while let Some(parent) = queue.pop_front() {
                for &(pid, _, terminal) in self
                    .processes
                    .iter()
                    .filter(|(pid, ppid, _)| *ppid == parent && alive(pid))
                {
                    found.push(Process { pid, terminal });
                    queue.push_back(pid);
                }
            }
            found
        }

        fn alive(&self, pid: u32) -> bool {
            self.processes.iter().any(|(p, _, _)| *p == pid) && !self.dead.contains(&pid)
        }

        fn start_identity(&self, pid: u32) -> Option<String> {
            self.starts.get(&pid).cloned()
        }

        fn executable(&self, pid: u32) -> Option<PathBuf> {
            self.executables.get(&pid).cloned()
        }

        fn open_files(&self, pid: u32) -> Vec<PathBuf> {
            self.open.get(&pid).cloned().unwrap_or_default()
        }

        fn pid_domain(&self) -> Option<String> {
            self.domain.clone()
        }
    }

    const CLAUDE: &str = "/home/me/.local/share/claude/versions/2.1.288";
    const CONVERSATION: &str = "064c9faa-9990-4b0c-9d35-f06ae2dd0d05";
    const OTHER: &str = "a2efba65-1e1d-4af3-a88b-7a136b350929";

    fn record(pid: u32, session: &str, status: &str, start: &str) -> Value {
        serde_json::json!({
            "pid": pid,
            "sessionId": session,
            "cwd": "/home/me/proj",
            "startedAt": 1791055892235_u64,
            "procStart": start,
            "version": "2.1.288",
            "kind": "interactive",
            "entrypoint": "cli",
            "status": status,
            "updatedAt": 1791055898351_u64,
        })
    }

    fn store_with(records: &[Value]) -> tempfile::TempDir {
        let store = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(store.path().join("sessions")).unwrap();
        for record in records {
            write_record(store.path(), record);
        }
        store
    }

    fn write_record(store: &Path, record: &Value) {
        let pid = record["pid"].as_u64().unwrap();
        std::fs::write(
            store.join("sessions").join(format!("{pid}.json")),
            record.to_string(),
        )
        .unwrap();
        // Claude writes a key file beside each record; it is not a record.
        std::fs::write(
            store.join("sessions").join(format!("{pid}.0123abcd.key")),
            "{}",
        )
        .unwrap();
    }

    fn run(table: &FakeTable, store: &tempfile::TempDir) -> Inspection {
        inspect(SHELL, table, &[store.path().to_path_buf()])
    }

    #[test]
    fn the_window_is_in_the_conversation_its_claude_records() {
        let mut table = FakeTable::window();
        table.spawn(1001, SHELL, Some(WINDOW_TTY), CLAUDE, "77");
        let store = store_with(&[record(1001, CONVERSATION, "busy", "77")]);
        assert_eq!(
            run(&table, &store),
            Inspection {
                agent: Some("claude-code"),
                conversation_id: Some(CONVERSATION.into()),
                state: ConversationState::Running,
                cli_version: Some("2.1.288".into()),
                live_elsewhere: false,
                fresh: false,
                source: Source::Registry,
            }
        );
    }

    #[test]
    fn claude_status_maps_onto_four_states() {
        for (status, state) in [
            ("busy", ConversationState::Running),
            ("shell", ConversationState::Running),
            ("waiting", ConversationState::Blocked),
            ("idle", ConversationState::Idle),
            ("compacting", ConversationState::Unknown),
        ] {
            let mut table = FakeTable::window();
            table.spawn(1001, SHELL, Some(WINDOW_TTY), CLAUDE, "77");
            let store = store_with(&[record(1001, CONVERSATION, status, "77")]);
            assert_eq!(run(&table, &store).state, state, "{status}");
        }
    }

    #[test]
    fn a_record_left_by_a_killed_claude_is_not_believed() {
        // SIGKILL leaves sessions/<pid>.json behind, and the pid can come
        // back as something else entirely.
        let mut table = FakeTable::window();
        table.spawn(1001, SHELL, Some(WINDOW_TTY), "/usr/bin/vim", "90");
        let store = store_with(&[record(1001, CONVERSATION, "idle", "77")]);
        assert_eq!(run(&table, &store).source, Source::None);

        let mut table = FakeTable::window();
        table.spawn(1001, SHELL, Some(WINDOW_TTY), CLAUDE, "77");
        table.dead.insert(1001);
        assert_eq!(run(&table, &store), Inspection::nothing());
    }

    #[test]
    fn a_record_from_another_pid_namespace_is_not_believed() {
        let mut table = FakeTable::window();
        table.domain = Some("linux:abc:pid:[1]".into());
        table.spawn(1001, SHELL, Some(WINDOW_TTY), CLAUDE, "77");
        let mut foreign = record(1001, CONVERSATION, "idle", "77");
        foreign["pidDomain"] = "linux:abc:pid:[2]".into();
        let store = store_with(&[foreign.clone()]);
        assert_eq!(run(&table, &store).source, Source::Process);

        foreign["pidDomain"] = "linux:abc:pid:[1]".into();
        let store = store_with(&[foreign]);
        assert_eq!(run(&table, &store).source, Source::Registry);
    }

    #[test]
    fn without_a_comparable_start_the_process_must_be_claude() {
        let mut table = FakeTable::window();
        table.spawn(1001, SHELL, Some(WINDOW_TTY), CLAUDE, "77");
        table.starts.clear();
        let store = store_with(&[record(
            1001,
            CONVERSATION,
            "idle",
            "Sat Oct  3 10:00:00 2026",
        )]);
        assert_eq!(run(&table, &store).source, Source::Registry);

        table
            .executables
            .insert(1001, PathBuf::from("/usr/bin/python3"));
        assert_eq!(run(&table, &store), Inspection::nothing());
    }

    #[test]
    fn the_same_conversation_held_outside_the_window_is_live_elsewhere() {
        let mut table = FakeTable::window();
        table.spawn(1001, SHELL, Some(WINDOW_TTY), CLAUDE, "77");
        // Another window, its own terminal session.
        table.spawn(2000, 1, Some(2000), "/bin/zsh", "5");
        table.spawn(2001, 2000, Some(2000), CLAUDE, "88");
        let store = store_with(&[
            record(1001, CONVERSATION, "idle", "77"),
            record(2001, CONVERSATION, "busy", "88"),
        ]);
        let inspection = run(&table, &store);
        assert!(inspection.live_elsewhere);
        assert_eq!(inspection.conversation_id.as_deref(), Some(CONVERSATION));

        // A dead holder holds nothing.
        table.dead.insert(2001);
        assert!(!run(&table, &store).live_elsewhere);
    }

    #[test]
    fn a_parked_window_does_not_hold_the_conversation_it_left() {
        // Another window parked in agent view: its record keeps the id it
        // left beside `parkedJobId`, and its background job holds the fork
        // under a new id. This window resumed the original thread, which
        // nothing else holds.
        let mut table = FakeTable::window();
        table.spawn(1001, SHELL, Some(WINDOW_TTY), CLAUDE, "77");
        table.spawn(2000, 1, Some(2000), "/bin/zsh", "5");
        table.spawn(2001, 2000, Some(2000), CLAUDE, "88");
        table.spawn(3000, 1, None, CLAUDE, "6");
        table.spawn(3001, 3000, Some(3001), CLAUDE, "7");
        let mut parked = record(2001, CONVERSATION, "idle", "88");
        parked["parkedJobId"] = "a2efba65".into();
        let mut job = record(3001, OTHER, "idle", "7");
        job["kind"] = "bg".into();
        job["jobId"] = "a2efba65".into();
        let store = store_with(&[record(1001, CONVERSATION, "idle", "77"), parked, job]);
        let inspection = run(&table, &store);
        assert_eq!(inspection.source, Source::Registry);
        assert_eq!(inspection.conversation_id.as_deref(), Some(CONVERSATION));
        assert!(!inspection.live_elsewhere);

        // The fork's own holder is still seen from a window that is in it.
        let mut table = FakeTable::window();
        table.spawn(1001, SHELL, Some(WINDOW_TTY), CLAUDE, "77");
        table.spawn(3000, 1, None, CLAUDE, "6");
        table.spawn(3001, 3000, Some(3001), CLAUDE, "7");
        let mut job = record(3001, OTHER, "idle", "7");
        job["kind"] = "bg".into();
        job["jobId"] = "a2efba65".into();
        let store = store_with(&[record(1001, OTHER, "idle", "77"), job]);
        assert!(run(&table, &store).live_elsewhere);
    }

    #[test]
    fn a_parked_window_is_in_its_background_job_which_outlives_it() {
        // Agent view: the window's Claude starts Claude's supervisor as its
        // own child in a new session; the supervisor forks the conversation
        // into a background job under a new id and the window's record keeps
        // the old id beside `parkedJobId`.
        let mut table = FakeTable::window();
        table.spawn(1001, SHELL, Some(WINDOW_TTY), CLAUDE, "77");
        table.spawn(1002, 1001, Some(1002), CLAUDE, "78");
        table.spawn(1003, 1002, Some(1003), CLAUDE, "79");
        table.spawn(1004, 1003, Some(1004), CLAUDE, "80");
        let mut window = record(1001, CONVERSATION, "idle", "77");
        window["parkedJobId"] = "a2efba65".into();
        let mut job = record(1004, OTHER, "waiting", "80");
        job["kind"] = "bg".into();
        job["jobId"] = "a2efba65".into();
        let store = store_with(&[window, job]);
        assert_eq!(
            run(&table, &store),
            Inspection {
                agent: Some("claude-code"),
                conversation_id: Some(OTHER.into()),
                state: ConversationState::Blocked,
                cli_version: Some("2.1.288".into()),
                live_elsewhere: true,
                fresh: false,
                source: Source::Parked,
            }
        );
    }

    #[test]
    fn a_parked_window_whose_job_is_gone_names_no_conversation() {
        let mut table = FakeTable::window();
        table.spawn(1001, SHELL, Some(WINDOW_TTY), CLAUDE, "77");
        let mut window = record(1001, CONVERSATION, "idle", "77");
        window["parkedJobId"] = "a2efba65".into();
        let store = store_with(&[window.clone()]);
        let inspection = run(&table, &store);
        assert_eq!(inspection.source, Source::Parked);
        assert_eq!(inspection.conversation_id, None);
        assert!(!inspection.live_elsewhere);

        // A job name this daemon does not believe is not mistaken for "not
        // parked": the stale id is never offered.
        window["parkedJobId"] = "../../etc".into();
        let store = store_with(&[window]);
        let inspection = run(&table, &store);
        assert_eq!(inspection.source, Source::Parked);
        assert_eq!(inspection.conversation_id, None);
    }

    #[test]
    fn an_attach_client_shows_a_conversation_held_elsewhere() {
        let mut table = FakeTable::window();
        table.spawn(1001, SHELL, Some(WINDOW_TTY), CLAUDE, "77");
        // The background session it shows, under Claude's supervisor.
        table.spawn(3000, 1, None, CLAUDE, "5");
        table.spawn(3001, 3000, Some(3001), CLAUDE, "6");
        let mut job = record(3001, OTHER, "idle", "6");
        job["jobId"] = "a2efba65".into();
        let store = store_with(&[job]);
        let journal = store.path().join("daemon").join("attach-journal");
        std::fs::create_dir_all(&journal).unwrap();
        std::fs::write(
            journal.join("eee45fce-f141-4b55-a83b-600f2cb66d45.json"),
            r#"{"gestureId":"eee45fce","surface":"bg_cli","pid":1001,"procStart":"77","via":"cold"}"#,
        )
        .unwrap();
        assert_eq!(
            run(&table, &store),
            Inspection {
                agent: Some("claude-code"),
                conversation_id: None,
                state: ConversationState::Unknown,
                cli_version: None,
                live_elsewhere: true,
                fresh: false,
                source: Source::Attach,
            }
        );

        // The journal outlives a killed client; a new process at that pid is
        // not an attach client.
        table.starts.insert(1001, "999".into());
        assert_eq!(run(&table, &store).source, Source::Process);
    }

    #[test]
    fn the_agent_nearest_the_shell_answers() {
        // Claude running a nested Claude in its Bash tool: the outer one is
        // the conversation the window is in.
        let mut table = FakeTable::window();
        table.spawn(1001, SHELL, Some(WINDOW_TTY), CLAUDE, "77");
        table.spawn(1002, 1001, Some(WINDOW_TTY), "/bin/bash", "78");
        table.spawn(1003, 1002, Some(WINDOW_TTY), CLAUDE, "79");
        let store = store_with(&[
            record(1003, OTHER, "busy", "79"),
            record(1001, CONVERSATION, "busy", "77"),
        ]);
        assert_eq!(
            run(&table, &store).conversation_id.as_deref(),
            Some(CONVERSATION)
        );
    }

    /// A Codex home on disk: rollouts and writer locks with the times Codex
    /// would have left on them, and a window whose native Codex (under npm's
    /// node launcher) holds whichever of them a test opens.
    struct CodexHome {
        dir: tempfile::TempDir,
        table: FakeTable,
    }

    const CODEX_PID: u32 = 1002;
    const THREAD_A: &str = "01a1851d-2f36-76d1-98ee-b27aeae4a30d";
    const THREAD_B: &str = "01a1851d-dcf1-7852-a5e9-dfea6fc5f98a";
    const THREAD_C: &str = "01a18522-1349-71d2-9b67-b3e81618a23e";

    impl CodexHome {
        fn new() -> Self {
            let mut table = FakeTable::window();
            table.spawn(1001, SHELL, Some(WINDOW_TTY), "/usr/bin/node", "77");
            table.spawn(
                CODEX_PID,
                1001,
                Some(WINDOW_TTY),
                "/usr/lib/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/codex/codex",
                "78",
            );
            table
                .open
                .insert(CODEX_PID, vec![PathBuf::from("/dev/pts/3")]);
            let dir = tempfile::tempdir().unwrap();
            std::fs::create_dir_all(dir.path().join("sessions/2026/10/29")).unwrap();
            std::fs::create_dir_all(dir.path().join("thread-writer-locks")).unwrap();
            Self { dir, table }
        }

        fn at(seconds: u64) -> SystemTime {
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000 + seconds)
        }

        fn hold(&mut self, path: PathBuf, written: u64, contents: &str) {
            std::fs::write(&path, contents).unwrap();
            std::fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(Self::at(written))
                .unwrap();
            self.table.open.get_mut(&CODEX_PID).unwrap().push(path);
        }

        /// The thread's writer lock, as Codex holds it from the thread's start.
        fn lock(&mut self, id: &str, written: u64) {
            let path = self
                .dir
                .path()
                .join("thread-writer-locks")
                .join(format!("{id}.lock"));
            self.hold(path, written, "");
        }

        /// The thread's rollout, its first line a `session_meta` from `source`.
        fn rollout(&mut self, id: &str, written: u64, source: Value, thread_source: &str) {
            let meta = serde_json::json!({
                "timestamp": "2026-10-29T00:44:04.123Z",
                "type": "session_meta",
                "payload": {
                    "id": id,
                    "session_id": id,
                    "cwd": "/home/me/proj",
                    "originator": "codex-tui",
                    "cli_version": "0.155.1",
                    "source": source,
                    "thread_source": thread_source,
                    "base_instructions": {"text": "x".repeat(22_000)},
                },
            });
            let path = self
                .dir
                .path()
                .join("sessions/2026/10/29")
                .join(format!("rollout-2026-10-29T00-44-04-{id}.jsonl"));
            self.hold(
                path,
                written,
                &format!("{meta}\n{{\"type\":\"event_msg\"}}\n"),
            );
        }

        fn primary(&mut self, id: &str, written: u64) {
            self.rollout(id, written, Value::from("cli"), "user");
        }

        fn subagent(&mut self, id: &str, parent: &str, written: u64) {
            let source = serde_json::json!({
                "subagent": {"thread_spawn": {"parent_thread_id": parent, "depth": 1}}
            });
            self.rollout(id, written, source, "subagent");
        }

        fn inspect(&self) -> Inspection {
            inspect(SHELL, &self.table, &[store_with(&[]).path().to_path_buf()])
        }
    }

    fn started(id: &str) -> Inspection {
        Inspection {
            agent: Some("codex"),
            conversation_id: Some(id.into()),
            state: ConversationState::Unknown,
            cli_version: None,
            live_elsewhere: false,
            fresh: false,
            source: Source::OpenFile,
        }
    }

    #[test]
    fn codex_is_named_by_the_thread_it_holds() {
        let mut home = CodexHome::new();
        home.lock(THREAD_A, 10);
        home.primary(THREAD_A, 12);
        assert_eq!(home.inspect(), started(THREAD_A));
    }

    #[test]
    fn a_codex_thread_with_nothing_written_is_fresh_and_unnamed() {
        // Launched, no message yet: the lock is held, the rollout is not.
        let mut home = CodexHome::new();
        home.lock(THREAD_A, 10);
        let inspection = home.inspect();
        assert_eq!(inspection.agent, Some("codex"));
        assert_eq!(inspection.conversation_id, None);
        assert!(inspection.fresh);
        assert_eq!(inspection.source, Source::OpenFile);
        // `/new` after a conversation: the last one stays held, older.
        home.primary(THREAD_A, 12);
        home.lock(THREAD_B, 20);
        let inspection = home.inspect();
        assert_eq!(inspection.conversation_id, None);
        assert!(inspection.fresh);
    }

    #[test]
    fn codex_holding_several_threads_is_in_the_one_written_last() {
        // `/new`, then a message: two threads held, the new one written last.
        let mut home = CodexHome::new();
        home.lock(THREAD_A, 10);
        home.primary(THREAD_A, 12);
        home.lock(THREAD_B, 20);
        home.primary(THREAD_B, 25);
        assert_eq!(home.inspect(), started(THREAD_B));
        // `/resume` of the first from inside Codex writes its lock and its
        // rollout again, after the second's.
        let mut home = CodexHome::new();
        home.lock(THREAD_A, 30);
        home.primary(THREAD_A, 31);
        home.lock(THREAD_B, 20);
        home.primary(THREAD_B, 25);
        assert_eq!(home.inspect(), started(THREAD_A));
    }

    #[test]
    fn a_subagents_thread_is_never_the_windows() {
        let mut home = CodexHome::new();
        home.lock(THREAD_A, 10);
        home.primary(THREAD_A, 12);
        home.lock(THREAD_B, 14);
        home.subagent(THREAD_B, THREAD_A, 40);
        home.lock(THREAD_C, 15);
        home.subagent(THREAD_C, THREAD_A, 41);
        assert_eq!(home.inspect(), started(THREAD_A));
        // Subagents alone name nothing.
        let mut home = CodexHome::new();
        home.subagent(THREAD_B, THREAD_A, 40);
        let inspection = home.inspect();
        assert_eq!(inspection.conversation_id, None);
        assert!(!inspection.fresh);
        assert_eq!(inspection.source, Source::Process);
    }

    #[test]
    fn a_rollout_whose_first_line_cannot_be_read_is_the_persons() {
        let mut home = CodexHome::new();
        home.lock(THREAD_A, 10);
        home.primary(THREAD_A, 12);
        let path = home
            .dir
            .path()
            .join("sessions/2026/10/29")
            .join(format!("rollout-2026-10-29T00-50-00-{THREAD_B}.jsonl"));
        // A first line longer than is read, then one not JSON at all.
        let long = format!(
            "{{\"type\":\"session_meta\",\"x\":\"{}\"}}",
            "y".repeat(300_000)
        );
        home.hold(path.clone(), 20, &long);
        assert_eq!(home.inspect(), started(THREAD_B));
        std::fs::write(&path, "not json\n").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(CodexHome::at(20))
            .unwrap();
        assert_eq!(home.inspect(), started(THREAD_B));
    }

    #[test]
    fn codex_holding_nothing_of_its_threads_names_none() {
        let home = CodexHome::new();
        let inspection = home.inspect();
        assert_eq!(inspection.agent, Some("codex"));
        assert_eq!(inspection.source, Source::Process);
        assert_eq!(inspection.conversation_id, None);
        assert!(!inspection.fresh);
        // Paths that only look like Codex's are not its threads.
        let mut table = home.table;
        table.open.get_mut(&CODEX_PID).unwrap().extend([
            PathBuf::from(format!("/tmp/{THREAD_A}.lock")),
            PathBuf::from(format!("/tmp/thread-writer-locks/{THREAD_A}.lck")),
            PathBuf::from("/tmp/thread-writer-locks/.coordination.lock"),
        ]);
        let inspection = inspect(SHELL, &table, &[store_with(&[]).path().to_path_buf()]);
        assert_eq!(inspection.source, Source::Process);
    }

    #[test]
    fn a_codex_windows_thread_is_remembered_once_it_has_one() {
        let homes = tempfile::tempdir().unwrap();
        let memory = ConversationMemory::new(homes.path().to_path_buf());
        let window = Uuid::new_v4();
        assert_eq!(memory.recall(window), None);
        // Nothing to remember: no agent, a Claude Code window, a fresh thread.
        memory.note(window, &Inspection::nothing());
        memory.note(
            window,
            &Inspection {
                agent: Some(CLAUDE_CODE),
                ..started(CONVERSATION)
            },
        );
        memory.note(window, &Inspection::codex(CodexThread::Fresh));
        assert_eq!(memory.recall(window), None);
        memory.note(window, &started(THREAD_A));
        let remembered = Inspection {
            source: Source::Remembered,
            ..started(THREAD_A)
        };
        assert_eq!(memory.recall(window), Some(remembered));
        memory.note(window, &started(THREAD_B));
        assert_eq!(
            memory.recall(window).unwrap().conversation_id.as_deref(),
            Some(THREAD_B)
        );
        // One window's note is its own.
        assert_eq!(memory.recall(Uuid::new_v4()), None);
        // Nothing is left behind but the note.
        let names: Vec<_> = std::fs::read_dir(homes.path().join(window.to_string()))
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, [std::ffi::OsString::from(MEMORY_FILE)]);
    }

    #[test]
    fn a_note_is_believed_only_as_a_codex_uuid() {
        let homes = tempfile::tempdir().unwrap();
        let memory = ConversationMemory::new(homes.path().to_path_buf());
        let window = Uuid::new_v4();
        let path = homes.path().join(window.to_string()).join(MEMORY_FILE);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        for bad in [
            serde_json::json!({"agent": "claude-code", "conversation_id": THREAD_A}).to_string(),
            serde_json::json!({"agent": "codex", "conversation_id": "--last"}).to_string(),
            serde_json::json!({"agent": "codex", "conversation_id": THREAD_A.to_uppercase()})
                .to_string(),
            serde_json::json!({"agent": "codex"}).to_string(),
            format!(
                "{{\"agent\":\"codex\",\"conversation_id\":\"{THREAD_A}\",\"pad\":\"{}\"}}",
                "x".repeat(2048)
            ),
            "not json".to_string(),
        ] {
            std::fs::write(&path, &bad).unwrap();
            assert_eq!(memory.recall(window), None, "{bad}");
        }
        // A link is not followed.
        let elsewhere = homes.path().join("elsewhere.json");
        std::fs::write(
            &elsewhere,
            serde_json::json!({"agent": "codex", "conversation_id": THREAD_A}).to_string(),
        )
        .unwrap();
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &path).unwrap();
        assert_eq!(memory.recall(window), None);
    }

    #[test]
    fn a_window_without_its_agent_is_answered_from_its_note() {
        let homes = tempfile::tempdir().unwrap();
        let memory = ConversationMemory::new(homes.path().to_path_buf());
        let window = Uuid::new_v4();
        // Never noted: a live answer stands, and a window not running here
        // has none.
        assert_eq!(
            answer(window, Some(Inspection::nothing()), Some(&memory)),
            Some(Inspection::nothing())
        );
        assert_eq!(answer(window, None, Some(&memory)), None);
        assert_eq!(answer(window, None, None), None);
        // A live answer is noted as it is given.
        assert_eq!(
            answer(window, Some(started(THREAD_A)), Some(&memory)),
            Some(started(THREAD_A))
        );
        let remembered = Some(Inspection {
            source: Source::Remembered,
            ..started(THREAD_A)
        });
        // Codex has gone and the shell is back, or the window is not running.
        assert_eq!(
            answer(window, Some(Inspection::nothing()), Some(&memory)),
            remembered
        );
        assert_eq!(answer(window, None, Some(&memory)), remembered);
        // An agent running in the window is answered for live, whatever was
        // noted: a fresh Codex thread, or a Codex the host cannot read.
        let fresh = Inspection::codex(CodexThread::Fresh);
        assert_eq!(
            answer(window, Some(fresh.clone()), Some(&memory)),
            Some(fresh)
        );
        let unknown = Inspection::codex(CodexThread::Unknown);
        assert_eq!(
            answer(window, Some(unknown.clone()), Some(&memory)),
            Some(unknown)
        );
        assert_eq!(answer(window, None, Some(&memory)), remembered);
    }

    #[test]
    fn codex_shows_its_own_name_or_nodes_in_the_foreground() {
        assert!(may_be_codex("codex"));
        assert!(may_be_codex("node"));
        assert!(!may_be_codex("bash"));
        assert!(!may_be_codex("claude"));
    }

    #[test]
    fn a_shell_with_nothing_running_is_no_agent() {
        let mut table = FakeTable::window();
        table.spawn(1001, SHELL, Some(WINDOW_TTY), "/usr/bin/top", "77");
        assert_eq!(run(&table, &store_with(&[])), Inspection::nothing());
        // A window whose shell is gone.
        assert_eq!(
            inspect(4242, &table, &[store_with(&[]).path().to_path_buf()]),
            Inspection::nothing()
        );
    }

    #[test]
    fn hostile_registry_files_are_skipped_not_believed() {
        let mut table = FakeTable::window();
        table.spawn(1001, SHELL, Some(WINDOW_TTY), CLAUDE, "77");
        let store = store_with(&[]);
        let sessions = store.path().join("sessions");
        // Pid in the name and the body disagree.
        std::fs::write(
            sessions.join("1001.json"),
            record(1002, CONVERSATION, "idle", "77").to_string(),
        )
        .unwrap();
        assert_eq!(run(&table, &store).source, Source::Process);
        // Not a UUID.
        std::fs::write(
            sessions.join("1001.json"),
            record(1001, "../../../etc/passwd", "idle", "77").to_string(),
        )
        .unwrap();
        assert_eq!(run(&table, &store).source, Source::Process);
        // Not JSON, and oversized.
        std::fs::write(sessions.join("1001.json"), b"{\"pid\":1001,").unwrap();
        assert_eq!(run(&table, &store).source, Source::Process);
        let mut huge = record(1001, CONVERSATION, "idle", "77");
        huge["padding"] = "x".repeat(MAX_RECORD_BYTES as usize).into();
        std::fs::write(sessions.join("1001.json"), huge.to_string()).unwrap();
        assert_eq!(run(&table, &store).source, Source::Process);
        // A link to a real record is not followed.
        std::fs::remove_file(sessions.join("1001.json")).unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let real = elsewhere.path().join("real.json");
        std::fs::write(&real, record(1001, CONVERSATION, "idle", "77").to_string()).unwrap();
        std::os::unix::fs::symlink(&real, sessions.join("1001.json")).unwrap();
        assert_eq!(run(&table, &store).source, Source::Process);
        // A FIFO under a record's name cannot stall the read.
        std::fs::remove_file(sessions.join("1001.json")).unwrap();
        nix::unistd::mkfifo(&sessions.join("1001.json"), nix::sys::stat::Mode::S_IRWXU).unwrap();
        assert_eq!(run(&table, &store).source, Source::Process);
    }

    #[test]
    fn record_names_must_be_canonical_pids() {
        assert_eq!(record_file_pid("1001.json"), Some(1001));
        for bad in [
            "01001.json",
            "1001.json.bak",
            "+1001.json",
            "1.json",
            "0.json",
            "99999999999.json",
            "1001.0123abcd.key",
            "abc.json",
        ] {
            assert_eq!(record_file_pid(bad), None, "{bad}");
        }
    }

    #[test]
    fn claude_and_codex_are_recognised_by_their_executables() {
        for claude in [
            "/home/me/.local/bin/claude",
            "/home/me/.local/share/claude/versions/2.1.288",
            "/home/me/.local/share/claude/versions/2.1.287 (deleted)",
        ] {
            assert!(is_claude(Path::new(claude)), "{claude}");
        }
        for other in [
            "/usr/bin/node",
            "/home/me/.local/share/other/versions/2.1.288",
            "/home/me/versions/2.1.288",
            "/usr/bin/claude-helper",
        ] {
            assert!(!is_claude(Path::new(other)), "{other}");
        }
        assert!(is_codex(Path::new("/usr/local/bin/codex")));
        assert!(!is_codex(Path::new("/usr/local/bin/codex-wrapper")));
    }

    #[test]
    fn rollout_ids_are_read_only_from_well_formed_names() {
        assert_eq!(
            codex_rollout_id(Path::new(
                "/s/rollout-2026-10-03T10-12-44-0199a8b2-6c3e-7f10-9d2b-5a4e3c2b1a09.jsonl"
            ))
            .as_deref(),
            Some("0199a8b2-6c3e-7f10-9d2b-5a4e3c2b1a09")
        );
        for bad in [
            "/s/rollout-0199a8b2-6c3e-7f10-9d2b-5a4e3c2b1a09.jsonl",
            "/s/rollout-2026-10-03T10-12-44-0199a8b2-6c3e-7f10-9d2b-5a4e3c2b1a09.jsonl.zst",
            "/s/rollout-2026-10-03T10-12-44-NOT-A-UUID-AT-ALL-0000000000000000.jsonl",
            "/s/notes.jsonl",
        ] {
            assert_eq!(codex_rollout_id(Path::new(bad)), None, "{bad}");
        }
    }

    #[test]
    fn the_answer_fits_a_control_frame() {
        let inspection = Inspection {
            agent: Some("claude-code"),
            conversation_id: Some(CONVERSATION.into()),
            state: ConversationState::Blocked,
            cli_version: Some("x".repeat(32)),
            live_elsewhere: true,
            fresh: false,
            source: Source::Registry,
        };
        let encoded = serde_json::to_string(&inspection).unwrap();
        assert!(encoded.len() < 512, "{encoded}");
        assert_eq!(
            serde_json::from_str::<Value>(&encoded).unwrap(),
            serde_json::json!({
                "agent": "claude-code",
                "conversation_id": CONVERSATION,
                "state": "blocked",
                "cli_version": "x".repeat(32),
                "live_elsewhere": true,
                "fresh": false,
                "source": "registry",
            })
        );
        let fresh = serde_json::to_value(Inspection::codex(CodexThread::Fresh)).unwrap();
        assert_eq!(fresh["fresh"], true);
        assert_eq!(fresh["conversation_id"], Value::Null);
        assert_eq!(fresh["source"], "open_file");
        let remembered = Inspection {
            source: Source::Remembered,
            ..Inspection::codex(CodexThread::Started(CONVERSATION.into()))
        };
        assert_eq!(
            serde_json::to_value(remembered).unwrap()["source"],
            "remembered"
        );
    }

    #[test]
    fn lock_ids_are_read_only_from_codexs_lock_folder() {
        assert_eq!(
            codex_lock_id(Path::new(
                "/home/me/.codex/thread-writer-locks/01a1851d-2f36-76d1-98ee-b27aeae4a30d.lock"
            ))
            .as_deref(),
            Some("01a1851d-2f36-76d1-98ee-b27aeae4a30d")
        );
        for bad in [
            "/home/me/.codex/thread-writer-locks/.coordination.lock",
            "/home/me/.codex/thread-writer-locks/01A1851D-2F36-76D1-98EE-B27AEAE4A30D.lock",
            "/home/me/.codex/locks/01a1851d-2f36-76d1-98ee-b27aeae4a30d.lock",
            "/home/me/.codex/thread-writer-locks/01a1851d-2f36-76d1-98ee-b27aeae4a30d",
            "01a1851d-2f36-76d1-98ee-b27aeae4a30d.lock",
        ] {
            assert_eq!(codex_lock_id(Path::new(bad)), None, "{bad}");
        }
    }

    #[test]
    fn window_shells_never_name_init() {
        let shells = WindowShells::new(|id| (id == Uuid::nil()).then_some(1));
        assert_eq!(shells.shell_pid(Uuid::nil()), None);
        let shells = WindowShells::new(|_| Some(4242));
        assert_eq!(shells.shell_pid(Uuid::new_v4()), Some(4242));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_stat_lines_parse_after_the_last_parenthesis() {
        let stat = system::parse_stat(
            "3312138 (claude (x) y) S 3312136 3312138 3312136 34817 3312138 4194560 1 2 3 4 5 6 7 8 20 0 12 0 276309329 1 2",
        )
        .unwrap();
        assert_eq!(stat.ppid, 3312136);
        assert_eq!(stat.session, 3312136);
        assert_eq!(stat.start, "276309329");
        assert!(!stat.zombie);
        assert!(system::parse_stat("1 (x) Z 0 0 0").is_none());
    }

    /// The real process table against this very test: its own tree, in its
    /// own session, started when /proc says.
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_process_table_walks_a_real_tree() {
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let me = std::process::id();
        let tree = SystemProcesses.tree(me);
        assert_eq!(tree.first().map(|process| process.pid), Some(me));
        let found = tree
            .iter()
            .find(|process| process.pid == child.id())
            .copied()
            .expect("the child is under its parent");
        assert_eq!(found.terminal, tree[0].terminal);
        assert!(SystemProcesses.alive(child.id()));
        assert!(SystemProcesses
            .start_identity(child.id())
            .is_some_and(|start| start.bytes().all(|byte| byte.is_ascii_digit())));
        // `spawn` can return before the child's exec has replaced its image
        // (a vfork-style spawn in a threaded process), so `/proc/<pid>/exe`
        // may still name this test binary for a moment: wait for the exec.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut runs = SystemProcesses.executable(child.id());
        while !runs.as_ref().is_some_and(|path| path.ends_with("sleep"))
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(std::time::Duration::from_millis(10));
            runs = SystemProcesses.executable(child.id());
        }
        assert!(
            runs.as_ref().is_some_and(|path| path.ends_with("sleep")),
            "{runs:?}"
        );
        assert!(SystemProcesses
            .pid_domain()
            .is_some_and(|domain| domain.starts_with("linux:")));
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(!SystemProcesses.alive(child.id()));
    }

    /// The files this very test holds open, as Codex's would be read: on
    /// macOS through libproc, on Linux through `/proc/<pid>/fd`.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn the_real_process_table_lists_a_processs_open_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir
            .path()
            .join(format!("rollout-2026-10-29T00-44-04-{THREAD_A}.jsonl"));
        let _held = std::fs::File::create(&path).unwrap();
        let canonical = std::fs::canonicalize(&path).unwrap();
        let open = SystemProcesses.open_files(std::process::id());
        assert!(
            open.iter().any(
                |file| std::fs::canonicalize(file).ok().as_deref() == Some(canonical.as_path())
            ),
            "{canonical:?} not in {open:?}"
        );
        assert!(open
            .iter()
            .any(|file| codex_rollout_id(file).as_deref() == Some(THREAD_A)));
    }
}
