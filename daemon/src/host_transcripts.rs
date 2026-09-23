//! Where an agent leaves its own record of a conversation, and how a device
//! asks for it.
//!
//! `agent.transcripts` answers with the files an agent harness wrote for one
//! window's conversation: Claude Code's `~/.claude/projects/<folder>/<id>.jsonl`
//! and the subagent records beside it, Codex's dated `rollout-*.jsonl` files,
//! aider's chat history in the working folder. The daemon only *locates*. The
//! device then reads each file with the ordinary `fs.read`, through the same
//! home-rooted, symlink-refusing capability every other read goes through, and
//! nothing about the content reaches the server (`docs/TRUST.md`). An agent
//! whose record lives somewhere the daemon cannot name — opencode keeps its
//! conversations in a database — answers `supported: false` rather than a
//! guess.
//!
//! Every search is bounded: so many directories opened, so many files looked
//! at, so many answers. A home directory with ten thousand Codex days in it
//! gets a truncated answer, never a stalled channel.

use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::sync::Arc;

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use serde::Serialize;

use crate::host_files::{
    cancelled_error, modified_seconds, FsError, FsResult, HostFileOperations, HostFileService,
    HostOperationKind,
};

/// Most files one answer names. Past this the answer says `truncated` and
/// keeps what it found first; the frame has 16 KiB to fit in.
pub(crate) const MAX_TRANSCRIPTS: usize = 24;
/// Directories one search opens before it stops looking.
const MAX_SCAN_DIRS: usize = 512;
/// Files one search examines before it stops looking.
const MAX_SCAN_FILES: usize = 2000;
/// Entries one directory listing reads before it stops.
const MAX_LISTED_ENTRIES: usize = 2048;
/// How much of a Codex rollout is read to learn which folder it was opened
/// in: the `session_meta` line comes first and names `cwd` near its start.
const CODEX_HEAD_BYTES: usize = 64 * 1024;

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
    /// `conversation` for the main record, `subagent` for a helper the
    /// conversation ran, `input` for a bare prompt history.
    pub role: &'static str,
    pub conversation_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct TranscriptReport {
    pub agent_kind: String,
    /// False when the daemon knows nothing about where this harness writes.
    pub supported: bool,
    pub transcripts: Vec<TranscriptFile>,
    /// Where the daemon looked, as display paths, so an empty answer can say.
    pub searched: Vec<String>,
    pub truncated: bool,
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

/// The folder Claude Code files a working directory under: every byte that
/// is not a letter or digit becomes a dash, so `/home/me/proj` is
/// `-home-me-proj` and `C:\Users\me` is `C--Users-me`.
pub(crate) fn claude_project_folder(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// The id at the end of a Codex rollout name:
/// `rollout-2026-09-17T10-12-44-<id>.jsonl`.
pub(crate) fn codex_conversation_id(name: &str) -> Option<String> {
    let rest = name.strip_prefix("rollout-")?.strip_suffix(".jsonl")?;
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
            locate_sync(&service, &query, operations)
        })
        .await
}

