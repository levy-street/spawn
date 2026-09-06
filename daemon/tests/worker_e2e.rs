//! End-to-end test of the spawn-worker binary: spawn a real shell on a PTY it
//! owns, drive it over the framed unix-socket protocol, and verify live
//! output, stdin, resize, reattach replay, and exit reporting. No external
//! anywhere near this test.

#[cfg(unix)]
mod unix {
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

    fn worker_command(socket: &Path, session_id: Uuid, log_dir: &Path) -> Command {
        let mut command = Command::new(WORKER_BIN);
        command
            .arg("--socket")
            .arg(socket)
            .arg("--session-id")
            .arg(session_id.to_string())
            .arg("--log-dir")
            .arg(log_dir)
            .arg("--segment-bytes")
            .arg("4096")
            .arg("--max-log-bytes")
            .arg("65536")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        command
    }

    struct WorkerFixture {
        child: Child,
        socket: PathBuf,
        _dir: tempfile::TempDir,
    }

    impl WorkerFixture {
        async fn launch() -> Self {
            let dir = tempfile::Builder::new()
                .prefix("spawn-e2e-")
                .tempdir_in("/tmp")
                .expect("short tempdir");
            let session_id = Uuid::new_v4();
            let socket = dir.path().join(format!("{session_id}.sock"));
            let log_dir = dir.path().join("scrollback");
            let child = worker_command(&socket, session_id, &log_dir)
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

    /// Scratch diagnostic (ignored by default): input→echo latency through the
    /// worker + unix socket alone. Run with `--ignored --nocapture` to print the
    /// distribution when hunting interactive-latency regressions.
    #[tokio::test]
    #[ignore]
    async fn echo_latency_through_worker() {
        let fixture = WorkerFixture::launch().await;
        let mut conn = fixture.connect().await;
        expect_hello(&mut conn, "awaiting_start").await;
        let spec = start_spec(&["/bin/cat"]);
        wire::write_json_frame(&mut conn, wire::T_START, &spec)
            .await
            .unwrap();
        let (frame_type, _) = read_frame(&mut conn).await;
        assert_eq!(frame_type, wire::T_STARTED);

        let mut samples = Vec::new();
        for i in 0..50u8 {
            let byte = [b'a' + (i % 26)];
            let start = std::time::Instant::now();
            wire::write_frame(&mut conn, wire::T_INPUT, &byte)
                .await
                .unwrap();
            loop {
                let (frame_type, payload) = read_frame(&mut conn).await;
                if frame_type == wire::T_OUTPUT {
                    let (_, bytes) = wire::decode_output(&payload).unwrap();
                    if bytes.contains(&byte[0]) {
                        break;
                    }
                }
            }
            samples.push(start.elapsed().as_secs_f64() * 1000.0);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        samples.sort_by(f64::total_cmp);
        println!(
            "worker echo: min={:.2} p50={:.2} p90={:.2} max={:.2} ms",
            samples[0],
            samples[samples.len() / 2],
            samples[samples.len() * 9 / 10],
            samples[samples.len() - 1]
        );
    }

    #[tokio::test]
    async fn duplicate_worker_is_rejected_and_crash_stale_endpoints_recover() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::Builder::new()
            .prefix("spawn-e2e-")
            .tempdir_in("/tmp")
            .expect("short tempdir");
        let session_id = Uuid::new_v4();
        let socket = dir.path().join(format!("{session_id}.sock"));
        let lifecycle = socket.with_extension("lifecycle.sock");
        let logs = dir.path().join("scrollback");
        let mut first = worker_command(&socket, session_id, &logs).spawn().unwrap();
        let mut first_conn = connect_with_retry(&socket).await;
        let first_hello = expect_hello(&mut first_conn, "awaiting_start").await;
        assert_eq!(first_hello.session_id, session_id);
        assert_eq!(
            std::fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777,
            0o700
        );
        for endpoint in [&socket, &lifecycle] {
            assert_eq!(
                std::fs::metadata(endpoint).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        let mut duplicate = worker_command(&socket, session_id, &logs).spawn().unwrap();
        let duplicate_status = tokio::time::timeout(Duration::from_secs(3), duplicate.wait())
            .await
            .expect("duplicate worker did not reject promptly")
            .unwrap();
        assert!(!duplicate_status.success());
        assert!(
            first.try_wait().unwrap().is_none(),
            "owner worker was displaced"
        );

        // SIGKILL bypasses the worker's identity-guarded normal cleanup, leaving
        // both socket inodes behind. Releasing the lifetime flock lets exactly one
        // replacement recover them safely.
        first.kill().await.unwrap();
        first.wait().await.unwrap();
        assert!(socket.exists());
        assert!(lifecycle.exists());
        drop(first_conn);

        let mut replacement = worker_command(&socket, session_id, &logs).spawn().unwrap();
        let mut replacement_conn = connect_with_retry(&socket).await;
        let replacement_hello = expect_hello(&mut replacement_conn, "awaiting_start").await;
        assert_eq!(replacement_hello.session_id, session_id);
        assert_ne!(replacement_hello.instance_id, first_hello.instance_id);
        wire::write_json_frame(
            &mut replacement_conn,
            wire::T_SHUTDOWN,
            &wire::Shutdown { signal: None },
        )
        .await
        .unwrap();
        let status = tokio::time::timeout(STEP_TIMEOUT, replacement.wait())
            .await
            .expect("replacement did not exit")
            .unwrap();
        assert!(status.success());
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn supervisor_replacement_and_oversized_headers_keep_resources_bounded() {
        fn fd_count(pid: u32) -> usize {
            std::fs::read_dir(format!("/proc/{pid}/fd"))
                .unwrap()
                .count()
        }

        fn rss_kib(pid: u32) -> u64 {
            let status = std::fs::read_to_string(format!("/proc/{pid}/status")).unwrap();
            status
                .lines()
                .find_map(|line| line.strip_prefix("VmRSS:"))
                .and_then(|value| value.split_whitespace().next())
                .unwrap()
                .parse()
                .unwrap()
        }

        let mut fixture = WorkerFixture::launch().await;
        let worker_pid = fixture.child.id().expect("worker pid");
        let mut current = fixture.connect().await;
        expect_hello(&mut current, "awaiting_start").await;
        wire::write_json_frame(
            &mut current,
            wire::T_START,
            &start_spec(&["/bin/sh", "-c", "cat"]),
        )
        .await
        .unwrap();
        let (frame_type, _) = read_frame(&mut current).await;
        assert_eq!(frame_type, wire::T_STARTED);
        let baseline_fds = fd_count(worker_pid);
        let baseline_rss = rss_kib(worker_pid);
        let mut oldest_stale = Some(current);

        let mut current = fixture.connect().await;
        expect_hello(&mut current, "running").await;
        for _ in 0..200 {
            let mut bad = fixture.connect().await;
            expect_hello(&mut bad, "running").await;
            let mut header = [0u8; 5];
            header[..4].copy_from_slice(&u32::MAX.to_le_bytes());
            header[4] = wire::T_INPUT;
            use tokio::io::AsyncWriteExt;
            bad.write_all(&header).await.unwrap();
            let closed = tokio::time::timeout(Duration::from_secs(1), wire::read_frame(&mut bad))
                .await
                .expect("oversized-header peer retained a worker task/fd");
            assert!(closed.is_err() || closed.unwrap().is_none());

            let mut replacement = fixture.connect().await;
            expect_hello(&mut replacement, "running").await;
            current = replacement;
        }

        tokio::time::sleep(Duration::from_millis(50)).await;
        if let Some(stale) = oldest_stale.as_mut() {
            let _ = wire::write_frame(stale, wire::T_INPUT, b"stale-peer-marker\n").await;
        }
        wire::write_frame(&mut current, wire::T_INPUT, b"current-peer-marker\n")
            .await
            .unwrap();
        let output = collect_output_until(&mut current, b"current-peer-marker").await;
        assert!(
            !output
                .windows(b"stale-peer-marker".len())
                .any(|window| window == b"stale-peer-marker"),
            "cancelled supervisor reader still fed commands"
        );

        assert!(
            fd_count(worker_pid) <= baseline_fds + 3,
            "supervisor replacement leaked worker fds"
        );
        assert!(
            rss_kib(worker_pid) <= baseline_rss + 16 * 1024,
            "oversized headers or replacement tasks grew worker memory without bound"
        );

        wire::write_json_frame(
            &mut current,
            wire::T_SHUTDOWN,
            &wire::Shutdown {
                signal: Some(wire::LifecycleSignal::Term),
            },
        )
        .await
        .unwrap();
        tokio::time::timeout(STEP_TIMEOUT, fixture.child.wait())
            .await
            .expect("worker cleanup timed out")
            .unwrap();
        drop(oldest_stale.take());
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
                let (_watermark, bytes) =
                    wire::decode_output(&payload).expect("valid output frame");
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

    /// Read frames until a `T_FOREGROUND` report matching `expected` arrives;
    /// other frame types (output, history) are drained and ignored. Returns every
    /// distinct foreground value observed on the way, `expected` last.
    async fn collect_foreground_until(stream: &mut UnixStream, expected: &str) -> Vec<String> {
        let mut seen: Vec<String> = Vec::new();
        let deadline = tokio::time::Instant::now() + STEP_TIMEOUT;
        loop {
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out waiting for foreground {expected:?}; saw {seen:?}"
            );
            let (frame_type, payload) = read_frame(stream).await;
            if frame_type != wire::T_FOREGROUND {
                continue;
            }
            let basename = wire::decode_foreground(&payload)
                .expect("valid foreground frame")
                .to_string();
            assert!(!basename.trim().is_empty(), "foreground must be non-empty");
            assert!(
                basename.chars().count() <= 64,
                "foreground basename must be truncated to 64 chars: {basename:?}"
            );
            if seen.last().map(String::as_str) != Some(basename.as_str()) {
                seen.push(basename.clone());
            }
            if basename == expected {
                return seen;
            }
        }
    }

    /// Real-PTY foreground detection: spawn an interactive shell, run `sleep`,
    /// and observe the reported basename transition shell → sleep → shell.
    #[tokio::test]
    async fn foreground_reports_transition_shell_to_sleep_and_back() {
        let fixture = WorkerFixture::launch().await;
        let mut conn = fixture.connect().await;
        expect_hello(&mut conn, "awaiting_start").await;

        // An interactive shell on the PTY runs with job control, so each command
        // becomes its own foreground process group — exactly the production
        // shell-first session shape.
        let spec = start_spec(&["/bin/sh", "-i"]);
        wire::write_json_frame(&mut conn, wire::T_START, &spec)
            .await
            .unwrap();
        let (frame_type, _) = read_frame(&mut conn).await;
        assert_eq!(frame_type, wire::T_STARTED);

        // The idle prompt's foreground group is the shell itself. The exact
        // basename is platform-dependent (`sh` via /proc comm on Linux, `bash`
        // via libproc on macOS where /bin/sh is bash), so capture it rather than
        // asserting a name.
        let (frame_type, payload) = loop {
            let frame = read_frame(&mut conn).await;
            if frame.0 == wire::T_FOREGROUND {
                break frame;
            }
        };
        assert_eq!(frame_type, wire::T_FOREGROUND);
        let shell = wire::decode_foreground(&payload)
            .expect("valid foreground frame")
            .to_string();
        assert_ne!(shell, "sleep");

        // `sleep` takes the foreground within one poll interval...
        wire::write_frame(&mut conn, wire::T_INPUT, b"set -m\nsleep 5\n")
            .await
            .unwrap();
        collect_foreground_until(&mut conn, "sleep").await;

        // ...and the shell reclaims it when the command exits.
        collect_foreground_until(&mut conn, &shell).await;

        wire::write_json_frame(
            &mut conn,
            wire::T_SHUTDOWN,
            &wire::Shutdown {
                signal: Some(wire::LifecycleSignal::Kill),
            },
        )
        .await
        .unwrap();
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

    /// Guards against the "garbled lines when scrolling" bug: replays are
    /// self-describing committed-line streams. The head geometry marker + history
    /// sentinel open the flowing-text history section (renderable at any width),
    /// and a second marker opens a self-contained repaint of the current screen
    /// at the current geometry — the only section for which geometry matters.
    #[tokio::test]
    async fn replay_is_a_sentineled_history_plus_current_screen() {
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

        // Opens with the CURRENT geometry (after the resize), the history
        // sentinel that tells clients to render flowing lines, not raw bytes,
        // and the return to ASCII that keeps those lines text (#61).
        let head = String::from_utf8_lossy(&spawnd::sessiond::scrollback::replay_head(120, 40))
            .into_owned();
        assert!(
            head.starts_with("\x1b[8;40;120t\x1b_sp:h1\x1b\\\x1b(B\x1b)B\x1b*B\x1b+B\x0f"),
            "head shape: {head:?}"
        );
        assert!(
            text.starts_with(&head),
            "replay must open with geometry marker + history sentinel + return to ASCII: {:?}",
            &text[..text.len().min(40)]
        );
        // Exactly one more marker separates history from the screen repaint.
        let markers: Vec<_> = text.match_indices("\x1b[8;40;120t").collect();
        assert_eq!(markers.len(), 2, "history and screen sections: {text:?}");
        let screen_at = markers[1].0;
        // The live screen still shows both lines (nothing scrolled off a 40-row
        // screen), so they appear in the screen section; nothing was committed
        // to history yet.
        let screen = &text[screen_at..];
        assert!(
            screen.contains("before-resize"),
            "screen repaint: {screen:?}"
        );
        assert!(
            screen.contains("after-resize"),
            "screen repaint: {screen:?}"
        );
    }

    /// The reconnect-seed regression: the RTC attach path requests replay with a
    /// fixed 64 KiB budget. When retained history outgrew the newest segment's
    /// share of that budget, replay used to fail closed — wedging every attach on
    /// "connecting" until the agent was restarted. A small budget must succeed
    /// with truncated history and a current screen.
    #[tokio::test]
    async fn small_budget_replay_succeeds_against_deep_history() {
        let fixture = WorkerFixture::launch().await;
        let mut conn = fixture.connect().await;
        expect_hello(&mut conn, "awaiting_start").await;

        // ~130 KB of committed lines — comfortably past a 64 KiB seed budget.
        let script = r#"
i=0; while [ $i -lt 1300 ]; do printf 'deep-%05d-%090d\n' "$i" 0; i=$((i+1)); done
printf 'FLOOD-END\n'
cat
"#;
        let spec = start_spec(&["/bin/sh", "-c", script]);
        wire::write_json_frame(&mut conn, wire::T_START, &spec)
            .await
            .unwrap();
        let (frame_type, _) = read_frame(&mut conn).await;
        assert_eq!(frame_type, wire::T_STARTED);
        collect_output_until(&mut conn, b"FLOOD-END").await;

        wire::write_frame(
            &mut conn,
            wire::T_REPLAY_REQ,
            &wire::encode_replay_req(64 * 1024),
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
                "seed-sized replay must not error (frame {frame_type})"
            );
        };
        let (_, bytes) = wire::decode_replay(&replay).unwrap();
        let text = String::from_utf8_lossy(bytes);
        // Newest history made it in; oldest was truncated to fit the budget.
        assert!(text.contains("deep-01299"), "newest history missing");
        assert!(!text.contains("deep-00000"), "budget was not applied");
        // The screen section still reconstructs the live screen.
        let mut replayed = spawnd::sessiond::emulator::Emulator::new(80, 24);
        replayed.feed(bytes);
        assert!(
            replayed.screen_text().join("\n").contains("FLOOD-END"),
            "screen repaint missing from small-budget replay"
        );
    }

    /// A scrollback wipe (`ESC[2J ESC[3J`, the claude/codex `/clear`) must
    /// actually destroy retained history: the replay afterwards contains no
    /// pre-clear content anywhere — not even in the screen section.
    #[tokio::test]
    async fn scrollback_wipe_erases_replayed_history() {
        let fixture = WorkerFixture::launch().await;
        let mut conn = fixture.connect().await;
        expect_hello(&mut conn, "awaiting_start").await;

        let script = r#"
i=0; while [ $i -lt 100 ]; do printf 'pre-clear-%04d\n' "$i"; i=$((i+1)); done
printf 'PRE-DONE\n'
read line
printf '\033[2J\033[3J\033[H'
printf 'POST-CLEAR-CONTENT\n'
cat
"#;
        let spec = start_spec(&["/bin/sh", "-c", script]);
        wire::write_json_frame(&mut conn, wire::T_START, &spec)
            .await
            .unwrap();
        let (frame_type, _) = read_frame(&mut conn).await;
        assert_eq!(frame_type, wire::T_STARTED);
        collect_output_until(&mut conn, b"PRE-DONE").await;

        // Pre-clear content must be replayable first.
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
            assert!(frame_type == wire::T_OUTPUT);
        };
        let (_, bytes) = wire::decode_replay(&replay).unwrap();
        let text = String::from_utf8_lossy(bytes);
        assert!(
            text.contains("pre-clear-0000"),
            "history must retain scrolled lines before the wipe"
        );

        // Trigger the clear and wait for post-clear output.
        wire::write_frame(&mut conn, wire::T_INPUT, b"go\n")
            .await
            .unwrap();
        collect_output_until(&mut conn, b"POST-CLEAR-CONTENT").await;

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
            assert!(frame_type == wire::T_OUTPUT);
        };
        let (_, bytes) = wire::decode_replay(&replay).unwrap();
        let text = String::from_utf8_lossy(bytes);
        assert!(
            !text.contains("pre-clear-"),
            "wiped history leaked into the replay"
        );
        assert!(
            text.contains("POST-CLEAR-CONTENT"),
            "post-clear screen missing from the replay"
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

    /// Committed-history delta streaming: nothing is emitted before the
    /// supervisor subscribes (old daemons would drop the connection on unknown
    /// frame types); once subscribed, every committed batch arrives with a
    /// contiguous (epoch, offset) chain, the replay switches to T_REPLAY2 whose
    /// anchor equals the chain's end, and the replayed history ends with exactly
    /// the streamed bytes. An `ED 3` wipe bumps the epoch and restarts offsets.
    #[tokio::test]
    async fn history_deltas_chain_match_replay_and_wipe_bumps_epoch() {
        let fixture = WorkerFixture::launch().await;
        let mut conn = fixture.connect().await;
        let hello = expect_hello(&mut conn, "awaiting_start").await;
        assert!(hello.history, "worker must advertise delta capability");

        // Scroll plenty of lines BEFORE subscribing; no history frames may appear.
        let spec = start_spec(&[
            "/bin/sh",
            "-c",
            "for i in $(seq 1 60); do echo unsub-$i; done; echo UNSUB-END; cat",
        ]);
        wire::write_json_frame(&mut conn, wire::T_START, &spec)
            .await
            .unwrap();
        let (frame_type, _) = read_frame(&mut conn).await;
        assert_eq!(frame_type, wire::T_STARTED);
        {
            let mut acc: Vec<u8> = Vec::new();
            while !acc.windows(9).any(|w| w == b"UNSUB-END") {
                let (frame_type, payload) = read_frame(&mut conn).await;
                assert_ne!(
                    frame_type,
                    wire::T_HISTORY,
                    "no deltas may be emitted before subscription"
                );
                assert_ne!(frame_type, wire::T_HISTORY_WIPE);
                if frame_type == wire::T_OUTPUT {
                    let (_, bytes) = wire::decode_output(&payload).unwrap();
                    acc.extend_from_slice(bytes);
                }
            }
        }

        // Subscribe, then push lines through `cat` so they scroll off and commit.
        wire::write_frame(&mut conn, wire::T_HISTORY_SUB, &[])
            .await
            .unwrap();
        for i in 0..50 {
            wire::write_frame(
                &mut conn,
                wire::T_INPUT,
                format!("delta-line-{i:03}\n").as_bytes(),
            )
            .await
            .unwrap();
        }
        wire::write_frame(&mut conn, wire::T_INPUT, b"DELTA-DONE\n")
            .await
            .unwrap();

        // Collect deltas until the last marker line has committed (it scrolls off
        // once enough lines follow it — push a few more to flush it through).
        for i in 0..30 {
            wire::write_frame(
                &mut conn,
                wire::T_INPUT,
                format!("flush-{i:02}\n").as_bytes(),
            )
            .await
            .unwrap();
        }
        let mut epoch: Option<u64> = None;
        let mut next_offset: Option<u64> = None;
        let mut delta_bytes: Vec<u8> = Vec::new();
        let deadline = tokio::time::Instant::now() + STEP_TIMEOUT;
        while !delta_bytes.windows(14).any(|w| w == b"delta-line-049") {
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out waiting for committed deltas; got {:?}",
                String::from_utf8_lossy(&delta_bytes)
            );
            let (frame_type, payload) = read_frame(&mut conn).await;
            if frame_type != wire::T_HISTORY {
                continue;
            }
            let (anchor, bytes) = wire::decode_history(&payload).unwrap();
            match epoch {
                None => epoch = Some(anchor.epoch),
                Some(existing) => assert_eq!(anchor.epoch, existing, "epoch drifted mid-stream"),
            }
            if let Some(expected) = next_offset {
                assert_eq!(
                    anchor.offset, expected,
                    "delta offsets must chain gaplessly"
                );
            }
            next_offset = Some(anchor.offset + bytes.len() as u64);
            delta_bytes.extend_from_slice(bytes);
        }

        // Quiesce, then capture a replay: T_REPLAY2 whose anchor continues the
        // chain and whose history section ends with exactly the streamed bytes.
        tokio::time::sleep(Duration::from_millis(300)).await;
        let mut tail_deltas = true;
        while tail_deltas {
            tail_deltas = false;
            wire::write_frame(
                &mut conn,
                wire::T_REPLAY_REQ,
                &wire::encode_replay_req(4 * 1024 * 1024),
            )
            .await
            .unwrap();
            let payload = loop {
                let (frame_type, payload) = read_frame(&mut conn).await;
                match frame_type {
                    wire::T_REPLAY2 => break payload,
                    wire::T_REPLAY => panic!("subscribed replay must use T_REPLAY2"),
                    wire::T_HISTORY => {
                        let (anchor, bytes) = wire::decode_history(&payload).unwrap();
                        assert_eq!(Some(anchor.offset), next_offset.map(|_| anchor.offset));
                        next_offset = Some(anchor.offset + bytes.len() as u64);
                        delta_bytes.extend_from_slice(bytes);
                        tail_deltas = true;
                    }
                    _ => {}
                }
            };
            if tail_deltas {
                continue; // late commits interleaved; re-capture so anchors settle
            }
            let (_, anchor, bytes) = wire::decode_replay2(&payload).unwrap();
            assert_eq!(Some(anchor.epoch), epoch, "replay anchor epoch");
            assert_eq!(
                Some(anchor.offset),
                next_offset,
                "replay anchor must equal the delta chain's end"
            );
            let text = bytes.to_vec();
            let sentinel = spawnd::sessiond::scrollback::REPLAY_HISTORY_SENTINEL;
            let start = text
                .windows(sentinel.len())
                .position(|w| w == sentinel)
                .expect("history sentinel")
                + sentinel.len();
            let marker = b"\x1b[8;";
            let end = text[start..]
                .windows(marker.len())
                .position(|w| w == marker)
                .map(|p| start + p)
                .expect("second geometry marker");
            let history = &text[start..end];
            assert!(
            history.ends_with(&delta_bytes),
            "replayed history must end with the streamed delta bytes (history {} bytes, deltas {} bytes)",
            history.len(),
            delta_bytes.len()
        );
        }

        // ED 3 through the PTY (cat echoes the raw bytes): epoch bumps, offsets
        // restart, and post-wipe commits chain from zero.
        let old_epoch = epoch.unwrap();
        wire::write_frame(&mut conn, wire::T_INPUT, b"\x1b[3J\n")
            .await
            .unwrap();
        let deadline = tokio::time::Instant::now() + STEP_TIMEOUT;
        let new_epoch = loop {
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out waiting for history wipe"
            );
            let (frame_type, payload) = read_frame(&mut conn).await;
            if frame_type == wire::T_HISTORY_WIPE {
                break wire::decode_history_wipe(&payload).unwrap();
            }
        };
        assert_eq!(
            new_epoch,
            old_epoch.wrapping_add(1),
            "wipe must bump the epoch"
        );
        for i in 0..40 {
            wire::write_frame(
                &mut conn,
                wire::T_INPUT,
                format!("post-wipe-{i:02}\n").as_bytes(),
            )
            .await
            .unwrap();
        }
        let deadline = tokio::time::Instant::now() + STEP_TIMEOUT;
        let mut post_wipe_first: Option<wire::HistoryAnchor> = None;
        while post_wipe_first.is_none() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out waiting for post-wipe deltas"
            );
            let (frame_type, payload) = read_frame(&mut conn).await;
            if frame_type == wire::T_HISTORY {
                let (anchor, _) = wire::decode_history(&payload).unwrap();
                post_wipe_first = Some(anchor);
            }
        }
        let anchor = post_wipe_first.unwrap();
        assert_eq!(anchor.epoch, new_epoch);
        assert_eq!(anchor.offset, 0, "offsets restart after a wipe");
    }
}

#[cfg(windows)]
mod windows {
    use std::collections::BTreeMap;
    use std::ffi::{OsStr, OsString};
    use std::os::windows::ffi::OsStringExt;
    use std::path::Path;
    use std::time::Duration;

