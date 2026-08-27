//! `spawnd run` — foreground service loop. Connects WSS, registers, services
//! frames forever (with reconnect + exponential backoff).

use std::cell::Cell;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::future::Future;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::sync::mpsc as std_mpsc;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::Once;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use futures_util::{stream::FuturesUnordered, StreamExt};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use crate::cli::RunArgs;
use crate::config;
use crate::creds::{self, CredentialRevision, StoredCreds};
use crate::proto::{
    CarriedEndorsement, HostAgentInstallResult, HostAgentStatus, HostAgentTarget, Inbound,
    Outbound, SessionCreate,
};
use crate::pty::{self, WsOutbound};
use crate::rtc::{HostRtcSignal, RtcAnswerSigner, RtcSessions};
use crate::sessions::SessionRegistry;
use crate::worker_backend;
use crate::ws::{self, WsInbound};
use spawnd::acct_endorsement::{signature_from_wire, AcctEndorsementTranscript};
use spawnd::endorsement_chain::{
    find_valid_chain, ChainEdge, RevocationSet, DEFAULT_MAX_CHAIN_EDGES, MAX_CARRIED_ENDORSEMENTS,
};
use spawnd::host_pair_approval::account_id_bytes;
use spawnd::signed_signal::{
    public_key_from_wire, ScopeType, SenderRole, SignalKind, SignedSignalTranscript,
};
use spawnd::signed_signal_wire::{envelope_sender, verify_rtc_signal_wire, VerifiedRtcSignal};

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const WS_PING_INTERVAL: Duration = Duration::from_secs(15);
const OUTBOUND_CHANNEL_DEPTH: usize = 1024;
const TOOL_VERSION_TIMEOUT: Duration = Duration::from_secs(5);
const TOOL_INSTALL_TIMEOUT: Duration = Duration::from_secs(180);
const TOOL_OUTPUT_LIMIT: usize = 16 * 1024;
const SHELL_PATH_PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const DEFAULT_SESSION_COLS: u16 = 120;
const DEFAULT_SESSION_ROWS: u16 = 32;
/// Credential storage has no portable cross-process notification primitive.
/// One daemon-wide poll schedules detection within 500 ms while keeping
/// keyring/file reads serial and avoiding one watcher per connection. The
/// separate load deadline below bounds I/O response or fatal fail-stop.
const CREDENTIAL_RELOAD_INTERVAL: Duration = Duration::from_millis(500);
/// A synchronous credential backend can block in a cross-process lock, the
/// filesystem, or a native keyring. Keep that work off Tokio and stop trusting
/// the active generation if one complete load has not replied by this bound.
const CREDENTIAL_LOAD_DEADLINE: Duration = Duration::from_secs(2);
const CREDENTIAL_LOADER_THREAD_NAME: &str = "spawnd-credential-loader";
const CREDENTIAL_LOADER_PANIC_DIAGNOSTIC: &[u8] =
    b"spawnd: credential loader failed; trust disabled\n";

thread_local! {
    /// Private non-user-controlled identity for the one blocking credential
    /// worker. A thread name alone can be copied by unrelated code; the panic
    /// hook therefore keys on this internal TLS marker instead.
    static IS_CREDENTIAL_LOADER_THREAD: Cell<bool> = const { Cell::new(false) };
}

static INSTALL_CREDENTIAL_LOADER_PANIC_HOOK: Once = Once::new();

fn install_credential_loader_panic_hook() {
    INSTALL_CREDENTIAL_LOADER_PANIC_HOOK.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let is_credential_loader = IS_CREDENTIAL_LOADER_THREAD
                .try_with(Cell::get)
                .unwrap_or(false);
            if is_credential_loader {
                // Panic hooks run before catch_unwind. Never format `info`:
                // its payload and source location can contain credential
                // backend secrets. Ignore stderr failures without panicking.
                let mut stderr = std::io::stderr().lock();
                let _ = std::io::Write::write_all(&mut stderr, CREDENTIAL_LOADER_PANIC_DIAGNOSTIC);
            } else {
                previous(info);
            }
        }));
    });
}

enum CredentialLoadReply {
    Loaded(StoredCreds),
    Failed,
}

struct CredentialLoadRequest {
    reply: oneshot::Sender<CredentialLoadReply>,
}

struct PendingCredentialLoad {
    reply: oneshot::Receiver<CredentialLoadReply>,
    deadline: tokio::time::Instant,
}

/// One daemon-wide, single-flight boundary around all blocking credential I/O.
///
/// The worker is a dedicated standard thread, not a Tokio blocking task, so a
/// backend that ignores cancellation cannot make runtime shutdown wait or
/// amplify into abandoned `spawn_blocking` jobs. The async side retains the
/// pending reply across cancellation (for example, when a WebSocket handshake
/// wins a `select!`) and never enqueues a second request while it is live. A
/// hard deadline or any worker/channel failure permanently closes the request
/// channel: callers must invalidate trust and terminate the daemon run.
struct CredentialLoader {
    requests: Option<std_mpsc::SyncSender<CredentialLoadRequest>>,
    pending: Option<PendingCredentialLoad>,
    load_deadline: Duration,
    failed: bool,
}

impl CredentialLoader {
    fn for_daemon() -> Result<Self> {
        // Preserve the ordinary initial-load warning behavior, then keep the
        // 500 ms live monitor quiet on Unix's designed file fallback.
        let mut initial = true;
        Self::start(CREDENTIAL_LOAD_DEADLINE, move || {
            if std::mem::take(&mut initial) {
                creds::load()
            } else {
                creds::load_for_live_reload()
            }
        })
    }

    fn start<F>(load_deadline: Duration, load: F) -> Result<Self>
    where
        F: FnMut() -> Result<StoredCreds> + Send + 'static,
    {
        Self::start_inner(load_deadline, load, None, None)
    }

    fn start_inner<F>(
        load_deadline: Duration,
        mut load: F,
        worker_exit: Option<std_mpsc::Sender<()>>,
        reply_attempted: Option<std_mpsc::Sender<()>>,
    ) -> Result<Self>
    where
        F: FnMut() -> Result<StoredCreds> + Send + 'static,
    {
        // Install once before the internal thread can possibly panic. The
        // captured preexisting hook remains the exact delegate for every
        // unrelated thread; no load/run swaps process-global hooks.
        install_credential_loader_panic_hook();
        // Capacity one plus the async-side `pending` slot is intentionally
        // conservative: only one request is ever sent, and `try_send` ensures
        // Tokio is never blocked even if the worker has not reached `recv`.
        let (requests, receiver) = std_mpsc::sync_channel::<CredentialLoadRequest>(1);
        thread::Builder::new()
            .name(CREDENTIAL_LOADER_THREAD_NAME.to_owned())
            .spawn(move || {
                IS_CREDENTIAL_LOADER_THREAD.with(|marker| marker.set(true));
                while let Ok(request) = receiver.recv() {
                    let loaded = catch_unwind(AssertUnwindSafe(&mut load));
                    let (reply, stop) = match loaded {
                        Ok(Ok(record)) => (CredentialLoadReply::Loaded(record), false),
                        Ok(Err(_)) | Err(_) => (CredentialLoadReply::Failed, true),
                    };
                    // When the supervisor timed out or shut down, this send
                    // drops the complete StoredCreds reply (whose Drop wipes
                    // token/private seed) and the closed request channel ends
                    // the thread without another backend invocation.
                    let reply_failed = request.reply.send(reply).is_err();
                    if let Some(reply_attempted) = reply_attempted.as_ref() {
                        let _ = reply_attempted.send(());
                    }
                    if reply_failed || stop {
                        break;
                    }
                }
                if let Some(worker_exit) = worker_exit {
                    let _ = worker_exit.send(());
                }
            })
            .context("starting bounded credential loader")?;
        Ok(Self {
            requests: Some(requests),
            pending: None,
            load_deadline,
            failed: false,
        })
    }

    #[cfg(test)]
    fn start_observed<F>(
        load_deadline: Duration,
        load: F,
        worker_exit: std_mpsc::Sender<()>,
    ) -> Result<Self>
    where
        F: FnMut() -> Result<StoredCreds> + Send + 'static,
    {
        Self::start_inner(load_deadline, load, Some(worker_exit), None)
    }

    #[cfg(test)]
    fn start_observed_replies<F>(
        load_deadline: Duration,
        load: F,
        worker_exit: std_mpsc::Sender<()>,
        reply_attempted: std_mpsc::Sender<()>,
    ) -> Result<Self>
    where
        F: FnMut() -> Result<StoredCreds> + Send + 'static,
    {
        Self::start_inner(
            load_deadline,
            load,
            Some(worker_exit),
            Some(reply_attempted),
        )
    }

    async fn load(&mut self) -> Result<StoredCreds> {
        if self.failed {
            return Err(anyhow!("credential loader is permanently unavailable"));
        }
        // A watcher future can be cancelled while this one request remains in
        // flight. Deadline precedence must be checked before polling a queued
        // reply: Tokio's `timeout_at` polls the inner future first and could
        // otherwise accept credentials that arrived only after expiry.
        if self
            .pending
            .as_ref()
            .is_some_and(|pending| tokio::time::Instant::now() >= pending.deadline)
        {
            self.fail_permanently();
            return Err(anyhow!("credential reload exceeded its hard deadline"));
        }
        if self.pending.is_none() {
            let (reply_tx, reply_rx) = oneshot::channel();
            let request = CredentialLoadRequest { reply: reply_tx };
            let sent = self
                .requests
                .as_ref()
                .ok_or_else(|| anyhow!("credential loader is permanently unavailable"))?
                .try_send(request);
            if sent.is_err() {
                self.fail_permanently();
                return Err(anyhow!("credential loader request channel failed"));
            }
            self.pending = Some(PendingCredentialLoad {
                reply: reply_rx,
                deadline: tokio::time::Instant::now() + self.load_deadline,
            });
        }

        enum AwaitedReply {
            Expired,
            Reply(Result<CredentialLoadReply, oneshot::error::RecvError>),
        }
        let awaited = {
            let pending = self.pending.as_mut().expect("pending load");
            let deadline = pending.deadline;
            let expiry = tokio::time::sleep_until(deadline);
            tokio::pin!(expiry);
            tokio::select! {
                biased;
                _ = &mut expiry => AwaitedReply::Expired,
                reply = &mut pending.reply => AwaitedReply::Reply(reply),
            }
        };
        match awaited {
            AwaitedReply::Reply(Ok(CredentialLoadReply::Loaded(record))) => {
                self.pending = None;
                Ok(record)
            }
            AwaitedReply::Reply(Ok(CredentialLoadReply::Failed)) => {
                self.fail_permanently();
                Err(anyhow!("credential loader failed"))
            }
            AwaitedReply::Reply(Err(_)) => {
                self.fail_permanently();
                Err(anyhow!("credential loader reply channel failed"))
            }
            AwaitedReply::Expired => {
                self.fail_permanently();
                Err(anyhow!("credential reload exceeded its hard deadline"))
            }
        }
    }

    fn fail_permanently(&mut self) {
        self.failed = true;
        self.pending = None;
        self.requests = None;
    }
}

struct LiveCredentialSnapshot {
    /// Token, host signing key, trust domain, and browser pins are owned as one
    /// indivisible loaded record. No live code reloads individual fields.
    record: StoredCreds,
    revision: CredentialRevision,
    generation: u64,
    record_id: Uuid,
    server_origin: String,
    host_id: Uuid,
}

impl LiveCredentialSnapshot {
    fn initial(record: StoredCreds, configured_server: &url::Url) -> Result<Self> {
        let server_origin = creds::canonical_server_origin(configured_server.as_str())
            .context("validating configured server trust origin")?;
        Self::validated(record, server_origin, None)
    }

    fn validated(
        record: StoredCreds,
        server_origin: String,
        expected_host_id: Option<Uuid>,
    ) -> Result<Self> {
        creds::validate_live_record(&record).context("validating live credential record")?;
        let access_token = record
            .access_token
            .as_deref()
            .ok_or_else(|| anyhow!("no daemon token; run `spawnd login` first"))?;
        creds::validate_login_access_token(access_token)
            .context("validating live daemon access token")?;
        let host_id = record
            .host_id
            .context("stored credentials have no registered Host ID")?;
        if expected_host_id.is_some_and(|expected| expected != host_id) {
            return Err(anyhow!(
                "credential reload changed the registered Host ID; refusing live trust rotation"
            ));
        }
        let stored_server = record
            .server_url
            .as_deref()
            .context("stored credentials have no server trust origin")?;
        let stored_origin = creds::canonical_server_origin(stored_server)
            .context("validating stored server trust origin")?;
        if stored_origin != server_origin {
            return Err(anyhow!(
                "stored credential server origin does not match the configured server"
            ));
        }
        creds::host_identity(&record)?
            .context("stored credentials have no host signing identity")?;
        let revision = creds::credential_revision(&record)?;
        let (generation, record_id) = revision.current_parts().ok_or_else(|| {
            anyhow!(
                "stored credentials have no revisioned whole-record generation; run `spawnd login` again"
            )
        })?;
        Ok(Self {
            record,
            revision,
            generation,
            record_id,
            server_origin,
            host_id,
        })
    }

    fn classify_reload(&self, record: StoredCreds) -> Result<Option<Self>> {
        let next = Self::validated(record, self.server_origin.clone(), Some(self.host_id))?;
        if next.revision == self.revision {
            if next.record == self.record {
                return Ok(None);
            }
            return Err(anyhow!(
                "credential contents changed without a new whole-record revision"
            ));
        }
        if next.generation <= self.generation {
            return Err(anyhow!(
                "credential generation rolled back or did not advance"
            ));
        }
        if next.record_id == self.record_id {
            return Err(anyhow!(
                "credential generation advanced without a fresh record identity"
            ));
        }
        Ok(Some(next))
    }
}

enum ServeOutcome {
    SessionEnded(SessionEnd),
    CredentialsChanged(Box<LiveCredentialSnapshot>),
}

struct SessionEnd {
    result: Result<()>,
    stable: bool,
}

enum ActiveSessionEvent {
    SessionEnded(Result<()>),
    CredentialReload(Result<Box<LiveCredentialSnapshot>>),
}

async fn wait_for_credential_change(
    active: &LiveCredentialSnapshot,
    loader: &mut CredentialLoader,
) -> Result<LiveCredentialSnapshot> {
    wait_for_credential_change_with(active, CREDENTIAL_RELOAD_INTERVAL, loader).await
}

async fn credential_change_now(
    active: &LiveCredentialSnapshot,
    loader: &mut CredentialLoader,
) -> Result<Option<LiveCredentialSnapshot>> {
    credential_change_now_with(active, loader).await
}

async fn credential_change_now_with(
    active: &LiveCredentialSnapshot,
    loader: &mut CredentialLoader,
) -> Result<Option<LiveCredentialSnapshot>> {
    let record = loader
        .load()
        .await
        .context("reloading credentials before websocket admission")?;
    active.classify_reload(record)
}

async fn wait_for_credential_change_with(
    active: &LiveCredentialSnapshot,
    poll_interval: Duration,
    loader: &mut CredentialLoader,
) -> Result<LiveCredentialSnapshot> {
    let start = tokio::time::Instant::now() + poll_interval;
    let mut ticker = tokio::time::interval_at(start, poll_interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        // The ticker is the guarantee; the notify is a latency optimization
        // that observes this daemon's own pin writes without waiting out the
        // interval.
        tokio::select! {
            _ = ticker.tick() => {}
            _ = credentials_touched_notify().notified() => {}
        }
        let record = loader
            .load()
            .await
            .context("reloading the complete credential record")?;
        if let Some(next) = active.classify_reload(record)? {
            return Ok(next);
        }
    }
}

pub async fn run(server_cli: Option<String>, _args: RunArgs) -> Result<()> {
    install_sighup_handler();
    #[cfg(windows)]
    crate::service::refresh_user_path()?;
    crate::update::prepare_probation()?;
    crate::update::arm_probation_deadline();
    crate::update::refresh_worker_pair_status().await;
    let mut credential_loader = CredentialLoader::for_daemon()?;
    let stored = credential_loader
        .load()
        .await
        .context("loading stored credentials")?;
    // Prefer the explicit --server flag, then $SPAWN_SERVER_URL (already
    // wired into clap), then the URL we logged in against.
    let server_url = config::server_url_for_instance(server_cli, stored.server_url.as_deref())?;
    let ws_url = config::ws_url(&server_url)?;
    let mut live_credentials = LiveCredentialSnapshot::initial(stored, &server_url)?;

    let registry = SessionRegistry::new();
    let config_dir = crate::config::config_dir()?;
    #[cfg(windows)]
    crate::service::instance_state_dir(&config_dir)?;
    #[cfg(windows)]
    crate::service::start_control_listener(&config_dir, reconnect_notify(), shutdown_notify())?;
    let task_breakaway_denied = crate::service::probe_task_breakaway(&config_dir);
    let state_store = Arc::new(crate::state::StateStore::new_with_breakaway(
        &config_dir,
        server_url.as_str(),
        task_breakaway_denied,
    ));
    crate::state::install_active(Arc::clone(&state_store));
    state_store.heartbeat(0);
    let state_registry = registry.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        interval.tick().await;
        loop {
            interval.tick().await;
            state_store.heartbeat(state_registry.ids().len());
        }
    });
    let rtc_sessions = RtcSessions::new();
    // Process-lifetime monotonic floor for the account deny-list (device mesh
    // §3). Owned here — above the per-connection loop — so a reconnect cannot
    // reset it: a key revoked on one control connection stays revoked on every
    // later one, whatever the server's next frames say. Deliberately in-memory
    // only: the server's permanent tombstone (R10) is the durable store across
    // restarts, and a server malicious enough to withhold a revocation after a
    // daemon restart could equally have withheld it before the daemon ever
    // learned it — a local disk cache would close no attack class while adding
    // a write path into credential storage from the hostile-input WS handler.
    let mut daemon_revoked = RevocationSet::new();
    if !rtc_sessions
        .bind_registered_host_id(live_credentials.host_id)
        .await
    {
        return Err(anyhow!("could not bind the stored Host ID"));
    }

    // Ctrl-C closes only this supervisor. Session workers remain alive and
    // are adopted by the next `spawnd` process.
    let mut attempt: u32 = 0;
    let mut last_protocol_update_error: Option<Instant> = None;
    let mut last_supersession: Option<Instant> = None;
    let mut supersession_count = 0_u8;
    let mut supersession_logged = false;
    let mut unauthorized_logged = false;

    'supervisor: loop {
        // A session close or backoff timer can become ready in the same
        // scheduler turn as a credential write. Never let that select race
        // carry the stale snapshot into another socket: reread the whole
        // record through the hard-deadline loader before every attempt.
        let immediate_reload =
            match credential_change_now(&live_credentials, &mut credential_loader).await {
                Ok(reload) => reload,
                Err(error) => {
                    rtc_sessions.invalidate_trust_and_close_all().await;
                    return Err(error);
                }
            };
        if let Some(next) = immediate_reload {
            // The prior socket-end branch may have won over a simultaneously
            // ready reload. Its ordinary close cannot authorize an offer that
            // was already waiting at RTC insertion, so advance the trust
            // epoch here before accepting the newly observed generation.
            rtc_sessions.invalidate_trust_and_close_all().await;
            live_credentials = next;
            attempt = 0;
        }
        let outcome = {
            let session_fut = serve_one_connection(
                &live_credentials,
                &ws_url,
                &registry,
                &rtc_sessions,
                &mut credential_loader,
                &mut daemon_revoked,
            );
            tokio::pin!(session_fut);

            tokio::select! {
                r = &mut session_fut => r,
                r = tokio::signal::ctrl_c() => {
                    r.context("ctrl-c handler")?;
                    tracing::info!("Ctrl-C received; exiting (session workers are preserved)");
                    return Ok(());
                }
                _ = shutdown_signal() => {
                    tracing::info!("graceful service shutdown requested; exiting (session workers are preserved)");
                    return Ok(());
                }
            }
        }?;
        let res = match outcome {
            ServeOutcome::CredentialsChanged(next) => {
                tracing::info!(
                    generation = next.generation,
                    "credential generation changed; reconnecting with the new whole record"
                );
                live_credentials = *next;
                attempt = 0;
                continue;
            }
            ServeOutcome::SessionEnded(ended) => {
                if ended.stable {
                    attempt = 0;
                    unauthorized_logged = false;
                } else {
                    attempt = attempt.saturating_add(1);
                }
                ended.result
            }
        };
        if let Err(error) = &res {
            let class = ws::failure_class(error);
            let (kind, default_detail) = crate::state::connection_error_class(class);
            let detail = ws::auth_refusal(error)
                .map(ws::AuthRefusal::as_str)
                .unwrap_or(default_detail);
            crate::state::active_disconnected(kind, detail, registry.ids().len());
        } else {
            crate::state::active_disconnected("protocol", "socket_closed", registry.ids().len());
        }
        let protocol_required = matches!(&res, Err(error) if ws::is_protocol_required(error));
        let reconnect_now = res.as_ref().err().and_then(ws::close_disposition)
            == Some(ws::CloseDisposition::ImmediateReconnect);
        let delay = if protocol_required {
            let failure = match crate::update::apply_from_release(&server_url).await {
                Ok(crate::update::HttpUpdateOutcome::Applied(applied)) => {
                    Some(crate::update::exec(applied))
                }
                Ok(crate::update::HttpUpdateOutcome::NoUpdate(reason)) => {
                    Some(crate::update::UpdateFailure {
                        stage: crate::update::UpdateStage::Precondition,
                        error: reason,
                    })
                }
                Err(failure) => Some(failure),
            };
            if let Some(failure) = failure {
                let now = Instant::now();
                let should_log = last_protocol_update_error
                    .is_none_or(|last| now.duration_since(last) >= Duration::from_secs(60 * 60));
                if should_log {
                    last_protocol_update_error = Some(now);
                    let reinstall = crate::update::reinstall_command(&server_url);
                    tracing::error!(
                        stage = failure.stage.as_str(),
                        error = failure.error,
                        reinstall = %reinstall,
                        "SPAWN D daemon cannot satisfy the server protocol; reinstall it"
                    );
                }
            }
            ws::self_update_backoff()
        } else {
            let disposition = res.as_ref().err().and_then(ws::close_disposition);
            if disposition != Some(ws::CloseDisposition::Superseded) {
                last_supersession = None;
                supersession_count = 0;
                supersession_logged = false;
            }
            match disposition {
                Some(ws::CloseDisposition::ClientBug) => {
                    return Err(anyhow!(
                        "server rejected this daemon as a client bug (close 4002)"
                    ));
                }
                Some(ws::CloseDisposition::ImmediateReconnect) => Duration::ZERO,
                Some(ws::CloseDisposition::Unauthorized) => {
                    if !unauthorized_logged {
                        unauthorized_logged = true;
                        tracing::error!(class = "unauthorized", "token expired — run spawnd login");
                    }
                    Duration::from_secs(60)
                }
                Some(ws::CloseDisposition::Superseded) => {
                    let now = Instant::now();
                    supersession_count = if last_supersession
                        .is_some_and(|last| now.duration_since(last) <= Duration::from_secs(60))
                    {
                        supersession_count.saturating_add(1)
                    } else {
                        1
                    };
                    last_supersession = Some(now);
                    if supersession_count >= 2 {
                        if !supersession_logged {
                            supersession_logged = true;
                            tracing::error!("another daemon instance is using these credentials");
                        }
                        Duration::from_secs(60)
                    } else {
                        ws::backoff_for_attempt(attempt.saturating_sub(1))
                    }
                }
                _ => {
                    match &res {
                        Ok(()) => tracing::info!("ws closed cleanly; reconnecting"),
                        Err(error) => tracing::warn!(
                            class = ws::failure_class(error),
                            "daemon control websocket session ended with error"
                        ),
                    }
                    if res
                        .as_ref()
                        .err()
                        .is_some_and(|error| ws::failure_class(error) == "unauthorized")
                    {
                        if !unauthorized_logged {
                            unauthorized_logged = true;
                            tracing::error!(
                                class = "unauthorized",
                                "daemon credentials were refused by the control server"
                            );
                        }
                        Duration::from_secs(60)
                    } else {
                        ws::backoff_for_attempt(attempt.saturating_sub(1))
                    }
                }
            }
        };
        tracing::info!(?delay, "reconnecting after backoff");
        if reconnect_now {
            attempt = 0;
        }
        let reloaded = {
            let sleep_fut = tokio::time::sleep(delay);
            let reload_fut = wait_for_credential_change(&live_credentials, &mut credential_loader);
            tokio::pin!(sleep_fut);
            tokio::pin!(reload_fut);
            tokio::select! {
                _ = &mut sleep_fut => None,
                reloaded = &mut reload_fut => Some(reloaded),
                _ = sighup_signal() => {
                    attempt = 0;
                    None
                }
                r = tokio::signal::ctrl_c() => {
                    r.context("ctrl-c handler")?;
                    tracing::info!("Ctrl-C received; exiting (session workers are preserved)");
                    return Ok(());
                }
                _ = shutdown_signal() => {
                    tracing::info!("graceful service shutdown requested; exiting (session workers are preserved)");
                    return Ok(());
                }
            }
        };
        if let Some(reloaded) = reloaded {
            let reloaded = match reloaded {
                Ok(reloaded) => reloaded,
                Err(error) => {
                    rtc_sessions.invalidate_trust_and_close_all().await;
                    return Err(error);
                }
            };
            rtc_sessions.invalidate_trust_and_close_all().await;
            live_credentials = reloaded;
            attempt = 0;
            continue 'supervisor;
        }
    }
}

