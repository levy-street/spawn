//! End-to-end test of the spawn-worker binary: spawn a real shell on a PTY it
//! owns, drive it over the framed unix-socket protocol, and verify live
//! output, stdin, resize, reattach replay, and exit reporting. No external
//! anywhere near this test.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::net::UnixStream;
use tokio::process::{Child, Command};
use uuid::Uuid;

use spawnd::sessiond::wire;

const WORKER_BIN: &str = env!("CARGO_BIN_EXE_spawn-worker");
const STEP_TIMEOUT: Duration = Duration::from_secs(15);

struct WorkerFixture {
    child: Child,
    socket: PathBuf,
    _dir: tempfile::TempDir,
}

impl WorkerFixture {
    async fn launch() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let socket = dir.path().join("agent.sock");
        let log_dir = dir.path().join("scrollback");
        let child = Command::new(WORKER_BIN)
            .arg("--socket")
            .arg(&socket)
            .arg("--agent-id")
            .arg(Uuid::new_v4().to_string())
            .arg("--log-dir")
            .arg(&log_dir)
            .arg("--segment-bytes")
            .arg("4096")
            .arg("--max-log-bytes")
            .arg("65536")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("spawning spawn-worker");
        Self {
            child,
            socket,
            _dir: dir,
        }
    }

    async fn connect(&self) -> UnixStream {
        connect_with_retry(&self.socket).await
    }
}

async fn connect_with_retry(socket: &Path) -> UnixStream {
    let deadline = tokio::time::Instant::now() + STEP_TIMEOUT;
    loop {
        match UnixStream::connect(socket).await {
            Ok(stream) => return stream,
            Err(_) if tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            Err(e) => panic!("worker socket never came up: {e}"),
        }
    }
}

async fn read_frame(stream: &mut UnixStream) -> (u8, Vec<u8>) {
    tokio::time::timeout(STEP_TIMEOUT, wire::read_frame(stream))
        .await
        .expect("frame read timed out")
        .expect("frame read failed")
        .expect("connection closed unexpectedly")
}

async fn expect_hello(stream: &mut UnixStream, state: &str) -> wire::Hello {
    let (frame_type, payload) = read_frame(stream).await;
    assert_eq!(frame_type, wire::T_HELLO, "first frame must be Hello");
    let hello: wire::Hello = wire::decode_json(&payload).unwrap();
    assert_eq!(hello.version, wire::PROTO_VERSION);
    assert_eq!(hello.state, state);
    hello
}

/// Collect T_OUTPUT payloads until `needle` appears in the accumulated bytes.
async fn collect_output_until(stream: &mut UnixStream, needle: &[u8]) -> Vec<u8> {
    let mut acc: Vec<u8> = Vec::new();
    let deadline = tokio::time::Instant::now() + STEP_TIMEOUT;
    loop {
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {:?}; got {:?}",
            String::from_utf8_lossy(needle),
            String::from_utf8_lossy(&acc)
        );
        let (frame_type, payload) = read_frame(stream).await;
        if frame_type == wire::T_OUTPUT {
            let (_watermark, bytes) = wire::decode_output(&payload).expect("valid output frame");
            acc.extend_from_slice(bytes);
            if acc.windows(needle.len()).any(|w| w == needle) {
                return acc;
            }
        }
    }
}

fn base_env() -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    env.insert(
        "PATH".to_string(),
        std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into()),
    );
    env.insert("TERM".to_string(), "xterm-256color".to_string());
    env
}

fn start_spec(argv: &[&str]) -> wire::StartSpec {
    wire::StartSpec {
        cwd: "/".to_string(),
        argv: argv.iter().map(|s| s.to_string()).collect(),
        env: base_env(),
        cols: 80,
        rows: 24,
    }
}

