# spawnd connection-layer review (daemon/src/ws.rs, run.rs, rtc.rs)

Branch `native-daemon-fixes-auto-update-daemon`, read-only, 2026-08-25.
Library facts were checked against the vendored sources in
`~/.cargo/registry/.../webrtc-0.17.1`, `webrtc-ice-0.17.1`, `webrtc-sctp-0.17.1`,
`tokio-tungstenite-0.24.0`. Line numbers for `ws.rs` refer to the file as first
read; another stream edited it mid-review (it now carries a `ProtocolRequired`
error and a 4003 close-code check), so offsets there are ~+13.

No P0. Nothing prevents a connection on an ordinary home/office UDP network.
The P1s are about what happens on the *second* connection: after a server
deploy, a laptop lid, a Wi-Fi to Ethernet switch, a UDP-blocked office, or a
slow phone link.

---

## (A) Findings

### P1-1  A control-WS drop tears down every live terminal, and re-establishing takes minutes

**What the code does.** When the WS session ends for any ordinary reason,
`serve_one_connection_with_loader` runs `rtc_sessions.close_all()`
(`run.rs:819-822`), which deactivates and closes every session peer and host
peer (`rtc.rs:1579-1637`). Independently, every status emission goes through
`send_session_peer_status`, which closes the peer if `try_send_status` fails
(`rtc.rs:1344-1351`), and the `out_tx` captured in the callbacks dies with the
socket. So the DTLS/SCTP path, which is peer-to-peer and does not need the
server, is killed whenever the server link blinks.

Recovery then chains three timers: the daemon notices the dead WS only through
`READ_IDLE_TIMEOUT = 75s` (`ws.rs:197`; server acks each heartbeat at
`server/spawn_server/ws/daemon.py:1533`, so an idle link legitimately sees a
frame every 30 s), reconnects after backoff, re-registers; the browser has
meanwhile received `unavailable` from the server (`daemon.py:1082-1103`), torn
down, and is on its own 5 s to 60 s retry ladder
(`web/src/components/terminal/useSessionSocket.ts:141-147, 404-416`). A 10 s
server deploy or a host network switch therefore costs every user roughly 1 to
2 minutes of frozen terminals, and 100% of sessions reconnect at once.

**Why it matters.** This is the single biggest reliability item for "works
across networks": every host-side mobility event (sleep/wake, VPN up/down,
Wi-Fi roam that changes the IP) manifests as a WS drop first, and today a WS
drop equals a terminal outage even when ICE would have survived (NAT bindings
live ~30 s+, and TURN allocations survive independently).

**Proposed fix.**
1. Stop calling `close_all()` on ordinary socket end. Keep
   `invalidate_trust_and_close_all()` for credential/revocation changes only.
   Make the WS sender swappable the way `install_session_sinks` already does
   for forwarders: hold `Arc<ArcSwapOption<mpsc::Sender<WsOutbound>>>` (or a
   `watch`) in `RtcSessions`, install on connect, clear on disconnect, and have
   `try_send_status`/`send_json` read through it.
2. Treat a status that could not be sent as *deferred*, not fatal: record the
   last status per peer and re-announce on reconnect (like
   `control.resend_foreground`), so the server converges.
3. Distinguish `TrySendError::Full` from `Closed` in `try_send_status`
   (`rtc.rs:3408`); a momentarily full 1024-slot channel must not kill a
   freshly connected peer.
