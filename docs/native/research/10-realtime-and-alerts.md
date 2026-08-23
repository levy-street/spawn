# R10 — Realtime control plane, host control, alerts and notifications

## TL;DR
1. Spawn has three separate live transports: one owner alert WebSocket, one signaling WebSocket plus WebRTC pair per terminal, and one signaling WebSocket plus WebRTC DataChannel per controlled host.
2. The alert socket uses spawn.alerts.v1, a 25-second server ping, an 80-second client watchdog, and jittered exponential reconnect from 1–15 seconds, but it has no cursor, acknowledgement, replay, or durable history.
3. Session signaling uses spawn.v3 and host signaling uses spawn.host.v1; terminal bytes, terminal controls, file bytes, metrics, and host commands must use authenticated WebRTC DataChannels.
4. No inbound WebSocket or DataChannel event directly patches a React Query entity today; alert events invalidate the sessions prefix, while most live state stays inside transport-local stores until REST polling catches up.
5. Host control exposes bounded home-directory file operations, streaming reads/writes, preview, exact capacity, and guarded desktop reveal/open; capabilities, signed-host trust, and daemon path policy are the effective permissions.
6. Alert delivery is transient and device-local: preferences live in localStorage, cross-tab claiming only arbitrates sound/haptics/system notifications, and visual attention badges derive from refreshed session state rather than stored alerts.
7. Foreground process disclosure is only a sanitized executable basename; activity is a coarse starting/active/input-sent/waiting/quiet state, and server capacity is bucketed while exact capacity is direct over host control.
8. Native must wire AppState and network changes into TanStack Query, retire every stale socket/RTC generation on background or interface change, and perform a deterministic refetch/reconnect sweep on resume.
9. The server has no APNs, FCM, Expo push, or Web Push subscription path; Expo Go can schedule local notifications but cannot receive remote push, so suspended or terminated apps cannot learn about new alerts.
10. **DECISION REQUIRED:** stock Expo Go has no WebRTC DataChannel implementation; live terminals and host control therefore require either a WebView fallback in Expo Go, a development build, or a new server transport.

## 1. Scope and transport topology

This report covers the code that keeps browser state live and the native-mobile behavior that must replace browser assumptions. It does not redefine the REST surface or the PTY wire protocol. The important architectural split is:

| Plane | Client endpoint | Negotiated protocol | Payload carried on that socket | Long-lived data path |
|---|---|---|---|---|
| Owner alerts | /ws/alerts | spawn.alerts.v1 | alert and keepalive JSON | WebSocket itself |
| Terminal session | /ws/browser?session_id=PTY_UUID | spawn.v3 | lifecycle and WebRTC signaling JSON | spawn.pty and spawn.ctl WebRTC DataChannels |
| Host control | /ws/host?host_id=HOST_UUID | spawn.host.v1 | WebRTC signaling JSON | spawn.host.ctl WebRTC DataChannel |

The URL constructors and terminal transport requirement are explicit in web/src/lib/ws.ts:1-8 and web/src/lib/ws.ts:16-48. The server rejects terminal bytes and terminal-control traffic on the signaling socket; the browser comment consequently calls both DataChannels mandatory (web/src/lib/ws.ts:4-8; server/spawn_server/ws/browser.py:344-620).

The default origin is NEXT_PUBLIC_SPAWN_WS_URL when nonempty. Otherwise the browser derives ws:// or wss:// from window.location; server-side rendering falls back to ws://localhost:3000 (web/src/lib/ws.ts:16-28). Native has no window.location, so it must receive a normalized API base URL and derive the matching WS origin explicitly.

**RECOMMEND:** Put REST and WebSocket base URL derivation in one native auth/environment module. A native tunnel, staging host, or production host must not independently configure two origins.

### 1.1 Authentication

All three server WebSocket handlers use the same user resolver. Authentication preference is:

1. Authorization: Bearer ACCESS_TOKEN header.
2. spawn_session cookie.
3. token query parameter.

The resolver validates that the JWT is an access token and that its subject identifies a current user (server/spawn_server/ws/browser.py:123-156). The web constructors add neither header nor query token and therefore rely on the same-origin cookie (web/src/lib/ws.ts:30-48). Logout closes the singleton alert socket before revoking the cookie (web/src/lib/auth.ts:56-71).

**RECOMMEND:** Native should use the Authorization header when its WebSocket implementation accepts headers. Use the documented token query parameter only as a compatibility fallback, because URLs are more likely to be captured in logs and diagnostics.

Each session or host attach is owner-scoped. The browser session handler checks session ownership before signaling (server/spawn_server/ws/browser.py:178-188). The host handler authenticates, loads the host, and rejects a non-owner with close code 1008 (server/spawn_server/ws/host.py:381-397). The alert subscription selects a Redis channel derived from the authenticated user ID (server/spawn_server/ws/alerts.py:228-264).

### 1.2 There is no one global realtime connection

The alert socket is a module singleton per browser tab and survives AppShell route remounts (web/src/lib/alert-socket.ts:6-20). Terminal connections are leased from LiveTerminalProvider, which can retain up to six warm, parked terminal instances (web/src/components/terminal/LiveTerminalProvider.tsx:18-24; web/src/components/terminal/LiveTerminalProvider.tsx:59-130). useHostControl creates one HostControlClient for the mounted host-control consumer and closes it on unmount (web/src/hooks/useHostControl.ts:13-100).

Native should preserve the separation but centralize ownership. An alert connection is account-scoped; a terminal connection is session-scoped; a host-control connection is host-scoped and should exist only while a feature needs it.

### 1.3 Heartbeat, replay, and dedup summary

| Transport | Application heartbeat | Reconnect | Resume/replay | Duplicate/stale defense |
|---|---|---|---|---|
| Alert WS | Server alerts.ping every 25 s; client silence watchdog 80 s | Jittered exponential 1–15 s | None | 60-ms cross-tab claim keyed by event/session/at; not durable |
| Session signaling WS | None | Linear 500 ms × attempt, cap 10 s | Server sends current session.status on attach; no event replay | Exact RTC ID/nonce/generation/scope tuple |
| Terminal RTC | Peer connection state and five-second disconnected grace; stats every five seconds, not a heartbeat | Fresh RTC generation, retry 5–60 s | spawn.ctl requests 400 history lines then subscribes; this is terminal content bootstrap, not signaling replay | Fresh generation and ordered/reliable channels |
| Host signaling/RTC | No periodic heartbeat; ping is an optional request and has no normal production caller | Signaling linear 500 ms × attempt, cap 10 s | None; pending requests/streams are rejected, never replayed | Server binding nonce/daemon generation; request IDs; stream sequence/hash/tombstones |
| Daemon presence WS | host.heartbeat every 30 s with server acknowledgement | Daemon-owned | Latest host presence/capacity only | Current daemon connection/generation fencing |

Alert timing is defined in web/src/lib/alert-socket.ts:27-35 and server/spawn_server/ws/alerts.py:35-63. Session timing/bootstrap is web/src/components/terminal/useSessionSocket.ts:137-146, web/src/components/terminal/useSessionSocket.ts:930-970, and web/src/components/terminal/useSessionSocket.ts:1480-1509. Host ping and reconnect are web/src/lib/hostControl.ts:421-423 and web/src/lib/hostControl.ts:1686-1717. Daemon heartbeat timing is daemon/src/run.rs:37 and daemon/src/run.rs:726-746.

No transport replays a side-effecting client command after reconnect. This is mandatory for host-control ambiguity and desirable for terminal input; only explicit terminal history bootstrap is replay-like.

## 2. Alert WebSocket client

### 2.1 State and public surface

The web alert module exposes:

- AlertSocketState = idle | connecting | open | closed.
- subscribeToAlerts(listener), returning an unsubscribe function.
- subscribeToAlertSocketState(listener), returning an unsubscribe function.
- getAlertSocketState().
- closeAlertSocket().

These are external-store style functions rather than React state (web/src/lib/alert-socket.ts:23-25; web/src/lib/alert-socket.ts:182-209). The notification settings panel uses open as the connected indicator (web/src/components/settings/NotificationsPanel.tsx:26-107).

The first listener starts the connection. Removing the final listener starts a 15-second linger timer; if no listener returns, the module closes the socket. This avoids route-transition churn (web/src/lib/alert-socket.ts:163-179).

### 2.2 Lifecycle constants

| Behavior | Literal value | Source |
|---|---:|---|
| Initial reconnect base | 1,000 ms | web/src/lib/alert-socket.ts:27-35 |
| Reconnect cap | 15,000 ms | web/src/lib/alert-socket.ts:27-35 |
| Server-silence watchdog | 80,000 ms | web/src/lib/alert-socket.ts:27-35 |
| No-subscriber linger | 15,000 ms | web/src/lib/alert-socket.ts:27-35 |
| Server keepalive | 25 seconds | server/spawn_server/ws/alerts.py:35-63 |
| Claim window, separate from transport | 60 ms | web/src/lib/alert-claim.ts:21-100 |

Reconnect is jittered exponential:

~~~ts
const base = Math.min(15_000, 1_000 * 2 ** attempt);
const delay = base * randomBetween(0.7, 1.3);
attempt = Math.min(attempt + 1, 6);
~~~

The attempt counter resets on open. The implementation caps the computed base at 15 seconds and the attempt counter at six (web/src/lib/alert-socket.ts:75-110).

On every received frame, including alerts.ping, the client rearms the 80-second watchdog. A watchdog expiry closes the socket so reconnect can proceed (web/src/lib/alert-socket.ts:113-127). The server sends alerts.ping every 25 seconds (server/spawn_server/ws/alerts.py:272-277).

The browser listens for visibilitychange and online. Becoming visible or online wakes a connection only when there is no already-open socket. pagehide clears the watchdog; it does not close the socket or establish a resume token (web/src/lib/alert-socket.ts:140-161).

### 2.3 Parsing and delivery

The socket selects subprotocol spawn.alerts.v1. A missing protocol receives protocol.required and close code 4003 (web/src/lib/alert-socket.ts:96-110; server/spawn_server/ws/alerts.py:228-241).

Every text frame is JSON-parsed. Only type alert is passed to consumer listeners. alerts.ping has transport value because it rearms the watchdog, but no application callback. An exception in one consumer is isolated from other consumers (web/src/lib/alert-socket.ts:113-127).

The server expects no inbound commands. It receives only to notice disconnect, ignores unexpected text, and logs then ignores unexpected binary data (server/spawn_server/ws/alerts.py:288-298).

There is no sequence number, last-event ID, acknowledgement, resume request, durable alert record, or replay subscription. The server subscribes to the current Redis owner channel and forwards future messages only (server/spawn_server/ws/alerts.py:250-270). Therefore any alert published before the subscription is ready, while the client is disconnected, or while a mobile process is suspended is lost as an alert event.

**RECOMMEND:** Treat reconnection as current-state recovery, not alert replay. Refetch sessions/workspaces/hosts after reconnect. Do not manufacture a finished alert from current state because finished is a transition and is not reconstructible.

## 3. Session signaling and terminal liveness

### 3.1 Connection lifecycle

useSessionSocket owns the session signaling WebSocket, RTCPeerConnection, spawn.pty channel, spawn.ctl channel, bootstrap/history state, upload state, pending terminal input, liveness timers, and connection metrics (web/src/components/terminal/useSessionSocket.ts:40-82; web/src/components/terminal/useSessionSocket.ts:105-146).

Literal limits:

| Limit | Value | Source |
|---|---:|---|
| RTC connect deadline | 10 seconds | web/src/components/terminal/useSessionSocket.ts:137-146 |
| Upload readiness deadline | 20 seconds | web/src/components/terminal/useSessionSocket.ts:137-146 |
| Peer disconnected grace | 5 seconds | web/src/components/terminal/useSessionSocket.ts:137-146 |
| RTC retry range | exponential 5–60 seconds | web/src/components/terminal/useSessionSocket.ts:137-146 |
| Pending input ceiling | 64 KiB | web/src/components/terminal/useSessionSocket.ts:137-146 |
| RTC stats interval | 5 seconds | web/src/components/terminal/useSessionSocket.ts:1512-1590 |
| History bootstrap | 400 lines, then subscribe | web/src/components/terminal/useSessionSocket.ts:930-970 |

The signaling reconnect is linear, not exponential:

~~~ts
delay = Math.min(10_000, 500 * attempt)
~~~

There is no jitter, online listener, visibility listener, heartbeat, or socket-silence watchdog in this hook (web/src/components/terminal/useSessionSocket.ts:1480-1509). A normal component unmount closes the socket with code 1000 (web/src/components/terminal/useSessionSocket.ts:1489-1509).

When a peer becomes disconnected, the hook grants five seconds for recovery. failed or closed tears down RTC and schedules another generation (web/src/components/terminal/useSessionSocket.ts:1018-1039). Each generation gets a browser-minted RTC signaling session ID plus binding nonce. Answers, candidates, and statuses must match the complete immutable binding tuple and positive generation, not merely the reusable PTY session ID (web/src/lib/ws.ts:159-195).

Both DataChannels are reliable and ordered. The terminal becomes ready only when spawn.pty and spawn.ctl are open, server readiness is established, and initial history bootstrap has completed (web/src/components/terminal/useSessionSocket.ts:812-832).

### 3.2 What state reaches React

