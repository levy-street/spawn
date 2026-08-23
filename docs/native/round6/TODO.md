# Round 6 — overlay consistency, pane rows, archived drawer

From Charlie's round-6 review (2026-08-22), taken on the round-5 build.

| # | Item | Owner | Status |
|---|------|-------|--------|
| 1 | Overlay pages sometimes have rounded corners, sometimes square. Always rounded | R6-01 | ☐ |
| 2 | Pane rows: full width, transparent ground | R6-02 | ☐ |
| 3 | Pane rows: drop the file path from the subtitle | R6-02 | ☐ |
| 4 | Archived workspaces becomes a row **above the search bar**: archive icon, label, right chevron; opens an overlay page | R6-03 | ☐ |
| 5 | Row separators must run to the **left screen edge**, not stop short | R6-03 | ☐ |

## Added mid-round (navigation shell)

| # | Item | Owner | Status |
|---|------|-------|--------|
| 6 | Header still carries Hosts/Settings buttons top-right — redundant now the nav bar exists | R6-01 | ☐ |
| 7 | Switching nav destinations pushes a page on top; it should change route instantly | R6-01 | ☐ |
| 8 | Nav bar must stay visible over overlays, above everything | R6-01 | ☐ |
| 9 | Tapping a nav item closes all open overlays | R6-01 | ☐ |
| 10 | Code clean, generic, well managed and documented end to end | all | ☐ |

**Assumption on item 6:** the redundant buttons are the *destinations* — Hosts and Settings —
which the nav bar now carries. The `+` on Workspaces stays: it creates a workspace, it is not
navigation, and nothing else offers that action.
