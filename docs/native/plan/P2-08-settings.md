# P2-08 — Settings, profile, appearance and device trust

**Phase 2, parallel with nine other agents.**

**Read first:** `00-OVERVIEW.md` (§3 D8 accepted limitations, §5, §7.1, §7.7, §8), then
`research/12-auth-and-flows.md §3` (the complete settings inventory with every control, default and
persistence location), and `research/05-trust-and-crypto.md` for the trust panels.

## 1. Objective

The Settings tab root and every panel under it.

## 2. Files you own

```
src/app/(tabs)/settings/**
src/components/settings/**
src/data/queries/settings.ts
```

## 3. Specification

### 3.1 The panel list is exactly nine

`research/12 §TL;DR 6`: **Account, Appearance, Notifications, Hosts, Agents, Skills, Templates,
Browser devices, Device trust.**

"Terminal", "Sessions" and "Security" are **not** settings panels in this product. Do not add them.
Terminal font size lives with the terminal (`P2-05`); do not duplicate it here unless
`research/12` shows it in Appearance.

Hosts/Agents/Skills panels overlap `P2-06`'s surfaces — you own the **settings-side** entry points
and any account-level configuration; `P2-06` owns the Hosts tab root. Link rather than duplicate.

### 3.2 Every control, exactly

For each panel, implement every control `research/12 §3` enumerates with its label, control type,
default, persistence location, and whether it is **per-device or per-account**. That distinction
matters: a per-device preference must not be written to the account, and vice versa.

- **Appearance**: theme mode via `P1-03`'s `SegmentedControl` → `useThemeMode()` from `@/theme`.
  Persisted per device.
- **Notifications**: the preference keys and defaults from `research/10 §4`. In Expo Go there is
  **no remote push** and the server has no push backend (`00-OVERVIEW.md §3 D8`) — render the
  push-dependent preferences with an explicit unavailable explanation rather than a toggle that
  does nothing.
- **Account**: profile fields, email, password change, sign out, delete/deactivate if the API
  supports it. Sign out clears `authToken` and returns to the gate.
- **Browser devices**: list registered devices, show this device, revoke others.
- **Device trust**: the phone's identity, its fingerprint, host pins, endorsement state. Passkey
  PRF is **unavailable in Expo Go** — use `P1-06`'s capability probe and render its explicit
  unavailable state with the reason. Never show a control that cannot work.

### 3.3 Copy and haptics

Quote the web app's labels and descriptions. Toggles fire `haptics.selection()`; destructive
actions confirm and fire `haptics.warning()`.

## 4. Rules
- No new preference keys. Use the ones `research/12` and `research/10` document, with the same
  storage location, so the phone and web agree where they share an account.
- Secrets go through `P1-06`'s `secureStorage`; preferences go to AsyncStorage.
- Do not build a settings framework — a list of screens with rows is right.

## 5. Tests
- Every panel renders its full documented control set (a data-driven test over the inventory).
- Per-device vs per-account persistence goes to the right store (mock both).
- Theme mode change updates `useThemeMode` and persists.
- Passkey-unavailable state renders from the capability probe.
- Push-dependent notification prefs render as unavailable.
- Sign out clears the token and routes to the gate.

## 6. Deliverables checklist
- [ ] Exactly the nine documented panels, no invented ones
- [ ] Every control with correct default and per-device/per-account persistence
- [ ] Unavailable states for passkey PRF and remote push, with reasons
- [ ] Sign out, device revocation, host pins
- [ ] Tests green; `typecheck`, `lint` clean; progress + report written

## 7. Reporting
Progress `docs/native/progress/P2-08.md`; report `docs/native/reports/P2-08.md` with the full
control inventory as shipped.
