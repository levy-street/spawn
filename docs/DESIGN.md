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
- **State**: Postgres for durable state (users, hosts, agents, presets, host
  tool policies). Redis for WS worker coordination: PTY byte fan-out, browser
  text events, daemon command envelopes, request/response frames, and terminal
  display ownership/geometry. On-disk rotated transcripts provide replay after
  a server restart.
- **Public surface**:
  - HTTP/JSON REST under `/api/...`
  - `/ws/daemon` — daemon WebSocket
  - `/ws/browser` — browser WebSocket (per-agent attach)
- **Bridge logic**: server holds a local routing map `agent_id -> daemon_conn`
  and `agent_id -> {browser_conn, ...}` as a fast path. PTY output frames from
  a daemon are appended to transcript storage and published through Redis;
  browser websockets subscribe to that stream. Browser input, host/agent
  commands, host status/tool requests, snapshot responses, upload acks, agent
  status/exit events, and display-control updates also cross workers through
  Redis channels, so a browser or REST request can land on a different worker
  than the daemon WS.

### `spawnd` — Erlang/OTP

- **Stack**: Erlang/OTP release, `gun` for outbound websockets, `erlexec` for
  direct subprocess and PTY management, and a small escript CLI for login,
  status, logout, local control, and self-test commands.
- **CLI**:
  - `spawnd login` — interactive device-code flow against the server. Stores a
    long-lived daemon token in `~/.config/spawn/credentials.json`.
  - release wrapper `spawnd foreground` / `spawnd daemon` — starts the OTP
    daemon, connects WSS, registers, and services frames.
  - `spawnd logout` — wipes stored token.
  - `spawnd status` — prints configured server/login state.
  - `spawnd agents`, `spawnd kill <id>`, `spawnd update-check`, `spawnd
    self-test` — local control socket commands against the running daemon.
- **Process model**: each agent is an OTP-supervised worker that owns one
  direct OS subprocess attached to a PTY through `erlexec`. There is no tmux
  layer. The registry tracks live workers, restart waits for the old process to
  exit before starting the replacement, and stale unregister/monitor messages
  are ignored so a restarted agent is not removed accidentally.
- **Agent environment**: the daemon launches the agent under the host user's
  process env (HOME, XDG_CONFIG_HOME, PATH, etc. flow through naturally),
  overlaid with the `env` from `agent.create`. spawn does not manage agent
  credentials; each agent CLI handles its own login on the host.
- **Reconnect**: on WS disconnect or heartbeat timeout, daemon reconnects and
  sends a `register` frame with `existing_agents: [...]` so the server resyncs
  its routing map for still-running OTP agent workers.

### `spawn-web` — Next.js 15 PWA

- **Stack**: Next.js 15 App Router, React 19, Tailwind v4, shadcn/ui, Biome,
  Bun. xterm.js + `@xterm/addon-fit` + `@xterm/addon-web-links`. TanStack
  Query for REST. Native WebSocket for streaming.
- **Pages**:
  - `/` — public landing page.
  - `/dash` — dashboard (active agents, recent activity).
  - `/download` — hosted daemon installer instructions.
  - `/login`, `/signup`, `/device` (device-code approval).
  - `/hosts` — list of registered daemons with status, last-seen, kill/rename.
  - `/agents` — grid + detail. New-agent modal: pick host, pick preset,
    optional cwd / argv override.
  - `/agents/[id]` — full terminal view + composer + modifier bar.
  - `/settings` — account, preset management, and danger-zone placeholder.
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
  SameSite=Strict cookies, 30-day refresh / 15-min access. Unsafe
  cookie-authenticated API requests also require the readable `spawn_csrf`
  cookie to be echoed in `X-CSRF-Token`; bearer-token API clients are not
  subject to the browser CSRF check.
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
        env_template jsonb, install)
  -- owner_user_id null = built-in preset visible to all users
agents(id, owner_user_id, host_id, preset_id|null, cwd, argv jsonb, env jsonb,
       status, started_at, exited_at, exit_code, last_output_at, last_input_at,
       pinned_at, archived_at)
host_tool_policies(id, owner_user_id, host_id, preset_id, auto_update,
                   last_checked_at, last_auto_update_at, last_auto_update_error)
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

1. **Core runtime** — server, web app, Erlang/OTP daemon, device login, daemon
   registration, direct PTY agents, transcript replay, and host target checks.
2. **Install/deploy** — hosted installer, prebuilt daemon artifacts, production
   deploy helper, and Redis-backed multi-worker websocket routing.
3. **Mobile polish** — composer, modifier bar, PWA install prompts, and
   container-query refinements.
4. **Multi-agent UX** — grid views, swipe-between flows, richer bulk actions,
   and better long-running-agent affordances.
5. **Hardening** — audit log, daemon auto-update rollout policy, rate limiting,
   observability, and broader provider/OS compatibility testing.
