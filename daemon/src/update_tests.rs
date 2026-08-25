use super::*;

use std::sync::atomic::AtomicBool;

use base64::Engine;
use sha2::{Digest, Sha256};
use tempfile::tempdir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn manifest_request() -> UpdateRequest {
    UpdateRequest {
        request_id: Some("request-1".into()),
        version: "0.1.0+gnew".into(),
        tree: "b".repeat(40),
        target: "darwin-aarch64".into(),
        spawnd: DaemonUpdateArtifact {
            path: "/api/install/spawnd/darwin-aarch64".into(),
            sha256: "c".repeat(64),
        },
        spawn_worker: DaemonUpdateArtifact {
            path: "/api/install/spawn-worker/darwin-aarch64".into(),
            sha256: "d".repeat(64),
        },
        allow_downgrade: false,
    }
}

fn signed_manifest(
    signing_key: &ed25519_dalek::SigningKey,
    counter: u64,
) -> (Vec<u8>, String, String) {
    use ed25519_dalek::Signer;

    let public_key = URL_SAFE_NO_PAD.encode(signing_key.verifying_key().to_bytes());
    let key_id =
        digest_hex(&Sha256::digest(signing_key.verifying_key().to_bytes()))[..8].to_string();
    let bytes = serde_json::to_vec(&serde_json::json!({
        "commit": "a".repeat(40),
        "tree": "b".repeat(40),
        "version": "0.1.0+gnew",
        "release_counter": counter,
        "signing_key_id": key_id,
        "targets": {
            "darwin-aarch64": {
                "spawnd_sha256": "c".repeat(64),
                "spawn_worker_sha256": "d".repeat(64)
            }
        }
    }))
    .unwrap();
    let signature = URL_SAFE_NO_PAD.encode(signing_key.sign(&bytes).to_bytes());
    (bytes, signature, public_key)
}

#[test]
fn signed_manifest_accepts_exact_bytes_and_rejects_bad_missing_or_wrong_signatures() {
    use ed25519_dalek::Signer;

    let key = ed25519_dalek::SigningKey::from_bytes(&[7; 32]);
    let wrong = ed25519_dalek::SigningKey::from_bytes(&[8; 32]);
    let (manifest, signature, public_key) = signed_manifest(&key, 2_000);
    let request = manifest_request();
    verify_manifest_bytes(
        &manifest,
        Some(signature.as_bytes()),
        &request,
        "darwin-aarch64",
        false,
        &[&public_key],
        Some(1_000),
    )
    .unwrap();

    let missing = verify_manifest_bytes(
        &manifest,
        None,
        &request,
        "darwin-aarch64",
        false,
        &[&public_key],
        Some(1_000),
    )
    .unwrap_err();
    assert_eq!(
        (missing.stage, missing.error),
        (UpdateStage::Verify, "manifest_unsigned")
    );

    let mut bad = signature.into_bytes();
    bad[0] = if bad[0] == b'A' { b'B' } else { b'A' };
    let failure = verify_manifest_bytes(
        &manifest,
        Some(&bad),
        &request,
        "darwin-aarch64",
        false,
        &[&public_key],
        Some(1_000),
    )
    .unwrap_err();
    assert_eq!(failure.error, "manifest_bad_signature");

    let wrong_key = URL_SAFE_NO_PAD.encode(wrong.verifying_key().to_bytes());
    let valid_signature = URL_SAFE_NO_PAD.encode(key.sign(&manifest).to_bytes());
    let failure = verify_manifest_bytes(
        &manifest,
        Some(valid_signature.as_bytes()),
        &request,
        "darwin-aarch64",
        false,
        &[&wrong_key],
        Some(1_000),
    )
    .unwrap_err();
    assert_eq!(failure.error, "manifest_bad_signature");
}