fn reconnect_notify() -> &'static tokio::sync::Notify {
    static RECONNECT: std::sync::OnceLock<tokio::sync::Notify> = std::sync::OnceLock::new();
    RECONNECT.get_or_init(tokio::sync::Notify::new)
}

fn shutdown_notify() -> &'static tokio::sync::Notify {
    static SHUTDOWN: std::sync::OnceLock<tokio::sync::Notify> = std::sync::OnceLock::new();
    SHUTDOWN.get_or_init(tokio::sync::Notify::new)
}

#[cfg(unix)]
fn install_sighup_handler() {
    tokio::spawn(async {
        let Ok(mut signal) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup())
        else {
            return;
        };
        while signal.recv().await.is_some() {
            reconnect_notify().notify_one();
        }
    });
}

#[cfg(not(unix))]
fn install_sighup_handler() {}

async fn sighup_signal() {
    reconnect_notify().notified().await;
}

async fn shutdown_signal() {
    shutdown_notify().notified().await;
}

async fn serve_one_connection(
    live_credentials: &LiveCredentialSnapshot,
    ws_url: &url::Url,
    registry: &SessionRegistry,
    rtc_sessions: &RtcSessions,
    loader: &mut CredentialLoader,
    daemon_revoked: &mut RevocationSet,
) -> Result<ServeOutcome> {
    serve_one_connection_with_loader(
        live_credentials,
        ws_url,
        registry,
        rtc_sessions,
        CREDENTIAL_RELOAD_INTERVAL,
        loader,
        daemon_revoked,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn serve_one_connection_with_loader(
    live_credentials: &LiveCredentialSnapshot,
    ws_url: &url::Url,
    registry: &SessionRegistry,
    rtc_sessions: &RtcSessions,
    poll_interval: Duration,
    loader: &mut CredentialLoader,
    daemon_revoked: &mut RevocationSet,
) -> Result<ServeOutcome> {
    // Keep this boundary self-contained as well as guarding it in `run`: a
    // caller cannot open a websocket from a snapshot that was already stale
    // when the connection operation began.
    match credential_change_now_with(live_credentials, loader).await {
        Ok(Some(next)) => {
            rtc_sessions.invalidate_trust_and_close_all().await;
            return Ok(ServeOutcome::CredentialsChanged(Box::new(next)));
        }
        Ok(None) => {}
        Err(error) => {
            rtc_sessions.invalidate_trust_and_close_all().await;
            return Err(error);
        }
    }
    let token = live_credentials
        .record
        .access_token
        .as_deref()
        .ok_or_else(|| anyhow!("no access token"))?;

    enum ConnectOutcome<S> {
        Connected(S),
        Reloaded(Result<Box<LiveCredentialSnapshot>>),
    }
    let connect_outcome = {
        let reload_fut = wait_for_credential_change_with(live_credentials, poll_interval, loader);
        tokio::pin!(reload_fut);
        tokio::select! {
            connected = ws::connect(ws_url, token) => match connected {
                Ok(stream) => ConnectOutcome::Connected(stream),
                Err(error) => return Ok(ServeOutcome::SessionEnded(SessionEnd {
                    result: Err(error),
                    stable: false,
                })),
            },
            reloaded = &mut reload_fut => ConnectOutcome::Reloaded(reloaded.map(Box::new)),
        }
    };
    let stream = match connect_outcome {
        ConnectOutcome::Connected(stream) => stream,
        ConnectOutcome::Reloaded(reloaded) => {
            let reloaded = match reloaded {
                Ok(reloaded) => reloaded,
                Err(error) => {
                    rtc_sessions.invalidate_trust_and_close_all().await;
                    return Err(error);
                }
            };
            rtc_sessions.invalidate_trust_and_close_all().await;
            return Ok(ServeOutcome::CredentialsChanged(reloaded));
        }
    };
    // A durable commit can land while DNS/TCP/TLS/WebSocket negotiation is in
    // flight after the pre-connect gate. Recheck before splitting the socket,
    // registering the host, installing sinks, or accepting any control/RTC
    // frame; a stale handshake is dropped without becoming an admitted daemon
    // session.
    match credential_change_now_with(live_credentials, loader).await {
        Ok(Some(next)) => {
            drop(stream);
            rtc_sessions.invalidate_trust_and_close_all().await;
            return Ok(ServeOutcome::CredentialsChanged(Box::new(next)));
        }
        Ok(None) => {}
        Err(error) => {
            drop(stream);
            rtc_sessions.invalidate_trust_and_close_all().await;
            return Err(error);
        }
    }
    tracing::info!(%ws_url, "ws connected");
    crate::state::active_connected(registry.ids().len());

    let (write_half, read_half) = stream.split();

    // mpsc that the dispatch loop and heartbeat task push outbound frames
    // into. Per-session forwarder tasks ALSO ship into here, but indirectly:
    // each session owns its own outbox and a long-lived forwarder task; we
    // install/clear this session's `out_tx` as the forwarder's "sink" on
    // connect/disconnect so reader threads survive WS reconnects.
    let (out_tx, out_rx) = mpsc::channel::<WsOutbound>(OUTBOUND_CHANNEL_DEPTH);
    rtc_sessions.install_ws_sender(out_tx.clone());

    // mpsc for inbound frames so we have a single dispatch loop.
    let (in_tx, mut in_rx) = mpsc::channel::<WsInbound>(256);

    let pong_count = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let mut sender_task = tokio::spawn(ws::run_sender_loop(write_half, out_rx));
    let mut reader_task = tokio::spawn(ws::run_reader_loop(
        read_half,
        in_tx,
        Arc::clone(&pong_count),
    ));
    let registered_at = Arc::new(StdMutex::new(None::<Instant>));

    // First WS session of this daemon process: scan for live session workers
    // left behind by a previous instance, adopt each, and surface them in
    // `existing_sessions`. This makes daemon restart non-destructive.
    if registry.claim_discovery() {
        rediscover_existing_sessions(registry, rtc_sessions, &out_tx).await;
    }

    // Install this connection's sink for every session's forwarder so PTY
    // bytes route here. (Reattach-discovered sessions don't have a sink yet;
    // sessions from prior WS connections had a stale sink to overwrite.)
    install_session_sinks(registry, &out_tx).await;

    // Send `register`.
    let host_name = hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "unknown-host".into());

    // The GPU name is the one part of the spec that needs a subprocess, so it
    // is probed off to the side and folded in whenever it lands. Registering
    // without it costs a host its GPU label until the next reconnect, which is
    // strictly better than making the connection wait on `nvidia-smi`.
    crate::host_metrics::sampler().probe_gpu();

    let update_capability = crate::update::capability();
    let live_bindings = rtc_sessions.live_bindings().await;
    let register = Outbound::Register {
        host_name,
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        version: crate::version::build_version(),
        daemon_tree: crate::version::daemon_tree().map(str::to_string),
        self_update: update_capability.self_update,
        self_update_blocked: update_capability.blocked.map(str::to_string),
        worker_mismatch: crate::update::worker_mismatch(),
        keeps_peers_across_reconnect: true,
        live_bindings,
        session_ice_policy: true,
        existing_sessions: registry.ids(),
        spec: crate::host_metrics::sampler().spec(),
        supports_account_chains: true,
    };
    let register_json = serde_json::to_string(&register)?;
    out_tx
        .send(WsOutbound::json(register_json))
        .await
        .map_err(|_| anyhow!("ws sender already closed"))?;

    // Heartbeat task: also functions as the keepalive. If the write side
    // can't reach the channel (sender_task died) we know the WS is dead.
    let hb_tx = out_tx.clone();
    let mut heartbeat_task = tokio::spawn(async move {
        let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
        let mut ping = tokio::time::interval(WS_PING_INTERVAL);
        heartbeat.tick().await;
        ping.tick().await;
        let mut pong_liveness =
            crate::ws::PongLiveness::new(pong_count.load(std::sync::atomic::Ordering::Relaxed));
        loop {
            tokio::select! {
                _ = ping.tick() => {
                    let current = pong_count.load(std::sync::atomic::Ordering::Relaxed);
                    if pong_liveness.before_ping(current) {
                        tracing::warn!("two websocket pongs missed; treating control socket as disconnected");
                        break;
                    }
                    if hb_tx.send(WsOutbound::ping()).await.is_err() {
                        tracing::warn!("websocket ping send failed; ws likely dead");
                        break;
                    }
                }
                _ = heartbeat.tick() => {
                    let (cpu_bucket, mem_bucket) = crate::host_metrics::sampler().heartbeat_buckets();
                    let frame = match serde_json::to_string(&Outbound::HostHeartbeat {
                        cpu_bucket,
                        mem_bucket,
                    }) {
                        Ok(s) => s,
                        Err(_) => continue,
                    };
                    if hb_tx.send(WsOutbound::json(frame)).await.is_err() {
                        tracing::warn!("heartbeat send failed; ws likely dead");
                        break;
                    }
                }
            }
        }
    });

    // Race the dispatch loop against the IO tasks. Whichever finishes
    // first ends the session — this is what makes WS death reliably
    // visible even when the read-side EOF detection misbehaves at the
    // kernel/tungstenite layer. Scoped so `dispatch_fut`'s borrow of
    // `out_tx` releases before we drop it below.
    let dispatch_result = {
        let dispatch_fut = dispatch_loop(
            &mut in_rx,
            registry,
            rtc_sessions,
            &out_tx,
            live_credentials,
            daemon_revoked,
            Arc::clone(&registered_at),
        );
        tokio::pin!(dispatch_fut);
        tokio::select! {
            biased;
            reader = &mut reader_task => {
                let result = match reader {
                    Ok(ws::ReaderOutcome::Closed(disposition, auth_refusal)) => {
                        Err(ws::close_error_with_auth(disposition, auth_refusal))
                    }
                    Err(_) => Ok(()),
                };
                tracing::info!("ws reader task ended; ending session");
                ActiveSessionEvent::SessionEnded(result)
            }
            r = &mut dispatch_fut => ActiveSessionEvent::SessionEnded(r),
            _ = &mut sender_task => {
                tracing::info!("ws sender task ended (write error); ending session");
                ActiveSessionEvent::SessionEnded(Ok(()))
            }
            _ = &mut heartbeat_task => {
                tracing::info!("heartbeat task ended; ending session");
                ActiveSessionEvent::SessionEnded(Ok(()))
            }
            reloaded = wait_for_credential_change_with(live_credentials, poll_interval, loader) => {
                ActiveSessionEvent::CredentialReload(reloaded.map(Box::new))
            }
            _ = sighup_signal() => {
                tracing::info!("SIGHUP received; reconnecting now");
                ActiveSessionEvent::SessionEnded(Err(ws::close_error(
                    ws::CloseDisposition::ImmediateReconnect,
                )))
            }
        }
    };

    // Tear down this session. A trust reload drops and joins the WebSocket I/O
    // tasks before peer/sink cleanup so a hard loader failure cannot retain a
    // stale control transport. Ordinary socket endings clear per-session sinks
    // first; forwarders keep draining bounded worker output into direct
    // viewers and reconnect catches up from worker replay. We abort rather
    // than attempting a graceful WebSocket close because the final TCP write
    // can hang. Only the reload branch re-awaits the aborted handles: no I/O
    // handle was the winning `select!` branch there.
    let credential_reload = matches!(&dispatch_result, ActiveSessionEvent::CredentialReload(_));
    if credential_reload {
        // A hard loader failure is fatal. Drop the transport tasks before any
        // potentially slow sink/peer cleanup so the stale control socket can
        // no longer deliver work after the reply deadline fires.
        heartbeat_task.abort();
        reader_task.abort();
        sender_task.abort();
        let _ = tokio::join!(&mut heartbeat_task, &mut reader_task, &mut sender_task);
        rtc_sessions.clear_ws_sender();
        rtc_sessions.invalidate_trust_and_close_all().await;
        clear_session_sinks(registry).await;
    } else {
        rtc_sessions.clear_ws_sender();
        clear_session_sinks(registry).await;
    }
    heartbeat_task.abort();
    reader_task.abort();
    sender_task.abort();
    drop(out_tx);
    drop(sender_task);
    drop(reader_task);
    drop(heartbeat_task);
    match dispatch_result {
        ActiveSessionEvent::SessionEnded(result) => {
            let stable = registered_at
                .lock()
                .expect("registered timestamp lock")
                .is_some_and(|registered| registered.elapsed() >= Duration::from_secs(60));
            Ok(ServeOutcome::SessionEnded(SessionEnd { result, stable }))
        }
        ActiveSessionEvent::CredentialReload(result) => {
            Ok(ServeOutcome::CredentialsChanged(result?))
        }
    }
}

/// Install this WS connection's outbound sender as the forwarder sink for
/// every session currently in the registry. Browser reconnects request a
/// checkpoint replay from the owning worker, so no daemon-side repaint is
/// needed; foreground reports emitted while no connection existed are
/// re-announced so the server converges without waiting for a change.
async fn install_session_sinks(registry: &SessionRegistry, out_tx: &mpsc::Sender<WsOutbound>) {
    for (session_id, control) in registry.snapshot_controls() {
        control.set_sink(out_tx.clone()).await;
        control.resend_foreground(session_id).await;
    }
}

/// Clear all forwarder sinks. Called when the session ends. Forwarders park
/// on `notified()` until a new session runs `install_session_sinks`.
async fn clear_session_sinks(registry: &SessionRegistry) {
    for (_, control) in registry.snapshot_controls() {
        control.clear_sink().await;
    }
}

// Verify an opaque signed RTC offer against this host's identity and each
// locally-approved browser pin. Returns the verified signal on the first pin
// that matches (the browser that signed it is `sender_public_key`); `None`
// when no local pin verifies it, so an unverifiable offer is never downgraded.
// Whether this daemon refuses RTC offers that carry no verified signed
// envelope.
//
// On by default (see `require_signed_rtc_offers`): an unsigned offer to a
// daemon that has never pinned the offering browser is exactly the attack
// signed signaling refuses. `SPAWND_REQUIRE_SIGNED_RTC=0` is the escape hatch
// for operators who accept raw first-contact (e.g. recovering a deployment
// whose browser identities were lost).
//
// While it is off, the browser-side pin gate still protects the operator's own
// browser from being downgraded, but does not stop a server from opening its
// own unsigned session to this daemon — so authentication soundness (P5 in
// docs/TRUST_DEVICE_MESH.md) holds only with enforcement on (assumption A7).

/// Run one blocking credential mutation off the Tokio dispatch task with the
/// exact isolation the single-flight loader uses for the same backend:
///
///  * the credential-loader thread-local marker, so a keyring/file backend
///    panic is redacted by the installed hook to the fixed diagnostic instead
///    of printing the raw payload (which can carry secret material); and
///  * a `catch_unwind`, so such a panic can never unwind across the async
///    boundary or abort the process.
///
/// `creds::load()`/`save()` reach a cross-process lock, the filesystem, and a
/// native keyring; running them inline on a Tokio task both blocks the runtime
/// and bypasses this redaction. The work is bounded by the same hard deadline
/// as a loader load: on timeout the abandoned blocking job still runs to
/// completion on its pool thread, but no longer stalls dispatch.
async fn run_isolated_credential_blocking<T, F>(work: F) -> Result<T>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    // Idempotent (`Once`): the daemon run path installs this when it builds the
    // loader, but keep the invariant independent of call order.
    install_credential_loader_panic_hook();
    let handle = tokio::task::spawn_blocking(move || {
        IS_CREDENTIAL_LOADER_THREAD.with(|marker| marker.set(true));
        let outcome = catch_unwind(AssertUnwindSafe(work));
        // Return the pooled blocking thread to a neutral identity so a later
        // unrelated blocking task on it is not mistaken for the loader and its
        // panic wrongly redacted. This always runs: `catch_unwind` returns.
        IS_CREDENTIAL_LOADER_THREAD.with(|marker| marker.set(false));
        outcome
    });
    match tokio::time::timeout(CREDENTIAL_LOAD_DEADLINE, handle).await {
        // Never format the caught payload: like the loader's diagnostic, it can
        // carry credential-backend secrets. Drop it and surface a fixed error.
        Ok(Ok(Ok(value))) => Ok(value),
        Ok(Ok(Err(_panic))) => Err(anyhow!("credential reconcile failed; trust unchanged")),
        Ok(Err(_join)) => Err(anyhow!("credential reconcile task failed; trust unchanged")),
        Err(_elapsed) => Err(anyhow!("credential reconcile exceeded its hard deadline")),
    }
}

/// Bring local browser pins in line with what the server reports.
///
/// Adoption first, then pruning: a device admitted by this very frame would
/// otherwise be dropped immediately for being absent from the id list. Only an
/// endorsement verifiable against a key already pinned here can add anything;
/// removals are taken from the server, which can only reduce access.
///
/// The backing `creds::load()`/`save()` calls run through
/// [`run_isolated_credential_blocking`], never inline on this Tokio task, so a
/// backend panic during reconcile is redacted exactly like the loader's and
/// cannot leak secret material to stderr/logs.
async fn reconcile_browser_pins(
    account_id: Option<&str>,
    proposed: Option<&[crate::proto::InboundBrowserPin]>,
    live_device_ids: Option<&[String]>,
    out_tx: &mpsc::Sender<WsOutbound>,
) {
    // Snapshot the frame into owned values on the async task; only the blocking
    // keyring/file load+save is moved off Tokio below.
    let adopt = match (account_id, proposed) {
        (Some(account), Some(proposed)) => {
            let account = account.to_owned();
            let candidates: Vec<creds::ProposedBrowserPin> = proposed
                .iter()
                .map(|pin| creds::ProposedBrowserPin {
                    device_id: pin.browser_device_id.clone(),
                    key_algorithm: pin.browser_key_algorithm.clone(),
                    public_key: pin.browser_public_key.clone(),
                    fingerprint: pin.browser_key_fingerprint.clone(),
                    endorser_public_key: pin.endorser_public_key.clone(),
                    endorsement_signature: pin.endorsement_signature.clone(),
                })
                .collect();
            Some((account, candidates))
        }
        _ => None,
    };
    // Absent the field nothing is dropped, so an older server cannot empty the
    // local pins by staying silent.
    let proposed_ids = proposed
        .unwrap_or_default()
        .iter()
        .map(|pin| pin.browser_device_id.clone())
        .collect::<Vec<_>>();
    let prune = live_device_ids.map(<[String]>::to_vec);
    if adopt.is_none() && prune.is_none() {
        return;
    }

    type ReconcileOutcomes = (
        Option<Result<Vec<creds::PinAdoptionOutcome>>>,
        Option<Result<usize>>,
    );
    let outcome = run_isolated_credential_blocking(move || -> ReconcileOutcomes {
        // Ordinary (non-panic) backend errors on one side do not skip the
        // other, matching the previous inline behavior; only a genuine panic
        // short-circuits both, which the isolation redacts and fails closed.
        let adopted = adopt.as_ref().map(|(account, candidates)| {
            creds::adopt_endorsed_browser_pins_report(account, candidates)
        });
        let removed = prune
            .as_ref()
            .map(|live| creds::prune_browser_pins_to_live_set(live));
        (adopted, removed)
    })
    .await;

    let (adopted, removed) = match outcome {
        Ok(outcomes) => outcomes,
        Err(error) => {
            tracing::warn!(
                error = format!("{error:#}"),
                "could not reconcile browser pins off the dispatch task"
            );
            send_pin_adoption_failures(out_tx, &proposed_ids, "other").await;
            return;
        }
    };

    let mut changed = false;
    match adopted {
        None => {}
        Some(Ok(outcomes)) => {
            let adopted = outcomes
                .iter()
                .filter(|outcome| outcome.newly_adopted)
                .count();
            changed |= adopted > 0;
            if adopted > 0 {
                tracing::info!(
                    adopted,
                    "adopted browser pins endorsed by an already-trusted device"
                );
            }
            for outcome in outcomes {
                let frame = match outcome.reason {
                    None => Outbound::HostPinAdopted {
                        browser_device_id: outcome.device_id,
                    },
                    Some(reason) => Outbound::HostPinAdoptFailed {
                        browser_device_id: outcome.device_id,
                        reason: reason.to_string(),
                    },
                };
                if let Ok(frame) = serde_json::to_string(&frame) {
                    let _ = out_tx.send(WsOutbound::json(frame)).await;
                }
            }
        }
        Some(Err(error)) => {
            tracing::warn!(
                error = format!("{error:#}"),
                "could not adopt endorsed browser pins"
            );
            send_pin_adoption_failures(out_tx, &proposed_ids, "other").await;
        }
    }
    match removed {
        None | Some(Ok(0)) => {}
        Some(Ok(removed)) => {
            changed = true;
            tracing::warn!(removed, "dropped browser pins the server no longer lists");
        }
        Some(Err(error)) => tracing::warn!(
            error = format!("{error:#}"),
            "could not reconcile browser pins against the server"
        ),
    }
    if changed {
        // A revocation (or adoption) this daemon just wrote must reach the
        // in-memory verifier snapshot now, not on the next poll tick: nudge
        // the credential-change waiter so the ~500 ms stale-pin window (during
        // which a revoked browser's signed offers still verify) collapses to
        // the reload itself.
        credentials_touched_notify().notify_one();
    }
}

async fn send_pin_adoption_failures(
    out_tx: &mpsc::Sender<WsOutbound>,
    device_ids: &[String],
    reason: &str,
) {
    for browser_device_id in device_ids {
        let frame = Outbound::HostPinAdoptFailed {
            browser_device_id: browser_device_id.clone(),
            reason: reason.to_owned(),
        };
        if let Ok(frame) = serde_json::to_string(&frame) {
            let _ = out_tx.send(WsOutbound::json(frame)).await;
        }
    }
}

/// Wakes the credential-change poller immediately after a local write that
/// must be observed promptly (browser-pin adoption/revocation). At most one
/// session loop waits at a time; a missed wake degrades to the poll interval.
fn credentials_touched_notify() -> &'static tokio::sync::Notify {
    static CREDENTIALS_TOUCHED: std::sync::OnceLock<tokio::sync::Notify> =
        std::sync::OnceLock::new();
    CREDENTIALS_TOUCHED.get_or_init(tokio::sync::Notify::new)
}

