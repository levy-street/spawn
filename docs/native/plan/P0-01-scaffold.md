# P0-01 — Scaffold the Expo SDK 54 app and the theme system

**Phase 0. You run alone.** Nine agents start the moment you finish, and every one of them builds
on what you create. If your foundation is wrong, nine parallel agents build on a wrong foundation.
Precision matters more than speed here.

**Read first:** `docs/native/plan/00-OVERVIEW.md`, then `docs/native/research/08-rn-stack.md`
(especially §13 "Copy-ready v1 scaffold" and Appendix A), then
`docs/native/research/01-design-system.md` (especially the closing "Native token module shape").

---

## 1. Objective

Produce a **running, verifiable, empty** Expo SDK 54 application at `mobile/` with:

- every config file correct for Expo Go 54,
- the complete directory skeleton the campaign expects,
- the **entire theme/token system** implemented and tested,
- a working test harness,

such that `npm run typecheck`, `npm run lint`, `npm test` and `npx expo export --platform ios` all
succeed on a tree with no feature code in it.

**Non-goals.** No screens beyond a placeholder home. No components beyond the theme. No API
client, no navigation structure beyond the router root, no terminal, no business logic. Those
belong to Phase 1 and Phase 2 agents who start after you. Creating them is out of scope and will
be reverted.

---

## 2. Hard constraints

- **Expo SDK 54.** Expo Go on the App Store is v54.0.2 (verified 2026-08-22). SDK 57 exists; it is
  irrelevant, because the phone cannot run it. Do not "upgrade" anything to 55/56/57.
- **Every Expo-managed native package must match the Expo Go 54 binary.** Install them with
  `npx expo install <pkg>`, never `npm install <pkg>`, and finish with `npx expo install --fix`.
  `research/08 §13` gives a starting version set, but two reports disagreed on
  `react-native-webview` (13.15.0 vs 13.16.1) and `react-native-keyboard-controller` (1.18.5 vs
  1.21.9). **`expo install` is the tie-breaker.** A native module version that disagrees with the
  Expo Go binary crashes the app on launch, so record in your report the exact resolved version of
  every native package.
- **No custom native modules, no config plugins that rebuild native code.** If `expo install`
  wants to add a plugin that requires a dev build, stop and report it.
- Node: the repo baseline is 22.19.x. Global `node` on this machine is v24.18.0, which Expo 54 may
  reject. `nvm` is installed with **22.17.1** available (`~/.nvm/versions/node/v22.17.1`). If the
  Expo CLI complains about the Node version, use that one and record what you did.
- `bun` is **not** installed globally on this machine. Use `npm` for installs. Do not add a bun
  lockfile. Leave `"packageManager"` out of `package.json` rather than declaring a package manager
  that isn't present.

---

## 3. Work items

### 3.1 Create the project

Create `mobile/` **inside the existing repo** — do not run a scaffolder that tries to
`git init`, and do not let it write outside `mobile/`.

Preferred: create the directory and author the config files directly from `research/08 §13`, then
`npm install`. That is more predictable than `create-expo-app`, which pulls a template you would
then have to strip. If you do use a template, delete every example screen, component, hook and
asset it ships before you finish — an untouched template file left in the tree is a defect.

### 3.2 Config files

Author all of these, taking `research/08 §13` as the source and correcting versions via
`expo install`:

