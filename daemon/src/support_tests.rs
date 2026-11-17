use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::SigningKey;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

// A parked blocking task inhibits Tokio auto-advance while loopback IO and
// explicit signals run. Only advance() moves deadlines; dropping this sender
// releases the task even when an assertion panics.
pub(crate) fn freeze_time() -> std::sync::mpsc::Sender<()> {
    tokio::time::pause();
    let (tx, rx) = std::sync::mpsc::channel();
    tokio::task::spawn_blocking(move || {
        let _ = rx.recv();
    });
    tx
}
#[derive(Default)]
pub(super) struct Pause(
    Mutex<
        Option<(
            tokio::sync::oneshot::Sender<()>,
            tokio::sync::oneshot::Receiver<()>,
        )>,
    >,
);
impl Pause {
    fn arm(
        &self,
    ) -> (
        tokio::sync::oneshot::Receiver<()>,
        tokio::sync::oneshot::Sender<()>,
    ) {
        let (entered, wait) = tokio::sync::oneshot::channel();
        let (release, resume) = tokio::sync::oneshot::channel();
        *self.0.lock().unwrap() = Some((entered, resume));
        (wait, release)
    }
    pub(super) async fn pause(&self) {
        let gate = self.0.lock().unwrap().take();
        if let Some((entered, resume)) = gate {
            let _ = entered.send(());
            let _ = resume.await;
        }
    }
}
#[derive(Default)]
pub(super) struct Hooks {
    pub after_apply: Pause,
    pub before_send: Pause,
    pub after_recorded: Pause,
    pub after_fallback: Pause,
    pub apply_failed: Notify,
    pub apply_attempts: AtomicU64,
    pub audit: IoPause,
}

#[derive(Default)]
pub(super) struct IoPause(
    Mutex<
        Option<(
            tokio::sync::oneshot::Sender<()>,
            std::sync::mpsc::Receiver<()>,
        )>,
    >,
);
impl IoPause {
    fn arm(
        &self,
    ) -> (
        tokio::sync::oneshot::Receiver<()>,
        std::sync::mpsc::Sender<()>,
    ) {
        let (entered, ready) = tokio::sync::oneshot::channel();
        let (release, hold) = std::sync::mpsc::channel();
        *self.0.lock().unwrap() = Some((entered, hold));
        (ready, release)
    }
    pub(super) fn pause(&self) {
        let gate = self.0.lock().unwrap().take();
        if let Some((entered, hold)) = gate {
            let _ = entered.send(());
            let _ = hold.recv_timeout(Duration::from_secs(10));
        }
    }
}

pub(crate) fn fixture() -> (Trust, Consent) {
    let signer = SigningKey::from_bytes(&[7; 32]);
    let public = URL_SAFE_NO_PAD.encode(signer.verifying_key().as_bytes());
    let record: StoredCreds = serde_json::from_value(serde_json::json!({
        "credential_record_version": 1, "credential_generation": 1,
        "credential_record_id": Uuid::from_bytes([4;16]),
        "access_token":"test-token", "host_id":Uuid::from_bytes([3;16]),
        "host_private_key_seed":URL_SAFE_NO_PAD.encode([5;32]),
        "browser_pins":[{"browser_device_id":Uuid::from_bytes([2;16]),
            "browser_key_algorithm":"ed25519", "browser_public_key":public,
            "browser_key_fingerprint":crate::creds::browser_key_fingerprint(&public).unwrap()}]
    }))
    .unwrap();
    let mut trust = Trust::from_record(&record);
    trust.account = Some([1; 16]);
    let mut consent = Consent {
        version: 1,
        account_id: Uuid::from_bytes([1; 16]).to_string(),
        signer_device_id: Uuid::from_bytes([2; 16]).to_string(),
        signer_public_key: public,
        enabled: true,
        issued_at_ms: 1000,
        signature: String::new(),
        carried_endorsements: vec![],
    };
    consent.sign(&signer).unwrap();
    (trust, consent)
}

