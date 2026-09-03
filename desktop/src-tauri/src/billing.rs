//! What the account's plan admits, and where the plan is changed.
//!
//! The wizard never fetches: the webview's CSP forbids remote connects
//! outright, so every network call in this app is a Rust command. This is the
//! billing one, and it is deliberately the whole of the client's cleverness —
//! the server asks the same question again at
//! `POST /api/auth/device/approve` and is the authority. What happens here is
//! that somebody at their limit reads a plain sentence instead of watching a
//! spinner, a daemon download and an opaque failure.
//!
//! Every failure is permissive. `/api/billing/state` 404s on a deployment with
//! billing off, which is the supported state of every self-hosted install; an
//! unreachable server, an expired token or a body this build cannot read are
//! outages, and a gate nobody can pass is an outage rather than a control.

use anyhow::{Context, Result};

use crate::api::ApiClient;
use crate::models::{BillingState, SubscriptionState};
use crate::storage;

/// The route the browser is sent to. A real page on the chosen server, not a
/// Stripe URL: Checkout is started from a signed-in browser session, and this
/// app has no business minting one.
const PLANS_PATH: &str = "/pricing";

/// The account's plan as the host gate needs it, or the permissive answer.
///
/// Never fails. A caller that had to handle an error here would have to decide
/// what an error means, and there is only one safe answer to that — so it is
/// made once, here.
pub async fn subscription_state() -> SubscriptionState {
    match read().await {
        Ok(Some(state)) => state.into(),
        Ok(None) => SubscriptionState::unknown(),
        Err(error) => {
            // Not surfaced to the window: nothing is being refused, so there is
            // nothing for the reader to do about it.
            eprintln!("billing: {error:#}");
            SubscriptionState::unknown()
        }
    }
}

/// `Ok(None)` is the 404 a deployment that sells nothing answers with.
async fn read() -> Result<Option<BillingState>> {
    let preferences = storage::load_preferences()?;
    let api = ApiClient::new(&preferences.server_origin)?;
    let Some(body) = api.optional_authenticated_get("/api/billing/state").await? else {
        return Ok(None);
    };
    Ok(Some(
        serde_json::from_value(body).context("decoding the SPAWN D billing state")?,
    ))
}

/// Where the plan is changed, on the server this app is signed in to.
pub fn plans_url() -> Result<String> {
    let preferences = storage::load_preferences()?;
    Ok(ApiClient::new(&preferences.server_origin)?
        .url(PLANS_PATH)?
        .to_string())
}