/// The account chained endorsements are scoped to (device mesh §3).
///
/// The server names one on every `registered` / `host.browser_pins` frame,
/// and that used to be taken as read. This host's own pins hold a better
/// answer: the account id each browser approval was signed over, re-verified
/// on load (`StoredCreds::proven_account_id`). A wrong account could only
/// ever deny the chain path — it matches no legitimate chain — never grant
/// one, so nothing here was exploitable; but a server-controlled input to a
/// trust decision is one thing fewer to reason about when the local copy
/// wins. The server's value fills in only while no pin carries a proof.
fn resolve_daemon_account(proven: Option<[u8; 16]>, reported: Option<&str>) -> Option<[u8; 16]> {
    let reported = reported.and_then(|value| account_id_bytes(value).ok());
    match (proven, reported) {
        (Some(local), Some(server)) => {
            if local != server {
                tracing::warn!(
                    "server named a different account for this host than its own approval proofs do; keeping the proven one"
                );
            }
            Some(local)
        }
        (Some(local), None) => Some(local),
        (None, server) => server,
    }
}

fn require_signed_rtc_offers() -> bool {
    // Enforcement is the default: an unsigned offer to a daemon that has never
    // pinned the offering browser is exactly the attack signed signaling
    // exists to refuse. `SPAWND_REQUIRE_SIGNED_RTC=0` (or `false`) is the
    // explicit escape hatch for operators who accept raw first-contact
    // connections — e.g. while recovering a deployment whose every browser
    // identity was lost.
    !std::env::var_os("SPAWND_REQUIRE_SIGNED_RTC")
        .is_some_and(|value| value == "0" || value == "false")
}

/// The fingerprint of whoever signed a refused offer, for the console line the
/// operator is standing in front of. The envelope failed verification, so this
/// is the sender's own unverified claim about itself — useful only for naming
/// the device to approve, never for a trust decision.
fn claimed_offer_fingerprint(envelope: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(envelope).ok()?;
    let claimed = parsed.get("sender_identity_public_key")?.as_str()?;
    public_key_from_wire(claimed).ok()?;
    creds::browser_key_fingerprint(claimed).ok()
}

/// Answer a refused RTC offer instead of dropping it.
///
/// A daemon that simply `continue`s leaves the browser watching an indefinite
/// "connecting" spinner: the relay has a live binding, no answer ever arrives,
/// and nothing distinguishes an unapproved device from a host that is asleep.
/// Echoing the offer's own routing tuple is what lets the relay match this
/// status to that binding and forward it.
#[allow(clippy::too_many_arguments)]
fn refuse_rtc_offer(
    out_tx: &mpsc::Sender<WsOutbound>,
    signal_id: &str,
    binding_nonce: Option<&String>,
    scope_type: Option<&String>,
    scope_id: Option<Uuid>,
    protocol: Option<&String>,
    protocol_version: Option<u16>,
    message: &str,
) {
    // Without the nonce the relay cannot bind the status to the offer, so
    // there is nobody to tell.
    let Some(nonce) = binding_nonce else {
        return;
    };
    let frame = Outbound::RtcStatus {
        session_id: signal_id.to_string(),
        binding_nonce: Some(nonce.clone()),
        scope_type: scope_type.cloned(),
        scope_id,
        protocol: protocol.cloned(),
        protocol_version,
        status: "failed".to_string(),
        message: Some(message.to_string()),
    };
    if let Ok(text) = serde_json::to_string(&frame) {
        let _ = out_tx.try_send(WsOutbound::json(text));
    }
}

const RTC_REFUSED_UNPINNED_BROWSER: &str =
    "This host has not approved this device. Approve it from a device this host already trusts, or pair the host again.";

fn verify_signed_rtc_offer(envelope: &str, record: &StoredCreds) -> Option<VerifiedRtcSignal> {
    let host_identity = creds::host_identity(record).ok().flatten()?;
    let host_key = public_key_from_wire(&host_identity.public_key).ok()?;
    for pin in record.browser_pins() {
        let Ok(browser_key) = public_key_from_wire(pin.public_key()) else {
            continue;
        };
        if let Ok(verified) = verify_rtc_signal_wire(envelope, &browser_key, &host_key) {
            return Some(verified);
        }
    }
    None
}

/// Reconstruct verifiable endorsement edges from the wire form carried on an
/// offer. Malformed edges are dropped rather than fatal — the chain search
/// simply won't use them, and a genuine chain is unaffected.
fn parse_carried_endorsements(carried: &[CarriedEndorsement]) -> Vec<ChainEdge> {
    carried
        .iter()
        .filter_map(|edge| {
            let transcript = AcctEndorsementTranscript::from_wire(
                &edge.account_id,
                &edge.endorser_public_key,
                &edge.endorsed_public_key,
                &edge.endorsed_device_id,
            )
            .ok()?;
            let signature = signature_from_wire(&edge.signature).ok()?;
            Some(ChainEdge {
                transcript,
                signature,
            })
        })
        .collect()
}

/// Admit a signed RTC offer either because the offering key is directly pinned
/// (the shipped single-hop path) or because it reaches one of this host's pins —
/// its anchors — through a carried account-endorsement chain (device mesh §3).
///
/// The chain path still proves possession: the offer must verify against its own
/// claimed sender key (an EUF-CMA signature that binds the offer's DTLS
/// fingerprint), exactly as the direct path proves it against a pinned key.
/// `find_valid_chain` then decides whether that proven-possessed key is trusted
/// for this account. So the server, holding no private key, can neither sign a
/// valid offer nor forge a chain edge; carried edges only ever *extend reach*,
/// never grant it. `None` (falling through to the caller's rejection) whenever
/// the account is unknown, no edges are carried, or no chain reaches an anchor.
fn verify_signed_rtc_offer_admitted(
    envelope: &str,
    record: &StoredCreds,
    account_id: Option<&[u8; 16]>,
    revoked: &RevocationSet,
    carried: &[CarriedEndorsement],
) -> Option<VerifiedRtcSignal> {
    // Fast path: a directly-pinned browser key.
    if let Some(verified) = verify_signed_rtc_offer(envelope, record) {
        // Fail-closed: a revoked key never connects, even if a pin still lingers
        // (the deny-list is delivered independently of pin reconciliation).
        if revoked.contains(&verified.sender_public_key().to_bytes()) {
            tracing::warn!(reason = "revoked-pinned-key", "signed RTC offer refused");
            return None;
        }
        return Some(verified);
    }
    // Chain path only when the offer carries edges and we know our own account.
    // Each refusal names its reason: an uninformative reject line made a real
    // admission failure undiagnosable in the field.
    let Some(account_id) = account_id else {
        tracing::warn!(reason = "no-account-anchor", "signed RTC offer refused");
        return None;
    };
    if carried.is_empty() {
        tracing::warn!(
            reason = "no-carried-endorsements",
            "signed RTC offer refused"
        );
        return None;
    }
    // Independent daemon-side cap, before any parse or signature work. The
    // honest relay bounds carried sets to the same 64, so an over-cap list only
    // ever comes from a party driving this socket directly; the wire
    // deserializer already refuses such frames, and this re-check keeps the
    // bound local to the admission path (defense in depth, named refusal).
    if carried.len() > MAX_CARRIED_ENDORSEMENTS {
        tracing::warn!(
            reason = "carried-endorsements-over-cap",
            carried = carried.len(),
            max = MAX_CARRIED_ENDORSEMENTS,
            "signed RTC offer refused"
        );
        return None;
    }
    let Some(host_identity) = creds::host_identity(record).ok().flatten() else {
        tracing::warn!(reason = "no-host-identity", "signed RTC offer refused");
        return None;
    };
    let Ok(host_key) = public_key_from_wire(&host_identity.public_key) else {
        tracing::warn!(reason = "bad-host-key", "signed RTC offer refused");
        return None;
    };
    // Verify against the sender the envelope CLAIMS: this proves possession of
    // that private key. Only a proven-possessed key is a candidate for a chain.
    let Ok(claimed_sender) = envelope_sender(envelope) else {
        tracing::warn!(
            reason = "unreadable-envelope-sender",
            "signed RTC offer refused"
        );
        return None;
    };
    let Ok(verified) = verify_rtc_signal_wire(envelope, &claimed_sender, &host_key) else {
        tracing::warn!(
            reason = "envelope-verification-failed",
            "signed RTC offer refused"
        );
        return None;
    };
    let anchors: Vec<_> = record
        .browser_pins()
        .iter()
        .filter_map(|pin| public_key_from_wire(pin.public_key()).ok())
        .collect();
    let edges = parse_carried_endorsements(carried);
    // find_valid_chain rejects any chain whose keys (anchor, intermediates, or
    // the connecting key) are on the deny-list.
    match find_valid_chain(
        account_id,
        &anchors,
        revoked,
        verified.sender_public_key(),
        &edges,
        DEFAULT_MAX_CHAIN_EDGES,
    ) {
        Ok(()) => Some(verified),
        Err(error) => {
            tracing::warn!(
                reason = "no-valid-chain",
                ?error,
                sender = %short_key(verified.sender_public_key()),
                carried = carried.len(),
                parsed_edges = edges.len(),
                anchors = anchors.len(),
                "signed RTC offer refused"
            );
            None
        }
    }
}

