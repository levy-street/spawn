# Production network for SPAWN D

This is the production contract for nginx, WebSockets, WebRTC, and TURN. The
checked-in examples are [the public nginx vhost](../infra/nginx-spawnd.conf.example)
and [the coturn configuration](../infra/coturn.conf.example). Replace secrets
and machine-specific addresses deliberately; do not copy a placeholder into a
running service.

## Current production topology

As verified on 2026-08-25, nginx terminates the Let's Encrypt certificate for
`spawnd.dev` and proxies to Next on `localhost:3001`, including WebSocket
upgrade headers. Next proxies `/api/*` and `/ws/*` to the API on
`127.0.0.1:8001`. coturn listens on UDP and TCP 3478 with `use-auth-secret`,
realm `spawnd.dev`, and `external-ip=100.26.16.161/10.0.0.127`. There is no
TURN TLS listener today.

Use a dedicated nginx `/ws/` location with 300-second read and send timeouts.
The server's 25-second application pings make nginx's 60-second default
survivable, but five minutes is the intended operational margin. Keep
uvicorn's protocol ping interval/timeout explicit at 20 seconds as a second
layer rather than relying on library defaults.

After changing nginx, run `nginx -t`, reload it, then run:

```bash
SPAWN_HEALTH_PUBLIC_ORIGIN=https://spawnd.dev \
  scripts/health-check.sh --probe-websocket https://spawnd.dev
```

The probe offers `spawn.alerts.v1` without credentials and requires HTTP 101
followed by WebSocket close 1008. That sequence proves nginx, Next, and the API
all preserved the upgrade; an HTTP-only health check cannot prove it.

## TURN transports and ports

The server and coturn must share one secret:

```dotenv
SPAWN_TURN_URLS=turn:100.26.16.161:3478?transport=udp,turn:100.26.16.161:3478?transport=tcp
SPAWN_TURN_SECRET=<same random secret as coturn static-auth-secret>
```

An ordinary UDP `turn:` URL is mandatory. The daemon uses webrtc-rs 0.17,
which cannot use TURN over TCP or TLS, so a list containing only
`?transport=tcp` or `turns:` strands daemons behind restrictive NAT. Keep UDP
3478 reachable, even after adding transports for browsers and phones. TCP
3478 is useful to those clients but does not replace UDP for the daemon.

Allow both listener traffic and relay allocations in the host/cloud firewall:

- UDP 3478 and TCP 3478 to coturn.
- The coturn UDP relay range. The default is 49152–65535; if production pins
  `min-port`/`max-port`, open that exact range and keep config and firewall in
  lockstep.
- UDP 50000–50999 inbound on each daemon machine where LAN/direct WebRTC is
  expected. This is the daemon's ephemeral candidate range, not coturn's relay
  range. Host firewalls may restrict it to trusted LANs when off-LAN traffic
  can fall back to TURN. The range is also the budget for direct paths: every
  peer connection binds one server-reflexive socket per STUN/TURN URL per
  address family, plus one host socket per address of every interface that
  carries a host candidate — LAN links and VPN interfaces alike, since a peer
  on the same VPN reaches the daemon through them. Five a peer on a
  two-interface Linux host; more on a Mac with its `utun`s. A peer that finds
  the range full still reaches the TURN relay (the TURN client binds outside
  the range), so a full range means relay-only sessions, and the relay pays
  for them. Daemons before the 50000–50999 range pinned 50000–50100 and went
  relay-only at about a dozen sessions on such a Mac. Ports are chosen at a
  random offset within the range, so a firewall rule written for the old one
  admits only about one socket in ten: re-create the rule for the new range
  when the daemon updates. What stops a peer gathering anything at all is the
  process's open-file limit; the daemon raises its own soft limit when it
  starts to run, and the service units it writes set the soft limit only
  (`LimitNOFILE=65536:infinity`, launchd `SoftResourceLimits`): the daemon's
  hard limit follows every shell a SPAWN D terminal spawns, so a number there
  would stop `ulimit -n` reaching what a native shell can. Those shells do
  inherit the raised soft limit.

