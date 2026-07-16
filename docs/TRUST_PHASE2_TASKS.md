# Trust Phase 2 — tracked task schedule

Last updated: 2026-07-16. Governing model: `docs/TRUST.md`. Build sequence and
purge runbook: `docs/TRUST_PHASE2.md`.

This is the execution ledger for the trust-model review. It distinguishes
reviewed work already integrated on `master` from the active transport roots
and later work that depends on those new encrypted transports.

## Status and merge protocol

Statuses are `DONE`, `SHIPPED`, `ACTIVE`, `READY`, `BLOCKED`, and `PLANNED`.
`SHIPPED` means code is on `master` but a corrective acceptance gate remains.
`DONE` means the implementation has passed an independent review and is on
`master`; a passing implementation test in a worktree is not enough.

Every implementation task uses this protocol:

1. Create a dedicated git worktree and implementation branch from current
   `master`; record the implementer and acceptance commands in the task/PR.
2. When implementation is committed, assign a different subagent to review
   correctness, trust-model invariants, tests, and mergeability against the
   then-current `master`.
3. If review requests changes, return the task to the original implementation
   subagent. Review the new commit again; do not self-approve.
4. A review pass must include a clean merge/rebase simulation and the relevant
   test gates. Only then merge back to `master` and mark `DONE`.
5. Merge dependency roots before their dependants. Rebase/retest concurrent
   branches after another task changes a shared protocol or file.

No task may weaken or silently defer a protected data class merely to avoid a
merge conflict. Documentation-only review passes do not approve later runtime
behavior.

## Current checkpoint

| ID | Status | Scope | Depends on | Review/acceptance gate |
|----|--------|-------|------------|------------------------|
| BASE-00 | DONE | Remove the unused production Redis PTY ring API (`e03fb3f`) and repair the stale real-Redis smoke (`98b28b4`) | — | Runtime API is gone; real pub/sub smoke and matrix guard pass without ring calls |
| BASE-01 | DONE | Move meaningful-output classification to daemon and emit content-free `agent.activity` (`4b245f1`), then land the independently reviewed correctness series (`47b9c75`, `5b887bc`, `c7f3802`, `83c4295`; merged by `31d3442`) | — | Server no longer parses `0x01` payloads; GATE-02–05 passed before the Increment 2 transport roots started |
| DOC-01 | DONE | Expand trust inventory, transports, schedule, purge, retained metadata, and progress wording (`ea8169f`, `8d5966e`, `4b00aff`) | — | Independently reviewed documentation is internally consistent and grounded in current routes/frames/models |

## Immediate gate — complete

These tasks ran in parallel and passed independent implementation review. Their
completion is the gate that allowed the `spawn.ctl` transport work to start.

| ID | Status | Scope | Depends on | Review/acceptance gate |
|----|--------|-------|------------|------------------------|
| GATE-01 | DONE | Update `scripts/smoke-redis-pubsub.sh` after ring API removal; preserve live pub/sub coverage and remove stale ring calls (`98b28b4`) | BASE-00 | Real Redis smoke passed; test-matrix guard prevents ring calls returning |
| GATE-02 | DONE | Emit a content-free, monotonic-throttled daemon input-activity frame for `spawn.pty` input and stamp `last_input_at` after host/agent ownership validation (`47b9c75`; reviewed series merged by `31d3442`) | BASE-01 | A v2 DataChannel typing test produces the documented Input sent transition without server terminal bytes and preserves at-most-once-per-second disclosure |
| GATE-03 | DONE | Cover every daemon-induced repaint suppression path, especially tmux scroll and copy-mode cancellation before stdin (`47b9c75`; reviewed series merged by `31d3442`) | BASE-01 | Tests prove scroll/resize/redraw/input echo do not create false output activity while later genuine output does |
| GATE-04 | DONE | Correct classifier behavior for invalid/incomplete UTF-8 and split escape sequences; use monotonic throttle/suppression clocks (`47b9c75`, `5b887bc`, `c7f3802`, `83c4295`; merged by `31d3442`) | BASE-01 | Differential/boundary tests cover invalid bytes, multibyte chunk splits, escape splits, clock boundaries, and the three-character threshold |
| GATE-05 | DONE | Add end-to-end activity tests and remove dead server classifier/suppression behavior when imports reached zero (`47b9c75`, `5b887bc`, `c7f3802`, `83c4295`; merged by `31d3442`) | GATE-02, GATE-03, GATE-04 | Tests cover throttling, frame emission/backpressure, ownership rejection, input stamping, streaming/binary output classification, and suppression |
| QUAL-01 | DONE | Format all Increment 1 trust-touched Rust, including `activity.rs` and activity paths in `pty.rs`; require the same for every later trust change (activity merge `31d3442`; repository check confirmed at `640a2e0`) | BASE-01 | `cargo fmt --all -- --check` passes |

