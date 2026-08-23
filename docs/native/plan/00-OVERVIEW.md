# spawn native mobile app — campaign overview

This is the authoritative plan for building the spawn native mobile app. Every implementation
agent reads this file first, then its own plan file, then the research reports it cites.

- Research reports: `docs/native/research/01..12-*.md` (21,503 lines, written 2026-08-22)
- Per-agent plans: `docs/native/plan/P<phase>-<nn>-<name>.md`
- Branch: `native-app`
- App root: `mobile/`

---

## 1. Mission

Ship a **native iPhone client for spawn** built with React Native + Expo + EAS that:

1. Reproduces the web app's **design language exactly** — same tokens, type, spacing, radii,
   motion, iconography and terminal palettes. Not an interpretation.
2. Reaches **feature parity** with the web client (121 catalogued capabilities, `research/06`).
3. Feels **native**: swipe-dismissable overlays, drag-paged tabs, haptics on every meaningful
   interaction, 60fps lists, real keyboard handling.
4. Centralises data with computed/derived values, global styling and global components.
5. **Boots in Expo Go on a physical iPhone** at the end of this campaign.

The existing responsive/mobile *web* layout is explicitly **not** a reference. Its desktop design
language, its data layer and its wire protocols are.

### The core user journey (build everything else around this)

Workspaces list → open a workspace → horizontal pager of **tabs** → each tab is a vertical list of
**terminals** showing type, name, logo and status → tap one → a full-screen **terminal overlay**
that drags down to dismiss, types well, scrolls well, and has real shortcuts.

---

## 2. Hard constraints

| # | Constraint | Consequence |
|---|---|---|
| C1 | Must run in **Expo Go** | No custom native modules. No config plugins that rebuild native code. No `react-native-webrtc`, no MMKV, no Unistyles, no Nitro modules. |
| C2 | Expo Go on the App Store is **v54.0.2** | Target **Expo SDK 54** exactly. Verified 2026-08-22 via the iTunes lookup API: Expo Go `54.0.2`, released 2025-09-23. SDK 57 being current is irrelevant — the phone can only run what the store binary supports. |
| C3 | No backend changes | The native client adapts to the server as it exists. See §5 — this is achievable; do not fork the backend. |
| C4 | No manual/device testing during the build | Agents verify with typecheck, lint and unit tests only. Human testing happens after. |
| C5 | Design parity is not negotiable | Every colour, radius, duration and font size comes from the token module, which is a transcription of the web CSS. |

---

## 3. Verified architecture decisions

These are settled. Do not relitigate them in an implementation agent.

### D1 — Expo SDK 54, React Native 0.81.5, React 19.1.0

Verified against the live registry and the App Store (C2). The New Architecture is enforced by
Expo Go 54. `research/08 §13` contains copy-ready `package.json`, `app.json`, `eas.json`,
`tsconfig.json`, `metro.config.js`, `babel.config.js`.

**Version rule:** for every Expo-managed native package, the version must match what the Expo Go 54
binary ships. Install with `npx expo install <pkg>` and finish with `npx expo install --fix`;
treat `research/08`'s pins as a starting point, not gospel. Two reports disagreed on
`react-native-webview` (13.15.0 vs 13.16.1) and `react-native-keyboard-controller` (1.18.5 vs
1.21.9) — `expo install` is the tie-breaker, because a native module version that disagrees with
the Expo Go binary crashes on launch.

### D2 — Auth: bearer token lifted from the login `set-cookie`

`research/03` and `research/12` both concluded the native app needs a new server refresh endpoint.
**They are wrong, and the orchestrator verified this directly in the server source:**

- `POST /api/auth/login` returns a 15-minute `access_token` in JSON **and** sets
  `spawn_session` to a **30-day** token (`server/spawn_server/routes/auth.py:121-122`).
- Both tokens are minted by the same `_issue_user_token`, which stamps `"kind": "access"` on
  both (`server/spawn_server/auth.py:66-79`).
- `current_user` accepts `Authorization: Bearer …` and only requires `kind == "access"`
  (`server/spawn_server/auth.py:136-145`).

Therefore: **read the `set-cookie` response header, extract the `spawn_session` JWT, store it in
`expo-secure-store`, and send it as `Authorization: Bearer <jwt>` on every REST call and as
`?token=<jwt>` on every WebSocket.** `HttpOnly` is a browser restriction; React Native's fetch
exposes the header. That gives 30-day sessions with **zero backend changes**.

