//! `spawnd login` — interactive device-code flow.
//!
//! Flow per `proto/README.md`:
//!   1. POST /api/auth/device/start  -> { device_code, user_code, verification_uri, interval, expires_in }
//!   2. Print "open <verification_uri> and enter code XXXX-XXXX".
//!   3. Poll /api/auth/device/poll until success / expiry / denial.
//!   4. On success store {access_token, host_id, server_url}.

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use reqwest::StatusCode;

use crate::cli::LoginArgs;
use crate::config;
use crate::creds::{self, StoredCreds};
use crate::proto::{
    DevicePollRequest, DevicePollResponse, DeviceStartRequest, DeviceStartResponse,
};

pub async fn run(server_cli: Option<String>, args: LoginArgs) -> Result<()> {
    let server = config::server_url(server_cli)?;

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
        })
        .send()
        .await
        .context("POST /api/auth/device/start")?
        .error_for_status()?
        .json()
        .await
        .context("decoding device/start response")?;

    println!(
        "spawn: open {} and enter code:  {}",
        start.verification_uri, start.user_code
    );

    // 2. poll
    let poll_url = config::api_url(&server, "/api/auth/device/poll")?;
    let mut interval = Duration::from_secs(start.interval.max(1));
    let poll_body = DevicePollRequest {
        device_code: &start.device_code,
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

        if let (Some(token), Some(host_id)) = (body.access_token, body.host_id) {
            let creds = StoredCreds {
                access_token: Some(token),
                host_id: Some(host_id),
                server_url: Some(server.to_string()),
            };
            creds::save(&creds)?;
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

fn detect_hostname() -> String {
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "unknown-host".into())
}
