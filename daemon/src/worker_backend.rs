//! spawnd-side supervision of mandatory session workers (docs/SESSIOND.md).
//!
//! For each worker agent, spawnd:
//! - spawns `spawn-worker` in its own process group (so it survives spawnd
//!   restarts and upgrades),
//! - connects to its unix socket and drives the framed `sessiond::wire`
//!   protocol,
//! - bridges worker output into the per-agent outbox → forwarder →
//!   {WS sink, DataChannel direct sinks} pipeline,
//! - delivers fixed-size TERM/KILL requests through the worker's independent
//!   lifecycle socket, where stable child ownership guards the signal,
//! - adopts already-running workers after a restart by scanning the socket
//!   directory (the worker greets every connection with `Hello`).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use sha2::{Digest, Sha256};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;
use zeroize::Zeroizing;

use spawnd::sessiond::wire;
use spawnd::sessiond::{endpoint, endpoint::LockAttempt};

use crate::config;
use crate::pty::{self, AgentHandle, ExitReason, ForwarderControl, WorkerCmd, WorkerHandleParts};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const ADOPT_CONNECT_TIMEOUT: Duration = Duration::from_millis(750);
const START_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_HELLO_FRAME_BYTES: usize = 4 * 1024;
const MAX_STARTED_FRAME_BYTES: usize = 1024;
const MAX_LIVE_OUTPUT_FRAME_BYTES: usize = 64 * 1024 + 8;
const MAX_EXIT_FRAME_BYTES: usize = 4 * 1024;
const MAX_WORKER_ERROR_FRAME_BYTES: usize = 16 * 1024;

fn worker_frame_limit(frame_type: u8) -> Option<usize> {
    match frame_type {
        wire::T_HELLO => Some(MAX_HELLO_FRAME_BYTES),
        wire::T_STARTED => Some(MAX_STARTED_FRAME_BYTES),
        wire::T_OUTPUT => Some(MAX_LIVE_OUTPUT_FRAME_BYTES),
        wire::T_REPLAY => Some(wire::MAX_FRAME_LEN),
        wire::T_REPLAY2 => Some(wire::MAX_FRAME_LEN),
        // One committed batch is bounded by the emulator's drain window, but
        // an `ED 2` on a huge screen can commit a full viewport at once.
        wire::T_HISTORY => Some(wire::MAX_FRAME_LEN),
        wire::T_HISTORY_WIPE => Some(8),
        wire::T_EXIT => Some(MAX_EXIT_FRAME_BYTES),
        wire::T_ERROR => Some(MAX_WORKER_ERROR_FRAME_BYTES),
        _ => None,
    }
}

/// Process environment is global; worker integration tests that override the
/// binary/socket paths must serialize with RTC acceptance tests doing the same.
#[cfg(test)]
pub(crate) static WORKER_TEST_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Directory holding worker sockets and scrollback dirs:
/// `$SPAWND_WORKER_DIR` → `$XDG_RUNTIME_DIR/spawn/workers` → config dir — with
/// one hard constraint: the unix-socket paths it hands out must fit the
/// platform's `sun_path` limit (104 bytes on macOS). macOS has no
/// `XDG_RUNTIME_DIR`, so the fallback lands in
/// `~/Library/Application Support/spawn/workers`; the `<uuid>.lifecycle.sock`
/// under it is 107 bytes and `bind(2)` rejects it — every worker fails to
/// start. When the preferred base can't hold a full-length socket leaf we
/// divert to a short private directory instead.
pub fn worker_dir() -> Result<PathBuf> {
    let dir = if let Some(dir) = std::env::var_os("SPAWND_WORKER_DIR").filter(|v| !v.is_empty()) {
        // An explicit override is trusted verbatim; a too-long path here is the
        // operator's to answer for and surfaces loudly at bind time.
        PathBuf::from(dir)
    } else {
        let tag = config_root_tag();
        choose_worker_dir(
            dirs::runtime_dir(),
            &tag,
            || Ok(config::config_dir()?.join("workers")),
            socket_dir_fits,
            || short_worker_dir(&tag),
        )?
    };
    endpoint::ensure_private_dir(&dir)?;
    Ok(dir)
}

/// Per-config-root suffix that isolates the worker runtime directory when an
/// explicit `SPAWN_CONFIG_DIR` is in use. Two instances under one OS user share
/// `$XDG_RUNTIME_DIR` and `/tmp`, so without this they would land in the same
/// worker dir and adopt each other's workers on restart. Empty for the default
/// single instance, which keeps its path byte-for-byte unchanged.
fn config_root_tag() -> String {
    root_tag_for(
        std::env::var_os("SPAWN_CONFIG_DIR")
            .filter(|v| !v.is_empty())
            .as_deref(),
    )
}

fn root_tag_for(root: Option<&std::ffi::OsStr>) -> String {
    match root {
        None => String::new(),
        Some(root) => {
            let canonical = std::fs::canonicalize(root).unwrap_or_else(|_| PathBuf::from(root));
            let digest = Sha256::digest(canonical.as_os_str().as_encoded_bytes());
            format!(
                "-{:02x}{:02x}{:02x}{:02x}",
                digest[0], digest[1], digest[2], digest[3]
            )
        }
    }
}