## Global quality ledger

These findings predated the trust review and did not by themselves block the
start of Increment 2. They have now also been independently reviewed and
integrated, leaving a clean quality baseline for the transport work.

| ID | Status | Scope | Blocking rule | Review/acceptance gate |
|----|--------|-------|---------------|------------------------|
| QUAL-02 | DONE | Resolve repository-wide `cargo fmt --all -- --check` drift outside the Increment 1 activity changes (`1bb9fe9`; merged with the parallel Clippy cleanup by `640a2e0`) | Completed baseline cleanup | Global format check passes |
| QUAL-03 | DONE | Fix the Ruff import-order failure in `server/spawn_server/routes/hosts.py` (`ec1f86e`) | Completed baseline cleanup | `uv run ruff check spawn_server tests` passes |
| QUAL-04 | DONE | Fix the two Clippy warnings: `type_complexity` at `pty.rs` worker replay and `nonminimal_bool` in `upload.rs` (`775b7d0`; merged with the parallel format cleanup by `640a2e0`) | Completed baseline cleanup | `cargo clippy --all-targets --all-features -- -D warnings` passes |
| QUAL-05 | DONE | Make the full server test baseline hermetic by isolating auth-provider environment and migration connection state (`aa524d9`) | Completed test-harness cleanup | Full server suite passes without relying on ambient environment or prior engine state |

### Integrated validation at `640a2e0`

The reviewed Wave 0 commits were validated together on `master` at `640a2e0`:

- `cd daemon && cargo fmt --all -- --check` — passed.
- `cd daemon && cargo clippy --all-targets --all-features -- -D warnings` — passed.
- `cd daemon && cargo test --locked` — 113 tests passed.
- `cd server && uv run ruff check spawn_server tests` — passed.
- `cd server && uv run pytest -q` — 128 tests passed.
- `scripts/smoke-redis-pubsub.sh` — passed against real Redis.

## Phase 2 runtime schedule

The two transport roots, P2-AGENT-01 and P2-HOST-01, and the P2-TMUX-01
worker-only cutover are reviewed and integrated on `master` through `1f66d2d`.
The P2-AGENT-02/P2-TERM-02 server-terminal cut is reviewed and integrated
through `5722288`. Work beneath a root may parallelize only where its protocol
is reviewed and stable.

