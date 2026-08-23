# P2-03 — Workspaces root: list, create, rename, archive, templates, icons

**Phase 2, parallel with nine other agents.**

**Read first:** `00-OVERVIEW.md` (§5, §7.6, §8), then `research/07-workspace-model.md` (entity
reference, lifecycle flows, icons, templates), `research/06-feature-inventory.md` for the
capability list, and `research/02-web-architecture.md §3` for query/invalidation conventions.

## 1. Objective

The first screen a signed-in user sees: their workspaces, and everything they can do to a
workspace from the list.

## 2. Files you own

```
src/app/(tabs)/workspaces/index.tsx
src/app/(tabs)/workspaces/_layout.tsx
src/components/workspaces/**
src/data/queries/workspaces.ts
```

Workspace **detail** is `P2-04`. You own the list and workspace-level CRUD; they own what's inside.

## 3. Specification

- List every workspace with its icon, name, and a **rollup** of what's inside: tab count, running
  terminal count, and an attention indicator. Use `P1-07`'s selectors — do not recompute rollups.
- Sort/group as the web app does (`research/07 §7`).
- `FlashList` for the list. Pull-to-refresh. Skeletons on first load, `EmptyState` when there are
  none.
- Row actions via `P1-04`'s `SwipeableRow` and a long-press menu (`P1-02`'s `Menu`): rename,
  change icon, duplicate, archive/unarchive, delete. Destructive actions go through `Confirm`.
- **Create**: name + icon + optional template. Templates come from the templates endpoint;
  instantiation semantics are in `research/07 §4`.
- **Icons**: the web app has a workspace-icon system including auto-fill and image scanning
  (`workspace-icon*.ts`). Port the **picker and the stored value format** faithfully so desktop and
  phone agree. If the auto-fill/scan behaviour needs capabilities the phone lacks, ship the manual
  picker and record the gap — do not invent a different icon format.
- **Archive**: `research/03 §Scope` notes archive now *retains* session rows and layout and
  restarts the same sessions on unarchive. Reflect that in the copy — it is a suspend, not a
  delete. Archived workspaces are listed separately (`P3-02` owns the archived screen; you own the
  entry point to it).
- Mutations follow the web's write-both convention: on success write both `qk.workspace(id)` and
  `qk.workspaces()` (`research/02 §5`), using `P1-07`'s helpers.

## 4. Rules specific to you

- No layout/tab algebra here — that is `P1-07`'s and `P2-04`'s.
- Haptics per the `P1-04` vocabulary: selection on row open, warning on destructive commit,
  success/error on mutation results.
- Optimistic updates only where the web app does them; otherwise invalidate and let the refetch
  settle.

## 5. Tests

- Query hooks call the right endpoints and invalidate the right keys (mock the API layer).
- Rollup rendering from selector output.
- Create/rename/archive mutation wiring, including the write-both invalidation.
- Row action menu shows the right items for archived vs active.
- Empty and error states render.

## 6. Deliverables checklist
- [ ] List with icons, rollups and attention indicators from `P1-07` selectors
- [ ] Create with name/icon/template; rename; duplicate; archive/unarchive; delete
- [ ] Swipe + long-press actions with confirmations
- [ ] Icon picker preserving the web's stored format
- [ ] Archive copy reflecting suspend semantics
- [ ] Tests green; `typecheck`, `lint` clean; progress + report written

## 7. Reporting
Progress `docs/native/progress/P2-03.md`; report `docs/native/reports/P2-03.md`.
