# Trust Phase 2/3 — progress + resume notes

Working savefile for the "operator model" migration. Design spec:
`docs/TRUST_PHASE2.md`. Governing doc: `docs/TRUST.md`. Tracked execution
schedule: `docs/TRUST_PHASE2_TASKS.md`. Read all three first.

## What we're doing and why

A security audit found that the server **saw protected content**: even for v2
(DataChannel) clients the daemon mirrored PTY output to the server as plaintext
(`0x01` leg) → transcripts + Redis pubsub, and history/snapshot frames still
transited the server. The reviewed P2-AGENT-02/P2-TERM-02 cut now removes that
agent-terminal path. The current P2-HOST-02 review candidate also removes host
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

P2-HOST-02 now has an integrated implementation candidate on its isolated
review branch: host home/list/stat/read/write/mkdir/rename/remove, browser
download/upload, and browser-mediated cross-host transfer use bounded,
hash-and-length-checked DataChannel streams. Registration `home_dir`, filesystem
REST routes, server broker waiters/result schemas, and daemon `host.fs.*` frames
are removed in that branch. This is **IMPLEMENTED, REVIEW PENDING**, not an
integrated or `DONE` claim.

The first P2-HOST-02 review rejected the candidate for path-resolution races,
serial DataChannel read deadlock, check-then-rename clobbering, incomplete
bilateral transfer aborts, unbounded directory aggregation, and inadequate
two-host isolation coverage. The revised candidate uses a held capability root
and no-follow directory handles, atomic no-replace rename, separate bounded
ACK/cancel dispatch, explicit bounded directory pages/UI retention, bilateral
abort cleanup, and real distinct-host paired-channel coverage.

The next review found three cancel/lifecycle races: active-write cancel fell
through to channel close, split fast/normal queues could reorder cancellation
ahead of earlier frames on both endpoints, and per-write cleanup sleepers were
untracked. Corrections return handled cancellation, stamp frames before queue
routing, use bounded expiring cutoff tombstones on daemon and browser, and own
one tracked session reaper that drains at close.

The following review found that stamping alone was insufficient: the fast
consumer still published the write-cancel cutoff too late, cancellation could
wait on an active file-write lock and its disk cleanup, and the browser could
accept a new read declaration that reused a cancelled stream ID. The current
candidate synchronously assigns each arrival ordinal and publishes stream
cancel cutoffs in one short per-session arbiter critical section before queue
routing. Any later write chunk/end fails closed even while the fast consumer is
backlogged. Active writes have cancellation tokens; fast cancel removes and
tombstones the stream, signals its token, and enqueues bounded cleanup without
waiting for file I/O. One tracked session maintenance task owns cleanup and
idle reaping, and cancelled temporary files are dropped and unlinked without a
pointless flush. Browser read declarations reject active and tombstoned IDs.
Forced fast-delay cancel-then-chunk/end, stalled-write ACK/cancel survival,
prompt cleanup, browser declaration replay, paired-channel backlog/reuse,
rapid write-churn shutdown, and distinct-host isolation regressions cover these
findings. Independent review is still required before merge.

**Current integrated P2-HOST-02 candidate validation:** daemon format and
strict all-target Clippy pass; all 156 daemon tests pass; server Ruff and all
143 server tests pass; web lint, typecheck, all 48 unit tests, 68 Playwright
tests with retries disabled (3 opt-in audits skipped), and the production build
pass. `SPAWN_E2E_PORT=43831 scripts/test-all.sh` also passes the full repeatable
matrix, including prebuilt install, HTTP, Redis, PostgreSQL owner recovery,
login, daemon lifecycle, live-browser, and service-manager smokes. No
P2-HOST-02 worker process remains afterward.

The P2-HOST-02 candidate includes the reviewed worker-only and agent relay
checkpoints and must retain both source guards through review.

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

## Remaining sequence

1. Independently review and merge the P2-HOST-02 filesystem migration, then
   migrate agent uploads, which still use a server-visible route.
2. Ship the parallel E2E path for interactive installer detail. Keep the
   legacy tool route until its endpoint-owned durable targets exist; this wave
   is not the final tool cut.
3. Move full launch manifests, `Agent.env`, preset environment/install/tool
   targets, and skill bodies to the approved endpoint-owned/encrypted store.
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
