# D2 implementation report — daemon connection reliability

Implemented the complete D2 scope, the three ErrChunk directives assigned to
the daemon, and Addendum 1 A–D. No numbered D2 item was cut.

## Files

- Dependency/runtime wiring: `daemon/Cargo.toml`, `daemon/Cargo.lock`,
  `daemon/src/lib.rs`, `daemon/src/main.rs`, `daemon/src/version.rs`.
- WebSocket supervision/protocol: `daemon/src/ws.rs`, `daemon/src/run.rs`,
  `daemon/src/proto.rs`.
- RTC, PTY, and control transport: `daemon/src/rtc.rs`, `daemon/src/pty.rs`,
  `daemon/src/session_ctl.rs`.
- Update/worker pairing: `daemon/src/update.rs`, `daemon/src/update_io.rs`,
  `daemon/src/update_tests.rs`, `daemon/src/worker_backend.rs`,
  `daemon/src/bin/spawn-worker.rs`.
- SCTP #822 patch: exact 0.17.2 crate source under `daemon/vendor/sctp/`, with
  the functional change and regression test confined to
  `src/association/association_internal.rs` and
  `src/association/association_internal/association_internal_test.rs`.
- Operational and layout documentation: `daemon/CLAUDE.md`.
- `cargo fmt` also normalized formatting in already-present daemon changes.

## ErrChunk directives

### F1 — dependency update (completed and verified first)

Ran `cargo update -p webrtc` while keeping `Cargo.toml` at `webrtc = "0.17"`.
The final locked relevant versions are:

- `webrtc 0.17.2`
- `webrtc-ice 0.17.2`
- `webrtc-sctp 0.17.2` (resolved through the path patch below)
- Matched subcrates for which 0.17.2 was not published remain at 0.17.1:
  `webrtc-data`, `webrtc-mdns`, `webrtc-media`, `webrtc-srtp`, and
  `webrtc-util`.

The F1 build and focused daemon tests were green before applying F2. There was
no `rtc.rs` API migration needed for 0.17.2.

### Instrumentation

- Both session and host peer-connection `Connected` callbacks log the selected
  ICE candidate-pair types and protocols at info. They never log candidate
  addresses or SDP.
- `daemon/CLAUDE.md` documents that
  `RUST_LOG=webrtc_sctp=debug` plus `receive buffer full. dropping DATA with tsn=`
  is the confirmation signal for upstream issue #822.

### F2 — narrow path-patched receiver fix

- Added `[patch.crates-io] webrtc-sctp = { path = "vendor/sctp" }`.
- Vendored the exact locked 0.17.2 registry source. `diff -rq` against that
  source reports only the association implementation and its regression test
  as different.
- Ported only the upstream PR #201 behavior: when the reassembly buffer is full
  but has no readable message, admit the next in-sequence DATA chunk so the
  fragmented message can complete and free the receiver window.
- The patch-site comment records issue #822, PR #201, why SPAWN D carries the
  patch, and that it should be removed once a published `webrtc-sctp` release
  contains the upstream fix.
- Added a direct crate regression that fills a three-byte receive window with
  an incomplete fragment and verifies that the next ending fragment is
  admitted.

No jump to webrtc 0.20/0.21 and no reduction of the SCTP receive buffer was
made.

## D2 numbered checklist

1. **WS connection:** complete. DNS has a 5 s deadline, resolved IPv6/IPv4
   addresses are alternated, each TCP address has a 5 s attempt, and the whole
   DNS/TCP/TLS/upgrade is bounded by 20 s. Both `ws` and `wss` use the manually
   connected socket with Nagle disabled, TCP keepalive enabled, and
   `client_async_tls_with_config` for TLS.
2. **Ping/liveness:** complete. The daemon sends WebSocket Ping every 15 s,
   treats Pong as inbound liveness, ends the connection after two complete
   unanswered intervals, and retains the 75 s read-idle outer bound.
3. **Backoff/close policy:** complete. The addendum's AWS full-jitter rule
   supersedes the original ±25% wording: delay is uniformly selected in
   `0..=min(60 s, 1 s * 2^attempt)`. The attempt resets only after Registered
   has remained healthy for 60 s. Typed handling covers 1008, 4000, 4002,
   4003, and 4010; permanent/rapid refusal reaches the cap and noisy errors are
   logged once. Credential replacement still legitimately resets the ladder.
