# spawn

Centralized control plane for AI coding agents. Spin up `claude code`, `codex`,
`opencode`, `aider`, or any CLI agent on any machine you own (your laptop, a
remote dev box, a GPU host) and drive them all from one browser tab — including
your phone.

## Architecture

```
                   ┌────────────────────────┐
   ┌─────────┐     │                        │     ┌─────────────────┐
   │ Browser │◀───▶│  spawn-server (FastAPI)│◀───▶│ spawnd (Rust)   │
   │  PWA    │ WSS │   Postgres + Redis     │ WSS │ tmux + PTY      │
   └─────────┘     │                        │     │  ↳ claude/codex │
                   └────────────────────────┘     └─────────────────┘
```

- **server/** — FastAPI control plane. Auth, host/agent registry, WS broker
  between daemons and browsers.
- **daemon/** — `spawnd`, a single Rust binary that runs on each remote host.
  Dials *out* to the server (no inbound ports needed). Manages local agent
  processes inside `tmux` and streams PTY I/O back over WSS.
- **web/** — Next.js 15 PWA. xterm.js terminal, mobile-first composer +
  modifier bar, hosts/agents UI.
- **proto/** — single source of truth for the WS + REST contract shared by all
  three workspaces.
- **infra/** — `docker-compose` for local Postgres + Redis.

Agent provider auth (Anthropic, OpenAI, etc.) is handled by each agent CLI
itself on the host (e.g. `claude /login`); spawn does not manage those
credentials. See `docs/DESIGN.md` for the full architecture, auth model, and
mobile design notes.

## Local dev (quickstart)

System prerequisites: `docker`, Python 3.13 (`uv` installs interpreters on
demand), Rust stable (via `rustup`), Bun 1.x, and **`tmux`** on every host
that will run `spawnd`.

## Daemon install

From any host that should run agents, use the hosted installer from your spawn
web URL:

```bash
curl -fsSL https://spawn.example.com/install.sh | sh
```

The script installs prerequisites where it can, downloads a prebuilt daemon
when available, falls back to building from source, runs the device-code login
flow, then starts a user `systemd` service when available with a background
fallback. The hosted script defaults to `SPAWN_PUBLIC_URL`; override it
explicitly when needed:

```bash
curl -fsSL https://spawn.example.com/install.sh | sh -s -- --server https://spawn.example.com
```

```bash
# 0. One-time: copy env template
cp .env.example server/.env

# 1. Bring up Postgres + Redis
docker compose -f infra/docker-compose.yml up -d

# 2. Server (Python 3.13 + uv) — default config picks up server/.env
cd server
uv sync
uv run alembic upgrade head
uv run uvicorn spawn_server.main:app --reload --port 8000
# CORS is preconfigured to allow http://localhost:3000

# 3. Web (Bun + Next.js) — sign up here first so the device-code approve flow
#    has someone to bind to
cd ../web
bun install
bun dev    # http://localhost:3000

# 4. Daemon (Rust). Default --server is http://localhost:8000.
cd ../daemon
cargo run -- login   # follow the printed URL + code; approve in the web app
cargo run -- run     # foreground; reconnects on disconnect
```

End-to-end smoke test: sign up at http://localhost:3000, run `spawnd login`,
approve the device code on `/device`, see the host appear on `/hosts`, then
spawn a `shell` preset agent and watch xterm.js attach to it.

## Agent sidebar

The desktop sidebar keeps active workflows reachable while leaving terminal
space clear:

- Agents are grouped with pinned agents first, then sorted by most recent user
  input so noisy long-running agents do not constantly jump to the top.
- Hover an agent row, or long-press on touch, to show quick actions just over
  the content pane: rename, pin/unpin, restart, archive, and delete.
- A compact divider separates pinned agents from the rest of the recent list.

## Known limits in this scaffold

- **Single uvicorn worker only.** Cross-worker live PTY fan-out via Redis
  pubsub is published by the daemon WS but not yet subscribed in the
  browser WS — the wiring is in place but the consumer task is a follow-up.
  History replay still works cross-worker.
- **No CSRF protection on cookie auth yet.** Add SameSite=Strict cookies +
  CSRF tokens before any non-localhost deployment.
- **shadcn components are hand-rolled** (Tailwind v4 + React 19 ergonomics
  ahead of the official CLI). The API matches shadcn's so swapping later is
  mechanical.
- **PWA icons are placeholders.** Replace `web/public/icon-{192,512}.png`
  before shipping.
- **No agent transcripts persisted** beyond the 256 KB ring buffer.
- **Agent provider auth is per host.** Each host needs its own
  `claude /login` / `codex login` / etc. There is no central credential
  store; this is a deliberate non-goal for spawn.

## Project status

Pre-alpha scaffold. See `docs/DESIGN.md` for the roadmap.
