# W2 implementation report — web connection reliability

## Files

- `web/src/lib/ws.ts`
  - Shared jittered reconnect policy, close-code classification, unauthorized event, ICE-server sanitization/expiry helpers, and additive signalling frame types.
- `web/src/lib/ws.test.ts`
  - Backoff bounds, close-code policy, ICE sanitization, and TURN-expiry coverage.
- `web/src/lib/session-ctl.ts`
  - Bounded/expiring input queue, 16 KiB PTY writes with backpressure, and `pty_gap` parsing.
- `web/src/lib/session-ctl.test.ts`
  - Chunking, send-error remainder, backpressure, queue expiry, and `pty_gap` coverage.
- `web/src/components/terminal/useSessionSocket.ts`
  - Session signalling watchdog/wake/reconnect, healthy-PC resume, ICE restart/fallback, config refresh, signed-mode restart, queued-input expiry, and stable hook callbacks/result.
- `web/src/lib/hostControl.ts`
  - Host signalling watchdog/wake/reconnect, healthy-PC resume, ICE restart/fallback, config refresh, candidate gating, and close-code handling.
- `web/src/lib/hostControl.test.ts`
  - Fake WebSocket/RTCPeerConnection coverage for authorization, watchdog feature detection, resume/fallback, wake-triggered ICE restart, and rebuild timeout.
- `web/src/lib/alert-socket.ts`
  - Shared jitter/close policy, application-frame attempt reset, unauthorized invalidation, immediate 4010 reconnect, and wake handling. Existing 4003 handling is preserved.
- `web/src/lib/query.tsx`
  - Invalidates `['me']` when a socket reports 1008 unauthorized.
- `web/src/hooks/useHostControl.ts`
  - React Query account-endorsement cache/prefetch with a five-minute stale time and immediate cached trust input.
- `web/src/components/terminal/Terminal.tsx`
  - Active/hidden gating, stable resize behavior, gap recovery, signed-out/disabled/reconnecting UI, queued-input count, and background scrollback pause.
- `web/src/components/terminal/ConnectionChip.tsx`
  - Copy map and data-plane-first state display so a healthy channel is not shown as signalling/reconnecting.
- `web/src/components/terminal/ConnectingOverlay.tsx`
  - Signed-out and server-disabled presentation.

## Per-item checklist

1. **Complete — shared backoff.** Added `backoffDelay(attempt, {base, cap})` with 0.7–1.3 jitter and adopted it in session, host, and alert sockets. Attempts now reset on the first valid application frame, not `onopen`.
2. **Complete — close codes and signed-out state.** All three sockets share the required policy: 1008 is terminal and invalidates `['me']`; 4002/1002 are terminal client bugs; 4003 retains the versioning stream's `spawn:client-stale` behavior; 4010 reconnects immediately; ordinary/retryable codes use backoff. Session UI has `unauthorized` and the exact `You've been signed out.` / `Sign in` copy.
3. **Complete — watchdog and wake.** Session and host watchdogs arm only after the first server `ping`; thereafter inbound frames refresh the 80-second budget and clients reply with `pong`. Old servers that never ping cannot trip the watchdog. `online`, `visibilitychange`, and `pageshow` clear backoff/reconnect a closed signalling socket, or start ICE recovery when signalling is open but the peer is unhealthy.
4. **Complete — ICE sanitization and construction failure.** `sanitizeIceServers()` accepts only STUN/TURN schemes, requires credentials for TURN/TURNS, and caps at eight entries. PeerConnection creation uses sanitized config plus `iceCandidatePoolSize: 1` inside the recovery `try`, so constructor failure follows the retry ladder.
5. **Complete — signalling resume.** A connected PeerConnection/data channel survives ordinary WebSocket loss. The replacement socket sends `rtc.resume` with the exact binding tuple; `resumed`/`rebound` retain the peer, while `unavailable`, an error, or a three-second unanswered resume starts the existing fresh-offer path. Missing resume metadata also degrades to a fresh offer. The chip prioritizes a healthy data plane, so it does not show `channel…` during signalling recovery.
6. **Complete — ICE restart.** `disconnected` waits five seconds; `failed` and foreground/network wake recover immediately. Recovery refreshes near-expiry TURN config (waiting at most two seconds), applies the latest config, calls `restartIce()`, sends `ice_restart: true` with the existing binding, gates candidates behind the restart offer, and rebuilds after ten seconds if still disconnected. Signed bindings remain signed with an explicit mode latch. Servers that ignore config requests or restart/resume frames time out into the existing fresh-offer flow.
7. **Complete — PTY input safety.** Direct and queued writes use at most 16 KiB per DataChannel message, catch send failures, stop at the 256 KiB high-water mark, resume at the 128 KiB `bufferedamountlow` threshold, and retain the exact unsent suffix.
8. **Complete — `pty_gap`.** Parsing validates a safe non-negative offset. Handling reuses history-gap recovery: discard pending anchored output/snapshots, reset the anchor, request history from the supplied offset, and gate input through the replay.
9. **Complete — time to first byte.** Account endorsements use React Query with a five-minute stale time and prefetch as soon as host identity is known. Trust resolution starts alongside signalling, candidates are pooled, and the connection timeout starts only after the offer has been sent.
10. **Complete — stable hook API.** `sendBinary`, `sendJson`, and `uploadFile` are callbacks; the returned transport object is memoized. Resize follows `dcOpen` and deduplicates the last `{cols, rows}`.
11. **Complete — retry reset/start and disabled state.** `session.status: running` and non-failure RTC statuses reset retry delay and begin RTC immediately when needed. Disabled RTC config renders `transport disabled by this server`.
12. **Complete — reconnect/queue UI.** A painted pane without an open data channel for two seconds shows `Reconnecting to {host} — keystrokes are sent once the channel is back (N queued)`. Queued input expires after 30 seconds. Connection-chip labels come from a copy map rather than raw enum values.
13. **Complete — inactive work pause.** Session stats and scheduled scrollback refresh pause while the pane is inactive or `document.hidden`, then resume on visibility/activity.
14. **Complete — signed-mode latch.** Session RTC has an explicit signed/raw decision latch and uses it for initial and restart offers, matching host control behavior.
15. **Complete — state-machine tests.** Bun tests drive fake browser WebSocket/RTCPeerConnection/DataChannel implementations through jitter bounds, close codes, feature-detected watchdog, wake recovery, resume-vs-fresh-offer decisions, input chunking/backpressure/error handling, ICE restart, and rebuild fallback. Coverage lives in the nearest existing test files (`hostControl.test.ts`, `ws.test.ts`, and `session-ctl.test.ts`).
16. **Complete — shared copy.** Web uses the spec's exact signed-out and reconnect strings. M2 should copy the strings in item 2 and item 12 verbatim.

## Verification output

Command run exactly as requested:

```text
cd web && npm run lint && npx tsc --noEmit && npm_config_cache=/private/tmp/spawn-web-npm-cache npx --package=bun bunx bun test src

