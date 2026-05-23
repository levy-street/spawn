# Interaction Surface Matrix

Spawn exposes the same host and agent controls through the browser UI, REST API,
MCP tools, typed web helpers, and the daemon wire protocol. REST is the source of
truth for user-facing semantics; MCP and browser flows call into the same route
or shared control helpers where possible.

| Capability | Browser UI | REST | MCP | Web helper | Daemon frame |
| --- | --- | --- | --- | --- | --- |
| Sign up, sign in, sign out, session | login/signup/settings | `/api/auth/*`, `/api/me` | bearer auth only | `auth.*` | none |
| Generate MCP bearer token | settings | `POST /api/auth/mcp-token` | n/a | `auth.mcpToken` | none |
| Device approval | device page | `/api/auth/device/*` | none | `auth.approveDevice` | `device.start`, poll/login CLI |
| List/get hosts | hosts page, agent form | `GET /api/hosts`, `GET /api/hosts/{id}` | `list_hosts`, `get_host` | `hosts.list/get` | register/heartbeat updates |
| Rename/delete host | hosts page | `PATCH/DELETE /api/hosts/{id}` | `rename_host`, `delete_host` | `hosts.rename/remove` | delete closes connected daemon |
| List host directories | new-agent picker | `GET /api/hosts/{id}/dirs` | `list_host_dirs` | `hosts.dirs` | `host.dirs` request/result |
| Check/install host tools | hosts page, agent update badge | `/tools`, `/install`, `/policy` | `list_host_tools`, `install_host_tool`, `set_host_tool_auto_update` | `hosts.tools/installTool/updateToolPolicy` | `host.tools.check`, `host.tools.install` |
| List/create/update/delete presets | settings | `/api/presets` | `list_presets`, `create_preset`, `update_preset`, `delete_preset` | `presets.*` | used at agent launch |
| Manage MCP servers | settings, new-agent access picker | `/api/mcp-servers` | `list_mcp_servers`, `create_mcp_server`, `create_spawn_mcp_server`, `update_mcp_server`, `delete_mcp_server` | `mcpServers.*` | included in `agent.create` |
| Manage skills | settings, new-agent access picker | `/api/skills` | `list_skills`, `create_skill`, `update_skill`, `delete_skill` | `skills.*` | included in `agent.create` |
| Grant agent MCP/skill access | new-agent access picker, agent detail summary | `/api/agents/{id}/access` | `get_agent_access`, `set_agent_access`; `create_agent` accepts grants | `agentAccess.*`; `agents.create` grant fields | materializes files/env and Codex projection |
| List/get/create agents | agents page, sidebar, new-agent form | `/api/agents` | `list_agents`, `get_agent`, `create_agent` | `agents.list/get/create` | `agent.create` |
| Rename/pin/archive/delete agent | agents page, detail header, sidebar | `PATCH/DELETE /api/agents/{id}` | `rename_agent`, `pin_agent`, `archive_agent`, `delete_agent` | `agents.update/rename/pin/archive/remove` | `agent.rename`, `agent.kill` |
| Restart agent | agents page, detail header, sidebar | `POST /api/agents/{id}/restart` | `restart_agent` | `agents.restart` | `agent.restart` |
| Terminal input | terminal page | `POST /api/agents/{id}/input` | `send_agent_input` | `agents.input` | binary input frame |
| Resize/scroll/redraw terminal | terminal page display owner | `/resize`, `/scroll`, `/redraw` | `resize_agent`, `scroll_agent`, `redraw_agent` | `agents.resize/scroll/redraw` | `agent.resize`, `agent.scroll`, `agent.redraw` |
| Capture terminal snapshot | terminal reconnect/history | `POST /api/agents/{id}/snapshot` | `snapshot_agent` | `agents.snapshot` | `agent.snapshot` request/result |
| Upload file/image to agent cwd | terminal upload/drop/paste | `/upload`, `/upload-file` | `upload_agent_file` | `agents.upload/uploadFile` | `agent.upload` request/result |
| tmux session visibility | agent detail header | `tmux_session` field | `tmux_session` field | `Agent.tmux_session` | daemon creates/renames session |

Intentional differences:

- Browser display ownership is a UI/WebSocket coordination feature. REST and MCP
  expose the underlying resize, scroll, redraw, snapshot, upload, and input
  actions but do not model viewer ownership.
- The `spawnd` CLI is host-side daemon administration only: login, status,
  logout, run, install, and service setup. User agent control lives in browser,
  REST, and MCP.
- Browser upload includes native file picker, drop, and paste affordances.
  REST/MCP carry the same data as JSON base64; REST also supports multipart.
- Managed MCP servers and skills are projected per agent. Spawn does not mutate
  the host user's global MCP or skill configuration.
