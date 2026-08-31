# W3 Phase C implementation report — web

Date: 2026-08-25

Scope: `web/**` only. No server, daemon, or mobile files were touched. No git-writing commands were run.

## Files changed

Modified:

- `web/src/app/device/page.tsx`
- `web/src/app/download/page.tsx`
- `web/src/app/hosts/[id]/page.tsx`
- `web/src/app/legion/page.tsx`
- `web/src/app/login/page.tsx`
- `web/src/components/access/number-check.tsx`
- `web/src/components/auth/AuthGate.tsx`
- `web/src/components/brand/press.tsx`
- `web/src/components/hosts/connect-host.tsx`
- `web/src/components/legion/LegionHostCard.tsx`
- `web/src/components/legion/LegionHostDetail.tsx`
- `web/src/components/onboarding/onboarding-flow.tsx`
- `web/src/components/onboarding/step-machine.test.ts`
- `web/src/components/onboarding/step-machine.ts`
- `web/src/lib/alerts.test.ts`
- `web/src/lib/alerts.ts`
- `web/src/lib/api.ts`
- `web/src/lib/platform.ts`
- `web/tests/e2e/app-mocks.ts`

Added:

- `web/src/components/hosts/host-health-panel.tsx`
- `web/src/lib/device-approval-stash.test.ts`
- `web/src/lib/device-approval-stash.ts`
- `web/src/lib/host-health.test.ts`
- `web/src/lib/host-health.ts`
- `web/src/lib/pairing-errors.test.ts`
- `web/src/lib/pairing-errors.ts`
- `web/src/lib/setup-claims.test.ts`
- `web/src/lib/setup-claims.ts`
- `web/tests/e2e/setup-claims.spec.ts`

## Per-item checklist

### 1. Setup claim mint + checklist — DONE

- `ConnectHostSection` mints after the authenticated user is known.
- A live claim produces `curl -fsSL <origin>/install.sh | sh -s -- --setup <token>`.
- POST 404/405 detects an older server and restores the previous plain install command and host-poll flow.
- Claims re-mint at `expires_at` while mounted.
- Claim GET polls every 2 seconds while visible, pauses while `document.hidden`, and refreshes on visibility return.
- `host.pair_requested` and `host.pair_resolved` alert frames trigger low-latency claim refetches; polling remains authoritative.
- The four milestones derive from copy click, claim `ready`, claim/local `approved`, and a matching online host. Claim `host_id` wins; otherwise the prior newly-online-host behavior is retained.
- `onHostOnline` fires once after the Online milestone has a short paint beat, preserving onboarding's done animation/workspace summon.
- Exact 60-second stalled hints and a 30-second elapsed waiting hint are present.

Pinning unit tests:

- `deriveSetupChecklist › moves pending, ready, approved, and online through the four milestones`
- `deriveSetupChecklist › does not invent progress for an unbound failed claim`
- `deriveSetupChecklist › keeps a bound failure at registered without implying approval`
- `deriveSetupChecklist › local approval advances immediately while the dependable claim poll catches up`
- `setupChecklistStalledHint › waits 60 seconds, then uses the exact shared hint for each transition`
- `setupChecklistStalledHint › terminal and online states never show a stale waiting hint`
- `parseAlertFrame › accepts setup-claim host pairing events without ever carrying the token`

Pinning Playwright test: `setup claim advances inline approval through the existing onboarding done beat`.

### 2. Inline approve card — DONE

- A `ready` claim feeds `approval_ref` into the existing `PairingCodeForm` lookup path.
- With no `#k=`, the existing `NumberCheck` full-fingerprint comparison frame is used. No shorter comparison was introduced.
- The exact shared lead sentence is rendered.
- Approval advances the local checklist immediately to Approved; the claim poll catches up dependably.
- Typed-code entry remains below the inline review.
- The existing trust ceremony is unchanged: exact fragment match gives one Approve action, fragment mismatch/malformed input is terminal, and absent fragment requires the full fingerprint comparison.

Pinning Playwright test: `setup claim advances inline approval through the existing onboarding done beat`.

### 3. Approve-surface error catalogue — DONE

