//! `spawnd login` — interactive device-code flow.
//!
//! Flow per `proto/README.md`:
//!   1. POST /api/auth/device/start  -> { device_code, user_code, verification_uri, interval, expires_in }
//!   2. Sign and POST /api/auth/device/possession for that exact ceremony.
//!   3. Only after proof succeeds, print the verification URI and user code.
//!   4. Poll /api/auth/device/poll until success / expiry / denial.
//!   5. On success store {access_token, host_id, server_url}.

use std::io::{self, IsTerminal, Read, Write};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use reqwest::StatusCode;
use zeroize::{Zeroize, Zeroizing};

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
    let expected_browser_fingerprint = args.expect_browser_fingerprint;
    if let Some(expected) = expected_browser_fingerprint.as_deref() {
        validate_browser_fingerprint_shape(expected)
            .context("validating --expect-browser-fingerprint")?;
    }

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

    println!(
        "spawn: open {} and enter code:  {}",
        start.verification_uri, start.user_code
    );
    println!("spawn: verify host fingerprint: {}", identity.fingerprint);

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
                expected_browser_fingerprint.as_deref(),
                prompt_for_browser_fingerprint,
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

fn commit_poll_success<F>(
    stored: &mut creds::StoredCreds,
    body: DevicePollResponse,
    identity: &HostIdentity,
    server: &url::Url,
    expected_browser_fingerprint: Option<&str>,
    prompt: impl FnOnce() -> Result<String>,
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
        BrowserFingerprintConfirmation {
            expected: expected_browser_fingerprint,
            prompt,
        },
        persist,
        |_| {},
    )
}

struct BrowserFingerprintConfirmation<'a, P> {
    expected: Option<&'a str>,
    prompt: P,
}

fn commit_poll_success_observed<F, P, O>(
    stored: &mut creds::StoredCreds,
    mut body: DevicePollResponse,
    identity: &HostIdentity,
    server: &url::Url,
    confirmation: BrowserFingerprintConfirmation<'_, P>,
    persist: F,
    observe_wiped_token: O,
) -> Result<uuid::Uuid>
where
    F: FnOnce(&mut creds::StoredCreds, &creds::CredentialRevision) -> Result<()>,
    P: FnOnce() -> Result<String>,
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
        let requires_confirmation = creds::browser_pin_requires_confirmation(
            stored,
            host_id,
            server.as_str(),
            &browser_pin,
        )
        .context("authorizing approved browser identity in the local trust domain")?;
        if let Some(expected) = confirmation.expected {
            verify_exact_browser_fingerprint(expected, browser_pin.fingerprint())?;
        } else if requires_confirmation {
            let entered = (confirmation.prompt)()?;
            verify_exact_browser_fingerprint(&entered, browser_pin.fingerprint())?;
        }
        let browser_pin = creds::confirm_browser_pin(browser_pin);
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

fn verify_exact_browser_fingerprint(entered: &str, locally_derived: &str) -> Result<()> {
    validate_browser_fingerprint_shape(entered)?;
    if entered != locally_derived {
        return Err(anyhow!(
            "browser fingerprint confirmation did not exactly match the locally derived full fingerprint"
        ));
    }
    Ok(())
}

fn validate_browser_fingerprint_shape(value: &str) -> Result<()> {
    const PREFIX: &str = "SHA256:";
    const SUFFIX_BYTES: usize = 16;
    if value.len() != PREFIX.len() + SUFFIX_BYTES
        || !value.starts_with(PREFIX)
        || !value[PREFIX.len()..]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(anyhow!(
            "browser fingerprint confirmation must be one exact full SHA256: base64url value"
        ));
    }
    Ok(())
}

fn prompt_for_browser_fingerprint() -> Result<String> {
    let stdin = io::stdin();
    prompt_for_browser_fingerprint_from(&mut stdin.lock(), stdin.is_terminal())
}

fn prompt_for_browser_fingerprint_from(
    reader: &mut impl Read,
    is_terminal: bool,
) -> Result<String> {
    if !is_terminal {
        return Err(anyhow!(
            "first-contact browser trust requires an interactive terminal or --expect-browser-fingerprint with the exact full value shown by the browser"
        ));
    }
    eprintln!("spawn: first contact requires reciprocal browser verification.");
    eprintln!("spawn: copy the exact full browser fingerprint from the browser approval page.");
    eprint!("spawn: browser fingerprint: ");
    io::stderr()
        .flush()
        .context("flushing fingerprint prompt")?;
    read_exact_fingerprint_line(reader)
}

