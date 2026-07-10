# Interaction Surface Matrix

Spawn exposes the same host and agent controls through the browser UI, REST API,
typed web helpers, and the daemon wire protocol. REST is the source of truth for
user-facing semantics; browser flows call into the same route or shared control
helpers where possible. (The MCP tool surface and `/mcp` endpoint were removed
entirely — see docs/TRUST.md.)

| Capability | Browser UI | REST | Web helper | Daemon frame |
| --- | --- | --- | --- | --- |
| Sign up, sign in, sign out, session | login/signup/settings | `/api/auth/*`, `/api/me` | `auth.*` | none |
| Device approval | device page | `/api/auth/device/*` | `auth.approveDevice` | `device.start`, poll/login CLI |
| List/get hosts | hosts page, agent form | `GET /api/hosts`, `GET /api/hosts/{id}` | `hosts.list/get` | register/heartbeat updates |
| Rename/delete host | hosts page | `PATCH/DELETE /api/hosts/{id}` | `hosts.rename/remove` | delete closes connected daemon |
| List host directories | new-agent picker | `GET /api/hosts/{id}/dirs` | `hosts.dirs` | `host.dirs` request/result |
| Check/install host tools | hosts page, agent update badge | `/tools`, `/install`, `/policy` | `hosts.tools/installTool/updateToolPolicy` | `host.tools.check`, `host.tools.install` |
| List/create/update/delete presets | settings | `/api/presets` | `presets.*` | used at agent launch |
| Manage skills | settings, new-agent access picker | `/api/skills` | `skills.*` | included in `agent.create` |
| Grant agent skill access | new-agent access picker, agent detail summary | `/api/agents/{id}/access` | `agentAccess.*`; `agents.create` grant fields | materializes files/env and Codex projection |
| List/get/create agents | agents page, sidebar, new-agent form | `/api/agents` | `agents.list/get/create` | `agent.create` |
| Rename/pin/archive/delete agent | agents page, detail header, sidebar | `PATCH/DELETE /api/agents/{id}` | `agents.update/rename/pin/archive/remove` | `agent.rename`, `agent.kill` |
| Restart agent | agents page, detail header, sidebar | `POST /api/agents/{id}/restart` | `agents.restart` | `agent.restart` |
| Terminal input | terminal page | `POST /api/agents/{id}/input` | `agents.input` | binary input frame |
| Resize/scroll/redraw terminal | terminal page display owner | `/resize`, `/scroll`, `/redraw` | `agents.resize/scroll/redraw` | `agent.resize`, `agent.scroll`, `agent.redraw` |
| Capture terminal snapshot | terminal reconnect/history | `POST /api/agents/{id}/snapshot` | `agents.snapshot` | `agent.snapshot` request/result |
| Upload file/image to agent cwd | terminal upload/drop/paste | `/upload`, `/upload-file` | `agents.upload/uploadFile` | `agent.upload` request/result |
| tmux session visibility | agent detail header | `tmux_session` field | `Agent.tmux_session` | daemon creates/renames session |

Intentional differences:

- Browser display ownership is a UI/WebSocket coordination feature. REST
  exposes the underlying resize, scroll, redraw, snapshot, upload, and input
  actions but does not model viewer ownership.
- The `spawnd` CLI is host-side daemon administration only: login, status,
  logout, run, install, and service setup. User agent control lives in browser
  and REST.
- Browser upload includes native file picker, drop, and paste affordances.
  REST carries the same data as JSON base64 and also supports multipart.
- Managed skills are projected per agent. Spawn does not mutate the host
  user's global skill configuration.
