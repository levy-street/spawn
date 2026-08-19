# spawn — device trust mesh

**Status:** Design / proposed. Not yet implemented. Governed by [TRUST.md](./TRUST.md);
where the two disagree, TRUST.md wins on principle and this doc refines the
device-to-device and revocation mechanics.

This document defines how trust spreads across a user's **devices** (browsers)
and **hosts** (daemons) so that, from the user's point of view, *all of my
devices can reach all of my hosts* — with a single human check per new device,
effortless propagation, and instant per-device revocation — while the server
remains structurally unable to insert itself.

It exists because host onboarding (`possess`) is solved, but the multi-device
case is not: trust is endpoint-to-endpoint (each host pins the browser keys it
will talk to), so a brand-new device holds a key no host has ever seen. Logging
into the account is not enough. This doc is the target model and its proofs.

---

## 1. Goals (the properties we want)

Let a user own a set of hosts **H** and a set of devices **D**, both growing
over time in arbitrary order.

- **P1 — Completeness (full mesh).** Every device in **D** can connect to every
  host in **H**, for *all* orderings of additions and regardless of which hosts
  were online when a device was added.
- **P2 — Soundness (no server-inserted trust).** The server cannot cause any
  host to accept a key the user never verified. No MITM, ever.
- **P3 — Revocation.** Revoking a device denies it *everywhere*, effective from
  the moment each host is next reachable, without a trusted device having to
  contact every host — and delegating this to the server introduces no
  confidentiality risk.
- **P4 — One human check per device.** Admitting a device to the whole mesh
  costs exactly one human verification, independent of |H|.

The tension P1+P4 (effortless spread) usually fights P2+P3 (tight control). The
model below gets all four by exploiting one asymmetry: **adding trust wrongly is
catastrophic; removing it wrongly is only a denial of service.**

---

## 2. Threat model

- **The server is the adversary for confidentiality.** It relays and signals; it
  must never be able to read protected content or impersonate an endpoint. It can
  drop, delay, reorder, or fabricate anything it relays.
- **The server is trusted only in the fail-closed direction** (availability). It
  already has unconditional power to deny service (it is the mandatory relay). We
  never grant it any power whose misuse *grants* access.
- **Devices are honest.** They keep their private keys on-device and follow the
  protocol (they do not endorse a key without the human step). A *stolen,
  unlocked* device is out of scope until revoked — it can act as itself, which is
  what revocation is for.
- **The human is the ultimate verifier.** If the operator approves a mismatched
  number, that is outside the model, exactly as approving a wrong SSH fingerprint
  is outside SSH's.

---

## 3. Model and definitions

**Keys.** Every device `d` and every host `h` holds an asymmetric keypair
`(sk, pk)`; `sk` never leaves the device/host (non-extractable). Optionally the
account has a **root** `R = (sk_R, pk_R)` whose `sk_R` is sealed under the user's
passkey (the same passkey that seals the trust bundle in TRUST.md).

**Endorsement.** A signed statement
`e = Sign_{sk_a}(⟨"SPAWN-ENDORSE", account_id, pk_b⟩)`
meaning *issuer `a` vouches for key `pk_b` for this account*. The issuer `a` is a
device or the root. Endorsements are **account-scoped**, not per-host (this is
the deliberate change from today's per-host endorsement).

**Anchors.** Each host `h` pins a set of trusted keys `A(h)` — its **anchors**.
An anchor enters `A(h)` only by a human check: the possessing device's key at
`possess` time (the 6-digit host-pairing check), and/or the root `R`.

**Chain.** A device `d` reaches host `h` by presenting a chain
`pk_{a₀} → pk_{a₁} → … → pk_{aₖ} = pk_d`
where `pk_{a₀} ∈ A(h)` and each edge `e_i = Sign_{sk_{a_{i-1}}}(⟨…, pk_{a_i}⟩)`
is a valid endorsement. The device **carries** its chain and presents it on
connect. Length is unbounded; a root-endorsed device has a length-1 chain to `R`.

**Revocation set.** `Rev` is an account-level deny-list of public keys, held by
the server and delivered to each host on connect. `Rev(h)` is the copy `h` last
received. The account owner may only *add* to `Rev`; the server may only
*distribute* it; a host may only *subtract* the listed keys from acceptance.

**Admission rule.** A host `h` accepts a connection from `d` iff **all** hold:
1. `d` proves possession of `sk_d` (signs a fresh challenge);
2. `d` presents a valid endorsement chain from some `a₀ ∈ A(h)` to `pk_d`;
3. no key on the chain (including `pk_d`) is in `Rev(h)`;
4. the chain is a **simple path** — no key appears twice (mutual endorsements
   create 2-cycles; trust must not launder through a loop) — and its length is
   within a fixed bound `L_max` (validation-DoS cap).

**Continuous-enforcement rule.** Admission is re-evaluated for the *life* of a
session, not only at connect: on any `Rev` update, `h` immediately **terminates
every live session** whose chain contains a newly-revoked key. Blocking new
connections is not enough — see P3 and **R1**.

**Number-match (the admission gate).** An endorsement of `pk_b` is *created* only
after a **committed short-authentication-string (SAS)** ceremony between the
issuer's device and `b`: both endpoints first *commit* to their public keys, then
each derives the same short number from `(pk_a, pk_b, session)` and the human
confirms the two screens match (MS-Authenticator-style entry, not tap-to-approve).
Commit-then-reveal is mandatory — see §6, Proof of P2.

---

## 4. Operations

- **possess(h) by device d.** The human verifies the host↔device pairing — this
  is an **anchor ceremony and must meet A5** (committed ephemeral SAS, or a
  full-entropy fingerprint compare). `h` sets `A(h) ⊇ {pk_d}`. If a root exists,
  `d` also presents `R`'s endorsement of `d` and `h` adds `R` to `A(h)` (so the
  host anchors on the account, surviving loss of `d`). *The mesh's entire
  soundness (P2) inherits from this check — see **R2**.*
