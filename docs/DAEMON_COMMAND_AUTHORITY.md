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
| Conversation inspect (read-only, pair-admitted device over `spawn.host.ctl`) | `conv.inspect` is answered only on a host channel admitted through an authenticated device pair; a legacy protocol-1 host channel, admitted on the server's binding alone, answers `pair_required`. It reads the window's own process tree and Claude Code's live-session registry, executes nothing, reads no process arguments or environment, and has no effect on the host | Keep it read-only. The `conv.*` operations that act on a conversation (below) inherit the same pair admission |
| Conversation probe (read-only, pair-admitted device over `spawn.host.ctl`) | `conv.probe` (`conv.v2`) resolves a folder's name inside home, reads `.git` and `commondir` pointers, the names of Claude Code's install links and at most a `package.json` inside home, and lists copies of a conversation in the store. It executes nothing — unlike `host.agents.check`, the version comes from where Claude Code is installed, never from running it — and has no effect beyond creating spawnd's own private holdings folder | Keep it read-only and execution-free |
| Conversation export, import and retire (pair-admitted device over `spawn.host.ctl`; never reachable from the server) | `conv.v2`, Linux and macOS daemons. A conversation leaves a host only by being retired out of it: `conv.export` accepts only `mode:"retire"`, and `conv.import.begin` only a transfer the device declares a retire carried; a snapshot copy, which would leave the conversation resumable on two hosts, is reserved for an owner-approved copies feature and refused by both. `conv.export` stops a window on device intent: it refuses while any live holder outside the window has the conversation (`conversation_live_elsewhere`), stops the window's worker through the session registry, each TERM and KILL revalidated against the window's registry generation under its generation-transition lock (the lock is not held across the whole move: a window started again before the files are out refuses the move with `window_restarted`), signals the window's own Claude processes it identified exactly (a pidfd on Linux) and confirms each gone by pid and start, then moves the conversation's files out of the agent's lookup path into spawnd's holdings, one move of a conversation at a time, rolling back when anything holds the conversation after the move. `conv.import.begin` writes only allowlisted logical paths under names the receiving daemon computes, 0600/0700, and sets any existing copy aside rather than overwriting it. Every file effect is keyed by a device-chosen `transfer_id` recorded on disk before it happens; the window's stop and the signals to its Claude processes come before the record (nothing has moved yet, and a refusal there leaves no transfer), and the answer reports how the window went (`stopped`). Commit and cancel exclude each other through tombstones; an outcome is reconcilable through `conv.import.status` and `conv.transfers`; `conv.retire.commit` requires the length and digest the target committed, and `conv.retire.abort` restores without overwriting. Nothing is executed and no server-chosen parameter reaches either host | Bind the stop to the window's exact incarnation once launch manifests exist; a move's commit on the server (`/move`) still places the window by server authority, as a restart does |
| Daemon self-update | Server requests an update; daemon verifies signed artifacts and its local rollback policy | Audit request authority separately from artifact authenticity; retain local downgrade consent and pair rollback guarantees |
| Device/root trust changes | Endpoint signatures plus local pins; revocation is deny-direction | Preserve these boundaries while resolving custody and offline root-rotation transitions |

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
