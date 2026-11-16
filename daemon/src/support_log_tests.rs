//! Tests for `support_log.rs`, kept apart so the module itself stays free of
//! anything that lists a folder (scripts/check-support-log.sh).

use super::*;
use tracing_subscriber::layer::SubscriberExt;

fn read_lines(dir: &Path) -> Vec<serde_json::Value> {
    let mut lines = Vec::new();
    for name in [PREVIOUS, CURRENT] {
        if let Ok(text) = std::fs::read_to_string(dir.join(name)) {
            for line in text.lines() {
                lines.push(serde_json::from_str(line).expect("each line is JSON"));
            }
        }
    }
    lines
}

/// A sink for the stderr layer under test.
#[derive(Clone, Default)]
struct Sink(Arc<std::sync::Mutex<Vec<u8>>>);

impl io::Write for Sink {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn rust_log_trace_and_verbose_flags_do_not_widen_the_support_log() {
    let tmp = tempfile::tempdir().unwrap();
    let log = SupportLog::open_with(&tmp.path().join(DIR_NAME), 4096, true).unwrap();
    let sink = Sink::default();
    let writer = sink.clone();
    // The stderr layer as `RUST_LOG=trace` (or `-vv` and then some) makes
    // it, composed the way main.rs composes it.
    let stderr = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .with_filter(tracing_subscriber::EnvFilter::new("trace"));
    let subscriber = tracing_subscriber::registry()
        .with(stderr)
        .with(log.layer());
    tracing::subscriber::with_default(subscriber, || {
        tracing::trace!(target: "spawnd::rtc", "spawnd-trace");
        tracing::debug!(target: "spawnd::rtc", "spawnd-debug");
        tracing::info!(target: "spawnd::rtc", "spawnd-info");
        tracing::trace!(target: "tungstenite::protocol", "tungstenite-trace");
        tracing::debug!(target: "tungstenite::protocol", "tungstenite-debug");
        tracing::info!(target: "tungstenite::protocol", "tungstenite-info");
        tracing::warn!(target: "tungstenite::protocol", "tungstenite-warn");
        tracing::trace!(target: "spawnd_lookalike", "lookalike-trace");
        tracing::info!(target: "spawnd_lookalike", "lookalike-info");
        let span = tracing::info_span!(target: "spawnd::run", "the-span-name", peer = "span-field");
        let _entered = span.enter();
        tracing::info!(target: "spawnd::run", "inside-a-span");
    });
    assert!(log.flush(Duration::from_secs(10)));
    let stderr = String::from_utf8(sink.0.lock().unwrap().clone()).unwrap();
    assert!(stderr.contains("spawnd-trace") && stderr.contains("tungstenite-trace"));
    let messages: Vec<String> = read_lines(log.dir())
        .iter()
        .map(|line| line["msg"].as_str().unwrap().to_string())
        .collect();
    let mut expected = vec!["spawnd-info", "tungstenite-warn", "inside-a-span"];
    if crate::version::DIAGNOSTICS_BUILD {
        expected.insert(0, "spawnd-debug");
    }
    assert_eq!(messages, expected);
    let raw = std::fs::read_to_string(log.dir().join(CURRENT)).unwrap();
    assert!(!raw.contains("span-field"), "a span field reached the log");
    assert!(!raw.contains("the-span-name"), "a span reached the log");
}

#[test]
fn log_crate_records_are_capped_at_warn_by_their_own_target() {
    let tmp = tempfile::tempdir().unwrap();
    let log = SupportLog::open_with(&tmp.path().join(DIR_NAME), 4096, true).unwrap();
    let subscriber = tracing_subscriber::registry().with(log.layer());
    let dispatch = tracing::Dispatch::new(subscriber);
    // What tracing-log does with a `log` record: ask about the record's
    // own metadata, then dispatch it on the per-level callsite.
    tracing::dispatcher::with_default(&dispatch, || {
        for (level, text) in [
            (tracing_log::log::Level::Debug, "webrtc-debug"),
            (tracing_log::log::Level::Info, "webrtc-info"),
            (tracing_log::log::Level::Warn, "webrtc-warn"),
        ] {
            tracing_log::format_trace(
                &tracing_log::log::Record::builder()
                    .args(format_args!("{text}"))
                    .level(level)
                    .target("webrtc_ice::agent")
                    .file(Some("src/agent/mod.rs"))
                    .line(Some(7))
                    .build(),
            )
            .unwrap();
        }
    });
    assert!(log.flush(Duration::from_secs(10)));
    let lines = read_lines(log.dir());
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!(lines[0]["msg"], "webrtc-warn");
    assert_eq!(lines[0]["target"], "webrtc_ice::agent");
    assert_eq!(lines[0]["at"], "src/agent/mod.rs:7");
    assert_eq!(lines[0]["fields"], serde_json::json!({}));
}

#[test]
fn withheld_fields_are_never_formatted_and_numbers_pass() {
    struct Explodes;
    impl fmt::Debug for Explodes {
        fn fmt(&self, _: &mut fmt::Formatter<'_>) -> fmt::Result {
            panic!("a withheld value was formatted");
        }
    }
    let tmp = tempfile::tempdir().unwrap();
    let log = SupportLog::open_with(&tmp.path().join(DIR_NAME), 4096, true).unwrap();
    let subscriber = tracing_subscriber::registry().with(log.layer());
    tracing::subscriber::with_default(subscriber, || {
        tracing::info!(
            target: "spawnd::run",
            sdp = "v=0 o=- secret-sdp",
            offer_sdp = ?Explodes,
            refresh_token = %"tok-123",
            skills = ?vec!["my-skill"],
            stdin_error = "typed-into-stdin",
            bytes = 1234u64,
            input_len = 5i64,
            data = true,
            ratio = 0.5f64,
            session_id = "4b1c2d3e",
            "withheld"
        );
        tracing::info!(target: "spawnd::run", raw = &b"typed-bytes"[..], "bytes");
    });
    assert!(log.flush(Duration::from_secs(10)));
    let lines = read_lines(log.dir());
    let fields = &lines[0]["fields"];
    for name in ["sdp", "offer_sdp", "refresh_token", "skills", "stdin_error"] {
        assert_eq!(fields[name], WITHHELD, "{name}");
    }
    assert_eq!(fields["bytes"], 1234);
    assert_eq!(fields["input_len"], 5);
    assert_eq!(fields["data"], true);
    assert_eq!(fields["ratio"], 0.5);
    assert_eq!(fields["session_id"], "4b1c2d3e");
    assert_eq!(lines[1]["fields"]["raw"], WITHHELD);
    let raw = std::fs::read_to_string(log.dir().join(CURRENT)).unwrap();
    for secret in [
        "secret-sdp",
        "tok-123",
        "my-skill",
        "typed-into-stdin",
        "typed-bytes",
    ] {
        assert!(!raw.contains(secret), "{secret}");
    }
}

#[test]
fn the_sanitizer_strips_controls_and_redacts_secrets() {
    // ANSI and control characters, including the worker's own APC marker.
    assert_eq!(
        sanitize(
            "\u{1b}[31mred\u{1b}[0m \u{1b}]0;title\u{7}ok \u{1b}_sp:h1\u{1b}\\done\u{0}\u{7f}"
        ),
        "red ok done"
    );
    assert_eq!(sanitize("a\nb\tc\r\u{9b}2Jd\u{202e}e"), "a b c de");
    // An unterminated string sequence swallows the rest, never shows it.
    assert_eq!(sanitize("before\u{1b}]52;c;Y2xpcGJvYXJk"), "before");
    // Truncation at 512 characters.
    let long = "é".repeat(600);
    let capped = sanitize(&long);
    assert_eq!(capped.chars().count(), 512);
    assert!(capped.ends_with('…'));
    // Bearer, whatever the case and separator.
    assert_eq!(
        sanitize("authorization: Bearer abc.DEF-123 rest"),
        "authorization: Bearer <redacted> rest"
    );
    assert_eq!(sanitize("bearer=xyz"), "bearer <redacted>");
    // A JWT, even one too short for the base64 rule.
    let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
    assert_eq!(
        sanitize(&format!("token {jwt} end")),
        "token <redacted> end"
    );
    // A long mixed base64 run; hex, plain words and paths pass.
    let b64 = "QWxhZGRpbjpvcGVuIHNlc2FtZQ9wYXNzd29yZDEyMzQ1Njc4OTA+/=";
    assert_eq!(sanitize(&format!("key {b64}")), "key <redacted>");
    let hex = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    assert_eq!(sanitize(hex), hex);
    let path = "/Users/Max1/Projects/spawn/daemon/src/run.rs";
    assert_eq!(sanitize(path), path);
    let words = "connection_reset_by_peer_while_reading_the_registered_frame";
    assert_eq!(sanitize(words), words);
    // KEY=VALUE with a secret-looking key, quoted or not; others pass.
    assert_eq!(
        sanitize("OPENAI_API_KEY=sk-live-1 GITHUB_TOKEN=\"gh p\" MODE=fast"),
        "OPENAI_API_KEY=<redacted> GITHUB_TOKEN=<redacted> MODE=fast"
    );
    assert_eq!(
        sanitize("password='hunter 2', user=me"),
        "password=<redacted>, user=me"
    );
    // URL userinfo, query strings and fragments.
    assert_eq!(
        sanitize("dial wss://user:pw@spawnd.example/api/ws?token=abc#frag failed"),
        "dial wss://<redacted>@spawnd.example/api/ws?<redacted> failed"
    );
    assert_eq!(
        sanitize("https://example.com/a/b#access_token=x"),
        "https://example.com/a/b#<redacted>"
    );
    // A task's join error carries the panic payload.
    assert_eq!(
        sanitize("task 7 panicked with message \"CANARY in payload\""),
        "task 7 panicked with message <withheld>"
    );
}

#[test]
fn field_names_match_whole_or_by_part() {
    for name in [
        "sdp",
        "offer_sdp",
        "access_token",
        "refresh_token",
        "tokens",
        "skills",
        "command_line",
        "stdin_error",
        "env.vars",
        "Payload",
        "candidate_type",
    ] {
        assert!(is_withheld(name), "{name}");
    }
    for name in [
        "session_id",
        "error",
        "path",
        "dir",
        "viewer_id",
        "operation",
    ] {
        assert!(!is_withheld(name), "{name}");
    }
}

#[test]
fn an_event_never_exceeds_two_kib() {
    let fields: Vec<(&'static str, FieldValue)> = (0..20)
        .map(|_| ("value", FieldValue::Str("x".repeat(500))))
        .collect();
    let line = render_line(
        "t",
        "INFO",
        "spawnd::run",
        "src/run.rs:1",
        &"m".repeat(512),
        fields,
    );
    assert!(line.len() <= MAX_EVENT_BYTES + 1, "{}", line.len());
    let value: serde_json::Value = serde_json::from_slice(&line).unwrap();
    assert_eq!(value["truncated"], true);
    assert_eq!(value["msg"].as_str().unwrap().len(), 512);
}

#[test]
fn timestamps_round_trip_and_sort_as_text() {
    let earlier = rfc3339_millis(1_763_251_200_123);
    let later = rfc3339_millis(1_763_251_200_124);
    assert_eq!(earlier, "2025-11-16T00:00:00.123Z");
    assert!(earlier < later);
    assert_eq!(parse_rfc3339_millis(&earlier), Some(1_763_251_200_123));
    assert_eq!(parse_rfc3339_millis("2025-11-16T00:00:00Z"), None);
}

fn fill(store: &Store, lines: usize, width: usize, tag: &str) {
    for index in 0..lines {
        let line = render_line(
            &rfc3339_millis(1_000_000 + index as u64),
            "INFO",
            "spawnd::test",
            "src/support_log.rs:1",
            &format!("{tag}-{index:06} {}", "x".repeat(width)),
            Vec::new(),
        );
        store.append(&line).unwrap();
    }
}

#[test]
fn rotation_keeps_exactly_two_files_under_their_cap() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join(DIR_NAME);
    let store = Store::open(&path).unwrap();
    // About 2.2 files' worth of 1 KiB lines.
    fill(&store, 9_000, 1000, "line");
    let mut names: Vec<String> = std::fs::read_dir(&path)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names, [CURRENT, PREVIOUS, LOCK]);
    for name in [CURRENT, PREVIOUS] {
        let len = std::fs::metadata(path.join(name)).unwrap().len();
        assert!(len <= MAX_FILE_BYTES, "{name}: {len}");
        let text = std::fs::read_to_string(path.join(name)).unwrap();
        assert!(text.ends_with('\n') && text.lines().all(|l| l.starts_with("{\"t\":")));
    }
    let newest = std::fs::read_to_string(path.join(CURRENT)).unwrap();
    assert!(
        newest
            .trim_end()
            .ends_with("line-008999 ".to_string().as_str())
            || newest.contains("line-008999")
    );
}

