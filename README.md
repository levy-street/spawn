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
   │  PWA    │ WSS │   Postgres + Redis     │ WSS │ workers + PTY   │
   └─────────┘     │                        │     │  ↳ claude/codex │
                   └────────────────────────┘     └─────────────────┘
```

- **server/** — FastAPI control plane. Auth, host/agent registry, content-free
  lifecycle/WebRTC signaling, TURN credentials, and owner fencing.
- **daemon/** — `spawnd` plus `spawn-worker` binaries that run on each remote host.
  Dials *out* to the server (no inbound ports needed). Each purpose-built
  worker owns one agent PTY and encrypted bounded replay.
- **web/** — Next.js 15 PWA. xterm.js terminal, mobile-first composer +
  modifier bar, hosts/agents UI.
- **proto/** — single source of truth for the WS + REST contract shared by all
  three workspaces.
- **infra/** — `docker-compose` for local Postgres + Redis.

Agent provider auth (Anthropic, OpenAI, etc.) is handled by each agent CLI
itself on the host (e.g. `claude /login`); spawn does not manage those
credentials. See `docs/DESIGN.md` for the full architecture, auth model, and
mobile design notes, and `docs/TRUST.md` for the trust architecture and
threat model: the server is being reduced to an operator that negotiates
auth and connections but cannot read terminal content — data flows only
between the host daemon, the browser, and a ciphertext-only TURN relay.

## Local dev (quickstart)

System prerequisites: `docker`, Python 3.13 (`uv` installs interpreters on
demand), Rust stable (via `rustup`), and Bun 1.x. Agent hosts install both
`spawnd` and its paired `spawn-worker` binary.

## Daemon install

From any host that should run agents, use the hosted installer from your spawn
web URL:

```bash
curl -fsSL https://spawn.example.com/install.sh | sh
```

The script installs prerequisites where it can, downloads a prebuilt daemon for
macOS or Linux when available, falls back to building from source, runs the
device-code login flow, then starts a macOS LaunchAgent or Linux user `systemd`
service when available with a background fallback. The hosted script defaults
to `SPAWN_PUBLIC_URL`; override it explicitly when needed:

```bash
curl -fsSL https://spawn.example.com/install.sh | sh -s -- --server https://spawn.example.com
```

For CI or smoke tests that should prove the minimal binary path without a Rust
fallback, add `--prebuilt-only`.

Interactive terminal sessions require direct browser↔daemon WebRTC
DataChannels: `spawn.pty` for bytes and `spawn.ctl` for endpoint replay and
viewport control. Server WebSockets carry only auth, disclosed lifecycle, and
signaling; there is no terminal relay or transcript fallback. Configure STUN/TURN with
`SPAWN_WEBRTC_ICE_SERVERS`; the default is STUN-only. Add TURN credentials for
reliable off-LAN, mobile, and corporate-network direct transport.

```bash
# 0. One-time: copy env template
cp .env.example server/.env

# 1. Bring up Postgres + Redis
docker compose -f infra/docker-compose.yml up -d

# 2. Server (Python 3.13 + uv) — default config picks up server/.env
cd server
uv sync
uv run alembic upgrade head
uv run uvicorn spawn_server.main:app --reload --port 8000 --ws websockets-sansio
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

## Login providers

Email/password auth works by default. To also show Google, Microsoft, or GitHub
sign-in buttons, set the matching `SPAWN_<PROVIDER>_CLIENT_ID` and
`SPAWN_<PROVIDER>_CLIENT_SECRET` values in `server/.env`. The callback path for
each provider is:

```text
${SPAWN_PUBLIC_URL}/api/auth/oauth/<provider>/callback
```

For example, local Google development uses
`http://localhost:8000/api/auth/oauth/google/callback`; production uses
`https://spawnd.dev/api/auth/oauth/google/callback`.

## Testing

Run the repeatable local test matrix from the repo root:

```bash
scripts/test-all.sh
```

That runs server lint/tests, daemon Rust tests, hosted prebuilt-install smoke,
local HTTP-surface smoke, real `spawnd login` smoke, local server+daemon
recovery smoke, real Redis coordination/signaling smoke,
live browser+daemon smoke, service-manager crash-restart smoke, web lint,
Playwright browser tests, web production build, and diff hygiene. The Redis
smoke starts an isolated Redis instance and proves owner fencing and
cross-process signaling using the production backend; Redis carries no PTY
content.
The local daemon smoke also launches multiple shell agents concurrently and verifies
each PTY stream stays isolated. The live browser smoke drives the real Next app
against a disposable FastAPI server and real daemon, creates an agent through
the UI, negotiates the mandatory DataChannels, sends input, verifies output
from the session worker, uploads a file into the agent cwd, and proves a second
browser tab can take terminal control and send input.

To include non-disruptive Linux host coverage over SSH, set a host alias from
your local SSH config:

```bash
SPAWN_REMOTE_LINUX_HOST=dream scripts/test-all.sh
```

That additionally verifies Linux prebuilt install, user `systemd` restart
behavior, and systemd linger enable/restore on the remote host.

To include the public HTTP surface of a staged or production deployment:

```bash
SPAWN_HTTP_SMOKE_URL=https://spawnd.dev scripts/test-all.sh
```

That verifies the landing page, download page, `/healthz`, `/install.sh`, and
the hosted daemon binary for the current machine.

The real reboot persistence check is intentionally gated because it reboots the
remote machine:

```bash
SPAWN_ALLOW_REBOOT=1 SPAWN_REMOTE_REBOOT_HOST=dream scripts/test-all.sh
```

If the remote host needs sudo for reboot, provide `SPAWN_SUDO_PASSWORD` in the
environment for that command.

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
server/web/hosted daemon binary, runs database migrations, and restarts the
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
button. This upload path still transits the server pending P2-TERM-01, then the
daemon saves it into the agent working directory using
sanitized, non-overwriting filenames. Image paste/attachment behavior remains
separate and stores prompt attachments under `<cwd>/.spawn/attachments/`.

## Known limits in this scaffold

- **Single API worker for remaining daemon command/control.** Terminal input,
  output, replay and viewport state are direct DataChannel traffic, while
  uploads and some host-management commands still depend on the worker that
  owns the daemon socket. Keep production on one API worker until those later
  trust tasks move endpoint operations off server routes.
- **No CSRF protection on cookie auth yet.** Add SameSite=Strict cookies +
  CSRF tokens before any non-localhost deployment.
- **shadcn components are hand-rolled** (Tailwind v4 + React 19 ergonomics
  ahead of the official CLI). The API matches shadcn's so swapping later is
  mechanical.
- **PWA icons are placeholders.** Replace `web/public/icon-{192,512}.png`
  before shipping.
- **Offline history is intentionally unavailable.** Replay comes from a live
  endpoint worker; the server stores no terminal transcript. Optional
  client-key-encrypted backup is later work.
- **Agent provider auth is per host.** Each host needs its own
  `claude /login` / `codex login` / etc. There is no central credential
  store; this is a deliberate non-goal for spawn.

## Project status

Pre-alpha scaffold. See `docs/DESIGN.md` for the roadmap.
