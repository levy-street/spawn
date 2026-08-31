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
