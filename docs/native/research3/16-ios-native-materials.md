# R16 — iOS-native materials and controls in Expo Go SDK 54

## TL;DR

- Yes: SDK 54 has `expo-glass-effect ~0.1.10`, and Expo documents that release as included in Expo Go; the registry's current `57.0.1` must not be installed into this SDK 54 app.
- The project has not installed the JavaScript package yet, so add it with `npx expo install expo-glass-effect`; no native rebuild is needed because the SDK 54 Expo Go binary already contains its native side.
- Never allow `GlassView` to become a silent plain `View`: gate it with both availability functions and Reduce Transparency, then render the installed `BlurView` fallback explicitly.
- Use Liquid Glass sparingly for floating controls and navigation chrome; use standard blur materials or solid semantic backgrounds for content, sheets, and ordinary cards.
- SDK 54 Expo Go has no safe generic single-tap native `UIMenu`/popover API; `@react-native-menu/menu`, `react-native-ios-context-menu`, and Zeego all need unbundled native code.
- Expo Router's native `Link.Menu` is available for long-pressed navigational links, while React Native's native `ActionSheetIOS` is available for short command lists but presents as a bottom action sheet on iPhone.
- The terminal should use the native-stack header and its automatic back button; its ellipsis should open a wide guarded-Glass custom popover, with `ActionSheetIOS` reserved for surfaces where a bottom action sheet is acceptable.
- SDK 54 pins `react-native-screens ~4.16.0`, which supports native `formSheet` routes, fractional detents, a system grabber, initial detent, corner radius, and detent-change events in Expo Go.
- `expo-symbols ~1.0.8` is also bundled in Expo Go 54 but absent from this project; prefer SF Symbols for Apple chrome and retain Lucide for Spawn's brand/domain imagery.
- Standardize 44pt targets, visible press fills, semantic iOS colors, restrained haptics, native headers, and native sheets before adding decorative blur; those details create most of the “proper iOS app” feel.

## 1. Decisive compatibility result

