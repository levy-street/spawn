# Server connection/signalling review — SPAWN D control plane

Branch `native-daemon-fixes-auto-update-daemon`, read-only, 2026-08-25. Line numbers are
from the working tree at the time of reading; `ws/daemon.py` and `routes/hosts.py` were being
edited by other agents during the review (daemon.py grew from 2098 to 2228 lines), so treat
daemon.py numbers as ±a few lines. Nothing was run.

Deployment facts established from the repo (used throughout):

- uvicorn 0.46.0 + websockets 16.0 in `server/.venv`. Defaults `ws_ping_interval=20.0`,
  `ws_ping_timeout=20.0` (`uvicorn/config.py:191-192`); the `websockets-sansio`, legacy and
  wsproto implementations all honour them. The production systemd unit is **not** in the repo,
  so whether prod overrides these (or `--workers`) cannot be confirmed.
- Next 15.5.15 proxies `/ws/*` upgrades via http-proxy; `setupSocket` calls
  `socket.setTimeout(0)` on both halves and `proxyTimeout` (30 s) applies to HTTP only. Next
  adds no idle cut on WebSockets.
- nginx: only `infra/nginx-admin.conf.example` is in the repo (no `proxy_read_timeout`, so the
  60 s default applies to that vhost). The main `spawnd.dev` vhost is not in the repo.
- Daemon: `host.heartbeat` every 30 s (`daemon/src/run.rs:43`), read-idle 75 s
  (`daemon/src/ws.rs:197`), TCP keepalive 30 s/5 s (`ws.rs:118-123`), `Authorization: Bearer`
  header (`ws.rs:26-41`), backoff 1,2,4…60 s **without jitter** (`ws.rs:265-270`).
- Web: same-origin sockets, cookie auth (`web/src/lib/ws.ts:31,47`). Mobile: access token in
  the URL query (`mobile/src/data/api/socket-urls.ts:5-14`).
- TURN: no TURN URL/secret anywhere in the repo (`.env.example:12-14` is Google STUN only;
  `docs/TRUST.md:641-655` states coturn runs on the prod box with `use-auth-secret` as of
  2026-07-10). Whether prod's `.env` sets `SPAWN_TURN_URLS`/`SPAWN_TURN_SECRET` is unknowable
  from the repo.

---

## (A) Findings, by severity

### 1. P1 (P0 the moment `--workers > 1`): terminal signalling and every daemon-facing HTTP route are worker-local, despite the Redis "cross-worker" design

