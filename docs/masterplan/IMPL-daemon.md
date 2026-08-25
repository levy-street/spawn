# Daemon implementation report

## Files changed or added

- `daemon/CLAUDE.md`
- `daemon/build.rs`
- `daemon/src/cli.rs`
- `daemon/src/main.rs`
- `daemon/src/proto.rs`
- `daemon/src/pty.rs`
- `daemon/src/run.rs`
- `daemon/src/version.rs`
- `daemon/src/worker_backend.rs`
- `daemon/src/ws.rs`
- `daemon/src/update.rs` (new; orchestration, preconditions, HTTP release path, exec)
- `daemon/src/update_io.rs` (new; bounded download/verification/swap helpers)
- `daemon/src/update_tests.rs` (new; focused updater tests)

No dependency or lockfile changes were needed.

## Spec checklist

- [x] `build.rs` stamps `SPAWND_DAEMON_TREE` from `git rev-parse HEAD:daemon`, appends `-dirty` when `git diff --quiet HEAD -- .` is nonzero, emits an empty value outside git, and watches `src`, `build.rs`, `Cargo.toml`, and `Cargo.lock`. Existing `SPAWND_BUILD_VERSION` / `--version` formatting is unchanged.
- [x] `version.rs` exposes `daemon_tree()`; register sends `daemon_tree` (omitted when unknown), `self_update`, and nullable `self_update_blocked` with exact precondition classes `disabled`, `unwritable`, `unsupported_target`, and `worker_missing`.
- [x] `Inbound::DaemonUpdate`, its `{path,sha256}` artifacts, and `Outbound::DaemonUpdateResult` implement the exact wire names/shapes. Unknown frame types remain `MalformedJson` and are discarded content-free.
- [x] Process-wide single-flight guard returns `precondition/busy` to concurrent requests.
- [x] Preconditions run initially and immediately before swap: opt-out env, resolved/writable current executable directory, resolved worker file/writable directory, and exact macOS/Linux target mapping.
- [x] URL joining resets to the configured server origin and refuses schemes/hosts, query/fragment/backslash forms, traversal outside `/api/install/`, and all non-install paths.
- [x] Existing rustls `reqwest` downloads both files under one five-minute bound, streams SHA-256, and enforces a 256 MiB cap.
- [x] Both files get 0755; candidate `spawnd --version` has a 15-second timeout, must exit zero, and must end with the advertised version.
- [x] Two-binary swap uses `.prev` backups and rolls back a failed second rename or worker swap. Existing backups are never overwritten.
- [x] Pushed updates run in a Tokio task so dispatch continues. Failures return exact stage/class values. Success sends `ok:true`, flushes the result and clean close in one bounded two-second window, then execs with original argv/current env.
- [x] Exec replaces only `spawnd`; worker-owned sessions survive and are re-adopted. Exec failure is class-only and leaves the old process running with the new binary on disk for the next restart.
- [x] Stages log at info; ingress warnings/errors contain stage/classes only, never server strings or full paths.
- [x] HTTP path fetches public `GET /api/release`, declines unknown/dirty/current identities, picks only its listed target, and reuses the same apply pipeline.
- [x] Selected-subprotocol refusal and close 4003 are typed HTTP-update triggers. Failed triggers use a separate five-minute backoff and an hourly reinstall error; ordinary 1..60 second backoff is unchanged.
- [x] `spawnd update` runs HTTP update once. A successful exec reruns the command in the new binary, which sees the current tree and exits the one-shot path.
- [x] Startup removes exact stale `spawnd.prev` / `spawn-worker.prev` files.
- [x] `daemon/CLAUDE.md` describes the new modules/tests.

## Verification

