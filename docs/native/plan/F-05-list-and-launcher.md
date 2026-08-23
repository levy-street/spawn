# F-05 — List stability, list rhythm, and the dead `+` button

**Fix batch, parallel with five other agents.**

**Read first:** `docs/native/research2/14-navigation-and-behaviour.md` §4 (the diagnosed scroll
bug) and `docs/native/research2/13-styling-parity.md` §4 (list rhythm).

## 1. What the owner reported

> "inside a workspace the + button does nothing"

> "on the workspace list page it keeps reloading, it should reload for updates but it shouldnt
> effect the UI (currently it scrolls the list down then back up"

## 2. Files you own

```
mobile/src/components/workspaces/**
mobile/src/components/workspace-detail/**      # EXCEPT agent-icon.tsx (F-04 owns it)
mobile/src/data/queries/workspaces.ts
mobile/src/data/queries/workspace-detail.ts
mobile/src/data/queries/launcher.ts
mobile/src/components/launcher/**
```

## 3. Fix 1 — the scroll jump

**It is not a remount.** `research2/14 §TL;DR 10`: the five-second session poll sets
`sessionsQuery.isRefetching`, which is wired to **FlashList's visible `refreshing` prop**, so iOS
renders the pull-to-refresh control and moves content down and back on every poll.

Fix it properly: `refreshing` must reflect **only a user-initiated pull**, never a background
poll. Keep the poll; make it invisible. Verify no other list in your files has the same wiring —
grep for `refreshing` across the tree and report any you find outside your paths rather than
editing them.

## 4. Fix 2 — the `+` button

`onAddPane` is threaded through `workspace-header.tsx:65`, `pane-list.tsx:111,123` and
`tab-strip.tsx:120`, but **nothing supplies a handler** — the launcher `P2-10` built is never
presented. Wire it: `+` opens the launcher flow (host → folder → agent → name), and on success the
new session appears in the current tab.

Check the sibling controls in `action-sheets.tsx:260` (`onAddTab`) and confirm every action in the
workspace screen actually reaches an implementation. Report any others that are dead.

## 5. Fix 3 — list rhythm

`research2/13 §TL;DR 9`: native rows are much looser than web — **72pt rows, 44pt avatars, 16pt
gutters, 24/32 headings** versus web's **40px rows, 24px marks, 10px sidebar gutters**. Tighten
toward the web's rhythm, but keep tap targets ≥44pt: the *row* can be denser while the touch target
stays adequate. Use the target values in `research2/13 §4`; where it gives a range, prefer the
denser end and say what you chose.

## 6. Tests
- `refreshing` is true only for a user pull, false during a background refetch (assert the prop
  against query state).
- Scroll offset is preserved across a refetch (assert the list is not remounted: stable keys,
  stable `data` identity).
- `+` invokes the launcher; a successful launch adds a session to the active tab.
- Every action exposed by the workspace screen has a handler (a test that walks the props).
- Row heights match the new spec.

## 7. Deliverables
- [ ] Background polling no longer moves the list
- [ ] `+` opens the launcher and creates a session
- [ ] No other dead actions in the workspace screen
- [ ] List rhythm tightened to the web-derived targets, targets still ≥44pt
- [ ] `typecheck`, `lint`, `test` clean for your files
- [ ] Progress `docs/native/progress/F-05.md`; report `docs/native/reports/F-05.md`