4. **Peers survive control-WS loss:** complete. Ordinary WS loss clears a
   swappable `ArcSwapOption` sender and preserves peers; credential/revocation
   paths still invalidate trust and close all. Full/closed signalling outboxes
   defer the last peer status rather than closing RTC, and statuses are
   re-announced after registration. Register advertises
   `keeps_peers_across_reconnect` and reports exact live binding tuples.
5. **ICE restart:** complete. A same-ID restart is accepted only when the
   explicit restart flag is present, identity/generation match, the signed key
   is the same as the original offer's key, and the remote ICE ufrag is fresh.
   It renegotiates the existing peer connection and signs the answer. Unknown,
   replayed, unsigned/key-changed, generation-changed, and non-restart
   collisions remain rejected. Legacy offers default `ice_restart` to false.
6. **Output pacing:** complete. Removed the 2 s data-channel send timeouts,
   installed 64 KiB low/512 KiB high buffered-amount pacing, and wait for the
   channel callback with a safety wake rather than treating slowness as peer
   death. Direct-sink overflow drops backlog, emits exact
   `{"type":"pty_gap","offset":...}`, and resubscribes from that origin
   without closing RTC.
7. **Session ICE policy:** complete. Session offers now parse and apply an
   optional `ice_transport_policy`; register advertises
   `session_ice_policy: true`. The absence remains the legacy-compatible
   default. The signed-offer regression proves `relay` and `ice_restart` are
   not dropped during parsing.
8. **Shared network policy/API:** complete. One API/setting engine is built at
   startup for both paths. It disables mDNS, drops IPv4/IPv6 link-local
   candidates and noisy virtual interfaces, preserves `utun`, `wg`, and
   `tailscale`, and limits UDP candidates to 50000–50100. The inbound firewall
   requirement and LAN-direct behavior are documented.
9. **Signalling concurrency:** complete. RTC work is dispatched through an
   unbounded per-signal queue: ordering is preserved within a peer while
   different peers progress independently, so a slow close/offer cannot block
   other signalling.
10. **Logging:** complete. Connect failures are assigned bounded,
    content-free classes (`dns`, `tcp`, `tls`, `handshake`, `timeout`,
    `protocol_required`, `unauthorized`). `tracing-log` bridges library `log`
    records into the existing tracing subscriber with WebRTC defaults at warn
    and `RUST_LOG` overrides. SDP errors are class-only at warn and detail-only
    at debug.
11. **Candidates/barriers:** complete. End-of-candidates is emitted as an
    empty candidate for both session and host signalling. Worker readiness and
    shutdown barriers are 10 s.
12. **TURN limitation:** complete. No TURN-TCP/TLS patch was attempted. A
    content-free warn-once diagnostic is emitted when an offered ICE list has
    no usable UDP `turn:` entry, and `daemon/CLAUDE.md` documents the webrtc-ice
    0.17 limitation and required outbound UDP.

Compatibility details added while implementing the exact binding tuple:
generation-bearing host signals are accepted, while a host frame from an old
server may still omit `binding_generation` and maps to legacy generation zero.
Session policy and restart fields are optional/defaulted, and unknown additive
register fields do not change legacy offer behavior.

## Research addendum checklist

### A. Post-update health gate and automatic revert

- Swap writes `spawnd.updating` atomically beside the daemon. Its bounded JSON
  records attempts, old/attempted trees, the five-minute deadline, prior
  version, optional request ID, worker path, and whether revert completed.
- The first updated startup increments probation. A second failed startup or
  an expired deadline restores both `.prev` binaries and execs the prior
  `spawnd`.
- Reaching `Inbound::Registered` while healthy removes the marker and only
  then removes both `.prev` files; stale backups are no longer deleted at
  startup.
- After a reverted daemon registers, it sends a tracked/flushed
  `daemon.update_result` with `ok:false`, `stage:"health"`, the failed tree,
  and `error:"registration_failed"` before deleting durable state. If the
  frame cannot flush, the marker is retained for the next connection.
- Pure state-machine tests and fake two-binary swap/revert tests are included.

### B. Worker pair cross-check

- `spawn-worker --version` now emits the exact shared build version and tree
  stamp from `version.rs`.
- The daemon compares that identity at startup and immediately before each
  worker launch. A mismatch reports `worker_mismatch`, blocks self-update in
  the same capability surface, and refuses only new sessions with a clear
  error. Existing workers are not disturbed.

### C. Outbound data-channel discipline

- PTY chunks are 16 KiB, control replay is now `16 KiB - header`, history and
  file chunks remain below the limit, and host direct/control framing enforces
  16 KiB. Oversized control output is dropped without closing the peer.