#[tokio::test]
async fn worker_runs_command_streams_output_and_replays_on_reattach() {
    let mut fixture = WorkerFixture::launch().await;

    // --- first connection: start the agent, see live output -------------
    let mut conn = fixture.connect().await;
    expect_hello(&mut conn, "awaiting_start").await;

    let spec = start_spec(&["/bin/sh", "-c", "printf 'hello-from-worker\\n'; cat"]);
    wire::write_json_frame(&mut conn, wire::T_START, &spec)
        .await
        .unwrap();
    let (frame_type, payload) = read_frame(&mut conn).await;
    assert_eq!(frame_type, wire::T_STARTED);
    let started: wire::Started = wire::decode_json(&payload).unwrap();
    assert!(started.pid > 0, "agent pid must be real");

    collect_output_until(&mut conn, b"hello-from-worker").await;

    // stdin flows into the PTY (cat echoes it back).
    wire::write_frame(&mut conn, wire::T_INPUT, b"marco-polo\n")
        .await
        .unwrap();
    collect_output_until(&mut conn, b"marco-polo").await;

    // Resize is accepted without killing anything.
    wire::write_frame(&mut conn, wire::T_RESIZE, &wire::encode_resize(120, 40))
        .await
        .unwrap();

    // --- drop the connection entirely (spawnd "restart") ----------------
    drop(conn);
    tokio::time::sleep(Duration::from_millis(100)).await;

    // --- reattach: worker still alive, replay covers everything ---------
    let mut conn = fixture.connect().await;
    let hello = expect_hello(&mut conn, "running").await;
    assert_eq!(hello.pid, Some(started.pid));
    assert_eq!((hello.cols, hello.rows), (120, 40));

    wire::write_frame(
        &mut conn,
        wire::T_REPLAY_REQ,
        &wire::encode_replay_req(1024 * 1024),
    )
    .await
    .unwrap();
    let replay = loop {
        let (frame_type, payload) = read_frame(&mut conn).await;
        if frame_type == wire::T_REPLAY {
            break payload;
        }
        // Live output frames may interleave; skip them.
        assert!(
            frame_type == wire::T_OUTPUT,
            "unexpected frame {frame_type}"
        );
    };
    let (watermark, bytes) = wire::decode_replay(&replay).unwrap();
    assert!(watermark > 0);
    let text = String::from_utf8_lossy(bytes);
    assert!(
        text.contains("hello-from-worker"),
        "replay missing initial output: {text:?}"
    );
    assert!(
        text.contains("marco-polo"),
        "replay missing echoed stdin: {text:?}"
    );

    // Input still works on the adopted connection.
    wire::write_frame(&mut conn, wire::T_INPUT, b"after-reattach\n")
        .await
        .unwrap();
    collect_output_until(&mut conn, b"after-reattach").await;

    // --- shutdown: Exit frame, then full cleanup -------------------------
    wire::write_json_frame(
        &mut conn,
        wire::T_SHUTDOWN,
        &wire::Shutdown {
            signal: Some(wire::LifecycleSignal::Term),
        },
    )
    .await
    .unwrap();
    let deadline = tokio::time::Instant::now() + STEP_TIMEOUT;
    loop {
        assert!(
            tokio::time::Instant::now() < deadline,
            "never saw T_EXIT after shutdown"
        );
        let (frame_type, payload) = read_frame(&mut conn).await;
        if frame_type == wire::T_EXIT {
            let _: wire::ExitInfo = wire::decode_json(&payload).unwrap();
            break;
        }
    }

    // Worker process exits and unlinks its socket.
    let status = tokio::time::timeout(STEP_TIMEOUT, fixture.child.wait())
        .await
        .expect("worker did not exit")
        .expect("worker wait failed");
    assert!(status.success(), "worker exit status: {status:?}");
    assert!(
        !fixture.socket.exists(),
        "socket should be unlinked on exit"
    );
}

#[tokio::test]
async fn worker_reports_exit_code() {
    let mut fixture = WorkerFixture::launch().await;
    let mut conn = fixture.connect().await;
    expect_hello(&mut conn, "awaiting_start").await;

    let spec = start_spec(&["/bin/sh", "-c", "exit 7"]);
    wire::write_json_frame(&mut conn, wire::T_START, &spec)
        .await
        .unwrap();
    let (frame_type, _) = read_frame(&mut conn).await;
    assert_eq!(frame_type, wire::T_STARTED);

    let deadline = tokio::time::Instant::now() + STEP_TIMEOUT;
    let info = loop {
        assert!(tokio::time::Instant::now() < deadline, "no exit frame");
        let (frame_type, payload) = read_frame(&mut conn).await;
        if frame_type == wire::T_EXIT {
            break wire::decode_json::<wire::ExitInfo>(&payload).unwrap();
        }
    };
    assert_eq!(info.exit_code, Some(7));

    let status = tokio::time::timeout(STEP_TIMEOUT, fixture.child.wait())
        .await
        .expect("worker did not exit")
        .expect("worker wait failed");
    assert!(status.success());
}

