//! The support log: a second, separate record of what this daemon did, kept
//! for the day someone has to work out what went wrong on this machine.
//!
//! It is not the daemon's stderr. Stderr mixes in worker output and anything
//! `RUST_LOG` lets a third-party crate say — at trace, tungstenite prints
//! every control frame. The support log is produced by its own tracing layer
//! with rules nothing at runtime can loosen:
//!
//! - **A fixed filter.** `spawnd` events at INFO (DEBUG on the diagnostics
//!   build), every other crate at WARN. `RUST_LOG` and `-v` configure only the
//!   stderr layer; this filter reads neither, and [`SupportLayer`] checks it
//!   again on every event in case it is ever composed without it.
//! - **Events only.** Spans are refused by the filter and the layer records no
//!   span fields, so nothing reaches this file through a span.
//! - **Field rules.** A string or `Debug`/`Display` value of a field whose
//!   name, or one `_`/`.`-separated part of it, is in [`WITHHELD_FIELDS`] is
//!   written as `<withheld>` without being formatted. Numbers and booleans
//!   pass. A byte slice is always withheld.
//! - **A sanitiser** ([`sanitize`]) on every other string, the message
//!   included: ANSI sequences and control characters are stripped, bearer
//!   tokens, JWT-shaped strings, long mixed-case base64 runs, secret-looking
//!   `KEY=VALUE` pairs, URL userinfo, query strings and fragments, and a
//!   panic message carried by a task's join error are redacted, each value is
//!   capped at 512 characters and each event at 2 KiB.
//!
//! One JSON object per line, `{t, level, target, at, msg, fields}`, in
//! `support/support.jsonl` under the instance log directory, rotated to
//! `support.jsonl.1` at 4 MiB: at most 8 MiB per instance, for ever. A
//! dedicated writer thread owns the files and is fed by a bounded channel;
//! when the channel is full an event is dropped and counted, never waited
//! for, so no async task and no dispatch loop ever waits on this disk.
//! Every append and every rotation happens under a cross-process lock
//! (`support.lock`), so the two processes of one instance that overlap during
//! a self-update write whole lines and rotate once. Each file is opened by its
//! exact name, through the verified private directory, never following a link.
//!
//! [`read_window`] is the only reader. It opens exactly the two file names and
//! never lists the folder, so nothing else that ever lands beside them — a
//! diagnostics replay dump, a scrollback segment — can be read through it.
//!
//! Anything that could carry terminal content, file content, a command line
//! or a credential must be logged under a withheld field name, or not logged.

use std::fmt::{self, Write as _};
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result};
use cap_std::fs::Dir;
use serde::{Deserialize, Serialize, Serializer};
use tracing::field::{Field, Visit};
use tracing::level_filters::LevelFilter;
use tracing::subscriber::Interest;
use tracing::{Event, Level, Metadata, Subscriber};
use tracing_log::NormalizeEvent;
use tracing_subscriber::filter::Filtered;
use tracing_subscriber::layer::{Context, Filter, Layer};

/// The folder under the instance log directory that holds the support log.
pub(crate) const DIR_NAME: &str = "support";
/// The file being written.
pub(crate) const CURRENT: &str = "support.jsonl";
/// The file before it. Rotation replaces it; there is never a third.
pub(crate) const PREVIOUS: &str = "support.jsonl.1";
/// Held for every append, rotation and read, across processes.
const LOCK: &str = "support.lock";

/// Each file stays at or under this size.
pub(crate) const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// Each field value and the message, in characters, after sanitising.
const MAX_VALUE_CHARS: usize = 512;
/// A `Debug` or `Display` value stops being formatted past this many bytes.
const MAX_RAW_VALUE_BYTES: usize = 4 * MAX_VALUE_CHARS;
/// One event's JSON line, newline excluded.
const MAX_EVENT_BYTES: usize = 2048;
/// Events waiting for the writer. Beyond this they are dropped and counted.
const CHANNEL_CAPACITY: usize = 1024;
/// One append writes at most about this much.
const MAX_BATCH_BYTES: usize = 64 * 1024;
/// How long a panic waits for its record to reach the disk.
const PANIC_FLUSH_WAIT: Duration = Duration::from_millis(250);
const WRITER_THREAD: &str = "spawnd-support-log";

const WITHHELD: &str = "<withheld>";
const REDACTED: &str = "<redacted>";
const DROPPED_TARGET: &str = "spawnd::support_log";
const DROPPED_MESSAGE: &str = "support log events dropped";

/// Field names whose string and `Debug` values are never written. A field
/// matches when its whole name, or one `_`- or `.`-separated part of it
/// (plural `s` ignored), is listed: `offer_sdp`, `refresh_token`,
/// `skills` and `stdin_error` are all withheld.
pub(crate) const WITHHELD_FIELDS: &[&str] = &[
    "sdp",
    "candidate",
    "token",
    "access_token",
    "credential",
    "password",
    "secret",
    "content",
    "body",
    "bytes",
    "data",
    "payload",
    "input",
    "output",
    "text",
    "env",
    "argv",
    "args",
    "command_line",
    "stdin",
    "stdout",
    "stderr",
    "clipboard",
    "skill",
];

/// The most verbose level a `spawnd` event is recorded at.
const SPAWND_LEVEL: Level = if crate::version::DIAGNOSTICS_BUILD {
    Level::DEBUG
} else {
    Level::INFO
};
/// The most verbose level any other crate's event is recorded at.
const OTHER_LEVEL: Level = Level::WARN;

