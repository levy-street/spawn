# Web connection layer review (read-only)

Branch `native-daemon-fixes-auto-update-daemon`, 2026-08-25. Scope: `web/src/lib/ws.ts`,
`web/src/components/terminal/useSessionSocket.ts`, `web/src/lib/hostControl.ts`,
`web/src/lib/alert-socket.ts`, `web/src/lib/signed-rtc-live.ts`, the consumers in
`Terminal.tsx` / `LiveTerminalProvider.tsx` / `ConnectionChip.tsx` /
`ConnectingOverlay.tsx`, `web/public/sw.js`, `web/next.config.ts`, the e2e reconnect
specs, and — only as far as needed to judge the client — `server/spawn_server/ws/*.py`,
`turn.py`, `auth.py`, and `daemon/src/rtc.rs` constants. All paths below are relative
to the repo root. No file was edited, no build or test was run.

Architecture as read: one `WebSocket` per open/warm terminal to `/ws/browser`
(`spawn.v3`) carrying only `rtc.*` signalling and `session.*` lifecycle; two ordered,
reliable data channels (`spawn.pty`, `spawn.ctl`) to the daemon; one `/ws/host` +
`spawn.host.ctl` channel per host page/file explorer; one owner-wide `/ws/alerts`
singleton per tab. `rtc.config` (STUN + 24 h coturn REST credential,
`ice_transport_policy`) is sent once per WS connect. Offers are Ed25519-signed by the
browser device key when the host is pinned or claims a key; the answer is verified before
`setRemoteDescription`.

---

## (A) Findings, ordered by severity

### P1-1 — No dead-link detection or wake trigger on the session and host sockets; RTC recovery is chained to a WS that may be dead

**What the code does.**
- `useSessionSocket` never sends or expects any application-level keepalive, has no
  watchdog timer, and registers no `online` / `visibilitychange` / `pageshow` listener.
  The only listeners in `web/src` for `online` are in `alert-socket.ts:180`; the only
  `visibilitychange` in `Terminal.tsx:2375-2378` re-fits xterm and does nothing to the
  connection.
- The server sends nothing periodic on `/ws/browser` (`server/spawn_server/ws/browser.py`
  has no keepalive task; only `/ws/alerts` has one, `alerts.py:42,298-302`, 25 s). uvicorn's
  protocol-level pings (if the prod launch uses the default `websockets` impl) are invisible
  to page JavaScript, so they only help the *server* notice a dead peer.
- RTC retries are gated on the WS: `scheduleRtcRetry` returns unless
  `wsRef.current?.readyState === WebSocket.OPEN` (`useSessionSocket.ts:414`) and reuses
  `lastRtcIceServers` from the last `rtc.config` (`:415`). Nothing ever re-dials the WS
  because RTC keeps failing.
- `hostControl.ts` is the same: no watchdog, no wake listeners, `onconnectionstatechange`
  reacts only to `failed`/`closed` (`hostControl.ts:1165-1172`), and a request timeout
  (`:393-400`) rejects the caller but does not probe liveness or fail the channel.

**Field impact.** Laptop sleep on the same network (NAT mapping expires, IP unchanged):
after wake the browser still reports the WS as `OPEN`. ICE consent on the peer connection
fails after ~30 s → `disconnected` → 5 s grace → `cleanupRtc(true,true)` writes
`rtc.close` into the dead socket → 5 s later `startRtc` writes a fresh offer into the same
dead socket → `RTC_CONNECT_TIMEOUT_MS` (10 s) → retry at 10/20/40/60 s. The WS is only
discovered dead when the kernel gives up retransmitting (macOS ~1-2 min, Linux
`tcp_retries2` ≈ 15 min) or when a network *interface* change makes the write fail
promptly. Meanwhile the pane shows a stale screen with a 10 px "channel…" chip
(`Terminal.tsx:3345-3362`). Tab backgrounding on mobile Safari (socket killed while
suspended) has the same shape. The host control channel silently times out every request
for the same window.

**Proposed fix.**
1. Server: add a `{"type":"session.ping"}` (and host equivalent) every 25 s on
   `/ws/browser` and `/ws/host`, exactly like `alerts.ping`. Client: arm a watchdog at
   ~80 s (3 misses) in `connect()` (`useSessionSocket.ts:1269`) and in
   `HostControlClient.openWebSocket` (`hostControl.ts:999`); on expiry call `ws.close()`
   so `onclose` drives the existing reconnect path. Reset the watchdog on any inbound frame.
