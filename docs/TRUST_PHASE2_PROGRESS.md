# Trust Phase 2/3 — progress + resume notes

Working savefile for the "operator model" migration. Design spec:
`docs/TRUST_PHASE2.md`. Governing doc: `docs/TRUST.md`. Tracked execution
schedule: `docs/TRUST_PHASE2_TASKS.md`. Read all three first.

## What we're doing and why

A security audit found that the server **saw protected content**: even for v2
(DataChannel) clients the daemon mirrored PTY output to the server as plaintext
(`0x01` leg) → transcripts + Redis pubsub, and history/snapshot frames still
transited the server. The reviewed P2-AGENT-02/P2-TERM-02 cut now removes that
agent-terminal path. The reviewed P2-HOST-02 cut removes host paths/files/
transfers from the server, and the independently reviewed P2-TERM-01 cut merged
at `5d99ebb4` removes agent uploads. Installer output, launch values, preset
environment templates, and skill bodies still have server-readable paths or
stores. Signaling is unsigned (server can MITM the DataChannel). Goal of this
work ("Tier 2"):

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
| `22c1f0c` | QUAL-FLAKE-01 | Integrated the independently reviewed task-lifecycle and smoke stability corrections. |
| `4e7c89b` | P2-HOST-02 | Integrated the independently reviewed capability-rooted host filesystem channel, bounded streaming/cancellation, conservative `outcome_unknown`, shutdown/publication, and temp-cleanup hardening series on `master`. |
| `5d99ebb4` | P2-TERM-01 | Integrated the independently reviewed direct agent-upload migration, durable browser reconciliation boundary, bounded endpoint cleanup, server upload-path removal, and final fixed-signal capability correction on `master`. |

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
`4e7c89b`: host home/list/stat/read/write/mkdir/rename/remove, browser
download/upload, and browser-mediated cross-host transfer use bounded,
hash-and-length-checked DataChannel streams. Registration `home_dir`, filesystem
REST routes, server broker waiters/result schemas, and daemon `host.fs.*` frames
are removed.

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
findings.

The latest review made the close/effect boundary explicit. A mutation that
passes the session effect fence may finish after peer close, so lost
acknowledgements for dispatched mkdir/rename/remove operations and writes after
`stream.end` now surface as stable `outcome_unknown`, never as proof of
rollback; the browser does not retry and must reconcile endpoint state first.
Deterministic tests pause both before and after effect authorization, prove the
single close deadline, cancel and drain every claimed DataChannel send before
that deadline, make any late-polled callback take cancellation before
`send_text`, suppress new sends after close, and verify write-temp cleanup.
Host control also rejects
unordered or partially reliable
DataChannels, suppresses hello/connected publication when close wins the open
race, and bounds the deliberately external close invoker with a tested hard
deadline. A session-owned temporary registry now exists before upload-temp
creation. Its per-temp claim lets close remove unpublished and pre-commit temps
without waiting behind unrelated linearized mutations; already-linearized
commits retain the conservative `outcome_unknown` rule. Cleanup syscalls run in
accounted blocking closures and cannot extend the single close deadline, even
when an unlink itself stalls.

**Accepted P2-HOST-02 review validation:** daemon format and
strict all-target Clippy pass; all 169 daemon tests pass; server Ruff and all
149 server tests pass; web lint, typecheck, all 54 unit tests, 68 Playwright
tests with retries disabled (3 opt-in audits skipped), and the production build
pass. `SPAWN_E2E_PORT=43957 scripts/test-all.sh` also passes the full repeatable
matrix, including prebuilt install, HTTP, Redis, PostgreSQL owner recovery,
login, daemon lifecycle, live-browser, and service-manager smokes. No
P2-HOST-02 worker process remains afterward.

The merged P2-HOST-02 implementation includes the reviewed worker-only and
agent-relay checkpoints and retains both source guards. Its conservative
`outcome_unknown` effect boundary and no-automatic-retry rule are inputs to
P2-DATA-01; the durable cross-restart reconciliation journal remains DATA-02
work and is not claimed by HOST-02.

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