/// The fixed rule: whether an event from `target` at `level` belongs in the
/// support log. Nothing at runtime changes it.
pub(crate) fn admits(target: &str, level: &Level) -> bool {
    let spawnd = target == "spawnd" || target.starts_with("spawnd::");
    let ceiling = if spawnd { SPAWND_LEVEL } else { OTHER_LEVEL };
    // tracing orders levels by verbosity: ERROR < WARN < … < TRACE.
    *level <= ceiling
}

/// The per-layer filter that fixes the support log's levels. It reads no
/// environment and no flag.
pub(crate) struct SupportFilter;

impl<S> Filter<S> for SupportFilter {
    fn enabled(&self, meta: &Metadata<'_>, _cx: &Context<'_, S>) -> bool {
        meta.is_event() && admits(meta.target(), meta.level())
    }

    fn callsite_enabled(&self, meta: &'static Metadata<'static>) -> Interest {
        if !meta.is_event() {
            return Interest::never();
        }
        // tracing-log dispatches every `log` record through one callsite per
        // level, targeted "log"; the record's own target is only known when
        // `enabled` is asked about it.
        if meta.target() == "log" {
            return Interest::sometimes();
        }
        if admits(meta.target(), meta.level()) {
            Interest::always()
        } else {
            Interest::never()
        }
    }

    fn max_level_hint(&self) -> Option<LevelFilter> {
        Some(LevelFilter::from_level(SPAWND_LEVEL))
    }
}

/// A handle on one instance's support log: the writer thread's channel, and
/// the count of events it has had to drop. Cloning shares both.
#[derive(Clone)]
pub(crate) struct SupportLog {
    inner: Arc<Inner>,
}

struct Inner {
    tx: SyncSender<Message>,
    dropped: AtomicU64,
    /// Tests only: wait for room instead of dropping, so a canary test sees
    /// every event the filter let through.
    block_when_full: bool,
    dir: PathBuf,
}

enum Message {
    Line(Vec<u8>),
    Flush(SyncSender<()>),
}

/// `<instance log dir>/support`. Nothing is created.
pub(crate) fn support_dir(config_dir: &Path) -> Result<PathBuf> {
    Ok(crate::service::instance_log_path(config_dir)?.join(DIR_NAME))
}

/// The file `spawnd status` names.
pub(crate) fn current_path(config_dir: &Path) -> Result<PathBuf> {
    Ok(support_dir(config_dir)?.join(CURRENT))
}

/// Remove this instance's support folder, for `reset` and `exorcise`. A link
/// in its place is removed, not followed.
pub(crate) fn remove(config_dir: &Path) -> Result<()> {
    let dir = support_dir(config_dir)?;
    match std::fs::symlink_metadata(&dir) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(&dir),
        Ok(_) => std::fs::remove_file(&dir),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
    .with_context(|| format!("removing {}", dir.display()))
}

impl SupportLog {
    /// Open (creating it owner-only when missing) this instance's support
    /// folder and start its writer thread.
    pub(crate) fn open_for_instance(config_dir: &Path) -> Result<Self> {
        // On Windows the log directory is created and protected the way the
        // daemon's own log is; the support folder below it is owner-only.
        #[cfg(windows)]
        crate::service::instance_log_dir(config_dir)?;
        Self::open(&support_dir(config_dir)?)
    }

    pub(crate) fn open(dir: &Path) -> Result<Self> {
        Self::open_with(dir, CHANNEL_CAPACITY, false)
    }

    fn open_with(dir: &Path, capacity: usize, block_when_full: bool) -> Result<Self> {
        let store = Store::open(dir)?;
        let (tx, rx) = mpsc::sync_channel(capacity);
        let inner = Arc::new(Inner {
            tx,
            dropped: AtomicU64::new(0),
            block_when_full,
            dir: dir.to_path_buf(),
        });
        let writer_inner = Arc::clone(&inner);
        std::thread::Builder::new()
            .name(WRITER_THREAD.into())
            .spawn(move || write_loop(rx, store, &writer_inner.dropped))
            .context("starting the support log writer")?;
        Ok(Self { inner })
    }

    /// The tracing layer, already behind its fixed filter.
    pub(crate) fn layer<S>(&self) -> Filtered<SupportLayer, SupportFilter, S>
    where
        S: Subscriber,
    {
        SupportLayer { log: self.clone() }.with_filter(SupportFilter)
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn dir(&self) -> &Path {
        &self.inner.dir
    }

    /// Events dropped since this process started because the writer was
    /// behind or the disk refused them.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn dropped(&self) -> u64 {
        self.inner.dropped.load(Ordering::Relaxed)
    }