pub(crate) async fn test_collector(config: PathBuf, trust: Trust, origin: String) -> Collector {
    let path = config.join("support");
    let log = support_log::SupportLog::open(&path).unwrap();
    log.fixture_event(1_000_000);
    let collector = Collector::start_at(config, path, Some(log), "00000000".into(), origin)
        .await
        .unwrap();
    collector.trust(Arc::new(trust), None, None);
    collector
}
pub(crate) async fn settled(c: &Collector) {
    let (tx, rx) = tokio::sync::oneshot::channel();
    c.tx.send(Command::Barrier(tx)).await.unwrap();
    rx.await.unwrap();
}
pub(crate) fn collection(c: &Collector, window: i64) -> tokio::sync::oneshot::Receiver<()> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    c.enqueue_collection(Uuid::new_v4(), window, Some(tx));
    rx
}
async fn listener() -> (tokio::net::TcpListener, String) {
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    (listener, origin)
}
pub(crate) async fn receive_request(stream: &mut tokio::net::TcpStream) -> (String, Vec<u8>) {
    let mut bytes = Vec::new();
    let end = loop {
        let mut buffer = [0; 4096];
        let n = stream.read(&mut buffer).await.unwrap();
        assert_ne!(n, 0);
        bytes.extend_from_slice(&buffer[..n]);
        if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            break end + 4;
        }
        assert!(bytes.len() < 8192);
    };
    let headers = String::from_utf8(bytes[..end].to_vec()).unwrap();
    let length: usize = headers
        .lines()
        .find_map(|line| {
            line.to_lowercase()
                .strip_prefix("content-length: ")
                .map(str::to_owned)
        })
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert!(length <= support_log::MAX_GZIP_BYTES);
    while bytes.len() - end < length {
        let mut buffer = [0; 4096];
        let n = stream.read(&mut buffer).await.unwrap();
        assert_ne!(n, 0);
        bytes.extend_from_slice(&buffer[..n]);
    }
    (headers, bytes[end..].to_vec())
}

#[tokio::test]
async fn actual_upload_and_refusal_complete_before_receipts_are_read() {
    bounded(async {
        let _clock = freeze_time();
        let tmp = support_log::capture::private_tempdir();
        let (listener, origin) = listener().await;
        let (trust, consent) = fixture();
        support_store::apply(tmp.path(), Some(consent), &trust, 1000).unwrap();
        let c = test_collector(tmp.path().to_owned(), trust, origin).await;
        settled(&c).await;
        let done = collection(&c, 0);
        let (mut socket, _) = listener.accept().await.unwrap();
        let (headers, body) = receive_request(&mut socket).await;
        assert!(headers
            .to_lowercase()
            .contains("authorization: bearer test-token\r\n"));
        assert!(headers
            .to_lowercase()
            .contains("content-type: application/gzip"));
        let mut raw = String::new();
        std::io::Read::read_to_string(&mut flate2::read::GzDecoder::new(body.as_slice()), &mut raw)
            .unwrap();
        let header: serde_json::Value = serde_json::from_str(raw.lines().next().unwrap()).unwrap();
        assert_eq!(header["bytes"], raw.len());
        assert_eq!(header["lines"], raw.lines().count() - 1);
        assert_eq!(
            header["window_to"].as_u64().unwrap() - header["window_from"].as_u64().unwrap(),
            60_000
        );
        assert!(body.len() <= support_log::MAX_GZIP_BYTES);
        socket
            .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        done.await.unwrap();
        let second_done = collection(&c, i64::MAX);
        let (mut second, _) = listener.accept().await.unwrap();
        let (_, refusal) = receive_request(&mut second).await;
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&refusal).unwrap()["declined"],
            "rate_limited"
        );
        second
            .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        second_done.await.unwrap();
        let receipts = support_store::recent(&tmp.path().join("support")).unwrap();
        assert!(receipts
            .iter()
            .any(|r| r.window == 259200 && r.outcome == Outcome::RateLimited));
        assert!(receipts.iter().any(|r| r.outcome == Outcome::Sent));
    })
    .await;
}

#[tokio::test]
async fn older_apply_cannot_grant_newer_generation_and_reconnect_keeps_off() {
    bounded(async {
        let _clock = freeze_time();
        let tmp = support_log::capture::private_tempdir();
        let (trust, mut consent) = fixture();
        support_store::apply(tmp.path(), Some(consent.clone()), &trust, 1000).unwrap();
        let c = test_collector(tmp.path().to_owned(), trust.clone(), String::new()).await;
        settled(&c).await;
        let (entered, release) = c.delivery.hooks.after_apply.arm();
        c.trust(Arc::new(trust.clone()), None, None);
        entered.await.unwrap();
        consent.enabled = false;
        consent.issued_at_ms += 1;
        consent.sign(&SigningKey::from_bytes(&[7; 32])).unwrap();
        c.consent(Some(consent));
        let generation = c.delivery.delivered.load(Ordering::SeqCst);
        assert_ne!(c.delivery.applied.load(Ordering::SeqCst), generation);
        let (recorded, resume) = c.delivery.hooks.after_recorded.arm();
        release.send(()).unwrap();
        recorded.await.unwrap();
        assert_ne!(c.delivery.applied.load(Ordering::SeqCst), generation);
        let refused = collection(&c, 60);
        assert!(refused.await.is_err());
        assert_eq!(c.delivery.status().dropped_requests, 1);
        resume.send(()).unwrap();
        settled(&c).await;
        assert_eq!(authorize(tmp.path(), &trust), Err(Refusal::NotConsented));
        c.fence();
        c.trust(Arc::new(trust.clone()), None, None);
        settled(&c).await;
        assert_eq!(authorize(tmp.path(), &trust), Err(Refusal::NotConsented));
    })
    .await;
}

