# Round 8 — spacing, sheet ergonomics, and a navigation rework

| # | Item | Status |
|---|------|--------|
| 1 | Too much space below the archived workspaces row | ☐ |
| 2 | Sheet action rows taller | ☐ |
| 3 | Sheets must account for the bottom safe area | ☐ |
| 4 | Scrim drag should track the finger continuously, not only fire on a flick | ☐ |
| 5 | Back from an overlay sometimes lands on an unrelated route | ☐ |
| 6 | Overlays sometimes animate in/out, sometimes not | ☐ |
| 7 | The app sometimes pushes itself in from the right, over itself | ☐ |
| 8 | Navigation generalised and clean end to end | ☐ |
| 9 | Row separators cleared the left edge but ran into the right | ☑ |

## 9 — Row separators cleared the left edge but ran into the right

`ListSeparator` took an `inset` prop that applied `marginLeft` with no matching
right-hand offset, and it defaulted to on. Every list that spelled out
`inset={false}` looked right; the pane list, which took the default, drew each
divider starting 16pt in from the left and running to the physical screen edge.

The prop is gone — the separator now always runs edge to edge — along with the
`listRow.separatorInset` / `separatorFullBleed` tokens and the wrapper
components whose only job was to pass `inset={false}`.

`tests/__tests__/divider-symmetry.test.ts` keeps it from coming back: it
resolves every style composition in `src/` back into one object and fails on any
divider that is pushed off one horizontal edge but not the other. It catches the
inline-override shape that hid the original bug, where the offset sat in a
different object from the hairline it moved.
