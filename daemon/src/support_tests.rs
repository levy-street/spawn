use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::SigningKey;
use std::sync::atomic::AtomicBool;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

// A parked blocking task inhibits Tokio auto-advance while loopback IO and
// explicit signals run. Only advance() moves deadlines; dropping this sender
// releases the task even when an assertion panics.
pub(crate) fn freeze_time() -> std::sync::mpsc::Sender<()> {
    tokio::time::pause();
    let (tx, rx) = std::sync::mpsc::channel();
    tokio::task::spawn_blocking(move || {
        let _ = rx.recv_timeout(Duration::from_secs(30));
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
        *self.0.try_lock().expect("test gate busy") = Some((entered, resume));
        (wait, release)
    }
    pub(super) async fn pause(&self) {
        let gate = self.0.try_lock().expect("test gate busy").take();
        if let Some((entered, resume)) = gate {
            let _ = entered.send(());
            let _ = tokio::time::timeout(Duration::from_secs(10), resume).await;
        }
    }
}
#[derive(Default)]
pub(super) struct Hooks {
    pub resolve: IoPause,
    pub after_apply: Pause,
    pub before_send: Pause,
    pub before_claim: Pause,
    pub apply: IoPause,
    pub prepare: IoPause,
    pub audit: IoPause,
    pub panic: AtomicBool,
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
        *self.0.try_lock().expect("test gate busy") = Some((entered, hold));
        (ready, release)
    }
    pub(super) fn pause(&self) -> bool {
        let gate = self.0.try_lock().expect("test gate busy").take();
        if let Some((entered, hold)) = gate {
            let _ = entered.send(());
            let _ = hold.recv_timeout(Duration::from_secs(30));
            return true;
        }
        false
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
    let collector = Collector::start_ready(
        config,
        path,
        Some(log),
        "00000000".into(),
        origin,
        Worker::start().unwrap(),
    )
    .unwrap();
    collector.trust(Arc::new(trust), None, None);
    collector
}
pub(crate) async fn settled(c: &Collector) {
    let (tx, rx) = tokio::sync::oneshot::channel();
    bounded(async {
        c.tx.send(Command::Barrier(tx)).await.unwrap();
        rx.await.unwrap();
    })
    .await;
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
    assert!(length <= support_log::MAX_BODY_BYTES);
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
        // This exact fixture path must also be used on Windows.
        std::fs::write(tmp.path().join("state.json"), br#"{"pid":1,"version":"0.1.0","connected":true,"connected_at":null,"server":"","last_error":null,"sessions":7}"#).unwrap();
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
            .contains("content-type: application/x-ndjson"));
        let raw = std::str::from_utf8(&body).unwrap();
        let header: serde_json::Value = serde_json::from_str(raw.lines().next().unwrap()).unwrap();
        assert_eq!(header["bytes"], raw.len());
        assert_eq!(header["state"]["sessions"], 7);
        assert!(!headers.to_lowercase().contains("x-spawn-support-log-raw-bytes"));
        let digest: String = Sha256::digest(&body).iter().map(|b| format!("{b:02x}")).collect();
        assert!(headers.to_lowercase().contains(&format!("x-spawn-support-log-sha256: {digest}\r\n")));
        assert_eq!(header["lines"], raw.lines().count() - 1);
        assert_eq!(
            header["window_to"].as_u64().unwrap() - header["window_from"].as_u64().unwrap(),
            60_000
        );
        assert!(body.len() <= support_log::MAX_BODY_BYTES);
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
        assert!(c.delivery.status().denied.is_some());
        release.send(()).unwrap();
        settled(&c).await;
        c.trust(Arc::new(trust), None, None);
        settled(&c).await;
        assert!(c.delivery.status().denied.is_some());
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
        drop(release);
        done.await.unwrap();
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
        let unavailable = Collector::start_ready(
            tmp.path().to_owned(),
            unavailable,
            None,
            "00000000".into(),
            String::new(),
            Worker::start().unwrap(),
        )
        .unwrap();
        settled(&unavailable).await;
        assert_eq!(unavailable.delivery.status().denied, None);
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
        drop(release);
        done.await.unwrap();
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
        support_store::apply(tmp.path(), None, &trust, 1000).unwrap();
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
        settled(&c).await;
        assert_eq!(c.delivery.status().dropped_requests, 3);
        c.fence();
        c.trust(Arc::new(trust), None, None);
        settled(&c).await;
        c.collect(Uuid::new_v4(), 60);
        settled(&c).await;
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
        if wait.recv_timeout(Duration::from_secs(30)).is_err() {
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
        settled(&c).await;
        assert!(c.delivery.status().denied.is_some());
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
        settled(&c).await;
        assert!(c.delivery.status().denied.is_some());
        assert_eq!(authorize(tmp.path(), &trust), Err(Refusal::NotConsented));
    })
    .await;
}

