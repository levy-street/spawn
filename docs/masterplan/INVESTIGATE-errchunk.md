# INVESTIGATE — ErrChunk / SCTP session death

Read-only root-cause investigation. No files in the repo were changed.

---

## 1. Verdict (one paragraph)

**`failed to handle_inbound: ErrChunk` does not mean a chunk failed to parse. In
webrtc-sctp 0.17.1 the bare `Error::ErrChunk` is returned from exactly one place
— when the daemon *receives* an SCTP **ABORT** chunk from the peer (its `Display`
text is literally "abort chunk, with following errors").** So every ErrChunk is
the browser/phone's own SCTP stack (usrsctp) deciding to tear the association
down and telling the daemon so. The daemon's SCTP is not misbehaving on parse;
the peer is aborting. A browser aborts an established association almost only when
*its own* outbound DATA exhausts its retransmit limit (~10 T3-rtx) on a chunk the
daemon never acknowledges. The single mechanism in webrtc-sctp 0.17.x that
produces exactly that is the **receiver-side zero-window / gap-at-full-buffer
deadlock (upstream issue #822)**: a large multi-fragment inbound message (a
paste — see web P1-4) loses one fragment on the lossy, high-RTT NZ-mobile→US-TURN
relay path; the surviving fragments pin the reassembly buffer so the receiver
window credit sticks at 0; the retransmitted missing fragment is then *dropped by
the daemon on every retry* because the buffer-full branch only re-admits a
gap-filler strictly below the highest queued TSN, not the next-in-sequence chunk;
the browser retransmits it forever, gives up, and sends ABORT. **My confidence
that the cause is "SCTP-over-relay receiver robustness in webrtc-sctp 0.17, not a
parse bug and not an oversized daemon send" is high; my confidence in the exact
attribution to #822 (vs. the closely related MTU bug #806) is medium**, because
the daemon logs neither SCTP internals nor the selected candidate pair, so the
final fragment-drop step is inferred from code + upstream + the relay/mobile
correlation rather than seen in a log line.

---

## 2. Evidence

### 2a. What ErrChunk actually is (code-proven)

Vendored `webrtc-sctp-0.17.1`:

- `src/error.rs:161` → `#[error("abort chunk, with following errors")] ErrChunk`.
- `src/association/association_internal.rs:2181-2182` — the **only** site that
  returns the bare `Error::ErrChunk`:
  ```rust
  } else if chunk_any.downcast_ref::<ChunkAbort>().is_some() {
      return Err(Error::ErrChunk);
  ```
- `handle_inbound` (`association_internal.rs:340-370`) treats a malformed packet
  as non-fatal (`Packet::unmarshal` err → `log::warn!("unable to parse SCTP
  packet")` → `return Ok(())`; `check_packet` err → warn → `Ok(())`). Per-chunk,
  only `Err(ErrChunk)` propagates as fatal; every other chunk error is
  `log::warn!("failed to handle chunk")` and processing continues. The inline
  comment says it outright: *"the only condition that is fatal is a ABORT chunk."*
- `src/association/mod.rs:445-450` — when `handle_inbound` returns that error the
  read loop logs `failed to handle_inbound: {err:?}`, sets `done=true`, and closes
  the association. That is the log line we see, followed by `SessionSRTP has been
  closed` and teardown.

So **oversized / malformed / mis-ordered inbound chunks do NOT produce ErrChunk**
— they are logged-and-skipped. ErrChunk == received ABORT, full stop.

### 2b. The daemon cannot be sending an oversized message (rules out one hypothesis)

- `webrtc-sctp-0.17.1/src/stream/mod.rs:288-289`: `if p.len() >
  max_message_size … return Err(Error::ErrOutboundPacketTooLarge)`. Send-side is
  enforced.
- The daemon uses the default `SettingEngine` (`daemon/src/rtc.rs:659,676`,
  `:902,910`) → association `max_message_size = DEFAULT_MAX_MESSAGE_SIZE = 65536`
  (`association/mod.rs:61`, `association_internal.rs:105-106`).
- The daemon's PTY sender (`rtc.rs:2199-2207`) calls `dc.send(chunk)` and, on
  `Err`, `break`s. So the daemon physically cannot put a >64 KiB message on the
  wire; if it tried it would fail locally, not reach the browser. **The browser is
  not aborting because the daemon sent something too big.**

### 2c. Prod log statistics

