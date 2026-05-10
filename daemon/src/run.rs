//! `spawnd run` — foreground service loop. Connects WSS, registers, services
//! frames forever (with reconnect + exponential backoff).

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::{stream::FuturesUnordered, StreamExt};
use tokio::process::Command;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::agents::AgentRegistry;
use crate::cli::RunArgs;
use crate::config;
use crate::creds::{self, StoredCreds};
use crate::frames;
use crate::proto::{
    AgentCreate, HostDirEntry, HostToolInstallResult, HostToolStatus, HostToolTarget, Inbound,
    Outbound,
};
use crate::pty::{self, WsOutbound};
use crate::tmux;
use crate::upload;
use crate::ws::{self, WsInbound};

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const OUTBOUND_CHANNEL_DEPTH: usize = 1024;
const TOOL_VERSION_TIMEOUT: Duration = Duration::from_secs(5);
const TOOL_INSTALL_TIMEOUT: Duration = Duration::from_secs(180);
const TOOL_OUTPUT_LIMIT: usize = 16 * 1024;

pub async fn run(server_cli: Option<String>, _args: RunArgs) -> Result<()> {
    let stored = creds::load().context("loading stored credentials")?;
    if !stored.is_logged_in() {
        return Err(anyhow!("no daemon token; run `spawnd login` first"));
    }
    // Prefer the explicit --server flag, then $SPAWN_SERVER_URL (already
    // wired into clap), then the URL we logged in against.
    let server_url = match server_cli {
        Some(s) => config::server_url(Some(s))?,
        None => match stored.server_url.clone() {
            Some(s) => config::server_url(Some(s))?,
            None => config::server_url(None)?,
        },
    };
    let ws_url = config::ws_url(&server_url)?;

    let registry = AgentRegistry::new();

    // Ctrl-C handler closes the WS but does NOT kill agent tmux sessions —
    // that's the whole point of using tmux.
    let mut attempt: u32 = 0;

    loop {
        let session_fut = serve_one_connection(&stored, &ws_url, &registry);
        tokio::pin!(session_fut);

        let res = tokio::select! {
            r = &mut session_fut => r,
            r = tokio::signal::ctrl_c() => {
                r.context("ctrl-c handler")?;
                tracing::info!("Ctrl-C received; exiting (tmux sessions are preserved)");
                return Ok(());
            }
        };
        match res {
            Ok(()) => {
                tracing::info!("ws closed cleanly; reconnecting");
                attempt = 0;
            }
            Err(e) => {
                tracing::warn!(error = %e, "ws session ended with error");
                attempt = attempt.saturating_add(1);
            }
        }
        let delay = ws::backoff_for_attempt(attempt);
        tracing::info!(?delay, "reconnecting after backoff");
        let sleep_fut = tokio::time::sleep(delay);
        tokio::pin!(sleep_fut);
        tokio::select! {
            _ = &mut sleep_fut => {}
            r = tokio::signal::ctrl_c() => {
                r.context("ctrl-c handler")?;
                tracing::info!("Ctrl-C received; exiting (tmux sessions are preserved)");
                return Ok(());
            }
        }
    }
}

async fn serve_one_connection(
    stored: &StoredCreds,
    ws_url: &url::Url,
    registry: &AgentRegistry,
) -> Result<()> {
    let token = stored
        .access_token
        .as_deref()
        .ok_or_else(|| anyhow!("no access token"))?;

    let stream = ws::connect(ws_url, token).await?;
    tracing::info!(%ws_url, "ws connected");

    let (write_half, read_half) = stream.split();

    // mpsc that the dispatch loop and heartbeat task push outbound frames
    // into. Per-agent forwarder tasks ALSO ship into here, but indirectly:
    // each agent owns its own outbox and a long-lived forwarder task; we
    // install/clear this session's `out_tx` as the forwarder's "sink" on
    // connect/disconnect so reader threads survive WS reconnects.
    let (out_tx, out_rx) = mpsc::channel::<WsOutbound>(OUTBOUND_CHANNEL_DEPTH);

    // mpsc for inbound frames so we have a single dispatch loop.
    let (in_tx, mut in_rx) = mpsc::channel::<WsInbound>(256);

    let mut sender_task = tokio::spawn(ws::run_sender_loop(write_half, out_rx));
    let mut reader_task = tokio::spawn(ws::run_reader_loop(read_half, in_tx));

    // First WS session of this daemon process: scan tmux for live
    // `spawn-<uuid>` sessions left behind by a previous instance, reattach
    // a PTY reader to each, and surface them in `existing_agents`. This is
    // what makes daemon restart non-destructive.
    if registry.claim_discovery() {
        rediscover_existing_agents(registry, &out_tx).await;
    }

    // Install this session's sink for every agent's forwarder so PTY bytes
    // route here. (Reattach-discovered agents don't have a sink yet; agents
    // from prior WS sessions had a stale sink we need to overwrite.)
    install_session_sinks(registry, &out_tx).await;

    // Send `register`.
    let host_name = hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "unknown-host".into());

    let register = Outbound::Register {
        host_name,
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        home_dir: daemon_home_dir().map(|p| p.to_string_lossy().into_owned()),
        existing_agents: registry.ids(),
    };
    let register_json = serde_json::to_string(&register)?;
    out_tx
        .send(WsOutbound::Json(register_json))
        .await
        .map_err(|_| anyhow!("ws sender already closed"))?;

    // Heartbeat task: also functions as the keepalive. If the write side
    // can't reach the channel (sender_task died) we know the WS is dead.
    let hb_tx = out_tx.clone();
    let mut heartbeat_task = tokio::spawn(async move {
        let mut tick = tokio::time::interval(HEARTBEAT_INTERVAL);
        tick.tick().await; // consume the immediate first tick
        loop {
            tick.tick().await;
            let frame = match serde_json::to_string(&Outbound::HostHeartbeat) {
                Ok(s) => s,
                Err(_) => continue,
            };
            if hb_tx.send(WsOutbound::Json(frame)).await.is_err() {
                tracing::warn!("heartbeat send failed; ws likely dead");
                break;
            }
        }
    });

    // Race the dispatch loop against the IO tasks. Whichever finishes
    // first ends the session — this is what makes WS death reliably
    // visible even when the read-side EOF detection misbehaves at the
    // kernel/tungstenite layer. Scoped so `dispatch_fut`'s borrow of
    // `out_tx` releases before we drop it below.
    let dispatch_result = {
        let dispatch_fut = dispatch_loop(&mut in_rx, registry, &out_tx);
        tokio::pin!(dispatch_fut);
        tokio::select! {
            r = &mut dispatch_fut => r,
            _ = &mut sender_task => {
                tracing::info!("ws sender task ended (write error); ending session");
                Ok(())
            }
            _ = &mut reader_task => {
                tracing::info!("ws reader task ended; ending session");
                Ok(())
            }
            _ = &mut heartbeat_task => {
                tracing::info!("heartbeat task ended; ending session");
                Ok(())
            }
        }
    };

    // Tear down this session. Clearing the per-agent sinks first parks the
    // forwarders on `notified()` until the next session installs new ones —
    // PTY bytes accumulate in their outboxes in the meantime, so nothing is
    // lost. We just abort the IO tasks (rather than awaiting graceful exit)
    // because `stream_tx.close()` against a half-dead remote can hang on
    // the final TCP write, AND because the `select!` above may have already
    // consumed one task to completion (re-awaiting a finished JoinHandle
    // panics).
    clear_session_sinks(registry).await;
    heartbeat_task.abort();
    reader_task.abort();
    sender_task.abort();
    drop(out_tx);
    drop(sender_task);
    drop(reader_task);
    drop(heartbeat_task);
    dispatch_result
}

