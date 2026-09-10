# Shared device connections

SPAWN D opens one authenticated WebRTC connection per device and daemon while
its signed-in app is open. All terminal views and host operations reuse it.
The server still owns session creation, session metadata, and workspace layout;
this change does not move those authorities to the daemon.

## Wire and authorization

The existing `spawn.host.v1` signaling websocket accepts `rtc_version=2`.
Its signed transcript uses host scope, protocol `spawn.host.ctl`, and protocol
version 2. Both endpoints verify the expected identity and the exact RTC
session/binding generation. Unsigned v2 offers and answers fail closed.
The daemon advertises `supports_device_connections` at registration and
`session.transport.v1` in its host hello. New clients show an update message
when the server or daemon lacks support; existing host-v1 and session-v2
clients remain compatible with the new server and daemon.

The root channel is `spawn.host.ctl`. Each host-operation consumer opens
`spawn.host.ctl/<consumer UUID>`. Each terminal attachment opens two reliable,
ordered channels:

- `spawn.pty/<session UUID>/<view UUID>/<attachment UUID>`
- `spawn.ctl/<session UUID>/<view UUID>/<attachment UUID>`

UUIDs use canonical lowercase spelling. The daemon resolves the session in its
local registry, binds the attachment to that worker generation, and applies the
existing replay, upload-capability, control, and readiness protocols. A session
channel never gets a separate signaling route or admission-budget charge.
A successor connection from the same authenticated device retires the previous
one; different devices are independent. Parent retirement or trust invalidation
fences child effects before closing their channels. A failed or closed attachment
cannot close its siblings' peer.

## Ownership and recovery

The browser app provider owns host connections across route changes. Web Locks
elect one owner across same-origin tabs, and BroadcastChannel carries bounded
channel traffic to it. Monotonic owner terms fence delayed messages. Closing or
freezing the owner releases its lock; another tab connects and its views replay
from their existing history anchors. Unsupported coordination APIs produce an
explicit error. Each account, registered device key, and host has its own lock
and connection. Registration finishes before connection admission; replacing a
device key retires its connections and authenticates successors with the new key.

The mobile authenticated root retains a host WebView independently of terminal
screens. Terminal WebViews render locally and proxy channel operations through
the native bridge. Three seconds in the background may retire the transport;
foreground reopening restores views. Neither backgrounding nor closing the last
view terminates a session. Signing out, changing accounts, or revoking host trust
retires the affected connections and pending work. Replacing the phone's signing
key also recreates its host and terminal workers, even within the same account.

Each host has one reconnect notice and retry action. Panes preserve their last
output for copying and indicate that input is paused. Input accepted before a
loss may have executed; unsent input is discarded and never replayed on a new
attachment. Upload and file-write uncertainty continues to use the existing
reconciliation flows and stable operation IDs.

A session remembers its controlling device even when that device has no attached
views. Viewing and reconnecting from another device do not resize the terminal
or acquire input control. **Take control** explicitly transfers that lease.
Focusing another view within the owning device transfers its active view and
geometry. The UI waits for daemon confirmation before enabling input.

## Bounds and verification

Channel proxies bound individual frames to 64 KiB, queued sends to 256 KiB and
1,024 messages per channel, and outstanding receive credit to 2 MiB and 1,024
messages. Scheduling visits channels independently with a small native send
buffer. The daemon caps a pair at 128 terminal attachments and 32 additional
host-control consumers. Existing session replay and host-file streaming limits
continue to apply. SCTP still shares congestion across the peer, so bandwidth
contention must be measured with concurrent terminal and file traffic.

Behavioral coverage belongs in daemon native WebRTC tests, the browser connection
manager tests, mobile worker/transport tests, and `smoke-local-browser-live.sh`.
The live smoke checks signed shell output, input, uploads, same-device tab reuse,
typing in a second session during an 8 MiB upload, and owner handover against an
isolated API and daemon. Native mobile lifecycle,
real network transitions, and platform release gates still require their own
runtime evidence before release.