pub(crate) async fn stall_io(c: &Collector) -> std::sync::mpsc::Sender<()> {
    let (ready, release) = c.delivery.hooks.apply.arm();
    let (trust, _) = fixture();
    c.trust(Arc::new(trust), None, None);
    bounded(ready).await.unwrap();
    release
}

#[tokio::test]
async fn early_trust_and_revocation_are_applied_in_order() {
    bounded(async {
        let tmp = support_log::capture::private_tempdir();
        let (listener, origin) = listener().await;
        let (trust, consent) = fixture();
        support_store::apply(tmp.path(), Some(consent.clone()), &trust, 1000).unwrap();
        let c = Collector::start_ready(
            tmp.path().to_owned(),
            tmp.path().join("support"),
            None,
            "00000000".into(),
            origin,
            Worker::start().unwrap(),
        )
        .unwrap();
        let (ready, release) = c.delivery.hooks.apply.arm();
        c.trust(Arc::new(trust.clone()), None, None);
        c.update(&Arc::new(crate::proto::SupportUpdate {
            revoked_browser_keys: Some(vec![consent.signer_public_key]),
            ..Default::default()
        }));
        let done = collection(&c, 60);
        ready.await.unwrap();
        release.send(()).unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let (_, body) = receive_request(&mut socket).await;
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap()["declined"],
            "signer_untrusted"
        );
        socket
            .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        done.await.unwrap();
        assert!(c.delivery.status().denied.is_none());
        assert_eq!(authorize(tmp.path(), &trust), Err(Refusal::SignerUntrusted));
    })
    .await;
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
    join_thread(owner).unwrap();
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
        assert_eq!(c.delivery.status().denied, Some(Denied::Deadline));
        assert!(collection(&c, 60).await.is_err());
        assert!(futures_util::FutureExt::now_or_never(listener.accept()).is_none());
        drop(release);
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