Fallback if header extraction ever fails on device: React Native's native cookie jar persists
`spawn_session` automatically, so plain `fetch` with no auth header also authenticates. Implement
the bearer path as primary and leave the cookie jar as the accidental safety net; do not build a
third mechanism.

### D3 — Terminal + transport: one WebView worker per session

The blocker: terminal bytes travel over **authenticated WebRTC DataChannels** directly to the
daemon (`spawn.pty` + `spawn.ctl`), the server refuses to relay terminal content, and
`react-native-webrtc` cannot run in Expo Go (C1).

The resolution, which `research/04`, `research/08` and `research/09` independently converged on:
**`react-native-webview` is bundled in Expo Go, and WKWebView implements both `RTCPeerConnection`
and a full DOM.** So each live session gets one WebView that hosts *both* the WebRTC peer *and*
the xterm.js emulator.

```
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

Why this shape and not the obvious alternatives:

- **Bytes never cross the RN bridge.** Putting WebRTC in the WebView but xterm in RN would force
  every byte through `postMessage`. Co-locating them means a flood of output costs nothing.
- **The private key stays native.** The WebView never sees the Ed25519 seed. When the signalling
  transcript needs signing, the WebView posts a sign request to RN, RN signs with the SecureStore
  key and posts back the signature. A handful of small messages per session.
- **The signalling socket stays native.** One RN-owned `/ws/browser` connection, so socket
  lifecycle, reconnect and AppState handling live in one place and are unit-testable.
- **It is swappable.** Everything above the `SessionTransport` interface (§7.4) is renderer- and
  transport-agnostic, so a later EAS development build can drop in native `react-native-webrtc`
  and a native emulator without touching a single screen.

**This is not a web wrapper.** 100% of navigation, lists, chrome, settings, forms, gestures and
haptics are native React Native. The WebView is a headless VT emulator + datachannel endpoint — the
same role a native terminal-emulator library would play. No spawn HTML page is ever loaded; the
worker document is a local, offline, hand-built asset.

**Known risk (R-1), must be proven on device:** WebKit gates WebRTC on a secure context. HTML
loaded via `source={{ html }}` gets an opaque origin. Mitigation, in order: (a) pass
`source={{ html, baseUrl: 'https://spawn.local/' }}` so WKWebView treats the document as
https-origin; (b) fall back to a `file://` document via `expo-asset` (WebKit treats `file:` as
potentially trustworthy); (c) last resort, load the worker from the spawn server over https.
`P1-09` implements (a), leaves (b) behind a one-line switch, and documents the result. This is the
one thing that cannot be settled without a physical iPhone, and the owner will verify it first.

### D4 — Host control also needs a WebView worker

`spawn.host.ctl` (file browsing, transfers, exact capacity) is a *separate* WebRTC peer per host,
not per session (`research/10 §1`, `research/11 §1`). It uses the same worker mechanism with a
different channel protocol, hosted in one hidden WebView per connected host.

### D5 — Styling: plain `StyleSheet` + a typed token module

NativeWind's Tailwind-v4 path is still preview; Unistyles 3 requires native Nitro code (C1
excludes it). Tokens are transcribed from `web/src/app/globals.css` into
`src/theme/*` with every OKLCH colour resolved to sRGB hex (`research/01`).

### D6 — State: TanStack Query + Zustand + pure selectors

Mirrors the web app's architecture (`research/02`): TanStack Query owns server snapshots, pure
selector modules own derived values, Zustand owns transport/session-local state that is not server
truth. No persisted query cache in v1 (the web app has none either).

### D7 — Navigation: Expo Router 6, native stack, four tab roots

Roots: **Workspaces · Hosts · Files · Settings** (`research/06 §TL;DR 3`). Legion, Profile, Admin
and Archived hang off those roots. The terminal overlay is a `card`-presentation route with a
vertical drag-dismiss gesture — *not* `fullScreenModal`, which cannot be gesture-dismissed.

### D8 — Accepted Expo Go limitations (document in-app, do not fight)

