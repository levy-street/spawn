//! Per-agent PTY + tmux session management.
//!
//! For each `agent.create`:
//!   1. `tmux new-session -d -s spawn-<name>--<id>` launches the real argv detached,
//!      with the final env injected via `-e KEY=VAL`. Spawn does not manage
//!      agent credentials — the daemon's process env (HOME, XDG_CONFIG_HOME,
//!      PATH, etc.) flows through, and the agent CLI finds whatever it
//!      logged in with on the host.
//!   2. We open a portable_pty PTY and spawn `tmux attach -t <session>`
//!      inside it. A blocking reader thread pushes raw PTY bytes into a
//!      per-agent **outbox** (an unbounded mpsc). A long-lived per-agent
//!      **forwarder** task encodes those bytes as binary frames and ships
//!      them to the WS session's outbound sink. Stdin from the WS goes into
//!      the PTY's writer.
//!
//! The reader thread + forwarder task survive across WS reconnects: the
//! WS session installs/clears the forwarder's sink on connect/disconnect,
//! and the outbox buffers any bytes received in between. This is what makes
//! "bounce uvicorn while an agent is running" not break the agent.
//!
//! Because tmux owns the underlying agent process, the agent also survives
//! `spawnd` restarts (see `reattach`).

use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex, Notify};
use uuid::Uuid;

use crate::frames;
use crate::tmux;

#[derive(Debug)]
pub enum WsOutbound {
    /// A serialized JSON frame.
    Json(String),
    /// A binary frame already encoded (`kind|agent_id|payload`).
    Binary(Vec<u8>),
}

/// The thing the WS session hands to a per-agent forwarder so that bytes
/// route to the current connection.
pub type SessionSink = mpsc::Sender<WsOutbound>;
pub type DirectSink = mpsc::UnboundedSender<Vec<u8>>;

/// Shared between an agent's forwarder task and the WS session lifecycle.
/// `slot` holds the current session's outbound sink (or `None` between
/// sessions). `notify` wakes the forwarder when a sink becomes available.
#[derive(Clone)]
pub struct ForwarderControl {
    slot: Arc<AsyncMutex<Option<SessionSink>>>,
    direct_sinks: Arc<AsyncMutex<HashMap<String, DirectSink>>>,
    notify: Arc<Notify>,
}

impl ForwarderControl {
    fn new() -> Self {
        Self {
            slot: Arc::new(AsyncMutex::new(None)),
            direct_sinks: Arc::new(AsyncMutex::new(HashMap::new())),
            notify: Arc::new(Notify::new()),
        }
    }

    /// Install the current WS session's outbound sink. Wakes the forwarder
    /// task so any backlog drains immediately.
    pub async fn set_sink(&self, sink: SessionSink) {
        *self.slot.lock().await = Some(sink);
        self.notify.notify_waiters();
    }

    /// Clear the sink (called when the WS session ends). The forwarder will
    /// park on `notify` until a new sink is installed; bytes accumulate in
    /// the agent's outbox in the meantime.
    pub async fn clear_sink(&self) {
        *self.slot.lock().await = None;
    }

    /// Add a direct terminal transport sink, such as a browser WebRTC
    /// DataChannel. These sinks receive raw PTY output bytes without the
    /// daemon->server->browser relay hop.
    pub async fn add_direct_sink(&self, id: String, sink: DirectSink) {
        self.direct_sinks.lock().await.insert(id, sink);
    }

    pub async fn remove_direct_sink(&self, id: &str) {
        self.direct_sinks.lock().await.remove(id);
    }

    async fn send_direct(&self, chunk: &[u8]) {
        let mut sinks = self.direct_sinks.lock().await;
        sinks.retain(|_, sink| sink.send(chunk.to_vec()).is_ok());
    }
}

/// Per-agent runtime handle.
pub struct AgentHandle {
    pub agent_id: Uuid,
    /// tmux session name (e.g. "spawn-palette--<uuid>").
    session: Arc<Mutex<String>>,
    /// Stdin into the PTY (writer half).
    stdin: Arc<Mutex<Box<dyn Write + Send>>>,
    /// Optional token used to cancel the read thread; consumed on shutdown.
    #[allow(dead_code)]
    cancel_tx: Option<oneshot::Sender<()>>,
    /// Master PTY (kept alive so resize works).
    master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    /// Last size applied through this handle. Used to avoid expensive tmux
    /// refreshes when browsers repeat the same geometry.
    size: Arc<Mutex<(u16, u16)>>,
    /// Reader thread pushes raw PTY bytes here. Held alive while the agent
    /// is alive; when dropped, the per-agent forwarder task exits.
    #[allow(dead_code)]
    outbox_tx: mpsc::UnboundedSender<Vec<u8>>,
    /// Lets the WS session install/clear the forwarder's current sink.
    pub control: ForwarderControl,
}

impl AgentHandle {
    pub fn session(&self) -> Result<String> {
        self.session
            .lock()
            .map(|s| s.clone())
            .map_err(|_| anyhow::anyhow!("tmux session lock poisoned"))
    }

