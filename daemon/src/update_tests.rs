use super::*;

use std::sync::atomic::AtomicBool;

use base64::Engine;
use sha2::{Digest, Sha256};
use tempfile::tempdir;

fn test_executable(directory: &Path, stem: &str) -> PathBuf {
    directory.join(crate::platform::executable_name(stem))
}

#[test]
fn cli_downgrade_floor_comes_from_the_selected_instance() {
    let tmp = tempdir().unwrap();
    let selected = Release {
        dir: tmp.path().join("release"),
        meta: install::ReleaseMeta {
            id: "selected".into(),
            version: "0.1.0+gselected".into(),
            tree: "c".repeat(40),
            variant: "release".into(),
            spawnd_sha256: "a".repeat(64),
            spawn_worker_sha256: "b".repeat(64),
            installed_at_unix_ms: 0,
            source: "test".into(),
            build_counter: Some(u64::MAX - 1),
            release_store: 1,
        },
    };
    let floor = instance_build_counter(Mode::Cli, tmp.path(), Some(&selected));
    assert_eq!(floor, selected.meta.build_counter);
    assert_eq!(
        instance_build_counter(Mode::Daemon, tmp.path(), Some(&selected)),
        floor
    );
    let key = ed25519_dalek::SigningKey::from_bytes(&[7; 32]);
    let (manifest, signature, public_key) = signed_manifest(&key, 2000);
    let failure = verify_manifest_bytes(
        &manifest,
        Some(signature.as_bytes()),
        &manifest_request(),
        "darwin-aarch64",
        &VerifyPolicy {
            allow_unsigned: false,
            public_keys: &[&public_key],
            build_counter: floor,
            downgrade_authorized: false,
            variant: ReleaseVariant::Release,
        },
    )
    .unwrap_err();
    assert_eq!(failure.error, "downgrade");
    let mut unknown = selected;
    unknown.meta.build_counter = None;
    assert_eq!(
        instance_build_counter(Mode::Cli, tmp.path(), Some(&unknown)),
        None
    );
}

#[cfg(unix)]
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
    signed_manifest_with(signing_key, counter, None)
}