**P2-TERM-01 checkpoint (reviewed and merged at `5d99ebb4`):** agent upload names,
bytes, hashes, endpoint paths, cancellation, and detailed results move off both
REST/WS legs onto bounded kind-2 chunks on the direct `spawn.ctl` DataChannel.
The stream is bound to a fresh per-channel capability and exact worker-backend
generation; stable upload UUIDs support bounded resume/idempotency. The daemon
validates exact chunk order/length/final flag and SHA-256, applies per-viewer and
global admission limits plus a bounded completion cache, and cleans private
temporary files on error, cancellation, disconnect, or replacement. The
worker protocol is version 5 so launched/adopted workers retain a canonical
local cwd. Upload commits use retained no-follow directory descriptors, mode
0600 same-directory temporary files, and atomic no-clobber final links; invalid
or old peers fail closed. Server routes, schemas, broker waiters, browser and
daemon upload frames, and web API helpers are removed. Legacy frames close
without logging names, paths, errors, or payloads.

The accepted correction series requires both agent DataChannels to be ordered
and fully reliable. Upload preparation, write/sync, link, unlink, and directory
sync are owned blocking operations with tracked permits; session/generation
teardown uses one absolute deadline and keeps per-viewer/global capacity charged
until real descriptor/temp cleanup finishes. Successful final linking records
the completion cache before fallible unlink/fsync cleanup. Post-link cleanup
failure, or browser timeout/abort/disconnect after final chunk dispatch, is the
stable `outcome_unknown` result and is never retried automatically. Remove,
unmount, and RTC-generation replacement abort browser uploads, send best-effort
`upload_cancel`, and cannot resurrect UI state from late completion. A Remove
before final dispatch stays a silent definite cancellation; after final
dispatch the thumbnail still disappears but the reconciliation warning remains
visible. Hashing, backpressure, chunk reads, and acknowledgement waits recheck
the abort signal, immutable RTC generation, and exact open control-channel
identity after every await. The same checks run immediately before and after
the reconciliation promotion and synchronously before final send, so a queued
late completion cannot overtake cancellation or replacement. Upload admission
atomically returns `Inserted`, `Existing`, or `Complete` under the hub lock;
only `Inserted` prepares a descriptor/temp, while `Existing` performs exact
owner, manifest, lifecycle, and resume checks. Before `upload_start`, the
browser durably reserves one of eight
agent-scoped reconciliation slots without eviction. Full capacity or a storage
fault refuses the upload with zero endpoint effect. Immediately before the
final frame it durably promotes that reservation to `outcome_unknown`; a failed
promotion cancels before publication. Same-tab memory and history-state
fallbacks preserve a failed-write identity, warning, and global upload lock
across component/navigation remounts. The fault poisons every overlapping
reservation; restored storage or another successful write cannot clear it or
let a stalled upload dispatch. Even simultaneous `sessionStorage` and history
fallback failures retain the in-memory lock, notify mounted consumers
best-effort, and surface only the typed blocked result. A successful
acknowledged completion or
explicit checked dismissal frees a slot only after the removal persists. The
record is independent of the transient three-second status and attachment
lifetime, and no warning offers retry. Control-channel teardown publishes
cancellation and viewer removal immediately. Every callback for that peer
shares an immutable
first-close deadline, including delayed sender, state, duplicate, invalid, and
replacement paths. The tracked cleanup owns the RTC admission token until
transport, fence, registries, and uploads actually settle, so map removal does
not free capacity and stalled churn remains inside the global peer cap.
Teardown also reschedules retained post-publication unlink/fsync cleanup; a
failure stays charged and a later session/generation teardown retries it.