#[tokio::test]
async fn busy_lock_off_survives_trust_update_old_on_and_restart() {
    bounded(async {
        let tmp = support_log::capture::private_tempdir();
        let (trust, mut consent) = fixture();
        let on = consent.clone();
        support_store::apply(tmp.path(), Some(on.clone()), &trust, 1000).unwrap();
        let c = test_collector(tmp.path().to_owned(), trust.clone(), String::new()).await;
        settled(&c).await;
        let lock = spawnd::secret_file::SecretFile::new("test", ".test.", 65536)
            .try_lock_file(&tmp.path().join("support-log-consent.lock"))
            .unwrap();
        consent.enabled = false;
        consent.issued_at_ms += 1;
        consent.sign(&SigningKey::from_bytes(&[7; 32])).unwrap();
        c.consent(Some(consent));
        c.delivery.hooks.apply_failed.notified().await;
        c.trust(Arc::new(trust.clone()), None, None);
        c.consent(Some(on));
        assert!(c.delivery.status().pending);
        drop(lock);
        settled(&c).await;
        assert_eq!(authorize(tmp.path(), &trust), Err(Refusal::NotConsented));
        drop(c);
        let c = test_collector(tmp.path().to_owned(), trust.clone(), String::new()).await;
        settled(&c).await;
        assert_eq!(authorize(tmp.path(), &trust), Err(Refusal::NotConsented));
    })
    .await;
}

#[tokio::test]
async fn queue_overflow_permanently_denies_collector() {
    bounded(async {
        let _clock = freeze_time();
        let tmp = support_log::capture::private_tempdir();
        let (trust, _) = fixture();
        let c = test_collector(tmp.path().to_owned(), trust.clone(), String::new()).await;
        settled(&c).await;
        let (entered, release) = c.delivery.hooks.after_apply.arm();
        c.trust(Arc::new(trust.clone()), None, None);
        entered.await.unwrap();
        for _ in 0..QUEUE {
            c.fence();
        }
        c.consent(None);
        assert!(c.delivery.status().permanent_deny);
        release.send(()).unwrap();
        settled(&c).await;
        c.trust(Arc::new(trust), None, None);
        settled(&c).await;
        assert!(c.delivery.status().permanent_deny);
    })
    .await;
}

#[tokio::test]
async fn change_before_request_start_opens_no_connection() {
    bounded(async {
        let _clock = freeze_time();
        let tmp = support_log::capture::private_tempdir();
        let (listener, origin) = listener().await;
        let (trust, consent) = fixture();
        support_store::apply(tmp.path(), Some(consent), &trust, 1000).unwrap();
        let c = test_collector(tmp.path().to_owned(), trust, origin).await;
        settled(&c).await;
        let (prepared, release) = c.delivery.hooks.before_send.arm();
        let done = collection(&c, 60);
        prepared.await.unwrap();
        c.consent(None);
        done.await.unwrap();
        drop(release);
        assert!(futures_util::FutureExt::now_or_never(listener.accept()).is_none());
        assert_eq!(
            support_store::recent(&tmp.path().join("support"))
                .unwrap()
                .last()
                .unwrap()
                .outcome,
            Outcome::Cancelled
        );
    })
    .await;
}

#[tokio::test]
async fn in_flight_request_is_dropped_and_records_cancelled() {
    bounded(async {
        let _clock = freeze_time();
        let tmp = support_log::capture::private_tempdir();
        let (listener, origin) = listener().await;
        let (trust, consent) = fixture();
        support_store::apply(tmp.path(), Some(consent), &trust, 1000).unwrap();
        let c = test_collector(tmp.path().to_owned(), trust, origin).await;
        settled(&c).await;
        let done = collection(&c, 60);
        let (mut socket, _) = listener.accept().await.unwrap();
        let (_, body) = receive_request(&mut socket).await;
        assert!(!body.is_empty()); // the body can already have been delivered
        c.consent(None);
        done.await.unwrap(); // no response: the request future was abandoned
        assert_eq!(
            support_store::recent(&tmp.path().join("support"))
                .unwrap()
                .last()
                .unwrap()
                .outcome,
            Outcome::Cancelled
        );
    })
    .await;
}

#[tokio::test]
async fn pending_input_refuses_collection_before_io() {
    bounded(async {
        let _clock = freeze_time();
        let tmp = support_log::capture::private_tempdir();
        let (trust, _) = fixture();
        let c = test_collector(tmp.path().to_owned(), trust.clone(), String::new()).await;
        settled(&c).await;
        let (entered, release) = c.delivery.hooks.after_apply.arm();
        c.trust(Arc::new(trust.clone()), None, None);
        entered.await.unwrap();
        for _ in 0..6 {
            c.collect(Uuid::new_v4(), 60);
        }
        assert_eq!(c.delivery.status().dropped_requests, 6);
        assert!(!tmp.path().join("support/sent.jsonl").exists());
        release.send(()).unwrap();
    })
    .await;
}

