# spawn wire protocol

This is the contract between `spawn-server`, `spawnd`, and the browser PWA.
All three implementations MUST match.

## Identifiers

- All IDs are UUIDv4 strings in JSON, raw 16-byte big-endian in binary frames.
- Timestamps are RFC 3339 strings.

## REST API (`/api/...`)

JSON in / JSON out. `Content-Type: application/json`. Auth via
`Authorization: Bearer <token>` (web users use HTTP-only cookies; the server
also accepts `Bearer` for API testing).

### Auth

| Method | Path                       | Body                                | Response                                                                                                          |
|--------|----------------------------|-------------------------------------|-------------------------------------------------------------------------------------------------------------------|
| POST   | `/api/auth/signup`         | `{email, password}`                 | `{access_token, user}`                                                                                            |
| POST   | `/api/auth/login`          | `{email, password}`                 | `{access_token, user}`                                                                                            |
| POST   | `/api/auth/logout`         | —                                   | 204                                                                                                               |
| GET    | `/api/me`                  | —                                   | `{user}`                                                                                                          |
| POST   | `/api/auth/device/start`   | `{host_name, os, arch, version}`    | `{device_code, user_code, verification_uri, interval, expires_in}`                                                |
| POST   | `/api/auth/device/poll`    | `{device_code}`                     | `{access_token, host_id}` on success; `{error: "authorization_pending"\|"slow_down"\|"expired_token"\|"denied"}` |
| POST   | `/api/auth/device/approve` | `{user_code}`                       | `{host_name}` (authenticated as a web user)                                                                       |

### Hosts

| Method | Path                  | Notes                                    |
|--------|-----------------------|------------------------------------------|
| GET    | `/api/hosts`          | list current user's hosts                |
| GET    | `/api/hosts/{id}`     | one host                                 |
| GET    | `/api/hosts/{id}/dirs`| list host directories, optional `?path=` |
| GET    | `/api/hosts/{id}/tools` | check preset executable targets on the connected host daemon |
| POST   | `/api/hosts/{id}/tools/{preset_id}/install` | run that preset's install command on the connected host daemon |
| PATCH  | `/api/hosts/{id}/tools/{preset_id}/policy` | update per-target policy: `{auto_update?}` |
| PATCH  | `/api/hosts/{id}`     | rename: `{name}`                         |
| DELETE | `/api/hosts/{id}`     | revoke daemon token + drop the host      |

Host shape:
```json
{
  "id": "uuid",
  "name": "gpu-box-1",
  "os": "linux",
  "arch": "x86_64",
  "version": "0.1.0",
  "status": "online" | "offline",
  "last_seen_at": "2026-05-04T...",
  "agent_count": 2,
  "home_dir": "/home/me|null"
}
```

### Agents

| Method | Path                 | Body                                                                              |
|--------|----------------------|-----------------------------------------------------------------------------------|
| GET    | `/api/agents`        | list current user's unarchived agents (optional `?host_id=...`, `?include_archived=true`) |
| GET    | `/api/agents/{id}`   |                                                                                   |
| POST   | `/api/agents`        | `{name?, host_id, preset_id?, cwd, argv?, env?, skill_ids?, create_cwd?}` — at least one of preset_id or argv |
| PATCH  | `/api/agents/{id}`   | rename/pin/archive: `{name?, pinned?, archived?}`                                 |
| POST   | `/api/agents/{id}/restart` | restart the existing agent with its saved cwd/argv/env; optional `{cols, rows, create_cwd?}` |
| GET    | `/api/agents/{id}/access` | list skill grants for an agent                                               |
| PATCH  | `/api/agents/{id}/access` | replace grants with `{skill_ids?}`                                          |
| DELETE | `/api/agents/{id}`   | sends `agent.kill` if needed, deletes the agent row + transcript                  |

