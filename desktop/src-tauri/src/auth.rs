use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use reqwest::Method;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use url::Url;

use crate::api::ApiClient;
use crate::crypto::DeviceIdentity;
use crate::models::{
    AccountState, AuthConfig, AuthOutcome, BrowserDevice, DesktopPreferences, MeResponse,
    SessionRenewResponse, TokenResponse,
};
use crate::storage;

/// The one native redirect every SPAWN D server release admits. It is the
/// same address the phone app hands back to, so a server configured for the
/// phone already accepts this app; the installed desktop companion claims the
/// `spawn://` scheme, so nothing else should receive what comes back.
pub const OAUTH_REDIRECT_URI: &str = "spawn://auth/oauth";

/// The providers a server can enable. Which of them actually appear comes from
/// `GET /api/auth/config` at sign-in time, never from this list.
pub const OAUTH_PROVIDERS: &[&str] = &["google", "microsoft", "github", "apple"];

pub async fn auth_config(origin: &str) -> Result<AuthConfig> {
    let api = ApiClient::new(origin)?;
    api.anonymous_get("/api/auth/config")
        .await
        .context("reading the server's sign-in options")
}

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

/// The PKCE verifier for the sign-in this app is currently running.
///
/// A `spawn://auth/oauth?code=…` link arrives from the operating system, and
/// the OS does not say who sent it. Without this, any such link would be
/// exchanged: an attacker could complete OAuth with their own account and lure
/// someone into opening the resulting link, at which point this app would sign
/// itself into the attacker's account — and then, because the host gate
/// possesses on arrival, register that person's computer as a host under it.
/// The verifier never leaves this process until redemption, so a code minted
/// for a flow that started somewhere else cannot be spent here.
static PENDING_OAUTH: Mutex<Option<String>> = Mutex::new(None);

fn begin_pkce() -> Result<String> {
    let mut raw = [0u8; 32];
    getrandom::getrandom(&mut raw).map_err(|error| anyhow::anyhow!("{error}"))?;
    let verifier = URL_SAFE_NO_PAD.encode(raw);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    *PENDING_OAUTH.lock().expect("pending OAuth lock") = Some(verifier);
    Ok(challenge)
}

/// Take the pending verifier, so a code can be redeemed at most once and only
/// by the flow that is actually outstanding.
fn take_pkce_verifier() -> Option<String> {
    PENDING_OAUTH.lock().expect("pending OAuth lock").take()
}

pub fn oauth_start_url(origin: &str, provider: &str, invite: Option<&str>) -> Result<String> {
    if !OAUTH_PROVIDERS.contains(&provider) {
        bail!("unsupported OAuth provider")
    }
    let challenge = begin_pkce()?;
    let mut url = Url::parse(origin)?.join(&format!("/api/auth/oauth/{provider}/start"))?;
    url.query_pairs_mut()
        .append_pair("return_to", "/")
        .append_pair("redirect_uri", OAUTH_REDIRECT_URI)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256");
    if let Some(invite) = invite.filter(|value| !value.trim().is_empty()) {
        url.query_pairs_mut().append_pair("invite", invite.trim());
    }
    Ok(url.to_string())
}

