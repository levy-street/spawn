# P4-04 — Production network adapter and one notification preference store

**Phase 4 (defect-fix pass), parallel with four other agents.**

**Read first:** `00-OVERVIEW.md` (§5, §8), `docs/native/plan/P1-08-realtime.md` §3.6, then
`docs/native/reports/P3-06-parity.md` "Top risks" items **9** and **12**.

## 1. The problems

1. **No production reachability source.** `lifecycle.ts` accepts an injected `NetworkSource`, but
   `provider.tsx:62` never supplies a native one. Wi-Fi↔cellular changes may not tear down and
   reopen sockets until some other event happens — exactly the case `P1-08` was told to handle,
   left unplugged.
2. **Two notification preference stores.** The settings panel and the presenter keep separate
   in-memory stores over the same persistence key, so toggling a preference may not affect the
   next alert until restart.

## 2. Files you own

```
mobile/src/data/realtime/provider.tsx
mobile/src/data/realtime/network-source.ts        # new
mobile/src/lib/notifications.ts
mobile/src/components/settings/notifications-panel.tsx
mobile/src/**/__tests__/**  (yours only)
```

## 3. What to build

### 3.1 The network adapter

Implement a real `NetworkSource` from what is installed — check `expo-network` first; do **not**
add a dependency. If nothing installed can report reachability and interface changes, implement the
best available approximation (`AppState` + socket failure signals), and **say so plainly** in your
report rather than shipping something that looks complete and is not.

Wire it in `provider.tsx`. On an interface change, `P1-08`'s contract is a **hard reconnect**, not
a soft retry — the old socket is dead even though it has not noticed.

### 3.2 One preference store

Collapse the two stores into a single source of truth over the existing persistence key. Both the
settings panel and the presenter must read the same live value, so a toggle takes effect on the
next alert with no restart. Do not change the key or the preference schema — the web app shares
these semantics.

## 4. Rules
- No new dependencies. No changes to `P1-08`'s socket internals — you are supplying an adapter it
  already accepts.
- Do not redesign the notifications panel; fix its data source.

## 5. Tests
- Interface change triggers a hard reconnect (mock the source; assert retirement then reconnect).
- Offline → online triggers the resume sweep in the documented order.
- A preference toggled in the panel is observed by the presenter without a restart.
- Persistence round-trips under the existing key with the existing schema.

## 6. Deliverables
- [ ] Production `NetworkSource` wired, or an honest statement of what is achievable
- [ ] Single notification preference store, no restart required
- [ ] Tests green; typecheck + lint clean for your files
- [ ] Progress `docs/native/progress/P4-04.md`; report `docs/native/reports/P4-04.md`
