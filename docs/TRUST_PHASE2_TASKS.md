# Trust Phase 2 — tracked task schedule

Last updated: 2026-07-17. Governing model: `docs/TRUST.md`. Build sequence and
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

Source guards follow [`GUARD_POLICY.md`](GUARD_POLICY.md): they enforce literal
machine surfaces and never interpret English semantics. Passing a guard does
not change a task status or replace independent review.

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
| QUAL-FLAKE-01 | DONE — REVIEWED, MERGED (`22c1f0c`) | Remove three observed baseline races without weakening assertions: centrally own, observe, drain, and cancel every background auto-update task; make local-daemon teardown bounded and scoped to stable launch plus worker identities before filesystem cleanup; gate persistent-agent create on an owner-authorized, content-free current-generation daemon ping after the intentionally failing agent is deleted | Completed baseline stability correction | Focused server repeats, cleanup/reconnect self-tests, repeated local-daemon smoke, trust guards, exact gates, and current-master mergeability passed with bounded fail-closed diagnostics |

QUAL-FLAKE-01 keeps all three independently reproduced failures visible with
their reviewed corrections, integrated at `22c1f0c`:

1. **DONE — REVIEWED, MERGED:** the server centrally owns, observes, drains,
   and cancels auto-update result-persistence tasks.
2. **DONE — REVIEWED, MERGED:** local-daemon cleanup is bounded and scoped to
   stable daemon and worker identities before private filesystem removal.
3. **DONE — REVIEWED, MERGED:** persistent-shell creation waits for an
   owner-authorized, content-free current-generation daemon ping after deletion
   of the capability-test agent.

The first candidate failed independent review. Its replacement added production
task ownership, stable process identity, content-free readiness, and fail-closed
platform/socket-path guards, reran the acceptance evidence, passed independent
review, and merged at `22c1f0c`.

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
through `5722288`; QUAL-FLAKE-01 is integrated through `22c1f0c`; the P2-HOST-02
filesystem cut is reviewed and integrated through `4e7c89b`; and P2-TERM-01 is
independently reviewed and merged through `5d99ebb4`.
Work beneath a root may parallelize only where its protocol is reviewed and
stable.

