# spawn — device trust mesh

**Status:** Implemented and live-validated end-to-end (2026-08-20) on branch
`feat/device-mesh` (unmerged; deployed to dev). §8 records what shipped per
stage and how it was validated. Governed by [TRUST.md](./TRUST.md); where the
two disagree, TRUST.md wins on principle and this doc refines the
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

*One computer is one device.* The desktop companion and the web app it loads
into its own window are the **same** `d`: the companion hands its `sk` to that
webview in-process, never through the server (`desktop/CLAUDE.md`, "the page is
this app's device"; `web/src/lib/desktop-device-handover.ts`). The key the page
then signs with is the key in `A(h)` from `possess`, so no second device is ever
minted for the computer that was possessed, and the companion's own signed host
introductions are firsthand to the page (§4, R7) — they verify under a key it
holds, not one it was told about.

**Endorsement.** A signed statement
`e = Sign_{sk_a}(⟨"SPAWN-ENDORSE", account_id, pk_b⟩)`
meaning *issuer `a` vouches for key `pk_b` for this account*. The issuer `a` is a
device or the root. Endorsements are **account-scoped**, not per-host (this is
the deliberate change from today's per-host endorsement).

**Anchors.** Each host `h` pins a set of trusted keys `A(h)` — its **anchors**.
An anchor enters `A(h)` only by an out-of-band check: the possessing device's
key at `possess` time (since 2026-08-21 the URL-fragment host-key check — see
the Appendix A note; previously the 6-digit host-pairing SAS), and/or the root
`R`.
**Ratchet (as built):** once `R` enters `A(h)`, it stays there even if the
device whose endorsement installed it is later revoked — the installer was
trusted at installation time, and an `R`-anchor that died with a device would
re-couple recovery to that device's fate, voiding P3″. Removing `R` from
`A(h)` requires revoking `R` itself (which also lands `pk_R` on `Rev`).

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

- **possess(h) by device d.** The host↔device pairing is verified out of band —
  this is an **anchor ceremony and must meet A5**. As built (2026-08-21) the
  check is the URL-fragment host-key equality (full key, exact, machine-checked
  over a channel the server never carries — Appendix A note), with the
  full-entropy fingerprint compare as the no-fragment fallback; the committed
  ephemeral SAS was the previous mechanism. `h` sets `A(h) ⊇ {pk_d}`. If a root exists,
  `d` also presents `R`'s endorsement of `d` and `h` adds `R` to `A(h)` (so the
  host anchors on the account, surviving loss of `d`). *The mesh's entire
  soundness (P2) inherits from this check — see **R2**.*
- **add-device(new = c, using existing = x).** One committed SAS number-match
  between `x` and `c`. On match, a **mutual** endorsement is created:
  `x → c` *and* `c → x` (both keys were verified in the same ceremony, so both
  directions are equally justified). If `x` holds the passkey, `c` is *also*
  endorsed directly by `R`. `c` receives the trust bundle (host keys) so it knows
  every host.
- **approve-knock(new = c, from existing = x)** *(2026-08-25; the mobile app's
  admission path).* `c` knocks (`/api/trust/device-approvals`, advisory — grants
  nothing; the server also pushes the knock to the account's phones, minus
  `c`'s own). Every screen `x` that some host trusts shows the prompt; its one
  action, "Enter its number", runs `add-device(c, x)` above, the committed SAS
  with `x` as initiator and `c` as joiner (the phone speaks both roles as of
  this date), so the human types the four-digit number `c` shows and the
  mutual endorsement follows. There is no look-and-click approve and no
  fingerprint compare on this path: a number the server cannot grind is the
  check, on the phone exactly as in the browser. Toward a host without
  `supports_account_chains` nothing here applies (R9 exemption path unchanged).
- **connect(d → h).** `d` presents its chain; `h` applies the admission rule.
- **revoke(d).** Account owner adds `pk_d` to `Rev`. Server pushes to all
  connected hosts immediately and holds it for offline hosts to fetch on
  reconnect. Each host removes any chain through `pk_d`.
- **heal / re-anchor (background, at every passkey moment).** The passkey
  device re-endorses chain-admitted devices *directly off `R`*, shrinking
  their chains to length 1; and upgrades hosts still anchored on a device to also
  anchor on `R` (via an endorsement from a device the host already trusts). The
  star is the attractor state; chains are a transient bridge.

**Mutual endorsement is a required invariant of the chain fallback**, not an
optimization — Proof of P1 depends on it. **Re-anchoring to `R` is what drives
revocation blast radius to zero** — Proof of P3′ depends on it.

### 4.1 The root lifecycle (as built, stage 5)

- **Mint.** `R` is generated during passkey creation; its seed is sealed into
  the passkey trust bundle *before* `pk_R` is registered or endorses anything —
  a root whose seed is not durably recoverable must never become an authority.
  Server-side, `pk_R` is stored as an account-level key (at most one live root
  per account) that can **endorse but never be endorsed, never pairs, and never
  connects**.
- **Heal trigger.** Every passkey unlock is a heal: `R→d` endorsements for all
  live devices lacking one, plus the host anchor upgrade. The anchor upgrade is
  not a new statement type — it is the existing host-scoped endorsement, with
  `pk_R` as the endorsed key, signed by a device the host already pins; the
  daemon re-verifies it exactly as any pin adoption (P2 preserved), and the
  resulting anchor ratchets (§3).
- **Retrofit.** A bundle sealed before the root existed gains one at its next
  unlock: the bundle is resealed under the *same* data key with the fresh root
  inside, so every enrolled passkey keeps working without gathering the other
  passkeys' secrets.
- **Rotation (root compromise response).** Revoking `R` tombstones it (`pk_R`
  joins `Rev`; the ratcheted anchors die with it). The next passkey unlock
  detects the revoked sealed root, mints a successor, reseals it over the dead
  one, and heals off the successor. Consistent with R10: the old root is never
  un-revoked.
- **`pk_R` provenance rule (client discipline).** A device only ever treats a
  key as "the root" if it learned `pk_R` firsthand — at mint, from the
  unsealed bundle, or (since 2026-08-22) from a **verified root
  introduction** (below). The server's claim of which key is the root is
  cross-checked against that and a mismatch aborts loudly; a substituted root
  must never be endorsed or anchored.
- **Root introductions + the pinned-device anchor sweep (2026-08-22).** The
  per-host anchor upgrade must be signed by a device the host *pins*, but the
  passkey can live on an unpinned (chain-admitted) device — in which case the
  heal's upgrade 409s everywhere and the root anchors nowhere (the field bug,
  §9). The cure is structural: `pk_R` rides the same firsthand gossip channel
  as host keys. A device that knows the root firsthand (mint/unlock) signs a
  domain-separated `SPAWN-ROOT-INTRO-V1` statement
  (`account ‖ introducer_pk ‖ root_pk`), published durably (one row per
  introducer, `root_introductions`, migration 0041; the server hygiene-checks
  and withholds revoked introducers — mailbox only). A recipient honors a row
  ONLY when the introducer's key is in its ceremony-seeded firsthand
  peer-key store and the signature re-verifies against that copy; it then
  records `pk_R` in a durable firsthand-root store. **Conflict rule
  (fail-closed):** a verified introduction naming a different key than one
  already held records nothing and surfaces loudly; a *successor* is adopted
  only when the old key's revocation is corroborated roster+tombstone (B2's
  rule), the verified introducers are unanimous, and the successor is alive.
  **The sweep:** on the continuous-gossip cadence, a device holding active
  local pins that firsthand-knows `pk_R` and observes (advisory pin lists) a
  pinned host lacking the root anchor signs the existing per-host
  `SPAWN-BROWSER-ENDORSE-V1` upgrade for it — over the host key from its
  LOCAL pin store, binding the roster root row's id only after checking that
  row's key equals the firsthand `pk_R`. The daemon re-verifies as with any
  pin adoption (P2 preserved); repeats are idempotent. This also closes the
  former "possess-time anchor-on-`R`" gap: a newly possessed host is anchored
  by the possessing device's next sweep.