The installed baseline is Expo `54.0.37`, React Native `0.81.5`, Expo Router `~6.0.24`, `react-native-screens ~4.16.0`, `expo-blur ~15.0.8`, and `expo-haptics ~15.0.8` (`mobile/package.json:33-65`). Neither `expo-glass-effect` nor `expo-symbols` is in the project dependencies (`mobile/package.json:20-71`). The package registry currently labels `expo-glass-effect 57.0.1` as latest, but that is the SDK 57 line, not a compatible choice for this app ([npm versions](https://www.npmjs.com/package/expo-glass-effect?activeTab=versions)).

The SDK 54 facts are unambiguous:

> `"expo-glass-effect": "~0.1.10"`
>
> `"expo-symbols": "~1.0.8"`
>
> `"react-native-screens": "~4.16.0"`

Those are the exact SDK 54 pins in Expo's [official `bundledNativeModules.json`](https://raw.githubusercontent.com/expo/expo/sdk-54/packages/expo/bundledNativeModules.json). More decisively, the versioned SDK 54 GlassEffect page says **“Included in Expo Go”**, recommends `~0.1.10`, and describes `GlassView` as native `UIVisualEffectView` ([Expo SDK 54 GlassEffect](https://docs.expo.dev/versions/v54.0.0/sdk/glass-effect/)). Expo's SDK 54 release notes likewise say the UIKit implementation is the best choice for most Expo apps and that the SDK 54/Xcode 26 build supports Liquid Glass ([Expo SDK 54 changelog](https://expo.dev/changelog/sdk-54#using-liquid-glass-views-in-your-app)). Expo explains the underlying rule separately: Expo Go has a fixed native binary and can only expose native libraries already compiled into it ([development-build FAQ](https://docs.expo.dev/develop/development-builds/faq/)).

**Answer:** there is an SDK 54-compatible release, `expo-glass-effect ~0.1.10`, and it is included in Expo Go 54. Installing its version-matched JavaScript package is sufficient to access the already-compiled native module; installing the current `57.0.1` is not.

**RECOMMEND:** have the fix agent run `npx expo install expo-glass-effect` so Expo resolves `~0.1.10`. This is the only appropriate installation path. It adds a first-party, version-pinned JS dependency and requires no config plugin or native rebuild, so it is Expo Go 54 compatible.

### Do not permit the unsupported-platform no-op

`GlassView` exists only on iOS 26+, and Expo explicitly says it falls back to a regular `View` on unsupported platforms. Rendering it unconditionally would therefore silently remove the material on an older device, an incompatible compiled binary, or a Reduce Transparency setup. Expo provides two checks and warns that some early iOS 26 runtimes can crash unless the runtime API check is used ([SDK 54 GlassEffect availability APIs](https://docs.expo.dev/versions/v54.0.0/sdk/glass-effect/#isliquidglassavailable)).

Use one shared material primitive with this decision, not scattered direct `GlassView` calls:

```tsx
import {
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
} from "expo-glass-effect";
import { BlurView } from "expo-blur";
import { AccessibilityInfo, Platform } from "react-native";

// Keep reduceTransparency in state from AccessibilityInfo's async query/event.
const useGlass =
  Platform.OS === "ios" &&
  !reduceTransparency &&
  isLiquidGlassAvailable() &&
  isGlassEffectAPIAvailable();

return useGlass ? (
  <GlassView glassEffectStyle="regular" style={styles.fill}>{children}</GlassView>
) : (
  <BlurView
    intensity={92}
    tint={theme.isDark ? "systemMaterialDark" : "systemMaterialLight"}
    style={styles.fill}
  >
    {children}
  </BlurView>
);
```

`AccessibilityInfo` is React Native core, hence present in Expo Go's bundled RN `0.81.5`; Expo also directs callers to `AccessibilityInfo.isReduceTransparencyEnabled()` because `isLiquidGlassAvailable()` can remain true when accessibility has reduced the effect ([Expo accessibility note](https://docs.expo.dev/versions/v54.0.0/sdk/glass-effect/#isliquidglassavailable)). On non-iOS platforms, the shared primitive needs a solid theme surface rather than attempting an iOS material.

**RECOMMEND:** use `glassEffectStyle="regular"` for menus and text-bearing popovers. Apple says regular maintains legibility and is the variant most system components use; `clear` is only for controls floating over rich media, with a 35% dark dimming layer when the media is bright ([Apple HIG — Materials](https://developer.apple.com/design/human-interface-guidelines/materials)). Do not set `opacity < 1` on a `GlassView` or any ancestor, because Expo documents incorrect rendering; `isInteractive` is mount-only, so remount with a new `key` if that behavior changes ([Expo known issues](https://docs.expo.dev/versions/v54.0.0/sdk/glass-effect/#known-issues)).

## 2. Standard materials: the reliable fallback and content-layer treatment

`expo-blur` is already installed (`mobile/package.json:34`) and its SDK 54 page says it is included in Expo Go at `~15.0.8` ([Expo SDK 54 BlurView](https://docs.expo.dev/versions/v54.0.0/sdk/blur-view/)). Its iOS contract is:

- `intensity`: `1..100`, default `50`; use it to tune how strongly background detail is suppressed.
- `tint`: `light`, `dark`, `default`, `extraLight`, `regular`, `prominent`; or the semantic system materials below.
- Thickness families: `systemUltraThinMaterial`, `systemThinMaterial`, `systemMaterial`, `systemThickMaterial`, `systemChromeMaterial`.
- Explicit appearance variants: append `Light` or `Dark` to every system family, for example `systemThinMaterialLight` and `systemChromeMaterialDark`.
- Rounded clipping: `borderRadius` alone does not clip the blur; the material view must have `overflow: "hidden"` ([Expo border-radius note](https://docs.expo.dev/versions/v54.0.0/sdk/blur-view/#using-borderradius-with-blurview)).

These tint strings map directly to UIKit's semantic `UIBlurEffect.Style` cases with the same names. Apple says material thickness changes how much underlying content shows through, and says to select materials by semantic role rather than apparent color because accessibility and appearance settings can alter them ([Apple HIG — standard materials](https://developer.apple.com/design/human-interface-guidelines/materials#Standard-materials)).

### Spawn material recipe

| Surface | iOS 26 first choice | Explicit SDK 54 fallback | Treatment |
|---|---|---|---|
| Ellipsis menu / anchored popover | `GlassView`, `regular`, noninteractive material surface | `BlurView`, `systemMaterialLight/Dark`, intensity `92` | Rounded inner clip; semantic hairline; outside shadow; semantic labels/fills |
| Compact floating toolbar / icon control group | `GlassView`, `regular`, `isInteractive` fixed at mount | `systemThinMaterialLight/Dark`, intensity `86` | 44pt controls; no extra surface opacity; pressed fill inside each control |
| Sticky app header | Native-stack system header first | `headerTransparent: true` plus `headerBlurEffect: "systemChromeMaterial"` only if a translucent custom appearance is required | Let the navigation controller own top safe area and back behavior |
| Native form sheet | Native `formSheet` presentation and system grabber | Solid `systemBackground` content in the native sheet | Do not blur the entire content layer; glass is only for floating sheet chrome |
| Dialog/custom overlay that cannot become a route | `GlassView regular` only if it is transient functional chrome | `systemMaterialLight/Dark`, intensity `94` | Retain a dim scrim; solid fallback when Reduce Transparency is enabled |
| Content card/list/terminal canvas | No Liquid Glass | Solid theme/system background, or standard material only where content layers need separation | Apple explicitly says not to put Liquid Glass in the content layer |

The visual construction should use two wrappers so clipping does not cut off the shadow:

```tsx
const outer = {
  shadowColor: "#000",
  shadowOpacity: 0.20,
  shadowRadius: 22,
  shadowOffset: { width: 0, height: 10 },
};
const clip = {
  borderRadius: 16,
  borderWidth: StyleSheet.hairlineWidth,
  borderColor: PlatformColor("separator"),
  overflow: "hidden" as const,
};
```

Put the `GlassView`/`BlurView` inside `clip`; never animate opacity on `outer`, `clip`, or a Glass ancestor. For a true `GlassView`, start without an extra color wash or heavy border—the native material supplies its own specular edge—and keep only the semantic hairline if contrast testing shows it is needed. For the `BlurView` fallback, a subtle overlay using `PlatformColor("systemFill")` may provide the control-layer fill, while text/icons use `labelColor`, `secondaryLabelColor`, `tertiaryLabelColor`, `separator`, and `systemRedColor` equivalents behind an iOS platform check. React Native's `PlatformColor` resolves native semantic colors and follows theme/high-contrast changes ([RN 0.81 PlatformColor](https://reactnative.dev/docs/0.81/platformcolor)).

This is an approximation of vibrancy, not UIKit `UIVibrancyEffect`: `expo-blur` exposes blur/tint/intensity but no vibrancy subview API. True Liquid Glass also adds adaptive refraction, highlights, and interaction behavior that `BlurView` cannot reproduce. **RECOMMEND:** name the fallback `StandardMaterialSurface`, not `LiquidGlass`, and do not claim parity when the guard chooses blur.

## 3. Native menus and popovers: exact limits

The terminal currently does not use a native menu. Its ellipsis opens the app's `Menu` (`mobile/src/components/terminal-ui/terminal-header.tsx:202-225`), which renders a custom React Native `Modal presentationStyle="overFullScreen"` with a themed rectangle (`mobile/src/components/ui/popover.tsx:327-371`). The default width is `theme.space(44)` (`mobile/src/components/ui/menu.tsx:72-84`), and `space(units)` is `units * 4`, so the observed surface is only **176pt** (`mobile/src/theme/spacing.ts:28-30`). The seven ordinary commands plus a destructive command are React Native `Pressable` rows (`mobile/src/components/terminal-ui/terminal-header.tsx:89-140`). Web's generic desktop menu also starts at `min-w-44`/176px, but that is a mouse-sized minimum, not an instruction to retain the narrow phone menu (`web/src/components/ui/dropdown-menu.tsx:193-213`).

### First-party and community options

| Option | Genuinely native? | Expo Go 54? | Finding |
|---|---|---|---|
| A package named `expo-context-menu` | No first-party package exists | **No** | It is absent from the SDK 54 native-module manifest. The similarly named `@appandflow/expo-context-menu` is a third-party custom cross-platform React Native menu, not UIKit ([npm package](https://www.npmjs.com/package/@appandflow/expo-context-menu)). It would not improve native fidelity. |
| `@expo/ui` SwiftUI `Menu`/`ContextMenu` | Yes | **No on SDK 54 Expo Go** | SDK 54 has a version mapping for the beta package, but Expo says Expo UI was first bundled into Expo Go in SDK 56 ([Expo UI stable announcement](https://expo.dev/blog/expo-ui-stable-sdk-56)). Do not import the current SDK 57 ContextMenu docs into this SDK 54 project. |
| Expo Router `Link.Menu` | Yes, iOS context menu | **Yes** | Router `~6.0.24` is installed (`mobile/package.json:49`) and documented as included in Expo Go. `Link.MenuAction` supports SF Symbol icons, disabled/on state, destructive styling, submenus, and long-press link previews ([SDK 54 Router API](https://docs.expo.dev/versions/v54.0.0/sdk/router/), [Link preview/menu guide](https://docs.expo.dev/router/reference/link-preview/#menu)). It only belongs to a navigational `Link`; it is not a generic tap-to-open ellipsis menu. |
| React Native `ActionSheetIOS` | Yes, UIKit action sheet | **Yes** | It is RN `0.81` core, so no package/native module is added. It supports cancel, destructive and disabled indices plus an iPad anchor ([RN ActionSheetIOS](https://reactnative.dev/docs/0.81/actionsheetios)). On iPhone it is a bottom action sheet, not an anchored popover, and it provides no per-row icons or width control. |
| `@react-native-menu/menu` | Yes, `UIMenu` | **No** | Its installation performs native linking/Pods and its podspec compiles `ios/**/*.{h,m,mm,swift}` ([repository](https://github.com/react-native-menu/menu), [podspec](https://github.com/react-native-menu/menu/blob/master/react-native-menu.podspec)). It is not in Expo Go 54's [supported third-party list](https://docs.expo.dev/versions/v54.0.0/sdk/third-party-overview/), so a JS install cannot work. |
| `react-native-ios-context-menu` | Yes, `UIContextMenuInteraction` | **No** | Its SDK 54-compatible release still consists of native iOS code and is not bundled in Expo Go ([RN 0.81/Expo 54 release](https://github.com/dominicstop/react-native-ios-context-menu/releases/tag/v3.2.0), [Expo Go native-library rule](https://docs.expo.dev/develop/development-builds/faq/)). It requires a development build. |
| Zeego | Native wrappers on iOS/Android | **No** | Zeego wraps `react-native-ios-context-menu` and `@react-native-menu/menu`; its own upgrade instructions say to install those native dependencies and rebuild with `expo prebuild`/`expo run:ios` ([Zeego release instructions](https://github.com/nandorojo/zeego/releases)). That directly violates the Expo Go requirement. |

There is one tempting but unsafe API: the nested React Navigation JS package exposes experimental `unstable_headerRightItems` and can describe a menu (`mobile/node_modules/expo-router/node_modules/@react-navigation/native-stack/src/types.tsx:327-352`), then forwards `headerRightBarButtonItems` (`mobile/node_modules/expo-router/node_modules/@react-navigation/native-stack/src/views/useHeaderConfigProps.tsx:541-545`). However, SDK 54's pinned native `react-native-screens 4.16.0` header config has no corresponding bar-button-items prop (`mobile/node_modules/react-native-screens/src/types.tsx:545-610`). **RECOMMEND:** do not use this experimental JS/native version mismatch in Expo Go 54; it may be silently ignored or warn rather than produce the desired `UIMenu`.

### Recommended terminal interaction

**RECOMMEND:** combine the native pieces that are reliable instead of forcing the wrong native presentation:

1. Make the terminal a normal pushed native-stack card with `headerShown: true`; leave `headerLeft` unset so UIKit supplies the back button.
2. Put only the session title in the header. Remove the CWD row, as requested. Keep the connection state aligned in content immediately below the header if it cannot fit without crowding.
3. Render a 44×44 `Pressable` ellipsis in `headerRight`, using the SF Symbol `ellipsis` once `expo-symbols` is added.
4. On tap, open the existing anchored popover geometry rebuilt on the guarded `GlassView regular`/`BlurView systemMaterial` primitive. This is native material around React Native menu content; it is not falsely described as a native `UIMenu`.
5. Use `ActionSheetIOS` only for simpler surfaces where an iPhone bottom sheet is acceptable. Use `Link.Menu` for long-press actions on workspace/session rows that are already links. Push advanced actions such as diagnostics or font settings to a normal card route, which then gets a normal native back button.

**UNKNOWN:** a genuinely native, single-tap, anchored ellipsis `UIMenu` is not achievable in the Expo Go 54 binary with a supported stable API. Achieving that exact control requires either leaving Expo Go for a development build and adding a native menu library, or upgrading to a later SDK/API set after a separate compatibility pass.

### Menu geometry and HIG truth

Apple's public HIG does **not** publish a numeric minimum menu width, row height, horizontal padding, corner radius, or separator inset. It does require comfortable controls (default iOS control size `44×44pt`), visible press states, a small number of context actions, logical groups separated visually, no more than about three groups, short labels, and destructive actions last and marked destructive/red ([Apple accessibility sizes](https://developer.apple.com/design/human-interface-guidelines/accessibility#Mobility), [Apple buttons](https://developer.apple.com/design/human-interface-guidelines/buttons), [Apple context menus](https://developer.apple.com/design/human-interface-guidelines/context-menus), [Apple menus](https://developer.apple.com/design/human-interface-guidelines/menus)).

**UNKNOWN:** any claim that “Apple HIG requires a 280pt menu, 48pt row, 16pt padding, or a particular separator inset” would be fabricated. The following exact numbers are therefore the **Spawn phone fallback specification**, chosen to satisfy the HIG's actual 44pt and organization rules and to fix the owner's too-narrow result:

| Part | Spawn exact rule | HIG-derived part |
|---|---|---|
| Ellipsis trigger | 44×44pt hit region; 18–20pt symbol centered | 44×44 default touch target and visible pressed state are HIG |
| Surface width | `minWidth: 280`; `maxWidth: min(320, viewportWidth - 32)`; grow for Dynamic Type before truncating | HIG gives no numeric width; 16pt screen margins and 280–320 are Spawn rules |
| Row | `minHeight: 48`; horizontal padding 12; vertical padding 10; never shrink below 44 | Only the ≥44 interaction size is HIG; 48/12/10 are Spawn rules |
| Icon/label | 20pt icon in a 24pt frame; 10pt gap; 17/22 system/body label; one line except accessibility sizes | HIG requires short, clear labels and familiar symbols; metrics are Spawn rules |
| Surface padding/radius | 6pt internal padding; 16pt radius | Spawn rule; system-native surfaces should retain system geometry instead |
| Separator | `StyleSheet.hairlineWidth`, semantic `separator`, 4pt vertical margin, 46pt leading inset when rows have icons | HIG requires separators/logical groups but gives no numeric inset |
| Destructive | Final group, final item, red semantic label and `trash`; pressed fill only, never a permanent red row background | Placement and destructive marking/red are HIG |
| Organization | Frequent actions first; maximum about three groups; move advanced configuration to a route | HIG |

The current menu already uses ≥44pt rows and destructive color, but only haptics after selection (`mobile/src/components/ui/menu.tsx:119-165`). Its 176pt default width and eight-item flat command inventory are the primary geometry/information issues.

## 4. Native-stack headers are the native back-button solution

Expo Router's `Stack` is backed by native stack/`react-native-screens`, which SDK 54 includes in Expo Go ([SDK 54 supported third-party libraries](https://docs.expo.dev/versions/v54.0.0/sdk/third-party-overview/)). The supported native-header surface includes:

- automatic UIKit back button and long-press back-history menu; `headerBackButtonDisplayMode` supports `default`, `generic`, and `minimal`;
- `headerRight`, which hosts a React element in the native navigation bar;
- iOS large titles, with `contentInsetAdjustmentBehavior="automatic"` on the associated `ScrollView`/`FlatList` so they collapse correctly;
- native `headerSearchBarOptions`, again paired with automatic content inset behavior;
- semantic header blur via `headerBlurEffect`, if an explicitly translucent header is needed.

These options and caveats are documented by [React Navigation's native-stack reference](https://reactnavigation.org/docs/native-stack-navigator/); the exact pinned screens source includes native back-display modes, all system blur-effect strings, native search, large title, and header-right slots ([react-native-screens 4.16.0 types](https://raw.githubusercontent.com/software-mansion/react-native-screens/4.16.0/src/types.tsx)). `headerRight` is not itself a native menu—it is simply the reliable insertion point for the guarded custom ellipsis button.

The app currently disables this entire facility globally (`headerShown: false` at `mobile/src/app/_layout.tsx:86-97`). The terminal then repeats `headerShown: false`, disables its gesture, and removes animation (`mobile/src/app/terminal/[sessionId].tsx:34-42`), while its custom header manually adds `insets.top + 8` (`mobile/src/components/terminal-ui/terminal-header.tsx:142-155`). That combination explains both the non-native back control and part of the safe-area overcompensation.

**RECOMMEND:** override the terminal route with a native header, do not provide `headerLeft`, and use the system default back display unless owner testing prefers `minimal`. Native roots such as Workspaces/Hosts may use large titles; the terminal should use a compact title. Native search belongs on searchable root/list screens, not as a decorative terminal header field. Do not manually add `insets.top` below a visible native header.

## 5. Native sheet presentation in the pinned binary

SDK 54 pins `react-native-screens ~4.16.0` in both this project (`mobile/package.json:65`) and Expo's [SDK 54 module manifest](https://raw.githubusercontent.com/expo/expo/sdk-54/packages/expo/bundledNativeModules.json). The exact `4.16.0` source supports the following only when presentation is `formSheet`:

> `sheetAllowedDetents?: number[] | 'fitToContents' | 'medium' | 'large' | 'all'`
>
> `sheetCornerRadius?: number`
>
> `sheetGrabberVisible?: boolean`
>
> `sheetInitialDetentIndex?: number | 'last'`

It also supports `sheetExpandsWhenScrolledToEdge`, `sheetLargestUndimmedDetentIndex`, and an `onSheetDetentChanged` native event carrying the detent index and stability. Fractions must be ascending; iOS accepts any count, Android uses at most three; an omitted/negative corner radius uses the system default ([react-native-screens 4.16.0 sheet types](https://raw.githubusercontent.com/software-mansion/react-native-screens/4.16.0/src/types.tsx)). The iOS implementation is `UIModalPresentationFormSheet`, so this is native and Expo Go 54 compatible through the bundled `react-native-screens` binary.

Express it through Expo Router at the owning stack:

```tsx
<Stack.Screen
  name="workspace-actions"
  options={{
    presentation: "formSheet",
    headerShown: true,
    title: "Workspace actions",
    sheetAllowedDetents: [0.35, 0.72],
    sheetInitialDetentIndex: 0,
    sheetGrabberVisible: true,
    // Omit sheetCornerRadius to retain UIKit's current system default.
  }}
/>
```

Then open it with `router.push("/workspace-actions")`; the route owns its content and dismissal. Expo's form-sheet guide confirms the Router option names and detent semantics ([Expo Router modals](https://docs.expo.dev/router/advanced/modals/#form-sheet-presentation)). That guide also states that correct `flex: 1` behavior with custom numeric iOS detents begins in SDK 55; on this SDK 54 app, give sheet content an explicit/minimum height and do not rely on a lone flex fill. `fitToContents` likewise needs explicit content sizing.

**RECOMMEND:** convert route-like custom overlays—create/edit workspace, multi-step selectors, diagnostics, host/workspace action forms—to native `formSheet`. Omit `sheetCornerRadius` unless the web parity requirement proves a custom value necessary; the system default is the more future-proof iOS 26 choice. Keep the existing Gorhom sheet only for an interaction that must remain mounted inside the same route or has animation/gesture behavior native form-sheet cannot supply. The current generic Sheet is a custom `BottomSheetModal` with its own background, radius, shadow, safe-area math, and 48%/90% snap defaults (`mobile/src/components/ui/sheet.tsx:62-153`); replacing route surfaces removes a large source of bespoke chrome.

For optional detent feedback, listen for `sheetDetentChange`, cache the previous index, and call `haptics.selection()` only when the event is stable and the index actually changed. That event and `expo-haptics` are both in the Expo Go 54 binary; do not fire on every intermediate frame.

## 6. SF Symbols for platform chrome

Yes: Expo's SDK 54 page says `expo-symbols ~1.0.8` is included in Expo Go, exposes native SF Symbols through `SymbolView`, and provides a React-node fallback for Android/web ([Expo SDK 54 Symbols](https://docs.expo.dev/versions/v54.0.0/sdk/symbols/)). It is present in the SDK 54 manifest but absent from this project (`mobile/package.json:20-71`).

**RECOMMEND:** add it with `npx expo install expo-symbols`, resolving `~1.0.8`. As with GlassEffect, this adds the version-matched JS package while the native implementation is already compiled into Expo Go 54; no rebuild/config plugin is required. The package is marked beta, so isolate it behind the app's `Icon`/`PlatformIcon` abstraction rather than importing `SymbolView` throughout screens.

Prefer SF Symbols wherever the icon communicates standard Apple chrome:

| Current/domain intent | iOS SF Symbol | Rule |
|---|---|---|
| More, add, close, search | `ellipsis`, `plus`, `xmark`, `magnifyingglass` | Always SF Symbol in iOS headers, menus, nav, and control chrome |
| Delete, edit, refresh, copy | `trash`, `pencil`, `arrow.clockwise`, `doc.on.doc` | SF Symbol in commands; destructive styling remains semantic red |
| Upload/share, archive, settings | `square.and.arrow.up`, `archivebox`, `gearshape` | SF Symbol in generic platform actions |
| Folder/navigation disclosure | `folder`, `chevron.down` | SF Symbol in chrome; leave the actual back chevron to native stack |
| Agent/vendor mark, terminal/PTY identity, host/workspace artwork, trust/network concept | existing Lucide/custom `AgentIcon`/brand asset | Keep Lucide/custom art because these are Spawn domain semantics, not Apple chrome |

Use `type="monochrome"` for ordinary chrome and `hierarchical` only when hierarchy communicates state. Match symbol `weight` to adjacent system text and pass the existing Lucide element through `fallback` for Android/web. This is Expo Go compatible through `expo-symbols`; Lucide remains JS/SVG and is already installed (`mobile/package.json:56,66`).

## 7. Haptics, highlighting, and native-feel details

`expo-haptics ~15.0.8` is installed (`mobile/package.json:42`), pinned in Expo's SDK 54 native-module manifest, and exposes iOS selection, impact, and notification feedback ([SDK 54 module manifest](https://raw.githubusercontent.com/expo/expo/sdk-54/packages/expo/bundledNativeModules.json), [Expo SDK 54 Haptics](https://docs.expo.dev/versions/v54.0.0/sdk/haptics/)). It is therefore Expo Go 54 compatible without another dependency or rebuild. The app already wraps it with repeat suppression and named `overlayOpen`/`overlayDismiss` effects (`mobile/src/lib/haptics.ts:1-25`, `mobile/src/lib/haptics.ts:65-73`). The generic sheet already fires selection feedback when its snap index changes (`mobile/src/components/ui/sheet.tsx:103-107`), and the menu fires only after an item is selected (`mobile/src/components/ui/menu.tsx:121-131`).

**RECOMMEND:** standardize these cues:

- custom menu/popover opens: one light impact (`haptics.overlayOpen()`); do not also fire it when a system-native control already provides feedback;
- menu highlight changes during drag/keyboard selection: `selection()` once per changed item, not continuously;
- stable native-sheet detent change: `selection()` once per changed index;
- irreversible action: warning notification at the actual commit/confirmation, not merely when the destructive menu row is highlighted;
- success/error: notification feedback only when an asynchronous outcome resolves; never use haptics as the sole state indication.

Use React Native `Pressable` for custom iOS controls. It exposes pressed-state styling and `hitSlop`; `TouchableNativeFeedback` is Android-only and supplies Android ripples, not an iOS-native treatment ([RN Pressable](https://reactnative.dev/docs/0.81/pressable), [RN TouchableNativeFeedback](https://reactnative.dev/docs/0.81/touchablenativefeedback)). On iOS, change a semantic fill immediately on `pressed`—for example `systemFill`/the app's accent role—and optionally scale an isolated icon by at most 0.97. Do not fade the Glass surface or a parent. Every custom icon button must retain a 44×44 hit target even if its visual glyph is 18–20pt; Apple explicitly requires a press state for custom buttons ([Apple HIG — Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons)). All of these APIs are React Native core or the already-installed `expo-haptics`, so they work in Expo Go 54.

## 8. Capability table for the fix batch

| Feature | Available in Expo Go 54? | Recommended implementation | Explicit fallback |
|---|---|---|---|
| True iOS 26 Liquid Glass | **Yes**, after adding JS `expo-glass-effect ~0.1.10` | Guarded `GlassView regular` for transient control/navigation chrome | `BlurView systemMaterialLight/Dark`; solid semantic surface for Reduce Transparency/non-iOS |
| Morphing/combined glass controls | **Yes**, same package | `GlassContainer` only for closely related floating controls; fixed mount-time interactivity | Separate standard-material controls; never fake morphing with opacity |
| Standard iOS materials | **Yes**, installed `expo-blur ~15.0.8` | Semantic system tints; `systemChromeMaterial` for explicit chrome, `systemMaterial` for menus, `systemThinMaterial` for light floating controls | Solid theme/system background |
| Native semantic colors | **Yes**, RN core | Platform-checked `PlatformColor` tokens for labels, fills, separator, destructive state | Existing theme tokens |
| Generic first-party `expo-context-menu` | **No** | Do not install the similarly named third-party custom package | `Link.Menu`, `ActionSheetIOS`, or guarded-Glass custom menu according to interaction |
| Native long-press link context menu | **Yes**, installed Router 6 | `Link.Menu`/`Link.MenuAction` on navigational rows | Existing custom long-press menu on non-iOS |
| Native iPhone action sheet | **Yes**, RN core | `ActionSheetIOS` for small flat command sets where bottom presentation is acceptable | Guarded-Glass custom menu / app Sheet on non-iOS |
| Native single-tap anchored ellipsis `UIMenu` | **No stable compatible API** | 44pt `headerRight` Pressable opening guarded-Glass 280–320pt custom popover | `ActionSheetIOS`; development build plus native menu library outside current scope |
| `@react-native-menu/menu` / iOS context-menu library / Zeego | **No** | Do not add under Expo Go constraint | Current custom menu rebuilt to this report's material/geometry spec |
| Native back button/header/right slot | **Yes**, Router + screens bundled | Native `Stack`, leave `headerLeft` unset; custom `headerRight` only where needed | Existing custom header only on a surface native stack genuinely cannot express |
| Native large title/search | **Yes** | Large titles on list roots; `headerSearchBarOptions` with automatic content insets | In-content SearchField for cross-platform/specialized search |
| Native iOS form sheet/detents/grabber/corner | **Yes**, screens `4.16.0` | Router route with `presentation: "formSheet"`, ascending fractions, system corner, visible grabber | Existing Gorhom sheet only for same-route/unsupported interactions |
| SF Symbols | **Yes**, after adding JS `expo-symbols ~1.0.8` | SF Symbols for iOS chrome behind one abstraction | Lucide fallback and Lucide/custom assets for Spawn domain/brand icons |
| Selection/impact/notification haptics | **Yes**, installed `expo-haptics` | Existing wrapper; open, stable detent, outcome cues with deduplication | Visual/audio state only when haptics unavailable |
| iOS custom press feedback | **Yes**, RN core | `Pressable`, semantic pressed fill, 44pt hit area; no ripple | Existing theme pressed token; Android `android_ripple` only on Android |

**RECOMMEND:** implementation order is (1) enable native-stack headers/back and remove duplicate safe-area padding, (2) convert route-like overlays to native form sheets, (3) add the two exact first-party JS dependencies and a guarded material/icon abstraction, (4) rebuild the terminal menu to the 280–320pt custom specification, and (5) apply standardized press/haptic behavior. This yields genuine system behavior wherever Expo Go 54 exposes it and labels every remaining custom approximation honestly.
