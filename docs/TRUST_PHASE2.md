# Trust Phase 2 — implementation spec (server holds no protected content)

Companion to `docs/TRUST.md` Phase 2. This revised cut sequence covers both
agent-scoped terminal traffic and host-scoped operations. Each increment must
be independently reviewed and shippable, but the Phase 2 claim is made only
after the historical-data purge and final inventory pass. Grep is one check,
not proof that old plaintext has left disks, databases, Redis, or backups.

## Current reality (why this is the sequence)

- The mandatory session worker feeds one `run_forwarder` that sends every output
  chunk to **two sinks unconditionally**: the WebRTC DataChannel direct-sinks
  **and** the server-bound `0x01` WS leg. No v2 gate on the daemon side.
- The only DataChannel is a raw per-agent `spawn.pty` byte pipe
  (`daemon/src/rtc.rs`, `web/src/components/terminal/useAgentSocket.ts`). There
  is no per-agent control channel and no host-scoped peer connection.
- Since Increment 1, the server-bound `0x01` leg remains for **transcript
  persistence** (the connect-time history seed) and **v1 relay fan-out**. The
  server no longer needs its bytes for activity classification.
- v2 already keeps *live* PTY off the server (Phase 1), but the connect-time
  `history` frame and every `snapshot` frame still transit the server for every
  client, v1 and v2.
- Host directory/file routes in `server/spawn_server/routes/hosts.py` proxy
  `host.fs.*` through the server. Downloads and uploads put complete file bytes
  in server memory; cross-host transfer reads into the server before writing to
  the destination. The daemon's registration frame also exposes `home_dir`.
  These operations may be used with no agent running, so `spawn.ctl` on an
  agent connection cannot replace them.
- Tool checks and installs also use server↔daemon control frames. Installer
  `output` and `error` can contain arbitrary commands, paths, and secrets;
  `HostToolPolicy.last_auto_update_error` persists a detailed error derived
  from the result.
- REST `/api/agents/{id}/input` and `/snapshot` are content-bearing terminal
  paths independent of the browser WebSocket flow.
- Terminal resize/scroll/redraw and display-control traffic exposes dimensions,
  scroll deltas, and viewport timing through REST, `/ws/browser`, and
  server↔daemon `agent.resize`/`scroll`/`redraw` frames.
- `Agent.cwd`/`argv`/`env`, `Skill.content`, and
  `Preset.default_argv`/`env_template`/`install` are plaintext database fields.
  Preset templates are merged into the launch environment in `routes/agents.py`;
  the resulting launch manifest transits the server in `agent.create`.
- When no explicit name is supplied, `_default_agent_name` copies the protected
  `cwd` basename into the retained `Agent.name` column. Existing rows do not
  record whether a name was explicit or derived.
- Daemon `Outbound::Error.message` frames contain full `anyhow` chains (often
  including cwd/file paths). `ws/daemon.py` forwards upload messages and logs
  every free-form message; other detailed status/exit strings can do the same.
- Removing future writes is insufficient: existing transcript files, database
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

### 1A — activity correctness gate (before Increment 2)

Increment 1 is directionally complete but is not the behavioral acceptance
gate yet:

- Emit a content-free, monotonic-throttled input-activity frame for DataChannel
  input so v2 typing updates `last_input_at`; the server currently stamps only
  REST/v1 input. Preserve the current at-most-once-per-second granularity.
- Apply daemon-owned suppression before every daemon-induced repaint,
  including `agent.scroll` and copy-mode cancellation before stdin.
- Make classification match the intended invalid/incomplete UTF-8 behavior
  across PTY chunk boundaries. Replacement characters must not turn arbitrary
  invalid bytes into three meaningful characters; escape/control sequences
  split across chunks need bounded carry or an equivalent streaming parser.
- Use monotonic time for throttle/suppression intervals. Wall-clock timestamps
  are appropriate only in the metadata frame/database stamp.
- Add tests for throttle, every suppression source, output/input frame
  emission, channel backpressure/drop behavior, and the guarantee that binary
  PTY output never updates activity server-side. Delete the unused server-side
  classifier/suppression code once no live path imports it.

