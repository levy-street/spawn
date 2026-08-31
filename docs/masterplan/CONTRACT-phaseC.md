# CONTRACT — Phase C wire shapes (setup claims, pairing push, host mini-doctor, install flags)

Binding for the server (S3), daemon (D3), web (W3), and mobile (M3) workers. Every field
below is exact. Additive everywhere; every consumer feature-detects (a server without these
endpoints returns 404 → clients fall back to today's behaviour; a daemon without
`setup_token` support simply does not send it).

Source design: docs/masterplan/DESIGN-daemon-ux.md §2.3 (mechanism + permutations), §2.4
(error catalogue), §2.5 (helper surfaces); docs/masterplan/DESIGN-multiaccount.md §3.
Security frame: docs/TRUST_UX.md §4 — the claim token grants NOTHING. It routes one
notification, pre-fills a lookup the user could already do with the typed code, and
suppresses one `open(1)`. Approval still requires the signed browser approval proof;
possession-before-approval and the `#k=` path are untouched.

## 1. Setup claims (server)

### `POST /api/setup/claims` — authenticated (cookie or Bearer), rate limit 10/min/user
Request body: `{}` (empty object; `extra="forbid"`).
Response 201:
```json
{ "token": "<43-char urlsafe base64, 32 random bytes>", "expires_in": 1800, "expires_at": "<iso8601 utc>" }
```

### `GET /api/setup/claims/{token}` — authenticated; only the minting user may read it
404 for unknown token OR another user's token (indistinguishable). Response 200:
```json
{
  "status": "pending" | "ready" | "approved" | "failed",
  "approval_ref": "<str>" | null,          // set from `ready` onward
  "host_name": "<str>" | null,             // set from `ready` onward (from device/start)
  "os": "<str>" | null,
  "host_key_fingerprint": "<str>" | null,  // display only — same value /pending serves
  "host_id": "<uuid>" | null,              // set when `approved`
  "error": null | "expired" | "denied" | "key_conflict" | "pin_conflict" | "pin_limit",  // set when `failed`
  "expires_at": "<iso8601 utc>"
}
```
State machine: `pending` (minted) → `ready` (a ceremony bound to this token proved possession)
→ `approved` (that ceremony was approved; `host_id` set) | `failed` (`error` set: the bound
ceremony expired/denied/conflicted, or the claim's own 30-min TTL passed with no ceremony →
`error: "expired"`). A token binds at most ONE ceremony (the first `device/start` that carries
it); later starts with the same token are accepted for the daemon (the ceremony proceeds) but
do not rebind the claim.

### `DeviceStartRequest` gains `setup_token: str | null = None` (43 chars when present)
Stored on the `DeviceCode` row (`setup_token` column, nullable, indexed). Unknown/expired
tokens are ignored silently (the ceremony proceeds unattended) — never an error to the daemon.

### `DevicePossessionResponse` gains `attended: bool = False`
`true` iff this ceremony's `setup_token` resolved to a live claim at possession time (the claim
is flipped to `ready` in the same transaction). Old daemons ignore the field.

### Trust events (added to `trust_events.TRUST_EVENTS`, forwarded on `/ws/alerts`)
- `host.pair_requested` `{ "event": "host.pair_requested", "approval_ref": str, "host_name": str, "os": str|null, "host_key_fingerprint": str }` — published to the minting user when the claim goes `ready`.
- `host.pair_resolved` `{ "event": "host.pair_resolved", "approval_ref": str, "outcome": "approved"|"denied"|"expired"|"key_conflict"|"pin_conflict"|"pin_limit", "host_id": str|null }` — published when the bound ceremony resolves.
The token itself NEVER appears in any event or push payload.

## 2. Pairing push (server → phones)
When a claim goes `ready`, push to every `PushDevice` of the minting user (same plumbing as
`send_approval_push`, at most once per ceremony):
- title: `SPAWN D`
- body: `<host_name> is ready to join your account`
- data: `{ "event": "host.pair_requested", "approvalRef": "<approval_ref>" }`
Mobile tap handling: open the fingerprint review pre-filled via
`POST /api/auth/device/pending { "approval_ref": approvalRef }` (existing endpoint). The push
carries no authority; approval is the existing signed ceremony.
Deep link (also usable from a QR or a link): `spawn://device?ref=<approval_ref>` → the same
screen. (`#k=` fragments in a deep link are honoured exactly like web's `/device` route when
present; absent → the fingerprint compare frame — never a weaker check.)

