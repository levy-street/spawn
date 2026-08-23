# R01 — Design system and exact theme extraction

## TL;DR

- The executable source of truth is `web/src/app/globals.css`; where `docs/DESIGN.md` differs, this report follows CSS.
- Light is a near-white neutral stack (`background #FAFAFA`); dark is a near-black neutral stack (`background #030303`) with chroma reserved for brand and status.
- Ship semantic light/dark objects, not Tailwind in React Native; the complete copy-ready objects are at the end of this report.
- App UI uses the iOS/system sans stack; terminals use a 13px system-monospace stack at `lineHeight: 1.2`; marketing/auth additionally use IBM Plex Sans and Rowdies.
- The spacing unit is 4px; core radii are 6/8/10px (`sm`/`md`/`lg`), with 12/16px overlays and pills at 9999px.
- Default UI transitions are 150ms with `cubic-bezier(0.4,0,0.2,1)`; shell geometry uses 200ms and `cubic-bezier(0.32,0.72,0,1)`.
- Dialog/menu motion is fade plus 95% scale; drawer/sheet motion is a 220ms translation; there are no springs anywhere in the web implementation.
- Every app glyph comes from Lucide except the spawnd brand art and five inline agent marks; the web lock pins `lucide-react@1.14.0`.
- Theme preference is `light | dark | system`, defaults to system, persists as `spawn.theme`, and updates live with OS appearance changes.
- Expo Go is compatible with the proposed token/font/icon layer: use bundled font assets and Expo-supported `lucide-react-native`/`react-native-svg`; do not add a custom native module.

## Scope, authority, and important drift

This report read the only stylesheet under `web/src` (`globals.css`), every file under `web/src/components/ui`, the theme/font/layout helpers, terminal configuration, both icon components, the brand component, and all public assets. Tailwind is loaded through the v4 PostCSS plugin and `tw-animate-css`; there is no Tailwind config file and no second CSS token source (`web/postcss.config.mjs:1`, `web/src/app/globals.css:1`).

Source precedence for native implementation:

1. Executable declarations in `web/src/app/globals.css` and component classes.
2. Runtime code in `web/src/lib/theme.ts`, `theme-bootstrap.ts`, `viewport.ts`, and component styles.
3. `docs/DESIGN.md` only when it agrees with executable source.

Known documentation/code drift that must not leak into mobile:

- `docs/DESIGN.md` calls `--row-h` 2.25rem/36px, but current CSS is **2.5rem/40px** (`docs/DESIGN.md:117`, `web/src/app/globals.css:339`).
- `docs/DESIGN.md` describes older OKLCH brand-accent declarations; current CSS uses exact brand hex values: light `#E11E15`, dark `#FF453A` (`docs/DESIGN.md:69`, `web/src/app/globals.css:323`, `web/src/app/globals.css:400`).
- The browser `<meta name="theme-color">` dark value is `#070707`, while the rendered dark background `oklch(0.10 0 0)` resolves to `#030303`; CSS is the surface authority (`web/src/lib/theme.ts:18`, `web/src/app/globals.css:359`).
- The CSS comment still says the light wordmark ink clears 4.5:1; preserve the value, not the stale rationale (`web/src/app/globals.css:318`).

**RECOMMEND:** Treat the literal TypeScript objects in “Native token module shape” as mobile’s only style source. This prevents prose drift and makes theme values atomically swappable.

## Color conversion method

React Native colors are expressed below as sRGB hex/rgba. The raw CSS declaration remains authoritative. Conversion used the CSS Color 4 OKLab matrices:

```text
a = C cos(h)                         b = C sin(h)
l' = L + 0.3963377774a + 0.2158037573b
m' = L - 0.1055613458a - 0.0638541728b
s' = L - 0.0894841775a - 1.2914855480b
l = l'^3; m = m'^3; s = s'^3
Rlin =  4.0767416621l - 3.3077115913m + 0.2309699292s
Glin = -1.2684380046l + 2.6097574011m - 0.3413193965s
Blin = -0.0041960863l - 0.7034186147m + 1.7076147010s
sRGB(c) = c <= .0031308 ? 12.92c : 1.055c^(1/2.4) - .055
```

Channels outside sRGB are clipped only in the reported fallback. Preserve raw OKLCH wherever a future RN renderer supports it; clipped tokens are marked `†`.

Spot checks:

- Light background `oklch(.985 0 0)`: `a=b=0`; linear RGB is `.985³=.955671625`; companded channel `.98025598 × 255 = 249.965`, therefore `#FAFAFA`.
- Light primary `oklch(.2 0 0)`: linear RGB `.008`; companded channel `.0861042 × 255 = 21.956`, therefore `#161616`.
- Light destructive `oklch(.53 .2 25)`: `a=.18126156`, `b=.08452365`; linear RGB `[.56010488,.01200775,.02127265]`; companded bytes `[197,29,40]`, therefore `#C51D28`.
- Light success `oklch(.52 .13 152)`: linear RGB `[.00659322,.20610710,.05295800]`; companded bytes `[19,125,65]`, therefore `#137D41`.

The raw declarations are at `web/src/app/globals.css:272` and `web/src/app/globals.css:356`.

## Tailwind alias layer

The `@theme inline` block does not hold values. It aliases Tailwind utility names to runtime CSS custom properties, so `bg-background` remains `var(--background)` rather than freezing one theme at build time (`web/src/app/globals.css:11`). The complete alias families are:

```css
--color-background: var(--background);
--color-foreground: var(--foreground);
--color-muted: var(--muted);
--color-muted-foreground: var(--muted-foreground);
--color-card: var(--card);
--color-card-foreground: var(--card-foreground);
--color-popover: var(--popover);
--color-popover-foreground: var(--popover-foreground);
--color-popover-border: var(--popover-border);
--color-popover-accent: var(--popover-accent);
--color-primary: var(--primary);
--color-primary-foreground: var(--primary-foreground);
--color-secondary: var(--secondary);
--color-secondary-foreground: var(--secondary-foreground);
--color-accent: var(--accent);
--color-accent-foreground: var(--accent-foreground);
--color-destructive: var(--destructive);
--color-destructive-foreground: var(--destructive-foreground);
--color-destructive-soft: var(--destructive-soft);
--color-success: var(--success);
--color-success-soft: var(--success-soft);
--color-warning: var(--warning);
--color-warning-soft: var(--warning-soft);
--color-info: var(--info);
--color-info-soft: var(--info-soft);
--color-code-comment: var(--code-comment);
--color-code-string: var(--code-string);
--color-code-keyword: var(--code-keyword);
--color-code-number: var(--code-number);
--color-code-punct: var(--code-punct);
--color-tone-active: var(--tone-active);
--color-tone-waiting: var(--tone-waiting);
--color-tone-idle: var(--tone-idle);
--color-tone-offline: var(--tone-offline);
--color-border: var(--border);
--color-pane-divider: var(--pane-divider);
--color-input: var(--input);
--color-ring: var(--ring);
--color-terminal-bg: var(--terminal-bg);
--color-shell: var(--shell);
--color-brand-bg: var(--brand-bg);
--color-brand-panel: var(--brand-panel);
--color-brand-well: var(--brand-well);
--color-brand-hairline: var(--brand-hairline);
--color-brand-accent: var(--brand-accent);
--color-brand-accent-soft: var(--brand-accent-soft);
```

This is a direct transcription of `web/src/app/globals.css:19-87`. There are **no chart tokens**, **no sidebar color family**, and no `danger` alias. Sidebar uses `shell`, `background`, `card`, and ordinary semantic colors; destructive is the only danger name (`web/src/app/globals.css:40`, `docs/DESIGN.md:35`).

## Complete semantic palette: raw and resolved

Soft tokens are the same RGB as their base with the declared alpha. `ring` resolves to `foreground` in both app themes. “Use” is the semantic contract, not an invitation to substitute a visually similar token.

| Token | Light raw → sRGB | Dark raw → sRGB | Where used |
|---|---|---|---|
| `background` | `oklch(.985 0 0)` → `#FAFAFA` | `oklch(.10 0 0)` → `#030303` | Root app/content canvas, dialog ground, full-screen overlays, focused panes |
| `foreground` | `oklch(.17 0 0)` → `#0F0F0F` | `oklch(.97 0 0)` → `#F5F5F5` | Default text/icons; neutral focus ring source |
| `muted` | `oklch(.955 0 0)` → `#F0F0F0` | `oklch(.21 0 0)` → `#181818` | Subdued wells, skeletons, unchecked switch |
| `mutedForeground` | `oklch(.47 0 0)` → `#5B5B5B` | `oklch(.71 0 0)` → `#A1A1A1` | Secondary text, placeholders, quiet icons |
| `card` | `oklch(1 0 0)` → `#FFFFFF` | `oklch(.16 0 0)` → `#0D0D0D` | Cards, pane headers, grouped content |
| `cardForeground` | `oklch(.17 0 0)` → `#0F0F0F` | `oklch(.97 0 0)` → `#F5F5F5` | Text on cards |
| `popover` | `oklch(1 0 0)` → `#FFFFFF` | `oklch(.235 0 0)` → `#1E1E1E` | Menus, sheets, toasts, floating terminal controls |
| `popoverForeground` | `oklch(.17 0 0)` → `#0F0F0F` | `oklch(.97 0 0)` → `#F5F5F5` | Text/icons on popovers |
| `popoverBorder` | `oklch(.88 0 0)` → `#D7D7D7` | `oklch(.31 0 0)` → `#303030` | Lifted-surface hairlines |
| `popoverAccent` | `oklch(.94 0 0)` → `#EBEBEB` | `oklch(.30 0 0)` → `#2E2E2E` | Menu-row hover/focus fill |
| `primary` | `oklch(.20 0 0)` → `#161616` | `oklch(.97 0 0)` → `#F5F5F5` | Primary buttons, checked switch track |
| `primaryForeground` | `oklch(.985 0 0)` → `#FAFAFA` | `oklch(.13 0 0)` → `#070707` | Content on primary controls |
| `secondary` | `oklch(.95 0 0)` → `#EEEEEE` | `oklch(.24 0 0)` → `#1F1F1F` | Secondary button/badge fills |
| `secondaryForeground` | `oklch(.20 0 0)` → `#161616` | `oklch(.97 0 0)` → `#F5F5F5` | Content on secondary fills |
| `accent` | `oklch(.93 0 0)` → `#E8E8E8` | `oklch(.27 0 0)` → `#262626` | General hover/selected neutral fill |
| `accentForeground` | `oklch(.17 0 0)` → `#0F0F0F` | `oklch(.97 0 0)` → `#F5F5F5` | Text over accent fill |
| `destructive` | `oklch(.53 .2 25)` → `#C51D28` | `oklch(.62 .21 25)` → `#EA3C3F` | Delete/stop/error actions and text |
| `destructiveForeground` | `oklch(.99 0 0)` → `#FCFCFC` | `oklch(.97 0 0)` → `#F5F5F5` | Content on destructive button |
| `destructiveSoft` | same / `.10` → `rgba(197,29,40,.10)` | same / `.14` → `rgba(234,60,63,.14)` | Destructive badges/callouts |
| `success` | `oklch(.52 .13 152)` → `#137D41` | `oklch(.74 .15 152)` → `#54C57A` | Positive text/icons/borders |
| `successSoft` | same / `.12` → `rgba(19,125,65,.12)` | same / `.14` → `rgba(84,197,122,.14)` | Success badges/callouts |
| `warning` | `oklch(.55 .13 75)` → `#9D6400†` | `oklch(.78 .14 80)` → `#E6AC3D` | Attention/waiting text/icons/borders |
| `warningSoft` | same / `.14` → `rgba(157,100,0,.14)†` | same / `.14` → `rgba(230,172,61,.14)` | Warning badges/callouts |
| `info` | `oklch(.52 .11 240)` → `#1870A1` | `oklch(.72 .12 235)` → `#4CB0E5` | Informational accents, folder icons |
| `infoSoft` | same / `.12` → `rgba(24,112,161,.12)` | same / `.14` → `rgba(76,176,229,.14)` | Info badges/callouts |
| `codeComment` | `oklch(.55 .02 260)` → `#6B727E` | `oklch(.62 .02 260)` → `#7F8793` | Rendered-code comments |
| `codeString` | `oklch(.48 .12 150)` → `#197037` | `oklch(.78 .13 150)` → `#76CF8A` | Rendered-code strings |
| `codeKeyword` | `oklch(.50 .16 305)` → `#7945AB` | `oklch(.76 .14 305)` → `#C699F8` | Rendered-code keywords/tags |
| `codeNumber` | `oklch(.52 .13 60)` → `#9D5300†` | `oklch(.80 .12 70)` → `#EFB062` | Numbers/markup attributes |
| `codePunct` | `oklch(.55 .02 260)` → `#6B727E` | `oklch(.66 .02 260)` → `#8B939F` | Code punctuation |
| `toneActive` | `oklch(.60 .16 152)` → `#009A4D†` | `oklch(.74 .17 152)` → `#3EC873` | 8px “producing output/online” dot |
| `toneWaiting` | `oklch(.60 .13 240)` → `#1A89C5` | `oklch(.72 .13 235)` → `#3FB1EA` | 8px waiting/starting dot |
| `toneIdle` | `oklch(.60 0 0)` → `#808080` | `oklch(.68 0 0)` → `#989898` | Running but quiet dot |
| `toneOffline` | `oklch(.78 0 0)` → `#B7B7B7` | `oklch(.44 0 0)` → `#525252` | Exited/offline dot |
| `border` | `oklch(.90 0 0)` → `#DEDEDE` | `oklch(.27 0 0)` → `#262626` | Standard 1px hairlines |
| `paneDivider` | `oklch(.84 0 0)` → `#CACACA` | `oklch(.38 0 0)` → `#424242` | Pane seams, one step brighter than border |
| `input` | `oklch(.90 0 0)` → `#DEDEDE` | `oklch(.27 0 0)` → `#262626` | Input/textarea border |
| `ring` | `var(--foreground)` → `#0F0F0F` | `var(--foreground)` → `#F5F5F5` | Focus indication; deliberately neutral |
| `shell` | `oklch(.945 0 0)` → `#EDEDED` | `oklch(.20 0 0)` → `#161616` | Sidebar, app frame, tab strip, pane gutters |
| `terminalBg` | `oklch(.99 0 0)` → `#FCFCFC` | `oklch(.145 0 0)` → `#0A0A0A` | Terminal/pane backing ground |
| `brandBg` | `oklch(.97 0 0)` → `#F5F5F5` | `oklch(.115 0 0)` → `#050505` | Theme-aware public-brand ground |
| `brandPanel` | `oklch(1 0 0)` → `#FFFFFF` | `oklch(.15 0 0)` → `#0B0B0B` | Theme-aware brand panel |
| `brandWell` | `oklch(.94 0 0)` → `#EBEBEB` | `oklch(.08 0 0)` → `#020202` | Theme-aware brand inset/well |
| `brandHairline` | `oklch(.88 0 0)` → `#D7D7D7` | `oklch(.29 0 0)` → `#2B2B2B` | Theme-aware brand rules |
| `brandAccent` | `#E11E15` | `#FF453A` | spawnd identity, launcher plus, app selection |
| `brandAccentSoft` | `rgba(225,30,21,.12)` | `rgba(255,69,58,.14)` | Low-emphasis brand tint |