/// Prefer the runtime dir, fall back to the config dir — but only while the
/// choice can still hold a full-length socket path; otherwise take `short`.
/// `config_workers`/`short` are thunks so neither is materialized (the config
/// dir is created as a side effect) unless actually chosen. Factored out and
/// parameterized on `fits`/`short` so the divert branch is unit-testable on a
/// host whose real `sun_path` limit wouldn't trip it.
fn choose_worker_dir(
    runtime_dir: Option<PathBuf>,
    tag: &str,
    config_workers: impl FnOnce() -> Result<PathBuf>,
    fits: impl Fn(&std::path::Path) -> bool,
    short: impl FnOnce() -> Result<PathBuf>,
) -> Result<PathBuf> {
    let preferred = match runtime_dir {
        // The config-dir fallback is already per-root (it *is* SPAWN_CONFIG_DIR);
        // only the shared runtime dir needs the tag to stay per-instance.
        Some(run) => run.join(format!("spawn{tag}")).join("workers"),
        None => config_workers()?,
    };
    if fits(&preferred) {
        Ok(preferred)
    } else {
        short()
    }
}

/// The longest socket leaf `worker_dir()` ever hosts: `<uuid>.lifecycle.sock`
/// (`wire::lifecycle_socket_path`). A UUID renders as 36 characters.
const LONGEST_SOCKET_LEAF_LEN: usize = 36 + ".lifecycle.sock".len();

/// Usable `sun_path` length: the fixed buffer minus its NUL terminator.
/// macOS/BSD carry a 104-byte buffer → 103; Linux 108 → 107.
#[cfg(target_os = "macos")]
const SUN_PATH_STRLEN_MAX: usize = 103;
#[cfg(not(target_os = "macos"))]
const SUN_PATH_STRLEN_MAX: usize = 107;

/// Whether `dir/<longest-leaf>` still fits an addressable socket path.
fn path_fits(dir_len: usize, sun_path_strlen_max: usize) -> bool {
    // dir + '/' + leaf, and the address as a whole still needs its NUL.
    dir_len + 1 + LONGEST_SOCKET_LEAF_LEN <= sun_path_strlen_max
}

/// Whether every socket `worker_dir()` will bind under `dir` fits `sun_path`.
fn socket_dir_fits(dir: &std::path::Path) -> bool {
    path_fits(
        dir.as_os_str().as_encoded_bytes().len(),
        SUN_PATH_STRLEN_MAX,
    )
}