/// Install this WS session's outbound sender as the forwarder sink for
/// every agent currently in the registry, then nudge each PTY so tmux
/// re-emits the current screen into the freshly-connected pipeline. Without
/// the nudge, an idle agent would show as a blank screen until it next
/// emits a byte. Idempotent — replacing an existing sink is the intended
/// behavior on reconnect.
async fn install_session_sinks(registry: &AgentRegistry, out_tx: &mpsc::Sender<WsOutbound>) {
    for (_, control) in registry.snapshot_controls() {
        control.set_sink(out_tx.clone()).await;
    }
    // Snapshot ids and call nudge through the registry so we don't have to
    // reach into AgentHandle internals.
    for id in registry.ids() {
        registry.with_handle(id, |h| {
            if let Err(e) = h.nudge_redraw() {
                tracing::debug!(%id, error = %e, "nudge_redraw failed");
            }
        });
    }
}

/// Clear all forwarder sinks. Called when the session ends. Forwarders park
/// on `notified()` until a new session runs `install_session_sinks`.
async fn clear_session_sinks(registry: &AgentRegistry) {
    for (_, control) in registry.snapshot_controls() {
        control.clear_sink().await;
    }
}

async fn dispatch_loop(
    in_rx: &mut mpsc::Receiver<WsInbound>,
    registry: &AgentRegistry,
    out_tx: &mpsc::Sender<WsOutbound>,
) -> Result<()> {
    while let Some(msg) = in_rx.recv().await {
        match msg {
            WsInbound::Closed => return Ok(()),
            WsInbound::Json(frame) => match frame {
                Inbound::Registered { host_id } => {
                    tracing::info!(%host_id, "registered with server");
                }
                Inbound::HostHeartbeat => {
                    tracing::trace!("host heartbeat ack");
                }
                Inbound::HostFsList { request_id, path } => {
                    handle_host_fs_list(request_id, path, out_tx).await;
                }
                Inbound::HostToolsCheck {
                    request_id,
                    targets,
                } => {
                    handle_host_tools_check(request_id, targets, out_tx).await;
                }
                Inbound::HostToolsInstall { request_id, target } => {
                    handle_host_tools_install(request_id, target, out_tx).await;
                }
                Inbound::AgentCreate(create) => {
                    handle_agent_create(create, registry, out_tx).await;
                }
                Inbound::AgentRestart(create) => {
                    handle_agent_restart(create, registry, out_tx).await;
                }
                Inbound::AgentKill { agent_id, signal } => {
                    handle_agent_kill(agent_id, signal, registry).await;
                }
                Inbound::AgentResize {
                    agent_id,
                    cols,
                    rows,
                } => {
                    handle_agent_resize(agent_id, cols, rows, registry).await;
                }
                Inbound::AgentScroll { agent_id, lines } => {
                    handle_agent_scroll(agent_id, lines, registry).await;
                }
                Inbound::AgentSnapshot {
                    agent_id,
                    lines,
                    plain,
                } => {
                    handle_agent_snapshot(
                        agent_id,
                        lines.unwrap_or(5_000),
                        plain.unwrap_or(false),
                        registry,
                        out_tx,
                    )
                    .await;
                }
                Inbound::AgentRedraw { agent_id } => {
                    handle_agent_redraw(agent_id, registry).await;
                }
                Inbound::AgentUpload {
                    agent_id,
                    cwd,
                    name,
                    mime_type,
                    bytes_b64,
                    paste_prefix,
                    paste,
                    client_id,
                } => {
                    handle_agent_upload(
                        agent_id,
                        cwd,
                        name,
                        mime_type,
                        bytes_b64,
                        paste_prefix,
                        paste.unwrap_or(true),
                        client_id,
                        registry,
                        out_tx,
                    )
                    .await;
                }
            },
            WsInbound::Binary {
                kind,
                agent_id,
                payload,
            } => {
                if kind == frames::KIND_PTY_INPUT {
                    let session = tmux::session_name(agent_id);
                    tmux::cancel_copy_mode(&session).await;
                    let found = registry.with_handle(agent_id, |h| {
                        if let Err(e) = h.write_stdin(&payload) {
                            tracing::warn!(%agent_id, error = %e, "PTY stdin write failed");
                        }
                    });
                    if !found {
                        tracing::debug!(%agent_id, "ignoring stdin for unknown agent");
                    }
                } else {
                    tracing::debug!(kind, "ignoring unknown binary frame kind");
                }
            }
        }
    }
    Ok(())
}

