# Trust Phase 2 — implementation spec (server holds no protected content)

Companion to `docs/TRUST.md` Phase 2. This revised cut sequence covers both
agent-scoped terminal traffic and host-scoped operations. Each increment must
be independently reviewed and shippable, but the Phase 2 claim is made only
after the historical-data purge and final inventory pass. Grep is one check,
not proof that old plaintext has left disks, databases, Redis, or backups.

## Current source reality (P2-TERM-01 review candidate)

- `spawn-worker` is the only session backend. Its bounded encrypted-at-rest
  replay log is the live endpoint's only history source; tmux execution and
  fallback are retired and guarded against reintroduction.
- Agent terminals require two ordered WebRTC DataChannels: `spawn.pty` carries
  PTY bytes and `spawn.ctl` carries request-bound history/snapshot plus
  resize/display ownership and bounded agent uploads. Missing, duplicate,
  closed, unknown, or unordered
  channels fail closed, with no server-content fallback. Neither channel's
  message handler may affect the worker or viewer state until one shared gate
  has observed both required channels open successfully; pre-ready frames are
  dropped rather than buffered through the counterpart timeout. Once that gate
  and control-viewer registration succeed, the daemon emits the bounded
  `spawn.ctl` v1 `{"kind":"event","event":"ready"}` acknowledgement. The
  browser holds input and control requests in its existing bounded,
  generation-scoped queues until that event and tears down/retries the RTC
  attempt if readiness plus initial replay do not complete within 10 seconds.
- The daemon control socket requires `spawn.control.v2`; the browser agent
  socket requires `spawn.v2`. Both are text/JSON-only signaling and disclosed
  lifecycle. Binary terminal frames,
  `spawn.v1`, the `0x01`/`0x02` relay, transcripts, agent-content Redis pubsub,
  and server history/snapshot/display relay are removed in the reviewed
  P2-AGENT-02 cut. Browser RTC offer/candidate/close frames bind
  the exact agent/scope/protocol/version/nonce tuple.
- A reviewed host-scoped `spawn.host.ctl` transport root is integrated and
  works independently of any agent. The merged P2-HOST-02 implementation moves
  host list/stat/read/write/mkdir/rename/remove, browser download/upload, and
  browser-mediated cross-host transfer onto bounded capability-rooted streams
  on that channel.
- Host directory/file REST routes, server broker waiters/result schemas,
  daemon `host.fs.*` frames, and registration `home_dir` are removed in the
  merged source. Host paths, entry metadata, file bytes, hashes, and
  detailed filesystem errors therefore remain endpoint-to-endpoint.
- Tool checks and installs also use server↔daemon control frames. Installer
  `output` and `error` can contain arbitrary commands, paths, and secrets;
  `HostToolPolicy.last_auto_update_error` persists a detailed error derived
  from the result.
- REST and WebSocket terminal input/snapshot/resize/scroll/redraw/display
  surfaces are removed. The P2-TERM-01 candidate also removes both agent-upload
  routes, browser/daemon upload WebSocket frames, broker waiters, schemas, and
  base64 payloads; old upload frames close fail-closed without logging content.
  Upload names, bytes, endpoint paths, hashes, cancellation, and detailed
  results now remain on the direct per-agent `spawn.ctl` channel.
- `Agent.cwd`/`argv`/`env`, `Skill.content`, and
  `Preset.default_argv`/`env_template`/`install` are plaintext database fields.
  Preset templates are merged into the launch environment in `routes/agents.py`;
  the resulting launch manifest transits the server in `agent.create`.
- When no explicit name is supplied, `_default_agent_name` copies the protected
  `cwd` basename into the retained `Agent.name` column. Existing rows do not
  record whether a name was explicit or derived.
- Daemon `Outbound::Error.message` frames contain full `anyhow` chains (often
  including cwd/file paths). Upload-specific frames are removed in the
  P2-TERM-01 candidate, but other detailed status/exit strings can still be
  forwarded or logged.
- Removing current and future writes is insufficient: existing transcript files, database
  values, derived names, server/observability logs, legacy
  `spawn:agent:*:ring` Redis keys, and infrastructure backups/snapshots remain
  readable until explicitly purged.