Declarations and palette intent: `web/src/app/globals.css:275-332`, `web/src/app/globals.css:359-409`. Badge recipes prove the status fill/border/text usage (`web/src/components/ui/badge.tsx:4`). Status-dot mapping is exact and exhaustive (`web/src/components/ui/status.tsx:5`).

### Fixed pressroom/marketing primitives

These values never theme-swap (`web/src/app/globals.css:89-123`):

| Token | Literal | Meaning/use |
|---|---:|---|
| `void` | `#000000` | Marketing paper/background |
| `char` | `#120F0E` | Dark panel |
| `panelg` | `#191514` | Raised/inset dark panel |
| `lineG` | `rgba(242,237,226,.13)` | Fine rule |
| `lineStrong` | `rgba(242,237,226,.26)` | Strong rule/input border |
| `bone` | `#F2EDE2` | Primary warm foreground/CTA ground |
| `ash` | `#A39A8C` | Muted warm foreground |
| `hellfire` | `#E11E15` | Canonical logo ink |
| `plate` | `#EA2A1B` | Slightly lighter red flood coat for black text |
| `blood` | `#7C100B` | Deep red |
| `ember` | `#FF453A` | Accessible small red text/dark-theme accent |

`.grimoire` remaps shared primitives instead of defining a second component set (`web/src/app/globals.css:130-183`):

| Semantic | Grimoire resolved value |
|---|---|
| background / foreground | `#000000` / `#F2EDE2` |
| muted / mutedForeground | `#191514` / `#A39A8C` |
| card / cardForeground | `#120F0E` / `#F2EDE2` |
| popover / popoverForeground | `#191514` / `#F2EDE2` |
| popoverBorder / popoverAccent | `rgba(242,237,226,.26)` / `rgba(242,237,226,.10)` |
| primary / primaryForeground | `#F2EDE2` / `#000000` |
| secondary / secondaryForeground | `rgba(242,237,226,.05)` / `#F2EDE2` |
| accent / accentForeground | `rgba(242,237,226,.12)` / `#F2EDE2` |
| destructive / destructiveForeground / destructiveSoft | `#FF453A` / `#000000` / `rgba(255,69,58,.14)` |
| success / successSoft | `#FF453A` / `rgba(255,69,58,.12)` |
| warning / warningSoft | `#FF453A` / `rgba(255,69,58,.12)` |
| info / infoSoft | `#A39A8C` / `rgba(163,154,140,.14)` |
| toneActive / toneWaiting / toneIdle / toneOffline | `#FF453A` / `#A39A8C` / `#A39A8C` / `rgba(242,237,226,.26)` |
| border / paneDivider / input / ring | `rgba(242,237,226,.13)` / `rgba(242,237,226,.26)` / `rgba(242,237,226,.26)` / `#FF453A` |
| brandAccent / brandAccentSoft | `#FF453A` / `rgba(255,69,58,.14)` |

Grimoire does not override code colors, `shell`, `terminalBg`, or the brand surface stack. Those inherit the active root theme if ever used inside `.grimoire`; no current marketing primitive relies on those inherited values.

### Runtime-computed colors and variables

- `--tab-surface` is selected-tab figure/ground. A plain/empty selected tab is `background`: `#FAFAFA` light, `#030303` dark. A connected focused header mixes 75% card + 25% background in OKLab: `#FEFEFE` light, `#0A0A0A` dark. A dimmed connected header then mixes 3.5% foreground into that result in light (`#F4F4F4`) or 25% black in dark (`#040404`) (`web/src/components/workspace/workspace-tabs.tsx:918-924`).
- Connected selected tabs add 6×6px bottom-corner patches immediately outside the tab (`left/right:-6px`) filled with `tabSurface`; a 6px radial mask cuts each into a concave join with the content panel (`web/src/app/globals.css:523-548`). Native can reproduce this with two 6px corner views/masks or an equivalent rounded vector path.
- `--vv-height` defaults to `100dvh`; when the keyboard covers at least 1px and zoom is ≤1.01, runtime sets it to `min(visualViewport.height, innerHeight)px`. `--vv-keyboard = max(0, innerHeight - height - visualViewport.offsetTop)px`; pinch zoom removes the height override (`web/src/lib/viewport.ts:28-65`).
- `--safe-top/bottom/left/right` are `env(safe-area-inset-*,0px)` on web. Native must read `react-native-safe-area-context` insets, not parse these strings (`web/src/app/globals.css:350-353`). Registry latest was `react-native-safe-area-context@5.9.1` on 2026-08-22; install the Expo-SDK-compatible version with `npx expo install`. It works in Expo Go.
- `--content-inset` is 0 by default and 8px at the shell’s `md` container breakpoint (`web/src/app/globals.css:345`, `web/src/components/nav/AppShell.tsx:259`). Mobile remains 0.
- Folder picker sets `--picker-column:224px`; two columns plus 26px chrome yield a preferred `474×440px` panel (`web/src/components/workspace/folder-picker.tsx:36-51`).
- Grid tile variables are percentages of a 24×24 logical grid: `left=x/24`, `top=y/24`, `width=w/24`, `height=h/24`; only the actively resized tile receives pixel `--preview-width/height` (`web/src/lib/grid.ts:31`, `web/src/components/workspace/workspace-grid.tsx:187-210`).
- `--channel-drift-to` is `8px` normally and `-8px` for the reverse half of the connecting channel (`web/src/app/globals.css:607-627`).

## Geometry and spacing

Tailwind’s spacing unit is `0.25rem = 4px` (`web/node_modules/tailwindcss/theme.css:325`). The following values are all spacing steps actually used under `web/src`; native should expose them because feature plans will encounter all of them:

| Key | px | Key | px | Key | px |
|---:|---:|---:|---:|---:|---:|
| `0` | 0 | `px` | 1 | `0.5` | 2 |
| `1` | 4 | `1.5` | 6 | `2` | 8 |
| `2.5` | 10 | `3` | 12 | `3.5` | 14 |
| `4` | 16 | `5` | 20 | `6` | 24 |
| `6.5` | 26 | `7` | 28 | `8` | 32 |
| `9` | 36 | `10` | 40 | `11` | 44 |
| `12` | 48 | `14` | 56 | `16` | 64 |
| `20` | 80 | `24` | 96 | `32` | 128 |

Arbitrary spacing in use: 3px gaps, 15px vertical CTA padding, half-pane-gap padding (`3px` today), and safe-area-derived margins/paddings (`web/src/components/brand/press.tsx:28`, `web/src/components/workspace/workspace-grid.tsx:1755`, `web/src/app/globals.css:642-659`).

Theme-invariant chrome geometry (`web/src/app/globals.css:334-353`):

| Token | Literal | Native meaning |
|---|---:|---|
| `sidebarWidth` | 264px | Expanded desktop sidebar / drawer cap |
| `sidebarRailWidth` | 56px | Collapsed desktop rail |
| `rowHeight` | 40px | Sidebar/nav/list rhythm |
| `paneGap` | 6px | Narrow stacked-pane gutter |
| `contentInset` | 0px mobile; 8px desktop shell | Floating content-panel gap |
| `visualViewportHeight` | `100dvh` or keyboard measurement | Use window minus keyboard |
| `keyboardInset` | 0px or computed | Overlay lift above software keyboard |

Minimum touch targets are 44px. This is explicit for coarse-pointer controls and sheet cascade rows (`docs/DESIGN.md:254`, `web/src/components/ui/cascade-menu.tsx:382`).

## Radii, borders, shadows, blur, opacity, and layering

### Radii

The app overrides three Tailwind defaults (`web/src/app/globals.css:89-92`):

| Utility/token | Literal | Typical surface |
|---|---:|---|
| `rounded` | 4px | Small file controls/raw utility default |
| `radiusSm` / `rounded-sm` | 6px | Tiny actions, badge focusable child |
| `radiusMd` / `rounded-md` | 8px | Buttons, inputs, menu rows |
| `radiusLg` / `rounded-lg` | 10px | Cards, menus, toasts, sidebar rows |
| `rounded-xl` | 12px | Dialogs, icon plates, connection mark |
| `rounded-2xl` | 16px | Bottom-sheet top corners, launcher FAB |
| `rounded-full` | 9999px conceptually | Pills, status dots, switch track |
| explicit | 2px, 4px, 6px | Legion mini-visualizations |

`.pressroom` overrides `radiusMd` and `radiusLg` to 6px, leaving `sm` at 6px, so all shared auth controls become consistently 6px (`web/src/app/globals.css:197-200`).

### Borders and focus rings

- Default `border` is 1px solid; explicit 2px is used for dashed drop/drag/focus targets, 4px only for a marketing/illustration edge. Standard color is `border`; lifted menus use `popoverBorder`; pane seams use `paneDivider` (`web/src/components/ui/card.tsx:9`, `web/src/components/ui/dropdown-menu.tsx:199`, `web/src/components/workspace/workspace-grid.tsx:1585`).
- Button/input/textarea focus is no outline plus a 1px `ring` with no offset (`web/src/components/ui/button.tsx:12`, `web/src/components/ui/input.tsx:15`).
- Switch focus is a 2px ring plus 1px background-colored offset (`web/src/components/ui/switch.tsx:35-38`).
- Appearance radio cards use a 2px `ring` on `focus-within`; selected cards also switch border to `ring` (`web/src/components/settings/AppearancePanel.tsx:47-51`).
- Pressroom quiet buttons use a 1px `lineStrong` border; hover raises border to bone and fills bone at 8%; disabled uses `lineG`, ash text, transparent fill, opacity 1 (`web/src/app/globals.css:220-235`).

### Shadows

Tailwind v4 values used by the app (`web/node_modules/tailwindcss/theme.css:406-412`):

```ts
shadowSm = "0 1px 3px 0 rgb(0 0 0 / .10), 0 1px 2px -1px rgb(0 0 0 / .10)";
shadowMd = "0 4px 6px -1px rgb(0 0 0 / .10), 0 2px 4px -2px rgb(0 0 0 / .10)";
shadowLg = "0 10px 15px -3px rgb(0 0 0 / .10), 0 4px 6px -4px rgb(0 0 0 / .10)";
shadowXl = "0 20px 25px -5px rgb(0 0 0 / .10), 0 8px 10px -6px rgb(0 0 0 / .10)";
shadow2xl = "0 25px 50px -12px rgb(0 0 0 / .25)";
```

Uses: `sm` on cards, switch thumb, agent plates, grid-ghost label; `md` on rail tooltip; `lg` on toast, launcher, terminal floaters; `xl` plus black/50 on menus/popovers; `2xl` on dialogs/drawer/sheet/folder picker. Dialogs tint 2xl black at 20% light / 50% dark. The connecting success lock adds `0 0 20px -8px success` (`web/src/components/ui/dialog.tsx:30-60`, `web/src/components/terminal/ConnectingOverlay.tsx:225-229`).

The only text shadow is `0 1px 2px rgba(0,0,0,.60)` on the tiny white labels inside Legion progress bars (`web/src/components/legion/legion-parts.tsx:78-85`).

React Native iOS cannot reproduce multi-layer CSS shadows with a single legacy `shadow*` tuple. **RECOMMEND:** on modern RN use the `boxShadow` style string above where supported; otherwise use the first lobe only and reserve exact multi-lobe parity for the New Architecture baseline. This is JS styling and Expo Go compatible.

### Blur/backdrop

- Bare `backdrop-blur` = 8px; `sm` = 8px; `md` = 12px under Tailwind v4 (`web/node_modules/tailwindcss/theme.css:476-482`).
- Dialog and exited-pane scrims use 2px; drag/drop terminal overlays use 1px; sticky chrome/terminal floaters use 8px; masthead uses 12px (`web/src/components/ui/dialog.tsx:81`, `web/src/components/terminal/Terminal.tsx:3265`, `web/src/components/brand/press.tsx:131`).
- RN `BlurView` is provided by `expo-blur` in Expo Go. Registry latest was `expo-blur@57.0.2` on 2026-08-22; use `npx expo install expo-blur` so the installed version matches the chosen Expo SDK. **RECOMMEND:** use it only for these explicit surfaces; ordinary popovers are opaque and should not gain blur.

