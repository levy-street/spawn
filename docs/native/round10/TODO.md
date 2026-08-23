# Round 10

| # | Item | Status |
|---|------|--------|
| 1 | Nav taps slide the new page in on top; should switch instantly | ☑ |
| 2 | Workspace options menu had no bottom safe area | ☑ |
| 3 | Bottom sheets: drag from above the panel didn't actually drag it | ☑ rebuilt |
| 4 | Full-page overlay didn't look like it animated | ☑ |
| 5 | Full-page overlays need a close action pinned above the keyboard | ☑ |
| 6 | Close-session confirm had no visible button | ☑ |
| 7 | Confirms should be bottom popups, not full-page | ☑ |
| 8 | Sheets rendered below the bottom nav | ☑ |
| 9 | Releasing a drag lost its velocity and staggered | ☑ |
| 10 | Profile avatar hid while an overlay animated | ☑ |
| 11 | Card and drawer corners should match the device radius | ☑ |
| 12 | Dragging a sheet down then back up still closed it | ☑ |

Verified: tsc clean, biome clean across 588 files, 1259 tests / 182 suites, iOS export builds.

## The sheet was rebuilt rather than patched

`@gorhom/bottom-sheet` is gone. It owned its own pan, bound to the panel and handle,
with no way to extend that to the scrim — driving its position from a scrim gesture
restarted its animation every frame, which is what stuttered and flashed. The
replacement is ~200 lines: one shared value *is* the sheet's position, one gesture spans
the whole overlay, and the drag writes straight to that value. Nothing competes for it.

That also fixed three other items for free: it measures its own content, owns the bottom
safe-area inset, and presents into the same window-level layer as the nav bar, so a
drawer sits above the bar instead of behind it.

## Why a nav tap was pushing

The bar cannot live inside the tabs navigator — it is portalled to window level so it
survives a detail screen being pushed over the tabs, and react-native-screens detaches
the view hierarchy of any stack screen below the top one, which took the bar with it.
But routing to a destination's href from outside the navigator appends a card to the
root stack. The tabs layout now registers its navigator (`components/nav/tab-switcher.ts`)
and the bar asks it to switch, so a nav tap is a tab jump again.

## Full-page versus bottom drawer

Settled deliberately: a **form** is full-page — it needs the room and the keyboard, and
now carries a pinned action row that stays above the keyboard (a Close button when it has
no actions of its own). A **confirmation** is a bottom drawer — it is a question with two
answers, presented where the thumb already is.

## Known gaps

Motion feel — the drawer's spring, the dialog's rise — can only be judged on device.
`sheet-dismissal.test.tsx` is a separate file because a completed pan animation leaves the
test renderer unable to mount another sheet in the same file; the component itself renders
correctly in isolation, which was verified directly.

## Follow-up: Hosts and Settings are roots, and a nav tap really is a tab jump

Two separate faults made them read as pushed pages.

**They declared a back action.** `host-list-screen` and the shared `SettingsScreen`
both passed `onBack={router.back}` — left over from when they were pushed — so their
headers showed a chevron instead of the profile control. `SettingsScreen` also chose its
header actions by comparing the title string to `"Settings"` / `"Admin"`. Both are now
explicit props (`root`, `actions`), so a panel keeps its chevron while the root does not.

**The tab bridge was registering the wrong navigator.** `useNavigation()` inside a layout
returns the navigation of the screen that layout is rendered in — the parent stack — so
`navigate("hosts")` appended a card rather than switching tabs. The registration now comes
from the `tabBar` slot, which is handed the tab navigator itself and keeps rendering while
a detail screen covers the tabs.
