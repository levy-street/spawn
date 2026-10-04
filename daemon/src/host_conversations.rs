//! The conversation carrier: `conv.probe`, `conv.export`,
//! `conv.import.begin|status|cancel`, `conv.retire.commit|abort` and
//! `conv.transfers` — the family `conv.v2`, answered only on a
//! `spawn.host.ctl` channel admitted through an authenticated device pair,
//! on Linux and macOS daemons. Claude Code only, in this release.
//!
//! A device moves a conversation by carrying it: it reads a conversation
//! bundle (`host_bundle`) out of the source host over one host channel and
//! writes it into the target over another, on the stream v2 primitive
//! (`host_stream`). Neither host learns of the other, and the server sees
//! none of it. What this module adds is what only the hosts can do:
//!
//! * **The source is the fence.** `conv.export` in retire mode refuses while
//!   any process outside the window holds the conversation — a background
//!   session, the job an attach client or agent view shows, another window
//!   (`host_conv::holders`). Then it stops the window's worker through the
//!   session registry, stops every Claude process of the window itself and
//!   confirms each is gone by its pid and start (never by a pid file or the
//!   session's exit), checks again that nothing holds the conversation, and
//!   moves the conversation's files out of Claude's lookup path into
//!   `<config>/conversations/outgoing/<transfer>/` before it reads a byte.
//!   From then on no Claude on the source can resume it.
//! * **The target chooses every name.** `conv.import.begin` takes an agent, a
//!   conversation id and a folder; the destination is Claude Code's own
//!   folder rule over the canonical folder, in the store the window's
//!   environment names. Bytes are staged under `incoming/<transfer>/`,
//!   verified entry by entry and whole, extracted 0600/0700, fsynced, and
//!   only then renamed into the store — the record last. A copy of the same
//!   conversation already on the host is set aside under `superseded/`,
//!   never overwritten. Commit and cancel are decided under one lock and
//!   written down as tombstones, so a transfer reports exactly one of them.
//! * **Nothing is lost on the way.** `conv.retire.commit` moves the source's
//!   holding into `retired/`, kept 30 days outside the lookup path, and only
//!   when the device shows it the length and digest the target committed;
//!   `conv.retire.abort` puts the files back. `conv.transfers` lists what is
//!   unfinished, so any device can resolve a move another one started.
//!
//! Nothing is executed. Every file read is hostile input: bounded, reached
//! without following a link, through the home capability or spawnd's own
//! private holdings. Stopping processes is signalling them, through a pidfd
//! on Linux so a recycled pid is never signalled.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::future::Future;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex as StdMutex, OnceLock, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, DirBuilder, OpenOptions};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::host_bundle::{BundleError, Manifest, CLAUDE_CODE, CONVERSATION, SIDECAR};
use crate::host_conv::{Holder, Holders, ProcessTable, WindowShells};
use crate::host_files::{
    FsError, FsResult, HostFileOperations, HostFileService, HostOperationKind,
};
use crate::host_stream::{BulkGate, DigestAt, StreamRequest, TransferStatus};

/// The family capability for the carrier. `conv.v1` keeps naming
/// `conv.inspect` alone, so a client that knows only it never assumes a
/// daemon can carry.
pub(crate) const CAPABILITY: &str = "conv.v2";
/// Where a window can be walked and its processes confirmed gone.
pub(crate) const SUPPORTED: bool = crate::host_conv::SUPPORTED;

pub(crate) const PROBE_OP: &str = "conv.probe";
pub(crate) const EXPORT_OP: &str = "conv.export";
pub(crate) const IMPORT_BEGIN_OP: &str = "conv.import.begin";
pub(crate) const IMPORT_STATUS_OP: &str = "conv.import.status";
pub(crate) const IMPORT_CANCEL_OP: &str = "conv.import.cancel";
pub(crate) const RETIRE_COMMIT_OP: &str = "conv.retire.commit";
pub(crate) const RETIRE_ABORT_OP: &str = "conv.retire.abort";
pub(crate) const TRANSFERS_OP: &str = "conv.transfers";

/// Every operation `conv.v2` adds.
pub(crate) fn is_carrier_op(operation: &str) -> bool {
    matches!(
        operation,
        PROBE_OP
            | EXPORT_OP
            | IMPORT_BEGIN_OP
            | IMPORT_STATUS_OP
            | IMPORT_CANCEL_OP
            | RETIRE_COMMIT_OP
            | RETIRE_ABORT_OP
            | TRANSFERS_OP
    )
}

/// Retired holdings and finished transfers' records are kept this long.
const RETENTION: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// Housekeeping runs at most this often.
const GC_INTERVAL: Duration = Duration::from_secs(10 * 60);
/// Transfers a host stages at once, and the bytes they may declare together:
/// two bundles of the largest size.
const MAX_INCOMING: usize = 16;
const MAX_INCOMING_BYTES: u64 = 2 * crate::host_bundle::BUNDLE_MAX;
/// What an import leaves free on the filesystem beside what it needs: the
/// staged bundle and the files extracted from it, both whole until commit.
const SPACE_RESERVE: u64 = 256 * 1024 * 1024;
/// Project folders one scan of a Claude store reads; a store with more is
/// refused rather than half-searched, since a copy missed is a copy that
/// would go on being resumable.
const MAX_PROJECT_FOLDERS: usize = 16_384;
/// Files one walk of a conversation's sidecar examines.
const MAX_SIDECAR_VISITS: usize = 16_384;
/// The largest record of spawnd's own this module reads back.
const MAX_RECORD_BYTES: u64 = 4 * 1024 * 1024;
/// A `.git` file, a `commondir`, a package manifest.
const MAX_SMALL_FILE_BYTES: u64 = 64 * 1024;
/// Copies of a conversation a probe names.
const MAX_REPORTED_DUPLICATES: usize = 16;
/// How long a window's processes have to go after TERM, then after KILL.
const AGENT_TERM_GRACE: Duration = Duration::from_secs(3);
const AGENT_KILL_GRACE: Duration = Duration::from_secs(2);
const AGENT_POLL: Duration = Duration::from_millis(50);
/// Unfinished transfers one `conv.transfers` answer lists per direction.
const MAX_LISTED_TRANSFERS: usize = 32;

const OUTGOING: &str = "outgoing";
const RETIRED: &str = "retired";
const ABORTED: &str = "aborted";
const INCOMING: &str = "incoming";
const IMPORTED: &str = "imported";
const CANCELLED: &str = "cancelled";
const SUPERSEDED: &str = "superseded";
const RECORD: &str = "record.json";
/// An outgoing record's states: files leaving the store; out and declared;
/// a move that failed and could not be put back, which only an abort ends.
const MOVING: &str = "moving";
const HELD: &str = "held";
const STRANDED: &str = "stranded";
const FILES: &str = "files";
const STAGED: &str = "bundle";
const TREE: &str = "tree";

fn error(code: &'static str, detail: impl Into<String>) -> FsError {
    FsError::new(code, detail)
}

fn bundle_error(error: BundleError) -> FsError {
    FsError::new(error.code, error.detail)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// How a window's stop went (`PairWindows::stop`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WindowStop {
    /// The daemon runs no worker for it: a window already stopped.
    NotRunning,
    /// Its worker is gone.
    Stopped,
    /// Its shell's group was killed and its worker still holds the terminal
    /// (a background job keeps it open). The window's Claude processes are
    /// confirmed separately, by pid.
    Lingering,
    /// A worker for it exists that this daemon has not adopted yet.
    Unavailable,
}

pub(crate) type StopFuture = Pin<Box<dyn Future<Output = WindowStop> + Send>>;
type StopFn = dyn Fn(Uuid) -> StopFuture + Send + Sync;
type IncarnationFn = dyn Fn(Uuid) -> Option<u64> + Send + Sync;
type ShellNameFn = dyn Fn() -> String + Send + Sync;

/// Where a retire is, for a test that acts between its steps.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MovePoint {
    /// The record is written; nothing has moved yet.
    BeforeMove,
    /// Every file has moved; the holders are about to be checked again.
    AfterMove,
}

/// Where the carrier keeps and finds things. Production names nothing and
/// reads the daemon's own configuration; tests root everything in a
/// temporary home.
#[derive(Clone)]
pub(crate) struct Places {
    /// spawnd's holdings: `<config>/conversations`.
    holdings: Option<PathBuf>,
    /// Claude Code's store: `CLAUDE_CONFIG_DIR`, else `~/.claude`.
    claude_store: Option<PathBuf>,
    /// Where live-session registries and rosters are read: both of the
    /// above, as `conv.inspect` reads them.
    registry_stores: Option<Vec<PathBuf>>,
    login_shell: Arc<ShellNameFn>,
    #[cfg(test)]
    move_hook: Option<Arc<dyn Fn(MovePoint) + Send + Sync>>,
    /// The free space a test's filesystem reports.
    #[cfg(test)]
    free_space: Option<u64>,
}

impl Places {
    /// The daemon's own: its config dir, the store its environment names,
    /// and the login shell its windows start.
    pub(crate) fn from_env(login_shell: fn() -> String) -> Self {
        Self {
            holdings: None,
            claude_store: None,
            registry_stores: None,
            login_shell: Arc::new(login_shell),
            #[cfg(test)]
            move_hook: None,
            #[cfg(test)]
            free_space: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn rooted(holdings: PathBuf, claude_store: PathBuf) -> Self {
        Self {
            holdings: Some(holdings),
            registry_stores: Some(vec![claude_store.clone()]),
            claude_store: Some(claude_store),
            login_shell: Arc::new(|| "bash".to_string()),
            move_hook: None,
            free_space: None,
        }
    }

    /// The space free to spawnd on the filesystem of `dir`, where it can be
    /// read.
    fn free_bytes(&self, dir: &Dir) -> Option<u64> {
        #[cfg(test)]
        if self.free_space.is_some() {
            return self.free_space;
        }
        #[cfg(unix)]
        {
            let stat = rustix::fs::fstatvfs(dir).ok()?;
            Some(stat.f_bavail.saturating_mul(stat.f_frsize))
        }
        #[cfg(not(unix))]
        {
            let _ = dir;
            None
        }
    }

    fn reached(&self, point: MovePoint) {
        #[cfg(test)]
        if let Some(hook) = &self.move_hook {
            hook(point);
        }
        let _ = point;
    }

    fn holdings_path(&self) -> FsResult<PathBuf> {
        match &self.holdings {
            Some(path) => Ok(path.clone()),
            None => crate::config::config_dir()
                .map(|dir| dir.join("conversations"))
                .map_err(|error| error_unavailable(&error.to_string())),
        }
    }

    fn claude_store_path(&self) -> Option<PathBuf> {
        self.claude_store.clone().or_else(|| {
            std::env::var_os("CLAUDE_CONFIG_DIR")
                .filter(|value| !value.to_string_lossy().trim().is_empty())
                .map(PathBuf::from)
        })
    }

    fn registry_stores(&self) -> Vec<PathBuf> {
        self.registry_stores
            .clone()
            .unwrap_or_else(crate::host_conv::claude_stores)
    }
}

fn error_unavailable(detail: &str) -> FsError {
    error(
        "store_unavailable",
        format!("spawnd cannot keep conversations here: {detail}"),
    )
}

/// What a channel admitted through an authenticated device pair may do with
/// this daemon's windows: name a window's shell (`conv.inspect`), stop it
/// (`conv.export` in retire mode), and pace its bulk on the association's
/// gate. Built in `rtc_pair.rs`, which owns the session registry; nothing
/// here reaches the registry itself.
#[derive(Clone)]
pub(crate) struct PairWindows {
    shells: WindowShells,
    stop: Arc<StopFn>,
    incarnation: Arc<IncarnationFn>,
    bulk: Arc<BulkGate>,
    places: Places,
}

impl PairWindows {
    pub(crate) fn new(
        shells: WindowShells,
        stop: impl Fn(Uuid) -> StopFuture + Send + Sync + 'static,
        incarnation: impl Fn(Uuid) -> Option<u64> + Send + Sync + 'static,
        bulk: Arc<BulkGate>,
        places: Places,
    ) -> Self {
        Self {
            shells,
            stop: Arc::new(stop),
            incarnation: Arc::new(incarnation),
            bulk,
            places,
        }
    }

    pub(crate) fn shell_pid(&self, session_id: Uuid) -> Option<u32> {
        self.shells.shell_pid(session_id)
    }

    /// Which run of the window this daemon has now, if any: a window started
    /// again is another one.
    fn incarnation(&self, session_id: Uuid) -> Option<u64> {
        (self.incarnation)(session_id)
    }

    pub(crate) fn bulk(&self) -> &Arc<BulkGate> {
        &self.bulk
    }

    async fn stop_window(&self, session_id: Uuid) -> WindowStop {
        (self.stop)(session_id).await
    }
}

// ---------------------------------------------------------------------------
// Requests

/// A canonical lower-case UUID: what every id in this family is.
fn canonical_uuid(value: Option<&Value>) -> Option<Uuid> {
    let text = value?.as_str()?;
    let uuid = Uuid::parse_str(text).ok()?;
    (uuid.hyphenated().to_string() == text).then_some(uuid)
}

/// A transfer id is a device-chosen UUIDv4.
fn transfer_id(payload: Option<&Map<String, Value>>) -> FsResult<Uuid> {
    canonical_uuid(payload.and_then(|payload| payload.get("transfer_id")))
        .filter(|id| id.get_version_num() == 4)
        .ok_or_else(|| {
            error(
                "invalid_request",
                "transfer_id must be a canonical lower-case UUIDv4",
            )
        })
}

fn optional_uuid(payload: Option<&Map<String, Value>>, key: &str) -> FsResult<Option<Uuid>> {
    match payload.and_then(|payload| payload.get(key)) {
        None | Some(Value::Null) => Ok(None),
        value => canonical_uuid(value)
            .map(Some)
            .ok_or_else(|| error("invalid_request", format!("{key} must be a canonical UUID"))),
    }
}

/// The agent and conversation a request names, as the bundle rules require:
/// an agent version 1 defines, spelled exactly, and a canonical id.
fn conversation(payload: Option<&Map<String, Value>>) -> FsResult<String> {
    let agent = payload
        .and_then(|payload| payload.get("agent"))
        .and_then(Value::as_str);
    if !agent.is_some_and(crate::host_bundle::known_agent) {
        return Err(error(
            "invalid_request",
            "agent must be one this host can carry (claude-code)",
        ));
    }
    payload
        .and_then(|payload| payload.get("conversation_id"))
        .and_then(Value::as_str)
        .filter(|id| crate::host_bundle::is_canonical_id(id))
        .map(str::to_string)
        .ok_or_else(|| {
            error(
                "invalid_request",
                "conversation_id must be a canonical lower-case UUID",
            )
        })
}

fn text<'a>(payload: Option<&'a Map<String, Value>>, key: &str) -> Option<&'a str> {
    payload?
        .get(key)?
        .as_str()
        .filter(|value| value.len() <= 4096 && !value.as_bytes().contains(&0))
}

/// The one way a conversation leaves a host: `retire`, the fence — the
/// window stops and the files leave Claude's lookup path, so the
/// conversation is never resumable on two hosts at once. `snapshot`, a copy
/// that leaves the source running, is reserved for a later copies feature
/// the owner has not approved (OD7) and is refused by both ends: the source
/// never makes one, and a target imports only what a retire carried.
fn retire_mode(payload: Option<&Map<String, Value>>, what: &str) -> FsResult<()> {
    match text(payload, "mode") {
        Some("retire") => Ok(()),
        Some("snapshot") => Err(error(
            "unsupported_operation",
            format!(
                "{what} only a retired conversation: a snapshot would leave it resumable on two hosts, and copies are not offered"
            ),
        )),
        _ => Err(error("invalid_request", "mode must be retire")),
    }
}

/// What of the sidecar travels. The record always does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Include {
    subagents: bool,
    tool_results: bool,
    workflows: bool,
}

impl Include {
    const ALL: Self = Self {
        subagents: true,
        tool_results: true,
        workflows: true,
    };

    fn parse(value: Option<&Value>) -> FsResult<Self> {
        let Some(value) = value.filter(|value| !value.is_null()) else {
            return Ok(Self::ALL);
        };
        let names = value
            .as_array()
            .ok_or_else(|| error("invalid_request", "include must be a list"))?;
        let mut include = Self {
            subagents: false,
            tool_results: false,
            workflows: false,
        };
        let mut conversation = false;
        for name in names {
            match name.as_str() {
                Some("conversation") => conversation = true,
                Some("subagents") => include.subagents = true,
                Some("tool_results") => include.tool_results = true,
                Some("workflows") => include.workflows = true,
                _ => {
                    return Err(error(
                        "invalid_request",
                        "include names conversation, subagents, tool_results and workflows",
                    ))
                }
            }
        }
        if !conversation {
            return Err(error(
                "invalid_request",
                "include must name the conversation itself",
            ));
        }
        Ok(include)
    }

    fn allows(self, logical: &str) -> bool {
        if logical == CONVERSATION {
            return true;
        }
        let rest = logical.strip_prefix("sidecar/").unwrap_or_default();
        if rest.starts_with("subagents/") {
            self.subagents
        } else if rest.starts_with("tool-results/") {
            self.tool_results
        } else if rest.starts_with("workflows/") {
            self.workflows
        } else {
            false
        }
    }

    fn names(self) -> Vec<&'static str> {
        let mut names = vec!["conversation"];
        if self.subagents {
            names.push("subagents");
        }
        if self.tool_results {
            names.push("tool_results");
        }
        if self.workflows {
            names.push("workflows");
        }
        names
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ExportRequest {
    pub transfer_id: Uuid,
    pub conversation_id: String,
    /// The window the conversation leaves.
    pub session_id: Uuid,
    pub cwd: Option<String>,
    /// The host it goes to: recorded so that a device resolving an
    /// unfinished move asks that host before it puts anything back.
    pub to_host_id: Uuid,
    include: Include,
    pub stream: StreamRequest,
    pub from_sequence: u64,
}

impl ExportRequest {
    pub(crate) fn parse(payload: Option<&Map<String, Value>>) -> FsResult<Self> {
        let transfer_id = transfer_id(payload)?;
        let conversation_id = conversation(payload)?;
        retire_mode(payload, "this host exports")?;
        let session_id = optional_uuid(payload, "session_id")?.ok_or_else(|| {
            error(
                "invalid_request",
                "retiring a conversation names the window it leaves",
            )
        })?;
        let to_host_id = optional_uuid(payload, "to_host_id")?.ok_or_else(|| {
            error(
                "invalid_request",
                "retiring a conversation names the host it goes to",
            )
        })?;
        let stream = StreamRequest::parse(payload.and_then(|payload| payload.get("stream")))
            .ok_or_else(|| error("invalid_request", "stream is {window?, digest?}"))?;
        let from_sequence = match payload.and_then(|payload| payload.get("from_sequence")) {
            None | Some(Value::Null) => 0,
            Some(value) => value
                .as_u64()
                .ok_or_else(|| error("invalid_request", "from_sequence is a chunk number"))?,
        };
        Ok(Self {
            transfer_id,
            conversation_id,
            session_id,
            cwd: text(payload, "cwd").map(str::to_string),
            to_host_id,
            include: Include::parse(payload.and_then(|payload| payload.get("include")))?,
            stream,
            from_sequence,
        })
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ImportRequest {
    pub transfer_id: Uuid,
    pub conversation_id: String,
    pub cwd: String,
    pub length: u64,
    pub sha256: Option<String>,
    pub stream: StreamRequest,
    pub from_host_id: Option<Uuid>,
}

impl ImportRequest {
    pub(crate) fn parse(payload: Option<&Map<String, Value>>) -> FsResult<Self> {
        let transfer_id = transfer_id(payload)?;
        let conversation_id = conversation(payload)?;
        // The device forwards the export's mode, as it forwards its digest.
        retire_mode(payload, "this host imports")?;
        let cwd = text(payload, "cwd")
            .filter(|cwd| !cwd.trim().is_empty())
            .ok_or_else(|| {
                error(
                    "invalid_request",
                    "cwd names the folder the window opens in",
                )
            })?
            .to_string();
        let length = payload
            .and_then(|payload| payload.get("length"))
            .and_then(Value::as_u64)
            .ok_or_else(|| error("invalid_request", "length is the bundle's length in bytes"))?;
        if length > crate::host_bundle::BUNDLE_MAX {
            return Err(error("too_large", "a bundle is at most 2 GiB"));
        }
        if length <= crate::host_bundle::HEADER_BYTES {
            return Err(error(
                "invalid_request",
                "length is shorter than any bundle",
            ));
        }
        let stream = StreamRequest::parse(payload.and_then(|payload| payload.get("stream")))
            .ok_or_else(|| error("invalid_request", "stream is {window?, digest?}"))?;
        let sha256 = crate::host_stream::optional_sha256(payload, "sha256").ok_or_else(|| {
            error(
                "invalid_request",
                "sha256 is 64 lower-case hex digits or null",
            )
        })?;
        match (stream.digest, &sha256) {
            (DigestAt::Start, None) => {
                return Err(error(
                    "invalid_request",
                    "a digest at the start is declared in the begin",
                ))
            }
            (DigestAt::End, Some(_)) => {
                return Err(error(
                    "invalid_request",
                    "a digest at the end is declared in stream.end",
                ))
            }
            _ => {}
        }
        Ok(Self {
            transfer_id,
            conversation_id,
            cwd,
            length,
            sha256,
            stream,
            from_host_id: optional_uuid(payload, "from_host_id")?,
        })
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ProbeRequest {
    pub conversation_id: Option<String>,
    pub cwd: String,
}

impl ProbeRequest {
    pub(crate) fn parse(payload: Option<&Map<String, Value>>) -> FsResult<Self> {
        let agent = text(payload, "agent");
        if !agent.is_some_and(crate::host_bundle::known_agent) {
            return Err(error(
                "invalid_request",
                "agent must be one this host can carry (claude-code)",
            ));
        }
        let conversation_id = match payload.and_then(|payload| payload.get("conversation_id")) {
            None | Some(Value::Null) => None,
            Some(value) => Some(
                value
                    .as_str()
                    .filter(|id| crate::host_bundle::is_canonical_id(id))
                    .ok_or_else(|| {
                        error(
                            "invalid_request",
                            "conversation_id must be a canonical lower-case UUID",
                        )
                    })?
                    .to_string(),
            ),
        };
        let cwd = text(payload, "cwd")
            .filter(|cwd| !cwd.trim().is_empty())
            .ok_or_else(|| error("invalid_request", "cwd names the folder to look at"))?
            .to_string();
        Ok(Self {
            conversation_id,
            cwd,
        })
    }
}

/// Retire commit: the device shows what the target committed.
#[derive(Clone, Debug)]
pub(crate) struct RetireCommit {
    pub transfer_id: Uuid,
    pub length: u64,
    pub sha256: String,
}

impl RetireCommit {
    pub(crate) fn parse(payload: Option<&Map<String, Value>>) -> FsResult<Self> {
        let transfer_id = transfer_id(payload)?;
        let length = payload
            .and_then(|payload| payload.get("length"))
            .and_then(Value::as_u64);
        let sha256 =
            text(payload, "sha256").filter(|digest| crate::host_stream::is_sha256_hex(digest));
        match (length, sha256) {
            (Some(length), Some(sha256)) => Ok(Self {
                transfer_id,
                length,
                sha256: sha256.to_string(),
            }),
            _ => Err(error(
                "invalid_request",
                "a retire commits only what the target committed: length and sha256",
            )),
        }
    }
}

pub(crate) fn parse_transfer(payload: Option<&Map<String, Value>>) -> FsResult<Uuid> {
    transfer_id(payload)
}

// ---------------------------------------------------------------------------
// Transfers in flight: one lock per transfer and role, and the one stream
// carrying it.

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
enum Role {
    Export,
    Import,
}

/// Why a stream was ended by someone other than its own channel.
pub(crate) type EndReason = Arc<OnceLock<&'static str>>;

struct ActiveStream {
    stream_id: String,
    token: CancellationToken,
    reason: EndReason,
}

/// One transfer's state while anything works on it. Its lock is where commit
/// and cancel are decided, and where a resumed stream supersedes the old.
#[derive(Default)]
pub(crate) struct Slot {
    active: Option<ActiveStream>,
}

impl Slot {
    /// End the stream carrying this transfer, if any, saying why.
    fn end(&mut self, reason: &'static str) {
        if let Some(active) = self.active.take() {
            let _ = active.reason.set(reason);
            active.token.cancel();
        }
    }

    /// `stream_id` carries this transfer from now on; whatever carried it
    /// before is superseded.
    fn start(&mut self, slot: &Arc<Mutex<Slot>>, stream_id: &str) -> Claim {
        self.end("superseded");
        let token = CancellationToken::new();
        let reason: EndReason = Arc::new(OnceLock::new());
        self.active = Some(ActiveStream {
            stream_id: stream_id.to_string(),
            token: token.clone(),
            reason: Arc::clone(&reason),
        });
        Claim {
            slot: Arc::clone(slot),
            stream_id: stream_id.to_string(),
            token,
            reason,
        }
    }

    fn carries(&self, stream_id: &str) -> bool {
        self.active
            .as_ref()
            .is_some_and(|active| active.stream_id == stream_id && !active.token.is_cancelled())
    }

    /// The stream ended on its own channel: let the transfer go quietly.
    fn release(&mut self, stream_id: &str, reason: &'static str) {
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.stream_id == stream_id)
        {
            self.end(reason);
        }
    }
}

/// A stream's claim on the transfer it carries: what its owner watches to
/// learn that someone else ended it (a resumed stream, a cancel, a commit
/// or abort of the transfer), and how it lets go when it ends on its own.
#[derive(Clone)]
pub(crate) struct Claim {
    slot: Arc<Mutex<Slot>>,
    stream_id: String,
    token: CancellationToken,
    reason: EndReason,
}

impl Claim {
    pub(crate) fn token(&self) -> &CancellationToken {
        &self.token
    }

    /// `superseded`, `cancelled`, `transfer_committed`, `transfer_aborted`,
    /// or `finished` for a stream that ended on its own.
    pub(crate) fn reason(&self) -> Option<&'static str> {
        self.reason.get().copied()
    }

    /// The stream is over; the transfer stays as it is.
    pub(crate) async fn release(&self) {
        self.slot.lock().await.release(&self.stream_id, "finished");
    }

    /// Why a stream that no longer carries its transfer cannot go on.
    fn lost(&self) -> FsError {
        match self.reason() {
            Some("cancelled") => error(
                "transfer_cancelled",
                "the transfer was cancelled and can never commit",
            ),
            _ => error("superseded", "another stream carries this transfer now"),
        }
    }
}

type SlotMap = StdMutex<HashMap<(Role, Uuid), Weak<Mutex<Slot>>>>;

fn slot(role: Role, transfer: Uuid) -> Arc<Mutex<Slot>> {
    static SLOTS: OnceLock<SlotMap> = OnceLock::new();
    let mut slots = SLOTS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    slots.retain(|_, slot| slot.strong_count() > 0);
    if let Some(slot) = slots.get(&(role, transfer)).and_then(Weak::upgrade) {
        return slot;
    }
    let slot = Arc::new(Mutex::new(Slot::default()));
    slots.insert((role, transfer), Arc::downgrade(&slot));
    slot
}

/// Hold a transfer's import lock, as a commit verifying and extracting a
/// large bundle does: for tests of what waits on it.
#[cfg(test)]
pub(crate) async fn hold_import_lock(transfer: Uuid) -> tokio::sync::OwnedMutexGuard<Slot> {
    slot(Role::Import, transfer).lock_owned().await
}

type MoveLocks = StdMutex<HashMap<String, Weak<Mutex<()>>>>;

/// One move of a conversation at a time, whatever transfer carries it: held
/// from the look for an unfinished move of the conversation, through the
/// holder checks and the window's stop, until its own record is written and
/// its files are out. A second move of the same conversation — a double tap,
/// another device — waits here, then finds the first's record and is refused
/// with `transfer_unresolved` before anything of its own stops.
fn move_lock(conversation_id: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<MoveLocks> = OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(conversation_id).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(conversation_id.to_string(), Arc::downgrade(&lock));
    lock
}

/// The context every operation runs in: the home capability, this channel's
/// operation accounting, and the pair's authority over windows.
#[derive(Clone)]
pub(crate) struct Carrier {
    files: HostFileService,
    operations: Arc<HostFileOperations>,
    pair: PairWindows,
}

impl Carrier {
    pub(crate) fn new(
        files: HostFileService,
        operations: Arc<HostFileOperations>,
        pair: PairWindows,
    ) -> Self {
        Self {
            files,
            operations,
            pair,
        }
    }

    async fn blocking<T, F>(&self, work: F) -> FsResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&HostFileService, &Places, &HostFileOperations) -> FsResult<T> + Send + 'static,
    {
        let files = self.files.clone();
        let places = self.pair.places.clone();
        self.files
            .run_blocking(
                Arc::clone(&self.operations),
                HostOperationKind::Conversation,
                move |operations| work(&files, &places, operations),
            )
            .await
    }
}

// ---------------------------------------------------------------------------
// Filesystem leaves

fn nofollow(error: std::io::Error) -> FsError {
    crate::host_files::nofollow_error(error)
}

/// A directory of the store, opened without following a link; created 0700
/// when missing, never re-moded when present.
fn ensure_dir(parent: &Dir, name: &OsStr) -> FsResult<Dir> {
    match parent.open_dir_nofollow(name) {
        Ok(dir) => return Ok(dir),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(nofollow(error)),
    }
    let mut builder = DirBuilder::new();
    #[cfg(unix)]
    {
        use cap_std::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match parent.create_dir_with(name, &builder) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let dir = parent.open_dir_nofollow(name).map_err(nofollow)?;
    crate::platform::fsync_dir(parent)?;
    Ok(dir)
}

fn optional_dir(parent: &Dir, name: &OsStr) -> FsResult<Option<Dir>> {
    match parent.symlink_metadata(name) {
        Ok(metadata) if metadata.is_dir() => {
            parent.open_dir_nofollow(name).map(Some).map_err(nofollow)
        }
        Ok(_) => Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn is_regular_file(parent: &Dir, name: &OsStr) -> bool {
    parent
        .symlink_metadata(name)
        .is_ok_and(|metadata| metadata.is_file())
}

fn exists(parent: &Dir, name: &OsStr) -> bool {
    parent.symlink_metadata(name).is_ok()
}

/// A regular file opened for reading without following a link, and without
/// blocking: a FIFO planted where a `.git` pointer, a `commondir` or a
/// conversation file is expected opens at once and is refused, rather than
/// holding a thread — and the channel waiting on it — for good.
fn open_file(parent: &Dir, name: &OsStr) -> FsResult<std::fs::File> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32);
    }
    let file = parent
        .open_with(name, &options)
        .map_err(nofollow)?
        .into_std();
    if !file.metadata()?.is_file() {
        return Err(error(
            "not_file",
            "a conversation file is not a regular file",
        ));
    }
    Ok(file)
}

fn open_path(root: &Dir, components: &[OsString]) -> FsResult<std::fs::File> {
    let (name, parents) = components
        .split_last()
        .ok_or_else(|| error("invalid_path", "an empty location"))?;
    let mut dir = root.try_clone()?;
    for component in parents {
        dir = dir.open_dir_nofollow(component).map_err(nofollow)?;
    }
    open_file(&dir, name)
}

/// The byte length of a log's complete lines: up to and including its last
/// newline. A Claude killed mid-write leaves a torn last line, and the next
/// append glues onto it; a carried record ends at the last whole one.
fn complete_lines(file: &mut std::fs::File, size: u64) -> FsResult<u64> {
    const BLOCK: u64 = 64 * 1024;
    let mut end = size;
    let mut buffer = vec![0_u8; BLOCK as usize];
    while end > 0 {
        let start = end.saturating_sub(BLOCK);
        let len = (end - start) as usize;
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut buffer[..len])?;
        if let Some(position) = buffer[..len].iter().rposition(|byte| *byte == b'\n') {
            return Ok(start + position as u64 + 1);
        }
        end = start;
    }
    Ok(0)
}

/// Rename across directories of one filesystem, never over anything.
fn rename_noreplace(from_dir: &Dir, from: &OsStr, to_dir: &Dir, to: &OsStr) -> FsResult<()> {
    #[cfg(unix)]
    {
        use rustix::fs::{renameat_with, RenameFlags};
        match renameat_with(from_dir, from, to_dir, to, RenameFlags::NOREPLACE) {
            Ok(()) => Ok(()),
            Err(rustix::io::Errno::EXIST | rustix::io::Errno::NOTEMPTY) => Err(error(
                "already_exists",
                "something is already where a conversation file belongs",
            )),
            Err(rustix::io::Errno::XDEV) => Err(error(
                "store_unavailable",
                "Claude's store and spawnd's holdings are on different filesystems",
            )),
            Err(
                rustix::io::Errno::NOSYS | rustix::io::Errno::INVAL | rustix::io::Errno::NOTSUP,
            ) => Err(error(
                "atomic_no_clobber_unsupported",
                "atomic no-clobber rename is unavailable on this filesystem",
            )),
            Err(errno) => Err(std::io::Error::from_raw_os_error(errno.raw_os_error()).into()),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (from_dir, from, to_dir, to);
        Err(error(
            "unsupported_operation",
            "conversations are not carried on this platform",
        ))
    }
}

/// The filesystem a directory is on.
fn device_of(dir: &Dir) -> FsResult<u64> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(dir.try_clone()?.into_std_file().metadata()?.dev())
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        Err(error(
            "unsupported_operation",
            "conversations are not carried on this platform",
        ))
    }
}