    use spawnd::sessiond::{endpoint, wire, worker};
    use uuid::Uuid;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    const WORKER_BIN: &str = env!("CARGO_BIN_EXE_spawn-worker");
    const STEP_TIMEOUT: Duration = Duration::from_secs(15);

    fn direct_child_process_names(parent_pid: u32) -> Vec<OsString> {
        // SAFETY: the snapshot has no borrowed inputs and is closed below.
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        assert_ne!(
            snapshot,
            INVALID_HANDLE_VALUE,
            "creating process snapshot failed: {}",
            std::io::Error::last_os_error()
        );

        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        // SAFETY: `entry` has the documented size and remains live for the
        // complete enumeration; `snapshot` is a live process snapshot.
        let mut has_entry = unsafe { Process32FirstW(snapshot, &mut entry) };
        if has_entry == 0 {
            let error = std::io::Error::last_os_error();
            // SAFETY: `snapshot` is owned by this function and still live.
            unsafe { CloseHandle(snapshot) };
            panic!("reading process snapshot failed: {error}");
        }

        let mut names = Vec::new();
        while has_entry != 0 {
            if entry.th32ParentProcessID == parent_pid {
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|unit| *unit == 0)
                    .unwrap_or(entry.szExeFile.len());
                names.push(OsString::from_wide(&entry.szExeFile[..end]));
            }
            // SAFETY: same initialized entry and live snapshot as above.
            has_entry = unsafe { Process32NextW(snapshot, &mut entry) };
        }
        // SAFETY: `snapshot` is owned by this function and closed exactly once.
        unsafe { CloseHandle(snapshot) };
        names
    }

