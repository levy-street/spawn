# Daemon command authority

Tracking: [#63](https://github.com/levy-street/spawn/issues/63). This inventory
describes the first containment change, not a completed endpoint-authority
migration. The control WebSocket authenticates the server; it does not prove
that a trusted operator device authorized an executable request.

## Installation containment

`host.agents.install` remains decodable so older servers receive an immediate
failure in the existing result shape. The daemon returns
`device_authorization_required` before resolving the command, probing versions,
running a self-updater, or executing an installer. No server flag, request ID,
or stored auto-update policy waives that refusal.

The server's install endpoint checks account ownership and then returns 409.
Its broker no longer constructs installation requests. The background agent
auto-update scheduler and status-refresh installation side effect are removed.
Enabling an auto-update policy returns 409; existing rows are retained as
historical metadata but reported inactive, and disabling them remains possible.

Both clients keep availability information and direct the operator to install
or update agents in a trusted terminal on the host. The in-app installation
and auto-update controls are removed until an endpoint-authorized replacement
is ready. Daemon self-update is a separate mechanism and is unaffected.

This is a security containment exception to the older P2-HOST-03B sequencing
that retained installation until durable endpoint targets existed. It does not
claim the replacement, unattended policy migration, or historical-data purge is
complete. Existing agent definitions, install strings, and policy history are
not deleted.

## Remaining authority and implementation order

| Operation | Current authority / effect | Next requirement |
| --- | --- | --- |
| Agent install and self-updater through `host.agents.install` | Refused by the daemon; server dispatch and scheduler removed | Restore only over authenticated endpoint operations with durable target/effect identity and explicit ambiguous-outcome handling |
| Agent availability/version checks through `host.agents.check` | Server chooses executable targets; version probes run programs and package checks may run package-manager commands | Move checks to endpoint-authorized targets; treating a probe as read-only does not make execution safe |
| Session create/restart/move/kill | Server sends lifecycle requests (a move is a restart on another host); launch definitions, cwd, environment, and skills can affect code execution | Bind device intent to exact launch manifests and lifecycle operations; persist effect identity before execution |
| Worker rediscovery and offline restart | Local worker ownership is durable across supervisor restarts; restart manifests still depend on existing configuration paths | Preserve adoption while moving executable restart authority to committed endpoint state |
| Host file operations | Authenticated host DataChannel with capability-rooted operations | Preserve admission, revocation, filesystem capabilities, and replay/cancellation rules during the durable-state work |
| Conversation inspect (pair-admitted device over `spawn.host.ctl`; reads, and notes Codex threads) | `conv.inspect` is answered only on a host channel admitted through an authenticated device pair; a legacy protocol-1 host channel, admitted on the server's binding alone, answers `pair_required`. It reads the window's own process tree, Claude Code's live-session registry, which Codex thread files the window's Codex holds open (with the first line of each held rollout, to tell a subagent's thread apart), and Codex's shared server's own record (`<CODEX_HOME>/app-server-daemon/daemon.pid`), to say a window's Codex is on that server. It executes nothing, reads no process arguments or environment, and has no effect on the host beyond noting each Codex window's thread id in spawnd's own folder for them (`<config>/conversations/`, one file per window, removed when the server stops the window for good with `session.kill`) | Keep it to reads and those notes. Later `conv.*` operations that act on a conversation inherit the same pair admission and still need durable effect identity before execution |
| Codex launch probe (pair-admitted device over `spawn.host.ctl`, `conv.launch`) | When a device about to type Codex into a window asks `conv.launch`, the daemon runs one fixed command, `codex --no-daemon --version`, by the path the `PATH` of the environment it started that window's shell with finds, with that environment, in the window's folder, with a 5 s timeout; only on Linux and macOS, and only for a window whose shell this daemon started (none for an adopted worker). Relative `PATH` entries (`node_modules/.bin`) are looked up from the window's folder, as its shell would. It runs no shell to learn that environment, keeps nothing between asks, and runs on no timer. The run is spawnd's own child, as its user — on Linux in spawnd's service cgroup, outside every window's scope and its limits — in a process group of its own that is killed whole at the timeout; at most 3 run at once across the daemon, and a launch that cannot start one within 1 s is answered null (plain `codex`) rather than queued. A legacy host channel answers `pair_required`; the server never sees the request. The device naming the window chooses which window's environment, never the program or its arguments; such a device can already type into the window. The answer (does that Codex accept `--no-daemon`, or unknown) goes only to the asking device. Like any `codex` run it refreshes Codex's own scratch folder under `<CODEX_HOME>/tmp/`; a `codex` an agent planted on that `PATH` runs at the next launch's ask, as it would at the launch itself | Keep it to that one invocation (pinned by `scripts/check-no-server-agent-upload.sh`); any further probe needs its own review |
| Support log collection (`support_log.collect`) | One optional sequential actor; locally proven account, verified signer/device attribution and enabled signed consent. Dispatch advances a generation immediately; each input and collection finishes before the next. Any update failure enters terminal `Denied(reason)`. Admission budget and durable quota bound collection. One prefix-preserving HTTPS POST carries a typed gzip/refusal body and bearer token; only 2xx succeeds | Daemon-only; no server sender/storage or app switch. Honest registration redelivers current consent. Request start is the atomic generation/start-bit claim after final disk authorization; later cancellation is best effort, with at most one 900 KiB bundle within the 15-second timeout. Cross-process changes are seen at the next authorization read. See `proto/SUPPORT_LOG_CONSENT_V1.md` and `TRUST.md` |
| Daemon self-update | Server requests an update; daemon verifies signed artifacts and its local rollback policy | Audit request authority separately from artifact authenticity; retain local downgrade consent and pair rollback guarantees |
| Device/root trust changes | Endpoint signatures plus local pins; revocation is deny-direction | Preserve these boundaries while resolving custody and offline root-rotation transitions |

Request start means the single atomic compare-exchange from
`(collection generation, not started)` to `(collection generation, started)`,
after the final disk authorization job returns and immediately before `send()`
is created and polled. Generation and started bit occupy one atomic word.
Delivery before this transition makes the claim fail: no request is created,
and the receipt is `cancelled`. Delivery after it abandons the request best-effort.

A collection may begin sending only if, immediately before the request is
started, the statement stored on this host is valid, enabled, not switched off,
and its signer is still admitted, as read from disk by this process. A change
this process receives before the request has been started prevents it. Once the
request has been started it is abandoned on a best-effort basis when a later
change arrives, but its body (one bundle, at most 900 KiB) may still be delivered,
and it ends within the 15-second request timeout in any case. A change written
by another process of the same instance is seen at the next authorisation read.

One optional sequential actor owns sharing across control reconnects. Startup
schedules its preparation without waiting; collection is unavailable until ready.
The existing delivery queue is present immediately, so early trust and withdrawal
cannot be lost during preparation. Preparation is the actor's first awaited job;
failure enters the same terminal denial. Dispatch
clones the parsed support payload, advances one generation with a compare-exchange
loop, clears the request-started bit, tries the bounded queue and notifies the
actor. It does no support filesystem or cryptographic work. Queue operations may
allocate and payload destruction may occur. Actual trust changes, failed or
timed-out credential observations, consent, teardown and shutdown advance the
generation; unchanged observations deliver nothing.

The actor takes one input at a time, in arrival order, and finishes it before
taking another. A combined trust/consent update stays one input. Received trust
and revocations are retained before writes. Collection runs inside that same
loop: admission budget, one preparation job (authorization, durable reservation,
snapshot and compression), one final disk authorization job, atomic start claim,
request selected against generation change, then one final receipt job. During
collection, delivery still advances the generation immediately, while queued
updates wait for collection to finish. Every filesystem job is awaited to
completion or its deadline; healthy work is never abandoned. Lock waits are
bounded at about two seconds. No job queues behind unfinished work. The dedicated
thread is not joined at daemon shutdown.

Any update failure enters terminal `Denied(reason)` for the rest of this process:
storage I/O failure, lock wait expiry, storage job deadline, stopped/panicked
storage worker, the consent write budget, the 256-key support revocation floor,
delivery queue overflow or delivery-gate contention, invalid support update, or
generation exhaustion (a terminal atomic word prevents any start claim). Collection storage-job deadlines, worker death and receipt
write failures also deny. Later inputs are drained and ignored, and stored consent
is removed once, best-effort; a dead or unfinished worker can prevent that removal.
No collection is admitted in `Denied`. Status gives the reason in plain words and
says restarting SPAWN D on that machine clears the process denial. The normal
heartbeat can be up to 30 seconds old, and storage failure can prevent reporting.

An account whose server delivers more than 256 removed devices cannot share from
that host. Restart does not cure it while that history is redelivered. Connection
revocations remain uncapped, as on master. More than 30 sharing changes in ten
minutes pauses sharing on that host until restart; ordinary toggles across devices
can reach this budget. Unchanged effective state skips writes, including a
comparison of the carried approvals: a refreshed approval path is persisted.

Successful persistence survives restart; terminal process denial and the admission
bucket do not. Removing the statement also removes its timestamp/revocation floor;
failed removal can leave an old on. An honest server must redeliver current consent
in `registered` before collection. A dishonest server can withhold withdrawal or
replay an old valid on after state loss. There is no host acknowledgement that it
applied a turn-off; apps must not claim one. Capability, silence and collection
receipts do not provide that confirmation.

Installation containment does not prevent arbitrary execution through the
remaining launch or probe surfaces. Do not describe this release as making a
compromised server unable to execute commands on a host.

The P2-HOST-03A tool candidate is on an older unmerged branch; it must be
reconciled with current sessions, both clients, and the reviewed effect
boundaries. P2-DATA-02 remains necessary for durable targets and unattended
execution. A lost acknowledgement must never authorize retry; a fresh request
ID alone cannot settle whether an earlier installation ran.

## Verification and compatibility

- Daemon regression tests deserialize legacy frames, including asserted
  authorization flags and repeated request IDs, and require a refusal with no
  subprocess effect, version result, or installer output.
- Server tests require an immediate install refusal without a daemon frame,
  reject enabling automation, and prove that an existing true policy cannot
  schedule installation during an availability refresh.
- Client checks retain availability while removing installation/automation
  actions; web and mobile show the same recovery instruction.
- New daemon + old server: installations return a stable failure. New server
  + old daemon: the legitimate server no longer dispatches installations, but
  the old binary remains vulnerable to a malicious server until upgraded.
- No control-subprotocol bump is needed for the retained refusal response.
  Releasing still follows `docs/RELEASE.md`; this branch does not deploy itself.