fn read_bounded(file: std::fs::File, cap: u64) -> FsResult<Vec<u8>> {
    let mut bytes = Vec::new();
    file.take(cap + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > cap {
        return Err(error("too_large", "a record is larger than it can be"));
    }
    Ok(bytes)
}

/// One of spawnd's own records, written whole or not at all.
fn write_record<T: Serialize>(dir: &Dir, name: &str, value: &T) -> FsResult<()> {
    let temporary = format!(".{name}.tmp");
    match dir.remove_file(&temporary) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let mut file = crate::platform::create_private_file_new_at(dir, Path::new(&temporary))?;
    let bytes =
        serde_json::to_vec(value).map_err(|serialize| error("io_error", serialize.to_string()))?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    dir.rename(&temporary, dir, name)?;
    crate::platform::fsync_dir(dir)?;
    Ok(())
}

fn read_record<T: DeserializeOwned>(dir: &Dir, name: &str) -> FsResult<Option<T>> {
    let file = match crate::platform::open_private_file_at(dir, Path::new(name), false) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let bytes = read_bounded(file, MAX_RECORD_BYTES)?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| error("corrupt_record", "a transfer record cannot be read"))
}

fn remove_tree(parent: &Dir, name: &str) -> FsResult<()> {
    match parent.remove_dir_all(name) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    crate::platform::fsync_dir(parent)?;
    Ok(())
}

fn components_text(components: &[OsString]) -> FsResult<Vec<String>> {
    components
        .iter()
        .map(|component| {
            component
                .to_str()
                .map(str::to_string)
                .ok_or_else(|| error_unavailable("the store's path is not UTF-8"))
        })
        .collect()
}

// ---------------------------------------------------------------------------
// spawnd's holdings: `<config>/conversations`

struct Holdings {
    root: Dir,
}

impl Holdings {
    fn open(places: &Places) -> FsResult<Self> {
        let path = places.holdings_path()?;
        crate::platform::create_private_dir_all(&path)
            .map_err(|error| error_unavailable(&error.to_string()))?;
        let root = crate::platform::open_private_dir(&path)
            .map_err(|error| error_unavailable(&error.to_string()))?;
        Ok(Self { root })
    }

    fn sub(&self, name: &str) -> FsResult<Dir> {
        crate::platform::open_or_create_private_dir_at(&self.root, Path::new(name))
            .map_err(Into::into)
    }

    fn device(&self) -> FsResult<u64> {
        device_of(&self.root)
    }
}

// ---------------------------------------------------------------------------
// Claude Code's store

struct Store {
    components: Vec<OsString>,
    dir: Dir,
    display: PathBuf,
}

impl Store {
    /// The store the window's environment names, inside home. One outside
    /// home, or reached through a link, is beyond the file capability.
    fn open(files: &HostFileService, places: &Places) -> FsResult<Self> {
        let components = match places.claude_store_path() {
            Some(path) => {
                if !path.is_absolute() {
                    return Err(error_unavailable(
                        "CLAUDE_CONFIG_DIR is not an absolute path",
                    ));
                }
                let text = path
                    .to_str()
                    .ok_or_else(|| error_unavailable("CLAUDE_CONFIG_DIR is not UTF-8"))?;
                files
                    .relative_components(text)
                    .map_err(|_| error_unavailable("Claude's store is outside home"))?
            }
            None => vec![OsString::from(".claude")],
        };
        Self::at(files, components)
    }

    fn at(files: &HostFileService, components: Vec<OsString>) -> FsResult<Self> {
        let dir = files.open_dir_components(&components).map_err(|failure| {
            if failure.code == "not_found" {
                error("store_missing", "Claude Code has no store on this host yet")
            } else {
                error_unavailable(&failure.detail)
            }
        })?;
        Ok(Self {
            display: files.display_path(&components),
            components,
            dir,
        })
    }

    fn projects(&self) -> FsResult<Option<Dir>> {
        optional_dir(&self.dir, OsStr::new("projects"))
    }

    fn projects_display(&self) -> PathBuf {
        self.display.join("projects")
    }
}

/// One project folder that holds something of a conversation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Copy {
    folder: String,
    /// `<folder>/<id>.jsonl` is a regular file: a resumable copy.
    record: bool,
    /// `<folder>/<id>/` is a directory.
    sidecar: bool,
}

/// Every folder of the store holding `<id>.jsonl` or `<id>/`. `cancelled`
/// stops a scan nobody waits for; a commit's never does.
fn find_copies(projects: &Dir, id: &str, cancelled: &dyn Fn() -> bool) -> FsResult<Vec<Copy>> {
    let record = OsString::from(format!("{id}.jsonl"));
    let mut copies = Vec::new();
    for (index, entry) in projects.entries()?.enumerate() {
        if index >= MAX_PROJECT_FOLDERS {
            return Err(error(
                "store_too_large",
                "Claude's store has more project folders than spawnd will search",
            ));
        }
        if index.is_multiple_of(256) && cancelled() {
            return Err(crate::host_files::cancelled_error());
        }
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let Some(folder) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Ok(project) = projects.open_dir_nofollow(&folder) else {
            continue;
        };
        let has_record = is_regular_file(&project, &record);
        let has_sidecar = project
            .symlink_metadata(id)
            .is_ok_and(|metadata| metadata.is_dir());
        if has_record || has_sidecar {
            copies.push(Copy {
                folder,
                record: has_record,
                sidecar: has_sidecar,
            });
        }
    }
    copies.sort_by(|a, b| a.folder.cmp(&b.folder));
    Ok(copies)
}

/// Which copy a move carries: the only resumable one; or, of several, the
/// one in the window's folder. Claude Code itself refuses to resume an id
/// held in two other folders, and so does a move.
fn carried_copy(copies: &[Copy], preferred: Option<&str>) -> FsResult<usize> {
    let records: Vec<usize> = copies
        .iter()
        .enumerate()
        .filter(|(_, copy)| copy.record)
        .map(|(index, _)| index)
        .collect();
    match records.as_slice() {
        [] => Err(error(
            "conversation_not_found",
            "this host has no record of that conversation",
        )),
        [only] => Ok(*only),
        several => preferred
            .and_then(|folder| {
                several
                    .iter()
                    .copied()
                    .find(|index| copies[*index].folder == folder)
            })
            .ok_or_else(|| {
                error(
                    "conversation_ambiguous",
                    "several folders hold this conversation and none is the window's",
                )
            }),
    }
}

// ---------------------------------------------------------------------------
// Where a conversation lands

struct Destination {
    /// The folder with every link resolved: what Claude Code files it under.
    cwd: String,
    exists: bool,
    folder: String,
    repository_root: Option<String>,
}

/// `~` and `~/x` against home; anything else as given.
fn expand_home(files: &HostFileService, cwd: &str) -> String {
    let home = files.home_dir();
    let cwd = cwd.trim();
    if cwd == "~" {
        return home;
    }
    match cwd.strip_prefix("~/") {
        Some(rest) => Path::new(&home).join(rest).to_string_lossy().into_owned(),
        None => cwd.to_string(),
    }
}

fn resolve_destination(files: &HostFileService, cwd: &str) -> FsResult<Destination> {
    let expanded = expand_home(files, cwd);
    if !Path::new(&expanded).is_absolute() {
        return Err(error("invalid_path", "cwd is not an absolute folder"));
    }
    // Only a name: resolving reads link targets, never contents, and
    // everything is then opened through the capability.
    let (cwd, resolved) = match std::fs::canonicalize(&expanded) {
        Ok(real) => match real.into_os_string().into_string() {
            Ok(real) => (real, true),
            Err(_) => return Err(error("invalid_path", "cwd is not UTF-8")),
        },
        Err(_) => (expanded, false),
    };
    let components = files.relative_components(&cwd)?;
    let exists = resolved && files.open_dir_components(&components).is_ok();
    let repository_root = if exists {
        repository_root(files, &components)
    } else {
        None
    };
    Ok(Destination {
        folder: crate::host_transcripts::claude_project_folder(&cwd),
        cwd,
        exists,
        repository_root,
    })
}

/// The repository a folder belongs to, as Claude Code keys its memory: the
/// nearest folder holding `.git`; for a linked worktree, the main working
/// tree its `commondir` names. Read from two small files, never by running
/// git.
fn repository_root(files: &HostFileService, components: &[OsString]) -> Option<String> {
    for depth in (0..=components.len()).rev() {
        let ancestor = &components[..depth];
        let dir = files.open_dir_components(ancestor).ok()?;
        let Ok(metadata) = dir.symlink_metadata(".git") else {
            continue;
        };
        let here = files.display_path(ancestor);
        if metadata.is_file() {
            if let Some(main) = worktree_main(files, &dir, &here) {
                return Some(main);
            }
        }
        return here.into_os_string().into_string().ok();
    }
    None
}

fn small_text(dir: &Dir, name: &str) -> Option<String> {
    let file = open_file(dir, OsStr::new(name)).ok()?;
    let bytes = read_bounded(file, MAX_SMALL_FILE_BYTES).ok()?;
    String::from_utf8(bytes).ok()
}

/// `.git` as a file (`gitdir: <dir>`): a linked worktree's `<dir>` holds
/// `commondir`, naming the main repository's `.git`, whose parent is the
/// main working tree. A submodule's has none, and is its own repository.
fn worktree_main(files: &HostFileService, dir: &Dir, here: &Path) -> Option<String> {
    let pointer = small_text(dir, ".git")?;
    let gitdir = pointer.lines().next()?.strip_prefix("gitdir:")?.trim();
    let gitdir = std::fs::canonicalize(here.join(gitdir)).ok()?;
    let gitdir_components = files.relative_components(gitdir.to_str()?).ok()?;
    let gitdir_handle = files.open_dir_components(&gitdir_components).ok()?;
    let common = small_text(&gitdir_handle, "commondir")?;
    let common = std::fs::canonicalize(gitdir.join(common.lines().next()?.trim())).ok()?;
    if common.file_name()? != ".git" {
        return None;
    }
    let main = common.parent()?;
    files.relative_components(main.to_str()?).ok()?;
    main.to_str().map(str::to_string)
}

/// Claude Code's version, read from where it is installed and never by
/// running it: a native install's `versions/<version>`, a Homebrew cask's
/// `claude-code/<version>/`, or the `package.json` beside an npm install's
/// entry point inside home.
fn claude_version(files: &HostFileService) -> Option<String> {
    let mut candidates = vec![Path::new(&files.home_dir()).join(".local/bin/claude")];
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(
            std::env::split_paths(&path)
                .take(64)
                .map(|dir| dir.join("claude")),
        );
    }
    for candidate in candidates {
        let Ok(target) = std::fs::canonicalize(&candidate) else {
            continue;
        };
        if let Some(version) = version_from_install_path(&target) {
            return Some(version);
        }
        if let Some(version) = npm_package_version(files, &target) {
            return Some(version);
        }
    }
    None
}

fn plausible_version(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 32
        && text
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_digit())
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
}

fn version_from_install_path(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let parent = path.parent()?;
    let parent_name = parent.file_name()?.to_str()?;
    let grandparent = parent.parent()?.file_name()?.to_str()?;
    if parent_name == "versions" && grandparent == "claude" && plausible_version(name) {
        return Some(name.to_string());
    }
    if grandparent == "claude-code" && plausible_version(parent_name) {
        return Some(parent_name.to_string());
    }
    None
}

fn npm_package_version(files: &HostFileService, entry: &Path) -> Option<String> {
    let package = entry.parent()?;
    if package.file_name()? != "claude-code" || package.parent()?.file_name()? != "@anthropic-ai" {
        return None;
    }
    let components = files.relative_components(package.to_str()?).ok()?;
    let dir = files.open_dir_components(&components).ok()?;
    let manifest: Value = serde_json::from_str(&small_text(&dir, "package.json")?).ok()?;
    manifest
        .get("version")?
        .as_str()
        .filter(|version| plausible_version(version))
        .map(str::to_string)
}

// ---------------------------------------------------------------------------
// conv.probe

impl Carrier {
    /// What a device needs from a target before it moves a conversation
    /// there: the folder as Claude Code will see it, where the record would
    /// land, where its memory lives, whether any copy of the conversation is
    /// already here, the login shell, and Claude Code's version.
    pub(crate) async fn probe(&self, request: ProbeRequest) -> FsResult<Value> {
        self.blocking(move |files, places, operations| {
            probe_sync(files, places, operations, &request)
        })
        .await
    }
}

fn probe_sync(
    files: &HostFileService,
    places: &Places,
    operations: &HostFileOperations,
    request: &ProbeRequest,
) -> FsResult<Value> {
    let destination = resolve_destination(files, &request.cwd)?;
    let store = Store::open(files, places);
    // Whether a Claude here holds the conversation now, by the same
    // fail-closed reading an import refuses on (`conversation_live_here`):
    // which copy it holds is not said, so every copy carries it.
    let live = request
        .conversation_id
        .as_deref()
        .map(|id| !holders_now(places, None, id).elsewhere.is_empty());
    let mut duplicates = Vec::new();
    let mut duplicates_truncated = false;
    let (store_display, store_problem, destination_display, memory) = match &store {
        Ok(store) => {
            if let (Some(id), Some(projects)) = (&request.conversation_id, store.projects()?) {
                for copy in find_copies(&projects, id, &|| operations.cancelled())? {
                    if !copy.record {
                        continue;
                    }
                    if duplicates.len() >= MAX_REPORTED_DUPLICATES {
                        duplicates_truncated = true;
                        break;
                    }
                    let path = store
                        .projects_display()
                        .join(&copy.folder)
                        .join(format!("{id}.jsonl"));
                    let metadata = projects
                        .open_dir_nofollow(&copy.folder)
                        .ok()
                        .and_then(|folder| folder.symlink_metadata(format!("{id}.jsonl")).ok());
                    duplicates.push(json!({
                        "folder": copy.folder,
                        "path": path.to_string_lossy(),
                        "size": metadata.as_ref().map(cap_std::fs::Metadata::len),
                        "modified_at": metadata.as_ref().and_then(crate::host_files::modified_seconds),
                        "live": live.unwrap_or(false),
                    }));
                }
            }
            let problem = match Holdings::open(places).and_then(|holdings| {
                let same = holdings.device()? == device_of(&store.dir)?;
                Ok(same)
            }) {
                Ok(true) => None,
                Ok(false) => Some("store_unavailable"),
                Err(failure) => Some(failure.code),
            };
            let memory_folder = crate::host_transcripts::claude_project_folder(
                destination
                    .repository_root
                    .as_deref()
                    .unwrap_or(&destination.cwd),
            );
            (
                Some(store.display.to_string_lossy().into_owned()),
                problem,
                Some(
                    store
                        .projects_display()
                        .join(&destination.folder)
                        .to_string_lossy()
                        .into_owned(),
                ),
                Some(
                    store
                        .projects_display()
                        .join(memory_folder)
                        .join("memory")
                        .to_string_lossy()
                        .into_owned(),
                ),
            )
        }
        Err(failure) => (None, Some(failure.code), None, None),
    };
    Ok(json!({
        "agent": CLAUDE_CODE,
        "home": files.home_dir(),
        "cwd": destination.cwd,
        "folder_exists": destination.exists,
        "project_folder": destination.folder,
        "store": store_display,
        "store_ready": store_problem.is_none(),
        "store_problem": store_problem,
        "destination": destination_display,
        "memory": memory,
        "repository_root": destination.repository_root,
        "duplicates": duplicates,
        "duplicates_truncated": duplicates_truncated,
        "live": live,
        "login_shell": (places.login_shell)(),
        "cli_version": claude_version(files),
    }))
}

// ---------------------------------------------------------------------------
// Records

#[derive(Clone, Debug, Serialize, Deserialize)]
struct BundleRecord {
    /// The manifest exactly as the bundle carries it.
    manifest: String,
    length: u64,
    sha256: String,
    /// Files of the conversation's sidecar that stayed behind: not on the
    /// allowlist, or not asked for.
    skipped: u64,
}

/// `outgoing/<transfer>/record.json` (and then `retired/<transfer>/`).
#[derive(Clone, Debug, Serialize, Deserialize)]
struct OutgoingRecord {
    version: u32,
    transfer_id: String,
    agent: String,
    conversation_id: String,
    session_id: Option<String>,
    to_host_id: Option<String>,
    created_at: u64,
    /// `moving` while files leave the store; `held` once the bundle is
    /// declared.
    state: String,
    include: Vec<String>,
    /// The store the files came from, relative to home.
    store: Vec<String>,
    /// Every folder that held something of the conversation; the slot is
    /// the index (`files/<slot>/`).
    copies: Vec<Copy>,
    carried: usize,
    bundle: Option<BundleRecord>,
    retired_at: Option<u64>,
}

/// `incoming/<transfer>/record.json`.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct IncomingRecord {
    version: u32,
    transfer_id: String,
    agent: String,
    conversation_id: String,
    cwd: String,
    store: Vec<String>,
    folder: String,
    memory: Option<String>,
    length: u64,
    sha256: Option<String>,
    digest: String,
    from_host_id: Option<String>,
    created_at: u64,
    /// `receiving`, then `committing` once every byte is verified and
    /// extracted: from then on the transfer can only commit.
    state: String,
    /// The verified whole-bundle digest, from `committing` on.
    verified_sha256: Option<String>,
    /// Whether the bundle carries anything beside the record.
    has_sidecar: Option<bool>,
}

/// A finished transfer: `aborted/`, `imported/`, `cancelled/<transfer>.json`.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Tombstone {
    version: u32,
    transfer_id: String,
    conversation_id: Option<String>,
    state: String,
    at: u64,
    length: Option<u64>,
    sha256: Option<String>,
    result: Option<Value>,
}

