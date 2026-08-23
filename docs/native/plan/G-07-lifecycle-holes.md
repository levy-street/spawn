# G-07 — Close the unwired lifecycle holes

**Wave A, parallel with three other agents.** Read `G-00-CONVENTIONS.md`, then
`research3/19-bugs-and-verification.md` §A, especially its unwired-hook audit.

## 1. Why this exists

Three defects have now shipped in this pattern: a module built correctly, exporting the right
function, that **nothing ever calls**. The auth token had no change notification; the workspace `+`
had no handler; the device identity account was never selected. `research3/19` audited for more and
found three further holes.

Your job is to close them and to leave behind something that makes the pattern visible.

## 2. Files you own

```
mobile/src/data/realtime/**
mobile/src/lib/linking.ts
mobile/src/data/api/auth-token.ts
```

`AuthGate` and the identity binding belong to **G-01** — do not touch `auth-gate.tsx`.

## 3. The holes

From `research3/19 §TL;DR 6`:
1. **Realtime generation registration is unused.** Wire it so socket/RTC generations are registered
   and retired as designed. Without it the retirement logic that prevents stale sockets resurrecting
   dead state never runs.
2. **Pending authenticated deep-link clear is unused.** A stored pending link is never cleared in
   one of its paths, so a stale link can fire later. Wire the clear.
3. **Token expiry deletes silently without notifying subscribers.** `authToken` now notifies on
   `set` and `clear`, but the expiry path deletes the record directly and skips the notification —
   so the gate does not learn the session ended. Route expiry through the same notification.

For each: read the code, confirm the hole is real before changing anything, and say in your report
what the observable symptom was.

## 4. Leave the pattern visible

Add a test that fails when a lifecycle hook goes unwired. A pragmatic version: a test that asserts
each of these specific bindings is registered by the module that owns it. Do not build a generic
reflection framework — three explicit assertions are worth more than a clever one.

## 5. Tests
- Realtime generations are registered on connect and retired on background/interface change.
- A pending deep link is cleared on the documented path and does not fire later.
- Token expiry notifies subscribers exactly once.
- The wiring assertions from §4.

## 6. Deliverables
- [ ] All three holes closed, each with its symptom documented
- [ ] Wiring assertions that fail if they regress
- [ ] `typecheck`, `lint`, `test` clean for your files
- [ ] Progress `docs/native/progress/G-07.md`; report `docs/native/reports/G-07.md`