- **Heal robustness + honesty (2026-08-22).** Every heal statement is
  isolated: one failed `R→d` endorsement neither aborts the remaining
  endorsements nor skips the anchor half. The report is per-id
  (endorsed/failed device ids, upgraded/refused host ids with reasons) and
  carries `rootEndorsedSelf` — verified against *re-fetched* edges with real
  signature checks, so a server that answers 200 without storing reads as
  false. The unlock claims success only on that flag; anything less is
  surfaced as the partial result it is. The anchor loop iterates the UNION of
  bundle hosts and the device's active local pins (both firsthand), and
  **every unlock reseals** the bundle with any local pins it lacks — under
  the same data key at a bumped revision (CAS; a concurrent loser skips and
  converges next unlock) — so the bundle tracks the fleet instead of
  fossilizing at setup time.
- **No-passkey mode** remains supported: pure device-chain operation, no heal,
  R8's lockout cost applies and is the mode's documented price.

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
- **A7 — signed-RTC enforcement is on** (`SPAWND_REQUIRE_SIGNED_RTC ≠ 0`, the
  built default; prod pins it via a drop-in). A daemon refuses an unsigned RTC
  offer; with the escape hatch set, it accepts raw first-contact and **P5 below
  is false at its first step**. Load-bearing — treat any path that weakens it as
  A6 treats a signaling bypass. *(Code-verified 2026-08-19; see **R12**.)*