| File | Notes |
|---|---|
| `mobile/package.json` | Scripts exactly as in §3.6 below. `"main": "expo-router/entry"`. |
| `mobile/app.json` | Name `spawn`, slug `spawn`, scheme `spawn`, `userInterfaceStyle: "automatic"`, `newArchEnabled: true`, bundle id `dev.spawnd.spawn`. Splash/icon reference the placeholder assets you create in §3.4. |
| `mobile/eas.json` | `development`, `preview`, `production` profiles. Development profile sets `developmentClient: true` for the eventual dev build; this campaign does not use it, but the file must be correct. |
| `mobile/tsconfig.json` | `extends: "expo/tsconfig.base"`, `strict: true`, path alias `@/* → src/*`. |
| `mobile/metro.config.js` | Default Expo config. Ensure Metro's `watchFolders` does **not** climb into `web/`, `server/`, `daemon/` or the repo root `node_modules` — a repo-wide crawl is slow and can break the bundler. |
| `mobile/babel.config.js` | `babel-preset-expo`. Reanimated 4 uses the worklets plugin — confirm the correct plugin for SDK 54 and add it last in the plugin list if required. |
| `mobile/biome.json` | Match the conventions of `web/biome.json` so the repo lints consistently. Biome is the repo's linter; do not introduce ESLint or Prettier. |
| `mobile/.gitignore` | `node_modules/`, `.expo/`, `dist/`, `*.log`, `.DS_Store`, `ios/`, `android/`. |

### 3.3 Directory skeleton

Create every directory in `00-OVERVIEW.md §4` so no later agent has to create a shared parent.
Put a `.gitkeep` in any directory you leave empty. **Do not create stub `.ts` files for other
agents' modules** — an empty stub that later gets overwritten is worse than a missing file,
because it makes `typecheck` pass on code that does not exist yet.

Exception: create `mobile/src/app/index.tsx` as a minimal placeholder screen (a themed `View` with
the spawn wordmark and the text "spawn") so the app has something to render. `P3-01` replaces it.

### 3.4 Assets

- `assets/images/icon.png`, `adaptive-icon.png`, `splash.png` — placeholder solid-colour images in
  the brand palette at the correct dimensions (1024×1024 icon). Generate them programmatically or
  with a tiny script; do not copy anything from `web/public` that you have not confirmed is
  appropriate, and do not fabricate a logo. If `web/public` contains a usable spawn mark, use it
  and say so in your report.
- `assets/fonts/` — leave empty with a `.gitkeep`. Font selection is `P3-01`'s call; the theme
  module must fall back cleanly to system faces until then (§3.5).

### 3.5 The theme system — the substantial part of your job

Implement `mobile/src/theme/` as a faithful transcription of the web design system.
`research/01-design-system.md` did the extraction work, including converting every OKLCH
declaration to sRGB hex with worked examples. **Its closing "Native token module shape" section is
written to be copied.** Copy it; do not re-derive the colours, and do not "improve" any value.

Files to create:

```
src/theme/colors.ts       # light + dark semantic palettes, brand palette, status tones
src/theme/typography.ts   # families, sizes, line heights, weights, letter spacing
src/theme/spacing.ts      # 4px unit helper + named radii
src/theme/motion.ts       # durations + easing curves, named per interaction
src/theme/terminal.ts     # xterm palettes (all ANSI colours) for both modes
src/theme/theme.ts        # assembles a Theme object per mode
src/theme/provider.tsx    # ThemeProvider + useTheme() + useThemeMode()
src/theme/index.ts        # the ONE exception to the no-barrel rule: re-export the public API
```

Requirements:

- The public API is exactly `00-OVERVIEW.md §7.1`. Nine agents are coding against that signature
  right now; it cannot drift.
- `ThemeMode` is `'light' | 'dark' | 'system'`, defaults to `system`, follows OS appearance live
  via `useColorScheme()`, and persists the user's choice under the same storage key family the web
  app uses (`research/01` documents it as `spawn.theme`). Use `@react-native-async-storage/async-storage`.
- Every colour is a literal sRGB hex or rgba string. No OKLCH at runtime — React Native cannot
  parse it.
- `space(n)` returns `n * 4`. Radii are `sm:6 md:8 lg:10 xl:12 xxl:16 pill:9999`.
- Typography falls back to system faces (`System` sans, and the platform monospace stack for
  terminal/code) until real fonts are bundled. Structure it so swapping in a bundled face later is
  a one-line change.
- `motion` exposes named durations and easings tied to interactions (press, dialog, sheet, toast,
  status pulse), per `research/01 §motion`. The web app uses **no springs** — 150ms
  `cubic-bezier(0.4,0,0.2,1)` is the default and shell geometry uses 200ms
  `cubic-bezier(0.32,0.72,0,1)`. Express these as Reanimated-compatible easing definitions.