- `/device` and inline review map `expired`, `denied`, `key_conflict`, `pin_conflict`, and `pin_limit` from pending, approve, and `claim.failed.error`.
- Nested FastAPI detail shapes and raw messages are normalized. Raw `user code is expired` cannot reach the screen.
- `denied` uses `The approval was declined in the browser. Nothing was registered.` from DESIGN-daemon-ux §2.4; CONTRACT §6 does not separately list denied.

Pinning unit tests:

- `pairing error catalogue › maps every terminal wire error to the exact shared copy`
- `pairing error catalogue › never leaks the server's raw expired-code string`
- `pairing error catalogue › recognizes nested FastAPI detail shapes`
- `pairing error catalogue › leaves unrelated network and validation errors alone`

Pinning Playwright tests:

- `expired typed codes use the catalogue instead of the raw server string`
- `key_conflict on /device shows the exact three-option catalogue`

### 4. Fragment survival through AuthGate/OAuth — DONE

- Before redirecting an unauthenticated `/device` visit, `AuthGate` writes `{ref|code, k, at}` to tab-scoped `sessionStorage` under `spawn:device-approval`.
- Redirect `next` contains only path + query; the fragment is never sent.
- Login runs `safeNext`, strips fragments defensively, passes the validated value to OAuth `returnTo`, and uses it after password login.
- `/device` consumes the stash only when needed, restores identifier plus exact key, and clears it immediately.
- Entries older than 30 minutes are ignored/cleared. A stored key is never joined to a different URL identifier.
- Storage failures preserve an identifier-only fallback, which requires full-fingerprint comparison.
- After approval, active and archived workspaces are checked. A truly zero-workspace account receives `Continue setup` to `/onboarding`.

Pinning unit tests:

- `device approval session stash › stashes ref + fragment and restores them after a redirect`
- `device approval session stash › restores an older code path when the callback URL has no identifier`
- `device approval session stash › ignores and clears entries older than 30 minutes`
- `device approval session stash › never joins a stored key to a different approval identifier`
- `device approval session stash › does not stash unrelated routes or identifier-free device pages`

Pinning Playwright tests:

- `AuthGate and password login restore the tab-scoped approval fragment`
- `OAuth receives the validated device path and query, never its fragment`

### 5. Onboarding learns an in-flight ceremony — DONE

- `deriveStep` completes only for an online host, plus existing skip/legacy compatibility paths.
- An approved-but-offline host remains on the host hand-off.
- `ConnectHostSection` receives it as a resumed ceremony, suppresses reinstall instructions, begins at Approved, and waits for Online.
- A `ready` claim stays on the mounted surface and becomes the inline approval frame.

Pinning unit test: `deriveStep › keeps an approved-but-offline host in the host hand-off instead of reinstalling`.

Pinning Playwright test: `setup claim advances inline approval through the existing onboarding done beat`.

### 6. Host “Something wrong?” panel — DONE

- The host page and Legion detail/card use a shared mini-doctor component.
- Offline selection order is never-connected, auth-rejected, stale-version, then plain-offline.
- The one remedy command is copyable.
- Missing `last_disconnect` is accepted and selects plain-offline.
- Online hosts collapse to version plus existing live indicators.

Pinning unit tests:

- `hostHealthPanel › selects never-connected before every other offline signal`
- `hostHealthPanel › selects auth rejection and its one login remedy`
- `hostHealthPanel › selects stale version for available and failed updates while offline`
- `hostHealthPanel › missing last_disconnect degrades to the plain-offline case`
- `hostHealthPanel › online collapses to version and has no command`

### 7. Permanent Add a machine surface — DONE

- Legion has a permanent `Add a machine` button/dialog using `ConnectHostSection`; it owns and mints its claim.
- The multi-account line appears under every web install command found: claim/onboarding/add-machine, download, and landing-page install command. It is not put under repair/update commands.
- The permanent entry reuses the same claim surface pinned by `setup claim advances inline approval through the existing onboarding done beat`.

### 8. Waiting states never strand — DONE

- Claim/checklist waits show elapsed status after 30 seconds and exact recovery help after 60 seconds.
- Pairing lookup/approval waits track elapsed time, expose cancel after 60 seconds, abort where supported, and ignore stale completions by operation generation.
- Fragment-verification and retry waits have the same 30/60-second treatment.

Pinning unit test: `setupChecklistStalledHint › waits 60 seconds, then uses the exact shared hint for each transition`.