- **add-device(new = c, using existing = x).** One committed SAS number-match
  between `x` and `c`. On match, a **mutual** endorsement is created:
  `x → c` *and* `c → x` (both keys were verified in the same ceremony, so both
  directions are equally justified). If `x` holds the passkey, `c` is *also*
  endorsed directly by `R`. `c` receives the trust bundle (host keys) so it knows
  every host.
- **connect(d → h).** `d` presents its chain; `h` applies the admission rule.
- **revoke(d).** Account owner adds `pk_d` to `Rev`. Server pushes to all
  connected hosts immediately and holds it for offline hosts to fetch on
  reconnect. Each host removes any chain through `pk_d`.
- **heal / re-anchor (background, whenever a passkey device is present).** The
  passkey device re-endorses chain-admitted devices *directly off `R`*, shrinking
  their chains to length 1; and upgrades hosts still anchored on a device to also
  anchor on `R` (via an endorsement from a device the host already trusts). The
  star is the attractor state; chains are a transient bridge.

**Mutual endorsement is a required invariant of the chain fallback**, not an
optimization — Proof of P1 depends on it. **Re-anchoring to `R` is what drives
revocation blast radius to zero** — Proof of P3′ depends on it.

---

## 5. Assumptions (the proofs hold relative to these)

- **A1.** The signature scheme is EUF-CMA secure (Ed25519).
- **A2.** Private keys are non-extractable and never leave their device/host; the
  server never holds any `sk`.
- **A3.** Devices are honest: a device creates `endorse(pk_b)` only after a
  successful human number-match confirming `pk_b`. *(This is strong — a single
  compromised trusted device becomes a mesh-wide rogue CA; see **R4** for the
  detection/limitation defenses.)*
- **A4.** The human compares the two numbers correctly and aborts on mismatch.
- **A5.** The number-match is a **committed *ephemeral* SAS**: both endpoints
  contribute a *fresh ephemeral* key, **commit** (hash) before reveal, and the
  `k`-digit number is derived from *both* ephemerals (bound to the identity
  keys). A substituting server must inject its own ephemerals and commit *blind*,
  so it cannot grind — its per-ceremony success is `≤ 10⁻ᵏ` (one-shot).
  **Corollary (critical):** a short number derived from a *long-lived* key with
  **no** ephemeral + commitment is **grindable** — a server generates keys until
  the number matches (~`10ᵏ` work ≈ *seconds* for `k=6`) — and provides *no*
  security. In that construction the human MUST instead compare a full-entropy
  fingerprint (`≥ 96` bits). See Red-team finding **R2**.
- **A6 (enforced constraint, not merely assumed).** A host is reachable by a
  client *only via a server-mediated step at which the host checks `Rev`* — i.e.
  no session may be established through any path that skips server signaling
  (LAN/mDNS direct, cached/pre-issued offers, a future "local mode"). This must
  be *enforced*; P3 is false the moment any such bypass exists. See **R3**.

---

