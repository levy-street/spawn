# G-06 — Terminal header, native menu, and dismissal from anywhere

**Wave B, parallel with two other agents.** Read `G-00-CONVENTIONS.md`, wave A's reports
(`G-01.md`, `G-03.md` — especially `NativePopover` and `GlassSurface`), then
`research3/16-ios-native-materials.md` §TL;DR 7 and `research3/19-bugs-and-verification.md` §C.

## 1. What the owner reported

> "on the header we dont need the folder path, there should be more space to the right of the
> terminal logo here and that failed logo isnt aligned properly"

> "this dropdown isnt wide enough and its also not using apple native components for liquid glass…
> on the terminal page it should be a normal popover with a normal back button"

> "for all overlay pages, i cant drag from anywhere (left to right) to close, i still have to drag
> on the edges"

## 2. Files you own

```
mobile/src/components/terminal-ui/**
mobile/src/app/terminal/[sessionId].tsx
mobile/src/terminal/TerminalSurface.tsx        # gesture/layout only — not transport
```

Do not change transport, the worker, or the ctl protocol. The identity binding that fixes
"Connection failed" was done in wave A by `G-01`; if it still fails, report it — do not re-fix it.

## 3. Header

- **Remove the folder path.** The owner does not want it in the header.
- Give the agent mark **more space to its right** — respect the spacing scale in `theme/sizing.ts`.
- **Align the status badge properly** — the "Failed" pill is visibly misaligned in the owner's
  screenshot. Align it on the same optical baseline as the title row.
- Use the **native-stack header with its automatic back button** (`research3/16 §TL;DR 7`,
  `G-00 §Decisions 2`) rather than the custom chevron. The owner asked for "a normal back button".

## 4. The menu

Replace the cramped custom dropdown with wave A's **`NativePopover`** — wide (≥260pt), 44pt rows, on
a guarded glass surface. Keep every existing action (Rename, Restart, Upload file, Search terminal,
Font size, Copy mode, Diagnostics, Kill session) with Kill session destructive.

## 5. Dismissal from anywhere

`research3/19 §C` explains why the previous attempt did not work: it covered only the loaded
terminal `Modal`; the terminal's **loading and error states have gestures disabled**; and the pan
competes with the WebView and a nested long-press.

So: dismissal must work from anywhere on the overlay in **every** state — loading, error, and
connected. `G-01` enabled full-screen back gestures for pushed screens app-wide; make the terminal
consistent with that. Vertical drags still belong to the terminal scrollback when connected
(`research/09 §TL;DR 8`), so keep the horizontal axis-locked model — but ensure the recogniser is
actually above the WebView and wins against the nested long-press. State in your report how you
verified the recogniser ordering.

## 6. Tests
- The header renders no path, and the badge aligns on the documented baseline.
- The menu renders through `NativePopover` with all actions and a destructive Kill session.
- Dismissal gesture is enabled in loading, error **and** connected states (assert per state).
- The axis-lock decision remains pure-testable and still passes.
- Existing terminal tests still pass.

## 7. Deliverables
- [ ] Header: no path, correct spacing, aligned badge, native back button
- [ ] `NativePopover` menu at ≥260pt with all actions
- [ ] Drag-to-close from anywhere in every terminal state
- [ ] `typecheck`, `lint`, `test` clean for your files
- [ ] Progress `docs/native/progress/G-06.md`; report `docs/native/reports/G-06.md`