*Verification status (2026-08-19): A2 and the P5 enforcement path were audited in
code by two subagents that cross-reviewed each other — A2 holds for both the
browser key `sk_B` (non-extractable, `web/src/lib/signed-signal.ts`) and the host
seed `sk_H` (`daemon/src/creds.rs`); only signatures + public keys ever leave.
Defense-in-depth notes (not A2 violations): the host seed is stored plaintext at
rest in the headless 0600-file fallback (keyring elsewhere) and is not `mlock`ed.
`StoredCreds` derives `Serialize` and the seed IS serialized — but only to local
at-rest stores (keyring/file), never a network body; the outbound file projection
already strips it (`file_creds_without_private_seed`). The safe future-proofing is
that projection/wrapper pattern — **not** `#[serde(skip)]`, which would break
keyring persistence and lose the host identity across restarts.*

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

*Caveat made explicit by the F1 field bug (§9): the theorem's premise is that
healing actually installed the `R` anchors. When the passkey lives on an
unpinned device, the heal alone cannot install any (the per-host upgrade must
be signed by a pinned device), so the steady state was never reached. The
root-introduction channel + pinned-device sweep (§4.1) restore the premise:
any pinned device that firsthand-knows `pk_R` drives hosts toward the anchored
state, and the remove flow verifies the anchor before relying on this theorem.*

### P4 — One human check per device

> **Theorem.** Admitting a device to the entire mesh costs exactly one human
> number-match, independent of |H|.

**Proof.** `add-device` performs one number-match (§4). By P1, the resulting
(mutual) endorsement gives the device a valid chain to every host's anchor with
no further human action. Healing and re-anchoring are machine operations
authorized by the passkey (a consent tap, not a per-host comparison). Human cost
is therefore 1, independent of |H|. ∎

### P5 — Authentication soundness (proof-of-possession admission)

*Code-verified against the shipped enforcement path (2026-08-19), cross-reviewed
by two independent subagents. This theorem is about the **connect** step; it is
what makes "public keys are safe for the server to see" a proven property, not an
assertion.*

> **Theorem.** Under A1, A2, and **A7** (signed-RTC enforcement on), a party
> completes a data-plane (WebRTC) connection to host `h` only by proving
> possession of a private key `sk` whose public key `pk` is pinned by `h` — where
> `pk` is an anchor of `h` or was admitted by an endorsement signed by a key `h`
> already pins. Consequently a party holding only *public* keys — in particular
> the relay/signaling server — **cannot connect to `h` as a trusted client**,
> except by the same `≤ 10⁻ᵏ`-per-attempt SAS substitution already bounded in P2.

**Proof.** Let party `P` complete a connection to `h`.

*Every accepted offer carries a signature over the connection's own key material.*
Under A7 `h` refuses an unsigned offer outright (and refuses a mixed signed+raw
offer before reading either), building an answer only through the signed path. So
`P`'s offer was an envelope carrying an Ed25519 signature `σ` over a transcript
`T` that **includes the offer SDP** — hence the browser's fresh per-connection
DTLS fingerprint `F` — and names `h` as intended peer, bound to the session id.

*`h` accepts only if `σ` verifies (`verify_strict`) against a key `h` has pinned.*
`h` checks `σ` against its own host key (as intended peer) and against each key in
its pinned browser set, accepting on the first `pk` that verifies, else rejecting.
The verify is strict and keys are canonicality/small-order-checked, so A1's
EUF-CMA guarantee is realized, not voided by a malleable encoding. By A1+A2 the
server holds no `sk` and cannot forge `σ` for a `pk` it does not possess; so
acceptance implies `σ` was produced by the holder of `sk` for a pinned `pk`.

