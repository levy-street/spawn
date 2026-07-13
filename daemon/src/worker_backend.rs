//! spawnd-side supervision of session workers (docs/SESSIOND.md).
//!
//! The worker backend replaces tmux for agents opted in via
//! `SPAWND_SESSION_BACKEND=worker` (globally) or a per-agent
//! `SPAWND_SESSION_BACKEND=worker` entry in `agent.create` env. tmux remains
//! the default backend; nothing here runs unless the flag is set.
//!
//! For each worker agent, spawnd:
//! - spawns `spawn-worker` in its own process group (so it survives spawnd
//!   restarts and upgrades),
//! - connects to its unix socket and drives the framed `sessiond::wire`
//!   protocol,
//! - bridges worker output into the same per-agent outbox → forwarder →
//!   {WS sink, DataChannel direct sinks} pipeline the tmux backend uses, so
//!   the WebRTC PTY path needs no changes,
//! - adopts already-running workers after a restart by scanning the socket
//!   directory (the worker greets every connection with `Hello`).

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use spawnd::sessiond::wire;

use crate::config;
use crate::proto::AgentCreate;
use crate::pty::{self, AgentHandle, ExitReason, ForwarderControl, WorkerCmd, WorkerHandleParts};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const ADOPT_CONNECT_TIMEOUT: Duration = Duration::from_millis(750);
const START_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendKind {
    Tmux,
    Worker,
}

fn parse_backend(value: &str) -> Option<BackendKind> {
    match value.trim().to_ascii_lowercase().as_str() {
        "worker" | "sessiond" => Some(BackendKind::Worker),
        "tmux" => Some(BackendKind::Tmux),
        _ => None,
    }
}

/// Global backend selection: `SPAWND_SESSION_BACKEND` env, default tmux.
pub fn global_backend() -> BackendKind {
    std::env::var("SPAWND_SESSION_BACKEND")
        .ok()
        .and_then(|v| parse_backend(&v))
        .unwrap_or(BackendKind::Tmux)
}

/// Per-agent backend selection: an `SPAWND_SESSION_BACKEND` entry in the
/// create frame's env overrides the global default. This is the migration
/// lever — individual agents can move to the worker backend while the rest
/// of the host stays on tmux.
pub fn backend_for_create(create: &AgentCreate) -> BackendKind {
    create
        .env
        .get("SPAWND_SESSION_BACKEND")
        .and_then(|v| parse_backend(v))
        .unwrap_or_else(global_backend)
}

/// Directory holding worker sockets and scrollback dirs:
/// `$SPAWND_WORKER_DIR` → `$XDG_RUNTIME_DIR/spawn/workers` → config dir.
pub fn worker_dir() -> Result<PathBuf> {
    let dir = match std::env::var_os("SPAWND_WORKER_DIR").filter(|v| !v.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => match dirs::runtime_dir() {
            Some(run) => run.join("spawn").join("workers"),
            None => config::config_dir()?.join("workers"),
        },
    };
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(dir)
}

fn socket_path(dir: &std::path::Path, agent_id: Uuid) -> PathBuf {
    dir.join(format!("{agent_id}.sock"))
}

fn log_dir(dir: &std::path::Path, agent_id: Uuid) -> PathBuf {
    dir.join(format!("{agent_id}.scrollback"))
}

/// Resolve the spawn-worker binary: `$SPAWND_WORKER_BIN` → sibling of the
/// running spawnd → bare name (PATH).
fn worker_bin() -> PathBuf {
    if let Some(bin) = std::env::var_os("SPAWND_WORKER_BIN").filter(|v| !v.is_empty()) {
        return PathBuf::from(bin);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sibling = dir.join("spawn-worker");
            if sibling.exists() {
                return sibling;
            }
        }
    }
    PathBuf::from("spawn-worker")
}