Agent shape:
```json
{
  "id": "uuid",
  "name": "mobile fix|null",
  "host_id": "uuid",
  "host_name": "gpu-box-1",
  "preset_id": "uuid|null",
  "cwd": "/home/me/projects/foo",
  "argv": ["claude"],
  "env": {"FOO": "bar"},
  "status": "starting" | "running" | "exited" | "killed",
  "started_at": "...",
  "exited_at": "...|null",
  "exit_code": "int|null",
  "pinned_at": "...|null",
  "archived_at": "...|null"
}
```

### Presets

| Method | Path             | Body                                                          |
|--------|------------------|---------------------------------------------------------------|
| GET    | `/api/presets`   | list (built-ins + user-defined)                               |
| POST   | `/api/presets`   | `{name, agent_kind, default_argv, env_template}`              |
| DELETE | `/api/presets/{id}` |                                                            |

Each preset may also carry an optional `install` shell command. The daemon
runs it (via `bash -c`) when `argv[0]` isn't on PATH, streaming stdout into
the agent's PTY so the user sees install progress in the terminal view.

Built-in presets (server-seeded, `owner_user_id = null`):
- **claude-code** — `argv=["claude"]`, install `npm install -g @anthropic-ai/claude-code`
- **codex** — `argv=["codex"]`, install `curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh`
- **opencode** — `argv=["opencode"]`, install `npm install -g opencode-ai`
- **aider-sonnet** — `argv=["aider","--model","claude-sonnet-4-6"]`, install `pipx install aider-chat || pip install --user aider-chat`
- **shell** — `argv=["bash","-l"]`, no install needed

> spawn does not manage agent provider credentials. Each agent CLI handles
> its own login interactively on the host (e.g. `claude /login` writes
> `~/.claude/.credentials.json`). The daemon launches the agent under the
> host user's environment, so the CLI finds whatever it logged in with.

### Skills

Spawn stores managed skills centrally, then grants them to agents explicitly
or by default for new agents. (Managed MCP servers and the `/mcp` endpoint
were removed entirely — see docs/TRUST.md; spawn-mediated tool control
through the server conflicts with the operator model.)

| Method | Path | Body |
|--------|------|------|
| GET | `/api/skills` | list managed skills |
| POST | `/api/skills` | `{name, description?, content, enabled_by_default?}` |
| PATCH | `/api/skills/{id}` | update a managed skill |
| DELETE | `/api/skills/{id}` | delete a managed skill |

When an agent is launched, granted skills are included in the daemon
`agent.create` frame. The daemon writes per-agent files and exports
`SPAWN_AGENT_CONFIG_DIR`, `SPAWN_SKILLS_FILE`, and `SPAWN_SKILLS_DIR`. For
Codex-compatible argv, the daemon also writes a per-agent `CODEX_HOME`
projection containing a `config.toml`, managed skills, and links to existing
Codex auth state when present.

### Screens

Saved multi-terminal arrangements: each screen is one named split-tree
layout of agents. A layout node is either a pane or a binary split:

```json
{"root": {"type": "split", "direction": "row", "ratio": 0.6,
          "a": {"type": "pane", "agent_id": "uuid"},
          "b": {"type": "pane", "agent_id": "uuid"}}}
```

| Method | Path | Body |
|--------|------|------|
| GET | `/api/screens` | list screens |
| POST | `/api/screens` | `{name, layout?}` |
| GET | `/api/screens/{id}` | one screen |
| PATCH | `/api/screens/{id}` | `{name?, layout?}` |
| DELETE | `/api/screens/{id}` | |

Layouts are sanitized on write: panes referencing agents the caller does
not own are pruned (splits collapse to the surviving child), screens cap
at 8 panes, split ratios are clamped to 0.05–0.95.

## Daemon WebSocket — `/ws/daemon`

- Handshake header: `Authorization: Bearer <daemon_token>`
- Subprotocol: `spawn.v1`
- Frames: text frames are JSON, binary frames are PTY data.

### Binary frame layout

```
+------+--------------+-----------------+
| kind | agent_id     | payload         |
| u8   | 16 bytes     | N bytes         |
+------+--------------+-----------------+
```