*A pinned `pk` is anchored or validly endorsed — the server cannot inject one.* A
key enters `h`'s pinned set only via (i) an operator-approved pairing whose
browser signature `h` verifies (an **anchor**, human-gated per §3/§4), or (ii)
endorsement adoption, which verifies the endorsement against a key **already in
`h`'s pinned set**, snapshotting the trusted set *before* the pass so a key
admitted this pass cannot bootstrap another within it. This is P2 applied to the
connect step. *(Scope note, updated 2026-08-20: the account-scoped multi-hop
carried chain of §3 is now the shipped enforcement — `find_valid_chain` admits
from the unordered edge-set the device carries, DFS from `A(h)` to the
connecting key, simple-path, `Rev`-subtracted, length-capped at 8 — in addition
to the direct-pin fast path. Live-validated for both host-control and agent
terminals.)*

*Possession of `sk` alone can't hijack — the channel binds to the media key.*
Because `σ` covers the SDP, `F` is authenticated under `pk`, and `P` completes the
connection only by finishing the DTLS handshake with the private key whose
fingerprint is `F`. A party that merely **replays** a captured envelope (the
server) cannot: it lacks that ephemeral media key, and substituting its own
fingerprint breaks `σ`. So the identity signature and the DTLS handshake are one
**channel-bound** proof-of-possession, from `pk` down to the live media key.

Combining: `P` connected ⇒ `h` accepted `σ` under a pinned `pk` (anchored or
validly endorsed) ⇒ `P` held `sk` **and** the bound media key. A party with only
public keys satisfies neither. The sole residual is substituting a key *during*
the anchor/endorsement ceremony, bounded by A5's committed SAS to `≤ 10⁻ᵏ`
per one-shot attempt (P2). ∎

**What this made explicit.** (1) **A7 is load-bearing** — with enforcement off,
`h` accepts a raw unsigned offer and this theorem fails at step 1; the
browser-side pin gate does not stop a server opening its own unsigned session.
(2) **The "fresh challenge" of §3 clause 1 is realized as channel-binding, not a
host-issued nonce** — freshness/anti-replay rests on WebRTC minting a fresh
ephemeral DTLS key per connection and on `σ` covering the session id + intended
peer (which blocks cross-session/cross-host splicing), not on a nonce `h` picks.

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

## 8. Implementation record (all stages shipped, branch `feat/device-mesh`)