## 6. Properties and proofs

Throughout, the **endorsement graph** `G` has the account's device/root keys as
vertices and one undirected edge per mutual endorsement (plus a directed edge
root→device for each root endorsement). A *chain* to anchor `a` is a path from
`a` to `d` whose every edge is a validly-signed endorsement in the traversed
direction.

### P1 — Completeness (full mesh)

> **Theorem.** For every device `d ∈ D` and host `h ∈ H` of the account, `h`
> accepts `d`, for all addition orderings and independent of host online-ness at
> add time — provided no key on some `d`-to-`A(h)` path is revoked.

**Proof.** By induction on the order in which devices are added, we show every
device has a valid chain to every anchor in the account's endorsement graph
component.

*Base.* The first device `d₀` that possesses a host is placed in that host's
`A(h)` by `possess` (A3/A4 gate the human check). `d₀`'s chain to `A(h)` is the
trivial length-0 path. ✔

*Step.* Assume every device added so far has a valid chain to every account
anchor. Add device `c` via existing device `x`. `add-device` creates the mutual
endorsement `x ↔ c` (§4). Take any anchor `a ∈ A(h)`. By hypothesis `x` has a
valid chain `a → … → x`. Append edge `x → c` (valid, since `x` endorsed `c`):
this is a valid chain `a → … → x → c`. Hence `c` has a valid chain to `a`. ✔

*Why order and offline-ness are irrelevant.* Chain validity (admission rule
clause 2) is a **local signature check** over the presented chain against
`A(h)`. It requires no prior contact between `h` and any intermediate device, and
no intermediate device to have connected first. Therefore a host registered
*before* `c` existed, that has *never met* `c` or `x`, still accepts `c` the first
time `c` connects. Ordering and online-ness never enter the check. ∎

**What the proof forced us to add:** without the *mutual* edge, `G` is a directed
tree rooted at `d₀`, and a host anchored on a *non-root* device (e.g. one
possessed later by `c`) is unreachable by devices *above* `c` in the tree — the
exact "can C1 reach a host C2 registered?" gap. Mutual endorsement makes `G`
connected in both directions, restoring full mesh. The root/star model satisfies
P1 trivially (every device has a length-1 chain to `R ∈ A(h)`), which is why the
hybrid *heals toward the star*.

### P2 — Soundness (no server-inserted trust)

> **Theorem.** If `h` accepts `d`, then `pk_d` was human-verified (§3
> number-match) by a device transitively human-verified back to an anchor of `h`.
> Equivalently: the server cannot make `h` accept a key the user never verified,
> except with probability ≤ `10⁻ᵏ` per substitution attempt.

**Proof.** `h` accepts only via a chain `a₀ → … → pk_d` with `a₀ ∈ A(h)`
(admission clause 2). Each edge is `Sign_{sk_x}(endorse pk_y)`. By A1+A2 the
server cannot forge any edge (it holds no `sk_x`), so every edge was genuinely
produced by the holder of `sk_x`. By A3 that holder produced it only after a
human number-match confirming `pk_y`. `a₀` entered `A(h)` only by a human check
(§3). By induction along the chain, every key — in particular `pk_d` — was
human-verified at endorsement time. The server's only capability is relaying; it
can neither forge an edge nor introduce an anchor. ∎

**The `10⁻ᵏ` term, and what the proof forced us to add.** The one place the
server can attack is *inside* a number-match: relay `c`'s ceremony to `x` while
substituting its own key `pk_c'`. The defense is A5's commit-then-reveal: both
endpoints commit to their keys *before* the SAS is derivable, so a MITM must
commit to `pk_c'` **before** learning which number it needs — it cannot grind.
Its committed key yields a matching `k`-digit SAS with probability `10⁻ᵏ`, and the
ceremony is one-shot (A5). Without commit-then-reveal the server could grind a
colliding key offline in ~`10ᵏ` work (trivial), defeating the check — hence A5 is
mandatory, not cosmetic. With `k = 6`, per-attempt substitution success is `10⁻⁶`.

### P3 — Revocation: effectiveness

> **Theorem.** Once `pk_d ∈ Rev`, no host accepts a *new* connection from `d`
> from the moment that host is next reachable — and any *existing* session of
> `d` is torn down as soon as its host receives the update.

**Proof (new connections).** By A6 a client reaches `h` only via a server-mediated
step, and the server delivers `Rev` to `h` at that step before brokering the
session, so at every reachable state of `h`, `Rev(h) ∋ pk_d`. Admission clause 3
rejects any chain containing `pk_d`. There is no reachable state in which `h` is
both reachable by `d` and unaware of the revocation.