/// Join only after a real-clock bounded completion check.
pub(crate) fn join_thread<T>(thread: std::thread::JoinHandle<T>) -> std::thread::Result<T> {
    let end = std::time::Instant::now() + Duration::from_secs(10);
    while !thread.is_finished() {
        assert!(
            std::time::Instant::now() < end,
            "test thread did not finish"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    thread.join()
}

#[tokio::test]
async fn combined_update_write_failure_is_terminal_and_retains_no_on() {
    bounded(async {
        let _clock = freeze_time();
        let tmp = support_log::capture::private_tempdir();
        let (listener, origin) = listener().await;
        let (trust, mut consent) = fixture();
        support_store::apply(tmp.path(), Some(consent.clone()), &trust, 1000).unwrap();
        let c = test_collector(tmp.path().to_owned(), trust.clone(), origin).await;
        settled(&c).await;
        let lock = spawnd::secret_file::SecretFile::new("test", ".test.", 65536)
            .try_lock_file(&tmp.path().join("support-log-consent.lock"))
            .unwrap();
        c.update(&Arc::new(crate::proto::SupportUpdate {
            revoked_browser_keys: Some(vec![consent.signer_public_key.clone()]),
            consent: crate::proto::ConsentInput::Valid(consent.clone()),
            ..Default::default()
        }));
        consent.issued_at_ms += 1;
        consent.sign(&SigningKey::from_bytes(&[7; 32])).unwrap();
        c.consent(Some(consent));
        // Wait boundedly, but release the held lock before any assertion.
        let (tx, rx) = tokio::sync::oneshot::channel();
        c.tx.send(Command::Barrier(tx)).await.unwrap();
        let result = tokio::time::timeout(Duration::from_secs(5), rx).await;
        drop(lock);
        result.unwrap().unwrap();
        assert_eq!(c.delivery.status().denied, Some(Denied::Lock));
        assert!(!tmp.path().join("support-log-consent.json").exists());
        assert!(collection(&c, 60).await.is_err());
        assert!(futures_util::FutureExt::now_or_never(listener.accept()).is_none());
    })
    .await;
}

#[tokio::test]
async fn off_during_preparation_finishes_job_then_later_on_applies() {
    bounded(async {
        let tmp = support_log::capture::private_tempdir();
        let (listener, origin) = listener().await;
        let (trust, mut consent) = fixture();
        support_store::apply(tmp.path(), Some(consent.clone()), &trust, 1000).unwrap();
        let c = test_collector(tmp.path().to_owned(), trust.clone(), origin).await;
        settled(&c).await;
        let (preparing, release) = c.delivery.hooks.prepare.arm();
        let done = collection(&c, 60);
        preparing.await.unwrap();
        c.consent(None);
        release.send(()).unwrap();
        done.await.unwrap();
        settled(&c).await;
        assert_eq!(authorize(tmp.path(), &trust), Err(Refusal::NotConsented));
        consent.issued_at_ms += 1;
        consent.sign(&SigningKey::from_bytes(&[7; 32])).unwrap();
        c.consent(Some(consent));
        settled(&c).await;
        assert!(authorize(tmp.path(), &trust).is_ok());
        assert!(c.delivery.status().denied.is_none());
        assert!(futures_util::FutureExt::now_or_never(listener.accept()).is_none());
        let receipts = support_store::recent(&tmp.path().join("support")).unwrap();
        assert_eq!(receipts.first().unwrap().outcome, Outcome::Started);
        assert_eq!(receipts.last().unwrap().outcome, Outcome::Cancelled);
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delivery_between_final_authorisation_and_atomic_claim_opens_no_connection() {
    bounded(async {
        let tmp = support_log::capture::private_tempdir();
        let (listener, origin) = listener().await;
        let (trust, consent) = fixture();
        support_store::apply(tmp.path(), Some(consent), &trust, 1000).unwrap();
        let c = test_collector(tmp.path().to_owned(), trust, origin).await;
        settled(&c).await;
        let (authorized, release) = c.delivery.hooks.before_claim.arm();
        let done = collection(&c, 60);
        authorized.await.unwrap();
        c.consent(None);
        release.send(()).unwrap();
        done.await.unwrap();
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
async fn worker_panic_is_explicit_terminal_denial() {
    bounded(async {
        let tmp = support_log::capture::private_tempdir();
        let (trust, consent) = fixture();
        let c = test_collector(tmp.path().to_owned(), trust, String::new()).await;
        settled(&c).await;
        c.delivery.hooks.panic.store(true, Ordering::SeqCst);
        c.consent(Some(consent));
        settled(&c).await;
        assert_eq!(c.delivery.status().denied, Some(Denied::WorkerStopped));
        assert!(collection(&c, 60).await.is_err());
        let io = Worker::start().unwrap();
        assert_eq!(
            io.run(tokio::time::Instant::now() + IO_DEADLINE, || panic!(
                "worker test"
            ))
            .await,
            Err(crate::support_io::Error::Stopped)
        );
        assert_eq!(
            io.run(tokio::time::Instant::now() + IO_DEADLINE, || ())
                .await,
            Err(crate::support_io::Error::Stopped)
        );
    })
    .await;
}

#[test]
fn exhausted_generation_cannot_claim_a_request_start() {
    let delivery = Arc::new(Delivery::new());
    delivery.word.store(u64::MAX - 1, Ordering::SeqCst);
    let stop = Stop {
        delivery: Arc::clone(&delivery),
        generation: u64::MAX - 1,
    };
    delivery.advance();
    assert!(!stop.claim_start());
    assert_eq!(delivery.status().denied, Some(Denied::GenerationExhausted));
}

#[tokio::test]
async fn absent_statement_collect_creates_nothing_and_opens_no_socket() {
    bounded(async {
        let tmp = support_log::capture::private_tempdir();
        let (listener, origin) = listener().await;
        let mut origin = url::Url::parse(&origin).unwrap();
        origin.set_scheme("https").unwrap();
        origin.set_host(Some("localhost")).unwrap();
        let c = Collector::start_ready(
            tmp.path().to_owned(),
            tmp.path().join("support"),
            None,
            "00000000".into(),
            origin.to_string(),
            Worker::start().unwrap(),
        )
        .unwrap();
        let (mut resolving, _release) = c.delivery.hooks.resolve.arm();
        let (mut preparing, _release) = c.delivery.hooks.prepare.arm();
        let frame = crate::proto::parse_inbound(&format!(
            r#"{{"type":"support_log.collect","request_id":"{}","since_seconds":60}}"#,
            Uuid::new_v4()
        ))
        .unwrap();
        if let crate::proto::Inbound::SupportLogCollect {
            request_id,
            since_seconds,
        } = frame
        {
            c.collect(request_id, since_seconds);
        } else {
            panic!("collection frame not parsed");
        }
        settled(&c).await;
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0);
        assert!(matches!(
            resolving.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        assert!(matches!(
            preparing.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        assert!(futures_util::FutureExt::now_or_never(listener.accept()).is_none());
        assert_eq!(c.delivery.status().dropped_requests, 1);
        assert_eq!(c.delivery.status().denied, None);
    })
    .await;
}

#[test]
fn stalled_collection_and_refusal_dns_do_not_hold_runtime_shutdown() {
    for enabled in [true, false] {
        let tmp = support_log::capture::private_tempdir();
        let config = tmp.path().to_owned();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (finished, shutdown) = std::sync::mpsc::channel();
        let owner = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(bounded(async {
                let (trust, consent) = fixture();
                support_store::apply(&config, enabled.then_some(consent), &trust, 1000).unwrap();
                let c = test_collector(config.clone(), trust, "https://localhost".into()).await;
                settled(&c).await;
                let (resolving, release) = c.delivery.hooks.resolve.arm();
                release_tx.send(release).unwrap();
                let done = collection(&c, 60);
                resolving.await.unwrap();
                let receipts = support_store::recent(&config.join("support")).unwrap();
                assert_eq!(
                    receipts.last().unwrap().outcome,
                    if enabled {
                        Outcome::Started
                    } else {
                        Outcome::NotConsented
                    }
                );
                let delivery = Arc::clone(&c.delivery);
                drop(c);
                done.await.unwrap();
                // The audit cannot queue behind the unfinished lookup.
                assert_eq!(delivery.status().denied, Some(Denied::Deadline));
            }));
            drop(runtime);
            finished.send(()).unwrap();
        });
        let release = release_rx.recv_timeout(Duration::from_secs(30)).unwrap();
        let result = shutdown.recv_timeout(Duration::from_secs(10));
        drop(release); // release even if the bounded shutdown check failed
        join_thread(owner).unwrap();
        result.expect("runtime waited for the collector's OS lookup");
    }
}

#[tokio::test]
async fn three_slow_queued_collections_drop_expiry_without_denying() {
    bounded(async {
        let _clock = freeze_time();
        let tmp = support_log::capture::private_tempdir();
        let (listener, origin) = listener().await;
        let (trust, consent) = fixture();
        support_store::apply(tmp.path(), Some(consent), &trust, 1000).unwrap();
        let c = test_collector(tmp.path().to_owned(), trust.clone(), origin).await;
        settled(&c).await;
        let first = collection(&c, 60);
        let second = collection(&c, 60);
        let third = collection(&c, 60);
        let (mut socket, _) = listener.accept().await.unwrap();
        receive_request(&mut socket).await;
        tokio::time::advance(Duration::from_secs(16)).await;
        first.await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let (_, body) = receive_request(&mut socket).await;
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap()["declined"],
            "rate_limited"
        );
        let (mut preparing, _release) = c.delivery.hooks.prepare.arm();
        tokio::time::advance(Duration::from_secs(13)).await;
        second.await.unwrap();
        assert!(third.await.is_err());
        settled(&c).await;
        assert!(matches!(
            preparing.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        assert_eq!(c.delivery.status().denied, None);
        assert_eq!(c.delivery.status().dropped_requests, 1);
        assert!(authorize(tmp.path(), &trust).is_ok());
        assert_eq!(
            support_store::recent(&tmp.path().join("support"))
                .unwrap()
                .len(),
            4
        );
        assert!(futures_util::FutureExt::now_or_never(listener.accept()).is_none());
        c.consent(None);
        settled(&c).await;
        assert_eq!(c.delivery.status().denied, None);
        assert_eq!(authorize(tmp.path(), &trust), Err(Refusal::NotConsented));
    })
    .await;
}

#[tokio::test]
async fn collect_admission_full_queue_and_busy_gate_only_drop() {
    bounded(async {
        let _clock = freeze_time();
        let tmp = support_log::capture::private_tempdir();
        let (trust, _) = fixture();
        let c = test_collector(tmp.path().to_owned(), trust.clone(), String::new()).await;
        settled(&c).await;
        let (entered, release) = c.delivery.hooks.after_apply.arm();
        c.trust(Arc::new(trust), None, None);
        entered.await.unwrap();
        for _ in 0..QUEUE {
            c.fence();
        }
        let generation = c.delivery.generation();
        for _ in 0..4 {
            c.collect(Uuid::new_v4(), 60);
        }
        {
            let _gate = c.gate.lock().unwrap();
            c.collect(Uuid::new_v4(), 60);
        }
        assert_eq!(c.delivery.generation(), generation);
        assert_eq!(c.delivery.status().denied, None);
        assert_eq!(c.delivery.status().dropped_requests, 5);
        release.send(()).unwrap();
        settled(&c).await;
        c.consent(None);
        settled(&c).await;
        assert_eq!(c.delivery.status().denied, None);
    })
    .await;
}

#[test]
fn drop_count_is_today_only() {
    let delivery = Delivery::new();
    let yesterday = support_log::now_unix_millis() / 86_400_000 - 1;
    delivery
        .dropped
        .store(yesterday << 32 | 7, Ordering::Relaxed);
    assert_eq!(delivery.status().dropped_requests, 0);
    delivery.drop_request();
    assert_eq!(delivery.status().dropped_requests, 1);
}