/// A signed manifest for tree `b…` at `counter`; `variants`, when given, is
/// written verbatim under the `variants` key so a test can shape it freely.
fn signed_manifest_with(
    signing_key: &ed25519_dalek::SigningKey,
    counter: u64,
    variants: Option<serde_json::Value>,
) -> (Vec<u8>, String, String) {
    use ed25519_dalek::Signer;

    let public_key = URL_SAFE_NO_PAD.encode(signing_key.verifying_key().to_bytes());
    let key_id =
        digest_hex(&Sha256::digest(signing_key.verifying_key().to_bytes()))[..8].to_string();
    let mut manifest = serde_json::json!({
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
    });
    if let Some(variants) = variants {
        manifest["variants"] = variants;
    }
    let bytes = serde_json::to_vec(&manifest).unwrap();
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
        &VerifyPolicy {
            allow_unsigned: false,
            public_keys: &[&public_key],
            build_counter: Some(1_000),
            downgrade_authorized: false,
            variant: ReleaseVariant::Release,
        },
    )
    .unwrap();

    let missing = verify_manifest_bytes(
        &manifest,
        None,
        &request,
        "darwin-aarch64",
        &VerifyPolicy {
            allow_unsigned: false,
            public_keys: &[&public_key],
            build_counter: Some(1_000),
            downgrade_authorized: false,
            variant: ReleaseVariant::Release,
        },
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
        &VerifyPolicy {
            allow_unsigned: false,
            public_keys: &[&public_key],
            build_counter: Some(1_000),
            downgrade_authorized: false,
            variant: ReleaseVariant::Release,
        },
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
        &VerifyPolicy {
            allow_unsigned: false,
            public_keys: &[&wrong_key],
            build_counter: Some(1_000),
            downgrade_authorized: false,
            variant: ReleaseVariant::Release,
        },
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
        &VerifyPolicy {
            allow_unsigned: false,
            public_keys: &[&public_key],
            build_counter: Some(1_000),
            downgrade_authorized: false,
            variant: ReleaseVariant::Release,
        },
    )
    .unwrap_err();
    assert_eq!(
        (downgrade.stage, downgrade.error),
        (UpdateStage::Precondition, "downgrade")
    );

    // The server asking is not the server deciding: `allow_downgrade` on the
    // frame no longer bypasses the counter on its own, because docs/TRUST.md
    // treats the control plane as hostile and rollback protection is the one
    // guarantee the counter exists to give.
    request.allow_downgrade = true;
    let asked_only = verify_manifest_bytes(
        &older,
        Some(signature.as_bytes()),
        &request,
        "darwin-aarch64",
        &VerifyPolicy {
            allow_unsigned: false,
            public_keys: &[&public_key],
            build_counter: Some(1_000),
            downgrade_authorized: false,
            variant: ReleaseVariant::Release,
        },
    )
    .unwrap_err();
    assert_eq!(
        (asked_only.stage, asked_only.error),
        (UpdateStage::Precondition, "downgrade")
    );

    // With local consent proven on the host as well, it proceeds.
    verify_manifest_bytes(
        &older,
        Some(signature.as_bytes()),
        &request,
        "darwin-aarch64",
        &VerifyPolicy {
            allow_unsigned: false,
            public_keys: &[&public_key],
            build_counter: Some(1_000),
            downgrade_authorized: true,
            variant: ReleaseVariant::Release,
        },
    )
    .unwrap();

    request.allow_downgrade = false;
    let (equal, equal_signature, _) = signed_manifest(&key, 1_000);
    verify_manifest_bytes(
        &equal,
        Some(equal_signature.as_bytes()),
        &request,
        "darwin-aarch64",
        &VerifyPolicy {
            allow_unsigned: false,
            public_keys: &[&public_key],
            build_counter: Some(1_000),
            downgrade_authorized: false,
            variant: ReleaseVariant::Release,
        },
    )
    .unwrap();

    verify_manifest_bytes(
        &older,
        None,
        &request,
        "darwin-aarch64",
        &VerifyPolicy {
            allow_unsigned: true,
            public_keys: &[],
            build_counter: Some(1_000),
            downgrade_authorized: false,
            variant: ReleaseVariant::Release,
        },
    )
    .unwrap();

    request.spawnd.sha256 = "e".repeat(64);
    let mismatch = verify_manifest_bytes(
        &equal,
        Some(equal_signature.as_bytes()),
        &request,
        "darwin-aarch64",
        &VerifyPolicy {
            allow_unsigned: false,
            public_keys: &[&public_key],
            build_counter: Some(1_000),
            downgrade_authorized: false,
            variant: ReleaseVariant::Release,
        },
    )
    .unwrap_err();
    assert_eq!(
        (mismatch.stage, mismatch.error),
        (UpdateStage::Verify, "manifest_mismatch")
    );
}

