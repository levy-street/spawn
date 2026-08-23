# P1-02 — UI overlays: sheets, dialogs, menus, toasts, swipe-dismiss

**Phase 1, parallel with eight other agents.** You own every surface that floats above the page.
The owner's brief calls out "good native overlay pages that can be swiped away" and "good swipe
feedback" specifically — this is that.

**Read first:** `00-OVERVIEW.md` (§5, §7.1, §7.2, §8), then `research/01-design-system.md` for the
exact visual spec of `dialog`, `drawer`, `sheet`, `popover`, `dropdown-menu`, `cascade-menu`,
`toast`, `tooltip`, `confirm`, `collapse`, plus the overlay **z-index layering table** it
documents. Then `research/08-rn-stack.md §8` (bottom sheets and overlays) and §4 (gesture recipes).

---

## 1. Objective

Implement the overlay primitives with native-quality gesture behaviour: rubber-banded drags,
velocity-aware dismissal, correct keyboard avoidance, and haptics at the right moments.

## 2. Files you own

```
src/components/ui/sheet.tsx                    # bottom sheet (@gorhom/bottom-sheet)
src/components/ui/swipe-dismiss-overlay.tsx    # full-screen drag-down-to-dismiss container
src/components/ui/dialog.tsx                   # centred modal
src/components/ui/confirm.tsx                  # destructive/confirm dialog + imperative helper
src/components/ui/toast.tsx                    # toast + ToastProvider + useToast()
src/components/ui/menu.tsx                     # action menu / dropdown
src/components/ui/action-sheet.tsx             # iOS-style action list
src/components/ui/popover.tsx                  # anchored popover
src/components/ui/tooltip.tsx                  # long-press tooltip
src/components/ui/collapse.tsx                 # animated disclosure
src/components/ui/__tests__/**
```

Atoms (`button`, `text`, `card`…) belong to `P1-01`; import them, do not create them. Forms belong
to `P1-03`.

## 3. Specifications

### `SwipeDismissOverlay` — the most important component you build

A full-screen container that:
- animates in from the bottom with the shell-geometry motion (200ms,
  `cubic-bezier(0.32,0.72,0,1)` per `research/01 §motion`);
- can be dragged down to dismiss, with **rubber-banding** past the top bound and
  **velocity-aware** dismissal (a fast flick dismisses from a short distance; a slow drag needs to
  pass a threshold — use a projected-endpoint decay, not a raw distance test);
- dims and slightly scales the content behind it as it opens, restoring as it dismisses;
- fires `haptics.overlayOpen()` on present and `haptics.overlayDismiss()` when a drag crosses the
  dismissal threshold — fire on threshold crossing, not on release, so the phone confirms the
  gesture while the finger is still down;
- exposes a `dragHandleRegion` prop so a consumer can restrict where the drag starts. **The
  terminal overlay needs this**: inside a terminal, a vertical drag belongs to the scrollback, and
  only the header/top edge may start a dismissal (`research/09 §TL;DR 8`). Design for that from
  the start, do not bolt it on.
- runs entirely on the UI thread via Reanimated worklets + `react-native-gesture-handler`. No
  gesture state may round-trip through JS.

Props: `visible`, `onDismiss`, `dragHandleRegion?: 'full' | 'header'`, `dismissThreshold?`,
`backdropOpacity?`, `children`.

### `Sheet`
Bottom sheet on `@gorhom/bottom-sheet` v5. Snap points, backdrop, keyboard avoidance
(`keyboardBehavior`/`keyboardBlurBehavior` set so a focused input inside the sheet stays visible),
`haptics.selection()` on snap-point change. Provide a `SheetHeader` with title + optional action.

### `Dialog` / `Confirm`
Centred modal with the web app's fade + 95%-scale entrance (`research/01 §motion`). `Confirm`
provides the destructive-action pattern with the web app's exact copy conventions, a destructive
variant, and an imperative `confirm({...}): Promise<boolean>` helper so callers don't each manage
visibility state.

### `Toast` + `ToastProvider` + `useToast()`
Matches the web toast's position, stacking, timing and variants (default/success/error). Queue
behaviour: multiple toasts stack rather than replace. Swipe to dismiss. Safe-area aware. Success
fires `haptics.success()`, error `haptics.error()`.

The provider mounts once at the app root — `P3-01` wires it. Export the provider and the hook;
do not mount it yourself.

### `Menu`, `ActionSheet`, `Popover`, `Tooltip`
- `Menu`: anchored action list with the popover surface tokens (note `popover-border` and
  `popover-accent` are deliberately distinct from `border`/`accent` — `research/01` explains why).
  Destructive items in the destructive tone. `haptics.selection()` on item press.
- `ActionSheet`: bottom-anchored action list for phone-shaped choices, with a cancel affordance.
- `Popover`: anchored to a measured element, flipping when it would clip the screen edge. The web
  app has real positioning logic (`menu-position.ts`) — reproduce its flip/shift behaviour.
- `Tooltip`: long-press activated on touch (there is no hover on a phone). Keep it simple.

### `Collapse`
Animated height disclosure with the standard 150ms transition; measures content, handles dynamic
content, and respects reduced motion.

## 4. Rules specific to you

- Every gesture must feel like the OS: interruptible animations (grabbing a closing overlay
  re-attaches to the finger), no clamped linear drags, no dismissal that fires on a tap.
- Respect reduced motion: replace transforms with a plain fade when it is enabled.
- Safe areas via `react-native-safe-area-context` everywhere an overlay touches a screen edge.
- Do not build a generic "portal/overlay manager" framework. Expo Router's modals plus these
  components are enough.

## 5. Tests

Gesture behaviour cannot be fully tested headlessly — test the parts that can be:
- the **dismissal decision function** as a pure unit: given translation, velocity and threshold,
  does it dismiss? Extract this from the worklet into a plain exported function and test it
  thoroughly, including the velocity-projection edge cases. This is the highest-value test you
  write.
- the popover **flip/shift positioning** function as a pure unit against screen bounds;
- toast **queueing/stacking reducer** as a pure unit;
- render tests: each overlay mounts, calls `onDismiss` when its close control is pressed, and
  renders children;
- reduced-motion variants render.

## 6. Deliverables checklist

- [ ] All 10 components implemented to spec
- [ ] `SwipeDismissOverlay` supports `dragHandleRegion: 'header'` for the terminal
- [ ] Velocity-aware, rubber-banded, interruptible gestures on the UI thread
- [ ] Haptics fire at threshold crossing, not on release
- [ ] Reduced motion and safe areas handled
- [ ] Pure dismissal/positioning/queue functions extracted and unit-tested
- [ ] `typecheck`, `lint`, `test` clean for your files
- [ ] Progress file current; final report written

## 7. Reporting

Progress: `docs/native/progress/P1-02.md`. Final report: `docs/native/reports/P1-02.md` with the
full prop signature of every component (Phase 2 depends on these), the exported pure functions and
their semantics, `## Requests for other agents`, `## Known gaps`.
