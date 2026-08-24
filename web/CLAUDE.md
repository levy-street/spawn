# Working agreements for web/

The Next.js (App Router) browser frontend. `AGENTS.md` beside this file is a
symlink to it. Read the repo root `CLAUDE.md` first — `mobile/` is the other
frontend of the same product, and any user-facing change here ships with its
mobile counterpart in the same commit: screens, copy, validation, empty
states, error messages. A change that is genuinely browser-only (a WebAuthn
ceremony, a download page) says so in the commit message.

## Layout

```
src/
  app/            one directory per route (App Router)
                  admin/ app/ device/ download/ forgot-password/ hosts/
                  legion/ login/ onboarding/ reset-password/ security/
                  sessions/ signup/ trust-ux-demo/ verify-email/ w/
  components/     UI grouped by product area
                  access/ auth/ brand/ files/ hosts/ icons/ legion/ nav/
                  onboarding/ profile/ session/ settings/ terminal/ trust/
                  ui/ workspace/
  hooks/          React hooks shared across areas (useHostControl, …)
  lib/            framework-free logic: API client, crypto, ceremonies,
                  alerts — with colocated *.test.ts files
  trust-ux/       trust and identity UX flows
  middleware.ts   request middleware (+ its test beside it)
tests/e2e/        Playwright end-to-end specs
scripts/          build wrappers (next-with-proxy-target.mjs) and helpers
public/           static assets
```

## Where things go

- A new route: `src/app/<route>/page.tsx`. Components used by only that route
  stay in its directory.
- Reusable UI for a product area: `src/components/<area>/`. Primitives with no
  area (buttons, menus, dialogs): `src/components/ui/` — look there before
  writing a new one.
- Logic that does not touch React: `src/lib/`, with a `*.test.ts` next to it.
  Unit tests colocate with the code they test; there is no parallel test tree.
- A hook used by more than one area: `src/hooks/`.

## Conventions

- Tailwind for styling. Server components by default; `"use client"` only
  where interaction requires it.
- Biome is the linter and formatter (`biome.json`). No eslint, no prettier.
- The app is single-origin: `/api/*`, `/ws/*`, and `/healthz` are Next
  rewrites to the FastAPI server, baked into the build from
  `SPAWN_API_PROXY_TARGET`. `scripts/next-with-proxy-target.mjs` wraps
  build/start and refuses a silent default outside `dev`. Never call the API
  cross-origin.

## Before calling a change done

```bash
npm run lint && npx tsc --noEmit
npx bun test src              # unit tests run under bun, not jest
npm run test:e2e              # Playwright, when the change warrants it
```

## Keeping this file true

Agents and people plan work from this file, so a stale version misroutes every
change that follows it. A commit that adds, renames, or moves a directory
under `src/`, changes a convention, or changes a command above updates this
file in the same commit. `scripts/check-claude-md.sh` (run by
`scripts/test-all.sh`) fails when a tracked directory here is not named in
this file.
