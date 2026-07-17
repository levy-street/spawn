# Trust Phase 2/3 — progress + resume notes

Working savefile for the "operator model" migration. Design spec:
`docs/TRUST_PHASE2.md`. Governing doc: `docs/TRUST.md`. Tracked execution
schedule: `docs/TRUST_PHASE2_TASKS.md`. Read all three first.

## Permanent decision: do not revive tmux

P2-TMUX-01 is finished, independently reviewed, and merged. `spawn-worker` is
the only production session backend. A report about behavior that used to be
implemented by tmux must be rewritten as a `spawn-worker` requirement; it must
not become a tmux repair, compatibility, fallback, test-restoration, or
incident-recovery task. Do not add tmux repair TODOs. Reversal requires a new
ADR and explicit trust-boundary review. The full maintenance and cutover rule
is in `docs/TMUX_REMOVAL.md`, and `scripts/check-worker-only-daemon.sh` guards
the source boundary.

## What we're doing and why

A security audit found that the server **saw protected content**: even for v2
(DataChannel) clients the daemon mirrored PTY output to the server as plaintext
(`0x01` leg) → transcripts + Redis pubsub, and history/snapshot frames still
transited the server. The reviewed P2-AGENT-02/P2-TERM-02 cut now removes that
agent-terminal path. The reviewed P2-HOST-02 cut removes host paths/files/
transfers from the server. The current P2-TERM-01 review candidate also removes
agent uploads, while installer output, launch values, preset environment
templates, and skill bodies still have server-readable paths or stores.
Signaling is unsigned (server can MITM the DataChannel). Goal of this work
("Tier 2"):

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
agent-relay checkpoints and retains both source guards.

P2-HOST-03A now has an implementation candidate on its isolated review branch.
The hosts page fetches only disclosed preset ID/name, agent kind, policy, and
timestamps from `GET /api/hosts/{id}/tool-targets`; it sends target ID/tool kind
over `spawn.host.ctl`. The endpoint alone resolves the executable and runs
fixed, versioned direct argv for checks/installs. Commands, resolved paths,
versions, install argv, stdout/stderr, truncation, and detailed errors remain
browser↔endpoint E2E. The implementation reuses the reviewed host capability
and generation binding, ordered/reliable admission, bounded queues,
request/cancel binding, publication fence, absolute close deadline, zero-agent
operation, and reconnect behavior.

This is **IMPLEMENTED, REVIEW PENDING**, not integrated or `DONE`. Execution is
fail closed: unknown payload fields and arbitrary path/argv are rejected; no
shell evaluates browser input; target/process/output/time limits are fixed;
same-tool installs across the interactive and retained compatibility paths are
mutually exclusive; cancellation, close, and timeout kill a per-attempt Linux
cgroup v2 containment. The generated Linux user service deliberately does not
request `Delegate=`: delegation alone cannot stop a same-UID tool from moving
itself into a writable ancestor and is not a trust boundary. Before exec, the
endpoint instead applies Landlock ABI 3 filesystem mutation confinement and an
inherited, architecture-reviewed seccomp filter. Tool writes are limited to
HOME, temporary/runtime roots, and `/dev/null`; cgroup hierarchy writes, namespace
and mount manipulation, ptrace/process-memory and fd-stealing APIs, BPF/perf,
io_uring setup, and AF_UNIX manager connections are denied. All inherited FDs
above stderr are marked close-on-exec. On x86-64, x32-tagged syscall numbers
are killed before native syscall dispatch or its default allow. Execution fails
closed when cgroup v2, Landlock, or the reviewed seccomp architecture is
unavailable. Once
installation starts, any non-success, teardown, failed reconciliation, or lost
acknowledgement is `outcome_unknown`, is never retried automatically, and must
be reconciled with a separate `tool.check` whose idle effect-generation token
is unchanged through atomic completion.