2. Client: register `visibilitychange` (visible), `online`, and `pageshow` (`persisted`)
   handlers in the effect (`useSessionSocket.ts:286`) and in the client's `connect()`
   (`hostControl.ts:307`). Handler: if `readyState !== OPEN` → clear the backoff and
   reconnect now; if `OPEN` but `rtcRef.current.pc?.connectionState` is not
   `connected` → close the WS (which re-dials, refreshes `rtc.config`, and restarts RTC);
   if everything is connected → send one ping and let the watchdog decide.
3. In `scheduleRtcRetry` (`:404`), after two consecutive RTC failures on the same WS,
   close the WS with `1000` instead of retrying on it: a fresh WS is the only thing that
   proves the signalling path is alive *and* re-mints TURN credentials (see P2-4).

### P1-2 — Reconnect backoff resets on `onopen` and close codes are ignored: `1008` and `4003` closes become a 2 Hz loop per pane, with nothing surfaced

**What the code does.**
- `ws.onopen` sets `attempt = 0` (`useSessionSocket.ts:1286`). `ws.onclose` does not look
  at `CloseEvent.code` (`:1496-1502`); every close → `scheduleReconnect` → delay
  `min(10 s, 500 ms × attempt)` (`:1505-1510`). The alerts socket has the same shape:
  `attempt = 0` on open (`alert-socket.ts:120`), no code inspection (`:153-161`).
- The server `accept()`s **before** authenticating (`ws/browser.py:195-196`,
  `ws/host.py:359-360`, `ws/alerts.py:262-263`), then closes with `1008` (`browser.py:157-176`)
  or, for a missing subprotocol, `4003` after `accept()` (`browser.py:189-193`,
  `alerts.py:256-260`). So from the client's point of view every rejection is
  *open → close*, which resets the ladder to 500 ms each time.
- `hostControl.ts` resets `reconnectAttempt` only on the daemon `hello`
  (`hostControl.ts:1306`), so it backs off correctly to 10 s — but also ignores the code
  (`:1123-1130`) and would retry a `1008` forever.
- `useAuth` (`web/src/lib/auth.ts:12-33`) only refetches `/api/me` on mount/focus/30 s
  staleness; a WS-only rejection never triggers it, and nothing else in `web/src` handles
  a 401 except `auth.ts:19`.

**Field impact.** The cookie is a days-long `kind=access` JWT (`auth.py:69-71,114-123`),
so this is not the common path — but it *is* the path after: "sign out everywhere" /
password change (epoch bump — see P1-3, which currently masks it), account deletion,
JWT secret rotation, cookie expiry with the tab left open, and any future server that
answers `4003`. Each warm terminal (`WARM_LIMIT = 10`, `LiveTerminalProvider.tsx:27`)
loops independently: up to ~20 TLS+WS handshakes/s from one tab, each doing a DB round
trip server-side, with the chip flickering "connecting"/"offline" and no way out but a
reload. The user is never told they are signed out.

**Proposed fix.**
- Do not reset `attempt` on `onopen`; reset it on the first application frame
  (`rtc.config` for session/host, first `alerts.ping`/`alert` for alerts) or after the
  socket has stayed open ≥ 5 s.
- Branch on `event.code` in all three `onclose` handlers:
  `1008` → stop reconnecting, set a new `SocketState` `"unauthorized"`, call
  `queryClient.invalidateQueries({queryKey:["me"]})` so the shell can redirect to
  sign-in; `4003` → stop, surface "SPAWN D needs a reload to keep talking to this server"
  (this is what the other stream wiring `protocol.required` needs from the client — today
  nothing consumes it and nothing else swallows it either, it is simply retried);
  `4002` → stop and report (client bug); `1000`/`1001`/`1006`/`1012`/`1013` → reconnect with
  backoff. Add jitter (see P2-6).
- Server (optional, but it removes the reset-on-open problem at the root): authenticate
  before `accept()` and reject with HTTP 403 for a bad cookie so the browser sees
  `onerror`+`onclose(1006)` without an `onopen`.

### P1-3 — (server, security) WebSocket auth ignores `session_epoch`, so a revoked session keeps signalling access until the JWT's days-long expiry

**What the code does.** `_resolve_user` (`ws/browser.py:145-178`, reused by
`ws/host.py:19,360` and `ws/alerts.py:31,263`) decodes the token, checks `kind`, `sub`
and that the user row exists — and returns. The HTTP dependencies compare
`payload["epoch"]` with `user.session_epoch` (`auth.py:167,222`); the WS path does not.
The cookie TTL is `jwt_refresh_ttl_days` (`auth.py:119`).

**Field impact.** After "sign out everywhere" (or whatever bumps `session_epoch`), a
copied cookie can no longer call `/api/*`, but can still open `/ws/browser` for any
session id, receive `rtc.config` with fresh TURN credentials, and negotiate a terminal
data channel — the daemon's signed-signalling pin is the only remaining gate, and an
unpinned host has none. Out of the web client's scope to fix, but it is the direct answer
to "auth expiry mid-session → what happens": today, nothing.

