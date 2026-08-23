# G-05 — Workspace tabs: define, close, drag-reorder; and the dead controls

**Wave B, parallel with two other agents.** Read `G-00-CONVENTIONS.md`, wave A's reports
(`G-01.md`, `G-02.md`), then `research3/18-tabs-and-design-language.md` **Part A** — it is your
specification, with the web treatment and the native target for every property. Also
`research3/19-bugs-and-verification.md` §B.

## 1. What the owner reported

> "the tabs here are okay but not great, we need the same stuff as web, they should be more
> defined, i should be able to X them, i should be able to hold then drag to rearange them."

> "the add button is weird, it should be a full width button and the list items should also be
> taller"

> "the + button here still does nothing, same with the ..."

## 2. Files you own

```
mobile/src/components/workspace-detail/**
mobile/src/data/queries/workspace-detail.ts
mobile/src/components/launcher/**
```

## 3. Tabs

`research3/18` Part A documents the web treatment (height, padding, radius, border, background,
type, and the indicator that makes tabs "defined") and the native target for each. Implement it.

Add the two missing interactions — `research3/19 §TL;DR 8` confirms neither exists today:
- **Close (X)**: per the web rules for when it shows, its size and hit area (≥44pt effective), and
  what happens to a tab containing live sessions. Follow the web's confirm/kill/move semantics
  exactly; do not invent a policy.
- **Long-press then drag to reorder**: `react-native-gesture-handler` + Reanimated, both installed.
  `research3/18` specifies the interaction model, the haptics, edge auto-scroll and the drop
  indicator. Persist through the existing whole-envelope `PATCH`; reorder is geometry-rewriting on
  a phone (`research/07 §TL;DR 8`) — reuse `applyMobileOrder`, do not write new ordering maths.

Respect the **8-tab ceiling** with a disabled add control rather than a failing mutation.

## 4. The dead controls

`research3/19 §TL;DR 7`: in current source `+` opens the launcher **unless pane placement is full**,
and `...` opens workspace actions. The owner experienced both as inert.

So the defect is most likely **silent failure**, not a missing handler. Fix it as a feedback
problem:
- when `+` cannot place a pane, say so — a disabled control with a reason, or a toast naming the
  16-tile ceiling. Never a tap that does nothing.
- audit **every** interactive control in your paths per `research3/19 §B` and make each one either
  work, or visibly explain why it cannot. Include the table in your report.
- if either control is genuinely unwired, wire it.

## 5. Rows and the add button

- Pane/terminal rows rebuild on **`ListRow`** at `tall`.
- The add control becomes a **full-width button** below the list, per the owner.
- Adopt the **`Screen`** scaffold; remove local inset handling.

## 6. Tests
- Tab close: shows per the web rule, confirms for a tab with live sessions, and removes on confirm.
- Long-press drag reorder: the reorder decision and resulting order are pure-testable — test the
  ordering function exhaustively; assert `applyMobileOrder` is used.
- 8-tab ceiling disables the add control.
- Every control has a handler, and a blocked `+` surfaces a reason (assert the toast/disabled state).
- Rows use `ListRow` at `tall`.

## 7. Deliverables
- [ ] Tabs match the web treatment and are visibly defined
- [ ] Close (X) with the web's live-session semantics
- [ ] Long-press drag reorder persisted via `applyMobileOrder`
- [ ] Full-width add button; taller rows via `ListRow`
- [ ] No control fails silently; audit table in the report
- [ ] `typecheck`, `lint`, `test` clean for your files
- [ ] Progress `docs/native/progress/G-05.md`; report `docs/native/reports/G-05.md`