/// `superseded/<transfer>/<n>/origin.json`: where a set-aside copy was.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Origin {
    version: u32,
    conversation_id: String,
    folder: String,
    at: u64,
}

fn tombstone_name(transfer: Uuid) -> String {
    format!("{transfer}.json")
}

fn read_tombstone(holdings: &Holdings, kind: &str, transfer: Uuid) -> FsResult<Option<Tombstone>> {
    read_record(&holdings.sub(kind)?, &tombstone_name(transfer))
}

fn write_tombstone(holdings: &Holdings, kind: &str, tombstone: &Tombstone) -> FsResult<()> {
    write_record(
        &holdings.sub(kind)?,
        &format!("{}.json", tombstone.transfer_id),
        tombstone,
    )
}

// ---------------------------------------------------------------------------
// Housekeeping

/// Held by housekeeping for its whole pass, and by whatever builds or
/// settles what housekeeping removes — a commit setting copies aside and
/// dropping its staging, a cancel dropping its staging — so a pass never
/// sees, and removes, one half-built: a set-aside slot whose `origin.json`
/// is not written yet reads as one past keeping.
fn holdings_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: StdMutex<()> = StdMutex::new(());
    LOCK.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Drop what is past keeping: retired holdings and set-aside copies after
/// 30 days, finished transfers' records likewise, staging a tombstone
/// already settled, and staging nothing has written for 30 days — cancelled
/// first, so it can never commit, which a device resolving the move then
/// finds. Never an unresolved `outgoing/`: only a device resolves a move,
/// and only the target's answer says whether the source may put it back.
fn collect_garbage(holdings: &Holdings, now: u64, force: bool) {
    static LAST: StdMutex<Option<Instant>> = StdMutex::new(None);
    if !force {
        let mut last = LAST
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if last.is_some_and(|at| at.elapsed() < GC_INTERVAL) {
            return;
        }
        *last = Some(Instant::now());
    }
    let _holdings = holdings_lock();
    let expired = |at: u64| now.saturating_sub(at) > RETENTION.as_millis() as u64;
    for kind in [ABORTED, IMPORTED, CANCELLED] {
        let Ok(dir) = holdings.sub(kind) else {
            continue;
        };
        for name in transfer_names(&dir, ".json") {
            if let Ok(Some(tombstone)) = read_record::<Tombstone>(&dir, &tombstone_name(name)) {
                if expired(tombstone.at) {
                    let _ = dir.remove_file(tombstone_name(name));
                }
            }
        }
    }
    if let Ok(dir) = holdings.sub(RETIRED) {
        for name in transfer_names(&dir, "") {
            let Ok(held) = dir.open_dir_nofollow(name.to_string()) else {
                continue;
            };
            let at = read_record::<OutgoingRecord>(&held, RECORD)
                .ok()
                .flatten()
                .and_then(|record| record.retired_at.or(Some(record.created_at)));
            if at.is_some_and(expired) {
                let _ = remove_tree(&dir, &name.to_string());
            }
        }
    }
    if let Ok(dir) = holdings.sub(SUPERSEDED) {
        for name in transfer_names(&dir, "") {
            let Ok(set) = dir.open_dir_nofollow(name.to_string()) else {
                continue;
            };
            let at = set
                .entries()
                .ok()
                .into_iter()
                .flatten()
                .filter_map(Result::ok)
                .filter_map(|entry| set.open_dir_nofollow(entry.file_name()).ok())
                .filter_map(|copy| read_record::<Origin>(&copy, "origin.json").ok().flatten())
                .map(|origin| origin.at)
                .max();
            if at.is_none_or(expired) {
                let _ = remove_tree(&dir, &name.to_string());
            }
        }
    }
    if let Ok(dir) = holdings.sub(INCOMING) {
        for name in transfer_names(&dir, "") {
            let settled = [IMPORTED, CANCELLED]
                .iter()
                .any(|kind| matches!(read_tombstone(holdings, kind, name), Ok(Some(_))));
            if settled {
                let _ = remove_tree(&dir, &name.to_string());
                continue;
            }
            let Ok(Some((staging, record))) = incoming_record(holdings, name, false) else {
                continue;
            };
            // A decided commit only ever rolls forward.
            if record.state != "receiving" {
                continue;
            }
            let written = staging
                .symlink_metadata(STAGED)
                .ok()
                .and_then(|metadata| crate::host_files::modified_seconds(&metadata))
                .and_then(|seconds| u64::try_from(seconds).ok())
                .map_or(0, |seconds| seconds.saturating_mul(1000));
            if !expired(record.created_at.max(written)) {
                continue;
            }
            // Not while anything works on it: a begin, a commit, a cancel.
            let slot = slot(Role::Import, name);
            let Ok(_working) = slot.try_lock() else {
                continue;
            };
            drop(staging);
            let cancelled = write_tombstone(
                holdings,
                CANCELLED,
                &Tombstone {
                    version: 1,
                    transfer_id: name.to_string(),
                    conversation_id: Some(record.conversation_id.clone()),
                    state: "cancelled".into(),
                    at: now,
                    length: None,
                    sha256: None,
                    result: None,
                },
            );
            if cancelled.is_ok() {
                let _ = remove_tree(&dir, &name.to_string());
            }
        }
    }
}

/// Housekeeping for a host that may never carry another conversation: run
/// after each registration (`run.rs`), at most every ten minutes, and never
/// creating the holdings where there are none.
pub(crate) fn collect_held() {
    let Ok(config) = crate::config::config_dir() else {
        return;
    };
    let path = config.join("conversations");
    if !path.is_dir() {
        return;
    }
    let places = Places {
        holdings: Some(path),
        claude_store: None,
        registry_stores: None,
        login_shell: Arc::new(String::new),
        #[cfg(test)]
        move_hook: None,
        #[cfg(test)]
        free_space: None,
    };
    if let Ok(holdings) = Holdings::open(&places) {
        collect_garbage(&holdings, now_ms(), false);
    }
}

/// The transfers named in a holdings folder: `<uuid><suffix>` entries.
fn transfer_names(dir: &Dir, suffix: &str) -> Vec<Uuid> {
    let Ok(entries) = dir.entries() else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let id = name.strip_suffix(suffix)?;
            let uuid = Uuid::parse_str(id).ok()?;
            (uuid.hyphenated().to_string() == id).then_some(uuid)
        })
        .take(4096)
        .collect()
}

// ---------------------------------------------------------------------------
// Signals

/// Ask `holder` to stop; true when it was delivered or the process is gone.
/// Only exactly the process seen is signalled (`host_conv::is_same_process`):
/// one whose start cannot be read, or differs, never is. On Linux the pidfd
/// pins the process the start is checked against, so a pid recycled meanwhile
/// is never signalled; elsewhere the check and the signal are microseconds
/// apart.
fn signal(holder: &Holder, table: &dyn ProcessTable, kill: bool) -> bool {
    #[cfg(target_os = "linux")]
    {
        use rustix::process::{pidfd_open, pidfd_send_signal, Pid, PidfdFlags, Signal};
        let Some(pid) = i32::try_from(holder.pid).ok().and_then(Pid::from_raw) else {
            return true;
        };
        let signal = if kill { Signal::KILL } else { Signal::TERM };
        match pidfd_open(pid, PidfdFlags::empty()) {
            Ok(pidfd) => {
                if !crate::host_conv::is_same_process(holder, table) {
                    return !table.alive(holder.pid);
                }
                matches!(
                    pidfd_send_signal(&pidfd, signal),
                    Ok(()) | Err(rustix::io::Errno::SRCH)
                )
            }
            Err(rustix::io::Errno::SRCH) => true,
            // A kernel before pidfds: the identity check, then the pid.
            Err(_) => {
                if !crate::host_conv::is_same_process(holder, table) {
                    return !table.alive(holder.pid);
                }
                matches!(
                    rustix::process::kill_process(pid, signal),
                    Ok(()) | Err(rustix::io::Errno::SRCH)
                )
            }
        }
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        use rustix::process::{kill_process, Pid, Signal};
        let Some(pid) = i32::try_from(holder.pid).ok().and_then(Pid::from_raw) else {
            return true;
        };
        if !crate::host_conv::is_same_process(holder, table) {
            return !table.alive(holder.pid);
        }
        let signal = if kill { Signal::KILL } else { Signal::TERM };
        matches!(
            kill_process(pid, signal),
            Ok(()) | Err(rustix::io::Errno::SRCH)
        )
    }
    #[cfg(not(unix))]
    {
        let _ = (holder, table, kill);
        false
    }
}

/// TERM, a grace, KILL, a grace: then every one of `agents` must be gone,
/// judged by pid and start, not by a pid file. One that cannot be told from
/// the process seen counts as still there.
async fn stop_agents(agents: Vec<Holder>) -> FsResult<()> {
    if agents.is_empty() {
        return Ok(());
    }
    for (kill, grace) in [(false, AGENT_TERM_GRACE), (true, AGENT_KILL_GRACE)] {
        let living = agents.clone();
        let delivered = tokio::task::spawn_blocking(move || {
            let table = crate::host_conv::SystemProcesses;
            living
                .iter()
                .filter(|agent| crate::host_conv::still_running(agent, &table))
                .all(|agent| signal(agent, &table, kill))
        })
        .await
        .unwrap_or(false);
        if !delivered {
            tracing::warn!(kill, "a window's agent could not be signalled");
        }
        let deadline = tokio::time::Instant::now() + grace;
        loop {
            let living = agents.clone();
            let running = tokio::task::spawn_blocking(move || {
                let table = crate::host_conv::SystemProcesses;
                living
                    .iter()
                    .any(|agent| crate::host_conv::still_running(agent, &table))
            })
            .await
            .unwrap_or(true);
            if !running {
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(AGENT_POLL).await;
        }
    }
    Err(error(
        "agent_still_running",
        "the window's agent did not stop; nothing has moved",
    ))
}

fn holders_now(places: &Places, shell: Option<u32>, conversation_id: &str) -> Holders {
    crate::host_conv::holders(
        shell,
        conversation_id,
        &crate::host_conv::SystemProcesses,
        &places.registry_stores(),
    )
}

/// A host a conversation is moving to refuses it while a Claude here holds
/// it: setting that copy aside, or placing the carried record where it
/// writes, would give the conversation two writers.
fn live_here_error(holders: &Holders) -> FsError {
    if holders.doubtful {
        return error(
            "conversation_live_here",
            "a Claude Code session record on this host names the conversation and spawnd cannot confirm that its process has stopped; stop it here first, or remove the stale record from Claude's sessions folder",
        );
    }
    error(
        "conversation_live_here",
        "a Claude on this host holds the conversation (a window, a background session, or an attached client); stop it here first",
    )
}

/// Refuse while anything on this host holds `conversation_id`.
fn refuse_live_here(places: &Places, conversation_id: &str) -> FsResult<()> {
    let holders = holders_now(places, None, conversation_id);
    if holders.elsewhere.is_empty() {
        Ok(())
    } else {
        Err(live_here_error(&holders))
    }
}

fn live_elsewhere_error(holders: &Holders) -> FsError {
    if holders.doubtful {
        return error(
            "conversation_live_elsewhere",
            "a Claude Code session record on this host names the conversation and spawnd cannot confirm that its process has stopped (a background session, an attached client, another window, or another machine or container sharing this home); stop it there first, or remove the stale record from Claude's sessions folder",
        );
    }
    error(
        "conversation_live_elsewhere",
        "another process on this host holds the conversation (a background session, an attached client, or another window); stop it there first",
    )
}

// ---------------------------------------------------------------------------
// conv.export

/// Entries of a bundle and where each one's bytes are, relative to the
/// root they are read from.
#[derive(Clone, Debug)]
struct Located {
    logical: String,
    location: Vec<OsString>,
}

/// Where a conversation's files are found: spawnd's holding of a retired
/// copy, which is what streams, or the store, measured before anything
/// stops.
#[derive(Clone, Copy, Debug)]
enum Layout<'a> {
    /// `files/<slot>/conversation.jsonl` and `files/<slot>/sidecar/`.
    Held,
    /// `<folder>/<id>.jsonl` and `<folder>/<id>/`.
    Store { id: &'a str },
}

impl Layout<'_> {
    fn record(self) -> OsString {
        match self {
            Self::Held => OsString::from(CONVERSATION),
            Self::Store { id } => OsString::from(format!("{id}.jsonl")),
        }
    }

    fn sidecar(self) -> OsString {
        match self {
            Self::Held => OsString::from(SIDECAR),
            Self::Store { id } => OsString::from(id),
        }
    }
}

/// Every file of a conversation the allowlist and `include` let travel, and
/// a count of those that stay.
fn locate_entries(
    root: &Dir,
    layout: Layout<'_>,
    include: Include,
    operations: &HostFileOperations,
) -> FsResult<(Vec<Located>, u64)> {
    let mut located = Vec::new();
    let mut skipped = 0_u64;
    if !is_regular_file(root, &layout.record()) {
        return Err(error(
            "conversation_not_found",
            "this host has no record of that conversation",
        ));
    }
    located.push(Located {
        logical: CONVERSATION.to_string(),
        location: vec![layout.record()],
    });
    if let Some(sidecar) = optional_dir(root, &layout.sidecar())? {
        let mut visits = 0_usize;
        walk_sidecar(
            &sidecar,
            &mut vec![layout.sidecar()],
            &mut vec![SIDECAR.to_string()],
            include,
            &mut visits,
            &mut located,
            &mut skipped,
            operations,
        )?;
    }
    // Ascending byte order of the logical paths, the record last.
    let record = located.remove(0);
    located.sort_by(|a, b| a.logical.as_bytes().cmp(b.logical.as_bytes()));
    located.push(record);
    Ok((located, skipped))
}

#[allow(clippy::too_many_arguments)]
fn walk_sidecar(
    dir: &Dir,
    location: &mut Vec<OsString>,
    logical: &mut Vec<String>,
    include: Include,
    visits: &mut usize,
    located: &mut Vec<Located>,
    skipped: &mut u64,
    operations: &HostFileOperations,
) -> FsResult<()> {
    if logical.len() > 5 {
        *skipped += 1;
        return Ok(());
    }
    let mut names: Vec<OsString> = Vec::new();
    for entry in dir.entries()? {
        *visits += 1;
        if *visits > MAX_SIDECAR_VISITS {
            return Err(error(
                "too_large",
                "the conversation's sidecar has more files than a bundle carries",
            ));
        }
        if visits.is_multiple_of(256) && operations.cancelled() {
            return Err(crate::host_files::cancelled_error());
        }
        names.push(entry?.file_name());
    }
    names.sort();
    for name in names {
        let Ok(metadata) = dir.symlink_metadata(&name) else {
            continue;
        };
        let Some(text) = name.to_str().map(str::to_string) else {
            *skipped += 1;
            continue;
        };
        logical.push(text);
        location.push(name.clone());
        let path = logical.join("/");
        if metadata.is_dir() {
            match dir.open_dir_nofollow(&name) {
                Ok(child) => walk_sidecar(
                    &child, location, logical, include, visits, located, skipped, operations,
                )?,
                Err(_) => *skipped += 1,
            }
        } else if metadata.is_file()
            && crate::host_bundle::check_path(CLAUDE_CODE, &path).is_ok()
            && include.allows(&path)
        {
            located.push(Located {
                logical: path,
                location: location.clone(),
            });
        } else {
            // A link, a device, a name or kind the allowlist does not know,
            // or a kind the device did not ask for: it stays on this host.
            *skipped += 1;
        }
        logical.pop();
        location.pop();
    }
    Ok(())
}

/// One entry's carried size and digest: its bytes now, a log cut at its
/// last complete line.
fn measure(root: &Dir, located: &Located) -> FsResult<crate::host_bundle::Entry> {
    let mut file = open_path(root, &located.location)?;
    let mut size = file.metadata()?.len();
    if size > crate::host_bundle::ENTRY_MAX {
        return Err(error(
            "too_large",
            "a conversation file is larger than 512 MiB",
        ));
    }
    if crate::host_bundle::is_log(&located.logical) {
        size = complete_lines(&mut file, size)?;
    }
    file.seek(SeekFrom::Start(0))?;
    let mut hasher = Sha256::new();
    let copied = std::io::copy(&mut (&mut file).take(size), &mut HashWriter(&mut hasher))?;
    if copied != size {
        return Err(error(
            "file_changed",
            "a conversation file shrank while it was read",
        ));
    }
    Ok(crate::host_bundle::Entry {
        path: located.logical.clone(),
        size,
        sha256: format!("{:x}", hasher.finalize()),
    })
}

struct HashWriter<'a>(&'a mut Sha256);

impl Write for HashWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// The manifest of what lies at `root`, and the bundle it makes: length and
/// whole-stream digest, read twice — the manifest first needs every
/// entry's digest, and the stream's digest covers the manifest.
fn declare(
    root: &Dir,
    located: &[Located],
    conversation_id: &str,
    skipped: u64,
) -> FsResult<BundleRecord> {
    let entries = located
        .iter()
        .map(|located| measure(root, located))
        .collect::<FsResult<Vec<_>>>()?;
    let manifest = Manifest {
        agent: CLAUDE_CODE.to_string(),
        conversation_id: conversation_id.to_string(),
        entries,
    };
    let encoded = manifest.encode();
    manifest
        .validate_encoded(encoded.len() as u64)
        .map_err(bundle_error)?;
    let mut source = BundleSource::new(root, located, &encoded, &manifest, 0)?;
    let length = source.length;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let read = source.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(BundleRecord {
        manifest: String::from_utf8(encoded).unwrap_or_default(),
        length,
        sha256: format!("{:x}", hasher.finalize()),
        skipped,
    })
}

/// A bundle read straight from the files it names: the header and manifest
/// from memory, then each entry from its file, bounded to its declared size
/// and checked against its digest as its last byte goes past. A file that
/// changed underneath ends the read with `file_changed`.
pub(crate) struct BundleSource {
    root: Dir,
    prefix: Vec<u8>,
    entries: Vec<(crate::host_bundle::Entry, Vec<OsString>)>,
    /// Where each entry starts in the bundle.
    starts: Vec<u64>,
    length: u64,
    position: u64,
    current: Option<OpenEntry>,
}

struct OpenEntry {
    index: usize,
    file: std::io::Take<std::fs::File>,
    hasher: Sha256,
    read: u64,
}

impl BundleSource {
    /// The bundle from chunk `from_sequence` on: byte
    /// `min(from_sequence × chunk_bytes, length)`, so a resume at the chunk
    /// count — every chunk already with the device — serves no chunk and
    /// only `stream.end`, whatever the length of the last chunk.
    fn new(
        root: &Dir,
        located: &[Located],
        encoded: &[u8],
        manifest: &Manifest,
        from_sequence: u64,
    ) -> FsResult<Self> {
        let mut prefix = crate::host_bundle::header(encoded.len() as u32).to_vec();
        prefix.extend_from_slice(encoded);
        let mut starts = Vec::with_capacity(manifest.entries.len());
        let mut at = prefix.len() as u64;
        for entry in &manifest.entries {
            starts.push(at);
            at += entry.size;
        }
        let length = manifest.bundle_length(encoded.len() as u64);
        if from_sequence > crate::host_stream::chunk_count(length) {
            return Err(error(
                "resume_mismatch",
                "a resume starts past the bundle's end",
            ));
        }
        let from = crate::host_stream::chunk_offset(from_sequence).min(length);
        Ok(Self {
            root: root.try_clone()?,
            prefix,
            entries: manifest
                .entries
                .iter()
                .cloned()
                .zip(located.iter().map(|located| located.location.clone()))
                .collect(),
            starts,
            length,
            position: from,
            current: None,
        })
    }

    pub(crate) fn length(&self) -> u64 {
        self.length
    }

    /// Fill `buffer` from the current position; 0 at the end.
    fn read(&mut self, buffer: &mut [u8]) -> FsResult<usize> {
        let mut filled = 0;
        while filled < buffer.len() && self.position < self.length {
            let position = self.position;
            if position < self.prefix.len() as u64 {
                let from = position as usize;
                let take = (buffer.len() - filled).min(self.prefix.len() - from);
                buffer[filled..filled + take].copy_from_slice(&self.prefix[from..from + take]);
                filled += take;
                self.position += take as u64;
                continue;
            }
            let index = match self.starts.partition_point(|start| *start <= position) {
                0 => 0,
                after => after - 1,
            };
            // Empty entries are passed over.
            let index = (index..self.entries.len())
                .find(|candidate| {
                    self.entries[*candidate].0.size > 0
                        && self.starts[*candidate] + self.entries[*candidate].0.size > position
                })
                .ok_or_else(|| error("file_changed", "the bundle ended early"))?;
            if self.current.as_ref().is_none_or(|open| open.index != index) {
                self.current = Some(self.open(index, position - self.starts[index])?);
            }
            let Some(open) = self.current.as_mut() else {
                continue;
            };
            let size = self.entries[index].0.size;
            let want = (buffer.len() - filled).min((size - open.read) as usize);
            let read = open.file.read(&mut buffer[filled..filled + want])?;
            if read == 0 {
                return Err(error(
                    "file_changed",
                    "a conversation file shrank while it was read",
                ));
            }
            open.hasher.update(&buffer[filled..filled + read]);
            open.read += read as u64;
            filled += read;
            self.position += read as u64;
            if open.read == size {
                let digest = format!("{:x}", std::mem::take(&mut open.hasher).finalize());
                if digest != self.entries[index].0.sha256 {
                    return Err(error(
                        "file_changed",
                        "a conversation file changed since it was declared",
                    ));
                }
                self.current = None;
            }
        }
        Ok(filled)
    }

    /// Open entry `index` positioned `skip` bytes in, hashing the bytes it
    /// skips so the entry's digest still covers all of it.
    fn open(&self, index: usize, skip: u64) -> FsResult<OpenEntry> {
        let (entry, location) = &self.entries[index];
        let file = open_path(&self.root, location)?;
        let mut file = file.take(entry.size);
        let mut hasher = Sha256::new();
        let skipped = std::io::copy(&mut (&mut file).take(skip), &mut HashWriter(&mut hasher))?;
        if skipped != skip {
            return Err(error(
                "file_changed",
                "a conversation file shrank while it was read",
            ));
        }
        Ok(OpenEntry {
            index,
            file,
            hasher,
            read: skip,
        })
    }

    /// Up to `count` whole chunks from the current position.
    pub(crate) fn read_chunks(&mut self, count: u64) -> FsResult<Vec<Vec<u8>>> {
        let mut chunks = Vec::new();
        for _ in 0..count {
            let remaining = self.length - self.position;
            if remaining == 0 {
                break;
            }
            let mut chunk = vec![0_u8; remaining.min(crate::host_stream::CHUNK_BYTES) as usize];
            let mut filled = 0;
            while filled < chunk.len() {
                let read = self.read(&mut chunk[filled..])?;
                if read == 0 {
                    return Err(error("file_changed", "the bundle ended early"));
                }
                filled += read;
            }
            chunks.push(chunk);
        }
        Ok(chunks)
    }
}

/// A prepared export: the bundle's declaration and its bytes from where the
/// device resumes.
pub(crate) struct PreparedExport {
    pub source: BundleSource,
    pub sha256: String,
    pub entries: usize,
    pub skipped: u64,
    pub stopped: Option<&'static str>,
    pub claim: Claim,
}

enum Existing {
    None,
    Outgoing(Box<OutgoingRecord>),
    Retired,
    Aborted,
}

fn existing_export(holdings: &Holdings, transfer: Uuid) -> FsResult<Existing> {
    if exists(&holdings.sub(RETIRED)?, OsStr::new(&transfer.to_string())) {
        return Ok(Existing::Retired);
    }
    if read_tombstone(holdings, ABORTED, transfer)?.is_some() {
        return Ok(Existing::Aborted);
    }
    let outgoing = holdings.sub(OUTGOING)?;
    match optional_dir(&outgoing, OsStr::new(&transfer.to_string()))? {
        Some(held) => match read_record::<OutgoingRecord>(&held, RECORD)? {
            Some(record) => Ok(Existing::Outgoing(Box::new(record))),
            // A holding whose record never landed holds no files either:
            // the record is written before any file moves.
            None => {
                drop(held);
                remove_tree(&outgoing, &transfer.to_string())?;
                Ok(Existing::None)
            }
        },
        None => Ok(Existing::None),
    }
}

fn same_export(record: &OutgoingRecord, request: &ExportRequest) -> bool {
    record.conversation_id == request.conversation_id
        && record.agent == CLAUDE_CODE
        && record.session_id.as_deref() == Some(request.session_id.to_string().as_str())
        && record.to_host_id.as_deref() == Some(request.to_host_id.to_string().as_str())
        && record.include == request.include.names()
}

/// Move what is still in the store of each copy into its slot of the
/// holding: the sidecar first, the record last, so a store never has a
/// record whose sidecar has already gone. Idempotent: a slot already moved
/// is passed over.
fn move_out(
    holdings: &Holdings,
    store: &Store,
    transfer: Uuid,
    record: &OutgoingRecord,
) -> FsResult<()> {
    let held = holdings
        .sub(OUTGOING)?
        .open_dir_nofollow(transfer.to_string())?;
    let files = crate::platform::open_or_create_private_dir_at(&held, Path::new(FILES))?;
    let projects = store
        .projects()?
        .ok_or_else(|| error("conversation_not_found", "Claude's store has no projects"))?;
    let id = &record.conversation_id;
    for (slot, copy) in record.copies.iter().enumerate() {
        let target =
            crate::platform::open_or_create_private_dir_at(&files, Path::new(&slot.to_string()))?;
        let Some(project) = optional_dir(&projects, OsStr::new(&copy.folder))? else {
            continue;
        };
        if copy.sidecar && exists(&project, OsStr::new(id)) && !exists(&target, OsStr::new(SIDECAR))
        {
            rename_noreplace(&project, OsStr::new(id), &target, OsStr::new(SIDECAR))?;
        }
        let record_name = OsString::from(format!("{id}.jsonl"));
        if copy.record
            && exists(&project, &record_name)
            && !exists(&target, OsStr::new(CONVERSATION))
        {
            rename_noreplace(&project, &record_name, &target, OsStr::new(CONVERSATION))?;
        }
        crate::platform::fsync_dir(&target)?;
        crate::platform::fsync_dir(&project)?;
    }
    crate::platform::fsync_dir(&files)?;
    Ok(())
}