For example, a daemon host using UFW can admit direct candidates from a
`192.168.1.0/24` LAN with:

```bash
sudo ufw allow from 192.168.1.0/24 to any port 50000:50999 proto udp
```

Add the equivalent inbound rule to any host or cloud firewall in front of that
machine; use a broader source only when direct Internet candidates are
intended.

## Windows Firewall

On native Windows, `spawnd.exe` is the only SPAWN D program that binds the
direct WebRTC candidate range, UDP 50000–50999. The per-user installer neither
elevates nor silently creates a firewall rule. When inbound direct ICE is
blocked, the daemon can still use ordinary outbound UDP to the configured TURN
service.

An administrator who explicitly wants direct candidates on a Private network
may add this program-scoped rule for the installed daemon. A rule created
under the earlier 50000–50100 guidance admits about one socket in ten of the
current range; remove it and create it again for 50000–50999:

```powershell
$spawnd = Join-Path $env:LOCALAPPDATA 'spawn\bin\spawnd.exe'
New-NetFirewallRule -DisplayName 'SPAWN D direct WebRTC (Private)' `
  -Direction Inbound -Action Allow -Profile Private -Program $spawnd `
  -Protocol UDP -LocalPort 50000-50999

# Uninstall or rollback:
Remove-NetFirewallRule -DisplayName 'SPAWN D direct WebRTC (Private)'
```

Creating or removing that rule requires administrator authority. A standard
user may see a first-listen Windows Security prompt but may be unable to approve
the exception; declining, dismissing, or being blocked by policy leaves direct
inbound ICE unavailable and TURN as the fallback. Never broaden the rule to
the Public profile or to any program.

When `SPAWN_TURN_URLS` is present in the health-check service environment,
`scripts/health-check.sh` adds `coturn` to its systemd unit checks and sends a
STUN Binding request to a configured UDP endpoint. The Binding request needs
no TURN secret. Missing Python 3 produces a warning because the dependency-free
probe cannot run; an endpoint that is actually configured but does not answer
is a health failure.

## TURN TLS on 443

