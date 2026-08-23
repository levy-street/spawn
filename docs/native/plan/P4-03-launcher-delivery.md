# P4-03 — Deliver the pending agent command

**Phase 4 (defect-fix pass), parallel with four other agents.**

**Read first:** `00-OVERVIEW.md` (§5, §7.4, §8), `docs/native/plan/P2-10-launcher.md` §3.3, then
`docs/native/reports/P3-06-parity.md` "Top risks" item **7**.

## 1. The problem

> "The launcher stores the command and creates a shell, but `deliverPendingLaunch` is only
> defined/tested (`mobile/src/data/queries/launcher.ts:118`). The first 'launch Claude/Codex'
> attempt is likely to open an ordinary shell."

Agent launch is deliberately two-stage (`research/07 §TL;DR 10`): create a login-shell session,
then **type the constructed command into its live terminal**. Stage one ships; stage two has no
production consumer. So launching Claude Code gives you a bare shell — the headline "run an agent"
feature silently does nothing.

## 2. Files you own

```
mobile/src/data/queries/launcher.ts
mobile/src/components/launcher/**
mobile/src/**/__tests__/**  (yours only)
```

You may add **one** small integration point in the terminal screen if there is genuinely no other
way to observe readiness — but prefer wiring it through the transport's existing `state` events so
you do not touch `P2-05`'s files. If you must, change only what is required and record it
line by line in your report.

## 3. What to build

Wire delivery into the real path:

1. After the session is created, the pending command is persisted (already implemented).
2. When that session's transport reaches **`ready`** — the five-way readiness gate in
   `00-OVERVIEW.md §7.4`, *not* merely "channel open" — write the command bytes followed by a
   newline.
3. Clear the pending record on delivery. Deliver **exactly once**: a reconnect must not retype the
   command into a live shell. Guard with the stored session id plus a delivered flag.
4. If the session dies before ready, or the record is older than a sane staleness bound, abandon it
   and surface an honest state rather than typing a command into an unrelated shell.

**Correctness bar:** typing a command twice into someone's shell is worse than not typing it. When
in doubt, do not deliver, and say so in the UI.

## 4. Rules
- Bytes go through `SessionTransport.write()`; do not touch the WebView or the worker.
- Do not redesign the launcher UI. This is delivery wiring.

## 5. Tests
- Delivery fires exactly once on `ready`, never on intermediate states.
- Reconnect after delivery does not resend.
- Session dies before ready → abandoned, no write, honest state.
- Stale record → abandoned.
- App restart mid-flight → the persisted record still delivers exactly once.
- Command bytes match the constructed command plus newline (reuse the existing construction tests).

## 6. Deliverables
- [ ] Pending command delivered on transport `ready`, exactly once
- [ ] Abandonment paths for death, staleness and restart
- [ ] Tests green; typecheck + lint clean for your files
- [ ] Progress `docs/native/progress/P4-03.md`; report `docs/native/reports/P4-03.md`, listing any
      line touched outside your paths
