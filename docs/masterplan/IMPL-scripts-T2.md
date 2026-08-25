# IMPL scripts T2 — updater test programme

Date: 2026-08-26 NZST  
Tree tested: `c65d4c51006a7f059a8ac829ad55c35b97959cbd`

## Files

- Added `scripts/update-test-lib.sh`, `scripts/fault-proxy.py`, `scripts/test-update-e2e.sh`, `scripts/test-update-faults.sh`, `scripts/test-update-probation.sh`, `scripts/test-version-skew.sh`, and `scripts/chaos-drills.sh`.
- Updated `scripts/test-all.sh` and `docs/RELEASE.md`.
- Updated `server/tests/test_verify_release_script.py` so its daemon-only fixture explicitly uses the new `--skip-desktop` seam.
- Added the allowed `web/tests/e2e/version-skew.spec.ts` exception.

No `mobile/`, `daemon/`, or server implementation file was changed. No production command/origin or git write command was run.

## Per-item checklist

### 1. Signed updater E2E — PASS with one explicit SKIP

- PASS: two HEAD builds use separate cached targets, trees A/B, counters 1000/2000, and a throwaway Ed25519 public key.
- PASS: real artifact hashes, manifest rendering/signing/verification via `release-lib.sh`, local prebuilt routes, sqlite/in-process server, and full scripted credential ceremony.
- PASS: tree A registration; automatic update; ordered `precondition/download/verify/swap/exec`; actual daemon PID unchanged across exec; tree B/current registration.
- PASS: both `.prev` files observed through tree-B registration and removed only after it, probation marker removed, installed pair byte-matches v-new.
- PASS: pre-existing worker keeps the same PID and socket inode, session stays running, and the PTY process marker survives adoption.
- SKIP: post-register PTY bytes with proof of no client reconnect needs a reusable non-browser RTC DataChannel observer. The script prints this SKIP rather than claiming PASS.
- PASS: same-tree POST 200/current; manual POST 202 then immediate second POST 429.
- PASS: `SPAWND_NO_SELF_UPDATE=1` -> unsupported/disabled; chmod 555 install directory -> unsupported/not writable.
- PASS: counter 500 -> failed/downgrade with v-old intact; `allow_downgrade:true` installs tree B.

### 2. Fault injection — PASS with one explicit SKIP

- SKIP: literal hang -> download needs a test timeout hook; D3 fixes the production budget at 300 seconds.
- PASS: truncate -> verify; binary flip -> verify; old pair remains intact and registered.
- PASS: in-transit manifest flip -> manifest mismatch (the control digest pin).
- PASS: valid-JSON signed-byte mutation before server digest advertisement -> manifest bad signature.
- PASS: trickle completes cleanly/atomically; clean download/verify failure is the only accepted alternative.
- PASS: candidate `--version` exit 1, wrong output, and 20-second sleep all -> verify with old pair intact and daemon registered.
- PASS: one proxied origin carries WebSocket control, manifests, and downloads.

### 3. Probation/revert — PASS

- PASS: signed candidate wrapper reports exact v-new; on run it replaces its installed path with real v-new and gives only the first exec an empty credential directory.
- PASS: real v-new sees/increments the installed marker then exits 1; supervisor restart crosses the two-attempt threshold and pair-atomically restores/execs v-old.
- PASS: v-old registers tree A; host is failed with health/registration-failed; marker/backups are gone and restored pair byte-matches v-old.
- PASS: stable old PID/tree and no re-push across 65 seconds (two keepalive windows).

### 4. Version skew — implemented; full matrix SKIP in this run

- PASS: self-test and unset-ref guard.
- PASS by inspection: detached worktree lifecycle, old build with the main absolute server venv, four local register + worker-backed PTY cells, old/new auto-update, new/old unsigned refusal/no-loop/no-downgrade, and matrix printing.
- SKIP: `SPAWN_OLD_REF` was not supplied and this workstream was forbidden from running git write commands. The script prints an explicit SKIP.

### 5. Chaos drills — safe half PASS; observer/privileged cells SKIP/MANUAL

- PASS (70s): actual daemon SIGSTOP -> offline within 90s -> SIGCONT online; zero 4000/supersession closes.
- PASS: SIGKILL local uvicorn around a live PTY leaves daemon/worker/PTY alive, adds no `rtc.close`, then observes a new daemon registration and running session after restart.
- SKIP: exact `rtc.status rebound`/`live_bindings` needs a reusable live RTC observer.
- MANUAL: TCP pfctl, UDP/TURN, NLC, and sleep/Wi-Fi print expectations. Privilege is refused without `SPAWN_ALLOW_SUDO=1`; availability uses only `sudo -n`, never a prompt.

### 6. CI wiring — PASS

- PASS: all harness self-tests are in guards.
- PASS: E2E, faults, and probation run unconditionally after daemon tests.
- PASS: skew is gated by `SPAWN_OLD_REF`; chaos by `SPAWN_ALLOW_SUDO=1`.
- PASS: unconditional scripts use the existing cargo/shell/curl/Python/server-venv toolchain, with no browser or new package dependency.

### 7. Release documentation — PASS

- PASS: documents three CI proofs, skew before each daemon release, chaos after connection-layer changes, stdlib fault proxy, optional-manual toxiproxy/mitmproxy, and sudo behavior.