**Proposed fix.** In `_resolve_user`, after loading `user`, apply the same epoch check as
`auth.py:167` and close with `1008`. Consider also bumping-epoch → publishing a
"disconnect" on the user's alert channel so live sockets are cut, not just future ones.

### P1-4 — PTY input is sent as one SCTP message; a paste over ~64 KiB throws inside `sendBinary` and is lost

**What the code does.** xterm delivers a paste as a single `onData` string
(`Terminal.tsx:2708-2711` → `term.paste`; handler `:2735-2747`), which becomes one
`ptyDc.send(...)` in `sendBinary` (`useSessionSocket.ts:1617-1628`) with no chunking, no
`try`, and no `bufferedAmount` check. The daemon is webrtc-rs 0.17.1
(`daemon/Cargo.lock:3509-3510`); it does not emit `a=max-message-size` in its answer
(no writer for it in `webrtc-0.17.1/src/peer_connection/sdp/mod.rs`; only a parser at
`:1052`), and its own default is 64 KiB (`api/setting_engine/mod.rs:64,76`). Per RFC 8841
and Chromium's `RTCDataChannel.send`, an absent attribute means 65536, and a larger
message throws `TypeError: message too large`. The code base already knows this limit:
uploads are chunked at 48 KiB (`session-ctl.ts:11`) and control frames capped at 16 KiB
(`:2`). `flushPendingInput` (`:806-820`) silently `break`s on the same throw.

**Field impact.** Pasting a long log, diff or file into an agent prompt — a core gesture
of this product — silently sends nothing, and the exception escapes the xterm `onData`
callback, skipping the latency HUD/predictive-echo bookkeeping after `:2746`. Behaviour
may differ between Chrome and Firefox (open question C-5), which makes it worse, not
better.

**Proposed fix.** In `sendBinary`, slice into ≤ 16 KiB `ArrayBuffer`s and send them in
order on the same channel (SCTP preserves order on one stream; the PTY has no message
boundaries). Wrap `send` in `try` and, on throw, enqueue the remainder rather than
dropping it. Honour backpressure: if `ptyDc.bufferedAmount > 256 KiB`, set
`bufferedAmountLowThreshold` and continue on `bufferedamountlow` (the upload path already
does exactly this, `:578-602`). Same treatment in `flushPendingInput`.

### P2-1 — Signalling-plane drop tears down a healthy data plane on both ends (every server deploy renegotiates every terminal)

**What the code does.** `ws.onclose` → `cleanupRtc(false)` closes `ptyDc`, `ctlDc` and
the `RTCPeerConnection` (`useSessionSocket.ts:1496-1499`, `:341-401`). On the server,
browser detach publishes `rtc.close` for every binding to the daemon
(`ws/browser.py:661-680`), which closes its peer. `hostControl.ts:1128` does the same.

**Field impact.** `deploy-prod.sh` restarts the API (`scripts/deploy-prod.sh:485`); every
open and warm terminal (up to 10 per tab) drops its p2p channel, re-signals, replays 400
lines of history, and re-takes control, although the direct/relay path to the daemon was
fine. A flaky link to the *server* (mobile data) churns a stable p2p session for the same
reason. WebRTC only needs signalling for setup and ICE restart; the data channel does not
need the WS to stay up.

**Proposed fix (design change, both ends).** Keep the pc alive across WS reconnects when
`pc.connectionState === "connected"`: in `onclose` skip `cleanupRtc` if the channels are
open, reconnect the WS, and on `rtc.config` do not `startRtc` if a healthy pc exists.
Server: on browser detach, do not publish `rtc.close` immediately; give the browser a
grace window (e.g. 30 s) to re-attach with the same `session_id`+`binding_nonce` (the
broker already keys bindings on them) and only then retire. Daemon side already reaps a
peer that actually fails (`daemon/src/rtc.rs:1107-1200`). If that is too large a change,
at least make the client keep `dcOpen` true and *not* show "channel…" while the pc is
still connected, and reconnect the WS in the background.

### P2-2 — `RTCPeerConnection` is constructed outside the `try`, and `ice_servers` from the server are passed unvalidated: a bad config wedges the hook with no retry

