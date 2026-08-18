//! serde structs for every server↔daemon JSON frame in `proto/README.md`.
//!
//! Frames are tagged via the `type` field. `type` strings, key names, and
//! shapes here MUST match the protocol document exactly — the server, daemon,
//! and browser are all built against it.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Live relay bound shared with the server. The endpoint wire adapter has a
/// larger construction bound, but nested WebSocket/Redis routing deliberately
/// accepts at most 512 KiB until the signed cutover is complete.
pub const MAX_SIGNED_RTC_RELAY_BYTES: usize = 512 * 1024;

fn deserialize_present_bounded_signed_envelope<'de, D>(
    deserializer: D,
) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // `#[serde(default)]` handles an absent field without invoking this
    // function. Once the field is present, require a non-null JSON string so
    // `signed_envelope: null` cannot collapse to `None` and select legacy SDP.
    let value = String::deserialize(deserializer)?;
    if value.len() > MAX_SIGNED_RTC_RELAY_BYTES {
        return Err(serde::de::Error::custom(
            "signed RTC envelope exceeds its live relay bound",
        ));
    }
    Ok(Some(value))
}

fn serialize_bounded_signed_envelope<S>(
    value: &Option<String>,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    if value
        .as_ref()
        .is_some_and(|wire| wire.len() > MAX_SIGNED_RTC_RELAY_BYTES)
    {
        return Err(serde::ser::Error::custom(
            "signed RTC envelope exceeds its live relay bound",
        ));
    }
    value.serialize(serializer)
}

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
    #[serde(rename = "host.pong")]
    HostPong { request_id: String },
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sdp: Option<String>,
        /// Opaque signed-envelope JSON. The server may route this string but
        /// only the endpoint verifier may interpret its SDP.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            serialize_with = "serialize_bounded_signed_envelope",
            deserialize_with = "deserialize_present_bounded_signed_envelope"
        )]
        signed_envelope: Option<String>,
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

/// One browser pin as the server reports it. Nothing here is trusted: a record
/// is adopted only if its endorsement verifies against a key already pinned.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InboundBrowserPin {
    pub browser_device_id: String,
    pub browser_key_algorithm: String,
    pub browser_public_key: String,
    pub browser_key_fingerprint: String,
    #[serde(default)]
    pub endorser_public_key: Option<String>,
    #[serde(default)]
    pub endorsement_signature: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Inbound {
    Registered {
        host_id: Uuid,
        /// Account the host belongs to. Server-supplied, and safe to be: it is
        /// only an input to endorsement verification, so a wrong value makes
        /// the signature fail rather than admitting anything.
        #[serde(default)]
        account_id: Option<String>,
        /// Full pin records, so an endorsed device can be adopted. None from a
        /// server that predates them; adoption simply does not happen.
        #[serde(default)]
        browser_pins: Option<Vec<InboundBrowserPin>>,
        // None means the server never sent the field, which is not the same as
        // an empty set: a server that cannot report its pins must not cause
        // every local pin to be dropped.
        #[serde(default)]
        browser_device_ids: Option<Vec<String>>,
    },
    /// Pushed when a host's browser pin set changes, so an endorsement takes
    /// effect without waiting for the daemon to reconnect.
    #[serde(rename = "host.browser_pins")]
    HostBrowserPins {
        #[serde(default)]
        account_id: Option<String>,
        #[serde(default)]
        browser_pins: Option<Vec<InboundBrowserPin>>,
        #[serde(default)]
        browser_device_ids: Option<Vec<String>>,
    },
    #[serde(rename = "host.heartbeat")]
    HostHeartbeat,
    #[serde(rename = "host.ping")]
    HostPing { request_id: String },
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
        #[serde(default)]
        sdp: Option<String>,
        /// Preserved exactly for the Phase-3 verifier cutover. F1 accepts the
        /// relay shape; F2 will verify it before starting WebRTC negotiation.
        #[serde(
            default,
            deserialize_with = "deserialize_present_bounded_signed_envelope"
        )]
        signed_envelope: Option<String>,
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
    pub host_key_algorithm: &'a str,
    pub host_public_key: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceStartResponse {
    pub device_code: String,
    pub user_code: String,
    /// Opaque handle we bake into the browser URL (`/device?ref=…`) so the short
    /// user_code never rides in a link. Absent from a pre-0029 server.
    #[serde(default)]
    pub approval_ref: Option<String>,
    pub approval_nonce: String,
    pub verification_uri: String,
    pub interval: u64,
    #[allow(dead_code)]
    pub expires_in: u64,
}

