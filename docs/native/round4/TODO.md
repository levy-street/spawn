# Round 4 — UI standardisation and defect sweep

Every item comes from Charlie's round-4 review (2026-08-22). Owner is the agent that
carries it; nothing here is closed until the verification pass has looked at it.

## A. Global chrome — the root cause of six of these items

| # | Item | Owner | Status |
|---|------|-------|--------|
| A1 | Header action icons sit off-centre in their pill (screenshot 1) | R4-01 | ☐ |
| A2 | Remove **all** Liquid Glass — header pills, overlay back buttons, popovers, menus, dialogs. Standard app UI only | R4-01 / R4-02 | ☐ |
| A3 | Kill the duplicated in-body header on Hosts, Legion, Settings, Templates, Agents — one header per screen | R4-01 + consumers | ☐ |
| A4 | Remove the dead space above those second headers (native header + safe area + in-body header stacked) | R4-01 | ☐ |
| A5 | Overlay/pushed pages must carry their header content with the drag, not leave it pinned | R4-01 | ☐ |
| A6 | One global `AppHeader`; every screen uses it; native stack header switched off | R4-01 | ☐ |

## B. Global primitives

| # | Item | Owner | Status |
|---|------|-------|--------|
| B1 | Empty states need a bordered container — applied globally, not per screen | R4-02 | ☐ |
| B2 | List rows full-bleed with separators between them | R4-02 | ☐ |
| B3 | Delete `GlassSurface`; dialog/menu/popover fall back to solid themed surfaces | R4-02 | ☐ |

## C. Screens

| # | Item | Owner | Status |
|---|------|-------|--------|
| C1 | Workspace rows: full width, separators between them (screenshot 2) | R4-03 | ☐ |
| C2 | Workspace search field moves to the **bottom** of the screen (screenshot 3) | R4-03 | ☐ |
| C3 | Hosts: drop the second "Hosts" header and its dead space (screenshot 4) | R4-04 | ☐ |
| C4 | Legion: drop the second header and its dead space (screenshot 10) | R4-04 | ☐ |
| C5 | Account: keyboard opens on entry for no reason (screenshot 5) | R4-05 | ☐ |
| C6 | Agents: no yolo-mode labels on the switches (screenshot 6) | R4-05 | ☐ |
| C7 | Agents: custom-agent empty state needs a container (screenshot 6) | R4-05 | ☐ |
| C8 | Templates: empty state needs a border (screenshot 8) | R4-05 | ☐ |
| C9 | Device pairing: white bands top and bottom; no back button (screenshot 7) | R4-06 | ☐ |
| C10 | Workspace tabs: rebuild to web parity — connected tab flares into the panel below (screenshot 9) | R4-07 | ☐ |
| C11 | Workspace `+` does nothing | R4-07 | ☐ |
| C12 | Workspace `...` does nothing | R4-07 | ☐ |
| C13 | Terminal overlay: standard back button, header travels with the dismiss drag | R4-08 | ☐ |

## D. Standing requirement

Everything above uses shared global components and shared tokens. No screen-local
re-implementation of a header, a row, an empty state, or a separator. Styling aligns
with `web/`.