#[tokio::test]
async fn unknown_account_does_not_store_consent_and_bad_storage_is_optional() {
    bounded(async {
        let _clock = freeze_time();
        let tmp = support_log::capture::private_tempdir();
        let (mut trust, consent) = fixture();
        trust.account = None;
        let c = test_collector(tmp.path().to_owned(), trust.clone(), String::new()).await;
        c.consent(Some(consent));
        settled(&c).await;
        assert!(!tmp.path().join("support-log-consent.json").exists());
        assert_eq!(authorize(tmp.path(), &trust), Err(Refusal::NotConsented));
        let unavailable = tmp.path().join("file");
        std::fs::write(&unavailable, b"test").unwrap();
        assert!(Collector::start_at(
            tmp.path().to_owned(),
            unavailable.clone(),
            None,
            "00000000".into(),
            String::new()
        )
        .await
        .is_none());
        // Exercise the same storage-preparation boundary used at daemon startup.
        assert!(crate::platform::open_support_dir(&unavailable, true).is_err());
    })
    .await;
}
#[test]
fn consent_and_connection_share_direct_and_chained_admission() {
    use spawnd::acct_endorsement::{sign_transcript, signature_to_wire, AcctEndorsementTranscript};
    let (trust, mut consent) = fixture();
    let signer = SigningKey::from_bytes(&[9; 32]);
    consent.signer_public_key = URL_SAFE_NO_PAD.encode(signer.verifying_key().as_bytes());
    consent.signer_device_id = Uuid::from_bytes([6; 16]).to_string();
    consent.sign(&signer).unwrap();
    assert_eq!(trust.verify(&consent, 1000), Err(Refusal::SignerUntrusted));
    let root = SigningKey::from_bytes(&[7; 32]);
    let transcript = AcctEndorsementTranscript::from_wire(
        &consent.account_id,
        &URL_SAFE_NO_PAD.encode(root.verifying_key().as_bytes()),
        &consent.signer_public_key,
        &consent.signer_device_id,
    )
    .unwrap();
    consent
        .carried_endorsements
        .push(spawnd::endorsement_chain::CarriedEndorsement {
            account_id: consent.account_id.clone(),
            endorser_public_key: URL_SAFE_NO_PAD.encode(root.verifying_key().as_bytes()),
            endorsed_public_key: consent.signer_public_key.clone(),
            endorsed_device_id: consent.signer_device_id.clone(),
            signature: signature_to_wire(&sign_transcript(&root, &transcript)),
        });
    assert!(trust.verify(&consent, 1000).is_ok());
    assert!(crate::run::admitted_device(
        &signer.verifying_key(),
        &trust.pins,
        trust.account.as_ref(),
        &trust.revoked.admission_set(),
        &consent.carried_endorsements,
        None
    ));
    let mut revoked = trust.clone();
    revoked
        .revoked
        .insert(root.verifying_key().to_bytes())
        .unwrap();
    assert_eq!(
        revoked.verify(&consent, 1000),
        Err(Refusal::SignerUntrusted)
    );
    consent.carried_endorsements = vec![consent.carried_endorsements[0].clone(); 65];
    assert!(trust.verify(&consent, 1000).is_err());
    assert!(serde_json::from_value::<Consent>(serde_json::to_value(&consent).unwrap()).is_err());
}

#[test]
fn upload_destinations_are_origin_pinned_and_http_is_test_loopback_only() {
    let id = Uuid::new_v4();
    let origin = url::Url::parse("https://example.invalid/ignored?query#fragment").unwrap();
    let url = endpoint(origin.as_str(), id).unwrap();
    assert_eq!(url.origin(), origin.origin());
    assert_eq!(url.path(), format!("/ignored/api/support-log/uploads/{id}"));
    assert!(url.query().is_none() && url.fragment().is_none());
    assert!(endpoint("http://example.invalid", id).is_err());
    assert!(endpoint("https://user:password@example.invalid", id).is_err());
}

