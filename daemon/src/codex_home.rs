//! A skilled window's own `CODEX_HOME`: `<window home>/codex-home`.
//!
//! Codex finds its skills through `config.toml` in `CODEX_HOME`, so a window
//! whose skills spawnd writes gets a Codex home of its own. Everything else in
//! it is the user's:
//!
//! - their `config.toml`, merged rather than replaced (format-preserving, so
//!   their comments and settings — `cli_auth_credentials_store` among them —
//!   survive), with this window's skills and its folder's trust added. Codex
//!   reads a relative path there against the folder the file is in, so each
//!   key it reads that way (`RELATIVE_PATH_KEYS`) is rewritten as the path it
//!   named in the user's home: left as written, it would name a file in this
//!   window's home that is not there, and Codex refuses to start without its
//!   `model_instructions_file`;
//! - their conversation stores, `sessions/`, `archived_sessions/`,
//!   `history.jsonl` and `session_index.jsonl`, linked, so a rollout written
//!   here lands in the store every other Codex reads: `codex resume` finds it
//!   from any window and `agent.transcripts` finds it where it looks;
//! - their sign-in and Codex's small caches, mirrored: a link to the user's
//!   file where they have one, nothing where they have none, and never a file
//!   of the window's own. Codex refresh tokens are single-use, so a second
//!   sign-in — a copy, or one made in the window — would fork the chain and
//!   sign one side out; and a window must sign out when the user does. On
//!   Windows, where a file symlink needs a privilege, a file is hard-linked
//!   instead. A `keyring` (or in-memory `ephemeral`) credential store is keyed
//!   by the `CODEX_HOME` path itself and never reads `auth.json`, so the
//!   window keeps none; an `auto` store reads `auth.json` whenever its keyring
//!   holds nothing for this home, so it is mirrored like `file`.
//!
//! The home is reconciled each time the window starts or restarts, never
//! wiped — the wipe this replaced deleted every skilled window's Codex
//! conversations on Restart. Each apply re-points every link (a different
//! `CODEX_HOME` is a different source) and verifies it. A conversation store
//! that is real rather than linked is left alone where it could be the
//! window's own record from before these links existed; one whose data has
//! another name (a hard link: on Windows, an earlier source's projection) is
//! re-pointed, which loses nothing.

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use toml_edit::{value, ArrayOfTables, DocumentMut, Formatted, Item, Table, TableLike, Value};

/// The user's `config.toml` is read up to this much; Codex's own is a few
/// KiB, and anything past this is not one to merge.
const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Dir,
    File,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Owner {
    /// The user's conversations. A link is re-pointed; a real entry may be
    /// the window's own record from before the link and is kept, unless its
    /// data has another name (a hard link), which is re-pointed.
    Store,
    /// The user's sign-in and caches, mirrored: a link to the user's file
    /// where there is one, and nothing where there is none. Whatever else is
    /// at the name is replaced or removed.
    Mirror,
}

struct Projection {
    name: &'static str,
    kind: Kind,
    owner: Owner,
}

const PROJECTIONS: &[Projection] = &[
    Projection {
        name: "sessions",
        kind: Kind::Dir,
        owner: Owner::Store,
    },
    Projection {
        name: "archived_sessions",
        kind: Kind::Dir,
        owner: Owner::Store,
    },
    Projection {
        name: "history.jsonl",
        kind: Kind::File,
        owner: Owner::Store,
    },
    Projection {
        name: "session_index.jsonl",
        kind: Kind::File,
        owner: Owner::Store,
    },
    Projection {
        name: AUTH_FILE,
        kind: Kind::File,
        owner: Owner::Mirror,
    },
    Projection {
        name: "internal_storage.json",
        kind: Kind::File,
        owner: Owner::Mirror,
    },
    Projection {
        name: "models_cache.json",
        kind: Kind::File,
        owner: Owner::Mirror,
    },
    Projection {
        name: "version.json",
        kind: Kind::File,
        owner: Owner::Mirror,
    },
];

const AUTH_FILE: &str = "auth.json";

/// Every key Codex reads as a path relative to the folder of the
/// `config.toml` that sets it — the `AbsolutePathBuf` fields of its
/// `ConfigToml` as of Codex 0.155 — by where it sits: `*` is any key of a
/// table (a profile, an agent role, a provider, an exporter), `[]` each entry
/// of an array. A `~` path is Codex's to expand and an absolute one already
/// names its file; only a relative one is rewritten.
const RELATIVE_PATH_KEYS: &[&[&str]] = &[
    &["model_instructions_file"],
    &["experimental_compact_prompt_file"],
    &["model_catalog_json"],
    &["sqlite_home"],
    &["log_dir"],
    &["js_repl_node_path"],
    &["js_repl_node_module_dirs", "[]"],
    &["profiles", "*", "model_instructions_file"],
    &["profiles", "*", "experimental_compact_prompt_file"],
    &["profiles", "*", "model_catalog_json"],
    &["profiles", "*", "js_repl_node_path"],
    &["profiles", "*", "js_repl_node_module_dirs", "[]"],
    &["agents", "*", "config_file"],
    &["skills", "config", "[]", "path"],
    &["sandbox_workspace_write", "writable_roots", "[]"],
    &["model_providers", "*", "auth", "cwd"],
    &["otel", "*", "*", "tls", "ca-certificate"],
    &["otel", "*", "*", "tls", "client-certificate"],
    &["otel", "*", "*", "tls", "client-private-key"],
];

/// How a file is linked: a symlink where that is free, a hard link on
/// Windows, where a file symlink needs Developer Mode or a privilege and a
/// hard link needs neither. A directory is always symlinked.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum FileLink {
    Symbolic,
    Hard,
}

impl FileLink {
    fn native() -> Self {
        if cfg!(windows) {
            Self::Hard
        } else {
            Self::Symbolic
        }
    }
}