async fn handle_host_fs_list(
    request_id: String,
    path: Option<String>,
    out_tx: &mpsc::Sender<WsOutbound>,
) {
    let home_dir = daemon_home_dir().map(|p| p.to_string_lossy().into_owned());
    let target = expand_host_path(path.as_deref().unwrap_or(""));
    let path_string = target.to_string_lossy().into_owned();
    let parent = target.parent().map(|p| p.to_string_lossy().into_owned());

    let mut entries = Vec::new();
    let mut error = None;
    match tokio::fs::read_dir(&target).await {
        Ok(mut dir) => loop {
            match dir.next_entry().await {
                Ok(Some(entry)) => {
                    let file_type = match entry.file_type().await {
                        Ok(t) => t,
                        Err(_) => continue,
                    };
                    if !file_type.is_dir() {
                        continue;
                    }
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if name == "." || name == ".." {
                        continue;
                    }
                    entries.push(HostDirEntry {
                        path: entry.path().to_string_lossy().into_owned(),
                        name,
                    });
                }
                Ok(None) => break,
                Err(e) => {
                    error = Some(e.to_string());
                    break;
                }
            }
        },
        Err(e) => {
            error = Some(e.to_string());
        }
    }

    entries.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.name.cmp(&b.name))
    });

    let frame = Outbound::HostFsListResult {
        request_id,
        path: path_string,
        home_dir,
        parent,
        entries,
        error,
    };
    if let Ok(s) = serde_json::to_string(&frame) {
        let _ = out_tx.send(WsOutbound::Json(s)).await;
    }
}

async fn handle_host_tools_check(
    request_id: String,
    targets: Vec<HostToolTarget>,
    out_tx: &mpsc::Sender<WsOutbound>,
) {
    let mut checks = FuturesUnordered::new();
    let target_count = targets.len();
    for (index, target) in targets.into_iter().enumerate() {
        checks.push(async move { (index, check_host_tool(target).await) });
    }

    let mut indexed_tools: Vec<Option<HostToolStatus>> =
        std::iter::repeat_with(|| None).take(target_count).collect();
    while let Some((index, tool)) = checks.next().await {
        if let Some(slot) = indexed_tools.get_mut(index) {
            *slot = Some(tool);
        }
    }
    let tools = indexed_tools.into_iter().flatten().collect();

    let frame = Outbound::HostToolsCheckResult { request_id, tools };
    if let Ok(s) = serde_json::to_string(&frame) {
        let _ = out_tx.send(WsOutbound::Json(s)).await;
    }
}

async fn handle_host_tools_install(
    request_id: String,
    target: HostToolTarget,
    out_tx: &mpsc::Sender<WsOutbound>,
) {
    let result = install_host_tool(target).await;
    let frame = Outbound::HostToolsInstallResult { request_id, result };
    if let Ok(s) = serde_json::to_string(&frame) {
        let _ = out_tx.send(WsOutbound::Json(s)).await;
    }
}

async fn check_host_tool(target: HostToolTarget) -> HostToolStatus {
    let command = target.command.trim().to_string();
    if command.is_empty() {
        return HostToolStatus {
            preset_id: target.preset_id,
            preset_name: target.preset_name,
            agent_kind: target.agent_kind,
            command,
            install: target.install,
            installed: false,
            path: None,
            version: None,
            latest_version: None,
            update_available: None,
            error: Some("preset argv has no executable".into()),
        };
    }

    let path = binary_path(&command).await;
    let Some(path) = path else {
        return HostToolStatus {
            preset_id: target.preset_id,
            preset_name: target.preset_name,
            agent_kind: target.agent_kind,
            command,
            install: target.install,
            installed: false,
            path: None,
            version: None,
            latest_version: None,
            update_available: None,
            error: None,
        };
    };

    let (version, error) = match read_tool_version(&command).await {
        Ok(version) => (version, None),
        Err(e) => (None, Some(format!("version check failed: {e:#}"))),
    };
    let latest_version = latest_tool_version(target.install.as_deref()).await;
    let update_available = match (version.as_deref(), latest_version.as_deref()) {
        (Some(installed), Some(latest)) => version_suggests_update(installed, latest),
        _ => None,
    };

    HostToolStatus {
        preset_id: target.preset_id,
        preset_name: target.preset_name,
        agent_kind: target.agent_kind,
        command,
        install: target.install,
        installed: true,
        path: Some(path),
        version,
        latest_version,
        update_available,
        error,
    }
}

