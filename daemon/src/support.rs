//! Background support collection. Dispatch only publishes trust snapshots and
//! enqueues bounded commands. No dispatch-owned lock is acquired by these jobs.
use crate::{
    creds::StoredCreds,
    support_log,
    support_store::{self, Outcome, Receipt},
};
use arc_swap::ArcSwap;
use serde::Serialize;
use sha2::{Digest, Sha256};
use spawnd::{endorsement_chain::RevocationSet, support_consent::Consent};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::sync::{mpsc, Semaphore};
use uuid::Uuid;

const DEADLINE: Duration = Duration::from_secs(30);
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Refusal {
    NotConsented,
    SignerUntrusted,
    RateLimited,
    NoLog,
    Failed,
}

#[derive(Clone)]
pub(crate) struct Trust {
    pub record: StoredCreds,
    pub account: Option<[u8; 16]>,
    pub revoked: RevocationSet,
}
impl Trust {
    pub(crate) fn verify(&self, consent: &Consent, now: u64) -> Result<(), Refusal> {
        let account = self.account.as_ref().ok_or(Refusal::SignerUntrusted)?;
        let signer = consent
            .verify(account, now)
            .map_err(|_| Refusal::NotConsented)?;
        if !crate::run::admitted_device(
            &signer,
            &self.record,
            Some(account),
            &self.revoked,
            &consent.carried_endorsements,
        ) {
            return Err(Refusal::SignerUntrusted);
        }
        Ok(())
    }
}
struct Context {
    config: PathBuf,
    trust: ArcSwap<Trust>,
    path: PathBuf,
    source: Option<support_log::SupportLog>,
    instance: String,
    epoch: AtomicU64,
    denied: AtomicBool,
}
pub(crate) struct Collector {
    tx: mpsc::Sender<Command>,
    context: Arc<Context>,
}
enum Command {
    Trust {
        value: Box<Trust>,
        live_devices: Option<Vec<String>>,
        epoch: u64,
    },
    Consent {
        value: Option<Consent>,
        epoch: u64,
    },
    Collect {
        request_id: Uuid,
        window: u64,
        deadline: tokio::time::Instant,
    },
}
impl Collector {
    pub(crate) fn start(config: PathBuf, trust: Trust, origin: String) -> anyhow::Result<Self> {
        let path = support_log::support_dir(&config)?;
        let source = support_log::active_for(&path);
        let instance = crate::service::instance_name(&config);
        Ok(Self::start_at(
            config, path, source, instance, trust, origin,
        ))
    }
    fn start_at(
        config: PathBuf,
        path: PathBuf,
        source: Option<support_log::SupportLog>,
        instance: String,
        trust: Trust,
        origin: String,
    ) -> Self {
        let context = Arc::new(Context {
            config,
            path,
            source,
            instance,
            trust: ArcSwap::from_pointee(trust),
            epoch: AtomicU64::new(0),
            denied: AtomicBool::new(false),
        });
        let (tx, rx) = mpsc::channel(32);
        tokio::spawn(serve(Arc::clone(&context), rx, origin));
        Self { tx, context }
    }
    pub(crate) fn trust(
        &self,
        trust: Trust,
        live_devices: Option<Vec<String>>,
    ) -> anyhow::Result<()> {
        self.context.denied.store(true, Ordering::SeqCst);
        let epoch = self.context.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        self.tx
            .try_send(Command::Trust {
                value: Box::new(trust),
                live_devices,
                epoch,
            })
            .map_err(|_| anyhow::anyhow!("support queue full or closed"))
    }
    pub(crate) fn consent(&self, value: Option<Consent>) -> anyhow::Result<()> {
        // Fail closed immediately, including when a saturated queue cannot
        // carry a turn-off. Only the latest successfully persisted apply clears.
        self.context.denied.store(true, Ordering::SeqCst);
        let epoch = self.context.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        self.tx
            .try_send(Command::Consent { value, epoch })
            .map_err(|_| anyhow::anyhow!("support queue full or closed"))
    }
    pub(crate) fn collect(&self, request_id: Uuid, since_seconds: i64) -> anyhow::Result<()> {
        self.tx
            .try_send(Command::Collect {
                request_id,
                window: since_seconds.clamp(60, 259200) as u64,
                deadline: tokio::time::Instant::now() + DEADLINE,
            })
            .map_err(|_| anyhow::anyhow!("support queue full or closed"))
    }
}
impl Drop for Collector {
    fn drop(&mut self) {
        self.context.denied.store(true, Ordering::SeqCst);
        self.context.epoch.fetch_add(1, Ordering::SeqCst);
    }
}
async fn serve(context: Arc<Context>, mut rx: mpsc::Receiver<Command>, origin: String) {
    // Same reqwest/rustls HTTP stack as daemon login/update. Redirects are
    // disabled: even this daemon's own server cannot choose another recipient.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build();
    let Ok(client) = client else {
        return;
    };
    let responses = Arc::new(Semaphore::new(4));
    while let Some(command) = rx.recv().await {
        match command {
            Command::Trust {
                mut value,
                live_devices,
                epoch,
            } => {
                let ctx = Arc::clone(&context);
                let applied = tokio::task::spawn_blocking(move || {
                    // Reconciliation may not have reached the credential poller
                    // yet. Missing direct pins are immediate deny-only input.
                    if let Some(live) = live_devices {
                        let live: std::collections::HashSet<_> = live
                            .iter()
                            .filter_map(|id| Uuid::parse_str(id).ok())
                            .collect();
                        for pin in value.record.browser_pins() {
                            if !live.contains(&pin.device_id()) {
                                if let Ok(key) =
                                    spawnd::signed_signal::public_key_from_wire(pin.public_key())
                                {
                                    value.revoked.insert(key.to_bytes());
                                }
                            }
                        }
                    }
                    support_store::remember_revocations(&ctx.config, &value)?;
                    ctx.trust.store(Arc::from(value));
                    anyhow::Ok(())
                })
                .await;
                if matches!(applied, Ok(Ok(()))) && context.epoch.load(Ordering::SeqCst) == epoch {
                    context.denied.store(false, Ordering::SeqCst);
                }
            }
            Command::Consent { value, epoch } => {
                let ctx = Arc::clone(&context);
                let applied = tokio::task::spawn_blocking(move || {
                    support_store::apply(
                        &ctx.config,
                        value,
                        &ctx.trust.load(),
                        support_log::now_unix_millis(),
                    )
                })
                .await;
                if matches!(applied, Ok(Ok(()))) && context.epoch.load(Ordering::SeqCst) == epoch {
                    context.denied.store(false, Ordering::SeqCst);
                }
            }
            Command::Collect {
                request_id,
                window,
                deadline,
            } => {
                let Ok(permit) = Arc::clone(&responses).acquire_owned().await else {
                    break;
                };
                let ctx = Arc::clone(&context);
                let client = client.clone();
                let origin = origin.clone();
                // The upload has its own absolute deadline, including time in
                // the bounded queue. Nothing awaits it on the dispatch loop.
                tokio::spawn(async move {
                    let _permit = permit;
                    let result = tokio::time::timeout_at(
                        deadline,
                        collect(Arc::clone(&ctx), &client, &origin, request_id, window),
                    )
                    .await;
                    if !matches!(result, Ok(Ok(()))) {
                        let _ = tokio::task::spawn_blocking(move || {
                            support_store::append(
                                &ctx.path,
                                &Receipt::new(request_id, window, Outcome::Failed),
                            )
                        })
                        .await;
                    }
                });
            }
        }
    }
}