## Increments

### 0 — delete the dead Redis ring buffer  ✅ done (`e03fb3f`)

Zero production callers. `ws/ringbuffer.py`, `RedisBackend.ring_*`,
`_InProcPubSub` ring methods, `config.ringbuffer_max_bytes`. The operational
Redis smoke still referenced the removed methods and was repaired by `98b28b4`;
the real pub/sub smoke and a test-matrix guard now pass without the ring API.

### 1 — content-free output activity ping ✅ shipped (`4b245f1`)

The daemon now classifies PTY output and emits metadata-only
`agent.activity {agent_id}` frames. The server stamps `last_output_at` and no
longer inspects `0x01` bytes for activity. This intentionally discloses the
coarse time at which meaningful output occurred; `docs/TRUST.md` lists that as
retained behavioral metadata.

### 1A — activity correctness gate ✅ done

Before the terminal relay cut, this gate added content-free,
monotonic-throttled input activity for DataChannel input; daemon-owned repaint
suppression; streaming invalid/incomplete UTF-8 and escape-sequence handling;
and monotonic throttle/suppression timing. Its regression suite covers every
suppression source, producer ordering, bounded classifier carry, output/input
frame emission, and channel backpressure/drop behavior. The removed binary PTY
path is no longer an activity source.

Trust-touched Rust formatting is also a pre-Increment-2 gate. Repository-wide
formatting, lint, and Clippy debt is tracked separately from trust correctness in
`docs/TRUST_PHASE2_TASKS.md`; pre-existing unrelated findings do not silently
become Phase 2 blockers, but any file touched by a trust task must leave its
relevant gate clean.

### 2 — DataChannel control channel (`spawn.ctl`) + endpoint replay ✅ reviewed and merged

The browser and daemon now require `spawn.pty` and `spawn.ctl`. The latter
carries bounded, request-bound JSON control plus chunked binary replay from the
worker's encrypted rolling log. Connect history, snapshots, resize, and
display ownership no longer transit the application server. An endpoint-only
PTY byte anchor orders replay against live bytes because separate ordered
DataChannels do not share a total order.

This increment reuses the worker's actual resource-budgeted history; it does
not add a durable daemon transcript archive. The worker keeps an
encrypted-at-rest rolling log with an 8 MiB conservative total resource charge
by default: exact ciphertext/framing, twice the replay representation, and
retained log/path bookkeeping. It removes whole oldest segments before new
admission and rejects a checkpoint that cannot fit by itself. The key remains
only in the live worker process. An append/checkpoint admission failure destroys
and disables replay while live output continues. Acceptance covers its
retention boundary, replay after `spawnd` restart/adoption, and history becoming
unavailable after the underlying worker exits.
Browser-side history beyond those bounds is not a server backup and is outside
the reconnect guarantee.

The same channel carries resize/scroll/redraw, multi-viewer display ownership,
and their acknowledgements. The daemon, not the server, arbitrates viewport
state so geometry, deltas, and event timing remain E2E.

`spawn.ctl` v1 is implemented as bounded request-bound JSON plus chunked binary replay frames.
Worker replay propagates its durable output watermark into the same producer
coordinate as live frames. Each producer boundary is translated through the
viewer's attach origin into an exact
`spawn.pty` offset. RTC callbacks also carry an immutable backend-generation
binding and a teardown fence, preventing a late callback from resolving the
same agent UUID to a replacement backend. The browser uses the explicit offset
and a bounded bootstrap queue because ordering on one DataChannel does not
imply ordering against the other. Slow viewers are disconnected from bounded
queues and catch up through replay on reconnect. This transport root passed
independent review and was integrated through `1f66d2d`; it does not by itself
make the Phase 2 claim.

### 3 — retire the WS terminal relay and server content stores ✅ reviewed and merged

