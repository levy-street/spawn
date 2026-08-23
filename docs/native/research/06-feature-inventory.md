# R06 — Complete Feature Inventory and Proposed Native Mobile Information Architecture

## TL;DR

1. The parity contract below contains 121 numbered capabilities: 58 core, 56 secondary, and 7 desktop-only-by-nature capabilities whose stated phone equivalents remain required.
2. The canonical hierarchy is Workspace → ordered named Tabs → child tiles; a child is either a live PTY session or a file-browser widget, and mobile must preserve that model rather than flatten it.
3. **RECOMMEND:** Use a four-root native tab bar—Workspaces, Hosts, Files, Settings—with stack navigation inside each root and Legion, Profile, Admin, Archived, and public/about material reachable from those roots.
4. **RECOMMEND:** Make Workspace Detail a pushed screen whose tab strip is a horizontal pager and whose selected tab is a vertical list of terminal/file children; tapping a terminal presents a full-screen, drag-down-dismissable terminal overlay.
5. The terminal overlay needs a persistent native modifier row, keyboard-safe resize, touch scrollback, ownership/take-control UI, upload/clipboard actions, connection diagnostics, and the exact dark/light terminal palettes documented below.
6. Workspace geometry editing is desktop-only-by-nature: retain its current 24×24 v3 layout data, but expose reorder, move-to-tab, duplicate, split/dock presets, and close through mobile list actions and sheets.
7. File Explorer operations (list, preview, upload, download, rename, remove, open/reveal, transfer) and exact host metrics use authenticated `spawn.host.ctl`; terminal-scoped cwd/attachment upload instead uses the session's `spawn.ctl` DataChannel.
8. Conditional surfaces include configured OAuth providers, invite-only signup, enforced email verification, admin status, host/daemon capabilities, pointer/media capability, browser notification support, passkey PRF support, and several local diagnostic preferences.
9. **UNKNOWN:** Expo Go support for the required authenticated WebRTC DataChannels and passkey-PRF trust flow must be proven on a physical iPhone; the behavioral fallback is a transport-only WebView overlay, but that conflicts with the owner’s “not a web wrapper” requirement.
10. The implementation must carry the desktop token system—not its bad responsive layout—using the same brand/status colors, radii, spacing rhythm, terminal themes, icon family, 150 ms motion baseline, spring-like easing, and reduced-motion behavior.

## Scope, method, and interpretation

This report is both (1) the mobile parity acceptance checklist and (2) the concrete navigation brief. Every source file under `web/src/app/` and `web/src/components/` was inspected; the final source-coverage ledger names every file so absence from a screen section is not ambiguity. Product and protocol orientation came from the repository overview and design document: the browser talks to the FastAPI control plane for account/model/signaling work, while terminal bytes and file operations travel browser↔daemon rather than through the server (`README.md:3-16`, `README.md:42-47`, `README.md:214-222`).

Classification is deliberately independent of implementation order:

- **core** — required to sign in, connect a machine, navigate workspace/tab children, or operate a remote terminal safely.
- **secondary** — not necessary for the first command, but required by “total feature parity.”
- **desktop-only-by-nature** — the exact desktop interaction depends on hover, a fine pointer, or simultaneous large panes. The data/action remains required and the phone equivalent is stated.

“API” below names both control-plane REST calls and direct host-control commands. A React Query refetch/invalidation after mutation is part of the expected behavior even when not restated on every row. Toasts, destructive confirmation, focus restoration, loading, empty, offline, and failure handling are first-class behavior, not decoration (`web/src/components/ui/confirm.tsx:14-109`, `web/src/components/ui/toast.tsx:7-241`).

## Canonical data model the IA must expose

The future app cannot infer the hierarchy from current pixels. The live wire model says a workspace owns 1–8 ordered tabs, each tab owns a version-3 24×24 grid with 4×4 minimum tiles and at most 16 tiles, and each tile either points at a PTY session or carries a `files` widget. A session is always the user's login shell on one host and one `cwd`; an “agent” is a launchable CLI definition typed into that shell, not a separate daemon process (`web/src/lib/grid.ts:1-33`, `web/src/lib/tabs.ts:14-42`, `web/src/lib/api.ts:234-278`, `web/src/components/workspace/pending-launch.ts:1-20`).

```ts
// web/src/lib/api.ts:318-384 — trimmed, field names unchanged
type TileWidget = { kind: "files"; host_id: string; path: string };
type Tile = {
  session_id: string;
  x: number; y: number; w: number; h: number;
  widget?: TileWidget;
};
type GridLayout = { version: 3; tiles: Tile[] };
type WorkspaceTab = {
  id: string;
  name: string;
  host_id: string | null; // null means inherit workspace home
  cwd: string | null;
  layout: GridLayout;
};
type LayoutV3 = {
  version: 3;
  active_tab: string | null;
  tabs: WorkspaceTab[]; // schema requires at least one
};
type Workspace = {
  id: string; name: string;
  host_id: string | null; cwd: string | null;
  layout: LayoutV3; position: number;
  icon: string | null; icon_source: "auto" | "custom" | "none" | null;
  archived_at: string | null;
};
```

The list row requested by the owner can therefore be derived without a new server concept:

```ts
// web/src/lib/api.ts:234-278 and web/src/components/ui/status.tsx:5-63
type MobileTabChild =
  | { kind: "terminal"; tile: Tile; session: Session; agent?: Agent }
  | { kind: "files"; tile: Tile; host_id: string; path: string };

// terminal status is Session.activity_state:
// "starting" | "active" | "quiet" | "waiting" | "input_sent" |
// "exited" | "killed" | "unknown"
```

Status presentation is semantic: active pulses in the active tone; waiting, idle/quiet, and offline use the corresponding token dots, with a text/accessible label (`web/src/components/ui/status.tsx:5-63`, `docs/DESIGN.md:87-105`, `docs/DESIGN.md:122-133`).

## Feature parity contract

### Global application, public, and acquisition surfaces

#### F-001 — Application document and install identity — **secondary**

- Purpose/entry: every route inherits the PWA document, metadata, viewport, icons, and global providers.
- Controls: none directly; it establishes installability and caps browser zoom at 1 in the web implementation.
- States/API: static; no API. The native app must use the same name/marks/theme metadata but should preserve iOS accessibility text scaling rather than copy a browser zoom cap.
- Evidence: `web/src/app/layout.tsx:8-58`, `web/src/app/globals.css:1-752`.

#### F-002 — Public landing masthead and account entry — **secondary**

- Entry: `/`. Signed-out controls are Log in and Sign up; signed-in control is Enter spawn. The brand mark returns home.
- Controls/API: route only—`/login`, `/signup`, or `/app`; auth state determines the CTA.
- States: auth resolving, signed out, signed in; no blocking page error.
- Evidence: `web/src/app/page.tsx:20-208`, `web/src/components/brand/press.tsx:63-187`.

#### F-003 — Public product story and motion — **secondary**

- Controls: scroll-driven terminal scrub, drifting screenshots, marquee, demo video, Download, Get started, Security, and open-source/source links; footer repeats product/account links.
- Gestures/states: normal scrolling; decorative transforms/marquee are suppressed for `prefers-reduced-motion`.
- API: none.
- Evidence: `web/src/app/page.tsx:20-503`, `web/src/components/brand/press.tsx:20-32`, `web/src/components/brand/press.tsx:189-255`.

#### F-004 — Native daemon download/install page — **secondary**

- Entry: `/download` and landing CTAs. Detects macOS, Linux, Windows, or unknown platform.
- Controls: Copy install command, Sign up, platform-specific download/install affordances, and a smoke-test command for prebuilt artifacts.
- States: copied feedback; unsupported/unknown platform warning; platform-specific instructions. No API.
- Phone equivalent: explain that the daemon belongs on the controlled computer, let the user copy/share the install command, and offer pairing next.
- Evidence: `web/src/app/download/page.tsx:19-106`, `web/src/app/download/page.tsx:108-285`.

#### F-005 — Security explainer — **secondary**

- Entry: `/security` and public footer/masthead.
- Controls: masthead Login/Signup/Enter, Download/Get started, repository/source links.
- Content/states: trust boundary, encryption/direct transport, identity and security claims; static, with no API.
- Evidence: `web/src/app/security/page.tsx:24-280`, `web/src/components/brand/press.tsx:63-255`.

### Authentication, routing, and onboarding

#### F-006 — Auth gate and authenticated bootstrap — **core**

- Entry: every private screen. While identity resolves it displays a loading state; unauthenticated users are redirected to `/login`; authenticated content mounts only after resolution.
- `/app` then reads auth config, user, hosts, and workspaces; it routes unverified accounts to onboarding, otherwise to the remembered/first active workspace.
- Controls/states: spinner while auth/config/host/workspace or verification routing resolves; auth-check error shows its message with no Retry; config/host/workspace load error offers Try again (the handler refetches hosts and workspaces); skipped/no hosts offers Connect a host; hosts exist but none is online and no workspace exists offers View hosts; online host with no workspace offers New workspace; otherwise it redirects to the remembered/first workspace.
- API: `GET /api/me`, `GET /api/auth/config`, `GET /api/hosts`, `GET /api/workspaces`.
- Evidence: `web/src/components/auth/AuthGate.tsx:7-29`, `web/src/app/app/page.tsx:17-214`, `web/src/lib/api.ts:506-515`, `web/src/lib/api.ts:541-558`, `web/src/lib/api.ts:880-912`.

#### F-007 — Login — **core**

- Entry: `/login` or auth redirect.
- Controls: configured Google/Microsoft/GitHub buttons; Email field; Password field; Log in; Forgot password; Create account.
- Keyboard: native form submission/Return invokes Log in.
- States: config loading; OAuth buttons absent if no providers; per-request busy state; inline auth/config failure.
- API: `POST /api/auth/login {email,password}`; OAuth opens `/api/auth/oauth/{provider.id}/start?return_to=/app`; success routes `/app`.
- Evidence: `web/src/app/login/page.tsx:15-109`, `web/src/components/onboarding/oauth-buttons.tsx:4-42`, `web/src/lib/api.ts:473-515`.

#### F-008 — Signup and invitation — **core**

- Entry: `/signup`, optional invitation in query/context.
- Controls: configured OAuth; Email; Password (minimum 8 in this surface); invite token field only when `invite_only`; Create account; Login link; config Retry.
- States: config loading/error; validation; submission error/busy; provider list empty.
- API: `POST /api/auth/signup {email,password,invite?}`; success continues onboarding.
- Evidence: `web/src/app/signup/page.tsx:12-84`, `web/src/components/onboarding/signup-form.tsx:9-110`, `web/src/lib/api.ts:473-479`.

#### F-009 — Forgot password — **secondary**

- Entry: `/forgot-password` from Login.
- Controls: Email; Send reset link; Return to login.
- States: form, sending, then a universal sent state with Back to sign in. Request failure is intentionally swallowed and produces the identical sent state, preventing both account enumeration and delivery-error disclosure.
- API: `POST /api/auth/password-reset/request {email}`.
- Evidence: `web/src/app/forgot-password/page.tsx:11-81`, `web/src/lib/api.ts:487-492`.

#### F-010 — Reset password — **secondary**

- Entry: `/reset-password?token=…` from email.
- Controls: New password (minimum 12); Confirm new password; Set new password. A missing-token state replaces the form with Request a reset link.
- States: Suspense/loading, missing token, too short, mismatch, submitting, API error; success has no separate screen and immediately seeds current auth data then routes `/app`. Copy warns that every currently signed-in device will be signed out.
- API: `POST /api/auth/password-reset/confirm {token,new_password}`.
- Evidence: `web/src/app/reset-password/page.tsx:14-125`, `web/src/lib/api.ts:493-498`.

#### F-011 — Email verification — **core**

- Entry: `/verify-email?token=…`; token confirmation runs once automatically.
- Controls: Continue/next destination, Return to login, and recovery navigation on failure.
- States: Suspense/loading, verifying, success, invalid/expired/missing token; next route depends on whether a host exists or host setup was skipped. After verification the hosts query gates Continue as “Checking setup…”; a host-query error has no explicit branch and leaves that button disabled.
- API: `POST /api/auth/verify-email/confirm {token}`; routing also consults hosts/auth config.
- Evidence: `web/src/app/verify-email/page.tsx:14-148`, `web/src/lib/api.ts:499-505`.

#### F-012 — Onboarding step machine and verification — **core**

- Entry: `/onboarding`; visible steps are Account → Verify (only when required) → Host → Done.
- Controls: Account form/Create account and continue when entered signed out; Verify has Resend email and advances automatically after a 5-second identity poll observes verification; Host has pairing controls and Skip for now; top-level load/completion failure has Try again.
- States: config/user/host loading and errors; waiting for verification; resend busy/success/error; already complete; skipped host.
- API: `GET /api/me`, `GET /api/auth/config`, `GET /api/hosts`, `POST /api/auth/verify-email/request`; verification status is polled/refetched.
- Evidence: `web/src/app/onboarding/page.tsx:1-20`, `web/src/components/onboarding/step-machine.ts:1-35`, `web/src/components/onboarding/onboarding-flow.tsx:45-180`, `web/src/components/onboarding/onboarding-flow.tsx:274-504`.

#### F-013 — Connect and cryptographically approve a host — **core**

- Entry: onboarding Host step, `/device`, Hosts settings, empty-host states.
- Controls: platform selector/instructions; Copy install command; pairing-code field; Check/continue; Back; Retry; explicit Approve; start over.
- Flow: poll the pending device code, display the host name and SHA256 fingerprint, derive/register the local browser identity, compare returned identity/fingerprint, sign approval, pin first contact, then wait for the daemon-created Host row.
- States: installation instructions, waiting for code, pending lookup, identity registration failure, review, fingerprint mismatch, approval busy/error, waiting for daemon, success/expiry.
- API: `POST /api/auth/device/pending {user_code}` and `POST /api/auth/device/approve` with host key, browser key, nonce, fingerprints, and signature; polls `GET /api/hosts`.
- Evidence: `web/src/app/device/page.tsx:3-16`, `web/src/components/hosts/connect-host.tsx:63-169`, `web/src/components/hosts/connect-host.tsx:171-448`, `web/src/lib/api.ts:398-426`, `web/src/lib/api.ts:516-539`.

#### F-014 — Skip host and create first workspace — **core**

- Controls: Skip for now on the host step; Try again only if automatic completion fails. There is no Finish/Create button: reaching Done starts completion automatically.
- Effects: skip persists `spawn.onboarding.skippedHost`; Done creates a workspace with `first_session:{host_id,cwd:"~"}` only when no workspace exists and an online host is available, shows a brief success beat, then routes to it. Existing-workspace or skipped/no-host completion routes `/app`.
- States: preparing, “Host connected. Shell summoned” or “Setup complete” success beat, creation failure with Try again.
- API: `POST /api/workspaces` with `first_session` or an empty body.
- Evidence: `web/src/components/onboarding/onboarding-flow.tsx:139-180`, `web/src/components/onboarding/onboarding-flow.tsx:236-504`, `web/src/lib/api.ts:895-912`.

#### F-015 — Browser/mobile device registration health banner — **core**

- Purpose: prevent identity-dependent connections from failing silently.
- Controls: Retry registration; Open device settings.
- States: hidden while ready/loading/no user; destructive banner on registration error; warning banner for revoked or local cleanup pending.
- API: registration/refetch uses browser-device identity endpoints; route to device settings.
- Evidence: `web/src/components/auth/BrowserDeviceRegistrationStatus.tsx:8-50`, `web/src/lib/api.ts:584-619`.

### Global authenticated shell and workspace discovery

#### F-016 — Adaptive application shell — **core**

- Desktop controls: resizable sidebar (216–420 px), collapse/expand, navigation rail, content outlet. Width and collapsed state persist.
- Existing web-mobile controls: header hamburger, current title, add button, left drawer and scrim; drawer closes by leftward swipe (>70 px), Escape, close, or navigation.
- Native equivalent: bottom root tabs plus a workspace stack; do not recreate the web hamburger as primary IA.
- States: sidebar/drawer open/closed, resizing, current workspace/alerts; global Settings, Profile, confirmation, and toast portals mount here.
- API/effect: shell width/collapse/drawer state is local and persisted; navigation changes routes. Data calls belong to the selected destination, not to the shell control itself.
- Evidence: `web/src/components/nav/AppShell.tsx:28-290`, `web/src/components/ui/drawer.tsx:15-178`.

#### F-017 — Workspace list and ordering — **core**

- Entry: sidebar on web; Workspaces root on mobile.
- Controls: select workspace; New workspace; collapse rail; pointer-drag workspaces to reorder (touch intentionally excluded on web).
- States: loading skeleton, empty, API error, active workspace. Reorder is optimistic and persisted.
- API: `GET /api/workspaces`; `PATCH /api/workspaces/{id} {position}`.
- Evidence: `web/src/components/nav/Sidebar.tsx:40-211`, `web/src/components/nav/Sidebar.tsx:332-621`, `web/src/lib/api.ts:880-930`.

#### F-018 — Workspace search — **secondary**

- Controls: open/focus search; text field; clear/cancel; choose a result.
- Keyboard: native input typing and submission behavior; desktop focus is managed as the search expands.
- States: no query, filtered results, “no workspaces match,” empty fleet.
- API: client-side filter over `GET /api/workspaces`.
- Evidence: `web/src/components/nav/Sidebar.tsx:40-211`, `web/src/components/nav/Sidebar.tsx:332-519`.

#### F-019 — Workspace row quick actions — **core**

- Controls: tap row; inline rename; overflow/context menu: Rename, Change icon, Archive, Delete; drag handle on fine pointer.
- Keyboard: rename Enter commits, Escape cancels, blur commits.
- States: active, drag source/target, rename input, mutation busy/error via toast; archive/delete confirmations.
- API: `PATCH /api/workspaces/{id}`, `POST /api/workspaces/{id}/archive`, `DELETE /api/workspaces/{id}`.
- Evidence: `web/src/components/nav/SidebarWorkspaceRow.tsx:32-232`, `web/src/components/nav/Sidebar.tsx:211-331`.

#### F-020 — Archived workspace collection — **secondary**

- Controls: persisted disclosure shows the five most recent/pinned archived workspaces; select; Restore; Delete; View all; modal search; close.
- States: loading/error/empty; last-opened archived item remains pinned; no search matches; destructive confirmation.
- API: `GET /api/workspaces?archived=true`, `POST /api/workspaces/{id}/unarchive`, `DELETE /api/workspaces/{id}`.
- Evidence: `web/src/components/nav/SidebarArchivedSection.tsx:33-188`, `web/src/components/nav/SidebarArchivedSection.tsx:190-419`, `web/src/lib/api.ts:880-946`.

#### F-021 — Legion compact strip — **desktop-only-by-nature**

- Controls: expand/collapse persisted strip; select Legion; select/hover a host; open host detail. Fine-pointer hover can show a detail preview.
- States: host capacity meters may be absent for older/no-telemetry daemons; online/offline/status; loading/error/empty.
- API: `GET /api/hosts`; direct exact metrics only when expanded/detail requests need them.
- Native equivalent: a Fleet/Legion row under Hosts and a pushed Fleet Overview; no hover preview.
- Evidence: `web/src/components/legion/LegionStrip.tsx:26-232`, `web/src/components/legion/legion-parts.tsx:1-263`.

#### F-022 — Profile — **secondary**

- Entry/controls: avatar/account row opens Profile; Close; activity/fleet summaries; agent summary; Copy/share safe stats.
- States: loading skeleton, inline load error with no Retry control, populated identity/fleet/activity heatmap; Copy stats changes to Copied for two seconds, while clipboard denial produces an informational toast.
- API: `GET /api/profile`.
- Native equivalent: pushed Profile screen from Settings root.
- Evidence: `web/src/components/profile/ProfileDialog.tsx:17-65`, `web/src/components/profile/ProfileDialog.tsx:83-315`, `web/src/lib/api.ts:689-691`.

#### F-023 — Logout — **core**

- Entry: profile/sidebar account menu.
- Controls: Logout.
- States/effects: request busy/failure; clears authenticated state and routes to login.
- API: `POST /api/auth/logout`.
- Evidence: `web/src/components/nav/Sidebar.tsx:519-621`, `web/src/lib/api.ts:486-486`.

### Workspace, tabs, child list, and layout operations

#### F-024 — Workspace detail loading and persistence — **core**

