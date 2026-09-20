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
                  [slug]/ admin/ app/ claude-plan-calculator/ desktop-build/
                  device/ docs/ download/ forgot-password/ hosts/ legion/
                  llms.txt/ login/ onboarding/ reset-password/ security/
                  sessions/ signup/ tmux-cheatsheet/ verify-email/ w/
                  ([slug]/ renders the SEO page catalogue — see "SEO pages";
                  claude-plan-calculator/ and tmux-cheatsheet/ are its two
                  hand-built tool pages; docs/ renders design documents from
                  ../docs on-site; llms.txt/ serves the AI-crawler summary)
  components/     UI grouped by product area
                  access/ auth/ brand/ files/ grimoire/ hosts/ icons/ legion/
                  nav/ release/ onboarding/ profile/ session/ settings/
                  terminal/ trust/ ui/ workspace/
                  (grimoire/ is the frame and templates of the SEO pages)
  hooks/          React hooks shared across areas (useHostControl, …)
  lib/            framework-free logic: API client, crypto, ceremonies,
                  alerts — with colocated *.test.ts files
  middleware.ts   request middleware (+ its test beside it)
tests/e2e/        Playwright end-to-end specs
scripts/          build wrappers (next-with-proxy-target.mjs) and helpers
                  (og-shots.mjs renders SEO pages' OG images from a dev server)
public/           static assets (og/ holds the per-page OG images)
```

The retired production mockup paths `src/trust-ux/` and
`src/app/trust-ux-demo/` were deleted; trust UI belongs with its live product
area and must not be reintroduced through a public demo route.

## Where things go

- A new route: `src/app/<route>/page.tsx`. Components used by only that route
  stay in its directory.
- Reusable UI for a product area: `src/components/<area>/`. Primitives with no
  area (buttons, menus, dialogs): `src/components/ui/` — look there before
  writing a new one.
- Logic that does not touch React: `src/lib/`, with a `*.test.ts` next to it.
  Unit tests colocate with the code they test; there is no parallel test tree.
- A hook used by more than one area: `src/hooks/`.
- A keyboard chord: `src/lib/keyboard-chords.ts` decides who owns one, the
  app or the shell inside the terminal, and the answer differs by platform —
  on a Mac ⌥ is the terminal's word key, so the grid asks for ⌃⌥ or ⌘⌥
  wherever a terminal is listening, while on Windows and Linux Alt is the
  app's and Ctrl is the shell's. Read it before binding anything with a
  modifier: a document-level capture listener quietly taking ⌥+Arrow from a
  focused terminal is the exact bug that module exists to prevent, and the
  same file states the arrow sequences the terminal sends for itself, because
  xterm.js's own platform detection is wrong inside this bundle.
- A websocket change: the subprotocol names in `src/lib/ws.ts` and
  `src/lib/alerts.ts` (`spawn.v3`, `spawn.alerts.v1`) are the compatibility
  contract with the server, not a version — a server that requires a different
  one refuses the socket, and the refusal is what raises the hard reload
  prompt. Read "The wire protocols" in `docs/RELEASE.md` before changing one.

## SEO pages

The landing pages prescribed by the keyword grimoire (`spawnd-seo-grimoire.html`
at the repo root; `docs/SEO.md` is the short guide). Pages are data, not JSX:
one entry per page in `src/lib/grimoire/` — `articles/*.ts` (one file per
keyword cluster, each headed by the vendor pages its facts were checked
against), `hubs.ts`, `comparisons.ts` — catalogued by `src/lib/grimoire/catalogue.ts`
and rendered by `app/[slug]/` through `src/components/grimoire/` (the frame in
the pressroom's ink, and the article, hub, and comparison templates).
`catalogue.test.ts` holds the invariants: a slug never shadows a static route
or a public asset, every link inline or related resolves, titles and
descriptions stay inside snippet budgets, a guide has steps. Paragraph strings
accept the inline markup of `src/lib/grimoire/inline.ts` (`code` spans and
`[text](href)` links). The sitemap, the `/guides` rack, and `/llms.txt` follow
from the catalogue. Every claim about spawnd survives a diff against
`docs/TRUST.md`.

## Conventions

- Tailwind for styling. Server components by default; `"use client"` only
  where interaction requires it.
- Biome is the linter and formatter (`biome.json`). No eslint, no prettier.
- The app is single-origin: `/api/*`, `/ws/*`, and `/healthz` are Next
  rewrites to the FastAPI server, baked into the build from
  `SPAWN_API_PROXY_TARGET`. `scripts/next-with-proxy-target.mjs` wraps
  build/start and refuses a silent default outside `dev`. Never call the API
  cross-origin.
- This app is also the macOS desktop app's product face, loaded into its
  window. `useDesktopShell()` (`src/hooks/`) says so, read from the webview's
  user agent in an effect — never during render, or the first client render
  will not match the HTML it hydrates. Inside that window there is no address
  bar and no way back, so anything that leads to the marketing site is a dead
  end: a link to `/`, the masthead, the colophon, a brand mark that goes home.
  New chrome that leaves the product has to answer for itself there. That
  window is also the app's own device: on the way in the app leaves its
  Ed25519 identity in `sessionStorage` and `src/lib/desktop-device-handover.ts`
  takes it (once, only under that user agent) before the page registers as
  anything, so the product runs as "SPAWN D on Mac" — the device that
  possessed the computer — and never as a second device of its own.

- Device transport: `DaemonConnectionsProvider` owns one signed host connection
  per registered device and host. Identity replacement retires its connections.
  `lib/daemon-connection.ts` shares it across tabs with
  Web Locks and BroadcastChannel; terminal hooks and host/file consumers own
  channels only. Never create a peer or signaling websocket in a terminal.
  Read `docs/DEVICE_CONNECTIONS.md` before changing attachment or control rules.

## Before calling a change done

```bash
npm run lint && npx tsc --noEmit
npx bun test src              # unit tests run under bun, not jest
npm run test:e2e              # Playwright, when the change warrants it
```

An end-to-end test that starts another Next server gives it its own disposable
`SPAWN_NEXT_DIST_DIR`. Sharing `.next` overwrites the running suite's build.
Use `SPAWN_NEXT_TSCONFIG_PATH` with a disposable config copy as well, so Next's
generated type paths never rewrite the tracked `tsconfig.json`.

## Keeping this file true

Agents and people plan work from this file, so a stale version misroutes every
change that follows it. A commit that adds, renames, or moves a directory
under `src/`, changes a convention, or changes a command above updates this
file in the same commit. `scripts/check-claude-md.sh` (run by
`scripts/test-all.sh`) fails when a tracked directory here is not named in
this file.