| Capability | Status in Expo Go | Native behaviour |
|---|---|---|
| Passkey / WebAuthn PRF trust bundle | Unavailable | Show an explicit "not available on this device" state; endorsement + manual host pairing are the supported paths (`research/05 §5-6`). |
| Remote push notifications | Unavailable, and the server has no push backend at all | Local notifications only, while the app is foregrounded/scheduled (`research/10 §9`). |
| OAuth login (Google/Microsoft/GitHub) | Redirects to a relative web path, cannot return to the app | Email+password only in v1; show the OAuth buttons disabled with a reason. |
| Face-ID-gated SecureStore | Unavailable | Use plain SecureStore. |

---

## 4. Repository layout

Everything the campaign creates lives under `mobile/`. Nothing outside `mobile/` is modified —
not `web/`, not `server/`, not `daemon/`, not `proto/`, not root config.

```
mobile/
├── app.json  eas.json  package.json  tsconfig.json
├── metro.config.js  babel.config.js  biome.json
├── assets/
│   ├── fonts/                     # bundled mono + brand faces
│   ├── images/                    # icon, splash, adaptive-icon, agent logos
│   └── terminal/                  # the WebView worker document + xterm bundle
├── tests/
│   ├── setup.ts
│   └── fixtures/                  # proto vectors copied for offline vector tests
└── src/
    ├── app/                       # expo-router routes ONLY — thin screens, no logic
    │   ├── _layout.tsx
    │   ├── (auth)/                # login, signup, forgot, reset, verify
    │   ├── (onboarding)/
    │   ├── (tabs)/                # workspaces, hosts, files, settings
    │   ├── workspace/[id].tsx
    │   ├── terminal/[sessionId].tsx
    │   └── host/[id]/…
    ├── theme/                     # tokens, provider, typography, motion
    ├── components/
    │   ├── ui/                    # global primitives (§7.1)
    │   ├── gestures/              # pager, swipeable row, drag-dismiss
    │   └── <feature>/             # feature-scoped components
    ├── data/
    │   ├── api/                   # client + typed endpoints + zod schemas
    │   ├── queries/               # useQuery/useMutation hooks
    │   ├── selectors/             # pure derived-value modules
    │   ├── realtime/              # websockets, appstate/network wiring
    │   ├── stores/                # zustand stores
    │   ├── layout/                # LayoutV3 codec + tab/tile algebra
    │   ├── types/                 # domain types
    │   └── queryKeys.ts           # the single query-key registry
    ├── terminal/
    │   ├── transport/             # SessionTransport, HostTransport, bridge
    │   └── worker/                # source for the WebView worker document
    └── lib/                       # crypto, storage, haptics, format, errors
```

### Import convention

`@/` resolves to `mobile/src/`. **Direct imports only — no barrel `index.ts` files.**

```ts
import { Button } from '@/components/ui/button';       // yes
import { Button } from '@/components/ui';              // no
```

Barrels create a file every agent must edit, which is exactly the merge conflict this campaign is
structured to avoid.

---

## 5. Conventions every agent follows

**Files & naming.** `kebab-case.tsx` for files. `PascalCase` React components, `camelCase`
functions, `SCREAMING_SNAKE` module constants. One component per file unless a subcomponent is
private to it. Keep files under ~400 lines.

**Styling.** Never hard-code a colour, radius, spacing value, font size or duration. Everything
comes from `useTheme()` / the token modules. `StyleSheet.create` at module scope for static styles;
inline objects only for values that genuinely depend on props or animation.

**Copy.** All user-facing strings live in the component that renders them, matching the web app's
exact wording (`research/12` quotes the real strings). Do not improvise product copy.

**Types.** TypeScript strict. No `any` in an exported signature. No `@ts-ignore` without a
one-line reason. Wire types come from the zod schemas in `@/data/api`; do not redeclare them.

**Errors.** Every API failure surfaces through the shared `ApiError` shape and the toast/inline
conventions in `research/02 §8`. No silent catches.

**Accessibility.** Every interactive element gets `accessibilityRole` and an
`accessibilityLabel`. Minimum touch target 44×44.

**Haptics.** Use the vocabulary table in `src/lib/haptics.ts` (owned by P1-04). Never call
`expo-haptics` directly from a screen.

**Testing.** Unit tests for every pure function, codec, reducer, state machine and selector you
own. `jest-expo` + `@testing-library/react-native`. No test may need a device, a network, a
server or a real terminal.