- Entry: `/w/{workspaceId}`; mobile route `workspaces/:workspaceId`.
- Data: workspace, all sessions, focus/attention state; selected tab is restored per workspace from local storage and workspace last-opened is remembered globally.
- States: centered loading spinner; non-404 workspace error as inline destructive text with no Retry control; not found routes `/app`; archived banner; valid workspace; auto-icon scan can run after load.
- API: `GET /api/workspaces/{id}`, `GET /api/sessions`, plus focus/alert data from its query source.
- Evidence: `web/src/app/w/[id]/page.tsx:35-200`.

#### F-025 — Workspace title and workspace-level menu — **core**

- Controls: rename workspace; Change icon; Set default host/folder; Save as template; Archive; Delete; New child.
- States: inline edit/mutation errors; folder/icon/template sheets; archive warns all live sessions stop; delete warns all referenced sessions are killed/deleted.
- API: `PATCH /api/workspaces/{id}`, template creation, archive, delete.
- Evidence: `web/src/components/workspace/workspace-tabs.tsx:125-236`, `web/src/components/workspace/workspace-tabs.tsx:822-1263`.

#### F-026 — Tab selection and horizontal navigation — **core**

- Controls: select named tab; active-tab tap enters rename; plus creates a tab; close control; horizontal scroll on narrow/coarse input.
- Keyboard: `Alt+Shift+ArrowLeft/ArrowRight` reorders the selected tab; click/keyboard selection updates the chosen tab.
- States: active/inactive, renaming, drag source/drop target, maximum-tab disabled state, empty tab.
- Limit: a workspace has at most eight tabs.
- API: the selected tab is local per workspace; structural changes call `PATCH /api/workspaces/{id} {layout}`.
- Native equivalent: horizontally swipe a pager and tap the tab strip; selection and pager remain bidirectionally synchronized.
- Evidence: `web/src/components/workspace/workspace-tabs.tsx:125-236`, `web/src/components/workspace/workspace-tabs.tsx:420-558`, `web/src/lib/tabs.ts:35-42`.

#### F-027 — Create and rename a tab — **core**

- Controls: plus/Add tab; generated default name; active tab click/Rename menu; text input.
- Keyboard: Enter commits, Escape cancels, blur commits.
- States: maximum tabs reached, invalid/empty name normalized, optimistic layout save failure.
- API: `PATCH /api/workspaces/{id} {layout}`.
- Evidence: `web/src/components/workspace/workspace-tabs.tsx:420-558`, `web/src/components/workspace/workspace-tabs.tsx:822-1048`.

#### F-028 — Reorder, duplicate, and close a tab — **core**

- Controls: pointer drag reorder; modifier-drag duplicate (`Command`/`Option` as interpreted by the component); context menu Duplicate, Rename, Change folder, Close; close button.
- Keyboard: `Alt+Shift+ArrowLeft/Right` reorder; rename keys as above.
- Duplicate effect: creates equivalent sessions with host/cwd/skills/agent launches and copies file widgets/layout; close confirms when needed and kills/removes tab sessions.
- States: dragging, duplicating busy/failure, only-tab/maximum constraints, live-session close confirmation.
- API: `POST /api/sessions` per copied PTY, `GET/PATCH /api/sessions/{id}/access`, `DELETE /api/sessions/{id}`, `PATCH /api/workspaces/{id} {layout}`.
- Evidence: `web/src/components/workspace/workspace-tabs.tsx:602-820`, `web/src/components/workspace/workspace-tabs.tsx:822-1263`.

#### F-029 — Tab-specific home host/folder — **secondary**

- Controls: Change folder opens host→folder picker; choose inherited workspace home or an explicit host/cwd.
- States: host loading/error/offline/disabled; inherited vs explicit value; selection busy/failure.
- API: `GET /api/hosts`, direct `fs.home`/`fs.list` while picking, `PATCH /api/workspaces/{id} {layout}`.
- Evidence: `web/src/components/workspace/tab-home.tsx:14-187`, `web/src/components/workspace/workspace-tabs.tsx:822-1263`.

#### F-030 — Create a blank workspace — **core**

- Entry: global New workspace.
- Controls: New workspace → Select folder; when several hosts exist choose an online host; browse/select the folder; Back returns from picker to the cascade and dismiss cancels. There is no name field or separate Create button: selecting the folder immediately creates an empty, homed workspace whose initial tab has no terminal.
- States: hosts loading/no hosts/offline disabled; folder picker load/error; creation busy; creation error toast. Host/template query errors have no dedicated branch in this menu and therefore look like empty results.
- API: `GET /api/hosts`, direct `fs.home`/`fs.list`, `POST /api/workspaces {host_id,cwd}`.
- Evidence: `web/src/components/workspace/new-workspace-menu.tsx:24-211`, `web/src/lib/api.ts:895-912`.

#### F-031 — Create workspace from template — **secondary**

- Controls: choose a listed template; if its remembered host/folder still exists and is online, selection instantiates immediately; otherwise choose host then folder; Back/dismiss cancels. There is no second Create confirmation.
- Effect: replays tab names and 24×24 geometry, file widgets, shell sessions, and queued agent commands. A matching current agent definition re-applies today's env/yolo preference; a deleted definition falls back to the stored bare command. Templates do not store session skill grants.
- States: templates absent while loading/error or truly empty (no differentiated message inside the menu); remembered host offline disables its template; folder/creation errors; partial instantiation error toast.
- API: `GET /api/workspace-templates`, `GET /api/agents`, `POST /api/workspaces`, repeated `POST /api/sessions`, and repeated `GET/PATCH /api/workspaces/{id}`.
- Evidence: `web/src/components/workspace/new-workspace-menu.tsx:24-211`, `web/src/components/workspace/instantiate-template.ts:15-116`.

#### F-032 — Workspace icon discovery and editing — **secondary**

- Controls: Change icon; accept folder-suggested image; upload an image; use initials/no image; Retry/close.
- States: scanning host folder, suggestion found, no suggestion, load failure, local upload/read failure, saved.
- API: direct host file preview/read for folder discovery; `PATCH /api/workspaces/{id} {icon,icon_source}`.
- Evidence: `web/src/components/workspace/workspace-icon-dialog.tsx:30-254`, `web/src/lib/api.ts:913-930`.

#### F-033 — Archive, restore, and permanently delete workspace — **secondary**

- Controls: Archive with confirmation; archived-banner Restore; Delete with destructive confirmation.
- Semantics: archive captures shape and kills sessions but preserves the layout; restore restarts windows where possible; delete kills and removes every referenced session.
- States: archived banner, restore busy/error, offline-host children remain stopped, delete/archive error toasts.
- API: `POST /api/workspaces/{id}/archive`, `POST /api/workspaces/{id}/unarchive`, `DELETE /api/workspaces/{id}`.
- Evidence: `web/src/components/workspace/archived-banner.tsx:10-51`, `web/src/lib/api.ts:931-946`, `web/src/components/workspace/workspace-tabs.tsx:748-820`.

#### F-034 — New-child launcher and placement preview — **core**

- Controls: tap launcher to choose Shell/Agent/Files; on fine-pointer desktop, drag a kind into an empty area, dock edge, or split target; Escape cancels; a bin target appears while moving an existing pane.
- States: closed/open; drag preview invalid/valid; grid full; max tiles; host unavailable.
- API: delegates to session/file creation and layout update capabilities below.
- Native equivalent: a prominent Add button opens an action sheet; placement presets appear only after child selection.
- Evidence: `web/src/components/workspace/launcher-fab.tsx:39-264`, `web/src/components/workspace/launcher-fab.tsx:307-624`.

#### F-035 — Add shell terminal — **core**

- Controls: Shell creates immediately at the resolved tab/workspace home; Shell on another host/folder is the explicit escape hatch; without a home, choose an online host if needed and then an exact folder. Selecting the final choice creates—there is no second confirmation.
- States: hosts loading/empty/offline; directory load/error; workspace at 16 tiles with explanatory error/disabled launcher; creation busy/error.
- API: `GET /api/hosts`, direct `fs.home`/`fs.list`, `POST /api/sessions {host_id,cwd,workspace_id,tile?}`, with preparatory/final workspace layout reconciliation.
- Evidence: `web/src/components/workspace/new-session-menu.tsx:35-331`, `web/src/components/workspace/new-session-menu.tsx:334-490`, `web/src/lib/api.ts:576-581`, `web/src/lib/api.ts:771-819`.

#### F-036 — Add agent terminal — **core**

- Controls: choose an Agent definition; like Shell, it launches immediately at resolved home or asks for host/folder when no home exists. The menu has no skill picker, yolo toggle, install button, or second Create confirmation; it uses saved agent preferences and omits `skill_ids` from the create call.
- Effect: daemon still starts a login shell; the agent command is queued and typed into the connected terminal once.
- States: the agent choices are absent while the definitions query is loading/error or truly empty; host offline; workspace full; creation/launch failure.
- API: `GET /api/agents`, `GET /api/hosts`, `POST /api/sessions`; the command itself goes on the PTY DataChannel.
- Evidence: `web/src/components/workspace/new-session-menu.tsx:35-331`, `web/src/components/workspace/agent-command.ts:1-90`, `web/src/components/workspace/pending-launch.ts:1-20`.

#### F-037 — Add files widget — **secondary**

- Controls: Files; choose host/folder; choose placement.
- States: no/online hosts, folder loading/error, grid full, layout save error.
- API: direct `fs.home`/`fs.list`; `PATCH /api/workspaces/{id} {layout}` with `widget:{kind:"files",host_id,path}`.
- Mobile equivalent: child row opens the Files screen/overlay at that host and path while retaining the tile in layout data.
- Evidence: `web/src/components/workspace/new-session-menu.tsx:35-331`, `web/src/lib/api.ts:318-337`.

#### F-038 — Host folder picker — **core**

- Presentation: Finder-style columns on desktop with breadcrumbs, host selector, filter, and current-path commit.
- Controls: host; breadcrumb; directory; text filter; Show hidden toggle (persisted); New folder; Back; Cancel; Select folder.
- Keyboard: Arrow Down/Up changes sibling, Right enters first child, Left or Backspace goes parent, Enter selects/commits, Escape clears filter first then closes.
- States: host/home loading, per-column loading, truncated result, no subfolders, no filter matches, hidden-only, offline/error, create-folder error. It retains at most 12 pages/1,024 entries per picker traversal.
- API: `GET /api/hosts`; direct `fs.home`, paged `fs.list`, `fs.mkdir`.
- Native equivalent: pushed host root followed by a single-column drill-down; retain breadcrumb/back stack, filter, hidden toggle, create folder, and explicit “Choose this folder.”
- Evidence: `web/src/components/workspace/folder-picker.tsx:36-180`, `web/src/components/workspace/folder-picker.tsx:229-429`, `web/src/components/workspace/folder-picker.tsx:442-702`, `web/src/components/workspace/folder-picker-column.tsx:9-143`, `web/src/components/workspace/folder-picker-crumbs.tsx:19-87`, `web/src/components/workspace/folder-picker-helpers.ts:104-136`.

#### F-039 — Save current workspace as template — **secondary**

- Controls: Save as template; template name; confirm/cancel.
- Effect: serializes workspace default home/icon plus tab names and tile geometry, files widgets, and shell/recognizable-agent run kinds/commands. It does not serialize session skill grants; instantiation relocates all children to the chosen template home.
- States: empty/name validation, saving/error/success toast.
- API: `POST /api/workspace-templates`.
- Evidence: `web/src/components/workspace/workspace-tabs.tsx:822-1263`, `web/src/lib/api.ts:949-985`.

#### F-040 — Render workspace child layout — **core**

- Desktop: render up to 16 non-overlapping tiles on a version-3 24×24 canvas with 4×4 minimum geometry; each tile is terminal or files; focus and selected pane are represented; empty grid invites creation.
- States: missing session, starting/running/exited child, files widget, grid empty/full, optimistic-save error.
- API: `GET /api/sessions`; `PATCH /api/workspaces/{id} {layout}` for geometry/children.
- Native equivalent: selected tab renders a vertical ordered child list derived deterministically from tile order (`y`, then `x`), while the stored geometry remains untouched.
- Evidence: `web/src/components/workspace/workspace-grid.tsx:81-169`, `web/src/components/workspace/workspace-grid.tsx:1237-1552`, `web/src/components/workspace/workspace-grid-helpers.ts:1-722`, `web/src/lib/grid.ts:1-33`.

#### F-041 — Drag, dock, split, resize, and remove panes — **desktop-only-by-nature**

- Controls: fine-pointer tile drag; empty-grid placement; dock edge; split target; divider resize; corner/edge resize; drop on bin to discard; Escape cancels.
- States: invalid collision/out-of-bounds, valid preview, divider active, save pending/failure, max tiles.
- API: debounced/optimistic `PATCH /api/workspaces/{id} {layout}`; discard may `DELETE /api/sessions/{id}` after confirmation/lifecycle handling.
- Phone equivalent: child action sheet offers Move up/down, Move to tab, Duplicate, Close, and a “Layout on desktop” explanation; creation may offer Full/Split-with-selected/Dock presets that mutate the same 24×24 coordinates.
- Evidence: `web/src/components/workspace/workspace-grid.tsx:299-420`, `web/src/components/workspace/workspace-grid.tsx:537-840`, `web/src/components/workspace/workspace-grid.tsx:880-1220`.

#### F-042 — Keyboard focus and workspace switching in the grid — **desktop-only-by-nature**

- Keyboard: `Alt+1…9` selects workspace by sidebar order; `Alt+Arrow` moves focus among panes; Escape cancels an active layout gesture.
- States: no target in direction, fewer than N workspaces, focus moves into the chosen pane.
- API: none for focus; route/local focus state only.
- Phone equivalent: root/workspace lists replace numeric switching; swipe tab pager replaces directional pane focus. Preserve hardware-keyboard shortcuts where they do not conflict with iOS.
- Evidence: `web/src/components/workspace/workspace-grid.tsx:81-169`, `web/src/components/workspace/workspace-grid.tsx:1559-1894`.

#### F-043 — Duplicate and move panes across tabs — **core**

- Controls: modifier-drag duplicates; dwell over another tab then drop moves/copies; pane menus offer duplicate and mobile move up/down.
- States: destination full/invalid, cross-tab preview, session copy creation busy/error, original retained on copy failure.
- API: `POST /api/sessions`, session access get/update, `PATCH /api/workspaces/{id} {layout}`, optional `DELETE /api/sessions/{id}`.
- Native equivalent: “Move to tab…” and “Duplicate to tab…” sheets with destination capacity/status.
- Evidence: `web/src/components/workspace/workspace-grid.tsx:537-840`, `web/src/components/workspace/workspace-grid.tsx:880-1220`, `web/src/components/workspace/workspace-grid.tsx:1559-1894`.

#### F-044 — Existing narrow-screen workspace stack — **core**

- Web currently stacks panes vertically and exposes Move up/Move down rather than canvas editing.
- The owner explicitly rejects the existing mobile-web design as visual inspiration; only its behavior—every child remains accessible and reorderable—is a parity constraint.
- API: layout updates use the same workspace PATCH.
- Evidence: `web/src/components/workspace/workspace-grid.tsx:350-463`, `web/src/components/workspace/workspace-grid.tsx:1237-1552`.

#### F-045 — Session pane header and quick controls — **core**

- Shows agent/process icon, editable name, activity/status, host and cwd context.
- Controls: focus terminal; rename; Agent switcher; change host; change folder (`cd`); Full screen; Restart; Duplicate; Mute/unmute notifications; Move up/down on mobile; Close in a deliberately separate destructive menu.
- Keyboard: inline rename Enter/commit, Escape/cancel, blur/commit.
- States: running/starting/exited/killed/missing, offline host, rename/restart/close error, foreground-agent warning.
- API: session update/restart/delete; workspace layout update; terminal bytes for `cd` and handoff.
- Evidence: `web/src/components/workspace/session-pane.tsx:75-216`, `web/src/components/workspace/session-pane.tsx:268-593`.

#### F-046 — Restart, duplicate, move host, and close a session — **core**

- Restart respawns the shell in its cwd. Duplicate creates a second PTY with the same host/cwd/access/agent intent. Move host confirms, creates a fresh shell on the chosen online host, and replaces the tile. Close kills and hard-deletes.
- States: confirm, busy/failure, source exited, no destination hosts, destination offline, layout reconciliation.
- API: `POST /api/sessions/{id}/restart`, `POST /api/sessions`, `GET/PATCH /api/sessions/{id}/access`, `DELETE /api/sessions/{id}`, workspace PATCH.
- Evidence: `web/src/components/workspace/session-pane.tsx:75-216`, `web/src/components/workspace/workspace-grid.tsx:1445-1539`, `web/src/lib/api.ts:771-834`.

#### F-047 — Switch shell/agent/files mode — **core**

- Controls: choose Shell; choose any agent; Install and run when absent; choose File explorer.
- Agent handoff: if another recognized agent owns the foreground, warn/confirm, attempt up to four `Ctrl-C` interrupts and poll eight times at 700 ms; then type the new command, or report the shell still busy.
- States: agent list loading/error, installed/not installed, installing, interrupting, busy/failed, current selection.
- API: `GET /api/agents`, `GET /api/hosts/{id}/agents`, `POST /api/hosts/{id}/agents/{agentId}/install`; PTY writes; files conversion updates workspace layout.
- Evidence: `web/src/components/workspace/agent-switcher.tsx:19-223`, `web/src/components/workspace/shell-handoff.ts:7-91`.

#### F-048 — Workspace files-widget pane — **secondary**

- Controls: current-folder chip/Change folder; New folder; Upload; Refresh; Collapse all; Duplicate; Close. The embedded explorer itself is a tree and does not add a breadcrumb or filter field.
- States: host/direct-channel connection states plus all File Explorer states in F-067–F-080.
- API: direct host control; workspace layout PATCH for path/duplicate/close.
- Evidence: `web/src/components/workspace/widget-pane.tsx:28-194`.

#### F-049 — Pending one-shot agent launch — **core**

- Behavior: a newly created agent session queues its command until the component that owns the terminal connects, claims it once, types it, then forgets it.
- States: pending/claimed/absent; a launch must never be replayed on remount.
- API: PTY DataChannel only after `POST /api/sessions` creates the shell.
- Evidence: `web/src/components/workspace/pending-launch.ts:1-20`, `web/src/components/workspace/agent-command.ts:1-90`.

#### F-050 — Archived workspace banner — **secondary**

- Shows that the open workspace is archived and its sessions are stopped.
- Controls: Restore.
- States: restoring/error; restored workspace resumes/recreates what hosts permit.
- API: `POST /api/workspaces/{id}/unarchive`.
- Evidence: `web/src/components/workspace/archived-banner.tsx:10-51`.

### Terminal and full-session operation

#### F-051 — Full-session detail entry — **core**

- Entry: `/sessions/{sessionId}` from a pane or session list; web hides the normal nav for maximum room.
- Header controls: Back; rename; activity/status; host/cwd; toggle Files; overflow Restart, Remove from workspace/Close; terminal focus.
- States: route loading skeleton, not found with Back, fetch error/Retry, running/starting/exited/killed, host offline.
- API: `GET /api/sessions/{id}` (5 s polling), `GET /api/workspaces`, update/restart/delete and workspace layout updates.
- Native equivalent: full-screen overlay over Workspace Detail, not a root route.
- Evidence: `web/src/app/sessions/[id]/loading.tsx:1-18`, `web/src/app/sessions/[id]/page.tsx:8-18`, `web/src/components/session/session-view.tsx:54-197`, `web/src/components/session/session-view.tsx:199-368`.

#### F-052 — Establish and recover the live PTY connection — **core**

- Flow: obtain signaling/access state, establish authenticated WebRTC, require reliable ordered DataChannels named `spawn.pty` and `spawn.ctl`, synchronize snapshot/live output, reconnect with bounded backoff, and buffer pending input up to 64 KiB.
- Controls: none in the connection overlay. Slow/dropped connections retry automatically; a signed identity refusal is terminal and must be repaired/re-approved outside the overlay.
- States: blocked, host offline, dropped, reaching host, securing, secured, connecting, ready, reconnecting, fatal; “taking longer” appears after 8 seconds.
- API/transport: signaling/access endpoints plus WebRTC `pty` and `ctl` channels; terminal bytes never pass through REST.
- Evidence: `web/src/components/terminal/useSessionSocket.ts:43-146`, `web/src/components/terminal/useSessionSocket.ts:410-455`, `web/src/components/terminal/ConnectingOverlay.tsx:10-125`, `web/src/components/terminal/ConnectingOverlay.tsx:127-245`, `README.md:42-47`.