/// What reconciling one entry came to, for the log and for tests.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// Linked to the source, newly or re-pointed, and verified.
    Linked,
    /// Already linked to the source.
    Current,
    /// A real entry that may be the window's own record; left as it was.
    KeptOwn,
    /// Nothing to project: the source has none, or the credential store is
    /// not a file. Whatever the window had there is gone.
    Skipped,
    /// This platform could not link it; Codex makes its own here.
    Unlinked,
}

/// What to give one window's Codex.
pub(crate) struct Plan<'a> {
    /// The window's own Codex home, created if missing.
    pub codex_home: &'a Path,
    /// The user's Codex home, absolute, when there is one to draw from.
    pub source: Option<&'a Path>,
    /// Each skill's `SKILL.md`.
    pub skills: &'a [PathBuf],
    /// The folder the window opens in, trusted unless the user said
    /// otherwise.
    pub trusted_project: Option<&'a Path>,
}

/// Bring `plan.codex_home` in line with the user's Codex home and this
/// window's skills. Only a failure to write the configuration is an error; a
/// link this platform cannot make is logged and left to Codex.
pub(crate) fn reconcile(plan: &Plan<'_>) -> Result<Vec<(&'static str, Outcome)>> {
    reconcile_with(plan, FileLink::native())
}

fn reconcile_with(plan: &Plan<'_>, files: FileLink) -> Result<Vec<(&'static str, Outcome)>> {
    crate::platform::create_private_dir_all(plan.codex_home)
        .with_context(|| format!("creating {}", plan.codex_home.display()))?;
    let source = plan.source.filter(|source| source.is_dir());
    let user_config = source.and_then(|source| read_user_config(&source.join("config.toml")));
    let config = merged_config(
        user_config.as_deref(),
        source,
        plan.skills,
        plan.trusted_project,
    );
    let file_sign_in = signs_in_from_file(&config);
    let path = plan.codex_home.join("config.toml");
    replace_private_file(
        &path,
        rendered_config(&config, source.map(|source| source.join("config.toml"))).as_bytes(),
    )
    .with_context(|| format!("writing {}", path.display()))?;
    if !file_sign_in {
        tracing::info!(
            codex_home = %plan.codex_home.display(),
            "Codex keeps its sign-in outside auth.json (a keyring or ephemeral store, keyed by CODEX_HOME); this window keeps no auth.json"
        );
    }

    let mut outcomes = Vec::with_capacity(PROJECTIONS.len());
    for projection in PROJECTIONS {
        let dest = plan.codex_home.join(projection.name);
        let outcome = match (projection.owner, source) {
            (Owner::Store, Some(source)) => {
                store(projection.kind, &source.join(projection.name), &dest, files)
            }
            (Owner::Store, None) => unlink_store(&dest).map(|()| Outcome::Skipped),
            (Owner::Mirror, source) => {
                let wanted = source
                    .filter(|_| projection.name != AUTH_FILE || file_sign_in)
                    .map(|source| source.join(projection.name))
                    .filter(|source| source.is_file());
                mirror(wanted.as_deref(), &dest, files)
            }
        };
        match outcome {
            Ok(outcome) => {
                if outcome == Outcome::KeptOwn {
                    tracing::info!(
                        path = %dest.display(),
                        "kept this window's own Codex state rather than linking the user's"
                    );
                }
                outcomes.push((projection.name, outcome));
            }
            Err(error) => {
                tracing::warn!(
                    path = %dest.display(),
                    %error,
                    "could not link the user's Codex state into this window"
                );
                outcomes.push((projection.name, Outcome::Unlinked));
            }
        }
    }
    Ok(outcomes)
}

/// Whether Codex reads its sign-in from `auth.json`: the default `file`
/// store, and `auto`, which falls back to that file whenever its keyring
/// holds nothing for this home — always, for a home of its own, since the
/// keyring entry is keyed by the `CODEX_HOME` path.
fn signs_in_from_file(config: &DocumentMut) -> bool {
    !matches!(
        config
            .get("cli_auth_credentials_store")
            .and_then(Item::as_str),
        Some("keyring" | "ephemeral")
    )
}

fn read_user_config(path: &Path) -> Option<String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return None,
        Err(error) => {
            tracing::warn!(path = %path.display(), %error, "could not read the user's Codex config");
            return None;
        }
    };
    let mut text = String::new();
    if let Err(error) = file.take(MAX_CONFIG_BYTES + 1).read_to_string(&mut text) {
        tracing::warn!(path = %path.display(), %error, "could not read the user's Codex config");
        return None;
    }
    if text.len() as u64 > MAX_CONFIG_BYTES {
        tracing::warn!(path = %path.display(), "the user's Codex config is too large to merge");
        return None;
    }
    Some(text)
}

/// The user's configuration, its relative paths made the ones they named
/// in `base` (the user's home, where the file lives), with this window's
/// skills and trust merged in. Their own entries win: a skill path already
/// listed is not listed twice, and a folder they gave a trust level keeps it.
fn merged_config(
    user: Option<&str>,
    base: Option<&Path>,
    skills: &[PathBuf],
    trusted: Option<&Path>,
) -> DocumentMut {
    let mut config = match user.map(str::parse::<DocumentMut>) {
        Some(Ok(mut config)) => {
            if let Some(base) = base {
                rebase_relative_paths(&mut config, base);
            }
            config
        }
        Some(Err(error)) => {
            // Codex refuses a file it cannot parse; this window starts from
            // spawnd's part alone rather than not at all.
            tracing::warn!(%error, "the user's Codex config does not parse; not merging it");
            DocumentMut::new()
        }
        None => DocumentMut::new(),
    };
    if !skills.is_empty() {
        let entries = table_entry(&mut config, "skills")
            .entry("config")
            .or_insert(Item::None);
        let existing = std::mem::take(entries);
        *entries = Item::ArrayOfTables(
            existing
                .into_array_of_tables()
                .unwrap_or_else(|_| ArrayOfTables::new()),
        );
        if let Some(entries) = entries.as_array_of_tables_mut() {
            for skill in skills {
                let path = skill.to_string_lossy();
                let listed = entries
                    .iter()
                    .any(|entry| entry.get("path").and_then(Item::as_str) == Some(&*path));
                if !listed {
                    let mut entry = Table::new();
                    entry.insert("path", value(path.as_ref()));
                    entry.insert("enabled", value(true));
                    entries.push(entry);
                }
            }
        }
    }
    if let Some(project) = trusted {
        let project = project.to_string_lossy();
        let projects = table_entry(&mut config, "projects");
        if !projects.contains_key(&project) {
            let mut trust = Table::new();
            trust.insert("trust_level", value("trusted"));
            projects.insert(&project, Item::Table(trust));
        }
    }
    config
}