`turns:` on TCP 443 is recommended for browsers and phones on networks that
block UDP and non-HTTPS-looking ports. This is an option to provision, not a
claim about current production. It needs a hostname such as
`turn.spawnd.dev`, a certificate and private key for that hostname (the
Let's Encrypt files are suitable), and coturn's `tls-listening-port=443` plus
`cert`/`pkey` settings.

coturn cannot bind TCP 443 while nginx is already bound to TCP 443 on the same
IP. Choose one of these topologies before advertising a `turns:` URL:

- give coturn a second public IP and bind its 443 listener there;
- put an SNI-aware TCP router in front of nginx and coturn, routing the TURN
  hostname to coturn; or
- deploy a TURN-aware gateway such as STUNner in front of the relay.

After provisioning, add `turns:turn.spawnd.dev:443?transport=tcp` for browser
and phone fallback, while retaining the UDP `turn:` entry for daemons. Test
from a network where UDP is blocked before calling the path ready.

## One API worker, for now

Production must run exactly one uvicorn worker. Pin `--workers 1` in the
`spawn-server` unit and keep `--ws-ping-interval 20 --ws-ping-timeout 20`
explicit. Redis already supports cross-worker host-control dispatch, but the
terminal session signalling path and several daemon-facing HTTP routes still
look up daemon ownership in the worker-local broker. With multiple workers, a
browser can report “No daemon is connected” even while the host is online.

The named horizontal-scaling follow-up is to make the terminal session path
resolve the owner through Redis presence and `owner_dispatch`, matching the
host-control path. Do not raise the worker count until that work has shipped
and has a cross-worker signalling test.

## The websocket implementation

uvicorn has two websocket implementations built on the `websockets` library.
Its default, `--ws auto`, picks the legacy one. Production is moving to the
sans-I/O one, `--ws websockets-sansio`. Support log storage refuses to start
without it, because on the legacy implementation a Pong the library sends can
collide with an application write that is waiting to drain. Every place this
repository starts the server already passes the option, so these run what
production will run: the smokes in `scripts/test-all.sh`, the updater tests
and canary cohorts, the native acceptance fixtures and the Windows smoke. The
server's pytest suite drives the app in process through Starlette's test
client, which uses neither implementation; one test drives the sans-I/O
protocol directly (`server/tests/test_support_log_dispatch.py`).
`scripts/check-ws-sansio-launch.sh` fails a launcher without the option. The
production unit is edited by hand, so merging changes nothing there.
[RELEASE.md](RELEASE.md) ("The websocket implementation") has the procedure
and the rollback.

Below is what changes for this server, read from the installed uvicorn 0.46.0
and websockets 16.0. Paths are under `site-packages/`. `legacy` means
`uvicorn/protocols/websockets/websockets_impl.py` and `sans-I/O` means
`uvicorn/protocols/websockets/websockets_sansio_impl.py`. Server paths such
as `ws/daemon.py` are under `server/spawn_server/`. "Measured" means a
throwaway echo app run under both implementations on loopback.

**Message size limit (`--ws-max-size`, 64 MiB in production): same limit,
different reason and memory.** Both apply the limit to each received message,
with fragments counted together. Neither limits what the server sends. Legacy
passes it to the legacy protocol (legacy:100-109). An over-size message fails
the connection with 1009 and an empty reason
(`websockets/legacy/protocol.py:988-990`). The handler then sees a disconnect
with 1006. Sans-I/O passes it to `ServerProtocol` (sans-I/O:88-92). The
parser fails with 1009 and the reason `frame exceeds limit of N bytes`
(`websockets/protocol.py:625-627`). The handler sees 1009 with that reason
(sans-I/O:151-156, 327-336). Measured: legacy sent `1009 ''`, sans-I/O sent
`1009 'frame exceeds limit of 1048576 bytes'`. Memory differs more. Legacy
keeps reading until `--ws-max-queue` (32) complete messages wait for the
handler (`websockets/legacy/protocol.py:947-952`), so one connection can hold
32 messages of up to 64 MiB. Sans-I/O stops reading once a received message
waits for the handler (sans-I/O:247-249) and resumes when the handler takes
it (sans-I/O:472-477). It ignores `--ws-max-queue`. This does not matter to
us: the server closes any text frame over 1,100 KiB itself, with 1009 and
`signaling frame too large` (`ws/daemon.py:2262-2264`,
`ws/browser.py:520-521`).

**Ping and keepalive: same defaults and wire behaviour; liveness now depends on
the handler taking messages.** `--ws-ping-interval` and `--ws-ping-timeout`
both default to 20 seconds (`uvicorn/main.py:158-169`), the values the
section above asks production to pin. Legacy sleeps the interval, sends a Ping
and waits the timeout for the Pong
(`websockets/legacy/protocol.py:1213-1252`). Sans-I/O
sends the first Ping one interval after accept, and each later one an
interval after the last Pong less its round trip (sans-I/O:270-301). On
timeout both send close 1011 `keepalive ping timeout` and close the TCP
connection (sans-I/O:303-314). Measured with a client that never answers:
identical frames from both, Ping at 1 s, close at 2 s, then EOF. The handler
sees 1006 on legacy and 1005 on sans-I/O, and nothing here reads that code.
The difference that matters: sans-I/O reads only while no received message
waits for the handler. Pongs and the daemon's Pings are then not read either.
A handler that spends longer than the ping timeout on one message, while the
peer has sent another, loses the connection with 1011. The daemon sends a Ping
every 15 seconds and reconnects after two unanswered ones
(`daemon/src/run.rs:48`, `daemon/src/ws.rs:513-524`), so it gives up after
30 to 45 seconds. Legacy answered both while up to 32 messages waited.
Handlers normally return to `receive` quickly. The long waits are
daemon registration, which waits on a semaphore with no deadline
(`ws/daemon.py:2311-2312`) and then up to 30 seconds for activation
(`ws/daemon.py:89`), and any handler blocked on a slow database. After the
switch, a host that reconnects in a loop while the database is slow is the
sign to look for.

**Per-message compression: on in both; sans-I/O uses less memory.** It
defaults on (`uvicorn/main.py:172-176`). Legacy offers 15-bit windows and
zlib's default memory level (legacy:96-98). Sans-I/O offers 12-bit windows
both ways and memory level 5 (sans-I/O:79-87). That is a fraction of the
memory per compressed connection, at a slightly worse ratio. Browsers and
phones that offer compression get it either way. The daemon does not offer it,
because tokio-tungstenite is built without it (`daemon/Cargo.toml`).

**Close codes and reasons: same on the wire; `close` no longer waits.** Both
send the handler's code and reason unchanged (legacy:319-323; sans-I/O:437-446
and `websockets/protocol.py:364-388`). Codes must be one of the 1000-range
codes a peer may send, or 3000 to 4999 (`websockets/frames.py:99-112`,
`418-427`). Reasons are limited to 123 UTF-8 bytes, because a control frame
holds 125 (`websockets/frames.py:345-347`). Beyond that, either implementation
raises an error in the handler. The longest reason this server sends is 56
bytes (`ws/host.py:559`). Measured
under both: 1008 `token_revoked` and 4001 `host revoked` arrived unchanged.
The daemon acts on 1008 with `token_*` reasons, 4000, 4002, 4003 and 4010
(`daemon/src/ws.rs:322-351`). It treats 4001 as an ordinary reconnect. Legacy
`close` waits up to 10 seconds for the peer's close frame and then for the TCP
close (`websockets/legacy/protocol.py:720-770`). With more than 32 unread
messages from the peer it cannot read that frame. Measured: in 3 of 5 runs the
peer had no close after 5 seconds. Sans-I/O writes the close frame and closes
the transport at once. Measured: the code and reason arrived in 5 of 5 runs.
The one-second timeouts around `close` (`ws/broker.py:194-197`,
`ws/daemon.py:1433-1435`, `routes/auth.py:269-270`) no longer expire.