#[derive(Debug, Serialize)]
pub struct DevicePossessionRequest<'a> {
    pub device_code: &'a str,
    pub approval_nonce: &'a str,
    pub host_key_algorithm: &'a str,
    pub host_public_key: &'a str,
    pub signature: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DevicePossessionResponse {
    pub verified: bool,
    pub version: u8,
}

#[derive(Debug, Serialize)]
pub struct DevicePollRequest<'a> {
    pub device_code: &'a str,
    pub host_key_algorithm: &'a str,
    pub host_public_key: &'a str,
}

/// The poll endpoint returns either a success body (`access_token`+`host_id`)
/// or an error body (`error`). We deserialize as a flat struct with all
/// fields optional and discriminate at the call site.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DevicePollResponse {
    pub access_token: Option<String>,
    pub host_id: Option<Uuid>,
    pub host_key_algorithm: Option<String>,
    pub host_public_key: Option<String>,
    pub host_key_fingerprint: Option<String>,
    pub browser_device_id: Option<String>,
    pub browser_key_algorithm: Option<String>,
    pub browser_public_key: Option<String>,
    pub browser_key_fingerprint: Option<String>,
    // Absent from a pre-0022 server, which cannot supply the proof. The daemon
    // treats that as unverified rather than as a failure.
    pub account_id: Option<String>,
    pub browser_approval_signature: Option<String>,
    pub error: Option<String>,
}

#[cfg(test)]
mod signed_rtc_relay_tests {
    use super::*;

    #[test]
    fn signed_offer_preserves_the_exact_opaque_string_without_raw_sdp() {
        let wire = " \n{\\\"type\\\":\\\"rtc.offer\\\",\\\"signature\\\":\\\"opaque\\\"}\t";
        let frame = serde_json::json!({
            "type": "rtc.offer",
            "session_id": "018f0f77-86d2-7a8e-9b1c-1f3b847ca2a1",
            "binding_nonce": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "binding_generation": 7,
            "agent_id": "11111111-2222-4333-8444-555555555555",
            "scope_type": "agent",
            "scope_id": "11111111-2222-4333-8444-555555555555",
            "protocol": "spawn.pty",
            "protocol_version": 2,
            "signed_envelope": wire,
            "ice_servers": []
        });
        let parsed: Inbound = serde_json::from_value(frame).expect("signed relay shape");
        assert!(matches!(
            parsed,
            Inbound::RtcOffer {
                sdp: None,
                signed_envelope: Some(ref preserved),
                ..
            } if preserved == wire
        ));
    }

    #[test]
    fn signed_offer_presence_is_distinct_from_absent_legacy_sdp() {
        let session_id = "018f0f77-86d2-7a8e-9b1c-1f3b847ca2a1";
        let legacy: Inbound = serde_json::from_value(serde_json::json!({
            "type": "rtc.offer",
            "session_id": session_id,
            "sdp": "v=0\r\n"
        }))
        .expect("absent signed field remains valid legacy shape");
        assert!(matches!(
            legacy,
            Inbound::RtcOffer {
                sdp: Some(ref sdp),
                signed_envelope: None,
                ..
            } if sdp == "v=0\r\n"
        ));

        let signed: Inbound = serde_json::from_value(serde_json::json!({
            "type": "rtc.offer",
            "session_id": session_id,
            "signed_envelope": "{\"opaque\":true}"
        }))
        .expect("present bounded string remains valid signed shape");
        assert!(matches!(
            signed,
            Inbound::RtcOffer {
                sdp: None,
                signed_envelope: Some(ref wire),
                ..
            } if wire == "{\"opaque\":true}"
        ));
    }

