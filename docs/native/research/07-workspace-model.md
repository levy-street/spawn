# R07 — Workspaces, tabs, sessions, agents: data model, lifecycle and UI semantics
- TL;DR 1/10 — A workspace is a UUID-backed server row, but tabs, pane membership, pane order, file widgets, tab homes, and desktop geometry all live inside one version-3 `layout` JSON value.
- TL;DR 2/10 — Tabs and panes are not server tables and have no CRUD endpoints: every tab or pane mutation is a whole-envelope `PATCH /api/workspaces/{id}`, with no revision or compare-and-swap field.
- TL;DR 3/10 — A terminal row must derive its type/logo from daemon-reported `foreground_command`, its name from `session.name`, and its status from process/activity; agent definitions are launch shortcuts, not running-process records.
- TL;DR 4/10 — The four built-ins are Claude Code, Codex, OpenCode, and Aider Sonnet; custom definitions are allowed, and unknown kinds/commands use a first-letter monogram.
- TL;DR 5/10 — Process status, activity status, host presence, terminal transport, and alerts are independent dimensions; never overwrite one with another. Dead process wins attention precedence over waiting.
- TL;DR 6/10 — Activity is server-derived: output ≤3 s is active, user input newer than output is input-sent, output ≥8 s is awaiting input, the interval between is quiet, and no output becomes quiet after 8 s.
- TL;DR 7/10 — Phone UI should render each tab as a reading-order list, never the web mobile grid, but it must preserve every v3 tile rectangle and widget payload so desktop web remains compatible.
- TL;DR 8/10 — Explicit mobile row reordering necessarily rewrites desktop geometry because no independent list-order field exists; the reference helper stacks up to six rows and otherwise reassigns existing rectangles.
- TL;DR 9/10 — The only enforced capacity ceilings are 8 tabs and 16 valid tiles per tab; host CPU/memory telemetry and `session_count` are displays, not launch quotas.
- TL;DR 10/10 — Agent launch is a two-stage flow: create a login-shell session, then type the constructed command through its live terminal; the pending command is currently memory-only and is lost on reload/app death.

## Scope and authoritative model

This report treats the desktop data/protocol behavior as authoritative and deliberately does not copy the existing responsive grid presentation. The core hierarchy is:

```text
Workspace row (server)
└── layout: LayoutV3 JSON (server field, replaced as a unit)
    ├── ordered WorkspaceTab value (not a row)
    │   └── GridLayout v3
    │       ├── Tile -> Session UUID -> PTY Session row
    │       └── Tile -> files Widget payload (no Session row)
    └── active_tab (a persisted hint, not live cross-device navigation state)

Agent row = a command shortcut definition
foreground_command on Session = daemon's observation of what is actually running
```

The browser's literal envelope types are the clearest compact contract:

```ts
export interface WorkspaceTab {
  id: string;
  name: string;
  host_id?: string | null;
  cwd?: string | null;
  layout: GridLayout;
}

export interface LayoutV3 {
  version: 3;
  active_tab: string | null;
  tabs: WorkspaceTab[];
}

export interface TileWidget {
  kind: "files";
  host_id: string;
  path: string;
}

export interface Tile {
  session_id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  widget?: TileWidget;
}
```

These are literal client definitions, including the optional TypeScript tab-home keys. The wire decoder defaults both home values to `null`, and the server requires at least one and at most eight tabs. A widget tile's `session_id` is its own identity, not a foreign key. (web/src/lib/tabs.ts:14-42; web/src/lib/grid.ts:35-59; web/src/lib/api.ts:318-354; server/spawn_server/schemas.py:777-866)

## Entity reference

### Workspace

Literal client schema:

```ts
{
  id: UUID;
  name: string;
  host_id: UUID | null;        // default null
  cwd: string | null;          // default null
  layout: LayoutV3;
  position: integer;           // client decode default 0
  icon: string | null;         // default null
  icon_source: "auto" | "custom" | "none" | null; // default null
  archived_at: ISODate | null; // default null
  created_at: ISODate;
  updated_at: ISODate;
}
```

(web/src/lib/api.ts:356-384)

| Wire/client field | Server/DB field | Type, optionality and default | Semantics |
|---|---|---|---|
| `id` | `Workspace.id` | required UUID string; DB `String(36)`, generated UUID | Stable workspace identity. |
| `name` | `Workspace.name` | required string; DB max 128 | User-facing name. Explicit duplicates are permitted. |
| `host_id` | `Workspace.host_id` | nullable UUID; DB FK to host, `SET NULL` on host delete | Workspace default host. It is meaningful as a pair with `cwd`. |
| `cwd` | `Workspace.cwd` | nullable string; request/server max 1024 | Workspace default directory. |
| `layout` | `Workspace.layout` | required JSON; DB default empty object for legacy construction; API always emits normalized v3 | Ordered tabs, pane membership, widgets, rectangles and persisted active-tab hint. |
| `position` | `Workspace.position` | integer ≥0 on patch; DB/client default 0 | Contiguous ordering among active workspaces only. |
| `icon` | `Workspace.icon` | nullable string | Self-contained PNG/WebP base64 data URL; null means draw initials. |
| `icon_source` | `Workspace.icon_source` | `auto/custom/none/null` | Null means not examined; auto means discovered; custom means user choice or deliberate clear; none means scan completed without a usable icon. |
| `archived_at` | `Workspace.archived_at` | nullable ISO datetime | Null is active; set means archived/stopped. |
| `created_at` | `Workspace.created_at` | required ISO datetime; DB default now | Creation time. |
| `updated_at` | `Workspace.updated_at` | required ISO datetime; DB default/on-update now | Last workspace-row/layout mutation time. |
| hidden | `owner_user_id` | required UUID FK, indexed | Ownership is enforced server-side and omitted from `WorkspaceOut`. |

The DB declaration and API schema agree on field names. The DB comment saying “12x12” is stale; its adjacent layout comment and the actual contract are v3 tabs over 24×24 v3 grids. The same stale wording appears in the route module. (server/spawn_server/models.py:594-643; server/spawn_server/routes/workspaces.py:1-38; web/src/lib/grid.ts:23-33)

Workspace icon constraints are part of the entity contract: at most 32 KiB of characters and exactly a `data:image/png;base64,...` or `data:image/webp;base64,...` URL. The client rasterizes candidates to 128, 96, or 64 pixels, attempting WebP then PNG, and preserves transparency. Source images over 4 MiB are not pulled from a host. (server/spawn_server/schemas.py:733-774; web/src/lib/workspace-icon.ts:16-26; web/src/lib/workspace-icon.ts:293-300; web/src/lib/workspace-icon-image.ts:29-44; web/src/lib/workspace-icon-image.ts:69-133)

### Tab

A tab has no database model and no endpoint. It is one ordered value in `Workspace.layout.tabs`. The server-side name is `WorkspaceTab` only as a Pydantic validation type. (server/spawn_server/schemas.py:835-866; server/spawn_server/routes/workspaces.py:409-423)

| Field | Type/default | Server rule | Meaning |
|---|---|---|---|
| `id` | string, required | length 1–64; unique within envelope | Identity used by `active_tab` and navigation. New client tabs use UUID strings, but the migrated/default tab is literal `tab-1`. |
| `name` | string, required | length 1–64; non-empty | Display name; uniqueness is not required. |
| `host_id` | string/null; TS key optional; wire default null | Owned host or pruned to null on the next layout write | Tab-specific default host. |
| `cwd` | string/null; TS key optional; wire default null | max 1024; paired with `host_id` or both become null | Tab-specific default directory. |
| `layout` | `GridLayout`, required | v3; validated grid | Its terminal/widget membership and desktop rectangles. |

The server's deterministic initial value is:

```json
{
  "version": 3,
  "active_tab": "tab-1",
  "tabs": [{
    "id": "tab-1",
    "name": "Tab 1",
    "host_id": null,
    "cwd": null,
    "layout": { "version": 3, "tiles": [] }
  }]
}
```

(server/spawn_server/routes/workspaces.py:31-55)

Tab home resolution is exactly “complete tab pair, else complete workspace pair, else no home.” A half-pair does not resolve. (web/src/lib/tabs.ts:88-110; server/spawn_server/routes/workspaces.py:174-187)

### Session / terminal pane

Literal client schema:

```ts
{
  id: UUID;
  name: string | null;              // decode default null
  host_id: UUID;
  host_name: string | null;         // response join, default null
  cwd: string;
  status: "starting" | "running" | "exited" | "killed";
  started_at: ISODate;
  exited_at: ISODate | null;
  exit_code: integer | null;
  last_output_at: ISODate | null;    // default null
  last_input_at: ISODate | null;     // default null
  last_activity_at: ISODate | null;  // derived, default null
  activity_state:
    | "starting" | "active" | "quiet" | "waiting"
    | "input_sent" | "exited" | "killed" | "unknown";
  activity_label: string;            // decode default "Unknown"
  foreground_command: string | null; // default null
}
```

(web/src/lib/api.ts:234-256)

| Wire/client field | Server/DB field | Type/default | Production/meaning |
|---|---|---|---|
| `id` | `Session.id` | UUID string; DB generated | PTY/session identity and normal tile `session_id`. |
| `name` | `Session.name` | nullable string; max 128 | Explicit display name. Server creation fills a default even when request omitted; rename can clear it back to null. |
| `host_id` | `Session.host_id` | required UUID FK | Owning machine. |
| `host_name` | derived response join | nullable string | Current host name, not stored on Session. |
| `cwd` | `Session.cwd` | required string; DB max 1024 | Login shell working directory. |
| `status` | `Session.status` | raw DB string max 16, default `starting` | Client narrows known wire values to four literals. |
| `started_at` | `Session.started_at` | datetime, DB default now | Reset on restart/unarchive. |
| `exited_at` | `Session.exited_at` | nullable datetime | Written on exit/stop; reset on restart. |
| `exit_code` | `Session.exit_code` | nullable integer | Daemon exit code; signal exits may have null code. |
| `last_output_at` | `Session.last_output_at` | nullable datetime | Stamped from daemon's content-free meaningful-output activity ping. |
| `last_input_at` | `Session.last_input_at` | nullable datetime | Stamped from daemon's throttled content-free input ping. |
| `last_activity_at` | response-only derived | nullable datetime | Maximum of output, input, exit and start timestamps. |
| `activity_state` | response-only derived | string; client default unknown | Derived from status and timestamp windows on every read. |
| `activity_label` | response-only derived | string; client default Unknown | Human label paired with activity state. |
| `foreground_command` | `Session.foreground_command` | nullable string; DB max 255, server truncates observation to 64 | Basename only of daemon-observed foreground process. Cleared on exit/restart/archive. |
| hidden | `owner_user_id` | required UUID FK | Ownership, omitted from output. |

The server-side schema deliberately leaves `status` and `activity_state` as unconstrained strings while the client narrows them. Unknown non-running status values are echoed as the activity state and title-cased label, so native parsing should retain an unknown-string escape hatch rather than crash. (server/spawn_server/schemas.py:696-728; server/spawn_server/routes/sessions.py:58-91)

The actual persistent row contains no `last_activity_at` or `activity_*` fields; those are response projections. It also contains no workspace ID, tab ID, tile geometry, agent ID, connection state, unread count, or viewer state. Membership comes only from layouts; agent identity comes from foreground observation; transport/viewer state is live. (server/spawn_server/models.py:444-472; server/spawn_server/schemas.py:712-728)

“Pane” is a UI/layout concept, not another entity: a session pane is a `Tile` without `widget`; a widget pane is a `Tile` with `widget`. A Session can also exist standalone with no workspace tile because `workspace_id` is optional at creation and there is a standalone route. (server/spawn_server/schemas.py:696-705; web/src/app/sessions/[id]/page.tsx:8-16)

### Widget

Only one widget kind exists:

```ts
type TileWidget = {
  kind: "files";
  host_id: string;
  path: string;
};
```

There is no Widget table, lifecycle process, API resource, or status value. A widget's containing tile uses a fresh UUID-like `session_id` as its widget/pane identity. The payload is serialized only when non-null; normal session tile JSON does not gain a `widget: null` key. (web/src/lib/grid.ts:35-54; server/spawn_server/schemas.py:777-811)

The web title is “Files — {leaf-or-path}”; operational availability is inherited from the referenced Host and the file browser connects over host control. The layout server retains widgets without checking a Session row, but still enforces ID uniqueness across the whole workspace. (web/src/components/workspace/widget-pane.tsx:28-71; server/spawn_server/routes/workspaces.py:119-173)

### Agent definition

Literal client type:

```ts
type Agent = {
  id: UUID;
  owner_user_id: UUID | null; // null = immutable built-in
  name: string;
  kind: string;
  command: string;
  env: Record<string, string>; // default {}
  install?: string | null;
  yolo_args: string | null;    // default null
  yolo_env: Record<string, string>; // default {}
  yolo: boolean;               // per-reading-user preference, default false
};
```

(web/src/lib/api.ts:258-290)

| Field | DB/server rule | Meaning/divergence |
|---|---|---|
| `id` | UUID String(36) | Definition identity, not a process identity. |
| `owner_user_id` | UUID/null | Null is built-in and immutable; non-null is a custom definition owned by that user. |
| `name` | required, trimmed, max 128 | Display name; unique per owner at DB level. |
| `kind` | required, trimmed, max 64 | Identity/icon hint; arbitrary for custom definitions. |
| `command` | required, trimmed, max 1024 | Full visible shell command typed to launch. |
| `env` | JSON string map, default empty | Prefix variables for launch. |
| `install` | nullable, max 2048 | Visible install command offered when absent on a host. |
| `yolo_args` | nullable, max 256 | Permission-bypass arguments appended only if user's preference is on. |
| `yolo_env` | JSON string map, default empty | Permission-bypass env merged over `env` only if on. |
| `yolo` | response projection from `AgentPreference`; default false | Per-user choice; not stored on the Agent row. |