**Accepted P2-TERM-01 review and merge validation:** focused
daemon upload tests pass, including partial resume/conflict, global-64 and
completed-cache-128/TTL pressure, prepare/sync/commit/cleanup stalls, retained
capacity, cancellation races, and repeated post-link unlink/fsync failure with
session/generation retry, zero temp/FD/operation residue, idempotent
publication, and barrier-controlled same/different-owner concurrent starts
with exactly one preparation/temp and no slot replacement. Deterministic paused-time RTC tests prove delayed duplicate,
sender, and state closes cannot gain a new deadline, and a stalled cleanup
retains its admission slot across peer-map removal and replacement churn until
zero residue. A real paired-WebRTC regression drives the actual PTY and control
sender loops to failure, stalls their DataChannel-close path, then proves a
delayed duplicate and peer-state close reuse the sender's original deadline;
both labels settle with no peer, closing-registry, sink, task, or admission
residue. The real-peer gate rejects unordered,
packet-lifetime-limited, and retransmit-limited `spawn.pty` and `spawn.ctl`
channels without resident state. TypeScript and the browser protocol unit suite
pass; focused browser tests cover declared reliability, large multi-chunk
transfer, non-immediate `bufferedAmount` drain, Remove-driven cancellation, and
lost final acknowledgement without retry. Gated final-Blob-read races prove
Remove and RTC-generation replacement dispatch no final frame, publish nothing,
and ignore a queued late completion without losing definite/ambiguous state.
Browser coverage also advances more
than three seconds under a fake clock, applies later ordinary status, removes
the attachment, and unmounts/navigates/remounts the terminal while the durable
reconciliation record remains until explicit post-check dismissal. Browser
storage-fault coverage proves reservation failure has zero endpoint effect,
pre-final promotion failure cancels without publication, post-final failure
retains exactly one ambiguity without retry, eight unresolved records refuse a
ninth before `upload_start`, a concurrent fault permanently blocks older
stalled reservations, dual storage/history failure remains typed and visible to
overlapping consumers, and checked dismissal after recovery frees capacity.
Paired real WebRTC tests cover
verified multi-chunk publication, a stalled-cleanup control close within one
deadline with replacement isolation and eventual zero residue, and a lost
final acknowledgement that reconciles the same stable ID on a replacement
channel without a duplicate destination. The production-source upload guard
has only exact audited direct host-channel allowances; its adversarial self-test
rejects privileged-file relays before and after test modules and in moved
helpers. Strict daemon format and all-target
Clippy pass; all 60 library, 124 daemon, and 8 worker-E2E tests pass; server Ruff
and all 134 server tests pass; web lint, all 55 unit tests, 83 Playwright tests
(3 opt-in audits skipped), and the production build pass.
`SPAWN_E2E_PORT=45342 scripts/test-all.sh` passes the full repeatable matrix,
including prebuilt install, HTTP, Redis, PostgreSQL owner recovery, login,
daemon lifecycle, live-browser, and service-manager smokes. Current-master
mergeability passed at final review. Independent re-review found no remaining
issues after the fixed-signal capability was moved and pinned in
`daemon/src/host_signal.rs`; the reviewed series was integrated on `master` at
`5d99ebb4`.

The reconciliation ledger is intentionally tab-local: a new tab or browser
restart is not covered by this Phase 2 safety state. P2-DATA-01/P2-DATA-02 must
define the future durable endpoint-owned journal and cross-restart recovery
boundary. Its hard eight-record cap is an explicit availability/DoS tradeoff:
eight unresolved or durability-blocked records stop all new uploads until the
user checks endpoint state and successfully persists explicit dismissals. No
record is silently evicted to regain service.

This reviewed source is merged but not deployed, does not purge historical
copies, and does not complete Phase 2. Offline history is now an explicit
non-feature: replay is available only from a live endpoint worker; when the
host is offline or the worker exits, the server has no transcript to show.
Historical transcript files, Redis/AOF/WAL, logs, memory, swap, cores, backups,
replicas and snapshots remain in P2-PURGE-01 scope.

**P2-DATA-01 bounded design candidate (independent review pending):**
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

Earlier DATA/HOST guard experiments tried to interpret Markdown and English
security claims. That scope is intentionally stopped. Audit backups remain on
`backup/p2-data-guard-interrupted-20260716` and
`backup/p2-host-guard-interrupted-20260716`; neither those branches nor the
complex guard commits on `review/p2-data-design` are merge candidates. The
salvaged design prose is reviewed normally.