    #[test]
    fn signed_offer_rejects_present_null_and_every_non_string_shape() {
        let session_id = "018f0f77-86d2-7a8e-9b1c-1f3b847ca2a1";
        for (case, value, raw_sdp) in [
            ("null-only", serde_json::Value::Null, false),
            ("null-plus-raw", serde_json::Value::Null, true),
            (
                "unknown-object",
                serde_json::json!({"unknown": true}),
                false,
            ),
            ("array", serde_json::json!(["wire"]), false),
            ("boolean", serde_json::json!(true), false),
            ("number", serde_json::json!(7), false),
        ] {
            let mut frame = serde_json::json!({
                "type": "rtc.offer",
                "session_id": session_id,
                "signed_envelope": value
            });
            if raw_sdp {
                frame["sdp"] = serde_json::json!("v=0\r\nraw downgrade");
            }
            assert!(
                serde_json::from_value::<Inbound>(frame).is_err(),
                "present signed field must reject {case}"
            );
        }

        let duplicate = format!(
            r#"{{"type":"rtc.offer","session_id":"{session_id}","signed_envelope":"first","signed_envelope":"second"}}"#
        );
        assert!(
            serde_json::from_str::<Inbound>(&duplicate).is_err(),
            "duplicate signed fields must not create an ambiguous mode"
        );
    }

    #[test]
    fn signed_offer_rejects_live_bound_plus_one() {
        let exact = serde_json::json!({
            "type": "rtc.offer",
            "session_id": "018f0f77-86d2-7a8e-9b1c-1f3b847ca2a1",
            "signed_envelope": "x".repeat(MAX_SIGNED_RTC_RELAY_BYTES)
        });
        assert!(serde_json::from_value::<Inbound>(exact).is_ok());

        let frame = serde_json::json!({
            "type": "rtc.offer",
            "session_id": "018f0f77-86d2-7a8e-9b1c-1f3b847ca2a1",
            "signed_envelope": "x".repeat(MAX_SIGNED_RTC_RELAY_BYTES + 1)
        });
        assert!(serde_json::from_value::<Inbound>(frame).is_err());
    }

    #[test]
    fn outbound_answer_has_symmetric_opaque_shape() {
        let answer = Outbound::RtcAnswer {
            session_id: "018f0f77-86d2-7a8e-9b1c-1f3b847ca2a1".to_owned(),
            binding_nonce: Some("a".repeat(32)),
            agent_id: None,
            scope_type: Some("host".to_owned()),
            scope_id: Some(Uuid::parse_str("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee").unwrap()),
            protocol: Some("spawn.host.ctl".to_owned()),
            protocol_version: Some(1),
            sdp: None,
            signed_envelope: Some("{\\\"signature\\\":\\\"opaque\\\"}".to_owned()),
        };
        let value = serde_json::to_value(answer).unwrap();
        assert!(value.get("sdp").is_none());
        assert_eq!(
            value["signed_envelope"],
            serde_json::json!("{\\\"signature\\\":\\\"opaque\\\"}")
        );

        let oversized = Outbound::RtcAnswer {
            session_id: "018f0f77-86d2-7a8e-9b1c-1f3b847ca2a1".to_owned(),
            binding_nonce: None,
            agent_id: None,
            scope_type: None,
            scope_id: None,
            protocol: None,
            protocol_version: None,
            sdp: None,
            signed_envelope: Some("x".repeat(MAX_SIGNED_RTC_RELAY_BYTES + 1)),
        };
        assert!(serde_json::to_value(oversized).is_err());
    }

    #[test]
    fn answer_deserialization_has_the_same_present_non_null_rule() {
        let session_id = "018f0f77-86d2-7a8e-9b1c-1f3b847ca2a1";
        let absent: Outbound = serde_json::from_value(serde_json::json!({
            "type": "rtc.answer",
            "session_id": session_id,
            "sdp": "v=0\r\n"
        }))
        .expect("absent signed answer remains legacy");
        assert!(matches!(
            absent,
            Outbound::RtcAnswer {
                sdp: Some(ref sdp),
                signed_envelope: None,
                ..
            } if sdp == "v=0\r\n"
        ));

        let signed: Outbound = serde_json::from_value(serde_json::json!({
            "type": "rtc.answer",
            "session_id": session_id,
            "signed_envelope": "{\"opaque\":true}"
        }))
        .expect("present signed answer string");
        assert!(matches!(
            signed,
            Outbound::RtcAnswer {
                sdp: None,
                signed_envelope: Some(ref wire),
                ..
            } if wire == "{\"opaque\":true}"
        ));

        for value in [
            serde_json::Value::Null,
            serde_json::json!({"unknown": true}),
            serde_json::json!(["wire"]),
            serde_json::json!(false),
            serde_json::json!(9),
        ] {
            assert!(
                serde_json::from_value::<Outbound>(serde_json::json!({
                    "type": "rtc.answer",
                    "session_id": session_id,
                    "signed_envelope": value,
                    "sdp": "v=0\r\nraw downgrade"
                }))
                .is_err(),
                "present answer field must require a non-null string"
            );
        }
    }
}

