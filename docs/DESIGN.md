# spawn — design

## Goals

- Spin up arbitrary CLI agents (claude code, codex, opencode, aider, ...) on
  any machine you own, from a single web app.
- No inbound ports on remote hosts. Daemons dial out.
- Multi-tenant from day one (sign up + scoped agents).
- Per-host agent auth: each agent CLI handles its own provider login
  interactively on the host where it runs. spawn does not manage credentials.
- First-class mobile UX, including PWA installable.
- **Operator model**: the server negotiates auth and connections but is
  structurally unable to read terminal content. Data flows only between
  the host daemon, the browser, and (when NAT demands) a TURN relay
  carrying ciphertext. See `TRUST.md` — the governing document for this;
  where the two disagree, TRUST.md describes the target and this file
  the current mechanics.

## Components

### `spawn-server` — Python / FastAPI

- **Stack**: Python 3.13, FastAPI, SQLAlchemy 2.0 + Alembic, asyncpg,
  Pydantic v2, argon2 for password hashing, PyJWT for short-lived tokens,
  redis-py for cross-worker presence, signaling, and owner-fenced control results.
- **State**: Postgres currently holds durable user/host/agent/preset/skill
  records, including protected launch/preset/skill fields that Phase 2 must
  remove. The target Postgres state is disclosed registry/lifecycle metadata
  only. Redis coordinates presence, WebRTC signaling, and owner-fenced
  content-free control results between API workers; it is not a protected-data
  store and never carries terminal content.
- **Public surface**:
  - HTTP/JSON REST under `/api/...`
  - `/ws/daemon` — daemon WebSocket
  - `/ws/browser` — browser WebSocket (per-agent attach)
- **Control and signaling**: the server keeps auth, registry, lifecycle,
  presence, WebRTC signaling, owner fencing, and TURN credential minting.
  `/ws/daemon` is JSON-only `spawn.control.v2`; `/ws/browser` requires
  `spawn.v2`. The server has no terminal input/output, transcript, history,
  snapshot, viewport, or display-owner relay. Terminal data, history and
  viewport operations travel on mandatory `spawn.pty` + `spawn.ctl` direct
  channels. Agent uploads still cross the server, and launch manifests,
  preset environment/install/tool values, and skill bodies still have
  server-readable paths or stores pending P2-TERM-01 and P2-DATA-02. The MCP
  surface (endpoint, managed-server registry, MCP-client OAuth) was
  removed entirely on 2026-07-09 per TRUST.md.

### `spawnd` — Rust

- **Stack**: tokio, tokio-tungstenite, clap, serde / serde_json, anyhow,
  portable-pty, keyring (with file fallback in `~/.config/spawn/`).
- **CLI**:
  - `spawnd login` — interactive device-code flow against the server. Stores
    a long-lived daemon token in OS keyring.
  - `spawnd run` — foreground; connects WSS, registers, services frames.
  - `spawnd logout` — wipes stored token.
  - `spawnd status` — prints connection / agent state.
- **Process model**: each agent runs inside a mandatory per-agent
  `spawn-worker`, which owns its PTY, plaintext current-screen checkpoint grid,
  and encrypted-at-rest resource-budgeted scrollback.
  Workers survive `spawnd` crashes/restarts and are adopted over Unix sockets;
  see `SESSIOND.md` and the cutover ADR in `TMUX_REMOVAL.md`.
- **Agent environment**: the daemon launches the agent under the host user's
  process env (HOME, XDG_CONFIG_HOME, PATH, etc. flow through naturally),
  overlaid with the `env` from `agent.create`. spawn does not manage agent
  credentials; each agent CLI handles its own login on the host.
- **Reconnect**: on WS disconnect, daemon retries with exponential backoff.
  On reconnect, sends a `register` frame with `existing_agents: [...]` so the
  server resyncs its routing map without killing session workers.
- **Agent terminal data ownership (P2-AGENT-02 checkpoint)**: the live worker is the source
  of resource-budgeted replay, using encrypted-at-rest rolling segments and an
  ephemeral key. The conservative total charge covers ciphertext/framing,
  replay/scratch, and retained bookkeeping; this is not a durable transcript
  archive. Browsers fetch history over
  the DataChannel at attach. The server keeps no copy.