**What the code does.** The host-control path is genuinely cross-worker: `/ws/host` resolves
the daemon from Redis presence (`ws/host.py:474-480`) and the daemon's own worker registers the
binding on receipt (`ws/daemon.py:1173-1300`, host branch). The terminal path is not: the
browser's `rtc.offer` looks the daemon up in the **in-process** broker
(`ws/browser.py:456-469`: `broker.get_daemon_for_session(...) or broker.get_daemon_for_host(...)`
→ "No daemon is connected."), registers the binding against that local `DaemonConn`
(`ws/browser.py:491-502`), and the daemon-side pump expects the binding to already exist in
**its** worker's broker (`ws/daemon.py` session branch: `broker.rtc_session_for(session_id,
daemon=conn)` → `None` → silently dropped). Same for `routes/sessions.py:137,351,389,411` and
`routes/hosts.py:510,547,616,642,741` (`get_daemon_for_host` → 409 "host daemon is offline").
Only `push_browser_pins` (`ws/daemon.py:2210-2228`) handles the remote-worker case.
`redis.py:3-5` claims "Production deployments use real Redis so multiple uvicorn workers can
share state" — for the paths above that is false.

**Impact.** With N workers, a browser lands on the daemon's worker with probability 1/N; the
rest get "No daemon is connected" / 409 while the host list says online. If prod runs one
worker this is latent, but the docstring and the host path invite someone to add workers.

**Fix.** Short term: pin `--workers 1` in the unit and say so in `docs/RELEASE.md` and
`redis.py`. Real fix: make the session path symmetric with the host path — browser publishes
the offer against the Redis presence owner (as `ws/host.py:530-535` does) and the daemon's
worker registers the binding on receipt; HTTP routes resolve the owner from Redis and
request/reply over `owner_dispatch` (the plumbing already exists for pong/agents).

### 2. P1: a Redis pub/sub drop leaves browser and alert sockets open but deaf; the daemon socket is closed with a misleading "superseded"

**What the code does.** `subscribe_channel` iterates `pubsub.listen()` (`redis.py:348-389`)
with no resubscribe; a dropped Redis connection ends the iterator. Per socket:

- `/ws/daemon`: `receive_with_signal_pump` (`ws/host_signal.py:55-71`) raises
  `RuntimeError("host signal subscription stopped")` → generic `except` →
  `_fence_superseded_daemon` → close 4000 "superseded" (`ws/daemon.py:2141-2144`,
  `1124-1143`). Every daemon on the worker reconnects simultaneously (see #5 on jitter).
- `/ws/browser`: `_pump_rtc_signals` logs "RTC signal subscribe loop crashed" and exits
  (`ws/browser.py:348-351`); the socket stays open. Every subsequent `rtc.offer` is published
  fine but the answer can never arrive; the client retries forever against a deaf socket.
- `/ws/alerts`: `_pump_alerts` exits (`ws/alerts.py:292-296`); `alerts.ping` keeps flowing, so
  the client's 80 s watchdog never fires; alerts silently stop until the tab reloads.

**Fix.** On pump termination close the socket with a distinct code (1012 "service restart" or
4010) so clients reconnect through their existing backoff; for the daemon use a distinct
reason instead of "superseded". Optionally resubscribe with backoff inside
`subscribe_channel` and re-check the fencing token afterwards.

### 3. P1: TURN credentials on the browser side are minted once per socket with a 24 h TTL and can never be refreshed mid-socket

**What the code does.** `/ws/browser` sends `rtc.config` once at accept
(`ws/browser.py:217`, `_rtc_config_payload` at 52-63); `/ws/host` likewise
(`ws/host.py:383-420`, comment at 379-382 acknowledges exactly this failure for the daemon
side). Offers to the daemon mint fresh credentials (`_offer_ice`, `ws/browser.py:66-79`;
`ws/host.py:513-517`) — the daemon is fine; the browser is not. There is no frame that
re-sends `rtc.config`. `turn_ttl_seconds` defaults to 24 h (`config.py:151`).

**Impact.** A tab or app open longer than the TTL that has to build a new PeerConnection
(DataChannel dropped, network change, host reconnect) does so with expired TURN credentials →
coturn 401 → STUN/direct only → fails on exactly the NAT-restricted/corporate networks TURN
exists for, until the WebSocket happens to reconnect. Separately, coturn refuses allocation
refresh once the timestamp expires, so a *relayed* terminal session cannot outlive the TTL
(~24 h + allocation lifetime).

**Fix.** Server pushes a fresh `rtc.config` on `/ws/browser` and `/ws/host` every
`min(turn_ttl/2, 1 h)` (clients adopt the latest before constructing a PC); add a client
`rtc.config.request`. Consider `turn_ttl_seconds` 48–72 h with coturn `user-quota`, and an
ICE-restart path (#4) so a live relayed session can rotate credentials.

### 4. P1 (mobile) / P2 (desktop): no ICE restart; a network switch forces a full DataChannel rebuild

**What the code does.** `register_rtc_session` refuses a second offer for a live session id
(`ws/broker.py:313-314`; browser gets "RTC session id is already in use.",
`ws/browser.py:503-513`; host scope "failed", `ws/host.py:484-501`). There is no
`rtc.restart`. The only recovery is `rtc.close` + a fresh session id + fresh PeerConnection.

**Impact.** Wi-Fi→LTE, VPN toggles, sleep/wake with a new address: the terminal visibly
reconnects and any in-flight host-control request is lost, when WebRTC could repair the path
in place.

**Fix.** Accept `rtc.offer` with `ice_restart: true` from the *same* route on an existing
binding: keep nonce/generation, re-mint ICE, forward as a restart. Needs daemon support
(review-daemon) and client support.

### 5. P1 under load / P2 today: one DB row-lock transaction per relayed signalling frame, in both directions, on the same row the heartbeat and activity pings lock

**What the code does.** Daemon→browser: `_route_rtc_payload_if_owner`
(`ws/daemon.py:1050-1066`) runs `_validate_durable_host_owner` (SELECT … FOR UPDATE + three
`SET LOCAL` + rollback, `ws/daemon.py:~870-900`) and `_redis_owner_is_current` (Lua EVAL) for
**every** answer/candidate/status. Browser→daemon: `_process_host_rtc_signal`
(`ws/daemon.py:1186`) does the same per frame. `session.activity` (every 2 s per live session)
and `host.heartbeat` take FOR UPDATE / UPDATE on the same `hosts` row (`ws/daemon.py:1650-1663`
and the activity branch). `lock_timeout='2s'`, `statement_timeout='5s'`; pool is SQLAlchemy
defaults 5+10 (`db.py:50`); `_bounded_host_ownership_session` caps at 10 s.

**Impact.** Trickle ICE is 10–40 frames per setup, serialized on the daemon's socket loop, so
setup latency is ~frames × (DB txn + 2 EVALs). Worse, any lock/pool/PG hiccup surfaces as
`_fence_superseded_daemon` → daemon closed with 4000 → every session's signalling on that host
drops and the daemon reconnects. Redis already provides an atomic fencing token
(`publish_if_host_owner`), so the per-frame DB lock is belt-and-braces bought at the price of
availability.

**Fix.** Cache durable ownership per `DaemonConn` with a short validity (5–10 s) refreshed by
the heartbeat write and invalidated on any Redis CAS failure; drop FOR UPDATE for read-only
validation; fail *closed on the frame* (drop it) rather than fencing the whole socket on a
transient timeout.

### 6. P2: after a server restart, every daemon returns in lockstep and the server has no admission control

**What the code does.** `deploy-prod.sh` restarts `spawn-server`; all daemons see the close and
reconnect after `backoff_for_attempt` = 1,2,4…60 s with no jitter (`daemon/src/ws.rs:265-270`).
Registration costs ~7 DB transactions + ~6 Redis EVALs + `_live_browser_pins` per daemon
(`ws/daemon.py:1497-1640`). Nothing rate-limits or queues `/ws/daemon` registrations; the only
backpressure is timeouts (`HOST_ACTIVATION_DEADLINE_SECONDS=30`, session cap 10 s, pool
timeout 30 s), each of which ends in a 4000 close and another synchronized retry wave.

**Fix.** Daemon side: full jitter. Server side: a bounded semaphore around registration
(e.g. 32 concurrent) so extra arrivals wait instead of timing out and being closed; make pool
size explicit.

### 7. P2: supersession tears down host-control channels that may be healthy, and tells terminals nothing

**What the code does.** `accept_daemon_owner` retires the old connection's session-scope
bindings silently (`ws/broker.py:178-210`, `_drop_rtc_sessions_for_daemon_locked(existing,
include_host=False)`), then closes the old socket. The old handler's `finally` runs
`_revoke_host_rtc_sessions` (`ws/daemon.py:1068-1122`, called at 2145): every browser with a
host-control binding is told `unavailable` (via the replacement's owner token), and the
`rtc.close` to the old daemon is sent to a socket that was closed first (`1124-1136`), so it
is swallowed. When the socket dies *without* a replacement, the `unavailable` publish is fenced
(old owner no longer current → `StaleHostOwnerError` → `except: pass`) and browsers hear nothing
either way.

**Impact.** A daemon that merely re-dials its control socket (network blip, server restart)
makes every browser rebuild host control even when the DataChannel is fine; terminals learn of
a dead daemon only from DTLS/consent timeouts. Needs client confirmation (review-web/mobile) of
what `unavailable` does to an established channel.

**Fix.** On supersession by the same host, rebind live bindings to the new `DaemonConn` (new
generation, same nonce) and emit `rtc.status rebound`; reserve `unavailable` for a daemon that
is actually gone; on plain socket loss emit `unavailable` for terminals too.

### 8. P2: deploy smoke and health checks never exercise a WebSocket upgrade or TURN

**What the code does.** `scripts/deploy-prod.sh:344-367` and `scripts/health-check.sh:48-71`
only `GET /healthz` (directly and through the Next rewrite). `UNITS` default is
`spawn-server spawn-web redis-server` (`health-check.sh:24`) — no coturn.

**Impact.** A nginx vhost missing `Upgrade`/`Connection` headers, a Next regression in upgrade
proxying, a `proxy_read_timeout` cut, or coturn down/expired-cert all pass the smoke test while
every socket or every off-LAN connection fails.

**Fix.** Add a WS probe through the public origin: open `wss://<origin>/ws/alerts` offering
`spawn.alerts.v1` with no token and assert the handshake completes (101) and the close is
1008 "not authenticated" — proves the proxy chain, distinct from auth. Add a STUN Binding
request to the TURN host and `coturn` to `UNITS` when `SPAWN_TURN_URLS` is set.