**Verification before finishing** (from `mobile/`):
```
npm run typecheck && npm run lint && npm test
```
Clean for the files you own. Failures caused by another agent's not-yet-written file are expected
mid-phase — note them, do not fix them.

**Forbidden, always:** running `git`; adding/removing/upgrading dependencies; editing files you do
not own; creating anything outside `mobile/`; running the app, a simulator, or Expo Go; scope
expansion; speculative abstraction.

---

## 6. Phases and agent roster

Each phase is a batch of codex agents run in parallel. A phase starts only when the previous one
has been reviewed and committed by the orchestrator.

### Phase 0 — Scaffold (1 agent, serial)

| Agent | Scope |
|---|---|
| `P0-01-scaffold` | Create the Expo SDK 54 project, all config files, the complete directory skeleton, the full theme token modules (a mechanical transcription of `research/01`), and the test harness. Proves `typecheck`, `lint`, `test` and a Metro bundle all succeed before anyone else starts. |

### Phase 1 — Core systems (9 agents, parallel)

| Agent | Owns |
|---|---|
| `P1-01-ui-foundation` | Atoms: Text, Button, IconButton, Card, Badge, StatusDot, Spinner, Skeleton, Divider, Monogram, Chip, EmptyState |
| `P1-02-ui-overlays` | Sheet, Dialog, Confirm, Toast + provider, Menu/Popover, ActionSheet, SwipeDismissOverlay |
| `P1-03-ui-forms` | Input, Textarea, Switch, Label, Field, SearchField, SegmentedControl, Select |
| `P1-04-motion-haptics` | Haptics vocabulary, motion constants, TabPager, SwipeableRow, shared animation hooks |
| `P1-05-api-client` | The whole `@/data/api` layer: fetch client, auth token store, zod schemas, every typed endpoint |
| `P1-06-crypto-trust` | Ed25519 identity, SecureStore, signed-signal transcript codec, host pins, proto vector tests |
| `P1-07-domain-model` | Domain types, LayoutV3 codec, tab/tile algebra, all pure selectors, the query-key registry |
| `P1-08-realtime` | Alert socket, browser + host signalling sockets, AppState/network wiring, event→cache mapping, zustand stores |
| `P1-09-terminal-core` | The WebView worker document (xterm + WebRTC), the RN bridge, `SessionTransport`/`HostTransport`, ctl protocol codecs |

### Phase 2 — Features (10 agents, parallel)

| Agent | Owns |
|---|---|
| `P2-01-auth-screens` | Login, signup, forgot, reset, verify-email, the auth gate and session bootstrap |
| `P2-02-onboarding-pairing` | Onboarding flow and the 8-character host pairing ceremony |
| `P2-03-workspaces-list` | Workspaces root: list, create, rename, archive/unarchive, icons, templates |
| `P2-04-workspace-detail` | Tab pager, terminal/widget rows, tab CRUD, reorder, move-to-tab, layout writes |
| `P2-05-terminal-overlay` | The terminal screen: chrome, modifier bar, keyboard accessory, scroll/follow, upload UI |
| `P2-06-hosts` | Hosts list/detail, agents, skills, capacity, Legion |
| `P2-07-files` | File explorer, preview/viewer, uploads and downloads over `spawn.host.ctl` |
| `P2-08-settings` | The nine settings panels, profile, appearance, notifications, devices, device trust |
| `P2-09-alerts` | Alert surfacing, local notifications, activity/attention badges |
| `P2-10-launcher` | New-session flow: folder picker, agent switcher, pending launch, shell handoff |

### Phase 3 — Integration and hardening (6 agents, parallel)

| Agent | Owns |
|---|---|
| `P3-01-app-shell` | Root layout, tab bar, navigation wiring, deep links, splash/icon/fonts |
| `P3-02-longtail` | Admin, archived workspaces, about/download parity, remaining secondary capabilities |
| `P3-03-polish` | Motion, haptics and performance audit against the design spec |
| `P3-04-quality` | Test/lint/typecheck hardening, coverage, CI script |
| `P3-05-boot-verify` | Prove the bundle builds and boots for Expo Go; write the run/install runbook |
| `P3-06-parity-audit` | Audit the build against the 121-capability contract in `research/06`; report gaps |

Dependency rule: **an agent may only depend on interfaces defined in this file or in a plan file
from an earlier phase.** Within a phase, agents never depend on each other's implementation — only
on the contracts in §7.