| Stage | What shipped | Validation |
|---|---|---|
| 1 | Account-scoped endorsement `SPAWN-ACCT-ENDORSE-V1`, byte-identical across daemon/web/server, shared test vector | cross-implementation vectors asserted in all three |
| 2 | `validate_chain` + `RevocationSet` (subtract-only, `revokes_beyond`) | unit (24 tests) |
| 3a–b | Server endorsement store; browser↔browser committed-SAS add-device ceremony (Appendix A, browser↔browser instance), **mutual** endorsement on match | live on dev: two browsers, same SAS, mutual edges landed |
| 3c | `find_valid_chain` admission from the carried edge-set; wire: `carried_endorsements` on the signed offer, relay pass-through | live: unpinned device admitted `chained=true` for host-control **and** agent terminals |
| 4 | Fail-closed `Rev`: `revoked_browser_keys` delivered to every account host on connect and on change; deny-list growth triggers live-session teardown (R1) | live: revoked device denied new connects; open terminal dropped mid-session |
| 5 | Root lifecycle of §4.1: mint at passkey creation, sealed-in-bundle (survives passkey enroll/revoke resealing), full heal on unlock, retrofit for pre-root bundles, rotation after root revocation, anchor ratchet | live recovery drill: all devices revoked → passkey unlock on a fresh device → `chained=true` to the host |
| 6 | R4 roster (per-device provenance, audit log, R5 revoke warnings) + R9 retirement (daemon advertises `supports_account_chains` at register; server **ratchets** the flag and refuses per-host device endorsement toward such hosts — the root anchor upgrade is the one surviving per-host statement) | live: mixed fleet — new daemon refused legacy path with ceremony pointer, old daemons unaffected; roster verified on-screen |
| R7 | Host-key gossip over the add-device exchange: the approver signs `SPAWN-HOST-INTRO-V1` (`account ‖ approver_pk ‖ host_pk ‖ joiner_pk`) per host it holds an ACTIVE local pin for, posts the set on the pairing relay (set-once, post-reveal, before its endorsement edge so the joiner's completion cue implies the list is present); the joiner verifies each against the **ceremony-pinned** approver key + its own key and approves the host key locally like a hand-run possession. Web-only; the daemon never sees the statement (deliberately not `SPAWN-BROWSER-ENDORSE-V1` — no cross-protocol signature reuse) | unit (tamper: swapped host key / signer / joiner / account); live: two-context SAS, joiner's first terminal connect reads fully verified |
| R7-cont | CONTINUOUS gossip: (a) a device that verifies a host publishes a durable `SPAWN-HOST-INTRO-BCAST-V1` vouch (`account ‖ publisher_pk ‖ host_pk`) to the account store (`host_introductions`, migration 0040) — at possess time and via a reconcile sweep that retroactively publishes pre-existing pins; (b) every device keeps a durable FIRSTHAND peer-device-key store, seeded ONLY at ceremony completion (both roles persist the SAS-pinned peer key) and by `SPAWN-DEVICE-INTRO-V1` device introductions the approver signs into the same ceremony payload — NEVER from server-claimed metadata (a self-signed edge naming an attacker key verifies under its own claim: honoring it would be a full MITM; unit-tested as the trap case); (c) recipients honor a broadcast row only when its publisher key is in that firsthand store and the signature re-verifies against the firsthand copy, then pin locally (a conflicting binding never overwrites — the held pin is the substitution signal). Server hygiene-verifies at insert against the registered key, caps per account, and withholds rows from revoked publishers on GET; recipients also drop revoked peers from their firsthand memory | unit (trap: unknown-publisher self-signed row moves no trust; tamper; replay-to-wrong-joiner); server (idempotent republish, revoked-publisher filter, cap); live: second host possessed AFTER the ceremony arrives verified on the peer with no new ceremony |

| R-intro | Root introductions + pinned-device anchor sweep (§4.1, 2026-08-22): `SPAWN-ROOT-INTRO-V1` store (0041, one row per introducer, rotation replaces own row), firsthand-root memory with the fail-closed conflict rule, sweep signs the per-host upgrade only where the device is pinned and only over local-pin host keys; heal made per-statement with the per-id honest report and `rootEndorsedSelf` gate; reseal-on-unlock merges local pins into the bundle; `/pins` + `/pin-details` filtered through the daemon's shared transitive-liveness helper; the remove dialog's reachable promise gated on verified anchoring | unit (web 372 / server suites), shared web⟷server transcript vector; live: the field sequence re-run — passkey minted on an UNPINNED device, pinned device's sweep anchored both hosts, sole-pinned-device removal kept them reachable |

Not yet done: merge to master + prod rollout. ~~Folding possess-time
anchor-on-`R` into the possess flow~~ — subsumed by the anchor sweep
(2026-08-22): a newly possessed host is anchored by the possessing device's
next sweep cycle if any of its devices firsthand-knows `pk_R`. R7 residuals
after the continuous leg: a device approved BEFORE the
continuous build holds no firsthand peer keys, so it needs ONE more ceremony
(re-approval) — or a passkey heal — to seed its store; from then on coverage is
continuous. And an introduction is only as honest as the publishing device:
A3's rogue-CA blast radius applies to host vouches exactly as to endorsements,
with R4 detection (the roster and log) as the defense. The sealed bundle
remains the catch-up channel of last resort.

---

## 9. Red-team findings & resolutions

Findings from adversarially attacking §6. **R1–R3 broke a stated property as
written** and are now folded into the model above; the rest are sharpenings.

**R1 — Revocation left live sessions open (broke P3).** The admission rule only
governed *accepting* connections, so a device revoked mid-session kept its open
channel — the exact "kill it *now*" case. **Resolved:** added the
continuous-enforcement rule (§3) and the live-session half of P3.

**R2 — The shipped 6-digit code is grindable; soundness rested on it (threatened
P2 at the anchor).** The host key is a long-lived identity and the pairing had no
ephemeral/commitment, so a 20-bit number over it could be brute-forced by a
substituting server in ~seconds. **RESOLVED (built + validated, branch
`feat/sas-pairing`):** implemented the committed-ephemeral SAS of Appendix A
across server (relay endpoints, migration 0030), daemon, and browser; deleted the
grindable code; every path now shows the sound SAS or the 96-bit fingerprint,
never the weak code. Unit + integration + adversarial e2e green, and validated
**live end-to-end on dev** — daemon and browser independently computed the same
number (`923 579`) over the real relay. Merged to master 2026-08.

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
*(Built, stage 6: the roster shows per-device provenance — who vouched for whom —
plus a newest-first trust log of every live endorsement.)*

**R5 — Revoking a host's *sole* anchor orphans the host.** If `A(h) = {pk_d}` (no
root) and `d` is revoked, every chain must pass the revoked anchor → `h` is
unreachable; re-possess required. **Resolution:** healing a host to a root anchor
is a **precondition** for cleanly revoking a device that is some host's sole
anchor; the revoke flow must refuse or auto-heal first. *(As built, stage 6 +
2026-08-22: the revoke confirm computes the orphan set from the
transitively-LIVE pin lists — a revoked co-pin or revoked root no longer masks
sole-trust (F1d) — and, with a passkey and the host online, auto-heals via the
pre-removal unlock. The "stays reachable" promise is honored only when the
heal VERIFIABLY anchored (or found anchored) every at-risk host; otherwise
the dialog withdraws it and removal stays available only as an explicit
"Remove anyway" — warn-not-refuse, but never warn-then-lie.)*

