# Shared device connections

SPAWN D opens one authenticated WebRTC connection per device and daemon while
its signed-in app is open. All terminal views and host operations reuse it.
The server still owns session creation, session metadata, and workspace layout;
this change does not move those authorities to the daemon.

## Wire and authorization

The existing `spawn.host.v1` signaling websocket accepts `rtc_version=2`.
Its signed transcript uses host scope, protocol `spawn.host.ctl`, and protocol
version 2. Both endpoints verify the expected identity and signed RTC session;
the outer binding nonce/generation are checked separately as routing and
lifecycle fields. Unsigned v2 offers and answers fail closed.
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
channel traffic to it. Monotonic owner terms fence handovers, and child epochs
reject delayed opens after readiness loss on the same peer. Closing or
freezing the owner releases its lock; another tab connects and its views fetch
a fresh history seed, merging live output at its PTY offset. Unsupported
coordination APIs produce an explicit error. Each account, registered device key,
and host has its own lock and connection. Registration finishes before
connection admission; replacing a
device key retires its connections and authenticates successors with the new key.

The mobile authenticated root retains a host WebView independently of terminal
screens. Terminal WebViews render locally and proxy channel operations through
the native bridge. Each host-tool surface has its own host-control channel,
request/stream state, a bounded send queue and receive credits; closing or
failing it leaves the root, other tools and terminal attachments intact. Three
seconds in the background may retire the transport; foreground reopening
also checks the deadline because native runtimes can pause JavaScript timers.
Reopening restores views. Neither backgrounding nor closing the last view
terminates a session. Signing out, changing accounts, or revoking host trust
retires the affected connections and pending work. Replacing the phone's signing
key also recreates its host and terminal workers, even within the same account.

Each host has one reconnect notice and retry action. Panes preserve their last
output for copying and indicate that input is paused. Input accepted before a
loss may have executed; unsent input is discarded at every application queue.
Leaving host readiness retires child channels even when ICE repair retains the
physical peer. Recovery creates fresh attachments and host consumers, so delayed
old dispatches cannot resume. Upload and file-write uncertainty continues to use
the existing reconciliation flows and stable operation IDs.

Reprocessing an already-active host approval does not restart healthy or recovering
connections or renew its approval timestamp. It can retry a refused root after
device approval; the browser owner checks its current state so repeated requests
from different tabs cannot restart recovery. Workspace navigation can replay signed
host introductions; only a real local trust or routing-binding change restarts a
healthy connection. New approvals, revocations and resets remain visible.

Opening a running session uses fresh session/host list metadata when available,
preserving its original cache timestamp. Authentication, attachment authorization
and control ownership still come from the shared transport and daemon. Mobile
starts the session channels while its terminal WebView loads; up to 512 events
and 2 MiB of encoded data wait for that renderer. Retirement, queue overflow or
account changes discard that attachment's pending events. Both channel proxies
also retain bounded data received before the native channel-open event, then
deliver it in order after open. In particular, an early daemon `ready` frame
must not be discarded and force a ten-second attachment retry.

Fast initial attachments have a 240 ms connecting-notice grace period. A slower
initial render on an already-ready host shows a compact opening status, while
host setup, failures and recovery retain their connection messages. Readiness,
replay completion and daemon-confirmed input control remain independent gates;
the grace period cannot enable input. Errors and recovery remain visible, and
host-wide failures include the host name in both clients.

A session remembers its controlling device in supervisor memory even when that
device has no attached views; the lease does not survive a supervisor restart.
Viewing and reconnecting from another device do not resize the terminal
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
isolated API and daemon. It also measures first and repeat opens of three running
sessions, checking initial output, input, no connecting flash, exactly one
attachment on first open, and no replacement peer or ICE offer. Native mobile lifecycle, real network transitions,
and platform release gates still require their own
runtime evidence before release.

### Native acceptance

`.github/workflows/acceptance.yml` builds and runs a disposable Release app on
an iOS simulator and an Android emulator for the exact candidate commit. The
driver exists only in a disposable build copy; it uses the real authenticated
providers, terminal and host-tool surfaces, WebViews, daemon and session workers.
No production account, host or mobile signing identity is needed.

The fixture checks two sessions and two host tools sharing one peer, surface
detach/reopen, short and long background intervals, process restart, account
and device-identity retirement, and interrupted/fresh uploads with file hashes.
Shell input and process survival are checked independently on the daemon host.
A private coturn listener and bounded UDP proxy force a relay path. Native
`getStats()` must identify relay/UDP, and TURN application-data counters must
advance before actual bidirectional outage, packet loss and delay are injected.
HTTP throttling or STUN keepalives cannot satisfy that evidence.

The release gate requires separate passing iOS, Android and isolated-canary
reports tied to the candidate and deployed baseline. Missing, skipped or failed
cases block promotion. Logs and screenshots accompany native reports; private
fixture credentials and the test app are excluded from artifacts.

This provides unattended native runtime and controlled network-failure
evidence. It does not establish physical-device memory pressure, real radio
handover between Wi-Fi and cellular, or production fleet behavior. The following
physical-device matrix remains useful supplemental evidence; label it separately
from simulator, emulator and Jest results.

| Case | Exercise | Required observation |
| --- | --- | --- |
| Reuse and detach | Open two sessions and a file browser on one host; close and reopen each surface. | One device-to-host peer serves them; closing a surface leaves its siblings and the session workers running. |
| Background and resume | Background briefly, then for more than three seconds; resume with both sessions open. | The short interruption and transport retirement both recover. Views reattach once, stale worker events cannot enable input or retire a new attachment, and session processes survive. |
| Network change | Switch Wi-Fi to mobile data and back while output is streaming; repeat with direct connectivity unavailable and UDP TURN available. | Recovery restores both sessions and tools. Each host has one reconnect notice; input stays paused until fresh attachment/control confirmation. |
| Queued input and files | Interrupt a backpressured paste and an upload while typing in the other session. | Unsent input is discarded. Already-dispatched input remains explicitly uncertain; interrupted writes follow the existing reconciliation flow without a blind duplicate write. |
| Process restart | Terminate and reopen the app while sessions are running. | A fresh connection restores history and live output; the daemon's session workers survive, and another device's control lease is not taken implicitly. |
| Identity retirement | In the isolated fixture, sign out, switch accounts, replace the device key, and revoke host trust. | Each action retires the affected connection and pending work. Delayed bridge events cannot revive it or reach the next identity. |

Retain device logs and the observed peer/attachment lifecycle with the review
evidence. Report failures and unavailable cases explicitly rather than treating
successful bundling, component tests, or a green CI lane as native acceptance.
