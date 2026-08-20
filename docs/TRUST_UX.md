# spawn — trust UX

**Status:** Approved design (2026-08-20), converged over five owner-review rounds from a
clean-room derivation. This is the canonical UX specification for the device trust mesh;
the reference implementation of every screen and state lives at `web/src/trust-ux/`
(props-driven components + `/trust-ux-demo`), and the visual presentation is the
"Clean-Room Trust UX" artifact.

The protocol ([TRUST_DEVICE_MESH.md](../../../docs/TRUST_DEVICE_MESH.md), governed by
[TRUST.md](../../../docs/TRUST.md)) is an endorsement mesh: device keys, host anchors,
account-scoped signed chains, a passkey-sealed root, committed-SAS ceremonies, an add-only
revocation set, background healing. **None of that vocabulary reaches a screen.** The user
gets a flat list, one number to type, and three verbs.

## Mental model — the three sentences

1. **Approve a device once — type one number — and it can reach every host.**
2. **Remove a device and it loses access everywhere, instantly and forever.**
3. **Your passkey brings everything back, even if you lose every device.**

Everything on screen is one of these sentences happening. Nothing on screen is anything else.

## Concept budget

| Concept | Kind | Covers (mechanism) |
|---|---|---|
| **device** | noun | browser identity key, endorsement subject |
| **host** | noun | host, daemon, anchor set A(h) |
| **approve** | verb | add-device SAS ceremony + mutual endorsement |
| **possess** | verb | the host anchor ceremony — the product's own verb |
| **remove** | verb | revoke: Rev tombstone + live-session teardown |
| **the number** | artifact | committed-ephemeral SAS (A5, Appendix A) |

Six taught concepts — plus **the passkey**, which is *borrowed, not taught*: users already
know it from every other product, and here it silently carries the entire root lifecycle
(mint, seal, heal, retrofit, rotation). "Recovery" as a named object was the seventh
concept in an earlier draft and the only one that required teaching; it was deleted.
Anything that needs an additional concept gets redesigned until it doesn't.

## Vocabulary (with rationale)

- **device** — the phone or laptop you're holding. Not "browser" (users don't think of a
  phone as a browser), not "client". A host is colloquially also a device, but no screen
  ever mixes the two lists, so the collision is never experienced — and the guard below
  keeps it that way.
- **host** — what your agents run on. The rest of the product already calls them Hosts
  (the sidebar, the pages), and it is the protocol's own word — one noun, one name,
  everywhere. "Your devices reach your hosts."
- **approve** — admitting a device. The device is *already in the list* the moment it
  signs in; approval names the transition (untrusted → trusted), not an insertion — which
  is why "add" and "link" were both rejected: you can see the thing sitting there before
  you act on it. Not "endorse", "trust" (circular with the state), "authorize"
  (bureaucratic).
- **possess** — attaching a host. The deliberate brand-vocabulary exception: it is the
  product's own verb, the terminal literally prints `spawnd possess`, and the screen
  matching the terminal beats generic clarity. A different verb than *approve* on
  purpose: hosts enter from their own terminal, devices from another device's screen.
- **remove** — revocation. The scariest correct word that is still an everyday word.
  "Revoke" is certificate-speak.
- **the number check** — the SAS. Never "SAS" or "fingerprint". One side shows it, the
  other *types* it — typing is what proves the human actually compared. Copy is always
  the imperative: *"Enter the number shown on the other device."*
- **passkey** — used as-is, lowercase, exactly as the platform means it. Its one extra
  power here gets one caption where passkeys are managed: *"Your passkey also restores
  your devices and hosts if you lose everything."*

Words that never appear: root, chain, anchor, pin, bundle, heal, endorsement, SAS,
fingerprint, key, revoke, mesh, ceremony, tombstone, TOFU, signature, **recovery**.

**The device/host guard:** a host is never called a device anywhere — not in errors, not
in history, not in counts. The two lists never merge.

## Information architecture

One destination: **Access** (a settings section). Named for what the screen governs —
devices that have it, hosts that grant it, a history of changes to it — rather than after
one of its two row types, which is what made "Devices" as a destination name quietly
overload the noun. It contains, top to bottom:

1. **Devices** — every device that has signed in. A device appears here **the moment it
   signs in** (R4: every sign-in is immediately visible), wearing *Waiting for approval*
   until someone approves it. Approved rows: name, platform icon, *how it got here*
   ("Approved by MacBook Pro · Jun 3" / "Signed in with passkey · Jul 2" / "First
   device"), last seen, overflow → Rename / Remove. Row provenance **is** the audit
   surface.
2. **Hosts** — every possessed host, same row grammar ("Possessed by MacBook Pro" —
   provenance never collides with the Online/Offline presence pill, which is presence,
   not trust). The app's Hosts *page* keeps its job (presence, terminals); this section
   is the trust view of the same rows.
3. **The passkey nudge** — one dismissible line, shown only while the account has no
   passkey: the R8 cost stated once, pointing at account settings. There is no recovery
   section: **passkeys are managed with the account, not with trust**, and adding or
   removing one there IS turning the safety net on or off.
4. **History** — the trust log (R4), newest first, plain sentences. Last three inline;
   "Everything" expands.

Flows (approve, possess, remove) are entered from this screen or arrive as prompts.
There is no second destination, no per-host trust page, no key inspector, no recovery
object.

## Screens and states

### 1. Access (roster) — `AccessScreen`
- **default** — devices + hosts listed, history preview.
- **waiting device** — an unapproved sign-in shows immediately with an amber *Waiting
  for approval* pill and a primary *Approve…* action.
- **no passkey** — identical, plus the one nudge row (dismissible).
- Device rows are not stateful beyond the "This device" tint and the waiting pill; host
  rows dim when offline (presence, not trust).

### 2. The number check — `NumberCheck` (one component, both flows)

The check is **entry-style, never tap-to-approve** (the protocol's own words, §3):
the side being approved *shows* the number; the side that already has trust *types*
it. Typing is the proof of comparison — a habituated tap can't wave it through.

- **connecting** — "Securing the connection…" spinner. (Covers commit/reveal/nonces.)
- **compare · show** — the six digits, huge; "Enter this number on the other device";
  quiet waiting line beneath. No confirm button on this side at all.
- **compare · enter** — a six-digit field; wrong entry says "That's not it — N tries
  left" and the third miss lands on **stopped**; the standing escape is *"I don't
  see a number"*.
- **compare · fingerprint** — older hosts have no number; the same frame shows
  the full fingerprint instead, compare-style (*They match* / *They don't match*).
  Never a shorter code — the fallback is the stronger check, per the protocol's
  rollout rule.
- **waiting** — you finished; other side hasn't. Number stays visible, dimmed; after
  a while a quiet hint ("Make sure the other side is still open").
- **done** — check mark, one line of what you gained.
- **stopped** — mismatch or exhausted tries. Red, terminal: nothing was trusted.
  *Close* only. There is no "approve anyway" (A4/A5 are not softenable).

### 3. Approve a device — `WaitingForApproval` (the new device) / `ApproveRequest` + `ApproveRequestToast` (an existing one)
- new device: signs in → already listed everywhere → **waiting** ("Approve from a device
  you already use — or sign in here with your passkey") → NumberCheck (show side) →
  approved.
- existing device: the request arrives as a prompt (`ApproveRequest`) or, on desktop, a
  corner toast — *Enter its number* / *Ignore* → NumberCheck (enter side). The roster's
  waiting row is the pull path to the same place.
- With a passkey there is **no flow at all**: signing in with it is the approval.
  Recovery-after-total-loss is deliberately the *same non-flow*.

### 4. Possess a host — `PossessHost`
- **instruction** — "Run this on the host: `spawnd possess`" (one command, one line).
- → NumberCheck (terminal shows, this device types) → **done** ("mac-studio is possessed.
  All your devices can reach it.")

### 5. Remove a device — `RemoveDeviceDialog`
- **confirm** — "Remove iPhone? It loses access to every host — instantly and
  permanently. To use it again, you'd approve it as a new device." *(That sentence is
  P3 + R10 + R1, in one breath.)*
- **orphan warning (R5)** — adds an amber block naming the hosts at risk. No passkey:
  "Remove it and it must be possessed again from its terminal — or add a passkey first";
  primary becomes *Add a passkey first*, with *Remove anyway* still available (matches
  the shipped warn-not-refuse). With a passkey **and the host online**: "You'll confirm
  with your passkey so it stays reachable" — the passkey touch heals the host before the
  removal lands. An **offline** host can't be healed in time, so it always gets the
  honest wording — the passkey promise is only made where it can be kept.
- **this device** — same dialog, "You're using this device right now" note.

### 6. Passkeys — deliberately not here
Passkey management (add, remove) lives in **account settings** with every other product's
passkeys; one caption there carries the trust meaning. Adding one mints the safety net;
removing the last one retires it — the consequence copy at that action says so honestly,
including that removing it does **not** lock out a stolen passkey (delete it from the
password manager too; remove compromised devices). Root rotation happens automatically at
the next passkey sign-in. No dialogs in the trust UX.

### 7. Connection refused — `AccessBlocked`
- **removed** — *(refined 2026-08-21, owner review during field test)* there is no removed
  screen and no "Start over" button: a removed device that is still signed in seamlessly
  becomes a new, unapproved device on its next load — the dead key is cleaned up and a
  fresh one registers automatically, landing it in the ordinary *waiting* state. The
  button gated nothing (anyone can clear site data); the real invariants hold without it:
  the removed KEY stays dead forever (R10), every sign-in is visible (R4, with the removal
  and its remover in History), and approval — the only gate that matters — still takes the
  ceremony. The disaster flow is the ordinary flow.
- **not approved yet** — "One step left — approve from a device you already use, or sign
  in with your passkey." → *Use passkey*.

### 8. History — `TrustHistory`
- Plain sentences, newest first: "MacBook Pro approved iPhone", "Pixel 9 signed in with
  passkey", "Old iPad removed by MacBook Pro — access ended everywhere", "MacBook Pro
  possessed mac-studio", "Passkey added". Every live approval and every removal is one
  visible line (R4). No filters, no tabs.

## Flows

- **First device + first host.** Sign up on the device (no ceremony — there is nothing
  to approve *from*; the roster shows "First device"). Possess the first host: run one
  command, type one number. Total human cost: one number. The passkey nudge appears.
- **Additional device, passkey.** Sign in with the passkey → done. Zero screens. (The
  heal endorses it off the root; the sealed vault delivers the hosts.)
- **Additional device, no passkey.** Sign in → it appears everywhere as *Waiting for
  approval* → the new device shows the number, a trusted one types it. One number (P4).
- **Recovery after total loss.** Identical to "additional device, passkey". The disaster
  flow is the ordinary flow — that is the design.
- **Remove a device.** Overflow → Remove → confirm. If it would orphan a host, the
  dialog says which one and steers to a passkey first (R5). Takes effect mid-session
  (R1): the removed device's screens drop, and it lands on `AccessBlocked/removed`.
- **Passkey lifecycle.** Managed in account settings; consequences stated there.
- **No-passkey mode.** Do nothing. The nudge and the remove/orphan dialogs carry the
  warnings; nothing else changes.
- **Connection refused.** A removed or unapproved device gets `AccessBlocked` with the
  exact next step. Never a raw error.

## Desktop presentation

The same components, one composition rule: **flows are windows on mobile and
layers on desktop.**

- The roster renders as a settings pane (`wide`): same rows, more air; the row
  menu (Rename / Remove…) opens in place.
- Dialogs (`RemoveDeviceDialog`) sit centered over the dimmed page — the page stays
  visible so the consequence text reads in context.
- An approval request arrives as a **corner toast** (`ApproveRequestToast`) over
  whatever the user is doing, while the roster simultaneously shows the waiting row —
  push and pull paths to the same ceremony. Nothing is trusted from the toast itself.
- The ceremonies (`NumberCheck`, `PossessHost`, `WaitingForApproval`) keep their
  340px frame at every size — a security moment gets a focused card, never a
  full-bleed page.

## Deleted-complexity ledger

What a naive design would show, what we show instead, and why the protocol survives it:

| A naive design shows | We show | Why the invariant survives |
|---|---|---|
| Hex key fingerprints to eyeball | Nothing on modern endpoints; the same check-frame shows a full fingerprint only for older hosts | The committed SAS (A5) is *stronger* than fingerprint eyeballing; where a legacy endpoint can't do it, the protocol's rollout rule mandates the *full-entropy* compare — never a weaker short code — and the UI renders exactly that |
| "Endorsements" as inspectable objects | One phrase per row: "Approved by MacBook Pro · Jun 3" | The signature set is machine-verified (P2); humans only ever needed the *who/when*, which is exactly R4's detection requirement |
| The trust graph / chains | A flat list | P1 proves the mesh is complete, so "approved" is a truthful single state; chains are transport, not status |
| A recovery object with on/off state, reset dialogs, status | A passkey in account settings, one caption, one dismissible nudge | §4.1: the heal is what using the passkey means; mint/retrofit/rotation are automatic at passkey moments; the only decision a user ever makes is "have a passkey or not," and that decision already exists in every product |
| Root key status, heal progress, re-anchor events | "Signed in with passkey" as provenance | Healing is machine work authorized by the passkey (P4); surfacing it creates decisions no user can make better than the protocol |
| Per-host trust matrices (which device may reach which host) | Nothing | P1: every device reaches every host. A matrix would be an N×M grid of identical checkmarks |
| Pairing modes, SAS vs fingerprint fallback, protocol versions | One number check | The rollout rule (Appendix A) already guarantees the *stronger* check is chosen; the UI never offers the choice |
| A revocation list to manage | The Remove button + one sentence in its dialog | Rev is add-only and account-wide (P3/P3′); "instantly and permanently, everywhere" is the whole truth |
| "Un-remove" for mistakes | "Approve it as a new device" | R10: tombstones are permanent; re-admission is a fresh ceremony — which is exactly one number, so forgiveness stays cheap |
| Ceremony internals (commit, reveal, nonces, waiting-for-peer) | "Securing the connection…" then the number | A5's soundness doesn't depend on the user watching it happen |
| A separate recovery wizard | Nothing — recovery *is* signing in with the passkey | §4.1: unlock triggers the heal; the best disaster flow is the one users already know |

## Small rules the screens obey

- **Duplicate names get a suffix at approval time** ("MacBook Pro (2)") — two devices may
  never be indistinguishable in the roster or history, or a rogue approval could
  camouflage as an existing device (R4 at the naming layer).
- **The overflow menu earns its hop**: it holds Rename and Remove…; a bare
  destructive button on every row would make the roster read as a demolition list.
- **A waiting row is never quiet**: amber pill + primary Approve — an unapproved sign-in
  is the one thing the roster actively surfaces (R4's detection moment).
- **Denying a stranger is account security, not trust UX**: an unwanted waiting device is
  handled by not approving it and securing the account (sign out sessions, change
  credentials) — approval was never granted, so there is nothing here to revoke.
- **Waiting states never strand**: after a quiet interval they add one hint line with the
  obvious next step; Cancel is always present.
- **"Trusts/trusted" as plain English** is allowed in warning sentences ("dev-box trusts
  only this device") — the vocabulary ban is on *trust as a system noun*, not on the
  ordinary verb; anything else reads as evasion.
- **Possess vocabulary end to end** — what the terminal prints is what the screen says.

## Invariant map (nothing weakened)

- **A5 number match** — kept in both ceremonies as ENTRY, not tap-to-approve (the
  protocol's own requirement): one side shows, the other types; mismatch and exhausted
  tries are terminal, no override. Legacy hosts get the full-fingerprint compare.
- **P3/R1/R10 revocation** — instant ("instantly"), account-wide ("every host"),
  permanent ("permanently"; rejoin = fresh approval), live teardown (removed device
  drops to `AccessBlocked` mid-session).
- **R4 audit visibility** — every sign-in is visible immediately (the waiting row);
  provenance on every roster row; the History log; the removed screen names who
  removed it.
- **R5 orphan hazard** — the remove dialog names the hosts that would be orphaned and
  steers to a passkey first; *Remove anyway* remains (matches the shipped
  warn-not-refuse); the passkey promise is gated on the host being online.
- **R8 no-passkey mode** — fully supported: it is simply not having a passkey. Cost
  stated once (the nudge) and re-stated where it bites (the orphan dialog).

## Screen/state → component map

| Screen / state | Component |
|---|---|
| Access roster (default / waiting / nudge / wide / row menu) | `AccessScreen` |
| Number check (show / enter / fingerprint / waiting / done / stopped) | `NumberCheck` |
| New device waiting | `WaitingForApproval` |
| Approval request (prompt / desktop toast) | `ApproveRequest`, `ApproveRequestToast` |
| Possess instruction | `PossessHost` |
| Remove confirm (standard / orphan on-off-line / this device) | `RemoveDeviceDialog` |
| Refused (removed / not approved) | `AccessBlocked` |
| Full trust log | `TrustHistory` |
