# spawn — UI standards

The living design-system reference for `spawn-web`. Every visual decision
flows through the tokens in `web/src/app/globals.css` and the primitives in
`web/src/components/ui/` — this document is the inventory of both and the
rules for extending them. The shipped product/feature decision record lives in
`docs/OVERHAUL.md`; system architecture lives in `README.md`,
`docs/TRUST.md`, and `proto/README.md`.

The endpoint-local protected-data proposal in
`DURABLE_SENSITIVE_DATA.md` remains review-pending and unimplemented; do not
add UI for that store until a current shell-session design is accepted.

## Rules

1. **No Tailwind palette literals.** `emerald-500`, `amber-400`, `sky-300`,
   `zinc-600`, `red-500`, … must not appear anywhere in `web/src/` outside
   `globals.css`. Use the semantic tokens below. The Phase C grep gate
   (`docs/OVERHAUL.md` §9) enforces this; Biome cannot.
   - The sanctioned exceptions are fixed brand constants: the grimoire
     marketing palette (`bg-void`, `text-hellfire`, …), and third-party brand
     marks in `components/icons/` whose plate colors are arbitrary-value hex
     (`bg-[#D97757]`) because a logo keeps its identity in both themes.
2. **A new visual pattern becomes a primitive first.** If a surface needs a
   dropdown/dialog/menu/spinner/empty state that doesn't exist yet, add it to
   `web/src/components/ui/` (tokens only, both themes), then use it. No
   component-local one-offs, no copy-pasted panels.
3. **Both themes, always.** Every color token is defined for `:root` (light)
   and `[data-theme="dark"]`, and exposed through the `@theme inline` block so
   Tailwind utilities (`bg-success`, `text-warning`, `border-info/25`)
   resolve at runtime via CSS vars. Never define a color in only one theme;
   never write `dark:` pairs of raw colors when a token would swap itself.
4. **`destructive` is the canonical danger name.** There is no `--danger`
   family. Buttons, badges, text, and borders all use the `destructive`
   tokens.
5. **Container queries for layout, viewport queries for overlays.** See
   below.
6. **No timing-dependent UI.** Animations are decorative; logic never waits
   on them. Global reduced-motion support collapses all transitions.

## Tokens (`web/src/app/globals.css`)

### Surfaces and chrome (theme-swapped, all-neutral oklch)

`--background`, `--foreground`, `--muted`, `--muted-foreground`, `--card`,
`--card-foreground`, `--popover`, `--popover-foreground`, `--primary`,
`--primary-foreground`, `--secondary`, `--secondary-foreground`, `--accent`,
`--accent-foreground`, `--border`, `--input`, `--ring`, `--terminal-bg`,
`--shell`, and the brand-page stack `--brand-bg` / `--brand-panel` /
`--brand-well` / `--brand-hairline`. `--shell` is the app-shell ground — the
sidebar, the frame the content panel floats in, and the workspace grid's
gutter — set a step off the content panel in each theme (lighter in dark at
`oklch(0.205 0 0)`, darker in light at `oklch(0.945 0 0)`) so chrome and
content never read as one surface.

The workspace tab strip (`workspace-tabs.tsx`) is the same move again: the
strip is a band of `--shell` and the selected tab is a `--background` shape
cut into it (rounded top, flush bottom) — content rising into the chrome. An
empty tab's canvas is `--card`, one step darker than the shell ground, so a
fresh tab reads as a surface awaiting panes rather than more chrome.

Pane focus rides the same figure/ground idea rather than a fourth token: the
focused pane is left as `--background`, the deepest surface in the stack, and
every other pane takes a wash on top that always moves *away* from the light —
`bg-black/25` in dark, `bg-foreground/[0.035]` in light — receding in both. In
dark the ground is already near-black, so what visibly recedes is the pane's
content rather than its surface. Focus draws **no ring**; the background is
the whole signal. The only ring a pane draws is the cross-highlight from
hovering its row in the sidebar, and a pane never draws it for its own hover. It has to be an overlay, not a background
swap: xterm paints its own opaque canvas, so a pane's own `bg-*` never shows
through the terminal. These are pure neutral (`oklch(L 0 0)`) in both themes;
light is the same ramp read from the other end.

### Brand accent (theme-swapped)