Tool subprocesses, every descendant admitted before exec to their per-attempt
cgroup, and their stdout/stderr drain tasks are owned independently of request
and DataChannel tasks. The daemon is a child subreaper. Process,
session-long-task, and same-tool install permits remain held until the cgroup
reports `populated 0`, inventoried descendants are waited/reaped, both pipes
have finished or been aborted and joined, and the cgroup directory is removed.
A single absolute cleanup deadline covers freeze, PID inventory, population,
direct-child wait, raw reap, and recursive removal. Filesystem inventories and
removal run off the async runtime; a timed-out task stays owned by the
containment and is awaited without a concurrent retry. Partial PID inventories
are retained, and a post-kill `/proc` cgroup-membership scan finds adopted
zombies that `cgroup.procs` no longer reports. Any residual containment is
registered atomically in a capped quarantine before process capacity or effect
claims are released. That quarantine globally rejects new tool processes and
cannot reconcile an ambiguous install until its tracked reaper drains and a
new definitive check succeeds. Repeated pre-spawn failures settle their empty
cgroups through the same ownership path and do not accumulate capacity or
cleanup workers.
A successful direct parent that leaves a closed-stdio `setsid` descendant
behind is killed and reported as a failed operation; its permit cannot be
released while that descendant survives. Regressions also prove that a
fork/exec descendant cannot move to the parent cgroup or ask a same-UID
AF_UNIX user-manager surrogate to launch outside containment, while ordinary
HOME writes and AF_INET sockets remain available. Session close
still obeys its one absolute deadline while late cleanup remains tracked;
multi-target failure cancels and drains every started sibling. The browser
exposes an explicit cancel action, preserves structured endpoint error
codes/data, treats a lost post-spawn cancellation acknowledgement or late
success as `outcome_unknown`, ignores protected late output, and directs the
user to check status before any manual retry. An unknown outcome is retained
in typed, per-host/target browser query state across navigation and component
remounts; its reconciliation is bound to the exact preset ID and agent kind
that ran. `Check now` fetches fresh authoritative metadata before its endpoint
check and again before clearing the lock, so no-remount metadata drift cannot
clear it. Every interactive effect first disables legacy auto-update through
the policy endpoint and confirms the fresh authoritative target; the daemon's
shared gate also inhibits any already-racing compatibility installer.
Install/update and enabling legacy auto-update stay locked until an explicit
`Check now` returns one definitive, error-free, internally consistent status.
Built-in policy is keyed
by canonical disclosed `agent_kind`; in particular, preset `aider-sonnet` maps
to `aider` at both endpoint and browser boundaries and unknown kinds fail
closed.

Installer exit zero is not success by itself. The endpoint acknowledges
success only after a bounded direct-argv reconciliation positively observes a
recognizable installed version, a latest-version expectation, and no remaining
update. A latest-version observation is accepted only from an exit-zero,
non-truncated capture with no containment/capture failure and a recognizable
numeric version. Nonzero/timeout/cancel/session-close probes, an exit-zero
parent with a detached descendant, and ambiguous or contradictory statuses
return structured `outcome_unknown`. Tool execution
uses the daemon service environment plus fixed user-bin conventions; it does
not invoke or depend on a login shell to discover `PATH`.

The old REST `/tools` and `/install` endpoints, server `host.tools.*` frames,
plaintext durable preset install/default-command target, and unattended update
path remain deliberately retained for P2-HOST-03B. Therefore this parallel
interactive path does not complete the tool migration or Phase 2. A
tracked-plus-unignored production source inventory guard rejects server use of
the new E2E operation names, metadata helper/route/schema expansion, UI use or
aliasing of the legacy interactive helpers, computed routes/operations,
browser/endpoint shell fallbacks (including aliased arrays and `.join()`
chains, encoded strings, generically named dependencies, unresolved spawn
arguments, and `.args(["-c"])`), moved operation names,
login-shell probing, protected logging, and canonical-policy drift. Python AST,
TypeScript AST, and a locked parsed Rust helper bind the reviewed routes,
protected field accesses, API helpers, reconciliation logic, parser rules,
process-launch sites, and command policy. The Python boundary has a zero
baseline for `operator.attrgetter` imports, references, aliases, containers,
subscripts, returned callables, and statically constructed reflection strings.
The Rust boundary pins the parsed token structure of every production daemon
source and separately inventories function-item references, generic syscalls,
dynamic-loader symbols, escaped FFI link names, lexical aliases, glob/type/
extern imports, and macro token trees. Comments or unreachable duplicate
sentinels cannot satisfy those structural checks. The exact HOST-03B compatibility inventory,
tool-failure handling, and expanded adversarial `--self-test` run from
`scripts/test-all.sh`.