    fn push(&self, line: Vec<u8>) {
        let message = Message::Line(line);
        // Waiting for room is for tests only, and never on the writer
        // thread, which is the only thing that makes room.
        let sent =
            if self.inner.block_when_full && std::thread::current().name() != Some(WRITER_THREAD) {
                self.inner.tx.send(message).is_ok()
            } else {
                match self.inner.tx.try_send(message) {
                    Ok(()) => true,
                    Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => false,
                }
            };
        if !sent {
            self.inner.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Wait up to `wait` for everything queued so far to be written. Never
    /// waits for room in the channel: a full channel answers `false` at once.
    pub(crate) fn flush(&self, wait: Duration) -> bool {
        if std::thread::current().name() == Some(WRITER_THREAD) {
            return false;
        }
        let (ack_tx, ack_rx) = mpsc::sync_channel(1);
        if self.inner.tx.try_send(Message::Flush(ack_tx)).is_err() {
            return false;
        }
        ack_rx.recv_timeout(wait).is_ok()
    }

    /// Record that a thread panicked: where, and the thread's name. Never the
    /// payload, which is whatever the panicking code put in it — an
    /// `unwrap()` on an `Err` carries the error's value.
    fn record_panic(&self, location: Option<&std::panic::Location<'_>>, thread: Option<&str>) {
        let at = location
            .map(|location| format!("{}:{}", location.file(), location.line()))
            .unwrap_or_default();
        let fields = vec![(
            "thread",
            FieldValue::Str(sanitize(thread.unwrap_or("<unnamed>"))),
        )];
        let line = render_line(
            &now_rfc3339_millis(),
            "ERROR",
            "spawnd::panic",
            &sanitize(&at),
            "panic",
            fields,
        );
        self.push(line);
        self.flush(PANIC_FLUSH_WAIT);
    }

    /// Chain a panic hook that records each panic's location and thread
    /// name here, then runs the hook it replaced, so stderr is unchanged.
    pub(crate) fn install_panic_hook(&self) {
        let log = self.clone();
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            log.record_panic(info.location(), std::thread::current().name());
            previous(info);
        }));
    }
}

/// The layer itself. Use [`SupportLog::layer`], which puts it behind its
/// filter; it re-checks the fixed rule on every event regardless.
pub(crate) struct SupportLayer {
    log: SupportLog,
}