(server/spawn_server/schemas.py:591-635; server/spawn_server/models.py:361-386; server/spawn_server/routes/agents.py:39-59)

Host availability is a separate response whose field is deliberately `agent_kind`, not `kind`:

```ts
type HostAgentStatus = {
  agent_id: string;
  agent_name: string;
  agent_kind: string;
  command: string;               // binary checked on host
  install: string | null;
  installed: boolean;
  path: string | null;
  version: string | null;
  latest_version: string | null;
  update_available: boolean | null;
  error: string | null;
  auto_update: boolean;
  last_checked_at: ISODate | null;
  last_auto_update_at: ISODate | null;
  last_auto_update_error: string | null;
};
```

The server derives `command` as the first shell word and asks the connected daemon. An offline daemon yields 409; a timed-out check yields 504. (server/spawn_server/schemas.py:526-579; server/spawn_server/routes/hosts.py:92-108; server/spawn_server/routes/hosts.py:479-500)

### Host

Literal client schema:

```ts
type Host = {
  id: UUID;
  name: string;
  os?: string | null;
  arch?: string | null;
  version?: string | null;
  host_key_algorithm?: "ed25519" | null;
  host_public_key?: string | null;
  host_key_fingerprint?: string | null;
  status: "online" | "offline";
  last_seen_at: ISODate | null;
  session_count: number;
  cpu_cores: number | null;
  cpu_physical_cores: number | null;
  cpu_model: string | null;
  memory_bytes: number | null;
  gpu: string | null;
  cpu_bucket: 0 | 1 | 2 | 3 | 4 | 5 | null;
  mem_bucket: 0 | 1 | 2 | 3 | 4 | 5 | null;
  capacity_at: ISODate | null;
};
```

(web/src/lib/api.ts:79-106)

| Field | Server/DB details |
|---|---|
| `id` | UUID String(36), generated. |
| `name` | required, DB max 128; rename field max 128. |
| `os/arch/version` | nullable, DB max 64; refreshed from accepted daemon registration when present. |
| `host_key_algorithm/public_key` | nullable immutable pairing identity; valid new pair is Ed25519 and a 43-character public key. |
| `host_key_fingerprint` | response-only derivation; not a DB column. |
| `status` | DB raw string default `offline`; client narrows to online/offline. |
| `last_seen_at` | nullable; set on accepted activation, each heartbeat, and disconnect/offline transition. |
| `session_count` | response-only count of every owned Session row on that host, including exited/killed rows. It is not “live sessions.” |
| `cpu_cores/cpu_physical_cores/cpu_model/memory_bytes/gpu` | nullable machine specification from daemon registration. |
| `cpu_bucket/mem_bucket` | nullable five-segment heartbeat meter values, integers 0–5, not percentages. Suppressed to null in response while host is offline. |
| `capacity_at` | nullable heartbeat timestamp; remains available even if response buckets are suppressed. |
| hidden ownership/fencing | `owner_user_id` and daemon connection/generation fields are stored but not emitted. |

(server/spawn_server/models.py:230-323; server/spawn_server/routes/hosts.py:60-119; server/spawn_server/schemas.py:423-448)

Exact CPU percentage and memory usage are live host-control data rather than Host fields: `cpu_percent`, `memory_used_bytes`, `memory_total_bytes`, optional `load_one` and `uptime_seconds`. (web/src/lib/hostControl.ts:54-77)

### Workspace template

Literal client shapes:

```ts
type TemplateRun =
  | { kind: "shell"; command?: null }
  | { kind: "agent"; command: string }
  | { kind: "files"; command?: null };

type TemplateTile = {
  x: number; y: number; w: number; h: number;
  run: TemplateRun;
};

type WorkspaceTemplateSpec = {
  version: 2;
  tabs: Array<{ name: string; tiles: TemplateTile[] }>; // 1..8
};

type WorkspaceTemplate = {
  id: UUID;
  name: string;
  host_id: UUID | null;
  cwd: string | null;
  spec: WorkspaceTemplateSpec;
  icon: string | null;
  icon_source: "auto" | "custom" | "none" | null;
  created_at: ISODate;
  updated_at: ISODate;
};
```

(web/src/lib/api.ts:836-878)

| Field | Server rule/default |
|---|---|
| `id` | UUID String(36), generated. |
| `name` | required, trimmed, 1–128; not unique. |
| `host_id` | nullable owned Host FK, `SET NULL` on delete. |
| `cwd` | nullable, max 1024; required and non-empty when host ID is supplied. |
| `spec.version` | literal 2. This is template-spec v2 and is independent of layout/grid v3. |
| `spec.tabs` | 1–8 ordered tabs; names 1–64. |
| `tiles` | maximum 16 per tab; same 24×24 non-overlap geometry validation. |
| `run.kind` | shell, agent, or files. Only agent may carry a non-empty command, max 512. |
| `icon/icon_source` | same validation and semantics as Workspace. |
| timestamps | DB default/on-update times. |
| hidden | `owner_user_id` required, omitted from response. |

(server/spawn_server/schemas.py:920-1011; server/spawn_server/models.py:646-677; server/spawn_server/routes/workspace_templates.py:22-50)

The model docstring saying templates have “no folder or host” and its version-1 JSON comment are stale: the actual model has `host_id`/`cwd` and the accepted/emitted spec is version 2, with v1 coordinates lifted by a factor of two. (server/spawn_server/models.py:646-666; server/spawn_server/schemas.py:948-984)

## Schema divergences and invariants to preserve

1. Client `TileSchema.session_id` validates a UUID, but the shared grid algebra and server schema accept any non-empty string. Fixture IDs such as `a` prove that ID format is not part of grid validation. Real Session IDs and newly generated widget IDs are UUIDs, so native should generate UUID widgets but must not reject a pre-existing non-UUID layout ID before server policy has a chance to prune it. (web/src/lib/api.ts:325-337; proto/layout-v3-fixtures.json:4-6; server/spawn_server/schemas.py:787-810)
2. Tab IDs are arbitrary 1–64-character strings, not universally UUIDs. New web tabs use `crypto.randomUUID()`; legacy/default tab ID is `tab-1`. (server/spawn_server/schemas.py:835-850; web/src/components/workspace/workspace-tabs.tsx:602-607; server/spawn_server/routes/workspaces.py:36-55)
3. A Session has no workspace/tab foreign key. The first occurrence of a Session ID across all layout tabs wins during prune; later duplicates are removed. (server/spawn_server/routes/workspaces.py:119-173)
4. A GET parses/migrates malformed/legacy layout shape but does not run ownership pruning. Pruning happens on layout validation/writes and session creation into a workspace; therefore a read can temporarily contain a dead tile whose Session row is absent. (server/spawn_server/routes/workspaces.py:62-103; server/spawn_server/routes/workspaces.py:190-220; server/spawn_server/routes/sessions.py:301-309)
5. Layout PATCH is a replacement, has no revision/ETag/expected-version property, and is therefore last-writer-wins across devices. This follows from `WorkspacePatch.layout` plus the direct assignment in the route. (server/spawn_server/schemas.py:890-897; server/spawn_server/routes/workspaces.py:409-449)
6. An archived Workspace retains Session rows and tile IDs but stops their processes. Deleting it hard-deletes referenced Session rows. (server/spawn_server/routes/workspaces.py:455-489; server/spawn_server/routes/workspaces.py:561-579)

**RECOMMEND:** model `UUID` as a branded string for resource IDs, but keep `TabId` and `PaneId` as opaque strings at decode boundaries. Generate UUIDs for new tabs/widgets without narrowing historical input.

**RECOMMEND:** keep unknown server status/activity strings in normalized domain state alongside known discriminants. The Python response models are intentionally open strings even though the current web Zod decoder is narrower.

## Status model

### Five independent dimensions

The UI must not flatten these prematurely:

1. **Process lifecycle** — persistent `Session.status`: starting, running, exited, killed.
2. **Process activity** — response-derived `activity_state` and timestamps.
3. **Host presence** — persistent/heartbeat-derived online or offline.
4. **Viewed terminal transport** — live signaling socket, DataChannel, network path and trust.
5. **Attention/notification** — current waiting/dead derivation and event delivery.

A running Session can remain `running` while its Host is offline; losing a browser DataChannel also does not mutate process status. Conversely, an exited process can be viewed through a still-open signaling connection long enough to receive its exit frame. The code maintains these as separate sources. Host disconnect writes only Host status; browser transport state lives in the terminal hook; daemon exit writes Session status. (server/spawn_server/ws/daemon.py:493-507; server/spawn_server/ws/daemon.py:1724-1785; web/src/components/terminal/useSessionSocket.ts:105-118)

### Process status values and producers

| `Session.status` | Produced by | Label/activity precedence | Dot |
|---|---|---|---|
| `starting` | DB/create row default; reset by restart; reset for online-host sessions on unarchive | Activity is always `starting` / “Starting,” regardless of timestamps | waiting/info-blue |
| `running` | accepted daemon `session.started` frame | Timestamp formula below | active/waiting/idle according to activity |
| `exited` | daemon `session.exit` with no signal | Always `exited` / “Exited” | offline |
| `killed` | daemon `session.exit` with a signal; immediate server write on archive stop | Always `killed` / “Killed” | offline |
| other raw string | possible at Python/DB boundary | Same string as state, underscores replaced and title-cased as label | idle if raw status is running; otherwise offline |

Creation inserts `status="starting"` before commit and dispatch. (server/spawn_server/routes/sessions.py:157-184; server/spawn_server/routes/sessions.py:269-334)

`session.started` is accepted only for the currently fenced daemon owner, then writes `running` and publishes `{"type":"session.status","status":"running"}`. (server/spawn_server/ws/daemon.py:1497-1549)

`session.exit` writes `killed` if `signal` is truthy, otherwise `exited`; it writes exit code/time and clears foreground command. (server/spawn_server/ws/daemon.py:1724-1785)

Restart requires a live daemon broker connection, resets start/exit/output/input/foreground fields, keeps the same Session ID, cwd, name, host and skill access, then dispatches `session.restart`. (server/spawn_server/routes/sessions.py:337-376)

Archive uses best-effort `{"type":"session.kill","session_id":id,"signal":"TERM"}`, detaches routing, and immediately writes killed even if the host is unreachable. (server/spawn_server/routes/sessions.py:379-405)

### Activity-state formula and exact precedence

Server constants are:

```py
ACTIVE_OUTPUT_WINDOW = timedelta(seconds=3)
WAITING_OUTPUT_WINDOW = timedelta(seconds=8)
```

(server/spawn_server/routes/sessions.py:18-22)

For one read at time `now`:

```text
if status == starting -> ("starting", "Starting")
if status == exited   -> ("exited",   "Exited")
if status == killed   -> ("killed",   "Killed")
if status != running  -> (status, title_case(status))

if last_output_at is null:
    if now - started_at >= 8s -> ("quiet", "Quiet")
    else                      -> ("starting", "Starting")
else if now - last_output_at <= 3s:
    -> ("active", "Active")             // wins even if input is newer
else if last_input_at > last_output_at:
    -> ("input_sent", "Input sent")
else if now - last_output_at >= 8s:
    -> ("waiting", "Awaiting input")
else:
    -> ("quiet", "Quiet")                // strictly between 3s and 8s
```

The server computes `last_activity_at = max(last_output_at, last_input_at, exited_at, started_at)`. (server/spawn_server/routes/sessions.py:40-91)

Producers:

- The daemon emits a content-free `session.activity` signal after classifying meaningful output; the server stamps `last_output_at` and rearms the quiet alert timer without receiving terminal bytes. (server/spawn_server/ws/daemon.py:1552-1595)
- The daemon emits a throttled content-free `session.input_activity`; the server stamps `last_input_at` and cancels, rather than rearms, the quiet alert timer. (server/spawn_server/ws/daemon.py:1596-1642)
- The daemon emits `session.foreground` with only a process basename. The server strips paths, truncates to 64 characters, writes `foreground_command` and uses the transition for agent-finished alerts. (server/spawn_server/ws/daemon.py:1644-1722)

### Status dot, label and color mapping

The canonical tone function is:

```ts
switch (session.activity_state) {
  case "active": return "active";
  case "waiting":
  case "input_sent":
  case "starting": return "waiting";
  case "quiet": return "idle";
  default: return session.status === "running" ? "idle" : "offline";
}
```

(web/src/lib/sessions.ts:56-68)

| Tone | Light token | Dark token | Meaning/animation |
|---|---|---|---|
| active | `oklch(0.6 0.16 152)` | `oklch(0.74 0.17 152)` | output/online; Session dot pulses only while `activity_state==="active"` |
| waiting | `oklch(0.6 0.13 240)` | `oklch(0.72 0.13 235)` | waiting, input sent or starting; dot itself does not pulse |
| idle | `oklch(0.6 0 0)` | `oklch(0.68 0 0)` | running quiet |
| offline | `oklch(0.78 0 0)` | `oklch(0.44 0 0)` | exited/killed/host offline |

(docs/DESIGN.md:122-133; web/src/components/ui/status.tsx:5-17; web/src/components/ui/status.tsx:53-62)

Dots are 8 px, circular; Session dots have a card-colored border. The accessible label is `activity_label` and the title adds relative age from `last_activity_at`. (web/src/components/ui/status.tsx:19-62; web/src/lib/sessions.ts:42-53)

Waiting attention badges use the separate warning family, not the blue waiting dot: light `oklch(0.55 0.13 75)`, dark `oklch(0.78 0.14 80)`, with translucent soft fill. (docs/DESIGN.md:87-105)

There is no separate status icon per Session state. The pane combines its Agent icon plate with a small overlaid status dot. Native list rows should do the same. (web/src/components/workspace/session-pane.tsx:320-335)

### Attention precedence and badge counts

Exact function:

```ts
function sessionNeedsAttention(session): "waiting" | "dead" | null {
  if (session.status === "exited" || session.status === "killed") return "dead";
  if (session.activity_state === "waiting") return "waiting";
  return null;
}
```

(web/src/lib/sessions.ts:86-91)

Therefore **dead wins over waiting** if inconsistent signals arrive. `input_sent`, `quiet` and `starting` are not attention states even though starting/input-sent share the blue waiting tone. Per-tab and per-workspace badges count every non-widget session for which this function is non-null. (web/src/lib/workspaces.ts:59-77)

### Host status

| Value | Producer | UI |
|---|---|---|
| online | Accepted, fenced daemon activation writes status and last-seen | active green dot, label “online”; launch/folder choices enabled |
| offline | DB default; owning daemon disconnect/final cleanup writes offline and last-seen | offline gray dot, label “offline”; launch/folder choices disabled |

(server/spawn_server/models.py:230-245; server/spawn_server/ws/daemon.py:192-226; server/spawn_server/ws/daemon.py:1969-2006; web/src/components/ui/status.tsx:15-17; web/src/components/workspace/new-session-menu.tsx:197-232)

Heartbeats update `last_seen_at` and optional 0–5 meter buckets but do not change Session status. Offline host responses suppress the old meter buckets because they are stale, while retaining hardware spec. (server/spawn_server/ws/daemon.py:466-490; server/spawn_server/routes/hosts.py:60-89)

### Terminal connection status

This exists only for a mounted/viewed terminal, as live `SessionConnectionInfo`:

```ts
type SocketState = "idle" | "connecting" | "open" | "closed" | "error";

type SessionConnectionInfo = {
  socketState: SocketState;
  v3: boolean;
  dcOpen: boolean;
  kind: "direct" | "stun" | "relay" | null;
  rttMs: number | null;
  signedRtcRefusal?: Refusal | null;
  signalingTrust?: "verified" | "first_contact" | "raw" | null;
};
```

The chip precedence is strict:

1. Signed RTC refusal -> destructive red, “blocked.”
2. Socket closed/error -> destructive red, “offline.”
3. Socket not open -> muted pulsing, “connecting.”
4. Socket open but mandatory channels not open -> warning pulsing, “channel….”
5. Channels open, direct -> success, “direct” plus optional RTT.
6. Channels open, STUN -> info, “p2p” plus optional RTT.
7. Channels open, TURN -> warning, “relay” plus optional RTT.

(web/src/components/terminal/ConnectionChip.tsx:13-23; web/src/components/terminal/ConnectionChip.tsx:63-109)

Trust is a second indicator: verified uses `ShieldCheck`/success, first contact uses `ShieldAlert`/warning, and raw uses `ShieldOff`/muted. It does not change the network-path label. (web/src/components/terminal/ConnectionChip.tsx:25-60)

**RECOMMEND:** keep the list row's primary dot driven by process/activity. Show connection path/trust only inside the open terminal overlay, or as a secondary overlay-specific chip. A transient phone radio drop must not make a remote process appear exited.

### Alert states versus unread

The owner-scoped alert stream uses WebSocket subprotocol `spawn.alerts.v1` and carries only:

```ts
type AlertEventKind =
  | "agent.finished"
  | "agent.awaiting_input"
  | "session.died";

type AlertEvent = {
  event: AlertEventKind;
  session_id: string;
  command: string | null;
  exit_code?: number | null;
  signal?: string | null;
  at: string;
};
```

(web/src/lib/alerts.ts:17-34)

The server quiet timer is 8 seconds, one-shot, rearmed only by new meaningful output. Agent-finished is a running non-shell foreground returning to null/shell. Session-died comes from the exit transition. (server/spawn_server/ws/alerts.py:35-65; server/spawn_server/ws/alerts.py:81-105; server/spawn_server/ws/alerts.py:127-208)

There is **no durable unread entity or unread counter**. Alerts are transient delivery events; tab/workspace badges are current attention counts. The terminal's “New” marker is also local component state: it becomes true only when output arrives while that terminal is scrolled away from the live edge and clears on returning to bottom. (web/src/components/terminal/Terminal.tsx:483-489; web/src/components/terminal/Terminal.tsx:1126-1136; web/src/components/terminal/Terminal.tsx:1489-1505; web/src/components/terminal/Terminal.tsx:3302-3325)

**RECOMMEND:** expose `unreadCount: 0` in a native selector only if a uniform badge interface needs it, and document that it is not persisted. Do not relabel attention as unread.

## Agent kinds, marks, commands and detection

### Built-in definitions

The complete built-in list is four definitions:

| Display name (`name`) | `kind` | Launch `command` | Base `env` | Install command | Yolo args | Yolo env |
|---|---|---|---|---|---|---|
| `claude-code` | `claude-code` | `claude` | `{}` | `npm install -g @anthropic-ai/claude-code` | `--dangerously-skip-permissions` | `{}` |
| `codex` | `codex` | `codex` | `{}` | `curl -fsSL https://chatgpt.com/codex/install.sh \| CODEX_NON_INTERACTIVE=1 sh` | `--dangerously-bypass-approvals-and-sandbox` | `{}` |
| `opencode` | `opencode` | `opencode` | `{}` | `npm install -g opencode-ai` | null | `{"OPENCODE_PERMISSION":"{\"edit\":\"allow\",\"bash\":\"allow\",\"webfetch\":\"allow\"}"}` |
| `aider-sonnet` | `aider` | `aider --model claude-sonnet-4-6` | `{}` | `pipx install aider-chat \|\| pip install --user aider-chat` | `--yes-always` | `{}` |

(server/spawn_server/agents_builtin.py:22-71)

These rows are seeded idempotently by built-in **name** and server-owned metadata is updated on startup. Custom rows may use any non-empty kind/command and the same optional env/install/yolo fields; consequently this table is the full built-in list, not the full universe of agent kinds. (server/spawn_server/agents_builtin.py:74-109; server/spawn_server/routes/agents.py:90-149)

The API list itself has no `ORDER BY`. The UI establishes deterministic display order: built-ins first, then custom definitions, alphabetical by `name` within each group. (server/spawn_server/routes/agents.py:70-87; web/src/components/workspace/agent-switcher.tsx:58-65)

### Launch command construction

The command builder:

- accepts unquoted shell-safe characters matching `[A-Za-z0-9_@%+=:,./-]+`;
- otherwise POSIX single-quotes a value and expands an embedded quote as `'\''`;
- drops env keys that are not `[A-Za-z_][A-Za-z0-9_]*`;
- preserves dictionary insertion order and adds a trailing space after a non-empty env prefix;
- when yolo is both enabled and available, merges `yolo_env` over `env` and appends trimmed `yolo_args`;
- if installation is needed and `install` exists, constructs `install && runCommand`; otherwise runs the plain command.

(web/src/components/workspace/agent-command.ts:14-35; web/src/components/workspace/agent-command.ts:42-90)

Exact core:

```ts
function agentRunCommand(agent): string {
  const yolo = agent.yolo === true && agentYoloAvailable(agent);
  const env = yolo ? { ...agent.env, ...(agent.yolo_env ?? {}) } : agent.env;
  const args = yolo ? agent.yolo_args?.trim() : "";
  return envPrefix(env) + agent.command + (args ? " " + args : "");
}

function agentInstallAndRunCommand(agent): string | null {
  const install = agent.install?.trim();
  return install ? install + " && " + agentRunCommand(agent) : null;
}
```

The switcher checks host availability: installed definitions use run only; missing definitions use install-and-run if possible. The new-session and template paths currently queue `agentRunCommand` directly and do **not** consult availability, so a missing CLI reaches the shell as command-not-found. (web/src/components/workspace/agent-switcher.tsx:83-105; web/src/components/workspace/new-session-menu.tsx:164-176; web/src/components/workspace/instantiate-template.ts:86-95)

Session creation has no argv/env launch payload: it always starts the login shell and later types one command string. `argv.ts` contains a shell-like parser and smart-punctuation normalization utility, but the Agent form stores one trimmed command string and the launch builder does not split it into argv. Native must preserve that distinction. (web/src/lib/api.ts:786-803; web/src/lib/argv.ts:1-67; web/src/components/settings/agent-form.ts:31-44)

### Identity and logo resolution

The full resolver contract:

```ts
type ResolvedAgentIcon = {
  icon: "claude-code" | "codex" | "opencode" | "aider" | "shell" | "monogram";
  label: string;
  letter?: string;
};

// First non-KEY=value whitespace token, then strip path separators.
commandBasename(command)

// kind is checked first; command basename is fallback.
if name includes "claude"   -> Claude Code
if name includes "codex"    -> Codex
if name includes "opencode" -> OpenCode
if name includes "aider"    -> Aider
if exact bash|zsh|fish|sh|dash -> shell
if no kind/command          -> Shell
else                        -> first alphanumeric uppercase monogram
```

(web/src/lib/agent-identity.ts:6-48)

Running definition detection is stricter than brand matching:

```ts
function runningAgent(session, agents) {
  const reported = session?.foreground_command?.trim();
  if (!reported || isShellCommand(reported)) return null;
  const name = stripLeadingDash(reported).toLowerCase();
  return agents.find(
    agent => commandBasename(agent.command).toLowerCase() === name
  ) ?? null;
}
```

(web/src/lib/sessions.ts:93-130)

Thus:

- the terminal row's **actual type** comes from `foreground_command`, not from what was last selected;
- exact basename matching locates a current Agent definition for relaunch/template capture;
- broad substring matching chooses one of the four marks;
- null/unreported foreground is treated as Shell for compatibility with old workers;
- unknown/custom foreground gets a monogram unless its definition `kind` is supplied to a definition-list icon.

The marks are not files under `public/`. Their SVG paths are inline functions in `web/src/components/icons/AgentIcon.tsx`. Plate colors and sizes are:

| Mark | Plate/text |
|---|---|
| Claude Code | `#D97757` / white |
| Codex | white full-bleed plate; internal gradient stops `#B1A7FF`, `#7A9DFF`, `#3941FF` |
| OpenCode | black / white |
| Aider | `#10231b` / `#3fcf8e` |
| Shell | `#1c2128` / `#7ee787` |
| monogram | muted surface / muted foreground |

Default icon size is 28 px, glyph size is rounded `size * 0.58`, plate is rounded with inset ring and shadow. The exact Claude/Codex/OpenCode/Aider/Shell SVG paths are in the same component. (web/src/components/icons/AgentIcon.tsx:25-84; web/src/components/icons/AgentIcon.tsx:86-177)

**RECOMMEND:** port those exact inline SVG paths and plate constants to the shared native AgentIcon component. This is code-native vector artwork, needs no network/package lookup, and is compatible with Expo Go when rendered through the app's selected Expo-compatible SVG foundation.

### “Type, name, logo, status” row mapping

For a normal terminal tile:

| Row concept | Exact source/formula |
|---|---|
| type text | `resolveAgentIcon(null, foreground_command).label`; use Shell on null; optionally retain exact raw basename as secondary detail |
| name/title | trimmed `session.name` if present; otherwise `lastCwdDir(cwd) + " · " + agentDisplayName(foreground_command)`; ID-prefix fallback only if cwd is empty |
| logo | `resolveAgentIcon(null, foreground_command)`, with the inline mark/plate |
| status label | `session.activity_label`, falling back to uppercase `session.status` |
| status dot | `sessionActivityTone` and pulse iff activity is active |
| detail | host name, full cwd, running display name; status age from `last_activity_at` |

(web/src/lib/sessions.ts:12-53; web/src/lib/agent-identity.ts:35-57; web/src/components/ui/status.tsx:53-62)

For a files widget, use FolderTree/folder identity, title “Files — {leaf-or-path},” host/path detail and host online/offline state; it has no process/activity status. (web/src/components/workspace/widget-pane.tsx:28-71)

## Lifecycle flows

### API surface at a glance

```text
GET    /api/workspaces?archived=true|false
POST   /api/workspaces
GET    /api/workspaces/{workspace_id}
PATCH  /api/workspaces/{workspace_id}
POST   /api/workspaces/{workspace_id}/archive
POST   /api/workspaces/{workspace_id}/unarchive
DELETE /api/workspaces/{workspace_id}

GET    /api/sessions?host_id={host_id}
POST   /api/sessions
GET    /api/sessions/{session_id}
PATCH  /api/sessions/{session_id}
POST   /api/sessions/{session_id}/restart
DELETE /api/sessions/{session_id}
GET    /api/sessions/{session_id}/access
PATCH  /api/sessions/{session_id}/access

GET    /api/agents
POST   /api/agents
PATCH  /api/agents/{agent_id}
DELETE /api/agents/{agent_id}
PATCH  /api/agents/{agent_id}/preferences
GET    /api/hosts/{host_id}/agents
POST   /api/hosts/{host_id}/agents/{agent_id}/install
PATCH  /api/hosts/{host_id}/agents/{agent_id}/policy

GET    /api/workspace-templates
POST   /api/workspace-templates
PATCH  /api/workspace-templates/{template_id}
DELETE /api/workspace-templates/{template_id}
```

These paths and request shapes are the web API client's literal calls. (web/src/lib/api.ts:541-582; web/src/lib/api.ts:771-834; web/src/lib/api.ts:880-1015)

### 1. Create a workspace

#### Empty but homed workspace

1. Load `GET /api/hosts` and allow only online hosts in the creation UI. The web “new workspace” path opens the folder picker and creates an empty workspace at that host/directory. (web/src/components/workspace/new-workspace-menu.tsx:60-82)
2. Pick a folder through the host control transport. It is not a REST filesystem endpoint:
   - connect the host signaling flow and mandatory `spawn.host.ctl` version-1 DataChannel;
   - request `{"version":1,"type":"request","request_id":uuid,"operation":"fs.home"}`;
   - page directories with `operation:"fs.list", payload:{path,cursor}`, at most 96 entries per page;
   - optionally create a directory using `operation:"fs.mkdir", payload:{path}`;
   - restrict navigation/selection to the returned home subtree. (web/src/lib/hostControl.ts:7-19; web/src/lib/hostControl.ts:348-418; web/src/lib/hostControl.ts:421-470; web/src/components/workspace/folder-picker.tsx:117-179; web/src/components/workspace/folder-picker.tsx:305-335)