4. Server side (out of this review's scope but required): give a host a grace
   window before pushing `unavailable` to bound browsers, and accept a
   re-`register` that lists live RTC bindings.

### P1-2  Half-open detection is 75 s, there is no ICE restart, and wss has no TCP keepalive

**What the code does.**
- The daemon never sends WS Ping; `Message::Pong` is ignored for liveness
  (`ws.rs:166`). Liveness is inferred only from the 30 s heartbeat ack and the
  75 s read-idle budget (`ws.rs:197-228`).
- For `wss://` (production) it calls `connect_async_with_config` (`ws.rs:87-95`),
  which opens its own TCP socket, so `configure_keepalive` (`ws.rs:116-126`)
  is applied only on the `ws://` dev path. The comment says a TLS upgrade on a
  pre-connected stream needs tokio-rustls directly; it does not:
  `tokio_tungstenite::client_async_tls_with_config` exists in 0.24 with the
  `rustls-tls-webpki-roots` feature (`tokio-tungstenite-0.24.0/src/tls.rs:189`).
- ICE restart is not supported: `create_answer` refuses an offer whose
  `signal_id` already exists (`rtc.rs:724-753`, "rtc session admission
  rejected") and `negotiate` (`rtc.rs:1693-1707`) only ever runs on a fresh
  peer connection. webrtc-rs 0.17 does handle a remote-initiated ICE restart in
  `set_remote_description` (`webrtc-0.17.1/src/peer_connection/mod.rs:1516-1531`),
  so the library is not the blocker. Both clients currently mint a fresh signal
  id per attempt (`useSessionSocket.ts:428-430`), i.e. every recovery is a full
  new DTLS + SCTP + TURN allocation.
- ICE timeouts are the webrtc-ice defaults (disconnected 5 s, failed 25 s,
  keepalive 2 s; `webrtc-ice-0.17.1/src/agent/agent_config.rs:17-23`); the daemon
  adds `RTC_DISCONNECTED_GRACE = 15s` (`rtc.rs:82`) before closing.

**Why it matters.** After a host network switch the selected pair dies; the
daemon gives up the peer at ~20 s (disconnected + grace), but it cannot tell
anyone for up to 75 s because signalling rides the dead WS, and even once
reconnected the browser must rebuild everything from scratch. With an ICE
restart on the existing peer connection the same event costs one STUN round
trip. Tokio's timers use a monotonic clock that stops during suspend, so after
lid-open the 75 s budget resumes from where it was; detection is bounded but
still up to 75 s.

**Proposed fix.**
1. `ws.rs`: TCP-connect manually for both schemes (with the timeout from P1-3),
   `set_nodelay(true)`, keepalive, then `client_async_tls_with_config(req, tcp,
   Some(cfg), None)` for wss. Delete the "deferred until wss" comment.
2. Application ping: send `Message::Ping` every 15 s from the heartbeat task
   and count Pongs in `run_reader_loop` as liveness (they are proof the inbound
   path is alive; the current comment's worry about auto-pongs applies to
   *server* pings, not to pongs answering ours). Two missed pongs -> end the
   session. That takes detection from 75 s to ~30 s without touching the
   server.
3. ICE restart: in `create_answer`, when `peers` already holds `signal_id` with
   the same generation and the offer's ufrag differs, route to the existing
   `pc.set_remote_description` + `create_answer` + `set_local_description`
   instead of rejecting; keep the reject for a true collision (different
   generation or same ufrag). Needs the client to reuse the signal id with
   `restartIce()`; today's behaviour keeps working unchanged.
4. Optional: subscribe to route/interface change events (netlink on Linux,
   `SCNetworkReachability`/`nw_path_monitor` on macOS) and reconnect the WS
   immediately instead of waiting for the idle budget.

### P1-3  No connect timeout; a black-holed path hangs the supervisor forever

**What the code does.** `ws::connect` does DNS + TCP + TLS + HTTP upgrade with
no deadline (`ws.rs:60-62`, `92-95`), and the only other arm of the `select!`
in `serve_one_connection_with_loader` is the credential watcher
(`run.rs:643-653`). `TcpStream::connect((host, port))` and tokio-tungstenite's
internal connect both try resolved addresses sequentially with the OS SYN
timeout (~75 s macOS, ~130 s Linux) per address.

**Why it matters.** A captive portal that accepts TCP and never answers TLS, a
middlebox that black-holes, or a home network that advertises IPv6 without
upstream (AAAA tried first, SYNs dropped) leaves the daemon stuck in
"connecting" indefinitely or for minutes per attempt. The host shows offline
until someone restarts spawnd.

**Proposed fix.** Wrap the whole `ws::connect` in
`tokio::time::timeout(Duration::from_secs(20), ...)` in
`serve_one_connection_with_loader` (count it as an error for backoff). Inside
`connect`, resolve with `tokio::net::lookup_host` under its own 5 s timeout and
attempt each address with a 5 s connect timeout (Happy-Eyeballs-lite: try v6
and v4 alternately). This also bounds the blocking `getaddrinfo` thread.

### P1-4  TURN fallback on the daemon is UDP-only; no ICE-TCP, no TURN-TCP, no TURNS

**What the code does.** `RtcIceServerConfig` maps 1:1 onto
`RTCIceServer { urls, username, credential }` (`rtc.rs:3192-3198`; correct for
0.17, which has no `credential_type`). But webrtc-ice 0.17.1 gathers relay
candidates only for `turn:` over UDP
(`webrtc-ice-0.17.1/src/agent/agent_gather.rs:777-801`); `turn:...?transport=tcp`
and `turns:` hit the `else` branch, log "Unable to handle URL", and are skipped.
ICE-TCP is absent (`supported_network_types()` = Udp4/Udp6,
`network_type/mod.rs:17-18`; `TCPMux` is a TODO in
`webrtc-0.17.1/src/ice_transport/ice_gatherer.rs`). Relay sockets bind
`0.0.0.0:0` only (IPv4). And because spawnd does not bridge the `log` crate
into `tracing` (no `LogTracer` anywhere in `daemon/src`), the warning never
reaches a log file.

**Why it matters.** A host on a corporate/guest network that drops outbound UDP
has no path at all, silently. An operator who configures only
`turns:host:5349?transport=tcp` (the usual "works behind everything" choice)
gets zero relay candidates from every daemon, which in relay-only mode means
zero candidates. Browsers support all of these, so the asymmetry is easy to
miss in testing from the browser side.

**Proposed fix.** Short term: document that `turn_url_list` must include a UDP
`turn:` URI and that spawnd hosts need outbound UDP; validate that in the
server's settings loader and warn. Medium term: bridge `log` to `tracing`
(P3-4) so the gap is visible; track webrtc-rs for TURN-TCP (`turn` crate
already has a TCP-capable `Conn` shape in newer versions) or carry a small
patch in `agent_gather.rs` for the `Tcp && Turn` case.

### P1-5  Slow viewers and 2 s stalls kill the session instead of shedding output

**What the code does.** In release builds webrtc-sctp's pending queue is
128 KiB per association (`webrtc-sctp-0.17.1/src/queue/pending_queue.rs:16-17`;
the 128 MiB figure is `cfg(test)`), so `dc.send` blocks as soon as ~128 KiB is
unsent. The PTY sender wraps each 16 KiB send in `DATA_CHANNEL_SEND_TIMEOUT =
2s` and on timeout stops, deactivates and closes the peer (`rtc.rs:87`,
`2198-2225`); the control sender does the same for 48 KiB replay chunks
(`rtc.rs:2334-2356`, `session_ctl.rs:19`). Upstream of that, the forwarder's
direct sink is `128 x 16 KiB` and on overflow flips `disconnected`
(`pty.rs:723-731`), which the sender loop turns into a peer close
(`rtc.rs:2176-2183`).

**Why it matters.** A build log or `cat` on a phone over TURN (or any link
under ~10 KiB/s, or any 2 s hiccup while output is flowing) closes the data
channels; the browser sees `onclose`, sends `rtc.close`, waits 5-60 s, and
rebuilds ICE/DTLS, only to hit the same wall. ICE itself would have tolerated
a 5-25 s stall. The client already supports offset-anchored replay, so
dropping backlog is safe; closing is not.

**Proposed fix.**
1. Remove the 2 s send timeouts (or raise them above `RTC_DISCONNECTED_GRACE`)
   and let ICE state + `dc.on_close` decide liveness.
2. Pace with the channel's own accounting: `dc.buffered_amount()`,
   `dc.set_buffered_amount_low_threshold(64 KiB)`, `dc.on_buffered_amount_low`
   (all present on `RTCDataChannel` in 0.17), sending only while
   `buffered_amount < high_water`.
3. On direct-sink overflow, do not close the peer: drop the backlog, emit a
   `spawn.ctl` event equivalent to the history pump's `history_gap`
   (`rtc.rs:2919-2926`) carrying the new PTY offset, re-add the sink, and let
   the client re-snapshot. This needs a small client change in web and mobile.

### P1-6  Backoff resets to 1 s on any "clean" close, with no jitter

**What the code does.** `attempt = 0` whenever the session ends `Ok(())`
(`run.rs:543-547`), and a reader/sender/heartbeat task ending is reported as
`Ok(())` (`run.rs:782-793`). `backoff_for_attempt` is 1,2,4,...,60 s with no
jitter (`ws.rs:267-270`). So any accept-then-close from the server
(4003 `protocol.required`, 4000 `superseded`, 4002, 1009, activation deadline,
`_fence_superseded_daemon`) produces a 1 Hz reconnect with a full TLS handshake
forever. Two daemons sharing one credential (a cloned VM) supersede each other
at 1 Hz indefinitely. After a server restart every host reconnects on the same
1-2-4 s ladder in lockstep.

**Why it matters.** Fleet-wide, this is a self-inflicted DoS on the server
after any protocol bump or credential clone. The 4003 case is being handled by
another stream (confirmed: `ws.rs` now has `ProtocolRequired` and checks the
4003 close code), but the general shape remains.

**Proposed fix.** Reset `attempt` only after a session that reached
`Inbound::Registered` and lasted more than, say, 60 s; count short-lived
sessions as failures. Add +/-25% jitter to `backoff_for_attempt`. Keep the 60 s
cap. For a permanent refusal (protocol required, superseded twice in a row) go
to the cap immediately and log once at error level.

### P2-1  Nagle is on for the signalling socket

`connect_async_with_config(req, cfg, false)` keeps Nagle enabled
(`ws.rs:92`; `tokio-tungstenite-0.24.0/src/connect.rs:42-47`), and the `ws://`
path never calls `set_nodelay` either. The answer and each trickled candidate
are small writes in a burst; with delayed ACK on the server each one after the
first can wait tens to hundreds of ms. Fix: `tcp.set_nodelay(true)` in
`connect` once P1-2's manual connect is in place (or pass `true`).

### P2-2  Session peers ignore `ice_transport_policy`; offers carrying it are silently dropped

`run.rs:1599` runs the session path only when `ice_transport_policy.is_none()`,
otherwise falls through with no log and no `rtc.status`; `create_answer`
builds `RTCConfiguration { ice_servers, ..Default::default() }`
(`rtc.rs:681-684`) so session peers are always `All`. Host peers honour it
(`rtc.rs:917`, `parse_ice_transport_policy` at `rtc.rs:3200-3206`). The server
knows and withholds the field on session offers
(`server/spawn_server/ws/browser.py:66-79`). In a relay-only deployment the
daemon still gathers and sends host + srflx candidates for terminals, so the
operator's "everything through the relay" statement is not honoured for the
channel that matters most, LAN addresses leak into signalling, and the
daemon does STUN work it will not use. Fix: bump `SESSION_RTC_PROTOCOL_VERSION`
(or add a differently named field) so the server can send the policy to
capable daemons; parse it in the session path exactly like the host path and
pass it to `RTCConfiguration`. Also log the drop at warn.

### P2-3  Candidate hygiene: link-local and virtual-interface host candidates

webrtc-ice's `local_interfaces` only drops loopback
(`webrtc-ice-0.17.1/src/util/mod.rs:117-136`); spawnd sets no `ip_filter`, and
its interface filter covers only `docker*`, `br-*`, `veth*`, `lo`
(`rtc.rs:670-675`, duplicated at `904-909`). Every `fe80::` and `169.254.x`
address on every interface (macOS: `awdl0`, `llw0`, `anpi*`, `utun*`, `en*`)
becomes a host candidate: one UDP socket each, a STUN transaction each, and one
WS frame each (serialised behind Nagle, P2-1). Fix: one shared
`fn setting_engine() -> SettingEngine` used by both paths;
`set_ip_filter(|ip| !is_link_local(ip))`; extend the name filter with
`awdl`, `llw`, `anpi`, `bridge`, `vmnet`, `virbr`, `zt`. Keep `utun*`/`wg*`/
`tailscale*` (a VPN can be the only direct path).

### P2-4  mDNS disabled: LAN direct depends on the host firewall

`set_ice_multicast_dns_mode(Disabled)` (`rtc.rs:667`, `903`) is justified by a
real fd leak, but the consequence is that every browser host candidate
(`xxxx.local`) is dropped on arrival
(`webrtc-ice-0.17.1/src/agent/mod.rs:277-284`). LAN direct still works when the
browser's check reaches the daemon's host candidate (daemon learns a prflx
peer). It does not work when the host runs a default-deny inbound firewall
(ufw, macOS stealth mode, corporate EDR): the daemon never sends the first
packet toward the browser's LAN IP, so the unsolicited check is dropped, and
the pair falls back to srflx hairpin (unsupported on many home routers) or
TURN. Fix: pin an ephemeral range via
`set_udp_network(UDPNetwork::Ephemeral(EphemeralUDP::new(min, max)))` and
document the firewall rule; re-evaluate `QueryOnly` when the upstream leak is
fixed. `set_nat_1to1_ips` is not needed (srflx covers cloud VMs).

### P2-5  The dispatch loop is the global serialiser for signalling

`handle_offer(...).await` (`run.rs:1606-1615`), `rtc_sessions.close(...).await`
(`run.rs:1766-1768`, waits up to `UPLOAD_CLOSE_TIMEOUT = 2s` in
`deactivate_peer_until`, `rtc.rs:1556`) and
`invalidate_trust_and_close_all().await` (`run.rs:1358`, `1395`; sequential per
peer while holding `admission`, `rtc.rs:1644-1669`) all run inline in the single
inbound loop. With N browsers, one tab closing can hold every other tab's
candidates for up to 2 s; a pin push with 20 peers can stall the control plane
for tens of seconds; the 256-slot `in_rx` then back-pressures the reader. Fix:
spawn a task per `signal_id` (keyed map of `mpsc::UnboundedSender<RtcFrame>`)
so per-peer ordering is kept but peers do not block each other; keep the
dispatch loop free of `.await`s that can take longer than a few ms.

### P2-6  Corporate networks: no proxy support, webpki roots only

Cargo pins `rustls-tls-webpki-roots` (`daemon/Cargo.toml:27`) and nothing reads
`HTTPS_PROXY`. A TLS-intercepting corporate proxy fails certificate validation
(arguably desirable) and a CONNECT-only egress cannot dial at all (not
desirable; the browser next to it works). Fix: `rustls-tls-native-roots` (or
both), and an opt-in `SPAWN_HTTPS_PROXY`/`HTTPS_PROXY` CONNECT tunnel before
the TLS upgrade. Note TURN still needs UDP (P1-4).

### P2-7  Connection failures are logged class-free; webrtc-rs logs are dropped

`run.rs:548-554` logs "session ended with error" with no cause, and `ws.rs`
deliberately strips tungstenite text. webrtc-rs uses the `log` crate and
nothing bridges it, so TURN/mDNS/gather warnings vanish. Field triage ("is it
DNS, TLS, 403, or TURN?") is impossible from logs. Fix: classify the anyhow
chain by the contexts you control (`tcp connect`, `ws connect (tls)`,
`ws handshake`, timeout, `ProtocolRequired`) and log the class; install
`tracing_log::LogTracer` at warn level (webrtc warn lines can contain candidate
addresses; that is acceptable at warn, or add a filter layer).

### P3-1  Per-offer `MediaEngine` + `register_default_codecs` + `APIBuilder`

`rtc.rs:655-679` and `898-913` rebuild the API and register audio/video codecs
for a data-only peer. Cheap but pointless; build one `API` per
`SettingEngine` at startup.

### P3-2  Worker barriers on open are 3 s

`rtc.rs:2037-2038` (replay barrier) and `2072-2078` (`wait_source_offset`) fail
the peer with `failed` after 3 s; under heavy output or a loaded host that can
trip and cost a full reconnect. Consider 10 s, matching the replay capture.

### P3-3  `warn!(error = %e, "rtc offer failed")` can carry SDP parse text

`rtc.rs:624-628`: the sdp crate's syntax errors quote the offending line, which
can be a `c=`/`a=candidate` line. Log the class at warn and the text at debug.

### P3-4  ICE server list: no daemon-side validation; one bad entry fails the offer

Schemes are validated by webrtc-rs (`stun`/`stuns`/`turn`/`turns` only), and a
TURN entry without both username and credential makes `new_peer_connection`
fail (`webrtc-0.17.1/src/ice_transport/ice_server.rs:35-40`) so the whole offer
fails (`rtc.rs:680-687`). Arbitrary hosts are accepted; that is inherent to the
trust model (the control plane already relays signalling, TURN sees ciphertext
only, TRUST.md). `ice_transport_policy` is not a downgrade vector: the daemon
default is already `All`, and `relay` only restricts. Consider skipping
malformed entries with a warning rather than failing the offer. TURN
credentials have a 24 h TTL; a relay session older than that dies at refresh
with no restart path (see P1-2).

### P3-5  End-of-candidates is never signalled

`rtc.rs:1718-1720` returns on `None`. Browsers cope; sending
`{candidate: ""}` would let the client finish gathering-state bookkeeping.

### P3-6  4003 `protocol.required` loops at 1 Hz (confirmed; in progress elsewhere)

`Inbound` has no `protocol.required` variant, so the frame is a
`MalformedJson` warn followed by `Closed`, `Ok(())`, `attempt = 0`, 1 s. The
edit landing in `ws.rs` (close-code 4003 -> `ProtocolRequired`) addresses it;
P1-6 covers the general shape.

### P3-7  Credential re-poll every 500 ms for the daemon's lifetime

`run.rs:55`, `428-451`: a blocking credential read twice a second on every host
forever. Not a connection issue, but it is constant IO/keyring work.

---

## (B) What is already good; do not regress

- Trickle ICE in both directions; the answer is sent right after
  `set_local_description` with no gathering wait (`rtc.rs:1693-1707`,
  `829-842`). Signing is ed25519 and adds nothing measurable.
- Both clients buffer remote candidates that arrive before the answer
  (`useSessionSocket.ts:1436-1440`, `mobile/.../worker-transport.js:226`) and
  mint a fresh signal id per attempt, so the daemon's answer/candidate ordering
  race is harmless and same-id collisions do not occur today.
- ICE server mapping is right for webrtc-rs 0.17 (`urls/username/credential`,
  no `credential_type`); host-scope offers honour `relay`.
- Unreliable/unordered channels are rejected; both channels are required
  within 10 s; unknown labels close the peer (`rtc.rs:1823-1894`).
- Reaper for never-connected (30 s), failed (immediate) and disconnected
  (+15 s) peers uses weak refs so handlers do not pin sockets
  (`rtc.rs:1111-1203`); close paths are deadline-bounded.
- Generation fencing (`fence` RwLock, `close_for_session`, `session_closer`)
  is careful about backend replacement races.
- WS ingress is content-free in logs; subprotocol pinned; bearer auth in a
  header; binary frames refused.
- Heartbeats are acked by the server, so the read-idle timeout is meaningful.
  DNS is re-resolved on every attempt.
- All data-channel payloads are below the 64 KiB SCTP default
  (16 KiB pty chunks, 48 KiB ctl chunks, 8 KiB history fragments).
- DTLS is standard: per-peer certificate, fingerprint verification left on, SDP
  bound by the signed envelope on both sides.

## (C) Open questions

1. What does the server do with browser offers/candidates while a host's WS is
   down: queue them until re-register, or drop them? (Shapes P1-1.)
2. Does the server retire the session binding the instant the daemon WS drops
   (`daemon.py:1082-1103` suggests yes)? P1-1 needs a grace window there.
3. Production `turn_url_list`: UDP `turn:` present? coturn reachable over
   IPv6? (P1-4.)
4. Is there any `log`->`tracing` bridge I missed outside `daemon/src`? I found
   none (no `LogTracer`, no `tracing-log` in Cargo.toml).
5. Was the mDNS fd leak reproduced on 0.17.1 specifically, and is it fixed in
   0.18+? If so, `QueryOnly` should come back (P2-4).
6. After `rtc.status unavailable` does the browser wait for host presence
   before retrying, or does it keep the backoff ladder running? Determines how
   fast P1-1 recovery is once the daemon side is fixed.

## Time-to-first-byte sketch (lens 3)

Browser signs and sends offer (0.5 RTT to server) -> relay to daemon (0.5) ->
daemon verify + PC build + answer + sign (~5-20 ms CPU, inline in the dispatch
loop) -> answer back (1 RTT via server) -> candidates trickle both ways (each
frame paying Nagle, P2-1) -> ICE checks (webrtc-ice paces its own checks at
200 ms, `agent_config.rs:14`; as the controlled side the daemon accepts the
browser's nomination immediately) -> DTLS (1-2 RTT) -> SCTP INIT/COOKIE (2 RTT)
-> DCEP open (1 RTT) -> daemon `on_open`: worker replay barrier + source-offset
wait (3 s caps) + `connected` status over WS -> browser requests snapshot over
`spawn.ctl` (1 p2p RTT) -> worker capture (10 s cap) -> 48 KiB chunks. Roughly
7-9 network round trips plus two worker barriers; nothing is blocked on
gathering or signing. The avoidable costs are Nagle on the control socket and
the head-of-line blocking in the dispatch loop under concurrency.