#[cfg(test)]
mod device_pair_response_tests {
    use super::*;

    const START: &str = r#"{
        "device_code":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
        "user_code":"ABCD-EFGH",
        "approval_nonce":"ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8",
        "verification_uri":"https://spawn.example/device",
        "interval":5,
        "expires_in":600
    }"#;

    #[test]
    fn device_start_response_accepts_only_its_exact_schema() {
        let body: DeviceStartResponse = serde_json::from_str(START).unwrap();
        assert_eq!(body.user_code, "ABCD-EFGH");

        for rejected in [
            START.replace("\n    }", ",\n        \"error\":\"denied\"\n    }"),
            START.replace(
                "\n    }",
                ",\n        \"verified\":true,\n        \"version\":1\n    }",
            ),
            START.replace(
                "\n    }",
                ",\n        \"access_token\":\"substituted\"\n    }",
            ),
            START.replace("\n    }", ",\n        \"unexpected\":{}\n    }"),
        ] {
            assert!(
                serde_json::from_str::<DeviceStartResponse>(&rejected).is_err(),
                "accepted an unknown start-response field: {rejected}"
            );
        }
    }

    #[test]
    fn device_possession_response_rejects_mixed_authority_and_unknown_fields() {
        let body: DevicePossessionResponse =
            serde_json::from_str(r#"{"verified":true,"version":1}"#).unwrap();
        assert!(body.verified);
        assert_eq!(body.version, 1);

        for rejected in [
            r#"{"verified":true,"version":1,"error":"denied"}"#,
            r#"{"verified":true,"version":1,"access_token":"substituted"}"#,
            r#"{"verified":true,"version":1,"host_id":"11111111-2222-4333-8444-555555555555"}"#,
            r#"{"verified":true,"version":1,"unexpected":{}}"#,
            r#"{"verified":true,"version":1,"verified":false}"#,
        ] {
            assert!(
                serde_json::from_str::<DevicePossessionResponse>(rejected).is_err(),
                "accepted an ambiguous possession response: {rejected}"
            );
        }
    }
}

#[cfg(test)]
mod device_poll_tests {
    use super::*;

    #[test]
    fn success_response_uses_the_exact_browser_binding_field_names() {
        let body: DevicePollResponse = serde_json::from_str(
            r#"{
                "access_token":"token",
                "host_id":"11111111-2222-4333-8444-555555555555",
                "host_key_algorithm":"ed25519",
                "host_public_key":"host-key",
                "host_key_fingerprint":"SHA256:host",
                "browser_device_id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                "browser_key_algorithm":"ed25519",
                "browser_public_key":"browser-key",
                "browser_key_fingerprint":"SHA256:browser"
            }"#,
        )
        .unwrap();
        assert_eq!(
            body.browser_device_id.as_deref(),
            Some("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")
        );
        assert_eq!(body.browser_key_algorithm.as_deref(), Some("ed25519"));
        assert_eq!(body.browser_public_key.as_deref(), Some("browser-key"));
        assert_eq!(
            body.browser_key_fingerprint.as_deref(),
            Some("SHA256:browser")
        );
    }

    #[test]
    fn legacy_error_shape_remains_valid_but_aliases_and_duplicates_fail() {
        let pending: DevicePollResponse =
            serde_json::from_str(r#"{"error":"authorization_pending"}"#).unwrap();
        assert_eq!(pending.error.as_deref(), Some("authorization_pending"));
        assert!(pending.browser_device_id.is_none());
        assert!(serde_json::from_str::<DevicePollResponse>(
            r#"{"browser_id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}"#
        )
        .is_err());
        assert!(serde_json::from_str::<DevicePollResponse>(
            r#"{"browser_device_id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","browser_device_id":"11111111-2222-4333-8444-555555555555"}"#
        )
        .is_err());
    }
}
