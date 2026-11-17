//! Private consent and bounded append-only collection receipts. These files
//! never supply upload bytes. All calls are blocking work, outside dispatch.
use crate::support::{Refusal, Trust};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use spawnd::{secret_file::SecretFile, support_consent::Consent};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

const CONSENT: SecretFile =
    SecretFile::new("SPAWN D support sharing", ".support-consent.", 64 * 1024);
const CONSENT_NAME: &str = "support-log-consent.json";
const CONSENT_LOCK: &str = "support-log-consent.lock";
const SENT: &str = "sent.jsonl";
const SENT_PREVIOUS: &str = "sent.jsonl.1";
const SENT_LOCK: &str = "sent.lock";
const FLIGHT_LOCK: &str = "collection.lock";
const MAX_RECEIPT_FILE: u64 = 128 * 1024;

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Stored {
    pub consent: Option<Consent>,
    pub server_off: bool,
    #[serde(default)]
    revoked: spawnd::endorsement_chain::RevocationSet,
}
fn read(config: &Path) -> Result<Stored> {
    CONSENT
        .read(&config.join(CONSENT_NAME))?
        .map(|raw| serde_json::from_slice(&raw).context("invalid support sharing record"))
        .unwrap_or_else(|| Ok(Stored::default()))
}
fn write(config: &Path, stored: &Stored) -> Result<()> {
    let bytes = serde_json::to_vec(stored)?;
    anyhow::ensure!(
        bytes.len() <= CONSENT.max_bytes(),
        "oversized sharing record"
    );
    CONSENT.write(&config.join(CONSENT_NAME), &bytes)?;
    Ok(())
}
/// Reverify both the signature and the current admission rule on every load.
pub(crate) fn load(config: &Path, trust: &Trust, now: u64) -> Result<Stored, Refusal> {
    let stored = read(config).map_err(|_| Refusal::Failed)?;
    let mut trust = trust.clone();
    trust.revoked.absorb(stored.revoked.clone());
    if let Some(consent) = &stored.consent {
        trust.verify(consent, now)?;
    }
    Ok(stored)
}
pub(crate) fn apply(
    config: &Path,
    incoming: Option<Consent>,
    trust: &Trust,
    now: u64,
) -> Result<()> {
    let _lock = CONSENT.try_lock_file(&config.join(CONSENT_LOCK))?;
    let mut stored = read(config)?;
    stored.revoked.absorb(trust.revoked.clone());
    let mut trust = trust.clone();
    trust.revoked.absorb(stored.revoked.clone());
    if let Some(consent) = incoming {
        trust
            .verify(&consent, now)
            .map_err(|_| anyhow::anyhow!("untrusted sharing statement"))?;
        if let Some(old) = &stored.consent {
            // The old signer's removal does not erase the newest-wins floor.
            let account = trust.account.context("unknown account")?;
            old.verify(&account, now)?;
            if consent.issued_at_ms < old.issued_at_ms
                || (consent.issued_at_ms == old.issued_at_ms && !consent.same_statement(old))
            {
                return Ok(());
            }
        }
        stored.consent = Some(consent);
        stored.server_off = false;
    } else {
        stored.server_off = true;
    }
    write(config, &stored)?;
    Ok(())
}
pub(crate) fn remember_revocations(config: &Path, trust: &Trust) -> Result<()> {
    let _lock = CONSENT.try_lock_file(&config.join(CONSENT_LOCK))?;
    let mut stored = read(config)?;
    if stored.revoked.absorb(trust.revoked.clone()) {
        write(config, &stored)?;
    }
    Ok(())
}

#[derive(Debug, Default, Serialize)]
pub(crate) struct SharingStatus {
    pub enabled: bool,
    pub signer_device_id: Option<Uuid>,
    pub issued_at_ms: Option<u64>,
    pub server_off: bool,
    pub recent: Vec<Receipt>,
}
pub(crate) fn status(config: &Path, trust: &Trust, path: &Path) -> SharingStatus {
    let mut status = SharingStatus::default();
    // Even an untrusted or damaged proof cannot hide the server's off flag.
    let mut trust = trust.clone();
    if let Ok(stored) = read(config) {
        status.server_off = stored.server_off;
        // Legacy pins can lack the retained pairing proof. For presentation
        // only, recover the account from the previously accepted statement;
        // load still verifies its signature and current device admission.
        if trust.account.is_none() {
            trust.account = stored
                .consent
                .as_ref()
                .and_then(|c| spawnd::host_pair_approval::account_id_bytes(&c.account_id).ok());
        }
    }
    if let Ok(stored) = load(config, &trust, crate::support_log::now_unix_millis()) {
        if let Some(consent) = stored.consent {
            status.enabled = consent.enabled && !stored.server_off;
            status.signer_device_id = Uuid::parse_str(&consent.signer_device_id).ok();
            status.issued_at_ms = Some(consent.issued_at_ms);
        }
    }
    status.recent = recent(path).unwrap_or_default();
    status
}