#### F-053 — Raw terminal typing and control sequences — **core**

- Controls: software/hardware keyboard input, Return, Backspace, Tab, Escape, arrows and arbitrary control/ANSI sequences; raw input is sent as bytes.
- Keyboard: `Shift+Enter` sends alternate/newline semantics rather than ordinary Return; the mobile return behavior tracks terminal mode; bracketed paste is honored.
- States: read-only when another controller owns the session, blocked/offline connection, warm/connected, input buffered/reconciled.
- API: PTY DataChannel writes; no per-keystroke REST.
- Evidence: `web/src/components/terminal/Terminal.tsx:53-228`, `web/src/components/terminal/Terminal.tsx:2150-2179`, `web/src/components/terminal/Terminal.tsx:2712-2764`.

#### F-054 — Mobile touch scrolling and keyboard geometry — **core**

- Touch behavior: distinguish terminal scrollback from page gesture; use terminal scroll when history exists, hand off at edges/alternate buffer as appropriate, support momentum, tap to focus.
- Keyboard behavior: opening the soft keyboard freezes the visible terminal rows and refits without output jumping; dismissing restores geometry.
- States: main vs alternate screen, top/bottom edge, momentum active, focused/unfocused, keyboard showing/hiding.
- API/transport: scroll/focus are local renderer actions; a committed fit sends the resulting PTY size over the session control path, never REST.
- Evidence: `web/src/components/terminal/Terminal.tsx:61-65`, `web/src/components/terminal/Terminal.tsx:1746-2148`.

#### F-055 — Mobile modifier/shortcut bar — **core**

- Controls: Paste, Esc, Tab, Shift-Tab, Ctrl-C, Arrow Up/Down/Left/Right, Send/Return.
- Interaction: pointer/touch-down must preserve terminal focus so tapping a modifier does not collapse the keyboard.
- States: enabled/read-only/disconnected, clipboard unavailable/failure.
- API: sends clipboard text or exact control sequences on PTY DataChannel.
- Evidence: `web/src/components/terminal/ModifierBar.tsx:14-83`, `web/src/components/terminal/ModifierBar.tsx:87-186`.

#### F-056 — Shared-view ownership and take control — **core**

- When another browser/device controls input, show a read-only viewer state identifying that fact and a Take control action.
- Controls: Take control; focus after ownership; terminal handle also exposes `takeControl()`.
- States: owner, viewer, ownership request pending/failure, changed controller.
- API/transport: session control channel ownership frames; terminal output remains visible.
- Evidence: `web/src/components/terminal/Terminal.tsx:53-228`, `web/src/components/terminal/Terminal.tsx:824-949`, `web/src/components/terminal/Terminal.tsx:3056-3350`.

#### F-057 — Connection and activity status overlays — **core**

- Shows connection stage without hiding meaningful cached output; reports live status in an accessible live region.
- Controls: Take control; Jump to latest when scrolled away. Connection recovery itself is automatic; the terminal overlay does not expose a generic Retry button.
- States: connection stages from F-052, terminal active/quiet/waiting/exited, new-output indicator.
- API/transport: Take control sends a control-channel ownership frame; Jump to latest only changes local terminal scroll state; connection status is derived from the existing signaling/WebRTC lifecycle.
- Evidence: `web/src/components/terminal/ConnectingOverlay.tsx:10-245`, `web/src/components/terminal/Terminal.tsx:3056-3350`.

#### F-058 — Connection diagnostics chip — **secondary**

- Shows direct/P2P/relay path, round-trip time, verified/first-contact/raw trust state.
- Controls: tap/open detail menu; inspect blocked reason, path, latency, identity/trust detail.
- States: negotiating, direct, relay, disconnected, first contact, verified, blocked with reason.
- API/transport: derived from session connection/signaling/control state; no standalone REST mutation.
- Evidence: `web/src/components/terminal/ConnectionChip.tsx:13-155`, `web/src/components/terminal/ConnectionChip.tsx:157-221`.

#### F-059 — Upload files into terminal cwd — **core**

- Controls/reachability: dropping non-image files on the live terminal is the reachable web control. `TerminalHandle` also exports `openUpload()` and owns a hidden multi-file input, but no inspected `web/src/app/` or `web/src/components/` call site invokes that method; the nearby source comment claiming a surface-header trigger is stale. There is no visible picker, ordinary Cancel, or Retry control in the current web UI.
- Limits/states: each file is capped at 20 MiB; uploading is shown by one byte-weighted, non-interactive hairline progress bar, then a transient success/error status. Dropping displays “Drop images into the prompt · other files save to the working directory.”
- Safety state: an ambiguous final dispatch is never retried automatically. A retained warning offers **Check in terminal** and **I checked — dismiss**; reconciliation storage failure locks new uploads until storage recovers and retained records are checked/dismissed.
- Effect: non-images upload to the session cwd over the authenticated `spawn.ctl` channel. This flow reports the compact saved path but does not automatically type that path into the terminal.
- Native equivalent: expose Upload in terminal chrome because iPhone has no desktop file-drop gesture; it invokes the already-implemented hidden-picker/handle behavior rather than introducing a new file operation.
- Evidence: `web/src/components/terminal/Terminal.tsx:2454-2710`, `web/src/components/terminal/Terminal.tsx:2976-3050`, `web/src/components/terminal/Terminal.tsx:3056-3350`, `web/src/components/terminal/upload-progress.ts:1-23`, `web/src/components/terminal/upload-progress-bar.tsx:1-66`.

#### F-060 — Paste or attach clipboard images — **core**

- Clipboard input distinguishes image data from text; images upload to the session attachment destination while text uses terminal paste semantics. Dropped images take this same path.
- Controls: OS paste, Paste modifier, and Remove on each settled ready/error image chip. In deferred mode, the next Return prepends one or more `@<compact-path>` references and consumes the ready chips; in bracketed-path mode, the quoted path is pasted immediately and the chip is removed.
- States: clipboard empty/permission unavailable, image over 20 MiB, uploading hairline, ready thumbnail, `err` thumbnail, removed/consumed, and the same reconciliation warning/lock as F-059. Uploading chips are deliberately hidden and therefore have no visible cancel control.
- API/transport: image bytes upload to `destination:"attachments"` over `spawn.ctl`; text/path insertion writes to the PTY DataChannel; Remove is local unless it races the internal upload abort.
- Evidence: `web/src/components/terminal/Terminal.tsx:2454-2710`.

#### F-061 — Selection and clipboard behavior — **core**

- Fine-pointer selection auto-copies selected terminal text; Paste writes text respecting terminal paste mode. Mobile must use explicit native selection/copy where auto-copy would be surprising.
- States: selection present/cleared, clipboard denied/unavailable, read-only ownership.
- API/transport: Copy uses the platform clipboard only; Paste writes to the PTY DataChannel and makes no REST call.
- Evidence: `web/src/components/terminal/Terminal.tsx:2176-2181`, `web/src/components/terminal/ModifierBar.tsx:14-83`.

#### F-062 — Terminal rendering conformance and themes — **core**

- Font size 13, line height 1.2, mono stack, 100,000 scrollback lines, 10,000 snapshot lines; Unicode 11 width tables; `convertEol:false`.
- Dark is `#0a0a0a` background and `#e5e5e5` foreground/cursor. Light is `#fcfcfc`/`#1f1f1f`, selection `#accef7`, inactive selection `#e1e6eb`, with the full ANSI palette below.
- States: light/dark resolved theme, GPU/canvas renderer fallback, resized DPR/font.
- API/effect: renderer/theme configuration is local; switching appearance may refit the renderer but performs no REST mutation.
- Evidence: `web/src/components/terminal/xterm-config.mjs:17-121`, `web/src/components/terminal/Terminal.tsx:3707-3721`.

```ts
// web/src/components/terminal/xterm-config.mjs:49-81
const LIGHT_ANSI = {
  black: "#000000", red: "#cd3131", green: "#00bc00", yellow: "#949800",
  blue: "#0451a5", magenta: "#bc05bc", cyan: "#0598bc", white: "#555555",
  brightBlack: "#666666", brightRed: "#cd3131", brightGreen: "#14ce14",
  brightYellow: "#b5ba00", brightBlue: "#0451a5", brightMagenta: "#bc05bc",
  brightCyan: "#0598bc", brightWhite: "#a5a5a5"
};
```

#### F-063 — Optional predictive echo, latency HUD, and renderer override — **secondary**

- `localStorage.spawnPredictEcho="on"` enables predictive local keystroke echo; reconciliation must remove predictions when authoritative output arrives.
- `localStorage.spawnLatencyHud="on"` enables the keystroke latency HUD; `spawnRenderer` can force `gpu` or the non-GPU path.
- States: preference off by default, supported/unsupported renderer, prediction confirmed/mismatch, latency available/unavailable.
- Native equivalent: hide these under Settings → Advanced diagnostics, retaining opt-in behavior.
- API/effect: local diagnostics/preferences only; predictions are reconciled against ordinary PTY output and are never sent as a separate API request.
- Evidence: `web/src/components/terminal/Terminal.tsx:2736-2755`, `web/src/components/terminal/Terminal.tsx:3707-3721`, `web/src/components/terminal/latency-hud.ts:1-30`, `web/src/components/terminal/predictive-echo.ts:1-143`.

#### F-064 — Warm live-terminal pool — **core**

- Up to six terminals stay warm under LRU management so workspace/tab navigation can park and reclaim a live session without reconnecting or losing scrollback.
- Handle contract includes raw/newline/bracketed-paste state and imperative send/fit/focus/upload/ownership operations.
- States: claimed, parked, evicted, reconnecting; eviction must clean transport/render resources.
- API/transport: parking/reclaiming is local pool bookkeeping around an existing WebRTC connection; claiming a cold session invokes the normal F-052 signaling/transport flow.
- Evidence: `web/src/components/terminal/LiveTerminalProvider.tsx:18-229`, `web/src/components/terminal/LiveTerminalProvider.tsx:231-310`, `web/src/components/terminal/Terminal.tsx:53-228`.

#### F-065 — Session files aside — **desktop-only-by-nature**

- Controls: show/hide Files, open a host file browser rooted at session cwd, resize/close as presentation allows.
- Web presentation is side-by-side on large screens and full overlay on small screens.
- States/API: all File Explorer connection/loading/empty/error states; direct host control.
- Native equivalent: swipe-dismissable full-screen Files overlay launched from terminal toolbar.
- Evidence: `web/src/components/files/session-files-aside.tsx:12-82`, `web/src/components/session/session-view.tsx:199-368`.

#### F-066 — Composer mode component — **secondary**

- Component supports Raw/Composer toggle, multiline textarea, Enter to send, Shift+Enter newline, and Send button.
- **UNKNOWN:** no inspected app/component call site establishes that this component is reachable in the current UI; retain it in the contract as an implemented component but do not place it in the primary native terminal until a call-site/product decision confirms reachability.
- API: sends composed text through the terminal handle/DataChannel.
- Evidence: `web/src/components/terminal/Composer.tsx:8-75`; no import was found under `web/src/app/` or `web/src/components/` other than its own module during the full-file grep.

### Files and direct host filesystem operations

The file UI does not call a server file REST API. It opens the authenticated host-control protocol and uses bounded direct streams. These constants are a mobile compatibility contract (`web/src/lib/hostControl.ts:7-22`, `web/src/lib/hostControl.ts:79-164`):

```ts
export const HOST_CONTROL_PROTOCOL = "spawn.host.ctl";
export const HOST_CONTROL_VERSION = 1;
const MAX_CONTROL_FRAME_BYTES = 16 * 1024;
const MAX_PENDING_REQUESTS = 32;
const STREAM_CHUNK_BYTES = 8 * 1024;
const STREAM_WINDOW_CHUNKS = 8;
const STREAM_BUFFERED_HIGH_WATER = 256 * 1024;
const FALLBACK_DOWNLOAD_MEMORY_LIMIT = 32 * 1024 * 1024;

interface HostDirEntry {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink" | "other";
  is_dir: boolean;
  size?: number | null;
  modified_at?: number | null;
}
```

#### F-067 — Host file-browser entry points — **secondary**

- Entry: Host detail → Files (`/hosts/{id}/files`), a workspace files tile, session detail Files, or mobile Files root.
- Host page controls: Back to host; current host name/status; render File Explorer.
- States: host loading, not found, load error, offline/direct-channel failure.
- API: `GET /api/hosts/{id}` then direct `spawn.host.ctl` operations.
- Evidence: `web/src/app/hosts/[id]/files/page.tsx:27-73`, `web/src/components/files/session-files-aside.tsx:12-82`.

#### F-068 — Browse a lazily paged directory tree — **secondary**

- Controls: select row; expand/collapse directory; reveal/expand an initial path in the tree; Refresh current tree; Collapse all; Load more page. There is no breadcrumb or filename-filter field in this explorer.
- Behavior: directories lazy-load and can be refreshed independently; retained pagination is bounded to 32 pages; the visible tree preserves expansion/selection where valid.
- States: connecting, directory skeleton, loaded, empty, load error with Retry, stale/reloading, truncated/page limit.
- API: direct `fs.home`; `fs.list {path?,cursor}` with at most 96 entries per response.
- Evidence: `web/src/components/files/FileExplorer.tsx:67-300`, `web/src/components/files/FileExplorer.tsx:455-560`, `web/src/components/files/fileExplorerPaging.ts:7-39`, `web/src/lib/hostControl.ts:421-466`.

#### F-069 — File-tree hardware keyboard navigation — **secondary**

- Arrow Down/Up selects next/previous visible item; Arrow Right expands/enters; Arrow Left collapses or moves to parent; Enter opens; Space pins preview; Escape closes preview/context; `F2` renames; Delete requests deletion.
- States: unavailable actions are ignored/disabled; delete remains confirmed; selection stays visible.
- Phone equivalent: hardware shortcuts remain; touch uses tap, disclosure, long press, and overflow actions.
- API/effect: selection/expand/collapse are local until a directory needs `fs.list`; Open/preview, rename, and delete delegate to F-076/F-077, F-073, and their direct host-control commands.
- Evidence: `web/src/components/files/FileExplorer.tsx:805-847`.

#### F-070 — Create a folder — **secondary**

- Controls: New folder; inline name; commit/cancel.
- Keyboard: Enter commits, Escape cancels, blur commits.
- States: empty/invalid/conflicting name, saving, direct-channel/API error; successful tree refresh/select.
- API: direct `fs.mkdir {path}`.
- Evidence: `web/src/components/files/FileExplorer.tsx:563-710`, `web/src/components/files/FileExplorer.tsx:969-1131`, `web/src/components/files/FileExplorer.tsx:1376-1413`, `web/src/lib/hostControl.ts:468-470`.

#### F-071 — Upload files — **secondary**

- Controls: Upload toolbar button; hidden multi-file picker; drag/drop on desktop. Files are uploaded sequentially; this File Explorer surface has no Cancel or Retry control.
- States: drag target; footer spinner with “Uploading N file(s)…”; per-file success/error status; collision/permission/direct-channel failure. It does not expose byte progress.
- API: direct streamed write/upload to the selected host/path, followed by list refresh.
- Evidence: `web/src/components/files/FileExplorer.tsx:563-710`, `web/src/components/files/FileExplorer.tsx:849-868`, `web/src/components/files/FileExplorer.tsx:969-1131`, `web/src/components/files/FileExplorer.tsx:1298-1374`, `web/src/lib/hostControl.ts:784-984`.

#### F-072 — Download a file — **secondary**

- Entry/controls: row context menu, viewer toolbar, preview renderer fallback.
- States: preparing/streaming/success/error; browser streaming-sink path vs a 32 MiB in-memory fallback limit.
- API: direct streamed file read/download with length/hash metadata.
- Native equivalent: stream to an Expo Go-accessible cache/document destination, then invoke the native share sheet; do not accumulate unbounded bytes in JS memory.
- Evidence: `web/src/components/files/FileExplorer.tsx:891-960`, `web/src/components/files/file-viewer-dialog.tsx:45-315`, `web/src/lib/hostControl.ts:7-22`, `web/src/lib/hostControl.ts:784-984`.

#### F-073 — Rename and delete files/directories — **secondary**

- Controls: Rename from menu or `F2`; inline text; Delete from menu/Delete key; destructive confirmation. Directory delete can be recursive as explicitly confirmed.
- Keyboard: rename Enter/blur commits, Escape cancels.
- States: name conflict/validation, permission error, channel error, deleting, stale selection after success.
- API: direct `fs.rename {path,name,overwrite}` and `fs.remove {path,recursive}`.
- Evidence: `web/src/components/files/FileExplorer.tsx:563-745`, `web/src/components/files/FileExplorer.tsx:1140-1295`, `web/src/lib/hostControl.ts:472-487`.

#### F-074 — Transfer a file to another trusted online host — **secondary**

- Controls: Send to host submenu lists every other host; choose one row to start. Offline rows are disabled. There is no destination-folder picker or confirmation: the file goes to destination `~`, resolved to that host's home.
- States: no other hosts hides the submenu; offline disabled; online selection may still fail closed if destination trust cannot be established; success/error status text. The current surface has no transfer progress or Cancel control.
- API: `GET /api/hosts`; two authenticated direct host-control channels stream source→destination, not through FastAPI.
- Evidence: `web/src/components/files/FileExplorer.tsx:176-191`, `web/src/components/files/FileExplorer.tsx:563-710`, `web/src/components/files/FileExplorer.tsx:891-960`, `web/src/lib/hostControl.ts:784-984`.

#### F-075 — File row context and overflow actions — **secondary**

- Entry: right-click or row kebab; native long press/overflow.
- Actions: Open preview; Reveal in the controlled host's file manager; Open with the host's default application when capability and file policy permit; Copy absolute path; Copy relative path; Download; Rename; Send to host; Delete.
- States: actions disabled/absent by entry type, executable/open policy, trust and host capability; clipboard/toast success/error.
- API/effect: Copy is local; the other actions dispatch the direct preview/read, `desktop.reveal`, `desktop.open`, download, `fs.rename`, transfer, or `fs.remove` operations specified in F-072–F-079.
- Evidence: `web/src/components/files/FileExplorer.tsx:740-745`, `web/src/components/files/FileExplorer.tsx:891-960`, `web/src/components/files/FileExplorer.tsx:1140-1295`.

#### F-076 — Hover preview and pinned preview — **desktop-only-by-nature**

- Fine-pointer hover intent opens a lightweight preview card; Space pins it; pointer leave/delay closes unpinned content.
- States: no preview, loading, ready, unsupported, error, pinned.
- Phone equivalent: no hover card; long press opens Quick Look sheet, tap opens full viewer.
- API: direct capability-gated stat/range/preview read.
- Evidence: `web/src/components/files/file-preview-card.tsx:18-183`, `web/src/components/files/use-preview.ts:1-82`, `web/src/components/ui/hover-intent.ts:1-146`.

#### F-077 — Full file viewer navigation and toolbar — **secondary**

- Controls: Close; Previous/Next sibling; Copy path; reveal in the host file manager; open on host; download; image Fit/Actual; mobile kebab for actions.
- Keyboard: dialog Escape closes through global dialog behavior; previous/next controls are focusable.
- States: auto-load when ≤4 MiB; larger file requires explicit Load preview; loading with Cancel; unsupported/oversize/error; content truncation notice.
- API: direct `fs.stat`, bounded `fs.read.range`, preview stream, open/reveal, and download.
- Evidence: `web/src/components/files/file-viewer-dialog.tsx:45-315`, `web/src/components/files/file-viewer-dialog.tsx:317-457`.

#### F-078 — Render supported preview formats safely — **secondary**

- Formats/states: image, PDF, video, audio, syntax-highlighted text/code, sanitized Markdown, host-rendered preview, plain metadata/unsupported, truncated text, codec failure, progress/cancel/error.
- Controls: media-native playback controls, open/download fallbacks, retry/cancel as applicable.
- Security: Markdown output is sanitized before display; executable/open decisions come from host capability/policy rather than file extension alone.
- API/transport: content comes from the bounded direct stat/range/preview stream in F-077; media playback and renderer controls are local, while fallback Open/Download use F-079/F-072.
- Evidence: `web/src/components/files/preview-renderers.tsx:30-386`, `web/src/components/files/file-viewer-dialog.tsx:45-315`.