#[test]
fn manifest_mismatch_counter_guard_downgrade_and_escape_hatch_are_stable() {
    let key = ed25519_dalek::SigningKey::from_bytes(&[7; 32]);
    let (older, signature, public_key) = signed_manifest(&key, 500);
    let mut request = manifest_request();
    let downgrade = verify_manifest_bytes(
        &older,
        Some(signature.as_bytes()),
        &request,
        "darwin-aarch64",
        false,
        &[&public_key],
        Some(1_000),
    )
    .unwrap_err();
    assert_eq!(
        (downgrade.stage, downgrade.error),
        (UpdateStage::Precondition, "downgrade")
    );

    request.allow_downgrade = true;
    verify_manifest_bytes(
        &older,
        Some(signature.as_bytes()),
        &request,
        "darwin-aarch64",
        false,
        &[&public_key],
        Some(1_000),
    )
    .unwrap();

    request.allow_downgrade = false;
    let (equal, equal_signature, _) = signed_manifest(&key, 1_000);
    verify_manifest_bytes(
        &equal,
        Some(equal_signature.as_bytes()),
        &request,
        "darwin-aarch64",
        false,
        &[&public_key],
        Some(1_000),
    )
    .unwrap();

    verify_manifest_bytes(
        &older,
        None,
        &request,
        "darwin-aarch64",
        true,
        &[],
        Some(1_000),
    )
    .unwrap();

    request.spawnd.sha256 = "e".repeat(64);
    let mismatch = verify_manifest_bytes(
        &equal,
        Some(equal_signature.as_bytes()),
        &request,
        "darwin-aarch64",
        false,
        &[&public_key],
        Some(1_000),
    )
    .unwrap_err();
    assert_eq!(
        (mismatch.stage, mismatch.error),
        (UpdateStage::Verify, "manifest_mismatch")
    );
}

#[test]
fn worker_mismatch_bypasses_only_same_tree_idempotence() {
    assert!(same_tree_is_current("tree", "tree", false));
    assert!(!same_tree_is_current("tree", "tree", true));
    assert!(!same_tree_is_current("new", "old", false));
}

#[test]
fn install_url_join_accepts_only_server_local_install_paths() {
    let server = Url::parse("https://example.test/nested/base?ignored=yes").unwrap();
    let joined = join_install_url(&server, "/api/install/spawnd/darwin-aarch64").unwrap();
    assert_eq!(
        joined.as_str(),
        "https://example.test/api/install/spawnd/darwin-aarch64"
    );

    for rejected in [
        "https://evil.test/api/install/spawnd/darwin-aarch64",
        "//evil.test/api/install/spawnd/darwin-aarch64",
        "/api/release",
        "/api/install/../release",
        "/api/install/spawnd/darwin-aarch64?token=server-supplied",
        "/api/install/spawnd/darwin-aarch64#fragment",
        "/api/install\\spawnd\\darwin-aarch64",
    ] {
        let failure = join_install_url(&server, rejected).expect_err("path must be refused");
        assert_eq!(failure.stage, UpdateStage::Download);
        assert_eq!(failure.error, "invalid_path");
    }
}

#[test]
fn sha256_comparison_rejects_mismatch_and_malformed_values() {
    const HELLO_SHA256: &str = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    assert!(sha_matches(b"hello", HELLO_SHA256));
    assert!(sha_matches(b"hello", &HELLO_SHA256.to_uppercase()));
    assert!(!sha_matches(b"goodbye", HELLO_SHA256));
    assert!(!sha_matches(b"hello", "not-a-sha"));
}

#[cfg(unix)]
#[tokio::test]
async fn version_check_requires_success_and_expected_suffix() {
    let directory = tempdir().unwrap();
    let binary = directory.path().join("spawnd.tmp");
    fs::write(
        &binary,
        b"#!/bin/sh\nprintf 'spawnd 0.1.0+g123456789abc\\n'\n",
    )
    .unwrap();
    chmod_executable(&binary).unwrap();

    verify_version(&binary, "0.1.0+g123456789abc")
        .await
        .expect("matching clap-style version");
    let failure = verify_version(&binary, "0.1.0+gffffffffffff")
        .await
        .expect_err("wrong expected version must fail");
    assert_eq!(failure.stage, UpdateStage::Verify);
    assert_eq!(failure.error, "version_mismatch");
}