- `kind = 0x01` — PTY output (daemon → server → browsers)
- `kind = 0x02` — PTY input  (browser → server → daemon)

Agent IDs are big-endian 16-byte UUIDs.

### Daemon → server JSON frames

```json
{"type": "register",
 "host_name": "gpu-box-1",
 "os": "linux",
 "arch": "x86_64",
 "version": "0.1.0",
 "home_dir": "/home/me",
 "existing_agents": ["uuid", ...]}

{"type": "host.heartbeat"}

{"type": "agent.exit",
 "agent_id": "uuid",
 "exit_code": 0,
 "signal": null}

{"type": "agent.started",
 "agent_id": "uuid",
 "pid": 12345}

{"type": "agent.uploaded",
 "agent_id": "uuid",
 "path": "/home/me/projects/foo/.spawn/attachments/screenshot.png",
 "client_id": "browser-upload-id"}

{"type": "agent.snapshot",
 "agent_id": "uuid",
 "bytes_b64": "..."}

{"type": "rtc.answer",
 "session_id": "browser-generated-id",
 "agent_id": "uuid",
 "sdp": "v=0..."}

{"type": "rtc.candidate",
 "session_id": "browser-generated-id",
 "agent_id": "uuid",
 "candidate": {"candidate": "candidate:...", "sdpMid": "0", "sdpMLineIndex": 0}}

{"type": "rtc.status",
 "session_id": "browser-generated-id",
 "agent_id": "uuid",
 "status": "connected|failed",
 "message": "optional detail"}

{"type": "host.fs.list_result",
 "request_id": "uuid",
 "path": "/home/me/projects",
 "home_dir": "/home/me",
 "parent": "/home/me",
 "entries": [{"name": "foo",
              "path": "/home/me/projects/foo",
              "is_dir": true,
              "size": null,
              "modified_at": 1750000000}],
 "error": null}

{"type": "host.fs.read_result",
 "request_id": "uuid",
 "path": "/home/me/projects/a.txt",
 "name": "a.txt",
 "size": 2,
 "bytes_b64": "aGk=",
 "error": null}

{"type": "host.fs.op_result",
 "request_id": "uuid",
 "path": "/home/me/projects/a.txt",
 "error": null}

{"type": "host.tools.check_result",
 "request_id": "uuid",
 "tools": [{
   "preset_id": "uuid",
   "preset_name": "codex",
   "agent_kind": "codex",
   "command": "codex",
   "install": "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh",
   "installed": true,
   "path": "/usr/local/bin/codex",
   "version": "codex 1.2.3",
   "latest_version": "1.2.4|null",
   "update_available": true,
   "error": null}]}

{"type": "host.tools.install_result",
 "request_id": "uuid",
 "result": {
   "preset_id": "uuid",
   "preset_name": "codex",
   "agent_kind": "codex",
   "command": "codex",
   "install": "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh",
   "success": true,
   "exit_code": 0,
   "output": "...",
   "error": null,
   "status": null}}

{"type": "error",
 "agent_id": "uuid|null",
 "code": "spawn_failed|invalid_credential|...",
 "message": "..."}
```

### Server → daemon JSON frames

