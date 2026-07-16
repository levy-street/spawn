# Trust Phase 2/3 — progress + resume notes

Working savefile for the "operator model" migration. Design spec:
`docs/TRUST_PHASE2.md`. Governing doc: `docs/TRUST.md`. Tracked execution
schedule: `docs/TRUST_PHASE2_TASKS.md`. Read all three first.

## What we're doing and why

A security audit found that the server **saw protected content**: even for v2
(DataChannel) clients the daemon mirrored PTY output to the server as plaintext
(`0x01` leg) → transcripts + Redis pubsub, and history/snapshot frames still
transited the server. The reviewed P2-AGENT-02/P2-TERM-02 cut now removes that
agent-terminal path. The reviewed P2-HOST-02 cut also removes host
paths/files/transfers from the server, while installer output, agent uploads,
launch values, preset environment templates, and skill bodies still have
server-readable paths or stores. Signaling is unsigned (server can MITM the
DataChannel). Goal of this work ("Tier 2"):

- **Phase 2** — server has no plaintext protected-content path or recoverable
  plaintext store. Acceptance includes runtime path tests plus primary and
  backup purge evidence; grep alone is insufficient.
- **Phase 3** — signed signaling + fingerprint pinning makes signaling MITM
  detectable to independently trusted/verifiable endpoint builds. A hostile
  operator can still replace an unverified hosted web client, disable the
  checks, or exfiltrate content.

## Done (committed on `master`)

| commit | increment | what |
|--------|-----------|------|
| `e03fb3f` | 0 | Deleted the dead Redis PTY ring buffer (`ws/ringbuffer.py`, `RedisBackend.ring_*`, `_InProcPubSub` ring methods, `config.ringbuffer_max_bytes`). No production callers; its stale operational smoke dependency is fixed below. |
| `98b28b4` | 0A | Repaired the real Redis pub/sub smoke after ring removal and added a test-matrix guard against stale ring calls. |
| `f69b5fc` | — | `docs/TRUST_PHASE2.md` implementation spec (the cut sequence). |
| `4b245f1` | 1 | Initial **content-free activity ping**: classifier moved daemon-side; server stopped parsing bytes for activity. |
| `ea8169f`, `8d5966e`, `4b00aff` | DOC-01 | Independently reviewed trust inventory, transport schedule, purge runbook, retained-metadata disclosure, and guarantee/sequence corrections. |
| `47b9c75`, `5b887bc`, `c7f3802`, `83c4295` | GATE-02–05 | Independently reviewed input activity, repaint suppression, streaming classifier, monotonic timing, producer ordering, bounded idle resolution, and activity-path test corrections. |
| `31d3442` | GATE-02–05 | Merge commit integrating the complete reviewed activity-correction series on `master`. |
| `ec1f86e` | QUAL-03 | Full Ruff baseline fixed. |
| `aa524d9` | QUAL-05 | Full server suite made hermetic against ambient auth-provider environment and prior migration connection state. |
| `1bb9fe9`, `775b7d0` | QUAL-02, QUAL-04 | Independently reviewed repository-wide daemon format cleanup and strict Clippy fixes. |
| `640a2e0` | QUAL-01–04 | Merge commit integrating the parallel format/Clippy cleanups; current reviewed Wave 0 checkpoint. |
| `1f66d2d` | P2-AGENT-01, P2-TMUX-01, P2-HOST-01 | Integrated the independently reviewed per-agent control root, worker-only/tmux-removal cutover, and host-scoped control root plus their hardening series on `master`. |
| `5722288` | P2-AGENT-02, P2-TERM-02 | Integrated the independently reviewed server-terminal relay removal, mandatory two-channel agent RTC gate, strict v2 signaling, and bounded lifecycle teardown series on `master`. |
| `22c1f0c` | QUAL-FLAKE-01 | Integrated the independently reviewed task-ownership, bounded cleanup, and current-generation host-ping stability corrections. |
| `4e7c89b` | P2-HOST-02 | Integrated the independently reviewed capability-rooted host filesystem migration, bounded browser-mediated transfer, cancellation/effect-boundary handling, and server path removal. |

### Increment 1 detail (the keystone)

- `daemon/src/activity.rs`: streaming, stateful output classifier. It consumes
  arbitrary UTF-8 and terminal-sequence chunk boundaries in producer order,
  retains bounded candidate state, and requires ≥3 meaningful characters.
