# Trust Phase 2 — implementation spec (server holds no protected content)

Companion to `docs/TRUST.md` Phase 2. This revised cut sequence covers both
agent-scoped terminal traffic and host-scoped operations. Each increment must
be independently reviewed and shippable, but the Phase 2 claim is made only
after the historical-data purge and final inventory pass. Grep is one check,
not proof that old plaintext has left disks, databases, Redis, or backups.

## Current reality (why this is the sequence)

- Both session backends (tmux `pty.rs`, worker `worker_backend.rs`) converge on
  one `run_forwarder` (`daemon/src/pty.rs:594-627`) that sends every output
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
- `Agent.cwd`/`argv`/`env`, `Skill.content`, and
  `Preset.default_argv`/`env_template`/`install` are plaintext database fields.
  Preset templates are merged into the launch environment in `routes/agents.py`;
  the resulting launch manifest transits the server in `agent.create`.
- Removing future writes is insufficient: existing transcript files, database
  values, legacy `spawn:agent:*:ring` Redis keys, and infrastructure
  backups/snapshots remain readable until explicitly purged.

## Increments

### 0 — delete the dead Redis ring buffer  ✅ done (`e03fb3f`)
Zero production callers. `ws/ringbuffer.py`, `RedisBackend.ring_*`,
`_InProcPubSub` ring methods, `config.ringbuffer_max_bytes`. The operational
Redis smoke still referenced the removed methods and was repaired separately.

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
- Repair `scripts/smoke-redis-pubsub.sh`, which still exercises the removed ring
  API, so `scripts/test-all.sh` becomes a real gate again.

### 2 — DataChannel control channel (`spawn.ctl`) + history/snapshot over it
Add a second DC label `spawn.ctl` (daemon already gates on label at
`rtc.rs:348`; browser creates only `spawn.pty` at `useAgentSocket.ts:244`).
Carry snapshot/replay **requests + responses** over it, framed. On DC-open the
browser requests the connect-time backfill + scrollback from the daemon over
`spawn.ctl` (worker: `worker_replay` `pty.rs:340`; tmux: `tmux::capture_history`)
instead of the server `history`/`snapshot` frames. This removes those two v2
content paths only. It does **not** complete the server cut: the daemon still
mirrors every output chunk on `0x01` until Increment 3. The
`dc_offset`/`rtc_session_id` cross-transport ordering machinery collapses once
both live + backfill use the peer connection.

### 3 — drop the `0x01` output leg + delete server content stores
Safe once (1) and (2) land and the DataChannel is mandatory (v1 retired):
- Daemon: drop the `WsOutbound::Binary` sink in `run_forwarder`
  (`pty.rs:601-621`); reroute `send_pty_text`/`send_snapshot_text` banners onto
  `spawn.ctl` or drop them.
- Server: delete `transcript.py` + `daemon.py:158` append + `browser.py`
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

### 5 — host filesystem and tool operations over `spawn.host.ctl`

- Move list/read/write/mkdir/rename/remove request/response frames off the
  server WebSocket. Paths, entry names, sizes/times, file bytes, and detailed
  errors remain E2E. Remove `home_dir` from daemon registration and fetch the
  initial browser path over the host channel.
- Browser downloads and uploads stream directly. Cross-host transfer uses two
  authorized host sessions and streams source daemon → browser → destination
  daemon; the server never buffers the file. Preserve bounded memory and
  destination overwrite semantics.
- Treat tool commands, paths, versions, stdout, and stderr as protected content.
  User-initiated check/install traffic uses the host channel. For unattended
  updates, move the executable policy/target to the endpoint; the server may
  retain only preset/host identifiers, schedule timestamps, and a content-free
  success/failure/exit-code signal. Do not persist detailed errors in
  `last_auto_update_error`.
- Delete the corresponding REST content proxies and server broker waiters only
  after the web client and daemon path is live.

### 6 — agent uploads and terminal REST retirement

Replace agent `bytes_b64` upload legs (`ws/browser.py`, REST `routes/agents.py`,
and `agent_control.decode_upload`) with a chunked per-agent `spawn.ctl` stream.
Keep only a content-free saved/failed acknowledgement; paths remain on the
encrypted channel.

Remove `/api/agents/{id}/input` and `/snapshot` plus their schemas/broker
helpers. Browser input already uses `spawn.pty`; snapshot/history uses
`spawn.ctl`. Migrate smoke/integration tooling to an RTC endpoint harness
instead of keeping a server content proxy for tests. Return a non-content
deprecation response only during a bounded compatibility window.

### 7 — launch manifests, presets, and skills E2E

REST agent creation persists only retained metadata (id, owner, host, name,
status, lifecycle fields). `cwd`, `argv`, `env`, preset install data, preset
environment values, and skill bodies travel over `spawn.host.ctl`; remove them
from `_dispatch_agent_launch` and other server↔daemon frames. The daemon keeps a
local launch manifest so restart does not require server plaintext.

Before implementation, choose and threat-model the durable endpoint store:

