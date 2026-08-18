# UI/UX Overhaul — Workspaces, Sessions, Onboarding

**Status:** approved spec, ready for implementation
**Date:** 2026-08-19
**Scope:** full-stack (web, server, daemon, proto, docs). Pre-release: breaking changes are allowed, **data loss is not** — internal users' accounts, hosts, pairings, trust state, and running PTYs must survive every migration.

This document is the single coordination artifact for parallel implementation. Every interface that two workstreams share is **locked here** (§4). A workstream builds against the contracts in this doc, not against another workstream's branch. If a contract turns out to be wrong, fix the contract in this doc first, then the code.

---

## 1. Goals and ground rules

The product today is fragmented: five nav destinations, a multi-screen agent-creation form, a segmented setup experience, and a "Screens" surface bolted next to an "Agents" list. The overhaul collapses this into:

1. A **guided onboarding flow** on its own route that takes a new user from signup to a running shell.
2. A **single main page**: a workspace with a grid of terminal panes, navigated by a left sidebar (workspaces → sessions tree).
3. A **settings modal** (like the current account modal) holding everything that used to be a nav destination.
4. **Shell-first sessions**: every pane is a shell; AI agents are one-click shortcuts typed into that shell; Ctrl+C returns to the shell.
5. A **free-form packed grid** with real-time drag, snap, and auto-sizing.

Ground rules (from the project owner, non-negotiable):

- **No hacks, no dead code.** Old routes, components, tables, endpoints, and protocol frames are deleted, not hidden. Deleting and recreating files is encouraged.
- **Everything centralized.** No component-local colors, spacing constants, or one-off styles. All visual decisions flow through design tokens (`globals.css`) and shared primitives (`web/src/components/ui/`).
- **Data-preserving migrations.** Internal users are on this. Every schema and protocol change ships with a proper migration. "Clean slate" is never the mechanism.
- **Standards move with the code.** `docs/DESIGN.md`, `proto/README.md`, `README.md`, and this doc's contracts are updated by the workstream that changes the behavior, in the same PR.
- **Mobile stays first-class.** Every feature spec below includes its mobile behavior; a workstream is not done until both are done.
- **Reliability over cleverness.** Pure, unit-tested modules for anything algorithmic (grid algebra, path math, migrations). Deterministic behavior everywhere; no timing-dependent UI.

---

## 2. Vocabulary (canonical, use everywhere)

| New term | Replaces | Definition |
|---|---|---|
| **Workspace** | Screen | A named grid of session tiles. Table `workspaces`, API `/api/workspaces`, route `/w/[id]`. |
| **Session** | Agent (the DB record) | A PTY on a host. Always starts as the user's login shell in a chosen directory. Table `sessions`, API `/api/sessions`, route `/sessions/[id]`. |
| **Agent** | Preset | A launchable CLI tool definition: name, kind, command, env prefix, install command, logo. Table `agents`, API `/api/agents`. Not a process — a shortcut. |
| **Host** | Host | Unchanged. |
| **Skill** | Skill | Unchanged. |

The words "screen" and "preset" must not appear anywhere in the codebase after Phase C except in migration files and this doc. The Phase C audit greps for them (§9).

Renaming order matters in the DB because `agents` is both an old and a new table name: migration first renames `agents → sessions`, then `presets → agents` (§4.1).

---

## 3. Target architecture overview

```
/login /signup ─▶ /onboarding (account ▸ verify email ▸ connect host ▸ done)
                        │
                        ▼
   / ──redirect──▶ /w/[last-open workspace]
                        │
   ┌────────────────────┴─────────────────────────────┐
   │ Sidebar                │ Workspace grid           │
   │  [+ New workspace]     │  ┌──────┐ ┌──────┐      │
   │  ▸ Workspace 1         │  │ pane │ │ pane │      │
   │    · session (icon)    │  │ shell│ │claude│      │
   │    · session           │  └──────┘ └──────┘      │
   │    [+ add session]     │   $ ▍                    │
   │  ▸ Workspace 2         │   [◆ codex][✳ claude]…  │ ← shortcut bar: overlay
   │                        │                          │   under the shell cursor
   │  ──────────────        │                          │
   │  ⚙ Settings (modal)    │                          │
   │  ◉ account             │                          │
   └──────────────────────────────────────────────────┘
```

- A session is created by the **`+` cascade menu**: (host, if >1) → location (Home / Recent / Select folder…). No form, no separate page.
- The daemon spawns the user's **login shell** — never an agent binary directly. The pane shows a **shortcut bar** of agent buttons (with logos) whenever the shell is in the foreground; clicking one types the agent's command into the PTY. Ctrl+C inside the agent returns to the shell naturally.
- The daemon reports the **foreground process name** (basename only) so the UI knows what's running in each pane: sidebar icons, pane headers, and shortcut-bar visibility all derive from it.
- The grid is a **12×12 packed grid** (no vertical scroll — every pane always visible), with drag-to-move, edge/corner resize, collision push, and gravity compaction.

Terminal transport (WebRTC DataChannels, warm pool, keep-alive portals) is **unchanged in behavior** — only renamed. The pool/portal mechanism in `LiveTerminalProvider` + the `ScreenPane` slot-portal pattern is load-bearing (it keeps sockets alive across layout changes) and must be preserved in the new `WorkspaceGrid`.

---

## 4. Locked contracts

### 4.1 Database migrations (server, alembic `0029`–`0034`)

Current head is `0028`. All migrations must have working `upgrade()` **and** `downgrade()`, and a pytest that runs the chain against a fixture DB seeded with representative pre-overhaul data (split-tree layouts, archived agents, built-in + custom presets).