impl<S> Layer<S> for SupportLayer
where
    S: Subscriber,
{
    fn on_event(&self, event: &Event<'_>, _cx: Context<'_, S>) {
        // A `log` record arrives on tracing-log's per-level callsite; its own
        // target, file and line are in the normalized metadata.
        let normalized = event.normalized_metadata();
        let meta = normalized.as_ref().unwrap_or_else(|| event.metadata());
        if !admits(meta.target(), meta.level()) {
            return;
        }
        let mut collector = Collector::default();
        event.record(&mut collector);
        let at = match (meta.file(), meta.line()) {
            (Some(file), Some(line)) => format!("{file}:{line}"),
            (Some(file), None) => file.to_string(),
            _ => String::new(),
        };
        let line = render_line(
            &now_rfc3339_millis(),
            meta.level().as_str(),
            &sanitize(meta.target()),
            &sanitize(&at),
            collector.message.as_deref().unwrap_or(""),
            collector.fields,
        );
        self.log.push(line);
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
enum FieldValue {
    Str(String),
    I64(i64),
    U64(u64),
    F64(f64),
    Bool(bool),
}

#[derive(Default)]
struct Collector {
    message: Option<String>,
    fields: Vec<(&'static str, FieldValue)>,
}

impl Collector {
    fn keep(&self, field: &Field) -> bool {
        // tracing-log's bookkeeping fields; the layer reads them through the
        // normalized metadata instead.
        !field.name().starts_with("log.")
    }

    fn push_text(&mut self, field: &Field, format: impl FnOnce() -> String) {
        if !self.keep(field) {
            return;
        }
        let value = if is_withheld(field.name()) {
            WITHHELD.to_string()
        } else {
            sanitize(&format())
        };
        self.fields.push((field.name(), FieldValue::Str(value)));
    }
}

impl Visit for Collector {
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        if field.name() == "message" {
            self.message = Some(sanitize(&bounded_format(value)));
            return;
        }
        self.push_text(field, || bounded_format(value));
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = Some(sanitize(value));
            return;
        }
        self.push_text(field, || value.to_string());
    }

    fn record_bytes(&mut self, field: &Field, _value: &[u8]) {
        if self.keep(field) {
            self.fields
                .push((field.name(), FieldValue::Str(WITHHELD.to_string())));
        }
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        if self.keep(field) {
            self.fields.push((field.name(), FieldValue::I64(value)));
        }
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        if self.keep(field) {
            self.fields.push((field.name(), FieldValue::U64(value)));
        }
    }

    fn record_i128(&mut self, field: &Field, value: i128) {
        if self.keep(field) {
            let value = i64::try_from(value)
                .map(FieldValue::I64)
                .unwrap_or_else(|_| FieldValue::Str(value.to_string()));
            self.fields.push((field.name(), value));
        }
    }

    fn record_u128(&mut self, field: &Field, value: u128) {
        if self.keep(field) {
            let value = u64::try_from(value)
                .map(FieldValue::U64)
                .unwrap_or_else(|_| FieldValue::Str(value.to_string()));
            self.fields.push((field.name(), value));
        }
    }

    fn record_f64(&mut self, field: &Field, value: f64) {
        if self.keep(field) {
            self.fields.push((field.name(), FieldValue::F64(value)));
        }
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        if self.keep(field) {
            self.fields.push((field.name(), FieldValue::Bool(value)));
        }
    }
}

pub(crate) fn is_withheld(name: &str) -> bool {
    let listed = |part: &str| {
        WITHHELD_FIELDS
            .iter()
            .any(|withheld| withheld.eq_ignore_ascii_case(part))
    };
    listed(name)
        || name
            .split(['_', '.'])
            .any(|part| listed(part) || part.strip_suffix(['s', 'S']).is_some_and(listed))
}

/// Format a `Debug` (or `Display`, which tracing passes as `Debug`) value,
/// stopping once it passes [`MAX_RAW_VALUE_BYTES`]: a huge value costs no
/// more than that. A value cut short loses its unfinished last word, which
/// could be the front half of a token too short, cut, to be recognised.
fn bounded_format(value: &dyn fmt::Debug) -> String {
    struct Bounded {
        text: String,
        full: bool,
    }
    impl fmt::Write for Bounded {
        fn write_str(&mut self, piece: &str) -> fmt::Result {
            let room = MAX_RAW_VALUE_BYTES.saturating_sub(self.text.len());
            if piece.len() <= room {
                self.text.push_str(piece);
                return Ok(());
            }
            let mut end = room;
            while !piece.is_char_boundary(end) {
                end -= 1;
            }
            self.text.push_str(&piece[..end]);
            self.full = true;
            Err(fmt::Error)
        }
    }
    let mut bounded = Bounded {
        text: String::new(),
        full: false,
    };
    let _ = write!(bounded, "{value:?}");
    if bounded.full {
        let keep = bounded.text.rfind(|c: char| c.is_whitespace()).unwrap_or(0);
        bounded.text.truncate(keep);
        bounded.text.push_str(" …");
    }
    bounded.text
}

/// Everything a string goes through before it is written: control
/// characters out, secrets redacted, length capped.
pub(crate) fn sanitize(raw: &str) -> String {
    let stripped = strip_controls(raw);
    let redacted = redact(&stripped);
    cap_chars(redacted, MAX_VALUE_CHARS)
}

fn cap_chars(text: String, max: usize) -> String {
    match text.char_indices().nth(max) {
        None => text,
        Some(_) => {
            let end = text
                .char_indices()
                .nth(max - 1)
                .map(|(index, _)| index)
                .unwrap_or(0);
            let mut capped = text[..end].to_string();
            capped.push('…');
            capped
        }
    }
}

fn is_bidi_control(c: char) -> bool {
    matches!(c, '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// Remove ANSI escape sequences (CSI, OSC, DCS/SOS/PM/APC strings, and their
/// C1 forms), every other control character, and bidirectional overrides.
/// Line breaks and tabs become spaces, so an event is always one line.
fn strip_controls(raw: &str) -> String {
    #[derive(PartialEq)]
    enum State {
        Text,
        Escape,
        EscapeIntermediate,
        Csi,
        /// An OSC: ends at BEL or ST.
        Osc,
        /// DCS, SOS, PM, APC: end at ST only.
        Str,
        /// An ESC inside a string, which is ST when `\` follows.
        StrEscape {
            osc: bool,
        },
    }
    let mut out = String::with_capacity(raw.len());
    let mut state = State::Text;
    for c in raw.chars() {
        state = match state {
            State::Text => match c {
                '\u{1b}' => State::Escape,
                '\u{9b}' => State::Csi,
                '\u{9d}' => State::Osc,
                '\u{90}' | '\u{98}' | '\u{9e}' | '\u{9f}' => State::Str,
                '\n' | '\r' | '\t' => {
                    out.push(' ');
                    State::Text
                }
                c if c.is_control() || is_bidi_control(c) => State::Text,
                c => {
                    out.push(c);
                    State::Text
                }
            },
            State::Escape => match c {
                '[' => State::Csi,
                ']' => State::Osc,
                'P' | 'X' | '^' | '_' => State::Str,
                '\u{20}'..='\u{2f}' => State::EscapeIntermediate,
                _ => State::Text,
            },
            State::EscapeIntermediate => match c {
                '\u{20}'..='\u{2f}' => State::EscapeIntermediate,
                _ => State::Text,
            },
            State::Csi => match c {
                '\u{40}'..='\u{7e}' => State::Text,
                _ => State::Csi,
            },
            State::Osc => match c {
                '\u{07}' | '\u{9c}' => State::Text,
                '\u{1b}' => State::StrEscape { osc: true },
                _ => State::Osc,
            },
            State::Str => match c {
                '\u{9c}' => State::Text,
                '\u{1b}' => State::StrEscape { osc: false },
                _ => State::Str,
            },
            State::StrEscape { osc } => match c {
                '\\' => State::Text,
                '\u{1b}' => State::StrEscape { osc },
                _ if osc => State::Osc,
                _ => State::Str,
            },
        };
    }
    out
}

/// Characters a base64 or base64url run is made of.
fn is_base64_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '_' | '-')
}

/// Characters a `KEY` in `KEY=VALUE` is made of.
fn is_key_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')
}

/// Where a value in free text ends.
fn ends_value(c: char) -> bool {
    c.is_whitespace()
        || matches!(
            c,
            '"' | '\'' | '`' | ',' | ';' | '&' | ')' | ']' | '}' | '<' | '>'
        )
}

fn secret_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    const WORDS: &[&str] = &[
        "token",
        "secret",
        "passw",
        "pwd",
        "auth",
        "credential",
        "cookie",
        "apikey",
        "api_key",
        "api-key",
        "private",
        "signature",
    ];
    WORDS.iter().any(|word| lower.contains(word))
        || lower
            .split(['_', '-', '.'])
            .any(|part| matches!(part, "key" | "pass" | "pat" | "sig"))
}

