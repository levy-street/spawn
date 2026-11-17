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
| Support log collection (`support_log.collect`) | Optional process-wide actor; locally proven account, verified signer/device attribution and enabled signed consent. Inputs advance one generation and cancel running work; only equal applied/delivered generations authorize from reverified disk. Failed inputs remain pending; queue overflow denies permanently for this process. Admission bucket bounds requests/refusals across reconnects; durable quota bounds bundles. Typed gzip/refusal bodies use one prefix-preserving HTTPS POST with bearer daemon token; only 2xx succeeds | Daemon-only; no server sender/storage or app switch. Persisted state survives restart; pending/overflow denial does not. Honest registration redelivers current consent before collection; withholding remains a dishonest-server residual. Starting a request is the authorization boundary; cancellation is best effort and may leave one full 900 KiB bundle delivered within the 15-second request timeout. Cross-process changes are seen at the next authorization read. See `proto/SUPPORT_LOG_CONSENT_V1.md` and `TRUST.md` |
| Daemon self-update | Server requests an update; daemon verifies signed artifacts and its local rollback policy | Audit request authority separately from artifact authenticity; retain local downgrade consent and pair rollback guarantees |
| Device/root trust changes | Endpoint signatures plus local pins; revocation is deny-direction | Preserve these boundaries while resolving custody and offline root-rotation transitions |

A collection may begin sending only if, immediately before the request is
started, the statement stored on this host is valid, enabled, not switched off,
and its signer is still admitted, as read from disk by this process. A change
this process receives before the request has been started prevents it. Once the
request has been started it is abandoned on a best-effort basis when a later
change arrives, but its body (one bundle, at most 900 KiB) may still be delivered,
and it ends within the 15-second request timeout in any case. A change written
by another process of the same instance is seen at the next authorisation read.

Consent writes are deduplicated and limited to 30 changes per ten minutes;
exhaustion denies support until restart. A pending replacement may require
restart too. One dedicated worker retains unfinished I/O; overdue work blocks
collection, and the worker cannot hold daemon shutdown.

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
