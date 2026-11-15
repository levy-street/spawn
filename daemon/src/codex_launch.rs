//! Whether this host's Codex accepts `--no-daemon`.
//!
//! By default Codex (0.167.2) keeps every window's threads in one shared
//! background server (`codex app-server`), a process of its own outside every
//! window, so the host cannot tell which thread a window is on (`host_conv`).
//! `codex --no-daemon` keeps a window's threads in that window's own process
//! instead, where they can be named. SPAWN D's clients type the flag when they
//! start Codex only where this host says its Codex accepts it: a Codex that
//! does not know the flag refuses to start at all, and a shell fallback
//! (`codex --no-daemon || codex`) would relaunch Codex after any session that
//! ends badly, and is not one command in every shell SPAWN D types into.
//!
//! The answer comes from running `codex --no-daemon --version`, by its full
//! path, with a timeout: Codex parses its arguments before it does its work,
//! so it prints its version and exits, connecting to nothing and starting no
//! server or thread (Codex 0.167.2 under strace); a Codex without the flag
//! exits non-zero on the unknown argument. Like every `codex` run — and like
//! the `--version` check `host.agents.check` already makes — it sets up
//! Codex's own scratch folder of links to itself under
//! `<CODEX_HOME>/tmp/arg0-linux/`, which Codex clears on a later run.
//!
//! The daemon runs it itself — never at a device's or the server's request —
//! once when it starts, and again only when the `codex` its user's shells
//! find changes (another path, size or modification time, looked at once a
//! minute). Until then the answer is unknown, and a client adds nothing. Only where windows can be inspected (`host_conv::SUPPORTED`):
//! elsewhere the flag would cost the person Codex's shared server and buy
//! nothing.

use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime};

/// The program SPAWN D types to start Codex, as agent definitions spell it.
const PROGRAM: &str = "codex";
/// What a Codex that knows the flag answers with its version, and one that
/// does not refuses.
const PROBE_ARGS: [&str; 2] = ["--no-daemon", "--version"];
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const PROBE_OUTPUT_BYTES: usize = 4096;
/// How often the `codex` found is looked at (a stat) for a change.
const RECHECK: Duration = Duration::from_secs(60);
/// How often the user's shell environment is read again while it finds no
/// `codex`: one installed later may have put a new folder on the PATH.
const ENV_REFRESH: Duration = Duration::from_secs(600);

/// The executable a probe answered for.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Stamp {
    path: PathBuf,
    len: u64,
    modified: Option<SystemTime>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Known {
    stamp: Stamp,
    no_daemon: bool,
}

static KNOWN: Mutex<Option<Known>> = Mutex::new(None);

fn known() -> std::sync::MutexGuard<'static, Option<Known>> {
    KNOWN.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Whether the `codex` this host's shells find accepts `--no-daemon`: None
/// until it has been looked at, and while no `codex` is found.
pub(crate) fn accepts_no_daemon() -> Option<bool> {
    known().as_ref().map(|known| known.no_daemon)
}

/// Keep `accepts_no_daemon` current for the life of the daemon.
pub(crate) async fn watch() {
    let mut env = crate::run::resolved_command_env().await;
    let mut env_read = Instant::now();
    let mut interval = tokio::time::interval(RECHECK);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        let last = known().clone();
        let next = refresh(last, &env, |path| probe(path, &env, PROBE_TIMEOUT)).await;
        if next.is_none() && env_read.elapsed() >= ENV_REFRESH {
            env = crate::run::resolved_command_env().await;
            env_read = Instant::now();
        }
        *known() = next;
    }
}

/// One look: the `codex` found in `env` now, probed again only when it is not
/// the executable `last` answered for. None when there is none.
async fn refresh<F, Fut>(
    last: Option<Known>,
    env: &BTreeMap<String, String>,
    probe: F,
) -> Option<Known>
where
    F: FnOnce(PathBuf) -> Fut,
    Fut: Future<Output = bool>,
{
    let stamp = stamp(env)?;
    if let Some(last) = last.filter(|last| last.stamp == stamp) {
        return Some(last);
    }
    let no_daemon = probe(stamp.path.clone()).await;
    Some(Known { stamp, no_daemon })
}

fn stamp(env: &BTreeMap<String, String>) -> Option<Stamp> {
    let resolved = crate::run::resolve_program_in_env(Path::new(PROGRAM), env)?;
    let metadata = std::fs::metadata(&resolved.path).ok()?;
    Some(Stamp {
        path: resolved.path,
        len: metadata.len(),
        modified: metadata.modified().ok(),
    })
}