**R6 — SAS `session` underspecified (relay/reflection).** A short SAS needs
`session` to be a **fresh nonce with entropy contributed by both endpoints**, or
a server can reflect one concurrent ceremony's commitment into another. Folded
into A5's "ephemeral from both endpoints."

**R7 — Acceptance ≠ discovery.** P1 proves a host *accepts* a device; it does not
give the device the host's *key* to dial in. That rides on the passkey-sealed
bundle, so **no-passkey devices have no specified way to learn new hosts**.
**Resolution (built):** in pure device-chain mode, host keys gossip the same way
client keys do — carried in the mutual add-device exchange. The approver signs a
domain-separated `SPAWN-HOST-INTRO-V1` statement per host it has itself verified
(its active local pins), scoped to the exact joiner key the SAS authenticated;
the relay carries it set-once; the joiner verifies against the ceremony-pinned
approver key and pins locally. **Extended to CONTINUOUS delivery** (§8 R7-cont
row): verified hosts are also published as durable `SPAWN-HOST-INTRO-BCAST-V1`
vouches that every device holding the publisher's key FIRSTHAND (a durable
peer-key store seeded only inside ceremonies, bootstrapped across hops by
`SPAWN-DEVICE-INTRO-V1` handovers) verifies and pins on its own — so a host
possessed AFTER a device joined arrives already verified, no passkey and no
re-ceremony. Residual: devices approved before the continuous build need one
more ceremony to seed their firsthand memory.

**R8 — No-root, single-device loss = total lockout.** With no root and one
device, losing it strands every host (re-possess all). **Resolution:** strongly
encourage (or require) either a root or a *second* device before this is the only
recovery path; document it as the explicit cost of no-passkey mode.

**R9 — Migration is a downgrade surface.** While per-host *and* account-scoped
endorsements both validate during rollout, a server picks the weaker.
**Resolution:** retire the per-host path deliberately and refuse it once a host
supports account-scoped chains. *(Built, stage 6: the daemon advertises
`supports_account_chains` at register; the server ratchets it onto the host —
an old build reconnecting never reopens the path — and refuses per-host DEVICE
endorsements toward such hosts. The root anchor upgrade, being a statement
about that host, is the one surviving per-host use.)*

**R10 — Un-revoke silently re-grants.** Endorsements have no expiry and `Rev` is
add-only; removing a key from `Rev` re-admits it via its stale endorsement.
**Resolution:** revocation is a **permanent tombstone** — re-admitting a device
requires a *fresh* number-match and endorsement (new key or new ceremony), never
un-revoking.

**R11 — Endorsement graph is server-visible metadata.** The server relays/stores
endorsements, so it learns device topology (who endorsed whom). Consistent with
TRUST.md's metadata stance; noted so it is not mistaken for a leak of content.

**R12 — Host-side proof-of-possession is enforcement-gated (A7).** P5 holds only
while `SPAWND_REQUIRE_SIGNED_RTC ≠ 0`. It is the built default and prod pins it
on, but with the escape hatch set a daemon accepts a raw unsigned offer and a
server can open its own unsigned session — the browser-side pin gate does not stop
that. **Resolution:** A7 is a stated premise of P5; treat any future path that
weakens enforcement as A6 treats a signaling bypass. *(Code-verified 2026-08-19;
also fixed a stale "off by default" comment in daemon/src/run.rs.)*