/// First bytes of a key, hex, for log correlation (never a trust input).
fn short_key(key: &ed25519_dalek::VerifyingKey) -> String {
    key.to_bytes()[..6]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Build the deny-list from the wire keys the server delivers. Malformed keys
/// are skipped (they can never be a valid connecting key anyway).
fn revocation_set_from_wire(keys: Option<&[String]>) -> RevocationSet {
    let mut set = RevocationSet::new();
    for key in keys.into_iter().flatten() {
        if let Ok(verifying) = public_key_from_wire(key) {
            set.insert(verifying.to_bytes());
        }
    }
    set
}

/// Build the owned answer signer for a verified signed offer. The answer
/// transcript reuses the verified offer's exact session, scope, and protocol,
/// and binds the browser (offer sender) as the intended peer. `None` only when
/// the host identity has gone away.
fn build_rtc_answer_signer(
    record: &StoredCreds,
    verified: &VerifiedRtcSignal,
) -> Result<Option<RtcAnswerSigner>> {
    let Some(host_signer) = creds::host_rtc_answer_signer(record)? else {
        return Ok(None);
    };
    let protocol = verified.protocol();
    let transcript = verified.transcript();
    let protocol_version = transcript.protocol_version();
    let scope_type = transcript.scope_type();
    let scope_id = transcript.scope_id().to_string();
    let session_id = transcript.session_id().to_string();
    let peer_bytes = verified.sender_public_key().to_bytes();
    let signer: RtcAnswerSigner = Arc::new(move |local_sdp: &str| -> Result<String> {
        let answer = SignedSignalTranscript::new(
            SignalKind::Answer,
            protocol_version,
            session_id.clone(),
            scope_type,
            scope_id.clone(),
            SenderRole::Daemon,
            peer_bytes,
            local_sdp,
        )
        .context("building signed RTC answer transcript")?;
        host_signer.sign(protocol, &answer)
    });
    Ok(Some(signer))
}

async fn handle_daemon_update(
    server_origin: url::Url,
    request_id: String,
    request: crate::update::UpdateRequest,
    out_tx: mpsc::Sender<WsOutbound>,
) {
    let tree = request.tree.clone();
    let version_before = crate::version::build_version();
    match crate::update::apply(&server_origin, request).await {
        Ok(applied) => {
            let result = Outbound::DaemonUpdateResult {
                request_id,
                ok: true,
                tree,
                version_before,
                stage: None,
                error: None,
            };
            if let Ok(serialized) = serde_json::to_string(&result) {
                let flushed = tokio::time::timeout(Duration::from_secs(2), async {
                    let (frame, frame_flushed) = WsOutbound::tracked_json(serialized);
                    out_tx.send(frame).await.map_err(|_| ())?;
                    frame_flushed.notified().await;
                    let (close, close_flushed) = WsOutbound::tracked_close();
                    out_tx.send(close).await.map_err(|_| ())?;
                    close_flushed.notified().await;
                    Ok::<(), ()>(())
                })
                .await;
                if !matches!(flushed, Ok(Ok(()))) {
                    tracing::warn!(
                        stage = crate::update::UpdateStage::Exec.as_str(),
                        "self-update result flush exceeded its bounded window"
                    );
                }
            }
            let failure = crate::update::exec(applied);
            tracing::error!(
                stage = failure.stage.as_str(),
                error = failure.error,
                "SPAWN D daemon self-update failed"
            );
        }
        Err(failure) => {
            tracing::warn!(
                stage = failure.stage.as_str(),
                error = failure.error,
                "SPAWN D daemon self-update failed"
            );
            let result = Outbound::DaemonUpdateResult {
                request_id,
                ok: false,
                tree,
                version_before,
                stage: Some(failure.stage.as_str().to_string()),
                error: Some(failure.error.to_string()),
            };
            if let Ok(serialized) = serde_json::to_string(&result) {
                let _ = out_tx.send(WsOutbound::json(serialized)).await;
            }
        }
    }
}

type RtcSignalJob = Pin<Box<dyn Future<Output = ()> + Send>>;

fn enqueue_rtc_job(
    tasks: &mut HashMap<String, mpsc::UnboundedSender<RtcSignalJob>>,
    signal_id: String,
    job: RtcSignalJob,
) {
    let sender = tasks.entry(signal_id).or_insert_with(|| {
        let (sender, mut receiver) = mpsc::unbounded_channel::<RtcSignalJob>();
        tokio::spawn(async move {
            while let Some(job) = receiver.recv().await {
                job.await;
            }
        });
        sender
    });
    let _ = sender.send(job);
}

async fn dispatch_loop(
    in_rx: &mut mpsc::Receiver<WsInbound>,
    registry: &SessionRegistry,
    rtc_sessions: &RtcSessions,
    out_tx: &mpsc::Sender<WsOutbound>,
    live_credentials: &LiveCredentialSnapshot,
    daemon_revoked: &mut RevocationSet,
    registered_at: Arc<StdMutex<Option<Instant>>>,
) -> Result<()> {
    let mut rtc_tasks: HashMap<String, mpsc::UnboundedSender<RtcSignalJob>> = HashMap::new();
    // This host's account, as canonical UUID bytes. Used to scope carried
    // endorsement chains at connect (device mesh §3). A wrong/absent value only
    // denies the chain path — it never grants — so a lying server can at most
    // withhold chained admission, not forge it. Even so, the local pins carry
    // the answer (`resolve_daemon_account`), so the server's word is only
    // used while no pin carries an approval proof.
    let proven_account = live_credentials
        .record
        .proven_account_id()
        .and_then(|value| account_id_bytes(&value).ok());
    let mut daemon_account: Option<[u8; 16]> = proven_account;
    // `daemon_revoked` is the account deny-list (device mesh §3): keys the
    // server reports as revoked, subtracted from acceptance. Fail-closed and
    // subtract-only — it can only reject a connection, never admit one, so
    // server authority over it is safe. It is owned by the supervisor, not this
    // connection, and every delivered list is UNIONED in (`absorb`), never
    // assigned: once a key is revoked it stays revoked for the life of the
    // process even if a later frame — or a later connection — omits it. The
    // durable backstop across restarts is the server's permanent tombstone
    // (R10); this floor removes the in-process half of the P3′ residual.
    while let Some(msg) = in_rx.recv().await {
        match msg {
            WsInbound::Closed {
                disposition,
                auth_refusal,
            } => {
                return Err(ws::close_error_with_auth(disposition, auth_refusal));
            }
            WsInbound::Json(frame) => match *frame {
                Inbound::Registered {
                    host_id,
                    access_token,
                    account_id,
                    browser_pins,
                    browser_device_ids,
                    revoked_browser_keys,
                } => {
                    if host_id != live_credentials.host_id {
                        return Err(anyhow!("server registered daemon as an unexpected host"));
                    }
                    if !rtc_sessions.bind_registered_host_id(host_id).await {
                        return Err(anyhow!("server registered daemon as an unexpected host"));
                    }
                    tracing::info!(%host_id, "registered with server");
                    *registered_at.lock().expect("registered timestamp lock") =
                        Some(Instant::now());
                    crate::update::registered(out_tx).await;
                    if let Some(access_token) = access_token {
                        let persisted = run_isolated_credential_blocking(move || {
                            creds::replace_access_token(&access_token)
                        })
                        .await;
                        match persisted {
                            Ok(Ok(())) => credentials_touched_notify().notify_one(),
                            Ok(Err(error)) | Err(error) => tracing::warn!(
                                error = format!("{error:#}"),
                                "could not persist rotated daemon token"
                            ),
                        }
                    }
                    rtc_sessions.reannounce_live_statuses().await;
                    daemon_account = resolve_daemon_account(proven_account, account_id.as_deref());
                    let newly_revoked = daemon_revoked
                        .absorb(revocation_set_from_wire(revoked_browser_keys.as_deref()));
                    reconcile_browser_pins(
                        account_id.as_deref(),
                        browser_pins.as_deref(),
                        browser_device_ids.as_deref(),
                        out_tx,
                    )
                    .await;
                    if newly_revoked {
                        // RTC channels are peer-to-peer and can outlive a
                        // control-WS reconnect, so a device revoked while this
                        // daemon was disconnected must lose its live channel at
                        // re-registration, not keep it (R1). On the first
                        // registration of a fresh process no sessions exist and
                        // this is a no-op.
                        tracing::info!(
                            "revocations learned at registration: closing live RTC sessions for re-admission"
                        );
                        rtc_sessions.invalidate_trust_and_close_all().await;
                    }
                }
                Inbound::HostBrowserPins {
                    account_id,
                    browser_pins,
                    browser_device_ids,
                    revoked_browser_keys,
                } => {
                    // Pushed when the set changes, so endorsing OR revoking a
                    // device takes effect immediately instead of waiting for the
                    // daemon to happen to reconnect -- which could be hours.
                    daemon_account = resolve_daemon_account(proven_account, account_id.as_deref());
                    // Union, never replace: a shorter or absent pushed list must
                    // not un-revoke (the deny-list is add-only end to end, R10;
                    // a shrinking frame can only mean a withholding server).
                    let newly_revoked = daemon_revoked
                        .absorb(revocation_set_from_wire(revoked_browser_keys.as_deref()));
                    reconcile_browser_pins(
                        account_id.as_deref(),
                        browser_pins.as_deref(),
                        browser_device_ids.as_deref(),
                        out_tx,
                    )
                    .await;
                    if newly_revoked {
                        // R1: a device revoked mid-session must lose its live
                        // channel NOW, not only be blocked from new connects.
                        // Close every session and force re-admission under the
                        // new deny-list: the revoked device's re-offer is
                        // rejected while legitimate devices reconnect. Blunt but
                        // fail-closed and reuses the trust-invalidation path; a
                        // future refinement could tear down only sessions whose
                        // chain includes a revoked key by tracking admitting keys
                        // per session.
                        tracing::info!(
                            "revocation update: closing live RTC sessions for re-admission"
                        );
                        rtc_sessions.invalidate_trust_and_close_all().await;
                    }
                }
                Inbound::HostHeartbeat => {
                    tracing::trace!("host heartbeat ack");
                }
                Inbound::HostPing { request_id } => {
                    if let Ok(frame) = serde_json::to_string(&Outbound::HostPong { request_id }) {
                        let _ = out_tx.send(WsOutbound::json(frame)).await;
                    }
                }
                Inbound::DaemonUpdate {
                    request_id,
                    version,
                    tree,
                    target,
                    spawnd,
                    spawn_worker,
                    allow_downgrade,
                } => {
                    let server_origin = live_credentials
                        .server_origin
                        .parse::<url::Url>()
                        .expect("validated server origin remains a URL");
                    let out_tx = out_tx.clone();
                    let update_request_id = request_id.clone();
                    tokio::spawn(handle_daemon_update(
                        server_origin,
                        request_id,
                        crate::update::UpdateRequest {
                            request_id: Some(update_request_id),
                            version,
                            tree,
                            target,
                            spawnd,
                            spawn_worker,
                            allow_downgrade,
                        },
                        out_tx,
                    ));
                }
                Inbound::HostAgentsCheck {
                    request_id,
                    targets,
                } => {
                    handle_host_agents_check(request_id, targets, out_tx).await;
                }
                Inbound::HostAgentsInstall { request_id, target } => {
                    handle_host_agents_install(request_id, target, out_tx).await;
                }
                Inbound::SessionCreate(create) => {
                    handle_session_create(create, registry, rtc_sessions, out_tx).await;
                }
                Inbound::SessionRestart(create) => {
                    handle_session_restart(create, registry, rtc_sessions, out_tx).await;
                }
                Inbound::SessionKill { session_id, signal } => {
                    handle_session_kill(session_id, signal, registry, rtc_sessions, out_tx).await;
                }
                Inbound::RtcOffer {
                    session_id: signal_id,
                    binding_nonce,
                    binding_generation,
                    scope_type,
                    scope_id,
                    protocol,
                    protocol_version,
                    sdp,
                    signed_envelope,
                    carried_endorsements,
                    ice_servers,
                    ice_transport_policy,
                    ice_restart,
                } => {
                    if signed_envelope.is_some() && sdp.is_some() {
                        tracing::warn!("rejecting mixed signed/raw RTC offer");
                        continue;
                    }
                    // A signed offer must prove possession of a key this host
                    // trusts — directly pinned, or reached through a carried
                    // endorsement chain to an anchor — and describe exactly this
                    // session; it is never downgraded to a raw SDP.
                    let verified_offer = match &signed_envelope {
                        Some(envelope) => {
                            match verify_signed_rtc_offer_admitted(
                                envelope,
                                &live_credentials.record,
                                daemon_account.as_ref(),
                                daemon_revoked,
                                &carried_endorsements,
                            ) {
                                Some(verified)
                                    if verified.transcript().session_id() == signal_id.as_str() =>
                                {
                                    tracing::info!(
                                        scope_type = ?verified.transcript().scope_type(),
                                        scope_id = %verified.transcript().scope_id(),
                                        chained = !carried_endorsements.is_empty(),
                                        sender = %short_key(verified.sender_public_key()),
                                        "verified signed RTC offer against a local browser pin or chain"
                                    );
                                    Some(verified)
                                }
                                Some(_) => {
                                    tracing::warn!(
                                        "rejecting signed RTC offer with mismatched session"
                                    );
                                    refuse_rtc_offer(
                                        out_tx,
                                        &signal_id,
                                        binding_nonce.as_ref(),
                                        scope_type.as_ref(),
                                        scope_id,
                                        protocol.as_ref(),
                                        protocol_version,
                                        "The offer did not describe the session it was routed to.",
                                    );
                                    continue;
                                }
                                None => {
                                    match claimed_offer_fingerprint(envelope) {
                                        Some(fingerprint) => tracing::warn!(
                                            claimed_browser_fingerprint = %fingerprint,
                                            "refusing an RTC offer from a browser this host has \
                                             not approved; approve that fingerprint from a \
                                             device this host already trusts, or re-run \
                                             `spawnd login` and approve from the new device"
                                        ),
                                        None => tracing::warn!(
                                            "rejecting signed RTC offer that no local pin verified"
                                        ),
                                    }
                                    refuse_rtc_offer(
                                        out_tx,
                                        &signal_id,
                                        binding_nonce.as_ref(),
                                        scope_type.as_ref(),
                                        scope_id,
                                        protocol.as_ref(),
                                        protocol_version,
                                        RTC_REFUSED_UNPINNED_BROWSER,
                                    );
                                    continue;
                                }
                            }
                        }
                        None => None,
                    };
                    let answer_signer = match &verified_offer {
                        Some(verified) => {
                            match build_rtc_answer_signer(&live_credentials.record, verified) {
                                Ok(Some(signer)) => Some(signer),
                                _ => {
                                    tracing::warn!(
                                        "cannot sign RTC answer for verified signed offer"
                                    );
                                    refuse_rtc_offer(
                                        out_tx,
                                        &signal_id,
                                        binding_nonce.as_ref(),
                                        scope_type.as_ref(),
                                        scope_id,
                                        protocol.as_ref(),
                                        protocol_version,
                                        "This host cannot sign an RTC answer right now.",
                                    );
                                    continue;
                                }
                            }
                        }
                        None => None,
                    };
                    let offer_key = verified_offer
                        .as_ref()
                        .map(|verified| verified.sender_public_key().to_bytes());
                    let offer_sdp = match &verified_offer {
                        Some(verified) => verified.transcript().sdp().to_string(),
                        None => {
                            if require_signed_rtc_offers() {
                                // Without this, the browser-side pin gate can be
                                // bypassed entirely: a server that simply omits
                                // the signed envelope gets a raw peer connection
                                // to the PTY without going near the browser.
                                tracing::warn!(
                                    "rejecting unsigned RTC offer: signed signaling is required"
                                );
                                refuse_rtc_offer(
                                    out_tx,
                                    &signal_id,
                                    binding_nonce.as_ref(),
                                    scope_type.as_ref(),
                                    scope_id,
                                    protocol.as_ref(),
                                    protocol_version,
                                    "This host requires signed RTC signalling.",
                                );
                                continue;
                            }
                            let Some(sdp) = sdp else {
                                tracing::warn!("rejecting RTC offer without SDP envelope");
                                continue;
                            };
                            sdp
                        }
                    };
                    match (
                        binding_nonce,
                        binding_generation,
                        scope_type,
                        scope_id,
                        protocol,
                        protocol_version,
                    ) {
                        (
                            Some(nonce),
                            Some(owner_generation),
                            Some(scope_type),
                            Some(scope_id),
                            Some(protocol),
                            Some(protocol_version),
                        ) if scope_type == "session"
                            && protocol == "spawn.pty"
                            && protocol_version == 2 =>
                        {
                            // A signed offer's verified scope must match this
                            // session routing, so a relay cannot redirect a
                            // signed offer to a different session.
                            if let Some(verified) = &verified_offer {
                                let t = verified.transcript();
                                if t.scope_type() != ScopeType::Session
                                    || t.scope_id() != scope_id.to_string().as_str()
                                {
                                    tracing::warn!(
                                        "signed RTC offer scope does not match session routing"
                                    );
                                    continue;
                                }
                            }
                            if let Some(binding) = crate::rtc::RtcSignalBinding::from_server(
                                signal_id,
                                nonce,
                                owner_generation,
                                scope_id,
                            ) {
                                let task_key = binding.signal_id().to_string();
                                let rtc_sessions = rtc_sessions.clone();
                                let registry = registry.clone();
                                let out_tx = out_tx.clone();
                                enqueue_rtc_job(
                                    &mut rtc_tasks,
                                    task_key,
                                    Box::pin(async move {
                                        rtc_sessions
                                            .handle_offer(
                                                binding,
                                                offer_sdp,
                                                ice_servers,
                                                ice_transport_policy,
                                                ice_restart,
                                                offer_key,
                                                registry,
                                                out_tx,
                                                answer_signer,
                                            )
                                            .await;
                                    }),
                                );
                            }
                        }
                        (
                            Some(binding_nonce),
                            binding_generation,
                            scope_type,
                            scope_id,
                            protocol,
                            protocol_version,
                        ) => {
                            // A signed host offer's verified scope must match the
                            // host routing for the same reason.
                            if let Some(verified) = &verified_offer {
                                let t = verified.transcript();
                                let scope_ok = t.scope_type() == ScopeType::Host
                                    && scope_id
                                        .as_ref()
                                        .is_some_and(|id| t.scope_id() == id.to_string().as_str());
                                if !scope_ok {
                                    tracing::warn!(
                                        "signed RTC offer scope does not match host routing"
                                    );
                                    continue;
                                }
                            }
                            let task_key = signal_id.clone();
                            let rtc_sessions = rtc_sessions.clone();
                            let out_tx = out_tx.clone();
                            enqueue_rtc_job(
                                &mut rtc_tasks,
                                task_key,
                                Box::pin(async move {
                                    rtc_sessions
                                        .handle_host_offer(
                                            HostRtcSignal {
                                                signal_id,
                                                binding_nonce: Some(binding_nonce),
                                                binding_generation,
                                                scope_type,
                                                scope_id,
                                                protocol,
                                                protocol_version,
                                            },
                                            offer_sdp,
                                            ice_servers,
                                            ice_transport_policy,
                                            out_tx,
                                            answer_signer,
                                        )
                                        .await;
                                }),
                            );
                        }
                        _ => tracing::warn!("rejecting malformed mixed-scope rtc offer"),
                    }
                }
                Inbound::RtcCandidate {
                    session_id: signal_id,
                    binding_nonce,
                    binding_generation,
                    scope_type,
                    scope_id,
                    protocol,
                    protocol_version,
                    candidate,
                } => {
                    match (
                        binding_nonce,
                        binding_generation,
                        scope_type,
                        scope_id,
                        protocol,
                        protocol_version,
                    ) {
                        (
                            Some(nonce),
                            Some(owner_generation),
                            Some(scope_type),
                            Some(scope_id),
                            Some(protocol),
                            Some(protocol_version),
                        ) if scope_type == "session"
                            && protocol == "spawn.pty"
                            && protocol_version == 2 =>
                        {
                            if let Some(binding) = crate::rtc::RtcSignalBinding::from_server(
                                signal_id,
                                nonce,
                                owner_generation,
                                scope_id,
                            ) {
                                let (signal_id, generation, session_id) =
                                    binding.into_routing_parts();
                                let task_key = signal_id.clone();
                                let rtc_sessions = rtc_sessions.clone();
                                enqueue_rtc_job(
                                    &mut rtc_tasks,
                                    task_key,
                                    Box::pin(async move {
                                        rtc_sessions
                                            .handle_candidate(
                                                signal_id, generation, session_id, candidate,
                                            )
                                            .await;
                                    }),
                                );
                            }
                        }
                        (
                            Some(binding_nonce),
                            binding_generation,
                            scope_type,
                            scope_id,
                            protocol,
                            protocol_version,
                        ) => {
                            let task_key = signal_id.clone();
                            let rtc_sessions = rtc_sessions.clone();
                            enqueue_rtc_job(
                                &mut rtc_tasks,
                                task_key,
                                Box::pin(async move {
                                    rtc_sessions
                                        .handle_host_candidate(
                                            HostRtcSignal {
                                                signal_id,
                                                binding_nonce: Some(binding_nonce),
                                                binding_generation,
                                                scope_type,
                                                scope_id,
                                                protocol,
                                                protocol_version,
                                            },
                                            candidate,
                                        )
                                        .await;
                                }),
                            );
                        }
                        _ => tracing::warn!("rejecting malformed mixed-scope rtc candidate"),
                    }
                }
                Inbound::RtcClose {
                    session_id: signal_id,
                    binding_nonce,
                    binding_generation,
                    scope_type,
                    scope_id,
                    protocol,
                    protocol_version,
                } => {
                    match (
                        binding_nonce,
                        binding_generation,
                        scope_type,
                        scope_id,
                        protocol,
                        protocol_version,
                    ) {
                        (
                            Some(nonce),
                            Some(owner_generation),
                            Some(scope_type),
                            Some(scope_id),
                            Some(protocol),
                            Some(protocol_version),
                        ) if scope_type == "session"
                            && protocol == "spawn.pty"
                            && protocol_version == 2 =>
                        {
                            if let Some(binding) = crate::rtc::RtcSignalBinding::from_server(
                                signal_id,
                                nonce,
                                owner_generation,
                                scope_id,
                            ) {
                                let (signal_id, generation, session_id) =
                                    binding.into_routing_parts();
                                let task_key = signal_id.clone();
                                let rtc_sessions = rtc_sessions.clone();
                                enqueue_rtc_job(
                                    &mut rtc_tasks,
                                    task_key,
                                    Box::pin(async move {
                                        rtc_sessions
                                            .close(&signal_id, &generation, session_id)
                                            .await;
                                    }),
                                );
                            }
                        }
                        (
                            Some(binding_nonce),
                            binding_generation,
                            scope_type,
                            scope_id,
                            protocol,
                            protocol_version,
                        ) => {
                            let task_key = signal_id.clone();
                            let rtc_sessions = rtc_sessions.clone();
                            enqueue_rtc_job(
                                &mut rtc_tasks,
                                task_key,
                                Box::pin(async move {
                                    rtc_sessions
                                        .close_host(HostRtcSignal {
                                            signal_id,
                                            binding_nonce: Some(binding_nonce),
                                            binding_generation,
                                            scope_type,
                                            scope_id,
                                            protocol,
                                            protocol_version,
                                        })
                                        .await;
                                }),
                            );
                        }
                        _ => tracing::warn!("rejecting malformed mixed-scope rtc close"),
                    }
                }
            },
        }
    }
    Ok(())
}

async fn handle_host_agents_check(
    request_id: String,
    targets: Vec<HostAgentTarget>,
    out_tx: &mpsc::Sender<WsOutbound>,
) {
    let mut checks = FuturesUnordered::new();
    let target_count = targets.len();
    for (index, target) in targets.into_iter().enumerate() {
        checks.push(async move { (index, check_host_agent(target).await) });
    }

    let mut indexed_agents: Vec<Option<HostAgentStatus>> =
        std::iter::repeat_with(|| None).take(target_count).collect();
    while let Some((index, agent)) = checks.next().await {
        if let Some(slot) = indexed_agents.get_mut(index) {
            *slot = Some(agent);
        }
    }
    let agents = indexed_agents.into_iter().flatten().collect();

    let frame = Outbound::HostAgentsCheckResult { request_id, agents };
    if let Ok(s) = serde_json::to_string(&frame) {
        let _ = out_tx.send(WsOutbound::json(s)).await;
    }
}

async fn handle_host_agents_install(
    request_id: String,
    target: HostAgentTarget,
    out_tx: &mpsc::Sender<WsOutbound>,
) {
    let result = install_host_agent(target).await;
    let frame = Outbound::HostAgentsInstallResult { request_id, result };
    if let Ok(s) = serde_json::to_string(&frame) {
        let _ = out_tx.send(WsOutbound::json(s)).await;
    }
}

async fn check_host_agent(target: HostAgentTarget) -> HostAgentStatus {
    let command = target.command.trim().to_string();
    if command.is_empty() {
        return HostAgentStatus {
            agent_id: target.agent_id,
            agent_name: target.agent_name,
            agent_kind: target.agent_kind,
            command,
            install: target.install,
            installed: false,
            path: None,
            version: None,
            latest_version: None,
            update_available: None,
            error: Some("agent has no executable command".into()),
        };
    }

    let env = resolved_command_env().await;
    let path = binary_path(&command, &env).await;
    let Some(path) = path else {
        return HostAgentStatus {
            agent_id: target.agent_id,
            agent_name: target.agent_name,
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

    HostAgentStatus {
        agent_id: target.agent_id,
        agent_name: target.agent_name,
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
    status: Option<&HostAgentStatus>,
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

async fn install_host_agent(target: HostAgentTarget) -> HostAgentInstallResult {
    let install = target.install.as_deref().unwrap_or("").trim().to_string();
    if install.is_empty() {
        return HostAgentInstallResult {
            agent_id: target.agent_id,
            agent_name: target.agent_name,
            agent_kind: target.agent_kind,
            command: target.command,
            install: target.install,
            success: false,
            exit_code: None,
            output: String::new(),
            error: Some("agent has no install command".into()),
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

    let status = Some(check_host_agent(target.clone()).await);
    let (success, error) = update_outcome(
        version_before.as_deref(),
        status.as_ref(),
        capture.success,
        capture.error,
    );
    HostAgentInstallResult {
        agent_id: target.agent_id,
        agent_name: target.agent_name,
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
    resolve_program_in_env(Path::new(bin), env)
        .map(|resolved| resolved.path.to_string_lossy().into_owned())
}

fn env_get_ci<'a>(env: &'a BTreeMap<String, String>, name: &str) -> Option<&'a String> {
    env.iter()
        .find_map(|(key, value)| key.eq_ignore_ascii_case(name).then_some(value))
}

fn env_key_ci(env: &BTreeMap<String, String>, name: &str) -> Option<String> {
    env.keys()
        .find(|key| key.eq_ignore_ascii_case(name))
        .cloned()
}

fn env_remove_ci(env: &mut BTreeMap<String, String>, name: &str) {
    let keys = env
        .keys()
        .filter(|key| key.eq_ignore_ascii_case(name))
        .cloned()
        .collect::<Vec<_>>();
    for key in keys {
        env.remove(&key);
    }
}

fn env_insert_ci(env: &mut BTreeMap<String, String>, name: &str, value: String) {
    let key = env_key_ci(env, name).unwrap_or_else(|| name.to_string());
    env_remove_ci(env, name);
    env.insert(key, value);
}

fn resolve_program_in_env(
    path: &Path,
    env: &BTreeMap<String, String>,
) -> Option<crate::platform::ResolvedProgram> {
    fn classify(candidate: PathBuf) -> Option<crate::platform::ResolvedProgram> {
        let path = fs::canonicalize(candidate).ok()?;
        if !path.is_file() {
            return None;
        }
        #[cfg(windows)]
        let kind = match path.extension().and_then(|extension| extension.to_str()) {
            Some(extension)
                if extension.eq_ignore_ascii_case("cmd")
                    || extension.eq_ignore_ascii_case("bat") =>
            {
                crate::platform::ProgramKind::CmdShim
            }
            _ => crate::platform::ProgramKind::Native,
        };
        #[cfg(unix)]
        let kind = crate::platform::ProgramKind::Native;
        Some(crate::platform::ResolvedProgram { path, kind })
    }

    #[cfg(unix)]
    let candidates = |base: &Path| vec![base.to_path_buf()];
    #[cfg(windows)]
    let candidates = |base: &Path| {
        if base.extension().is_some() {
            return vec![base.to_path_buf()];
        }
        env_get_ci(env, "PATHEXT")
            .map(String::as_str)
            .unwrap_or(".COM;.EXE;.BAT;.CMD")
            .split(';')
            .filter_map(|extension| {
                let extension = extension.trim();
                if extension.is_empty() {
                    return None;
                }
                let mut name = base.as_os_str().to_os_string();
                if !extension.starts_with('.') {
                    name.push(".");
                }
                name.push(extension);
                Some(PathBuf::from(name))
            })
            .collect::<Vec<_>>()
    };

    if path.is_absolute() || path.components().count() > 1 {
        return candidates(path).into_iter().find_map(classify);
    }
    let search = env_get_ci(env, "PATH")?;
    std::env::split_paths(search).find_map(|directory| {
        candidates(&directory.join(path))
            .into_iter()
            .find_map(classify)
    })
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
    let process_env;
    let resolution_env = match env {
        Some(env) => env,
        None => {
            process_env = std::env::vars().collect::<BTreeMap<_, _>>();
            &process_env
        }
    };
    let Some(resolved) = resolve_program_in_env(Path::new(program), resolution_env) else {
        return CommandCapture {
            success: false,
            exit_code: None,
            output: String::new(),
            error: Some(format!("{program} was not found on PATH")),
        };
    };
    #[cfg(windows)]
    if resolved.kind == crate::platform::ProgramKind::CmdShim
        && cmd_shim_command_line(args).is_none()
    {
        return CommandCapture {
            success: false,
            exit_code: None,
            output: String::new(),
            error: Some("refusing non-fixed arguments through a cmd shim".into()),
        };
    }
    #[cfg(unix)]
    let mut command = {
        let mut command = Command::new(&resolved.path);
        command.args(args);
        command
    };
    #[cfg(windows)]
    let mut command = match resolved.kind {
        crate::platform::ProgramKind::Native => {
            let mut command = Command::new(&resolved.path);
            command.args(args);
            command
        }
        crate::platform::ProgramKind::CmdShim => {
            let comspec = env_get_ci(resolution_env, "COMSPEC")
                .filter(|value| !value.trim().is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("cmd.exe"));
            let mut command = Command::new(comspec);
            command.env("SPAWN_CMD_SHIM", &resolved.path);
            command.args(["/d", "/s", "/c"]);
            command.arg(cmd_shim_command_line(args).expect("fixed shim arguments were checked"));
            command
        }
    };
    command
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

#[cfg(windows)]
fn cmd_shim_command_line(args: &[&str]) -> Option<String> {
    args.iter()
        .all(|arg| matches!(*arg, "--version" | "version" | "-V" | "-v" | "update"))
        .then(|| format!("\"\"%SPAWN_CMD_SHIM%\" {}\"", args.join(" ")))
}

async fn run_shell_capture(
    command: &str,
    timeout: Duration,
    output_limit: usize,
    env: Option<&BTreeMap<String, String>>,
) -> CommandCapture {
    #[cfg(unix)]
    let mut shell = Command::new("bash");
    #[cfg(unix)]
    shell
        .arg("-c")
        .arg(format!("exec 2>&1; {command}"))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    let mut shell = {
        let process_env;
        let resolution_env = match env {
            Some(env) => env,
            None => {
                process_env = std::env::vars().collect::<BTreeMap<_, _>>();
                &process_env
            }
        };
        let resolved = ["pwsh.exe", "powershell.exe"]
            .into_iter()
            .find_map(|name| resolve_program_in_env(Path::new(name), resolution_env));
        let Some(resolved) = resolved else {
            return CommandCapture {
                success: false,
                exit_code: None,
                output: String::new(),
                error: Some("PowerShell is unavailable".into()),
            };
        };
        let mut shell = Command::new(resolved.path);
        shell
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"])
            .arg(command)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        shell
    };
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

async fn ensure_session_cwd(cwd: &str) -> Option<PathBuf> {
    let path = expand_host_path(cwd);
    match tokio::fs::create_dir_all(&path).await {
        Ok(()) => Some(path),
        Err(error) => {
            tracing::warn!(error = %error, "session cwd creation failed");
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
        fallback_host_root(home)
    } else if trimmed == "~" {
        home.unwrap_or_else(|| PathBuf::from(trimmed))
    } else if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        home.map(|h| h.join(rest))
            .unwrap_or_else(|| PathBuf::from(trimmed))
    } else {
        let path = Path::new(trimmed);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            fallback_host_root(home).join(path)
        }
    };
    lexical_normalize(path)
}

fn fallback_host_root(home: Option<PathBuf>) -> PathBuf {
    #[cfg(unix)]
    {
        home.unwrap_or_else(|| PathBuf::from("/"))
    }
    #[cfg(windows)]
    {
        home.or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from("."))
    }
}

fn lexical_normalize(path: PathBuf) -> PathBuf {
    let mut normalized = PathBuf::new();
    let rooted = path.is_absolute();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(Path::new(std::path::MAIN_SEPARATOR_STR)),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() && !rooted {
                    normalized.push("..");
                }
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    if normalized.as_os_str().is_empty() {
        if rooted {
            PathBuf::from(std::path::MAIN_SEPARATOR_STR)
        } else {
            PathBuf::from(".")
        }
    } else {
        normalized
    }
}

async fn handle_session_create(
    create: SessionCreate,
    registry: &SessionRegistry,
    rtc_sessions: &RtcSessions,
    out_tx: &mpsc::Sender<WsOutbound>,
) {
    let session_id = create.session_id;
    tracing::info!(%session_id, "session.create");

    let _ = crate::update::refresh_worker_pair_status().await;
    if crate::update::worker_mismatch() {
        send_error_code(
            out_tx,
            Some(session_id),
            "worker_mismatch",
            "spawn-worker does not match spawnd; run spawnd update to repair the installed pair",
        )
        .await;
        send_spawn_failed_exit(session_id, out_tx, "worker mismatch").await;
        return;
    }

    // Build the env for the session's login shell: the daemon's process env
    // (so HOME, XDG_CONFIG_HOME, PATH, etc. flow through naturally and agent
    // CLIs launched from the shell find their own credentials), normalized
    // and PATH-enriched. spawn does not inject credentials.
    let mut env: BTreeMap<String, String> = std::env::vars().collect();
    normalize_session_env(&mut env).await;
    if let Err(error) = materialize_session_capabilities(&create, &mut env) {
        tracing::warn!(%session_id, %error, "session capability setup failed");
        send_spawn_failed_exit(session_id, out_tx, "capability setup failed").await;
        return;
    }

    // A session is always the user's login shell; agents are commands typed
    // into it. The frame carries no argv, env, or install command.
    let shell = resolve_login_shell(&env);
    let argv = login_shell_argv(shell);

    let launch_cwd = if create.create_cwd {
        match ensure_session_cwd(&create.cwd).await {
            Some(path) => path,
            None => {
                send_spawn_failed_exit(session_id, out_tx, "cwd create failed").await;
                return;
            }
        }
    } else {
        expand_host_path(&create.cwd)
    };
    let launch_cwd_str = launch_cwd.to_string_lossy().into_owned();

    // Launch through the mandatory per-session worker. There is no backend
    // selector or per-session escape hatch: failing to start the worker is a
    // fail-closed session.create error.
    let spec = pty::LaunchSpec {
        session_id,
        cwd: &launch_cwd_str,
        cols: DEFAULT_SESSION_COLS,
        rows: DEFAULT_SESSION_ROWS,
        argv: &argv,
        env: &env,
    };
    let launched = match worker_backend::launch(spec).await {
        Ok(l) => l,
        Err(e) => {
            tracing::warn!(%session_id, error = %e, "session failed to start");
            send_error_code(
                out_tx,
                Some(session_id),
                "spawn_failed",
                "session failed to start",
            )
            .await;
            // Update UI status: starting → exited.
            let exit = Outbound::SessionExit {
                session_id,
                exit_code: None,
                signal: Some("spawn_failed".into()),
            };
            if let Ok(s) = serde_json::to_string(&exit) {
                let _ = out_tx.send(WsOutbound::json(s)).await;
            }
            return;
        }
    };

    register_attached(session_id, launched, registry, rtc_sessions, out_tx, true).await;
}

/// The user's login shell: `$SHELL` from the daemon's environment when it
/// names an executable file, else the platform default.
fn resolve_login_shell(env: &BTreeMap<String, String>) -> String {
    #[cfg(unix)]
    if let Some(shell) = env_get_ci(env, "SHELL").map(|value| value.trim()) {
        if is_executable_file(Path::new(shell)) {
            return shell.to_string();
        }
    }
    #[cfg(unix)]
    return default_login_shell().to_string();

    #[cfg(windows)]
    {
        for shell in ["pwsh.exe", "powershell.exe"] {
            if let Some(resolved) = resolve_program_in_env(Path::new(shell), env) {
                return resolved.path.to_string_lossy().into_owned();
            }
        }
        if let Some(comspec) = env_get_ci(env, "COMSPEC").filter(|value| !value.trim().is_empty()) {
            if is_executable_file(Path::new(comspec)) {
                return comspec.to_string();
            }
        }
        resolve_program_in_env(Path::new("cmd.exe"), env)
            .map(|resolved| resolved.path.to_string_lossy().into_owned())
            .unwrap_or_else(|| "cmd.exe".to_string())
    }
}

#[cfg(unix)]
fn default_login_shell() -> &'static str {
    if cfg!(target_os = "macos") {
        "/bin/zsh"
    } else {
        "/bin/bash"
    }
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.is_absolute()
        && std::fs::metadata(path)
            .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
}

#[cfg(windows)]
fn is_executable_file(path: &Path) -> bool {
    path.is_absolute() && path.is_file()
}

fn login_shell_argv(shell: String) -> Vec<String> {
    #[cfg(unix)]
    {
        vec![shell, "-l".to_string()]
    }
    #[cfg(windows)]
    {
        let is_powershell = Path::new(&shell)
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                name.eq_ignore_ascii_case("pwsh.exe") || name.eq_ignore_ascii_case("powershell.exe")
            });
        vec![
            shell,
            if is_powershell { "-NoLogo" } else { "/d" }.to_string(),
        ]
    }
}

async fn resolved_command_env() -> BTreeMap<String, String> {
    let mut env: BTreeMap<String, String> = std::env::vars().collect();
    normalize_session_env(&mut env).await;
    env
}

async fn normalize_session_env(env: &mut BTreeMap<String, String>) {
    env_remove_ci(env, "NO_COLOR");
    env_insert_ci(env, "TERM", "xterm-256color".into());
    env_insert_ci(env, "COLORTERM", "truecolor".into());
    if env_get_ci(env, "CLICOLOR").is_none() {
        env_insert_ci(env, "CLICOLOR", "1".into());
    }
    enrich_path_from_user_shell(env).await;
}

async fn enrich_path_from_user_shell(env: &mut BTreeMap<String, String>) {
    let mut preferred = shell_path_entries(env).await;
    preferred.extend(common_user_bin_entries(env));
    prepend_path_entries(env, preferred);
}

async fn shell_path_entries(env: &BTreeMap<String, String>) -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let _ = env;
        return Vec::new();
    }
    #[cfg(unix)]
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

    if let Some(shell) = env_get_ci(env, "SHELL").filter(|value| !value.trim().is_empty()) {
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
    #[cfg(unix)]
    let Some(home) = env_get_ci(env, "HOME").filter(|value| !value.is_empty()) else {
        return Vec::new();
    };
    #[cfg(unix)]
    let home = PathBuf::from(home);
    #[cfg(unix)]
    {
        [
            home.join(".local/bin"),
            home.join("bin"),
            home.join(".bun/bin"),
            home.join(".cargo/bin"),
        ]
        .into_iter()
        .collect()
    }

    #[cfg(windows)]
    {
        let mut paths = Vec::new();
        if let Some(local) = env_get_ci(env, "LOCALAPPDATA").filter(|value| !value.is_empty()) {
            let local = PathBuf::from(local);
            paths.push(local.join("spawn/bin"));
            paths.push(local.join("pnpm"));
            paths.push(local.join("Programs/Git/cmd"));
        }
        if let Some(roaming) = env_get_ci(env, "APPDATA").filter(|value| !value.is_empty()) {
            paths.push(PathBuf::from(roaming).join("npm"));
        }
        if let Some(pnpm) = env_get_ci(env, "PNPM_HOME").filter(|value| !value.is_empty()) {
            paths.push(PathBuf::from(pnpm));
        }
        if let Some(profile) = env_get_ci(env, "USERPROFILE").filter(|value| !value.is_empty()) {
            let profile = PathBuf::from(profile);
            paths.push(profile.join(".cargo/bin"));
            paths.push(profile.join(".bun/bin"));
            paths.push(profile.join(".local/bin"));
        }
        if let Some(program_files) =
            env_get_ci(env, "ProgramFiles").filter(|value| !value.is_empty())
        {
            paths.push(PathBuf::from(program_files).join("Git/cmd"));
        }
        paths
    }
}

fn prepend_path_entries(env: &mut BTreeMap<String, String>, preferred: Vec<PathBuf>) {
    let existing = env_get_ci(env, "PATH")
        .map(|path| std::env::split_paths(path).collect::<Vec<_>>())
        .unwrap_or_default();
    let mut merged = Vec::new();
    let mut seen = HashSet::new();

    for entry in preferred.into_iter().chain(existing) {
        if entry.as_os_str().is_empty() || !seen.insert(path_comparison_key(&entry)) {
            continue;
        }
        merged.push(entry);
    }

    if let Ok(joined) = std::env::join_paths(merged) {
        env_insert_ci(env, "PATH", joined.to_string_lossy().into_owned());
    }
}

fn path_comparison_key(path: &Path) -> OsString {
    #[cfg(unix)]
    {
        path.as_os_str().to_os_string()
    }
    #[cfg(windows)]
    {
        OsString::from(path.to_string_lossy().to_ascii_lowercase())
    }
}

fn materialize_session_capabilities(
    create: &SessionCreate,
    env: &mut BTreeMap<String, String>,
) -> Result<()> {
    if create.skills.is_empty() {
        return Ok(());
    }

    let root = config::config_dir()?
        .join("sessions")
        .join(create.session_id.to_string());
    if root.exists() {
        fs::remove_dir_all(&root).with_context(|| format!("clearing {}", root.display()))?;
    }
    crate::platform::create_private_dir_all(&root)
        .with_context(|| format!("creating {}", root.display()))?;

    let skills_file = root.join("skills.json");
    let skills_dir = root.join("skills");
    crate::platform::create_private_dir_all(&skills_dir)
        .with_context(|| format!("creating {}", skills_dir.display()))?;

    write_private_file(&skills_file, &serde_json::to_vec_pretty(&create.skills)?)
        .with_context(|| format!("writing {}", skills_file.display()))?;

    for skill in &create.skills {
        let dir = skills_dir.join(safe_file_component(&skill.name));
        crate::platform::create_private_dir_all(&dir)
            .with_context(|| format!("creating {}", dir.display()))?;
        let path = dir.join("SKILL.md");
        write_private_file(
            &path,
            skill_markdown(&skill.name, &skill.description, &skill.content).as_bytes(),
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

    // Shell-first sessions no longer know which agent will run, so the Codex
    // projection is materialized for every skilled session: if the user types
    // (or clicks) `codex`, it inherits this CODEX_HOME and sees the skills.
    let codex_home = root.join("codex-home");
    crate::platform::create_private_dir_all(&codex_home)
        .with_context(|| format!("creating {}", codex_home.display()))?;
    write_codex_projection(&codex_home, &skills_dir, create)?;
    link_codex_auth_state(&codex_home)?;
    env.insert(
        "CODEX_HOME".into(),
        codex_home.to_string_lossy().into_owned(),
    );

    Ok(())
}

fn write_codex_projection(
    codex_home: &Path,
    skills_dir: &Path,
    create: &SessionCreate,
) -> Result<()> {
    let mut config = String::from("# Generated by spawnd for this Spawn session.\n");
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
    write_private_file(&path, config.as_bytes())
        .with_context(|| format!("writing {}", path.display()))?;
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
    let mut reader = fs::File::open(source)?;
    let mut writer = crate::platform::create_private_file_new(dest)?;
    std::io::copy(&mut reader, &mut writer)?;
    writer.sync_all()
}

fn write_private_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = crate::platform::create_private_file_new(path)?;
    file.write_all(bytes)?;
    file.sync_all()
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
    use crate::proto::{SessionCreate, SkillConfig};
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use futures_util::SinkExt;
    use std::sync::{Arc, Mutex as StdMutex};
    use tokio_tungstenite::tungstenite::http::{header::SEC_WEBSOCKET_PROTOCOL, HeaderValue};

    /// Chain scope comes from this host's own approval proofs first; the
    /// server's account only fills in while no pin carries one, and never
    /// displaces a proven value.
    #[test]
    fn the_proven_account_outranks_the_servers_word_for_chain_scope() {
        let local = account_id_bytes("9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f").expect("uuid");
        let server = "1f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";
        assert_eq!(
            resolve_daemon_account(Some(local), Some(server)),
            Some(local)
        );
        assert_eq!(resolve_daemon_account(Some(local), None), Some(local));
        assert_eq!(
            resolve_daemon_account(None, Some(server)),
            account_id_bytes(server).ok()
        );
        assert_eq!(resolve_daemon_account(None, Some("not-a-uuid")), None);
        assert_eq!(resolve_daemon_account(None, None), None);
    }

    const TEST_BROWSER_KEY_ONE: &str = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
    const TEST_BROWSER_KEY_TWO: &str = "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw";
    const PANIC_SUBPROCESS_ENV: &str = "SPAWN_TEST_CREDENTIAL_LOADER_PANIC_SUBPROCESS";
    const PANIC_CANARY_TOKEN: &str = "panic-canary-token-7f9c";
    const PANIC_CANARY_PATH: &str = "/panic/canary/private/credentials.json";

    #[tokio::test]
    async fn rtc_signal_queues_order_each_peer_without_blocking_other_peers() {
        let mut queues = HashMap::new();
        let events = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let release_first = Arc::new(tokio::sync::Notify::new());

        enqueue_rtc_job(&mut queues, "peer-a".into(), {
            let events = Arc::clone(&events);
            let release = Arc::clone(&release_first);
            Box::pin(async move {
                release.notified().await;
                events.lock().await.push("a1");
            })
        });
        enqueue_rtc_job(&mut queues, "peer-a".into(), {
            let events = Arc::clone(&events);
            Box::pin(async move { events.lock().await.push("a2") })
        });
        enqueue_rtc_job(&mut queues, "peer-b".into(), {
            let events = Arc::clone(&events);
            Box::pin(async move { events.lock().await.push("b1") })
        });

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if !events.lock().await.is_empty() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(&*events.lock().await, &["b1"]);

        release_first.notify_one();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if events.lock().await.len() == 3 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(&*events.lock().await, &["b1", "a1", "a2"]);
    }

    async fn receive_std_signal(
        receiver: &std_mpsc::Receiver<()>,
        bound: Duration,
        description: &str,
    ) {
        tokio::time::timeout(bound, async {
            loop {
                match receiver.try_recv() {
                    Ok(()) => break,
                    Err(std_mpsc::TryRecvError::Empty) => {
                        tokio::time::sleep(Duration::from_millis(1)).await;
                    }
                    Err(std_mpsc::TryRecvError::Disconnected) => {
                        panic!("{description} channel disconnected")
                    }
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {description}"));
    }

    fn receive_std_signal_blocking(receiver: &std_mpsc::Receiver<()>, description: &str) {
        receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap_or_else(|_| panic!("timed out waiting for {description}"));
    }

    async fn poll_and_cancel_credential_load(loader: &mut CredentialLoader) {
        let load = loader.load();
        tokio::pin!(load);
        tokio::select! {
            biased;
            result = &mut load => panic!("credential load unexpectedly completed: {}", result.is_ok()),
            _ = tokio::task::yield_now() => {}
        }
    }

    fn credential_record(
        generation: u64,
        record_id: u128,
        token: &str,
        host_id: Uuid,
        server_url: &str,
        seed_byte: u8,
        pins: &[(Uuid, &str)],
    ) -> StoredCreds {
        let pins = pins
            .iter()
            .map(|(device_id, public_key)| {
                serde_json::json!({
                    "browser_device_id": device_id.to_string(),
                    "browser_key_algorithm": creds::BROWSER_KEY_ALGORITHM,
                    "browser_public_key": public_key,
                    "browser_key_fingerprint": creds::browser_key_fingerprint(public_key)
                        .expect("test key fingerprint"),
                })
            })
            .collect::<Vec<_>>();
        serde_json::from_value(serde_json::json!({
            "credential_record_version": 1,
            "credential_generation": generation,
            "credential_record_id": Uuid::from_u128(record_id).to_string(),
            "access_token": token,
            "host_id": host_id,
            "server_url": server_url,
            "host_private_key_seed": URL_SAFE_NO_PAD.encode([seed_byte; 32]),
            "browser_pins": pins,
        }))
        .expect("complete test credential record")
    }

    fn live_snapshot(record: StoredCreds) -> LiveCredentialSnapshot {
        LiveCredentialSnapshot::initial(
            record,
            &url::Url::parse("https://spawn.example/control").unwrap(),
        )
        .expect("live credential snapshot")
    }

    #[tokio::test]
    async fn daemon_update_runs_off_dispatch_and_busy_result_keeps_frames_serving() {
        let host_id = Uuid::from_u128(42);
        let record = credential_record(
            1,
            1,
            "test-token",
            host_id,
            "https://spawn.example/control",
            7,
            &[],
        );
        let live = live_snapshot(record);
        let registry = SessionRegistry::new();
        let rtc_sessions = RtcSessions::new();
        let mut revoked = RevocationSet::new();
        let (in_tx, mut in_rx) = mpsc::channel(4);
        let (out_tx, mut out_rx) = mpsc::channel(4);
        let _active_update = crate::update::acquire_update().expect("hold update guard");

        let dispatch = dispatch_loop(
            &mut in_rx,
            &registry,
            &rtc_sessions,
            &out_tx,
            &live,
            &mut revoked,
            Arc::new(StdMutex::new(None)),
        );
        let exercise = async move {
            in_tx
                .send(WsInbound::Json(Box::new(Inbound::DaemonUpdate {
                    request_id: "update-request".into(),
                    version: "0.1.0+g123456789abc".into(),
                    tree: "a".repeat(40),
                    target: "darwin-aarch64".into(),
                    spawnd: crate::proto::DaemonUpdateArtifact {
                        path: "/api/install/spawnd/darwin-aarch64".into(),
                        sha256: "b".repeat(64),
                    },
                    spawn_worker: crate::proto::DaemonUpdateArtifact {
                        path: "/api/install/spawn-worker/darwin-aarch64".into(),
                        sha256: "c".repeat(64),
                    },
                    allow_downgrade: false,
                })))
                .await
                .unwrap();
            let result: serde_json::Value =
                serde_json::from_str(out_rx.recv().await.expect("busy update result").as_str())
                    .unwrap();
            assert_eq!(result["type"], "daemon.update_result");
            assert_eq!(result["ok"], false);
            assert_eq!(result["stage"], "precondition");
            assert_eq!(result["error"], "busy");

            in_tx
                .send(WsInbound::Json(Box::new(Inbound::HostPing {
                    request_id: "ping-after-update".into(),
                })))
                .await
                .unwrap();
            let pong: serde_json::Value =
                serde_json::from_str(out_rx.recv().await.expect("pong after update").as_str())
                    .unwrap();
            assert_eq!(pong["type"], "host.pong");
            assert_eq!(pong["request_id"], "ping-after-update");
            drop(in_tx);
        };

        let (_, dispatch_result) = tokio::time::timeout(Duration::from_secs(2), async {
            tokio::join!(exercise, dispatch)
        })
        .await
        .expect("dispatch update test timeout");
        dispatch_result.unwrap();
    }

    #[test]
    fn signed_rtc_offer_verifies_and_answer_round_trips() {
        use ed25519_dalek::SigningKey;
        use spawnd::signed_signal::{
            public_key_from_wire, public_key_to_wire, ScopeType, SenderRole, SignalKind,
            SignedSignalTranscript,
        };
        use spawnd::signed_signal_wire::{
            sign_rtc_signal_wire, verify_rtc_signal_wire, RtcProtocol,
        };

        // Deterministic browser + host identities.
        let browser_key = SigningKey::from_bytes(&[7u8; 32]);
        let browser_pub_wire = public_key_to_wire(&browser_key.verifying_key());
        let host_seed = [9u8; 32];
        let host_key = SigningKey::from_bytes(&host_seed);
        let host_pub_wire = public_key_to_wire(&host_key.verifying_key());
        let host_peer = public_key_from_wire(&host_pub_wire).unwrap();

        // A record holding this host identity and an approved pin for the browser.
        let mut record = StoredCreds::default();
        record.host_private_key_seed = Some(URL_SAFE_NO_PAD.encode(host_seed));
        let fingerprint = creds::browser_key_fingerprint(&browser_pub_wire).unwrap();
        let pin = creds::browser_pin_from_approval(
            &Uuid::from_u128(1).to_string(),
            "ed25519",
            &browser_pub_wire,
            &fingerprint,
        )
        .unwrap();
        creds::merge_browser_pin(&mut record, pin).unwrap();

        let session_id = Uuid::from_u128(2).to_string();
        let scope_id = Uuid::from_u128(3).to_string();

        // The browser signs a session offer intended for this host.
        let offer = SignedSignalTranscript::new(
            SignalKind::Offer,
            2,
            session_id.clone(),
            ScopeType::Session,
            scope_id.clone(),
            SenderRole::Browser,
            host_peer.to_bytes(),
            "v=0\r\no=browser\r\n",
        )
        .unwrap();
        let offer_wire = sign_rtc_signal_wire(&browser_key, RtcProtocol::Session, &offer).unwrap();

        // The daemon verifies the offer against its host identity + pins.
        let verified = verify_signed_rtc_offer(&offer_wire, &record).expect("offer verifies");
        assert_eq!(verified.transcript().session_id(), session_id);
        assert_eq!(verified.transcript().sdp(), "v=0\r\no=browser\r\n");
        assert_eq!(verified.sender_public_key(), &browser_key.verifying_key());

        // The daemon signs an answer that the browser can verify against its pins.
        let signer = build_rtc_answer_signer(&record, &verified)
            .unwrap()
            .expect("answer signer");
        let answer_wire = (&signer)("v=0\r\no=daemon\r\n").expect("sign answer");
        let browser_peer = public_key_from_wire(&browser_pub_wire).unwrap();
        let answer = verify_rtc_signal_wire(&answer_wire, &host_peer, &browser_peer)
            .expect("browser verifies the daemon answer");
        assert_eq!(answer.transcript().sdp(), "v=0\r\no=daemon\r\n");
        assert_eq!(answer.transcript().session_id(), session_id);
        assert_eq!(answer.transcript().scope_id(), scope_id);

        // An offer from an unknown (unpinned) browser must never verify.
        let stranger = SigningKey::from_bytes(&[11u8; 32]);
        let stranger_offer = SignedSignalTranscript::new(
            SignalKind::Offer,
            2,
            session_id,
            ScopeType::Session,
            scope_id,
            SenderRole::Browser,
            host_peer.to_bytes(),
            "v=0\r\no=stranger\r\n",
        )
        .unwrap();
        let stranger_wire =
            sign_rtc_signal_wire(&stranger, RtcProtocol::Session, &stranger_offer).unwrap();
        assert!(verify_signed_rtc_offer(&stranger_wire, &record).is_none());
    }

    #[test]
    fn whole_record_reload_activates_add_revoke_and_atomic_rotation() {
        let host_id = Uuid::from_u128(10);
        let browser_one = Uuid::from_u128(101);
        let browser_two = Uuid::from_u128(102);
        let active = live_snapshot(credential_record(
            1,
            1,
            "old-token",
            host_id,
            "https://spawn.example/login",
            7,
            &[(browser_one, TEST_BROWSER_KEY_ONE)],
        ));

        let added_record = credential_record(
            2,
            2,
            "new-token",
            host_id,
            "https://spawn.example/another-path",
            9,
            &[
                (browser_one, TEST_BROWSER_KEY_ONE),
                (browser_two, TEST_BROWSER_KEY_TWO),
            ],
        );
        let expected_identity = creds::host_identity(&added_record)
            .unwrap()
            .unwrap()
            .public_key;
        let added = active
            .classify_reload(added_record)
            .unwrap()
            .expect("new generation");
        assert_eq!(added.record.access_token.as_deref(), Some("new-token"));
        assert_eq!(added.record.browser_pins().len(), 2);
        assert_eq!(
            creds::host_identity(&added.record)
                .unwrap()
                .unwrap()
                .public_key,
            expected_identity
        );
        assert_eq!(added.generation, 2);

        let revoked = added
            .classify_reload(credential_record(
                3,
                3,
                "rotated-token",
                host_id,
                "https://spawn.example/",
                11,
                &[(browser_two, TEST_BROWSER_KEY_TWO)],
            ))
            .unwrap()
            .expect("revocation generation");
        assert_eq!(revoked.record.browser_pins().len(), 1);
        assert_eq!(revoked.record.browser_pins()[0].device_id(), browser_two);
        assert_eq!(
            revoked.record.access_token.as_deref(),
            Some("rotated-token")
        );
        assert_eq!(revoked.generation, 3);
    }

    #[test]
    fn reload_rejects_substitution_rollback_domain_and_corruption() {
        let host_id = Uuid::from_u128(10);
        let active_record = credential_record(
            5,
            50,
            "secret-token",
            host_id,
            "https://spawn.example/",
            7,
            &[(Uuid::from_u128(101), TEST_BROWSER_KEY_ONE)],
        );
        let active = live_snapshot(active_record.clone());
        assert!(active
            .classify_reload(active_record.clone())
            .unwrap()
            .is_none());

        let mut same_revision: serde_json::Value =
            serde_json::to_value(&active_record).expect("serialize record");
        same_revision["access_token"] = serde_json::json!("substituted-token");
        let same_revision: StoredCreds =
            serde_json::from_value(same_revision).expect("mutated record");
        let error = active
            .classify_reload(same_revision)
            .err()
            .expect("same-revision substitution must fail");
        assert!(error
            .to_string()
            .contains("without a new whole-record revision"));
        assert!(!error.to_string().contains("secret-token"));
        assert!(!error.to_string().contains("substituted-token"));

        let rollback = credential_record(
            4,
            40,
            "rollback-token",
            host_id,
            "https://spawn.example/",
            7,
            &[],
        );
        assert!(active
            .classify_reload(rollback)
            .err()
            .expect("rollback must fail")
            .to_string()
            .contains("rolled back"));

        let reused_record_id =
            credential_record(6, 50, "token", host_id, "https://spawn.example/", 8, &[]);
        assert!(active
            .classify_reload(reused_record_id)
            .err()
            .expect("record identity reuse must fail")
            .to_string()
            .contains("fresh record identity"));

        let wrong_host = credential_record(
            6,
            60,
            "token",
            Uuid::from_u128(11),
            "https://spawn.example/",
            8,
            &[],
        );
        assert!(active
            .classify_reload(wrong_host)
            .err()
            .expect("host change must fail")
            .to_string()
            .contains("Host ID"));

        let wrong_origin =
            credential_record(6, 60, "token", host_id, "https://hostile.example/", 8, &[]);
        assert!(active
            .classify_reload(wrong_origin)
            .err()
            .expect("origin change must fail")
            .to_string()
            .contains("server origin"));

        let mut corrupt: serde_json::Value = serde_json::to_value(credential_record(
            6,
            60,
            "token",
            host_id,
            "https://spawn.example/",
            8,
            &[(Uuid::from_u128(102), TEST_BROWSER_KEY_TWO)],
        ))
        .unwrap();
        corrupt["browser_pins"][0]["browser_key_fingerprint"] =
            serde_json::json!("SHA256:AAAAAAAAAAAAAAAA");
        let corrupt: StoredCreds = serde_json::from_value(corrupt).unwrap();
        assert!(format!(
            "{:#}",
            active
                .classify_reload(corrupt)
                .err()
                .expect("corrupt pin must fail")
        )
        .contains("fingerprint"));

        let missing = StoredCreds::default();
        assert!(format!(
            "{:#}",
            active
                .classify_reload(missing)
                .err()
                .expect("missing backend record must fail")
        )
        .contains("no daemon token"));
    }

    #[tokio::test]
    async fn bounded_poll_activates_change_and_backend_failure_fails_closed() {
        let host_id = Uuid::from_u128(10);
        let old_record = credential_record(
            1,
            1,
            "never-log-this-token",
            host_id,
            "https://spawn.example/",
            7,
            &[],
        );
        let active = live_snapshot(old_record.clone());
        let next = credential_record(
            2,
            2,
            "new-token",
            host_id,
            "https://spawn.example/",
            8,
            &[(Uuid::from_u128(101), TEST_BROWSER_KEY_ONE)],
        );
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let load_calls = Arc::clone(&calls);
        let mut loader = CredentialLoader::start(Duration::from_millis(200), move || {
            if load_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                Ok(old_record.clone())
            } else {
                Ok(next.clone())
            }
        })
        .expect("credential loader");
        let changed =
            wait_for_credential_change_with(&active, Duration::from_millis(10), &mut loader)
                .await
                .expect("bounded reload");
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert_eq!(changed.generation, 2);
        assert_eq!(changed.record.browser_pins().len(), 1);

        let mut failed_loader = CredentialLoader::start(Duration::from_millis(200), || {
            Err(anyhow!(
                "credential backend unavailable with never-log-this-token"
            ))
        })
        .expect("failed credential loader");
        let error =
            wait_for_credential_change_with(&active, Duration::from_millis(10), &mut failed_loader)
                .await
                .err()
                .expect("backend failure must fail closed");
        let message = format!("{error:#}");
        assert!(message.contains("credential loader failed"));
        assert!(!message.contains("never-log-this-token"));
        assert_eq!(
            active.generation, 1,
            "failed reload cannot mutate active trust"
        );
    }

    #[tokio::test]
    async fn stalled_loader_has_one_hard_deadline_no_amplification_and_redacted_error() {
        let record = credential_record(
            1,
            1,
            "deadline-secret-token",
            Uuid::from_u128(10),
            "https://spawn.example/",
            7,
            &[],
        );
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let load_calls = Arc::clone(&calls);
        let (started_tx, started_rx) = std_mpsc::channel();
        let (release_tx, release_rx) = std_mpsc::channel();
        let (exit_tx, exit_rx) = std_mpsc::channel();
        let mut loader = CredentialLoader::start_observed(
            Duration::from_millis(80),
            move || {
                load_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let _ = started_tx.send(());
                release_rx.recv().expect("release stalled loader");
                Ok(record.clone())
            },
            exit_tx,
        )
        .expect("credential loader");

        let began = tokio::time::Instant::now();
        let error = loader
            .load()
            .await
            .err()
            .expect("stalled credential load must fail closed");
        assert!(began.elapsed() >= Duration::from_millis(70));
        assert!(began.elapsed() < Duration::from_millis(500));
        receive_std_signal(&started_rx, Duration::from_secs(1), "loader start").await;
        let message = format!("{error:#}");
        assert!(message.contains("hard deadline"));
        assert!(!message.contains("deadline-secret-token"));

        let second = loader
            .load()
            .await
            .err()
            .expect("timed-out loader must remain permanently failed");
        assert!(second.to_string().contains("permanently unavailable"));
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);

        release_tx.send(()).expect("release loader worker");
        receive_std_signal(&exit_rx, Duration::from_secs(1), "loader exit").await;
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn cancelled_pending_late_reply_cannot_bypass_its_absolute_deadline() {
        let record = credential_record(
            1,
            1,
            "cancelled-late-secret-token",
            Uuid::from_u128(10),
            "https://spawn.example/",
            7,
            &[],
        );
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let load_calls = Arc::clone(&calls);
        let (started_tx, started_rx) = std_mpsc::channel();
        let (release_tx, release_rx) = std_mpsc::channel();
        let (reply_tx, reply_rx) = std_mpsc::channel();
        let (exit_tx, exit_rx) = std_mpsc::channel();
        let mut loader = CredentialLoader::start_observed_replies(
            Duration::from_millis(100),
            move || {
                load_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                started_tx.send(()).expect("announce loader start");
                release_rx.recv().expect("release late loader");
                Ok(record.clone())
            },
            exit_tx,
            reply_tx,
        )
        .expect("credential loader");

        poll_and_cancel_credential_load(&mut loader).await;
        receive_std_signal_blocking(&started_rx, "cancelled loader start");
        let deadline = loader
            .pending
            .as_ref()
            .expect("retained pending load")
            .deadline;
        tokio::time::advance(Duration::from_millis(101)).await;
        assert!(tokio::time::Instant::now() > deadline);
        release_tx.send(()).expect("release late loader");
        receive_std_signal_blocking(&reply_rx, "late queued credential reply");

        let error = loader
            .load()
            .await
            .err()
            .expect("late queued reply must lose to retained deadline");
        assert!(error.to_string().contains("hard deadline"));
        assert!(!error.to_string().contains("cancelled-late-secret-token"));
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(loader.load().await.is_err());
        // Worker exit occurs only after fail_permanently dropped the queued
        // StoredCreds (zeroizing its sensitive fields) and closed requests.
        receive_std_signal_blocking(&exit_rx, "late loader exit after queued record drop");
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn credential_reply_and_deadline_same_instant_expiry_wins() {
        let record = credential_record(
            1,
            1,
            "same-instant-secret-token",
            Uuid::from_u128(10),
            "https://spawn.example/",
            7,
            &[],
        );
        let (started_tx, started_rx) = std_mpsc::channel();
        let (release_tx, release_rx) = std_mpsc::channel();
        let (reply_tx, reply_rx) = std_mpsc::channel();
        let (exit_tx, exit_rx) = std_mpsc::channel();
        let mut loader = CredentialLoader::start_observed_replies(
            Duration::from_millis(100),
            move || {
                started_tx.send(()).expect("announce loader start");
                release_rx.recv().expect("release same-instant loader");
                Ok(record.clone())
            },
            exit_tx,
            reply_tx,
        )
        .expect("credential loader");

        {
            let load = loader.load();
            tokio::pin!(load);
            tokio::select! {
                biased;
                result = &mut load => panic!("credential load unexpectedly completed: {}", result.is_ok()),
                _ = tokio::task::yield_now() => {}
            }
            receive_std_signal_blocking(&started_rx, "same-instant loader start");
            release_tx.send(()).expect("release same-instant loader");
            receive_std_signal_blocking(&reply_rx, "same-instant queued reply");
            tokio::time::advance(Duration::from_millis(100)).await;
            let error = load
                .await
                .err()
                .expect("biased expiry must beat reply at exact deadline");
            assert!(error.to_string().contains("hard deadline"));
            assert!(!error.to_string().contains("same-instant-secret-token"));
        }
        receive_std_signal_blocking(&exit_rx, "same-instant loader exit");
    }

    #[tokio::test(start_paused = true)]
    async fn cancelled_pending_timely_reply_is_accepted_before_original_deadline() {
        let record = credential_record(
            1,
            1,
            "timely-reattach-token",
            Uuid::from_u128(10),
            "https://spawn.example/",
            7,
            &[],
        );
        let (started_tx, started_rx) = std_mpsc::channel();
        let (release_tx, release_rx) = std_mpsc::channel();
        let (reply_tx, reply_rx) = std_mpsc::channel();
        let (exit_tx, exit_rx) = std_mpsc::channel();
        let mut loader = CredentialLoader::start_observed_replies(
            Duration::from_millis(100),
            move || {
                started_tx.send(()).expect("announce loader start");
                release_rx.recv().expect("release timely loader");
                Ok(record.clone())
            },
            exit_tx,
            reply_tx,
        )
        .expect("credential loader");

        poll_and_cancel_credential_load(&mut loader).await;
        receive_std_signal_blocking(&started_rx, "timely loader start");
        let original_deadline = loader.pending.as_ref().expect("pending load").deadline;
        tokio::time::advance(Duration::from_millis(50)).await;
        release_tx.send(()).expect("release timely loader");
        receive_std_signal_blocking(&reply_rx, "timely queued reply");
        let loaded = loader
            .load()
            .await
            .expect("pre-deadline reattachment must accept reply");
        assert_eq!(
            loaded.access_token.as_deref(),
            Some("timely-reattach-token")
        );
        assert!(tokio::time::Instant::now() < original_deadline);
        drop(loader);
        receive_std_signal_blocking(&exit_rx, "timely loader exit");
    }

    #[tokio::test(start_paused = true)]
    async fn repeated_cancellation_never_resets_or_extends_pending_deadline() {
        let record = credential_record(
            1,
            1,
            "repeat-cancel-secret-token",
            Uuid::from_u128(10),
            "https://spawn.example/",
            7,
            &[],
        );
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let load_calls = Arc::clone(&calls);
        let (started_tx, started_rx) = std_mpsc::channel();
        let (release_tx, release_rx) = std_mpsc::channel();
        let (reply_tx, reply_rx) = std_mpsc::channel();
        let (exit_tx, exit_rx) = std_mpsc::channel();
        let mut loader = CredentialLoader::start_observed_replies(
            Duration::from_millis(100),
            move || {
                load_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                started_tx.send(()).expect("announce loader start");
                release_rx.recv().expect("release repeated-cancel loader");
                Ok(record.clone())
            },
            exit_tx,
            reply_tx,
        )
        .expect("credential loader");

        poll_and_cancel_credential_load(&mut loader).await;
        receive_std_signal_blocking(&started_rx, "repeated-cancel loader start");
        let original_deadline = loader.pending.as_ref().expect("pending load").deadline;
        tokio::time::advance(Duration::from_millis(40)).await;
        poll_and_cancel_credential_load(&mut loader).await;
        assert_eq!(
            loader.pending.as_ref().expect("pending load").deadline,
            original_deadline
        );
        tokio::time::advance(Duration::from_millis(40)).await;
        poll_and_cancel_credential_load(&mut loader).await;
        assert_eq!(
            loader.pending.as_ref().expect("pending load").deadline,
            original_deadline
        );
        tokio::time::advance(Duration::from_millis(21)).await;
        release_tx.send(()).expect("release repeated-cancel loader");
        receive_std_signal_blocking(&reply_rx, "repeated-cancel late reply");
        let error = loader
            .load()
            .await
            .err()
            .expect("original deadline must survive repeated cancellation");
        assert!(error.to_string().contains("hard deadline"));
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        receive_std_signal_blocking(&exit_rx, "repeated-cancel loader exit");
    }

    #[tokio::test]
    async fn loader_panic_and_disconnected_channel_fail_permanently_without_details() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let load_calls = Arc::clone(&calls);
        let (exit_tx, exit_rx) = std_mpsc::channel();
        let mut panicked = CredentialLoader::start_observed(
            Duration::from_millis(200),
            move || -> Result<StoredCreds> {
                load_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                panic!("credential loader test panic");
            },
            exit_tx,
        )
        .expect("credential loader");
        let panic_error = panicked
            .load()
            .await
            .err()
            .expect("worker panic must fail closed");
        assert!(panic_error.to_string().contains("credential loader failed"));
        assert!(!panic_error.to_string().contains("test panic"));
        receive_std_signal(&exit_rx, Duration::from_secs(1), "panicked loader exit").await;
        assert!(panicked.load().await.is_err());
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);

        let (requests, receiver) = std_mpsc::sync_channel(1);
        drop(receiver);
        let mut disconnected = CredentialLoader {
            requests: Some(requests),
            pending: None,
            load_deadline: Duration::from_millis(200),
            failed: false,
        };
        let channel_error = disconnected
            .load()
            .await
            .err()
            .expect("disconnected request channel must fail closed");
        assert!(channel_error.to_string().contains("request channel failed"));
        assert!(disconnected.load().await.is_err());
    }

    #[test]
    fn credential_loader_panic_subprocess_redacts_stderr_and_delegates_unrelated_hook() {
        let output = std::process::Command::new(std::env::current_exe().expect("current test exe"))
            .arg("--exact")
            .arg("run::tests::credential_loader_panic_subprocess_helper")
            .arg("--nocapture")
            .arg("--test-threads=1")
            .env(PANIC_SUBPROCESS_ENV, "1")
            .output()
            .expect("run credential loader panic subprocess");
        assert!(
            !output.status.success(),
            "helper must surface one generic daemon failure"
        );
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let combined = format!("{stdout}\n{stderr}");
        assert!(!combined.contains(PANIC_CANARY_TOKEN));
        assert!(!combined.contains(PANIC_CANARY_PATH));
        assert!(!combined.contains("panicked at"));
        let fixed = std::str::from_utf8(CREDENTIAL_LOADER_PANIC_DIAGNOSTIC)
            .expect("static diagnostic utf8")
            .trim_end();
        assert_eq!(combined.matches(fixed).count(), 1);
        assert!(combined.contains("preexisting-hook:ordinary-thread-panic"));
        assert!(combined.contains("credential loader failed"));
    }

    #[tokio::test]
    #[allow(clippy::result_large_err)]
    async fn credential_loader_panic_subprocess_helper() -> Result<()> {
        if std::env::var_os(PANIC_SUBPROCESS_ENV).is_none() {
            return Ok(());
        }

        // The loader hook must compose with and preserve an already-installed
        // application hook for every unrelated thread.
        std::panic::set_hook(Box::new(|info| {
            let payload = info
                .payload()
                .downcast_ref::<&str>()
                .copied()
                .or_else(|| info.payload().downcast_ref::<String>().map(String::as_str))
                .unwrap_or("non-string-panic");
            let mut stderr = std::io::stderr().lock();
            let _ = std::io::Write::write_all(
                &mut stderr,
                format!("preexisting-hook:{payload}\n").as_bytes(),
            );
        }));

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local websocket");
        let address = listener.local_addr().unwrap();
        let server_url = url::Url::parse(&format!("http://{address}")).unwrap();
        let ws_url = config::ws_url(&server_url).unwrap();
        let registered_state = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let server_registered_state = Arc::clone(&registered_state);
        let (registered_tx, registered_rx) = oneshot::channel();
        let (closed_tx, closed_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.expect("accept daemon socket");
            let mut socket = tokio_tungstenite::accept_hdr_async(
                tcp,
                |_: &tokio_tungstenite::tungstenite::handshake::server::Request,
                 mut response: tokio_tungstenite::tungstenite::handshake::server::Response| {
                    response.headers_mut().insert(
                        SEC_WEBSOCKET_PROTOCOL,
                        HeaderValue::from_static("spawn.control.v3"),
                    );
                    Ok(response)
                },
            )
            .await
            .expect("daemon websocket handshake");
            socket
                .next()
                .await
                .expect("daemon register frame")
                .expect("valid daemon register frame");
            server_registered_state.store(true, std::sync::atomic::Ordering::SeqCst);
            let _ = registered_tx.send(());
            while socket.next().await.is_some() {}
            let _ = closed_tx.send(());
        });

        let host_id = Uuid::from_u128(10);
        let record = credential_record(
            1,
            1,
            "panic-active-token",
            host_id,
            server_url.as_str(),
            7,
            &[],
        );
        let active = LiveCredentialSnapshot::initial(record.clone(), &server_url).unwrap();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let load_calls = Arc::clone(&calls);
        let load_registered_state = Arc::clone(&registered_state);
        let mut loader = CredentialLoader::start(Duration::from_millis(200), move || {
            load_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if load_registered_state.load(std::sync::atomic::Ordering::SeqCst) {
                panic!("{PANIC_CANARY_TOKEN} {PANIC_CANARY_PATH}");
            }
            Ok(record.clone())
        })
        .expect("credential loader");
        let registry = SessionRegistry::new();
        assert!(registry.claim_discovery());
        let rtc_sessions = RtcSessions::new();
        assert!(rtc_sessions.bind_registered_host_id(host_id).await);
        let epoch_before = rtc_sessions.trust_epoch_for_test();
        let mut daemon_revoked = RevocationSet::new();

        {
            let connection = serve_one_connection_with_loader(
                &active,
                &ws_url,
                &registry,
                &rtc_sessions,
                Duration::from_millis(5),
                &mut loader,
                &mut daemon_revoked,
            );
            tokio::pin!(connection);
            tokio::time::timeout(Duration::from_secs(1), async {
                tokio::select! {
                    registered = registered_rx => {
                        registered.expect("daemon registration sender");
                    }
                    result = &mut connection => {
                        panic!("connection ended before registration: {}", result.is_ok());
                    }
                }
            })
            .await
            .expect("daemon registration timeout");
            let error = tokio::time::timeout(Duration::from_secs(1), &mut connection)
                .await
                .expect("credential panic did not fail active session")
                .err()
                .expect("credential panic must return fatal error");
            let message = format!("{error:#}");
            assert!(message.contains("credential loader failed"));
            assert!(!message.contains(PANIC_CANARY_TOKEN));
            assert!(!message.contains(PANIC_CANARY_PATH));
        }
        assert!(rtc_sessions.trust_epoch_for_test() > epoch_before);
        tokio::time::timeout(Duration::from_secs(1), closed_rx)
            .await
            .expect("panic did not close stale websocket")
            .expect("websocket close observation");
        let calls_at_failure = calls.load(std::sync::atomic::Ordering::SeqCst);
        assert!(loader.load().await.is_err());
        assert_eq!(
            calls.load(std::sync::atomic::Ordering::SeqCst),
            calls_at_failure
        );
        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .expect("local websocket server timeout")
            .expect("local websocket server task");

        let unrelated = std::thread::spawn(|| panic!("ordinary-thread-panic"));
        assert!(unrelated.join().is_err());
        Err(anyhow!("credential loader failed"))
    }

    #[tokio::test]
    async fn reconcile_credential_blocking_runs_under_marker_and_fails_closed_on_panic() {
        // The reconcile-path credential work must execute under the loader's
        // redaction marker, so a keyring/file backend panic hits the redacting
        // hook rather than the ordinary one.
        let marker_seen =
            run_isolated_credential_blocking(|| IS_CREDENTIAL_LOADER_THREAD.with(Cell::get))
                .await
                .expect("isolated credential work returns its value");
        assert!(
            marker_seen,
            "reconcile backend work must set the credential-loader redaction marker"
        );

        // A panic in that work is caught and surfaced as a fixed error rather
        // than unwinding across the async boundary; the secret-bearing payload
        // never reaches the returned message.
        let panicked = run_isolated_credential_blocking(|| -> () {
            panic!("{PANIC_CANARY_TOKEN} {PANIC_CANARY_PATH}");
        })
        .await;
        let error = panicked.expect_err("a reconcile backend panic must fail closed");
        let message = format!("{error:#}");
        assert!(!message.contains(PANIC_CANARY_TOKEN));
        assert!(!message.contains(PANIC_CANARY_PATH));
    }

    #[test]
    fn reconcile_credential_panic_subprocess_redacts_stderr() {
        let output = std::process::Command::new(std::env::current_exe().expect("current test exe"))
            .arg("--exact")
            .arg("run::tests::reconcile_credential_panic_subprocess_helper")
            .arg("--nocapture")
            .arg("--test-threads=1")
            .env(PANIC_SUBPROCESS_ENV, "1")
            .output()
            .expect("run reconcile credential panic subprocess");
        assert!(
            !output.status.success(),
            "helper must surface the redacted failure and exit nonzero"
        );
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let combined = format!("{stdout}\n{stderr}");
        // A backend panic on the reconcile path is redacted to the fixed
        // diagnostic; its secret-bearing payload/location never reaches stderr.
        assert!(!combined.contains(PANIC_CANARY_TOKEN));
        assert!(!combined.contains(PANIC_CANARY_PATH));
        assert!(!combined.contains("panicked at"));
        let fixed = std::str::from_utf8(CREDENTIAL_LOADER_PANIC_DIAGNOSTIC)
            .expect("static diagnostic utf8")
            .trim_end();
        assert_eq!(combined.matches(fixed).count(), 1);
        // An unrelated panic on an ordinary thread still reaches the preexisting
        // application hook, proving the marker keys redaction to this path only.
        assert!(combined.contains("preexisting-hook:ordinary-thread-panic"));
    }

    #[tokio::test]
    #[allow(clippy::result_large_err)]
    async fn reconcile_credential_panic_subprocess_helper() -> Result<()> {
        if std::env::var_os(PANIC_SUBPROCESS_ENV).is_none() {
            return Ok(());
        }

        // The loader hook must compose with and preserve an already-installed
        // application hook for every unrelated thread.
        std::panic::set_hook(Box::new(|info| {
            let payload = info
                .payload()
                .downcast_ref::<&str>()
                .copied()
                .or_else(|| info.payload().downcast_ref::<String>().map(String::as_str))
                .unwrap_or("non-string-panic");
            let mut stderr = std::io::stderr().lock();
            let _ = std::io::Write::write_all(
                &mut stderr,
                format!("preexisting-hook:{payload}\n").as_bytes(),
            );
        }));

        // Drive the exact reconcile isolation with a backend that panics
        // carrying a secret token and path, as a hostile keyring/file panic
        // could. The redacting hook must fire (marker set) and the payload must
        // never reach stderr or the returned error.
        let outcome: Result<()> = run_isolated_credential_blocking(|| {
            assert!(
                IS_CREDENTIAL_LOADER_THREAD.with(Cell::get),
                "reconcile backend work must run under the loader redaction marker"
            );
            panic!("{PANIC_CANARY_TOKEN} {PANIC_CANARY_PATH}");
        })
        .await;
        let error = outcome.expect_err("a reconcile backend panic must fail closed");
        let message = format!("{error:#}");
        assert!(!message.contains(PANIC_CANARY_TOKEN));
        assert!(!message.contains(PANIC_CANARY_PATH));

        let unrelated = std::thread::spawn(|| panic!("ordinary-thread-panic"));
        assert!(unrelated.join().is_err());
        Err(anyhow!("reconcile credential backend failed"))
    }

    #[tokio::test]
    async fn loader_accepts_near_deadline_success_and_ordinary_polls_stay_single_flight() {
        let record = credential_record(
            1,
            1,
            "near-deadline-token",
            Uuid::from_u128(10),
            "https://spawn.example/",
            7,
            &[],
        );
        let near_record = record.clone();
        let (release_tx, release_rx) = std_mpsc::channel();
        let mut near = CredentialLoader::start(Duration::from_millis(250), move || {
            release_rx.recv().expect("release near-deadline load");
            Ok(near_record.clone())
        })
        .expect("credential loader");
        let release = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            release_tx.send(()).expect("release loader");
        });
        let began = tokio::time::Instant::now();
        let loaded = near.load().await.expect("near-deadline load must succeed");
        assert_eq!(loaded.access_token.as_deref(), Some("near-deadline-token"));
        assert!(began.elapsed() >= Duration::from_millis(130));
        release.await.unwrap();

        let active = live_snapshot(record.clone());
        let next = credential_record(
            2,
            2,
            "single-flight-new-token",
            Uuid::from_u128(10),
            "https://spawn.example/",
            8,
            &[],
        );
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let concurrent = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let maximum = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let load_calls = Arc::clone(&calls);
        let load_concurrent = Arc::clone(&concurrent);
        let load_maximum = Arc::clone(&maximum);
        let mut ordinary = CredentialLoader::start(Duration::from_millis(200), move || {
            let in_flight = load_concurrent.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            load_maximum.fetch_max(in_flight, std::sync::atomic::Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(5));
            let index = load_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            load_concurrent.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
            if index < 2 {
                Ok(record.clone())
            } else {
                Ok(next.clone())
            }
        })
        .expect("credential loader");
        let changed =
            wait_for_credential_change_with(&active, Duration::from_millis(2), &mut ordinary)
                .await
                .expect("ordinary polling change");
        assert_eq!(changed.generation, 2);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 3);
        assert_eq!(maximum.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn shutdown_during_active_load_detaches_one_worker_and_ends_it_after_completion() {
        let record = credential_record(
            1,
            1,
            "shutdown-secret-token",
            Uuid::from_u128(10),
            "https://spawn.example/",
            7,
            &[],
        );
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let load_calls = Arc::clone(&calls);
        let (started_tx, started_rx) = std_mpsc::channel();
        let (release_tx, release_rx) = std_mpsc::channel();
        let (exit_tx, exit_rx) = std_mpsc::channel();
        let loader = CredentialLoader::start_observed(
            Duration::from_secs(10),
            move || {
                load_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                started_tx.send(()).expect("announce loader start");
                release_rx.recv().expect("release loader");
                Ok(record.clone())
            },
            exit_tx,
        )
        .expect("credential loader");
        let task = tokio::spawn(async move {
            let mut loader = loader;
            loader.load().await
        });
        receive_std_signal(&started_rx, Duration::from_secs(1), "loader start").await;
        task.abort();
        assert!(task
            .await
            .err()
            .expect("load task must be cancelled")
            .is_cancelled());
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        release_tx.send(()).expect("release loader");
        receive_std_signal(&exit_rx, Duration::from_secs(1), "loader exit").await;
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn immediate_gate_catches_commit_when_session_end_wins_ready_race() {
        let host_id = Uuid::from_u128(10);
        let active = live_snapshot(credential_record(
            1,
            1,
            "old-token",
            host_id,
            "https://spawn.example/",
            7,
            &[],
        ));
        let committed = credential_record(
            2,
            2,
            "committed-token",
            host_id,
            "https://spawn.example/",
            8,
            &[(Uuid::from_u128(101), TEST_BROWSER_KEY_ONE)],
        );

        // Both futures are ready; model the session-ended branch winning and
        // therefore dropping the periodic reload future.
        tokio::select! {
            biased;
            _ = async {} => {}
            _ = async {} => panic!("biased session-end branch should win"),
        }
        let mut loader =
            CredentialLoader::start(Duration::from_millis(200), move || Ok(committed.clone()))
                .expect("credential loader");
        let admitted = credential_change_now_with(&active, &mut loader)
            .await
            .unwrap()
            .expect("pre-connect gate must observe committed generation");
        assert_eq!(admitted.generation, 2);
        assert_eq!(
            admitted.record.access_token.as_deref(),
            Some("committed-token")
        );
    }

    #[tokio::test]
    // Tungstenite's mandatory handshake callback owns its large HTTP error
    // response type; this local test never constructs or returns that branch.
    #[allow(clippy::result_large_err)]
    async fn local_daemon_connection_reloads_complete_record_before_reconnect() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local websocket");
        let address = listener.local_addr().unwrap();
        let server_url = url::Url::parse(&format!("http://{address}")).unwrap();
        let ws_url = config::ws_url(&server_url).unwrap();
        let (auth_tx, mut auth_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let server = tokio::spawn(async move {
            for connection_index in 0..2 {
                let (tcp, _) = listener.accept().await.expect("accept daemon socket");
                let auth_tx = auth_tx.clone();
                let mut socket = tokio_tungstenite::accept_hdr_async(
                    tcp,
                    move |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                          mut response: tokio_tungstenite::tungstenite::handshake::server::Response| {
                        let authorization = request
                            .headers()
                            .get("Authorization")
                            .and_then(|value| value.to_str().ok())
                            .unwrap_or("(missing)")
                            .to_owned();
                        auth_tx.send(authorization).expect("auth observation");
                        response.headers_mut().insert(
                            SEC_WEBSOCKET_PROTOCOL,
                            HeaderValue::from_static("spawn.control.v3"),
                        );
                        Ok(response)
                    },
                )
                .await
                .expect("daemon websocket handshake");
                if connection_index == 0 {
                    while socket.next().await.is_some() {}
                } else {
                    socket.close(None).await.expect("close second socket");
                }
            }
        });

        let host_id = Uuid::from_u128(10);
        let initial_record = credential_record(
            1,
            1,
            "old-local-token",
            host_id,
            server_url.as_str(),
            7,
            &[],
        );
        let committed_record = credential_record(
            2,
            2,
            "new-local-token",
            host_id,
            server_url.as_str(),
            8,
            &[(Uuid::from_u128(101), TEST_BROWSER_KEY_ONE)],
        );
        let active = LiveCredentialSnapshot::initial(initial_record.clone(), &server_url).unwrap();
        let backend = Arc::new(StdMutex::new(initial_record));
        let load = {
            let backend = Arc::clone(&backend);
            move || Ok(backend.lock().expect("credential backend").clone())
        };
        let mut loader =
            CredentialLoader::start(Duration::from_secs(1), load).expect("credential loader");
        let registry = SessionRegistry::new();
        assert!(
            registry.claim_discovery(),
            "disable ambient worker discovery"
        );
        let rtc_sessions = RtcSessions::new();
        assert!(rtc_sessions.bind_registered_host_id(host_id).await);

        let mut daemon_revoked = RevocationSet::new();
        let first_outcome = {
            let first = serve_one_connection_with_loader(
                &active,
                &ws_url,
                &registry,
                &rtc_sessions,
                Duration::from_millis(10),
                &mut loader,
                &mut daemon_revoked,
            );
            tokio::pin!(first);
            let first_auth = tokio::select! {
                auth = auth_rx.recv() => auth.expect("first authorization"),
                result = &mut first => panic!("first connection ended before mutation: {}", result.is_ok()),
            };
            assert_eq!(first_auth, "Bearer old-local-token");
            *backend.lock().expect("credential backend") = committed_record;
            tokio::time::timeout(Duration::from_secs(2), &mut first)
                .await
                .expect("live reload timeout")
                .expect("live reload result")
        };
        let active = match first_outcome {
            ServeOutcome::CredentialsChanged(next) => next,
            ServeOutcome::SessionEnded(_) => panic!("credential commit did not end old session"),
        };
        assert_eq!(active.generation, 2);
        assert_eq!(active.record.browser_pins().len(), 1);

        let second_outcome = tokio::time::timeout(
            Duration::from_secs(2),
            serve_one_connection_with_loader(
                &active,
                &ws_url,
                &registry,
                &rtc_sessions,
                Duration::from_millis(10),
                &mut loader,
                &mut daemon_revoked,
            ),
        )
        .await
        .expect("second local connection timeout")
        .expect("second local connection result");
        assert!(matches!(second_outcome, ServeOutcome::SessionEnded(_)));
        assert_eq!(
            auth_rx.recv().await.expect("second authorization"),
            "Bearer new-local-token"
        );
        tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .expect("local websocket server timeout")
            .expect("local websocket server task");
    }

    #[tokio::test]
    #[allow(clippy::result_large_err)]
    async fn local_daemon_rejects_ambiguous_signed_offer_values_before_rtc_dispatch() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local websocket");
        let address = listener.local_addr().unwrap();
        let server_url = url::Url::parse(&format!("http://{address}")).unwrap();
        let ws_url = config::ws_url(&server_url).unwrap();
        let (observed_tx, observed_rx) = oneshot::channel();
        let (close_tx, close_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.expect("accept daemon socket");
            let mut socket = tokio_tungstenite::accept_hdr_async(
                tcp,
                |_: &tokio_tungstenite::tungstenite::handshake::server::Request,
                 mut response: tokio_tungstenite::tungstenite::handshake::server::Response| {
                    response.headers_mut().insert(
                        SEC_WEBSOCKET_PROTOCOL,
                        HeaderValue::from_static("spawn.control.v3"),
                    );
                    Ok(response)
                },
            )
            .await
            .expect("daemon websocket handshake");
            let register = socket
                .next()
                .await
                .expect("daemon register frame")
                .expect("valid daemon register frame")
                .into_text()
                .expect("text daemon register frame");
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&register).unwrap()["type"],
                "register"
            );

            let signal_id = "018f0f77-86d2-7a8e-9b1c-1f3b847ca2a1";
            let session_id = "11111111-2222-4333-8444-555555555555";
            let frames = [
                serde_json::json!({
                    "type": "rtc.offer",
                    "session_id": signal_id,
                    "binding_nonce": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "binding_generation": 7,
                    "scope_type": "session",
                    "scope_id": session_id,
                    "protocol": "spawn.pty",
                    "protocol_version": 2,
                    "signed_envelope": null,
                    "sdp": "v=0\r\nraw downgrade"
                })
                .to_string(),
                serde_json::json!({
                    "type": "rtc.offer",
                    "session_id": session_id,
                    "signed_envelope": null
                })
                .to_string(),
                serde_json::json!({
                    "type": "rtc.offer",
                    "session_id": session_id,
                    "signed_envelope": {"unknown": true}
                })
                .to_string(),
                format!(r#"{{"type":"rtc.offer","session_id":"{session_id}","signed_envelope":}}"#),
                // A valid string selects signed mode. F1 deliberately refuses
                // it before RTC until F2 verifies and extracts transcript SDP.
                serde_json::json!({
                    "type": "rtc.offer",
                    "session_id": session_id,
                    "signed_envelope": "{\"opaque\":true}"
                })
                .to_string(),
                // Even a valid signed string cannot fall through to its raw
                // sibling, and an absent signed field still parses as legacy.
                serde_json::json!({
                    "type": "rtc.offer",
                    "session_id": session_id,
                    "signed_envelope": "{\"opaque\":true}",
                    "sdp": "v=0\r\nraw sibling"
                })
                .to_string(),
                serde_json::json!({
                    "type": "rtc.offer",
                    "session_id": session_id,
                    "sdp": "v=0\r\n",
                })
                .to_string(),
            ];
            for frame in frames {
                socket
                    .send(tokio_tungstenite::tungstenite::Message::Text(frame))
                    .await
                    .expect("send adversarial RTC frame");
            }
            socket
                .send(tokio_tungstenite::tungstenite::Message::Text(
                    r#"{"type":"host.ping","request_id":"after-rejected-rtc"}"#.into(),
                ))
                .await
                .expect("send post-rejection ping");

            let mut unexpected = Vec::new();
            loop {
                let message = tokio::time::timeout(Duration::from_secs(1), socket.next())
                    .await
                    .expect("post-rejection pong timeout")
                    .expect("post-rejection websocket close")
                    .expect("post-rejection websocket read")
                    .into_text()
                    .expect("post-rejection text frame");
                let value: serde_json::Value = serde_json::from_str(&message).unwrap();
                if value["type"] == "host.pong" && value["request_id"] == "after-rejected-rtc" {
                    break;
                }
                unexpected.push(value);
            }
            assert_eq!(unexpected, Vec::<serde_json::Value>::new());
            observed_tx.send(()).expect("rejection observation");
            close_rx.await.expect("close request");
            socket.close(None).await.expect("close daemon socket");
        });

        let host_id = Uuid::from_u128(10);
        let record = credential_record(
            1,
            1,
            "signed-presence-test-token",
            host_id,
            server_url.as_str(),
            7,
            &[],
        );
        let active = LiveCredentialSnapshot::initial(record.clone(), &server_url).unwrap();
        let stable_record = record.clone();
        let mut loader =
            CredentialLoader::start(Duration::from_secs(1), move || Ok(stable_record.clone()))
                .expect("credential loader");
        let registry = SessionRegistry::new();
        assert!(registry.claim_discovery());
        let rtc_sessions = RtcSessions::new();
        assert!(rtc_sessions.bind_registered_host_id(host_id).await);

        let mut daemon_revoked = RevocationSet::new();
        let connection = serve_one_connection_with_loader(
            &active,
            &ws_url,
            &registry,
            &rtc_sessions,
            Duration::from_secs(5),
            &mut loader,
            &mut daemon_revoked,
        );
        tokio::pin!(connection);
        tokio::time::timeout(Duration::from_secs(2), async {
            tokio::select! {
                observed = observed_rx => observed.expect("server rejection observation"),
                result = &mut connection => {
                    panic!("daemon connection ended before rejection proof: {}", result.is_ok());
                }
            }
        })
        .await
        .expect("live signed-presence rejection timeout");
        assert_eq!(rtc_sessions.resident_session_count().await, 0);
        close_tx.send(()).expect("close test websocket");
        let outcome = tokio::time::timeout(Duration::from_secs(1), &mut connection)
            .await
            .expect("daemon connection close timeout")
            .expect("daemon connection result");
        assert!(matches!(outcome, ServeOutcome::SessionEnded(_)));
        assert_eq!(rtc_sessions.resident_session_count().await, 0);
        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .expect("local websocket server timeout")
            .expect("local websocket server task");
    }

    #[test]
    fn carried_edge_cap_admits_at_cap_and_refuses_over_cap() {
        use ed25519_dalek::SigningKey;
        use spawnd::acct_endorsement::{sign_transcript, signature_to_wire};
        use spawnd::signed_signal::public_key_to_wire;
        use spawnd::signed_signal_wire::{sign_rtc_signal_wire, RtcProtocol};

        let user = "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";
        let account = account_id_bytes(user).expect("account bytes");

        // Host identity, an anchor device X (the only pinned key), and a
        // browser B admitted only through the carried chain X→B.
        let host_seed = [9u8; 32];
        let host_key = SigningKey::from_bytes(&host_seed);
        let host_peer =
            public_key_from_wire(&public_key_to_wire(&host_key.verifying_key())).unwrap();
        let anchor_key = SigningKey::from_bytes(&[1u8; 32]);
        let anchor_wire = public_key_to_wire(&anchor_key.verifying_key());
        let browser_key = SigningKey::from_bytes(&[7u8; 32]);
        let browser_wire = public_key_to_wire(&browser_key.verifying_key());

        let mut record = StoredCreds::default();
        record.host_private_key_seed = Some(URL_SAFE_NO_PAD.encode(host_seed));
        let fingerprint = creds::browser_key_fingerprint(&anchor_wire).unwrap();
        let pin = creds::browser_pin_from_approval(
            &Uuid::from_u128(1).to_string(),
            "ed25519",
            &anchor_wire,
            &fingerprint,
        )
        .unwrap();
        creds::merge_browser_pin(&mut record, pin).unwrap();

        // The signed offer proves possession of B.
        let offer = SignedSignalTranscript::new(
            SignalKind::Offer,
            2,
            Uuid::from_u128(2).to_string(),
            ScopeType::Session,
            Uuid::from_u128(3).to_string(),
            SenderRole::Browser,
            host_peer.to_bytes(),
            "v=0\r\no=browser\r\n",
        )
        .unwrap();
        let envelope = sign_rtc_signal_wire(&browser_key, RtcProtocol::Session, &offer).unwrap();

        // One genuine X→B edge, presented as duplicate copies up to the cap —
        // the honest relay's own maximum. Duplicates collapse before the
        // search, so this admits, and cheaply.
        let device_id = Uuid::from_u128(4).to_string();
        let transcript =
            AcctEndorsementTranscript::from_wire(user, &anchor_wire, &browser_wire, &device_id)
                .unwrap();
        let signature = signature_to_wire(&sign_transcript(&anchor_key, &transcript));
        let edge = CarriedEndorsement {
            account_id: user.to_string(),
            endorser_public_key: anchor_wire.clone(),
            endorsed_public_key: browser_wire.clone(),
            endorsed_device_id: device_id,
            signature,
        };
        let at_cap = vec![edge.clone(); MAX_CARRIED_ENDORSEMENTS];
        let verified = verify_signed_rtc_offer_admitted(
            &envelope,
            &record,
            Some(&account),
            &RevocationSet::new(),
            &at_cap,
        )
        .expect("an at-cap carried set with a genuine chain admits");
        assert_eq!(verified.sender_public_key(), &browser_key.verifying_key());

        // One over the daemon's independent cap: refused outright, even though
        // the same genuine chain is inside. Only a server driving the socket
        // directly can present this — the honest relay bounds at the same 64.
        let over_cap = vec![edge; MAX_CARRIED_ENDORSEMENTS + 1];
        assert!(
            verify_signed_rtc_offer_admitted(
                &envelope,
                &record,
                Some(&account),
                &RevocationSet::new(),
                &over_cap,
            )
            .is_none(),
            "an over-cap carried set must be refused"
        );
    }

    #[tokio::test]
    #[allow(clippy::result_large_err)]
    async fn a_revoked_key_stays_denied_when_a_later_frame_omits_it() {
        use ed25519_dalek::SigningKey;
        use spawnd::signed_signal::public_key_to_wire;
        use spawnd::signed_signal_wire::{sign_rtc_signal_wire, RtcProtocol};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local websocket");
        let address = listener.local_addr().unwrap();
        let server_url = url::Url::parse(&format!("http://{address}")).unwrap();
        let ws_url = config::ws_url(&server_url).unwrap();

        let host_id = Uuid::from_u128(10);
        let host_seed = [9u8; 32];
        let host_key = SigningKey::from_bytes(&host_seed);
        let host_peer =
            public_key_from_wire(&public_key_to_wire(&host_key.verifying_key())).unwrap();
        let browser_key = SigningKey::from_bytes(&[7u8; 32]);
        let browser_wire = public_key_to_wire(&browser_key.verifying_key());
        let browser_pk_bytes = browser_key.verifying_key().to_bytes();

        // A fully well-formed signed host-scope offer from the browser: absent
        // the revocation it would verify against the pin and reach RTC.
        let session_id = Uuid::from_u128(2).to_string();
        let offer = SignedSignalTranscript::new(
            SignalKind::Offer,
            1,
            session_id.clone(),
            ScopeType::Host,
            host_id.to_string(),
            SenderRole::Browser,
            host_peer.to_bytes(),
            "v=0\r\no=browser\r\n",
        )
        .unwrap();
        let envelope = sign_rtc_signal_wire(&browser_key, RtcProtocol::Host, &offer).unwrap();

        let account_id = "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";
        let (observed_tx, observed_rx) = oneshot::channel();
        let (close_tx, close_rx) = oneshot::channel();
        let server_session_id = session_id.clone();
        let server_browser_wire = browser_wire.clone();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.expect("accept daemon socket");
            let mut socket = tokio_tungstenite::accept_hdr_async(
                tcp,
                |_: &tokio_tungstenite::tungstenite::handshake::server::Request,
                 mut response: tokio_tungstenite::tungstenite::handshake::server::Response| {
                    response.headers_mut().insert(
                        SEC_WEBSOCKET_PROTOCOL,
                        HeaderValue::from_static("spawn.control.v3"),
                    );
                    Ok(response)
                },
            )
            .await
            .expect("daemon websocket handshake");
            let register = socket
                .next()
                .await
                .expect("daemon register frame")
                .expect("valid daemon register frame")
                .into_text()
                .expect("text daemon register frame");
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&register).unwrap()["type"],
                "register"
            );

            let frames = [
                // The revocation lands in the registration frame...
                serde_json::json!({
                    "type": "registered",
                    "host_id": host_id,
                    "account_id": account_id,
                    "revoked_browser_keys": [server_browser_wire],
                })
                .to_string(),
                // ...then a later push replaces the list with an EMPTY one —
                // the whole-replace un-revoke attack (P3′ residual). Pin
                // fields stay absent so pin reconciliation never runs.
                serde_json::json!({
                    "type": "host.browser_pins",
                    "account_id": account_id,
                    "revoked_browser_keys": [],
                })
                .to_string(),
                // The revoked (but still locally pinned) key now offers. The
                // monotonic floor must refuse it before any RTC work; with a
                // whole-replace deny-list this would verify, reach the RTC
                // path, and emit an answer or failure-status frame.
                serde_json::json!({
                    "type": "rtc.offer",
                    "session_id": server_session_id,
                    "binding_nonce": "a".repeat(32),
                    "scope_type": "host",
                    "scope_id": host_id,
                    "protocol": "spawn.host.ctl",
                    "protocol_version": 1,
                    "signed_envelope": envelope,
                    "ice_servers": [],
                })
                .to_string(),
            ];
            for frame in frames {
                socket
                    .send(tokio_tungstenite::tungstenite::Message::Text(frame))
                    .await
                    .expect("send revocation-ratchet frame");
            }
            socket
                .send(tokio_tungstenite::tungstenite::Message::Text(
                    r#"{"type":"host.ping","request_id":"after-revoked-offer"}"#.into(),
                ))
                .await
                .expect("send post-offer ping");

            // Dispatch is serial, so by pong time the offer was fully handled.
            // A revoked key is now answered with an explicit refusal so the
            // client does not spin forever. The refusal is not admission: no
            // RTC answer or resident session may be produced.
            let mut unexpected = Vec::new();
            loop {
                let message = tokio::time::timeout(Duration::from_secs(1), socket.next())
                    .await
                    .expect("post-offer pong timeout")
                    .expect("post-offer websocket close")
                    .expect("post-offer websocket read")
                    .into_text()
                    .expect("post-offer text frame");
                let value: serde_json::Value = serde_json::from_str(&message).unwrap();
                if value["type"] == "host.pong" && value["request_id"] == "after-revoked-offer" {
                    break;
                }
                unexpected.push(value);
            }
            assert_eq!(unexpected.len(), 1);
            assert_eq!(unexpected[0]["type"], "rtc.status");
            assert_eq!(unexpected[0]["status"], "failed");
            assert_eq!(unexpected[0]["session_id"], server_session_id);
            observed_tx.send(()).expect("refusal observation");
            close_rx.await.expect("close request");
            socket.close(None).await.expect("close daemon socket");
        });

        // The browser key IS pinned: only the deny-list stands between the
        // revoked device and admission.
        let record = credential_record(
            1,
            1,
            "revocation-ratchet-test-token",
            host_id,
            server_url.as_str(),
            9,
            &[(Uuid::from_u128(1), browser_wire.as_str())],
        );
        let active = LiveCredentialSnapshot::initial(record.clone(), &server_url).unwrap();
        let stable_record = record.clone();
        let mut loader =
            CredentialLoader::start(Duration::from_secs(1), move || Ok(stable_record.clone()))
                .expect("credential loader");
        let registry = SessionRegistry::new();
        assert!(registry.claim_discovery());
        let rtc_sessions = RtcSessions::new();
        assert!(rtc_sessions.bind_registered_host_id(host_id).await);

        let mut daemon_revoked = RevocationSet::new();
        {
            let connection = serve_one_connection_with_loader(
                &active,
                &ws_url,
                &registry,
                &rtc_sessions,
                Duration::from_secs(5),
                &mut loader,
                &mut daemon_revoked,
            );
            tokio::pin!(connection);
            tokio::time::timeout(Duration::from_secs(2), async {
                tokio::select! {
                    observed = observed_rx => observed.expect("server refusal observation"),
                    result = &mut connection => {
                        panic!("daemon connection ended before refusal proof: {}", result.is_ok());
                    }
                }
            })
            .await
            .expect("live revocation-ratchet refusal timeout");
            assert_eq!(rtc_sessions.resident_session_count().await, 0);
            close_tx.send(()).expect("close test websocket");
            let outcome = tokio::time::timeout(Duration::from_secs(1), &mut connection)
                .await
                .expect("daemon connection close timeout")
                .expect("daemon connection result");
            assert!(matches!(outcome, ServeOutcome::SessionEnded(_)));
        }
        // The floor outlives the connection: a reconnect (a fresh dispatch
        // loop) starts from this state, so the omitted key stays denied for
        // the life of the process, not just the socket.
        assert!(daemon_revoked.contains(&browser_pk_bytes));
        assert_eq!(rtc_sessions.resident_session_count().await, 0);
        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .expect("local websocket server timeout")
            .expect("local websocket server task");
    }

    #[tokio::test]
    #[allow(clippy::result_large_err)]
    async fn stalled_live_loader_closes_websocket_invalidates_trust_and_returns_fatal_error() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local websocket");
        let address = listener.local_addr().unwrap();
        let server_url = url::Url::parse(&format!("http://{address}")).unwrap();
        let ws_url = config::ws_url(&server_url).unwrap();
        let (registered_tx, registered_rx) = oneshot::channel();
        let (closed_tx, closed_rx) = oneshot::channel();
        let registered_state = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let server_registered_state = Arc::clone(&registered_state);
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.expect("accept daemon socket");
            let mut socket = tokio_tungstenite::accept_hdr_async(
                tcp,
                |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                 mut response: tokio_tungstenite::tungstenite::handshake::server::Response| {
                    assert_eq!(
                        request
                            .headers()
                            .get("Authorization")
                            .and_then(|value| value.to_str().ok()),
                        Some("Bearer live-stall-secret-token")
                    );
                    response.headers_mut().insert(
                        SEC_WEBSOCKET_PROTOCOL,
                        HeaderValue::from_static("spawn.control.v3"),
                    );
                    Ok(response)
                },
            )
            .await
            .expect("daemon websocket handshake");
            socket
                .next()
                .await
                .expect("daemon register frame")
                .expect("valid daemon register frame");
            server_registered_state.store(true, std::sync::atomic::Ordering::SeqCst);
            let _ = registered_tx.send(());
            while socket.next().await.is_some() {}
            let _ = closed_tx.send(tokio::time::Instant::now());
        });

        let host_id = Uuid::from_u128(10);
        let record = credential_record(
            1,
            1,
            "live-stall-secret-token",
            host_id,
            server_url.as_str(),
            7,
            &[],
        );
        let active = LiveCredentialSnapshot::initial(record.clone(), &server_url).unwrap();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let load_calls = Arc::clone(&calls);
        let load_registered_state = Arc::clone(&registered_state);
        let (stall_tx, stall_rx) = std_mpsc::channel();
        let (release_tx, release_rx) = std_mpsc::channel();
        let (exit_tx, exit_rx) = std_mpsc::channel();
        let mut stall_tx = Some(stall_tx);
        let mut release_rx = Some(release_rx);
        let mut loader = CredentialLoader::start_observed(
            Duration::from_millis(100),
            move || {
                load_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if !load_registered_state.load(std::sync::atomic::Ordering::SeqCst) {
                    return Ok(record.clone());
                }
                stall_tx.take().expect("one stalled load").send(()).ok();
                release_rx
                    .take()
                    .expect("one stalled load release")
                    .recv()
                    .expect("release stalled live load");
                Ok(record.clone())
            },
            exit_tx,
        )
        .expect("credential loader");
        let registry = SessionRegistry::new();
        assert!(registry.claim_discovery());
        let rtc_sessions = RtcSessions::new();
        assert!(rtc_sessions.bind_registered_host_id(host_id).await);
        let epoch_before = rtc_sessions.trust_epoch_for_test();
        let mut daemon_revoked = RevocationSet::new();

        {
            let connection = serve_one_connection_with_loader(
                &active,
                &ws_url,
                &registry,
                &rtc_sessions,
                Duration::from_millis(5),
                &mut loader,
                &mut daemon_revoked,
            );
            tokio::pin!(connection);
            tokio::time::timeout(Duration::from_secs(1), async {
                tokio::select! {
                    registered = registered_rx => {
                        registered.expect("daemon registration sender");
                    }
                    result = &mut connection => {
                        panic!("daemon connection ended before registration: {}", result.is_ok());
                    }
                }
            })
            .await
            .expect("daemon registration timeout");
            tokio::select! {
                _ = receive_std_signal(
                    &stall_rx,
                    Duration::from_secs(1),
                    "live loader stall",
                ) => {}
                result = &mut connection => {
                    panic!("daemon connection ended before loader stall: {}", result.is_ok());
                }
            }
            let deadline_started = tokio::time::Instant::now();
            let error = tokio::time::timeout(Duration::from_millis(500), &mut connection)
                .await
                .expect("fatal loader deadline did not return")
                .err()
                .expect("loader deadline must be fatal to the supervisor");
            assert!(deadline_started.elapsed() < Duration::from_millis(250));
            let message = format!("{error:#}");
            assert!(message.contains("hard deadline"));
            assert!(!message.contains("live-stall-secret-token"));
            assert!(rtc_sessions.trust_epoch_for_test() > epoch_before);
            let closed_at = tokio::time::timeout(Duration::from_millis(200), closed_rx)
                .await
                .expect("stale websocket was not closed after loader deadline")
                .expect("websocket close observation");
            assert!(
                closed_at.duration_since(deadline_started) < Duration::from_millis(250),
                "stale websocket survived past the loader fail-stop bound"
            );
            assert!(calls.load(std::sync::atomic::Ordering::SeqCst) >= 3);
        }

        let calls_at_failure = calls.load(std::sync::atomic::Ordering::SeqCst);
        let follow_on = loader
            .load()
            .await
            .err()
            .expect("fatal loader must prohibit reconnect loads");
        assert!(follow_on.to_string().contains("permanently unavailable"));
        assert_eq!(
            calls.load(std::sync::atomic::Ordering::SeqCst),
            calls_at_failure
        );
        release_tx.send(()).expect("release stalled live loader");
        receive_std_signal(&exit_rx, Duration::from_secs(1), "live loader exit").await;
        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .expect("local websocket server timeout")
            .expect("local websocket server task");
    }

    #[tokio::test]
    #[allow(clippy::result_large_err)]
    async fn credential_failure_slow_cleanup_cannot_revive_late_cancelled_loader_reply() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local websocket");
        let address = listener.local_addr().unwrap();
        let server_url = url::Url::parse(&format!("http://{address}")).unwrap();
        let ws_url = config::ws_url(&server_url).unwrap();
        let registered_state = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let server_registered_state = Arc::clone(&registered_state);
        let (registered_tx, registered_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.expect("accept daemon socket");
            let mut socket = tokio_tungstenite::accept_hdr_async(
                tcp,
                |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                 mut response: tokio_tungstenite::tungstenite::handshake::server::Response| {
                    assert_eq!(
                        request
                            .headers()
                            .get("Authorization")
                            .and_then(|value| value.to_str().ok()),
                        Some("Bearer cleanup-race-secret-token")
                    );
                    response.headers_mut().insert(
                        SEC_WEBSOCKET_PROTOCOL,
                        HeaderValue::from_static("spawn.control.v3"),
                    );
                    Ok(response)
                },
            )
            .await
            .expect("daemon websocket handshake");
            socket
                .next()
                .await
                .expect("daemon register frame")
                .expect("valid daemon register frame");
            server_registered_state.store(true, std::sync::atomic::Ordering::SeqCst);
            let _ = registered_tx.send(());
            while socket.next().await.is_some() {}
        });

        let host_id = Uuid::from_u128(10);
        let record = credential_record(
            1,
            1,
            "cleanup-race-secret-token",
            host_id,
            server_url.as_str(),
            7,
            &[],
        );
        let active = LiveCredentialSnapshot::initial(record.clone(), &server_url).unwrap();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let load_calls = Arc::clone(&calls);
        let load_registered_state = Arc::clone(&registered_state);
        let (stall_tx, stall_rx) = std_mpsc::channel();
        let (release_tx, release_rx) = std_mpsc::channel();
        let (reply_tx, reply_rx) = std_mpsc::channel();
        let (exit_tx, exit_rx) = std_mpsc::channel();
        let mut stall_tx = Some(stall_tx);
        let mut release_rx = Some(release_rx);
        let mut loader = CredentialLoader::start_observed_replies(
            Duration::from_millis(300),
            move || {
                load_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if !load_registered_state.load(std::sync::atomic::Ordering::SeqCst) {
                    return Ok(record.clone());
                }
                stall_tx.take().expect("one stalled load").send(()).ok();
                release_rx
                    .take()
                    .expect("one stalled load release")
                    .recv()
                    .expect("release cleanup-race loader");
                Ok(record.clone())
            },
            exit_tx,
            reply_tx,
        )
        .expect("credential loader");
        let registry = SessionRegistry::new();
        assert!(registry.claim_discovery());
        let rtc_sessions = RtcSessions::new();
        assert!(rtc_sessions.bind_registered_host_id(host_id).await);
        let epoch_before = rtc_sessions.trust_epoch_for_test();
        let cleanup_gate = rtc_sessions.stall_next_close_all_for_test().await;
        let mut daemon_revoked = RevocationSet::new();

        let outcome = {
            let connection = serve_one_connection_with_loader(
                &active,
                &ws_url,
                &registry,
                &rtc_sessions,
                Duration::from_millis(5),
                &mut loader,
                &mut daemon_revoked,
            );
            tokio::pin!(connection);
            tokio::time::timeout(Duration::from_secs(1), async {
                tokio::select! {
                    registered = registered_rx => {
                        registered.expect("daemon registration sender");
                    }
                    result = &mut connection => {
                        panic!("connection ended before registration: {}", result.is_ok());
                    }
                }
            })
            .await
            .expect("daemon registration timeout");
            tokio::select! {
                _ = receive_std_signal(
                    &stall_rx,
                    Duration::from_secs(1),
                    "cleanup-race loader stall",
                ) => {}
                result = &mut connection => {
                    panic!("connection ended before loader stall: {}", result.is_ok());
                }
            }
            // The hard loader deadline is a trust failure. It must enter the
            // invalidate_trust_and_close_all path even though an ordinary
            // socket close deliberately would not.
            tokio::time::timeout(Duration::from_secs(1), async {
                tokio::select! {
                    _ = cleanup_gate.wait_entered() => {}
                    result = &mut connection => {
                        panic!("connection skipped slow cleanup: {}", result.is_ok());
                    }
                }
            })
            .await
            .expect("session cleanup did not begin");

            // The active reload future has hit its hard deadline while the
            // underlying blocking request is still running. Trust cleanup is
            // deliberately held while that cancelled request replies late.
            release_tx.send(()).expect("release cleanup-race loader");
            receive_std_signal(&reply_rx, Duration::from_secs(1), "late cleanup-race reply").await;
            cleanup_gate.release();
            tokio::time::timeout(Duration::from_secs(1), &mut connection)
                .await
                .expect("connection cleanup timeout")
        };
        let error = match outcome {
            Err(error) => error,
            Ok(_) => panic!("credential deadline must fail closed"),
        };
        let message = format!("{error:#}");
        assert!(message.contains("hard deadline"));
        assert!(!message.contains("cleanup-race-secret-token"));
        assert!(rtc_sessions.trust_epoch_for_test() > epoch_before);
        let calls_at_failure = calls.load(std::sync::atomic::Ordering::SeqCst);
        assert!(loader.load().await.is_err());
        assert_eq!(
            calls.load(std::sync::atomic::Ordering::SeqCst),
            calls_at_failure
        );
        receive_std_signal(&exit_rx, Duration::from_secs(1), "cleanup-race loader exit").await;
        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .expect("local websocket server timeout")
            .expect("local websocket server task");
    }

    #[tokio::test]
    async fn ordinary_socket_close_keeps_peer_trust_and_skips_cleanup_gate() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server_url = url::Url::parse(&format!("http://{address}")).unwrap();
        let ws_url = config::ws_url(&server_url).unwrap();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_hdr_async(
                tcp,
                |_: &tokio_tungstenite::tungstenite::handshake::server::Request,
                 mut response: tokio_tungstenite::tungstenite::handshake::server::Response| {
                    response.headers_mut().insert(
                        SEC_WEBSOCKET_PROTOCOL,
                        HeaderValue::from_static("spawn.control.v3"),
                    );
                    Ok(response)
                },
            )
            .await
            .unwrap();
            socket.next().await.unwrap().unwrap();
            socket.close(None).await.unwrap();
        });

        let host_id = Uuid::from_u128(10);
        let record = credential_record(
            1,
            1,
            "ordinary-close-token",
            host_id,
            server_url.as_str(),
            7,
            &[],
        );
        let active = LiveCredentialSnapshot::initial(record.clone(), &server_url).unwrap();
        let mut loader =
            CredentialLoader::start(Duration::from_secs(1), move || Ok(record.clone())).unwrap();
        let registry = SessionRegistry::new();
        assert!(registry.claim_discovery());
        let rtc_sessions = RtcSessions::new();
        assert!(rtc_sessions.bind_registered_host_id(host_id).await);
        let epoch_before = rtc_sessions.trust_epoch_for_test();
        let cleanup_gate = rtc_sessions.stall_next_close_all_for_test().await;
        let mut revoked = RevocationSet::new();

        let outcome = tokio::time::timeout(
            Duration::from_secs(1),
            serve_one_connection_with_loader(
                &active,
                &ws_url,
                &registry,
                &rtc_sessions,
                Duration::from_secs(5),
                &mut loader,
                &mut revoked,
            ),
        )
        .await
        .expect("ordinary close timeout")
        .expect("ordinary close result");
        assert!(matches!(outcome, ServeOutcome::SessionEnded(_)));
        assert_eq!(rtc_sessions.trust_epoch_for_test(), epoch_before);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), cleanup_gate.wait_entered())
                .await
                .is_err(),
            "ordinary close entered trust cleanup"
        );
        server.await.unwrap();
    }

    fn tool_status(
        version: Option<&str>,
        latest: Option<&str>,
        update_available: Option<bool>,
    ) -> HostAgentStatus {
        HostAgentStatus {
            agent_id: "p".into(),
            agent_name: "claude".into(),
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

        let create = SessionCreate {
            session_id: Uuid::new_v4(),
            cwd: "/work/repo".to_string(),
            skills: vec![
                SkillConfig {
                    id: "skill-1".to_string(),
                    name: "spawn control".to_string(),
                    description: "Operate spawn".to_string(),
                    content: "Use spawn carefully.".to_string(),
                },
                SkillConfig {
                    id: "skill-2".to_string(),
                    name: "repo/notes".to_string(),
                    description: "Repo notes".to_string(),
                    content: "Remember project conventions.".to_string(),
                },
            ],
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

    #[cfg(unix)]
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

    #[cfg(unix)]
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

        normalize_session_env(&mut env).await;

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

    #[cfg(windows)]
    #[test]
    fn windows_resolver_honors_case_insensitive_env_and_pathext_order() {
        let temp = tempfile::tempdir().expect("tempdir");
        let exe = temp.path().join("agent.EXE");
        let shim = temp.path().join("agent.CMD");
        fs::write(&exe, b"fixture").unwrap();
        fs::write(&shim, b"@echo off\r\n").unwrap();
        let mut env = BTreeMap::new();
        env.insert("Path".into(), temp.path().to_string_lossy().into_owned());
        env.insert("PathExt".into(), ".EXE;.CMD".into());

        let resolved = resolve_program_in_env(Path::new("agent"), &env).unwrap();
        assert_eq!(resolved.path, fs::canonicalize(exe).unwrap());
        assert_eq!(resolved.kind, crate::platform::ProgramKind::Native);

        env.insert("PathExt".into(), ".CMD;.EXE".into());
        let resolved = resolve_program_in_env(Path::new("agent"), &env).unwrap();
        assert_eq!(resolved.path, fs::canonicalize(shim).unwrap());
        assert_eq!(resolved.kind, crate::platform::ProgramKind::CmdShim);
    }

    #[cfg(windows)]
    #[test]
    fn windows_path_enrichment_keeps_one_case_insensitive_path_key() {
        let mut env = BTreeMap::new();
        env.insert("Path".into(), r"C:\Windows\System32".into());
        env.insert("PATH".into(), r"C:\duplicate".into());
        env.insert(
            "LOCALAPPDATA".into(),
            r"C:\Users\Case Test\AppData\Local".into(),
        );
        env.insert(
            "APPDATA".into(),
            r"C:\Users\Case Test\AppData\Roaming".into(),
        );
        env.insert("USERPROFILE".into(), r"C:\Users\Case Test".into());

        let preferred = common_user_bin_entries(&env);
        prepend_path_entries(&mut env, preferred);
        assert_eq!(
            env.keys()
                .filter(|key| key.eq_ignore_ascii_case("PATH"))
                .count(),
            1
        );
        let entries = std::env::split_paths(env_get_ci(&env, "PATH").unwrap()).collect::<Vec<_>>();
        assert_eq!(
            entries.first().unwrap(),
            &PathBuf::from(r"C:\Users\Case Test\AppData\Local\spawn\bin")
        );
        assert!(entries
            .iter()
            .any(|entry| entry == &PathBuf::from(r"C:\Users\Case Test\.local\bin")));
    }

    #[cfg(windows)]
    #[test]
    fn windows_shell_resolution_and_arguments_follow_platform_order() {
        let temp = tempfile::tempdir().expect("tempdir");
        let pwsh = temp.path().join("pwsh.exe");
        let powershell = temp.path().join("powershell.exe");
        let cmd = temp.path().join("cmd.exe");
        for path in [&pwsh, &powershell, &cmd] {
            fs::write(path, b"fixture").unwrap();
        }
        let mut env = BTreeMap::new();
        env.insert("PATH".into(), temp.path().to_string_lossy().into_owned());
        env.insert("COMSPEC".into(), cmd.to_string_lossy().into_owned());

        let shell = resolve_login_shell(&env);
        assert_eq!(PathBuf::from(&shell), fs::canonicalize(&pwsh).unwrap());
        assert_eq!(login_shell_argv(shell)[1], "-NoLogo");
        fs::remove_file(&pwsh).unwrap();
        let shell = resolve_login_shell(&env);
        assert_eq!(
            PathBuf::from(&shell),
            fs::canonicalize(&powershell).unwrap()
        );
        fs::remove_file(&powershell).unwrap();
        let shell = resolve_login_shell(&env);
        assert_eq!(PathBuf::from(&shell), cmd);
        assert_eq!(login_shell_argv(shell)[1], "/d");
    }

    #[cfg(windows)]
    #[test]
    fn cmd_shim_builder_accepts_only_fixed_code_owned_tokens() {
        assert_eq!(
            cmd_shim_command_line(&["--version"]).as_deref(),
            Some("\"\"%SPAWN_CMD_SHIM%\" --version\"")
        );
        assert!(cmd_shim_command_line(&["update", "&whoami"]).is_none());
        assert!(cmd_shim_command_line(&["--version", "user supplied"]).is_none());
    }
}

async fn handle_session_restart(
    create: SessionCreate,
    registry: &SessionRegistry,
    rtc_sessions: &RtcSessions,
    out_tx: &mpsc::Sender<WsOutbound>,
) {
    let session_id = create.session_id;
    tracing::info!(%session_id, "session.restart");

    // Hold the generation transition across every lifecycle delivery. This
    // lets each TERM/KILL revalidate the exact atomic lifecycle snapshot and
    // prevents replacement from linearizing between validation and the
    // worker-owned signal syscall.
    let transition = registry.lock_generation_transition(session_id).await;
    let current = registry.lifecycle_snapshot(session_id);
    if let Some(snapshot) = &current {
        let binding = snapshot.binding();
        rtc_sessions
            .close_for_session(session_id, binding.generation())
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
            Err(anyhow!("stale session lifecycle generation"))
        };
        if let Err(error) = &term_result {
            tracing::warn!(%session_id, %error, "restart TERM delivery failed; escalating now");
        }
        let mut kill_attempted = false;
        for attempt in 0..30u32 {
            if !worker_backend::socket_exists(session_id) {
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
                    Err(anyhow!("stale session lifecycle generation"))
                };
                if let Err(error) = kill_result {
                    tracing::error!(%session_id, %error, "restart KILL delivery failed");
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let _ = registry.remove_if_generation(session_id, binding.generation());
        crate::state::active_heartbeat(registry.ids().len());
    }
    drop(transition);

    if worker_backend::socket_exists(session_id) {
        send_spawn_failed_exit(session_id, out_tx, "restart timeout").await;
        return;
    }
    handle_session_create(create, registry, rtc_sessions, out_tx).await;
}

async fn handle_session_kill(
    session_id: Uuid,
    signal: Option<spawnd::sessiond::wire::LifecycleSignal>,
    registry: &SessionRegistry,
    rtc_sessions: &RtcSessions,
    out_tx: &mpsc::Sender<WsOutbound>,
) {
    // Signal through the worker, adopting first if this daemon process has
    // not attached yet. The worker Exit frame drives session.exit.
    if !registry.contains(session_id) {
        let _ = ensure_session_attached(session_id, registry, rtc_sessions, out_tx).await;
    }
    let Some(snapshot) = registry.lifecycle_snapshot(session_id) else {
        send_error(
            out_tx,
            Some(session_id),
            "kill_failed",
            &anyhow!("session lifecycle is unavailable"),
        )
        .await;
        return;
    };
    let requested = signal.unwrap_or(spawnd::sessiond::wire::LifecycleSignal::Term);
    if let Err(error) = registry.shutdown_if_current(&snapshot, requested).await {
        tracing::warn!(%session_id, %error, "session signal delivery failed");
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
            Some(session_id),
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
                tracing::warn!(%session_id, %error, "delayed session KILL delivery failed");
            }
        });
    }
    // The worker reports exit and emits `session.exit`. We do not
    // remove from the registry here — let the exit handler do it once it has
    // the exit code.
}