## 3. Host "Something wrong?" data (server → web/mobile)
`HostOut` gains (S2 item 18 — already in the S2 worker's scope; treat as present):
```json
"last_disconnect": { "at": "<iso8601>" | null, "reason": "socket_closed"|"superseded"|"keepalive_timeout"|"auth_rejected"|"server_restart"|"stale" | null }
```
`status` is DERIVED: `"online"` only when the daemon socket is open AND `last_seen_at` is within
90 s. `update` (existing): `{ state: current|available|updating|failed|unsupported|unknown, latest_version, error, requested_at }`.
Panel cases (exact copy in docs/masterplan/DESIGN-daemon-ux.md §2.5 item 3):
- never connected: `last_seen_at == null`
- auth-rejected: `last_disconnect.reason == "auth_rejected"`
- stale version: `update.state in {available, failed}` while offline
- plain offline: everything else while `status != "online"`

## 4. install.sh flags (server/routes/install.py) → daemon
- `--setup TOKEN` → exported as `SPAWN_SETUP_TOKEN` into the environment of the final
  `exec spawnd … possess` (and of `login --no-run` on the `--no-start/--foreground/--no-service`
  paths). The daemon's `possess`/`login` read `--setup-token <TOKEN>` (flag) or
  `SPAWN_SETUP_TOKEN` (env) and send it as `setup_token` on `device/start`.
- `--new-account` → `exec spawnd … possess --new-account` (Part 5; forces a fresh
  per-account registration even when an instance already exists).
- The displayed one-liner, when a claim was minted:
  `curl -fsSL <origin>/install.sh | sh -s -- --setup <token>`; without a claim (or when the
  server has no claims endpoint): today's `curl -fsSL <origin>/install.sh | sh`.

## 5. Daemon behaviour on `attended` (D3)
- `attended: true` → do NOT auto-open the browser. Print the link + code + fingerprint exactly
  as today, then `spawn: waiting for approval…`. If the poll is still `authorization_pending`
  after 25 s, open the browser as today (the tab may have been closed).
- `attended: false` / field absent → today's behaviour (open immediately).

## 6. Shared copy (both frontends, word for word)
- install instruction: `After installation, run spawnd possess on that machine.` (mobile said
  `spawnd login` — bug; web already says `possess`)
- multi-account hint (one line under the install command): `Already running SPAWN D for another account on that machine? Add --new-account.`
- checklist labels: `Command copied` · `Machine registered` · `Approved` · `Online`
- checklist stalled hints (after 60 s on a step):
  - step 1: `Having trouble? Re-run the install command — it's safe to repeat.`
  - step 2: `The machine is waiting for your approval below.`
  - step 3: `Approved. Waiting for the machine to come online — this usually takes a few seconds.`
- inline approve card lead: `Fastest: open the link in the machine's terminal — it verifies the identity automatically. Or compare the fingerprint below against the terminal.`
- expired code: `That code expired. On the machine, run spawnd possess again.`
- key_conflict (three options, verbatim from DESIGN-daemon-ux §2.3 transcript 3, minus the `spawn:` prefix):
  `This machine was set up before, under a different SPAWN D account, and that account still holds its identity. Nothing was changed.`
  `• To use it under that account: sign in there and approve as usual.`
  `• To hand it to this account: remove the host from the old account's Hosts page first, then run spawnd possess again.`
  `• To keep both accounts on this machine: spawnd possess --new-account`
- pin_conflict: `The browser that approved this machine doesn't match its earlier approval. Approve again from a browser you've used with this host before — or remove the host on the web and start fresh.`
- pin_limit: `This host has reached its limit of approving browsers (32). Remove old devices under Access, then try again.`
- host panel (§2.5 item 3):
  - never connected: `SPAWN D hasn't checked in from this machine yet. On it, run: spawnd doctor`
  - auth-rejected: `{host} can't sign in. On that machine, run: spawnd login`
  - stale version: `{host} runs {version}. On it, run: spawnd update (or it will self-update when idle).`
  - plain offline: `Last seen {relative} (connection dropped). If the machine is on, run spawnd doctor there.`
  - panel title: `Something wrong?`; the command is rendered copyable.
- Add a machine: button/entry label `Add a machine`.
- pairing push title/body as in §2.