/// Launch a fresh worker for `agent.create` and start the agent inside it.
pub async fn launch(spec: pty::LaunchSpec<'_>) -> Result<pty::Launched> {
    let dir = worker_dir()?;
    let socket = socket_path(&dir, spec.agent_id);
    let logs = log_dir(&dir, spec.agent_id);
    // A stale socket from a dead worker would race the new one's bind; the
    // worker unlinks it itself, but clear it here too for a clean connect.
    if UnixStream::connect(&socket).await.is_err() {
        let _ = std::fs::remove_file(&socket);
    }

    let bin = worker_bin();
    let mut cmd = std::process::Command::new(&bin);
    cmd.arg("--socket")
        .arg(&socket)
        .arg("--agent-id")
        .arg(spec.agent_id.to_string())
        .arg("--log-dir")
        .arg(&logs)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::inherit());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Own process group: the worker (and its agent) must not die with
        // spawnd. Note: under systemd, spawnd's unit needs KillMode=process
        // for this to survive `systemctl restart` (docs/SESSIOND.md).
        cmd.process_group(0);
    }
    let child = cmd
        .spawn()
        .with_context(|| format!("spawning {}", bin.display()))?;
    tracing::info!(agent_id = %spec.agent_id, worker_pid = child.id(), "spawned session worker");

    let mut stream = connect_with_retry(&socket, CONNECT_TIMEOUT)
        .await
        .context("connecting to session worker")?;
    let hello = read_hello(&mut stream).await?;
    if hello.state != "awaiting_start" {
        bail!("worker in unexpected state {:?}", hello.state);
    }

    let start = wire::StartSpec {
        cwd: spec.cwd.to_string(),
        argv: spec.argv.to_vec(),
        env: spec.env.clone(),
        cols: spec.cols,
        rows: spec.rows,
    };
    wire::write_json_frame(&mut stream, wire::T_START, &start)
        .await
        .context("sending Start to worker")?;
    let started = tokio::time::timeout(START_TIMEOUT, async {
        loop {
            match wire::read_frame(&mut stream).await? {
                Some((wire::T_STARTED, payload)) => {
                    return wire::decode_json::<wire::Started>(&payload)
                }
                Some((wire::T_ERROR, payload)) => {
                    let err: wire::WorkerError = wire::decode_json(&payload)?;
                    bail!("worker failed to start agent: {}", err.message);
                }
                Some(_) => continue,
                None => bail!("worker closed connection before Started"),
            }
        }
    })
    .await
    .map_err(|_| anyhow!("timed out waiting for worker Started"))??;

    Ok(assemble(
        spec.agent_id,
        spec.session.to_string(),
        started.pid,
        spec.cols,
        spec.rows,
        stream,
    ))
}

/// Adopt an already-running worker (spawnd restart / lazy attach). Returns
/// `Ok(None)` when no live worker socket exists for this agent.
pub async fn adopt(agent_id: Uuid, session_label: &str) -> Result<Option<pty::Launched>> {
    let dir = worker_dir()?;
    let socket = socket_path(&dir, agent_id);
    if !socket.exists() {
        return Ok(None);
    }
    let mut stream = match connect_with_retry(&socket, ADOPT_CONNECT_TIMEOUT).await {
        Ok(s) => s,
        Err(_) => {
            // Dead socket left by a crashed worker: clean it up.
            let _ = std::fs::remove_file(&socket);
            return Ok(None);
        }
    };
    let hello = read_hello(&mut stream).await?;
    if hello.state == "awaiting_start" {
        // Orphan that never got its Start; tell it to go away.
        let _ = wire::write_json_frame(
            &mut stream,
            wire::T_SHUTDOWN,
            &wire::Shutdown { signal: None },
        )
        .await;
        return Ok(None);
    }
    tracing::info!(%agent_id, state = %hello.state, pid = ?hello.pid, "adopting session worker");
    Ok(Some(assemble(
        agent_id,
        session_label.to_string(),
        hello.pid.unwrap_or(0),
        hello.cols.max(1),
        hello.rows.max(1),
        stream,
    )))
}

/// Restart-only liveness probe: is a worker still holding this agent's
/// socket? Connecting displaces the worker's active connection, so callers
/// must only probe after the agent's handle has been removed (the old
/// connection is being torn down anyway). A stale socket from a crashed
/// worker is cleaned up as a side effect.
pub async fn socket_live(agent_id: Uuid) -> bool {
    let Ok(dir) = worker_dir() else {
        return false;
    };
    let socket = socket_path(&dir, agent_id);
    if !socket.exists() {
        return false;
    }
    match UnixStream::connect(&socket).await {
        Ok(_) => true,
        Err(_) => {
            let _ = std::fs::remove_file(&socket);
            false
        }
    }
}

