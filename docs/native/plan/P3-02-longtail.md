# P3-02 — Long tail: admin, archived, and remaining secondary capabilities

**Phase 3, parallel with five other agents.**

**Read first:** `00-OVERVIEW.md` (§5, §8), then `research/06-feature-inventory.md` (the 121
numbered capabilities — your worklist is everything marked secondary that no Phase 2 agent owns),
and `research/12-auth-and-flows.md §6` for Admin.

## 1. Objective

Close the parity gap left after Phase 2, so `P3-06`'s audit has as little to report as possible.

## 2. Files you own

```
src/app/admin/**
src/components/admin/**
src/app/(tabs)/workspaces/archived.tsx
src/components/longtail/**
src/data/queries/admin.ts
```

## 3. Specification

### 3.1 Method

1. Read `research/06`'s capability table end to end.
2. Cross-reference the Phase 2 reports in `docs/native/reports/` to see what shipped.
3. Build what is left **that belongs to you** — anything not owned by another agent's path.
4. Anything you cannot build, record with its `F-` number and the reason. That list goes to
   `P3-06`.

Do **not** rebuild or "improve" another agent's surface. If a Phase 2 surface is missing a
capability inside its own path, that is a finding for your report, not an edit.

### 3.2 Admin

`research/12 §TL;DR 9`: Admin is operator-only and deferring it is a reasonable, explicit exception
to total parity. **The owner asked for literally everything, so build it** — but build it last,
after the rest of your list, and keep it plain: read-mostly screens, no bespoke design work. If you
run out of room, a stubbed Admin with an honest "available on web" message is a better outcome than
a half-built one; say which you did.

Gate it on `is_admin` from `me`; non-admins must not see the entry point.

### 3.3 Archived workspaces

Archive is a **suspend**, not a delete: session rows and layout are retained and the same sessions
restart on unarchive (`research/03 §Scope`). Build the archived list with restore, and copy that
tells the truth.

### 3.4 Public/about surfaces

Whatever `research/06` lists (download/about material) that makes sense on a phone. Do not port
marketing pages wholesale; a compact About screen with version, links and legal is the right scope.

## 4. Rules
- Path discipline is your main risk — you are working late, next to finished code. Touch only your
  paths.
- Prefer plain, correct screens over polish here; `P3-03` owns polish.

## 5. Tests
- Admin gating: non-admin cannot reach it.
- Archived list + restore.
- A test per non-trivial capability you add.

## 6. Deliverables checklist
- [ ] Gap list derived from `research/06` × Phase 2 reports
- [ ] Archived workspaces with restore and honest copy
- [ ] Admin (or an honest stub, stated as such)
- [ ] About/public surfaces
- [ ] Remaining-gap list with `F-` numbers handed to `P3-06`
- [ ] Tests green; `typecheck`, `lint` clean; progress + report written

## 7. Reporting
Progress `docs/native/progress/P3-02.md`; report `docs/native/reports/P3-02.md` — the gap list is
the most important part.