#### F-079 — Open or reveal a file on the controlled desktop — **desktop-only-by-nature**

- Actions: Reveal invokes the host file manager; Open invokes the host OS application only if the daemon reports the capability and `open_allowed` policy.
- States: capability missing, non-openable/executable policy, host offline, direct request success/error.
- Phone equivalent: retain these as “Reveal on [host]” and “Open on [host]” remote commands; they do not open the file locally on the phone.
- API: direct `desktop.reveal` and `desktop.open` capability-gated methods.
- Evidence: `web/src/lib/preview/capabilities.ts:1-68`, `web/src/components/files/FileExplorer.tsx:891-960`, `web/src/lib/hostControl.ts:556-773`.

#### F-080 — File explorer retained-budget and exceptional states — **secondary**

- Global states include no connection, connecting, host offline, root/home error, empty directory, per-node error with retry, paged loading, truncated result, retained-page budget exhausted, operation progress, permission errors, and channel loss/reconnect.
- Mobile must retain visible feedback and retry at the affected row/path rather than replace the whole screen where possible.
- API/transport: Retry repeats the failed direct `fs.home`, `fs.list`, or row operation; retained-page eviction and expansion state are local.
- Evidence: `web/src/components/files/FileExplorer.tsx:67-300`, `web/src/components/files/FileExplorer.tsx:969-1131`, `web/src/components/files/fileExplorerPaging.ts:7-39`.

### Hosts and Legion fleet management

#### F-081 — Host list — **core**

- Entry: Settings → Hosts on web; Hosts root on mobile.
- Controls: select host; inline/overflow Rename; Remove; Add/connect host; refresh by query lifecycle.
- States: loading, error with Retry, empty, online/offline cards, last seen, OS/version/session count; list polls every 10 seconds.
- API: `GET /api/hosts`, `PATCH /api/hosts/{id}`, `DELETE /api/hosts/{id}`.
- Evidence: `web/src/components/settings/HostsPanel.tsx:23-219`, `web/src/lib/api.ts:541-558`.

#### F-082 — Add another host — **core**

- Entry: Hosts root/Settings and no-host states.
- Controls/states/API: exactly the install, pairing-code, fingerprint review, approval and polling contract in F-013; it is reusable after onboarding.
- Evidence: `web/src/components/settings/HostsPanel.tsx:23-219`, `web/src/components/hosts/connect-host.tsx:63-448`.

#### F-083 — First-contact host approval and pinning — **core**

- Approval must compare the pending server identity with the derived fingerprint, register/use the phone identity, sign the approval nonce, and persist the host pin before treating the connection as verified.
- Controls: Back, Approve, Retry/start over; never auto-approve a mismatch.
- States: unknown first contact, verified values, mismatch/block, already paired, approval expiry.
- API body fields are exact: `user_code`, `approval_nonce`, `host_key_algorithm`, `host_public_key`, `host_key_fingerprint`, `browser_device_id`, `browser_key_algorithm`, `browser_public_key`, `browser_key_fingerprint`, `signature`.
- Evidence: `web/src/lib/api.ts:398-426`, `web/src/lib/api.ts:516-539`, `web/src/components/hosts/connect-host.tsx:171-448`.

#### F-084 — Host detail — **core**

- Entry: `/hosts/{id}`; mobile `hosts/:hostId`.
- Header controls: Back; Files; inline Rename; overflow Rename/Remove; removal confirmation.
- Content: name/status, OS/architecture, daemon version, live session count, connection/last seen, identity key algorithm/public key/fingerprint, Host Agents panel, and recent/live sessions.
- States: host loading/not found/error, online/offline, rename mode/error, delete busy/error. Host polls every 30 seconds and sessions every 5 seconds.
- API: `GET/PATCH/DELETE /api/hosts/{id}`, `GET /api/sessions?host_id={id}`.
- Evidence: `web/src/app/hosts/[id]/page.tsx:59-226`, `web/src/app/hosts/[id]/page.tsx:228-430`.

#### F-085 — Rename or remove a host — **secondary**

- Rename controls: menu/inline input; Enter/blur commit, Escape cancel.
- Remove controls: destructive confirmation. Effect also writes a local trust tombstone/pin cleanup before/with control-plane removal so stale trust is not silently reused.
- States: mutation busy/error; deleting current/online host is clearly destructive.
- API: `PATCH /api/hosts/{id} {name}`, `DELETE /api/hosts/{id}` plus local trust-store mutation.
- Evidence: `web/src/app/hosts/[id]/page.tsx:59-226`, `web/src/lib/api.ts:547-558`.

#### F-086 — Host session list and session entry — **core**

- Rows show session name/agent/foreground identity, cwd, status/activity, and route to full session.
- States: session list loading/error/empty, running/starting/exited/killed; background polling every 5 seconds.
- API: `GET /api/sessions?host_id={hostId}`, then F-051 entry.
- Evidence: `web/src/app/hosts/[id]/page.tsx:228-430`, `web/src/lib/api.ts:771-784`.

#### F-087 — Host agent availability — **secondary**

- Visible for online hosts. Lists every agent definition with installed/version/update/policy state.
- Controls: Refresh; Install; Update/reinstall where indicated; disclosure of output/result.
- States: loading skeleton, load error with Retry, empty, host offline (panel absent), installed/missing/outdated, installing, result success/failure.
- API: `GET /api/hosts/{id}/agents`, `POST /api/hosts/{id}/agents/{agentId}/install`.
- Evidence: `web/src/components/hosts/HostAgentsPanel.tsx:18-199`, `web/src/lib/api.ts:559-569`.

#### F-088 — Per-host agent auto-update policy — **secondary**

- Control: Auto update switch per agent.
- States: on/off, disabled while saving, mutation failure rollback/toast.
- API: `PATCH /api/hosts/{hostId}/agents/{agentId}/policy {auto_update}`.
- Evidence: `web/src/components/hosts/HostAgentsPanel.tsx:18-199`, `web/src/lib/api.ts:570-575`.

#### F-089 — Legion/fleet overview — **secondary**

- Entry: `/legion`; mobile Hosts → Fleet Overview.
- Shows fleet summary and one card per host with status, capacity buckets/exact metrics, sessions needing attention, agent availability and hardware identity.
- Controls: Add host/Connect first host; select host; Exact/live metrics toggle; open host detail.
- States: hosts loading/error/empty, per-host online/offline, exact metrics connecting/unavailable/error; host query 15 s and session query 5 s.
- API: `GET /api/hosts`, `GET /api/sessions`; exact values use direct `host.metrics {}` over host control.
- Evidence: `web/src/app/legion/page.tsx:16-143`, `web/src/components/legion/LegionHostCard.tsx:16-150`.

#### F-090 — Legion host detail/preview — **desktop-only-by-nature**

- Web fine-pointer hover detail includes exact/coarse CPU, memory, load, uptime, specs, status, and up to six recent/live sessions.
- Controls: select a listed session/host detail; dismiss hover implicitly.
- Phone equivalent: tapping a fleet card pushes Host Detail; an optional explicit Metrics sheet replaces hover.
- API: host/session queries and direct exact metrics.
- Evidence: `web/src/components/legion/LegionHostDetail.tsx:8-115`, `web/src/components/legion/LegionStrip.tsx:26-232`.

### Settings, account, agents, skills, templates, devices, and trust

#### F-091 — Settings section navigation — **secondary**

- Web dialog sections: Account, Appearance, Notifications, Hosts, Agents, Skills, Templates, Browser devices, Device trust, plus Admin only for `user.is_admin`.
- Controls: section list, back/close dialog. The currently selected section is held in a central external store rather than a URL.
- States: open/closed, selected section, admin hidden/visible.
- Native equivalent: Settings is a root tab with a pushed screen per section; Hosts also has a first-class root, while the Settings Hosts row deep-links there.
- API/effect: selecting/closing a section changes only navigation/store state; each destination owns the calls specified in F-092–F-103.
- Evidence: `web/src/components/settings/SettingsDialog.tsx:37-120`, `web/src/components/settings/settings-dialog-store.ts:5-71`.

#### F-092 — Account settings and deletion — **secondary**

- Shows email and verification state. Controls: Resend verification; Logout; Delete account; confirmation email field; Password field optional/conditional for OAuth; permanent-delete confirmation/cancel.
- States: verified/unverified, resend busy/sent/error, delete form validation, wrong password/error, deleting.
- Effects: deletion permanently removes account-owned data and returns to signed-out flow.
- API: `POST /api/auth/verify-email/request`, `POST /api/auth/logout`, `POST /api/account/delete {confirm_email,password?}`.
- Evidence: `web/src/components/settings/AccountPanel.tsx:11-165`, `web/src/lib/api.ts:693-697`.

#### F-093 — Appearance — **secondary**

- Controls: Light, Dark, System radio choices.
- Behavior: resolves system preference, applies immediately to app chrome and every live/warm terminal, and persists preference.
- States: three choices and live resolved light/dark.
- API: none; local preference/theme provider.
- Evidence: `web/src/components/settings/AppearancePanel.tsx:8-75`, `web/src/components/terminal/xterm-config.mjs:28-85`.

#### F-094 — Notifications — **secondary**

- Events: session finished, awaiting input, and died. Channels: in-app, sound, system notification, vibration.
- Controls: each event/channel toggle; request system permission; Test notification. Individual sessions also expose Mute/unmute.
- States: browser/platform channel unsupported, permission default/granted/denied, alert stream connected/disconnected/retrying, test success/failure, preference on/off.
- API/transport: preferences are managed by the notifications layer; alert stream supplies events; session mute is local/session preference in the pane UI.
- Native requirement: map vibration to Expo haptics where possible and system notifications to Expo Notifications only if Expo Go supports the required runtime path; always retain in-app fallback.
- Evidence: `web/src/components/settings/NotificationsPanel.tsx:26-235`, `web/src/components/workspace/session-pane.tsx:268-593`.

#### F-095 — Hosts settings panel — **secondary**

- Provides the same list, rename, remove, status, and Connect Host section as F-081/F-082 inside Settings.
- Native equivalent: a Settings row deep-links into the Hosts root rather than duplicate stateful screens.
- API: `GET/PATCH/DELETE /api/hosts` resources plus F-013 device pending/approval calls; this panel adds no separate endpoint.
- Evidence: `web/src/components/settings/HostsPanel.tsx:23-219`.

#### F-096 — Agent definitions and yolo preferences — **secondary**

- List distinguishes built-in immutable definitions from user-owned definitions. Controls: Add, Edit custom, Delete custom, Yolo/skip-confirmation preference.
- Editor fields: Name, Kind, Command, Install command, yolo args, yolo environment, normal environment key/value rows; add/remove env row; Save/Cancel.
- States: loading/error/empty, built-in read-only, field validation/duplicate env key, save/delete busy/error.
- API: `GET/POST /api/agents`, `PATCH/DELETE /api/agents/{id}`, `PATCH /api/agents/{id}/preferences {yolo}`.
- Evidence: `web/src/components/settings/AgentsPanel.tsx:34-187`, `web/src/components/settings/AgentsPanel.tsx:189-488`, `web/src/components/settings/agent-form.ts:1-45`, `web/src/lib/api.ts:988-1015`.

#### F-097 — Skills library — **secondary**

- Controls: Add skill; edit existing; Delete; Name, Description, Content text fields; Enabled by default switch; Save/Cancel.
- States: list loading/error/empty, new/edit form, validation, save/delete busy/error.
- API: `GET/POST /api/skills`, `PATCH/DELETE /api/skills/{id}`.
- Evidence: `web/src/components/settings/SkillsPanel.tsx:12-196`, `web/src/lib/api.ts:1017-1036`.

#### F-098 — Workspace templates management — **secondary**

- Rows summarize tabs/windows/agents and show icon/home metadata.
- Controls: inline Rename; Enter/Save, Escape/Cancel; Change icon; Delete with confirmation.
- States: loading, empty, populated, editing, saving/icon/delete mutation error. The current list query has no explicit error branch: a failed query falls through to the “No templates yet” message.
- API: `GET /api/workspace-templates`, `PATCH/DELETE /api/workspace-templates/{id}`.
- Evidence: `web/src/components/settings/TemplatesPanel.tsx:13-217`, `web/src/lib/api.ts:949-985`.

#### F-099 — Browser/mobile device identities — **core**

- Shows this device and all registered Ed25519 browser identities, labels, fingerprints, created/revoked status.
- Controls: Retry registration; Retry local key deletion; Start fresh on this browser; Rename with Save/Cancel (Escape also cancels, maximum 64 characters); Approve an untrusted peer; Revoke with fingerprint-bearing confirmation; expand Revoked devices; Clear history with confirmation; Unlock saved trust; Connect a host; open Device trust.
- States: registration loading/error/ready; local/server identity load error; no registered browsers; this-browser badge; trusted with host count; not trusted yet; introduction waiting/available; approval expanded/result; revoked; cleanup pending; untrusted replacement with locally derived fingerprint; rename/revoke/prune busy/error. Clear history deletes tombstones only and cannot reverse revocation.
- API: `POST /api/browser-devices/register`, `GET /api/browser-devices`, `PATCH /api/browser-devices/{id}`, `POST /api/browser-devices/{id}/revoke`, `POST /api/browser-devices/prune` plus local keystore.
- Evidence: `web/src/components/settings/DevicesPanel.tsx:25-220`, `web/src/components/settings/DevicesPanel.tsx:221-385`, `web/src/components/settings/DevicesPanel.tsx:387-541`, `web/src/lib/api.ts:584-619`.

#### F-100 — Device trust status and local trust material — **core**

- Shows whether local browser/device identity is ready, revoked, untrusted, backed up, or needs repair; exposes fingerprint/storage diagnostics.
- Controls: Set up a passkey; Unlock saved trust here; Add a backup passkey; Revoke a passkey; expand Recovery & diagnostics; Forget trust on this browser; jump to Browser devices for approvals.
- States: passkey unsupported; setup needed; sealed bundle present/absent; local recognized-host count; passkey count; setup/unlock/import/add/revoke/forget busy and result/error; storage report checking/ready/failure with identity, plain value, Ed25519 and ECDSA persistence facts; stale bundle revision/conflict; local identity not persisted. Forget leaves connections unprotected until trusted again.
- API: trust bundle and passkey endpoints plus local cryptographic storage.
- Evidence: `web/src/components/settings/TrustPanel.tsx:27-272`, `web/src/components/settings/TrustPanel.tsx:274-485`, `web/src/lib/api.ts:699-769`.

#### F-101 — Passkey-PRF encrypted trust backup — **core**

- Controls: Set up creates the first PRF passkey and seals current verified hosts in one action; Unlock evaluates a known passkey and imports the bundle; Add backup authenticates with an existing passkey then enrolls a second; Forget removes local host trust; Revoke reseals for the sole survivor then removes the credential.
- Concurrency: bundle writes use an expected revision so a stale device cannot blindly overwrite newer trust state.
- States: WebAuthn/PRF unsupported, user canceled, credential created, bundle absent, locked, decrypted/import counts, revision conflict, operation error. Revoke is enabled only with exactly two passkeys: one would lock the user out, and more than two cannot be resealed for every survivor by this device.
- API: `GET/PUT /api/trust/bundle` and passkey credential/challenge endpoints defined by the trust client surface.
- **UNKNOWN:** managed Expo Go may not expose the WebAuthn PRF extension or secure Ed25519 APIs needed for a native-equivalent flow. A web trust-settings handoff can preserve access behavior, but is not full native parity; this needs a physical-device spike before implementation planning closes.
- Evidence: `web/src/components/settings/TrustPanel.tsx:27-272`, `web/src/components/settings/TrustPanel.tsx:274-485`, `web/src/lib/api.ts:699-769`.

#### F-102 — Endorse a new device from trusted hosts — **core**

- Shows a locally derived candidate fingerprint; the operator compares it on both devices. The current trusted browser signs one endorsement for every keyed host whose server pin list names this browser.
- Controls: It matches — approve; Cancel. After an inline failure the approve control can be pressed again; there is no separate Retry.
- States: current identity absent/unregistered; no host trusts this browser; derived/claimed fingerprint mismatch (must block); approving; per-call/signing failure; complete host count.
- API/transport: `GET /api/browser-devices`, `GET /api/hosts`, repeated `GET /api/trust/hosts/{hostId}/pins`, repeated `POST /api/trust/endorsements`; signing is local rather than a direct live-host request.
- Evidence: `web/src/components/trust/device-endorsement.tsx:19-184`.

#### F-103 — Introduction/link-device acceptance — **core**

- Polls endorsements every 15 seconds; when locally verified introductions exist, groups them by endorsing device and shows that device's label/fingerprint plus every vouched-for host. With none, the panel renders nothing—there is no visible waiting state.
- Controls: It matches — verify these hosts. There is no Reject, Cancel, or separate Retry control; leaving the settings surface is the non-accept path.
- States: hidden/no verified introductions, verifying/accepting, approved host count, partial local-import failures, error.
- API/transport: `GET /api/trust/endorsements?endorsed_device_id=…`; signatures are verified locally and accepted host keys are pinned locally.
- Evidence: `web/src/components/trust/introduction-panel.tsx:21-121`.

### Profile and administration long tail

#### F-104 — Fleet/activity profile details and share — **secondary**

- The profile includes identity, fleet totals, machine summaries, a UTC activity heatmap, and agent usage/summaries; safe share text excludes secrets.
- Controls: Copy stats and Close; there is no Retry button in the current dialog.
- States/API: loading skeleton, inline error, populated; `GET /api/profile`; two-second Copied state or clipboard-denial toast.
- Evidence: `web/src/components/profile/ProfileDialog.tsx:83-315`, `web/src/lib/api.ts:689-691`.

#### F-105 — Admin authorization and section entry — **secondary**

- Entry: Settings Admin or `/admin`; wraps AuthGate and then checks `user.is_admin`.
- Controls: Invites, Users, Emails sections; Back/Exit admin.
- States: auth/user loading, non-admin Not found, selected section.
- API: `GET /api/me`; section endpoints below.
- Evidence: `web/src/app/admin/layout.tsx:8-68`, `web/src/app/admin/page.tsx:23-39`, `web/src/components/settings/SettingsDialog.tsx:91-103`.

#### F-106 — Admin invitations — **secondary**

- Controls: optional Email restriction; expiry hours numeric field (1–720, default 72); Create invite; Copy fresh invitation URL; Dismiss fresh result; Revoke existing invite.
- States: list loading/empty; create validation/error; creating; fresh unredacted URL; copied; pending/used/expired/revoked rows; revoke busy. The current UI has no explicit list-query or revoke-error branch: a failed list renders an empty table and a failed revoke leaves the row without feedback, gaps mobile parity should reproduce only if strict behavioral identity is required.
- API: `GET/POST /api/admin/invites`, `POST /api/admin/invites/{id}/revoke`.
- Evidence: `web/src/app/admin/page.tsx:250-430`, `web/src/lib/api.ts:668-687`.

#### F-107 — Admin users — **secondary**

- Read-only table/list shows email, joined time, verified state, host/session/device counts, and admin badge.
- Controls: section switch only; no per-user mutation in the inspected UI.
- States: loading, explicit load error, populated; a successful empty result renders an empty table body with no dedicated empty message.
- API: `GET /api/admin/users`.
- Native equivalent: vertical cards or horizontally scrollable data rows; do not omit fields.
- Evidence: `web/src/app/admin/page.tsx:181-248`, `web/src/lib/api.ts:677-677`.

#### F-108 — Admin email delivery diagnostics — **secondary**

- Shows mail configuration/status and sent email records.
- Controls: Send test email; expand/collapse an email record; section switch. There is no recipient field; the web call always supplies `null`, leaving recipient selection to server behavior.
- States: mail status checking then configured/delivering or not delivering; email-list loading/empty/populated; send busy/sent/not-delivered/error note; redacted body/metadata expansion. There is no explicit status/list query-error branch—the missing data falls through to “Not delivering” and/or “No email sent yet.”
- API: `GET /api/admin/mail`, `GET /api/admin/emails`, `POST /api/admin/emails/test {to:null}`.
- Evidence: `web/src/app/admin/page.tsx:39-178`, `web/src/lib/api.ts:668-676`.

### Shared interaction, state, and visual-system capabilities

#### F-109 — Dropdown, context, and cascade menus — **secondary**