### 9. P2: ICE/TURN misconfiguration is silent and can break or relay everyone

**What the code does.** `webrtc_ice_server_list` returns `[]` on any JSON/shape error
(`config.py:166-190`); `turn_url_list` is `split(",")` with no URL validation
(`config.py:161-163`); nothing logs the effective ICE set at boot.

**Impact.** A typo in `SPAWN_WEBRTC_ICE_SERVERS` silently drops STUN: with TURN configured,
`ice_transport_policy` becomes `"relay"` for every client (all traffic through coturn, paid
bandwidth, higher latency); without TURN, `ice_servers=[]` → LAN-only. A malformed TURN URL is
shipped to every client and `new RTCPeerConnection({iceServers})` throws, so every connection
fails.

**Fix.** Validate at startup (scheme ∈ stun/stuns/turn/turns, host, optional port,
`?transport=udp|tcp`), refuse to start on error, log the effective servers and policy.

### 10. P2: the phone puts its access token in the WebSocket URL, and the server accepts it there

**What the code does.** `mobile/src/data/api/socket-urls.ts:5-14` appends `?token=` to
`/ws/browser`, `/ws/host`, `/ws/alerts`; `_resolve_user` accepts `token` from the query
(`ws/browser.py:154-155`) after header and cookie; `_resolve_daemon_host` does too
(`ws/daemon.py:~104-105`) although the daemon sends a header.

