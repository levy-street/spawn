# P2-04 — Workspace detail: the tab pager and the terminal list

**Phase 2, parallel with nine other agents. This is the screen the owner described most
specifically — build it exactly.**

**Read first:** `00-OVERVIEW.md` (§1 core journey, §5, §8), then `research/07-workspace-model.md`
**in full** (hierarchy, layout algebra, statuses, agent identity, capacity), then
`research/06-feature-inventory.md §TL;DR 4` for the intended IA.

## 1. Objective

> "In a workspace I should see a list of tabs, each tab should have a list of terminals that are
> running along with their type, name, logo, status, etc… I should be able to drag swipe between
> tabs."

Build that.

## 2. Files you own

```
src/app/workspace/[id].tsx
src/components/workspace-detail/**
src/data/queries/workspace-detail.ts
```

The terminal **overlay** is `P2-05`. You own the list and the row; tapping a row navigates to
their route.

## 3. Specification

### 3.1 Structure

- Header: workspace name, icon, and an actions menu.
- A **tab strip** listing the workspace's tabs, horizontally scrollable, showing the active tab.
- A **horizontal pager** (`P1-04`'s `TabPager`) whose pages are tabs.
- Each page: a **vertical list of that tab's children** in `P1-07`'s `readingOrder`.

The tab strip's indicator must move **continuously with the pager drag**, not jump on settle —
`TabPager` exposes drag progress for exactly this. Tapping a strip item animates the pager. A
committed page change fires `haptics.selection()` once (the pager does this; do not double-fire).

### 3.2 The terminal row — the product's signature element

Each row shows, per `research/07 §TL;DR 3`:
- **Logo/type**: from `P1-07`'s `identifyAgent(foreground_command, agents)` — derived from the
  daemon-reported foreground command, **not** from the agent that launched it. Unknown kinds fall
  back to `P1-01`'s `Monogram`.
- **Name**: `session.name`.
- **Status**: `P1-01`'s `StatusDot` plus a label, from `P1-07`'s `displayStatus`, which composes
  five independent dimensions (process, activity, host presence, transport, alerts). **Never
  collapse them into one field yourself.**
- Secondary line: cwd or host, as the web row shows.
- Attention ordering uses `attentionRank` — dead process outranks waiting.

A tab's children may also be **file-browser widgets**, not just sessions (`research/07 §TL;DR 1`).
Render those rows too, routing to `P2-07`'s file surface.

### 3.3 Actions

- Tap a terminal row → navigate to `P2-05`'s terminal route.
- Swipe (via `P1-04`'s `SwipeableRow`) and long-press menu: rename, move to another tab, duplicate,
  close/kill, restart. Destructive through `Confirm`.
- **Reorder** within a tab. Read `research/07 §TL;DR 8` carefully: there is no independent
  list-order field, so reordering **rewrites desktop geometry**. Use `P1-07`'s
  `applyMobileOrder` — do not invent your own mapping, and tell the user nothing about geometry;
  it should just work.
- Tab management: create, rename, reorder, delete tabs. Ceilings are **8 tabs / 16 tiles per tab**
  — use `P1-07`'s `can*` predicates to disable controls rather than letting a mutation fail.
- New session entry point: present `P2-10`'s launcher. Do not build the launcher.

### 3.4 Mutations

Every tab/pane change is a **whole-envelope `PATCH /api/workspaces/{id}` with no revision field**
(`research/07 §TL;DR 2`). Build the new envelope with `P1-07`'s pure algebra, send it whole, and
invalidate both workspace keys. Debounce rapid reorders into one PATCH — the web app debounces at
500ms (`research/02 §6`); match it. Roll back to the last server value on failure.

## 4. Rules specific to you

- Use `FlashList` for the per-tab lists; keep rows cheap (memoised, no per-row subscriptions to
  large stores).
- Do not open transports here. The list shows status from server + `P1-08`'s connection store; only
  `P2-05` opens a session transport.
- Do not build a grid. The phone is a reading-order list (`research/07 §TL;DR 7`).

## 5. Tests

- Row renders type/name/logo/status correctly for: each built-in agent, a custom agent, an unknown
  command, a null command.
- `displayStatus` composition is rendered, not recomputed (assert selector usage via mocks).
- Reorder calls `applyMobileOrder` and PATCHes the whole envelope; payloads preserved.
- Debounce coalesces rapid reorders into one PATCH (fake timers).
- Ceiling predicates disable the add-tab control at 8 and add-pane at 16.
- Pager page change fires exactly one selection haptic.
- File-widget rows render and route.

## 6. Deliverables checklist
- [ ] Tab strip with continuous drag-linked indicator
- [ ] `TabPager` between tabs with lazy page rendering
- [ ] Terminal rows with type/name/logo/status from `P1-07` selectors
- [ ] File-widget rows
- [ ] Swipe/long-press actions, reorder via `applyMobileOrder`, tab CRUD with ceilings
- [ ] Whole-envelope PATCH with 500ms debounce and rollback
- [ ] Tests green; `typecheck`, `lint` clean; progress + report written

## 7. Reporting
Progress `docs/native/progress/P2-04.md`; report `docs/native/reports/P2-04.md`.
