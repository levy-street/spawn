//! Where an agent leaves its own record of a conversation, and how a device
//! asks for it.
//!
//! `agent.transcripts` answers with the files an agent harness wrote for one
//! window's conversation: Claude Code's `projects/<folder>/<id>.jsonl` and the
//! sidecar beside it, Codex's dated `rollout-*.jsonl` files, aider's chat
//! history in the working folder or at the root of its repository. The daemon
//! only *locates*. The device then reads each file with the ordinary
//! `fs.read`, through the same home-rooted, symlink-refusing capability every
//! other read goes through, and nothing about the content reaches the server
//! (`docs/TRUST.md`). An agent whose record lives somewhere the daemon cannot
//! name — opencode keeps its conversations in a database — answers
//! `supported: false` rather than a guess.
//!
//! Each store is where the daemon's own environment puts it, the environment
//! every window starts from: `CLAUDE_CONFIG_DIR` (else `~/.claude`) and
//! `CODEX_HOME` (else `~/.codex`, and also when it names one of spawnd's own
//! window homes, which a daemon started from a skilled window inherits). One
//! configured outside home, or as a relative path, is beyond the file
//! capability, so it too answers `supported: false`: no `fs.read` could reach
//! what a search found there, and the locator does not widen what the daemon
//! will read.
//!
//! An agent names its working directory with every link resolved — Claude
//! Code's project folder is computed from `realpathSync(process.cwd())`, and
//! Codex records `getcwd` — so a window opened through a link is looked for
//! under that name first, then under the folder as given.
//!
//! Roles are a closed set on the wire — `conversation`, `subagent`, `input` —
//! that deployed clients validate, refusing a report with any other. So a
//! Claude Code sidecar reuses them: a helper's record, its metadata and the
//! workflows that ran helpers are `subagent`; tool output spilled out of the
//! record is `conversation`.
//!
//! Every search is bounded: so many directories opened, so many files looked
//! at, so many answers. A home directory with ten thousand Codex days in it
//! gets a truncated answer, never a stalled channel.

use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use serde::Serialize;

use crate::host_files::{
    cancelled_error, modified_seconds, FsError, FsResult, HostFileOperations, HostFileService,
    HostOperationKind,
};

/// Most files one answer names. Past this the answer says `truncated` and
/// keeps what it found first; the frame has 16 KiB to fit in, which holds
/// roughly this many home-rooted paths, so a larger cap would only move the
/// cut into the frame-fitting loop.
pub(crate) const MAX_TRANSCRIPTS: usize = 24;
/// Directories one search opens before it stops looking.
const MAX_SCAN_DIRS: usize = 512;
/// Files one search examines before it stops looking.
const MAX_SCAN_FILES: usize = 2000;
/// Entries one directory listing reads before it stops.
const MAX_LISTED_ENTRIES: usize = 2048;
/// How much of a record is read to learn which folder it was opened in: a
/// Codex rollout's `session_meta` line comes first and names `cwd` near its
/// start, and every Claude Code message line carries one.
const HEAD_BYTES: usize = 64 * 1024;
/// Claude Code cuts a project folder name at this many UTF-16 units and
/// suffixes a hash (`claude_project_folder`).
const CLAUDE_FOLDER_UNITS: usize = 200;

pub(crate) struct TranscriptQuery {
    /// The agent definition's `kind` (`claude-code`, `codex`, `aider`, …).
    pub agent_kind: String,
    /// The conversation id the client handed the agent at launch, when the
    /// grammar has one (`claude --session-id <uuid>`).
    pub conversation_id: Option<String>,
    /// The folder the window was opened in, for harnesses that key by it.
    pub cwd: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct TranscriptFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified_at: Option<i64>,
    /// `conversation` for the main record (and output it spilled),
    /// `subagent` for a helper the conversation ran, `input` for a bare
    /// prompt history.
    pub role: &'static str,
    pub conversation_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct TranscriptReport {
    pub agent_kind: String,
    /// False when the daemon knows nothing about where this harness writes,
    /// or where it writes is beyond the file capability.
    pub supported: bool,
    pub transcripts: Vec<TranscriptFile>,
    /// Where the daemon looked, as display paths, so an empty answer can say.
    pub searched: Vec<String>,
    pub truncated: bool,
}

/// Where this daemon's agents keep their records.
#[derive(Default)]
pub(crate) struct AgentStores {
    /// `CLAUDE_CONFIG_DIR`; unset means `~/.claude`.
    pub claude_config_dir: Option<PathBuf>,
    /// `CODEX_HOME`; unset means `~/.codex`.
    pub codex_home: Option<PathBuf>,
    /// spawnd's own per-window homes (`config::window_homes_dir`). A skilled
    /// window started before its Codex home linked rollouts into the store
    /// above keeps its own `codex-home/sessions` there.
    pub window_homes: Option<PathBuf>,
}

impl AgentStores {
    fn from_env() -> Self {
        let window_homes = crate::config::window_homes_dir().ok();
        Self {
            claude_config_dir: configured_dir("CLAUDE_CONFIG_DIR"),
            codex_home: users_codex_home(configured_dir("CODEX_HOME"), window_homes.as_deref()),
            window_homes,
        }
    }
}

/// `CODEX_HOME` as the user's store, unless it names one of spawnd's own
/// window homes: a daemon started from a skilled window inherits that
/// window's, whose `sessions` is a link into the user's store that the file
/// capability refuses to follow. The store is then the default one, as it is
/// for the window's own source (`run.rs`, `codex_source_home`).
fn users_codex_home(configured: Option<PathBuf>, window_homes: Option<&Path>) -> Option<PathBuf> {
    configured.filter(|path| !window_homes.is_some_and(|homes| path.starts_with(homes)))
}

fn configured_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.to_string_lossy().trim().is_empty())
        .map(PathBuf::from)
}

/// The server's own rule for the id (`AGENT_SESSION_ID_PATTERN`), plus one of
/// ours: something alphanumeric has to be in it, so `..` and `.` can never
/// name a file.
pub(crate) fn valid_conversation_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
        && id.bytes().any(|byte| byte.is_ascii_alphanumeric())
}

/// The folder Claude Code files a working directory under, exactly as it
/// computes it: every UTF-16 unit that is not an ASCII letter or digit
/// becomes a dash, so `/home/me/proj` is `-home-me-proj`, `C:\Users\me` is
/// `C--Users-me`, and an emoji is two dashes. A name longer than 200 units is
/// cut there and given `-` plus the base-36 absolute value of the path's
/// Java-style `hashCode`. `proto/claude-project-folder.json` pins it.
pub(crate) fn claude_project_folder(cwd: &str) -> String {
    let folder: String = cwd
        .encode_utf16()
        .map(|unit| match u8::try_from(unit) {
            Ok(byte) if byte.is_ascii_alphanumeric() => char::from(byte),
            _ => '-',
        })
        .collect();
    if folder.len() <= CLAUDE_FOLDER_UNITS {
        return folder;
    }
    let hash = cwd.encode_utf16().fold(0_i32, |hash, unit| {
        hash.wrapping_mul(31).wrapping_add(i32::from(unit))
    });
    // `Math.abs` on a double: `i32::MIN` has an absolute value too.
    format!(
        "{}-{}",
        &folder[..CLAUDE_FOLDER_UNITS],
        base36(i64::from(hash).unsigned_abs())
    )
}

fn base36(mut value: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut digits = Vec::new();
    loop {
        digits.push(DIGITS[(value % 36) as usize]);
        value /= 36;
        if value == 0 {
            break;
        }
    }
    digits.reverse();
    String::from_utf8(digits).unwrap_or_default()
}

/// The id at the end of a Codex rollout name:
/// `rollout-2026-09-17T10-12-44-<id>.jsonl`, or `.jsonl.zst` once Codex has
/// compressed an old one.
pub(crate) fn codex_conversation_id(name: &str) -> Option<String> {
    let rest = name.strip_prefix("rollout-")?;
    let rest = rest
        .strip_suffix(".jsonl.zst")
        .or_else(|| rest.strip_suffix(".jsonl"))?;
    // `YYYY-MM-DDThh-mm-ss` is 19 bytes, then the dash before the id.
    const TIMESTAMP_AND_DASH: usize = 20;
    if rest.len() <= TIMESTAMP_AND_DASH || !rest.is_char_boundary(TIMESTAMP_AND_DASH) {
        return None;
    }
    let id = &rest[TIMESTAMP_AND_DASH..];
    valid_conversation_id(id).then(|| id.to_string())
}

pub(crate) async fn locate_in_session(
    files: &HostFileService,
    query: TranscriptQuery,
    operations: Arc<HostFileOperations>,
) -> FsResult<TranscriptReport> {
    locate_with_stores(files, query, None, operations).await
}

