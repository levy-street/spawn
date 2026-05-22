# spawn

Centralized control plane for AI coding agents. Spin up `claude code`, `codex`,
`opencode`, `aider`, or any CLI agent on any machine you own (your laptop, a
remote dev box, a GPU host) and drive them all from one browser tab — including
your phone.

## Architecture

```
                   ┌────────────────────────┐
   ┌─────────┐     │                        │     ┌─────────────────┐
   │ Browser │◀───▶│  spawn-server (FastAPI)│◀───▶│ spawnd (OTP)    │
   │  PWA    │ WSS │   Postgres + Redis     │ WSS │ erlexec + PTY   │
   └─────────┘     │                        │     │  ↳ claude/codex │
                   └────────────────────────┘     └─────────────────┘
```

- **server/** — FastAPI control plane. Auth, host/agent registry, WS broker
  between daemons and browsers.
- **daemon/** — `spawnd`, an Erlang/OTP daemon that runs on each remote host.
  Dials *out* to the server (no inbound ports needed). Supervises local agent
  subprocesses directly through PTYs, streams I/O back over WSS, and exposes a
  localhost control socket mirrored by the web Hosts view.
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
demand), Erlang/OTP + `rebar3`, Bun 1.x, and C/C++ build tools for the
`erlexec` PTY port program.

## Daemon install

From any host that should run agents, use the hosted installer from your spawn
web URL:

```bash
curl -fsSL https://spawn.example.com/install.sh | sh
```

The script installs prerequisites where it can, builds the OTP daemon from
source, runs the device-code login flow, then starts a user `systemd` service
when available with a background fallback. The hosted script defaults to
`SPAWN_PUBLIC_URL`; override it explicitly when needed:

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

# 4. Daemon (Erlang/OTP). Default --server is http://localhost:8000.
cd ../daemon
rebar3 release
rebar3 escriptize
_build/default/bin/spawnd login   # follow the printed URL + code; approve in the web app
_build/default/rel/spawnd/bin/spawnd foreground  # foreground; reconnects on disconnect
```

End-to-end smoke test: sign up at http://localhost:3000, run `spawnd login`,
approve the device code on `/device`, see the host appear on `/hosts`, then
spawn a `shell` preset agent and watch xterm.js attach to it.

## Production deploy

Production infrastructure is bootstrapped from the Levy Street Ansible repo:
the `spawnd-prod` host is configured with nginx + certbot, TLS for
`spawnd.dev`, and a reverse proxy to the Next.js web service on
`127.0.0.1:3001`. Keep the FastAPI server private on `127.0.0.1:8001`; the web
service proxies API and websocket traffic to it.

After the production host has a checkout, runtime dependencies, and systemd
services such as `spawn-server` and `spawn-web`, deploy the current branch
with:

```bash
SPAWN_DEPLOY_HOST=spawnd-prod \
SPAWN_DEPLOY_PATH=/opt/spawn \
scripts/deploy-prod.sh
```

The host can be any alias from the caller's `~/.ssh/config`. The deploy script
fetches the same branch from `origin` on the production machine, rebuilds the
server/web/hosted daemon artifacts, runs database migrations, and restarts the
configured services. It refuses to run when the local checkout has uncommitted
changes or commits that have not been pushed.

Useful overrides:

```bash
SPAWN_DEPLOY_SERVICES="spawn-server spawn-web" scripts/deploy-prod.sh spawnd-prod
SPAWN_DEPLOY_BUILD=0 scripts/deploy-prod.sh spawnd-prod
SPAWN_DEPLOY_SUDO="" scripts/deploy-prod.sh spawnd-prod
```

## Agent sidebar

The desktop sidebar keeps active workflows reachable while leaving terminal
space clear:

- Agents are grouped with pinned agents first, then sorted by most recent user
  input so noisy long-running agents do not constantly jump to the top.
- Hover an agent row, or long-press on touch, to show quick actions just over
  the content pane: rename, pin/unpin, restart, archive, and delete.
- A compact divider separates pinned agents from the rest of the recent list.

## Agent file uploads

The agent terminal pane accepts local files through drag and drop or the upload
button. Files are streamed through the browser websocket to the daemon for that
agent's host and saved directly into the agent working directory using
sanitized, non-overwriting filenames. Image paste/attachment behavior remains
separate and stores prompt attachments under `<cwd>/.spawn/attachments/`.

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