### Opacity

Direct element-opacity states are 0%, 45%, 50%, 60%, 70%, 90%, and 100%. Disabled controls generally use 50%; disabled switch rows use 60%; active status ping uses 60%; skeleton fill is muted at 70% (`web/src/components/ui/button.tsx:12`, `web/src/components/ui/switch.tsx:82-84`, `web/src/components/ui/status.tsx:43-47`, `web/src/components/ui/skeleton.tsx:4`).

Color-modifier alpha levels actually used are 5%, 8%, 10%, 12%, 13%, 14%, 15%, 20%, 25%, 26%, 30%, 35%, 40%, 45%, 50%, 55%, 60%, 70%, 75%, 80%, 85%, 90%, and 95%. These modify the named semantic/pressroom color, not the whole subtree. Marketing image scrims also use exact black gradient stops `.62`, `.82`, `.86`, `.88`, `.90`, `.94`, `.96`, and `.98` (`web/src/app/page.tsx:465`, `web/src/app/download/page.tsx:128`, `web/src/components/onboarding/auth-shell.tsx:71`).

### Z-index contract

| z | Ownership |
|---:|---|
| -10 | Decorative auth artwork behind content |
| 0 | Workspace openings/background |
| 5 | Terminal predictive-echo overlay |
| 6 | Terminal connecting overlay |
| 10 | Pane tiles, dragged tabs/rows, file-row foreground |
| 20 | Exited/drag overlays, sidebar resize grip |
| 30 | Mobile header, modifier bar, terminal upload/latest controls |
| 40 | Masthead, launcher FAB, workspace dividers, terminal warning stack |
| 50 | Modal/dialog/drawer/sheet roots and grid ghost |
| 60 | Rail tooltip |
| 90 | Preview popover (above dialogs, below menus) |
| 100 | Dropdown/cascade/folder-picker portals |
| 105 | Launcher drop preview |
| 110 | Launcher drag ghost |
| 120 | Toast host (topmost app feedback) |

The overlay ordering is deliberate in code comments (`web/src/components/ui/popover.tsx:113-120`) and concrete call sites (`web/src/components/ui/toast.tsx:171-179`, `web/src/components/workspace/launcher-fab.tsx:604-620`).

### Other global rendering rules

- App selection is `brandAccent` fill with `background` text; `.grimoire` selection is hellfire fill with void text. Terminal selection is explicitly separate and comes from the terminal palette (`web/src/app/globals.css:237-240`, `web/src/app/globals.css:440-446`).
- Ordinary web scrollbars are 10×10px; thumb is `border`, clipped inside a 2px transparent border and fully rounded, hover thumb is `mutedForeground`, track/corner transparent. Firefox uses its `thin` setting. xterm opts back into its own auto scrollbar (`web/src/app/globals.css:468-500`). Native should keep the iOS scroll indicator rather than paint a fake web bar; color it from `border`/`mutedForeground` only where the platform API allows. This needs no native module.
- The web document disables browser text inflation, tap highlight and vertical overscroll chaining, and antialiases text (`web/src/app/globals.css:412-432`). Native equivalents are platform defaults plus explicit scroll-boundary/press feedback at the component level, not root visual tokens.
- xterm disables touch actions on its renderer, then re-enables touch/callout/text selection only on the hidden helper textarea (`web/src/app/globals.css:502-521`). This is evidence that terminal gestures and keyboard capture need an explicit native arbitration layer.

Rendered Markdown (`.prose-preview`) has its own exact relative recipe, still using semantic colors (`web/src/app/globals.css:661-752`):

| Element | Literal style |
|---|---|
| `h1..h4` | semibold 600, line-height 1.3, block margins `1.4em 0.6em`; first child top margin removed |
| `h1 / h2 / h3` | `1.55em / 1.3em / 1.1em`; h4 inherits surrounding size |
| `p, ul, ol, blockquote, table` | block margin `.75em` |
| lists | left padding `1.5em`; disc/decimal; item block margin `.25em` |
| inline `code` | muted fill, radius 4px, Tailwind mono, `.9em`, padding `.1em .35em` |
| `pre` | muted fill, radius 8px, horizontal scroll, padding `12px 16px`; child code loses its own fill/padding |
| blockquote | 2px left `border`, muted text, left padding `1em` |
| `hr` | border color, block margin `1.5em` |
| table | collapsed borders, content width, max 100%, horizontal scroll; cells 1px border, padding `.35em .7em`, left aligned; header muted + semibold |
| task checkbox | right margin `.4em` |

## Typography

### Families and loading

There are four typographic roles, three of which share platform faces:

| Role/token | Exact web family | Weight files | Loading and use |
|---|---|---|---|
| App/body sans | `ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif` | Platform-provided | Explicit body stack; app chrome and all `ui/` primitives. On iPhone, omit `fontFamily` to receive San Francisco closest to the web system stack (`web/src/app/globals.css:430-432`). |
| Tailwind `font-mono` / terminal | `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace` | Platform-provided | App metadata/code and terminal text (`web/node_modules/tailwindcss/theme.css:6-8`, `web/src/components/terminal/xterm-config.mjs:18-21`). |
| Grimoire / `font-grimoire` | `var(--font-plex-sans, "IBM Plex Sans"), "Helvetica Neue", Arial, sans-serif` | IBM Plex Sans 400, 500 | `next/font/google` self-hosts build output, exposes `--font-plex-sans` on `<html>`, and uses `display:"swap"`; marketing/auth prose only (`web/src/app/globals.css:120-121`). |
| Sigil / `font-sigil` | `ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace` | Platform-provided | Labels, metadata, terminal-adjacent controls, pressroom fields/buttons (`web/src/app/globals.css:122`). |
| Poster | Rowdies | Rowdies 300 Light | `next/font/google`, latin subset, self-hosted build output, `display:"swap"`; large marketing/auth display type only. It is used through `poster.className`, not an `@theme` token. |

The exact `next/font` declarations are (`web/src/lib/fonts.ts:1-26`):

```ts
export const poster = Rowdies({
  subsets: ["latin"],
  weight: "300",
  display: "swap",
});

export const grimoire = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-plex-sans",
});
```

The Plex variable is mounted on `<html>` and the default body is antialiased (`web/src/app/layout.tsx:61-76`). No source `.woff`, `.woff2`, `.ttf`, or `.otf` is committed under `web`; Next's generated hash filenames are build artifacts and must not be copied.

**RECOMMEND:** bundle `@expo-google-fonts/ibm-plex-sans@0.4.1` (`IBMPlexSans_400Regular`, `IBMPlexSans_500Medium`) and `@expo-google-fonts/rowdies@0.4.2` (`Rowdies_300Light`) with `expo-font@57.0.1`. Those registry versions were verified 2026-08-22; use `npx expo install expo-font` for SDK compatibility. They are ordinary font assets and work in Expo Go. Keep app chrome on the platform default and terminal UI on `Platform.select({ios:"Menlo", android:"monospace"})`.

### Complete text scale used

Tailwind v4 supplies these named values (`web/node_modules/tailwindcss/theme.css:347-372`):

| Name | Size | Default line height | Common surfaces |
|---|---:|---:|---|
| `text-xs` | 12px | 16px | Hints, toast detail, cascade detail, compact metadata |
| `text-sm` | 14px | 20px | Buttons, inputs, list/menu rows, titles/descriptions, body UI |
| `text-base` | 16px | 24px | Card titles (then `leading-tight` = 20px), ordinary long copy |
| `text-lg` | 18px | 28px | Sparse larger headings |
| `text-xl` | 20px | 28px | Page/marketing subheads |

Arbitrary fixed sizes actually present under `web/src` are `8.5`, `9`, `9.5`, `10`, `10.5`, `11`, `12`, `13`, `15`, `16`, `17`, `24`, `26`, and `28` px. The dense 8.5–11px cuts are grid illustrations, labels, badges, counters and monospace metadata; 13px is terminal text and several compact text controls; 15–17px is content/subheads; 24–28px is page/display type. Never round `11px` labels to the native 12px token: badge, dropdown label and cascade-back typography depend on the denser size (`web/src/components/ui/badge.tsx:25-30`, `web/src/components/ui/dropdown-menu.tsx:285-295`, `web/src/components/ui/cascade-menu.tsx:333-346`).

Responsive marketing display sizes use these exact CSS expressions; they belong to parity for brand/auth surfaces even though ordinary mobile app chrome does not use them:

```ts
"clamp(17px,2vw,21px)";   "clamp(24px,3.7vw,35px)";
"clamp(24px,3.7vw,41px)"; "clamp(26px,3.5vw,39px)";
"clamp(26px,4.5vw,48px)"; "clamp(26px,5.9vw,32px)";
"clamp(28px,3.7vw,48px)"; "clamp(30px,4.5vw,48px)";
"clamp(30px,4.8vw,52px)"; "clamp(30px,5.4vw,48px)";
"clamp(32px,4.3vw,63px)"; "clamp(32px,4.8vw,60px)";
"clamp(32px,5.6vw,63px)"; "clamp(35px,5.6vw,63px)";
"clamp(36px,6.9vw,65px)"; "clamp(40px,7.5vw,92px)";
```

The landing page owns these per-block rather than through a named scale (`web/src/app/page.tsx:362-384`, `web/src/components/brand/press.tsx:176-203`). Native should implement each with `Math.min(max, Math.max(min, viewportWidth * vw/100))` only on the corresponding brand block.

### Line height, tracking, weight and surface map

Named line-height values in play are `none=1`, `tight=1.25`, `snug=1.375`, `normal=1.5`, `relaxed=1.625`, and `loose=2`; numeric utilities `leading-4/5/6/7/8` are `16/20/24/28/32px`. Arbitrary ratios present are `.98`, `1`, `1.02`, `1.04`, `1.06`, `1.08`, `1.25`, `1.3`, `1.55`, and `1.6` (`web/node_modules/tailwindcss/theme.css:391-395`; representative display use `web/src/app/page.tsx:365-384`).

Weights actually requested are `300` light, `400` normal, `500` medium, and `600` semibold. The app system font can render all four; Plex only ships 400/500; Rowdies only 300. Tracking uses named `tight=-0.025em`, `normal=0`, `wide=.025em`, plus `.04em`, `.10em`, `.12em`, `.14em`, `.16em`, `.18em`, `.22em`, and `.30em`. Pressroom shared buttons are monospace `12px`, uppercase, `.10em`; labels are monospace `11px`, uppercase, `.16em` (`web/src/app/globals.css:201-218`).

Canonical native component pairs:

| Style | `fontSize / lineHeight / weight / tracking` | Surfaces |
|---|---|---|
| `uiXs` | `12 / 16 / 400 / 0` | Hint/detail/metadata |
| `uiSm` | `14 / 20 / 400 / 0` | Input/menu/body text |
| `uiSmMedium` | `14 / 20 / 500 / 0` | Button, label, switch label |
| `uiSmSemibold` | `14 / 20 / 600 / 0` | Dialog/empty-state titles |
| `uiBase` | `16 / 24 / 400 / 0` | Body copy |
| `cardTitle` | `16 / 20 / 600 / 0` | Card title; `leading-tight` changes line height, not tracking |
| `micro` | `11 / 16 / 500 / 0` | Badge/menu label/back row |
| `sigilLabel` | `11 / 16 / 500 / 1.76px` | Uppercase pressroom label (`.16em`) |
| `sigilButton` | `12 / 16 / 500 / 1.2px` | Uppercase pressroom button (`.10em`) |
| `terminal` | `13 / 15.6 / 400 / 0` | Terminal glyph cell metrics |

The source often leaves a custom size's line-height as CSS `normal`. The table above deliberately gives explicit line heights only for shared native primitives; preserve block-specific ratios for poster/display text instead of inventing one global “normal.”

## Motion system

### Primitive timing and easing tokens

Tailwind's actual installed defaults and the app custom curve are (`web/node_modules/tailwindcss/theme.css:434-440`, `web/src/app/globals.css:550-555`):

| Token | Literal | Use |
|---|---|---|
| `instant` | `0ms` | Drag-follow transforms and initial mounted state |
| `fast` | `100ms` | Tooltip/menu/popover enter, quick label close |
| `base` | `150ms` | Default `transition-*`; color, transform and cascade step |
| `medium` | `200ms` | Collapse, drawer/sheet scrim, shell/FAB geometry |
| `panel` | `220ms` | Drawer and sheet translate |
| `hoverIntent` | `260ms` | File-preview pointer dwell; input disambiguation |
| `overlay` | `300ms` | Connecting overlay, upload progress, channel/lock colors |
| `jiggle` | `450ms` | Launcher trash target attention |
| `successHold` | `420ms` | Connecting success acknowledgement |
| `toastInfo/error/alert` | `5000/8000/7000ms` | Auto-dismiss lifetimes |
| `easeIn` | `[.4,0,1,1]` | Tailwind named ease-in |
| `easeOut` | `[0,0,.2,1]` | Native-feeling settle, tab/grid drag returns |
| `easeInOut` | `[.4,0,.2,1]` | Default 150ms CSS transition |
| `swift` | `[.32,.72,0,1]` | Shell/panel geometry and tactile app motion |
| `cssEase` | CSS keyword `ease` = `[.25,.1,.25,1]` | `tw-animate-css` enter/exit unless another animation timing function is set |
| `linear` | `[0,0,1,1]` | Spinners, sheen, drift, marquees |

Important implementation detail: `.ease-swift` is a class that writes `transition-timing-function`; it is **not** a `--ease-swift` CSS variable (`web/src/app/globals.css:550-555`). Therefore inline `transform 150ms var(--ease-swift,ease-out)` in sidebar rows resolves to CSS `ease-out`, not swift (`web/src/components/nav/Sidebar.tsx:256`). Also, adding `.ease-swift` beside a `tw-animate-css` animation does not replace that animation's own default `ease` timing. Native parity should reproduce the *actual* timings above.

