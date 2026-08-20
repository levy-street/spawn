# spawn trust UX — clean-room design

Derived solely from `docs/TRUST.md` and `docs/TRUST_DEVICE_MESH.md`. Every screen below renders an
invariant of the mesh; nothing here weakens one. Mechanism names (root, endorsement, chain, anchor,
pin, bundle, heal, SAS, tombstone) never appear in the product. This document defines what does.

---

## 1. The user's mental model

Three sentences, and the entire UI teaches only these three:

1. **A device joins your account once — with one human check — and then it works with every host
   you have, and every host you add later.** (P1 + P4)
2. **Your passkey quietly countersigns everything, so no single device is precious: lose one, lose
   all of them, and the passkey gets you back in.** (§4.1 root + heal)
3. **Removing a device is immediate, everywhere, and permanent.** (P3, R1, R10)

Two supporting beliefs the UI reinforces at every opportunity:

- **The server can never add trust — only you can.** Trust moves between *your* screens: a number
  shown on one, typed into another. Nothing the service does on its own ever grants access. (P2)
- **Removal is the safe direction.** Adding trust wrongly is catastrophic; removing it wrongly
  costs only a re-link. Copy says so: *"If in doubt, remove it — you can always link a device
  again."* (§1 asymmetry)

What the user is **never** asked:

- Never asked to compare hex fingerprints (sole exception: the legacy-host fallback, §6.3, where
  the protocol itself mandates the full-entropy compare).
- Never asked per-host anything. One check admits a device to *all* hosts (P4); the UI must never
  imply per-host grants exist.
- Never asked to confirm, approve, or observe the heal. Passkey unlock re-signs the account in the
  background; it surfaces only as status upgrades and history entries.
- Never asked to tap "Approve" on a bare prompt. Every ceremony requires *typing* the number
  (A5: entry-style, not tap-to-approve).
- Never asked to name, rotate, export, or think about keys.
- Never asked "reconnect?" after a trust refusal. Trust refusals are terminal states with a named
  remedy — auto-retry would train users to ignore them.

---

## 2. Vocabulary

