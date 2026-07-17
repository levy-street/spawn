# Trust Phase 3 — independent security audit (signed signaling + fingerprint pinning)

**Date:** 2026-07-17
**Branch audited:** `master`
**Scope:** the Phase 3 "signed RTC signaling + Ed25519 host identity + fingerprint pinning"
workstream (`p3-*` branches; `signed_signal*`, `host_identity`, browser device identity,
device flow, live RTC signaling relay).
**Method:** three independent passes that were run separately and then cross-checked —
(1) daemon crypto primitives + wire adapter + transcript specs, (2) browser/web client,
(3) FastAPI server relay + identity/device-flow. All three converged on the same central
finding, which raises confidence it is real and not an artifact of one reading.

This is an *independent second opinion* produced in parallel with the implementer's own
review. It is advisory. Nothing here was modified in the tree.

---

## Bottom line

The signed-signaling **cryptographic foundation is high quality** — better than most
production crypto code in this class. But it is a **dormant, well-tested library, not a
live defense**. The signed path has **zero live callers** across daemon, server, and web;
the running system still exchanges raw, unsigned SDP on `rtc.offer`/`rtc.answer`.

Therefore, against the project's stated threat model (a hostile relay must be
*structurally unable* to MITM the DTLS DataChannel), **that property is not yet in force
anywhere.** The MITM exposure on `master` today is the same as before Phase 3 began — the
work so far builds the machinery to close the gap, not the closure.

This matches the specs' own disclaimers verbatim (`proto/SIGNED_SIGNAL_V1.md:5-7`,
`proto/SIGNED_SIGNAL_WIRE_V1.md:3-5`: "not installed on a live WebSocket route yet"). So
this is a *status-framing* correction, not an allegation of a defect: "6/7 branches
merged" measures the foundation, not the guarantee. The load-bearing half — live
integration + trust bootstrap — is still ahead, and is the error-prone part where the
findings below will bite.

---

## Credit — the foundation is sound (verified-correct)

Checked and found correct; no defect:

**Daemon primitive + wire layer (`daemon/src/signed_signal.rs`, `signed_signal_wire.rs`)**
- Signature is over a canonical, domain-separated **binary** transcript, not JSON; JSON
  field/byte order is untrusted and the transcript is reconstructed before verify.
- `verify_transcript` uses **`verify_strict`** (`signed_signal.rs:311`) — the correct
  malleability/forgery-resistant choice — and is tested against the actual identity-key
  universal forgery, which plain `verify` accepts and `verify_strict` rejects
  (`signed_signal.rs:944-945`).
- Public-key ingress recompresses the point to enforce RFC 8032 canonical encoding and
  rejects the small-order subgroup (`signed_signal.rs:328-335`), against a 40+ vector
  negative corpus (8 weak, 40 noncanonical, off-curve, mixed-torsion controls).
- Strict fixed-width base64url decode rejects wrong width/padding/alphabet before decoding
  (`signed_signal.rs:399-427`).
- Wire adapter fails closed correctly (`signed_signal_wire.rs:232-278`): validates caller
  pins as strictly as envelope keys; `deny_unknown_fields` (`:123`); algorithm allow-list;
  **rejects on sender/peer pin mismatch before signature check** (`:255`, `:258`);
  downgrade-resistant protocol/scope/version tuple enforcement; input bounded before parse.
  All 12 envelope fields have fail-closed mutation tests.
- **SDP is a signed transcript field** (`SIGNED_SIGNAL_V1.md:30`) — so a valid signature
  *does* cover the DTLS fingerprint. The design is right; it simply isn't invoked yet.

**Browser library (`web/src/lib/signed-signal*.ts`, `browser-device-identity.ts`)**
- Verify reconstructs the transcript and re-encodes canonical bytes; `subtle.verify`
  boolean is honored and the function throws on any error, fail-closed
  (`signed-signal-wire.ts:169-182`, `signed-signal.ts:367-390`).
- Sender/peer pins canonicalized before `===` compare (`signed-signal-wire.ts:149-168`).
- Small-order rejection via `@noble/ed25519` strict `Point.fromBytes(raw,false)` +
  `isSmallOrder()` (`signed-signal.ts:121`); canonical base64url round-trip
  (`:410-436`); duplicate-top-level-key rejection blocks parser-differential attacks
  (`signed-signal-wire.ts:297-337`).
