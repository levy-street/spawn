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
- The coturn UDP relay range. The default is 49152–65535; if production pins
  `min-port`/`max-port`, open that exact range and keep config and firewall in
  lockstep.
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
