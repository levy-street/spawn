# spawn — design

## Goals

- Spin up arbitrary CLI agents (claude code, codex, opencode, aider, ...) on
  any machine you own, from a single web app.
- No inbound ports on remote hosts. Daemons dial out.
- Multi-tenant from day one (sign up + scoped agents).
- Per-host agent auth: each agent CLI handles its own provider login
  interactively on the host where it runs. spawn does not manage credentials.
- First-class mobile UX, including PWA installable.

## Components

### `spawn-server` — Python / FastAPI

- **Stack**: Python 3.13, FastAPI, SQLAlchemy 2.0 + Alembic, asyncpg,
  Pydantic v2, argon2 for password hashing, PyJWT for short-lived tokens,
  redis-py for pubsub.
- **State**: Postgres for durable state (users, hosts, agents, presets,
  audit). Redis for pub/sub between WS workers (so a frontend connected to
  worker A can receive PTY bytes from a daemon connected to worker B).
- **Public surface**:
  - HTTP/JSON REST under `/api/...`
  - `/ws/daemon` — daemon WebSocket
  - `/ws/browser` — browser WebSocket (per-agent attach)
- **Bridge logic**: server holds a routing map `agent_id -> daemon_conn` and
  `agent_id -> {browser_conn, ...}`. PTY output frames from a daemon fan out
  to subscribed browsers; PTY input from a browser routes to the owning
  daemon. Server also keeps a Redis ring buffer of the last 256 KB of PTY
  output per agent for replay on reconnect.

### `spawnd` — Rust

- **Stack**: tokio, tokio-tungstenite, clap, serde / serde_json, anyhow,
  portable-pty, keyring (with file fallback in `~/.config/spawn/`).
- **CLI**:
  - `spawnd login` — interactive device-code flow against the server. Stores
    a long-lived daemon token in OS keyring.
  - `spawnd run` — foreground; connects WSS, registers, services frames.
  - `spawnd logout` — wipes stored token.
  - `spawnd status` — prints connection / agent state.
- **Process model**: each agent runs inside its own detached `tmux` session
  (`spawn-<uuid>`), so an agent survives `spawnd` crashes/restarts. The
  daemon attaches a PTY to the tmux pane to stream I/O.
- **Agent environment**: the daemon launches the agent under the host user's
  process env (HOME, XDG_CONFIG_HOME, PATH, etc. flow through naturally),
  overlaid with the `env` from `agent.create`. spawn does not manage agent
  credentials; each agent CLI handles its own login on the host.
- **Reconnect**: on WS disconnect, daemon retries with exponential backoff.
  On reconnect, sends a `register` frame with `existing_agents: [...]` so the
  server resyncs its routing map without killing the tmux sessions.

### `spawn-web` — Next.js 15 PWA

- **Stack**: Next.js 15 App Router, React 19, Tailwind v4, shadcn/ui, Biome,
  Bun. xterm.js + `@xterm/addon-fit` + `@xterm/addon-web-links`. TanStack
  Query for REST. Native WebSocket for streaming.
- **Pages**:
  - `/` — dashboard (active agents, recent activity).
  - `/login`, `/signup`, `/device` (device-code approval).
  - `/hosts` — list of registered daemons with status, last-seen, kill/rename.
  - `/agents` — grid + detail. New-agent modal: pick host, pick preset,
    optional cwd / argv override.
  - `/agents/[id]` — full terminal view + composer + modifier bar.
  - `/settings` — account, daemons, danger zone.
- **Mobile**:
  - Composer pattern: textarea above terminal with Send button. Toggle to raw
    mode for power users.
  - On-screen modifier bar (`Esc`, `Tab`, `Ctrl-C`, `↑`, `↓`, `↩`) sticky
    above the keyboard via `visualViewport`.
  - Container queries (Tailwind v4) for agent panes.
  - PWA manifest + service worker for installability and offline shell.
  - `viewport-fit=cover` and safe-area-insets honored.

## Auth model

- **Web users**: email + argon2id password. Sessions are JWTs in HTTP-only
  cookies, 30-day refresh / 15-min access.
- **Daemons**: device-code flow.
  1. Daemon `POST /api/auth/device/start` → `{device_code, user_code,
     verification_uri, interval, expires_in}`.
  2. Daemon prints `Open https://spawn.dev/device and enter code QZ4K-7HMT`.
  3. Daemon polls `POST /api/auth/device/poll {device_code}` until success.
  4. Browser (logged-in user) opens `/device`, enters `user_code`, hits
     `POST /api/auth/device/approve {user_code}` → server marks the device
     code authorized for that user.
  5. Next poll returns `{access_token: <daemon_token>, host_id}`. Daemon
     stores token in keyring.
- Daemon tokens are scoped: `host:<host_id>:control`. Revocable from the web
  UI (kills the WS).

## Multi-tenancy

- Single `users` table to start. (Orgs/teams are a follow-up; design now so
  every record carries `owner_user_id`.)
- All REST endpoints require auth and filter by `owner_user_id`.
- The server enforces that a daemon's `host_id` belongs to the daemon
  token's user, and an agent's `host_id` belongs to the same user as the
  spawn request.

## Data model

```sql
users(id, email, password_hash, created_at)
hosts(id, owner_user_id, name, os, arch, version, status, last_seen_at)
presets(id, owner_user_id|null, name, agent_kind, default_argv jsonb,
        env_template jsonb)
  -- owner_user_id null = built-in preset visible to all users
agents(id, owner_user_id, host_id, preset_id|null, cwd, argv jsonb, env jsonb,
       status, started_at, exited_at, exit_code)
device_codes(device_code, user_code, host_name, status, user_id|null,
             expires_at)
```

## Wire protocol (summary — see `proto/README.md` for full)

- Daemon `/ws/daemon`:
  - Out: `register`, `host.heartbeat`, `agent.exit`; binary `0x01 <uuid> <bytes>`
    for PTY output.
  - In:  `agent.create`, `agent.kill`, `agent.resize`; binary `0x02 <uuid>
    <bytes>` for PTY input.
- Browser `/ws/browser?agent_id=...`:
  - Out: text `{type:"resize",cols,rows}`; binary stdin bytes.
  - In:  text `{type:"history",bytes_b64}`, `{type:"agent.exit",code}`;
    binary stdout bytes.

## Roadmap

1. **Skeleton** — three workspaces wired up; `docker compose up`,
   `uvicorn`, `cargo run`, `bun dev` all green; auth + daemon registration
   end-to-end. *(this scaffold)*
2. **Spawn one agent** — agent.create → tmux/PTY in daemon → xterm.js in
   browser. Resize, reconnect, replay.
3. **Mobile polish** — composer, modifier bar, PWA install, container queries.
4. **Multi-agent UX** — grid, swipe-between, kill/restart, transcripts.
5. **Hardening** — audit log, daemon auto-update, rate limiting, observability.