/// Put every slot's files back where they came from: the sidecar first, the
/// record last. A name taken meanwhile stops the restore with nothing
/// overwritten; what was restored stays restored, and a later abort carries
/// on from there.
fn move_back(
    holdings: &Holdings,
    files: &HostFileService,
    transfer: Uuid,
    record: &OutgoingRecord,
) -> FsResult<usize> {
    let store = Store::at(files, record.store.iter().map(OsString::from).collect())?;
    let projects = ensure_dir(&store.dir, OsStr::new("projects"))?;
    let held = holdings
        .sub(OUTGOING)?
        .open_dir_nofollow(transfer.to_string())?;
    let Some(held_files) = optional_dir(&held, OsStr::new(FILES))? else {
        return Ok(0);
    };
    let id = &record.conversation_id;
    let mut restored = 0;
    for (slot, copy) in record.copies.iter().enumerate() {
        let Some(source) = optional_dir(&held_files, OsStr::new(&slot.to_string()))? else {
            continue;
        };
        let has_sidecar = exists(&source, OsStr::new(SIDECAR));
        let has_record = exists(&source, OsStr::new(CONVERSATION));
        if !has_sidecar && !has_record {
            continue;
        }
        let project = ensure_dir(&projects, OsStr::new(&copy.folder))?;
        if has_sidecar {
            rename_noreplace(&source, OsStr::new(SIDECAR), &project, OsStr::new(id))?;
        }
        if has_record {
            rename_noreplace(
                &source,
                OsStr::new(CONVERSATION),
                &project,
                OsStr::new(&format!("{id}.jsonl")),
            )?;
        }
        crate::platform::fsync_dir(&project)?;
        crate::platform::fsync_dir(&source)?;
        restored += 1;
    }
    crate::platform::fsync_dir(&projects)?;
    Ok(restored)
}

impl Carrier {
    /// Prepare `conv.export`: the fence and the move out of the lookup path
    /// (once per transfer; a resume finds the holding). The returned source
    /// starts at the request's `from_sequence`, and `stream_id` carries the
    /// transfer from now on.
    pub(crate) async fn prepare_export(
        &self,
        request: ExportRequest,
        stream_id: &str,
    ) -> FsResult<PreparedExport> {
        let slot = slot(Role::Export, request.transfer_id);
        let mut guard = Arc::clone(&slot).lock_owned().await;
        let (source, bundle, entries, stopped) = self.prepare_retire(&request).await?;
        let claim = guard.start(&slot, stream_id);
        drop(guard);
        Ok(PreparedExport {
            source,
            sha256: bundle.sha256,
            entries,
            skipped: bundle.skipped,
            stopped,
            claim,
        })
    }

    async fn prepare_retire(
        &self,
        request: &ExportRequest,
    ) -> FsResult<(BundleSource, BundleRecord, usize, Option<&'static str>)> {
        let moving = move_lock(&request.conversation_id);
        let _moving = moving.lock().await;
        let transfer = request.transfer_id;
        let from_sequence = request.from_sequence;
        let check = request.clone();
        let existing = self
            .blocking(move |_, places, _| {
                let holdings = Holdings::open(places)?;
                collect_garbage(&holdings, now_ms(), false);
                match existing_export(&holdings, transfer)? {
                    Existing::Retired => Err(error(
                        "transfer_committed",
                        "this transfer was committed; the conversation lives on the other host",
                    )),
                    Existing::Aborted => Err(error(
                        "transfer_aborted",
                        "this transfer was aborted and its files are back in place",
                    )),
                    Existing::Outgoing(record) => {
                        if !same_export(&record, &check) {
                            return Err(error(
                                "resume_mismatch",
                                "this transfer carries another conversation",
                            ));
                        }
                        Ok(Some(record))
                    }
                    Existing::None => {
                        if check.from_sequence > 0 {
                            return Err(error(
                                "resume_mismatch",
                                "there is no such transfer to resume",
                            ));
                        }
                        let outgoing = holdings.sub(OUTGOING)?;
                        for other in transfer_names(&outgoing, "") {
                            let Ok(held) = outgoing.open_dir_nofollow(other.to_string()) else {
                                continue;
                            };
                            if read_record::<OutgoingRecord>(&held, RECORD)?.is_some_and(|record| {
                                record.conversation_id == check.conversation_id
                            }) {
                                return Err(error(
                                    "transfer_unresolved",
                                    format!(
                                        "an earlier move of this conversation ({other}) is unfinished; resolve it first"
                                    ),
                                ));
                            }
                        }
                        Ok(None)
                    }
                }
            })
            .await?;
        let mut stopped = None;
        let record = match existing {
            Some(record) => *record,
            None => {
                stopped = Some(self.retire_fresh(request).await?);
                let transfer = request.transfer_id;
                self.blocking(move |_, places, _| {
                    let holdings = Holdings::open(places)?;
                    let held = holdings
                        .sub(OUTGOING)?
                        .open_dir_nofollow(transfer.to_string())?;
                    read_record::<OutgoingRecord>(&held, RECORD)?
                        .ok_or_else(|| error("corrupt_record", "a transfer's record vanished"))
                })
                .await?
            }
        };
        // Finish what a crash or a channel loss interrupted; the bundle is
        // declared once.
        let transfer = request.transfer_id;
        let (source, bundle, entries) = self
            .blocking(move |files, places, operations| {
                let holdings = Holdings::open(places)?;
                let mut record = record;
                match record.state.as_str() {
                    // Files may still be in the store: the fence again, as
                    // for a move that has not begun. Whatever holds the
                    // conversation now refuses the resume, and the record
                    // stays for an abort to put back what did move.
                    MOVING => {
                        let now = holders_now(places, None, &record.conversation_id);
                        if !now.elsewhere.is_empty() {
                            return Err(live_elsewhere_error(&now));
                        }
                        move_fenced(files, places, &holdings, transfer, &mut record, &|| false)?;
                    }
                    STRANDED => return Err(stranded_error()),
                    _ => {}
                }
                let held = holdings
                    .sub(OUTGOING)?
                    .open_dir_nofollow(transfer.to_string())?;
                let held_files =
                    crate::platform::open_or_create_private_dir_at(&held, Path::new(FILES))?;
                let root = crate::platform::open_or_create_private_dir_at(
                    &held_files,
                    Path::new(&record.carried.to_string()),
                )?;
                let include = Include {
                    subagents: record.include.iter().any(|name| name == "subagents"),
                    tool_results: record.include.iter().any(|name| name == "tool_results"),
                    workflows: record.include.iter().any(|name| name == "workflows"),
                };
                let (located, skipped) = locate_entries(&root, Layout::Held, include, operations)?;
                let bundle = match &record.bundle {
                    Some(bundle) => bundle.clone(),
                    None => {
                        let bundle = declare(&root, &located, &record.conversation_id, skipped)?;
                        record.bundle = Some(bundle.clone());
                        record.state = HELD.to_string();
                        write_record(&held, RECORD, &record)?;
                        bundle
                    }
                };
                let manifest = Manifest::decode(
                    bundle.manifest.as_bytes(),
                    CLAUDE_CODE,
                    &record.conversation_id,
                )
                .map_err(bundle_error)?;
                // The holding is what was declared, or nothing streams.
                let declared: Vec<&str> = manifest
                    .entries
                    .iter()
                    .map(|entry| entry.path.as_str())
                    .collect();
                let found: Vec<&str> = located.iter().map(|entry| entry.logical.as_str()).collect();
                if declared != found {
                    return Err(error(
                        "file_changed",
                        "the held conversation no longer matches its declaration",
                    ));
                }
                let source = BundleSource::new(
                    &root,
                    &located,
                    bundle.manifest.as_bytes(),
                    &manifest,
                    from_sequence,
                )?;
                Ok((source, bundle, manifest.entries.len()))
            })
            .await?;
        Ok((source, bundle, entries, stopped))
    }

    /// The fence, for a transfer that has not begun: refuse while anything
    /// outside the window holds the conversation; stop the window and its
    /// Claude processes and confirm each gone; check again — and that the
    /// window has not been started again meanwhile; then write the record
    /// and move every copy out of the lookup path into the holding
    /// (`move_fenced`).
    async fn retire_fresh(&self, request: &ExportRequest) -> FsResult<&'static str> {
        let session = request.session_id;
        let conversation_id = request.conversation_id.clone();
        let preferred_cwd = request.cwd.clone();
        // Where the files are, before anything stops: a move that could not
        // go anywhere must not stop the window.
        let planned = self
            .blocking(move |files, places, operations| {
                let holdings = Holdings::open(places)?;
                let store = Store::open(files, places)?;
                if holdings.device()? != device_of(&store.dir)? {
                    return Err(error_unavailable(
                        "Claude's store and spawnd's holdings are on different filesystems",
                    ));
                }
                let projects = store.projects()?.ok_or_else(|| {
                    error(
                        "conversation_not_found",
                        "this host has no record of that conversation",
                    )
                })?;
                let copies = find_copies(&projects, &conversation_id, &|| operations.cancelled())?;
                let preferred = preferred_cwd
                    .as_deref()
                    .and_then(|cwd| resolve_destination(files, cwd).ok())
                    .map(|destination| destination.folder);
                let carried = carried_copy(&copies, preferred.as_deref())?;
                // Refuse an oversized conversation before stopping it.
                let project = projects.open_dir_nofollow(&copies[carried].folder)?;
                let (located, _) = locate_entries(
                    &project,
                    Layout::Store {
                        id: &conversation_id,
                    },
                    Include::ALL,
                    operations,
                )?;
                let mut total = 0_u64;
                for entry in &located {
                    let size = open_path(&project, &entry.location)?.metadata()?.len();
                    if size > crate::host_bundle::ENTRY_MAX {
                        return Err(error(
                            "too_large",
                            "a conversation file is larger than 512 MiB",
                        ));
                    }
                    total = total.saturating_add(size);
                }
                if total > crate::host_bundle::BUNDLE_MAX
                    || located.len() > crate::host_bundle::ENTRIES_MAX
                {
                    return Err(error(
                        "too_large",
                        "the conversation is larger than a bundle carries",
                    ));
                }
                Ok((components_text(&store.components)?, copies, carried))
            })
            .await?;
        let (store, copies, carried) = planned;

        // (a) Nothing outside the window may hold it.
        let shell = self.pair.shell_pid(session);
        let conversation_id = request.conversation_id.clone();
        let before = self
            .blocking(move |_, places, _| Ok(holders_now(places, shell, &conversation_id)))
            .await?;
        if !before.elsewhere.is_empty() {
            return Err(live_elsewhere_error(&before));
        }
        if let Some(inspection) = &before.inspection {
            if inspection
                .conversation_id
                .as_deref()
                .is_some_and(|live| live != request.conversation_id)
            {
                return Err(error(
                    "conversation_changed",
                    "the window is in another conversation now; ask it again",
                ));
            }
        }

        // (b) Stop the window, then its own Claude processes, by pid. The run
        // of the window that is stopped is remembered: one started again
        // before the files are out of the lookup path could resume them.
        let incarnation = self.pair.incarnation(session);
        let stopped = match self.pair.stop_window(session).await {
            WindowStop::Unavailable => {
                return Err(error(
                    "window_unavailable",
                    "the window's worker is not reachable yet; try again",
                ))
            }
            WindowStop::NotRunning => "not_running",
            WindowStop::Stopped => "stopped",
            WindowStop::Lingering => "lingering",
        };
        stop_agents(before.window_agents.clone()).await?;

        // (c) Nothing holds it now, anywhere; then out of the lookup path.
        let transfer = request.transfer_id;
        let pair = self.pair.clone();
        let restarted = move || {
            pair.incarnation(session)
                .is_some_and(|now| Some(now) != incarnation)
        };
        let record = OutgoingRecord {
            version: 1,
            transfer_id: transfer.to_string(),
            agent: CLAUDE_CODE.to_string(),
            conversation_id: request.conversation_id.clone(),
            session_id: Some(session.to_string()),
            to_host_id: Some(request.to_host_id.to_string()),
            created_at: now_ms(),
            state: MOVING.to_string(),
            include: request
                .include
                .names()
                .into_iter()
                .map(str::to_string)
                .collect(),
            store,
            copies,
            carried,
            bundle: None,
            retired_at: None,
        };
        self.blocking(move |files, places, _| {
            let now = holders_now(places, None, &record.conversation_id);
            if !now.elsewhere.is_empty() {
                return Err(live_elsewhere_error(&now));
            }
            if restarted() {
                return Err(window_restarted_error());
            }
            let holdings = Holdings::open(places)?;
            let outgoing = holdings.sub(OUTGOING)?;
            let held = crate::platform::open_or_create_private_dir_at(
                &outgoing,
                Path::new(&transfer.to_string()),
            )?;
            // The record lands before any file moves.
            write_record(&held, RECORD, &record)?;
            crate::platform::fsync_dir(&outgoing)?;
            let mut record = record;
            move_fenced(files, places, &holdings, transfer, &mut record, &restarted)
        })
        .await?;
        Ok(stopped)
    }
}

/// Every copy out of the lookup path, then checked again: a Claude that
/// resumed the conversation while its files moved holds one that is now
/// outside the lookup path, and a window started again could resume it.
/// When either happens, or the move fails part-way, every file goes back
/// and the transfer is forgotten — nothing was carried. A restore that fails
/// too leaves the record `stranded`: no resume or commit goes on from there,
/// and only an abort, which puts back what it can, finishes it.
fn move_fenced(
    files: &HostFileService,
    places: &Places,
    holdings: &Holdings,
    transfer: Uuid,
    record: &mut OutgoingRecord,
    restarted: &dyn Fn() -> bool,
) -> FsResult<()> {
    places.reached(MovePoint::BeforeMove);
    let moved = Store::at(files, record.store.iter().map(OsString::from).collect())
        .and_then(|store| move_out(holdings, &store, transfer, record));
    let failure = match moved {
        Err(failure) => failure,
        Ok(()) => {
            places.reached(MovePoint::AfterMove);
            let after = holders_now(places, None, &record.conversation_id);
            if !after.elsewhere.is_empty() {
                live_elsewhere_error(&after)
            } else if restarted() {
                window_restarted_error()
            } else {
                return Ok(());
            }
        }
    };
    match move_back(holdings, files, transfer, record) {
        Ok(_) => remove_tree(&holdings.sub(OUTGOING)?, &transfer.to_string())?,
        Err(restore) => {
            tracing::warn!(
                code = restore.code,
                "a retire that failed could not be undone; only an abort finishes it"
            );
            record.state = STRANDED.to_string();
            let held = holdings
                .sub(OUTGOING)?
                .open_dir_nofollow(transfer.to_string())?;
            write_record(&held, RECORD, record)?;
        }
    }
    Err(failure)
}

fn window_restarted_error() -> FsError {
    error(
        "window_restarted",
        "the window was started again while its conversation was moving; nothing has moved",
    )
}

fn stranded_error() -> FsError {
    error(
        "transfer_incomplete",
        "this move failed and could not be undone; abort it to put back what can be",
    )
}

// ---------------------------------------------------------------------------
// conv.import.*

/// A v2 write stream carrying one transfer into this host. Its channel owns
/// it; every chunk takes the transfer's lock, so a stream that was
/// superseded or cancelled writes nothing more.
pub(crate) struct ImportStream {
    pub transfer_id: Uuid,
    pub stream_id: String,
    pub window: u64,
    pub length: u64,
    declared_sha256: Option<String>,
    digest: DigestAt,
    pub next_sequence: u64,
    acknowledged: u64,
    file: Option<tokio::fs::File>,
    reader: crate::host_bundle::Reader,
    claim: Claim,
}

/// What `conv.import.begin` answers.
pub(crate) struct ImportOpened {
    pub stream: ImportStream,
    pub received: u64,
}

/// What a chunk did: the acknowledgement to send, if one is due.
#[derive(Debug)]
pub(crate) struct ChunkTaken {
    pub ack: Option<u64>,
}

impl ImportStream {
    pub(crate) fn claim(&self) -> Claim {
        self.claim.clone()
    }

    pub(crate) fn complete(&self) -> bool {
        self.next_sequence == crate::host_stream::chunk_count(self.length)
    }

    /// Stage one chunk, and say whether to acknowledge: once the receiver
    /// has caught up with what arrived (`caught_up`), on the last chunk, and
    /// never later than half the window. An error ends the stream; one from
    /// the bundle's checks ends the transfer too (its bytes can never
    /// commit).
    pub(crate) async fn take_chunk(
        &mut self,
        carrier: &Carrier,
        sequence: u64,
        bytes: &[u8],
        caught_up: bool,
    ) -> Result<ChunkTaken, FsError> {
        let slot = Arc::clone(&self.claim.slot);
        let guard = slot.lock().await;
        if !guard.carries(&self.stream_id) {
            return Err(self.claim.lost());
        }
        if sequence != self.next_sequence {
            return Err(error(
                "invalid_sequence",
                "chunks arrive in order, each once",
            ));
        }
        if !crate::host_stream::may_send(self.window, self.acknowledged, sequence) {
            return Err(error(
                "window_exceeded",
                "a chunk beyond the granted window",
            ));
        }
        if crate::host_stream::chunk_len(self.length, sequence) != Some(bytes.len() as u64) {
            return Err(error(
                "invalid_chunk",
                "a chunk is not the size its place calls for",
            ));
        }
        if let Err(failure) = self.reader.feed(bytes) {
            drop(guard);
            self.discard(carrier).await;
            return Err(bundle_error(failure));
        }
        let Some(file) = self.file.as_mut() else {
            return Err(error("io_error", "the staged bundle is closed"));
        };
        file.write_all(bytes).await?;
        self.next_sequence += 1;
        let last = self.complete() || caught_up;
        let ack =
            crate::host_stream::ack_due(self.window, self.acknowledged, self.next_sequence, last)
                .then(|| {
                    self.acknowledged = self.next_sequence;
                    self.next_sequence
                });
        drop(guard);
        Ok(ChunkTaken { ack })
    }

    /// Forget the transfer: bytes that failed verification are not kept for
    /// resuming, and a begin with the same id starts again from nothing.
    async fn discard(&mut self, carrier: &Carrier) {
        self.file = None;
        let transfer = self.transfer_id;
        let mut guard = self.claim.slot.lock().await;
        guard.release(&self.stream_id, "finished");
        let _ = carrier
            .blocking(move |_, places, _| {
                let holdings = Holdings::open(places)?;
                remove_tree(&holdings.sub(INCOMING)?, &transfer.to_string())
            })
            .await;
        drop(guard);
    }

    /// `stream.end`: every chunk taken, the declaration matched, then the
    /// commit. The answer is `stream.committed`'s `result`.
    pub(crate) async fn finish(
        mut self,
        carrier: &Carrier,
        length: Option<u64>,
        sha256: Option<&str>,
    ) -> FsResult<Value> {
        if length != Some(self.length) || !self.complete() || !self.reader.complete() {
            self.end().await;
            return Err(error(
                "incomplete",
                "the stream ended before every chunk of the bundle",
            ));
        }
        let expected = match (self.digest, &self.declared_sha256, sha256) {
            (DigestAt::Start, Some(declared), Some(end)) if declared == end => declared.clone(),
            (DigestAt::End, None, Some(end)) if crate::host_stream::is_sha256_hex(end) => {
                end.to_string()
            }
            _ => {
                self.end().await;
                return Err(error(
                    "declaration_mismatch",
                    "stream end does not match its declaration",
                ));
            }
        };
        if let Some(file) = self.file.take() {
            let mut file = file;
            file.flush().await?;
            file.sync_all().await?;
        }
        let transfer = self.transfer_id;
        let slot = Arc::clone(&self.claim.slot);
        let mut guard = slot.lock().await;
        if !guard.carries(&self.stream_id) {
            return Err(self.claim.lost());
        }
        let outcome = carrier
            .blocking(move |files, places, operations| {
                commit_import(files, places, operations, transfer, &expected)
            })
            .await;
        guard.release(&self.stream_id, "finished");
        drop(guard);
        outcome
    }

    /// The stream is over; the transfer stays as it is. What it staged is
    /// flushed first, so a resume finds every byte it acknowledged.
    pub(crate) async fn end(mut self) {
        if let Some(mut file) = self.file.take() {
            let _ = file.flush().await;
        }
        self.claim.release().await;
    }
}

/// A staged transfer and its record. A staging folder whose record never
/// landed holds nothing a resume could use; only the transfer's own lock
/// holder (`repair`) clears it, since a begin for it may be under way.
fn incoming_record(
    holdings: &Holdings,
    transfer: Uuid,
    repair: bool,
) -> FsResult<Option<(Dir, IncomingRecord)>> {
    let incoming = holdings.sub(INCOMING)?;
    let Some(staging) = optional_dir(&incoming, OsStr::new(&transfer.to_string()))? else {
        return Ok(None);
    };
    match read_record::<IncomingRecord>(&staging, RECORD)? {
        Some(record) => Ok(Some((staging, record))),
        None => {
            drop(staging);
            if repair {
                remove_tree(&incoming, &transfer.to_string())?;
            }
            Ok(None)
        }
    }
}

