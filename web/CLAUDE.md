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
                  device/ docs/ download/ forgot-password/ hosts/ llms.txt/
                  login/ onboarding/ reset-password/ security/ sessions/
                  signup/ tmux-cheatsheet/ verify-email/ w/
                  ([slug]/ renders the SEO page catalogue — see "SEO pages";
                  claude-plan-calculator/ and tmux-cheatsheet/ are its two
                  hand-built tool pages; docs/ renders design documents from
                  ../docs on-site; llms.txt/ serves the AI-crawler summary;
                  hosts/ is the Hosts page and each host's page — a layout
                  with one route per section: Overview, files/, sessions/,
                  access/ — and `/legion` is a redirect to it in
                  next.config.ts)
  components/     UI grouped by product area
                  access/ auth/ brand/ files/ grimoire/ hosts/ icons/ nav/
                  release/ onboarding/ profile/ session/ settings/ terminal/
                  trust/ ui/ workspace/
                  (grimoire/ is the frame and templates of the SEO pages;
                  hosts/ holds the sidebar's Hosts strip, the Hosts page's
                  cards, the shared host connection provider, and cockpit/ —
                  the frame and sections of a host's own page)
  hooks/          React hooks shared across areas (useHostControl, …)
  lib/            framework-free logic: API client, crypto, ceremonies,
                  alerts — with colocated *.test.ts files (lib/files/ is
                  the file browser's pure core: sort, filter, selection,
                  type-ahead, listing sources, and transfers — the engine,
                  the hub that hands jobs between tabs, the zip writer,
                  download sinks; components/files/FileBrowser draws it in
                  its page, pane and aside layouts; lib/move/ is moving a
                  Claude Code window to another host with its
                  conversation — the carrier's wire and pump, the
                  orchestrator and its failure matrix, the resolver for an
                  unfinished move, the hub that runs a move in the tab
                  holding the connection, the dialog's checks, the screen
                  classifier and the move's copy, tested against fakes in
                  lib/move/fakes.ts)
  middleware.ts   request middleware (+ its test beside it)
tests/e2e/        Playwright end-to-end specs
scripts/          build wrappers (next-with-proxy-target.mjs) and helpers
                  (og-shots.mjs renders SEO pages' OG images from a dev server;
                  measure-session-opening.mjs records first/repeat terminal
                  navigation timings in the isolated live browser smoke)
public/           static assets (og/ holds the per-page OG images; sw.js is
                  the service worker — the offline shell, notification
                  clicks, and the streamed-download route)
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

- The fleet is "Hosts" — the page, the sidebar strip, the code that draws
  them (`components/hosts/`, `lib/fleet.ts`). "Legion" was its old name and
  survives only where something outside the frontend still uses it: the
  `/legion` redirect, the server's `legion_days` table, and the
  `spawn.sidebar.legionOpen` storage key. `scripts/check-product-vocabulary.sh`
  enforces this across `src/` here and in `mobile/`.
- A window is opened in one place: `createWindow` in
  `components/workspace/create-window.ts`. Every "+" — the menus, the
  launcher, a duplicate, a template, "New window here…" on a host's page —
  calls it to create the session, record its agent and conversation, and
  queue the agent's launch, so whatever has to be settled with a host before
  a window starts is settled once. A list of skills is granted as given,
  empty included (a duplicate carries exactly its source's, through
  `duplicateWindow`); only an omitted list means the account's defaults.
  Widgets (the file explorer pane) are layout, not windows, and are placed
  by their surface.
- A host's page grows by capability, never by OS: anything beyond Overview,
  Files, Sessions and Access — a Desktop tab, or a section of Overview for
  its conversations, its unfinished moves, Claude accounts or boxes — is a
  slot in `lib/host-offers.ts`, keyed by one versioned capability family the
  host advertises on this device's own connection, and lit only once this
  build ships its view. The phone keeps the same slots, with the same ids
  and labels, on the same families. The first to ship is Unfinished moves
  (`moves`, `conv.v2`, `components/hosts/cockpit/unfinished-moves.tsx`);
  `conversations` stays reserved for the list of a host's conversations.
- Polling idles when nothing is pending. A `refetchInterval` under ten seconds
  is for a state a person is waiting on right now — a live ceremony, a blocked
  session — and gives way to the idle cadence the moment that state clears
  (`lib/approve-ceremony.ts`, `components/access/session-approval-gate.tsx`).
  Every signed-in tab runs these hooks for as long as it is open; at an
  always-fast cadence they were most of the server's request volume
  (2026-09-22). Prefer a `refetchInterval` function or a ref read at
  schedule time over remounting the query.
- A host path never goes into a URL — not a `?path=`, not a fragment. A URL
  reaches the server's request logs, every prefetch and RSC request, the
  browser's history and the next site's Referer, and a host path is protected
  content (`docs/TRUST.md`). To open a host's Files at a folder, call
  `useOpenHostFolder()` (`components/files/`), which hands the folder over in
  memory; the Files page keeps the folder on screen in the tab's
  `history.state` (`lib/files/folder-handoff.ts`). An inbound `?path=` (a
  phone's universal link) is still read once and dropped from the address.
- Uploads, downloads and sends between hosts are jobs in the Transfers tray
  (`components/files/transfers-provider.tsx` over `lib/files/transfer-engine.ts`),
  never work a view does itself: they outlive the folder and the page they
  were started from, and each host is reached through a transfer consumer of
  its own. An upload or a send runs in the tab that holds the host's
  connection (`lib/files/transfer-hub.ts`); a download runs where it is saved,
  and its save target is chosen in the click itself (a save picker needs the
  gesture). `public/sw.js` matches its stream route before anything else and
  never caches it, and a new version of it waits to take over while the one in
  control is still answering a streamed download (the stream lives only in
  that worker's memory).
- Moving a window to another host with its conversation is a job too, never
  work a view does itself: `MovesProvider` (`components/workspace/`) runs it
  through the hub in `lib/move/move-hub.ts`, in the tab that holds the
  target's connection, over consumer channels of its own, and the tab that
  asked queues what is typed after it (`move-launch.ts`). Exactly one tab
  runs a move, queues its relaunch and restarts a window put back: each is a
  Web Lock claim one tab takes for good, never a timeout that lets a second
  tab do it too. Whoever settles a move — the mover, or any device that
  resolves it — leaves the window running its agent: the resume (put back,
  the line from `lib/move/put-back.ts`, mode explicit) is queued with
  `pendingLaunch.claim`, and that device's view of the window takes the
  display to type it (`usePendingLaunchDrain`) rather than waiting for Take
  control; with no view of it (a host's page), the outcome says so and
  offers to open the window. A card saying the window stays "Moving" goes
  once its row stops reading moving (`useDismissWhenResolved`). The
  orchestrator, carrier and resolver in `lib/move/` are framework-free and
  tested against `lib/move/fakes.ts`; once the target has
  committed, a move only finishes, and a refusal from the server is read
  again rather than believed (`lib/move/server.ts`). Every string a move says
  is in `lib/move/copy.ts`, which the phone mirrors string for string
  (`lib/move/copy.test.ts` and the phone's `move-copy.test.ts` pin the same
  names to the same sentences), and none is a daemon or server code. A note
  is typed into Claude Code only when the shared screen table
  (`lib/move/screen.ts`, pinned by `proto/claude-screen-vectors.json`) reads
  its ready prompt; no dialog is ever answered with a key. A v2 chunk's bytes are encoded and read only in
  `lib/hostControl.ts` (`sendChunkV2`, `handleStreamV2`), which
  `scripts/check-no-server-agent-upload.sh` pins.
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