#[tokio::test]
async fn unpersisted_off_erases_on_before_restart_and_redelivery() {
    bounded(async {
        let _clock = freeze_time();
        let tmp = support_log::capture::private_tempdir();
        let (trust, mut off) = fixture();
        support_store::apply(tmp.path(), Some(off.clone()), &trust, 1000).unwrap();
        let c = test_collector(tmp.path().to_owned(), trust.clone(), String::new()).await;
        settled(&c).await;
        let lock = spawnd::secret_file::SecretFile::new("test", ".test.", 65536)
            .try_lock_file(&tmp.path().join("support-log-consent.lock"))
            .unwrap();
        let (erased, release) = c.delivery.hooks.after_fallback.arm();
        off.enabled = false;
        off.issued_at_ms += 1;
        off.sign(&SigningKey::from_bytes(&[7; 32])).unwrap();
        c.consent(Some(off.clone()));
        erased.await.unwrap();
        assert!(!tmp.path().join("support-log-consent.json").exists());
        assert_eq!(authorize(tmp.path(), &trust), Err(Refusal::NotConsented));
        drop(c);
        drop(lock);
        drop(release);
        let c = test_collector(tmp.path().to_owned(), trust.clone(), String::new()).await;
        c.consent(Some(off)); // honest registered redelivers before collection
        settled(&c).await;
        assert_eq!(authorize(tmp.path(), &trust), Err(Refusal::NotConsented));
    })
    .await;
}

#[tokio::test]
async fn failed_off_unlink_is_permanent_and_later_trust_cannot_clear_it() {
    bounded(async {
        let _clock = freeze_time();
        let tmp = support_log::capture::private_tempdir();
        let (trust, _) = fixture();
        let c = test_collector(tmp.path().to_owned(), trust.clone(), String::new()).await;
        settled(&c).await;
        std::fs::create_dir(tmp.path().join("support-log-consent.json")).unwrap();
        let (failed, release) = c.delivery.hooks.after_fallback.arm();
        c.consent(None);
        failed.await.unwrap();
        assert!(c.delivery.status().permanent_deny);
        c.trust(Arc::new(trust), None, None);
        drop(release);
        assert!(c.delivery.status().permanent_deny);
    })
    .await;
}

#[tokio::test]
async fn later_verified_consent_supersedes_failed_input() {
    bounded(async {
        let tmp = support_log::capture::private_tempdir();
        let (trust, mut consent) = fixture();
        let c = test_collector(tmp.path().to_owned(), trust.clone(), String::new()).await;
        settled(&c).await;
        let mut invalid = consent.clone();
        invalid.signature.clear();
        c.consent(Some(invalid));
        c.delivery.hooks.apply_failed.notified().await;
        consent.issued_at_ms += 1;
        consent.enabled = false;
        consent.sign(&SigningKey::from_bytes(&[7; 32])).unwrap();
        c.consent(Some(consent));
        settled(&c).await;
        assert!(!c.delivery.status().pending);
        assert_eq!(authorize(tmp.path(), &trust), Err(Refusal::NotConsented));
    })
    .await;
}

#[tokio::test]
async fn stalled_tls_is_cancelled_and_redirect_is_upload_failure() {
    bounded(async {
        let _clock = freeze_time();
        let tmp = support_log::capture::private_tempdir();
        let (listener, origin) = listener().await;
        let (trust, consent) = fixture();
        support_store::apply(tmp.path(), Some(consent), &trust, 1000).unwrap();
        let c = test_collector(
            tmp.path().to_owned(),
            trust,
            origin.replacen("http:", "https:", 1),
        )
        .await;
        settled(&c).await;
        let done = collection(&c, 60);
        let (mut connection, _) = listener.accept().await.unwrap();
        let mut header = [0; 5];
        connection.read_exact(&mut header).await.unwrap();
        assert_eq!(header[0], 22); // TLS handshake record, may span many TCP reads
        let length = u16::from_be_bytes([header[3], header[4]]) as usize;
        let mut hello = vec![0; length];
        connection.read_exact(&mut hello).await.unwrap();
        assert_eq!(hello[0], 1); // ClientHello; the listener never answers TLS
        c.fence(); // reload/teardown uses the same immediate generation fence
        done.await.unwrap();
        let mut rest = Vec::new();
        connection.read_to_end(&mut rest).await.unwrap();
        // Cancellation need not recall already queued TLS handshake records.
        // Without ServerHello no HTTP request line or application body can exist.
        let mut bytes = rest.as_slice();
        while !bytes.is_empty() {
            assert!(bytes.len() >= 5);
            assert!(matches!(bytes[0], 20..=22)); // never application data (23)
            let length = u16::from_be_bytes([bytes[3], bytes[4]]) as usize;
            assert!(bytes.len() >= 5 + length);
            bytes = &bytes[5 + length..];
        }
        assert_eq!(
            support_store::recent(&tmp.path().join("support"))
                .unwrap()
                .last()
                .unwrap()
                .outcome,
            Outcome::Cancelled
        );

        let tmp = support_log::capture::private_tempdir();
        let (listener, origin) = self::listener().await;
        let (trust, consent) = fixture();
        support_store::apply(tmp.path(), Some(consent), &trust, 1000).unwrap();
        let c = test_collector(tmp.path().to_owned(), trust, origin).await;
        settled(&c).await;
        let done = collection(&c, 60);
        let (mut socket, _) = listener.accept().await.unwrap();
        receive_request(&mut socket).await;
        socket
            .write_all(b"HTTP/1.1 302 Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        done.await.unwrap();
        assert_eq!(
            support_store::recent(&tmp.path().join("support"))
                .unwrap()
                .last()
                .unwrap()
                .outcome,
            Outcome::UploadFailed
        );
    })
    .await;
}

#[test]
fn generated_negative_device_attribution_vectors() {
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../proto/support-log-consent-v1-vectors.json"
    ))
    .unwrap();
    let (trust, _) = fixture();
    for case in vectors["negative"].as_array().unwrap() {
        let consent: Consent = serde_json::from_value(case["consent"].clone()).unwrap();
        assert!(consent.verify(&[1; 16], consent.issued_at_ms).is_ok());
        assert_eq!(
            trust.verify(&consent, consent.issued_at_ms),
            Err(Refusal::SignerUntrusted)
        );
    }
}

