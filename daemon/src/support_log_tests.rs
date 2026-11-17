//! Tests for `support_log.rs`, kept apart so the module itself stays free of
//! anything that lists a folder (scripts/check-support-log.sh).

use super::*;
use tracing_subscriber::layer::SubscriberExt;

fn read_lines(dir: &Path) -> Vec<serde_json::Value> {
    let mut lines = Vec::new();
    for name in [PREVIOUS, CURRENT] {
        if let Ok(text) = std::fs::read_to_string(dir.join(name)) {
            for line in text.lines() {
                let line: serde_json::Value =
                    serde_json::from_str(line).expect("each line is JSON");
                assert_eq!(line["build"], BUILD_ID);
                lines.push(line);
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
    let tmp = capture::private_tempdir();
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
    let lines = read_lines(log.dir());
    let mut targets = vec!["spawnd::rtc", "tungstenite::protocol", "spawnd::run"];
    if crate::version::DIAGNOSTICS_BUILD {
        targets.insert(0, "spawnd::rtc");
    }
    assert_eq!(
        lines
            .iter()
            .map(|line| line["target"].as_str().unwrap())
            .collect::<Vec<_>>(),
        targets
    );
    assert!(lines.iter().all(|line| line.get("msg").is_none()));
    let raw = std::fs::read_to_string(log.dir().join(CURRENT)).unwrap();
    assert!(!raw.contains("span-field"), "a span field reached the log");
    assert!(!raw.contains("the-span-name"), "a span reached the log");
}

#[test]
fn log_crate_records_are_capped_at_warn_by_their_own_target() {
    let tmp = capture::private_tempdir();
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
    assert!(lines[0].get("msg").is_none());
    assert_eq!(lines[0]["target"], "webrtc_ice::agent");
    assert_eq!(lines[0]["at"], "src/agent/mod.rs:7");
    assert!(lines[0].get("fields").is_none());
    assert_eq!(lines[0].as_object().unwrap().len(), 5);
}

#[test]
fn withheld_fields_cover_every_type_and_safe_counters_pass() {
    struct Explodes;
    impl fmt::Debug for Explodes {
        fn fmt(&self, _: &mut fmt::Formatter<'_>) -> fmt::Result {
            panic!("a withheld value was formatted");
        }
    }
    let tmp = capture::private_tempdir();
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
            token = 123u128,
            env = -123i128,
            secret = 1.5f64,
            count = 1234u64,
            length = 5i64,
            active = true,
            elapsed_secs = 0.5f64,
            session_id = "4b1c2d3e",
            "withheld"
        );
        tracing::info!(target: "spawnd::run", raw = &b"typed-bytes"[..], "bytes");
    });
    assert!(log.flush(Duration::from_secs(10)));
    let lines = read_lines(log.dir());
    let fields = &lines[0]["fields"];
    for name in [
        "sdp",
        "offer_sdp",
        "refresh_token",
        "skills",
        "stdin_error",
        "bytes",
        "input_len",
        "data",
        "token",
        "env",
        "secret",
    ] {
        assert_eq!(fields[name], WITHHELD, "{name}");
    }
    assert_eq!(fields["count"], 1234);
    assert_eq!(fields["length"], 5);
    assert_eq!(fields["active"], true);
    assert_eq!(fields["elapsed_secs"], 0.5);
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
    let path = "/tmp/projects/daemon/src/run.rs";
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
fn unknown_names_and_error_sites_are_closed_by_default() {
    let policy: Policy = serde_json::from_str(include_str!("support_log_policy.json")).unwrap();
    assert!(!policy.fields.contains_key("future_field"));
    assert_eq!(policy.fields["error"].kind, "withheld");
    assert_eq!(policy.fields["session_id"].kind, "id");
    assert_eq!(policy.fields["replay_bytes"].kind, "scalar");
}

#[test]
fn invalid_policy_is_cached_closed_with_one_internal_marker() {
    static CACHE: OnceLock<Policy> = OnceLock::new();
    struct MustNotFormat;
    impl fmt::Debug for MustNotFormat {
        fn fmt(&self, _: &mut fmt::Formatter<'_>) -> fmt::Result {
            panic!("invalid policy admitted a formatter");
        }
    }
    let tmp = capture::private_tempdir();
    let log = SupportLog::open_with(&tmp.path().join(DIR_NAME), 32, true).unwrap();
    let closed = cached_policy(&CACHE, "malformed policy", &log);
    // Even a later valid input cannot retry initialization or admit anything.
    let again = cached_policy(&CACHE, include_str!("support_log_policy.json"), &log);
    assert!(std::ptr::eq(closed, again));
    assert!(closed.fields.is_empty() && closed.error_sites.is_empty());
    let layer = SupportLayer {
        log: log.clone(),
        policy: closed,
    };
    tracing::subscriber::with_default(tracing_subscriber::registry().with(layer), || {
        tracing::warn!(path = ?MustNotFormat, count = 7, "first");
        tracing::warn!(error = ?MustNotFormat, reason = ?MustNotFormat, "second");
    });
    assert!(log.flush(Duration::from_secs(10)));
    assert_eq!(log.dropped(), 0);
    let lines = read_lines(log.dir());
    assert_eq!(lines.len(), 3);
    assert_eq!(
        lines[0]["msg"],
        "support log policy invalid; all fields withheld"
    );
    assert_eq!(lines[0]["level"], "ERROR");
    for line in &lines[1..] {
        assert!(line.get("msg").is_none());
        assert!(line["fields"]
            .as_object()
            .unwrap()
            .values()
            .all(|v| v == WITHHELD));
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
    let tmp = capture::private_tempdir();
    let path = tmp.path().join(DIR_NAME);
    let store = Store::open(&path).unwrap();
    // About 2.2 files' worth of 1 KiB lines.
    fill(&store, 9_000, 1000, "line");
    let mut names: Vec<String> = std::fs::read_dir(&path)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    let mut expected = vec![CURRENT, PREVIOUS, LOCK];
    expected.sort();
    assert_eq!(names, expected);
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
    let tmp = capture::private_tempdir();
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
    assert!(read_window(&path, "00000000", 0, i64::MAX, 1 << 20, None).is_err());
    std::fs::remove_file(path.join(CURRENT)).unwrap();
    std::os::unix::fs::symlink(&elsewhere, path.join(PREVIOUS)).unwrap();
    assert!(read_window(&path, "00000000", 0, i64::MAX, 1 << 20, None).is_err());
    // A link in place of the folder itself is refused too.
    let linked = tmp.path().join("linked");
    std::os::unix::fs::symlink(tmp.path(), &linked).unwrap();
    assert!(Store::open(&linked).is_err());
}

#[test]
fn a_full_channel_drops_and_counts_and_never_waits() {
    const EVENTS: usize = 2_000;
    let tmp = capture::private_tempdir();
    let path = tmp.path().join(DIR_NAME);
    // Stand in for a disk that does not answer: hold the cross-process lock
    // the writer takes for every append, through a second handle. If an
    // event waited for the writer, this test would never finish.
    let store = Store::open(&path).unwrap();
    let log = SupportLog::open_with(&path, 4, false).unwrap();
    store.lock.lock().unwrap();
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
    let (ack_tx, ack_rx) = mpsc::sync_channel(1);
    log.inner.tx.send(Message::Flush(ack_tx)).unwrap();
    assert!(ack_rx.recv().unwrap());
    let written = read_lines(&path)
        .iter()
        .filter(|line| line["target"] == "spawnd::run")
        .count();
    assert_eq!(written as u64 + dropped, EVENTS as u64);
    let bundle = read_window(&path, "00000000", 0, i64::MAX / 2, 1 << 30, None).unwrap();
    assert_eq!(bundle.header.dropped_events, dropped);
}

#[test]
fn the_reader_takes_its_window_newest_first_and_names_only_two_files() {
    let tmp = capture::private_tempdir();
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
    let all = read_window(&path, "abcd1234", from, to, 1 << 20, None).unwrap();
    assert_eq!(all.lines.len(), 100);
    assert!(!all.header.truncated);
    assert!(all.lines[0].contains("line-004000"));
    assert!(all.lines[99].contains("line-004099"));
    // Spanning both files, oldest first.
    let spanning = read_window(&path, "abcd1234", 1_000_000, to, 1 << 30, None).unwrap();
    assert!(spanning.lines.windows(2).all(|pair| pair[0] < pair[1]));
    assert!(spanning.lines.iter().all(|line| !line.contains("DECOY")));
    // A byte cap keeps the newest.
    let capped = read_window(&path, "abcd1234", from, to, 10 * 1100, None).unwrap();
    assert!(capped.header.truncated);
    assert!(capped.header.bytes <= 10 * 1100);
    assert_eq!(capped.lines.len(), capped.header.lines);
    assert!(capped.lines.last().unwrap().contains("line-004099"));
    assert_eq!(capped.header.instance, "abcd1234");
    assert_eq!(capped.header.kind, "spawnd-support-log");
    assert_eq!(capped.header.reader_version, crate::version::BUILD_VERSION);
    assert_eq!(capped.header.os, std::env::consts::OS);
    assert_eq!(
        capped.header.reader_variant,
        if crate::version::DIAGNOSTICS_BUILD {
            "diagnostics"
        } else {
            "normal"
        }
    );
    // A missing folder is an empty bundle, not an error.
    let missing = read_window(
        &tmp.path().join("none"),
        "00000000",
        0,
        i64::MAX,
        1 << 20,
        None,
    )
    .unwrap();
    assert!(missing.lines.is_empty());
}

#[test]
fn reader_preserves_each_producers_build_identity() {
    let tmp = capture::private_tempdir();
    let path = tmp.path().join(DIR_NAME);
    let store = Store::open(&path).unwrap();
    let current = render_line(
        "2026-01-01T00:00:00.000Z",
        "INFO",
        "spawnd",
        "src/main.rs:1",
        "",
        Vec::new(),
    );
    let mut older: serde_json::Value = serde_json::from_slice(&current).unwrap();
    older["build"] = "0.1.0+g000000000000/0000000000000000000000000000000000000000".into();
    let mut older_bytes = serde_json::to_vec(&older).unwrap();
    older_bytes.push(b'\n');
    store.append(&older_bytes).unwrap();
    store.append(&current).unwrap();
    let bundle = read_window(&path, "00000000", 0, i64::MAX, 4096, None).unwrap();
    assert_eq!(bundle.lines.len(), 2);
    let lines: Vec<serde_json::Value> = bundle
        .lines
        .iter()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines[0]["build"], older["build"]);
    assert_eq!(lines[1]["build"], BUILD_ID);
    let header = serde_json::to_value(bundle.header).unwrap();
    assert_eq!(header["reader_version"], crate::version::BUILD_VERSION);
    assert!(header.get("version").is_none());
}

#[test]
fn a_panic_records_location_and_runtime_thread_id_never_payload_or_name() {
    let capture = capture::global();
    let canary = crate::support_log::capture::canary();
    let payload = canary.clone();
    let thread = canary.clone();
    let joined = std::thread::Builder::new()
        .name(thread.clone())
        .spawn(move || {
            // An `unwrap()` on an `Err` puts the error's value in the payload.
            let error: Result<(), String> = std::hint::black_box(Err(payload));
            error.unwrap();
        })
        .unwrap();
    let thread_id = format!("{:?}", joined.thread().id());
    let joined = joined.join();
    assert!(joined.is_err());
    let contents = capture.contents();
    let record = contents
        .lines()
        .find(|line| line.contains(&thread_id))
        .expect("the panic was recorded");
    let record: serde_json::Value = serde_json::from_str(record).unwrap();
    assert_eq!(record["target"], "spawnd::panic");
    assert_eq!(record["level"], "ERROR");
    assert_eq!(record["build"], BUILD_ID);
    assert!(record["at"]
        .as_str()
        .unwrap()
        .contains("support_log_tests.rs:"));
    capture::assert_absent(&contents, &canary, "the support log");
    capture::assert_absent(&capture.bundle(), &canary, "the bundle");
}

#[test]
fn url_redaction_consumes_all_parameters_and_userinfo_punctuation() {
    for url in [
        "https://host/?a=one&code=short-secret&next=two#fragment",
        "https://host/?a=one;code=short-secret,next=two#fragment",
        "https://host/?code=short-secret'next&x=y",
    ] {
        assert_eq!(sanitize(url), "https://host/?<redacted>");
    }
    for userinfo in ["user,pw;secret", "user:pw&secret", "user'pw(secret)"] {
        assert_eq!(
            sanitize(&format!(
                "https://{userinfo}@host/path?a=1&code=secret done"
            )),
            "https://<redacted>@host/path?<redacted> done"
        );
    }
    assert_eq!(
        sanitize("https://[::1]/#one,two;three&four"),
        "https://[::1]/#<redacted>"
    );
    assert_eq!(
        sanitize("\"https://host/?a=one&code=secret\" next"),
        "\"https://host/?<redacted>\" next"
    );
}

#[test]
fn input_is_bounded_before_scanning_and_incomplete_tokens_are_discarded() {
    // The helper returns a borrowed slice within the cap, independent of the
    // suffix. This checks the work bound structurally, without a timing test.
    let prefix = "ready ".repeat(MAX_RAW_VALUE_BYTES / 6);
    let a = format!("{prefix}unfinished{}", "x".repeat(MAX_RAW_VALUE_BYTES));
    let b = format!(
        "{prefix}unfinished{}",
        "secret ".repeat(MAX_RAW_VALUE_BYTES)
    );
    let (bounded, cut) = bounded_input(&a);
    assert!(cut && bounded.len() <= MAX_RAW_VALUE_BYTES);
    assert_eq!(bounded.as_ptr(), a.as_ptr());
    assert!(!bounded.contains("unfinished"));
    assert_eq!(sanitize(&a), sanitize(&b));
    assert_eq!(sanitize(&"é".repeat(MAX_RAW_VALUE_BYTES)), "…");
    let repeated = "bearer".repeat(64);
    assert_eq!(sanitize(&repeated), repeated);
    assert_eq!(
        sanitize("JoinError::Panic(Id(1), \"short private note\", ...)"),
        "JoinError::Panic( <withheld>"
    );
}

#[test]
fn a_panicking_debug_value_drops_one_event_and_the_layer_continues() {
    struct Panics;
    impl fmt::Debug for Panics {
        fn fmt(&self, _: &mut fmt::Formatter<'_>) -> fmt::Result {
            panic!("formatter panic");
        }
    }
    let tmp = capture::private_tempdir();
    let log = SupportLog::open(&tmp.path().join(DIR_NAME)).unwrap();
    tracing::subscriber::with_default(tracing_subscriber::registry().with(log.layer()), || {
        tracing::warn!(path = ?Panics, "broken formatter");
        tracing::warn!("after formatter panic");
    });
    assert!(log.flush(Duration::from_secs(10)));
    assert_eq!(log.dropped(), 1);
    let lines: Vec<_> = read_lines(log.dir())
        .into_iter()
        .filter(|line| line["target"] != DROPPED_TARGET)
        .collect();
    assert_eq!(lines.len(), 1);
    assert!(lines[0].get("msg").is_none());
}

#[test]
fn saturation_does_not_visit_fields() {
    struct MustNotFormat<'a>(&'a Cell<bool>);
    impl fmt::Debug for MustNotFormat<'_> {
        fn fmt(&self, _: &mut fmt::Formatter<'_>) -> fmt::Result {
            self.0.set(true);
            panic!("full queue formatted a field");
        }
    }
    let tmp = capture::private_tempdir();
    let log = SupportLog::open_with(&tmp.path().join(DIR_NAME), 1, false).unwrap();
    let permit = log.reserve().unwrap();
    let formatted = Cell::new(false);
    tracing::subscriber::with_default(tracing_subscriber::registry().with(log.layer()), || {
        tracing::warn!(path = ?MustNotFormat(&formatted), "saturated");
    });
    assert!(!formatted.get());
    assert_eq!(log.dropped(), 1);
    drop(permit);
    assert!(log.reserve().is_some());
}

