# IMPL — mobile D (M4: Phase D hygiene)

Implemented the Phase D mobile hygiene workstream in `mobile/` only. No git write command was run.

## Files

### Session renewal and sign out everywhere

- `mobile/src/app/_layout.tsx`
- `mobile/src/lib/session-renewal.tsx`
- `mobile/src/lib/__tests__/session-renewal.test.ts`
- `mobile/src/data/api/auth-token.ts`
- `mobile/src/data/api/client.ts`
- `mobile/src/data/api/endpoints/auth.ts`
- `mobile/src/data/api/schemas/auth.ts`
- `mobile/src/data/queries/auth.ts`
- `mobile/src/data/api/__tests__/client.test.ts`
- `mobile/src/data/api/__tests__/endpoints.test.ts`
- `mobile/src/data/api/__tests__/schemas.test.ts`
- `mobile/src/components/settings/account-panel.tsx`
- `mobile/src/components/settings/__tests__/panel-behavior.test.tsx`

### Pin capacity and undelivered approvals

- `mobile/src/components/hosts/host-detail-screen.tsx`
- `mobile/src/components/hosts/host-detail-view.tsx`
- `mobile/src/components/hosts/__tests__/host-views.test.tsx`
- `mobile/src/components/hosts/__tests__/screen-headers.test.tsx`
- `mobile/src/data/api/endpoints/trust.ts`
- `mobile/src/data/api/schemas/trust.ts`
- `mobile/src/data/queries/hosts.ts`
- `mobile/src/data/queryKeys.ts`
- `mobile/src/data/realtime/alert-socket.ts`
- `mobile/src/data/realtime/provider.tsx`
- `mobile/src/data/realtime/pin-undelivered-events.ts`
- `mobile/src/data/realtime/__tests__/alert-socket.test.ts`
- `mobile/src/components/alerts/alert-presenter.tsx`
- `mobile/src/components/alerts/__tests__/alert-presenter.test.tsx`

### Stale devices and local store hygiene

- `mobile/src/data/api/schemas/devices.ts`
- `mobile/src/components/settings/browser-device-row.tsx`
- `mobile/src/components/settings/browser-devices-panel.tsx`
- `mobile/src/components/settings/__tests__/browser-device-row.test.tsx`
- `mobile/src/data/trust/host-pins.ts`
- `mobile/src/data/trust/local-account.ts`
- `mobile/src/data/trust/__tests__/host-pins.test.ts`
- `mobile/src/data/trust/__tests__/local-account.test.ts`

## Checklist

### 1. Session renewal

- `captureFromResponse` is now run by the shared API client for every HTTP response, before success/error parsing, rather than only through login endpoint callbacks. A renewed `spawn_session` cookie is therefore adopted from non-login responses, including error responses that carry one.
- Stored tokens now retain decoded numeric `iat` and `exp` metadata. The half-life predicate renews at `iat + ((exp - iat) / 2)`, but does not try to renew an already expired token.
- `SessionRenewal` runs once when the signed-in app shell loads and again whenever the app becomes active. It deduplicates concurrent checks.
- When the token has crossed its half-life it calls `POST /api/auth/session/renew`, stores `access_token`, and otherwise does nothing.
- A 404 is treated as an older server and ignored. Other failures do not sign the user out; the existing authenticated request pre-flight expiry check remains the last-resort hard sign-out.

Tests:

- `adopts a renewed cookie from a non-login response`
- `triggers at half-life on a foreground check and stores the returned token`
- `ignores the renewal endpoint on an older server`
- `renews the current session and keeps the caller signed in after signing out elsewhere`

### 2. Sign out everywhere

- Settings → Account now has `Sign out everywhere` using the existing confirmation-sheet and toast primitives.
- The successful response token is explicitly adopted so the caller stays signed in after the epoch bump.
- A 404 replaces/disables the action with `Not available on this server yet.`

Tests:

- `sign out everywhere confirms, preserves this session, and reports success`
- `sign out everywhere becomes unavailable after an old-server 404`
- `renews the current session and keeps the caller signed in after signing out elsewhere`

### 3. Pin capacity and undelivered approvals

- Host detail fetches the host's pins and shows the `used / max` approval capacity plus the approving-device list.
- At `used >= 28` it shows the exact contract warning.
- A pin with `delivered: false` is marked `Not delivered`.
- Trust/admission probes only consume delivered pins; an undelivered server record cannot become local trust.
- The alert socket strictly parses `host.pin_undelivered`; the realtime provider publishes it; the alert presenter emits the exact host/reason toast and invalidates the host-pins query.
- The existing M3 `pin_limit` approve-surface message remains exact and its tests remain green.
- Legacy servers returning a bare UUID pin array remain readable. A 404 leaves the optional host-detail approval section absent rather than breaking host detail.

Tests:

- `warns at 28 approvals and marks a pin the host did not receive`
- `round-trips trust response JSON` (Phase D object and legacy UUID array)
- `parses a host pin delivery failure`
- `maps an undelivered trust event to the exact host toast`
- `turns the alerts-socket undelivered event into a toast`

### 4. Stale devices and last-seen parity

- The Access device panel sorts non-root live devices by `last_seen_at` descending, with missing values last.
- Every row renders `Seen {relative}`; older records fall back to `created_at` so the row still has truthful timing.
- Devices unseen for strictly more than 60 days show `Not seen since {date}`.
- Devices with no trusted hosts show `Waiting for approval`.
- Rename and Remove remain in the row action sheet. No stale device is automatically removed.

Tests:

- `sorts live devices by last seen and badges only those beyond 60 days`
- `renders last seen, waiting state, stale badge, and keeps Rename/Remove in actions`
- `round-trips browser-device and pairing response JSON`

### 5. Local store hygiene

- Access → This phone now offers `Remove this account from this phone` with the exact contract confirmation copy.
- Cleanup is account-scoped. It removes that account's active host approvals, device identity/registration, and any account-scoped rows in local `peer_device_keys` and `root_knowledge` tables when those tables exist.
- It deliberately never deletes revocation tombstones and never touches the trust-revision floor.
- `deleteAccount` and identity reset now remove active host approvals only. Tombstones survive both account deletion and local removal.
- The 256-record host-pin limit is enforced against active records only; tombstones are counted separately and do not consume active capacity.
- The current checkout has no peer-key/root-knowledge writers yet. The cleanup is forward-compatible with account-scoped tables if/when those stores are introduced; it does not invent or migrate a schema.
- Clear history now includes `Removal is permanent; this only clears the list.`

Tests:

- `keeps tombstones through account cleanup`
- `counts active records separately so 256 tombstones do not consume the cap`
- `is account-scoped and preserves tombstones plus the trust-revision floor`

### 6. Test coverage

All requested cases are covered by the named Jest tests above: non-login cookie adoption, half-life renewal with fake time, sign-out-everywhere including 404 fallback, account-scoped wipe and invariants, separate active/tombstone caps, stale sorting/badging, capacity threshold, realtime undelivered-to-toast mapping, and row last-seen rendering.

One early isolated row test needed the existing safe-area provider wrapper and passed after that harness fix. A multi-suite targeted Jest invocation printed all passing results but retained an open handle, so it was interrupted; the required full `npm run ci` subsequently exited normally with all 233 suites green. No untouched full-suite flake remained to rerun.

## Verification

`cd mobile && npm run ci` — exit 0:

```text
Checked 694 files in 223ms. No fixes applied.
Test Suites: 233 passed, 233 total
Tests:       1608 passed, 1608 total
Snapshots:   2 passed, 2 total
Time:        18.07 s
Ran all test suites.
```

The run emitted the repository's existing Expo Go notification warning and existing React `act` / TerminalOverlay warnings; neither failed a suite.

`git diff --check -- mobile` — exit 0, no output.