The reviewed P2-AGENT-02 cut removes the daemon binary output/input
sink, server transcript writes and forwarding, agent-content pubsub, browser
binary fallback, `spawn.v1`, and the old REST/WS terminal viewport surfaces.
The daemon and server require their exact v2 subprotocols, every browser RTC
signal carries the full agent tuple, and invalid mandatory DataChannel shapes
remove the peer, viewer, and direct sink. The accepted regression is that an
offline or exited worker has no history replay; there is no server transcript
to show. Historical copies still require Increment 8 purge evidence.

### 4 — host-scoped E2E control transport (`spawn.host.ctl`) ✅ reviewed and merged

The browser and daemon create a WebRTC session keyed by `host_id`, not `agent_id`, with
a `spawn.host.ctl` DataChannel. The control plane authenticates the browser,
checks host ownership, mints TURN credentials, and forwards offer/answer/ICE;
it never receives DataChannel messages. The session remains usable when the
host has zero agents.

The channel uses versioned request/response envelopes with unguessable
`request_id`, operation type, bounded metadata, cancellation, explicit size
limits, and chunked binary streams with length/hash verification. The daemon
authorizes operations to its own host identity; the browser binds every
response to the requested host/session. Phase 3 adds signed signaling to both
agent- and host-scoped peer connections.

The transport root is intentionally separable from the content migrations in
Increment 5. Its reviewed, merged cut uses a dedicated
`/ws/host` signaling websocket, binds each RTC session to browser connection,
daemon connection, host scope, protocol, and version, and exposes only a
bounded `hello`/`ping` request-response primitive. Its acceptance covers
ownership, zero-agent, TURN-only, reconnect, cancellation, size, and
cross-scope behavior. Those gates passed before any protected filesystem/tool
payload is moved. It does
not make the Phase 2 claim and does not remove any legacy host content route.
Host signaling is routed between websocket workers through ephemeral Redis
pub/sub channels and an atomic, compare-refreshed daemon ownership lease; it
does not depend on process-local broker affinity. A replacement claim actively
revokes the previous worker. Authenticated daemon sockets remain absent from
broker host and agent routing until registration has allocated a durable database
`BigInteger` fence token and a matching, non-routable Redis pending reservation.
Promotion uses an exact pending-and-predecessor CAS; the active lease is restored
by exact token if the database activation commit fails. A reservation cannot alter
the previous database owner, active Redis lease, browser target, or broker routes.
During the bounded promotion-to-commit bridge B is still non-routable and A remains
authorized; a browser requires the database and Redis active tokens to agree. The
Redis cache accepts only a newer reservation token, and
the authoritative database owner can reclaim
a lost cache entry; heartbeat and offline transitions require the exact connection
and generation. Every host signal also revalidates
the current lease, so a stale worker cannot retain or create host sessions or
overwrite its replacement's durable status during either claim or notification
races. Browser, host, and daemon session
counts are capped, pending offers expire, daemon peer connections have a hard
ceiling, and only the first correctly labelled host DataChannel is accepted.
The browser's negotiation deadline starts before offer creation and ends only
after the versioned host-channel hello, so missing answers and half-open
channels are cleaned up and reconnected. Host RTC status visible to the server
is restricted to stable content-free values.

### 5 — host filesystem and interactive tool transport over `spawn.host.ctl`

The filesystem portion is **REVIEWED AND MERGED** in P2-HOST-02 at `4e7c89b`.
The interactive tool portion is **IMPLEMENTED, REVIEW PENDING** separately as
P2-HOST-03A and is not complete until independent review passes and it merges.

- Move list/read/write/mkdir/rename/remove request/response frames off the
  server WebSocket. Paths, entry names, sizes/times, file bytes, and detailed
  errors remain E2E. Remove `home_dir` from daemon registration and fetch the
  initial browser path over the host channel.