/// Shortest reliably-private directory whose socket paths fit `sun_path` on
/// every platform: `/tmp/spawn-<uid>/workers`. `/tmp` is sticky, and
/// `ensure_private_dir` creates our subtree 0700 and rejects any pre-existing
/// node we don't own — so a hostile `/tmp` entry can't redirect the daemon.
/// (`std::env::temp_dir()` is deliberately avoided: `$TMPDIR` on macOS is a
/// ~50-char path that would defeat the whole point.)
fn short_worker_dir(tag: &str) -> Result<PathBuf> {
    let uid = nix::unistd::Uid::effective().as_raw();
    let base = PathBuf::from("/tmp").join(format!("spawn-{uid}{tag}"));
    // Harden the per-uid parent too; ensure_private_dir only secures the leaf.
    endpoint::ensure_private_dir(&base)?;
    Ok(base.join("workers"))
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
    let reservation = match endpoint::try_reserve(&socket)? {
        LockAttempt::Acquired(lock) => lock,
        LockAttempt::Busy => bail!("worker endpoint is already owned"),
    };
    let bin = worker_bin();
    let mut cmd = std::process::Command::new(&bin);
    cmd.arg("--socket")
        .arg(&socket)
        .arg("--agent-id")
        .arg(spec.agent_id.to_string())
        .arg("--log-dir")
        .arg(&logs)
        .arg("--lock-fd")
        .arg(reservation.raw_fd().to_string())
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
        let lock_fd = reservation.raw_fd();
        // Clear CLOEXEC only in the post-fork child. The multithreaded
        // supervisor never exposes this reservation to unrelated concurrent
        // child launches.
        unsafe {
            cmd.pre_exec(move || {
                let flags = nix::libc::fcntl(lock_fd, nix::libc::F_GETFD);
                if flags < 0
                    || nix::libc::fcntl(lock_fd, nix::libc::F_SETFD, flags & !nix::libc::FD_CLOEXEC)
                        < 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    let child_result = cmd
        .spawn()
        .with_context(|| format!("spawning {}", bin.display()));
    let child = child_result?;
    drop(reservation);
    tracing::info!(agent_id = %spec.agent_id, worker_pid = child.id(), "spawned session worker");
    // Move the worker into its per-agent CPU scope before the agent spawns
    // (T_START below) so the whole agent tree inherits the cgroup.
    crate::cpu_scopes::enroll_worker(spec.agent_id, child.id()).await;

    let mut stream = connect_with_retry(&socket, CONNECT_TIMEOUT)
        .await
        .context("connecting to session worker")?;
    let hello = read_hello(&mut stream, spec.agent_id).await?;
    if hello.state != "awaiting_start" {
        bail!("worker is not available for a new agent");
    }
    subscribe_history(&mut stream, &hello).await?;

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
            match wire::read_frame_limited(&mut stream, worker_frame_limit).await? {
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
        started.pid,
        WorkerConnection {
            cwd: started.cwd,
            cols: spec.cols,
            rows: spec.rows,
            lifecycle_socket: wire::lifecycle_socket_path(&socket),
            lifecycle_instance: hello.instance_id,
            stream,
        },
    ))
}

/// Subscribe to committed-history deltas when the worker advertises support.
/// Workers never emit the new frame types unsubscribed, so old workers (no
/// advertisement) and old daemons (no subscription) both stay on the legacy
/// replay-only flow.
async fn subscribe_history(stream: &mut UnixStream, hello: &wire::Hello) -> Result<()> {
    if hello.history {
        wire::write_frame(stream, wire::T_HISTORY_SUB, &[])
            .await
            .context("subscribing to worker history deltas")?;
    }
    Ok(())
}

/// Adopt an already-running worker (spawnd restart / lazy attach). Returns
/// `Ok(None)` when no live worker socket exists for this agent.
pub async fn adopt(agent_id: Uuid) -> Result<Option<pty::Launched>> {
    let dir = worker_dir()?;
    let socket = socket_path(&dir, agent_id);
    if !socket.exists() {
        return Ok(None);
    }
    let mut stream = match connect_with_retry(&socket, ADOPT_CONNECT_TIMEOUT).await {
        Ok(s) => s,
        Err(_) => {
            cleanup_crashed_worker_endpoints(&socket);
            return Ok(None);
        }
    };
    let hello = read_hello(&mut stream, agent_id).await?;
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
    subscribe_history(&mut stream, &hello).await?;
    Ok(Some(assemble(
        agent_id,
        hello.pid.unwrap_or(0),
        WorkerConnection {
            cwd: hello
                .cwd
                .context("worker did not retain its cwd capability root")?,
            cols: hello.cols.max(1),
            rows: hello.rows.max(1),
            lifecycle_socket: wire::lifecycle_socket_path(&socket),
            lifecycle_instance: hello.instance_id,
            stream,
        },
    )))
}

/// Whether the worker socket still exists. This deliberately does not connect:
/// accepting a probe would displace the active supervisor connection and
/// could fence a queued TERM/KILL command during restart.
pub fn socket_exists(agent_id: Uuid) -> bool {
    let Ok(dir) = worker_dir() else {
        return false;
    };
    socket_path(&dir, agent_id).exists()
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
/// outbox → forwarder, a command channel for stdin/resize/replay, a separate
/// acknowledged lifecycle channel, and an exit oneshot.
struct WorkerConnection {
    cwd: String,
    cols: u16,
    rows: u16,
    lifecycle_socket: PathBuf,
    lifecycle_instance: Uuid,
    stream: UnixStream,
}

fn assemble(agent_id: Uuid, pid: u32, connection: WorkerConnection) -> pty::Launched {
    let WorkerConnection {
        cwd,
        cols,
        rows,
        lifecycle_socket,
        lifecycle_instance,
        stream,
    } = connection;
    let (outbox_tx, outbox_rx) = mpsc::channel::<pty::OutputChunk>(pty::WORKER_OUTPUT_QUEUE_DEPTH);
    let control = ForwarderControl::new();
    tokio::spawn(pty::run_forwarder(agent_id, outbox_rx, control.clone()));

    let (cmd_tx, cmd_rx) = mpsc::channel::<WorkerCmd>(pty::WORKER_COMMAND_QUEUE_DEPTH);
    let (exit_tx, exit_rx) = oneshot::channel::<ExitReason>();

    let (read_half, write_half) = stream.into_split();
    let pending: PendingReplays = Default::default();
    let alive = Arc::new(AtomicBool::new(true));

    tokio::spawn(run_writer(
        write_half,
        cmd_rx,
        pending.clone(),
        Arc::clone(&alive),
        agent_id,
    ));
    tokio::spawn(run_reader(
        read_half,
        outbox_tx.clone(),
        control.clone(),
        exit_tx,
        pending,
        Arc::clone(&alive),
        agent_id,
    ));

    let handle = AgentHandle::new_worker(WorkerHandleParts {
        agent_id,
        cwd,
        cmd_tx,
        lifecycle: pty::AgentLifecycle::new(lifecycle_socket, lifecycle_instance),
        alive,
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

type ReplayWaiter = oneshot::Sender<pty::WorkerReplayResult>;
type PendingReplays = std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<ReplayWaiter>>>;
const MAX_PENDING_REPLAYS: usize = 8;

/// cmd channel → framed writes. Ends when the handle (and its cmd_tx) is
/// dropped, which also closes the worker connection's write side.
async fn run_writer(
    mut write_half: tokio::net::unix::OwnedWriteHalf,
    mut cmd_rx: mpsc::Receiver<WorkerCmd>,
    pending: PendingReplays,
    alive: Arc<AtomicBool>,
    agent_id: Uuid,
) {
    while let Some(cmd) = cmd_rx.recv().await {
        if !alive.load(Ordering::Acquire) {
            break;
        }
        let res = match cmd {
            WorkerCmd::Input(bytes) => {
                let result = wire::write_frame(&mut write_half, wire::T_INPUT, &bytes).await;
                result
            }
            WorkerCmd::Resize { cols, rows } => {
                wire::write_frame(
                    &mut write_half,
                    wire::T_RESIZE,
                    &wire::encode_resize(cols, rows),
                )
                .await
            }
            WorkerCmd::Replay { max_bytes, resp } => {
                if let Err(resp) = enqueue_pending_replay(&pending, resp) {
                    let _ = resp.send(Err(anyhow!("too many pending worker replay requests")));
                    continue;
                }
                wire::write_frame(
                    &mut write_half,
                    wire::T_REPLAY_REQ,
                    &wire::encode_replay_req(max_bytes),
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
    fail_pending_replays(&pending);
}

fn enqueue_pending_replay(
    pending: &PendingReplays,
    resp: ReplayWaiter,
) -> std::result::Result<(), ReplayWaiter> {
    let mut waiters = pending.lock().expect("pending lock");
    if waiters.len() >= MAX_PENDING_REPLAYS {
        return Err(resp);
    }
    waiters.push_back(resp);
    Ok(())
}

fn fail_pending_replays(pending: &PendingReplays) {
    let mut pending = pending.lock().expect("pending lock");
    while let Some(waiter) = pending.pop_front() {
        let _ = waiter.send(Err(anyhow!("worker connection closed")));
    }
}

/// framed reads → outbox (output), replay responses, exit report.
async fn run_reader(
    mut read_half: tokio::net::unix::OwnedReadHalf,
    outbox_tx: mpsc::Sender<pty::OutputChunk>,
    control: ForwarderControl,
    exit_tx: oneshot::Sender<ExitReason>,
    pending: PendingReplays,
    alive: Arc<AtomicBool>,
    agent_id: Uuid,
) {
    let mut exit_tx = Some(exit_tx);
    loop {
        match wire::read_frame_limited(&mut read_half, worker_frame_limit).await {
            Ok(Some((wire::T_OUTPUT, payload))) => {
                let payload = Zeroizing::new(payload);
                match wire::decode_output(&payload) {
                    Ok((watermark, bytes)) => {
                        let chunk = pty::OutputChunk::classify_at_source(
                            bytes.to_vec(),
                            watermark,
                            &control,
                        );
                        if outbox_tx.send(chunk).await.is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        tracing::warn!(%agent_id, %error, "invalid worker output frame");
                        break;
                    }
                }
            }
            Ok(Some((wire::T_REPLAY, payload))) => {
                let payload = Zeroizing::new(payload);
                let waiter = pending.lock().expect("pending lock").pop_front();
                if let Some(waiter) = waiter {
                    let result = match wire::decode_replay(&payload) {
                        Ok((watermark, bytes)) => {
                            let replay = bytes.to_vec();
                            let barrier = pty::OutputChunk::source_barrier(watermark);
                            let _ = outbox_tx.send(barrier).await;
                            Ok(pty::WorkerReplay::new(watermark, replay))
                        }
                        Err(error) => Err(error),
                    };
                    send_replay_result(waiter, result);
                }
            }
            Ok(Some((wire::T_REPLAY2, payload))) => {
                let payload = Zeroizing::new(payload);
                let waiter = pending.lock().expect("pending lock").pop_front();
                if let Some(waiter) = waiter {
                    let result = match wire::decode_replay2(&payload) {
                        Ok((watermark, anchor, bytes)) => {
                            let replay = bytes.to_vec();
                            let barrier = pty::OutputChunk::source_barrier(watermark);
                            let _ = outbox_tx.send(barrier).await;
                            Ok(pty::WorkerReplay::new_with_history(
                                watermark,
                                replay,
                                (anchor.epoch, anchor.offset),
                            ))
                        }
                        Err(error) => Err(error),
                    };
                    send_replay_result(waiter, result);
                }
            }
            Ok(Some((wire::T_HISTORY, payload))) => {
                let payload = Zeroizing::new(payload);
                match wire::decode_history(&payload) {
                    Ok((anchor, bytes)) => {
                        control
                            .route_history(anchor.epoch, Some(anchor.offset), bytes)
                            .await;
                    }
                    Err(error) => {
                        tracing::warn!(%agent_id, %error, "invalid worker history frame");
                    }
                }
            }
            Ok(Some((wire::T_HISTORY_WIPE, payload))) => {
                let payload = Zeroizing::new(payload);
                match wire::decode_history_wipe(&payload) {
                    Ok(epoch) => control.route_history(epoch, None, &[]).await,
                    Err(error) => {
                        tracing::warn!(%agent_id, %error, "invalid worker history wipe frame");
                    }
                }
            }
            Ok(Some((wire::T_EXIT, payload))) => {
                let payload = Zeroizing::new(payload);
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
                let payload = Zeroizing::new(payload);
                if let Ok(err) = wire::decode_json::<wire::WorkerError>(&payload) {
                    tracing::warn!(%agent_id, message = %err.message, "worker error");
                    if let Some(waiter) = pending.lock().expect("pending lock").pop_front() {
                        let _ = waiter.send(Err(anyhow!("worker replay failed: {}", err.message)));
                    }
                }
            }
            Ok(Some((wire::T_HELLO, payload))) => {
                drop(Zeroizing::new(payload));
            }
            Ok(Some((other, payload))) => {
                drop(Zeroizing::new(payload));
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
    alive.store(false, Ordering::Release);
    fail_pending_replays(&pending);
}

fn send_replay_result(waiter: ReplayWaiter, result: pty::WorkerReplayResult) {
    // WorkerReplay owns its zeroization, including the rejected-send value.
    let _ = waiter.send(result);
}

async fn connect_with_retry(socket: &std::path::Path, timeout: Duration) -> Result<UnixStream> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        match UnixStream::connect(socket).await {
            Ok(stream) => {
                if endpoint::validate_private_socket(socket).is_ok()
                    && endpoint::validate_stream_peer(&stream).is_ok()
                {
                    return Ok(stream);
                }
                if tokio::time::Instant::now() >= deadline {
                    return Err(anyhow!("worker endpoint validation failed"));
                }
            }
            Err(_) => {
                if tokio::time::Instant::now() >= deadline {
                    return Err(anyhow!("worker endpoint unreachable"));
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn cleanup_crashed_worker_endpoints(socket: &std::path::Path) {
    let Ok(LockAttempt::Acquired(_lock)) = endpoint::try_reserve(socket) else {
        return;
    };
    let _ = endpoint::remove_stale_socket(socket);
    let _ = endpoint::remove_stale_socket(&wire::lifecycle_socket_path(socket));
}

async fn read_hello(stream: &mut UnixStream, expected_agent_id: Uuid) -> Result<wire::Hello> {
    let frame = tokio::time::timeout(
        CONNECT_TIMEOUT,
        wire::read_frame_limited(stream, |frame_type| {
            (frame_type == wire::T_HELLO).then_some(MAX_HELLO_FRAME_BYTES)
        }),
    )
    .await
    .map_err(|_| anyhow!("timed out waiting for worker Hello"))??;
    let Some((wire::T_HELLO, payload)) = frame else {
        bail!("worker did not send Hello first");
    };
    let hello: wire::Hello = wire::decode_json(&payload)?;
    if hello.agent_id != expected_agent_id {
        bail!("worker Hello identity validation failed");
    }
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
    fn longest_socket_leaf_tracks_the_real_lifecycle_name() {
        // The length guard is only correct while it matches the actual longest
        // socket the worker binds. A nil UUID gives the canonical 36 chars.
        let socket = std::path::Path::new("/x").join(format!("{}.sock", Uuid::nil()));
        let leaf = wire::lifecycle_socket_path(&socket);
        let leaf = leaf.file_name().unwrap().to_string_lossy();
        assert!(leaf.ends_with(".lifecycle.sock"));
        assert_eq!(leaf.len(), LONGEST_SOCKET_LEAF_LEN);
    }

    #[test]
    fn macos_config_fallback_overflows_sun_path_but_linux_holds() {
        // The real macOS runtime fallback base. This is the regression the fix
        // exists for: its lifecycle socket is 107 bytes, past macOS's 103.
        let base = std::path::Path::new("/Users/jeremy/Library/Application Support/spawn/workers");
        let len = base.as_os_str().as_encoded_bytes().len();
        assert_eq!(len + 1 + LONGEST_SOCKET_LEAF_LEN, 107);
        assert!(!path_fits(len, 103), "must be rejected on macOS");
        assert!(path_fits(len, 107), "the same path is fine on Linux");
    }

    #[test]
    fn choose_worker_dir_diverts_only_when_the_preferred_base_overflows() {
        // Preferred base overflows → take the short dir; config thunk still runs
        // (no runtime dir) but its result is discarded for being too long.
        let short = PathBuf::from("/tmp/spawn-1/workers");
        let picked = choose_worker_dir(
            None,
            "",
            || {
                Ok(PathBuf::from(
                    "/Users/who/Library/Application Support/spawn/workers",
                ))
            },
            |_| false,
            || Ok(short.clone()),
        )
        .unwrap();
        assert_eq!(picked, short);

        // Runtime dir present and fits → keep it; neither fallback is touched.
        let picked = choose_worker_dir(
            Some(PathBuf::from("/run/user/1000")),
            "",
            || unreachable!("config dir must not be consulted when runtime dir is present"),
            |_| true,
            || unreachable!("short dir must not be built when the preferred base fits"),
        )
        .unwrap();
        assert_eq!(picked, PathBuf::from("/run/user/1000/spawn/workers"));

        // A per-root tag namespaces the shared runtime dir so two instances
        // under one OS user don't collide (and adopt each other's workers).
        let alice = choose_worker_dir(
            Some(PathBuf::from("/run/user/1000")),
            "-aabbccdd",
            || unreachable!(),
            |_| true,
            || unreachable!(),
        )
        .unwrap();
        assert_eq!(
            alice,
            PathBuf::from("/run/user/1000/spawn-aabbccdd/workers")
        );
    }

    #[test]
    fn config_root_tag_isolates_distinct_roots_and_is_empty_by_default() {
        assert_eq!(root_tag_for(None), "");
        let alice = root_tag_for(Some(std::ffi::OsStr::new("/srv/spawn/alice")));
        let bob = root_tag_for(Some(std::ffi::OsStr::new("/srv/spawn/bob")));
        assert_ne!(alice, bob);
        assert!(alice.starts_with('-') && alice.len() == 9); // '-' + 8 hex
    }

    #[tokio::test]
    async fn hello_agent_identity_is_validated_before_instance_trust() {
        let expected = Uuid::new_v4();
        let received = Uuid::new_v4();
        let (mut client, mut peer) = UnixStream::pair().unwrap();
        let writer = tokio::spawn(async move {
            wire::write_json_frame(
                &mut peer,
                wire::T_HELLO,
                &wire::Hello {
                    version: wire::PROTO_VERSION,
                    agent_id: received,
                    instance_id: Uuid::new_v4(),
                    state: "running".into(),
                    pid: Some(10),
                    cols: 80,
                    rows: 24,
                    cwd: Some("/".into()),
                    history: false,
                },
            )
            .await
            .unwrap();
        });
        let error = read_hello(&mut client, expected)
            .await
            .unwrap_err()
            .to_string();
        assert_eq!(error, "worker Hello identity validation failed");
        assert!(!error.contains(&received.to_string()));
        writer.await.unwrap();
    }

    #[tokio::test]
    async fn unreachable_endpoint_error_does_not_echo_its_path() {
        let dir = tempfile::tempdir().unwrap();
        let private_name = "private-endpoint-name.sock";
        let error = connect_with_retry(&dir.path().join(private_name), Duration::from_millis(1))
            .await
            .unwrap_err()
            .to_string();
        assert_eq!(error, "worker endpoint unreachable");
        assert!(!error.contains(private_name));
    }

    #[test]
    fn replay_wipes_after_successful_send_then_receiver_cancellation() {
        let observed = Arc::new(std::sync::Mutex::new(Vec::new()));
        let probe = {
            let observed = Arc::clone(&observed);
            Arc::new(move |bytes: &[u8]| observed.lock().unwrap().extend_from_slice(bytes))
        };
        let (waiter, receiver) = oneshot::channel();
        send_replay_result(
            waiter,
            Ok(pty::WorkerReplay::with_wipe_probe(
                7,
                b"decrypted replay bytes".to_vec(),
                probe,
            )),
        );
        drop(receiver);
        let observed = observed.lock().unwrap();
        assert_eq!(observed.len(), b"decrypted replay bytes".len());
        assert!(observed.iter().all(|byte| *byte == 0));
    }

    #[tokio::test]
    async fn stalled_worker_socket_caps_and_rejects_fast_input() {
        let agent_id = Uuid::new_v4();
        let (daemon_stream, worker_stream) = UnixStream::pair().expect("unix pair");
        let (read_half, write_half) = daemon_stream.into_split();
        drop(read_half);
        let (cmd_tx, cmd_rx) = mpsc::channel(pty::WORKER_COMMAND_QUEUE_DEPTH);
        let capacity_probe = cmd_tx.clone();
        let (outbox_tx, _outbox_rx) = mpsc::channel(pty::WORKER_OUTPUT_QUEUE_DEPTH);
        let alive = Arc::new(AtomicBool::new(true));
        let writer = tokio::spawn(run_writer(
            write_half,
            cmd_rx,
            Default::default(),
            Arc::clone(&alive),
            agent_id,
        ));
        let handle = AgentHandle::new_worker(WorkerHandleParts {
            agent_id,
            cwd: "/".into(),
            cmd_tx,
            lifecycle: pty::AgentLifecycle::new(
                PathBuf::from("/nonexistent/spawn-test-lifecycle.sock"),
                Uuid::new_v4(),
            ),
            alive,
            cols: 80,
            rows: 24,
            outbox_tx,
            control: ForwarderControl::new(),
        });

        let input = vec![b'i'; pty::MAX_WORKER_INPUT_BYTES];
        let mut rejected = None;
        for _ in 0..10_000 {
            if let Err(error) = handle.write_stdin(&input) {
                rejected = Some(error);
                break;
            }
            tokio::task::yield_now().await;
        }
        let rejected = rejected.expect("stalled worker input never reached the bounded queue");
        assert!(rejected.to_string().contains("queue full"));
        assert_eq!(
            capacity_probe.max_capacity(),
            pty::WORKER_COMMAND_QUEUE_DEPTH
        );
        assert_eq!(capacity_probe.capacity(), 0);

        drop(handle);
        drop(capacity_probe);
        drop(worker_stream);
        tokio::time::timeout(Duration::from_secs(3), writer)
            .await
            .expect("stalled writer did not stop")
            .unwrap();
    }

    #[tokio::test]
    async fn worker_output_emits_content_free_activity_without_status_filtering() {
        let agent_id = Uuid::new_v4();
        let (daemon_stream, mut worker_stream) = UnixStream::pair().expect("unix pair");
        let (read_half, _write_half) = daemon_stream.into_split();

        let control = ForwarderControl::new();
        let (sink_tx, mut sink_rx) = mpsc::channel(4);
        control.set_sink(sink_tx).await;
        let (outbox_tx, outbox_rx) = mpsc::channel(pty::WORKER_OUTPUT_QUEUE_DEPTH);
        let forwarder = tokio::spawn(pty::run_forwarder(agent_id, outbox_rx, control.clone()));
        let (exit_tx, _exit_rx) = oneshot::channel();
        let reader = tokio::spawn(run_reader(
            read_half,
            outbox_tx,
            control,
            exit_tx,
            Default::default(),
            Arc::new(AtomicBool::new(true)),
            agent_id,
        ));

        wire::write_frame(
            &mut worker_stream,
            wire::T_OUTPUT,
            &wire::encode_output(5, b"12:34"),
        )
        .await
        .expect("worker output");
        let activity = sink_rx.recv().await.unwrap();
        assert!(activity.as_str().contains("agent.activity"));
        assert!(!activity.as_str().contains("12:34"));
        assert!(sink_rx.try_recv().is_err());

        drop(worker_stream);
        reader.await.unwrap();
        forwarder.await.unwrap();
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

    /// Wait for `needle` on the direct sink.
    ///
    /// KNOWN FLAKE: in a full-suite run this wait is bimodal — the first bytes
    /// either arrive in milliseconds or never (the accumulator is empty at the
    /// deadline), so the failure is a race with another test, not slowness.
    /// Raising the budget to 60s did not convert a single failure into a pass.
    /// Reproduces without any signed-signaling change, and never in isolation.
    async fn collect_direct_until(
        rx: &mut mpsc::Receiver<pty::DirectPayload>,
        needle: &[u8],
    ) -> Vec<u8> {
        let mut acc = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            assert!(
                !remaining.is_zero(),
                "timed out waiting for {:?}; got {:?}",
                String::from_utf8_lossy(needle),
                String::from_utf8_lossy(&acc)
            );
            match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Some(chunk)) => {
                    acc.extend_from_slice(&chunk);
                    if acc.windows(needle.len()).any(|w| w == needle) {
                        return acc;
                    }
                }
                // Distinguish the two failures: a closed sink is a real defect,
                // a timeout is the deadline above. Reporting both as "closed"
                // sends the next reader hunting the wrong bug.
                Ok(None) => panic!(
                    "direct sink closed while waiting for {:?}; got {:?}",
                    String::from_utf8_lossy(needle),
                    String::from_utf8_lossy(&acc)
                ),
                Err(_) => panic!(
                    "timed out waiting for {:?}; got {:?}",
                    String::from_utf8_lossy(needle),
                    String::from_utf8_lossy(&acc)
                ),
            }
        }
    }

    /// Full supervisor-side round trip through the exact plumbing the
    /// DataChannel path uses: launch → forwarder → direct sink, stdin via the
    /// handle, replay, drop-handle-then-adopt, shutdown → exit_rx.
    #[tokio::test]
    async fn worker_launch_adopt_and_priority_shutdown_roundtrip() {
        let _env_lock = WORKER_TEST_ENV_LOCK.lock().await;
        let old_dir = std::env::var_os("SPAWND_WORKER_DIR");
        let old_bin = std::env::var_os("SPAWND_WORKER_BIN");
        let dir = tempfile::tempdir().expect("tempdir");
        std::env::set_var("SPAWND_WORKER_DIR", dir.path());
        std::env::set_var("SPAWND_WORKER_BIN", built_worker_bin());

        let agent_id = Uuid::new_v4();
        let argv: Vec<String> = ["/bin/sh", "-c", "trap '' TERM; printf 'wb-hello\\n'; cat"]
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
            cwd: "/",
            cols: 80,
            rows: 24,
            argv: &argv,
            env: &env,
        })
        .await
        .expect("worker launch");
        assert!(launched.pid > 0);

        let duplicate = launch(pty::LaunchSpec {
            agent_id,
            cwd: "/",
            cols: 80,
            rows: 24,
            argv: &argv,
            env: &env,
        })
        .await;
        let duplicate_error = match duplicate {
            Ok(_) => panic!("duplicate same-agent launch unexpectedly succeeded"),
            Err(error) => error,
        };
        assert_eq!(
            duplicate_error.to_string(),
            "worker endpoint is already owned"
        );

        // Keep the forwarder unblocked the way a live WS session would.
        let (ws_tx, mut ws_rx) = mpsc::channel(1024);
        launched.handle.control.set_sink(ws_tx).await;
        tokio::spawn(async move { while ws_rx.recv().await.is_some() {} });

        // Establish the same replay barrier used before a real DataChannel is
        // registered. Historical worker watermarks may predate this spawnd.
        let initial_replay_rx = launched.handle.replay(1 << 20).expect("replay req");
        let initial_replay = initial_replay_rx
            .await
            .expect("replay resp")
            .expect("replay ok");
        let initial_watermark = initial_replay.watermark();
        launched
            .handle
            .control
            .wait_source_offset(initial_watermark)
            .await;
        let initial_replay_has_hello =
            String::from_utf8_lossy(initial_replay.bytes()).contains("wb-hello");
        drop(initial_replay);

        // DataChannel-style direct sink sees output after its exact origin.
        let mut direct = launched
            .handle
            .control
            .add_direct_sink("test-dc".into())
            .await;
        if !initial_replay_has_hello {
            collect_direct_until(&mut direct.receiver, b"wb-hello").await;
        }
        // stdin through the handle reaches the PTY (cat echoes).
        launched.handle.write_stdin(b"ping-1\n").expect("stdin");
        collect_direct_until(&mut direct.receiver, b"ping-1").await;

        // Replay covers everything so far.
        let replay_rx = launched.handle.replay(1 << 20).expect("replay req");
        let replay = replay_rx.await.expect("replay resp").expect("replay ok");
        assert!(replay.watermark() > 0);
        let text = String::from_utf8_lossy(replay.bytes());
        assert!(text.contains("wb-hello"), "replay missing output: {text:?}");
        assert!(
            text.contains("ping-1"),
            "replay missing stdin echo: {text:?}"
        );
        drop(replay);

        // Simulate a spawnd restart: drop the handle, adopt the live worker.
        drop(launched);
        tokio::time::sleep(Duration::from_millis(150)).await;
        let adopted = adopt(agent_id)
            .await
            .expect("adopt ok")
            .expect("worker should still be alive");
        assert!(adopted.pid > 0);

        let (ws_tx, mut ws_rx) = mpsc::channel(1024);
        adopted.handle.control.set_sink(ws_tx).await;
        tokio::spawn(async move { while ws_rx.recv().await.is_some() {} });
        let adopted_replay_rx = adopted.handle.replay(1 << 20).expect("adopt replay req");
        let adopted_replay = adopted_replay_rx
            .await
            .expect("adopt replay resp")
            .expect("adopt replay ok");
        let adopted_watermark = adopted_replay.watermark();
        adopted
            .handle
            .control
            .wait_source_offset(adopted_watermark)
            .await;
        assert!(String::from_utf8_lossy(adopted_replay.bytes()).contains("ping-1"));
        drop(adopted_replay);
        let mut direct = adopted
            .handle
            .control
            .add_direct_sink("test-dc-2".into())
            .await;

        adopted.handle.write_stdin(b"ping-2\n").expect("stdin");
        collect_direct_until(&mut direct.receiver, b"ping-2").await;

        // Model the exact saturated spawnd ordinary-command boundary while
        // retaining the real adopted worker's independent lifecycle
        // capability. No command receiver is polled during TERM/KILL.
        let (stalled_cmd_tx, _stalled_cmd_rx) = mpsc::channel(pty::WORKER_COMMAND_QUEUE_DEPTH);
        for _ in 0..pty::WORKER_COMMAND_QUEUE_DEPTH {
            stalled_cmd_tx
                .try_send(WorkerCmd::Input(pty::DirectPayload::new(vec![
                    b'i';
                    pty::MAX_WORKER_INPUT_BYTES
                ])))
                .expect("fill ordinary command queue");
        }
        assert_eq!(stalled_cmd_tx.capacity(), 0);
        let (priority_outbox, _priority_outbox_rx) = mpsc::channel(pty::WORKER_OUTPUT_QUEUE_DEPTH);
        let priority_handle = AgentHandle::new_worker(WorkerHandleParts {
            agent_id,
            cwd: "/".into(),
            cmd_tx: stalled_cmd_tx,
            lifecycle: adopted.handle.lifecycle(),
            alive: Arc::new(AtomicBool::new(true)),
            cols: 80,
            rows: 24,
            outbox_tx: priority_outbox,
            control: ForwarderControl::new(),
        });

        // Restart shutdown must not probe by connecting: a probe would become
        // the worker's current supervisor generation and fence this TERM.
        // The agent ignores TERM, so the independent lifecycle path must
        // remain usable for KILL escalation even if ordinary commands stall.
        let lifecycle = priority_handle.lifecycle();
        lifecycle
            .shutdown(wire::LifecycleSignal::Term)
            .await
            .expect("TERM delivery");
        let mut exit_rx = adopted.exit_rx;
        assert!(
            tokio::time::timeout(Duration::from_millis(300), &mut exit_rx)
                .await
                .is_err(),
            "TERM unexpectedly stopped the signal-ignoring test agent"
        );
        assert!(socket_exists(agent_id));
        lifecycle
            .shutdown(wire::LifecycleSignal::Kill)
            .await
            .expect("KILL delivery");
        let reason = tokio::time::timeout(Duration::from_secs(15), exit_rx)
            .await
            .expect("exit timed out")
            .expect("exit_rx dropped");
        assert!(
            reason.exit_code.is_some() || reason.signal.is_some(),
            "exit reason should carry a code or signal: {reason:?}"
        );
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while socket_exists(agent_id) {
            assert!(
                tokio::time::Instant::now() < deadline,
                "worker socket never went away"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if let Some(replay_after_exit) = adopted.handle.replay(1 << 20) {
            assert!(
                !matches!(replay_after_exit.await, Ok(Ok(_))),
                "replay unexpectedly remained available after worker exit"
            );
        }
        match old_dir {
            Some(value) => std::env::set_var("SPAWND_WORKER_DIR", value),
            None => std::env::remove_var("SPAWND_WORKER_DIR"),
        }
        match old_bin {
            Some(value) => std::env::set_var("SPAWND_WORKER_BIN", value),
            None => std::env::remove_var("SPAWND_WORKER_BIN"),
        }
    }
}