**Security-review hardenings B1–B5 (2026-08-22, PR #25 review).** Four
server-trust findings, fixed on-branch; one invariant recorded. **B1:** the
registration proof is now `SPAWN-BROWSER-REGISTER-V2` with the root claim
bound as a signed flags byte — `is_root` had been a server-mutable request
field feeding real authority (the sole R9 per-host-endorsement exemption and
the root pin-liveness ratchet); the server now verifies the claim against the
proof, so a flipped flag is refused, with shared vectors pinning both flag
values and both flip directions (green-field cutover, no v1 window). **B2:**
root rotation no longer destroys `sk_R` on a bare server claim — rotation
retires the outgoing seed into a bounded, sealed `retiredRoots` archive
(refusing at the cap rather than evicting), and the trigger requires the
roster's revoked row to carry the sealed `pk_R` AND the key to appear in the
permanent add-only tombstone table (new authenticated GET), so a fabricated
"revoked + no live root" roster is uncorroborated: nothing rotates, the
operator is told, and even a corroborated lie now destroys nothing. **B3:**
`removeLastPasskey` revokes only the roster row whose key equals the
bundle-unsealed `pk_R` (loud skip otherwise), and the root-registration
response is verified field-for-field before healing proceeds — the server's
`is_root` labeling alone never selects what gets revoked or anchored.
**B4:** the carried-endorsement relay now has a module-load fit proof (exact
worst-case serialized-JSON arithmetic, token-alphabet field values so bytes ==
characters) that a maximal sanitizer-accepted edge set fits the 64 KiB routing
bound, and the Redis→daemon hop documents why sanitize is not re-run there
(the daemon independently caps at 64 and re-verifies every signature).
**B5 (stated invariant, no code change):** a fingerprint served by the
control plane must never be DISPLAYED as a comparison value without local
recomputation from the accompanying key — every current surface re-derives
(`canonicalHost`, roster fingerprints), and any future surface must too, or
the human check of A4/A5 silently degrades into trusting the adversary's
label. *(Follow-up, same review: the invariant is now structural — the
server no longer serves a fingerprint next to a key the response already
carries (`BrowserDeviceOut.fingerprint`, `HostOut.host_key_fingerprint`,
the approve-response fingerprints, `endorsed_key_fingerprint`), so a lazy
consumer of the redundant field cannot exist. The only fingerprints still
on the wire are the possession-ceremony ones the daemon prints/verifies —
`DevicePendingResponse`/`DevicePollSuccess` and the signed approve request
— each cross-checked against the key at the point of use.)*

**F1 — FIELD BUG (owner-hit, 2026-08-22): the unpinned passkey anchored the
root nowhere, and the remove flow promised protection it never verified.** A
passkey was created on a chain-admitted (UNPINNED) device. The heal's per-host
root anchor upgrade must be signed by a device the host pins (the server 409s
otherwise — correctly, per R9/P2), so every upgrade was refused and `R`
anchored **nowhere**; the failure was additionally invisible because one
refused statement aborted the whole loop and the reports were count-only.
The R5 remove dialog then promised *"you'll confirm with your passkey so it
stays reachable"* gated only on passkey-exists + host-online; the pre-removal
unlock "succeeded" vacuously, and revoking the sole pinned device orphaned
every host. Two independent security reviews confirmed the cluster
(P-C1/C2/C3/C4/C7). **Resolved (same date):** (a) the structural cure — root
introductions + the pinned-device anchor sweep (§4.1), so `pk_R` reaches
pinned devices over the firsthand channel and they anchor it; (b) the heal
made per-statement with a per-id report and the `rootEndorsedSelf` honesty
gate; (c) reseal-on-unlock + local-pin union, so the bundle and the anchor
loop track the fleet; (d) `/pins` and `/pin-details` filtered through the
daemon's own transitive-liveness computation (a revoked root can no longer
pose as a co-pin and suppress the R5 warning); (e) the remove dialog's
promise is now *verified or withdrawn* — every at-risk online host must be in
the heal's `upgradedHostIds` or show the live root anchor in refreshed pins,
else the dialog returns in its honest branch (warn-not-refuse preserved).
The general lesson is B5's, one level up: **a flow must never promise an
outcome it did not verify** — success copy is part of the trust surface.