Pinning Playwright test: `the checklist adds its exact stalled escape after 60 seconds`.

### Tests — PARTIAL (all authored; browser execution blocked by sandbox)

- Unit coverage was added for claim state/hints, catalogue, stash, host panel, alert events, and approved-offline onboarding derivation.
- Six Playwright scenarios were added with app-mocks: inline approval through done, 60-second hint, expired copy, password fragment survival, OAuth returnTo without fragment, and key-conflict copy.
- All unit tests pass. Playwright was attempted twice, but this environment prevented a browser from launching; see Verification.

## Verification output tails

### Lint + TypeScript

Command: `cd web && npm run lint && npx tsc --noEmit`

Exit 0. Tail/summary:

```text
Checked 350 files in 183ms. No fixes applied.
Found 4 warnings.
Found 1 info.
```

The five diagnostics are pre-existing/outside this implementation: `src/lib/passkey-flows.test.ts` (`useIndexOf` info), `src/components/session/session-view.tsx` (unused `useRef`), `src/components/settings/SettingsDialog.tsx` (unused `Server`), `src/trust-ux/presentation.html` (1.2 MiB size), and `tests/e2e/onboarding.spec.ts` (unused `WORKSPACE_ID`). TypeScript emitted no output.

### Bun unit suite

Command: `cd web && npm_config_cache=/private/tmp/spawn-web-npm-cache npx --package=bun bunx bun test src`

Exit 0. Exact tail:

```text
1098 pass
0 fail
4320 expect() calls
Ran 1098 tests across 72 files. [1.94s]
```

Baseline was 1076 pass / 0 fail; this stream adds 22 passing unit tests.

### Production build

Command: `cd web && SPAWN_API_PROXY_TARGET=http://127.0.0.1:9 npm run build`

Exit 0. Tail:

```text
✓ Compiled successfully in 3.1s
✓ Generating static pages (17/17)
```

The final route table included `/device`, `/hosts/[id]`, `/legion`, `/login`, and `/onboarding`.

### Diff whitespace check

Command: `git diff --check -- web`

Exit 0; no output.

### Playwright

The development-server attempt hit this sandbox's file-watch limit:

```text
Watchpack Error ... EMFILE: too many open files
```

After a successful production build/server, every Chromium case failed before test code ran (`0ms`) because macOS denied browser IPC setup:

```text
FATAL ... MachPortRendezvousServer.<pid>: Permission denied (1100)
```

This is an execution-environment limitation, not an assertion failure. Five scenarios existed for that run; the sixth OAuth-returnTo case was added afterward and passed lint/typecheck/build. Rerun in a Playwright-capable environment:

```text
cd web && npm run test:e2e -- tests/e2e/setup-claims.spec.ts
```

## Undone / cut

- No implementation item was cut.
- Runtime Playwright confirmation is the sole partial deliverable. Chromium cannot start here due to Mach port permission denial; the dev fallback also exceeds the watcher limit.
- Full legacy e2e was not attempted after the target suite could not launch a browser.

## Notes for S3 / M3 / D3

### Endpoints and wire fields consumed

1. `POST /api/setup/claims`
   - Authenticated request, body exactly `{}`.
   - Success may be 201 and returns `{token, expires_in, expires_at}`.
   - Web validates token length 43, positive integer `expires_in`, and string `expires_at`.
   - 404/405 intentionally means old-server fallback.

2. `GET /api/setup/claims/{token}`
   - Polled every 2 seconds while visible.
   - Exact fields: `status`, `approval_ref`, `host_name`, `os`, `host_key_fingerprint`, `host_id`, `error`, `expires_at`.
   - Status: `pending | ready | approved | failed`.
   - Error: `expired | denied | key_conflict | pin_conflict | pin_limit`.
   - `approval_ref` drives pending lookup; `host_id` drives exact online-host matching.
   - Claim `host_key_fingerprint` is display data only and does not weaken approval; the review uses existing `/pending` material/local derivation.

3. Existing `POST /api/auth/device/pending`
   - Inline sends `{approval_ref}`; typed fallback sends `{user_code}`.
   - Existing response must retain approval nonce and host public-key material used for full-fingerprint verification.
   - Catalogue codes may arrive as API code/string/message/detail or nested `{detail: {code|error|message}}`.

