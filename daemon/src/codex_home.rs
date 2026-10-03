//! A skilled window's own `CODEX_HOME`: `<window home>/codex-home`.
//!
//! Codex finds its skills through `config.toml` in `CODEX_HOME`, so a window
//! whose skills spawnd writes gets a Codex home of its own. Everything else in
//! it is the user's:
//!
//! - their `config.toml`, merged rather than replaced (format-preserving, so
//!   their comments and settings — `cli_auth_credentials_store` among them —
//!   survive), with this window's skills and its folder's trust added;
//! - their conversation stores, `sessions/`, `archived_sessions/`,
//!   `history.jsonl` and `session_index.jsonl`, linked, so a rollout written
//!   here lands in the store every other Codex reads: `codex resume` finds it
//!   from any window and `agent.transcripts` finds it where it looks;
//! - their sign-in and Codex's small caches, linked and never copied: Codex
//!   refresh tokens are single-use, and a copy that refreshed would fork the
//!   chain and sign the user's own Codex out. On Windows, where a file
//!   symlink needs a privilege, `auth.json` is hard-linked instead, or not
//!   projected at all. A keyring (or `auto`) credential store is keyed by the
//!   `CODEX_HOME` path itself, so there is nothing to project and nothing is.
//!
//! The home is reconciled each time the window starts or restarts, never
//! wiped — the wipe this replaced deleted every skilled window's Codex
//! conversations on Restart. Each apply re-points every link (a different
//! `CODEX_HOME` is a different source) and verifies it. What is real rather
//! than linked is left alone where it could be the user's: a conversation
//! store a window kept before these links existed, or a sign-in that differs
//! from the source's. A projected file is spawnd's to replace only where
//! replacing it loses nothing: a symlink, a hard link (its data has another
//! name — on Windows that is an earlier source's projection), or a copy
//! byte-identical to its source.

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use toml_edit::{value, ArrayOfTables, DocumentMut, Item, Table};

/// The user's `config.toml` is read up to this much; Codex's own is a few
/// KiB, and anything past this is not one to merge.
const MAX_CONFIG_BYTES: u64 = 1024 * 1024;
/// A projected file is compared with its source up to this size.
const MAX_COMPARED_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Dir,
    File,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Owner {
    /// The user's conversations. A link is re-pointed; a real entry is the
    /// window's own record from before the link, and is never touched.
    Store,
    /// State projected from the source home. A link, or a copy identical to
    /// its source, is replaced; a file that differs is the window's own (a
    /// sign-in made in it), and is kept.
    Projected,
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
        owner: Owner::Projected,
    },
    Projection {
        name: "internal_storage.json",
        kind: Kind::File,
        owner: Owner::Projected,
    },
    Projection {
        name: "models_cache.json",
        kind: Kind::File,
        owner: Owner::Projected,
    },
    Projection {
        name: "version.json",
        kind: Kind::File,
        owner: Owner::Projected,
    },
];

const AUTH_FILE: &str = "auth.json";