fn locate_sync(
    files: &HostFileService,
    query: &TranscriptQuery,
    operations: &HostFileOperations,
) -> FsResult<TranscriptReport> {
    let mut search = Search {
        files,
        operations,
        dirs_opened: 0,
        files_examined: 0,
        truncated: false,
        searched: Vec::new(),
    };
    let (supported, mut transcripts) = match query.agent_kind.as_str() {
        "claude-code" => (true, search.claude(query)?),
        "codex" => (true, search.codex(query)?),
        "aider" => (true, search.aider(query)?),
        _ => (false, Vec::new()),
    };
    if transcripts.len() > MAX_TRANSCRIPTS {
        transcripts.truncate(MAX_TRANSCRIPTS);
        search.truncated = true;
    }
    Ok(TranscriptReport {
        agent_kind: query.agent_kind.clone(),
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

struct Search<'a> {
    files: &'a HostFileService,
    operations: &'a HostFileOperations,
    dirs_opened: usize,
    files_examined: usize,
    truncated: bool,
    searched: Vec<String>,
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

    /// Claude Code: `~/.claude/projects/<folder>/<id>.jsonl`, with the helpers
    /// that conversation ran under `<id>/subagents/`. With an id, every
    /// project folder is checked — a conversation resumed from another folder
    /// continues in that folder's file — the launch folder first. Without one
    /// (an agent typed by hand), the launch folder's conversations, newest
    /// first.
    fn claude(&mut self, query: &TranscriptQuery) -> FsResult<Vec<TranscriptFile>> {
        let base = [OsString::from(".claude"), OsString::from("projects")];
        let preferred = query.cwd.as_deref().map(claude_project_folder);
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
                    .as_deref()
                    .is_none_or(|folder| name != OsStr::new(folder))
            });
            for folder in folders {
                let Some(project) = self.open_child_dir(&projects, &folder)? else {
                    if self.truncated {
                        break;
                    }
                    continue;
                };
                let components = [base[0].clone(), base[1].clone(), folder];
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
                if let Some(side) = self.open_child_dir(&project, OsStr::new(id))? {
                    if let Some(subagents) = self.open_child_dir(&side, OsStr::new("subagents"))? {
                        let mut components = components.to_vec();
                        components.push(OsString::from(id));
                        components.push(OsString::from("subagents"));
                        let mut names: Vec<OsString> = self
                            .children(&subagents)?
                            .into_iter()
                            .filter(|child| child.is_file && has_suffix(&child.name, ".jsonl"))
                            .map(|child| child.name)
                            .collect();
                        names.sort();
                        for name in names {
                            if let Some(file) = self.file_in(
                                &subagents,
                                &components,
                                &name,
                                "subagent",
                                Some(id.clone()),
                            )? {
                                found.push(file);
                            }
                        }
                    }
                }
            }
        } else if let Some(folder) = preferred {
            let components = [base[0].clone(), base[1].clone(), OsString::from(folder)];
            self.searched.push(self.display(&components));
            let Some(project) = self.open_optional_dir(&components)? else {
                return Ok(found);
            };
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
            found.sort_by(|a, b| b.modified_at.cmp(&a.modified_at).then(a.name.cmp(&b.name)));
        } else {
            self.searched.push(self.display(&base));
        }
        Ok(found)
    }

    /// Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl`,
    /// newest day first. Codex picks its own id, so a window rarely has one
    /// recorded; the rollouts opened in the window's folder stand in — each
    /// file's first line is its `session_meta` and names the `cwd`.
    fn codex(&mut self, query: &TranscriptQuery) -> FsResult<Vec<TranscriptFile>> {
        let base = [OsString::from(".codex"), OsString::from("sessions")];
        self.searched.push(self.display(&base));
        let suffix = query
            .conversation_id
            .as_ref()
            .map(|id| OsString::from(format!("-{id}.jsonl")));
        let needle = match (&suffix, &query.cwd) {
            (Some(_), _) => None,
            (None, Some(cwd)) => Some(format!(
                "\"cwd\":{}",
                serde_json::to_string(cwd).map_err(|error| FsError::new(
                    "invalid_path",
                    format!("working directory is not encodable: {error}")
                ))?
            )),
            (None, None) => return Ok(Vec::new()),
        };
        let mut found = Vec::new();
        let Some(sessions) = self.open_optional_dir(&base)? else {
            return Ok(found);
        };
        'days: for year in self.numbered_dirs(&sessions)? {
            let Some(year_dir) = self.open_child_dir(&sessions, &year)? else {
                if self.truncated {
                    break;
                }
                continue;
            };
            for month in self.numbered_dirs(&year_dir)? {
                let Some(month_dir) = self.open_child_dir(&year_dir, &month)? else {
                    if self.truncated {
                        break 'days;
                    }
                    continue;
                };
                for day in self.numbered_dirs(&month_dir)? {
                    let Some(day_dir) = self.open_child_dir(&month_dir, &day)? else {
                        if self.truncated {
                            break 'days;
                        }
                        continue;
                    };
                    let components = [
                        base[0].clone(),
                        base[1].clone(),
                        year.clone(),
                        month.clone(),
                        day.clone(),
                    ];
                    let mut names: Vec<OsString> = self
                        .children(&day_dir)?
                        .into_iter()
                        .filter(|child| {
                            child.is_file
                                && has_prefix(&child.name, "rollout-")
                                && has_suffix(&child.name, ".jsonl")
                        })
                        .map(|child| child.name)
                        .collect();
                    // The timestamp is in the name, so newest last; reversed
                    // is newest first.
                    names.sort();
                    names.reverse();
                    for name in names {
                        if !self.tick_file()? {
                            break 'days;
                        }
                        let matched = match (&suffix, &needle) {
                            (Some(suffix), _) => os_ends_with(&name, suffix),
                            (None, Some(needle)) => self.head_contains(&day_dir, &name, needle),
                            (None, None) => false,
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
                        if suffix.is_some() {
                            break 'days;
                        }
                        if found.len() >= MAX_TRANSCRIPTS {
                            self.truncated = true;
                            break 'days;
                        }
                    }
                }
            }
        }
        Ok(found)
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

    /// Whether the first `CODEX_HEAD_BYTES` of a file contain `needle`. A file
    /// that cannot be opened simply does not match: one unreadable rollout
    /// must not end the search for the rest.
    fn head_contains(&self, dir: &Dir, name: &OsStr, needle: &str) -> bool {
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        let Ok(file) = dir.open_with(name, &options) else {
            return false;
        };
        let mut head = Vec::with_capacity(CODEX_HEAD_BYTES);
        if file
            .into_std()
            .take(CODEX_HEAD_BYTES as u64)
            .read_to_end(&mut head)
            .is_err()
        {
            return false;
        }
        String::from_utf8_lossy(&head).contains(needle)
    }

    /// aider: `.aider.chat.history.md` and `.aider.input.history` in the
    /// folder it ran in. There is no id; the folder is the conversation.
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
        for (name, role) in [
            (".aider.chat.history.md", "conversation"),
            (".aider.input.history", "input"),
        ] {
            if let Some(file) = self.file_in(&dir, &components, OsStr::new(name), role, None)? {
                found.push(file);
            }
        }
        Ok(found)
    }
}