/// Redact secrets that can appear in free text. Patterns are matched on
/// ASCII; anything else passes through untouched.
fn redact(text: &str) -> String {
    let text = redact_after_panic(text);
    let text = redact_urls(&text);
    let text = redact_bearer(&text);
    let text = redact_key_values(&text);
    let text = redact_jwts(&text);
    redact_base64_runs(&text)
}

/// A task's `JoinError` renders as "task 7 panicked with message \"…\"",
/// and that message is the panic payload.
fn redact_after_panic(text: &str) -> String {
    const MARKER: &str = "panicked with message";
    match text.find(MARKER) {
        Some(index) => format!("{} {WITHHELD}", &text[..index + MARKER.len()]),
        None => text.to_string(),
    }
}

fn redact_urls(text: &str) -> String {
    if !text.contains("://") {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find("://") {
        let (head, tail) = rest.split_at(index + 3);
        out.push_str(head);
        let end = tail.find(ends_value).unwrap_or(tail.len());
        let (url, after) = tail.split_at(end);
        let authority_end = url.find(['/', '?', '#']).unwrap_or(url.len());
        let (authority, path) = url.split_at(authority_end);
        match authority.rfind('@') {
            Some(at) => {
                out.push_str(REDACTED);
                out.push_str(&authority[at..]);
            }
            None => out.push_str(authority),
        }
        match path.find(['?', '#']) {
            Some(cut) => {
                out.push_str(&path[..cut]);
                out.push_str(&path[cut..cut + 1]);
                out.push_str(REDACTED);
            }
            None => out.push_str(path),
        }
        rest = after;
    }
    out.push_str(rest);
    out
}

fn redact_bearer(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    if !lower.contains("bearer") {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    while let Some(found) = lower[cursor..].find("bearer") {
        let start = cursor + found;
        let word_end = start + "bearer".len();
        let gap = text[word_end..]
            .find(|c: char| !(c == ' ' || c == ':' || c == '='))
            .map(|offset| word_end + offset)
            .unwrap_or(text.len());
        let token_end = text[gap..]
            .find(ends_value)
            .map(|offset| gap + offset)
            .unwrap_or(text.len());
        out.push_str(&text[cursor..word_end]);
        if gap > word_end && token_end > gap {
            out.push(' ');
            out.push_str(REDACTED);
            cursor = token_end;
        } else {
            cursor = word_end;
        }
    }
    out.push_str(&text[cursor..]);
    out
}

fn redact_key_values(text: &str) -> String {
    if !text.contains('=') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    let bytes = text.as_bytes();
    let mut search = 0;
    while let Some(found) = text[search..].find('=') {
        let eq = search + found;
        let key_start = text[..eq]
            .char_indices()
            .rev()
            .take_while(|(_, c)| is_key_char(*c))
            .last()
            .map(|(index, _)| index)
            .unwrap_or(eq);
        let key = &text[key_start..eq];
        let value_start = eq + 1;
        if key.is_empty() || !secret_key(key) || key_start < cursor {
            search = value_start;
            continue;
        }
        let value_end = match bytes.get(value_start) {
            Some(quote @ (b'"' | b'\'')) => text[value_start + 1..]
                .find(char::from(*quote))
                .map(|offset| value_start + 1 + offset + 1)
                .unwrap_or(text.len()),
            _ => text[value_start..]
                .find(ends_value)
                .map(|offset| value_start + offset)
                .unwrap_or(text.len()),
        };
        if value_end > value_start && &text[value_start..value_end] != REDACTED {
            out.push_str(&text[cursor..value_start]);
            out.push_str(REDACTED);
            cursor = value_end;
        }
        search = value_end.max(value_start);
    }
    out.push_str(&text[cursor..]);
    out
}

fn redact_jwts(text: &str) -> String {
    if !text.contains("eyJ") {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    while let Some(found) = text[cursor..].find("eyJ") {
        let start = cursor + found;
        let end = text[start..]
            .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '=')))
            .map(|offset| start + offset)
            .unwrap_or(text.len());
        let candidate = &text[start..end];
        let parts: Vec<&str> = candidate.split('.').collect();
        let preceded_by_word = text[..start]
            .chars()
            .next_back()
            .is_some_and(|c| c.is_ascii_alphanumeric());
        out.push_str(&text[cursor..start]);
        if !preceded_by_word && parts.len() >= 3 && parts[0].len() >= 8 && parts[1].len() >= 4 {
            out.push_str(REDACTED);
        } else {
            out.push_str(candidate);
        }
        cursor = end.max(start + 3);
    }
    out.push_str(&text[cursor..]);
    out
}

/// A run that looks like encoded random bytes: long, of the base64
/// alphabets, mixing upper case, lower case and digits, and not plain hex —
/// a hash or a fingerprint is hex and passes. A path, which is mostly lower
/// case words between slashes, is left alone.
fn looks_encoded(run: &str) -> bool {
    if run.len() < 40 || run.chars().all(|c| c.is_ascii_hexdigit()) {
        return false;
    }
    let upper = run.chars().any(|c| c.is_ascii_uppercase());
    let lower = run.chars().any(|c| c.is_ascii_lowercase());
    let digit = run.chars().any(|c| c.is_ascii_digit());
    if !(upper && lower && digit) {
        return false;
    }
    let path_like = run.starts_with('/') && run.split('/').all(|segment| segment.len() < 40);
    !path_like
}