pub(crate) fn remove(config: &Path) -> Result<()> {
    let _lock = CONSENT.try_lock_file(&config.join(CONSENT_LOCK))?;
    match std::fs::remove_file(config.join(CONSENT_NAME)) {
        Ok(()) => spawnd::secret_file::sync_parent_directory(config).map_err(Into::into),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Outcome {
    Started,
    Sent,
    UploadFailed,
    NotConsented,
    SignerUntrusted,
    RateLimited,
    NoLog,
    Failed,
}
impl From<Refusal> for Outcome {
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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Receipt {
    pub time: u64,
    pub request_id: Uuid,
    pub outcome: Outcome,
    pub bytes: usize,
    pub lines: usize,
    pub window: u64,
}
impl Receipt {
    pub(crate) fn new(request_id: Uuid, window: u64, outcome: Outcome) -> Self {
        Self {
            time: crate::support_log::now_unix_millis(),
            request_id,
            outcome,
            bytes: 0,
            lines: 0,
            window,
        }
    }
    fn charges_rate(&self) -> bool {
        !matches!(self.outcome, Outcome::Sent | Outcome::UploadFailed)
    }
}

fn open(dir: &cap_std::fs::Dir, name: &str) -> std::io::Result<File> {
    match crate::platform::open_private_file_at(dir, Path::new(name), true) {
        Ok(file) => Ok(file),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            crate::platform::create_private_file_new_at(dir, Path::new(name))
        }
        Err(error) => Err(error),
    }
}
fn read_receipts(dir: &cap_std::fs::Dir) -> Result<Vec<Receipt>> {
    let mut receipts = Vec::new();
    for name in [SENT_PREVIOUS, SENT] {
        let file = match crate::platform::open_private_file_at(dir, Path::new(name), false) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        anyhow::ensure!(
            file.metadata()?.len() <= MAX_RECEIPT_FILE,
            "oversized support receipts"
        );
        let mut bytes = Vec::new();
        file.take(MAX_RECEIPT_FILE).read_to_end(&mut bytes)?;
        // Corruption is fail-closed, never a cleared rate history.
        anyhow::ensure!(
            bytes.is_empty() || bytes.last() == Some(&b'\n'),
            "torn support receipt"
        );
        for line in bytes.split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
            receipts.push(serde_json::from_slice(line)?);
        }
    }
    Ok(receipts)
}
fn append_locked(dir: &cap_std::fs::Dir, receipt: &Receipt) -> Result<()> {
    let mut bytes = serde_json::to_vec(receipt)?;
    bytes.push(b'\n');
    anyhow::ensure!(bytes.len() < 1024, "oversized support receipt");
    let mut file = open(dir, SENT)?;
    if file.metadata()?.len() + bytes.len() as u64 > MAX_RECEIPT_FILE {
        drop(file);
        dir.rename(SENT, dir, SENT_PREVIOUS)?;
        file = open(dir, SENT)?;
    }
    file.seek(SeekFrom::End(0))?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    #[cfg(unix)]
    dir.open(".")?.sync_all()?;
    Ok(())
}
fn locked_dir(path: &Path) -> Result<(cap_std::fs::Dir, File)> {
    let dir = crate::platform::open_support_dir(path, true)?;
    let lock = open(&dir, SENT_LOCK)?;
    lock.try_lock()
        .map_err(|_| std::io::Error::other("support receipts busy"))?;
    Ok((dir, lock))
}
pub(crate) fn append(path: &Path, receipt: &Receipt) -> Result<()> {
    let (dir, _lock) = locked_dir(path)?;
    let _ = read_receipts(&dir)?; // never append behind a torn reservation
    append_locked(&dir, receipt)
}
pub(crate) fn recent(path: &Path) -> Result<Vec<Receipt>> {
    let (dir, _lock) = locked_dir(path)?;
    let mut receipts = read_receipts(&dir)?;
    receipts.drain(..receipts.len().saturating_sub(5));
    Ok(receipts)
}

/// Held through upload, and by an unfinished blocking snapshot after timeout.
/// A reconnect or overlapping process cannot get a second collection in flight.
#[derive(Debug)]
pub(crate) struct Flight {
    _file: File,
    pub path: PathBuf,
}
pub(crate) fn begin(path: &Path, receipt: &Receipt) -> Result<Flight, Refusal> {
    let (dir, _lock) = locked_dir(path).map_err(|_| Refusal::Failed)?;
    let flight = open(&dir, FLIGHT_LOCK).map_err(|_| Refusal::Failed)?;
    flight.try_lock().map_err(|_| Refusal::RateLimited)?;
    let receipts = read_receipts(&dir).map_err(|_| Refusal::Failed)?;
    if rate_limited(&receipts, receipt.time) {
        return Err(Refusal::RateLimited);
    }
    append_locked(&dir, receipt).map_err(|_| Refusal::Failed)?;
    Ok(Flight {
        _file: flight,
        path: path.to_owned(),
    })
}
fn rate_limited(receipts: &[Receipt], now: u64) -> bool {
    // Refusals also consume rate budget: refusal floods cannot rotate away the
    // upload history and regain permission. Two full files retain far more
    // than twelve charges, even when each charge has a terminal receipt.
    let mut day = 0;
    for receipt in receipts.iter().filter(|r| r.charges_rate()) {
        let age = now.saturating_sub(receipt.time);
        if age < 300_000 {
            return true;
        }
        if age < 86_400_000 {
            day += 1;
        }
    }
    day >= 12
}

#[cfg(test)]
#[path = "support_store_tests.rs"]
mod tests;
