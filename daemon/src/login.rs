//! `spawnd login` — interactive device-code flow.
//!
//! Flow per `proto/README.md`:
//!   1. POST /api/auth/device/start  -> { device_code, user_code, verification_uri, interval, expires_in }
//!   2. Sign and POST /api/auth/device/possession for that exact ceremony.
//!   3. Only after proof succeeds, print the verification URI and user code.
//!   4. Poll /api/auth/device/poll until success / expiry / denial.
//!   5. On success store {access_token, host_id, server_url}.

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use reqwest::StatusCode;
use zeroize::{Zeroize, Zeroizing};

use spawnd::host_pair_approval::{self, HostPairApprovalTranscript};
use spawnd::signed_signal::public_key_from_wire;

use crate::cli::LoginArgs;
use crate::config;
use crate::creds;
use crate::creds::HostIdentity;
use crate::proto::{
    DevicePollRequest, DevicePollResponse, DevicePossessionRequest, DevicePossessionResponse,
    DeviceStartRequest, DeviceStartResponse,
};

pub async fn run(server_cli: Option<String>, args: LoginArgs) -> Result<()> {
    let server = config::server_url(server_cli)?;

    // Persist before starting the ceremony so retries and interrupted logins
    // never rotate identity. A corrupt existing seed fails closed.
    let mut stored = creds::load().context("loading stored credentials")?;
    let expected = creds::credential_revision(&stored)?;
    let identity = creds::ensure_host_identity(&mut stored)?;
    creds::save(&mut stored, &expected).context("persisting host identity")?;

    let host_name = args.host_name.unwrap_or_else(detect_hostname);
    let os = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();
    let version = env!("CARGO_PKG_VERSION").to_string();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;

    // 1. start
    let start_url = config::api_url(&server, "/api/auth/device/start")?;
    let start: DeviceStartResponse = client
        .post(start_url.as_str())
        .json(&DeviceStartRequest {
            host_name: &host_name,
            os: &os,
            arch: &arch,
            version: &version,
            host_key_algorithm: identity.algorithm,
            host_public_key: &identity.public_key,
        })
        .send()
        .await
        .context("POST /api/auth/device/start")?
        .error_for_status()?
        .json()
        .await
        .context("decoding device/start response")?;

    // Prove possession before activating the human-visible user code. The
    // private seed stays inside creds; only the fixed-width signature leaves.
    let possession_signature =
        creds::sign_host_pair_possession(&stored, &start.device_code, &start.approval_nonce)?;
    let possession_url = config::api_url(&server, "/api/auth/device/possession")?;
    let possession: DevicePossessionResponse = client
        .post(possession_url.as_str())
        .json(&DevicePossessionRequest {
            device_code: &start.device_code,
            approval_nonce: &start.approval_nonce,
            host_key_algorithm: identity.algorithm,
            host_public_key: &identity.public_key,
            signature: &possession_signature,
        })
        .send()
        .await
        .context("POST /api/auth/device/possession")?
        .error_for_status()?
        .json()
        .await
        .context("decoding device/possession response")?;
    if !possession.verified || possession.version != 1 {
        return Err(anyhow!(
            "device/possession returned an unsupported verification state"
        ));
    }

    // Match a browser login's ease: open the approval page with the code
    // prefilled and poll to completion ourselves. On a headless host we fall
    // back to printing the link. The host-key possession proof above is
    // unchanged — this only touches how the human reaches the approval page.
    let approve_url = match url::Url::parse(&start.verification_uri) {
        Ok(mut parsed) => {
            parsed
                .query_pairs_mut()
                .append_pair("code", &start.user_code);
            parsed.to_string()
        }
        Err(_) => start.verification_uri.clone(),
    };
    if open_browser(&approve_url) {
        println!("spawn: opened your browser to approve this host.");
        println!(
            "spawn:   code {}   (didn't open? visit {})",
            start.user_code, approve_url
        );
    } else {
        println!("spawn: approve this host in your browser:");
        println!("spawn:   {approve_url}");
        println!("spawn:   code {}", start.user_code);
    }
    println!("spawn: verify host fingerprint: {}", identity.fingerprint);
    println!("spawn: waiting for approval…");

    // 2. poll
    let poll_url = config::api_url(&server, "/api/auth/device/poll")?;
    let mut interval = Duration::from_secs(start.interval.max(1));
    let poll_body = DevicePollRequest {
        device_code: &start.device_code,
        host_key_algorithm: identity.algorithm,
        host_public_key: &identity.public_key,
    };

    loop {
        tokio::time::sleep(interval).await;

        let resp = client
            .post(poll_url.as_str())
            .json(&poll_body)
            .send()
            .await
            .context("POST /api/auth/device/poll")?;

        let status = resp.status();
        // 200 with body that may carry either {access_token, host_id} or {error: ...}.
        // Some servers return non-2xx for pending/denied; tolerate both.
        if !(status.is_success()
            || status == StatusCode::BAD_REQUEST
            || status == StatusCode::FORBIDDEN
            || status == StatusCode::GONE)
        {
            return Err(anyhow!("device/poll: HTTP {status}"));
        }
        let body: DevicePollResponse =
            resp.json().await.context("decoding device/poll response")?;

        if poll_has_success_fields(&body) {
            let host_id = commit_poll_success(
                &mut stored,
                body,
                &identity,
                &server,
                &start.approval_nonce,
                creds::save,
            )?;
            println!("spawn: logged in. host_id = {host_id}");
            return Ok(());
        }

        match body.error.as_deref() {
            Some("authorization_pending") | None => {
                // keep polling
            }
            Some("slow_down") => {
                interval += Duration::from_secs(5);
                tracing::debug!(?interval, "server requested slow_down");
            }
            Some("expired_token") => {
                return Err(anyhow!("device code expired; run `spawnd login` again"));
            }
            Some("denied") => {
                return Err(anyhow!("login was denied"));
            }
            Some(other) => {
                return Err(anyhow!("device/poll returned error: {other}"));
            }
        }
    }
}