- Browser downloads and uploads stream directly. Cross-host transfer uses two
  authorized host sessions and streams source daemon → browser → destination
  daemon; the server never buffers the file. Preserve bounded memory and
  destination overwrite semantics. Filesystem calls are capability-rooted and
  no-follow for every component, no-clobber commits use a single atomic rename,
  directory pages have daemon and browser retention ceilings, and ACK/cancel
  dispatch cannot wait behind a long sender or file write. A short per-session
  arrival arbiter assigns ordinals and publishes bounded, expiring cancel
  cutoffs before fast/normal queue routing: only frames that preceded a cancel
  may drain, while every later chunk/end fails closed even if the fast consumer
  is delayed. Fast write cancellation signals the active I/O token and hands
  disk cleanup to the single tracked session maintenance task. Cancelled read
  IDs remain tombstoned and cannot be redeclared. The first source/destination
  timeout, error, cancellation, or peer loss aborts and cleans up both streams.
- Add a parallel E2E request/response path for interactive tool checks/installs,
  including commands, paths, installed/latest versions, stdout/stderr, and
  detailed errors. This increment proves and ships the endpoint transport, but
  does not claim the tool cut complete. The legacy server-side tool routes
  cannot be removed yet because their durable target still comes from plaintext
  `Preset.install` and `Preset.default_argv`; the final and unattended cut waits
  for Increment 7.
- The P2-HOST-03A candidate exposes metadata-only target discovery over REST,
  then sends only a bounded target ID and stable tool kind on `spawn.host.ctl`.
  The endpoint maps that kind to a fixed executable/version/install argv,
  resolves it locally, and executes it directly without a shell. Checks and
  installs have endpoint deadlines, process/output/concurrency bounds,
  cancellation kills the process group, and same-tool installs are mutually
  exclusive. A post-spawn failure, timeout, cancellation, close, failed
  reconciliation, or lost acknowledgement is `outcome_unknown`; the browser
  never retries and uses a fresh `tool.check` to reconcile. Protected tool
  results are validated against the requested target and fixed policy before
  display. The existing capability/generation binding, ordered-reliable
  admission, bounded queues, publication fence, one absolute close deadline,
  zero-agent session, and reconnect behavior remain the transport root.
- Delete the filesystem REST content proxies and server broker waiters only
  after the web client and daemon path is live. Tool route deletion remains
  deferred to Increment 7.

### 6 — agent uploads and terminal control-plane retirement (review candidate)

P2-TERM-01 replaces the agent `bytes_b64` REST/WS/broker legs with a bounded
per-agent `spawn.ctl` stream. The `ready` event carries a fresh per-channel
capability, the exact agent-backend generation, and the 20 MiB/48 KiB endpoint
limits. A stable upload UUID binds an immutable manifest and enables bounded
resume/idempotency. Kind-2 binary chunks carry exact sequence/final framing;
the daemon validates length and SHA-256, caps four uploads per viewer and 64
globally, and expires a bounded completion cache.

The worker private protocol is bumped to version 5 so a launched or adopted
worker retains its canonical local cwd as the upload capability root. The
daemon opens that root and attachment directories component-by-component with
no-follow directory descriptors, accepts one relative leaf only, writes a
same-directory mode-0600 temporary file, and atomically hard-links a free final
name without clobbering regular files or symlinks. Cancellation, malformed
chunks, channel teardown, and backend replacement remove temporary state.
Endpoint paths and detailed responses travel only on `spawn.ctl`; there is no
content-free server acknowledgement because the server has no upload leg at
all. Old workers without the cwd capability and old REST/WS upload clients fail
closed instead of activating a compatibility relay.

The reviewed P2-TERM-02/P2-AGENT-02 cut removes REST
input/snapshot/resize/scroll/redraw, the equivalent `/ws/browser`
viewport/display-control handlers, and their schemas/broker/server↔daemon
frames. Browser input uses `spawn.pty`; snapshot/history and viewport control
use `spawn.ctl`. Smoke/integration tooling uses an RTC endpoint harness instead
of a server content proxy.

P2-ERROR-01 must replace agent-scoped free-form daemon error messages with stable server-visible
codes and E2E detail on `spawn.ctl`. Remove server forwarding/logging of error
text; lifecycle status and exit code remain disclosed metadata.

### 7 — launch manifests, presets, skills, and tool policy E2E