The hook exposes socketState, protocol/version state, data-channel readiness, connection information, trust/refusal information, metrics, sendBinary, sendJson, and upload helpers (web/src/components/terminal/useSessionSocket.ts:1670-1680). Terminal supplies an onExit callback that writes a local exit banner and invokes its optional parent callback; it does not supply onStatus (web/src/components/terminal/Terminal.tsx:1300-1308).

The terminal's trust prerequisites are separate React Query reads of ["session", sessionId] and ["host", hostId], both with a 30-second stale time. Socket creation is gated until the host trust decision can be evaluated (web/src/components/terminal/Terminal.tsx:1023-1075).

The pooled terminal provider retains connection state in its own warm/claimed terminal registry (web/src/components/terminal/LiveTerminalProvider.tsx:156-229; web/src/components/terminal/LiveTerminalProvider.tsx:296-310). Session signaling does not patch ["session", id] or ["sessions"]. REST polling or alert-driven invalidation remains responsible for the global list.

### 3.3 Terminal control never belongs on signaling WS

The TypeScript OutboundMessage union retains resize, take_control, scroll, and snapshot names, but useSessionSocket routes those operations to spawn.ctl. Only RTC offer, candidate, and close use the signaling WebSocket (web/src/lib/ws.ts:134-157; web/src/components/terminal/useSessionSocket.ts:1592-1624).

Terminal input bytes use spawn.pty or wait in the bounded pending-input buffer. There is no WebSocket content fallback (web/src/components/terminal/useSessionSocket.ts:1592-1624). This is security- and architecture-relevant for Expo Go; see section 12.

## 4. Literal message catalogue

The examples below are logical JSON. UUIDs, nonces, generations, SDP, ICE, hashes, and paths are examples, not constants.

### 4.1 Alert socket: server to client

#### Keepalive

~~~json
{"type":"alerts.ping"}
~~~

The client uses this only to reset the watchdog (web/src/lib/alert-socket.ts:113-127). The server sends it at 25-second intervals (server/spawn_server/ws/alerts.py:272-277).

#### Alert

~~~json
{
  "type": "alert",
  "event": "agent.finished",
  "session_id": "7a150707-3121-48bf-a557-f06bb2218937",
  "command": "claude",
  "at": "2026-08-22T04:12:53.103Z"
}
~~~

event is agent.finished, agent.awaiting_input, or session.died. command is optional/null for session.died; exit_code and signal are fields of session.died (web/src/lib/alerts.ts:17-68; server/spawn_server/ws/alerts.py:193-225).

#### Protocol rejection

~~~json
{"type":"protocol.required","protocol":"spawn.alerts.v1","version":1}
~~~

This is sent only when the client did not offer spawn.alerts.v1, followed by close code 4003 (server/spawn_server/ws/alerts.py:228-237).

### 4.2 Alert socket: client to server

There is no application message. The server ignores text and binary input (server/spawn_server/ws/alerts.py:288-298).

### 4.3 Session signaling: server to client

#### RTC configuration

~~~json
{
  "type": "rtc.config",
  "enabled": true,
  "ice_servers": [{"urls":["stun:stun.example.test:3478"]}],
  "binding_nonce_required": true
}
~~~

The client refuses an enabled configuration unless binding_nonce_required is true (web/src/lib/ws.ts:62-67; web/src/components/terminal/useSessionSocket.ts:1270-1465).

#### Current lifecycle state

~~~json
{"type":"session.status","status":"running"}
~~~

status is starting, running, exited, or killed (web/src/lib/ws.ts:59-62). The server sends rtc.config plus current session.status when a browser attaches, so lifecycle state partially resynchronizes after reconnect (server/spawn_server/ws/browser.py:193-196).

#### Exit

~~~json
{"type":"session.exit","exit_code":137,"signal":"SIGKILL"}
~~~

Both values may be null (web/src/lib/ws.ts:59-61).

#### RTC answer, raw carrier

~~~json
{
  "type": "rtc.answer",
  "session_id": "browser-rtc-generation-id",
  "binding_nonce": "one-use-random-nonce",
  "binding_generation": 7,
  "scope_type": "session",
  "scope_id": "PTY-session-uuid",
  "protocol": "spawn.pty",
  "protocol_version": 2,
  "sdp": "answer-sdp"
}
~~~

#### RTC answer, signed carrier

~~~json
{
  "type": "rtc.answer",
  "session_id": "browser-rtc-generation-id",
  "binding_nonce": "one-use-random-nonce",
  "binding_generation": 7,
  "scope_type": "session",
  "scope_id": "PTY-session-uuid",
  "protocol": "spawn.pty",
  "protocol_version": 2,
  "signed_envelope": "signed-answer-envelope"
}
~~~

signed_envelope and sdp are mutually exclusive relay carriers (web/src/lib/ws.ts:68-81). A generation that starts signed mode cannot silently fall back to its raw sibling (web/src/lib/ws.ts:77-80).

#### RTC candidate

~~~json
{
  "type": "rtc.candidate",
  "session_id": "browser-rtc-generation-id",
  "binding_nonce": "one-use-random-nonce",
  "binding_generation": 7,
  "scope_type": "session",
  "scope_id": "PTY-session-uuid",
  "protocol": "spawn.pty",
  "protocol_version": 2,
  "candidate": {
    "candidate": "candidate:...",
    "sdpMid": "0",
    "sdpMLineIndex": 0
  }
}
~~~

The client ignores a stale or wrong RTC identity (web/src/lib/ws.ts:178-195; web/src/components/terminal/useSessionSocket.ts:1270-1465).

#### RTC status

~~~json
{
  "type": "rtc.status",
  "session_id": "browser-rtc-generation-id",
  "binding_nonce": "one-use-random-nonce",
  "binding_generation": 7,
  "scope_type": "session",
  "scope_id": "PTY-session-uuid",
  "protocol": "spawn.pty",
  "protocol_version": 2,
  "status": "negotiating",
  "message": "optional detail"
}
~~~

The client handles negotiating as binding progress. failed, disabled, unavailable, and collision terminate or retry the generation according to trust and retry policy (web/src/lib/ws.ts:93-104; web/src/components/terminal/useSessionSocket.ts:1270-1465).

### 4.4 Session signaling: client to server

Every RTC frame carries this immutable tuple:

~~~json
{
  "scope_type": "session",
  "scope_id": "PTY-session-uuid",
  "protocol": "spawn.pty",
  "protocol_version": 2
}
~~~

The tuple is constructed in web/src/lib/ws.ts:118-132.

#### Offer, raw

~~~json
{
  "type": "rtc.offer",
  "session_id": "browser-rtc-generation-id",
  "binding_nonce": "one-use-random-nonce",
  "scope_type": "session",
  "scope_id": "PTY-session-uuid",
  "protocol": "spawn.pty",
  "protocol_version": 2,
  "sdp": "offer-sdp"
}
~~~

#### Offer, signed

~~~json
{
  "type": "rtc.offer",
  "session_id": "browser-rtc-generation-id",
  "binding_nonce": "one-use-random-nonce",
  "scope_type": "session",
  "scope_id": "PTY-session-uuid",
  "protocol": "spawn.pty",
  "protocol_version": 2,
  "signed_envelope": "signed-offer-envelope"
}
~~~

#### Candidate

~~~json
{
  "type": "rtc.candidate",
  "session_id": "browser-rtc-generation-id",
  "binding_nonce": "one-use-random-nonce",
  "scope_type": "session",
  "scope_id": "PTY-session-uuid",
  "protocol": "spawn.pty",
  "protocol_version": 2,
  "candidate": {"candidate":"candidate:...","sdpMid":"0","sdpMLineIndex":0}
}
~~~

#### Close generation

~~~json
{
  "type": "rtc.close",
  "session_id": "browser-rtc-generation-id",
  "binding_nonce": "one-use-random-nonce",
  "scope_type": "session",
  "scope_id": "PTY-session-uuid",
  "protocol": "spawn.pty",
  "protocol_version": 2
}
~~~

These four outbound shapes are defined in web/src/lib/ws.ts:134-157. Server signaling does not accept terminal input, resize, history, or snapshot frames (server/spawn_server/ws/browser.py:344-620).

### 4.5 Host signaling: both directions

Host signaling uses the same offer/answer/candidate/status concepts, but the metadata tuple is:

~~~json
{
  "scope_type": "host",
  "scope_id": "host-uuid",
  "protocol": "spawn.host.ctl",
  "protocol_version": 1
}
~~~

The host client verifies inbound signaling metadata against that tuple (web/src/lib/hostControl.ts:986-1230). The server's initial configuration is:

~~~json
{
  "type": "rtc.config",
  "enabled": true,
  "ice_servers": [],
  "ice_transport_policy": "all",
  "scope_type": "host",
  "scope_id": "host-uuid",
  "protocol": "spawn.host.ctl",
  "protocol_version": 1
}
~~~

ice_transport_policy is all or relay (server/spawn_server/ws/host.py:431-444).

A representative client offer is:

~~~json
{
  "type": "rtc.offer",
  "session_id": "browser-host-rtc-generation-id",
  "scope_type": "host",
  "scope_id": "host-uuid",
  "protocol": "spawn.host.ctl",
  "protocol_version": 1,
  "signed_envelope": "signed-offer-envelope"
}
~~~

The raw carrier replaces signed_envelope with sdp. Client candidate and close frames carry type, session_id, the host tuple, and candidate where applicable; they do not carry the server-minted binding nonce. HostControlClient constructs that outgoing metadata in web/src/lib/hostControl.ts:1129-1151 and web/src/lib/hostControl.ts:1407-1425.

The host server mints a nonce when it accepts an offer, injects it into the daemon relay, and requires the exact daemon connection, daemon generation, signaling session, and nonce before forwarding an answer/candidate/status back (server/spawn_server/ws/host.py:473-553; server/spawn_server/ws/host.py:259-350). Unlike the session client matcher, HostControlClient itself checks the outer host tuple and session_id but does not compare binding_nonce or binding_generation; a signed answer is additionally verified against the signed transcript (web/src/lib/hostControl.ts:1035-1104; web/src/lib/signed-rtc-live.ts:177-255).

An inbound signed answer is therefore shaped like:

~~~json
{
  "type": "rtc.answer",
  "session_id": "browser-host-rtc-generation-id",
  "binding_nonce": "server-minted-relay-nonce",
  "scope_type": "host",
  "scope_id": "host-uuid",
  "protocol": "spawn.host.ctl",
  "protocol_version": 1,
  "signed_envelope": "signed-answer-envelope"
}
~~~

The raw unpinned answer replaces signed_envelope with sdp. Inbound candidate carries the same outer fields plus candidate. rtc.status carries the same outer route, session_id, and a status; HostControlClient reacts to failed, disabled, and unavailable (web/src/lib/hostControl.ts:1035-1104).

The host server currently calls accept(subprotocol="spawn.host.v1") without first testing the offered list, unlike the alert/session handlers (server/spawn_server/ws/host.py:381-389; server/spawn_server/ws/browser.py:159-173). The web client does offer spawn.host.v1, so its normal connection is valid.

### 4.6 Host DataChannel: handshake and request/response

The channel label/protocol is spawn.host.ctl. All frames are JSON text, version 1, and no larger than 16 KiB (web/src/lib/hostControl.ts:7-18; web/src/lib/hostControl.ts:1232-1405).

Daemon hello:

~~~json
{
  "version": 1,
  "type": "hello",
  "protocol": "spawn.host.ctl",
  "capabilities": [
    "ping",
    "fs.home",
    "fs.list",
    "fs.stat",
    "fs.read",
    "fs.read.range",
    "fs.write.begin",
    "fs.mkdir",
    "fs.rename",
    "fs.remove",
    "fs.preview",
    "host.metrics",
    "desktop.reveal",
    "desktop.open"
  ],
  "limits": {
    "frame_bytes": 16384,
    "chunk_bytes": 8192,
    "file_bytes": 536870912,
    "directory_entries": 1024,
    "range_bytes": 16777216,
    "preview_bytes": 2097152,
    "preview_pixels": [128,256,512,1024],
    "normal_queue": 64,
    "fast_queue": 64,
    "long_tasks": 8,
    "write_reapers": 1
  }
}
~~~

Some optional capabilities are omitted when unsupported or telemetry is disabled. The daemon constructs hello before ready in daemon/src/host_control.rs:2097-2146. The web parser accepts at most 64 capability strings matching its restricted token syntax (web/src/lib/preview/capabilities.ts:50-85).

Client request:

~~~json
{
  "version": 1,
  "type": "request",
  "request_id": "random-id",
  "operation": "fs.stat",
  "payload": {"path":"Projects/spawn/README.md"}
}
~~~

Success:

~~~json
{
  "version": 1,
  "type": "response",
  "request_id": "random-id",
  "ok": true,
  "result": {"path":"Projects/spawn/README.md","kind":"file","size":19342}
}
~~~

Failure:

~~~json
{
  "version": 1,
  "type": "response",
  "request_id": "random-id",
  "ok": false,
  "error": {"code":"not_found","detail":"path not found"}
}
~~~

The daemon response envelope is generated in daemon/src/host_control.rs:372-401. The client turns a failed response into HostControlError(code, detail) (web/src/lib/hostControl.ts:44-51; web/src/lib/hostControl.ts:1232-1405).

Client cancellation:

~~~json
{"version":1,"type":"cancel","request_id":"random-id"}
~~~