**Impact.** The handshake request line, token included, is written to nginx's access log and
uvicorn's access log (default format logs the full path) and any intermediate. Access tokens
are 15-minute JWTs (`config.py:28`), which bounds but does not remove the exposure.

**Fix.** React Native's `WebSocket` accepts `{ headers: { Authorization } }` as a third
argument; the server already prefers the header. Then remove query-token acceptance from
`_resolve_user` and `_resolve_daemon_host`.

### 11. P2: `/ws/host` skips the `protocol.required` + 4003 negotiation the other three sockets do

**What the code does.** `ws/daemon.py:1413-1423`, `ws/browser.py:187-195`, `ws/alerts.py:252-262`
check the offered subprotocols, accept, send `protocol.required`, close 4003.
`ws/host.py:359` does `await websocket.accept(subprotocol=HOST_WS_SUBPROTOCOL)` unconditionally.

**Impact.** A client that did not offer `spawn.host.v1` gets a browser-level handshake
failure (RFC 6455 §4.1: server selected a subprotocol the client did not offer) with no frame —
exactly the case the 4003 client wiring in the other stream is meant to catch.

**Fix.** Mirror the other three sockets.

### 12. P2: a client on the right subprotocol but the wrong frame shape gets silence on every socket

**What the code does.** `/ws/browser`: unknown `type` falls through the `if/elif` with no
`else` (`ws/browser.py:387-645`); `/ws/host`: metadata mismatch → `continue`
(`ws/host.py:441-447`); `/ws/daemon`: log only (`ws/daemon.py:2138`); malformed candidates and
SDPs → `continue` everywhere.

**Fix.** Reply `{"type":"error","code":"unknown_frame"|"invalid_frame","frame_type":…}`,
rate-limited per socket (say 1/s), and count in metrics. The daemon socket should also answer
a pre-`register` frame with an error instead of dropping it.

### 13. P2: host status survives a server crash as "online" forever

**What the code does.** `_to_out` returns `host.status` verbatim (`routes/hosts.py:62-88`);
`status="offline"` is written only by the socket's `finally`
(`ws/daemon.py:2173`, `_mark_host_offline_if_owner`) or by supersession. There is no startup
sweep and no derivation from `last_seen_at`.

**Impact.** After SIGKILL/OOM/power loss (finally never runs), any host whose daemon does not
come back shows "online" with a stale `last_seen_at`, and `/ws/host` says "unavailable" while
the list says online.

**Fix.** Derive in `_to_out` (and wherever sessions expose host status):
`online iff host.status == "online" and last_seen_at >= now - 3 × 30 s`. Keep the raw column.

### 14. P2: one authenticated user can exhaust the per-worker RTC binding table for everyone

