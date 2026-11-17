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
        .insert(SigningKey::from_bytes(&[7; 32]).verifying_key().to_bytes())
        .unwrap();
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
    assert!(!status(tmp.path(), &legacy, &path).enabled);
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

#[test]
fn equal_timestamp_off_wins_and_unproven_account_cannot_store() {
    let tmp = crate::support_log::capture::private_tempdir();
    let (mut trust, mut consent) = fixture();
    apply(tmp.path(), Some(consent.clone()), &trust, 1000).unwrap();
    consent.enabled = false;
    consent.sign(&SigningKey::from_bytes(&[7; 32])).unwrap();
    apply(tmp.path(), Some(consent), &trust, 1000).unwrap();
    assert!(
        !load(tmp.path(), &trust, 1000)
            .unwrap()
            .consent
            .unwrap()
            .enabled
    );
    trust.account = None;
    assert!(apply(tmp.path(), None, &trust, 1000).is_err());
}

#[test]
fn absent_statement_cleanup_does_not_create_a_lock() {
    let tmp = crate::support_log::capture::private_tempdir();
    std::fs::create_dir(tmp.path().join(CONSENT_LOCK)).unwrap();
    remove(tmp.path()).unwrap();
}

#[test]
fn cancellations_without_started_reservations_still_preserve_quota() {
    let tmp = crate::support_log::capture::private_tempdir();
    let path = tmp.path().join("support");
    let mut cancelled = Receipt::new(Uuid::new_v4(), 60, Outcome::Cancelled);
    for n in 0..12 {
        // exactly the daily quota, not a load test
        cancelled.time = 1_000_000 + n * 300_000;
        append(&path, &cancelled).unwrap();
    }
    cancelled.time += 300_000;
    assert!(matches!(
        begin(&path, &cancelled),
        Err(Refusal::RateLimited)
    ));
}

#[test]
fn identical_effective_state_does_not_spend_control_writes() {
    let tmp = crate::support_log::capture::private_tempdir();
    let (trust, consent) = fixture();
    let mut budget = ControlBudget::default();
    apply_budgeted(tmp.path(), Some(consent.clone()), &trust, 1000, &mut budget).unwrap();
    assert_eq!(budget.0.len(), 1);
    apply_budgeted(tmp.path(), Some(consent), &trust, 1000, &mut budget).unwrap();
    assert_eq!(budget.0.len(), 1);
    apply_budgeted(tmp.path(), None, &trust, 1000, &mut budget).unwrap();
    assert_eq!(budget.0.len(), 2);
    apply_budgeted(tmp.path(), None, &trust, 1000, &mut budget).unwrap();
    assert_eq!(budget.0.len(), 2);
}

#[test]
fn status_with_no_support_files_is_read_only() {
    let tmp = crate::support_log::capture::private_tempdir();
    let (trust, _) = fixture();
    let config = tmp.path().join("absent-config");
    let path = tmp.path().join("absent-log");
    assert!(!status(&config, &trust, &path).enabled);
    assert!(!config.exists() && !path.exists());
}

#[test]
fn refreshed_carried_approval_is_persisted_for_the_same_signed_statement() {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use spawnd::acct_endorsement::{sign_transcript, signature_to_wire, AcctEndorsementTranscript};
    let tmp = crate::support_log::capture::private_tempdir();
    let (mut trust, mut consent) = fixture();
    let root = SigningKey::from_bytes(&[7; 32]);
    let first = SigningKey::from_bytes(&[8; 32]);
    let second = SigningKey::from_bytes(&[9; 32]);
    let leaf = SigningKey::from_bytes(&[10; 32]);
    let key = |signer: &SigningKey| URL_SAFE_NO_PAD.encode(signer.verifying_key().as_bytes());
    consent.signer_public_key = key(&leaf);
    consent.signer_device_id = Uuid::from_bytes([6; 16]).to_string();
    consent.sign(&leaf).unwrap();
    let edge = |from: &SigningKey, to: &SigningKey| {
        let transcript = AcctEndorsementTranscript::from_wire(
            &consent.account_id,
            &key(from),
            &key(to),
            &consent.signer_device_id,
        )
        .unwrap();
        spawnd::endorsement_chain::CarriedEndorsement {
            account_id: consent.account_id.clone(),
            endorser_public_key: key(from),
            endorsed_public_key: key(to),
            endorsed_device_id: consent.signer_device_id.clone(),
            signature: signature_to_wire(&sign_transcript(from, &transcript)),
        }
    };
    let first_path = vec![edge(&root, &first), edge(&first, &leaf)];
    let second_path = vec![edge(&root, &second), edge(&second, &leaf)];
    consent.carried_endorsements = first_path;
    apply(tmp.path(), Some(consent.clone()), &trust, 1000).unwrap();
    trust
        .revoked
        .insert(first.verifying_key().to_bytes())
        .unwrap();
    remember_revocations(tmp.path(), &trust).unwrap();
    assert!(load(tmp.path(), &trust, 1000).is_err());
    let old = consent.clone();
    consent.carried_endorsements = second_path;
    assert!(consent.same_statement(&old));
    apply(tmp.path(), Some(consent.clone()), &trust, 1000).unwrap();
    assert_eq!(
        load(tmp.path(), &trust, 1000).unwrap().consent,
        Some(consent)
    );
}
