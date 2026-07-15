//! Binary frame layout for PTY data on the daemon WS:
//!
//! ```text
//! +------+--------------+-----------------+
//! | kind | agent_id     | payload         |
//! | u8   | 16 bytes     | N bytes         |
//! +------+--------------+-----------------+
//! ```
//!
//! - `kind = 0x01` — PTY output (daemon → server → browsers)
//! - `kind = 0x02` — PTY input  (browser → server → daemon)
//!
//! Agent IDs are big-endian 16-byte UUIDs.

use anyhow::{bail, Result};
use uuid::Uuid;

pub const KIND_PTY_OUTPUT: u8 = 0x01;
pub const KIND_PTY_INPUT: u8 = 0x02;

const HEADER_LEN: usize = 1 + 16;

/// Encode a binary frame: `[kind][agent_id_be_bytes][payload]`.
pub fn encode_binary(kind: u8, agent_id: Uuid, payload: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(HEADER_LEN + payload.len());
    buf.push(kind);
    buf.extend_from_slice(agent_id.as_bytes());
    buf.extend_from_slice(payload);
    buf
}

/// Convenience: encode a PTY-output frame.
pub fn encode_pty_output(agent_id: Uuid, payload: &[u8]) -> Vec<u8> {
    encode_binary(KIND_PTY_OUTPUT, agent_id, payload)
}

