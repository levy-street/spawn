# P1-04 — Motion, gestures and haptics

**Phase 1, parallel with eight other agents.** You own the layer that makes the app feel native:
the haptic vocabulary, the shared motion constants, and the two reusable gesture components the
core journey depends on — the **tab pager** and the **swipeable row**.

**Read first:** `00-OVERVIEW.md` (§5, §7.1, §7.2, §8), then `research/08-rn-stack.md §4`
(gesture/animation recipes, Reanimated 4 + Gesture Handler versions and worklet caveats) and §5
(the `expo-haptics` API surface and the recommended haptic vocabulary table), then
`research/01-design-system.md §motion` for the exact durations and easings.

---

## 1. Objective

Ship the haptic vocabulary module, motion helpers, and the gesture components for horizontal tab
paging and swipe-to-action rows — all running on the UI thread.

## 2. Files you own

```
src/lib/haptics.ts
src/lib/motion/easings.ts          # named easings matching the web curves
src/lib/motion/durations.ts        # named durations
src/lib/motion/use-press-scale.ts  # shared press animation hook
src/lib/motion/reduced-motion.ts   # reduced-motion hook + helpers
src/components/gestures/tab-pager.tsx
src/components/gestures/swipeable-row.tsx
src/components/gestures/drag-threshold.ts   # pure dismissal/commit decision logic
src/lib/__tests__/haptics.test.ts
src/components/gestures/__tests__/**
src/lib/motion/__tests__/**
```

`SwipeDismissOverlay` belongs to `P1-02` — it imports `drag-threshold.ts` from you. Coordinate by
contract only: export the pure decision function described in §3.4 and do not build the overlay.

## 3. Specifications

### 3.1 `src/lib/haptics.ts`

The single haptics entry point for the entire app. Signature is frozen in
`00-OVERVIEW.md §7.2`.

Implementation requirements:
- Wraps `expo-haptics`. **No screen or component may import `expo-haptics` directly** — you are
  the only file that does.
- Every call is fire-and-forget and must never throw. `expo-haptics` rejects on unsupported
  hardware and in some simulator contexts; swallow and continue.
- Provide a module-level enable/disable switch (`setEnabled(bool)`) so the settings panel
  (`P2-08`) can honour a user preference, and so tests can assert silence.
- Rate-limit repeats: an identical haptic fired more than once within ~50ms should collapse to one
  call. Rapid-fire taptics feel like a buzz, not feedback.
- Semantic wrappers (`overlayOpen`, `overlayDismiss`) map to concrete styles — document the mapping
  in a comment and in your report.

Publish the **haptic vocabulary** as the app's single source of truth, from `research/08 §5`:

| Interaction | Haptic |
|---|---|
| Tab change (pager settles on a new tab) | `selection()` |
| List row select / picker tick | `selection()` |
| Button press (default) | `impact('light')` |
| Destructive action press | `warning()` |
| Overlay presented | `overlayOpen()` |
| Drag crosses dismissal threshold | `overlayDismiss()` |
| Swipe row reveals an action | `impact('light')` |
| Swipe row commits a destructive action | `warning()` |
| Mutation succeeded (toast) | `success()` |
| Mutation failed (toast) | `error()` |
| Terminal connected / session ready | `success()` |
| Terminal disconnected unexpectedly | `error()` |
| Long-press context menu opens | `impact('medium')` |

Phase 2 agents will consult this table rather than inventing their own; make sure your report
reproduces it.

### 3.2 `src/lib/motion/*`

- `durations.ts`: named durations from `research/01 §motion` — the 150ms default, the 200ms shell
  geometry, the 220ms drawer/sheet translation, toast timings, skeleton shimmer period. Name them
  by interaction, not by number (`durations.press`, `durations.shell`, `durations.sheet`).
- `easings.ts`: the web curves as Reanimated `Easing.bezier` definitions —
  `cubic-bezier(0.4,0,0.2,1)` as the standard curve and `cubic-bezier(0.32,0.72,0,1)` as the shell
  curve. **The web app uses no springs** (`research/01 §TL;DR`); do not introduce spring physics
  for anything that has a web counterpart. Gesture-tracking animations (pager, drag) are the
  exception — they follow the finger and settle with a decay/spring, which has no web analogue.
- `use-press-scale.ts`: the shared press feedback hook (`P1-01`'s Button and `P1-02`'s menu rows
  both use it) returning an animated style and press handlers.
- `reduced-motion.ts`: `useReducedMotion()` plus a `motionSafe(animatedValue, fallback)` helper.
  Every animated component in the app routes through this.