**A peer that disappears: different codes and errors; the server handles
both.** Legacy gives the handler a disconnect with 1006 (legacy:362-368).
Sans-I/O gives 1005 (sans-I/O:123-126). A send after the loss raises
`RuntimeError` in both (measured). The message comes from uvicorn on legacy.
On sans-I/O it comes from uvloop, `the handler is closed`. websockets itself
never learns of the loss, so under plain asyncio, as on Windows, such writes
are dropped silently. After the library has closed the connection itself
(keepalive or over-size), a sans-I/O send raises `RuntimeError`
(sans-I/O:469-470).
Every connection object sends through `_send_or_disconnect`
(`ws/broker.py:31-46`), which turns `OSError` and `RuntimeError` into
`WebSocketDisconnect`. The alert pump catches `RuntimeError`
(`ws/alerts.py:305`, `317`). The server never branches on 1005 or 1006.

**A slow peer: legacy waits, sans-I/O buffers without a limit. This
matters.** A legacy send waits for the transport to drain
(legacy:317, `websockets/legacy/protocol.py:1164-1186`). Sans-I/O `send` waits
on an event (sans-I/O:366) that is set at creation (sans-I/O:95-96) and never
cleared, because the protocol has no `pause_writing`. Every send returns at
once and the bytes wait in the transport's buffer. Measured with a client that
stopped reading: legacy took 11 sends of 256 KiB and then hit a 2-second
deadline; sans-I/O took all 64 in 0.01 seconds. So the 2-second send deadlines
(`_bounded_send_text`, `ws/daemon.py:1329-1330`; `request_daemon_update`,
`ws/broker.py:1035`) now bound only the wait for the send lock. They no longer
detect a peer that stopped reading. What this server sends is small:
signalling, pins, events and the 25-second application pings. A stalled peer
also stops answering Pings, so within 40 seconds the server queues close 1011
for it and stops writing to it. Memory growth should therefore be small. But
sans-I/O gives the handler its disconnect only when the buffer has drained or
the TCP connection breaks (sans-I/O:123-126, 303-314). Until then the handler
and its subscriptions stay alive. The proxies in front end the TCP connection
eventually: nginx's 300-second timeouts, then Next. Watch the server's memory
after the switch.

