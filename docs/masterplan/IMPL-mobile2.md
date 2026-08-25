# IMPL-mobile2 — M2 mobile connection reliability

## Outcome and files

Implemented all Mobile M2 items 1–16; nothing was cut or left undone. The existing release-identity, self-update, and `4003` behavior remains intact.

Changed areas: `package.json`/`package-lock.json`; `src/data/api/{client,socket-urls}.ts`; realtime sockets, lifecycle, network source, and provider under `src/data/realtime/`; trust startup under `src/data/trust/`; terminal/file/Legion UI under `src/components/` and `src/terminal/*Surface.tsx`; native transport under `src/terminal/transport/`; worker sources and regenerated `worker-html.ts`/`assets/terminal/worker.html`; nearest tests plus new provider, ICE-policy, and host-registry suites. `tests/fake-transport.ts` supports the additive event. `mobile/CLAUDE.md` was not changed because no directory, command, or convention changed.

`expo-network` was installed with Expo's version resolver and is loaded only through guarded dynamic `require` in `try/catch`. `app.json` was not changed. The native signal activates only after the next EAS build; an OTA on an older native binary silently keeps the socket-observed fallback.

## Per-item checklist

1. **Done:** host transport reconnects under a three-minute budget; active requests/commands/streams reject with retryable `connection_lost`; File Explorer has generation-keyed Retry.
2. **Done:** `rtc.config` starts peers only while signalling and otherwise caches; connected workers ignore ordinary `connect`; ready accepts a fresh `signal-open`; known bindings resume and timeout/`unavailable` forces a fresh offer.
3. **Done:** 500 ms, 1, 2, 4… jittered (0.7–1.3), 30 s-capped ladder; readiness resets it; post-ready timeout retries for three minutes before lost-connection copy.
4. **Done:** guarded native network source, socket fallback, interface-change ICE restart, stale TURN refresh request (two-second maximum), five-second disconnected grace, ten-second full-rebuild fallback, and 80 s ping-gated browser/host watchdog. Interface changes keep signalling available for the restart offer; offline/background retire eagerly.
5. **Done:** `inactive` does nothing; background close is deferred three seconds and active cancels it or reopens a completed retirement.
6. **Done:** non-first bootstrap clears with `\x1b[0m\x1b[H\x1b[2J\x1b[3J`; alternate-buffer history reseed is skipped; `pty_gap` discards anchored backlog and bootstraps from its offset.
7. **Done:** alerts follow auth-token appearance/removal; `1008` emits unauthenticated/shared sign-out; persistent failure shows exact `Live updates paused — Retry`.
8. **Done:** both `open()` paths fence async identity work against close/replacement and maintain one bridge subscription.
9. **Done:** mount starts signal, identity, trust, and 30 s-memoized endorsements; direct pins skip endorsement HTTP; config buffers for worker attach; loopback is process-cached and skipped for host workers.
10. **Done:** signal state and close metadata fail transports immediately; `1008` says `You've been signed out.`; `4003` preserves the SPAWN D update path.
11. **Done:** all sockets use `Authorization: Bearer` via RN's third WebSocket argument; token queries removed; CSP is `connect-src 'none'`; ICE inputs are capped/scheme-filtered, TURN credentials required, STUN credentials stripped.
12. **Done:** connected worker polls selected-pair stats every five seconds and reports direct/STUN/relay plus integer RTT to terminal header and diagnostics; network-vs-host restart failure copy differs.
13. **Done:** one host-keyed refcounted transport/worker with ownership handoff; Legion poll is three seconds and pauses outside the viewport or when unfocused.
14. **Done:** host backpressure uses `bufferedamountlow` with 60 s bound; one platform-correct bridge listener; client failures attempt `rtc.close`; unknown policy warns and degrades to `all`.
15. **Done:** native direct/pending writes and worker DataChannel sends chunk at 16 KiB; pending cap remains 64 KiB.
16. **Done:** nearest-suite tests cover these paths and new user copy matches web; daemon-update copy was not changed.

## Verification

Final required run:

```text
cd mobile && npm run ci
typecheck: PASS
lint: PASS — 681 files
jest: PASS — 227 suites, 1562 tests, 2 snapshots
```

The first full CI found a stale assertion in the touched `ctl-codec.test.ts` expecting 64 KiB chunks. I updated it, reran that suite alone (`9/9` passed), then reran full CI successfully. No shared-tree failing suite needed a flake rerun. Existing non-failing Expo Go notification and unrelated React `act` warnings remain in full-suite output. `git diff --check -- mobile` passed; `mobile/app.json` has no diff.

## Undone

None.

## Notes for S2 / W2 / D2

- **S2:** mobile requests config only for TURN credentials expiring within one hour, waits ≤2 s, resumes only after binding metadata, falls back on timeout/`unavailable`, reconnects `4010` immediately, and arms watchdog only after the first `ping`. Older servers degrade through timeouts/fresh offers/socket observation. New mobile uses headers; server query-token compatibility remains for old phones.
- **W2:** shared copy is `You've been signed out.` and composed `Live updates paused — Retry`. Path kinds are `direct|stun|relay|unknown`; RTT is milliseconds. Existing daemon-update dialog/copy is unchanged.
- **D2:** restart offers retain live signal id/nonce/generation and carry outer `ice_restart: true`; after ten seconds mobile closes/fresh-builds. Client failure emits `rtc.close` when signalling is available. PTY input is ≤16 KiB and `pty_gap {offset}` uses history recovery.