#[cfg(unix)]
#[test]
fn support_and_parent_symlinks_never_change_target_permissions() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let tmp = capture::private_tempdir();
    let target = tmp.path().join("target");
    std::fs::create_dir(&target).unwrap();
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o751)).unwrap();
    let support = tmp.path().join(DIR_NAME);
    symlink(&target, &support).unwrap();
    assert!(Store::open(&support).is_err());
    assert_eq!(
        std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
        0o751
    );
    let parent_link = tmp.path().join("parent-link");
    symlink(&target, &parent_link).unwrap();
    assert!(Store::open(&parent_link.join(DIR_NAME)).is_err());
    assert_eq!(
        std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
        0o751
    );
    assert!(!target.join(DIR_NAME).exists());
    // Earlier ancestors are trusted, and may be links (e.g. the OS home root).
    let parent = target.join("instance");
    std::fs::create_dir(&parent).unwrap();
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700)).unwrap();
    let store = Store::open(&parent_link.join("instance").join(DIR_NAME)).unwrap();
    store.append(b"{}\n").unwrap();
    assert!(parent.join(DIR_NAME).join(CURRENT).exists());
    assert_eq!(
        std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
        0o751
    );
}

#[test]
fn flush_reports_failed_writes_then_recovers() {
    let tmp = capture::private_tempdir();
    let path = tmp.path().join(DIR_NAME);
    let log = SupportLog::open(&path).unwrap();
    std::fs::create_dir(path.join(CURRENT)).unwrap();
    log.push(b"{}\n".to_vec());
    assert!(
        !log.flush(Duration::from_secs(10)),
        "a lost batch was acknowledged as written"
    );
    assert_eq!(log.dropped(), 1);
    std::fs::remove_dir(path.join(CURRENT)).unwrap();
    log.push(b"{}\n".to_vec());
    assert!(log.flush(Duration::from_secs(10)));
    assert!(std::fs::read_to_string(path.join(CURRENT))
        .unwrap()
        .lines()
        .all(|line| serde_json::from_str::<serde_json::Value>(line).is_ok()));
}