- PASS — `cd daemon && cargo fmt`
- PASS — `cd daemon && cargo build --locked`
- PASS — `cd daemon && cargo check --locked --bin spawnd`
- FAIL (untouched pre-existing warning) — `cd daemon && cargo clippy --locked --bin spawnd -- -D warnings`

  `git diff --quiet HEAD -- daemon/src/sessiond/emulator.rs` exits 0. Failing output:

  ```text
  error: can be more succinctly written as a byte str
     --> src/sessiond/emulator.rs:491:34
      |
  491 |                 let designator = [b'(', b')', b'*', b'+'][i];
      |                                  ^^^^^^^^^^^^^^^^^^^^^^^^ help: try: `*b"()*+"`
      |
      = note: `-D clippy::byte-char-slices` implied by `-D warnings`

  error: could not compile `spawnd` (lib) due to 1 previous error
  ```

- PASS (compile completed; only existing warnings reported) — `cd daemon && cargo clippy --locked --bin spawnd`
- PASS — `cargo test --locked --bin spawnd update:: --no-fail-fast`: 10 passed, 0 failed.
- PASS — `cargo test --locked --bin spawnd ws:: --no-fail-fast`: 8 passed, 0 failed.
- PASS — `cargo test --locked --bin spawnd proto:: --no-fail-fast`: 13 passed, 0 failed.
- FAIL (unrelated existing assertion; no diff hunk touches this test/refusal path) — `cargo test --locked --bin spawnd run:: --no-fail-fast`: 33 passed, 1 failed. Exact rerun failed identically:

  ```text
  ---- run::tests::a_revoked_key_stays_denied_when_a_later_frame_omits_it stdout ----

  thread 'run::tests::a_revoked_key_stays_denied_when_a_later_frame_omits_it' panicked at src/run.rs:4797:13:
  assertion `left == right` failed
    left: [Object {"binding_nonce": String("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), "message": String("This host has not approved this device. Approve it from a device this host already trusts, or pair the host again."), "protocol": String("spawn.host.ctl"), "protocol_version": Number(1), "scope_id": String("00000000-0000-0000-0000-00000000000a"), "scope_type": String("host"), "session_id": String("00000000-0000-0000-0000-000000000002"), "status": String("failed"), "type": String("rtc.status")}]
   right: []

  thread 'run::tests::a_revoked_key_stays_denied_when_a_later_frame_omits_it' panicked at src/run.rs:4838:56:
  server refusal observation: RecvError(())

  test result: FAILED. 33 passed; 1 failed; 0 ignored; 0 measured; 285 filtered out
  ```

- PASS — exact new dispatch test `run::tests::daemon_update_runs_off_dispatch_and_busy_result_keeps_frames_serving`: 1 passed.
- PASS — `cargo build --locked --release` (2m 01s).
- PASS — `target/release/spawnd --version`: `spawnd 0.1.0+gab39d120cf5e`.
- PASS — release binary contains expected identity `3b6fb119daffadedb9e2608d5fe8cf98c73dc106-dirty`.
- PASS — `git diff --check -- daemon`.

The unfiltered suite was intentionally not run per the warning about the hanging upload test.

## Left undone

No daemon spec item is intentionally left undone. Strict clippy and the complete `run::` filter are not green only because of the untouched failures pasted above; I did not modify those out-of-scope areas.

## Notes for other streams

- Pushed artifact keys are exactly `spawnd` and `spawn_worker`; paths must be under `/api/install/`.
- HTTP expects `daemon.version`, `daemon.tree`, and `daemon.targets[<target>].{spawnd_sha256,spawn_worker_sha256}`.
- Targets are exactly `darwin-aarch64`, `darwin-x86_64`, `linux-aarch64`, `linux-x86_64`.
- Dirty builds register `<40hex>-dirty` but decline HTTP update; outside-git builds omit `daemon_tree`.
- On pushed success, `daemon.update_result ok:true` is sent before exec; the new register must carry the requested tree. Sessions remain in worker processes.
- Failure stages are `download|verify|swap|exec|precondition`; preconditions use the spec reasons plus `busy`, and pipeline errors are short underscore-delimited classes.