**What the code does.** `MAX_RTC_BINDING_IDENTITIES = 4096` counts live **and** retired
bindings across all users per worker (`ws/host_signal.py:25`; `ws/broker.py:308-312`);
tombstones live 5 min (`ws/host_signal.py:24`). Session-scope offers have no per-connection
cap (only host scope has `MAX_HOST_RTC_SESSIONS_PER_BROWSER = 8`, `ws/broker.py:315-338`).

**Impact.** ~14 offer/close pairs per second for five minutes fills the table; every other
user's offers then fail ("failed" / "already in use"). Invite-only deployment mitigates.

**Fix.** Per-user and per-connection caps for session scope; per-socket frame-rate limit.

### 15. P3: relayed candidate objects and status messages are forwarded almost unvalidated

**What the code does.** `_valid_rtc_candidate` only checks `candidate` is a string ≤ 64 KiB and
forwards `dict(value)` with every other key intact (`ws/browser.py:99-105`,
`ws/daemon.py:647-654`); a real candidate is < 300 B. Session-scope `rtc.status.message` from
the daemon is forwarded unbounded (`ws/daemon.py:2101-2104`); host scope drops it (good).
Offers/answers are rebuilt server-side with allowlisted fields and server-chosen
`ice_servers`/`ice_transport_policy` (`ws/browser.py:531-555`, `ws/host.py:514-529`,
`ws/daemon.py:1995-2049`), so neither peer can inject ICE servers or policy into the other.

**Fix.** Allowlist `candidate` (≤ 1 KiB), `sdpMid` (≤ 64), `sdpMLineIndex` (int 0..65535),
`usernameFragment` (≤ 256); drop other keys; cap `message` at 256 chars.

### 16. P3: every failure class closes the daemon with 4000 "superseded"

**What the code does.** `_fence_superseded_daemon` (`ws/daemon.py:1124-1143`) is the handler
for real supersession, DB lock timeouts, Redis blips, pool exhaustion, send timeouts
(`_bounded_send_text` 2 s) and the generic `except` — ~25 call sites.

**Impact.** Logs and client diagnostics misattribute outages; if a future daemon treats 4000 as
"another instance owns this host, stop", transient errors kill daemons. Today the daemon
reconnects on any close (`daemon/src/run.rs:545-557`).

**Fix.** 4000 superseded (real), 4004 fencing/consistency failure, 1012 service restart.

### 17. P3: session offers never carry `ice_transport_policy` because the daemon uses the field's presence as its host/session discriminator

`ws/browser.py:66-79`, guarded by `test_ws_browser.py:745-757`. In a relay-only deployment the
daemon still gathers host/srflx candidates for terminal PCs (slower, daemon IPs in
candidates). Fix needs a protocol bump: daemon dispatches on `scope_type` (already on every
frame), then the server adds the policy.

### 18. P3: pre-connected binding TTL of 60 s fails silently

`HOST_RTC_SESSION_TTL_SECONDS = 60` (`ws/host_signal.py:22`). A negotiation slower than that
(TURN over TCP on a bad link can take 10–20 s; a stalled daemon longer) expires the binding and
every later answer/candidate is dropped with no frame to the browser. Raise to 120 s and emit
`rtc.status expired`.

### 19. P3: no Origin check on cookie-authenticated sockets

`/ws/browser`, `/ws/host`, `/ws/alerts` accept the `spawn_session` cookie
(`ws/browser.py:153`) and rely on `SameSite=lax` (`auth.py:121`, `routes/auth.py:132,209`) to
keep cross-site handshakes unauthenticated. That holds in current browsers (Lax cookies are not
sent on cross-site WebSocket handshakes). An explicit `Origin` allowlist from
`cors_origin_list`/`web_url` is cheap belt-and-braces.

### 20. P3: unthrottled failed WebSocket auth

An expired daemon token (`jwt_daemon_ttl_days=365`) or revoked host makes the daemon re-dial
every ≤ 60 s forever; each attempt is TLS + JWT decode + DB lookup; `rate_limit.py` covers only
HTTP auth routes. Add a per-IP limiter on `/ws/*` handshake failures.

### 21. P3: `/ws/browser` proceeds deaf if its subscriptions are not ready within 1 s

`ws/browser.py:355-361` waits 1 s for both pumps then enters the receive loop regardless; on a
slow Redis the first answer can be published before the browser's channel is subscribed. Close
1012 instead of proceeding.

### 22. P3: Redis restart hides a connected daemon for up to one heartbeat