[`GUARD_POLICY.md`](GUARD_POLICY.md) is now permanent: source guards enforce
machine-readable rows, schemas, routes, APIs, required files, and small literal
forbidden sets. They never parse English semantics, render Markdown/HTML, or
maintain a generated prose inventory. The bounded shell guard can detect a
missing canonical marker; it cannot approve this ADR or prove a runtime claim.

**Parallel Phase 3 foundations:** reviewed P3-IDENTITY-01A is integrated at
`ab20cbc`; reviewed P3-IDENTITY-01B is integrated through `e34d412`; and
reviewed P3-IDENTITY-02A is integrated at `37c91d4`; reviewed browser account
registration P3-IDENTITY-02B is integrated at `3ec8b91`; and the reviewed
offline signed-wire adapter P3-IDENTITY-02C is integrated at `6028b2a`. These
establish canonical Ed25519 transcripts, durable daemon pairing keys,
account-scoped non-extractable browser-local keys, and strict offline adapters.
They do not make live signaling signed.

**P3-IDENTITY-02A browser identity (reviewed and integrated at `37c91d4`):** the bounded
browser library now persists one versioned, account-scoped, non-extractable
Ed25519 private key in IndexedDB and exposes only the public key plus an opaque
signing operation. Serialized first-writer creation makes concurrent tabs load
one winner; every reload validates record shape, algorithm/usages, canonical
public bytes, and private/public correspondence before use. Corrupt or
unavailable storage fails without rotation, storage is capped at 32 accounts,
and local deletion is bound to the expected public key. Focused fake-IndexedDB
unit tests and native Chromium tests cover persistence, nonextractability,
convergence, account separation, corruption/mismatch, unavailable storage, and
deletion.

This is a local storage/library foundation only. It is not wired to server
registration, login, pairing, TOFU, signaling, or any API payload, and it does
not make agent or host signaling signed. The private key remains an opaque
non-extractable `CryptoKey`; no private bytes or JWK are exported, logged, put in
Web Storage, or sent to the server. Its independent review and mergeability
gate passed before integration.

**P3-IDENTITY-02B account registry (reviewed and integrated at `3ec8b91`):** an
authenticated browser signs the fixed-width, domain-separated
`SPAWN-BROWSER-REGISTER-V1` transcript containing the server-authenticated user
UUID and exact browser public key. The server strictly preflights key/signature
wire widths, reuses the accepted non-weak Ed25519 contract, verifies possession,
derives the fingerprint, and records one globally account-bound immutable key
with a retained revocation tombstone. Same-account/key registration is
idempotent. Static proof replay is therefore possible only for that same
authenticated account/key; no challenge or Redis state is required.

Authenticated browser lifecycle registration is loud but does not lock users
out of logout, settings, device listing, revocation, or recovery. Revocation
requires both server device ID and expected public key. A current-browser
revocation records public-key-only local cleanup state, deletes the IndexedDB
key only after server confirmation, exposes retry after partial failure, and
requires an explicit action before generating a replacement. No private key,
JWK, or signature enters Web Storage or logs.

P3-IDENTITY-02B by itself does **not** bind a browser key into daemon host
pairing, add peer-key discovery or TOFU continuity, or wire signatures into
live agent/host RTC signaling. No live signaling/TOFU security claim exists.

**P3-IDENTITY-02D server/browser host-pair binding (implemented, independent
review pending):** each device-code ceremony now receives a fresh server nonce.
The approving browser signs a fixed-width `SPAWN-HOST-PAIR-APPROVE-V1`
transcript containing the authenticated user UUID, exact nonce, reviewed host
Ed25519 key, and exact active registered browser Ed25519 key. Approval compares
the complete reviewed host/browser tuple, verifies possession, and snapshots it
with a one-shot conditional update. Poll rechecks that the browser registration
is still active, so revocation before consumption fails closed without issuing a
token, creating a Host, or creating a pin.