    pub fn set_session(&self, next: String) -> Result<()> {
        let mut session = self
            .session
            .lock()
            .map_err(|_| anyhow::anyhow!("tmux session lock poisoned"))?;
        *session = next;
        Ok(())
    }

    pub fn write_stdin(&self, bytes: &[u8]) -> Result<()> {
        let mut stdin = self
            .stdin
            .lock()
            .map_err(|_| anyhow::anyhow!("pty stdin lock poisoned"))?;
        stdin.write_all(bytes).context("writing PTY stdin")?;
        stdin.flush().ok();
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<bool> {
        let mut size = self
            .size
            .lock()
            .map_err(|_| anyhow::anyhow!("pty size lock poisoned"))?;
        if *size == (cols, rows) {
            return Ok(false);
        }
        let master = self
            .master
            .lock()
            .map_err(|_| anyhow::anyhow!("pty master lock poisoned"))?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("resizing PTY")?;
        *size = (cols, rows);
        Ok(true)
    }

    /// Re-apply the current PTY size so the kernel emits a fresh SIGWINCH to
    /// `tmux attach`, which prompts tmux to re-emit the current pane state.
    /// Used after WS reconnect so browsers see the latest screen even when
    /// codex/etc. would otherwise be idle.
    pub fn nudge_redraw(&self) -> Result<()> {
        let master = self
            .master
            .lock()
            .map_err(|_| anyhow::anyhow!("pty master lock poisoned"))?;
        let size = master.get_size().context("reading PTY size")?;
        master.resize(size).context("re-applying PTY size")?;
        Ok(())
    }

    /// Drop the cancel channel so the reader exits next iteration.
    #[allow(dead_code)]
    pub fn cancel(&mut self) {
        if let Some(tx) = self.cancel_tx.take() {
            let _ = tx.send(());
        }
    }
}

pub struct LaunchSpec<'a> {
    pub agent_id: Uuid,
    pub session: &'a str,
    pub cwd: &'a str,
    pub cols: u16,
    pub rows: u16,
    pub argv: &'a [String],
    /// Final env to pass to the launched agent (and to tmux via `-e`).
    pub env: &'a BTreeMap<String, String>,
}

/// Result of a successful launch.
pub struct Launched {
    pub handle: AgentHandle,
    /// PID of the `tmux attach` we spawned in the PTY (reported via
    /// `agent.started`). Note this is NOT the agent's pid; the real agent
    /// runs under tmux.
    pub pid: u32,
    /// Future-style: receives the exit reason once the PTY EOFs.
    pub exit_rx: oneshot::Receiver<ExitReason>,
}

#[derive(Debug, Clone)]
pub struct ExitReason {
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
}

/// 1) tmux new-session -d
/// 2) attach in a portable-pty
/// 3) spawn a reader thread (raw bytes -> outbox)
/// 4) spawn a forwarder task (outbox -> current WS sink)
pub async fn launch(spec: LaunchSpec<'_>) -> Result<Launched> {
    let session = spec.session;

    tmux::new_session_detached(session, spec.cwd, spec.cols, spec.rows, spec.argv, spec.env)
        .await
        .context("starting tmux session")?;

    // If the agent's argv exits within a few hundred ms (bad binary, missing
    // flag, smart-quote garbage), the tmux session is already gone by the
    // time we try to attach — and the user just sees a confusing
    // "can't find session" from `tmux attach`. Detect that case here and
    // surface a clearer error.
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    if !tmux::has_session(session).await {
        anyhow::bail!(
            "agent process exited before we could attach — check argv: {:?}",
            spec.argv
        );
    }

    attach_to_session(spec.agent_id, session, spec.cwd, spec.cols, spec.rows)
}

/// Re-attach to an existing tmux session that was started by a previous
/// `spawnd` instance. Used during daemon discovery on startup so agents
/// survive daemon restarts without losing state.
pub async fn reattach(agent_id: uuid::Uuid, session: &str) -> Result<Launched> {
    if !tmux::has_session(session).await {
        anyhow::bail!("tmux session {session:?} not found");
    }
    let (cols, rows) = tmux::window_size(session).await.unwrap_or((120, 32));
    // We don't know the original cwd; default to the current daemon's working
    // directory (which is typically the user's home). The PTY child only
    // needs cwd to be a valid dir; the agent's actual cwd is preserved by
    // tmux.
    let cwd = std::env::current_dir()
        .ok()
        .and_then(|p| p.to_str().map(String::from))
        .unwrap_or_else(|| "/".to_string());
    tracing::info!(%agent_id, %session, cols, rows, "reattaching to existing tmux session");
    attach_to_session(agent_id, session, &cwd, cols, rows)
}