#[test]
fn partial_writes_roll_back_and_interrupted_tails_are_repaired() {
    let tmp = capture::private_tempdir();
    let store = Store::open(&tmp.path().join(DIR_NAME)).unwrap();
    store.append(b"{\"first\":true}\n").unwrap();
    let mut file = open_or_create(&store.dir, CURRENT).unwrap();
    let error = append_transaction(&mut file, b"{\"second\":true}\n", |file, bytes| {
        file.write_all(&bytes[..5])?;
        Err(io::Error::other("injected partial write"))
    });
    assert!(error.is_err());
    assert_eq!(
        file.metadata().unwrap().len(),
        b"{\"first\":true}\n".len() as u64
    );
    file.seek(SeekFrom::End(0)).unwrap();
    file.write_all(b"{\"torn\"").unwrap();
    store.append(b"{\"third\":true}\n").unwrap();
    file.seek(SeekFrom::Start(0)).unwrap();
    let mut contents = String::new();
    file.read_to_string(&mut contents).unwrap();
    assert_eq!(contents, "{\"first\":true}\n{\"third\":true}\n");
}

#[test]
fn legacy_history_is_discarded_and_cannot_enter_the_new_pair() {
    let tmp = capture::private_tempdir();
    let path = tmp.path().join(DIR_NAME);
    let store = Store::open(&path).unwrap();
    for name in [
        "support.jsonl",
        "support.jsonl.1",
        "support-v2.jsonl",
        "support-v2.jsonl.1",
    ] {
        std::fs::write(path.join(name), "unsafe older history\n").unwrap();
    }
    drop(store);
    let store = Store::open(&path).unwrap();
    for name in [
        "support.jsonl",
        "support.jsonl.1",
        "support-v2.jsonl",
        "support-v2.jsonl.1",
    ] {
        assert!(!path.join(name).exists());
    }
    fill(&store, 1, 10, "safe");
    // An overlapping old process can recreate its files, never the new pair.
    std::fs::write(path.join("support.jsonl"), "unsafe older history\n").unwrap();
    let bundle = read_window(&path, "00000000", 0, i64::MAX / 2, 1 << 20, None).unwrap();
    assert_eq!(bundle.lines.len(), 1);
    assert!(bundle.lines[0].contains("safe"));
    let _reopened = Store::open(&path).unwrap();
    assert_eq!(
        read_window(&path, "00000000", 0, i64::MAX / 2, 1 << 20, None)
            .unwrap()
            .lines,
        bundle.lines
    );
}