Source: `~/.local/state/spawn/22c6d0a3/spawnd.err.log` on this Mac (the daemon
runs on end-user machines, not on `spawnd-prod`; `ssh spawnd-prod` only carries
`spawn-server` + `spawn-web`, no `~/.local/state/spawn`). 36,525 lines,
2026-08-24T00:12 → 2026-08-25T09:02 (~33 h). ANSI stripped for counting.

| metric | count |
|---|---|
| `peer connection state changed: connected` (sessions that reached connected) | **107** |
| `peer connection state changed: closed` | 138 |
| `peer connection state changed: failed` (never usable) | 10 |
| `failed to handle_inbound: ErrChunk` (received ABORT) | **77** |
| daemon read-idle timeout | 8 |
| lines mentioning a *selected/nominated* candidate pair | **0** |

**≈72% of all successfully-connected sessions (77/107) die by receiving an SCTP
ABORT.** This is the dominant failure mode and matches "top reliability
complaint."

Connect→ErrChunk lifetime (77 samples): **min 0 s, median 19 s, mean 485 s, max
3489 s (58 min).** Bimodal — ~34/77 die within 10 s, then a long tail out to an
hour. Interpretation: dies fast when a large inbound burst (paste / big input)
happens early; survives long when it happens late; plain keystrokes (single-chunk
messages) rarely trigger it.

**Relay correlation:** of the 77 teardown blocks, **65 (84%)** list a TURN
`relay` candidate; the peers are NZ mobile IPv6 (`2401:7000:710d:…`, Spark/Vodafone
NZ) with srflx `203.211.111.19` (NZ) and relay `98.83.222.112` (the prod AWS
coturn). One fully-characterised session (log line ~30167): remote candidates
`udp6 srflx 2401:7000:…`, `udp4 srflx 203.211.111.19`, `udp4 relay 98.83.222.112`;
connected 05:50:39.04 → `[] failed to handle_inbound: ErrChunk` 05:50:40.25
(~1.2 s) → `SessionSRTP has been closed` → teardown → immediate reconnect at
05:50:42 (the reconnect loop the user sees as "Reconnecting"). **Caveat:** 84% is
"a relay candidate existed," not "the selected pair was relay" — the daemon never
logs the nominated pair (see §5), so relay-as-selected is inferred (correctly,
for a home-NAT daemon ↔ CGNAT NZ-mobile peer, but not log-proven).

Other WARN noise on the same host (not the abort cause, but explains general
relay flakiness): `failed to resolve stun host … No available ipv4/ipv6 IP
address` (299×), `Unable to handle URL in gather_candidates_relay
turn:…?transport=tcp` (125× — webrtc-ice 0.17 can't do TURN/TCP, already noted in
SPEC-connection.md), `could not listen udp fe80::… (os error 49)` (link-local
churn). No SCTP-level WARNs (retransmit/sack/rwnd/tsn) appear because those are
`log::debug!` and the daemon runs at INFO — which is exactly why the fragment-drop
step is not directly visible (see §5).

### 2d. The #822 deadlock, in the actual 0.17.1 source

`webrtc-sctp-0.17.1/src/association/association_internal.rs:954-985` (`handle_data`):

```rust
let can_push = self.payload_queue.can_push(d, self.peer_last_tsn);
if can_push {
    if let Some(_s) = self.get_or_create_stream(d.stream_identifier) {
        if self.get_my_receiver_window_credit().await > 0 {
            self.payload_queue.push(d.clone(), self.peer_last_tsn);   // normal accept
        } else {
            // Receive buffer is full
            if let Some(last_tsn) = self.payload_queue.get_last_tsn_received() {
                if sna32lt(d.tsn, *last_tsn) {                        // gap-filler BELOW highest queued
                    self.payload_queue.push(d.clone(), self.peer_last_tsn);
                } else { /* dropped */ }
            } else { /* buffer full, payload_queue empty → dropped */ }
        }
    }
}
```

