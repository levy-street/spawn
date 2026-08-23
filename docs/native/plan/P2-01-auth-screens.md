# P2-01 — Auth screens, session bootstrap and the auth gate

**Phase 2, parallel with nine other agents.**

**Read first:** `00-OVERVIEW.md` (§3 D2 auth decision, §5, §7.3, §8), then
`research/12-auth-and-flows.md` §1-3 for the flows, exact validation rules and **verbatim error
copy**, then `research/03-server-api.md`'s auth endpoint catalogue.

## 1. Objective

Ship every unauthenticated screen, the session bootstrap, and the gate that decides what the app
shows on launch.

## 2. Files you own

```
src/app/(auth)/login.tsx
src/app/(auth)/signup.tsx
src/app/(auth)/forgot-password.tsx
src/app/(auth)/reset-password.tsx
src/app/(auth)/verify-email.tsx
src/app/(auth)/_layout.tsx
src/components/auth/**
src/data/queries/auth.ts
src/lib/auth-gate.tsx          # the gate component + bootstrap hook
src/**/__tests__/** (yours only)
```

## 3. Specification

### 3.1 The gate

`research/12 §TL;DR 1`: the gate order is **Account → Verify (only when enforced) → Host → Done**,
and it is driven by **live account/host state, not a locally advanced wizard index**. Implement it
that way: read `me` and `hosts`, decide the destination, and never persist a "step number".

- No token → `(auth)/login`.
- Token but unverified **and** verification is enforced → `verify-email`.
- Verified but zero hosts → hand off to `P2-02`'s onboarding route.
- Otherwise → the tab roots.

Email verification enforcement is a server capability flag, not an assumption — read it from the
auth-config endpoint (`research/03`).

Subscribe to `P1-05`'s unauthenticated event (its plan §3.2) so a `401` anywhere in the app
returns to login exactly once, without every screen handling it.

### 3.2 Login and signup

Use `P1-03`'s `Field`/`Input` with the correct `purpose` values (`email`, `password`,
`newPassword`) so iOS autofill and Strong Password work. Validation rules come from
`P1-03`'s `validation.ts`: signup password **8–256**, reset password **12–256** — they differ.

On success, call `authToken.captureFromResponse(res)` (`00-OVERVIEW.md §3 D2`) — this is the whole
auth strategy; do not store the short-lived JSON `access_token` instead. Then seed the `me` query
and let the gate route.

Signup may be invite-only (`research/12 §TL;DR 10`, `research/06 §TL;DR 8`) — handle the invite
field and the server's rejection copy.

**OAuth buttons**: Google/Microsoft/GitHub cannot complete in Expo Go (`00-OVERVIEW.md §3 D8`).
Render them **disabled with a visible reason**, only for the providers the server reports as
configured. Do not hide them and do not fake the flow.

### 3.3 Forgot / reset / verify

Reset links last **one hour**, verification links **two days**, both single-use, and a newly issued
link supersedes the old one (`research/12 §TL;DR 2`). Surface expiry and reuse as distinct,
accurate messages — not a generic failure.

These screens are reachable by deep link. Accept the token from route params; `P3-01` owns the
linking config, you own consuming the params.

### 3.4 Copy

Quote the web app's strings exactly as `research/12` records them. Do not improve the wording.

## 4. Rules specific to you

- Keyboard handling: form scrolls so the focused field stays visible; return key advances; submit
  from the last field.
- No business logic in route files — screens compose components from `src/components/auth/`.
- Do not build the onboarding flow (`P2-02`) or settings (`P2-08`).

## 5. Tests

- The gate's decision function as a **pure unit**: every combination of token/verified/enforced/
  host-count → expected destination. Extract it from the component to make this possible.
- Form validation wiring: invalid input blocks submit and shows the exact copy.
- Login success path calls `captureFromResponse` and seeds `me` (mock the API layer).
- 401 event routes to login exactly once.
- OAuth buttons render disabled with a reason when providers are configured, and are absent when
  they are not.

## 6. Deliverables checklist

- [ ] Five auth screens + layout, matching web copy and validation
- [ ] State-driven gate (no persisted wizard index), tested as a pure function
- [ ] `captureFromResponse` used as the credential source
- [ ] Deep-link params consumed for reset/verify
- [ ] OAuth disabled with a reason
- [ ] Tests green; `typecheck`, `lint` clean for your files
- [ ] Progress file current; final report written

## 7. Reporting
Progress `docs/native/progress/P2-01.md`; final report `docs/native/reports/P2-01.md` with the
gate truth table as implemented, `## Requests for other agents`, `## Known gaps`.
