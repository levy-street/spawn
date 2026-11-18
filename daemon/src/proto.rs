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

use spawnd::endorsement_chain::deserialize_bounded_carried_endorsements;

/// Parsed independently from ordinary registration. Invalid support data is
/// support-only denial; it must never discard a valid ordinary frame.
#[derive(Debug, Clone, Default)]
pub(crate) enum ConsentInput {
    #[default]
    Absent,
    Null,
    Valid(spawnd::support_consent::Consent),
    Invalid,
}
#[derive(Debug, Clone, Default)]
pub(crate) struct SupportUpdate {
    pub browser_device_ids: Option<Vec<String>>,
    pub revoked_browser_keys: Option<Vec<String>>,
    pub consent: ConsentInput,
}

// The ordinary parser has already validated this JSON. Usually two substring
// checks rule the key out. If it could occur, inspect only string boundaries
// and nesting: a value or a nested key with the same spelling doesn't count.
fn has_top_level_field(text: &str, field: &str) -> bool {
    if !text.contains(field) && !text.contains(r"\u") {
        return false;
    }
    let mut depth = 0;
    let mut quote = None;
    let mut bytes = text.bytes().enumerate();
    while let Some((pos, byte)) = bytes.next() {
        match (quote, byte) {
            (None, b'{' | b'[') => depth += 1,
            (None, b'}' | b']') => depth -= 1,
            (None, b'"') => quote = Some(pos),
            (Some(_), b'\\') => {
                bytes.next();
            }
            (Some(start), b'"') => {
                quote = None;
                // An ASCII key uses at most six bytes per letter (\uXXXX).
                if depth != 1 || pos - start - 1 > 6 * field.len() {
                    continue;
                }
                let raw = &text[start + 1..pos];
                let matches = raw == field
                    || (raw.contains('\\')
                        && serde_json::from_str::<String>(&text[start..=pos])
                            .is_ok_and(|key| key == field));
                if matches && text[pos + 1..].trim_ascii_start().starts_with(':') {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

/// Only support-bearing frames get a second parse. The ordinary parse runs
/// first, with exactly the ordinary field types and serde_json features.
pub(crate) fn parse_inbound(text: &str) -> Result<Inbound, serde_json::Error> {
    let mut frame: Inbound = serde_json::from_str(text)?;
    let field = match &mut frame {
        Inbound::Registered {
            support,
            browser_device_ids,
            revoked_browser_keys,
            ..
        } => {
            *support = std::sync::Arc::new(SupportUpdate {
                browser_device_ids: browser_device_ids.clone(),
                revoked_browser_keys: revoked_browser_keys.clone(),
                consent: ConsentInput::Absent,
            });
            "support_log_consent"
        }
        Inbound::HostSupportLogConsent { .. } => "consent",
        Inbound::HostBrowserPins {
            support,
            browser_device_ids,
            revoked_browser_keys,
            ..
        } => {
            *support = std::sync::Arc::new(SupportUpdate {
                browser_device_ids: browser_device_ids.clone(),
                revoked_browser_keys: revoked_browser_keys.clone(),
                consent: ConsentInput::Absent,
            });
            return Ok(frame);
        }
        _ => return Ok(frame),
    };
    // This bounds only the extension pass; ordinary WebSocket parsing retains
    // master's frame limit and behaviour, including unknown/duplicate fields.
    const MAX_SUPPORT_FRAME_BYTES: usize = 64 * 1024;
    struct Extension(&'static str);
    impl<'de> serde::de::DeserializeSeed<'de> for Extension {
        type Value = ConsentInput;
        fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
            d.deserialize_map(self)
        }
    }
    impl<'de> serde::de::Visitor<'de> for Extension {
        type Value = ConsentInput;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("a daemon frame")
        }
        fn visit_map<A: serde::de::MapAccess<'de>>(
            self,
            mut map: A,
        ) -> Result<Self::Value, A::Error> {
            #[derive(Deserialize)]
            #[serde(untagged)]
            enum Value {
                Valid(spawnd::support_consent::Consent),
                Null(()),
                Invalid(serde::de::IgnoredAny),
            }
            let mut result = ConsentInput::Absent;
            let mut seen = false;
            while let Some(key) = map.next_key::<String>()? {
                if key == self.0 {
                    let value = map.next_value::<Value>()?;
                    result = if seen {
                        ConsentInput::Invalid
                    } else {
                        match value {
                            Value::Valid(value) => ConsentInput::Valid(value),
                            Value::Null(()) => ConsentInput::Null,
                            Value::Invalid(_) => ConsentInput::Invalid,
                        }
                    };
                    seen = true;
                } else {
                    let _ = map.next_value::<serde::de::IgnoredAny>()?;
                }
            }
            Ok(result)
        }
    }
    let consent = if text.len() > MAX_SUPPORT_FRAME_BYTES {
        if field == "support_log_consent" && !has_top_level_field(text, field) {
            return Ok(frame);
        }
        ConsentInput::Invalid
    } else {
        use serde::de::DeserializeSeed;
        Extension(field)
            .deserialize(&mut serde_json::Deserializer::from_str(text))
            .unwrap_or(ConsentInput::Invalid)
    };
    let consent = match consent {
        ConsentInput::Absent if field == "consent" => ConsentInput::Invalid,
        value => value,
    };
    match &mut frame {
        Inbound::Registered { support, .. } | Inbound::HostSupportLogConsent { support } => {
            std::sync::Arc::make_mut(support).consent = consent;
        }
        _ => unreachable!(),
    }
    Ok(frame)
}

/// The most agents one `host.agents.check` may name. The server sends every
/// agent the host's owner can use: five built in, plus their own, which it
/// does not cap. Each named agent can cost the daemon processes, so a list
/// past this refuses the whole frame at deserialization, as an over-cap
/// endorsement list does; the server, hearing nothing, reports the check
/// timed out.
pub const MAX_HOST_AGENT_TARGETS: usize = 64;

fn deserialize_bounded_agent_targets<'de, D>(
    deserializer: D,
) -> Result<Vec<HostAgentTarget>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct BoundedTargets;
    impl<'de> serde::de::Visitor<'de> for BoundedTargets {
        type Value = Vec<HostAgentTarget>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            write!(
                formatter,
                "a sequence of at most {MAX_HOST_AGENT_TARGETS} agent targets"
            )
        }

        fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
        where
            A: serde::de::SeqAccess<'de>,
        {
            let mut targets = Vec::new();
            while let Some(target) = seq.next_element::<HostAgentTarget>()? {
                if targets.len() == MAX_HOST_AGENT_TARGETS {
                    return Err(serde::de::Error::custom(
                        "host agents check names more agents than the daemon checks",
                    ));
                }
                targets.push(target);
            }
            Ok(targets)
        }
    }

    deserializer.deserialize_seq(BoundedTargets)
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        daemon_tree: Option<String>,
        self_update: bool,
        self_update_blocked: Option<String>,
        /// A mismatched co-installed worker is repairable by reapplying the
        /// current release, so it is reported separately from blockers.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        worker_mismatch: bool,
        /// New daemons keep established peer-to-peer channels alive while the
        /// control websocket reconnects. Old servers ignore both additions.
        keeps_peers_across_reconnect: bool,
        live_bindings: Vec<LiveRtcBinding>,
        /// Allows the server to include `ice_transport_policy` on session
        /// offers without triggering the old host/session discriminator trap.
        session_ice_policy: bool,
        existing_sessions: Vec<Uuid>,
        /// What this machine is — cores, memory, CPU model, GPU. Sent once, on
        /// registration, because none of it changes while the daemon runs.
        /// Absent when `SPAWND_NO_TELEMETRY` is set, and absent from every
        /// daemon older than this field, so the server must treat "no spec" as
        /// normal rather than as a fault.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        spec: Option<crate::host_metrics::HostSpec>,
        /// This build admits browsers via account-scoped endorsement chains
        /// (`endorsement_chain::find_valid_chain`), so the server may refuse the
        /// legacy per-host device-endorsement path toward this host (mesh R9:
        /// while both paths validate, a hostile server picks the weaker one).
        /// Old servers ignore the unknown field.
        supports_account_chains: bool,
        supports_device_connections: bool,
        supports_support_log: bool,
    },
    /// The keepalive, optionally carrying two meter readings. Buckets, never
    /// percentages: see `host_metrics` for why the server is given a coarse
    /// reading and the browser an exact one. With telemetry off, both fields
    /// are skipped and the frame is byte-for-byte the one older daemons send.
    #[serde(rename = "host.heartbeat")]
    HostHeartbeat {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cpu_bucket: Option<u8>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mem_bucket: Option<u8>,
    },
    #[serde(rename = "host.pong")]
    HostPong { request_id: String },
    #[serde(rename = "host.pin_adopt_failed")]
    HostPinAdoptFailed {
        browser_device_id: String,
        reason: String,
    },
    #[serde(rename = "host.pin_adopted")]
    HostPinAdopted { browser_device_id: String },
    #[serde(rename = "daemon.update_result")]
    DaemonUpdateResult {
        request_id: String,
        ok: bool,
        tree: String,
        version_before: String,
        stage: Option<String>,
        error: Option<String>,
    },
    #[serde(rename = "session.exit")]
    SessionExit {
        session_id: Uuid,
        exit_code: Option<i32>,
        signal: Option<String>,
    },
    #[serde(rename = "session.started")]
    SessionStarted { session_id: Uuid, pid: u32 },
    /// Content-free "meaningful output happened" ping (trust Phase 2): lets the
    /// server stamp `last_output_at` without seeing PTY bytes. Throttled and
    /// classified daemon-side (see `activity.rs`).
    #[serde(rename = "session.activity")]
    SessionActivity { session_id: Uuid },
    /// Content-free input-activity ping for WebRTC DataChannel input. The
    /// server cannot observe `spawn.pty` bytes, so this daemon-throttled signal
    /// is the only metadata it needs to maintain `last_input_at`.
    #[serde(rename = "session.input_activity")]
    SessionInputActivity { session_id: Uuid },
    /// Foreground process report: the basename of the executable currently in
    /// the PTY's foreground process group. A deliberate, documented exception
    /// to the content-free activity design (docs/TRUST.md): a bare basename,
    /// max 64 chars, no arguments/paths/output, so the UI can label panes.
    /// Emitted only when the value changes, at most once per second.
    #[serde(rename = "session.foreground")]
    SessionForeground { session_id: Uuid, command: String },
    #[serde(rename = "host.agents.check_result")]
    HostAgentsCheckResult {
        request_id: String,
        agents: Vec<HostAgentStatus>,
    },
    #[serde(rename = "host.agents.install_result")]
    HostAgentsInstallResult {
        request_id: String,
        result: HostAgentInstallResult,
    },
    #[serde(rename = "rtc.answer")]
    RtcAnswer {
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        binding_nonce: Option<String>,
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
        session_id: Option<Uuid>,
        code: String,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_id: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LiveRtcBinding {
    pub session_id: String,
    pub binding_nonce: String,
    pub binding_generation: u64,
    pub scope_type: String,
    pub scope_id: Uuid,
    pub protocol: String,
    pub protocol_version: u16,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DaemonUpdateArtifact {
    pub path: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Inbound {
    Registered {
        #[serde(skip)]
        support: std::sync::Arc<SupportUpdate>,
        host_id: Uuid,
        /// Optional daemon-token rotation. Old servers omit it.
        #[serde(default)]
        access_token: Option<String>,
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
        /// Account deny-list (device mesh §3): wire keys of revoked devices this
        /// host must subtract from acceptance, so a revoked device cannot connect
        /// even through a chain to an anchor. Server-delivered, add-only for the
        /// owner, subtract-only here; a wrong value can only DENY, never grant.
        #[serde(default)]
        revoked_browser_keys: Option<Vec<String>>,
    },
    #[serde(rename = "host.support_log_consent")]
    HostSupportLogConsent {
        #[serde(skip)]
        support: std::sync::Arc<SupportUpdate>,
    },
    #[serde(rename = "support_log.collect")]
    SupportLogCollect {
        request_id: Uuid,
        since_seconds: i64,
    },
    /// Pushed when a host's browser pin set changes, so an endorsement takes
    /// effect without waiting for the daemon to reconnect.
    #[serde(rename = "host.browser_pins")]
    HostBrowserPins {
        #[serde(skip)]
        support: std::sync::Arc<SupportUpdate>,
        #[serde(default)]
        account_id: Option<String>,
        #[serde(default)]
        browser_pins: Option<Vec<InboundBrowserPin>>,
        #[serde(default)]
        browser_device_ids: Option<Vec<String>>,
        #[serde(default)]
        revoked_browser_keys: Option<Vec<String>>,
    },
    #[serde(rename = "host.heartbeat")]
    HostHeartbeat,
    #[serde(rename = "host.ping")]
    HostPing { request_id: String },
    #[serde(rename = "daemon.update")]
    DaemonUpdate {
        request_id: String,
        version: String,
        tree: String,
        target: String,
        spawnd: DaemonUpdateArtifact,
        spawn_worker: DaemonUpdateArtifact,
        #[serde(default)]
        allow_downgrade: bool,
    },
    #[serde(rename = "host.agents.check")]
    HostAgentsCheck {
        request_id: String,
        #[serde(default, deserialize_with = "deserialize_bounded_agent_targets")]
        targets: Vec<HostAgentTarget>,
    },
    #[serde(rename = "host.agents.install")]
    HostAgentsInstall {
        request_id: String,
        target: HostAgentTarget,
    },
    #[serde(rename = "session.create")]
    SessionCreate(SessionCreate),
    #[serde(rename = "session.restart")]
    SessionRestart(SessionCreate),
    #[serde(rename = "session.kill")]
    SessionKill {
        session_id: Uuid,
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
        /// Account endorsement edges the browser carries so a daemon that does
        /// not directly pin the offering key can admit it via a chain to an
        /// anchor (device mesh §3). Empty for a directly-pinned browser.
        /// Bounded at the wire: a set larger than the daemon's independent cap
        /// rejects the whole frame (see the deserializer).
        #[serde(default, deserialize_with = "deserialize_bounded_carried_endorsements")]
        carried_endorsements: Vec<CarriedEndorsement>,
        #[serde(default)]
        ice_servers: Vec<RtcIceServerConfig>,
        #[serde(default)]
        ice_transport_policy: Option<String>,
        #[serde(default)]
        ice_restart: bool,
    },
    #[serde(rename = "rtc.candidate")]
    RtcCandidate {
        session_id: String,
        #[serde(default)]
        binding_nonce: Option<String>,
        #[serde(default)]
        binding_generation: Option<u64>,
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
        scope_type: Option<String>,
        #[serde(default)]
        scope_id: Option<Uuid>,
        #[serde(default)]
        protocol: Option<String>,
        #[serde(default)]
        protocol_version: Option<u16>,
    },
    /// The server refusing a frame this daemon sent
    /// (`spawn_server.ws.reliability.ErrorFrameSender`).
    ///
    /// Without this variant the frame did not parse at all and was discarded
    /// as malformed, content-free and unattributed — so a daemon whose
    /// signalling the server was rejecting on every connection said only
    /// "discarding malformed JSON daemon control frame" and there was no way,
    /// from a running system, to learn which frame or why. That is the whole
    /// value here: both fields are short server-authored constants, and
    /// [`BoundedServerText`] keeps them that way in the log.
    #[serde(rename = "error")]
    Error {
        code: BoundedServerText,
        #[serde(default)]
        frame_type: Option<BoundedServerText>,
    },
}

/// A short string from the server, safe to put in a log line.
///
/// The daemon deliberately never logs a server frame's contents — an SDP, a
/// token, or serde's own error text quoting either (see `ws::classify`). These
/// two fields are the exception the protocol allows: a refusal code and the
/// name of the frame it refers to, both protocol constants. They are still
/// server-authored, so they are bounded and stripped of anything that is not
/// an ordinary identifier character before they are believed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BoundedServerText(String);

impl BoundedServerText {
    const MAX_CHARS: usize = 48;

    fn sanitize(raw: &str) -> Self {
        let text: String = raw
            .chars()
            .take(Self::MAX_CHARS)
            .map(|character| {
                if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                    character
                } else {
                    '?'
                }
            })
            .collect();
        Self(text)
    }
}

impl std::fmt::Display for BoundedServerText {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for BoundedServerText {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Ok(Self::sanitize(&raw))
    }
}

impl Serialize for BoundedServerText {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RtcIceServerConfig {
    pub urls: Vec<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub credential: Option<String>,
}

/// One account-scoped endorsement edge a browser carries on an RTC offer so a
/// daemon that does not directly pin the offering key can still admit it via a
/// chain to a key it does pin (docs/TRUST_DEVICE_MESH.md §3). Every field is
/// server-relayed and untrusted; the daemon re-verifies each signature and finds
/// the chain (`endorsement_chain::find_valid_chain`). Wire strings, so the daemon
/// reconstructs the exact `SPAWN-ACCT-ENDORSE-V1` transcript it re-verifies.
pub use spawnd::endorsement_chain::CarriedEndorsement;

/// `session.create` / `session.restart` payload. A session always starts as
/// the user's login shell in `cwd`: the daemon resolves the shell itself, so
/// the frame carries no argv, env, or install command.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionCreate {
    pub session_id: Uuid,
    pub cwd: String,
    #[serde(default)]
    pub skills: Vec<SkillConfig>,
    #[serde(default)]
    pub create_cwd: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillConfig {
    pub id: String,
    pub name: String,
    pub description: String,
    pub content: String,
}

/// One agent definition to probe or install on this host. `agent_id` and
/// `agent_name` identify the agent definition (the launchable CLI tool), not a
/// session; `command` is the binary name to `which` (the first word of the
/// agent definition's command string, computed server-side).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostAgentTarget {
    pub agent_id: String,
    pub agent_name: String,
    pub agent_kind: String,
    pub command: String,
    #[serde(default)]
    pub install: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostAgentStatus {
    pub agent_id: String,
    pub agent_name: String,
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
pub struct HostAgentInstallResult {
    pub agent_id: String,
    pub agent_name: String,
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
    pub status: Option<HostAgentStatus>,
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
    // A pre-0065 server still answers this field; it is ignored.
    #[serde(default)]
    #[allow(dead_code)]
    pub attended: bool,
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
mod daemon_update_wire_tests {
    use super::*;

    #[test]
    fn register_carries_self_update_identity_and_capability() {
        let value = serde_json::to_value(Outbound::Register {
            host_name: "workstation".into(),
            os: "macos".into(),
            arch: "aarch64".into(),
            version: "0.1.0+g123456789abc".into(),
            daemon_tree: Some("a".repeat(40)),
            self_update: true,
            self_update_blocked: None,
            worker_mismatch: false,
            keeps_peers_across_reconnect: true,
            live_bindings: vec![LiveRtcBinding {
                session_id: "signal-1".into(),
                binding_nonce: "a".repeat(32),
                binding_generation: 7,
                scope_type: "session".into(),
                scope_id: Uuid::nil(),
                protocol: "spawn.pty".into(),
                protocol_version: 2,
            }],
            session_ice_policy: true,
            existing_sessions: Vec::new(),
            spec: None,
            supports_account_chains: true,
            supports_device_connections: true,
            supports_support_log: true,
        })
        .unwrap();
        assert_eq!(value["type"], "register");
        assert_eq!(value["supports_support_log"], true);
        assert_eq!(value["daemon_tree"], "a".repeat(40));
        assert_eq!(value["self_update"], true);
        assert!(value["self_update_blocked"].is_null());
        assert_eq!(value["keeps_peers_across_reconnect"], true);
        assert_eq!(value["session_ice_policy"], true);
        assert_eq!(value["live_bindings"][0]["binding_generation"], 7);

        let without_tree = serde_json::to_value(Outbound::Register {
            host_name: "workstation".into(),
            os: "linux".into(),
            arch: "x86_64".into(),
            version: "0.1.0".into(),
            daemon_tree: None,
            self_update: false,
            self_update_blocked: Some("worker_missing".into()),
            worker_mismatch: false,
            keeps_peers_across_reconnect: true,
            live_bindings: Vec::new(),
            session_ice_policy: true,
            existing_sessions: Vec::new(),
            spec: None,
            supports_account_chains: true,
            supports_device_connections: true,
            supports_support_log: true,
        })
        .unwrap();
        assert!(without_tree.get("daemon_tree").is_none());
        assert_eq!(without_tree["self_update_blocked"], "worker_missing");
    }

    #[test]
    fn daemon_update_and_result_match_the_exact_wire_names() {
        let request: Inbound = serde_json::from_value(serde_json::json!({
            "type": "daemon.update",
            "request_id": "11111111-2222-4333-8444-555555555555",
            "version": "0.1.0+g123456789abc",
            "tree": "a".repeat(40),
            "target": "darwin-aarch64",
            "spawnd": {
                "path": "/api/install/spawnd/darwin-aarch64",
                "sha256": "b".repeat(64)
            },
            "spawn_worker": {
                "path": "/api/install/spawn-worker/darwin-aarch64",
                "sha256": "c".repeat(64)
            }
        }))
        .expect("daemon.update wire parses");
        assert!(matches!(
            request,
            Inbound::DaemonUpdate { ref target, .. } if target == "darwin-aarch64"
        ));

        let result = serde_json::to_value(Outbound::DaemonUpdateResult {
            request_id: "11111111-2222-4333-8444-555555555555".into(),
            ok: false,
            tree: "a".repeat(40),
            version_before: "0.1.0+g000000000000".into(),
            stage: Some("verify".into()),
            error: Some("sha256_mismatch".into()),
        })
        .unwrap();
        assert_eq!(result["type"], "daemon.update_result");
        assert_eq!(result["stage"], "verify");
        assert_eq!(result["error"], "sha256_mismatch");
    }

    #[test]
    fn pin_adoption_ack_and_nack_use_the_contract_frames() {
        let adopted = serde_json::to_value(Outbound::HostPinAdopted {
            browser_device_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee".into(),
        })
        .unwrap();
        assert_eq!(adopted["type"], "host.pin_adopted");
        assert_eq!(
            adopted["browser_device_id"],
            "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        );
        let failed = serde_json::to_value(Outbound::HostPinAdoptFailed {
            browser_device_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee".into(),
            reason: "pin_limit".into(),
        })
        .unwrap();
        assert_eq!(failed["type"], "host.pin_adopt_failed");
        assert_eq!(failed["reason"], "pin_limit");
    }

    #[test]
    fn registered_token_rotation_is_optional_for_old_servers() {
        let old: Inbound = serde_json::from_value(serde_json::json!({
            "type": "registered",
            "host_id": "11111111-2222-4333-8444-555555555555"
        }))
        .unwrap();
        assert!(matches!(
            old,
            Inbound::Registered {
                access_token: None,
                ..
            }
        ));

        let rotated: Inbound = serde_json::from_value(serde_json::json!({
            "type": "registered",
            "host_id": "11111111-2222-4333-8444-555555555555",
            "access_token": "rotated-token"
        }))
        .unwrap();
        assert!(matches!(
            rotated,
            Inbound::Registered { access_token: Some(token), .. } if token == "rotated-token"
        ));
    }
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
            "scope_type": "session",
            "scope_id": "11111111-2222-4333-8444-555555555555",
            "protocol": "spawn.pty",
            "protocol_version": 2,
            "signed_envelope": wire,
            "ice_servers": [],
            "ice_transport_policy": "relay",
            "ice_restart": true
        });
        let parsed: Inbound = serde_json::from_value(frame).expect("signed relay shape");
        assert!(matches!(
            parsed,
            Inbound::RtcOffer {
                sdp: None,
                signed_envelope: Some(ref preserved),
                ice_transport_policy: Some(ref policy),
                ice_restart: true,
                ..
            } if preserved == wire && policy == "relay"
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

    #[test]
    fn carried_endorsements_are_bounded_at_the_wire() {
        use spawnd::endorsement_chain::MAX_CARRIED_ENDORSEMENTS;

        let session_id = "018f0f77-86d2-7a8e-9b1c-1f3b847ca2a1";
        let edge = serde_json::json!({
            "account_id": "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
            "endorser_public_key": "endorser",
            "endorsed_public_key": "endorsed",
            "endorsed_device_id": "11111111-2222-4333-8444-555555555551",
            "signature": "sig",
        });
        let offer = |count: usize| {
            serde_json::json!({
                "type": "rtc.offer",
                "session_id": session_id,
                "signed_envelope": "{\"opaque\":true}",
                "carried_endorsements": vec![edge.clone(); count],
            })
        };

        // The honest relay never forwards more than 64 edges, so exactly the
        // cap must parse and one over must reject the whole frame — an
        // over-cap set only ever comes from a party driving the daemon socket
        // directly, and it must not buy any admission work.
        let at_cap: Inbound = serde_json::from_value(offer(MAX_CARRIED_ENDORSEMENTS))
            .expect("an at-cap carried edge set parses");
        assert!(matches!(
            at_cap,
            Inbound::RtcOffer { ref carried_endorsements, .. }
                if carried_endorsements.len() == MAX_CARRIED_ENDORSEMENTS
        ));
        assert!(
            serde_json::from_value::<Inbound>(offer(MAX_CARRIED_ENDORSEMENTS + 1)).is_err(),
            "an over-cap carried edge set must reject the frame"
        );

        // Absent stays the empty default; present-but-not-a-sequence rejects.
        let absent: Inbound = serde_json::from_value(serde_json::json!({
            "type": "rtc.offer",
            "session_id": session_id,
            "signed_envelope": "{\"opaque\":true}",
        }))
        .expect("absent carried edges remain valid");
        assert!(matches!(
            absent,
            Inbound::RtcOffer { ref carried_endorsements, .. } if carried_endorsements.is_empty()
        ));
        for bad in [serde_json::Value::Null, serde_json::json!("edges")] {
            assert!(
                serde_json::from_value::<Inbound>(serde_json::json!({
                    "type": "rtc.offer",
                    "session_id": session_id,
                    "signed_envelope": "{\"opaque\":true}",
                    "carried_endorsements": bad,
                }))
                .is_err(),
                "a present non-sequence carried_endorsements must reject"
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
        assert!(!body.attended, "current servers omit the legacy field");
        let pre_0065: DevicePossessionResponse =
            serde_json::from_str(r#"{"verified":true,"version":1,"attended":true}"#).unwrap();
        assert!(pre_0065.attended, "the pre-0065 field remains tolerated");

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

    /// The server's refusal frame, exactly as
    /// `spawn_server.ws.reliability.ErrorFrameSender` writes it.
    ///
    /// Before this variant existed the daemon could not parse this frame at
    /// all: a server refusing every `rtc.answer` produced nothing in the
    /// daemon's log but "discarding malformed JSON daemon control frame", with
    /// no code, no frame name, and no way to tell it apart from a frame the
    /// server had no business sending.
    #[test]
    fn the_servers_refusal_frame_parses_and_stays_bounded() {
        let frame = r#"{"type": "error", "code": "invalid_frame", "frame_type": "rtc.answer"}"#;
        match serde_json::from_str::<Inbound>(frame).expect("the server's own error frame parses") {
            Inbound::Error { code, frame_type } => {
                assert_eq!(code.to_string(), "invalid_frame");
                assert_eq!(
                    frame_type.map(|kind| kind.to_string()).as_deref(),
                    Some("rtc.answer")
                );
            }
            other => panic!("the server's error frame parsed as {other:?}"),
        }

        // `frame_type` is null whenever the refused frame had no usable type.
        let untyped = r#"{"type": "error", "code": "invalid_frame", "frame_type": null}"#;
        match serde_json::from_str::<Inbound>(untyped).expect("a null frame_type parses") {
            Inbound::Error { frame_type, .. } => assert!(frame_type.is_none()),
            other => panic!("parsed as {other:?}"),
        }

        // Both fields reach a log line, so a hostile server may not use them to
        // write one: everything but an ordinary identifier character is
        // replaced, and the length is capped.
        let hostile = format!(
            r#"{{"type": "error", "code": {}, "frame_type": {}}}"#,
            serde_json::to_string(&"x".repeat(500)).unwrap(),
            serde_json::to_string("a\nb\u{1b}[31m").unwrap(),
        );
        match serde_json::from_str::<Inbound>(&hostile).expect("a hostile error frame parses") {
            Inbound::Error { code, frame_type } => {
                assert_eq!(code.to_string().len(), BoundedServerText::MAX_CHARS);
                let kind = frame_type.expect("present").to_string();
                assert_eq!(kind, "a?b??31m");
                assert!(!kind.contains('\n') && !kind.contains('\u{1b}'));
            }
            other => panic!("parsed as {other:?}"),
        }
    }

    /// The exact host-scope candidate frame the server relays, byte for byte
    /// as `spawn_server.ws.host._signal_payload` builds it around a candidate
    /// `spawn_server.ws.browser._valid_rtc_candidate` has sanitized.
    ///
    /// A frame this daemon cannot parse is discarded content-free — the log
    /// says only "discarding malformed JSON daemon control frame" and there is
    /// no way to tell from a running system whether the server sent something
    /// new or something it sends on every connection. This test is that
    /// answer, kept next to the parser it protects.
    #[test]
    fn the_servers_host_candidate_frame_parses() {
        let frame = r#"{"type": "rtc.candidate", "session_id": "1aeaea29-1880-4c9f-9b7e-7b0d9627af15", "scope_type": "host", "scope_id": "d3914d3d-2d62-47f7-9d88-85d84e1ef79c", "protocol": "spawn.host.ctl", "protocol_version": 1, "binding_nonce": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "binding_generation": 1, "candidate": {"candidate": "candidate:842163049 1 udp 1677729535 33cde59c-1be0-47b5-9ae5-786881bd0089.local 50123 typ host generation 0 ufrag Xk4b network-cost 999", "sdpMid": "0", "usernameFragment": "Xk4b", "sdpMLineIndex": 0}}"#;
        let parsed: Inbound = serde_json::from_str(frame).expect("the server's own frame parses");
        match parsed {
            Inbound::RtcCandidate {
                session_id,
                scope_type,
                candidate,
                ..
            } => {
                assert_eq!(session_id, "1aeaea29-1880-4c9f-9b7e-7b0d9627af15");
                assert_eq!(scope_type.as_deref(), Some("host"));
                assert!(candidate.get("candidate").is_some());
            }
            other => panic!("the server's candidate frame parsed as {other:?}"),
        }
    }
    #[test]
    fn support_extensions_preserve_registration_and_bound_consent() {
        let host = Uuid::from_bytes([1; 16]);
        for (value, expected) in [
            (None, "absent"),
            (Some(serde_json::Value::Null), "null"),
            (Some(serde_json::json!({})), "invalid"),
            (Some(serde_json::json!(42)), "invalid"),
        ] {
            let mut wire = serde_json::json!({"type":"registered", "host_id":host});
            if let Some(value) = value {
                wire["support_log_consent"] = value;
            }
            let Inbound::Registered {
                support, host_id, ..
            } = parse_inbound(&wire.to_string()).unwrap()
            else {
                panic!("registration discarded")
            };
            assert_eq!(host_id, host);
            assert_eq!(
                match support.consent {
                    ConsentInput::Absent => "absent",
                    ConsentInput::Null => "null",
                    ConsentInput::Invalid => "invalid",
                    _ => "valid",
                },
                expected
            );
        }
        assert!(
            matches!(parse_inbound(r#"{"type":"host.support_log_consent","consent":null}"#).unwrap(), Inbound::HostSupportLogConsent { support } if matches!(support.consent, ConsentInput::Null))
        );
        assert!(parse_inbound(
            r#"{"type":"support_log.collect","request_id":"../escape","since_seconds":60}"#
        )
        .is_err());
    }
    #[test]
    fn duplicate_support_extension_does_not_discard_registration() {
        let wire = format!(
            r#"{{"type":"registered","host_id":"{}","support_log_consent":null,"support_log_consent":{{}}}}"#,
            Uuid::from_bytes([1; 16])
        );
        assert!(
            matches!(parse_inbound(&wire).unwrap(), Inbound::Registered { support, .. } if matches!(support.consent, ConsentInput::Invalid))
        );
    }
}

#[cfg(test)]
mod ordinary_parity {
    use super::*;
    // Frozen ordinary frame definition from origin/master at the start of this
    // repair. Shared payload types have no wire changes in this branch.
    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(tag = "type", rename_all = "snake_case")]
    enum MasterInbound {
        Registered {
            host_id: Uuid,
            /// Optional daemon-token rotation. Old servers omit it.
            #[serde(default)]
            access_token: Option<String>,
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
            /// Account deny-list (device mesh §3): wire keys of revoked devices this
            /// host must subtract from acceptance, so a revoked device cannot connect
            /// even through a chain to an anchor. Server-delivered, add-only for the
            /// owner, subtract-only here; a wrong value can only DENY, never grant.
            #[serde(default)]
            revoked_browser_keys: Option<Vec<String>>,
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
            #[serde(default)]
            revoked_browser_keys: Option<Vec<String>>,
        },
        #[serde(rename = "host.heartbeat")]
        HostHeartbeat,
        #[serde(rename = "host.ping")]
        HostPing { request_id: String },
        #[serde(rename = "daemon.update")]
        DaemonUpdate {
            request_id: String,
            version: String,
            tree: String,
            target: String,
            spawnd: DaemonUpdateArtifact,
            spawn_worker: DaemonUpdateArtifact,
            #[serde(default)]
            allow_downgrade: bool,
        },
        #[serde(rename = "host.agents.check")]
        HostAgentsCheck {
            request_id: String,
            #[serde(default, deserialize_with = "deserialize_bounded_agent_targets")]
            targets: Vec<HostAgentTarget>,
        },
        #[serde(rename = "host.agents.install")]
        HostAgentsInstall {
            request_id: String,
            target: HostAgentTarget,
        },
        #[serde(rename = "session.create")]
        SessionCreate(SessionCreate),
        #[serde(rename = "session.restart")]
        SessionRestart(SessionCreate),
        #[serde(rename = "session.kill")]
        SessionKill {
            session_id: Uuid,
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
            /// Account endorsement edges the browser carries so a daemon that does
            /// not directly pin the offering key can admit it via a chain to an
            /// anchor (device mesh §3). Empty for a directly-pinned browser.
            /// Bounded at the wire: a set larger than the daemon's independent cap
            /// rejects the whole frame (see the deserializer).
            #[serde(default, deserialize_with = "deserialize_bounded_carried_endorsements")]
            carried_endorsements: Vec<CarriedEndorsement>,
            #[serde(default)]
            ice_servers: Vec<RtcIceServerConfig>,
            #[serde(default)]
            ice_transport_policy: Option<String>,
            #[serde(default)]
            ice_restart: bool,
        },
        #[serde(rename = "rtc.candidate")]
        RtcCandidate {
            session_id: String,
            #[serde(default)]
            binding_nonce: Option<String>,
            #[serde(default)]
            binding_generation: Option<u64>,
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
            scope_type: Option<String>,
            #[serde(default)]
            scope_id: Option<Uuid>,
            #[serde(default)]
            protocol: Option<String>,
            #[serde(default)]
            protocol_version: Option<u16>,
        },
        /// The server refusing a frame this daemon sent
        /// (`spawn_server.ws.reliability.ErrorFrameSender`).
        ///
        /// Without this variant the frame did not parse at all and was discarded
        /// as malformed, content-free and unattributed — so a daemon whose
        /// signalling the server was rejecting on every connection said only
        /// "discarding malformed JSON daemon control frame" and there was no way,
        /// from a running system, to learn which frame or why. That is the whole
        /// value here: both fields are short server-authored constants, and
        /// [`BoundedServerText`] keeps them that way in the log.
        #[serde(rename = "error")]
        Error {
            code: BoundedServerText,
            #[serde(default)]
            frame_type: Option<BoundedServerText>,
        },
    }

    fn nested_markers(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::Object(map) => {
                for value in map.values_mut() {
                    nested_markers(value);
                }
                map.insert(
                    "$serde_json::private::RawValue".into(),
                    serde_json::json!(0),
                );
                map.insert(
                    "unknown".into(),
                    serde_json::json!({"$serde_json::private::RawValue":0}),
                );
            }
            serde_json::Value::Array(values) => {
                for value in values {
                    nested_markers(value);
                }
            }
            _ => {}
        }
    }
    fn parity(wire: &str) {
        let master = serde_json::from_str::<MasterInbound>(wire);
        let current = parse_inbound(wire);
        assert_eq!(
            master.is_ok(),
            current.is_ok(),
            "ordinary parse result diverged"
        );
        if let (Ok(master), Ok(current)) = (master, current) {
            assert_eq!(
                serde_json::to_value(master).unwrap(),
                serde_json::to_value(current).unwrap()
            );
        }
    }
    #[test]
    fn every_ordinary_frame_matches_master_for_private_marker_unknown_and_duplicate_fields() {
        let id = uuid::Uuid::nil().to_string();
        let target = serde_json::json!({"agent_id":"test", "agent_name":"test", "agent_kind":"test", "command":"test"});
        let frames = vec![
            serde_json::json!({"type":"registered", "host_id":id, "browser_pins":[{"browser_device_id":id,"browser_key_algorithm":"ed25519","browser_public_key":"test","browser_key_fingerprint":"test"}]}),
            serde_json::json!({"type":"host.browser_pins"}),
            serde_json::json!({"type":"host.heartbeat"}),
            serde_json::json!({"type":"host.ping", "request_id":"test"}),
            serde_json::json!({"type":"daemon.update", "request_id":"test","version":"test","tree":"test","target":"test","spawnd":{"path":"test","sha256":"test"},"spawn_worker":{"path":"test","sha256":"test"}}),
            serde_json::json!({"type":"host.agents.check", "request_id":"test", "targets":[target.clone()]}),
            serde_json::json!({"type":"host.agents.install", "request_id":"test", "target":target}),
            serde_json::json!({"type":"session.create", "session_id":id, "cwd":".", "skills":[{"id":"test","name":"test","description":"test","content":"test"}]}),
            serde_json::json!({"type":"session.restart", "session_id":id, "cwd":"."}),
            serde_json::json!({"type":"session.kill", "session_id":id}),
            serde_json::json!({"type":"rtc.offer", "session_id":"test", "ice_servers":[{"urls":["test"]}]}),
            serde_json::json!({"type":"rtc.candidate", "session_id":"test", "candidate":{"candidate":"test","sdpMid":"0","sdpMLineIndex":0}}),
            serde_json::json!({"type":"rtc.close", "session_id":"test"}),
            serde_json::json!({"type":"error", "code":"test"}),
        ];
        for mut frame in frames {
            assert!(serde_json::from_value::<MasterInbound>(frame.clone()).is_ok());
            nested_markers(&mut frame);
            let wire = frame.to_string();
            parity(&wire);
            parity(&format!("{{\"unknown\":1,\"unknown\":2,{}", &wire[1..]));
            // Duplicate a known ordinary field too: accepted/rejected exactly
            // as master, rather than normalized by a Value pre-parse.
            if let Some((key, value)) = frame.as_object().unwrap().iter().find(|(k, _)| {
                *k != "type" && *k != "unknown" && *k != "$serde_json::private::RawValue"
            }) {
                parity(&format!(
                    "{{{}:{},{}",
                    serde_json::to_string(&key).unwrap(),
                    value,
                    &wire[1..]
                ));
            }
            if frame["type"] == "rtc.candidate" {
                let Inbound::RtcCandidate { candidate, .. } = parse_inbound(&wire).unwrap() else {
                    unreachable!()
                };
                let parsed: webrtc::ice_transport::ice_candidate::RTCIceCandidateInit =
                    serde_json::from_value(candidate).unwrap();
                assert_eq!(parsed.candidate, "test");
            }
        }
    }
    #[test]
    fn oversized_registration_bounds_only_a_top_level_consent_field() {
        let padding = "x".repeat(64 * 1024);
        for (extra, present) in [
            ("", false),
            (r#","nested":[{"support_log_consent":null}]"#, false),
            (r#","value":"support_log_consent""#, false),
            (r#","value":"\"support_log_consent\":{""#, false),
            (r#","support_log_consent":null"#, true),
            (r#","support_log_\u0063onsent" : null"#, true),
        ] {
            let wire = format!(
                r#"{{"type":"registered","host_id":"{}","padding":"{padding}"{extra}}}"#,
                Uuid::nil()
            );
            let Inbound::Registered { support, .. } = parse_inbound(&wire).unwrap() else {
                panic!("registration discarded")
            };
            if present {
                assert!(matches!(support.consent, ConsentInput::Invalid));
            } else {
                assert!(matches!(support.consent, ConsentInput::Absent));
            }
        }
    }

    #[test]
    fn positional_registration_preserves_the_ordinary_frame_across_the_cap() {
        // The absence guarantee covers the objects the server sends. At or
        // below the cap, arrays keep master's map-only extension result. Above
        // it an array has no named consent field, so it can safely keep local
        // consent without parsing an unsupported wire form a second time.
        let mut wire = serde_json::json!(["registered", Uuid::nil()]).to_string();
        wire.push_str(&" ".repeat(64 * 1024 - wire.len()));
        assert!(
            matches!(parse_inbound(&wire).unwrap(), Inbound::Registered { support, .. } if matches!(support.consent, ConsentInput::Invalid))
        );
        wire.push(' ');
        assert!(
            matches!(parse_inbound(&wire).unwrap(), Inbound::Registered { support, .. } if matches!(support.consent, ConsentInput::Absent))
        );
    }
}