`get_my_receiver_window_credit = max_receive_buffer_size −
Σ bytes_in_reassembly_queue` (`:1055-1058`); default
`max_receive_buffer_size = INITIAL_RECV_BUF_SIZE = 1 MiB` (`mod.rs:58`). The
per-**stream** reassembly queue holds fragments of an incomplete message; a large
message (paste) with one lost fragment keeps that queue full → credit 0 while the
association-level `payload_queue` can be empty → `get_last_tsn_received()` is
`None` → the retransmitted missing fragment hits the `else { /* dropped */ }`
arm every time. The window never reopens; the sender's T3-rtx retransmits until
`Association.Max.Retransmits` is hit; usrsctp sends ABORT. Upstream issue **#822**
("permanent zero-window deadlock when the chunk dropped at buffer-full is the tail
of a burst") is this exact branch; the reporter observed it as browser→webrtc-rs
aborts, ~5% baseline, higher under loss. The 0.17.1 code's `sna32lt` re-admission
is a *partial* mitigation that does not cover the in-sequence / empty-payload-queue
case.

### 2e. Upstream version research (agent-verified, cited)

- webrtc-sctp `DEFAULT_MAX_MESSAGE_SIZE = 65536` and the "max-message-size SDP
  attribute is ignored" behaviour: webrtc-rs **issue #326** (closed,
  not-planned). This is a *send-cap* limitation and does **not** cause the abort
  (the cap only makes webrtc-rs more conservative than the browser).
- **Issue #806 / PR #807** — `INITIAL_MTU` lowered **1228 → 1191** to fit
  ≤1280-byte paths after IPv6(40)+UDP(8)+TURN-ChannelData(4)+DTLS(13)+GCM(24)
  overhead. Shipped in **webrtc-sctp 0.17.2 / webrtc 0.17.2 (2026-07-20)**.
  Confirmed 0.17.1 still has `INITIAL_MTU = 1228` (`mod.rs:56`). This blackholes
  full-size **daemon→browser** DATA chunks on exactly our IPv6+TURN population —
  a real contributor to relay instability, but it primarily *stalls* the
  daemon→browser direction (browser keeps SACKing; no browser ABORT), so it is
  **not** the direct cause of the received-ABORT / ErrChunk symptom.
