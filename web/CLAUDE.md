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
                  [slug]/ admin/ app/ device/ download/ for/ forgot-password/
                  hosts/ legion/ login/ onboarding/ reset-password/
                  run-agents-in-parallel/ security/ sessions/ signup/
                  trust-ux-demo/ use/ verify-email/ vs/ w/
                  ([slug]/ is the flat-URL landing-page router — see "SEO
                  landing pages"; for/ and use/ are the legacy registry
                  families; vs/ is the comparisons hub, its spokes now flat;
                  run-agents-in-parallel/ is the hand-built flagship from
                  docs/SEO_TREE.md)
  components/     UI grouped by product area
                  access/ auth/ brand/ files/ hosts/ icons/ legion/ nav/
                  onboarding/ profile/ seo/ session/ settings/ terminal/
                  trust/ ui/ workspace/
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

## SEO landing pages

Landing pages are data, not JSX. Two generations coexist during the
rework (`docs/SEO_TREE.md` is the page catalogue, `docs/SEO_RUNBOOK.md` the
process):

- **Flat slugs (current)**: one entry per page in `src/lib/seo/` template
  files (`comparisons.ts` so far), catalogued by `src/lib/seo/flat.ts` and
  rendered by `app/[slug]/` through the templates in
  `src/components/seo/templates/` (job frame, comparison, the live fleet
  capture in `public/product/`). `src/lib/seo/flat.test.ts` holds the
  invariants, including the denylist that keeps flat slugs off static
  routes. `app/run-agents-in-parallel/` is the hand-built flagship on the
  job template.
- **Legacy registry**: `/use/*` and `/for/*` entries in
  `src/lib/seo/{use-cases,agents}.ts`, rendered by
  `src/components/seo/SeoLandingPage.tsx`; `registry.test.ts` holds their
  invariants. They migrate to flat slugs at rework time.

The sitemap (`app/sitemap.ts`), hubs, and cross-links follow from both
catalogues (`related` keys starting with "/" resolve against the flat one).
Titles and H1s stay plain-language for search; the demon voice lives in body
copy. Every claim must survive a diff against `docs/TRUST.md`.

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