/// Best-effort: open `url` in the operator's default browser. Returns whether a
/// launcher was started. Never blocks and never fails login — on a headless host
/// (no display) or where no opener exists, the caller prints the URL instead.
fn open_browser(url: &str) -> bool {
    use std::process::{Command, Stdio};
    let mut _cmd: Option<Command> = None;
    #[cfg(target_os = "macos")]
    {
        _cmd = Some(Command::new("open"));
    }
    #[cfg(target_os = "linux")]
    {
        // No display ⇒ headless (SSH/server): don't try; the caller prints it.
        if std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some() {
            _cmd = Some(Command::new("xdg-open"));
        }
    }
    match _cmd {
        Some(mut cmd) => cmd
            .arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .is_ok(),
        None => false,
    }
}

fn poll_has_success_fields(body: &DevicePollResponse) -> bool {
    body.access_token.is_some()
        || body.host_id.is_some()
        || body.host_key_algorithm.is_some()
        || body.host_public_key.is_some()
        || body.host_key_fingerprint.is_some()
        || body.browser_device_id.is_some()
        || body.browser_key_algorithm.is_some()
        || body.browser_public_key.is_some()
        || body.browser_key_fingerprint.is_some()
}

/// Verify the browser's approval proof against values this daemon already holds.
///
/// The nonce and host key come from this daemon's own device/start exchange, so
/// a proof minted for another ceremony, another host, or another account cannot
/// be replayed here. Returns whether a proof was actually verified.
///
/// A missing proof is tolerated and reported as unverified, because a pre-0022
/// server cannot supply one. A present-but-invalid proof aborts the login: no
/// benign condition produces one.
///
/// This does not by itself defeat a hostile server. The transcript commits to
/// the signer's own key, so a server substituting its own keypair can mint a
/// self-consistent proof. Distinguishing that case is what the operator's
/// out-of-band fingerprint comparison below is for.
fn verify_browser_approval(
    body: &DevicePollResponse,
    identity: &HostIdentity,
    approval_nonce: &str,
    browser_public_key: &str,
) -> Result<bool> {
    let (Some(account_id), Some(signature_wire)) = (
        body.account_id.as_deref(),
        body.browser_approval_signature.as_deref(),
    ) else {
        return Ok(false);
    };
    let transcript = HostPairApprovalTranscript::from_wire(
        account_id,
        approval_nonce,
        &identity.public_key,
        browser_public_key,
    )
    .context("decoding the browser approval transcript")?;
    let signature = host_pair_approval::signature_from_wire(signature_wire)
        .context("decoding the browser approval signature")?;
    let browser_key = public_key_from_wire(browser_public_key)
        .context("decoding the approved browser public key")?;
    host_pair_approval::verify_transcript(&browser_key, &transcript, &signature)
        .context("verifying the browser approval proof")?;
    Ok(true)
}