1. endpoint-local canonical storage (simpler, with a documented temporary
   cross-device/cross-host synchronization regression), or
2. opaque client-encrypted server blobs with versioned AEAD envelopes and a
   recovery/key-distribution design in which the server never receives keys.

The security invariant is non-negotiable: no plaintext `Agent.env`,
`Skill.content`, or `Preset.env_template` remains server-readable. Existing
values are copied and verified through the chosen endpoint path before any
database field is cleared. Preset/skill names and descriptions remain disclosed
metadata and must not contain secrets.

### 8 — live-data migration and plaintext purge

This is an operational migration, not a schema-only cleanup. It is destructive
and must not begin until Increments 2–7 are live, old clients are blocked from
content-bearing paths, and endpoint copies have passed reattach/restart/preset/
skill recovery tests.

1. **Inventory before changing data.** Record counts and byte totals (never
   values) for every file under the configured `SPAWN_TRANSCRIPT_DIR`, non-empty
   `Agent.cwd`/`argv`/`env`, `Skill.content`,
   `Preset.default_argv`/`env_template`/`install`, and
   `HostToolPolicy.last_auto_update_error` rows; Redis keys matching the
   historical `spawn:agent:*:ring` namespace; server logs/temp files/exports;
   database/Redis persistence files and WAL/AOF; volume snapshots; replicas;
   and provider backups. Record owners, encryption/key scope, retention, and
   the oldest restorable point.
2. **Migrate and verify endpoint copies.** Move transcript/history ownership to
   the daemon and launch/preset/skill data to the approved endpoint store.
   Server-only offline/archived transcripts are an accepted retirement, not a
   silent migration: announce a bounded export/reconnect window before the cut,
   let users re-establish history from an online daemon or export it, and record
   the deletion deadline. Check record counts, byte counts or keyed digests at
   endpoints, then exercise daemon restart, agent restart, history attach,
   preset edit/use, and skill edit/use. The audit record contains identifiers/
   counts only.
3. **Close every ingress before purge.** Require upgraded browser/daemon
   versions; retire `spawn.v1`, `0x01`/`0x02`, content REST routes, broker
   waiters, and plaintext model writes. Monitor and reject attempted legacy
   frames. Take the final inventory after the last accepted plaintext write.
4. **Purge primaries.** Delete transcript files and empty directories; scrub
   plaintext database values in a transaction before dropping/replacing the
   columns; delete legacy Redis ring keys (including keys not reachable through
   current application code); clear known temp/export artifacts. Account for
   database WAL, Redis AOF/RDB, replicas, and freed filesystem blocks: ordinary
   file deletion/VACUUM is not secure erasure, so re-provision an encrypted
   volume or destroy/rotate the storage encryption key where raw-block recovery
   is possible. Never print a value in migration output. Plain Redis pub/sub
   messages are ephemeral but their application path must already be removed.
5. **Purge recoverable copies.** Destroy database dumps, machine/volume
   snapshots, object-store versions, and backups that contain plaintext, or let
   them expire under a documented retention policy while withholding the Phase
   2 completion claim. Where backups are envelope-encrypted, verified key
   destruction is acceptable if it makes every copy unrecoverable. Coordinate
   provider replicas and disaster-recovery stores, not just the live node.
6. **Verify as the server operator.** Run negative disk/database/Redis scans,
   inspect server logs, and restore the oldest remaining backup into an isolated
   environment to confirm the protected fields/content are absent or
   cryptographically unrecoverable. A second operator reviews the evidence.
   Record timestamps, code/schema versions, counts, and backup IDs—not content.
7. **Rollback rule.** Roll back binaries/configuration only. Do not restore a
   plaintext content store. If endpoint recovery fails, stop the rollout before
   Step 4 rather than purging early.

## Operational staging (do not break live sessions)

Most remaining increments modify the **daemon**; restarting it restarts every
session riding it (including any live agent). For each daemon increment: build
(`cargo build`), run `daemon` test suite + `scripts/smoke-local-*`, stage on a
throwaway host/agent first, and only then roll the live daemon during a quiet
window. Server-only pieces deploy independently with just a server restart.

The purge has its own change window and rollback boundary. Take no fresh
plaintext backup for convenience: backup policy must already be compatible
with Step 8 before the purge begins.

## Acceptance (end of Phase 2)

All tasks and review gates in `docs/TRUST_PHASE2_TASKS.md` are complete. A
route/frame/schema inventory and adversarial tests show no server path can
receive or return PTY/history/snapshot bytes, agent or host file data, directory
entries/paths, tool commands/paths/versions/output/detailed errors, launch
`cwd`/`argv`/`env`, preset default arguments/environment/install values, or
skill bodies. Server-process memory, disk, database, Redis, logs, backups,
snapshots, and restored oldest-retained backup contain no recoverable plaintext
from those classes.

The server continues to see the metadata explicitly disclosed in
`docs/TRUST.md`, including user-input and meaningful-output timestamps. An active
signaling MITM remains possible until Phase 3; Phase 2 does not imply endpoint
authentication against a malicious control plane.