**Current P2-HOST-03A candidate validation:** daemon format and strict
all-target Clippy pass; all 194 daemon tests pass (60 library, 126 supervisor,
8 worker E2E). Server Ruff and all 150 server tests pass. Web lint, typecheck,
all 60 unit tests, a retry-free Playwright run with 74 passing tests and 3
opt-in audits skipped, and the production build pass. The focused endpoint
tool suite has 25 adversarial tests, the browser host-control suite has 37,
the paired zero-agent host channel covers bounded close with independently
owned late tool cleanup, and the metadata-only server regression passes.
`SPAWN_E2E_PORT=44531 scripts/test-all.sh` passes the complete repeatable
matrix, including the adversarial boundary self-test plus prebuilt install,
HTTP, Redis, PostgreSQL owner recovery, login, daemon lifecycle, live-browser,
and service-manager smokes. No review pass or merge is claimed by this
validation. The corrected reconnect suite additionally passed 30 consecutive
runs while the expanded adversarial boundary self-test ran concurrently.

**P2-TMUX-01 cutover checkpoint (reviewed and merged):** production daemon
creation/adoption/replay/input/resize/shutdown paths use `spawn-worker`; the
tmux module, backend selector/env escape hatch, session-name protocol state,
tmux discovery/attach/capture/copy/repaint paths, exact tmux replay buffer, and
tmux-status classifier/tests are deleted. `scripts/check-worker-only-daemon.sh`
guards that boundary in `scripts/test-all.sh`. The decision and operator
boundary are recorded in `docs/TMUX_REMOVAL.md`.

This is a permanent architecture constraint, not a paused migration. Do not
schedule tmux repair work or add tmux repair TODOs. Restate any affected
user-visible behavior against `spawn-worker`; reversing the cutover requires a
new ADR and trust-boundary review.

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

**P2-TERM-01 checkpoint (implemented, review pending):** agent upload names,
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

The current correction series requires both agent DataChannels to be ordered
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

**Current P2-TERM-01 correction validation (review still pending):** focused
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
mergeability passes: `master` at `4e7c89b` is the candidate's exact merge base
and the simulated merge tree equals the candidate tree. Independent re-review
is still required before acceptance or merge.

The reconciliation ledger is intentionally tab-local: a new tab or browser
restart is not covered by this Phase 2 safety state. P2-DATA-01/P2-DATA-02 must
define the future durable endpoint-owned journal and cross-restart recovery
boundary. Its hard eight-record cap is an explicit availability/DoS tradeoff:
eight unresolved or durability-blocked records stop all new uploads until the
user checks endpoint state and successfully persists explicit dismissals. No
record is silently evicted to regain service.

This is still a source checkpoint: it is not merged or deployed, does not purge
historical copies, and does not complete Phase 2. Offline history is now an
explicit non-feature: replay is available only from a live endpoint worker;
when the host is offline or the worker exits, the server has no transcript to
show. Historical transcript files, Redis/AOF/WAL, logs, memory, swap, cores,
backups, replicas and snapshots remain in P2-PURGE-01 scope.

## Remaining sequence

1. Independently review and merge the P2-TERM-01 direct agent-upload candidate,
   including current-master integrated-host coexistence; do not restore a
   REST/WS compatibility upload path for old peers.
2. Independently review and merge the implemented parallel E2E path for
   interactive installer detail. Keep the legacy tool route until its
   endpoint-owned durable targets exist; this wave is not the final tool cut.
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