fn commit_poll_success<F>(
    stored: &mut creds::StoredCreds,
    body: DevicePollResponse,
    identity: &HostIdentity,
    server: &url::Url,
    approval_nonce: &str,
    persist: F,
) -> Result<uuid::Uuid>
where
    F: FnOnce(&mut creds::StoredCreds, &creds::CredentialRevision) -> Result<()>,
{
    commit_poll_success_observed(
        stored,
        body,
        identity,
        server,
        approval_nonce,
        persist,
        |_| {},
    )
}

fn commit_poll_success_observed<F, O>(
    stored: &mut creds::StoredCreds,
    mut body: DevicePollResponse,
    identity: &HostIdentity,
    server: &url::Url,
    approval_nonce: &str,
    persist: F,
    observe_wiped_token: O,
) -> Result<uuid::Uuid>
where
    F: FnOnce(&mut creds::StoredCreds, &creds::CredentialRevision) -> Result<()>,
    O: FnOnce(&str),
{
    // Take secret ownership before inspecting any other success field. Every
    // early return below leaves the token inside an auto-zeroizing allocation.
    let mut token = body.access_token.take().map(Zeroizing::new);
    // The browser tuple is first-contact trust input. Do not inspect or decode
    // it until the existing host binding and success shape are exact.
    let result = (|| {
        verify_poll_identity(&body, identity)?;
        if body.error.is_some() {
            return Err(anyhow!("device/poll mixed success and error fields"));
        }
        let token_ref = token
            .as_deref()
            .context("device/poll success omitted access_token")?;
        let host_id = body
            .host_id
            .context("device/poll success omitted host_id")?;
        creds::validate_login_access_token(token_ref)?;
        let browser_device_id = body
            .browser_device_id
            .as_deref()
            .context("device/poll success omitted browser_device_id")?;
        let browser_key_algorithm = body
            .browser_key_algorithm
            .as_deref()
            .context("device/poll success omitted browser_key_algorithm")?;
        let browser_public_key = body
            .browser_public_key
            .as_deref()
            .context("device/poll success omitted browser_public_key")?;
        let browser_key_fingerprint = body
            .browser_key_fingerprint
            .as_deref()
            .context("device/poll success omitted browser_key_fingerprint")?;
        let browser_pin = creds::browser_pin_from_approval(
            browser_device_id,
            browser_key_algorithm,
            browser_public_key,
            browser_key_fingerprint,
        )
        .context("validating approved browser identity from device/poll")?;
        // Check the browser's own signature before storing the pin, so an
        // invalid proof never reaches the credential file.
        let approval_verified =
            verify_browser_approval(&body, identity, approval_nonce, browser_public_key)?;
        // Retain the proof itself, not a verdict about it, so every later load
        // re-derives the verdict rather than trusting this one.
        let browser_pin = if approval_verified {
            println!("spawn: browser approval proof verified");
            creds::attach_browser_approval_proof(
                browser_pin,
                body.account_id
                    .as_deref()
                    .expect("a verified proof carries an account ID"),
                approval_nonce,
                body.browser_approval_signature
                    .as_deref()
                    .expect("a verified proof carries a signature"),
            )
            .context("retaining the verified browser approval proof")?
        } else {
            println!("spawn: warning: this server supplied no browser approval proof");
            browser_pin
        };
        // The proof cannot tell a substituted browser key from the real one, so
        // the operator confirms this fingerprint matches the one their browser
        // shows. This is the only check a hostile server cannot pass.
        println!("spawn: verify browser fingerprint: {browser_key_fingerprint}");
        let owned_token = std::mem::take(
            &mut **token
                .as_mut()
                .expect("validated poll access token remains owned"),
        );
        creds::commit_login_update(
            stored,
            owned_token,
            host_id,
            server.to_string(),
            browser_pin,
            persist,
        )?;
        Ok(host_id)
    })();
    if result.is_err() {
        if let Some(token) = token.as_mut() {
            token.zeroize();
            observe_wiped_token(token.as_str());
        } else {
            observe_wiped_token("");
        }
    }
    result
}