3. Send:

```json
POST /api/workspaces
{
  "host_id": "<host uuid>",
  "cwd": "/chosen/path"
}
```

Optional fields are `name`, `icon` and `icon_source`. (web/src/lib/api.ts:895-912)
4. Server verifies host ownership, derives the name, appends the active position, and stores one empty default tab. Name preference is: explicit trimmed name; otherwise cwd leaf (`~` becomes “Home”) made unique with “ 2”, “ 3”, … across active **and archived** names; otherwise the smallest unused “Workspace N.” (server/spawn_server/routes/workspaces.py:267-303; server/spawn_server/routes/workspaces.py:321-379)
5. Response:

```json
{
  "workspace": { "...": "Workspace" },
  "session": null
}
```

#### Workspace plus first terminal atomically

1. Send:

```json
POST /api/workspaces
{
  "name": "optional",
  "first_session": {
    "host_id": "<host uuid>",
    "cwd": "/chosen/path",
    "skill_ids": ["<optional skill uuid>"]
  }
}
```

2. In one DB transaction the server inserts Workspace and Session, grants default skills if `skill_ids` is omitted, and writes the Session as the one 24×24 tile. (server/spawn_server/routes/workspaces.py:349-379; server/spawn_server/routes/sessions.py:157-184)
3. After commit it dispatches this daemon frame:

```json
{
  "type": "session.create",
  "session_id": "<session uuid>",
  "cwd": "/chosen/path",
  "skills": [],
  "create_cwd": true
}
```

(server/spawn_server/routes/workspaces.py:382-395; server/spawn_server/routes/sessions.py:128-154)
4. Response contains both created entities. The UI may queue an agent command against the returned Session ID for later typing. (web/src/components/workspace/new-session-menu.tsx:173-177)

The Session create route does not itself require `host.status==="online"`. If no daemon is brokered, dispatch logs and returns while the durable Session remains `starting`. The UI prevents selecting offline hosts; native must do the same but should still handle a stuck `starting` row after a race. (server/spawn_server/routes/sessions.py:128-155; server/spawn_server/routes/sessions.py:269-334; web/src/components/workspace/new-session-menu.tsx:197-232)

### 2. Create a tab

1. Read the current LayoutV3.
2. Refuse if `tabs.length >= 8`.
3. Generate a UUID string.
4. Generate `nextTabName`: begin at `tabs.length + 1` and increment while “Tab N” is already used.
5. Append:

```json
{
  "id": "<uuid>",
  "name": "Tab N",
  "layout": { "version": 3, "tiles": [] }
}
```

The web-born object omits tab home keys; wire decode/server normalization makes them null.
6. Set `active_tab` to the new ID.
7. Send `PATCH /api/workspaces/{id} {"layout": <entire envelope>}`. There is no tab endpoint. (web/src/lib/tabs.ts:117-133; web/src/components/workspace/workspace-tabs.tsx:602-607; server/spawn_server/routes/workspaces.py:409-423)

### 3. Pick a folder and launch a session

1. Resolve the default folder:

```text
if target tab has both host_id and cwd -> use that pair
else if workspace has both             -> use workspace pair
else                                   -> ask for host + folder
```

(web/src/lib/tabs.ts:88-100; web/src/components/workspace/new-session-menu.tsx:94-108)
2. The choice is one of Shell, an Agent definition, or Files. Files follows the widget flow below; Shell and Agent both create the same login-shell Session. (web/src/components/workspace/new-session-menu.tsx:35-52)
3. Ensure the target tab has space. The authoritative test is `autoPlace(tab.layout.tiles).tile !== null`, not merely tile count. (web/src/components/workspace/new-session-menu.tsx:90-92)
4. For the web even-band placement, the client first computes sibling geometry with a temporary pane ID, removes that placeholder, and PATCHes the reshaped layout before creating the Session. This ordering prevents the explicit rectangle from overlapping the server's older sibling geometry. (web/src/components/workspace/new-session-menu.tsx:140-163)
5. Ensure the server envelope's `active_tab` identifies the intended target. `POST /api/sessions` has no `tab_id`; it always appends to the envelope's active tab. (server/spawn_server/routes/sessions.py:187-214)
6. Send:

```json
POST /api/sessions
{
  "host_id": "<host uuid>",
  "cwd": "/chosen/path",
  "name": "optional",
  "skill_ids": ["optional"],
  "workspace_id": "<workspace uuid>",
  "tile": { "x": 0, "y": 0, "w": 12, "h": 24 }
}
```

Omit `tile` to invoke server `auto_place`. Omit `workspace_id` for a standalone Session. `tile` without workspace ID is 400. (web/src/lib/api.ts:786-803; server/spawn_server/routes/sessions.py:269-309)
7. Server prunes stale/foreign/duplicate tiles, appends into active tab, atomically commits Session plus layout, records recent directory/activity statistics, and dispatches `session.create`. Explicit invalid geometry is 400 `tile placement is invalid`; no place is 409 `workspace_full`; archived workspace is 409 `workspace_archived`. (server/spawn_server/routes/sessions.py:187-214; server/spawn_server/routes/sessions.py:282-334)
8. If Shell was selected, stop.
9. If Agent was selected, construct `agentRunCommand(agent)` and store it as a pending launch for the returned Session ID. (web/src/components/workspace/new-session-menu.tsx:164-171)
10. When the pane has a Session record and terminal signaling socket reports open, take the command exactly once and send `command + "\r"` through the terminal handle. (web/src/components/workspace/session-pane.tsx:154-164)
11. The daemon eventually reports the observed foreground basename; the 5-second session poll reconciles the row identity/status. Sessions are polled every 5 seconds on the workspace page. (web/src/app/w/[id]/page.tsx:66-70; web/src/components/workspace/agent-switcher.tsx:93-104)

**RECOMMEND:** native's launch mutation should explicitly update `active_tab` in the freshest layout before `POST /api/sessions`, because `tabId` is not part of the create request. A local swipe between tabs alone must not be assumed to have persisted that value.

### 4. Add a files widget

1. Resolve host/cwd as for a terminal.
2. GET the freshest Workspace.
3. Generate a UUID widget pane ID.
4. Place it in the target grid.
5. Append a tile with:

```json
{
  "session_id": "<fresh widget uuid>",
  "x": 0, "y": 0, "w": 24, "h": 24,
  "widget": {
    "kind": "files",
    "host_id": "<host uuid>",
    "path": "/chosen/path"
  }
}
```

6. PATCH the entire layout. No Session call occurs. (web/src/components/workspace/new-session-menu.tsx:114-139)

### 5. Attach to and detach from a Session

Attach is view lifecycle, not process lifecycle:

1. Open `WS /ws/browser?session_id=<PTY session UUID>` with WebSocket subprotocol `spawn.v3` and the normal auth mechanism. (web/src/lib/ws.ts:1-34; server/spawn_server/ws/browser.py:159-196)
2. Server verifies ownership, then sends frames of these exact shapes (example shown for enabled RTC and a running Session; `enabled` and `status` carry current values):

```json
{"type":"rtc.config","enabled":true,"ice_servers":[],"binding_nonce_required":true}
{"type":"session.status","status":"running"}
```

(server/spawn_server/ws/browser.py:178-200)
3. Browser creates a fresh RTC signaling `session_id`, a binding nonce and a peer connection.
4. Browser creates two reliable ordered DataChannels named exactly `spawn.pty` and `spawn.ctl`. Both are mandatory. (web/src/components/terminal/useSessionSocket.ts:410-444)
5. Browser sends offer:

```json
{
  "type": "rtc.offer",
  "session_id": "<rtc generation id, not PTY id>",
  "binding_nonce": "<nonce>",
  "scope_type": "session",
  "scope_id": "<PTY session UUID>",
  "protocol": "spawn.pty",
  "protocol_version": 2,
  "sdp": "<raw offer or signed_envelope instead>"
}
```

(web/src/lib/ws.ts:118-157)
6. Server registers/fences the exact tuple and relays offer/candidates to the owning daemon. Terminal binary bytes or terminal control on the WebSocket cause a policy close: content belongs on the DataChannels. (server/spawn_server/ws/browser.py:344-390; server/spawn_server/ws/browser.py:391-549)
7. `spawn.pty` carries terminal input/output. `spawn.ctl` v1 carries history, snapshot, resize, scroll, redraw, control ownership, upload and history subscription. (web/src/lib/session-ctl.ts:1-28)
8. Live display-state events carry `owner:boolean`, `cols`, `rows` and `viewers`; these are not Session fields. (web/src/lib/session-ctl.ts:52-70)
9. Detach by closing the overlay/transport. If available, send:

```json
{
  "type": "rtc.close",
  "session_id": "<rtc id>",
  "binding_nonce": "<nonce>",
  "scope_type": "session",
  "scope_id": "<PTY id>",
  "protocol": "spawn.pty",
  "protocol_version": 2
}
```

Then close DataChannels/peer/WebSocket. The server unregisters the RTC binding and forwards close to the daemon. (web/src/lib/ws.ts:145-157; server/spawn_server/ws/browser.py:588-620)
10. Detach **does not** kill, archive, delete, rename or change Session process state. It only removes this viewer/transport.

### 6. Rename

#### Session

1. Trim input in UI.
2. Send `PATCH /api/sessions/{session_id} {"name":"value"}`.
3. Sending null, empty or whitespace clears to DB null. Other names are max 128. (web/src/lib/api.ts:804-810; server/spawn_server/routes/sessions.py:248-266)

The server initially generates `"{host.name} - {last cwd directory}"` truncated to 128 when creation name is blank, so null-name fallback mostly applies to renamed-clear or old data. (server/spawn_server/routes/sessions.py:29-38; server/spawn_server/routes/sessions.py:157-174)

#### Tab

1. Trim/cap to 64.
2. Replace that tab's `name` in the envelope.
3. PATCH the entire Workspace layout. Names need not be unique. (web/src/lib/tabs.ts:204-208; web/src/components/workspace/workspace-tabs.tsx:787)

#### Workspace

1. Send `PATCH /api/workspaces/{id} {"name":"value"}`.
2. Server trims and rejects empty with 400. Explicit duplicates are not checked. (server/spawn_server/routes/workspaces.py:409-423)

### 7. Move a pane between tabs

1. Find source tab and tile by pane ID.
2. Reject missing source/target, same tab, or unplaceable target.
3. Run `autoPlace` on target.
4. Remove source using grid `remove`, which may let adjacent survivors expand into the freed rectangle.
5. Preserve the moved tile's `session_id` and optional `widget` payload, but replace its rectangle with target placement.
6. PATCH the whole envelope once. This is layout-only: the Session process and ID do not change. (web/src/lib/tabs.ts:227-250)

Cross-tab drag preview is local and the saved drop is still one envelope update. (web/src/components/workspace/workspace-grid.tsx:765-781)

### 8. Reorder tabs and workspaces

#### Tabs

1. Find tab array index.
2. Clamp target to `0..tabs.length-1`.
3. Remove then insert the same object.
4. Return no mutation if index is unchanged.
5. PATCH full layout. `active_tab` is preserved. (web/src/lib/tabs.ts:211-225)

#### Workspaces

1. Send `PATCH /api/workspaces/{id} {"position":target}`.
2. Server removes the row from active ordering, clamps target, reinserts it and rewrites every active position to contiguous `0..n-1`. Archived workspaces are outside this ordering. (server/spawn_server/routes/workspaces.py:232-264; server/spawn_server/routes/workspaces.py:441-448)

### 9. Reorder panes on phone

1. Derive current IDs by reading order, `(y,x)`.
2. Move one ID up/down or accept a gesture-produced ordered ID list.
3. Convert list order back to a valid grid because the wire has no list-order field:
   - for 1–6 panes, assign each full width `x=0,w=24` and vertically divide 24 rows, distributing remainder to earlier items;
   - for 7–16 panes, sort the existing rectangles by reading order and reassign the requested IDs to that rectangle multiset;
   - carry the correct widget payload with each ID.
4. PATCH the full envelope. (web/src/components/workspace/workspace-grid-helpers.ts:618-652)

This explicit operation modifies how desktop renders the tab. Passive phone list viewing and swiping between tabs must not rewrite rectangles.

**UNKNOWN:** product must decide whether native exposes pane reorder exactly as web mobile does, because feature parity says yes but the operation necessarily changes desktop geometry. There is no server field in which a separate mobile ordering can be stored.

### 10. Remove, close and kill

These are distinct:

#### Remove from workspace, keep process

1. Remove tile from layout.
2. PATCH Workspace.
3. Do not call Session delete. The Session remains reachable via its standalone route/list. (web/src/components/session/session-view.tsx:115-139)

#### Close a Session permanently

1. Confirm destructive action.
2. `DELETE /api/sessions/{id}`.
3. Server sends best-effort daemon `session.kill` with TERM, detaches broker routing, hard-deletes row and commits. (server/spawn_server/routes/sessions.py:408-435)
4. Remove its tile from Workspace via layout PATCH. The standalone view performs delete first and treats layout cleanup as best effort; a later layout write prunes the absent row. (web/src/components/session/session-view.tsx:140-160)

#### Close a tab

1. The last tab cannot be removed.
2. Collect all non-widget Session IDs; widgets require no delete.
3. Confirm that all processes will be killed.
4. DELETE Sessions in parallel.
5. If any delete fails, do not PATCH tab removal. Earlier successful deletes can already be gone.
6. If all succeed, remove tab, set active tab to nearest survivor preferring the previous tab, and PATCH layout. (web/src/lib/tabs.ts:190-202; web/src/components/workspace/workspace-tabs.tsx:675-702)