REST agent creation persists only retained metadata (id, owner, host, name,
status, lifecycle fields). `cwd`, `argv`, `env`, preset install/default-command
data, preset environment values, and skill bodies travel over
`spawn.host.ctl`; remove them from `_dispatch_agent_launch` and other
server↔daemon frames. The daemon keeps a local launch manifest so restart does
not require server plaintext. Pre-launch and host-scoped detailed errors travel
back on `spawn.host.ctl`; the server receives only a stable lifecycle code.

Before implementation, choose and threat-model the durable endpoint store:

1. endpoint-local canonical storage (simpler, with a documented temporary
   cross-device/cross-host synchronization regression), or
2. opaque client-encrypted server blobs with versioned AEAD envelopes and a
   recovery/key-distribution design in which the server never receives keys.

The second option still leaks object identifiers, ciphertext sizes, version
counts, and create/update/access timing/patterns. Its design and UI must disclose
that metadata and test that no key or plaintext reaches server logs/telemetry.

The security invariant is non-negotiable: no plaintext `Agent.env`,
`Skill.content`, or `Preset.env_template` remains server-readable. Existing
values are copied and verified through the chosen endpoint path before any
database field is cleared. Preset/skill names and descriptions remain disclosed
metadata and must not contain secrets.

Stop deriving `Agent.name` from `cwd`; use an explicit user-supplied metadata
label or a neutral ID-based default. Before clearing `Agent.cwd`, conservatively
identify rows whose name equals the historical host/cwd-derived default and
replace them with a neutral value (or reclassify/move the name E2E if exact
provenance cannot be established). Record counts, never the old names.

Once endpoint-owned `Preset.install`/`default_argv` and tool targets are durable,
finish the tool cut begun in Increment 5: make the E2E interactive path
mandatory and remove its compatibility server route; unattended execution
policy and targets live at the daemon/endpoint. The server retains only the
enabled flag, host/preset identifiers, check/update/result timestamps, and
content-free success/failure/exit-code status. Clear `last_auto_update_error`
and remove all detailed result forwarding/logging.

### 8 — live-data migration and plaintext purge

This is an operational migration, not a schema-only cleanup. It is destructive
and must not begin until Increments 2–7 are live, old clients are blocked from
content-bearing paths, and endpoint copies have passed reattach/restart/preset/
skill recovery tests.

1. **Inventory before changing data.** Record counts and byte totals (never
   values) for every file under the configured `SPAWN_TRANSCRIPT_DIR`, non-empty
   `Agent.cwd`/`argv`/`env`, `Skill.content`,
   `Preset.default_argv`/`env_template`/`install`, and
   `HostToolPolicy.last_auto_update_error` rows; cwd-derived `Agent.name` rows;
   Redis keys matching the historical `spawn:agent:*:ring` namespace; server,
   daemon-forwarded, proxy, container/journal, audit, APM/trace, crash-report,
   and third-party observability logs; temp files/exports/core dumps/swap;
   database/Redis persistence files and WAL/AOF; volume snapshots; replicas;
   and provider backups. Record owners, encryption/key scope, retention,
   deletion capability, and the oldest restorable point.
2. **Migrate and verify endpoint copies.** Retire server transcripts in favor of
   the existing bounded worker replay described in Increment 2, and move
   launch/preset/skill data to the approved endpoint store. Server-only
   offline/archived transcripts are an accepted retirement, not a silent
   migration: announce a bounded export/reconnect window before the cut, let
   users re-establish available history from an online endpoint or export it,
   and record the deletion deadline. Check record counts, byte counts or keyed
   digests at endpoints, then exercise worker replay across retention,
   daemon restart/adoption, agent exit, history attach, preset edit/use, and
   skill edit/use. The audit record contains identifiers/counts only.
3. **Close, drain, and restart every ingress before purge.** Require upgraded browser/daemon
   versions; retire `spawn.v1`, `0x01`/`0x02`, content REST routes, broker
   waiters, free-form error/status messages, viewport control frames, and
   plaintext model writes. Stop new requests; drain in-flight HTTP/WS queues,
   broker waiters, Redis client/pubsub buffers, log pipelines, and telemetry
   exporters; then restart every server worker/container and any relay process
   that could retain plaintext memory. Monitor and reject attempted legacy
   frames. Take the final inventory only after the last accepted plaintext write
   and the drain/restart completes.
