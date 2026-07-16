//! serde structs for every server↔daemon JSON frame in `proto/README.md`.
//!
//! Frames are tagged via the `type` field. `type` strings, key names, and
//! shapes here MUST match the protocol document exactly — the server, daemon,
//! and browser are all built against it.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Daemon → server
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[allow(clippy::large_enum_variant)]
pub enum Outbound {
    Register {
        host_name: String,
        os: String,
        arch: String,
        version: String,
        existing_agents: Vec<Uuid>,
    },
    #[serde(rename = "host.heartbeat")]
    HostHeartbeat,
    #[serde(rename = "agent.exit")]
    AgentExit {
        agent_id: Uuid,
        exit_code: Option<i32>,
        signal: Option<String>,
    },
    #[serde(rename = "agent.started")]
    AgentStarted { agent_id: Uuid, pid: u32 },
    /// Content-free "meaningful output happened" ping (trust Phase 2): lets the
    /// server stamp `last_output_at` without seeing PTY bytes. Throttled and
    /// classified daemon-side (see `activity.rs`).
    #[serde(rename = "agent.activity")]
    AgentActivity { agent_id: Uuid },
    /// Content-free input-activity ping for WebRTC DataChannel input. The
    /// server cannot observe `spawn.pty` bytes, so this daemon-throttled signal
    /// is the only metadata it needs to maintain `last_input_at` for v2.
    #[serde(rename = "agent.input_activity")]
    AgentInputActivity { agent_id: Uuid },
    #[serde(rename = "agent.uploaded")]
    AgentUploaded {
        agent_id: Uuid,
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        #[serde(default)]
        client_id: Option<String>,
    },
    #[serde(rename = "host.tools.check_result")]
    HostToolsCheckResult {
        request_id: String,
        tools: Vec<HostToolStatus>,
    },
    #[serde(rename = "host.tools.install_result")]
    HostToolsInstallResult {
        request_id: String,
        result: HostToolInstallResult,
    },
    #[serde(rename = "rtc.answer")]
    RtcAnswer {
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        binding_nonce: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_id: Option<Uuid>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope_type: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope_id: Option<Uuid>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        protocol: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        protocol_version: Option<u16>,
        sdp: String,
    },
    #[serde(rename = "rtc.candidate")]
    RtcCandidate {
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        binding_nonce: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_id: Option<Uuid>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope_type: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope_id: Option<Uuid>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        protocol: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        protocol_version: Option<u16>,
        candidate: serde_json::Value,
    },
    #[serde(rename = "rtc.status")]
    RtcStatus {
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        binding_nonce: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_id: Option<Uuid>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope_type: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope_id: Option<Uuid>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        protocol: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        protocol_version: Option<u16>,
        status: String,
        #[serde(default)]
        message: Option<String>,
    },
    Error {
        agent_id: Option<Uuid>,
        code: String,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_id: Option<String>,
    },
}