#[cfg(unix)]
#[tokio::test]
async fn worker_pair_check_requires_the_exact_shared_tree_stamp() {
    let directory = tempdir().unwrap();
    let worker = directory.path().join("spawn-worker");
    fs::write(
        &worker,
        format!(
            "#!/bin/sh\nprintf '%s\\n' '{}'\n",
            crate::version::worker_identity_line()
        ),
    )
    .unwrap();
    chmod_executable(&worker).unwrap();
    assert!(worker_pair_matches(&worker).await);

    fs::write(
        &worker,
        b"#!/bin/sh\nprintf 'spawn-worker wrong tree=wrong\\n'\n",
    )
    .unwrap();
    assert!(!worker_pair_matches(&worker).await);
}

#[test]
fn swap_rolls_back_when_the_second_rename_fails() {
    let directory = tempdir().unwrap();
    let live = directory.path().join("spawnd");
    let missing_temporary = directory.path().join("spawnd.tmp");
    fs::write(&live, b"old").unwrap();

    swap_one(&live, &missing_temporary).expect_err("missing replacement must fail");
    assert_eq!(fs::read(&live).unwrap(), b"old");
    assert!(!previous_path(&live).exists());
}

#[test]
fn worker_swap_failure_rolls_back_the_completed_daemon_swap() {
    let directory = tempdir().unwrap();
    let daemon = directory.path().join("spawnd");
    let daemon_temporary = directory.path().join("spawnd.tmp");
    let worker = directory.path().join("spawn-worker");
    let missing_worker_temporary = directory.path().join("spawn-worker.tmp");
    fs::write(&daemon, b"old daemon").unwrap();
    fs::write(&daemon_temporary, b"new daemon").unwrap();
    fs::write(&worker, b"old worker").unwrap();

    let failure = swap_binaries(
        &daemon,
        &daemon_temporary,
        &worker,
        &missing_worker_temporary,
    )
    .expect_err("worker replacement must fail");
    assert_eq!(failure.stage, UpdateStage::Swap);
    assert_eq!(failure.error, "swap_failed");
    assert_eq!(fs::read(&daemon).unwrap(), b"old daemon");
    assert_eq!(fs::read(&daemon_temporary).unwrap(), b"new daemon");
    assert_eq!(fs::read(&worker).unwrap(), b"old worker");
    assert!(!previous_path(&daemon).exists());
    assert!(!previous_path(&worker).exists());
}

#[test]
fn precondition_reasons_are_short_stable_classes() {
    let daemon = PathBuf::from("/daemon/spawnd");
    let worker = PathBuf::from("/worker/spawn-worker");
    let writable = |_: &Path| true;

    assert_eq!(
        classify_preconditions(
            true,
            Some(daemon.clone()),
            Some(worker.clone()),
            Some("darwin-aarch64"),
            writable,
        )
        .unwrap_err(),
        BlockReason::Disabled
    );
    assert_eq!(
        classify_preconditions(
            false,
            None,
            Some(worker.clone()),
            Some("darwin-aarch64"),
            writable,
        )
        .unwrap_err(),
        BlockReason::Unwritable
    );
    assert_eq!(
        classify_preconditions(
            false,
            Some(daemon.clone()),
            None,
            Some("darwin-aarch64"),
            writable,
        )
        .unwrap_err(),
        BlockReason::WorkerMissing
    );
    assert_eq!(
        classify_preconditions(
            false,
            Some(daemon.clone()),
            Some(worker.clone()),
            None,
            writable,
        )
        .unwrap_err(),
        BlockReason::UnsupportedTarget
    );
    assert_eq!(
        classify_preconditions(
            false,
            Some(daemon),
            Some(worker),
            Some("darwin-aarch64"),
            |_| false,
        )
        .unwrap_err(),
        BlockReason::Unwritable
    );
    assert_eq!(BlockReason::Disabled.as_str(), "disabled");
    assert_eq!(BlockReason::Unwritable.as_str(), "unwritable");
    assert_eq!(
        BlockReason::UnsupportedTarget.as_str(),
        "unsupported_target"
    );
    assert_eq!(BlockReason::WorkerMissing.as_str(), "worker_missing");
}

