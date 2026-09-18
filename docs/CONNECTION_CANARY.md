# Isolated connection canary

`scripts/test-connection-canary.sh` rehearses daemon promotion and recovery on
disposable, loopback-only server instances. It supplies the `isolated_canary`
evidence required by `scripts/check-release-acceptance.py`. Native iOS and
Android WebRTC evidence is a separate requirement; this runner measures the
worker IPC and PTY layers.

```bash
scripts/test-connection-canary.sh \
  --baseline <deployed-commit> --candidate <candidate-commit> \
  --output /tmp/connection-canary.json
```

Both refs must resolve to different full commits. The runner checks out each
into a disposable detached worktree and builds its actual daemon/worker pair
with the same release profile and toolchain. The candidate server serves both
cohorts. An arbitrary baseline ref is useful for local debugging; the release
gate must resolve the deployed baseline independently and match the exact
candidate commit before promotion.

Linux and macOS are supported. Prerequisites are the existing updater fixture's
Rust toolchain, Python, `server/.venv` dependencies, Git and curl. The runner
uses `SPAWN_TEST_CARGO_TARGET_DIR` (default `/tmp/spawn-t2-cargo`) for reusable
release build artifacts; give concurrent runners separate caches. Run the
lightweight protocol and evidence regressions with
`scripts/test-connection-canary.sh --self-test`.

Every required case runs a real API-created session and a synthetic command on
its worker-owned PTY:

| Case | Required observation |
| --- | --- |
| `baseline_holdback` | Baseline daemon and worker remain selected while the candidate manifest is available and automatic updates are off. |
| `candidate_soak` | A fresh candidate daemon and candidate worker sustain the same workload. |
| `update_recovery` | A live baseline worker survives automatic candidate installation, daemon exec, a killed local API process, and a killed fixture daemon; the candidate adopts the same session. |
| `startup_rollback` | A signed fixture wrapper deliberately fails candidate registration; production probation restores the baseline, keeps the worker alive, and does not retry the failed tree over two keepalive intervals. |

Each active-daemon observation lasts at least 120 seconds by default.
`--soak-seconds 60` is the supported shorter local rehearsal; less than 60
seconds fails. The PTY command emits a heartbeat every 250 ms and then writes
an atomic local checkpoint. The observer requires repeated monotonic advances,
the same PTY PID/start identity, a live worker PID and the same socket inode.
Five seconds without an advance fails the case. A blocked PTY write cannot
publish a successful heartbeat. Actions have a bounded observation deadline;
rollback additionally requires 60 seconds without another startup attempt.
Its observation includes five seconds of clock-rounding padding, and the
measured monotonic duration must still cover the full minute. API and daemon
recovery durations are recorded in milliseconds and must each stay within
60 seconds. Each recovery or IPC checkpoint must observe a new daemon
registration for that exact fixture host; cached API online status cannot
satisfy the recovery witness or stop its timer.

A worker accepts exactly one supervisor connection. Therefore each case takes
its direct IPC input/output measurements **before and after** the active
daemon window: it stops only that disposable daemon, connects to the worker,
sends 32 unpredictable tokens and requires the PTY command's prefixed response,
then restarts the daemon and verifies adoption. Terminal input echo cannot
satisfy a response. The before/after Hello must name the same session, worker
instance UUID and PTY PID. Host identity, browser trust pins and selected
executable pairs are also checked. Daemon logs must show successful worker
rediscovery for every expected restart or update exec, with the original PTY
PID; a persisted server session status alone cannot pass adoption. These
checkpoints do not claim that a
browser connection remained attached, or that the observer passively shared
the daemon's IPC connection.

The fresh candidate worker's p95 response latency must be at most
`max(250 ms, 5 × baseline p95)`. Every individual response has an absolute
five-second timeout. This generous local guard detects severe IPC regressions;
it is not a network latency target or a statistical performance benchmark.
The update case intentionally retains the baseline worker, as production
updates must preserve already-running sessions.

The JSON report contains `schema_version: 1`, `suite: connection_canary`,
`evidence_kind: isolated_canary`, `physical_device: false`, exact candidate and
baseline commit IDs, timestamps, required cases, checks and raw latency
samples. Its sibling `<report>.artifacts/` contains checkpoint measurements,
daemon/server logs and executable/source hashes. Source root, daemon, server
and mobile tree IDs are separate from the synthetic daemon tree/counter and
ephemeral fixture signing identity used to exercise the updater. Fixture
signatures are not production release signatures. Private keys, credentials
and fixture databases are not included in the evidence artifacts.

The report starts failed, and becomes passed only after every required case,
measurement, comparison and cleanup succeeds. Missing, skipped, short or
failed cases fail promotion. Changing either runner source file during the
observation also fails, even if every scenario passed. Existing output paths
are refused. The runner
does not publish artifacts, select production users, change global network
rules, touch a live daemon, or implement a production rollout mechanism.
