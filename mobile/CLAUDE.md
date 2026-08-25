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
                  settings/ terminal-ui/ trust/ ui/ workspace-detail/
                  workspaces/
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
                  notifications, secure-storage, haptics, linking, motion/,
                  providers, share, validation
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
- Tests colocate in the nearest `__tests__/` directory (jest).

## Conventions

- Style only with `@/theme` tokens and the `ui/` primitives — no raw hex
  values, no inline magic numbers.
- Biome is the linter (`biome.json`).
- Anything that touches the native layer — a dependency with native code, a
  config plugin, entitlements, icons, `app.json` version — changes what can
  ship over-the-air. Read `docs/RELEASE.md` before touching it.

## Before calling a change done

```bash
npm run ci                    # typecheck + lint + jest
```

## Keeping this file true

Agents and people plan work from this file, so a stale version misroutes every
change that follows it. A commit that adds, renames, or moves a directory
under `src/`, changes a convention, or changes a command above updates this
file in the same commit. `scripts/check-claude-md.sh` (run by
`scripts/test-all.sh`) fails when a tracked directory here is not named in
this file.