Cancellation is best effort (web/src/lib/hostControl.ts:1436-1445). Once an indeterminate mutation has been dispatched, timeout or abort yields outcome_unknown rather than implying rollback (web/src/lib/hostControl.ts:348-419; web/src/lib/hostControl.ts:1556-1630).

### 4.7 Host DataChannel: read stream

The successful fs.read, fs.read.range, or fs.preview result declares stream_id, length, and sha256. Binary content is then base64 in ordered JSON chunks:

~~~json
{"version":1,"type":"stream.chunk","stream_id":"s1","sequence":0,"bytes_b64":"BASE64"}
{"version":1,"type":"stream.ack","stream_id":"s1","sequence":1}
{"version":1,"type":"stream.end","stream_id":"s1","length":12,"sha256":"FULL-LOWERCASE-HEX-SHA256"}
~~~

The receiver verifies strict sequence, declared byte length, and SHA-256; it acknowledges a bounded window and keeps tombstones so late chunks for cancelled streams can be drained safely (web/src/lib/hostControl.ts:489-553; web/src/lib/hostControl.ts:1232-1405).

### 4.8 Host DataChannel: write stream

Begin request:

~~~json
{
  "version":1,
  "type":"request",
  "request_id":"r-write",
  "operation":"fs.write.begin",
  "payload":{
    "dir":"Projects/spawn/tmp",
    "name":"notes.txt",
    "length":12,
    "sha256":"FULL-LOWERCASE-HEX-SHA256",
    "overwrite":false
  }
}
~~~

The successful result declares a stream ID. The client sends:

~~~json
{"version":1,"type":"stream.chunk","stream_id":"w1","sequence":0,"bytes_b64":"aGVsbG8gd29ybGQK"}
{"version":1,"type":"stream.end","stream_id":"w1","length":12,"sha256":"FULL-LOWERCASE-HEX-SHA256"}
{"version":1,"type":"stream.committed","stream_id":"w1","path":"Projects/spawn/tmp/notes.txt"}
~~~

stream.committed is daemon to client, not client to daemon. The client emits 8-KiB chunks, honors DataChannel backpressure, applies a 60-second stream timeout, and treats connection loss after the commit boundary as outcome_unknown (web/src/lib/hostControl.ts:846-957).

### 4.9 Complete host DataChannel frame list

| Direction | type | Required application fields | Client behavior |
|---|---|---|---|
| Daemon → client | hello | version, protocol, capabilities; limits also supplied | Validate v1/protocol, parse capabilities, become ready |
| Daemon → client | response | request_id, ok, result or error{code,detail} | Resolve/reject matching pending request; unmatched response is ignored |
| Daemon → client | stream.chunk | stream_id, sequence, bytes_b64 | Require expected stream/sequence, decode bounded nonempty chunk, update hash/length |
| Daemon → client | stream.end | stream_id, length, sha256 | Require declared/received length and all hashes to match, then close reader |
| Daemon → client | stream.committed | stream_id, path | Resolve outgoing write |
| Daemon → client | stream.error | stream_id, error{code,detail} | Reject active read/write or consume cancellation tombstone |
| Client → daemon | request | request_id, operation, optional payload | Starts one operation; duplicate IDs are fatal to daemon channel |
| Client → daemon | cancel | request_id | Best-effort cancel for timed-out/aborted request |
| Client → daemon | stream.ack | stream_id, sequence | Advances daemon read window |
| Client → daemon | stream.cancel | stream_id | Best-effort stop for incoming read |
| Client → daemon | stream.chunk | stream_id, sequence, bytes_b64 | Supplies write bytes |
| Client → daemon | stream.end | stream_id, length, sha256 | Declares write commit boundary |

Client validation/dispatch is web/src/lib/hostControl.ts:1232-1405 and client send framing is web/src/lib/hostControl.ts:1436-1467. Daemon normal/fast dispatch is daemon/src/host_control.rs:420-455; daemon response/error frames are daemon/src/host_control.rs:372-401.

### 4.10 WebSocket close codes that native must classify

| Code | Meaning in this surface | Retry? | Source |
|---:|---|---|---|
| 1000 | Normal client unmount/host-control close | Only if a new foreground lease requests it | web/src/components/terminal/useSessionSocket.ts:1489-1509; web/src/lib/hostControl.ts:331-345 |
| 1002 | Client detected selected-protocol/binding/binary protocol violation | No blind loop; surface incompatible/protocol error | web/src/components/terminal/useSessionSocket.ts:1245-1288; web/src/components/terminal/useSessionSocket.ts:1463-1465 |
| 1008 | Authentication, missing owner session, or missing owner host | Refresh auth once; otherwise stop and surface access/not-found | server/spawn_server/ws/browser.py:123-188; server/spawn_server/ws/host.py:381-397 |
| 1009 | Signaling JSON exceeds server limit | Do not retry the same frame | server/spawn_server/ws/browser.py:354-362; server/spawn_server/ws/host.py:455-459 |
| 4002 | Binary or forbidden content on signaling WebSocket | Programming/protocol error; never route content there | server/spawn_server/ws/browser.py:344-387; server/spawn_server/ws/host.py:445-453 |
| 4003 | Required spawn.v3 or spawn.alerts.v1 not offered | Client upgrade/configuration required | server/spawn_server/ws/browser.py:159-173; server/spawn_server/ws/alerts.py:228-237 |

The current browser alert reconnect loop does not branch on close code; it retries any gone socket while subscribed (web/src/lib/alert-socket.ts:129-138). Native should avoid hammering permanent 1008/4003 failures.

## 5. Event-to-cache and local-store mapping

This table is intentionally exhaustive for inbound live events. A dash means no direct React Query effect.

| Inbound event/frame | React Query effect | Local effect | Source |
|---|---|---|---|
| alerts.ping | — | Rearm alert watchdog | web/src/lib/alert-socket.ts:113-127 |
| alert, disabled event kind | — | None; preference gate returns before invalidation | web/src/hooks/useSessionAlerts.tsx:81-111 |
| alert, muted session | — | None; mute gate returns before invalidation | web/src/hooks/useSessionAlerts.tsx:81-111 |
| alert, enabled/unmuted, session currently visible | invalidateQueries({queryKey:["sessions"]}) | Suppress toast, sound, haptic, and system notification | web/src/hooks/useSessionAlerts.tsx:89-111 |
| alert, enabled/unmuted, not visible/current | invalidateQueries({queryKey:["sessions"]}) | Build title/body; visible app may toast; hidden app may issue system notification; sound/haptic need cross-tab claim | web/src/hooks/useSessionAlerts.tsx:103-147 |
| session.status | — | Optional useSessionSocket onStatus callback only; Terminal does not provide it | web/src/components/terminal/useSessionSocket.ts:1270-1465; web/src/components/terminal/Terminal.tsx:1300-1308 |
| session.exit | — | Terminal writes local exit banner and calls optional parent onExit | web/src/components/terminal/Terminal.tsx:1300-1308 |
| rtc.config, session | — | Create or reject RTC generation | web/src/components/terminal/useSessionSocket.ts:1270-1465 |
| rtc.answer, session | — | Set remote description after full binding check | web/src/lib/ws.ts:178-195; web/src/components/terminal/useSessionSocket.ts:1270-1465 |
| rtc.candidate, session | — | Add candidate after full binding check | web/src/lib/ws.ts:178-195; web/src/components/terminal/useSessionSocket.ts:1270-1465 |
| rtc.status, session | — | Bind generation or tear down/retry/refuse | web/src/components/terminal/useSessionSocket.ts:1270-1465 |
| spawn.pty data | — | Write terminal bytes/history into xterm-local state | web/src/components/terminal/useSessionSocket.ts:812-832; web/src/components/terminal/useSessionSocket.ts:930-970 |
| spawn.ctl response/history/state | — | Resolve terminal-local control/bootstrap operation | web/src/components/terminal/useSessionSocket.ts:812-970 |
| rtc.config/answer/candidate/status, host | — | Advance or fail HostControlClient connection/trust state | web/src/lib/hostControl.ts:986-1230 |
| host hello | — | Parse capabilities; state becomes ready; notify external-store subscribers | web/src/lib/hostControl.ts:1232-1405; daemon/src/host_control.rs:2097-2146 |
| host response | — | Resolve/reject one pending request | web/src/lib/hostControl.ts:1232-1405 |
| host stream.chunk/end/error/committed | — | Advance stream, hash/length checks, resolve/reject transfer | web/src/lib/hostControl.ts:489-553; web/src/lib/hostControl.ts:1232-1405 |
| host.metrics response | — | useHostCapacity replaces its local latest sample; retains last sample on later failure | web/src/hooks/useHostCapacity.ts:8-104 |
| malformed/unknown alert frame | — | Ignore after JSON/parser validation | web/src/lib/alerts.ts:38-68; web/src/lib/alert-socket.ts:113-127 |
| malformed session text frame | — | parseInbound returns null; ignore | web/src/lib/ws.ts:106-114; web/src/components/terminal/useSessionSocket.ts:1270-1465 |
| binary session signaling frame | — | Close as protocol error | web/src/components/terminal/useSessionSocket.ts:1270-1465 |
| host signaling frame with wrong tuple | — | Ignore, except a wrong-route signed answer can fail the current generation | web/src/lib/hostControl.ts:1018-1104 |
| malformed/oversized/unknown host DataChannel frame | — | Fail the entire RTC generation | web/src/lib/hostControl.ts:1232-1405 |

invalidateQueries(["sessions"]) is a prefix invalidation. It reaches the all-sessions query and filtered forms such as ["sessions",{host_id}], but not singular ["session",id]. The application uses all-sessions polling in the sidebar every five seconds (web/src/components/nav/Sidebar.tsx:59-80), workspace all-sessions polling every five seconds (web/src/app/w/[id]/page.tsx:54-70), singular session polling every five seconds (web/src/components/session/session-view.tsx:62-72), and host-filtered sessions polling every five seconds (web/src/app/hosts/[id]/page.tsx:75-86).

React Query defaults are staleTime 10 seconds, refetchOnWindowFocus false, and retry 1 (web/src/lib/query.tsx:13-24). Workspace and host views override some intervals/stale times at their call sites.

Host file operations also do not automatically mutate query data. FileExplorer invalidates the relevant ["host-files", hostId, parentPath] after successful mutations; Refresh All invalidates the ["host-files", hostId] prefix (web/src/components/files/FileExplorer.tsx:478-499; web/src/components/files/FileExplorer.tsx:563-712).

The exact file query families are:

- Root: ["host-files", hostId, rootPath ?? ""].
- Expanded directory: ["host-files", hostId, path].
- Additional page: ["host-files", hostId, path, "page", cursor].

refreshDir(root) invalidates both the configured root key and resolved root path when they differ. refreshDir(other) invalidates that directory prefix, which also reaches its page keys. refreshAll invalidates ["host-files", hostId] (web/src/components/files/FileExplorer.tsx:206-236; web/src/components/files/FileExplorer.tsx:478-499).

**RECOMMEND:** Implement one pure event-to-effects reducer in mobile. It should return cache invalidations, local transport transitions, and notification intents. Transport code should execute effects; it should not contain ad hoc QueryClient calls.

**RECOMMEND:** On every valid alert, invalidate both ["sessions"] and ["session", session_id]. Preserve the web prefix invalidation for list parity, and add the singular key because native overlays are likely to render it directly.

## 6. Host control: security and connection policy

### 6.1 Effective permission layers

Host control has no user-facing per-operation ACL on the server. Its permission layers are:

1. WebSocket authentication and Host.user_id ownership check (server/spawn_server/ws/host.py:381-397).
2. Signed-host trust decision before the client connects (web/src/hooks/useHostControl.ts:13-100).
3. Exact RTC scope/protocol/binding verification (web/src/lib/hostControl.ts:986-1230).
4. Daemon-advertised capabilities; absent capabilities disable or reject operations (daemon/src/host_control.rs:2097-2146; web/src/lib/preview/capabilities.ts:50-85).
5. Home-rooted, no-follow filesystem resolution with traversal, symlink, and outside-root rejection (daemon/src/host_files.rs:1-5; daemon/src/host_files.rs:830-897).
6. Extra desktop-open policy, including per-request revalidation and executable/unsafe-type refusal (daemon/src/host_desktop.rs:166-224).
7. Bounded frames, queues, streams, directory pages, file sizes, ranges, and task concurrency (web/src/lib/hostControl.ts:7-42; daemon/src/host_control.rs:26-40; daemon/src/host_files.rs:29-40).

useHostControl reads ["host", hostId] at 30-second stale time, evaluates signed-host trust, creates only one client for the host, and closes it on unmount (web/src/hooks/useHostControl.ts:13-100).

The file browser gates controls from the exact client state and parsed capability list (web/src/components/files/FileExplorer.tsx:181-236). The displayed OS name only changes copy such as Finder versus file manager; it does not weaken the daemon check (web/src/hooks/useHostControl.ts:13-100).

The trust seed is established during host pairing, not by host control itself. ConnectHostSection polls ["hosts"] every three seconds to notice the first online host; this onboarding liveness is REST polling, not a WebSocket event (web/src/components/hosts/connect-host.tsx:63-88). Pairing:

1. Fetches the pending device by user code.
2. Recomputes and compares the host public-key fingerprint.
3. Loads any existing local pin.
4. Requires a registered local browser device identity.
5. Persists the exact host pin locally.
6. Signs an approval proof binding account, nonce, and host public key.
7. Verifies the approval response did not substitute either host or browser identity.
8. Invalidates ["hosts"] after approval.