fn verify_poll_identity(body: &DevicePollResponse, identity: &HostIdentity) -> Result<()> {
    if body.host_key_algorithm.as_deref() != Some(identity.algorithm)
        || body.host_public_key.as_deref() != Some(identity.public_key.as_str())
        || body.host_key_fingerprint.as_deref() != Some(identity.fingerprint.as_str())
    {
        return Err(anyhow!(
            "device/poll returned a mismatched host identity binding"
        ));
    }
    Ok(())
}

fn detect_hostname() -> String {
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "unknown-host".into())
}

#[cfg(test)]
mod tests {
    /// 32 zero bytes: a canonical 43-char base64url ceremony nonce.
    const TEST_ACCOUNT: &str = "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";
    const TEST_APPROVAL_NONCE: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    use super::*;

    const BROWSER_KEY: &str = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";

    fn identity() -> HostIdentity {
        HostIdentity {
            algorithm: "ed25519",
            public_key: "A".repeat(43),
            fingerprint: "SHA256:fingerprint".into(),
        }
    }

    fn response() -> DevicePollResponse {
        DevicePollResponse {
            access_token: Some("token".into()),
            host_id: Some(uuid::Uuid::nil()),
            host_key_algorithm: Some("ed25519".into()),
            host_public_key: Some("A".repeat(43)),
            host_key_fingerprint: Some("SHA256:fingerprint".into()),
            browser_device_id: None,
            browser_key_algorithm: None,
            browser_public_key: None,
            browser_key_fingerprint: None,
            account_id: None,
            browser_approval_signature: None,
            error: None,
        }
    }

    fn complete_response() -> DevicePollResponse {
        let mut body = response();
        body.browser_device_id = Some("11111111-2222-4333-8444-555555555555".into());
        body.browser_key_algorithm = Some("ed25519".into());
        body.browser_public_key = Some(BROWSER_KEY.into());
        body.browser_key_fingerprint = Some(creds::browser_key_fingerprint(BROWSER_KEY).unwrap());
        body
    }

    #[test]
    fn poll_success_requires_exact_identity_binding() {
        assert!(verify_poll_identity(&response(), &identity()).is_ok());
        let mut changed_key = response();
        changed_key.host_public_key = Some("B".repeat(43));
        assert!(verify_poll_identity(&changed_key, &identity()).is_err());
        let mut missing_fingerprint = response();
        missing_fingerprint.host_key_fingerprint = None;
        assert!(verify_poll_identity(&missing_fingerprint, &identity()).is_err());
    }