**Subprotocols, headers, `Origin` and the proxy: same for today's clients, with
one trap.** Legacy splits each `Sec-WebSocket-Protocol` header at commas
(legacy:167-169). Sans-I/O passes the raw header values (sans-I/O:210).
Measured: a client offering `spawn.v3` and `spawn.v4` in one header gave
`['spawn.v3', 'spawn.v4']` on legacy and `['spawn.v3, spawn.v4']` on sans-I/O.
Every client offers exactly one name today (`daemon/src/ws.rs:27`,
`web/src/lib/hostControl.ts`, `web/src/lib/alert-socket.ts`,
`mobile/src/data/realtime/socket.ts`), so each endpoint's
`… not in offered` check (`ws/daemon.py:2214`, `ws/browser.py:293`,
`ws/host.py:451`, `ws/alerts.py:262`) sees the same thing. A future release
that has a client offer an old and a new name together would be refused with
`protocol.required` until the server splits the values itself. Both pass the
request headers to the app unchanged (legacy:171-174; sans-I/O:193-196). The
server reads only `authorization` and the `token` query. Neither checks
`Origin`, and neither does the server. Forwarded-address handling is uvicorn's
proxy-headers middleware, which wraps the app outside both.

**Shutdown: same close code; sans-I/O can wait forever.** On SIGTERM uvicorn
stops accepting and calls each connection's `shutdown`
(`uvicorn/server.py:280-283`). It then waits for every connection to close,
with no limit unless `--timeout-graceful-shutdown` is set
(`uvicorn/server.py:285-316`). Legacy fails each connection with 1012
(legacy:143-149). Its close task half-closes the TCP connection and aborts it
after at most 2 × 10 seconds (`websockets/legacy/protocol.py:1260-1341`).
Sans-I/O gives the handler 1012 at once, sends close 1012 and closes the
transport (sans-I/O:140-149). It never aborts, so a transport with unsent bytes
stays open until they drain. Both send 1012 with an empty reason before the
handler's own close, so `server restart` never reaches a peer. The daemon
reconnects on 1012. Measured with a client that had stopped reading: legacy
exited 20.1 seconds after SIGTERM, and sans-I/O was still running after 30
seconds. With no unsent bytes, the usual case behind Next's proxy, both close
at once. The risk is a deploy restart that waits for the unit's stop timeout.
`--timeout-graceful-shutdown` would bound it and is not part of this change.

## Protocol horizon

WebTransport signalling and MASQUE relays are watch-only, not planned work.
WebTransport is the credible HTTP/3 successor to watch for signalling, but
[current guidance](https://ably.com/blog/can-webtransport-replace-websockets)
still favors WebSockets for this application. MASQUE's
[CONNECT-UDP](https://http.dev/masque) and emerging relay patterns are the
potential long-term exit from TURN's awkward TCP/TLS topology, with
[MASQUE relays](https://smallstep.com/blog/masque-relays-vs-vpns/) already
demonstrating the shape. Neither changes the production contract above until
browser, daemon-library, proxy, and operational support are mature enough to
replace a path end to end.