| ID | Status | Scope | Depends on | Review/acceptance gate |
|----|--------|-------|------------|------------------------|
| P2-TMUX-01 | DONE — REVIEWED, MERGED (`1f66d2d`) | Worker-only cutover: remove daemon tmux execution/module/backend selector/session-name protocol state and all tmux create/attach/adopt/discover/capture/replay/resize/scroll/copy/repaint paths; remove tmux-only replay/status filtering plus server/web `tmux_session` and `agent.rename`; add fail-closed guard and cutover ADR | P2-AGENT-01 implementation, QUAL-01 | Strict daemon/server/web gates pass; source inventory proves no production tmux execution, escape hatch, API/schema/UI field, or rename frame; real worker launch/adopt/replay/resize/input/shutdown remains covered; operator drain/restart and old-session unavailability are explicit; mergeability review passes |
| P2-AGENT-01 | DONE — REVIEWED, MERGED (`1f66d2d`) | Add versioned per-agent `spawn.ctl`; move history/snapshot plus resize/display ownership to the mandatory worker replay source | GATE-02–05, QUAL-01 | Ordering/reconnect/size/error and multi-viewer viewport tests pass; worker replay retains whole segments under its 8 MiB conservative total charge (ciphertext/framing + twice replay + bookkeeping), becomes unavailable after worker exit, and replays after `spawnd` restart/adoption; v2 server sees no history/snapshot/dimensions/deltas/event timing |
| P2-AGENT-02 | DONE — REVIEWED, MERGED (`5722288`) | Retire `spawn.v1`, daemon `0x01` output and `0x02` input, server transcript writes/history forwarding/pubsub relay; require both agent DataChannels and strict v2 signaling tuples | P2-AGENT-01 | All-target daemon compile, server/web suites, mandatory-channel and old-protocol failure tests, no-content guard, offline-history/cutover documentation, and mergeability review pass |
| P2-HOST-01 | DONE — REVIEWED, MERGED (`1f66d2d`) | Add host-scoped WebRTC session and versioned `spawn.host.ctl`, independent of any agent | GATE-02–05, QUAL-01 | Host with zero agents can connect; ownership, reconnect, cancellation, limits, request binding, TURN-only, and cross-host session isolation tests pass |
| P2-HOST-02 | DONE — REVIEWED, MERGED (`4e7c89b`) | Move host list/stat/read/write/mkdir/rename/remove/download/upload/transfer and registration `home_dir` to capability-rooted host channels; browser mediates bounded, bilaterally cancelled cross-host streaming; preserve pre-routing cancel publication, prompt token-based write cancellation, tracked cleanup, read-stream replay rejection, conservative `outcome_unknown`, and bounded close/publication semantics | P2-HOST-01, QUAL-03 | Server inventory has no host path/name/size/mtime/error or byte payload; no-follow/atomic-race tests, bounded dispatcher/page/stream/tombstone/reaper tests, forced fast/normal cancel-order and stalled-I/O control-path tests, browser redeclaration tests, distinct two-host authorization/abort tests, strict/full gates, and mergeability review pass |
| P2-HOST-03A | ACTIVE — IMPLEMENTED, REVIEW PENDING | Add the parallel interactive tool path on `spawn.host.ctl`: commands, paths, installed/latest versions, detailed errors, and stdout/stderr remain E2E while the legacy route is temporarily retained | P2-HOST-01, QUAL-03 | Independent review must prove bounded/cancellable interactive check/install and no new server content; compatibility route retention is explicit and Phase 2 remains incomplete |
| P2-HOST-03B | BLOCKED | Complete the tool cut: make the interactive endpoint path mandatory, remove the legacy server route, and relocate unattended executable policy/targets to the endpoint | P2-HOST-03A, P2-DATA-02, QUAL-03 | Durable endpoint owns `Preset.install`/default command before route removal; install consumes a durable tool-target effect generation and only conclusive version/package-manager proof resolves ambiguity; acknowledgement cannot authorize retry; server retains only disclosed policy/timestamps/content-free result and cannot persist detail |
| P2-TERM-01 | DONE — REVIEWED, MERGED (`5d99ebb4`) | Move agent uploads to capability/generation-bound, hash-checked, bounded/chunked/cancellable `spawn.ctl`; remove REST/WS/broker `bytes_b64`, saved/error, and daemon upload legs; retain the worker's canonical cwd as a no-follow descriptor-rooted destination capability | P2-AGENT-01, QUAL-04 | Large-file/chunk framing, resume/idempotency, cancellation/disconnect/replacement cleanup, checksum/length, capability/generation, symlink/escape/no-clobber, concurrent destination, path-ack confidentiality, old-peer failure, bounded-memory/cache/backpressure/retry tests, full gates, independent review, and current-master mergeability pass |
| P2-TERM-02 | DONE — REVIEWED, MERGED (`5722288`) | Remove REST/WS input/snapshot/resize/scroll/redraw/display-control surfaces and migrate test clients to RTC endpoint harness | P2-AGENT-01, GATE-02 | No server schema/frame carries PTY/snapshot/viewport data or event timing; old clients receive only a content-free protocol-required close; mergeability review passes |
| P2-DATA-01 | ACTIVE — BOUNDED DESIGN, REVIEW PENDING | Review the proposed per-host endpoint-local canonical store in `DURABLE_SENSITIVE_DATA.md`; explicitly defer opaque client-encrypted server blobs. This row covers a documentation candidate only, not a runtime migration or accepted design | P2-HOST-01, P2-HOST-02 | Independent review accepts the key hierarchy/ownership, crash-atomic two-slot anchor, browser/endpoint trust, recovery/export/import, multi-device/host and offline behavior, durable effect-generation anti-replay after result expiry, exact HOST-02/TERM-01/HOST-03A/DATA-02 journals, fail-before-effect capacity, rollback/replay limits, migration/cutover, revocation/rotation/deletion, quotas/conflicts, observability, compatibility failures, leakage comparison, rejected alternatives, and falsifiable DATA-02/HOST-03B/PURGE gates; server never receives a store/recovery key |
| P2-DATA-02 | BLOCKED | Implement the proposed store after DATA-01 review; move `cwd`, `argv`, `env`, preset default-command/install/environment values, tool targets, and skill bodies over `spawn.host.ctl`; store exact daemon restart manifests, monotonic effect heads, and durable ambiguous-effect reconciliation locally; wrap merged HOST-02 plus reviewed TERM-01/HOST-03A/DATA-02 effects; stop cwd-derived names | P2-DATA-01, P2-HOST-02, P2-TERM-01, P2-HOST-03A (all independently reviewed and merged) | Evidence names the exact reviewed TERM-01/HOST-03A protocol commits and effect boundaries; create/restart/preset/skill/tool/export/import/conflict/reconciliation flows work after plaintext reads are disabled; cap+1 fails before effect; replay after result expiry/restart/restore fails; offline daemon restart uses the committed manifest and preserves unresolved locks; acknowledgement never authorizes retry; rotation retains the old epoch until every wrapper and two consecutive A/B new-epoch anchor advances are synced/read-back/authenticated; both anchor modes pass torn-write/disk-full/power-loss tests; neutral default name used; legacy derived names scrubbed/reclassified; only disclosed metadata remains server-side; ADR adversarial gates pass |
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
rules are `DONE`. The Phase 3 foundations below may overlap that cleanup, but
their progress neither satisfies nor weakens any Phase 2 gate.