```json
{"type": "registered", "host_id": "uuid"}

{"type": "host.heartbeat"}

{"type": "host.fs.list",
 "request_id": "uuid",
 "path": "/home/me/projects",
 "include_files": false}

{"type": "host.fs.read",
 "request_id": "uuid",
 "path": "/home/me/projects/a.txt"}

{"type": "host.fs.write",
 "request_id": "uuid",
 "dir": "/home/me/projects",
 "name": "a.txt",
 "bytes_b64": "aGk=",
 "overwrite": false}

{"type": "host.fs.mkdir",
 "request_id": "uuid",
 "path": "/home/me/projects/new-dir"}

{"type": "host.fs.remove",
 "request_id": "uuid",
 "path": "/home/me/projects/old",
 "recursive": false}

{"type": "host.tools.check",
 "request_id": "uuid",
 "targets": [{
   "preset_id": "uuid",
   "preset_name": "codex",
   "agent_kind": "codex",
   "command": "codex",
   "install": "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh"}]}

{"type": "host.tools.install",
 "request_id": "uuid",
 "target": {
   "preset_id": "uuid",
   "preset_name": "codex",
   "agent_kind": "codex",
   "command": "codex",
   "install": "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh"}}

{"type": "agent.create",
 "agent_id": "uuid",
 "cwd": "/home/me/projects/foo",
 "argv": ["claude"],
 "env": {"FOO": "bar"},
 "skills": [{"id": "uuid", "name": "spawn-control",
             "description": "House style for agents", "content": "..."}],
 "install": "npm install -g @anthropic-ai/claude-code",
 "tmux_session": "spawn-<uuid>",
 "cols": 120,
 "rows": 32,
 "create_cwd": true}

{"type": "agent.restart",
 "agent_id": "uuid",
 "cwd": "/home/me/projects/foo",
 "argv": ["claude"],
 "env": {"FOO": "bar"},
 "skills": [],
 "install": "npm install -g @anthropic-ai/claude-code",
 "tmux_session": "spawn-<uuid>",
 "cols": 120,
 "rows": 32,
 "create_cwd": true}

{"type": "agent.kill", "agent_id": "uuid", "signal": "TERM"}

{"type": "agent.resize", "agent_id": "uuid", "cols": 120, "rows": 32}

{"type": "agent.scroll", "agent_id": "uuid", "lines": -8}

{"type": "agent.snapshot", "agent_id": "uuid", "lines": 100000}

{"type": "agent.redraw", "agent_id": "uuid"}

{"type": "agent.upload",
 "agent_id": "uuid",
 "cwd": "/home/me/projects/foo",
 "name": "screenshot.png",
 "mime_type": "image/png",
 "bytes_b64": "...",
 "paste_prefix": "@",
 "paste": false,
 "destination": "cwd",
 "client_id": "browser-upload-id"}

{"type": "rtc.offer",
 "session_id": "browser-generated-id",
 "agent_id": "uuid",
 "sdp": "v=0...",
 "ice_servers": [{"urls": ["stun:stun.l.google.com:19302"]}]}

{"type": "rtc.candidate",
 "session_id": "browser-generated-id",
 "agent_id": "uuid",
 "candidate": {"candidate": "candidate:...", "sdpMid": "0", "sdpMLineIndex": 0}}

{"type": "rtc.close",
 "session_id": "browser-generated-id",
 "agent_id": "uuid"}
```

The daemon launches the agent argv at `cwd` with the host user's process
environment, overlaid with the `env` from this frame. spawn does not inject
provider credentials — each agent CLI authenticates itself on the host.
Image uploads are saved by the daemon under `<cwd>/.spawn/attachments/` by
default. When `destination` is `"cwd"`, the upload may be any file type and is
saved directly under `<cwd>` using a sanitized, non-overwriting filename.
When `paste` is true or omitted, the saved path is inserted into the agent PTY
using `paste_prefix`; when `paste` is false, the daemon only reports the saved
path back to the browser. `client_id` is an optional browser correlation id.
The server sends
`host.heartbeat` acknowledgements for daemon heartbeats so the daemon can
distinguish healthy idle connections from dead sockets.

## Browser WebSocket — `/ws/browser?agent_id=<uuid>&cols=<n>&rows=<n>`

- Auth: session cookie (or `?token=` for testing).
- Subprotocol: clients offer `spawn.v2, spawn.v1` in preference order; the
  server selects `spawn.v2` when WebRTC is enabled, else `spawn.v1`.
  - **`spawn.v2`** (docs/TRUST.md Phase 1): the WS is control + signaling
    only. The server never sends binary frames (live PTY output flows over
    the WebRTC DataChannel exclusively) and closes the socket with code
    `4002` if the browser sends one. All JSON frames below are unchanged.
  - **`spawn.v1`** (legacy): binary frames relay PTY bytes in both
    directions through the server. Kept for rollout compatibility.
