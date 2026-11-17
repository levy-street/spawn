//! One process owner for support consent, admission, and cancellation. Dispatch
//! delivers bounded commands; it never waits for storage, crypto, or a response.
use crate::{
    creds::{BrowserPin, StoredCreds},
    support_log,
    support_store::{self, Outcome, Receipt},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use spawnd::{endorsement_chain::RevocationSet, support_consent::Consent};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock, Weak,
    },
    time::Duration,
};
use tokio::sync::{mpsc, Notify};
use uuid::Uuid;

const DEADLINE: Duration = Duration::from_secs(30);
const AUDIT_RESERVE: Duration = Duration::from_secs(2);
const QUEUE: usize = 32;
const CHUNK: usize = 4096;
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Refusal {
    NotConsented,
    SignerUntrusted,
    RateLimited,
    NoLog,
    Failed,
}
// The only JSON body. Keep this tagged enum and its single serialization site
// pinned by the source guard; it cannot contain arbitrary caller text.
#[derive(Serialize)]
#[serde(tag = "declined", rename_all = "snake_case")]
enum RefusalBody {
    NotConsented,
    SignerUntrusted,
    RateLimited,
    NoLog,
    Failed,
}
impl From<Refusal> for RefusalBody {
    fn from(value: Refusal) -> Self {
        match value {
            Refusal::NotConsented => Self::NotConsented,
            Refusal::SignerUntrusted => Self::SignerUntrusted,
            Refusal::RateLimited => Self::RateLimited,
            Refusal::NoLog => Self::NoLog,
            Refusal::Failed => Self::Failed,
        }
    }
}
#[derive(Clone)]
pub(crate) struct Trust {
    pub pins: Arc<[BrowserPin]>,
    pub account: Option<[u8; 16]>,
    pub revoked: RevocationSet,
    pub token: Option<Arc<str>>,
}
impl Trust {
    pub(crate) fn from_record(record: &StoredCreds) -> Self {
        Self {
            pins: record.browser_pins().into(),
            account: record
                .proven_account_id()
                .and_then(|id| spawnd::host_pair_approval::account_id_bytes(&id).ok()),
            revoked: RevocationSet::new(),
            token: record.access_token.as_deref().map(Arc::from),
        }
    }
    pub(crate) fn verify(&self, consent: &Consent, now: u64) -> Result<(), Refusal> {
        let account = self.account.as_ref().ok_or(Refusal::NotConsented)?;
        let signer = consent
            .verify(account, now)
            .map_err(|_| Refusal::NotConsented)?;
        let device =
            Uuid::parse_str(&consent.signer_device_id).map_err(|_| Refusal::SignerUntrusted)?;
        if !crate::run::admitted_device(
            &signer,
            &self.pins,
            Some(account),
            &self.revoked,
            &consent.carried_endorsements,
            Some(device),
        ) {
            return Err(Refusal::SignerUntrusted);
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct RuntimeStatus {
    pub permanent_deny: bool,
    pub pending: bool,
    pub dropped_requests: u64,
}
static ACTIVE: OnceLock<Weak<Delivery>> = OnceLock::new();
pub(crate) fn runtime_status() -> Option<RuntimeStatus> {
    ACTIVE.get()?.upgrade().map(|d| d.status())
}
struct Delivery {
    delivered: AtomicU64,
    applied: AtomicU64, // actor writes only; never used to clear a denial flag
    permanent: AtomicBool,
    dropped: AtomicU64,
    changed: Notify,
    #[cfg(test)]
    hooks: tests::Hooks,
}
impl Delivery {
    fn new() -> Self {
        Self {
            delivered: AtomicU64::new(0),
            applied: AtomicU64::new(0),
            permanent: AtomicBool::new(false),
            dropped: AtomicU64::new(0),
            changed: Notify::new(),
            #[cfg(test)]
            hooks: tests::Hooks::default(),
        }
    }
    fn advance(&self) -> u64 {
        let generation = self
            .delivered
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_add(1));
        self.changed.notify_waiters();
        match generation {
            Ok(n) => n + 1,
            Err(n) => {
                self.deny();
                n
            }
        }
    }
    fn deny(&self) {
        self.permanent.store(true, Ordering::SeqCst);
        self.changed.notify_waiters();
    }
    fn status(&self) -> RuntimeStatus {
        RuntimeStatus {
            permanent_deny: self.permanent.load(Ordering::SeqCst),
            pending: self.applied.load(Ordering::SeqCst) != self.delivered.load(Ordering::SeqCst),
            dropped_requests: self.dropped.load(Ordering::Relaxed),
        }
    }
}
#[derive(Clone)]
struct Stop {
    delivery: Arc<Delivery>,
    generation: u64,
}
impl Stop {
    fn stopped(&self) -> bool {
        self.delivery.permanent.load(Ordering::SeqCst)
            || self.delivery.delivered.load(Ordering::SeqCst) != self.generation
    }
    async fn changed(&self) {
        loop {
            let notified = self.delivery.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.stopped() {
                return;
            }
            notified.await;
        }
    }
}
struct Context {
    ready: mpsc::WeakSender<Command>,
    config: PathBuf,
    path: PathBuf,
    source: Option<support_log::SupportLog>,
    instance: String,
}
struct Budget {
    next: tokio::time::Instant,
}
impl Budget {
    fn admit(&mut self, now: tokio::time::Instant) -> bool {
        // GCRA: one credit per minute, burst three, no reconnect reset.
        if self.next > now + Duration::from_secs(120) {
            return false;
        }
        self.next = self.next.max(now) + Duration::from_secs(60);
        true
    }
}
pub(crate) struct Collector {
    tx: mpsc::Sender<Command>,
    delivery: Arc<Delivery>,
    budget: Mutex<Budget>,
}
#[derive(Clone)]
enum Input {
    Trust {
        value: Arc<Trust>,
        live: Option<Arc<[String]>>,
        revoked: Option<Arc<[String]>>,
    },
    Consent(Option<Consent>),
    Fence,
    Shutdown,
}
enum Command {
    Input(u64, Input),
    Collect {
        request_id: Uuid,
        window: u64,
        deadline: tokio::time::Instant,
        #[cfg(test)]
        done: Option<tokio::sync::oneshot::Sender<()>>,
    },
    Ready {
        generation: u64,
        done: tokio::sync::oneshot::Sender<Result<(), Refusal>>,
    },
    #[cfg(test)]
    Barrier(tokio::sync::oneshot::Sender<()>),
}
pub(crate) struct Fence<'a> {
    collector: Option<&'a Collector>,
    shutdown: bool,
}
impl<'a> Fence<'a> {
    pub(crate) fn connection(collector: Option<&'a Collector>) -> Self {
        Self {
            collector,
            shutdown: false,
        }
    }
    pub(crate) fn shutdown(collector: Option<&'a Collector>) -> Self {
        Self {
            collector,
            shutdown: true,
        }
    }
}
impl Drop for Fence<'_> {
    fn drop(&mut self) {
        if let Some(c) = self.collector {
            c.deliver(if self.shutdown {
                Input::Shutdown
            } else {
                Input::Fence
            });
        }
    }
}
impl Collector {
    pub(crate) fn start(config: PathBuf, origin: String) -> Option<Self> {
        // Optional from the first filesystem operation; never fail startup.
        let path = support_log::support_dir(&config).ok()?;
        crate::platform::open_support_dir(&path, true).ok()?;
        let source = support_log::active_for(&path);
        let instance = crate::service::instance_name(&config);
        let collector = Self::start_at(config, path, source, instance, origin)?;
        let _ = ACTIVE.set(Arc::downgrade(&collector.delivery));
        Some(collector)
    }
    fn start_at(
        config: PathBuf,
        path: PathBuf,
        source: Option<support_log::SupportLog>,
        instance: String,
        origin: String,
    ) -> Option<Self> {
        crate::platform::open_support_dir(&path, true).ok()?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .build()
            .ok()?;
        let delivery = Arc::new(Delivery::new());
        let (tx, rx) = mpsc::channel(QUEUE);
        let context = Arc::new(Context {
            ready: tx.downgrade(),
            config,
            path,
            source,
            instance,
        });
        tokio::spawn(serve(context, Arc::clone(&delivery), rx, client, origin));
        Some(Self {
            tx,
            delivery,
            budget: Mutex::new(Budget {
                next: tokio::time::Instant::now(),
            }),
        })
    }
    fn deliver(&self, input: Input) {
        // One short, nonwaiting delivery gate orders generation and enqueue even
        // if future callers use different tasks. Contention can only deny.
        let guard = self.budget.try_lock();
        let generation = self.delivery.advance();
        if guard.is_err() || self.tx.try_send(Command::Input(generation, input)).is_err() {
            self.delivery.deny();
        }
    }
    pub(crate) fn trust(
        &self,
        value: Arc<Trust>,
        live: Option<Arc<[String]>>,
        revoked: Option<Arc<[String]>>,
    ) {
        self.deliver(Input::Trust {
            value,
            live,
            revoked,
        });
    }
    pub(crate) fn consent(&self, value: Option<Consent>) {
        self.deliver(Input::Consent(value));
    }
    pub(crate) fn fence(&self) {
        self.deliver(Input::Fence);
    }
    pub(crate) fn collect(&self, request_id: Uuid, since_seconds: i64) {
        self.enqueue_collection(
            request_id,
            since_seconds,
            #[cfg(test)]
            None,
        );
    }
    fn enqueue_collection(
        &self,
        request_id: Uuid,
        since_seconds: i64,
        #[cfg(test)] done: Option<tokio::sync::oneshot::Sender<()>>,
    ) {
        let Ok(mut budget) = self.budget.try_lock() else {
            self.delivery.deny();
            return;
        };
        if !budget.admit(tokio::time::Instant::now()) {
            self.delivery.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        if self
            .tx
            .try_send(Command::Collect {
                request_id,
                window: since_seconds.clamp(60, 259200) as u64,
                deadline: tokio::time::Instant::now() + DEADLINE,
                #[cfg(test)]
                done,
            })
            .is_err()
        {
            self.delivery.advance();
            self.delivery.deny();
        }
    }
}
impl Drop for Collector {
    fn drop(&mut self) {
        self.deliver(Input::Shutdown);
    }
}

#[derive(PartialEq)]
enum Apply {
    Done,
    Retry,
    Permanent,
}
async fn apply(ctx: &Arc<Context>, input: &Input, trust: &mut Option<Arc<Trust>>) -> Apply {
    match input {
        Input::Fence | Input::Shutdown => Apply::Done,
        Input::Trust {
            value,
            live,
            revoked,
        } => {
            let mut next = (**value).clone();
            if let Some(previous) = trust {
                next.revoked.absorb(previous.revoked.clone());
            }
            if let Some(revoked) = revoked {
                for key in revoked.iter() {
                    if let Ok(key) = spawnd::signed_signal::public_key_from_wire(key) {
                        next.revoked.insert(key.to_bytes());
                    }
                }
            }
            if let Some(live) = live {
                for pin in next.pins.iter() {
                    if !live
                        .iter()
                        .any(|id| Uuid::parse_str(id).ok() == Some(pin.device_id()))
                    {
                        if let Ok(key) =
                            spawnd::signed_signal::public_key_from_wire(pin.public_key())
                        {
                            next.revoked.insert(key.to_bytes());
                        }
                    }
                }
            }
            if next.revoked.len() > support_store::MAX_REVOCATIONS {
                return Apply::Permanent;
            }
            let next = Arc::new(next);
            let config = ctx.config.clone();
            let copy = Arc::clone(&next);
            let result = tokio::task::spawn_blocking(move || {
                support_store::remember_revocations(&config, &copy)
            })
            .await;
            match result {
                Ok(Ok(revoked)) => {
                    let mut next = (*next).clone();
                    next.revoked = revoked;
                    *trust = Some(Arc::new(next));
                    Apply::Done
                }
                Ok(Err(error)) if error.is::<support_store::RevocationOverflow>() => {
                    Apply::Permanent
                }
                _ => Apply::Retry,
            }
        }
        Input::Consent(value) => {
            let Some(trust) = trust else {
                return Apply::Retry;
            };
            // Unknown local account cannot store or honour any statement.
            if trust.account.is_none() {
                return Apply::Done;
            }
            let config = ctx.config.clone();
            let value = value.clone();
            let trust = Arc::clone(trust);
            if matches!(
                tokio::task::spawn_blocking(move || support_store::apply(
                    &config,
                    value,
                    &trust,
                    support_log::now_unix_millis()
                ))
                .await,
                Ok(Ok(()))
            ) {
                Apply::Done
            } else {
                Apply::Retry
            }
        }
    }
}
fn supersedes(old: Option<&Consent>, new: &Consent) -> bool {
    old.is_none_or(|old| {
        new.issued_at_ms > old.issued_at_ms
            || (new.issued_at_ms == old.issued_at_ms && (!new.enabled || new.same_statement(old)))
    })
}
async fn serve(
    ctx: Arc<Context>,
    delivery: Arc<Delivery>,
    mut rx: mpsc::Receiver<Command>,
    client: reqwest::Client,
    origin: String,
) {
    let mut trust = None;
    let mut applied = 0;
    let mut active = false;
    let mut deferred = std::collections::VecDeque::new();
    loop {
        let command = if let Some(command) = deferred.pop_front() {
            command
        } else if let Some(command) = rx.recv().await {
            command
        } else {
            break;
        };
        match command {
            Command::Input(generation, input) => {
                let mut backoff = Duration::from_millis(10);
                // Retain the actual failed input, not just a denial bit. Later
                // inputs cannot overtake it; collection cannot erase it either.
                loop {
                    match apply(&ctx, &input, &mut trust).await {
                        Apply::Done => break,
                        Apply::Permanent => {
                            delivery.deny();
                            return;
                        }
                        Apply::Retry => {}
                    }
                    #[cfg(test)]
                    delivery.hooks.apply_failed.notify_one();
                    if matches!(&input, Input::Consent(value) if value.as_ref().is_none_or(|c| !c.enabled))
                    {
                        let config = ctx.config.clone();
                        if !matches!(
                            tokio::task::spawn_blocking(move || support_store::erase_statement(
                                &config
                            ))
                            .await,
                            Ok(Ok(()))
                        ) {
                            delivery.deny();
                        }
                        #[cfg(test)]
                        delivery.hooks.after_fallback.pause().await;
                    }
                    if delivery.permanent.load(Ordering::SeqCst) || rx.is_closed() {
                        return;
                    }
                    // Keep arrival order, but allow a later verified consent to
                    // supersede this failed consent. Intervening commands stay
                    // queued, and delivered > applied blocks every collection
                    // until that replacement itself has successfully applied.
                    let superseded = if let (Input::Consent(old), Some(current)) = (&input, &trust)
                    {
                        let replacement = deferred.iter().find_map(|command| match command {
                            Command::Input(_, Input::Consent(Some(new)))
                                if supersedes(old.as_ref(), new) =>
                            {
                                Some(new.clone())
                            }
                            _ => None,
                        });
                        if let Some(new) = replacement {
                            let current = Arc::clone(current);
                            tokio::task::spawn_blocking(move || {
                                current.verify(&new, support_log::now_unix_millis()).is_ok()
                            })
                            .await
                            .unwrap_or(false)
                        } else {
                            false
                        }
                    } else {
                        false
                    };
                    if superseded {
                        break;
                    }
                    tokio::select! {
                        _ = tokio::time::sleep(backoff) => {},
                        command = rx.recv() => {
                            let Some(command) = command else { return; };
                            if deferred.len() == QUEUE { delivery.deny(); return; }
                            deferred.push_back(command);
                        }
                    }
                    backoff = (backoff * 2).min(Duration::from_secs(1));
                }
                // Only the actor writes applied, and only the generation just
                // applied. A late operation cannot grant a newer generation:
                // delivered has already advanced, so equality is impossible.
                #[cfg(test)]
                delivery.hooks.after_apply.pause().await;
                match &input {
                    Input::Trust { .. } => active = true,
                    Input::Fence | Input::Shutdown => active = false,
                    Input::Consent(_) => {}
                }
                applied = generation;
                delivery.applied.store(applied, Ordering::SeqCst);
                if matches!(input, Input::Shutdown) {
                    return;
                }
            }
            Command::Collect {
                request_id,
                window,
                deadline,
                #[cfg(test)]
                done,
            } => {
                let ctx = Arc::clone(&ctx);
                let client = client.clone();
                let origin = origin.clone();
                let stop = Stop {
                    delivery: Arc::clone(&delivery),
                    generation: applied,
                };
                let current = trust.clone();
                // Authorisation belongs to this actor, including the disk reread.
                // Inputs delivered during that read invalidate this exact token.
                let auth = if !active || stop.stopped() {
                    Err(Refusal::NotConsented)
                } else if let Some(trust) = &current {
                    let config = ctx.config.clone();
                    let trust = Arc::clone(trust);
                    tokio::time::timeout_at(
                        deadline - AUDIT_RESERVE,
                        tokio::task::spawn_blocking(move || authorize(&config, &trust)),
                    )
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .unwrap_or(Err(Refusal::Failed))
                } else {
                    Err(Refusal::NotConsented)
                };
                tokio::spawn(async move {
                    collect(
                        ctx, &client, &origin, request_id, window, deadline, stop, current, auth,
                    )
                    .await;
                    #[cfg(test)]
                    if let Some(done) = done {
                        let _ = done.send(());
                    }
                });
            }
            Command::Ready { generation, done } => {
                let verdict = if !active
                    || applied != generation
                    || delivery.delivered.load(Ordering::SeqCst) != generation
                    || delivery.permanent.load(Ordering::SeqCst)
                {
                    Err(Refusal::NotConsented)
                } else if let Some(trust) = &trust {
                    let config = ctx.config.clone();
                    let trust = Arc::clone(trust);
                    tokio::task::spawn_blocking(move || authorize(&config, &trust).map(|_| ()))
                        .await
                        .unwrap_or(Err(Refusal::Failed))
                } else {
                    Err(Refusal::NotConsented)
                };
                let _ = done.send(verdict);
            }
            #[cfg(test)]
            Command::Barrier(done) => {
                let _ = done.send(());
            }
        }
    }
}
fn authorize(config: &std::path::Path, trust: &Trust) -> Result<Consent, Refusal> {
    if trust.account.is_none() {
        return Err(Refusal::NotConsented);
    }
    let stored = support_store::load(config, trust, support_log::now_unix_millis())?;
    let consent = stored.consent.ok_or(Refusal::NotConsented)?;
    if stored.server_off || !consent.enabled {
        return Err(Refusal::NotConsented);
    }
    Ok(consent)
}
struct Prepared {
    bundle: support_log::CompressedBundle,
    _flight: support_store::Flight,
}
fn prepare(ctx: &Context, request_id: Uuid, window: u64) -> Result<Prepared, Refusal> {
    let flight = support_store::begin(
        &ctx.path,
        &Receipt::new(request_id, window, Outcome::Started),
    )?;
    let log = ctx.source.as_ref().ok_or(Refusal::NoLog)?;
    let state = support_log::BundleState::read(&ctx.config).map_err(|_| Refusal::Failed)?;
    #[cfg(not(test))]
    let now = support_log::now_unix_millis().min(i64::MAX as u64);
    #[cfg(test)]
    let now = 1_000_000u64; // matches the fixture event, independent of scheduling

    let bundle = support_log::collect_bundle(
        log,
        &ctx.instance,
        now.saturating_sub(window * 1000) as i64,
        now as i64,
        state,
    )
    .map_err(|_| Refusal::Failed)?
    .ok_or(Refusal::NoLog)?;
    Ok(Prepared {
        bundle,
        _flight: flight,
    })
}
fn endpoint(origin: &str, request_id: Uuid) -> Result<url::Url, Refusal> {
    let base = url::Url::parse(origin).map_err(|_| Refusal::Failed)?;
    let allowed = base.scheme() == "https";
    #[cfg(test)]
    let allowed = allowed
        || (base.scheme() == "http"
            && match base.host() {
                Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
                Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
                _ => false,
            });
    if !allowed || !base.username().is_empty() || base.password().is_some() {
        return Err(Refusal::Failed);
    }
    let mut url = crate::config::api_url(&base, &format!("/api/support-log/uploads/{request_id}"))
        .map_err(|_| Refusal::Failed)?;
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}
// UPLOAD_BODY_BEGIN: reviewed body provenance markers, pinned by the guard.
fn guarded_body(
    body: Vec<u8>,
    stop: Stop,
) -> impl futures_util::Stream<Item = Result<Vec<u8>, std::io::Error>> + Send {
    futures_util::stream::unfold((body, 0, stop), |(body, offset, stop)| async move {
        if offset == usize::MAX {
            return None;
        }
        #[cfg(test)]
        stop.delivery.hooks.before_chunk.pause().await;
        if stop.stopped() {
            return Some((
                Err(std::io::Error::other("support collection cancelled")),
                (body, usize::MAX, stop),
            ));
        }
        if offset >= body.len() {
            return None;
        }
        let end = (offset + CHUNK).min(body.len());
        let chunk = body[offset..end].to_vec();
        Some((Ok(chunk), (body, end, stop)))
    })
}
// UPLOAD_BODY_END
#[allow(clippy::too_many_arguments)]
async fn collect(
    ctx: Arc<Context>,
    client: &reqwest::Client,
    origin: &str,
    request_id: Uuid,
    window: u64,
    deadline: tokio::time::Instant,
    stop: Stop,
    trust: Option<Arc<Trust>>,
    auth: Result<Consent, Refusal>,
) {
    let mut receipt = Receipt::new(request_id, window, Outcome::Failed);
    // Reserve time for the terminal audit within the same absolute deadline.
    let work = async {
        let url = endpoint(origin, request_id)?;
        let prepared = match auth {
            Ok(_) => {
                let work = Arc::clone(&ctx);
                tokio::task::spawn_blocking(move || prepare(&work, request_id, window))
                    .await
                    .unwrap_or(Err(Refusal::Failed))
            }
            Err(reason) => Err(reason),
        };
        let token = trust
            .as_ref()
            .and_then(|t| t.token.as_ref())
            .ok_or(Refusal::Failed)?;
        let mut request = client.post(url).bearer_auth(token.as_ref());
        let mut flight = None;
        match prepared {
            Ok(prepared) => {
                let (done, verdict) = tokio::sync::oneshot::channel();
                ctx.ready
                    .upgrade()
                    .ok_or(Refusal::Failed)?
                    .try_send(Command::Ready {
                        generation: stop.generation,
                        done,
                    })
                    .map_err(|_| Refusal::Failed)?;
                verdict.await.map_err(|_| Refusal::Failed)??;
                let support_log::CompressedBundle { header, body } = prepared.bundle;
                receipt.bytes = body.len();
                receipt.lines = header.lines;
                let digest: String = Sha256::digest(&body)
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect();
                request = request
                    .header(reqwest::header::CONTENT_TYPE, "application/gzip")
                    .header(reqwest::header::CONTENT_LENGTH, body.len())
                    .header("X-Spawn-Support-Log-Sha256", digest)
                    .header("X-Spawn-Support-Log-Lines", header.lines)
                    .header("X-Spawn-Support-Log-Raw-Bytes", header.bytes)
                    .header("X-Spawn-Support-Log-From", header.from.unwrap_or(0))
                    .header("X-Spawn-Support-Log-To", header.to.unwrap_or(0))
                    .header(
                        "X-Spawn-Support-Log-Truncated",
                        if header.truncated { "true" } else { "false" },
                    )
                    .body(reqwest::Body::wrap_stream(guarded_body(body, stop.clone())));
                flight = Some(prepared._flight);
                receipt.outcome = Outcome::Sent;
            }
            Err(reason) => {
                receipt.outcome = reason.into();
                let path = ctx.path.clone();
                let refusal = receipt.clone();
                tokio::task::spawn_blocking(move || support_store::append(&path, &refusal))
                    .await
                    .map_err(|_| Refusal::Failed)?
                    .map_err(|_| Refusal::Failed)?;
                request = request.json(&RefusalBody::from(reason));
            }
        }
        // The outer select drops this future even during DNS/connect/TLS. Body
        // polling independently fences every bounded chunk at the send boundary.
        #[cfg(test)]
        stop.delivery.hooks.before_send.pause().await;
        let result = request.send().await;
        if !matches!(result, Ok(response) if response.status().is_success()) {
            receipt.outcome = Outcome::UploadFailed;
        }
        drop(flight);
        Ok::<(), Refusal>(())
    };
    let result = tokio::select! { biased;
        _ = stop.changed() => None,
        result = tokio::time::timeout_at(deadline - AUDIT_RESERVE, work) => Some(result),
    };
    match result {
        None => receipt.outcome = Outcome::Cancelled,
        Some(Ok(Ok(()))) => {}
        _ => receipt.outcome = Outcome::Failed,
    }
    // A running filesystem call cannot be recalled, but it is never awaited
    // outside the collection deadline and cannot resume a cancelled upload.
    let path = ctx.path.clone();
    let _ = tokio::time::timeout_at(
        deadline,
        tokio::task::spawn_blocking(move || support_store::append(&path, &receipt)),
    )
    .await;
}

#[cfg(test)]
#[path = "support_tests.rs"]
pub(crate) mod tests;
