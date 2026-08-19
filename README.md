# spawn

Run shell sessions on machines you own and use them from one browser tab,
including your phone. After a guided onboarding flow, the signed-in product is
a single workspace page: a sidebar tree of workspaces and sessions beside a
packed grid of live terminals.

The product vocabulary is deliberately small:

- A **session** is a shell PTY on a host. It starts the host user's login shell
  in a chosen directory.
- An **agent** is a launchable CLI definition—name, kind, command, environment
  prefix, and optional install command. Agent buttons are shortcuts that type
  visible commands into a session; an agent is not a process record.
- A **workspace** is a named grid of session tiles.
- A **host** is a paired machine running `spawnd`.

## Architecture

```
                   ┌────────────────────────┐
   ┌─────────┐     │                        │     ┌────────────────────┐
   │ Browser │◀───▶│  spawn-server (FastAPI)│◀───▶│ spawnd (Rust)      │
   │  PWA    │ WSS │   Postgres + Redis     │ WSS │ workers + shell PTY│
   └─────────┘     │                        │     └────────────────────┘
                   └────────────────────────┘
```

- **web/** — Next.js 15 PWA: onboarding, workspace/sidebar/settings UI,
  xterm.js terminals, and the browser side of WebRTC and host control.
- **server/** — FastAPI control plane: accounts, host/session/workspace/agent
  registries, lifecycle coordination, disclosed activity, WebRTC signaling,
  TURN credentials, and owner fencing.
- **daemon/** — `spawnd` and `spawn-worker`. A host dials out to the server, so
  it needs no inbound port. Each worker owns one shell session's PTY and
  encrypted bounded replay and survives a `spawnd` restart.
- **proto/** — wire contracts and cross-runtime vectors shared by the server,
  daemon, and web, plus grid fixtures shared by the server and web.
- **infra/** — local Postgres/Redis Compose services and deployment-facing
  nginx examples.

Terminal bytes, replay, viewport control, and session file transfers use
authenticated browser↔daemon WebRTC DataChannels. Server WebSockets carry
control, disclosed lifecycle/activity, and signaling rather than terminal
content. A TURN relay may carry the WebRTC ciphertext but cannot decrypt it.
Agent-provider authentication remains local to each CLI on each host; spawn
does not store Anthropic, OpenAI, or other provider credentials.

See [RELEASE_NOTES_OVERHAUL.md](docs/RELEASE_NOTES_OVERHAUL.md) for the UI
overhaul upgrade, [INTERFACE_MATRIX.md](docs/INTERFACE_MATRIX.md) and
[proto/README.md](proto/README.md) for interfaces, [DESIGN.md](docs/DESIGN.md)
for UI standards, [SESSIOND.md](docs/SESSIOND.md) for the worker model, and
[TRUST.md](docs/TRUST.md) for the trust architecture.

## Local development

The quickstart expects Docker, Python 3.13 with `uv`, Rust stable, Node
22.19.x, Bun 1.3.14+, `curl`, `lsof`, PostgreSQL client tools, and Redis client
tools.

From the repository root:

```bash
docker compose -f infra/docker-compose.yml up -d
npm run dev
```

Compose creates the local `spawn` database. `npm run dev` verifies Postgres and
Redis, syncs dependencies, applies Alembic migrations, builds both Rust
binaries, and starts the reloadable web app on port 3000 and private API on
port 8010. It also starts the isolated local daemon when that development
config is already paired; otherwise it prints the exact pairing command to run
in another terminal. Rust source changes rebuild and restart `spawnd` while
existing session workers remain alive.

The command refuses to take over occupied ports and stops only the process
groups it started when you press Ctrl-C.

### Manual startup

Use this when you want to run the three workspaces separately:

```bash
# One time
cp .env.example server/.env
docker compose -f infra/docker-compose.yml up -d
```

For the browser-facing single origin, set these values in `server/.env`:

```dotenv
SPAWN_PUBLIC_URL=http://localhost:3000
SPAWN_WEB_URL=http://localhost:3000
SPAWN_CORS_ORIGINS=http://localhost:3000
```

Then run each process in its own terminal:

```bash
# API: http://localhost:8000
cd server
uv sync
uv run alembic upgrade head
uv run uvicorn spawn_server.main:app --reload --port 8000 --ws websockets-sansio
```

```bash
# Web: http://localhost:3000; development proxy target defaults to :8000
cd web
bun install
bun run dev
```

```bash
# Daemon: pair once, then run in the foreground
cd daemon
cargo run --bin spawnd -- --server http://localhost:3000 login
cargo run --bin spawnd -- --server http://localhost:3000 run
```

Sign up in the browser, complete or skip the host step in onboarding, approve
the device code at `/device`, and create a workspace session by choosing its
host and directory. The session starts a login shell; use an agent shortcut in
the terminal when you want to launch a configured CLI.

## Installing a daemon

On any macOS or Linux host that should run sessions, use the installer served
by your spawn deployment:

```bash
curl -fsSL https://spawn.example.com/install.sh | sh
```

The script installs prerequisites where it can, downloads both prebuilt daemon
binaries when available, falls back to building from source, runs the
device-code login flow, and installs a macOS LaunchAgent or Linux user
`systemd` service when available. The hosted script defaults to
`SPAWN_PUBLIC_URL`; override it explicitly when needed:

```bash
curl -fsSL https://spawn.example.com/install.sh | sh -s -- --server https://spawn.example.com
```

Use `--prebuilt-only` in CI or smoke tests that must reject the source-build
fallback. Configure STUN/TURN with `SPAWN_WEBRTC_ICE_SERVERS`; the default is
STUN-only, while TURN is important for off-LAN, mobile, and restrictive
corporate networks.

## Login providers

Email/password authentication works by default. To add Google, Microsoft, or
GitHub, set the matching `SPAWN_<PROVIDER>_CLIENT_ID` and
`SPAWN_<PROVIDER>_CLIENT_SECRET` values in `server/.env`. Register this callback
on the provider:

```text
${SPAWN_PUBLIC_URL}/api/auth/oauth/<provider>/callback
```

For the manual local setup above, the Google callback is
`http://localhost:3000/api/auth/oauth/google/callback`.

## Testing

Run the repository's repeatable test matrix from the root:

```bash
scripts/test-all.sh
```

It runs server lint/tests, source guards, Rust tests, installer and service
smokes, local HTTP/login/daemon/browser smokes, real Redis coordination,
Playwright tests, web lint/unit tests, and the production build. Some optional
checks are enabled by environment variables:

```bash
SPAWN_REMOTE_LINUX_HOST=<ssh-host> scripts/test-all.sh
SPAWN_HTTP_SMOKE_URL=https://spawnd.dev scripts/test-all.sh
SPAWN_ALLOW_REBOOT=1 SPAWN_REMOTE_REBOOT_HOST=<ssh-host> scripts/test-all.sh
```

The reboot check is deliberately gated because it reboots the remote machine.
If that host requires sudo, provide `SPAWN_SUDO_PASSWORD` for the check.

## Production deployment

The supported deployment shape is TLS termination in front of the Next.js
service on `127.0.0.1:3001`, with FastAPI private on `127.0.0.1:8001`. Next.js
proxies `/api`, `/ws`, `/healthz`, and `/install.sh`, so only the web origin
needs to be public.

After provisioning the host and its `spawn-server` and `spawn-web` services:

```bash
SPAWN_DEPLOY_HOST=spawnd-prod \
SPAWN_DEPLOY_PATH=/opt/spawn \
scripts/deploy-prod.sh
```

The deploy script fetches the current branch on the production machine,
syncs/builds the server, web app, and hosted daemon binaries, applies database
migrations, and restarts the configured services. Useful overrides are:

```bash
SPAWN_DEPLOY_SERVICES="spawn-server spawn-web" scripts/deploy-prod.sh spawnd-prod
SPAWN_DEPLOY_BUILD=0 scripts/deploy-prod.sh spawnd-prod
SPAWN_DEPLOY_SUDO="" scripts/deploy-prod.sh spawnd-prod
```

For the overhaul rollout order and daemon protocol break, follow
[RELEASE_NOTES_OVERHAUL.md](docs/RELEASE_NOTES_OVERHAUL.md).

## Session file transfers

The terminal can upload local files through the picker or drag and drop. The
browser hashes and streams bounded chunks directly to the endpoint over the
locked `spawn.ctl` v1 DataChannel protocol. Names, bytes, final paths, and
detailed errors do not transit the application server. The daemon commits
files beneath the session working directory without overwriting an existing
destination. Image paste attachments remain separate and use
`<cwd>/.spawn/attachments/`.

## Known limits

- Cookie authentication uses `SameSite=Lax` but has no separate CSRF token.
  Add explicit CSRF protection before exposing a deployment to untrusted web
  origins.
- Offline terminal history is intentionally unavailable. Replay belongs to a
  live session worker; the server stores no transcript.
- Agent-provider authentication is per host. Each host needs its own CLI login
  such as `claude /login` or `codex login`.

## Project status

Pre-alpha, with the workspace/session/agent overhaul implemented. The shipped
design record remains in [OVERHAUL.md](docs/OVERHAUL.md).
