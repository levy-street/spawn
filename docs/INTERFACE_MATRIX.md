# Interaction surface matrix

This is the current implementation-backed contract between `web/`, `server/`,
and `daemon/`. `proto/README.md` remains the exhaustive wire reference.

## Product objects

| Object | Meaning | Database / REST / web |
| --- | --- | --- |
| Session | one login-shell PTY on a host | `sessions` / `/api/sessions` / `/sessions/[id]` or a workspace tile |
| Agent | launchable CLI definition used as a shortcut inside a session; not a process | `agents` / `/api/agents` / Settings → Agents |
| Workspace | named packed grid of session tiles | `workspaces` / `/api/workspaces` / `/w/[id]` |
| Host | paired machine running `spawnd` | `hosts` / `/api/hosts` / Settings → Hosts, `/hosts/[id]`, and `/legion` |
| Skill | managed content materialized for an allowed session | `skills` / `/api/skills` / Settings → Skills |

## HTTP and direct-channel capabilities

| Capability | Web surface | HTTP surface | Web helper | Daemon/direct surface |
| --- | --- | --- | --- | --- |
| Onboarding configuration | `/onboarding`, auth pages | `GET /api/auth/config` → `{providers, email_verification_required, invite_only}` | `auth.config` | none |
| Account lifecycle | auth pages, Settings → Account | `/api/auth/signup`, `/api/auth/login`, `/api/auth/logout`, `/api/me`, `/api/account/delete`, recovery and verification routes under `/api/auth` | `auth.*`, `account.remove` | none |
| Pair a host | onboarding, `/device`, Settings → Hosts | `/api/auth/device/{start,possession,poll,pending,approve}` | `auth.pendingDevice`, `auth.approveDevice` | device-code login and possession proof |
| List/get/rename/delete hosts | Settings → Hosts, `/hosts/[id]` | `GET /api/hosts`, `GET/PATCH/DELETE /api/hosts/{id}` | `hosts.list/get/rename/remove` | registration and presence over daemon WS |
| Check/install configured agents on a host | Settings → Hosts/Agents, session shortcut bar | `GET /api/hosts/{id}/agents`; `POST /api/hosts/{id}/agents/{agent_id}/install`; `PATCH /api/hosts/{id}/agents/{agent_id}/policy` | `hosts.agents/installAgent/updateAgentPolicy` | `host.agents.check` / `check_result`; `host.agents.install` / `install_result` |
| Recent session directories | none — the folder browser answers "where" now; the route and its client helper remain | `GET /api/hosts/{id}/recent-dirs` → `{dirs:[{path,last_used_at}]}` (newest first, max 8) | `hosts.recentDirs` | none |
| Host files | folder picker, file explorer | none; only signaling is server-mediated | `HostControlClient` | capability-rooted `spawn.host.ctl` `fs.*` requests and bounded streams |
| Host file previews | file explorer hover card and viewer dialog | none; never server-visible | `HostControlClient.readRange/previewImage` | `fs.read.range` bounded slice; `fs.preview` host-rendered PNG (macOS only, advertised per host) |
| Reveal / open a host file on its desktop | file row menu, viewer toolbar | none | `HostControlClient.reveal/openDefault` | `desktop.reveal` / `desktop.open`; path-only payload, allowlisted and rate-limited on the host (macOS only, advertised per host) |
| List/create/get/rename/delete sessions | sidebar, workspace grid, `/sessions/[id]` | `GET/POST /api/sessions`, `GET/PATCH/DELETE /api/sessions/{id}`; list accepts only optional `host_id` | `sessions.*` | `session.create`, `session.kill`; terminal over direct channels |
| Restart a session | sidebar, pane/full-session actions, the agent's own "Update installed · Restart to update" notice | `POST /api/sessions/{id}/restart` | `sessions.restart`; for an agent window the client queues the agent's resume command (`claude --resume <agent_session_id>`, or `--continue` when none was recorded) and types it the moment the fresh shell's transport opens | `session.restart` ends the worker (the process tree goes with its PTY) and starts a login shell in the stored `cwd`; the resume command is client-typed input like any launch |
| Session skill access | Settings → Skills and session access consumers | `GET/PATCH /api/sessions/{id}/access` | `sessionAccess.get/update` | skills are included in `session.create` / `session.restart` and materialized per session |
| List/create/get/update/delete workspaces | sidebar and `/w/[id]` | `GET/POST /api/workspaces`, `GET/PATCH/DELETE /api/workspaces/{id}` | `workspaces.*` | deleting a workspace best-effort kills every session referenced by its tiles |
| Archive / restore a workspace | sidebar Archived drawer, `/w/[id]` | `POST /api/workspaces/{id}/{archive,unarchive}` | `workspaces.archive/unarchive` | archiving stops every session and keeps the rows, layout and sidebar slot; restoring restarts the same sessions in place |
| Manage agent definitions | Settings → Agents, shortcut bar | `GET/POST /api/agents`, `PATCH/DELETE /api/agents/{id}` | `agents.*` | definitions are typed into the shell; built-ins are immutable through write routes |
| Yolo mode (skip an agent's permission prompts) | Settings → Agents, one switch per agent | `PATCH /api/agents/{id}/preferences` → `{yolo}`; the spelling rides on `AgentOut` as `yolo_args`/`yolo_env` | `agents.setPreferences`, `agentRunCommand` | per user, not per definition (`agent_preferences`), so the switch is live on read-only built-ins; folded into the command the browser types, never a hidden launch flag |
| Manage skills | Settings → Skills | `GET/POST /api/skills`, `PATCH/DELETE /api/skills/{id}` | `skills.*` | materialized into the session environment/config root |
| Browser devices and trust | Settings → Browser devices / Device trust | `/api/browser-devices/*`, `/api/trust/{bundle,passkeys,endorsements,hosts/.../pins}` | `browserDevices.*`, `trust.*` | signed signaling and daemon-local browser pins |
| Host capacity | sidebar Legion strip, `/legion`, profile dialog | on `GET /api/hosts`: static spec (`cpu_cores`, `cpu_physical_cores`, `cpu_model`, `memory_bytes`, `gpu`) plus `cpu_bucket`/`mem_bucket` in `0..=5` and `capacity_at`; buckets are withheld for an offline host | `summarizeLegion`, `useHostCapacity` | spec on `register`; buckets on `host.heartbeat`; **exact** figures only over `spawn.host.ctl` `host.metrics`, never server-visible. `SPAWND_NO_TELEMETRY=1` disables all three |
| Profile and legion history | account menu → Profile | `GET /api/profile` → identity, `totals`, `agents`, sparse `days`, `hosts`, `history_days`, `today` | `profile.get`, `calendar` | none — read from `legion_days`, an append-only per-owner-per-day counter table written beside the existing lifecycle writes |
| Terminal input/output | workspace/session terminal | none | `useSessionSocket`, `LiveTerminalProvider` | ordered reliable `spawn.pty` DataChannel direct to the endpoint |
| Alerts on agent completion | Settings → Notifications, pane menu → Mute alerts | none; delivered over `/ws/alerts` (owner-scoped, subprotocol `spawn.alerts.v1`) | `subscribeToAlerts`, `useSessionAlerts`, `notify-prefs` | transitions are detected beside the lifecycle writes in `ws/daemon.py`; the daemon gains no new frame |
| Replay, resize, display ownership, upload | workspace/session terminal | none | `spawn.ctl` client | ordered reliable locked `spawn.ctl` v1 DataChannel direct to the endpoint |

`POST /api/sessions` accepts `host_id`, `cwd`, optional `name`, optional
`skill_ids`, and optional `workspace_id` plus `tile`. With a workspace and no
explicit tile, the server auto-places it. The daemon receives no user-supplied
argv, environment, or install command: it resolves and starts the host user's
login shell.

`POST /api/workspaces` accepts an optional name and optional
`first_session:{host_id,cwd,skill_ids}`. The atomic first session occupies the
full 12×12 canvas. Deleting a workspace kills and hard-deletes the sessions in
its tiles before deleting the workspace.

## WebSocket and DataChannel protocols

| Connection | URL / label | Required version | Purpose |
| --- | --- | --- | --- |
| Browser session signaling | `/ws/browser?session_id=<session UUID>` | WS subprotocol `spawn.v3` | RTC signaling and disclosed `session.status` / `session.exit`; no terminal-content fallback |
| Daemon control | `/ws/daemon` | WS subprotocol `spawn.control.v3` | registration, lifecycle, disclosed activity, agent availability, and RTC signaling |
| Browser host signaling | `/ws/host?host_id=<host UUID>` | WS subprotocol `spawn.host.v1` | RTC signaling for the host control channel |
| Session PTY | DataChannel `spawn.pty` | protocol version 2 | raw PTY bytes |
| Session control | DataChannel `spawn.ctl` | locked protocol version 1 | replay, viewport/display ownership, and session uploads |
| Host control | DataChannel `spawn.host.ctl` | protocol version 1 | host filesystem and host-scoped protected operations |

The daemon control frames implemented in `daemon/src/proto.rs` are:

| Direction | Frames |
| --- | --- |
| daemon → server | `register` (`existing_sessions`, optional `spec`), `host.heartbeat` (optional `cpu_bucket`/`mem_bucket`), `host.pong`, `session.started`, `session.exit`, `session.activity`, `session.input_activity`, `session.foreground`, `host.agents.check_result`, `host.agents.install_result`, `rtc.answer`, `rtc.candidate`, `rtc.status`, `error` |
| server → daemon | `registered`, `host.browser_pins`, `host.heartbeat`, `host.ping`, `host.agents.check`, `host.agents.install`, `session.create`, `session.restart`, `session.kill`, `rtc.offer`, `rtc.candidate`, `rtc.close` |

As implemented:

- RTC frames route a session by `scope_type:"session"` plus `scope_id`; there
  is no redundant process-record ID in the v3 signaling frame.
- `host.agents.check_result` returns its list under `agents`.
- Agent availability targets use `agent_id`, `agent_name`, `agent_kind`, and a
  server-derived first command word because those IDs describe CLI
  definitions, not sessions.
- The private worker wire remains protocol version 5. Its `Hello` serializes
  `session_id` and accepts the pre-overhaul key as a serde alias so the new
  daemon can adopt already-running workers.
- The `spawn.ctl` v1 field `agent_generation` and its related error codes are
  frozen compatibility vocabulary inside that locked DataChannel protocol.
  They name the session worker generation in current code.

`session.foreground` contains only the foreground executable basename: at
most 64 characters, no arguments, paths, titles, or output. It is emitted on
change at no more than once per second and stored as
`sessions.foreground_command` for pane/sidebar labeling and for whether the
pane header's agent switcher can switch.

## Workspace layout v2

```json
{
  "version": 2,
  "tiles": [
    {"session_id": "uuid", "x": 0, "y": 0, "w": 6, "h": 12}
  ]
}
```

The canvas is 12 columns × 12 rows. Geometry is integer-only; tiles remain in
bounds, have `w >= 3` and `h >= 3`, do not overlap, and use unique owned
session IDs. A workspace has at most eight tiles. On layout writes, the server
prunes missing, unowned, and duplicate session references before validating
the remaining geometry. Auto-placement returns HTTP 409 `workspace_full` when it cannot
legally add another tile.

The canonical algebra is implemented in `server/spawn_server/grid.py` and
`web/src/lib/grid.ts`; both consume `proto/layout-v3-fixtures.json`. Reading
order is `(y, x)` and drives the mobile stack and keyboard focus order.

## Web routes

| Route | Current content |
| --- | --- |
| `/` | signed-out marketing page; signed-in onboarding/workspace redirect and first-workspace creation |
| `/onboarding` | derived account → email verification (when enforced) → host → done flow |
| `/w/[id]` | main workspace grid |
| `/sessions/[id]` | full-page single session |
| `/login`, `/signup`, `/forgot-password`, `/reset-password`, `/verify-email` | account flows |
| `/device` | daemon device-code approval |
| `/hosts/[id]`, `/hosts/[id]/files` | host detail and full host file explorer |
| `/legion` | every host, its capacity, and what is running on it; optional live per-second figures over the host control channel |
| `/download`, `/security` | public product/support pages |
| `/admin` | administrator-only accounts, invites, and email operations |

Account, appearance, hosts, agents, skills, browser devices, and device trust
are tabs in the settings dialog opened from the app shell; they are not
standalone app routes. The profile is likewise a dialog rather than a route,
opened from the account menu in the sidebar footer, so it overlays a workspace
of live panes without detaching any of them.

Capacity resolution is deliberate and is documented in docs/TRUST.md: the
server holds a five-level bucket refreshed per heartbeat, the browser gets
exact figures directly from the daemon, and a host can decline both with
`SPAWND_NO_TELEMETRY=1` — which also removes `host.metrics` from the channel's
advertised capabilities, so an opted-out host is indistinguishable from an old
one.

The proposed endpoint-local protected-data design remains review-pending and
unimplemented; its pre-overhaul object model is retained in
`DURABLE_SENSITIVE_DATA.md` and requires redesign before runtime work.
