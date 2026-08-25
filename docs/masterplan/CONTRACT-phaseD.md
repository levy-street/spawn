# CONTRACT — Phase D hygiene wire shapes (session renewal, sign-out-everywhere, pin capacity, stale devices)

Binding for server (S3 §C), daemon (D3), web (W4), mobile (M4). Source: docs/MASTERPLAN.md Part 4,
docs/masterplan/AUDIT-lifecycle.md §B/§D. Invariants: the deny-list is add-only and permanent;
revocation is never weakened or silently automated; pruning never re-admits.

## 1. Session renewal (F4)
- Any authenticated HTTP request whose session token is older than half its TTL gets a fresh
  `Set-Cookie: spawn_session=<new token>` on the response (same epoch; same attributes as login).
- `POST /api/auth/session/renew` (auth, empty body) → `200 { "access_token": "<fresh session token>", "expires_at": "<iso>" }` + the cookie. 401 when the epoch no longer matches.
- Web: nothing to store — the cookie renews itself. Belt-and-braces: on app load, if `/api/me`
  succeeded, nothing else. (Do NOT add a timer.)
- Mobile: `captureFromResponse` must adopt a renewed `spawn_session` cookie from ANY response
  (verify it already does for every request path; fix if only login does), AND on foreground/app
  load, when the stored token's `exp` is within half its lifetime, call `session/renew` and store
  the new token. Old servers: 404 → ignore.

## 2. Sign out everywhere (F7)
- `POST /api/auth/sign-out-everywhere` (auth, empty body) → `200 { "access_token": "<fresh token for THIS session>" }` + cookie. Every other session (browsers, phones) is signed out (epoch bump); the caller stays signed in with the new token.
- UI (both): Settings → account section → button `Sign out everywhere`; confirm dialog title
  `Sign out everywhere?`, body `Every other browser and phone signed in to this account will be signed out. This one stays signed in.`, confirm verb `Sign out everywhere`, cancel `Cancel`; success toast `Signed out everywhere else.` Old server: 404 → the button shows `Not available on this server yet.`

## 3. Daemon token rotation (F3)
- `registered` ack may carry `"access_token": "<fresh daemon token>"` when the current token expires within 30 days; the daemon persists it through its credential-commit path and uses it on the next connect.
- Handshake refusal for an identifiable host: close 1008 with reason `token_expired` | `token_revoked` | `token_invalid`; `last_disconnect.reason = "auth_rejected"` on the host row (the host page panel's auth-rejected case).

## 4. Pin capacity (F1, F2)
- Revoking a device deletes its `HostBrowserPin` rows (deny-list untouched). Both server cap checks count live pins only.
- Pins endpoint (the existing `GET /api/trust/hosts/{host_id}/pins` — confirm the path in `routes/trust_bundle.py`) gains `"capacity": { "used": n, "max": 32 }` and per pin `"delivered": bool`, `"undelivered_reason": null | "pin_limit" | "invalid_chain" | "other"`.
- Daemon → server frames: `host.pin_adopt_failed { "browser_device_id": uuid, "reason": "pin_limit"|"invalid_chain"|"other" }` and `host.pin_adopted { "browser_device_id": uuid }`.
- Trust event on `/ws/alerts`: `host.pin_undelivered { "host_id": uuid, "browser_device_id": uuid, "reason": … }`.
- UI (both):
  - capacity warning when `used >= 28`: `This host is close to its limit of approving devices ({used} of {max}). Remove devices you no longer use under Access.`
  - `pin_limit` copy (already in CONTRACT-phaseC §6): `This host has reached its limit of approving browsers (32). Remove old devices under Access, then try again.`
  - undelivered: banner/toast `The approval didn't reach {host}. {reason sentence}` where reason sentences are: pin_limit → the pin_limit copy above; invalid_chain → `{host} could not verify the approval. Approve the device again from a device {host} already trusts.`; other → `Try approving again; if it keeps failing, run spawnd doctor on {host}.` The pins list shows `Not delivered` on that pin.

## 5. Stale devices (F5, F6)
- Both device panels: sort live devices by `last_seen_at` desc; a device unseen for more than 60 days shows the badge `Not seen since {date}`; the row's overflow keeps Rename / Remove; nothing is ever auto-revoked.
- Mobile gains last-seen parity with web (`Seen {relative}` on every row; `Waiting for approval` state where web shows it).

## 6. Local store hygiene (F8, F11)
- Both: Access → this device → `Remove this account from this {browser|phone}` (confirm: `Remove {email} from this {browser|phone}? Its device identity, host approvals, and cached keys for this account are deleted here. Removed devices stay removed everywhere.`) → wipes identity + host pins + peer keys + root knowledge FOR THAT ACCOUNT ONLY, preserving local revocation tombstones and the trust-revision floor. Tombstones are excluded from the active-record caps (count active and tombstone records separately).
- "Clear history" (roster tombstone prune) copy gains one line: `Removal is permanent; this only clears the list.`