pub async fn exchange_oauth_code(origin: &str, code: &str) -> Result<AuthOutcome> {
    let Some(verifier) = take_pkce_verifier() else {
        bail!("This sign-in did not start in SPAWN D. Open SPAWN D and sign in from there.")
    };
    let api = ApiClient::new(origin)?;
    let response: TokenResponse = api
        .anonymous_json(
            Method::POST,
            "/api/auth/oauth/exchange",
            &json!({ "code": code, "code_verifier": verifier }),
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

/// Renew the app session and hand back the browser session cookie the server
/// sets alongside it, so the app window opens already signed in.
pub async fn browser_session_cookie() -> Result<Option<String>> {
    let preferences = storage::load_preferences()?;
    let api = ApiClient::new(&preferences.server_origin)?;
    let (response, headers): (SessionRenewResponse, _) = api
        .authenticated_post_with_headers("/api/auth/session/renew")
        .await
        .context("renewing the SPAWN D session")?;
    storage::set_token(&preferences.server_origin, &response.access_token)?;
    Ok(headers
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find(|value| value.trim_start().starts_with("spawn_session="))
        .map(str::to_owned))
}

/// Whether this server is new enough for this app.
///
/// The app rides its own updater channel, so it can meet a server that
/// predates something it needs — a self-hosted one, or a hosted one that has
/// not been deployed yet. `POST /api/auth/session/renew` is the sentinel: it
/// is the last step of every sign-in here, it answers 401 unauthenticated
/// where it exists and 404 where it does not, so the question can be asked
/// before anyone has typed a password.
pub async fn server_is_supported(origin: &str) -> Result<bool> {
    let api = ApiClient::new(origin)?;
    let status = api.probe(Method::POST, "/api/auth/session/renew").await?;
    Ok(endpoint_exists(status))
}

fn endpoint_exists(status: reqwest::StatusCode) -> bool {
    !matches!(
        status,
        reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::METHOD_NOT_ALLOWED
    )
}

/// The verify gate's poll: the server is the only authority on whether the
/// address has been confirmed, so nothing about it is cached locally.
pub async fn account_state() -> Result<AccountState> {
    let preferences = storage::load_preferences()?;
    let api = ApiClient::new(&preferences.server_origin)?;
    let me: MeResponse = api
        .authenticated_get("/api/me")
        .await
        .context("checking your account")?;
    Ok(AccountState {
        email: me.user.email,
        email_verified: me.user.email_verified_at.is_some(),
    })
}

pub async fn request_email_verification() -> Result<()> {
    let preferences = storage::load_preferences()?;
    let api = ApiClient::new(&preferences.server_origin)?;
    api.authenticated_post_no_content("/api/auth/verify-email/request")
        .await
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
                "label": crate::platform::DEVICE_LABEL,
                "key_algorithm": "ed25519",
                "public_key": public_key,
                "signature": signature
            }),
        )
        .await
        .with_context(|| {
            format!(
                "registering {} as a SPAWN D device",
                crate::platform::THIS_COMPUTER
            )
        })?;
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
            .with_context(|| {
                format!(
                    "asking an existing device to approve {}",
                    crate::platform::THIS_COMPUTER
                )
            })?;
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
        email_verified: response.user.email_verified_at.is_some(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_server_without_the_endpoint_is_the_one_that_answers_404() {
        // Present: the route is there and simply wants an account.
        assert!(endpoint_exists(reqwest::StatusCode::UNAUTHORIZED));
        assert!(endpoint_exists(reqwest::StatusCode::FORBIDDEN));
        assert!(endpoint_exists(reqwest::StatusCode::OK));
        // Absent: an older server routes nothing at this path.
        assert!(!endpoint_exists(reqwest::StatusCode::NOT_FOUND));
        assert!(!endpoint_exists(reqwest::StatusCode::METHOD_NOT_ALLOWED));
    }

    /// `PENDING_OAUTH` is process-wide on purpose: the app has one window and
    /// one sign-in at a time, and a newly started flow should invalidate an
    /// abandoned one. Tests that drive it therefore have to take turns.
    static OAUTH_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn oauth_test_guard() -> std::sync::MutexGuard<'static, ()> {
        let guard = OAUTH_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        take_pkce_verifier();
        guard
    }

    #[test]
    fn oauth_hands_back_to_the_redirect_every_server_release_allows() {
        let _guard = oauth_test_guard();
        let value = oauth_start_url("https://spawnd.dev", "google", None).unwrap();
        let parsed = Url::parse(&value).unwrap();
        let params: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(
            params.get("redirect_uri").map(String::as_str),
            Some("spawn://auth/oauth")
        );
        assert_eq!(params.get("return_to").map(String::as_str), Some("/"));
        assert_eq!(parsed.path(), "/api/auth/oauth/google/start");
        assert!(!params.contains_key("invite"));
    }

    #[test]
    fn oauth_start_commits_to_a_pkce_challenge_the_verifier_opens() {
        let _guard = oauth_test_guard();
        let value = oauth_start_url("https://spawnd.dev", "google", None).unwrap();
        let parsed = Url::parse(&value).unwrap();
        let params: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        let challenge = params.get("code_challenge").expect("a challenge is sent");
        assert_eq!(
            params.get("code_challenge_method").map(String::as_str),
            Some("S256")
        );
        let verifier = take_pkce_verifier().expect("a verifier is held");
        assert!(verifier.len() >= 43, "{verifier}");
        assert_ne!(&verifier, challenge, "the challenge is not the verifier");
        assert_eq!(
            &URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())),
            challenge
        );
        // Taken exactly once: a second callback has nothing to spend.
        assert!(take_pkce_verifier().is_none());
    }

    #[tokio::test]
    async fn a_code_for_a_flow_that_started_elsewhere_is_never_exchanged() {
        let _guard = oauth_test_guard();
        // Nothing is pending — no `oauth_start_url` ran for this flow. The
        // deep link an attacker lured onto this machine dies here, before any
        // request is made.
        assert!(take_pkce_verifier().is_none());
        let error = exchange_oauth_code("https://spawnd.dev", &"a".repeat(32))
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("did not start in SPAWN D"),
            "{error}"
        );
    }

    #[test]
    fn oauth_carries_an_invite_only_when_one_was_typed() {
        let _guard = oauth_test_guard();
        let value = oauth_start_url("https://spawnd.dev", "apple", Some("  ")).unwrap();
        assert!(!value.contains("invite="));
        let value = oauth_start_url("https://spawnd.dev", "apple", Some(" ABC-123 ")).unwrap();
        let parsed = Url::parse(&value).unwrap();
        let params: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(params.get("invite").map(String::as_str), Some("ABC-123"));
        assert!(oauth_start_url("https://spawnd.dev", "facebook", None).is_err());
    }

    #[test]
    fn auth_config_defaults_every_field_an_older_server_omits() {
        let parsed: AuthConfig = serde_json::from_str("{}").unwrap();
        assert!(parsed.providers.is_empty());
        assert!(!parsed.email_verification_required);
        assert!(!parsed.invite_only);
        let parsed: AuthConfig = serde_json::from_str(
            r#"{"providers":[{"id":"google","name":"Google"},{"id":"apple","name":"Apple"}],"email_verification_required":true,"invite_only":true}"#,
        )
        .unwrap();
        assert_eq!(parsed.providers.len(), 2);
        assert_eq!(parsed.providers[1].id, "apple");
        assert!(parsed.email_verification_required && parsed.invite_only);
    }

    #[test]
    fn a_user_without_a_verified_at_reads_as_unverified() {
        let user: TokenResponse = serde_json::from_str(
            r#"{"access_token":"t","user":{"id":"u1","email":"a@b.c","created_at":"2026-01-01T00:00:00Z"}}"#,
        )
        .unwrap();
        assert!(user.user.email_verified_at.is_none());
    }
}