| ID | Status | Scope | Depends on | Review/acceptance gate |
|----|--------|-------|------------|------------------------|
| P2-TMUX-01 | DONE — REVIEWED, MERGED (`1f66d2d`) | Worker-only cutover: remove daemon tmux execution/module/backend selector/session-name protocol state and all tmux create/attach/adopt/discover/capture/replay/resize/scroll/copy/repaint paths; remove tmux-only replay/status filtering plus server/web `tmux_session` and `agent.rename`; add fail-closed guard and cutover ADR | P2-AGENT-01 implementation, QUAL-01 | Strict daemon/server/web gates pass; source inventory proves no production tmux execution, escape hatch, API/schema/UI field, or rename frame; real worker launch/adopt/replay/resize/input/shutdown remains covered; operator drain/restart and old-session unavailability are explicit; mergeability review passes |
| P2-AGENT-01 | DONE — REVIEWED, MERGED (`1f66d2d`) | Add versioned per-agent `spawn.ctl`; move history/snapshot plus resize/display ownership to the mandatory worker replay source | GATE-02–05, QUAL-01 | Ordering/reconnect/size/error and multi-viewer viewport tests pass; worker replay retains whole segments under its 8 MiB conservative total charge (ciphertext/framing + twice replay + bookkeeping), becomes unavailable after worker exit, and replays after `spawnd` restart/adoption; v2 server sees no history/snapshot/dimensions/deltas/event timing |
| P2-AGENT-02 | DONE — REVIEWED, MERGED (`5722288`) | Retire `spawn.v1`, daemon `0x01` output and `0x02` input, server transcript writes/history forwarding/pubsub relay; require both agent DataChannels and strict v2 signaling tuples | P2-AGENT-01 | All-target daemon compile, server/web suites, mandatory-channel and old-protocol failure tests, no-content guard, offline-history/cutover documentation, and mergeability review pass |
| P2-HOST-01 | DONE — REVIEWED, MERGED (`1f66d2d`) | Add host-scoped WebRTC session and versioned `spawn.host.ctl`, independent of any agent | GATE-02–05, QUAL-01 | Host with zero agents can connect; ownership, reconnect, cancellation, limits, request binding, TURN-only, and cross-host session isolation tests pass |
| P2-HOST-02 | ACTIVE — IMPLEMENTED, REVIEW PENDING | Integrated review candidate on its isolated branch: move host list/stat/read/write/mkdir/rename/remove/download/upload/transfer and registration `home_dir` to capability-rooted host channels; browser mediates bounded, bilaterally cancelled cross-host streaming. Review findings, including pre-routing cancel publication, prompt token-based write cancellation, tracked cleanup, and read-stream ID replay, are corrected; independent review and merge are pending. | P2-HOST-01, QUAL-03 | Server inventory has no host path/name/size/mtime/error or byte payload; no-follow/atomic-race tests, bounded dispatcher/page/stream/tombstone/reaper tests, forced fast/normal cancel-order and stalled-I/O control-path tests, browser redeclaration tests, and distinct two-host authorization/abort tests pass |
| P2-HOST-03A | PLANNED | Add the parallel interactive tool path on `spawn.host.ctl`: commands, paths, installed/latest versions, detailed errors, and stdout/stderr remain E2E while the legacy route is temporarily retained | P2-HOST-01, QUAL-03 | Interactive check/install works with bounded/cancellable requests and no new server content; compatibility route retention is explicit and Phase 2 remains incomplete |
| P2-HOST-03B | BLOCKED | Complete the tool cut: make the interactive endpoint path mandatory, remove the legacy server route, and relocate unattended executable policy/targets to the endpoint | P2-HOST-03A, P2-DATA-02, QUAL-03 | Durable endpoint owns `Preset.install`/default command before route removal; server retains only disclosed policy/timestamps/content-free result and cannot persist detail |
| P2-TERM-01 | PLANNED | Move agent uploads to chunked `spawn.ctl`; remove REST/WS `bytes_b64` upload legs | P2-AGENT-01, QUAL-04 | Large-file, cancellation, retry, path-ack confidentiality, and bounded-memory tests pass |
| P2-TERM-02 | DONE — REVIEWED, MERGED (`5722288`) | Remove REST/WS input/snapshot/resize/scroll/redraw/display-control surfaces and migrate test clients to RTC endpoint harness | P2-AGENT-01, GATE-02 | No server schema/frame carries PTY/snapshot/viewport data or event timing; old clients receive only a content-free protocol-required close; mergeability review passes |
| P2-DATA-01 | PLANNED | Approve endpoint-local versus opaque client-encrypted durable store for launch manifests, preset operational values/tool targets, and skill bodies | P2-HOST-01 | Threat model covers keys/recovery, multi-device, offline restart, rollback, migration, and ciphertext identifier/size/version/access leakage; server never has decryption keys |
| P2-DATA-02 | BLOCKED | Move `cwd`, `argv`, `env`, preset default-command/install/environment values, tool targets, and skill bodies over `spawn.host.ctl`; store daemon restart manifest locally; stop cwd-derived names | P2-DATA-01 | Create/restart/preset/skill/tool flows work after plaintext reads are disabled; neutral default name used; legacy derived names scrubbed/reclassified; only disclosed metadata or opaque ciphertext remains |
| P2-ERROR-01 | BLOCKED | Replace free-form daemon error/status/exit details with stable server-visible codes and E2E agent/host/pre-launch detail; remove server forwarding/logging | P2-AGENT-01, P2-HOST-01, P2-DATA-02 | Injected cwd/file/tool errors reach browser E2E, while server frames/logs/telemetry contain only codes and disclosed lifecycle metadata |
| P2-PURGE-01 | BLOCKED | Inventory, migrate, close/drain ingress, restart processes, and purge transcripts, DB/derived names, Redis, memory/queues/swap/core, logs/observability, WAL/AOF, backups, replicas, raw blocks, and snapshots | P2-TMUX-01, P2-AGENT-02, P2-HOST-02, P2-HOST-03B, P2-TERM-01, P2-TERM-02, P2-DATA-02, P2-ERROR-01 | Two-operator evidence follows the eight-step runbook; process/observability and oldest-backup checks find no recoverable plaintext; no content rollback path remains |
| P2-AUDIT-01 | BLOCKED | Final adversarial server audit and Phase 2 claim gate | P2-PURGE-01 | Code/route/frame/schema inventory; server memory/queue/swap/core/disk/DB/Redis/log/observability scans; backup evidence; TURN-only tests; ciphertext and retained-metadata disclosure all pass |