4. **Purge primaries.** Delete transcript files and empty directories; scrub
   plaintext database values in a transaction before dropping/replacing the
   columns; delete legacy Redis ring keys (including keys not reachable through
   current application code); clear known temp/export artifacts. Account for
   database WAL, Redis AOF/RDB, replicas, and freed filesystem blocks: ordinary
   file deletion/VACUUM is not secure erasure, so re-provision an encrypted
   volume or destroy/rotate the storage encryption key where raw-block recovery
   is possible. Never print a value in migration output. Plain Redis pub/sub
   messages are ephemeral but their application path must already be removed.
5. **Purge runtime and observability residue.** Delete historical server/proxy/
   container/journal logs, APM traces, error events, crash reports, core dumps,
   and third-party log copies containing derived names or detailed errors.
   Disable plaintext core capture. Wipe/recreate unencrypted swap or destroy its
   encryption key, and reboot/restart as required to make old process memory,
   queues, and swapped pages unrecoverable. Verify retention/deletion at every
   external observability provider rather than assuming local deletion reaches
   it.
6. **Purge recoverable copies.** Destroy database dumps, machine/volume
   snapshots, object-store versions, and backups that contain plaintext, or let
   them expire under a documented retention policy while withholding the Phase
   2 completion claim. Where backups are envelope-encrypted, verified key
   destruction is acceptable if it makes every copy unrecoverable. Coordinate
   provider replicas and disaster-recovery stores, not just the live node.
7. **Verify as the server operator.** Run negative disk/database/Redis/swap/core
   scans; inspect process memory, queues, local and external observability
   stores; and restore the oldest remaining backup into an isolated environment
   to confirm the protected fields/content are absent or cryptographically
   unrecoverable. Confirm ciphertext-only storage leaks only the disclosed
   metadata. A second operator reviews the evidence. Record timestamps,
   code/schema versions, counts, and backup IDs—not content.
8. **Rollback rule.** Roll back binaries/configuration only. Do not restore a
   plaintext content store. If endpoint recovery fails, stop the rollout before
   Step 4 rather than purging early.

## Operational staging (do not break live sessions)

Most remaining increments modify the **daemon**. Restarting it tears down RTC
and server-control connections and makes browsers reconnect, while compatible
worker processes normally survive and are rediscovered/adopted. The one-time
worker-only cutover requires the fail-closed drain in `TMUX_REMOVAL.md`; old
sessions are not adopted. For later increments build (`cargo build`), run the
daemon suite + `scripts/smoke-local-*`, verify worker adoption on a throwaway
host, and only then roll the live daemon during a quiet window. Server-only
pieces deploy independently with a server restart.

The purge has its own change window and rollback boundary. Take no fresh
plaintext backup for convenience: backup policy must already be compatible
with the Increment 8 purge runbook before the purge begins.

## Acceptance (end of Phase 2)

All Phase 2 tasks through `P2-AUDIT-01`, plus the immediate and overlapping
quality gates required by their dependency/merge rules in
`docs/TRUST_PHASE2_TASKS.md`, are complete. The Phase 3 follow-on identity task
is explicitly excluded from this completion condition. A route/frame/schema
inventory and adversarial tests show no server path can
receive or return PTY/history/snapshot bytes, agent or host file data, directory
entries/paths/sizes/mtimes/errors, tool commands/paths/installed/latest
versions/output/detailed errors, launch
`cwd`/`argv`/`env`, cwd-derived labels, terminal geometry/viewport events,
preset default arguments/environment/install values, free-form daemon errors,
or skill bodies. Server-process memory, queues, disk, database, Redis, swap,
core dumps, local/external observability, backups, snapshots, and restored
oldest-retained backup contain no recoverable plaintext from those classes.

The server continues to see the metadata explicitly disclosed in
`docs/TRUST.md`, including user-input and meaningful-output timestamps. An active
signaling MITM remains possible until Phase 3; Phase 2 does not imply endpoint
authentication against a malicious control plane.