`--brand-accent` / `--brand-accent-soft` — the landing page's hellfire
(`#ff4930` = `oklch(0.666 0.222 31)`) carried into the app chrome as its one
non-status accent. Light is `oklch(0.55 0.2 31)`, at the same L ≤ 0.55 the
status hues use so it clears 4.5:1 on `--background`; dark is
`oklch(0.67 0.22 31)`, the landing value. It is *not* a status color and
carries no meaning — it is identity. Used by the `spawnd` wordmark, the
launcher's `+`, and `::selection`. `--ring` is **neutral** — `--foreground`
in both themes, ring width 1px on the form primitives — a focus ring is never
the accent red. Do not reach for the accent to signal state; that is what the
`success` / `warning` / `info` / `destructive` families are for.

### Semantic status (theme-swapped; the only chroma in the app palette)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--success` | `oklch(0.52 0.13 152)` | `oklch(0.74 0.15 152)` | positive text/icons/borders |
| `--success-soft` | same hue `/ 0.12` | same hue `/ 0.14` | chip/badge/callout fills |
| `--warning` | `oklch(0.55 0.13 75)` | `oklch(0.78 0.14 80)` | attention text/icons/borders |
| `--warning-soft` | same hue `/ 0.14` | same hue `/ 0.14` | fills |
| `--info` | `oklch(0.52 0.11 240)` | `oklch(0.72 0.12 235)` | neutral-informative accents |
| `--info-soft` | same hue `/ 0.12` | same hue `/ 0.14` | fills |
| `--destructive` | `oklch(0.53 0.2 25)` | `oklch(0.62 0.21 25)` | dangerous actions/errors |
| `--destructive-soft` | same hue `/ 0.1` | same hue `/ 0.14` | fills |

Light values sit at L ≤ 0.55 so status text clears 4.5:1 on `--background`.
The `*-soft` tints are translucent so they sit correctly on any surface
(card, popover, background). The standard chip recipe is the Badge's:
`border-<status>/25 bg-<status>-soft text-<status>`.

"Attention" states (a session waiting for input) use the `warning` family.