#[cfg(unix)]
#[test]
fn neither_path_is_ever_followed_through_a_link() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join(DIR_NAME);
    let elsewhere = tmp.path().join("elsewhere.txt");
    std::fs::write(&elsewhere, "not the log\n").unwrap();
    let store = Store::open(&path).unwrap();
    std::os::unix::fs::symlink(&elsewhere, path.join(CURRENT)).unwrap();
    assert!(store.append(b"{\"t\":\"x\"}\n").is_err());
    assert_eq!(
        std::fs::read_to_string(&elsewhere).unwrap(),
        "not the log\n"
    );
    // The reader refuses a link at either name.
    assert!(read_window(&path, "x", 0, i64::MAX, 1 << 20).is_err());
    std::fs::remove_file(path.join(CURRENT)).unwrap();
    std::os::unix::fs::symlink(&elsewhere, path.join(PREVIOUS)).unwrap();
    assert!(read_window(&path, "x", 0, i64::MAX, 1 << 20).is_err());
    // A link in place of the folder itself is refused too.
    let linked = tmp.path().join("linked");
    std::os::unix::fs::symlink(tmp.path(), &linked).unwrap();
    assert!(Store::open(&linked).is_err());
}

#[test]
fn a_full_channel_drops_and_counts_and_never_waits() {
    const EVENTS: usize = 2_000;
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join(DIR_NAME);
    // Stand in for a disk that does not answer: hold the cross-process lock
    // the writer takes for every append, through a second handle. If an
    // event waited for the writer, this test would never finish.
    let store = Store::open(&path).unwrap();
    store.lock.lock().unwrap();
    let log = SupportLog::open_with(&path, 4, false).unwrap();
    let subscriber = tracing_subscriber::registry().with(log.layer());
    tracing::subscriber::with_default(subscriber, || {
        for index in 0..EVENTS {
            tracing::info!(target: "spawnd::run", index, "event");
        }
    });
    // The writer holds at most one batch (64 KiB, a few hundred of these
    // lines) and the channel four more; everything else was dropped.
    let dropped = log.dropped();
    assert!(dropped >= 1_000, "{dropped}");
    store.lock.unlock().unwrap();
    // Once the writer moves again, everything it had is written and it
    // says how many it lost.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !log.flush(Duration::from_millis(100)) {
        assert!(
            std::time::Instant::now() < deadline,
            "the writer never resumed"
        );
    }
    let written = read_lines(&path)
        .iter()
        .filter(|line| line["msg"] == "event")
        .count();
    assert_eq!(written as u64 + dropped, EVENTS as u64);
    let bundle = read_window(&path, "x", 0, i64::MAX / 2, 1 << 30).unwrap();
    assert_eq!(bundle.header.dropped_events, dropped);
}