`tw-animate-css@1.4.0` is the installed version (`web/bun.lock:532`). `animate-in` starts from the supplied opacity/transform and returns to identity; `animate-out` runs the reverse. In this app, `fade-*-0` means opacity 0, `zoom-*-95` means scale .95, and `slide-*-4` means 16px. Default animation duration is 150ms unless `duration-*` overrides it (`web/src/app/globals.css:2`, `web/src/components/ui/dropdown-menu.tsx:193-201`).

### Every shared/UI interaction motion

| Interaction | Exact motion |
|---|---|
| Button/input/menu hover and focus | Color transition 150ms, ease-in-out; default/destructive buttons instead animate opacity to .90 over that transition. |
| Switch | Track colors 150ms ease-in-out; knob X `2px → 18px`, 150ms ease-in-out (`web/src/components/ui/switch.tsx:35-50`). |
| Collapse | Grid row `0fr ↔ 1fr`, 200ms swift; no animation until one RAF after mount (`web/src/components/ui/collapse.tsx:38-50`). |
| Dialog scrim/content | Enter fade from 0; centered sizes also scale `.95 → 1`; default 150ms CSS ease. No authored exit class in the wrapper (`web/src/components/ui/dialog.tsx:20-62`, `web/src/components/ui/dialog.tsx:79-85`). |
| Dropdown/popover | Fade `0 → 1` + scale `.95 → 1`, 100ms CSS ease, transform origin nearest anchor (`web/src/components/ui/dropdown-menu.tsx:193-201`, `web/src/components/ui/popover.tsx:111-120`). |
| Cascade step | Fade from 0 and X `+16 → 0` forward or `-16 → 0` back, 150ms CSS ease; initial root panel does not slide (`web/src/components/ui/cascade-menu.tsx:323-331`). |
| Drawer | Scrim opacity 200ms; panel X `-100% → 0`, 220ms swift. While finger drags left, transition is disabled. Axis locks horizontal/vertical after 8px; dismiss below `-70px` (`web/src/components/ui/drawer.tsx:119-139`, `web/src/components/ui/drawer.tsx:143-169`). |
| Bottom sheet | Scrim opacity 200ms; panel Y `100% → 0`, 220ms ease-out. While handle is dragged down, transition is disabled; dismiss above `90px` (`web/src/components/ui/sheet.tsx:93-127`). |
| Tooltip | Pointer waits 500ms; keyboard focus opens immediately; fade from 0 in 100ms, no movement; touch never opens it (`web/src/components/ui/tooltip.tsx:7-13`, `web/src/components/ui/tooltip.tsx:109-139`). |
| Toast enter | Fade from 0 and X `+16 → 0`, 200ms CSS ease (the adjacent swift transition class does not alter keyframe timing). |
| Toast exit | Fade to 0 and X `0 → +16`, 150ms CSS ease, retained in store 180ms before removal (`web/src/components/ui/toast.tsx:52-60`, `web/src/components/ui/toast.tsx:184-190`). |
| Spinner | Continuous `rotate(0→360deg)`, 1s linear (`web/src/components/ui/spinner.tsx:17-29`). |
| Skeleton | Opacity `1→.5→1`, 2s `cubic-bezier(.4,0,.6,1)` infinite (`web/src/components/ui/skeleton.tsx:3-4`, `web/node_modules/tailwindcss/theme.css:451-460`). |
| Active status | Ping scale `1→2` while fading `1→0`, 1s ease-out infinite, source dot remains (`web/src/components/ui/status.tsx:43-47`, `web/node_modules/tailwindcss/theme.css:447-450`). |
| Hover preview intent | Open after 260ms stationary pointer; close immediately and geometrically; keyboard pin is immediate (`web/src/components/ui/hover-intent.ts:15-48`). |

### Custom keyframes and feature motion

The complete authored keyframe set in `globals.css` is:

```css
@keyframes grimoire-spin { to { transform: rotate(360deg); } }
@keyframes brand-marquee { to { transform: translateX(-50%); } }
@keyframes bin-jiggle {
  0%,100% { transform: rotate(0deg) }
  25%     { transform: rotate(-7deg) }
  75%     { transform: rotate(7deg) }
}
@keyframes upload-sheen { to { background-position: -100% 0; } }
@keyframes channel-drift { to { background-position-x: var(--channel-drift-to); } }
```

Durations: grimoire rings `90s` forward and `140s` reverse, linear infinite; brand marquee `56s` linear infinite; bin jiggle `450ms ease-in-out infinite`; upload sheen `1.2s linear infinite`, initial background position `100% 0` to `-100% 0`, over a `transparent → rgba(255,255,255,.95) → transparent` gradient sized `200% 100%`; channel drift `.75s linear infinite`, moving a repeating `2px currentColor / 6px transparent` dash period by ±8px (`web/src/app/globals.css:241-264`, `web/src/app/globals.css:561-627`).

Feature-level motions that plans must retain:

- App shell/sidebar width and collapse use 200ms swift after one-RAF arming; plus icon rotates 90° in 150ms, and collapsing labels fade in 100ms while opening labels fade in 150ms after 75ms (`web/src/components/nav/AppShell.tsx:187`, `web/src/components/nav/sidebar-parts.tsx:35-36`, `web/src/components/nav/Sidebar.tsx:358-444`).
- Workspace tab drag neighbors and ghost settle with transform 150ms ease-out; grid pane `left/top/width/height/transform` changes use 150ms swift (`web/src/components/workspace/workspace-tabs.tsx:444-509`, `web/src/components/workspace/workspace-grid.tsx:1581-1585`).
- Launcher tray max-width/padding and FAB use 200ms swift. Items use `all 200ms swift`, 35ms index stagger, hidden state `translateX(16px) scale(.75) opacity(0)`; FAB hover/press scale `1.05/.95` and open plus rotates 45° (`web/src/components/workspace/launcher-fab.tsx:528-624`).
- Agent-switcher compact metadata transitions width, opacity and margin over 150ms. Folder picker enters with 100ms fade/scale; breadcrumb/back opacity is 150ms swift and search-field width is 200ms swift (`web/src/components/workspace/agent-switcher.tsx:153`, `web/src/components/workspace/folder-picker.tsx:456-551`).
- Connecting overlay appears only after 240ms, enters/exits fade+scale at 300ms, holds success 420ms, then waits 260ms before unmount. Its slow state begins at 8s; lock/channel color transition is 300ms (`web/src/components/terminal/ConnectingOverlay.tsx:14-21`, `web/src/components/terminal/ConnectingOverlay.tsx:172-245`).
- Upload progress remains visible at least 420ms; width/opacity motion is 300ms active or 200ms fade, swift (`web/src/components/terminal/Terminal.tsx:438-445`, `web/src/components/terminal/Terminal.tsx:3303-3336`).
- Legion progress width is 500ms swift and disclosure chevrons are 150ms (`web/src/components/legion/legion-parts.tsx:64`, `web/src/components/legion/legion-parts.tsx:125`).
- File-view determinate progress width is 200ms ease-out (`web/src/components/files/preview-renderers.tsx:124`).
- Masthead’s scroll-linked translate is direct/scrubbed rather than time-eased; other brand hover transitions use the 150ms default (`web/src/components/brand/press.tsx:79-101`, `web/src/components/brand/press.tsx:122-136`).
- Landing plate hover translates down 4px over 200ms swift; legion new-slot plus rotates 90° over 150ms. Archived/sidebar/legion disclosure chevrons use 150ms transform after first-frame arming (`web/src/app/page.tsx:542`, `web/src/app/legion/page.tsx:133`, `web/src/components/nav/SidebarArchivedSection.tsx:175`, `web/src/components/legion/LegionStrip.tsx:176`).

Every remaining authored `transition-colors`, `transition-opacity`, `transition-transform`, bare `transition`, or `transition-all` without a `duration-*` uses Tailwind's default 150ms/ease-in-out. All `animate-spin`, `animate-pulse`, and `animate-ping` call sites reuse the shared keyframes already specified; loaders do not define alternate speeds (`web/node_modules/tailwindcss/theme.css:434-460`; representative consumers `web/src/components/files/FileExplorer.tsx:1012-1128`).

There is no spring constant, damping ratio, Framer Motion dependency, or web spring implementation anywhere in `web/src`. **RECOMMEND:** use `react-native-reanimated@4.6.0` timing for parity first (registry latest verified 2026-08-22; install the Expo-SDK-compatible version via `npx expo install react-native-reanimated`; Expo Go compatible). Reserve native springs for new mobile-only gesture settling, with values documented separately so they do not silently alter copied web interactions.

Reduced motion is global and absolute: under `prefers-reduced-motion: reduce`, all animations and transitions become `.01ms`, animation iteration count becomes 1, and transition delay becomes 0 (`web/src/app/globals.css:629-640`). Native must gate every Reanimated timing/repeat on `AccessibilityInfo.isReduceMotionEnabled()`; state changes and removal timers must still happen.

## Shared UI component visual specifications

The specifications below cover every production file in `web/src/components/ui`; the two adjacent test files are accounted for at the end. “Hover” maps to highlighted/pressed state on touch only where it communicates action; native should not manufacture permanent hover state.

### `armed-motion.ts`

`useArmedMotion()` returns false for first paint and true on the next animation frame. It has no visual surface; it suppresses route/mount replay of decorative transitions (`web/src/components/ui/armed-motion.ts:19-27`). Native equivalent: a shared value set after the first committed frame; initial persisted/open state renders in place.

### `badge.tsx`

An inline, single-line pill: row, centered, 4px gap, 1px border, horizontal 8px, vertical 2px, fully rounded, `11/16` medium (`web/src/components/ui/badge.tsx:4-29`). Variants:

| Variant | Border | Fill | Text |
|---|---|---|---|
| default | `border` | `secondary` at 60% | `secondaryForeground` |
| outline | `border` | transparent | `mutedForeground` |
| success | `success` at 25% | `successSoft` | `success` |
| warning | `warning` at 25% | `warningSoft` | `warning` |
| info | `info` at 25% | `infoSoft` | `info` |
| destructive | `destructive` at 25% | `destructiveSoft` | `destructive` |

Badge defines no press/focus/disabled/loading behavior; callers should wrap it in an accessible control if interactive.

### `button.tsx`

Base anatomy: centered row, 8px gap, no wrapping, radius 8px, `14/20` medium, selectable text disabled, color transition 150ms. Focus: no outline, 1px `ring`. Disabled: pointer off and whole control opacity .5 (`web/src/components/ui/button.tsx:8-35`).

| Size | Exact box |
|---|---|
| default | height 40px; horizontal 16px, vertical 8px |
| small | height 36px; horizontal 12px; radius 8px |
| large | height 44px; horizontal 24px; radius 8px |
| icon | 40×40px; no authored inner padding |

| Variant | Default | Highlight/hover |
|---|---|---|
| default | `primary` fill, `primaryForeground` | opacity .90 |
| secondary | `secondary`, `secondaryForeground` | `accent` fill |
| outline | transparent, 1px `border` | `accent` fill, `accentForeground` |
| ghost | transparent | `accent` fill, `accentForeground` |
| destructive | `destructive`, `destructiveForeground` | opacity .90 |
| link | transparent, `primary` text | underline, 4px underline offset |

There is no built-in active transform or loading state. Loading is a caller-owned `Spinner`; preserve width/label as needed rather than replacing all children implicitly. Pressroom overrides secondary/outline and disabled visuals as described under borders (`web/src/app/globals.css:201-235`).

### `card.tsx`

Card container: radius 10px, 1px `border`, `card`/`cardForeground`, `shadowSm`. Header is a column with 4px gap and 16px padding. Title `16/20`, semibold, normal tracking; description `14/20`, `mutedForeground`. Content is 16px padding with top 0. Footer is row-centered with 8px gap, 16px padding, top 0 (`web/src/components/ui/card.tsx:4-53`). Card has no intrinsic hover/focus/selected state.

### `collapse.tsx`

Outer grid animates row fraction `0fr ↔ 1fr`, 200ms swift; inner remains mounted but clips overflow and is `inert` while closed. Caller spacing must be inner padding because outer margin escapes the clip (`web/src/components/ui/collapse.tsx:7-53`). No decoration is added.

### `empty-state.tsx`

Centered vertical stack, 12px gap, horizontal 24px, vertical 48px, centered text. Optional icon plate is 48×48px, radius 12px, 1px `border`, `muted` fill, `mutedForeground`; child SVG 24px. Title `14/20` semibold. Body max width 384px, `14/24`, muted. Action has 8px top margin. `iconPlate=false` renders a self-plated mark bare (`web/src/components/ui/empty-state.tsx:9-51`).

### `input.tsx`, `textarea.tsx`, `label.tsx`

Input: 40px high, full width, radius 8px, 1px `input` border, transparent fill, horizontal 12px / vertical 8px, `14/20`; placeholder `mutedForeground`; focus 1px `ring`, no outline; disabled opacity .5 (`web/src/components/ui/input.tsx:8-23`). Textarea is identical but auto-height with 60px minimum (`web/src/components/ui/textarea.tsx:8-20`). Label is foreground `14/14`, medium (`web/src/components/ui/label.tsx:6-15`). Error styling is not built into these primitives; callers add destructive text/border.

### `skeleton.tsx`, `spinner.tsx`, `status.tsx`