fn has_suffix(name: &OsStr, suffix: &str) -> bool {
    name.to_str().is_some_and(|name| name.ends_with(suffix))
}

fn has_prefix(name: &OsStr, prefix: &str) -> bool {
    name.to_str().is_some_and(|name| name.starts_with(prefix))
}

fn os_ends_with(name: &OsStr, suffix: &OsStr) -> bool {
    match (name.to_str(), suffix.to_str()) {
        (Some(name), Some(suffix)) => name.ends_with(suffix),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::AtomicBool;

    use super::*;

    async fn locate(root: &Path, query: TranscriptQuery) -> TranscriptReport {
        let service = HostFileService::rooted_at(root).await.unwrap();
        locate_in_session(
            &service,
            query,
            HostFileOperations::new(Arc::new(AtomicBool::new(false))),
        )
        .await
        .unwrap()
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

    /// The canonical root, which is what every display path starts with (on
    /// macOS the temp dir itself is behind a symlink).
    fn home(temp: &tempfile::TempDir) -> PathBuf {
        temp.path().canonicalize().unwrap()
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
    }

    #[tokio::test]
    async fn claude_conversation_is_found_by_id_with_its_subagents_launch_folder_first() {
        let temp = tempfile::tempdir().unwrap();
        let home = home(&temp);
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
        let described: Vec<(&str, &str)> = report
            .transcripts
            .iter()
            .map(|file| (file.role, file.name.as_str()))
            .collect();
        assert_eq!(
            described,
            vec![
                ("conversation", "45171e5a-5951-4d38-81e5-e1c0f9639d80.jsonl"),
                ("subagent", "agent-a.jsonl"),
                ("subagent", "agent-b.jsonl"),
                ("conversation", "45171e5a-5951-4d38-81e5-e1c0f9639d80.jsonl"),
            ]
        );
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
        let home = home(&temp);
        let cwd = home.join("proj");
        let folder = claude_project_folder(&cwd.to_string_lossy());
        let project = home.join(".claude").join("projects").join(&folder);
        write(&project.join("older.jsonl"), b"{}\n");
        write(&project.join("agent-side.jsonl"), b"{}\n");
        write(&project.join("newer.jsonl"), b"{}\n");
        let old = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        std::fs::File::open(project.join("older.jsonl"))
            .unwrap()
            .set_modified(old)
            .unwrap();
        std::fs::File::open(project.join("agent-side.jsonl"))
            .unwrap()
            .set_modified(old + std::time::Duration::from_secs(10))
            .unwrap();
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
        let home = home(&temp);
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
        let home = home(&temp);
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
            &home(&temp).join(".codex/sessions/2026/09/17/rollout-2026-09-17T10-12-44-01a0aeda-b62e-7681-a475-3e513e9aafd9.jsonl"),
            b"{}\n",
        );
        let report = locate(temp.path(), query("codex", None, None)).await;
        assert!(report.supported);
        assert!(report.transcripts.is_empty());
    }

    #[tokio::test]
    async fn aider_history_lives_in_the_folder_it_ran_in() {
        let temp = tempfile::tempdir().unwrap();
        let home = home(&temp);
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
        // nothing to find and nothing to fail on.
        let outside = locate(
            temp.path(),
            query("aider", None, Some("/definitely/outside")),
        )
        .await;
        assert!(outside.transcripts.is_empty());
        assert_eq!(outside.searched, vec!["/definitely/outside".to_string()]);
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
        let home = home(&temp);
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
        let home = home(&temp);
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
}