/// Run the probe against the executable stamped, by its path, so what is
/// probed is what was found. Anything but Codex's own version line, in time,
/// is a no.
async fn probe(path: PathBuf, env: &BTreeMap<String, String>, timeout: Duration) -> bool {
    let Some(program) = path.to_str() else {
        return false;
    };
    let capture = crate::run::run_program_capture(
        program,
        &PROBE_ARGS,
        timeout,
        PROBE_OUTPUT_BYTES,
        Some(env),
    )
    .await;
    capture.success && answers_as_codex(&capture.output)
}

/// `codex-cli 0.167.2`: Codex's version line, not some other program's
/// output under the name.
fn answers_as_codex(output: &str) -> bool {
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .is_some_and(|line| line.starts_with("codex"))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A folder whose only program is a `codex` running `script`.
    fn fake_codex(script: &str) -> (tempfile::TempDir, BTreeMap<String, String>) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(PROGRAM);
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let env = BTreeMap::from([(
            "PATH".to_string(),
            dir.path().to_string_lossy().into_owned(),
        )]);
        (dir, env)
    }

    async fn answer(script: &str, timeout: Duration) -> Option<bool> {
        let (_dir, env) = fake_codex(script);
        refresh(None, &env, |path| probe(path, &env, timeout))
            .await
            .map(|known| known.no_daemon)
    }

    #[tokio::test]
    async fn a_codex_that_knows_the_flag_says_so_with_its_version() {
        let script = r#"[ "$1" = --no-daemon ] && [ "$2" = --version ] && { echo "codex-cli 0.167.2"; exit 0; }; exit 2"#;
        assert_eq!(answer(script, PROBE_TIMEOUT).await, Some(true));
    }

    #[tokio::test]
    async fn a_codex_without_the_flag_and_anything_unexpected_is_a_no() {
        for script in [
            // Codex before the flag: clap refuses the unknown argument.
            r#"echo "error: unexpected argument '--no-daemon' found" >&2; exit 2"#,
            // Some other program under the name, or help text instead.
            r#"echo "Usage: codex [OPTIONS]"; exit 0"#,
            r#"exit 0"#,
        ] {
            assert_eq!(answer(script, PROBE_TIMEOUT).await, Some(false), "{script}");
        }
    }

    #[tokio::test]
    async fn a_codex_that_hangs_is_a_no_and_is_not_waited_on() {
        let started = Instant::now();
        // `exec`, so the process the probe times out on is the one sleeping.
        let script = "PATH=/bin:/usr/bin; exec sleep 30";
        assert_eq!(
            answer(script, Duration::from_millis(300)).await,
            Some(false)
        );
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[tokio::test]
    async fn no_codex_on_the_path_is_unknown() {
        let empty = tempfile::tempdir().unwrap();
        let env = BTreeMap::from([(
            "PATH".to_string(),
            empty.path().to_string_lossy().into_owned(),
        )]);
        let probed = refresh(None, &env, |_| async { panic!("nothing to probe") }).await;
        assert_eq!(probed, None);
    }

    #[tokio::test]
    async fn the_same_codex_is_probed_once_and_a_changed_one_again() {
        let runs = tempfile::tempdir().unwrap();
        let count = runs.path().join("runs");
        let script = format!(
            "echo run >> {}; echo \"codex-cli 0.167.2\"",
            count.display()
        );
        let (dir, env) = fake_codex(&script);
        let ran = || {
            std::fs::read_to_string(&count)
                .map(|text| text.lines().count())
                .unwrap_or(0)
        };
        let first = refresh(None, &env, |path| probe(path, &env, PROBE_TIMEOUT)).await;
        assert_eq!(first.as_ref().map(|known| known.no_daemon), Some(true));
        let again = refresh(first.clone(), &env, |path| probe(path, &env, PROBE_TIMEOUT)).await;
        assert_eq!(again, first);
        assert_eq!(ran(), 1);
        // An update replaces the executable: probed again.
        std::fs::write(
            dir.path().join(PROGRAM),
            format!("#!/bin/sh\necho run >> {}\nexit 2\n", count.display()),
        )
        .unwrap();
        let updated = refresh(again, &env, |path| probe(path, &env, PROBE_TIMEOUT)).await;
        assert_eq!(updated.map(|known| known.no_daemon), Some(false));
        assert_eq!(ran(), 2);
    }

    #[test]
    fn only_codexs_version_line_counts() {
        assert!(answers_as_codex("codex-cli 0.167.2\n"));
        assert!(answers_as_codex("\n  codex 1.0\n"));
        assert!(!answers_as_codex(""));
        assert!(!answers_as_codex("node v22.0.0"));
        assert!(!answers_as_codex("Usage: codex [OPTIONS]"));
    }
}