- Skeleton is any caller-sized rectangle, radius 8px, `muted` at 70%, pulsing opacity 1/.5 at 2s (`web/src/components/ui/skeleton.tsx:1-4`).
- Spinner defaults 16×16, current color defaults `mutedForeground`, SVG `viewBox="0 0 24 24"`. Track: circle center 12 radius 9, 25% opacity, stroke 3. Arc: `M12 3a9 9 0 0 1 9 9`, stroke 3, round cap. Whole mark rotates 1s linear and owns a status label (`web/src/components/ui/spinner.tsx:8-29`).
- Status dot is 8×8, fully round, tone fill (`active|waiting|idle|offline`). Optional pulse duplicates it absolutely, scale/fade ping at opacity .6. A session dot adds a 1px `card` border so it separates from card ground. Online hosts map to active; everything else maps offline (`web/src/components/ui/status.tsx:5-61`).

### `switch.tsx`

Switch track is 40×24, 1px border, pill, centered knob. Off: `muted` fill and `border`; on: `primary` fill/border. Focus is 2px `ring` plus 1px `background` offset; disabled opacity .5. Knob is 16×16, `background`, pill, `shadowSm`, X=2px off and X=18px on (`web/src/components/ui/switch.tsx:25-52`).

`SwitchRow` expands the target: row, start-aligned, 12px gap and padding, radius 10px, 1px `border`; enabled hover fill `accent` at 40%; disabled row opacity .6. Optional icon has 2px top margin and muted ink. Label is `14/20` medium; hint has 2px top margin, `12/16`, muted; switch aligns 2px from top (`web/src/components/ui/switch.tsx:69-109`).

### `dialog.tsx` and `confirm.tsx`

Dialog root portals at z50. Scrim is black 60%, 2px backdrop blur. Content uses `background`, column layout, clips overflow, and has no default outline. All sizes fade in; centered sizes scale `.95→1` (`web/src/components/ui/dialog.tsx:20-85`).

| Size | Mobile/compact geometry | Desktop cap encoded by web |
|---|---|---|
| `sm` | centered, viewport width minus 32px, max height viewport minus 32px | max width 384px |
| `md` | same | max width 512px |
| `lg` | same | max width 672px |
| `full-mobile` | all edges 0, safe top/bottom, visual-viewport height | at ≥768px: max `920×680`, viewport minus `48×64`, centered |
| `viewer` | all edges 0, safe top/bottom, visual-viewport height | at ≥768px: max `960×860`, viewport minus 48px both axes, centered |

Centered/desktop panels: radius 12px, 1px `border`, `shadow2xl` tinted black20 light/black50 dark. Full-mobile and viewer have no mobile border/radius/shadow. Close control: absolute top/right 12px plus safe-top on mobile, 6px padding, radius 8px, muted ink, highlight `accent`/foreground, 16px X (`web/src/components/ui/dialog.tsx:30-62`, `web/src/components/ui/dialog.tsx:89-99`). Header: column, 4px gap, padding 16px, bottom 8px, right 48px. Title `14/20` semibold; description `14/20` muted. Footer: right-aligned row, 8px gap, 16px padding, top 8px (`web/src/components/ui/dialog.tsx:105-138`). Radix supplies focus trap, Escape, scrim dismissal, ARIA and focus restoration.

Confirm is a singleton small dialog without close X. It has title, optional description, and footer with small outline Cancel then small default/destructive Confirm. Destructive confirms autofocus Cancel; safe confirms autofocus Confirm. Closing by Escape/scrim resolves false; a second confirm cancels the prior one (`web/src/components/ui/confirm.tsx:20-51`, `web/src/components/ui/confirm.tsx:59-107`).

### `drawer.tsx`

Mobile left drawer: z50 root and black50 scrim. Panel spans visual-viewport height, width `min(85vw,264px)`, safe top/bottom, `background`/foreground, right 1px border, `shadow2xl`; inner content scrolls vertically (`web/src/components/ui/drawer.tsx:146-174`). It traps Tab/Shift-Tab, Escape closes, locks background scroll, focuses panel on open and restores prior focus on close (`web/src/components/ui/drawer.tsx:65-117`). Motion/gesture is exactly in the motion table: horizontal direction lock at 8px; only a leftward drag follows; threshold 70px.

### `sheet.tsx`

Bottom sheet: z50, black50 scrim; bottom/left/right anchored; maximum height `visualViewport - 40px`; radius 16px on top corners only; 1px top `border`; `popover`/`popoverForeground`, `shadow2xl`, safe bottom (`web/src/components/ui/sheet.tsx:113-145`). Grab region is a centered column, gap 8px, top padding 10px, touch scrolling disabled only there. Handle is 36×4px, pill, `border` fill. Optional title spans width, horizontal 16px, bottom 4px, `14/20` medium. Content scrolls vertically. Escape/scrim close, background locks, focus restores. **UNKNOWN:** this hand-rolled web sheet does not implement a Tab focus trap (`web/src/components/ui/sheet.tsx:61-84`); native modal semantics should trap accessibility focus, but exact cross-platform behavior needs device UAT.

### `dropdown-menu.tsx`

Portal menu z100, fallback/minimum width 176px, viewport-aware max dimensions, internal overscroll containment, radius 10px, 1px `popoverBorder`, `popover`, 4px padding, `popoverForeground`, `shadowXl` plus black50 (`web/src/components/ui/dropdown-menu.tsx:84-128`, `web/src/components/ui/dropdown-menu.tsx:183-207`). It stays 8px inside the viewport, sits 4px off its anchor, flips main axis or cross-edge before clamping (`web/src/components/ui/menu-position.ts:25-28`, `web/src/components/ui/menu-position.ts:129-172`).

Item: full-width row, 8px gap, radius 8px, horizontal/vertical 8px, `14/20`; hover/focus `popoverAccent`; disabled opacity .5. Destructive item uses destructive ink and destructive fill at 10% when highlighted. Checkbox is 16×16, radius 4px, 1px border; checked foreground fill/border with background check, 12px check at stroke 3. Separator: horizontal margin 4px, vertical 4px, 1px `popoverBorder`. Label: horizontal 8px, vertical 6px, `11px` medium muted (`web/src/components/ui/dropdown-menu.tsx:212-295`). Escape/outside closes and Arrow Down opens from the trigger. The authored Up/Down handler intends to wrap enabled items, but queries `rootRef` while the menu is portaled outside it, so current web DOM cannot find those rows (`web/src/components/ui/dropdown-menu.tsx:84-88`, `web/src/components/ui/dropdown-menu.tsx:147-167`). Native should implement the intended roving behavior over its menu data rather than reproduce that DOM defect.

### `cascade-menu.tsx`

Anchored form: 240px wide, otherwise same z100, radius, border, fill, padding and shadow as dropdown. At viewport width ≤767px, `presentation="auto"` becomes the bottom sheet (`web/src/components/ui/cascade-menu.tsx:184-193`, `web/src/components/ui/cascade-menu.tsx:428-469`).

Panels show one level. Back row: 8px horizontal/vertical, 6px gap, radius 8px, `11px` medium muted, 14px chevron; root title uses 8px horizontal/6px vertical. Section heading: horizontal 8px, bottom 4px/top 8px, `12px` medium muted; non-first headings add 4px top plus top border. Items match dropdown; anchored vertical padding 8px, sheet minimum height 44px and padding 10px. Icon slot and forward chevron are 16px. Detail is `12/16` muted. Loading centers spinner with 24px vertical padding; empty uses horizontal 8px/vertical 12px, centered `14/20` muted (`web/src/components/ui/cascade-menu.tsx:323-410`). Arrow Right descends, Arrow Left/Backspace returns, Up/Down wraps, first item is focused per panel (`web/src/components/ui/cascade-menu.tsx:281-321`).

### `popover.tsx`

Preview popover: caller-supplied anchor, default side right/start, measured fallback width 544px, z90, clips overflow, radius 10px, 1px `popoverBorder`, `popover`/foreground, `shadowXl` plus black50, 100ms fade/scale enter (`web/src/components/ui/popover.tsx:29-96`, `web/src/components/ui/popover.tsx:98-127`). Noninteractive default is pointer-transparent `role=tooltip`; interactive form is pointer-enabled `role=group`. It uses the same 8px viewport gutter/4px anchor gap positioning helper. It defines no internal padding because preview content owns its composition.

### `tooltip.tsx`

Collapsed-rail tooltip: portal z60, starts 8px right of anchor, vertically centered but held 16px from viewport edges. Max width 256px, radius 8px, 1px `border`, `popover`/foreground, horizontal 8px/vertical 4px, `12/16`, `shadowMd`, wrapping words, 100ms fade (`web/src/components/ui/tooltip.tsx:7-13`, `web/src/components/ui/tooltip.tsx:127-144`). Pointer hover waits 500ms; focus-visible is immediate; pointer down, leave, scroll, resize and blur close; touch never opens (`web/src/components/ui/tooltip.tsx:61-124`).

### `toast.tsx`

Host is z120, right 16px, width 320px capped to viewport minus 32px, 8px stack gap. It starts below the 56px mobile header plus safe-top, or 16px from top in desktop shell. Flex reverse keeps newest visually top (`web/src/components/ui/toast.tsx:169-179`).

Toast row: start-aligned, 10px gap, radius 10px, 1px border, `popover`, horizontal 12px/vertical 10px, `14/20`, `shadowLg`. Info border is `border`; error border is destructive at 40%. Default glyph is 16px success check or destructive alert with 2px top margin. Detail is 12/16 muted with 2px top margin. Dismiss is 20×20, radius 6px, muted; highlight accent/foreground; X 14px. Actionable content gets a 1px ring (`web/src/components/ui/toast.tsx:180-237`). Up to five live items; exact duplicates refresh instead of stacking. Info/error last 5s/8s, alert override 7s; manual dismiss is supported (`web/src/components/ui/toast.tsx:52-114`).

### `hover-intent.ts`, `menu-position.ts`, and tests

`hover-intent.ts` is behavioral only: 260ms open, immediate cancel, structural target equality, keyboard pin. `menu-position.ts` is geometry only: 8px viewport margin, 4px anchor offset, axis flipping, size capping, and transform origin calculation (`web/src/components/ui/hover-intent.ts:24-105`, `web/src/components/ui/menu-position.ts:25-49`). Their tests establish timing, pinning, flipping, clamping and capping but add no visual tokens (`web/src/components/ui/hover-intent.test.ts:1`, `web/src/components/ui/menu-position.test.ts:1`).

## Terminal theme, font, and renderer constants

### Shared xterm configuration

The shipped xterm configuration is intentionally imported by the browser and terminal-conformance runner (`web/src/components/terminal/xterm-config.mjs:1-15`):

```ts
export const TERMINAL_FONT_SIZE = 13;
export const TERMINAL_LINE_HEIGHT = 1.2; // effective 15.6px cell line
export const TERMINAL_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
export const TERMINAL_SCROLLBACK_LINES = 100_000;
export const TERMINAL_SNAPSHOT_LINES = 10_000;
export const TERMINAL_UNICODE_VERSION = "11";
export const XTERM_EMULATION_OPTIONS = {
  allowProposedApi: true,
  convertEol: false,
};
```

Live browser construction also sets `cursorBlink:true`, `scrollOnUserInput:true`, and `smoothScrollDuration:0`, loads fit/web-links/clipboard/serialize and Unicode 11 add-ons, and then activates Unicode version 11 (`web/src/components/terminal/Terminal.tsx:1456-1484`). The xterm viewport itself has 4px vertical and 6px horizontal padding (`web/src/app/globals.css:509-514`).

There is **no user-selectable terminal font, size, line-height, or independent terminal color scheme** in the web implementation. Terminal follows the resolved app theme live; changing theme replaces `term.options.theme` in place without recreating the live session (`web/src/components/terminal/Terminal.tsx:510-522`). The only persisted choice is the app preference `spawn.theme`.

### Dark terminal palette

The authored dark theme overrides only background, foreground and cursor (`web/src/components/terminal/xterm-config.mjs:28-36`). Everything else is `@xterm/xterm@5.5.0` default:

| Slot | Dark literal |
|---|---|
| background | `#0A0A0A` |
| foreground | `#E5E5E5` |
| cursor | `#E5E5E5` |
| cursorAccent | `#000000` (xterm default) |
| selectionBackground | `rgba(255,255,255,.30)` |
| selectionInactiveBackground | `rgba(255,255,255,.30)` |
| black / brightBlack | `#2E3436` / `#555753` |
| red / brightRed | `#CC0000` / `#EF2929` |
| green / brightGreen | `#4E9A06` / `#8AE234` |
| yellow / brightYellow | `#C4A000` / `#FCE94F` |
| blue / brightBlue | `#3465A4` / `#729FCF` |
| magenta / brightMagenta | `#75507B` / `#AD7FA8` |
| cyan / brightCyan | `#06989A` / `#34E2E2` |
| white / brightWhite | `#D3D7CF` / `#EEEEEC` |

The defaults are literal in `web/node_modules/@xterm/xterm/src/browser/services/ThemeService.ts:23-52`. ANSI indices 16–231 are the standard xterm 6×6×6 cube with channel levels `[0,95,135,175,215,255]`; indices 232–255 are greys `8 + 10n` for `n=0..23` (`web/node_modules/@xterm/xterm/src/browser/services/ThemeService.ts:55-75`). Those extended colors are terminal protocol behavior, not app semantic tokens.

### Light terminal palette

The light palette is authored explicitly because dark-default ANSI white/yellow are illegible on white (`web/src/components/terminal/xterm-config.mjs:38-81`):

