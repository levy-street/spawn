# Interaction Surface Matrix

This table records the current compatibility surface. It is not permission to
keep a protected REST/server frame. The Phase 2 target makes REST the disclosed
metadata plane and the DataChannels the protected-content plane. (The MCP tool
surface and `/mcp` endpoint were removed entirely — see docs/TRUST.md.)

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
| Rename/pin/archive/delete agent | agents page, detail header, sidebar | `PATCH/DELETE /api/agents/{id}` | `agents.update/rename/pin/archive/remove` | metadata update; `agent.kill` for delete |
| Restart agent | agents page, detail header, sidebar | `POST /api/agents/{id}/restart` | `agents.restart` | `agent.restart` |
| Terminal input | terminal page | `POST /api/agents/{id}/input` | `agents.input` | binary input frame |
| Resize/scroll/redraw terminal | terminal page display owner | `/resize`, `/scroll`, `/redraw` | `agents.resize/scroll/redraw` | `agent.resize`, `agent.scroll`, `agent.redraw` |
| Capture terminal snapshot | terminal reconnect/history | `POST /api/agents/{id}/snapshot` | `agents.snapshot` | `agent.snapshot` request/result |
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
| delete/wipe | metadata deletion/revocation only | revisioned tombstone/object crypto-delete; explicit local store wipe | server revocation cannot prove an offline endpoint was erased |

There is deliberately no server helper that accepts protected values, opaque
Phase 2 sync blob, recovery key, or plaintext fallback. Old clients get a
content-free upgrade failure after cutover.

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