Trust-touched Rust formatting is also a pre-Increment-2 gate. Repository-wide
formatting, lint, and Clippy debt is tracked separately from trust correctness in
`docs/TRUST_PHASE2_TASKS.md`; pre-existing unrelated findings do not silently
become Phase 2 blockers, but any file touched by a trust task must leave its
relevant gate clean.

### 2 — DataChannel control channel (`spawn.ctl`) + history/snapshot over it
Add a second DC label `spawn.ctl` (daemon already gates on label at
`rtc.rs:348`; browser creates only `spawn.pty` at `useAgentSocket.ts:244`).
Carry snapshot/replay **requests + responses** over it, framed. On DC-open the
browser requests the connect-time backfill + scrollback from the daemon over
`spawn.ctl` from the worker's encrypted bounded replay instead of the server
`history`/`snapshot` frames. This removes those two v2
content paths only. It does **not** complete the server cut: the daemon still
mirrors every output chunk on `0x01` until Increment 3. The
server-bound `rtc_session_id` correlation collapses once both live and
backfill use the peer connection. An endpoint-only PTY byte anchor remains
necessary: separate ordered DataChannels do not share a total order.

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

**Implementation checkpoint (independent review pending):** `spawn.ctl` v1 is
implemented as bounded request-bound JSON plus chunked binary replay frames.
Worker replay propagates its durable output watermark into the same producer
coordinate as live frames. Each producer boundary is translated through the
viewer's attach origin into an exact
`spawn.pty` offset. RTC callbacks also carry an immutable backend-generation
binding and a teardown fence, preventing a late callback from resolving the
same agent UUID to a replacement backend. The browser uses the explicit offset
and a bounded bootstrap queue because ordering on one DataChannel does not
imply ordering against the other. Slow viewers are disconnected from bounded
queues and catch up through replay on reconnect. Legacy v1 server
history/snapshot/viewport paths remain temporarily for compatibility, and
daemon `0x01` mirroring still remains for Increment 3; this checkpoint therefore
does not make the Phase 2 claim.

### 3 — drop the `0x01` output leg + delete server content stores
Safe once (1) and (2) land and the DataChannel is mandatory (v1 retired):
- Daemon: drop the `WsOutbound::Binary` sink in `run_forwarder`
  (`pty.rs:658-702`); reroute `send_pty_text`/`send_snapshot_text` banners onto
  `spawn.ctl` or drop them.
- Server: delete `transcript.py` + `daemon.py:148` append + `browser.py`
  history/snapshot forwarding + the v1 `_pump_pubsub`/`0x02` input legs +
  `redis.py` pubsub. Drop `spawn.v1` + `WS_CLOSE_BINARY_ON_V2` branching.
- **Accepted regression:** offline-host history replay (documented in TRUST.md).

### 4 — host-scoped E2E control transport (`spawn.host.ctl`)

Create a browser↔daemon WebRTC session keyed by `host_id`, not `agent_id`, with
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

Implementation note: the transport root is intentionally separable from the
content migrations in Increment 5. Its first reviewed cut uses a dedicated
`/ws/host` signaling websocket, binds each RTC session to browser connection,
daemon connection, host scope, protocol, and version, and exposes only a
bounded `hello`/`ping` request-response primitive. This permits ownership,
zero-agent, TURN-only, reconnect, cancellation, size, and cross-scope behavior
to be tested before any protected filesystem/tool payload is moved. It does
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
- Delete the filesystem REST content proxies and server broker waiters only
  after the web client and daemon path is live. Tool route deletion remains
  deferred to Increment 7.

### 6 — agent uploads and terminal control-plane retirement

Replace agent `bytes_b64` upload legs (`ws/browser.py`, REST `routes/agents.py`,
and `agent_control.decode_upload`) with a chunked per-agent `spawn.ctl` stream.
Keep only a content-free saved/failed acknowledgement; paths remain on the
encrypted channel.

Remove REST input/snapshot/resize/scroll/redraw, the equivalent `/ws/browser`
viewport/display-control handlers, and their schemas/broker/server↔daemon
frames. Browser input already uses `spawn.pty`; snapshot/history and viewport
control use `spawn.ctl`. Migrate smoke/integration tooling to an RTC endpoint
harness instead of keeping a server content proxy for tests. Return a
non-content deprecation response only during a bounded compatibility window.

Replace agent-scoped free-form daemon error messages with stable server-visible
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
