//! `spawnd run` — foreground service loop. Connects WSS, registers, services
//! frames forever (with reconnect + exponential backoff).

use std::collections::{BTreeMap, HashSet};
use std::fs;
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
use crate::rtc::{HostRtcSignal, RtcSessions};
use crate::upload;
use crate::worker_backend;
use crate::ws::{self, WsInbound};

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const OUTBOUND_CHANNEL_DEPTH: usize = 1024;
const TOOL_VERSION_TIMEOUT: Duration = Duration::from_secs(5);
const TOOL_INSTALL_TIMEOUT: Duration = Duration::from_secs(180);
const TOOL_OUTPUT_LIMIT: usize = 16 * 1024;
const SHELL_PATH_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

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
    let rtc_sessions = RtcSessions::new();
    if let Some(host_id) = stored.host_id {
        let _ = rtc_sessions.bind_registered_host_id(host_id).await;
    }

    // Ctrl-C closes only this supervisor. Session workers remain alive and
    // are adopted by the next `spawnd` process.
    let mut attempt: u32 = 0;

    loop {
        let session_fut = serve_one_connection(&stored, &ws_url, &registry, &rtc_sessions);
        tokio::pin!(session_fut);

        let res = tokio::select! {
            r = &mut session_fut => r,
            r = tokio::signal::ctrl_c() => {
                r.context("ctrl-c handler")?;
                tracing::info!("Ctrl-C received; exiting (session workers are preserved)");
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
                tracing::info!("Ctrl-C received; exiting (session workers are preserved)");
                return Ok(());
            }
        }
    }
}

