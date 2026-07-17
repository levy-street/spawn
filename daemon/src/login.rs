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
    let identity = creds::ensure_host_identity(&mut stored)?;
    creds::save(&stored).context("persisting host identity")?;

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

        if body.access_token.is_some()
            || body.host_id.is_some()
            || body.host_key_algorithm.is_some()
            || body.host_public_key.is_some()
            || body.host_key_fingerprint.is_some()
        {
            verify_poll_identity(&body, &identity)?;
            if body.error.is_some() {
                return Err(anyhow!("device/poll mixed success and error fields"));
            }
            let token = body
                .access_token
                .context("device/poll success omitted access_token")?;
            let host_id = body
                .host_id
                .context("device/poll success omitted host_id")?;
            stored.access_token = Some(token);
            stored.host_id = Some(host_id);
            stored.server_url = Some(server.to_string());
            creds::save(&stored)?;
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
            error: None,
        }
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
}