/// `stores` is `None` for the daemon's own environment, resolved on the
/// blocking pool because naming spawnd's config dir touches the disk.
async fn locate_with_stores(
    files: &HostFileService,
    query: TranscriptQuery,
    stores: Option<AgentStores>,
    operations: Arc<HostFileOperations>,
) -> FsResult<TranscriptReport> {
    if let Some(id) = &query.conversation_id {
        if !valid_conversation_id(id) {
            return Err(FsError::new(
                "invalid_request",
                "conversation id is not a valid identifier",
            ));
        }
    }
    if let Some(cwd) = &query.cwd {
        if cwd.as_bytes().contains(&0) {
            return Err(FsError::new("invalid_path", "path contains a NUL byte"));
        }
    }
    let service = files.clone();
    files
        .run_blocking(operations, HostOperationKind::List, move |operations| {
            let stores = stores.unwrap_or_else(AgentStores::from_env);
            locate_sync(&service, &query, &stores, operations)
        })
        .await
}

fn locate_sync(
    files: &HostFileService,
    query: &TranscriptQuery,
    stores: &AgentStores,
    operations: &HostFileOperations,
) -> FsResult<TranscriptReport> {
    let mut search = Search {
        files,
        stores,
        operations,
        dirs_opened: 0,
        files_examined: 0,
        truncated: false,
        searched: Vec::new(),
        real_cwd: None,
    };
    let query = TranscriptQuery {
        agent_kind: query.agent_kind.clone(),
        conversation_id: query.conversation_id.clone(),
        // `~` is the host's home, which is what the agent itself was given.
        cwd: query
            .cwd
            .as_deref()
            .filter(|cwd| !cwd.trim().is_empty())
            .map(|cwd| search.expand_home(cwd)),
    };
    search.real_cwd = query
        .cwd
        .as_deref()
        .and_then(real_folder)
        .filter(|real| query.cwd.as_deref() != Some(real.as_str()));
    let (supported, mut transcripts) = match query.agent_kind.as_str() {
        "claude-code" => match search.store(stores.claude_config_dir.as_deref(), ".claude") {
            Some(store) => (true, search.claude(&store, &query)?),
            None => (false, Vec::new()),
        },
        "codex" => match search.store(stores.codex_home.as_deref(), ".codex") {
            Some(store) => (true, search.codex(&store, &query)?),
            None => (false, Vec::new()),
        },
        "aider" => (true, search.aider(&query)?),
        _ => (false, Vec::new()),
    };
    if transcripts.len() > MAX_TRANSCRIPTS {
        transcripts.truncate(MAX_TRANSCRIPTS);
        search.truncated = true;
    }
    Ok(TranscriptReport {
        agent_kind: query.agent_kind,
        supported,
        transcripts,
        searched: search.searched,
        truncated: search.truncated,
    })
}

struct Child {
    name: OsString,
    is_dir: bool,
    is_file: bool,
}

/// What a Codex rollout is matched by.
enum CodexMatch {
    /// Its name ends in the id.
    Id { plain: String, compressed: String },
    /// Its first line names the folder, by any of its names (a compressed
    /// rollout cannot be read for it, so only an id finds one of those).
    Cwd(Vec<String>),
}

struct Search<'a> {
    files: &'a HostFileService,
    stores: &'a AgentStores,
    operations: &'a HostFileOperations,
    dirs_opened: usize,
    files_examined: usize,
    truncated: bool,
    searched: Vec<String>,
    /// The window's folder with every link resolved, where that is another
    /// name for it (`real_folder`).
    real_cwd: Option<String>,
}

