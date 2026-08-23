# P3-01 — App shell, navigation, deep links and launch assets

**Phase 3, parallel with five other agents.**

**Read first:** `00-OVERVIEW.md` (§3 D7, §4, §5, §8), then `research/06-feature-inventory.md`'s IA
proposal, `research/12-auth-and-flows.md §8` (the required incoming links), and
`research/08-rn-stack.md §3` (navigation) and §11 (splash, fonts, status bar).

## 1. Objective

Assemble the pieces Phase 1 and 2 built into one coherent application that launches, routes and
handles links.

## 2. Files you own

```
src/app/_layout.tsx
src/app/(tabs)/_layout.tsx
src/app/index.tsx                 # replaces P0-01's placeholder
src/lib/linking.ts
src/lib/providers.tsx             # the composed provider tree
assets/images/**                  # final icon/splash (replacing placeholders)
assets/fonts/**
```

## 3. Specification

### 3.1 Provider tree

Compose, in a documented order: SafeArea → GestureHandlerRootView → Theme → QueryClient →
Realtime (`P1-08`'s provider) → Toast (`P1-02`'s provider) → KeyboardProvider → Router. Order
matters; state the dependencies in a comment and in your report.

QueryClient defaults mirror the web app (`research/02 §3`): `staleTime: 10_000`,
`refetchOnWindowFocus: false`, `retry: 1`. **No persisted query cache** in v1 — the web app has
none either. Wire `focusManager`/`onlineManager` through `P1-08`'s `lifecycle.ts`; do not
reimplement it.

### 3.2 Tab bar

Four roots: **Workspaces · Hosts · Files · Settings** (`00-OVERVIEW.md §3 D7`). Native tab bar,
themed, with `P1-01`'s icons and any badge counts `P2-09` publishes. Legion, Profile, Admin and
Archived hang off those roots — they are not tabs.

The terminal route is a **`card` presentation with a vertical dismiss gesture**, not
`fullScreenModal`.

### 3.3 Deep links

`research/12 §TL;DR 10` lists the required incoming links: signup invites, email verification,
password reset, device pairing, onboarding, host/files, workspace focus and session fallbacks. Map
each to a route, with the scheme `spawn` plus any universal-link domain.

**UNKNOWN:** the production domain, bundle id and URL scheme are the owner's inputs. Ship `spawn`
as the scheme and the placeholder bundle id from `app.json`, make the universal-link domain a
single constant, and flag it clearly in your report for the owner to fill in.

Every deep link must work from cold start, not just when the app is already running.

### 3.4 Launch assets

Replace `P0-01`'s placeholders with real icon/splash derived from the brand assets
(`research/01 §7` inventories what exists in `web/public`). Load bundled fonts via `expo-font` with
`expo-splash-screen` held until fonts are ready, then update `src/theme/typography.ts`'s family
constants — coordinate through your report; do not restructure the theme module.

Status bar style follows the theme. Configure `expo-system-ui` background so there is no flash on
launch.

## 4. Rules
- You are assembling, not rewriting. If a Phase 1/2 module has the wrong API, report it — do not
  edit their files.
- Keep route files thin: layout + composition only.

## 5. Tests
- Provider tree mounts without throwing, in order.
- Deep-link resolution: one case per documented link shape → expected route + params, including
  cold start.
- Tab bar renders four roots and routes correctly.
- QueryClient defaults match the documented values.

## 6. Deliverables checklist
- [ ] Composed provider tree with documented ordering
- [ ] Four-root tab bar; terminal as a dismissable card route
- [ ] Complete deep-link map, cold-start safe, with the owner's inputs flagged
- [ ] Real icon/splash/fonts with no launch flash
- [ ] Tests green; `typecheck`, `lint` clean; progress + report written

## 7. Reporting
Progress `docs/native/progress/P3-01.md`; report `docs/native/reports/P3-01.md`, listing the
owner-input placeholders explicitly.
