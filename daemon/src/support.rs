//! One process owner for support consent, admission, and cancellation. Dispatch
//! delivers bounded commands; it never waits for storage, crypto, or a response.
use crate::support_io::{Worker, IO_DEADLINE};
use crate::{
    creds::{BrowserPin, StoredCreds},
    support_log,
    support_store::{self, Outcome, Receipt},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use spawnd::support_consent::Consent;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock, Weak,
    },
    time::Duration,
};
use tokio::sync::{mpsc, Notify};
use uuid::Uuid;

const DEADLINE: Duration = Duration::from_secs(30);
const AUDIT_RESERVE: Duration = Duration::from_secs(2);
const QUEUE: usize = 32;
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
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Trust {
    pub pins: Arc<[BrowserPin]>,
    pub account: Option<[u8; 16]>,
    pub revoked: support_store::Revocations,
    pub token: Option<Arc<str>>,
}
impl Trust {
    pub(crate) fn from_record(record: &StoredCreds) -> Self {
        Self {
            pins: record.browser_pins().into(),
            account: record
                .proven_account_id()
                .and_then(|id| spawnd::host_pair_approval::account_id_bytes(&id).ok()),
            revoked: support_store::Revocations::default(),
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
            &self.revoked.admission_set(),
            &consent.carried_endorsements,
            Some(device),
        ) {
            return Err(Refusal::SignerUntrusted);
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Denied {
    Storage,
    Lock,
    Deadline,
    WorkerStopped,
    WriteBudget,
    Revocations,
    DeliveryOverflow,
    InvalidUpdate,
    GenerationExhausted,
}
impl Denied {
    pub(crate) fn reason(self) -> &'static str {
        match self {
            Self::Storage => "support storage update failed",
            Self::Lock => "support storage lock wait expired",
            Self::Deadline => "support storage job deadline passed",
            Self::WorkerStopped => "support storage worker stopped",
            Self::WriteBudget => "more than 30 sharing changes in ten minutes",
            Self::Revocations => "more than 256 removed devices",
            Self::DeliveryOverflow => "support input delivery overflow",
            Self::InvalidUpdate => "invalid support update",
            Self::GenerationExhausted => "support generation exhausted",
        }
    }
    fn storage(error: anyhow::Error) -> Self {
        if error.is::<support_store::ControlOverflow>() {
            Self::WriteBudget
        } else if error.is::<support_store::RevocationOverflow>() {
            Self::Revocations
        } else if error.is::<support_store::LockExpired>() {
            Self::Lock
        } else {
            Self::Storage
        }
    }
}
impl From<crate::support_io::Error> for Denied {
    fn from(value: crate::support_io::Error) -> Self {
        match value {
            crate::support_io::Error::Deadline => Self::Deadline,
            crate::support_io::Error::Stopped => Self::WorkerStopped,
        }
    }
}
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct RuntimeStatus {
    pub denied: Option<Denied>,
    pub dropped_requests: u64,
}
static ACTIVE: OnceLock<Weak<Delivery>> = OnceLock::new();
pub(crate) fn runtime_status() -> Option<RuntimeStatus> {
    ACTIVE.get()?.upgrade().map(|d| d.status())
}
struct Delivery {
    // Low bit: request started. Remaining bits: delivery generation.
    word: AtomicU64,
    denied: OnceLock<Denied>,
    dropped: AtomicU64,
    changed: Notify,
    #[cfg(test)]
    hooks: tests::Hooks,
}
impl Delivery {
    fn new() -> Self {
        Self {
            word: AtomicU64::new(0),
            denied: OnceLock::new(),
            dropped: AtomicU64::new(0),
            changed: Notify::new(),
            #[cfg(test)]
            hooks: tests::Hooks::default(),
        }
    }
    fn generation(&self) -> u64 {
        self.word.load(Ordering::SeqCst) & !1
    }
    fn advance(&self) {
        let mut old = self.word.load(Ordering::SeqCst);
        loop {
            // All ones is a terminal exhausted word. Even at exhaustion,
            // delivery atomically makes a not-started claim impossible.
            let next = (old & !1).saturating_add(2);
            match self
                .word
                .compare_exchange_weak(old, next, Ordering::SeqCst, Ordering::SeqCst)
            {
                Ok(_) => {
                    if next == u64::MAX {
                        self.deny(Denied::GenerationExhausted);
                    } else {
                        self.changed.notify_one();
                    }
                    return;
                }
                Err(current) => old = current,
            }
        }
    }
    fn deny(&self, reason: Denied) {
        let _ = self.denied.set(reason);
        self.changed.notify_one();
    }
    fn status(&self) -> RuntimeStatus {
        RuntimeStatus {
            denied: self.denied.get().copied(),
            dropped_requests: self.dropped.load(Ordering::Relaxed),
        }
    }
}
struct Stop {
    delivery: Arc<Delivery>,
    generation: u64,
}
impl Stop {
    fn stopped(&self) -> bool {
        self.delivery.denied.get().is_some() || self.delivery.generation() != self.generation
    }
    fn claim_start(&self) -> bool {
        // Request start is this single atomic transition from (generation, 0)
        // to (generation, 1). Delivery before it prevents creating/polling send;
        // delivery after it abandons the request best-effort (P2).
        !self.stopped()
            && self
                .delivery
                .word
                .compare_exchange(
                    self.generation,
                    self.generation | 1,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                )
                .is_ok()
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
    io: Arc<Worker>,
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
    gate: Mutex<()>,
}
enum Input {
    Trust {
        value: Arc<Trust>,
        live: Option<Arc<Vec<String>>>,
        revoked: Option<Arc<Vec<String>>>,
    },
    #[cfg(test)]
    Consent(Option<Consent>),
    Update(Arc<crate::proto::SupportUpdate>),
    Fence,
    Shutdown,
}
enum Command {
    Input(Input),
    Collect {
        request_id: Uuid,
        window: u64,
        deadline: tokio::time::Instant,
        generation: u64,
        #[cfg(test)]
        done: Option<tokio::sync::oneshot::Sender<()>>,
    },
    #[cfg(test)]
    Barrier(tokio::sync::oneshot::Sender<()>),
}
pub(crate) struct Fence<'a> {
    collector: Option<&'a Collector>,
}
impl<'a> Fence<'a> {
    pub(crate) fn connection(collector: Option<&'a Collector>) -> Self {
        Self { collector }
    }
}
impl Drop for Fence<'_> {
    fn drop(&mut self) {
        if let Some(c) = self.collector {
            c.deliver(Input::Fence);
        }
    }
}
impl Collector {
    pub(crate) fn start(config: PathBuf, origin: String) -> Option<Self> {
        // Resolve paths only; the actor performs preparation as its first job.
        // Its existing delivery queue preserves inputs arriving before readiness.
        let path = support_log::support_dir(&config).ok()?;
        let source = support_log::active_for(&path);
        let instance = crate::service::instance_name(&config);
        Self::start_ready(config, path, source, instance, origin, Worker::process()?)
    }
    #[cfg(test)]
    async fn start_at(
        config: PathBuf,
        path: PathBuf,
        source: Option<support_log::SupportLog>,
        instance: String,
        origin: String,
    ) -> Option<Self> {
        Self::start_ready(config, path, source, instance, origin, Worker::start()?)
    }
    fn start_ready(
        config: PathBuf,
        path: PathBuf,
        source: Option<support_log::SupportLog>,
        instance: String,
        origin: String,
        io: Arc<Worker>,
    ) -> Option<Self> {
        let builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15));
        #[cfg(test)]
        let builder = builder.no_proxy();
        let client = builder.build().ok()?;
        let delivery = Arc::new(Delivery::new());
        let (tx, rx) = mpsc::channel(QUEUE);
        let context = Arc::new(Context {
            io,
            config,
            path,
            source,
            instance,
        });
        tokio::spawn(serve(context, Arc::clone(&delivery), rx, client, origin));
        Some(Self {
            tx,
            delivery,
            gate: Mutex::new(()),
        })
    }
    fn deliver(&self, input: Input) {
        // One short, nonwaiting delivery gate orders generation and enqueue even
        // if future callers use different tasks. Contention can only deny.
        let guard = self.gate.try_lock();
        self.delivery.advance();
        if guard.is_err() || self.tx.try_send(Command::Input(input)).is_err() {
            self.delivery.deny(Denied::DeliveryOverflow);
        }
    }
    pub(crate) fn trust(
        &self,
        value: Arc<Trust>,
        live: Option<Arc<Vec<String>>>,
        revoked: Option<Arc<Vec<String>>>,
    ) {
        self.deliver(Input::Trust {
            value,
            live,
            revoked,
        });
    }
    pub(crate) fn update(&self, update: &Arc<crate::proto::SupportUpdate>) {
        // Clone the parsed payload, advance the generation, try the queue and
        // notify the actor. No support filesystem or cryptographic work here.
        self.deliver(Input::Update(Arc::clone(update)));
    }
    #[cfg(test)]
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
        let Ok(_gate) = self.gate.try_lock() else {
            self.delivery.advance();
            self.delivery.deny(Denied::DeliveryOverflow);
            return;
        };
        if self.delivery.denied.get().is_some() {
            self.delivery.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        if self
            .tx
            .try_send(Command::Collect {
                request_id,
                window: since_seconds.clamp(60, 259200) as u64,
                deadline: tokio::time::Instant::now() + DEADLINE,
                generation: self.delivery.generation(),
                #[cfg(test)]
                done,
            })
            .is_err()
        {
            self.delivery.advance();
            self.delivery.deny(Denied::DeliveryOverflow);
        }
    }
}
impl Drop for Collector {
    fn drop(&mut self) {
        self.deliver(Input::Shutdown);
    }
}

