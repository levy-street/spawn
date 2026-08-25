> Orchestrator note (2026-08-26): the "Notes for S3 / M4" section below misquotes several copy strings and the alert envelope. The committed code uses the CONTRACT-phaseD strings word for word (verified by grep against mobile): dialog body "Every other browser and phone signed in to this account will be signed out. This one stays signed in.", confirm verb "Sign out everywhere", the capacity warning "This host is close to its limit of approving devices ({used} of {max})…", the three undelivered reason sentences, and the `type: "trust", event: "host.pin_undelivered"` envelope. Trust the code and IMPL-mobile-D.md's copy list.

# IMPL web D — W4 web hygiene

Implemented Phase D web hygiene in `web/` only. No git write commands were run.

## Files

Modified:

- `web/src/app/hosts/[id]/page.tsx`
- `web/src/components/nav/AppShell.tsx`
- `web/src/components/settings/AccessPanel.tsx`
- `web/src/components/settings/AccountPanel.tsx`
- `web/src/lib/access-view.test.ts`
- `web/src/lib/access-view.ts`
- `web/src/lib/alerts.test.ts`
- `web/src/lib/alerts.ts`
- `web/src/lib/api.ts`
- `web/src/lib/browser-host-pins.test.ts`
- `web/src/lib/browser-host-pins.ts`
- `web/src/lib/peer-device-keys.ts`
- `web/src/trust-ux/types.ts`
- `web/tests/e2e/app-mocks.ts`

Added:

- `web/src/components/hosts/host-approving-devices-panel.tsx`
- `web/src/components/hosts/host-pin-undelivered-alerts.tsx`
- `web/src/lib/api.test.ts`
- `web/src/lib/host-pin-hygiene.test.ts`
- `web/src/lib/host-pin-hygiene.ts`
- `web/src/lib/local-account-hygiene.test.ts`
- `web/src/lib/local-account-hygiene.ts`
- `web/tests/e2e/settings-hygiene.spec.ts`

## Checklist

### 1. Sign out everywhere

- Added `auth.signOutEverywhere()`: `POST /api/auth/sign-out-everywhere`, body `{}`, response `{ access_token }`.
- Added Settings action, exact confirmation copy, success toast `Signed out everywhere else.`, and a disabled 404 state `Not available on this server yet.`
- The browser adopts the server-set cookie. Nothing stores the returned token.

Tests:

- `sign out everywhere posts an empty body and adopts the returned client contract`
- Playwright: `Settings signs out every other session and keeps this one signed in`
- Playwright: `Settings explains when sign out everywhere is unavailable`

### 2. Session renewal

- Confirmed every `api()` fetch sends `credentials: "include"`.
- Documented that browser-native `Set-Cookie` adoption stays transparent to the abstraction; no timer or token state was added.

Test:

- `an ordinary response stays transparent to renewed session-cookie adoption`

### 3. Pin capacity and undelivered approvals

- Added delivery metadata plus `capacity.used` / `capacity.max`, retaining old `string[]` responses as fallback.
- Host detail now shows `Approving devices`, capacity, the exact warning at `used >= 28`, and `Not delivered`.
- Undelivered rows are excluded from the trusted-device ID list.
- `host.pin_undelivered` from `/ws/alerts` maps exact reason sentences to a toast and invalidates pin queries.
- Verified W3 already supplies exact `pin_limit` copy on approval surfaces.

Tests:

- `host approval delivery metadata keeps the old array response as its fallback`
- `warns at 28 devices, not before, with the exact recovery copy`
- `maps every wire reason to the exact toast sentence`
- `accepts a host approval that the daemon could not adopt`

### 4. Stale devices

- Access filters live non-root devices, sorts by `last_seen` descending, and places absent/invalid dates last.
- More than 60 days produces `Not seen since {date}`; exactly 60 does not.
- Rename and Remove remain in the overflow. Nothing auto-removes a device.

Test:

- `sorts live devices by last seen and badges only those beyond 60 days`

### 5. Local store hygiene

- Added `Remove this account from this browser` in the current-device overflow with the exact confirmation.
- Wipe removes the scoped identity, active host approvals, peer material, and firsthand root knowledge. Identity is removed last.
- It preserves revocation tombstones, the trust-revision floor, and other accounts.
- Browser host approvals have independent 256-record active and tombstone caps.
- Peer active capacity is scoped per account and origin.
- History now says `Removal is permanent; this only clears the list.`