**What the code does.** `new RTCPeerConnection({iceServers, iceTransportPolicy})` at
`useSessionSocket.ts:442-445` runs after `rtcStartInFlight = true` (`:422`) and before the
`try` at `:1175`; the `finally` at `:1264-1266` is never reached if the constructor throws,
so `rtcStartInFlight` stays `true` and every later `startRtc` returns at `:420` until the
WS is replaced. `hostControl.ts:1143` is the same relative to its `try` at `:1186`.
`msg.ice_servers ?? []` is forwarded as-is (`:1314`, `hostControl.ts:1055`). Browsers
throw `SyntaxError` for a non-`stun:`/`stuns:`/`turn:`/`turns:` URL and
`InvalidAccessError` for a `turn:` entry without credentials.

**Field impact.** A typo in `SPAWN_WEBRTC_ICE_SERVERS`/`TURN_URLS`, or a future server
adding a new URL scheme, produces a pane stuck on "Negotiating the encrypted terminal
channel" forever, with no log and no retry. Security-wise, the server can point the
browser's STUN/TURN traffic at any host (IP disclosure to a third party the server
chooses), which the operator already can do by design; validating schemes at least keeps
it inside ICE.

**Proposed fix.** Add `sanitizeIceServers(list)` in `ws.ts` that keeps only entries whose
`urls` all match `/^(stuns?|turns?):/i`, drops `turn(s)` entries lacking
`username`+`credential`, and caps the list; construct the pc inside the `try`; on a
constructor throw call `cleanupRtc(false, true, rtcGeneration)` so the retry ladder runs.

### P2-3 — `disconnected`/`failed` always rebuild the peer connection; `restartIce()` is never used and no ICE restart happens on network change

**What the code does.** `connectionstatechange` → `disconnected` starts a 5 s timer then
`cleanupRtc(true,true)`; `failed` → immediate `cleanupRtc(true,true)`
(`useSessionSocket.ts:1028-1050`). There is no `restartIce`, `iceRestart`, or
`setConfiguration` anywhere in `web/src`. Recovery is a brand new pc: new trust
resolution, new signing, new endorsement fetch (P2-5), new DTLS + SCTP handshakes, a new
`history` bootstrap (400 lines, `:952-957`), `history_subscribe`, and a `take_control`
round. Daemon grace is 15 s (`daemon/src/rtc.rs:82`) vs the browser's 5 s, so the daemon's
old peer lingers until the browser's `rtc.close` arrives.

**Field impact.** Wi‑Fi roam, VPN up/down, Wi‑Fi→Ethernet, or a mobile handover all
produce a full 10-20 s renegotiation with a history re-render, when an ICE restart on the
existing DTLS association typically recovers in 1-3 s and keeps the channels open. The
5 s `disconnected` grace is reasonable; the problem is what happens after it.

**Proposed fix.** On `disconnected` past the grace, and on `failed`: first refresh
`rtc.config` (server support needed: honour a client `{"type":"rtc.config.refresh"}` or
re-send on `rtc.status` `negotiating`), `pc.setConfiguration({iceServers})`, then
`pc.restartIce()` and re-run the offer path with `binding_generation` unchanged (the
daemon must accept a re-offer on the same binding — coordinate with the daemon review).
Only if the restart fails within ~10 s fall back to today's rebuild. Trigger the same
restart from the `online` handler in P1-1.

### P2-4 — TURN credentials are minted once per session WS and reused for every RTC retry; relay-only fallback is never attempted explicitly

**What the code does.** `rtc.config` is sent once per `/ws/browser` connect
(`ws/browser.py:217`) with a credential whose username encodes `expiry = now + 24 h`
(`turn.py:25-29`, `config.py:145`). The client stores it in `lastRtcIceServers`
(`useSessionSocket.ts:1314`) and every `scheduleRtcRetry` reuses it (`:415`). The host
socket mints per offer (`ws/host.py:513-517`) precisely because of this bug
(`ws/host.py:379-382` explains it) — the session socket did not get the same fix.
`iceTransportPolicy` is `"relay"` only when the deployment is relay-only or the debug
flag `window.__spawnRtcForceRelay` is set (`:439-445`); there is no "try `all`, then
`relay`" ladder.

**Field impact.** A tab left open > 24 h (uvicorn pings keep the WS alive) that then loses
its p2p path retries with expired TURN credentials: coturn answers 401, the relay
candidates never appear, and on a NAT that needs relay every retry fails until the WS
itself happens to drop. The missing explicit relay retry matters less than it sounds
(with TURN configured, `all` already includes relay candidates), except where a direct
pair *looks* viable but is asymmetric/lossy; there a relay-only attempt is the more
reliable second try.

**Proposed fix.** Parse the credential expiry from `username.split(":")[0]` and treat
`rtc.config` as stale 1 h before it; when stale, re-dial the WS (or use the refresh
message from P2-3) before `startRtc`. Add one explicit `iceTransportPolicy: "relay"`
attempt after two failed `all` attempts when the list contains a `turn(s):` entry, and
surface "connected via relay" (already available via `connInfo.kind`).