#[test]
fn dropping_the_last_handle_stops_the_writer() {
    let tmp = capture::private_tempdir();
    let log = SupportLog::open(&tmp.path().join(DIR_NAME)).unwrap();
    let stopped = log.inner.stopped.lock().unwrap().take().unwrap();
    log.push(b"{}\n".to_vec());
    drop(log);
    stopped.recv().expect("writer retained its sender");
    assert_eq!(
        std::fs::read_to_string(tmp.path().join(DIR_NAME).join(CURRENT)).unwrap(),
        "{}\n"
    );
}

#[test]
fn construction_withholds_dynamic_messages_unknown_fields_and_unlisted_errors() {
    struct MustNotFormat;
    impl fmt::Debug for MustNotFormat {
        fn fmt(&self, _: &mut fmt::Formatter<'_>) -> fmt::Result {
            panic!("unapproved formatter ran");
        }
    }
    let tmp = capture::private_tempdir();
    let log = SupportLog::open_with(&tmp.path().join(DIR_NAME), 32, true).unwrap();
    let marker = capture::canary();
    let sink = Sink::default();
    let writer = sink.clone();
    let stderr = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_writer(move || writer.clone());
    tracing::subscriber::with_default(
        tracing_subscriber::registry()
            .with(stderr)
            .with(log.layer()),
        || {
            tracing::warn!(target: "spawnd::run", "dynamic {}", marker);
            tracing::warn!(target: "spawnd::run", future_field = %marker, "static message");
            tracing::warn!(target: "webrtc_ice::agent", error = %marker, "peer {}", marker);
            tracing::warn!(target: "spawnd::run", error = %marker, "unlisted error");
            tracing::warn!(target: "spawnd::run", message = marker.as_str());
            // An admitted name cannot smuggle arbitrary text through its type rule.
            tracing::warn!(target: "spawnd::run", count = %marker, reason = %marker, session_id = %marker, "wrong types");
        },
    );
    assert!(
        String::from_utf8(sink.0.lock().unwrap().clone())
            .unwrap()
            .contains(&marker),
        "stderr lost its original detail"
    );
    // With no stderr formatter, no rejected Debug implementation is invoked.
    tracing::subscriber::with_default(tracing_subscriber::registry().with(log.layer()), || {
        tracing::warn!(target: "spawnd::run", future_field = ?MustNotFormat, error = ?MustNotFormat, "{:?}", MustNotFormat);
        tracing::warn!(target: "webrtc_turn", error = ?MustNotFormat, "{:?}", MustNotFormat);
        tracing::warn!(target: "spawnd::run", future_number = 42u64, future_boolean = true, "unknown scalar fields");
        tracing::warn!(target: "spawnd::run", reason = "worker replay barrier failed", count = 7u64, "incident category");
    });
    assert!(log.flush(Duration::from_secs(10)));
    assert_eq!(log.dropped(), 0);
    let written = std::fs::read_to_string(log.dir().join(CURRENT)).unwrap();
    capture::assert_absent(&written, &marker, "constructed log");
    let lines = read_lines(log.dir());
    assert_eq!(lines.len(), 10);
    for line in &lines {
        assert!(line.get("msg").is_none());
        if !is_spawnd(line["target"].as_str().unwrap()) {
            assert_eq!(line.as_object().unwrap().len(), 5);
        }
    }
    assert_eq!(lines[8]["fields"]["future_number"], WITHHELD);
    assert_eq!(lines[8]["fields"]["future_boolean"], WITHHELD);
    assert_eq!(lines[9]["fields"]["reason"], "worker replay barrier failed");
    assert_eq!(lines[9]["fields"]["count"], 7);
    // The log facade used by ICE/TURN must also leave arbitrary reasons out.
    let dispatch = tracing::Dispatch::new(tracing_subscriber::registry().with(log.layer()));
    tracing::dispatcher::with_default(&dispatch, || {
        tracing_log::format_trace(
            &tracing_log::log::Record::builder()
                .args(format_args!("peer reason: {marker}"))
                .level(tracing_log::log::Level::Warn)
                .target("webrtc_ice::agent")
                .file(Some("src/agent/mod.rs"))
                .line(Some(1))
                .build(),
        )
        .unwrap();
    });
    assert!(log.flush(Duration::from_secs(10)));
    let lines = read_lines(log.dir());
    assert_eq!(lines.last().unwrap().as_object().unwrap().len(), 5);
    capture::assert_absent(
        &std::fs::read_to_string(log.dir().join(CURRENT)).unwrap(),
        &marker,
        "log bridge",
    );
}