    #[test]
    fn poll_success_requires_and_persists_the_exact_browser_tuple() {
        let server = url::Url::parse("https://spawn.example/").unwrap();
        let mut stored = creds::StoredCreds::default();
        let persisted = std::cell::Cell::new(false);
        let host_id = commit_poll_success(
            &mut stored,
            complete_response(),
            &identity(),
            &server,
            TEST_APPROVAL_NONCE,
            |candidate, _| {
                persisted.set(true);
                assert_eq!(candidate.browser_pins().len(), 1);
                assert_eq!(candidate.browser_pins()[0].public_key(), BROWSER_KEY);
                Ok(())
            },
        )
        .unwrap();
        assert!(persisted.get());
        assert_eq!(host_id, uuid::Uuid::nil());
        assert_eq!(stored.access_token.as_deref(), Some("token"));
        assert_eq!(stored.server_url.as_deref(), Some("https://spawn.example/"));
        assert_eq!(stored.browser_pins().len(), 1);
    }

    #[test]
    fn poll_browser_tuple_is_validated_only_after_host_token_and_host_id() {
        let server = url::Url::parse("https://spawn.example/").unwrap();
        let mut wrong_host = complete_response();
        wrong_host.host_public_key = Some("different-host".into());
        wrong_host.browser_public_key = Some("short".into());
        let error = commit_poll_success(
            &mut creds::StoredCreds::default(),
            wrong_host,
            &identity(),
            &server,
            TEST_APPROVAL_NONCE,
            |_, _| Ok(()),
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("mismatched host identity"));

        let mut missing_token = complete_response();
        missing_token.access_token = None;
        missing_token.browser_public_key = Some("short".into());
        let error = commit_poll_success(
            &mut creds::StoredCreds::default(),
            missing_token,
            &identity(),
            &server,
            TEST_APPROVAL_NONCE,
            |_, _| Ok(()),
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("omitted access_token"));

        let mut missing_host_id = complete_response();
        missing_host_id.host_id = None;
        missing_host_id.browser_public_key = Some("short".into());
        let error = commit_poll_success(
            &mut creds::StoredCreds::default(),
            missing_host_id,
            &identity(),
            &server,
            TEST_APPROVAL_NONCE,
            |_, _| Ok(()),
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("omitted host_id"));

        for invalid_token in [String::new(), "x".repeat(12 * 1024 + 1)] {
            let mut invalid = complete_response();
            invalid.access_token = Some(invalid_token);
            invalid.browser_public_key = Some("short".into());
            let error = commit_poll_success(
                &mut creds::StoredCreds::default(),
                invalid,
                &identity(),
                &server,
                TEST_APPROVAL_NONCE,
                |_, _| Ok(()),
            )
            .unwrap_err();
            assert!(format!("{error:#}").contains("access token"));
        }
    }

    #[test]
    fn every_early_poll_failure_observes_a_wiped_returned_token() {
        let server = url::Url::parse("https://spawn.example/").unwrap();
        let mut cases = Vec::new();

        let mut wrong_host = complete_response();
        wrong_host.host_public_key = Some("different-host".into());
        cases.push(wrong_host);

        let mut mixed = complete_response();
        mixed.error = Some("denied".into());
        cases.push(mixed);

        let mut missing_host_id = complete_response();
        missing_host_id.host_id = None;
        cases.push(missing_host_id);

        let mut missing_browser_field = complete_response();
        missing_browser_field.browser_public_key = None;
        cases.push(missing_browser_field);

        let mut invalid_token = complete_response();
        invalid_token.access_token = Some("x".repeat(12 * 1024 + 1));
        cases.push(invalid_token);

        let mut invalid_pin = complete_response();
        invalid_pin.browser_public_key = Some("short".into());
        cases.push(invalid_pin);

        for body in cases {
            let observed = std::cell::Cell::new(false);
            let persisted = std::cell::Cell::new(false);
            assert!(commit_poll_success_observed(
                &mut creds::StoredCreds::default(),
                body,
                &identity(),
                &server,
                TEST_APPROVAL_NONCE,
                |_, _| {
                    persisted.set(true);
                    Ok(())
                },
                |wiped| {
                    observed.set(true);
                    assert!(wiped.is_empty());
                },
            )
            .is_err());
            assert!(observed.get());
            assert!(!persisted.get());
        }
    }

