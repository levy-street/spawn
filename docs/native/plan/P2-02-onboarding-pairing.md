# P2-02 — Onboarding and the host pairing ceremony

**Phase 2, parallel with nine other agents.**

**Read first:** `00-OVERVIEW.md` (§5, §7.7, §8), then `research/12-auth-and-flows.md §4` (the
onboarding flow and what a phone can/cannot do), then `research/05-trust-and-crypto.md §8` (the
pairing protocol) and its §2-4 for identity and pinning.

## 1. Objective

Get a new user from "signed in, no hosts" to "a paired host", on a phone.

## 2. Files you own

```
src/app/(onboarding)/**
src/components/onboarding/**
src/data/queries/pairing.ts
```

## 3. Specification

### 3.1 A phone cannot host spawnd

`research/12 §TL;DR 5`. The phone's job is to **explain** and then **approve**:

1. Tell the user to run the installer and `spawnd login` on a supported Mac/Linux machine.
2. Show the install command with a **copy button** (`expo-clipboard`) — the exact command from the
   web onboarding flow, which `research/12` records.
3. Then move to approval.

Do not pretend the phone can install a host. Do not hide the step.

### 3.2 The pairing ceremony

`research/05 §TL;DR 10` — this exists today and needs no new protocol:

- The daemon starts a **30-minute device-code ceremony**.
- The user enters the **eight-character code** on the phone.
- The user **compares fingerprints** between machine and phone.
- The phone **pins** the host key and **signs approval**.

**There is no QR protocol in the current implementation.** Do not build a QR scanner for pairing.
(`expo-camera` is installed for other purposes; leave it alone here.)

Requirements:
- Code entry uses `P1-03`'s `Input` with the 8-character validator, auto-uppercasing if the code
  set is uppercase, and a clear per-character presentation. `textContentType="oneTimeCode"`.
- Fingerprint comparison must be **unmissable**: large, monospace, formatted identically to the
  machine's display (`P1-06` owns the formatter). The user must actively confirm a match — a
  single "Approve" button with the fingerprint in small text is a security-UX failure.
- Pin + approve go through `P1-06` (`deviceIdentity.signApproval`, host-pin store). Never
  reimplement crypto here.
- The 30-minute expiry is real: show remaining time and handle expiry with a clear restart path.
- Every failure mode from `research/05 §4` — mismatch, missing identity, revoked pin, unreadable
  storage — gets a distinct, accurate screen. **Fail closed**; never offer "continue anyway".

### 3.3 Endorsement

`research/05 §5` — an already-trusted device can endorse the phone, which is the smoother path when
one exists. Offer it when the account has another trusted device, and fall back to direct pairing.
Passkey PRF is unavailable in Expo Go (`00-OVERVIEW.md §3 D8`) — if a flow would need it, show
`P1-06`'s explicit unavailable state.

## 4. Rules specific to you

- No crypto here. `P1-06` owns it; you own screens and flow.
- Onboarding is entered from `P2-01`'s gate; do not implement gating yourself.
- Haptics: `success()` on a completed pairing, `error()` on a mismatch.

## 5. Tests

- The onboarding step resolver as a pure function of account/host state.
- Code input validation and formatting.
- Each trust failure mode renders its own distinct state (mock `P1-06`'s result union).
- Expiry countdown transitions to the expired state (fake timers).
- Copy-to-clipboard fires with the exact install command.

## 6. Deliverables checklist

- [ ] Install-instruction step with copyable command
- [ ] 8-character code entry with validation and expiry handling
- [ ] Prominent fingerprint comparison requiring explicit confirmation
- [ ] Pin + approve via `P1-06`, failing closed on every error case
- [ ] Endorsement path when a trusted device exists
- [ ] No QR pairing built
- [ ] Tests green; `typecheck`, `lint` clean
- [ ] Progress current; report written

## 7. Reporting
Progress `docs/native/progress/P2-02.md`; report `docs/native/reports/P2-02.md`.