#[tokio::test]
async fn revocations_survive_reconnect_and_unlink_in_this_process() {
    bounded(async {
        let _clock = freeze_time();
        let tmp = support_log::capture::private_tempdir();
        let (trust, consent) = fixture();
        let c = test_collector(tmp.path().to_owned(), trust.clone(), String::new()).await;
        c.trust(
            Arc::new(trust.clone()),
            None,
            Some(vec![consent.signer_public_key.clone()].into()),
        );
        settled(&c).await;
        c.fence();
        settled(&c).await;
        support_store::erase_statement(tmp.path()).unwrap();
        c.trust(Arc::new(trust.clone()), None, None);
        settled(&c).await;
        assert!(support_store::apply(tmp.path(), Some(consent), &trust, 1000).is_err());
    })
    .await;
}

#[tokio::test]
async fn pre_send_deadline_still_leaves_time_for_terminal_audit() {
    bounded(async {
        let _clock = freeze_time();
        let tmp = support_log::capture::private_tempdir();
        let (listener, origin) = listener().await;
        let (trust, consent) = fixture();
        support_store::apply(tmp.path(), Some(consent), &trust, 1000).unwrap();
        let c = test_collector(tmp.path().to_owned(), trust, origin).await;
        settled(&c).await;
        let (prepared, release) = c.delivery.hooks.before_send.arm();
        let done = collection(&c, 60);
        prepared.await.unwrap();
        tokio::time::advance(DEADLINE - Duration::from_secs(1)).await;
        done.await.unwrap();
        drop(release);
        assert!(futures_util::FutureExt::now_or_never(listener.accept()).is_none());
        assert_eq!(
            support_store::recent(&tmp.path().join("support"))
                .unwrap()
                .last()
                .unwrap()
                .outcome,
            Outcome::Failed
        );
    })
    .await;
}

#[tokio::test]
async fn only_admitted_refusals_post_and_reconnect_does_not_refill() {
    bounded(async {
        let _clock = freeze_time();
        let tmp = support_log::capture::private_tempdir();
        let (listener, origin) = listener().await;
        let (trust, _) = fixture();
        let c = test_collector(tmp.path().to_owned(), trust.clone(), origin).await;
        settled(&c).await;
        // Keep audit completion explicit; concurrent audit contention is allowed
        // to fail closed. Frozen time gives all three frames the same bucket time.
        for _ in 0..3 {
            let done = collection(&c, 60);
            let (mut socket, _) = listener.accept().await.unwrap();
            let (_, body) = receive_request(&mut socket).await;
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&body).unwrap()["declined"],
                "not_consented"
            );
            socket
                .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
            done.await.unwrap();
        }
        for _ in 0..3 {
            c.collect(Uuid::new_v4(), 60);
        }
        assert_eq!(c.delivery.status().dropped_requests, 3);
        c.fence();
        c.trust(Arc::new(trust), None, None);
        settled(&c).await;
        c.collect(Uuid::new_v4(), 60);
        assert_eq!(c.delivery.status().dropped_requests, 4);
        assert!(futures_util::FutureExt::now_or_never(listener.accept()).is_none());
    })
    .await;
}

/// Real-clock deadline also works when Tokio time is frozen for pacing tests.
/// Dropping the sender releases the watchdog immediately on success or panic.
pub(crate) async fn bounded<T>(future: impl std::future::Future<Output = T>) -> T {
    let (cancel, wait) = std::sync::mpsc::channel::<()>();
    let (expired, timeout) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        if wait.recv_timeout(Duration::from_secs(10)).is_err() {
            let _ = expired.send(());
        }
    });
    let result = tokio::select! {
        result = future => result,
        _ = timeout => panic!("support test exceeded its real-clock deadline"),
    };
    drop(cancel);
    result
}