Tests:

- `wipes one account while preserving other accounts, removal records, and revision floors`
- `counts active records separately so 256 tombstones never starve live capacity`

### 6. Test coverage

- Bun coverage includes account-scoped wipe, preserved tombstones/floor, separate caps, stale sort/badge, capacity threshold, alert mapping, sign-out client call, old pins fallback, and transparent session renewal.
- Added mocked Playwright success and 404 settings flows.

## Verification

### Lint and typecheck

```text
cd web && npm run lint && npx tsc --noEmit
```

Pass:

```text
Checked 358 files in 212ms. No fixes applied.
Found 4 warnings.
Found 1 info.
```

The five diagnostics are existing/W3 diagnostics in passkey flows, session view, SettingsDialog, presentation, and onboarding. TypeScript had no errors.

### Bun

```text
npm_config_cache=/private/tmp/spawn-web-npm-cache npx --package=bun bunx bun test src
```

Pass:

```text
1106 pass
0 fail
4354 expect() calls
Ran 1106 tests across 75 files. [2.21s]
```

### Production build

```text
SPAWN_API_PROXY_TARGET=http://127.0.0.1:9 npm run build
```

Pass: compiled successfully and generated all 17 static pages.

### Playwright

```text
SPAWN_E2E_BASE_URL=http://127.0.0.1:3302 npm run test:e2e -- tests/e2e/settings-hygiene.spec.ts
```

Environment-blocked before either test body ran:

```text
FATAL ... MachPortRendezvousServer.<pid>: Permission denied (1100)
2 failed
```

The dev-server attempt also hit repeated Watchpack `EMFILE` errors. The production build and mocked specs are present; Chromium launch is the remaining limitation.

### Whitespace

```text
git diff --check -- web
```

Pass, no output.

## Undone + why

- No functional item is intentionally omitted.
- Playwright could not execute because the worker environment denied Chromium's Mach-port rendezvous.
- The concurrent server was not available. Responses/events are mocked and schema-tested; pins keep the documented old-array fallback and sign-out exposes the documented 404 state.

## Notes for S3 / M4

### Endpoints and fields

- `POST /api/auth/sign-out-everywhere`
  - request `{}`
  - response `{ "access_token": "..." }`
  - response must set the renewed session cookie
  - 404 drives `Not available on this server yet.`
- Every ordinary response may renew the cookie; web uses `credentials: "include"`.
- `GET /api/hosts/{host_id}/pins` preferred shape:

```json
{
  "pins": [{
    "browser_device_id": "uuid",
    "delivered": true,
    "undelivered_reason": null
  }],
  "capacity": { "used": 1, "max": 32 }
}
```

- Web accepts `device_id` as a temporary alias and old `string[]`; S3 should emit `browser_device_id`.
- `undelivered_reason`: `pin_limit`, `invalid_chain`, `other`.
- Undelivered entries stay listed and are not treated as adopted approvals.
- Device rows depend on `id`, `name`, `status`, `last_seen`; stale is strictly over 60 days.

### Alert event

```json
{
  "type": "host.pin_undelivered",
  "host_id": "uuid",
  "browser_device_id": "uuid",
  "reason": "pin_limit",
  "at": "ISO-8601 timestamp"
}
```

Exact toast sentences:

- `pin_limit`: `This machine has too many approving devices. Remove an old one and approve again.`
- `invalid_chain`: `This machine could not verify the approval. Approve it again from a device you trust.`
- `other`: `This machine did not receive the approval. Approve it again.`

### Exact copy dependencies

- `Sign out everywhere`
- `Sign out everywhere?`
- `This ends every other SPAWN D session. You stay signed in on this browser.`
- `Sign out everywhere else`
- `Signed out everywhere else.`
- `Not available on this server yet.`
- `This machine has many approving devices. Remove one you no longer use before adding another.`
- `Not delivered`
- `Not seen since {date}`
- `Remove this account from this browser`
- `Remove {email} from this browser?`
- `Its device identity, host approvals, and cached keys for this account are deleted here. Removed devices stay removed everywhere.`
- `Remove account`
- `Removal is permanent; this only clears the list.`

### Trust invariants

- Nothing auto-removes.
- Account removal deletes only active local material for that account and origin.
- Revocation tombstones and the trust-revision floor survive removal and history clearing.
- Active and tombstone capacity is independent.