#### Delete a Workspace

1. Confirm destructive action.
2. `DELETE /api/workspaces/{id}`.
3. Server enumerates non-widget tile Session IDs, kill-and-deletes owned rows, deletes Workspace and commits. Unreferenced standalone Sessions are untouched. (server/spawn_server/routes/workspaces.py:561-579)

### 11. Restart

1. `POST /api/sessions/{id}/restart {}`.
2. Server requires owned Session/Host and a currently brokered daemon; otherwise 409 `host daemon is offline`.
3. Same ID/cwd/name/host/skill relationship is retained.
4. Status and start time reset; exit code/time, output/input timestamps and foreground command clear.
5. Server dispatches `session.restart` with `create_cwd:true` and current skill capabilities.
6. Daemon acknowledgement moves status to running. (server/spawn_server/routes/sessions.py:337-376; server/spawn_server/ws/daemon.py:1497-1549)

Restart does not automatically relaunch the previously observed Agent; it restarts the login shell.

### 12. Archive and unarchive

#### Archive

1. Compute live count for confirmation: referenced Session exists and status is neither exited nor killed.
2. `POST /api/workspaces/{id}/archive`.
3. Server rejects already archived with 409 `workspace_archived`.
4. For every non-widget owned Session tile, best-effort TERM, detach and immediately mark killed/exit-time while retaining row.
5. Set `archived_at` and `updated_at`.
6. Remove from active ordering and reindex survivors; keep the archived row's old `position` as restore slot.
7. Preserve layout, Session IDs, homes, names and geometry. (web/src/lib/workspaces.ts:44-56; server/spawn_server/routes/workspaces.py:455-489)

#### Unarchive

1. `POST /api/workspaces/{id}/unarchive`.
2. Reject non-archived with 409 `workspace_not_archived`.
3. Clear archive time and reinsert at clamped saved position, reindexing active rows.
4. For every non-widget Session:
   - if owned Host exists and is online, reset the same row to starting and dispatch `session.restart`;
   - if Host is absent/offline, leave it killed/stopped.
5. Do not refuse the whole restore because one host is offline. (server/spawn_server/routes/workspaces.py:492-559)

Unarchive restarts shells only; prior agents are not relaunched because only `foreground_command` observed them and archive cleared it.

### 13. Duplicate tab and pane

#### Duplicate a tab

1. Refuse at 8 tabs.
2. For each widget tile, generate a fresh widget ID; no round trip.
3. For each extant Session tile:
   - GET `/api/sessions/{id}/access` and copy explicit skill IDs;
   - POST a new standalone Session on the same host/cwd;
   - if `runningAgent` recognizes the source foreground, queue that Agent's current run command for the copy.
4. Copy source geometry exactly, substitute new IDs, copy tab home, generate “{name} copy”, “copy 2”, etc., insert at requested clamped index or end, and set active.
5. PATCH the new envelope.
6. If anything fails before layout save, delete every newly created Session to avoid invisible shells. (web/src/lib/tabs.ts:135-187; web/src/components/workspace/workspace-tabs.tsx:609-664)

#### Duplicate one pane

The same semantic rule applies: a widget is layout-only with a fresh ID; a Session copy gets same host/cwd/skills, and a recognized running agent is queued. If placement/layout landing fails, delete the newly created Session. (web/src/components/workspace/workspace-grid.tsx:537-600)

Duplication copies shape and launch intent, not process memory/history.

### 14. Convert terminal ↔ files and move host

The desktop offers additional destructive identity-changing actions:

- **Terminal to Files:** confirm; replace Session tile ID with fresh widget ID in the same rectangle; PATCH layout; then DELETE old Session. A failed delete can leave an unreferenced Session. (web/src/components/workspace/workspace-grid.tsx:1463-1494)
- **Move terminal to another host:** this is not migration. Create a new shell Session on target host at `~`, replace the old tile ID while keeping its rectangle, focus new ID, then DELETE old Session. Agent process/history/skills are not preserved by this flow. (web/src/components/workspace/workspace-grid.tsx:1497-1538)

Native feature-parity labels should make these replacement semantics clear.

### 15. Save and instantiate a template

#### Capture

1. For each tab in order, copy tab name.
2. For each tile copy x/y/w/h.
3. Widget -> `run:{kind:"files"}`.
4. Session whose daemon foreground basename exactly matches an Agent command basename -> `run:{kind:"agent",command:agent.command}`.
5. Missing/unrecognized/shell Session -> `run:{kind:"shell"}`.
6. Send `POST /api/workspace-templates` with name, workspace host/cwd, spec, icon and icon source. (web/src/lib/workspace-templates.ts:14-42; web/src/lib/api.ts:949-968)

The spec intentionally does not retain Session names, IDs, skill grants, per-tab homes, output/history or live status.

#### Instantiate

1. Load current Agent definitions.
2. Create empty Workspace named from chosen cwd basename or template name; include custom icon always, but include auto-discovered icon only when template host/cwd exactly matches the chosen folder.
3. PATCH Workspace home.
4. Create every tab with a fresh UUID; create files widget tiles immediately with fresh IDs and chosen host/cwd while retaining rectangles.
5. PATCH this initial layout.
6. Walk tabs in order. Before creating their Sessions, PATCH `active_tab` to that tab because Session create appends there.
7. For every shell/agent template tile, POST Session with chosen host/cwd, workspace ID and exact rectangle.
8. For Agent tile, match stored command basename to a current definition and queue today's env/yolo-aware run command; if no definition remains, queue the stored command.
9. Remember first created Session for focus.
10. Restore `active_tab` to first tab and return Workspace ID/focus Session ID. (web/src/components/workspace/instantiate-template.ts:15-116)

There is no transaction/rollback spanning these calls. A mid-instantiation failure can leave a partial Workspace and Sessions.

### 16. Shell handoff and agent switching

Agent definitions are commands typed into the PTY, so switching while another agent owns the foreground is destructive:

1. If no terminal handle, cancel.
2. If `sessionAtShell` (null or recognized shell foreground), type command and newline immediately.
3. Otherwise show destructive confirm naming current foreground.
4. Up to 8 iterations, wait 700 ms each; send Ctrl-C on only the first 4.
5. After each delay, GET `/api/sessions/{id}`.
6. If Session is not running, return busy.
7. When foreground becomes null/shell, type `clear\n` then command plus newline and focus.
8. After roughly 5.6 seconds without prompt, return busy and ask user to quit it manually. (web/src/components/workspace/shell-handoff.ts:14-90)

Choosing “Shell” uses the same handoff with an empty command, leaving a cleared prompt. The switcher requires Session status running. (web/src/components/workspace/agent-switcher.tsx:72-125)

### 17. Pending launch handling

Current implementation:

```ts
const queued = new Map<string, string>();

set(sessionId, command) {
  queued.set(sessionId, command);
}

take(sessionId) {
  const command = queued.get(sessionId) ?? null;
  queued.delete(sessionId);
  return command;
}
```

(web/src/components/workspace/pending-launch.ts:1-21)

The queue is module memory only, consumed once when its pane sees signaling socket open. It is not a Session field and never goes to the server. Reloading, app termination, JS bundle reset, or creating a command for a tab never opened loses it and leaves the login shell running. (web/src/components/workspace/session-pane.tsx:154-164)

**RECOMMEND:** implement parity first as a centralized in-memory `Map<SessionId,string>` whose only consumer is terminal-ready. Do not persist raw commands casually: env values can contain secrets, and a durable/replayed command needs explicit expiry, ownership and exactly-once design.

**UNKNOWN:** product must decide whether mobile process death should abandon a queued Agent exactly like web reload, or whether a separately designed secure pending-launch record is a mobile requirement.

### 18. Capacity limits and behavior at the cap

There is no host-level launch quota.

| Capacity concept | Formula/behavior |
|---|---|
| tabs | maximum 8 per workspace; add/duplicate refuses locally and server schema rejects larger |
| tiles | maximum 16 per tab, counting Sessions and widgets |
| placeability | authoritative `autoPlace(tiles).tile !== null`; can be false below 16 for a valid fragmented layout with no 4×4 hole/splittable tile |
| server create at cap | 409 `workspace_full`; no Session/layout commit |
| explicit invalid rectangle | 400 `tile placement is invalid` |
| `Host.session_count` | count of all DB Session rows, not a cap and not live-only |
| exact host metrics | display-only 1-second polling over host control; no launch enforcement |
| server buckets | nullable 0–5 display segments from heartbeat; no launch enforcement |

(web/src/lib/grid.ts:29-33; web/src/lib/grid.ts:200-249; server/spawn_server/routes/sessions.py:187-214; server/spawn_server/routes/hosts.py:111-119; web/src/hooks/useHostCapacity.ts:8-25; server/spawn_server/host_capacity.py:25-32)

Useful computed availability:

```ts
remainingTabSlots = 8 - workspace.layout.tabs.length;
nominalTileSlots = 16 - tab.layout.tiles.length;
canAddPane = autoPlace(tab.layout.tiles).tile !== null;
workspaceNominalTileSlots =
  sum(workspace.layout.tabs.map(tab => 16 - tab.layout.tiles.length));
```

`nominalTileSlots` is informational; `canAddPane` controls the button. A full current tab does not mean other tabs are full.

### 19. Manage agent definitions and preferences

1. `GET /api/agents` returns built-ins plus the user's custom definitions.
2. Built-ins are read-only definitions; custom definitions use POST/PATCH/DELETE `/api/agents`. Create/edit requires nonblank name, kind and command; the settings form also rejects duplicate env keys. (web/src/components/settings/AgentsPanel.tsx:34-95; web/src/components/settings/AgentsPanel.tsx:317-330)
3. Deleting a custom definition removes only the shortcut; already running Sessions are unaffected because they have no Agent FK. (web/src/components/settings/AgentsPanel.tsx:88-95)
4. `PATCH /api/agents/{id}/preferences {"yolo":boolean}` works for built-ins and custom definitions because it writes the user's separate preference row. The UI updates optimistically and refetches on failure. (web/src/components/settings/AgentsPanel.tsx:63-78; server/spawn_server/routes/agents.py:166-203)
5. The yolo toggle is disabled when both `yolo_args` and `yolo_env` are empty; the command preview visibly shows the extra env keys/arguments. (web/src/components/settings/AgentsPanel.tsx:202-252; web/src/components/settings/AgentsPanel.tsx:285-290)

### 20. Change homes, widget paths and workspace icon

- Workspace home changes use `PATCH /api/workspaces/{id} {"host_id":...,"cwd":...}` after folder selection. Tab home changes replace the tab's paired `host_id/cwd` in LayoutV3 and PATCH the envelope; null/null restores inheritance. (web/src/lib/api.ts:913-930; web/src/lib/tabs.ts:88-110)
- Re-rooting a files widget changes only `widget.path`, preserving pane ID, host and rectangle, then PATCHes layout. (web/src/components/workspace/workspace-grid.tsx:1445-1455)
- On first open of an active, homed Workspace whose `icon_source` is null and Host is online, scan the folder. Success PATCHes `{icon,icon_source:"auto"}`; no usable candidate PATCHes `{icon_source:"none"}`; transport/write failure leaves null so a later open retries. (web/src/hooks/useWorkspaceIconAutoFill.ts:9-75)
- Manual choice rasterizes the image and PATCHes `icon` with `icon_source:"custom"`. “Use initials” sends `icon:null` and custom source, preventing another automatic scan. Folder suggestions are available only with online Host/cwd. (web/src/components/workspace/workspace-icon-dialog.tsx:44-115; web/src/components/workspace/workspace-icon-dialog.tsx:219-250; web/src/components/workspace/workspace-tabs.tsx:1125-1134)

## Grid and layout compatibility

### Persistence envelope

The stored Workspace field is:

```json
{
  "version": 3,
  "active_tab": "tab id or null",
  "tabs": [
    {
      "id": "opaque 1..64 character id",
      "name": "1..64 character name",
      "host_id": "host uuid or null",
      "cwd": "/path or null",
      "layout": {
        "version": 3,
        "tiles": [
          {
            "session_id": "opaque nonempty pane id",
            "x": 0,
            "y": 0,
            "w": 24,
            "h": 24,
            "widget": {
              "kind": "files",
              "host_id": "host uuid",
              "path": "/path"
            }
          }
        ]
      }
    }
  ]
}
```

`widget` is absent for terminal tiles, not null. The envelope and each grid happen to be version 3 but are separately described layers. Template spec version is 2. (server/spawn_server/schemas.py:787-866; web/src/lib/api.ts:318-354; server/spawn_server/schemas.py:948-959)

### Grid constants and invariants

```ts
export const LAYOUT_VERSION = 3;
export const GRID_SIZE = 24;
export const MIN_TILE_SIZE = 4;
export const MAX_TILES = 16;
```

(web/src/lib/grid.ts:23-33)

A valid grid:

- is an object with `version===3` and a tile array;
- has at most 16 tiles;
- gives every tile a non-empty string `session_id`;
- gives x/y/w/h integer values;
- keeps every rectangle in `0..24` bounds;
- makes every width and height at least 4;
- has unique pane IDs;
- has no overlapping rectangles.

(web/src/lib/grid.ts:79-101; web/src/lib/grid.ts:125-198)

The web and server implementations are required to reproduce the shared fixture results byte-for-byte after normalized JSON. Returned arrays are always reading order; validation error emission order is pinned; operations are deterministic and immutable. (web/src/lib/grid.ts:1-20; proto/layout-v3-fixtures.json:2-12; server/spawn_server/grid.py:1-11)

### Validation error contract

```ts
type LayoutErrorCode =
  | "shape"
  | "version"
  | "count"
  | "session_id"
  | "integer"
  | "bounds"
  | "size"
  | "duplicate"
  | "overlap";

type LayoutError = {
  code: LayoutErrorCode;
  index?: number;
  other_index?: number;
};
```