| Term (user-facing) | Mechanism it names | Rationale |
|---|---|---|
| **device** | browser identity key + its endorsements | Familiar; matches what the user physically holds. |
| **host** | daemon + host identity key | Established product term for "machine running spawn". |
| **link** (a device) | `add-device`: committed-SAS ceremony + mutual endorsement | A link is symmetric and human-made — exactly what the mutual endorsement is. Avoids "pair", reserved for hosts, so instructions can never ambiguate which ceremony. |
| **pair** (a host) | `possess`: host↔browser anchor ceremony | "Pair" implies the physical adjacency the ceremony really requires (you can read the machine's terminal). |
| **match code** | the 6-digit committed SAS, shown "NNN NNN" | "Code" invites the required act (typing). "Match" preserves the true semantic: it is a *comparison*, not a secret — so "the codes don't match" reads as danger, not typo. Never called password, PIN, or OTP. |
| **vouched for by X** | device endorsement (X → this key) | Honest and human: a device you trust vouched for this one. Makes the R4 roster legible — provenance is a sentence, not a graph. |
| **backed by your passkey** | root endorsement `R → d`; root anchor `R ∈ A(h)` | "Backed" carries the exact guarantee: this device/host survives the loss of everything else. Used identically for devices and hosts. |
| **remove** | revoke: `pk → Rev`, permanent tombstone | Plain verb. The permanence and instancy live in the confirm dialog, not in a scary button label — removal is the *safe* direction and the UI should not make users afraid of it. |
| **reset passkey trust** | root revocation + successor mint | Rare and grave; the name says what it does and implies nothing is deleted. Deliberately not "reset passkey" (the passkey credential itself is the platform's object, not ours). |
| **trust history** | the audited endorsement/revocation log (R4) | "History" not "log": it's for humans doing detection, newest first. |
| **restore** | recovery heal on a fresh device via passkey unlock | The user experiences it as restoration, not enrollment. |
| **this device** | the local identity key | Every roster marks the viewer's own row; self-location is a prerequisite for detection. |

Words that never appear: root, endorsement (as a noun), chain, anchor, pin, bundle, heal, SAS,
mesh, tombstone, revocation set, TOFU, fingerprint (outside §6.3), key (as a thing users manage).

---

## 3. Information architecture

One page owns all of trust: **Security**. Users hunting for "kick that device out" or "why can't
my phone connect" have exactly one place to look — which is itself an R4 requirement: detection
only works if the roster is *found*.

```
Security
├── Overview strip      — passkey state, device/host counts, outstanding warnings
├── Devices             — the roster (R4 detection surface) · [Link a device]
├── Hosts               — per-host trust status (R5 early warning)  · [Pair a host]
└── Trust history       — newest-first audited events, incl. failed ceremonies
```

Everything else is either a **flow** (full-screen or modal, entered from a button or from
sign-in) or an **in-context state** (a connection surface replaced by a refusal screen):

- Flows: *Link this device* (on the joining device), *Approve a device* (on a trusted device),
  *Pair a host*, *Passkey setup*, *Restore account*, *Remove device*, *Reset passkey trust*.
- In-context: the connection gate (refusal states, §7) and the session verified chip.

---

## 4. Screens and states

### 4.1 Security overview strip

| State | Rendering |
|---|---|
| Passkey active | "Passkey — backing N devices and M hosts. Created ⟨date⟩." Quiet. Advanced link: *Reset passkey trust*. |
| No passkey | Prominent warning card: "No passkey. If you lose your devices, the only way back is at each machine's keyboard." CTA: *Create passkey*. (R8 — the cost is permanent signage, not a one-time dialog.) |
| Warnings | Zero or more actionable warning rows (see below). No warnings → a single quiet "Everything is backed by your passkey." line. |

Warning rows (each names its remedy, one tap away):

| Warning | Trigger (mechanism) | Copy |
|---|---|---|
| Sole-key host | some `h` with `A(h)` = one device key, no root (R5 pre-warning) | "⟨host⟩ trusts only ⟨device⟩. If that device is lost or removed, ⟨host⟩ must be paired again at the machine." → *Back it with your passkey* / *Create passkey* |
| Single device, no passkey | \|D\|=1 and no root (R8) | "This is your only device and you have no passkey. Losing it locks you out of every host." |
| Awaiting passkey backup | devices with chain-only admission (pre-heal) | "N devices will be backed by your passkey the next time you use it." (informational — the heal is automatic; no action button, because there is nothing to approve) |
| Unrecognized-device nudge | roster changed since last visit | "A device was added on ⟨date⟩: ⟨name⟩. Not you? Remove it." (R4: detection must be pushed, not just available) |

### 4.2 Devices roster (R4)

Header copy — the detection contract, verbatim on screen: **"Every device that can reach your
hosts is on this list. If you see one you don't recognize, remove it."**

Each row:

- Name + platform, "**This device**" pill on the viewer's row.
- Status pill — exactly one of:
  - **Backed by your passkey** (ok) — root-endorsed; steady state.
  - **Vouched for by ⟨device⟩** (neutral; + "backed by passkey after your next passkey use" when a
    passkey exists) — chain-admitted, pre-heal.
- Provenance line (the audit sentence): "Linked ⟨date⟩ — approved by ⟨device⟩" / "First device" /
  "Restored with your passkey ⟨date⟩". Plus last-seen.
- Inline warning when the device is some host's only key (R5): "Only key to: ⟨hosts⟩."
- **Remove** action (never hidden behind an overflow menu — removal is the safe direction).

Removed devices do not linger in the roster; they appear in trust history as permanent events.
There is deliberately no "removed devices" list with a restore button (R10: no un-revoke exists;
offering one would be a lie).

### 4.3 Hosts trust list

Per host row:

- Name, online/offline dot (presence is metadata the server already has; showing it here explains
  *when* removals take effect).
- Status pill — one of:
  - **Backed by your passkey** (ok).
  - **Paired with ⟨device⟩ only** (warn) — the R5 pre-warning, permanently visible.
  - **Unreachable — needs pairing at the machine** (danger) — orphaned: every key it trusted was
    removed.
- Offline hosts during a pending removal show: "Applies when this host next comes online." (P3:
  effective from the moment each host is next reachable — the UI must not claim "now" for a
  machine that is asleep.)
- Orphaned rows carry the remedy inline: *Show pairing instructions*.

### 4.4 Trust history

Newest-first sentences with dates. Every trust-changing event, including failures — a stopped
ceremony is the strongest detection signal there is:

- "⟨device⟩ joined — approved by ⟨device⟩" (link)
- "Your passkey backed ⟨device⟩ / ⟨host⟩" (heal — the only face the heal has)
- "⟨host⟩ paired from ⟨device⟩" (possess)
- "⟨device⟩ removed from ⟨device⟩ — permanent" (revoke; danger tone)
- "A link attempt was stopped — the codes didn't match" (mismatch abort; danger tone)
- "A link attempt expired unanswered" (neutral)
- "Account restored on ⟨device⟩ with your passkey" (recovery)
- "Passkey created — new devices are now backed automatically"
- "Passkey trust was reset — hosts backed only by the passkey need pairing again" (danger tone)

### 4.5 The ceremony (committed-SAS number match) — shared design

Used at *link a device* (browser↔browser) and *pair a host* (host↔browser). Appendix-A protocol;
the UI adds nothing and removes nothing:

- The **untrusted side displays** the code; the **trusted side types** it. Typing forces reading
  (A5's entry-style mandate) and puts the affirmative act on the endpoint whose signature the
  ceremony produces.
- The code renders as two groups of three ("**483 291**"), large, with the instruction naming the
  *other* screen explicitly: "Enter the code shown on ⟨other side⟩."
- **Three entry attempts**, then the ceremony aborts. Re-typing within a ceremony is
  cryptographically free (both commitments are fixed before the code exists; a wrong keystroke
  gives an attacker nothing), but unlimited attempts train users to force it. Attempt 2 and 3 show:
  "Check the two screens carefully — if they show different codes, stop."
- A permanent escape is always visible: **"The codes don't match"** — it aborts the ceremony,
  tells the user plainly that something may have interfered, and writes a danger event to trust
  history. Mismatch is never a retry; a new attempt is a new ceremony with fresh codes (one-shot,
  A5).
- **Integrity failure** (commitment check fails on open — §Appendix A step 3): loud abort, never
  silent retry: "The security check failed before the code was shown. This can indicate
  interference. Nothing was trusted." Logged to history.
- Codes expire (~2 minutes). Expiry is a calm state, not an error: "This code expired. Start
  again from the other device."
- Repeated failures get escalating honesty: "If this keeps happening, something between your
  devices may be interfering. Nothing has been trusted."

---

## 5. Flows

### 5.1 First device (account creation)

1. Sign in (account exists server-side; grants nothing by itself — the UI says so once:
   "Signing in identifies you to the service. Your devices decide what to trust.").
2. **Passkey setup — offered before anything else.** One screen: "Create a passkey. It backs
   every device and host you add, and it's how you get back in if you lose everything." Primary:
   *Create passkey*. Secondary: *Skip for now* → the no-passkey cost sheet (§5.6).
   - Ordering rationale: everything downstream (host backing at pair time, silent device
     admission) inherits from the root existing *first*. Retrofit exists (§4.1 of the mesh doc),
     but the ideal path never needs it.
3. Passkey created → this device is backed automatically (root is minted with the passkey; no
   ceremony — the device holding the passkey *is* the check). Straight into "Pair your first
   host" (§5.2).

States: `offer → creating → done` | `cost-sheet` | `error` (platform refused / cancelled — retry
or skip).

### 5.2 First host (pair a host)

1. Instructions screen: the install/pair command to run on the machine, copyable. "Run this on
   the machine you want to reach. It will print a 6-digit code."
2. *Waiting for the host…* (the machine registers, the ceremony opens).
3. **Entry:** "Enter the code shown in the terminal on ⟨host⟩." Entry field, three attempts,
   mismatch escape, expiry — §4.5.
4. Success: "⟨host⟩ paired." With passkey: "Your passkey now backs it — every device you link can
   reach it, and losing this browser won't lose the host." Without: "Paired with this device.
   Only devices linked to your account can reach it." + the R5 warning inline.
5. Legacy host (protocol fallback, Appendix A rollout): instead of the code entry, the
   **full-fingerprint compare** — "This host is running an older version. Compare the full
   fingerprint instead — every group must match." Renders the complete fingerprint in groups,
   with explicit *They match* / *They don't match* buttons. This is the one place a compare
   without typing is permitted, because the value is full-entropy (A5 corollary: the ungrindable
   alternative to the committed SAS is ≥96-bit compare — never a short code without commitment).

States: `instructions → waiting → enter-code (attempts 3→1) → verifying → paired` |
`fingerprint-fallback → paired` | `mismatch-reported` | `attempts-exhausted` | `expired` | `error`.

### 5.3 Each additional device

The joining device signs in, detects it is unlinked, and lands on **Link this device** — a
full-screen fork with passkey-first ordering:

- **Path A — "Use your passkey"** (primary when the account has one). Passkey unlock → the
  account restores/backs this device silently → done. *No number ceremony.* This is P4 satisfied
  by the passkey itself: the unlock is the one human check, and §4.1's heal admits the device with
  a direct passkey backing. Success copy: "This device is now backed by your passkey. All N hosts
  are available."
- **Path B — "Approve from another device"** (primary when no passkey; fallback when the passkey
  isn't available on this hardware). The committed-SAS ceremony:
  - New device: `waiting for your other device → showing code ("483 291 — enter this on
    ⟨approver⟩") → linked` | `declined` | `expired` | `integrity-failure` | `error`.
  - Trusted device: an approval request appears: "A device calling itself '⟨name⟩' wants to join
    your account." The name is labeled as the claim it is: "The name and platform are the
    device's own claim. The code check is what proves it's yours." → *Continue* → entry (§4.5) →
    "⟨device⟩ linked. It can now reach all N hosts." With a passkey present on the approver, the
    new device is passkey-backed in the same act; otherwise it shows "Vouched for by ⟨approver⟩".
  - Success on the new device names the consequence, once: "Linked. Every host on the account is
    available — including ones added in the future."

Rationale for the fork order: the ceremony is the *fallback*, not the headline. The mesh's
steady state is the passkey star; the UX should route users there whenever possible and keep the
two-device ceremony for the cases the protocol keeps it for (no passkey, cross-ecosystem device).

### 5.4 Recovery after total loss

Sign in on a fresh device; the account has hosts but the user holds no linked device.

- **With a passkey:** hero screen — "Welcome back. Unlock with your passkey to restore access to
  your N hosts." → platform passkey prompt → "Restoring…" → "Restored. This device is backed by
  your passkey. N hosts available." (One human check: the unlock. The heal admits the fresh
  device and re-backs everything — validated in the mesh's live recovery drill.)
  - Old devices are *not* resurrected by this — they were removed or lost; the roster shows only
    this device plus whatever survives. History records "Account restored on ⟨device⟩".
- **Without a passkey (R8 — the lockout):** an honest dead-end screen, not an error: "There is no
  way to restore access remotely — that's the design: nothing but your devices could grant
  access, and they're gone. To reconnect, go to each machine and pair it again." Per-host
  pairing instructions follow. A closing line states the lesson without scolding: "A passkey
  would have avoided this. You can create one after you're back in."

States: `intro → unlocking → restoring → restored` | `lockout` | `error`.

### 5.5 Revocation

**Remove a device** — one confirm dialog, three consequence tiers, all computed and named:

1. Always shown, in this order:
   - "Takes effect immediately on every online host. ⟨K⟩ offline hosts apply it the moment they
     next come online." (P3, stated precisely — no false "instantly everywhere".)
   - "Any live session from ⟨device⟩ ends now." (R1)
   - "Permanent. To use ⟨device⟩ again you'll link it as a new device." (R10 — the tombstone,
     phrased as the fresh-ceremony path, since that is the only true re-entry.)
2. **Sole-key hosts (R5):** if removal orphans hosts, a danger block names them: "⟨host⟩ trusts
   only this device. Remove it and ⟨host⟩ becomes unreachable until you pair it again at the
   machine." With a passkey available, the primary action becomes **"Back hosts with your passkey
   first"** — a passkey unlock that heals the hosts onto the passkey, then proceeds with a
   zero-collateral removal. Proceeding without it requires an explicit checkbox
   ("I understand ⟨host⟩ will need pairing again at the machine"). Refusing silently or
   auto-healing without saying so are both wrong: the first blocks the "kill it now" case,
   the second hides a consequence.
3. **Collateral devices (pre-heal chains):** devices whose access runs through the removed one
   are listed: with a passkey — "⟨device⟩ will lose access until your next passkey use" (P3″: the
   window closes at the next heal); without — "⟨device⟩ will lose access. Re-link it from another
   device." (its key is not removed, so a fresh ceremony readmits it).
4. In the steady state (everything passkey-backed) the dialog says exactly that: "No other
   device or host is affected." — the P3″ zero-blast-radius, made visible as calm.

The confirm button is not artificially frightening; the *asymmetry* copy appears when the user
hesitates on an unrecognized device: "If in doubt, remove it. You can always link a device
again."

**Reset passkey trust (the root)** — under the passkey card's Advanced link:

- Framing: "Only for suspected passkey compromise" — e.g. distrust of the passkey provider or a
  synced-credential leak. (Mesh §7: root compromise is master-credential class.)
- Consequences, all named before the typed confirmation:
  - "Hosts backed *only* by your passkey become unreachable until paired again at the machine:
    ⟨list⟩." (§4.1 rotation: ratcheted anchors die with the root; a host with no device key left
    is orphaned.)
  - "Your devices stay in the account and are re-backed by the new passkey trust immediately."
    (Reset runs under a passkey unlock, so the successor is minted and the heal runs in the same
    act — device blast radius zero.)
  - "The old passkey trust can never be restored." (R10 applies to the root too.)
  - "This does not remove any device. If you suspect a device, remove it first — resetting
    passkey trust without removing a compromised device protects nothing."
- Typed confirmation ("reset") rather than a checkbox: this is the one flow whose blast radius
  can include physical trips to machines.

### 5.6 No-passkey mode

Entered only through the cost sheet (from onboarding skip or from disabling later). The sheet is
a contract, not a nag — every documented cost, affirmatively acknowledged:

- "Lose all your devices → locked out of every host. The only way back is at each machine's
  keyboard." (R8)
- "New devices always require another device present to approve them." (no silent admission)
- "A host paired from one device may not be reachable from your others until you re-link those
  devices." (R7, stated honestly as a current limit of passkey-less operation)
- Strong recommendation rendered as a checklist item: "Keep at least two linked devices at all
  times." — and the single-device warning (§4.1 strip) becomes permanent signage in this mode.

Confirm: *I accept the lockout risk*. The overview strip carries the no-passkey warning
indefinitely; it is never dismissible (R8's cost is "documented", and documentation that hides
itself isn't).

### 5.7 Connection-refused moments

All refusals are **terminal screens with a named remedy** — never spinners, never auto-retry,
never a generic "connection failed" (that phrase is reserved for the network). Variants:

| State | Trigger (mechanism) | Copy + remedy |
|---|---|---|
| **This device was removed** | own key in `Rev` at connect | "This device was removed from the account on ⟨date⟩ from ⟨device⟩. Removal is permanent. If this was you — or if in doubt — nothing to do. To use spawn here again, link this device as new from a trusted device." No retry button exists. |
| **Session ended: device removed** (R1 teardown) | live teardown on `Rev` growth | Full-screen takeover over the dying terminal: "Your access was removed just now, and this session was closed everywhere. If you didn't expect this, your account owner (you, on another device) did it deliberately." Never rendered as "reconnecting" — a trust teardown must not look like Wi-Fi. |
| **Trust path broken** | chain contains a removed key | "Your access ran through ⟨device⟩, which has been removed." Remedy with passkey: "Use your passkey to re-secure this device." Without: "Re-link this device from another trusted device." |
| **Host unreachable — no keys left** | orphaned host (R5 happened) | "⟨host⟩ no longer trusts any of your devices. This requires pairing again at the machine." → pairing instructions. |
| **Host doesn't know this device's hosts list is stale** | R7 gap (no-passkey, host added after last link) | "⟨host⟩ was added from another device. Without a passkey, hosts reach your other devices when you re-link. Open spawn on ⟨pairing device⟩, or re-link this device." |

The session chrome carries a small permanent chip: **"End-to-end encrypted — verified"** with a
one-line popover naming the basis ("backed by your passkey" / "vouched for by ⟨device⟩"). One
chip, always present when connected, so its *absence* is meaningful and refusals above never
coexist with it.

---

## 6. Decisions made against (and why)

1. **Against tap-to-approve** anywhere. A5 mandates entry-style; tapping approves whatever is on
   the other screen without reading it.
2. **Against fingerprints in normal flows.** The committed SAS exists precisely so humans never
   eyeball hex. The full compare survives only in the legacy-host fallback, where the protocol
   requires it.
3. **Against a trust-graph visualization.** Provenance sentences per row are what R4 actually
   needs; a graph is impressive and unreadable in the moment that matters (spotting an intruder).
4. **Against a "removed devices" list with restore.** R10: un-revoke does not exist. The UI
   offering it would either lie or dead-end.
5. **Against surfacing the heal as a prompt.** There is nothing a human can verify at heal time;
   a prompt would be security theater and would train click-through. It surfaces as history +
   status upgrades only.
6. **Against naming the root.** Users get one anchor concept: the passkey. A second invisible
   super-key ("root") adds fear without adding a decision they can make.
7. **Against per-host device permissions.** P1 makes the mesh all-to-all; a permissions matrix
   would imply revocable per-host grants that the model doesn't have, and users would rely on
   phantom boundaries.
8. **Against auto-retry / "reconnecting…" on trust refusals.** Every refusal has a human remedy;
   spinners hide exactly the events (R1 teardown, revocation) the user most needs to see.
9. **Against making removal frightening.** The asymmetry (§1) says removal is the cheap
   direction; hesitation to remove is the costly failure mode. Danger styling is reserved for
   consequences (orphaned hosts), not for the act.
10. **Against a "sync devices" concept.** The bundle/heal machinery is invisible; presenting a
    sync switch would invite users to toggle a guarantee.

---

## 7. Screen/state → component map

| Component (`web/src/trust-ux/`) | Covers |
|---|---|
| `SecurityOverview` | §4.1 — passkey card (active / none), warning rows, all-clear line |
| `DeviceRoster` | §4.2 — every device row state, provenance, R5 inline warnings, remove |
| `HostTrustList` | §4.3 — backed / sole-key / orphaned / offline-pending-removal rows |
| `TrustHistory` | §4.4 — all event kinds incl. mismatch + reset (danger tones) |
| `LinkDeviceNew` | §5.3 joining side — choose (passkey/approval fork), waiting, code display, linked, declined, expired, integrity-failure, error |
| `LinkDeviceApprove` | §5.3 trusted side — incoming claim, code entry w/ attempts, verifying, approved, mismatch-reported, attempts-exhausted, expired, error |
| `PairHost` | §5.2 — instructions, waiting, code entry, fingerprint fallback, paired, mismatch-reported, attempts-exhausted, expired, error |
| `PasskeyOnboarding` | §5.1 — offer, creating, done, cost sheet (§5.6), error |
| `RecoveryFlow` | §5.4 — intro, unlocking, restoring, restored, lockout, error |
| `RemoveDeviceDialog` | §5.5 — all three consequence tiers + steady-state calm case |
| `ResetPasskeyTrustDialog` | §5.5 — root reset with typed confirmation |
| `ConnectionGate` | §5.7 — all five refusal variants |
| `VerifiedChip` | §5.7 — the session chip and its basis line |
| `bits` | shared primitives: match-code display, code entry (attempts + mismatch escape), pills, buttons, cards |
| `types` | all data + state-machine interfaces; callbacks for every action |

Every state named in §4–§5 is constructible via props on these components; the demo page at
`web/src/app/trust-ux-demo/page.tsx` renders each one.
