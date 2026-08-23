# R14 — Navigation, gestures, WebView containment, and list stability

- **TL;DR 1/10:** Safari opens because `originWhitelist={["https://spawn.local/*"]}` is matched against the origin `https://spawn.local`, so the slash/path pattern fails before `navigationAllowed` runs and RN WebView hands the URL to the OS.
- **TL;DR 2/10:** Keep the inline worker and synthetic HTTPS base; use `originWhitelist={["*"]}` plus a strict `onShouldStartLoadWithRequest` allowlist so every navigation reaches the callback and every non-bootstrap navigation is cancelled in-app.
- **TL;DR 3/10:** `loadHTMLString:baseURL:` navigates to the supplied HTML and uses the base only for relative resolution; allowing that initial iOS navigation does not perform a network GET to `spawn.local`.
- **TL;DR 4/10:** Add `onOpenWindow`, retain `allowsLinkPreview={false}` and `setSupportMultipleWindows={false}`, and leave automatic JS windows disabled; none is the present root cause, but together they close `_blank` escape paths.
- **TL;DR 5/10:** The authored worker has no anchor, form, or location assignment; its sole `<base>` is redundant and blocked by its own CSP, while xterm links use the supplied bridge callback rather than its dormant `window.open` default.
- **TL;DR 6/10:** The native-stack full-screen gesture is currently overridden off, and the visible overlay is actually a React Native `Modal` with a custom header-only vertical pan.
- **TL;DR 7/10:** A one-finger downward swipe anywhere cannot coexist with terminal-owned vertical scrollback; make dismissal a rightward, axis-locked swipe from anywhere and preserve vertical drags for xterm.
- **TL;DR 8/10:** Replace `(tabs)` with an Expo Router Drawer using `drawerType: "back"`; SDK 54 needs one new JavaScript dependency, `@react-navigation/drawer`, while all required native animation/gesture dependencies are already installed and Expo Go-compatible.
- **TL;DR 9/10:** Remove the root Files route, keep files contextual at `/host/[id]/files`, expose Workspaces/Hosts/Legion/Settings through the drawer, and keep Admin conditional; public deep-link paths can remain stable because route groups are URL-invisible.
- **TL;DR 10/10:** The workspace list is not remounting: its five-second session poll sets `sessionsQuery.isRefetching`, which is incorrectly wired to FlashList's visible `refreshing` prop and makes iOS pull-to-refresh move the content down and back up.

## Scope, installed baseline, and decision summary

This report covers the four assigned behavioural defects only. The installed baseline is Expo `54.0.37`, Expo Router `~6.0.24`, React Native `0.81.5`, `react-native-gesture-handler ~2.28.0`, `react-native-reanimated ~4.1.1`, `react-native-screens ~4.16.0`, `react-native-webview 13.15.0`, and `react-native-worklets 0.5.1` (`mobile/package.json:32`, `mobile/package.json:48`, `mobile/package.json:58-68`). The terminal architecture deliberately embeds a local xterm/WebRTC worker rather than a web page (`docs/native/plan/00-OVERVIEW.md:87-113`, `docs/native/plan/00-OVERVIEW.md:129-140`).

| Defect | Exact cause | Implementable decision | New dependency |
| --- | --- | --- | --- |
| Safari opens | An origin-only matcher is given a path pattern, so RN WebView opens the rejected initial URL through `Linking` before the app callback | Static HTML + synthetic HTTPS base, wildcard library gate, strict app gate, explicit `_blank` interception | None for primary; conditional `expo-asset` only if file fallback is proven necessary |
| Overlay gesture is limited | The route disables native gestures and the nested custom `Modal` opts into `dragHandleRegion="header"` | Rightward full-surface custom pan; retain vertical scroll ownership | None |
| Bottom tabs/files root | Four tab roots are hard-coded, including Files | Expo Router Drawer with `drawerType: "back"`; remove Files root | **Yes:** `@react-navigation/drawer` |
| Poll causes list bounce | Background `isRefetching` drives pull-to-refresh chrome | Local `manualRefreshing` state only around user pull | None |

## 1. Terminal containment: why Safari opens and the exact fix

### 1.1 Root cause: the whitelist rejects the initial static-document navigation

The worker source is currently:

```tsx
const WORKER_BASE_URL = "https://spawn.local/";

const source = USE_FILE_WORKER_FALLBACK
  ? { uri: Image.resolveAssetSource(terminalWorkerAsset).uri }
  : { html: TERMINAL_WORKER_HTML, baseUrl: WORKER_BASE_URL };

<WebView
  source={source}
  originWhitelist={["https://spawn.local/*", "file://*"]}
  onShouldStartLoadWithRequest={navigationAllowed}
/>
```

(`mobile/src/terminal/TerminalSurface.tsx:30-33`, `mobile/src/terminal/TerminalSurface.tsx:354-374`)

`react-native-webview` does not match a whitelist expression against the complete URL. It extracts only `scheme://authority` and compiles each expression to a prefix regex:

```ts
const extractOrigin = (url: string): string =>
  /^[A-Za-z][A-Za-z0-9+\-.]+:(\/\/)?[^/]*/.exec(url)?.[0] ?? "";

const originWhitelistToRegex = (originWhitelist: string): string =>
  `^${escapeStringRegexp(originWhitelist).replace(/\\\*/g, ".*")}`;
```

(`mobile/node_modules/react-native-webview/src/WebViewShared.tsx:22-32`)

For the initial URL, that produces:

```text
URL:              https://spawn.local/
extracted origin: https://spawn.local
compiled pattern: ^https://spawn\.local/.*
result:           NO MATCH
```