/// Decode a binary frame. Returns `(kind, agent_id, payload_slice)`.
pub fn decode_binary(buf: &[u8]) -> Result<(u8, Uuid, &[u8])> {
    if buf.len() < HEADER_LEN {
        bail!(
            "binary frame too short: {} bytes (need {})",
            buf.len(),
            HEADER_LEN
        );
    }
    let kind = buf[0];
    let id_bytes: [u8; 16] = buf[1..HEADER_LEN].try_into().expect("checked length");
    let agent_id = Uuid::from_bytes(id_bytes);
    Ok((kind, agent_id, &buf[HEADER_LEN..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_pty_output() {
        let id = Uuid::new_v4();
        let payload = b"hello, world";
        let buf = encode_pty_output(id, payload);
        let (kind, decoded_id, decoded_payload) = decode_binary(&buf).unwrap();
        assert_eq!(kind, KIND_PTY_OUTPUT);
        assert_eq!(decoded_id, id);
        assert_eq!(decoded_payload, payload);
    }

    #[test]
    fn round_trip_empty_payload() {
        let id = Uuid::nil();
        let buf = encode_binary(KIND_PTY_INPUT, id, b"");
        let (kind, decoded_id, decoded_payload) = decode_binary(&buf).unwrap();
        assert_eq!(kind, KIND_PTY_INPUT);
        assert_eq!(decoded_id, id);
        assert!(decoded_payload.is_empty());
    }

    #[test]
    fn id_is_big_endian_uuid_bytes() {
        // The `agent_id` is the raw UUID bytes — `Uuid::as_bytes` already
        // returns network/big-endian order, which is the protocol contract.
        let id = Uuid::parse_str("12345678-1234-5678-1234-567812345678").unwrap();
        let buf = encode_pty_output(id, b"x");
        assert_eq!(&buf[1..17], id.as_bytes());
        assert_eq!(buf[0], KIND_PTY_OUTPUT);
        assert_eq!(buf[17], b'x');
    }

    #[test]
    fn rejects_too_short() {
        assert!(decode_binary(&[]).is_err());
        assert!(decode_binary(&[0x01]).is_err());
        // 16 bytes total = kind + 15 bytes of id; still short.
        assert!(decode_binary(&[0u8; 16]).is_err());
    }

    #[test]
    fn outbound_register_serializes_with_correct_type_tag() {
        use crate::proto::Outbound;
        let frame = Outbound::Register {
            host_name: "host".into(),
            os: "linux".into(),
            arch: "x86_64".into(),
            version: "0.1.0".into(),
            home_dir: Some("/home/me".into()),
            existing_agents: vec![],
        };
        let s = serde_json::to_string(&frame).unwrap();
        assert!(s.contains("\"type\":\"register\""));
        assert!(s.contains("\"host_name\":\"host\""));
        assert!(s.contains("\"home_dir\":\"/home/me\""));
    }

    #[test]
    fn outbound_dotted_types_use_protocol_names() {
        use crate::proto::Outbound;
        use uuid::Uuid;
        let frame = Outbound::AgentExit {
            agent_id: Uuid::nil(),
            exit_code: Some(0),
            signal: None,
        };
        let s = serde_json::to_string(&frame).unwrap();
        assert!(s.contains("\"type\":\"agent.exit\""));

        let hb = Outbound::HostHeartbeat;
        let s = serde_json::to_string(&hb).unwrap();
        assert!(s.contains("\"type\":\"host.heartbeat\""));

        let uploaded = Outbound::AgentUploaded {
            agent_id: Uuid::nil(),
            path: "/repo/.spawn/attachments/shot.png".into(),
            client_id: Some("upload-1".into()),
        };
        let s = serde_json::to_string(&uploaded).unwrap();
        assert!(s.contains("\"type\":\"agent.uploaded\""));
        assert!(s.contains("\"client_id\":\"upload-1\""));

        let snapshot = Outbound::AgentSnapshot {
            agent_id: Uuid::nil(),
            bytes_b64: "b2s=".into(),
            dc_offset: Some(42),
            rtc_session_id: Some("sess-1".into()),
        };
        let s = serde_json::to_string(&snapshot).unwrap();
        assert!(s.contains("\"type\":\"agent.snapshot\""));
    }

    #[test]
    fn inbound_agent_create_round_trips() {
        use crate::proto::Inbound;
        let raw = r#"{
            "type": "agent.create",
            "agent_id": "00000000-0000-0000-0000-000000000001",
            "cwd": "/tmp",
            "argv": ["claude"],
            "env": {"FOO": "bar"},
            "tmux_session": "spawn-abc",
            "cols": 120,
            "rows": 32
        }"#;
        let parsed: Inbound = serde_json::from_str(raw).unwrap();
        match parsed {
            Inbound::AgentCreate(c) => {
                assert_eq!(c.cwd, "/tmp");
                assert_eq!(c.argv, vec!["claude"]);
                assert_eq!(c.cols, 120);
                assert_eq!(c.env.get("FOO").map(String::as_str), Some("bar"));
            }
            _ => panic!("expected AgentCreate"),
        }
    }

    #[test]
    fn inbound_agent_kill_resize_parse() {
        use crate::proto::Inbound;
        let kill: Inbound = serde_json::from_str(
            r#"{"type":"agent.kill","agent_id":"00000000-0000-0000-0000-000000000002","signal":"TERM"}"#,
        )
        .unwrap();
        assert!(matches!(kill, Inbound::AgentKill { .. }));

        let resize: Inbound = serde_json::from_str(
            r#"{"type":"agent.resize","agent_id":"00000000-0000-0000-0000-000000000003","cols":80,"rows":24}"#,
        )
        .unwrap();
        match resize {
            Inbound::AgentResize { cols, rows, .. } => {
                assert_eq!(cols, 80);
                assert_eq!(rows, 24);
            }
            _ => panic!("expected AgentResize"),
        }

        let rename: Inbound = serde_json::from_str(
            r#"{"type":"agent.rename","agent_id":"00000000-0000-0000-0000-000000000003","tmux_session":"spawn-palette--00000000-0000-0000-0000-000000000003"}"#,
        )
        .unwrap();
        match rename {
            Inbound::AgentRename { tmux_session, .. } => {
                assert_eq!(
                    tmux_session,
                    "spawn-palette--00000000-0000-0000-0000-000000000003"
                );
            }
            _ => panic!("expected AgentRename"),
        }
    }

    #[test]
    fn rtc_signaling_parses_legacy_agent_and_bound_host_shapes() {
        use crate::proto::Inbound;

        let legacy: Inbound = serde_json::from_str(
            r#"{"type":"rtc.offer","session_id":"legacy","agent_id":"00000000-0000-4000-8000-000000000001","sdp":"v=0"}"#,
        )
        .unwrap();
        match legacy {
            Inbound::RtcOffer {
                agent_id,
                scope_type,
                protocol,
                ..
            } => {
                assert!(agent_id.is_some());
                assert!(scope_type.is_none());
                assert!(protocol.is_none());
            }
            _ => panic!("expected legacy RTC offer"),
        }

        let host: Inbound = serde_json::from_str(
            r#"{"type":"rtc.offer","session_id":"host","scope_type":"host","scope_id":"00000000-0000-4000-8000-000000000002","protocol":"spawn.host.ctl","protocol_version":1,"sdp":"v=0","ice_transport_policy":"relay"}"#,
        )
        .unwrap();
        match host {
            Inbound::RtcOffer {
                agent_id,
                scope_type,
                scope_id,
                protocol,
                protocol_version,
                ice_transport_policy,
                ..
            } => {
                assert!(agent_id.is_none());
                assert_eq!(scope_type.as_deref(), Some("host"));
                assert!(scope_id.is_some());
                assert_eq!(protocol.as_deref(), Some("spawn.host.ctl"));
                assert_eq!(protocol_version, Some(1));
                assert_eq!(ice_transport_policy.as_deref(), Some("relay"));
            }
            _ => panic!("expected host RTC offer"),
        }
    }

    #[test]
    fn host_fs_frames_parse_and_serialize() {
        use crate::proto::{HostDirEntry, Inbound, Outbound};

        let list: Inbound =
            serde_json::from_str(r#"{"type":"host.fs.list","request_id":"req-1","path":"~/src"}"#)
                .unwrap();
        match list {
            Inbound::HostFsList {
                request_id,
                path,
                include_files,
            } => {
                assert_eq!(request_id, "req-1");
                assert_eq!(path.as_deref(), Some("~/src"));
                assert!(!include_files);
            }
            _ => panic!("expected HostFsList"),
        }

        let result = Outbound::HostFsListResult {
            request_id: "req-1".into(),
            path: "/home/me".into(),
            home_dir: Some("/home/me".into()),
            parent: Some("/home".into()),
            entries: vec![HostDirEntry {
                name: "src".into(),
                path: "/home/me/src".into(),
                is_dir: Some(true),
                size: None,
                modified_at: Some(1_750_000_000),
            }],
            error: None,
        };
        let s = serde_json::to_string(&result).unwrap();
        assert!(s.contains("\"type\":\"host.fs.list_result\""));
        assert!(s.contains("\"request_id\":\"req-1\""));
        assert!(s.contains("\"path\":\"/home/me/src\""));
        assert!(s.contains("\"is_dir\":true"));
    }

    #[test]
    fn host_fs_explorer_frames_parse_and_serialize() {
        use crate::proto::{Inbound, Outbound};

        let list: Inbound = serde_json::from_str(
            r#"{"type":"host.fs.list","request_id":"r1","path":"~","include_files":true}"#,
        )
        .unwrap();
        assert!(matches!(
            list,
            Inbound::HostFsList {
                include_files: true,
                ..
            }
        ));

        let read: Inbound =
            serde_json::from_str(r#"{"type":"host.fs.read","request_id":"r2","path":"~/a.txt"}"#)
                .unwrap();
        assert!(matches!(read, Inbound::HostFsRead { .. }));

        let write: Inbound = serde_json::from_str(
            r#"{"type":"host.fs.write","request_id":"r3","dir":"~/src","name":"a.txt","bytes_b64":"aGk="}"#,
        )
        .unwrap();
        match write {
            Inbound::HostFsWrite {
                overwrite, name, ..
            } => {
                assert!(!overwrite);
                assert_eq!(name, "a.txt");
            }
            _ => panic!("expected HostFsWrite"),
        }

        let mkdir: Inbound =
            serde_json::from_str(r#"{"type":"host.fs.mkdir","request_id":"r4","path":"~/new"}"#)
                .unwrap();
        assert!(matches!(mkdir, Inbound::HostFsMkdir { .. }));

        let rename: Inbound = serde_json::from_str(
            r#"{"type":"host.fs.rename","request_id":"r6","path":"~/old.txt","name":"new.txt"}"#,
        )
        .unwrap();
        match rename {
            Inbound::HostFsRename { name, .. } => assert_eq!(name, "new.txt"),
            _ => panic!("expected HostFsRename"),
        }

        let remove: Inbound = serde_json::from_str(
            r#"{"type":"host.fs.remove","request_id":"r5","path":"~/old","recursive":true}"#,
        )
        .unwrap();
        assert!(matches!(
            remove,
            Inbound::HostFsRemove {
                recursive: true,
                ..
            }
        ));

        let read_result = Outbound::HostFsReadResult {
            request_id: "r2".into(),
            path: "/home/me/a.txt".into(),
            name: Some("a.txt".into()),
            size: Some(2),
            bytes_b64: Some("aGk=".into()),
            error: None,
        };
        let s = serde_json::to_string(&read_result).unwrap();
        assert!(s.contains("\"type\":\"host.fs.read_result\""));

        let op_result = Outbound::HostFsOpResult {
            request_id: "r3".into(),
            path: Some("/home/me/src/a.txt".into()),
            error: None,
        };
        let s = serde_json::to_string(&op_result).unwrap();
        assert!(s.contains("\"type\":\"host.fs.op_result\""));
    }

    #[test]
    fn inbound_agent_upload_parse() {
        use crate::proto::Inbound;
        let upload: Inbound = serde_json::from_str(
            r#"{
                "type":"agent.upload",
                "agent_id":"00000000-0000-0000-0000-000000000004",
                "cwd":"/repo",
                "name":"shot.png",
                "mime_type":"image/png",
                "bytes_b64":"cG5n",
                "paste_prefix":"@",
                "paste":false,
                "destination":"cwd",
                "client_id":"upload-1"
            }"#,
        )
        .unwrap();
        match upload {
            Inbound::AgentUpload {
                cwd,
                name,
                mime_type,
                bytes_b64,
                paste_prefix,
                paste,
                destination,
                client_id,
                ..
            } => {
                assert_eq!(cwd, "/repo");
                assert_eq!(name, "shot.png");
                assert_eq!(mime_type, "image/png");
                assert_eq!(bytes_b64, "cG5n");
                assert_eq!(paste_prefix.as_deref(), Some("@"));
                assert_eq!(paste, Some(false));
                assert_eq!(destination.as_deref(), Some("cwd"));
                assert_eq!(client_id.as_deref(), Some("upload-1"));
            }
            _ => panic!("expected AgentUpload"),
        }
    }

    #[test]
    fn inbound_agent_snapshot_parse() {
        use crate::proto::Inbound;
        let snapshot: Inbound = serde_json::from_str(
            r#"{
                "type":"agent.snapshot",
                "agent_id":"00000000-0000-0000-0000-000000000005",
                "lines":5000
            }"#,
        )
        .unwrap();
        match snapshot {
            Inbound::AgentSnapshot { lines, plain, .. } => {
                assert_eq!(lines, Some(5000));
                assert_eq!(plain, None);
            }
            _ => panic!("expected AgentSnapshot"),
        }

        let plain_snapshot: Inbound = serde_json::from_str(
            r#"{
                "type":"agent.snapshot",
                "agent_id":"00000000-0000-0000-0000-000000000005",
                "lines":5000,
                "plain":true
            }"#,
        )
        .unwrap();
        match plain_snapshot {
            Inbound::AgentSnapshot { plain, .. } => assert_eq!(plain, Some(true)),
            _ => panic!("expected AgentSnapshot"),
        }

        let redraw: Inbound = serde_json::from_str(
            r#"{"type":"agent.redraw","agent_id":"00000000-0000-0000-0000-000000000005"}"#,
        )
        .unwrap();
        assert!(matches!(redraw, Inbound::AgentRedraw { .. }));
    }

    #[test]
    fn inbound_host_heartbeat_parse() {
        use crate::proto::Inbound;
        let hb: Inbound = serde_json::from_str(r#"{"type":"host.heartbeat"}"#).unwrap();
        assert!(matches!(hb, Inbound::HostHeartbeat));
    }
}