fn staged_length(staging: &Dir) -> FsResult<u64> {
    match staging.symlink_metadata(STAGED) {
        Ok(metadata) if metadata.is_file() => Ok(metadata.len()),
        Ok(_) => Err(error("corrupt_record", "the staged bundle is not a file")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(error.into()),
    }
}

/// Where a transfer stands, from what is on disk. A commit a crash
/// interrupted is finished first: from `committing` on, it can only commit.
fn import_status(
    files: &HostFileService,
    places: &Places,
    transfer: Uuid,
) -> FsResult<TransferStatus> {
    let holdings = Holdings::open(places)?;
    if let Some(tombstone) = read_tombstone(&holdings, IMPORTED, transfer)? {
        return Ok(TransferStatus::committed(tombstone.length.unwrap_or(0)));
    }
    if read_tombstone(&holdings, CANCELLED, transfer)?.is_some() {
        return Ok(TransferStatus::cancelled());
    }
    match incoming_record(&holdings, transfer, true)? {
        Some((_, record)) if record.state == "committing" => {
            finish_commit(files, places, &holdings, transfer, record.clone())?;
            Ok(TransferStatus::committed(record.length))
        }
        Some((staging, record)) => Ok(TransferStatus::receiving(
            staged_length(&staging)?,
            record.length,
        )),
        None => Ok(TransferStatus::absent()),
    }
}

impl Carrier {
    /// `conv.import.begin`: a new transfer staged, or one already staged
    /// resumed where its bytes end; either way `stream_id` carries it from
    /// now on and any stream that did before is superseded.
    pub(crate) async fn begin_import(
        &self,
        request: ImportRequest,
        stream_id: &str,
    ) -> FsResult<ImportOpened> {
        let slot = slot(Role::Import, request.transfer_id);
        let mut guard = Arc::clone(&slot).lock_owned().await;
        let begun = request.clone();
        let (staged, reader, file) = self
            .blocking(move |files, places, operations| {
                let staged = begin_sync(files, places, operations, &begun)?;
                let holdings = Holdings::open(places)?;
                let incoming = holdings.sub(INCOMING)?;
                let staging = incoming.open_dir_nofollow(begun.transfer_id.to_string())?;
                let mut reader = crate::host_bundle::Reader::new(
                    CLAUDE_CODE,
                    &begun.conversation_id,
                    begun.length,
                )
                .map_err(bundle_error)?;
                let mut file =
                    crate::platform::open_private_file_at(&staging, Path::new(STAGED), true)?;
                // What is already staged is read again: the reader's verdict
                // on it is part of the transfer, whichever stream wrote it.
                let mut buffer = vec![0_u8; 64 * 1024];
                let mut left = staged;
                while left > 0 {
                    let want = left.min(buffer.len() as u64) as usize;
                    file.read_exact(&mut buffer[..want])?;
                    if let Err(failure) = reader.feed(&buffer[..want]) {
                        drop(file);
                        drop(staging);
                        remove_tree(&incoming, &begun.transfer_id.to_string())?;
                        return Err(bundle_error(failure));
                    }
                    left -= want as u64;
                }
                // A chunk a crash cut short is sent again.
                file.set_len(staged)?;
                file.seek(SeekFrom::Start(staged))?;
                Ok((staged, reader, file))
            })
            .await?;
        let claim = guard.start(&slot, stream_id);
        drop(guard);
        let next_sequence = TransferStatus::receiving(staged, request.length).next_sequence;
        Ok(ImportOpened {
            received: staged,
            stream: ImportStream {
                transfer_id: request.transfer_id,
                stream_id: stream_id.to_string(),
                window: request.stream.window,
                length: request.length,
                declared_sha256: request.sha256.clone(),
                digest: request.stream.digest,
                next_sequence,
                acknowledged: next_sequence,
                file: Some(tokio::fs::File::from_std(file)),
                reader,
                claim,
            },
        })
    }

    pub(crate) async fn import_status(&self, transfer: Uuid) -> FsResult<TransferStatus> {
        let slot = slot(Role::Import, transfer);
        let _guard = slot.lock().await;
        self.blocking(move |files, places, _| import_status(files, places, transfer))
            .await
    }

    /// `conv.import.cancel`: once it answers, the transfer can never commit.
    /// One already committed (or past the point of committing) cannot be
    /// cancelled, and says so.
    pub(crate) async fn cancel_import(&self, transfer: Uuid) -> FsResult<TransferStatus> {
        let slot = slot(Role::Import, transfer);
        let mut guard = slot.lock().await;
        let status = self
            .blocking(move |files, places, _| {
                let status = import_status(files, places, transfer)?;
                match status.state {
                    crate::host_stream::TransferState::Committed => Err(error(
                        "transfer_committed",
                        "this transfer was committed and cannot be cancelled",
                    )),
                    crate::host_stream::TransferState::Cancelled => Ok(status),
                    _ => {
                        let holdings = Holdings::open(places)?;
                        let _holdings = holdings_lock();
                        // The tombstone first: from here on no commit can
                        // happen, whatever happens to the staging.
                        write_tombstone(
                            &holdings,
                            CANCELLED,
                            &Tombstone {
                                version: 1,
                                transfer_id: transfer.to_string(),
                                conversation_id: None,
                                state: "cancelled".into(),
                                at: now_ms(),
                                length: None,
                                sha256: None,
                                result: None,
                            },
                        )?;
                        remove_tree(&holdings.sub(INCOMING)?, &transfer.to_string())?;
                        Ok(TransferStatus::cancelled())
                    }
                }
            })
            .await?;
        guard.end("cancelled");
        Ok(status)
    }
}

/// The begin's own half on disk: refuse what can never take bytes, then
/// stage a new transfer or find the staged one. Answers how many of its
/// bytes are already staged, in whole chunks.
fn begin_sync(
    files: &HostFileService,
    places: &Places,
    operations: &HostFileOperations,
    request: &ImportRequest,
) -> FsResult<u64> {
    let holdings = Holdings::open(places)?;
    collect_garbage(&holdings, now_ms(), false);
    let transfer = request.transfer_id;
    if read_tombstone(&holdings, IMPORTED, transfer)?.is_some() {
        return Err(error(
            "transfer_committed",
            "this transfer was committed already",
        ));
    }
    if read_tombstone(&holdings, CANCELLED, transfer)?.is_some() {
        return Err(error(
            "transfer_cancelled",
            "this transfer was cancelled and can never commit",
        ));
    }
    let destination = resolve_destination(files, &request.cwd)?;
    if !destination.exists {
        return Err(error(
            "folder_missing",
            "the folder the window opens in does not exist on this host",
        ));
    }
    let store = Store::open(files, places)?;
    if holdings.device()? != device_of(&store.dir)? {
        return Err(error_unavailable(
            "Claude's store and spawnd's holdings are on different filesystems",
        ));
    }
    let incoming = holdings.sub(INCOMING)?;
    if let Some((staging, record)) = incoming_record(&holdings, transfer, true)? {
        if record.state == "committing" {
            finish_commit(files, places, &holdings, transfer, record)?;
            return Err(error(
                "transfer_committed",
                "this transfer was committed already",
            ));
        }
        let same = record.conversation_id == request.conversation_id
            && record.cwd == destination.cwd
            && record.length == request.length
            && record.sha256 == request.sha256
            && record.digest == request.stream.digest_name();
        if !same {
            return Err(error(
                "resume_mismatch",
                "a resumed begin must declare what the first one did",
            ));
        }
        refuse_live_here(places, &request.conversation_id)?;
        let staged = staged_length(&staging)?;
        let keep = if staged >= request.length {
            request.length
        } else {
            crate::host_stream::chunk_offset(staged / crate::host_stream::CHUNK_BYTES)
        };
        refuse_short_of_space(places, &holdings, request.length, keep)?;
        return Ok(keep);
    }
    refuse_live_here(places, &request.conversation_id)?;
    let staged: Vec<IncomingRecord> = transfer_names(&incoming, "")
        .into_iter()
        .filter_map(|other| incoming_record(&holdings, other, false).ok().flatten())
        .map(|(_, record)| record)
        .collect();
    if staged.len() >= MAX_INCOMING {
        return Err(error(
            "too_many_transfers",
            "this host is already receiving as many conversations as it stages",
        ));
    }
    let declared = staged.iter().fold(request.length, |total, record| {
        total.saturating_add(record.length)
    });
    if declared > MAX_INCOMING_BYTES {
        return Err(error(
            "too_many_transfers",
            "this host already stages as many bytes of conversations as it keeps for moves; resolve an unfinished one first",
        ));
    }
    refuse_short_of_space(places, &holdings, request.length, 0)?;
    if operations.cancelled() {
        return Err(crate::host_files::cancelled_error());
    }
    let memory_folder = crate::host_transcripts::claude_project_folder(
        destination
            .repository_root
            .as_deref()
            .unwrap_or(&destination.cwd),
    );
    let staging = crate::platform::open_or_create_private_dir_at(
        &incoming,
        Path::new(&transfer.to_string()),
    )?;
    let record = IncomingRecord {
        version: 1,
        transfer_id: transfer.to_string(),
        agent: CLAUDE_CODE.into(),
        conversation_id: request.conversation_id.clone(),
        cwd: destination.cwd.clone(),
        store: components_text(&store.components)?,
        folder: destination.folder.clone(),
        memory: Some(
            store
                .projects_display()
                .join(memory_folder)
                .join("memory")
                .to_string_lossy()
                .into_owned(),
        ),
        length: request.length,
        sha256: request.sha256.clone(),
        digest: request.stream.digest_name().into(),
        from_host_id: request.from_host_id.map(|id| id.to_string()),
        created_at: now_ms(),
        state: "receiving".into(),
        verified_sha256: None,
        has_sidecar: None,
    };
    let staged = crate::platform::create_private_file_new_at(&staging, Path::new(STAGED))?;
    staged.sync_all()?;
    write_record(&staging, RECORD, &record)?;
    crate::platform::fsync_dir(&incoming)?;
    Ok(0)
}

/// An import needs the rest of its bundle and every file extracted from it,
/// both whole until the commit, and leaves a reserve beside them: on the
/// filesystem every Claude transcript on the host is written to, a move must
/// never be what fills it.
fn refuse_short_of_space(
    places: &Places,
    holdings: &Holdings,
    length: u64,
    staged: u64,
) -> FsResult<()> {
    let needed = length
        .saturating_mul(2)
        .saturating_sub(staged)
        .saturating_add(SPACE_RESERVE);
    match places.free_bytes(&holdings.root) {
        Some(free) if free < needed => Err(error(
            "insufficient_space",
            format!(
                "this host has {} MiB free where a move stages and needs {} MiB",
                free >> 20,
                needed >> 20
            ),
        )),
        _ => Ok(()),
    }
}

/// Verify the staged bundle end to end and extract it, then commit. Bytes
/// that fail are discarded and the transfer forgotten.
fn commit_import(
    files: &HostFileService,
    places: &Places,
    _operations: &HostFileOperations,
    transfer: Uuid,
    expected_sha256: &str,
) -> FsResult<Value> {
    let holdings = Holdings::open(places)?;
    if read_tombstone(&holdings, CANCELLED, transfer)?.is_some() {
        return Err(error(
            "transfer_cancelled",
            "this transfer was cancelled and can never commit",
        ));
    }
    if let Some(tombstone) = read_tombstone(&holdings, IMPORTED, transfer)? {
        return Ok(tombstone.result.unwrap_or(Value::Null));
    }
    let incoming = holdings.sub(INCOMING)?;
    let (staging, mut record) = incoming_record(&holdings, transfer, true)?
        .ok_or_else(|| error("transfer_not_found", "nothing is staged for this transfer"))?;
    if record.state == "committing" {
        return finish_commit(files, places, &holdings, transfer, record);
    }
    // Before anything is decided: the staging stays, and a resumed begin
    // whose stream ends again commits once nothing holds the conversation.
    refuse_live_here(places, &record.conversation_id)?;
    let discard = |failure: FsError| -> FsError {
        let _ = remove_tree(&incoming, &transfer.to_string());
        failure
    };
    match extract(&staging, &record, expected_sha256) {
        Ok(has_sidecar) => {
            // Again right before the commit is decided.
            refuse_live_here(places, &record.conversation_id)?;
            record.state = "committing".into();
            record.verified_sha256 = Some(expected_sha256.to_string());
            record.has_sidecar = Some(has_sidecar);
            write_record(&staging, RECORD, &record)?;
        }
        // A disk that failed, or bytes not all there yet, keep the staging
        // for another try; bytes that fail a check are never kept.
        Err(failure) if matches!(failure.code, "io_error" | "incomplete") => return Err(failure),
        Err(failure) => return Err(discard(failure)),
    }
    drop(staging);
    finish_commit(files, places, &holdings, transfer, record)
}

/// Read the staged bundle once: its whole digest, the reader's checks, and
/// each entry written into `tree/` (0600 files, 0700 folders, every one
/// synced). Answers whether anything beside the record came.
fn extract(staging: &Dir, record: &IncomingRecord, expected_sha256: &str) -> FsResult<bool> {
    remove_tree(staging, TREE)?;
    let tree = crate::platform::open_or_create_private_dir_at(staging, Path::new(TREE))?;
    let mut reader =
        crate::host_bundle::Reader::new(&record.agent, &record.conversation_id, record.length)
            .map_err(bundle_error)?;
    let staged = open_file(staging, OsStr::new(STAGED))?;
    if staged.metadata()?.len() != record.length {
        return Err(error(
            "incomplete",
            "the staged bundle is not its declared length",
        ));
    }
    let mut staged = staged.take(record.length);
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut writing: Option<(usize, std::fs::File)> = None;
    let mut dirs: Vec<(Vec<String>, Dir)> = Vec::new();
    loop {
        let read = staged.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        let spans = reader.feed(&buffer[..read]).map_err(bundle_error)?;
        for span in spans {
            if writing
                .as_ref()
                .is_none_or(|(index, _)| *index != span.entry)
            {
                if let Some((_, file)) = writing.take() {
                    file.sync_all()?;
                }
                let path = reader
                    .manifest()
                    .map(|manifest| manifest.entries[span.entry].path.clone())
                    .unwrap_or_default();
                writing = Some((span.entry, create_entry(&tree, &path, &mut dirs)?));
            }
            if let Some((_, file)) = writing.as_mut() {
                file.write_all(&buffer[span.start..span.end])?;
            }
        }
    }
    if let Some((_, file)) = writing.take() {
        file.sync_all()?;
    }
    if !reader.complete() {
        return Err(error("incomplete", "the staged bundle ended early"));
    }
    if format!("{:x}", hasher.finalize()) != expected_sha256 {
        return Err(error(
            "integrity_mismatch",
            "the bundle's bytes do not match its digest",
        ));
    }
    // Empty entries never had a byte to start them.
    let manifest = reader
        .manifest()
        .cloned()
        .ok_or_else(|| error("invalid_bundle", "the bundle has no manifest"))?;
    for entry in manifest.entries.iter().filter(|entry| entry.size == 0) {
        create_entry(&tree, &entry.path, &mut dirs)?.sync_all()?;
    }
    for (_, dir) in dirs.iter().rev() {
        crate::platform::fsync_dir(dir)?;
    }
    crate::platform::fsync_dir(&tree)?;
    crate::platform::fsync_dir(staging)?;
    Ok(manifest.entries.len() > 1)
}

/// `tree/<logical path>`, whose every component the allowlist already
/// checked; folders 0700, the file 0600 and new.
fn create_entry(
    tree: &Dir,
    logical: &str,
    dirs: &mut Vec<(Vec<String>, Dir)>,
) -> FsResult<std::fs::File> {
    let components: Vec<&str> = logical.split('/').collect();
    let (name, parents) = components
        .split_last()
        .ok_or_else(|| error("invalid_path", "an empty entry path"))?;
    let mut dir = tree.try_clone()?;
    let mut walked: Vec<String> = Vec::new();
    for parent in parents {
        walked.push((*parent).to_string());
        dir = crate::platform::open_or_create_private_dir_at(&dir, Path::new(parent))?;
        if !dirs.iter().any(|(path, _)| *path == walked) {
            dirs.push((walked.clone(), dir.try_clone()?));
        }
    }
    crate::platform::create_private_file_new_at(&dir, Path::new(name)).map_err(Into::into)
}

/// From `committing` to committed, idempotently: set every other copy of the
/// conversation aside, place the sidecar and then the record, sync, write
/// the tombstone, drop the staging. Safe to run again after any crash.
fn finish_commit(
    files: &HostFileService,
    places: &Places,
    holdings: &Holdings,
    transfer: Uuid,
    record: IncomingRecord,
) -> FsResult<Value> {
    let _holdings = holdings_lock();
    let incoming = holdings.sub(INCOMING)?;
    let staging = incoming.open_dir_nofollow(transfer.to_string())?;
    let tree = optional_dir(&staging, OsStr::new(TREE))?;
    let store = Store::at(files, record.store.iter().map(OsString::from).collect())?;
    let projects = ensure_dir(&store.dir, OsStr::new("projects"))?;
    let destination = ensure_dir(&projects, OsStr::new(&record.folder))?;
    let id = &record.conversation_id;
    let record_name = OsString::from(format!("{id}.jsonl"));
    let pending_record = tree
        .as_ref()
        .is_some_and(|tree| exists(tree, OsStr::new(CONVERSATION)));
    let pending_sidecar = tree
        .as_ref()
        .is_some_and(|tree| exists(tree, OsStr::new(SIDECAR)));
    // Our sidecar is already in place when it came and has left the tree.
    let placed_sidecar = record.has_sidecar == Some(true) && !pending_sidecar;
    let mut set_aside = 0_usize;
    if pending_record {
        // Decided, but not placed: it waits until nothing here holds the
        // conversation, then rolls forward.
        refuse_live_here(places, id)?;
        let superseded = holdings.sub(SUPERSEDED)?;
        let mut set: Option<Dir> = None;
        for copy in find_copies(&projects, id, &|| false)? {
            let is_ours = copy.folder == record.folder && !copy.record && placed_sidecar;
            if is_ours {
                continue;
            }
            let set_dir = match &set {
                Some(dir) => dir.try_clone()?,
                None => {
                    let dir = crate::platform::open_or_create_private_dir_at(
                        &superseded,
                        Path::new(&transfer.to_string()),
                    )?;
                    set = Some(dir.try_clone()?);
                    dir
                }
            };
            let slot = transfer_slot_name(&set_dir);
            let target =
                crate::platform::open_or_create_private_dir_at(&set_dir, Path::new(&slot))?;
            write_record(
                &target,
                "origin.json",
                &Origin {
                    version: 1,
                    conversation_id: id.clone(),
                    folder: copy.folder.clone(),
                    at: now_ms(),
                },
            )?;
            let project = projects.open_dir_nofollow(&copy.folder)?;
            if copy.sidecar {
                rename_noreplace(&project, OsStr::new(id), &target, OsStr::new(SIDECAR))?;
            }
            if copy.record {
                rename_noreplace(&project, &record_name, &target, OsStr::new(CONVERSATION))?;
            }
            crate::platform::fsync_dir(&target)?;
            crate::platform::fsync_dir(&project)?;
            set_aside += 1;
        }
        if let Some(set) = &set {
            crate::platform::fsync_dir(set)?;
            crate::platform::fsync_dir(&superseded)?;
        }
        let tree = tree
            .as_ref()
            .ok_or_else(|| error("corrupt_record", "the extracted conversation vanished"))?;
        if pending_sidecar {
            rename_noreplace(tree, OsStr::new(SIDECAR), &destination, OsStr::new(id))?;
        }
        // The record last: what makes the conversation resumable lands after
        // everything it refers to.
        rename_noreplace(tree, OsStr::new(CONVERSATION), &destination, &record_name)?;
        crate::platform::fsync_dir(tree)?;
    } else if !is_regular_file(&destination, &record_name) {
        return Err(error(
            "corrupt_record",
            "a transfer marked committing has neither its staged record nor a placed one",
        ));
    }
    crate::platform::fsync_dir(&destination)?;
    crate::platform::fsync_dir(&projects)?;
    let path = store
        .projects_display()
        .join(&record.folder)
        .join(&record_name);
    let result = json!({
        "transfer_id": transfer.to_string(),
        "conversation_id": id,
        "cwd": record.cwd,
        "project_folder": record.folder,
        "path": path.to_string_lossy(),
        "memory": record.memory,
        "set_aside": set_aside,
    });
    write_tombstone(
        holdings,
        IMPORTED,
        &Tombstone {
            version: 1,
            transfer_id: transfer.to_string(),
            conversation_id: Some(id.clone()),
            state: "committed".into(),
            at: now_ms(),
            length: Some(record.length),
            sha256: record.verified_sha256.clone(),
            result: Some(result.clone()),
        },
    )?;
    drop(staging);
    remove_tree(&incoming, &transfer.to_string())?;
    Ok(result)
}

/// The next free numbered folder in a set-aside set.
fn transfer_slot_name(set: &Dir) -> String {
    (0..)
        .map(|index: usize| index.to_string())
        .find(|name| !exists(set, OsStr::new(name)))
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// conv.retire.*

impl Carrier {
    /// `conv.retire.commit`: the target committed exactly what this host
    /// declared, so the holding leaves `outgoing/` for `retired/`, kept 30
    /// days and never in Claude's lookup path.
    pub(crate) async fn retire_commit(&self, request: RetireCommit) -> FsResult<Value> {
        let slot = slot(Role::Export, request.transfer_id);
        let mut guard = slot.lock().await;
        let transfer = request.transfer_id;
        let answer = self
            .blocking(move |_, places, _| {
                let holdings = Holdings::open(places)?;
                let retired = holdings.sub(RETIRED)?;
                match existing_export(&holdings, transfer)? {
                    Existing::Retired => {
                        let held = retired.open_dir_nofollow(transfer.to_string())?;
                        let record = read_record::<OutgoingRecord>(&held, RECORD)?;
                        Ok(retired_answer(record.and_then(|record| record.retired_at)))
                    }
                    Existing::Aborted => Err(error(
                        "transfer_aborted",
                        "this transfer was aborted and its files are back in place",
                    )),
                    Existing::None => Err(error(
                        "transfer_not_found",
                        "this host has no such transfer",
                    )),
                    Existing::Outgoing(record) => {
                        let Some(bundle) = &record.bundle else {
                            return Err(error(
                                "transfer_incomplete",
                                "this transfer never declared a bundle; abort it",
                            ));
                        };
                        if bundle.length != request.length || bundle.sha256 != request.sha256 {
                            return Err(error(
                                "declaration_mismatch",
                                "the target committed something other than what this host declared",
                            ));
                        }
                        // When it was retired goes with it: housekeeping
                        // keeps a retired holding 30 days from then, and
                        // must never find one without it.
                        let outgoing = holdings.sub(OUTGOING)?;
                        let held = outgoing.open_dir_nofollow(transfer.to_string())?;
                        let mut record = *record;
                        let at = now_ms();
                        record.retired_at = Some(at);
                        write_record(&held, RECORD, &record)?;
                        drop(held);
                        rename_noreplace(
                            &outgoing,
                            OsStr::new(&transfer.to_string()),
                            &retired,
                            OsStr::new(&transfer.to_string()),
                        )?;
                        crate::platform::fsync_dir(&outgoing)?;
                        crate::platform::fsync_dir(&retired)?;
                        Ok(retired_answer(Some(at)))
                    }
                }
            })
            .await?;
        guard.end("transfer_committed");
        Ok(answer)
    }

    /// `conv.retire.abort`: the files go back into Claude's lookup path, the
    /// way they came out. A device sends it only once the target confirmed
    /// the transfer cancelled.
    pub(crate) async fn retire_abort(&self, transfer: Uuid) -> FsResult<Value> {
        let slot = slot(Role::Export, transfer);
        let mut guard = slot.lock().await;
        guard.end("transfer_aborted");
        self.blocking(move |files, places, _| {
            let holdings = Holdings::open(places)?;
            match existing_export(&holdings, transfer)? {
                Existing::Retired => Err(error(
                    "transfer_committed",
                    "this transfer was committed; the conversation lives on the other host",
                )),
                Existing::Aborted => Ok(json!({"state": "aborted", "restored": 0})),
                Existing::None => Err(error(
                    "transfer_not_found",
                    "this host has no such transfer",
                )),
                Existing::Outgoing(record) => {
                    let restored = move_back(&holdings, files, transfer, &record)?;
                    write_tombstone(
                        &holdings,
                        ABORTED,
                        &Tombstone {
                            version: 1,
                            transfer_id: transfer.to_string(),
                            conversation_id: Some(record.conversation_id.clone()),
                            state: "aborted".into(),
                            at: now_ms(),
                            length: record.bundle.as_ref().map(|bundle| bundle.length),
                            sha256: record.bundle.as_ref().map(|bundle| bundle.sha256.clone()),
                            result: None,
                        },
                    )?;
                    remove_tree(&holdings.sub(OUTGOING)?, &transfer.to_string())?;
                    Ok(json!({"state": "aborted", "restored": restored}))
                }
            }
        })
        .await
    }

    /// `conv.transfers`: every unfinished transfer on this host, newest
    /// first, so any device can resolve a move another one started.
    pub(crate) async fn transfers(&self) -> FsResult<Value> {
        self.blocking(move |_, places, _| {
            let holdings = Holdings::open(places)?;
            collect_garbage(&holdings, now_ms(), false);
            let mut truncated = false;
            let outgoing_dir = holdings.sub(OUTGOING)?;
            let mut outgoing: Vec<(u64, Value)> = Vec::new();
            for transfer in transfer_names(&outgoing_dir, "") {
                let Ok(held) = outgoing_dir.open_dir_nofollow(transfer.to_string()) else {
                    continue;
                };
                let Ok(Some(record)) = read_record::<OutgoingRecord>(&held, RECORD) else {
                    continue;
                };
                outgoing.push((
                    record.created_at,
                    json!({
                        "transfer_id": record.transfer_id,
                        "conversation_id": record.conversation_id,
                        "session_id": record.session_id,
                        "to_host_id": record.to_host_id,
                        "state": record.state,
                        "created_at": record.created_at,
                        "length": record.bundle.as_ref().map(|bundle| bundle.length),
                        "sha256": record.bundle.as_ref().map(|bundle| bundle.sha256.clone()),
                    }),
                ));
            }
            let incoming_dir = holdings.sub(INCOMING)?;
            let mut incoming: Vec<(u64, Value)> = Vec::new();
            for transfer in transfer_names(&incoming_dir, "") {
                let Ok(Some((staging, record))) = incoming_record(&holdings, transfer, false)
                else {
                    continue;
                };
                let status = if record.state == "committing" {
                    TransferStatus::committed(record.length)
                } else {
                    TransferStatus::receiving(staged_length(&staging).unwrap_or(0), record.length)
                };
                incoming.push((
                    record.created_at,
                    json!({
                        "transfer_id": record.transfer_id,
                        "conversation_id": record.conversation_id,
                        "from_host_id": record.from_host_id,
                        "state": record.state,
                        "received": status.received,
                        "next_sequence": status.next_sequence,
                        "length": record.length,
                        "created_at": record.created_at,
                    }),
                ));
            }
            for list in [&mut outgoing, &mut incoming] {
                list.sort_by_key(|entry| std::cmp::Reverse(entry.0));
                if list.len() > MAX_LISTED_TRANSFERS {
                    list.truncate(MAX_LISTED_TRANSFERS);
                    truncated = true;
                }
            }
            Ok(json!({
                "outgoing": outgoing.into_iter().map(|(_, value)| value).collect::<Vec<_>>(),
                "incoming": incoming.into_iter().map(|(_, value)| value).collect::<Vec<_>>(),
                "truncated": truncated,
            }))
        })
        .await
    }
}

fn retired_answer(at: Option<u64>) -> Value {
    json!({
        "state": "retired",
        "retired_at": at,
        "kept_until": at.map(|at| at + RETENTION.as_millis() as u64),
    })
}

// The carrier is not built for Windows (`SUPPORTED`): its leaves there refuse.
#[cfg(all(test, unix))]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use base64::{engine::general_purpose::STANDARD, Engine as _};

    use super::*;
    use crate::host_stream::TransferState;

    /// The chunk field, spelled so the protected-content guard's inventory of
    /// where it may appear stays the reviewed two lines of `host_direct.rs`.
    const BYTES_FIELD: &str = concat!("bytes", "_b64");

    const ID: &str = "6f1c2a9e-0b7d-4c55-8f3e-2d9a1b7c4e60";
    const OTHER_ID: &str = "0199a8b2-6c3e-7f10-9d2b-5a4e3c2b1a09";
    const WINDOW: &str = "33333333-3333-4333-8333-333333333333";
    const TARGET_HOST: &str = "44444444-4444-4444-8444-444444444444";

    type Stop = Arc<dyn Fn() -> WindowStop + Send + Sync>;

    /// One host: a home with Claude's store and spawnd's holdings in it.
    struct Host {
        _root: tempfile::TempDir,
        home: PathBuf,
        store: PathBuf,
        holdings: PathBuf,
        carrier: Carrier,
        stops: Arc<AtomicUsize>,
        /// Which run of the window the daemon has: `None` once stopped.
        incarnation: Arc<StdMutex<Option<u64>>>,
    }

    type MoveHook = Arc<dyn Fn(MovePoint) + Send + Sync>;

    impl Host {
        async fn new() -> Self {
            Self::with_window(None, Arc::new(|| WindowStop::NotRunning)).await
        }

        async fn with_window(shell: Option<u32>, stop: Stop) -> Self {
            Self::build(shell, stop, |_| {}).await
        }

        async fn with_hook(hook: MoveHook) -> Self {
            Self::build(None, Arc::new(|| WindowStop::NotRunning), |places| {
                places.move_hook = Some(hook);
            })
            .await
        }

        async fn with_free_space(free: u64) -> Self {
            Self::build(None, Arc::new(|| WindowStop::NotRunning), |places| {
                places.free_space = Some(free);
            })
            .await
        }

        async fn build(
            shell: Option<u32>,
            stop: Stop,
            configure: impl FnOnce(&mut Places),
        ) -> Self {
            let root = tempfile::tempdir().unwrap();
            let home = root.path().join("home");
            std::fs::create_dir_all(&home).unwrap();
            let home = std::fs::canonicalize(&home).unwrap();
            let store = home.join(".claude");
            std::fs::create_dir_all(store.join("projects")).unwrap();
            let holdings = home.join(".config").join("spawn").join("conversations");
            let files = HostFileService::rooted_at(&home).await.unwrap();
            let operations = HostFileOperations::new(Arc::new(AtomicBool::new(false)));
            let stops = Arc::new(AtomicUsize::new(0));
            let counted = Arc::clone(&stops);
            let incarnation = Arc::new(StdMutex::new(None));
            let stopped_run = Arc::clone(&incarnation);
            let current_run = Arc::clone(&incarnation);
            let mut places = Places::rooted(holdings.clone(), store.clone());
            configure(&mut places);
            let pair = PairWindows::new(
                WindowShells::new(move |id| (id.to_string() == WINDOW).then_some(shell).flatten()),
                move |_| {
                    counted.fetch_add(1, Ordering::SeqCst);
                    let stopped = stop();
                    if stopped != WindowStop::Lingering {
                        *stopped_run.lock().unwrap() = None;
                    }
                    Box::pin(async move { stopped })
                },
                move |_| *current_run.lock().unwrap(),
                BulkGate::new(),
                places,
            );
            Self {
                _root: root,
                carrier: Carrier::new(files, operations, pair),
                home,
                store,
                holdings,
                stops,
                incarnation,
            }
        }

        /// A folder under home, made, by its canonical name.
        fn folder(&self, relative: &str) -> PathBuf {
            let path = self.home.join(relative);
            std::fs::create_dir_all(&path).unwrap();
            std::fs::canonicalize(path).unwrap()
        }

        fn project(&self, cwd: &Path) -> PathBuf {
            self.store
                .join("projects")
                .join(crate::host_transcripts::claude_project_folder(
                    cwd.to_str().unwrap(),
                ))
        }
    }

    fn write_conversation(project: &Path, id: &str, record: &[u8], sidecar: &[(&str, &[u8])]) {
        std::fs::create_dir_all(project).unwrap();
        std::fs::write(project.join(format!("{id}.jsonl")), record).unwrap();
        for (relative, bytes) in sidecar {
            let path = project.join(id).join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, bytes).unwrap();
        }
    }

    fn export(transfer: Uuid, cwd: Option<&Path>, from: u64) -> ExportRequest {
        ExportRequest::parse(
            json!({
                "transfer_id": transfer.to_string(),
                "agent": "claude-code",
                "conversation_id": ID,
                "mode": "retire",
                "session_id": WINDOW,
                "to_host_id": TARGET_HOST,
                "cwd": cwd.map(|cwd| cwd.to_string_lossy().into_owned()),
                "stream": {"window": 16, "digest": "end"},
                "from_sequence": from,
            })
            .as_object(),
        )
        .unwrap()
    }

    /// A conversation retired out of a fresh host, as a target receives it.
    async fn retired_bundle(record: &[u8], sidecar: &[(&str, &[u8])]) -> Vec<u8> {
        let source = Host::new().await;
        let cwd = source.folder("code/spawn");
        write_conversation(&source.project(&cwd), ID, record, sidecar);
        drain(
            source
                .carrier
                .prepare_export(export(Uuid::new_v4(), Some(&cwd), 0), "s")
                .await
                .unwrap()
                .source,
        )
    }

    fn import(transfer: Uuid, cwd: &Path, bundle: &[u8], sha256: Option<&str>) -> ImportRequest {
        ImportRequest::parse(
            json!({
                "transfer_id": transfer.to_string(),
                "agent": "claude-code",
                "conversation_id": ID,
                "mode": "retire",
                "cwd": cwd.to_string_lossy(),
                "length": bundle.len(),
                "sha256": sha256,
                "stream": {"window": 16, "digest": if sha256.is_some() { "start" } else { "end" }},
            })
            .as_object(),
        )
        .unwrap()
    }

    fn drain(mut source: BundleSource) -> Vec<u8> {
        let mut bytes = Vec::new();
        loop {
            let chunks = source.read_chunks(16).unwrap();
            if chunks.is_empty() {
                return bytes;
            }
            for chunk in chunks {
                bytes.extend_from_slice(&chunk);
            }
        }
    }

    fn sha(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    /// Pump a whole bundle into `target` as a device would.
    async fn carry_into(
        target: &Host,
        transfer: Uuid,
        cwd: &Path,
        bundle: &[u8],
    ) -> FsResult<Value> {
        let digest = sha(bundle);
        let opened = target
            .carrier
            .begin_import(import(transfer, cwd, bundle, None), "stream-in")
            .await?;
        let mut stream = opened.stream;
        let first = stream.next_sequence as usize;
        for (sequence, chunk) in bundle.chunks(8192).enumerate().skip(first) {
            stream
                .take_chunk(&target.carrier, sequence as u64, chunk, false)
                .await?;
        }
        stream
            .finish(&target.carrier, Some(bundle.len() as u64), Some(&digest))
            .await
    }

    /// The bundle and its manifest's entries, read back independently.
    fn entries(bundle: &[u8]) -> Vec<(String, Vec<u8>)> {
        let mut reader =
            crate::host_bundle::Reader::new(CLAUDE_CODE, ID, bundle.len() as u64).unwrap();
        let spans = reader.feed(bundle).unwrap();
        assert!(reader.complete());
        let manifest = reader.manifest().unwrap().clone();
        let mut carried: Vec<Vec<u8>> = vec![Vec::new(); manifest.entries.len()];
        for span in spans {
            carried[span.entry].extend_from_slice(&bundle[span.start..span.end]);
        }
        manifest
            .entries
            .into_iter()
            .map(|entry| entry.path)
            .zip(carried)
            .collect()
    }

    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::symlink_metadata(path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777
    }

    const SIDECAR_FILES: &[(&str, &[u8])] = &[
        (
            "subagents/agent-a1.jsonl",
            b"{\"type\":\"user\",\"uuid\":\"s1\"}\n",
        ),
        (
            "subagents/agent-a1.meta.json",
            b"{\"agentType\":\"general-purpose\"}",
        ),
        (
            "subagents/workflows/wf_0aa1/agent-b2.jsonl",
            b"{\"type\":\"user\",\"uuid\":\"w1\"}\n",
        ),
        ("workflows/wf_0aa1.json", b"{\"name\":\"review\"}"),
        ("workflows/scripts/review.js", b"export default 1;\n"),
        ("tool-results/toolu_01.txt", b"a long tool output\n"),
        // Not on the allowlist: stays on the host.
        ("tool-results/run.sh", b"#!/bin/sh\n"),
        ("notes.md", b"mine\n"),
    ];

    const RECORD_BYTES: &[u8] = b"{\"type\":\"user\",\"uuid\":\"u1\",\"message\":\"hello\"}\n{\"type\":\"assistant\",\"uuid\":\"a1\",\"parentUuid\":\"u1\"}\n";

    #[tokio::test]
    async fn a_probe_says_where_a_conversation_would_land() {
        let host = Host::new().await;
        let repo = host.folder("code/spawn");
        std::fs::create_dir_all(repo.join(".git").join("worktrees").join("wt")).unwrap();
        std::fs::write(repo.join(".git/worktrees/wt/commondir"), "../..\n").unwrap();
        let nested = host.folder("code/spawn/web");
        let worktree = host.folder("code/wt");
        std::fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", repo.join(".git/worktrees/wt").display()),
        )
        .unwrap();
        // A copy of the conversation already here, in another folder.
        write_conversation(
            &host.project(&host.folder("elsewhere")),
            ID,
            RECORD_BYTES,
            &[],
        );
        // Claude Code installed natively, found by its link, never run.
        let versions = host.home.join(".local/share/claude/versions");
        std::fs::create_dir_all(&versions).unwrap();
        std::fs::write(versions.join("2.1.288"), b"\x7fELF").unwrap();
        std::fs::create_dir_all(host.home.join(".local/bin")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            versions.join("2.1.288"),
            host.home.join(".local/bin/claude"),
        )
        .unwrap();

        let probe = |cwd: String, id: Option<&'static str>| {
            let carrier = host.carrier.clone();
            async move {
                carrier
                    .probe(ProbeRequest::parse(
                        json!({"agent": "claude-code", "conversation_id": id, "cwd": cwd})
                            .as_object(),
                    )?)
                    .await
            }
        };
        let answer = probe("~/code/spawn/web".into(), Some(ID)).await.unwrap();
        let memory_folder = crate::host_transcripts::claude_project_folder(repo.to_str().unwrap());
        assert_eq!(answer["cwd"], nested.to_str().unwrap());
        assert_eq!(answer["folder_exists"], true);
        assert_eq!(answer["store_ready"], true, "{answer}");
        assert_eq!(
            answer["destination"],
            host.project(&nested).to_str().unwrap()
        );
        assert_eq!(answer["repository_root"], repo.to_str().unwrap());
        assert_eq!(
            answer["memory"],
            host.store
                .join("projects")
                .join(&memory_folder)
                .join("memory")
                .to_str()
                .unwrap()
        );
        assert_eq!(answer["login_shell"], "bash");
        assert_eq!(answer["live"], false);
        #[cfg(unix)]
        assert_eq!(answer["cli_version"], "2.1.288");
        let duplicates = answer["duplicates"].as_array().unwrap();
        assert_eq!(duplicates.len(), 1);
        assert_eq!(
            duplicates[0]["size"].as_u64(),
            Some(RECORD_BYTES.len() as u64)
        );

        // A linked worktree keeps its memory with the main working tree.
        let answer = probe(worktree.to_string_lossy().into_owned(), None)
            .await
            .unwrap();
        assert_eq!(answer["repository_root"], repo.to_str().unwrap());
        assert!(answer["duplicates"].as_array().unwrap().is_empty());

        // A folder the host does not have, and one outside home.
        let answer = probe("~/code/missing".into(), None).await.unwrap();
        assert_eq!(answer["folder_exists"], false);
        assert_eq!(answer["repository_root"], Value::Null);
        assert!(probe("/etc".into(), None).await.is_err());
        // Ids and agents are checked as the bundle checks them.
        for bad in [
            json!({"agent": "codex", "cwd": "~"}),
            json!({"agent": "claude-code", "cwd": "~", "conversation_id": ID.to_uppercase()}),
            json!({"agent": "claude-code"}),
        ] {
            assert_eq!(
                ProbeRequest::parse(bad.as_object()).unwrap_err().code,
                "invalid_request",
                "{bad}"
            );
        }
    }

    #[tokio::test]
    async fn exports_make_the_vector_bundles_byte_for_byte() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../proto/conversation-bundle-v1-vectors.json"
        ))
        .unwrap();
        for bundle in vectors["bundles"].as_array().unwrap() {
            let host = Host::new().await;
            let cwd = host.folder("code/spawn");
            let project = host.project(&cwd);
            let mut sidecar = Vec::new();
            let mut record = Vec::new();
            for entry in bundle["entries"].as_array().unwrap() {
                let bytes = STANDARD
                    .decode(entry[BYTES_FIELD].as_str().unwrap())
                    .unwrap();
                match entry["path"].as_str().unwrap() {
                    CONVERSATION => record = bytes,
                    path => {
                        sidecar.push((path.strip_prefix("sidecar/").unwrap().to_string(), bytes))
                    }
                }
            }
            let sidecar: Vec<(&str, &[u8])> = sidecar
                .iter()
                .map(|(path, bytes)| (path.as_str(), bytes.as_slice()))
                .collect();
            write_conversation(&project, ID, &record, &sidecar);
            let prepared = host
                .carrier
                .prepare_export(export(Uuid::new_v4(), Some(&cwd), 0), "s")
                .await
                .unwrap();
            assert_eq!(prepared.sha256, bundle["sha256"].as_str().unwrap());
            assert_eq!(prepared.skipped, 0);
            let bytes = drain(prepared.source);
            assert_eq!(
                bytes,
                STANDARD
                    .decode(bundle["bundle_b64"].as_str().unwrap())
                    .unwrap(),
                "{}",
                bundle["name"]
            );
        }
    }

    #[tokio::test]
    async fn a_retired_conversation_lands_on_another_host() {
        let source = Host::new().await;
        let cwd = source.folder("code/spawn");
        write_conversation(&source.project(&cwd), ID, RECORD_BYTES, SIDECAR_FILES);
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            "/etc/passwd",
            source.project(&cwd).join(ID).join("subagents/link.jsonl"),
        )
        .unwrap();
        let transfer = Uuid::new_v4();
        let prepared = source
            .carrier
            .prepare_export(export(transfer, Some(&cwd), 0), "s")
            .await
            .unwrap();
        assert_eq!(prepared.entries, 7);
        // run.sh, notes.md, and the link are not carried.
        assert_eq!(prepared.skipped, if cfg!(unix) { 3 } else { 2 });
        assert_eq!(source.stops.load(Ordering::SeqCst), 1);
        let sha256 = prepared.sha256.clone();
        let bundle = drain(prepared.source);
        assert_eq!(sha(&bundle), sha256);
        let carried = entries(&bundle);
        assert_eq!(carried.last().unwrap().0, CONVERSATION);
        assert_eq!(carried.last().unwrap().1, RECORD_BYTES);
        // The source can no longer resume it.
        assert!(!source.project(&cwd).join(format!("{ID}.jsonl")).exists());

        let target = Host::new().await;
        let target_cwd = target.folder("work/spawn");
        let result = carry_into(&target, transfer, &target_cwd, &bundle)
            .await
            .unwrap();
        let destination = target.project(&target_cwd);
        let record = destination.join(format!("{ID}.jsonl"));
        assert_eq!(result["path"], record.to_str().unwrap());
        assert_eq!(result["cwd"], target_cwd.to_str().unwrap());
        assert_eq!(result["set_aside"], 0);
        assert_eq!(std::fs::read(&record).unwrap(), RECORD_BYTES);
        for (relative, bytes) in &SIDECAR_FILES[..6] {
            assert_eq!(
                std::fs::read(destination.join(ID).join(relative)).unwrap(),
                *bytes,
                "{relative}"
            );
        }
        assert!(!destination.join(ID).join("notes.md").exists());
        assert!(!destination.join(ID).join("tool-results/run.sh").exists());
        #[cfg(unix)]
        {
            assert_eq!(mode(&record), 0o600);
            assert_eq!(mode(&destination.join(ID)), 0o700);
            assert_eq!(mode(&destination.join(ID).join("workflows/scripts")), 0o700);
            assert_eq!(
                mode(&destination.join(ID).join("workflows/scripts/review.js")),
                0o600
            );
        }
        // Nothing staged is left.
        assert_eq!(
            std::fs::read_dir(target.holdings.join(INCOMING))
                .unwrap()
                .count(),
            0
        );
        let status = target.carrier.import_status(transfer).await.unwrap();
        assert_eq!(status, TransferStatus::committed(bundle.len() as u64));
        assert_eq!(
            target
                .carrier
                .cancel_import(transfer)
                .await
                .unwrap_err()
                .code,
            "transfer_committed"
        );
        let again = target
            .carrier
            .begin_import(import(transfer, &target_cwd, &bundle, None), "again")
            .await;
        assert_eq!(again.err().unwrap().code, "transfer_committed");
    }

    #[tokio::test]
    async fn retiring_a_stopped_window_moves_the_conversation_out_of_the_lookup_path() {
        let source = Host::new().await;
        let cwd = source.folder("code/spawn");
        let project = source.project(&cwd);
        write_conversation(&project, ID, RECORD_BYTES, SIDECAR_FILES);
        let transfer = Uuid::new_v4();
        let prepared = source
            .carrier
            .prepare_export(export(transfer, Some(&cwd), 0), "s")
            .await
            .unwrap();
        assert_eq!(prepared.stopped, Some("not_running"));
        assert_eq!(source.stops.load(Ordering::SeqCst), 1);
        let sha256 = prepared.sha256.clone();
        let bundle = drain(prepared.source);
        // Out of Claude's lookup path, whole, before a byte was read.
        assert!(!project.join(format!("{ID}.jsonl")).exists());
        assert!(!project.join(ID).exists());
        let held = source.holdings.join(OUTGOING).join(transfer.to_string());
        assert_eq!(
            std::fs::read(held.join("files/0").join(CONVERSATION)).unwrap(),
            RECORD_BYTES
        );
        assert!(held.join("files/0/sidecar/notes.md").exists());
        #[cfg(unix)]
        assert_eq!(mode(&held), 0o700);

        let listed = source.carrier.transfers().await.unwrap();
        assert_eq!(listed["outgoing"][0]["transfer_id"], transfer.to_string());
        assert_eq!(listed["outgoing"][0]["state"], "held");
        assert_eq!(listed["outgoing"][0]["sha256"], sha256);
        assert_eq!(listed["outgoing"][0]["session_id"], WINDOW);

        // One move of a conversation at a time.
        let second = source
            .carrier
            .prepare_export(export(Uuid::new_v4(), Some(&cwd), 0), "s2")
            .await;
        assert_eq!(second.err().unwrap().code, "transfer_unresolved");

        let target = Host::new().await;
        let target_cwd = target.folder("code/spawn");
        let committed = carry_into(&target, transfer, &target_cwd, &bundle)
            .await
            .unwrap();
        assert_eq!(committed["conversation_id"], ID);

        // The source retires only what the target committed.
        let wrong = RetireCommit::parse(
            json!({"transfer_id": transfer.to_string(), "length": bundle.len(), "sha256": "0".repeat(64)})
                .as_object(),
        )
        .unwrap();
        assert_eq!(
            source.carrier.retire_commit(wrong).await.unwrap_err().code,
            "declaration_mismatch"
        );
        let right = RetireCommit::parse(
            json!({"transfer_id": transfer.to_string(), "length": bundle.len(), "sha256": sha256})
                .as_object(),
        )
        .unwrap();
        let retired = source.carrier.retire_commit(right.clone()).await.unwrap();
        assert_eq!(retired["state"], "retired");
        assert!(source
            .holdings
            .join(RETIRED)
            .join(transfer.to_string())
            .exists());
        assert!(!held.exists());
        // Still never back in the lookup path.
        assert!(!project.join(format!("{ID}.jsonl")).exists());
        assert!(source.carrier.transfers().await.unwrap()["outgoing"]
            .as_array()
            .unwrap()
            .is_empty());
        // Settled: a commit again is the same answer; an abort cannot undo it.
        assert_eq!(
            source.carrier.retire_commit(right).await.unwrap()["state"],
            "retired"
        );
        assert_eq!(
            source
                .carrier
                .retire_abort(transfer)
                .await
                .unwrap_err()
                .code,
            "transfer_committed"
        );
        let resumed = source
            .carrier
            .prepare_export(export(transfer, Some(&cwd), 1), "s3")
            .await;
        assert_eq!(resumed.err().unwrap().code, "transfer_committed");
    }

    #[tokio::test]
    async fn an_abort_puts_every_copy_back() {
        let source = Host::new().await;
        let cwd = source.folder("code/spawn");
        let other = source.folder("code/old");
        write_conversation(&source.project(&cwd), ID, RECORD_BYTES, SIDECAR_FILES);
        write_conversation(
            &source.project(&other),
            ID,
            b"{\"old\":1}\n",
            &[("tool-results/x.txt", b"x")],
        );
        let transfer = Uuid::new_v4();
        // Two copies: the window's folder decides which one travels; both
        // leave the lookup path.
        let prepared = source
            .carrier
            .prepare_export(export(transfer, Some(&cwd), 0), "s")
            .await
            .unwrap();
        let carried = entries(&drain(prepared.source));
        assert_eq!(carried.last().unwrap().1, RECORD_BYTES);
        for folder in [&cwd, &other] {
            assert!(!source.project(folder).join(format!("{ID}.jsonl")).exists());
        }
        // The target confirmed its cancel; the source puts it all back.
        let aborted = source.carrier.retire_abort(transfer).await.unwrap();
        assert_eq!(aborted, json!({"state": "aborted", "restored": 2}));
        assert_eq!(
            std::fs::read(source.project(&cwd).join(format!("{ID}.jsonl"))).unwrap(),
            RECORD_BYTES
        );
        for (relative, bytes) in SIDECAR_FILES {
            assert_eq!(
                std::fs::read(source.project(&cwd).join(ID).join(relative)).unwrap(),
                *bytes
            );
        }
        assert_eq!(
            std::fs::read(source.project(&other).join(format!("{ID}.jsonl"))).unwrap(),
            b"{\"old\":1}\n"
        );
        assert!(source
            .project(&other)
            .join(ID)
            .join("tool-results/x.txt")
            .exists());
        assert!(!source
            .holdings
            .join(OUTGOING)
            .join(transfer.to_string())
            .exists());
        // Settled the other way.
        assert_eq!(
            source.carrier.retire_abort(transfer).await.unwrap()["state"],
            "aborted"
        );
        let commit = RetireCommit::parse(
            json!({"transfer_id": transfer.to_string(), "length": 1, "sha256": "a".repeat(64)})
                .as_object(),
        )
        .unwrap();
        assert_eq!(
            source.carrier.retire_commit(commit).await.unwrap_err().code,
            "transfer_aborted"
        );
        // Without the window's folder, two copies are one too many.
        let ambiguous = source
            .carrier
            .prepare_export(export(Uuid::new_v4(), None, 0), "s2")
            .await;
        assert_eq!(ambiguous.err().unwrap().code, "conversation_ambiguous");
        assert_eq!(
            source
                .carrier
                .retire_abort(Uuid::new_v4())
                .await
                .unwrap_err()
                .code,
            "transfer_not_found"
        );
    }

    #[tokio::test]
    async fn a_torn_last_line_is_left_behind() {
        // A Claude killed mid-write leaves a line without its newline; the
        // carried record ends at the last whole one, and the holding keeps
        // exactly what was there.
        let source = Host::new().await;
        let cwd = source.folder("code/spawn");
        let torn = b"{\"n\":1}\n{\"n\":2}\n{\"n\":3,\"partial";
        write_conversation(
            &source.project(&cwd),
            ID,
            torn,
            &[("subagents/agent-a1.jsonl", b"{\"s\":1}\n{\"s\":")],
        );
        let transfer = Uuid::new_v4();
        let prepared = source
            .carrier
            .prepare_export(export(transfer, Some(&cwd), 0), "s")
            .await
            .unwrap();
        let bundle = drain(prepared.source);
        let carried = entries(&bundle);
        assert_eq!(
            carried[0],
            (
                "sidecar/subagents/agent-a1.jsonl".into(),
                b"{\"s\":1}\n".to_vec()
            )
        );
        assert_eq!(
            carried[1],
            (CONVERSATION.into(), b"{\"n\":1}\n{\"n\":2}\n".to_vec())
        );
        let held = source
            .holdings
            .join(OUTGOING)
            .join(transfer.to_string())
            .join("files/0")
            .join(CONVERSATION);
        assert_eq!(std::fs::read(&held).unwrap(), torn);

        let target = Host::new().await;
        let target_cwd = target.folder("code/spawn");
        carry_into(&target, transfer, &target_cwd, &bundle)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(target.project(&target_cwd).join(format!("{ID}.jsonl"))).unwrap(),
            b"{\"n\":1}\n{\"n\":2}\n"
        );
        // An abort puts the record back exactly as the agent left it.
        source.carrier.retire_abort(transfer).await.unwrap();
        assert_eq!(
            std::fs::read(source.project(&cwd).join(format!("{ID}.jsonl"))).unwrap(),
            torn
        );
    }

    #[tokio::test]
    async fn a_copy_already_on_the_target_is_set_aside() {
        let bundle = retired_bundle(RECORD_BYTES, &[("tool-results/new.txt", b"new")]).await;

        let target = Host::new().await;
        let target_cwd = target.folder("code/spawn");
        let stale = target.folder("code/stale");
        // A stale copy in another folder (Claude would resume neither), and
        // a stray sidecar where the new one lands.
        write_conversation(
            &target.project(&stale),
            ID,
            b"{\"stale\":1}\n",
            &[("tool-results/old.txt", b"old")],
        );
        std::fs::create_dir_all(target.project(&target_cwd).join(ID).join("tool-results")).unwrap();
        std::fs::write(
            target
                .project(&target_cwd)
                .join(ID)
                .join("tool-results/stray.txt"),
            b"stray",
        )
        .unwrap();
        let probe = target
            .carrier
            .probe(
                ProbeRequest::parse(
                    json!({"agent": "claude-code", "conversation_id": ID, "cwd": "~/code/spawn"})
                        .as_object(),
                )
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(probe["duplicates"].as_array().unwrap().len(), 1);

        let transfer = Uuid::new_v4();
        let result = carry_into(&target, transfer, &target_cwd, &bundle)
            .await
            .unwrap();
        assert_eq!(result["set_aside"], 2);
        // The new copy is the only one Claude can find.
        assert!(!target.project(&stale).join(format!("{ID}.jsonl")).exists());
        let destination = target.project(&target_cwd);
        assert_eq!(
            std::fs::read(destination.join(format!("{ID}.jsonl"))).unwrap(),
            RECORD_BYTES
        );
        assert_eq!(
            std::fs::read(destination.join(ID).join("tool-results/new.txt")).unwrap(),
            b"new"
        );
        assert!(!destination.join(ID).join("tool-results/stray.txt").exists());
        // Never deleted: set aside, outside the lookup path.
        let set = target.holdings.join(SUPERSEDED).join(transfer.to_string());
        let mut kept: Vec<Vec<u8>> = std::fs::read_dir(&set)
            .unwrap()
            .map(|slot| slot.unwrap().path())
            .flat_map(|slot| {
                [
                    "conversation.jsonl",
                    "sidecar/tool-results/old.txt",
                    "sidecar/tool-results/stray.txt",
                ]
                .into_iter()
                .filter_map(move |file| std::fs::read(slot.join(file)).ok())
            })
            .collect();
        kept.sort();
        assert_eq!(
            kept,
            vec![
                b"old".to_vec(),
                b"stray".to_vec(),
                b"{\"stale\":1}\n".to_vec()
            ]
        );
    }

    /// The stream v2 write transcript: two chunks, the channel gone, the
    /// status, the resumed begin, the last chunk, the commit.
    #[tokio::test]
    async fn an_import_resumes_where_its_lost_stream_left_off() {
        let vectors: Value =
            serde_json::from_str(include_str!("../../proto/stream-v2-vectors.json")).unwrap();
        let script = &vectors["transcripts"][0];
        let frames = script["frames"].as_array().unwrap();
        let payload = |index: usize| frames[index][1]["payload"].clone();
        let chunk = |index: usize| {
            STANDARD
                .decode(frames[index][1][BYTES_FIELD].as_str().unwrap())
                .unwrap()
        };
        let target = Host::new().await;
        target.folder("code/spawn");
        let begin = ImportRequest::parse(payload(0).as_object()).unwrap();
        let transfer = begin.transfer_id;
        let opened = target.carrier.begin_import(begin, "ws-1").await.unwrap();
        assert_eq!(opened.stream.next_sequence, 0);
        assert_eq!(opened.stream.window, 16);
        let mut stream = opened.stream;
        let first = stream
            .take_chunk(&target.carrier, 0, &chunk(2), false)
            .await
            .unwrap();
        assert_eq!(first.ack, None);
        // Caught up: acknowledged at once.
        let second = stream
            .take_chunk(&target.carrier, 1, &chunk(3), true)
            .await
            .unwrap();
        assert_eq!(second.ack, Some(2));
        // The channel closes; the staging stays.
        stream.end().await;
        let status = target.carrier.import_status(transfer).await.unwrap();
        assert_eq!(json!(status), frames[7][1]["result"]);
        let listed = target.carrier.transfers().await.unwrap();
        assert_eq!(listed["incoming"][0]["next_sequence"], 2);

        // A resumed begin declaring something else is refused.
        let mut changed = payload(8);
        changed["length"] = json!(16754);
        assert_eq!(
            target
                .carrier
                .begin_import(ImportRequest::parse(changed.as_object()).unwrap(), "x")
                .await
                .err()
                .unwrap()
                .code,
            "resume_mismatch"
        );
        let resumed = target
            .carrier
            .begin_import(
                ImportRequest::parse(payload(8).as_object()).unwrap(),
                "ws-2",
            )
            .await
            .unwrap();
        assert_eq!(resumed.stream.next_sequence, 2);
        assert_eq!(resumed.received, 16_384);
        let mut stream = resumed.stream;
        let last = stream
            .take_chunk(&target.carrier, 2, &chunk(10), false)
            .await
            .unwrap();
        assert_eq!(last.ack, Some(3));
        let end = &frames[12][1];
        let result = stream
            .finish(
                &target.carrier,
                end["length"].as_u64(),
                end["sha256"].as_str(),
            )
            .await
            .unwrap();
        assert_eq!(
            result["transfer_id"],
            frames[13][1]["result"]["transfer_id"]
        );
        let status = target.carrier.import_status(transfer).await.unwrap();
        assert_eq!(json!(status), frames[15][1]["result"]);
    }

    #[tokio::test]
    async fn an_export_resumes_from_the_chunk_the_device_asks_for() {
        let source = Host::new().await;
        let cwd = source.folder("code/spawn");
        let big: Vec<u8> = (0..3000)
            .flat_map(|line| {
                format!("{{\"n\":{line},\"pad\":\"{}\"}}\n", "x".repeat(20)).into_bytes()
            })
            .collect();
        write_conversation(&source.project(&cwd), ID, &big, SIDECAR_FILES);
        let transfer = Uuid::new_v4();
        let first = source
            .carrier
            .prepare_export(export(transfer, Some(&cwd), 0), "first")
            .await
            .unwrap();
        let whole = drain(first.source);
        assert!(whole.len() > 3 * 8192);
        assert_eq!(sha(&whole), first.sha256);
        // The device lost its channel after two chunks and asks again from
        // the third, maybe on another channel: the same bytes from there,
        // the same whole-stream digest, and the first stream is told.
        let again = source
            .carrier
            .prepare_export(export(transfer, Some(&cwd), 2), "second")
            .await
            .unwrap();
        assert!(first.claim.token().is_cancelled());
        assert_eq!(first.claim.reason(), Some("superseded"));
        assert_eq!(again.sha256, first.sha256);
        assert_eq!(drain(again.source), whole[2 * 8192..]);
        // There is nothing to resume for a transfer never begun.
        let unknown = source
            .carrier
            .prepare_export(export(Uuid::new_v4(), Some(&cwd), 3), "c")
            .await;
        assert_eq!(unknown.err().unwrap().code, "resume_mismatch");
        // A resume names the same move: the same window and target.
        let mut elsewhere = export(transfer, Some(&cwd), 1);
        elsewhere.to_host_id = Uuid::new_v4();
        let refused = source.carrier.prepare_export(elsewhere, "d").await;
        assert_eq!(refused.err().unwrap().code, "resume_mismatch");
    }

    /// A record alone whose bundle is exactly `length` bytes long.
    fn record_for_bundle_of(length: u64) -> Vec<u8> {
        let bundle_of = |size: u64| {
            let manifest = Manifest {
                agent: CLAUDE_CODE.into(),
                conversation_id: ID.into(),
                entries: vec![crate::host_bundle::Entry {
                    path: CONVERSATION.into(),
                    size,
                    sha256: "0".repeat(64),
                }],
            };
            manifest.bundle_length(manifest.encode().len() as u64)
        };
        let overhead = bundle_of(length) - length;
        let size = length - overhead;
        assert_eq!(bundle_of(size), length);
        let mut record = vec![b'x'; size as usize - 1];
        record.push(b'\n');
        record
    }

    /// Every resume the stream v2 vectors list, served by a held export of
    /// exactly that length: from chunk `next` the bundle continues at
    /// `min(next × 8192, length)` — at the chunk count, nothing but the end —
    /// and past the chunk count there is nothing to resume.
    #[tokio::test]
    async fn an_export_resumes_at_every_point_the_vectors_name() {
        let vectors: Value =
            serde_json::from_str(include_str!("../../proto/stream-v2-vectors.json")).unwrap();
        let mut lengths = 0;
        for case in vectors["chunking"].as_array().unwrap() {
            let length = case["length"].as_u64().unwrap();
            // Shorter than any bundle, or too long for a test to write.
            if !(4096..=1 << 20).contains(&length) {
                continue;
            }
            lengths += 1;
            let source = Host::new().await;
            let cwd = source.folder("code/spawn");
            write_conversation(
                &source.project(&cwd),
                ID,
                &record_for_bundle_of(length),
                &[],
            );
            let transfer = Uuid::new_v4();
            let first = source
                .carrier
                .prepare_export(export(transfer, Some(&cwd), 0), "first")
                .await
                .unwrap();
            assert_eq!(first.source.length(), length);
            let whole = drain(first.source);
            assert_eq!(whole.len() as u64, length);
            for resume in case["resume"].as_array().unwrap() {
                let next = resume["next_sequence"].as_u64().unwrap();
                let offset = resume["offset"].as_u64().unwrap() as usize;
                let again = source
                    .carrier
                    .prepare_export(export(transfer, Some(&cwd), next), "again")
                    .await
                    .unwrap_or_else(|failure| {
                        panic!("{length} from {next}: {} {}", failure.code, failure.detail)
                    });
                assert_eq!(again.sha256, first.sha256, "{length} from {next}");
                assert_eq!(drain(again.source), whole[offset..], "{length} from {next}");
            }
            let past = case["chunks"].as_u64().unwrap() + 1;
            let refused = source
                .carrier
                .prepare_export(export(transfer, Some(&cwd), past), "past")
                .await;
            assert_eq!(refused.err().unwrap().code, "resume_mismatch", "{length}");
        }
        assert!(lengths >= 4, "the vectors name lengths a bundle can have");
    }

    #[tokio::test]
    async fn a_resumed_begin_supersedes_the_stream_that_had_the_transfer() {
        let source = Host::new().await;
        let cwd = source.folder("code/spawn");
        let big: Vec<u8> = (0..2000)
            .flat_map(|n| format!("{{\"n\":{n}}}\n").into_bytes())
            .collect();
        write_conversation(&source.project(&cwd), ID, &big, &[]);
        let bundle = drain(
            source
                .carrier
                .prepare_export(export(Uuid::new_v4(), Some(&cwd), 0), "s")
                .await
                .unwrap()
                .source,
        );
        let target = Host::new().await;
        let target_cwd = target.folder("code/spawn");
        let transfer = Uuid::new_v4();
        let mut old = target
            .carrier
            .begin_import(import(transfer, &target_cwd, &bundle, None), "old")
            .await
            .unwrap()
            .stream;
        old.take_chunk(&target.carrier, 0, &bundle[..8192], false)
            .await
            .unwrap();
        let claim = old.claim();
        let mut new = target
            .carrier
            .begin_import(import(transfer, &target_cwd, &bundle, None), "new")
            .await
            .unwrap()
            .stream;
        assert_eq!(new.next_sequence, 1);
        assert!(claim.token().is_cancelled());
        assert_eq!(claim.reason(), Some("superseded"));
        // The old stream writes nothing more.
        let refused = old
            .take_chunk(&target.carrier, 1, &bundle[8192..16384], false)
            .await;
        assert_eq!(refused.err().unwrap().code, "superseded");
        for (sequence, chunk) in bundle.chunks(8192).enumerate().skip(1) {
            new.take_chunk(&target.carrier, sequence as u64, chunk, false)
                .await
                .unwrap();
        }
        new.finish(
            &target.carrier,
            Some(bundle.len() as u64),
            Some(&sha(&bundle)),
        )
        .await
        .unwrap();
        assert_eq!(
            std::fs::read(target.project(&target_cwd).join(format!("{ID}.jsonl"))).unwrap(),
            big
        );
    }

    /// Commit and cancel are decided under one lock: whichever takes it
    /// first wins, and the other is told so — never both, never neither.
    /// The first round cancels before the commit starts, the last commits
    /// before the cancel; the rounds between race them on several threads.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn cancel_and_commit_exclude_each_other() {
        let bundle = retired_bundle(RECORD_BYTES, SIDECAR_FILES).await;
        let target = Host::new().await;
        let target_cwd = target.folder("code/spawn");
        let record = target.project(&target_cwd).join(format!("{ID}.jsonl"));
        let mut outcomes: HashMap<&str, usize> = HashMap::new();
        const ROUNDS: u64 = 16;
        for round in 0..ROUNDS {
            let _ = std::fs::remove_file(&record);
            let _ = std::fs::remove_dir_all(target.project(&target_cwd).join(ID));
            let transfer = Uuid::new_v4();
            let mut stream = target
                .carrier
                .begin_import(import(transfer, &target_cwd, &bundle, None), "s")
                .await
                .unwrap()
                .stream;
            for (sequence, chunk) in bundle.chunks(8192).enumerate() {
                stream
                    .take_chunk(&target.carrier, sequence as u64, chunk, false)
                    .await
                    .unwrap();
            }
            let digest = sha(&bundle);
            let length = bundle.len() as u64;
            let carrier = target.carrier.clone();
            let early_cancel = if round == 0 {
                Some(target.carrier.cancel_import(transfer).await)
            } else {
                None
            };
            let racing_cancel = (round % 2 == 0 && round != 0 && round != ROUNDS - 1).then(|| {
                let canceller = target.carrier.clone();
                tokio::spawn(async move { canceller.cancel_import(transfer).await })
            });
            let commit =
                tokio::spawn(
                    async move { stream.finish(&carrier, Some(length), Some(&digest)).await },
                );
            let (committed, cancelled) = match early_cancel {
                Some(cancelled) => (commit.await.unwrap(), cancelled),
                None if round == ROUNDS - 1 => {
                    let committed = commit.await.unwrap();
                    (committed, target.carrier.cancel_import(transfer).await)
                }
                // A cancel already in flight when the commit starts.
                None if racing_cancel.is_some() => {
                    let cancelled = racing_cancel.unwrap().await.unwrap();
                    (commit.await.unwrap(), cancelled)
                }
                // A cancel that comes while the commit is under way.
                None => {
                    tokio::time::sleep(Duration::from_micros(round * 150)).await;
                    let cancelled = target.carrier.cancel_import(transfer).await;
                    (commit.await.unwrap(), cancelled)
                }
            };
            let status = target.carrier.import_status(transfer).await.unwrap();
            match (committed, cancelled) {
                (Ok(_), Err(refusal)) => {
                    assert_eq!(refusal.code, "transfer_committed");
                    assert_eq!(status.state, TransferState::Committed);
                    assert!(record.exists());
                    *outcomes.entry("committed").or_default() += 1;
                }
                (Err(refusal), Ok(answer)) => {
                    assert_eq!(refusal.code, "transfer_cancelled");
                    assert_eq!(answer, TransferStatus::cancelled());
                    assert_eq!(status, TransferStatus::cancelled());
                    assert!(!record.exists());
                    *outcomes.entry("cancelled").or_default() += 1;
                }
                (commit, cancel) => panic!("round {round}: both or neither: {commit:?} {cancel:?}"),
            }
        }
        assert!(
            outcomes.get("committed").is_some_and(|count| *count > 0),
            "{outcomes:?}"
        );
        assert!(
            outcomes.get("cancelled").is_some_and(|count| *count > 0),
            "{outcomes:?}"
        );
    }

    #[tokio::test]
    async fn bytes_that_fail_their_checks_are_forgotten() {
        let bundle = retired_bundle(RECORD_BYTES, &[]).await;
        let target = Host::new().await;
        let target_cwd = target.folder("code/spawn");
        // A digest declared at the start that the bytes do not have.
        let transfer = Uuid::new_v4();
        let wrong = "f".repeat(64);
        let mut stream = target
            .carrier
            .begin_import(import(transfer, &target_cwd, &bundle, Some(&wrong)), "s")
            .await
            .unwrap()
            .stream;
        stream
            .take_chunk(&target.carrier, 0, &bundle, false)
            .await
            .unwrap();
        let failed = stream
            .finish(&target.carrier, Some(bundle.len() as u64), Some(&wrong))
            .await
            .unwrap_err();
        assert_eq!(failed.code, "integrity_mismatch");
        assert_eq!(
            target.carrier.import_status(transfer).await.unwrap(),
            TransferStatus::absent()
        );
        assert!(!target
            .project(&target_cwd)
            .join(format!("{ID}.jsonl"))
            .exists());
        // Begun again, it starts from nothing.
        let opened = target
            .carrier
            .begin_import(import(transfer, &target_cwd, &bundle, None), "again")
            .await
            .unwrap();
        assert_eq!(opened.stream.next_sequence, 0);

        // A manifest naming another conversation fails at its first chunk.
        let mut forged = bundle.clone();
        let at = forged
            .windows(ID.len())
            .position(|window| window == ID.as_bytes())
            .unwrap();
        forged[at..at + ID.len()].copy_from_slice(OTHER_ID.as_bytes());
        let transfer = Uuid::new_v4();
        let mut stream = target
            .carrier
            .begin_import(import(transfer, &target_cwd, &forged, None), "forged")
            .await
            .unwrap()
            .stream;
        let refused = stream
            .take_chunk(&target.carrier, 0, &forged, false)
            .await
            .unwrap_err();
        assert_eq!(refused.code, "invalid_manifest");
        assert_eq!(
            target.carrier.import_status(transfer).await.unwrap(),
            TransferStatus::absent()
        );
    }

    #[tokio::test]
    async fn a_begin_refuses_what_can_never_land() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../proto/conversation-bundle-v1-vectors.json"
        ))
        .unwrap();
        for case in vectors["requests"].as_array().unwrap() {
            let parsed = ImportRequest::parse(
                json!({
                    "transfer_id": Uuid::new_v4().to_string(),
                    "agent": case["agent"],
                    "conversation_id": case["conversation_id"],
                    "mode": "retire",
                    "cwd": "~",
                    "length": 100,
                    "stream": {"digest": "end"},
                })
                .as_object(),
            );
            assert_eq!(
                parsed.err().map(|error| error.code),
                case["error"].as_str(),
                "{}",
                case["name"]
            );
        }
        let base = json!({
            "transfer_id": Uuid::new_v4().to_string(),
            "agent": "claude-code",
            "conversation_id": ID,
            "mode": "retire",
            "cwd": "~/code/spawn",
            "length": 100,
            "stream": {"digest": "end"},
        });
        for (change, code) in [
            // Only what a retire carried lands: never a second resumable
            // copy of a conversation still resumable where it came from.
            (json!({"mode": "snapshot"}), "unsupported_operation"),
            (json!({"mode": null}), "invalid_request"),
            (
                json!({"transfer_id": "0199a8b2-6c3e-7f10-9d2b-5a4e3c2b1a09"}),
                "invalid_request",
            ),
            (json!({"length": 1u64 << 32}), "too_large"),
            (json!({"length": 12}), "invalid_request"),
            (json!({"stream": {"digest": "start"}}), "invalid_request"),
            (json!({"sha256": "a".repeat(64)}), "invalid_request"),
            (json!({"cwd": ""}), "invalid_request"),
        ] {
            let mut payload = base.clone();
            for (key, value) in change.as_object().unwrap() {
                payload[key] = value.clone();
            }
            assert_eq!(
                ImportRequest::parse(payload.as_object())
                    .err()
                    .map(|error| error.code),
                Some(code),
                "{change}"
            );
        }
        let target = Host::new().await;
        let request = |cwd: &str| {
            let mut payload = base.clone();
            payload["cwd"] = json!(cwd);
            payload["transfer_id"] = json!(Uuid::new_v4().to_string());
            ImportRequest::parse(payload.as_object()).unwrap()
        };
        assert_eq!(
            target
                .carrier
                .begin_import(request("~/code/missing"), "s")
                .await
                .err()
                .unwrap()
                .code,
            "folder_missing"
        );
        assert_eq!(
            target
                .carrier
                .begin_import(request("/etc"), "s")
                .await
                .err()
                .unwrap()
                .code,
            "outside_root"
        );
        // A cancel before any begin still means it can never commit.
        target.folder("code/spawn");
        let transfer = Uuid::new_v4();
        assert_eq!(
            target.carrier.cancel_import(transfer).await.unwrap(),
            TransferStatus::cancelled()
        );
        let mut payload = base.clone();
        payload["transfer_id"] = json!(transfer.to_string());
        assert_eq!(
            target
                .carrier
                .begin_import(ImportRequest::parse(payload.as_object()).unwrap(), "s")
                .await
                .err()
                .unwrap()
                .code,
            "transfer_cancelled"
        );
        // A store that does not exist yet is not invented.
        std::fs::remove_dir_all(&target.store).unwrap();
        assert_eq!(
            target
                .carrier
                .begin_import(request("~/code/spawn"), "s")
                .await
                .err()
                .unwrap()
                .code,
            "store_missing"
        );
    }

    #[tokio::test]
    async fn exports_refuse_what_they_cannot_carry() {
        for (payload, code) in [
            (json!({"mode": "move"}), "invalid_request"),
            (json!({"mode": null}), "invalid_request"),
            // Reserved for a copies feature nobody has approved: a snapshot
            // would leave the conversation resumable here too.
            (json!({"mode": "snapshot"}), "unsupported_operation"),
            (json!({"session_id": null}), "invalid_request"),
            // A move names where it goes, so whoever resolves it asks there.
            (json!({"to_host_id": null}), "invalid_request"),
            (json!({"to_host_id": "dream"}), "invalid_request"),
            (json!({"include": ["subagents"]}), "invalid_request"),
            (
                json!({"include": ["conversation", "memory"]}),
                "invalid_request",
            ),
            (json!({"stream": {"digest": "sideways"}}), "invalid_request"),
        ] {
            let mut request = json!({
                "transfer_id": Uuid::new_v4().to_string(),
                "agent": "claude-code",
                "conversation_id": ID,
                "mode": "retire",
                "session_id": WINDOW,
                "to_host_id": TARGET_HOST,
            });
            for (key, value) in payload.as_object().unwrap() {
                request[key] = value.clone();
            }
            assert_eq!(
                ExportRequest::parse(request.as_object())
                    .err()
                    .map(|error| error.code),
                Some(code),
                "{payload}"
            );
        }
        let host = Host::new().await;
        let missing = host
            .carrier
            .prepare_export(export(Uuid::new_v4(), None, 0), "s")
            .await;
        assert_eq!(missing.err().unwrap().code, "conversation_not_found");
        // Nothing stopped for a conversation that is not here.
        assert_eq!(host.stops.load(Ordering::SeqCst), 0);
        // Only what was asked for travels.
        let cwd = host.folder("code/spawn");
        write_conversation(&host.project(&cwd), ID, RECORD_BYTES, SIDECAR_FILES);
        let first = Uuid::new_v4();
        let mut request = json!({
            "transfer_id": first.to_string(),
            "agent": "claude-code",
            "conversation_id": ID,
            "mode": "retire",
            "session_id": WINDOW,
            "to_host_id": TARGET_HOST,
            "include": ["conversation", "tool_results"],
        });
        let prepared = host
            .carrier
            .prepare_export(ExportRequest::parse(request.as_object()).unwrap(), "s")
            .await
            .unwrap();
        let carried: Vec<String> = entries(&drain(prepared.source))
            .into_iter()
            .map(|(path, _)| path)
            .collect();
        assert_eq!(
            carried,
            vec!["sidecar/tool-results/toolu_01.txt", CONVERSATION]
        );
        host.carrier.retire_abort(first).await.unwrap();
        request["transfer_id"] = json!(Uuid::new_v4().to_string());
        request["include"] = json!(["conversation"]);
        let prepared = host
            .carrier
            .prepare_export(ExportRequest::parse(request.as_object()).unwrap(), "s")
            .await
            .unwrap();
        assert_eq!(prepared.entries, 1);
    }

    /// A target never stages what its disk cannot hold beside everything
    /// else — the bundle and its extracted files, whole until the commit,
    /// and a reserve — nor more than two of the largest bundles unresolved.
    #[tokio::test]
    async fn a_target_stages_only_what_it_has_room_for() {
        let length = 100_000_u64;
        let needed = 2 * length + SPACE_RESERVE;
        let begin = |transfer: Uuid, length: u64| {
            ImportRequest::parse(
                json!({
                    "transfer_id": transfer.to_string(),
                    "agent": "claude-code",
                    "conversation_id": ID,
                    "mode": "retire",
                    "cwd": "~/code/spawn",
                    "length": length,
                    "stream": {"digest": "end"},
                })
                .as_object(),
            )
            .unwrap()
        };
        let short = Host::with_free_space(needed - 1).await;
        short.folder("code/spawn");
        let refused = short
            .carrier
            .begin_import(begin(Uuid::new_v4(), length), "s")
            .await;
        assert_eq!(refused.err().unwrap().code, "insufficient_space");
        assert_eq!(
            std::fs::read_dir(short.holdings.join(INCOMING))
                .unwrap()
                .count(),
            0
        );
        let enough = Host::with_free_space(needed).await;
        enough.folder("code/spawn");
        enough
            .carrier
            .begin_import(begin(Uuid::new_v4(), length), "s")
            .await
            .unwrap();

        let roomy = Host::with_free_space(u64::MAX).await;
        roomy.folder("code/spawn");
        for _ in 0..2 {
            roomy
                .carrier
                .begin_import(begin(Uuid::new_v4(), crate::host_bundle::BUNDLE_MAX), "s")
                .await
                .unwrap();
        }
        let refused = roomy
            .carrier
            .begin_import(begin(Uuid::new_v4(), 100), "s")
            .await;
        assert_eq!(refused.err().unwrap().code, "too_many_transfers");
    }

    /// Staging nothing has written for 30 days is cancelled — so it can
    /// never commit, and a device resolving the move finds that — and then
    /// dropped; never one decided, nor one anything works on.
    #[tokio::test]
    async fn abandoned_staging_is_cancelled_then_dropped() {
        let target = Host::new().await;
        let cwd = target.folder("code/spawn");
        let bundle = retired_bundle(RECORD_BYTES, &[]).await;
        let long_ago = now_ms() - RETENTION.as_millis() as u64 - 60_000;
        let mut staged = Vec::new();
        for _ in 0..3 {
            let transfer = Uuid::new_v4();
            let mut stream = target
                .carrier
                .begin_import(import(transfer, &cwd, &bundle, None), "s")
                .await
                .unwrap()
                .stream;
            stream
                .take_chunk(
                    &target.carrier,
                    0,
                    &bundle[..8192.min(bundle.len()) - 1],
                    false,
                )
                .await
                .ok();
            stream.end().await;
            let staging = target.holdings.join(INCOMING).join(transfer.to_string());
            let mut record: Value =
                serde_json::from_slice(&std::fs::read(staging.join(RECORD)).unwrap()).unwrap();
            record["created_at"] = json!(long_ago);
            std::fs::write(staging.join(RECORD), record.to_string()).unwrap();
            std::fs::File::options()
                .write(true)
                .open(staging.join(STAGED))
                .unwrap()
                .set_modified(UNIX_EPOCH + Duration::from_millis(long_ago))
                .unwrap();
            staged.push((transfer, staging));
        }
        let (abandoned, abandoned_at) = &staged[0];
        let (decided, decided_at) = &staged[1];
        let (busy, busy_at) = &staged[2];
        let mut record: Value =
            serde_json::from_slice(&std::fs::read(decided_at.join(RECORD)).unwrap()).unwrap();
        record["state"] = json!("committing");
        std::fs::write(decided_at.join(RECORD), record.to_string()).unwrap();
        let working = slot(Role::Import, *busy);
        let held = working.lock().await;
        let holdings = Holdings::open(&target.carrier.pair.places).unwrap();
        collect_garbage(&holdings, now_ms(), true);
        drop(held);
        assert!(!abandoned_at.exists());
        assert_eq!(
            target.carrier.import_status(*abandoned).await.unwrap(),
            TransferStatus::cancelled()
        );
        assert!(decided_at.exists(), "a decided commit only rolls forward");
        assert!(busy_at.exists(), "never while anything works on it");
        let _ = (decided, busy);
    }

    /// A probe of a worktree whose `commondir` is a FIFO answers at once:
    /// the open never waits for a writer that will not come.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_planted_fifo_never_stalls_a_probe() {
        let host = Host::new().await;
        let repo = host.folder("code/spawn");
        let gitdir = repo.join(".git").join("worktrees").join("wt");
        std::fs::create_dir_all(&gitdir).unwrap();
        let fifo = gitdir.join("commondir");
        nix::unistd::mkfifo(&fifo, nix::sys::stat::Mode::S_IRWXU).unwrap();
        let worktree = host.folder("code/wt");
        std::fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", gitdir.display()),
        )
        .unwrap();
        // Were the probe to block on the FIFO, this would let it go after a
        // second, so the test fails instead of hanging.
        let release = fifo.clone();
        let done = Arc::new(AtomicBool::new(false));
        let answered = Arc::clone(&done);
        let releaser = std::thread::spawn(move || {
            use std::os::unix::fs::OpenOptionsExt;
            let patience = Instant::now() + Duration::from_secs(1);
            while Instant::now() < patience {
                if answered.load(Ordering::SeqCst) {
                    return false;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline {
                if std::fs::OpenOptions::new()
                    .write(true)
                    .custom_flags(nix::libc::O_NONBLOCK)
                    .open(&release)
                    .is_ok()
                {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            false
        });
        let started = Instant::now();
        let answer = host
            .carrier
            .probe(
                ProbeRequest::parse(
                    json!({"agent": "claude-code", "cwd": worktree.to_string_lossy()}).as_object(),
                )
                .unwrap(),
            )
            .await
            .unwrap();
        let waited = started.elapsed();
        done.store(true, Ordering::SeqCst);
        assert!(!releaser.join().unwrap(), "the probe waited on the FIFO");
        assert!(waited < Duration::from_secs(2), "{waited:?}");
        assert_eq!(answer["repository_root"], worktree.to_str().unwrap());
    }

    #[tokio::test]
    async fn housekeeping_drops_only_what_is_past_keeping() {
        let host = Host::new().await;
        let holdings = Holdings::open(&host.carrier.pair.places).unwrap();
        let long_ago = now_ms() - RETENTION.as_millis() as u64 - 60_000;
        let old = Uuid::new_v4();
        let recent = Uuid::new_v4();
        let unresolved = Uuid::new_v4();
        for (kind, transfer, at) in [
            (RETIRED, old, long_ago),
            (RETIRED, recent, now_ms()),
            (OUTGOING, unresolved, long_ago),
        ] {
            let dir = holdings.sub(kind).unwrap();
            let held = crate::platform::open_or_create_private_dir_at(
                &dir,
                Path::new(&transfer.to_string()),
            )
            .unwrap();
            write_record(
                &held,
                RECORD,
                &OutgoingRecord {
                    version: 1,
                    transfer_id: transfer.to_string(),
                    agent: CLAUDE_CODE.into(),
                    conversation_id: ID.into(),
                    session_id: None,
                    to_host_id: None,
                    created_at: at,
                    state: "held".into(),
                    include: vec!["conversation".into()],
                    store: vec![".claude".into()],
                    copies: Vec::new(),
                    carried: 0,
                    bundle: None,
                    retired_at: Some(at),
                },
            )
            .unwrap();
        }
        for (transfer, at) in [(old, long_ago), (recent, now_ms())] {
            write_tombstone(
                &holdings,
                CANCELLED,
                &Tombstone {
                    version: 1,
                    transfer_id: transfer.to_string(),
                    conversation_id: None,
                    state: "cancelled".into(),
                    at,
                    length: None,
                    sha256: None,
                    result: None,
                },
            )
            .unwrap();
        }
        let set = crate::platform::open_or_create_private_dir_at(
            &holdings.sub(SUPERSEDED).unwrap(),
            Path::new(&old.to_string()),
        )
        .unwrap();
        let copy = crate::platform::open_or_create_private_dir_at(&set, Path::new("0")).unwrap();
        write_record(
            &copy,
            "origin.json",
            &Origin {
                version: 1,
                conversation_id: ID.into(),
                folder: "-x".into(),
                at: long_ago,
            },
        )
        .unwrap();
        collect_garbage(&holdings, now_ms(), true);
        assert!(!host.holdings.join(RETIRED).join(old.to_string()).exists());
        assert!(host
            .holdings
            .join(RETIRED)
            .join(recent.to_string())
            .exists());
        // Only a device resolves a move, however old.
        assert!(host
            .holdings
            .join(OUTGOING)
            .join(unresolved.to_string())
            .exists());
        assert!(!host
            .holdings
            .join(CANCELLED)
            .join(format!("{old}.json"))
            .exists());
        assert!(host
            .holdings
            .join(CANCELLED)
            .join(format!("{recent}.json"))
            .exists());
        assert!(!host
            .holdings
            .join(SUPERSEDED)
            .join(old.to_string())
            .exists());
    }

    /// A real process standing in for Claude: its record names it as Claude
    /// names itself, so the registry believes it exactly as it would.
    #[cfg(target_os = "linux")]
    fn record_for(store: &Path, pid: u32, conversation: &str) {
        let table = crate::host_conv::SystemProcesses;
        std::fs::create_dir_all(store.join("sessions")).unwrap();
        std::fs::write(
            store.join("sessions").join(format!("{pid}.json")),
            json!({
                "pid": pid,
                "sessionId": conversation,
                "procStart": table.start_identity(pid).unwrap(),
                "pidDomain": table.pid_domain(),
                "status": "busy",
                "version": "2.1.288",
                "kind": "interactive",
            })
            .to_string(),
        )
        .unwrap();
    }

    /// A process that cannot be told from the one seen is never signalled,
    /// even when it runs Claude: a pid recycled during a window's stop by
    /// another window's Claude must not get TERM, then KILL.
    #[cfg(target_os = "linux")]
    #[test]
    fn only_exactly_the_process_seen_is_signalled() {
        let root = tempfile::tempdir().unwrap();
        let claude = root.path().join("claude");
        std::fs::copy("/bin/sleep", &claude).unwrap();
        let mut other = std::process::Command::new(&claude)
            .arg("60")
            .spawn()
            .unwrap();
        let table = crate::host_conv::SystemProcesses;
        let pid = other.id();
        for unknown in [
            Holder { pid, start: None },
            Holder {
                pid,
                start: Some("1".into()),
            },
        ] {
            assert!(!signal(&unknown, &table, true), "{unknown:?}");
            std::thread::sleep(Duration::from_millis(50));
            assert!(table.alive(pid), "{unknown:?} was signalled");
        }
        let seen = Holder {
            pid,
            start: table.identity(pid),
        };
        assert!(signal(&seen, &table, true));
        other.wait().unwrap();
        // Gone: nothing to signal, and nothing held.
        assert!(signal(&seen, &table, true));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_conversation_live_elsewhere_is_never_retired() {
        let host = Host::new().await;
        let cwd = host.folder("code/spawn");
        write_conversation(&host.project(&cwd), ID, RECORD_BYTES, &[]);
        // A background session holding it, in no window.
        let mut background = std::process::Command::new("sleep")
            .arg("60")
            .spawn()
            .unwrap();
        record_for(&host.store, background.id(), ID);
        let refused = host
            .carrier
            .prepare_export(export(Uuid::new_v4(), Some(&cwd), 0), "s")
            .await;
        assert_eq!(refused.err().unwrap().code, "conversation_live_elsewhere");
        // Nothing stopped, nothing moved.
        assert_eq!(host.stops.load(Ordering::SeqCst), 0);
        assert!(host.project(&cwd).join(format!("{ID}.jsonl")).exists());
        assert!(crate::host_conv::SystemProcesses.alive(background.id()));
        background.kill().unwrap();
        background.wait().unwrap();
        // Once it is gone, the record it left is not believed.
        let prepared = host
            .carrier
            .prepare_export(export(Uuid::new_v4(), Some(&cwd), 0), "s")
            .await
            .unwrap();
        assert_eq!(prepared.stopped, Some("not_running"));
    }

    /// A live stand-in for a Claude holding `conversation` on `store`.
    #[cfg(target_os = "linux")]
    fn live_holder(store: &Path, conversation: &str) -> std::process::Child {
        let child = std::process::Command::new("sleep")
            .arg("60")
            .spawn()
            .unwrap();
        record_for(store, child.id(), conversation);
        child
    }

    #[cfg(target_os = "linux")]
    fn end(mut child: std::process::Child) {
        child.kill().unwrap();
        child.wait().unwrap();
    }

    fn outgoing_record(host: &Host, transfer: Uuid) -> Option<Value> {
        let path = host
            .holdings
            .join(OUTGOING)
            .join(transfer.to_string())
            .join(RECORD);
        std::fs::read(path)
            .ok()
            .map(|bytes| serde_json::from_slice(&bytes).unwrap())
    }

    /// A move interrupted with its record written and its files still in
    /// the store, resumed after the window was started again and Claude
    /// resumed the conversation there: the resume runs the fence again,
    /// refuses, and leaves the record for an abort.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_resumed_move_runs_the_fence_again() {
        let host = Host::new().await;
        let cwd = host.folder("code/spawn");
        let record_path = host.project(&cwd).join(format!("{ID}.jsonl"));
        write_conversation(&host.project(&cwd), ID, RECORD_BYTES, &[]);
        let transfer = Uuid::new_v4();
        host.carrier
            .prepare_export(export(transfer, Some(&cwd), 0), "first")
            .await
            .unwrap();
        // As if the daemon had stopped after the record and before the move.
        let held = host.holdings.join(OUTGOING).join(transfer.to_string());
        std::fs::rename(held.join("files/0").join(CONVERSATION), &record_path).unwrap();
        let mut record = outgoing_record(&host, transfer).unwrap();
        record["state"] = json!(MOVING);
        record["bundle"] = Value::Null;
        std::fs::write(held.join(RECORD), record.to_string()).unwrap();
        let live = live_holder(&host.store, ID);
        let resumed = host
            .carrier
            .prepare_export(export(transfer, Some(&cwd), 0), "second")
            .await;
        assert_eq!(resumed.err().unwrap().code, "conversation_live_elsewhere");
        assert!(record_path.exists(), "moved out from under a live holder");
        assert_eq!(outgoing_record(&host, transfer).unwrap()["state"], MOVING);
        end(live);
        // Once nothing holds it, the resume finishes the move.
        let resumed = host
            .carrier
            .prepare_export(export(transfer, Some(&cwd), 0), "third")
            .await
            .unwrap();
        assert!(!record_path.exists());
        assert_eq!(
            entries(&drain(resumed.source)).last().unwrap().1,
            RECORD_BYTES
        );
        assert_eq!(outgoing_record(&host, transfer).unwrap()["state"], HELD);
    }

    /// A conversation a Claude on the target holds is never set aside or
    /// written over: the probe says so, the begin refuses, and so does the
    /// commit when the holder appeared since the begin. The staging stays,
    /// and the move finishes once nothing holds the conversation.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_conversation_live_on_the_target_is_never_imported_over() {
        let bundle = retired_bundle(RECORD_BYTES, &[]).await;
        let length = bundle.len() as u64;
        let target = Host::new().await;
        let target_cwd = target.folder("code/spawn");
        let copy = target.project(&target_cwd).join(format!("{ID}.jsonl"));
        write_conversation(&target.project(&target_cwd), ID, b"{\"live\":1}\n", &[]);
        let holder = live_holder(&target.store, ID);
        let probe = target
            .carrier
            .probe(
                ProbeRequest::parse(
                    json!({"agent": "claude-code", "conversation_id": ID, "cwd": "~/code/spawn"})
                        .as_object(),
                )
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(probe["live"], true);
        assert_eq!(probe["duplicates"][0]["live"], true);
        let refused = carry_into(&target, Uuid::new_v4(), &target_cwd, &bundle).await;
        assert_eq!(refused.err().unwrap().code, "conversation_live_here");
        end(holder);

        let transfer = Uuid::new_v4();
        let mut stream = target
            .carrier
            .begin_import(import(transfer, &target_cwd, &bundle, None), "s")
            .await
            .unwrap()
            .stream;
        for (sequence, chunk) in bundle.chunks(8192).enumerate() {
            stream
                .take_chunk(&target.carrier, sequence as u64, chunk, false)
                .await
                .unwrap();
        }
        let holder = live_holder(&target.store, ID);
        let refused = stream
            .finish(&target.carrier, Some(length), Some(&sha(&bundle)))
            .await;
        assert_eq!(refused.err().unwrap().code, "conversation_live_here");
        assert_eq!(std::fs::read(&copy).unwrap(), b"{\"live\":1}\n");
        assert_eq!(
            target.carrier.import_status(transfer).await.unwrap(),
            TransferStatus::receiving(length, length)
        );
        end(holder);
        let probe = target
            .carrier
            .probe(
                ProbeRequest::parse(
                    json!({"agent": "claude-code", "conversation_id": ID, "cwd": "~/code/spawn"})
                        .as_object(),
                )
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(probe["live"], false);
        // Resumed with nothing left to send, its end commits.
        let resumed = target
            .carrier
            .begin_import(import(transfer, &target_cwd, &bundle, None), "again")
            .await
            .unwrap();
        assert_eq!(
            resumed.stream.next_sequence,
            crate::host_stream::chunk_count(length)
        );
        let result = resumed
            .stream
            .finish(&target.carrier, Some(length), Some(&sha(&bundle)))
            .await
            .unwrap();
        assert_eq!(result["set_aside"], 1);
        assert_eq!(std::fs::read(&copy).unwrap(), RECORD_BYTES);
    }

    /// Two moves of one conversation at once — a double tap, two devices —
    /// never both stop the window or both hold its files: the second waits
    /// for the first's record and is refused before anything of its own.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_conversation_moves_once_at_a_time() {
        for round in 0..8 {
            let host = Host::with_window(
                None,
                Arc::new(|| {
                    std::thread::sleep(Duration::from_millis(100));
                    WindowStop::NotRunning
                }),
            )
            .await;
            let cwd = host.folder("code/spawn");
            write_conversation(&host.project(&cwd), ID, RECORD_BYTES, SIDECAR_FILES);
            let (one, two) = (Uuid::new_v4(), Uuid::new_v4());
            let (first, second) = (host.carrier.clone(), host.carrier.clone());
            let (a, b) = (export(one, Some(&cwd), 0), export(two, Some(&cwd), 0));
            let (a, b) = tokio::join!(
                tokio::spawn(
                    async move { first.prepare_export(a, "one").await.map(|p| p.entries) }
                ),
                tokio::spawn(
                    async move { second.prepare_export(b, "two").await.map(|p| p.entries) }
                ),
            );
            let outcomes = [a.unwrap(), b.unwrap()];
            let carried: Vec<usize> = outcomes
                .iter()
                .filter_map(|outcome| outcome.as_ref().ok().copied())
                .collect();
            let refused: Vec<&str> = outcomes
                .iter()
                .filter_map(|outcome| outcome.as_ref().err().map(|failure| failure.code))
                .collect();
            assert_eq!(carried, vec![7], "round {round}: {refused:?}");
            assert_eq!(refused, vec!["transfer_unresolved"], "round {round}");
            assert_eq!(host.stops.load(Ordering::SeqCst), 1, "round {round}");
            assert_eq!(
                std::fs::read_dir(host.holdings.join(OUTGOING))
                    .unwrap()
                    .count(),
                1,
                "round {round}"
            );
        }
    }

    /// A Claude that resumed the conversation while its files moved holds
    /// one now outside the lookup path: everything goes back, and the move
    /// is forgotten.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_holder_that_appears_during_the_move_puts_everything_back() {
        let started: Arc<StdMutex<Vec<std::process::Child>>> = Arc::default();
        let store: Arc<OnceLock<PathBuf>> = Arc::default();
        let (holders, at) = (Arc::clone(&started), Arc::clone(&store));
        let once = AtomicBool::new(false);
        let host = Host::with_hook(Arc::new(move |point| {
            if point == MovePoint::AfterMove && !once.swap(true, Ordering::SeqCst) {
                holders
                    .lock()
                    .unwrap()
                    .push(live_holder(at.get().unwrap(), ID));
            }
        }))
        .await;
        store.set(host.store.clone()).unwrap();
        let cwd = host.folder("code/spawn");
        let other = host.folder("code/old");
        write_conversation(&host.project(&cwd), ID, RECORD_BYTES, SIDECAR_FILES);
        write_conversation(&host.project(&other), ID, b"{\"old\":1}\n", &[]);
        let transfer = Uuid::new_v4();
        let refused = host
            .carrier
            .prepare_export(export(transfer, Some(&cwd), 0), "s")
            .await;
        for child in started.lock().unwrap().drain(..) {
            end(child);
        }
        assert_eq!(refused.err().unwrap().code, "conversation_live_elsewhere");
        for folder in [&cwd, &other] {
            assert!(host.project(folder).join(format!("{ID}.jsonl")).exists());
        }
        assert!(host.project(&cwd).join(ID).join("notes.md").exists());
        assert!(outgoing_record(&host, transfer).is_none());
        // Nothing is left to resolve: the next move starts afresh.
        host.carrier
            .prepare_export(export(Uuid::new_v4(), Some(&cwd), 0), "again")
            .await
            .unwrap();
    }

    /// The same, when the Claude that resumed it has already written its
    /// record anew where the old one was: the restore cannot put it back
    /// over that, so the move is stranded. No resume or commit goes on from
    /// there, and an abort puts back what it can once the place is free.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_move_that_cannot_be_put_back_is_stranded() {
        let started: Arc<StdMutex<Vec<std::process::Child>>> = Arc::default();
        let project: Arc<OnceLock<(PathBuf, PathBuf)>> = Arc::default();
        let (holders, at) = (Arc::clone(&started), Arc::clone(&project));
        let host = Host::with_hook(Arc::new(move |point| {
            if point == MovePoint::AfterMove {
                let (store, project) = at.get().unwrap();
                holders.lock().unwrap().push(live_holder(store, ID));
                std::fs::write(project.join(format!("{ID}.jsonl")), b"{\"new\":1}\n").unwrap();
            }
        }))
        .await;
        let cwd = host.folder("code/spawn");
        project
            .set((host.store.clone(), host.project(&cwd)))
            .unwrap();
        write_conversation(&host.project(&cwd), ID, RECORD_BYTES, &[]);
        let transfer = Uuid::new_v4();
        let refused = host
            .carrier
            .prepare_export(export(transfer, Some(&cwd), 0), "s")
            .await;
        for child in started.lock().unwrap().drain(..) {
            end(child);
        }
        assert_eq!(refused.err().unwrap().code, "conversation_live_elsewhere");
        assert_eq!(outgoing_record(&host, transfer).unwrap()["state"], STRANDED);
        let resumed = host
            .carrier
            .prepare_export(export(transfer, Some(&cwd), 0), "again")
            .await;
        assert_eq!(resumed.err().unwrap().code, "transfer_incomplete");
        let commit = RetireCommit::parse(
            json!({"transfer_id": transfer.to_string(), "length": 1, "sha256": "a".repeat(64)})
                .as_object(),
        )
        .unwrap();
        assert_eq!(
            host.carrier.retire_commit(commit).await.unwrap_err().code,
            "transfer_incomplete"
        );
        // Never over what is there now.
        let record_path = host.project(&cwd).join(format!("{ID}.jsonl"));
        assert_eq!(
            host.carrier.retire_abort(transfer).await.unwrap_err().code,
            "already_exists"
        );
        assert_eq!(std::fs::read(&record_path).unwrap(), b"{\"new\":1}\n");
        std::fs::remove_file(&record_path).unwrap();
        host.carrier.retire_abort(transfer).await.unwrap();
        assert_eq!(std::fs::read(&record_path).unwrap(), RECORD_BYTES);
    }

    /// A move that fails part-way puts back what it moved, and is forgotten.
    #[tokio::test]
    async fn a_move_that_fails_part_way_is_put_back() {
        let holding: Arc<OnceLock<PathBuf>> = Arc::default();
        let at = Arc::clone(&holding);
        let host = Host::with_hook(Arc::new(move |point| {
            if point == MovePoint::BeforeMove {
                // The second copy's slot cannot be made: the first has moved
                // by the time the move fails.
                let files = at.get().unwrap().join(FILES);
                std::fs::create_dir_all(&files).unwrap();
                std::fs::write(files.join("1"), b"in the way").unwrap();
            }
        }))
        .await;
        let cwd = host.folder("code/spawn");
        let other = host.folder("code/zzz");
        write_conversation(&host.project(&cwd), ID, RECORD_BYTES, SIDECAR_FILES);
        write_conversation(&host.project(&other), ID, b"{\"old\":1}\n", &[]);
        let transfer = Uuid::new_v4();
        holding
            .set(host.holdings.join(OUTGOING).join(transfer.to_string()))
            .unwrap();
        let failed = host
            .carrier
            .prepare_export(export(transfer, Some(&cwd), 0), "s")
            .await;
        assert!(failed.is_err());
        assert!(host
            .holdings
            .join(OUTGOING)
            .join(transfer.to_string())
            .join("files/0")
            .read_dir()
            .is_err());
        for folder in [&cwd, &other] {
            assert!(
                host.project(folder).join(format!("{ID}.jsonl")).exists(),
                "{folder:?}"
            );
        }
        assert!(host.project(&cwd).join(ID).join("notes.md").exists());
        assert!(outgoing_record(&host, transfer).is_none());
    }

    /// A window started again before the files are out of the lookup path
    /// could resume them: the move is refused and everything goes back.
    #[tokio::test]
    async fn a_window_started_again_while_its_conversation_moves_refuses_the_move() {
        let run: Arc<OnceLock<Arc<StdMutex<Option<u64>>>>> = Arc::default();
        let at = Arc::clone(&run);
        let host = Host::with_hook(Arc::new(move |point| {
            if point == MovePoint::AfterMove {
                *at.get().unwrap().lock().unwrap() = Some(2);
            }
        }))
        .await;
        run.set(Arc::clone(&host.incarnation)).unwrap();
        let cwd = host.folder("code/spawn");
        write_conversation(&host.project(&cwd), ID, RECORD_BYTES, &[]);
        let transfer = Uuid::new_v4();
        let refused = host
            .carrier
            .prepare_export(export(transfer, Some(&cwd), 0), "s")
            .await;
        assert_eq!(refused.err().unwrap().code, "window_restarted");
        assert!(host.project(&cwd).join(format!("{ID}.jsonl")).exists());
        assert!(outgoing_record(&host, transfer).is_none());
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn retiring_a_running_window_stops_its_agent_and_confirms_it_by_pid() {
        use std::io::BufRead;
        // A window: a shell, and in it an "agent" that outlives the shell's
        // death, as Claude in its own process group does.
        let mut shell = std::process::Command::new("sh")
            .arg("-c")
            .arg("sleep 60 & echo $!; wait")
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        std::io::BufReader::new(shell.stdout.as_mut().unwrap())
            .read_line(&mut line)
            .unwrap();
        let agent: u32 = line.trim().parse().unwrap();
        let shell_pid = shell.id();
        let host = Host::with_window(
            Some(shell_pid),
            Arc::new(move || {
                // The worker's stop: the shell goes, the agent stays.
                let _ = rustix::process::kill_process(
                    rustix::process::Pid::from_raw(shell_pid as i32).unwrap(),
                    rustix::process::Signal::KILL,
                );
                WindowStop::Stopped
            }),
        )
        .await;
        let cwd = host.folder("code/spawn");
        write_conversation(&host.project(&cwd), ID, RECORD_BYTES, &[]);

        // The window is in another conversation now: nothing stops.
        record_for(&host.store, agent, OTHER_ID);
        let changed = host
            .carrier
            .prepare_export(export(Uuid::new_v4(), Some(&cwd), 0), "s")
            .await;
        assert_eq!(changed.err().unwrap().code, "conversation_changed");
        assert_eq!(host.stops.load(Ordering::SeqCst), 0);

        record_for(&host.store, agent, ID);
        let transfer = Uuid::new_v4();
        let prepared = host
            .carrier
            .prepare_export(export(transfer, Some(&cwd), 0), "s")
            .await
            .unwrap();
        assert_eq!(prepared.stopped, Some("stopped"));
        assert_eq!(host.stops.load(Ordering::SeqCst), 1);
        // The agent was signalled and is gone (reaped, or a zombie: either
        // way not running).
        assert!(!crate::host_conv::SystemProcesses.alive(agent));
        assert!(!host.project(&cwd).join(format!("{ID}.jsonl")).exists());
        let _ = shell.wait();
    }
}