The implementation is web/src/components/hosts/connect-host.tsx:183-289. Host control later consumes this local pin through resolveSignedRtcTrust; it must fail closed on pin-storage/refusal errors rather than silently using raw RTC (web/src/lib/hostControl.ts:1173-1196).

HostControlClient exposes hasCapability(operation), but its generic request and typed methods do not automatically reject an unadvertised operation; current callers/UI perform the gate, and the daemon remains authoritative (web/src/lib/hostControl.ts:348-419; web/src/lib/hostControl.ts:775-782; web/src/components/files/FileExplorer.tsx:181-236).

**RECOMMEND:** Native typed methods should fail locally with unsupported_operation when the current hello omits the capability, while still treating daemon rejection as authoritative. Keep the generic request method private.

### 6.2 GUARD_POLICY is not runtime authorization

docs/GUARD_POLICY.md says repository guards should check deterministic machine-readable surfaces and literals, not use prose as a security proof (docs/GUARD_POLICY.md:3-13). It also says removed complex guards should not be reintroduced without a narrow reason and calls out the completed tmux removal (docs/GUARD_POLICY.md:15-26).

Therefore:

- A source guard may assert that spawn.host.ctl, an operation name, or a limit remains present.
- A source guard does not grant permission.
- Runtime ownership, signed identity, capability negotiation, path containment, and daemon policy remain authoritative.
- Native must not infer safety from a UI control being hidden.

**RECOMMEND:** Port protocol conformance tests and runtime validation. Do not port a UI-only capability check as if it were authorization.

### 6.3 Host client lifecycle

HostControlClient state is idle | connecting | open | ready | closed | error (web/src/lib/hostControl.ts:164). It applies:

| Limit | Value | Source |
|---|---:|---|
| Connect deadline | 15 seconds | web/src/lib/hostControl.ts:13-18 |
| Default request timeout | 15 seconds | web/src/lib/hostControl.ts:13-18 |
| Preview request timeout | 35 seconds | web/src/lib/hostControl.ts:33-39 |
| Max client pending requests | 32 | web/src/lib/hostControl.ts:11-18 |
| Signaling reconnect | linear 500 ms × attempt, cap 10 seconds | web/src/lib/hostControl.ts:1686-1717 |
| Frame limit | 16 KiB | web/src/lib/hostControl.ts:11 |
| Chunk size | 8 KiB | web/src/lib/hostControl.ts:16 |
| Stream window | 8 chunks | web/src/lib/hostControl.ts:17 |
| Buffered high-water | 256 KiB | web/src/lib/hostControl.ts:18 |
| Stream timeout | 60 seconds | web/src/lib/hostControl.ts:19 |
| In-memory download fallback | 32 MiB | web/src/lib/hostControl.ts:20 |
| Incoming stream tombstones | 256 for 120 seconds | web/src/lib/hostControl.ts:21-22 |
| Max range request | 16 MiB | web/src/lib/hostControl.ts:40-41 |
| Client directory page | 96 entries | web/src/lib/hostControl.ts:42 |

The WebSocket reaches open before RTC/DataChannel readiness. The client becomes ready only after a valid hello/capability frame (web/src/lib/hostControl.ts:986-1230; web/src/lib/hostControl.ts:1232-1405).

The daemon hello advertises limits, but the current client only reads version, protocol, and capabilities; it continues using its compiled client limits (web/src/lib/hostControl.ts:1253-1282). This is safe where the client limit is no larger than the daemon contract, but the values are not dynamically negotiated.

Unlike the session hook, host peer-state handling reacts to failed and closed but does not provide a five-second disconnected grace. It has no visibility or online listener (web/src/lib/hostControl.ts:986-1230; web/src/lib/hostControl.ts:1686-1717).

**UNKNOWN:** HostControlClient does not visibly verify websocket.protocol after open, while useSessionSocket verifies spawn.v3. Resolve by adding a native conformance test against server selection and preferably applying the same explicit selected-protocol check to native host signaling. The web behaviors are in web/src/lib/hostControl.ts:986-1230 and web/src/components/terminal/useSessionSocket.ts:1245-1269.

### 6.4 Generic request semantics

request(operation, payload, options) requires ready state and fewer than 32 pending requests. It creates a random request ID, serializes the v1 envelope, and rejects a frame beyond 16 KiB. Abort before dispatch is AbortError. After dispatch it sends best-effort cancel (web/src/lib/hostControl.ts:348-419).

Five ordinary request operations have indeterminate side effects:

- fs.mkdir
- fs.rename
- fs.remove
- desktop.reveal
- desktop.open

They are declared in web/src/lib/hostControl.ts:23-32. A timeout or abort after dispatch becomes HostControlError("outcome_unknown"), because the daemon may have acted and only the acknowledgement was lost (web/src/lib/hostControl.ts:348-419; web/src/lib/hostControl.ts:1556-1630). fs.write uses a separate commit boundary and applies the same principle after commit (web/src/lib/hostControl.ts:846-957).

**RECOMMEND:** Never automatically retry an indeterminate request or committed write. Refresh the directory or state and ask the user to resolve ambiguity.

The daemon retains up to 4,096 seen request IDs and closes on duplicates or request-capacity violations rather than executing twice (daemon/src/host_control.rs:26-40; daemon/src/host_control.rs:404-412).

## 7. Host control command inventory

### 7.1 Wire operations

Every operation below is dispatched by the daemon switch in daemon/src/host_control.rs:458-653. The client method validation and return normalization live in web/src/lib/hostControl.ts:421-984.

| Client API | Wire operation and payload | Successful result | Capability | Current web affordance |
|---|---|---|---|---|
| ping() | ping, no payload | {pong:true} | ping | No normal production control; useful for diagnostics |
| home() | fs.home, no payload | {home_dir:string} | fs.home | File browser initial root; folder picker |
| listPage(path?,cursor?) | fs.list, {path?:string,cursor?:number} | HostDirList with path, home_dir, parent, entries, next_cursor, truncated | fs.list | File browser, folder picker, breadcrumbs, icon scan |
| mkdir(path) | fs.mkdir, {path:string} | {path?:string|null} | fs.mkdir | New Folder; folder picker create |
| rename(path,name,overwrite?) | fs.rename, {path,name,overwrite:boolean} | {path?:string|null} | fs.rename | Rename dialog/context menu |
| remove(path,recursive?) | fs.remove, {path,recursive:boolean} | {path?:string|null} | fs.remove | Delete confirmation/context menu |
| readFile(path) | fs.read, {path} | path, name, stream_id, length, sha256 | fs.read | Preview, download, source side of host transfer |
| readRange(path,offset,length) | fs.read.range, {path,offset,length} | stream declaration plus offset, file_size, version, content_type, open_allowed, eof | fs.read.range | Bounded preview/head reads |
| previewImage(path,maxPixels) | fs.preview, {path,max_pixels} | stream declaration plus mime, width, height, version | fs.preview | Host-rendered preview for formats browser cannot draw |
| stat(path) | fs.stat, {path} | HostFileStat | fs.stat | Supporting API; no prominent direct button |
| reveal(path) | desktop.reveal, {path} | {path?:string|null} | desktop.reveal | Reveal in Finder/file manager context item |
| openDefault(path) | desktop.open, {path} | {path?:string|null} | desktop.open | Open on host context item |
| metrics() | host.metrics, {} | {sample, spec?} | host.metrics | Exact capacity card/poll |
| writeStream(...) begin | fs.write.begin, {dir,name,length,sha256,overwrite?} | stream_id then committed path | fs.write.begin | Upload; destination side of transfer |

Method definitions and validation:

- ping and home: web/src/lib/hostControl.ts:421-427.
- listPage: web/src/lib/hostControl.ts:429-465.
- mkdir, rename, remove: web/src/lib/hostControl.ts:468-487.
- readFile: web/src/lib/hostControl.ts:556-571.
- readRange: web/src/lib/hostControl.ts:574-632.
- previewImage: web/src/lib/hostControl.ts:634-676.
- stat: web/src/lib/hostControl.ts:709-723.
- reveal and openDefault: web/src/lib/hostControl.ts:725-745.
- metrics: web/src/lib/hostControl.ts:747-773.
- writeStream: web/src/lib/hostControl.ts:846-957.

HostDirEntry is:

~~~ts
interface HostDirEntry {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink" | "other";
  is_dir: boolean;
  size?: number | null;
  modified_at?: number | null;
}
~~~

HostDirList adds path, home_dir, optional parent, entries, optional next_cursor, and optional truncated (web/src/lib/hostControl.ts:79-95).

HostFileStat is:

~~~ts
interface HostFileStat {
  path: string;
  name: string;
  kind: "file" | "directory" | "symlink" | "other";
  size?: number | null;
  modified_at?: number | null;
  content_type?: string | null;
  open_allowed?: boolean;
}
~~~

The source is web/src/lib/hostControl.ts:101-109.

readRange accepts only safe nonnegative offset and a length from 1 through 16 MiB. A short tail is legal. The result carries the requested slice offset, total file size, opaque version, content type, host open verdict, and eof flag (web/src/lib/hostControl.ts:574-632).

previewImage accepts max_pixels from an allowlist, never an arbitrary clamped integer: 128, 256, 512, or 1024. Its request timeout is 35 seconds so the daemon can return the renderer's real error (web/src/lib/hostControl.ts:33-42; web/src/lib/hostControl.ts:634-676).

desktop.open and desktop.reveal accept only a path. There is no application name, command, argument vector, environment, shell string, flag, or URL option (web/src/lib/hostControl.ts:725-745; daemon/src/host_desktop.rs:1-13).

On macOS the daemon invokes the absolute /usr/bin/open binary, applies a five-second launch timeout, and rate limits launches to a burst of three followed by one per 500 ms (daemon/src/host_desktop.rs:43-120). reveal may reveal a resolved path; openDefault rejects a directory, executable content, or a file whose magic/type is unsafe, and it rechecks on every request (daemon/src/host_desktop.rs:166-224). docs/TRUST.md explains these write-then-open defenses at docs/TRUST.md:235-254.

### 7.2 Client convenience operations

These are client orchestration, not additional daemon operation names:

| API | Composition | Important constraint | Source |
|---|---|---|---|
| readHead(path,knownSize?) | Whole read when known small; otherwise fs.read.range | Throws range_unsupported when bounded access is unavailable | web/src/lib/hostControl.ts:678-707 |
| downloadFile(path) | fs.read then collect into memory | Hard fallback ceiling 32 MiB; larger needs streaming download | web/src/lib/hostControl.ts:784-799 |
| saveFile(path) | Browser file picker streaming, else Blob/anchor | Browser-only sinks must be replaced with Expo FileSystem/Sharing APIs | web/src/lib/hostControl.ts:801-825 |
| uploadFile(dir,file,overwrite?) | Hash browser File then writeStream | Browser File is not a native file abstraction | web/src/lib/hostControl.ts:827-844 |
| writeStream(...) | begin, chunk, backpressure, end, commit | Exact length/hash; no retry after ambiguous commit | web/src/lib/hostControl.ts:846-957 |
| transferTo(source,destination,...) | read stream from source client into destination write stream | Cancels the source when destination fails | web/src/lib/hostControl.ts:959-984 |

**RECOMMEND:** Preserve the wire client and replace only byte-source/byte-sink adapters. Native uploads should stream from a URI/file handle and native downloads should stream to app storage; do not recreate the browser's 32-MiB Blob fallback.

### 7.3 UI trigger map

The host Files route is linked from the host page (web/src/app/hosts/[id]/page.tsx:303-308). Within FileExplorer:

- Header actions trigger New Folder, Upload, and Refresh (web/src/components/files/FileExplorer.tsx:969-1013).
- Row/context actions trigger preview, Reveal on Host, Open on Host, download, rename, send/transfer, and delete (web/src/components/files/FileExplorer.tsx:891-960).
- Mutation flows for upload, mkdir, rename, delete, transfer, and download are in web/src/components/files/FileExplorer.tsx:563-712.
- Preview loaders choose range, full read, or host-rendered preview in web/src/lib/preview/preview-loaders.ts:116-195.
- Capability-to-preview mapping is in web/src/lib/preview/capabilities.ts:14-20 and web/src/lib/preview/capabilities.ts:50-85.
- FolderPicker uses home, listPage, and mkdir (web/src/components/workspace/folder-picker.tsx:117-156; web/src/components/workspace/folder-picker.tsx:305-320).
- Workspace icon scan uses listPage/read APIs rather than a new wire operation (web/src/lib/workspace-icon-scan.ts:29-54; web/src/lib/workspace-icon-scan.ts:101-133).
- LegionHostCard polls exact metrics when expanded/looked at (web/src/components/legion/LegionHostCard.tsx:16-48; web/src/components/legion/LegionHostCard.tsx:72-121).

HostAgentsPanel is not host-control traffic. It uses REST/server-daemon relay for agent list, installation, and policy, polling ["host-agents", hostId] every 60 seconds with stale time 30 seconds (web/src/components/hosts/HostAgentsPanel.tsx:18-50).

### 7.4 Error taxonomy

The client always exposes application failures as HostControlError with code and optional detail (web/src/lib/hostControl.ts:44-51). The native client must branch on code, never parse English detail.

Client-originated or transport-originated codes/conditions:

| Code/condition | Meaning and mobile action | Source |
|---|---|---|
| not ready / connection closed Error | Request never dispatched; reconnect when foreground/online | web/src/lib/hostControl.ts:348-419 |
| too many pending requests Error | Client exceeded 32; apply UI backpressure | web/src/lib/hostControl.ts:348-419 |
| AbortError | Abort before dispatch or a determinate read cancelled | web/src/lib/hostControl.ts:348-419 |
| outcome_unknown | Side-effecting request or committed write may have succeeded | web/src/lib/hostControl.ts:23-32; web/src/lib/hostControl.ts:1556-1630 |
| range_unsupported | A bounded head read was requested but capability absent | web/src/lib/hostControl.ts:678-707 |
| streaming_download_required | File is larger than browser 32-MiB memory fallback | web/src/lib/hostControl.ts:784-799 |
| length_mismatch | Source produced a byte count different from declaration | web/src/lib/hostControl.ts:846-957 |
| protocol/sequence/hash failure | Peer sent malformed frame, wrong sequence, wrong length/hash, or unknown stream; fail RTC | web/src/lib/hostControl.ts:489-553; web/src/lib/hostControl.ts:1232-1405 |

Daemon filesystem/path codes:

| Code | Cause | Source |
|---|---|---|
| not_found | Missing component | daemon/src/host_files.rs:57-67 |
| permission_denied | OS denied access | daemon/src/host_files.rs:57-67 |
| already_exists | No-clobber target exists | daemon/src/host_files.rs:57-67 |
| invalid_path | Invalid/NUL/malformed path | daemon/src/host_files.rs:57-67; daemon/src/host_files.rs:830-897 |
| io_error | Other bounded I/O failure | daemon/src/host_files.rs:57-67 |
| outside_root | Resolution left held home root | daemon/src/host_files.rs:830-897 |
| traversal_rejected | Parent traversal was requested | daemon/src/host_files.rs:830-897 |
| symlink_rejected | Path component or target is a symlink where forbidden | daemon/src/host_files.rs:830-897 |
| not_directory | A required directory component is not a directory | daemon/src/host_files.rs:830-897 |
| root_protected | Rename/remove targeted the capability root | daemon/src/host_files.rs:1634-1699 |
| not_file | Operation requires an ordinary file | daemon/src/host_files.rs:1429-1442 |
| file_changed | Version/metadata changed during a bounded operation | daemon/src/host_files.rs:1429-1442 |
| atomic_no_clobber_unsupported | Platform cannot guarantee requested atomic no-clobber behavior | daemon/src/host_files.rs:2111-2121 |

Other daemon protocol/service codes include invalid_cursor, invalid_request, entry_too_large, too_many_tasks, too_many_streams, telemetry_disabled, unsupported_operation, stream_timeout, declaration_mismatch, invalid_hash, invalid_name, home_unavailable, cancelled, and preview-renderer-specific failures. The operation dispatch surface is daemon/src/host_control.rs:458-653; bounded control limits are daemon/src/host_control.rs:26-40; normalized cancelled/io_error/outcome_unknown helpers are daemon/src/host_files.rs:2141-2157.

Desktop launch adds launch_rate_limited and open_not_permitted (daemon/src/host_desktop.rs:148-224).

**UNKNOWN:** Error detail strings are intentionally not a stable enum, and some OS/preview errors vary by platform. The stable integration contract is code plus optional human detail. Resolve platform presentation by collecting daemon fixtures for macOS, Linux, and Windows; do not guess from detail text.

## 8. Alerts: generation, model, claiming, and presentation

### 8.1 Alert model

The client model is:

~~~ts
type AlertEventKind =
  | "agent.finished"
  | "agent.awaiting_input"
  | "session.died";

interface AlertEvent {
  event: AlertEventKind;
  session_id: string;
  command: string | null;
  exit_code?: number | null;
  signal?: string | null;
  at: string;
}

type AlertFrame =
  | ({ type: "alert" } & AlertEvent)
  | { type: "alerts.ping" };
~~~

The source declarations are web/src/lib/alerts.ts:17-34. parseAlertFrame also recognizes alerts.ping. For an alert it requires a supported event, nonempty session_id, and command that is absent/null or a string. exit_code and signal normalize to null when not valid. A missing/invalid at currently normalizes to the empty string rather than rejecting the event (web/src/lib/alerts.ts:43-68).

The event key is:

~~~text
event + ":" + session_id + ":" + at
~~~

It is constructed in web/src/lib/alerts.ts:71-78. It is suitable for a notification tag but is not a durable server ID.

Titles are event-specific. Bodies combine workspace, session, folder, command/agent identity, and exit details while avoiding duplicate labels (web/src/lib/alerts.ts:80-126; web/src/lib/alerts.ts:164-197).

### 8.2 What generates each alert

#### agent.finished

The server compares the previous and current disclosed foreground executable. It emits finished when:

- Session status is running.
- The previous foreground is non-null and not a shell.
- The current foreground becomes null or a recognized shell.

The transition and payload constructor are in server/spawn_server/ws/alerts.py:81-124 and server/spawn_server/ws/alerts.py:193-208. Foreground changes are processed in server/spawn_server/ws/daemon.py:1644-1722.

This means finished is a foreground transition, not proof that an arbitrary process succeeded. It cannot be reconstructed after missing the event.

#### agent.awaiting_input

QuietWatch holds at most one timer per session. Meaningful output cancels/replaces the timer. On expiry it fires once and does not rearm until fresh activity. User input and daemon-socket shutdown cancel it (server/spawn_server/ws/alerts.py:127-190).

Before publishing, the server re-reads the session and requires it still be running/non-shell, have output activity, have no newer user input, and have reached at least 90% of the quiet window (server/spawn_server/ws/daemon.py:677-716). The activity quiet window is eight seconds (server/spawn_server/routes/sessions.py:20-22).

#### session.died

On exit, status becomes killed when a signal is present and exited otherwise; the server stores exit fields, clears foreground, publishes session exit, and publishes one died alert (server/spawn_server/ws/daemon.py:1724-1817).

Alert publish is fenced to the current host owner. A delivery/backend failure is logged and does not terminate the daemon connection (server/spawn_server/ws/daemon.py:719-732).

### 8.3 Server filtering

Only objects with type alert, an allowlisted event, a nonempty session ID, and a command that is null or a string no longer than 64 characters are forwarded (server/spawn_server/ws/alerts.py:211-225). The alert server subscribes only after authentication and forwards current Redis publications; it has no client command surface (server/spawn_server/ws/alerts.py:228-298).

### 8.4 Claiming is not acknowledgement

claimAlert(eventKey) uses BroadcastChannel("spawn.alerts.claim"):

1. Each tab has a random tab ID.
2. Tabs announce a claim for the same event key.
3. They wait 60 ms.
4. Lexicographically lowest tab ID wins.
5. Claims expire after 30 seconds.
6. The local remembered set is bounded by TTL.

The complete algorithm is web/src/lib/alert-claim.ts:21-100.

This claim:

- Coordinates only browser tabs in one browser profile.
- Arbitrates sound, vibration, and system notification.
- Does not acknowledge anything to the server.
- Does not prevent every visible tab from showing its own in-app toast.
- Does not persist through process death.
- Falls back to true if BroadcastChannel fails.

Because the server has no alert ID/ack route and the client key includes a nonvalidated timestamp fallback, the current system has no durable exactly-once semantic (web/src/lib/alert-claim.ts:21-100; web/src/lib/alerts.ts:43-78; server/spawn_server/ws/alerts.py:288-298).

**RECOMMEND:** On native, use an in-memory plus persisted bounded event-key set only to reduce duplicates during rapid reconnects. Label it deduplication, not acknowledgement. It cannot recover missed events or prove server delivery.

### 8.5 Preference keys and defaults

Preferences are device-local and stored in localStorage key spawn.notify.prefs (web/src/lib/notify-prefs.ts:5-20).

| Key | Type | Default | Meaning |
|---|---|---:|---|
| toast | boolean | true | Show in-app toast while visible |
| sound | boolean | false | Play alert cue |
| system | boolean | false | Show OS/PWA notification while hidden |
| haptics | boolean | false | Vibrate/haptic cue |
| onFinished | boolean | true | Enable agent.finished events |
| onAwaiting | boolean | true | Enable agent.awaiting_input events |
| onDied | boolean | true | Enable session.died events |
| mutedSessions | string[] | [] | Suppress all alert delivery for listed session IDs |

Defaults and shape are web/src/lib/notify-prefs.ts:22-58. Invalid persisted values normalize to defaults. mutedSessions keeps only strings, deduplicates them, and retains at most the last 200 (web/src/lib/notify-prefs.ts:63-82). Storage failure returns defaults (web/src/lib/notify-prefs.ts:85-95). The module exposes external-store get/subscribe/set and mute helpers (web/src/lib/notify-prefs.ts:98-183). Event-to-toggle mapping is in web/src/lib/notify-prefs.ts:185-191.

**RECOMMEND:** Preserve these exact keys/defaults in a versioned native persistence object. Device-local behavior is intentional; do not put it in React Query or server account state.

