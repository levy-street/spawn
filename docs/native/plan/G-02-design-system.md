# G-02 — Standardise the component system and the sizing scale

**Wave A, parallel with three other agents.** Read `G-00-CONVENTIONS.md`, then
`research3/18-tabs-and-design-language.md` Part B (the component standardisation spec) and
`research3/17-layout-system.md` §3 and §5.

## 1. What the owner asked for

> "everything is a bit to small all over the place and it doesnt really match the UI on the web app"
> "The whole UI system needs to be standardised end to end, nice components, things like that,
> openAI style but also matching the web app."

## 2. Files you own

```
mobile/src/components/ui/list-row.tsx          # new
mobile/src/components/ui/footer-actions.tsx    # new
mobile/src/components/ui/section-header.tsx    # new
mobile/src/components/ui/button.tsx
mobile/src/components/ui/card.tsx
mobile/src/components/ui/empty-state.tsx
mobile/src/components/ui/badge.tsx
mobile/src/components/ui/chip.tsx
mobile/src/theme/spacing.ts
mobile/src/theme/sizing.ts                     # new: the canonical size scale
```

## 3. Build the standard

`research3/18` Part B defines the canonical anatomy, sizing, spacing and states for every shared
surface. Implement it. It is written to be built to without further interpretation — follow it
rather than reinterpreting.

Ship the two frozen primitives from `G-00`: **`ListRow`** and **`FooterActions`**, plus
`SectionHeader`. Wave B builds its screens out of these, so their APIs must match exactly.

`FooterActions`: one child renders full width; two render **50/50 with the standard gap**, which is
what the owner asked for on the new-workspace screen. Heights, gaps, gutters and bottom-inset
handling per `research3/17 §5`.

## 4. Size up

`research3/17 §3` gives the table: element | web value | native current | **native target**.
Apply every target. The governing rule from `G-00 §Decisions 6`: adopt the web's **proportions**
with phone-appropriate **absolute** sizes, never below 44pt for a touch target. Round 2's
tightening was wrong for a phone — this reverses it deliberately.

Put the canonical numbers in `theme/sizing.ts` and consume them everywhere, so "too small" is a
one-file fix in future rather than a sweep.

## 5. Boundaries
Form controls are unchanged this round unless `research3/17 §3` gives them a new target — if it
does, apply only the size change. Glass/materials are **G-03**. Screens are wave B. Do not touch
`components/ui/{input,select,field,...}` beyond sizing, and do not redesign components
`research2/13` already found at parity.

## 6. Tests
- `ListRow` renders every slot; both heights match `sizing.ts`; press and long-press fire.
- `FooterActions` lays out 1 child full width and 2 children 50/50 with the gap.
- Every exported size is sourced from `sizing.ts` (a test asserting no literal sizes in the
  components you own is acceptable and encouraged).
- Existing component tests still pass.

## 7. Deliverables
- [ ] `ListRow`, `FooterActions`, `SectionHeader` shipped to the frozen APIs
- [ ] `theme/sizing.ts` as the single source of size truth
- [ ] Every `research3/17 §3` target applied
- [ ] `typecheck`, `lint`, `test` clean for your files
- [ ] Progress `docs/native/progress/G-02.md`; report `docs/native/reports/G-02.md` with the final
      size table, since wave B builds to it