- The setting engine caps the local SCTP send message size at 16 KiB; the
  WebRTC stack still applies its negotiated peer limit.
- The remaining 48 KiB `UPLOAD_CHUNK_BYTES` path is browser/phone → daemon
  upload input, not daemon → client data-channel output.

### D. Full jitter

Implemented as described under numbered item 3, including the Registered +
60 s reset rule.

## Verification

All commands used `CARGO_HOME=/private/tmp/spawn-d2-cargo` because the managed
sandbox does not expose the normal Cargo cache.

- `cargo fmt` — pass.
- `scripts/check-claude-md.sh` — pass: every tracked directory documented.
- `cargo build --locked` — pass.
- `cargo clippy --locked --bin spawnd -- -D warnings` — stops on the existing
  `clippy::byte-char-slices` finding at
  `src/sessiond/emulator.rs:501` (`[b'(', b')', b'*', b'+']`).
- `cargo clippy --locked --bin spawnd -- -A clippy::byte-char-slices -D warnings`
  — pass, demonstrating no additional warning after allowing only that
  pre-existing finding.
- `cargo test --locked --bin spawnd ws::` — 12 passed.
- `cargo test --locked --bin spawnd update::tests::` — 14 passed.
- `cargo test --locked --bin spawnd session_ctl::tests::` — 10 passed.
- Focused regressions for direct-sink recovery, full signalling outbox, ICE
  restart/ufrag validation, fake-channel pacing, network policy, host binding,
  host ICE policy, per-signal concurrency, async update dispatch, update wire
  names, signed relay offer parsing, and worker-pair stamp — 12 passed.
- Direct vendor filter
  `cargo test --locked --manifest-path vendor/sctp/Cargo.toml test_full_receive_buffer_admits_next_in_sequence_fragment`
  — 1 passed (115 filtered out).
- Actual built identity check —
  `spawn-worker 0.1.0+ga0958a31d98d tree=e635a76b8845a0ea9691b505f91efe109c8ea883-dirty`;
  the daemon and worker use the same generated stamp.
- `cargo build --locked --release` — pass in 1m28s.

One allowed targeted integration filter remains red:
`worker_backend::tests::worker_launch_adopt_and_priority_shutdown_roundtrip`
fails on this Mac with `binding lifecycle worker endpoint: path must be shorter
than SUN_LEN`, followed by the expected worker-endpoint-unreachable assertion.
The hard rule against git-writing commands precluded `git worktree add`, so I
created a read-only baseline from `git archive HEAD`, built its worker, and ran
the identical filter with an isolated target directory. Baseline HEAD fails
with the same `SUN_LEN`/endpoint-unreachable sequence. Both temporary baseline
trees were removed afterward. No unfiltered daemon suite was run.

## Undone / known external limits

- No D2 item is undone.
- The exact clippy command remains blocked by the unrelated emulator lint
  above; the one-lint-allowed run is otherwise clean.
- The macOS worker lifecycle test retains its pre-existing Unix socket path
  length failure.
- TURN over TCP/TLS remains unavailable by design until supported upstream;
  the daemon now exposes that limitation rather than silently hiding it.

## Notes for S2 / W2 / M2

- **S2:** Send session `ice_transport_policy` only after the daemon advertises
  `session_ice_policy`; older daemons use the field's absence as a discriminator
  and will drop such offers. The new daemon safely accepts either shape.
- **S2:** Preserve/reconcile every live binding tuple exactly. New host frames
  should carry `binding_generation`; omit it for legacy peers as needed. This
  daemon accepts omitted legacy generation and advertises the actual generation
  it received for new bindings.
- **S2:** Persist a failed attempted tree from
  `daemon.update_result {ok:false, stage:"health"}` and do not push that tree
  again. The health result carries the original request ID when available and a
  deterministic health ID otherwise.
- **S2:** Unknown live bindings should be answered with `rtc.close`, while
  known exact tuples should be rebound during the orphan grace. A missing
  legacy host generation is represented as zero.
- **W2/M2:** Keep all input data-channel messages at or below 16 KiB. Handle
  `pty_gap` through the existing history-gap resnapshot path.
- **W2/M2:** ICE restarts must reuse the signal ID, binding nonce/generation,
  and signed key, set `ice_restart:true`, and provide a fresh ufrag. Any old
  daemon that does not implement restart will retain its previous collision
  rejection, so clients must keep the specified full-rebuild fallback.
- **All peers:** The daemon's new cross-component fields are additive and
  optional on input. Existing offers without ICE policy/restart/generation
  retain their previous behavior.