async fn install_host_tool(target: HostToolTarget) -> HostToolInstallResult {
    let install = target.install.as_deref().unwrap_or("").trim().to_string();
    if install.is_empty() {
        return HostToolInstallResult {
            preset_id: target.preset_id,
            preset_name: target.preset_name,
            agent_kind: target.agent_kind,
            command: target.command,
            install: target.install,
            success: false,
            exit_code: None,
            output: String::new(),
            error: Some("preset has no install command".into()),
            status: None,
        };
    }

    let capture = run_shell_capture(&install, TOOL_INSTALL_TIMEOUT, TOOL_OUTPUT_LIMIT).await;
    let status = Some(check_host_tool(target.clone()).await);
    HostToolInstallResult {
        preset_id: target.preset_id,
        preset_name: target.preset_name,
        agent_kind: target.agent_kind,
        command: target.command,
        install: target.install,
        success: capture.success,
        exit_code: capture.exit_code,
        output: capture.output,
        error: capture.error,
        status,
    }
}

async fn binary_path(bin: &str) -> Option<String> {
    let output = Command::new("which")
        .arg(bin)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

async fn read_tool_version(command: &str) -> Result<Option<String>> {
    for args in [
        &["--version"][..],
        &["version"][..],
        &["-V"][..],
        &["-v"][..],
    ] {
        let capture = run_program_capture(command, args, TOOL_VERSION_TIMEOUT, 4096).await;
        if capture.success {
            if let Some(version) = first_meaningful_line(&capture.output) {
                return Ok(Some(version));
            }
        }
    }
    Ok(None)
}

async fn latest_tool_version(install: Option<&str>) -> Option<String> {
    let install = install?.trim();
    if install.is_empty() {
        return None;
    }

    if let Some(package) = npm_package_from_install_command(install) {
        let capture = run_program_capture(
            "npm",
            &["view", &package, "version"],
            TOOL_VERSION_TIMEOUT,
            4096,
        )
        .await;
        if capture.success {
            return first_meaningful_line(&capture.output);
        }
    }

    if let Some(package) = python_package_from_install_command(install) {
        let capture = run_program_capture(
            "python3",
            &["-m", "pip", "index", "versions", &package],
            TOOL_VERSION_TIMEOUT,
            4096,
        )
        .await;
        if capture.success {
            return parse_pip_latest_version(&package, &capture.output);
        }
    }

    None
}

fn npm_package_from_install_command(command: &str) -> Option<String> {
    let parts = shell_words(command);
    let npm_index = parts
        .iter()
        .position(|part| part == "npm" || part.ends_with("/npm"))?;
    let mut saw_install = false;
    let mut saw_global = false;
    for part in parts.iter().skip(npm_index + 1) {
        match part.as_str() {
            "install" | "i" => saw_install = true,
            "-g" | "--global" => saw_global = true,
            _ if saw_install && saw_global && !part.starts_with('-') => return Some(part.clone()),
            _ => {}
        }
    }
    None
}

fn python_package_from_install_command(command: &str) -> Option<String> {
    let parts = shell_words(command);
    for (idx, part) in parts.iter().enumerate() {
        if part != "pipx" && part != "pip" && !part.ends_with("/pip") && !part.ends_with("/pipx") {
            continue;
        }
        let mut saw_install = false;
        for next in parts.iter().skip(idx + 1) {
            match next.as_str() {
                "install" => saw_install = true,
                _ if saw_install && !next.starts_with('-') => return Some(next.clone()),
                _ => {}
            }
        }
    }
    None
}

fn shell_words(command: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;

    for ch in command.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
        } else if ch.is_whitespace() {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
        } else {
            current.push(ch);
        }
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

fn parse_pip_latest_version(package: &str, output: &str) -> Option<String> {
    let first = first_meaningful_line(output)?;
    let prefix = format!("{package} (");
    first
        .strip_prefix(&prefix)
        .and_then(|rest| rest.split(')').next())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

fn version_suggests_update(installed: &str, latest: &str) -> Option<bool> {
    let installed = numeric_version(installed)?;
    let latest = numeric_version(latest)?;
    Some(compare_versions(&installed, &latest) == std::cmp::Ordering::Less)
}

fn numeric_version(text: &str) -> Option<Vec<u64>> {
    let mut best: Vec<u64> = Vec::new();
    for raw in text.split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '.') {
        let candidate = raw.trim_start_matches('v');
        if !candidate
            .chars()
            .next()
            .map(|ch| ch.is_ascii_digit())
            .unwrap_or(false)
        {
            continue;
        }
        let parts: Vec<u64> = candidate
            .split('.')
            .take_while(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()))
            .filter_map(|part| part.parse::<u64>().ok())
            .collect();
        if parts.len() > best.len() {
            best = parts;
        }
    }
    if best.is_empty() {
        None
    } else {
        Some(best)
    }
}

fn compare_versions(left: &[u64], right: &[u64]) -> std::cmp::Ordering {
    let len = left.len().max(right.len());
    for idx in 0..len {
        let l = left.get(idx).copied().unwrap_or(0);
        let r = right.get(idx).copied().unwrap_or(0);
        match l.cmp(&r) {
            std::cmp::Ordering::Equal => continue,
            ordering => return ordering,
        }
    }
    std::cmp::Ordering::Equal
}