| Slot | Light literal |
|---|---|
| background | `#FCFCFC` |
| foreground | `#1F1F1F` |
| cursor | `#1F1F1F` |
| cursorAccent | `#FCFCFC` |
| selectionBackground | `#ACCEF7` supplied; xterm renders it at 30% opacity over background |
| selectionInactiveBackground | `#E1E6EB` supplied; xterm renders it at 30% opacity over background |
| black / brightBlack | `#000000` / `#666666` |
| red / brightRed | `#CD3131` / `#CD3131` |
| green / brightGreen | `#00BC00` / `#14CE14` |
| yellow / brightYellow | `#949800` / `#B5BA00` |
| blue / brightBlue | `#0451A5` / `#0451A5` |
| magenta / brightMagenta | `#BC05BC` / `#BC05BC` |
| cyan / brightCyan | `#0598BC` / `#0598BC` |
| white / brightWhite | `#555555` / `#A5A5A5` |

xterm deliberately converts any supplied opaque selection color to a 30%-opacity overlay, then composites it over the terminal background (`web/node_modules/@xterm/xterm/src/browser/services/ThemeService.ts:130-149`). A native terminal renderer must preserve that semantic; displaying solid `#ACCEF7` would be visibly wrong.

**UNKNOWN:** a complete Expo-Go-compatible native terminal emulator/rendering strategy belongs to the terminal research topic. Whatever renderer is chosen must accept the palette and metrics above and must preserve indexed ANSI semantics; this report does not recommend wrapping xterm or introducing a custom native view.

## Icon system and asset inventory

### Lucide

Web declares `lucide-react:^1.14.0` and locks exactly `1.14.0` (`web/package.json:34`, `web/bun.lock:372`). Icons inherit `currentColor`; Lucide's normal stroke width remains 2. Shared sizes actually used are 12px (`size-3`), 14px (`size-3.5`), 16px (`size-4`), 20px (`size-5`), and 24px (`size-6`). The only shared override is the 12px checkbox Check at stroke 3 (`web/src/components/ui/dropdown-menu.tsx:255-263`). Design guidance pairs a normal 16px glyph with at least a 28px control and requires a minimum 44px coarse-pointer target (`docs/DESIGN.md:225-239`, `docs/DESIGN.md:254`). Color comes from the surrounding semantic text token, never a hard-coded Lucide fill.

Complete unique Lucide imports across `web/src` (108 names, including aliases such as `Clipboard as ClipboardIcon`):

```text
AlertCircle, AlertTriangle, Archive, ArrowDown, ArrowLeft, ArrowRight,
ArrowRightLeft, ArrowUp, Bell, BellOff, BellRing, Binary, Bot, Check,
CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ChevronsDownUp,
ChevronUp, Clipboard, Copy, CornerUpLeft, Database, Download, Ellipsis,
ExternalLink, Eye, EyeOff, File, FileArchive, FileCode, FileCog, FileImage,
FileKey, FileMusic, FileSpreadsheet, FileSymlink, FileTerminal, FileText,
FileType, FileVideoCamera, Fingerprint, Flame, Folder, FolderOpen, FolderPlus,
FolderSearch, FolderTree, Home, ImageOff, ImagePlus, KeyRound, Laptop,
LayoutTemplate, List, Loader2, Lock, LockOpen, LogOut, Mail, Maximize2, Menu,
MessageCircleQuestion, MessageSquare, Monitor, MonitorSmartphone, Moon,
MoreHorizontal, Network, Palette, PanelLeftClose, PanelLeftOpen, Pencil,
PlugZap, Plus, Presentation, Radio, RadioTower, RefreshCw, RotateCcw,
RotateCw, Search, Send, SendHorizontal, Server, Settings, Settings2, Shapes,
ShieldAlert, ShieldCheck, ShieldOff, Skull, Smartphone, SquareTerminal, Sun,
Terminal, Trash2, Type, Unlink, Unplug, Upload, User, UserRound, Volume2,
Wrench, X, Zap
```

Representative exhaustive-import sites include terminal modifier arrows/clipboard/send (`web/src/components/terminal/ModifierBar.tsx:3-10`), all file-type marks (`web/src/components/files/file-icon.tsx:1-19`), explorer actions (`web/src/components/files/FileExplorer.tsx:4-23`), settings navigation (`web/src/components/settings/SettingsDialog.tsx:3-14`), and pane actions (`web/src/components/workspace/session-pane.tsx:4-19`).

**RECOMMEND:** pin `lucide-react-native@1.14.0`, verified published 2026-08-22, because it is the matching renderer release for web's locked `lucide-react@1.14.0`; registry latest is `1.33.0`, but taking it could change glyph paths and violate pixel parity. Install the SDK-compatible `react-native-svg` with Expo's version resolver (registry latest `15.15.5`; Lucide 1.14 accepts majors 12–15). Both work in Expo Go because `react-native-svg` is supported there; this replaces DOM SVG, it is not a custom native module.

### Agent identity plates and exact custom SVGs

`AgentIcon` defaults to a 28×28 plate, radius 10px, `shadowSm`, 1px inset ring. Non-Codex glyphs are `round(size × .58)` = 16px at default. Monogram font is `max(10, round(size × .45))` = 13px at default (`web/src/components/icons/AgentIcon.tsx:36-82`). Fixed plates:

| Identity | Plate | Glyph | Inset ring |
|---|---|---|---|
| Claude Code | `#D97757` | white | white 10% |
| Codex | white | its full-bleed gradient mark | black 10% |
| OpenCode | black | white | white 20% |
| Aider | `#10231B` | `#3FCF8E` | white 10% |
| Shell | `#1C2128` | `#7EE787` | white 10% |
| Fallback monogram | `muted` | `mutedForeground` | `border` |

Every custom mark has `viewBox="0 0 24 24"`. These path definitions are the porting source (`web/src/components/icons/AgentIcon.tsx:86-175`):

```ts
export const agentMarks = {
  claude: {
    fill: "currentColor",
    fillRule: "evenodd",
    clipRule: "evenodd",
    d: "M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z",
  },
  codexPlate: {
    fill: "#FFFFFF",
    d: "M19.503 0H4.496A4.496 4.496 0 000 4.496v15.007A4.496 4.496 0 004.496 24h15.007A4.496 4.496 0 0024 19.503V4.496A4.496 4.496 0 0019.503 0z",
  },
  codexGlyph: {
    d: "M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z",
    gradient: { x1: 4.33, y1: 18.25, x2: 19.5, y2: 5,
      stops: [[0,"#B1A7FF"],[.5,"#7A9DFF"],[1,"#3941FF"]] },
  },
  opencode: { fill: "currentColor", d: "M16 6H8v12h8V6zm4 16H4V2h16v20z" },
  aider: { fill: "none", stroke: "currentColor", strokeWidth: 2.4,
    strokeLinecap: "round", strokeLinejoin: "round", d: "M5 19 12 5l7 14M8.3 14.4h7.4" },
  shell: { fill: "none", stroke: "currentColor", strokeWidth: 2.4,
    strokeLinecap: "round", strokeLinejoin: "round", d: "M4.5 6 10 12l-5.5 6M13 19h6.5" },
} as const;
```

Port these five definitions to `react-native-svg` `Svg`, `Path`, `Defs`, `LinearGradient`, and `Stop`. The resolver deciding which plate to show lives outside the design system.

Resolver behavior is nevertheless part of identity consistency: definition `kind` wins over command; otherwise the command basename is checked after skipping environment-assignment prefixes. Claude/Codex/OpenCode/Aider map to brand plates; `bash|zsh|fish|sh|dash` map to shell; an unknown kind becomes its uppercase first-letter monogram; no kind/command becomes Shell (`web/src/components/icons/AgentIcon.test.ts:4-45`).

### Pressroom brand primitives

These are reusable designs in `components/brand/press.tsx`, not page-specific accidents:

- `CTA_SLAB`: inline centered row, 8px gap, radius 6px, bone fill/void text, horizontal 28px and vertical 15px, sigil `13px` medium uppercase with `.14em` tracking; hover fill white. Red is intentionally not a button ground (`web/src/components/brand/press.tsx:20-28`).
- `CTA_QUIET`: inline centered row, 8px gap, sigil 12px uppercase, `.18em`, bone text, ember70 underline at 8px offset; hover turns text/underline ember (`web/src/components/brand/press.tsx:30-32`).
- `Eyebrow`: sigil 12px medium uppercase, `.30em`, hellfire (`web/src/components/brand/press.tsx:34-45`).
- `RegistrationMarks`: four absolute “+” glyphs, top/bottom 12px and left/right 16px, z10, sigil 15px, hellfire50, noninteractive (`web/src/components/brand/press.tsx:48-60`).
- `Masthead`: sticky top z40, 1px `lineG` bottom border, void at 85%, 12px backdrop blur. Inner max width 1440px, horizontal 20px/vertical 24px, sigil 11px uppercase at `.22em`; ≥640px becomes `1fr auto 1fr`, horizontal 32px and 12px text. Brand starts with 8px vertical gap, 32px trident, 16px wordmark. First 90px of scroll continuously changes padding `24→14`, gap `8→0`, mark `32→28`, word height `16→0`, word opacity `1→0`, and word Y `0→-4` (`web/src/components/brand/press.tsx:63-112`, `web/src/components/brand/press.tsx:123-185`).
- `Colophon`: 1px `lineG` top border, horizontal 20px/vertical 40px; inner max width 1152px, centered column with 16px gap, sigil 11px uppercase at `.14em`, ash. At ≥640px it becomes a row, horizontal 32px; link group gap 20px, hover bone (`web/src/components/brand/press.tsx:189-209`).
- `InstallCommand`: shrink-wrapped max-width row, gap 12px, radius 6px, 1px bone border, void fill, vertical 14px, right 12px/left 16px, sigil 13px bone. Ember `$`; code is single-line/horizontally scrollable. Copy control has left margin 4px, 4px padding, bone50 → bone highlight, 16px Copy; success swaps to ember Check for 2s (`web/src/components/brand/press.tsx:212-254`).

### Brand and public assets

`Trident` loads `/brand/spawnd-icon.svg`; `Wordmark` uses `/brand/spawnd-wordmark.svg` as a CSS mask so it can take `currentColor` (`web/src/components/icons/BrandMark.tsx:13-25`, `web/src/components/icons/BrandMark.tsx:28-62`). Exact inventory:

| File | Intrinsic dimensions / viewBox | Notes and RN treatment |
|---|---|---|
| `public/brand/spawnd-icon.svg` | `538×538`, viewBox `0 0 538 538` | Transparent SVG with fixed `#E11E15` and white filled art. Bundle via Svg transformer or pre-render PNG. |
| `public/brand/spawnd-icon-black.svg` | `538×538`, same viewBox | Transparent fixed black + white variant. |
| `public/brand/spawnd-wordmark.svg` | `1753×370`, matching viewBox/aspect | Seven white filled paths used as one mask on web. RN cannot use CSS mask; render paths with desired fill/current semantic color, or pre-render required red/bone variants. |
| `public/icon.svg` | `512×512`, viewBox `0 0 512 512` | Red `#E11E15` square with black mark. App icon source. |
| `public/favicon-48.png` | `48×48` | Web favicon. |
| `public/icon-192.png` | `192×192` | PWA/maskable icon. |
| `public/icon-512.png` | `512×512` | PWA/maskable icon; useful app-icon raster source. |
| `public/og.jpg` | `2400×1260` | Social card; metadata advertises it as 1200×630 (`web/src/app/layout.tsx:18-25`). |
| `public/manifest.webmanifest` | JSON, no visual dimensions | PWA name/orientation/colors/icons; no native-rendered asset. |
| `public/sw.js` | JavaScript, no visual dimensions | Web service worker; no RN equivalent or design content. |
| `brand/ink/altar-ink.png` | `1915×821` | Marketing art. |
| `brand/ink/grid-ink.png` | `1448×1086` | Marketing poster frame. |
| `brand/ink/handoff-ink.png` | `1536×1024` | Marketing poster frame. |
| `brand/ink/hero-ink.png` | `1672×941` | Marketing poster frame. |
| `brand/ink/hosts-ink.png` | `1448×1086` | Marketing poster frame. |
| `brand/ink/pocket-ink.png` | `1122×1402` | Tall marketing poster frame. |
| `brand/ink/grid-ink.mp4` | `1024×768`, 24fps, 10.041667s | Marketing loop. |
| `brand/ink/handoff-ink.mp4` | `1024×682`, 24fps, 10.041667s | Marketing loop. |
| `brand/ink/hero-ink.mp4` | `1920×1088`, 24fps, 15.041667s | Marketing loop. |
| `brand/ink/hosts-ink.mp4` | `1024×768`, 24fps, 10.041667s | Marketing loop. |
| `brand/ink/pocket-ink.mp4` | `1024×1366`, 24fps, 10.041667s | Marketing loop. |

The PWA manifest fixes black background/theme and allows any orientation (`web/public/manifest.webmanifest:1-23`); it is not a native color-token override. All SVGs and MP4s need RN/Expo rendering equivalents; PNG/JPG assets work directly. **RECOMMEND:** keep the original files as canonical art; use `react-native-svg@15.15.5` and `expo-video@57.0.2` (registry latest verified 2026-08-22, installed through `npx expo install` for SDK compatibility) plus native images. Both work in Expo Go. Do not trace or redesign the marks.

## Theme switching mechanics

The web contract is exactly:

```ts
type ThemePreference = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";
const THEME_STORAGE_KEY = "spawn.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";
```

Preference defaults to `system`; invalid/missing/throwing storage also becomes system. System resolves through OS dark-mode media query. Setting preference writes storage, immediately resolves and applies it, updates browser `color-scheme` and theme-color chrome, and emits to an external store (`web/src/lib/theme.ts:8-64`, `web/src/lib/theme.ts:71-120`; `web/src/lib/theme-bootstrap.ts:12-25`). A media-query listener remains attached at all times but only emits/applies while preference is system (`web/src/lib/theme.ts:79-91`).