/// Shared core: open a portable-pty, run `tmux attach` in it, start the
/// reader thread + per-agent forwarder task. Returns once the structures
/// are wired up; bytes will start flowing as soon as the WS session installs
/// a sink via `handle.control.set_sink(...)`.
fn attach_to_session(
    agent_id: uuid::Uuid,
    session: &str,
    cwd: &str,
    cols: u16,
    rows: u16,
) -> Result<Launched> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("openpty")?;

    let mut cmd = CommandBuilder::new("tmux");
    cmd.args(["attach", "-t", session]);
    cmd.env("TERM", "xterm-256color");
    if let Ok(p) = std::env::var("PATH") {
        cmd.env("PATH", p);
    }
    // Match the socket resolution of every other tmux invocation: honor the
    // daemon's TMUX_TMPDIR, never an inherited $TMUX, so an attach from a
    // daemon started inside a tmux pane can't target the outer server.
    cmd.env_remove("TMUX");
    if let Ok(t) = std::env::var("TMUX_TMPDIR") {
        cmd.env("TMUX_TMPDIR", t);
    }
    cmd.cwd(cwd);

    let child = pair
        .slave
        .spawn_command(cmd)
        .context("spawning tmux attach inside PTY")?;
    let pid = child.process_id().unwrap_or(0);

    let reader = pair
        .master
        .try_clone_reader()
        .context("cloning PTY reader")?;
    let writer = pair.master.take_writer().context("taking PTY writer")?;
    let master = Arc::new(Mutex::new(pair.master));
    let stdin = Arc::new(Mutex::new(writer));

    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    let (exit_tx, exit_rx) = oneshot::channel::<ExitReason>();

    // Per-agent outbox + forwarder.
    let (outbox_tx, outbox_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let control = ForwarderControl::new();

    // Forwarder: outbox -> current sink (with reconnect-aware looping).
    {
        let control = control.clone();
        tokio::spawn(run_forwarder(agent_id, outbox_rx, control));
    }

    // Reader thread: raw PTY -> outbox.
    let outbox_for_reader = outbox_tx.clone();
    std::thread::spawn(move || {
        run_reader_thread(
            agent_id,
            reader,
            child,
            outbox_for_reader,
            cancel_rx,
            exit_tx,
        );
    });

    let handle = AgentHandle {
        agent_id,
        session: Arc::new(Mutex::new(session.to_string())),
        stdin,
        cancel_tx: Some(cancel_tx),
        master,
        size: Arc::new(Mutex::new((cols, rows))),
        outbox_tx,
        control,
    };
    Ok(Launched {
        handle,
        pid,
        exit_rx,
    })
}

fn run_reader_thread(
    agent_id: Uuid,
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    outbox: mpsc::UnboundedSender<Vec<u8>>,
    mut cancel_rx: oneshot::Receiver<()>,
    exit_tx: oneshot::Sender<ExitReason>,
) {
    let mut buf = [0u8; 8192];
    loop {
        // Cooperative cancel check (non-blocking).
        if cancel_rx.try_recv().is_ok() {
            tracing::debug!(%agent_id, "PTY reader cancelled");
            break;
        }

        match reader.read(&mut buf) {
            Ok(0) => {
                tracing::debug!(%agent_id, "PTY EOF");
                break;
            }
            Ok(n) => {
                if outbox.send(buf[..n].to_vec()).is_err() {
                    // Forwarder gone (registry dropped this agent). We can stop.
                    tracing::debug!(%agent_id, "outbox closed; stopping reader");
                    break;
                }
            }
            Err(e) => {
                tracing::warn!(%agent_id, error = %e, "PTY read error");
                break;
            }
        }
    }

    // Drain exit status.
    let reason = match child.wait() {
        Ok(status) => {
            if status.success() {
                ExitReason {
                    exit_code: Some(0),
                    signal: None,
                }
            } else {
                ExitReason {
                    exit_code: Some(status.exit_code() as i32),
                    signal: None,
                }
            }
        }
        Err(_) => ExitReason {
            exit_code: None,
            signal: None,
        },
    };
    let _ = exit_tx.send(reason);
}

/// Long-lived per-agent task: encode raw PTY bytes into binary frames and
/// ship them to the current WS session's sink. Survives WS reconnects —
/// when the sink is None, parks on `control.notify` until a new session
/// installs one. Exits when `outbox_rx` returns None (i.e. all
/// `outbox_tx` clones — including the AgentHandle and reader thread — are
/// dropped).
async fn run_forwarder(
    agent_id: Uuid,
    mut outbox_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    control: ForwarderControl,
) {
    while let Some(chunk) = outbox_rx.recv().await {
        control.send_direct(&chunk).await;
        let frame = frames::encode_pty_output(agent_id, &chunk);
        // Loop until the chunk is sent (or wait for a sink to be installed).
        loop {
            // Snapshot the current sink under lock, drop the lock, then send.
            let current = control.slot.lock().await.clone();
            match current {
                Some(s) => match s.send(WsOutbound::Binary(frame.clone())).await {
                    Ok(_) => break,
                    Err(_) => {
                        // Sink closed mid-send (WS likely just dropped). Clear
                        // it if it's still the closed one we just tried — but
                        // not if a new session has already swapped a fresh
                        // sink in.
                        let mut g = control.slot.lock().await;
                        if g.as_ref().map(|x| x.is_closed()).unwrap_or(false) {
                            *g = None;
                        }
                        // Loop and retry; if slot is now None, the next
                        // iteration will park on the notifier.
                    }
                },
                None => {
                    control.notify.notified().await;
                }
            }
        }
    }
    tracing::debug!(%agent_id, "forwarder exiting (outbox closed)");
}