Emission order is:

1. `shape` alone if the object/array shape cannot be inspected.
2. `version`, then `count`.
3. Per tile: session ID, integer, bounds, size. Integer failure suppresses bounds/size for that tile.
4. Duplicates in tile order, with later index and first occurrence.
5. Overlaps for index pairs in lexicographic order.

Tiles failing integer or bounds checks are excluded from overlap checks. The fixtures explicitly say ID **format** is not validated at this algebra layer. (proto/layout-v3-fixtures.json:4-5; web/src/lib/grid.ts:125-198)

### Reading order

Every operation returns a copied array sorted by:

```ts
(a, b) => a.y - b.y || a.x - b.x
```

`readingOrder` maps that array to pane IDs. Because valid rectangles cannot share an origin cell, the order is unambiguous. (web/src/lib/grid.ts:103-110; web/src/lib/grid.ts:389-392)

This order is the native tab list order unless a transient drag preview is active.

### `autoPlace`

1. If already 16 tiles, return null placement and sorted input.
2. Scan every possible 4×4 origin by y then x.
3. At first free origin, grow width rightward one column at a time while height is 4.
4. Then grow height downward across that expanded width.
5. Return rectangle plus sorted existing tiles.
6. If no 4×4 hole, candidates are existing tiles whose longer side is at least 8.
7. Choose largest area; ties use reading order.
8. Split along longer side; if width ≥ height, split vertically.
9. Existing tile keeps the ceil half; new placement receives floor half.
10. If no candidate, return null.

(web/src/lib/grid.ts:200-249; proto/layout-v3-fixtures.json:6)

The returned `tiles` may contain a resized victim. A caller must persist those along with appending the new tile.

### `move`

1. Unknown ID -> sorted unchanged input.
2. Clamp requested x to `0..24-w` and y to `0..24-h`.
3. If target is empty, move there and leave the old gap.
4. If target overlaps, choose victim with largest intersection area; tie goes to earliest reading-order victim.
5. Swap entire rectangles: both position **and size**.

(web/src/lib/grid.ts:284-329; proto/layout-v3-fixtures.json:7)

### `resize`

1. Unknown ID -> unchanged.
2. Keep origin fixed.
3. Clamp width to `4..24-x` and height to `4..24-y`.
4. Shrink leaves a gap.
5. Grow succeeds only if no overlap; otherwise entire operation is unchanged.

(web/src/lib/grid.ts:331-350; proto/layout-v3-fixtures.json:8)

### `remove`

1. Drop the target.
2. Nothing moves.
3. Survivors in reading order attempt to grow one cell at a time into only the freed rectangle.
4. Direction priority is right, down, left, up.
5. Repeat passes until nothing can grow.
6. Unknown ID -> unchanged.

(web/src/lib/grid.ts:352-387; proto/layout-v3-fixtures.json:10)

This is why “remove pane” can alter neighboring rectangle sizes even though it does not globally repack.

### `compact`

`compact` remains a pure utility but is no longer called by normal canvas operations. It processes tiles in reading order, sliding each continuously up as far as possible and then left, checking all other current rectangles. (web/src/lib/grid.ts:251-266; proto/layout-v3-fixtures.json:9)

### Legacy lifts

- A bare workspace layout envelope version 2 becomes a one-tab version-3 envelope with `tab-1`/“Tab 1.” (server/spawn_server/routes/workspaces.py:62-103)
- A grid still stamped version 2 represents a 12×12 space; coordinates and sizes are multiplied by 2 into 24×24 v3. (server/spawn_server/schemas.py:814-832; server/spawn_server/grid.py:138-161)
- A template spec version 1 similarly lifts geometry ×2 and becomes template spec version 2. (server/spawn_server/schemas.py:948-984)
- The older split-tree migration assigns float rectangles in 24×24, rounds edges half-up, falls back to repeated auto-place if rounded tiles are invalid, and retains only the first 16 panes in DFS order. (proto/layout-v3-fixtures.json:11; web/src/lib/grid.ts:394-475)

Several comments still say 12×12/v2 while constants and serialized values are 24×24/v3. Native must follow constants, schemas and fixtures rather than stale prose. (web/src/lib/api.ts:318-337; web/src/lib/grid.ts:23-33; server/spawn_server/models.py:594-613)

### Server normalization and pruning

On a layout write the server:

1. Parses/lifts the envelope.
2. Resolves owned Session IDs referenced by non-widget tiles.
3. Traverses tabs and tiles in supplied order.
4. Drops missing/unowned normal Session tiles.
5. Drops every repeated pane ID after the first occurrence, including widget IDs.
6. Retains widget tiles without Session lookup.
7. Resets a tab home to null/null if incomplete or host is unowned.
8. Rejects duplicate tab IDs.
9. Rejects `active_tab` if non-null and not a tab ID.
10. Validates each grid's geometry.

(server/spawn_server/routes/workspaces.py:119-204)

The server does not sort supplied tiles during envelope prune; valid operation functions already return reading order, but geometry itself defines reading order regardless of JSON array order. The shared algebra's returned arrays are sorted. (server/spawn_server/routes/workspaces.py:162-187; proto/layout-v3-fixtures.json:4)

### What phone should render

For each selected tab:

1. Read `tab.layout.tiles`.
2. Sort by y then x.
3. Map terminal tiles to Session rows by ID.
4. Map widget tiles directly to file-widget rows.
5. Omit or render a recoverable “session unavailable” placeholder for a non-widget tile missing its Session row; do not invent status.
6. Render a flat native list with one tactile row per pane.
7. Tapping a terminal row pushes/presents the live terminal as a swipe-dismissable overlay.
8. Tapping a widget row presents its native file surface.

The phone must not resize/repack merely because it displayed the list. The existing web helper that repacks a “mobile” layout is only invoked for explicit pane reorder, not passive layout. (web/src/components/workspace/workspace-grid-helpers.ts:618-652)

### Fields phone must preserve

Every layout mutation must round-trip:

- envelope `version`;
- `active_tab`, except when intentionally targeting a server-side create;
- tab array order;
- every tab `id` and `name`;
- each tab `host_id` and `cwd` pair;
- each grid `version`;
- every tile `session_id`;
- every tile `x/y/w/h`;
- optional `widget.kind/host_id/path`;
- all tabs and tiles not targeted by the mutation.

Dropping rectangles because phone does not draw them destroys desktop layout. Dropping widget payload converts it into an invalid/missing Session tile. Dropping tab homes changes future launch folders. Dropping inactive tabs destroys them.

**RECOMMEND:** port `grid.ts` and `tabs.ts` as platform-neutral pure TypeScript and run the shared fixture JSON against the mobile implementation in its own implementation phase. Do not create a “simpler” native serializer.

**RECOMMEND:** serialize local layout mutations per Workspace and begin each recipe from a fresh GET. This reduces same-device lost updates. It cannot solve cross-device conflicts because the current server has no compare-and-swap token; native should refresh after save and surface failures.

## Derived and computed values

### Canonical session and tile maps

```ts
sessionsById = new Map(sessions.map(session => [session.id, session]));
hostsById = new Map(hosts.map(host => [host.id, host]));
agentsById = new Map(agents.map(agent => [agent.id, agent]));

orderedTiles(tab) =
  [...tab.layout.tiles].sort((a, b) => a.y - b.y || a.x - b.x);

sessionTiles(tab) = orderedTiles(tab).filter(tile => !tile.widget);
widgetTiles(tab) = orderedTiles(tab).filter(tile => tile.widget);
```

The workspace's cross-tab pane ID order is tab array order, then grid reading order. (web/src/lib/tabs.ts:60-68; web/src/lib/grid.ts:389-392)

### Per-tab values

```ts
tileCount(tab) = tab.layout.tiles.length;

sessionCount(tab) =
  sessionTiles(tab).filter(tile => sessionsById.has(tile.session_id)).length;

widgetCount(tab) = widgetTiles(tab).length;

runningCount(tab) =
  sessionTiles(tab).filter(tile => {
    const session = sessionsById.get(tile.session_id);
    return session !== undefined
      && session.status !== "exited"
      && session.status !== "killed";
  }).length;

attentionCount(tab) =
  sessionTiles(tab).filter(tile => {
    const session = sessionsById.get(tile.session_id);
    return session !== undefined
      && sessionNeedsAttention(session) !== null;
  }).length;

waitingCount(tab) =
  sessionTiles(tab).filter(tile =>
    sessionsById.get(tile.session_id)?.status !== "exited"
    && sessionsById.get(tile.session_id)?.status !== "killed"
    && sessionsById.get(tile.session_id)?.activity_state === "waiting"
  ).length;

deadCount(tab) =
  sessionTiles(tab).filter(tile => {
    const status = sessionsById.get(tile.session_id)?.status;
    return status === "exited" || status === "killed";
  }).length;

nominalRemaining(tab) = 16 - tileCount(tab);
canAdd(tab) = autoPlace(tab.layout.tiles).tile !== null;
```

The real attention implementation excludes widgets and counts the same predicate. (web/src/lib/workspaces.ts:70-77)

### Per-workspace rollup

```ts
workspaceTiles(workspace) =
  workspace.layout.tabs.flatMap(tab => orderedTiles(tab));

workspaceSessionIds(workspace) =
  workspace.layout.tabs.flatMap(tab => readingOrder(tab.layout.tiles));

workspaceTileCount(workspace) = workspaceTiles(workspace).length;

workspaceLiveSessionCount(workspace) =
  workspaceSessionIds(workspace).filter(id => {
    const session = sessionsById.get(id);
    return session !== undefined
      && session.status !== "exited"
      && session.status !== "killed";
  }).length;

workspaceAttentionCount(workspace) =
  workspaceSessionIds(workspace).filter(id => {
    const session = sessionsById.get(id);
    return session !== undefined
      && sessionNeedsAttention(session) !== null;
  }).length;

workspaceRecency(workspace) = max(
  parse(workspace.updated_at),
  ...workspaceSessionIds(workspace)
    .map(id => sessionsById.get(id)?.last_input_at)
    .filter(nonNull)
    .map(parseFinite)
);
```

(web/src/lib/workspaces.ts:18-24; web/src/lib/workspaces.ts:44-67; web/src/lib/workspaces.ts:80-92)

Widgets cannot accidentally raise live/attention counts because no Session row exists for their ID; per-tab code explicitly filters them.

Recommended display rollup:

```ts
workspaceStats = {
  tabs: workspace.layout.tabs.length,
  panes: sum(tab.tileCount),
  terminals: sum(tab.sessionCount),
  widgets: sum(tab.widgetCount),
  running: sum(tab.runningCount),
  waiting: sum(tab.waitingCount),
  dead: sum(tab.deadCount),
  attention: sum(tab.attentionCount),
  remainingTabs: 8 - tabs,
  nominalRemainingPanes: sum(16 - tab.tileCount),
  archived: workspace.archived_at !== null,
};
```

`badgeCount` is `attention`, not unread.

### Active tab

Server envelope resolution is `tabs.find(id===active_tab) ?? tabs[0]`. (web/src/lib/tabs.ts:44-48; server/spawn_server/routes/workspaces.py:106-111)

The desktop device selection precedence is:

1. explicit user choice / valid route `?tab=`;
2. tab that owns route `?focus=<session>`;
3. last valid tab for this Workspace in local device storage;
4. envelope active tab, falling back to first.

Switching tabs updates only local device state; `active_tab` reaches server as a side-effect of a later layout write so devices do not fight on every click. (web/src/app/w/[id]/page.tsx:99-125)

**RECOMMEND:** native should store `lastTabByWorkspace[workspaceId]` locally and use the same precedence. A horizontal tab swipe is local navigation and must not PATCH by itself.

### Active pane / terminal

There is no server “active Session.” Desktop keeps a local `focusedId`:

```text
ids = readingOrder(activeTab.tiles)
if ids empty                         -> focusedId = null
else if prior focusedId not in ids  -> focusedId = ids[0]
else                                -> retain focusedId
```

(web/src/app/w/[id]/page.tsx:128-144)

Because reading order includes widgets, this is active **pane**, not necessarily active terminal. Native should keep local `selectedPaneIdByTab` and use the open overlay route as the strongest focus signal.

### Status and type selector

```ts
function terminalRow(session, tile, agents) {
  const agent = runningAgent(session, agents);
  const identity = resolveAgentIcon(
    agent?.kind ?? null,
    session.foreground_command
  );
  return {
    paneId: tile.session_id,
    sessionId: session.id,
    type: identity.label,
    title: sessionTitle(session),
    icon: identity,
    statusLabel: sessionActivityLabel(session),
    statusTone: sessionActivityTone(session),
    statusPulse: session.activity_state === "active",
    attention: sessionNeedsAttention(session),
    live: session.status !== "exited" && session.status !== "killed",
  };
}
```

For exact visual parity with current pane headers, pass foreground command without definition kind to the icon; supplying a matching Agent kind can improve a custom definition's list label but is a small divergence. The web running pane icon uses only `command={session.foreground_command}`. (web/src/components/workspace/agent-switcher.tsx:67-70)

### Host capacity selector

Server summary:

```ts
hostCapacitySummary(host) = {
  online: host.status === "online",
  cpuSegments: host.status === "online" ? host.cpu_bucket : null,
  memorySegments: host.status === "online" ? host.mem_bucket : null,
  hasTelemetry: host.capacity_at !== null,
  sessionRows: host.session_count, // not live, not remaining
};
```

Exact live surface state:

```ts
{
  sample: HostCapacitySample | null,
  spec: HostCapacitySpec | null,
  live: enabled && hostControlReady && capabilityPresent && sample !== null,
  unavailable:
    readyAndCapabilityMissing
    || (liveTransportButPollFailed && sample === null)
}
```