**Proof (live sessions).** A live session persists only while `h` is
server-connected (A6). The server pushes the `Rev` update to every connected
host; on receipt the continuous-enforcement rule terminates any session whose
chain contains `pk_d`. Absent that rule, a device revoked *mid-session* keeps its
open channel indefinitely (**R1**) — which is precisely the "kill my stolen
phone *now*" case revocation exists for. ∎

### P3′ — Revocation: safety of server delegation

> **Theorem.** Granting the server authority over `Rev` enables no confidentiality
> or impersonation attack; its worst misuse is denial of service, a power it
> already holds.

**Proof.** The server's only power over `Rev` is to add keys. By the admission
rule, `Rev` appears solely in clause 3, which can only *reject*; no value of
`Rev` causes clause 1 or 2 to accept a key they otherwise wouldn't. Hence no
addition to `Rev` makes `h` accept a new key — P2 is independent of `Rev`. The
only effect achievable is rejecting legitimate devices, i.e. DoS. By the transport
architecture the server can already deny service unconditionally (drop all
relayed traffic), so `Rev`-authority is not a new capability. ∎

**Residual (stated, not proven away).** A *malicious* server can **withhold** a
`Rev` update to keep a revoked device alive. Withholding is a subset of its
existing power (it can relay a thief's traffic directly regardless of `Rev`); it
still cannot read content or insert itself (P2). Availability trust in the server
is a standing assumption of TRUST.md; the escape hatch is self-hosting.

### P3″ — Revocation blast radius

> **Theorem.** Revoking a device that is a root-child (length-1 chain to `R`)
> affects no other device.

**Proof.** A device `d'` survives revocation of `pk_d` iff it has *some* valid
chain to an anchor avoiding `pk_d` (admission clause 3 rejects only chains
containing a revoked key). After healing (§4), every root-child has the length-1
chain `R → d'`, which contains no device key. Revoking any device key `pk_d`
leaves every such chain intact. ∎

Only devices still on a *transient* pre-heal chain through `pk_d` are collateral,
and that window closes at the next heal. This is why "collapse to the passkey
root" is the mechanism that minimizes blast radius: in steady state it is zero.

### P4 — One human check per device

> **Theorem.** Admitting a device to the entire mesh costs exactly one human
> number-match, independent of |H|.

**Proof.** `add-device` performs one number-match (§4). By P1, the resulting
(mutual) endorsement gives the device a valid chain to every host's anchor with
no further human action. Healing and re-anchoring are machine operations
authorized by the passkey (a consent tap, not a per-host comparison). Human cost
is therefore 1, independent of |H|. ∎

---

## 7. What is *not* proven / out of scope

- **Stolen, unlocked device before revocation.** It can act as itself until
  revoked — the reason P3 exists. Cascade (P3″) covers keys it may have endorsed.
- **Malicious server withholding revocation** — availability, not confidentiality
  (P3′ residual).
- **Passkey / root compromise** — equivalent to full account compromise; `R`
  anchors everything by design. Same class as losing a master credential.
- **Human approves a mismatched number** (violates A4) — user error, as with any
  SAS scheme.
- **Rigor level.** These are complete deductive proofs *relative to §5's
  assumptions*, not machine-checked. Mechanizing P1–P4 in a proof assistant
  (e.g. modelling `G`, the admission rule, and an adversary that controls
  relaying) is possible future work if we want an ironclad artifact; the SAS
  bound (P2) is the part most worth mechanizing.

---

## 8. Delta from what's built today

| Piece | Today | Target |
|---|---|---|
| Endorsement scope | per-host (`browser_endorsement.rs` binds to one host) | **account-scoped**, chain-validated |
| Endorsement delivery | pushed per-host | **carried by the device, presented on connect** |
| Endorsement direction | one-way | **mutual** in the add ceremony (P1) |
| Host anchors | possessing device's key | device key **and/or root**, multi-anchor chain validation |
| Root | trust bundle is passkey-sealed (host keys) | add a passkey-sealed **root key** as universal anchor + healing |
| Number-match | 6-digit host code shipped — **grindable, not the anchor (R2)** | committed *ephemeral* SAS (A5) for a sound short code, device↔device and at possess |
| Revocation | browser-device revoke exists; delivery path partial | account deny-list delivered on connect, subtract-only, **+ live-session teardown (R1)** |

The primitives (endorsement, passkey-sealed bundle, per-device keys, a 6-digit
verification code) already exist; the work is re-scoping endorsement to the
account, chain validation with multiple anchors, mutual endorsement + healing,
and the fail-closed `Rev` channel.

---

## 9. Red-team findings & resolutions

Findings from adversarially attacking §6. **R1–R3 broke a stated property as
written** and are now folded into the model above; the rest are sharpenings.

**R1 — Revocation left live sessions open (broke P3).** The admission rule only
governed *accepting* connections, so a device revoked mid-session kept its open
channel — the exact "kill it *now*" case. **Resolved:** added the
continuous-enforcement rule (§3) and the live-session half of P3.

**R2 — The shipped 6-digit code is grindable; soundness rested on it (threatened
P2 at the anchor).** The host key is a long-lived identity and the pairing has no
ephemeral/commitment, so a 20-bit number over it can be brute-forced by a
substituting server in ~seconds. The real anchor is the **96-bit fingerprint**,
which the shipped UI now demotes to fine print. **Resolved in model:** A5 rewritten
to require a committed *ephemeral* SAS for a short code to be sound, and possess
marked as an anchor ceremony that must meet A5. **Action item (touches prod):**
either restore the full fingerprint as the primary compare, or add a committed
ephemeral exchange so the short code is genuinely sound. Until then the 6-digit
is *convenience, not security*.

**R3 — A6 was assumed, not enforced (P3 silently voidable).** Any connection path
that skips server-mediated signaling (LAN direct, cached offers, "local mode")
lets a revoked device connect before the host hears `Rev`. **Resolved:** A6
restated as an enforced design constraint that any future connectivity feature
must not violate.

**R4 — A compromised (not stolen) trusted device is a mesh-wide rogue CA.** Any
trusted device can endorse, so malware on one device can silently endorse the
attacker's keys onto every host (and off `R` if it holds the passkey). Inherent
to endorsement systems, but A3 buried it. **Resolution:** (a) keep a **visible,
audited device/endorsement roster** so a rogue endorsement is *detectable* and
revocable; (b) prefer **root-only endorsement when a passkey is present**,
leaving device-endorsement as the no-passkey fallback — shrinking the rogue-CA
surface to passkey-holders. Detection + fast revocation is the realistic defense.

**R5 — Revoking a host's *sole* anchor orphans the host.** If `A(h) = {pk_d}` (no
root) and `d` is revoked, every chain must pass the revoked anchor → `h` is
unreachable; re-possess required. **Resolution:** healing a host to a root anchor
is a **precondition** for cleanly revoking a device that is some host's sole
anchor; the revoke flow must refuse or auto-heal first.