#[derive(Debug)]
struct CommandCapture {
    success: bool,
    exit_code: Option<i32>,
    output: String,
    error: Option<String>,
}

async fn run_program_capture(
    program: &str,
    args: &[&str],
    timeout: Duration,
    output_limit: usize,
) -> CommandCapture {
    let child = match Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            return CommandCapture {
                success: false,
                exit_code: None,
                output: String::new(),
                error: Some(e.to_string()),
            };
        }
    };

    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(output)) => CommandCapture {
            success: output.status.success(),
            exit_code: output.status.code(),
            output: combined_output(&output.stdout, &output.stderr, output_limit),
            error: None,
        },
        Ok(Err(e)) => CommandCapture {
            success: false,
            exit_code: None,
            output: String::new(),
            error: Some(e.to_string()),
        },
        Err(_) => CommandCapture {
            success: false,
            exit_code: None,
            output: String::new(),
            error: Some(format!("command timed out after {}s", timeout.as_secs())),
        },
    }
}

async fn run_shell_capture(
    command: &str,
    timeout: Duration,
    output_limit: usize,
) -> CommandCapture {
    let child = match Command::new("bash")
        .arg("-c")
        .arg(format!("{command} 2>&1"))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            return CommandCapture {
                success: false,
                exit_code: None,
                output: String::new(),
                error: Some(e.to_string()),
            };
        }
    };

    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(output)) => CommandCapture {
            success: output.status.success(),
            exit_code: output.status.code(),
            output: combined_output(&output.stdout, &output.stderr, output_limit),
            error: None,
        },
        Ok(Err(e)) => CommandCapture {
            success: false,
            exit_code: None,
            output: String::new(),
            error: Some(e.to_string()),
        },
        Err(_) => CommandCapture {
            success: false,
            exit_code: None,
            output: String::new(),
            error: Some(format!(
                "install command timed out after {}s",
                timeout.as_secs()
            )),
        },
    }
}

fn combined_output(stdout: &[u8], stderr: &[u8], limit: usize) -> String {
    let mut bytes = Vec::with_capacity(stdout.len() + stderr.len() + 1);
    bytes.extend_from_slice(stdout);
    if !stdout.is_empty() && !stderr.is_empty() {
        bytes.push(b'\n');
    }
    bytes.extend_from_slice(stderr);

    let (truncated, slice) = if bytes.len() > limit {
        (true, &bytes[bytes.len() - limit..])
    } else {
        (false, bytes.as_slice())
    };
    let text = String::from_utf8_lossy(slice).trim().to_string();
    if truncated {
        format!("[spawn] output truncated to last {limit} bytes\n{text}")
    } else {
        text
    }
}

fn first_meaningful_line(output: &str) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(240).collect())
}

async fn ensure_agent_cwd(
    agent_id: Uuid,
    cwd: &str,
    out_tx: &mpsc::Sender<WsOutbound>,
) -> Option<PathBuf> {
    let path = expand_host_path(cwd);
    match tokio::fs::create_dir_all(&path).await {
        Ok(()) => Some(path),
        Err(e) => {
            let msg = format!(
                "\r\n\x1b[31m[spawn] could not create cwd\x1b[0m\r\n\
                 [spawn] cwd: {}\r\n\
                 [spawn] {}\r\n",
                path.display(),
                e
            );
            send_pty_text(agent_id, out_tx, &msg).await;
            None
        }
    }
}

fn daemon_home_dir() -> Option<PathBuf> {
    dirs::home_dir().or_else(|| std::env::current_dir().ok())
}

fn expand_host_path(input: &str) -> PathBuf {
    let trimmed = input.trim();
    let home = daemon_home_dir();
    let path = if trimmed.is_empty() {
        home.unwrap_or_else(|| PathBuf::from("/"))
    } else if trimmed == "~" {
        home.unwrap_or_else(|| PathBuf::from(trimmed))
    } else if let Some(rest) = trimmed.strip_prefix("~/") {
        home.map(|h| h.join(rest))
            .unwrap_or_else(|| PathBuf::from(trimmed))
    } else {
        let path = Path::new(trimmed);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            home.unwrap_or_else(|| PathBuf::from("/")).join(path)
        }
    };
    lexical_normalize(path)
}

fn lexical_normalize(path: PathBuf) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(Path::new("/")),
            Component::CurDir => {}
            Component::ParentDir => {
                if normalized.as_os_str() != "/" && !normalized.pop() {
                    normalized.push("..");
                }
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    if normalized.as_os_str().is_empty() {
        PathBuf::from("/")
    } else {
        normalized
    }
}