## Phase 3 foundation schedule

| ID | Status | Scope | Depends on | Review/acceptance gate |
|----|--------|-------|------------|------------------------|
| P3-IDENTITY-01A | DONE (`ab20cbc`) | Build the canonical cryptographic foundation: typed Ed25519 keys/signatures, deterministic signed-envelope encoding, domain separation, fingerprint representation, and cross-language test vectors. This does not enable signed signaling | P2-AGENT-01, P2-HOST-01 | Independent review passed deterministic canonical bytes, strict decode/re-encode rejection, key/signature vectors, weak-key rejection, malformed-input bounds, and mergeability |
| P3-IDENTITY-01B | DONE (`e34d412`) | Build host identity-key generation, protected persistence, fingerprint display, and explicit host-key pairing flows against the reviewed 01A contract | P2-HOST-01, P3-IDENTITY-01A | Independent review passed stable protected host identity, owner-authorized immutable pairing, concurrency/replay isolation, and mergeability; live signaling is still unsigned |
| P3-IDENTITY-02A | DONE (`37c91d4`) | Persist one account-scoped, non-extractable browser device identity in versioned, bounded IndexedDB storage; expose only its public key and bounded signing operations; fail closed on unavailable/corrupt storage; provide expected-public-key-bound local deletion | P3-IDENTITY-01A | Independent unit and native-browser review passed reload stability, first-creation tab convergence, nonextractability, account isolation, corruption failure, bounded records, expected-key deletion, and mergeability |
| P3-IDENTITY-02B | DONE (`3ec8b91`) | Bind the browser public key to its authenticated account with a canonical proof-of-possession transcript, durable active/revoked server registry, server-derived fingerprint, loud lifecycle registration, and expected-ID-plus-key revocation/local cleanup recovery. Static proof replay is idempotent only for the same account/key and uses no Redis challenge state | P3-IDENTITY-01A, P3-IDENTITY-02A | Independent review passed cross-runtime canonical-UUID vectors, strict fixed-width bounds, ownership/uniqueness/revocation tombstones, SQLite/PostgreSQL concurrency, private-material isolation, native-browser recovery UX, and mergeability; no live signaling/TOFU claim exists |
| P3-IDENTITY-02C | DONE (`6028b2a`) | Add strict Rust and browser JSON adapters around the signed offer/answer transcript, including exact key pins, bounded parsing, opaque browser-identity signing, and shared cross-language vectors; keep them off live WebSockets | P3-IDENTITY-01A, P3-IDENTITY-02A | Independent review passed exact field validation, sender/recipient pin comparison, all-field mutation and bounds rejection, cross-runtime parity, no secret-key exposure, protocol replay audit, and mergeability; no live signaling/L1 claim exists |
| P3-IDENTITY-02D | DONE — REVIEWED, MERGED (`7cc4ddc`, F8 hardening `8805622`) | Bind device-code approval to a fresh server nonce and exact active approving browser proof; transactionally create bounded immutable server Host/browser pins and return the exact browser tuple to poll; retain host-key ownership and fence deletion against stale ceremonies | P3-IDENTITY-01B, P3-IDENTITY-02B | Independent review passed cross-runtime proof vectors, host/browser/nonce substitution, revoked-before-poll rejection, immutable and 32-pin bounds, SQLite/PostgreSQL approve/revoke/poll/cap/delete/start races, same-owner post-delete repair, cross-owner retained-key rejection, deterministic migrations, native dual-fingerprint UX, response substitution, and mergeability. This is server/browser first contact only: daemon-local consumption is 02E and live signaling/TOFU remain unclaimed |
| P3-IDENTITY-02E | ACTIVE — CORRECTION/RE-REVIEW | Consume the server-mediated approving-browser tuple into a daemon-local, bounded immutable pin foundation; bind every retained pin set to the canonical server origin plus returned Host ID; scope OS-keyring entries to the canonical config-directory identity; keep Unix's complete mode-0600 file as its automatic commit point when the optional keyring is unavailable | P3-IDENTITY-01B, P3-IDENTITY-02B, P3-IDENTITY-02C, P3-IDENTITY-02D | The integrated checkpoint and current correction candidate cover strict tuple validation, cross-config keyring isolation plus conflict-checked default-only legacy migration, schema/CAS/durability/fallback/relogin failure modes, exact two-login pin preservation, status/log redaction, and cross-runtime crypto. Independent re-review and current-master mergeability are still required. The poll source remains server-mediated: this row alone does not give an expected live peer key independent provenance, activate a pin, or establish TOFU/L1 |
| P3-AUDIT-01 | ACTIVE — FINDINGS OPEN, HARD GATE | Preserve and disposition the independent [`TRUST_PHASE3_AUDIT.md`](TRUST_PHASE3_AUDIT.md) plus the implementation review of all Phase 3 foundations | P3-IDENTITY-01A, P3-IDENTITY-01B, P3-IDENTITY-02A, P3-IDENTITY-02B, P3-IDENTITY-02C, P3-IDENTITY-02D, P3-IDENTITY-02E | Foundation corrections require zero unresolved findings and independent re-review. The audit's F1–F8 are separate live prerequisites below; a foundation pass must not be reported as live MITM resistance |
| P3-LIVE-F1 | PLANNED — HARD BLOCKER | Preserve the exact signed 12-field envelope in **both** offer and answer directions. `ws/browser.py`, `ws/host.py`, and `ws/daemon.py` carry one bounded opaque/nested signed payload plus untrusted routing metadata; they never parse/re-serialize it or flatten routing extras into the strict envelope | P3-AUDIT-01 | Fix all three current reconstruction/strip sites; exact-signature strip tests fail closed. Choose and calculate one common bound that fits nesting plus current host WebSocket/Redis limits, enforce it at endpoint/relay/broker boundaries, preserve exact bytes for duplicate-key detection, and pass exact-limit/+1 tests |
| P3-LIVE-F2 | PLANNED — HARD BLOCKER | Make verified-signal types mandatory at RTC boundaries. Daemon `handle_offer`/`handle_host_offer` and browser agent/host remote-description helpers accept only `VerifiedRtcSignal`; WebRTC consumes only `verified.transcript.sdp`, with fingerprint change fatal | P3-LIVE-F1, P3-LIVE-F4 | Agent and host native exchanges pass signature-strip and raw-vs-verified-SDP substitution tests; no `setRemoteDescription` reads WS-message SDP, no raw caller remains, and a bounded source/type check protects those literal boundaries |
| P3-LIVE-F3 | PLANNED — HARD BLOCKER | Treat binding nonce/generation/topology and outer routing fields only as routing semantics. Each endpoint compares every outer duplicate and the verified transcript tuple against its own locally held pending session/scope/version/kind/role; ICE candidates are accepted only after the signed remote description | P3-LIVE-F1, P3-LIVE-F2 | Cross-session/agent/host/scope/version/role/topology replay aborts. Prefer no outer raw-SDP duplicate; if a routing duplicate exists, mismatch with both local state and verified inner tuple is fatal |
| P3-LIVE-F4 | ACTIVE — BROWSER HOST-PIN FOUNDATION REVIEWED, MERGED (`bc09105`, route-identity hardening `856061f`) | Establish reciprocal, independently persisted expected-peer pins. The reviewed browser foundation persists the locally derived/OOB-compared daemon key by exact account + canonical server origin, then binds bounded Host IDs only after an exact active key match; daemon selection and explicit OOB browser-pin activation remain separate required work. Never use a server-provided key as the verifier expectation | P3-IDENTITY-02D, P3-IDENTITY-02E | Reviewed limits are IndexedDB schema/record version 1, 256 retained active-or-tombstone keys total, and 8 observed canonical Host IDs per key. Approval writes/reactivates the exact local key before the server POST. Host-detail resolution first requires exact route/response identity and may establish the bounded active binding; deletion requires that pre-existing exact Host-ID-to-key binding, tombstones it before the same route-target DELETE, and never discovers or binds from deletion-time data. Partial failures are loud and retryable. Fake-IndexedDB and native Chromium coverage exercises strict keys/fingerprints, corruption/version/schema/cap, tab convergence, resolver refusal, split response/route IDs, key/fingerprint substitution, multiple active unbound pins, approval/deletion ordering, disappearance/reappearance, and exact explicit reapproval. The browser half is reviewed and merged; reciprocal daemon-pin activation and live signing remain open, so this status makes no TOFU-elimination or L1 claim |
| P3-BROWSER-TRUST-SCOPE | IMPLEMENTATION COMPLETE — RE-REVIEW PENDING | Scope every browser signer, host pin, warm terminal, and DataChannel capability to the canonical authenticated user UUID plus exact active browser registration and epoch. `LiveTerminalProvider` must observe auth even though it is mounted above `AuthGate`; `HostControlClient` construction always requires explicit per-destination local trust material | P3-LIVE-F4, P3-LIVE-F5 | The candidate synchronously aborts existing and pending terminal/HostControl/signing/pin capabilities on local or cross-tab invalidation, requires fresh `/me` plus registration before a peer tab can establish a new epoch, and centralizes HostControl construction behind exact account/device/key/epoch leases. Approval, resolution, and deletion guard every await and distinguish zero-effect pre-boundary aborts from retained local recovery and post-dispatch `outcome_unknown`. Each HostControl destination consumes its own exact active account + origin + Host-ID + key/fingerprint pin; H1→H2 distinct-pin and missing/swapped/revoked failures, captured-signer revocation, structural signer copy/wrapper/rebinding rejection, marker-write failure, replay retention, and raw-authority inventories are covered. Live RTC signing/verification and reciprocal daemon activation remain separate blockers, so this status makes no signed-signaling, TOFU, or L1 claim. Independent re-review and current-master mergeability remain required |
| P3-DAEMON-TRUST-RELOAD | ACTIVE — IMPLEMENTED, REVIEW PENDING | Replace `run()`'s one-time credential snapshot with one revisioned whole-record authorization snapshot, immediate pre-connect and post-handshake/pre-registration rereads plus a bounded 500 ms reload poll, and an RTC trust-epoch fence. Revalidate canonical server origin + exact Host ID and never mix token, host signing key, or pins across revisions | P3-IDENTITY-02E, P3-LIVE-F4 | Independent review must prove add/revoke activation, atomic token/key/pin rotation, same-revision substitution and rollback refusal, stale-offer/reconnect fencing, missing/unavailable/corrupt backend failure, config/keyring isolation, local live-daemon reconnect behavior, bounded resource/shutdown behavior, no secret disclosure, and current-master mergeability |
| P3-LIVE-UUID | PLANNED — HARD BLOCKER | Make every live session/scope/routing ID an exact lowercase-hyphen canonical UUID at generation and ingress. Remove `useAgentSocket.newRtcSessionId()`'s time/random fallback; require `crypto.randomUUID()` or an RFC 4122 UUID built from `getRandomValues`, otherwise fail closed | P3-IDENTITY-02C | Agent and HostControl generators, server outer routing, daemon, and browser reject uppercase/unhyphenated/braced/trimmed/arbitrary IDs rather than length-checking or normalizing. Unavailable CSPRNG creates no RTC session. Verified routing consumes the exact text without parse/reserialize drift |
| P3-LIVE-F5 | PLANNED — HARD BLOCKER | Derive every displayed/accepted host and browser fingerprint locally from a strict canonical public key and require exact equality throughout registration, pending review, approval, persistence, and live selection | P3-IDENTITY-02A, P3-IDENTITY-02B, P3-LIVE-F4 | Unit and native-browser tests substitute same-key/wrong-fingerprint and wrong-key/same-fingerprint responses at first contact and live use; no server string is accepted as fingerprint authority |
| P3-LIVE-F6 | PLANNED — HARD BLOCKER | Refuse null/unkeyed legacy Hosts and missing local identities/pins at `/ws/daemon`, `/ws/host`, `/ws/browser`, and both endpoint prerequisites; there is no unsigned compatibility fallback | P3-LIVE-F4 | Pre-0017/null-key rows cannot enter any signed signaling socket or RTC path; missing key/pin tests abort before relay/admission in all three server sockets and both endpoints |
| P3-LIVE-F7 | DONE — REVIEWED, MERGED (`4b35222`, strict-ingress hardening `8bc3cdc`) | Require fresh daemon host-key proof over the exact device code, approval nonce, and strict host key before activating browser review or token issue; preserve the F8 claim/deletion fence | P3-IDENTITY-01B, P3-IDENTITY-02D | Independent review passed Rust-produced/Python-verified fixed-width vectors, malformed/high-S/invalid-R and binding replay rejection, missing-proof fail-closed behavior, SQLite/PostgreSQL proof/delete/expiry races, pre-upgrade null proof migration, real daemon login and browser/daemon smokes, private-material isolation, strict unknown-field rejection, and mergeability |
| P3-LIVE-F8 | DONE — REVIEWED, MERGED (`8805622`) | Retain a durable host key→owner claim after Host deletion and a deletion/device-code revocation fence so old ceremonies cannot recreate or transfer the identity | P3-IDENTITY-02D | Independent review passed deletion, retries, restart, SQLite/PostgreSQL delete/start/poll races, same-owner re-pairing, stale device-code rejection, migration backfill/downgrade refusal, and permanent cross-owner claim rejection |
| P3-LIVE-CUTOVER | PLANNED — HARD BLOCKER | Make signed envelope presence/version unconditional by bumping affected WS subprotocols or enforcing a fatal signed-only shape on the existing routes; provide no missing-field/version negotiation or unsigned fallback | P3-LIVE-F1, P3-LIVE-F6 | Document a coordinated/non-rolling cutover. Old PWA assets and old daemons sending unsigned frames are rejected at server/daemon boundaries and create no RTC peer/session; coordinated old-browser/old-daemon downgrade tests pass |
| P3-IDENTITY-02 | BLOCKED — FINAL LIVE SIGNING/TOFU GATE | Integrate signed agent and host signaling only after F1–F8, strict live UUIDs, browser/daemon trust lifecycle closure, and the signed-only cutover pass; every offer/answer ingress is mandatory signed wire and every RTC consumer is verified-only | P3-LIVE-F1, P3-LIVE-F2, P3-LIVE-F3, P3-LIVE-F4, P3-BROWSER-TRUST-SCOPE, P3-DAEMON-TRUST-RELOAD, P3-LIVE-UUID, P3-LIVE-F5, P3-LIVE-F6, P3-LIVE-F7, P3-LIVE-F8, P3-LIVE-CUTOVER | All eight audit definition-of-done points pass for both directions and both scopes. With independently trusted/verifiable endpoint builds, fingerprint substitution and every signed-tuple replay abort loudly; unverified hosted JavaScript remains explicitly outside the guarantee |

