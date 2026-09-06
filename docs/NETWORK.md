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
realm `spawnd.dev`, and `external-ip=98.83.222.112/10.0.0.127`. There is no
TURN TLS listener today. As read on 2026-09-06, its relay range is pinned to
`min-port=49160`/`max-port=49360`; the credential and allocation lifetimes it
runs with are in "Relay credential and allocation lifetimes" below.

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
SPAWN_TURN_URLS=turn:98.83.222.112:3478?transport=udp,turn:98.83.222.112:3478?transport=tcp
SPAWN_TURN_SECRET=<same random secret as coturn static-auth-secret>
```

An ordinary UDP `turn:` URL is mandatory. The daemon uses webrtc-rs 0.17,
which cannot use TURN over TCP or TLS, so a list containing only
`?transport=tcp` or `turns:` strands daemons behind restrictive NAT. Keep UDP
3478 reachable, even after adding transports for browsers and phones. TCP
3478 is useful to those clients but does not replace UDP for the daemon.

Allow both listener traffic and relay allocations in the host/cloud firewall:

- UDP 3478 and TCP 3478 to coturn.
- The coturn UDP relay range. coturn's default is 49152–65535; production
  pins `min-port=49160`/`max-port=49360` today, so that exact range is what
  the relay's security group admits. Config and firewall move in lockstep:
  widen the group first, then the config, then restart coturn.
- UDP 50000–50100 inbound on each daemon machine where LAN/direct WebRTC is
  expected. This is the daemon's ephemeral candidate range, not coturn's relay
  range. Host firewalls may restrict it to trusted LANs when off-LAN traffic
  can fall back to TURN.

For example, a daemon host using UFW can admit direct candidates from a
`192.168.1.0/24` LAN with:

```bash
sudo ufw allow from 192.168.1.0/24 to any port 50000:50100 proto udp
```

Add the equivalent inbound rule to any host or cloud firewall in front of that
machine; use a broader source only when direct Internet candidates are
intended.

## Relay credential and allocation lifetimes

Two values found on 2026-09-05, when a day of `journalctl -u coturn` on the
relay held around 9,000 `check_stun_auth: Cannot find credentials of user`
rejections and thousands of `create_relay_ioa_sockets: no available ports`
(issue #71):

```dotenv
# /opt/spawn/server/.env
SPAWN_TURN_TTL_SECONDS=604800
```

```
# /etc/turnserver.conf
max-allocate-lifetime=180
```

**The credential lifetime is seven days.** A TURN credential is `expiry:user_id`
signed with the shared secret, minted into every `rtc.config` and every session
offer. coturn checks the expiry on every allocation refresh and permission
request, not only at allocation, so a peer connection that outlives its
credential loses its relay allocation at the cliff and every relayed pane on
it drops. Browsers and phones now refresh the terminal's credential an hour
before expiry with a non-disruptive ICE restart on the same peer connection
(the host control channel — files, the launcher — still refreshes only when
it rebuilds for another reason, and drops at its cliff; that is a
follow-up). The restart is only accepted from a signed offer: the daemon
pins a peer to the key that offered it and refuses a restart without one, so
on a deployment that still allows raw, unpinned signalling the refresh falls
back to the rebuild the failure paths already do. The daemon cannot —
webrtc-rs builds its ICE agent once, from the servers in the first offer,
and a restart re-gathers with those same credentials — so its own relay
allocation still dies at its cliff: a pair that runs through the browser's
relay survives on the browser's fresh allocation, while one that runs
through the daemon's relay (a daemon behind a symmetric NAT, or relay to
relay) drops there and reconnects. The lifetime is the daemon's only
protection, and seven days keeps that cliff past any realistic pane. The
server's default is the same seven days, so the env line documents rather
than changes. The cost of a long window is that a leaked credential can
allocate relay for longer; the relay carries only DTLS ciphertext between
peers, so that exposure is bandwidth, never content.

**An allocation lives three minutes.** Every peer connection on both sides
allocates one relay port for the allocation's lifetime even when the pair
that wins is direct, and clients ask for ten minutes. A client that dies —
or whose credential expired — stops refreshing, and its port sat in the
200-port pool for the rest of those ten minutes while every reconnecting
pane re-gathered into it; `no available ports` fed the reconnect storm that
produced it. `max-allocate-lifetime=180` caps what coturn grants; both
clients refresh well inside it (Chrome and WebKit at lifetime minus 60 s,
webrtc-rs at half the lifetime), so a live connection notices nothing and a
dead one frees its port in three minutes. Changing either coturn value
needs a coturn restart, which drops every relayed pane once; they reconnect
on their own.

**The range is still 200 ports.** Widening `min-port`/`max-port` to
49152–65535 waits on the relay's security group (`spawn-turn-access`), which
the instance role cannot read or change; when that is done the config
follows, with one more coturn restart, and the firewall bullet above changes
with it.

## Windows Firewall

On native Windows, `spawnd.exe` is the only SPAWN D program that binds the
direct WebRTC candidate range, UDP 50000–50100. The per-user installer neither
elevates nor silently creates a firewall rule. When inbound direct ICE is
blocked, the daemon can still use ordinary outbound UDP to the configured TURN
service.

An administrator who explicitly wants direct candidates on a Private network
may add this program-scoped rule for the installed daemon:

```powershell
$spawnd = Join-Path $env:LOCALAPPDATA 'spawn\bin\spawnd.exe'
New-NetFirewallRule -DisplayName 'SPAWN D direct WebRTC (Private)' `
  -Direction Inbound -Action Allow -Profile Private -Program $spawnd `
  -Protocol UDP -LocalPort 50000-50100

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

A relay that answers STUN can still be refusing every allocation, so wherever
coturn is — named in the unit list, or simply installed as `coturn.service`
on the host — the same run reads the last hour of `journalctl -u coturn` and
counts its two failure signatures. Any `create_relay_ioa_sockets: no available
ports` is a failure: the relay pool is full and a new relayed connection just
failed. `check_stun_auth: Cannot find credentials of user` is coturn refusing
an expired credential; up to `SPAWN_HEALTH_TURN_REJECTIONS_MAX` an hour
(default 30) is a client that reconnected with a credential the relay had
just expired, and more is a client presenting expired credentials on every
reconnect, the loop that produced around 9,000 in a day on 2026-09-05. A
host where the journal is not readable — journalctl still exits 0 there and
only hints on stderr, so the script reads the hint — gets a warning naming
it, not a failure; a host with no coturn at all skips the row.
`scripts/health-check.sh --self-test` exercises the counting, the thresholds,
the access check and the gating against fixtures.

The STUN probe, unlike the relay row, needs `SPAWN_TURN_URLS` in the timer's
environment, and as read on 2026-09-06 production's `spawn-health.service`
carries no environment at all, so that probe has never run from the timer
there. A drop-in with `Environment=SPAWN_TURN_URLS=<the server's value>`
turns it on; the relay row does not wait for it.

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