// ---------------------------------------------------------------------------
// Server → daemon
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Inbound {
    Registered {
        host_id: Uuid,
    },
    #[serde(rename = "host.heartbeat")]
    HostHeartbeat,
    #[serde(rename = "host.tools.check")]
    HostToolsCheck {
        request_id: String,
        #[serde(default)]
        targets: Vec<HostToolTarget>,
    },
    #[serde(rename = "host.tools.install")]
    HostToolsInstall {
        request_id: String,
        target: HostToolTarget,
    },
    #[serde(rename = "agent.create")]
    AgentCreate(AgentCreate),
    #[serde(rename = "agent.restart")]
    AgentRestart(AgentCreate),
    #[serde(rename = "agent.kill")]
    AgentKill {
        agent_id: Uuid,
        #[serde(default)]
        signal: Option<spawnd::sessiond::wire::LifecycleSignal>,
    },
    #[serde(rename = "agent.upload")]
    AgentUpload {
        agent_id: Uuid,
        #[serde(default)]
        request_id: Option<String>,
        cwd: String,
        name: String,
        mime_type: String,
        bytes_b64: String,
        #[serde(default)]
        paste_prefix: Option<String>,
        #[serde(default)]
        paste: Option<bool>,
        #[serde(default)]
        destination: Option<String>,
        #[serde(default)]
        client_id: Option<String>,
    },
    #[serde(rename = "rtc.offer")]
    RtcOffer {
        session_id: String,
        #[serde(default)]
        binding_nonce: Option<String>,
        #[serde(default)]
        binding_generation: Option<u64>,
        #[serde(default)]
        agent_id: Option<Uuid>,
        #[serde(default)]
        scope_type: Option<String>,
        #[serde(default)]
        scope_id: Option<Uuid>,
        #[serde(default)]
        protocol: Option<String>,
        #[serde(default)]
        protocol_version: Option<u16>,
        sdp: String,
        #[serde(default)]
        ice_servers: Vec<RtcIceServerConfig>,
        #[serde(default)]
        ice_transport_policy: Option<String>,
    },
    #[serde(rename = "rtc.candidate")]
    RtcCandidate {
        session_id: String,
        #[serde(default)]
        binding_nonce: Option<String>,
        #[serde(default)]
        binding_generation: Option<u64>,
        #[serde(default)]
        agent_id: Option<Uuid>,
        #[serde(default)]
        scope_type: Option<String>,
        #[serde(default)]
        scope_id: Option<Uuid>,
        #[serde(default)]
        protocol: Option<String>,
        #[serde(default)]
        protocol_version: Option<u16>,
        candidate: serde_json::Value,
    },
    #[serde(rename = "rtc.close")]
    RtcClose {
        session_id: String,
        #[serde(default)]
        binding_nonce: Option<String>,
        #[serde(default)]
        binding_generation: Option<u64>,
        #[serde(default)]
        agent_id: Option<Uuid>,
        #[serde(default)]
        scope_type: Option<String>,
        #[serde(default)]
        scope_id: Option<Uuid>,
        #[serde(default)]
        protocol: Option<String>,
        #[serde(default)]
        protocol_version: Option<u16>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RtcIceServerConfig {
    pub urls: Vec<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub credential: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCreate {
    pub agent_id: Uuid,
    pub cwd: String,
    #[serde(default)]
    pub argv: Vec<String>,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    /// Optional shell command. If `argv[0]` isn't on the daemon's PATH at
    /// agent.create time, the daemon runs this via `bash -c` and streams
    /// no server-visible output. Then it retries the PATH lookup before launch.
    #[serde(default)]
    pub install: Option<String>,
    #[serde(default)]
    pub skills: Vec<AgentSkillConfig>,
    #[serde(default)]
    pub create_cwd: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSkillConfig {
    pub id: String,
    pub name: String,
    pub description: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostToolTarget {
    pub preset_id: String,
    pub preset_name: String,
    pub agent_kind: String,
    pub command: String,
    #[serde(default)]
    pub install: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostToolStatus {
    pub preset_id: String,
    pub preset_name: String,
    pub agent_kind: String,
    pub command: String,
    #[serde(default)]
    pub install: Option<String>,
    pub installed: bool,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub latest_version: Option<String>,
    #[serde(default)]
    pub update_available: Option<bool>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostToolInstallResult {
    pub preset_id: String,
    pub preset_name: String,
    pub agent_kind: String,
    pub command: String,
    #[serde(default)]
    pub install: Option<String>,
    pub success: bool,
    #[serde(default)]
    pub exit_code: Option<i32>,
    pub output: String,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub status: Option<HostToolStatus>,
}

// ---------------------------------------------------------------------------
// Device-code (REST)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct DeviceStartRequest<'a> {
    pub host_name: &'a str,
    pub os: &'a str,
    pub arch: &'a str,
    pub version: &'a str,
}

#[derive(Debug, Deserialize)]
pub struct DeviceStartResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
    #[allow(dead_code)]
    pub expires_in: u64,
}

#[derive(Debug, Serialize)]
pub struct DevicePollRequest<'a> {
    pub device_code: &'a str,
}

/// The poll endpoint returns either a success body (`access_token`+`host_id`)
/// or an error body (`error`). We deserialize as a flat struct with all
/// fields optional and discriminate at the call site.
#[derive(Debug, Deserialize)]
pub struct DevicePollResponse {
    pub access_token: Option<String>,
    pub host_id: Option<Uuid>,
    pub error: Option<String>,
}