Successful poll transactionally creates or reuses the exact Host and inserts an
immutable Host/browser pin containing both public-key snapshots. Each Host may
hold at most 32 such pins; Host admission is serialized on PostgreSQL and
write-serialized on file SQLite. Independently approved ceremonies at the final
slot race to exactly one success, while the loser receives a stable `pin_limit`
error and leaves no partial pin or token. Pending, approval, and poll responses
carry the exact host/browser presentations, and the browser loudly rejects a
substituted response. The confirmation UI displays both fingerprints before the
user authorizes the link.

**P3-IDENTITY-02D audit F8 revocation rule:** deleting a keyed Host revokes the
live Host row, every server Host/browser pin, and every pending, approved, or
consuming device-code ceremony for that exact key in one serialized database
transaction. The server retains a durable exact Ed25519 key-to-original-owner
claim. A fresh ceremony committed after deletion may intentionally re-pair the
same key only to that original account; another account remains fail-closed
unless a future explicit ownership-transfer ceremony is designed. Device
start, approval, poll, and deletion share the retained claim as their first
keyed write boundary, so delete-versus-start/poll linearizes on SQLite and
PostgreSQL without releasing the binding. Daemon disconnect is best-effort
external cleanup after the durable commit, not the revocation boundary.

This is only the server/browser first-contact half of pairing. P3-IDENTITY-02E
must separately make the daemon validate and persist the returned browser pin;
02D makes no daemon-local pin, peer discovery, live-signaling, or TOFU claim.
Later server revocation can block an unconsumed approval, but it cannot erase a
pin already persisted by a daemon in 02E.

The P2-DATA-01 checkpoint described above remains documentation only. No
endpoint protected-data store, DataChannel operation, migration, server-column
clearing, deployment, or purge has occurred, and P2-DATA-02 remains blocked
until the decision passes review and is merged.

## Remaining sequence

1. Preserve the reviewed P2-TERM-01 server-upload-path removal merged at
   `5d99ebb4` and the P2-HOST-02 filesystem cut merged at `4e7c89b`; do not
   restore REST/WS compatibility content paths while integrating later work.
2. Finish independent review of the bounded P2-DATA-01 design and the parallel
   P2-HOST-03A interactive installer candidate. In parallel, independently
   review P3-IDENTITY-02D without claiming daemon-local pin persistence, TOFU,
   or signed signaling. Keep the legacy tool route
   until its endpoint-owned durable targets exist; this wave is not the final
   tool cut.
3. Only after P2-DATA-01 and P2-HOST-03A have passed independent review and
   merged (with P2-HOST-02 and P2-TERM-01 already merged), implement the
   then-reviewed per-host endpoint-local store in P2-DATA-02. Its evidence must
   name exact reviewed protocol/effect-boundary commits, including TERM-01 at
   `5d99ebb4` and the future accepted HOST-03A commit. Move full launch
   manifests, `Agent.env`, preset environment/install/tool targets, and skill
   bodies into it over `spawn.host.ctl`. Preserve the explicit offline-host and
   cross-host-sync regressions in `DURABLE_SENSITIVE_DATA.md`; do not introduce
   a protected server queue as a convenience fallback.
   Stop cwd-derived default names, then make the interactive E2E tool path
   mandatory, remove its legacy server route, finish unattended tool migration,
   and replace free-form server-visible daemon errors with E2E details.
4. Only after replacements and endpoint recovery tests pass, drain/restart
   server paths and run the historical plaintext purge across process memory,
   disk/DB/Redis, swap/core dumps, logs/observability, and every backup/snapshot.
   Verify the oldest retained restore before making the Phase 2 claim.
5. After P3-IDENTITY-02D passes its own review, implement separately reviewed
   P3-IDENTITY-02E daemon validation and durable local pin consumption. Only
   then separately integrate peer-key discovery, TOFU/fingerprint continuity,
   and signed signaling bound to SDP, session,
   agent-or-host scope, protocol version, sender role, and intended peer key.
   Trusted/verifiable endpoints must reject fingerprint substitution and
   cross-session/cross-scope replay for both agent- and host-scoped peer
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