- `daemon/src/pty.rs`: monotonic per-agent input/output throttles and output
  suppression state; activity eligibility is decided at the producer so later
  resize/input/redraw events cannot retroactively change a queued chunk.
  Ambiguous status-like fragments resolve after a bounded idle interval.
- `daemon/src/proto.rs`: content-free `agent.activity` and
  `agent.input_activity` frames.
- `daemon/src/rtc.rs` and `daemon/src/run.rs`: DataChannel input stamps
  input activity, while input echo, resize, redraw, scroll, and copy-mode
  repaint paths suppress false output activity.
- `server/spawn_server/ws/daemon.py`: handle `agent.activity` → stamp
  `last_output_at`, and handle `agent.input_activity` → stamp
  `last_input_at`, after host/agent ownership validation. The server does not
  classify `0x01` bytes. Server and daemon tests cover the moved behavior.

**Historical Increment 1 validation:** daemon `cargo test --bins --lib` = 40
pass; the full server run recorded 127 passed and 2 failed
(`test_auth_providers`, `test_migrations`), so it was not a passing full suite.
**Deployed + live-validated** on dev: this session's
`last_output_at` updates via `agent.activity` (server no longer sees bytes for
activity); no post-restart `unknown frame` logs; no errors.

The later comprehensive review found the Redis smoke regression, v2 input
timestamp gap, incomplete repaint suppression, streaming-classifier and clock
boundary issues, missing integration coverage, and global format/Ruff/Clippy
drift. Those findings are now all corrected, independently reviewed, and
integrated through `640a2e0`. The originally recorded failures above remain
historical facts; they should not be rewritten as a passing run.

**Historical integrated validation at `640a2e0`:** strict repository-wide daemon
format and Clippy checks pass; `cargo test --locked` passes 113 daemon tests;
full server Ruff passes; the hermetic full server suite passes 128 tests; and
the real-Redis pub/sub smoke passes.

## Exactly where we're up to

Wave 0 is complete on `master` through `640a2e0`: the expanded trust design,
Redis smoke repair, all activity correctness gates, hermetic server baseline,
and repository-wide format/Ruff/Clippy cleanup passed independent review.

Increment 1's output-activity path is **shipped to the dev stack**. It made the
later mirror cut possible by removing the server's need to inspect terminal
bytes for activity.

Wave 1 is complete on `master` through `1f66d2d`: P2-AGENT-01,
P2-TMUX-01, and P2-HOST-01 passed independent review and were integrated. The
per-agent `spawn.ctl`, mandatory worker-only backend, and independent
host-scoped `spawn.host.ctl` roots are therefore established.

The reviewed P2-AGENT-02/P2-TERM-02 terminal-relay cut is integrated on
`master` through `5722288`. The application server no longer has live terminal,
replay, snapshot, or viewport content paths; both agent DataChannels and strict
v2 signaling tuples are mandatory.

The QUAL-FLAKE-01 stability correction passed independent review and is merged
at `22c1f0c`. Server auto-update tasks are centrally owned and drained,
local-daemon cleanup is bounded and tied to stable process identities, and the
persistent-agent smoke waits on an owner-authorized, content-free
current-generation `host.ping`/`host.pong` exchange.

P2-HOST-02 passed independent review and is integrated on `master` at
`4e7c89b`. Host home/list/stat/read/write/mkdir/rename/remove, browser
download/upload, and browser-mediated cross-host transfer use bounded,
capability-rooted host DataChannels. Registration `home_dir`, filesystem REST
routes, server broker waiters/result schemas, and daemon `host.fs.*` frames are
removed. Its conservative `outcome_unknown` effect boundary and no-automatic-
retry rule are inputs to P2-DATA-01; the durable cross-restart reconciliation
journal remains DATA-02 work and is not claimed by HOST-02.

**P2-TMUX-01 cutover checkpoint (reviewed and merged):** production daemon
creation/adoption/replay/input/resize/shutdown paths use `spawn-worker`; the
tmux module, backend selector/env escape hatch, session-name protocol state,
tmux discovery/attach/capture/copy/repaint paths, exact tmux replay buffer, and
tmux-status classifier/tests are deleted. `scripts/check-worker-only-daemon.sh`
guards that boundary in `scripts/test-all.sh`. The decision and operator
boundary are recorded in `docs/TMUX_REMOVAL.md`.