/// Make every relative path Codex would read against the user's home
/// (`RELATIVE_PATH_KEYS`) name the same file from this window's. A provider's
/// token command with no `auth.cwd` runs in the folder of the config that set
/// it, so that folder is written down too.
fn rebase_relative_paths(config: &mut DocumentMut, base: &Path) {
    for pattern in RELATIVE_PATH_KEYS {
        rebase_table(config.as_table_mut(), pattern, base);
    }
    let Some(providers) = config
        .get_mut("model_providers")
        .and_then(Item::as_table_like_mut)
    else {
        return;
    };
    for (_, provider) in providers.iter_mut() {
        let Some(auth) = provider
            .as_table_like_mut()
            .and_then(|provider| provider.get_mut("auth"))
            .and_then(Item::as_table_like_mut)
        else {
            continue;
        };
        if !auth.contains_key("cwd") {
            auth.insert("cwd", value(base.to_string_lossy().as_ref()));
        }
    }
}

fn rebase_table(table: &mut dyn TableLike, pattern: &[&str], base: &Path) {
    let Some((step, rest)) = pattern.split_first() else {
        return;
    };
    if *step == "*" {
        for (_, item) in table.iter_mut() {
            rebase_item(item, rest, base);
        }
    } else if let Some(item) = table.get_mut(step) {
        rebase_item(item, rest, base);
    }
}

fn rebase_item(item: &mut Item, pattern: &[&str], base: &Path) {
    match item {
        Item::Value(value) => rebase_value(value, pattern, base),
        Item::Table(table) => rebase_table(table, pattern, base),
        Item::ArrayOfTables(tables) => {
            if let Some((&"[]", rest)) = pattern.split_first() {
                for table in tables.iter_mut() {
                    rebase_table(table, rest, base);
                }
            }
        }
        Item::None => {}
    }
}

fn rebase_value(value: &mut Value, pattern: &[&str], base: &Path) {
    match (pattern.split_first(), value) {
        (None, Value::String(path)) => {
            if let Some(rebased) = rebased_path(path.value(), base) {
                let decor = path.decor().clone();
                *path = Formatted::new(rebased);
                *path.decor_mut() = decor;
            }
        }
        (Some((&"[]", rest)), Value::Array(values)) => {
            for value in values.iter_mut() {
                rebase_value(value, rest, base);
            }
        }
        (Some(_), Value::InlineTable(table)) => rebase_table(table, pattern, base),
        _ => {}
    }
}

/// `path` as Codex reads it against `base`, where that changes it: not for
/// `~` or `~/…`, which Codex expands against the home directory, nor for an
/// absolute path.
fn rebased_path(path: &str, base: &Path) -> Option<String> {
    let from_home =
        path == "~" || path.starts_with("~/") || (cfg!(windows) && path.starts_with("~\\"));
    if from_home || Path::new(path).is_absolute() {
        return None;
    }
    Some(base.join(path).to_string_lossy().into_owned())
}

/// `config[key]` as a table, made one if it is absent (implicit, so it
/// prints no header of its own) or converted from an inline table.
fn table_entry<'a>(config: &'a mut DocumentMut, key: &str) -> &'a mut Table {
    let item = config.entry(key).or_insert(Item::None);
    let existing = std::mem::take(item);
    let was_table = existing.is_table();
    let mut spread = false;
    *item = Item::Table(match existing.into_table() {
        Ok(table) if was_table => table,
        // An inline table, spread out — and what it nests spread out with it
        // — under a header only if a value of its own needs one.
        Ok(mut table) => {
            for (_, child) in table.iter_mut() {
                let nested = std::mem::take(child);
                *child = match nested.into_array_of_tables() {
                    Ok(array) => Item::ArrayOfTables(array),
                    Err(nested) => nested,
                };
            }
            let headed = table.iter().any(|(_, item)| item.is_value());
            table.set_implicit(!headed);
            spread = true;
            table
        }
        Err(_) => {
            let mut table = Table::new();
            table.set_implicit(true);
            table
        }
    });
    if spread {
        // `skills = {` left its spacing on the key, which a header would keep.
        if let Some(mut key) = config.key_mut(key) {
            key.leaf_decor_mut().clear();
        }
    }
    match config.get_mut(key) {
        Some(Item::Table(table)) => table,
        _ => unreachable!("the item was just made a table"),
    }
}

fn rendered_config(config: &DocumentMut, source: Option<PathBuf>) -> String {
    let origin = match &source {
        Some(path) => format!("yours from {}", path.display()),
        None => "Codex's defaults".to_string(),
    };
    format!(
        "# This SPAWN D window's Codex settings: {origin}, plus the skills it was\n\
         # given. spawnd writes this file each time the window starts; change\n\
         # your own instead.\n{config}"
    )
}