async fn serve_one_connection(
    stored: &StoredCreds,
    ws_url: &url::Url,
    registry: &AgentRegistry,
    rtc_sessions: &RtcSessions,
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

    // First WS session of this daemon process: scan for live session workers
    // left behind by a previous instance, adopt each, and surface them in
    // `existing_agents`. This makes daemon restart non-destructive.
    if registry.claim_discovery() {
        rediscover_existing_agents(registry, rtc_sessions, &out_tx).await;
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
        let dispatch_fut = dispatch_loop(&mut in_rx, registry, rtc_sessions, &out_tx);
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

    // Tear down this session. Clearing the per-agent sinks first stops the
    // legacy mirror; forwarders continue draining bounded worker output into
    // direct viewers, and a reconnect catches up from worker replay. We just
    // abort the IO tasks (rather than awaiting graceful exit)
    // because `stream_tx.close()` against a half-dead remote can hang on
    // the final TCP write, AND because the `select!` above may have already
    // consumed one task to completion (re-awaiting a finished JoinHandle
    // panics).
    clear_session_sinks(registry).await;
    rtc_sessions.close_all().await;
    heartbeat_task.abort();
    reader_task.abort();
    sender_task.abort();
    drop(out_tx);
    drop(sender_task);
    drop(reader_task);
    drop(heartbeat_task);
    dispatch_result
}

/// Install this WS session's outbound sender as the forwarder sink for every
/// agent currently in the registry. Browser reconnects request a checkpoint
/// replay from the owning worker, so no daemon-side repaint is needed.
async fn install_session_sinks(registry: &AgentRegistry, out_tx: &mpsc::Sender<WsOutbound>) {
    for (_, control) in registry.snapshot_controls() {
        control.set_sink(out_tx.clone()).await;
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
    rtc_sessions: &RtcSessions,
    out_tx: &mpsc::Sender<WsOutbound>,
) -> Result<()> {
    while let Some(msg) = in_rx.recv().await {
        match msg {
            WsInbound::Closed => return Ok(()),
            WsInbound::Json(frame) => match frame {
                Inbound::Registered { host_id } => {
                    if !rtc_sessions.bind_registered_host_id(host_id).await {
                        return Err(anyhow!("server registered daemon as an unexpected host"));
                    }
                    tracing::info!(%host_id, "registered with server");
                }
                Inbound::HostHeartbeat => {
                    tracing::trace!("host heartbeat ack");
                }
                Inbound::HostFsList {
                    request_id,
                    path,
                    include_files,
                } => {
                    handle_host_fs_list(request_id, path, include_files, out_tx).await;
                }
                Inbound::HostFsRead { request_id, path } => {
                    let out_tx = out_tx.clone();
                    tokio::spawn(async move {
                        handle_host_fs_read(request_id, path, &out_tx).await;
                    });
                }
                Inbound::HostFsWrite {
                    request_id,
                    dir,
                    name,
                    bytes_b64,
                    overwrite,
                } => {
                    let out_tx = out_tx.clone();
                    tokio::spawn(async move {
                        handle_host_fs_write(request_id, dir, name, bytes_b64, overwrite, &out_tx)
                            .await;
                    });
                }
                Inbound::HostFsMkdir { request_id, path } => {
                    handle_host_fs_mkdir(request_id, path, out_tx).await;
                }
                Inbound::HostFsRemove {
                    request_id,
                    path,
                    recursive,
                } => {
                    handle_host_fs_remove(request_id, path, recursive, out_tx).await;
                }
                Inbound::HostFsRename {
                    request_id,
                    path,
                    name,
                } => {
                    handle_host_fs_rename(request_id, path, name, out_tx).await;
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
                    handle_agent_create(create, registry, rtc_sessions, out_tx).await;
                }
                Inbound::AgentRestart(create) => {
                    handle_agent_restart(create, registry, rtc_sessions, out_tx).await;
                }
                Inbound::AgentKill { agent_id, signal } => {
                    handle_agent_kill(agent_id, signal, registry, rtc_sessions, out_tx).await;
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
                    request_id,
                    lines,
                    plain,
                    rtc_session_id,
                } => {
                    // Captures can take a while on deep panes; run them off
                    // the dispatch loop so queued stdin frames aren't delayed
                    // behind them.
                    let registry = registry.clone();
                    let rtc_sessions = rtc_sessions.clone();
                    let out_tx = out_tx.clone();
                    tokio::spawn(async move {
                        handle_agent_snapshot(
                            agent_id,
                            SnapshotRequest {
                                request_id,
                                lines: lines.unwrap_or(5_000),
                                plain: plain.unwrap_or(false),
                                rtc_session_id,
                            },
                            &registry,
                            &rtc_sessions,
                            &out_tx,
                        )
                        .await;
                    });
                }
                Inbound::AgentRedraw { agent_id } => {
                    handle_agent_redraw(agent_id, registry).await;
                }
                Inbound::AgentUpload {
                    agent_id,
                    request_id,
                    cwd,
                    name,
                    mime_type,
                    bytes_b64,
                    paste_prefix,
                    paste,
                    destination,
                    client_id,
                } => {
                    handle_agent_upload(
                        agent_id,
                        request_id,
                        cwd,
                        name,
                        mime_type,
                        bytes_b64,
                        paste_prefix,
                        paste.unwrap_or(true),
                        destination,
                        client_id,
                        registry,
                        rtc_sessions,
                        out_tx,
                    )
                    .await;
                }
                Inbound::RtcOffer {
                    session_id,
                    generation,
                    binding_nonce,
                    binding_generation,
                    agent_id,
                    scope_type,
                    scope_id,
                    protocol,
                    protocol_version,
                    sdp,
                    ice_servers,
                    ice_transport_policy,
                } => {
                    match (
                        generation,
                        binding_nonce,
                        binding_generation,
                        agent_id,
                        scope_type,
                        scope_id,
                        protocol,
                        protocol_version,
                    ) {
                        (
                            None,
                            Some(nonce),
                            Some(owner_generation),
                            Some(agent_id),
                            None,
                            None,
                            None,
                            None,
                        ) => {
                            if ice_transport_policy.is_none() {
                                if let Some(binding) = crate::rtc::RtcSessionBinding::from_server(
                                    session_id,
                                    nonce,
                                    owner_generation,
                                    agent_id,
                                ) {
                                    rtc_sessions
                                        .handle_offer(
                                            binding,
                                            sdp,
                                            ice_servers,
                                            registry.clone(),
                                            out_tx.clone(),
                                        )
                                        .await;
                                }
                            }
                        }
                        (Some(generation), None, None, Some(agent_id), None, None, None, None) => {
                            if ice_transport_policy.is_none() {
                                if let Some(binding) = crate::rtc::RtcSessionBinding::from_legacy(
                                    session_id, generation, agent_id,
                                ) {
                                    rtc_sessions
                                        .handle_offer(
                                            binding,
                                            sdp,
                                            ice_servers,
                                            registry.clone(),
                                            out_tx.clone(),
                                        )
                                        .await;
                                }
                            }
                        }
                        (
                            None,
                            Some(binding_nonce),
                            None,
                            None,
                            scope_type,
                            scope_id,
                            protocol,
                            protocol_version,
                        ) => {
                            rtc_sessions
                                .handle_host_offer(
                                    HostRtcSignal {
                                        session_id,
                                        binding_nonce: Some(binding_nonce),
                                        scope_type,
                                        scope_id,
                                        protocol,
                                        protocol_version,
                                    },
                                    sdp,
                                    ice_servers,
                                    ice_transport_policy,
                                    out_tx.clone(),
                                )
                                .await;
                        }
                        _ => tracing::warn!("rejecting malformed mixed-scope rtc offer"),
                    }
                }
                Inbound::RtcCandidate {
                    session_id,
                    generation,
                    binding_nonce,
                    binding_generation,
                    agent_id,
                    scope_type,
                    scope_id,
                    protocol,
                    protocol_version,
                    candidate,
                } => {
                    match (
                        generation,
                        binding_nonce,
                        binding_generation,
                        agent_id,
                        scope_type,
                        scope_id,
                        protocol,
                        protocol_version,
                    ) {
                        (
                            None,
                            Some(nonce),
                            Some(owner_generation),
                            Some(agent_id),
                            None,
                            None,
                            None,
                            None,
                        ) => {
                            if let Some(binding) = crate::rtc::RtcSessionBinding::from_server(
                                session_id,
                                nonce,
                                owner_generation,
                                agent_id,
                            ) {
                                let (session_id, generation, agent_id) =
                                    binding.into_routing_parts();
                                rtc_sessions
                                    .handle_candidate(session_id, generation, agent_id, candidate)
                                    .await;
                            }
                        }
                        (Some(generation), None, None, Some(agent_id), None, None, None, None) => {
                            if let Some(binding) = crate::rtc::RtcSessionBinding::from_legacy(
                                session_id, generation, agent_id,
                            ) {
                                let (session_id, generation, agent_id) =
                                    binding.into_routing_parts();
                                rtc_sessions
                                    .handle_candidate(session_id, generation, agent_id, candidate)
                                    .await;
                            }
                        }
                        (
                            None,
                            Some(binding_nonce),
                            None,
                            None,
                            scope_type,
                            scope_id,
                            protocol,
                            protocol_version,
                        ) => {
                            rtc_sessions
                                .handle_host_candidate(
                                    HostRtcSignal {
                                        session_id,
                                        binding_nonce: Some(binding_nonce),
                                        scope_type,
                                        scope_id,
                                        protocol,
                                        protocol_version,
                                    },
                                    candidate,
                                )
                                .await;
                        }
                        _ => tracing::warn!("rejecting malformed mixed-scope rtc candidate"),
                    }
                }
                Inbound::RtcClose {
                    session_id,
                    generation,
                    binding_nonce,
                    binding_generation,
                    agent_id,
                    scope_type,
                    scope_id,
                    protocol,
                    protocol_version,
                } => {
                    match (
                        generation,
                        binding_nonce,
                        binding_generation,
                        agent_id,
                        scope_type,
                        scope_id,
                        protocol,
                        protocol_version,
                    ) {
                        (
                            None,
                            Some(nonce),
                            Some(owner_generation),
                            Some(agent_id),
                            None,
                            None,
                            None,
                            None,
                        ) => {
                            if let Some(binding) = crate::rtc::RtcSessionBinding::from_server(
                                session_id,
                                nonce,
                                owner_generation,
                                agent_id,
                            ) {
                                let (session_id, generation, agent_id) =
                                    binding.into_routing_parts();
                                rtc_sessions.close(&session_id, &generation, agent_id).await;
                            }
                        }
                        (Some(generation), None, None, Some(agent_id), None, None, None, None) => {
                            if let Some(binding) = crate::rtc::RtcSessionBinding::from_legacy(
                                session_id, generation, agent_id,
                            ) {
                                let (session_id, generation, agent_id) =
                                    binding.into_routing_parts();
                                rtc_sessions.close(&session_id, &generation, agent_id).await;
                            }
                        }
                        (
                            None,
                            Some(binding_nonce),
                            None,
                            None,
                            scope_type,
                            scope_id,
                            protocol,
                            protocol_version,
                        ) => {
                            rtc_sessions
                                .close_host(HostRtcSignal {
                                    session_id,
                                    binding_nonce: Some(binding_nonce),
                                    scope_type,
                                    scope_id,
                                    protocol,
                                    protocol_version,
                                })
                                .await;
                        }
                        _ => tracing::warn!("rejecting malformed mixed-scope rtc close"),
                    }
                }
            },
            WsInbound::Binary {
                kind,
                agent_id,
                payload,
            } => {
                if kind == frames::KIND_PTY_INPUT {
                    if !registry.contains(agent_id) {
                        let _ =
                            ensure_agent_attached(agent_id, registry, rtc_sessions, out_tx).await;
                    }
                    let input = payload.copy_to_direct();
                    let found = registry.with_handle(agent_id, |h| {
                        if let Err(e) = h.write_stdin_owned(input) {
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
    include_files: bool,
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
                    let is_dir = file_type.is_dir();
                    if !is_dir && !include_files {
                        continue;
                    }
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if name == "." || name == ".." {
                        continue;
                    }
                    let metadata = entry.metadata().await.ok();
                    entries.push(HostDirEntry {
                        path: entry.path().to_string_lossy().into_owned(),
                        name,
                        is_dir: Some(is_dir),
                        size: metadata.as_ref().filter(|_| !is_dir).map(|m| m.len()),
                        modified_at: metadata
                            .as_ref()
                            .and_then(|m| m.modified().ok())
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs() as i64),
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
        let a_dir = a.is_dir.unwrap_or(false);
        let b_dir = b.is_dir.unwrap_or(false);
        b_dir
            .cmp(&a_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
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

async fn send_fs_op_result(
    request_id: String,
    path: Option<String>,
    error: Option<String>,
    out_tx: &mpsc::Sender<WsOutbound>,
) {
    let frame = Outbound::HostFsOpResult {
        request_id,
        path,
        error,
    };
    if let Ok(s) = serde_json::to_string(&frame) {
        let _ = out_tx.send(WsOutbound::Json(s)).await;
    }
}

async fn handle_host_fs_read(request_id: String, path: String, out_tx: &mpsc::Sender<WsOutbound>) {
    let target = expand_host_path(&path);
    let path_string = target.to_string_lossy().into_owned();
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned());

    let read = async {
        let metadata = tokio::fs::metadata(&target)
            .await
            .with_context(|| format!("reading metadata for {}", target.display()))?;
        if !metadata.is_file() {
            anyhow::bail!("not a regular file");
        }
        if metadata.len() as usize > upload::MAX_FS_BYTES {
            anyhow::bail!("file exceeds 32 MB download limit");
        }
        let bytes = tokio::fs::read(&target)
            .await
            .with_context(|| format!("reading {}", target.display()))?;
        Ok::<_, anyhow::Error>((metadata.len(), STANDARD.encode(&bytes)))
    }
    .await;

    let frame = match read {
        Ok((size, bytes_b64)) => Outbound::HostFsReadResult {
            request_id,
            path: path_string,
            name,
            size: Some(size),
            bytes_b64: Some(bytes_b64),
            error: None,
        },
        Err(e) => Outbound::HostFsReadResult {
            request_id,
            path: path_string,
            name,
            size: None,
            bytes_b64: None,
            error: Some(e.to_string()),
        },
    };
    if let Ok(s) = serde_json::to_string(&frame) {
        let _ = out_tx.send(WsOutbound::Json(s)).await;
    }
}

async fn handle_host_fs_write(
    request_id: String,
    dir: String,
    name: String,
    bytes_b64: String,
    overwrite: bool,
    out_tx: &mpsc::Sender<WsOutbound>,
) {
    let target_dir = expand_host_path(&dir);
    let write = async {
        let bytes = STANDARD
            .decode(bytes_b64.as_bytes())
            .context("decoding file payload")?;
        upload::save_file_in_dir(&target_dir, &name, &bytes, overwrite).await
    }
    .await;

    match write {
        Ok(path) => {
            send_fs_op_result(
                request_id,
                Some(path.to_string_lossy().into_owned()),
                None,
                out_tx,
            )
            .await;
        }
        Err(e) => {
            send_fs_op_result(request_id, None, Some(e.to_string()), out_tx).await;
        }
    }
}

async fn handle_host_fs_mkdir(request_id: String, path: String, out_tx: &mpsc::Sender<WsOutbound>) {
    let target = expand_host_path(&path);
    let path_string = target.to_string_lossy().into_owned();
    match tokio::fs::create_dir_all(&target).await {
        Ok(()) => send_fs_op_result(request_id, Some(path_string), None, out_tx).await,
        Err(e) => {
            send_fs_op_result(request_id, Some(path_string), Some(e.to_string()), out_tx).await
        }
    }
}

async fn handle_host_fs_remove(
    request_id: String,
    path: String,
    recursive: bool,
    out_tx: &mpsc::Sender<WsOutbound>,
) {
    let target = expand_host_path(&path);
    let path_string = target.to_string_lossy().into_owned();

    let remove = async {
        if target == Path::new("/") || Some(&target) == daemon_home_dir().as_ref() {
            anyhow::bail!("refusing to remove {}", target.display());
        }
        let metadata = tokio::fs::symlink_metadata(&target)
            .await
            .with_context(|| format!("reading metadata for {}", target.display()))?;
        if metadata.is_dir() {
            if recursive {
                tokio::fs::remove_dir_all(&target).await
            } else {
                tokio::fs::remove_dir(&target).await
            }
            .with_context(|| format!("removing directory {}", target.display()))?;
        } else {
            tokio::fs::remove_file(&target)
                .await
                .with_context(|| format!("removing {}", target.display()))?;
        }
        Ok::<_, anyhow::Error>(())
    }
    .await;

    match remove {
        Ok(()) => send_fs_op_result(request_id, Some(path_string), None, out_tx).await,
        Err(e) => {
            send_fs_op_result(request_id, Some(path_string), Some(e.to_string()), out_tx).await
        }
    }
}

async fn handle_host_fs_rename(
    request_id: String,
    path: String,
    name: String,
    out_tx: &mpsc::Sender<WsOutbound>,
) {
    let source = expand_host_path(&path);

    let rename = async {
        let name = name.trim();
        if name.is_empty() || name.len() > 255 || name == "." || name == ".." {
            anyhow::bail!("invalid name");
        }
        if name.contains(['/', '\\']) || name.chars().any(char::is_control) {
            anyhow::bail!("name cannot contain path separators");
        }
        if source == Path::new("/") || Some(&source) == daemon_home_dir().as_ref() {
            anyhow::bail!("refusing to rename {}", source.display());
        }
        let parent = source
            .parent()
            .ok_or_else(|| anyhow!("cannot rename {}", source.display()))?;
        let target = parent.join(name);
        if target == source {
            return Ok(target);
        }
        if tokio::fs::try_exists(&target)
            .await
            .with_context(|| format!("checking {}", target.display()))?
        {
            anyhow::bail!("{name} already exists");
        }
        tokio::fs::rename(&source, &target)
            .await
            .with_context(|| format!("renaming {}", source.display()))?;
        Ok::<_, anyhow::Error>(target)
    }
    .await;

    match rename {
        Ok(target) => {
            send_fs_op_result(
                request_id,
                Some(target.to_string_lossy().into_owned()),
                None,
                out_tx,
            )
            .await;
        }
        Err(e) => send_fs_op_result(request_id, None, Some(e.to_string()), out_tx).await,
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

    let env = resolved_command_env().await;
    let path = binary_path(&command, &env).await;
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

    let (version, error) = match read_tool_version(&command, &env).await {
        Ok(version) => (version, None),
        Err(e) => (None, Some(format!("version check failed: {e:#}"))),
    };
    let latest_version = latest_tool_version(target.install.as_deref(), &env).await;
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

/// Self-update subcommand for tools whose own updater targets the
/// installation PATH actually resolves — install scripts often manage a
/// different copy (e.g. `npm install -g` under nvm while PATH serves the
/// native installer's binary), which "succeeds" without changing anything.
fn self_update_args(agent_kind: &str) -> Option<&'static [&'static str]> {
    match agent_kind {
        "claude-code" => Some(&["update"]),
        _ => None,
    }
}

/// Decide the honest outcome of an update attempt: a script can exit 0 while
/// the version PATH serves never changes (shadowed install). Demote that to
/// an explicit failure so the auto-update loop surfaces it instead of
/// silently retrying forever.
fn update_outcome(
    version_before: Option<&str>,
    status: Option<&HostToolStatus>,
    script_success: bool,
    script_error: Option<String>,
) -> (bool, Option<String>) {
    if !script_success {
        return (false, script_error);
    }
    let Some(status) = status else {
        return (true, script_error);
    };
    let unchanged = match (version_before, status.version.as_deref()) {
        (Some(before), Some(after)) => before == after,
        _ => false,
    };
    if unchanged && status.update_available == Some(true) {
        let path = status.path.as_deref().unwrap_or("?");
        let version = status.version.as_deref().unwrap_or("?");
        let latest = status.latest_version.as_deref().unwrap_or("?");
        return (
            false,
            Some(format!(
                "update ran but PATH still serves {path} at {version} (latest {latest}); \
                 another installation is shadowing the updated copy"
            )),
        );
    }
    (true, script_error)
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

    let env = resolved_command_env().await;
    let version_before = read_tool_version(&target.command, &env)
        .await
        .ok()
        .flatten();

    // Already-installed tools with a self-updater get it first: it updates
    // the installation PATH resolves, which the install script may not.
    let mut capture = None;
    if version_before.is_some() {
        if let Some(args) = self_update_args(&target.agent_kind) {
            let self_capture = run_program_capture(
                &target.command,
                args,
                TOOL_INSTALL_TIMEOUT,
                TOOL_OUTPUT_LIMIT,
                Some(&env),
            )
            .await;
            let after = read_tool_version(&target.command, &env)
                .await
                .ok()
                .flatten();
            if self_capture.success && after != version_before {
                capture = Some(self_capture);
            }
        }
    }
    let capture = match capture {
        Some(capture) => capture,
        None => {
            run_shell_capture(
                &install,
                TOOL_INSTALL_TIMEOUT,
                TOOL_OUTPUT_LIMIT,
                Some(&env),
            )
            .await
        }
    };

    let status = Some(check_host_tool(target.clone()).await);
    let (success, error) = update_outcome(
        version_before.as_deref(),
        status.as_ref(),
        capture.success,
        capture.error,
    );
    HostToolInstallResult {
        preset_id: target.preset_id,
        preset_name: target.preset_name,
        agent_kind: target.agent_kind,
        command: target.command,
        install: target.install,
        success,
        exit_code: capture.exit_code,
        output: capture.output,
        error,
        status,
    }
}

async fn binary_path(bin: &str, env: &BTreeMap<String, String>) -> Option<String> {
    let output = Command::new("which")
        .arg(bin)
        .envs(env)
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

async fn read_tool_version(
    command: &str,
    env: &BTreeMap<String, String>,
) -> Result<Option<String>> {
    for args in [
        &["--version"][..],
        &["version"][..],
        &["-V"][..],
        &["-v"][..],
    ] {
        let capture =
            run_program_capture(command, args, TOOL_VERSION_TIMEOUT, 4096, Some(env)).await;
        if capture.success {
            if let Some(version) = first_meaningful_line(&capture.output) {
                return Ok(Some(version));
            }
        }
    }
    Ok(None)
}

async fn latest_tool_version(
    install: Option<&str>,
    env: &BTreeMap<String, String>,
) -> Option<String> {
    let install = install?.trim();
    if install.is_empty() {
        return None;
    }

    if let Some(package) = registry_package_for_known_installer(install)
        .map(str::to_string)
        .or_else(|| npm_package_from_install_command(install))
    {
        let capture = run_program_capture(
            "npm",
            &["view", &package, "version"],
            TOOL_VERSION_TIMEOUT,
            4096,
            Some(env),
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
            Some(env),
        )
        .await;
        if capture.success {
            return parse_pip_latest_version(&package, &capture.output);
        }
    }

    None
}

/// curl|sh installers reveal no registry, but several known tools publish to
/// npm in lockstep with their script releases — good enough for a
/// latest-version check (updates still run the configured installer).
fn registry_package_for_known_installer(install: &str) -> Option<&'static str> {
    if install.contains("chatgpt.com/codex/install") {
        return Some("@openai/codex");
    }
    if install.contains("claude.ai/install") {
        return Some("@anthropic-ai/claude-code");
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
    env: Option<&BTreeMap<String, String>>,
) -> CommandCapture {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(env) = env {
        command.envs(env);
    }

    let child = match command.spawn() {
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
    env: Option<&BTreeMap<String, String>>,
) -> CommandCapture {
    let mut shell = Command::new("bash");
    shell
        .arg("-c")
        .arg(format!("exec 2>&1; {command}"))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    if let Some(env) = env {
        shell.envs(env);
    }

    let child = match shell.spawn() {
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
    rtc_sessions: &RtcSessions,
    out_tx: &mpsc::Sender<WsOutbound>,
) {
    let agent_id = create.agent_id;
    tracing::info!(%agent_id, argv = ?create.argv, "agent.create");

    // Build the env for the launched agent: the daemon's process env (so
    // HOME, XDG_CONFIG_HOME, PATH, etc. flow through naturally and the
    // agent CLI finds its own credentials), overlaid with any per-agent
    // env from the create frame. spawn does not inject credentials.
    let mut env: BTreeMap<String, String> = std::env::vars().collect();
    normalize_agent_env(&mut env).await;
    for (k, v) in &create.env {
        env.insert(k.clone(), v.clone());
    }
    if let Err(e) = materialize_agent_capabilities(&create, &mut env) {
        let msg = format!("\r\n\x1b[31m[spawn] capability setup failed: {e:#}\x1b[0m\r\n");
        send_pty_text(agent_id, out_tx, &msg).await;
        send_spawn_failed_exit(agent_id, out_tx, "capability setup failed").await;
        return;
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
    if !binary_exists(&bin, &env).await {
        match create.install.as_deref() {
            Some(install_cmd) if !install_cmd.trim().is_empty() => {
                let header = format!(
                    "\r\n\x1b[36m[spawn] {bin:?} not found in PATH; running install...\x1b[0m\r\n\
                     $ {install_cmd}\r\n"
                );
                send_pty_text(agent_id, out_tx, &header).await;
                let installed = run_install(agent_id, install_cmd, out_tx, &env).await;
                if !installed {
                    send_spawn_failed_exit(agent_id, out_tx, "install failed").await;
                    return;
                }
                if !binary_exists(&bin, &env).await {
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

    // Launch through the mandatory per-agent worker. There is no backend
    // selector or per-agent escape hatch: failing to start the worker is a
    // fail-closed agent.create error.
    let spec = pty::LaunchSpec {
        agent_id,
        cwd: &launch_cwd_str,
        cols: create.cols,
        rows: create.rows,
        argv: &create.argv,
        env: &env,
    };
    let launched = match worker_backend::launch(spec).await {
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
    // Wire the new agent's forwarder to this server session before inserting
    // into the registry so early worker output routes immediately.
    launched.handle.control.set_sink(out_tx.clone()).await;
    let transition = registry.lock_generation_transition(agent_id).await;
    if let Some(previous) = registry.binding_for(agent_id) {
        // Invalidate first. Any offer that captured `previous` must acquire
        // this same transition lock before peer insertion and will fail its
        // generation recheck after the guard is released.
        let _ = registry.remove_if_generation(agent_id, previous.generation());
        rtc_sessions
            .close_for_agent(agent_id, previous.generation())
            .await;
    }
    let generation = registry.insert(launched.handle);
    drop(transition);

    // Tell server it's up.
    let started = Outbound::AgentStarted { agent_id, pid };
    let _ = out_tx
        .send(WsOutbound::Json(serde_json::to_string(&started).unwrap()))
        .await;

    // Await PTY exit and forward `agent.exit`.
    let registry = registry.clone();
    let rtc_sessions = rtc_sessions.clone();
    let out_tx = out_tx.clone();
    tokio::spawn(async move {
        let reason = exit_rx.await.unwrap_or(pty::ExitReason {
            exit_code: None,
            signal: None,
        });
        let transition = registry.lock_generation_transition(agent_id).await;
        let removed = registry.remove_if_generation(agent_id, generation);
        rtc_sessions.close_for_agent(agent_id, generation).await;
        drop(transition);
        if removed.is_none() {
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

async fn resolved_command_env() -> BTreeMap<String, String> {
    let mut env: BTreeMap<String, String> = std::env::vars().collect();
    normalize_agent_env(&mut env).await;
    env
}

async fn normalize_agent_env(env: &mut BTreeMap<String, String>) {
    env.remove("NO_COLOR");
    env.insert("TERM".into(), "xterm-256color".into());
    env.insert("COLORTERM".into(), "truecolor".into());
    env.entry("CLICOLOR".into()).or_insert_with(|| "1".into());
    enrich_path_from_user_shell(env).await;
}

async fn enrich_path_from_user_shell(env: &mut BTreeMap<String, String>) {
    let mut preferred = shell_path_entries(env).await;
    preferred.extend(common_user_bin_entries(env));
    prepend_path_entries(env, preferred);
}

async fn shell_path_entries(env: &BTreeMap<String, String>) -> Vec<PathBuf> {
    for shell in candidate_shells(env) {
        let mut entries = Vec::new();
        for mode in ["-ic", "-lc"] {
            if let Some(path) = probe_shell_path(&shell, mode, env).await {
                entries.extend(std::env::split_paths(&path));
            }
        }
        if !entries.is_empty() {
            return entries;
        }
    }
    Vec::new()
}

async fn probe_shell_path(
    shell: &Path,
    mode: &str,
    env: &BTreeMap<String, String>,
) -> Option<String> {
    let mut command = Command::new(shell);
    command
        .arg(mode)
        .arg("printf '%s\\n' \"$PATH\"")
        .envs(env)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);

    let output = tokio::time::timeout(SHELL_PATH_PROBE_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

fn candidate_shells(env: &BTreeMap<String, String>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();

    let mut push = |path: PathBuf| {
        if !path.is_absolute() || !path.exists() {
            return;
        }
        if seen.insert(path.clone()) {
            candidates.push(path);
        }
    };

    if let Some(shell) = env.get("SHELL").filter(|value| !value.trim().is_empty()) {
        push(PathBuf::from(shell));
    }
    for shell in [
        "/bin/bash",
        "/usr/bin/bash",
        "/bin/zsh",
        "/usr/bin/zsh",
        "/bin/sh",
        "/usr/bin/sh",
    ] {
        push(PathBuf::from(shell));
    }

    candidates
}

fn common_user_bin_entries(env: &BTreeMap<String, String>) -> Vec<PathBuf> {
    let Some(home) = env.get("HOME").filter(|value| !value.is_empty()) else {
        return Vec::new();
    };
    let home = PathBuf::from(home);
    [
        home.join(".local/bin"),
        home.join("bin"),
        home.join(".bun/bin"),
        home.join(".cargo/bin"),
    ]
    .into_iter()
    .collect()
}

fn prepend_path_entries(env: &mut BTreeMap<String, String>, preferred: Vec<PathBuf>) {
    let existing = env
        .get("PATH")
        .map(|path| std::env::split_paths(path).collect::<Vec<_>>())
        .unwrap_or_default();
    let mut merged = Vec::new();
    let mut seen = HashSet::new();

    for entry in preferred.into_iter().chain(existing) {
        if entry.as_os_str().is_empty() || !seen.insert(entry.clone()) {
            continue;
        }
        merged.push(entry);
    }

    if let Ok(joined) = std::env::join_paths(merged) {
        env.insert("PATH".into(), joined.to_string_lossy().into_owned());
    }
}

fn materialize_agent_capabilities(
    create: &AgentCreate,
    env: &mut BTreeMap<String, String>,
) -> Result<()> {
    if create.skills.is_empty() {
        return Ok(());
    }

    let root = config::config_dir()?
        .join("agents")
        .join(create.agent_id.to_string());
    if root.exists() {
        fs::remove_dir_all(&root).with_context(|| format!("clearing {}", root.display()))?;
    }
    fs::create_dir_all(&root).with_context(|| format!("creating {}", root.display()))?;

    let skills_file = root.join("skills.json");
    let skills_dir = root.join("skills");
    fs::create_dir_all(&skills_dir)
        .with_context(|| format!("creating {}", skills_dir.display()))?;

    fs::write(&skills_file, serde_json::to_vec_pretty(&create.skills)?)
        .with_context(|| format!("writing {}", skills_file.display()))?;

    for skill in &create.skills {
        let dir = skills_dir.join(safe_file_component(&skill.name));
        fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
        let path = dir.join("SKILL.md");
        fs::write(
            &path,
            skill_markdown(&skill.name, &skill.description, &skill.content),
        )
        .with_context(|| format!("writing {}", path.display()))?;
    }

    env.insert(
        "SPAWN_AGENT_CONFIG_DIR".into(),
        root.to_string_lossy().into_owned(),
    );
    env.insert(
        "SPAWN_SKILLS_FILE".into(),
        skills_file.to_string_lossy().into_owned(),
    );
    env.insert(
        "SPAWN_SKILLS_DIR".into(),
        skills_dir.to_string_lossy().into_owned(),
    );

    if is_codex_argv(&create.argv) {
        let codex_home = root.join("codex-home");
        fs::create_dir_all(&codex_home)
            .with_context(|| format!("creating {}", codex_home.display()))?;
        write_codex_projection(&codex_home, &skills_dir, create)?;
        link_codex_auth_state(&codex_home)?;
        env.insert(
            "CODEX_HOME".into(),
            codex_home.to_string_lossy().into_owned(),
        );
    }

    Ok(())
}

fn is_codex_argv(argv: &[String]) -> bool {
    argv.first()
        .and_then(|bin| Path::new(bin).file_name())
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.to_ascii_lowercase().contains("codex"))
}

fn write_codex_projection(
    codex_home: &Path,
    skills_dir: &Path,
    create: &AgentCreate,
) -> Result<()> {
    let mut config = String::from("# Generated by spawnd for this Spawn agent.\n");
    for skill in &create.skills {
        let path = skills_dir
            .join(safe_file_component(&skill.name))
            .join("SKILL.md");
        config.push_str("\n[[skills.config]]\npath = ");
        config.push_str(&toml_string(&path.to_string_lossy()));
        config.push_str("\nenabled = true\n");
    }
    if !create.cwd.trim().is_empty() {
        config.push_str("\n[projects.");
        config.push_str(&toml_quoted_key(&create.cwd));
        config.push_str("]\ntrust_level = \"trusted\"\n");
    }
    let path = codex_home.join("config.toml");
    fs::write(&path, config).with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

fn link_codex_auth_state(codex_home: &Path) -> Result<()> {
    let Some(home) = dirs::home_dir() else {
        return Ok(());
    };
    let source_home = std::env::var("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home.join(".codex"));
    for name in [
        "auth.json",
        "internal_storage.json",
        "models_cache.json",
        "version.json",
    ] {
        let source = source_home.join(name);
        let dest = codex_home.join(name);
        if !source.exists() || dest.exists() {
            continue;
        }
        link_or_copy(&source, &dest)
            .with_context(|| format!("projecting Codex auth state {}", source.display()))?;
    }
    Ok(())
}

#[cfg(unix)]
fn link_or_copy(source: &Path, dest: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(source, dest).or_else(|_| fs::copy(source, dest).map(|_| ()))
}

#[cfg(not(unix))]
fn link_or_copy(source: &Path, dest: &Path) -> std::io::Result<()> {
    fs::copy(source, dest).map(|_| ())
}

fn skill_markdown(name: &str, description: &str, content: &str) -> String {
    if content.trim_start().starts_with("---") {
        return content.to_string();
    }
    format!(
        "---\nname: \"{}\"\ndescription: \"{}\"\n---\n\n{}",
        yaml_string(name),
        yaml_string(description),
        content
    )
}

fn safe_file_component(value: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in value.chars() {
        let next = if ch.is_ascii_alphanumeric() {
            ch.to_ascii_lowercase()
        } else if matches!(ch, '-' | '_' | '.') {
            ch
        } else {
            '-'
        };
        if next == '-' {
            if last_dash || out.is_empty() {
                continue;
            }
            last_dash = true;
        } else {
            last_dash = false;
        }
        out.push(next);
        if out.len() >= 80 {
            break;
        }
    }
    while out.ends_with(['-', '.', '_']) {
        out.pop();
    }
    if out.is_empty() {
        "skill".into()
    } else {
        out
    }
}

fn yaml_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn toml_quoted_key(value: &str) -> String {
    toml_string(value)
}

fn toml_string(value: &str) -> String {
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if ch.is_control() => out.push(' '),
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::AgentSkillConfig;

    fn tool_status(
        version: Option<&str>,
        latest: Option<&str>,
        update_available: Option<bool>,
    ) -> HostToolStatus {
        HostToolStatus {
            preset_id: "p".into(),
            preset_name: "claude".into(),
            agent_kind: "claude-code".into(),
            command: "claude".into(),
            install: None,
            installed: true,
            path: Some("/home/u/.local/bin/claude".into()),
            version: version.map(str::to_string),
            latest_version: latest.map(str::to_string),
            update_available,
            error: None,
        }
    }

    #[test]
    fn update_outcome_demotes_shadowed_install_success() {
        // Script exited 0 but PATH still serves the old version with an
        // update still available: silent no-op must become a visible error.
        let status = tool_status(Some("2.1.129"), Some("2.1.209"), Some(true));
        let (success, error) = update_outcome(Some("2.1.129"), Some(&status), true, None);
        assert!(!success);
        let msg = error.expect("explanatory error");
        assert!(msg.contains("shadowing"), "unexpected error: {msg}");
        assert!(msg.contains("2.1.129") && msg.contains("2.1.209"));
    }

    #[test]
    fn update_outcome_accepts_version_change() {
        let status = tool_status(Some("2.1.209"), Some("2.1.209"), Some(false));
        let (success, error) = update_outcome(Some("2.1.129"), Some(&status), true, None);
        assert!(success);
        assert!(error.is_none());
    }

    #[test]
    fn update_outcome_accepts_fresh_install_and_keeps_script_failures() {
        let status = tool_status(Some("1.0.0"), None, None);
        let (success, _) = update_outcome(None, Some(&status), true, None);
        assert!(success, "fresh install with no prior version");
        let (success, error) =
            update_outcome(Some("1.0.0"), Some(&status), false, Some("boom".into()));
        assert!(!success);
        assert_eq!(error.as_deref(), Some("boom"));
    }

    #[test]
    fn known_curl_installers_map_to_registry_packages() {
        assert_eq!(
            registry_package_for_known_installer(
                "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh"
            ),
            Some("@openai/codex")
        );
        assert_eq!(
            registry_package_for_known_installer("curl -fsSL https://claude.ai/install.sh | bash"),
            Some("@anthropic-ai/claude-code")
        );
        assert_eq!(
            registry_package_for_known_installer("npm install -g opencode-ai"),
            None
        );
    }

    #[test]
    fn self_update_args_only_for_known_kinds() {
        assert_eq!(self_update_args("claude-code"), Some(&["update"][..]));
        assert_eq!(self_update_args("codex"), None);
        assert_eq!(self_update_args("shell"), None);
    }

    #[test]
    fn codex_projection_includes_selected_skills_and_trusted_project() {
        let temp = tempfile::tempdir().expect("tempdir");
        let codex_home = temp.path().join("codex-home");
        let skills_dir = temp.path().join("skills");
        fs::create_dir_all(&codex_home).expect("codex home");
        fs::create_dir_all(skills_dir.join("spawn-control")).expect("spawn skill dir");
        fs::create_dir_all(skills_dir.join("repo-notes")).expect("notes skill dir");

        let create = AgentCreate {
            agent_id: Uuid::new_v4(),
            cwd: "/work/repo".to_string(),
            argv: vec!["/opt/homebrew/bin/codex".to_string()],
            env: BTreeMap::new(),
            install: None,
            skills: vec![
                AgentSkillConfig {
                    id: "skill-1".to_string(),
                    name: "spawn control".to_string(),
                    description: "Operate spawn".to_string(),
                    content: "Use spawn carefully.".to_string(),
                },
                AgentSkillConfig {
                    id: "skill-2".to_string(),
                    name: "repo/notes".to_string(),
                    description: "Repo notes".to_string(),
                    content: "Remember project conventions.".to_string(),
                },
            ],
            cols: 80,
            rows: 24,
            create_cwd: false,
        };

        write_codex_projection(&codex_home, &skills_dir, &create).expect("write projection");
        let config = fs::read_to_string(codex_home.join("config.toml")).expect("read config");

        assert!(config.contains("[[skills.config]]"));
        assert!(config.contains("spawn-control/SKILL.md"));
        assert!(config.contains("repo-notes/SKILL.md"));
        assert!(!config.contains("unselected"));
        assert!(config.contains("[projects.\"/work/repo\"]\ntrust_level = \"trusted\""));
    }

    #[test]
    fn skill_materialization_sanitizes_names_and_does_not_inject_unrelated_secrets() {
        let markdown = skill_markdown(
            "Spawn \"Control\"",
            "Use \\ safely",
            "Steps do not include bearer tokens.",
        );

        assert!(markdown.starts_with("---\n"));
        assert!(markdown.contains("name: \"Spawn \\\"Control\\\"\""));
        assert!(markdown.contains("description: \"Use \\\\ safely\""));
        assert!(markdown.contains("Steps do not include bearer tokens."));
        assert_eq!(safe_file_component("repo/notes & tips"), "repo-notes-tips");
        assert!(!markdown.contains("Bearer http-secret"));
        assert!(!markdown.contains("stdio-secret"));
    }

    #[test]
    fn path_enrichment_prefers_shell_path_and_keeps_service_path() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path();
        let shell_bin = home.join(".nvm/versions/node/v22/bin");
        let service_bin = PathBuf::from("/usr/bin");
        let fallback_bin = PathBuf::from("/bin");

        let mut env = BTreeMap::new();
        env.insert("HOME".to_string(), home.to_string_lossy().into_owned());
        env.insert(
            "PATH".to_string(),
            std::env::join_paths([service_bin.clone(), fallback_bin.clone()])
                .expect("join service path")
                .to_string_lossy()
                .into_owned(),
        );

        let mut preferred = vec![shell_bin.clone()];
        preferred.extend(common_user_bin_entries(&env));
        prepend_path_entries(&mut env, preferred);

        let path = env.get("PATH").expect("path");
        let entries = std::env::split_paths(path).collect::<Vec<_>>();
        assert_eq!(entries[0], shell_bin);
        assert_eq!(entries[1], home.join(".local/bin"));
        assert!(entries.iter().any(|entry| entry == &service_bin));
        assert!(entries.iter().any(|entry| entry == &fallback_bin));
    }

    #[tokio::test]
    async fn path_enrichment_reads_interactive_shell_startup_path() {
        let bash = PathBuf::from("/bin/bash");
        if !bash.exists() {
            return;
        }

        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path();
        let shell_bin = home.join("shell-only-bin");
        fs::create_dir_all(&shell_bin).expect("shell bin");
        fs::write(
            home.join(".bashrc"),
            format!("export PATH=\"{}:$PATH\"\n", shell_bin.display()),
        )
        .expect("bashrc");

        let mut env = BTreeMap::new();
        env.insert("HOME".to_string(), home.to_string_lossy().into_owned());
        env.insert("SHELL".to_string(), bash.to_string_lossy().into_owned());
        env.insert("PATH".to_string(), "/usr/bin:/bin".to_string());

        normalize_agent_env(&mut env).await;

        let path = env.get("PATH").expect("path");
        let entries = std::env::split_paths(path).collect::<Vec<_>>();
        let shell_pos = entries
            .iter()
            .position(|entry| entry == &shell_bin)
            .expect("shell path entry");
        let service_pos = entries
            .iter()
            .position(|entry| entry == &PathBuf::from("/usr/bin"))
            .expect("service path entry");
        assert!(shell_pos < service_pos);
    }
}

async fn handle_agent_restart(
    create: AgentCreate,
    registry: &AgentRegistry,
    rtc_sessions: &RtcSessions,
    out_tx: &mpsc::Sender<WsOutbound>,
) {
    let agent_id = create.agent_id;
    tracing::info!(%agent_id, argv = ?create.argv, "agent.restart");

    // Hold the generation transition across every lifecycle delivery. This
    // lets each TERM/KILL revalidate the exact atomic lifecycle snapshot and
    // prevents replacement from linearizing between validation and the
    // worker-owned signal syscall.
    let transition = registry.lock_generation_transition(agent_id).await;
    let current = registry.lifecycle_snapshot(agent_id);
    if let Some(snapshot) = &current {
        let binding = snapshot.binding();
        rtc_sessions
            .close_for_agent(agent_id, binding.generation())
            .await;
        if let Some(control) = registry.control_for_binding(binding) {
            control.clear_sink().await;
        }
        // Lifecycle delivery bypasses the potentially saturated worker input
        // socket. Check each result and deterministically escalate to KILL.
        let term_result = if registry.is_current(binding) {
            snapshot
                .lifecycle()
                .shutdown(spawnd::sessiond::wire::LifecycleSignal::Term)
                .await
        } else {
            Err(anyhow!("stale agent lifecycle generation"))
        };
        if let Err(error) = &term_result {
            tracing::warn!(%agent_id, %error, "restart TERM delivery failed; escalating now");
        }
        let mut kill_attempted = false;
        for attempt in 0..30u32 {
            if !worker_backend::socket_exists(agent_id) {
                break;
            }
            if !kill_attempted && (attempt == 15 || term_result.is_err()) {
                kill_attempted = true;
                let kill_result = if registry.is_current(binding) {
                    snapshot
                        .lifecycle()
                        .shutdown(spawnd::sessiond::wire::LifecycleSignal::Kill)
                        .await
                } else {
                    Err(anyhow!("stale agent lifecycle generation"))
                };
                if let Err(error) = kill_result {
                    tracing::error!(%agent_id, %error, "restart KILL delivery failed");
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let _ = registry.remove_if_generation(agent_id, binding.generation());
    }
    drop(transition);

    if worker_backend::socket_exists(agent_id) {
        send_pty_text(
            agent_id,
            out_tx,
            "\r\n\x1b[31m[spawn] restart failed: old session worker did not exit\x1b[0m\r\n",
        )
        .await;
        send_spawn_failed_exit(agent_id, out_tx, "restart timeout").await;
        return;
    }
    handle_agent_create(create, registry, rtc_sessions, out_tx).await;
}

async fn handle_agent_kill(
    agent_id: Uuid,
    signal: Option<spawnd::sessiond::wire::LifecycleSignal>,
    registry: &AgentRegistry,
    rtc_sessions: &RtcSessions,
    out_tx: &mpsc::Sender<WsOutbound>,
) {
    // Signal through the worker, adopting first if this daemon process has
    // not attached yet. The worker Exit frame drives agent.exit.
    if !registry.contains(agent_id) {
        let _ = ensure_agent_attached(agent_id, registry, rtc_sessions, out_tx).await;
    }
    let Some(snapshot) = registry.lifecycle_snapshot(agent_id) else {
        send_error(
            out_tx,
            Some(agent_id),
            "kill_failed",
            &anyhow!("agent lifecycle is unavailable"),
        )
        .await;
        return;
    };
    let requested = signal.unwrap_or(spawnd::sessiond::wire::LifecycleSignal::Term);
    if let Err(error) = registry.shutdown_if_current(&snapshot, requested).await {
        tracing::warn!(%agent_id, %error, "agent signal delivery failed");
        let final_error = if requested == spawnd::sessiond::wire::LifecycleSignal::Kill {
            error
        } else {
            match registry
                .shutdown_if_current(&snapshot, spawnd::sessiond::wire::LifecycleSignal::Kill)
                .await
            {
                Ok(()) => return,
                Err(kill_error) => kill_error,
            }
        };
        send_error(
            out_tx,
            Some(agent_id),
            "kill_failed",
            &final_error.context("lifecycle delivery failed after escalation"),
        )
        .await;
    } else if requested == spawnd::sessiond::wire::LifecycleSignal::Term {
        // TERM is graceful but bounded. Fence the delayed escalation to this
        // exact backend generation so a fast restart cannot be killed.
        let registry = registry.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(1500)).await;
            if let Err(error) = registry
                .shutdown_if_current(&snapshot, spawnd::sessiond::wire::LifecycleSignal::Kill)
                .await
            {
                tracing::warn!(%agent_id, %error, "delayed agent KILL delivery failed");
            }
        });
    }
    // The worker reports exit and emits `agent.exit`. We do not
    // remove from the registry here — let the exit handler do it once it has
    // the exit code.
}

async fn handle_agent_resize(agent_id: Uuid, cols: u16, rows: u16, registry: &AgentRegistry) {
    if !registry.contains(agent_id) {
        tracing::debug!(%agent_id, "ignoring resize for unknown agent");
        return;
    }
    let found = registry.with_handle(agent_id, |h| match h.resize(cols, rows) {
        Ok(_) => {}
        Err(e) => tracing::warn!(%agent_id, error = %e, "PTY resize failed"),
    });
    if !found {
        tracing::debug!(%agent_id, "ignoring resize for unknown agent");
    }
}

async fn handle_agent_scroll(agent_id: Uuid, lines: i16, _registry: &AgentRegistry) {
    if lines == 0 {
        return;
    }
    // Scrollback/selection is browser-local. Retain this content-free legacy
    // frame as a no-op until the server/web compatibility fields are removed.
    tracing::debug!(%agent_id, lines, "ignoring deprecated agent.scroll frame");
}

struct SnapshotRequest {
    request_id: Option<String>,
    lines: u16,
    plain: bool,
    rtc_session_id: Option<String>,
}

async fn handle_agent_snapshot(
    agent_id: Uuid,
    request: SnapshotRequest,
    registry: &AgentRegistry,
    rtc_sessions: &RtcSessions,
    out_tx: &mpsc::Sender<WsOutbound>,
) {
    let SnapshotRequest {
        request_id,
        lines,
        plain: _plain,
        rtc_session_id,
    } = request;
    let attach_outcome = ensure_agent_attached(agent_id, registry, rtc_sessions, out_tx).await;
    if attach_outcome != AttachOutcome::Attached {
        let message = match attach_outcome {
            AttachOutcome::Unavailable => "session worker is unavailable",
            AttachOutcome::Unknown => "session worker adoption failed",
            AttachOutcome::Attached => unreachable!(),
        };
        send_error(out_tx, Some(agent_id), "snapshot_failed", &anyhow!(message)).await;
        return;
    }

    // Sample the requester's DataChannel position before replay. The worker
    // logs bytes before shipping them, so everything counted here is covered.
    let dc_offset = match &rtc_session_id {
        Some(id) => match registry.control_for(agent_id) {
            Some(control) => control.direct_sink_offset(id).await,
            None => None,
        },
        None => None,
    };
    let max_bytes = (lines as u32)
        .saturating_mul(256)
        .clamp(64 * 1024, 8 * 1024 * 1024);
    let mut replay_rx = None;
    registry.with_handle(agent_id, |h| replay_rx = h.replay(max_bytes));
    let replay = match replay_rx {
        Some(rx) => match rx.await {
            Ok(Ok(replay)) => Ok(replay),
            Ok(Err(e)) => Err(e),
            Err(_) => Err(anyhow!("worker replay dropped")),
        },
        None => Err(anyhow!("worker connection gone")),
    };
    match replay {
        Ok(replay) => {
            let snapshot = Outbound::AgentSnapshot {
                agent_id,
                request_id,
                bytes_b64: STANDARD.encode(replay.bytes()),
                dc_offset,
                rtc_session_id,
            };
            if let Ok(s) = serde_json::to_string(&snapshot) {
                let _ = out_tx.send(WsOutbound::Json(s)).await;
            }
        }
        Err(e) => {
            tracing::warn!(%agent_id, error = %e, "worker snapshot failed");
            send_error(out_tx, Some(agent_id), "snapshot_failed", &e).await;
        }
    }
}

async fn handle_agent_redraw(agent_id: Uuid, registry: &AgentRegistry) {
    let known = registry.contains(agent_id);
    tracing::debug!(%agent_id, known, "ignoring deprecated agent.redraw frame");
}

#[allow(clippy::too_many_arguments)]
async fn handle_agent_upload(
    agent_id: Uuid,
    request_id: Option<String>,
    cwd: String,
    name: String,
    mime_type: String,
    bytes_b64: String,
    paste_prefix: Option<String>,
    paste: bool,
    destination: Option<String>,
    client_id: Option<String>,
    registry: &AgentRegistry,
    rtc_sessions: &RtcSessions,
    out_tx: &mpsc::Sender<WsOutbound>,
) {
    if !registry.contains(agent_id) {
        let _ = ensure_agent_attached(agent_id, registry, rtc_sessions, out_tx).await;
        if !registry.contains(agent_id) {
            tracing::debug!(%agent_id, "ignoring upload for unknown agent");
            return;
        }
    }

    let save_to_cwd = destination.as_deref() == Some("cwd");
    match upload::save_upload(&cwd, &name, &mime_type, &bytes_b64, save_to_cwd).await {
        Ok(path) => {
            if paste {
                let paste_text = upload::paste_text_for_path(&cwd, &path, paste_prefix.as_deref());
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
                request_id,
                client_id,
            };
            if let Ok(s) = serde_json::to_string(&uploaded) {
                let _ = out_tx.send(WsOutbound::Json(s)).await;
            }
            tracing::info!(%agent_id, path = %path.display(), "upload saved");
        }
        Err(e) => {
            tracing::warn!(%agent_id, error = %e, "upload failed");
            send_upload_error(out_tx, agent_id, request_id, client_id, &e).await;
        }
    }
}

async fn send_upload_error(
    out_tx: &mpsc::Sender<WsOutbound>,
    agent_id: Uuid,
    request_id: Option<String>,
    client_id: Option<String>,
    err: &anyhow::Error,
) {
    let frame = Outbound::Error {
        agent_id: Some(agent_id),
        code: "upload_failed".into(),
        message: format!("{err:#}"),
        request_id,
        client_id,
    };
    if let Ok(s) = serde_json::to_string(&frame) {
        let _ = out_tx.send(WsOutbound::Json(s)).await;
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
        request_id: None,
        client_id: None,
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

async fn spawn_exit_forwarder(
    agent_id: Uuid,
    generation: u64,
    exit_rx: tokio::sync::oneshot::Receiver<pty::ExitReason>,
    registry: AgentRegistry,
    rtc_sessions: RtcSessions,
    out_tx: mpsc::Sender<WsOutbound>,
) {
    let reason = exit_rx.await.unwrap_or(pty::ExitReason {
        exit_code: None,
        signal: None,
    });
    let transition = registry.lock_generation_transition(agent_id).await;
    let removed = registry.remove_if_generation(agent_id, generation);
    rtc_sessions.close_for_agent(agent_id, generation).await;
    drop(transition);
    if removed.is_none() {
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
}

/// Adopt a running session worker for this agent (spawnd restart / lazy
/// attach). Returns false when no live worker exists.
async fn adopt_worker_agent(
    agent_id: Uuid,
    registry: &AgentRegistry,
    rtc_sessions: &RtcSessions,
    out_tx: &mpsc::Sender<WsOutbound>,
    notify_started: bool,
) -> Result<bool> {
    if registry.contains(agent_id) {
        return Ok(true);
    }
    let Some(launched) = worker_backend::adopt(agent_id).await? else {
        return Ok(false);
    };
    register_attached(
        agent_id,
        launched,
        registry,
        rtc_sessions,
        out_tx,
        notify_started,
    )
    .await;
    Ok(true)
}

/// Shared tail of launch/adopt: wire the sink, insert into the
/// registry, optionally announce agent.started, and spawn the exit forwarder.
async fn register_attached(
    agent_id: Uuid,
    launched: pty::Launched,
    registry: &AgentRegistry,
    rtc_sessions: &RtcSessions,
    out_tx: &mpsc::Sender<WsOutbound>,
    notify_started: bool,
) {
    let pid = launched.pid;
    let exit_rx = launched.exit_rx;

    launched.handle.control.set_sink(out_tx.clone()).await;
    let transition = registry.lock_generation_transition(agent_id).await;
    if let Some(previous) = registry.binding_for(agent_id) {
        let _ = registry.remove_if_generation(agent_id, previous.generation());
        rtc_sessions
            .close_for_agent(agent_id, previous.generation())
            .await;
    }
    let generation = registry.insert(launched.handle);
    drop(transition);

    if notify_started {
        let started = Outbound::AgentStarted { agent_id, pid };
        let _ = out_tx
            .send(WsOutbound::Json(serde_json::to_string(&started).unwrap()))
            .await;
    }

    tokio::spawn(spawn_exit_forwarder(
        agent_id,
        generation,
        exit_rx,
        registry.clone(),
        rtc_sessions.clone(),
        out_tx.clone(),
    ));
}

/// Outcome of a lazy worker adoption attempt.
#[derive(Clone, Copy, PartialEq, Eq)]
enum AttachOutcome {
    Attached,
    /// No live worker socket exists. Old pre-cutover sessions are deliberately
    /// unavailable; there is no transparent cross-backend adoption.
    Unavailable,
    /// Transient worker connection/adoption failure.
    Unknown,
}

async fn ensure_agent_attached(
    agent_id: Uuid,
    registry: &AgentRegistry,
    rtc_sessions: &RtcSessions,
    out_tx: &mpsc::Sender<WsOutbound>,
) -> AttachOutcome {
    if registry.contains(agent_id) {
        return AttachOutcome::Attached;
    }
    // Serialize lazy adoption: snapshot bursts and stdin dispatch racing here
    // would double-connect and displace each other's worker connections.
    let _guard = registry.lock_attach().await;
    if registry.contains(agent_id) {
        return AttachOutcome::Attached;
    }
    match adopt_worker_agent(agent_id, registry, rtc_sessions, out_tx, true).await {
        Ok(true) => {
            tracing::info!(%agent_id, "lazily adopted session worker");
            AttachOutcome::Attached
        }
        Ok(false) => {
            tracing::debug!(%agent_id, "no session worker found for unknown agent");
            AttachOutcome::Unavailable
        }
        Err(e) => {
            tracing::warn!(%agent_id, error = %e, "worker adoption failed");
            AttachOutcome::Unknown
        }
    }
}

/// On daemon startup, discover worker sockets left behind by a previous
/// instance and adopt each live session.
async fn rediscover_existing_agents(
    registry: &AgentRegistry,
    rtc_sessions: &RtcSessions,
    out_tx: &mpsc::Sender<WsOutbound>,
) {
    for agent_id in worker_backend::discover_ids() {
        if registry.contains(agent_id) {
            continue;
        }
        match adopt_worker_agent(agent_id, registry, rtc_sessions, out_tx, false).await {
            Ok(true) => tracing::info!(%agent_id, "rediscovered worker-backed agent"),
            Ok(false) => {}
            Err(e) => {
                tracing::warn!(%agent_id, error = %e, "failed to adopt session worker");
            }
        }
    }
}

/// Returns true if `bin` resolves to something on PATH.
async fn binary_exists(bin: &str, env: &BTreeMap<String, String>) -> bool {
    binary_path(bin, env).await.is_some()
}

/// Run `bash -c "exec 2>&1; <install_cmd>"` and stream output into the agent's PTY
/// frame channel. Returns true on a successful exit status.
async fn run_install(
    agent_id: Uuid,
    install_cmd: &str,
    out_tx: &mpsc::Sender<WsOutbound>,
    env: &BTreeMap<String, String>,
) -> bool {
    use tokio::io::AsyncReadExt;

    let mut shell = tokio::process::Command::new("bash");
    shell
        .arg("-c")
        .arg(format!("exec 2>&1; {install_cmd}"))
        .envs(env)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);

    let mut child = match shell.spawn() {
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