For that small nonsecret object, **RECOMMEND:** use @react-native-async-storage/async-storage 2.2.0, the current Expo-SDK-recommended version bundled in Expo Go. The npm latest verified on 2026-08-22 is 3.1.1, but installing npm latest would not match the stock Expo Go native binary; use expo install resolution. The storage is explicitly unencrypted, which is acceptable for notification toggles and muted session IDs but not auth tokens: [Expo AsyncStorage documentation](https://docs.expo.dev/versions/latest/sdk/async-storage/).

### 8.6 Notification channels

The browser channel capability model distinguishes supported, permission, and iOS standalone-install requirements. iOS browser notifications are considered unavailable outside standalone mode (web/src/lib/notify-channels.ts:16-64).

Sound:

- Requires AudioContext to be armed from a user gesture (web/src/lib/notify-channels.ts:66-125).
- session.died uses 660 Hz then 440 Hz.
- agent.awaiting_input uses 780 Hz twice.
- agent.finished uses 660 Hz then 880 Hz.
- Notes use a triangular oscillator, about 0.11 seconds apart (web/src/lib/notify-channels.ts:127-165).

Haptic/vibration:

- session.died: [70, 60, 70] ms.
- agent.finished and agent.awaiting_input: [40, 60, 40] ms.

The patterns are in web/src/lib/notify-channels.ts:168-177.

Native channel packages verified on 2026-08-22:

| Package | Current version | Expo Go | Use |
|---|---:|---|---|
| expo-haptics | 57.0.1 | Yes | Semantic success/warning/error haptics |
| expo-audio | 57.0.4 | Yes | Play bundled two-note alert assets |

The versions were verified from the npm registry. Expo documents expo-haptics 57.0.1 and its system haptic APIs at [Expo Haptics](https://docs.expo.dev/versions/latest/sdk/haptics/). Expo explicitly lists expo-audio 57.0.4 as included in Expo Go at [Expo Audio](https://docs.expo.dev/versions/latest/sdk/audio/).

**RECOMMEND:** Use expo-haptics 57.0.1, mapping agent.finished to Success, agent.awaiting_input to Warning, and session.died to Error. iOS does not expose the browser's arbitrary millisecond vibration arrays through this API, so semantic native feedback is the Expo-Go-compatible equivalent.

**RECOMMEND:** Use expo-audio 57.0.4 with three tiny bundled assets pre-rendered from the existing frequency/envelope recipes. React Native has no browser AudioContext, and assets preserve the same audible identity without custom native code.

System notifications require explicit permission request. Delivery requires granted permission (web/src/lib/notify-channels.ts:181-239). The browser payload sets title/body, tag, URL data, silent, /icon-192.png, and /icon-192.png badge. It prefers serviceWorkerRegistration.showNotification and falls back to the Notification constructor. Click focuses an existing page or navigates to the URL (web/src/lib/notify-channels.ts:192-239; web/public/sw.js:75-105).

The service worker has notificationclick behavior but no push event listener (web/public/sw.js:1-105).

### 8.7 Per-session alert hook

AppShell mounts one useSessionAlerts instance on signed-in application routes (web/src/components/nav/AppShell.tsx:68-81). For every parsed event:

1. Read current notification preferences.
2. Return immediately if that event type is disabled or the session is muted.
3. If the event belongs to the visible session, invalidate sessions but suppress all channels.
4. Read exact ["sessions"], ["agents"], and ["workspaces"] cache values for labels.
5. Invalidate the ["sessions"] prefix.
6. If document is visible and toast enabled, show an in-app toast.
7. Claim cross-tab arbitration.
8. If claimed, play sound/haptics if enabled.
9. If hidden, claimed, and system enabled, show a system notification.

The implementation is web/src/hooks/useSessionAlerts.tsx:81-148. Label cache reads are in web/src/hooks/useSessionAlerts.tsx:103-107 and web/src/hooks/useSessionAlerts.tsx:186-188.

The toast/notification route is /w/WORKSPACE_ID?tab=TAB_ID&focus=SESSION_ID when workspace placement is known, otherwise /sessions/SESSION_ID. The web focus helper retries up to 40 times at 50-ms intervals after navigation (web/src/hooks/useSessionAlerts.tsx:59-79; web/src/hooks/useSessionAlerts.tsx:191-200).

### 8.8 What renders where

- Visible alerts render as clickable in-app toasts when toast is enabled (web/src/hooks/useSessionAlerts.tsx:118-125).
- Hidden alerts render as browser system notifications only when system permission/preference permits (web/src/hooks/useSessionAlerts.tsx:135-147).
- NotificationsPanel renders preferences, connection dot, permission/setup guidance, and a test alert. Its copy notes that closing all spawn tabs stops alerts (web/src/components/settings/NotificationsPanel.tsx:26-107; web/src/components/settings/NotificationsPanel.tsx:111-234).
- Sidebar warning dots/counts are not an alert inbox. They derive from session attention after query refresh (web/src/components/nav/SidebarWorkspaceRow.tsx:75-107; web/src/components/nav/SidebarWorkspaceRow.tsx:154-170).
- Workspace tab warning badges likewise derive from tab session attention (web/src/components/workspace/workspace-tabs.tsx:838; web/src/components/workspace/workspace-tabs.tsx:934-939).
- Status pills map activity/status to visual tones and pulse active state (web/src/components/ui/status.tsx:5-62).

There is no alert history list, unread counter, mark-read route, or alert badge store in this client/server path.

## 9. Presence, activity, and capacity

### 9.1 Session representation

The web Session type includes identifiers, command/cwd, status, exit_code, signal, timestamps, activity, and foreground metadata (web/src/lib/api.ts:234-256). The server response schema mirrors the disclosed activity/foreground fields (server/spawn_server/schemas.py:712-728).

The coarse session activity values are derived on REST serialization:

- starting when the session status is starting.
- exited or killed when terminal.
- quiet when running has no recent output and the startup quiet window has elapsed.
- active when meaningful output is at most three seconds old.
- input_sent when user input is newer than output.
- waiting when output is at least eight seconds old.
- quiet in the remaining gap/state.

The constants are active = 3 seconds and waiting = 8 seconds (server/spawn_server/routes/sessions.py:20-22). The exact derivation and last-activity maximum are server/spawn_server/routes/sessions.py:48-83.

The web maps:

- running + activity active to active tone.
- waiting, input_sent, or starting to waiting tone.
- quiet to idle.
- terminal statuses to dead.
- missing/offline to offline.

Attention exists only for exited/killed or waiting activity (web/src/lib/sessions.ts:56-91). Workspaces/tabs count that derived attention (web/src/lib/workspaces.ts:59-77).

### 9.2 Meaningful activity filtering

The daemon does not disclose terminal bytes to the server. It classifies activity locally and emits throttled timing/foreground events:

| Filter/window | Value | Source |
|---|---:|---|
| Output activity throttle | 2 seconds | daemon/src/activity.rs:1-23 |
| Input activity throttle | 1 second | daemon/src/activity.rs:1-23 |
| Echo suppression | 750 ms | daemon/src/activity.rs:1-23 |
| Redraw suppression | 1,500 ms | daemon/src/activity.rs:1-23 |
| Minimum meaningful printable output | 3 characters | daemon/src/activity.rs:1-23 |

Meaningful output excludes blank/terminal-control-only churn (daemon/src/activity.rs:214-226). Input classification distinguishes terminal reports and mouse protocol from likely user input (daemon/src/activity.rs:312-430).

The server stamps last_output_at for meaningful output, touches host presence, and touches the quiet watcher (server/spawn_server/ws/daemon.py:1552-1595). User input stamps last_input_at, touches the host, and cancels pending quiet alerts (server/spawn_server/ws/daemon.py:1596-1642).

### 9.3 Foreground disclosure

The foreground disclosure is a sanitized executable basename, maximum 64 characters. It contains no arguments, full path, environment, command output, or terminal bytes. Updates are rate limited and sent only when the basename changes (docs/TRUST.md:88-95; docs/TRUST.md:120-161).

The server sees account/host/session/workspace/agent records, presence timestamps, foreground basename, coarse activity timing, and WebRTC signaling, but not PTY content or host file bytes (docs/TRUST.md:88-95; docs/TRUST.md:120-161).

highlight-store is unrelated to remote presence: it is a local hover/highlight external store with no network I/O (web/src/lib/highlight-store.ts:5-41). diagnostics.ts performs endpoint-direct diagnostic requests; it is not a realtime feed (web/src/lib/diagnostics.ts:3-14).

### 9.4 Host online presence

The daemon heartbeat interval is 30 seconds (daemon/src/run.rs:37; daemon/src/run.rs:726-746). Heartbeats update host last_seen/capacity and receive acknowledgement (server/spawn_server/ws/daemon.py:466-507; server/spawn_server/ws/daemon.py:1482-1495). Releasing the daemon owner connection marks the host offline (server/spawn_server/ws/daemon.py:1970-2006).

REST host serialization hides the most recent bucket when the host is offline but retains static spec/capacity timestamp where appropriate (server/spawn_server/routes/hosts.py:60-89). Host web views poll the host record at 30 seconds (web/src/app/hosts/[id]/page.tsx:75-86).

### 9.5 Capacity has two disclosure levels

Server-visible capacity is coarse:

- CPU and memory buckets are integers 0 through 5.
- Static specification may include CPU/core/model, memory, and GPU metadata.
- Daemon sends bucketed telemetry roughly every 30 seconds.
- SPAWND_NO_TELEMETRY=1 disables spec, buckets, and exact capacity capability.

The trust disclosure is docs/TRUST.md:187-233. Server validation of optional spec and 0–5 buckets is server/spawn_server/host_capacity.py:1-18 and server/spawn_server/host_capacity.py:25-103. Host web type fields are in web/src/lib/api.ts:79-106.

Exact capacity is direct host control only:

~~~ts
interface HostCapacitySample {
  cpu_percent: number;
  memory_used_bytes: number;
  memory_total_bytes: number;
  load_one?: number | null;
  uptime_seconds: number;
}

interface HostCapacitySpec {
  cpu_cores: number;
  cpu_physical_cores?: number | null;
  cpu_model?: string | null;
  memory_bytes: number;
  gpu?: string | null;
}
~~~

The types are web/src/lib/hostControl.ts:54-77.

useHostCapacity polls host.metrics every one second only when enabled/looked at, allows four seconds per request, prevents overlapping requests, and retains the last successful sample through a later error. It does not write React Query (web/src/hooks/useHostCapacity.ts:8-104).

**RECOMMEND:** Stop exact-capacity polling immediately when a native screen is blurred, covered by an overlay, inactive, or backgrounded. On resume, request once immediately and then resume the one-second cadence only while visible.

## 10. Browser assumptions that fail under mobile backgrounding

### 10.1 Continuously foregrounded assumptions

| Current mechanism | Foreground-browser assumption | Mobile failure mode | Source |
|---|---|---|---|
| Alert reconnect setTimeout | JS timers continue close to schedule | Timers pause/coalesce during suspension | web/src/lib/alert-socket.ts:75-110 |
| Alert 80-s watchdog | Keepalive frames and watchdog execute | Suspended JS cannot receive/rearm/close promptly | web/src/lib/alert-socket.ts:113-127 |
| visibilitychange/online wake | DOM document/window exist | React Native has neither | web/src/lib/alert-socket.ts:140-161 |
| Alert singleton linger | Route remounts but page process persists | OS may kill process/state entirely | web/src/lib/alert-socket.ts:6-20; web/src/lib/alert-socket.ts:163-179 |
| Session WS reconnect timer | Hook remains scheduled | Background timer pauses; socket may look open but be dead | web/src/components/terminal/useSessionSocket.ts:1480-1509 |
| RTC connect/retry/grace timers | RTCPeerConnection can negotiate continuously | Lock/network handoff invalidates ICE/path while JS is suspended | web/src/components/terminal/useSessionSocket.ts:137-146; web/src/components/terminal/useSessionSocket.ts:997-1039 |
| RTC stats interval | Five-second polling remains useful | Wastes energy or pauses with stale displayed sample | web/src/components/terminal/useSessionSocket.ts:1512-1590 |
| Six warm terminals | Desktop can afford parked renderers/connections | Mobile radio, memory, and keyboard/renderer cost is high | web/src/components/terminal/LiveTerminalProvider.tsx:18-24; web/src/components/terminal/LiveTerminalProvider.tsx:59-130 |
| Host signaling reconnect | Mounted page remains continuously executable | Background leaves pending timers/requests ambiguous | web/src/lib/hostControl.ts:1686-1717 |
| Host request/stream timeouts | Timers reflect elapsed live processing | Suspension may fire all deadlines on resume | web/src/lib/hostControl.ts:348-419; web/src/lib/hostControl.ts:846-957 |
| Exact metrics 1-s poll | Card visibility equates to app visibility | Background polling burns energy or freezes stale | web/src/hooks/useHostCapacity.ts:8-104 |
| React Query default focus | Browser focus events drive refetch, if enabled | RN needs explicit focusManager wiring | web/src/lib/query.tsx:13-24 |
| Terminal sizing | DOM ResizeObserver, visualViewport, visibility refit and RAF exist | Native keyboard/layout APIs differ | web/src/components/terminal/Terminal.tsx:2338-2363 |
| Terminal diagnostics | document.visibilityState exists | No DOM visibility in RN | web/src/components/terminal/Terminal.tsx:2917-2929 |

WebRTC itself may survive some brief background transitions on some devices, but correctness must not depend on it. Mobile should regard backgrounding and network-interface changes as generation boundaries.

### 10.2 Required native lifecycle policy

#### App becomes inactive

inactive on iOS is a short transition for Control Center, notification shade, calls, and lock. The app should:

- Mark Query focus false.
- Pause exact capacity polling and UI-only refresh timers.
- Stop generating toast/haptic/sound intents.
- Do not start new host writes/mutations.
- Allow a very short transition without reconnect churn; if state proceeds to background, perform background policy.

#### App enters background or screen locks

Treat lock as background:

- Mark Query focus false.
- Close active session signaling WS, spawn.pty, spawn.ctl, and RTCPeerConnection as one generation.
- Close host signaling/RTC after rejecting determinate reads and marking dispatched indeterminate mutations outcome_unknown.
- Cancel exact capacity polling.
- Keep no more than a best-effort alert WS during the brief period JS remains scheduled; do not promise it remains alive.
- If an alert arrives while JS is still running and system notifications are enabled, schedule an immediate local notification.
- Persist preferences and bounded alert dedup keys, not transport objects.

The alert socket is the deliberate exception to “retire all background transports”: it may continue receiving while JS is executable, but it is marked background-best-effort and is always discarded/recreated on the next active transition. Session and host transports are retired immediately.

**RECOMMEND:** Mobile should keep zero warm terminal RTC connections in background and at most one active terminal connection in foreground. Reopen overlay terminal history from the normal 400-line bootstrap (web/src/components/terminal/useSessionSocket.ts:930-970).

#### Network becomes offline

- Set TanStack onlineManager false.
- Retire all WebSocket and RTC generations immediately.
- Reject not-yet-dispatched operations as offline.
- Preserve outcome_unknown for any dispatched indeterminate mutation/write commit.
- Suppress reconnect timers until online.

#### Network changes Wi-Fi to cellular or cellular to Wi-Fi

Even if isConnected never becomes false:

- Increment a process-local network epoch.
- Retire every current signaling socket, peer connection, DataChannel, and ICE candidate buffer.
- Start fresh connections only for alert stream, visible terminal, and visible host-control consumer.
- Never accept an answer/candidate from the prior binding generation.

This is stricter than waiting for RTCPeerConnection failed. It prevents a stale channel that appears open from black-holing input after path migration.

#### App returns active after seconds, minutes, or hours

Perform the same ordered sweep regardless of duration:

1. Re-read secure auth and current network state.
2. Set onlineManager from network reachability.
3. Retire any object whose app epoch or network epoch is stale.
4. Set focusManager true.
5. Reconnect owner alert stream.
6. Invalidate/refetch ["sessions"], ["workspaces"], ["hosts"], and ["agents"].
7. Also refetch the currently visible ["session", id], ["workspace", id], and ["host", id].
8. Reopen only the visible terminal, creating a new RTC ID/nonce/generation and bootstrapping 400 history lines.
9. Reopen host control only if the current screen needs Files/exact metrics.
10. Restart one-second metrics only when its card remains visible.

Current attention can recover from REST session status/activity. A missed finished transition cannot recover because alert WS has no replay.

### 10.3 TanStack Query, AppState, and network wiring

Verified package versions on 2026-08-22:

| Package | Verified current version | Expo Go | Role |
|---|---:|---|---|
| @tanstack/react-query | 5.101.4 | Yes, pure JS | cache/focus/online |
| @react-native-community/netinfo | 12.0.1 | Included in Expo Go | reactive connectivity/type |
| expo-network | 57.0.1 | Included in Expo Go | Expo alternative and direct network state |

Versions were checked against the npm registry. Expo's current NetInfo page lists 12.0.1 and says it is included in Expo Go: [NetInfo Expo documentation](https://docs.expo.dev/versions/latest/sdk/netinfo/). Expo's network page lists 57.0.1, Expo Go inclusion, getNetworkStateAsync, and addNetworkStateListener: [expo-network documentation](https://docs.expo.dev/versions/latest/sdk/network/). TanStack's React Native guide documents focusManager with AppState and onlineManager with NetInfo: [TanStack Query React Native guide](https://tanstack.com/query/latest/docs/framework/react/react-native).

**RECOMMEND:** Use @react-native-community/netinfo 12.0.1. It is Expo-Go-compatible and gives one reactive subscription with type plus isConnected/isInternetReachable, matching TanStack's documented RN integration. expo-network 57.0.1 is a valid simpler Expo-only fallback.

Minimal focus wiring:

~~~ts
import { AppState, type AppStateStatus } from "react-native";
import { focusManager } from "@tanstack/react-query";

let lastAppState: AppStateStatus = AppState.currentState;

export function installFocusBridge(onTransition: (
  previous: AppStateStatus,
  next: AppStateStatus,
) => void) {
  focusManager.setFocused(lastAppState === "active");
  return AppState.addEventListener("change", next => {
    const previous = lastAppState;
    lastAppState = next;
    focusManager.setFocused(next === "active");
    onTransition(previous, next);
  });
}
~~~

React Native defines active, background, and iOS inactive states and exposes change events: [React Native AppState](https://reactnative.dev/docs/appstate).

Minimal online and network-epoch wiring:

~~~ts
import NetInfo, { type NetInfoStateType } from
  "@react-native-community/netinfo";
import { onlineManager } from "@tanstack/react-query";

let lastType: NetInfoStateType | null = null;
let networkEpoch = 0;

export function installNetworkBridge(onEpoch: (epoch: number) => void) {
  return NetInfo.addEventListener(state => {
    const reachable =
      state.isConnected === true &&
      state.isInternetReachable !== false;
    onlineManager.setOnline(reachable);

    if (lastType !== null && state.type !== lastType) {
      networkEpoch += 1;
      onEpoch(networkEpoch);
    }
    lastType = state.type;
  });
}
~~~

Network type is a useful path-change signal, but not perfect: a Wi-Fi BSSID/path can change without type changing. Also increment the transport epoch after an offline-to-online edge and after any explicit RTCPeerConnection failed/closed event.

The lifecycle coordinator, not individual screens, should own these two subscriptions. Individual clients receive epochs and leases.

### 10.4 Query recovery set

On active/online recovery:

~~~ts
await Promise.all([
  queryClient.invalidateQueries({ queryKey: ["sessions"] }),
  queryClient.invalidateQueries({ queryKey: ["workspaces"] }),
  queryClient.invalidateQueries({ queryKey: ["hosts"] }),
  queryClient.invalidateQueries({ queryKey: ["agents"] }),
]);

if (visibleSessionId) {
  await queryClient.refetchQueries({
    queryKey: ["session", visibleSessionId],
    type: "active",
  });
}
~~~

Use invalidation for prefixes because the web application deliberately has filtered list keys (web/src/components/nav/Sidebar.tsx:59-80; web/src/app/hosts/[id]/page.tsx:75-86). Add visible singular keys because native overlays will hold entity-local screens.

**RECOMMEND:** Set refetchOnReconnect true and retry queries conservatively, but set mutation retries to zero for host control and all non-idempotent REST writes. Host-control ambiguity rules are stricter than ordinary HTTP query retry.

## 11. Push notifications and Expo Go

### 11.1 What the repository supports today

A repository-wide search of server/, web/, daemon/, proto/, and docs/ for APNs, FCM, web-push, PushSubscription, Expo push token, and device notification token found no server push implementation. The positive notification surfaces are:

- Authenticated live /ws/alerts (server/spawn_server/ws/alerts.py:228-305).
- Redis current-owner alert publications (server/spawn_server/ws/alerts.py:250-270).
- Browser Notification/service-worker display invoked by running page JavaScript (web/src/lib/notify-channels.ts:192-239).
- Service-worker notification click handling, with no push event handler (web/public/sw.js:1-105).

There is no device-token model/route, APNs provider, FCM sender, Expo Push Service integration, Web Push subscription endpoint, durable alert queue, or post-resume replay in the inspected implementation.

Therefore a backgrounded native app can receive a new alert only while its JS process and alert socket happen still to be executing. Once suspended or terminated, the server has no route to wake it.

### 11.2 expo-notifications current limitations

Verified current package version on 2026-08-22: expo-notifications 57.0.13. Expo lists the SDK-compatible install as approximately 57.0.13 and says local notifications remain available in Expo Go: [Expo Notifications API](https://docs.expo.dev/versions/latest/sdk/notifications/).

Current Expo documentation states:

- Remote push notification functionality is not available in Expo Go; a development build is required: [Expo development-build FAQ](https://docs.expo.dev/develop/development-builds/faq/).
- Expo's notifications guide separately calls out that remote push is unavailable in Expo Go on Android from SDK 53 and directs users to a development build; the broader development-build FAQ applies to remote push generally: [Expo notifications documentation](https://docs.expo.dev/versions/latest/sdk/notifications/).
- Local notifications can be scheduled from Expo Go with scheduleNotificationAsync and an in-process notification handler: [Expo local notification example](https://docs.expo.dev/versions/latest/sdk/notifications/).
- Receiving a notification response and deep-linking is supported through listeners in running native code: [Expo notification response handling](https://docs.expo.dev/versions/latest/sdk/notifications/).
- Headless background handling is tied to remote data notifications plus TaskManager/native configuration; it does not create an alert source without a push sender: [Expo background notification tasks](https://docs.expo.dev/versions/latest/sdk/notifications/).

What works in stock Expo Go:

- Ask for local-notification permission.
- Schedule an immediate or future local notification from executing JS.
- Receive foreground notification callbacks while JS is active.
- Receive/tap response routing for notifications already scheduled by the app.
- Use Expo-compatible local haptics separately.

What does not work:

- Register a production remote-push path that receives spawn alerts in Expo Go.
- Wake a suspended/terminated app for a newly generated server alert.
- Reliably maintain /ws/alerts through lock/background.
- Turn BackgroundTask into realtime WebSocket listening.

### 11.3 Minimal no-server-change notification design

**RECOMMEND:** Use expo-notifications 57.0.13 for local notification display only and preserve the exact preference gate from section 8.

At app start:

~~~ts
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});
~~~

Ask for permission only when the user enables system notifications. Do not prompt on first launch.

When an alert arrives:

~~~ts
async function deliverAlert(alert: AlertEvent, appState: AppStateStatus) {
  const prefs = await readNotifyPrefs();
  if (!eventEnabled(prefs, alert.event)) return;
  if (prefs.mutedSessions.includes(alert.session_id)) return;

  invalidateAlertQueries(alert.session_id);

  if (appState === "active") {
    showNativeToast(alert);
    maybeHapticAndSound(alert, prefs);
    return;
  }

  if (prefs.system && await claimAlertKey(alertKey(alert))) {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: alertTitle(alert),
        body: alertBody(alert),
        data: { route: routeForAlert(alert), eventKey: alertKey(alert) },
      },
      trigger: null,
    });
  }
}
~~~

This can show a local notification if the socket frame arrives during the short executable background window. It cannot schedule an event it has not received.

On notification response, route to the native workspace/tab/terminal overlay using stored IDs. Refetch the entity before opening because the notification can be old. If the session no longer exists, open its session detail/error state instead of retrying the terminal indefinitely.

Do not set a persistent OS badge from current alerts; the product has no read/ack count. If a badge is later introduced, it needs a defined server truth.

### 11.4 BackgroundTask is not a substitute

Verified current expo-background-task version: 57.0.12. It is included in Expo Go, but the OS chooses execution time; Android has a minimum 15-minute interval, iOS scheduling is discretionary, and killed apps do not reliably run it: [Expo BackgroundTask documentation](https://docs.expo.dev/versions/latest/sdk/background-task/).

**RECOMMEND:** Do not use BackgroundTask for alert delivery or WebSocket keepalive. At most use it for a future best-effort coarse REST refresh, and never claim realtime semantics.

## 12. Critical Expo Go transport conflict

The hard product constraint says the complete app, including live terminal, must run in stock Expo Go. The current spawn transport requires WebRTC DataChannels:

- Terminal bytes and viewport/history operations are mandatory spawn.pty/spawn.ctl DataChannel traffic (web/src/lib/ws.ts:1-8).
- WebSocket signaling carries only lifecycle and RTC negotiation (web/src/lib/ws.ts:4-13).
- Host file bytes, metrics, commands, and desktop actions use spawn.host.ctl DataChannel (web/src/lib/hostControl.ts:7-18; web/src/lib/hostControl.ts:348-984).
- Server browser WS rejects terminal/control payloads rather than relaying them (server/spawn_server/ws/browser.py:344-620).

Verified current react-native-webrtc version: 124.0.8. It supports DataChannels, but it contains native code and its own documentation says it is not available in Expo Go; Expo use requires a development client/config plugin: [react-native-webrtc repository](https://github.com/react-native-webrtc/react-native-webrtc). Expo Go can use only native modules already bundled in the Expo Go client.

Therefore there is no pure React Native/Expo-Go implementation of the required direct WebRTC DataChannels in the current architecture.

The three possible decisions are:

| Decision | Expo Go | Native quality | Server change | Consequence |
|---|---|---|---|---|
| Development build with react-native-webrtc 124.0.8 | No, violates stock Expo Go test | Native terminal/host control possible | None | Best production architecture, fails hard stated constraint |
| react-native-webview 13.16.1 terminal/control bridge | Yes; package is included in Expo Go | Terminal surface is a web wrapper | None if hosted web client reused | Satisfies transport and Expo Go, violates “not a web wrapper” for core surface |
| Add a server-relayed terminal/host-control transport | Potentially | Native JS socket client possible | Yes, material protocol/security/backend work | Explicitly outside this research and changes end-to-end privacy architecture |

The npm latest react-native-webview verified on 2026-08-22 is 14.0.1. Stock Expo Go currently bundles/recommends 13.16.1, so the Expo-Go fallback must use 13.16.1 via expo install rather than npm latest: [Expo WebView documentation](https://docs.expo.dev/versions/latest/sdk/webview/).

**DECISION REQUIRED:** The orchestrator/product owner must relax one of three constraints: stock Expo Go, native-not-wrapper live terminal/host control, or no server transport change. No implementation plan can honestly satisfy all three with the current wire architecture.

**RECOMMEND:** For an Expo-Go milestone without server changes, isolate the compromise to the live terminal/host-control transport surface using react-native-webview 13.16.1, while keeping navigation, overlays, workspace/tab lists, preferences, alerts, haptics, and lifecycle native. For the production first-class app, use a development build with react-native-webrtc 124.0.8. This is a product decision, not a hidden implementation fallback.

## 13. Native realtime module shape

### 13.1 Modules and responsibilities

~~~text
mobile/src/realtime/
  auth.ts
  urls.ts
  protocols.ts
  backoff.ts
  effects.ts
  coordinator.ts
  lifecycle.ts
  alert/
    types.ts
    parse.ts
    client.ts
    reducer.ts
    delivery.ts
    claim.ts
    preferences.ts
  session/
    signaling.ts
    binding.ts
    transport.ts
    lease.ts
  host/
    signaling.ts
    protocol.ts
    client.ts
    streams.ts
    errors.ts
    capacity.ts
  notifications/
    local.ts
    routes.ts
~~~

auth.ts

- Provides getAccessToken(): Promise<string | null>.
- Adds Authorization to REST and WebSocket construction.
- Emits an auth epoch so all transports close on logout/token replacement.
- Never logs query tokens, nonces, SDP, or signed envelopes.

urls.ts

- Provides sessionWsUrl(sessionId), hostWsUrl(hostId), alertsWsUrl().
- Converts https to wss and http to ws from one configured base.
- Percent-encodes IDs with URL/URLSearchParams.

protocols.ts

- Exports literal subprotocol constants spawn.alerts.v1, spawn.v3, spawn.host.v1.
- Exports RTC content tuples spawn.pty v2 and spawn.host.ctl v1.
- Contains no React or transport side effects.

backoff.ts

- Deterministic Backoff with injected random() and clock for tests.
- Alert policy: exponential jitter 0.7–1.3, base 1 second, cap 15 seconds.
- Session/host policy may preserve current linear 500-ms attempt/cap 10 seconds, but coordinator suppresses timers while offline/background.
- reset() on a fully usable state, not merely TCP open.

effects.ts

~~~ts
type RealtimeEffect =
  | { type: "query.invalidate"; key: readonly unknown[] }
  | { type: "query.refetch"; key: readonly unknown[] }
  | { type: "toast"; alert: AlertEvent }
  | { type: "localNotification"; alert: AlertEvent }
  | { type: "haptic"; pattern: AlertEventKind }
  | { type: "sound"; pattern: AlertEventKind }
  | { type: "transport.retire"; scope: string; reason: string };
~~~

coordinator.ts

~~~ts
interface RealtimeCoordinator {
  start(): void;
  stop(): void;
  getSnapshot(): RealtimeSnapshot;
  subscribe(listener: () => void): () => void;

  acquireSession(sessionId: string): SessionLease;
  acquireHost(hostId: string): HostLease;

  onAppState(state: "active" | "inactive" | "background"): void;
  onNetwork(state: NetworkSnapshot): void;
  onAuthEpoch(epoch: number): void;
}
~~~

The coordinator owns app, network, and auth epochs. Session/host leases capture all three when created; any mismatch makes later callbacks stale and harmless. The account alert client is explicitly allowed to process background frames while JS runs, reads the current AppState for delivery, and is force-replaced when the app becomes active.

lifecycle.ts

- Installs exactly one AppState listener.
- Installs exactly one NetInfo listener.
- Wires TanStack focusManager and onlineManager.
- Executes the ordered resume invalidation/reconnect sweep.

alert/types.ts and alert/parse.ts

- Preserve AlertEvent, AlertFrame, and the exact parser.
- Reject unsupported event/session/command shapes.
- Consider rejecting missing at in native instead of normalizing empty, or explicitly create a local receipt timestamp.

**UNKNOWN:** Web accepts missing/invalid at as empty string, weakening dedup. Exact parity means preserve it; robust native dedup means reject or replace it. Resolve with an R03/server contract decision before implementation (web/src/lib/alerts.ts:43-78).

alert/client.ts

~~~ts
interface AlertClient {
  connect(): void;
  close(reason: string): void;
  reset(): void;
  getSnapshot(): AlertConnectionSnapshot;
  subscribe(listener: () => void): () => void;
  onAlert(listener: (alert: AlertEvent) => void): () => void;
}
~~~

- Uses spawn.alerts.v1.
- Implements 80-second silence watchdog.
- Ignores alerts.ping after recording liveness.
- Exposes no send method because server has no commands.
- Treats every connect as a fresh non-replay subscription.

alert/reducer.ts

~~~ts
interface AlertContext {
  appState: "active" | "inactive" | "background";
  visibleSessionId: string | null;
  preferences: NotifyPreferences;
  claimed: boolean;
}

function reduceAlert(
  alert: AlertEvent,
  context: AlertContext,
): RealtimeEffect[];
~~~

The reducer carries all preference, mute, visible-session suppression, invalidation, and channel selection logic. It must be pure.

alert/preferences.ts

- @react-native-async-storage/async-storage 2.2.0-backed, versioned equivalent of spawn.notify.prefs.
- Exact eight keys/defaults from section 8.
- subscribe/getSnapshot/update/mute/unmute.
- Maximum 200 muted session IDs.

alert/claim.ts

- One-process in-memory arbitration.
- Optional AsyncStorage bounded dedup across quick restarts.
- TTL 30 seconds for parity.
- No claim of server acknowledgement.

alert/delivery.ts

- Maps reducer effects to native toast, expo-haptics, sound, and expo-notifications.
- Executes only after permission/preference checks.
- Notification response opens native overlay route and refetches entity.

session/binding.ts

~~~ts
interface RtcBindingIdentity {
  rtcSessionId: string;
  bindingNonce: string;
  bindingGeneration: number | null;
  sessionId: string;
}

function frameMatchesBinding(
  identity: RtcBindingIdentity,
  frame: RtcBindingFrame,
): boolean;
~~~

It must require session ID, nonce, positive safe generation, session scope ID, spawn.pty, and protocol version 2, matching web/src/lib/ws.ts:178-195.

session/signaling.ts

- Offers spawn.v3 and verifies selected subprotocol.
- Parses lifecycle and RTC config/answer/candidate/status.
- Sends only RTC offer/candidate/close.
- Enforces binding_nonce_required.
- Emits local session exit/status effects plus a singular/list query invalidation.

session/transport.ts

- Abstracts DataChannel implementation so the app can compile against a native-WebRTC development build or the explicitly chosen Expo-Go bridge.
- Exposes ptyBytes, controlFrames, ready, historyReady, metrics, and generation.
- Never falls back to signaling WS.

session/lease.ts

- Reference-counts one visible terminal transport.
- Retires immediately on background/network/auth epoch.
- Does not retain the web pool of six warm terminals by default.

host/protocol.ts

- Owns all v1 request/response/stream codecs.
- Validates 16-KiB frame maximum.
- Validates operation response shapes.
- Exports capability tokens and literal limits.

host/client.ts

~~~ts
interface HostControlClient {
  getSnapshot(): HostControlSnapshot;
  subscribe(listener: () => void): () => void;
  connect(): void;
  close(reason: string): void;

  ping(signal?: AbortSignal): Promise<{ pong: true }>;
  home(signal?: AbortSignal): Promise<{ home_dir: string }>;
  listPage(path?: string, cursor?: number, signal?: AbortSignal):
    Promise<HostDirList>;
  mkdir(path: string, signal?: AbortSignal): Promise<HostFileOp>;
  rename(path: string, name: string, overwrite?: boolean,
    signal?: AbortSignal): Promise<HostFileOp>;
  remove(path: string, recursive?: boolean,
    signal?: AbortSignal): Promise<HostFileOp>;
  stat(path: string, signal?: AbortSignal): Promise<HostFileStat>;
  readFile(path: string, signal?: AbortSignal): Promise<HostReadStream>;
  readRange(path: string, offset: number, length: number,
    signal?: AbortSignal): Promise<HostRangeStream>;
  previewImage(path: string, maxPixels: 128 | 256 | 512 | 1024,
    signal?: AbortSignal): Promise<HostPreviewStream>;
  reveal(path: string, signal?: AbortSignal): Promise<HostFileOp>;
  openDefault(path: string, signal?: AbortSignal): Promise<HostFileOp>;
  metrics(signal?: AbortSignal): Promise<HostMetrics>;
}
~~~

host/streams.ts

- Read stream state machine: declaration → ordered chunks → ack windows → end → hash/length verification.
- Write state machine: begin → ordered chunks/backpressure → end declaration → committed.
- Tracks stream tombstones.
- Maps app/network suspension at commit boundary to outcome_unknown.
- Uses native URI reader/writer adapters, not Blob.

host/errors.ts

- HostControlError(code, detail).
- isIndeterminateOperation(operation).
- presentationForCode(code), with generic fallback.
- Never inspects English detail for control flow.

host/capacity.ts

- One non-overlapping one-second poll while visible and ready.
- Four-second request deadline.
- Retains last successful sample with separate error/staleness fields.
- Stops on inactive/background/blur.

notifications/local.ts

- Owns expo-notifications handler and permission request.
- Has no remote token registration API until server support exists.
- Schedules only from received alert intents.

### 13.2 Suggested snapshots

~~~ts
interface AlertConnectionSnapshot {
  state: "idle" | "connecting" | "open" | "closed";
  lastFrameAt: number | null;
  reconnectAttempt: number;
  noReplay: true;
}

interface HostControlSnapshot {
  state: "idle" | "connecting" | "open" | "ready" | "closed" | "error";
  capabilities: ReadonlySet<string>;
  refusal: SignedRtcRefusalReason | null;
  appEpoch: number;
  networkEpoch: number;
}

interface RealtimeSnapshot {
  appState: "active" | "inactive" | "background";
  online: boolean;
  networkType: string;
  appEpoch: number;
  networkEpoch: number;
  alerts: AlertConnectionSnapshot;
}
~~~

Do not expose raw WebSocket/RTCPeerConnection objects through React context. Expose immutable snapshots and command methods so UI cannot bypass lifecycle policy.

## 14. Headless unit-test plan

All reducer, parser, lifecycle, request, and stream tests can run without React Native UI. Inject a fake clock, deterministic RNG, fake socket/channel, fake QueryClient effect executor, and in-memory preference store.

### 14.1 URL/auth/protocol tests

1. https REST base becomes wss; http becomes ws.
2. Session and host UUIDs are URL-encoded into the correct query keys.
3. Authorization bearer header is attached where supported.
4. Query-token fallback never appears in logs/snapshots.
5. Exact subprotocol offered for all three sockets.
6. Selected protocol mismatch closes session and host connections.
7. protocol.required is surfaced as incompatible-client, not generic offline.

### 14.2 Alert parser/reducer tests

1. Accept agent.finished, agent.awaiting_input, and session.died examples.
2. Reject unknown type/event, empty session ID, oversized/wrong-type command.
3. Pin the at empty-string parity decision.
4. Disabled event returns no effects and no invalidation, matching web.
5. Muted session returns no effects and no invalidation, matching web.
6. Visible current session returns sessions/singular invalidations but no delivery.
7. Active noncurrent session returns toast and optional claimed sound/haptic.
8. Background event returns local notification only when system is enabled and claimed.
9. session.died maps the distinct haptic/sound pattern.
10. Label construction deduplicates equal workspace/session/folder names.
11. Route construction prefers workspace/tab/focus and falls back to session detail.
12. Same event key is suppressed inside TTL and allowed after TTL.

### 14.3 Alert client timing tests

1. First subscriber connects; final unsubscribe begins 15-second linger.
2. Resubscribe within linger avoids disconnect.
3. 25-second ping rearms 80-second watchdog but emits no alert.
4. Silence at 80 seconds closes/reconnects.
5. Backoff bases are 1, 2, 4, 8, then 15 seconds, with injected 0.7–1.3 jitter.
6. Successful open resets attempt.
7. Malformed JSON and non-alert frames do not reach listeners.
8. One throwing listener does not block another.
9. Reconnect never sends a resume cursor.
10. Auth epoch closes immediately and clears listeners/state as specified.

### 14.4 Session binding and signaling tests

1. Accept only exact session_id, binding_nonce, positive safe binding_generation, scope, ID, protocol, and version.
2. Reject missing generation/nonce.
3. Reject candidate/answer from a retired network epoch.
4. Reject raw answer after signed mode is frozen.
5. enabled rtc.config without binding_nonce_required fails closed.
6. Binary frame on signaling socket fails protocol.
7. session.status emits local status plus cache effects.
8. session.exit emits local exit plus list/singular invalidation.
9. New network/app epoch sends best-effort rtc.close then disposes peer/channels.
10. New visible lease creates a fresh RTC session ID and nonce.

### 14.5 Lifecycle tests

1. active → inactive sets Query focus false but does not double-close.
2. inactive → background increments app epoch, retires session/host transports, and leaves only the explicitly background-eligible alert client.
3. background → active performs one ordered recovery sweep.
4. online → offline sets onlineManager false and retires transports.
5. Wi-Fi → cellular while connected increments network epoch.
6. offline → online increments network epoch and reconnects only leased scopes.
7. Duplicate AppState/NetInfo events are idempotent.
8. A callback from a stale epoch cannot update a current snapshot.
9. Resume after one minute and one day follow the same state machine.
10. Exact capacity does not poll while inactive/background/blurred.

### 14.6 Host request tests

1. Request before ready fails without dispatch.
2. The 33rd pending request is rejected.
3. Frame above 16 KiB is rejected locally.
4. Default timeout is 15 seconds; preview timeout is 35 seconds.
5. Abort before dispatch is AbortError.
6. Dispatched fs.mkdir/rename/remove/reveal/open timeout is outcome_unknown.
7. Determinate read timeout is ordinary timeout/cancel.
8. No indeterminate request is retried after reconnect.
9. Failed response preserves exact code/detail.
10. Unknown request ID, wrong version, wrong frame type, and malformed JSON fail the generation.
11. Capability absence disables command even if UI accidentally calls it.
12. Path/name/range/preview allowlist client validation matches exact limits.

### 14.7 Host stream tests

1. Ordered 8-KiB chunks succeed.
2. Duplicate, skipped, or negative sequence fails.
3. Window acknowledgement advances at the correct boundary.
4. End before declared length fails.
5. Extra bytes fail.
6. SHA-256 mismatch fails.
7. Cancel creates a tombstone and late expected chunks drain safely.
8. Tombstone expires at 120 seconds and store stays bounded at 256.
9. Stream idle timeout is 60 seconds.
10. Write waits for bufferedAmount below 256 KiB.
11. Source length mismatch fails before claiming success.
12. Disconnect before commit is a failed determinate write.
13. Disconnect after commit boundary is outcome_unknown.
14. Destination transfer failure cancels source.
15. Native file adapter streams without building a 32-MiB-plus in-memory buffer.

### 14.8 Presence/capacity tests

1. Activity boundary at three seconds is active.
2. Newer input becomes input_sent.
3. Output at eight seconds becomes waiting.
4. exited/killed always maps dead attention.
5. waiting and dead contribute workspace/tab attention; active/quiet do not.
6. Bucket validation accepts only integer 0–5 or null.
7. Exact metrics response validates 0–100 CPU and nonnegative memory/uptime.
8. Capacity poll never overlaps.
9. Failure retains last sample and marks it stale/error.
10. Missing host.metrics capability renders unavailable, not zero.

### 14.9 Local notification tests

1. Permission is requested only after explicit system-notification enable.
2. Active app uses toast and does not schedule local OS notification.
3. Background executing app schedules trigger:null exactly once per claimed key.
4. Muted/disabled alert never schedules.
5. Notification data contains only route IDs/event key, no terminal content.
6. Response tap refetches then routes to workspace/tab/terminal overlay.
7. Missing/deleted session has a safe detail fallback.
8. No code path requests a remote Expo push token.
9. Process suspension is represented as “cannot deliver”, not a successful queued alert.

## 15. Implementation decisions for the orchestrator

1. Resolve the Expo Go/WebRTC contradiction before assigning the terminal or host-control transport implementation.
2. Decide whether native preserves the web parser's empty timestamp behavior or tightens it.
3. Decide whether disabled/muted alerts should continue returning before cache invalidation for exact parity. This report recommends preserving delivery semantics but invalidating current state independently.
4. Confirm native should close all terminal/host RTC on background; this report recommends yes.
5. Confirm only one visible terminal is retained on mobile rather than the desktop pool of six; this report recommends one.
6. Keep server push explicitly out of scope unless requirements change. Nothing current can wake a suspended app.

The simplest correct native realtime core is an epoch-based lifecycle coordinator, one alert singleton, leased per-session/per-host transports, a pure event-effects reducer, and strict no-retry handling for ambiguous host mutations.
