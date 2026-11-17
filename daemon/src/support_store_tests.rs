use super::*;
use crate::support::tests::fixture;
use ed25519_dalek::SigningKey;

#[test]
fn newest_wins_identical_clears_server_off_and_reload_reverifies() {
    let tmp = crate::support_log::capture::private_tempdir();
    let (trust, mut consent) = fixture();
    apply(tmp.path(), Some(consent.clone()), &trust, 1000).unwrap();
    apply(tmp.path(), None, &trust, 1000).unwrap();
    assert!(load(tmp.path(), &trust, 1000).unwrap().server_off);
    apply(tmp.path(), Some(consent.clone()), &trust, 1000).unwrap();
    assert!(!load(tmp.path(), &trust, 1000).unwrap().server_off);
    let old = consent.clone();
    consent.issued_at_ms += 1;
    consent.enabled = false;
    consent.sign(&SigningKey::from_bytes(&[7; 32])).unwrap();
    apply(tmp.path(), Some(consent.clone()), &trust, 1001).unwrap();
    apply(tmp.path(), Some(old), &trust, 1001).unwrap();
    assert!(
        !load(tmp.path(), &trust, 1001)
            .unwrap()
            .consent
            .unwrap()
            .enabled
    );
    let mut conflict = consent.clone();
    conflict.enabled = true;
    conflict.sign(&SigningKey::from_bytes(&[7; 32])).unwrap();
    apply(tmp.path(), Some(conflict), &trust, 1001).unwrap();
    assert_eq!(
        load(tmp.path(), &trust, 1001).unwrap().consent,
        Some(consent)
    );
    let mut raw = read(tmp.path()).unwrap();
    raw.consent.as_mut().unwrap().enabled = true;
    CONSENT
        .write(
            &tmp.path().join(CONSENT_NAME),
            &serde_json::to_vec(&raw).unwrap(),
        )
        .unwrap();
    assert!(matches!(
        load(tmp.path(), &trust, 1001),
        Err(Refusal::NotConsented)
    ));
    remove(tmp.path()).unwrap();
    assert!(read(tmp.path()).unwrap().consent.is_none());
}

#[test]
fn removed_signer_stays_removed_after_restart_and_cannot_waive_newest_floor() {
    let tmp = crate::support_log::capture::private_tempdir();
    let (mut trust, consent) = fixture();
    apply(tmp.path(), Some(consent.clone()), &trust, 1000).unwrap();
    let original = trust.clone();
    trust
        .revoked
        .insert(SigningKey::from_bytes(&[7; 32]).verifying_key().to_bytes());
    remember_revocations(tmp.path(), &trust).unwrap();
    assert!(matches!(
        load(tmp.path(), &original, 1000),
        Err(Refusal::SignerUntrusted)
    ));
    assert!(apply(tmp.path(), Some(consent), &original, 1000).is_err());
}

#[test]
fn rates_survive_reopen_and_include_attempts_refusals_and_clock_rollback() {
    let tmp = crate::support_log::capture::private_tempdir();
    let path = tmp.path().join("support");
    let mut receipt = Receipt::new(Uuid::new_v4(), 60, Outcome::Started);
    receipt.time = 1_000_000;
    let flight = begin(&path, &receipt).unwrap();
    assert!(matches!(begin(&path, &receipt), Err(Refusal::RateLimited)));
    drop(flight);
    receipt.time += 299_999;
    assert!(matches!(begin(&path, &receipt), Err(Refusal::RateLimited)));
    receipt.time += 1;
    drop(begin(&path, &receipt).unwrap());
    for offset in 2..12 {
        // Twelve fixed quota cases, not a stress test.
        receipt.time = 1_000_000 + offset * 300_000;
        drop(begin(&path, &receipt).unwrap());
    }
    receipt.time += 300_000;
    assert!(matches!(begin(&path, &receipt), Err(Refusal::RateLimited)));
    receipt.time = 1;
    assert!(matches!(begin(&path, &receipt), Err(Refusal::RateLimited)));
    receipt.time = 1_000_000 + 86_400_000;
    drop(begin(&path, &receipt).unwrap());
    receipt.time += 300_000;
    receipt.outcome = Outcome::NotConsented;
    append(&path, &receipt).unwrap();
    assert!(matches!(begin(&path, &receipt), Err(Refusal::RateLimited)));
}

#[test]
fn torn_audit_fails_closed_and_rotated_receipts_preserve_quota() {
    let tmp = crate::support_log::capture::private_tempdir();
    let path = tmp.path().join("support");
    let (dir, lock) = locked_dir(&path).unwrap();
    let receipt = Receipt::new(Uuid::new_v4(), 60, Outcome::NotConsented);
    let mut line = serde_json::to_vec(&receipt).unwrap();
    line.push(b'\n');
    // Directly seed a bounded full file; exercise one rotation, no load loop.
    let count = MAX_RECEIPT_FILE as usize / line.len();
    let mut file = open(&dir, SENT).unwrap();
    file.write_all(&line.repeat(count)).unwrap();
    drop(file);
    drop(lock);
    append(&path, &receipt).unwrap();
    assert!(dir.metadata(SENT_PREVIOUS).unwrap().len() <= MAX_RECEIPT_FILE);
    assert!(dir.metadata(SENT).unwrap().len() <= MAX_RECEIPT_FILE);
    assert!(matches!(begin(&path, &receipt), Err(Refusal::RateLimited)));
    open(&dir, SENT).unwrap().write_all(b"torn").unwrap();
    assert!(matches!(begin(&path, &receipt), Err(Refusal::Failed)));
}

#[test]
fn status_reports_verified_attribution_server_off_and_refusals() {
    let tmp = crate::support_log::capture::private_tempdir();
    let path = tmp.path().join("support");
    let (trust, consent) = fixture();
    apply(tmp.path(), Some(consent.clone()), &trust, 1000).unwrap();
    let shown = status(tmp.path(), &trust, &path);
    assert!(shown.enabled);
    assert_eq!(
        shown.signer_device_id,
        Uuid::parse_str(&consent.signer_device_id).ok()
    );
    assert_eq!(shown.issued_at_ms, Some(1000));
    let mut legacy = trust.clone();
    legacy.account = None;
    assert!(status(tmp.path(), &legacy, &path).enabled);
    apply(tmp.path(), None, &trust, 1000).unwrap();
    append(
        &path,
        &Receipt::new(Uuid::new_v4(), 60, Outcome::NotConsented),
    )
    .unwrap();
    let shown = status(tmp.path(), &trust, &path);
    assert!(!shown.enabled && shown.server_off);
    assert_eq!(shown.recent.len(), 1);
    assert_eq!(shown.recent[0].outcome, Outcome::NotConsented);
}
