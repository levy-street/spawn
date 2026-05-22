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
demand), Erlang/OTP 27+ + `rebar3`, Bun 1.x, and C/C++ build tools for the
`erlexec` PTY port program.

## Daemon install

From any host that should run agents, use the hosted installer from your spawn
web URL:

```bash
curl -fsSL https://spawn.example.com/install.sh | sh
```

The script downloads a prebuilt, self-contained OTP release for the host
OS/architecture, runs the device-code login flow, then starts a user `systemd`
service when available with a background fallback. The installer detects
`linux-x86_64`, `linux-arm64`, `darwin-x86_64`, and `darwin-arm64`; Windows
hosts run the Linux daemon inside WSL. The hosted web route serves artifacts
from `SPAWN_DAEMON_ARTIFACT_DIR` or `dist/spawnd` when present, and otherwise
can only serve the release built for the web server's own OS/architecture.

Build a prebuilt artifact on a matching host with:

```bash
scripts/package-spawnd.sh
```

The package script emits `spawnd-$target.tar.gz` under `dist/spawnd` by
default. Run it on each OS/architecture you want to publish; Erlang releases
are not cross-compiled by this repo.

The hosted script defaults to `SPAWN_PUBLIC_URL`; override it explicitly when
needed:

```bash
curl -fsSL https://spawn.example.com/install.sh | sh -s -- --server https://spawn.example.com
```

If the hosted prebuilt for a host is unavailable, build on the target host
instead:

```bash
curl -fsSL https://spawn.example.com/install.sh | sh -s -- --build-from-source
```

Source builds require Erlang/OTP 27 or newer because the daemon depends on
current `erlexec` releases. Ubuntu 24.04's default `apt` Erlang package is OTP
25, so use the prebuilt artifact path there or install a newer OTP first.

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

For the already-running local stack, the repeatable smoke script exercises the
installed daemon wrapper, local control socket, REST API, browser websocket,
PTY input/output, duplicate upload handling, restart, host tool policy, and
host tool install paths. It also launches the built-in provider presets against
fake provider binaries so `claude`, `codex`, `opencode`, `aider`, and `shell`
argv wiring are covered without requiring real provider credentials:

```bash
scripts/smoke-local.sh
```

To run the installed provider CLIs through the real daemon-backed agent path
without relying on fake binaries, run:

```bash
scripts/smoke-provider-clis.sh
```

To exercise the real web client in headless Chromium, including the public
landing and install pages, authenticated Hosts status and rename flow, New
Agent form, and an agent terminal render across desktop and mobile terminal
controls, terminal file upload, Agents grid rename/archive actions, plus the
Settings preset manager, run:

```bash
scripts/smoke-web-ui.sh
```

To verify the Redis-backed multi-worker path, including REST/browser traffic
landing on a different FastAPI worker than the daemon websocket and terminal
display ownership moving between browser connections on different workers, run:

```bash
scripts/smoke-cross-worker.sh
```

To verify the production deploy script without touching a real host, run:

```bash
scripts/smoke-deploy-prod.sh
```

To run read-only readiness checks against the real production host before or
after a deploy, run:

```bash
scripts/check-prod-readiness.sh spawnd-prod
```

To verify a fresh `spawnd login` device-code approval, isolated credential
save/status/logout flow, run:

```bash
scripts/smoke-device-login.sh
```

To verify installer platform detection, native Windows rejection, the prebuilt
artifact path for Linux/macOS/WSL-like shells, and the OTP source-build guard
in a local Ubuntu container, run:

```bash
scripts/smoke-install-linux.sh
```

To build real Linux prebuilt daemon artifacts in Docker and prove they install
and run in a minimal Ubuntu runtime without Erlang/rebar3, run:

```bash
scripts/smoke-linux-artifact.sh
SPAWN_LINUX_ARTIFACT_PLATFORMS=linux/amd64 scripts/smoke-linux-artifact.sh
```

To run the full local verification suite in the expected order, use the
orchestrator:

```bash
scripts/smoke-all.sh
```

Heavy Docker artifact and read-only production checks are opt-in:

```bash
SPAWN_SMOKE_ALL_LINUX_ARTIFACTS=1 \
SPAWN_SMOKE_ALL_LINUX_AMD64=1 \
SPAWN_SMOKE_ALL_PROD_HOST=spawnd-prod \
scripts/smoke-all.sh
```

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
server/web/current-host daemon artifact, runs database migrations, and restarts the
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

## Known Limits

- **shadcn components are hand-rolled** (Tailwind v4 + React 19 ergonomics
  ahead of the official CLI). The API matches shadcn's so swapping later is
  mechanical.
- **PWA icons are placeholders.** Replace `web/public/icon-{192,512}.png`
  before shipping.
- **Transcript retention is bounded.** Agent output is persisted to rotated
  transcript files for replay, but old scrollback is dropped once the per-agent
  size limit is reached.
- **Agent provider auth is per host.** Each host needs its own
  `claude /login` / `codex login` / etc. There is no central credential
  store; this is a deliberate non-goal for spawn.

## Project Status

Active prototype with local daemon install, authenticated web UI, direct
subprocess agents, transcript replay, host target checks/installs, and deploy
helpers. See `docs/DESIGN.md` for remaining hardening work.