### Web-tab skew cell — static PASS, browser runtime SKIP

- PASS: one spec follows `mockApp`, starts a locally stamped old-web bundle, and mocks a newer `/api/release`.
- PASS by assertions: 4003 shows hard dialog/countdown, no Later/reconnect spinner/new socket; soft mismatch is snooze-able.
- PASS: Biome and full TypeScript check.
- SKIP runtime: Playwright never reached tests because sandbox Next/Watchpack exhausted file watchers with `EMFILE`; rerun outside the sandbox.

## Verification tails and wall clocks

Guards (about 1s):

```text
update-test-lib: self-test ok
test-update-e2e: self-test ok
fault-proxy: self-test ok
test-update-faults: self-test ok
test-update-probation: self-test ok
test-version-skew: self-test ok
chaos-drills: self-test ok
```

`test-update-e2e.sh` — PASS, 43s:

```text
SKIP PTY bytes/no client reconnect (needs: reusable non-browser RTC DataChannel observer for the cargo+python CI fixture)
PASS auto-update/worker-adoption/idempotence
PASS manual/429
PASS blocked: disabled
PASS unsupported: unwritable
PASS downgrade/allow_downgrade
test-update-e2e: passed in 43s (1 explicit SKIP)
```

`test-update-faults.sh` — PASS, 90s:

```text
SKIP hang -> download (needs: test-only SPAWND_UPDATE_DOWNLOAD_TIMEOUT_MS override; production budget is fixed at 300s)
PASS truncate -> verify:
PASS flip-binary -> verify:
PASS flip-manifest -> manifest mismatch
PASS manifest_bad_signature
PASS trickle -> completed
PASS version-exit -> verify:
PASS version-wrong -> verify:
PASS version-timeout -> verify:
test-update-faults: passed in 90s (1 explicit SKIP)
```

`test-update-probation.sh` — PASS, 78s:

```text
test-update-probation: observing failed tree for 65s (two keepalive windows)
test-update-probation: passed in 78s
```

`test-version-skew.sh` — guarded SKIP, <1s:

```text
test-version-skew: SKIP (set SPAWN_OLD_REF to the last deployed commit)
```

`chaos-drills.sh` — safe half PASS, 70s:

```text
PASS half-open recovery (4000 closes=0)
PASS server vanish (worker retained, no rtc.close)
SKIP rtc.status rebound/live_bindings (needs: reusable headless RTC binding observer for the shell harness)
MANUAL TCP pfctl — refused (set SPAWN_ALLOW_SUDO=1; commands always use sudo -n)
MANUAL UDP/TURN pfctl — refused
MANUAL NLC — Very Bad Network + yes
MANUAL sleep/Wi-Fi
chaos-drills: completed in 70s
```

Repository/release checks:

```text
$ bash -n scripts/*.sh
# no output
$ scripts/check-claude-md.sh
check-claude-md: every tracked directory is documented
$ server/.venv/bin/python -m pytest -q server/tests/test_deploy_prod_script.py server/tests/test_verify_release_script.py
.........                                                                [100%]
9 passed in 3.51s
$ git diff --check -- scripts docs server/tests/test_verify_release_script.py
# no output
```

Web static checks — PASS, 1.4s:

```text
$ cd web && ./node_modules/.bin/biome check tests/e2e/version-skew.spec.ts && ./node_modules/.bin/tsc --noEmit --pretty false
Checked 1 file in 49ms. No fixes applied.
```

Focused Playwright — SKIP before tests, 120s:

```text
[WebServer] Watchpack Error (watcher): Error: EMFILE: too many open files, watch
Error: Timed out waiting 120000ms from config.webServer.
```

## Undone and why

1. PTY bytes/no reconnect: missing reusable non-browser RTC observer.
2. Hang timeout: missing daemon test timeout hook; fixed production wait is 300s.
3. Four-cell matrix: no `SPAWN_OLD_REF`, plus this run could not perform git writes.
4. Playwright: sandbox file-watch exhaustion before tests.
5. Exact rebound/live bindings and privileged/physical network drills remain explicitly SKIP/MANUAL.
6. Two early failed harness iterations predate the final cleanup guard and left sandbox-owned workers that this process cannot signal (`EPERM`): PIDs 21571/21627 under `/private/tmp/spawn-update-e2e.M3G0el`, and PIDs 53089/53145 under `/private/tmp/spawn-chaos-drills.obe6K6` (socket state `/private/tmp/su.FDz03R`). Later complete E2E and chaos runs clean up successfully. An outer process should terminate those exact PIDs and remove those exact directories.

## Notes for D4 / S4

### D4

- Add a debug/test-only `SPAWND_UPDATE_DOWNLOAD_TIMEOUT_MS` override, validated to a small positive range and ignored in production release builds. This converts hang/download from SKIP without weakening the real five-minute budget.
- Provide a reusable local RTC/DataChannel observer that attaches once, writes/reads PTY bytes across daemon exec, and exposes peer/channel creation counts.

### S4

- Provide a local-test introspection seam or reusable headless observer for active RTC bindings, `live_bindings` on daemon re-register, and emitted `rtc.status` values.
- SIGKILL leaves durable host `online` state until a real daemon registration refreshes it. The harness waits for a new registration rather than trusting the row; a read-only connection-generation/lease diagnostic would make this directly assertable.