**`0029_agents_to_sessions`**
- Rename table `agents → sessions`.
- Drop columns: `argv`, `env`, `preset_id`, `archived_at`, `pinned_at`. (Sessions are always the host's login shell; archiving and pinning are retired concepts. Rows for archived agents are deleted by this migration — they have no UI anymore.)
- Add column: `foreground_command VARCHAR(255) NULL`.
- Rename table `agent_skill_grants → session_skill_grants`; rename column `agent_id → session_id`.

**`0030_presets_to_agents`**
- Rename table `presets → agents`.
- Convert `default_argv JSON (list)` → `command VARCHAR(1024)` (shell-join with quoting; migration includes the join helper).
- Rename `env_template → env`.
- Keep `agent_kind → kind`, `install`, `owner_user_id`, `name` (unique per owner).
- Delete the built-in `shell` row (sessions are shells; the shortcut is meaningless).
- Rename table `host_tool_policies → host_agent_policies`; rename column `preset_id → agent_id`.

**`0031_screens_to_workspaces`**
- Rename table `screens → workspaces`.
- Drop columns `ephemeral`, `pinned_at` (retired concepts — no ephemeral workspaces in the new UX).
- Add `position INTEGER NOT NULL DEFAULT 0`; backfill by `name` order.
- Convert `layout` JSON from split-tree v1 to grid v2 using the algorithm in §4.4. Layouts referencing sessions deleted in 0029 have those tiles dropped first. Empty result → `{"version": 2, "tiles": []}`.

**`0032_recent_dirs`**
```sql
CREATE TABLE recent_dirs (
  id VARCHAR(36) PRIMARY KEY,
  owner_user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host_id VARCHAR(36) NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  path VARCHAR(1024) NOT NULL,
  last_used_at DATETIME NOT NULL,
  UNIQUE (owner_user_id, host_id, path)
);
```
Backfill from surviving `sessions.cwd` (newest `started_at` per distinct path, cap 8 per host).

**`0033`/`0034`** — reserved for anything the server workstream discovers; keep the chain linear.

### 4.2 HTTP API (new surface)

Unchanged routers: auth, account_recovery, auth_providers, device, install, admin, capabilities (paths under it renamed, see below), browser_devices, trust_bundle. Everything else:

**Sessions — `/api/sessions`** (was `/api/agents`)

```jsonc
// POST /api/sessions  → 201 SessionOut
{
  "host_id": "uuid",            // required
  "cwd": "/abs/path",           // required
  "name": "optional ≤128",
  "skill_ids": ["uuid"],        // omitted → all enabled_by_default
  "workspace_id": "uuid",       // optional: transactionally append a tile to that workspace
  "tile": {"x":0,"y":0,"w":6,"h":12}  // optional; omitted → server auto-places (§4.4)
}
```
- No `argv`, `env`, `preset_id`, or `install` — the daemon always spawns the login shell.
- Server side effects: dispatch `session.create` (§4.3); upsert `recent_dirs (owner, host, cwd)`; if `workspace_id` given, validate+append the tile inside the same transaction (invalid/overlapping explicit tile → 400; omitted tile → auto-place).
- `GET /api/sessions` (query `host_id?`) — no `include_archived` anymore.
- `GET /api/sessions/{id}`, `PATCH /api/sessions/{id}` (`{name?}` only), `POST /api/sessions/{id}/restart` (respawns the shell in `cwd`), `DELETE /api/sessions/{id}` (kill + hard delete, unchanged semantics).
- `SessionOut`: `id, name, host_id, host_name, cwd, status, started_at, exited_at, exit_code, last_output_at, last_input_at, last_activity_at, activity_state, activity_label, foreground_command`. Activity derivation is unchanged (`routes/agents.py:_activity` logic moves to `routes/sessions.py`).
- Skills access: `GET/PATCH /api/sessions/{id}/access` (was `/api/agents/{id}/access`).

**Workspaces — `/api/workspaces`** (was `/api/screens`)

```jsonc
// POST /api/workspaces → 201 { "workspace": WorkspaceOut, "session": SessionOut | null }
{
  "name": "optional",           // default "Workspace N" (server computes next free N)
  "first_session": {            // optional: create workspace + first shell atomically
    "host_id": "uuid", "cwd": "/abs/path", "skill_ids": ["uuid"]
  }
}
```
- `first_session` gets tile `{x:0,y:0,w:12,h:12}`.
- `GET ""` (ordered by `position`), `GET /{id}`, `PATCH /{id}` (`{name?, layout?, position?}`), `DELETE /{id}` → kills and deletes every session referenced by its tiles, then deletes the workspace. 204. (Client always confirms first.)
- Layout validation (server-side, pydantic): §4.4 rules. No ephemeral/410 behavior — deleting the last tile just leaves an empty workspace.

**Agents (definitions) — `/api/agents`** (was `/api/presets`)

- `AgentOut`: `id, owner_user_id (null = built-in), name, kind, command (string), env (dict), install (string|null)`.
- `GET ""`, `POST ""`, `PATCH /{id}`, `DELETE /{id}`. Built-ins immutable (404 on write) — unchanged rule.
- Built-ins re-seeded idempotently: `claude-code`, `codex`, `opencode`, `aider-sonnet` (same commands/installs as today, minus `shell`).

**Hosts — availability renamed**

- `GET /api/hosts/{id}/agents` (was `/tools`) → `{ "agents": [HostAgentStatus] }` — same fields as today's `HostToolStatus` with `preset_id/preset_name` → `agent_id/agent_name`.
- `POST /api/hosts/{id}/agents/{agent_id}/install`, `PATCH /api/hosts/{id}/agents/{agent_id}/policy` — same semantics as today's tool install/policy.
- **New:** `GET /api/hosts/{id}/recent-dirs` → `{ "dirs": [{"path": "...", "last_used_at": "..."}] }`, newest first, max 8.

**Auth config — new**

- `GET /api/auth/config` → `{ "providers": [{id,name}], "email_verification_required": bool, "invite_only": bool }`. Replaces `GET /api/auth/providers` (delete it). `email_verification_required` = `SPAWN_REQUIRE_EMAIL_VERIFICATION && mailer_ready()` — the exact condition `auth.verified_user` enforces, so onboarding never shows a gate the server won't enforce.

### 4.3 Daemon protocol v3 (`spawn.control.v3`)

Clean break: the server requires subprotocol `spawn.control.v3`; a v2 daemon gets the existing `protocol.required` close (4003) and shows as offline until the user re-runs `install.sh`. **Running PTYs survive** the daemon upgrade because workers are separate processes adopted over the private socket (see below).

Frame renames (all payload fields `agent_id → session_id`):

| v2 | v3 |
|---|---|
| `agent.create` | `session.create` — payload `{session_id, cwd, skills, create_cwd}`. **No `argv`, `env`, `install`.** Daemon resolves the shell: `$SHELL` from the daemon's env if executable, else `/bin/zsh` (macOS) / `/bin/bash`, invoked with `-l`. Env computation (normalize, PATH enrichment, skills materialization) unchanged. |
| `agent.restart` | `session.restart` — same payload |
| `agent.kill` | `session.kill` |
| `agent.started` | `session.started` |
| `agent.exit` | `session.exit` |
| `agent.activity` | `session.activity` |
| `agent.input_activity` | `session.input_activity` |
| `host.tools.check` / `check_result` | `host.agents.check` / `check_result` — target fields `preset_id/preset_name → agent_id/agent_name`; targets carry `command` as the binary to `which` (first word of the agent's command string, computed server-side) |
| `host.tools.install` / `install_result` | `host.agents.install` / `install_result` |
| `register` `existing_agents` | `existing_sessions` |

**New frame — foreground reporting (daemon → server):**

```jsonc
{"type": "session.foreground", "session_id": "uuid", "command": "claude"}
```
- `command` is the **basename only** of the foreground process's executable, max 64 chars, no arguments, no paths. Emitted only when the value changes, min interval 1s.
- Worker implementation: poll every 1s — `tcgetpgrp(master_fd)` → fg pgid → process name (`/proc/<pgid>/comm` on Linux, `libproc proc_name`/`sysctl KERN_PROC` on macOS). New worker-wire frame `T_FOREGROUND (0x11)`, **additive** — worker wire stays `PROTO_VERSION 5`-compatible so a new spawnd can still adopt old workers (which simply never send it; their sessions report `foreground_command: null`).
- Server stores it in `sessions.foreground_command` and includes it in `SessionOut`.
- **Privacy note (must land in `docs/TRUST.md` and `proto/README.md`):** this is a deliberate, documented exception to the content-free activity design — a process basename, nothing else, and it exists so the UI can label panes. No arguments, no output, no titles.

**RTC scope rename:** `scope_type: "agent" → "session"`, browser WS query `?agent_id= → ?session_id=`. This touches the signed-signal envelope transcript: bump the signed-signal spec revision, update `daemon/src/signed_signal*.rs`, `web/src/lib/signed-signal*.ts`, and **regenerate the test vectors** in `proto/*-vectors.json` with the existing vector tooling. DataChannel labels (`spawn.pty`, `spawn.ctl`, `spawn.host.ctl`) and their internal protocols are unchanged.

`proto/README.md` is rewritten for v3 by the daemon workstream (it owns the protocol), reviewed by the server workstream.

### 4.4 Workspace grid — layout schema v2 and algebra

**Schema (wire + DB):**

```jsonc
{
  "version": 2,
  "tiles": [ {"session_id": "uuid", "x": 0, "y": 0, "w": 6, "h": 12} ]
}
```

Invariants (validated server-side on every write, enforced client-side by construction):
- Canvas is exactly **12 columns × 12 rows**; the grid always fills the pane area — no vertical scroll, every pane visible (tmux-like).
- Integers only. `0 ≤ x`, `x+w ≤ 12`, `0 ≤ y`, `y+h ≤ 12`, `w ≥ 3`, `h ≥ 3`.
- No two tiles overlap. Max **8 tiles** per workspace. Duplicate/unowned `session_id`s are pruned server-side (same policy as today's sanitizer).

**Pure algebra module** — implemented twice, from the same fixtures:
- `web/src/lib/grid.ts` (TypeScript, exhaustively unit-tested)
- `server/spawn_server/grid.py` (Python — used by layout validation, auto-place, and migration 0031)

Both must pass the shared fixture suite **`proto/layout-v2-fixtures.json`** (owned by the grid workstream): a list of `{op, input, expected}` cases covering every function below. This is the collision-proof way to keep the two implementations identical.

Functions (deterministic, no randomness):
- `validate(layout)` — the invariants above.
- `autoPlace(tiles) -> tile` — first free 3×3 position scanning `y` then `x`; greedily expand `w` rightward while free, then `h` downward. If no 3×3 is free: take the largest-area tile, split it along its longer axis (ties → vertical split), shrink it to the first half, return the second half as the new tile. (Cap of 8 tiles on a 12×12 canvas guarantees this terminates.)
- `move(tiles, id, x, y) -> tiles` — place the tile at the target; tiles it overlaps are pushed down (increasing `y`), cascading; then `compact`.
- `resize(tiles, id, w, h) -> tiles` — clamp to invariants, push collisions down, `compact`.
- `remove(tiles, id) -> tiles` — drop the tile, `compact`, then greedily expand remaining tiles (in reading order) into freed space (right, then down) so the canvas stays filled where possible.
- `compact(tiles) -> tiles` — gravity: sort by `(y, x)`, move each tile up as far as it goes, then left.
- `readingOrder(tiles) -> id[]` — sort by `(y, x)`. Used for the mobile stack and keyboard focus order.
- `fromSplitTree(v1root) -> tiles` — migration converter: recursively assign float rects starting from `(0,0,12,12)`, `row` split gives `a` `ratio*w`; round to ints; if any resulting tile violates `w≥3 || h≥3` or overlaps after rounding, **fall back** to placing the panes in v1 DFS order (a-then-b) with repeated `autoPlace`. Deterministic either way.

### 4.5 Web route map

| Route | Content | Notes |
|---|---|---|
| `/` | Signed out → marketing landing (unchanged). Signed in → redirect: onboarding incomplete → `/onboarding`; else → `/w/{last-open}` (localStorage `spawn.workspaces.last`, fallback first by `position`); zero workspaces + ≥1 host → create "Workspace 1"+shell then redirect; zero hosts → `/onboarding?step=host` unless skipped, else empty state. | |
| `/onboarding` | The guided flow (§5.1). | new |
| `/w/[id]` | Workspace view (§5.2, §5.4–5.6). | new |
| `/sessions/[id]` | Full-screen single session (rebuilt from `/agents/[id]`: header, terminal, files aside, session switcher). | renamed |
| `/login`, `/signup` | Restyled to onboarding shell; signup → `/onboarding`. | keep |
| `/forgot-password`, `/reset-password`, `/verify-email` | Keep; `/verify-email` redirects into `/onboarding` when onboarding is incomplete. | keep |
| `/device` | Enter-code pairing. Page stays (daemons print this URL); its form component is reused by onboarding and Settings ▸ Hosts. | keep |
| `/hosts/[id]`, `/hosts/[id]/files` | Kept as detail routes, linked from Settings ▸ Hosts. Restyled with the new shell. | keep |
| `/download`, `/security`, `/admin` | Unchanged (admin gets token cleanup only). | keep |
| **Deleted** | `/agents`, `/agents/new`, `/agents/[id]`, `/screens`, `/screens/[id]`, `/presets`, `/hosts` (list page — the settings tab replaces it), `/settings`, `/trust` | Old URLs get `redirect()`s in `next.config.ts` → `/` (or `/sessions/[id]` for `/agents/[id]`) so stale bookmarks don't 404. |

### 4.6 Design system contracts

**Tokens (`web/src/app/globals.css`)** — single source of truth for all color/spacing/motion. Additions (defined for `:root` light **and** `[data-theme="dark"]`, exposed via `@theme inline` as Tailwind utilities):

```css
/* semantic status — replaces every hardcoded emerald/amber/sky/violet/red/zinc literal */
--success, --success-soft        /* soft = 10–20% surface tint for chips/badges */
--warning, --warning-soft        /* "attention" uses warning */
--info,    --info-soft
--danger,  --danger-soft         /* alias of --destructive family; pick one name, delete the other */
--tone-active, --tone-waiting, --tone-idle, --tone-offline  /* status dots */
/* chrome geometry — replaces TS constants scattered in components */
--sidebar-width: 264px; --sidebar-rail-width: 56px;
--row-h: 2.25rem;                /* the 36px nav row rhythm */
--pane-gap: 6px;                 /* grid gutter */
```

Rules (add to `docs/DESIGN.md`):
- No Tailwind palette literals (`emerald-500`, `amber-400`, …) anywhere in `web/src/` outside `globals.css`. Biome can't enforce this; the Phase C grep gate does (§9).
- Container queries for layout responsiveness (the existing `@container/shell` pattern), viewport `md:` only for overlays. `BottomTabs`'s bare `@md:` bug disappears with the file.
- Every interactive element uses `ui/` primitives; a new visual pattern becomes a primitive first, then gets used.

**Primitives (`web/src/components/ui/`)** — existing set stays (button, input, badge, card, dropdown-menu, sheet, skeleton, status, textarea, tooltip, label) with literals replaced by tokens. New primitives:

| File | Contract |
|---|---|
| `dialog.tsx` | Radix Dialog wrapper: `Dialog, DialogContent (size: "sm"\|"md"\|"lg"\|"full-mobile"), DialogHeader, DialogTitle, DialogFooter`. SettingsDialog, folder picker, and confirms all build on it. |
| `confirm.tsx` | `useConfirm() → confirm({title, body, confirmLabel, destructive}) : Promise<boolean>`. Replaces every `window.prompt`/inline confirm. |
| `cascade-menu.tsx` | Multi-step dropdown for the `+` flow: `CascadeMenu` renders a stack of panels with slide transition, back button, keyboard nav (arrows/Enter/Escape), and a loading state per panel. Generic: panels are `{id, title?, items: [{icon?, label, detail?, onSelect \| panel}]}`. |
| `drawer.tsx` | Left slide-in drawer for the mobile sidebar (scrim, drag-to-dismiss, focus trap, `--vv-height`-capped). |
| `empty-state.tsx` | Icon + title + body + primary action. Used by empty workspace, no-hosts banner, etc. |
| `spinner.tsx` | Single loading affordance (replaces ad-hoc "Loading..." text). |

**Icons:** `web/src/components/icons/AgentIcon.tsx` (moved/rebuilt from `AgentKindIcon`) maps agent `kind` → bundled logo SVG (`claude-code`, `codex`, `opencode`, `aider`), shell kinds (`bash|zsh|fish|sh`) → terminal glyph, anything else → monogram. Used by the sidebar, pane headers, and the shortcut bar.

---

## 5. Feature specs

### 5.1 Onboarding (`/onboarding`)

One route, one client component with a step machine. Steps are **derived, not stored**: `account` (no user) → `verify` (user && !email_verified_at && config.email_verification_required) → `host` (no hosts && not skipped) → `done`. Deep-linkable via `?step=`, but the machine never shows a step whose precondition is already met — logging in mid-way resumes at the right step automatically.

Visual: full-page, centered column (max-w-md), step indicator (4 dots + labels), no sidebar/app chrome. Uses the marketing-adjacent dark treatment on the outside but standard tokens inside the card. Mobile: same single column.

1. **Account** — email+password signup (invite field when `config.invite_only`) plus the OAuth buttons from `config.providers`. Existing users see "log in instead". On success → next step.
2. **Verify email** — "We sent a link to {email}". Resend button (rate-limit aware), auto-advance: poll `GET /api/me` every 5s; when `email_verified_at` lands (user clicked the link in any tab), advance with a success beat. If `config.email_verification_required` is false, this step never renders.
3. **Connect a host** — platform-detected install command (`curl … install.sh | sh`) with copy button (reuse the `/download` detection logic as a shared lib, not a copy-paste), an inline **enter-code** form (the `/device` component), and a live "waiting for your machine…" status polling `GET /api/hosts` every 3s. When the first host flips online → success beat, auto-advance. **"Skip for now"** link (persist `spawn.onboarding.skippedHost = true` in localStorage) → done step; the main page then shows a persistent connect-a-host `empty-state` until a host exists.
4. **Done** — if a host exists and the user has zero workspaces: `POST /api/workspaces {first_session: {host_id, cwd: <host home>}}` (home resolved via the host control channel `fs.home`; if the channel isn't ready in 3s, send `cwd: "~"` — the daemon expands it). Then `router.replace(/w/{id})`.

`AuthGate` gains onboarding awareness: it redirects unauthenticated users to `/login` (unchanged) and lets `/` handle the onboarding redirect (route map §4.5). No other route blocks on onboarding — a half-onboarded user who types `/w/x` and owns it may use it.

### 5.2 App shell, sidebar, and main page

**`AppShell` v2** (`web/src/components/nav/AppShell.tsx`, rebuilt):
- Desktop (`@md/shell:`): resizable/collapsible left sidebar exactly as today (same width persistence keys, same rail collapse — keep that code), main area is the routed page. The old mobile header + BottomTabs are deleted.
- Mobile: slim top bar `h-12`: hamburger (opens `drawer.tsx` containing the full Sidebar), current workspace name, `+` (new-session cascade). Main area below.

**Sidebar** (rebuilt, `web/src/components/nav/Sidebar.tsx` + `SidebarWorkspaceRow.tsx` + `SidebarSessionRow.tsx`):

Top→bottom:
1. Brand row + collapse toggle (keep current behavior/geometry contract: `--row-h` rows, constant icon gutter, labels fade not unmount).
2. **`+ New workspace`** primary button. One online host → instantly `POST /api/workspaces {first_session:{host_id, cwd:"~"}}` and navigate. Multiple hosts → opens the cascade menu (§5.4) and creates workspace+session from the selection. Zero hosts → opens Settings ▸ Hosts.
3. **Workspace list** (ordered by `position`): each row = workspace name, attention badge (sum of its sessions needing attention — amber dot + count chip, token `--warning`), and a chevron on the right. Click row → navigate `/w/[id]`. Click chevron → expand/collapse (persisted per workspace in localStorage) revealing **indented session rows**: `AgentIcon(foreground_command)` + name + `StatusDot(activity)`, live per the 5s poll. Click session row → navigate to its workspace and focus the pane (`?focus=`); the row's kebab has Open full screen (`/sessions/[id]`), Rename, Restart, Close (confirm → DELETE). Below the sessions: a small **`+` add-session row** opening the cascade menu for that workspace. Workspace row kebab: Rename (inline), Move up/down (PATCH `position`), Delete (confirm; explains sessions will be closed).
4. **Hover-highlight contract:** hovering a session row sets `highlightStore.sessionId` (a tiny `useSyncExternalStore` module store in `web/src/lib/highlight-store.ts`); the matching grid tile renders `ring-2 ring-ring`. Mouse-leave clears. Grid panes do the reverse on hover (row gets `bg-accent`).
5. Sticky bottom (above account): **Settings** row (gear icon) → `openSettings("account")`. Then the account row (avatar + email, dropdown: Settings / Log out) as today.

Collapsed rail: workspace initials in `size-9` squares with `RailTooltip`, attention dot overlaid; `+`, settings, and account keep their icons. No Recents section anywhere (retired).

**Workspace page (`/w/[id]`)**: no tab strip. A minimal header (`h-12`): workspace name with inline rename (double-click or kebab), saving indicator, files-aside toggle (desktop), kebab (Rename / Delete workspace). The rest of the viewport is the grid.

### 5.3 Settings modal

Extend the existing `SettingsDialog` (keep its store, shell, and mobile full-screen behavior). New tab list:

| Tab | Content |
|---|---|
| **Account** | Existing `AccountPanel` (verify-email callout, logout, delete account). |
| **Appearance** | Existing `AppearancePanel`. |
| **Hosts** | New `HostsPanel`: host cards (status, os/arch, version, session count) with rename/remove and a link to `/hosts/[id]`; "Connect a host" section = install command + enter-code form (same shared components as onboarding step 3). |
| **Agents** | New `AgentsPanel` (rebuilt from `PresetsManager`): built-ins listed read-only with logos; custom agents CRUD — name, kind, command (single string), env (key=value rows), install command. |
| **Skills** | Existing `SkillsPanel`. |
| **Browser devices** | Existing `DevicesPanel`. |
| **Device trust** | Existing `TrustPanel`. |
| **Admin** (only `is_admin`) | A link row → `/admin`. |

`SettingsTab` union: `"account" | "appearance" | "hosts" | "agents" | "skills" | "devices" | "trust"`. The `/settings` and `/trust` shell routes are deleted; `openSettings` deep-linking stays module-level.

### 5.4 Session creation — the `+` cascade

All `+` entry points (sidebar add-session row, sidebar new-workspace with >1 host, mobile top-bar `+`, empty-workspace CTA) open the same `CascadeMenu`:

- **Step 1 — Host** (only when >1 host): each host with `StatusDot`; offline hosts disabled with "offline" detail. Single host → step skipped entirely.
- **Step 2 — Location:**
  - **Home** — the host's home directory (`~`). First item, default-focused.
  - **Recent** — up to 8 entries from `GET /api/hosts/{id}/recent-dirs`, shown as `folder-name` with the full path as detail. Section hidden when empty.
  - **Select folder…** — opens the folder picker dialog.
- Selecting a location immediately creates the session (`POST /api/sessions` with `workspace_id` + server auto-place) — or workspace+session when invoked from `+ New workspace`. The new tile mounts with a terminal connecting; focus moves to it. No name field, no skills, no review screen (rename later via kebab; skills default to `enabled_by_default`).

**Folder picker dialog** (`web/src/components/workspace/FolderPickerDialog.tsx`, on `ui/dialog`): a fast finder-style browser over the host control channel (`useHostControl` → `fs.home`/`fs.list`), replacing `DirectoryPicker`:
- Breadcrumb path bar (click any segment), editable path input with `~` support (reuse `lib/paths.ts`).
- Directory list (directories only), keyboard navigation (arrows, Enter to descend, Backspace to go up), type-ahead filter, loading skeletons; entries sorted client-side (daemon returns raw readdir order).
- Footer: "New folder" (uses `fs.mkdir`), Cancel, **"Select this folder"**.
- Note: the daemon's fs capability is rooted at the host home — the picker browses the home tree. Paths outside home can still be typed into the path input and are passed through (session cwd is not home-restricted).
- Mobile: `full-mobile` dialog size.

### 5.5 Shell-first sessions and the agent shortcut bar

- Every session **is** the login shell. Killing a foreground agent (Ctrl+C / exit) drops back to the shell prompt — no code needed, it's how shells work. The session only exits when the shell itself exits; the pane then shows an exited state with Restart / Close actions.
- **Shortcut bar** (`web/src/components/workspace/ShortcutBar.tsx`): an overlay **inside the terminal**, anchored directly **below the input cursor** — like an IDE autocomplete popup, not a pane toolbar. A compact, horizontally scrollable pill row (`bg-popover/90` + backdrop blur, `border-border`, max-width = pane width − 16px) that never takes focus; clicking a pill leaves the terminal focused.
  - **Visible when all of:** `session.status === "running"`; `foreground_command` is null or a shell (`bash|zsh|fish|sh|dash|…` — matcher in `lib/sessions.ts`); the **input line is empty** (just-created shells start empty); and the cursor row is on-screen (hidden while scrolled back). It disappears the moment the user starts typing or an agent takes the foreground, and reappears on the next empty prompt.
  - **Empty-input heuristic** (tracked inside `Terminal` from the bytes it sends — deterministic, no prompt parsing): printable bytes and pastes increment a pending-input count; Backspace/DEL decrement it; Enter, Ctrl+C, Ctrl+U, Ctrl+D, and any foreground change reset it to zero. Count 0 ⇔ empty.
  - **Positioning:** top = cursor cell bottom + 4px, left = cursor x clamped to pane padding; flips above the cursor row when there's not enough room below. Repositions on cursor move, output, and resize.
  - **Terminal interface contract** (A5 implements in `components/terminal/`, B2 consumes — locked here because it crosses workstreams):
    ```ts
    // TerminalProps additions
    onCursorMove?: () => void;                              // xterm onCursorMove passthrough
    onPromptStateChange?: (state: "empty" | "typing") => void;
    // TerminalHandle addition
    getCursorRect(): { left: number; top: number; cellWidth: number; cellHeight: number } | null;
    // pixel rect relative to the terminal container; null when the cursor row is scrolled out of view
    ```
- One pill per agent definition (built-ins first, then custom): `AgentIcon` + name. Availability from `["host-agents", host_id]` (`GET /api/hosts/{id}/agents`, staleTime 5 min, refetched when a pane mounts):
  - **Installed** → click focuses the pane and types `{env prefix}{command}\n` into the PTY via the terminal handle (`FOO=bar claude\n`). Env entries from the agent's `env` dict become `KEY=value ` prefixes.
  - **Missing** → pill shows a download glyph + "install & run"; click types `{install} && {env prefix}{command}\n` — fully visible in the terminal, cancellable with Ctrl+C, no hidden execution.
- Pane header shows what's running: `AgentIcon(foreground_command)` + session name + `StatusDot`; sidebar session rows use the same derivation (§5.2).
- The old silent install preflight in the daemon (`run_install`, output discarded) is **deleted** with the `install` field of `session.create`.

### 5.6 Grid interactions

`web/src/components/workspace/WorkspaceGrid.tsx` renders `layout.tiles` as absolutely-positioned tiles (percentage geometry from the 12×12 units, `--pane-gap` gutters). **Terminal keep-alive is preserved**: the slot/portal pattern from the current screens page moves here — one `SessionPane` per session in a stable keyed layer, portaled into whichever tile slot the layout exposes; reshaping never remounts a terminal.

- **Drag to move:** grab the pane header's grip zone. During drag the pane follows the pointer as a `transform` (60fps, no React state per move); a ghost outline shows the snapped target cell (`grid.move` computed live per pointer position, throttled to grid-cell changes); other tiles animate (`transition: transform 150ms var(--ease-swift)`) into their pushed/compacted positions in real time. Release commits.
- **Resize:** SE-corner handle plus invisible edge handles; live ghost + neighbor animation identical to move (`grid.resize`).
- **Persistence:** commits are optimistic (`setQueryData`) and PATCHed with a 500ms debounce; a failed PATCH rolls back to the server copy and toasts the error. Concurrent-tab safety: `PATCH` responses are written back verbatim (server state wins).
- **Zoom:** double-click pane header or `Alt+Z` — client-only fullscreen of one pane (non-zoomed tiles `hidden`, not unmounted). Keyboard: `Alt+arrows` move focus in `readingOrder`; `Alt+1..9` switch workspaces by position.
- **Empty workspace:** `empty-state` with a big `+` opening the cascade menu.
- **Attention:** panes whose session needs attention (existing `agentNeedsAttention` logic, moved to `lib/sessions.ts`) get a `--warning` top hairline; counts roll up to the sidebar.

### 5.7 Mobile

- Sidebar → `drawer.tsx` (left slide-in) with identical content; opens via hamburger. Closes on navigation.
- Workspace: no grid — vertical stack of panes in `readingOrder`, each `min-h-[55dvh]`, with the existing `ModifierBar` on coarse pointers. Drag/resize disabled; the session kebab offers Move up / Move down (swaps in reading order, persisted by re-packing tiles into a 12-wide, stacked layout only if the user reorders on mobile — desktop arrangement is otherwise untouched).
- Shortcut bar: same behavior, larger touch targets (`h-11` pills).
- Cascade menu renders as a bottom sheet (`ui/sheet.tsx`) instead of an anchored dropdown; folder picker is full-screen.
- Settings modal: full-screen (existing behavior).
- Onboarding: single column, works end-to-end on a phone (this is the "install on my laptop, approve from my phone" path — test it).

---

## 6. Explicit deletions

Web (files removed, not stubbed): `app/agents/**`, `app/screens/**`, `app/presets/`, `app/hosts/page.tsx` (list page only), `app/settings/`, `app/trust/`, `components/nav/BottomTabs.tsx`, `components/agents/**` (NewAgentForm, DirectoryPicker, AgentListRow, AgentSwitcher, AgentSurfaceHeader, AgentPaneMenu, AgentKindIcon — rebuilt equivalents live under `components/session/`, `components/workspace/`, `components/icons/`), `components/presets/**`, `components/screens/ScreenIcon.tsx`, `lib/layout.ts`, `lib/screens.ts`, `lib/agents.ts`, `lib/dnd.ts` (grid drag replaces HTML5 DnD; no cross-workspace tile dragging in v1). Dashboard content in `app/page.tsx` (Hosts/Recent agents cards) replaced by the redirect logic.

Server: `routes/screens.py`, `routes/presets.py`, old names in `routes/agents.py` (file becomes `routes/sessions.py`; a new `routes/agents.py` serves definitions), `presets.py` seeder (rebuilt as `agents_builtin.py`), every `AgentCreate.argv/env/preset_id/install` path, archive/pin fields and the `include_archived` query, ephemeral/410 screen logic, `/api/auth/providers`.

Daemon: v2 frame names, `AgentCreate.{argv,env,install}` handling, `run_install` (silent preflight), the `shell` built-in special-casing. (`host.tools.*` internals live on under `host.agents.*` names.)

Concepts retired everywhere: ephemeral screens, pinned screens/agents, archived agents, the Recents sidebar section, the "New agent" CTA, HTML5 agent-drag MIME types.

---

## 7. Workstreams (parallel plan)

Ownership is **per-path**: a workstream may create/modify/delete only inside its owned paths; everything else is read-only. Shared behavior is coordinated exclusively through §4 contracts and the fixture file. Each workstream updates the docs listed in its row **in the same PR** and leaves its area with zero references to retired vocabulary.

### Phase A — foundations (all five run in parallel)

| ID | Workstream | Owns | Depends on | Docs to update |
|---|---|---|---|---|
| **A1** | **Server rewrite**: migrations 0029–0032 (+tests), `models.py`, `schemas.py`, `routes/sessions.py`, `routes/workspaces.py`, `routes/agents.py` (defs), `routes/hosts.py` (agents/recent-dirs), `routes/auth_config`, `grid.py` (validator/auto-place vs fixtures), `ws/daemon.py` + `ws/broker.py` v3 frames, seeder, all server tests | `server/**` | §4.1–4.4 contracts; fixtures file (A4) for grid tests — until it lands, mirror the §4.4 prose | `docs/ADMIN.md` if touched; review `proto/README.md` (A2's PR) |
| **A2** | **Daemon v3**: frame renames, shell resolution in `session.create`, drop argv/env/install, `T_FOREGROUND` + foreground poller (worker), `session.foreground` emit, `host.agents.*`, scope_type rename + signed-signal bump + regenerate vectors, subprotocol v3 | `daemon/**`, `proto/README.md`, `proto/*vectors*` | §4.3 | `proto/README.md` (rewrite), `docs/SESSIOND.md`, `docs/TRUST.md` (foreground disclosure note) |
| **A3** | **Design system**: token additions + literal purge in *surviving* files (`ui/*`, `ConnectionChip`, `FileExplorer`, `HostToolsPanel`→ kept pieces, admin, download, settings panels), new primitives (`dialog`, `confirm`, `cascade-menu`, `drawer`, `empty-state`, `spinner`), `icons/AgentIcon.tsx` + bundled logo SVGs | `web/src/app/globals.css`, `web/src/components/ui/**`, `web/src/components/icons/**`, literal-purge edits in surviving components | §4.6 | `docs/DESIGN.md` (becomes the UI standards doc: tokens, primitives, container-query rules, no-literal rule) |
| **A4** | **Grid engine**: `web/src/lib/grid.ts` + exhaustive unit tests + `proto/layout-v2-fixtures.json` | those files only | §4.4 | fixture file is the doc |
| **A5** | **Web data layer**: rewrite `lib/api.ts` (new types/endpoints per §4.2), `lib/ws.ts` (v3 frames, `session_id`), `lib/auth.ts` (+config), new `lib/sessions.ts` (title/activity/attention/shell-matcher helpers) + `lib/workspaces.ts` (naming, recency) + `lib/highlight-store.ts`; mechanical `agent→session` rename through `components/terminal/**` (props, hooks, `useAgentSocket→useSessionSocket`, `LiveTerminalProvider` pool keys — behavior untouched) plus the cursor/prompt-state exposure for the shortcut bar (`getCursorRect`, `onCursorMove`, `onPromptStateChange` per §5.5); delete `lib/agents.ts`, `lib/screens.ts`, `lib/layout.ts`, `lib/dnd.ts` | `web/src/lib/**` (except grid.ts/theme), `web/src/components/terminal/**` | §4.2, §4.3 | — |

Phase A gate: server tests green against migrated fixture DB; daemon `cargo test` green incl. a real-PTY foreground test; web `bun test src` green; grid fixtures pass in both TS and Python; e2e is expected red until C2.

### Phase B — product surfaces (after A merges; run in parallel)

| ID | Workstream | Owns | Depends on |
|---|---|---|---|
| **B1** | **Shell, sidebar, settings**: `AppShell` v2, `Sidebar` v2 (+ row components, drawer wiring), `SettingsDialog` new tabs, `HostsPanel`, `AgentsPanel`, shared connect-a-host components, `app/page.tsx` redirect logic, `/hosts/[id]` restyle | `web/src/components/nav/**`, `web/src/components/settings/**`, `web/src/components/hosts/**`, `app/page.tsx`, `app/hosts/**`, `app/device/**` | A3, A5 |
| **B2** | **Workspace experience**: `app/w/[id]`, `WorkspaceGrid` (+ drag/resize + keep-alive portals), `SessionPane`, `ShortcutBar`, `NewSessionMenu` (cascade flows incl. new-workspace variant), `FolderPickerDialog`, `app/sessions/[id]` (rebuilt full-screen view + `components/session/**`), mobile stack + ModifierBar wiring, files aside | `web/src/app/w/**`, `web/src/app/sessions/**`, `web/src/components/workspace/**`, `web/src/components/session/**`, `web/src/components/files/**` | A3, A4, A5 |
| **B3** | **Onboarding + auth surfaces**: `app/onboarding/**`, `components/onboarding/**`, restyled `login/signup/forgot/reset/verify-email`, platform-detect shared lib extraction from `/download` | those paths + `web/src/lib/platform.ts` | A3, A5 |

Phase B gate: `bun run build` green; manual walkthrough of onboarding → workspace → shortcut → settings on desktop and a phone viewport.

### Phase C — convergence (serial, in this order)

| ID | Workstream | Scope |
|---|---|---|
| **C1** | **Deletion + audit sweep**: delete every §6 item that still exists, add `next.config.ts` redirects, then run the grep gate (§9). Fix all hits. |
| **C2** | **Test overhaul**: rewrite `tests/e2e/app-mocks.ts` for the new API; port surviving specs (terminal/scrollback/trust/device/admin/auth suites — mostly renames); replace `screens.spec.ts` with `workspace-grid.spec.ts` (drag/resize/pack/persist/zoom/attention); new specs: `onboarding.spec.ts`, `session-create.spec.ts` (cascade + folder picker), `shortcut-bar.spec.ts` (availability, type-through, install&&run, cursor anchoring: appears under the prompt cursor, hides on typing/scrollback/agent foreground, flips above near the pane bottom), `sidebar.spec.ts` (tree, hover-highlight, mobile drawer), `settings-modal.spec.ts`. Owns `web/tests/**`. |
| **C3** | **Docs + release**: `README.md` (architecture/vocabulary), final pass over `docs/DESIGN.md`, `proto/README.md`, `docs/INTERFACE_MATRIX.md`, `docs/TRUST.md`; write `docs/RELEASE_NOTES_OVERHAUL.md` (internal-user upgrade steps, §8); delete this spec's "status" header or mark shipped; final `/code-review` of the whole branch set. |

---

## 8. Rollout (internal users)

Deploy order: **database migrations → server+web together → daemons**.

1. Server & web ship together (same deploy today). Migrations 0029–0032 run first; they are data-preserving (sessions, workspaces, agents defs, hosts, trust, users all carry over; archived agents are the one deliberate deletion).
2. Old daemons (v2) are rejected with `protocol.required` and appear **offline** — running PTY workers keep running untouched. Each user re-runs `curl …/install.sh | sh`; the new spawnd **adopts the existing workers** over the private socket (worker wire stays compatible; old workers simply never report foreground). Sessions and scrollback survive.
3. Post-deploy: existing sessions show their original process (a migrated `claude` session keeps running claude); its shortcut bar appears only after it exits to… nothing (old sessions weren't shells), so an exited migrated session's Restart spawns a **shell** in its cwd — this is the intended one-time behavior change; note it in the release notes.

---

## 9. Phase C grep gate (must all return zero hits)

Run from repo root, excluding `docs/OVERHAUL.md`, `docs/RELEASE_NOTES_OVERHAUL.md`, migration files, and `.git`:

```
rg -i "screen"       server/spawn_server web/src daemon/src        # workspaces only
rg -i "preset"       server/spawn_server web/src daemon/src proto
rg    "agent_id"     web/src server/spawn_server daemon/src proto  # session_id (except agents-defs FK)
rg -i "new agent"    web/src
rg    "ephemeral|archived_at|include_archived" server/spawn_server web/src
rg    "emerald-|amber-|sky-|violet-|zinc-|red-5" web/src --glob '!app/globals.css'
rg    "spawn.control.v2|agent\.create|agent\.exit|host\.tools\." server daemon web/src proto
```

Plus: `bun run lint && bun run test:unit && bun run test:e2e` (web), `pytest` (server), `cargo test` (daemon), `bun run build`.

---

## 10. Decision log (for future archaeology)

- Shell-first sessions; agents are typed shortcuts; foreground basename reported by the worker (deliberate, documented content-free exception).
- Sessions stay standalone records; workspaces reference them via layout tiles; deleting a workspace closes its sessions (confirmed in UI).
- `+ New workspace` immediately creates a shell session (host cascade when >1 host).
- Full-stack rename (DB, API, protocol v3, web) with data-preserving migrations — pre-release with internal users.
- Grid: free-form packed 12×12, no vertical scroll, dual TS/Python algebra kept identical via shared fixtures.
- Folder picking: in-app host browser over the existing E2E fs channel (native OS pickers can't browse remote hosts or return absolute paths).
- "Root" location option became **Home** (`~`); literal `/` was rejected as permission-hostile and the fs channel is home-rooted anyway.
- Onboarding gates account + email verification (when server-enforced); host connect is skippable; first workspace auto-created.
- Routes kept: `/hosts/[id]`, `/hosts/[id]/files`, `/sessions/[id]`, `/device`, `/admin`, marketing pages. Everything else folds into `/w/[id]` + the settings modal.
- Mobile: drawer sidebar + stacked panes + bottom-sheet cascade; BottomTabs deleted.
- Retired: ephemeral/pinned screens, archived agents, Recents section, HTML5 drag MIME contract, silent install preflight.