#[test]
fn plain_cli_outcomes_are_byte_stable() {
    assert_eq!(
        cli_no_update_line("current"),
        "SPAWN D daemon update not applied (current)."
    );
    assert_eq!(
        UpdateFailure::new(UpdateStage::Verify, "manifest_bad_signature").to_string(),
        "verify: manifest_bad_signature"
    );
}

#[test]
fn target_mapping_covers_only_published_platforms() {
    assert_eq!(target_for("macos", "aarch64"), Some("darwin-aarch64"));
    assert_eq!(target_for("macos", "x86_64"), Some("darwin-x86_64"));
    assert_eq!(target_for("linux", "aarch64"), Some("linux-aarch64"));
    assert_eq!(target_for("linux", "x86_64"), Some("linux-x86_64"));
    assert_eq!(target_for("windows", "x86_64"), None);
    assert_eq!(target_for("linux", "riscv64"), None);
}

#[test]
fn update_guard_is_single_flight_and_releases_on_drop() {
    let flag = AtomicBool::new(false);
    let first = acquire_from(&flag).expect("first update acquires guard");
    let busy = acquire_from(&flag).expect_err("second update must be busy");
    assert_eq!(busy.stage, UpdateStage::Precondition);
    assert_eq!(busy.error, "busy");
    drop(first);
    acquire_from(&flag).expect("guard releases when update finishes");
}

#[test]
fn post_register_cleanup_removes_only_the_installed_pair_backups() {
    let directory = tempdir().unwrap();
    let daemon = directory.path().join("spawnd");
    let worker = directory.path().join("spawn-worker");
    let daemon_previous = directory.path().join("spawnd.prev");
    let worker_previous = directory.path().join("spawn-worker.prev");
    let unrelated = directory.path().join("notes.prev");
    fs::write(&daemon_previous, b"old daemon").unwrap();
    fs::write(&worker_previous, b"old worker").unwrap();
    fs::write(&unrelated, b"keep").unwrap();

    cleanup_previous_paths(&daemon, &worker);

    assert!(!daemon_previous.exists());
    assert!(!worker_previous.exists());
    assert_eq!(fs::read(unrelated).unwrap(), b"keep");
}

fn test_marker(attempts: u32, deadline_unix_ms: u64, reverted: bool) -> ProbationMarker {
    ProbationMarker {
        attempts,
        old_tree: "a".repeat(40),
        deadline_unix_ms,
        attempted_tree: "b".repeat(40),
        version_before: "0.1.0+gold".into(),
        request_id: Some("request-1".into()),
        worker_path: PathBuf::from("/bin/spawn-worker"),
        reverted,
    }
}

#[test]
fn probation_state_machine_continues_once_then_reverts_or_reports() {
    assert_eq!(
        probation_decision(&test_marker(0, 10_000, false), 1_000),
        ProbationDecision::Continue
    );
    assert_eq!(
        probation_decision(&test_marker(1, 10_000, false), 1_000),
        ProbationDecision::Revert
    );
    assert_eq!(
        probation_decision(&test_marker(0, 999, false), 1_000),
        ProbationDecision::Revert
    );
    assert_eq!(
        probation_decision(&test_marker(99, 1, true), 1_000),
        ProbationDecision::ReportRevert
    );
}

#[test]
fn reverted_probation_reports_a_stable_health_failure() {
    let mut marker = test_marker(2, 1, true);
    let frame = serde_json::to_value(health_failure_result(&marker)).unwrap();
    assert_eq!(frame["type"], "daemon.update_result");
    assert_eq!(frame["request_id"], "request-1");
    assert_eq!(frame["ok"], false);
    assert_eq!(frame["stage"], "health");
    assert_eq!(frame["tree"], marker.attempted_tree);

    marker.request_id = None;
    let fallback = serde_json::to_value(health_failure_result(&marker)).unwrap();
    assert_eq!(
        fallback["request_id"],
        format!("health-{}", marker.attempted_tree)
    );
}