A blocking fixed script in `<head>` reads storage and stamps `<html data-theme>` plus CSS `color-scheme` before first paint; on any exception it falls back to dark. The root suppresses the expected hydration mismatch (`web/src/lib/theme-bootstrap.ts:1-25`, `web/src/app/layout.tsx:61-75`). React then updates the theme-color meta because Next may render it after the bootstrap script. The public theme-color constants are light `#FAFAFA`, dark `#070707`; remember that the actual dark content background is `#030303` (`web/src/lib/theme.ts:18-22`, `web/src/lib/theme.ts:127-145`).

Native equivalent has no HTML flash problem, but asynchronous preference loading can still flash. **RECOMMEND:** keep the splash screen visible until stored preference and bundled fonts resolve, then render the root theme atomically. Use React Native `useColorScheme()` for OS appearance and subscribe continuously only when preference is `system`. Mirror the storage key verbatim so a future shared preference migration is possible. This is fully compatible with Expo Go; the storage adapter can be selected by the central data-layer plan.

`cn(...inputs: ClassValue[])` is the web-only class composition boundary: `twMerge(clsx(inputs))` (`web/src/lib/utils.ts:1-6`). Native needs no equivalent class merger; compose typed style arrays so later state styles override base styles deterministically.

## Native token module shape

The following modules are intentionally plain TypeScript. Values are resolved literals so no Tailwind, CSS parser, runtime OKLCH conversion, or styling framework is required. Downstream implementation can copy these blocks verbatim.

### `mobile/src/theme/colors.ts`

```ts
export const lightColors = {
  background: "#FAFAFA",
  foreground: "#0F0F0F",
  muted: "#F0F0F0",
  mutedForeground: "#5B5B5B",
  card: "#FFFFFF",
  cardForeground: "#0F0F0F",
  popover: "#FFFFFF",
  popoverForeground: "#0F0F0F",
  popoverBorder: "#D7D7D7",
  popoverAccent: "#EBEBEB",
  primary: "#161616",
  primaryForeground: "#FAFAFA",
  secondary: "#EEEEEE",
  secondaryForeground: "#161616",
  accent: "#E8E8E8",
  accentForeground: "#0F0F0F",
  destructive: "#C51D28",
  destructiveForeground: "#FCFCFC",
  destructiveSoft: "rgba(197,29,40,0.10)",
  success: "#137D41",
  successSoft: "rgba(19,125,65,0.12)",
  warning: "#9D6400",
  warningSoft: "rgba(157,100,0,0.14)",
  info: "#1870A1",
  infoSoft: "rgba(24,112,161,0.12)",
  codeComment: "#6B727E",
  codeString: "#197037",
  codeKeyword: "#7945AB",
  codeNumber: "#9D5300",
  codePunct: "#6B727E",
  toneActive: "#009A4D",
  toneWaiting: "#1A89C5",
  toneIdle: "#808080",
  toneOffline: "#B7B7B7",
  border: "#DEDEDE",
  paneDivider: "#CACACA",
  input: "#DEDEDE",
  ring: "#0F0F0F",
  shell: "#EDEDED",
  terminalBg: "#FCFCFC",
  brandBg: "#F5F5F5",
  brandPanel: "#FFFFFF",
  brandWell: "#EBEBEB",
  brandHairline: "#D7D7D7",
  brandAccent: "#E11E15",
  brandAccentSoft: "rgba(225,30,21,0.12)",
} as const;

export type ThemeColors = { readonly [K in keyof typeof lightColors]: string };

export const darkColors = {
  background: "#030303",
  foreground: "#F5F5F5",
  muted: "#181818",
  mutedForeground: "#A1A1A1",
  card: "#0D0D0D",
  cardForeground: "#F5F5F5",
  popover: "#1E1E1E",
  popoverForeground: "#F5F5F5",
  popoverBorder: "#303030",
  popoverAccent: "#2E2E2E",
  primary: "#F5F5F5",
  primaryForeground: "#070707",
  secondary: "#1F1F1F",
  secondaryForeground: "#F5F5F5",
  accent: "#262626",
  accentForeground: "#F5F5F5",
  destructive: "#EA3C3F",
  destructiveForeground: "#F5F5F5",
  destructiveSoft: "rgba(234,60,63,0.14)",
  success: "#54C57A",
  successSoft: "rgba(84,197,122,0.14)",
  warning: "#E6AC3D",
  warningSoft: "rgba(230,172,61,0.14)",
  info: "#4CB0E5",
  infoSoft: "rgba(76,176,229,0.14)",
  codeComment: "#7F8793",
  codeString: "#76CF8A",
  codeKeyword: "#C699F8",
  codeNumber: "#EFB062",
  codePunct: "#8B939F",
  toneActive: "#3EC873",
  toneWaiting: "#3FB1EA",
  toneIdle: "#989898",
  toneOffline: "#525252",
  border: "#262626",
  paneDivider: "#424242",
  input: "#262626",
  ring: "#F5F5F5",
  shell: "#161616",
  terminalBg: "#0A0A0A",
  brandBg: "#050505",
  brandPanel: "#0B0B0B",
  brandWell: "#020202",
  brandHairline: "#2B2B2B",
  brandAccent: "#FF453A",
  brandAccentSoft: "rgba(255,69,58,0.14)",
} as const satisfies ThemeColors;

export const pressroomColors = {
  void: "#000000",
  char: "#120F0E",
  panelg: "#191514",
  lineG: "rgba(242,237,226,0.13)",
  lineStrong: "rgba(242,237,226,0.26)",
  bone: "#F2EDE2",
  ash: "#A39A8C",
  hellfire: "#E11E15",
  plate: "#EA2A1B",
  blood: "#7C100B",
  ember: "#FF453A",
} as const;

export const grimoireColors = {
  background: pressroomColors.void,
  foreground: pressroomColors.bone,
  muted: pressroomColors.panelg,
  mutedForeground: pressroomColors.ash,
  card: pressroomColors.char,
  cardForeground: pressroomColors.bone,
  popover: pressroomColors.panelg,
  popoverForeground: pressroomColors.bone,
  popoverBorder: pressroomColors.lineStrong,
  popoverAccent: "rgba(242,237,226,0.10)",
  primary: pressroomColors.bone,
  primaryForeground: pressroomColors.void,
  secondary: "rgba(242,237,226,0.05)",
  secondaryForeground: pressroomColors.bone,
  accent: "rgba(242,237,226,0.12)",
  accentForeground: pressroomColors.bone,
  destructive: pressroomColors.ember,
  destructiveForeground: pressroomColors.void,
  destructiveSoft: "rgba(255,69,58,0.14)",
  success: pressroomColors.ember,
  successSoft: "rgba(255,69,58,0.12)",
  warning: pressroomColors.ember,
  warningSoft: "rgba(255,69,58,0.12)",
  info: pressroomColors.ash,
  infoSoft: "rgba(163,154,140,0.14)",
  toneActive: pressroomColors.ember,
  toneWaiting: pressroomColors.ash,
  toneIdle: pressroomColors.ash,
  toneOffline: pressroomColors.lineStrong,
  border: pressroomColors.lineG,
  paneDivider: pressroomColors.lineStrong,
  input: pressroomColors.lineStrong,
  ring: pressroomColors.ember,
  brandAccent: pressroomColors.ember,
  brandAccentSoft: "rgba(255,69,58,0.14)",
} as const;

export const tabSurfaces = {
  light: { empty: "#FAFAFA", focused: "#FEFEFE", dimmed: "#F4F4F4" },
  dark: { empty: "#030303", focused: "#0A0A0A", dimmed: "#040404" },
} as const;
```

The mapped `ThemeColors` type enforces key parity without requiring dark values to equal light string literals. **RECOMMEND:** retain `satisfies ThemeColors`; do not widen `lightColors` before deriving the key type.

### `mobile/src/theme/typography.ts`

```ts
import { Platform } from "react-native";

export const fontFamily = {
  // Omit this family on Text where possible: RN's platform default is the web
  // system-ui equivalent and preserves the native San Francisco face on iOS.
  sans: Platform.select({ ios: "System", android: "sans-serif" })!,
  mono: Platform.select({
    ios: "Menlo",
    android: "monospace",
    default: "monospace",
  })!,
  sigil: Platform.select({
    ios: "SF Mono",
    android: "monospace",
    default: "monospace",
  })!,
  grimoireRegular: "IBMPlexSans_400Regular",
  grimoireMedium: "IBMPlexSans_500Medium",
  posterLight: "Rowdies_300Light",
} as const;

export const fontWeight = {
  light: "300",
  normal: "400",
  medium: "500",
  semibold: "600",
} as const;

export const fontSize = {
  microIllustration: 8.5,
  tiny: 9,
  tinyPlus: 9.5,
  ten: 10,
  tenPlus: 10.5,
  micro: 11,
  xs: 12,
  terminal: 13,
  sm: 14,
  fifteen: 15,
  base: 16,
  seventeen: 17,
  lg: 18,
  xl: 20,
  displaySm: 24,
  displayMd: 26,
  displayLg: 28,
} as const;

export const lineHeight = {
  compact: 14,
  micro: 16,
  terminal: 15.6,
  sm: 20,
  base: 24,
  lg: 28,
  xl: 32,
  none: 1,
  tight: 1.25,
  snug: 1.375,
  normal: 1.5,
  relaxed: 1.625,
  loose: 2,
} as const;

export const displayLineHeightRatio = {
  posterTightest: 0.98,
  none: 1,
  r102: 1.02,
  r104: 1.04,
  r106: 1.06,
  r108: 1.08,
  r125: 1.25,
  r130: 1.30,
  r155: 1.55,
  r160: 1.60,
} as const;

export const letterSpacing = {
  tighterEm: -0.05,
  tightEm: -0.025,
  normalEm: 0,
  wideEm: 0.025,
  sigil04Em: 0.04,
  sigil10Em: 0.10,
  sigil12Em: 0.12,
  sigil14Em: 0.14,
  sigil16Em: 0.16,
  sigil18Em: 0.18,
  sigil22Em: 0.22,
  sigil30Em: 0.30,
} as const;

export const typeStyles = {
  uiXs: { fontSize: 12, lineHeight: 16, fontWeight: "400" },
  uiSm: { fontSize: 14, lineHeight: 20, fontWeight: "400" },
  uiSmMedium: { fontSize: 14, lineHeight: 20, fontWeight: "500" },
  uiSmSemibold: { fontSize: 14, lineHeight: 20, fontWeight: "600" },
  uiBase: { fontSize: 16, lineHeight: 24, fontWeight: "400" },
  cardTitle: { fontSize: 16, lineHeight: 20, fontWeight: "600", letterSpacing: 0 },
  micro: { fontSize: 11, lineHeight: 16, fontWeight: "500" },
  sigilLabel: {
    fontFamily: fontFamily.sigil, fontSize: 11, lineHeight: 16,
    fontWeight: "500", letterSpacing: 1.76, textTransform: "uppercase",
  },
  sigilButton: {
    fontFamily: fontFamily.sigil, fontSize: 12, lineHeight: 16,
    fontWeight: "500", letterSpacing: 1.2, textTransform: "uppercase",
  },
  terminal: {
    fontFamily: fontFamily.mono, fontSize: 13, lineHeight: 15.6,
    fontWeight: "400", letterSpacing: 0,
  },
} as const;

/** [minimum px, viewport-width percent, maximum px], brand surfaces only. */
export const displayClamp = {
  c17_2_21: [17, 2, 21],
  c24_3_7_35: [24, 3.7, 35],
  c24_3_7_41: [24, 3.7, 41],
  c26_3_5_39: [26, 3.5, 39],
  c26_4_5_48: [26, 4.5, 48],
  c26_5_9_32: [26, 5.9, 32],
  c28_3_7_48: [28, 3.7, 48],
  c30_4_5_48: [30, 4.5, 48],
  c30_4_8_52: [30, 4.8, 52],
  c30_5_4_48: [30, 5.4, 48],
  c32_4_3_63: [32, 4.3, 63],
  c32_4_8_60: [32, 4.8, 60],
  c32_5_6_63: [32, 5.6, 63],
  c35_5_6_63: [35, 5.6, 63],
  c36_6_9_65: [36, 6.9, 65],
  c40_7_5_92: [40, 7.5, 92],
} as const;

/** Match CSS clamp(minPx, vw, maxPx) for the brand-only display blocks. */
export function clampDisplay(
  widthPx: number,
  minPx: number,
  vw: number,
  maxPx: number,
): number {
  return Math.min(maxPx, Math.max(minPx, widthPx * vw / 100));
}
```

React Native `letterSpacing` takes pixels, so the named `*Em` values must be multiplied by a style's font size. `typeStyles` already resolves the two shared sigil values.

### `mobile/src/theme/spacing.ts`

```ts
export const space = {
  0: 0,
  px: 1,
  0.5: 2,
  1: 4,
  1.5: 6,
  2: 8,
  2.5: 10,
  3: 12,
  3.5: 14,
  4: 16,
  5: 20,
  6: 24,
  6.5: 26,
  7: 28,
  8: 32,
  9: 36,
  10: 40,
  11: 44,
  12: 48,
  14: 56,
  16: 64,
  20: 80,
  24: 96,
  32: 128,
} as const;

export const radius = {
  xxs: 2,
  raw: 4,
  sm: 6,
  md: 8,
  lg: 10,
  xl: 12,
  xxl: 16,
  full: 9999,
} as const;

export const specialSpace = {
  threePx: 3,
  ctaVertical: 15,
  paneHalfGap: 3,
} as const;

export const borderWidth = { none: 0, hairline: 1, emphasis: 2, poster: 4 } as const;

export const chrome = {
  sidebarWidth: 264,
  sidebarRailWidth: 56,
  rowHeight: 40,
  paneGap: 6,
  contentInsetMobile: 0,
  contentInsetDesktop: 8,
  touchTarget: 44,
  terminalPaddingHorizontal: 6,
  terminalPaddingVertical: 4,
  menuViewportMargin: 8,
  menuAnchorOffset: 4,
  pickerColumnWidth: 224,
  pickerPreferredWidth: 474,
  pickerPreferredHeight: 440,
  gridUnits: 24,
  drawerMaxWidth: 264,
  drawerWidthFraction: 0.85,
  sheetTopClearance: 40,
} as const;
```