fn redact_base64_runs(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut run_start: Option<usize> = None;
    let flush = |out: &mut String, run: &str| {
        if looks_encoded(run) {
            out.push_str(REDACTED);
        } else {
            out.push_str(run);
        }
    };
    for (index, c) in text.char_indices() {
        if is_base64_char(c) {
            run_start.get_or_insert(index);
            continue;
        }
        if let Some(start) = run_start.take() {
            flush(&mut out, &text[start..index]);
        }
        out.push(c);
    }
    if let Some(start) = run_start {
        flush(&mut out, &text[start..]);
    }
    out
}

/// One field set as a JSON object, in recorded order.
struct FieldsOut<'a>(&'a [(&'static str, FieldValue)]);

impl Serialize for FieldsOut<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (name, value) in self.0 {
            map.serialize_entry(name, value)?;
        }
        map.end()
    }
}

#[derive(Serialize)]
struct LineOut<'a> {
    t: &'a str,
    level: &'a str,
    target: &'a str,
    at: &'a str,
    msg: &'a str,
    fields: FieldsOut<'a>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    truncated: bool,
}

/// One JSON line, newline included, never longer than [`MAX_EVENT_BYTES`]
/// before it: fields are dropped from the end, then the message shortened,
/// until it fits.
fn render_line(
    t: &str,
    level: &str,
    target: &str,
    at: &str,
    msg: &str,
    mut fields: Vec<(&'static str, FieldValue)>,
) -> Vec<u8> {
    let mut msg = msg.to_string();
    let mut truncated = false;
    loop {
        let line = LineOut {
            t,
            level,
            target,
            at,
            msg: &msg,
            fields: FieldsOut(&fields),
            truncated,
        };
        let mut bytes = serde_json::to_vec(&line).unwrap_or_default();
        if bytes.len() <= MAX_EVENT_BYTES {
            bytes.push(b'\n');
            return bytes;
        }
        truncated = true;
        if fields.pop().is_some() {
            continue;
        }
        let keep = msg.chars().count() / 2;
        if keep == 0 {
            // Only the fixed parts are left and they do not fit: say so.
            return render_line(t, level, "?", "?", "", Vec::new());
        }
        msg = msg.chars().take(keep).collect();
    }
}

fn now_unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn rfc3339_millis(unix_millis: u64) -> String {
    let seconds = crate::state::unix_seconds_rfc3339(unix_millis / 1000);
    // `YYYY-MM-DDTHH:MM:SSZ` → `YYYY-MM-DDTHH:MM:SS.mmmZ`: fixed width, so
    // two of them compare as their instants do.
    format!(
        "{}.{:03}Z",
        seconds.trim_end_matches('Z'),
        unix_millis % 1000
    )
}

fn now_rfc3339_millis() -> String {
    rfc3339_millis(now_unix_millis())
}

/// Parse what [`rfc3339_millis`] writes, back to Unix milliseconds.
fn parse_rfc3339_millis(value: &str) -> Option<i64> {
    let (seconds, millis) = value.strip_suffix('Z')?.split_once('.')?;
    if millis.len() != 3 || !millis.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let seconds = crate::state::parse_rfc3339_seconds(&format!("{seconds}Z"))?;
    Some(seconds * 1000 + millis.parse::<i64>().ok()?)
}

/// The support folder, held open, and its lock file.
struct Store {
    dir: Dir,
    lock: File,
}

impl Store {
    fn open(path: &Path) -> Result<Self> {
        crate::platform::create_private_dir_all(path)
            .with_context(|| format!("creating {}", path.display()))?;
        let dir = crate::platform::open_private_dir(path)
            .with_context(|| format!("opening {}", path.display()))?;
        let lock = open_or_create(&dir, LOCK)
            .with_context(|| format!("opening {}", path.join(LOCK).display()))?;
        Ok(Self { dir, lock })
    }

    /// Append whole lines, rotating first when they would take the current
    /// file past its cap. The lock covers both, across processes.
    fn append(&self, bytes: &[u8]) -> io::Result<()> {
        self.lock.lock()?;
        let result = self.append_locked(bytes);
        let unlocked = self.lock.unlock();
        result.and(unlocked)
    }

    fn append_locked(&self, bytes: &[u8]) -> io::Result<()> {
        let mut file = open_or_create(&self.dir, CURRENT)?;
        let len = file.metadata()?.len();
        if len > 0 && len + bytes.len() as u64 > MAX_FILE_BYTES {
            drop(file);
            // Replaces the previous file; a link there is replaced, not
            // followed. There is never a third file.
            self.dir.rename(CURRENT, &self.dir, PREVIOUS)?;
            file = open_or_create(&self.dir, CURRENT)?;
        }
        // Every writer appends under the lock, so the end found here is the
        // end this write lands at.
        file.seek(SeekFrom::End(0))?;
        file.write_all(bytes)
    }
}

/// Open `name` in the verified folder for writing, creating it owner-only
/// when it does not exist. Never follows a link: on Unix the open refuses
/// one, on Windows a reparse point fails validation.
fn open_or_create(dir: &Dir, name: &str) -> io::Result<File> {
    let name = Path::new(name);
    match crate::platform::open_private_file_at(dir, name, true) {
        Ok(file) => Ok(file),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            match crate::platform::create_private_file_new_at(dir, name) {
                Ok(file) => Ok(file),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    crate::platform::open_private_file_at(dir, name, true)
                }
                Err(error) => Err(error),
            }
        }
        Err(error) => Err(error),
    }
}

