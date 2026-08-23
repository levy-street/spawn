# Round 7 — polish pass (orchestrator, no subagents)

| # | Item | Status |
|---|------|--------|
| 1 | Archived workspaces row pins to the bottom, above the nav bar | ☑ |
| 2 | Search text still sits low — vertically centre it | ☑ |
| 3 | Icon buttons: no background change on press; dim content to 80% instead | ☑ |
| 4 | Pane rows: remove swipe-to-rename/close and their containers — those live in `...` | ☑ |
| 5 | Bottom sheets render above the nav bar | ☑ |
| 6 | Bottom sheets draggable down from the scrim above them, not only from inside | ☑ |
| 7 | Sheet menus: drop the title header | ☑ |
| 8 | Sheet menus: taller rows, bigger icons, more space between icon and label | ☑ |
| 9 | Terminal header: remove the "Connecting" badge | ☑ |
| 10 | Terminal connecting state redesigned to match the web app | ☑ |
| 11 | Hosts screen starts scrolled down on first load until tapped | ☑ |

All eleven done. Verified: tsc clean, biome clean across 581 files, 1233 tests passing.

Not committed: the working tree also carries in-flight device-trust work (7 new files plus
edits to `host-list-screen`, `connection-status`, `terminal-overlay`, the terminal transport
and onboarding). Round 7's changes are interleaved with it in three files, so landing them
separately would break HEAD. Left for the tree's owner to commit together.

`src/lib/__tests__/pairing-route-wiring.test.tsx` fails on that in-flight work:
`useDeviceHostApprovals` calls `useQuery` with no `QueryClientProvider` in that test.
Confirmed unrelated to round 7 — the suite passes with only the device-trust edit reverted.