**R6 — SAS `session` underspecified (relay/reflection).** A short SAS needs
`session` to be a **fresh nonce with entropy contributed by both endpoints**, or
a server can reflect one concurrent ceremony's commitment into another. Folded
into A5's "ephemeral from both endpoints."

**R7 — Acceptance ≠ discovery.** P1 proves a host *accepts* a device; it does not
give the device the host's *key* to dial in. That rides on the passkey-sealed
bundle, so **no-passkey devices have no specified way to learn new hosts**.
**Resolution:** in pure device-chain mode, host keys must gossip the same way
client keys do — carried in the mutual add-device exchange. Specify this (open Q).

**R8 — No-root, single-device loss = total lockout.** With no root and one
device, losing it strands every host (re-possess all). **Resolution:** strongly
encourage (or require) either a root or a *second* device before this is the only
recovery path; document it as the explicit cost of no-passkey mode.

**R9 — Migration is a downgrade surface.** While per-host *and* account-scoped
endorsements both validate during rollout, a server picks the weaker.
**Resolution:** retire the per-host path deliberately and refuse it once a host
supports account-scoped chains.

**R10 — Un-revoke silently re-grants.** Endorsements have no expiry and `Rev` is
add-only; removing a key from `Rev` re-admits it via its stale endorsement.
**Resolution:** revocation is a **permanent tombstone** — re-admitting a device
requires a *fresh* number-match and endorsement (new key or new ceremony), never
un-revoking.

**R11 — Endorsement graph is server-visible metadata.** The server relays/stores
endorsements, so it learns device topology (who endorsed whom). Consistent with
TRUST.md's metadata stance; noted so it is not mistaken for a leak of content.

**Verdict.** The core claim — *the server can slam doors, never open them* —
survives. With R1–R3 folded in, P1–P4 hold under §5. R2 is the one that reaches
into shipped code and needs a product decision.