**Passkey-lifecycle hardening (fresh-context review, 2026-08-22).** A second
review pass over the passkey layer found a cluster of lifecycle-edge bugs
(P-C5/P-C6 plus three adjacent), all closed the same day. (a) *Seal before
enroll:* setup ordered server-enroll → second gesture → seal, so a failure
mid-way (Safari's user-activation expiry is routine) left a GHOST credential —
listed, offered, opening nothing; now the order is create → PRF → seal →
putBundle (CAS) → enroll, unlock offers only the server-list ∩ envelope-wraps
intersection (falling back to the wraps themselves for the half-enrolled
state, then re-registering after the verified open — no retry deadlocks), and
a provably wrap-less credential can be removed as cleanup after a working
passkey proves a fresh envelope. (b) *Forget honesty:* the device-local
"forget hosts" wrote `revoked` tombstones, so the device never returned to the
unpinned path, imports skipped those hosts forever, and the unlock claimed
"already knows your hosts" over zero pins; forgetting now DELETES the records
(tombstone provenance: a retained tombstone always means a targeted per-host
removal, which imports still honour and signed-RTC still refuses), and the
unlock status reports every bucket including "stayed removed". (c) The bundle
DELETE gained the same revision CAS as PUT (a delete racing another device's
backup enrollment stranded the fresh credential); the final-passkey removal
abandons an unreadable-but-present bundle only after a second, exact
acknowledgement, and fails outright on transient errors. (d) The retired-root
archive cap no longer throws out of the unlock (the 9th rotation permanently
broke recovery): rotation now evicts the OLDEST retired seed. (e) History/roster
honesty: `R→d` edges render as "Approved by your passkey", never as a sign-in
claim the operator may not have made — the same lesson as F1, applied to the
audit surface: **display copy must not overclaim provenance**.

**Verdict.** The core claim — *the server can slam doors, never open them* —
survives, and now with code-level backing: A2 (private keys never leave) and P5
(connection requires proof-of-possession of a pinned key) were audited in the
shipped code by two cross-reviewing subagents. R2 is **resolved** (committed SAS,
built + validated). The remaining gap to the *target* mesh is structural
(account-scoped multi-hop chains, root/star, fail-closed `Rev`), not a hole in
what ships.

## 10. Open questions — resolved in the build, plus what remains

- ~~Root creation UX~~ → §4.1: minted at passkey creation; retrofit at unlock
  for pre-root bundles; no-passkey mode = pure device-chain, supported, never
  heals (R8's cost documented).
- ~~Chain length bound~~ → capped at 8 edges (`DEFAULT_MAX_CHAIN_EDGES`),
  simple-path enforced.
- ~~`Rev` delivery~~ → full list (`revoked_browser_keys`), delivered in the
  registration frame and on every pin push; the host treats it as subtract-only
  regardless of provenance, so its authentication is irrelevant to soundness.
- ~~Re-anchoring triggers~~ → every passkey moment (mint and each unlock);
  no periodic timer.

- ~~R7 host discovery~~ → host-key gossip carried in the add-device exchange
  (`SPAWN-HOST-INTRO-V1`, §8 R7 row) AND continuously thereafter
  (`SPAWN-HOST-INTRO-BCAST-V1` + firsthand peer-key stores, §8 R7-cont row);
  the bundle is now the catch-up channel of last resort only.

- ~~Possess-time anchor-on-`R`~~ → subsumed by the root-introduction channel
  and the pinned-device anchor sweep (§4.1, 2026-08-22): a newly possessed
  host gains the `R` anchor at the possessing device's next sweep cycle, with
  `pk_R` always firsthand-derived, never the server's `is_root` claim.

**Still open:** merge + prod rollout (alembic 0031–0041).

---

## Appendix A — The committed-ephemeral SAS (concrete protocol)

This is the construction A5 requires: a 6-digit number a substituting server
**cannot grind**. It is Bluetooth Secure Simple Pairing "Numeric Comparison" /
MANA-III, adapted to our relay-mediated flow. Used at `add-device`
(browser↔browser). Below is the original host↔browser instance, kept as the
normative description of the construction.

> **Possession no longer uses the SAS (2026-08-21).** `spawnd possess` now
> verifies the host key through an **out-of-band URL fragment** instead: after
> receiving `verification_uri`, the daemon appends its own host public key
> *locally* as `#k=<host_public_key_wire>` (overwriting any server-supplied
> fragment) and refuses a `verification_uri` that is not same-origin with the
> server the operator pointed it at. URL fragments are never sent in HTTP
> requests, so the key rides terminal→browser without transiting the server;
> `/device` asserts the server-claimed `host_public_key` **exactly equals** the
> fragment and refuses to pin or approve on any difference (or on a damaged
> fragment). This is A5 by different means — full-key, exact, machine-checked
> equality over a channel the server never touches, replacing a 6-digit human
> compare — and it removes the human comparison step entirely (the remaining
> click is pure intent). A link with **no** fragment (older daemon, retyped
> URL) falls back to the full-fingerprint compare below, never a weaker code.
> The committed SAS remains the device↔device (`add-device`) check, unchanged.

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