fn read_exact_fingerprint_line(reader: &mut impl Read) -> Result<String> {
    // 23 fingerprint bytes plus CRLF. Stop without allocating past the bound.
    const MAX_LINE_BYTES: usize = 25;
    let mut bytes = Vec::with_capacity(MAX_LINE_BYTES);
    for _ in 0..MAX_LINE_BYTES {
        let mut byte = [0_u8; 1];
        match reader
            .read(&mut byte)
            .context("reading browser fingerprint")?
        {
            0 => {
                return Err(anyhow!(
                    "browser fingerprint confirmation ended before a complete line was entered"
                ))
            }
            1 => {
                bytes.push(byte[0]);
                if byte[0] == b'\n' {
                    if bytes.len() >= 2 && bytes[bytes.len() - 2] == b'\r' {
                        bytes.truncate(bytes.len() - 2);
                    } else {
                        bytes.pop();
                    }
                    return String::from_utf8(bytes)
                        .context("browser fingerprint confirmation was not UTF-8");
                }
            }
            _ => unreachable!("one-byte read returned more than one byte"),
        }
    }
    Err(anyhow!(
        "browser fingerprint confirmation exceeded the exact full fingerprint bound"
    ))
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
    use super::*;

    const BROWSER_KEY: &str = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
    const BROWSER_FINGERPRINT: &str = "SHA256:If4x36FUomFia_hU";

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
            Some(BROWSER_FINGERPRINT),
            || unreachable!("explicit confirmation must not prompt"),
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
            Some(BROWSER_FINGERPRINT),
            || unreachable!("invalid response must not prompt"),
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
            Some(BROWSER_FINGERPRINT),
            || unreachable!("invalid response must not prompt"),
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
            Some(BROWSER_FINGERPRINT),
            || unreachable!("invalid response must not prompt"),
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
                Some(BROWSER_FINGERPRINT),
                || unreachable!("invalid response must not prompt"),
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
                BrowserFingerprintConfirmation {
                    expected: Some(BROWSER_FINGERPRINT),
                    prompt: || unreachable!("invalid response must not prompt"),
                },
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
                Some(BROWSER_FINGERPRINT),
                || unreachable!("invalid response must not prompt"),
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
            error: None,
        };
        assert!(poll_has_success_fields(&body));
    }

    #[test]
    fn exact_fingerprint_confirmation_rejects_every_non_exact_form() {
        assert!(verify_exact_browser_fingerprint(BROWSER_FINGERPRINT, BROWSER_FINGERPRINT).is_ok());
        for entered in [
            "SHA256:If4x36FUomFia_h",
            "sha256:If4x36FUomFia_hU",
            "SHA256:if4x36FUomFia_hU",
            "SHA256:If4x36FUomFia_hU ",
            " SHA256:If4x36FUomFia_hU",
            "If4x36FUomFia_hU",
            "SHA256:not-a-fingerprint",
            "",
        ] {
            assert!(verify_exact_browser_fingerprint(entered, BROWSER_FINGERPRINT).is_err());
        }
    }

    #[test]
    fn bounded_interactive_entry_accepts_only_an_exact_complete_line() {
        for line in [
            format!("{BROWSER_FINGERPRINT}\n"),
            format!("{BROWSER_FINGERPRINT}\r\n"),
        ] {
            assert_eq!(
                prompt_for_browser_fingerprint_from(&mut line.as_bytes(), true).unwrap(),
                BROWSER_FINGERPRINT
            );
        }
        for line in [
            BROWSER_FINGERPRINT.to_owned(),
            format!("{BROWSER_FINGERPRINT}extra\n"),
        ] {
            assert!(prompt_for_browser_fingerprint_from(&mut line.as_bytes(), true).is_err());
        }
        for line in [format!("{BROWSER_FINGERPRINT} \n"), "\n".to_owned()] {
            let entered = prompt_for_browser_fingerprint_from(&mut line.as_bytes(), true).unwrap();
            assert!(verify_exact_browser_fingerprint(&entered, BROWSER_FINGERPRINT).is_err());
        }
        assert!(prompt_for_browser_fingerprint_from(
            &mut format!("{BROWSER_FINGERPRINT}\n").as_bytes(),
            false,
        )
        .is_err());
    }

    #[test]
    fn first_contact_requires_confirmation_but_known_exact_pin_relogin_does_not_prompt() {
        let server = url::Url::parse("https://spawn.example/").unwrap();
        let mut stored = creds::StoredCreds::default();
        let prompt_calls = std::cell::Cell::new(0);
        commit_poll_success(
            &mut stored,
            complete_response(),
            &identity(),
            &server,
            None,
            || {
                prompt_calls.set(prompt_calls.get() + 1);
                Ok(BROWSER_FINGERPRINT.to_owned())
            },
            |_, _| Ok(()),
        )
        .unwrap();
        assert_eq!(prompt_calls.get(), 1);

        commit_poll_success(
            &mut stored,
            complete_response(),
            &identity(),
            &server,
            None,
            || {
                prompt_calls.set(prompt_calls.get() + 1);
                Err(anyhow!("known pin unexpectedly prompted"))
            },
            |_, _| Ok(()),
        )
        .unwrap();
        assert_eq!(prompt_calls.get(), 1);
        assert_eq!(stored.browser_pins().len(), 1);
    }

    #[test]
    fn legacy_server_mediated_pin_promotes_only_after_oob_and_successful_atomic_save() {
        let server = url::Url::parse("https://spawn.example/").unwrap();
        let mut legacy = creds::StoredCreds::default();
        legacy.host_id = Some(uuid::Uuid::nil());
        legacy.server_url = Some(server.to_string());
        let unconfirmed = creds::browser_pin_from_approval(
            "11111111-2222-4333-8444-555555555555",
            "ed25519",
            BROWSER_KEY,
            BROWSER_FINGERPRINT,
        )
        .unwrap();
        assert!(creds::merge_browser_pin(&mut legacy, unconfirmed).unwrap());
        assert!(legacy
            .browser_pin(uuid::Uuid::parse_str("11111111-2222-4333-8444-555555555555").unwrap())
            .is_none());

        let mut failed = legacy.clone();
        let prompted = std::cell::Cell::new(false);
        assert!(commit_poll_success(
            &mut failed,
            complete_response(),
            &identity(),
            &server,
            None,
            || {
                prompted.set(true);
                Ok(BROWSER_FINGERPRINT.to_owned())
            },
            |candidate, _| {
                assert!(candidate.browser_pins()[0].is_oob_confirmed());
                Err(anyhow!("injected legacy promotion save failure"))
            },
        )
        .is_err());
        assert!(prompted.get());
        assert!(!failed.browser_pins()[0].is_oob_confirmed());
        assert!(failed
            .browser_pin(uuid::Uuid::parse_str("11111111-2222-4333-8444-555555555555").unwrap())
            .is_none());
        assert!(failed.access_token.is_none());

        commit_poll_success(
            &mut legacy,
            complete_response(),
            &identity(),
            &server,
            Some(BROWSER_FINGERPRINT),
            || unreachable!(),
            |candidate, _| {
                assert!(candidate.browser_pins()[0].is_oob_confirmed());
                Ok(())
            },
        )
        .unwrap();
        assert!(legacy.browser_pins()[0].is_oob_confirmed());
        assert!(legacy
            .browser_pin(uuid::Uuid::parse_str("11111111-2222-4333-8444-555555555555").unwrap())
            .is_some());
    }

    #[test]
    fn substituted_key_and_confirmation_failure_wipe_token_without_persisting() {
        let server = url::Url::parse("https://spawn.example/").unwrap();
        let signing_key = ed25519_dalek::SigningKey::from_bytes(&[7_u8; 32]);
        let substituted_key =
            spawnd::signed_signal::public_key_to_wire(&signing_key.verifying_key());
        let mut body = complete_response();
        body.browser_public_key = Some(substituted_key.clone());
        body.browser_key_fingerprint =
            Some(creds::browser_key_fingerprint(&substituted_key).unwrap());
        let persisted = std::cell::Cell::new(false);
        let wiped = std::cell::Cell::new(false);
        assert!(commit_poll_success_observed(
            &mut creds::StoredCreds::default(),
            body,
            &identity(),
            &server,
            BrowserFingerprintConfirmation {
                expected: Some(BROWSER_FINGERPRINT),
                prompt: || unreachable!("explicit confirmation must not prompt"),
            },
            |_, _| {
                persisted.set(true);
                Ok(())
            },
            |token| {
                wiped.set(true);
                assert!(token.is_empty());
            },
        )
        .is_err());
        assert!(wiped.get());
        assert!(!persisted.get());
    }

    #[test]
    fn known_pin_device_key_and_domain_conflicts_fail_before_prompt_or_persist() {
        let server = url::Url::parse("https://spawn.example/").unwrap();
        let mut stored = creds::StoredCreds::default();
        commit_poll_success(
            &mut stored,
            complete_response(),
            &identity(),
            &server,
            Some(BROWSER_FINGERPRINT),
            || unreachable!(),
            |_, _| Ok(()),
        )
        .unwrap();

        let mut id_conflict = complete_response();
        id_conflict.browser_device_id = Some("22222222-2222-4222-8222-222222222222".into());
        let signing_key = ed25519_dalek::SigningKey::from_bytes(&[9_u8; 32]);
        let other_key = spawnd::signed_signal::public_key_to_wire(&signing_key.verifying_key());
        let mut key_conflict = complete_response();
        key_conflict.browser_public_key = Some(other_key.clone());
        key_conflict.browser_key_fingerprint =
            Some(creds::browser_key_fingerprint(&other_key).unwrap());
        let mut host_conflict = complete_response();
        host_conflict.host_id = Some(uuid::Uuid::from_u128(9));
        for (body, origin) in [
            (id_conflict, "https://spawn.example/"),
            (key_conflict, "https://spawn.example/"),
            (host_conflict, "https://spawn.example/"),
            (complete_response(), "https://other.example/"),
        ] {
            let persisted = std::cell::Cell::new(false);
            let prompt_called = std::cell::Cell::new(false);
            assert!(commit_poll_success(
                &mut stored,
                body,
                &identity(),
                &url::Url::parse(origin).unwrap(),
                None,
                || {
                    prompt_called.set(true);
                    Ok(BROWSER_FINGERPRINT.to_owned())
                },
                |_, _| {
                    persisted.set(true);
                    Ok(())
                },
            )
            .is_err());
            assert!(!prompt_called.get());
            assert!(!persisted.get());
        }
    }

    #[test]
    fn capacity_and_save_failure_abort_after_confirmation_with_token_wiped() {
        let server = url::Url::parse("https://spawn.example/").unwrap();
        let mut full = creds::StoredCreds::default();
        full.host_id = Some(uuid::Uuid::nil());
        full.server_url = Some(server.to_string());
        for index in 0..creds::MAX_BROWSER_PINS {
            let signing_key =
                ed25519_dalek::SigningKey::from_bytes(&[(index as u8).saturating_add(50); 32]);
            let public_key =
                spawnd::signed_signal::public_key_to_wire(&signing_key.verifying_key());
            let fingerprint = creds::browser_key_fingerprint(&public_key).unwrap();
            let pin = creds::browser_pin_from_approval(
                &uuid::Uuid::from_u128(index as u128 + 1).to_string(),
                "ed25519",
                &public_key,
                &fingerprint,
            )
            .unwrap();
            assert!(creds::merge_browser_pin(&mut full, pin).unwrap());
        }
        let prompted = std::cell::Cell::new(false);
        let persisted = std::cell::Cell::new(false);
        let wiped = std::cell::Cell::new(false);
        assert!(commit_poll_success_observed(
            &mut full,
            complete_response(),
            &identity(),
            &server,
            BrowserFingerprintConfirmation {
                expected: None,
                prompt: || {
                    prompted.set(true);
                    Ok(BROWSER_FINGERPRINT.to_owned())
                },
            },
            |_, _| {
                persisted.set(true);
                Ok(())
            },
            |token| {
                wiped.set(true);
                assert!(token.is_empty());
            },
        )
        .is_err());
        assert!(!prompted.get());
        assert!(!persisted.get());
        assert!(wiped.get());

        let mut empty = creds::StoredCreds::default();
        let wiped = std::cell::Cell::new(false);
        let error = commit_poll_success_observed(
            &mut empty,
            complete_response(),
            &identity(),
            &server,
            BrowserFingerprintConfirmation {
                expected: Some(BROWSER_FINGERPRINT),
                prompt: || unreachable!(),
            },
            |_, _| Err(anyhow!("injected confirmed-login save failure")),
            |token| {
                wiped.set(true);
                assert!(token.is_empty());
            },
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("injected confirmed-login save failure"));
        assert!(wiped.get());
        assert!(empty.access_token.is_none());
        assert!(empty.browser_pins().is_empty());
    }
}