- Dropdowns support anchor or explicit right-click coordinates, outside click, Escape, Arrow Up/Down roving focus, disabled/checkable/destructive items.
- Cascade menus switch below 768 px to a sheet with parent/back navigation, loading/empty states, and the same keyboard semantics.
- Native equivalent: action sheets for short menus and pushed/sheet drill-down for host→folder or destination cascades.
- API/effect: menu navigation/dismissal is local; activating an item invokes that item's documented callback/API and disabled items invoke nothing.
- Evidence: `web/src/components/ui/dropdown-menu.tsx:27-210`, `web/src/components/ui/dropdown-menu.tsx:212-297`, `web/src/components/ui/cascade-menu.tsx:31-86`, `web/src/components/ui/cascade-menu.tsx:185-472`.

#### F-110 — Dialog, bottom-sheet, popover, and drawer behavior — **secondary**

- Dialogs support constrained sizes, full-mobile/full-viewer variants, focus trapping/restoration, scrim and Escape dismissal where permitted.
- Web bottom sheet uses a drag handle and dismisses after >90 px downward drag; left drawer axis-locks and dismisses after >70 px left drag. Both lock background scroll.
- Native equivalent: platform modal stacks/sheets with interactive dismissal; confirmation and destructive work must disable accidental drag dismissal while submitting.
- API/effect: presentation, drag, focus, scrim, and dismissal are local; content controls own any mutation.
- Evidence: `web/src/components/ui/dialog.tsx:9-149`, `web/src/components/ui/sheet.tsx:14-149`, `web/src/components/ui/drawer.tsx:15-178`, `web/src/components/ui/popover.tsx:1-128`.

#### F-111 — Global confirmation and toast feedback — **secondary**

- Any surface can await a singleton confirmation. Destructive confirms initially focus Cancel; safe confirms focus Confirm.
- Toast kinds include info/success/error with action and dismiss; info defaults to 5 s, error to 8 s, queue maximum is five, and duplicates coalesce.
- Native equivalent: centralized confirmation-sheet service and in-app toast host above every stack/overlay; critical errors must not depend on ephemeral toast alone.
- API/effect: confirmation resolves a local promise; only the caller's confirmed callback performs its documented mutation. Toast action/dismiss are local unless the supplied action callback triggers work.
- Evidence: `web/src/components/ui/confirm.tsx:14-109`, `web/src/components/ui/toast.tsx:7-241`.

#### F-112 — Accessible focus, labels, motion, and status — **core**

- Controls retain visible focus rings, accessible names/roles, status text in addition to color, focus containment/restoration, and keyboard paths described above.
- Meaningful motion arms one frame after mount so navigation does not replay false transitions; global CSS handles reduced motion.
- Native equivalent: VoiceOver labels/hints/state, Dynamic Type within tested bounds, Reduce Motion, Reduce Transparency/contrast checks, and haptics suppressed when system accessibility settings request it.
- API/effect: accessibility and motion behavior is local/platform state and does not add a network call.
- Evidence: `web/src/components/ui/armed-motion.ts:5-27`, `web/src/components/ui/status.tsx:5-63`, `web/src/app/globals.css:1-752`, `docs/DESIGN.md:152-171`.

#### F-113 — Standard loading, empty, error, disabled, and status primitives — **core**

- Reusable primitives cover spinner/skeleton, EmptyState, badges/status dots, cards, inputs/labels/textareas, switches, collapse, tooltip, and button variants.
- Together they can represent initial loading, refresh, empty success, recoverable error, offline/capability-disabled, and mutation-in-flight states. The exact inventory above records where the current web surface intentionally omits Retry or lets a query error fall through to empty; mobile must not assume every error has a Retry control.
- API/effect: these are presentation primitives; a Retry/button callback repeats only the owning screen's documented query or mutation.
- Evidence: `web/src/components/ui/spinner.tsx:1-31`, `web/src/components/ui/skeleton.tsx:1-5`, `web/src/components/ui/empty-state.tsx:1-53`, `web/src/components/ui/badge.tsx:1-35`, `web/src/components/ui/status.tsx:1-63`, `web/src/components/ui/button.tsx:1-58`.

#### F-114 — Shared brand/icon language — **secondary**

- Workspace, agent/provider, file-type, product, and generic action icons come from shared icon components/Lucide-style strokes; status must not use arbitrary emoji or bespoke visual vocabularies.
- The BrandMark and agent/file icon mappings must be ported as assets/components with accessible labels where informative.
- API/effect: visual mapping is local and has no network mutation.
- Evidence: `web/src/components/icons/BrandMark.tsx:1-63`, `web/src/components/icons/AgentIcon.tsx:1-177`, `web/src/components/files/file-icon.tsx:1-67`, `docs/DESIGN.md:223-239`.

#### F-115 — Centralized client data and optimistic derived state — **core**

- Web behavior relies on centralized cached queries, invalidation, optimistic workspace layout saves, locally derived child/status/attention/capability values, and small global stores for settings/profile/terminal pools.
- Native parity must not let individual screens independently reinterpret workspace/tab/session relationships or status semantics.
- API/effect: the store owns all REST/direct-channel query caching, mutations, optimistic patches, rollback, invalidation, and local derived selectors; it adds no endpoint of its own.
- Evidence: `web/src/app/w/[id]/page.tsx:35-200`, `web/src/components/workspace/workspace-grid.tsx:299-420`, `web/src/components/profile/profile-dialog-store.ts:1-39`, `web/src/components/settings/settings-dialog-store.ts:5-71`, `web/src/components/terminal/LiveTerminalProvider.tsx:18-310`.

#### F-116 — Direct host-control capability negotiation — **core**

- Operations must remain hidden/disabled until the host advertises the relevant capability; connection state is `idle | connecting | open | ready | closed | error`.
- File stat/range/preview, desktop reveal/open, upload/write/transfer, exact metrics, and folder listing are direct operations with request/stream bounds, timeouts, validation, and reconnect behavior.
- API/transport: the authenticated `spawn.host.ctl` v1 DataChannel exchanges hello/request/response/stream frames; capability checks and frame validation happen before dispatch, with no file-byte relay through FastAPI.
- Evidence: `web/src/lib/hostControl.ts:7-22`, `web/src/lib/hostControl.ts:54-164`, `web/src/lib/hostControl.ts:421-487`, `web/src/lib/hostControl.ts:556-984`, `web/src/lib/preview/capabilities.ts:1-68`.

#### F-117 — Offline and partial-fleet operation — **core**

- Workspaces and historical session metadata remain navigable when hosts are offline; creation/install/exact-files actions are disabled for affected hosts; offline panes expose clear restart/recovery states rather than disappearing.
- Restore can leave a child stopped when its host is offline; all-hosts-offline bootstrap offers navigation/connection recovery rather than an empty crash.
- API/effect: cached/control-plane workspace, host, and session reads remain usable; mutations/direct host commands targeting an offline host are withheld until host status permits them.
- Evidence: `web/src/app/app/page.tsx:112-214`, `web/src/components/workspace/session-pane.tsx:268-593`, `web/src/lib/api.ts:931-944`.

#### F-118 — Safe destructive-action hierarchy — **core**

- Existing friction is action-specific: account deletion requires typing the account email (and password when applicable); workspace/tab/session/host/template/file deletion uses scoped confirmation; device revoke and revoked-history clearing use fingerprint/history-bearing browser confirms; agent/skill deletion uses a browser confirm. Passkey Revoke begins from its button and requires the surviving passkey ceremony but has no separate app confirmation; admin invite Revoke is immediate and also has no confirmation.
- Close/restart/common actions must not sit adjacent to destructive actions without separation; the session pane intentionally gives Close its own menu. Native should retain exact consequences and preferably normalize browser confirms into the centralized confirmation sheet without adding a second confirm after a platform passkey prompt.
- API/effect: cancellation performs no mutation; confirmation dispatches the owning account/workspace/session/host/template/file/device/agent/skill endpoint or direct `fs.remove` operation documented above.
- Evidence: `web/src/components/ui/confirm.tsx:14-109`, `web/src/components/workspace/session-pane.tsx:268-593`, `web/src/components/settings/AccountPanel.tsx:11-165`, `web/src/components/settings/TrustPanel.tsx:232-272`, `web/src/app/admin/page.tsx:279-282`.

#### F-119 — Hardware-keyboard parity on iPhone/iPad — **secondary**

- Preserve terminal raw keys/modifier bar, file-tree keys, folder-picker navigation, rename Enter/Escape, menu arrow navigation, dialog Escape, and useful grid/tab shortcuts when a hardware keyboard is connected.
- Do not intercept raw terminal shortcuts while terminal focus owns them; global shortcuts should be disabled during terminal typing or text-field editing.
- API/effect: each shortcut triggers the same local action, REST mutation, or direct-channel command as its visible control; the shortcut layer adds no independent endpoint.
- Evidence: `web/src/components/terminal/Terminal.tsx:2712-2764`, `web/src/components/files/FileExplorer.tsx:805-847`, `web/src/components/workspace/folder-picker.tsx:442-702`, `web/src/components/workspace/workspace-tabs.tsx:420-558`.

#### F-120 — Public/about content from the authenticated app — **secondary**

- Security, Download/install, source/open-source information, and account Login/Signup destinations remain reachable through Settings → About/Help or external browser even though they are not primary native roots.
- Native must not duplicate desktop marketing animation inside the operational stack; content can open in an in-app browser/external browser while preserving links.
- API/effect: opening static/about links is navigation only; Login/Signup use F-007/F-008 when reached signed out.
- Evidence: `web/src/app/page.tsx:20-503`, `web/src/app/security/page.tsx:24-280`, `web/src/app/download/page.tsx:19-285`.

#### F-121 — Test-defined helper invariants — **core**

- Agent command construction, form validation, folder page limits, grid placement/reflow, hover/menu positioning, live write buffering, predictive echo, upload progress, socket handling, icon mapping, and onboarding step transitions have colocated tests; mobile implementations should turn their observable invariants into platform-neutral unit tests rather than port DOM mechanics.
- API/effect: no user-facing endpoint; tests verify the observable behavior around the REST/direct-channel operations named by their owning capabilities.
- Evidence: `web/src/components/workspace/agent-command.test.ts:1-128`, `web/src/components/workspace/workspace-grid-helpers.test.ts:1-594`, `web/src/components/terminal/useSessionSocket.test.ts:1-25`, and the complete test-file ledger below.

## Control-plane and direct-channel call matrix

This is the compact call checklist for mobile data-layer planning. Request/response schemas are runtime-validated with Zod in the web client; native must validate equivalent boundaries instead of trusting JSON. The authoritative schema and method definitions are in `web/src/lib/api.ts:70-106`, `web/src/lib/api.ts:234-390`, `web/src/lib/api.ts:398-469`, and `web/src/lib/api.ts:473-1036`.

### Account and authentication

| Method and path | Exact meaningful body/query | Triggering capability |
|---|---|---|
| `POST /api/auth/signup` | `{email,password,invite?:string|null}` | F-008 |
| `POST /api/auth/login` | `{email,password}` | F-007 |
| `POST /api/auth/logout` | none | F-023/F-092 |
| `POST /api/auth/password-reset/request` | `{email}` | F-009 |
| `POST /api/auth/password-reset/confirm` | `{token,new_password}` | F-010 |
| `POST /api/auth/verify-email/request` | none | F-012/F-092 |
| `POST /api/auth/verify-email/confirm` | `{token}` | F-011 |
| `GET /api/me` | none | F-006 |
| `GET /api/auth/config` | none | F-006–F-012 |
| `POST /api/auth/device/pending` | `{user_code}` | F-013/F-083 |
| `POST /api/auth/device/approve` | signed host+device identity body listed in F-083 | F-013/F-083 |
| `POST /api/account/delete` | `{confirm_email,password?}` | F-092 |

Evidence: `web/src/lib/api.ts:473-539`, `web/src/lib/api.ts:693-697`.

### Hosts, sessions, and access

| Method and path | Exact meaningful body/query | Triggering capability |
|---|---|---|
| `GET /api/hosts` | none | F-006, F-013, F-081 |
| `GET /api/hosts/{id}` | none | F-067/F-084 |
| `PATCH /api/hosts/{id}` | `{name}` | F-081/F-085 |
| `DELETE /api/hosts/{id}` | none | F-081/F-085 |
| `GET /api/hosts/{id}/agents` | none | F-036/F-087 |
| `POST /api/hosts/{id}/agents/{agentId}/install` | none | F-047/F-087 |
| `PATCH /api/hosts/{id}/agents/{agentId}/policy` | `{auto_update?:boolean}` | F-088 |
| `GET /api/sessions?host_id={id}` | host query optional | F-086/F-089 |
| `GET /api/sessions/{id}` | none | F-046/F-051/F-052 |
| `POST /api/sessions` | `{host_id,cwd,name?,skill_ids?,workspace_id?,tile?:{x,y,w,h}}` | F-035/F-036/F-046 |
| `PATCH /api/sessions/{id}` | `{name?:string|null}` | F-045/F-051 |
| `POST /api/sessions/{id}/restart` | `{}` | F-046/F-051 |
| `DELETE /api/sessions/{id}` | none; kill + hard delete | F-028/F-046/F-051 |
| `GET /api/sessions/{id}/access` | none | F-028/F-036/F-043/F-046 |
| `PATCH /api/sessions/{id}/access` | `{skill_ids?:string[]}` | F-028/F-036/F-043/F-046 |

Evidence: `web/src/lib/api.ts:541-582`, `web/src/lib/api.ts:771-834`.

`hosts.recentDirs(id)` declares `GET /api/hosts/{id}/recent-dirs` with a maximum-eight response, but no call site exists under the inspected `web/src/app/` or `web/src/components/` tree; it is therefore not a reachable parity capability (`web/src/lib/api.ts:576-581`).

### Workspaces, templates, agents, and skills

| Method and path | Exact meaningful body/query | Triggering capability |
|---|---|---|
| `GET /api/workspaces` | no query = active ordered by `position`; `?archived=true` = archived only | F-017/F-020 |
| `GET /api/workspaces/{id}` | none | F-024 |
| `POST /api/workspaces` | `{name?,first_session?:{host_id,cwd,skill_ids?},host_id?,cwd?,icon?,icon_source?}` | F-014/F-030/F-031 |
| `PATCH /api/workspaces/{id}` | any of `{name,layout,position,host_id,cwd,icon,icon_source}` | F-019/F-025–F-050 |
| `POST /api/workspaces/{id}/archive` | none | F-019/F-033 |
| `POST /api/workspaces/{id}/unarchive` | none | F-020/F-033/F-050 |
| `DELETE /api/workspaces/{id}` | none | F-019/F-033 |
| `GET/POST /api/workspace-templates` | create `{name,host_id?,cwd?,spec,icon?,icon_source?}` | F-031/F-039/F-098 |
| `PATCH/DELETE /api/workspace-templates/{id}` | editable create fields | F-098 |
| `GET/POST /api/agents` | create agent fields in F-096 | F-036/F-096 |
| `PATCH/DELETE /api/agents/{id}` | partial agent definition / none | F-096 |
| `PATCH /api/agents/{id}/preferences` | `{yolo?:boolean}` | F-096 |
| `GET/POST /api/skills` | create `{name,description?,content,enabled_by_default?}` | F-097 |
| `PATCH/DELETE /api/skills/{id}` | partial skill / none | F-097 |

Template `spec.version` is `2`, contains 1–8 named tabs, and each tile has geometry plus `run:{kind:"shell"|"agent"|"files",command}` (`web/src/lib/api.ts:836-878`). Endpoint evidence: `web/src/lib/api.ts:880-1036`.

### Browser devices, trust, profile, and admin

| Method and path | Exact meaningful body/query | Triggering capability |
|---|---|---|
| `POST /api/browser-devices/register` | `{key_algorithm:"ed25519",public_key,signature,label?}` | F-015/F-099 |
| `GET /api/browser-devices` | none | F-099/F-102 |
| `PATCH /api/browser-devices/{id}` | `{label}` | F-099 |
| `POST /api/browser-devices/{id}/revoke` | `{expected_public_key}` | F-099 |
| `POST /api/browser-devices/prune` | none | F-099 |
| `GET /api/trust/bundle` | none; returns bundle or null | F-100/F-101 |
| `PUT /api/trust/bundle` | `{sealed,expected_revision:number|null}` | F-101 |
| `GET/POST /api/trust/passkeys` | add `{credential_id,label}` | F-101 |
| `DELETE /api/trust/passkeys/{id}` | none | F-101 |
| `GET /api/trust/hosts/{hostId}/pins` | none | F-102 |
| `GET /api/trust/endorsements?endorsed_device_id={id}` | candidate id | F-103 |
| `POST /api/trust/endorsements` | `{host_id,endorser_device_id,endorsed_device_id,signature}` | F-102 |
| `GET /api/profile` | none | F-022/F-104 |
| `GET /api/admin/mail` | none | F-108 |
| `GET /api/admin/emails` | none | F-108 |
| `POST /api/admin/emails/test` | web passes `{to:null}`; API accepts optional recipient | F-108 |
| `GET /api/admin/users` | none | F-107 |
| `GET/POST /api/admin/invites` | create `{email?:string|null,ttl_hours?:number|null}` | F-106 |
| `POST /api/admin/invites/{id}/revoke` | none | F-106 |

Evidence: `web/src/lib/api.ts:584-619`, `web/src/lib/api.ts:668-769`. The admin Emails screen itself has no recipient field: its test mutation always passes `null` (`web/src/app/admin/page.tsx:39-58`, `web/src/app/admin/page.tsx:106-113`).

### Direct `spawn.host.ctl` command family

| Command/action | Meaning | Triggering capability |
|---|---|---|
| `ping` | liveness | F-116 |
| `fs.home` | resolve daemon user home | F-030/F-035/F-038/F-068 |
| `fs.list {path?,cursor}` | page directory | F-038/F-068 |
| `fs.mkdir {path}` | create folder | F-070 |
| `fs.rename {path,name,overwrite}` | rename | F-073 |
| `fs.remove {path,recursive}` | delete | F-073 |
| `fs.stat {path}` | metadata without listing parent | F-075/F-077/F-078 |
| `fs.read {path}` | full integrity-checked stream | F-072/F-078 |
| `fs.read.range {path,offset,length}` | bounded slice, maximum 16 MiB | F-077/F-078 |
| `fs.preview {path,max_pixels}` | host-rendered preview; pixels exactly 128/256/512/1024 | F-076–F-078 |
| `fs.write.begin {dir,name,length,sha256,overwrite?}` + stream frames | host destination write with progress/integrity | F-071/F-074 |
| `desktop.reveal {path}` / `desktop.open {path}` | remote host file-manager/application action | F-075/F-079 |
| `host.metrics {}` | exact CPU %, used/total memory, load-one, uptime and host spec | F-089/F-090 |

The public client methods validate directory cursor monotonicity and response shape; an invalid response fails the RTC channel rather than rendering unsafe data (`web/src/lib/hostControl.ts:421-487`). Stream/stat/preview/open/write implementations and their request validation are in `web/src/lib/hostControl.ts:489-984`.

The JSON control-frame envelope is exact and versioned:

```jsonc
// request — web/src/lib/hostControl.ts:348-370
{
  "version": 1,
  "type": "request",
  "request_id": "<UUID>",
  "operation": "fs.list",
  "payload": { "path": "/home/me", "cursor": 0 }
}

// daemon greeting — web/src/lib/hostControl.ts:1253-1282
{
  "version": 1,
  "type": "hello",
  "protocol": "spawn.host.ctl",
  "capabilities": ["fs.read.range", "fs.preview", "host.metrics"]
}

// response — web/src/lib/hostControl.ts:1394-1404
{ "version": 1, "type": "response", "request_id": "<same UUID>", "ok": true, "result": {} }
// failure replaces result with: "error": {"code":"…","detail":"…"}

// stream frames — web/src/lib/hostControl.ts:1284-1388, web/src/lib/hostControl.ts:1448-1467
{ "version": 1, "type": "stream.chunk", "stream_id": "…", "sequence": 0, "bytes_b64": "…" }
{ "version": 1, "type": "stream.ack", "stream_id": "…", "sequence": 1 }
{ "version": 1, "type": "stream.end", "stream_id": "…", "length": 123, "sha256": "<64 hex>" }
```

Control frames are at most 16 KiB; chunks decode to at most 8 KiB; length and SHA-256 must match or the stream fails with `integrity_mismatch` (`web/src/lib/hostControl.ts:7-22`, `web/src/lib/hostControl.ts:1289-1354`). Mutations whose acknowledgement is lost (`fs.mkdir`, `fs.rename`, `fs.remove`, `desktop.reveal`, `desktop.open`) are indeterminate and must not be silently retried because the action may have occurred (`web/src/lib/hostControl.ts:23-42`).