**Tests** (`src/theme/__tests__/`):
- every semantic token exists in both light and dark palettes, with no missing keys in either;
- every colour value parses as a valid hex/rgba string;
- `space()` arithmetic;
- the mode resolver maps `system` to the OS scheme and explicit modes to themselves;
- a snapshot of the assembled light and dark `Theme` objects, so later drift is visible in review.

### 3.6 Scripts and test harness

`package.json` scripts:

```json
{
  "start": "expo start --lan",
  "start:tunnel": "expo start --tunnel",
  "ios": "expo start --ios",
  "typecheck": "tsc --noEmit",
  "lint": "biome check .",
  "lint:fix": "biome check --write .",
  "test": "jest",
  "test:ci": "jest --ci --coverage",
  "ci": "npm run typecheck && npm run lint && npm run test:ci"
}
```

Jest: `jest-expo` preset, `tests/setup.ts` in `setupFilesAfterEach`, `@/` module name mapping,
`testMatch` covering `src/**` and `tests/**`. `tests/setup.ts` should install
`@testing-library/react-native` matchers and any mocks that every suite needs
(`expo-haptics`, `react-native-reanimated`'s jest setup, `expo-secure-store`). Keep it small —
later agents will ask you to add mocks; they cannot, so make the obvious ones present.

### 3.7 Proto fixtures for offline vector tests

`P1-06` must verify its Ed25519 and transcript implementations against the repo's cross-runtime
vectors without reading outside `mobile/`. Copy these files to `mobile/tests/fixtures/`:

```
proto/signed-signal-v1-vectors.json
proto/signed-signal-wire-v1-vectors.json
proto/browser-device-registration-v1-vectors.json
proto/host-pair-approval-v1-vectors.json
proto/host-pair-possession-v1-vectors.json
proto/ed25519-public-key-negative-vectors.json
proto/layout-v3-fixtures.json
```

Copy them byte-for-byte. Do not reformat, re-key or "clean" them — they are golden fixtures.

---

## 4. Verification (all must pass before you finish)

```bash
cd mobile
npm run typecheck      # clean
npm run lint           # clean
npm test               # theme tests pass
npx expo export --platform ios   # bundles with no resolution errors
```

Also run `npx expo-doctor` and record the output. Warnings about missing EAS project id or missing
fonts are expected; anything about incompatible package versions is **not** — fix those.

Do **not** run `expo start`, open a simulator, or try to load the app on a device.

---

## 5. Deliverables checklist

- [ ] `mobile/` exists with all config files, correct for Expo Go 54
- [ ] Every native package version resolved via `expo install`, and the resolved set recorded in the report
- [ ] Full directory skeleton per `00-OVERVIEW.md §4`
- [ ] Placeholder `src/app/index.tsx` renders a themed screen
- [ ] Placeholder icon/splash assets at correct dimensions
- [ ] Complete `src/theme/**` matching `00-OVERVIEW.md §7.1`, transcribed from `research/01`
- [ ] Theme tests pass, including light/dark parity and snapshots
- [ ] Proto fixtures copied to `tests/fixtures/`
- [ ] `typecheck`, `lint`, `test`, `expo export` all green
- [ ] Progress file kept current throughout
- [ ] Final report written

---

## 6. Reporting

- Progress: `docs/native/progress/P0-01.md`, rewritten every meaningful unit of work, in the
  format given in your shared context.
- Final report: `docs/native/reports/P0-01.md`. It must include:
  - the **exact resolved version of every dependency** (paste `npm ls --depth=0`), because Phase 1
    agents are forbidden from installing anything and need to know what they have;
  - the `expo-doctor` output;
  - the full public API of `src/theme` as you actually implemented it, so Phase 1 can rely on it;
  - any place `research/08 §13` was wrong and what you did instead;
  - `## Requests for other agents` and `## Known gaps`.
