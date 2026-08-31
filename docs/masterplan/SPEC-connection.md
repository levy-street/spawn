# SPEC: connection speed, reliability, and security — browser, phone, daemon, server

Repo /Users/charliesaxton/dev/spawn, branch native-daemon-fixes-auto-update-daemon.
Companion to SPEC-versioning.md (already implemented in the same branch; the
`protocol.required`/4003 handling, `/api/release`, and daemon self-update exist —
build on them, do not duplicate them). The four review reports that ground this
spec are in scratchpad/reports/REVIEW-{daemon,web,mobile,server}.md — read the
one for your folder in full; every item below cites its finding id.

Production facts (verified 2026-08-25 on the box): one uvicorn worker, no
`--ws-ping-*` flags (defaults 20 s/20 s), nginx `proxy_read_timeout 60s` on `/`,
coturn on `turn:98.83.222.112:3478?transport=udp|tcp` (no `turns:`, no TLS
listener), STUN = Google, uvicorn access log on.

## Cross-cutting protocol additions (exact)

All additive. Subprotocol names stay `spawn.v3` / `spawn.control.v3` /
`spawn.host.v1` / `spawn.alerts.v1`; old clients ignore unknown frames.

### Keepalive (server → browser/host sockets)

`{"type":"ping","ts":<unix ms>}` every 25 s on `/ws/browser` and `/ws/host`
(alerts keeps `alerts.ping`). Clients may reply `{"type":"pong","ts":<same>}`
(optional; server ignores). Clients arm an 80 s watchdog (3 misses) on any
inbound frame and close the socket (code 4008 "keepalive timeout") when it
fires so the ordinary reconnect path runs.

### Fresh ICE configuration mid-socket

- Server re-sends `rtc.config` on `/ws/browser` and `/ws/host` every
  `min(turn_ttl_seconds/2, 3600)` s and on request:
  `{"type":"rtc.config.request"}` → one `rtc.config` reply (rate: 1 per 5 s per socket).
- Clients keep the latest `rtc.config`; before constructing a PeerConnection or
  restarting ICE they use the latest, and if the TURN credential expiry
  (`username.split(":")[0]`, unix seconds) is within 1 h, they send
  `rtc.config.request` first and wait ≤ 2 s for the reply.

### Signalling-plane loss without data-plane loss

Register (daemon → server) gains `keeps_peers_across_reconnect: true` and
`live_bindings: [{"session_id":"<rtc signal id>","binding_nonce":"…",
"binding_generation":<int>,"scope_type":"session|host","scope_id":"<uuid>",
"protocol":"spawn.pty|spawn.host.ctl","protocol_version":<int>}]`
(every peer the daemon still has open). Server:

- When a daemon socket ends WITHOUT a supersession by a newer generation and the
  daemon had `keeps_peers_across_reconnect`, its RTC bindings are kept for
  `RTC_BINDING_ORPHAN_GRACE_SECONDS = 60` in an "orphaned" state instead of being
  revoked; browsers bound to them get `{"type":"rtc.status","status":"signalling_lost", …tuple…}`
  (informational; they keep their channels).
- When the same host re-registers within the grace, bindings whose identity
  appears in `live_bindings` are rebound to the new DaemonConn (same nonce and
  generation) and browsers get `rtc.status rebound`; bindings absent from
  `live_bindings` are revoked (`unavailable`) as today; `live_bindings` entries
  the server does not know are answered with `rtc.close` to the daemon.
- When a browser socket ends, its bindings are orphaned for the same grace
  instead of `rtc.close` being published; a new browser socket for the same
  user and PTY session may send
  `{"type":"rtc.resume","session_id":…,"binding_nonce":…,"binding_generation":…,"scope_type":…,"scope_id":…,"protocol":…,"protocol_version":…}`
  and the server re-associates the binding (reply `rtc.status resumed`) or
  answers `rtc.status unavailable` if it is gone. Grace expiry publishes
  `rtc.close` to the daemon exactly as detach does today.
- Old daemons (no flag) keep today's immediate revoke; old browsers never send
  `rtc.resume` and keep working.

### ICE restart on an existing binding