/// Guards against the "duplicated screenfuls in scrollback" bug: rotations
/// used to jiggle the PTY rows-1 -> rows to provoke a checkpoint repaint, and
/// full-screen apps (claude, codex) re-rendered a duplicate frame on every
/// WINCH. Checkpoints are now synthesized from the worker's emulator, so log
/// rotation is a storage concern that must be invisible to the agent process.
#[tokio::test]
async fn scrollback_rotation_must_not_disturb_the_agent() {
    let fixture = WorkerFixture::launch().await;
    let mut conn = fixture.connect().await;
    expect_hello(&mut conn, "awaiting_start").await;

    // Flood ~14KB (>3 rotations at 4KB segments) with a WINCH trap armed,
    // then idle long enough for any pending jiggle signals to be delivered.
    let script = r#"
trap 'printf "WINCH-SEEN\n"' WINCH
i=0; while [ $i -lt 200 ]; do printf 'chunk-%04d-%060d\n' "$i" 0; i=$((i+1)); done
printf 'FLOOD-DONE\n'
n=0; while [ $n -lt 20 ]; do sleep 0.1; n=$((n+1)); done
printf 'IDLE-DONE\n'
"#;
    let spec = start_spec(&["/bin/bash", "-c", script]);
    wire::write_json_frame(&mut conn, wire::T_START, &spec)
        .await
        .unwrap();
    let (frame_type, _) = read_frame(&mut conn).await;
    assert_eq!(frame_type, wire::T_STARTED);

    let output = collect_output_until(&mut conn, b"IDLE-DONE").await;
    let text = String::from_utf8_lossy(&output);
    assert!(
        text.contains("FLOOD-DONE"),
        "flood never completed: {text:?}"
    );
    let winches = text.matches("WINCH-SEEN").count();
    assert_eq!(
        winches, 0,
        "agent received {winches} WINCH(es) purely from log rotation; \
         full-screen apps re-render their frame on each one, duplicating \
         screenfuls in scrollback"
    );
}

/// Guards against the "garbled lines when scrolling" bug: replays used to be
/// raw bytes with no geometry information, so a replay spanning a resize
/// rendered old-geometry bytes at the current size. Replays are now
/// self-describing: they open with a geometry marker (`CSI 8 ; rows ; cols t`)
/// plus a checkpoint repaint and emit a marker at every recorded resize, so
/// every byte renders at a known geometry.
#[tokio::test]
async fn replay_describes_geometry_across_resizes() {
    let fixture = WorkerFixture::launch().await;
    let mut conn = fixture.connect().await;
    expect_hello(&mut conn, "awaiting_start").await;

    let spec = start_spec(&["/bin/sh", "-c", "printf 'before-resize\\n'; cat"]);
    wire::write_json_frame(&mut conn, wire::T_START, &spec)
        .await
        .unwrap();
    let (frame_type, _) = read_frame(&mut conn).await;
    assert_eq!(frame_type, wire::T_STARTED);
    collect_output_until(&mut conn, b"before-resize").await;

    wire::write_frame(&mut conn, wire::T_RESIZE, &wire::encode_resize(120, 40))
        .await
        .unwrap();
    wire::write_frame(&mut conn, wire::T_INPUT, b"after-resize\n")
        .await
        .unwrap();
    collect_output_until(&mut conn, b"after-resize").await;

    wire::write_frame(
        &mut conn,
        wire::T_REPLAY_REQ,
        &wire::encode_replay_req(1024 * 1024),
    )
    .await
    .unwrap();
    let replay = loop {
        let (frame_type, payload) = read_frame(&mut conn).await;
        if frame_type == wire::T_REPLAY {
            break payload;
        }
        assert!(
            frame_type == wire::T_OUTPUT,
            "unexpected frame {frame_type}"
        );
    };
    let (_, bytes) = wire::decode_replay(&replay).unwrap();
    let text = String::from_utf8_lossy(bytes);

    // Opens with the starting geometry (80x24 from the StartSpec).
    assert!(
        text.starts_with("\x1b[8;24;80t"),
        "replay must open with a geometry marker: {:?}",
        &text[..text.len().min(40)]
    );
    let before = text.find("before-resize").expect("pre-resize output");
    let resize_marker = text
        .find("\x1b[8;40;120t")
        .expect("resize must appear as a geometry marker");
    let after = text.find("after-resize").expect("post-resize output");
    assert!(
        before < resize_marker && resize_marker < after,
        "geometry marker must sit between output produced at 80x24 and at \
         120x40 (before={before}, marker={resize_marker}, after={after})"
    );
}