- **Issue #822** — the zero-window deadlock above. **Not fixed in any published
  version** (classic 0.17.x, nor the 0.20/0.21 `rtc` rewrite). Fixes exist only as
  a vendored fork patch (`privacy-ethereum/kps@a73a0a8`, "accept the in-sequence
  chunk at a full buffer") and an **open** `webrtc-rs/rtc` **PR #201** ("Fix
  deadlock in buffer that has a gap but is full").
- Version landscape: classic line is `webrtc` 0.17.0 → 0.17.1 → **0.17.2**
  (latest classic); there is no 0.18/0.19; 0.20.x is a sans-io rewrite on the
  separate `rtc`/`rtc-sctp` crates (latest stable 0.20.3, 2026-08-16; 0.21.0-beta
  exists). Crucially, 0.20.3 **regressed** the MTU fix (`rtc` issue #178) and
  still lacks the #822 fix.

---

## 3. Recommended fix (concrete, layered)

Ordered by leverage-per-risk. None of these touches `ice_transport_policy` on a
session offer (see §6).

**F1 — Bump to webrtc/webrtc-sctp 0.17.2 (near-zero cost, do first).**
`daemon/Cargo.toml` already says `webrtc = "0.17"` (`^0.17`), so a plain
`cargo update -p webrtc` moves the lock from 0.17.1 → **0.17.2**; the public API
(`SettingEngine`, `APIBuilder`, `RTCPeerConnection`, `dc.send/send_text/on_message`,
all the daemon's `use webrtc::…` paths) is byte-for-byte unchanged — **no
`rtc.rs` migration**. Verify `daemon/Cargo.lock` then shows `webrtc-sctp 0.17.2`
and the vendored `INITIAL_MTU = 1191`. Fixes the #806 MTU blackhole on the
IPv6+TURN paths.

**F2 — Patch the #822 deadlock (the direct ErrChunk fix).** Add to
`daemon/Cargo.toml`:
```toml
[patch.crates-io]
webrtc-sctp = { git = "…fork of 0.17.2 with the #822 fix…" }
```
The one-branch change is in the vendored
`association/association_internal.rs` `handle_data` buffer-full `else` block
(§2d): when credit is 0, also admit the chunk if it is the next in-sequence
chunk (`d.tsn == peer_last_tsn.wrapping_add(1)`) / when `get_last_tsn_received()`
is `None`, instead of dropping it — i.e. port `rtc` PR #201 / the KPS fork commit
onto 0.17.2. This is the single change most likely to stop "daemon receives
ABORT under loss." It needs upstream-diff verification and a soak on one host.

**F3 — Client input chunking ≤16 KiB + backpressure, BOTH frontends (already
planned as web P1-4 / mobile item 15 in SPEC-connection.md:219-220,290).** Cap
each `ptyDc.send()` / paste at ≤16 KiB and honour `bufferedAmount` (256 KiB high
/ `bufferedamountlow`). This shrinks inbound messages so a single lost fragment
can no longer pin a large multi-fragment reassembly, sharply cutting the #822
trigger rate — and it helps *before* the crate patch ships and on already-deployed
daemons. It is the client half; F2 is the daemon half; ship both.

**Do NOT** lower `max_receive_buffer_size` (it makes #822 easier to trigger) and
do **not** jump to 0.20/0.21 (large sans-io rewrite — every import changes, needs
a `Runtime` + crypto-provider + edition 2024 — and it currently ships neither fix).

---

## 4. Hypotheses killed (and how)

- **"A chunk-parse bug in webrtc-sctp 0.17 (ErrChunk = malformed inbound
  chunk)."** Killed by code: `ErrChunk` is returned only for a received ABORT
  chunk (`association_internal.rs:2181`); every parse/validation failure is
  non-fatal warn-and-continue (`handle_inbound` §2a). A version bump "to fix the
  chunk parser" is aimed at the wrong defect.
- **"The daemon sends an oversized SCTP message and the browser aborts."** Killed
  by code: send-side `max_message_size` is enforced (`stream/mod.rs:288`), the
  daemon uses the 65536 default and `break`s on send error, so it cannot emit a
  too-big message.
- **"max-message-size is ignored (#326) → browser aborts."** Killed: #326 only
  makes webrtc-rs's send cap more conservative than the browser's; it cannot cause
  a browser-side protocol violation.
- **"nginx 60 s idle / daemon 75 s read-idle / TURN broken / coturn 0
  allocations."** Already ruled out by the team's prior triage; corroborated here
  — read-idle fired only 8× vs 77 ErrChunk, and dying sessions are using relay
  candidates, not failing to allocate them.
- **"#806 MTU blackhole is THE cause."** Downgraded to *contributor*, not primary:
  it stalls daemon→browser (browser keeps SACKing, does not ABORT), so it does not
  produce the *received*-ABORT ErrChunk line; it does explain some of the other
  teardowns and the general relay flakiness on the same paths, and F1 fixes it for
  free.

---

## 5. What I could not determine, and the one-line instrumentation that settles it

I could not directly observe the final fragment-drop, nor prove per-session that
the *selected* pair (not merely an offered candidate) was the relay. Both are
invisible because (a) the daemon logs no selected candidate pair, and (b)
webrtc-sctp's drop line is `log::debug!` while the daemon runs at INFO.

Two cheap, non-behaviour-changing instruments (specify only — I did not make
these edits):

1. **Log the selected candidate pair at connect.** The accessor exists in
   webrtc 0.17: `pc.sctp()` → `RTCSctpTransport` (`peer_connection/mod.rs:2086`)
   → `.transport()` → `RTCDtlsTransport` (`sctp_transport/mod.rs:120`) →
   `.ice_transport()` → `&RTCIceTransport` (`dtls_transport/mod.rs:117`) →
   `.get_selected_candidate_pair().await` (`ice_transport/mod.rs:87`). In the
   existing `on_peer_connection_state_change` handler
   (`daemon/src/rtc.rs:1020` / `:1147`), when state becomes `Connected`, add one
   `tracing::info!(local=%pair.local, remote=%pair.remote, "selected candidate
   pair")`. Then a future log slice can state definitively whether the aborting
   sessions are relay/srflx/host/prflx.
2. **Enable `RUST_LOG=webrtc_sctp=debug` on one host temporarily.** The line
   `receive buffer full. dropping DATA with tsn=…`
   (`association_internal.rs:972-978`) appearing immediately before an ErrChunk is
   a *direct* confirmation of #822; its absence would point back at #806/other. A
   single host for a day would decide #822-vs-#806 conclusively.

---

## 6. Hard-constraint compliance

None of F1/F2/F3 nor the instrumentation adds `ice_transport_policy` to a session
`rtc.offer`. `daemon/src/run.rs` (~line 1598) uses that field's *absence* as the
host-vs-session discriminator, so sending it to a session offer would make every
deployed daemon silently drop every session offer. The fixes here are the crate
version, a `[patch.crates-io]` SCTP fix, client-side input chunking, and INFO
logging — the discriminator is untouched. If a future fix ever needs the session
path to learn a policy, it must ride a new advertised capability
(`session_ice_policy` register flag), never the field on today's daemons.