---

## 7. Shared interface contracts

These are frozen. An agent that needs one of these implements against the signature here, even if
the owning agent has not finished. The owning agent must match it exactly.

### 7.1 Theme — owned by `P0-01`, consumed by everyone

```ts
// @/theme
export type ThemeMode = 'light' | 'dark' | 'system';
export interface Theme {
  isDark: boolean;
  colors: Colors;      // every semantic token, sRGB hex/rgba — see research/01
  space: (n: number) => number;      // 4px unit
  radii: { sm: 6; md: 8; lg: 10; xl: 12; xxl: 16; pill: 9999 };
  type: Typography;    // families, sizes, lineHeights, weights
  motion: Motion;      // durations + easings, see research/01 §motion
  terminal: TerminalTheme;  // xterm palette for the active mode
}
export function useTheme(): Theme;
export function useThemeMode(): { mode: ThemeMode; setMode(m: ThemeMode): void };
```

### 7.2 Haptics — owned by `P1-04`

```ts
// @/lib/haptics
export const haptics: {
  selection(): void;                       // tab change, row select, picker tick
  impact(w: 'light'|'medium'|'heavy'): void;
  success(): void; warning(): void; error(): void;
  overlayOpen(): void; overlayDismiss(): void;   // semantic wrappers
};
```

### 7.3 API — owned by `P1-05`

```ts
// @/data/api/client
export class ApiError extends Error {
  status: number; code: string; detail?: unknown;
}
export function api<T>(path: string, init?: RequestInit & { schema?: ZodType<T> }): Promise<T>;

// @/data/api/auth-token
export const authToken: {
  get(): Promise<string | null>;
  set(jwt: string): Promise<void>;
  clear(): Promise<void>;
  /** Extracts `spawn_session` from a login/signup response's set-cookie header (D2). */
  captureFromResponse(res: Response): Promise<string | null>;
};
```

Endpoint modules live at `@/data/api/endpoints/<domain>.ts` and export one typed async function per
server route, named for the operation (`listWorkspaces`, `patchWorkspace`, `createSession`, …).

### 7.4 Transport — owned by `P1-09`

```ts
// @/terminal/transport/types
export type TransportState =
  | 'idle' | 'signalling' | 'connecting' | 'ready' | 'reconnecting' | 'closed' | 'failed';

export interface SessionTransport {
  readonly sessionId: string;
  readonly state: TransportState;
  open(): Promise<void>;
  close(): void;
  /** stdin. Caller must chunk at 64 KiB — the daemon rejects larger frames. */
  write(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
  requestReplay(fromOffset?: number): void;
  upload(file: UploadRequest): UploadHandle;
  on(ev: 'state', fn: (s: TransportState) => void): () => void;
  on(ev: 'error', fn: (e: TransportError) => void): () => void;
  on(ev: 'title', fn: (t: string) => void): () => void;
  on(ev: 'bell', fn: () => void): () => void;
  on(ev: 'scroll', fn: (s: ScrollState) => void): () => void;
}
export function createSessionTransport(opts: SessionTransportOptions): SessionTransport;
```

The renderer is not part of this interface: PTY bytes go straight to xterm inside the worker
(D3). RN receives only events.

### 7.5 Terminal surface — owned by `P1-09`, rendered by `P2-05`

```tsx
// @/terminal/TerminalSurface
export interface TerminalSurfaceHandle {
  focus(): void; blur(): void;
  sendKey(seq: string): void;            // modifier bar / accessory keys
  scrollToBottom(): void;
  setFollow(follow: boolean): void;
  setFontSize(px: number): void;
  copySelection(): Promise<string | null>;
  search(q: string, dir: 'next' | 'prev'): void;
}
export const TerminalSurface: React.ForwardRefExoticComponent<
  TerminalSurfaceProps & React.RefAttributes<TerminalSurfaceHandle>
>;
```

### 7.6 Query keys — owned by `P1-07`

```ts
// @/data/queryKeys
export const qk = {
  me: () => ['me'] as const,
  hosts: () => ['hosts'] as const,
  host: (id: string) => ['host', id] as const,
  sessions: () => ['sessions'] as const,
  session: (id: string) => ['session', id] as const,
  workspaces: () => ['workspaces'] as const,
  workspace: (id: string) => ['workspace', id] as const,
  // …complete registry transcribed from research/02 §4
} as const;
```