/// One conversation store of the window's home, linked to `source`.
fn store(kind: Kind, source: &Path, dest: &Path, files: FileLink) -> io::Result<Outcome> {
    prepare_store(kind, source, files)?;
    match fs::symlink_metadata(dest) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            link(kind, files, source, dest)?;
            Ok(Outcome::Linked)
        }
        Err(error) => Err(error),
        Ok(metadata) if metadata.file_type().is_symlink() => {
            if fs::read_link(dest).is_ok_and(|target| target == source) {
                return Ok(Outcome::Current);
            }
            remove_link(dest, &metadata)?;
            link(kind, files, source, dest)?;
            Ok(Outcome::Linked)
        }
        Ok(metadata) if kind == Kind::File && metadata.is_file() => {
            if same_file(source, dest) {
                return Ok(Outcome::Current);
            }
            if !hard_linked(dest) {
                return Ok(Outcome::KeptOwn);
            }
            fs::remove_file(dest)?;
            link(kind, files, source, dest)?;
            Ok(Outcome::Linked)
        }
        Ok(_) => Ok(Outcome::KeptOwn),
    }
}

/// A store a link can point at. A directory Codex would create itself is
/// created; a file is left for Codex's own append to create through a
/// symlink, but a hard link needs a file to name.
fn prepare_store(kind: Kind, source: &Path, files: FileLink) -> io::Result<()> {
    match (kind, files) {
        (Kind::Dir, _) => fs::create_dir_all(source),
        (Kind::File, FileLink::Hard) => fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(source)
            .map(drop),
        (Kind::File, FileLink::Symbolic) => Ok(()),
    }
}

/// A conversation store with no source to point at: a link of ours goes,
/// and nothing whose removal would lose data.
fn unlink_store(dest: &Path) -> io::Result<()> {
    match fs::symlink_metadata(dest) {
        Ok(metadata) if metadata.file_type().is_symlink() => remove_link(dest, &metadata),
        Ok(metadata) if metadata.is_file() && hard_linked(dest) => fs::remove_file(dest),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// Make `dest` the user's file `source`, or nothing where the user has none.
/// A file of the window's own — a copy an older spawnd left, a sign-in made
/// in the window, a link the user's logout split off — is never kept.
fn mirror(source: Option<&Path>, dest: &Path, files: FileLink) -> io::Result<Outcome> {
    let existing = match fs::symlink_metadata(dest) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    let Some(source) = source else {
        match existing {
            Some(metadata) if metadata.file_type().is_symlink() => {
                remove_link(dest, &metadata)?;
            }
            Some(metadata) if metadata.is_file() => {
                fs::remove_file(dest)?;
                tracing::info!(
                    path = %dest.display(),
                    "removed this window's own copy of a Codex file the user does not have"
                );
            }
            Some(_) => return Ok(Outcome::KeptOwn),
            None => {}
        }
        return Ok(Outcome::Skipped);
    };
    match existing {
        None => {}
        Some(metadata) if metadata.file_type().is_symlink() => {
            if files == FileLink::Symbolic
                && fs::read_link(dest).is_ok_and(|target| target == source)
            {
                return Ok(Outcome::Current);
            }
            remove_link(dest, &metadata)?;
        }
        Some(metadata) if metadata.is_file() => {
            if files == FileLink::Hard && same_file(source, dest) {
                return Ok(Outcome::Current);
            }
            fs::remove_file(dest)?;
        }
        Some(_) => return Ok(Outcome::KeptOwn),
    }
    link(Kind::File, files, source, dest)?;
    Ok(Outcome::Linked)
}

/// Make the link and prove it names `source`; one that does not is taken
/// away again rather than left pointing somewhere else.
fn link(kind: Kind, files: FileLink, source: &Path, dest: &Path) -> io::Result<()> {
    let hard = kind == Kind::File && files == FileLink::Hard;
    if hard {
        fs::hard_link(source, dest)?;
    } else {
        symlink(kind, source, dest)?;
    }
    let verified = if hard {
        same_file(source, dest)
    } else {
        fs::read_link(dest).is_ok_and(|target| target == source)
    };
    if verified {
        return Ok(());
    }
    if let Ok(metadata) = fs::symlink_metadata(dest) {
        if metadata.file_type().is_symlink() {
            let _ = remove_link(dest, &metadata);
        } else {
            let _ = fs::remove_file(dest);
        }
    }
    Err(io::Error::other("the link does not name its source"))
}

#[cfg(unix)]
fn symlink(_kind: Kind, source: &Path, dest: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(source, dest)
}

/// A directory symlink needs Developer Mode or the privilege; without it the
/// store stays unlinked and Codex keeps this window's rollouts in its home,
/// which is no longer wiped. Files are hard-linked here (`FileLink::native`).
#[cfg(windows)]
fn symlink(kind: Kind, source: &Path, dest: &Path) -> io::Result<()> {
    match kind {
        Kind::Dir => std::os::windows::fs::symlink_dir(source, dest),
        Kind::File => std::os::windows::fs::symlink_file(source, dest),
    }
}

#[cfg(not(any(unix, windows)))]
fn symlink(_kind: Kind, _source: &Path, _dest: &Path) -> io::Result<()> {
    Err(io::Error::from(io::ErrorKind::Unsupported))
}

fn remove_link(dest: &Path, metadata: &fs::Metadata) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt;
        if metadata.file_type().is_symlink_dir() {
            return fs::remove_dir(dest);
        }
    }
    let _ = metadata;
    fs::remove_file(dest)
}

fn same_file(left: &Path, right: &Path) -> bool {
    let identity =
        |path: &Path| fs::File::open(path).and_then(|file| crate::platform::file_identity(&file));
    matches!((identity(left), identity(right)), (Ok(left), Ok(right)) if left == right)
}

/// Whether the file has another name, so removing this one loses nothing.
fn hard_linked(path: &Path) -> bool {
    fs::File::open(path)
        .and_then(|file| crate::platform::hard_link_count(&file))
        .is_ok_and(|links| links > 1)
}