#[test]
fn health_revert_restores_both_fake_binaries() {
    let directory = tempdir().unwrap();
    let daemon = directory.path().join("spawnd");
    let worker = directory.path().join("spawn-worker");
    fs::write(&daemon, b"bad daemon").unwrap();
    fs::write(&worker, b"bad worker").unwrap();
    fs::write(previous_path(&daemon), b"old daemon").unwrap();
    fs::write(previous_path(&worker), b"old worker").unwrap();

    revert_binaries(&daemon, &worker).unwrap();

    assert_eq!(fs::read(&daemon).unwrap(), b"old daemon");
    assert_eq!(fs::read(&worker).unwrap(), b"old worker");
    assert!(!previous_path(&daemon).exists());
    assert!(!previous_path(&worker).exists());
}

#[test]
fn corrupt_marker_recovery_requires_both_previous_binaries() {
    let directory = tempdir().unwrap();
    let daemon = directory.path().join("spawnd");
    let worker = directory.path().join("spawn-worker");
    fs::write(previous_path(&daemon), b"old daemon").unwrap();
    assert!(!complete_previous_pair(&daemon, &worker));
    fs::write(previous_path(&worker), b"old worker").unwrap();
    assert!(complete_previous_pair(&daemon, &worker));
    assert_eq!(
        previous_worker_path_for_recovery(&daemon),
        Some(worker),
        "recovery must find spawn-worker.prev even when the current worker is missing"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn downloads_verifies_and_swaps_both_fake_binaries() {
    let daemon_bytes = b"#!/bin/sh\nprintf 'spawnd 0.1.0+gintegration\\n'\n".to_vec();
    let worker_bytes = b"new worker".to_vec();
    let daemon_sha = digest_hex(&Sha256::digest(&daemon_bytes));
    let worker_sha = digest_hex(&Sha256::digest(&worker_bytes));
    let (server, serving) = serve_responses(vec![daemon_bytes.clone(), worker_bytes.clone()]).await;

    let directory = tempdir().unwrap();
    let live_daemon = directory.path().join("spawnd");
    let live_worker = directory.path().join("spawn-worker");
    let temp_daemon = directory.path().join("spawnd.tmp.test");
    let temp_worker = directory.path().join("spawn-worker.tmp.test");
    fs::write(&live_daemon, b"old daemon").unwrap();
    fs::write(&live_worker, b"old worker").unwrap();

    let client = http_client().unwrap();
    let downloaded_daemon = download_to(&client, server.join("daemon").unwrap(), &temp_daemon)
        .await
        .unwrap();
    let downloaded_worker = download_to(&client, server.join("worker").unwrap(), &temp_worker)
        .await
        .unwrap();
    assert_eq!(downloaded_daemon, daemon_sha);
    assert_eq!(downloaded_worker, worker_sha);
    chmod_executable(&temp_daemon).unwrap();
    chmod_executable(&temp_worker).unwrap();
    verify_version(&temp_daemon, "0.1.0+gintegration")
        .await
        .unwrap();
    swap_binaries(&live_daemon, &temp_daemon, &live_worker, &temp_worker).unwrap();

    assert_eq!(fs::read(&live_daemon).unwrap(), daemon_bytes);
    assert_eq!(fs::read(&live_worker).unwrap(), worker_bytes);
    assert_eq!(
        fs::read(previous_path(&live_daemon)).unwrap(),
        b"old daemon"
    );
    assert_eq!(
        fs::read(previous_path(&live_worker)).unwrap(),
        b"old worker"
    );
    serving.await.unwrap();
}

async fn serve_responses(responses: Vec<Vec<u8>>) -> (Url, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        for body in responses {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0u8; 4096];
            let _ = stream.read(&mut request).await.unwrap();
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(headers.as_bytes()).await.unwrap();
            stream.write_all(&body).await.unwrap();
            stream.shutdown().await.unwrap();
        }
    });
    (Url::parse(&format!("http://{address}/")).unwrap(), task)
}
