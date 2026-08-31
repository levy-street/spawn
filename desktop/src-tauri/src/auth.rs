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
#[cfg(not(target_os = "macos"))]
pub const OAUTH_UNSUPPORTED: &str = "unsupported";
#[cfg(target_os = "macos")]
pub const OAUTH_CANCELLED: &str = "cancelled";

#[cfg(target_os = "macos")]
const OAUTH_START_FAILED: &str = "start_failed:";

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

/// Present the provider with the platform OAuth primitive and return the full
/// native callback URL. The PKCE state comes from [`oauth_start_url`] exactly
/// as it does for the browser flow, so [`exchange_oauth_code`] consumes the
/// same process-held verifier whichever surface completed the sign-in.
#[cfg(target_os = "macos")]
pub async fn oauth_authenticate(
    app: tauri::AppHandle,
    origin: &str,
    provider: &str,
    invite: Option<&str>,
) -> Result<String> {
    let start_url = oauth_start_url(origin, provider, invite)
        .map_err(|error| anyhow::anyhow!("{OAUTH_START_FAILED}{error:#}"))?;
    macos_oauth::authenticate(app, start_url)
        .await
        .map_err(anyhow::Error::msg)
}

/// Other platforms keep the browser plus deep-link route. The sentinel lets
/// the wizard select it without relying on user-agent detection for behavior.
#[cfg(not(target_os = "macos"))]
pub async fn oauth_authenticate(
    _app: tauri::AppHandle,
    _origin: &str,
    _provider: &str,
    _invite: Option<&str>,
) -> Result<String> {
    bail!(OAUTH_UNSUPPORTED)
}

#[cfg(target_os = "macos")]
mod macos_oauth {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{
        define_class, msg_send, AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly,
    };
    use objc2_authentication_services::{
        ASPresentationAnchor, ASWebAuthenticationPresentationContextProviding,
        ASWebAuthenticationSession, ASWebAuthenticationSessionErrorCode,
    };
    use objc2_foundation::{NSError, NSString, NSURL};
    use tauri::{AppHandle, Manager};
    use tokio::sync::oneshot;

    use super::{OAUTH_CANCELLED, OAUTH_START_FAILED};
    use crate::window;

    type OAuthResult = std::result::Result<String, String>;
    type Delivery = Arc<Mutex<Option<oneshot::Sender<OAuthResult>>>>;

    struct PresentationContextIvars {
        anchor: Retained<ASPresentationAnchor>,
    }

    define_class!(
        // SAFETY:
        // - NSObject has no subclassing requirements.
        // - The stored anchor is retained and only accessed on the main thread.
        // - PresentationContextProvider does not implement Drop.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = PresentationContextIvars]
        #[name = "SpawnOAuthPresentationContextProvider"]
        struct PresentationContextProvider;

        unsafe impl NSObjectProtocol for PresentationContextProvider {}

        unsafe impl ASWebAuthenticationPresentationContextProviding for PresentationContextProvider {
            #[unsafe(method_id(presentationAnchorForWebAuthenticationSession:))]
            fn presentation_anchor(
                &self,
                _session: &ASWebAuthenticationSession,
            ) -> Retained<ASPresentationAnchor> {
                self.ivars().anchor.clone()
            }
        }
    );

