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
bun run build    # next build
bun run start    # next start
bun run lint     # biome check .
```

## Env vars

See repo root `.env.example`:

- `NEXT_PUBLIC_SPAWN_API_URL` — REST base URL (default `http://localhost:8000`)
- `NEXT_PUBLIC_SPAWN_WS_URL`  — WebSocket base URL (default `ws://localhost:8000`)

## Structure

- `src/app/` — App Router pages (login/signup/device + protected app shell).
- `src/components/terminal/` — xterm.js + WS hook + composer + modifier bar.
- `src/components/nav/` — `AppShell` (responsive: side rail desktop, top+tab
  bar mobile) and `BottomTabs`.
- `src/components/ui/` — shadcn-style primitives (Button, Input, Card, ...).
- `src/lib/api.ts` — typed REST helpers (zod-validated) matching `proto/README.md`.
- `src/lib/ws.ts` — WS URL builder + JSON inbound parser + base64 helpers.
- `src/lib/auth.ts` — `useAuth()` hook over `/api/me` (cookie session).
- `src/lib/viewport.ts` — keyboard-aware CSS variables (`--vv-height`, `--vv-keyboard`).
- `public/manifest.webmanifest`, `public/sw.js` — PWA install + minimal SW.