### 7.7 Crypto & trust — owned by `P1-06`

```ts
// @/lib/crypto/identity
export const deviceIdentity: {
  ensure(): Promise<{ publicKey: Uint8Array; deviceId: string }>;
  publicKey(): Promise<Uint8Array | null>;
  /** Bounded signing only. Never exposes or exports the seed. */
  signSignalTranscript(t: SignalTranscript): Promise<Uint8Array>;
  signApproval(t: ApprovalTranscript): Promise<Uint8Array>;
  reset(): Promise<void>;
};
```

---

## 8. Path ownership matrix

One owner per path, for the life of the campaign. If your plan does not list a path, you do not
write to it.

| Path | Owner |
|---|---|
| `mobile/*` (root config), `mobile/tests/setup.ts` | `P0-01` |
| `mobile/src/theme/**` | `P0-01` |
| `mobile/src/components/ui/{text,button,icon-button,card,badge,status-dot,spinner,skeleton,divider,monogram,chip,empty-state}.tsx` | `P1-01` |
| `mobile/src/components/ui/{sheet,dialog,confirm,toast,menu,popover,action-sheet,swipe-dismiss-overlay}.tsx` | `P1-02` |
| `mobile/src/components/ui/{input,textarea,switch,label,field,search-field,segmented-control,select}.tsx` | `P1-03` |
| `mobile/src/components/gestures/**`, `mobile/src/lib/haptics.ts`, `mobile/src/lib/motion/**` | `P1-04` |
| `mobile/src/data/api/**` | `P1-05` |
| `mobile/src/lib/crypto/**`, `mobile/src/lib/secure-storage.ts`, `mobile/src/data/trust/**` | `P1-06` |
| `mobile/src/data/{types,selectors,layout}/**`, `mobile/src/data/queryKeys.ts` | `P1-07` |
| `mobile/src/data/{realtime,stores}/**` | `P1-08` |
| `mobile/src/terminal/**`, `mobile/assets/terminal/**` | `P1-09` |
| `mobile/src/app/(auth)/**`, `mobile/src/components/auth/**` | `P2-01` |
| `mobile/src/app/(onboarding)/**`, `mobile/src/components/onboarding/**` | `P2-02` |
| `mobile/src/app/(tabs)/workspaces/**`, `mobile/src/components/workspaces/**` | `P2-03` |
| `mobile/src/app/workspace/**`, `mobile/src/components/workspace-detail/**` | `P2-04` |
| `mobile/src/app/terminal/**`, `mobile/src/components/terminal-ui/**` | `P2-05` |
| `mobile/src/app/(tabs)/hosts/**`, `mobile/src/app/host/**`, `mobile/src/components/hosts/**` | `P2-06` |
| `mobile/src/app/(tabs)/files/**`, `mobile/src/components/files/**` | `P2-07` |
| `mobile/src/app/(tabs)/settings/**`, `mobile/src/components/settings/**` | `P2-08` |
| `mobile/src/components/alerts/**`, `mobile/src/lib/notifications.ts` | `P2-09` |
| `mobile/src/components/launcher/**` | `P2-10` |
| `mobile/src/app/_layout.tsx`, `mobile/src/app/(tabs)/_layout.tsx`, `mobile/src/lib/linking.ts` | `P3-01` |
| `mobile/src/app/admin/**`, `mobile/src/components/admin/**` | `P3-02` |
| `mobile/docs/**` | `P3-05` |

`mobile/src/data/queries/**` is partitioned by domain: each Phase-2 agent owns
`queries/<its-domain>.ts` and no other.

---

## 9. Definition of done for the campaign

1. `npm run typecheck`, `npm run lint`, `npm test` all pass clean from `mobile/`.
2. `npx expo export --platform ios` produces a bundle with no resolution errors.
3. `npx expo start` serves a bundle that Expo Go 54 on a physical iPhone can load.
4. The owner can log in, see workspaces, open a workspace, page between tabs, see terminals with
   type/name/logo/status, open a terminal overlay, type into it, and dismiss it by dragging.
5. `P3-06` reports parity against the 121-capability contract, with every gap explicitly listed.

Items 3 and 4 are the owner's to verify on device. Everything before them is the campaign's.