fn line_count(bytes: &[u8]) -> u64 {
    bytes.iter().filter(|&&b| b == b'\n').count() as u64
}

/// The writer thread: drain what is queued, append it in one write, answer
/// flushes, and note drops in the log itself.
fn write_loop(rx: Receiver<Message>, store: Store, dropped: &AtomicU64) {
    let mut batch: Vec<u8> = Vec::with_capacity(MAX_BATCH_BYTES);
    let mut acks: Vec<SyncSender<()>> = Vec::new();
    let mut reported = 0u64;
    let mut failing = false;
    while let Ok(first) = rx.recv() {
        let mut next = Some(first);
        while let Some(message) = next.take() {
            match message {
                Message::Line(line) => batch.extend_from_slice(&line),
                Message::Flush(ack) => acks.push(ack),
            }
            if batch.len() < MAX_BATCH_BYTES {
                next = rx.try_recv().ok();
            }
        }
        let total = dropped.load(Ordering::Relaxed);
        if total > reported {
            batch.extend_from_slice(&render_line(
                &now_rfc3339_millis(),
                "WARN",
                DROPPED_TARGET,
                concat!(file!(), ":", line!()),
                DROPPED_MESSAGE,
                vec![("dropped", FieldValue::U64(total - reported))],
            ));
        }
        if !batch.is_empty() {
            match store.append(&batch) {
                Ok(()) => {
                    reported = total;
                    if failing {
                        failing = false;
                        tracing::info!("the support log is being written again");
                    }
                }
                Err(error) => {
                    // The lines are gone; count them so the next marker says so.
                    let lost = line_count(&batch).saturating_sub(u64::from(total > reported));
                    dropped.fetch_add(lost, Ordering::Relaxed);
                    if !failing {
                        failing = true;
                        tracing::warn!(%error, "the support log could not be written; dropping its events");
                    }
                }
            }
            batch.clear();
        }
        for ack in acks.drain(..) {
            let _ = ack.send(());
        }
    }
}

/// What a collection of the support log says about itself, ahead of its
/// lines.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct BundleHeader {
    pub kind: &'static str,
    pub format: u32,
    pub version: String,
    pub variant: &'static str,
    pub os: &'static str,
    pub arch: &'static str,
    pub instance: String,
    pub window_from: String,
    pub window_to: String,
    pub lines: usize,
    pub bytes: usize,
    pub dropped_events: u64,
    /// Lines inside the window were left out to stay under the byte cap.
    pub truncated: bool,
}

/// The header and the selected lines, oldest first.
#[derive(Debug, Clone)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct Bundle {
    pub header: BundleHeader,
    pub lines: Vec<String>,
}

#[derive(Deserialize)]
struct LineHead {
    t: String,
    #[serde(default)]
    target: String,
    #[serde(default)]
    msg: String,
    #[serde(default)]
    fields: Option<DroppedFields>,
}

#[derive(Deserialize)]
struct DroppedFields {
    #[serde(default)]
    dropped: Option<u64>,
}

