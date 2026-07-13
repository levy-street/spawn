//! End-to-end test of the spawn-worker binary: spawn a real shell on a PTY it
//! owns, drive it over the framed unix-socket protocol, and verify live
//! output, stdin, resize, reattach replay, and exit reporting. No tmux
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
            acc.extend_from_slice(&payload);
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
            signal: Some("TERM".into()),
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