#[tokio::test]
async fn five_thousand_revocations_preserve_connection_admission_and_deny_support() {
    bounded(async {
        let (trust, consent) = fixture();
        let keys: Vec<String> = (0u32..5000)
            .map(|n| {
                let mut seed = [42; 32];
                seed[..4].copy_from_slice(&n.to_be_bytes());
                URL_SAFE_NO_PAD.encode(SigningKey::from_bytes(&seed).verifying_key().as_bytes())
            })
            .collect();
        let mut rtc = spawnd::endorsement_chain::RevocationSet::from_keys(keys.iter().map(|key| {
            spawnd::signed_signal::public_key_from_wire(key)
                .unwrap()
                .to_bytes()
        }));
        assert_eq!(rtc.len(), 5000);
        let signer =
            spawnd::signed_signal::public_key_from_wire(&consent.signer_public_key).unwrap();
        assert!(!rtc.contains(&signer.to_bytes()));
        assert!(crate::run::admitted_device(
            &signer,
            &trust.pins,
            trust.account.as_ref(),
            &rtc,
            &[],
            None
        ));
        let revoked = spawnd::signed_signal::public_key_from_wire(&keys[4999]).unwrap();
        assert!(rtc.contains(&revoked.to_bytes()));
        assert!(!crate::run::admitted_device(
            &revoked,
            &trust.pins,
            trust.account.as_ref(),
            &rtc,
            &[],
            None
        ));
        let tmp = support_log::capture::private_tempdir();
        let c = test_collector(tmp.path().to_owned(), trust.clone(), String::new()).await;
        settled(&c).await;
        c.trust(Arc::new(trust), None, Some(Arc::new(keys)));
        c.tx.closed().await;
        assert!(c.delivery.status().permanent_deny);
        assert_eq!(rtc.len(), 5000);
        assert!(!rtc.contains(&signer.to_bytes()));
        assert!(crate::run::support_test_connection_admission(&rtc));
        rtc.insert(signer.to_bytes());
        assert!(!crate::run::support_test_connection_admission(&rtc));
    })
    .await;
}

#[tokio::test]
async fn alternating_consent_exhausts_control_budget_and_requires_restart() {
    bounded(async {
        let tmp = support_log::capture::private_tempdir();
        let (trust, consent) = fixture();
        let c = test_collector(tmp.path().to_owned(), trust.clone(), String::new()).await;
        settled(&c).await;
        for n in 0..support_store::CONTROL_WRITES {
            c.consent(if n % 2 == 0 {
                Some(consent.clone())
            } else {
                None
            });
            settled(&c).await;
            assert_eq!(
                support_store::load(tmp.path(), &trust, 1000)
                    .unwrap()
                    .server_off,
                n % 2 != 0
            );
        }
        c.consent(Some(consent));
        c.tx.closed().await;
        assert!(c.delivery.status().permanent_deny);
        assert!(
            support_store::load(tmp.path(), &trust, 1000)
                .unwrap()
                .server_off
        );
    })
    .await;
}

pub(crate) async fn stall_io(c: &Collector) -> std::sync::mpsc::Sender<()> {
    let (release, hold) = std::sync::mpsc::channel::<()>();
    let (entered, ready) = tokio::sync::oneshot::channel();
    let io = Arc::clone(&c.delivery.io);
    tokio::spawn(async move {
        let _ = io
            .run(
                tokio::time::Instant::now() + Duration::from_millis(10),
                move || {
                    let _ = entered.send(());
                    let _ = hold.recv_timeout(Duration::from_secs(10));
                },
            )
            .await;
    });
    ready.await.unwrap();
    release
}

#[tokio::test]
async fn overdue_io_blocks_admission_and_retains_the_unfinished_job() {
    bounded(async {
        let _clock = freeze_time();
        let tmp = support_log::capture::private_tempdir();
        let (trust, _) = fixture();
        let c = test_collector(tmp.path().to_owned(), trust, String::new()).await;
        settled(&c).await;
        let release = stall_io(&c).await;
        tokio::time::advance(Duration::from_millis(20)).await;
        assert!(c.delivery.status().io_overdue);
        assert!(collection(&c, 60).await.is_err());
        assert!(!tmp.path().join("support/sent.jsonl").exists());
        let invoked = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&invoked);
        assert!(c
            .delivery
            .io
            .run(tokio::time::Instant::now() + IO_DEADLINE, move || flag
                .store(true, Ordering::SeqCst))
            .await
            .is_err());
        assert!(!invoked.load(Ordering::SeqCst));
        drop(release);
    })
    .await;
}

#[tokio::test]
async fn stalled_initialization_returns_absent_at_deadline() {
    bounded(async {
        let tmp = support_log::capture::private_tempdir();
        let io = Worker::start().unwrap();
        let (release, hold) = std::sync::mpsc::channel::<()>();
        let (entered, ready) = tokio::sync::oneshot::channel();
        let init = Collector::initialize(tmp.path().to_owned(), String::new(), Arc::clone(&io), move || {
            let _ = entered.send(());
            let _ = hold.recv_timeout(Duration::from_secs(10));
            None
        });
        tokio::pin!(init);
        tokio::select! { _ = &mut init => panic!("initialization escaped its blocked worker"), _ = ready => {} }
        assert!(init.await.is_none());
        assert!(io.overdue());
        drop(release);
    }).await;
}