### P2-5 — Serial critical path to first byte; the uncached endorsement HTTP fetch sits inside the 10 s RTC timer

**What the code does.** Order for a fresh pane (`Terminal.tsx:1029-1087`,
`useSessionSocket.ts:1269-1293,1308-1317,1175-1261,940-981`):
1. `GET /api/sessions/{id}` → 2. `GET /api/hosts/{host_id}` (serial; gates `enabled`) →
3. WS TCP/TLS + upgrade → 4. server: auth DB read, session DB read, Redis subscribe,
`rtc.config` → 5. `rtcConnectTimer` starts (`:1007`) → `resolveTrust()` (two IndexedDB
databases, `browser-host-pins.ts:686+`, `browser-device-identity.ts:734+`) →
6. `createOffer`/`setLocalDescription` (gathering starts only now) → 7. Ed25519 sign +
self-verify (cheap) → 8. **`GET /api/trust/account-endorsements`** on every generation,
uncached (`Terminal.tsx:1069-1080`, `hooks/useHostControl.ts:58-69`) → 9. offer → Redis →
daemon → answer → Redis → browser → 10. trickle ICE (both sides trickle:
`useSessionSocket.ts:1022-1027`, `daemon/src/rtc.rs:1714`) → 11. DTLS (2 RTT) →
12. SCTP INIT (1 RTT) → 13. DCEP open ×2 → 14. daemon `ready` event → 15. `history`
request/replay → `markReady` → pending input flushed. Roughly 11-13 network round trips
serialised, three of which (2, 8, and the WS handshake) are HTTP-shaped and the rest
p2p-shaped.
`iceCandidatePoolSize` and `bundlePolicy` are left at defaults (`:442-445`).

**Field impact.** On a 150 ms mobile RTT, steps 1-9 alone are ~1.5-2 s before ICE begins;
on retries the endorsement fetch is repeated and eats into `RTC_CONNECT_TIMEOUT_MS`.
`Terminal.tsx:1353-1364` only admits "connecting direct channel…" after 1.5 s, and the
overlay's "slow" copy waits 8 s (`ConnectingOverlay.tsx:20`).

**Proposed fix.** (a) Cache endorsements in react-query (`staleTime` ≥ 5 min, prefetch
when `signalingIdentityKnown`) and pass the cached value; on cache miss send the offer
without `carried_endorsements` and let a pinned device be admitted as it is today.
(b) Start `resolveTrust()` as soon as the effect runs, in parallel with the WS handshake,
not after `rtc.config`. (c) Set `iceCandidatePoolSize: 1` so gathering (incl. the TURN
allocation) overlaps steps 5-8. (d) Cache the last `rtc.config` per tab (with its expiry,
P2-4) so a reconnect can construct the pc before the new WS is even open, and reconcile
if the fresh config differs. (e) Start the `rtcConnectTimer` after the offer is sent, and
give the bootstrap its own timer.

### P2-6 — Hook return values are unstable, so a `resize` control request is sent on every Terminal render and the xterm `onData` handler is re-subscribed every render

**What the code does.** `sendBinary`, `sendJson`, `uploadFile` and the returned object
are recreated on every render (`useSessionSocket.ts:1617,1630,1684,1695-1705`; only
`settleUploadReadiness` is memoised, `:248`). `Terminal.tsx:2781-2787` has
`[socket.state, socket.sendJson]` as deps, so it re-fires on every render while the pane
owns the display; the `connInfo` poll alone re-renders every 5 s (`:1540-1615`).
`Terminal.tsx:2728-2779` depends on `socket` and therefore disposes and re-attaches
`term.onData` on every render.

**Field impact.** A tracked `resize` request (`SessionCtlRequestTracker`, up to 128
outstanding, `:992`) crosses the ctl channel at least every 5 s per owned pane and on
every keystroke-driven render; the daemon answers each. Whether the daemon re-applies an
identical winsize (and what TUI apps do on a redundant SIGWINCH) is open question C-2.

**Proposed fix.** `useCallback` the three functions on `[sessionId]` (they read refs) and
`useMemo` the return object; in `Terminal.tsx` key the resize effect on
`socket.dcOpen` (not `state`) and remember the last sent size to skip duplicates.

### P2-7 — No jitter on the session and host reconnect ladders; retry never widens past 10 s

**What the code does.** Session: `min(10 s, 500 ms × attempt)` (`useSessionSocket.ts:1508`).
Host: `min(10 s, base × attempt)` (`hostControl.ts:1722-1726`). Alerts is the model:
exponential, 15 s cap, ×0.7-1.3 jitter (`alert-socket.ts:87-96`).