This merged source checkpoint has not deployed, restarted a service,
signalled a live process, or deleted an external session. Old sessions cannot
be transparently migrated and are intentionally unavailable to the new daemon.
Operators must close ingress, drain them under a change window, install both
worker-only binaries, restart, and later complete P2-PURGE-01. Rollback cannot
restore the retired content path. The server/API/web `tmux_session` display
field and `agent.rename` frame are removed in this checkpoint because their
derived labels were not guaranteed content-free.

**P2-AGENT-02/P2-TERM-02 checkpoint (reviewed and merged):** daemon
WebSocket `spawn.control.v2` is JSON-only; browser WebSocket `spawn.v2` is
mandatory; the `0x01` output and `0x02` input frames, `spawn.v1`, transcripts,
agent-content Redis pubsub, server snapshots/history/display state, browser
binary fallback, and REST input/resize/scroll/redraw/snapshot routes are gone.
Both `spawn.pty` and `spawn.ctl` are required for an agent RTC peer. Old
clients and daemons receive only `protocol.required` then close. Strict binding
tuples and `scripts/check-no-server-terminal-content.sh` fail closed against a
content path returning. The daemon acknowledges the shared two-channel gate
with a `spawn.ctl` v1 `ready` event; browsers keep PTY input and control
requests in bounded generation-scoped queues until that event, then fail the
RTC attempt on the existing 10-second connection/bootstrap deadline.

**Accepted P2-AGENT-02 review validation:** strict daemon format and
Clippy pass; all 140 daemon tests pass; server Ruff and all 146 server tests
pass; web lint, all 30 unit tests, 68 browser tests (3 opt-in audits skipped),
and the production build pass. `SPAWN_E2E_PORT=3791 scripts/test-all.sh` passes
all repeatable checks plus local installer, HTTP, Redis, owner-recovery, login,
daemon, live-browser, and service-manager smokes.

This merged source checkpoint is not deployed, does not purge historical
copies, and does not complete Phase 2. Offline history is now an explicit
non-feature: replay is available only from a live endpoint worker; when the
host is offline or the worker exits, the server has no transcript to show.
Historical transcript files, Redis/AOF/WAL, logs, memory, swap, cores, backups,
replicas and snapshots remain in P2-PURGE-01 scope.

**P2-DATA-01 design checkpoint (implemented, independent review pending):**
`docs/DURABLE_SENSITIVE_DATA.md` selects a per-host endpoint-local canonical
store. It explicitly rejects an opaque client-encrypted server store as the
Phase 2 canonical source and forbids server key escrow, plaintext fallback,
dual-write, browser-only canonical storage, and last-write-wins. The design
covers the AEAD/key hierarchy, browser and endpoint trust, multi-device/host
regressions, offline daemon restart, account recovery and encrypted
export/import, CAS/replay/rollback semantics and limitations, migration,
rotation/revocation/deletion, quotas, authenticated metadata, observability,
compatibility failures, endpoint-durable `outcome_unknown` reconciliation,
exact retained server metadata, and hand-offs to
P2-DATA-02/P2-HOST-03B/P2-PURGE-01. Ten falsifiable acceptance gates are
defined.

The first DATA-01 review candidate was rejected. The corrected design now keeps
durable monotonic per-target/root anti-replay heads after retry-result expiry;
fails request 4,097 before effect while 4,096 younger-than-24h results are
retained; journals exact HOST-02 filesystem, TERM-01 upload, HOST-03A install,
and DATA-02 launch identities/preconditions before effect; forbids
acknowledgement/dismissal from unlocking retry; and specifies separate immutable
key epochs plus crash-atomic two-slot mutable anchors. A section-aware guard
with hostile comment/dead-section, duplicate/missing-section, unsafe-retry,
capacity, anchor, and stale-status fixtures must pass before rereview. These are
still design requirements, not implemented runtime behavior.

The next rereview also rejected the candidate until three additional contracts
were explicit: active-prose contradictions must fail the structured guard even
when comments/fences contain a safe decoy; rotation must retain the old epoch
until every wrapper and two consecutive A/B new-epoch slot advances are
durably synced/read-back/authenticated; and DATA-02 must wait for reviewed,
merged TERM-01/HOST-03A protocols and name their exact commits. This document
records those corrections for another independent rereview; it does not claim
they have passed.