    impl PresentationContextProvider {
        fn new(mtm: MainThreadMarker, anchor: Retained<ASPresentationAnchor>) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(PresentationContextIvars { anchor });
            // SAFETY: `this` is an allocated instance of our NSObject subclass,
            // and its Rust ivars have been initialized immediately above.
            unsafe { msg_send![super(this), init] }
        }
    }

    /// ASWebAuthenticationSession keeps its completion block, while its
    /// presentation provider property is weak. This holder keeps both alive;
    /// the completion block removes it on the main thread as soon as
    /// AuthenticationServices has finished with them.
    struct SessionLifetime {
        _session: Retained<ASWebAuthenticationSession>,
        _provider: Retained<PresentationContextProvider>,
    }

    static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

    thread_local! {
        /// AuthenticationServices' completion queue is not part of its public
        /// contract. Keeping main-thread-only objects here means the block can
        /// carry only Send data back to Tauri's main-thread dispatcher before
        /// the session and its presentation provider are released.
        static ACTIVE_SESSIONS: RefCell<HashMap<u64, SessionLifetime>> =
            RefCell::new(HashMap::new());
    }

    pub async fn authenticate(app: AppHandle, start_url: String) -> OAuthResult {
        let (sender, receiver) = oneshot::channel();
        let delivery = Arc::new(Mutex::new(Some(sender)));
        let main_delivery = Arc::clone(&delivery);
        let main_app = app.clone();
        app.run_on_main_thread(move || {
            if let Err(error) = start(&main_app, &start_url, Arc::clone(&main_delivery)) {
                deliver(&main_delivery, Err(error));
            }
        })
        .map_err(|error| format!("{OAUTH_START_FAILED}{error}"))?;

        receiver.await.map_err(|_| {
            format!("{OAUTH_START_FAILED}the web authentication session ended without an answer")
        })?
    }

    #[allow(deprecated)]
    fn start(app: &AppHandle, start_url: &str, delivery: Delivery) -> Result<(), String> {
        let mtm = MainThreadMarker::new()
            .ok_or_else(|| format!("{OAUTH_START_FAILED}OAuth must start on the main thread"))?;
        let window = app
            .get_webview_window(window::LABEL)
            .ok_or_else(|| format!("{OAUTH_START_FAILED}the SPAWN D window is gone"))?;
        let ns_window = window
            .ns_window()
            .map_err(|error| format!("{OAUTH_START_FAILED}{error}"))?;
        // SAFETY: Tauri returns the live NSWindow backing `window`. NSWindow
        // is an NSObject subclass, which is exactly the concrete macOS type
        // represented by AuthenticationServices' ASPresentationAnchor alias.
        let anchor = unsafe { Retained::retain(ns_window.cast::<ASPresentationAnchor>()) }
            .ok_or_else(|| {
                format!("{OAUTH_START_FAILED}the SPAWN D window has no native handle")
            })?;
        let provider = PresentationContextProvider::new(mtm, anchor);

        let url_string = NSString::from_str(start_url);
        let url = NSURL::URLWithString(&url_string)
            .ok_or_else(|| format!("{OAUTH_START_FAILED}the OAuth URL is invalid"))?;
        let callback_scheme = NSString::from_str("spawn");
        let session_id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
        let completion_app = app.clone();
        let completion_delivery = Arc::clone(&delivery);
        let completion: RcBlock<dyn Fn(*mut NSURL, *mut NSError)> = RcBlock::new(
            move |callback_url: *mut NSURL, callback_error: *mut NSError| {
                // Clone everything the callback still needs before main-thread
                // cleanup releases the session and this retained block.
                let app = completion_app.clone();
                let delivery = Arc::clone(&completion_delivery);
                let result = completion_result(callback_url, callback_error);
                let main_delivery = Arc::clone(&delivery);
                if let Err(error) = app.run_on_main_thread(move || {
                    ACTIVE_SESSIONS.with(|sessions| {
                        sessions.borrow_mut().remove(&session_id);
                    });
                    deliver(&main_delivery, result);
                }) {
                    deliver(
                        &delivery,
                        Err(format!("could not finish the OAuth session: {error}")),
                    );
                }
            },
        );

        // This callback-scheme initializer is the compatible API on every
        // macOS version SPAWN D supports. The newer callback-object overload
        // cannot be deployed to those older systems.
        // SAFETY: URL and scheme are valid Objective-C objects, and the heap
        // block remains valid for the call; ASWebAuthenticationSession copies
        // and retains it for the asynchronous operation.
        let session = unsafe {
            ASWebAuthenticationSession::initWithURL_callbackURLScheme_completionHandler(
                ASWebAuthenticationSession::alloc(),
                &url,
                Some(&callback_scheme),
                RcBlock::as_ptr(&completion),
            )
        };
        let provider_object = ProtocolObject::from_ref(&*provider);
        // SAFETY: All session configuration and presentation happen on the
        // main thread, and `provider_object` implements the required protocol.
        unsafe {
            session.setPresentationContextProvider(Some(provider_object));
            session.setPrefersEphemeralWebBrowserSession(false);
        }
        let retained_session = session.clone();
        ACTIVE_SESSIONS.with(|sessions| {
            sessions.borrow_mut().insert(
                session_id,
                SessionLifetime {
                    _session: session,
                    _provider: provider,
                },
            );
        });
        // SAFETY: The session is fully configured, retained in
        // `ACTIVE_SESSIONS`, and
        // this function is executing on the main thread.
        let started = unsafe { retained_session.start() };
        if !started {
            ACTIVE_SESSIONS.with(|sessions| {
                sessions.borrow_mut().remove(&session_id);
            });
            return Err(format!(
                "{OAUTH_START_FAILED}macOS could not present the web authentication session"
            ));
        }
        Ok(())
    }

    fn completion_result(callback_url: *mut NSURL, callback_error: *mut NSError) -> OAuthResult {
        // SAFETY: AuthenticationServices owns both nullable arguments for the
        // duration of this completion-block invocation.
        let callback_url = unsafe { callback_url.as_ref() };
        // SAFETY: Same callback lifetime as `callback_url` above.
        let callback_error = unsafe { callback_error.as_ref() };
        if let Some(url) = callback_url {
            return url
                .absoluteString()
                .map(|value| value.to_string())
                .ok_or_else(|| "macOS returned an OAuth callback without a URL".to_owned());
        }
        if let Some(error) = callback_error {
            if error.code() == ASWebAuthenticationSessionErrorCode::CanceledLogin.0 {
                return Err(OAUTH_CANCELLED.to_owned());
            }
            if matches!(
                error.code(),
                code if code == ASWebAuthenticationSessionErrorCode::PresentationContextNotProvided.0
                    || code == ASWebAuthenticationSessionErrorCode::PresentationContextInvalid.0
            ) {
                return Err(format!(
                    "{OAUTH_START_FAILED}{}",
                    error.localizedDescription()
                ));
            }
            return Err(error.localizedDescription().to_string());
        }
        Err("macOS returned no OAuth callback".to_owned())
    }

    fn deliver(delivery: &Delivery, result: OAuthResult) {
        let sender = delivery
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(sender) = sender {
            let _ = sender.send(result);
        }
    }
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
    let hosts: serde_json::Value = api
        .authenticated_get("/api/hosts")
        .await
        .context("checking this account's hosts")?;
    let approval_required = approval_is_required(&before, &registered.id, &hosts);
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

