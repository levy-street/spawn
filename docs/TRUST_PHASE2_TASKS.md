# Trust Phase 2 — tracked task schedule

Last updated: 2026-07-15. Governing model: `docs/TRUST.md`. Build sequence and
purge runbook: `docs/TRUST_PHASE2.md`.

This is the execution ledger for the trust-model review. It distinguishes work
already shipped from corrective gates that must land before Increment 2 and
later work that depends on the new encrypted transports.

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
| BASE-00 | SHIPPED | Remove the unused production Redis PTY ring API (`e03fb3f`) | — | Runtime code removed; corrective smoke task GATE-01 remains |
| BASE-01 | SHIPPED | Move meaningful-output classification to daemon and emit content-free `agent.activity` (`4b245f1`) | — | Server no longer parses `0x01` payloads; correctness tasks GATE-02–05 remain |
| DOC-01 | ACTIVE | Expand trust inventory, transports, schedule, purge, retained metadata, and progress wording | — | Documentation diff is internally consistent and grounded in current routes/frames/models |

## Immediate gate — must finish before Increment 2

These tasks are intentionally small enough to run in parallel. All must be
`DONE` before `spawn.ctl` implementation starts.

| ID | Status | Scope | Depends on | Review/acceptance gate |
|----|--------|-------|------------|------------------------|
| GATE-01 | ACTIVE | Update `scripts/smoke-redis-pubsub.sh` after ring API removal; preserve the live pub/sub smoke and remove stale ring calls | BASE-00 | The smoke passes and `scripts/test-all.sh` no longer fails on `ring_append`/`ring_read`/`ring_clear` |
| GATE-02 | ACTIVE | Emit a content-free, monotonic-throttled daemon input-activity frame for `spawn.pty` input and stamp `last_input_at` after host/agent ownership validation | BASE-01 | A v2 DataChannel typing test produces the documented Input sent transition without server terminal bytes and preserves at-most-once-per-second disclosure |
| GATE-03 | ACTIVE | Cover every daemon-induced repaint suppression path, especially tmux scroll and copy-mode cancellation before stdin | BASE-01 | Tests prove scroll/resize/redraw/input echo do not create false output activity while later genuine output does |
| GATE-04 | ACTIVE | Correct classifier behavior for invalid/incomplete UTF-8 and split escape sequences; use monotonic throttle/suppression clocks | BASE-01 | Differential/boundary tests cover invalid bytes, multibyte chunk splits, escape splits, backward wall-clock changes, and the three-character threshold |
| GATE-05 | ACTIVE | Add end-to-end activity tests and remove dead server classifier/suppression code when imports reach zero | GATE-02, GATE-03, GATE-04 | Tests cover throttling, frame emission/backpressure, ownership rejection, input stamping, and binary output not stamping server activity |

## Phase 2 runtime schedule

The two transport roots, P2-AGENT-01 and P2-HOST-01, may proceed in parallel
after the immediate gate. Work beneath a root may parallelize only where its
protocol is already reviewed and stable.