async fn send_error(
    out_tx: &mpsc::Sender<WsOutbound>,
    session_id: Option<Uuid>,
    code: &str,
    err: &anyhow::Error,
) {
    let frame = Outbound::Error {
        session_id,
        code: code.into(),
        message: format!("{err:#}"),
        request_id: None,
        client_id: None,
    };
    if let Ok(s) = serde_json::to_string(&frame) {
        let _ = out_tx.send(WsOutbound::json(s)).await;
    }
    tracing::warn!(?session_id, code, error = %err, "sent error frame");
}

async fn send_error_code(
    out_tx: &mpsc::Sender<WsOutbound>,
    session_id: Option<Uuid>,
    code: &str,
    message: &str,
) {
    let frame = Outbound::Error {
        session_id,
        code: code.into(),
        message: message.into(),
        request_id: None,
        client_id: None,
    };
    if let Ok(serialized) = serde_json::to_string(&frame) {
        let _ = out_tx.send(WsOutbound::json(serialized)).await;
    }
}

async fn send_spawn_failed_exit(session_id: Uuid, out_tx: &mpsc::Sender<WsOutbound>, reason: &str) {
    let exit = Outbound::SessionExit {
        session_id,
        exit_code: None,
        signal: Some(format!("spawn_failed: {reason}")),
    };
    if let Ok(s) = serde_json::to_string(&exit) {
        let _ = out_tx.send(WsOutbound::json(s)).await;
    }
}

