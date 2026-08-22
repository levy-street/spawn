# P4-02 — Shell wiring: mount the confirm host, fix dead-end routes

**Phase 4 (defect-fix pass), parallel with four other agents.**

**Read first:** `00-OVERVIEW.md` (§5, §8), then `docs/native/reports/P3-06-parity.md` "Top risks"
items **3, 5, 6** and rows **F-006, F-014, F-019, F-020**.

## 1. The problems

Three defects, all "built but not connected":

1. **`ConfirmHost` is never mounted.** `confirm()` returns a Promise serviced only by that host
   (`mobile/src/components/ui/confirm.tsx:48`), and the provider tree never renders it. Every
   destructive action that awaits `confirm()` — archive-with-live-sessions, workspace delete,
   permanent delete — **hangs forever after the first press**. The UI looks broken.
2. **Every Connect Host button targets a missing route.** Controls push `/(onboarding)/host`, but
   only `/(onboarding)/device` exists (`host-list-screen.tsx:102`). Adding a second host is
   impossible.
3. **Skip Host is a dead end.** Onboarding persists the skip flag and shows completion, but
   `auth-gate.tsx:31` ignores it and routes every zero-host account back to onboarding. The user
   cannot reach Workspaces after taking an action the app offered them.

## 2. Files you own

```
mobile/src/app/_layout.tsx
mobile/src/lib/providers.tsx
mobile/src/lib/auth-gate.tsx
mobile/src/app/(onboarding)/**
mobile/src/components/hosts/host-list-screen.tsx     # link target only
mobile/src/components/settings/hosts-panel.tsx       # link target only
mobile/src/**/__tests__/**  (yours only)
```

For the two link-target files: change **only** the route string and anything strictly required to
make it correct. They belong to other agents; do not refactor or restyle them.

## 3. What to build

### 3.1 Mount the confirm host

Render `ConfirmHost` once in the provider tree, above the router so any screen can await it, and
below the theme so it is themed. Verify by test that a `confirm()` call resolves `true` on
accept and `false` on dismiss, and that a second `confirm()` while one is pending resolves the
first as `false` (that behaviour already exists in `confirm.tsx` — assert it, don't change it).

Audit the tree for any other declared-but-unmounted host (toast, sheet, action sheet, keyboard
provider) and mount whatever is missing. Enumerate every overlay host and its mount status in your
report — this class of defect is invisible until someone taps.

### 3.2 Fix the pairing route

Decide, and say which you chose: either add `(onboarding)/host.tsx` presenting `P2-02`'s pairing
ceremony standalone (outside first-run onboarding), or repoint the links at `device`. Adding the
route is better if the ceremony assumes first-run context — a returning user adding a second host
should not see "welcome" framing.

Whichever you pick, adding a host from **Hosts** and from **Settings → Hosts** must work.

### 3.3 Honour Skip Host

`auth-gate.tsx` must read the persisted skip flag. Zero hosts **plus** skip set → allow through to
Workspaces. Zero hosts and no skip → onboarding. The user must be able to get back to pairing
later (they can, via §3.2).

Keep the gate's decision a **pure function** as `P2-01` built it, and extend its truth table test
with the skip cases.

## 4. Rules
- Wiring only. No new features, no redesign, no refactoring of other agents' components.
- Provider order matters — document any change in your report.

## 5. Tests
- `confirm()` resolves true/false through the mounted host; a superseding call resolves the first false.
- Every overlay host is mounted (assert presence in the rendered tree).
- Gate truth table extended for skip: zero hosts + skip → workspaces; zero hosts, no skip → onboarding.
- Connect Host link targets resolve to a route that exists.

## 6. Deliverables
- [ ] `ConfirmHost` and every other overlay host mounted
- [ ] Pairing reachable from Hosts and Settings
- [ ] Skip Host no longer a dead end
- [ ] Tests green; typecheck + lint clean for your files
- [ ] Progress `docs/native/progress/P4-02.md`; report `docs/native/reports/P4-02.md` with the
      overlay-host mount table and the provider order as shipped
