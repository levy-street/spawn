# P1-03 — UI forms: inputs, controls and field composition

**Phase 1, parallel with eight other agents.**

**Read first:** `00-OVERVIEW.md` (§5, §7.1, §7.2, §8), then `research/01-design-system.md` for the
visual spec of `input`, `textarea`, `switch`, `label`; then `research/12-auth-and-flows.md` for the
real validation rules and the **exact error copy** used across the app's forms.

---

## 1. Objective

Implement the form primitives and the field-composition layer that every auth screen, settings
panel, rename dialog and picker in the app will use.

## 2. Files you own

```
src/components/ui/input.tsx
src/components/ui/textarea.tsx
src/components/ui/switch.tsx
src/components/ui/label.tsx
src/components/ui/field.tsx             # label + control + hint + error composition
src/components/ui/search-field.tsx
src/components/ui/segmented-control.tsx
src/components/ui/select.tsx
src/lib/validation.ts                   # shared validators + error copy
src/components/ui/__tests__/**
src/lib/__tests__/validation.test.ts
```

Atoms belong to `P1-01`, overlays to `P1-02`. Import them; do not create them. `Select` presents
its options through `P1-02`'s `ActionSheet`/`Sheet` — code against
`00-OVERVIEW.md` and `P1-02`'s plan for those signatures; if the file does not exist yet, that is
expected mid-phase.

## 3. Specifications

### `Input`
Single-line text field matching the web `input.tsx` spec: height, padding, radius, border, focus
ring (the web app's `ring` token resolves to `foreground` — check `research/01`), placeholder
colour, disabled and error states.

Mobile-specific requirements that matter more than the visual spec:
- `autoCapitalize`, `autoCorrect`, `spellCheck`, `keyboardType`, `textContentType` and
  `autoComplete` must be settable and must have **correct defaults per semantic type**. Expose a
  `purpose` prop (`'email' | 'password' | 'newPassword' | 'oneTimeCode' | 'url' | 'path' |
  'name' | 'search' | 'plain'`) that sets all of them coherently — this is where mobile forms are
  usually wrong, and getting it right is most of this component's value.
- `path` and `plain` purposes must disable autocapitalise, autocorrect and smart punctuation.
- Password fields: secure entry with a reveal toggle, and `textContentType` set so iOS offers
  Keychain autofill and Strong Password.
- One-time-code fields: `textContentType="oneTimeCode"` so SMS/email codes autofill.
- `returnKeyType` and `onSubmitEditing` support so multi-field forms advance correctly; expose a
  `nextRef` convention or accept a ref to focus next.
- Focus/blur animate the border/ring with the standard 150ms transition.

### `Textarea`
Multi-line variant. Auto-grows between a min and max height, then scrolls. Same purpose-driven
input configuration.

### `Switch`
Match the web switch's dimensions, colours and thumb travel. Animate with Reanimated.
`haptics.selection()` on toggle. `accessibilityRole="switch"` with `checked` state.

### `Label` and `Field`
`Field` is the composition primitive: label, required marker, the control as children, a hint
line, and an error line that replaces the hint when present. Error text uses the destructive
token. The error line must not cause layout jump when it appears — reserve its height or animate
it. `accessibilityLabelledBy`-equivalent wiring so the control announces its label.

### `SearchField`
Input with a leading search icon, a clear button when non-empty, `purpose="search"`, and a
debounced `onDebouncedChange` (expose the debounce ms; default 250).

### `SegmentedControl`
iOS-style segmented selector for two-to-four options — used for theme mode
(`light`/`dark`/`system`) and similar. Animated selection indicator, `haptics.selection()` on
change.

### `Select`
A control that opens `P1-02`'s `ActionSheet` (few options) or `Sheet` with a list (many options).
Props: `value`, `options`, `onChange`, `placeholder`, plus an optional `renderOption` for rows
that need an icon or logo.

### `src/lib/validation.ts`
Pure validators with the app's **real** rules and **real error strings**, taken from
`research/12`:
- email format;
- password: **8–256** characters on signup, **12–256** on reset — these differ, do not unify them;
- required, min/max length, matching-confirmation;
- workspace/session name constraints (`research/07` documents max lengths);
- host pairing code: 8 characters, with the exact accepted character set.

Export them as `(value: string) => string | null` (error copy or null) so `Field` can render the
result directly. Quote the web app's copy verbatim; do not improvise wording.

## 4. Rules specific to you

- Never call `expo-haptics` directly — go through `@/lib/haptics`.
- No form-state library. Screens manage their own state; you provide controls and validators.
- Do not implement keyboard-avoidance scrolling here — that is a screen-level concern owned by the
  screens and, for the terminal, by `P2-05`.

## 5. Tests

- **`validation.ts` gets exhaustive tests** — every rule, boundary values (7/8/256/257 chars,
  11/12 for reset), and exact error strings. This is pure logic and the highest-value suite you
  write.
- `Input` applies the correct autocapitalize/autocorrect/textContentType set for each `purpose`
  (assert the props reaching the underlying `TextInput`).
- Password reveal toggles `secureTextEntry`.
- `Switch` fires `onValueChange` and the selection haptic (mock `@/lib/haptics`).
- `Field` renders hint, swaps to error, and does not shift layout.
- `SearchField` debounces (fake timers) and clears.
- `SegmentedControl` selection changes.

## 6. Deliverables checklist

- [ ] All 8 components plus `validation.ts`
- [ ] `purpose`-driven input configuration, correct for every case
- [ ] Real validation rules and verbatim error copy from `research/12`
- [ ] Haptics and accessibility on every control
- [ ] Tests pass; `typecheck`, `lint` clean for your files
- [ ] Progress file current; final report written

## 7. Reporting

Progress: `docs/native/progress/P1-03.md`. Final report: `docs/native/reports/P1-03.md` with every
component's prop signature, the full validator list with rules and copy,
`## Requests for other agents`, `## Known gaps`.