async fn spawn_exit_forwarder(
    session_id: Uuid,
    generation: u64,
    exit_rx: tokio::sync::oneshot::Receiver<pty::ExitReason>,
    registry: SessionRegistry,
    rtc_sessions: RtcSessions,
    out_tx: mpsc::Sender<WsOutbound>,
) {
    let reason = exit_rx.await.unwrap_or(pty::ExitReason {
        exit_code: None,
        signal: None,
    });
    let transition = registry.lock_generation_transition(session_id).await;
    let removed = registry.remove_if_generation(session_id, generation);
    rtc_sessions.close_for_session(session_id, generation).await;
    drop(transition);
    if removed.is_none() {
        tracing::debug!(%session_id, generation, "ignoring stale session exit");
        return;
    }
    crate::state::active_heartbeat(registry.ids().len());
    let exit = Outbound::SessionExit {
        session_id,
        exit_code: reason.exit_code,
        signal: reason.signal,
    };
    if let Ok(s) = serde_json::to_string(&exit) {
        let _ = out_tx.send(WsOutbound::json(s)).await;
    }
}

/// Adopt a running session worker for this session (spawnd restart / lazy
/// attach). Returns false when no live worker exists.
async fn adopt_worker_session(
    session_id: Uuid,
    registry: &SessionRegistry,
    rtc_sessions: &RtcSessions,
    out_tx: &mpsc::Sender<WsOutbound>,
    notify_started: bool,
) -> Result<bool> {
    if registry.contains(session_id) {
        return Ok(true);
    }
    let Some(launched) = worker_backend::adopt(session_id).await? else {
        return Ok(false);
    };
    register_attached(
        session_id,
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
/// registry, optionally announce session.started, and spawn the exit forwarder.
async fn register_attached(
    session_id: Uuid,
    launched: pty::Launched,
    registry: &SessionRegistry,
    rtc_sessions: &RtcSessions,
    out_tx: &mpsc::Sender<WsOutbound>,
    notify_started: bool,
) {
    let pid = launched.pid;
    let exit_rx = launched.exit_rx;

    launched.handle.control.set_sink(out_tx.clone()).await;
    let transition = registry.lock_generation_transition(session_id).await;
    if let Some(previous) = registry.binding_for(session_id) {
        let _ = registry.remove_if_generation(session_id, previous.generation());
        rtc_sessions
            .close_for_session(session_id, previous.generation())
            .await;
    }
    let generation = registry.insert(launched.handle);
    drop(transition);
    crate::state::active_heartbeat(registry.ids().len());

    if notify_started {
        let started = Outbound::SessionStarted { session_id, pid };
        let _ = out_tx
            .send(WsOutbound::json(serde_json::to_string(&started).unwrap()))
            .await;
    }

    tokio::spawn(spawn_exit_forwarder(
        session_id,
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

async fn ensure_session_attached(
    session_id: Uuid,
    registry: &SessionRegistry,
    rtc_sessions: &RtcSessions,
    out_tx: &mpsc::Sender<WsOutbound>,
) -> AttachOutcome {
    if registry.contains(session_id) {
        return AttachOutcome::Attached;
    }
    // Serialize lazy adoption: snapshot bursts and stdin dispatch racing here
    // would double-connect and displace each other's worker connections.
    let _guard = registry.lock_attach().await;
    if registry.contains(session_id) {
        return AttachOutcome::Attached;
    }
    match adopt_worker_session(session_id, registry, rtc_sessions, out_tx, true).await {
        Ok(true) => {
            tracing::info!(%session_id, "lazily adopted session worker");
            AttachOutcome::Attached
        }
        Ok(false) => {
            tracing::debug!(%session_id, "no session worker found for unknown session");
            AttachOutcome::Unavailable
        }
        Err(e) => {
            tracing::warn!(%session_id, error = %e, "worker adoption failed");
            AttachOutcome::Unknown
        }
    }
}

/// On daemon startup, discover worker sockets left behind by a previous
/// instance and adopt each live session.
async fn rediscover_existing_sessions(
    registry: &SessionRegistry,
    rtc_sessions: &RtcSessions,
    out_tx: &mpsc::Sender<WsOutbound>,
) {
    for session_id in worker_backend::discover_ids() {
        if registry.contains(session_id) {
            continue;
        }
        match adopt_worker_session(session_id, registry, rtc_sessions, out_tx, false).await {
            Ok(true) => tracing::info!(%session_id, "rediscovered worker-backed session"),
            Ok(false) => {}
            Err(e) => {
                tracing::warn!(%session_id, error = %e, "failed to adopt session worker");
            }
        }
    }
}
