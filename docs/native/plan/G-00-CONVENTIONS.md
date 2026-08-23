# G-00 — Round-3 conventions and frozen primitive APIs

Read alongside `00-OVERVIEW.md`. Where they disagree, this file wins for round 3.

Research: `docs/native/research3/16-ios-native-materials.md`, `17-layout-system.md`,
`18-tabs-and-design-language.md`, `19-bugs-and-verification.md`.

## Decisions

1. **No menu of any kind.** The drawer added last round is removed. There is no burger, no tab bar.
   Navigation is a plain native stack: **Workspaces is the root**; Hosts, Legion, Settings and
   Admin are reached from the Workspaces header and from each other, with native back buttons.
2. **Native chrome by default.** Use the `react-native-screens` native-stack header and its
   automatic back button rather than custom headers, wherever a screen has an ordinary title/back
   shape (`research3/16 §TL;DR 7`).
3. **Liquid Glass, guarded.** `expo-glass-effect ~0.1.10` is installed and is bundled in Expo Go 54.
   `GlassView` must **never** be allowed to degrade into a silent plain `View`: gate every use on
   both availability functions **and** Reduce Transparency, and render an explicit `BlurView`
   fallback (`research3/16 §TL;DR 3`). Use glass for floating controls and navigation chrome only —
   content, sheets and ordinary cards use standard materials or solid semantic backgrounds
   (§TL;DR 4).
4. **SF Symbols for Apple chrome**, Lucide for spawn's brand and domain iconography
   (`expo-symbols ~1.0.8`, installed).
5. **Native sheets.** `react-native-screens ~4.16.0` supports `formSheet` with fractional detents,
   grabber, corner radius and detent events in Expo Go (`research3/16 §TL;DR 8`). Prefer it over
   custom overlays where the surface is a sheet.
6. **Bigger, not denser.** Round 2 tightened rows toward web density; the owner says everything is
   too small. Adopt the web's *proportions* with phone-appropriate *absolute* sizes, per
   `research3/17 §3`. Never below 44pt for a touch target.
7. **One screen scaffold.** Exactly one layer owns the top safe-area inset. The "empty space at the
   top" is inset double-counting (`research3/17 §1`).

## Frozen primitive APIs — wave B codes against these

```ts
// @/components/layout/screen   (owner: G-01)
export interface ScreenProps {
  children: React.ReactNode;
  scroll?: boolean;                 // wraps in a keyboard-aware scroll view
  footer?: React.ReactNode;         // pinned, tracks the keyboard, safe-area aware
  padded?: boolean;                 // applies the standard screen gutter
}
export function Screen(props: ScreenProps): React.JSX.Element;
```

```ts
// @/components/ui/footer-actions   (owner: G-02)
/** Pinned action bar. One child = full width. Two = 50/50 with the standard gap. */
export function FooterActions(props: { children: React.ReactNode }): React.JSX.Element;
```

```ts
// @/components/ui/list-row   (owner: G-02)
export interface ListRowProps {
  leading?: React.ReactNode;        // mark/avatar slot
  title: string;
  subtitle?: string;
  trailing?: React.ReactNode;       // status / chevron / actions
  onPress?: () => void;
  onLongPress?: () => void;
  height?: "regular" | "tall";      // regular = 64pt, tall = 76pt (see research3/17)
}
export function ListRow(props: ListRowProps): React.JSX.Element;
```

```tsx
// @/components/ui/glass   (owner: G-03)
/** Liquid Glass when genuinely available, explicit BlurView otherwise. Never a bare View. */
export function GlassSurface(props: {
  children: React.ReactNode;
  intensity?: "chrome" | "thin" | "ultraThin";
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element;
export function isGlassAvailable(): boolean;
```

```tsx
// @/components/ui/native-popover   (owner: G-03)
/** Wide anchored popover on a guarded glass surface. Min width 260pt, 44pt rows. */
export function NativePopover(props: {
  visible: boolean;
  onDismiss: () => void;
  anchor: { x: number; y: number; width: number; height: number };
  items: Array<{
    key: string; label: string; icon?: string;
    destructive?: boolean; disabled?: boolean; onPress: () => void;
  }>;
}): React.JSX.Element;
```

## Standing rules

All of `00-OVERVIEW.md §5` still applies: no git, no dependency installs (glass, symbols and
drawer-removal are handled by the orchestrator), no running the app, path ownership is absolute,
tokens for every value, tests for logic you own.