Numeric keys such as `space[0.5]` are valid JavaScript but some lint configurations prefer quoted keys (`"0.5"`). Either spelling produces the same object.

### `mobile/src/theme/effects.ts`

```ts
export const shadow = {
  sm: "0 1px 3px 0 rgba(0,0,0,0.10), 0 1px 2px -1px rgba(0,0,0,0.10)",
  md: "0 4px 6px -1px rgba(0,0,0,0.10), 0 2px 4px -2px rgba(0,0,0,0.10)",
  lg: "0 10px 15px -3px rgba(0,0,0,0.10), 0 4px 6px -4px rgba(0,0,0,0.10)",
  xl: "0 20px 25px -5px rgba(0,0,0,0.10), 0 8px 10px -6px rgba(0,0,0,0.10)",
  xxl: "0 25px 50px -12px rgba(0,0,0,0.25)",
  dialogLight: "0 25px 50px -12px rgba(0,0,0,0.20)",
  dialogDark: "0 25px 50px -12px rgba(0,0,0,0.50)",
} as const;

export const blurRadius = {
  drag: 1,
  modal: 2,
  sm: 8,
  base: 8,
  md: 12,
} as const;

export const opacity = {
  hidden: 0,
  quiet: 0.45,
  disabled: 0.50,
  pulse: 0.60,
  skeleton: 0.70,
  hoverButton: 0.90,
  opaque: 1,
} as const;

/** Apply to a color channel (for example `hexWithAlpha(colors.card, alpha.a35)`),
 * not to the whole subtree. */
export const alpha = {
  a05: 0.05,
  a08: 0.08,
  a10: 0.10,
  a12: 0.12,
  a13: 0.13,
  a14: 0.14,
  a15: 0.15,
  a20: 0.20,
  a25: 0.25,
  a26: 0.26,
  a30: 0.30,
  a35: 0.35,
  a40: 0.40,
  a45: 0.45,
  a50: 0.50,
  a55: 0.55,
  a60: 0.60,
  a70: 0.70,
  a75: 0.75,
  a80: 0.80,
  a85: 0.85,
  a90: 0.90,
  a95: 0.95,
} as const;

export const layer = {
  decorativeBack: -10,
  base: 0,
  predictiveEcho: 5,
  connecting: 6,
  tile: 10,
  paneOverlay: 20,
  mobileChrome: 30,
  floatingChrome: 40,
  modal: 50,
  tooltip: 60,
  previewPopover: 90,
  menu: 100,
  launcherDropPreview: 105,
  launcherDragGhost: 110,
  toast: 120,
} as const;
```

### `mobile/src/theme/motion.ts`

```ts
export const duration = {
  instant: 0,
  reduced: 0.01,
  launcherItemStagger: 35,
  sidebarLabelDelay: 75,
  fast: 100,
  base: 150,
  toastExitRemoval: 180,
  medium: 200,
  panel: 220,
  connectingDelay: 240,
  hoverIntent: 260,
  connectingUnmount: 260,
  overlay: 300,
  successHold: 420,
  uploadMinVisible: 420,
  jiggle: 450,
  progress: 500,
  tooltipDelay: 500,
  channelDrift: 750,
  spinner: 1000,
  uploadSheen: 1200,
  skeleton: 2000,
  copyFeedback: 2000,
  connectingSlow: 8000,
  brandMarquee: 56_000,
  grimoireSpin: 90_000,
  grimoireSpinReverse: 140_000,
  toastInfo: 5_000,
  toastAlert: 7_000,
  toastError: 8_000,
} as const;

export const easing = {
  linear: [0, 0, 1, 1],
  cssEase: [0.25, 0.1, 0.25, 1],
  in: [0.4, 0, 1, 1],
  out: [0, 0, 0.2, 1],
  inOut: [0.4, 0, 0.2, 1],
  swift: [0.32, 0.72, 0, 1],
  pulse: [0.4, 0, 0.6, 1],
} as const;

export const transition = {
  default: { duration: duration.base, easing: easing.inOut },
  quickEnter: { duration: duration.fast, easing: easing.cssEase },
  collapse: { duration: duration.medium, easing: easing.swift },
  drawer: { duration: duration.panel, easing: easing.swift },
  sheet: { duration: duration.panel, easing: easing.out },
  dialog: { duration: duration.base, easing: easing.cssEase },
  overlay: { duration: duration.overlay, easing: easing.cssEase },
  toastEnter: { duration: duration.medium, easing: easing.cssEase },
  toastExit: { duration: duration.base, easing: easing.cssEase },
} as const;

export const gesture = {
  drawerAxisLock: 8,
  drawerDismiss: 70,
  sheetDismiss: 90,
} as const;

export const transform = {
  enterScale: 0.95,
  menuSlide: 16,
  toastSlide: 16,
  drawerHiddenXPercent: -100,
  sheetHiddenYPercent: 100,
  switchThumbOffX: 2,
  switchThumbOnX: 18,
  statusPingScale: 2,
  binJiggleDegrees: [-7, 7],
  launcherHiddenScale: 0.75,
  launcherHoverScale: 1.05,
  launcherPressScale: 0.95,
} as const;

export const pattern = {
  channelDashPx: 2,
  channelPeriodPx: 8,
  channelBackgroundDriftPx: 8,
  uploadSheenBackgroundSizePercent: 200,
  uploadSheenFromPercent: 100,
  uploadSheenToPercent: -100,
} as const;

export const repeat = {
  spinner: { duration: duration.spinner, easing: easing.linear, infinite: true },
  skeleton: { duration: duration.skeleton, easing: easing.pulse, infinite: true },
  statusPing: { duration: duration.spinner, easing: easing.out, infinite: true },
  uploadSheen: { duration: duration.uploadSheen, easing: easing.linear, infinite: true },
  channelDrift: { duration: duration.channelDrift, easing: easing.linear, infinite: true },
  binJiggle: { duration: duration.jiggle, easing: easing.inOut, infinite: true },
} as const;
```

Convert the cubic tuples with `Easing.bezier(...tuple)`. “Reduced” is captured for parity with CSS, but native should normally skip/reduce the animation rather than schedule a 0.01ms clock.

### `mobile/src/theme/terminal.ts`

```ts
export const terminalMetrics = {
  fontSize: 13,
  lineHeightMultiplier: 1.2,
  lineHeight: 15.6,
  scrollbackLines: 100_000,
  snapshotLines: 10_000,
  unicodeVersion: "11",
  cursorBlink: true,
  scrollOnUserInput: true,
  smoothScrollDuration: 0,
  convertEol: false,
} as const;

export const terminalDark = {
  background: "#0A0A0A",
  foreground: "#E5E5E5",
  cursor: "#E5E5E5",
  cursorAccent: "#000000",
  selectionBackground: "rgba(255,255,255,0.30)",
  selectionInactiveBackground: "rgba(255,255,255,0.30)",
  black: "#2E3436",
  red: "#CC0000",
  green: "#4E9A06",
  yellow: "#C4A000",
  blue: "#3465A4",
  magenta: "#75507B",
  cyan: "#06989A",
  white: "#D3D7CF",
  brightBlack: "#555753",
  brightRed: "#EF2929",
  brightGreen: "#8AE234",
  brightYellow: "#FCE94F",
  brightBlue: "#729FCF",
  brightMagenta: "#AD7FA8",
  brightCyan: "#34E2E2",
  brightWhite: "#EEEEEC",
} as const;

export type TerminalPalette = { readonly [K in keyof typeof terminalDark]: string };

export const terminalLight = {
  background: "#FCFCFC",
  foreground: "#1F1F1F",
  cursor: "#1F1F1F",
  cursorAccent: "#FCFCFC",
  // These are the effective 30%-opacity overlays. Keep the supplied opaque
  // sources below if the renderer performs xterm-style opacity conversion.
  selectionBackground: "rgba(172,206,247,0.30)",
  selectionInactiveBackground: "rgba(225,230,235,0.30)",
  black: "#000000",
  red: "#CD3131",
  green: "#00BC00",
  yellow: "#949800",
  blue: "#0451A5",
  magenta: "#BC05BC",
  cyan: "#0598BC",
  white: "#555555",
  brightBlack: "#666666",
  brightRed: "#CD3131",
  brightGreen: "#14CE14",
  brightYellow: "#B5BA00",
  brightBlue: "#0451A5",
  brightMagenta: "#BC05BC",
  brightCyan: "#0598BC",
  brightWhite: "#A5A5A5",
} as const satisfies TerminalPalette;

export const terminalLightSelectionSources = {
  selectionBackground: "#ACCEF7",
  selectionInactiveBackground: "#E1E6EB",
} as const;

export const terminalPalette = (theme: "light" | "dark"): TerminalPalette =>
  theme === "light" ? terminalLight : terminalDark;
```

### `mobile/src/theme/index.ts` and the `useTheme()` contract

```ts
import { createContext, useContext } from "react";
import { darkColors, lightColors, type ThemeColors } from "./colors";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";
export const THEME_STORAGE_KEY = "spawn.theme";

export const themes: Record<ResolvedTheme, ThemeColors> = {
  light: lightColors,
  dark: darkColors,
};

export type ThemeContextValue = {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  colors: ThemeColors;
  setPreference: (next: ThemePreference) => void;
};

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === null) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

export function resolveTheme(
  preference: ThemePreference,
  osScheme: "light" | "dark" | null | undefined,
): ResolvedTheme {
  return preference === "system" ? (osScheme === "light" ? "light" : "dark") : preference;
}

export * from "./colors";
export * from "./effects";
export * from "./motion";
export * from "./spacing";
export * from "./terminal";
export * from "./typography";
```

Provider responsibilities are deliberately small: synchronously expose one resolved object, persist validated preference under `spawn.theme`, follow OS changes only in system mode, hold splash until initial storage/font resolution, and apply the resolved background to root navigation/status-bar surfaces. No component should read OS scheme or storage directly.

### External package verification snapshot (2026-08-22)

| Package | Registry latest checked | Expo Go |
|---|---:|---|
| `@expo-google-fonts/ibm-plex-sans` | `0.4.1` | Yes; font asset loaded through Expo Font |
| `@expo-google-fonts/rowdies` | `0.4.2` | Yes; font asset loaded through Expo Font |
| `expo-font` | `57.0.1` | Yes, [official SDK page](https://docs.expo.dev/versions/latest/sdk/font/) says included |
| `expo-blur` | `57.0.2` | Yes, [official SDK page](https://docs.expo.dev/versions/latest/sdk/blur-view/) says included |
| `lucide-react-native` | `1.33.0`; recommend published `1.14.0` for web parity | Yes through React + supported SVG dependency |
| `react-native-svg` | `15.15.5` | Yes, [official SDK page](https://docs.expo.dev/versions/latest/sdk/svg/) says included |
| `react-native-safe-area-context` | `5.9.1` | Yes, [official SDK page](https://docs.expo.dev/versions/latest/sdk/safe-area-context/) says included |
| `react-native-reanimated` | `4.6.0` | Yes, [official SDK page](https://docs.expo.dev/versions/latest/sdk/reanimated/) says included |
| `expo-video` | `57.0.2` | Yes, [official SDK page](https://docs.expo.dev/versions/latest/sdk/video/) says included |

“Registry latest” is evidence, not a mandate to force that number against another Expo SDK. Always use `npx expo install <package>` in the implementation branch to select Expo's compatible version; the values above satisfy the owner's request for verified current package versions.

## Final implementation decisions and validation notes

**RECOMMEND:** Build native primitives from semantic tokens and the component recipes above; never copy responsive mobile CSS behavior. The hard requirement says desktop visual language plus native interaction, and these values capture that language without the web's existing phone layout.

**RECOMMEND:** Add screenshot fixtures for both themes covering Button variants/sizes, form controls, badges/status, menus, card, dialog, drawer/sheet, toast, all agent plates, and a fixed ANSI terminal sample. Validate on a physical iPhone in Expo Go at 1× screenshot pixels, allowing only platform text rasterization differences.

**RECOMMEND:** Treat safe areas, keyboard height, accessibility reduce-motion and current OS scheme as runtime inputs; every other design value in this report should remain a literal token.

**UNKNOWN:** CSS OKLCH values outside sRGB were clipped for the native hex fallbacks (`warning`, `codeNumber`, `toneActive` light). Device screenshot comparison will determine whether the platform's future OKLCH support produces materially different gamut; current copy-ready objects intentionally choose deterministic sRGB.

**UNKNOWN:** Exact multi-lobe CSS shadow fidelity depends on the React Native renderer/New Architecture version selected by the Expo SDK. The token retains full CSS strings; device UAT decides whether `boxShadow` or a conservative single-lobe fallback is active.

**UNKNOWN:** Web `ui-monospace` can resolve to San Francisco Mono on iPhone, while React Native's most reliable unbundled iOS monospace family is Menlo. The repo commits no terminal font file. A physical-device glyph/cell comparison must decide whether `SFMono-Regular` is addressable in the chosen Expo SDK or whether Menlo is the supported fallback.

**UNKNOWN:** The external storage package and navigation/status-bar owner are outside this design-system topic. Their required contract is stated above; choosing them does not change any token.