Presence lives only in Redis (TTL 90 s, `ws/host_signal.py:26`); after a Redis restart
`/ws/host` says "unavailable" (`ws/host.py:474-479`) and `/ws/browser` "could not reach the
daemon" until the next 30 s heartbeat reclaims it (`ws/daemon.py:714-760`). Reclaim eagerly
when the local broker holds the connection but Redis has no key.

### 23. P3: daemon-supplied strings reach the log unbounded

`ws/daemon.py:2130-2136` logs `obj.get("message")` from the daemon verbatim. No SDP or
candidates are logged anywhere (good). Truncate to 256 chars.

---

## Lens-by-lens summary

**1. Keepalives and timeouts.**

| Socket | App-level keepalive | Protocol pings | Dead-peer detection | Proxy idle risk |
|---|---|---|---|---|
| `/ws/daemon` | daemon `host.heartbeat` every 30 s, server echoes (`ws/daemon.py:1650-1663`), writes `last_seen_at`, refreshes Redis presence (TTL 90 s) | uvicorn 20 s/20 s | server: pong timeout ≈ 20–40 s after lid closes → `WebSocketDisconnect` → offline. Daemon: 75 s read-idle | none (30 s traffic) |
| `/ws/alerts` | server `alerts.ping` every 25 s (`ws/alerts.py:42,298-304`); web watchdog 80 s | uvicorn 20 s/20 s | server via pong timeout | none |
| `/ws/browser` | **none** in either direction | uvicorn 20 s/20 s | server via pong timeout; client only on `onclose` | survives nginx's 60 s default **only** because of uvicorn pings |
| `/ws/host` | **none** | uvicorn 20 s/20 s | same | same |

"Host offline" after a silent vanish is ~20–40 s: not twitchy, not slow. The whole table
depends on the prod unit not passing `--ws-ping-interval 0` and on the main nginx vhost's
`proxy_read_timeout` — neither is in the repo. Recommended values: nginx `location /ws/ {
proxy_read_timeout 300s; proxy_send_timeout 300s; }`, uvicorn `--ws-ping-interval 20
--ws-ping-timeout 20` stated explicitly in the unit, and an app-level ping (server-sent, like
alerts) on `/ws/browser` and `/ws/host` so liveness does not hinge on ASGI defaults.

