# Native app architecture

The app is React Native UI and navigation around a deliberately narrow WebView terminal worker.
REST snapshots live in TanStack Query, realtime/session UI state lives in Zustand, and all product
styling comes from the typed theme tokens.

## Module map

| Path | Responsibility |
|---|---|
| `src/app/` | Thin Expo Router route and layout composition |
| `src/components/ui/` | Shared native controls, forms, overlays, and feedback |
| `src/components/<feature>/` | Feature screens and feature-scoped components |
| `src/data/api/` | Base URL, token storage, fetch client, schemas, and typed endpoints |
| `src/data/queries/` | TanStack Query hooks and mutations |
| `src/data/realtime/` | App lifecycle plus alert, browser-signal, and host-signal sockets |
| `src/data/stores/` | Transient Zustand state for connections, alerts, and terminal UI |
| `src/data/layout/`, `selectors/`, `types/` | Pure domain codecs, derivation, and wire-independent models |
| `src/lib/crypto/`, `src/data/trust/` | Device identity, signed transcripts, pins, and trust flows |
| `src/terminal/transport/` | Typed RN-to-worker bridge and session/host transports |
| `src/terminal/worker/` | Source and generator for the offline xterm/WebRTC worker |
| `assets/terminal/worker.html` | Generated, self-contained worker asset used by the file fallback |
| `src/theme/` | Exact light/dark tokens, typography, motion, and theme persistence |

Route files should parse parameters and compose a feature component. They should not own protocol,
API, state, or reusable visual logic.

## Startup and data flow

The root layout assembles Safe Area → Gesture Handler → Theme/launch appearance → Query → Realtime
→ Toast → Keyboard → Router. At startup, the auth gate reads the per-server SecureStore token,
loads auth/account/host snapshots, and routes to login, verification, onboarding, or the four-tab
application. Font loading and the theme-matched system background finish before the held splash is
released.

Normal server data flows as:

```text
route → feature component → query hook → typed API client → spawn server
                                  ↑
realtime sockets → cache effects ─┘
```

The server URL is resolved by `src/data/api/config.ts`: persisted runtime override, then
`expo.extra.apiUrl`, then the development localhost fallback. REST, WebSocket URL builders, and
per-origin token storage all consume that one value.

## Terminal transport

```text
┌─ React Native (all UI) ───────────────────────────────────────┐
│  Terminal overlay chrome, modifier bar, keyboard accessory,   │
│  scroll pill, upload UI, connection chip, gestures, haptics   │
│                                                                │
│  Ed25519 private key (expo-secure-store) ── signs transcripts │
│  /ws/browser signalling socket (shared, RN-owned)             │
└───────────────┬────────────────────────────────────────────────┘
                │  JSON bridge: signalling, control, sign requests,
                │  status events, modifier-bar keystrokes
                │  (low volume — PTY bytes never cross this bridge)
┌───────────────▼─ WebView worker (invisible boundary) ─────────┐
│  RTCPeerConnection ── spawn.pty / spawn.ctl DataChannels      │
│  xterm.js 5.5 (WebGL, Unicode11, Fit, WebLinks, Clipboard)    │
│  PTY bytes: DataChannel ──▶ xterm, zero bridge crossings      │
└────────────────────────────────────────────────────────────────┘
```

`TerminalSurface` loads one worker per session. `HostTransportSurface` uses the same worker
boundary for the separate `spawn.host.ctl` peer used by file browsing and exact host capacity.
The Ed25519 seed never enters the WebView, and terminal output never crosses the React Native
string bridge.

The default worker source is inline HTML with `baseUrl: "https://spawn.local/"`. That sentinel
asks WKWebView for a secure context. The generated file asset is already bundled as the first
fallback; `USE_FILE_WORKER_FALLBACK` in each surface selects it if physical-device testing proves
the inline strategy cannot create a secure WebRTC DataChannel. Serving the immutable worker from
the spawn HTTPS origin is the last architectural fallback.

The worker has an inline CSP, bundled xterm/addons, and no remote scripts, stylesheets, fetches, or
CDN assets. The `https://spawn.local/` value is an origin sentinel, not a server request.

## Expo Go native boundary

The project targets Expo SDK 54, React Native 0.81.5, and React 19.1.0. Every imported native
package must either be a first-party SDK 54 Expo Go module or one of the SDK 54 bundled community
modules. Pure-JavaScript packages may only build on that set.

Do not introduce `react-native-webrtc`, MMKV, Unistyles/Nitro, `expo-dev-client`, or a config plugin
whose runtime effect is required for the app to work. Those require a rebuilt native client and
would invalidate Expo Go acceptance.

## Where to look when something breaks

| Symptom | First files/subsystem to inspect |
|---|---|
| Blank screen before navigation | `src/app/_layout.tsx`, `src/lib/providers.tsx`, Metro's first exception |
| Login redirect loop or immediate sign-out | `src/lib/auth-gate.tsx`, `src/data/api/auth-token.ts`, server URL |
| REST screen is stale or errors | Domain hook in `src/data/queries/`, endpoint/schema in `src/data/api/` |
| Live changes do not appear | `src/data/realtime/provider.tsx`, socket URL/token, cache effect mapping |
| Theme or launch flash is wrong | `src/theme/`, root provider/status bar, `app.json`, image/font assets |
| Gesture or keyboard conflict | `src/components/gestures/`, terminal overlay, keyboard provider |
| Terminal Diagnostics capability unavailable | worker source strategy, WKWebView/Expo Go/iOS versions |
| Diagnostics pass but terminal stays connecting | browser signalling, signed transcript, host pin, ICE, daemon |
| Terminal renders but input/output is wrong | worker runtime/session codec and `spawn.pty`/`spawn.ctl` gates |
| Files or host capacity fail | `HostTransportSurface`, host transport, `spawn.host.ctl` |
| Notification missing | alert socket/store/presenter; only local notifications are supported in Expo Go |

## Verification boundaries

`npm run typecheck`, `npm run lint`, `npm test`, `npx expo-doctor`, and
`npx expo export --platform ios` prove types, static behavior, compatible dependencies, import
resolution, and iOS bundling. They cannot prove WKWebView secure-context behavior, WebRTC/ICE on a
real network, keyboard ergonomics, haptics, camera permissions, or final native splash rendering.
Those checks belong to the physical-iPhone run in the root README.