- **Durable protected state (approved target, not implemented)**: `spawnd`
  owns one independently keyed, endpoint-local canonical store for launch and
  restart manifests, preset/tool operational values, and skill bodies. It is
  available after daemon restart and exposed only over `spawn.host.ctl`.
  `DURABLE_SENSITIVE_DATA.md` defines its envelope, recovery, conflicts,
  quotas, migration, and accepted offline/cross-host regressions.

### `spawn-web` — Next.js 15 PWA

- **Stack**: Next.js 15 App Router, React 19, Tailwind v4, shadcn/ui, Biome,
  Bun. xterm.js + `@xterm/addon-fit` + `@xterm/addon-web-links`. TanStack
  Query for REST. Native WebSocket for content-free signaling and lifecycle.
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

The SQL below is the current server-readable shape, not the Phase 2 target:

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

After P2-DATA-02, Postgres retains the IDs/ownership, names/descriptions,
grants, policy/lifecycle fields, and neutral/explicit labels allowed by
`TRUST.md`, but not `cwd`, `argv`, `env`, preset default/install/environment
values, tool executable targets, or skill bodies. Those values are versioned
AEAD objects in the per-host store selected by
`DURABLE_SENSITIVE_DATA.md`. Built-in operational preset values move to a
versioned daemon-local catalog; their IDs/names/kinds may remain disclosed.

This split is intentionally non-atomic across the server metadata plane and
endpoint content plane. The browser binds both by stable ID, while protected
writes use exact endpoint revisions. Missing/offline endpoint values fail
closed; the server never fills the gap from a cache.

## Wire protocol (summary — see `proto/README.md` for full)

- Daemon `/ws/daemon`:
  - Subprotocol `spawn.control.v2`, JSON only.
  - Out: `register`, `host.heartbeat`, content-free `agent.activity` /
    `agent.input_activity`, lifecycle, and bound `rtc.*` signaling.
  - In: `agent.create`, `agent.kill`, upload/control operations still awaiting
    later trust tasks, and bound `rtc.*` signaling.
- Browser `/ws/browser?agent_id=...`:
  - Mandatory subprotocol `spawn.v2`; text-only auth, disclosed lifecycle,
    uploads pending migration, TURN config, and bound `rtc.*` signaling.
  - Binary frames and terminal viewport/history commands fail closed.
- Terminal data plane: mandatory WebRTC DataChannels `spawn.pty` (bytes) and
  `spawn.ctl` (history/snapshot/viewport/display ownership), negotiated via
  the content-free WS signaling plane. TURN is an encrypted reachability
  fallback, not a server terminal-content fallback.

## Roadmap

Phases 1–4 of the original scaffold roadmap (skeleton, first agent,
mobile polish, multi-agent UX) have shipped. The roadmap is now the
operator-model migration, specified in `TRUST.md`:

1. **TURN + WebRTC-only terminal path** — source implementation under review:
   coturn with ephemeral server-minted credentials; WS PTY relay deleted;
   `spawn.v2`.
2. **Endpoint-owned data** — history and snapshots now use agent
   DataChannels, and server transcripts plus the Redis PTY ring are deleted.
   Upload, fs-listing/transfer, launch-manifest, preset, tool-target, and skill
   migrations remain tracked Phase 2 work; the server still sees those values
   until their individual cutovers land. (The
   `/mcp` visibility question is resolved: the MCP surface was cut
   entirely on 2026-07-09.)
3. **Endpoint identity** — Ed25519 host keys + WebCrypto browser device
   keys bound via the device-code flow; signed SDP; TOFU pinning with
   fingerprint verification UX.
4. **Open source** — license, history secret-scan, SECURITY.md,
   reproducible builds, self-host guide; spawnd.dev becomes the hosted
   convenience instance.

Ongoing hardening (audit log, daemon auto-update, rate limiting,
observability) continues alongside.