**2. Supersession.** Takeover is DB generation allocation → Redis pending claim → DB
activation → Redis CAS → local accept (closes the old local socket within 1 s) → revocation
publish; sub-second in practice. From the Redis CAS onward the old connection's non-heartbeat
frames fail `_daemon_can_mutate` and its heartbeats fail `_refresh_host_signal_presence`
(`ws/daemon.py:714-760`), so there is no window where both route. RTC bindings: host scope gets
a definitive `unavailable`; session scope gets nothing (#7). Reconnect storm: #6.

**3. ICE/TURN.** `label = user_id` is fine (enables coturn `user-quota`; it is visible in
cleartext STUN over `turn:` UDP/TCP, so prefer `turns:` if that matters). The signed transcript
(`ws/signed_signal_relay.py:113-128`, `_FIELDS`) does **not** include `ice_servers`, so
credential rotation cannot break verification; the "8 KiB … TURN ice_servers block" comment is
about the routing-metadata budget. `turns:` is handled by `ice_transport_policy`
(`turn.py:62`) but documented nowhere, and TURN-over-TLS-443 for UDP-blocked networks is not
in any example config. `ice_transport_policy` is present on browser `rtc.config`
(`ws/browser.py:61`), host `rtc.config` (`ws/host.py:414`), host `rtc.offer`→daemon
(`ws/host.py:517`), and deliberately absent on session `rtc.offer`→daemon (#17). Production
TURN: not provisioned anywhere in the repo (see C).

**4. Relay path.** Browser→daemon frame: WS → local broker (lock) → Redis EVAL publish → daemon
worker pump → broker lock + DB FOR UPDATE txn + Redis EVAL → daemon WS. Daemon→browser: WS →
broker lock + DB FOR UPDATE txn + Redis EVAL + Redis EVAL publish → browser pump → two broker
lookups → WS. One pub/sub hop, one DB transaction, two EVALs per frame (#5). Ordering is
preserved end to end (single publisher per worker, sequential pumps and socket loops). Bounds
— candidate 64 KiB, SDP 1 MiB, frame 1100 KiB, Redis envelope 1200 KiB, signed envelope
512 KiB — drop no legitimate trickle candidate. Silent expiry at 60 s: #18.

**5. Security.** Auth: daemon header (query fallback), browser header/cookie/query; no Origin
check (#19); no per-user WS rate limits (#14, #20). Injection: neither peer can inject
ICE servers or policy (server rebuilds every offer/answer); candidate objects and session
`message` pass through (#15). Logging: no SDP/candidates; daemon `message` unbounded (#23);
tokens in URLs (#10).

**6. Protocol negotiation.** Consistent on `/ws/daemon`, `/ws/browser`, `/ws/alerts`;
`/ws/host` is the odd one out (#11). Wrong frame shape on the right subprotocol is silent
everywhere (#12).

---

## (B) What is already good

- Fencing is genuinely correct: durable generation counter + Redis pending/active leases with
  Lua CAS (`redis.py:252-345, 414-599`), `publish_if_host_owner` as an atomic fencing token on
  every cross-worker publish, and `_reconcile_host_activation` resolving lost-ack cases. The
  test suite pins the hard cases (delayed C vs successor D, Redis loss, corrupt cache,
  generation max) — `test_ws_daemon.py:566-1018`.
- Supersession of the *local* predecessor is atomic with route removal
  (`ws/broker.py:178-210`) and the socket close is bounded (1 s) and idempotent.
- The daemon heartbeat doubles as keepalive with a server echo, and the daemon's read-idle
  budget is measured against JSON frames only, so protocol pings cannot mask a half-dead link
  (`daemon/src/ws.rs:207-260`).
- `/ws/alerts` has a proper server-side keepalive with a documented cadence and a client
  watchdog.
- Fresh TURN credentials per offer to the daemon; static ICE stays in front of the minted entry;
  TURN URLs without a secret are never shipped unauthenticated (`test_turn.py`).
- `ice_transport_policy` is computed in one place and the tests guard both its presence on
  `rtc.config` and its absence on session offers.
- Relay validation is strict where it matters: signed envelopes are checked field-by-field
  with duplicate-key and non-finite rejection, the routing tuple must match the authorized
  route, raw SDP in signed mode fails closed, frame/envelope byte bounds have a compile-time fit
  proof (`ws/signed_signal_relay.py`).
- Every socket refuses binary frames and retired content frames with 4002; terminal bytes have
  no server code path.
- Cookie is `HttpOnly; SameSite=Lax; Secure` under https.
- Daemon authenticates with a header, has TCP keepalive tuned for uvicorn restarts, and
  reconnects on any close.
- `push_browser_pins` shows the right cross-worker pattern (nudge on the host channel, owner
  worker recomputes from the DB).

---

## (C) Open questions

1. **Production TURN.** The repo contains no TURN URL, secret, coturn unit, config, or
   example (`.env.example:12-14` is STUN-only; `infra/docker-compose.yml` has no coturn;
   `health-check.sh` does not watch it). `docs/TRUST.md:641-655` asserts coturn runs on the
   prod box with `use-auth-secret` since 2026-07-10. I could not determine: whether prod's
   `.env` sets `SPAWN_TURN_URLS`/`SPAWN_TURN_SECRET`; which transports are offered (`udp`,
   `tcp`, `turns:` on 443); the coturn `realm`/`user-quota`/cert state; or whether
   `SPAWN_WEBRTC_ICE_SERVERS` still includes STUN (which decides `"all"` vs `"relay"`). Run on
   the box: `grep -E 'TURN|ICE' /path/to/.env`, `systemctl status coturn`, and a STUN
   Binding request to port 3478/443.
2. **Production uvicorn flags.** `--workers` (decides whether #1 is P0 today), `--ws`,
   `--ws-ping-interval/--ws-ping-timeout`, `--proxy-headers`. The unit is not in the repo.
3. **Main nginx vhost.** `proxy_read_timeout`/`proxy_send_timeout` on `/ws/`, and whether it
   uses `map $http_upgrade $connection_upgrade` or the admin example's fixed `"upgrade"`.
4. **Client behaviour on `rtc.status unavailable` for an established channel** (#7) and on
   a deaf `/ws/browser` (#2) — for review-web and review-mobile.
5. **Daemon behaviour on `rtc.close` for a host-control session after its socket is already
   closed** and on `ice_restart` (for #4, #7) — for review-daemon.
6. Whether uvicorn's access log is enabled in prod (decides how bad #10 is today).
