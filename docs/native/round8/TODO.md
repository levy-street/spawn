# Round 8 — spacing, sheet ergonomics, and a navigation rework

| # | Item | Status |
|---|------|--------|
| 1 | Too much space below the archived workspaces row | ☑ |
| 2 | Sheet action rows taller | ☑ |
| 3 | Sheets must account for the bottom safe area | ☑ |
| 4 | Scrim drag should track the finger continuously, not only fire on a flick | ☑ |
| 5 | Back from an overlay sometimes lands on an unrelated route | ☑ |
| 6 | Overlays sometimes animate in/out, sometimes not | ☑ |
| 7 | The app sometimes pushes itself in from the right, over itself | ☑ |
| 8 | Navigation generalised and clean end to end | ☑ |

Verified: tsc clean, biome clean across 582 files, 1238 tests / 179 suites, iOS export
accepts the new route tree.

## The navigation fix

`/workspace/[id]`, `/host/[id]`, `/legion` and `/admin` were **sibling tabs** of the three
roots, so opening a workspace was a tab switch, not a push. That one fact explains all three
symptoms: the whole app slid in over itself, `animation: "none"` meant no transition, and
back had no stack entry to pop so it guessed a destination from the path.

The three roots moved into a `(tabs)` route group — invisible in URLs, so no call site
changed — and the layout above them became an ordinary `Stack` that pushes every detail
screen over that group. Back pops real history, there is one transition everywhere, and the
retained companion-tab machinery with its back-destination guessing is gone.

## Menus and action sheets were two components

The workspace row's `...` is a `Menu`; the pane and host sheets are `ActionSheet`. They had
grown separate row implementations, so round 7's sizing reached only one of them. Both now
render through a shared `DrawerRow`, with the geometry in `sizing.actionSheet`.