### Code (theme-swapped)

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--code-comment` | `oklch(0.55 0.02 260)` | `oklch(0.62 0.02 260)` | comments |
| `--code-string` | `oklch(0.48 0.12 150)` | `oklch(0.78 0.13 150)` | string literals |
| `--code-keyword` | `oklch(0.50 0.16 305)` | `oklch(0.76 0.14 305)` | keywords, markup tags |
| `--code-number` | `oklch(0.52 0.13 60)` | `oklch(0.80 0.12 70)` | numbers, markup attributes |
| `--code-punct` | `oklch(0.55 0.02 260)` | `oklch(0.66 0.02 260)` | punctuation |

Its own family rather than a reuse of the status hues, which carry meaning:
painting a string literal "success green" is precisely the semantic overload the
token system exists to prevent. Light values sit at the same `L ≤ 0.55` the
status hues use, so each clears 4.5:1 on `--background`.

### Status-dot tones (theme-swapped)

| Token | Light | Dark | Meaning |
|---|---|---|---|
| `--tone-active` | `oklch(0.6 0.16 152)` | `oklch(0.74 0.17 152)` | producing output / online |
| `--tone-waiting` | `oklch(0.6 0.13 240)` | `oklch(0.72 0.13 235)` | waiting for input, starting |
| `--tone-idle` | `oklch(0.6 0 0)` | `oklch(0.68 0 0)` | running, quiet |
| `--tone-offline` | `oklch(0.78 0 0)` | `oklch(0.44 0 0)` | exited / host offline |

These map 1:1 to `DotTone` in `ui/status.tsx` and to
`sessionActivityTone()` in `lib/sessions.ts`. Dots are brighter than the
text hues on purpose — an 8px dot needs punch, not reading contrast.

### Chrome geometry (theme-invariant)

| Token | Value | Use |
|---|---|---|
| `--sidebar-width` | `264px` | expanded sidebar / drawer width |
| `--sidebar-rail-width` | `56px` | collapsed sidebar rail |
| `--row-h` | `2.25rem` | the 36px nav-row rhythm (sidebar rows, list rows) |
| `--pane-gap` | `6px` | workspace grid gutter |
| `--content-inset` | `0px`, raised to `8px` by `<main>` at `@md/shell` | gap around the floating content panel. The sidebar is full-bleed chrome; `<main>` is a rounded panel on it. Nothing in this stack outlines itself
with a hairline — figure and ground do the separating: `--shell` behind
`--background` for the panel, and again for the workspace grid's gutter
behind its session panes. Anything sizing itself off `--vv-height` inside the shell subtracts `2*var(--content-inset)`. Raised on `<main>`, **not** on the `@container/shell` root — an element cannot container-query the container it establishes, so an `@md/shell:` variant there never matches |

No Tailwind utility names; consume as arbitrary values —
`w-(--sidebar-width)`, `h-(--row-h)`, `gap-(--pane-gap)`. Never re-declare
these as TS constants in components.

### Radius, motion, viewport

- Radius: `--radius-sm` 0.375rem, `--radius-md` 0.5rem, `--radius-lg`
  0.625rem (`rounded-sm/md/lg`).
- `.ease-swift` — the shared decelerating easing
  (`cubic-bezier(0.32, 0.72, 0, 1)`) for shell chrome animation. Grid tile
  moves use `transform 150ms` with it.
- `prefers-reduced-motion` collapses every animation/transition globally; do
  not add per-component motion opt-outs.
- Cursors: Tailwind v4's Preflight sets `cursor: default` on buttons, so
  `globals.css` restores `cursor: pointer` for `button`, `[role="button"]`,
  `[role="menuitem"]`, `[role="option"]`, `[role="tab"]`, `label[for]`, and
  `summary` in `@layer base`. Disabled controls are excluded. Because it is a
  base rule, any explicit `cursor-*` utility still wins — that is how the
  drag/resize grips and the deliberately arrow-cursored menu items keep their
  own cursors. Do not add `cursor-pointer` to individual buttons.
- `--vv-height` / `--vv-keyboard` track the visual viewport (on-screen
  keyboard); `--safe-*` are the safe-area insets. Utilities: `h-vv`,
  `min-h-vv`, `pad-safe-top/bottom/x`. Every full-height overlay (dialog,
  drawer, sheet) caps itself to `--vv-height`.

### Grimoire (marketing surfaces)

`--color-void/char/panelg/line-g/line-strong/bone/ash/hellfire/blood/ember`
plus `--font-grimoire/sigil` — fixed constants for the `.grimoire` landing
skin. App chrome does not paint with these; it reaches the same brand through
the theme-swapped `--brand-accent` above. The two sanctioned crossings are the
shared brand lockup (`components/icons/BrandMark.tsx`) and `--font-sigil`,
which the wordmark uses on every surface.

## Primitives (`web/src/components/ui/`)

Conventions: hand-rolled shadcn-style unless Radix is already the right tool
(`dialog` builds on `@radix-ui/react-dialog`); `cn()` for class merging;
`cva` where real variants exist; `forwardRef` when a caller needs the node;
tokens only.

| File | Exports | Use it for |
|---|---|---|
| `button.tsx` | `Button` (`variant`: default/secondary/outline/ghost/destructive/link; `size`: default/sm/lg/icon) | every clickable action |
| `input.tsx`, `textarea.tsx`, `label.tsx` | form fields | all text entry |
| `badge.tsx` | `Badge` (`variant`: default/outline/success/warning/info/destructive) | status chips |
| `status.tsx` | `DotTone`, `StatusDot`, `SessionStatusDot`, `hostStatusTone` | activity/presence dots |
| `card.tsx` | `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter` | grouped content panels |
| `skeleton.tsx` | `Skeleton` | loading placeholders for known layouts |
| `spinner.tsx` | `Spinner` (`size`, `label`) | indeterminate loading; replaces "Loading..." text |
| `empty-state.tsx` | `EmptyState` (`icon`, `title`, `body`, `action`) | empty workspace, no hosts, empty lists |
| `dialog.tsx` | `Dialog`, `DialogContent` (`size`: `sm`/`md`/`lg`/`full-mobile`/`viewer`), `DialogHeader/Title/Description/Footer/Trigger/Close` | every modal. `full-mobile` = full screen under `md:`, large panel above; `viewer` is the same shape sized for file content |
| `confirm.tsx` | `confirm(opts): Promise<boolean>`, `useConfirm`, `ConfirmHost` | destructive/irreversible actions. `ConfirmHost` is mounted once in the app shell; never build ad-hoc confirm dialogs |
| `toast.tsx` | `toast(msg, opts?)`, `toast.error(msg, opts?)`, `ToastHost` | transient outcome/error notices (replaces inline error banners). `ToastHost` is mounted once in the app shell; duplicates coalesce; errors linger longer. The stack sits top-right under the mobile header, newest at the top, capped at 5 — a sixth evicts the oldest, not the newest. `opts` adds a dimmer second line (`detail`) and a leading mark (`icon`) for notices where what happened and where it happened are different facts |
| `dropdown-menu.tsx` | `DropdownMenu` (render-prop trigger, `openAt` handle), `DropdownMenuItem/Separator/Label` | single-level menus, kebabs, right-click menus |
| `cascade-menu.tsx` | `CascadeMenu`, `CascadePanel`, `CascadeItem` | multi-step pick-one flows (the `+` new-session cascade). Panels are data; per-panel `loading`; items can be `heading` section labels; renders as a bottom sheet on small viewports |
| `sheet.tsx` | `BottomSheet` | mobile bottom-sheet container (drag handle, scrim, `--vv-height` cap) |
| `drawer.tsx` | `Drawer` | left slide-in panel (the mobile sidebar): scrim, drag-to-dismiss, focus trap |
| `tooltip.tsx` | `RailTooltip` | collapsed-sidebar hover/focus hints |
| `switch.tsx` | `Switch`, `SwitchRow` | a setting that applies the moment it is flipped. `role="switch"` on a real `<button>`, so Space/Enter and disabled semantics come from the platform. `SwitchRow` is the labelled form — label, one line of hint, full-row hit area — and the hint is where an unavailable channel explains itself rather than sitting there inert |
| `popover.tsx` | `Popover` (`anchor`, `side`, `align`, `interactive`) | a floating surface anchored to a rect the *caller* supplies, when that rect is not simply the trigger — the file preview card tracks a row vertically while staying pinned to the panel's edge. Non-interactive by default (`role="tooltip"`, pointer events off) so it cannot capture the hover that opened it |
| `hover-intent.ts` | `useHoverIntent`, `createHoverIntent` | opening something because the pointer *stopped*, not because it passed through. The pure factory takes its clock, so the behaviour is unit-tested with no DOM |

Usage rules:

- Menus: one level → `DropdownMenu`; steps → `CascadeMenu`. Never nest
  dropdowns manually.
- Anything that asks "are you sure" goes through `confirm()`. `window.confirm`
  / `window.prompt` are banned.
- Errors from background work (layout saves, polling, tab CRUD) go through
  `toast.error()`, not inline banners — the surface that failed usually isn't
  where the user is looking.
- Overlays own their own scrim, Escape handling, focus behavior, and scroll
  locking — callers only control `open`.

## Icons

- `components/icons/AgentIcon.tsx` — agent identity everywhere (sidebar
  session rows, pane headers, agent switcher). Resolves definition `kind`
  first, then the foreground/command basename: bundled marks for
  `claude-code`, `codex`, `opencode`, `aider`, `hermes`; terminal glyph for
  `bash|zsh|fish|sh|dash`; first-letter monogram otherwise. Props:
  `{kind?, command?, size?, className?}`.
- `components/icons/BrandMark.tsx` — the spawnd trident (`Trident`) and the
  wordmark's typography (`WORDMARK_CLASS`: sigil mono, lowercase, `0.22em`
  tracking). One lockup for the landing nav, the download nav, the auth shell,
  the sidebar header, and the mobile header. The trident art is fixed hellfire
  like the `AgentIcon` plates — a logo keeps its identity in both themes — so
  only the wordmark's color varies: `text-brand-accent` in app chrome,
  `text-hellfire` on `.grimoire` grounds.
- Everything else uses `lucide-react` at `size-4` (16px) inside `size-7`+
  hit areas.

## Responsiveness

- **Container queries drive layout.** Components adapt to the container they
  live in, not the window — the app shell publishes `@container/shell`, the
  settings dialog `@container/settings`; panes and panels use `@md/shell:`
  style variants. A terminal pane at 400px wide inside a wide window must lay
  out like a 400px screen.
- **Viewport `md:` is reserved for overlay presentation** — where a surface
  materializes (dialog vs full screen, anchored menu vs bottom sheet, sidebar
  vs drawer). `DialogContent size="full-mobile"` and `CascadeMenu`'s auto
  sheet mode are the canonical examples.
- Touch targets on coarse pointers: min `h-11` (44px).
- Mobile chrome details (keyboard-aware `--vv-height`, safe areas,
  `ModifierBar`) are part of every feature, not a follow-up.

## Adding a token or primitive

1. Define the token in `:root` **and** `[data-theme="dark"]`, wire it in
   `@theme inline`, and add it to the inventory above — same PR.
2. Check light-mode contrast (text ≥ 4.5:1 on its surface; non-text ≥ 3:1).
3. New primitive: tokens only, keyboard + focus behavior included, works in
   both themes and both pointer types, then documented in the table above.
4. If an existing surface hand-rolls the pattern, migrate it in the same PR —
   primitives don't ship with zero consumers and a TODO.
