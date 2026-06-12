# spawn-web

Next.js 15 + React 19 PWA frontend for `spawn`.

## Stack

- Next.js 15 (App Router) + React 19
- Tailwind CSS v4 (single `@import "tailwindcss";` entry; PostCSS plugin)
- shadcn-style components (hand-written here against Radix primitives, not the
  CLI, because the official shadcn CLI was not yet stable for Tailwind v4 +
  React 19 at scaffold time)
- TanStack Query v5
- xterm.js v5 (`@xterm/xterm` + fit/web-links/clipboard addons)
- Native `WebSocket` (no socket.io)
- zod for runtime validation of REST responses
- vaul (available; not yet wired into a screen — Drawer can be added when a
  screen needs it)
- lucide-react icons
- Biome for lint + format
- Bun as package manager

## Scripts

```sh
bun install
bun dev          # next dev
bun run build    # next build with a stable API proxy target
bun run start    # next start with the same API proxy target default
bun run start:spawn # next start on 0.0.0.0:3001 for the local spawn pane
bun run lint     # biome check .
```

## Env vars

See repo root `.env.example`:

- `SPAWN_API_PROXY_TARGET` — server-side proxy target for Next rewrites.
  Production rewrites are captured during `next build`, so this must be set
  before invoking `next` directly. The package `build`/`start` scripts default
  it to `http://127.0.0.1:8001`, matching the local production panes.
- `NEXT_PUBLIC_SPAWN_API_URL` — optional browser REST base URL. Leave unset for
  same-origin `/api/*` through Next's proxy.
- `NEXT_PUBLIC_SPAWN_WS_URL` — optional browser WebSocket base URL. Leave unset
  for same-origin `/ws/*` through Next's proxy.
- `SPAWN_WEBRTC_ENABLED` / `SPAWN_WEBRTC_ICE_SERVERS` — server-side controls for
  direct daemon DataChannel terminal streams. STUN-only is best-effort; add TURN
  credentials for reliable off-LAN/mobile use.

## Structure

- `src/app/` — App Router pages (login/signup/device + protected app shell).
- `src/components/terminal/` — xterm.js + WS/WebRTC hook + composer + modifier bar.
- `src/components/nav/` — `AppShell` (responsive: side rail desktop, top+tab
  bar mobile) and `BottomTabs`.
- `src/components/ui/` — shadcn-style primitives (Button, Input, Card, ...).
- `src/lib/api.ts` — typed REST helpers (zod-validated) matching `proto/README.md`.
- `src/lib/ws.ts` — WS URL builder + JSON inbound parser + base64 helpers.
- `src/lib/auth.ts` — `useAuth()` hook over `/api/me` (cookie session).
- `src/lib/viewport.ts` — keyboard-aware CSS variables (`--vv-height`, `--vv-keyboard`).
- `public/manifest.webmanifest`, `public/sw.js` — PWA install + minimal SW.
