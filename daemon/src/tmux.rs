//! Thin wrapper around invoking the `tmux` binary. We deliberately keep this
//! crate-free of any tmux-control-mode complexity: we just shell out for
//! lifecycle ops (`new-session -d`, `kill-session`, `has-session`,
//! `refresh-client`).

use std::collections::BTreeMap;
use std::process::Stdio;

use anyhow::{anyhow, Context, Result};
use tokio::process::Command;
use uuid::Uuid;

const SESSION_PREFIX: &str = "spawn-";
const DEFAULT_LABEL: &str = "agent";
const MAX_LABEL_LEN: usize = 48;

/// Base `tmux` invocation. Strips any inherited `$TMUX` so a daemon launched
/// from inside a tmux pane (dev shells, smoke tests) resolves sockets via its
/// own `TMUX_TMPDIR` instead of silently targeting the outer server — which
/// would let a sandboxed daemon discover, resize, or kill production sessions.
fn tmux_command() -> Command {
    let mut cmd = Command::new("tmux");
    cmd.env_remove("TMUX");
    cmd
}

/// Returns the canonical tmux session name for an agent.
///
/// The UUID stays in the name so a restarted daemon can rediscover and
/// reattach sessions even after users rename agents in Spawn.
pub fn session_name(agent_id: Uuid, label: Option<&str>) -> String {
    format!(
        "{SESSION_PREFIX}{}--{}",
        safe_session_label(label.unwrap_or(DEFAULT_LABEL)),
        agent_id
    )
}

/// Previous stable session name format. Kept for rediscovering existing
/// agents created before friendly tmux names were introduced.
pub fn legacy_session_name(agent_id: Uuid) -> String {
    format!("{SESSION_PREFIX}{agent_id}")
}

/// Sanitize arbitrary UI names into tmux-friendly, shell-ergonomic labels.
pub fn safe_session_label(label: &str) -> String {
    let mut out = String::new();
    let mut last_was_sep = false;

    for ch in label.trim().chars() {
        let next = if ch.is_ascii_alphanumeric() {
            Some(ch.to_ascii_lowercase())
        } else if matches!(ch, '.' | '_' | '-') {
            Some(ch)
        } else if ch.is_whitespace() || matches!(ch, '/' | '\\' | ':' | ';' | ',') {
            Some('-')
        } else {
            None
        };

        let Some(ch) = next else {
            continue;
        };
        if ch == '-' {
            if last_was_sep || out.is_empty() {
                continue;
            }
            last_was_sep = true;
        } else {
            last_was_sep = false;
        }
        out.push(ch);
        if out.len() >= MAX_LABEL_LEN {
            break;
        }
    }

    while out.ends_with('-') || out.ends_with('.') || out.ends_with('_') {
        out.pop();
    }
    if out.is_empty() {
        DEFAULT_LABEL.to_string()
    } else {
        out
    }
}

/// Extract the Spawn agent UUID from either the new friendly session name or
/// the legacy `spawn-<uuid>` format.
pub fn agent_id_from_session(session: &str) -> Option<Uuid> {
    let suffix = session.strip_prefix(SESSION_PREFIX)?;
    if let Ok(id) = Uuid::parse_str(suffix) {
        return Some(id);
    }

    let bytes = suffix.as_bytes();
    if bytes.len() < 36 {
        return None;
    }
    for start in 0..=(bytes.len() - 36) {
        let candidate = std::str::from_utf8(&bytes[start..start + 36]).ok()?;
        if let Ok(id) = Uuid::parse_str(candidate) {
            return Some(id);
        }
    }
    None
}