async fn handle_agent_create(
    create: AgentCreate,
    registry: &AgentRegistry,
    out_tx: &mpsc::Sender<WsOutbound>,
) {
    let agent_id = create.agent_id;
    tracing::info!(%agent_id, argv = ?create.argv, "agent.create");

    // Build the env for the launched agent: the daemon's process env (so
    // HOME, XDG_CONFIG_HOME, PATH, etc. flow through naturally and the
    // agent CLI finds its own credentials), overlaid with any per-agent
    // env from the create frame. spawn does not inject credentials.
    let mut env: BTreeMap<String, String> = std::env::vars().collect();
    for (k, v) in &create.env {
        env.insert(k.clone(), v.clone());
    }

    // Pre-flight: if argv[0] isn't on PATH, try the install command (if any)
    // and stream its output into the agent's PTY so the user sees progress.
    let bin = create.argv.first().cloned().unwrap_or_default();
    if bin.is_empty() {
        send_pty_text(
            agent_id,
            out_tx,
            "\r\n\x1b[31m[spawn] argv is empty\x1b[0m\r\n",
        )
        .await;
        send_spawn_failed_exit(agent_id, out_tx, "empty argv").await;
        return;
    }
    if !binary_exists(&bin).await {
        match create.install.as_deref() {
            Some(install_cmd) if !install_cmd.trim().is_empty() => {
                let header = format!(
                    "\r\n\x1b[36m[spawn] {bin:?} not found in PATH; running install...\x1b[0m\r\n\
                     $ {install_cmd}\r\n"
                );
                send_pty_text(agent_id, out_tx, &header).await;
                let installed = run_install(agent_id, install_cmd, out_tx).await;
                if !installed {
                    send_spawn_failed_exit(agent_id, out_tx, "install failed").await;
                    return;
                }
                if !binary_exists(&bin).await {
                    let msg = format!(
                        "\x1b[31m[spawn] install completed but {bin:?} is still not on PATH. \
                         Check the install command for this preset.\x1b[0m\r\n"
                    );
                    send_pty_text(agent_id, out_tx, &msg).await;
                    send_spawn_failed_exit(agent_id, out_tx, "binary still missing").await;
                    return;
                }
                send_pty_text(
                    agent_id,
                    out_tx,
                    "\x1b[32m[spawn] install OK; launching agent...\x1b[0m\r\n",
                )
                .await;
            }
            _ => {
                let msg = format!(
                    "\r\n\x1b[31m[spawn] {bin:?} not found in PATH and no install command \
                     is configured for this preset. Install it manually on the host or set \
                     a preset install command.\x1b[0m\r\n"
                );
                send_pty_text(agent_id, out_tx, &msg).await;
                send_spawn_failed_exit(agent_id, out_tx, "binary not found, no install").await;
                return;
            }
        }
    }

    let launch_cwd = if create.create_cwd {
        match ensure_agent_cwd(agent_id, &create.cwd, out_tx).await {
            Some(path) => path,
            None => {
                send_spawn_failed_exit(agent_id, out_tx, "cwd create failed").await;
                return;
            }
        }
    } else {
        expand_host_path(&create.cwd)
    };
    let launch_cwd_str = launch_cwd.to_string_lossy().into_owned();

    // launch
    let launched_res = pty::launch(pty::LaunchSpec {
        agent_id,
        cwd: &launch_cwd_str,
        cols: create.cols,
        rows: create.rows,
        argv: &create.argv,
        env: &env,
    })
    .await;

    let launched = match launched_res {
        Ok(l) => l,
        Err(e) => {
            send_error(out_tx, Some(agent_id), "spawn_failed", &e).await;
            // Push the error text into the agent's PTY stream too, so it
            // shows up in the terminal view (otherwise users only see a
            // bare KILLED tile and have to chase logs).
            let msg = format!(
                "\r\n\x1b[31m[spawn] agent failed to start\x1b[0m\r\n\
                 [spawn] argv: {:?}\r\n\
                 [spawn] cwd:  {}\r\n\
                 [spawn] {}\r\n\
                 [spawn] hint: confirm the binary exists in the daemon's PATH \
                 and that running it manually doesn't error immediately.\r\n",
                create.argv, launch_cwd_str, e
            );
            let pty_frame = frames::encode_pty_output(agent_id, msg.as_bytes());
            let _ = out_tx.send(WsOutbound::Binary(pty_frame)).await;
            // Update UI status: starting → exited.
            let exit = Outbound::AgentExit {
                agent_id,
                exit_code: None,
                signal: Some(format!("spawn_failed: {e:#}")),
            };
            if let Ok(s) = serde_json::to_string(&exit) {
                let _ = out_tx.send(WsOutbound::Json(s)).await;
            }
            return;
        }
    };

    let pid = launched.pid;
    let exit_rx = launched.exit_rx;
    // Wire the new agent's forwarder to this session BEFORE inserting into
    // the registry — that way the first PTY bytes (tmux's initial pane draw)
    // route through cleanly instead of piling up in the outbox.
    launched.handle.control.set_sink(out_tx.clone()).await;
    let generation = registry.insert(launched.handle);

    // Tell server it's up.
    let started = Outbound::AgentStarted { agent_id, pid };
    let _ = out_tx
        .send(WsOutbound::Json(serde_json::to_string(&started).unwrap()))
        .await;

    // Await PTY exit and forward `agent.exit`.
    let registry = registry.clone();
    let out_tx = out_tx.clone();
    tokio::spawn(async move {
        let reason = exit_rx.await.unwrap_or(pty::ExitReason {
            exit_code: None,
            signal: None,
        });
        if registry
            .remove_if_generation(agent_id, generation)
            .is_none()
        {
            tracing::debug!(%agent_id, generation, "ignoring stale agent exit");
            return;
        }
        let exit = Outbound::AgentExit {
            agent_id,
            exit_code: reason.exit_code,
            signal: reason.signal,
        };
        if let Ok(s) = serde_json::to_string(&exit) {
            let _ = out_tx.send(WsOutbound::Json(s)).await;
        }
    });
}