fn authorize(ctx: &Context) -> Result<Consent, Refusal> {
    if ctx.denied.load(Ordering::SeqCst) {
        return Err(Refusal::NotConsented);
    }
    let trust = ctx.trust.load_full();
    let stored = support_store::load(&ctx.config, &trust, support_log::now_unix_millis())?;
    let consent = stored.consent.ok_or(Refusal::NotConsented)?;
    if stored.server_off || !consent.enabled {
        return Err(Refusal::NotConsented);
    }
    Ok(consent)
}
struct Prepared {
    bundle: support_log::CompressedBundle,
    consent: Consent,
    epoch: u64,
    _flight: support_store::Flight,
}
fn prepare(ctx: &Context, request_id: Uuid, window: u64) -> Result<Prepared, Refusal> {
    let epoch = ctx.epoch.load(Ordering::SeqCst);
    let consent = authorize(ctx)?;
    let path = &ctx.path;
    let receipt = Receipt::new(request_id, window, Outcome::Started);
    let flight = support_store::begin(path, &receipt)?;
    let log = ctx.source.as_ref().ok_or(Refusal::NoLog)?;
    let state = support_log::BundleState::read(&ctx.config).map_err(|_| Refusal::Failed)?;
    let now = support_log::now_unix_millis().min(i64::MAX as u64);
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
        consent,
        epoch,
        _flight: flight,
    })
}
fn endpoint(origin: &str, request_id: Uuid) -> Result<url::Url, Refusal> {
    let mut url = url::Url::parse(origin).map_err(|_| Refusal::Failed)?;
    let allowed = url.scheme() == "https";
    #[cfg(test)]
    let allowed = allowed
        || (url.scheme() == "http"
            && match url.host() {
                Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
                Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
                _ => false,
            });
    if !allowed || !url.username().is_empty() || url.password().is_some() {
        return Err(Refusal::Failed);
    }
    url.set_path(&format!("/api/support-log/uploads/{request_id}"));
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

async fn collect(
    ctx: Arc<Context>,
    client: &reqwest::Client,
    origin: &str,
    request_id: Uuid,
    window: u64,
) -> anyhow::Result<()> {
    // A UUID is already typed at deserialization; no server-supplied path or
    // URL ever participates in constructing the destination.
    let url =
        endpoint(origin, request_id).map_err(|_| anyhow::anyhow!("invalid support destination"))?;
    let work = Arc::clone(&ctx);
    let prepared = tokio::task::spawn_blocking(move || prepare(&work, request_id, window)).await?;
    let mut prepared = match prepared {
        Ok(prepared) => {
            let work = Arc::clone(&ctx);
            // Recheck the stored statement and latest trust after snapshot work.
            // No file, crypto work, or dispatch-owned mutex on an async worker.
            tokio::task::spawn_blocking(move || {
                let current = authorize(&work)?;
                if work.epoch.load(Ordering::SeqCst) != prepared.epoch
                    || !current.same_statement(&prepared.consent)
                {
                    return Err(Refusal::NotConsented);
                }
                Ok(prepared)
            })
            .await?
        }
        Err(reason) => Err(reason),
    };
    if prepared.as_ref().is_ok_and(|p| {
        p.epoch != ctx.epoch.load(Ordering::SeqCst) || ctx.denied.load(Ordering::SeqCst)
    }) {
        prepared = Err(Refusal::NotConsented);
    }
    let token = ctx
        .trust
        .load()
        .record
        .access_token
        .clone()
        .ok_or_else(|| anyhow::anyhow!("no daemon token"))?;
    let mut request = client.post(url).bearer_auth(token);
    let mut receipt = Receipt::new(request_id, window, Outcome::Sent);
    let mut flight = None;
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
            flight = Some(prepared._flight);
        }
        Err(reason) => {
            receipt.outcome = reason.into();
            let work = Arc::clone(&ctx);
            let refusal = receipt.clone();
            tokio::task::spawn_blocking(move || support_store::append(&work.path, &refusal))
                .await??;
            request = request.json(&serde_json::json!({"declined": reason}));
        }
    }
    // Exactly one upload call site, used for gzip and fixed JSON refusals.
    let result = request
        .send()
        .await
        .and_then(reqwest::Response::error_for_status);
    if let Some(flight) = flight {
        if result.is_err() {
            receipt.outcome = Outcome::UploadFailed;
        }
        tokio::task::spawn_blocking(move || {
            let _flight = flight;
            support_store::append(&_flight.path, &receipt)
        })
        .await??;
    }
    // A transport failure is already recorded; there is no retry.
    Ok(())
}

#[cfg(test)]
#[path = "support_tests.rs"]
pub(crate) mod tests;
