# G-01 — Remove the menu, standardise the screen scaffold, bind the account

**Wave A, parallel with three other agents.** Read `G-00-CONVENTIONS.md` first, then
`research3/17-layout-system.md` §1-2 and `research3/19-bugs-and-verification.md` §A.

## 1. Files you own

```
mobile/src/app/**                          # the whole route tree
mobile/src/components/layout/**            # new: Screen scaffold
mobile/src/components/nav/**               # delete drawer content
mobile/src/lib/auth-gate.tsx
mobile/package.json                        # ONLY to remove @react-navigation/drawer
```

## 2. Remove the menu entirely

The owner: *"we dont need a burger menu, we dont need a menu at all."*

Delete the drawer navigator and its content. Replace with a plain native stack per
`G-00 §Decisions 1`: **Workspaces is the root**. Hosts, Legion, Settings and Admin are reached from
the Workspaces header (and from one another) with native back buttons. Keep every URL stable —
route groups are URL-invisible, so `/workspaces`, `/hosts`, `/settings/*`, `/legion`, `/admin/*`
must all still resolve. Extend the linking tests.

Remove `@react-navigation/drawer` from `package.json` (do not run npm install; the orchestrator
will reconcile the lockfile).

Use the **native-stack header** with its automatic back button rather than custom headers wherever
the screen is an ordinary title/back shape (`G-00 §Decisions 2`).

## 3. Fix the top gap — the whole class, not the instances

`research3/17 §1` identifies where the safe-area inset is applied twice. Fix the double-count, then
prevent recurrence: ship **one `Screen` scaffold** (`G-00` frozen API) that every screen uses, with
exactly one layer owning the top inset. Document in your report which layer that is, so no future
agent re-adds it.

`Screen` must handle: safe areas, the standard gutter, keyboard-aware scrolling, and a pinned
`footer` that tracks the keyboard (`research3/17 §4`) and respects the bottom inset. The footer
renders `G-02`'s `FooterActions` — code against the frozen API.

Convert every screen listed in `research3/17 §6` to the scaffold. If a screen belongs to another
agent's path, convert only its **wrapper**, changing nothing about its content, and list every file
you touched in your report.

## 4. Enable dismissal gestures everywhere

`research3/19 §C`: default stack pages still use edge-only gestures. Set the native-stack options so
**full-screen** back gestures are enabled for pushed screens app-wide, and say which options you
used. The terminal overlay is `G-06`'s.

## 5. Bind the device identity account — this unblocks every terminal

`research3/19 §A`: `deviceIdentity` throws `IDENTITY_ABSENT` because nothing selects the account.

Per §TL;DR 3, **`AuthGate` owns the binding**:
- select from **`me.user.id`** — the canonical account UUID, not email or device id (§TL;DR 4);
- block protected runtime until the binding is ready, so nothing can attempt to sign before it;
- **clear** the binding on logout, on 401, on server change, and on an A→B account change — there
  are currently zero `clearDeviceIdentityAccount()` calls;
- on account switch, clear the in-memory selection and select B. **Do not destroy A's identity** on
  ordinary logout or switch; `deviceIdentity.reset()` and `onDeviceIdentityReset` are reserved for
  revoke/delete/fresh-start (§TL;DR 5).

## 6. Tests
- Route map: every documented URL resolves; no drawer route remains.
- The gate binds the account from `me.user.id` once ready, and clears it on logout/401.
- Signing is impossible before binding (assert the ordering).
- `Screen` applies the top inset exactly once (assert against a mocked inset).
- Footer tracks the keyboard (assert the offset responds to keyboard height).

## 7. Deliverables
- [ ] Drawer and all menu UI removed; stack-only navigation with native headers
- [ ] URLs stable; linking tests extended
- [ ] `Screen` scaffold shipped and adopted; top inset applied once
- [ ] Full-screen back gestures enabled app-wide
- [ ] Account binding in `AuthGate`, with clearing on every documented transition
- [ ] `typecheck`, `lint`, `test` clean for your files
- [ ] Progress `docs/native/progress/G-01.md`; report `docs/native/reports/G-01.md`