async fn apply(
    ctx: &Arc<Context>,
    delivery: &Arc<Delivery>,
    input: Input,
    trust: &mut Option<Arc<Trust>>,
) -> Result<(), Denied> {
    use crate::proto::ConsentInput;
    let (base, live, revoked, consent) = match input {
        Input::Trust {
            value,
            live,
            revoked,
        } => (Some(value), live, revoked, ConsentInput::Absent),
        Input::Update(update) => (
            trust.clone(),
            update.browser_device_ids.clone().map(Arc::new),
            update.revoked_browser_keys.clone().map(Arc::new),
            update.consent.clone(),
        ),
        #[cfg(test)]
        Input::Consent(value) => (
            trust.clone(),
            None,
            None,
            value.map_or(ConsentInput::Null, ConsentInput::Valid),
        ),
        Input::Fence | Input::Shutdown => return Ok(()),
    };
    let Some(base) = base else {
        return Err(Denied::InvalidUpdate);
    };
    let mut next = (*base).clone();
    if let Some(previous) = trust.as_ref() {
        next.revoked
            .absorb(previous.revoked.clone())
            .map_err(Denied::storage)?;
    }
    if let Some(revoked) = revoked {
        for key in revoked.iter() {
            if let Ok(key) = spawnd::signed_signal::public_key_from_wire(key) {
                next.revoked
                    .insert(key.to_bytes())
                    .map_err(Denied::storage)?;
            }
        }
    }
    if let Some(live) = live {
        for pin in next.pins.iter() {
            if !live
                .iter()
                .any(|id| Uuid::parse_str(id).ok() == Some(pin.device_id()))
            {
                if let Ok(key) = spawnd::signed_signal::public_key_from_wire(pin.public_key()) {
                    next.revoked
                        .insert(key.to_bytes())
                        .map_err(Denied::storage)?;
                }
            }
        }
    }
    // Retain received trust BEFORE attempting any write. Any error is terminal;
    // there is no later path which can authorize using an older projection.
    let next = Arc::new(next);
    *trust = Some(Arc::clone(&next));
    if matches!(consent, ConsentInput::Invalid) {
        return Err(Denied::InvalidUpdate);
    }
    let config = ctx.config.clone();
    #[cfg(test)]
    let delivery = Arc::clone(delivery);
    #[cfg(not(test))]
    let _ = delivery;
    let revoked = ctx
        .io
        .run_with(tokio::time::Instant::now() + IO_DEADLINE, move |owned| {
            #[cfg(test)]
            {
                delivery.hooks.apply.pause();
                assert!(
                    !delivery.hooks.panic.swap(false, Ordering::SeqCst),
                    "injected support worker panic"
                );
            }
            let revoked = support_store::remember_revocations(&config, &next)?;
            if next.account.is_some() {
                let incoming = match consent {
                    ConsentInput::Null => Some(None),
                    ConsentInput::Valid(value) => Some(Some(value)),
                    _ => None,
                };
                if let Some(incoming) = incoming {
                    support_store::apply_budgeted(
                        &config,
                        incoming,
                        &next,
                        support_log::now_unix_millis(),
                        &mut owned.control_budget,
                    )?;
                }
            }
            Ok::<_, anyhow::Error>(revoked)
        })
        .await
        .map_err(Denied::from)?
        .map_err(Denied::storage)?;
    Arc::make_mut(trust.as_mut().expect("retained trust")).revoked = revoked;
    Ok(())
}
async fn serve(
    ctx: Arc<Context>,
    delivery: Arc<Delivery>,
    mut rx: mpsc::Receiver<Command>,
    client: reqwest::Client,
    origin: String,
) {
    let path = ctx.path.clone();
    #[cfg(test)]
    let starting = Arc::clone(&delivery);
    let startup = ctx
        .io
        .run(tokio::time::Instant::now() + IO_DEADLINE, move || {
            #[cfg(test)]
            starting.hooks.initialize.pause();
            let result = crate::platform::open_support_dir(&path, true).map(|_| ());
            #[cfg(test)]
            starting.hooks.initialized.notify_one();
            result
        })
        .await
        .map_err(Denied::from)
        .and_then(|r| r.map_err(|_| Denied::Storage));
    if let Err(reason) = startup {
        delivery.deny(reason);
    }
    #[cfg(not(test))]
    let _ = ACTIVE.set(Arc::downgrade(&delivery));
    let mut trust = None;
    let mut active = false;
    let mut erased = false;
    let mut budget = Budget {
        next: tokio::time::Instant::now(),
    };
    loop {
        if delivery.denied.get().is_some() && !erased {
            erased = true;
            let config = ctx.config.clone();
            // Exactly one best-effort removal. A dead or unfinished worker may
            // prevent it; nothing is submitted behind an unfinished job.
            let _ = ctx
                .io
                .run(tokio::time::Instant::now() + IO_DEADLINE, move || {
                    support_store::erase_statement(&config)
                })
                .await;
        }
        let receive = async {
            #[cfg(not(test))]
            {
                rx.recv().await
            }
            #[cfg(test)]
            {
                tokio::time::timeout(Duration::from_secs(30), rx.recv())
                    .await
                    .expect("support actor input wait exceeded test deadline")
            }
        };
        let command = tokio::select! { biased;
            _ = delivery.changed.notified() => continue,
            command = receive => match command { Some(command) => command, None => break },
        };
        #[cfg(test)]
        if let Command::Barrier(done) = command {
            let _ = done.send(());
            continue;
        }
        if delivery.denied.get().is_some() {
            continue;
        }
        match command {
            Command::Input(input) => {
                let shutdown = matches!(input, Input::Shutdown);
                match &input {
                    Input::Trust { .. } => active = true,
                    Input::Fence | Input::Shutdown => active = false,
                    _ => {}
                }
                if let Err(reason) = apply(&ctx, &delivery, input, &mut trust).await {
                    delivery.deny(reason);
                }
                #[cfg(test)]
                delivery.hooks.after_apply.pause().await;
                if shutdown {
                    break;
                }
            }
            Command::Collect {
                request_id,
                window,
                deadline,
                generation,
                #[cfg(test)]
                done,
            } => {
                let stop = Stop {
                    delivery: Arc::clone(&delivery),
                    generation,
                };
                if !budget.admit(tokio::time::Instant::now()) || stop.stopped() {
                    delivery.dropped.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
                let auth = if active {
                    Ok(())
                } else {
                    Err(Refusal::NotConsented)
                };
                if let Err(reason) = collect(
                    Arc::clone(&ctx),
                    &client,
                    &origin,
                    request_id,
                    window,
                    deadline,
                    &stop,
                    trust.clone(),
                    auth,
                )
                .await
                {
                    delivery.deny(reason);
                }
                let _ = delivery.word.compare_exchange(
                    generation | 1,
                    generation,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                );
                #[cfg(test)]
                if let Some(done) = done {
                    let _ = done.send(());
                }
            }
            #[cfg(test)]
            Command::Barrier(_) => unreachable!(),
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
}
fn prepare(
    ctx: &Context,
    request_id: Uuid,
    window: u64,
    deadline: tokio::time::Instant,
    owned: &mut crate::support_io::State,
) -> Result<Prepared, Refusal> {
    if owned.flight.is_some() {
        return Err(Refusal::RateLimited);
    }
    let flight = support_store::begin(
        &ctx.path,
        &Receipt::new(request_id, window, Outcome::Started),
    )?;
    owned.flight = Some((deadline, flight));
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
    Ok(Prepared { bundle })
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
#[allow(clippy::too_many_arguments)]
async fn collect(
    ctx: Arc<Context>,
    client: &reqwest::Client,
    origin: &str,
    request_id: Uuid,
    window: u64,
    deadline: tokio::time::Instant,
    stop: &Stop,
    trust: Option<Arc<Trust>>,
    auth: Result<(), Refusal>,
) -> Result<(), Denied> {
    let mut receipt = Receipt::new(request_id, window, Outcome::Failed);
    let work_deadline = deadline - AUDIT_RESERVE;
    let work = async {
        let url = match endpoint(origin, request_id) {
            Ok(url) => url,
            Err(_) => return Ok(()),
        };
        let prepared = match (auth, trust.clone()) {
            (Ok(()), Some(current)) => {
                let work = Arc::clone(&ctx);
                #[cfg(test)]
                let delivery = Arc::clone(&stop.delivery);
                ctx.io
                    .run_with(
                        (tokio::time::Instant::now() + IO_DEADLINE).min(work_deadline),
                        move |owned| {
                            #[cfg(test)]
                            delivery.hooks.prepare.pause();
                            authorize(&work.config, &current)?;
                            prepare(&work, request_id, window, deadline, owned)
                        },
                    )
                    .await
                    .map_err(Denied::from)?
            }
            (Err(reason), _) => Err(reason),
            _ => Err(Refusal::NotConsented),
        };
        if stop.stopped() {
            receipt.outcome = Outcome::Cancelled;
            return Ok(());
        }
        let token = trust
            .as_ref()
            .and_then(|t| t.token.as_ref())
            .ok_or(Denied::InvalidUpdate)?;
        let mut request = client.post(url).bearer_auth(token.as_ref());
        let mut sending_bundle = false;
        match prepared {
            Ok(prepared) => {
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
                    .body(body);
                sending_bundle = true;
                receipt.outcome = Outcome::Sent;
            }
            Err(reason) => {
                receipt.outcome = reason.into();
                let path = ctx.path.clone();
                let refusal = receipt.clone();
                ctx.io
                    .run(
                        (tokio::time::Instant::now() + IO_DEADLINE).min(deadline - AUDIT_RESERVE),
                        move || support_store::append(&path, &refusal),
                    )
                    .await
                    .map_err(Denied::from)?
                    .map_err(Denied::storage)?;
                request = request.json(&RefusalBody::from(reason));
            }
        }
        #[cfg(test)]
        stop.delivery.hooks.before_send.pause().await;
        if sending_bundle {
            let config = ctx.config.clone();
            let current = trust.clone().ok_or(Denied::InvalidUpdate)?;
            // Final disk authorization, after all body/header preparation.
            let authorized = ctx
                .io
                .run(
                    (tokio::time::Instant::now() + IO_DEADLINE).min(work_deadline),
                    move || authorize(&config, &current),
                )
                .await
                .map_err(Denied::from)?;
            if authorized.is_err() {
                receipt.outcome = Outcome::Cancelled;
                return Ok(());
            }
        }
        #[cfg(test)]
        stop.delivery.hooks.before_claim.pause().await;
        if tokio::time::Instant::now() >= work_deadline {
            receipt.outcome = Outcome::Failed;
            return Ok(());
        }
        if !stop.claim_start() {
            receipt.outcome = Outcome::Cancelled;
            return Ok(());
        }
        // No await between the atomic start claim and creation/polling of send.
        receipt.outcome = tokio::select! { biased;
            _ = stop.changed() => Outcome::Cancelled,
            response = tokio::time::timeout_at(work_deadline, request.send()) => match response {
                Ok(Ok(response)) if response.status().is_success() => receipt.outcome,
                Ok(_) => Outcome::UploadFailed,
                Err(_) => Outcome::Cancelled,
            },
        };
        Ok::<(), Denied>(())
    }
    .await;
    if work.is_err() {
        receipt.outcome = Outcome::Failed;
    }
    // Never cancel a healthy filesystem job. Even a delivered off waits for
    // preparation to complete, then this receipt, before the actor applies it.
    let path = ctx.path.clone();
    #[cfg(test)]
    let delivery = Arc::clone(&stop.delivery);
    let audit = ctx
        .io
        .run_with(deadline, move |owned| {
            #[cfg(test)]
            delivery.hooks.audit.pause();
            owned.flight = None;
            support_store::append(&path, &receipt)
        })
        .await
        .map_err(Denied::from)
        .and_then(|r| r.map_err(Denied::storage));
    work.and(audit)
}

#[cfg(test)]
#[path = "support_tests.rs"]
pub(crate) mod tests;