**Permanent P2-TMUX-01 scheduling rule:** this completed cutover must never be
reopened as a backend repair, compatibility, fallback, or incident-recovery
task. Translate any old-backend bug report into the equivalent `spawn-worker`
behavior and schedule that worker-only fix instead. Reversing the decision
requires a new ADR and explicit trust-boundary review; see
[`TMUX_REMOVAL.md`](TMUX_REMOVAL.md).

`P2-HOST-03B`, `P2-DATA-02`, `P2-ERROR-01`, `P2-PURGE-01`, and `P2-AUDIT-01`
are marked `BLOCKED` because their declared dependencies do not exist yet, not
because their scope is optional.

Phase 2 is complete when the Phase 2 rows above through `P2-AUDIT-01` and the
immediate/overlapping quality gates required by their dependency and merge
rules are `DONE`. It does not wait for the Phase 3 follow-on task below.

## Phase 3 follow-on schedule

| ID | Status | Scope | Depends on | Review/acceptance gate |
|----|--------|-------|------------|------------------------|
| P3-IDENTITY-01 | PLANNED | Endpoint keys; signed agent/host signaling over a canonical tuple containing SDP, session ID, scope type/ID, protocol version, sender role, and intended peer key; TOFU pinning and fingerprint UX | P2-AUDIT-01 | With independently trusted/verifiable endpoint builds, fingerprint substitution plus cross-session, cross-agent, cross-host, cross-scope, protocol-version, role, and peer-key replay all make both endpoints abort loudly for agent and host sessions; unverified hosted JavaScript is explicitly not covered |

## Review-finding coverage

