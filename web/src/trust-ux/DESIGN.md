# spawn trust UX — design

The protocol ([TRUST_DEVICE_MESH.md](../../../docs/TRUST_DEVICE_MESH.md), governed by
[TRUST.md](../../../docs/TRUST.md)) is an endorsement mesh: device keys, host anchors,
account-scoped signed chains, a passkey-sealed root, committed-SAS ceremonies, an add-only
revocation set, background healing. **None of that vocabulary reaches a screen.** The user
gets a flat list, one number to compare, and three verbs.

## Mental model — the three sentences

1. **Link a device once — check one number — and it can reach every host.**
2. **Remove a device and it loses access everywhere, instantly and forever.**
3. **Recovery is a passkey that can bring everything back, even if you lose every device.**

Everything on screen is one of these sentences happening. Nothing on screen is anything else.

## Concept budget

| Concept | Kind | Covers (mechanism) |
|---|---|---|
| **device** | noun | browser identity key, endorsement subject |
| **host** | noun | host, daemon, anchor set A(h) |
| **recovery** | noun | root key R, passkey, sealed bundle, heal, retrofit, rotation |
| **link** | verb | add-device SAS ceremony + mutual endorsement |
| **possess** | verb | the host anchor ceremony — the product's own verb |
| **remove** | verb | revoke: Rev tombstone + live-session teardown |
| **the number** | artifact | committed-ephemeral SAS (A5, Appendix A) |

Seven. Every screen is built only from these. Anything that needed an eighth concept was
redesigned until it didn't.

## Vocabulary (with rationale)

- **device** — the phone or laptop you're holding. Not "browser" (users don't think of a
  phone as a browser), not "client".
- **host** — what your agents run on. The rest of the product already calls them
  Hosts (the sidebar, the pages), and it is the protocol's own word — one noun, one
  name, everywhere. "Your devices reach your hosts" and it pairs with the verb below.
