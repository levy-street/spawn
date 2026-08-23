# P1-01 — UI foundation: the global primitive atoms

**Phase 1, parallel with eight other agents.** You own the atoms every screen in the app is built
from. Get these right and Phase 2 is assembly; get them wrong and ten agents build on sand.

**Read first:** `00-OVERVIEW.md` (§5 conventions, §7.1 theme contract, §8 ownership), then
`research/01-design-system.md` — its component-by-component visual spec is your specification,
covering anatomy, variants, sizes, states, exact paddings, heights, radii and per-state colours for
every primitive in `web/src/components/ui/`.

---

## 1. Objective

Implement the primitive components, matching the web app's visual spec exactly, using only the
theme tokens from `@/theme`.

## 2. Files you own

```
src/components/ui/text.tsx
src/components/ui/button.tsx
src/components/ui/icon-button.tsx
src/components/ui/card.tsx
src/components/ui/badge.tsx
src/components/ui/status-dot.tsx
src/components/ui/spinner.tsx
src/components/ui/skeleton.tsx
src/components/ui/divider.tsx
src/components/ui/monogram.tsx
src/components/ui/chip.tsx
src/components/ui/empty-state.tsx
src/components/ui/icon.tsx
src/components/ui/__tests__/**
```

Nothing else. `sheet`, `dialog`, `toast`, `menu` belong to `P1-02`; `input`, `switch`, `field`
belong to `P1-03`. Do not create them, do not import them.

## 3. Component specifications

Take every literal value — padding, height, radius, font size, colour per state — from
`research/01`. Where it gives a table for a component, that table is the spec. Do not round
values, do not substitute a "close enough" token, do not invent variants the web app lacks.

### `Text`
The typography primitive. Props: `variant` (the named scale from `research/01` typography, e.g.
title/body/label/caption/mono), `color` (a semantic token name, not a raw colour), `weight`,
`numberOfLines`, plus standard `TextProps`. Every other component renders text through this — no
bare `<Text>` from `react-native` anywhere in the app.

### `Button`
Variants and sizes exactly as the web `button.tsx` defines them (`research/01` enumerates them).
States: default, pressed, disabled, loading. Requirements:
- Pressed state uses the token'd press treatment and the 150ms default transition, animated with
  Reanimated — not `TouchableOpacity`'s default fade.
- `loading` swaps the label for `Spinner` while preserving the button's width (no layout jump).
- Fires `haptics.impact('light')` on press for default variants and `haptics.warning()` for
  destructive variants. Import from `@/lib/haptics` (`P1-04`) — code against
  `00-OVERVIEW.md §7.2`; the module may not exist yet, that is expected.
- Minimum 44×44 touch target regardless of visual size.
- `accessibilityRole="button"`, label from the text content or an explicit prop.

### `IconButton`
Icon-only button. Same variants/states, square, with the same 44×44 minimum and a required
`accessibilityLabel`.

### `Icon`
Wraps `lucide-react-native`. Props: `name` (typed against the icon set), `size`, `color` (semantic
token). `research/01` lists every icon name the web app actually uses — type `name` against that
list so a typo is a compile error. If an icon in that list does not exist in
`lucide-react-native`, note it in your report and pick the nearest; do not silently drop it.

### `Card`
Surface container. Padding, radius, border and background per token. Variants for the elevated and
flat treatments the web app uses.

### `Badge` / `Chip`
Small status/label pills. All variants including the `*-soft` translucent tints
(`destructive-soft`, `success-soft`, `warning-soft`, `info-soft`).

### `StatusDot`
The status indicator used in sidebar rows, pane headers and host cards. Renders the four tones
(`tone-active`, `tone-waiting`, `tone-idle`, `tone-offline`). The active tone pulses — reproduce
the web animation's timing from `research/01 §motion`, and **respect reduced-motion**: when
`AccessibilityInfo.isReduceMotionEnabled` is true, render a static dot.

### `Spinner`
Indeterminate loader at the web app's sizes and speed.

### `Skeleton`
Shimmer placeholder. Match the web shimmer's duration and direction. Also honours reduced motion
(static muted block).

### `Divider`
Hairline. Note that the web app has two distinct hairlines — `border` and the brighter
`pane-divider` used between tiled panes. Expose both via a prop; do not collapse them.

### `Monogram`
The first-letter fallback mark used when an agent kind has no logo (`research/07 §TL;DR 4`).
Deterministic background from the seed string, foreground with sufficient contrast, circular,
sized by prop.

### `EmptyState`
Icon + title + optional description + optional action. Used by every list in the app.

## 4. Rules specific to you

- **Every value from a token.** If you find yourself typing a hex colour or a pixel number that
  isn't a `space()` multiple, you are doing it wrong — go find the token.
- **No feature knowledge.** These components know nothing about sessions, workspaces or hosts.
  `StatusDot` takes a tone, not a session.
- Animate with `react-native-reanimated`. No `Animated` from `react-native`.
- Do not build a variant system abstraction. A `variant` prop with a lookup object is enough; the
  app does not need a styled-system.

## 5. Tests

`src/components/ui/__tests__/`, using `@testing-library/react-native`:
- each component renders in both light and dark without throwing;
- `Button` disabled does not fire `onPress`; loading shows the spinner and keeps its label width;
- `Button` press fires the expected haptic (mock `@/lib/haptics`);
- `Badge`/`Chip` render every variant;
- `StatusDot` renders each tone and goes static under reduced motion (mock `AccessibilityInfo`);
- `Icon` rejects an unknown name at the type level (a `@ts-expect-error` assertion test);
- `EmptyState` renders and fires its action.

Snapshot tests are welcome for the variant matrices, but assert behaviour where behaviour exists.

## 6. Deliverables checklist

- [ ] All 13 files implemented to the `research/01` spec
- [ ] Every value sourced from `@/theme`
- [ ] Reduced-motion handled in `StatusDot` and `Skeleton`
- [ ] 44×44 minimum targets and accessibility roles/labels throughout
- [ ] Tests pass; `typecheck` and `lint` clean for your files
- [ ] Progress file kept current; final report written

## 7. Reporting

Progress: `docs/native/progress/P1-01.md`. Final report: `docs/native/reports/P1-01.md`,
including the prop signature of every component you shipped (Phase 2 agents consume these and
cannot read your source before they start), any `research/01` value that was missing or
self-contradictory, `## Requests for other agents`, and `## Known gaps`.