The installed library then checks the whitelist **before** calling the supplied `onShouldStartLoadWithRequest`; on failure it calls `Linking.canOpenURL` and `Linking.openURL`, sets `shouldStart = false`, and never invokes `navigationAllowed` (`mobile/node_modules/react-native-webview/src/WebViewShared.tsx:40-70`). Its own type documentation says matching is against “just the origin” and a rejected URL opens in Safari (`mobile/node_modules/react-native-webview/src/WebViewTypes.ts:1301-1308`). The upstream reference says the same and explicitly says static HTML should use `originWhitelist={["*"]}` ([React Native WebView `source` and `originWhitelist`](https://github.com/react-native-webview/react-native-webview/blob/master/docs/Reference.md#originwhitelist)).

**Conclusion:** the physical-device symptom follows the installed source exactly. `navigationAllowed` currently returns true for `https://spawn.local/`, but it is never reached because the preceding library whitelist rejects that origin (`mobile/src/terminal/TerminalSurface.tsx:63-69`, `mobile/node_modules/react-native-webview/src/WebViewShared.tsx:53-68`).

### 1.2 Initial `loadHTMLString` on iOS: allowing it does not fetch `spawn.local`

For `{ html, baseUrl }`, the iOS implementation calls:

```objc
NSURL *baseURL = [RCTConvert NSURL:_source[@"baseUrl"]];
[_webView loadHTMLString:html baseURL:baseURL];
```

(`mobile/node_modules/react-native-webview/apple/RNCWebViewImpl.m:836-846`)

Apple defines `loadHTMLString:baseURL:` as loading and navigating to the supplied HTML string; `baseURL` is used to resolve relative URLs, not as a request that must first be fetched ([Apple `WKWebView.loadHTMLString`](https://developer.apple.com/documentation/webkit/wkwebview/loadhtmlstring%28_%3Abaseurl%3A%29)). The initial static-document navigation still passes through the iOS `decidePolicyForNavigationAction` delegate. The installed delegate has no “skip first load” branch: when a handler exists, it sends the request to JS and allows or cancels that same navigation from the returned decision (`mobile/node_modules/react-native-webview/apple/RNCWebViewImpl.m:1324-1404`). The upstream reference only documents a first-load omission on **Android**, not iOS ([React Native WebView `onShouldStartLoadWithRequest`](https://github.com/react-native-webview/react-native-webview/blob/master/docs/Reference.md#onshouldstartloadwithrequest)).

Therefore:

- iOS calls `onShouldStartLoadWithRequest` for this initial `loadHTMLString` navigation once it passes the RN WebView whitelist (`mobile/node_modules/react-native-webview/apple/RNCWebViewImpl.m:1365-1404`).
- Returning `true` allows the already-created `loadHTMLString` navigation; it does **not** call `loadRequest` or issue a DNS/network request for `https://spawn.local/` (`mobile/node_modules/react-native-webview/apple/RNCWebViewImpl.m:836-846`, `mobile/node_modules/react-native-webview/apple/RNCWebViewImpl.m:1365-1386`).
- The observed Safari request is RN WebView's JavaScript-side OS handoff, not WKWebView trying to resolve the synthetic hostname (`mobile/node_modules/react-native-webview/src/WebViewShared.tsx:53-65`).

### 1.3 `originWhitelist` is a dispatch gate, not the security policy

A seemingly narrow correction such as `originWhitelist={["https://spawn.local", "file://*"]}` would make the bootstrap work, but it is not full containment: any future navigation outside those origins is handed to the OS **before** the app callback can cancel it (`mobile/node_modules/react-native-webview/src/WebViewShared.tsx:53-68`). The robust arrangement is:

1. set the library dispatch gate to `originWhitelist={["*"]}` so every URL reaches the app callback;
2. make `onShouldStartLoadWithRequest` the strict navigation policy;
3. use `onOpenWindow` for targetless/new-window navigations because iOS intercepts those before the ordinary policy callback when that prop is registered (`mobile/node_modules/react-native-webview/apple/RNCWebViewImpl.m:1351-1362`).

This is not an “allow the internet” policy. The wildcard only prevents RN WebView from automatically calling the system opener; the callback returns `false` for all documents except the exact bootstrap document.

### 1.4 `_blank`, link previews, and multiple windows

The current props include `allowsLinkPreview={false}` and `setSupportMultipleWindows={false}`, but no `onOpenWindow` (`mobile/src/terminal/TerminalSurface.tsx:371-374`). Their actual roles are:

- `allowsLinkPreview={false}` suppresses WebKit's preview UI; it is not a navigation allowlist. Retain it for terminal UX, but it cannot stop the initial Safari launch (`mobile/src/terminal/TerminalSurface.tsx:371-374`).
- `setSupportMultipleWindows` is Android-only and defaults to true; setting it false has no iOS effect (`mobile/node_modules/react-native-webview/src/WebViewTypes.ts:1033-1038`). Retain it for Android Expo Go.
- On iOS, without `onOpenWindow`, WKWebView's `createWebViewWithConfiguration` handler loads a `_blank` request into the same WebView. With `onOpenWindow`, it emits `targetUrl` instead (`mobile/node_modules/react-native-webview/apple/RNCWebViewImpl.m:390-403`). In the navigation-policy path, registering `onOpenWindow` cancels targetless navigation and emits the event, keeping the document unchanged (`mobile/node_modules/react-native-webview/apple/RNCWebViewImpl.m:1351-1362`). Upstream documents this for `window.open` and `<a target="_blank">` ([React Native WebView `onOpenWindow`](https://github.com/react-native-webview/react-native-webview/blob/master/docs/Reference.md#onopenwindow)).
- `javaScriptCanOpenWindowsAutomatically` defaults to false, meaning script cannot open a window without user interaction ([React Native WebView reference](https://github.com/react-native-webview/react-native-webview/blob/master/docs/Reference.md#javascriptcanopenwindowsautomatically)). Set it explicitly to document the containment policy.

### 1.5 Worker-document navigation audit

The build template contains one `<base>` and a CSP that simultaneously declares `base-uri 'none'; form-action 'none'`; the body contains only the terminal `<div>` and scripts (`mobile/src/terminal/worker/build-worker.mjs:36-47`). The authored worker sources contain no `<a>`, `<form>`, form action, `location =`, or `window.location` assignment. The only authored link path installs a custom WebLinks handler that posts the URI to native:

```js
new WebLinksAddon.WebLinksAddon((_event, uri) => api.post({ type: "link", url: uri }))
```

(`mobile/src/terminal/worker/worker-runtime.js:143-175`)

The bundled xterm WebLinks vendor does contain its generic dormant default handler based on `window.open`, because that vendor is included in the build (`mobile/src/terminal/worker/build-worker.mjs:9-17`, `mobile/assets/terminal/worker.html:235`). The app supplies the custom handler above, so the default is not selected; the built worker confirms the custom callback at `mobile/assets/terminal/worker.html:407`. Native validates `http:`, `https:`, and `mailto:` and only calls `Linking.openURL` after the user activates a terminal link (`mobile/src/components/terminal-ui/terminal-overlay.tsx:62-70`, `mobile/src/components/terminal-ui/terminal-overlay.tsx:306-308`). Nothing in bootstrap automatically navigates the top-level document.

The `<base href="https://spawn.local/">` is redundant because `source.baseUrl` already supplies the document base, and `base-uri 'none'` blocks the element by policy (`mobile/src/terminal/worker/build-worker.mjs:41-42`, `mobile/src/terminal/TerminalSurface.tsx:354-356`).

**RECOMMEND:** remove the `<base>` from the build template and update its generated-asset assertions. Rationale: eliminate contradictory dead markup while leaving the real Safari fix in the WebView navigation policy.

### 1.6 Secure-context alternatives and RTC constructibility

There are two separate questions: whether the document reports `isSecureContext`, and whether this WKWebView can expose, construct, negotiate, and open a DataChannel. The WebRTC specification declares `RTCPeerConnection` as `[Exposed=Window]` with a constructor, not `[SecureContext]` ([WebRTC specification](https://w3c.github.io/webrtc-pc/#dom-rtcpeerconnection)). WebKit may still impose platform policy, so a standards answer is not enough. This app already performs the correct runtime proof: it records `isSecureContext`, tests that the constructor exists, constructs two peers, performs offer/answer, and waits for a loopback DataChannel (`mobile/src/terminal/worker/worker-runtime.js:388-437`). Both session and host transports reject any missing capability (`mobile/src/terminal/transport/session-transport.ts:345-356`, `mobile/src/terminal/transport/host-transport.ts:662-673`).

| Document strategy | `isSecureContext` | `RTCPeerConnection` | Expo Go SDK 54 / dependency status | Decision |
| --- | --- | --- | --- | --- |
| Inline HTML, `baseUrl: "https://spawn.local/"` | **Standards: true** if WKWebView gives the document that HTTPS tuple origin; HTTPS origins are potentially trustworthy. **UNKNOWN:** actual device result until the whitelist fix lets the existing diagnostic run. | **Standards: constructible** because the interface is exposed to Window without `[SecureContext]`. **UNKNOWN:** SDK 54 WKWebView loopback result until the existing probe completes. | `react-native-webview 13.15.0` is already installed and running in Expo Go (`mobile/package.json:67`). No native rebuild or dependency. | **Primary.** Offline, immutable, no network listener, smallest change. |
| `file://` document via `expo-asset` | The Secure Contexts spec says UAs **SHOULD** trust `file:`, but explicitly permits stricter UAs to exclude it; therefore **UNKNOWN on this WKWebView** until probed ([Secure Contexts §3.1](https://w3c.github.io/webappsec-secure-contexts/#is-origin-trustworthy)). | Standards: constructible; **UNKNOWN on this WKWebView** until the same loopback probe. | `expo-asset` for SDK 54 is included in Expo Go, but it is absent from direct dependencies and would be a new direct dependency (`mobile/package.json:20-70`; [Expo SDK 54 Asset](https://docs.expo.dev/versions/v54.0.0/sdk/asset/)). `Asset.loadAsync(...)` is the documented way to obtain a downloaded `localUri` that points to a device `file://` URL. | First fallback only after primary fails; adding `expo-asset` is justified here because a guaranteed local file URI is the purpose of the fallback. |
| `http://127.0.0.1/...` or `http://localhost/...` | Loopback IPs are trustworthy; conforming UAs also trust `localhost`/`.localhost` ([Secure Contexts §3.1](https://w3c.github.io/webappsec-secure-contexts/#is-origin-trustworthy)). A synthetic `baseUrl` should therefore be secure, but **UNKNOWN on this WKWebView** until probed. | Standards: constructible; **UNKNOWN on this WKWebView** until probe. | A synthetic base needs no package but gives no advantage over synthetic HTTPS. Loading a real `uri` requires a local HTTP listener; no such server dependency is installed (`mobile/package.json:20-70`), and adding a native server is incompatible with the fixed Expo Go-only constraint. | Reject. Do not create a loopback server or point `source.uri` at an unserved address. |
| `file://` plus `allowFileAccessFromFileURLs` / `allowUniversalAccessFromFileURLs` | These flags change cross-origin file reads; they do **not** change the secure-context algorithm. Result remains the `file:` row above. | They do not expose RTC or make it constructible. Result remains probe-dependent. | The installed WebView types expose both on iOS and Android (`mobile/node_modules/react-native-webview/src/WebViewTypes.ts:610-624`, `mobile/node_modules/react-native-webview/src/WebViewTypes.ts:1005-1019`). No new package, Expo Go-compatible, but universal access weakens isolation. | Reject for the self-contained worker; it has no file subresources and needs neither permission. |
| Real worker URL on the spawn server over HTTPS | **True** for an authenticated HTTPS origin ([Secure Contexts §3.1](https://w3c.github.io/webappsec-secure-contexts/#is-origin-trustworthy)). | Standards: constructible; actual DataChannel still goes through the existing probe. | No new mobile native dependency and Expo Go-compatible, but introduces a network/bootstrap availability and version-integrity dependency. | Last fallback only, already anticipated by the architecture (`docs/native/plan/00-OVERVIEW.md:134-140`). |

### 1.7 Copy-ready recommendation

**RECOMMEND:** keep inline HTML with the synthetic HTTPS base, route every URL through a strict app callback, and intercept new windows. Rationale: fix the proven whitelist bug without changing the secure origin or adding a dependency.

Implement this policy verbatim in `TerminalSurface`:

```tsx
const WORKER_BASE_URL = "https://spawn.local/";

function bootstrapNavigationAllowed(request: WebViewNavigation): boolean {
  // iOS reports the initial loadHTMLString navigation as the supplied base URL.
  if (request.url === WORKER_BASE_URL || request.url === "about:blank") return true;

  // Keep the existing bundled-file fallback contained to its own top-level file.
  if (USE_FILE_WORKER_FALLBACK && request.url.startsWith("file://")) return true;

  // Never return an external URL to RN WebView's OS-opening path.
  return false;
}

<WebView
  source={{ html: TERMINAL_WORKER_HTML, baseUrl: WORKER_BASE_URL }}
  originWhitelist={["*"]}
  onShouldStartLoadWithRequest={bootstrapNavigationAllowed}
  onOpenWindow={({ nativeEvent: { targetUrl } }) => {
    callbacks.current.onLink?.(targetUrl);
  }}
  javaScriptCanOpenWindowsAutomatically={false}
  allowsLinkPreview={false}
  setSupportMultipleWindows={false}
  // retain the remaining current terminal props
/>
```

The native `onLink` callback already applies `safeTerminalLink` before calling `Linking.openURL`, so forwarding `targetUrl` uses the existing safe user-visible path (`mobile/src/components/terminal-ui/terminal-overlay.tsx:306-308`). Do not use `originWhitelist={["https://spawn.local/*"]}` again, and do not “fix” the issue by removing `baseUrl`.

The current switch is not yet a guaranteed file fallback: it passes `Image.resolveAssetSource(terminalWorkerAsset).uri` straight to WebView (`mobile/src/terminal/TerminalSurface.tsx:28-32`, `mobile/src/terminal/TerminalSurface.tsx:354-356`). In an Expo development session an asset URI may point at the development server; only Expo Asset's downloaded `localUri` is documented as a device `file://` URL ([Expo SDK 54 Asset `localUri`](https://docs.expo.dev/versions/v54.0.0/sdk/asset/#localuri)). A real fallback should first run:

```ts
const [asset] = await Asset.loadAsync(terminalWorkerAsset);
if (!asset.localUri) throw new Error("Terminal worker file asset is unavailable.");
setWorkerSource({ uri: asset.localUri });
```

**RECOMMEND:** if the existing capability diagnostic reports any false field after the primary fix, add the Expo-compatible `expo-asset` dependency, load its guaranteed `file://` `localUri`, remount the WebView once, and rerun the same probe; if file also fails, use an immutable worker served by the configured spawn server over real HTTPS. Rationale: each fallback is accepted only after proving `isSecureContext`, constructor exposure, DataChannel creation, and loopback, exactly the capabilities transport already requires (`mobile/src/terminal/worker/worker-runtime.js:388-437`, `mobile/src/terminal/transport/session-transport.ts:345-356`).

**Expo Go compatibility:** the primary uses installed `react-native-webview 13.15.0` only (`mobile/package.json:67`) and needs no plugin, module, or rebuild. Conditional `expo-asset` is explicitly included in Expo Go for SDK 54 and needs a JavaScript dependency install but no custom native build ([Expo SDK 54 Asset](https://docs.expo.dev/versions/v54.0.0/sdk/asset/)); do not add it unless the primary capability probe fails.

## 2. Swipe-to-dismiss from anywhere without stealing terminal scroll

### 2.1 The active recognizer is not the configured native-stack gesture

The root stack appears to request the desired full-screen native gesture:

```tsx
{
  presentation: "card",
  gestureEnabled: true,
  gestureDirection: "vertical",
  animation: "slide_from_bottom",
  animationMatchesGesture: true,
  fullScreenGestureEnabled: true,
}
```

(`mobile/src/app/_layout.tsx:25-32`)

However, the terminal route renders its own `Stack.Screen` and overrides `animation: "none"` plus `gestureEnabled: false` in loading, error, and ready states (`mobile/src/app/terminal/[sessionId].tsx:34-48`, `mobile/src/app/terminal/[sessionId].tsx:80-98`). The ready UI then opens a separate React Native `Modal` and wraps its whole panel in a custom Gesture Handler pan (`mobile/src/components/ui/swipe-dismiss-overlay.tsx:233-254`). The terminal opts that custom pan into `dragHandleRegion="header"` (`mobile/src/components/terminal-ui/terminal-overlay.tsx:249-251`). Eligibility is therefore explicitly:

```ts
dragHandleRegion === "full" ||
touch.absoluteY <= insets.top + chrome.touchTarget
```

(`mobile/src/components/ui/swipe-dismiss-overlay.tsx:135-163`)

That custom vertical pan—not native stack—is the gesture the owner currently sees. The nested native `Modal` also presents its own touch surface above the route, so merely changing root stack options cannot make gestures begin in the terminal surface while the modal/custom overlay remains (`mobile/src/components/ui/swipe-dismiss-overlay.tsx:235-254`).

### 2.2 What native-stack's iOS props really do

For the installed native stack, `gestureDirection: "vertical"` defaults `fullScreenGestureEnabled`, `animationMatchesGesture`, and `slide_from_bottom` on iOS (`mobile/node_modules/expo-router/node_modules/@react-navigation/native-stack/src/views/NativeStackView.native.tsx:143-160`). `fullScreenGestureEnabled` is the prop that changes recognition from an edge recognizer to a full-screen pan, while `gestureResponseDistance` can restrict where that pan begins (`mobile/node_modules/expo-router/node_modules/@react-navigation/native-stack/src/types.tsx:541-603`). The public documentation confirms that full-screen means the whole screen and that vertical direction enables full-screen behaviour ([React Navigation native stack](https://reactnavigation.org/docs/native-stack-navigator/#fullscreengestureenabled)).

At the installed native layer, `react-native-screens` creates both edge recognizers and a full-screen `RNSPanGestureRecognizer` (`mobile/node_modules/react-native-screens/ios/RNSScreenStack.mm:1016-1036`). An enabled full-screen pan begins when it is within optional response-distance bounds (`mobile/node_modules/react-native-screens/ios/RNSScreenStack.mm:963-983`); unset bounds are `-1` and therefore unrestricted (`mobile/node_modules/react-native-screens/ios/RNSScreenStack.mm:1168-1189`). Do not set `gestureResponseDistance` when “anywhere” is the goal.

There is no prop that can make two vertical one-finger recognizers both own the same drag. The native code explicitly arbitrates its full-screen pan against a descendant `UIScrollView` pan and does not recognize both once the back gesture begins (`mobile/node_modules/react-native-screens/ios/RNSScreenStack.mm:1210-1219`, `mobile/node_modules/react-native-screens/ios/RNSScreenStack.mm:1280-1295`). A WKWebView has its own scroll/touch handling, and xterm deliberately sets `.xterm-viewport{touch-action:pan-y}` while outer document scroll is disabled (`mobile/src/terminal/worker/build-worker.mjs:42-44`, `mobile/src/terminal/TerminalSurface.tsx:365-368`). Prior terminal UX explicitly assigns vertical one-finger drags to terminal history (`docs/native/research/09-native-terminal-ux.md:660-700`).

### 2.3 Reconciled gesture model

A downward swipe from any pixel and terminal scrollback are mutually exclusive: the first few vertical points do not reveal whether the user intends “older output” or “dismiss.” `simultaneousWithExternalGesture` does not solve ownership; both views would move. Waiting for a scroll boundary also fails the common case, because at the live bottom a downward finger drag is precisely how the user enters scrollback.

The viable model is:

| Gesture | Owner |
| --- | --- |
| One-finger vertical drag anywhere in terminal grid | xterm scrollback, unchanged |
| Long press | existing terminal selection mode (`mobile/src/components/terminal-ui/terminal-overlay.tsx:238-244`) |
| One-finger **rightward** swipe from anywhere | overlay dismissal |
| Tap Close/header controls | native overlay chrome |

The worker already advertises vertical-only touch panning on `.xterm-viewport`, making an axis-locked horizontal native gesture the least conflicting full-surface choice (`mobile/src/terminal/worker/build-worker.mjs:42-44`). This changes direction, not availability: the owner can start the dismiss swipe anywhere, including on the WebView, without sacrificing terminal history.

**RECOMMEND:** retain one transition owner—the existing custom overlay—and convert it to a full-surface rightward pan with early axis locking; rationale: it preserves the approved overlay animation/chrome and makes all vertical grid drags remain terminal scroll.

Exact handler policy for `SwipeDismissOverlay`:

```tsx
<SwipeDismissOverlay
  dragHandleRegion="full"
  dismissDirection="right"
  onDismiss={onDismiss}
  visible
>
```

```ts
Gesture.Pan()
  .manualActivation(true)
  .onTouchesMove((event, manager) => {
    const dx = touch.absoluteX - startX.value;
    const dy = touch.absoluteY - startY.value;

    if (dx < -axisLock || Math.abs(dy) > crossAxisFailureDistance) {
      manager.fail();                 // immediately release vertical/left drags
    } else if (dx > axisLock && Math.abs(dx) > Math.abs(dy)) {
      manager.activate();             // rightward, from any starting X/Y
    }
  })
  .onUpdate(({ translationX, velocityX }) => {
    translateX.value = rubberBand(Math.max(0, translationX), width);
    // use the existing 22% projected-distance decision with X values
  })
  .onEnd(({ translationX, velocityX }) => {
    // dismiss if translationX + velocityX * 0.2 >= width * 0.22;
    // otherwise spring translateX back to 0.
  });
```

Use the current `theme.motion.gesture.drawerAxisLock`, projection `0.2`, threshold ratio `0.22`, haptics, reduced-motion timing, and spring, changing only Y/height to X/width (`mobile/src/components/ui/swipe-dismiss-overlay.tsx:19-24`, `mobile/src/components/ui/swipe-dismiss-overlay.tsx:97-110`, `mobile/src/components/ui/swipe-dismiss-overlay.tsx:169-195`). Fail a vertical gesture before activation so the WebView/xterm retains it; do not compose this pan simultaneously with scrollback.

If implementation instead removes the nested `Modal` and custom transition, the native-stack-only alternative is exact:

```tsx
{
  presentation: "card",
  gestureEnabled: true,
  gestureDirection: "horizontal",
  fullScreenGestureEnabled: true,
  animation: "slide_from_right",
  animationMatchesGesture: true,
  // omit gestureResponseDistance
}
```

That requires deleting the terminal route's `gestureEnabled: false`/`animation: "none"` override and rendering the overlay as route content instead of a React Native `Modal` (`mobile/src/app/terminal/[sessionId].tsx:34-42`, `mobile/src/components/ui/swipe-dismiss-overlay.tsx:235-254`). Do not enable both native-stack and custom full-screen dismiss gestures.

**UNKNOWN:** whether RNGH's parent detector receives every horizontal touch sequence from this exact WKWebView on the owner's iOS/Expo Go build must be confirmed on the physical device; WebView touch arbitration is native and cannot be proven by source alone. The implementation fallback is the native-stack-only model above, which attaches its recognizer to the screen stack rather than around WebView content.

**Expo Go compatibility:** primary uses only the already-installed Gesture Handler, Reanimated, and Worklets versions (`mobile/package.json:59-68`); the fallback uses the already-installed native stack/react-native-screens (`mobile/package.json:48`, `mobile/package.json:64`). Both need no package, plugin, or rebuild in Expo Go SDK 54.

## 3. Replace the bottom tabs with a push-style burger drawer

### 3.1 Current structure and installed-dependency check

The current `(tabs)` layout defines exactly four roots:

```ts
[
  { name: "workspaces", title: "Workspaces" },
  { name: "hosts", title: "Hosts" },
  { name: "files", title: "Files" },
  { name: "settings", title: "Settings" },
]
```

(`mobile/src/app/(tabs)/_layout.tsx:10-15`)

The Files root only mounts `FilesHome` (`mobile/src/app/(tabs)/files/index.tsx:1-4`). By contrast, web exposes Files contextually from a host at `/hosts/[id]/files`, not as primary sidebar furniture (`web/src/app/hosts/[id]/page.tsx:303-308`). Web's sidebar is built around New workspace, the workspace tree/search, Archived, Legion/hosts, and Settings (`web/src/components/nav/Sidebar.tsx:464-529`, `web/src/components/nav/Sidebar.tsx:531-568`). Admin is conditional inside Settings (`web/src/components/settings/SettingsDialog.tsx:91-103`).

`@react-navigation/drawer` is **not** in the app's direct dependency list (`mobile/package.json:20-70`). Expo Router declares it as an optional peer, so `expo-router/drawer` does not make the actual navigator installed (`mobile/node_modules/expo-router/package.json:115-120`, `mobile/package-lock.json:5887-5906`). Gesture Handler, Reanimated, and Worklets are already direct dependencies (`mobile/package.json:59-68`).

Expo's current SDK-specific documentation says SDK 54/55 Drawer requires `@react-navigation/drawer`, Reanimated, Worklets, and Gesture Handler and is used via `import { Drawer } from "expo-router/drawer"` ([Expo Router Drawer, SDK 54/55](https://docs.expo.dev/router/advanced/drawer/)). Thus adding the drawer needs exactly **one new direct JavaScript dependency**: `@react-navigation/drawer`, selected by `npx expo install` during implementation rather than hard-pinning an unverified registry version. The installed Expo Router peer constraint is `^7.5.0` (`mobile/package-lock.json:5887-5900`), but the Expo installer remains the compatibility authority.

**Expo Go compatibility:** Expo documents this route for SDK 54, and all of its native engines are already installed in the app/available to Expo Go (`mobile/package.json:59-68`). Adding `@react-navigation/drawer` does not add a custom native module or config plugin and does not require rebuilding Expo Go.

### 3.2 The requested motion is `drawerType: "back"`

React Navigation defines:

- `front`: drawer covers the screen;
- `back`: drawer is revealed **behind** the screen as content moves away;
- `slide`: drawer and screen both translate;
- `permanent`: always-visible sidebar.

([React Navigation Drawer `drawerType`](https://reactnavigation.org/docs/drawer-navigator/#drawertype))

The owner's “menu underneath on the left; push app content to the right” is exactly `drawerType: "back"`, not `slide`. Use:

```tsx
<Drawer
  drawerContent={(props) => <SpawnDrawerContent {...props} />}
  screenOptions={{
    drawerType: "back",
    drawerPosition: "left",
    headerShown: true,
    swipeEnabled: true,
    overlayColor: "transparent", // content itself reveals the menu underneath
  }}
/>
```

Use a branded custom `drawerContent`, not the generic default row stack, because web's drawer contains live workspace rows, Archived and Legion/host state rather than four equivalent destinations (`web/src/components/nav/Sidebar.tsx:464-568`). The menu/header burger should call `navigation.toggleDrawer()` through the drawer navigation object; deep content should keep the drawer navigator mounted so the burger works inside workspaces and hosts.

**RECOMMEND:** use Expo Router Drawer with `drawerType: "back"` and one new `@react-navigation/drawer` dependency; rationale: it supplies focus management, accessibility actions, gesture/back/history integration, and nested router state while exactly matching the requested push-aside geometry.

### 3.3 Route-tree restructure

Rename the authenticated shell group `(tabs)` to `(drawer)` and make it own the authenticated detail routes, so the burger remains available throughout the app rather than only on four landing pages. Route-group names do not appear in public URLs ([Expo Router route-group notation](https://docs.expo.dev/router/basics/notation/#parentheses)).

```text
mobile/src/app/
├── _layout.tsx                         root Stack
├── (drawer)/
│   ├── _layout.tsx                    Drawer; branded custom content; drawerType="back"
│   ├── workspaces/
│   │   ├── _layout.tsx                nested Stack
│   │   ├── index.tsx                  landing, public /workspaces
│   │   └── archived.tsx               public /workspaces/archived
│   ├── workspace/[id].tsx             hidden drawer route, public /workspace/:id
│   ├── hosts/
│   │   ├── _layout.tsx                nested Stack
│   │   └── index.tsx                  public /hosts
│   ├── legion.tsx                     public /legion
│   ├── host/[id]/                     hidden drawer routes, public /host/:id/...
│   │   ├── index.tsx
│   │   ├── agents.tsx
│   │   └── files.tsx                  the only Files surface
│   ├── settings/                      nested Stack, public /settings/...
│   └── admin/                         hidden/conditional, public /admin/...
└── terminal/[sessionId].tsx           root overlay above the drawer shell
```

The root currently registers `(tabs)`, workspace detail, and host detail as separate Stack screens (`mobile/src/app/_layout.tsx:92-98`). Change the registered shell to `(drawer)` and move workspace/host/admin under it; leave terminal at root so it overlays and dismisses back to whatever drawer-contained screen launched it. The current nested workspace, hosts, and settings layouts can remain Stacks (`mobile/src/app/(tabs)/workspaces/_layout.tsx:1-4`, `mobile/src/app/(tabs)/hosts/_layout.tsx:1-4`, `mobile/src/app/(tabs)/settings/_layout.tsx:4-28`).

Destination placement:

| Area | Drawer/UI placement | Route |
| --- | --- | --- |
| Workspaces | Main drawer body, including New, search/live workspace rows, and Archived, matching web | `/workspaces`, `/workspace/[id]`, `/workspaces/archived` |
| Hosts | Drawer item or Legion host rows; keep a Hosts landing for device management and compatibility | `/hosts`, `/host/[id]` |
| Legion | Footer section above Settings; web's overflow row already points to `/legion` (`web/src/components/legion/LegionStrip.tsx:202-209`) | `/legion` |
| Settings | Footer item opening the nested Settings stack | `/settings`, `/settings/...` |
| Files | **No root/menu item.** Remove `(tabs)/files/index.tsx`; reach files through host/workspace actions | `/host/[id]/files` |
| Admin | Conditional item/link for `user.is_admin`, adjacent to or inside Settings as web does | `/admin`, `/admin/...` |

Do not preserve `/files` as an empty redirect: the owner explicitly wants the index gone. Existing contextual calls already use `/host/[id]/files` (`mobile/src/components/hosts/host-detail-screen.tsx:99-104`, `mobile/src/app/workspace/[id].tsx:20-23`, `mobile/src/components/files/files-home.tsx:82`).

### 3.4 Every navigation call site that needs updating

Prefer public, group-less hrefs in application code. This avoids coupling navigation to whether the authenticated shell is named `(tabs)` or `(drawer)`. The grep inventory found these affected sites:

| Site | Current | Update |
| --- | --- | --- |
| `mobile/src/app/admin/_layout.tsx:20` | `router.replace("/(tabs)/settings")` | `router.replace("/settings")` |
| `mobile/src/components/admin/admin-home-screen.tsx:49` | `router.replace("/(tabs)/settings")` | `router.replace("/settings")` |
| `mobile/src/app/(tabs)/settings/index.tsx:47` | `router.push("/(tabs)/settings/profile")` | move file, then `router.push("/settings/profile")` |
| `mobile/src/app/(tabs)/settings/index.tsx:62` | `router.push(panel.route)` | consumer stays; update all inventory values below |
| `mobile/src/app/(tabs)/settings/index.tsx:73` | `router.push("/(tabs)/settings/server")` | `router.push("/settings/server")` |
| `mobile/src/app/(tabs)/settings/index.tsx:80` | `router.push("/(tabs)/settings/about")` | `router.push("/settings/about")` |
| `mobile/src/components/settings/settings-root.tsx:47` | `router.push("/(tabs)/settings/profile")` | `router.push("/settings/profile")` |
| `mobile/src/components/settings/settings-root.tsx:62` | `router.push(panel.route)` | consumer stays; inventory changes |
| `mobile/src/components/settings/settings-inventory.ts:23-140` | nine `/(tabs)/settings/{account,appearance,notifications,hosts,agents,skills,templates,devices,trust}` values | nine `/settings/{...}` values |
| `mobile/src/components/settings/profile-screen.tsx:84` | `router.push("/(tabs)/settings/account")` | `router.push("/settings/account")` |
| `mobile/src/components/settings/hosts-panel.tsx:24` | `router.push("/(tabs)/hosts")` | `router.push("/hosts")` |
| `mobile/src/components/hosts/host-detail-screen.tsx:176` | `router.replace("/(tabs)/hosts")` | `router.replace("/hosts")` |
| `mobile/src/components/hosts/host-list-screen.tsx:153` | `router.push("/(tabs)/hosts/legion")` | `router.push("/legion")` |
| `mobile/src/lib/linking.ts:11-26` | `DeepLinkRoute` includes `/(tabs)/hosts/legion` and `/(tabs)/settings` | use `/legion` and `/settings` (or `(drawer)` only if a typed internal route is unavoidable) |
| `mobile/src/lib/linking.ts:162-170` | `/legion` resolves to route `/(tabs)/hosts/legion`, href `/hosts/legion`; download/security resolve to `/(tabs)/settings` | resolve to public `/legion`/href `/legion`, and public `/settings` |
| `mobile/src/lib/__tests__/linking.test.ts:49`, `mobile/src/lib/__tests__/linking.test.ts:63-68` | assertions contain old group routes | assert `/legion` and `/settings` |

Also update the root navigator declaration from `Stack.Screen name="(tabs)"` to `(drawer)` and remove the now-nested standalone workspace/host registrations (`mobile/src/app/_layout.tsx:92-98`). This is navigator structure rather than a `router.push`, but it is required for the move.

All other grep hits are already public/group-less and should remain unchanged: terminal routes use `/terminal/...`, workspaces use `/workspace/[id]` and `/workspaces/archived`, host detail/files use `/host/[id]...`, admin uses `/admin/...`, onboarding uses `/onboarding/...`, and authentication uses public auth paths (`mobile/src/components/workspaces/workspace-list-screen.tsx:109-112`, `mobile/src/components/workspaces/workspace-list-screen.tsx:157-159`, `mobile/src/components/workspaces/workspace-list-screen.tsx:297`, `mobile/src/components/hosts/host-detail-screen.tsx:99-104`, `mobile/src/components/admin/admin-home-screen.tsx:34-46`, `mobile/src/components/auth/login-form.tsx:105-136`). `IncomingLinkCoordinator` navigates with the public `link.href`, so stable public hrefs keep cold/foreground deep links intact (`mobile/src/app/_layout.tsx:39-68`). The authenticated launch destination is already `/workspaces` and requires no change (`mobile/src/lib/auth-gate.tsx:15-20`).

The production `mobile/src/app`, `mobile/src/components`, and `mobile/src/lib` grep found no JSX `<Link href=...>` navigation sites to migrate. The remaining `href` field is `ResolvedDeepLink.href`, consumed dynamically by `IncomingLinkCoordinator`; its changed resolver cases are included in the table (`mobile/src/lib/linking.ts:28-34`, `mobile/src/app/_layout.tsx:39-68`).

### 3.5 Custom Reanimated drawer alternative

A custom drawer could reuse installed RNGH/Reanimated/Worklets and add no dependency (`mobile/package.json:59-68`). Its geometry is straightforward: menu absolutely behind, content `translateX` from `0` to drawer width, rightward pan/open, leftward pan/close. It is Expo Go SDK 54-compatible because it uses only installed Expo Go-supported libraries.

It would also have to recreate drawer route focus, screen-reader modal/focus behaviour, escape/back handling, interrupted-gesture state, nested-stack history, safe-area/RTL handling, keyboard dismissal, and deep-link-selected state. That is unnecessary risk for an app whose owner explicitly prioritises feel and stability.

**RECOMMEND:** do not build the custom drawer unless adding the one JavaScript dependency is refused. Rationale: the official Drawer has the smaller behavioural and accessibility surface despite the new package.

## 4. Workspace list polling without scroll disturbance

### 4.1 Exact diagnosis: the list is not remounting

The session query polls every 5,000 ms:

```ts
const SESSION_POLL_MS = 5_000;

return useQuery({
  queryKey: qk.sessions(),
  queryFn: () => listSessions(),
  refetchInterval: SESSION_POLL_MS,
});
```

(`mobile/src/data/queries/workspaces.ts:22-23`, `mobile/src/data/queries/workspaces.ts:112-117`)

The workspace screen consumes that result and recomputes its snapshot/row models when sessions change (`mobile/src/components/workspaces/workspace-list-screen.tsx:63-67`, `mobile/src/components/workspaces/workspace-list-screen.tsx:122-146`). That causes a normal render, not a list remount:

- the `FlashList` component stays in the same render branch; skeletons are gated only by `workspacesQuery.isLoading`, which is initial loading, not background session fetching (`mobile/src/components/workspaces/workspace-list-screen.tsx:237-248`, `mobile/src/components/workspaces/workspace-list-screen.tsx:261-304`);
- the list already has the correct stable `keyExtractor={(item) => item.workspace.id}` (`mobile/src/components/workspaces/workspace-list-screen.tsx:288-302`);
- there is no changing `key` on `FlashList`, and `WorkspaceRow` is an imported component rather than a component declared inline (the inline `renderItem` function may add render work but does not remount the list) (`mobile/src/components/workspaces/workspace-list-screen.tsx:14-33`, `mobile/src/components/workspaces/workspace-list-screen.tsx:197-226`, `mobile/src/components/workspaces/workspace-list-screen.tsx:288-304`);
- TanStack Query retains successful data during a same-key refetch; `placeholderData` applies while an observer is pending and is not needed for this stable `qk.sessions()` key ([TanStack `useQuery`](https://tanstack.com/query/latest/docs/framework/react/reference/useQuery)).

The exact visual cause is this line:

```tsx
refreshing={workspacesQuery.isRefetching || sessionsQuery.isRefetching}
```

(`mobile/src/components/workspaces/workspace-list-screen.tsx:300-302`)

Every session poll sets `sessionsQuery.isRefetching` true. FlashList defines `refreshing` as “true while waiting for new data from a refresh,” and its `onRefresh` adds the standard RefreshControl ([FlashList usage](https://shopify.github.io/flash-list/docs/usage/#refreshing)). React Native defines `refreshing` as the controlled state of the visible refresh indicator ([React Native RefreshControl](https://reactnative.dev/docs/refreshcontrol)). On iOS, turning that control on and off programmatically produces the observed down/up content-inset motion. The data refresh itself is not moving the list.

### 4.2 Exact fix

Track a distinct user-initiated refresh state. Background fetch state must never drive pull-to-refresh chrome:

```tsx
const [manualRefreshing, setManualRefreshing] = useState(false);

const refresh = useCallback(async () => {
  if (manualRefreshing) return;
  setManualRefreshing(true);
  try {
    await Promise.all([
      workspacesQuery.refetch(),
      archivedQuery.refetch(),
      sessionsQuery.refetch(),
      templatesQuery.refetch(),
    ]);
  } finally {
    setManualRefreshing(false);
  }
}, [
  archivedQuery,
  manualRefreshing,
  sessionsQuery,
  templatesQuery,
  workspacesQuery,
]);

<FlashList
  data={rows}
  keyExtractor={(item) => item.workspace.id}
  onRefresh={() => void refresh()}
  refreshing={manualRefreshing}
  renderItem={renderItem}
/>
```

For a cleaner dependency list, destructure stable `refetch` functions and depend on those rather than entire query result objects. Keep the initial skeleton and error branches as they are; neither activates on a successful background refetch (`mobile/src/components/workspaces/workspace-list-screen.tsx:237-259`).

**RECOMMEND:** bind FlashList `refreshing` only to a local state set inside the user `onRefresh` path; rationale: `isRefetching` describes every background network refresh, while pull-to-refresh is visible interaction state.

Do **not** add `placeholderData`/`keepPreviousData`, change the existing key extractor, or add `maintainVisibleContentPosition` as the primary fix. Previous data is already retained for a same-key poll, item IDs are already stable, and no row insertion/reorder bug is causing this periodic symmetric bounce (`mobile/src/components/workspaces/workspace-list-screen.tsx:122-146`, `mobile/src/components/workspaces/workspace-list-screen.tsx:288-302`). `maintainVisibleContentPosition` could be evaluated later for real insertions above the viewport, but it cannot correct an intentionally displayed RefreshControl.

Memoising `renderItem` with `useCallback` and wrapping an expensive `WorkspaceRow` in `memo` are optional render-cost improvements because each session result can rebuild snapshot/row props (`mobile/src/components/workspaces/workspace-list-screen.tsx:125-146`, `mobile/src/components/workspaces/workspace-list-screen.tsx:197-226`). They are not required to preserve scroll position and should not be presented as the defect fix.

### 4.3 Polling policy

Keep session data live at five seconds while the query has active observers, but make the background policy explicit:

```ts
useQuery({
  queryKey: qk.sessions(),
  queryFn: listSessions,
  refetchInterval: SESSION_POLL_MS,
  refetchIntervalInBackground: false,
});
```

TanStack documents that `refetchInterval` performs continuous refetching and that `refetchIntervalInBackground: true` is the opt-in for continuing in background ([TanStack `useQuery`](https://tanstack.com/query/latest/docs/framework/react/reference/useQuery)). The app already maps React Native AppState into TanStack's focus manager and performs a recovery sweep on resume (`mobile/src/data/realtime/lifecycle.ts:83-117`, `mobile/src/data/realtime/lifecycle.ts:146-147`). Its alert stream invalidates sessions for alerts, while session status/exit frames intentionally remain transport-local, so polling still fills a real cross-screen consistency gap (`mobile/src/data/realtime/event-map.ts:21-38`). Reconnection also invalidates sessions and workspaces (`mobile/src/data/realtime/provider.tsx:83-104`).

**RECOMMEND:** retain the current five-second interval for active/focused use, set `refetchIntervalInBackground: false` explicitly, and rely on the existing AppState/reconnect sweep on resume; rationale: data remains live without invisible background work or any scroll/UI state mutation.

**Expo Go compatibility:** this fix uses the installed TanStack Query `5.101.4`, FlashList `2.0.2`, and React Native RefreshControl surface (`mobile/package.json:28-30`, `mobile/package.json:58`); it requires no new dependency, native module, or rebuild.

## Implementation acceptance checks

These are device checks for the subsequent fix batch, not tests run during this research:

1. Open a terminal from a workspace and host. The app remains foregrounded, Safari does not open, `onLoad` fires, and the existing diagnostic reports all of `isSecureContext`, `peerConnection`, `dataChannel`, and `loopback` true (`mobile/src/terminal/worker/worker-runtime.js:388-437`).
2. Attempt a scripted/location navigation and a `_blank` link in a development fixture. The worker document stays loaded; only a user-activated, safe terminal link reaches native `Linking.openURL` (`mobile/src/components/terminal-ui/terminal-overlay.tsx:62-70`, `mobile/src/components/terminal-ui/terminal-overlay.tsx:306-308`).
3. Vertically scroll terminal history from the center of the WebView: no overlay movement. Right-swipe from header, blank chrome, and terminal grid: the overlay tracks and dismisses. Leftward and diagonal/vertical attempts fail early.
4. Open the burger from Workspaces, a workspace detail, Hosts, host Files, Legion, Settings, and Admin. Content moves right while the menu remains underneath; browser/device Back first closes the drawer, then follows nested history.
5. Confirm `/legion`, `/settings`, `/host/:id/files`, `/workspace/:id`, and terminal deep links resolve both cold and foreground after moving the route group (`mobile/src/lib/linking.ts:123-219`, `mobile/src/app/_layout.tsx:34-69`).
6. Leave Workspaces untouched for several poll cycles at top and mid-list. Session badges/state update without spinner, inset movement, or scroll-offset change. Pull manually once: the refresh indicator appears only for that explicit refresh and the offset settles once.
