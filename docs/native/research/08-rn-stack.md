# R08 — React Native / Expo stack selection (verified, Expo Go compatible)

## TL;DR

1. Expo SDK 57.0.15 is current stable, but the App Store Expo Go client still supports SDK 54 only; build v1 on Expo `~54.0.37`, React Native `0.81.5`, and React `19.1.0`.
2. Use Expo Router `~6.0.24` with a native stack; present the terminal as a `card` with a vertical full-screen dismiss gesture, because `fullScreenModal` cannot be gesture-dismissed.
3. Use Reanimated `~4.1.1`, Worklets `0.5.1`, Gesture Handler `~2.28.0`, Pager View `6.9.1`, and the New Architecture that Expo Go already enforces.
4. Use plain React Native `StyleSheet` plus a typed token/theme module; NativeWind's Tailwind-v4 path is still preview, while Unistyles 3 requires native Nitro code and cannot run in Expo Go.
5. Use TanStack Query `5.101.4` for server state, Zustand `5.0.15` for client/session state, selectors for all derived values, and AsyncStorage `2.2.0` for query persistence.
6. Use SecureStore `~15.0.8` only for small secrets, AsyncStorage for preferences/cache, and SQLite `~16.0.10` when the offline catalogue outgrows key/value persistence; MMKV cannot run in Expo Go.
7. Use FlashList `2.0.2` for long/recycling lists and FlatList for short lists; FlashList v2 is bundled in SDK 54 Expo Go and requires the New Architecture.
8. Use Router modals for navigable overlays, Gorhom Bottom Sheet `5.2.14` for interactive sheets, and custom Reanimated gestures only when the native stack/sheet cannot express the interaction.
9. Native WebRTC is impossible in Expo Go: `react-native-webrtc` needs native code, so the v1 terminal must keep WebRTC DataChannels and terminal emulation inside the bundled WebView boundary.
10. Remote push, Face ID, custom URL-scheme OAuth, true app splash rendering, and native WebRTC cannot be proved in stock Expo Go; gate or defer them, then move to SDK 57 plus an EAS development build.

## Scope, method, and source policy

Research was performed on **2026-08-22 (Pacific/Auckland)**. Package versions were checked against the live npm registry. Expo/React Native behavior was checked against current official documentation and the SDK 54 source branch, not inferred from old SDK behavior.

The repo facts that constrain this choice are:

- spawn's terminal bytes, replay, viewport control, and file transfer use authenticated browser-to-daemon WebRTC DataChannels; server WebSockets carry control/signalling, not terminal content (`README.md:42-47`).
- The web app is Next.js/xterm, the server is FastAPI, and the daemon owns the PTYs (`README.md:29-38`).
- Node `22.19.x` and Bun `1.3.14+` are already the repository development baseline (`README.md:55-59`).
- The root package has no workspace declaration and only a root `dev` script (`package.json:1-7`). A self-contained `mobile/package.json` therefore will not be pulled into the existing root lifecycle unless a future change explicitly does so.
- Web already uses Biome, TypeScript 5.9, React Query, Lucide, Zod, and Bun (`web/package.json:11-15`, `web/package.json:19-60`).

Primary external version sources:

- [Expo current SDK matrix](https://docs.expo.dev/versions/latest/)
- [Expo SDK 57 release and App Store status](https://expo.dev/changelog/sdk-57)
- [Expo SDK 54 release/tool requirements](https://expo.dev/changelog/sdk-54)
- [Expo's current physical-device project instruction](https://docs.expo.dev/get-started/create-a-project/)
- [SDK 54 bundled native compatibility manifest](https://unpkg.com/expo@54.0.37/bundledNativeModules.json)
- [SDK 54 Expo Go package source](https://github.com/expo/expo/blob/sdk-54/apps/expo-go/package.json)
- [SDK 54 Expo Go iOS Podfile](https://github.com/expo/expo/blob/sdk-54/apps/expo-go/ios/Podfile)
- [SDK 54 third-party libraries built into Expo Go](https://docs.expo.dev/versions/v54.0.0/sdk/third-party-overview/)

## 1. Expo SDK selection

### Current stable versus the required physical-iPhone baseline

| Item | Current fact on 2026-08-22 | Decision |
|---|---|---|
| Current stable Expo package | `expo@57.0.15` ([npm registry](https://registry.npmjs.org/expo/latest)) | Do not use for stock Expo Go v1 yet. |
| SDK 57 framework pins | RN `0.86` (current patched Expo uses RN `0.86.2`), React `19.2.3`, Node `22.13.x+` | Post-Expo-Go target. |
| SDK 57 platform floor | iOS `16.4+`, Xcode `26.4+`, Android `7+`, compile/target API 36 | Post-Expo-Go target. |
| App Store / Play Store Expo Go | Still SDK 54 while Expo waits for SDK 57 store approval | Hard v1 boundary. |
| SDK 54 framework pins | Expo `~54.0.37`, RN `0.81.5`, React `19.1.0` | **Selected v1 stack.** |
| SDK 54 tooling floor | Node `20.19.4+`, Xcode `16.1+` (Xcode 26 recommended) | Repo Node `22.19.x` is valid. |
| SDK 54 platform floor | iOS `15.1+`, Android `7+`, compile/target API 36 | Wider device coverage than SDK 57. |

The [current Expo SDK matrix](https://docs.expo.dev/versions/latest/#each-expo-sdk-version-depends-on-a-react-native-version) lists SDK 57 with RN 0.86, React 19.2.3, Node 22.13.x, iOS 16.4+, and Xcode 26.4+. The [SDK 57 changelog](https://expo.dev/changelog/sdk-57) says `expo@57.0.9+` moves to RN 0.86.2 to fix a Hermes/Reanimated memory regression, and explicitly says the store Expo Go update is still awaiting approval.

The otherwise surprising SDK 54 choice is not conservatism: Expo's [current create-project page](https://docs.expo.dev/get-started/create-a-project/) explicitly says to use SDK 54 for Expo Go on a physical device during the SDK 57 transition. SDK 54 remains on critical-fix support until the next SDK around September/October 2026 according to the SDK 57 release notes.

**RECOMMEND:** Pin SDK 54 at its current patch set for v1: `expo~54.0.37`, `react-native@0.81.5`, and `react@19.1.0`; do not let a generic `create-expo-app@latest --template default@sdk-57` silently move this app beyond the App Store Expo Go client.

### Which Expo Go versions support which SDKs

Expo Go no longer runs multiple SDK runtimes in one binary. The relevant states today are:

| Client | Physical iPhone install route | SDK runtime |
|---|---|---|
| Public App Store Expo Go | App Store, no developer account | **54 only** |
| `eas go` Expo Go | Build/upload through the user's Apple TestFlight team | One selected runtime: 54, 55, 56, or 57 |
| iOS Simulator Expo Go | Expo CLI/Expo Go download | A matching selected SDK, including 57 |
| Android sideloaded Expo Go | Expo CLI/APK | A matching selected SDK, including 57 |

Sources: the [Expo Go runtime download selector](https://expo.dev/go), [SDK 57 Expo Go compatibility notes](https://expo.dev/changelog/sdk-57#will-there-be-a-new-expo-go-version-on-the-app-store-and-play-store), and the [current physical-device setup page](https://docs.expo.dev/get-started/create-a-project/).

The hard requirement says “Expo Go on a physical iPhone,” not “a custom Expo Go uploaded with a paid Apple team.” Therefore the report treats the public App Store client as the acceptance target.

**UNKNOWN:** Expo may obtain App Store approval for SDK 57 before implementation finishes. Resolve immediately before scaffolding by checking the [SDK 57 changelog's App Store paragraph](https://expo.dev/changelog/sdk-57#will-there-be-a-new-expo-go-version-on-the-app-store-and-play-store) and opening the installed Expo Go app's About/runtime screen. If it genuinely reports SDK 57, regenerate every Expo-managed version with `npx expo install --fix`; do not mix the SDK 54 list below with SDK 57.

### Exact Expo Go native boundary for SDK 54

There are three different lists that are often conflated:

1. `bundledNativeModules.json` is the exact **SDK-compatible package-version manifest** used by `expo install`.
2. The third-party overview is the exact public list of **community native packages compiled into Expo Go**.
3. Expo Go's Podfile/package source is the exact implementation boundary for first-party Expo modules.

The official SDK 54 third-party Expo Go list is exactly:

| Bundled third-party native library | SDK 54 compatible version |
|---|---:|
| `@react-native-async-storage/async-storage` | `2.2.0` |
| `@react-native-community/datetimepicker` | `8.4.4` |
| `@react-native-community/netinfo` | `11.4.1` |
| `@react-native-community/slider` | `5.0.1` |
| `@react-native-masked-view/masked-view` | `0.3.2` |
| `@react-native-picker/picker` | `2.11.1` |
| `@react-native-segmented-control/segmented-control` | `2.5.7` |
| `@shopify/flash-list` | `2.0.2` |
| `@shopify/react-native-skia` | `2.2.12` |
| `@stripe/stripe-react-native` | `0.50.3` |
| `react-native-gesture-handler` | `~2.28.0` |
| `react-native-keyboard-controller` | `1.18.5` |
| `react-native-maps` | `1.20.1` |
| `react-native-pager-view` | `6.9.1` |
| `react-native-reanimated` | `~4.1.1` |
| `react-native-safe-area-context` | `~5.6.0` |
| `react-native-screens` | `~4.16.0` |
| `react-native-svg` | `15.12.1` |
| `react-native-view-shot` | `4.0.3` |
| `react-native-webview` | `13.15.0` |

Source: [SDK 54 third-party overview](https://docs.expo.dev/versions/v54.0.0/sdk/third-party-overview/) plus the [SDK 54 compatibility manifest](https://unpkg.com/expo@54.0.37/bundledNativeModules.json). `@gorhom/bottom-sheet` is not itself native; Expo Go's own SDK 54 app uses `5.1.8`, and current `5.2.14` is JavaScript over the bundled Reanimated/Gesture Handler native dependencies.

The public first-party modules available in the SDK 54 Expo Go runtime are:

```text
expo, expo-age-range, expo-apple-authentication, expo-application,
expo-asset, expo-audio, expo-auth-session, expo-av, expo-background-fetch,
expo-background-task, expo-battery, expo-blur, expo-brightness,
expo-calendar, expo-camera, expo-cellular, expo-checkbox, expo-clipboard,
expo-constants, expo-contacts, expo-crypto, expo-device,
expo-document-picker, expo-file-system, expo-font, expo-gl,
expo-glass-effect, expo-haptics, expo-image, expo-image-manipulator,
expo-image-picker, expo-intent-launcher, expo-keep-awake,
expo-linear-gradient, expo-linking, expo-live-photo,
expo-local-authentication, expo-localization, expo-location,
expo-mail-composer, expo-manifests, expo-media-library,
expo-mesh-gradient, expo-navigation-bar, expo-network,
expo-notifications, expo-print, expo-router, expo-screen-capture,
expo-screen-orientation, expo-secure-store, expo-sensors, expo-sharing,
expo-sms, expo-speech, expo-sqlite, expo-status-bar, expo-store-review,
expo-symbols, expo-system-ui, expo-task-manager,
expo-tracking-transparency, expo-updates, expo-video,
expo-video-thumbnails, expo-web-browser
```

The SDK 54 iOS Expo Go Podfile autolinks Expo packages and explicitly excludes:

```ruby
exclude: [
  'expo-module-template', 'expo-module-template-local',
  'expo-dev-menu', 'expo-dev-menu-interface',
  'expo-dev-launcher', 'expo-dev-client',
  'expo-maps', 'expo-network-addons', 'expo-insights',
  'expo-splash-screen', 'expo-blob', '@expo/ui', '@expo/app-integrity'
]
```

Source: [Expo Go iOS Podfile lines 39–63](https://github.com/expo/expo/blob/sdk-54/apps/expo-go/ios/Podfile#L39-L63). `expo-splash-screen` is a special case: Expo Go supplies its own launcher/splash behavior, but it cannot reproduce a standalone app's configured splash. The API can coordinate readiness; the configured native visual must be release-tested. `expo-router` and several JS-only packages appear in the client package source as dependencies even though they do not each imply a distinct native pod.

**RECOMMEND:** Treat the tables and the Podfile exclusions as the allow-list. A package is Expo-Go-safe only if it is in that native set or is demonstrably pure JavaScript using only that set.

## 2. Project shape inside this repository

### Directory layout

```text
spawn/
├── mobile/
│   ├── src/
│   │   ├── app/                    # Expo Router routes only
│   │   ├── components/             # global primitives + feature components
│   │   ├── features/               # workspaces, tabs, sessions, files, settings
│   │   ├── data/                   # API, query keys, cache persistence
│   │   ├── protocol/               # mobile protocol adapters/contracts
│   │   ├── state/                  # Zustand stores + derived selectors
│   │   ├── theme/                  # exact tokens, useTheme, makeStyles
│   │   ├── terminal/               # WebView boundary + native input chrome
│   │   ├── hooks/
│   │   ├── lib/
│   │   └── test/
│   ├── assets/
│   │   ├── fonts/
│   │   └── images/
│   ├── app.json
│   ├── eas.json
│   ├── metro.config.js
│   ├── babel.config.js
│   ├── tsconfig.json
│   ├── package.json
│   └── bun.lock
├── web/
├── server/
├── daemon/
└── proto/
```

Keep route files thin. A route parses parameters and composes a feature screen; it does not own API calls, protocol state, tokens, or reusable UI.

**RECOMMEND:** Make `mobile/` a standalone Bun package, not a root workspace initially. The root package currently has no `workspaces` key (`package.json:1-7`), so this preserves existing `npm run dev` behavior and prevents root tooling from recursively installing/scanning the app.

### Static `app.json` versus `app.config.ts`

Use one, never both as competing sources.

- Use the static `app.json` in the closing section for v1. It is deterministic and contains no secrets.
- Move to `app.config.ts` only when build variants require computed bundle identifiers, schemes, or non-public environment values.
- `EXPO_PUBLIC_*` values are compiled into the app and are not secrets.
- Native permission text/config-plugin output is ignored by the already-built Expo Go binary. A config plugin may prepare an EAS build, but Expo-Go acceptance must not depend on its effect.

The unfilled EAS `projectId` is intentionally absent from the supplied `app.json`.

**UNKNOWN:** The owner must confirm the final Apple/Android identifier. This report uses `dev.spawnd.spawn`, based on the repository's `spawnd.dev` naming, but that does not prove ownership or App Store availability.

### Metro isolation

Expo SDK 52+ normally auto-configures Metro for real package-manager monorepos. This repo is not declared as one. With project root `mobile/`, Metro does not need to watch sibling directories. The supplied config additionally:

- sets `watchFolders` to `[]`;
- resolves packages only from `mobile/node_modules`;
- disables hierarchical lookup into parent `node_modules`;
- blocks accidental imports from `web/`, `server/`, and `daemon/`.

Do not point `watchFolders` at the repository root. That would make Metro crawl the large Next.js, Python, and Rust trees and creates duplicate React/native-package resolution risk. See Expo's [current monorepo guidance](https://docs.expo.dev/guides/monorepos/).

If mobile needs generated protocol contracts, copy/generate them into `mobile/src/protocol/generated/` in an explicit codegen step. Do not solve sharing by letting Metro crawl the entire repo.

### TypeScript and path aliases

The alias contract is `@/* -> mobile/src/*`. Runtime and TypeScript resolve the same path because Metro/Babel understands the Expo Router project root and the alias is TypeScript-only for source imports; do not add `babel-plugin-module-resolver` unless a real runtime failure proves it necessary.

Strictness selected in the final `tsconfig.json`:

```json
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true,
  "useUnknownInCatchVariables": true,
  "noImplicitOverride": true,
  "noFallthroughCasesInSwitch": true,
  "noEmit": true
}
```

Expo Router typed routes are beta. Enabling `experiments.typedRoutes` generates `.expo/types/**/*.ts` on `expo start`; Expo's [typed routes guide](https://docs.expo.dev/router/reference/typed-routes/) says CI can run `npx expo customize tsconfig.json` when it must generate/configure types without starting the server. Route hrefs should be absolute and dynamic routes should use object form with typed `params`.

### Root `.gitignore` additions

The repo already ignores `node_modules`, build output, `.env`, local databases, and test artefacts (`.gitignore:1-62`). Add only mobile-specific generated/native output:

```gitignore
# Expo / React Native generated state
/mobile/.expo/
/mobile/expo-env.d.ts
/mobile/coverage/
/mobile/android/
/mobile/ios/
```

The `android/` and `ios/` ignores enforce managed/CNG workflow. Do not ignore `mobile/eas.json`, assets, or a future `mobile/.eas/workflows/` directory.

### Running on a physical iPhone

```bash
cd /Users/charliesaxton/dev/spawn/mobile
bun run start
```

The `start` script uses LAN mode. The iPhone and Mac must be on the same Wi-Fi; scan the terminal QR code with the Camera app/Expo Go. If client isolation, VPN, or a public network blocks LAN discovery:

```bash
bun run start:tunnel
```

Tunnel is slower; Expo's [physical-device instructions](https://docs.expo.dev/get-started/start-developing/) say LAN is preferred and tunnel is the fallback.

## 3. Navigation

### Expo Router versus direct React Navigation

| Criterion | Expo Router `~6.0.24` | Direct React Navigation 7 |
|---|---|---|
| Native stack | Uses React Navigation/screens | Direct configuration |
| File/URL parity | Built in | Manual linking config |
| Typed routes | Generated `Href`/params (beta) | Hand-maintained param lists/static API |
| Deep linking | Every route linkable by default | Manual prefixes/screens mapping |
| Expo integration | Default Expo template, bundled in Go | Supported but more setup |
| Escape hatch | `withLayoutContext`, underlying navigation options | Native API directly |

**RECOMMEND:** Expo Router `~6.0.24`. It is the SDK 54-supported router, is built on React Navigation, preserves native stack behavior, and removes a large hand-maintained linking/param surface. Source: [SDK 54 Router reference](https://docs.expo.dev/versions/v54.0.0/sdk/router/).

### Route tree for the product IA

```text
src/app/
├── _layout.tsx
├── +not-found.tsx
├── +native-intent.tsx
├── index.tsx                              # auth/app redirect
├── (auth)/
│   ├── _layout.tsx
│   ├── sign-in.tsx
│   ├── sign-up.tsx
│   ├── device.tsx
│   └── pairing.tsx
├── (app)/
│   ├── _layout.tsx
│   ├── workspaces/
│   │   ├── index.tsx                     # workspace list
│   │   └── [workspaceId]/
│   │       ├── index.tsx                 # tab pager + terminal lists
│   │       ├── files.tsx
│   │       └── settings.tsx
│   ├── hosts/
│   │   ├── index.tsx
│   │   └── [hostId].tsx
│   └── settings/
│       ├── index.tsx
│       ├── agents.tsx
│       ├── account.tsx
│       └── appearance.tsx
├── terminal/
│   └── [sessionId].tsx                   # full-screen vertical card overlay
└── (modals)/
    ├── _layout.tsx
    ├── new-workspace.tsx
    ├── new-session.tsx
    ├── rename.tsx
    ├── command-palette.tsx
    └── confirm-destructive.tsx
```

Route groups do not appear in URLs. Use stable IDs, never names, in paths. The terminal route is outside `(app)` so it overlays any app screen without becoming a bottom/global tab.

Typed navigation example:

```tsx
router.push({
  pathname: "/terminal/[sessionId]",
  params: { sessionId },
});

const { sessionId } = useLocalSearchParams<"/terminal/[sessionId]">();
```

### Root stack contract

```tsx
import { Stack } from "expo-router";

export default function RootLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(app)" />
      <Stack.Screen
        name="terminal/[sessionId]"
        options={{
          presentation: "card",
          gestureEnabled: true,
          gestureDirection: "vertical",
          animation: "slide_from_bottom",
          animationMatchesGesture: true,
          fullScreenGestureEnabled: true,
          contentStyle: { backgroundColor: "transparent" },
        }}
      />
      <Stack.Screen
        name="(modals)"
        options={{ presentation: "modal" }}
      />
    </Stack>
  );
}
```

Why `card`, not `fullScreenModal`: React Navigation's [native stack documentation](https://reactnavigation.org/docs/native-stack-navigator/#presentation) states that `fullScreenModal` maps to `UIModalPresentationFullScreen` and **cannot be dismissed by gesture**. On iOS, `gestureDirection: "vertical"` automatically selects full-screen gesture semantics and a slide-from-bottom transition. This gives a visually full-screen terminal that can be swiped down from anywhere while keeping native transition ownership.

For ordinary screens, keep the default iOS edge swipe-back. Do not add a competing full-screen horizontal pan gesture to every screen.

### Modal and sheet presentation rules

| Content | Presentation |
|---|---|
| Live terminal overlay | Native stack `card`, vertical full-screen gesture |
| New workspace/session multi-step task | Router `modal` route |
| Small adaptive form using native detents | Router/native stack `formSheet` |
| Command palette, switcher, quick actions | Gorhom bottom sheet |
| Destructive confirmation | Native `Alert` for simple confirmation; Router modal for explained/multi-control cases |
| Context menu | Native menu primitive if already available; otherwise bottom sheet |

Router modals remain routes, so they survive deep links and back navigation. Gorhom sheets are transient UI state and should not be encoded as durable navigation history.

### Deep links in Expo Go

Expo Router links all routes automatically. Production builds use `spawn://...` from `scheme: "spawn"`; Expo Go development links look like `exp://<lan-host>:8081/--/<path>` per the [SDK 54 Linking reference](https://docs.expo.dev/versions/v54.0.0/sdk/linking/).

Custom scheme callbacks are not an Expo Go acceptance surface because the installed Expo Go binary owns its schemes. Expo's [authentication guide](https://docs.expo.dev/guides/authentication/) explicitly warns that OAuth/OpenID testing cannot rely on a custom app scheme in Expo Go.

**UNKNOWN:** Universal links, OAuth callback ownership, and production `spawn://` links require an EAS/TestFlight binary and final associated-domain/bundle-id configuration. Keep password/device-code auth usable in Expo Go.

## 4. Gestures and animation

### Exact versions and architecture caveats

| Package | Current npm stable | SDK 54 / Expo Go pin | Notes |
|---|---:|---:|---|
| `react-native-reanimated` | `4.6.0` | `~4.1.1` | 4.6 does not support RN 0.81; do not install latest. |
| `react-native-worklets` | `0.12.1` | `0.5.1` | Exact compatible worklets line for Reanimated 4.1. |
| `react-native-gesture-handler` | `3.2.1` | `~2.28.0` | Use SDK-bundled native binary. |
| `react-native-pager-view` | `9.0.2` | `6.9.1` | Bundled native pager for horizontal tabs. |

Registry versions were verified from the live npm metadata; SDK pins come from the [Expo 54 manifest](https://unpkg.com/expo@54.0.37/bundledNativeModules.json). Reanimated's [compatibility table](https://docs.swmansion.com/react-native-reanimated/docs/guides/compatibility/) confirms 4.1.x supports RN 0.81 and Worklets 0.5.x.

Reanimated 4 and FlashList 2 require the New Architecture. Expo Go only supports the New Architecture, so keep `newArchEnabled: true`. `babel-preset-expo` configures the Worklets/Reanimated transform automatically for SDK 54; do not manually add `react-native-reanimated/plugin` or `react-native-worklets/plugin` to the supplied Babel config. See [Expo's SDK 54 Reanimated page](https://docs.expo.dev/versions/v54.0.0/sdk/reanimated/).

Use the Hermes inspector, not legacy remote JS debugging. Worklets must not capture mutable heavyweight JS objects. Cross from the UI runtime to JS only for committed semantic events such as “dismiss” or “tab changed,” not every animation frame.

### Root wrappers

```tsx
<GestureHandlerRootView style={{ flex: 1 }}>
  <KeyboardProvider>
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <BottomSheetModalProvider>
          <ThemeProvider>{children}</ThemeProvider>
        </BottomSheetModalProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  </KeyboardProvider>
</GestureHandlerRootView>
```

The exact wrapper order may move providers that do not require layout, but Gesture Handler must own the native root and Keyboard Controller must wrap screens that consume its animated state.

### Horizontal pager between workspace tabs

**RECOMMEND:** Use `react-native-pager-view@6.9.1`, not a hand-built horizontal FlatList, for the primary workspace tab pager. It gives native page settling and avoids JS-thread gesture arbitration.

Canonical shape:

```tsx
const page = useSharedValue(activeIndex);

const onPageScroll = useEvent(
  (event: PageScrollEvent) => {
    "worklet";
    page.value = event.position + event.offset;
  },
  ["onPageScroll"],
);

<AnimatedPagerView
  initialPage={activeIndex}
  onPageScroll={onPageScroll}
  onPageSelected={(event) => setActiveTabIndex(event.nativeEvent.position)}
  overdrag
  style={StyleSheet.absoluteFill}
>
  {tabs.map((tab) => <TabTerminalList key={tab.id} tabId={tab.id} />)}
</AnimatedPagerView>
```

Drive the tab indicator, adjacent-page scale (`0.985..1`), and label opacity from `page` on the UI thread. Commit store state in `onPageSelected`, not `onPageScroll`. Call `selectionAsync()` once when the settled tab index changes.

### Drag-down overlay with rubber-banding

Prefer the native stack vertical gesture for the terminal. For a custom transparent preview overlay that truly needs custom rubber-banding:

```tsx
const y = useSharedValue(0);

const pan = Gesture.Pan()
  .activeOffsetY(8)
  .failOffsetX([-24, 24])
  .onUpdate(({ translationY }) => {
    const dy = Math.max(0, translationY);
    const band = height * 0.55;
    y.value = dy / (1 + dy / band);
  })
  .onEnd(({ velocityY }) => {
    const dismiss = y.value > height * 0.22 || velocityY > 900;
    if (dismiss) {
      y.value = withTiming(height, { duration: 180 }, (finished) => {
        if (finished) scheduleOnRN(router.back);
      });
    } else {
      y.value = withSpring(0, { damping: 26, stiffness: 280 });
    }
  });
```

Backdrop opacity can interpolate from `0.35` to `0`; scale the revealed screen only subtly. A dismissal must be cancelable until threshold. Haptic feedback fires once when crossing the commit threshold, not continuously.

### Swipe-to-action rows

Use Gesture Handler's declarative `Gesture.Pan`, with:

- `activeOffsetX([-12, 12])` so normal taps remain taps;
- `failOffsetY([-8, 8])` so vertical list scrolling wins early;
- clamped translation equal to action width plus a small rubber-band;
- a single threshold haptic;
- `withSpring(0)` or `withSpring(-actionWidth)` on release;
- one open row at a time, closed when the list scrolls or route blurs.

Do not place destructive action execution directly on gesture end. Reveal “Stop/Delete,” then require an explicit press unless the action is trivially reversible.

### Shared-element-ish transitions

True Reanimated shared-element transitions are experimental and version-sensitive; SDK 54's Reanimated 4.1 does not have the later feature maturity required for a production foundation. SDK 54 also predates the newer Apple zoom transition support.

**RECOMMEND:** Coordinate a native stack transition with matching geometry, a 150 ms fade/scale on the source row, and a terminal skeleton in the destination. Do not depend on an experimental shared-element API for v1.

### 60/120 fps rules

- Keep pager/drag/row transforms and opacity on the UI runtime.
- Animate `transform` and `opacity`; avoid per-frame width/height/layout changes.
- Use `useAnimatedScrollHandler` only for values actually consumed on the UI thread.
- Never set React state per scroll frame.
- Memoize row renderers/handlers and provide stable keys/types.
- Use `expo-image` for cached images/logos.
- Do not render terminal scrollback as thousands of React `<Text>` rows; keep emulation/rendering in its specialized surface.
- Honour system Reduce Motion. The web design rules already require all motion to collapse under reduced motion (`docs/DESIGN.md:152-170`).
- “120 fps” is an upper bound determined by a ProMotion device and native frame scheduler, not an app promise. Profile release-like EAS builds; Expo Go development overhead is not a valid final FPS benchmark.

## 5. Haptics

`expo-haptics~15.0.8` is the SDK 54-compatible package. Its API is:

```ts
selectionAsync(): Promise<void>;
impactAsync(style?: ImpactFeedbackStyle): Promise<void>;
notificationAsync(type?: NotificationFeedbackType): Promise<void>;
performAndroidHapticsAsync(type: AndroidHaptics): Promise<void>;
```

Source: [SDK 54 Haptics API](https://docs.expo.dev/versions/v54.0.0/sdk/haptics/).

Every cross-platform impact/notification style:

| Enum | Values |
|---|---|
| `ImpactFeedbackStyle` | `Light`, `Medium`, `Heavy`, `Rigid`, `Soft` |
| `NotificationFeedbackType` | `Success`, `Warning`, `Error` |

Every Android-specific haptic value:

```text
Clock_Tick, Confirm, Context_Click, Drag_Start, Gesture_End,
Gesture_Start, Keyboard_Press, Keyboard_Release, Keyboard_Tap,
Long_Press, No_Haptics, Reject, Segment_Frequent_Tick, Segment_Tick,
Text_Handle_Move, Toggle_Off, Toggle_On, Virtual_Key, Virtual_Key_Release
```

On Android, prefer `performAndroidHapticsAsync` semantic constants to simulating iOS impact styles with `Vibrator`; Expo documents that this route does not require `VIBRATE` permission.

### spawn haptic vocabulary

| Interaction | iOS/cross-platform call | Android semantic call | Rule |
|---|---|---|---|
| Settled workspace tab change | `selectionAsync()` | `Segment_Tick` | Once after settle. |
| Modifier key toggled | `selectionAsync()` | `Toggle_On` / `Toggle_Off` | Only on state change. |
| Open live terminal overlay | `impactAsync(Light)` | `Context_Click` | At committed navigation. |
| Sheet snaps to detent | `impactAsync(Soft)` | `Segment_Tick` | Once per detent. |
| Swipe action crosses commit threshold | `impactAsync(Medium)` | `Gesture_End` | Once; reset if recrossed. |
| Drag begins on reorderable item | `impactAsync(Rigid)` | `Drag_Start` | Not on ordinary list scroll. |
| Workspace/session created | `notificationAsync(Success)` | `Confirm` | After server acknowledgement. |
| Recoverable warning/waiting attention | `notificationAsync(Warning)` | `Long_Press` or no haptic | Rare, user-initiated context only. |
| Operation failed | `notificationAsync(Error)` | `Reject` | Avoid repeating on retries. |
| Destructive confirmation press | `impactAsync(Heavy)` | `Long_Press` | Result then gets Success/Error. |
| Ordinary row tap, scrolling, terminal output | none | `No_Haptics` | Prevent fatigue. |
| Every typed terminal character | none | none | The system keyboard already owns key feedback. |

**RECOMMEND:** Centralize this table behind `haptics.selection()`, `haptics.open()`, `haptics.threshold()`, `haptics.success()`, `haptics.warning()`, and `haptics.error()`; components must not choose raw styles independently.

### iOS limitations

The Taptic Engine intentionally does nothing when Low Power Mode is active, the user disabled system haptics, iOS camera capture is active, or dictation is active. Calls made while backgrounded/suspended are not a reliable alert mechanism. The returned promise means the native trigger was requested, not that the user physically felt it. Older/non-Taptic devices may produce nothing.

Do not fire haptics during continuous scrolling or on every drag update. Camera-based QR pairing is specifically a period when iOS may suppress them.

## 6. Styling and exact web-token transfer

### Library comparison

| Option | Verified current version | Expo Go | Tailwind v4 / theme status | Decision |
|---|---:|---|---|---|
| RN `StyleSheet` + typed tokens | RN `0.81.5` | Yes, core | No translation/runtime dependency | **Use.** |
| `react-native-unistyles` | `3.3.0` | **No** | Excellent themes, but requires `react-native-nitro-modules`, Babel setup, and `expo prebuild` | Post-Go option only. |
| `nativewind` stable | `4.2.6` | JS/runtime can load | Stable line targets Tailwind 3-style setup; not the web app's Tailwind 4 system | Do not use. |
| `nativewind@preview` | `5.0.0-preview.4` | Plausible on SDK 54 native set | Tailwind 4.1+, RN 0.81+, Reanimated 4; official docs say not for production | Do not use in v1. |
| `tamagui` | `2.7.7` | Yes for its JS/core path | Own token/component/compiler system; RN 0.81+/React 19 | Too much parallel design-system machinery. |

Versions: [Unistyles npm](https://registry.npmjs.org/react-native-unistyles/latest), [NativeWind npm](https://registry.npmjs.org/nativewind/latest), [Tamagui npm](https://registry.npmjs.org/tamagui/latest). Unistyles' official [Expo tutorial](https://unistyl.es/v3/tutorial/intro/) installs Nitro Modules and runs `expo prebuild --clean`, which definitively disqualifies it from stock Expo Go. NativeWind's [v5 documentation](https://www.nativewind.dev/v5) labels the Tailwind-v4 version pre-release and not intended for production.

**RECOMMEND:** Plain `StyleSheet` plus an immutable, typed theme/token module and global primitives. It has zero native/version risk, represents exact numeric tokens without CSS translation ambiguity, and makes the web design language—not a third-party component library—the source of truth.

### Authoritative web design facts to preserve

- Tokens, not raw palette values, are mandatory; both themes must define every color (`docs/DESIGN.md:14-39`).
- Semantic colour is limited to success/warning/info/destructive and status/code families (`docs/DESIGN.md:87-133`).
- Radii are 6, 8, and 10 px; the shared motion curve is `cubic-bezier(0.32, 0.72, 0, 1)` and tile motion is 150 ms (`docs/DESIGN.md:152-160`).
- The live CSS currently uses a 40 px row and 6 px pane gap (`web/src/app/globals.css:334-345`). This supersedes the stale 36 px row listed in `docs/DESIGN.md:135-150`.
- The terminal uses 13 px type, 1.2 line height, 100,000 live scrollback lines, and 10,000 snapshot lines (`web/src/components/terminal/xterm-config.mjs:17-26`).
- Dark terminal defaults are `#0a0a0a`/`#e5e5e5`; the light terminal is `#fcfcfc`/`#1f1f1f` with an explicit 16-colour palette (`web/src/components/terminal/xterm-config.mjs:28-81`).
- Marketing/auth type uses IBM Plex Sans 400/500 and Rowdies 300 (`web/src/lib/fonts.ts:1-25`); app chrome otherwise uses the system sans stack (`web/src/app/globals.css:430` onward).

React Native 0.81 does not accept CSS `oklch(...)` strings. Convert the source OKLCH values once to sRGB hex and store both the source value (documentation) and RN value (runtime). Do not convert ad hoc in components.

### Exact runtime colour map

These sRGB values are the RN-safe conversions of `web/src/app/globals.css:272-410`:

| Token | Light | Dark |
|---|---:|---:|
| `background` | `#fafafa` | `#030303` |
| `foreground` | `#0f0f0f` | `#f5f5f5` |
| `muted` | `#f0f0f0` | `#181818` |
| `mutedForeground` | `#5b5b5b` | `#a1a1a1` |
| `card` | `#ffffff` | `#0d0d0d` |
| `cardForeground` | `#0f0f0f` | `#f5f5f5` |
| `popover` | `#ffffff` | `#1e1e1e` |
| `popoverForeground` | `#0f0f0f` | `#f5f5f5` |
| `popoverBorder` | `#d7d7d7` | `#303030` |
| `popoverAccent` | `#ebebeb` | `#2e2e2e` |
| `primary` | `#161616` | `#f5f5f5` |
| `primaryForeground` | `#fafafa` | `#070707` |
| `secondary` | `#eeeeee` | `#1f1f1f` |
| `secondaryForeground` | `#161616` | `#f5f5f5` |
| `accent` | `#e8e8e8` | `#262626` |
| `accentForeground` | `#0f0f0f` | `#f5f5f5` |
| `destructive` | `#c51d28` | `#ea3c3f` |
| `success` | `#137d41` | `#54c57a` |
| `warning` | `#9d6400` | `#e6ac3d` |
| `info` | `#1870a1` | `#4cb0e5` |
| `codeComment` | `#6b727e` | `#7f8793` |
| `codeString` | `#197037` | `#76cf8a` |
| `codeKeyword` | `#7945ab` | `#c699f8` |
| `codeNumber` | `#9d5300` | `#efb062` |
| `codePunct` | `#6b727e` | `#8b939f` |
| `toneActive` | `#009a4d` | `#3ec873` |
| `toneWaiting` | `#1a89c5` | `#3fb1ea` |
| `toneIdle` | `#808080` | `#989898` |
| `toneOffline` | `#b7b7b7` | `#525252` |
| `border` / `input` | `#dedede` | `#262626` |
| `paneDivider` | `#cacaca` | `#424242` |
| `brandAccent` | `#e11e15` | `#ff453a` |
| `brandAccentSoft` | `rgba(225,30,21,0.12)` | `rgba(255,69,58,0.14)` |
| `shell` | `#ededed` | `#161616` |
| `terminalBackground` | `#fcfcfc` | `#0a0a0a` |

Preserve soft semantic fills with source alpha: light success/info 0.12, light warning 0.14, light destructive 0.10; dark semantic fills 0.14 (`web/src/app/globals.css:291-301`, `web/src/app/globals.css:379-387`).

### Token and `useTheme()` contract

```ts
export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export type ColorToken = keyof typeof lightColors;
export type ThemeColors = Readonly<Record<ColorToken, string>>;

export type ThemeTokens = Readonly<{
  color: ThemeColors;
  space: Readonly<{ 0: 0; 1: 4; 2: 8; 3: 12; 4: 16; 5: 20; 6: 24 }>;
  radius: Readonly<{ sm: 6; md: 8; lg: 10; pill: 999 }>;
  size: Readonly<{ row: 40; touch: 44; sidebar: 264; rail: 56; paneGap: 6 }>;
  icon: Readonly<{ sm: 16; md: 20; lg: 24 }>;
  type: Readonly<{
    body: { fontSize: 14; lineHeight: 20 };
    caption: { fontSize: 12; lineHeight: 16 };
    title: { fontSize: 16; lineHeight: 24 };
    terminal: { fontSize: 13; lineHeight: 15.6; fontFamily: string };
  }>;
  motion: Readonly<{
    fast: 120;
    normal: 150;
    swift: readonly [0.32, 0.72, 0, 1];
  }>;
}>;

export type ThemeContextValue = Readonly<{
  preference: ThemePreference;
  resolved: ResolvedTheme;
  tokens: ThemeTokens;
  setPreference(next: ThemePreference): Promise<void>;
}>;

export function useTheme(): ThemeContextValue;

export function createThemedStyles<T extends StyleSheet.NamedStyles<T>>(
  factory: (tokens: ThemeTokens) => T,
): () => T {
  const styles = {
    light: StyleSheet.create(factory(lightTheme)),
    dark: StyleSheet.create(factory(darkTheme)),
  };
  return function useThemedStyles(): T {
    const { resolved } = useTheme();
    return styles[resolved];
  };
}
```

The reusable web primitives consistently use Tailwind `text-sm` (14/20) and `text-xs` (12/16), with `text-base` (16/24) for larger titles (`web/src/components/ui/button.tsx:10-17`; `web/src/components/ui/card.tsx:23-35`; `web/src/components/ui/toast.tsx:180-224`). Terminal 13/15.6 remains its separate measured scale (`web/src/components/terminal/xterm-config.mjs:17-21`).

Implementation rules:

- Resolve `system` with `useColorScheme()`/`Appearance`.
- Persist only the preference (`system|light|dark`) in AsyncStorage.
- Set React Navigation's theme from the same token object.
- Set `StatusBar` style from `resolved`.
- Memoize each theme's `StyleSheet.create` result once; do not allocate style objects per render.
- Global primitives (`Button`, `IconButton`, `TextField`, `Badge`, `Row`, `Surface`, `Sheet`, `EmptyState`, `StatusDot`) own interaction states and token application.
- Never use `PlatformColor` for identity/status tokens; it would drift from web. It is acceptable for genuinely native system affordances outside the product palette.

### Centralized data/state contract

Styling and derived app data should have the same single-source discipline:

- TanStack Query `5.101.4`: authenticated REST/control-plane server state, cache invalidation, mutations.
- Zustand `5.0.15`: transient client state such as selected workspace/tab, overlay focus, terminal connection handles, shortcut modifier state.
- Query async-storage persister `5.101.4`: selected serializable query cache only.
- Zod `4.4.3`: validate network/storage boundaries.
- Derived values are selectors, never mirrored mutable fields.

Registry sources checked on 2026-08-22: [TanStack Query](https://registry.npmjs.org/@tanstack/react-query/5.101.4), [query async-storage persister](https://registry.npmjs.org/@tanstack/query-async-storage-persister/5.101.4), [Zustand](https://registry.npmjs.org/zustand/5.0.15), and [Zod](https://registry.npmjs.org/zod/4.4.3). All are JavaScript packages over the already selected native storage/runtime and work in Expo Go.

```ts
type SpawnUiState = {
  activeWorkspaceId: string | null;
  activeTabByWorkspace: Record<string, string | undefined>;
  setActiveWorkspace(id: string): void;
  setActiveTab(workspaceId: string, tabId: string): void;
};

export const useActiveTabId = (workspaceId: string) =>
  useSpawnUiStore((state) => state.activeTabByWorkspace[workspaceId] ?? null);

export const useTerminalsForTab = (workspaceId: string, tabId: string) => {
  const sessions = useSessionsQuery(workspaceId).data ?? [];
  return useMemo(
    () => sessions.filter((session) => session.tabId === tabId),
    [sessions, tabId],
  );
};
```

Do not put React Query responses into Zustand. Do not persist live sockets, WebViews, Reanimated shared values, secrets, or terminal scrollback.

## 7. Lists: FlashList for scale, FlatList for short navigation lists

Registry checks on 2026-08-22:

| Package/API | Current registry version | SDK 54 / Expo Go version | Expo Go | Decision |
|---|---:|---:|---|---|
| `@shopify/flash-list` | `2.3.2` | `2.0.2` | Yes; bundled third-party native module | Use SDK-compatible `2.0.2` |
| React Native `FlatList` | RN `0.86.2` current / RN `0.81.5` selected | `0.81.5` | Yes; React Native core | Use for short lists |

Sources: the [SDK 54 compatibility manifest](https://raw.githubusercontent.com/expo/expo/sdk-54/packages/expo/bundledNativeModules.json), the [FlashList v2 migration guide](https://shopify.github.io/flash-list/docs/v2-migration/), and [React Native 0.81 FlatList documentation](https://reactnative.dev/docs/0.81/flatlist).

**RECOMMEND:** Install FlashList through `expo install` and pin the SDK-compatible `2.0.2`, even though npm's newest release is `2.3.2`. Expo Go contains the native binary selected by the SDK, so npm-latest is not automatically the compatible choice.

### Allocation by screen

| Content | Component | Why |
|---|---|---|
| Workspace list | `FlatList` initially | Usually short; built-in refresh, accessibility, and no extra abstraction |
| Tabs inside one workspace | Horizontal `PagerView`, not a list | Native page settling and drag progress |
| Terminals in a tab | `FlashList` | Rows update status frequently; recycle at scale |
| Remote file/directory results | `FlashList` | Potentially thousands of entries |
| Local event/audit/search result streams | `FlashList` | Unbounded incremental results |
| Terminal scrollback | Neither | Keep xterm.js inside the terminal WebView; virtualizing terminal rows in RN would break terminal selection/rendering semantics |
| Tiny settings/menu lists | Plain `View` or `FlatList` | Recycling adds no value |

FlashList v2 is New-Architecture-only and Expo SDK 54 is New Architecture by default. V2 removed the old `estimatedItemSize` requirement; do not copy v1 examples that set it. Its migration guide also warns that item state must be reset when a recycled component is reused and that `key` props inside the item subtree prevent efficient recycling.

```tsx
import { FlashList } from "@shopify/flash-list";

<FlashList
  data={terminals}
  keyExtractor={(item) => item.id}
  renderItem={({ item }) => <TerminalRow terminal={item} />}
  getItemType={(item) => item.kind}
  maintainVisibleContentPosition={{
    autoscrollToTopThreshold: 0.2,
    startRenderingFromBottom: false,
  }}
  onEndReached={fetchNextPage}
  onEndReachedThreshold={0.5}
/>
```

List rules:

- Memoize rows only after measuring; stable `renderItem` and handler identities matter more than blanket `memo`.
- Use a stable server object ID as `keyExtractor`. Never use an array index for sessions or files.
- Provide `getItemType` when terminal/file row layouts differ.
- Keep image/logo dimensions explicit so layout does not jump.
- Store row selection outside a recycled row and supply `extraData` when FlatList rendering depends on external state.
- Avoid nested same-direction virtualized lists.
- Profile release builds. Development mode adds JS instrumentation and is not evidence of list throughput.
- A 60/120 Hz screen does not make JS execute at 120 fps automatically. Keep scroll animations on the UI thread, avoid `runOnJS` per frame, and keep the terminal byte path out of React state.

## 8. Bottom sheets and overlays

Registry checks on 2026-08-22:

| Choice | Verified version | Expo Go | Appropriate use |
|---|---:|---|---|
| Expo Router native-stack modal/card | Router `6.0.24`, screens `4.16.0` | Yes | Full-screen navigable pages, including terminal |
| `@gorhom/bottom-sheet` | `5.2.14` | Yes on SDK 54; peers are bundled Gesture Handler/Reanimated | Contextual menus, pickers, action panels |
| Custom Gesture Handler + Reanimated | SDK pins `2.28.0` + `4.1.1` | Yes | Product-specific drag surfaces only |

The bottom-sheet package's verified peers are React Native Gesture Handler `>=2.16.0` and Reanimated `>=3.16.0 || >=4.0.0`; SDK 54 satisfies both. It is JavaScript over those native dependencies and therefore works in Expo Go. The package documentation covers dynamic sizing, keyboard behavior, scrollable children, and modal stacking: [Gorhom Bottom Sheet v5](https://gorhom.dev/react-native-bottom-sheet/).

**RECOMMEND:** Use Expo Router/native-stack for any surface with a route, URL, back-stack identity, or full-screen terminal. Use Gorhom Bottom Sheet only for transient actions and compact editors. Use a custom Reanimated overlay only for the terminal card's tailored drag-down physics.

Do not render the terminal itself in a sheet. A sheet competes with terminal pan/selection, keyboard, and scroll gestures, and its partial snap points shrink the most space-sensitive UI. The terminal route is a full-screen native stack card whose content can participate in an explicit vertical dismiss gesture.

### Keyboard inside sheets

Canonical sheet settings:

```tsx
<BottomSheetModal
  ref={ref}
  snapPoints={["48%", "90%"]}
  enableDynamicSizing={false}
  keyboardBehavior="interactive"
  keyboardBlurBehavior="restore"
  android_keyboardInputMode="adjustResize"
  enableBlurKeyboardOnGesture
>
  <BottomSheetTextInput
    value={value}
    onChangeText={setValue}
    returnKeyType="done"
  />
</BottomSheetModal>
```

Use the package's `BottomSheetTextInput`, or copy its focus/blur hooks into a custom input; a plain `TextInput` does not inform the sheet's keyboard coordinator. `keyboardBehavior="interactive"` moves the sheet by the keyboard height. `fillParent` is a fallback for an editor that must remain visible; `extend` always moves to the maximum snap point. Test hardware keyboards, dictation, emoji, predictive text, and iPhone floating/undocked keyboard cases separately.

`react-native-keyboard-controller` owns page-level keyboard motion; do not wrap the same sheet in another translating keyboard view. There must be one component responsible for each vertical adjustment.

## 9. Storage

### Compatibility and allocation

| Store | Selected/current version | Expo Go | Use in spawn |
|---|---:|---|---|
| `expo-secure-store` | `~15.0.8` / npm `15.0.8` | Yes | Access/refresh tokens and a small device credential only |
| `@react-native-async-storage/async-storage` | `2.2.0` / npm `2.2.0` | Yes | Preferences and bounded serialized query persistence |
| `expo-sqlite` | `~16.0.10` / npm `16.0.10` | Yes | Larger structured cache, search indexes, metadata, offline queue if needed |
| `react-native-mmkv` | npm `4.3.2` | **No** | Post-Expo-Go only |

Sources: [SecureStore SDK 54](https://docs.expo.dev/versions/v54.0.0/sdk/securestore/), [AsyncStorage SDK 54](https://docs.expo.dev/versions/v54.0.0/sdk/async-storage/), [SQLite SDK 54](https://docs.expo.dev/versions/v54.0.0/sdk/sqlite/), and [MMKV installation](https://github.com/mrousavy/react-native-mmkv#installation).

**RECOMMEND:** SecureStore for secrets, AsyncStorage for preferences and a deliberately filtered React Query snapshot, and SQLite only when a real structured/offline requirement appears. Do not introduce SQLite merely as a key/value preference store.

### SecureStore constraints

SecureStore uses iOS Keychain Services and Android encrypted SharedPreferences/Keystore. It is an encrypted persistence boundary, not an arbitrary object database.

- Store an opaque token or small credential per key; serialize only small values.
- Expo documents that large payloads can be rejected by the underlying platform. Older iOS releases commonly rejected values around `2048` bytes; there is no portable Expo-enforced byte cap. Treat **2 KB per value as the design budget**, not a guaranteed current limit.
- Split no large object across SecureStore keys. Store non-secret metadata in AsyncStorage/SQLite and only its credential in SecureStore.
- `requireAuthentication` changes retrieval semantics and can invalidate data when biometrics change.
- Face ID authentication cannot be tested in Expo Go because its native Info.plist permission is not present; a development/release build is required.
- Keychain values can survive uninstall/reinstall on iOS. Android data does not survive uninstall. Never use uninstall as logout semantics.
- SecureStore is not a source of synchronously available startup state.

```ts
import * as SecureStore from "expo-secure-store";

const ACCESS_TOKEN_KEY = "spawn.auth.access-token.v1";

export async function saveAccessToken(token: string): Promise<void> {
  if (new TextEncoder().encode(token).byteLength > 2_048) {
    throw new Error("Access token exceeds the mobile credential budget");
  }
  await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, token, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}
```

Do not enable `requireAuthentication` for the only refresh credential in v1. It would make background refresh and recovery dependent on a biometric prompt and is not testable in Expo Go on iPhone. Use LocalAuthentication as a separate app-lock gate, then retrieve the token normally.

### Query persistence

Persist only queries whose payloads are non-secret and useful after restart. Explicitly exclude signaling material, session connection offers/answers, tokens, terminal bytes, terminal scrollback, and short-lived presence.

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { persistQueryClient } from "@tanstack/react-query-persist-client";

export const queryPersister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: "spawn.query-cache.v1",
  throttleTime: 1_000,
});

persistQueryClient({
  queryClient,
  persister: queryPersister,
  maxAge: 24 * 60 * 60 * 1_000,
  buster: "mobile-schema-v1",
  dehydrateOptions: {
    shouldDehydrateQuery: (query) =>
      query.state.status === "success" &&
      ["workspaces", "hosts", "sessions"].includes(String(query.queryKey[0])),
  },
});
```

### Why MMKV is excluded

MMKV 4 is a JSI/Nitro native module. Its installation requires `react-native-nitro-modules`, native linking, and rebuilding the application. Stock Expo Go cannot load an arbitrary native module that is absent from its bundled manifest. It becomes a reasonable performance upgrade in an EAS development build, but it is not a v1 dependency.

## 10. Networking, WebSocket, cryptography, and the WebRTC boundary

### React Native versus browser surface

React Native 0.81 exposes `fetch`, `XMLHttpRequest`, and `WebSocket` globally. Those names do not guarantee browser-identical behavior. Relevant official references are [React Native networking](https://reactnative.dev/docs/0.81/network), [React Native WebSocket source at 0.81.5](https://github.com/facebook/react-native/blob/v0.81.5/packages/react-native/Libraries/WebSocket/WebSocket.js), and [Expo fetch](https://docs.expo.dev/versions/v54.0.0/sdk/expo/#expofetch-api).

| Browser capability | SDK 54 native status | Implementation rule |
|---|---|---|
| `fetch` JSON/REST | Available | Use explicit bearer tokens, timeouts via `AbortController`, validate JSON |
| Browser cookie jar | Different/fragile across RN native stacks | Do not design mobile auth around implicit browser cookies |
| CORS | Not enforced like a browser | Server auth still applies; never treat absence of CORS as trust |
| Fetch streaming | Use `expo/fetch`; WinterCG-compatible stream support | Select explicitly for streaming endpoints |
| `ReadableStream`, `TextEncoder`, `TextDecoder` | Available through Expo/RN globals; native TextDecoder is UTF-8-focused | Test protocol vectors on-device |
| `EventSource` | Not a React Native core global | Parse an `expo/fetch` response stream or use WebSocket; do not add a native module |
| `WebSocket` text | Available | Suitable for control/signaling |
| `WebSocket` binary | `binaryType` supports `blob` or `arraybuffer`; `send` accepts string, ArrayBuffer, views, Blob | Set `binaryType = "arraybuffer"`; normalize at boundary |
| `Blob` | React Native implementation exists | Avoid it for hot terminal frames; release promptly |
| `ArrayBuffer` / typed arrays | Available | Canonical binary representation |
| `crypto.getRandomValues` / UUID | Use `expo-crypto` | Supported and Expo-Go-safe |
| `crypto.subtle` | Do not assume Web Crypto SubtleCrypto parity | Use audited pure JS libraries and Expo Crypto primitives |
| WebRTC `RTCPeerConnection` / `RTCDataChannel` | **Absent from RN core and Expo Go** | Keep WebRTC terminal runtime in bundled WebView for v1 |

React Native's documentation calls out known fetch deviations: `redirect: "manual"` behavior is not browser-equivalent, `credentials: "omit"` is not reliably honored, and cookie-based authentication has long-standing native limitations. iOS redirect handling can also lose `Set-Cookie`. Spawn mobile should therefore use explicit `Authorization` headers and tokens in SecureStore, not ambient cookies.

```ts
import { z } from "zod";

export async function apiFetch<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
  const token = await loadAccessToken();
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${API_ORIGIN}${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) throw await SpawnApiError.fromResponse(response);
  return schema.parse(await response.json());
}
```

**RECOMMEND:** Keep one transport adapter with explicit byte/string conversions. Do not scatter assumptions about browser globals across stores and screens.

### Binary WebSocket facts

React Native 0.81.5's actual implementation declares:

```ts
type BinaryType = "blob" | "arraybuffer";
type WebSocketMessage = string | ArrayBuffer;
// send(data: string | ArrayBuffer | ArrayBufferView | Blob): void
```

On send, ArrayBuffer and ArrayBufferView payloads are converted to base64 before the native WebSocket module call. Incoming binary messages arrive from the native module as base64 and are decoded to ArrayBuffer when `binaryType === "arraybuffer"`. That bridge detail makes WebSocket binary acceptable for control/data messages but worth measuring for sustained terminal traffic.

```ts
const socket = new WebSocket(url, protocols);
socket.binaryType = "arraybuffer";
socket.onmessage = ({ data }) => {
  if (!(data instanceof ArrayBuffer)) {
    throw new TypeError("Expected a binary spawn protocol frame");
  }
  acceptFrame(new Uint8Array(data));
};
```

### Cryptography

`expo-crypto ~15.0.9` supplies `digest`, `digestStringAsync`, `getRandomBytes`, `getRandomBytesAsync`, `getRandomValues`, and `randomUUID`. The synchronous random-byte method is limited to at most 1024 bytes per call. It does not provide the general browser `SubtleCrypto` AES/ECDH/import/export API needed by arbitrary web code.

The existing web package uses `@noble/ed25519` `3.1.0` (`web/package.json:20`; `web/bun.lock:148`). Its own React Native guide requires an explicit SHA-512 provider. Use current `@noble/hashes@2.3.0` (pure JavaScript) and Expo Crypto randomness; both are Expo-Go-safe. Source: [Noble Ed25519 React Native setup](https://github.com/paulmillr/noble-ed25519#react-native-polyfill-getrandomvalues-and-sha512) and the [Noble Hashes registry record](https://registry.npmjs.org/@noble/hashes/latest).

```ts
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import * as Crypto from "expo-crypto";

ed.hashes.sha512 = sha512;
ed.hashes.sha512Async = async (message) => sha512(message);

const privateKey = Crypto.getRandomBytes(32);
const publicKey = await ed.getPublicKeyAsync(privateKey);
```

This adapter supports Noble's synchronous and asynchronous APIs without depending on global `crypto.subtle` or `crypto.getRandomValues`. Keep it in one protocol bootstrap module and run the shared `proto/` vectors on Hermes/iOS before accepting it. The cryptographic primitive is selected here; key lifecycle and exact protocol framing remain owned by their dedicated research passes.

### The hard WebRTC conflict and v1 fallback

The product's terminal bytes use authenticated WebRTC DataChannels between browser and daemon (`README.md:42-45`). React Native core does not expose `RTCPeerConnection` or `RTCDataChannel`.

`react-native-webrtc` is currently `124.0.8`. It is a custom native module and explicitly cannot run in stock Expo Go; the project requires a development client/prebuild. The current config plugin `@config-plugins/react-native-webrtc` is `15.0.2` and declares Expo `>=56` as a peer, which also excludes the selected SDK 54. Sources: [react-native-webrtc Expo guide](https://github.com/react-native-webrtc/react-native-webrtc/blob/master/Documentation/Expo.md), [package registry](https://www.npmjs.com/package/react-native-webrtc), and [config plugin registry](https://www.npmjs.com/package/@config-plugins/react-native-webrtc).

**RECOMMEND:** In v1, render xterm.js and the existing browser-compatible WebRTC/DataChannel transport in bundled `react-native-webview 13.15.0`, inside a genuinely native terminal overlay. Keep live terminal bytes entirely inside that WebView. Use `postMessage` only for low-rate route/session status, title, focus, key-command, clipboard, and lifecycle messages.

This is not a web-wrapper recommendation for the app: workspace, tab, terminal-list, settings, sheets, gesture, haptic, and navigation surfaces remain native. It is a deliberately narrow compatibility island for the one feature Expo Go cannot implement natively.

WebView constraints:

- `window.ReactNativeWebView.postMessage` accepts a string. Use small typed JSON envelopes.
- Never base64 every terminal frame through the RN bridge; the WebView must own DataChannel↔xterm directly.
- Load a bundled HTML/JS asset or a tightly controlled origin; do not expose arbitrary navigation.
- Reject unexpected `onShouldStartLoadWithRequest` origins.
- Define a protocol version and correlation IDs for bridge messages.
- Send native safe-area/keyboard metrics and modifier-key actions to the page, not raw high-frequency touches.
- Treat page messages as untrusted input and validate with Zod.

```ts
type NativeToTerminal =
  | { v: 1; type: "key"; text: string }
  | { v: 1; type: "resize"; columns: number; rows: number }
  | { v: 1; type: "lifecycle"; state: "active" | "inactive" | "background" }
  | { v: 1; type: "clipboard-read-result"; requestId: string; text: string };

type TerminalToNative =
  | { v: 1; type: "ready" }
  | { v: 1; type: "title"; title: string }
  | { v: 1; type: "connection"; state: "connecting" | "connected" | "closed" }
  | { v: 1; type: "haptic"; event: "selection" | "warning" };
```

**UNKNOWN:** A stock Expo Go physical-iPhone spike must prove that the bundled WebView runtime exposes WebRTC DataChannels, handles the daemon's ICE/auth flow, preserves audio-session-independent background/foreground recovery, and sustains terminal throughput. If WebKit disables any required behavior, there is no honest Expo-Go-compatible native fallback; the product owner must choose between a relayed WebSocket terminal transport and an EAS development build with native WebRTC.

## 11. Other platform pieces

All SDK pins in this section come from Expo's [SDK 54 bundled native module manifest](https://raw.githubusercontent.com/expo/expo/sdk-54/packages/expo/bundledNativeModules.json). “Current” registry checks were performed on 2026-08-22. Install Expo modules with `expo install`, not by copying npm-latest, because the JavaScript package must match Expo Go's native binary.

### Icons and SVG

| Option | Verified version | Expo Go | Finding |
|---|---:|---|---|
| `@expo/vector-icons` | SDK pin `^15.0.3` | Yes | Bundled font icon families; broad but less consistent with web |
| `lucide-react-native` | npm `1.33.0`; selected `1.14.0` | Yes | Pure React/SVG, same icon vocabulary/version as web |
| `react-native-svg` | SDK pin `15.12.1` | Yes | Rendering dependency and custom SVG primitive |

The web lock resolves `lucide-react` `1.14.0` (`web/bun.lock:372-379`), so matching `lucide-react-native@1.14.0` avoids icon-shape drift even though npm has a newer `1.33.0`. That release accepts `react-native-svg` versions through 15. Lucide icons expose `size`, `color`, `strokeWidth`, and accessibility props; use the existing desktop icon names, and map unavailable browser-only glyphs explicitly.

**RECOMMEND:** `lucide-react-native@1.14.0` backed by SDK-bundled `react-native-svg@15.12.1`. Keep `@expo/vector-icons` available only for an icon that has no Lucide equivalent, not as the default visual language.

```tsx
import { Terminal, Server, Settings } from "lucide-react-native";

<Terminal
  size={tokens.icon.md}
  color={tokens.foreground.secondary}
  strokeWidth={1.75}
  accessibilityElementsHidden
/>
```

Do not dynamically import icons by string from the package root: it defeats static optimization and type checking. Maintain a small typed registry for terminal kinds.

### Fonts

`expo-font ~14.0.12` is bundled and works in Expo Go. Runtime loading through `useFonts` or `Font.loadAsync` works; a config plugin that embeds fonts into the native binary only takes effect after a native rebuild and therefore must not be required for Expo Go.

The web interface uses the browser system-sans stack, while its terminal uses an explicit UI-monospace/SFMono/Menlo/Consolas/Liberation Mono stack (`web/src/app/globals.css:430-432`; `web/src/components/terminal/xterm-config.mjs:17-21`). React Native cannot name browser fallbacks as a CSS stack. Use the iOS system font for UI and bundle one licensed monospaced font asset for deterministic terminal accessory/preview text; the xterm WebView may retain the CSS stack.

```tsx
import { useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";

void SplashScreen.preventAutoHideAsync();

const [loaded, error] = useFonts({
  SpawnMono: require("../assets/fonts/SpawnMono-Regular.ttf"),
});

useEffect(() => {
  if (loaded || error) void SplashScreen.hideAsync();
}, [loaded, error]);
```

**UNKNOWN:** The exact distributable mono font file is a brand/licensing choice not present in the repository. The scaffolding agent must not invent or download an asset silently. Supply a licensed file at `mobile/assets/fonts/SpawnMono-Regular.ttf`, or omit `SpawnMono` and use iOS `Menlo` until the owner chooses one.

### Verified Expo module matrix

| Module | SDK 54 pin | Expo Go | Spawn use and caveat |
|---|---:|---|---|
| `expo-image` | `~3.0.11` | Yes | Host/workspace logos, memory/disk caching, transitions; prefer over RN `Image` for remote imagery |
| `expo-blur` | `~15.0.8` | Yes | Native overlay/sheet chrome; avoid large continuously animated blur regions |
| `expo-linear-gradient` | `~15.0.8` | Yes | Exact desktop gradients where present; do not add decorative gradients gratuitously |
| `expo-clipboard` | `~8.0.8` | Yes | Explicit copy/paste actions; no passive clipboard polling |
| `expo-file-system` | `~19.0.24` | Yes | Download/upload staging, cache files; SDK 54 has the newer `File`/`Directory` API and a legacy namespace |
| `expo-document-picker` | `~14.0.8` | Yes | Import/upload; use `copyToCacheDirectory: true` when FileSystem must read immediately |
| `expo-camera` | `~17.0.10` | Yes | QR pairing through `CameraView`; permission required; only one active camera preview |
| `expo-local-authentication` | `~17.0.9` | Partial | App-unlock gate; Touch ID/passcode testable, Face ID permission requires a build |
| `expo-notifications` | `~0.32.17` | Partial | Local notifications work; remote push unavailable in Expo Go on Android from SDK 53; release-build proof required on iOS too |
| `expo-updates` | `~29.0.20` | Included | OTA updates in release builds; most runtime methods are not meaningful in Expo Go/development |
| `react-native-safe-area-context` | `~5.6.0` | Yes | Root safe-area provider and edge insets |
| `react-native-screens` | `~4.16.0` | Yes | Native-stack screens, freeze/detach behavior |
| `react-native-keyboard-controller` | `1.18.5` | Yes | Synchronized keyboard metrics/animation; terminal accessory positioning |
| `react-native-webview` | `13.15.0` | Yes | Narrow xterm/WebRTC compatibility island |
| `expo-keep-awake` | `~15.0.8` | Yes | Keep display awake while terminal overlay is active, user-controllable |
| `expo-status-bar` | `~3.0.9` | Yes | Theme-synchronized status-bar content |
| `expo-splash-screen` | `~31.0.13` | Partial preview | Runtime API works, but Expo Go shows the app icon and cannot faithfully preview final splash config |

Official module references: [Image](https://docs.expo.dev/versions/v54.0.0/sdk/image/), [BlurView](https://docs.expo.dev/versions/v54.0.0/sdk/blur-view/), [LinearGradient](https://docs.expo.dev/versions/v54.0.0/sdk/linear-gradient/), [Clipboard](https://docs.expo.dev/versions/v54.0.0/sdk/clipboard/), [FileSystem](https://docs.expo.dev/versions/v54.0.0/sdk/filesystem/), [DocumentPicker](https://docs.expo.dev/versions/v54.0.0/sdk/document-picker/), [Camera](https://docs.expo.dev/versions/v54.0.0/sdk/camera/), [LocalAuthentication](https://docs.expo.dev/versions/v54.0.0/sdk/local-authentication/), [Notifications](https://docs.expo.dev/versions/v54.0.0/sdk/notifications/), [Updates](https://docs.expo.dev/versions/v54.0.0/sdk/updates/), [Keyboard Controller](https://docs.expo.dev/versions/v54.0.0/sdk/keyboard-controller/), [WebView](https://docs.expo.dev/versions/v54.0.0/sdk/webview/), [KeepAwake](https://docs.expo.dev/versions/v54.0.0/sdk/keep-awake/), [StatusBar](https://docs.expo.dev/versions/v54.0.0/sdk/status-bar/), and [SplashScreen](https://docs.expo.dev/versions/v54.0.0/sdk/splash-screen/).

#### Image

Use a stable `cacheKey`, a fixed layout size, `contentFit="cover"` for photos and `"contain"` for logos, and a short transition. `expo-image` supports memory/disk caching and BlurHash/ThumbHash placeholders. Do not fetch authenticated sensitive images by putting long-lived credentials in public URLs.

```tsx
<Image
  source={{ uri: host.logoUrl, cacheKey: `host:${host.id}:${host.logoRevision}` }}
  placeholder={host.logoBlurhash ? { blurhash: host.logoBlurhash } : undefined}
  contentFit="contain"
  transition={120}
  style={styles.logo}
/>
```

#### Blur and gradient

On iOS, BlurView is appropriate behind navigation/sheet chrome. Provide an opaque/translucent token fallback because blur can be reduced by accessibility settings and behaves differently on Android. Mount blur after dynamic content when platform rendering order matters. Never place a full-screen animated BlurView above the terminal.

#### Clipboard

Use `Clipboard.getStringAsync()` only after an explicit paste command and `setStringAsync()` after copy. Clipboard contents are privacy-sensitive; never log them, persist them, or read on foreground. On iOS, a read may trigger privacy UI.

#### Files and document picker

The document picker returns content URIs/security-scoped selections whose lifetime and direct readability differ by platform. With `copyToCacheDirectory: true`, the selection is copied into an app-readable cache location at the cost of time and storage.

```ts
const result = await DocumentPicker.getDocumentAsync({
  multiple: false,
  copyToCacheDirectory: true,
  type: "*/*",
});

if (!result.canceled) {
  const [asset] = result.assets;
  if (!asset) throw new Error("Document picker returned no asset");
  const selected = new File(asset.uri);
  if (selected.size > MAX_UPLOAD_BYTES) throw new UploadTooLargeError();
}
```

Clean cache artifacts after upload. Use FileSystem's resumable/streaming APIs only after verifying the exact endpoint contract; do not load a very large remote file into a JS string or base64 buffer.

#### Camera QR pairing

Request permission in context, render one `CameraView`, use `barcodeScannerSettings={{ barcodeTypes: ["qr"] }}`, and debounce scan results. Stop/disable scanning immediately after the first valid code, validate its scheme and signature, show the parsed host identity for confirmation, and haptically acknowledge success/error. Do not auto-connect merely because arbitrary QR text resembles a URL.

```tsx
<CameraView
  active={isFocused && permission?.granted === true}
  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
  onBarcodeScanned={scanLocked ? undefined : handlePairingQr}
  style={StyleSheet.absoluteFill}
/>
```

#### Local authentication

Use `hasHardwareAsync`, `isEnrolledAsync`, and `supportedAuthenticationTypesAsync` before offering an app lock. Call `authenticateAsync` only while active and provide `cancelLabel` and a device-credential fallback. This protects local app access; it does not replace server/device authentication. Face ID requires `NSFaceIDUsageDescription`, which stock Expo Go cannot add for this project.

#### Notifications

Expo's current documentation states that remote push notification functionality is unavailable in Expo Go on Android from SDK 53 and requires a development build. That explicit prohibition is Android-specific; local notifications remain available in Expo Go on both platforms. On iOS, Expo Go can exercise portions of the notification API, but Expo Go owns the installed binary's APNs identity and entitlements, so it cannot validate spawn's production credentials, background modes, categories, or terminated-state delivery.

**RECOMMEND:** V1 in Expo Go may implement and demonstrate in-app alerts plus local notifications. Keep remote alert registration behind a capability flag and complete it only in the EAS preview/production build qualification pass.

Do not request notification permission at first launch. Ask when the user enables a specific session/agent alert, explain the benefit, then retrieve a project-scoped Expo push token in the built app. Define Android notification channels in production even though the immediate target is iPhone.

Pass `projectId` explicitly to `getExpoPushTokenAsync`; obtain it from `Constants.expoConfig?.extra?.eas?.projectId` only after `eas init` has written the real value. If it is absent, report remote alerts as unavailable—never send a token request with a fabricated ID.

#### Updates

Use EAS Update only for matching native runtime versions and channel-specific deployments. Do not call `reloadAsync` while a terminal has unsent input or an active transfer. Show an “update ready” action at a safe boundary. Expo Go always executes within Expo Go's own native runtime, so it is not proof that a standalone update will load.

#### Keyboard controller

`react-native-keyboard-controller 1.18.5` is in Expo Go's SDK 54 third-party manifest. It supplies native synchronized keyboard events/animated values without a custom build. Wrap the app in `KeyboardProvider` and drive the terminal accessory bar from `useReanimatedKeyboardAnimation`; do not derive its motion from late JS `keyboardDidShow` events.

```tsx
import { KeyboardProvider } from "react-native-keyboard-controller";

export function RootProviders({ children }: PropsWithChildren) {
  return (
    <GestureHandlerRootView style={styles.fill}>
      <KeyboardProvider>{children}</KeyboardProvider>
    </GestureHandlerRootView>
  );
}
```

On the terminal route, calculate usable height from safe-area insets plus the keyboard-controller height, send the resulting rows/columns to the WebView at a throttled cadence, and keep the shortcut row above the keyboard. Test interactive dismissal, hardware keyboard, dictation, password autofill, predictive bar, rotation, and returning from background.

#### Keep awake, status bar, and splash

Activate keep-awake only while the user is viewing a connected terminal or an opted-in long task; deactivate on blur/background and expose a setting because preventing sleep costs battery. Let the terminal route set status-bar style from theme, with no content hidden behind the Dynamic Island. Call `preventAutoHideAsync` at module scope and hide only when theme/fonts/auth hydration are ready. The final splash must be checked in a preview build because Expo Go does not reproduce all config-plugin effects.

## 12. Quality tooling

### Tool choice

The repository development baseline is Bun `1.3.14+` and Node `22.19.x` (`README.md:55-59`); web pins that policy and uses TypeScript/Biome (`web/package.json:5-15`; `web/package.json:44-60`; `web/biome.json:23-65`). Registry checks on 2026-08-22:

| Tool | Verified current / selected version | Decision |
|---|---:|---|
| TypeScript | `5.9.3` | Select exact `5.9.3` |
| `@biomejs/biome` | `2.5.10` | Select exact `2.5.10`; formatter + linter |
| `eslint-config-expo` | current `57.0.1`; SDK-54 line `~10.0.0` | Do not install initially |
| Prettier | `3.9.6` | Do not install; avoid two formatters |
| Jest | `29.7.0` selected (`30.2.0` registry current) | Jest 29 matches SDK 54 `jest-expo` peer range |
| `jest-expo` | `54.0.18` | Select SDK-matched preset |
| `@testing-library/react-native` | `14.0.1` | Select; peer requires Node `^22.13`, React 19, RN `>=0.78`, Jest `>=29` |
| `@testing-library/jest-native` | deprecated | Do not install; matchers are built into RNTL 12.4+ |
| `@types/jest` | `29.5.14` | Select for Jest 29 globals |
| `@types/react` | `19.1.17` current; SDK template range `~19.1.0` | Select exact `19.1.17` within the SDK's React 19.1 line |
| `test-renderer` | `1.2.0` | Select RNTL's supported host renderer; do not add deprecated `react-test-renderer` directly |

**RECOMMEND:** Use Biome for source/config linting and formatting so `mobile/` follows this repository. Use TypeScript for type correctness and Jest/Testing Library for component behavior. Do not install ESLint or Prettier unless an Expo-specific lint rule later proves indispensable.

Biome does not understand every semantic React Native/Expo rule ESLint plugins can provide, but it avoids a second formatter and duplicate base rule set. `expo-doctor` remains a separate dependency/native-compatibility check. If ESLint becomes necessary, use `eslint-config-expo@~10.0.0` for SDK 54 and disable formatting rules; do not switch to the SDK 57 config.

### Strict TypeScript policy

The final `tsconfig.json` enables `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature`, `useUnknownInCatchVariables`, and `verbatimModuleSyntax`. Boundary data must be `unknown` until Zod parsing succeeds. Avoid `any`, non-null assertions for route params, and unchecked JSON casts.

Typed Expo Router routes are enabled by `experiments.typedRoutes`. Route params remain external strings and require validation:

```ts
const TerminalRouteParams = z.object({
  workspaceId: z.string().min(1),
  terminalId: z.string().min(1),
});

const params = TerminalRouteParams.parse(useLocalSearchParams());
```

### Test boundaries

- Unit: token conversion, derived selectors, haptic vocabulary routing, protocol codecs, retry/backoff, storage filters.
- Component: workspace/tab/session rows, loading/error/empty states, sheet forms, permission rationale.
- Navigation: route params and dismiss behavior through mocked router boundaries.
- Contract: run copied/shared JSON protocol vectors through the mobile codec. Do not make tests reimplement expected bytes.
- WebView bridge: validate every message variant, origin gate, sequence/correlation behavior, malformed JSON rejection.
- Device qualification: terminal WebRTC/WebView, keyboard, haptics, camera, biometric, backgrounding, and release notifications cannot be proven by Jest.

Jest mocks native animation/gesture modules in setup; it does not assert pixels or animation frame rates. For reusable hooks, prefer behavior through a test component over calling internal functions directly.

### Exact scripts

```json
{
  "scripts": {
    "start": "expo start --lan",
    "start:tunnel": "expo start --tunnel",
    "android": "expo start --android",
    "ios": "expo start --ios",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "test": "jest --runInBand",
    "test:watch": "jest --watch",
    "test:ci": "jest --ci --runInBand --coverage",
    "ci": "bun run typecheck && bun run lint && bun run test:ci"
  }
}
```

`--runInBand` is intentional for predictable memory consumption in a polyrepo CI worker. Remove coverage from a fast pull-request lane if timing proves material; retain it in the merge lane.

Headless CI from repository root:

```sh
cd mobile
bun install --frozen-lockfile
bunx expo-doctor@latest
bun run typecheck
bun run lint
bun run test:ci
```

`expo-doctor@latest` is intentionally not a package script pinned into the app; CI should log the resolved Doctor version. If reproducibility takes priority, pin the CLI invocation in the CI image and revise it deliberately.

## 13. Copy-ready v1 scaffold

The files below are a coherent SDK 54 set. Do not combine one of them with an SDK 57 template. Expo-managed native package ranges match Expo `54.0.37`; pure-JS packages use exact verified versions. The official SDK 54 default template at source tag `sdk-54` was checked against these framework pins: Expo `~54.0.37`, Router `~6.0.24`, React `19.1.0`, RN `0.81.5`, Gesture Handler `~2.28.0`, Worklets `0.5.1`, Reanimated `~4.1.1`, Safe Area `~5.6.0`, and Screens `~4.16.0` ([template source](https://github.com/expo/expo/blob/sdk-54/templates/expo-template-default/package.json)).

### `mobile/package.json`

```json
{
  "name": "spawn-mobile",
  "version": "0.1.0",
  "private": true,
  "main": "expo-router/entry",
  "packageManager": "bun@1.3.14",
  "engines": {
    "node": ">=22.19.0 <23",
    "bun": ">=1.3.14"
  },
  "scripts": {
    "start": "expo start --lan",
    "start:tunnel": "expo start --tunnel",
    "android": "expo start --android",
    "ios": "expo start --ios",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "test": "jest --runInBand",
    "test:watch": "jest --watch",
    "test:ci": "jest --ci --runInBand --coverage",
    "ci": "bun run typecheck && bun run lint && bun run test:ci"
  },
  "dependencies": {
    "@expo/vector-icons": "15.0.3",
    "@gorhom/bottom-sheet": "5.2.14",
    "@noble/ed25519": "3.1.0",
    "@noble/hashes": "2.3.0",
    "@react-native-async-storage/async-storage": "2.2.0",
    "@react-navigation/native": "7.1.8",
    "@shopify/flash-list": "2.0.2",
    "@tanstack/query-async-storage-persister": "5.101.4",
    "@tanstack/react-query": "5.101.4",
    "@tanstack/react-query-persist-client": "5.101.4",
    "expo": "54.0.37",
    "expo-blur": "15.0.8",
    "expo-camera": "17.0.10",
    "expo-clipboard": "8.0.8",
    "expo-constants": "18.0.14",
    "expo-crypto": "15.0.9",
    "expo-document-picker": "14.0.8",
    "expo-file-system": "19.0.24",
    "expo-font": "14.0.12",
    "expo-haptics": "15.0.8",
    "expo-image": "3.0.11",
    "expo-keep-awake": "15.0.8",
    "expo-linear-gradient": "15.0.8",
    "expo-linking": "8.0.12",
    "expo-local-authentication": "17.0.9",
    "expo-notifications": "0.32.17",
    "expo-router": "6.0.24",
    "expo-secure-store": "15.0.8",
    "expo-splash-screen": "31.0.13",
    "expo-sqlite": "16.0.10",
    "expo-status-bar": "3.0.9",
    "expo-system-ui": "6.0.9",
    "expo-updates": "29.0.20",
    "lucide-react-native": "1.14.0",
    "react": "19.1.0",
    "react-native": "0.81.5",
    "react-native-gesture-handler": "2.28.0",
    "react-native-keyboard-controller": "1.18.5",
    "react-native-pager-view": "6.9.1",
    "react-native-reanimated": "4.1.1",
    "react-native-safe-area-context": "5.6.0",
    "react-native-screens": "4.16.0",
    "react-native-svg": "15.12.1",
    "react-native-webview": "13.15.0",
    "react-native-worklets": "0.5.1",
    "zod": "4.4.3",
    "zustand": "5.0.15"
  },
  "devDependencies": {
    "@biomejs/biome": "2.5.10",
    "@testing-library/react-native": "14.0.1",
    "@types/jest": "29.5.14",
    "@types/react": "19.1.17",
    "babel-preset-expo": "54.0.12",
    "jest": "29.7.0",
    "jest-expo": "54.0.18",
    "test-renderer": "1.2.0",
    "typescript": "5.9.3"
  },
  "jest": {
    "preset": "jest-expo",
    "setupFilesAfterEnv": [
      "<rootDir>/tests/setup.ts"
    ],
    "testMatch": [
      "<rootDir>/{src,tests}/**/?(*.)+(spec|test).[jt]s?(x)"
    ],
    "moduleNameMapper": {
      "^@/(.*)$": "<rootDir>/src/$1"
    },
    "collectCoverageFrom": [
      "src/**/*.{ts,tsx}",
      "!src/app/**",
      "!src/**/*.d.ts",
      "!src/**/index.ts"
    ]
  }
}
```

Notes on exactness:

- `@types/react` `19.1.17` is the verified current React 19.1 typings release and remains within React 19.1; Expo's template uses the looser `~19.1.0` range.
- Router's `react-dom` and `react-native-web` peers are marked optional. This native-only package omits both intentionally. Add the SDK pins `react-dom@19.1.0` and `react-native-web@0.21.0` only if mobile web becomes a supported target.
- `@react-navigation/native@7.1.8` is declared because app code imports `ThemeProvider` and navigation types directly. Router already depends on its native-stack implementation.
- No `expo-dev-client`, `react-native-webrtc`, MMKV, Unistyles, NativeWind, Tamagui, ESLint, or Prettier appears in v1.
- The package contains `expo-updates` for the eventual EAS binaries, but OTA configuration remains inactive until `eas update:configure` supplies a real project ID/update URL.

### `mobile/app.json`

```json
{
  "expo": {
    "name": "spawn",
    "slug": "spawn",
    "version": "0.1.0",
    "orientation": "default",
    "icon": "./assets/images/icon.png",
    "scheme": "spawn",
    "userInterfaceStyle": "automatic",
    "newArchEnabled": true,
    "platforms": [
      "ios",
      "android"
    ],
    "ios": {
      "supportsTablet": true,
      "bundleIdentifier": "dev.spawnd.spawn",
      "buildNumber": "1",
      "infoPlist": {
        "NSLocalNetworkUsageDescription": "spawn connects directly to machines you own on your local network."
      }
    },
    "android": {
      "package": "dev.spawnd.spawn",
      "versionCode": 1,
      "adaptiveIcon": {
        "foregroundImage": "./assets/images/adaptive-icon.png",
        "backgroundColor": "#030303"
      },
      "edgeToEdgeEnabled": true,
      "predictiveBackGestureEnabled": true
    },
    "plugins": [
      "expo-router",
      [
        "expo-splash-screen",
        {
          "image": "./assets/images/splash-icon.png",
          "imageWidth": 200,
          "resizeMode": "contain",
          "backgroundColor": "#F4F2ED",
          "dark": {
            "image": "./assets/images/splash-icon.png",
            "backgroundColor": "#030303"
          }
        }
      ],
      [
        "expo-camera",
        {
          "cameraPermission": "Allow spawn to scan a machine pairing QR code.",
          "microphonePermission": false,
          "recordAudioAndroid": false
        }
      ],
      [
        "expo-local-authentication",
        {
          "faceIDPermission": "Allow spawn to unlock with Face ID."
        }
      ],
      [
        "expo-secure-store",
        {
          "configureAndroidBackup": true,
          "faceIDPermission": "Allow spawn to access protected credentials with Face ID."
        }
      ],
      "expo-notifications"
    ],
    "experiments": {
      "typedRoutes": true
    }
  }
}
```

The assets named above are created as placeholders by the SDK 54 default template; replace them with exported spawn brand assets before a preview build. The config plugins prepare EAS binaries. They cannot mutate stock Expo Go, so runtime behavior must remain safe when their permission strings/entitlements are absent.

The identifier `dev.spawnd.spawn` is provisional as already marked **UNKNOWN**. Confirm it before running `eas init`. Do not add `ios.config.usesNonExemptEncryption: false` by rote: spawn performs authentication/protocol cryptography, and export-compliance classification needs an owner/legal decision.

### `mobile/eas.json`

```json
{
  "cli": {
    "version": ">=22.2.0",
    "appVersionSource": "remote"
  },
  "build": {
    "base": {
      "node": "22.19.0",
      "bun": "1.3.14"
    },
    "development": {
      "extends": "base",
      "distribution": "internal",
      "environment": "development",
      "channel": "development",
      "developmentClient": false
    },
    "preview": {
      "extends": "base",
      "distribution": "internal",
      "environment": "preview",
      "channel": "preview"
    },
    "production": {
      "extends": "base",
      "distribution": "store",
      "environment": "production",
      "channel": "production",
      "autoIncrement": true
    }
  },
  "submit": {
    "production": {}
  }
}
```

The `development` profile deliberately builds a normal internal binary, not a dev client, because `expo-dev-client` is outside the v1 Expo-Go dependency set. Local JavaScript development uses public Expo Go and `expo start`. Once the Expo-Go requirement is retired, add `expo-dev-client` and change `developmentClient` to `true`.

`channel` is harmless preparation but update publication will fail until the Expo project is initialized. `eas init` writes the real `extra.eas.projectId`; `eas update:configure` writes the update URL/runtime policy. Those account-derived values cannot be supplied honestly in a generic report.

### `mobile/tsconfig.json`

```json
{
  "extends": "expo/tsconfig.base",
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "baseUrl": ".",
    "paths": {
      "@/*": [
        "src/*"
      ]
    },
    "types": [
      "jest",
      "react-native"
    ],
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "useUnknownInCatchVariables": true,
    "noImplicitReturns": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true,
    "verbatimModuleSyntax": true
  },
  "include": [
    "src/**/*.ts",
    "src/**/*.tsx",
    "tests/**/*.ts",
    "tests/**/*.tsx",
    ".expo/types/**/*.ts",
    "expo-env.d.ts"
  ],
  "exclude": [
    "node_modules",
    "coverage",
    "dist"
  ]
}
```

`src/app` is the Router root. Expo supports `src/app`; never create a competing top-level `app/`, because it takes precedence. `expo-env.d.ts` and `.expo/types` are generated; include them for checking, ignore them in version control as specified above.

### `mobile/metro.config.js`

```js
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const siblingBlockList = ["web", "server", "daemon"].map(
  (name) =>
    new RegExp(
      `^${escapeForRegExp(path.resolve(__dirname, "..", name))}[/\\\\].*$`,
    ),
);

const defaultBlockList = config.resolver.blockList;

config.watchFolders = [];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules")];
config.resolver.disableHierarchicalLookup = true;
config.resolver.blockList = [
  ...(Array.isArray(defaultBlockList)
    ? defaultBlockList
    : defaultBlockList
      ? [defaultBlockList]
      : []),
  ...siblingBlockList,
];

module.exports = config;
```

The escape regex above is the standard JavaScript metacharacter escape pattern. This config assumes mobile owns its dependencies. If a later deliberate workspace move introduces symlinked shared packages, replace this isolation config with Expo's auto-monorepo defaults; do not accumulate contradictory `watchFolders` and `extraNodeModules` hacks.

### `mobile/babel.config.js`

```js
module.exports = function babelConfig(api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
  };
};
```

Do not manually append `react-native-reanimated/plugin` or `react-native-worklets/plugin`. SDK 54's `babel-preset-expo` configures the Worklets transform when Reanimated is installed; a duplicated/out-of-order plugin is a common source of worklet version mismatch.

### `mobile/biome.json`

This extra file is required by the recommended lint/format policy even though it was not in the minimum requested manifest list:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.10/schema.json",
  "files": {
    "includes": [
      "src/**",
      "tests/**",
      "*.js",
      "*.json",
      "!**/.expo",
      "!**/coverage",
      "!**/node_modules"
    ]
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "correctness": {
        "useExhaustiveDependencies": "error"
      },
      "suspicious": {
        "noExplicitAny": "error"
      },
      "style": {
        "noNonNullAssertion": "error"
      }
    }
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "double",
      "semicolons": "always",
      "trailingCommas": "all",
      "arrowParentheses": "always"
    }
  },
  "assist": {
    "enabled": true,
    "actions": {
      "source": {
        "organizeImports": "on"
      }
    }
  }
}
```

This deliberately tightens web's current `noExplicitAny`/non-null exceptions (`web/biome.json:29-47`) for a new codebase. If a generated protocol file cannot comply, exclude only that generated path, not the rule for all handwritten mobile code.

### `mobile/tests/setup.ts`

```ts
import "react-native-gesture-handler/jestSetup";
import { setUpTests } from "react-native-reanimated";

setUpTests();

jest.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: {
    Light: "light",
    Medium: "medium",
    Heavy: "heavy",
    Soft: "soft",
    Rigid: "rigid",
  },
  NotificationFeedbackType: {
    Success: "success",
    Warning: "warning",
    Error: "error",
  },
  impactAsync: jest.fn(async () => undefined),
  notificationAsync: jest.fn(async () => undefined),
  selectionAsync: jest.fn(async () => undefined),
  performAndroidHapticsAsync: jest.fn(async () => undefined),
}));
```

Mock `react-native-webview` behind the app's own `TerminalRuntime` interface in each bridge test rather than globally turning it into an inert `View`; bridge behavior is a key contract.

### Exact commands

From repository root, scaffold without allowing the template to install a competing dependency graph, move the generated route directory to `src/app`, then replace its generated manifests with the blocks above:

```sh
npx create-expo-app@latest mobile --template default@sdk-54 --no-install
cd mobile
mkdir -p src
mv app src/app
bun install
bunx expo-doctor@latest
```

If `mobile/` already exists, do not rerun `create-expo-app`; copy the files into that directory and run only the install/Doctor commands. `bun install` creates `mobile/bun.lock`, which must be committed by the implementation agent.

Run checks:

```sh
bun run typecheck
bun run lint
bun run test
```

Headless merge-gate checks:

```sh
bun run ci
```

Start for public Expo Go on a physical iPhone on the same LAN:

```sh
bun run start
```

Then open the public App Store Expo Go, allow Local Network access, and scan the terminal QR code. The phone and development machine must be on the same routable Wi-Fi/LAN; client isolation, VPN routes, corporate firewalls, and macOS firewall rules can prevent the phone reaching Metro. The phone must not use `localhost` for the spawn API/daemon—use an HTTPS origin or the development machine's LAN address as appropriate.

If LAN discovery/routing alone fails:

```sh
bun run start:tunnel
```

The tunnel carries the Metro bundle, not an arbitrary local spawn daemon. It does not solve a daemon/API address that the phone cannot route to and may make refreshes slower.

Do not run `expo run:ios`, `expo prebuild`, or install `expo-dev-client` for the Expo-Go acceptance pass. Those commands produce/use a custom native app and would no longer test the hard constraint.

## 14. Post-Expo-Go upgrade path

The public Expo Go constraint should be treated as an acceptance stage, not a permanent architecture ceiling.

### Gate 1: public Expo Go moves to SDK 57

When the installed App Store client actually supports SDK 57:

1. Create a clean SDK 57 comparison app.
2. Upgrade Expo with Expo's documented SDK-by-SDK procedure.
3. Run `expo install --fix` and `expo-doctor`.
4. Re-run protocol vectors, WebView terminal throughput, gesture, keyboard, camera, notification, and background/foreground qualification on the physical iPhone.
5. Adopt SDK 57's RN `0.86.2`, React `19.2.3`, Node `22.13+`, Xcode `26.4+`, and iOS `16.4+` floor as a single migration; never transplant individual SDK 57 native package versions into SDK 54 Expo Go.

SDK 57 by itself does **not** make arbitrary native modules available in public Expo Go.

### Gate 2: EAS development build replaces public Expo Go

Install `expo-dev-client` through the target SDK, set `developmentClient: true`, and then evaluate:

| Upgrade | Verified current version | Benefit | Migration consequence |
|---|---:|---|---|
| `react-native-webrtc` | `124.0.8` | Native `RTCPeerConnection`/DataChannel; removes WebView as the transport requirement | Requires native rebuild; replace bridge/terminal runtime only after protocol and throughput parity |
| `@config-plugins/react-native-webrtc` | `15.0.2` | Expo prebuild integration; peer Expo `>=56` | Use with SDK 57, not SDK 54 |
| `react-native-mmkv` | `4.3.2` | Fast synchronous JSI key/value cache | Requires Nitro native modules; keep SecureStore for secrets |
| `react-native-unistyles` | `3.3.0` | Native responsive theme engine | Requires Nitro/prebuild; migrate only if typed StyleSheet proves limiting |

**RECOMMEND:** Make native WebRTC the first post-Go investment. It removes the largest compatibility compromise. Do not simultaneously replace styling and storage; those are optional optimizations and would multiply migration risk.

Native WebRTC does not automatically supply a mobile terminal renderer. A native terminal view would be a separate library/product decision. It is valid to keep xterm in WebView while moving the WebRTC transport native, but then the RN↔WebView byte bridge must be benchmarked; base64 per terminal frame is unlikely to be the desired end state.

### Capabilities requiring preview/production qualification even without new libraries

- APNs/Expo remote push registration and receipt.
- Face ID usage description and authentication policy.
- Universal links/AASA and production OAuth redirect schemes.
- EAS Update channels/runtime compatibility and rollback.
- Final splash/icon/status-bar rendering.
- SecureStore biometric invalidation and reinstall behavior.
- Background/foreground reconnection, terminated-state notifications, and long transfers.
- App Store export compliance and privacy declarations.

## Appendix A. Exact SDK 54 compatibility manifest

This is the complete `bundledNativeModules.json` shipped by `expo@54.0.37`, fetched on 2026-08-22 from [the package artifact](https://unpkg.com/expo@54.0.37/bundledNativeModules.json). It is the exact version mapping used by `expo install`.

It is broader than the Expo Go runtime: config-only packages, deprecated compatibility packages, dev-client packages, and native modules that the Expo Go Podfile explicitly excludes can still appear here. The authoritative Expo Go boundary is the first-party list, third-party table, and Podfile exclusion set in section 1. This appendix prevents version guessing; it does not turn every row into an Expo-Go-safe recommendation.

| Package | SDK 54 compatible version |
|---|---:|
| `@expo/fingerprint` | `~0.15.5` |
| `@expo/metro-runtime` | `~6.1.2` |
| `@expo/vector-icons` | `^15.0.3` |
| `@expo/ui` | `~0.2.0-beta.9` |
| `@react-native-async-storage/async-storage` | `2.2.0` |
| `@react-native-community/datetimepicker` | `8.4.4` |
| `@react-native-masked-view/masked-view` | `0.3.2` |
| `@react-native-community/netinfo` | `11.4.1` |
| `@react-native-community/slider` | `5.0.1` |
| `@react-native-community/viewpager` | `5.0.11` |
| `@react-native-picker/picker` | `2.11.1` |
| `@react-native-segmented-control/segmented-control` | `2.5.7` |
| `@stripe/stripe-react-native` | `0.50.3` |
| `eslint-config-expo` | `~10.0.0` |
| `expo-age-range` | `~0.2.1` |
| `expo-analytics-amplitude` | `~11.3.0` |
| `expo-app-auth` | `~11.1.0` |
| `expo-app-loader-provider` | `~8.0.0` |
| `expo-apple-authentication` | `~8.0.8` |
| `expo-application` | `~7.0.8` |
| `expo-asset` | `~12.0.13` |
| `expo-audio` | `~1.1.1` |
| `expo-auth-session` | `~7.0.11` |
| `expo-av` | `~16.0.8` |
| `expo-background-fetch` | `~14.0.9` |
| `expo-background-task` | `~1.0.10` |
| `expo-battery` | `~10.0.8` |
| `expo-blur` | `~15.0.8` |
| `expo-brightness` | `~14.0.8` |
| `expo-build-properties` | `~1.0.10` |
| `expo-calendar` | `~15.0.8` |
| `expo-camera` | `~17.0.10` |
| `expo-cellular` | `~8.0.8` |
| `expo-checkbox` | `~5.0.8` |
| `expo-clipboard` | `~8.0.8` |
| `expo-constants` | `~18.0.14` |
| `expo-contacts` | `~15.0.11` |
| `expo-crypto` | `~15.0.9` |
| `expo-dev-client` | `~6.0.21` |
| `expo-device` | `~8.0.10` |
| `expo-document-picker` | `~14.0.8` |
| `expo-file-system` | `~19.0.24` |
| `expo-font` | `~14.0.12` |
| `expo-gl` | `~16.0.10` |
| `expo-glass-effect` | `~0.1.10` |
| `expo-google-app-auth` | `~8.3.0` |
| `expo-haptics` | `~15.0.8` |
| `expo-image` | `~3.0.11` |
| `expo-image-loader` | `~6.0.0` |
| `expo-image-manipulator` | `~14.0.8` |
| `expo-image-picker` | `~17.0.11` |
| `expo-intent-launcher` | `~13.0.8` |
| `expo-insights` | `~0.10.8` |
| `expo-keep-awake` | `~15.0.8` |
| `expo-linear-gradient` | `~15.0.8` |
| `expo-linking` | `~8.0.12` |
| `expo-local-authentication` | `~17.0.9` |
| `expo-localization` | `~17.0.9` |
| `expo-location` | `~19.0.8` |
| `expo-mail-composer` | `~15.0.8` |
| `expo-manifests` | `~1.0.11` |
| `expo-maps` | `~0.12.10` |
| `expo-mcp` | `~0.2.1` |
| `expo-media-library` | `~18.2.1` |
| `expo-mesh-gradient` | `~0.4.8` |
| `expo-module-template` | `~11.0.19` |
| `expo-modules-core` | `~3.0.30` |
| `expo-navigation-bar` | `~5.0.10` |
| `expo-network` | `~8.0.8` |
| `expo-notifications` | `~0.32.17` |
| `expo-print` | `~15.0.8` |
| `expo-live-photo` | `~1.0.8` |
| `expo-router` | `~6.0.24` |
| `expo-screen-capture` | `~8.0.10` |
| `expo-screen-orientation` | `~9.0.9` |
| `expo-secure-store` | `~15.0.8` |
| `expo-sensors` | `~15.0.8` |
| `expo-server` | `~1.0.7` |
| `expo-sharing` | `~14.0.8` |
| `expo-sms` | `~14.0.8` |
| `expo-speech` | `~14.0.8` |
| `expo-splash-screen` | `~31.0.13` |
| `expo-sqlite` | `~16.0.10` |
| `expo-status-bar` | `~3.0.9` |
| `expo-store-review` | `~9.0.9` |
| `expo-symbols` | `~1.0.8` |
| `expo-system-ui` | `~6.0.9` |
| `expo-task-manager` | `~14.0.9` |
| `expo-tracking-transparency` | `~6.0.8` |
| `expo-updates` | `~29.0.20` |
| `expo-video-thumbnails` | `~10.0.8` |
| `expo-video` | `~3.0.16` |
| `expo-web-browser` | `~15.0.11` |
| `jest-expo` | `~54.0.18` |
| `lottie-react-native` | `~7.3.1` |
| `react` | `19.1.0` |
| `react-dom` | `19.1.0` |
| `react-native` | `0.81.5` |
| `react-native-web` | `~0.21.0` |
| `react-native-gesture-handler` | `~2.28.0` |
| `react-native-get-random-values` | `~1.11.0` |
| `react-native-keyboard-controller` | `1.18.5` |
| `react-native-maps` | `1.20.1` |
| `react-native-pager-view` | `6.9.1` |
| `react-native-worklets` | `0.5.1` |
| `react-native-reanimated` | `~4.1.1` |
| `react-native-screens` | `~4.16.0` |
| `react-native-safe-area-context` | `~5.6.0` |
| `react-native-svg` | `15.12.1` |
| `react-native-view-shot` | `4.0.3` |
| `react-native-webview` | `13.15.0` |
| `react-server-dom-webpack` | `~19.1.4` |
| `sentry-expo` | `~7.0.0` |
| `unimodules-app-loader` | `~6.0.8` |
| `unimodules-image-loader-interface` | `~6.1.0` |
| `@shopify/react-native-skia` | `2.2.12` |
| `@shopify/flash-list` | `2.0.2` |
| `@sentry/react-native` | `~7.2.0` |
| `react-native-bootsplash` | `^6.3.10` |

## Appendix B. Acceptance checklist for the stack decision

The stack is accepted only when all of the following pass on the owner's physical iPhone in the public Expo Go client:

- Expo Go opens the SDK 54 QR without an unsupported-SDK error.
- `expo-doctor` reports no invalid native dependency version.
- Light/dark/system theme switching reproduces the documented token values and status-bar contrast.
- Workspace → tab pager → terminal-list navigation preserves state and deep-link route parsing.
- The terminal card follows the finger, cancels below threshold, dismisses above threshold, and never steals terminal vertical scroll unintentionally.
- Keyboard accessory modifiers, interactive dismissal, rotation, hardware keyboard, dictation, and background/foreground resize correctly.
- WebView proves authenticated daemon WebRTC/DataChannel connectivity and sustained xterm input/output without terminal bytes crossing the RN string bridge.
- Haptics occur once at vocabulary-defined boundaries and never during ordinary scrolling/output/typing.
- FlashList rows recycle without displaying stale terminal/file state.
- SecureStore round-trips small credentials; no secret/query cache/scrollback crosses the wrong storage boundary.
- QR permission, invalid-code rejection, valid pairing confirmation, and single-scan lockout work.
- Local notifications work; remote alerts are visibly capability-gated rather than falsely reported as configured.
- Reduce Motion collapses nonessential transitions and VoiceOver can identify/navigate every native control.

If the WebRTC/WebView item fails, the stack report has already identified the decision boundary: add a server/daemon WebSocket relay within separately approved product scope, or retire public Expo Go and use an EAS development build with native WebRTC. There is no third Expo-Go-compatible native DataChannel module to substitute.