### 3.3 `src/components/gestures/tab-pager.tsx`

The horizontal pager for workspace tabs — the owner asked specifically to "drag swipe between
tabs". This is a headline interaction.

Requirements:
- Built on `react-native-pager-view` (bundled in Expo Go 54) **or** a Reanimated + Gesture Handler
  implementation. Prefer `react-native-pager-view` for native scroll physics; drop to a custom
  implementation only if it cannot deliver the drag-follow feedback below, and say which you chose
  and why in your report.
- The page must **track the finger** during the drag, not snap on release only.
- A connected header/tab-strip indicator must move **continuously with the drag offset**, not jump
  on settle. Expose the drag progress as a shared value (`onOffsetChange` or a
  `useSharedValue` handed down) so the tab strip can animate in lockstep on the UI thread.
- `haptics.selection()` fires **once** when the pager commits to a new page.
- Supports lazy rendering (render the active page ± 1) so a workspace with eight tabs does not
  mount eight lists.
- Controlled and uncontrolled use: `page`, `onPageChange`, `initialPage`.
- Works with a vertically-scrolling list inside each page without gesture conflict.

Props: `pages`, `renderPage`, `page`, `onPageChange`, `onDragProgress`, `lazyWindow`.

### 3.4 `src/components/gestures/swipeable-row.tsx` and `drag-threshold.ts`

Swipe-to-reveal actions on list rows (close a terminal, move a tab, archive a workspace).

- Leading and trailing action sets, each with icon + label + tone.
- Rubber-band resistance past the action width.
- Full-swipe commits the primary destructive action, with `haptics.warning()` at the commit
  threshold **while the finger is still down**.
- Programmatic `close()` via ref; only one row open at a time is the consumer's concern, not yours.

`drag-threshold.ts` holds the **pure** decision logic, shared with `P1-02`'s overlay:

```ts
export interface DragDecisionInput {
  translation: number;      // px travelled along the axis
  velocity: number;         // px/s at release
  size: number;             // px of the full dimension (screen height or row width)
  threshold?: number;       // fraction of size, default 0.35
  projectionMs?: number;    // velocity projection window, default 150
}
/** Projects the release point forward by velocity and decides whether to commit. */
export function shouldCommitDrag(input: DragDecisionInput): boolean;
/** The resting offset to animate to given a decision. */
export function restingOffset(input: DragDecisionInput, committed: boolean): number;
```

Keep these free of Reanimated imports so they are trivially unit-testable, and mark them
`'worklet'`-safe (pure, no closures over JS state) so they can be called from the UI thread.

## 4. Rules specific to you

- All gesture state lives on the UI thread. If you find yourself calling `runOnJS` inside a pan
  handler for anything other than a haptic or a commit callback, reconsider.
- Do not build an animation framework, a gesture registry, or a motion "system". Four small
  modules and two components.
- Do not implement the tab strip UI, the workspace list, or the terminal overlay. You build the
  mechanism; Phase 2 builds the surfaces.

## 5. Tests

- `drag-threshold.ts`: exhaustive. Slow drag past threshold commits; fast flick from a short
  distance commits; slow drag short of threshold does not; velocity in the opposing direction
  cancels; boundary values. This is your most important suite.
- `haptics.ts`: each method calls the expected `expo-haptics` API (mock the module); disabled mode
  calls nothing; the 50ms repeat collapse works with fake timers; a rejecting `expo-haptics` does
  not throw.
- `durations`/`easings`: values match the documented web curves (guards against silent drift).
- `reduced-motion`: helper returns the fallback when enabled.
- `TabPager`: renders pages, calls `onPageChange`, fires exactly one selection haptic per commit,
  respects `lazyWindow`.
- `SwipeableRow`: renders actions, `close()` works, action press fires its callback.

## 6. Deliverables checklist

- [ ] `haptics.ts` matching §7.2, with the full vocabulary table implemented
- [ ] Motion modules with the exact web durations and easings, no invented springs
- [ ] `TabPager` with continuous drag-progress output and one haptic per commit
- [ ] `SwipeableRow` with rubber-banding and at-threshold haptics
- [ ] `drag-threshold.ts` pure, worklet-safe, exhaustively tested
- [ ] `typecheck`, `lint`, `test` clean for your files
- [ ] Progress file current; final report written

## 7. Reporting

Progress: `docs/native/progress/P1-04.md`. Final report: `docs/native/reports/P1-04.md` —
reproduce the haptic vocabulary table, give the full API of every module and component, state
whether `TabPager` used `react-native-pager-view` or a custom implementation and why,
`## Requests for other agents`, `## Known gaps`.
