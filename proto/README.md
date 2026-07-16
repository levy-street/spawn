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
| POST   | `/api/hosts/{id}/control/ping` | owner-authorized, content-free current daemon-generation readiness check (204) |
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
| POST   | `/api/agents/{id}/restart` | restart the existing agent with its saved cwd/argv/env; optional `{create_cwd?}` |
| GET    | `/api/agents/{id}/access` | list skill grants for an agent                                               |
| PATCH  | `/api/agents/{id}/access` | replace grants with `{skill_ids?}`                                          |
| DELETE | `/api/agents/{id}`   | sends `agent.kill` if needed, then deletes the agent row                           |

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
- Required subprotocol: `spawn.control.v2`
- Frames: JSON text only. Binary frames close with `4002`; an old/missing
  subprotocol receives content-free `protocol.required` and closes with `4003`.
- The retired daemon-WS `0x01` PTY output and `0x02` PTY input layouts are not
  valid compatibility frames.

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

{"type": "host.pong", "request_id": "uuid"}

{"type": "agent.exit",
 "agent_id": "uuid",
 "exit_code": 0,
 "signal": null}

{"type": "agent.started",
 "agent_id": "uuid",
 "pid": 12345}

{"type": "agent.activity", "agent_id": "uuid"}

{"type": "agent.input_activity", "agent_id": "uuid"}

Both activity frames are daemon-throttled metadata signals. They contain no
terminal bytes: `agent.activity` records meaningful PTY output timing, while
`agent.input_activity` records input timing for the direct WebRTC DataChannel.

{"type": "agent.uploaded",
 "agent_id": "uuid",
 "path": "/home/me/projects/foo/.spawn/attachments/screenshot.png",
 "client_id": "browser-upload-id"}

{"type": "rtc.answer",
 "session_id": "browser-generated-id",
 "binding_nonce": "browser-generated-hex",
 "agent_id": "uuid",
 "scope_type": "agent", "scope_id": "uuid",
 "protocol": "spawn.pty", "protocol_version": 2,
 "sdp": "v=0..."}

{"type": "rtc.candidate",
 "session_id": "browser-generated-id",
 "binding_nonce": "browser-generated-hex",
 "agent_id": "uuid",
 "scope_type": "agent", "scope_id": "uuid",
 "protocol": "spawn.pty", "protocol_version": 2,
 "candidate": {"candidate": "candidate:...", "sdpMid": "0", "sdpMLineIndex": 0}}

{"type": "rtc.status",
 "session_id": "browser-generated-id",
 "binding_nonce": "browser-generated-hex",
 "agent_id": "uuid",
 "scope_type": "agent", "scope_id": "uuid",
 "protocol": "spawn.pty", "protocol_version": 2,
 "status": "connected|failed",
 "message": "optional detail"}

Host-scoped signaling uses the same `rtc.*` types but replaces `agent_id` with
an explicit, mandatory binding tuple on every frame:

```json
{"type": "rtc.answer",
 "session_id": "browser-generated-id",
 "binding_nonce": "browser-generated-hex",
 "scope_type": "host",
 "scope_id": "host-uuid",
 "protocol": "spawn.host.ctl",
 "protocol_version": 1,
 "sdp": "v=0..."}
```

Host `rtc.candidate` and `rtc.status` frames carry the identical tuple and
binding nonce. Host status values are content-free codes; endpoint error
detail is not placed on the signaling websocket.

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

{"type": "host.ping", "request_id": "uuid"}

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

{"type": "host.fs.rename",
 "request_id": "uuid",
 "path": "/home/me/projects/a.txt",
 "name": "b.txt"}

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
 "create_cwd": true}

{"type": "agent.restart",
 "agent_id": "uuid",
 "cwd": "/home/me/projects/foo",
 "argv": ["claude"],
 "env": {"FOO": "bar"},
 "skills": [],
 "install": "npm install -g @anthropic-ai/claude-code",
 "create_cwd": true}

{"type": "agent.kill", "agent_id": "uuid", "signal": "TERM"}