Poll is 1 second, request timeout 4 seconds, and requests never stack. (web/src/hooks/useHostCapacity.ts:22-103)

There is no meaningful `capacityRemaining` in process units. Return layout remaining separately from raw host meters.

### Alerts and local new-output selector

```ts
currentAttentionBadge = workspaceAttentionCount(workspace, sessionsById);
durableUnreadBadge = 0;
terminalNewOutput =
  terminalOverlayMounted && !atLiveEdge && outputArrivedSinceLeavingLiveEdge;
```

Alert events should invalidate/reload Session state promptly, then let normal selectors compute attention; an event by itself is not persisted state. (web/src/lib/alerts.ts:5-14; server/spawn_server/ws/alerts.py:127-190)

## Ordering, naming and identity rules

### Workspace ordering

Active list:

```sql
ORDER BY position ASC, created_at ASC, id ASC
```

Archived list:

```sql
ORDER BY archived_at DESC, created_at DESC, id ASC
```

`GET /api/workspaces` defaults to active only; `?archived=true` returns archived only. The lists never mix. (server/spawn_server/routes/workspaces.py:232-252; server/spawn_server/routes/workspaces.py:306-315)

Active `position` is contiguous per owner and the server reindexes after reorder/archive/unarchive. Archived rows retain a stale/saved slot for restoration but are not sorted by it. (server/spawn_server/routes/workspaces.py:255-264; server/spawn_server/routes/workspaces.py:455-489; server/spawn_server/routes/workspaces.py:510-521)

The UI may compute `workspaceRecency` for heuristics, but that does not replace server/sidebar `position` ordering. Name search is trimmed, lowercased substring matching and retains input order. (web/src/lib/workspaces.ts:27-37; web/src/lib/workspaces.ts:80-92)

### Workspace default names

Server rule:

1. Explicit nonblank trimmed name wins and need not be unique.
2. Otherwise if cwd yields a leaf, use leaf; `~` yields “Home.”
3. If that base is already an exact active or archived name, choose “base 2,” then “base 3,” etc.
4. If no cwd-derived base, inspect names matching exactly `Workspace ([0-9]+)` and choose the smallest positive unused N.

(server/spawn_server/routes/workspaces.py:267-303; server/spawn_server/routes/workspaces.py:326-347)

The client helper `defaultWorkspaceName` instead begins at `existing.length+1` and increments on collision. That differs from the server's smallest-free rule; authoritative creation should omit name and let the server decide unless the user explicitly entered one. (web/src/lib/workspaces.ts:10-16)

There is no Workspace name uniqueness constraint in the DB model. Automatic naming avoids collisions; explicit rename/create can duplicate. (server/spawn_server/models.py:594-643; server/spawn_server/routes/workspaces.py:417-421)

### Tab ordering and names

- Array order is tab strip/swipe order.
- New tab appends.
- New default name begins at `tabs.length+1` and skips already used “Tab N.”
- Duplicate name is “{source} copy,” then “copy 2,” “copy 3,” etc.
- User rename need not be unique.
- Removing active tab chooses nearest survivor, preferring previous.
- Tab reorder clamps its insertion index.

(web/src/lib/tabs.ts:117-225)

Tab ID uniqueness is enforced within the Workspace envelope. Tab names are not unique. (server/spawn_server/routes/workspaces.py:190-198)

### Pane/Session ordering

- Within a tab, semantic order is geometry reading order `(y,x)`, not raw JSON array order.
- Across a Workspace, concatenate tabs in array order and each tab's reading order.
- `GET /api/sessions` is independent of layout and orders newest `started_at` first; do not use that response order for a tab list.
- Templates preserve tab array order and tile geometry; their list endpoint sorts templates alphabetically by name.
- Agent UI sorts built-ins first, then custom, alphabetical within each; API ordering is unspecified.
- Host list endpoint has no explicit ordering; native should establish the presentation order required by its host picker.

(web/src/lib/grid.ts:389-392; web/src/lib/tabs.ts:60-68; server/spawn_server/routes/sessions.py:217-232; server/spawn_server/routes/workspace_templates.py:62-78; web/src/components/workspace/agent-switcher.tsx:58-65; server/spawn_server/routes/hosts.py:440-451)

### Session names

Creation:

```text
explicit nonblank request name
else host.name + " - " + last directory component of cwd
truncate to 128 characters
```

(server/spawn_server/routes/sessions.py:29-38; server/spawn_server/routes/sessions.py:157-174)

Display:

```text
trimmed session.name if present
else cwd leaf + " · " + running-agent display name
else first 8 ID characters + " · " + running-agent display name
```

(web/src/lib/sessions.ts:12-25)

Names are not constrained unique per host/workspace/tab. Rename blank/null clears to null. (server/spawn_server/routes/sessions.py:248-266; server/spawn_server/models.py:444-469)

### Identity types and uniqueness

| Thing | Identity format | Uniqueness/lifetime |
|---|---|---|
| Workspace | server-generated UUID string, DB String(36) | global row PK; stable through archive/unarchive |
| Session | server-generated UUID string, DB String(36) | global row PK; stable through restart/archive/unarchive; gone on close/delete |
| Host | server-generated UUID string, DB String(36) | global row PK |
| Agent | server-generated UUID string, DB String(36) | global row PK; built-in IDs seeded DB-side and must not be hardcoded |
| Template | server-generated UUID string, DB String(36) | global row PK |
| Tab | opaque string 1–64 | unique only within one envelope; default `tab-1`, new UI UUID |
| terminal pane | same as Session UUID | that Session ID may appear at most once across the Workspace |
| widget pane | client-generated opaque nonempty ID, conventionally UUID | unique across whole Workspace; no row |
| RTC signaling session | fresh transport-generation string | distinct from PTY Session; bound with nonce/generation/scope tuple |

DB UUID generation is visible on the concrete row declarations. (server/spawn_server/models.py:233-235; server/spawn_server/models.py:366-386; server/spawn_server/models.py:449-469; server/spawn_server/models.py:599-643; server/spawn_server/models.py:653-677)

The Agent DB uniqueness constraint is `(owner_user_id,name)` and API converts its integrity error to 409 `agent name already exists`. Built-ins are located/updated by name during seed. (server/spawn_server/models.py:361-386; server/spawn_server/routes/agents.py:31-36; server/spawn_server/agents_builtin.py:74-109)

## Native domain module shape

### Design boundary

**RECOMMEND:** ship this as platform-neutral TypeScript under the native app's domain/data layer. It should have no React Native imports, navigation APIs, haptics, storage, SVG or WebRTC implementation. Inject HTTP, ID generation, device preference storage and terminal transport at the edges. Pure TypeScript itself is fully Expo Go compatible.

The domain owns:

- decoded entities and normalized maps;
- exact grid/tab algebra;
- row/rollup selectors;
- layout mutation serialization;
- REST mutations;
- pending-launch coordination;
- alert invalidation;
- no visual component state beyond serializable selection preferences.

### Concrete types

```ts
// domain/types.ts
export type UUID = string & { readonly __uuid: unique symbol };
export type WorkspaceId = UUID;
export type SessionId = UUID;
export type HostId = UUID;
export type AgentId = UUID;
export type TemplateId = UUID;
export type TabId = string & { readonly __tabId: unique symbol };
export type PaneId = string & { readonly __paneId: unique symbol };
export type ISODateString = string;

export type HostStatus = "online" | "offline" | (string & {});
export type ProcessStatus =
  | "starting" | "running" | "exited" | "killed"
  | (string & {});
export type ActivityState =
  | "starting" | "active" | "quiet" | "waiting"
  | "input_sent" | "exited" | "killed" | "unknown"
  | (string & {});
export type ActivityTone = "active" | "waiting" | "idle" | "offline";
export type Attention = "waiting" | "dead" | null;
export type WorkspaceIconSource = "auto" | "custom" | "none" | null;

export interface Host {
  id: HostId;
  name: string;
  os?: string | null;
  arch?: string | null;
  version?: string | null;
  host_key_algorithm?: "ed25519" | null;
  host_public_key?: string | null;
  host_key_fingerprint?: string | null;
  status: HostStatus;
  last_seen_at: ISODateString | null;
  session_count: number;
  cpu_cores: number | null;
  cpu_physical_cores: number | null;
  cpu_model: string | null;
  memory_bytes: number | null;
  gpu: string | null;
  cpu_bucket: number | null;
  mem_bucket: number | null;
  capacity_at: ISODateString | null;
}

export interface Session {
  id: SessionId;
  name: string | null;
  host_id: HostId;
  host_name: string | null;
  cwd: string;
  status: ProcessStatus;
  started_at: ISODateString;
  exited_at: ISODateString | null;
  exit_code: number | null;
  last_output_at: ISODateString | null;
  last_input_at: ISODateString | null;
  last_activity_at: ISODateString | null;
  activity_state: ActivityState;
  activity_label: string;
  foreground_command: string | null;
}

export interface Agent {
  id: AgentId;
  owner_user_id: UUID | null;
  name: string;
  kind: string;
  command: string;
  env: Record<string, string>;
  install?: string | null;
  yolo_args: string | null;
  yolo_env: Record<string, string>;
  yolo: boolean;
}

export interface FilesWidget {
  kind: "files";
  host_id: HostId;
  path: string;
}

export interface Tile {
  session_id: PaneId;
  x: number;
  y: number;
  w: number;
  h: number;
  widget?: FilesWidget;
}

export interface GridLayoutV3 {
  version: 3;
  tiles: Tile[];
}

export interface WorkspaceTab {
  id: TabId;
  name: string;
  host_id: HostId | null;
  cwd: string | null;
  layout: GridLayoutV3;
}

export interface WorkspaceLayoutV3 {
  version: 3;
  active_tab: TabId | null;
  tabs: WorkspaceTab[];
}

export interface Workspace {
  id: WorkspaceId;
  name: string;
  host_id: HostId | null;
  cwd: string | null;
  layout: WorkspaceLayoutV3;
  position: number;
  icon: string | null;
  icon_source: WorkspaceIconSource;
  archived_at: ISODateString | null;
  created_at: ISODateString;
  updated_at: ISODateString;
}

export type TemplateRun =
  | { kind: "shell"; command?: null }
  | { kind: "agent"; command: string }
  | { kind: "files"; command?: null };

export interface TemplateTile {
  x: number;
  y: number;
  w: number;
  h: number;
  run: TemplateRun;
}

export interface WorkspaceTemplate {
  id: TemplateId;
  name: string;
  host_id: HostId | null;
  cwd: string | null;
  spec: {
    version: 2;
    tabs: Array<{ name: string; tiles: TemplateTile[] }>;
  };
  icon: string | null;
  icon_source: WorkspaceIconSource;
  created_at: ISODateString;
  updated_at: ISODateString;
}

export interface Rect { x: number; y: number; w: number; h: number }
export interface ResolvedAgentIcon {
  icon: "claude-code" | "codex" | "opencode" | "aider" | "shell" | "monogram";
  label: string;
  letter?: string;
}
export interface Skill {
  id: UUID; owner_user_id: UUID; name: string; description: string;
  content: string; enabled_by_default: boolean; created_at: ISODateString;
}
export interface SessionAccess { session_id: SessionId; skills: Skill[] }
export interface HostAgentStatus {
  agent_id: AgentId; agent_name: string; agent_kind: string; command: string;
  install: string | null; installed: boolean; path: string | null;
  version: string | null; latest_version: string | null;
  update_available: boolean | null; error: string | null; auto_update: boolean;
  last_checked_at: ISODateString | null; last_auto_update_at: ISODateString | null;
  last_auto_update_error: string | null;
}
export interface CreateTemplateInput {
  name: string; host_id?: HostId; cwd?: string; spec: WorkspaceTemplate["spec"];
  icon?: string | null; icon_source?: WorkspaceIconSource;
}
export type PatchTemplateInput = Partial<CreateTemplateInput>;
```

### Store state

```ts
// domain/state.ts
export interface DomainState {
  workspacesById: Map<WorkspaceId, Workspace>;
  activeWorkspaceIds: WorkspaceId[];   // server position order
  archivedWorkspaceIds: WorkspaceId[]; // server archived order
  sessionsById: Map<SessionId, Session>;
  hostsById: Map<HostId, Host>;
  agentsById: Map<AgentId, Agent>;
  templatesById: Map<TemplateId, WorkspaceTemplate>;

  // Device-local navigation, never inferred to be server truth.
  lastTabByWorkspace: Map<WorkspaceId, TabId>;
  selectedPaneByTab: Map<string, PaneId>; // key workspaceId + ":" + tabId

  // Ephemeral launch intent.
  pendingLaunchBySession: Map<SessionId, string>;

  // Live overlay-only transport, absent for unmounted terminals.
  connectionBySession: Map<SessionId, SessionConnectionState>;
}

export interface SessionConnectionState {
  socket: "idle" | "connecting" | "open" | "closed" | "error";
  dataChannelsOpen: boolean;
  path: "direct" | "stun" | "relay" | null;
  rttMs: number | null;
  trust: "verified" | "first_contact" | "raw" | null;
  refusal: string | null;
  owner: boolean | null;
  viewers: number | null;
}
```

### Row and rollup view models