**Field impact.** After a server restart every warm terminal in every tab redials in
lockstep at exactly 0.5/1/1.5… s, each costing an auth + session DB read and a Redis
subscribe (`ws/browser.py:196-257`). Combine with P1-2's reset-on-open and a server that
is up but rejecting, and the herd never thins.

**Proposed fix.** Share one `backoffDelay(attempt)` helper from `alert-socket.ts` (or
`ws.ts`): `min(cap, base × 2^attempt) × (0.7 + 0.6 × random)`, cap 15-30 s.

### P2-8 — `rtc.status: unavailable` (host offline) backs off to 60 s and nothing shortens it when the host returns; `enabled:false` / `disabled` leave the pane silently stuck

**What the code does.** `unavailable`/`failed`/`collision` → `cleanupRtc(false, true)` →
retry 5/10/20/40/60 s (`useSessionSocket.ts:1480-1486`, `:404-417`). `session.status`
frames only call `onStatus` (`:1306-1307`); the server does publish
`session.status: running` when a daemon re-attaches (`ws/daemon.py:1581-1584`) but the
client does not use it to reset the ladder. `rtc.config` with `enabled:false` sets
`lastRtcIceServers = null` and nothing else (`:1318-1320`); `status: disabled` cleans up
with no retry and no state change (`:1485`). Neither reaches the UI: the chip shows
"channel…" and the overlay "Negotiating the encrypted terminal channel" indefinitely
(`ConnectionChip.tsx:98-104`, `ConnectingOverlay.tsx:48,93-102`).

**Field impact.** The overlay promises "This pane picks up on its own the moment the host
comes back" (`ConnectingOverlay.tsx:76`); reality is up to 60 s later. A deployment with
WebRTC disabled shows a permanent spinner with no words.

**Proposed fix.** On `session.status === "running"` (or any `rtc.status` that is not a
failure) with no live pc, clear `rtcRetryTimer`, reset `rtcRetryAttempts`, and
`startRtc` immediately. Add a `SocketState`/`ConnInfo` value for "transport disabled by
this server" and render it.

### P2-9 — Host control file streams are JSON+base64 with an app-level 8-chunk window; throughput is bounded by ~64 KiB per RTT and a 10 ms busy-poll drives backpressure

**What the code does.** Chunks are 8 KiB base64 in JSON text frames
(`hostControl.ts:16-18,941-944,1320-1356`), window `STREAM_WINDOW_CHUNKS = 8` with an
explicit `stream.ack` per chunk from the `ReadableStream` `pull` (`:546-551`), and
`waitForWritable` polls `bufferedAmount` every 10 ms instead of using
`bufferedamountlow` (`:1616-1636`). The daemon caps files at 512 MiB
(`proto/README.md:1066`).

**Field impact.** 64 KiB in flight per RTT ≈ 0.6 MB/s at 100 ms and 0.3 MB/s over a
200 ms relay; a 512 MiB file takes 15-30 min, plus ~33 % base64 overhead and a JSON parse
per 8 KiB. The 10 ms poll burns a timer per chunk on large uploads.

**Proposed fix.** Negotiate (via the `hello` capability list) binary chunk frames
(`ArrayBuffer` with a small header) and a window of 32-64 chunks or, better, drop the
app-level window and rely on SCTP flow control plus `bufferedAmountLowThreshold`
(64 KiB low / 256 KiB high), keeping the sha256 + sequence integrity checks unchanged.

### P2-10 — After the first paint, a dropped link is signalled only by a 10 px chip with raw enum text, and queued input is replayed silently

**What the code does.** The overlay only covers an unpainted pane
(`ConnectingOverlay.tsx:127-136`, `Terminal.tsx:3079-3080`). After paint, the status chip
prints `socket.state` verbatim — "closed", "error", "connecting" — joined with
"connecting direct channel…" (`Terminal.tsx:3354-3361`); `ConnectionChip` says "offline /
Control connection lost" (`ConnectionChip.tsx:92-93`). Keystrokes typed while
`!rtc.open` are queued up to 64 KiB (`useSessionSocket.ts:1627`, `:150`) and flushed on
`markReady` (`:841`), with no indication and no age limit; the queue is cleared only on
session-generation change (`:289`).

**Field impact.** The user sees a frozen terminal that looks alive; typing produces no
echo; a minute later, on reconnect, the accumulated keystrokes (possibly the same command
typed three times, or a `y` answered to a prompt that has since gone) are delivered to the
shell at once. Neither "stale" nor "your input is waiting" is ever said in words.