/// What reconciling one entry came to, for the log and for tests.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// Linked to the source, newly or re-pointed, and verified.
    Linked,
    /// Already linked to the source.
    Current,
    /// A real entry that may be the user's; left as it was.
    KeptOwn,
    /// Nothing to project: the source has none, or the credential store is
    /// not a file. A stale link of ours is removed.
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
    crate::platform::create_private_dir_all(plan.codex_home)
        .with_context(|| format!("creating {}", plan.codex_home.display()))?;
    let source = plan.source.filter(|source| source.is_dir());
    let user_config = match source {
        Some(source) => read_user_config(&source.join("config.toml")),
        None => None,
    };
    let config = merged_config(user_config.as_deref(), plan.skills, plan.trusted_project);
    let file_credentials = !matches!(
        config
            .get("cli_auth_credentials_store")
            .and_then(Item::as_str),
        Some("keyring" | "auto")
    );
    let path = plan.codex_home.join("config.toml");
    replace_private_file(
        &path,
        rendered_config(&config, source.map(|source| source.join("config.toml"))).as_bytes(),
    )
    .with_context(|| format!("writing {}", path.display()))?;

    let mut outcomes = Vec::with_capacity(PROJECTIONS.len());
    for projection in PROJECTIONS {
        let dest = plan.codex_home.join(projection.name);
        let wanted = source.filter(|_| projection.name != AUTH_FILE || file_credentials);
        if projection.name == AUTH_FILE && !file_credentials {
            tracing::info!(
                codex_home = %plan.codex_home.display(),
                "Codex keeps its sign-in in the OS keyring for each CODEX_HOME; not projecting auth.json"
            );
        }
        let outcome = match wanted {
            Some(source) => project(projection, &source.join(projection.name), &dest),
            None => forget(&dest).map(|()| Outcome::Skipped),
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

/// The user's configuration with this window's skills and trust merged in.
/// Their own entries win: a skill path already listed is not listed twice,
/// and a folder they gave a trust level keeps it.
fn merged_config(user: Option<&str>, skills: &[PathBuf], trusted: Option<&Path>) -> DocumentMut {
    let mut config = match user.map(str::parse::<DocumentMut>) {
        Some(Ok(config)) => config,
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

/// One entry of the window's home, reconciled against `source`.
fn project(projection: &Projection, source: &Path, dest: &Path) -> io::Result<Outcome> {
    match projection.owner {
        Owner::Store => prepare_store(projection.kind, source)?,
        Owner::Projected => {
            if !source.is_file() {
                forget(dest)?;
                return Ok(Outcome::Skipped);
            }
        }
    }
    match fs::symlink_metadata(dest) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            link(projection.kind, source, dest)?;
            Ok(Outcome::Linked)
        }
        Err(error) => Err(error),
        Ok(metadata) if metadata.file_type().is_symlink() => {
            if fs::read_link(dest).is_ok_and(|target| target == source) {
                return Ok(Outcome::Current);
            }
            remove_link(dest, &metadata)?;
            link(projection.kind, source, dest)?;
            Ok(Outcome::Linked)
        }
        Ok(_) if projection.owner == Owner::Store => Ok(Outcome::KeptOwn),
        Ok(metadata) if metadata.is_file() => {
            if same_file(source, dest) {
                return Ok(Outcome::Current);
            }
            if !hard_linked(dest) && !same_contents(source, dest) {
                return Ok(Outcome::KeptOwn);
            }
            fs::remove_file(dest)?;
            link(projection.kind, source, dest)?;
            Ok(Outcome::Linked)
        }
        Ok(_) => Ok(Outcome::KeptOwn),
    }
}

/// A store a link can point at. A directory Codex would create itself is
/// created; a file is left for Codex's own append to create through the
/// link, except where the link is a hard one, which needs a file to name.
fn prepare_store(kind: Kind, source: &Path) -> io::Result<()> {
    match kind {
        Kind::Dir => fs::create_dir_all(source),
        Kind::File => {
            if cfg!(windows) {
                fs::OpenOptions::new()
                    .append(true)
                    .create(true)
                    .open(source)
                    .map(drop)
            } else {
                Ok(())
            }
        }
    }
}

/// Remove a projection of ours that is no longer wanted: a link, symbolic or
/// hard, and nothing whose removal would lose data.
fn forget(dest: &Path) -> io::Result<()> {
    match fs::symlink_metadata(dest) {
        Ok(metadata) if metadata.file_type().is_symlink() => remove_link(dest, &metadata),
        Ok(metadata) if metadata.is_file() && hard_linked(dest) => fs::remove_file(dest),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// Make the link and prove it names `source`; one that does not is taken
/// away again rather than left pointing somewhere else.
fn link(kind: Kind, source: &Path, dest: &Path) -> io::Result<()> {
    make_link(kind, source, dest)?;
    let verified = match kind {
        Kind::File if cfg!(windows) => same_file(source, dest),
        _ => fs::read_link(dest).is_ok_and(|target| target == source),
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
fn make_link(_kind: Kind, source: &Path, dest: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(source, dest)
}

/// A directory symlink needs Developer Mode or the privilege; without it the
/// store stays unlinked and Codex keeps this window's rollouts in its home,
/// which is no longer wiped. A file is hard-linked, which needs neither, and
/// never copied.
#[cfg(windows)]
fn make_link(kind: Kind, source: &Path, dest: &Path) -> io::Result<()> {
    match kind {
        Kind::Dir => std::os::windows::fs::symlink_dir(source, dest),
        Kind::File => fs::hard_link(source, dest),
    }
}

#[cfg(not(any(unix, windows)))]
fn make_link(_kind: Kind, _source: &Path, _dest: &Path) -> io::Result<()> {
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

fn same_contents(left: &Path, right: &Path) -> bool {
    let read = |path: &Path| -> io::Result<Vec<u8>> {
        let mut bytes = Vec::new();
        fs::File::open(path)?
            .take(MAX_COMPARED_BYTES + 1)
            .read_to_end(&mut bytes)?;
        Ok(bytes)
    };
    match (read(left), read(right)) {
        (Ok(left), Ok(right)) => left.len() as u64 <= MAX_COMPARED_BYTES && left == right,
        _ => false,
    }
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
        reconcile(&Plan {
            codex_home: &fixture.codex_home,
            source: Some(source),
            skills: std::slice::from_ref(&fixture.skill),
            trusted_project: Some(Path::new("/work/repo")),
        })
        .unwrap()
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
    fn inline_tables_of_the_users_are_merged_into_not_replaced() {
        let merged = merged_config(
            Some(
                "skills = { config = [ { path = \"/u/SKILL.md\", enabled = false } ] }\n\
                 projects = { \"/a\" = { trust_level = \"untrusted\" } }\n",
            ),
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
        let fixture = fixture();
        let own = fixture.codex_home.join("sessions/2026/09/01");
        fs::create_dir_all(&own).unwrap();
        fs::write(own.join("rollout-2026-09-01T10-00-00-old.jsonl"), b"{}\n").unwrap();
        fs::write(fixture.codex_home.join("history.jsonl"), b"mine\n").unwrap();
        let outcomes = apply(&fixture, &fixture.source.clone());
        assert_eq!(outcome(&outcomes, "sessions"), Outcome::KeptOwn);
        assert_eq!(outcome(&outcomes, "history.jsonl"), Outcome::KeptOwn);
        assert!(own.join("rollout-2026-09-01T10-00-00-old.jsonl").is_file());
        assert_eq!(
            fs::read(fixture.codex_home.join("history.jsonl")).unwrap(),
            b"mine\n"
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
    fn a_copied_sign_in_is_replaced_by_a_link_and_a_different_one_is_kept() {
        let fixture = fixture();
        fs::create_dir_all(&fixture.codex_home).unwrap();
        fs::write(fixture.source.join(AUTH_FILE), b"{\"tokens\":1}").unwrap();
        // An unrefreshed copy, as an older spawnd left on Windows.
        fs::write(fixture.codex_home.join(AUTH_FILE), b"{\"tokens\":1}").unwrap();
        let outcomes = apply(&fixture, &fixture.source.clone());
        assert_eq!(outcome(&outcomes, AUTH_FILE), Outcome::Linked);
        assert!(same_file(
            &fixture.source.join(AUTH_FILE),
            &fixture.codex_home.join(AUTH_FILE)
        ));
        // A sign-in made in the window itself is the only one it has.
        fs::remove_file(fixture.codex_home.join(AUTH_FILE)).unwrap();
        fs::write(fixture.codex_home.join(AUTH_FILE), b"{\"tokens\":2}").unwrap();
        let outcomes = apply(&fixture, &fixture.source.clone());
        assert_eq!(outcome(&outcomes, AUTH_FILE), Outcome::KeptOwn);
        assert_eq!(
            fs::read(fixture.codex_home.join(AUTH_FILE)).unwrap(),
            b"{\"tokens\":2}"
        );
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
        let outcomes = apply(&fixture, &fixture.source.clone());
        assert_eq!(outcome(&outcomes, AUTH_FILE), Outcome::Linked);
        assert_eq!(
            fs::read(fixture.codex_home.join(AUTH_FILE)).unwrap(),
            b"{\"slot\":\"b\"}"
        );
        assert_eq!(
            fs::read(earlier.join(AUTH_FILE)).unwrap(),
            b"{\"slot\":\"a\"}"
        );
        let outcomes = apply(&fixture, &fixture.source.clone());
        assert_eq!(outcome(&outcomes, AUTH_FILE), Outcome::Current);
    }

    #[test]
    fn a_keyring_sign_in_is_not_projected() {
        for store in ["keyring", "auto"] {
            let fixture = fixture();
            fs::write(fixture.source.join(AUTH_FILE), b"{}").unwrap();
            fs::write(
                fixture.source.join("config.toml"),
                format!("cli_auth_credentials_store = \"{store}\"\n"),
            )
            .unwrap();
            let outcomes = apply(&fixture, &fixture.source.clone());
            assert_eq!(outcome(&outcomes, AUTH_FILE), Outcome::Skipped, "{store}");
            assert!(!fixture.codex_home.join(AUTH_FILE).exists(), "{store}");
            assert_eq!(
                config(&fixture)["cli_auth_credentials_store"].as_str(),
                Some(store)
            );
        }
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
