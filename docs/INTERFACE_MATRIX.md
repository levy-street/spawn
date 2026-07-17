# Interaction Surface Matrix

Spawn exposes controls through the browser UI, REST API, typed web helpers, and
daemon protocols. REST is the source of truth for server-visible semantics;
content-confidential host controls instead use authenticated end-to-end
DataChannels. (The MCP tool surface and `/mcp` endpoint were removed entirely —
see docs/TRUST.md.)

| Capability | Browser UI | REST | Web helper | Daemon frame |
| --- | --- | --- | --- | --- |
| Sign up, sign in, sign out, session | login/signup/settings | `/api/auth/*`, `/api/me` | `auth.*` | none |
| Device approval | device page | `/api/auth/device/*` | `auth.approveDevice` | `device.start`, poll/login CLI |
| List/get hosts | hosts page, agent form | `GET /api/hosts`, `GET /api/hosts/{id}` | `hosts.list/get` | register/heartbeat updates |
| Rename/delete host | hosts page | `PATCH/DELETE /api/hosts/{id}` | `hosts.rename/remove` | delete closes connected daemon |
| List/manage host files | file explorer, new-agent picker | none | `HostControlClient` | capability-rooted E2E `spawn.host.ctl` `fs.*`; explicit bounded pages and streams |
| Check/install host tools | hosts page, agent update badge | disclosed target metadata at `/tool-targets`; policy at `/policy`; legacy `/tools` and `/install` temporarily retained | interactive `HostControlClient.checkTools/installTool`; `hosts.updateToolPolicy`; legacy REST helpers retained | interactive E2E `spawn.host.ctl` `tool.check`/`tool.install`; legacy/unattended `host.tools.*` retained |
| List/create/update/delete presets | settings | `/api/presets` | `presets.*` | used at agent launch |
| Manage skills | settings, new-agent access picker | `/api/skills` | `skills.*` | included in `agent.create` |
| Grant agent skill access | new-agent access picker, agent detail summary | `/api/agents/{id}/access` | `agentAccess.*`; `agents.create` grant fields | materializes files/env and Codex projection |
| List/get/create agents | agents page, sidebar, new-agent form | `/api/agents` | `agents.list/get/create` | `agent.create` |
| Rename/pin/archive/delete agent | agents page, detail header, sidebar | `PATCH/DELETE /api/agents/{id}` | `agents.update/rename/pin/archive/remove` | metadata update; `agent.kill` for delete |
| Restart agent | agents page, detail header, sidebar | `POST /api/agents/{id}/restart` | `agents.restart` | `agent.restart` |
| Terminal input | terminal page | none | terminal socket hook | `spawn.pty` DataChannel direct to endpoint |
| Resize/scroll/redraw/display ownership | terminal page | none | `spawn.ctl` client | versioned `spawn.ctl` request direct to endpoint |
| History/snapshot replay | terminal reconnect/history | none | `spawn.ctl` client | bounded `spawn.ctl` chunk response direct from worker |
| Upload file/image to agent | terminal upload/drop/paste | none | terminal `spawn.ctl` client | bounded `spawn.ctl` `upload_start`/kind-2 chunks/cancel/completion direct to endpoint |

Intentional differences:

- Host home, paths, directory metadata, file bytes, and detailed filesystem
  errors never use REST or the server daemon WebSocket. The browser talks to
  the selected host on its independently bound `spawn.host.ctl` DataChannel;
  cross-host copies are browser-mediated between two such sessions.
- Interactive tool commands, executable paths, versions, installer argv,
  stdout/stderr, and detailed errors use `spawn.host.ctl` directly. REST
  discloses only target/policy metadata to that UI. The old REST and
  server-daemon tool path remains solely for compatibility and unattended
  updates until P2-HOST-03B; its presence keeps Phase 2 incomplete.
- Browser display ownership, terminal input, viewport control, replay, and
  agent upload are
  endpoint-owned DataChannel features. REST and server WebSockets deliberately
  expose none of those content-bearing operations.
- The `spawnd` CLI is host-side daemon administration only: login, status,
  logout, run, install, and service setup. User agent control lives in browser
  and REST.
- Browser upload includes native file picker, drop, and paste affordances. It
  hashes, chunks, backpressures, retries, and cancels on the direct per-agent
  control channel; there is no REST, signaling-WebSocket, or daemon-WebSocket
  upload-content path.
- Managed skills are projected per agent. Spawn does not mutate the host
  user's global skill configuration.