- **link** — admitting a device. Not "endorse", "pair", "trust", "verify" — link says what
  you get (it's attached now) without claiming ceremony mechanics.
- **possess** — attaching a host. The deliberate brand-vocabulary exception: it is the
  product's own verb, the terminal literally prints `spawnd possess`, and the screen
  matching the terminal beats generic clarity. Still a different verb than *link* on
  purpose: hosts enter from their own terminal, devices from another device's screen.
- **remove** — revocation. The scariest correct word that is still an everyday word.
  "Revoke" is certificate-speak.
- **recovery** — the entire root lifecycle. It is sold as what it does (brings everything
  back) and quietly does everything else (auto-trusting new passkey devices, healing,
  rotation) with zero UI.
- **the number check** — the SAS. Never "SAS" or "fingerprint". One side shows it, the
  other *types* it — typing is what proves the human actually compared. Copy is always
  the imperative: *"Enter the number shown on the other device."*

Words that never appear: root, chain, anchor, pin, bundle, heal, endorsement, SAS,
fingerprint, key, revoke, mesh, ceremony, tombstone, TOFU, signature.

## Information architecture

One destination: **Access** (a settings section). Named for what the screen governs —
devices that have it, hosts that grant it, recovery that restores it, a history of
changes to it — rather than after one of its two row types, which is what made
"Devices" as a destination name quietly overload the noun. It contains, top to bottom:

1. **Recovery strip** — one line: on (quiet) or off (amber, with the cost and a button).
2. **Devices** — every linked device. Each row: name, platform icon, *how it got here*
   ("Linked by MacBook Pro · Jun 3" / "Added by recovery" / "First device"), last seen,
   overflow → Remove. This row-level provenance **is** the R4 audit surface.
3. **Hosts** — every possessed host, same row grammar ("Possessed by MacBook Pro" — provenance never collides with the Online/Offline presence pill, which is presence, not trust). The app's Hosts *page* keeps its job (presence, terminals); this section is the trust view of the same rows.
4. **History** — the trust log (R4), newest first, plain sentences. Last three inline;
   "Everything" expands.

Flows (link, possess, remove, recovery) are entered from this screen or arrive as prompts.
There is no second destination, no per-host trust page, no key inspector.

## Screens and states

### 1. Access (roster) — `AccessScreen`
- **default** — recovery on, devices + hosts listed, history preview.
- **recovery off** — amber strip replaces the quiet one; everything else identical.
- Device rows are not stateful beyond the "This device" tint; host rows dim when offline (presence, not trust).

### 2. The number check — `NumberCheck` (one component, both flows)

The check is **entry-style, never tap-to-approve** (the protocol's own words, §3):
the side being added *shows* the number; the side that already has trust *types*
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

### 3. Link a new device — `LinkNewDevice` (the new device) / `LinkRequest` (an existing one)
- new device: **waiting** ("Confirm from a device you already use — or use your recovery
  passkey") → NumberCheck → **done** ("Linked. Every host is ready.")
- existing device: **prompt** ("A new device signed in as jeremy@… and wants to link") →
  *Enter its number* / *Ignore* → NumberCheck (enter side).
- With a passkey there is **no flow at all**: sign in, touch the passkey, everything
  appears. Recovery-after-total-loss is deliberately the *same non-flow*.

### 4. Possess a host — `PossessHost`
- **instruction** — "Run this on the host: `spawnd possess`" (one command, one line).
- → NumberCheck (terminal shows, this device types) → **done** ("mac-studio is possessed.
  All your devices can reach it.")

### 5. Remove a device — `RemoveDeviceDialog`
- **confirm** — "Remove iPhone? It loses access to every host — instantly and
  permanently. To use it again, you'd link it as a new device." *(That sentence is P3 +
  R10 + R1, in one breath.)*
- **orphan warning (R5)** — adds an amber block naming the hosts at risk. Recovery
  off: "Remove it and it must be set up again from its terminal — or turn on recovery
  first"; primary becomes *Turn on recovery first*, with *Remove anyway* still available
  (matches the shipped warn-not-refuse). Recovery on **and the host online**: "You'll
  confirm with your passkey so it stays reachable" — the passkey touch heals the host
  onto recovery before the removal lands. An **offline** host can't be healed in time,
  so it always gets the honest wording ("offline… after removal it must be set up again
  from its terminal") — the passkey promise is only made where it can be kept.
- **this device** — same dialog, "You're using this device right now" note.

### 6. Recovery — the strip inside `AccessScreen`, plus `TurnOnRecoveryDialog` and `ResetRecoveryDialog`
- **off** — the amber strip states the R8 cost once, plainly; *Turn on* opens
  `TurnOnRecoveryDialog` (one passkey creation, everything after is automatic).
  This state **is** no-passkey mode; it's not a mode, just a strip you haven't acted on.
- **on** — quiet single line with an inline *Reset* text action.
- **reset (root rotation)** — `ResetRecoveryDialog`, describing exactly what rotation
  delivers: recovery stops everywhere permanently and is rebuilt at the next passkey
  sign-in; devices stay linked. It deliberately does NOT claim to lock out a stolen
  passkey — a leaked passkey still opens the resealed vault, so the dialog points at the
  real remedies (delete the passkey where it's stored; remove compromised devices).
  Old root is tombstoned, never un-revoked (R10).

### 7. Connection refused — `AccessBlocked`
- **removed** — "This device was removed — Aug 12, by MacBook Pro. It can start over
  as a new device." → *Link as a new device*. (Names the remover: R4 visibility at the
  sharp end. Rejoining is a fresh link, never an un-remove: R10.)
- **not linked yet** — "Almost in — this device isn't linked yet." → *Link this device*.

### 8. History — `TrustHistory`
- Plain sentences, newest first: "MacBook Pro linked iPhone", "Recovery restored Pixel 9",
  "iPad removed by MacBook Pro — access ended everywhere", "MacBook Pro possessed mac-studio".
  Every live endorsement and every removal is one visible line (R4). No filters, no tabs.

## Flows

- **First device + first host.** Sign up on the device (no ceremony — there is nothing
  to link *to*; the roster shows "First device"). Prompt to turn on recovery. Connect the
  first host: run one command, type one number. Total human cost: one number.
- **Additional device, passkey.** Sign in → passkey → done. Zero screens. (Heal endorses
  it off the root; the bundle delivers the hosts.)
- **Additional device, no passkey.** Sign in → "confirm from a device you already use" →
  the new device shows the number, the trusted one types it. One number (P4).
- **Recovery after total loss.** Identical to "additional device, passkey". The disaster
  flow is the ordinary flow — that is the design.
- **Remove a device.** Overflow → Remove → confirm. If it would orphan a host, the
  dialog says which one and steers to recovery first (R5). Takes effect mid-session (R1):
  the removed device's screens drop, and it lands on `AccessBlocked/removed`.
- **Reset recovery (passkey-backed trust).** Recovery overflow → Reset → confirm.
- **No-passkey mode.** Do nothing. The amber strip and the remove/orphan dialogs carry the
  warnings; nothing else changes.
- **Connection refused.** A removed or unlinked device gets `AccessBlocked` with the exact
  next step. Never a raw error.

## Deleted-complexity ledger

What a naive design would show, what we show instead, and why the protocol survives it:

| A naive design shows | We show | Why the invariant survives |
|---|---|---|
| Hex key fingerprints to eyeball | Nothing on modern endpoints; the same check-frame shows a full fingerprint only for older hosts | The committed SAS (A5) is *stronger* than fingerprint eyeballing; where a legacy endpoint can't do it, the protocol's rollout rule mandates the *full-entropy* compare — never a weaker short code — and the UI renders exactly that |
| "Endorsements" as inspectable objects | One phrase per row: "Linked by MacBook Pro · Jun 3" | The signature set is machine-verified (P2); humans only ever needed the *who/when*, which is exactly R4's detection requirement |
| The trust graph / chains | A flat list | P1 proves the mesh is complete, so "linked" is a truthful single state; chains are transport, not status |
| Root key status, heal progress, re-anchor events | "Recovery is on" | Healing is a machine op authorized by the passkey (P4); surfacing it creates decisions no user can make better than the protocol |
| Per-host trust matrices (which device may reach which host) | Nothing | P1: every device reaches every host. A matrix would be an N×M grid of identical checkmarks |
| Pairing modes, SAS vs fingerprint fallback, protocol versions | One number check | The rollout rule (Appendix A) already guarantees the *stronger* check is chosen; the UI never offers the choice |
| A revocation list to manage | The Remove button + one sentence in its dialog | Rev is add-only and account-wide (P3/P3′); "instantly and permanently, everywhere" is the whole truth |
| "Un-remove" for mistakes | "Link it as a new device" | R10: tombstones are permanent; re-admission is a fresh ceremony — which is exactly one number check, so forgiveness stays cheap |
| A passkey/no-passkey mode switch | A card you either acted on or didn't | R8's cost is stated on the card and re-stated where it bites (orphan dialog); the mode is a consequence, not a setting |
| Ceremony internals (commit, reveal, nonces, waiting-for-peer) | "Securing the connection…" then the number | A5's soundness doesn't depend on the user watching it happen |
| A separate recovery wizard | Nothing — recovery *is* signing in with the passkey | §4.1: unlock triggers the heal; the best disaster flow is the one users already know |
| Key rotation UI after reset | One dialog sentence: "rebuilt the next time you use your passkey" | §4.1 rotation: mint-on-unlock is automatic; the old root stays dead (R10) |


## Desktop presentation

The same components, one composition rule: **flows are windows on mobile and
layers on desktop.**

- The roster renders as a settings pane (`wide`): same rows, more air; the row
  menu (Rename / Remove…) opens in place.
- Dialogs (`RemoveDeviceDialog`, recovery dialogs) sit centered over the dimmed
  page — the page stays visible so the consequence text reads in context.
- A link request arrives as a **corner toast** (`LinkRequestToast`) over whatever
  the user is doing: name, one reassurance line, *Enter its number* / *Ignore*.
  Nothing is trusted from the toast itself; it only opens the number check.
- The ceremonies (`NumberCheck`, `PossessHost`, `LinkNewDevice`) keep their
  340px frame at every size — a security moment gets a focused card, never a
  full-bleed page.

## Small rules the screens obey

- **Duplicate names get a suffix at link time** ("MacBook Pro (2)") — two devices may
  never be indistinguishable in the roster or history, or a rogue link could camouflage
  as an existing device (R4 at the naming layer).
- **The overflow menu earns its hop**: it holds Rename and Remove…; a bare
  destructive button on every row would make the roster read as a demolition list.
- **First device + first host flow** and all copy use the possess vocabulary end to end —
  what the terminal prints is what the screen says.
- **Waiting states never strand**: after a quiet interval they add one hint line with the
  obvious next step; Cancel is always present.
- **"Trusts/trusted" as plain English** is allowed in warning sentences ("dev-box trusts
  only this device") — the vocabulary ban is on *trust as a system noun*, not on the
  ordinary verb; anything else reads as evasion.

## Invariant map (nothing weakened)

- **A5 number match** — kept in both ceremonies as ENTRY, not tap-to-approve (the
  protocol's own requirement): one side shows, the other types; mismatch and exhausted
  tries are terminal, no override. Legacy hosts get the full-fingerprint compare.
- **P3/R1/R10 revocation** — instant ("instantly"), account-wide ("every host"),
  permanent ("permanently"; rejoin = new link), live teardown (removed device drops to
  `AccessBlocked` mid-session).
- **R4 audit visibility** — provenance on every roster row + the History log; the removed
  screen even names who removed it.
- **R5 orphan hazard** — the remove dialog names the hosts that would be orphaned and
  steers to recovery first; *Remove anyway* remains (matches the shipped warn-not-refuse).
- **R8 no-passkey mode** — fully supported (the off card), cost stated where it's decided
  and where it bites.
