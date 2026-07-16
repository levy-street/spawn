# Interaction Surface Matrix

This table records the current compatibility surface. It is not permission to
keep a protected REST/server frame. The Phase 2 target makes REST the disclosed
metadata plane and authenticated end-to-end DataChannels the protected-content
plane. REST remains the source of truth only for server-visible semantics. (The
MCP tool surface and `/mcp` endpoint were removed entirely — see docs/TRUST.md.)

| Capability | Browser UI | REST | Web helper | Daemon frame |
| --- | --- | --- | --- | --- |
| Sign up, sign in, sign out, session | login/signup/settings | `/api/auth/*`, `/api/me` | `auth.*` | none |
| Device approval | device page | `/api/auth/device/*` | `auth.approveDevice` | `device.start`, poll/login CLI |
| List/get hosts | hosts page, agent form | `GET /api/hosts`, `GET /api/hosts/{id}` | `hosts.list/get` | register/heartbeat updates |
| Rename/delete host | hosts page | `PATCH/DELETE /api/hosts/{id}` | `hosts.rename/remove` | delete closes connected daemon |
| List/manage host files | file explorer, new-agent picker | none | `HostControlClient` | capability-rooted E2E `spawn.host.ctl` `fs.*`; explicit bounded pages and streams |
| Check/install host tools | hosts page, agent update badge | `/tools`, `/install`, `/policy` | `hosts.tools/installTool/updateToolPolicy` | `host.tools.check`, `host.tools.install` |
| List/create/update/delete presets | settings | `/api/presets` | `presets.*` | used at agent launch |
| Manage skills | settings, new-agent access picker | `/api/skills` | `skills.*` | included in `agent.create` |
| Grant agent skill access | new-agent access picker, agent detail summary | `/api/agents/{id}/access` | `agentAccess.*`; `agents.create` grant fields | materializes files/env and Codex projection |
| List/get/create agents | agents page, sidebar, new-agent form | `/api/agents` | `agents.list/get/create` | `agent.create` |
| Rename/pin/archive/delete agent | agents page, detail header, sidebar | `PATCH/DELETE /api/agents/{id}` | `agents.update/rename/pin/archive/remove` | metadata update; `agent.kill` for delete |
| Restart agent | agents page, detail header, sidebar | `POST /api/agents/{id}/restart` | `agents.restart` | `agent.restart` |
| Terminal input | terminal page | none | terminal socket hook | `spawn.pty` DataChannel direct to endpoint |
| Resize/scroll/redraw/display ownership | terminal page | none | `spawn.ctl` client | versioned `spawn.ctl` request direct to endpoint |
| History/snapshot replay | terminal reconnect/history | none | `spawn.ctl` client | bounded `spawn.ctl` chunk response direct from worker |
| Upload file/image to agent cwd | terminal upload/drop/paste | `/upload`, `/upload-file` | `agents.upload/uploadFile` | `agent.upload` request/result |

## Approved durable protected-data target (P2-DATA-01)

This target is a design contract only; P2-DATA-02 has not implemented it. The
per-host endpoint store and exact failure/migration semantics are specified in
`DURABLE_SENSITIVE_DATA.md`.

| Capability | Server metadata plane | Browser ↔ endpoint plane | Offline behavior |
| --- | --- | --- | --- |
| create/restart agent | reserve/update agent ID, host/preset relationship, neutral or explicit name, lifecycle only | resolve and commit exact `agent_manifest`, then launch over `spawn.host.ctl` | metadata remains visible; launch/restart is unavailable while host is offline |
| edit/use preset | ID, owner, name, description/kind only | exact-revision `preset_values` read/write on each selected host | no protected server cache or queued sync |
| edit/use skill | ID, owner, name, description/default flag and grant IDs only | exact-revision `skill_body` read/write/materialization on each selected host | no body is returned; launch fails closed if a referenced revision is absent |
| tool target/policy | allowed enabled flag, IDs, coarse timestamps and content-free status | executable/install target, endpoint execution policy, versions/output/detail | unattended endpoint policy may run locally; server cannot reconstruct a missing target |
| copy preset/skill across hosts | no content operation | browser streams source host → browser → destination host over two authenticated host channels | both hosts must be online |
| export/import/recover | no key or archive endpoint | bounded passphrase-encrypted archive over `spawn.host.ctl` | account/password recovery alone cannot recover a lost host |
| reconcile ambiguous mutation | no protected request/record state; disclosed lifecycle metadata is not proof of outcome | endpoint-durable `outcome_unknown` inventory and operation-specific check/ack over `spawn.host.ctl` | lock survives daemon/browser restart; no automatic retry |
| delete/wipe | metadata deletion/revocation only | revisioned tombstone/object crypto-delete; explicit local store wipe | server revocation cannot prove an offline endpoint was erased |

There is deliberately no server helper that accepts protected values, opaque
Phase 2 sync blob, recovery key, or plaintext fallback. Old clients get a
content-free upgrade failure after cutover.

Intentional differences:

- Host home, paths, directory metadata, file bytes, and detailed filesystem
  errors never use REST or the server daemon WebSocket. The browser talks to
  the selected host on its independently bound `spawn.host.ctl` DataChannel;
  cross-host copies are browser-mediated between two such sessions.
- Browser display ownership, terminal input, viewport control, and replay are
  endpoint-owned DataChannel features. REST and server WebSockets deliberately
  expose none of those content-bearing operations.
- The `spawnd` CLI is host-side daemon administration only: login, status,
  logout, run, install, and service setup. User agent control lives in browser
  and REST.
- Browser upload includes native file picker, drop, and paste affordances.
  REST carries the same data as JSON base64 and also supports multipart.
- Managed skills are projected per agent. Spawn does not mutate the host
  user's global skill configuration.