EXIT 0
Biome: Checked 340 files; no fixes applied; 5 warnings and 1 info.
TypeScript: passed.
Bun: 1076 pass, 0 fail, 4278 expect() calls, 68 files.
```

The Biome findings are pre-existing/outside the W2 files: `passkey-flows.test.ts`, login `page.tsx`, `session-view.tsx`, `SettingsDialog.tsx`, `tests/e2e/onboarding.spec.ts`, plus the existing oversized `trust-ux/presentation.html` warning. No Playwright command was run.

Additional focused verification:

```text
npx biome check --write <13 changed web files>  # pass; one formatting fix applied
npx tsc --noEmit                               # pass
bun test src/lib/hostControl.test.ts src/lib/ws.test.ts src/lib/session-ctl.test.ts
# 75 pass, 0 fail, 233 expect() calls
git diff --check -- web                        # pass
```

## Undone

- None in W2 scope.
- Resume, signalling rebind, config-on-request, server ping, and restart acceptance are implemented client-side and deliberately feature-detected/fallback-safe, but their successful end-to-end path depends on the concurrent S2/D2 protocol work.

## Notes for S2 / D2 / M2

### S2

- Web expects plain `ping` frames with millisecond `ts`, accepts `rtc.config` refresh at any time, and sends plain `rtc.config.request`.
- `rtc.resume` includes signal/session id, binding nonce/generation, scope type/id, protocol, and protocol version. Reply `rtc.status resumed`, `rebound`, or `unavailable` with the binding tuple as specified.
- Restart offers reuse the signal id and binding nonce/generation and add `ice_restart: true`. Preserve the binding rather than allocating a new generation.
- Host/session candidates and close frames now include binding identity when available; tolerate these additive keys.
- Keep 4010 reserved for subscription loss and 4003 for the existing stale-client update flow.
- The stale-presence serialization/Redis reclaim/single-worker documentation items in the addendum are server/release work; W2 makes an already-open web data channel survive the signalling part of that failure.

### D2

- Restart offers can reuse an existing signed signal id. Accept only the same binding/generation and pinned signer with a fresh ICE ufrag; preserve replay protection.
- Web gates initial/restart candidates until the corresponding offer is sent and keeps the same binding for restart.
- Web now enforces 16 KiB input chunks. `pty_gap.offset` is treated as the new authoritative PTY offset: pending anchored output is discarded and history is requested from there.
- Do not use session `ice_transport_policy` as part of unrelated ErrChunk mitigation until the advertised capability path in the spec is present.

### M2

- Mirror these strings exactly:
  - `You've been signed out.`
  - `Sign in`
  - `Reconnecting to {host} — keystrokes are sent once the channel is back (N queued)`
  - `transport disabled by this server`
- Web's old-server compatibility rules are: watchdog only after the first `ping`; resume timeout/unavailable/error falls back after three seconds; stale TURN config request waits at most two seconds; failed restart rebuilds after ten seconds.