/// Write `path` whole and private, replacing whatever is there by rename, so
/// a reader sees the old file or the new one and a link at `path` is
/// replaced rather than written through.
pub(crate) fn replace_private_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?
        .to_string_lossy();
    let temporary = path.with_file_name(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    let written = (|| {
        let mut file = crate::platform::create_private_file_new(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        crate::platform::durable_replace(&temporary, path)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        _temp: tempfile::TempDir,
        source: PathBuf,
        codex_home: PathBuf,
        skill: PathBuf,
    }

    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("user-codex");
        fs::create_dir_all(&source).unwrap();
        let codex_home = temp.path().join("window").join("codex-home");
        let skill = temp.path().join("window/skills/notes/SKILL.md");
        Fixture {
            source,
            codex_home,
            skill,
            _temp: temp,
        }
    }

    fn apply(fixture: &Fixture, source: &Path) -> Vec<(&'static str, Outcome)> {
        apply_with(fixture, source, FileLink::native())
    }

    /// `FileLink::Hard` is how Windows links a file; hard links work the same
    /// on every platform the tests run on, so that path is tested everywhere.
    fn apply_with(
        fixture: &Fixture,
        source: &Path,
        files: FileLink,
    ) -> Vec<(&'static str, Outcome)> {
        reconcile_with(
            &Plan {
                codex_home: &fixture.codex_home,
                source: Some(source),
                skills: std::slice::from_ref(&fixture.skill),
                trusted_project: Some(Path::new("/work/repo")),
            },
            files,
        )
        .unwrap()
    }

    /// Both ways a file can be linked on this platform.
    fn file_links() -> Vec<FileLink> {
        if cfg!(unix) {
            vec![FileLink::Symbolic, FileLink::Hard]
        } else {
            vec![FileLink::Hard]
        }
    }

    fn outcome(outcomes: &[(&'static str, Outcome)], name: &str) -> Outcome {
        outcomes
            .iter()
            .find(|(entry, _)| *entry == name)
            .map(|(_, outcome)| *outcome)
            .unwrap_or_else(|| panic!("no outcome for {name}"))
    }

    fn config(fixture: &Fixture) -> DocumentMut {
        fs::read_to_string(fixture.codex_home.join("config.toml"))
            .unwrap()
            .parse()
            .unwrap()
    }

    /// Whether the window's `name` is the user's file itself, however it is
    /// linked.
    fn mirrors(fixture: &Fixture, source: &Path, name: &str) -> bool {
        same_file(&source.join(name), &fixture.codex_home.join(name))
    }

    #[test]
    fn the_users_config_survives_and_gains_the_windows_skills() {
        let fixture = fixture();
        fs::write(
            fixture.source.join("config.toml"),
            r#"# my settings
model = "gpt-5.5-codex"
cli_auth_credentials_store = "file"

[[skills.config]]
path = "/home/me/my-skill/SKILL.md"
enabled = false

[projects."/work/repo"]
trust_level = "untrusted"

[projects."/work/other"]
trust_level = "trusted"

[mcp_servers.docs]
command = "docs-mcp"
"#,
        )
        .unwrap();
        let plan = Plan {
            codex_home: &fixture.codex_home,
            source: Some(&fixture.source),
            skills: std::slice::from_ref(&fixture.skill),
            trusted_project: Some(Path::new("/work/repo")),
        };
        reconcile(&plan).unwrap();
        let text = fs::read_to_string(fixture.codex_home.join("config.toml")).unwrap();
        assert!(text.starts_with("# This SPAWN D window's Codex settings"));
        assert!(text.contains("# my settings"), "the user's comments stay");
        let merged = config(&fixture);
        assert_eq!(merged["model"].as_str(), Some("gpt-5.5-codex"));
        assert_eq!(merged["cli_auth_credentials_store"].as_str(), Some("file"));
        assert_eq!(
            merged["mcp_servers"]["docs"]["command"].as_str(),
            Some("docs-mcp")
        );
        // Their trust decision for the window's own folder stands.
        assert_eq!(
            merged["projects"]["/work/repo"]["trust_level"].as_str(),
            Some("untrusted")
        );
        assert_eq!(
            merged["projects"]["/work/other"]["trust_level"].as_str(),
            Some("trusted")
        );
        let skills = merged["skills"]["config"].as_array_of_tables().unwrap();
        let paths: Vec<_> = skills
            .iter()
            .map(|entry| entry["path"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            paths,
            vec![
                "/home/me/my-skill/SKILL.md".to_string(),
                fixture.skill.to_string_lossy().into_owned(),
            ]
        );
        assert_eq!(skills.get(1).unwrap()["enabled"].as_bool(), Some(true));

        // Applied again (a restart), nothing is listed twice.
        reconcile(&plan).unwrap();
        let merged = config(&fixture);
        assert_eq!(
            merged["skills"]["config"]
                .as_array_of_tables()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn a_relative_path_in_the_users_config_still_names_the_users_file() {
        let fixture = fixture();
        let user = |name: &str| fixture.source.join(name).to_string_lossy().into_owned();
        #[cfg(unix)]
        let absolute = "/etc/codex/instructions.md";
        #[cfg(windows)]
        let absolute = r"C:\codex\instructions.md";
        fs::write(
            fixture.source.join("config.toml"),
            format!(
                r#"model_instructions_file = "instructions.md" # mine
experimental_compact_prompt_file = "~/prompts/compact.md"
model_catalog_json = {absolute:?}
log_dir = "logs"
sandbox_workspace_write = {{ writable_roots = ["scratch", {absolute:?}] }}
skills.config = [{{ path = "skills/mine/SKILL.md", enabled = true }}]

[profiles.work]
model_instructions_file = "work.md"
model = "gpt-5.5-codex"

[agents]
max_threads = 4

[agents.reviewer]
config_file = "agents/reviewer.toml"

[model_providers.corp]
name = "Corp"
base_url = "https://llm.example/v1"
auth = {{ command = "./token.sh" }}

[model_providers.pinned.auth]
command = "token"
cwd = "bin"

[otel.exporter.otlp-http]
endpoint = "https://otel.example"
protocol = "binary"
tls = {{ ca-certificate = "certs/ca.pem" }}
"#
            ),
        )
        .unwrap();
        apply(&fixture, &fixture.source.clone());
        let text = fs::read_to_string(fixture.codex_home.join("config.toml")).unwrap();
        assert!(
            text.contains("# mine"),
            "the key's own comment stays: {text}"
        );
        let merged = config(&fixture);
        assert_eq!(
            merged["model_instructions_file"].as_str(),
            Some(&*user("instructions.md"))
        );
        // `~` is Codex's to expand, and an absolute path already names its
        // file.
        assert_eq!(
            merged["experimental_compact_prompt_file"].as_str(),
            Some("~/prompts/compact.md")
        );
        assert_eq!(merged["model_catalog_json"].as_str(), Some(absolute));
        assert_eq!(merged["log_dir"].as_str(), Some(&*user("logs")));
        let roots = merged["sandbox_workspace_write"]["writable_roots"]
            .as_array()
            .unwrap();
        assert_eq!(roots.get(0).unwrap().as_str(), Some(&*user("scratch")));
        assert_eq!(roots.get(1).unwrap().as_str(), Some(absolute));
        let skills = merged["skills"]["config"].as_array_of_tables().unwrap();
        assert_eq!(
            skills.get(0).unwrap()["path"].as_str(),
            Some(&*user("skills/mine/SKILL.md"))
        );
        assert_eq!(
            merged["profiles"]["work"]["model_instructions_file"].as_str(),
            Some(&*user("work.md"))
        );
        assert_eq!(
            merged["profiles"]["work"]["model"].as_str(),
            Some("gpt-5.5-codex")
        );
        assert_eq!(merged["agents"]["max_threads"].as_integer(), Some(4));
        assert_eq!(
            merged["agents"]["reviewer"]["config_file"].as_str(),
            Some(&*user("agents/reviewer.toml"))
        );
        // A token command with no cwd runs where the user's config is.
        assert_eq!(
            merged["model_providers"]["corp"]["auth"]["cwd"].as_str(),
            Some(&*fixture.source.to_string_lossy())
        );
        assert_eq!(
            merged["model_providers"]["corp"]["auth"]["command"].as_str(),
            Some("./token.sh")
        );
        assert_eq!(
            merged["model_providers"]["pinned"]["auth"]["cwd"].as_str(),
            Some(&*user("bin"))
        );
        assert_eq!(
            merged["otel"]["exporter"]["otlp-http"]["tls"]["ca-certificate"].as_str(),
            Some(&*user("certs/ca.pem"))
        );

        // Restarted, an absolute path stays as it is.
        apply(&fixture, &fixture.source.clone());
        assert_eq!(
            config(&fixture)["model_instructions_file"].as_str(),
            Some(&*user("instructions.md"))
        );
    }

    #[test]
    fn inline_tables_of_the_users_are_merged_into_not_replaced() {
        let merged = merged_config(
            Some(
                "skills = { config = [ { path = \"/u/SKILL.md\", enabled = false } ] }\n\
                 projects = { \"/a\" = { trust_level = \"untrusted\" } }\n",
            ),
            None,
            &[PathBuf::from("/w/SKILL.md")],
            Some(Path::new("/work/repo")),
        );
        let text = merged.to_string();
        assert!(
            !text.contains("[skills]"),
            "no header for a table of tables: {text}"
        );
        let reparsed: DocumentMut = text.parse().unwrap();
        let paths: Vec<_> = reparsed["skills"]["config"]
            .as_array_of_tables()
            .unwrap()
            .iter()
            .map(|entry| entry["path"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(paths, vec!["/u/SKILL.md", "/w/SKILL.md"]);
        assert_eq!(
            reparsed["projects"]["/a"]["trust_level"].as_str(),
            Some("untrusted")
        );
        assert_eq!(
            reparsed["projects"]["/work/repo"]["trust_level"].as_str(),
            Some("trusted")
        );
    }

    #[test]
    fn a_window_with_no_user_config_gets_spawnds_part_alone() {
        let fixture = fixture();
        reconcile(&Plan {
            codex_home: &fixture.codex_home,
            source: None,
            skills: std::slice::from_ref(&fixture.skill),
            trusted_project: Some(Path::new("/work/repo")),
        })
        .unwrap();
        let text = fs::read_to_string(fixture.codex_home.join("config.toml")).unwrap();
        assert!(text.contains("[[skills.config]]"));
        assert!(
            !text.contains("[skills]\n"),
            "no empty parent table: {text}"
        );
        let merged = config(&fixture);
        assert_eq!(
            merged["projects"]["/work/repo"]["trust_level"].as_str(),
            Some("trusted")
        );
    }

    #[test]
    fn an_unparseable_user_config_is_not_merged_and_does_not_stop_the_window() {
        let fixture = fixture();
        fs::write(
            fixture.source.join("config.toml"),
            "model = [unterminated\n",
        )
        .unwrap();
        apply(&fixture, &fixture.source.clone());
        let merged = config(&fixture);
        assert!(merged.get("model").is_none());
        assert!(merged["skills"]["config"].as_array_of_tables().is_some());
    }

    #[cfg(unix)]
    #[test]
    fn a_restart_keeps_the_windows_rollouts_and_they_land_in_the_users_store() {
        let fixture = fixture();
        let outcomes = apply(&fixture, &fixture.source.clone());
        assert_eq!(outcome(&outcomes, "sessions"), Outcome::Linked);
        assert_eq!(outcome(&outcomes, "history.jsonl"), Outcome::Linked);
        // Codex, run in the window, writes a rollout and a history line.
        let day = fixture.codex_home.join("sessions/2026/10/03");
        fs::create_dir_all(&day).unwrap();
        fs::write(day.join("rollout-2026-10-03T10-00-00-abc.jsonl"), b"{}\n").unwrap();
        fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(fixture.codex_home.join("history.jsonl"))
            .unwrap()
            .write_all(b"{\"text\":\"hi\"}\n")
            .unwrap();
        // Restart.
        let outcomes = apply(&fixture, &fixture.source.clone());
        assert_eq!(outcome(&outcomes, "sessions"), Outcome::Current);
        assert!(day.join("rollout-2026-10-03T10-00-00-abc.jsonl").is_file());
        assert!(fixture
            .source
            .join("sessions/2026/10/03/rollout-2026-10-03T10-00-00-abc.jsonl")
            .is_file());
        assert_eq!(
            fs::read(fixture.source.join("history.jsonl")).unwrap(),
            b"{\"text\":\"hi\"}\n"
        );
    }

    #[test]
    fn a_store_the_window_kept_itself_is_never_touched() {
        for files in file_links() {
            let fixture = fixture();
            let own = fixture.codex_home.join("sessions/2026/09/01");
            fs::create_dir_all(&own).unwrap();
            fs::write(own.join("rollout-2026-09-01T10-00-00-old.jsonl"), b"{}\n").unwrap();
            fs::write(fixture.codex_home.join("history.jsonl"), b"mine\n").unwrap();
            let outcomes = apply_with(&fixture, &fixture.source.clone(), files);
            assert_eq!(
                outcome(&outcomes, "sessions"),
                Outcome::KeptOwn,
                "{files:?}"
            );
            assert_eq!(
                outcome(&outcomes, "history.jsonl"),
                Outcome::KeptOwn,
                "{files:?}"
            );
            assert!(own.join("rollout-2026-09-01T10-00-00-old.jsonl").is_file());
            assert_eq!(
                fs::read(fixture.codex_home.join("history.jsonl")).unwrap(),
                b"mine\n"
            );
        }
    }

    #[test]
    fn a_hard_linked_store_file_stays_current_and_follows_a_new_codex_home() {
        let fixture = fixture();
        let outcomes = apply_with(&fixture, &fixture.source.clone(), FileLink::Hard);
        assert_eq!(outcome(&outcomes, "history.jsonl"), Outcome::Linked);
        fs::OpenOptions::new()
            .append(true)
            .open(fixture.codex_home.join("history.jsonl"))
            .unwrap()
            .write_all(b"{\"text\":\"a\"}\n")
            .unwrap();
        // Every later start sees the link it made, not a file of the window's.
        let outcomes = apply_with(&fixture, &fixture.source.clone(), FileLink::Hard);
        assert_eq!(outcome(&outcomes, "history.jsonl"), Outcome::Current);
        assert_eq!(outcome(&outcomes, "session_index.jsonl"), Outcome::Current);
        // A new CODEX_HOME: the hard link to the old one is re-pointed, and
        // the old home keeps what was written through it.
        let other = fixture.source.parent().unwrap().join("other-codex");
        fs::create_dir_all(&other).unwrap();
        let outcomes = apply_with(&fixture, &other, FileLink::Hard);
        assert_eq!(outcome(&outcomes, "history.jsonl"), Outcome::Linked);
        assert!(mirrors(&fixture, &other, "history.jsonl"));
        assert_eq!(
            fs::read(fixture.source.join("history.jsonl")).unwrap(),
            b"{\"text\":\"a\"}\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn every_link_is_repointed_when_the_users_codex_home_changes() {
        let fixture = fixture();
        fs::write(fixture.source.join(AUTH_FILE), b"{\"slot\":\"a\"}").unwrap();
        apply(&fixture, &fixture.source.clone());
        let other = fixture.source.parent().unwrap().join("other-codex");
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join(AUTH_FILE), b"{\"slot\":\"b\"}").unwrap();
        let outcomes = apply(&fixture, &other);
        for name in ["sessions", "archived_sessions", "history.jsonl", AUTH_FILE] {
            assert_eq!(outcome(&outcomes, name), Outcome::Linked, "{name}");
            assert_eq!(
                fs::read_link(fixture.codex_home.join(name)).unwrap(),
                other.join(name),
                "{name}"
            );
        }
        assert_eq!(
            fs::read(fixture.codex_home.join(AUTH_FILE)).unwrap(),
            b"{\"slot\":\"b\"}"
        );
        // A source without a projected file takes the stale link away.
        fs::remove_file(other.join(AUTH_FILE)).unwrap();
        let outcomes = apply(&fixture, &other);
        assert_eq!(outcome(&outcomes, AUTH_FILE), Outcome::Skipped);
        assert!(fs::symlink_metadata(fixture.codex_home.join(AUTH_FILE)).is_err());
    }

    #[test]
    fn a_window_signs_out_and_back_in_with_the_user() {
        for files in file_links() {
            let fixture = fixture();
            let source = fixture.source.clone();
            let window_auth = fixture.codex_home.join(AUTH_FILE);
            fs::write(source.join(AUTH_FILE), b"{\"tokens\":\"old\"}").unwrap();
            let outcomes = apply_with(&fixture, &source, files);
            assert_eq!(outcome(&outcomes, AUTH_FILE), Outcome::Linked, "{files:?}");
            assert!(mirrors(&fixture, &source, AUTH_FILE), "{files:?}");
            let outcomes = apply_with(&fixture, &source, files);
            assert_eq!(outcome(&outcomes, AUTH_FILE), Outcome::Current, "{files:?}");

            // `codex logout` in the user's own home. A hard link keeps the
            // signed-out credential under the window's name until the next
            // apply, which takes it away.
            fs::remove_file(source.join(AUTH_FILE)).unwrap();
            let outcomes = apply_with(&fixture, &source, files);
            assert_eq!(outcome(&outcomes, AUTH_FILE), Outcome::Skipped, "{files:?}");
            assert!(
                fs::symlink_metadata(&window_auth).is_err(),
                "{files:?}: a window kept a sign-in the user signed out of"
            );

            // `codex login` again: the window follows.
            fs::write(source.join(AUTH_FILE), b"{\"tokens\":\"new\"}").unwrap();
            let outcomes = apply_with(&fixture, &source, files);
            assert_eq!(outcome(&outcomes, AUTH_FILE), Outcome::Linked, "{files:?}");
            assert_eq!(fs::read(&window_auth).unwrap(), b"{\"tokens\":\"new\"}");
            assert!(mirrors(&fixture, &source, AUTH_FILE), "{files:?}");

            // A logout and a new login between two starts split a hard link
            // off: the window's name still holds the old sign-in. The next
            // start replaces it.
            fs::remove_file(source.join(AUTH_FILE)).unwrap();
            fs::write(source.join(AUTH_FILE), b"{\"tokens\":\"newer\"}").unwrap();
            let outcomes = apply_with(&fixture, &source, files);
            let expected = match files {
                FileLink::Symbolic => Outcome::Current,
                FileLink::Hard => Outcome::Linked,
            };
            assert_eq!(outcome(&outcomes, AUTH_FILE), expected, "{files:?}");
            assert_eq!(fs::read(&window_auth).unwrap(), b"{\"tokens\":\"newer\"}");
            assert!(mirrors(&fixture, &source, AUTH_FILE), "{files:?}");
        }
    }

    #[test]
    fn a_sign_in_of_the_windows_own_never_outlives_a_start() {
        for files in file_links() {
            let fixture = fixture();
            let source = fixture.source.clone();
            let window_auth = fixture.codex_home.join(AUTH_FILE);
            fs::create_dir_all(&fixture.codex_home).unwrap();
            // A copy an older spawnd left, or a sign-in made in the window.
            fs::write(&window_auth, b"{\"tokens\":\"window\"}").unwrap();
            fs::write(source.join(AUTH_FILE), b"{\"tokens\":\"user\"}").unwrap();
            let outcomes = apply_with(&fixture, &source, files);
            assert_eq!(outcome(&outcomes, AUTH_FILE), Outcome::Linked, "{files:?}");
            assert_eq!(fs::read(&window_auth).unwrap(), b"{\"tokens\":\"user\"}");
            assert!(mirrors(&fixture, &source, AUTH_FILE), "{files:?}");

            // With no sign-in of the user's, the window keeps none either.
            fs::remove_file(&window_auth).unwrap();
            fs::write(&window_auth, b"{\"tokens\":\"window\"}").unwrap();
            fs::remove_file(source.join(AUTH_FILE)).unwrap();
            let outcomes = apply_with(&fixture, &source, files);
            assert_eq!(outcome(&outcomes, AUTH_FILE), Outcome::Skipped, "{files:?}");
            assert!(fs::symlink_metadata(&window_auth).is_err(), "{files:?}");
        }
    }

    #[test]
    fn a_keyring_sign_in_keeps_no_auth_json_and_auto_falls_back_to_the_users() {
        for (store, projected) in [("keyring", false), ("ephemeral", false), ("auto", true)] {
            let fixture = fixture();
            fs::write(fixture.source.join(AUTH_FILE), b"{}").unwrap();
            fs::write(
                fixture.source.join("config.toml"),
                format!("cli_auth_credentials_store = \"{store}\"\n"),
            )
            .unwrap();
            // Whatever an older spawnd left there goes too.
            fs::create_dir_all(&fixture.codex_home).unwrap();
            fs::write(fixture.codex_home.join(AUTH_FILE), b"{\"stale\":1}").unwrap();
            let outcomes = apply(&fixture, &fixture.source.clone());
            assert_eq!(
                config(&fixture)["cli_auth_credentials_store"].as_str(),
                Some(store)
            );
            if projected {
                assert_eq!(outcome(&outcomes, AUTH_FILE), Outcome::Linked, "{store}");
                assert!(mirrors(&fixture, &fixture.source, AUTH_FILE), "{store}");
            } else {
                assert_eq!(outcome(&outcomes, AUTH_FILE), Outcome::Skipped, "{store}");
                assert!(!fixture.codex_home.join(AUTH_FILE).exists(), "{store}");
            }
        }
    }

    #[test]
    fn a_hard_link_to_an_earlier_source_is_relinked_to_the_new_one() {
        let fixture = fixture();
        fs::create_dir_all(&fixture.codex_home).unwrap();
        let earlier = fixture.source.parent().unwrap().join("earlier-codex");
        fs::create_dir_all(&earlier).unwrap();
        fs::write(earlier.join(AUTH_FILE), b"{\"slot\":\"a\"}").unwrap();
        // How a Windows window was given its sign-in from the earlier home.
        fs::hard_link(earlier.join(AUTH_FILE), fixture.codex_home.join(AUTH_FILE)).unwrap();
        fs::write(fixture.source.join(AUTH_FILE), b"{\"slot\":\"b\"}").unwrap();
        let outcomes = apply_with(&fixture, &fixture.source.clone(), FileLink::Hard);
        assert_eq!(outcome(&outcomes, AUTH_FILE), Outcome::Linked);
        assert_eq!(
            fs::read(fixture.codex_home.join(AUTH_FILE)).unwrap(),
            b"{\"slot\":\"b\"}"
        );
        assert_eq!(
            fs::read(earlier.join(AUTH_FILE)).unwrap(),
            b"{\"slot\":\"a\"}"
        );
        let outcomes = apply_with(&fixture, &fixture.source.clone(), FileLink::Hard);
        assert_eq!(outcome(&outcomes, AUTH_FILE), Outcome::Current);
    }

    #[cfg(unix)]
    #[test]
    fn the_config_replaces_a_link_rather_than_writing_through_it() {
        let fixture = fixture();
        fs::create_dir_all(&fixture.codex_home).unwrap();
        let elsewhere = fixture.source.join("config.toml");
        fs::write(&elsewhere, "model = \"mine\"\n").unwrap();
        std::os::unix::fs::symlink(&elsewhere, fixture.codex_home.join("config.toml")).unwrap();
        apply(&fixture, &fixture.source.clone());
        assert_eq!(
            fs::read_to_string(&elsewhere).unwrap(),
            "model = \"mine\"\n"
        );
        assert!(
            !fs::symlink_metadata(fixture.codex_home.join("config.toml"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }
}