    #[test]
    fn poll_rejects_partial_malformed_conflicting_and_mixed_browser_bindings() {
        let server = url::Url::parse("https://spawn.example/").unwrap();
        let mut invalid = Vec::new();
        let mut missing_id = complete_response();
        missing_id.browser_device_id = None;
        invalid.push(missing_id);
        let mut missing_algorithm = complete_response();
        missing_algorithm.browser_key_algorithm = None;
        invalid.push(missing_algorithm);
        let mut missing_key = complete_response();
        missing_key.browser_public_key = None;
        invalid.push(missing_key);
        let mut missing_fingerprint = complete_response();
        missing_fingerprint.browser_key_fingerprint = None;
        invalid.push(missing_fingerprint);
        let mut malformed_id = complete_response();
        malformed_id.browser_device_id = Some("11111111222243338444555555555555".into());
        invalid.push(malformed_id);
        let mut wrong_algorithm = complete_response();
        wrong_algorithm.browser_key_algorithm = Some("Ed25519".into());
        invalid.push(wrong_algorithm);
        let mut malformed_key = complete_response();
        malformed_key.browser_public_key = Some("A".repeat(43));
        invalid.push(malformed_key);
        let mut wrong_fingerprint = complete_response();
        wrong_fingerprint.browser_key_fingerprint = Some("SHA256:wrong".into());
        invalid.push(wrong_fingerprint);
        let mut mixed = complete_response();
        mixed.error = Some("denied".into());
        invalid.push(mixed);

        for body in invalid {
            let persisted = std::cell::Cell::new(false);
            assert!(commit_poll_success(
                &mut creds::StoredCreds::default(),
                body,
                &identity(),
                &server,
                TEST_APPROVAL_NONCE,
                |_, _| {
                    persisted.set(true);
                    Ok(())
                },
            )
            .is_err());
            assert!(!persisted.get());
        }
    }

    #[test]
    fn browser_only_poll_fields_enter_the_fail_closed_success_path() {
        let body = DevicePollResponse {
            access_token: None,
            host_id: None,
            host_key_algorithm: None,
            host_public_key: None,
            host_key_fingerprint: None,
            browser_device_id: Some("11111111-2222-4333-8444-555555555555".into()),
            browser_key_algorithm: None,
            browser_public_key: None,
            browser_key_fingerprint: None,
            account_id: None,
            browser_approval_signature: None,
            error: None,
        };
        assert!(poll_has_success_fields(&body));
    }

    /// Build a ceremony whose browser approval proof is genuinely signed.
    fn signed_ceremony(
        nonce: &str,
    ) -> (HostIdentity, DevicePollResponse, ed25519_dalek::SigningKey) {
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use base64::Engine;

        let host_key = ed25519_dalek::SigningKey::from_bytes(&[7; 32]);
        let browser_key = ed25519_dalek::SigningKey::from_bytes(&[9; 32]);
        let host_wire = URL_SAFE_NO_PAD.encode(host_key.verifying_key().to_bytes());
        let browser_wire = URL_SAFE_NO_PAD.encode(browser_key.verifying_key().to_bytes());

        let identity = HostIdentity {
            algorithm: "ed25519",
            public_key: host_wire.clone(),
            fingerprint: "SHA256:fingerprint".into(),
        };

        let transcript =
            HostPairApprovalTranscript::from_wire(TEST_ACCOUNT, nonce, &host_wire, &browser_wire)
                .expect("valid approval transcript");
        let signature = host_pair_approval::signature_to_wire(
            &host_pair_approval::sign_transcript(&browser_key, &transcript),
        );

        let mut body = response();
        body.host_public_key = Some(host_wire);
        body.browser_device_id = Some("11111111-2222-4333-8444-555555555555".into());
        body.browser_key_algorithm = Some("ed25519".into());
        body.browser_key_fingerprint = Some(creds::browser_key_fingerprint(&browser_wire).unwrap());
        body.browser_public_key = Some(browser_wire);
        body.account_id = Some(TEST_ACCOUNT.into());
        body.browser_approval_signature = Some(signature);
        (identity, body, browser_key)
    }