#[test]
fn startup_refuses_a_busy_lock_without_waiting_for_its_owner() {
    let tmp = capture::private_tempdir();
    let path = tmp.path().join(DIR_NAME);
    let store = Store::open(&path).unwrap();
    store.lock.lock().unwrap();
    // Completion is explicit; scheduler delays cannot be mistaken for lock
    // contention. The source guard also pins try_lock at startup.
    let (tx, rx) = mpsc::sync_channel(1);
    let attempt = std::thread::spawn(move || {
        tx.send(SupportLog::open(&path).is_err()).unwrap();
    });
    let result = rx.recv();
    store.lock.unlock().unwrap();
    attempt.join().unwrap();
    assert!(result.unwrap());
}

#[test]
fn the_real_worker_error_callsite_keeps_replay_io_but_withholds_other_causes() {
    let tmp = capture::private_tempdir();
    let log = SupportLog::open_with(&tmp.path().join(DIR_NAME), 32, true).unwrap();
    let marker = capture::canary();
    let error = "reading /tmp/history/seg-00000001.log: No such file or directory (os error 2)";
    let sink = Sink::default();
    let writer = sink.clone();
    let stderr = tracing_subscriber::fmt::layer()
        .without_time()
        .with_ansi(false)
        .with_writer(move || writer.clone());
    tracing::subscriber::with_default(
        tracing_subscriber::registry()
            .with(stderr)
            .with(log.layer()),
        || {
            crate::worker_backend::log_worker_error(uuid::Uuid::new_v4(), error);
            let session_id = uuid::Uuid::new_v4();
            crate::worker_backend::log_worker_error(session_id, &marker);
            // Master's exact WARN statement, with the same metadata and value.
            tracing::warn!(target: "spawnd::worker_backend", %session_id, message = %marker, "worker error");
        },
    );
    assert!(log.flush(Duration::from_secs(10)));
    let lines = read_lines(log.dir());
    if crate::version::DIAGNOSTICS_BUILD {
        assert_eq!(lines[0]["fields"]["error"], error);
        assert_eq!(lines.len(), 3);
    } else {
        assert_eq!(lines.len(), 2);
    }
    assert!(lines.last().unwrap()["fields"].get("message").is_none());
    assert!(lines.last().unwrap()["fields"].get("error").is_none());
    let stderr = String::from_utf8(sink.0.lock().unwrap().clone()).unwrap();
    assert!(stderr.contains(error) && stderr.contains(&marker));
    let stderr_lines: Vec<_> = stderr.lines().collect();
    assert_eq!(
        stderr_lines[stderr_lines.len() - 2],
        stderr_lines[stderr_lines.len() - 1]
    );
    capture::assert_absent(
        &std::fs::read_to_string(log.dir().join(CURRENT)).unwrap(),
        &marker,
        "worker error",
    );
}