| Review finding | Scheduled resolution |
|----------------|----------------------|
| Dual session backends kept a plaintext multiplexer path, runtime escape hatch, content-derived display field, and non-migratable replay semantics | P2-TMUX-01, P2-PURGE-01 |
| Phase 2 omitted host list/read/write/transfer and had no agent-independent transport | P2-HOST-01, P2-HOST-02 |
| Tool installer output decision was unresolved and unattended errors persisted content | P2-HOST-03A, P2-HOST-03B |
| REST terminal input/snapshot remained server content surfaces | P2-TERM-02 |
| Resize/scroll/redraw/display-control exposed dimensions, deltas, and viewport timing | P2-AGENT-01, P2-TERM-02 |
| `Preset.env_template` and other launch values were omitted | P2-DATA-01, P2-DATA-02 |
| Default `Agent.name` copied the protected cwd basename and legacy rows retained it | P2-DATA-02, P2-PURGE-01 |
| Free-form daemon errors were forwarded/logged by the server | P2-ERROR-01, P2-PURGE-01 |
| No historical plaintext migration/purge or backup plan | P2-PURGE-01, P2-AUDIT-01 |
| v2 DataChannel input did not update `last_input_at` | GATE-02, GATE-05 |
| Scroll/copy-mode repaint suppression was incomplete | GATE-03, GATE-05 |
| Redis operational smoke still called the removed ring API | GATE-01 (`DONE`, `98b28b4`) |
| User-input and meaningful-output timing was undisclosed behavioral metadata | DOC-01 |
| Rust lossy decoding changed invalid-byte classifier behavior | GATE-04 |
| Activity throttle/suppression used wall-clock time | GATE-04 |
| Activity tests omitted throttle, suppression, emission/loss, input stamping, and server binary non-classification | GATE-05 |
| Increment 2 was described as removing the last v2 content despite `0x01` | DOC-01, P2-AGENT-01, P2-AGENT-02 |
| Progress said both suites pass while recording failures | DOC-01 |
| Trust inventory omitted directory size/mtime/errors and full tool detail | DOC-01, P2-HOST-02, P2-HOST-03A, P2-HOST-03B |
| Retained inventory omitted unattended-update and opaque-ciphertext leakage | DOC-01, P2-DATA-01, P2-AUDIT-01 |
| Purge omitted draining/restarts, process memory, swap/core, and observability | P2-PURGE-01, P2-AUDIT-01 |
| Trust-touched format plus pre-existing global fmt/Ruff/Clippy failures were untracked | QUAL-01–04 |
| Past-session text conflated recorded DTLS traffic with optional durable opaque blobs | DOC-01, P2-DATA-01, P2-AUDIT-01 |
| Phase 3 signaling claims did not qualify the trusted/verifiable endpoint-code assumption | DOC-01, P3-IDENTITY-01 |
| Signed signaling omitted host scope, protocol, role, and cross-scope replay binding | DOC-01, P3-IDENTITY-01 |
| Interactive tool transport and final/unattended route removal had one contradictory task | P2-HOST-03A, P2-HOST-03B |
| Phase 2 completion wording accidentally included the Phase 3 task | DOC-01, P2-AUDIT-01 |
| Documentation promised a new daemon transcript store without implementation/retention tests | DOC-01, P2-AGENT-01 |

## Parallel waves

1. **Wave 0 (complete):** DOC-01, GATE-01–05, and QUAL-01–05 passed
   independent review and are integrated on `master` through `640a2e0`.
2. **Wave 1 (complete):** P2-AGENT-01, its P2-TMUX-01 worker-only cutover, and
   P2-HOST-01 passed independent review and are integrated on `master` through
   `1f66d2d`.
3. **Wave 2 (active):** P2-AGENT-02/P2-TERM-02 are reviewed and integrated
   through `5722288`; P2-HOST-02 is implemented with independent review pending.
   P2-TERM-01 remains planned while P2-HOST-03A implements separate host-channel
   operations
   (rebasing/serializing shared route edits before merge). P2-DATA-01 design
   review may run alongside them once P2-HOST-01 fixes the transport boundary.
4. **Wave 3:** P2-DATA-02 after its design pass, then P2-HOST-03B and
   P2-ERROR-01 in parallel once durable preset/tool targets exist.
5. **Wave 4 (serial change window):** P2-PURGE-01, then P2-AUDIT-01. Historical
   deletion and the final claim cannot safely run in parallel with content-path
   migrations.
6. **Wave 5:** Phase 3 identity/signaling work after the Phase 2 claim is true.