/// Start a detached tmux session running the given argv with the given env.
/// Returns when tmux returns (the session itself keeps running detached).
pub async fn new_session_detached(
    session: &str,
    cwd: &str,
    cols: u16,
    rows: u16,
    argv: &[String],
    env: &BTreeMap<String, String>,
) -> Result<()> {
    if argv.is_empty() {
        anyhow::bail!("argv is empty; cannot launch agent");
    }

    let mut cmd = tmux_command();
    cmd.arg("new-session")
        .arg("-d")
        .arg("-s")
        .arg(session)
        .arg("-c")
        .arg(cwd)
        .arg("-x")
        .arg(cols.to_string())
        .arg("-y")
        .arg(rows.to_string());

    // tmux -e KEY=VAL is per-environment-variable for the new session.
    for (k, v) in env {
        cmd.arg("-e").arg(format!("{k}={v}"));
    }

    for arg in agent_command_args(argv, env) {
        cmd.arg(arg);
    }

    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let out = cmd.output().await.context("invoking tmux new-session")?;
    if !out.status.success() {
        return Err(anyhow!(
            "tmux new-session failed ({}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

fn agent_command_args(argv: &[String], env: &BTreeMap<String, String>) -> Vec<String> {
    let mut args = vec!["--".to_string()];

    // tmux applies most -e variables to the pane process, but on some hosts
    // PATH is reset to a built-in default. Route only PATH through env(1) so
    // command lookup sees the same PATH that daemon preflight validated,
    // without exposing arbitrary secret env vars in the command argv.
    if let Some(path) = env.get("PATH").filter(|path| !path.is_empty()) {
        args.push("/usr/bin/env".to_string());
        args.push(format!("PATH={path}"));
    }

    args.extend(argv.iter().cloned());
    args
}

pub async fn kill_session(session: &str) -> Result<()> {
    let out = tmux_command()
        .arg("kill-session")
        .arg("-t")
        .arg(session)
        .output()
        .await
        .context("invoking tmux kill-session")?;
    if !out.status.success() {
        // Killing a non-existent session is fine.
        let stderr = String::from_utf8_lossy(&out.stderr);
        if stderr.contains("can't find session") || stderr.contains("session not found") {
            return Ok(());
        }
        return Err(anyhow!(
            "tmux kill-session failed ({}): {}",
            out.status,
            stderr.trim()
        ));
    }
    Ok(())
}

pub async fn rename_session(current: &str, next: &str) -> Result<()> {
    if current == next {
        return Ok(());
    }
    let out = tmux_command()
        .arg("rename-session")
        .arg("-t")
        .arg(current)
        .arg(next)
        .output()
        .await
        .context("invoking tmux rename-session")?;
    if !out.status.success() {
        return Err(anyhow!(
            "tmux rename-session failed ({}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

#[allow(dead_code)]
pub async fn has_session(session: &str) -> bool {
    tmux_command()
        .arg("has-session")
        .arg("-t")
        .arg(session)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

/// List existing tmux session names. Used to rediscover spawn agents after
/// a daemon restart.
///
/// `Ok(vec![])` means tmux answered and there are no sessions; `Err` means we
/// could not ask (spawn failure, or an unexpected tmux error). Callers must
/// not treat `Err` as "session gone" — under fd pressure or load, a transient
/// subprocess failure here used to make live agents report their tmux
/// session as lost.
pub async fn list_sessions() -> anyhow::Result<Vec<String>> {
    let out = tmux_command()
        .args(["list-sessions", "-F", "#{session_name}"])
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| anyhow::anyhow!("spawning tmux list-sessions: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        // "no server running" / "error connecting to ..." mean an honest
        // empty answer: the tmux server simply isn't up.
        if stderr.contains("no server running") || stderr.contains("error connecting to") {
            return Ok(Vec::new());
        }
        anyhow::bail!(
            "tmux list-sessions failed ({}): {}",
            out.status,
            stderr.trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect())
}

/// Read the current size of the session's first window. Returns None if the
/// session is gone or tmux output is unparseable.
pub async fn window_size(session: &str) -> Option<(u16, u16)> {
    let out = tmux_command()
        .args([
            "display-message",
            "-p",
            "-t",
            session,
            "-F",
            "#{window_width}x#{window_height}",
        ])
        .stdin(Stdio::null())
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let s = s.trim();
    let mut parts = s.split('x');
    let w: u16 = parts.next()?.parse().ok()?;
    let h: u16 = parts.next()?.parse().ok()?;
    Some((w, h))
}

/// Resize the tmux window. We ignore the result — if tmux is gone the PTY
/// will EOF anyway and the agent will be reported as exited.
pub async fn refresh_client(session: &str, cols: u16, rows: u16) {
    let _ = tmux_command()
        .args([
            "refresh-client",
            "-t",
            session,
            "-C",
            &format!("{cols}x{rows}"),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;
}

/// Scroll the first pane's tmux history for the session's attached client.
/// Negative lines scroll up into history; positive lines scroll back down
/// toward the live bottom. `copy-mode -e` mirrors tmux's wheel binding: it
/// enters copy mode for history browsing and exits again when scrolling back
/// to the bottom.
pub async fn scroll_history(session: &str, lines: i16) -> Result<()> {
    if lines == 0 {
        return Ok(());
    }

    let amount = lines.unsigned_abs().min(200).to_string();
    if lines < 0 {
        let scroll = run_tmux(["send-keys", "-t", session, "-X", "-N", &amount, "scroll-up"]).await;
        match scroll {
            Ok(()) => return Ok(()),
            Err(e) if !e.to_string().contains("not in a mode") => return Err(e),
            Err(_) => {}
        }
        run_tmux(["copy-mode", "-e", "-t", session]).await?;
        run_tmux(["send-keys", "-t", session, "-X", "-N", &amount, "scroll-up"]).await
    } else {
        let scroll = run_tmux([
            "send-keys",
            "-t",
            session,
            "-X",
            "-N",
            &amount,
            "scroll-down",
        ])
        .await;
        match scroll {
            Ok(()) => Ok(()),
            Err(e) if e.to_string().contains("not in a mode") => Ok(()),
            Err(e) => Err(e),
        }
    }
}

/// Capture the pane history as display-ready terminal text. This is used to
/// seed browser-local xterm scrollback on reconnect without entering tmux
/// copy-mode.
pub async fn capture_history(session: &str, lines: u16, styled: bool) -> Result<Vec<u8>> {
    let start = format!("-{}", lines.clamp(1, 10_000));
    let mut args = vec!["capture-pane"];
    if styled {
        // Styled snapshots need trailing cells: those blanks can carry
        // background resets/colors required to faithfully replay full-screen
        // terminal UIs into xterm.
        args.push("-e");
        args.push("-N");
    }
    args.extend(["-p", "-t", session, "-S", &start]);
    let out = tmux_command()
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .context("invoking tmux capture-pane")?;
    if !out.status.success() {
        return Err(anyhow!(
            "tmux capture-pane failed ({}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    let mut normalized = Vec::with_capacity(out.stdout.len() + 1024);
    for &byte in &out.stdout {
        if byte == b'\n' {
            normalized.extend_from_slice(b"\r\n");
        } else {
            normalized.push(byte);
        }
    }
    normalized.extend_from_slice(b"\x1b[0m");
    Ok(normalized)
}

/// Best-effort exit from copy-mode before injecting ordinary PTY input.
pub async fn cancel_copy_mode(session: &str) {
    let _ = run_tmux(["send-keys", "-t", session, "-X", "cancel"]).await;
}

/// Force tmux to repaint the whole client screen. Unlike re-applying the PTY
/// size (which only produces SIGWINCH — and therefore a repaint — when the
/// size actually CHANGES), this works unconditionally, which matters after a
/// browser refresh at unchanged geometry: the freshly-seeded xterm needs a
/// full repaint to restore cursor position and terminal modes.
pub async fn force_repaint(session: &str) {
    let _ = run_tmux(["refresh-client", "-t", session]).await;
}

/// Whether the session's active pane is in a mode (copy-mode etc.). Returns
/// None if tmux can't be queried.
pub async fn pane_in_mode(session: &str) -> Option<bool> {
    let out = tmux_command()
        .args([
            "display-message",
            "-p",
            "-t",
            session,
            "-F",
            "#{pane_in_mode}",
        ])
        .stdin(Stdio::null())
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim() == "1")
}

async fn run_tmux<const N: usize>(args: [&str; N]) -> Result<()> {
    let out = tmux_command()
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .await
        .context("invoking tmux")?;
    if out.status.success() {
        return Ok(());
    }
    Err(anyhow!(
        "tmux failed ({}): {}",
        out.status,
        String::from_utf8_lossy(&out.stderr).trim()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_session_label_is_shell_ergonomic() {
        assert_eq!(safe_session_label("  UI Work / Codex  "), "ui-work-codex");
        assert_eq!(safe_session_label("!!!"), "agent");
        assert_eq!(
            safe_session_label("dream - tiny_shakespeare.clm"),
            "dream-tiny_shakespeare.clm"
        );
    }

    #[test]
    fn session_name_keeps_label_and_uuid() {
        let id = Uuid::parse_str("00000000-0000-0000-0000-000000000001").unwrap();
        assert_eq!(
            session_name(id, Some("Palette")),
            "spawn-palette--00000000-0000-0000-0000-000000000001"
        );
    }

    #[test]
    fn agent_id_from_session_supports_new_and_legacy_names() {
        let id = Uuid::parse_str("00000000-0000-0000-0000-000000000001").unwrap();
        assert_eq!(agent_id_from_session(&legacy_session_name(id)), Some(id));
        assert_eq!(
            agent_id_from_session(&session_name(id, Some("UI Work"))),
            Some(id)
        );
        assert_eq!(agent_id_from_session("unrelated"), None);
        assert_eq!(
            agent_id_from_session("notes--00000000-0000-0000-0000-000000000001"),
            None
        );
    }

    #[test]
    fn agent_command_wraps_path_without_exposing_other_env() {
        let argv = vec![
            "codex".to_string(),
            "--model".to_string(),
            "gpt-5".to_string(),
        ];
        let mut env = BTreeMap::new();
        env.insert(
            "PATH".to_string(),
            "/home/oem/.nvm/versions/node/v20.20.2/bin:/usr/bin".to_string(),
        );
        env.insert("API_TOKEN".to_string(), "secret".to_string());

        assert_eq!(
            agent_command_args(&argv, &env),
            vec![
                "--",
                "/usr/bin/env",
                "PATH=/home/oem/.nvm/versions/node/v20.20.2/bin:/usr/bin",
                "codex",
                "--model",
                "gpt-5",
            ]
        );
    }

    #[test]
    fn agent_command_uses_argv_directly_without_path() {
        let argv = vec!["bash".to_string(), "-l".to_string()];
        assert_eq!(
            agent_command_args(&argv, &BTreeMap::new()),
            vec!["--", "bash", "-l"]
        );
    }
}
