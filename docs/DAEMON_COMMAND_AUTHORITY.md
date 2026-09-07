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
| Session create/restart/kill | Server sends lifecycle requests; launch definitions, cwd, environment, and skills can affect code execution | Bind device intent to exact launch manifests and lifecycle operations; persist effect identity before execution |
| Worker rediscovery and offline restart | Local worker ownership is durable across supervisor restarts; restart manifests still depend on existing configuration paths | Preserve adoption while moving executable restart authority to committed endpoint state |
| Host file operations | Authenticated host DataChannel with capability-rooted operations | Preserve admission, revocation, filesystem capabilities, and replay/cancellation rules during the durable-state work |
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