This checkpoint is documentation only. No endpoint store, protected-data
DataChannel operation, migration, server-column clearing, deployment, or purge
has occurred, and P2-DATA-02 remains blocked until the decision passes review
and is merged.

## Remaining sequence

1. Independently review and merge the current P2-TERM-01 direct agent-upload
   candidate. P2-HOST-02 is already reviewed and merged at `4e7c89b`; do not
   restore its server filesystem path while integrating later branches.
2. Finish independent review of the parallel P2-HOST-03A interactive installer
   candidate. Keep the legacy tool route until its endpoint-owned durable
   targets exist; this wave is not the final tool cut.
3. Only after this P2-DATA-01 decision, P2-TERM-01, and P2-HOST-03A have each
   passed independent review and merged (with the already merged P2-HOST-02),
   implement the approved per-host endpoint-local store in P2-DATA-02 and name
   the exact reviewed protocol/effect-boundary commits in its evidence. Move
   full launch manifests, `Agent.env`, preset environment/install/tool targets,
   and skill bodies into it over `spawn.host.ctl`. Preserve the explicit
   offline-host and cross-host-sync regressions in
   `DURABLE_SENSITIVE_DATA.md`; do not introduce a protected server queue as a
   convenience fallback.
   Stop cwd-derived default names, then make the interactive E2E tool path
   mandatory, remove its legacy server route, finish unattended tool migration,
   and replace free-form server-visible daemon errors with E2E details.
4. Only after replacements and endpoint recovery tests pass, drain/restart
   server paths and run the historical plaintext purge across process memory,
   disk/DB/Redis, swap/core dumps, logs/observability, and every backup/snapshot.
   Verify the oldest retained restore before making the Phase 2 claim.
5. Phase 3 adds Ed25519 host keys, browser device keys, and signed signaling
   bound to SDP, session, agent-or-host scope, protocol version, sender role, and
   intended peer key. Trusted/verifiable endpoints test fingerprint substitution
   and cross-session/cross-scope replay for both agent- and host-scoped peer
   connections; unverified operator-hosted JavaScript remains outside that
   guarantee.

## Operational playbook (how to build/deploy/validate — no secrets here)

**Topology.** Two daemons share the oem dev box:
- `spawnd.service` → **PROD** (`spawnd.dev`, AWS, an *earlier* commit). Binary
  `~/.local/bin/spawnd`. **DO NOT TOUCH.**
- `spawnd-dev.service` → **DEV** (dream → the minivac dev web instance).
  Binary `~/.local/bin/spawnd-dev` (separate!), with workers under
  `~/.local/state/spawn-dev/workers`. This is where THIS session's agent
  (`9e4e2296`) runs.
- Dev server + web on **minivac**: `systemctl --user` units
  `spawn-dev-server.service` (127.0.0.1:18330) and `spawn-dev-web.service`
  (0.0.0.0:8330). Repo at `~/projects/spawn`; web build needs
  `SPAWN_API_PROXY_TARGET=http://127.0.0.1:18330`.

**Deploy the daemon (dev):** do not deploy this cutover as an ordinary hot or
mixed-version restart. Follow `docs/TMUX_REMOVAL.md`: close ingress, inventory
and drain old sessions without capture, build/install both `spawnd` and
`spawn-worker`, deploy the matching server and web assets in the same change
window, then restart and verify worker adoption/replay. `spawn.v1` components
are intentionally incompatible and must fail closed. Compatible workers
survive a supervisor restart; old sessions are unavailable. Remediation is a
corrected content-free roll-forward, never re-enabling tmux or a WS relay.

**Deploy the server (dev):** `git push origin master` → `ssh minivac 'cd
~/projects/spawn && git pull --ff-only && systemctl --user restart
spawn-dev-server.service'`. For P2-AGENT-02 there is no backward-compatible
rolling order: use the coordinated drain/restart above.

**Validate live:** mint a dev session token server-side
(`auth.issue_session_token(user_id)` on the dev box — details + the user/host
ids are in the private `reference_dev_playwright_token` memory, deliberately not
committed), then `curl -H "Cookie: spawn_session=<tok>" <dev-web>/api/agents`
and check `activity_state` / `last_output_at`, or drive Playwright from `web/`
with the cookie.

**Tasks:** `docs/TRUST_PHASE2_TASKS.md` is the repository task ledger and maps
every review finding to an implementation, independent review, merge, and
acceptance gate.