/// Whether registering this device must wait on another device's approval.
///
/// Only when one is grantable: an approval is granted from a device a host
/// trusts, so an account with zero hosts has nobody who could answer, and the
/// gate would deadlock a fresh install. Nothing is lost by skipping it there —
/// with no hosts there is nothing an approval protects, and the first
/// possession pins the possessing device directly, exactly how the web
/// bootstraps.
fn approval_is_required(
    devices: &[BrowserDevice],
    registered_id: &str,
    hosts: &serde_json::Value,
) -> bool {
    any_hosts(hosts)
        && devices.iter().any(|device| {
            device.id != registered_id && device.revoked_at.is_none() && !device.is_root
        })
}

/// `/api/hosts` answers a bare array today; read the wrapped form too, as
/// `install.rs` does when it watches for the pinned host.
fn any_hosts(hosts: &serde_json::Value) -> bool {
    hosts
        .as_array()
        .or_else(|| hosts.get("hosts").and_then(serde_json::Value::as_array))
        .is_some_and(|entries| !entries.is_empty())
}

/// The device gate, re-asked for an install that is already signed in.
///
/// An earlier release required approval whenever another device existed, even
/// when no host could grant one, and recorded that in `device_approved` — so a
/// deadlocked install stays deadlocked across updates unless the question is
/// asked again. When approval is not grantable, record the device as approved,
/// as `finish_auth` now decides at sign-in, and let the wizard move on.
pub async fn device_gate_needed() -> Result<bool> {
    let preferences = storage::load_preferences()?;
    if preferences.device_approved {
        return Ok(false);
    }
    let api = ApiClient::new(&preferences.server_origin)?;
    let hosts: serde_json::Value = api
        .authenticated_get("/api/hosts")
        .await
        .context("checking this account's hosts")?;
    if any_hosts(&hosts) {
        return Ok(true);
    }
    let mut updated = preferences;
    updated.device_approved = true;
    storage::save_preferences(&updated)?;
    Ok(false)
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

    // The guard is held across the await on purpose: it serializes the
    // process-global `PENDING_OAUTH` against the other tests in this module,
    // which is the whole point of taking it, and no other task contends for it.
    #[allow(clippy::await_holding_lock)]
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
    fn approval_is_only_required_when_a_host_could_grant_it() {
        let device = |id: &str, revoked: bool, is_root: bool| BrowserDevice {
            id: id.into(),
            key_algorithm: "ed25519".into(),
            public_key: "k".into(),
            label: None,
            revoked_at: revoked.then(|| "2026-01-01T00:00:00Z".into()),
            is_root,
        };
        let devices = vec![device("other", false, false), device("this", false, false)];
        let hosts = serde_json::json!([{ "id": "host-1" }]);
        assert!(approval_is_required(&devices, "this", &hosts));
        // Zero hosts: nobody could grant an approval, so none is asked for —
        // requiring one anyway deadlocked every fresh install on such an
        // account.
        assert!(!approval_is_required(
            &devices,
            "this",
            &serde_json::json!([])
        ));
        assert!(!approval_is_required(
            &devices,
            "this",
            &serde_json::json!({ "hosts": [] })
        ));
        assert!(approval_is_required(
            &devices,
            "this",
            &serde_json::json!({ "hosts": [{}] })
        ));
        // Only another live, non-root device counts as an approver.
        assert!(!approval_is_required(
            &[device("this", false, false)],
            "this",
            &hosts
        ));
        assert!(!approval_is_required(
            &[device("other", true, false), device("this", false, false)],
            "this",
            &hosts
        ));
        assert!(!approval_is_required(
            &[device("other", false, true), device("this", false, false)],
            "this",
            &hosts
        ));
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
