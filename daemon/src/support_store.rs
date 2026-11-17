//! Private consent and bounded append-only collection receipts. These files
//! never supply upload bytes. All calls are blocking work, outside dispatch.
use crate::support::{Refusal, Trust};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use spawnd::{secret_file::SecretFile, support_consent::Consent};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use uuid::Uuid;

const CONSENT: SecretFile =
    SecretFile::new("SPAWN D support sharing", ".support-consent.", 64 * 1024);
pub(crate) const MAX_REVOCATIONS: usize = 256;
#[derive(Debug, thiserror::Error)]
#[error("support revocation capacity exceeded")]
pub(crate) struct RevocationOverflow;
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
// A bounded wait handles ordinary overlap with status/another writer. Actor
// retries keep the input pending after this wait, with a capped async backoff.
fn consent_lock(config: &Path) -> Result<File> {
    let mut last = None;
    for _attempt in 0..5 {
        match CONSENT.try_lock_file(&config.join(CONSENT_LOCK)) {
            Ok(lock) => return Ok(lock),
            Err(error) => last = Some(error),
        }
        #[cfg(not(test))]
        if _attempt < 4 {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    Err(last.expect("lock attempted"))
}
/// Allocation-free fallback when a delivered off cannot be stored. The actor
/// still retains that input and denies; losing this file loses the replay floor.
pub(crate) fn erase_statement(config: &Path) -> Result<()> {
    match std::fs::remove_file(config.join(CONSENT_NAME)) {
        Ok(()) => spawnd::secret_file::sync_parent_directory(config).map_err(Into::into),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}
pub(crate) fn apply(
    config: &Path,
    incoming: Option<Consent>,
    trust: &Trust,
    now: u64,
) -> Result<()> {
    anyhow::ensure!(
        trust.account.is_some(),
        "support sharing needs a locally proven account"
    );
    let _lock = consent_lock(config)?;
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
                || (consent.issued_at_ms == old.issued_at_ms
                    && !consent.same_statement(old)
                    && (!old.enabled || consent.enabled))
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
pub(crate) fn remember_revocations(
    config: &Path,
    trust: &Trust,
) -> Result<spawnd::endorsement_chain::RevocationSet> {
    let _lock = consent_lock(config)?;
    let mut stored = read(config)?;
    let changed = stored.revoked.absorb(trust.revoked.clone());
    if stored.revoked.len() > MAX_REVOCATIONS {
        return Err(RevocationOverflow.into());
    }
    if changed {
        write(config, &stored)?;
    }
    Ok(stored.revoked)
}

#[derive(Debug, Default, Serialize)]
pub(crate) struct SharingStatus {
    pub enabled: bool,
    pub account_unproven: bool,
    pub runtime: Option<crate::support::RuntimeStatus>,
    pub signer_device_id: Option<Uuid>,
    pub issued_at_ms: Option<u64>,
    pub server_off: bool,
    pub recent: Vec<Receipt>,
}
pub(crate) fn status(config: &Path, trust: &Trust, path: &Path) -> SharingStatus {
    let mut status = SharingStatus::default();
    // Even an untrusted or damaged proof cannot hide the server's off flag.
    if let Ok(stored) = read(config) {
        status.server_off = stored.server_off;
    }
    status.account_unproven = trust.account.is_none();
    if let Ok(stored) = load(config, trust, crate::support_log::now_unix_millis()) {
        if let Some(consent) = stored.consent {
            status.enabled = consent.enabled && !stored.server_off;
            status.signer_device_id = Uuid::parse_str(&consent.signer_device_id).ok();
            status.issued_at_ms = Some(consent.issued_at_ms);
        }
    }
    status.recent = recent(path).unwrap_or_default();
    status
}

/// Complete ordinary cleanup before reporting an optional support failure.
pub(crate) fn cleanup_after<T>(
    ordinary: impl FnOnce() -> Result<T>,
    support: impl FnOnce() -> Result<()>,
) -> Result<T> {
    let primary = ordinary();
    let secondary = support();
    match (primary, secondary) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => {
            Err(primary.context(format!("support cleanup also failed: {secondary:#}")))
        }
    }
}
pub(crate) fn remove(config: &Path) -> Result<()> {
    // No lock creation when there is nothing to remove (including full disks).
    if !config.join(CONSENT_NAME).try_exists()? {
        return Ok(());
    }
    let _lock = consent_lock(config)?;
    erase_statement(config)
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
    Cancelled,
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
        // Cancellation can precede Started. Charge it conservatively too, so
        // admitted/cancelled frames cannot rotate away the durable quota floor.
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
    Ok(Flight { _file: flight })
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