    fn test_runner_denied_worker_breakaway(error: &anyhow::Error) -> bool {
        let breakaway_denied = error
            .chain()
            .any(|cause| cause.to_string() == "worker breakaway launch was denied");
        let access_denied = error.chain().any(|cause| {
            cause.downcast_ref::<std::io::Error>().is_some_and(|error| {
                error.raw_os_error()
                    == Some(windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED as i32)
            })
        });
        breakaway_denied && access_denied
    }

    async fn read_frame(stream: &mut endpoint::SupervisorSideStream) -> (u8, Vec<u8>) {
        tokio::time::timeout(STEP_TIMEOUT, wire::read_frame(stream))
            .await
            .expect("timed out reading worker frame")
            .expect("worker frame read failed")
            .expect("worker endpoint closed")
    }

    async fn launch_and_connect(
        worker_dir: &Path,
        session_id: Uuid,
    ) -> anyhow::Result<(
        endpoint::SpawnedWorker,
        endpoint::Endpoint,
        endpoint::SupervisorSideStream,
    )> {
        let worker_endpoint = endpoint::endpoint_for(worker_dir, "", session_id).unwrap();
        let reservation = match endpoint::try_reserve(&worker_endpoint).unwrap() {
            endpoint::LockAttempt::Acquired(reservation) => reservation,
            endpoint::LockAttempt::Busy => panic!("new worker reservation was busy"),
        };
        let log_dir = worker_dir.join(format!("{session_id}.scrollback"));
        let args = vec![
            OsString::from("--pipe-name"),
            worker_endpoint.main_arg().to_os_string(),
            OsString::from("--session-id"),
            OsString::from(session_id.to_string()),
            OsString::from("--log-dir"),
            log_dir.as_os_str().to_os_string(),
            OsString::from("--metadata-dir"),
            worker_dir.as_os_str().to_os_string(),
            OsString::from("--reservation-handle"),
            OsString::from(reservation.raw_value().to_string()),
        ];
        let worker = endpoint::spawn_worker(Path::new(WORKER_BIN), &args, &reservation)?;
        drop(reservation);
        let stream =
            endpoint::connect_main(&worker_endpoint, tokio::time::Instant::now() + STEP_TIMEOUT)
                .await
                .unwrap();
        assert!(matches!(
            endpoint::try_reserve(&worker_endpoint).unwrap(),
            endpoint::LockAttempt::Busy
        ));
        Ok((worker, worker_endpoint, stream))
    }

