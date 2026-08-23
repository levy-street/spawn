# Round 9

| # | Item | Status |
|---|------|--------|
| 1 | Bottom nav items vanished — regression from the round-8 restructure | ☑ |
| 2 | Remove the email from the profile drawer | ☑ |
| 3 | Profile avatar on brand (product red) | ☑ |
| 4 | Scrim drag snaps and flashes | ☑ reverted, see note |
| 5 | Workspace detail needs bottom safe area | ☑ |
| 6 | Remove the title and the Cancel row from every drop-up | ☑ |
| 7 | Row `...` too small and too close to the edge | ☑ |
| 8 | Full-page overlays should rise ~50px and fade; select should dismiss the keyboard | ☑ |

Verified: tsc clean, biome clean across 582 files, 1239 tests / 179 suites, iOS export builds.

## The regression (item 1)

Round 8 moved the tab bar into the tabs navigator's `tabBar` slot, so it only existed while
that navigator was mounted — and it stopped rendering once the tabs became a screen inside
the pushed stack. The bar is now mounted once by the signed-in layout and portalled to
window level, so its presence does not depend on any navigator. It navigates through the
router, which also removed the navigation/state plumbing it used to need.

`Screen` reserves the bar's footprint through `BottomChromeProvider`, and the height token
moved to `theme/sizing.ts` so a layout primitive does not import the navigator (and, through
it, the bottom-sheet library) just to know how tall the bar is.

## Item 4 — reverted rather than shipped

Round 8 drove the sheet's position frame by frame from the scrim so it would follow the
finger. Each imperative snap restarted gorhom's own animation, which is the stutter and
flash. That is now reverted: a scrim drag closes through the sheet's own animation.
Dragging the sheet or its handle still tracks the finger properly, because that gesture
belongs to the sheet. True finger-tracking from the scrim needs the sheet restructured so
its pannable content spans the full screen with a transparent upper region — worth doing,
but not a change to make blind.