- Browser/phone: on `connectionstatechange` `disconnected` after a 5 s grace, on
  `failed`, and on a network-change/online/foreground wake while not
  `connected`: refresh config if stale, `pc.setConfiguration({iceServers,
  iceTransportPolicy})`, `pc.restartIce()`, `createOffer()`, sign it exactly like
  the first offer (same `binding_nonce`, same `binding_generation`) and send
  `rtc.offer` with `"ice_restart": true`. If not `connected` within 10 s of the
  restart offer, fall back to today's full rebuild (new signal id).
- Server (`register_rtc_session` / browser offer path): an `rtc.offer` with
  `ice_restart: true` from the same route for a live binding is accepted and
  forwarded with fresh `ice_servers` (no new binding, no new generation); a
  restart for an unknown binding is answered `rtc.status unavailable`.
- Daemon: an `rtc.offer` whose signal id already exists with the same
  generation, whose signed envelope verifies against the same pinned key as the
  original, and whose ICE ufrag differs from the current remote ufrag, is
  applied to the existing PeerConnection (`set_remote_description` →
  `create_answer` → `set_local_description`), answered and signed as usual; any
  other same-id offer is still rejected as a collision. Check
  `signed_signal.rs` for nonce/replay rules and keep them sound: a replayed
  older restart offer must be rejected or be a no-op, never regress state.

### Output backlog shedding (daemon → browser/phone)

New `spawn.ctl` event `{"type":"pty_gap","offset":<new pty offset>}` sent when
the daemon drops backlog for a slow viewer. Clients handle it like `history_gap`:
discard pending anchored bytes and request a fresh snapshot/history from
`offset`. (Web and mobile already implement the `history_gap` path; reuse it.)

### Close codes (all sockets)

1000/1001/1006/1012/1013 → reconnect with jittered backoff. 1008 → stop; web
invalidates `["me"]` and shows the signed-out state; mobile emits
`unauthenticated`; daemon treats a 1008 on the control socket as credentials
refused (log once, backoff cap). 4000 superseded → daemon reconnects; after two
consecutive supersessions within 60 s it goes straight to the 60 s cap and logs
once at error ("another daemon instance is using these credentials"). 4002 →
stop and report a client bug. 4003 → the versioning stream's client-stale path
(already wired). 4008 keepalive → reconnect. New server code 4010 "subscription
lost" (Redis pub/sub pump ended) → reconnect immediately.

## Server (server/) — owner S2

Findings: REVIEW-server #2 #3 #5 #7 #8(part) #9 #11 #12 #13 #15 #16 #18 #21 #22 #23; REVIEW-web P1-3; REVIEW-mobile P1-4 (server half).

1. `_resolve_user` (ws/browser.py, shared by host/alerts): enforce `session_epoch`
   exactly like `auth.py` HTTP deps; close 1008 (web P1-3). Add a test.
2. Keepalive task on `/ws/browser` and `/ws/host` (25 s `ping`); ignore client `pong`.
3. `rtc.config` refresh: periodic re-send + `rtc.config.request` handler on both sockets.
4. Redis pump termination → close the socket with 4010 (browser, alerts) and the
   daemon socket with 4010 (not 4000 "superseded"); distinct codes per #16:
   4000 real supersession, 4004 fencing/consistency failure, 4010 subscription lost.
5. Orphan grace + rebind + `rtc.resume` + `live_bindings` reconcile (section above).
   Bindings keep their nonce/generation; browsers get `signalling_lost`/`rebound`/`resumed`.