- `cols` and `rows` are optional initial browser dimensions. When present,
  the server resizes the tmux attach before producing the initial history
  snapshot.

### Browser → server

```json
{"type": "resize", "cols": 120, "rows": 32}
{"type": "scroll", "lines": -8}
{"type": "upload", "name": "screenshot.png", "mime_type": "image/png", "bytes_b64": "...", "paste": false, "client_id": "browser-upload-id"}
{"type": "upload", "destination": "cwd", "name": "notes.txt", "mime_type": "text/plain", "bytes_b64": "...", "paste": false, "client_id": "browser-upload-id"}
```
Plus raw binary stdin bytes.

`scroll` / `agent.scroll` is retained for legacy/manual tmux copy-mode
operations. Normal browser UI scrollback is local to xterm and should not send
scroll frames or mutate daemon-side viewport state.

When the server advertises WebRTC support, the browser may additionally send
`rtc.offer`, `rtc.candidate`, and `rtc.close` JSON frames over this websocket.
The server authorizes the browser against the agent, forwards signaling to the
owning daemon over `/ws/daemon`, and keeps this websocket open as the control
plane and fallback terminal relay.

### Server → browser

```json
{"type": "rtc.config",
 "enabled": true,
 "ice_servers": [{"urls": ["stun:stun.l.google.com:19302"]}]}
{"type": "history", "bytes_b64": "..."}    // initial replay buffer
{"type": "agent.exit", "exit_code": 0, "signal": null}
{"type": "agent.status", "status": "running"}
{"type": "upload.saved", "path": "/home/me/projects/foo/.spawn/attachments/screenshot.png", "client_id": "browser-upload-id"}
{"type": "upload.saved", "path": "/home/me/projects/foo/notes.txt", "client_id": "browser-upload-id"}
{"type": "upload.error", "message": "..."}
{"type": "rtc.answer", "session_id": "browser-generated-id", "agent_id": "uuid", "sdp": "v=0..."}
{"type": "rtc.candidate", "session_id": "browser-generated-id", "agent_id": "uuid", "candidate": {"candidate": "..."}}
{"type": "rtc.status", "session_id": "browser-generated-id", "agent_id": "uuid", "status": "connected|failed"}
```
Plus raw binary stdout bytes.

## Direct terminal DataChannel

The low-latency terminal data plane is an optional WebRTC DataChannel layered
on top of the websocket control plane.

- The browser creates a DataChannel named `spawn.pty`.
- Signaling goes through `rtc.*` JSON frames on `/ws/browser` and `/ws/daemon`.
- DataChannel messages are raw binary PTY bytes:
  - browser → daemon: stdin bytes for the authorized agent
  - daemon → browser: stdout/stderr PTY bytes for that agent
- The server-relayed binary PTY path stays active as fallback and transcript
  source. Browsers should prefer DataChannel output once it is open to avoid
  duplicate terminal rendering.
- `SPAWN_WEBRTC_ENABLED` enables the direct path, and
  `SPAWN_WEBRTC_ICE_SERVERS` configures the static ICE server list. STUN is
  enough for many LAN/home-network cases; TURN is required for reliable
  fallback across restrictive NATs and mobile/corporate networks.
- `SPAWN_TURN_URLS` + `SPAWN_TURN_SECRET` (+ `SPAWN_TURN_TTL_SECONDS`) point
  at a coturn running with `use-auth-secret`; the server mints ephemeral
  per-session HMAC credentials and appends them to the ICE list in
  `rtc.config` (browser) and `rtc.offer.ice_servers` (daemon). The relay
  only ever carries DTLS ciphertext between the peers.

## Versioning

- The WS subprotocol literal is the version handle. The browser WS
  negotiates `spawn.v2` (DataChannel-only PTY) with `spawn.v1` as the
  legacy relay fallback; the daemon WS remains `spawn.v1` until the
  daemon-owned-data migration (docs/TRUST.md Phase 2). Server SHOULD
  support both during a rollout window.
- REST endpoints under `/api/` are versioned by additive evolution.