- `browser-device-identity.ts` is a solid TOFU-once store for the **browser's own**
  Ed25519 identity (non-extractable key, single-winner IDB create `:354-390`, self-check
  on load `:311-341`, delete requires expected key `:484-543`). Scoping caveat below: this
  is the browser's account-registration identity, **not** a host-key pin.

**Server (`server/spawn_server/host_identity.py`, `routes/device.py`, `schemas.py`, …)**
- Canonicalization is complete at **every** API ingress: all host-key/signature/fingerprint
  entry points call `decode_ed25519_public_key` / `decode_ed25519_signature`
  (`host_identity.py:72-88`, `_decode_strict_ed25519_point:24-69`;
  `browser_registration.py:40-52`; `schemas.py:109-135,161-172`).
- TOFU cross-user fail-closed: foreign-owner claim returns `key_conflict`/409
  (`device.py:266-274,386-389`); same-owner re-login reuses the row, never rewrites the key
  (`:289-294`); key immutable (`HostPatch` `extra="forbid"`, `schemas.py:204-208`; unique
  constraint `models.py:192-195`).
- Device-flow binding constrains a malicious client: approve requires body==stored
  tuple==derived fingerprint (`device.py:368-376`) via a conditional one-shot UPDATE
  (`:391-403`). Device codes are one-shot (`:131-155,297-304`).
- Signaling owner tokens are monotonic-generation fenced (`host_signal.py:315-362`),
  rejecting stale-owner replay (`:185-188`).

---

## Core finding — the signed path is not wired in

The verifier has **no non-test caller anywhere** (repo-wide grep for
`verify_rtc_signal_wire`/`sign_rtc_signal_wire`/`verifyRtcSignalWire`/`signRtcSignalWire`
outside the module files + tests returns empty). The live path is unsigned end to end:

| End | Live call site | State |
|---|---|---|
| Daemon | `rtc.rs:530` `handle_offer` → `create_answer` → `Outbound::RtcAnswer { sdp: local_sdp }` (`:755-763`); host path `:770/802/886-894` | Sends raw SDP; never verifies incoming offer; never signs answer. `signed_signal*` modules compiled (`lib.rs:9-10`) but unused. |
| Browser | `useAgentSocket.ts:1133` and `hostControl.ts:689` `setRemoteDescription({sdp: <relayed>})` | Accepts raw relayed answer SDP; no verify. Offers sent unsigned (`useAgentSocket.ts:1040`, `hostControl.ts:782`). |
| Server | `ws/host.py`, `ws/browser.py`, `ws/daemon.py` relay | Relayed `rtc.*` frames carry no `signature`/identity fields at all. |

**Attack that still works today:** a hostile relay terminates DTLS itself, rewrites each
side's SDP with its own fingerprint, and relays plaintext — on both the PTY channel and the
**host-filesystem control** channel (`fs.*` in `hostControl.ts`, larger blast radius).

---

## Findings that bite *during or after* wiring

The "not wired yet" state is expected. These are the traps that will cause real problems
when it *is* wired, ranked. Each is anchored to code.

### F1 — Asymmetric relay silently strips offer signatures (fix before wiring)
`ws/host.py:_signal_payload:81-92` (used `:494-504`) and `ws/browser.py:461-475` rebuild the
**offer** with a fixed field set, so a browser-signed offer's `signature` /
`sender_identity_public_key` / `intended_peer_identity_public_key` are dropped by the relay.
The **answer** direction forwards the whole daemon dict (`ws/host.py:203`,
`ws/browser.py:296`) — so the relay is asymmetric. A Phase-3 wiring cannot rely on the
existing relay to carry offer signatures; this will fail confusingly.

### F2 — `setRemoteDescription` must consume the *verified* SDP, not the raw relayed SDP
Both browser call sites (`useAgentSocket.ts:1133`, `hostControl.ts:689`) pass the raw
`msg.sdp`. After adding verification, they must pass `verified.transcript.sdp` (the copy
covered by the signature) and reject renegotiated fingerprints — otherwise the fingerprint
binding is silently lost even though verification "passed."

### F3 — `binding_nonce` / `binding_generation` is a false friend
`web/src/lib/ws.ts` `rtcBindingFrameMatches` matches `session_id` + a browser nonce + a
**server-assigned** `binding_generation` + scope/protocol — all server-controlled/relayed,
so the relay trivially satisfies it while substituting its own fingerprint. It binds session
authority among relayed frames, **not** the DTLS peer. Do not let it stand in for MITM
protection. ICE candidates are likewise added unsigned (`useAgentSocket.ts:1152`,
`hostControl.ts:699`) — acceptable only once the fingerprint is actually verified.