/// The capstone fidelity check: a replay reconstructs the exact screen a
/// viewer of the live byte stream would see, across TUI cursor addressing
/// and multiple checkpoint rotations. Both streams are rendered through the
/// sessiond emulator and compared cell-for-cell as text.
#[tokio::test]
async fn replay_reconstructs_the_live_screen_across_rotations() {
    let fixture = WorkerFixture::launch().await;
    let mut conn = fixture.connect().await;
    expect_hello(&mut conn, "awaiting_start").await;

    // ~7KB of flood (several 4KB-segment rotations), then a cursor-addressed
    // TUI frame painted over the scrolled screen.
    let script = r#"
printf '\033[2J\033[H'
i=0; while [ $i -lt 600 ]; do printf 'flood-%04d\n' "$i"; i=$((i+1)); done
printf '\033[5;10H\033[7mTUI-BOX-FINAL\033[0m\033[K'
printf '\033[24;1HDONE-MARKER'
cat
"#;
    let spec = start_spec(&["/bin/sh", "-c", script]);
    wire::write_json_frame(&mut conn, wire::T_START, &spec)
        .await
        .unwrap();
    let (frame_type, _) = read_frame(&mut conn).await;
    assert_eq!(frame_type, wire::T_STARTED);
    let live_bytes = collect_output_until(&mut conn, b"DONE-MARKER").await;

    wire::write_frame(
        &mut conn,
        wire::T_REPLAY_REQ,
        &wire::encode_replay_req(1024 * 1024),
    )
    .await
    .unwrap();
    let replay = loop {
        let (frame_type, payload) = read_frame(&mut conn).await;
        if frame_type == wire::T_REPLAY {
            break payload;
        }
        assert!(
            frame_type == wire::T_OUTPUT,
            "unexpected frame {frame_type}"
        );
    };
    let (_, replay_bytes) = wire::decode_replay(&replay).unwrap();

    let mut live = spawnd::sessiond::emulator::Emulator::new(80, 24);
    live.feed(&live_bytes);
    let mut replayed = spawnd::sessiond::emulator::Emulator::new(80, 24);
    replayed.feed(replay_bytes);

    let (live_screen, replay_screen) = (live.screen_text(), replayed.screen_text());
    assert_eq!(
        live_screen, replay_screen,
        "replay-reconstructed screen diverged from the live screen"
    );
    let joined = replay_screen.join("\n");
    assert_eq!(
        joined.matches("TUI-BOX-FINAL").count(),
        1,
        "TUI frame must appear exactly once: {joined}"
    );
}

#[tokio::test]
async fn worker_rejects_bad_start_and_reports_error() {
    let fixture = WorkerFixture::launch().await;
    let mut conn = fixture.connect().await;
    expect_hello(&mut conn, "awaiting_start").await;

    let spec = wire::StartSpec {
        cwd: "/".into(),
        argv: vec![],
        env: base_env(),
        cols: 80,
        rows: 24,
    };
    wire::write_json_frame(&mut conn, wire::T_START, &spec)
        .await
        .unwrap();
    let (frame_type, payload) = read_frame(&mut conn).await;
    assert_eq!(frame_type, wire::T_ERROR);
    let err: wire::WorkerError = wire::decode_json(&payload).unwrap();
    assert!(err.message.contains("argv"), "unexpected error: {err:?}");
}