async fn handle_agent_restart(
    create: AgentCreate,
    registry: &AgentRegistry,
    out_tx: &mpsc::Sender<WsOutbound>,
) {
    let agent_id = create.agent_id;
    let session = tmux::session_name(agent_id);
    tracing::info!(%agent_id, argv = ?create.argv, "agent.restart");

    // Remove the current handle before killing tmux. Its exit task will see
    // that its generation is no longer current and will not emit agent.exit.
    if let Some(handle) = registry.remove(agent_id) {
        handle.control.clear_sink().await;
    }
    if let Err(e) = tmux::kill_session(&session).await {
        tracing::debug!(%agent_id, error = %e, "tmux kill-session before restart");
    }

    for _ in 0..30 {
        if !tmux::has_session(&session).await {
            handle_agent_create(create, registry, out_tx).await;
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    send_pty_text(
        agent_id,
        out_tx,
        "\r\n\x1b[31m[spawn] restart failed: old tmux session did not exit\x1b[0m\r\n",
    )
    .await;
    send_spawn_failed_exit(agent_id, out_tx, "restart timeout").await;
}

async fn handle_agent_kill(agent_id: Uuid, _signal: Option<String>, registry: &AgentRegistry) {
    let session = tmux::session_name(agent_id);
    if let Err(e) = tmux::kill_session(&session).await {
        tracing::warn!(%agent_id, error = %e, "tmux kill-session failed");
    }
    // The PTY reader will see EOF and emit `agent.exit` itself. We do NOT
    // remove from the registry here — let the exit handler do it once it has
    // the exit code.
    let _ = registry.ids(); // satisfy borrow checker / placeholder
}

async fn handle_agent_resize(agent_id: Uuid, cols: u16, rows: u16, registry: &AgentRegistry) {
    // Resize the PTY first, then refresh tmux client.
    let found = registry.with_handle(agent_id, |h| {
        if let Err(e) = h.resize(cols, rows) {
            tracing::warn!(%agent_id, error = %e, "PTY resize failed");
        }
    });
    if !found {
        tracing::debug!(%agent_id, "ignoring resize for unknown agent");
        return;
    }
    let session = tmux::session_name(agent_id);
    tmux::refresh_client(&session, cols, rows).await;
}

async fn handle_agent_scroll(agent_id: Uuid, lines: i16, registry: &AgentRegistry) {
    if lines == 0 {
        return;
    }
    if !registry.contains(agent_id) {
        tracing::debug!(%agent_id, "ignoring scroll for unknown agent");
        return;
    }
    let session = tmux::session_name(agent_id);
    if let Err(e) = tmux::scroll_history(&session, lines).await {
        tracing::warn!(%agent_id, lines, error = %e, "tmux scroll failed");
    }
}

async fn handle_agent_snapshot(
    agent_id: Uuid,
    lines: u16,
    plain: bool,
    registry: &AgentRegistry,
    out_tx: &mpsc::Sender<WsOutbound>,
) {
    if !registry.contains(agent_id) {
        tracing::debug!(%agent_id, "ignoring snapshot for unknown agent");
        return;
    }
    let session = tmux::session_name(agent_id);
    match tmux::capture_history(&session, lines, !plain).await {
        Ok(bytes) => {
            let snapshot = Outbound::AgentSnapshot {
                agent_id,
                bytes_b64: STANDARD.encode(bytes),
            };
            if let Ok(s) = serde_json::to_string(&snapshot) {
                let _ = out_tx.send(WsOutbound::Json(s)).await;
            }
        }
        Err(e) => {
            tracing::warn!(%agent_id, error = %e, "tmux snapshot failed");
            send_error(out_tx, Some(agent_id), "snapshot_failed", &e).await;
        }
    }
}

async fn handle_agent_redraw(agent_id: Uuid, registry: &AgentRegistry) {
    let found = registry.with_handle(agent_id, |h| {
        if let Err(e) = h.nudge_redraw() {
            tracing::debug!(%agent_id, error = %e, "nudge_redraw failed");
        }
    });
    if !found {
        tracing::debug!(%agent_id, "ignoring redraw for unknown agent");
    }
}

async fn handle_agent_upload(
    agent_id: Uuid,
    cwd: String,
    name: String,
    mime_type: String,
    bytes_b64: String,
    paste_prefix: Option<String>,
    paste: bool,
    client_id: Option<String>,
    registry: &AgentRegistry,
    out_tx: &mpsc::Sender<WsOutbound>,
) {
    if !registry.contains(agent_id) {
        tracing::debug!(%agent_id, "ignoring upload for unknown agent");
        return;
    }

    match upload::save_image_upload(&cwd, &name, &mime_type, &bytes_b64).await {
        Ok(path) => {
            if paste {
                let paste_text = upload::paste_text_for_path(&cwd, &path, paste_prefix.as_deref());
                let session = tmux::session_name(agent_id);
                tmux::cancel_copy_mode(&session).await;
                let found = registry.with_handle(agent_id, |h| {
                    if let Err(e) = h.write_stdin(paste_text.as_bytes()) {
                        tracing::warn!(%agent_id, error = %e, "PTY upload path paste failed");
                    }
                });
                if !found {
                    tracing::debug!(%agent_id, "agent disappeared before upload paste");
                }
            }
            let uploaded = Outbound::AgentUploaded {
                agent_id,
                path: path.to_string_lossy().into_owned(),
                client_id,
            };
            if let Ok(s) = serde_json::to_string(&uploaded) {
                let _ = out_tx.send(WsOutbound::Json(s)).await;
            }
            tracing::info!(%agent_id, path = %path.display(), "image upload saved");
        }
        Err(e) => {
            tracing::warn!(%agent_id, error = %e, "image upload failed");
            send_error(out_tx, Some(agent_id), "upload_failed", &e).await;
        }
    }
}

async fn send_error(
    out_tx: &mpsc::Sender<WsOutbound>,
    agent_id: Option<Uuid>,
    code: &str,
    err: &anyhow::Error,
) {
    let frame = Outbound::Error {
        agent_id,
        code: code.into(),
        message: format!("{err:#}"),
    };
    if let Ok(s) = serde_json::to_string(&frame) {
        let _ = out_tx.send(WsOutbound::Json(s)).await;
    }
    tracing::warn!(?agent_id, code, error = %err, "sent error frame");
}

/// Emit a string as a PTY-output frame so it shows up in the user's terminal.
async fn send_pty_text(agent_id: Uuid, out_tx: &mpsc::Sender<WsOutbound>, text: &str) {
    let frame = frames::encode_pty_output(agent_id, text.as_bytes());
    let _ = out_tx.send(WsOutbound::Binary(frame)).await;
}

async fn send_spawn_failed_exit(agent_id: Uuid, out_tx: &mpsc::Sender<WsOutbound>, reason: &str) {
    let exit = Outbound::AgentExit {
        agent_id,
        exit_code: None,
        signal: Some(format!("spawn_failed: {reason}")),
    };
    if let Ok(s) = serde_json::to_string(&exit) {
        let _ = out_tx.send(WsOutbound::Json(s)).await;
    }
}

/// On daemon startup, discover tmux sessions matching `spawn-<uuid>` left
/// behind by a previous instance and reattach to each. Inserts handles into
/// the registry and spawns the await-exit task per agent.
async fn rediscover_existing_agents(registry: &AgentRegistry, out_tx: &mpsc::Sender<WsOutbound>) {
    let sessions = tmux::list_sessions().await;
    for name in sessions {
        let Some(suffix) = name.strip_prefix("spawn-") else {
            continue;
        };
        let Ok(agent_id) = Uuid::parse_str(suffix) else {
            continue;
        };
        if registry.contains(agent_id) {
            continue; // shouldn't happen on a fresh process, but be safe
        }
        match pty::reattach(agent_id).await {
            Ok(launched) => {
                let exit_rx = launched.exit_rx;
                // Wire the rediscovered agent's forwarder to this session.
                launched.handle.control.set_sink(out_tx.clone()).await;
                let generation = registry.insert(launched.handle);
                let registry_clone = registry.clone();
                let out_tx_clone = out_tx.clone();
                tokio::spawn(async move {
                    let reason = exit_rx.await.unwrap_or(pty::ExitReason {
                        exit_code: None,
                        signal: None,
                    });
                    if registry_clone
                        .remove_if_generation(agent_id, generation)
                        .is_none()
                    {
                        tracing::debug!(%agent_id, generation, "ignoring stale agent exit");
                        return;
                    }
                    let exit = Outbound::AgentExit {
                        agent_id,
                        exit_code: reason.exit_code,
                        signal: reason.signal,
                    };
                    if let Ok(s) = serde_json::to_string(&exit) {
                        let _ = out_tx_clone.send(WsOutbound::Json(s)).await;
                    }
                });
                tracing::info!(%agent_id, "rediscovered existing agent");
            }
            Err(e) => {
                tracing::warn!(%agent_id, error = %e, "failed to reattach to existing tmux session");
            }
        }
    }
}

/// Returns true if `bin` resolves to something on PATH.
async fn binary_exists(bin: &str) -> bool {
    tokio::process::Command::new("which")
        .arg(bin)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Run `bash -c "<install_cmd> 2>&1"` and stream stdout into the agent's PTY
/// frame channel. Returns true on a successful exit status.
async fn run_install(agent_id: Uuid, install_cmd: &str, out_tx: &mpsc::Sender<WsOutbound>) -> bool {
    use tokio::io::AsyncReadExt;

    let mut child = match tokio::process::Command::new("bash")
        .arg("-c")
        .arg(format!("{install_cmd} 2>&1"))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            send_pty_text(
                agent_id,
                out_tx,
                &format!("\x1b[31m[spawn] failed to spawn install: {e}\x1b[0m\r\n"),
            )
            .await;
            return false;
        }
    };

    if let Some(mut stdout) = child.stdout.take() {
        let mut buf = vec![0u8; 4096];
        loop {
            match stdout.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    // Convert bare \n to \r\n so xterm renders lines correctly.
                    let mut converted = Vec::with_capacity(n + n / 4);
                    let mut prev = 0u8;
                    for &b in &buf[..n] {
                        if b == b'\n' && prev != b'\r' {
                            converted.push(b'\r');
                        }
                        converted.push(b);
                        prev = b;
                    }
                    let frame = frames::encode_pty_output(agent_id, &converted);
                    if out_tx.send(WsOutbound::Binary(frame)).await.is_err() {
                        break;
                    }
                }
                Err(e) => {
                    send_pty_text(
                        agent_id,
                        out_tx,
                        &format!("\x1b[31m[spawn] install read error: {e}\x1b[0m\r\n"),
                    )
                    .await;
                    break;
                }
            }
        }
    }

    match child.wait().await {
        Ok(s) if s.success() => true,
        Ok(s) => {
            let code = s
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "?".into());
            send_pty_text(
                agent_id,
                out_tx,
                &format!("\x1b[31m[spawn] install exited with status {code}\x1b[0m\r\n"),
            )
            .await;
            false
        }
        Err(e) => {
            send_pty_text(
                agent_id,
                out_tx,
                &format!("\x1b[31m[spawn] install wait error: {e}\x1b[0m\r\n"),
            )
            .await;
            false
        }
    }
}