    #[test]
    fn login_accepts_a_genuinely_signed_browser_approval() {
        let server = url::Url::parse("https://spawn.example/").unwrap();
        let (identity, body, _) = signed_ceremony(TEST_APPROVAL_NONCE);
        let mut stored = creds::StoredCreds::default();
        let persisted = std::cell::Cell::new(false);
        commit_poll_success(
            &mut stored,
            body,
            &identity,
            &server,
            TEST_APPROVAL_NONCE,
            |candidate, _| {
                persisted.set(true);
                assert_eq!(candidate.browser_pins().len(), 1);
                Ok(())
            },
        )
        .expect("a verified approval completes the login");
        assert!(persisted.get());
    }

    #[test]
    fn login_aborts_when_the_approval_proof_does_not_verify() {
        let server = url::Url::parse("https://spawn.example/").unwrap();
        let (identity, mut body, _) = signed_ceremony(TEST_APPROVAL_NONCE);
        // Flip one signature character: a forged or tampered proof.
        let signature = body.browser_approval_signature.take().unwrap();
        let flipped = if signature.starts_with('A') { 'B' } else { 'A' };
        body.browser_approval_signature = Some(format!("{flipped}{}", &signature[1..]));

        let persisted = std::cell::Cell::new(false);
        let error = commit_poll_success(
            &mut creds::StoredCreds::default(),
            body,
            &identity,
            &server,
            TEST_APPROVAL_NONCE,
            |_, _| {
                persisted.set(true);
                Ok(())
            },
        )
        .unwrap_err();
        assert!(
            format!("{error:#}").contains("browser approval proof"),
            "unexpected error: {error:#}"
        );
        assert!(!persisted.get(), "an unverified pin must never be stored");
    }

    #[test]
    fn login_rejects_an_approval_proof_from_another_ceremony() {
        let server = url::Url::parse("https://spawn.example/").unwrap();
        // Signed against a different nonce than the one this daemon started.
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use base64::Engine;
        let other_nonce = URL_SAFE_NO_PAD.encode([1_u8; 32]);
        let (identity, body, _) = signed_ceremony(&other_nonce);

        let persisted = std::cell::Cell::new(false);
        let error = commit_poll_success(
            &mut creds::StoredCreds::default(),
            body,
            &identity,
            &server,
            TEST_APPROVAL_NONCE,
            |_, _| {
                persisted.set(true);
                Ok(())
            },
        )
        .unwrap_err();
        assert!(
            format!("{error:#}").contains("browser approval proof"),
            "unexpected error: {error:#}"
        );
        assert!(!persisted.get());
    }

    #[test]
    fn login_still_completes_against_a_server_that_supplies_no_proof() {
        let server = url::Url::parse("https://spawn.example/").unwrap();
        let (identity, mut body, _) = signed_ceremony(TEST_APPROVAL_NONCE);
        body.account_id = None;
        body.browser_approval_signature = None;

        let persisted = std::cell::Cell::new(false);
        commit_poll_success(
            &mut creds::StoredCreds::default(),
            body,
            &identity,
            &server,
            TEST_APPROVAL_NONCE,
            |_, _| {
                persisted.set(true);
                Ok(())
            },
        )
        .expect("a pre-0022 server must still be able to pair");
        assert!(persisted.get());
    }
}