#[test]
fn worker_mismatch_and_a_variant_switch_bypass_same_tree_idempotence() {
    use ReleaseVariant::{Diagnostics, Release};
    assert!(release_is_current("tree", "tree", false, Release, Release));
    assert!(release_is_current(
        "tree",
        "tree",
        false,
        Diagnostics,
        Diagnostics
    ));
    assert!(!release_is_current("tree", "tree", true, Release, Release));
    assert!(!release_is_current("new", "old", false, Release, Release));
    // Told to follow the other variant, the same tree is an update to do.
    assert!(!release_is_current(
        "tree",
        "tree",
        false,
        Release,
        Diagnostics
    ));
    assert!(!release_is_current(
        "tree",
        "tree",
        false,
        Diagnostics,
        Release
    ));
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
    let binary = test_executable(directory.path(), "spawnd");
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

#[cfg(windows)]
#[tokio::test]
async fn version_check_executes_a_real_pe_fixture() {
    let directory = tempdir().unwrap();
    let source = directory.path().join("version-fixture.rs");
    let binary = test_executable(directory.path(), "spawnd");
    fs::write(
        &source,
        r#"fn main() { println!("spawnd 0.1.0+gwindowsfixture"); }"#,
    )
    .unwrap();
    let status = std::process::Command::new("rustc.exe")
        .arg(&source)
        .arg("-o")
        .arg(&binary)
        .status()
        .expect("rustc.exe must be available on Windows CI");
    assert!(status.success(), "building PE fixture failed with {status}");

    verify_version(&binary, "0.1.0+gwindowsfixture")
        .await
        .expect("matching native PE version");
    let failure = verify_version(&binary, "0.1.0+gwrong")
        .await
        .expect_err("wrong expected version must fail");
    assert_eq!(failure.stage, UpdateStage::Verify);
    assert_eq!(failure.error, "version_mismatch");
}

#[cfg(unix)]
#[tokio::test]
async fn worker_pair_check_requires_the_exact_shared_tree_stamp() {
    let directory = tempdir().unwrap();
    let worker = test_executable(directory.path(), "spawn-worker");
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
fn precondition_reasons_are_short_stable_classes() {
    let ok = Ok(ReleaseVariant::Release);
    assert_eq!(
        classify_preconditions(true, true, true, false, Some("darwin-aarch64"), ok),
        Err(BlockReason::Disabled)
    );
    assert_eq!(
        classify_preconditions(false, false, true, false, Some("darwin-aarch64"), ok),
        Err(BlockReason::Unwritable)
    );
    assert_eq!(
        classify_preconditions(false, true, false, false, Some("darwin-aarch64"), ok),
        Err(BlockReason::WorkerMissing)
    );
    // A daemon still running from the shared legacy pair must not swap files
    // it does not own; a command from a shell re-registers it instead.
    assert_eq!(
        classify_preconditions(false, true, true, true, Some("darwin-aarch64"), ok),
        Err(BlockReason::LegacyLaunch)
    );
    assert_eq!(
        classify_preconditions(false, true, true, false, None, ok),
        Err(BlockReason::UnsupportedTarget)
    );
    assert_eq!(
        classify_preconditions(
            false,
            true,
            true,
            false,
            Some("darwin-aarch64"),
            Err(BlockReason::InvalidVariant),
        ),
        Err(BlockReason::InvalidVariant)
    );
    assert_eq!(
        classify_preconditions(false, true, true, false, Some("darwin-aarch64"), ok),
        Ok(())
    );
    assert_eq!(BlockReason::Disabled.as_str(), "disabled");
    assert_eq!(BlockReason::Unwritable.as_str(), "unwritable");
    assert_eq!(
        BlockReason::UnsupportedTarget.as_str(),
        "unsupported_target"
    );
    assert_eq!(BlockReason::WorkerMissing.as_str(), "worker_missing");
    assert_eq!(BlockReason::InvalidVariant.as_str(), "invalid_variant");
    assert_eq!(BlockReason::LegacyLaunch.as_str(), "legacy_launch");
}

#[test]
fn variant_selection_defaults_to_the_own_build_and_honours_the_override() {
    use ReleaseVariant::{Diagnostics, Release};
    for own in [Release, Diagnostics] {
        assert_eq!(configured_variant_from(None, own), Ok(own));
        assert_eq!(configured_variant_from(Some(OsStr::new("")), own), Ok(own));
        assert_eq!(
            configured_variant_from(Some(OsStr::new("  ")), own),
            Ok(own)
        );
        assert_eq!(
            configured_variant_from(Some(OsStr::new("release")), own),
            Ok(Release)
        );
        assert_eq!(
            configured_variant_from(Some(OsStr::new(" diagnostics\n")), own),
            Ok(Diagnostics)
        );
        for bogus in [
            "debug",
            "Diagnostics",
            "DIAGNOSTICS",
            "diagnostic",
            "release,diagnostics",
        ] {
            assert_eq!(
                configured_variant_from(Some(OsStr::new(bogus)), own),
                Err(BlockReason::InvalidVariant),
                "{bogus:?} must not select a variant"
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            assert_eq!(
                configured_variant_from(Some(OsStr::from_bytes(&[0xff, 0xfe])), own),
                Err(BlockReason::InvalidVariant),
                "a value that is not a string must not select a variant"
            );
        }
    }
    // The build decides the default, so a diagnostics binary keeps following
    // diagnostics with nothing set, and a release binary never picks it up.
    assert_eq!(
        ReleaseVariant::own(),
        if crate::version::DIAGNOSTICS_BUILD {
            Diagnostics
        } else {
            Release
        }
    );
    assert_eq!(Release.as_str(), "release");
    assert_eq!(Diagnostics.as_str(), "diagnostics");
    assert_eq!(
        variant_install_path("spawnd", "linux-x86_64", Diagnostics),
        "/api/install/spawnd/linux-x86_64/diagnostics"
    );
    let server = Url::parse("https://example.test/").unwrap();
    assert!(join_install_url(
        &server,
        &variant_install_path("spawn-worker", "linux-x86_64", Diagnostics)
    )
    .is_ok());
}

fn variants_block(target: &str) -> serde_json::Value {
    serde_json::json!({
        "diagnostics": {
            "version": "0.1.0+gnew.diagnostics",
            "targets": {
                target: {
                    "spawnd_sha256": "e".repeat(64),
                    "spawn_worker_sha256": "f".repeat(64)
                }
            }
        }
    })
}

fn release_policy<'a>(public_keys: &'a [&'a str], variant: ReleaseVariant) -> VerifyPolicy<'a> {
    VerifyPolicy {
        allow_unsigned: false,
        public_keys,
        build_counter: Some(1_000),
        downgrade_authorized: false,
        variant,
    }
}

#[test]
fn a_manifest_carrying_variants_still_verifies_and_resolves_the_release_pair() {
    // What every release daemon in the field sees the moment the first
    // manifest with a `variants` map is published: it must verify and it
    // must resolve to exactly the release artifacts the server named.
    let key = ed25519_dalek::SigningKey::from_bytes(&[7; 32]);
    let request = manifest_request();
    let expected = UpdatePlan {
        build_counter: 2000,
        version: request.version.clone(),
        spawnd: request.spawnd.clone(),
        spawn_worker: request.spawn_worker.clone(),
    };
    for variants in [
        variants_block("darwin-aarch64"),
        serde_json::json!({}),
        serde_json::Value::Null,
        serde_json::json!("not even an object"),
        serde_json::json!({"diagnostics": "malformed"}),
        serde_json::json!({"future-variant": {"shape": ["unknown"]}}),
    ] {
        let (manifest, signature, public_key) =
            signed_manifest_with(&key, 2_000, Some(variants.clone()));
        let plan = verify_manifest_bytes(
            &manifest,
            Some(signature.as_bytes()),
            &request,
            "darwin-aarch64",
            &release_policy(&[&public_key], ReleaseVariant::Release),
        )
        .unwrap_or_else(|failure| panic!("variants {variants} broke the release path: {failure}"));
        assert_eq!(plan, expected);
    }
}

#[test]
fn the_diagnostics_variant_installs_its_own_pair_from_the_signed_manifest() {
    let key = ed25519_dalek::SigningKey::from_bytes(&[7; 32]);
    let request = manifest_request();
    let (manifest, signature, public_key) =
        signed_manifest_with(&key, 2_000, Some(variants_block("darwin-aarch64")));
    let plan = verify_manifest_bytes(
        &manifest,
        Some(signature.as_bytes()),
        &request,
        "darwin-aarch64",
        &release_policy(&[&public_key], ReleaseVariant::Diagnostics),
    )
    .unwrap();
    assert_eq!(
        plan,
        UpdatePlan {
            build_counter: 2000,
            version: "0.1.0+gnew.diagnostics".into(),
            spawnd: DaemonUpdateArtifact {
                path: "/api/install/spawnd/darwin-aarch64/diagnostics".into(),
                sha256: "e".repeat(64),
            },
            spawn_worker: DaemonUpdateArtifact {
                path: "/api/install/spawn-worker/darwin-aarch64/diagnostics".into(),
                sha256: "f".repeat(64),
            },
        }
    );
    // The release pair the server named is never what a diagnostics daemon
    // installs, even though it had to match the manifest to get this far.
    assert_ne!(plan.spawnd.sha256, request.spawnd.sha256);
    assert_ne!(plan.spawn_worker.sha256, request.spawn_worker.sha256);

    // The server's claim is still held to the signed release: a tree or a
    // release hash that disagrees with the manifest is refused before any
    // variant is looked at.
    let mut lying = request.clone();
    lying.spawnd.sha256 = "1".repeat(64);
    let failure = verify_manifest_bytes(
        &manifest,
        Some(signature.as_bytes()),
        &lying,
        "darwin-aarch64",
        &release_policy(&[&public_key], ReleaseVariant::Diagnostics),
    )
    .unwrap_err();
    assert_eq!(failure.error, "manifest_mismatch");
}

#[test]
fn the_diagnostics_variant_refuses_a_manifest_without_its_pair() {
    // A diagnostics host whose release has no diagnostics build for its
    // target keeps the build it has. Falling back to the release pair here
    // would silently turn it back into a release host.
    let key = ed25519_dalek::SigningKey::from_bytes(&[7; 32]);
    let request = manifest_request();
    let unavailable = [
        None,
        Some(serde_json::json!({})),
        Some(serde_json::Value::Null),
        Some(variants_block("linux-x86_64")),
        Some(serde_json::json!({"release": {"version": "x", "targets": {}}})),
    ];
    for variants in unavailable {
        let (manifest, signature, public_key) = signed_manifest_with(&key, 2_000, variants.clone());
        let failure = verify_manifest_bytes(
            &manifest,
            Some(signature.as_bytes()),
            &request,
            "darwin-aarch64",
            &release_policy(&[&public_key], ReleaseVariant::Diagnostics),
        )
        .unwrap_err();
        assert_eq!(
            (failure.stage, failure.error),
            (UpdateStage::Verify, "variant_unavailable"),
            "variants {variants:?}"
        );
    }
    let malformed = [
        serde_json::json!({"diagnostics": "malformed"}),
        serde_json::json!({"diagnostics": {"targets": {"darwin-aarch64": {
            "spawnd_sha256": "e".repeat(64), "spawn_worker_sha256": "f".repeat(64)}}}}),
        serde_json::json!({"diagnostics": {"version": "", "targets": {"darwin-aarch64": {
            "spawnd_sha256": "e".repeat(64), "spawn_worker_sha256": "f".repeat(64)}}}}),
        serde_json::json!({"diagnostics": {"version": "0.1.0+gnew.diagnostics", "targets": {
            "darwin-aarch64": {"spawnd_sha256": "short", "spawn_worker_sha256": "f".repeat(64)}}}}),
    ];
    for variants in malformed {
        let (manifest, signature, public_key) =
            signed_manifest_with(&key, 2_000, Some(variants.clone()));
        let failure = verify_manifest_bytes(
            &manifest,
            Some(signature.as_bytes()),
            &request,
            "darwin-aarch64",
            &release_policy(&[&public_key], ReleaseVariant::Diagnostics),
        )
        .unwrap_err();
        assert_eq!(
            (failure.stage, failure.error),
            (UpdateStage::Verify, "manifest_mismatch"),
            "variants {variants}"
        );
    }
}

#[test]
fn the_signature_covers_the_variant_hashes_and_the_counter_still_applies() {
    use ed25519_dalek::Signer;

    let key = ed25519_dalek::SigningKey::from_bytes(&[7; 32]);
    let request = manifest_request();
    let (manifest, signature, public_key) =
        signed_manifest_with(&key, 2_000, Some(variants_block("darwin-aarch64")));

    // Alter one byte of the diagnostics spawnd hash after signing: the
    // signature no longer verifies, for either variant, so a variant hash is
    // no less protected than a release one.
    let text = std::str::from_utf8(&manifest).unwrap();
    let tampered = text.replacen(&"e".repeat(64), &format!("d{}", "e".repeat(63)), 1);
    assert_ne!(tampered, text);
    for variant in [ReleaseVariant::Release, ReleaseVariant::Diagnostics] {
        let failure = verify_manifest_bytes(
            tampered.as_bytes(),
            Some(signature.as_bytes()),
            &request,
            "darwin-aarch64",
            &release_policy(&[&public_key], variant),
        )
        .unwrap_err();
        assert_eq!(failure.error, "manifest_bad_signature");
    }
    // Re-signed by the release key, the altered hash is what gets installed:
    // the variant pair is exactly as trusted as the signature, no more.
    let resigned = URL_SAFE_NO_PAD.encode(key.sign(tampered.as_bytes()).to_bytes());
    let plan = verify_manifest_bytes(
        tampered.as_bytes(),
        Some(resigned.as_bytes()),
        &request,
        "darwin-aarch64",
        &release_policy(&[&public_key], ReleaseVariant::Diagnostics),
    )
    .unwrap();
    assert_eq!(plan.spawnd.sha256, format!("d{}", "e".repeat(63)));

    // The monotonic counter guards the variant path unchanged.
    let (older, older_signature, _) =
        signed_manifest_with(&key, 500, Some(variants_block("darwin-aarch64")));
    let failure = verify_manifest_bytes(
        &older,
        Some(older_signature.as_bytes()),
        &request,
        "darwin-aarch64",
        &release_policy(&[&public_key], ReleaseVariant::Diagnostics),
    )
    .unwrap_err();
    assert_eq!(
        (failure.stage, failure.error),
        (UpdateStage::Precondition, "downgrade")
    );
    // And an unsigned manifest is refused before its variants are read.
    let failure = verify_manifest_bytes(
        &manifest,
        None,
        &request,
        "darwin-aarch64",
        &release_policy(&[&public_key], ReleaseVariant::Diagnostics),
    )
    .unwrap_err();
    assert_eq!(failure.error, "manifest_unsigned");
}

#[test]
fn plain_cli_outcomes_are_byte_stable() {
    assert_eq!(
        cli_no_update_line("9f1c2d3e", "current"),
        "SPAWN D daemon update not applied for 9f1c2d3e (current)."
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
    assert_eq!(target_for("windows", "x86_64"), Some("windows-x86_64"));
    assert_eq!(target_for("linux", "riscv64"), None);
}

#[test]
fn executable_update_names_keep_the_target_suffix_last() {
    let directory = tempdir().unwrap();
    let suffix = std::env::consts::EXE_SUFFIX;
    for stem in ["spawnd", "spawn-worker"] {
        let live = test_executable(directory.path(), stem);
        assert_eq!(
            live.file_name().unwrap().to_string_lossy(),
            format!("{stem}{suffix}")
        );
        for tag in ["prev", "tmp.123", "failed.123"] {
            assert_eq!(
                crate::platform::executable_variant(&live, tag)
                    .unwrap()
                    .file_name()
                    .unwrap()
                    .to_string_lossy(),
                format!("{stem}.{tag}{suffix}")
            );
        }
    }
    // The marker the in-place updater left beside its binary is data, with
    // no executable suffix; the store's marker sits in the instance dir.
    assert_eq!(
        legacy_marker_path(&test_executable(directory.path(), "spawnd"))
            .file_name()
            .unwrap(),
        "spawnd.updating"
    );
    let layout = install::Layout::at(directory.path().join("root"));
    let marker = install::probation_marker_path(&layout, Path::new("/srv/spawn/alice"));
    assert_eq!(marker.file_name().unwrap(), "spawnd.updating");
    assert!(marker.starts_with(layout.instances_dir()));
}

/// A marker written by the in-place updater (`worker_path`, no release ids)
/// still reads, and a store marker names what it moved between.
#[test]
fn probation_markers_read_both_generations() {
    let legacy: ProbationMarker = serde_json::from_str(
        r#"{"attempts":1,"old_tree":"a","deadline_unix_ms":5,"attempted_tree":"b","version_before":"0.1.0+gold","worker_path":"/x/spawn-worker","reverted":false}"#,
    )
    .unwrap();
    assert_eq!(legacy.worker_path, Some(PathBuf::from("/x/spawn-worker")));
    assert_eq!(legacy.previous_release, None);
    let store = test_marker(0, 10, false);
    let value = serde_json::to_value(&store).unwrap();
    assert_eq!(value["previous_release"], "0.1.0+gold-11111111");
    assert_eq!(value["attempted_release"], "0.1.0+gnew-22222222");
    assert!(value.get("worker_path").is_none());
}

#[test]
fn signed_manifest_accepts_the_windows_target_and_rejects_target_substitution() {
    use ed25519_dalek::Signer;

    let key = ed25519_dalek::SigningKey::from_bytes(&[17; 32]);
    let public_key = URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes());
    let key_id = digest_hex(&Sha256::digest(key.verifying_key().to_bytes()))[..8].to_string();
    let manifest = serde_json::to_vec(&serde_json::json!({
        "commit": "a".repeat(40),
        "tree": "b".repeat(40),
        "version": "0.1.0+gnew",
        "release_counter": 2_000,
        "signing_key_id": key_id,
        "targets": {
            "windows-x86_64": {
                "spawnd_sha256": "c".repeat(64),
                "spawn_worker_sha256": "d".repeat(64)
            }
        }
    }))
    .unwrap();
    let signature = URL_SAFE_NO_PAD.encode(key.sign(&manifest).to_bytes());
    let mut request = manifest_request();
    request.target = "windows-x86_64".into();
    request.spawnd.path = "/api/install/spawnd/windows-x86_64".into();
    request.spawn_worker.path = "/api/install/spawn-worker/windows-x86_64".into();

    verify_manifest_bytes(
        &manifest,
        Some(signature.as_bytes()),
        &request,
        "windows-x86_64",
        &VerifyPolicy {
            allow_unsigned: false,
            public_keys: &[&public_key],
            build_counter: Some(1_000),
            downgrade_authorized: false,
            variant: ReleaseVariant::Release,
        },
    )
    .unwrap();
    let failure = verify_manifest_bytes(
        &manifest,
        Some(signature.as_bytes()),
        &request,
        "linux-x86_64",
        &VerifyPolicy {
            allow_unsigned: false,
            public_keys: &[&public_key],
            build_counter: Some(1_000),
            downgrade_authorized: false,
            variant: ReleaseVariant::Release,
        },
    )
    .unwrap_err();
    assert_eq!(failure.error, "manifest_mismatch");
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
    let daemon = test_executable(directory.path(), "spawnd");
    let worker = test_executable(directory.path(), "spawn-worker");
    let daemon_previous = install::previous_path(&daemon);
    let worker_previous = install::previous_path(&worker);
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
        worker_path: None,
        reverted,
        previous_release: Some("0.1.0+gold-11111111".into()),
        attempted_release: Some("0.1.0+gnew-22222222".into()),
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
fn corrupt_marker_recovery_requires_both_previous_binaries() {
    let directory = tempdir().unwrap();
    let daemon = test_executable(directory.path(), "spawnd");
    let worker = test_executable(directory.path(), "spawn-worker");
    fs::write(install::previous_path(&daemon), b"old daemon").unwrap();
    assert!(!complete_previous_pair(&daemon, &worker));
    fs::write(install::previous_path(&worker), b"old worker").unwrap();
    assert!(complete_previous_pair(&daemon, &worker));
    assert_eq!(
        previous_worker_path_for_recovery(&daemon),
        Some(worker),
        "recovery must find spawn-worker.prev even when the current worker is missing"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn downloads_verifies_and_publishes_the_pair_as_one_release() {
    let daemon_bytes = b"#!/bin/sh\nprintf 'spawnd 0.1.0+gintegration\\n'\n".to_vec();
    let worker_bytes = format!(
        "#!/bin/sh\nprintf 'spawn-worker 0.1.0+gintegration tree={}\\n'\n",
        "b".repeat(40)
    )
    .into_bytes();
    let daemon_sha = digest_hex(&Sha256::digest(&daemon_bytes));
    let worker_sha = digest_hex(&Sha256::digest(&worker_bytes));
    let (server, serving) = serve_responses(vec![daemon_bytes.clone(), worker_bytes.clone()]).await;

    let directory = tempdir().unwrap();
    let layout = install::Layout::at(directory.path().join("root"));
    let staging = StagingDir::new(&layout).unwrap();
    assert!(staging.dir.starts_with(layout.releases_dir()));

    let client = http_client().unwrap();
    let downloaded_daemon = download_to(&client, server.join("daemon").unwrap(), &staging.daemon)
        .await
        .unwrap();
    let downloaded_worker = download_to(&client, server.join("worker").unwrap(), &staging.worker)
        .await
        .unwrap();
    assert_eq!(downloaded_daemon, daemon_sha);
    assert_eq!(downloaded_worker, worker_sha);
    chmod_executable(&staging.daemon).unwrap();
    chmod_executable(&staging.worker).unwrap();
    verify_version(&staging.daemon, "0.1.0+gintegration")
        .await
        .unwrap();
    verify_worker_identity(&staging.worker, "0.1.0+gintegration", &"b".repeat(40))
        .await
        .unwrap();
    // A worker that reports another tree never gets published beside a daemon.
    let failure = verify_worker_identity(&staging.worker, "0.1.0+gintegration", &"c".repeat(40))
        .await
        .unwrap_err();
    assert_eq!(
        (failure.stage, failure.error),
        (UpdateStage::Verify, "worker_mismatch")
    );

    let id = install::release_id("0.1.0+gintegration", &daemon_sha, &worker_sha);
    let release = install::publish_with_meta(
        &layout,
        install::PublishSource {
            spawnd: &staging.daemon,
            spawn_worker: &staging.worker,
            source: "update",
        },
        install::ReleaseMeta {
            id: id.clone(),
            version: "0.1.0+gintegration".into(),
            tree: "b".repeat(40),
            variant: "release".into(),
            spawnd_sha256: daemon_sha.clone(),
            spawn_worker_sha256: worker_sha.clone(),
            installed_at_unix_ms: unix_millis(),
            source: "update".into(),
            build_counter: Some(2000),
            release_store: 1,
        },
    )
    .unwrap();
    drop(staging);
    assert_eq!(release.id(), id);
    assert_eq!(fs::read(release.spawnd()).unwrap(), daemon_bytes);
    assert_eq!(fs::read(release.spawn_worker()).unwrap(), worker_bytes);
    install::verify_release(&release).unwrap();
    // The staging directory is gone; only the release remains.
    let entries: Vec<_> = fs::read_dir(layout.releases_dir())
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(entries, vec![id]);
    serving.await.unwrap();
}

#[cfg(unix)]
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