The reviewed 01A, 01B, 02A, 02B, offline 02C, and merged 02D foundations plus
the reviewed 02E integration may proceed in parallel with remaining Phase 2
cleanup because they do not reopen a protected server content path. That
overlap does not complete
Phase 2 or establish a Phase 3 guarantee. P3-AUDIT-01 must pass before a
combined trust-model claim. The independent audit found the foundation sound
but the live path unsigned; P3-LIVE-F1 through F8 are mandatory prerequisites,
not optional follow-ups, for the separate P3-IDENTITY-02 integration gate.

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
| Phase 3 signaling claims did not qualify the trusted/verifiable endpoint-code assumption | DOC-01, P3-IDENTITY-01A, P3-IDENTITY-01B, P3-IDENTITY-02 |
| Signed signaling omitted host scope, protocol, role, and cross-scope replay binding | DOC-01, P3-IDENTITY-01A, P3-IDENTITY-02 |
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
   through `5722288`; QUAL-FLAKE-01 is reviewed and integrated through
   `22c1f0c`, P2-HOST-02 is reviewed and integrated through `4e7c89b`, and
   P2-TERM-01 is reviewed and merged through `5d99ebb4`. P2-HOST-03A has an
   implementation candidate under independent review. P2-DATA-01's
   endpoint-local design is documentation-only and awaits independent
   review/merge; it adds no runtime store or Phase 2 claim.
4. **Wave 3:** P2-DATA-02 after its design pass, then P2-HOST-03B and
   P2-ERROR-01 in parallel once durable preset/tool targets exist.
5. **Wave 4 (serial change window):** P2-PURGE-01, then P2-AUDIT-01. Historical
   deletion and the final claim cannot safely run in parallel with content-path
   migrations.
6. **Parallel Phase 3 foundation (active):** 01A, 01B, 02A, 02B, offline 02C,
   and 02D are reviewed and integrated. The 02E integration/correction
   candidate is undergoing independent re-review. `TRUST_PHASE3_AUDIT.md`
   confirms that the foundation is not a live defense: F1–F8 above must pass
   before final P3-IDENTITY-02 wiring or any MITM-resistance claim. In
   particular, F1/F2 are hard blockers, and reciprocal expected-peer
   provenance in F4 cannot come solely from server poll/Host API data.