### Direct session `spawn.ctl` operation family

Terminal history, ownership, resize, and terminal-scoped upload use `spawn.ctl`, not the separate host-wide `spawn.host.ctl` family above. The operation set and fixed bounds are (`web/src/lib/session-ctl.ts:1-28`):

```ts
export const SESSION_CTL_VERSION = 1;
export const SESSION_CTL_MAX_REQUEST_BYTES = 16 * 1024;
export const SESSION_CTL_MAX_REPLAY_BYTES = 12 * 1024 * 1024;
export const SESSION_CTL_CHUNK_PAYLOAD_BYTES = 48 * 1024;
export const SESSION_CTL_MAX_OUTSTANDING_REQUESTS = 128;
export const SESSION_CTL_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const SESSION_CTL_UPLOAD_CHUNK_BYTES = 48 * 1024;

type SessionCtlOperation =
  | "history" | "snapshot" | "resize" | "scroll" | "redraw"
  | "take_control" | "upload_start" | "upload_cancel"
  | "upload_complete" | "history_subscribe";
```

| Operation/frame | Exact meaningful parameters/effect | Capability |
|---|---|---|
| `history` | initial `{lines:400,plain:false,cols?,rows?}` replay before ready | F-052/F-064 |
| `snapshot` | `{lines,plain:false}` bounded replay/park synchronization | F-052/F-064 |
| `resize` | `{cols,rows}`; only display owner may resize | F-054/F-056 |
| `scroll` | `{lines}` non-zero delta clamped by protocol | F-054 |
| `redraw` | no additional parameters | F-054/F-057 |
| `take_control` | `{cols,rows}` transfers display ownership | F-056 |
| `history_subscribe` | no parameters; enables committed `history_delta`/`history_wipe`/`history_gap` events when supported | F-052/F-064 |
| `upload_start` + binary kind-2 chunks | capability/generation-bound attachment or cwd upload | F-059/F-060 |
| `upload_cancel` | `{capability,agent_generation,upload_id}`; internal abort/teardown path, not a visible Cancel button | F-059/F-060 |

The upload metadata and result fields are exact (`web/src/lib/session-ctl.ts:118-135`, `web/src/lib/session-ctl.ts:368-427`):

```jsonc
// Ready event advertises the only accepted capability/generation and fixed limits.
{"version":1,"kind":"event","event":"ready","upload_capability":"<UUID>","agent_generation":7,"upload_max_bytes":20971520,"upload_chunk_bytes":49152}

// Start request; destination is exactly "cwd" or "attachments".
{"version":1,"kind":"request","request_id":"<upload UUID>","operation":"upload_start","capability":"<ready UUID>","agent_generation":7,"name":"notes.txt","mime_type":"text/plain","destination":"cwd","total_bytes":90000,"chunks":2,"sha256":"<64 lowercase hex>"}

// Resume/ready acknowledgement, then terminal completion.
{"version":1,"kind":"response","request_id":"<upload UUID>","operation":"upload_start","ok":true,"state":"ready","next_sequence":1,"received_bytes":49152}
{"version":1,"kind":"response","request_id":"<upload UUID>","operation":"upload_complete","ok":true,"state":"complete","path":"/endpoint/path/notes.txt","total_bytes":90000,"sha256":"<same digest>"}
```

Upload binary chunks use the 28-byte `SPCT` header with `kind=2`, stable upload UUID, `u32LE` sequence, and final-bit flag; payload is at most 48 KiB (`web/src/lib/session-ctl.ts:430-468`, `proto/README.md:892-910`). The browser may retry only the pre-effect `upload_start` exchange with the same UUID. It never automatically retries after final-chunk dispatch; lost acknowledgement becomes `outcome_unknown` and requires the visible F-059 reconciliation flow (`web/src/components/terminal/useSessionSocket.ts:594-735`, `proto/README.md:913-963`).

## Keyboard, pointer, touch, and existing gesture matrix

| Surface | Input | Exact web behavior | Mobile parity decision |
|---|---|---|---|
| Terminal | arbitrary key/input | raw PTY bytes; terminal owns shortcuts | Preserve with hidden/native text input and hardware keyboard |
| Terminal | `Shift+Enter` | alternate/newline return path | Preserve |
| Terminal | selection | fine-pointer selection auto-copies | Explicit Copy on touch; retain hardware/mouse behavior on iPad |
| Modifier row | buttons | Paste, Esc, Tab, Shift-Tab, Ctrl-C, arrows, Send | Persistent keyboard accessory |
| File tree | Up/Down | previous/next visible row | Preserve for hardware keyboard |
| File tree | Right/Left | expand/enter; collapse/parent | Preserve; touch disclosure/back |
| File tree | Enter/Space | open; pin preview | Enter open; Space Quick Look when hardware keyboard |
| File tree | `F2`/Delete | rename/delete request | Preserve; touch overflow |
| Folder picker | Up/Down | adjacent sibling | Preserve |
| Folder picker | Right | enter first child | Preserve; touch row push |
| Folder picker | Left/Backspace | parent | Preserve; native back |
| Folder picker | Enter | commit selection | Preserve |
| Folder picker | Escape | clear filter, then close | Preserve; native close/back mirrors stages |
| Inline rename | Enter/Escape/blur | commit/cancel/commit | Native Return/Cancel/blur |
| Tab strip | `Alt+Shift+Left/Right` | reorder tab | Preserve on hardware keyboard; touch reorder mode |
| Grid | `Alt+1…9` | navigate workspace N | Optional hardware shortcut only |
| Grid | `Alt+Arrow` | directional pane focus | Phone list/pager replaces; useful only on tablet |
| Grid | Escape | cancel active drag/layout gesture | Native Cancel/back |
| Grid/tab | drag | move; modifier-drag duplicates; cross-tab dwell | Action sheets/reorder mode; tablet may restore pointer drag |
| Context menu | right click | open at pointer coordinate | Long press or overflow |
| Dropdown/cascade | Up/Down/Escape | roving focus/dismiss | Native accessibility focus and back/dismiss |
| Drawer | horizontal swipe left >70 px | dismiss | Not primary IA; edge-swipe back in stacks |
| Bottom sheet | drag down >90 px | dismiss | Interactive native sheet dismissal |
| Terminal scroll | vertical pan | scroll buffer; edge/alternate-buffer handoff | Preserve; terminal overlay dismissal starts only from header |

Evidence: `web/src/components/terminal/Terminal.tsx:1746-2181`, `web/src/components/terminal/ModifierBar.tsx:14-186`, `web/src/components/files/FileExplorer.tsx:805-847`, `web/src/components/workspace/folder-picker.tsx:442-702`, `web/src/components/workspace/workspace-tabs.tsx:420-558`, `web/src/components/workspace/workspace-grid.tsx:1559-1894`, `web/src/components/ui/sheet.tsx:14-149`, `web/src/components/ui/drawer.tsx:15-178`.

## Conditional features, feature flags, and environment/capability gates

No `process.env` or `NEXT_PUBLIC_*` feature switch was found inside the inspected `web/src/app/` and `web/src/components/` tree. Supporting `web/src/lib/` code does have two deployment URL overrides and a production-only service-worker gate; these configure transport/PWA behavior rather than exposing optional product features. Other conditional UI is driven by auth config, mail status, daemon capabilities, local preferences, and runtime browser checks.

| Gate/preference | Exact condition | UI consequence | Evidence |
|---|---|---|---|
| REST base URL | `NEXT_PUBLIC_SPAWN_API_URL ?? ""` | Empty uses same-origin `/api/*`; non-empty targets the configured FastAPI origin, always with included cookies | `web/src/lib/api.ts:5-16`, `web/src/lib/api.ts:30-54` |
| Signaling base URL | `NEXT_PUBLIC_SPAWN_WS_URL ?? ""` | Empty derives `ws:`/`wss:` from the current origin; non-empty supplies `/ws/browser` and `/ws/host` base | `web/src/lib/ws.ts:1-39` |
| PWA service worker | `NODE_ENV==="production" && "serviceWorker" in navigator` | Registers `/sw.js` after load; absent in development/unsupported browsers and has no native-screen equivalent | `web/src/lib/query.tsx:27-43` |
| OAuth providers | `AuthConfig.providers: {id:"google"|"microsoft"|"github",name}[]` | Only configured provider buttons render | `web/src/lib/api.ts:428-441`, `web/src/components/onboarding/oauth-buttons.tsx:5-42` |
| Email verification | `email_verification_required` and `email_verified_at===null` | Verify step/redirect/resend surfaces | `web/src/components/onboarding/step-machine.ts:7-25`, `web/src/app/app/page.tsx:58-84` |
| Invite-only | `AuthConfig.invite_only` | Invite field/copy in signup | `web/src/components/onboarding/signup-form.tsx:53-98` |
| Admin | `user.is_admin` | Admin settings row and `/admin`; non-admin sees Not found | `web/src/components/settings/SettingsDialog.tsx:91-103`, `web/src/app/admin/layout.tsx:24-54` |
| Host online | `host.status==="online"` | Creation/install/direct-control enabled; offline state otherwise | `web/src/lib/api.ts:79-105`, `web/src/components/hosts/HostAgentsPanel.tsx:18-31` |
| Old/no telemetry daemon | capacity fields null; comment cites `SPAWND_NO_TELEMETRY` | Coarse meter omitted, not rendered as zero | `web/src/lib/api.ts:91-104` |
| SMTP delivery | admin mail status reports delivering; screen names `SPAWN_SMTP_HOST` when off | Mail is recorded but not sent; admin status explains configuration | `web/src/app/admin/page.tsx:72-99` |
| Direct operation support | advertised daemon capability + trust/channel ready | stat/range/preview/open/reveal/transfer actions enabled/visible | `web/src/lib/preview/capabilities.ts:1-68`, `web/src/components/files/FileExplorer.tsx:176-191` |
| Fine pointer and desktop width | `(min-width:768px)` and `(pointer:fine)` | Canvas grid dragging/resizing and hover affordances | `web/src/components/workspace/workspace-grid.tsx:350-463` |
| Hover preview | `(hover:hover) and (pointer:fine)` | Legion/file hover previews only | `web/src/components/legion/LegionStrip.tsx:83-101`, `web/src/components/files/FileExplorer.tsx:198-215` |
| Coarse pointer | `(pointer:coarse)` | terminal touch-input path/modifier presentation | `web/src/components/terminal/Terminal.tsx:1432-1445` |
| Narrow cascade | `(max-width:767px)` | cascade becomes bottom sheet | `web/src/components/ui/cascade-menu.tsx:185-205` |
| Reduced motion | `prefers-reduced-motion: reduce` | landing scroll transforms avoided; global animation reductions | `web/src/app/page.tsx:20-41`, `web/src/app/globals.css:1-752` |
| Platform detection | macOS/Linux/Windows/unknown | download/connect install copy changes | `web/src/app/download/page.tsx:19-106`, `web/src/components/hosts/connect-host.tsx:63-169` |
| Notification channels | browser/system permission/audio/vibration/PWA availability | toggle enabled, disabled with explanatory copy, or permission prompt | `web/src/components/settings/NotificationsPanel.tsx:26-235` |
| Passkey PRF | WebAuthn/platform and PRF result support | trust setup/unlock available or unsupported state | `web/src/components/settings/TrustPanel.tsx:27-272` |
| Host file open | capability plus `open_allowed` | Open on host action available | `web/src/lib/hostControl.ts:101-139`, `web/src/lib/preview/capabilities.ts:1-68` |
| Sidebar persistence | `spawn.sidebar.width`, `spawn.sidebar.collapsed` | restore width/collapse | `web/src/components/nav/AppShell.tsx:91-114` |
| Last workspace/tab | `spawn.workspaces.last`, per-workspace tab key | resume last context | `web/src/app/app/page.tsx:88-92`, `web/src/app/w/[id]/page.tsx:102-119` |
| Onboarding skip | `spawn.onboarding.skippedHost` | host step considered completed | `web/src/components/onboarding/onboarding-flow.tsx:62-82`, `web/src/components/onboarding/onboarding-flow.tsx:158-158` |
| Archived disclosure | local open/last-opened keys | restore rail disclosure/pinned archived row | `web/src/components/nav/SidebarArchivedSection.tsx:105-139` |
| Legion disclosure | persisted open key | restore strip expanded state | `web/src/components/legion/LegionStrip.tsx:51-128` |
| Folder hidden files | persisted Show hidden key | include/exclude dot entries | `web/src/components/workspace/folder-picker.tsx:107-116` |
| Predictive echo | `localStorage.spawnPredictEcho==="on"` | enable opt-in prediction | `web/src/components/terminal/Terminal.tsx:2736-2755` |
| Latency HUD | `localStorage.spawnLatencyHud==="on"` | show diagnostic HUD | `web/src/components/terminal/latency-hud.ts:1-30` |
| Renderer override | `localStorage.spawnRenderer` `gpu`/other | force GPU or fallback renderer | `web/src/components/terminal/Terminal.tsx:3707-3721` |
| Forced relay diagnostic | `window.__spawnRtcForceRelay===true` | sets ICE policy to `relay` for acceptance/debugging | `web/src/components/terminal/useSessionSocket.ts:427-435` |
| Upload reconciliation | per-session records in `sessionStorage`, memory and history-state fallback; maximum eight | unresolved reserved/unknown uploads block unsafe repetition until reconciled/dismissed | `web/src/components/terminal/Terminal.tsx:3420-3518` |

**RECOMMEND:** Represent all server/host/runtime gates as typed derived selectors in the centralized mobile data layer (`canOpenOnHost`, `canTransfer`, `needsVerification`, `canAdmin`, `notificationSupport`, `trustState`) so every screen renders identical availability and explanatory copy.

## Proposed native information architecture

### Product/interaction brief

The mobile app is an operational remote-control tool, not a dashboard and not a miniature desktop. The most frequent loop is: recognize workspace → select named tab → recognize terminal by icon/name/status → open terminal → type/scroll/use shortcut → dismiss back to the exact tab/list position. Fleet, files, trust, and configuration stay one or two predictable taps away but must not compete with that loop.

**RECOMMEND:** Use a tab-bar-first authenticated shell with four roots:

1. **Workspaces** — active workspace list; selected workspace pushes Workspace Detail.
2. **Hosts** — host list, Fleet/Legion entry, pairing, and host details.
3. **Files** — host file browsers plus current workspace/session file entry points. The web has no standalone recent-files model, so this root must initially show hosts and existing file-widget/session contexts, not invent recents/favorites.
4. **Settings** — account/profile, appearance, notifications, agents, skills, templates, devices/trust, archived workspaces, Admin when eligible, and About links.

Why tab-bar-first: Workspaces, Hosts, Files, and Settings are stable peer destinations used at unrelated moments; a single stack would make terminal dismissal/back history unpredictable. The terminal itself is deliberately not a root because it belongs to a workspace tab/session and must return to that context. This structure is a mobile projection of existing web entry points (`web/src/components/nav/Sidebar.tsx:332-621`, `web/src/components/settings/SettingsDialog.tsx:37-120`, `web/src/app/hosts/[id]/files/page.tsx:27-73`).

Unauthenticated launch uses a separate auth/onboarding stack: Welcome/Login/Signup → Verify → Connect Host → First Workspace. The operational tab bar mounts only after authenticated routing resolves (`web/src/app/app/page.tsx:17-214`, `web/src/components/onboarding/step-machine.ts:1-35`).

### Concrete workspace → tabs → terminals hierarchy

```text
Workspaces root
└── Workspace Detail (pushed)
    ├── header: icon, name, add, workspace menu
    ├── horizontal named-tab strip + synchronized pager
    │   ├── Tab A page
    │   │   ├── Terminal child row(s)
    │   │   └── Files child row(s)
    │   ├── Tab B page
    │   └── …
    ├── Add Child sheet (Shell / Agent / Files)
    ├── Child Actions sheet
    ├── Tab Actions sheet
    ├── Folder/host picker modal stack
    └── Terminal Overlay (full screen)
        ├── live terminal canvas
        ├── ownership/connection/upload overlays
        ├── keyboard modifier accessory
        └── Files Overlay (full screen above terminal)
```

The terminal row uses existing facts only:

- leading `AgentIcon` resolved from agent kind/foreground command, falling back to shell/monogram (`web/src/components/icons/AgentIcon.tsx:1-177`);
- primary name from `session.name`, recognizable agent name, or shell fallback;
- secondary line `host_name · cwd`;
- status dot and label from `activity_state`/`activity_label` (`web/src/lib/api.ts:234-256`, `web/src/components/ui/status.tsx:53-63`);
- trailing contextual overflow. A file child uses the file icon, path, host status, and its own overflow (`web/src/components/workspace/widget-pane.tsx:28-194`).

The selected tab page must preserve list position when the user opens/dismisses a terminal. Horizontal swipes only change workspace tabs when the gesture begins outside an interactive child horizontal control. A terminal never lives inside this pager; it is above it as an overlay, preventing terminal horizontal input/selection from accidentally changing tabs.

### Presentation and gesture rules

**RECOMMEND:** Follow this presentation hierarchy consistently:

- **Root tab** for Workspaces, Hosts, Files, Settings.
- **Push** for stable hierarchical information (Workspace Detail, Host Detail, settings subsections, folder drill-down, Admin subsections). System edge-swipe goes back.
- **Full-screen modal overlay** for immersive, interruptible tools that must return to exact context (Terminal, File Viewer, terminal Files). Drag down only from the header/handle; content pans remain content gestures.
- **Medium/large sheet** for bounded choices/actions (Add Child, child/tab/workspace actions, host choice, agent choice, confirmation, quick preview). Drag down anywhere not occupied by a scroll view; tap scrim dismisses when no destructive work is in flight.
- **Full-height modal stack** for multi-step pickers/creation (folder picker, new workspace, connect host outside onboarding, workspace icon). It has Cancel and can edge-swipe/back within its internal stack; drag-down at the root dismisses.

Settings is a root, not a swipe-dismissable overlay, because it is a stable destination with deep stacks and destructive trust/account operations. When a contextual “Open device settings” action is invoked over Terminal/Onboarding, switch to the Settings tab and push the appropriate section, preserving the source route in navigation state so Back returns there; do not layer a second Settings instance (`web/src/components/auth/BrowserDeviceRegistrationStatus.tsx:14-48`).

| Surface/action | Gesture | Haptic at semantic boundary | Conflict rule |
|---|---|---|---|
| Root tabs | tap | selection | No haptic when re-tapping current root unless it pops to root |
| Workspace tab pager | horizontal pan/tap | selection when page settles to a new tab | Disabled while terminal overlay is open; vertical intent locks list scroll |
| Reorder workspace/tab/child | long press then drag | light impact on pickup; selection per crossed slot; medium impact on drop | Screen-edge zone reserved for back; terminal rows do not open while dragging |
| Open terminal | tap row | light impact after overlay begins | Debounce double open; warm terminal may attach immediately |
| Dismiss terminal | drag header down or close | light impact at dismiss threshold | Vertical pan starting in terminal content always scrolls terminal |
| Stack back | iOS edge swipe/back | none | Unsaved form gets confirmation before pop |
| Open action/add sheet | tap/long press | light impact | Long press must still expose VoiceOver custom actions |
| Sheet detent/dismiss | vertical drag | selection at detent; light at dismiss threshold | Scroll view consumes pan until top |
| Folder/path selection | tap row/Choose | selection on drill; medium impact on final choose | No impact for every scrolled row |
| Toggle | tap | selection | Suppress if disabled/unsupported |
| Start/restart/create succeeds | action | success notification | Only after authoritative success |
| Pair/endorse succeeds | action | success notification | Mismatch uses error notification and remains blocked |
| Destructive confirmation | confirm | warning impact when sheet opens; medium impact after confirmed mutation | Never haptic merely for focusing destructive row |
| Error requiring attention | response | error notification | Coalesce repeated polling errors like toasts |
| Terminal keystroke | typing | **none** | Per-key haptics would be noisy and slow remote input |
| Modifier key | tap | light impact for Ctrl-C/Esc/Tab; selection for arrows | Preserve keyboard focus |