| ID | Status | Scope | Depends on | Review/acceptance gate |
|----|--------|-------|------------|------------------------|
| P2-AGENT-01 | PLANNED | Add versioned per-agent `spawn.ctl`; move connect-time history and snapshot requests/responses to it | GATE-01–05 | Ordering/reconnect/size/error tests pass; v2 server sees neither history nor snapshot content; reviewer notes that `0x01` still remains |
| P2-AGENT-02 | PLANNED | Retire `spawn.v1`, daemon `0x01` output and `0x02` input, server transcript writes/history forwarding/pubsub relay | P2-AGENT-01 | Mandatory DataChannel behavior and old-client failure mode tested; server cannot receive live PTY bytes; offline-history regression documented |
| P2-HOST-01 | PLANNED | Add host-scoped WebRTC session and versioned `spawn.host.ctl`, independent of any agent | GATE-01–05 | Host with zero agents can connect; ownership, reconnect, cancellation, limits, request binding, TURN-only, and cross-host session isolation tests pass |
| P2-HOST-02 | PLANNED | Move host list/read/write/mkdir/rename/remove/download/upload/transfer and registration `home_dir` to host channel; browser mediates cross-host streaming | P2-HOST-01 | Server route/frame inventory has no host path or byte payload; streaming is bounded and hash/length checked; two-host authorization tests pass |
| P2-HOST-03 | PLANNED | Move tool check/install commands, paths, versions, detailed errors, stdout/stderr to host channel; relocate unattended executable policy to endpoint | P2-HOST-01 | Server receives only documented content-free schedule/result metadata and cannot persist `last_auto_update_error` detail; failure-output test stays E2E |
| P2-TERM-01 | PLANNED | Move agent uploads to chunked `spawn.ctl`; remove REST/WS `bytes_b64` upload legs | P2-AGENT-01 | Large-file, cancellation, retry, path-ack confidentiality, and bounded-memory tests pass |
| P2-TERM-02 | PLANNED | Remove REST terminal input/snapshot surfaces and migrate smoke/integration clients to an RTC endpoint harness | P2-AGENT-01, GATE-02 | No server request/response schema carries PTY or snapshot bytes; compatibility response is content-free and time-bounded |
| P2-DATA-01 | PLANNED | Approve endpoint-local versus opaque client-encrypted durable store for launch manifests, preset operational values, and skill bodies | P2-HOST-01 | Written threat model covers keys/recovery, multi-device behavior, offline restart, rollback, and migration verification; server never has decryption keys |
| P2-DATA-02 | BLOCKED | Move `cwd`, `argv`, `env`, preset install/environment values, and skill bodies over `spawn.host.ctl`; store daemon restart manifest locally | P2-DATA-01 | Agent create/restart and preset/skill edit/use work after server plaintext reads are disabled; server stores only disclosed metadata or opaque ciphertext |
| P2-PURGE-01 | BLOCKED | Inventory, migrate, close ingress, and purge transcript files, plaintext DB fields, legacy Redis ring keys/persistence, logs/temp/exports, WAL/AOF, backups, replicas, raw volume blocks, and deployment snapshots | P2-AGENT-02, P2-HOST-02, P2-HOST-03, P2-TERM-01, P2-TERM-02, P2-DATA-02 | Two-operator evidence follows the seven-step runbook; oldest remaining backup restore contains no recoverable plaintext; storage keys/volumes make deleted blocks unrecoverable; no content rollback path remains |
| P2-AUDIT-01 | BLOCKED | Final adversarial server audit and Phase 2 claim gate | P2-PURGE-01 | Code/route/frame/schema inventory, server-memory observation, disk/DB/Redis/log scan, backup evidence, TURN-only tests, and metadata disclosure all pass |
| P3-IDENTITY-01 | PLANNED | Endpoint keys, signed agent/host signaling, TOFU pinning, and fingerprint UX | P2-AUDIT-01 | A signaling server that swaps DTLS fingerprints makes both endpoints abort loudly |

`P2-DATA-02`, `P2-PURGE-01`, and `P2-AUDIT-01` are marked `BLOCKED` because
their declared dependencies do not exist yet, not because their scope is
optional.

## Review-finding coverage

| Review finding | Scheduled resolution |
|----------------|----------------------|
| Phase 2 omitted host list/read/write/transfer and had no agent-independent transport | P2-HOST-01, P2-HOST-02 |
| Tool installer output decision was unresolved and unattended errors persisted content | P2-HOST-03 |
| REST terminal input/snapshot remained server content surfaces | P2-TERM-02 |
| `Preset.env_template` and other launch values were omitted | P2-DATA-01, P2-DATA-02 |
| No historical plaintext migration/purge or backup plan | P2-PURGE-01, P2-AUDIT-01 |
| v2 DataChannel input did not update `last_input_at` | GATE-02, GATE-05 |
| Scroll/copy-mode repaint suppression was incomplete | GATE-03, GATE-05 |
| Redis operational smoke still called the removed ring API | GATE-01 |
| User-input and meaningful-output timing was undisclosed behavioral metadata | DOC-01 |
| Rust lossy decoding changed invalid-byte classifier behavior | GATE-04 |
| Activity throttle/suppression used wall-clock time | GATE-04 |
| Activity tests omitted throttle, suppression, emission/loss, input stamping, and server binary non-classification | GATE-05 |
| Increment 2 was described as removing the last v2 content despite `0x01` | DOC-01, P2-AGENT-01, P2-AGENT-02 |
| Progress said both suites pass while recording failures | DOC-01 |

## Parallel waves

1. **Wave 0 (active):** DOC-01 and GATE-01–04 in separate worktrees; GATE-05
   integrates the reviewed activity corrections.
2. **Wave 1:** P2-AGENT-01 and P2-HOST-01 in parallel after the gate.
3. **Wave 2:** P2-AGENT-02/P2-TERM-01/P2-TERM-02 on the agent protocol while
   P2-HOST-02/P2-HOST-03 run on the host protocol. P2-DATA-01 design review may
   run alongside them once P2-HOST-01 fixes the transport boundary.
4. **Wave 3:** P2-DATA-02 after its design pass and host transport merge.
5. **Wave 4 (serial change window):** P2-PURGE-01, then P2-AUDIT-01. Historical
   deletion and the final claim cannot safely run in parallel with content-path
   migrations.
6. **Wave 5:** Phase 3 identity/signaling work after the Phase 2 claim is true.