6. ICE restart acceptance (`ice_restart: true`) with fresh ICE servers.
7. `/ws/host`: `protocol.required` + 4003 like the other three (#11). Unknown /
   invalid frame → `{"type":"error","code":"unknown_frame"|"invalid_frame","frame_type":…}`
   rate-limited 1/s per socket (#12).
8. Host status derivation (#13): `online` iff `status == "online"` and
   `last_seen_at >= now − 90 s`, in `_to_out` and wherever sessions expose host status.
9. ICE config validation at startup (#9): parse every STUN/TURN URL
   (`^(stun|stuns|turn|turns):host(:port)?(\?transport=(udp|tcp))?$`), refuse to
   start on a malformed one, log the effective list and policy once; warn loudly
   when TURN is configured without a UDP `turn:` entry (daemon P1-4).
10. Per-frame DB row lock on the relay path (#5): cache durable ownership per
    `DaemonConn` for 10 s (refreshed by heartbeat, invalidated on any Redis CAS
    failure); do not FOR UPDATE for read-only validation; on a transient DB
    timeout drop the frame (log) instead of fencing the whole daemon socket.
11. Registration admission (#6 server half): a bounded semaphore (32) around the
    register transaction so bursts queue instead of timing out into 4000.
12. Relay hygiene (#15 #18 #23): allowlist candidate keys and bound sizes
    (`candidate` ≤ 1 KiB, `sdpMid` ≤ 64, `sdpMLineIndex` 0..65535,
    `usernameFragment` ≤ 256); `rtc.status.message` ≤ 256; pre-connected binding
    TTL 120 s with `rtc.status expired`; truncate daemon `message` in logs.
13. `/ws/browser` pump readiness (#21): if the subscriptions are not ready in 1 s
    close 4010 instead of proceeding deaf. Redis restart presence reclaim (#22).
14. Session offers to the daemon carry `ice_transport_policy` once the daemon
    advertises `session_ice_policy: true` on register (daemon P2-2); keep withholding
    it for old daemons (the existing test pins that).
15. Per-user caps for session-scope RTC bindings (#14): 64 live per user, 16 per socket.
16. Keep accepting `?token=` on sockets for now (old phones), but log a
    deprecation once per process and prefer the header; document removal.
17. Tests for every item; `redis.py` docstring corrected about multi-worker (#1)
    and `docs/RELEASE.md`'s note that prod must run one worker until the
    session path is made symmetric (owner R2 writes the doc; you write the docstring).

## Daemon (daemon/) — owner D2

Findings: REVIEW-daemon P1-1..P1-6, P2-1..P2-5, P2-7, P3-1..P3-5.

1. WS: manual TCP connect for both schemes with `lookup_host` under a 5 s
   timeout, Happy-Eyeballs-lite per-address 5 s attempts, `set_nodelay(true)`,
   keepalive, then `client_async_tls_with_config` for wss; whole `connect` under
   20 s (P1-2, P1-3, P2-1).
2. WS Ping every 15 s from the heartbeat task; count Pongs as liveness; two
   missed → end the session (P1-2). Keep the 75 s idle budget as the outer bound.
3. Backoff: jitter ±25 %; reset `attempt` only after a session that reached
   `Registered` and lasted ≥ 60 s; permanent refusals (protocol required,
   1008, two supersessions in 60 s) go to the cap and log once (P1-6).
4. Keep peers across WS loss (P1-1): no `close_all()` on ordinary socket end;
   swappable WS sender (`ArcSwapOption`/`watch`) read by `try_send_status`/`send_json`;
   deferred statuses re-announced on reconnect; `TrySendError::Full` ≠ `Closed`;
   register carries `keeps_peers_across_reconnect: true` and `live_bindings`.
   Trust/revocation changes still `invalidate_trust_and_close_all()`.
5. ICE restart acceptance on an existing signal id (spec section) (P1-2).
6. Output pacing (P1-5): remove the 2 s send timeouts; pace on
   `buffered_amount`/`set_buffered_amount_low_threshold(64 KiB)`/`on_buffered_amount_low`
   with a 512 KiB high-water; on direct-sink overflow drop the backlog, emit
   `pty_gap {offset}`, re-add the sink; never close a peer for slowness — ICE
   state and `on_close` decide liveness.
7. Session peers honour `ice_transport_policy` when present (P2-2); advertise
   `session_ice_policy: true` on register; log at warn when a frame is dropped.
8. One shared `setting_engine()` for both paths: `set_ip_filter` dropping
   link-local (`fe80::/10`, `169.254/16`), interface filter extended with
   `awdl*`, `llw*`, `anpi*`, `bridge*`, `vmnet*`, `virbr*`, `zt*` (keep `utun*`,
   `wg*`, `tailscale*`); pin an ephemeral UDP port range
   (`set_udp_network(Ephemeral(EphemeralUDP::new(50000, 50100)))`) and document
   the inbound firewall rule; leave mDNS disabled but log once at info that LAN
   direct needs the rule (P2-3, P2-4). Build one `API` per engine at startup (P3-1).
9. Signalling concurrency (P2-5): per-signal-id task with an unbounded channel so
   one peer's 2 s close cannot hold everyone's candidates; the dispatch loop
   must not `.await` anything that can take longer than a few ms.
10. Logging (P2-7, P3-3): classify connect failures (`dns`, `tcp`, `tls`,
    `handshake`, `timeout`, `protocol_required`, `unauthorized`) at warn; bridge
    `log` → `tracing` with `tracing-log` at warn (add the dependency, it is
    tiny); SDP parse errors class-only at warn, text at debug.
11. End-of-candidates: send `{candidate: ""}` (P3-5). Worker barriers 3 s → 10 s (P3-2).
12. TURN over TCP/TLS is unavailable in webrtc-ice 0.17 (P1-4): do not patch the
    crate; make the daemon log once at warn when the offered ICE list has no UDP
    `turn:` entry, and note it in daemon/CLAUDE.md. (The server warns too.)

## Web (web/) — owner W2

Findings: REVIEW-web P1-1, P1-2, P1-4, P2-1..P2-8, P2-10, P2-11, P3-1..P3-4.

1. Shared `backoffDelay(attempt, {base, cap})` with jitter in `src/lib/ws.ts`,
   used by session, host, alerts (P2-7); reset attempt on the first application
   frame, never on `onopen` (P1-2).
2. Close-code handling in all three sockets (section above); a `SocketState`
   `"unauthorized"` and copy "You've been signed out." with a Sign in button;
   4003 keeps the versioning stream's behaviour (P1-2).
3. Watchdog (80 s) on session and host sockets driven by the server `ping`;
   `online`/`visibilitychange`/`pageshow` wake handlers: not OPEN → reconnect now
   (clear backoff); OPEN but pc not connected → ICE restart path; all good → nothing (P1-1).
4. `sanitizeIceServers()` in ws.ts (`^(stuns?|turns?):`, turn(s) require
   credentials, cap 8 entries); construct the pc inside the try; a constructor
   throw runs the retry ladder (P2-2).
5. Keep a healthy pc across WS reconnect; send `rtc.resume` on the new socket;
   only start a new offer when there is no connected pc or the server says
   `unavailable`; do not show "channel…" while the pc is connected (P2-1).
6. ICE restart on `disconnected` (after grace)/`failed`/wake with the spec's
   frame; fall back to rebuild after 10 s; refresh `rtc.config` first when the
   TURN credential expires within 1 h (`rtc.config.request`) (P2-3, P2-4).
7. PTY input chunking ≤ 16 KiB with try/catch and `bufferedAmount` backpressure
   (256 KiB high / `bufferedamountlow`); same in `flushPendingInput` (P1-4).
8. `pty_gap` handling via the existing `history_gap` path.
9. Time-to-first-byte (P2-5): cache `/api/trust/account-endorsements` in
   react-query (staleTime 5 min, prefetch when identity known); start
   `resolveTrust()` in parallel with the WS handshake; `iceCandidatePoolSize: 1`;
   start the connect timer after the offer is sent.
10. Stable hook API: `useCallback`/`useMemo` for `sendBinary`/`sendJson`/`uploadFile`
    and the returned object; resize effect keyed on `dcOpen` with last-size dedupe (P2-6).
11. `session.status running` / non-failure `rtc.status` resets the retry ladder
    and starts RTC immediately; render "transport disabled by this server" (P2-8).
12. Post-paint reconnect banner: after 2 s of `!dcOpen` on a painted pane show
    "Reconnecting to {host} — keystrokes are sent once the channel is back (N queued)";
    expire queued input older than 30 s; chip copy from a map, not the enum (P2-10, P3-3).
13. Pause `getStats` and scrollback refresh when `!active || document.hidden` (P2-11).
14. Explicit signed-mode latch in useSessionSocket mirroring hostControl (P3-1).
15. Tests: a jsdom/bun test file driving a fake `WebSocket`/`RTCPeerConnection`
    through: backoff + jitter bounds, close codes, watchdog, wake handler,
    resume-vs-offer decision, input chunking, ICE-restart-then-fallback (P3-4).
16. Copy mirrors mobile word for word; both are listed here so M2 matches.

## Mobile (mobile/) — owner M2

Findings: REVIEW-mobile P1-1..P1-7, P2-1..P2-7, P3-1..P3-5.

1. Host transport reconnect mirroring the session transport; reject in-flight
   requests with retryable `connection_lost`; Retry on `failed` in the file
   explorer via a generation-keyed remount (P1-1).
2. `rtc.config` only starts a connect when the machine is in `signalling`;
   otherwise cache it; the worker ignores `connect` while `connected`;
   `reduceConnection` accepts `signal-open` from `ready` by resetting gates (P1-2).
   With the resume protocol: on signalling reconnect with a connected pc send
   `rtc.resume`; new offer only on `unavailable`.
3. Backoff: 500 ms, 1, 2, 4 … cap 30 s, jittered; reset on readiness; a
   `connect_timeout` during a reconnect keeps retrying under the ladder (budget
   3 min) before `failed`, whose copy says the connection was lost, not that the
   device may be unapproved (P1-3).
4. Network change (P1-4): add `expo-network` as the production `NetworkSource`
   **behind a guarded dynamic `require` in try/catch** so an OTA on a runtime
   without the native module silently falls back to the socket-observed source
   (no `app.json` version bump; note in the commit that the signal activates
   after the next native build). On `interface-change` post `network-changed`
   to the worker → ICE restart (spec section) with the 5 s grace skipped.
   Watchdog 80 s on `/ws/browser` and `/ws/host` (server pings now).
5. Surfaces close the transport only on `background` (deferred 3 s close that
   `active` cancels); `inactive` does nothing (P1-5).
6. History replay: clear (`\x1b[0m\x1b[H\x1b[2J\x1b[3J`) before a non-first
   bootstrap; skip reseed on the alternate buffer unless forced (P1-6);
   `pty_gap` handled like `history_gap`.
7. Alerts socket follows the auth token: connect when a token appears, retire
   when it disappears; 1008 → `unauthenticated` (re-auth, not permanent);
   surface persistent `failed` with "Live updates paused — Retry" (P1-7).
8. `open()` cancellation safety and single bridge subscription (P2-1).
9. Carried endorsements memoised (30 s) and started at `open()`; skip when the
   host is directly pinned; signalling socket + identity load start from the
   surface mount effect, `rtc.config` buffered until the worker is ready;
   loopback probe cached per process and skipped for host workers (P2-2, P2-6).
10. Signalling-socket `failed` reaches the transport immediately with the close
    code/reason; 4003 → the versioning stream's update flow; 1008 → signed-out (P2-3).
11. Token in an `Authorization` header on all three sockets (RN `WebSocket`
    third argument), query form removed from `socket-urls.ts`; CSP `connect-src 'none'`
    in the worker (pin in the containment test); `ice_servers` filtered to
    `^(stun|stuns|turn|turns):` with credentials only on turn(s) (P2-4).
12. `getStats` poll (5 s while connected) → `connection-info {kind, rttMs}` bridge
    message shown in the terminal header/diagnostics; reconnecting copy varies
    by cause (P2-5).
13. One shared `HostTransport` per host with refcounts; Legion probe polls at
    3 s and pauses off-screen (P2-7).
14. `waitForWritable` on `bufferedamountlow`; platform-correct single bridge
    listener; `rtc.close` on client-side failure while the signalling socket is
    open; log unrecognised `ice_transport_policy` (P3-1..P3-5).
15. Input chunk size 16 KiB (both sides of the bridge), matching web.
16. Tests for each item in the nearest `__tests__`; copy identical to web.

## Release / infra / docs — owner R2

Findings: REVIEW-server #8, production facts above.

1. `infra/nginx-spawnd.conf.example` mirroring the real vhost with
   `location /ws/ { proxy_read_timeout 300s; proxy_send_timeout 300s; }`,
   `map $http_upgrade $connection_upgrade`, and a comment that the app-level
   pings make 60 s survivable but 300 s is the intended setting.
2. `infra/coturn.conf.example` + a section in docs/RELEASE.md (or a new
   docs/NETWORK.md linked from it) documenting: UDP `turn:` is mandatory for
   daemons (webrtc-rs 0.17 cannot use TURN-TCP/TLS), `turns:` on 443 is
   recommended for browsers/phones on UDP-blocked networks (needs a hostname +
   the letsencrypt cert; coturn `tls-listening-port=443` cannot share nginx's
   443 on one IP — document the second-IP or `stunner`/SNI-routing options),
   the daemon's ephemeral UDP range and the inbound firewall rule for LAN
   direct, and the one-uvicorn-worker constraint.
3. `scripts/health-check.sh`: a WebSocket probe through the public origin
   (`wss://<origin>/ws/alerts` offering `spawn.alerts.v1`, no token → expect a
   101 then close 1008) proving the proxy chain; a STUN Binding request to the
   TURN host:port when `SPAWN_TURN_URLS` is set; `coturn` in `UNITS` when TURN is
   configured. `deploy-prod.sh` post-deploy smoke runs the WS probe too.
4. A `scripts/smoke-connection.sh` (optional, gated) that runs a local server +
   daemon + headless browser signalling round trip is NOT required; do not add it.

## Verification (each owner)

Same commands as SPEC-versioning.md. In addition W2 and M2 add unit tests for
the state machines they touch, S2 adds tests for every new frame, and D2 adds
tests for backoff/jitter, connect timeout (use a listening socket that never
accepts), ICE-restart acceptance rules (pure function), and the pacing loop
(fake channel).

## Addendum — user asks 2026-08-25

### Stale presence: "the daemon says connected but the web app says it isn't"

This is the user's specific reconnect complaint and is the top reliability
symptom after ErrChunk. Root causes, all already itemised above, elevated here
to must-fix and to be handled as one coherent story across S2 and D2:

- Host status is served from the `status` column verbatim; after a server
  crash/OOM/redeploy the daemon's `finally` may not run, so the row stays
  `online` forever while the socket is gone (server #13). FIX: derive
  `online` iff `status == "online"` AND `last_seen_at >= now − 90 s`, everywhere
  a host status is serialised (list, get, patch, and the session/host embeds).
- Redis presence is the source of truth for "which worker holds the daemon";
  after a Redis blip `/ws/host` and the browser session path report the daemon
  gone until the next 30 s heartbeat reclaims it (server #22). FIX: when the
  local broker still holds the DaemonConn but Redis has no presence key,
  reclaim eagerly instead of waiting for the heartbeat.
- The single-worker terminal-path asymmetry (server #1): with >1 uvicorn worker
  a browser that lands on a different worker than the daemon is told "no daemon
  connected" though the host shows online. Prod runs one worker today; S2
  corrects the `redis.py` docstring and R2 documents the one-worker constraint,
  and this is called out as the known limiter for horizontal scaling with a
  named follow-up (make the session path resolve the owner via Redis +
  owner_dispatch like the host path already does).
- The signalling-loss-without-data-loss orphan/rebind/resume protocol (above)
  is what stops a daemon WS blip from *presenting* as a dead host in the first
  place: the browser keeps its channel and the host stays online across the
  daemon's reconnect.

Acceptance: after a `deploy-prod.sh` restart, an already-connected host stays
"online" in web and mobile and its open terminals recover without a manual
reload; a daemon whose machine slept and woke reflects the true state within one
keepalive interval, never a false "online".

### ErrChunk (sessions die 3–39 s after connect)

Root cause and fix come from scratchpad/reports/INVESTIGATE-errchunk.md (a
dedicated investigation). Likely outcomes and how they slot in:
- If it is a fixed-upstream webrtc-rs/webrtc-sctp bug: D2 bumps the pinned
  versions to the identified target and migrates rtc.rs; this is its own commit
  with the investigation linked, and re-runs the daemon connection tests.
- If it is inbound message size / MTU over relay: the web P1-4 and mobile input
  chunking (≤ 16 KiB) is the client half; D2 adds a defensive inbound cap and,
  if the investigation shows it, a conservative SCTP max-message/MTU setting.
  These land with the connection streams.
Do not guess the fix here; the investigation decides. The `ice_transport_policy`
session-offer trap (a session offer must never carry the field for today's
daemons — it is the host/session discriminator in run.rs) is restated for D2 and
S2 and must not be violated by any ErrChunk or relay fix.