#[test]
fn stuck_support_job_does_not_hold_runtime_shutdown() {
    let (release, hold) = std::sync::mpsc::channel::<()>();
    let (finished, shutdown) = std::sync::mpsc::channel();
    let owner = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let io = Worker::start().unwrap();
            let (entered, ready) = tokio::sync::oneshot::channel();
            let job = io.run(tokio::time::Instant::now() + IO_DEADLINE, move || {
                let _ = entered.send(());
                let _ = hold.recv_timeout(Duration::from_secs(10));
            });
            tokio::pin!(job);
            tokio::select! { _ = &mut job => panic!("job did not stall"), _ = ready => {} }
            // Drop the caller while the worker still owns the job.
        });
        drop(runtime);
        finished.send(()).unwrap();
    });
    shutdown
        .recv_timeout(Duration::from_secs(3))
        .expect("runtime waited for support filesystem job");
    drop(release);
    owner.join().unwrap();
}

#[tokio::test]
async fn independent_disk_off_is_seen_by_the_final_authorisation_read() {
    bounded(async {
        let tmp = support_log::capture::private_tempdir();
        let (listener, origin) = listener().await;
        let (trust, consent) = fixture();
        support_store::apply(tmp.path(), Some(consent), &trust, 1000).unwrap();
        let c = test_collector(tmp.path().to_owned(), trust.clone(), origin).await;
        settled(&c).await;
        let (prepared, release) = c.delivery.hooks.before_send.arm();
        let done = collection(&c, 60);
        prepared.await.unwrap();
        // Independent writer, no process-local generation notification.
        support_store::apply(tmp.path(), None, &trust, 1000).unwrap();
        release.send(()).unwrap();
        done.await.unwrap();
        assert!(futures_util::FutureExt::now_or_never(listener.accept()).is_none());
    })
    .await;
}

#[tokio::test]
async fn terminal_audit_timeout_retains_job_and_blocks_more_collection() {
    bounded(async {
        let _clock = freeze_time();
        let tmp = support_log::capture::private_tempdir();
        let (listener, origin) = listener().await;
        let (trust, consent) = fixture();
        support_store::apply(tmp.path(), Some(consent), &trust, 1000).unwrap();
        let c = test_collector(tmp.path().to_owned(), trust, origin).await;
        settled(&c).await;
        let (auditing, release) = c.delivery.hooks.audit.arm();
        let done = collection(&c, 60);
        let (mut socket, _) = listener.accept().await.unwrap();
        receive_request(&mut socket).await;
        socket
            .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        auditing.await.unwrap();
        tokio::time::advance(DEADLINE + Duration::from_millis(1)).await;
        done.await.unwrap();
        assert!(c.delivery.status().io_overdue);
        assert!(collection(&c, 60).await.is_err());
        assert!(futures_util::FutureExt::now_or_never(listener.accept()).is_none());
        drop(release);
    })
    .await;
}

#[tokio::test]
async fn later_inputs_cannot_shorten_pending_input_retry_interval() {
    bounded(async {
        let _clock = freeze_time();
        let tmp = support_log::capture::private_tempdir();
        let (trust, mut consent) = fixture();
        let c = test_collector(tmp.path().to_owned(), trust, String::new()).await;
        settled(&c).await;
        let before = c.delivery.hooks.apply_attempts.load(Ordering::SeqCst);
        consent.signature.clear();
        c.consent(Some(consent));
        c.delivery.hooks.apply_failed.notified().await;
        c.fence();
        tokio::time::advance(Duration::from_millis(9)).await;
        c.fence();
        assert_eq!(
            c.delivery.hooks.apply_attempts.load(Ordering::SeqCst),
            before + 1
        );
        tokio::time::advance(Duration::from_millis(2)).await;
        c.delivery.hooks.apply_failed.notified().await;
        assert_eq!(
            c.delivery.hooks.apply_attempts.load(Ordering::SeqCst),
            before + 2
        );
        c.fence();
        tokio::time::advance(Duration::from_millis(19)).await;
        assert_eq!(
            c.delivery.hooks.apply_attempts.load(Ordering::SeqCst),
            before + 2
        );
    })
    .await;
}

#[tokio::test]
async fn expired_io_deadline_never_enqueues_a_job() {
    bounded(async {
        let io = Worker::start().unwrap();
        let invoked = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&invoked);
        assert!(io
            .run(
                tokio::time::Instant::now() - Duration::from_secs(1),
                move || flag.store(true, Ordering::SeqCst)
            )
            .await
            .is_err());
        assert!(!invoked.load(Ordering::SeqCst));
    })
    .await;
}
