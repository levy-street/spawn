# G-04 — Workspace list and the new-workspace form

**Wave B, parallel with two other agents.** Wave A shipped the primitives — read
`G-00-CONVENTIONS.md` for their frozen APIs, then `docs/native/reports/G-01.md` and
`docs/native/reports/G-02.md` for what was actually built (the `Screen` scaffold, `ListRow`,
`FooterActions`, `theme/sizing.ts`). Then `research3/17-layout-system.md` §3 and §5.

## 1. What the owner reported

> "For the workspace list items here they should be way taller, they are very small right now and
> can take more space."

> "on the new workspace UI we should make the cancel and create workspace buttons both 50% width so
> together they take up 100% (with a gap between them), they should also stick above the keyboard."

## 2. Files you own

```
mobile/src/components/workspaces/**
mobile/src/data/queries/workspaces.ts
```

## 3. What to change

- Rebuild the list rows on **`ListRow`** with the `tall` height. Do not hand-roll row layout or
  re-declare sizes — everything comes from `theme/sizing.ts`. If a size is missing there, request
  it in your report rather than adding a literal.
- Adopt the **`Screen`** scaffold. Remove any local safe-area/padding handling — exactly one layer
  owns the top inset now, and it is not yours. This is the fix for the top gap on these screens.
- New-workspace form: adopt `Screen` with a `footer` of **`FooterActions`** containing exactly two
  children (Cancel, Create workspace) so they render **50/50 with the standard gap**, pinned and
  tracking the keyboard. That is precisely what the owner asked for; `FooterActions` already
  implements the geometry.
- Keep every existing behaviour: search, refresh, swipe actions, long-press menu, create/rename/
  duplicate/archive/delete, icon picker, templates. This is a re-composition, not a rewrite.
- The background poll must still not disturb scroll (fixed in round 2 — `refreshing` reflects only
  a user pull). Do not regress it; assert it in a test.

## 4. Tests
- Rows use `ListRow` at `tall`, and the rendered height matches `sizing.ts`.
- The form's footer renders two children 50/50 with the gap, and tracks the keyboard.
- No screen in your paths applies its own top safe-area inset.
- `refreshing` is false during a background refetch.
- Existing workspace tests still pass.

## 5. Deliverables
- [ ] List rebuilt on `ListRow`/`Screen`, visibly taller, sizes from `sizing.ts`
- [ ] 50/50 keyboard-tracking footer on the new-workspace form
- [ ] No local inset handling remains
- [ ] `typecheck`, `lint`, `test` clean for your files
- [ ] Progress `docs/native/progress/G-04.md`; report `docs/native/reports/G-04.md`
