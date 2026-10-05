# Interaction surface matrix

This is the current implementation-backed contract between `web/`, `server/`,
and `daemon/`. `proto/README.md` remains the exhaustive wire reference.

## Product objects

| Object | Meaning | Database / REST / web |
| --- | --- | --- |
| Session | one login-shell PTY on a host | `sessions` / `/api/sessions` / `/sessions/[id]` or a workspace tile |
| Agent | launchable CLI definition used as a shortcut inside a session; not a process | `agents` / `/api/agents` / Settings → Agents |
| Workspace | named packed grid of session tiles | `workspaces` / `/api/workspaces` / `/w/[id]` |
| Host | paired machine running `spawnd` | `hosts` / `/api/hosts` / `/hosts` and `/hosts/[id]` |
| Skill | managed content materialized for an allowed session | `skills` / `/api/skills` / Settings → Skills |

## HTTP and direct-channel capabilities

| Capability | Web surface | HTTP surface | Web helper | Daemon/direct surface |
| --- | --- | --- | --- | --- |
| Onboarding configuration | `/onboarding`, auth pages | `GET /api/auth/config` → `{providers, email_verification_required, invite_only}` | `auth.config` | none |
| Account lifecycle | auth pages, Settings → Account | `/api/auth/signup`, `/api/auth/login`, `/api/auth/logout`, `/api/me`, `/api/account/delete`, recovery and verification routes under `/api/auth` | `auth.*`, `account.remove` | none |
| Pair a host | onboarding, `/device`, `/hosts` → Possess a host | `/api/auth/device/{start,possession,poll,pending,approve}` | `auth.pendingDevice`, `auth.approveDevice` | device-code login and possession proof |
| List/get/rename/delete hosts | sidebar Hosts strip, `/hosts`, `/hosts/[id]` | `GET /api/hosts`, `GET/PATCH/DELETE /api/hosts/{id}` | `hosts.list/get/rename/remove` | registration and presence over daemon WS |
| Check/install configured agents on a host | `/hosts/[id]` (checked when asked, never on a timer), Settings → Agents, session shortcut bar | `GET /api/hosts/{id}/agents`; `POST /api/hosts/{id}/agents/{agent_id}/install`; `PATCH /api/hosts/{id}/agents/{agent_id}/policy` | `hosts.agents/installAgent/updateAgentPolicy` | `host.agents.check` / `check_result`; `host.agents.install` / `install_result` |
| Recent session directories | none — the folder browser answers "where" now; the route and its client helper remain | `GET /api/hosts/{id}/recent-dirs` → `{dirs:[{path,last_used_at}]}` (newest first, max 8) | `hosts.recentDirs` | none |
| Host files | folder picker, file explorer | none; only signaling is server-mediated | `HostControlClient` | capability-rooted `spawn.host.ctl` `fs.*` requests and bounded streams |
| File transfers | Transfers tray: upload files or a folder, download a file or a folder as a zip, "Send to another host…" with a destination folder and a conflict policy (phone: the folder's ⋯ menu — Upload from Files…, Upload from Photos…, Send to another host… — and the selection bar's Send; a file's Download & Share…; progress, questions and Resume in the Transfers banner and sheet; no folder download yet) | none; never server-visible | `TransferEngine` over a per-host transfer consumer (`HostControlClient`); uploads and sends run in the tab holding the host's connection (`TransferHub`). Phone: `components/files/transfer-engine.ts` runs the app's one queue (`data/stores/transfers.ts`), driven once for the app by `TransfersRunner` over a channel of its own to each host (`transfer-pool.ts`); sends go through `HostTransport.transferFileTo` | `fs.list`, `fs.mkdir`, `fs.write.begin` (one file at a time per host), `fs.read.range` (downloads, resumable at a byte offset; `fs.read` where not advertised), `fs.read` + `fs.write.begin` relayed for sends (`transferFileTo`), `fs.stat`/`fs.read` to check a write whose commit was not confirmed. The phone uses the same operations, one file at a time across the app: `fs.mkdir` for a folder before what it holds, and `fs.stat` (or `fs.list` where not advertised) to settle a taken name |
| Host file previews | file explorer hover card and viewer dialog | none; never server-visible | `HostControlClient.readRange/previewImage` | `fs.read.range` bounded slice; `fs.preview` host-rendered PNG (macOS only, advertised per host) |
| Reveal / open a host file on its desktop | file row menu, viewer toolbar | none | `HostControlClient.reveal/openDefault` | `desktop.reveal` / `desktop.open`; path-only payload, allowlisted and rate-limited on the host (macOS only, advertised per host) |
| Agent transcript | pane/full-session **Transcript** action (mobile: terminal menu and pane sheet); list, view, download; Restart, to learn whether a Claude Code conversation has a record yet | none; never server-visible | `HostControlClient.agentTranscripts`, then `readFile`/`saveFileToBrowser` | `agent.transcripts` locates the harness's own files for the window's `agent_session_id`/`cwd` (Claude Code `.jsonl`, Codex rollout, aider history); each is read with `fs.read` (advertised per daemon; older daemons answer `unsupported_operation`) |
| Live conversation | Restart (pane, full session, mobile terminal menu and pane sheet) | none; never server-visible, except that a changed Claude Code id the host named is written back with `PATCH /api/sessions/{id}` `agent_session_id` (a Codex id never is) | `HostControlClient.inspectConversation` (web), `HostTransport.inspectConversation` (mobile) | `conv.inspect {session_id}` → `{agent, conversation_id, state, cli_version, live_elsewhere, source}`, read from the window's own process tree and Claude Code's `sessions/<pid>.json` registry; executes nothing. Advertised as the family capability `conv.v1`, on pair-admitted channels only (a legacy host channel answers `pair_required`); Linux and macOS daemons |
| List/create/get/rename/delete sessions | sidebar, workspace grid, `/sessions/[id]` | `GET/POST /api/sessions`, `GET/PATCH/DELETE /api/sessions/{id}`; list accepts only optional `host_id`; `status` may read `moving` (activity `moving`, label `Moving`) while a device carries the window's conversation; `DELETE` answers `409 move_in_progress` while it is moving | `sessions.*` | `session.create`, `session.kill` (to the host the row named as it was deleted: a move that landed first is followed); terminal over direct channels |
| Restart a session | sidebar, pane/full-session actions, the agent's own "Update installed · Restart to update" notice | `POST /api/sessions/{id}/restart`; `409 move_in_progress` while the window is moving, `409 move_conflict` when another device moved it first, and the same (or `404` for a window closed meanwhile) when either lands after the restart's commit and before its launch: nothing restarts, so nothing may be typed | `sessions.restart`; for an agent window the client queues the agent's resume command (`claude --resume <agent_session_id>`, or `--continue` when none was recorded; Codex `codex resume --last`) and types it the moment the fresh shell's transport opens. Where the host advertises `conv.v1` the id comes from `conv.inspect` first — the conversation the window is actually in after `/clear`, `/branch`, `/resume` or agent view, and for Codex `codex resume <id>` of the one rollout it holds open. When the host answers for the window's agent but names no conversation, the recorded id is not used in its place (`--continue`, `resume --last`); a recorded Codex id is never used. A conversation also held outside the window does not stop a restart: resuming a running background session attaches to it. Where the host also advertises `agent.transcripts`, a Claude Code id is first looked up there, on the same channel and within the same wait: one with no transcript yet (a window that has not had a message, or one just moved to this host) relaunches as `claude --session-id <id>`, a fresh conversation under the window's id; a host that cannot say keeps `--resume`. An id reaches a command line only as a canonical UUID, lower-cased: the server's record is not trusted with what a device types, so a recorded Claude Code id that is anything else is neither resumed nor `--continue`d — the agent starts as `claude --session-id <new UUID>`, which is written back — and a host answer or transcript naming a non-UUID id names none. The line comes from the relaunch module both clients carry byte for byte (web `lib/agent-relaunch.ts`, mobile `data/selectors/agent-relaunch.ts`, pinned by `proto/agent-note-vectors.json`), whose `canonicalConversationId` is the one id rule on each client; Restart asks it for no `--permission-mode` and no note, so the agent comes back on the same host in the mode its own conversation recorded. A move or an account switch will compose its line there too: a line that carries a conversation onto a host always with an explicit `--permission-mode`, while a move put back names none — it is a Restart on the host the window never left, so Claude Code comes back in the mode the window ran in there (`proto/README.md`, "Relaunch lines and move notes") | `session.restart` ends the worker (the process tree goes with its PTY) and starts a login shell in the stored `cwd`; the resume command is client-typed input like any launch. The write is a compare-and-set on the host it read, and the launch re-reads the row under the daemon's lifecycle lock and is withheld when the window has gone, begun moving or moved |
| Move a window to another host | pane where chip → **Where this runs**, or the pane menu's **Move to another host…** (phone: pane sheet → Move to another host…), then a confirmation that says the agent starts a new conversation — and why ("Codex can't bring its conversation to another host yet…"); a Claude Code window whose hosts carry conversations opens the Move dialog instead (Carry row below) | `POST /api/sessions/{id}/move` `{host_id, cwd, expected_host_id, agent_id?, agent_session_id?, carried?}`; `404` not yours (or closed before the launch went out), `400 same_host`, `409 target_offline`, `409 move_conflict`, `409 move_in_progress` (a fresh move of a window that is moving, or a move begun on the target before the launch went out), `409 workspace_archived` (a fresh move of a window in an archived workspace). Carried moves (web `sessions.moveBegin` / `sessions.moveAbort`, mobile `beginSessionMove` / `abortSessionMove`): `POST /api/sessions/{id}/move/begin` `{expected_host_id}` (`409 move_in_progress`, `move_conflict`, `source_offline`, `workspace_archived`, `404`), then `/move` with `carried: true` (`409 move_conflict` unless the window is moving from `expected_host_id`), or `POST /api/sessions/{id}/move/abort` `{expected_host_id}` (`409 move_conflict` once committed or aborted) | `sessions.move` / `moveSession`; the same row, so tile, name, skills, mutes and alert settings stay; terminals are keyed by the incarnation `${id}@${host_id}`, and only the moving device takes the display and types the agent's launch (fresh `--session-id`, with `agent_id` so a hand-started agent is recorded); a launch queued for the old incarnation is dropped | rebinds the row, then best-effort `session.kill` to the old host (its late frames fail the `host_id` fence; an old host that is offline is told to stop the worker when it registers again) and `session.restart` to the new one, withheld when another device acted on the window first; nothing of the conversation travels through the server. Begin marks the row `moving` and sends nothing; while it is moving its exits are recorded without an alert, it is never stopped at registration, and restart, delete, archive and a fresh move are refused. The carried commit is the same rebind; into an archived workspace it rebinds the window stopped and launches nothing. Abort puts the window back: `running` with no frame when no exit was recorded while it moved, else `killed` with the ordinary `session.kill` |
| Carry a conversation to another host | both clients, for a Claude Code window whose two hosts advertise `conv.v2` on this device's own connections — web: the where chip or the pane menu's **Move to another host…**; phone: the pane sheet's **Move to another host…** → **Where this runs**, which says "Claude Code's conversation comes with it where it can." It opens the Move dialog (phone: the move sheet): "Checking dream and mac…", what moves and what does not, the folder's branch and commit from `.git/HEAD`, a time estimate past 15 s, "Starts in <mode> ▾" (Claude Code's own mode names, chosen each time and never brought back from the record), Cancel · Start fresh instead · Move with conversation; what the import would refuse — the conversation open elsewhere or on the target, Claude Code not set up there, the folder missing there, a file over 512 MB — blocks before anything stops and offers Start fresh, as does a source that is offline. Progress over the pane (phone: a progress sheet that can be put away behind a toast with Show), a toast on landing, and banners for Claude Code's own questions once it starts there (never answered for the person). Every other tab and device shows "Moving to another host…" (the target named only by the device carrying it), attaches no terminal, and offers Resolve as the only lifecycle action. Resolve asks first ("Finish or put back this move?"); where a host cannot answer it offers **Give up the move** (the server's abort only, neither host touched; the phone's own progress sheet offers it too while a silent host holds the put-back), and where the conversation is on the target and the window is not, **Take the window to <host>**. A host's Overview lists its **Unfinished moves** (slot `moves`) with Resolve, on both. Every sentence is the same on both clients (web `lib/move/copy.test.ts` and mobile `move-copy.test.ts` pin the same table) | none; never server-visible — the server only learns that the window is moving and then places it (`POST /api/sessions/{id}/move/begin`, then `/move` with `carried: true` or `/move/abort`; the Move row above) | web `lib/move/` (orchestrator, carrier, resolver, `server.ts` for a carry that may only finish, hub — one tab runs a move, queues its relaunch and restarts it, by Web Lock claims; the screen classifier on `proto/claude-screen-vectors.json`); mobile `components/workspace-detail/` (`previewMove`, `MoveRun`, `resolveMove`, `giveUpMove`; the classifier `data/selectors/claude-screen.ts` on the same table) over `HostTransport`'s `conversation*` calls and `beginSessionMove` / `abortSessionMove`, with the resume line and note in the pending-launch store, provisional until the carried commit answers | `conv.v2` on pair-admitted channels of Linux and macOS daemons (D2): `conv.probe` (the target's folder, store, memory folder, copies already there, login shell, Claude Code version), `conv.export` (retire only — a snapshot copy is reserved for an owner-approved copies feature and refused: refuse while anything outside the window holds the conversation, stop the window and its Claude processes and confirm each by pid, move every copy out of Claude's lookup path, then stream the bundle), `conv.import.begin/status/cancel` (only what a retire carried; staged, verified, written 0600/0700 where the target chooses, other copies set aside, commit and cancel exclusive), `conv.retire.commit/abort` (the source's holding kept 30 days in `retired`, or put back), `conv.transfers` (what is unfinished); stream v2 with bulk paced per device connection, conversation bundle v1 (`proto/README.md`) |
| Session skill access | Settings → Skills and session access consumers | `GET/PATCH /api/sessions/{id}/access` | `sessionAccess.get/update` | skills are included in `session.create` / `session.restart` and materialized per session |
| List/create/get/update/delete workspaces | sidebar and `/w/[id]` | `GET/POST /api/workspaces`, `GET/PATCH/DELETE /api/workspaces/{id}`; `DELETE` answers `409 move_in_progress`, deleting nothing, while any of its windows is moving | `workspaces.*` | deleting a workspace best-effort kills every session referenced by its tiles, each on the host its row named as it was deleted |
| Archive / restore a workspace | sidebar Archived drawer, `/w/[id]` | `POST /api/workspaces/{id}/{archive,unarchive}`; archive answers `409 move_in_progress`, stopping nothing, while any of its windows is moving | `workspaces.archive/unarchive` | archiving stops every session (each killed on the host its row names as it is stopped) and keeps the rows, layout and sidebar slot; restoring restarts the same sessions in place, leaving a moving one to its move; nothing moves into running in an archived workspace |
| Manage agent definitions | Settings → Agents, shortcut bar | `GET/POST /api/agents`, `PATCH/DELETE /api/agents/{id}` | `agents.*` | definitions are typed into the shell; built-ins are immutable through write routes |
| Yolo mode (skip an agent's permission prompts) | Settings → Agents, one switch per agent | `PATCH /api/agents/{id}/preferences` → `{yolo}`; the spelling rides on `AgentOut` as `yolo_args`/`yolo_env` | `agents.setPreferences`, `agentRunCommand` | per user, not per definition (`agent_preferences`), so the switch is live on read-only built-ins; folded into the command the browser types, never a hidden launch flag |
| Manage skills | Settings → Skills | `GET/POST /api/skills`, `PATCH/DELETE /api/skills/{id}` | `skills.*` | materialized into the session environment/config root |
| Browser devices and trust | Settings → Access | `/api/browser-devices/*`, `/api/trust/{bundle,passkeys,endorsements,hosts/.../pins}` | `browserDevices.*`, `trust.*` | signed signaling and daemon-local browser pins |
| Host capacity | sidebar Hosts strip, `/hosts`, profile dialog | on `GET /api/hosts`: static spec (`cpu_cores`, `cpu_physical_cores`, `cpu_model`, `memory_bytes`, `gpu`) plus `cpu_bucket`/`mem_bucket` in `0..=5` and `capacity_at`; buckets are withheld for an offline host | `summarizeFleet`, `useHostCapacity` (every 3 s, only for a host card on screen in a tab in front) | spec on `register`; buckets on `host.heartbeat`; **exact** figures only over `spawn.host.ctl` `host.metrics`, never server-visible. `SPAWND_NO_TELEMETRY=1` disables all three |
| Profile and activity history | account menu → Profile | `GET /api/profile` → identity, `totals`, `agents`, sparse `days`, `hosts`, `history_days`, `today` | `profile.get`, `calendar` | none — read from `legion_days`, an append-only per-owner-per-day counter table written beside the existing lifecycle writes |
| Terminal input/output | workspace/session terminal | none | `useSessionSocket`, `LiveTerminalProvider` | ordered reliable `spawn.pty` DataChannel direct to the endpoint |
| Alerts on agent completion | Settings → Notifications, pane menu → Mute alerts | none; delivered over `/ws/alerts` (owner-scoped, subprotocol `spawn.alerts.v1`) | `subscribeToAlerts`, `useSessionAlerts`, `notify-prefs` | transitions are detected beside the lifecycle writes in `ws/daemon.py`; the daemon gains no new frame |
| Replay, resize, display ownership, upload | workspace/session terminal | none | `spawn.ctl` client | ordered reliable locked `spawn.ctl` v1 DataChannel direct to the endpoint |

`POST /api/sessions` accepts `host_id`, `cwd`, optional `name`, optional
`skill_ids`, and optional `workspace_id` plus `tile`. With a workspace and no
explicit tile, the server auto-places it. A workspace's windows may run on
any mix of hosts; creating one never writes a host or folder back onto the
workspace, and an unnamed window stays unnamed (`name` null). The daemon receives no user-supplied
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

`spawn.host.ctl` advertises what a daemon can do in its `hello`. A new
operation family is one versioned capability for the whole family, never a
name per operation, and a revision that adds operations is a new name:
`conv.v1` is `conv.inspect`, `conv.v2` adds the carrier, and a daemon that
carries advertises both. Families that
carry a device's intent — `conv.*`, then `session.launch.*`,
`agent.accounts.*`, `screen.*`, `box.*` — are answered only on channels
admitted through an authenticated device pair; a legacy protocol-1 host
channel neither advertises them nor answers them (`pair_required`).

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
| `/hosts` | every host, its capacity, and what is running on it; exact figures over the host control channel for the cards on screen |
| `/hosts/[id]`, `/hosts/[id]/files`, `/hosts/[id]/sessions`, `/hosts/[id]/access` | a host's page, one address per section: Overview (exact load while on screen, the machine, what runs there and its folders, agent availability when asked), Files (the host's file explorer; the folder on screen is never in the URL — kept in the tab's `history.state`, handed over in memory by in-app links; an inbound `?path=` is read once and dropped), Sessions (its windows by workspace), Access (approving devices and the host's identity); "New window here…" opens a window on it. Further sections appear only for a host that advertises their capability family (`web/src/lib/host-offers.ts`; the phone's `mobile/src/data/selectors/host-offers.ts` keeps the same slots): Unfinished moves (`moves`, `conv.v2`) is the first |
| `/legion` | redirect to `/hosts` (the page's name before the rename) |
| `/download`, `/security` | public product/support pages |
| `/admin` | administrator-only accounts, invites, and email operations |

Account, appearance, notifications, agents, skills, workspace templates, and
access (browser devices and device trust) are tabs in the settings dialog
opened from the app shell; they are not standalone app routes. Hosts are not a
setting: they have the `/hosts` page. The profile is likewise a dialog rather
than a route, opened from the account menu in the sidebar footer, so it
overlays a workspace of live panes without detaching any of them.

Capacity resolution is deliberate and is documented in docs/TRUST.md: the
server holds a five-level bucket refreshed per heartbeat, the browser gets
exact figures directly from the daemon, and a host can decline both with
`SPAWND_NO_TELEMETRY=1` — which also removes `host.metrics` from the channel's
advertised capabilities, so an opted-out host is indistinguishable from an old
one.

The proposed endpoint-local protected-data design remains review-pending and
unimplemented; its pre-overhaul object model is retained in
`DURABLE_SENSITIVE_DATA.md` and requires redesign before runtime work.
