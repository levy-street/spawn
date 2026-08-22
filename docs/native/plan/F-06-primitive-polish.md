# F-06 — Non-form primitive and typography parity

**Fix batch, parallel with five other agents.**

**Read first:** `docs/native/research2/13-styling-parity.md` §2, §3 and §5.

## 1. Files you own

```
mobile/src/components/ui/status-dot.tsx
mobile/src/components/ui/toast.tsx
mobile/src/components/ui/popover.tsx
mobile/src/components/ui/collapse.tsx
mobile/src/components/ui/card.tsx
mobile/src/components/ui/chip.tsx
mobile/src/components/ui/text.tsx
mobile/src/theme/typography.ts
```

## 2. What to change

`research2/13 §TL;DR 6` is important: **badge, spinner, skeleton, empty state, sheet, dialog, base
menu, tooltip and most toast geometry are already at or near exact parity and must not be
redesigned.** Only fix what the report identifies as wrong. Restraint is the job here.

The identified defects (`research2/13 §TL;DR 7`):
- **status-dot**: implicit pulsing — make the pulse explicit/controlled, per the report
  (`status-dot.tsx:57-78`), and keep the reduced-motion behaviour.
- **toast**: close-control geometry (`toast.tsx:261-277`).
- **popover**: shadow opacity.
- **collapse**: timing and opacity (`collapse.tsx:23-59`).
- **card**: missing slots relative to the web component.
- **chip**: it is currently a generic alias — give it its real distinct treatment.

**Typography** (`research2/13 §TL;DR 10`): the raw scale and core composites are right, but too few
semantic variants are exposed and the existing sigil roles are never applied. Add the missing
semantic variants to `text.tsx`/`typography.ts` so screens can express the web's roles. Do not
change the underlying scale values — they are verified correct.

**Colour misuse** (`research2/13 §5`): fix every case the report lists where a native component
uses the wrong token for its role (e.g. `border` where web uses `popover-border`). Also fix
hard-coded colours the report found **in files you own**; report the rest.

## 3. Boundaries
Form controls are **F-03**. Brand marks, the monogram and the auth shell are **F-04**. Lists are
**F-05**. Do not touch them.

## 4. Tests
- Each changed component renders in light and dark without regression.
- Status dot pulses only when explicitly enabled, and is static under reduced motion.
- Collapse timing matches the token, not a literal.
- New text variants resolve to the documented scale values.
- No hard-coded colour remains in your files (a lint-style test over the source is acceptable).

## 5. Deliverables
- [ ] Only the identified defects fixed; parity components untouched
- [ ] Typography semantic variants added without changing the scale
- [ ] Token misuse corrected in your files
- [ ] `typecheck`, `lint`, `test` clean for your files
- [ ] Progress `docs/native/progress/F-06.md`; report `docs/native/reports/F-06.md`
