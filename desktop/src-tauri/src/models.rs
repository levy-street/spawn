use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct DesktopPreferences {
    pub server_origin: String,
    pub account_id: Option<String>,
    pub account_email: Option<String>,
    pub device_id: Option<String>,
    pub device_approved: bool,
    pub first_run_complete: bool,
    pub host_name: Option<String>,
}

/// The server this build points at until someone chooses another, fixed at
/// build time by `SPAWN_DESKTOP_SERVER_ORIGIN` (see `build.rs`). It is also
/// what the wizard calls "hosted", so a build made for one deployment does not
/// offer another one's name as the easy option.
pub const HOSTED_ORIGIN: &str = env!("SPAWN_DESKTOP_SERVER_ORIGIN");

/// The origin a release build points at. A build pointing anywhere else is
/// somebody's own, and must not take updates from the vendor's channel.
pub const VENDOR_ORIGIN: &str = env!("SPAWN_DESKTOP_VENDOR_ORIGIN");

impl Default for DesktopPreferences {
    fn default() -> Self {
        Self {
            server_origin: HOSTED_ORIGIN.into(),
            account_id: None,
            account_email: None,
            device_id: None,
            device_approved: false,
            first_run_complete: false,
            host_name: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct UserOut {
    pub id: String,
    pub email: String,
    /// Set once the address is confirmed. `None` on a server that predates
    /// verification, which is also what "not required" looks like.
    #[serde(default)]
    pub email_verified_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub user: UserOut,
}

#[derive(Clone, Debug, Deserialize)]
pub struct MeResponse {
    pub user: UserOut,
}

#[derive(Clone, Debug, Deserialize)]
pub struct SessionRenewResponse {
    pub access_token: String,
}

/// `GET /api/auth/config`: the sign-in surface's one-shot configuration, the
/// same shape the browser and the phone read. Every field defaults so an older
/// server that omits one reads as "off" rather than as a decode failure.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct AuthConfig {
    pub providers: Vec<AuthProvider>,
    pub email_verification_required: bool,
    pub invite_only: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AuthProvider {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct AuthOutcome {
    pub account_id: String,
    pub email: String,
    pub device_id: String,
    pub approval_required: bool,
    pub email_verified: bool,
}

/// What the wizard needs to know about the signed-in account when it resumes:
/// enough to pick the gate, nothing it would have to store.
#[derive(Clone, Debug, Serialize)]
pub struct AccountState {
    pub email: String,
    pub email_verified: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BrowserDevice {
    pub id: String,
    pub key_algorithm: String,
    pub public_key: String,
    pub label: Option<String>,
    pub revoked_at: Option<String>,
    #[serde(default)]
    pub is_root: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub struct DevicePending {
    pub host_name: String,
    pub approval_nonce: String,
    pub host_key_algorithm: String,
    pub host_public_key: String,
    pub host_key_fingerprint: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct DeviceApproveResponse {
    pub host_name: String,
    pub approval_nonce: String,
    pub host_key_algorithm: String,
    pub host_public_key: String,
    pub browser_device_id: String,
    pub browser_key_algorithm: String,
    pub browser_public_key: String,
    pub host_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct PairingState {
    pub id: String,
    pub initiator_device_id: String,
    pub joiner_device_id: String,
    pub initiator_public_key: String,
    pub initiator_commit: String,
    pub joiner_public_key: Option<String>,
    pub joiner_nonce: Option<String>,
    pub initiator_nonce: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct AccountEndorsement {
    pub endorser_device_id: String,
    pub endorser_public_key: String,
    pub endorsed_device_id: String,
    pub endorsed_public_key: String,
    pub signature: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum DeviceApprovalProgress {
    Waiting,
    ShowNumber { pairing_id: String, number: String },
    Approved,
    Refused { message: String },
}

#[derive(Clone, Debug, Serialize)]
pub struct ApprovalReview {
    pub host_name: String,
    pub exact_key_match: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PossessionStatus {
    Starting,
    Registered,
    Approved,
    Online,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
pub struct PossessionProgress {
    pub run_id: String,
    pub status: PossessionStatus,
    pub error: Option<String>,
    pub host_name: Option<String>,
    pub host_id: Option<String>,
    pub review: Option<ApprovalReview>,
    pub child_finished: bool,
    pub child_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HeartbeatState {
    pub pid: u32,
    pub version: String,
    pub connected: bool,
    pub connected_at: Option<String>,
    pub server: String,
    pub last_error: Option<HeartbeatError>,
    pub sessions: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HeartbeatError {
    pub kind: String,
    pub detail: String,
    pub at: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct LocalStatus {
    pub status: serde_json::Value,
    pub doctor: Option<serde_json::Value>,
    pub heartbeat: Option<HeartbeatState>,
    pub service: String,
    pub hosts: serde_json::Value,
    pub release: serde_json::Value,
    pub log_tail: String,
}

/// `GET /api/billing/state`: the plan this account is on and what it admits.
///
/// Every field defaults, for the same reason `AuthConfig`'s do — a server that
/// predates one must read as "off", never as a decode failure that would leave
/// the wizard unable to say anything at all.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct BillingState {
    pub tier: String,
    pub tier_name: String,
    /// `None` is unlimited: Pandemonium, a comped account, or billing off.
    pub host_limit: Option<u32>,
    pub host_count: u32,
    /// Reachable without anyone doing anything wrong: a downgrade is always
    /// allowed, so an account can sit above its limit until it sheds hosts.
    pub over_limit: bool,
    /// The catalogue, cheapest first, exactly as the server orders it.
    pub tiers: Vec<BillingTier>,
}

/// One plan as a surface names it. Display only; nothing charges from here.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(default)]
pub struct BillingTier {
    pub key: String,
    /// What a person reads. The Legion tier is spelled "the Legion plan".
    pub name: String,
    /// Monthly, USD, in cents.
    pub price_cents: i64,
    pub host_limit: Option<u32>,
}

/// What the wizard reads: the numbers the server enforces, and the one answer
/// the host gate actually needs.
///
/// Desktop is distributed directly — Developer ID and notarisation on macOS, a
/// per-user Authenticode-signed NSIS installer on Windows — so unlike the phone
/// it is under no platform billing rule at all. It may name the price and offer
/// the plan, and this shape carries what that takes.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct SubscriptionState {
    /// False when this deployment sells nothing — or would not say. Either way
    /// the wizard draws no billing UI and refuses nothing.
    pub billing_enabled: bool,
    pub tier: String,
    pub tier_name: String,
    pub host_limit: Option<u32>,
    pub host_count: u32,
    /// The only question the gate asks. The server asks it again and is the
    /// authority; this is the mirror that keeps someone off a spinner.
    pub may_add_host: bool,
    pub over_limit: bool,
    /// The cheapest plan on the catalogue that would admit one host more than
    /// this account already holds, when there is one to name.
    pub upgrade: Option<BillingTier>,
}

impl SubscriptionState {
    /// What the wizard believes when the billing API 404s, or will not answer.
    ///
    /// Permissive on purpose, and for two different reasons that happen to want
    /// the same answer. Billing off is the supported state of every self-hosted
    /// deployment, and a self-hoster must not notice this feature exists. An
    /// unreachable server is an outage, and a gate nobody can pass is an outage
    /// rather than a control — the server enforces the limit itself at
    /// `/api/auth/device/approve`, so failing open here costs a clear refusal,
    /// never a free host.
    pub fn unknown() -> Self {
        Self {
            may_add_host: true,
            ..Self::default()
        }
    }
}

impl From<BillingState> for SubscriptionState {
    fn from(state: BillingState) -> Self {
        let may_add_host = state
            .host_limit
            .is_none_or(|limit| state.host_count < limit);
        Self {
            billing_enabled: true,
            may_add_host,
            // Only where it is about to be offered. Below the limit the
            // cheapest plan that fits is the one they are already on, and
            // naming it would be an upsell where the rule is that the app says
            // nothing about billing until the moment it must.
            upgrade: (!may_add_host)
                .then(|| smallest_plan_that_fits(&state.tiers, state.host_count))
                .flatten(),
            tier: state.tier,
            tier_name: state.tier_name,
            host_limit: state.host_limit,
            host_count: state.host_count,
            over_limit: state.over_limit,
        }
    }
}

/// The cheapest plan that would admit one host more than the account holds.
///
/// Not "the next tier up". A downgrade is always allowed, so an account can sit
/// above its limit with hosts it already owns, and the honest offer there is the
/// smallest plan that fits what is *already there* — not the one immediately
/// above the current price, which would refuse again the moment it was bought.
/// The catalogue arrives cheapest first, so the first match is the cheapest.
fn smallest_plan_that_fits(tiers: &[BillingTier], hosts: u32) -> Option<BillingTier> {
    tiers
        .iter()
        .find(|tier| tier.host_limit.is_none_or(|limit| hosts < limit))
        .cloned()
}

#[cfg(test)]
mod billing_tests {
    use super::*;

    fn catalogue() -> Vec<BillingTier> {
        vec![
            tier("free", "Free", 0, Some(1)),
            tier("coven", "Coven", 500, Some(3)),
            tier("legion", "the Legion plan", 2_000, Some(20)),
            tier("pandemonium", "Pandemonium", 5_000, None),
        ]
    }

    fn tier(key: &str, name: &str, price_cents: i64, host_limit: Option<u32>) -> BillingTier {
        BillingTier {
            key: key.into(),
            name: name.into(),
            price_cents,
            host_limit,
        }
    }

    fn state(host_limit: Option<u32>, host_count: u32) -> BillingState {
        BillingState {
            tier: "free".into(),
            tier_name: "Free".into(),
            host_limit,
            host_count,
            over_limit: host_limit.is_some_and(|limit| host_count > limit),
            tiers: catalogue(),
        }
    }

    #[test]
    fn a_free_account_with_its_one_host_may_not_add_another() {
        let seen = SubscriptionState::from(state(Some(1), 1));
        assert!(!seen.may_add_host);
        assert!(seen.billing_enabled);
        assert_eq!(seen.upgrade.map(|plan| plan.key), Some("coven".into()));
    }

    #[test]
    fn below_the_limit_nothing_is_offered() {
        let seen = SubscriptionState::from(state(Some(3), 2));
        assert!(seen.may_add_host);
        assert_eq!(seen.upgrade, None);
    }

    #[test]
    fn an_unlimited_plan_never_refuses() {
        let seen = SubscriptionState::from(state(None, 400));
        assert!(seen.may_add_host);
        assert_eq!(seen.upgrade, None);
    }

    #[test]
    fn an_account_over_its_limit_is_offered_a_plan_that_actually_fits() {
        // Downgraded to Coven while holding five hosts: Coven is what they are
        // on and the tier above Free, and it would refuse this machine too.
        let mut over = state(Some(3), 5);
        over.tier = "coven".into();
        over.tier_name = "Coven".into();
        let seen = SubscriptionState::from(over);
        assert!(!seen.may_add_host);
        assert!(seen.over_limit);
        assert_eq!(seen.upgrade.map(|plan| plan.key), Some("legion".into()));
    }

    #[test]
    fn a_limit_no_catalogued_plan_clears_offers_nothing_rather_than_the_wrong_thing() {
        // A comped override, or a catalogue this build has never heard of.
        let mut huge = state(Some(1), 1);
        huge.tiers = vec![tier("free", "Free", 0, Some(1))];
        let seen = SubscriptionState::from(huge);
        assert!(!seen.may_add_host);
        assert_eq!(seen.upgrade, None);
    }

    #[test]
    fn an_unanswered_server_refuses_nothing_and_shows_nothing() {
        let seen = SubscriptionState::unknown();
        assert!(seen.may_add_host);
        assert!(!seen.billing_enabled);
        assert_eq!(seen.upgrade, None);
    }

    #[test]
    fn a_server_that_omits_every_field_decodes_rather_than_failing() {
        let state: BillingState = serde_json::from_str("{}").unwrap();
        let seen = SubscriptionState::from(state);
        assert!(seen.may_add_host, "no limit stated is no limit enforced");
    }
}
