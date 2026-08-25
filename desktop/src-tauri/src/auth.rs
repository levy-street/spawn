use anyhow::{bail, Context, Result};
use reqwest::Method;
use serde_json::json;
use url::Url;

use crate::api::ApiClient;
use crate::crypto::DeviceIdentity;
use crate::models::{
    AuthOutcome, BrowserDevice, DesktopPreferences, SessionRenewResponse, TokenResponse,
};
use crate::storage;

pub const OAUTH_REDIRECT_URI: &str = "spawn://oauth/callback";

pub async fn password_login(origin: &str, email: &str, password: &str) -> Result<AuthOutcome> {
    let api = ApiClient::new(origin)?;
    let response: TokenResponse = api
        .anonymous_json(
            Method::POST,
            "/api/auth/login",
            &json!({ "email": email, "password": password }),
        )
        .await?;
    finish_auth(origin, response).await
}

pub async fn password_signup(
    origin: &str,
    email: &str,
    password: &str,
    invite: Option<&str>,
) -> Result<AuthOutcome> {
    let api = ApiClient::new(origin)?;
    let response: TokenResponse = api
        .anonymous_json(
            Method::POST,
            "/api/auth/signup",
            &json!({ "email": email, "password": password, "invite": invite }),
        )
        .await?;
    finish_auth(origin, response).await
}

pub fn oauth_start_url(origin: &str, provider: &str, invite: Option<&str>) -> Result<String> {
    if !matches!(provider, "google" | "github" | "microsoft" | "apple") {
        bail!("unsupported OAuth provider")
    }
    let mut url = Url::parse(origin)?.join(&format!("/api/auth/oauth/{provider}/start"))?;
    url.query_pairs_mut()
        .append_pair("return_to", "/")
        .append_pair("redirect_uri", OAUTH_REDIRECT_URI);
    if let Some(invite) = invite.filter(|value| !value.trim().is_empty()) {
        url.query_pairs_mut().append_pair("invite", invite.trim());
    }
    Ok(url.to_string())
}

pub async fn exchange_oauth_code(origin: &str, code: &str) -> Result<AuthOutcome> {
    let api = ApiClient::new(origin)?;
    let response: TokenResponse = api
        .anonymous_json(
            Method::POST,
            "/api/auth/oauth/exchange",
            &json!({ "code": code }),
        )
        .await?;
    finish_auth(origin, response).await
}

pub async fn renew_session() -> Result<()> {
    let preferences = storage::load_preferences()?;
    let api = ApiClient::new(&preferences.server_origin)?;
    let response: SessionRenewResponse = api
        .authenticated_post("/api/auth/session/renew")
        .await
        .context("renewing the SPAWN D session")?;
    storage::set_token(&preferences.server_origin, &response.access_token)
}

async fn finish_auth(origin: &str, response: TokenResponse) -> Result<AuthOutcome> {
    let origin = storage::normalize_server_url(origin).map_err(anyhow::Error::msg)?;
    storage::set_token(&origin, &response.access_token)?;
    let api = ApiClient::new(&origin)?;
    let before: Vec<BrowserDevice> = api
        .authenticated_get("/api/browser-devices")
        .await
        .context("checking this account's existing devices")?;
    let identity = DeviceIdentity::load_or_create(&response.user.id)?;
    let public_key = identity.public_key_wire();
    let signature = identity.registration_proof(&response.user.id)?;
    let registered: BrowserDevice = api
        .authenticated_json(
            Method::POST,
            "/api/browser-devices/register",
            &json!({
                "label": "SPAWN D on Mac",
                "key_algorithm": "ed25519",
                "public_key": public_key,
                "signature": signature
            }),
        )
        .await
        .context("registering this Mac as a SPAWN D device")?;
    if registered.key_algorithm != "ed25519"
        || registered.public_key != public_key
        || registered.revoked_at.is_some()
    {
        bail!("Registered device does not match the local identity")
    }
    let approval_required = before
        .iter()
        .any(|device| device.id != registered.id && device.revoked_at.is_none() && !device.is_root);
    if approval_required {
        let _: serde_json::Value = api
            .authenticated_json(
                Method::POST,
                "/api/trust/device-approvals",
                &json!({ "browser_device_id": registered.id }),
            )
            .await
            .context("asking an existing device to approve this Mac")?;
    }
    let renewal: SessionRenewResponse = api
        .authenticated_post("/api/auth/session/renew")
        .await
        .context("establishing the long-lived SPAWN D app session")?;
    storage::set_token(&origin, &renewal.access_token)?;
    let mut preferences = DesktopPreferences {
        server_origin: origin,
        account_id: Some(response.user.id.clone()),
        account_email: Some(response.user.email.clone()),
        device_id: Some(registered.id.clone()),
        device_approved: !approval_required,
        first_run_complete: false,
        host_name: None,
    };
    // Preserve a completed local host if a session renewal re-registers the
    // same account. A different account always returns to the wizard.
    if let Ok(existing) = storage::load_preferences() {
        if existing.account_id.as_deref() == Some(response.user.id.as_str()) {
            preferences.first_run_complete = existing.first_run_complete;
            preferences.host_name = existing.host_name;
        }
    }
    storage::save_preferences(&preferences)?;
    Ok(AuthOutcome {
        account_id: response.user.id,
        email: response.user.email,
        device_id: registered.id,
        approval_required,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oauth_uses_the_one_registered_desktop_redirect() {
        let value = oauth_start_url("https://spawnd.dev", "github", None).unwrap();
        let parsed = Url::parse(&value).unwrap();
        let params: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(
            params.get("redirect_uri").map(String::as_str),
            Some(OAUTH_REDIRECT_URI)
        );
        assert_eq!(params.get("return_to").map(String::as_str), Some("/"));
        assert_eq!(parsed.path(), "/api/auth/oauth/github/start");
    }
}