## Undone

None for M4. Older-server fallbacks are intentionally limited to the documented behavior: session renewal 404 is ignored, sign-out-everywhere 404 becomes unavailable, and a missing legacy pins-capacity shape leaves the optional capacity UI absent.

## Notes for S3 / W4

### Endpoints and fields

- Any authenticated response may carry `Set-Cookie: spawn_session=<new token>`; mobile depends on the cookie name `spawn_session` and on a JWT with numeric `iat` and `exp` claims to calculate the half-life.
- `POST /api/auth/session/renew`, authenticated, empty body:
  - success: `200 { "access_token": "<fresh session token>", "expires_at": "<iso>" }` plus the renewed cookie;
  - compatibility: 404 means unsupported and is ignored;
  - other failures are not interpreted as unsupported.
- `POST /api/auth/sign-out-everywhere`, authenticated, empty body:
  - success: `200 { "access_token": "<fresh token for THIS session>" }` plus the cookie;
  - 404 makes the UI show the unavailable state.
- Browser-device rows depend on `last_seen_at: <iso> | null`. The schema also accepts `approval_requested_at: <iso> | null`, `revoked_by_device_id: <uuid> | null`, and optional `is_root` for parity/compatibility. Waiting state is currently derived from `trusted_host_count === 0`.
- `GET /api/trust/hosts/{host_id}/pins` preferred response:

  ```json
  {
    "pins": [
      {
        "browser_device_id": "<uuid>",
        "delivered": false,
        "undelivered_reason": "pin_limit"
      }
    ],
    "capacity": { "used": 28, "max": 32 }
  }
  ```

  `undelivered_reason` is `null | "pin_limit" | "invalid_chain" | "other"`. Mobile temporarily tolerates `device_id` instead of `browser_device_id` and the legacy bare UUID array; S3 should emit `browser_device_id` and the Phase D object. Pins marked undelivered are displayed but excluded from local trust/admission pin lists.

### Realtime event

- `/ws/alerts` uses the existing trust wrapper. Mobile expects exactly:

  ```json
  {
    "type": "trust",
    "event": "host.pin_undelivered",
    "host_id": "<uuid>",
    "browser_device_id": "<uuid>",
    "reason": "pin_limit | invalid_chain | other"
  }
  ```

  `host_id`, `browser_device_id`, and the closed reason enum are required. Unknown/malformed frames are dropped.

### Exact shared copy

- `Sign out everywhere`
- `Sign out everywhere?`
- `Every other browser and phone signed in to this account will be signed out. This one stays signed in.`
- Confirm: `Sign out everywhere`; cancel: `Cancel`
- `Signed out everywhere else.`
- `Not available on this server yet.`
- `This host is close to its limit of approving devices ({used} of {max}). Remove devices you no longer use under Access.`
- `This host has reached its limit of approving browsers (32). Remove old devices under Access, then try again.`
- `Not delivered`
- `The approval didn't reach {host}. {reason sentence}` split in mobile into toast message plus detail.
- `pin_limit`: `This host has reached its limit of approving browsers (32). Remove old devices under Access, then try again.`
- `invalid_chain`: `{host} could not verify the approval. Approve the device again from a device {host} already trusts.`
- `other`: `Try approving again; if it keeps failing, run spawnd doctor on {host}.`
- `Seen {relative}`
- `Waiting for approval`
- `Not seen since {date}`
- Overflow actions: `Rename`, `Remove`
- `Remove this account from this phone`
- `Remove {email} from this phone?`
- `Its device identity, host approvals, and cached keys for this account are deleted here. Removed devices stay removed everywhere.`
- Confirm: `Remove`; cancel: `Cancel`
- `Removal is permanent; this only clears the list.`

Trust invariants relied on by mobile and required across S3/W4: revocation tombstones and the trust-revision floor survive every wipe; tombstones do not consume active-record capacity; stale records are never removed automatically; an undelivered pin never becomes trust.