**Proposed fix.** After ~2 s of `!dcOpen` on a painted pane, show a one-line banner:
"Reconnecting to <host> — keystrokes will be sent once the channel is back (N queued)".
Expire queued input older than ~30 s, or replace replay-on-reconnect with a visible
"send queued input?" affordance. Map `SocketState` to copy in the chip rather than
printing the enum.

### P2-11 — Warm-pool terminals keep polling `getStats` and hold full transports while parked

**What the code does.** Up to `WARM_LIMIT = 10` terminals stay mounted and connected
(`LiveTerminalProvider.tsx:27,164-195`); each keeps its WS, its pc, and a 5 s `getStats`
poll (`useSessionSocket.ts:1610`) regardless of `active` or `document.hidden`.

**Field impact.** Ten WS + ten peer connections + ten periodic stats reports on a phone
browser; on reconnect storms (P1-2, P2-7) ×10. Mostly a battery/CPU cost, but it also
multiplies every other finding here.

**Proposed fix.** Pause the stats poll (and the scrollback refresh) when
`!active || document.hidden`; consider dropping the WS (keeping the pc) for parked
terminals once P2-1 lands, and lowering `WARM_LIMIT` on coarse-pointer devices.

### P3-1 — Signed-mode raw-answer window is closed only by nonce secrecy in the session hook

`hostControl.ts` latches `signedRtcRequired` before gathering (`:1206-1209`) so the raw
`rtc.answer` branch is unreachable for a signed generation. `useSessionSocket` has no
such latch: between deciding "signed" (`:1194-1211`) and `signedRtcSession =
nextSignedRtcSession` (`:1247`) a raw answer would be accepted by the `else if` at
`:1370-1417` *if* it matched the binding — which it cannot, because
`binding_generation` is only learned from `rtc.status negotiating` after the offer
(carrying the nonce) is sent (`:1256`). Sound, but implicit. Mirror the explicit latch
for defence in depth.

### P3-2 — `pageshow`/bfcache is unhandled on the session hook; alerts only disarms its watchdog

`alert-socket.ts:181-184` clears the watchdog on `pagehide`; nothing handles `pageshow`
with `persisted`. Browsers generally exclude pages with open WebSockets from bfcache, so
this is rarely hit; fold into the P1-1 wake handler.

### P3-3 — Chip and overlay copy

`Terminal.tsx:3355` prints the `SocketState` enum; `ConnectionChip` labels `stun` as
"p2p" (`ConnectionChip.tsx:72-76`) — "direct" and "p2p" are both peer-to-peer; consider
"direct (LAN)" / "direct (NAT)" / "relay". Relay is already surfaced (warning dot), which
is good.

### P3-4 — Test coverage of the connection layer

`useSessionSocket.test.ts` covers only `newRtcBindingNonce`. The e2e suite exercises one
`1001` close followed by a clean reconnect (`tests/e2e/terminal.spec.ts:84-88,1127-1133`,
`terminal-usability.audit.spec.ts:423-430`). No test covers backoff, close codes, the
RTC retry ladder, `disconnected` handling, or input queueing. Any fix above should land
with a jsdom/bun test that drives a fake `WebSocket`/`RTCPeerConnection` through these
transitions.

---

## (B) What is already good — do not regress

- **Signed signalling is fail-closed and the raw fallback is structurally unreachable in
  signed mode.** `SignedRtcLiveSession.verifyAndApplyAnswer` never reads `frame.sdp`
  (`signed-rtc-live.ts:172-220`), seals the generation and closes the pc on any failure;
  `refuse` sets a terminal state with no auto-retry (`useSessionSocket.ts:1194-1203`,
  `hostControl.ts:1197-1204`, `:1718`) and the copy names the safe next step
  (`signed-rtc-trust.ts:44-67`, `ConnectionChip.tsx:227-243`). A resolver *throw* also
  refuses (`:1188-1191`). Trust is resolved before `createOffer` so ICE gathering is not
  delayed by IndexedDB (`:1176-1181`).
- **Binding identity is strict.** `rtcBindingFrameMatches` checks session id, nonce,
  generation, scope tuple and protocol version (`ws.ts:181-198`); the nonce comes from a
  CSPRNG or the socket is closed (`:162-179`, `:427-435`); local candidates are buffered
  until the offer is on the wire so the session is never disclosed early
  (`:1022-1027,1261`, `hostControl.ts:1149-1164,1254-1257`).
- **Subprotocol and framing discipline on the client.** `ws.protocol` is checked on open
  and a wrong selection closes `1002` (`:1287-1290`); binary frames on the signalling
  socket close `1002` (`:1489`); unparseable frames in signed mode tear the RTC
  generation down (`:1300-1302`). `rtc.config` without `binding_nonce_required` is refused
  (`:1310-1313`). `ice_transport_policy` is coerced to exactly `"relay"` or `"all"`
  (`:1315`).
