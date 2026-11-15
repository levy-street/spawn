//! Whether the Codex a window will run accepts `--no-daemon`.
//!
//! By default Codex (0.167.2) keeps every window's threads in one shared
//! background server (`codex app-server`), a process of its own outside every
//! window, so the host cannot tell which thread a window is on (`host_conv`).
//! `codex --no-daemon` keeps a window's threads in that window's own process
//! instead, where they can be named. A client types the flag only where the
//! host says the window's Codex accepts it: a Codex that does not know the
//! flag refuses to start. Nothing simpler does the same job. A shell fallback
//! (`codex --no-daemon || codex`) relaunches Codex after any session that
//! ends badly and is not one command in PowerShell or cmd. The config
//! override `-c features.daemon_auto_start=false`, which an older Codex
//! ignores, is not equivalent: while a shared server runs, Codex 0.167.2
//! stops on a prompt whose recommended answer restarts that server for every
//! window, and its other answers exit.
//!
//! The answer describes the window, not the daemon: it is asked for when a
//! client is about to type Codex into a window (`conv.launch`), and comes from
//! running `codex --no-daemon --version` with the environment and in the
//! folder the window's shell was started with — the environment spawnd built
//! for that session, so no shell is run to learn it — with a timeout. Codex
//! parses its arguments before it does its work, so it prints its version
//! and exits, connecting to nothing and starting no server or thread (0.167.2
//! under strace); like every `codex` run it refreshes Codex's own scratch
//! folder of links to itself under `<CODEX_HOME>/tmp/`. A Codex without the
//! flag exits non-zero on the unknown argument. Nothing is kept between
//! launches: a timeout, a missing `codex` or a run that could not start
//! answers "unknown", and the client types plain `codex`.
//!
//! What this cannot see is what only the window's interactive shell knows: an
//! alias or function named `codex`, or a PATH a shell hook changes on `cd`.
//! There a "yes" can still be wrong, and the client undoes it: it watches for
//! Codex's refusal of the flag and types the command again without it.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

/// The program SPAWN D types to start Codex, as agent definitions spell it.
const PROGRAM: &str = "codex";
/// What a Codex that knows the flag answers with its version, and one that
/// does not refuses.
const PROBE_ARGS: [&str; 2] = ["--no-daemon", "--version"];
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const PROBE_OUTPUT_BYTES: usize = 4096;

/// Whether the `codex` that `env`'s PATH finds, run in `cwd`, accepts
/// `--no-daemon`: yes for its version line, no for a non-zero exit, None for
/// anything else (no `codex`, a timeout, a run that could not start, output
/// that is not Codex's).
pub(crate) async fn accepts_no_daemon(env: &BTreeMap<String, String>, cwd: &Path) -> Option<bool> {
    accepts_no_daemon_within(env, cwd, PROBE_TIMEOUT).await
}

async fn accepts_no_daemon_within(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    timeout: Duration,
) -> Option<bool> {
    // By the path found, so what runs is what was found.
    let found = crate::run::resolve_program_in_env(Path::new(PROGRAM), env)?;
    let program = found.path.to_str()?;
    let capture = crate::run::run_program_capture_in(
        program,
        &PROBE_ARGS,
        timeout,
        PROBE_OUTPUT_BYTES,
        Some(env),
        Some(cwd),
    )
    .await;
    match (capture.exited, capture.success) {
        (true, true) => answers_as_codex(&capture.output).then_some(true),
        (true, false) => Some(false),
        (false, _) => None,
    }
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
    use std::time::Instant;

    /// A folder whose only program is a `codex` running `script`, and an
    /// environment whose PATH is that folder.
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
        let (dir, env) = fake_codex(script);
        accepts_no_daemon_within(&env, dir.path(), timeout).await
    }

    #[tokio::test]
    async fn a_codex_that_knows_the_flag_says_so_with_its_version() {
        let script = r#"[ "$1" = --no-daemon ] && [ "$2" = --version ] && { echo "codex-cli 0.167.2"; exit 0; }; exit 2"#;
        assert_eq!(answer(script, PROBE_TIMEOUT).await, Some(true));
    }

    #[tokio::test]
    async fn a_codex_without_the_flag_says_no_by_its_exit() {
        // Codex before the flag: clap refuses the unknown argument.
        let script = r#"echo "error: unexpected argument '--no-daemon' found" >&2; exit 2"#;
        assert_eq!(answer(script, PROBE_TIMEOUT).await, Some(false));
    }

    #[tokio::test]
    async fn anything_but_a_version_or_a_refusal_is_unknown() {
        // Some other program under the name, help text instead, nothing.
        for script in [r#"echo "Usage: codex [OPTIONS]"; exit 0"#, "exit 0"] {
            assert_eq!(answer(script, PROBE_TIMEOUT).await, None, "{script}");
        }
    }

    #[tokio::test]
    async fn a_codex_that_hangs_is_unknown_and_is_not_waited_on() {
        let started = Instant::now();
        // `exec`, so the process the probe times out on is the one sleeping.
        let script = "PATH=/bin:/usr/bin; exec sleep 30";
        assert_eq!(answer(script, Duration::from_millis(300)).await, None);
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[tokio::test]
    async fn no_codex_on_the_windows_path_is_unknown() {
        let empty = tempfile::tempdir().unwrap();
        let env = BTreeMap::from([(
            "PATH".to_string(),
            empty.path().to_string_lossy().into_owned(),
        )]);
        assert_eq!(accepts_no_daemon(&env, empty.path()).await, None);
    }

    #[tokio::test]
    async fn the_codex_asked_is_the_windows_own_in_its_folder() {
        // A version manager's shim answers for the folder it runs in: the
        // probe runs where the window's shell starts.
        let (dir, env) =
            fake_codex(r#"[ -f .new-codex ] && { echo "codex-cli 0.167.2"; exit 0; }; exit 2"#);
        let project = tempfile::tempdir().unwrap();
        assert_eq!(accepts_no_daemon(&env, project.path()).await, Some(false));
        std::fs::write(project.path().join(".new-codex"), "").unwrap();
        assert_eq!(accepts_no_daemon(&env, project.path()).await, Some(true));
        drop(dir);
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