#[test]
fn the_reader_takes_its_window_newest_first_and_names_only_two_files() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join(DIR_NAME);
    let store = Store::open(&path).unwrap();
    fill(&store, 5_000, 1000, "line");
    // Things that must never be read through it, beside the two files.
    for decoy in [
        "support.jsonl.2",
        "seg-00000001.log",
        "x.replay",
        "support.log",
    ] {
        std::fs::write(
            path.join(decoy),
            format!(
                "{{\"t\":\"{}\",\"msg\":\"DECOY\"}}\n",
                rfc3339_millis(1_000_100)
            ),
        )
        .unwrap();
    }
    let from = 1_000_000 + 4_000;
    let to = 1_000_000 + 4_099;
    let all = read_window(&path, "abcd1234", from, to, 1 << 20).unwrap();
    assert_eq!(all.lines.len(), 100);
    assert!(!all.header.truncated);
    assert!(all.lines[0].contains("line-004000"));
    assert!(all.lines[99].contains("line-004099"));
    // Spanning both files, oldest first.
    let spanning = read_window(&path, "abcd1234", 1_000_000, to, 1 << 30).unwrap();
    assert!(spanning.lines.windows(2).all(|pair| pair[0] < pair[1]));
    assert!(spanning.lines.iter().all(|line| !line.contains("DECOY")));
    // A byte cap keeps the newest.
    let capped = read_window(&path, "abcd1234", from, to, 10 * 1100).unwrap();
    assert!(capped.header.truncated);
    assert!(capped.header.bytes <= 10 * 1100);
    assert_eq!(capped.lines.len(), capped.header.lines);
    assert!(capped.lines.last().unwrap().contains("line-004099"));
    assert_eq!(capped.header.instance, "abcd1234");
    assert_eq!(capped.header.kind, "spawnd-support-log");
    assert_eq!(capped.header.os, std::env::consts::OS);
    assert_eq!(
        capped.header.variant,
        if crate::version::DIAGNOSTICS_BUILD {
            "diagnostics"
        } else {
            "release"
        }
    );
    // A missing folder is an empty bundle, not an error.
    let missing = read_window(&tmp.path().join("none"), "x", 0, i64::MAX, 1 << 20).unwrap();
    assert!(missing.lines.is_empty());
}

#[test]
fn a_panic_records_where_and_which_thread_never_the_payload() {
    let capture = capture::global();
    let canary = format!("CANARY-{}", uuid::Uuid::new_v4());
    let payload = canary.clone();
    let thread = format!("support-panic-{}", uuid::Uuid::new_v4().simple());
    let joined = std::thread::Builder::new()
        .name(thread.clone())
        .spawn(move || {
            // An `unwrap()` on an `Err` puts the error's value in the payload.
            let error: Result<(), String> = std::hint::black_box(Err(payload));
            error.unwrap();
        })
        .unwrap()
        .join();
    assert!(joined.is_err());
    let contents = capture.contents();
    let record = contents
        .lines()
        .find(|line| line.contains(&thread))
        .expect("the panic was recorded");
    let record: serde_json::Value = serde_json::from_str(record).unwrap();
    assert_eq!(record["target"], "spawnd::panic");
    assert_eq!(record["level"], "ERROR");
    assert!(record["at"]
        .as_str()
        .unwrap()
        .contains("support_log_tests.rs:"));
    capture::assert_absent(&contents, &canary, "the support log");
    capture::assert_absent(&capture.bundle(), &canary, "the bundle");
}