4. Existing `POST /api/auth/device/approve`
   - Existing signed body is unchanged: identifier, approval nonce, host algorithm/public key/fingerprint, browser device id/algorithm/public key/fingerprint, and signature.
   - Catalogue errors are mapped from this endpoint too.

5. Existing `GET /api/hosts` and `GET /api/hosts/{id}`
   - Claim completion consumes `id` and `status` (`online | offline`).
   - Mini-doctor consumes `name`, `status`, `last_seen_at`, `version`, `update`, optional `last_disconnect`.
   - `last_disconnect`: `{at: string|null, reason: socket_closed|superseded|keepalive_timeout|auth_rejected|server_restart|stale|null}`; whole field may be absent/null.
   - Existing `update` fields: `state`, `latest_version`, `error`, `requested_at`; stale-version is `available` or `failed` while offline.
   - Per contract, server derives Online only for an open daemon socket with `last_seen_at` within 90 seconds.

6. Existing active and archived workspace-list endpoints are read after approval so `Continue setup` appears only at zero total workspaces.

### Alert events consumed

`/ws/alerts` trust frames must forward exact events/payloads:

- `host.pair_requested`: `approval_ref`, `host_name`, `os`, `host_key_fingerprint`.
- `host.pair_resolved`: `approval_ref`, `outcome`, `host_id`; outcome is `approved | denied | expired | key_conflict | pin_conflict | pin_limit`.

The parser expects the existing `type: "trust"` envelope and snake_case fields. The claim token must never appear. Events only wake the claim GET because they carry no token.

### Daemon/install dependencies

- Minted command: `curl -fsSL <origin>/install.sh | sh -s -- --setup <token>`.
- Old/no-claim command: `curl -fsSL <origin>/install.sh | sh`.
- S3 install routing must pass `--setup TOKEN` to `SPAWN_SETUP_TOKEN`/daemon `--setup-token` per CONTRACT §4.
- D3 sends `setup_token` on device start and obeys `DevicePossessionResponse.attended`; web does not consume `attended` directly.
- Multi-account remediation depends on `spawnd possess --new-account` / install `--new-account`.

### Copy strings web depends on (must match M3 word for word)

Install/helper:

- `After installation, run spawnd possess on that machine.`
- `Already running SPAWN D for another account on that machine? Add --new-account.`
- `Add a machine`

Checklist labels:

- `Command copied`
- `Machine registered`
- `Approved`
- `Online`

Checklist 60-second hints:

- `Having trouble? Re-run the install command — it's safe to repeat.`
- `The machine is waiting for your approval below.`
- `Approved. Waiting for the machine to come online — this usually takes a few seconds.`

Inline lead:

- `Fastest: open the link in the machine's terminal — it verifies the identity automatically. Or compare the fingerprint below against the terminal.`

Error catalogue:

- `That code expired. On the machine, run spawnd possess again.`
- `The approval was declined in the browser. Nothing was registered.`
- `This machine was set up before, under a different SPAWN D account, and that account still holds its identity. Nothing was changed.`
- `• To use it under that account: sign in there and approve as usual.`
- `• To hand it to this account: remove the host from the old account's Hosts page first, then run spawnd possess again.`
- `• To keep both accounts on this machine: spawnd possess --new-account`
- `The browser that approved this machine doesn't match its earlier approval. Approve again from a browser you've used with this host before — or remove the host on the web and start fresh.`
- `This host has reached its limit of approving browsers (32). Remove old devices under Access, then try again.`

Host mini-doctor:

- `Something wrong?`
- `SPAWN D hasn't checked in from this machine yet. On it, run: spawnd doctor`
- `{host} can't sign in. On that machine, run: spawnd login`
- `{host} runs {version}. On it, run: spawnd update (or it will self-update when idle).`
- `Last seen {relative} (connection dropped). If the machine is on, run spawnd doctor there.`

Pairing push (S3/M3-owned but event-coupled):

- Title `SPAWN D`
- Body `<host_name> is ready to join your account`

### Trust invariants retained

- Claims grant no approval authority.
- Exact `#k=` match retains the single Approve path.
- Key mismatch/malformed fragments remain terminal refusal.
- Missing fragments always require full-fingerprint comparison.
- `#k=` stays in same-origin tab-scoped `sessionStorage`, never query/OAuth/server requests, and expires locally after 30 minutes.