Haptics are proposed because the owner explicitly requires them; no web haptic exists for these navigation actions. Respect system Reduce Motion/accessibility settings. The existing notification preference already distinguishes notification vibration as optional and capability-dependent; it should govern notification events, not silently become a newly invented global navigation-haptics setting (`web/src/components/settings/NotificationsPanel.tsx:89-95`, `web/src/components/settings/NotificationsPanel.tsx:185-226`).

### Screen inventory

Routes are proposed React Navigation/Expo Router semantics, not existing web URL changes. `/(auth)` and `/(tabs)` denote separate navigation groups; `[id]` is an opaque UUID.

| Screen | Proposed route | Data required | Presentation | Gestures |
|---|---|---|---|---|
| Launch resolver | `/` | auth user/config, hosts, workspaces, local last context | transient stack screen | none |
| Welcome/Login | `/(auth)/login` | auth config/providers | auth stack root | native back only when externally entered |
| Signup | `/(auth)/signup` | auth config, invite context | pushed auth screen | edge-swipe back |
| Forgot password | `/(auth)/forgot-password` | none until submit | pushed auth screen | edge-swipe back |
| Reset password | `/(auth)/reset-password?token=` | token | pushed/deep-link auth screen | controlled back |
| Verify email | `/(auth)/verify-email?token=` | user/config/hosts | auth/onboarding stack | controlled back; refresh/poll |
| Onboarding | `/(auth)/onboarding/[step]` | user/config, hosts/workspaces | onboarding stack | edge-swipe only to allowed prior step |
| Connect Host | `/(auth)/onboarding/host` or `/hosts/connect` | platforms, pending pairing, local identity, hosts | onboarding push; contextual full-height modal | edge-swipe/back; modal drag-down at root |
| Workspaces | `/(tabs)/workspaces` | active workspaces, sessions/attention summary | tab root list | pull refresh; long-press reorder/actions |
| Archived workspaces | `/(tabs)/settings/archived` | archived workspaces | pushed list | edge-swipe; swipe row actions optional but destructive confirm required |
| New Workspace | `/modals/new-workspace` | hosts, templates, direct folder data | full-height modal stack | drag-down root; edge-swipe internal picker |
| Workspace Detail | `/(tabs)/workspaces/[workspaceId]` | workspace, sessions, agents/status/focus | pushed screen | edge-swipe back; horizontal tab pager; long-press reorder |
| Add Child | `/sheets/add-child` | current tab/home, hosts, agents, capacity | action/cascade sheet | drag-down; selection taps |
| Tab Actions | `/sheets/tab-actions` | tab, sessions, hosts, capacity | action sheet | drag-down |
| Child Actions | `/sheets/child-actions` | tile/session/widget, hosts/tabs | action sheet | long press/open; drag-down |
| Workspace Actions | `/sheets/workspace-actions` | workspace, hosts | action sheet | drag-down |
| Folder Picker | `/modals/folder-picker/[hostId]` | hosts and direct `fs.home/list` | full-height modal drill-down | edge-swipe parent; drag-down root |
| Workspace Icon | `/modals/workspace-icon/[workspaceId]` | workspace, host suggestion/read | full-height modal | drag-down |
| Terminal | `/overlays/terminal/[sessionId]` | session, host, transport/trust, warm handle | full-screen modal overlay | drag header down; close; terminal vertical pan |
| Terminal Files | `/overlays/terminal/[sessionId]/files` | host/session cwd, host control | full-screen overlay above terminal | drag header down; edge/back |
| File Viewer | `/overlays/file-viewer` | host/path/stat/preview/siblings | full-screen modal overlay | drag header down; horizontal previous/next only from viewer chrome |
| Hosts | `/(tabs)/hosts` | hosts, session/capacity summaries | tab root list | pull refresh; row tap; long-press actions |
| Fleet Overview | `/(tabs)/hosts/fleet` | hosts, sessions, optional exact metrics | pushed screen | edge-swipe back; pull refresh |
| Host Detail | `/(tabs)/hosts/[hostId]` | host, sessions, agents | pushed screen | edge-swipe back; pull refresh |
| Host Agents | `/(tabs)/hosts/[hostId]/agents` | host agent availability/policy | pushed list | edge-swipe back |
| Host Files | `/(tabs)/hosts/[hostId]/files` | host + direct filesystem | pushed screen | edge-swipe back; directory drill/touch scrolling |
| Files root | `/(tabs)/files` | hosts, session/workspace file entry points | tab root list | pull refresh; select host/context |
| Files browser | `/(tabs)/files/[hostId]` | direct home/tree/path | pushed screen | edge-swipe; directory drill; long-press row |
| Settings | `/(tabs)/settings` | user, derived health/admin gates | tab root list | standard vertical scroll |
| Profile | `/(tabs)/settings/profile` | profile | pushed screen | edge-swipe; Copy stats remains a visible control |
| Account | `/(tabs)/settings/account` | user/verification | pushed form | edge-swipe; delete confirmation sheet |
| Appearance | `/(tabs)/settings/appearance` | theme/system setting | pushed screen | edge-swipe; selection controls |
| Notifications | `/(tabs)/settings/notifications` | prefs/support/alert stream | pushed screen | edge-swipe; toggles |
| Agents | `/(tabs)/settings/agents` | agent definitions | pushed list | edge-swipe; row actions |
| Agent Editor | `/(tabs)/settings/agents/[id]` | selected/new definition | pushed form | edge-swipe with unsaved guard |
| Skills | `/(tabs)/settings/skills` | skills | pushed list | edge-swipe; row actions |
| Skill Editor | `/(tabs)/settings/skills/[id]` | selected/new skill | pushed form | edge-swipe with unsaved guard |
| Templates | `/(tabs)/settings/templates` | workspace templates | pushed list | edge-swipe; row actions |
| Devices | `/(tabs)/settings/devices` | local identity, browser devices, trust bundle | pushed screen | edge-swipe; destructive sheets |
| Device Trust | `/(tabs)/settings/trust` | passkeys, sealed bundle, local trust state | pushed flow | edge-swipe only when operation safe; platform prompts |
| Device endorsement | `/(tabs)/settings/devices/endorse/[id]` | candidate, host pins/keys | pushed verification | controlled back; explicit approve |
| Introduction | `/(tabs)/settings/devices/introduction/[id]` | endorsements, polling state | pushed verification | controlled back |
| Admin root | `/(tabs)/settings/admin` | user admin flag | pushed menu | edge-swipe |
| Admin Invites | `/(tabs)/settings/admin/invites` | invites | pushed list/form | edge-swipe; copy/share; revoke sheet |
| Admin Users | `/(tabs)/settings/admin/users` | admin users | pushed list/cards | edge-swipe |
| Admin Emails | `/(tabs)/settings/admin/emails` | mail status/email log | pushed list | edge-swipe; disclosure rows |
| About/Security/Download | `/(tabs)/settings/about` | static links/content | pushed native summary + browser links | edge-swipe |

Screen data sources are the schemas/calls in `web/src/lib/api.ts:70-106`, `web/src/lib/api.ts:234-469`, and `web/src/lib/api.ts:473-1036`; direct Files/Fleet operations are `web/src/lib/hostControl.ts:7-164` and `web/src/lib/hostControl.ts:421-984`.

### Where desktop-heavy and long-tail surfaces live

| Existing web surface | Phone location | Mobile adaptation |
|---|---|---|
| 24×24 multi-pane canvas | Workspace Detail child list/actions | Retain data; reorder/move/split presets; no tiny simultaneous terminals |
| Pointer resize/dividers/dock previews | Child Actions → Layout | Discrete, reversible commands; explain full freeform layout is best on desktop |
| Sidebar archived disclosure | Settings → Archived Workspaces | Full searchable list |
| Legion strip/hover card | Hosts → Fleet Overview/Host Detail | Explicit navigation, no hover |
| Settings modal section rail | Settings root stack | One row per section, system back |
| Profile dialog | Settings → Profile | Pushed screen retaining Copy stats |
| Admin table sections | Settings → Admin | Card/list rows retaining every field |
| File hover preview | long press Quick Look / tap viewer | Sheet/full viewer |
| Right-click/kebab cascades | long press/overflow action sheet | Sheet, nested choice screens only when needed |
| Session files side-by-side | Terminal toolbar → Files overlay | Full screen above terminal; swipe dismiss |
| Public landing motion | Settings → About external links | No operational-shell replica; preserve access/content |

This is not a permission to omit desktop-only-by-nature actions: it replaces the interaction while keeping the model mutation and recovery state (`web/src/components/workspace/workspace-grid.tsx:537-1220`, `web/src/components/files/FileExplorer.tsx:891-960`).

## Visual-language contract for these native screens

The actual CSS is the pixel/color source of truth. Use one centralized native token module generated/copied from the CSS values and shared by every component; do not translate token names ad hoc in screens.

```ts
// web/src/app/globals.css:272-410 — representative exact values
const light = {
  background: "oklch(0.985 0 0)", foreground: "oklch(0.17 0 0)",
  muted: "oklch(0.955 0 0)", mutedForeground: "oklch(0.47 0 0)",
  card: "oklch(1 0 0)", popover: "oklch(1 0 0)",
  primary: "oklch(0.2 0 0)", secondary: "oklch(0.95 0 0)",
  accent: "oklch(0.93 0 0)", border: "oklch(0.9 0 0)",
  brandAccent: "#e11e15", shell: "oklch(0.945 0 0)",
};
const dark = {
  background: "oklch(0.10 0 0)", foreground: "oklch(0.97 0 0)",
  muted: "oklch(0.21 0 0)", mutedForeground: "oklch(0.71 0 0)",
  card: "oklch(0.16 0 0)", popover: "oklch(0.235 0 0)",
  primary: "oklch(0.97 0 0)", secondary: "oklch(0.24 0 0)",
  accent: "oklch(0.27 0 0)", border: "oklch(0.27 0 0)",
  brandAccent: "#ff453a", shell: "oklch(0.2 0 0)",
};
```

- Surfaces are neutral; chroma is reserved for brand and semantic status. Focus ring is neutral foreground, never brand red (`web/src/app/globals.css:272-327`, `web/src/app/globals.css:356-404`).
- Status light/dark values are exactly those in `web/src/app/globals.css:291-314` and `web/src/app/globals.css:379-396`; code colors are separate from statuses.
- Radii are 6/8/10 px at a 16 px rem (`0.375/0.5/0.625rem`); chrome motion uses `cubic-bezier(0.32,0.72,0,1)` and 150 ms for short moves (`web/src/app/globals.css:89-92`, `docs/DESIGN.md:152-160`). Use native springs tuned to settle in roughly that interval for interactive gestures, not arbitrary bouncy presets.
- Current CSS row rhythm is **40 px** (`--row-h:2.5rem`), pane/list gutter 6 px, desktop content inset 8 px, while touch targets must reach at least 44 px through padding/hit slop (`web/src/app/globals.css:334-345`, `docs/DESIGN.md:241-254`).
- App type uses the system sans stack; terminal uses 13 px mono at line-height 1.2 (`web/src/app/globals.css:425-432`, `web/src/components/terminal/xterm-config.mjs:17-26`).
- All generic actions use the same thin-stroke icon family at 16 px within ≥28 px desktop hit areas; mobile raises actionable targets to ≥44 px. Agent, file and brand icons retain custom mappings (`docs/DESIGN.md:223-239`).

**UNKNOWN / SOURCE CONFLICT:** `docs/DESIGN.md:74-80` describes app brand accent `#ff4930`, shell dark `oklch(0.205 0 0)`, and `docs/DESIGN.md:135-143` describes a 36 px row. Current executable CSS instead uses light `#e11e15`, dark `#ff453a`, shell dark `oklch(0.2 0 0)`, and a 40 px row (`web/src/app/globals.css:318-340`, `web/src/app/globals.css:400-404`). Separately, `web/src/lib/api.ts:318-337` has a stale “12×12” comment even though grid schema v3 is explicitly 24×24 and constants enforce 4×4 minimum/16 maximum (`web/src/lib/grid.ts:1-33`, `proto/layout-v3-fixtures.json:1-2`). **RECOMMEND:** Match current CSS and executable grid constants/fixtures, then correct stale documentation separately; implementation agents must not average or substitute these values.

### Expo Go feasibility boundary

The navigation and haptic IA can be implemented with Expo-managed APIs, but two core parity paths depend on capabilities that must be validated rather than assumed:

1. Authenticated WebRTC DataChannels for both PTY and host-control, including binary frames, two mandatory channels, reconnect, and buffer/backpressure behavior (`web/src/components/terminal/useSessionSocket.ts:410-443`, `web/src/lib/hostControl.ts:7-22`).
2. Ed25519 device identity plus passkey WebAuthn PRF and local encrypted trust material (`web/src/lib/api.ts:398-469`, `web/src/components/settings/TrustPanel.tsx:27-272`).

**UNKNOWN:** Whether the Expo Go binary current on the target physical iPhone exposes enough WebRTC and PRF functionality. This report intentionally does not invent a verified package/version; that belongs to the platform/library research pass.

**RECOMMEND:** Make the first technical milestone a physical-iPhone Expo Go spike that (a) opens authenticated signaling, (b) creates required `pty` and `ctl` DataChannels, (c) round-trips binary data and backpressure, (d) survives background/foreground and keyboard resize, and (e) proves device-key/passkey recovery. This is a go/no-go gate, not deferred polish.

If native DataChannels are unavailable in Expo Go, the only behavioral fallback likely to work inside Expo Go is a transport-only WebView running the proven browser WebRTC/xterm stack inside the native full-screen terminal/files overlay. It preserves connection behavior and native outer navigation/dismissal, but it conflicts with “genuinely native/not a web wrapper.” If WKWebView DataChannels are also unavailable, opening the existing terminal in Safari is the last Expo Go-compatible access fallback and does not meet the overlay requirement. The orchestrator/product owner must then choose between relaxing Expo Go to an EAS development build/custom client or relaxing the no-wrapper requirement; IA cannot reconcile both constraints by itself.

## Key-screen ASCII wireframes

These sketches specify hierarchy and interaction zones, not a new visual style. All rows use the neutral token surfaces, custom identity icons, semantic status dots, 44 px minimum touch targets, safe areas, and native typography described above.

### 1. Login

```text
┌──────────────────────────────────────┐
│ safe area                            │
│                                      │
│           [spawn mark]               │
│      your machines, from anywhere    │
│                                      │
│  ┌────────────────────────────────┐  │
│  │ Continue with GitHub           │  │ configured
│  └────────────────────────────────┘  │ providers only
│  ─────────────── or ───────────────  │
│  Email                               │
│  ┌────────────────────────────────┐  │
│  │ name@example.com               │  │
│  └────────────────────────────────┘  │
│  Password                         ◉  │
│  ┌────────────────────────────────┐  │
│  │ ••••••••••••                   │  │
│  └────────────────────────────────┘  │
│  Forgot password?                    │
│  ┌────────────────────────────────┐  │
│  │             Log in             │  │
│  └────────────────────────────────┘  │
│       New here? Create account       │
│                                      │
└──────────────────────────────────────┘
```

Return submits. Busy disables duplicate submission; errors sit with the form and remain readable. OAuth rows are absent rather than disabled when no providers are configured (`web/src/app/login/page.tsx:15-109`, `web/src/components/onboarding/oauth-buttons.tsx:5-42`).

### 2. Onboarding / connect host

```text
┌──────────────────────────────────────┐
│ ‹ Back       Set up spawn        2/3 │
│ ● Account ─ ● Verify ─ ○ Host        │
│                                      │
│  Connect your first machine          │
│  Run this on the Mac/Linux/PC you    │
│  want to control:                    │
│  ┌────────────────────────────────┐  │
│  │ curl … | sh              Copy  │  │
│  └────────────────────────────────┘  │
│                                      │
│  Pairing code                        │
│  ┌────────────────────────────────┐  │
│  │ ABCD-EFGH                      │  │
│  └────────────────────────────────┘  │
│  ┌────────────────────────────────┐  │
│  │            Continue            │  │
│  └────────────────────────────────┘  │
│                                      │
│  Review next:                        │
│  office-mac                          │
│  SHA256:AbCdEf…  [must match]        │
│                                      │
│            Skip for now              │
└──────────────────────────────────────┘
```

The review state replaces—not stacks below—the install state and requires explicit Approve. Verification and mismatch states never compress the fingerprint (`web/src/components/hosts/connect-host.tsx:63-448`, `web/src/components/onboarding/onboarding-flow.tsx:274-504`).

### 3. Workspace list

```text
┌──────────────────────────────────────┐
│ Workspaces                    ＋      │
│ ┌──────────────────────────────────┐ │
│ │ Search workspaces               │ │
│ └──────────────────────────────────┘ │
│                                      │
│ ▣  spawn mobile             3 active │
│    office-mac · ~/dev/spawn       ›  │
│                                      │
│ AC  client work              waiting │ amber dot
│    studio · ~/clients/acme         › │
│                                      │
│ LA  lab                       offline │
│    mini · ~/experiments            › │
│                                      │
│ ──────────────────────────────────── │
│ Fleet: 2 online · 1 offline          │
│                                      │
│  Workspaces   Hosts   Files  Settings│
└──────────────────────────────────────┘
```

Tap pushes detail; long press exposes Rename/Icon/Archive/Delete; long-press drag enters reorder. Pull refresh is permitted but periodic/query refresh remains authoritative (`web/src/components/nav/Sidebar.tsx:40-211`, `web/src/components/nav/SidebarWorkspaceRow.tsx:32-232`).

### 4. Workspace detail with tab pager and terminal list

```text
┌──────────────────────────────────────┐
│ ‹ Workspaces  ▣ spawn mobile   ＋  •••│
├──────────────────────────────────────┤
│  main       tests       server     ＋ │ ← scrollable tabs
│ ━━━━━                                │
├──────────────────────────────────────┤
│  main · office-mac · ~/dev/spawn     │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │ ◉ Codex  implement mobile       │ │
│ │ ● active · office-mac           │ │
│ │ ~/dev/spawn                  ••• │ │
│ └──────────────────────────────────┘ │
│ ┌──────────────────────────────────┐ │
│ │ > zsh                           │ │
│ │ ● quiet · office-mac            │ │
│ │ ~/dev/spawn/server          •••  │ │
│ └──────────────────────────────────┘ │
│ ┌──────────────────────────────────┐ │
│ │ ▤ Files                          │ │
│ │ office-mac · ~/dev/spawn    •••  │ │
│ └──────────────────────────────────┘ │
│                 (＋) Add             │
│                                      │
│  Workspaces   Hosts   Files  Settings│
└──────────────────────────────────────┘
        ← swipe page →
```

Horizontal page gesture changes named workspace tabs with a selection haptic on settle. Tap a terminal opens overlay; tap files opens browser; long press a row enters action/reorder. The owner-requested type/name/logo/status are present without inventing new terminal metadata (`web/src/lib/api.ts:234-278`, `web/src/components/workspace/workspace-tabs.tsx:420-558`, `web/src/components/workspace/session-pane.tsx:75-216`).

### 5. Terminal overlay

```text
┌──────────────────────────────────────┐
│             ━━━━━                    │ drag handle
│  ×  Codex · main       P2P 42ms  ••• │ fixed header
├──────────────────────────────────────┤
│ $ bun test                           │
│ ✓ 184 tests passed                   │
│                                      │
│ > implement the mobile navigation…   │
│                                      │
│ █                                    │ live canvas
│                                      │
│                                      │
│                         New output ↓ │ when scrolled
├──────────────────────────────────────┤
│ Paste Esc Tab ⇧Tab  ^C  ← ↑ ↓ → Send│ horizontal accessory
├──────────────────────────────────────┤
│        iOS keyboard / safe area      │
└──────────────────────────────────────┘
```

Drag-down starts only on header/handle; vertical terminal pans remain scrollback. Native terminal chrome contains Rename, Files, Upload (the touch replacement for desktop drop), Restart, Mute, connection diagnostics, and Close separated destructively. Take control appears in the ownership overlay rather than this menu. Connection/ownership/upload overlays stay inside the canvas without removing cached output (`web/src/components/terminal/Terminal.tsx:3056-3350`, `web/src/components/terminal/ModifierBar.tsx:14-186`, `web/src/components/terminal/ConnectionChip.tsx:13-221`).

### 6. Host list