    #[test]
    fn worker_cli_uses_pipe_and_reservation_handle_contract() {
        let args = [
            "--pipe-name",
            r"\\.\pipe\spawn-S-1-5-21-1-00000000-0000-0000-0000-000000000001",
            "--session-id",
            "00000000-0000-0000-0000-000000000001",
            "--log-dir",
            r"C:\spawn\workers\session.scrollback",
            "--metadata-dir",
            r"C:\spawn\state\instance\workers",
            "--reservation-handle",
            "256",
        ];
        let parsed = worker::parse_args(args.into_iter().map(str::to_owned)).unwrap();
        assert_eq!(parsed.session_id, Uuid::from_u128(1));
        assert_eq!(parsed.reservation_handle, Some(256));
    }

    #[test]
    fn endpoint_names_are_flat_and_reject_substitution() {
        let dir = tempfile::tempdir().unwrap();
        let protected = dir.path().join("workers");
        endpoint::ensure_private_dir(&protected).unwrap();
        let id = Uuid::new_v4();
        let expected = endpoint::endpoint_for(&protected, "-89abcdef", id).unwrap();
        let name = expected.main_arg().to_string_lossy();
        assert!(name.starts_with(r"\\.\pipe\spawn-S-"));
        assert!(!name[r"\\.\pipe\".len()..].contains('\\'));
        assert!(endpoint::endpoint_from_worker_arg(
            &protected,
            "-89abcdef",
            id,
            OsStr::new(r"\\.\pipe\substituted"),
        )
        .is_err());
    }

    #[tokio::test]
    async fn real_worker_runs_cmd_fixture_over_named_pipe_and_releases_reservation() {
        let temp = tempfile::tempdir().unwrap();
        let worker_dir = temp.path().join("workers");
        endpoint::ensure_private_dir(&worker_dir).unwrap();
        let script_dir = temp.path().join("Program Files").join("SPAWN D fixtures");
        std::fs::create_dir_all(&script_dir).unwrap();
        std::fs::write(
            script_dir.join("claude.cmd"),
            b"@echo off\r\necho batch-ok:%~1:%~2\r\n",
        )
        .unwrap();

        let session_id = Uuid::new_v4();
        let launched = launch_and_connect(&worker_dir, session_id).await;
        let (_worker, worker_endpoint, mut stream) = match launched {
            Ok(launched) => launched,
            Err(error) if test_runner_denied_worker_breakaway(&error) => {
                eprintln!(
                    "skipping real worker end-to-end case: the test runner job denies worker breakaway"
                );
                return;
            }
            Err(error) => panic!("launch worker fixture: {error:#}"),
        };
        let (frame_type, payload) = read_frame(&mut stream).await;
        assert_eq!(frame_type, wire::T_HELLO);
        let hello: wire::Hello = wire::decode_json(&payload).unwrap();
        assert_eq!(hello.session_id, session_id);
        assert_eq!(hello.state, "awaiting_start");

        let mut env: BTreeMap<String, String> = std::env::vars().collect();
        let mut search = vec![script_dir.clone()];
        if let Some(path) = std::env::var_os("PATH") {
            search.extend(std::env::split_paths(&path));
        }
        env.insert(
            "PATH".into(),
            std::env::join_paths(search)
                .unwrap()
                .to_string_lossy()
                .into_owned(),
        );
        env.insert("PATHEXT".into(), ".COM;.EXE;.BAT;.CMD".into());
        let spec = wire::StartSpec {
            cwd: temp.path().to_string_lossy().into_owned(),
            argv: vec!["claude".into(), "two words".into(), "a&b".into()],
            env,
            cols: 80,
            rows: 24,
        };
        wire::write_json_frame(&mut stream, wire::T_START, &spec)
            .await
            .unwrap();

        let mut output = Vec::new();
        let mut started = false;
        let exit = loop {
            let (frame_type, payload) = read_frame(&mut stream).await;
            match frame_type {
                wire::T_STARTED => {
                    let started_frame: wire::Started = wire::decode_json(&payload).unwrap();
                    assert!(started_frame.pid > 1);
                    started = true;
                }
                wire::T_OUTPUT => {
                    let (_, bytes) = wire::decode_output(&payload).unwrap();
                    output.extend_from_slice(bytes);
                }
                wire::T_EXIT => break wire::decode_json::<wire::ExitInfo>(&payload).unwrap(),
                wire::T_FOREGROUND => {}
                other => panic!("unexpected worker frame {other}"),
            }
        };
        assert!(started);
        assert_eq!(exit.exit_code, Some(0));
        let visible = String::from_utf8_lossy(&output);
        assert!(
            visible.contains("batch-ok:two words:a&b"),
            "batch output missing from {visible:?}"
        );

        let deadline = tokio::time::Instant::now() + STEP_TIMEOUT;
        loop {
            match endpoint::try_reserve(&worker_endpoint).unwrap() {
                endpoint::LockAttempt::Acquired(_) => break,
                endpoint::LockAttempt::Busy if tokio::time::Instant::now() < deadline => {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                endpoint::LockAttempt::Busy => panic!("worker retained reservation after exit"),
            }
        }
    }

    #[tokio::test]
    async fn real_worker_keeps_windows_powershell_interactive() {
        let temp = tempfile::tempdir().unwrap();
        let worker_dir = temp.path().join("workers");
        endpoint::ensure_private_dir(&worker_dir).unwrap();

        let session_id = Uuid::new_v4();
        let launched = launch_and_connect(&worker_dir, session_id).await;
        let (worker, _worker_endpoint, mut stream) = match launched {
            Ok(launched) => launched,
            Err(error) if test_runner_denied_worker_breakaway(&error) => {
                eprintln!(
                    "skipping real PowerShell end-to-end case: the test runner job denies worker breakaway"
                );
                return;
            }
            Err(error) => panic!("launch worker fixture: {error:#}"),
        };
        let (frame_type, payload) = read_frame(&mut stream).await;
        assert_eq!(frame_type, wire::T_HELLO);
        let hello: wire::Hello = wire::decode_json(&payload).unwrap();
        assert_eq!(hello.state, "awaiting_start");

        // Production's login-shell resolver sends a canonical verbatim path;
        // the worker must convert that identity-safe spelling at the final
        // CreateProcess boundary so Windows PowerShell stays alive in ConPTY.
        let powershell = std::fs::canonicalize(
            Path::new(&std::env::var_os("SystemRoot").unwrap())
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe"),
        )
        .unwrap();
        let spec = wire::StartSpec {
            cwd: temp.path().to_string_lossy().into_owned(),
            argv: vec![powershell.to_string_lossy().into_owned(), "-NoLogo".into()],
            env: std::env::vars().collect(),
            cols: 80,
            rows: 24,
        };
        wire::write_json_frame(&mut stream, wire::T_START, &spec)
            .await
            .unwrap();
        let (frame_type, payload) = read_frame(&mut stream).await;
        assert_eq!(frame_type, wire::T_STARTED);
        let started: wire::Started = wire::decode_json(&payload).unwrap();
        assert!(started.pid > 1);

        // CreatePseudoConsole intentionally starts one headless conhost for
        // the remote terminal. A second conhost is the worker's own classic
        // console, which briefly presents a local window during session.create.
        tokio::time::sleep(Duration::from_millis(100)).await;
        let children = direct_child_process_names(worker.pid);
        let console_hosts = children
            .iter()
            .filter(|name| name.eq_ignore_ascii_case(OsStr::new("conhost.exe")))
            .count();
        assert!(
            console_hosts <= 1,
            "detached worker created a classic console host beside ConPTY: {children:?}"
        );

        // Keep the marker split in the input so terminal echo cannot satisfy
        // the assertion; only PowerShell executing the command can join it.
        wire::write_frame(
            &mut stream,
            wire::T_INPUT,
            b"Write-Output ([string]::Concat('SPAWN-','POWERSHELL-ALIVE'))\r",
        )
        .await
        .unwrap();
        let mut output = Vec::new();
        while !output
            .windows(b"SPAWN-POWERSHELL-ALIVE".len())
            .any(|window| window == b"SPAWN-POWERSHELL-ALIVE")
        {
            let (frame_type, payload) = read_frame(&mut stream).await;
            match frame_type {
                wire::T_OUTPUT => {
                    let (_, bytes) = wire::decode_output(&payload).unwrap();
                    output.extend_from_slice(bytes);
                }
                wire::T_FOREGROUND => {}
                wire::T_EXIT => panic!(
                    "PowerShell exited before processing input: {:?}",
                    wire::decode_json::<wire::ExitInfo>(&payload).unwrap()
                ),
                other => panic!("unexpected worker frame {other}"),
            }
        }

        wire::write_frame(&mut stream, wire::T_INPUT, b"exit\r")
            .await
            .unwrap();
        loop {
            let (frame_type, payload) = read_frame(&mut stream).await;
            match frame_type {
                wire::T_EXIT => {
                    let exit: wire::ExitInfo = wire::decode_json(&payload).unwrap();
                    assert_eq!(exit.exit_code, Some(0));
                    break;
                }
                wire::T_OUTPUT | wire::T_FOREGROUND => {}
                other => panic!("unexpected worker frame {other}"),
            }
        }
    }
}
