# F-03 — Form control styling parity

**Fix batch, parallel with five other agents.**

**Read first:** `docs/native/research2/13-styling-parity.md` — §1 is your specification, with
web → native-current → native-target values per control.

## 1. What the owner asked for

> "for inputs: inputs need to be taller and bigger, they should match web app input styling"

## 2. Files you own

```
mobile/src/components/ui/input.tsx
mobile/src/components/ui/textarea.tsx
mobile/src/components/ui/select.tsx
mobile/src/components/ui/search-field.tsx
mobile/src/components/ui/field.tsx
mobile/src/components/ui/switch.tsx
mobile/src/components/ui/label.tsx
mobile/src/components/ui/segmented-control.tsx
```

## 3. What to change

From `research2/13`:

- **Height.** Native shows a **40pt** box while its embedded actions are already 44pt. Make the
  visible control **44pt**, keep **14/20** type, and add a **separate 1pt focus halo** rather than
  thickening the border on focus (which shifts layout). `input.tsx:257-315`, `select.tsx:183-204`.
- **`Field` reserves a blank 16pt helper line plus an 8pt gap — a 24pt void on every field.**
  Remove it; render help and error copy only when present. Make the appearance non-shifting by
  animating in rather than reserving space. `field.tsx:35-84`.
- Apply every other web→target delta `research2/13 §1` lists for these files: padding, radius,
  border colour per state, placeholder colour, disabled treatment, error treatment.
- Keep the `purpose`-driven keyboard/autofill configuration exactly as it is — that behaviour is
  correct and must not regress.

Everything from `@/theme` tokens. No hard-coded colours or magic numbers.

## 4. Boundaries

Non-form primitives (button, card, badge, status dot, toast, popover, collapse, text) belong to
**F-06**. Brand marks and the auth shell belong to **F-04**. Do not touch them.

## 5. Tests

- Rendered height of `Input`, `Select`, `SearchField` is the target value.
- Focus adds the halo without changing layout height (assert style, not a snapshot).
- `Field` renders no helper row when there is no help or error, and no layout shift when an error
  appears.
- Existing form tests still pass — especially the `purpose` matrix.

## 6. Deliverables
- [ ] 44pt controls with 14/20 type and a separate focus halo
- [ ] `Field`'s 24pt void removed without introducing layout shift
- [ ] Every `research2/13 §1` delta applied
- [ ] `typecheck`, `lint`, `test` clean for your files
- [ ] Progress `docs/native/progress/F-03.md`; report `docs/native/reports/F-03.md`