#[test]
fn snapshot_orders_timestamps_then_append_order_and_skips_large_and_invalid_lines() {
    let tmp = capture::private_tempdir();
    let path = tmp.path().join(DIR_NAME);
    let store = Store::open(&path).unwrap();
    for (at, msg) in [
        (3000, "tie-first"),
        (1000, "old-small"),
        (3000, "tie-second"),
        (2000, "middle"),
    ] {
        store
            .append(&render_line(
                &rfc3339_millis(at),
                "INFO",
                "spawnd",
                "src/main.rs:1",
                msg,
                vec![],
            ))
            .unwrap();
    }
    store
        .append(&render_line(
            &rfc3339_millis(4000),
            "INFO",
            "spawnd",
            "src/main.rs:1",
            &"x".repeat(1500),
            vec![],
        ))
        .unwrap();
    store.append(b"invalid\n").unwrap();
    // Deliberately bypass tail repair for an interrupted final write.
    let mut file = open_or_create(&store.dir, CURRENT).unwrap();
    file.seek(SeekFrom::End(0)).unwrap();
    file.write_all(b"{\"t\":").unwrap();
    drop(file);
    let mut bundle = read_window(&path, "00000000", 0, 5000, 1600, None).unwrap();
    assert_eq!(bundle.header.invalid_lines, 2);
    assert!(bundle.header.truncated);
    assert!(bundle.encode().unwrap().len() <= 1600);
    let raw_bytes = bundle.encode().unwrap().len();
    assert_eq!(bundle.header.bytes, raw_bytes);
    assert!(!bundle.lines.iter().any(|l| l.contains(&"x".repeat(30))));
    assert!(bundle.lines[0].contains("old-small"));
    assert!(bundle.lines[1].contains("middle"));
    assert!(bundle.lines[2].contains("tie-first"));
    assert!(bundle.lines[3].contains("tie-second"));
    assert_eq!(bundle.header.from, Some(1000));
    assert_eq!(bundle.header.to, Some(3000));
}

