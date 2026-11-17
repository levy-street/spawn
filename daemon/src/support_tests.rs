use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::SigningKey;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

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
    let trust = Trust {
        record,
        account: Some([1; 16]),
        revoked: RevocationSet::new(),
    };
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

pub(crate) fn test_collector(config: PathBuf, trust: Trust, origin: String) -> Collector {
    let path = config.join("support");
    let log = support_log::SupportLog::open(&path).unwrap();
    let subscriber =
        tracing_subscriber::layer::SubscriberExt::with(tracing_subscriber::registry(), log.layer());
    tracing::subscriber::with_default(subscriber, || tracing::info!(count = 1, "test event"));
    Collector::start_at(config, path, Some(log), "00000000".into(), trust, origin)
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
async fn actual_upload_is_bounded_gzip_with_headers_and_the_next_is_a_json_refusal() {
    let tmp = support_log::capture::private_tempdir();
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (trust, consent) = fixture();
    support_store::apply(tmp.path(), Some(consent), &trust, 1000).unwrap();
    let collector = test_collector(tmp.path().to_owned(), trust, origin);
    let id = Uuid::new_v4();
    collector.collect(id, 0).unwrap();
    let (mut stream, _) = tokio::time::timeout(Duration::from_secs(10), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let (headers, body) = receive_request(&mut stream).await;
    assert!(headers.starts_with(&format!("POST /api/support-log/uploads/{id} ")));
    let lower = headers.to_lowercase();
    assert!(lower.contains("authorization: bearer test-token\r\n"));
    assert!(lower.contains("content-type: application/gzip\r\n"));
    let digest: String = Sha256::digest(&body)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert!(lower.contains(&format!("x-spawn-support-log-sha256: {digest}\r\n")));
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
    assert!(raw.len() <= support_log::MAX_RAW_BYTES);
    // Hold the first response: the next request gets a refusal, never a second bundle.
    collector.collect(Uuid::new_v4(), i64::MAX).unwrap();
    let (mut second, _) = tokio::time::timeout(Duration::from_secs(10), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let (headers, body) = receive_request(&mut second).await;
    assert!(headers
        .to_lowercase()
        .contains("content-type: application/json"));
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap()["declined"],
        "rate_limited"
    );
    second
        .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    stream
        .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    assert!(support_store::recent(&collector.context.path)
        .unwrap()
        .iter()
        .any(|r| r.window == 259200 && r.outcome == Outcome::RateLimited));
}

#[test]
fn all_authorization_refusals_and_current_revocation_are_checked() {
    let tmp = support_log::capture::private_tempdir();
    let (trust, consent) = fixture();
    let ctx = Context {
        config: tmp.path().to_owned(),
        path: tmp.path().join("support"),
        source: None,
        instance: "00000000".into(),
        trust: ArcSwap::from_pointee(trust.clone()),
        epoch: AtomicU64::new(0),
        denied: AtomicBool::new(false),
    };
    assert_eq!(authorize(&ctx), Err(Refusal::NotConsented));
    support_store::apply(tmp.path(), Some(consent.clone()), &trust, 1000).unwrap();
    assert!(authorize(&ctx).is_ok());
    assert!(matches!(
        prepare(&ctx, Uuid::new_v4(), 60),
        Err(Refusal::NoLog)
    ));
    let mut revoked = trust.clone();
    revoked
        .revoked
        .insert(SigningKey::from_bytes(&[7; 32]).verifying_key().to_bytes());
    ctx.trust.store(Arc::new(revoked));
    assert_eq!(authorize(&ctx), Err(Refusal::SignerUntrusted));
    ctx.trust.store(Arc::new(trust.clone()));
    support_store::apply(tmp.path(), None, &trust, 1000).unwrap();
    assert_eq!(authorize(&ctx), Err(Refusal::NotConsented));
    support_store::apply(tmp.path(), Some(consent), &trust, 1000).unwrap();
    assert!(authorize(&ctx).is_ok());
    ctx.denied.store(true, Ordering::SeqCst);
    assert_eq!(authorize(&ctx), Err(Refusal::NotConsented));
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
        &trust.record,
        trust.account.as_ref(),
        &trust.revoked,
        &consent.carried_endorsements
    ));
    let mut revoked = trust.clone();
    revoked.revoked.insert(root.verifying_key().to_bytes());
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
    assert_eq!(url.path(), format!("/api/support-log/uploads/{id}"));
    assert!(url.query().is_none() && url.fragment().is_none());
    assert!(endpoint("http://example.invalid", id).is_err());
    assert!(endpoint("https://user:password@example.invalid", id).is_err());
}