`agent.kill.signal` is optional and accepts only `TERM` or `KILL`; omitted
means `TERM`. Other values are rejected before lifecycle dispatch.

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
 "binding_nonce": "browser-or-server-generated-hex",
 "binding_generation": 7,
 "agent_id": "uuid",
 "scope_type": "agent", "scope_id": "uuid",
 "protocol": "spawn.pty", "protocol_version": 2,
 "sdp": "v=0...",
 "ice_servers": [{"urls": ["stun:stun.l.google.com:19302"]}]}

{"type": "rtc.candidate",
 "session_id": "browser-generated-id",
 "binding_nonce": "browser-or-server-generated-hex",
 "binding_generation": 7,
 "agent_id": "uuid",
 "scope_type": "agent", "scope_id": "uuid",
 "protocol": "spawn.pty", "protocol_version": 2,
 "candidate": {"candidate": "candidate:...", "sdpMid": "0", "sdpMLineIndex": 0}}

{"type": "rtc.close",
 "session_id": "browser-generated-id",
 "binding_nonce": "browser-or-server-generated-hex",
 "binding_generation": 7,
 "agent_id": "uuid",
 "scope_type": "agent", "scope_id": "uuid",
 "protocol": "spawn.pty", "protocol_version": 2}
```

For host-scoped sessions, `rtc.offer`, `rtc.candidate`, and `rtc.close` omit
`agent_id` and carry a 32-character `binding_nonce`, `scope_type:"host"`,
`scope_id`, `protocol:"spawn.host.ctl"`, and `protocol_version:1`. A host offer
also carries `ice_transport_policy:"all|relay"`; when the server supplies only
TURN URLs both endpoints use `relay` and do not gather direct/STUN candidates.
Agent signaling requires the same full scope/protocol tuple and additionally
carries the selected daemon owner's monotonic
`binding_generation`; the daemon combines it with the nonce so frames from an
older daemon ownership generation cannot affect a replacement session. The
legacy `generation` spelling is rejected.

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

## Browser WebSocket — `/ws/browser?agent_id=<uuid>`

- Auth: session cookie (or `?token=` for testing).
- Required subprotocol: `spawn.v2`. An old/missing subprotocol receives only
  `{"type":"protocol.required","protocol":"spawn.v2","version":2}` and
  closes with `4003`.
- This WebSocket is content-free signaling, disclosed lifecycle/status, and
  the still-pending upload migration. It never sends binary frames and closes
  with `4002` for a binary frame or terminal viewport/history/snapshot JSON.
- History, snapshots, geometry, scrolling, redraw and display ownership use
  `spawn.ctl`; terminal bytes use `spawn.pty`. Neither reaches the server.

### Browser → server

```json
{"type": "upload", "name": "screenshot.png", "mime_type": "image/png", "bytes_b64": "...", "paste": false, "client_id": "browser-upload-id"}
{"type": "upload", "destination": "cwd", "name": "notes.txt", "mime_type": "text/plain", "bytes_b64": "...", "paste": false, "client_id": "browser-upload-id"}
```

The browser additionally sends
`rtc.offer`, `rtc.candidate`, and `rtc.close` JSON frames over this websocket.
The server authorizes the browser against the agent, forwards signaling to the
owning daemon over `/ws/daemon`, and keeps this websocket open as the
signaling/status plane. A `spawn.v2` websocket never becomes a terminal relay.

### Server → browser

```json
{"type": "rtc.config",
 "enabled": true,
 "binding_nonce_required": true,
 "ice_servers": [{"urls": ["stun:stun.l.google.com:19302"]}]}
{"type": "agent.exit", "exit_code": 0, "signal": null}
{"type": "agent.status", "status": "running"}
{"type": "upload.saved", "path": "/home/me/projects/foo/.spawn/attachments/screenshot.png", "client_id": "browser-upload-id"}
{"type": "upload.saved", "path": "/home/me/projects/foo/notes.txt", "client_id": "browser-upload-id"}
{"type": "upload.error", "message": "..."}
{"type": "rtc.answer", "session_id": "browser-generated-id", "binding_nonce": "browser-generated-hex", "binding_generation": 7, "agent_id": "uuid", "scope_type":"agent", "scope_id":"uuid", "protocol":"spawn.pty", "protocol_version":2, "sdp": "v=0..."}
{"type": "rtc.candidate", "session_id": "browser-generated-id", "binding_nonce": "browser-generated-hex", "binding_generation": 7, "agent_id": "uuid", "scope_type":"agent", "scope_id":"uuid", "protocol":"spawn.pty", "protocol_version":2, "candidate": {"candidate": "..."}}
{"type": "rtc.status", "session_id": "browser-generated-id", "binding_nonce": "browser-generated-hex", "binding_generation": 7, "agent_id": "uuid", "scope_type":"agent", "scope_id":"uuid", "protocol":"spawn.pty", "protocol_version":2, "status": "connected|failed"}
```

## Direct per-agent DataChannels

The terminal data plane is two mandatory WebRTC DataChannels negotiated over
the content-free WebSocket signaling plane.

- The browser creates ordered DataChannels named `spawn.pty` and `spawn.ctl`.
- Signaling goes through `rtc.*` JSON frames on `/ws/browser` and `/ws/daemon`.
- DataChannel messages are raw binary PTY bytes:
  - browser → daemon: stdin bytes for the authorized agent
  - daemon → browser: stdout/stderr PTY bytes for that agent
- `spawn.ctl` carries the versioned bounded control protocol below. A v2
  terminal is ready only after both channels open and its initial history
  response is applied.
- Missing, duplicate, closed, or unknown agent channels close the peer; there
  is no server-content fallback.
- `SPAWN_WEBRTC_ICE_SERVERS` configures the static ICE server list. STUN is
  enough for many LAN/home-network cases; TURN is required for reliable
  fallback across restrictive NATs and mobile/corporate networks.
- `SPAWN_TURN_URLS` + `SPAWN_TURN_SECRET` (+ `SPAWN_TURN_TTL_SECONDS`) point
  at a coturn running with `use-auth-secret`; the server mints ephemeral
  per-session HMAC credentials and appends them to the ICE list in
  `rtc.config` (browser) and `rtc.offer.ice_servers` (daemon). The relay
  only ever carries DTLS ciphertext between the peers.

### `spawn.ctl` version 1

Requests are JSON text messages no larger than 16 KiB. `request_id` is a fresh
UUID and binds every response/chunk to its caller:

```json
{"version":1,"kind":"request","request_id":"uuid","operation":"history","lines":400,"plain":false,"cols":120,"rows":32}
{"version":1,"kind":"request","request_id":"uuid","operation":"snapshot","lines":10000,"plain":false}
{"version":1,"kind":"request","request_id":"uuid","operation":"resize","cols":120,"rows":32}
{"version":1,"kind":"request","request_id":"uuid","operation":"take_control","cols":120,"rows":32}
{"version":1,"kind":"request","request_id":"uuid","operation":"scroll","lines":-8}
{"version":1,"kind":"request","request_id":"uuid","operation":"redraw"}
```

History and snapshot currently support styled terminal replay only
(`plain:false`). A `plain:true` request fails closed with
`error.code="plain_replay_unsupported"`; the daemon does not relabel ANSI replay
as plain text.

The daemon clamps the protocol surface by rejecting, rather than silently
changing, invalid values: history/snapshot is 1–10,000 lines, geometry is
20–400 columns by 5–200 rows, and scroll is a non-zero delta from -200 to 200.
Worker replay uses the requested line count to bound its byte request and
returns a complete checkpoint-plus-stream; raw terminal bytes cannot safely be
line-truncated without losing parser state.
Only the daemon-selected display owner may resize; `take_control` transfers
ownership. Viewer attach/detach/transfer produces a per-viewer E2E event:

```json
{"version":1,"kind":"event","event":"display_state","owner":true,"cols":120,"rows":32,"viewers":2}
```

Small operations receive an `ok` response. History/snapshot metadata precedes
zero or more request-bound binary chunks and caps the complete response at
12 MiB:

```json
{"version":1,"kind":"response","request_id":"uuid","operation":"snapshot","ok":true,"plain":false,"pty_offset":42,"total_bytes":90000,"chunks":2}
```

Each binary chunk is at most 48 KiB of payload:

```text
+----------+---------+------+-------+----------------+----------+---------+
| "SPCT"   | version | kind | flags | request UUID   | sequence | payload |
| 4 bytes  | u8 (=1) | u8=1 | u16LE | 16 raw bytes   | u32LE    | bytes   |
+----------+---------+------+-------+----------------+----------+---------+
```

Flag bit 0 marks the last chunk. Errors are request-bound JSON responses with
`ok:false` plus stable `error.code` and bounded endpoint-only `error.detail`.
The worker uses an 8 MiB conservative total resource charge by default. It
includes exact ciphertext/framing bytes, twice the complete replay
representation, and retained log/path bookkeeping. Replay returns only whole
segments and fails if the newest complete segment does not fit the requested
response budget. An append/checkpoint admission failure disables replay for
that live worker rather than returning partial history; live PTY forwarding
continues. The control envelope retains a separate 12 MiB hard rejection ceiling.

`spawn.pty` and `spawn.ctl` are each ordered, but there is no total order
between them. Replay metadata therefore carries `pty_offset`, the exact
per-viewer `spawn.pty` byte boundary represented by the replay. Worker output
and replay share the worker's durable watermark, translated through the
viewer's attach origin. The worker logs output before forwarding it, so a replay
watermark is a stable barrier: spawnd waits until the live source coordinate
reaches it before returning the translated viewer anchor. The browser buffers
live PTY data during bootstrap, applies the replay, discards buffered bytes
through the anchor, and then applies only the suffix. Snapshot reconciliation
uses the same explicit anchor; it never infers capture order from message
arrival.

The daemon has one mandatory session backend and no selection escape hatch.
Old pre-cutover sessions are not adopted; operators must drain them before
installing/restarting the worker-only daemon. See `docs/TRUST_PHASE2_PROGRESS.md`.

The signaling server binds each active RTC session ID to its browser
connection, scope, binding nonce, selected daemon connection and durable daemon
ownership generation. Active ID collisions are rejected, and every candidate,
close, answer and status must match that binding; retired nonces and stale
owner generations cannot affect a replacement session. The daemon additionally
binds every agent RTC callback to both that signaling identity and the concrete
agent-backend generation, then drains its callback fence before replacing or
removing that backend.
Per-viewer live and response queues are bounded. A viewer that stalls SCTP
beyond the send timeout is disconnected and obtains a new bounded replay when
it reconnects; display-state updates are latest-value/coalesced.

## Host control WebSocket and DataChannel

`/ws/host?host_id=<uuid>` is a signaling-only browser websocket independent of
any agent. It authenticates the browser session, verifies that the user owns
the host, and selects subprotocol `spawn.host.v1`. The server sends a bound
`rtc.config`; browser offers/candidates/closes and daemon
answers/candidates/statuses must repeat the exact host binding tuple above.
The signaling router binds each `session_id` to the initiating browser
connection, selected daemon connection, host, protocol, and version. Session
ID collisions and cross-browser, cross-daemon, cross-host, or cross-protocol
frames are rejected.

The browser creates an ordered `spawn.host.ctl` DataChannel. The daemon accepts
that label only on a host-scoped peer connection for its server-registered host
identity. The server never receives these messages. Version 1 starts with:

```json
{"version":1,"type":"hello","protocol":"spawn.host.ctl","capabilities":["ping"]}
{"version":1,"type":"request","request_id":"unguessable-id","operation":"ping"}
{"version":1,"type":"response","request_id":"unguessable-id","ok":true,"result":{"pong":true}}
{"version":1,"type":"cancel","request_id":"unguessable-id"}
```

Control messages are UTF-8 JSON text limited to 16 KiB, request IDs are
limited to 128 bytes, and malformed, binary, wrong-version, or oversized
messages close the channel. The browser limits concurrent requests, applies a
timeout, sends cancellation on timeout/abort, and binds responses to the
outstanding request ID. Filesystem/tool/launch operations and their bounded
chunk streams are added by later trust Phase 2 tasks; the transport root
currently advertises only `ping`.

## Versioning

- The WS subprotocol literal is the version handle. The browser WS
  requires `spawn.v2`; the daemon WS requires `spawn.control.v2`. Older or
  missing subprotocols receive a content-free protocol-required close. There
  is deliberately no mixed-version rollout or terminal relay fallback.
- Host signaling uses `spawn.host.v1`; its DataChannel protocol is separately
  versioned by the mandatory `protocol_version` signaling field and `version`
  envelope field.
- REST endpoints under `/api/` are versioned by additive evolution.
