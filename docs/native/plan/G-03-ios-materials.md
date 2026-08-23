# G-03 — Liquid Glass, SF Symbols, native sheets and popovers

**Wave A, parallel with three other agents.** Read `G-00-CONVENTIONS.md`, then
`research3/16-ios-native-materials.md` in full — its closing capability table is your spec.

## 1. What the owner asked for

> "its also not using apple native components for liquid glass, we should be using liquid glass
> wherever we can like a proper nice app"

## 2. Files you own

```
mobile/src/components/ui/glass.tsx             # new: GlassSurface + isGlassAvailable
mobile/src/components/ui/native-popover.tsx    # new
mobile/src/components/ui/sheet.tsx             # convert to native formSheet where appropriate
mobile/src/components/ui/menu.tsx
mobile/src/components/ui/action-sheet.tsx
mobile/src/components/ui/icon.tsx              # add SF Symbols path
```

## 3. Liquid Glass — guarded, never silent

`expo-glass-effect ~0.1.10` is installed and is the SDK 54 release bundled in Expo Go 54. **Do not
upgrade it** — the registry's current `57.0.1` is for SDK 57 and must not be installed here.

Ship `GlassSurface` to the frozen `G-00` API. The critical requirement from
`research3/16 §TL;DR 3`: **never let `GlassView` become a silent plain `View`.** Gate on both
availability functions **and** Reduce Transparency, and render an explicit `BlurView` fallback
(`expo-blur`, installed). `isGlassAvailable()` exposes the result so callers can adapt.

Use it **sparingly** (§TL;DR 4): floating controls and navigation chrome only. Content, sheets and
ordinary cards keep standard materials or solid semantic backgrounds. Do not glass everything.

## 4. Native popover — replaces the terminal's cramped dropdown

`research3/16 §TL;DR 5`: there is no safe generic single-tap native `UIMenu`/popover in Expo Go 54 —
`@react-native-menu/menu`, `react-native-ios-context-menu` and Zeego all need unbundled native code.

So build `NativePopover` to the frozen API: a **wide** anchored popover on a guarded glass surface.
Minimum width **260pt**, **44pt** rows, HIG-derived padding, separators and destructive-item
treatment (`research3/16 §3` cites the HIG). The owner's complaint was that the current dropdown
"isnt wide enough" — the minimum width is not optional.

Also expose `ActionSheetIOS` through `action-sheet.tsx` for short command lists where a bottom
sheet is acceptable (§TL;DR 6), and Expo Router's native `Link.Menu` for long-pressed navigational
links.

## 5. Native sheets

`react-native-screens ~4.16.0` supports native `formSheet` with fractional detents, grabber, corner
radius and detent events in Expo Go (§TL;DR 8). Convert `sheet.tsx` to present natively where the
surface is genuinely a sheet, keeping the existing API so callers do not change. Where a caller
needs behaviour the native sheet cannot express, keep the custom path and say which in your report.

## 6. SF Symbols

`expo-symbols ~1.0.8` is installed and bundled. Extend `icon.tsx` with an SF Symbols path for
**Apple chrome** — navigation, menus, headers — while brand and domain iconography stays Lucide
(`G-00 §Decisions 4`). Do not swap spawn's agent/brand marks.

## 7. Tests
- `GlassSurface` renders `GlassView` when available and `BlurView` when not, and **never** a bare
  `View` (assert all three branches with mocks, including Reduce Transparency on).
- `NativePopover` enforces the 260pt minimum width and 44pt rows; destructive and disabled items
  render correctly; dismiss fires.
- `Sheet` still satisfies its existing tests after the native conversion.
- `Icon` resolves an SF Symbol name on the chrome path and a Lucide name on the brand path.

## 8. Deliverables
- [ ] `GlassSurface` + `isGlassAvailable`, guarded, with explicit fallback
- [ ] `NativePopover` at ≥260pt with 44pt rows
- [ ] Native `formSheet` presentation where appropriate
- [ ] SF Symbols for chrome, Lucide retained for brand
- [ ] `typecheck`, `lint`, `test` clean for your files
- [ ] Progress `docs/native/progress/G-03.md`; report `docs/native/reports/G-03.md`