## 10. Open questions

- Root creation UX: when/how is `R` minted, and what is the no-passkey story for
  users who never create one (pure device-chain mode — supported, heals never)?
- Chain length bound in practice, and whether to cap it (DoS on validation).
- `Rev` delivery detail: full list vs. delta, and its authentication to the host
  (the host must accept `Rev` as subtract-only regardless of its authentication).
- Re-anchoring triggers: eager on every passkey presence vs. periodic.

---

## Appendix A — The committed-ephemeral SAS (concrete protocol)

This is the construction A5 requires: a 6-digit number a substituting server
**cannot grind**. It is Bluetooth Secure Simple Pairing "Numeric Comparison" /
MANA-III, adapted to our relay-mediated flow. Used at `possess` (host↔browser)
and at `add-device` (browser↔browser); below is the host↔browser instance.

### Values

- `H` — the host identity public key (32 B), as *each endpoint sees it*.
- `B` — the browser device public key (32 B), as *each endpoint sees it*.
- `Nd`, `Nb` — fresh 32-byte random nonces from the daemon and browser.
- All hashes are SHA-256; `‖` is concatenation of fixed-width fields.

### Messages (relayed verbatim by the server; it may substitute, not forge)

1. **Commit (daemon → browser):** the daemon sends `H` and
   `Cd = SHA256("SPAWN-SAS-COMMIT-V1" ‖ H ‖ Nd)`. `Cd` *hides* `Nd`.
2. **Reveal-B (browser → daemon):** the browser — having seen only `Cd` — sends
   `B` and its nonce `Nb`.
3. **Open-D (daemon → browser):** the daemon sends `Nd`. The browser checks
   `Cd == SHA256("SPAWN-SAS-COMMIT-V1" ‖ H ‖ Nd)` and aborts on mismatch.

Both endpoints then compute, using the `H`/`B` values *they* hold:

```
digest = SHA256("SPAWN-SAS-V1" ‖ H ‖ B ‖ Nd ‖ Nb)
SAS    = ( u32_be(digest[0..4]) mod 1_000_000 )   ->  "NNN NNN"
```

The daemon prints `SAS`; the browser shows it; the human compares. On match the
existing approval + possession proof proceed unchanged (they bind the pairing;
the SAS authenticates the *keys* against substitution).

### Why the server cannot grind (security argument)

A MITM `S` plays *browser* toward the daemon and *daemon* toward the browser.

- Toward the browser it must send `Cd'` in msg 1 — committing to *its* nonce
  `Nd'` (and its substituted `H'`) **before** it sees `Nb` (msg 2).
- Toward the daemon it must send `Nb'` in msg 2 — chosen **before** it learns
  `Nd` (the daemon opens only in msg 3, and msg 1's `Cd` hid it).

So the two SAS values `S` induces —
`SAS_browser = f(H', B, Nd', Nb)` and `SAS_daemon = f(H, B', Nd, Nb')` — are each
fixed by `S` **before** the opposing fresh nonce is revealed. `S` controls
`H', B', Nd', Nb'` but not `Nd` or `Nb`, and commitment ordering forbids it from
adapting `Nd'`/`Nb'` afterward. Under SHA-256-as-random-oracle the two numbers
collide with probability `2⁻²⁰ ≈ 10⁻⁶` per one-shot ceremony — **not grindable**,
because grinding requires choosing a substitute *after* seeing the target, which
the commitment forbids. (Contrast the shipped code: no `Nd`/`Nb`, `SAS` a
function of the long-lived `H` alone → `S` grinds a matching `H'` in ~`10⁶` work.)

### Flow integration (relay-mediated, poll-based)

The three moves layer onto the existing device-code exchange:
`Cd` rides `device/start`; `Nb` rides the browser's pending/approve step; `Nd` is
revealed to the browser via a poll/fetch before it displays the SAS. Exact wire
fields are an implementation detail; the hash inputs above are normative.

### Rollout & backward-compatibility (resolves R9)

Both sides advertise SAS support. **If both support it → SAS mode** (sound 6
digits). **If either is old → fall back to the full 96-bit fingerprint compare**,
never to the grindable short code. The weak short code is thus never the
comparison value in any version combination; mixed fleets degrade to the
*stronger* check, not the weaker.

### Test vectors

Normative cross-implementation vectors (Rust `sas` module ⟷ web `sas.ts`) live
with the code and are asserted in both; a drift there silently weakens the check.