#[test]
fn snapshot_rotation_and_concurrent_read_are_locked_on_every_platform() {
    let tmp = capture::private_tempdir();
    let path = tmp.path().join(DIR_NAME);
    let store = Store::open(&path).unwrap();
    store
        .append(&render_line(
            &rfc3339_millis(2000),
            "INFO",
            "spawnd",
            "src/main.rs:1",
            "previous",
            vec![],
        ))
        .unwrap();
    // Fill the remainder with invalid terminated lines without stressing a writer.
    let mut file = open_or_create(&store.dir, CURRENT).unwrap();
    let remaining = MAX_FILE_BYTES - file.metadata().unwrap().len();
    file.seek(SeekFrom::End(0)).unwrap();
    let mut padding = vec![b'x'; remaining as usize];
    *padding.last_mut().unwrap() = b'\n';
    file.write_all(&padding).unwrap();
    drop(file);
    let (locked_tx, locked_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let writer = std::thread::spawn(move || {
        store.lock.lock().unwrap();
        locked_tx.send(()).unwrap();
        release_rx.recv().unwrap();
        store
            .append_locked(&render_line(
                &rfc3339_millis(1000),
                "INFO",
                "spawnd",
                "src/main.rs:1",
                "current",
                vec![],
            ))
            .unwrap();
        store.lock.unlock().unwrap();
    });
    locked_rx.recv().unwrap();
    let busy = read_window(&path, "00000000", 0, 5000, 4096, None);
    release_tx.send(()).unwrap();
    writer.join().unwrap();
    assert!(
        busy.is_err(),
        "a snapshot must not race the writer's rotation"
    );
    let bundle = read_window(&path, "00000000", 0, 5000, 4096, None).unwrap();
    assert_eq!(bundle.lines.len(), 2);
    assert!(bundle.lines[0].contains("current"));
    assert!(bundle.lines[1].contains("previous"));
    // Every read handle has closed before the next rotation. This replacement
    // fails on Windows if a reader kept an incompatible handle open.
    let next = Store::open(&path).unwrap();
    let mut file = open_or_create(&next.dir, CURRENT).unwrap();
    file.set_len(MAX_FILE_BYTES).unwrap();
    file.seek(SeekFrom::End(-1)).unwrap();
    file.write_all(b"\n").unwrap();
    drop(file);
    next.append(&render_line(
        &rfc3339_millis(3000),
        "INFO",
        "spawnd",
        "src/main.rs:1",
        "next",
        vec![],
    ))
    .unwrap();
    assert!(read_window(&path, "00000000", 0, 5000, 4096, None).is_ok());
}

#[test]
fn typed_header_cannot_copy_state_text_and_compression_has_a_final_cap() {
    let marker = capture::canary();
    let state: crate::state::StateFile = serde_json::from_value(serde_json::json!({
        "pid":1,"version":marker,"connected":true,"connected_at":marker,
        "server":marker,"last_error":{"kind":marker,"detail":marker,"at":"2026-01-01T00:00:00Z"},
        "sessions":2,"exe":marker,"release":marker,"tree":marker
    }))
    .unwrap();
    let projection = BundleState::from_state(state);
    capture::assert_absent(
        &serde_json::to_string(&projection).unwrap(),
        &marker,
        "typed state",
    );
    let tmp = capture::private_tempdir();
    let path = tmp.path().join(DIR_NAME);
    let store = Store::open(&path).unwrap();
    store
        .append(&render_line(
            &rfc3339_millis(1000),
            "INFO",
            "spawnd",
            "src/main.rs:1",
            "first",
            vec![],
        ))
        .unwrap();
    store
        .append(&render_line(
            &rfc3339_millis(2000),
            "INFO",
            "spawnd",
            "src/main.rs:1",
            "second",
            vec![],
        ))
        .unwrap();
    let bundle = read_window(&path, "00000000", 0, 3000, 4096, Some(projection)).unwrap();
    assert!(compress_bundle(bundle.clone(), 1).unwrap().is_none());
    let full = compress_bundle(bundle.clone(), MAX_GZIP_BYTES)
        .unwrap()
        .unwrap();
    let clipped = compress_bundle(bundle.clone(), full.body.len() - 1)
        .unwrap()
        .unwrap();
    assert_eq!(clipped.header.lines, 1);
    assert_eq!(clipped.header.from, Some(2000));
    assert!(clipped.header.truncated);
    assert!(clipped.body.len() < full.body.len());
    let result = compress_bundle(bundle, MAX_GZIP_BYTES).unwrap().unwrap();
    let mut raw = String::new();
    flate2::read::GzDecoder::new(result.body.as_slice())
        .read_to_string(&mut raw)
        .unwrap();
    assert_eq!(result.header.bytes, raw.len());
    capture::assert_absent(&raw, &marker, "complete bundle");
}