- **Generation guards everywhere.** Session, WS, and RTC generations are checked at every
  async boundary (`isCurrentRtcGeneration`, `isCurrentWs`, `latest.*` comparisons at
  `:1352-1363`), so late answers/candidates/uploads cannot land on a newer pc. Every old
  pc and channel is closed in `cleanupRtc` (`:379-389`; `hostControl.ts:1689-1700`), and
  `rtc.close` is signalled to the daemon (`:354-361`). React strict-mode double effects
  and fast session switches are handled by the generation counter (`:286-301,1514-1534`).
- **Data channel setup.** Ordered, fully reliable, `binaryType = "arraybuffer"`
  (`:449-451,788-789`); `OrderedAsyncQueue` keeps Blob/ArrayBuffer decoding in order
  (`:1080-1091`); PTY bytes received before the history bootstrap are held (12 MiB cap)
  and re-anchored so nothing is duplicated or dropped (`:1064-1079,876-895`); snapshots are
  released in PTY-offset order (`:861-874`). Upload chunks respect
  `bufferedAmountLowThreshold` with a stall timeout (`:578-602`) and are sized under the
  SCTP limit (`session-ctl.ts:11`).
- **Transient `disconnected` gets a grace period** (5 s, `:1034-1046`) rather than an
  immediate teardown; `failed`/`closed` are distinguished (`:1047-1049`).
- **Path classification and RTT are measured, not guessed** (`:1540-1615`) and relay is
  visibly flagged (`ConnectionChip.tsx:106-111`).
- **The alerts socket is the reference implementation**: watchdog on the server's 25 s
  ping (`alert-socket.ts:35-38,72-85`), jittered exponential backoff (`:87-96`),
  `visibilitychange`/`online` wake (`:164-185`), singleton across route changes with a
  linger (`:11-26,187-204`), and it is closed *before* logout so it cannot loop on `1008`
  (`auth.ts:56-60`).
- **Host control integrity**: sha256 + strict sequence window + tombstones on cancelled
  streams (`hostControl.ts:1320-1386,1509-1585`), `outcome_unknown` for mutations whose
  ack was lost (`:23-32,1647-1661`), capability parsing before `ready` (`:1304-1313`), and
  TURN credentials minted per offer on `/ws/host` (`ws/host.py:379-382,513-517`).
- **Service worker and proxy**: `sw.js:44` never touches `/api/*` or `/ws/*`;
  `next.config.ts:60-66` rewrites are the only place the API origin is named, so the app
  stays single-origin.
- No SDP, candidate, or credential is written to the console anywhere in these files.

---

## (C) Open questions

1. **Production WS topology and idle timeouts.** The repo has only
   `infra/nginx-admin.conf.example`; the systemd unit and the real nginx site are not
   checked in. Confirm which process terminates `/ws/*` in prod (nginx → `next start`
   rewrite → uvicorn?), that `next start` proxies the `Upgrade` for the `/ws/:path*`
   rewrite, the uvicorn `--ws` implementation and its `ws_ping_interval`/`ws_ping_timeout`
   (`websockets`/`websockets-sansio` default 20 s/20 s; `wsproto` sends no pings), and
   nginx `proxy_read_timeout` on the WS location (default 60 s; fine only if upstream
   pings are on).
2. **Does the daemon dedupe a same-size `resize`** (P2-6)? If it re-applies `TIOCSWINSZ`
   or redraws, the render-driven resize spam is user-visible in TUI apps.
3. **LAN direct path with mDNS disabled on the daemon** (`daemon/src/rtc.rs:667,903`):
   Chrome obfuscates host candidates as mDNS names; the daemon will ignore them as remote
   candidates, so a same-LAN pair must succeed via the daemon's real host candidate and a
   browser-side prflx. Worth verifying on a home network that `connInfo.kind` reports
   `direct` rather than `stun`/`relay`.
4. **Daemon re-offer on the same binding** — needed for P2-3's `restartIce` path. Does the
   daemon accept a second `rtc.offer` carrying the same `session_id`+`binding_nonce` with
   `a=ice-options` restart, or only a new binding?
5. **Browser max message size when the answer omits `a=max-message-size`** (P1-4).
   Chromium throws above 65536; Firefox may accept larger with EOR. Confirm on both;
   chunking at ≤16 KiB is correct either way.
6. **Is `session.status: running` on daemon re-attach delivered to already-open browser
   sockets** (`ws/daemon.py:1581-1584` suggests yes)? If so P2-8 is a client-only change.
7. **Should a parked (warm, unclaimed) terminal keep its WS at all** once P2-1 lets the
   data plane outlive the signalling plane?