impl Search<'_> {
    fn check_cancelled(&self) -> FsResult<()> {
        if self.operations.cancelled() {
            return Err(cancelled_error());
        }
        Ok(())
    }

    /// One more directory, if the budget allows. False stops the search and
    /// marks the answer truncated.
    fn tick_dir(&mut self) -> FsResult<bool> {
        self.check_cancelled()?;
        if self.dirs_opened >= MAX_SCAN_DIRS {
            self.truncated = true;
            return Ok(false);
        }
        self.dirs_opened += 1;
        Ok(true)
    }

    fn tick_file(&mut self) -> FsResult<bool> {
        self.check_cancelled()?;
        if self.files_examined >= MAX_SCAN_FILES {
            self.truncated = true;
            return Ok(false);
        }
        self.files_examined += 1;
        Ok(true)
    }

    fn display(&self, components: &[OsString]) -> String {
        self.files
            .display_path(components)
            .to_string_lossy()
            .into_owned()
    }

    /// The window's folder as an agent names its own working directory —
    /// every link resolved, as Claude Code's `realpathSync(process.cwd())`
    /// and Codex's `getcwd` have it — and then as given, where that differs.
    fn cwds(&self, query: &TranscriptQuery) -> Vec<String> {
        self.real_cwd
            .iter()
            .chain(query.cwd.iter())
            .cloned()
            .collect()
    }

    /// `~` and `~/x` against the home the file capability is rooted at;
    /// anything else as given.
    fn expand_home(&self, cwd: &str) -> String {
        let home = self.files.home_dir();
        if cwd == "~" {
            return home;
        }
        match cwd.strip_prefix("~/").or_else(|| cwd.strip_prefix("~\\")) {
            Some(rest) => {
                #[cfg(windows)]
                let rest = rest.replace('/', "\\");
                Path::new(&home).join(rest).to_string_lossy().into_owned()
            }
            None => cwd.to_string(),
        }
    }

    /// A harness's store as components under home: `default` there when
    /// nothing is configured, else the configured directory when home holds
    /// it. `None`, after saying where it is, for one the capability cannot
    /// reach.
    fn store(&mut self, configured: Option<&Path>, default: &str) -> Option<Vec<OsString>> {
        let Some(configured) = configured else {
            return Some(vec![OsString::from(default)]);
        };
        let components = configured
            .to_str()
            .filter(|_| configured.is_absolute())
            .and_then(|path| self.files.relative_components(path).ok());
        if components.is_none() {
            self.searched
                .push(configured.to_string_lossy().into_owned());
        }
        components
    }

    /// A directory under home, or nothing where it does not exist. Any other
    /// refusal — a symlinked `~/.claude`, say — is the file capability's
    /// verdict and is reported as such, because `fs.read` would give the same.
    fn open_optional_dir(&mut self, components: &[OsString]) -> FsResult<Option<Dir>> {
        if !self.tick_dir()? {
            return Ok(None);
        }
        match self.files.open_dir_components(components) {
            Ok(dir) => Ok(Some(dir)),
            Err(error) if error.code == "not_found" => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// A directory under home reached without any link on the way, or
    /// nothing, whatever the reason: for places that may or may not exist
    /// and are not the store the answer is about.
    fn open_extra_dir(&mut self, components: &[OsString]) -> FsResult<Option<Dir>> {
        if !self.tick_dir()? {
            return Ok(None);
        }
        Ok(self.files.open_dir_components(components).ok())
    }

    /// A child directory opened without following a link, or nothing.
    fn open_child_dir(&mut self, parent: &Dir, name: &OsStr) -> FsResult<Option<Dir>> {
        if !self.tick_dir()? {
            return Ok(None);
        }
        match parent.open_dir_nofollow(name) {
            Ok(dir) => Ok(Some(dir)),
            Err(_) => Ok(None),
        }
    }

    fn children(&mut self, dir: &Dir) -> FsResult<Vec<Child>> {
        let mut children = Vec::new();
        for entry in dir.entries()? {
            self.check_cancelled()?;
            if children.len() >= MAX_LISTED_ENTRIES {
                self.truncated = true;
                break;
            }
            let entry = entry?;
            let name = entry.file_name();
            if name == OsStr::new(".") || name == OsStr::new("..") {
                continue;
            }
            let file_type = entry.file_type()?;
            children.push(Child {
                name,
                is_dir: file_type.is_dir(),
                is_file: file_type.is_file(),
            });
        }
        Ok(children)
    }

    /// The regular file `name` in `dir`, described; nothing for a link, a
    /// directory, or an absence.
    fn file_in(
        &mut self,
        dir: &Dir,
        dir_components: &[OsString],
        name: &OsStr,
        role: &'static str,
        conversation_id: Option<String>,
    ) -> FsResult<Option<TranscriptFile>> {
        if !self.tick_file()? {
            return Ok(None);
        }
        let metadata = match dir.symlink_metadata(name) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        if !metadata.is_file() {
            return Ok(None);
        }
        let mut components = dir_components.to_vec();
        components.push(name.to_os_string());
        Ok(Some(TranscriptFile {
            path: self.display(&components),
            name: name.to_string_lossy().into_owned(),
            size: metadata.len(),
            modified_at: modified_seconds(&metadata),
            role,
            conversation_id,
        }))
    }

    /// Every regular file in `dir` that `wanted` accepts, by name, into
    /// `found`. True once the answer is full or the budget spent: stop.
    fn files_into(
        &mut self,
        dir: &Dir,
        components: &[OsString],
        wanted: fn(&OsStr) -> bool,
        role: &'static str,
        conversation_id: &str,
        found: &mut Vec<TranscriptFile>,
    ) -> FsResult<bool> {
        let mut names: Vec<OsString> = self
            .children(dir)?
            .into_iter()
            .filter(|child| child.is_file && wanted(&child.name))
            .map(|child| child.name)
            .collect();
        names.sort();
        for name in names {
            // One past the cap is enough to know the answer is truncated.
            if found.len() > MAX_TRANSCRIPTS {
                self.truncated = true;
                return Ok(true);
            }
            match self.file_in(
                dir,
                components,
                &name,
                role,
                Some(conversation_id.to_string()),
            )? {
                Some(file) => found.push(file),
                None if self.truncated => return Ok(true),
                None => {}
            }
        }
        Ok(self.truncated)
    }

    /// Claude Code: `<store>/projects/<folder>/<id>.jsonl`, with the sidecar
    /// that conversation wrote under `<id>/`. With an id, every project folder
    /// is checked — a conversation resumed from another folder continues in
    /// that folder's file — the launch folder first. Without one (an agent
    /// typed by hand), the launch folder's conversations, newest first.
    fn claude(
        &mut self,
        store: &[OsString],
        query: &TranscriptQuery,
    ) -> FsResult<Vec<TranscriptFile>> {
        let mut base = store.to_vec();
        base.push(OsString::from("projects"));
        let cwds = self.cwds(query);
        let preferred: Vec<String> = cwds.iter().map(|cwd| claude_project_folder(cwd)).collect();
        let mut found = Vec::new();
        if let Some(id) = &query.conversation_id {
            self.searched.push(self.display(&base));
            let Some(projects) = self.open_optional_dir(&base)? else {
                return Ok(found);
            };
            let file_name = OsString::from(format!("{id}.jsonl"));
            let mut folders: Vec<OsString> = self
                .children(&projects)?
                .into_iter()
                .filter(|child| child.is_dir)
                .map(|child| child.name)
                .collect();
            folders.sort();
            folders.sort_by_key(|name| {
                preferred
                    .iter()
                    .position(|folder| name == OsStr::new(folder))
                    .unwrap_or(preferred.len())
            });
            // Every record first, then what lies beside each: a sidecar can
            // run to hundreds of files and must not crowd out the record of
            // the same conversation resumed in another folder.
            let mut holders = Vec::new();
            for folder in folders {
                let Some(project) = self.open_child_dir(&projects, &folder)? else {
                    if self.truncated {
                        break;
                    }
                    continue;
                };
                let mut components = base.clone();
                components.push(folder);
                let Some(file) = self.file_in(
                    &project,
                    &components,
                    &file_name,
                    "conversation",
                    Some(id.clone()),
                )?
                else {
                    if self.truncated {
                        break;
                    }
                    continue;
                };
                found.push(file);
                holders.push((project, components));
            }
            for (project, components) in holders {
                if self.claude_sidecar(&project, &components, id, &mut found)? {
                    break;
                }
            }
        } else if !cwds.is_empty() {
            // Claude Code files the window under its folder with links
            // resolved; a window opened through a link is looked for there
            // first, then as given. A resolved folder that holds nothing is
            // not reported as searched: it would only name a link's target.
            let mut folders = Vec::new();
            let mut looked: Vec<&str> = Vec::new();
            for (index, (cwd, folder)) in cwds.iter().zip(&preferred).enumerate() {
                if looked.contains(&folder.as_str()) {
                    continue;
                }
                looked.push(folder);
                let mut components = base.clone();
                components.push(OsString::from(folder));
                let as_given = index + 1 == cwds.len();
                if as_given {
                    self.searched.push(self.display(&components));
                }
                if let Some(project) = self.open_optional_dir(&components)? {
                    if !as_given {
                        self.searched.push(self.display(&components));
                    }
                    folders.push((project, components));
                }
                if folder.len() > CLAUDE_FOLDER_UNITS {
                    folders.extend(self.claude_rehashed_folders(&base, folder, cwd)?);
                }
            }
            for (project, components) in folders {
                for child in self.children(&project)? {
                    if !child.is_file || !has_suffix(&child.name, ".jsonl") {
                        continue;
                    }
                    let stem = child.name.to_string_lossy();
                    let stem = stem.strip_suffix(".jsonl").unwrap_or(&stem);
                    let (role, conversation_id) = if stem.starts_with("agent-") {
                        ("subagent", None)
                    } else {
                        ("conversation", Some(stem.to_string()))
                    };
                    if let Some(file) =
                        self.file_in(&project, &components, &child.name, role, conversation_id)?
                    {
                        found.push(file);
                    }
                }
            }
            found.sort_by(|a, b| b.modified_at.cmp(&a.modified_at).then(a.name.cmp(&b.name)));
        } else {
            self.searched.push(self.display(&base));
        }
        Ok(found)
    }

    /// A long folder name ends in a hash, and a Claude Code that hashed
    /// differently filed the same folder under another suffix. Claude Code
    /// itself accepts a folder with the same 200-unit cut whose records were
    /// opened in this cwd; so does this.
    fn claude_rehashed_folders(
        &mut self,
        base: &[OsString],
        folder: &str,
        cwd: &str,
    ) -> FsResult<Vec<(Dir, Vec<OsString>)>> {
        let mut matched = Vec::new();
        let Some(projects) = self.open_optional_dir(base)? else {
            return Ok(matched);
        };
        let prefix = format!("{}-", &folder[..CLAUDE_FOLDER_UNITS]);
        let needle = cwd_needle(cwd)?;
        let mut names: Vec<OsString> = self
            .children(&projects)?
            .into_iter()
            .filter(|child| {
                child.is_dir && has_prefix(&child.name, &prefix) && child.name != OsStr::new(folder)
            })
            .map(|child| child.name)
            .collect();
        names.sort();
        for name in names {
            let Some(project) = self.open_child_dir(&projects, &name)? else {
                if self.truncated {
                    break;
                }
                continue;
            };
            let mut records = Vec::new();
            for child in self.children(&project)? {
                if child.is_file && has_suffix(&child.name, ".jsonl") {
                    records.push(child.name);
                }
            }
            let mut opened_here = false;
            for record in records {
                if !self.tick_file()? {
                    break;
                }
                if head_contains(&project, &record, std::slice::from_ref(&needle)) {
                    opened_here = true;
                    break;
                }
            }
            if opened_here {
                let mut components = base.to_vec();
                components.push(name);
                self.searched.push(self.display(&components));
                matched.push((project, components));
            }
        }
        Ok(matched)
    }

    /// What `<folder>/<id>/` holds for one conversation, in the order a
    /// reader wants it: the helpers it ran (`subagents/`, their `.meta.json`
    /// beside each record, and `subagents/workflows/<run>/`), the workflows
    /// that ran them (`workflows/`, `workflows/scripts/`), then the tool
    /// output too long to keep in the record (`tool-results/`, named from the
    /// record by path). True once the answer is full.
    fn claude_sidecar(
        &mut self,
        project: &Dir,
        components: &[OsString],
        id: &str,
        found: &mut Vec<TranscriptFile>,
    ) -> FsResult<bool> {
        let Some(side) = self.open_child_dir(project, OsStr::new(id))? else {
            return Ok(self.truncated);
        };
        let mut side_components = components.to_vec();
        side_components.push(OsString::from(id));
        let child = |components: &[OsString], name: &str| {
            let mut components = components.to_vec();
            components.push(OsString::from(name));
            components
        };

        if let Some(subagents) = self.open_child_dir(&side, OsStr::new("subagents"))? {
            let sub_components = child(&side_components, "subagents");
            if self.files_into(
                &subagents,
                &sub_components,
                is_helper_record,
                "subagent",
                id,
                found,
            )? {
                return Ok(true);
            }
            if let Some(runs) = self.open_child_dir(&subagents, OsStr::new("workflows"))? {
                let runs_components = child(&sub_components, "workflows");
                let mut names: Vec<OsString> = self
                    .children(&runs)?
                    .into_iter()
                    .filter(|child| child.is_dir)
                    .map(|child| child.name)
                    .collect();
                names.sort();
                for name in names {
                    let Some(run) = self.open_child_dir(&runs, &name)? else {
                        if self.truncated {
                            return Ok(true);
                        }
                        continue;
                    };
                    let mut run_components = runs_components.clone();
                    run_components.push(name);
                    if self.files_into(
                        &run,
                        &run_components,
                        is_helper_record,
                        "subagent",
                        id,
                        found,
                    )? {
                        return Ok(true);
                    }
                }
            }
        }
        if let Some(workflows) = self.open_child_dir(&side, OsStr::new("workflows"))? {
            let workflow_components = child(&side_components, "workflows");
            if self.files_into(
                &workflows,
                &workflow_components,
                any_name,
                "subagent",
                id,
                found,
            )? {
                return Ok(true);
            }
            if let Some(scripts) = self.open_child_dir(&workflows, OsStr::new("scripts"))? {
                if self.files_into(
                    &scripts,
                    &child(&workflow_components, "scripts"),
                    any_name,
                    "subagent",
                    id,
                    found,
                )? {
                    return Ok(true);
                }
            }
        }
        if let Some(results) = self.open_child_dir(&side, OsStr::new("tool-results"))? {
            if self.files_into(
                &results,
                &child(&side_components, "tool-results"),
                any_name,
                "conversation",
                id,
                found,
            )? {
                return Ok(true);
            }
        }
        Ok(self.truncated)
    }

    /// Codex: `<store>/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl`,
    /// newest day first. Codex picks its own id, so a window rarely has one
    /// recorded; the rollouts opened in the window's folder stand in — each
    /// file's first line is its `session_meta` and names the `cwd`.
    fn codex(
        &mut self,
        store: &[OsString],
        query: &TranscriptQuery,
    ) -> FsResult<Vec<TranscriptFile>> {
        let mut base = store.to_vec();
        base.push(OsString::from("sessions"));
        self.searched.push(self.display(&base));
        let matcher = match (&query.conversation_id, &query.cwd) {
            (Some(id), _) => CodexMatch::Id {
                plain: format!("-{id}.jsonl"),
                compressed: format!("-{id}.jsonl.zst"),
            },
            (None, Some(_)) => CodexMatch::Cwd(
                self.cwds(query)
                    .iter()
                    .map(|cwd| cwd_needle(cwd))
                    .collect::<FsResult<_>>()?,
            ),
            (None, None) => return Ok(Vec::new()),
        };
        let mut found = Vec::new();
        if let Some(sessions) = self.open_optional_dir(&base)? {
            if self.codex_days(&sessions, &base, &matcher, &mut found)? {
                return Ok(found);
            }
        }
        self.codex_window_stores(&matcher, &mut found)?;
        Ok(found)
    }

    /// Rollouts a skilled window kept in its own `codex-home/sessions`,
    /// written before that directory became a link into the store: still
    /// this host's conversations, and nowhere else. A linked one is the store
    /// itself, already searched, and is not followed.
    fn codex_window_stores(
        &mut self,
        matcher: &CodexMatch,
        found: &mut Vec<TranscriptFile>,
    ) -> FsResult<()> {
        let Some(homes) = self
            .stores
            .window_homes
            .as_deref()
            .and_then(Path::to_str)
            .and_then(|path| self.files.relative_components(path).ok())
        else {
            return Ok(());
        };
        let Some(windows) = self.open_extra_dir(&homes)? else {
            return Ok(());
        };
        let mut names: Vec<OsString> = self
            .children(&windows)?
            .into_iter()
            .filter(|child| child.is_dir)
            .map(|child| child.name)
            .collect();
        names.sort();
        let mut looked = false;
        for name in names {
            let mut components = homes.clone();
            components.extend([
                name,
                OsString::from("codex-home"),
                OsString::from("sessions"),
            ]);
            let Some(sessions) = self.open_extra_dir(&components)? else {
                if self.truncated {
                    break;
                }
                continue;
            };
            if !looked {
                // One line for all of them: a host with many windows must
                // not spend the frame on where it looked.
                self.searched.push(self.display(&homes));
                looked = true;
            }
            if self.codex_days(&sessions, &components, matcher, found)? {
                break;
            }
        }
        Ok(())
    }

    /// One Codex `sessions` tree, newest day first. True once the search is
    /// over: the id found, the answer full, or the budget spent.
    fn codex_days(
        &mut self,
        sessions: &Dir,
        base: &[OsString],
        matcher: &CodexMatch,
        found: &mut Vec<TranscriptFile>,
    ) -> FsResult<bool> {
        for year in self.numbered_dirs(sessions)? {
            let Some(year_dir) = self.open_child_dir(sessions, &year)? else {
                if self.truncated {
                    return Ok(true);
                }
                continue;
            };
            for month in self.numbered_dirs(&year_dir)? {
                let Some(month_dir) = self.open_child_dir(&year_dir, &month)? else {
                    if self.truncated {
                        return Ok(true);
                    }
                    continue;
                };
                for day in self.numbered_dirs(&month_dir)? {
                    let Some(day_dir) = self.open_child_dir(&month_dir, &day)? else {
                        if self.truncated {
                            return Ok(true);
                        }
                        continue;
                    };
                    let mut components = base.to_vec();
                    components.extend([year.clone(), month.clone(), day.clone()]);
                    let mut names: Vec<OsString> = self
                        .children(&day_dir)?
                        .into_iter()
                        .filter(|child| {
                            child.is_file
                                && has_prefix(&child.name, "rollout-")
                                && (has_suffix(&child.name, ".jsonl")
                                    || has_suffix(&child.name, ".jsonl.zst"))
                        })
                        .map(|child| child.name)
                        .collect();
                    // The timestamp is in the name, so newest last; reversed
                    // is newest first.
                    names.sort();
                    names.reverse();
                    for name in names {
                        if !self.tick_file()? {
                            return Ok(true);
                        }
                        let matched = match matcher {
                            CodexMatch::Id { plain, compressed } => {
                                has_suffix(&name, plain) || has_suffix(&name, compressed)
                            }
                            CodexMatch::Cwd(needles) => {
                                has_suffix(&name, ".jsonl")
                                    && head_contains(&day_dir, &name, needles)
                            }
                        };
                        if !matched {
                            continue;
                        }
                        let conversation_id = codex_conversation_id(&name.to_string_lossy());
                        if let Some(file) = self.file_in(
                            &day_dir,
                            &components,
                            &name,
                            "conversation",
                            conversation_id,
                        )? {
                            found.push(file);
                        }
                        // An id names one file; a folder can name many.
                        if matches!(matcher, CodexMatch::Id { .. }) {
                            return Ok(true);
                        }
                        if found.len() >= MAX_TRANSCRIPTS {
                            self.truncated = true;
                            return Ok(true);
                        }
                    }
                }
            }
        }
        Ok(false)
    }

    /// The all-digit child directories of `dir`, newest (highest) first.
    fn numbered_dirs(&mut self, dir: &Dir) -> FsResult<Vec<OsString>> {
        let mut names: Vec<OsString> = self
            .children(dir)?
            .into_iter()
            .filter(|child| {
                child.is_dir
                    && child.name.to_str().is_some_and(|name| {
                        !name.is_empty() && name.bytes().all(|b| b.is_ascii_digit())
                    })
            })
            .map(|child| child.name)
            .collect();
        names.sort();
        names.reverse();
        Ok(names)
    }

    /// aider: `.aider.chat.history.md` and `.aider.input.history` in the
    /// folder it ran in and, inside a git repository, at the repository's
    /// root, where aider keeps them whichever subfolder it was started in.
    /// There is no id; the folder is the conversation.
    fn aider(&mut self, query: &TranscriptQuery) -> FsResult<Vec<TranscriptFile>> {
        let mut found = Vec::new();
        let Some(cwd) = &query.cwd else {
            return Ok(found);
        };
        let components = match self.files.relative_components(cwd) {
            Ok(components) => components,
            Err(error) if error.code == "outside_root" || error.code == "traversal_rejected" => {
                // A folder outside home is one no `fs.read` could reach either.
                self.searched.push(cwd.clone());
                return Ok(found);
            }
            Err(error) => return Err(error),
        };
        self.searched.push(self.display(&components));
        let Some(dir) = self.open_optional_dir(&components)? else {
            return Ok(found);
        };
        self.aider_files(&dir, &components, &mut found)?;
        if let Some((root, root_components)) = self.git_root(&components)? {
            if root_components != components {
                self.searched.push(self.display(&root_components));
                self.aider_files(&root, &root_components, &mut found)?;
            }
        }
        Ok(found)
    }

    fn aider_files(
        &mut self,
        dir: &Dir,
        components: &[OsString],
        found: &mut Vec<TranscriptFile>,
    ) -> FsResult<()> {
        for (name, role) in [
            (".aider.chat.history.md", "conversation"),
            (".aider.input.history", "input"),
        ] {
            if let Some(file) = self.file_in(dir, components, OsStr::new(name), role, None)? {
                found.push(file);
            }
        }
        Ok(())
    }

    /// The nearest folder at or above `components`, within home, that holds
    /// a `.git` (a directory, or the file a worktree or submodule has).
    fn git_root(&mut self, components: &[OsString]) -> FsResult<Option<(Dir, Vec<OsString>)>> {
        for depth in (0..=components.len()).rev() {
            let ancestor = &components[..depth];
            let Some(dir) = self.open_optional_dir(ancestor)? else {
                return Ok(None);
            };
            if dir.symlink_metadata(".git").is_ok() {
                return Ok(Some((dir, ancestor.to_vec())));
            }
        }
        Ok(None)
    }
}

/// How a record names the folder it was opened in: Codex's `session_meta`
/// and every Claude Code message line carry `"cwd":"<path>"`.
fn cwd_needle(cwd: &str) -> FsResult<String> {
    Ok(format!(
        "\"cwd\":{}",
        serde_json::to_string(cwd).map_err(|error| FsError::new(
            "invalid_path",
            format!("working directory is not encodable: {error}")
        ))?
    ))
}

/// The folder `cwd` with every link on the way resolved: the name Claude
/// Code computes its project folder from (`realpathSync(process.cwd())`), and
/// the `cwd` Codex records. Only a name: resolving it reads link targets,
/// never contents, nothing is opened through it, and every search still goes
/// through the file capability.
fn real_folder(cwd: &str) -> Option<String> {
    if !Path::new(cwd).is_absolute() {
        return None;
    }
    let real = std::fs::canonicalize(cwd).ok()?;
    #[cfg(windows)]
    let real = crate::host_files::windows_wire_path(&real);
    real.into_os_string().into_string().ok()
}

/// Whether the first `HEAD_BYTES` of a file contain any of `needles`. A file
/// that cannot be opened simply does not match: one unreadable record must
/// not end the search for the rest.
fn head_contains(dir: &Dir, name: &OsStr, needles: &[String]) -> bool {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let Ok(file) = dir.open_with(name, &options) else {
        return false;
    };
    let mut head = Vec::with_capacity(HEAD_BYTES);
    if file
        .into_std()
        .take(HEAD_BYTES as u64)
        .read_to_end(&mut head)
        .is_err()
    {
        return false;
    }
    let head = String::from_utf8_lossy(&head);
    needles.iter().any(|needle| head.contains(needle.as_str()))
}

/// A helper's record or its metadata (`agent-<n>.jsonl`, `agent-<n>.meta.json`).
fn is_helper_record(name: &OsStr) -> bool {
    has_suffix(name, ".jsonl") || has_suffix(name, ".json")
}

fn any_name(_: &OsStr) -> bool {
    true
}

fn has_suffix(name: &OsStr, suffix: &str) -> bool {
    name.to_str().is_some_and(|name| name.ends_with(suffix))
}

fn has_prefix(name: &OsStr, prefix: &str) -> bool {
    name.to_str().is_some_and(|name| name.starts_with(prefix))
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::AtomicBool;

    use super::*;

    /// The stores every agent defaults to, whatever the environment running
    /// the tests says.
    async fn locate(root: &Path, query: TranscriptQuery) -> TranscriptReport {
        locate_in(root, AgentStores::default(), query).await
    }

    async fn locate_in(
        root: &Path,
        stores: AgentStores,
        query: TranscriptQuery,
    ) -> TranscriptReport {
        let service = HostFileService::rooted_at(root).await.unwrap();
        locate_with_stores(
            &service,
            query,
            Some(stores),
            HostFileOperations::new(Arc::new(AtomicBool::new(false))),
        )
        .await
        .unwrap()
    }

    fn names(report: &TranscriptReport) -> Vec<(&str, &str)> {
        report
            .transcripts
            .iter()
            .map(|file| (file.role, file.name.as_str()))
            .collect()
    }

    fn query(kind: &str, id: Option<&str>, cwd: Option<&str>) -> TranscriptQuery {
        TranscriptQuery {
            agent_kind: kind.to_string(),
            conversation_id: id.map(str::to_string),
            cwd: cwd.map(str::to_string),
        }
    }

    fn write(path: &Path, body: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    /// The home every display path starts with: the root as the service
    /// itself names it (canonical, and on Windows without the `\\?\`
    /// prefix a canonicalized path carries).
    async fn home(temp: &tempfile::TempDir) -> PathBuf {
        PathBuf::from(
            HostFileService::rooted_at(temp.path())
                .await
                .unwrap()
                .home_dir(),
        )
    }

    fn set_modified(path: &Path, when: std::time::SystemTime) {
        std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(when)
            .unwrap();
    }

    #[test]
    fn conversation_ids_follow_the_server_pattern_and_never_name_a_parent() {
        assert!(valid_conversation_id(
            "45171e5a-5951-4d38-81e5-e1c0f9639d80"
        ));
        assert!(valid_conversation_id("thread_1:a.b"));
        assert!(!valid_conversation_id(""));
        assert!(!valid_conversation_id(".."));
        assert!(!valid_conversation_id("."));
        assert!(!valid_conversation_id("a/b"));
        assert!(!valid_conversation_id("a\\b"));
        assert!(!valid_conversation_id(&"x".repeat(65)));
    }

    #[test]
    fn claude_folders_dash_everything_but_letters_and_digits() {
        assert_eq!(
            claude_project_folder("/home/oem/projects/spawn"),
            "-home-oem-projects-spawn"
        );
        assert_eq!(
            claude_project_folder("/home/me/Server.Company_Insights"),
            "-home-me-Server-Company-Insights"
        );
        assert_eq!(claude_project_folder(r"C:\Users\me"), "C--Users-me");
    }

    #[test]
    fn claude_folders_match_claude_codes_own_rule_byte_for_byte() {
        let vectors: serde_json::Value =
            serde_json::from_str(include_str!("../../proto/claude-project-folder.json")).unwrap();
        assert_eq!(
            vectors["max_units"].as_u64(),
            Some(CLAUDE_FOLDER_UNITS as u64)
        );
        let cases = vectors["cases"].as_array().unwrap();
        assert!(cases.len() >= 20);
        for case in cases {
            let cwd = case["cwd"].as_str().unwrap();
            assert_eq!(
                claude_project_folder(cwd),
                case["folder"].as_str().unwrap(),
                "{}",
                case["name"]
            );
            if let Some(expected) = case["java_hash"].as_i64() {
                let hash = cwd.encode_utf16().fold(0_i32, |hash, unit| {
                    hash.wrapping_mul(31).wrapping_add(i32::from(unit))
                });
                assert_eq!(i64::from(hash), expected, "{}", case["name"]);
            }
        }
    }

    #[test]
    fn codex_ids_come_after_the_timestamp() {
        assert_eq!(
            codex_conversation_id(
                "rollout-2026-09-17T10-12-44-01a0aeda-b62e-7681-a475-3e513e9aafd9.jsonl"
            )
            .as_deref(),
            Some("01a0aeda-b62e-7681-a475-3e513e9aafd9")
        );
        assert_eq!(
            codex_conversation_id("rollout-2026-09-17T10-12-44-.jsonl"),
            None
        );
        assert_eq!(codex_conversation_id("notes.jsonl"), None);
        assert_eq!(
            codex_conversation_id(
                "rollout-2026-09-17T10-12-44-01a0aeda-b62e-7681-a475-3e513e9aafd9.jsonl.zst"
            )
            .as_deref(),
            Some("01a0aeda-b62e-7681-a475-3e513e9aafd9")
        );
    }

    #[tokio::test]
    async fn claude_conversation_is_found_by_id_with_its_subagents_launch_folder_first() {
        let temp = tempfile::tempdir().unwrap();
        let home = home(&temp).await;
        let id = "45171e5a-5951-4d38-81e5-e1c0f9639d80";
        let cwd = home.join("proj");
        let folder = claude_project_folder(&cwd.to_string_lossy());
        let projects = home.join(".claude").join("projects");
        // The same id filed under two folders: the launch folder answers first.
        write(
            &projects.join("-elsewhere").join(format!("{id}.jsonl")),
            b"{}\n",
        );
        write(
            &projects.join(&folder).join(format!("{id}.jsonl")),
            b"{}\n{}\n",
        );
        write(
            &projects
                .join(&folder)
                .join(id)
                .join("subagents")
                .join("agent-b.jsonl"),
            b"{}\n",
        );
        write(
            &projects
                .join(&folder)
                .join(id)
                .join("subagents")
                .join("agent-a.jsonl"),
            b"{}\n",
        );
        write(
            &projects
                .join(&folder)
                .join(id)
                .join("subagents")
                .join("agent-a.meta.json"),
            b"{}",
        );
        // A different conversation in the same folder is not this one.
        write(&projects.join(&folder).join("other.jsonl"), b"{}\n");

        let report = locate(
            temp.path(),
            query("claude-code", Some(id), Some(&cwd.to_string_lossy())),
        )
        .await;
        assert!(report.supported);
        assert!(!report.truncated);
        // Both records before either sidecar; a helper's metadata beside its
        // record.
        assert_eq!(
            names(&report),
            vec![
                ("conversation", "45171e5a-5951-4d38-81e5-e1c0f9639d80.jsonl"),
                ("conversation", "45171e5a-5951-4d38-81e5-e1c0f9639d80.jsonl"),
                ("subagent", "agent-a.jsonl"),
                ("subagent", "agent-a.meta.json"),
                ("subagent", "agent-b.jsonl"),
            ]
        );
        assert!(report.transcripts[1].path.contains("-elsewhere"));
        assert_eq!(
            report.transcripts[0].path,
            projects
                .join(&folder)
                .join(format!("{id}.jsonl"))
                .to_string_lossy()
        );
        assert_eq!(report.transcripts[0].size, 6);
        assert_eq!(report.transcripts[0].conversation_id.as_deref(), Some(id));
        assert_eq!(
            report.searched,
            vec![projects.to_string_lossy().into_owned()]
        );
    }

    #[tokio::test]
    async fn claude_without_an_id_lists_the_launch_folders_conversations_newest_first() {
        let temp = tempfile::tempdir().unwrap();
        let home = home(&temp).await;
        let cwd = home.join("proj");
        let folder = claude_project_folder(&cwd.to_string_lossy());
        let project = home.join(".claude").join("projects").join(&folder);
        write(&project.join("older.jsonl"), b"{}\n");
        write(&project.join("agent-side.jsonl"), b"{}\n");
        write(&project.join("newer.jsonl"), b"{}\n");
        let old = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        set_modified(&project.join("older.jsonl"), old);
        set_modified(
            &project.join("agent-side.jsonl"),
            old + std::time::Duration::from_secs(10),
        );
        std::fs::create_dir_all(project.join("a-directory.jsonl")).unwrap();

        let report = locate(
            temp.path(),
            query("claude-code", None, Some(&cwd.to_string_lossy())),
        )
        .await;
        let described: Vec<(&str, &str, Option<&str>)> = report
            .transcripts
            .iter()
            .map(|file| {
                (
                    file.role,
                    file.name.as_str(),
                    file.conversation_id.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            described,
            vec![
                ("conversation", "newer.jsonl", Some("newer")),
                ("subagent", "agent-side.jsonl", None),
                ("conversation", "older.jsonl", Some("older")),
            ]
        );
        assert_eq!(
            report.searched,
            vec![project.to_string_lossy().into_owned()]
        );
    }

    #[tokio::test]
    async fn claude_answers_empty_where_nothing_was_ever_written() {
        let temp = tempfile::tempdir().unwrap();
        let report = locate(
            temp.path(),
            query("claude-code", Some("abc"), Some("/nowhere/at/all")),
        )
        .await;
        assert!(report.supported);
        assert!(report.transcripts.is_empty());
        assert_eq!(report.searched.len(), 1);
    }

    #[tokio::test]
    async fn codex_rollout_is_found_by_id_across_dated_folders() {
        let temp = tempfile::tempdir().unwrap();
        let home = home(&temp).await;
        let sessions = home.join(".codex").join("sessions");
        let id = "01a0aeda-b62e-7681-a475-3e513e9aafd9";
        write(
            &sessions
                .join("2026/09/17")
                .join(format!("rollout-2026-09-17T10-12-44-{id}.jsonl")),
            b"{\"type\":\"session_meta\"}\n",
        );
        write(
            &sessions
                .join("2026/09/18")
                .join("rollout-2026-09-18T01-00-00-ffffffff-0000-0000-0000-000000000000.jsonl"),
            b"{}\n",
        );
        let report = locate(temp.path(), query("codex", Some(id), None)).await;
        assert_eq!(report.transcripts.len(), 1);
        assert_eq!(report.transcripts[0].role, "conversation");
        assert_eq!(report.transcripts[0].conversation_id.as_deref(), Some(id));
        assert!(report.transcripts[0]
            .path
            .ends_with(&format!("rollout-2026-09-17T10-12-44-{id}.jsonl")));
        assert_eq!(
            report.searched,
            vec![sessions.to_string_lossy().into_owned()]
        );
    }

    #[tokio::test]
    async fn codex_rollouts_without_an_id_are_the_ones_opened_in_the_folder_newest_first() {
        let temp = tempfile::tempdir().unwrap();
        let home = home(&temp).await;
        let sessions = home.join(".codex").join("sessions");
        let here = "/home/me/proj";
        let meta = |cwd: &str| {
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"cwd\":{}}}}}\n{{}}\n",
                serde_json::to_string(cwd).unwrap()
            )
        };
        write(
            &sessions
                .join("2026/09/17")
                .join("rollout-2026-09-17T10-12-44-01a0aeda-b62e-7681-a475-3e513e9aafd9.jsonl"),
            meta(here).as_bytes(),
        );
        write(
            &sessions
                .join("2026/09/17")
                .join("rollout-2026-09-17T09-49-34-01a0aec5-82ea-79e1-a933-49b8049810ca.jsonl"),
            meta("/home/me/proj-two").as_bytes(),
        );
        write(
            &sessions
                .join("2026/08/09")
                .join("rollout-2026-08-09T08-59-57-01a08565-3382-7bd3-9743-0176e44cd4e3.jsonl"),
            meta(here).as_bytes(),
        );
        write(
            &sessions.join("2026/08/09").join("notes.txt"),
            b"not a rollout",
        );
        write(&sessions.join("stray.jsonl"), meta(here).as_bytes());

        let report = locate(temp.path(), query("codex", None, Some(here))).await;
        let names: Vec<&str> = report
            .transcripts
            .iter()
            .map(|file| file.name.as_str())
            .collect();
        assert_eq!(
            names,
            vec![
                "rollout-2026-09-17T10-12-44-01a0aeda-b62e-7681-a475-3e513e9aafd9.jsonl",
                "rollout-2026-08-09T08-59-57-01a08565-3382-7bd3-9743-0176e44cd4e3.jsonl",
            ]
        );
        assert_eq!(
            report.transcripts[1].conversation_id.as_deref(),
            Some("01a08565-3382-7bd3-9743-0176e44cd4e3")
        );
        assert!(!report.truncated);
    }

    #[tokio::test]
    async fn codex_with_neither_id_nor_folder_has_nothing_to_go_on() {
        let temp = tempfile::tempdir().unwrap();
        write(
            &home(&temp).await.join(".codex/sessions/2026/09/17/rollout-2026-09-17T10-12-44-01a0aeda-b62e-7681-a475-3e513e9aafd9.jsonl"),
            b"{}\n",
        );
        let report = locate(temp.path(), query("codex", None, None)).await;
        assert!(report.supported);
        assert!(report.transcripts.is_empty());
    }

    #[tokio::test]
    async fn aider_history_lives_in_the_folder_it_ran_in() {
        let temp = tempfile::tempdir().unwrap();
        let home = home(&temp).await;
        let cwd = home.join("proj");
        write(&cwd.join(".aider.chat.history.md"), b"# chat\n");
        write(&cwd.join(".aider.input.history"), b"+ hello\n");
        let report = locate(
            temp.path(),
            query("aider", None, Some(&cwd.to_string_lossy())),
        )
        .await;
        let described: Vec<(&str, &str)> = report
            .transcripts
            .iter()
            .map(|file| (file.role, file.name.as_str()))
            .collect();
        assert_eq!(
            described,
            vec![
                ("conversation", ".aider.chat.history.md"),
                ("input", ".aider.input.history"),
            ]
        );
        assert_eq!(report.searched, vec![cwd.to_string_lossy().into_owned()]);

        // A folder outside home is beyond the file capability, so there is
        // nothing to find and nothing to fail on. (`/definitely/outside` is
        // only absolute on Unix; on Windows it would name a folder in home.)
        #[cfg(unix)]
        {
            let outside = locate(
                temp.path(),
                query("aider", None, Some("/definitely/outside")),
            )
            .await;
            assert!(outside.transcripts.is_empty());
            assert_eq!(outside.searched, vec!["/definitely/outside".to_string()]);
        }
    }

    #[tokio::test]
    async fn an_unknown_harness_is_reported_as_unsupported_not_empty() {
        let temp = tempfile::tempdir().unwrap();
        let report = locate(temp.path(), query("opencode", None, Some("/home/me"))).await;
        assert!(!report.supported);
        assert!(report.transcripts.is_empty());
        assert!(report.searched.is_empty());
    }

    #[tokio::test]
    async fn a_conversation_id_that_could_name_a_parent_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        let service = HostFileService::rooted_at(temp.path()).await.unwrap();
        let error = locate_in_session(
            &service,
            query("claude-code", Some(".."), None),
            HostFileOperations::new(Arc::new(AtomicBool::new(false))),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "invalid_request");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_linked_project_folder_or_transcript_is_never_followed() {
        let temp = tempfile::tempdir().unwrap();
        let home = home(&temp).await;
        let id = "abc-123";
        let outside = temp.path().join("outside");
        write(&outside.join(format!("{id}.jsonl")), b"secret\n");
        let projects = home.join(".claude").join("projects");
        std::fs::create_dir_all(&projects).unwrap();
        std::os::unix::fs::symlink(&outside, projects.join("linked-folder")).unwrap();
        std::fs::create_dir_all(projects.join("real-folder")).unwrap();
        std::os::unix::fs::symlink(
            outside.join(format!("{id}.jsonl")),
            projects.join("real-folder").join(format!("{id}.jsonl")),
        )
        .unwrap();
        let report = locate(temp.path(), query("claude-code", Some(id), None)).await;
        assert!(report.transcripts.is_empty());
    }

    #[tokio::test]
    async fn the_answer_is_bounded() {
        let temp = tempfile::tempdir().unwrap();
        let home = home(&temp).await;
        let cwd = home.join("proj");
        let project = home
            .join(".claude")
            .join("projects")
            .join(claude_project_folder(&cwd.to_string_lossy()));
        for index in 0..(MAX_TRANSCRIPTS + 5) {
            write(&project.join(format!("{index:03}.jsonl")), b"{}\n");
        }
        let report = locate(
            temp.path(),
            query("claude-code", None, Some(&cwd.to_string_lossy())),
        )
        .await;
        assert_eq!(report.transcripts.len(), MAX_TRANSCRIPTS);
        assert!(report.truncated);
    }

    #[tokio::test]
    async fn a_claude_sidecar_lists_helpers_workflows_and_spilled_output_after_the_record() {
        let temp = tempfile::tempdir().unwrap();
        let home = home(&temp).await;
        let id = "acc62a59-dd15-4c71-a8e1-5469b722dbd6";
        let cwd = home.join("proj");
        let project = home
            .join(".claude")
            .join("projects")
            .join(claude_project_folder(&cwd.to_string_lossy()));
        let side = project.join(id);
        write(&project.join(format!("{id}.jsonl")), b"{}\n");
        write(&side.join("subagents/agent-a1.jsonl"), b"{}\n");
        write(&side.join("subagents/agent-a1.meta.json"), b"{}");
        write(&side.join("subagents/notes.txt"), b"not a helper");
        write(
            &side.join("subagents/workflows/wf_0aa1/agent-b2.jsonl"),
            b"{}\n",
        );
        write(
            &side.join("subagents/workflows/wf_0aa1/agent-b2.meta.json"),
            b"{}",
        );
        write(&side.join("workflows/wf_0aa1.json"), b"{}");
        write(&side.join("workflows/scripts/review-wf_0aa1.js"), b"//");
        write(&side.join("tool-results/toolu_01.txt"), b"long output");
        let report = locate(
            temp.path(),
            query("claude-code", Some(id), Some(&cwd.to_string_lossy())),
        )
        .await;
        assert_eq!(
            names(&report),
            vec![
                ("conversation", "acc62a59-dd15-4c71-a8e1-5469b722dbd6.jsonl"),
                ("subagent", "agent-a1.jsonl"),
                ("subagent", "agent-a1.meta.json"),
                ("subagent", "agent-b2.jsonl"),
                ("subagent", "agent-b2.meta.json"),
                ("subagent", "wf_0aa1.json"),
                ("subagent", "review-wf_0aa1.js"),
                ("conversation", "toolu_01.txt"),
            ]
        );
        assert!(report
            .transcripts
            .iter()
            .all(|file| file.conversation_id.as_deref() == Some(id)));
        assert_eq!(
            report.transcripts[3].path,
            side.join("subagents")
                .join("workflows")
                .join("wf_0aa1")
                .join("agent-b2.jsonl")
                .to_string_lossy()
        );
        assert!(!report.truncated);
    }

    #[tokio::test]
    async fn a_sidecar_too_big_for_one_answer_keeps_the_record_and_says_truncated() {
        let temp = tempfile::tempdir().unwrap();
        let home = home(&temp).await;
        let id = "big-sidecar";
        let cwd = home.join("proj");
        let project = home
            .join(".claude")
            .join("projects")
            .join(claude_project_folder(&cwd.to_string_lossy()));
        write(&project.join(format!("{id}.jsonl")), b"{}\n");
        for index in 0..(MAX_TRANSCRIPTS * 3) {
            write(
                &project
                    .join(id)
                    .join("tool-results")
                    .join(format!("{index:03}.txt")),
                b"x",
            );
        }
        let report = locate(
            temp.path(),
            query("claude-code", Some(id), Some(&cwd.to_string_lossy())),
        )
        .await;
        assert_eq!(report.transcripts.len(), MAX_TRANSCRIPTS);
        assert!(report.truncated);
        assert_eq!(report.transcripts[0].name, "big-sidecar.jsonl");
    }

    #[tokio::test]
    async fn claude_records_are_found_in_the_store_claude_config_dir_names() {
        let temp = tempfile::tempdir().unwrap();
        let home = home(&temp).await;
        let id = "abc-123";
        let store = home.join("work-claude");
        write(
            &store.join("projects/-anywhere").join(format!("{id}.jsonl")),
            b"{}\n",
        );
        // The default store holds a different copy; it is not where this
        // daemon's agents write.
        write(
            &home
                .join(".claude/projects/-anywhere")
                .join(format!("{id}.jsonl")),
            b"{}\n{}\n",
        );
        let stores = AgentStores {
            claude_config_dir: Some(store.clone()),
            ..AgentStores::default()
        };
        let report = locate_in(temp.path(), stores, query("claude-code", Some(id), None)).await;
        assert!(report.supported);
        assert_eq!(report.transcripts.len(), 1);
        assert_eq!(report.transcripts[0].size, 3);
        assert_eq!(
            report.searched,
            vec![store.join("projects").to_string_lossy().into_owned()]
        );
    }

    #[tokio::test]
    async fn a_store_outside_home_is_unsupported_not_searched() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        write(&outside.path().join("projects/-x/abc.jsonl"), b"{}\n");
        for kind in ["claude-code", "codex"] {
            let stores = AgentStores {
                claude_config_dir: Some(outside.path().to_path_buf()),
                codex_home: Some(outside.path().to_path_buf()),
                ..AgentStores::default()
            };
            let report = locate_in(temp.path(), stores, query(kind, Some("abc"), None)).await;
            assert!(!report.supported, "{kind}");
            assert!(report.transcripts.is_empty(), "{kind}");
            assert_eq!(
                report.searched,
                vec![outside.path().to_string_lossy().into_owned()],
                "{kind}"
            );
        }
        // A relative store is no place at all.
        let stores = AgentStores {
            claude_config_dir: Some(PathBuf::from("relative/claude")),
            ..AgentStores::default()
        };
        let report = locate_in(temp.path(), stores, query("claude-code", Some("abc"), None)).await;
        assert!(!report.supported);
    }

    #[tokio::test]
    async fn a_tilde_cwd_is_the_hosts_home() {
        let temp = tempfile::tempdir().unwrap();
        let home = home(&temp).await;
        let project = home
            .join(".claude")
            .join("projects")
            .join(claude_project_folder(&home.join("proj").to_string_lossy()));
        write(&project.join("one.jsonl"), b"{}\n");
        let report = locate(temp.path(), query("claude-code", None, Some("~/proj"))).await;
        assert_eq!(names(&report), vec![("conversation", "one.jsonl")]);

        let sessions = home.join(".codex").join("sessions").join("2026/09/17");
        write(
            &sessions
                .join("rollout-2026-09-17T10-12-44-01a0aeda-b62e-7681-a475-3e513e9aafd9.jsonl"),
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"cwd\":{}}}}}\n",
                serde_json::to_string(&home.to_string_lossy()).unwrap()
            )
            .as_bytes(),
        );
        let report = locate(temp.path(), query("codex", None, Some("~"))).await;
        assert_eq!(report.transcripts.len(), 1);
    }

    #[tokio::test]
    async fn a_long_folder_is_found_by_its_hashed_name_and_by_another_hash_of_the_same_cwd() {
        let temp = tempfile::tempdir().unwrap();
        let home = home(&temp).await;
        let cwd = home.join("x".repeat(120)).join("y".repeat(120));
        let cwd = cwd.to_string_lossy().into_owned();
        let folder = claude_project_folder(&cwd);
        assert!(folder.len() > CLAUDE_FOLDER_UNITS);
        let projects = home.join(".claude").join("projects");
        write(&projects.join(&folder).join("current.jsonl"), b"{}\n");
        let line = |cwd: &str| {
            format!(
                "{{\"type\":\"user\",\"cwd\":{},\"message\":{{}}}}\n",
                serde_json::to_string(cwd).unwrap()
            )
        };
        // Same 200-unit cut, another hash: filed by a Claude Code that hashed
        // differently, for this cwd...
        let cut = &folder[..CLAUDE_FOLDER_UNITS];
        write(
            &projects.join(format!("{cut}-oldhash")).join("older.jsonl"),
            line(&cwd).as_bytes(),
        );
        // ...and one for a different cwd that happens to share the cut.
        write(
            &projects
                .join(format!("{cut}-otherhash"))
                .join("stranger.jsonl"),
            line(&format!("{cwd}-sibling")).as_bytes(),
        );
        let report = locate(temp.path(), query("claude-code", None, Some(&cwd))).await;
        let mut found: Vec<&str> = report
            .transcripts
            .iter()
            .map(|file| file.name.as_str())
            .collect();
        found.sort();
        assert_eq!(found, vec!["current.jsonl", "older.jsonl"]);
        assert_eq!(report.searched.len(), 2);
    }

    #[tokio::test]
    async fn codex_rollouts_are_found_in_the_store_codex_home_names_compressed_or_not() {
        let temp = tempfile::tempdir().unwrap();
        let home = home(&temp).await;
        let store = home.join("codex-alt");
        let id = "01a0aeda-b62e-7681-a475-3e513e9aafd9";
        let day = store.join("sessions/2026/09/01");
        write(
            &day.join(format!("rollout-2026-09-01T10-12-44-{id}.jsonl.zst")),
            b"\x28\xb5\x2f\xfd",
        );
        let stores = AgentStores {
            codex_home: Some(store.clone()),
            ..AgentStores::default()
        };
        let report = locate_in(temp.path(), stores, query("codex", Some(id), None)).await;
        assert_eq!(report.transcripts.len(), 1);
        assert_eq!(report.transcripts[0].conversation_id.as_deref(), Some(id));
        assert!(report.transcripts[0].name.ends_with(".jsonl.zst"));
        assert_eq!(
            report.searched,
            vec![store.join("sessions").to_string_lossy().into_owned()]
        );

        // A compressed rollout cannot be read for its folder, so a folder
        // search passes over it rather than guessing.
        let stores = AgentStores {
            codex_home: Some(store),
            ..AgentStores::default()
        };
        let report = locate_in(temp.path(), stores, query("codex", None, Some("/home/me"))).await;
        assert!(report.transcripts.is_empty());
    }

    #[tokio::test]
    async fn codex_rollouts_a_window_kept_in_its_own_codex_home_are_found_too() {
        let temp = tempfile::tempdir().unwrap();
        let home = home(&temp).await;
        let homes = home.join(".config/spawn/sessions");
        let id = "01a0aec5-82ea-79e1-a933-49b8049810ca";
        let window = homes.join("2b1c5b7e-0000-4000-8000-000000000001");
        write(
            &window
                .join("codex-home/sessions/2026/08/30")
                .join(format!("rollout-2026-08-30T08-00-00-{id}.jsonl")),
            b"{}\n",
        );
        // A window with no Codex conversation of its own is passed over.
        std::fs::create_dir_all(homes.join("3c2d6c8f-0000-4000-8000-000000000002/skills")).unwrap();
        let stores = AgentStores {
            window_homes: Some(homes.clone()),
            ..AgentStores::default()
        };
        let report = locate_in(temp.path(), stores, query("codex", Some(id), None)).await;
        assert_eq!(report.transcripts.len(), 1);
        assert!(report.transcripts[0].path.contains("codex-home"));
        assert_eq!(
            report.searched,
            vec![
                home.join(".codex/sessions").to_string_lossy().into_owned(),
                homes.to_string_lossy().into_owned(),
            ]
        );

        // The store itself answers first, and ends an id search there.
        write(
            &home
                .join(".codex/sessions/2026/09/02")
                .join(format!("rollout-2026-09-02T08-00-00-{id}.jsonl")),
            b"{}\n",
        );
        let stores = AgentStores {
            window_homes: Some(homes),
            ..AgentStores::default()
        };
        let report = locate_in(temp.path(), stores, query("codex", Some(id), None)).await;
        assert_eq!(report.transcripts.len(), 1);
        assert!(!report.transcripts[0].path.contains("codex-home"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_window_codex_home_linked_into_the_store_is_not_searched_twice() {
        let temp = tempfile::tempdir().unwrap();
        let home = home(&temp).await;
        let store = home.join(".codex/sessions");
        let here = "/home/me/proj";
        write(
            &store
                .join("2026/09/17")
                .join("rollout-2026-09-17T10-12-44-01a0aeda-b62e-7681-a475-3e513e9aafd9.jsonl"),
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"cwd\":{}}}}}\n",
                serde_json::to_string(here).unwrap()
            )
            .as_bytes(),
        );
        let homes = home.join(".config/spawn/sessions");
        let codex_home = homes.join("2b1c5b7e-0000-4000-8000-000000000001/codex-home");
        std::fs::create_dir_all(&codex_home).unwrap();
        std::os::unix::fs::symlink(&store, codex_home.join("sessions")).unwrap();
        let stores = AgentStores {
            window_homes: Some(homes),
            ..AgentStores::default()
        };
        let report = locate_in(temp.path(), stores, query("codex", None, Some(here))).await;
        assert_eq!(report.transcripts.len(), 1);
        assert_eq!(report.searched, vec![store.to_string_lossy().into_owned()]);
    }

    #[tokio::test]
    async fn aider_history_at_the_repository_root_is_found_from_a_subfolder() {
        let temp = tempfile::tempdir().unwrap();
        let home = home(&temp).await;
        let repo = home.join("repo");
        let cwd = repo.join("packages").join("web");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();
        write(&repo.join(".aider.chat.history.md"), b"# chat\n");
        write(&repo.join(".aider.input.history"), b"+ hi\n");
        let report = locate(
            temp.path(),
            query("aider", None, Some(&cwd.to_string_lossy())),
        )
        .await;
        assert_eq!(
            names(&report),
            vec![
                ("conversation", ".aider.chat.history.md"),
                ("input", ".aider.input.history"),
            ]
        );
        assert_eq!(
            report.searched,
            vec![
                cwd.to_string_lossy().into_owned(),
                repo.to_string_lossy().into_owned(),
            ]
        );
        assert!(report.transcripts[0].path.ends_with(&format!(
            "repo{}.aider.chat.history.md",
            std::path::MAIN_SEPARATOR
        )));

        // A worktree's `.git` is a file; it marks the root all the same, and
        // history in the folder itself comes first.
        let worktree = home.join("worktree");
        let sub = worktree.join("src");
        write(
            &worktree.join(".git"),
            b"gitdir: ../repo/.git/worktrees/w\n",
        );
        write(&sub.join(".aider.chat.history.md"), b"# here\n");
        write(&worktree.join(".aider.chat.history.md"), b"# root\n");
        let report = locate(
            temp.path(),
            query("aider", None, Some(&sub.to_string_lossy())),
        )
        .await;
        assert_eq!(report.transcripts.len(), 2);
        assert_eq!(report.transcripts[0].size, 7);
        assert_eq!(report.transcripts[1].size, 7);
        assert!(report.transcripts[0].path.contains("src"));
    }

    #[test]
    fn a_codex_home_inside_spawnds_window_homes_is_not_the_users_store() {
        let homes = Path::new("/home/me/.config/spawn/sessions");
        let window = homes.join("2b1c5b7e-0000-4000-8000-000000000001/codex-home");
        assert_eq!(users_codex_home(Some(window), Some(homes)), None);
        assert_eq!(
            users_codex_home(Some(PathBuf::from("/srv/codex")), Some(homes)),
            Some(PathBuf::from("/srv/codex"))
        );
        assert_eq!(users_codex_home(None, Some(homes)), None);
    }

    /// A daemon started from a skilled window's terminal inherits that
    /// window's `CODEX_HOME`, whose `sessions` links into the user's store.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_daemon_started_in_a_skilled_window_still_finds_codex_rollouts() {
        let temp = tempfile::tempdir().unwrap();
        let home = home(&temp).await;
        let homes = home.join(".config/spawn/sessions");
        let window = homes.join("2b1c5b7e-0000-4000-8000-000000000001/codex-home");
        let id = "01a0aeda-b62e-7681-a475-3e513e9aafd9";
        write(
            &home
                .join(".codex/sessions/2026/10/03")
                .join(format!("rollout-2026-10-03T10-00-00-{id}.jsonl")),
            b"{}\n",
        );
        std::fs::create_dir_all(&window).unwrap();
        std::os::unix::fs::symlink(home.join(".codex/sessions"), window.join("sessions")).unwrap();
        let stores = AgentStores {
            codex_home: users_codex_home(Some(window), Some(&homes)),
            window_homes: Some(homes),
            ..AgentStores::default()
        };
        let report = locate_in(temp.path(), stores, query("codex", Some(id), None)).await;
        assert!(report.supported);
        assert_eq!(report.transcripts.len(), 1);
        assert_eq!(report.transcripts[0].conversation_id.as_deref(), Some(id));
    }

    /// Claude Code and Codex name a window opened through a link by the
    /// link's target.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_window_opened_through_a_link_is_found_under_its_real_folder() {
        let temp = tempfile::tempdir().unwrap();
        let home = home(&temp).await;
        let real = home.join("data").join("work");
        std::fs::create_dir_all(&real).unwrap();
        let linked = home.join("work");
        std::os::unix::fs::symlink(&real, &linked).unwrap();
        let real_project = home
            .join(".claude/projects")
            .join(claude_project_folder(&real.to_string_lossy()));
        write(&real_project.join("one.jsonl"), b"{}\n");
        let as_given = home
            .join(".claude/projects")
            .join(claude_project_folder(&linked.to_string_lossy()));

        let report = locate(
            temp.path(),
            query("claude-code", None, Some(&linked.to_string_lossy())),
        )
        .await;
        assert_eq!(names(&report), vec![("conversation", "one.jsonl")]);
        assert_eq!(
            report.searched,
            vec![
                real_project.to_string_lossy().into_owned(),
                as_given.to_string_lossy().into_owned(),
            ]
        );

        // By id, the real folder is checked first.
        write(&as_given.join("two.jsonl"), b"{}\n");
        write(&real_project.join("two.jsonl"), b"{}\n");
        let report = locate(
            temp.path(),
            query("claude-code", Some("two"), Some(&linked.to_string_lossy())),
        )
        .await;
        assert_eq!(report.transcripts.len(), 2);
        assert!(report.transcripts[0]
            .path
            .starts_with(&*real_project.to_string_lossy()));

        // A real folder that holds nothing is not named as searched.
        let empty_real = home.join("data").join("empty");
        std::fs::create_dir_all(&empty_real).unwrap();
        let empty_link = home.join("empty");
        std::os::unix::fs::symlink(&empty_real, &empty_link).unwrap();
        let report = locate(
            temp.path(),
            query("claude-code", None, Some(&empty_link.to_string_lossy())),
        )
        .await;
        assert!(report.transcripts.is_empty());
        assert_eq!(
            report.searched,
            vec![home
                .join(".claude/projects")
                .join(claude_project_folder(&empty_link.to_string_lossy()))
                .to_string_lossy()
                .into_owned()]
        );

        // Codex records the real folder as its cwd.
        write(
            &home
                .join(".codex/sessions/2026/10/03")
                .join("rollout-2026-10-03T10-00-00-01a0aeda-b62e-7681-a475-3e513e9aafd9.jsonl"),
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"cwd\":{}}}}}\n",
                serde_json::to_string(&real.to_string_lossy()).unwrap()
            )
            .as_bytes(),
        );
        let report = locate(
            temp.path(),
            query("codex", None, Some(&linked.to_string_lossy())),
        )
        .await;
        assert_eq!(report.transcripts.len(), 1);
    }
}