/// Agent ids with a worker socket present (candidates for adoption).
pub fn discover_ids() -> Vec<Uuid> {
    let Ok(dir) = worker_dir() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let stem = name.strip_suffix(".sock")?;
            Uuid::parse_str(stem).ok()
        })
        .collect()
}

/// Wire a connected worker stream into the standard per-agent plumbing:
/// outbox → forwarder (shared with the tmux backend), a command channel for
/// stdin/resize/replay/shutdown, and an exit oneshot.
fn assemble(
    agent_id: Uuid,
    session: String,
    pid: u32,
    cols: u16,
    rows: u16,
    stream: UnixStream,
) -> pty::Launched {
    let (outbox_tx, outbox_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let control = ForwarderControl::new();
    tokio::spawn(pty::run_forwarder(agent_id, outbox_rx, control.clone()));

    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<WorkerCmd>();
    let (exit_tx, exit_rx) = oneshot::channel::<ExitReason>();

    let (read_half, write_half) = stream.into_split();
    let pending: PendingReplays = Default::default();

    tokio::spawn(run_writer(write_half, cmd_rx, pending.clone(), agent_id));
    tokio::spawn(run_reader(
        read_half,
        outbox_tx.clone(),
        exit_tx,
        pending,
        agent_id,
    ));

    let handle = AgentHandle::new_worker(WorkerHandleParts {
        agent_id,
        session,
        cmd_tx,
        cols,
        rows,
        outbox_tx,
        control,
    });
    pty::Launched {
        handle,
        pid,
        exit_rx,
    }
}

type PendingReplays = std::sync::Arc<
    std::sync::Mutex<std::collections::VecDeque<oneshot::Sender<Result<(u64, Vec<u8>)>>>>,
>;

/// cmd channel → framed writes. Ends when the handle (and its cmd_tx) is
/// dropped, which also closes the worker connection's write side.
async fn run_writer(
    mut write_half: tokio::net::unix::OwnedWriteHalf,
    mut cmd_rx: mpsc::UnboundedReceiver<WorkerCmd>,
    pending: PendingReplays,
    agent_id: Uuid,
) {
    while let Some(cmd) = cmd_rx.recv().await {
        let res = match cmd {
            WorkerCmd::Input(bytes) => {
                wire::write_frame(&mut write_half, wire::T_INPUT, &bytes).await
            }
            WorkerCmd::Resize { cols, rows } => {
                wire::write_frame(
                    &mut write_half,
                    wire::T_RESIZE,
                    &wire::encode_resize(cols, rows),
                )
                .await
            }
            WorkerCmd::Redraw => wire::write_frame(&mut write_half, wire::T_REDRAW, b"").await,
            WorkerCmd::Replay { max_bytes, resp } => {
                pending.lock().expect("pending lock").push_back(resp);
                wire::write_frame(
                    &mut write_half,
                    wire::T_REPLAY_REQ,
                    &wire::encode_replay_req(max_bytes),
                )
                .await
            }
            WorkerCmd::Shutdown { signal } => {
                wire::write_json_frame(
                    &mut write_half,
                    wire::T_SHUTDOWN,
                    &wire::Shutdown { signal },
                )
                .await
            }
        };
        if let Err(e) = res {
            tracing::debug!(%agent_id, error = %e, "worker write failed");
            break;
        }
    }
    // Fail any replay waiters still queued.
    let mut pending = pending.lock().expect("pending lock");
    while let Some(waiter) = pending.pop_front() {
        let _ = waiter.send(Err(anyhow!("worker connection closed")));
    }
}

/// framed reads → outbox (output), replay responses, exit report.
async fn run_reader(
    mut read_half: tokio::net::unix::OwnedReadHalf,
    outbox_tx: mpsc::UnboundedSender<Vec<u8>>,
    exit_tx: oneshot::Sender<ExitReason>,
    pending: PendingReplays,
    agent_id: Uuid,
) {
    let mut exit_tx = Some(exit_tx);
    loop {
        match wire::read_frame(&mut read_half).await {
            Ok(Some((wire::T_OUTPUT, payload))) => {
                if outbox_tx.send(payload).is_err() {
                    break;
                }
            }
            Ok(Some((wire::T_REPLAY, payload))) => {
                let waiter = pending.lock().expect("pending lock").pop_front();
                if let Some(waiter) = waiter {
                    let result = wire::decode_replay(&payload)
                        .map(|(watermark, bytes)| (watermark, bytes.to_vec()));
                    let _ = waiter.send(result);
                }
            }
            Ok(Some((wire::T_EXIT, payload))) => {
                let info: wire::ExitInfo = wire::decode_json(&payload).unwrap_or(wire::ExitInfo {
                    exit_code: None,
                    signal: None,
                });
                if let Some(tx) = exit_tx.take() {
                    let _ = tx.send(ExitReason {
                        exit_code: info.exit_code,
                        signal: info.signal,
                    });
                }
                break;
            }
            Ok(Some((wire::T_ERROR, payload))) => {
                if let Ok(err) = wire::decode_json::<wire::WorkerError>(&payload) {
                    tracing::warn!(%agent_id, message = %err.message, "worker error");
                }
            }
            Ok(Some((wire::T_HELLO, _))) => {}
            Ok(Some((other, _))) => {
                tracing::debug!(%agent_id, frame_type = other, "ignoring worker frame");
            }
            Ok(None) | Err(_) => {
                // Connection lost without an Exit: distinguish "we dropped
                // the handle" (registry removal; exit already handled
                // elsewhere) from "worker vanished".
                if let Some(tx) = exit_tx.take() {
                    let _ = tx.send(ExitReason {
                        exit_code: None,
                        signal: Some("worker_lost".into()),
                    });
                }
                break;
            }
        }
    }
}

async fn connect_with_retry(socket: &std::path::Path, timeout: Duration) -> Result<UnixStream> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        match UnixStream::connect(socket).await {
            Ok(stream) => return Ok(stream),
            Err(e) => {
                if tokio::time::Instant::now() >= deadline {
                    return Err(e).with_context(|| format!("connecting {}", socket.display()));
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
    }
}

async fn read_hello(stream: &mut UnixStream) -> Result<wire::Hello> {
    let frame = tokio::time::timeout(CONNECT_TIMEOUT, wire::read_frame(stream))
        .await
        .map_err(|_| anyhow!("timed out waiting for worker Hello"))??;
    let Some((wire::T_HELLO, payload)) = frame else {
        bail!("worker did not send Hello first");
    };
    let hello: wire::Hello = wire::decode_json(&payload)?;
    if hello.version != wire::PROTO_VERSION {
        bail!(
            "worker protocol version {} != supported {}",
            hello.version,
            wire::PROTO_VERSION
        );
    }
    Ok(hello)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_parses_and_defaults_to_tmux() {
        assert_eq!(parse_backend("worker"), Some(BackendKind::Worker));
        assert_eq!(parse_backend("SESSIOND"), Some(BackendKind::Worker));
        assert_eq!(parse_backend("tmux"), Some(BackendKind::Tmux));
        assert_eq!(parse_backend("bogus"), None);
    }

    /// The spawn-worker binary as built alongside this test binary
    /// (target/debug/deps/spawnd-<hash> → target/debug/spawn-worker).
    fn built_worker_bin() -> PathBuf {
        let exe = std::env::current_exe().expect("current_exe");
        exe.parent()
            .and_then(|deps| deps.parent())
            .map(|debug| debug.join("spawn-worker"))
            .expect("worker bin path")
    }

    async fn collect_direct_until(
        rx: &mut mpsc::UnboundedReceiver<Vec<u8>>,
        needle: &[u8],
    ) -> Vec<u8> {
        let mut acc = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out waiting for {:?}; got {:?}",
                String::from_utf8_lossy(needle),
                String::from_utf8_lossy(&acc)
            );
            match tokio::time::timeout(Duration::from_secs(15), rx.recv()).await {
                Ok(Some(chunk)) => {
                    acc.extend_from_slice(&chunk);
                    if acc.windows(needle.len()).any(|w| w == needle) {
                        return acc;
                    }
                }
                _ => panic!("direct sink closed while waiting"),
            }
        }
    }

    /// Full supervisor-side round trip through the exact plumbing the
    /// DataChannel path uses: launch → forwarder → direct sink, stdin via the
    /// handle, replay, drop-handle-then-adopt, shutdown → exit_rx.
    #[tokio::test]
    async fn worker_launch_adopt_and_shutdown_roundtrip() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::env::set_var("SPAWND_WORKER_DIR", dir.path());
        std::env::set_var("SPAWND_WORKER_BIN", built_worker_bin());

        let agent_id = Uuid::new_v4();
        let argv: Vec<String> = ["/bin/sh", "-c", "printf 'wb-hello\\n'; cat"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let mut env = std::collections::BTreeMap::new();
        env.insert(
            "PATH".to_string(),
            std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into()),
        );
        env.insert("TERM".to_string(), "xterm-256color".to_string());

        let launched = launch(pty::LaunchSpec {
            agent_id,
            session: "spawn-test-worker",
            cwd: "/",
            cols: 80,
            rows: 24,
            argv: &argv,
            env: &env,
        })
        .await
        .expect("worker launch");
        assert!(launched.pid > 0);
        assert!(launched.handle.is_worker());

        // Keep the forwarder unblocked the way a live WS session would.
        let (ws_tx, mut ws_rx) = mpsc::channel(1024);
        launched.handle.control.set_sink(ws_tx).await;
        tokio::spawn(async move { while ws_rx.recv().await.is_some() {} });

        // DataChannel-style direct sink sees live output.
        let (dc_tx, mut dc_rx) = mpsc::unbounded_channel();
        launched
            .handle
            .control
            .add_direct_sink("test-dc".into(), dc_tx)
            .await;
        collect_direct_until(&mut dc_rx, b"wb-hello").await;

        // stdin through the handle reaches the PTY (cat echoes).
        launched.handle.write_stdin(b"ping-1\n").expect("stdin");
        collect_direct_until(&mut dc_rx, b"ping-1").await;

        // Replay covers everything so far.
        let replay_rx = launched.handle.worker_replay(1 << 20).expect("replay req");
        let (watermark, bytes) = replay_rx.await.expect("replay resp").expect("replay ok");
        assert!(watermark > 0);
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("wb-hello"), "replay missing output: {text:?}");
        assert!(
            text.contains("ping-1"),
            "replay missing stdin echo: {text:?}"
        );

        // Simulate a spawnd restart: drop the handle, adopt the live worker.
        drop(launched);
        tokio::time::sleep(Duration::from_millis(150)).await;
        let adopted = adopt(agent_id, "spawn-test-worker")
            .await
            .expect("adopt ok")
            .expect("worker should still be alive");
        assert!(adopted.pid > 0);

        let (ws_tx, mut ws_rx) = mpsc::channel(1024);
        adopted.handle.control.set_sink(ws_tx).await;
        tokio::spawn(async move { while ws_rx.recv().await.is_some() {} });
        let (dc_tx, mut dc_rx) = mpsc::unbounded_channel();
        adopted
            .handle
            .control
            .add_direct_sink("test-dc-2".into(), dc_tx)
            .await;

        adopted.handle.write_stdin(b"ping-2\n").expect("stdin");
        collect_direct_until(&mut dc_rx, b"ping-2").await;

        // Shutdown: exit_rx resolves and the worker cleans up its socket.
        assert!(adopted.handle.worker_shutdown(Some("TERM".into())));
        let reason = tokio::time::timeout(Duration::from_secs(15), adopted.exit_rx)
            .await
            .expect("exit timed out")
            .expect("exit_rx dropped");
        assert!(
            reason.exit_code.is_some() || reason.signal.is_some(),
            "exit reason should carry a code or signal: {reason:?}"
        );
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while socket_live(agent_id).await {
            assert!(
                tokio::time::Instant::now() < deadline,
                "worker socket never went away"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    #[test]
    fn per_agent_env_overrides_backend() {
        let create = AgentCreate {
            agent_id: Uuid::new_v4(),
            cwd: "/".into(),
            argv: vec!["bash".into()],
            env: [("SPAWND_SESSION_BACKEND".to_string(), "worker".to_string())]
                .into_iter()
                .collect(),
            install: None,
            skills: vec![],
            tmux_session: "spawn-test".into(),
            cols: 80,
            rows: 24,
            create_cwd: false,
        };
        assert_eq!(backend_for_create(&create), BackendKind::Worker);
    }
}