### F4 — No trust source for the pin
`verifyRtcSignalWire`'s `expectedSenderPublicKey` pin has **no producer anywhere**, and no
host-key TOFU pin is persisted or compared on the browser. Server-provided
`host_public_key`/`host_key_fingerprint` are **display-only** (`api.ts:81-83,254-256`;
host page `page.tsx:228`; device-approval `device/page.tsx:110-119`) — and trusting the
server's copy would mean trusting the hostile party. The only non-server channel is the
device-approval fingerprint compare (human, out-of-band). The pin bootstrap + persistence
is the missing half (tracked by `p3-daemon-browser-pins`, still unmerged at audit time).

### F5 — Server is the sole authority for the fingerprint the endpoints trust
`host_key_fingerprint` is server-derived (`host_identity.py:108-113`; `hosts.py:_to_out:48-66`;
`device.py:296,326`). With no live-path signature binding that key to the transport (core
finding), a hostile server can assert/swap the fingerprint the endpoints then trust.

### F6 — Null-keyed (pre-0017) hosts are a downgrade surface
`hosts.py:_to_out:48-66` returns `host_public_key=null`/`host_key_fingerprint=null` for
legacy hosts (migration `0017` leaves them null), with no positive "unverifiable" signal.
Nothing server-side requires a host be keyed before its signaling socket is served, so a
client that does not itself fail closed on null connects fully unauthenticated.

### F7 — No proof-of-possession at daemon pairing
`device.py:device_start:51-115` is unauthenticated and accepts any `host_public_key` with
**no signature** — unlike browser registration, which requires a signed transcript
(`browser_registration.py:55-68`). The daemon WS handshake authenticates by bearer token
only (`ws/daemon.py:75-90`); the daemon never proves it holds the pinned private key. The
pin binds a key the pairing party need not possess (defense-in-depth given the connection
would later need the private key to sign, but worth closing).

### F8 — Host deletion frees the key→owner pin (no tombstone)
`hosts.py:delete_host:570-585` deletes the `Host` row, freeing `uq_hosts_host_public_key`,
so another user may re-pair the same public key and become its owner
(`test_device.py:477-494`). Browser devices keep a permanent revocation tombstone
(`browser_devices.py:33-41`); hosts should too. Owner-initiated, so not a direct server
attack, but the (key→owner) pin is not durable.

### Nits
- DB check constraints enforce only `length=43`, not canonicality/point validity
  (`models.py:185-195`, migration `0017:25-33`); canonical/small-order checks live solely in
  the app layer. Defense-in-depth gap for any future direct DB writer.
- `web/src/lib/hostIdentity.ts` has **no implementation** — only `hostIdentity.test.ts`,
  which asserts Zod schema shape. Don't mistake the test name for coverage of live
  host-identity verification.

---

## Integration definition-of-done

For the signed path to actually deliver MITM resistance, wiring must:

1. **Sign** browser offers via `signRtcSignalWire`.
2. **Verify** every answer via `verifyRtcSignalWire` **before** `setRemoteDescription`.
3. Feed the **verified** `transcript.sdp` into WebRTC (not the raw relayed SDP), and reject
   renegotiated fingerprints (F2).
4. Treat a missing/unsigned/unverifiable answer as **fatal** — no fallthrough to the current
   unsigned accept (downgrade protection).
5. **Bootstrap the daemon pin out-of-band** (device-approval fingerprint is the only
   non-server channel) and **persist it fail-closed**, with hard refusal on mismatch (F4).
6. Fix the **asymmetric relay** so offer signature/identity fields survive forwarding (F1).
7. Fail closed on **null-keyed hosts** (F6); consider requiring a host be keyed before its
   signaling socket is served.
8. Add **proof-of-possession** at pairing (F7) and a **durable key→owner tombstone** (F8).

---

## Note on assurance ceiling (unchanged, for completeness)

Even fully wired, `SIGNED_SIGNAL_V1.md:87-93` is correct that server delivery of the browser
bundle is not independent client attestation — a hostile operator can still ship a web client
that skips verification. Signed signaling makes MITM **detectable to independently
obtained/verified endpoint builds** (the L1→L2 story in `docs/TRUST.md`); it does not make the
hosted web client self-protecting. That is a property of the trust model, not a bug in this
work.
