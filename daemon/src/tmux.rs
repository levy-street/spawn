//! Thin wrapper around invoking the `tmux` binary. We deliberately keep this
//! crate-free of any tmux-control-mode complexity: we just shell out for
//! lifecycle ops (`new-session -d`, `kill-session`, `has-session`,
//! `refresh-client`).

use std::collections::BTreeMap;
use std::process::Stdio;

use anyhow::{anyhow, Context, Result};
use tokio::process::Command;

/// Returns the canonical tmux session name for an agent.
pub fn session_name(agent_id: uuid::Uuid) -> String {
    format!("spawn-{}", agent_id)
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

    let mut cmd = Command::new("tmux");
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

    cmd.arg("--");
    for a in argv {
        cmd.arg(a);
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

pub async fn kill_session(session: &str) -> Result<()> {
    let out = Command::new("tmux")
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

#[allow(dead_code)]
pub async fn has_session(session: &str) -> bool {
    Command::new("tmux")
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
pub async fn list_sessions() -> Vec<String> {
    let out = Command::new("tmux")
        .args(["list-sessions", "-F", "#{session_name}"])
        .stdin(Stdio::null())
        .output()
        .await;
    let Ok(out) = out else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Read the current size of the session's first window. Returns None if the
/// session is gone or tmux output is unparseable.
pub async fn window_size(session: &str) -> Option<(u16, u16)> {
    let out = Command::new("tmux")
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
    let _ = Command::new("tmux")
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
        args.push("-e");
    }
    args.extend(["-p", "-t", session, "-S", &start]);
    let out = Command::new("tmux")
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

async fn run_tmux<const N: usize>(args: [&str; N]) -> Result<()> {
    let out = Command::new("tmux")
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
