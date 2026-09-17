# Working agreements for mobile/

The Expo / React Native app. `AGENTS.md` beside this file is a symlink to it.
Read the repo root `CLAUDE.md` first — `web/` is the other frontend of the
same product, and any user-facing change here ships with its web counterpart
in the same commit: screens, copy, validation, empty states, error messages.
A change that is genuinely native-only (Face ID, push registration) says so in
the commit message.

## Layout

```
src/
  app/            expo-router screens
    (auth)/       signed-out stack: login, signup, invites
    (drawer)/     signed-in shell and everything inside it
    onboarding/   first-run flow
    terminal/     full-screen terminal route
    __tests__/    route-level tests
    _layout.tsx   root providers and navigation shell
    index.tsx     entry redirect
  components/     UI grouped by product area
                  admin/ alerts/ auth/ brand/ files/ gestures/ hosts/
                  launcher/ layout/ longtail/ media/ nav/ onboarding/
                  release/ settings/ terminal-ui/ trust/ ui/
                  workspace-detail/ workspaces/
  data/           everything that talks to the server or holds client state
    api/          HTTP client and endpoints
    queries/      TanStack Query hooks; keys live in queryKeys.ts
    realtime/     websocket and live-update plumbing
    selectors/    derived data
    stores/       zustand stores for client-only state
    trust/        device identity and endorsement state
    types/        shared types for the data layer
    layout/       persisted layout state
    __tests__/    data-layer tests
  lib/            platform glue: crypto/, oauth, apple-auth, push,
                  notifications, release-watcher, updates, secure-storage,
                  haptics, linking, motion/, providers, share, validation
  terminal/       terminal surface components
  theme/          design tokens — every colour, spacing, and type value
assets/           icons and splash
e2e/, tests/      end-to-end and fixture suites
scripts/, docs/   build helpers and app-specific notes
```

## Where things go

- A new screen: `src/app/` in the right group; route-private pieces stay next
  to it.
- Area UI: `src/components/<area>/`. Primitives: `src/components/ui/` — look
  there before writing a new one.
- Server data: an endpoint in `data/api/` plus a query hook in
  `data/queries/` with its key in `queryKeys.ts`. Components never fetch
  directly.
- Client-only state: `data/stores/`.
- Realtime: the subprotocol names in `data/realtime/` (`spawn.v3`,
  `spawn.alerts.v1`) are the compatibility contract with the server, not a
  version — a server that requires a different one refuses the socket with a
  `protocol.required` frame, which is what routes into the update path. Read
  "The wire protocols" in `docs/RELEASE.md` before changing one.
- Tests colocate in the nearest `__tests__/` directory (jest).
- `e2e/NATIVE_ACCEPTANCE.md` describes the GitHub-hosted iOS simulator and Android
  emulator acceptance job. Its controller and RTC observation hook enter only a
  disposable build copy, using the actual app providers and native WebViews.
  The Android job removes generated build directories after preserving the APK
  and metadata; `e2e/test-compact-android-build.py` checks cleanup boundaries.
  Its hosted disk preflight reclaims only named unused tools on the disposable
  Ubuntu runner when less than 40 GiB is free and measures build/emulator headroom
  without recursively scanning tool trees. Local machines are refused;
  `e2e/test-android-disk-preflight.py` tests these boundaries.
  `e2e/test-native-runner.py` checks bounded installation, diagnostics and failure
  reporting. These checks run through the root test matrix.
  The restored-login regression uses the real AuthGate and verifies that the
  controller does not retire an already-restored account during process relaunch.
  Production routes and assets must never import this controller.

## Conventions

- Style only with `@/theme` tokens and the `ui/` primitives — no raw hex
  values, no inline magic numbers.
- Biome is the linter (`biome.json`).
- After login, use `adoptAuthenticatedAccount` in `data/queries/auth.ts` to clear
  prior account data and seed the new account while retaining mounted query
  observers, including disabled ones; removing them can strand `AuthGate`.
  The new account is seeded synchronously; the returned promise settles the
  active query reset. Acceptance automation awaits it before device registration
  so stale readiness cannot race native secure-storage operations.
- Anything that touches the native layer — a dependency with native code, a
  config plugin, entitlements, icons, `app.json` version — changes what can
  ship over-the-air. Read `docs/RELEASE.md` before touching it.

## Running it against a local server

```bash
npm run dev --onboarding      # from the repo root: server, web, daemon reset, Metro
npm run dev --mobile          # Metro alongside a normal dev run
```

Both print `exp://<this machine's LAN address>:8081` to type into Expo Go. The
address is the point: `src/data/api/config.ts` derives the dev API URL from the
Metro host it connected to, because in Expo Go "localhost" is the *phone*. So a
LAN Metro is what aims the app at the machine running the server, and `--tunnel`
or a Metro on `127.0.0.1` silently falls back to a localhost the phone cannot
reach. `scripts/dev.sh` clears `EXPO_PUBLIC_API_URL` before starting Metro for
the same reason — set, it outranks that derivation and would point a local app
at production. `SPAWN_DEV_MOBILE=0` leaves Metro out of an onboarding run.

- Device transport: `terminal/DaemonConnections.tsx` mounts the persistent
  host workers under the authenticated app. `transport/host-transport-registry.ts`
  scopes them by account and host identity; `session-transport.ts` owns only
  view attachments. Host-tool surfaces own separate consumer channels;
  `worker/worker-host-consumers.js` isolates their queues and protocol failures
  from the root and sibling consumers. `worker/worker-pair.js` proxies terminal
  channels through the native bridge. Rebuild `worker.html` and `worker-html.ts` with
  `node src/terminal/worker/build-worker.mjs` after worker source edits.
  Read `docs/DEVICE_CONNECTIONS.md` before changing lifecycle or control rules.
  Native surfaces check the three-second background deadline on foreground as
  well as in the timer callback, because the runtime can pause background timers.
  Native close retires the root synchronously; its delayed WebView acknowledgement
  must not close a replacement connection opened on the same bridge.
  Native acceptance selects an iPhone runtime matching the active Xcode simulator
  SDK; an explicit `--device UUID` opts into another installed runtime.

## Before calling a change done

```bash
npm run ci                    # typecheck + lint + jest
bash e2e/build-native-acceptance.sh ios /tmp/spawn-native-ios  # local fixture required
```

The native command requires Xcode (or use `android` with the Android SDK), an
authenticated loopback acceptance fixture, and the environment described in
`e2e/NATIVE_ACCEPTANCE.md`. `.github/workflows/native-acceptance.yml` runs both
platforms against an exact candidate commit with real UDP relay faults. Jest,
Metro exports, Expo Go, and generated native projects do not satisfy that gate.
Fixture preparation copies the daemon pair and exposes build configuration;
the native runner activates live accounts, daemon and sessions only after app
installation. Startup and liveness failures fail evidence without restarting
fixture processes.
After fixture readiness, app boot has a separate 180-second deadline. Local
startup diagnostics and validated-device failure captures remain available
when the acceptance control channel cannot report an error.

## Keeping this file true

Agents and people plan work from this file, so a stale version misroutes every
change that follows it. A commit that adds, renames, or moves a directory
under `src/`, changes a convention, or changes a command above updates this
file in the same commit. `scripts/check-claude-md.sh` (run by
`scripts/test-all.sh`) fails when a tracked directory here is not named in
this file.
