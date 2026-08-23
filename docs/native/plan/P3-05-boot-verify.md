# P3-05 — Boot verification and the Expo Go runbook

**Phase 3, parallel with five other agents.** You are the agent that proves the campaign's
headline promise: **the app boots and can be installed on a phone via Expo Go.**

## 1. Objective

Prove — as far as is possible without a device — that the bundle builds, resolves and boots, and
write the runbook the owner follows to get it on their iPhone.

## 2. Files you own

```
mobile/docs/**
mobile/README.md
```

Plus the right to make **minimal** fixes anywhere that block the bundle from building. Bundle-
blocking fixes only; record every one.

## 3. Specification

### 3.1 Verification you can actually do

Run and record:
```bash
cd mobile
npx expo export --platform ios          # must succeed, no unresolved modules
npx expo-doctor                         # record output; no version incompatibilities
npm run typecheck && npm run lint && npm test
```

Then verify statically, because you may not run the app:
- Every import resolves (the export step proves this).
- No module imported at app start touches a native API unavailable in Expo Go. Walk the import
  graph from `src/app/_layout.tsx` and check every dependency against the Expo Go 54 bundled module
  list (`research/08 §1`). **This is the single highest-value check you perform** — a non-Expo-Go
  module anywhere in the startup path means a white screen on the owner's phone, with a stack trace
  that will not obviously say why.
- `app.json` is coherent: scheme, bundle id, orientation, `newArchEnabled`, splash/icon paths all
  point at files that exist.
- Assets referenced by the theme, worker and screens exist at the referenced paths.
- The terminal worker asset is present, self-contained, and references nothing remote
  (grep it for `http://`, `https://`, `//cdn` — the only allowed absolute URL is the
  `baseUrl` sentinel from `P1-09`'s secure-context strategy).

### 3.2 The runbook

`mobile/README.md`, written for the owner, covering:
- prerequisites (Node version, `npx expo`, phone and Mac on the same network);
- `npm install`, then `npx expo start --lan`, and `--tunnel` when the LAN path fails;
- scanning the QR with the Camera app / Expo Go, and which Expo Go version is required (**54**);
- pointing the app at their server (`P1-05`'s base-URL override) — how, exactly;
- signing in, and what the first-run flow will ask for;
- **what to check first**: the terminal secure-context probe from `P1-09` (`00-OVERVIEW.md §3 D3`,
  risk R-1), because that is the one thing that cannot be proven off-device;
- known limitations from `00-OVERVIEW.md §3 D8` (no passkeys, no remote push, no OAuth login);
- troubleshooting: SDK mismatch, cache clearing (`--clear`), Metro on a different LAN, firewall.

Also write `mobile/docs/architecture.md`: a short orientation to the module layout, the transport
architecture diagram from `00-OVERVIEW.md §3 D3`, and where to look when something breaks.

## 4. Rules
- Do not run `expo start` and do not attempt to open the app.
- Bundle-blocking fixes only. Everything else is a finding.

## 5. Deliverables checklist
- [ ] `expo export --platform ios` succeeds, output recorded
- [ ] `expo-doctor` clean of version incompatibilities
- [ ] Startup import graph audited against the Expo Go 54 module list
- [ ] Worker asset confirmed self-contained
- [ ] `mobile/README.md` runbook the owner can follow start to finish
- [ ] `mobile/docs/architecture.md`
- [ ] Progress current; report written

## 6. Reporting
Progress `docs/native/progress/P3-05.md`; report `docs/native/reports/P3-05.md` with all command
output, the import-graph audit result, and every fix you made.