```ts
// domain/selectors.ts
export type PaneListItem = TerminalListItem | FilesListItem | MissingListItem;

export interface BasePaneListItem {
  paneId: PaneId;
  workspaceId: WorkspaceId;
  tabId: TabId;
  order: number;
  geometry: Pick<Tile, "x" | "y" | "w" | "h">;
}

export interface TerminalListItem extends BasePaneListItem {
  kind: "terminal";
  sessionId: SessionId;
  title: string;
  detail: string;
  typeLabel: string;
  icon: ResolvedAgentIcon;
  statusLabel: string;
  statusTone: ActivityTone;
  statusPulse: boolean;
  attention: Attention;
  running: boolean;
}

export interface FilesListItem extends BasePaneListItem {
  kind: "files";
  title: string;
  detail: string;
  hostId: HostId;
  path: string;
  hostOnline: boolean;
}

export interface MissingListItem extends BasePaneListItem {
  kind: "missing";
  title: "Session unavailable";
  statusTone: "offline";
}

export interface TabStats {
  tiles: number;
  terminals: number;
  widgets: number;
  running: number;
  waiting: number;
  dead: number;
  attention: number;
  nominalRemaining: number;
  canAdd: boolean;
}

export interface WorkspaceStats {
  tabs: number;
  tiles: number;
  terminals: number;
  widgets: number;
  running: number;
  waiting: number;
  dead: number;
  attention: number;
  remainingTabs: number;
  nominalRemainingPanes: number;
  archived: boolean;
  recency: number;
}
```

Selectors to ship:

```ts
export function selectOrderedWorkspaces(
  state: DomainState,
  archived: boolean
): Workspace[];

export function selectActiveTabId(
  workspace: Workspace,
  input: {
    explicitTabId?: TabId | null;
    focusPaneId?: PaneId | null;
    deviceTabId?: TabId | null;
  }
): TabId;

export function selectTabs(workspace: Workspace): WorkspaceTab[];

export function selectTabHome(
  workspace: Workspace,
  tabId: TabId
): { host_id: HostId; cwd: string } | null;

export function selectTabItems(
  state: DomainState,
  workspaceId: WorkspaceId,
  tabId: TabId
): PaneListItem[];

export function selectTabStats(
  state: DomainState,
  workspaceId: WorkspaceId,
  tabId: TabId
): TabStats;

export function selectWorkspaceStats(
  state: DomainState,
  workspaceId: WorkspaceId
): WorkspaceStats;

export function selectSessionTitle(session: Session): string;
export function selectSessionTone(session: Session): ActivityTone;
export function selectSessionAttention(session: Session): Attention;
export function selectRunningAgent(
  session: Session,
  agents: readonly Agent[]
): Agent | null;
export function selectAgentIdentity(
  session: Session
): ResolvedAgentIcon;
```

`selectTabItems` must sort geometry first, never the Session list response:

```ts
export function selectTabItems(state, workspaceId, tabId): PaneListItem[] {
  const workspace = requireWorkspace(state, workspaceId);
  const tab = requireTab(workspace.layout, tabId);
  return readingOrderTiles(tab.layout.tiles).map((tile, order) => {
    const base = {
      paneId: tile.session_id,
      workspaceId,
      tabId,
      order,
      geometry: { x: tile.x, y: tile.y, w: tile.w, h: tile.h },
    };

    if (tile.widget) {
      const host = state.hostsById.get(tile.widget.host_id);
      return {
        ...base,
        kind: "files",
        title: "Files — " + (basename(tile.widget.path) || tile.widget.path),
        detail: (host?.name ? host.name + " · " : "") + tile.widget.path,
        hostId: tile.widget.host_id,
        path: tile.widget.path,
        hostOnline: host?.status === "online",
      };
    }

    const session = state.sessionsById.get(tile.session_id as SessionId);
    if (!session) {
      return {
        ...base,
        kind: "missing",
        title: "Session unavailable",
        statusTone: "offline",
      };
    }

    const identity = resolveAgentIcon(null, session.foreground_command);
    return {
      ...base,
      kind: "terminal",
      sessionId: session.id,
      title: sessionTitle(session),
      detail: sessionTitleDetail(session),
      typeLabel: identity.label,
      icon: identity,
      statusLabel: sessionActivityLabel(session),
      statusTone: sessionActivityTone(session),
      statusPulse: session.activity_state === "active",
      attention: sessionNeedsAttention(session),
      running: session.status !== "exited" && session.status !== "killed",
    };
  });
}
```

### Repository/API interface

```ts
// domain/repository.ts
export interface SpawnRepository {
  listWorkspaces(input?: { archived?: boolean }): Promise<Workspace[]>;
  getWorkspace(id: WorkspaceId): Promise<Workspace>;
  createWorkspace(input?: {
    name?: string;
    first_session?: {
      host_id: HostId;
      cwd: string;
      skill_ids?: UUID[];
    };
    host_id?: HostId;
    cwd?: string;
    icon?: string | null;
    icon_source?: WorkspaceIconSource;
  }): Promise<{ workspace: Workspace; session: Session | null }>;
  patchWorkspace(
    id: WorkspaceId,
    patch: {
      name?: string;
      layout?: WorkspaceLayoutV3;
      position?: number;
      host_id?: HostId;
      cwd?: string;
      icon?: string | null;
      icon_source?: WorkspaceIconSource;
    }
  ): Promise<Workspace>;
  archiveWorkspace(id: WorkspaceId): Promise<Workspace>;
  unarchiveWorkspace(id: WorkspaceId): Promise<Workspace>;
  deleteWorkspace(id: WorkspaceId): Promise<void>;

  listSessions(input?: { host_id?: HostId }): Promise<Session[]>;
  getSession(id: SessionId): Promise<Session>;
  createSession(input: {
    host_id: HostId;
    cwd: string;
    name?: string;
    skill_ids?: UUID[];
    workspace_id?: WorkspaceId;
    tile?: { x: number; y: number; w: number; h: number };
  }): Promise<Session>;
  renameSession(id: SessionId, name: string | null): Promise<Session>;
  restartSession(id: SessionId): Promise<Session>;
  deleteSession(id: SessionId): Promise<void>;
  getSessionAccess(id: SessionId): Promise<{ session_id: SessionId; skills: Skill[] }>;
  setSessionAccess(id: SessionId, skill_ids: UUID[]): Promise<SessionAccess>;

  listHosts(): Promise<Host[]>;
  listAgents(): Promise<Agent[]>;
  listHostAgents(hostId: HostId): Promise<{ agents: HostAgentStatus[] }>;
  listTemplates(): Promise<WorkspaceTemplate[]>;
  createTemplate(input: CreateTemplateInput): Promise<WorkspaceTemplate>;
  patchTemplate(id: TemplateId, input: PatchTemplateInput): Promise<WorkspaceTemplate>;
  deleteTemplate(id: TemplateId): Promise<void>;
}
```

### Layout mutation coordinator

Because tab/pane operations replace a shared envelope, every mutation should use one primitive:

```ts
// domain/layout-mutations.ts
export type LayoutRecipe =
  (latest: WorkspaceLayoutV3, workspace: Workspace) =>
    WorkspaceLayoutV3 | null;

export interface WorkspaceLayoutMutator {
  mutate(
    workspaceId: WorkspaceId,
    recipe: LayoutRecipe
  ): Promise<Workspace>;
}

export function createWorkspaceLayoutMutator(
  repo: SpawnRepository
): WorkspaceLayoutMutator {
  const chains = new Map<WorkspaceId, Promise<unknown>>();

  return {
    mutate(workspaceId, recipe) {
      const prior = chains.get(workspaceId) ?? Promise.resolve();
      const next = prior.then(async () => {
        const workspace = await repo.getWorkspace(workspaceId);
        const layout = recipe(workspace.layout, workspace);
        if (layout === null) return workspace;
        assertValidEnvelope(layout);
        return repo.patchWorkspace(workspaceId, { layout });
      });
      chains.set(workspaceId, next.catch(() => undefined));
      return next;
    },
  };
}
```

This preserves sequential device-local intent and ensures recipes see the freshest fetched envelope. Again, it does not provide cross-device CAS.

### Mutation functions to ship

```ts
// domain/mutations.ts
export interface WorkspaceMutations {
  createEmpty(input: {
    hostId: HostId;
    cwd: string;
    name?: string;
  }): Promise<Workspace>;

  createWithFirstSession(input: {
    hostId: HostId;
    cwd: string;
    name?: string;
    agentId?: AgentId;
    skillIds?: UUID[];
  }): Promise<{ workspace: Workspace; session: Session }>;

  renameWorkspace(id: WorkspaceId, name: string): Promise<Workspace>;
  reorderWorkspace(id: WorkspaceId, position: number): Promise<Workspace>;
  archive(id: WorkspaceId): Promise<Workspace>;
  unarchive(id: WorkspaceId): Promise<Workspace>;
  deleteWorkspace(id: WorkspaceId): Promise<void>;

  createTab(workspaceId: WorkspaceId): Promise<Workspace>;
  renameTab(
    workspaceId: WorkspaceId,
    tabId: TabId,
    name: string
  ): Promise<Workspace>;
  reorderTab(
    workspaceId: WorkspaceId,
    tabId: TabId,
    toIndex: number
  ): Promise<Workspace>;
  setTabHome(
    workspaceId: WorkspaceId,
    tabId: TabId,
    home: { host_id: HostId; cwd: string } | null
  ): Promise<Workspace>;
  duplicateTab(workspaceId: WorkspaceId, tabId: TabId): Promise<Workspace>;
  closeTab(workspaceId: WorkspaceId, tabId: TabId): Promise<Workspace>;

  launchTerminal(input: {
    workspaceId: WorkspaceId;
    tabId: TabId;
    hostId: HostId;
    cwd: string;
    name?: string;
    agentId?: AgentId;
    skillIds?: UUID[];
    placement?: Rect;
  }): Promise<Session>;

  addFiles(input: {
    workspaceId: WorkspaceId;
    tabId: TabId;
    hostId: HostId;
    path: string;
    placement?: Rect;
  }): Promise<Workspace>;

  movePaneToTab(input: {
    workspaceId: WorkspaceId;
    paneId: PaneId;
    targetTabId: TabId;
  }): Promise<Workspace>;

  reorderPanes(
    workspaceId: WorkspaceId,
    tabId: TabId,
    orderedPaneIds: PaneId[]
  ): Promise<Workspace>;

  removePaneFromWorkspace(
    workspaceId: WorkspaceId,
    paneId: PaneId
  ): Promise<Workspace>;

  duplicatePane(
    workspaceId: WorkspaceId,
    paneId: PaneId
  ): Promise<Workspace>;

  renameSession(id: SessionId, name: string | null): Promise<Session>;
  restartSession(id: SessionId): Promise<Session>;
  closeSession(
    workspaceId: WorkspaceId | null,
    id: SessionId
  ): Promise<void>;

  captureTemplate(
    workspaceId: WorkspaceId,
    name: string
  ): Promise<WorkspaceTemplate>;
  instantiateTemplate(input: {
    templateId: TemplateId;
    hostId: HostId;
    cwd: string;
  }): Promise<{ workspaceId: WorkspaceId; focusSessionId: SessionId | null }>;
}
```

Important implementation rules:

- `createTab`, tab rename/home/reorder, pane move/reorder/remove and Files addition are layout recipes.
- `launchTerminal` must set the intended active tab in freshest layout before Session create because the POST lacks tab ID.
- `closeSession` deletes process first and performs layout cleanup best-effort, matching standalone behavior.
- `closeTab` must expose partial-delete failure rather than pretend atomicity.
- duplicate flows must delete newly created invisible Sessions when layout commit fails.
- archive/unarchive use dedicated endpoints, never emulate them with local status/layout edits.
- template instantiation must report partial failure because no cross-call transaction exists.

### Pending launch and terminal readiness

```ts
// domain/pending-launch.ts
export interface PendingLaunchStore {
  set(sessionId: SessionId, command: string): void;
  take(sessionId: SessionId): string | null;
  clear(sessionId: SessionId): void;
}

export interface TerminalCommandSink {
  sendInput(data: string): void;
  focus(): void;
}

export function onTerminalReady(
  pending: PendingLaunchStore,
  sessionId: SessionId,
  terminal: TerminalCommandSink
): void {
  const command = pending.take(sessionId);
  if (command === null) return;
  terminal.sendInput(command + "\r");
  terminal.focus();
}
```

Agent switching must use a separate `runInShell` coordinator with the confirmed Ctrl-C/poll behavior; it must not reuse pending-launch because the Session already has a foreground owner.

### Alert integration

```ts
export interface AlertCoordinator {
  connect(): void; // /ws/alerts, spawn.alerts.v1
  close(): void;
  subscribe(listener: (event: AlertEvent) => void): () => void;
}

function onAlert(event: AlertEvent): void {
  invalidateSession(event.session_id);
  invalidateSessionList();
  // notification presentation/mute/dedupe is UI/platform policy
}
```

Keep dedupe identity based on event `at` plus event/session identity. Keep attention badges selector-driven after refresh.

### Expo Go constraint

Everything in this proposed domain module—types, maps, grid algebra, selectors, REST calls, WebSocket signaling framing, command construction and mutation orchestration—is JavaScript/TypeScript and compatible with Expo Go.

The domain recommendation does not require a custom native module. The eventual terminal transport implementation must provide WebRTC/DataChannels somehow within Expo Go's available runtime; that transport choice belongs to the terminal/protocol research topic. This module should depend only on an injected `TerminalCommandSink`/connection-state adapter, so any Expo Go fallback does not fork workspace/session semantics.

**UNKNOWN:** whether the final Expo Go runtime exposes the required two reliable ordered DataChannels with the project's signed signaling flow is outside this report's assigned domain. The native transport implementation must resolve it; the workspace model must not assume a WebView fallback.

## Implementation checklist for the orchestrator

- Treat Workspace layout as a whole versioned document, not normalized server tab/pane resources.
- Preserve all desktop rectangles and widget payloads on every phone mutation.
- Use reading order for native lists and local state for tab swipe/selected overlay.
- Carry process, activity, host, transport and attention as separate state dimensions.
- Port exact agent definitions, command quoting/yolo rules and inline vector marks.
- Launch an Agent only after its login-shell terminal is ready; document ephemeral pending intent.
- Use `autoPlace`, not tile count, to enable Add.
- Match archive, restart and delete identity semantics exactly.
- Test the ported grid against `proto/layout-v3-fixtures.json`.
- Make last-writer-wins layout behavior visible in data-layer design; never silently merge stale envelopes.