```text
┌──────────────────────────────────────┐
│ Hosts                         ＋      │
│ ┌──────────────────────────────────┐ │
│ │ Fleet overview   2 online · 1 off│›│
│ └──────────────────────────────────┘ │
│                                      │
│ ● office-mac                         │
│   macOS · arm64 · <daemon version> › │
│   3 sessions                         │
│                                      │
│ ● studio-linux                       │
│   Linux · x86_64 · <daemon version> ›│
│   1 session                          │
│                                      │
│ ○ old-laptop                         │
│   Offline · last seen …           ›  │
│                                      │
│  Workspaces   Hosts   Files  Settings│
└──────────────────────────────────────┘
```

Tap host pushes detail; overflow/long press gives Rename/Remove; add opens pairing. The daemon-version field is populated from host data; the angle-bracket label is wireframe notation, not a guessed version (`web/src/lib/api.ts:79-105`, `web/src/components/settings/HostsPanel.tsx:23-219`).

### 7. Host detail

```text
┌──────────────────────────────────────┐
│ ‹ Hosts      office-mac         •••  │
│ ● Online · seen now                  │
│                                      │
│  macOS · arm64                       │
│  daemon <version> · 3 live sessions  │
│  Last seen <timestamp>               │
│                                      │
│  Files                              ›│
│  Agents · installed/update status  ›│
│                                      │
│  Sessions                            │
│  ● Codex · ~/dev/spawn             ›│
│  ● zsh · ~/dev/spawn/server        ›│
│                                      │
│  Identity                            │
│  Ed25519                             │
│  SHA256:AbCdEf…            [Copy]    │
└──────────────────────────────────────┘
```

Overflow holds Rename and destructive Remove. Offline retains facts/sessions while direct Files and Host Agents explain their unavailable state; exact CPU/memory metrics remain in Fleet Overview rather than being invented on Host Detail (`web/src/app/hosts/[id]/page.tsx:59-430`, `web/src/components/hosts/HostAgentsPanel.tsx:18-199`).

### 8. Settings root

```text
┌──────────────────────────────────────┐
│ Settings                             │
│ ┌──────────────────────────────────┐ │
│ │ CS  user@example.com            ›│ │ Profile
│ └──────────────────────────────────┘ │
│                                      │
│ Account                            › │
│ Appearance                 System  › │
│ Notifications                  ⚠   › │
│                                      │
│ Agents                             › │
│ Skills                             › │
│ Templates                          › │
│ Archived workspaces                › │
│                                      │
│ Devices                            › │
│ Device trust                  Locked ›│
│ Hosts                              ↗ │
│ Admin                         [admin]│ conditional
│ About & security                   › │
│                                      │
│  Workspaces   Hosts   Files  Settings│
└──────────────────────────────────────┘
```

The health glyph/badge must derive from actual registration/trust/notification state, not a decorative counter. Admin row is absent for non-admin users (`web/src/components/settings/SettingsDialog.tsx:37-120`, `web/src/components/auth/BrowserDeviceRegistrationStatus.tsx:8-50`).

### 9. Files

```text
┌──────────────────────────────────────┐
│ ‹ Files  office-mac · ~/dev     ＋ •••│
│  New folder · Upload · Refresh       │
│  Root: ~/dev                         │
│                                      │
│  ▾  spawn/                     12 Aug│
│     ▸ daemon/                  12 Aug│
│     ▸ docs/                    21 Aug│
│     ▸ mobile/                  22 Aug│
│     ▸ server/                  20 Aug│
│     ▸ web/                     22 Aug│
│     ◻ README.md          8 KB   21 Aug│
│     ◻ package.json       2 KB   18 Aug│
│                                      │
│ ┌──────────────────────────────────┐ │
│ │ ⟳ Uploading 2 file(s)...         │ │
│ └──────────────────────────────────┘ │
│  Workspaces   Hosts   Files  Settings│
└──────────────────────────────────────┘
```

Tap directory drills/expands according to current browser mode; tap file opens viewer; long press exposes the complete F-075 action set. Header actions expose New Folder, Upload, Refresh, and Collapse all. The current explorer has no filter/hidden-files control and its upload footer shows only a spinner and file count—no byte percentage, Cancel, or Retry (`web/src/components/files/FileExplorer.tsx:805-960`, `web/src/components/files/FileExplorer.tsx:969-1413`).

## Complete inspected-source coverage ledger

This ledger closes the “every file” requirement. “Primitive/support” files do not add a separate destination but define controls, states, visual semantics, or tested invariants already attached to F-001–F-121.

### `web/src/app/`

| Inspected source | Feature/screen contribution |
|---|---|
| `web/src/app/admin/layout.tsx:1-71` | F-105 admin auth/authorization shell |
| `web/src/app/admin/page.tsx:1-430` | F-106 invitations, F-107 users, F-108 email diagnostics |
| `web/src/app/app/page.tsx:1-223` | F-006 authenticated resolver and empty/offline bootstrap |
| `web/src/app/device/page.tsx:1-17` | F-013/F-082 standalone Connect Host entry |
| `web/src/app/download/page.tsx:1-286` | F-004 daemon acquisition/install |
| `web/src/app/forgot-password/page.tsx:1-81` | F-009 reset request |
| `web/src/app/globals.css:1-752` | F-001/F-093/F-112/F-114 visual, theme, viewport, reduced-motion system |
| `web/src/app/hosts/[id]/files/page.tsx:1-75` | F-067 Host Files entry |
| `web/src/app/hosts/[id]/page.tsx:1-447` | F-084–F-086 Host Detail/actions/sessions |
| `web/src/app/layout.tsx:1-80` | F-001 document/providers/viewport |
| `web/src/app/legion/page.tsx:1-143` | F-089 fleet overview |
| `web/src/app/login/page.tsx:1-109` | F-007 login |
| `web/src/app/onboarding/page.tsx:1-20` | F-012 onboarding route/shell |
| `web/src/app/page.tsx:1-582` | F-002/F-003 public landing/product motion |
| `web/src/app/reset-password/page.tsx:1-125` | F-010 password reset confirmation |
| `web/src/app/security/page.tsx:1-321` | F-005 security explainer |
| `web/src/app/sessions/[id]/loading.tsx:1-18` | F-051 full-session loading state |
| `web/src/app/sessions/[id]/page.tsx:1-18` | F-051 full-session route entry |
| `web/src/app/signup/page.tsx:1-84` | F-008 signup/config state |
| `web/src/app/verify-email/page.tsx:1-148` | F-011 token confirmation and next-route logic |
| `web/src/app/w/[id]/page.tsx:1-200` | F-024 workspace fetch/tab persistence/composition |

### Authentication, brand, files, hosts, icons, and Legion components

| Inspected source | Feature/screen contribution |
|---|---|
| `web/src/components/auth/AuthGate.tsx:1-29` | F-006 private-route gate/loading/redirect |
| `web/src/components/auth/BrowserDeviceRegistrationStatus.tsx:1-50` | F-015 registration/revocation health banner |
| `web/src/components/brand/press.tsx:1-255` | F-002–F-005 public masthead/footer/install copy |
| `web/src/components/files/FileExplorer.tsx:1-1413` | F-068–F-075/F-080 tree and all file operations/states |
| `web/src/components/files/file-icon.tsx:1-67` | F-075/F-114 file-type identity |
| `web/src/components/files/file-preview-card.tsx:1-183` | F-076 hover/pinned preview |
| `web/src/components/files/file-viewer-dialog.tsx:1-458` | F-077 viewer controls/states |
| `web/src/components/files/fileExplorerPaging.test.ts:1-45` | F-068/F-080 retained-page invariants |
| `web/src/components/files/fileExplorerPaging.ts:1-40` | F-068/F-080 retained-page budget logic |
| `web/src/components/files/preview-renderers.tsx:1-387` | F-078 content renderers/security/fallbacks |
| `web/src/components/files/session-files-aside.tsx:1-83` | F-065 session Files presentation |
| `web/src/components/files/use-preview.ts:1-82` | F-076–F-078 preview loading/cancel/cache states |
| `web/src/components/hosts/HostAgentsPanel.tsx:1-199` | F-087/F-088 host agent availability/install/policy |
| `web/src/components/hosts/connect-host.tsx:1-448` | F-013/F-082/F-083 pairing and identity approval |
| `web/src/components/icons/AgentIcon.test.ts:1-62` | F-114 agent icon resolution invariants |
| `web/src/components/icons/AgentIcon.tsx:1-177` | F-036/F-045/F-114 agent/shell icon mapping |
| `web/src/components/icons/BrandMark.tsx:1-63` | F-001/F-114 product mark/wordmark |
| `web/src/components/legion/LegionHostCard.tsx:1-150` | F-089 host fleet card |
| `web/src/components/legion/LegionHostDetail.tsx:1-115` | F-090 detailed host hover content |
| `web/src/components/legion/LegionStrip.tsx:1-299` | F-021 compact/persisted fleet strip |
| `web/src/components/legion/legion-parts.tsx:1-263` | F-021/F-089 capacity/status presentation helpers |

### Navigation, onboarding, profile, session, and settings components

| Inspected source | Feature/screen contribution |
|---|---|
| `web/src/components/nav/AppShell.tsx:1-291` | F-016 responsive shell/sidebar/drawer/global hosts |
| `web/src/components/nav/Sidebar.tsx:1-621` | F-017–F-023 navigation/search/workspace/global actions |
| `web/src/components/nav/SidebarArchivedSection.tsx:1-419` | F-020 archived disclosure/modal/actions |
| `web/src/components/nav/SidebarWorkspaceRow.tsx:1-232` | F-019 row rename/drag/menu |
| `web/src/components/nav/sidebar-parts.tsx:1-175` | F-016–F-021 reusable rail rows/headers/tooltips |
| `web/src/components/onboarding/auth-shell.tsx:1-204` | F-007–F-014 auth/onboarding layout and states |
| `web/src/components/onboarding/oauth-buttons.tsx:1-42` | F-007/F-008 configured OAuth controls |
| `web/src/components/onboarding/onboarding-flow.tsx:1-504` | F-012–F-014 verification/host/first-workspace flow |
| `web/src/components/onboarding/signup-form.tsx:1-110` | F-008 fields/providers/invite/validation |
| `web/src/components/onboarding/step-machine.test.ts:1-87` | F-012 routing transition invariants |
| `web/src/components/onboarding/step-machine.ts:1-35` | F-012 conditional step transition function |
| `web/src/components/profile/ProfileDialog.tsx:1-325` | F-022/F-104 profile/activity/share |
| `web/src/components/profile/profile-dialog-store.ts:1-39` | F-022 global profile dialog state |
| `web/src/components/session/session-view.tsx:1-368` | F-051/F-065 full session controls/Files split |
| `web/src/components/settings/AccountPanel.tsx:1-165` | F-092 verification/logout/account deletion |
| `web/src/components/settings/AgentsPanel.tsx:1-488` | F-096 agent list/editor/preferences |
| `web/src/components/settings/AppearancePanel.tsx:1-75` | F-093 theme selection |
| `web/src/components/settings/DevicesPanel.tsx:1-541` | F-099 identities/revoke/replace/prune/cleanup |
| `web/src/components/settings/HostsPanel.tsx:1-219` | F-081/F-082/F-085 settings host list/connect/actions |
| `web/src/components/settings/NotificationsPanel.tsx:1-237` | F-094 event/channel prefs/support/test/stream status |
| `web/src/components/settings/SettingsDialog.tsx:1-122` | F-091 sections/admin gate |
| `web/src/components/settings/SkillsPanel.tsx:1-196` | F-097 skill CRUD |
| `web/src/components/settings/TemplatesPanel.tsx:1-217` | F-098 template summaries/rename/icon/delete |
| `web/src/components/settings/TrustPanel.tsx:1-485` | F-100/F-101 passkey bundle setup/unlock/backup/revoke |
| `web/src/components/settings/agent-form.test.ts:1-53` | F-096 agent form validation invariants |
| `web/src/components/settings/agent-form.ts:1-45` | F-096 agent form normalization/validation |
| `web/src/components/settings/settings-dialog-store.ts:1-72` | F-091 global settings section state |

### Terminal and trust components

| Inspected source | Feature/screen contribution |
|---|---|
| `web/src/components/terminal/Composer.tsx:1-75` | F-066 latent raw/composer UI |
| `web/src/components/terminal/ConnectingOverlay.tsx:1-275` | F-052/F-057 staged connection and retry states |
| `web/src/components/terminal/ConnectionChip.tsx:1-221` | F-058 path/RTT/trust diagnostics |
| `web/src/components/terminal/LiveTerminalProvider.tsx:1-310` | F-064 warm LRU terminal ownership |
| `web/src/components/terminal/ModifierBar.tsx:1-186` | F-055 mobile shortcuts/focus preservation |
| `web/src/components/terminal/Terminal.tsx:1-4059` | F-052–F-064 terminal render/input/touch/upload/ownership core |
| `web/src/components/terminal/latency-hud.ts:1-118` | F-063 opt-in latency measurement/HUD |
| `web/src/components/terminal/live-write-buffer.test.ts:1-48` | F-052/F-053 buffered-write invariants |
| `web/src/components/terminal/live-write-buffer.ts:1-78` | F-052/F-053 pending/live byte ordering |
| `web/src/components/terminal/predictive-echo.test.ts:1-88` | F-063 predictive reconciliation invariants |
| `web/src/components/terminal/predictive-echo.ts:1-143` | F-063 predictive echo state machine |
| `web/src/components/terminal/upload-progress-bar.tsx:1-66` | F-059 byte-weighted, non-interactive progress presentation |
| `web/src/components/terminal/upload-progress.test.ts:1-32` | F-059 progress aggregation invariants |
| `web/src/components/terminal/upload-progress.ts:1-23` | F-059 aggregate progress derivation |
| `web/src/components/terminal/useSessionSocket.test.ts:1-25` | F-052 session socket invariant entry |
| `web/src/components/terminal/useSessionSocket.ts:1-1681` | F-052/F-056/F-059 signaling/WebRTC/control/upload transport |
| `web/src/components/terminal/xterm-config.mjs:1-121` | F-062 exact terminal metrics/themes/Unicode/emulation |
| `web/src/components/trust/device-endorsement.tsx:1-184` | F-102 cross-host device endorsement |
| `web/src/components/trust/introduction-panel.tsx:1-121` | F-103 endorsement introduction/polling |

### Shared UI primitives and tests

| Inspected source | Feature/screen contribution |
|---|---|
| `web/src/components/ui/armed-motion.ts:1-28` | F-112 meaningful post-mount motion arming |
| `web/src/components/ui/badge.tsx:1-35` | F-113 semantic badges |
| `web/src/components/ui/button.tsx:1-58` | F-113 action variants/sizes |
| `web/src/components/ui/card.tsx:1-53` | F-113 grouped surfaces |
| `web/src/components/ui/cascade-menu.tsx:1-472` | F-109 stepped desktop/menu mobile-sheet control |
| `web/src/components/ui/collapse.tsx:1-54` | F-021/F-108 disclosure motion/state |
| `web/src/components/ui/confirm.tsx:1-109` | F-111/F-118 global confirmation behavior |
| `web/src/components/ui/dialog.tsx:1-149` | F-110 modal sizes/focus/scrim |
| `web/src/components/ui/drawer.tsx:1-178` | F-016/F-110 web-mobile drawer gesture/focus |
| `web/src/components/ui/dropdown-menu.tsx:1-297` | F-109 menu/context/check/destructive controls |
| `web/src/components/ui/empty-state.tsx:1-53` | F-113 empty-state structure/action |
| `web/src/components/ui/hover-intent.test.ts:1-147` | F-076/F-090 hover timing invariants |
| `web/src/components/ui/hover-intent.ts:1-146` | F-076/F-090 fine-pointer intentional-hover logic |
| `web/src/components/ui/input.tsx:1-25` | F-113 text input primitive |
| `web/src/components/ui/label.tsx:1-17` | F-112/F-113 field labeling |
| `web/src/components/ui/menu-position.test.ts:1-342` | F-109 placement/clamping invariants |
| `web/src/components/ui/menu-position.ts:1-189` | F-109 anchored/context menu geometry |
| `web/src/components/ui/popover.tsx:1-128` | F-076/F-110 anchored preview surface |
| `web/src/components/ui/sheet.tsx:1-149` | F-109/F-110 mobile sheet/drag dismissal |
| `web/src/components/ui/skeleton.tsx:1-5` | F-113 known-layout loading placeholder |
| `web/src/components/ui/spinner.tsx:1-31` | F-113 indeterminate loading/status label |
| `web/src/components/ui/status.tsx:1-63` | F-040/F-045/F-057/F-113 activity/host dots |
| `web/src/components/ui/switch.tsx:1-113` | F-088/F-093/F-094/F-097 settings switches/rows |
| `web/src/components/ui/textarea.tsx:1-22` | F-066/F-097 multiline input |
| `web/src/components/ui/toast.tsx:1-241` | F-111 global outcomes/errors/actions/coalescing |
| `web/src/components/ui/tooltip.tsx:1-147` | F-016/F-021 collapsed-rail hints |

### Workspace components and tests

| Inspected source | Feature/screen contribution |
|---|---|
| `web/src/components/workspace/agent-command.test.ts:1-128` | F-036/F-049 agent command construction invariants |
| `web/src/components/workspace/agent-command.ts:1-90` | F-036/F-049 command/env/yolo composition |
| `web/src/components/workspace/agent-switcher.tsx:1-223` | F-047 shell/agent/install/files handoff |
| `web/src/components/workspace/archived-banner.tsx:1-51` | F-033/F-050 archived restore banner |
| `web/src/components/workspace/folder-picker-column.tsx:1-143` | F-038 column rows/loading/error/truncation |
| `web/src/components/workspace/folder-picker-crumbs.tsx:1-87` | F-038 breadcrumb navigation |
| `web/src/components/workspace/folder-picker-helpers.test.ts:1-177` | F-038 home jail/page/filter invariants |
| `web/src/components/workspace/folder-picker-helpers.ts:1-136` | F-038 path/filter/page helpers |
| `web/src/components/workspace/folder-picker.tsx:1-702` | F-038 complete folder picker controls/keys/states |
| `web/src/components/workspace/instantiate-template.ts:1-116` | F-031 replay template into workspace/sessions |
| `web/src/components/workspace/launcher-fab.tsx:1-624` | F-034 tap/drag child launcher/placement/bin |
| `web/src/components/workspace/new-session-menu-helpers.test.ts:1-20` | F-035–F-037 remembered-home helper invariants |
| `web/src/components/workspace/new-session-menu-helpers.ts:1-11` | F-035–F-037 home-label helper |
| `web/src/components/workspace/new-session-menu.tsx:1-490` | F-035–F-037 shell/agent/files cascades and creation |
| `web/src/components/workspace/new-workspace-menu.tsx:1-211` | F-030/F-031 blank/template workspace creation |
| `web/src/components/workspace/pending-launch.ts:1-21` | F-049 one-shot agent launch queue |
| `web/src/components/workspace/session-pane.tsx:1-593` | F-045/F-046 terminal pane header/menu/lifecycle |
| `web/src/components/workspace/shell-handoff.ts:1-91` | F-047 controlled Ctrl-C agent handoff |
| `web/src/components/workspace/tab-home.tsx:1-187` | F-029 per-tab home host/folder |
| `web/src/components/workspace/widget-pane.tsx:1-194` | F-048 files tile header/actions |
| `web/src/components/workspace/workspace-grid-helpers.test.ts:1-594` | F-040–F-044 placement/reflow/dock/split invariants |
| `web/src/components/workspace/workspace-grid-helpers.ts:1-722` | F-040–F-044 24×24 layout interaction algorithms |
| `web/src/components/workspace/workspace-grid.tsx:1-1894` | F-040–F-044 render/drag/resize/cross-tab/mobile operations |
| `web/src/components/workspace/workspace-icon-dialog.tsx:1-254` | F-032 icon discovery/upload/initials |
| `web/src/components/workspace/workspace-tabs.tsx:1-1263` | F-025–F-029/F-033/F-039 tab/workspace actions |

## Parity acceptance use

Each implementation plan should cite one or more F-numbers and may mark them complete only after all listed controls, state branches, keyboard/gesture behavior, and side effects are testable on the target platform. Visual completion without error/empty/offline/capability states is not capability completion. “Desktop-only-by-nature” is complete only when its stated phone equivalent mutates/preserves the same underlying data.

The recommended vertical slice is F-006/F-007 → F-017/F-024/F-026/F-040 → F-051–F-058/F-062/F-064, gated by the physical-iPhone transport/trust spike. That slice proves the core workspace→tab→terminal loop without pretending that the remaining secondary contract can be dropped.