/// Read one of the two files by its exact name, at most its cap from its
/// end. `None` when it does not exist.
#[cfg_attr(not(test), allow(dead_code))]
fn read_capped(dir: &Dir, name: &str) -> io::Result<Option<File>> {
    match crate::platform::open_private_file_at(dir, Path::new(name), false) {
        Ok(file) => Ok(Some(file)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg_attr(not(test), allow(dead_code))]
fn read_tail(file: Option<File>) -> io::Result<Vec<u8>> {
    let Some(mut file) = file else {
        return Ok(Vec::new());
    };
    let len = file.metadata()?.len();
    if len > MAX_FILE_BYTES {
        file.seek(SeekFrom::Start(len - MAX_FILE_BYTES))?;
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES).read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// The support log's lines whose time falls in `[from_ms, to_ms]` (Unix
/// milliseconds), chosen newest first until `max_bytes` (each line and its
/// newline counted), returned oldest first behind a header.
///
/// Opens exactly [`CURRENT`] and [`PREVIOUS`] in `support_dir`, through the
/// verified private folder and without following a link, and never lists the
/// folder. The two are opened together under the rotation lock, so a rotation
/// cannot move a line from one to the other mid-read.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn read_window(
    support_dir: &Path,
    instance: &str,
    from_ms: i64,
    to_ms: i64,
    max_bytes: usize,
) -> Result<Bundle> {
    let (current, previous) = match crate::platform::open_private_dir(support_dir) {
        Ok(dir) => {
            let lock = open_or_create(&dir, LOCK)?;
            lock.lock()?;
            let opened = read_capped(&dir, CURRENT)
                .and_then(|current| Ok((current, read_capped(&dir, PREVIOUS)?)));
            let _ = lock.unlock();
            let (current, previous) = opened?;
            (read_tail(current)?, read_tail(previous)?)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => (Vec::new(), Vec::new()),
        Err(error) => {
            return Err(error).with_context(|| format!("opening {}", support_dir.display()))
        }
    };
    let mut selected: Vec<String> = Vec::new();
    let mut bytes = 0usize;
    let mut dropped_events = 0u64;
    let mut truncated = false;
    let newest_first = current
        .split(|&b| b == b'\n')
        .rev()
        .chain(previous.split(|&b| b == b'\n').rev());
    for raw in newest_first {
        let Ok(text) = std::str::from_utf8(raw) else {
            continue;
        };
        let Ok(head) = serde_json::from_str::<LineHead>(text) else {
            continue;
        };
        let Some(at) = parse_rfc3339_millis(&head.t) else {
            continue;
        };
        if at < from_ms || at > to_ms {
            continue;
        }
        if head.target == DROPPED_TARGET && head.msg == DROPPED_MESSAGE {
            dropped_events += head.fields.and_then(|f| f.dropped).unwrap_or(0);
        }
        if truncated {
            continue;
        }
        if bytes + text.len() + 1 > max_bytes {
            truncated = true;
            continue;
        }
        bytes += text.len() + 1;
        selected.push(text.to_string());
    }
    selected.reverse();
    let header = BundleHeader {
        kind: "spawnd-support-log",
        format: 1,
        version: crate::version::build_version(),
        variant: if crate::version::DIAGNOSTICS_BUILD {
            "diagnostics"
        } else {
            "release"
        },
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        instance: instance.to_string(),
        window_from: rfc3339_millis(from_ms.max(0) as u64),
        window_to: rfc3339_millis(to_ms.max(0) as u64),
        lines: selected.len(),
        bytes,
        dropped_events,
        truncated,
    };
    Ok(Bundle {
        header,
        lines: selected,
    })
}

/// Tests only: one support log for the whole test process, installed as the
/// global tracing subscriber (with the `log` bridge and the panic hook), so a
/// canary test sees what every thread and task says. It never drops: a full
/// channel waits. Every test that uses it asserts only about its own canary.
#[cfg(test)]
pub(crate) mod capture {
    use super::*;
    use std::sync::OnceLock;
    use tracing_subscriber::layer::SubscriberExt;

    pub(crate) struct Capture {
        pub log: SupportLog,
        /// The stand-in for an instance log directory; the support folder is
        /// `support/` inside it. The diagnostics canary dumps replays here.
        #[cfg_attr(not(all(unix, feature = "diagnostics")), allow(dead_code))]
        pub instance_logs: PathBuf,
        _root: tempfile::TempDir,
    }

    static CAPTURE: OnceLock<Capture> = OnceLock::new();

    pub(crate) fn global() -> &'static Capture {
        CAPTURE.get_or_init(|| {
            let root = tempfile::tempdir().expect("support log capture dir");
            let instance_logs = root.path().join("logs").join("0badcafe");
            let log = SupportLog::open_with(&instance_logs.join(DIR_NAME), 1 << 16, true)
                .expect("open the captured support log");
            let subscriber = tracing_subscriber::registry().with(log.layer());
            let installed = tracing::subscriber::set_global_default(subscriber).is_ok();
            assert!(
                installed,
                "another test installed a global subscriber first"
            );
            let _ = tracing_log::LogTracer::init();
            log.install_panic_hook();
            Capture {
                log,
                instance_logs,
                _root: root,
            }
        })
    }

    impl Capture {
        /// Everything written so far, both files, after a flush.
        pub(crate) fn contents(&self) -> String {
            assert!(self.log.flush(Duration::from_secs(30)), "flush timed out");
            let dir = self.log.dir();
            let mut text = String::new();
            for name in [PREVIOUS, CURRENT] {
                if let Ok(bytes) = std::fs::read(dir.join(name)) {
                    text.push_str(&String::from_utf8_lossy(&bytes));
                }
            }
            text
        }

        pub(crate) fn bundle(&self) -> String {
            assert!(self.log.flush(Duration::from_secs(30)), "flush timed out");
            let bundle =
                read_window(self.log.dir(), "0badcafe", 0, i64::MAX / 2, 64 << 20).unwrap();
            let mut text = serde_json::to_string(&bundle.header).unwrap();
            for line in bundle.lines {
                text.push('\n');
                text.push_str(&line);
            }
            text
        }
    }

    /// The forms a canary could take in a log: as typed, hex in either case,
    /// and base64 (standard and URL-safe) at each of the three alignments it
    /// could have inside a longer encoded run.
    pub(crate) fn canary_forms(canary: &str) -> Vec<String> {
        use base64::Engine as _;
        let mut forms = vec![canary.to_string()];
        let hex: String = canary.bytes().map(|b| format!("{b:02x}")).collect();
        forms.push(hex.to_uppercase());
        forms.push(hex);
        for offset in 0..3 {
            let mut bytes = vec![0u8; offset];
            bytes.extend_from_slice(canary.as_bytes());
            bytes.extend_from_slice(&[0u8; 3]);
            for engine in [
                &base64::engine::general_purpose::STANDARD,
                &base64::engine::general_purpose::URL_SAFE,
            ] {
                let encoded = engine.encode(&bytes);
                // Characters touched by the padding bytes on either side
                // depend on the neighbours; the middle does not.
                let inner = &encoded[4..encoded.len() - 8];
                forms.push(inner.to_string());
            }
        }
        forms
    }

    pub(crate) fn assert_absent(haystack: &str, canary: &str, what: &str) {
        for form in canary_forms(canary) {
            assert!(
                !haystack.contains(&form),
                "{what} holds the canary as {form:?}"
            );
        }
    }
}

#[cfg(test)]
#[path = "support_log_tests.rs"]
mod tests;
