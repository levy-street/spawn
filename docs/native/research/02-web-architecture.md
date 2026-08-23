# R02 — Web application architecture, state management, and data flow

## TL;DR

1. The web app is a mostly-client-side Next.js shell: one process-local `QueryClient`, then one `LiveTerminalProvider`, with route-specific auth and chrome wrappers (`web/src/lib/query.tsx:13-49`).
2. TanStack Query owns remote snapshots; there is no query persistence, dehydration, hydration, Redux, Zustand, or general app-state context (`web/src/lib/query.tsx:13-49`).
3. The default query policy is `staleTime: 10_000`, `refetchOnWindowFocus: false`, and `retry: 1`; only file-list queries override `gcTime`, setting it to zero (`web/src/lib/query.tsx:14-24`; `web/src/components/files/FileExplorer.tsx:206-235`).
4. The principal shared keys are `me`, `auth-config`, `hosts`, `host`, `sessions`, `session`, `workspaces`, `workspace`, `workspace-templates`, `agents`, and `skills`; trust, browser-device, file, and admin surfaces add scoped keys documented below.
5. Remote list/detail duplication is intentional: successful mutations commonly write both `['session', id]` and `['sessions']`, or both `['workspace', id]` and `['workspaces']`, then polling/invalidation reconciles server truth (`web/src/components/session/session-view.tsx:44-50`; `web/src/components/workspace/workspace-tabs.tsx:202-220`).
6. Workspace grid edits are the most sophisticated optimistic path: immediate cache writes, a 500 ms debounce, serialized saves, revision/epoch guards, and rollback to the last server workspace (`web/src/components/workspace/workspace-grid.tsx:501-528`; `web/src/components/workspace/workspace-grid.tsx:607-655`).
7. Derived state is kept in pure modules—session presentation/attention, workspace counts, tab algebra, 24×24 grid algebra, and fleet rollups—not copied into a second mutable store (`web/src/lib/sessions.ts:18-129`; `web/src/lib/workspaces.ts:18-92`; `web/src/lib/grid.ts:1-33`; `web/src/lib/legion.ts:134-190`).
8. Durable browser state is small and explicit: eleven written `localStorage` key families plus three read-only debug flags, one session upload-reconciliation key family, three durable IndexedDB databases, and one scratch diagnostic database; auth tokens are never put in Web Storage (`web/src/lib/api.ts:5-16`; `web/src/lib/browser-device-identity.ts:17-36`).
9. Web auth is an HTTP-only-cookie lifecycle with no refresh client or global 401 interceptor; login seeds `['me']`, logout closes alerts and hard-navigates, and only browser-device revocation—not auth—coordinates across tabs (`web/src/lib/auth.ts:7-32`; `web/src/lib/auth.ts:56-72`; `web/src/lib/browser-device-registration.ts:174-194`).
10. Native should ship TanStack Query plus a literal query-key registry, pure selector modules, explicit realtime/terminal stores, SecureStore only for credentials/private keys, plain KV for preferences, and no persisted query cache.

## Scope and source-reading notes

This report describes the architecture the native view layer should reproduce, not the web responsive UI.
It covers every routed page under `web/src/app`, every literal or helper-generated TanStack Query key,
every query-cache write/invalidation/removal, and every production Web Storage/IndexedDB call found under
`web/src`.

The inspected web dependency range is `@tanstack/react-query: ^5.100.9`
(`web/package.json:24`). The npm registry reported `@tanstack/react-query` **5.101.4** on
2026-08-22. External package versions later in this report were checked the same day.

The shared architectural boundary is important:

```text
REST control-plane snapshots       -> TanStack Query
alert/control/signaling lifetimes  -> module singleton or scoped client
terminal rendering/connection pool -> React context + refs
derived display/domain values      -> pure functions + local useMemo
durable device/user preferences    -> named browser stores
local interaction state            -> component state / navigation state
```

The REST helper validates selected responses with Zod, always includes cookies, and throws a typed
`ApiError`; it does not contain a cache, refresh loop, or 401 interceptor (`web/src/lib/api.ts:5-66`):

```ts
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public detail?: unknown,
  ) { /* ... */ }
}

export async function api<T>(
  path: string,
  init: RequestInit & { schema?: z.ZodType<T> } = {},
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    ...rest,
  });
  if (!res.ok) throw new ApiError(/* status, code, message, detail */);
  if (res.status === 204) return undefined as T;
  const data = await res.json();
  return schema ? schema.parse(data) : (data as T);
}
```

## 1. Route map

### 1.1 Global routing and origin behavior

Next proxies `/api/:path*`, `/ws/:path*`, `/healthz`, and `/install.sh` to the configured control
plane, which lets production API and WebSocket traffic use the current origin
(`web/next.config.ts:60-66`). `API_URL` is empty by default and only becomes cross-origin when
`NEXT_PUBLIC_SPAWN_API_URL` is set (`web/src/lib/api.ts:13-16`). WebSocket URL helpers similarly
derive from the browser origin and provide three routes: `/ws/browser?session_id=...`,
`/ws/host?host_id=...`, and `/ws/alerts`; signaling uses subprotocol `spawn.v3`
(`web/src/lib/ws.ts:16-48`).

On an `admin.*` hostname, middleware rewrites ordinary paths under `/admin`; API, Next internals,
and auth pages pass through. The admin hostname therefore has a separate browser origin and cookie
jar. This is packaging, not authorization; admin APIs remain the security boundary
(`web/src/middleware.ts:3-13`; `web/src/middleware.ts:14-45`).

Legacy redirects are:

| Old route | Destination | Behavior |
|---|---|---|
| `/agents/new` | `/` | Temporary redirect. |
| `/agents/:id` | `/sessions/:id` | Temporary redirect; literal `new` is ordered first. |
| `/agents` | `/` | Temporary redirect. |
| `/screens` | `/` | Temporary redirect. |
| `/screens/:id` | `/w/:id` | Temporary redirect. |
| `/presets` | `/` | Temporary redirect. |
| `/hosts` | `/` | Temporary redirect. |
| `/settings` | `/` | Temporary redirect. |
| `/trust` | `/` | Temporary redirect. |

All nine redirects are declared together (`web/next.config.ts:68-84`).

### 1.2 Every concrete app route

| Route | Reachability and shell | What it renders and fetches | Redirects / gates / exceptional behavior |
|---|---|---|---|
| `/` | Public, including signed-in users. No `AuthGate`. | Client marketing/installation landing page. It derives the install command from `window.location.origin`; it does not issue an API query (`web/src/app/page.tsx:195-208`). | Intentionally remains the lander rather than bouncing signed-in users into the app (`web/src/app/app/page.tsx:20-25`). |
| `/app` | Logical signed-in entry resolver, but implements its own gate rather than wrapping `AuthGate`. | Fetches `['me']`, `['auth-config']`, `['hosts']`, and `['workspaces']`; hosts/workspaces are enabled only with a user (`web/src/app/app/page.tsx:27-41`). | Signed out → `/login`; verification incomplete → `/onboarding`; no host and not skipped → `/onboarding?step=host`; otherwise restores `spawn.workspaces.last` or the lowest-position workspace and replaces with `/w/:id` (`web/src/app/app/page.tsx:61-108`). If no usable destination exists it renders `AppShell` empty states for skipped setup, offline host, or first-workspace creation (`web/src/app/app/page.tsx:152-210`). |
| `/w/[id]` | `AuthGate` → `AppShell` → `Suspense(null)` → workspace body (`web/src/app/w/[id]/page.tsx:21-31`). | Fetches `['workspace', id]`, active `['workspaces']`, and `['sessions']`; the session list polls every 5 s (`web/src/app/w/[id]/page.tsx:54-70`). | A 404 invalidates workspace lists and selects the first remaining workspace by `position`, else `/app` (`web/src/app/w/[id]/page.tsx:84-92`). Active-tab priority is explicit choice/`?tab`, then a `?focus` session's tab, per-device persisted tab, then server `active_tab` (`web/src/app/w/[id]/page.tsx:99-120`). |
| `/sessions/[id]` | `AuthGate` → `AppShell`; mobile nav is hidden for the terminal page (`web/src/app/sessions/[id]/page.tsx:8-18`). | `SessionView` fetches `['session', id]` every 5 s and `['workspaces']` with 15 s staleness (`web/src/components/session/session-view.tsx:55-79`). | A session 404 invalidates sessions and returns to its containing workspace if known, otherwise `/` (`web/src/components/session/session-view.tsx:89-93`). A route-level loading file renders `AppShell` plus a spinner (`web/src/app/sessions/[id]/loading.tsx:10-17`). |
| `/hosts/[id]` | `AuthGate` → `AppShell` (`web/src/app/hosts/[id]/page.tsx:49-56`). | Fetches `['host', id]` every 30 s and `['sessions', {host_id:id}]` every 5 s; also mounts agent availability/control UI (`web/src/app/hosts/[id]/page.tsx:75-86`). | Rename invalidates host detail and list. Removal first performs local trust cleanup/tombstoning, then server deletion, invalidates host/session lists, opens settings, and routes to `/app` (`web/src/app/hosts/[id]/page.tsx:89-160`). |
| `/hosts/[id]/files` | `AuthGate` → `AppShell` → `Suspense(null)` (`web/src/app/hosts/[id]/files/page.tsx:15-24`). | Fetches `['host', id]`, then `FileExplorer` opens a direct host-control channel and reads `host-files` keys (`web/src/app/hosts/[id]/files/page.tsx:27-72`; `web/src/components/files/FileExplorer.tsx:185-235`). | No route redirect is encoded; absent/loading host is handled in-page. |
| `/legion` | `AuthGate` → `AppShell` (`web/src/app/legion/page.tsx:26-34`). | Fetches `['hosts']` every 15 s and `['sessions']` every 5 s, derives the fleet summary, and opens per-host direct metric channels only when “Live” is enabled (`web/src/app/legion/page.tsx:36-47`; `web/src/app/legion/page.tsx:89-123`). | Standard auth redirect only. Empty fleet gives an inline “possess a machine” action (`web/src/app/legion/page.tsx:100-119`). |
| `/device` | `AuthGate` → `AppShell` (`web/src/app/device/page.tsx:7-17`). | Renders `ConnectHost`, which polls `['hosts']` every 3 s and uses the browser-device registration query for signed approval (`web/src/components/hosts/connect-host.tsx:69-78`; `web/src/components/hosts/connect-host.tsx:275-294`). | Standard auth redirect only. Pairing success invalidates hosts. |
| `/admin` | Root provider → admin layout's `AuthGate` → `AdminChrome`; it deliberately does not use `AppShell` (`web/src/app/admin/layout.tsx:15-20`). | Fetches `['admin','mail']`, `['admin','emails']`, `['admin','users']`, and `['admin','invites']` (`web/src/app/admin/page.tsx:39-42`; `web/src/app/admin/page.tsx:181-182`; `web/src/app/admin/page.tsx:250-252`). | Non-admin users see “Nothing here”; this client check is convenience, while every admin API returns 404 to non-admins (`web/src/app/admin/layout.tsx:8-14`; `web/src/app/admin/layout.tsx:23-48`). Admin host rewriting is described above. |
| `/onboarding` | Public `AuthShell` inside `Suspense`; it supports a signed-out account step (`web/src/app/onboarding/page.tsx:6-20`). | `OnboardingFlow` fetches `['me']`, `['auth-config']`, conditionally `['hosts']`, then `['workspaces']` at completion (`web/src/components/onboarding/onboarding-flow.tsx:45-116`). | The live-state machine is account → verify (if enforced) → host (unless skipped) → done; a `?step` deep link is honored only if it is the currently unsatisfied gate (`web/src/components/onboarding/step-machine.ts:1-35`). Completion may atomically create the first workspace/session, then routes to `/w/:id`, else `/app` (`web/src/components/onboarding/onboarding-flow.tsx:184-224`). |
| `/verify-email` | Public `AuthShell` + `Suspense`; no `AuthGate` (`web/src/app/verify-email/page.tsx:137-146`). | Confirms the `?token`, seeds/invalidates `['me']`, then fetches `['hosts']` to choose `/app` versus onboarding (`web/src/app/verify-email/page.tsx:30-74`; `web/src/app/verify-email/page.tsx:85-96`). | Missing/failed token is inline. A module `Map<token, Promise>` ensures Strict Mode/remounts confirm each token once (`web/src/app/verify-email/page.tsx:14-27`). |
| `/login` | Public `AuthShell`; authenticated users are not proactively redirected. | Fetches public `['auth-config']`; password login calls the REST helper, seeds/invalidates `['me']` and replaces with `/app`. OAuth links perform a full navigation (`web/src/app/login/page.tsx:15-38`; `web/src/components/onboarding/oauth-buttons.tsx:13-32`). | Inline errors; `/app` performs subsequent onboarding/workspace routing. |
| `/signup` | Public `AuthShell` + `Suspense`; no auth gate (`web/src/app/signup/page.tsx:70-82`). | Fetches `['auth-config']`; signup seeds/invalidates `['me']`, then replaces with `/onboarding` (`web/src/app/signup/page.tsx:12-64`; `web/src/components/onboarding/signup-form.tsx:31-48`). | Config load failure renders retry UI. Invite value is URL/form state, not durable storage. |
| `/forgot-password` | Public `AuthShell`. | Calls password-reset request; no query cache (`web/src/app/forgot-password/page.tsx:11-31`). | The client deliberately shows the same sent state even if the request throws, avoiding account enumeration (`web/src/app/forgot-password/page.tsx:18-28`). |
| `/reset-password` | Public `AuthShell` + `Suspense`. | Reads `?token`, confirms new password, seeds/invalidates `['me']`, and replaces with `/app` (`web/src/app/reset-password/page.tsx:16-42`; `web/src/app/reset-password/page.tsx:114-123`). | Missing token/validation/server failures are inline. |
| `/download` | Public. | Static download/install presentation with client platform detection, not server data (`web/src/app/download/page.tsx:78-105`; `web/src/lib/platform.ts:48-61`). | No guard or redirect. |
| `/security` | Public server-rendered information page. | Static security copy; no client query (`web/src/app/security/page.tsx:18-24`). | No guard or redirect. |

There is no “authenticated users may not see auth pages” guard. `/login`, `/signup`, password routes,
and `/verify-email` remain directly reachable. Onboarding is different: it continuously derives the first
unsatisfied gate from live auth/config/host state, so it naturally advances rather than preserving a stale
step (`web/src/components/onboarding/step-machine.ts:12-35`).

## 2. Provider and shell tree

### 2.1 Exact global nesting

The root layout runs the theme bootstrap before paint, then enters the only global provider bundle
(`web/src/app/layout.tsx:61-79`):

```tsx
<html lang="en" suppressHydrationWarning className={grimoire.variable}>
  <head>
    <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
  </head>
  <body className="bg-background text-foreground antialiased">
    <AppProviders>{children}</AppProviders>
  </body>
</html>
```

`AppProviders` is exactly (`web/src/lib/query.tsx:13-49`):

```tsx
useViewportInset();

return (
  <QueryClientProvider client={client}>
    <LiveTerminalProvider>{children}</LiveTerminalProvider>
  </QueryClientProvider>
);
```

The order is meaningful:

1. The blocking theme script is outside React because React is too late to prevent the first-paint flash;
   the reactive theme itself is a module store, not a provider (`web/src/lib/theme-bootstrap.ts:1-25`;
   `web/src/lib/theme.ts:66-74`).
2. `QueryClientProvider` must wrap `LiveTerminalProvider` because pooled `Terminal` children call queries
   for their session and signaling host (`web/src/components/terminal/LiveTerminalProvider.tsx:197-228`;
   `web/src/components/terminal/Terminal.tsx:1029-1037`).
3. The viewport hook is an effect, not context. It publishes `--vv-height` and `--vv-keyboard` CSS
   variables from `visualViewport` (`web/src/lib/viewport.ts:5-13`; `web/src/lib/viewport.ts:49-81`).
4. Production service-worker registration is also an effect in this provider. It does not wrap children
   or hydrate query state (`web/src/lib/query.tsx:27-43`).

### 2.2 Protected product shell

Most signed-in pages add:

```text
AuthGate
└── AppShell
    ├── BrowserDeviceRegistrationStatus
    ├── Sidebar (desktop) / Drawer + Sidebar (small layout)
    ├── route page content
    ├── ConfirmHost
    ├── ToastHost
    ├── SettingsDialog
    └── ProfileDialog
```

`AuthGate` reads the shared `['me']` query, renders a small loading placeholder, replaces the route with
`/login` after a resolved anonymous result, and returns `null` until navigation completes
(`web/src/components/auth/AuthGate.tsx:7-28`). It does not enforce verification, host setup, or admin
status.

`AppShell` always subscribes to attention alerts and reads `['workspaces']` to name the current workspace
(`web/src/components/nav/AppShell.tsx:68-85`). It mounts registration status above route content and the
four global overlay hosts after the route content (`web/src/components/nav/AppShell.tsx:209-288`). The
alert stream is specifically mounted here because the socket, preferences, and cross-tab claim are
module singletons that survive the shell remount between routes (`web/src/components/nav/AppShell.tsx:73-81`).

The exceptions are deliberate:

- `/admin` uses `AuthGate` plus `AdminChrome`, so it has no product sidebar, settings/profile hosts, or
  toast host (`web/src/app/admin/layout.tsx:15-20`; `web/src/app/admin/layout.tsx:50-69`).
- `/app` owns its auth/onboarding resolver and only mounts `AppShell` after it has selected an actionable
  empty state (`web/src/app/app/page.tsx:27-41`; `web/src/app/app/page.tsx:152-210`).
- Public auth pages use `AuthShell`; their errors must therefore be inline rather than relying on the
  `AppShell` toast host (`web/src/app/login/page.tsx:40-107`; `web/src/components/ui/toast.tsx:149-178`).
- `/sessions/[id]` and its route loading boundary hide the small-layout nav so the terminal occupies the
  page (`web/src/app/sessions/[id]/page.tsx:12-16`; `web/src/app/sessions/[id]/loading.tsx:10-17`).

### 2.3 The only React contexts

The only production `createContext` calls under `web/src` are the live-terminal action and state contexts.
They are intentionally split so stable claim/release/handle actions do not force placeholder ref callbacks
to rerun when reactive connection state changes (`web/src/components/terminal/LiveTerminalProvider.tsx:35-50`).

```ts
type Actions = {
  claim: (sessionId: string, container: HTMLElement, token: symbol) => void;
  release: (sessionId: string, token: symbol) => void;
  getHandle: (sessionId: string) => TerminalHandle | null;
};
type State = {
  live: Record<string, SessionLive>;
  warm: Record<string, boolean>;
  claimed: Record<string, boolean>;
};
```

The provider keeps at most six rendered/connected terminal entries, never evicts a claimed terminal, and
evicts the least-recently-active parked terminals first (`web/src/components/terminal/LiveTerminalProvider.tsx:18-24`;
`web/src/components/terminal/LiveTerminalProvider.tsx:59-102`). Claiming physically moves a portal host into
the screen placeholder; release moves it to an off-screen park while preserving connection/render state
(`web/src/components/terminal/LiveTerminalProvider.tsx:104-135`; `web/src/components/terminal/LiveTerminalProvider.tsx:156-194`).

Consumers derive:

- visible/claimed sessions for alert suppression;
- any terminal handle by session ID;
- one session's connection/display state;
- `connected | connecting | warm | off` from pool membership, socket state, and claim state
  (`web/src/components/terminal/LiveTerminalProvider.tsx:231-309`).

## 3. TanStack Query architecture

### 3.1 Client defaults, lifetime, and validation

One `QueryClient` is constructed with lazy `useState`, preventing sharing between SSR requests and keeping
one client for the lifetime of the mounted client tree (`web/src/lib/query.tsx:8-25`):

```ts
new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});
```

There are no mutation defaults. `gcTime` is not globally set; inactive queries therefore use TanStack
Query v5's library default (five minutes in a browser), except the three `host-files` forms, which set
`gcTime: 0` (`web/src/components/files/FileExplorer.tsx:206-235`). See TanStack's
[important defaults](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults).

There is no `PersistQueryClientProvider`, persister, `dehydrate`, `hydrate`, or `HydrationBoundary` in the
web tree. The service worker caches static assets and navigation responses in Cache Storage `spawn-v1`,
but deliberately bypasses `/api/*` and `/ws/*`, so it is not a server-state cache
(`web/public/sw.js:1-8`; `web/public/sw.js:38-72`). A reload therefore loses the Query cache and refetches
server snapshots.

Many REST fetchers pass Zod schemas. Core state shapes include (`web/src/lib/api.ts:234-256`;
`web/src/lib/api.ts:339-384`):

```ts
type Session = {
  id: UUID; name: string | null; host_id: UUID; host_name: string | null;
  cwd: string; status: "starting" | "running" | "exited" | "killed";
  started_at: string; exited_at: string | null; exit_code: number | null;
  last_output_at: string | null; last_input_at: string | null;
  last_activity_at: string | null;
  activity_state: "starting" | "active" | "quiet" | "waiting" |
    "input_sent" | "exited" | "killed" | "unknown";
  activity_label: string; foreground_command: string | null;
};

type Workspace = {
  id: UUID; name: string; host_id: UUID | null; cwd: string | null;
  layout: { version: 3; active_tab: string | null; tabs: WorkspaceTab[] };
  position: number; icon: string | null;
  icon_source: "auto" | "custom" | "none" | null;
  archived_at: string | null; created_at: string; updated_at: string;
};
```

### 3.2 Complete query-key registry as implemented

“Default” below means stale for 10 s, one retry, no refetch on window focus, and default inactive GC.
Options are observer-specific: the same cache entry can have a fast polling observer on one mounted screen
and a long `staleTime` observer elsewhere.

| Key | Shape / fetcher | Readers and non-default policy | Who invalidates or writes it, and when |
|---|---|---|---|
| `['me']` | `{user: User} \| null`; `auth.me()` converts only HTTP 401 to `null` (`web/src/lib/auth.ts:12-25`). | Every auth gate/onboarding/auth-aware surface. `staleTime 30s`, `retry false`. | Login, signup, reset, verify set the returned user then invalidate (`web/src/app/login/page.tsx:24-32`; `web/src/components/onboarding/signup-form.tsx:31-43`; `web/src/app/reset-password/page.tsx:28-37`; `web/src/app/verify-email/page.tsx:49-55`). Onboarding verification polling/account success sets it directly (`web/src/components/onboarding/onboarding-flow.tsx:127-153`; `web/src/components/onboarding/onboarding-flow.tsx:301`). |
| `['auth-config']` | `{providers, email_verification_required, invite_only}` from `GET /api/auth/config` (`web/src/lib/api.ts:428-441`; `web/src/lib/api.ts:511-515`). | Login, signup, onboarding, `/app`; `staleTime 5m`, `retry 1` (`web/src/lib/auth.ts:35-53`). | No mutation invalidates it; explicit page retry calls `refetch`. |
| `['hosts']` | `Host[]` from `GET /api/hosts` (`web/src/lib/api.ts:541-546`). | `/app` default; onboarding 3s stale; pairing polls 3s; settings polls 10s; legion polls 15s; sidebar polls 30s; creation/home/tab surfaces use 15–30s stale (`web/src/components/onboarding/onboarding-flow.tsx:84-90`; `web/src/components/hosts/connect-host.tsx:73-77`; `web/src/components/settings/HostsPanel.tsx:26-34`; `web/src/app/legion/page.tsx:36-43`; `web/src/components/nav/Sidebar.tsx:76-80`). | Pairing success, host rename/remove, sidebar host/workspace refresh, and settings host changes invalidate (`web/src/components/hosts/connect-host.tsx:281-294`; `web/src/app/hosts/[id]/page.tsx:89-95`; `web/src/components/settings/HostsPanel.tsx:36-49`; `web/src/components/nav/Sidebar.tsx:101-110`). Onboarding host-online callback upserts a row immediately (`web/src/components/onboarding/onboarding-flow.tsx:145-153`). |
| `['host', hostId]` | `Host` from `GET /api/hosts/:id` (`web/src/lib/api.ts:547-551`). | Host detail polls 30s; files page default; `useHostControl` 30s stale; `Terminal` uses default (`web/src/app/hosts/[id]/page.tsx:75-80`; `web/src/hooks/useHostControl.ts:13-20`; `web/src/components/terminal/Terminal.tsx:1029-1037`). | Host-detail rename invalidates exact detail and list (`web/src/app/hosts/[id]/page.tsx:89-95`). Sidebar prefix `['workspace']` does not affect it. |
| `['host-agents', hostId]` | `{agents: HostAgentStatus[]}` from `GET /api/hosts/:id/agents` (`web/src/lib/api.ts:175-198`; `web/src/lib/api.ts:559-564`). | Host agent panel: enabled online, stale 30s, polls 60s; agent switcher: stale 5m (`web/src/components/hosts/HostAgentsPanel.tsx:18-27`; `web/src/components/workspace/agent-switcher.tsx:47-56`). | Successful install or policy change invalidates the exact host key (`web/src/components/hosts/HostAgentsPanel.tsx:37-49`). |
| `['sessions']` | Unfiltered `Session[]` from `GET /api/sessions` (`web/src/lib/api.ts:771-780`). | Sidebar, workspace, and legion poll every 5s; tabs/grid read the same cache with default or longer policies (`web/src/components/nav/Sidebar.tsx:59-63`; `web/src/app/w/[id]/page.tsx:66-70`; `web/src/app/legion/page.tsx:38-43`). | Alerts invalidate on receipt/suppression (`web/src/hooks/useSessionAlerts.tsx:89-111`). Session rename/restart write detail+list then invalidate; closes remove detail then invalidate (`web/src/components/workspace/session-pane.tsx:65-70`; `web/src/components/workspace/session-pane.tsx:166-194`). Workspace/session create, archive, delete, restore, host removal, duplication, pane conversion/move, and sidebar refresh all invalidate; exact sites are in §7. |
| `['sessions', {host_id}]` | Host-filtered `Session[]` from `GET /api/sessions?host_id=...` (`web/src/lib/api.ts:771-780`). | Host detail; enabled with ID, polls 5s (`web/src/app/hosts/[id]/page.tsx:81-86`). | Prefix invalidation `['sessions']` intentionally catches both global and filtered lists, e.g. host removal (`web/src/app/hosts/[id]/page.tsx:139-147`). Direct `setQueryData(['sessions'])` updates only the exact unfiltered list. |
| `['session', sessionId]` | `Session` from `GET /api/sessions/:id` (`web/src/lib/api.ts:781-785`). | Session page polls 5s and disables retries; pooled terminal uses 30s stale (`web/src/components/session/session-view.tsx:62-67`; `web/src/components/terminal/Terminal.tsx:1029-1032`). | Rename/restart write it; agent-launch prediction patches `foreground_command`; close removes the query (`web/src/components/session/session-view.tsx:44-50`; `web/src/components/workspace/agent-switcher.tsx:209-222`; `web/src/components/session/session-view.tsx:140-159`). |
| `['workspaces']` | Active `Workspace[]`, server-ordered by position, from `GET /api/workspaces` (`web/src/lib/api.ts:880-889`). | `/app` default; workspace page stale 10s; session page stale 15s; AppShell/grid stale 30s; sidebar polls 30s (`web/src/app/w/[id]/page.tsx:61-65`; `web/src/components/session/session-view.tsx:68-72`; `web/src/components/nav/AppShell.tsx:68-72`; `web/src/components/nav/Sidebar.tsx:64-68`). | Almost every workspace mutation invalidates. Optimistic reorder writes this list; workspace layout/settings/tab-home/icon updates write matching rows (`web/src/components/nav/Sidebar.tsx:126-149`; `web/src/components/workspace/workspace-tabs.tsx:202-220`; `web/src/hooks/useWorkspaceIconAutoFill.ts:57-72`). Prefix invalidation also matches archived list. |
| `['workspaces','archived']` | Archived `Workspace[]`, most recently archived first, from `GET /api/workspaces?archived=true` (`web/src/lib/api.ts:880-888`). | Sidebar only; stale 30s (`web/src/components/nav/Sidebar.tsx:69-75`). | Any prefix invalidation of `['workspaces']` refetches it; sidebar intentionally uses the prefix because archive/unarchive moves rows between lists (`web/src/components/nav/Sidebar.tsx:101-109`). |
| `['workspace', workspaceId]` | `Workspace` from `GET /api/workspaces/:id` (`web/src/lib/api.ts:890-894`). | Workspace route: stale 10s, retry false, refetch-on-focus true; add-session menu stale 10s (`web/src/app/w/[id]/page.tsx:54-60`; `web/src/components/workspace/new-session-menu.tsx:80-87`). | Layout/tab/home/icon flows write exact detail and active list. Creation invalidates returned ID; conflict and failed tab-home/layout writes invalidate exact ID. Sidebar uses prefix `['workspace']` after CRUD (`web/src/components/workspace/new-session-menu.tsx:179-193`; `web/src/components/workspace/tab-home.tsx:48-60`; `web/src/components/nav/Sidebar.tsx:101-110`). |
| `['workspace-templates']` | `WorkspaceTemplate[]` from `GET /api/workspace-templates` (`web/src/lib/api.ts:949-955`). | New-workspace menu stale 30s; settings default (`web/src/components/workspace/new-workspace-menu.tsx:52-57`; `web/src/components/settings/TemplatesPanel.tsx:27-35`). | Save-as-template, rename, icon update, and delete invalidate (`web/src/components/workspace/workspace-tabs.tsx:719-741`; `web/src/components/settings/TemplatesPanel.tsx:37-62`). |
| `['agents']` | `Agent[]` from `GET /api/agents` (`web/src/lib/api.ts:988-993`). | Settings default; launchers/tabs/grid 60s stale; switcher 5m stale (`web/src/components/settings/AgentsPanel.tsx:35-43`; `web/src/components/workspace/workspace-grid.tsx:426-432`; `web/src/components/workspace/agent-switcher.tsx:47-51`). | Create/update/delete invalidate. Yolo preference optimistically patches the matching row and invalidates only on error (`web/src/components/settings/AgentsPanel.tsx:43-85`). |
| `['skills']` | `Skill[]` from `GET /api/skills` (`web/src/lib/api.ts:1017-1022`). | Skills settings, default policy (`web/src/components/settings/SkillsPanel.tsx:12-20`). | Create, update, and delete each invalidate (`web/src/components/settings/SkillsPanel.tsx:40-63`). |
| `['profile']` | `Profile` totals, agents, sparse days, hosts from `GET /api/profile` (`web/src/lib/api.ts:156-173`; `web/src/lib/api.ts:689-691`). | Profile dialog only; enabled while open, stale 60s (`web/src/components/profile/ProfileDialog.tsx:34-43`). | No invalidator; a later open refetches when stale. |
| `['admin','mail']` | `AdminMailStatus` from `/api/admin/mail` (`web/src/lib/api.ts:647-653`; `web/src/lib/api.ts:668-670`). | Admin mail section, default. | No cache write/invalidation. |
| `['admin','emails']` | `AdminEmail[]` from `/api/admin/emails` (`web/src/lib/api.ts:655-670`). | Admin mail section, default. | Successful test email invalidates (`web/src/app/admin/page.tsx:39-55`). |
| `['admin','users']` | `AdminUser[]` from `/api/admin/users` (`web/src/lib/api.ts:621-631`; `web/src/lib/api.ts:677`). | Admin users section, default. | Read-only in current UI; no invalidator. |
| `['admin','invites']` | `AdminInvite[]` from `/api/admin/invites` (`web/src/lib/api.ts:633-645`; `web/src/lib/api.ts:678-686`). | Admin invite section, default. | Create and revoke invalidate (`web/src/app/admin/page.tsx:250-282`). |
| `['browser-device-registration', userId]` | `ready(device,key) \| cleanup_pending(key) \| revoked(key)`; fetcher loads/creates a device identity and registers it (`web/src/lib/browser-device-registration.ts:16-24`; `web/src/lib/browser-device-registration.ts:140-172`). | AppShell status, pairing, devices; enabled with user, stale forever, retry false (`web/src/lib/browser-device-registration.ts:174-183`). | A revocation-marker `storage` event invalidates cross-tab. Devices panel also sets staged states and invalidates for explicit fresh identity (`web/src/lib/browser-device-registration.ts:185-194`; `web/src/components/settings/DevicesPanel.tsx:77-105`; `web/src/components/settings/DevicesPanel.tsx:136-150`). |
| `['browser-devices']` | `BrowserDevice[]` from `/api/browser-devices` (`web/src/lib/api.ts:584-619`). | Devices settings; enabled with user (`web/src/components/settings/DevicesPanel.tsx:25-33`). | Registration becoming ready, revoke settlement, rename, and prune invalidate (`web/src/components/settings/DevicesPanel.tsx:42-46`; `web/src/components/settings/DevicesPanel.tsx:82-115`; `web/src/components/settings/DevicesPanel.tsx:169-194`). |
| `['browser-device-local-identity', userId]` | Local `BrowserDeviceIdentity \| null` loaded from IndexedDB, not REST. | Devices settings; enabled with user, retry false (`web/src/components/settings/DevicesPanel.tsx:34-39`). | Current-device cleanup sets `null`; “start fresh” also invalidates to reload (`web/src/components/settings/DevicesPanel.tsx:95-125`; `web/src/components/settings/DevicesPanel.tsx:136-150`). |
| `['browser-device-fingerprints', publicKeysCsv]` | `Map<deviceId,string>` locally derived from public keys. | Devices settings; enabled with at least one device (`web/src/components/settings/DevicesPanel.tsx:54-75`). | No explicit invalidator; changed CSV produces a new key. |
| `['trust','bundle']` | `TrustBundle \| null` from `/api/trust/bundle` (`web/src/lib/api.ts:455-461`; `web/src/lib/api.ts:699-715`). | Trust and devices settings; enabled with account (`web/src/components/settings/TrustPanel.tsx:52-61`; `web/src/components/settings/DevicesPanel.tsx:155-167`). | All trust-changing ceremonies invalidate prefix `['trust']` (`web/src/components/settings/TrustPanel.tsx:132-139`; `web/src/components/settings/TrustPanel.tsx:158-170`; `web/src/components/settings/TrustPanel.tsx:224-229`; `web/src/components/settings/TrustPanel.tsx:266-271`). |
| `['trust','passkeys']` | `PasskeyCredential[]` from `/api/trust/passkeys` (`web/src/lib/api.ts:463-469`; `web/src/lib/api.ts:717-721`). | Trust settings, enabled with account (`web/src/components/settings/TrustPanel.tsx:45-61`). | Prefix `['trust']` after setup/unlock/backup/revoke/forget. |
| `['trust','storage-probe', accountId]` | `{identityPersisted, probe: StoragePersistenceReport}` from local identity + scratch IndexedDB test. | Trust settings, enabled with account, stale forever (`web/src/components/settings/TrustPanel.tsx:62-72`). | Prefix `['trust']`; because it is stale forever, only explicit invalidation reruns it. |
| `['trust','local-pins', accountId]` | Active `BrowserHostPin[]` from local IndexedDB. | Trust settings, enabled with account (`web/src/components/settings/TrustPanel.tsx:74-82`). | Prefix `['trust']` after trust ceremonies. |
| `['trust','hosts']` | `Host[]` from REST, used only as advisory trust input. | Device endorsement hook, enabled by caller (`web/src/components/trust/device-endorsement.tsx:19-27`). | Prefix `['trust']` after endorsement or trust ceremonies. |
| `['trust','host-pin-map', hostIdsCsv]` | `Map<browserDeviceId, hostId[]>`; calls `trust.hostPins` for keyed hosts. | Device list/endorsement; enabled with keyed hosts, polls 15s (`web/src/components/trust/device-endorsement.tsx:28-50`). | Prefix `['trust']` after endorsement/trust changes; changing host CSV also creates a new key. |
| `['trust','introductions', accountId, deviceId]` | Locally verified `EndorsementIntroduction[]` from server claims plus private device identity. | Introduction panel; enabled with device, polls 15s (`web/src/components/trust/introduction-panel.tsx:21-46`). | Accept calls this query object's `refetch` directly (`web/src/components/trust/introduction-panel.tsx:48-61`). |
| `['host-files', hostId, rootPathOrEmpty]` | Direct-channel `HostDirList` (`path`, `home_dir`, parent, entries, cursor/truncated) (`web/src/lib/hostControl.ts:79-95`). | File explorer root; enabled when host control is ready, `gcTime 0` (`web/src/components/files/FileExplorer.tsx:185-212`). | Upload/mkdir/rename/delete refresh affected root/directory; full refresh invalidates prefix for this host (`web/src/components/files/FileExplorer.tsx:478-499`; `web/src/components/files/FileExplorer.tsx:563-652`). |
| `['host-files', hostId, path]` | Direct-channel first page for an expanded directory. | Dynamic `useQueries`; enabled when ready, `gcTime 0` (`web/src/components/files/FileExplorer.tsx:214-221`). | Same targeted directory/prefix invalidation as root. |
| `['host-files', hostId, path, 'page', cursor]` | Direct-channel later directory page. | Dynamic `useQueries`; enabled when ready, `gcTime 0` (`web/src/components/files/FileExplorer.tsx:222-235`). | Prefix invalidation for directory/host plus local cursor reset. |
| `['host-home', hostId]` | Direct-channel `{home_dir}` response. | Folder picker; enabled only while open/control-ready, stale 5m (`web/src/components/workspace/folder-picker.tsx:117-123`). | No explicit invalidator. |
| `['host-folders', hostId, path]` | Direct-channel fully paged directory entries. | Folder-picker columns and crumb menus; enabled with client, stale 5s (`web/src/components/workspace/folder-picker.tsx:145-155`; `web/src/components/workspace/folder-picker-crumbs.tsx:54-61`). | No explicit invalidator; folder creation is surfaced locally and its mutation error/status is local. |
| `['workspace-icon-suggestions', hostId, cwd]` | Locally/direct-channel derived `IconCandidate[]` from folder scanning. | Icon dialog; enabled only while open, online, control-ready; stale 5m, retry false (`web/src/components/workspace/workspace-icon-dialog.tsx:69-88`). | User can call its `refetch`; changed host/path creates a new key. |

No production call uses `cancelQueries`. Exact-key `setQueryData` calls do not update parameterized siblings;
prefix `invalidateQueries` calls do. This distinction is relied upon for sessions and workspaces.

## 4. React contexts, external stores, and other global state

### 4.1 What is—and is not—global

There is no Redux, Zustand, MobX, Recoil, or application-wide reducer. Durable server state belongs to the
TanStack Query cache. A few cross-route concerns are module-singleton external stores, and the only actual
application React contexts are the two halves of the live-terminal pool (`web/src/components/terminal/LiveTerminalProvider.tsx:35-50`).

This separation is important:

- Query cache: REST/direct-control resource state and server-derived state.
- Context: live terminal ownership and connection/display state that must follow a terminal between views.
- External singleton: theme, notification preferences, transient UI coordinators, and the alert socket.
- Component state: navigation chrome, dialogs, forms, active drag state, and unsaved layout transactions.
- Browser persistence: preferences, device identity/trust evidence, and uncertain upload reconciliation.

**RECOMMEND:** Preserve these ownership boundaries in native. Do not introduce a second server-state mirror in a
general-purpose store; it would make invalidation and terminal-event reconciliation harder, not easier.

### 4.2 Live terminal contexts

The provider deliberately splits stable imperative actions from changing observations so that an `attach` callback
does not re-fire merely because connection state changed (`web/src/components/terminal/LiveTerminalProvider.tsx:35-50`).

```ts
type Actions = {
  claim: (sessionId: string, container: HTMLElement, token: symbol) => void;
  release: (sessionId: string, token: symbol) => void;
  getHandle: (sessionId: string) => TerminalHandle | null;
};

type State = {
  live: Record<string, SessionLive>;
  warm: Record<string, boolean>;
  claimed: Record<string, boolean>;
};

const ActionsCtx = createContext<Actions | null>(null);
const StateCtx = createContext<State>({ live: {}, warm: {}, claimed: {} });
```

Source: `web/src/components/terminal/LiveTerminalProvider.tsx:35-50`.

The provider owns a `Map<sessionId, PoolEntry>`, a hidden parking container, warm IDs, claims, live connection
metadata, and a monotonic claim clock. `WARM_LIMIT` is six. When over budget it sorts only unclaimed entries by
`lastAt` and evicts least-recently-claimed terminals; the foreground entry is never evicted
(`web/src/components/terminal/LiveTerminalProvider.tsx:20-24`; `web/src/components/terminal/LiveTerminalProvider.tsx:52-102`).

`claim` creates or reparents a host node, marks it claimed, bumps recency, and enforces the limit. `release` is
token-guarded so an obsolete view cannot release a newer claim; it reparks the terminal without disconnecting it
(`web/src/components/terminal/LiveTerminalProvider.tsx:104-135`). Every warm terminal remains mounted via a portal,
with `active` and `autoTakeControl` true only while claimed (`web/src/components/terminal/LiveTerminalProvider.tsx:156-229`).

The public selectors/actions are:

| Hook | Input | Output/use |
|---|---|---|
| `useClaimedSessions()` | none | `Record<sessionId, boolean>` used to suppress alerts for sessions already visible (`web/src/components/terminal/LiveTerminalProvider.tsx:231-240`). |
| `useTerminalHandles()` | session ID at call time | Imperative `TerminalHandle | null`, allowing alert navigation/focus without routing through the grid (`web/src/components/terminal/LiveTerminalProvider.tsx:243-256`). |
| `useLiveTerminal(sessionId)` | nullable session ID | Stable attach ref, handle getter, connection info, display-control state; claims on attach/effect and releases on cleanup (`web/src/components/terminal/LiveTerminalProvider.tsx:258-293`). |
| `useSessionLive(sessionId)` | nullable session ID | Reactive `{connInfo, displayState}`, empty if the terminal is not warm (`web/src/components/terminal/LiveTerminalProvider.tsx:296-300`). |
| `useSessionConnState(sessionId)` | nullable session ID | `off`, `connecting`, `connected`, or `warm`; `warm` means socket open but not claimed (`web/src/components/terminal/LiveTerminalProvider.tsx:302-310`). |

Native cannot reparent a DOM portal. The architectural contract is still useful: one connection/runtime per warm
session, an imperative handle registry, single-owner claims, and LRU eviction. The native terminal surface should
attach to that runtime or replay buffered terminal state into its native view, depending on the terminal renderer.

**RECOMMEND:** Implement `TerminalPoolProvider` as the one native context, preserving the action/state split and
six-session LRU. Keep terminal bytes, scrollback, transport handles, and display-control state out of React Query.

### 4.3 Theme external store

The theme store has two different values: stored preference (`light | dark | system`) and resolved appearance
(`light | dark`). `system` is the default, and server snapshots use dark as the safe resolved fallback
(`web/src/lib/theme.ts:8-35`). The singleton initializes lazily, subscribes permanently to the OS media query,
and only emits an OS change when preference is `system` (`web/src/lib/theme.ts:66-98`).

```ts
export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const THEME_COLOR = {
  light: "#fafafa",
  dark: "#070707",
};
```

Source: `web/src/lib/theme.ts:13-22`.

`setThemePreference` updates the singleton, attempts persistence, applies the resolved document theme, and emits.
Blocked storage changes only durability; the choice remains effective for the process lifetime
(`web/src/lib/theme.ts:100-120`). `useTheme` exposes preference, resolved theme, and setter through
`useSyncExternalStore` (`web/src/lib/theme.ts:122-145`).

Native should use the system color-scheme subscription plus a tiny preference store. It does not need a generalized
state library for one three-value preference.

### 4.4 Notification-preference external store

Preferences are intentionally device-local rather than account data. A mute on one device does not mute another
device (`web/src/lib/notify-prefs.ts:5-17`). The complete value is:

```ts
export interface NotifyPrefs {
  toast: boolean;
  sound: boolean;
  system: boolean;
  haptics: boolean;
  onFinished: boolean;
  onAwaiting: boolean;
  onDied: boolean;
  mutedSessions: string[];
}

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = {
  toast: true,
  sound: false,
  system: false,
  haptics: false,
  onFinished: true,
  onAwaiting: true,
  onDied: true,
  mutedSessions: [],
};
```

Source: `web/src/lib/notify-prefs.ts:22-58`.

Deserialization normalizes every flag and de-duplicates/caps `mutedSessions` at 200. Corrupt or blocked storage
falls back to defaults (`web/src/lib/notify-prefs.ts:63-95`). The module owns one immutable snapshot plus a listener
set. All setters replace the snapshot, persist, then emit; muting also enforces the 200-entry bound
(`web/src/lib/notify-prefs.ts:98-176`).

### 4.5 Module-singleton UI coordinators

| Store | State and lifecycle | Persistence |
|---|---|---|
| Highlight store | One transient `sessionId`, consumed/cleared after navigation has focused that terminal; listeners observe changes (`web/src/lib/highlight-store.ts:5-40`). | None. |
| Settings-dialog store | `{open, initialTab, returnTab}`; tabs are account, appearance, notifications, hosts, agents, skills, templates, devices, trust. `returnTab` is a one-shot navigation continuation (`web/src/components/settings/settings-dialog-store.ts:5-72`). | None. |
| Profile-dialog store | Singleton boolean plus open/close/toggle subscription API (`web/src/components/profile/profile-dialog-store.ts:5-39`). | None. |
| Toast store | Up to five newest messages; identical kind/message/detail coalesce and refresh expiry. Info lasts 5s, errors 8s, alert toasts 7s; exit is 180ms (`web/src/components/ui/toast.tsx:7-60`; `web/src/components/ui/toast.tsx:62-167`). | None. |
| Confirm coordinator | At most one pending promise. Opening another confirm resolves the prior request false, and unmount/cancel also resolves it (`web/src/components/ui/confirm.tsx:14-109`). | None. |
| Pending workspace launch | One in-memory pending launch descriptor used to transfer just-created workspace/session context across navigation (`web/src/components/workspace/pending-launch.ts:1-20`). | None. |
| Verification requests | Module-level `Map<token, Promise>` prevents duplicate verification-email confirmations within this JS process (`web/src/app/verify-email/page.tsx:14-27`). | None. |
| AppShell remembered chrome | Module object `{collapsed, width}` seeds later AppShell remounts before storage effects run; component effects keep it and `localStorage` synchronized (`web/src/components/nav/AppShell.tsx:36-49`; `web/src/components/nav/AppShell.tsx:88-115`). | Mirrored to sidebar storage keys. |
| Legion disclosure memory | Module `{open}` prevents a closed-frame flash across the two sidebars/route remounts; the first mount seeds it from storage (`web/src/components/legion/LegionStrip.tsx:43-54`; `web/src/components/legion/LegionStrip.tsx:78-86`). | Mirrored to `spawn.sidebar.legionOpen`. |
| Archived disclosure memory | Module `{open}` has the same remount behavior; last-opened archived ID itself remains component state backed by storage (`web/src/components/nav/SidebarArchivedSection.tsx:33-46`; `web/src/components/nav/SidebarArchivedSection.tsx:95-119`). | Mirrored to archived storage keys. |
| Notification audio runtime | One lazily constructed/resumed `AudioContext`; created from the user gesture that enables sound, because browser autoplay policy would otherwise silence the first alert (`web/src/lib/notify-channels.ts:94-124`). | None. Native sound lifecycle replaces it. |
| Upload reconciliation runtime | `globalThis.__spawnUploadReconciliationRuntime` contains per-session memory records and storage-fault strings, preserving safety when session storage fails during remounts (`web/src/components/terminal/Terminal.tsx:127-153`). | Mirrored to session/history persistence where possible. |

These singleton coordinators survive route-component remounts but not a reload. That is intentional. In native they
may be small external stores or navigation services; they should not enter the query cache.

### 4.6 Realtime and direct-channel singletons

The alert WebSocket is process-wide, subscriber-driven, and long-lived across AppShell remounts. It uses exponential
backoff from 1s to 15s, an 80s watchdog, and a 15s no-listener linger before teardown
(`web/src/lib/alert-socket.ts:6-35`). It wakes immediately on visibility/online events and closes explicitly on
logout (`web/src/lib/alert-socket.ts:75-178`; `web/src/lib/alert-socket.ts:191-208`).

Alert display arbitration is a separate cross-tab mechanism: `BroadcastChannel("spawn.alerts.claim")` waits 60ms
for a competing claim, and claims expire after 30 seconds so one browser notification wins without suppressing the
event forever (`web/src/lib/alert-claim.ts:3-29`; `web/src/lib/alert-claim.ts:42-90`). This is not auth coordination.

`useHostControl` owns a `HostControlClient` per hook instance and closes it on cleanup; it is not a global client
registry (`web/src/hooks/useHostControl.ts:38-60`; `web/src/hooks/useHostControl.ts:76-89`). The client itself holds
ephemeral socket/request/listener state and rejects outstanding work on close
(`web/src/lib/hostControl.ts:248-282`; `web/src/lib/hostControl.ts:331-345`).

The file-preview subsystem is an in-memory cache, not durable data: object URLs, decoded previews, ref counts, and
pending loads live in Maps. Its global limits are 64 MiB and 32 entries, and it retains at most one active control
client per host (`web/src/lib/preview/preview-cache.ts:1-16`; `web/src/lib/preview/preview-cache.ts:49-50`;
`web/src/lib/preview/preview-cache.ts:98-100`; `web/src/lib/preview/preview-cache.ts:207-342`).

### 4.7 Local component state that must stay local

The active workspace tab is URL/local preference state plus server fallback, not global state. Dialog forms keep
draft values locally. Workspace-grid gesture state, pending order, save revision, and rollback snapshot are local to
the grid/editor. File-explorer expansion, selection, cursor pages, and mutation affordances are local. These are
view-instance concerns and should remain screen/component state in native.

Viewport handling writes CSS custom properties from `visualViewport`; it has no data context
(`web/src/lib/viewport.ts:5-13`; `web/src/lib/viewport.ts:49-81`). Native should replace this with safe-area and
keyboard-inset hooks, not port the CSS-variable store.

## 5. Derived and computed state

Derived values should remain pure functions whenever possible. The web application already provides a good split:
`sessions.ts`, `workspaces.ts`, `tabs.ts`, `grid.ts`, and `legion.ts` contain portable computation; screens compose
those functions with query results.

### 5.1 Session selectors

`web/src/lib/sessions.ts` centralizes human-facing session projection (`web/src/lib/sessions.ts:18-129`):

| Selector | Inputs | Output | Consumers/meaning |
|---|---|---|---|
| `sessionTitle` | session title, cwd, agent | Explicit title, otherwise cwd basename, otherwise agent/default label | Sidebar, terminal rows, session headers. |
| `sessionTitleDetail` | title/cwd | Supplemental path/detail only when useful | Tooltips and secondary text. |
| `sessionStatusLabel` | lifecycle status | Stable human label | Chips and accessible names. |
| `sessionActivityLabel` | activity + agent/status | Finished, awaiting input, working, idle, disconnected, etc. | Attention rows and connection summaries. |
| `sessionStatusTone` | status/activity | Semantic visual tone | Status dots/chips; native should map this to theme tokens. |
| `relativeTime` | timestamp and current time | Compact elapsed label | Sidebar/session metadata. |
| `sessionNeedsAttention` | status/activity | Boolean for awaiting/finished/dead states | Workspace attention counts and alert prioritization. |
| `shellFromCommand` | command string | Shell executable/category | Session type/logo fallback. |
| `runningAgent` | session agent/command | Agent identity inferred from command basename | Agent badges, Legion counts, terminal-row type. |

Do not duplicate these rules in each native list row. A terminal-row selector should expose at least:

```ts
type TerminalRow = {
  id: string;
  name: string;
  detail: string | null;
  kind: "agent" | "shell";
  agentId: string | null;
  shell: string | null;
  statusLabel: string;
  statusTone: string;
  needsAttention: boolean;
  hostId: string;
  lastActivityAt: string | null;
};
```

**RECOMMEND:** Create this projection once in `data/selectors/sessions.ts`; it directly supplies the required mobile
terminal list's type, name, logo key, and status.

### 5.2 Workspace selectors

Workspace helpers normalize the workspace label, compute the IDs/tile count, filter by case- and whitespace-
insensitive substring, identify archived records, count live sessions while excluding `exited`/`killed`, count
attention, and compute recency from newest `last_input_at` with `updated_at` fallback
(`web/src/lib/workspaces.ts:10-92`).

| Computation | Inputs → output | Used for |
|---|---|---|
| Display name | workspace metadata → stable visible label | Sidebar/header. |
| Session/tile IDs | layout plus session data → unique IDs/count | Capacity and empty-state decisions. |
| Search predicate | workspace + query → boolean | Workspace filtering. |
| Live count | workspace sessions → number excluding exited/killed | Sidebar badge and summaries. |
| Attention count | workspace sessions → number | Dot/badge priority. |
| Tab attention | tab tiles + sessions → boolean/count, widgets excluded | Per-tab marker. |
| Recency | session timestamps, then workspace update → sortable timestamp | Recent ordering. |

The `/w/[id]` screen chooses an active tab from route preference/server state, then memoizes `workspaceSessions` by
matching session IDs represented in the workspace (`web/src/app/w/[id]/page.tsx:99-144`). In native, route params
should identify the workspace while active-tab choice should use the same fallback order and be a selector plus a
small preference.

### 5.3 Tab-layout algebra

Tabs are not a loose UI array. `web/src/lib/tabs.ts` defines the persisted schema and its legal transformations.
There may be at most eight tabs. Helpers choose active/all/home tabs and implement add, copy, duplicate, remove,
reorder, and cross-tab tile moves without mutating input (`web/src/lib/tabs.ts:14-42`;
`web/src/lib/tabs.ts:44-250`).

**RECOMMEND:** Port these functions without semantic changes and test them against shared fixtures. Both native tab
swipes and desktop drag/drop must produce server-compatible layouts.

### 5.4 Logical grid computation

The persisted grid is an integer coordinate space, independent of screen pixels:

- `GRID_COLS = 24`, `GRID_ROWS = 24`.
- Minimum tile extent is 4 logical cells.
- Maximum visible/placed tiles is 16.
- Validation enforces integer geometry, bounds, unique session IDs, and non-overlap.
- Ordering is deterministic reading order (row, then column) (`web/src/lib/grid.ts:1-33`).

Auto-placement scans legal rectangles, compaction removes gaps, move may swap, resize clamps/rejects collision, and
remove can grow neighbors into freed space (`web/src/lib/grid.ts:200-391`). These functions are server-state
transforms, not React layout.

The desktop renderer maps logical coordinates to percentages, computes divider hit targets and free rectangles, and
memoizes tile lookup/order (`web/src/components/workspace/workspace-grid.tsx:194-210`;
`web/src/components/workspace/workspace-grid.tsx:386-420`). At widths below 768 px the web helper repacks up to six
tiles as a stack (`web/src/components/workspace/workspace-grid.tsx:81-89`;
`web/src/components/workspace/workspace-grid-helpers.ts:618-660`). The owner explicitly rejects the web mobile UX,
so native should retain logical grid transforms only—not the stack presentation.

For the native product flow, each tab's terminal list is simpler derived state:

```ts
function terminalsForTab(workspace, tabId, sessionsById): TerminalRow[] {
  const tab = workspace.layout.tabs.find((candidate) => candidate.id === tabId);
  return (tab?.tiles ?? [])
    .filter((tile) => tile.type !== "files")
    .map((tile) => sessionsById[tile.session_id])
    .filter(Boolean)
    .map(selectTerminalRow);
}
```

The exact tile discriminator/property names must follow the exported API types; the key architectural point is to
derive this list from workspace layout plus canonical session entities, never keep another mutable list.

### 5.5 Sidebar and list ordering

The main sidebar derives a `sessionsById` map, online host IDs, and visible workspace ordering from query results;
position is primary and filtered presentation is computed afterward (`web/src/components/nav/Sidebar.tsx:82-99`).
The archived drawer shows the five most recent archived workspaces and separately preserves the last-opened item so
it does not disappear from the small list (`web/src/components/nav/SidebarArchivedSection.tsx:121-134`).

Hosts settings sorts online hosts before offline hosts and then by name (`web/src/components/settings/HostsPanel.tsx:23-34`).
Devices settings synthesizes the current local identity, puts the active current device first, sorts other active
devices newest-first, and separates revoked devices (`web/src/components/settings/DevicesPanel.tsx:201-217`).

These orders should be named selectors. Sorting query-cache arrays in place would corrupt shared data; all current
derived transforms use copied/memoized arrays.

### 5.6 Legion aggregate model

Legion is the densest computed view. Its types define five chart segments, four strip states, and a summary carrying
totals, hosts, live sessions, running agents, capacity, and activity buckets (`web/src/lib/legion.ts:14-59`).

Its core selector:

- filters live sessions;
- determines session tone/activity bucket;
- recognizes running agents;
- attaches sessions to hosts;
- computes used/free capacity;
- sorts sessions deterministically;
- sorts hosts online-first then by name;
- rolls host numbers into global totals (`web/src/lib/legion.ts:62-190`).

Bucket labels, color/tone mapping, and tooltip text are centralized rather than embedded in chart components
(`web/src/lib/legion.ts:231-317`). Profile activity calendar cells and intensities are also derived centrally
(`web/src/lib/legion.ts:320-370`; `web/src/components/profile/ProfileDialog.tsx:83-89`).

Host capacity is live operational state rather than a REST field. `useHostCapacity` polls the direct control channel
every second with a four-second timeout, forbids overlapping samples, and emits live/unavailable plus sample/spec
data (`web/src/hooks/useHostCapacity.ts:21-103`). Native should preserve that cadence only while the relevant host or
aggregate screen is foregrounded.

### 5.7 File-explorer and path derivation

The file explorer derives capabilities from control state, merges paginated directory results, flattens expanded
directories depth-first, selects files only for viewers, and computes action availability from selection and host
state (`web/src/components/files/FileExplorer.tsx:185-191`; `web/src/components/files/FileExplorer.tsx:222-342`).
Path normalization, parent/basename/join rules are pure and platform-aware (`web/src/lib/paths.ts:3-61`). Platform
display/detection is likewise centralized (`web/src/lib/platform.ts:9-61`).

`storage-diagnostics.ts` produces a report about IndexedDB/private-key persistence; `diagnostics.ts` performs direct
health probing. Neither is a durable store (`web/src/lib/storage-diagnostics.ts:12-27`;
`web/src/lib/diagnostics.ts:3-14`).

## 6. Client-side persistence inventory

### 6.1 Classification rule for native

Use `expo-secure-store` only for secrets or credential-equivalent private material. Use AsyncStorage for preferences
and non-secret security metadata. Keep React Query memory-only. Missing security evidence must fail closed or require
re-establishment; it must not silently mean “trusted.”

### 6.2 `localStorage` keys written by the application

| Literal key | Value shape | Missing/corrupt behavior | Native destination |
|---|---|---|---|
| `spawn.theme` | String union `"light" \| "dark" \| "system"` | Defaults to `system`; only the preference resets (`web/src/lib/theme-bootstrap.ts:12-25`; `web/src/lib/theme.ts:37-45`). | AsyncStorage. |
| `spawn.notify.prefs` | JSON `NotifyPrefs` shown above; muted IDs capped at 200 | Defaults are restored; notification choices/mutes are device-local and reset (`web/src/lib/notify-prefs.ts:20-58`; `web/src/lib/notify-prefs.ts:85-120`). | AsyncStorage. |
| `spawn.onboarding.skippedHost` | Literal `"true"` | Host setup may be shown again; no account/server data is lost (`web/src/components/onboarding/onboarding-flow.tsx:17`; `web/src/components/onboarding/onboarding-flow.tsx:59-64`; `web/src/components/onboarding/onboarding-flow.tsx:157-160`). | AsyncStorage. |
| `spawn.workspaces.last` | Workspace UUID string | `/app` falls back to the first available workspace instead of the last one (`web/src/app/app/page.tsx:88-93`; `web/src/app/app/page.tsx:199-205`). Workspace route updates it (`web/src/app/w/[id]/page.tsx:72-74`). | AsyncStorage, account-namespaced. |
| `spawn.workspace.tab.${workspaceId}` | Tab ID string | Workspace uses server active/default/first-tab fallback (`web/src/app/w/[id]/page.tsx:19`; `web/src/app/w/[id]/page.tsx:99-120`). | AsyncStorage, account/workspace-namespaced. |
| `spawn.sidebar.width` | Decimal number string | Sidebar returns to its default width (`web/src/components/nav/AppShell.tsx:88-115`). | AsyncStorage; native may omit if no resizable sidebar. |
| `spawn.sidebar.collapsed` | `"true"` or `"false"` | Sidebar returns to default expanded state (`web/src/components/nav/AppShell.tsx:88-115`). | AsyncStorage; retain only for tablet/sidebar UI. |
| `spawn.sidebar.legionOpen` | Boolean string | Legion disclosure returns to default (`web/src/components/legion/LegionStrip.tsx:43-54`; `web/src/components/legion/LegionStrip.tsx:78-86`). | AsyncStorage. |
| `spawn.sidebar.archivedOpen` | Boolean string | Archived disclosure returns to default (`web/src/components/nav/SidebarArchivedSection.tsx:33-46`; `web/src/components/nav/SidebarArchivedSection.tsx:100-141`). | AsyncStorage. |
| `spawn.sidebar.archivedLastOpened` | Workspace UUID | The “keep last opened visible” convenience is lost (`web/src/components/nav/SidebarArchivedSection.tsx:33-34`; `web/src/components/nav/SidebarArchivedSection.tsx:109-134`). | AsyncStorage, account-namespaced. |
| `spawn.folderPicker.showHidden` | Boolean string | Folder picker hides dotfiles again (`web/src/components/workspace/folder-picker.tsx:36`; `web/src/components/workspace/folder-picker.tsx:104-115`). | AsyncStorage. |
| `spawn.browser-device.revocation.v1.${userId}` | `${"cleanup_pending" \| "revoked"}:${publicKeyWire}` | Local cleanup/recovery state is forgotten. The public key is not a secret, but the state is security-relevant (`web/src/lib/browser-device-registration.ts:14-49`; `web/src/lib/browser-device-registration.ts:71-96`). | AsyncStorage, account-namespaced; clear only through the revocation workflow. |

The following developer flags are read but not written by product UI. They need not be migrated as customer state:

| Literal key | Meaning | Evidence |
|---|---|---|
| `spawnLatencyHud` | `"on"` enables terminal latency HUD | `web/src/components/terminal/latency-hud.ts:1-29`. |
| `spawnPredictEcho` | `"on"` enables predicted terminal echo | `web/src/components/terminal/Terminal.tsx:2736-2745`. |
| `spawnRenderer` | `"gpu" \| "dom"` forces renderer selection | `web/src/components/terminal/Terminal.tsx:3706-3721`. |

**RECOMMEND:** Namespace every native preference that contains an entity ID by account ID. The web can depend on a
hard page lifecycle and one cookie jar; a long-running native process can switch accounts without losing memory.

### 6.3 `sessionStorage` and history fallback

Each terminal session can have an upload uncertainty ledger under
`spawn.upload-reconciliation.v1:${sessionId}`. It retains at most eight records
(`web/src/components/terminal/Terminal.tsx:82-85`; `web/src/components/terminal/Terminal.tsx:127-138`).

```ts
type UploadReconciliation = {
  uploadId: string;
  fileName: string;
  message: string;
  recordedAt: number;
  phase: "reserved" | "blocked" | "outcome_unknown";
};
```

The app reads/writes/clears those JSON arrays and mirrors them into `history.state` under
`__spawnUploadReconciliationFallback` when session storage is unavailable
(`web/src/components/terminal/Terminal.tsx:3420-3437`;
`web/src/components/terminal/Terminal.tsx:3440-3517`). Missing this record matters: after an outcome-unknown upload,
the user could retry an operation whose server-side result is not known. That is an idempotency/safety warning, not
just UI history.

**RECOMMEND:** Put upload reconciliation in account/session-namespaced AsyncStorage and retain the eight-record cap.
It is not a secret, but it must survive process death until explicitly resolved.

### 6.4 IndexedDB databases

#### Browser device identity

Database `spawn-browser-device-identity`, version 1, store `device-identities`, key path `accountId`, maximum 32
accounts. The record is:

```ts
type StoredBrowserDeviceIdentity = {
  accountId: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyWire: string;
  version: 1;
};
```

Source: `web/src/lib/browser-device-identity.ts:17-36`; database/open/upgrade behavior is at
`web/src/lib/browser-device-identity.ts:135-174`.

If missing, a new device identity is generated and the device must be registered/trusted again. The private key is
secret and non-extractable in the browser representation.

**RECOMMEND:** Store the native private seed/key material in `expo-secure-store`; store public metadata in
AsyncStorage. Never serialize private material into the query cache or logs.

**UNKNOWN:** A browser `CryptoKey` cannot be copied to Expo. The crypto/protocol owner must approve the exact
Expo-Go-compatible Ed25519 implementation and private-key encoding. Resolve this by validating its signatures
against `proto/` vectors before implementation. A custom native keychain/crypto module would violate Expo Go.

#### Browser host pins

Database `spawn-browser-host-pins`, version 1, store `host-pins`, maximum 256 records. Persisted fields are
`accountId`, `approvedAtMs`, `createdAtMs`, `hostFingerprint`, `hostIds`, `hostPublicKey`, `origin`, `recordId`,
`revokedAtMs`, `state`, and `version` (`web/src/lib/browser-host-pins.ts:4-45`;
`web/src/lib/browser-host-pins.ts:250-283`).

Pins are public-key trust evidence, not secrets, but their absence changes security behavior: hosts must be paired
or verified again and downgrade/identity-change checks lose their local baseline.

**RECOMMEND:** Persist pins in AsyncStorage as a versioned account-keyed document. Treat malformed/missing state as
untrusted, not as permission to accept a new key.

#### Trust-bundle revision

Database `spawn-trust-bundle-revision`, version 1, store `revisions`; records are `{accountId, revision}`
(`web/src/lib/trust-revision.ts:14-16`; `web/src/lib/trust-revision.ts:44-62`). Missing it resets the local rollback
floor, so the next valid server bundle must establish a new baseline.

**RECOMMEND:** Store the revision in AsyncStorage, but validate monotonicity in the trust repository rather than UI.

#### Storage probe

`spawn-storage-probe` / `probe` is a scratch IndexedDB created, written, read, cleared, and deleted to diagnose
persistence (`web/src/lib/storage-diagnostics.ts:12-27`; `web/src/lib/storage-diagnostics.ts:37-64`;
`web/src/lib/storage-diagnostics.ts:67-119`). It is not user data. Native needs an equivalent diagnostic operation,
not a migrated value.

### 6.5 Cache Storage and Query persistence

The service worker cache is `spawn-v1`. It precaches only static shell assets and explicitly bypasses API and
WebSocket traffic (`web/public/sw.js:1-8`; `web/public/sw.js:38-72`). React Query is not persisted or hydrated; all
resource data is refetched after a hard load.

Native image/bundle caching is platform/runtime behavior. Do not translate `spawn-v1` into a data cache. Also do
not add a TanStack query persister initially: account-bound trust and session data should not silently reappear from
disk before auth identity is established.

### 6.6 Persistence destination summary

| Class | Native store | Examples |
|---|---|---|
| Secret/credential-equivalent | `expo-secure-store` | Auth bearer/refresh token if native auth uses them; device private seed/key material. |
| Plain preference | AsyncStorage | Theme, notify preferences, hidden files, sidebar/tablet disclosures, last workspace/tab. |
| Security-critical public metadata | AsyncStorage with versioning and fail-closed validation | Host pins, trust revision, revocation marker. |
| Operational reconciliation | AsyncStorage | Outcome-unknown upload records. |
| Server resource state | Memory-only TanStack Query | Hosts, sessions, workspaces, settings, trust server documents, files. |
| Runtime connection state | Context/module memory | Terminal pool, host control, alert socket, preview objects. |

## 7. Optimistic updates and reconciliation

### 7.1 Cache mutation conventions

The app uses three distinct strategies:

1. Server-first: wait for response, write returned object or invalidate.
2. Optimistic patch: mutate cached state immediately, then refresh/rollback on error.
3. Local transaction: update local/cache layout immediately, serialize saves, and roll back to an explicit snapshot.

The distinction matters. Most “fast” controls are actually server-first with a direct cache write; only a small set
uses true pre-response mutation.

### 7.2 Call-site matrix

| Surface/action | Ahead of server? | Cache operation and reconciliation |
|---|---:|---|
| Login/signup/reset/verify | No | Successful response writes `['me']`; navigation follows. Authentication mutations also invalidate as needed (`web/src/lib/auth.ts:20-54`). |
| Onboarding verification/host discovery | Partly | Polling writes `['me']`; discovered host is upserted in cached hosts rather than waiting for a list refetch (`web/src/components/onboarding/onboarding-flow.tsx:85-128`). |
| Sidebar workspace reorder | Yes | `onMutate` copies/sorts, removes and reinserts the moved workspace, and rewrites positions. Both success and error refresh canonical workspace data (`web/src/components/nav/Sidebar.tsx:126-149`). |
| Workspace create/rename/archive/delete | No | After server success, invalidates workspace/session/host families appropriate to the action (`web/src/components/nav/Sidebar.tsx:101-187`; `web/src/components/workspace/new-workspace-menu.tsx:60-78`). |
| Agent YOLO preference | Yes | `onMutate` patches the matching row in `['agents']`; error invalidates to restore server truth (`web/src/components/settings/AgentsPanel.tsx:63-78`). |
| Agent/skill/template CRUD | No | Success invalidates its list family (`web/src/components/settings/AgentsPanel.tsx:43-85`; `web/src/components/settings/SkillsPanel.tsx:40-63`; `web/src/components/settings/TemplatesPanel.tsx:37-62`). |
| Workspace tab edits | Yes | `onMutate` writes both detail and active list; server response overwrites both; error invalidates both (`web/src/components/workspace/workspace-tabs.tsx:202-221`). |
| Tab drag reorder | Yes/local | A local `droppedOrder` prevents a frame of snap-back while the mutation settles, then canonical cache/server state wins (`web/src/components/workspace/workspace-tabs.tsx:237-327`). |
| Duplicate tab | Mixed transaction | Creates copied sessions, cleans all newly created sessions if the layout write fails, then writes returned workspace and invalidates sessions (`web/src/components/workspace/workspace-tabs.tsx:616-672`). |
| Close tab | Mixed transaction | Deletes represented sessions first, patches layout, then invalidates sessions (`web/src/components/workspace/workspace-tabs.tsx:675-701`). |
| Tab home selection | No | Success writes detail/list workspace copies; error invalidates detail (`web/src/components/workspace/tab-home.tsx:48-60`). |
| Workspace icon autofill | No | Server success writes detail/list. Failure clears the attempted marker so a later opening may retry (`web/src/hooks/useWorkspaceIconAutoFill.ts:51-75`). |
| Grid placement/move/resize | Yes | Cache/layout commit is immediate; saves are serialized/debounced and revision-guarded, with an explicit rollback snapshot on failure (`web/src/components/workspace/workspace-grid.tsx:501-528`; `web/src/components/workspace/workspace-grid.tsx:607-655`). |
| Incoming workspace during grid save | N/A | Incoming query data is ignored while saving so stale refetch data cannot overwrite the local transaction (`web/src/components/workspace/workspace-grid.tsx:444-450`). |
| Duplicate pane | Mixed transaction | Create session first, attempt placement, delete it if no legal landing exists, then invalidate affected data (`web/src/components/workspace/workspace-grid.tsx:545-601`). |
| Discard pane | Mixed transaction | Delete session, commit tile removal, remove detail cache, invalidate session list (`web/src/components/workspace/workspace-grid.tsx:807-839`). |
| Convert session to files widget | Mixed transaction | Commit widget layout, then delete session. Session queries are invalidated even on partial failure (`web/src/components/workspace/workspace-grid.tsx:1463-1494`). |
| Move session between hosts | Mixed transaction | Create destination session, seed session-list cache, commit swap, then remove old session; invalidates after settlement (`web/src/components/workspace/workspace-grid.tsx:1497-1538`). |
| Rename/restart session | No | Success replaces detail and list entity; no speculative value (`web/src/components/workspace/session-pane.tsx:166-194`; `web/src/components/session/session-view.tsx:95-114`). |
| Foreground agent prediction | Yes | Immediately patches session detail and base list so the new agent badge appears; five-second list polling reconciles (`web/src/components/workspace/agent-switcher.tsx:83-105`; `web/src/components/workspace/agent-switcher.tsx:209-222`). |
| Remove session from workspace | Yes | Writes workspace detail/list before response; success writes returned detail and invalidates list; error invalidates workspaces rather than restoring a captured snapshot (`web/src/components/session/session-view.tsx:115-139`). |
| Browser-device revocation | Staged, server-first | Cache records `cleanup_pending`/`revoked` stages around server revoke and local-key cleanup; `browser-devices` is invalidated on settle (`web/src/components/settings/DevicesPanel.tsx:77-150`). |
| Trust ceremonies | No | Successful setup/unlock/backup/revoke/forget invalidates prefix `['trust']` (`web/src/components/settings/TrustPanel.tsx:132-139`; `web/src/components/settings/TrustPanel.tsx:158-170`; `web/src/components/settings/TrustPanel.tsx:224-229`; `web/src/components/settings/TrustPanel.tsx:266-271`). |
| File upload/mkdir/rename/delete | No query optimism | Mutation controls update local UI and invalidate only affected directory keys/prefixes after result (`web/src/components/files/FileExplorer.tsx:478-499`; `web/src/components/files/FileExplorer.tsx:563-652`). |
| Realtime alert | N/A | Alert handling invalidates sessions so activity/status counts converge with the control plane (`web/src/hooks/useSessionAlerts.tsx:89-111`). |

There are no production `cancelQueries` calls and ordinary `onMutate` handlers do not return snapshot contexts.
Therefore sidebar/agent/session optimistic paths reconcile by invalidation rather than precise rollback. The grid is
the exception: it maintains its own transaction snapshot/revision machinery.

### 7.3 Native mutation contract

**RECOMMEND:** Centralize cache fan-out in mutation modules. A screen should call `renameSession(input)`; it should
not know that both `['session', id]` and `['sessions']` require updates.

```ts
function writeSession(client: QueryClient, session: Session) {
  client.setQueryData(["session", session.id], session);
  client.setQueryData<Session[]>(["sessions"], (rows) =>
    rows?.map((row) => (row.id === session.id ? session : row)),
  );
}

function writeWorkspace(client: QueryClient, workspace: Workspace) {
  client.setQueryData(["workspace", workspace.id], workspace);
  client.setQueryData<Workspace[]>(["workspaces"], (rows) =>
    rows?.map((row) => (row.id === workspace.id ? workspace : row)),
  );
}
```

Because filtered session queries have sibling keys, either update every matching query through
`setQueriesData({queryKey: ['sessions']})` or invalidate the prefix. Updating only `['sessions']` leaves
`['sessions', {host_id}]` stale.

**RECOMMEND:** For small reversible toggles, capture and return a snapshot from `onMutate` and restore it on error.
For multi-resource grid/session transactions, port the explicit serialized transaction and compensating deletes;
generic optimistic callbacks are not sufficient.

## 8. Error, loading, and empty-state conventions

### 8.1 Error representation and retry policy

All REST failures become `ApiError(status, code, message, detail)`. The helper prefers the API's `message`, then a
string FastAPI `detail`, then HTTP status text. Schema failures remain Zod errors
(`web/src/lib/api.ts:18-28`; `web/src/lib/api.ts:45-65`). There is no global error-normalization hook beyond this.

Query retries are one attempt after the initial failure by default. `['me']` never retries; auth config explicitly
retries once; workspace detail and several security/local queries disable retry
(`web/src/lib/query.tsx:14-24`; `web/src/lib/auth.ts:12-46`;
`web/src/app/w/[id]/page.tsx:54-60`). There is no global 401 interceptor.

Mutation errors use one of three presentations:

- Toast for background/in-context workspace actions where layout must remain visible. The workspace root converts a
  child error string to `toast.error` (`web/src/app/w/[id]/page.tsx:39-44`).
- Inline `role="alert"` near forms/settings where the user must correct input; Agents is representative
  (`web/src/components/settings/AgentsPanel.tsx:116-125`).
- Dedicated full/large `EmptyState` for route-entry failures (`web/src/app/app/page.tsx:110-149`).

The toast host coalesces identical failures rather than producing one toast per polling interval, caps the live
stack at five, and leaves errors visible for eight seconds (`web/src/components/ui/toast.tsx:52-60`;
`web/src/components/ui/toast.tsx:75-115`). Toasts can include detail, icon, action callback, and accessible action
label (`web/src/components/ui/toast.tsx:23-50`).

**RECOMMEND:** Native mutation modules should return typed domain errors; screens choose inline versus toast based on
whether the user can act locally. Do not make a global interceptor toast every polling failure.

### 8.2 Loading strategy

The app does not use Suspense-enabled TanStack queries. Every data surface reads `isLoading`, `isPending`,
`isFetching`, and `error` manually. React `Suspense` wrappers exist for Next search-parameter/client boundaries,
usually with `null`, not for data hydration (`web/src/app/w/[id]/page.tsx:21-31`).

Loading presentation scales with the surface:

| Surface | Convention |
|---|---|
| Auth gate | Plain centered “Loading...” prevents protected content flash (`web/src/components/auth/AuthGate.tsx:7-28`). |
| `/app` resolution | Centered spinner “Opening your workspace” while auth/config/hosts/workspaces choose a destination (`web/src/app/app/page.tsx:110-130`; `web/src/app/app/page.tsx:217-222`). |
| Workspace detail | Centered spinner while no workspace object exists; once data exists it remains visible during refetch (`web/src/app/w/[id]/page.tsx:146-156`). |
| Host/session lists | Skeleton rows/cards preserve intended geometry (`web/src/app/hosts/[id]/page.tsx:341-394`). |
| Legion | Skeleton host cards while host data loads; headline says “Counting your machines…” (`web/src/app/legion/page.tsx:45-60`; `web/src/app/legion/page.tsx:100-105`). |
| Settings panels | Two or more fixed skeleton rows, then inline content (`web/src/components/settings/AgentsPanel.tsx:126-131`). |
| File tree | Uses `isPending` plus control readiness, because a disabled query is pending but not fetching; six skeleton rows avoid falsely displaying empty while the direct channel connects (`web/src/components/files/FileExplorer.tsx:963-966`; `web/src/components/files/FileExplorer.tsx:1062-1083`). |
| Session route transition | The only route-level `loading.tsx`: `AppShell` plus terminal spinner (`web/src/app/sessions/[id]/loading.tsx:10-17`). |

Buttons/forms disable from the relevant mutation's `isPending`, preventing duplicate submissions; editor dialogs
also keep the mutation error next to the draft (`web/src/components/settings/AgentsPanel.tsx:163-180`).

### 8.3 Empty states and retries

Empty is not conflated with loading or error:

- `/app` has distinct calls to action for no host, offline host, and no workspace
  (`web/src/app/app/page.tsx:152-210`).
- Legion has a dashed empty rack with “Possess a machine” (`web/src/app/legion/page.tsx:100-119`).
- Agents shows a dashed custom-agent invitation only after loading finishes
  (`web/src/components/settings/AgentsPanel.tsx:150-158`).
- File explorer says “Empty directory. Drop files here to upload” only when not busy and not errored
  (`web/src/components/files/FileExplorer.tsx:1084-1093`).

Retry affordance is local. `/app` explicitly refetches both host and workspace queries from one “Try again” button
(`web/src/app/app/page.tsx:132-148`). Signup/config and other forms expose their own refetch or resubmit affordance.
There is no application-wide “retry all” control.

### 8.4 Terminal connection failures

The terminal keeps rendered output on screen across a mid-session reconnect; the connection overlay only covers a
terminal that has never painted. It delays entry 240ms to avoid flash, marks a connection slow after eight seconds,
and distinguishes reaching, securing, secured, offline, dropped, and identity-blocked states
(`web/src/components/terminal/ConnectingOverlay.tsx:10-22`;
`web/src/components/terminal/ConnectingOverlay.tsx:127-136`).

Dropped connections say that spawn is retrying automatically; offline panes wait for the host; signed trust refusal
is a hard “Connection blocked” state with its reason rather than an automatic downgrade
(`web/src/components/terminal/ConnectingOverlay.tsx:62-102`). Uploads whose outcome is unknown are recorded for
reconciliation rather than blindly retried (`web/src/components/terminal/Terminal.tsx:3178-3195`).

**RECOMMEND:** Preserve the distinction between transient transport failure and cryptographic refusal. Native may
automatically redial the former; the latter requires an explicit trust recovery flow.

### 8.5 Boundaries that do not exist

There is no `error.tsx` or `not-found.tsx` under `web/src/app`; only the session `loading.tsx` exists. Therefore
unexpected render exceptions fall to Next's framework boundary, while expected request failures are rendered by
the owning page/component. Native should add a top-level crash boundary for recovery, but it should not replace the
local expected-error states described above.

## 9. Client auth session lifecycle

### 9.1 Web session storage and establishment

The web client is cookie-authenticated. Every API request sets `credentials: "include"`; comments explicitly identify
the session cookie as HTTP-only (`web/src/lib/api.ts:5-16`; `web/src/lib/api.ts:30-43`;
`web/src/lib/auth.ts:7-10`). No access token, refresh token, password, or session identifier is written to
`localStorage`, `sessionStorage`, IndexedDB, or the Query cache.

The authentication response nevertheless contains both fields:

```ts
const AuthResponseSchema = z.object({
  access_token: z.string(),
  user: UserSchema,
});
```

Source: `web/src/lib/api.ts:392-396`.

Login/signup/password-confirm callers use the returned user to seed `['me']`; the browser relies on the Set-Cookie
side effect for subsequent requests. The returned `access_token` is not retained by web application code. Public
OAuth buttons use full navigation to `/api/auth/oauth/:provider/start?return_to=...`, allowing the server/browser
cookie flow to complete (`web/src/components/onboarding/oauth-buttons.tsx:13-32`).

### 9.2 Current-user query and gates

`useAuth()` is the session observer:

```ts
useQuery<{ user: User } | null>({
  queryKey: ["me"],
  queryFn: async () => {
    try { return await auth.me(); }
    catch (err) {
      if (err instanceof ApiError && err.status === 401) return null;
      throw err;
    }
  },
  retry: false,
  staleTime: 30_000,
});
```

Source: `web/src/lib/auth.ts:12-32`.

Only `/api/me` converts 401 into anonymous state. A 401 from any other API remains an `ApiError` for that query or
mutation; there is no automatic logout, token refresh, global redirect, or query-cache wipe.

`AuthGate` redirects resolved anonymous state to `/login` and renders no protected children while loading or after
the anonymous result (`web/src/components/auth/AuthGate.tsx:7-28`). Verification and onboarding are not AuthGate
responsibilities; `/app` and the onboarding state machine enforce those separately
(`web/src/app/app/page.tsx:57-85`; `web/src/components/onboarding/step-machine.ts:12-35`). Admin layout checks
`user.is_admin` for presentation, while APIs remain authoritative (`web/src/app/admin/layout.tsx:8-14`;
`web/src/app/admin/layout.tsx:23-48`).

### 9.3 Refresh, expiry, and focus

There is no client refresh endpoint call, refresh timer, Axios interceptor, or fetch wrapper retry. Cookie renewal or
expiry is entirely a server/browser concern. `['me']` is fresh for 30 seconds, and the global QueryClient disables
focus refetch; thus an already-mounted tab does not necessarily discover a remotely ended session at the instant it
regains focus (`web/src/lib/auth.ts:12-25`; `web/src/lib/query.tsx:16-24`). A protected route remount or explicit
refetch discovers it.

**UNKNOWN:** R03 must establish the native transport contract: whether Expo should send the returned
`access_token` as a bearer credential, maintain cookies, and whether any refresh mechanism exists server-side. This
report intentionally does not infer an endpoint that the web client never calls.

### 9.4 Logout fan-out

Logout performs three actions in order:

1. Close the process-wide alert socket.
2. Attempt `POST /api/auth/logout`, but swallow failure so an already-dead session cannot strand the user.
3. Hard navigate to `/`, tearing down the JS application and its in-memory QueryClient/terminal pool
   (`web/src/lib/auth.ts:56-72`).

The hard navigation is the web cache-clear mechanism. There is no explicit `queryClient.clear()` because the entire
document goes away. Persistent theme, device identity, host pins, trust revision, and device preferences survive
logout; they are device-scoped and/or account-keyed.

**RECOMMEND:** Native logout must perform the teardown the browser receives for free: stop alert/control/terminal
transports, cancel and clear QueryClient state, remove auth secrets, clear account-scoped ephemeral stores, reset the
navigation tree, and leave non-secret device preferences intact.

### 9.5 Multi-tab coordination

There is no `BroadcastChannel`, storage event, or service worker message for login/logout. Another tab discovers
auth change only on its next `['me']` fetch. The alert-claim BroadcastChannel coordinates notification display, not
identity (`web/src/lib/alert-claim.ts:3-29`). Browser-device revocation does listen to its localStorage marker and
invalidates the registration query cross-tab (`web/src/lib/browser-device-registration.ts:174-194`).

Native has one foreground process, but multiple windows/scenes can still exist on tablets. An account-session
boundary should be the sole owner of login/logout teardown so all navigation surfaces observe the same identity.

## 10. Native architecture translation

### 10.1 Proposed dependency choices

Versions below were checked against the npm registry on 2026-08-22. With Expo, install through
`npx expo install` so the generated project's SDK-compatible version wins if it differs from the registry latest.

| Package | Verified current version | Role | Expo Go |
|---|---:|---|---|
| `@tanstack/react-query` | `5.101.4` | Remote cache, polling, mutation state, invalidation | Yes; pure JS. TanStack documents React Native focus/online integration at <https://tanstack.com/query/latest/docs/framework/react/react-native>. |
| `expo-secure-store` | `57.0.1` | Credentials and private device-key material | Yes, listed as included in Expo Go: <https://docs.expo.dev/versions/latest/sdk/securestore/>. |
| `@react-native-async-storage/async-storage` | `3.1.1` | Plain preferences, pins/revisions, upload reconciliation | Yes, listed as included in Expo Go: <https://docs.expo.dev/versions/latest/sdk/async-storage/>. |
| `@react-native-community/netinfo` | `12.0.1` | Feed TanStack `onlineManager` and reconnect transports | Yes, listed as included in Expo Go: <https://docs.expo.dev/versions/latest/sdk/netinfo/>. |

`@tanstack/query-async-storage-persister` is currently `5.101.4`, but it is not recommended for the initial app.
Persisting all queries introduces account-bound stale data and trust ordering problems without satisfying offline
terminal use.

**RECOMMEND:** Use the four packages above, but keep the query cache memory-only. This matches the web architecture
and every package used for persistence/connectivity is Expo-Go-compatible.

**UNKNOWN:** Passkey/WebAuthn management and non-extractable browser `CryptoKey` behavior cannot be assumed in Expo
Go. The security implementation plan must name an Expo-Go-compatible ceremony or expose the unsupported operation
explicitly; it must not silently downgrade trust validation. A custom native WebAuthn/crypto module conflicts with
the hard Expo Go requirement.

### 10.2 Module boundaries

Use ordinary files and functions; no repository pattern, event bus, normalized entity framework, or generated query
DSL is necessary.

```text
mobile/src/data/
├── client.ts                    QueryClient and RN lifecycle wiring
├── queryKeys.ts                 the only literal key registry
├── api/
│   ├── http.ts                  typed request + ApiError
│   ├── authTransport.ts         credential attachment/teardown
│   └── types.ts                 native/shared API types
├── queries/
│   ├── auth.ts                  me, auth-config
│   ├── hosts.ts                 hosts, host, agents/capacity inputs
│   ├── sessions.ts              session lists/details
│   ├── workspaces.ts            active/archive/detail/templates
│   ├── settings.ts              agents, skills, profile, devices, admin
│   ├── trust.ts                 bundle/passkeys/local trust projections
│   └── files.ts                 host-control-backed directory queries
├── mutations/
│   ├── auth.ts
│   ├── hosts.ts
│   ├── sessions.ts
│   ├── workspaces.ts
│   ├── settings.ts
│   ├── trust.ts
│   └── files.ts
├── selectors/
│   ├── sessions.ts
│   ├── workspaces.ts
│   ├── terminalRows.ts
│   ├── tabs.ts
│   ├── grid.ts
│   ├── legion.ts
│   └── files.ts
├── realtime/
│   ├── alerts.ts                account alert socket + invalidation
│   ├── hostControl.ts           scoped direct-channel clients
│   ├── sessionTransport.ts      signaling/WebRTC runtime
│   ├── terminalPool.tsx         warm runtime ownership/LRU
│   └── lifecycle.ts             foreground/network/account teardown
└── storage/
    ├── secure.ts                auth/private keys only
    ├── preferences.ts           theme/notify/navigation preferences
    ├── trust.ts                 pins/revision/revocation metadata
    └── uploadReconciliation.ts  bounded uncertain-outcome ledger
```

Screens import query/mutation hooks and selectors. They do not import raw endpoint helpers or construct key arrays.
Realtime modules may invalidate through the shared QueryClient, but terminal byte streams never become query data.
Navigation owns overlay presentation, swipe dismissal, selected tab gesture state, and route history; it does not own
canonical hosts/sessions/workspaces.

### 10.3 Exact query-key registry to ship

This registry preserves the web key arrays exactly, including prefix semantics. Parameter objects must be stable,
JSON-equivalent values rather than mutable instances.

```ts
export const qk = {
  me: ["me"] as const,
  authConfig: ["auth-config"] as const,

  hosts: ["hosts"] as const,
  host: (hostId: string) => ["host", hostId] as const,
  hostAgents: (hostId: string) => ["host-agents", hostId] as const,

  sessions: ["sessions"] as const,
  sessionsForHost: (hostId: string) =>
    ["sessions", { host_id: hostId }] as const,
  session: (sessionId: string) => ["session", sessionId] as const,

  workspaces: ["workspaces"] as const,
  archivedWorkspaces: ["workspaces", "archived"] as const,
  workspace: (workspaceId: string) => ["workspace", workspaceId] as const,
  workspaceTemplates: ["workspace-templates"] as const,
  workspaceIconSuggestions: (hostId: string, cwd: string) =>
    ["workspace-icon-suggestions", hostId, cwd] as const,

  agents: ["agents"] as const,
  skills: ["skills"] as const,
  profile: ["profile"] as const,

  adminMail: ["admin", "mail"] as const,
  adminEmails: ["admin", "emails"] as const,
  adminUsers: ["admin", "users"] as const,
  adminInvites: ["admin", "invites"] as const,

  browserDeviceRegistration: (userId: string) =>
    ["browser-device-registration", userId] as const,
  browserDevices: ["browser-devices"] as const,
  browserDeviceLocalIdentity: (userId: string) =>
    ["browser-device-local-identity", userId] as const,
  browserDeviceFingerprints: (publicKeysCsv: string) =>
    ["browser-device-fingerprints", publicKeysCsv] as const,

  trust: ["trust"] as const,
  trustBundle: ["trust", "bundle"] as const,
  trustPasskeys: ["trust", "passkeys"] as const,
  trustStorageProbe: (accountId: string) =>
    ["trust", "storage-probe", accountId] as const,
  trustLocalPins: (accountId: string) =>
    ["trust", "local-pins", accountId] as const,
  trustHosts: ["trust", "hosts"] as const,
  trustHostPinMap: (hostIdsCsv: string) =>
    ["trust", "host-pin-map", hostIdsCsv] as const,
  trustIntroductions: (accountId: string, deviceId: string) =>
    ["trust", "introductions", accountId, deviceId] as const,

  hostFiles: (hostId: string, path = "") =>
    ["host-files", hostId, path] as const,
  hostFilesPage: (hostId: string, path: string, cursor: string) =>
    ["host-files", hostId, path, "page", cursor] as const,
  hostHome: (hostId: string) => ["host-home", hostId] as const,
  hostFolders: (hostId: string, path: string) =>
    ["host-folders", hostId, path] as const,
} as const;
```

Do not “improve” these into a different nested hierarchy during the first port. Mutation behavior relies on prefix
matching: `qk.workspaces` reaches active and archived lists; `qk.trust` reaches every trust query; `['host-files',
hostId]` reaches root, expanded directories, and cursor pages.

### 10.4 QueryClient and app lifecycle

Start with the web defaults:

```ts
new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});
```

Source behavior: `web/src/lib/query.tsx:13-25`.

Wire React Native `AppState` to TanStack `focusManager`; wire NetInfo to `onlineManager`. Preserve per-query polling
intervals from the registry table, but allow TanStack to pause ordinary polling while backgrounded. The alert
transport is different: it must reconnect deliberately on foreground/network recovery, matching the web socket's
visibility/online wake behavior (`web/src/lib/alert-socket.ts:140-161`).

The provider order should be conceptually:

```text
QueryClientProvider
└── AccountSessionBoundary
    └── TerminalPoolProvider
        └── NavigationContainer
            └── screens and native overlay routes
```

The account boundary prevents one authenticated user's cache/runtime from leaking into another. On identity change,
teardown realtime clients before clearing queries. Theme and plain device preferences can live outside that account
boundary.

### 10.5 Query and mutation rules

- Query modules own fetcher, key, `enabled`, stale/poll interval, retry, and projection. Screens supply IDs only.
- Mutation modules own every list/detail fan-out and invalidation. Screens receive `mutate`, pending, and typed error.
- Prefix invalidation is used deliberately for sibling parameterized queries.
- Exact writes are used only when a returned entity is authoritative and all relevant siblings are updated.
- File queries remain `gcTime: 0`; retaining direct-channel directory responses after the last observer risks using a
  result from a closed control client (`web/src/components/files/FileExplorer.tsx:185-235`).
- Workspace detail keeps `refetchOnWindowFocus: true`; the global default remains false
  (`web/src/app/w/[id]/page.tsx:54-60`).
- Sessions retain the five-second foreground poll until realtime events cover all status transitions
  (`web/src/app/w/[id]/page.tsx:66-70`).
- Trust probe/registration queries preserve `staleTime: Infinity` and explicit invalidation because rerunning them can
  generate/register identity state (`web/src/lib/browser-device-registration.ts:174-183`;
  `web/src/components/settings/TrustPanel.tsx:62-72`).

### 10.6 Store rules

Use a store only for mutable process state that cannot be represented as a server resource or navigation state:

| Native store | State | Lifetime |
|---|---|---|
| Account session | Auth identity, credential availability, teardown epoch | Login to logout/account switch. Canonical user remains `qk.me`. |
| Terminal pool | Runtime/transport handle, connection/display state, claim token, recency | Account session; max six warm by default. |
| Alert transport | Socket state, subscriber set, retry/watchdog | Account session; closes on logout. |
| Theme preference | preference + resolved system appearance | Device/process; persisted plain KV. |
| Notify preferences | normalized immutable snapshot | Device/process; persisted plain KV. |
| Toast/confirm coordinators | transient queue/one pending prompt | Process only. |

Do not store workspace arrays, session counts, active-agent badges, host ordering, capacity rollups, or tab terminal
rows here. Those are Query data plus selectors.

### 10.7 Selector contract for the core mobile flow

The screen graph can remain simple:

```text
qk.workspaces + qk.sessions
        │
        ├── selectWorkspaceRows(...) -> workspace list
        │
qk.workspace(id) + qk.sessions
        │
        ├── selectWorkspaceTabs(...) -> swipeable tab descriptors
        │
        └── selectTerminalRows(tabId, ...) -> type/name/logo/status rows
                                                   │
                                                   └── terminal overlay route(sessionId)
                                                        ├── qk.session(sessionId)
                                                        └── TerminalPool claim(sessionId)
```

Each selector should be a pure function with stable, testable ordering. Memoize at the hook boundary only when its
inputs are large or its output identity affects a virtualized list. Do not persist derived counts/rows; recompute
them from canonical snapshots.

### 10.8 Explicit decisions for the orchestrator

1. Adopt TanStack Query and the exact registry above; do not add Redux/Zustand for remote entities.
2. Keep query data memory-only in v1; persist only the inventory in Section 6.
3. Port session/workspace/tab/grid/Legion selectors before screens so every native surface shares the same rules.
4. Build an account-scoped realtime boundary and six-entry warm terminal pool; terminal bytes never enter React Query.
5. Make mutation modules responsible for cache fan-out and compensating actions.
6. Require the auth/security plans to resolve bearer-versus-cookie transport and Expo-Go-compatible device signing.
7. Treat passkey parity as an explicit Expo Go constraint decision; do not hide an unavailable or weakened flow.

That architecture is intentionally boring: one remote cache, a handful of purpose-specific runtime stores, pure
selectors, named durable keys, and navigation as the only owner of native overlay presentation.

## Appendix A. Complete cache-write and invalidation call-site ledger

This is the mechanical audit of every production `setQueryData`, `invalidateQueries`, `removeQueries`, and dynamic
registration-key invalidation under `web/src`. It complements the key-oriented table in §3 by grouping calls by
triggering surface. There are no production `setQueriesData` or `cancelQueries` calls.

| File / trigger | Exact cache effects |
|---|---|
| `web/src/lib/browser-device-registration.ts:185-194` — cross-tab revocation marker changes | Invalidates the dynamic `browserDeviceRegistrationQueryKey(userId)`. |
| `web/src/hooks/useWorkspaceIconAutoFill.ts:51-75` — automatic icon scan succeeds | Writes `['workspace', id]` and maps the saved workspace into exact active `['workspaces']`. |
| `web/src/hooks/useSessionAlerts.tsx:89-111` — accepted alert or suppression-related state change | Invalidates prefix `['sessions']` at both alert paths. |
| `web/src/app/admin/page.tsx:39-55` — send test email succeeds | Invalidates `['admin','emails']`. |
| `web/src/app/admin/page.tsx:250-282` — create or revoke invite succeeds | Each mutation invalidates `['admin','invites']`. |
| `web/src/app/w/[id]/page.tsx:76-92` — opened workspace becomes archived, or detail returns 404 | Each condition invalidates prefix `['workspaces']`; the 404 path then redirects. |
| `web/src/app/login/page.tsx:24-32` — login succeeds | Writes `{user}` to `['me']`, then invalidates `['me']`. |
| `web/src/components/onboarding/signup-form.tsx:31-43` — signup succeeds | Writes `{user}` to `['me']`, then invalidates `['me']`. |
| `web/src/app/reset-password/page.tsx:28-37` — password confirmation succeeds | Writes `{user}` to `['me']`, then invalidates `['me']`. |
| `web/src/app/verify-email/page.tsx:49-55` — email confirmation succeeds | Writes `{user}` to `['me']`, then invalidates `['me']`. |
| `web/src/components/onboarding/onboarding-flow.tsx:127-153` — verification poll or host becomes online | Verification writes the returned `['me']`; online callback upserts a `Host` into exact `['hosts']`. |
| `web/src/components/onboarding/onboarding-flow.tsx:292-304` — account step succeeds | Writes the returned user to `['me']`. |
| `web/src/app/hosts/[id]/page.tsx:89-95` — host rename succeeds | Invalidates `['host', id]` and `['hosts']`. |
| `web/src/app/hosts/[id]/page.tsx:139-147` — host removal/trust cleanup succeeds | Invalidates `['hosts']` and prefix `['sessions']`. |
| `web/src/components/hosts/connect-host.tsx:275-294` — pairing sees a newly online host | Invalidates `['hosts']`. |
| `web/src/components/hosts/HostAgentsPanel.tsx:37-49` — install agent or change host-agent policy | Each success invalidates `['host-agents', host.id]`. |
| `web/src/components/settings/HostsPanel.tsx:36-51` — host rename/remove | Rename invalidates `['hosts']`; remove invalidates `['hosts']` and `['sessions']`. |
| `web/src/components/settings/HostsPanel.tsx:103-113` — embedded connector reports host online | Invalidates `['hosts']`. |
| `web/src/components/session/session-view.tsx:44-51` — shared successful session write helper | Writes `['session', id]`, then maps replacement into exact `['sessions']`. Used by rename and restart. |
| `web/src/components/session/session-view.tsx:89-110` — session 404, rename success, restart success | Each invalidates prefix `['sessions']`; success first calls the write helper. |
| `web/src/components/session/session-view.tsx:115-139` — remove session from workspace | `onMutate` writes optimistic `['workspace', id]` and exact `['workspaces']`; success writes canonical detail then invalidates `['workspaces']`; error also invalidates `['workspaces']`. |
| `web/src/components/session/session-view.tsx:140-159` — close session succeeds | Removes `['session', id]`, invalidates `['sessions']` and `['workspaces']`, then navigates. |
| `web/src/components/workspace/session-pane.tsx:65-72` — shared pane session write helper | Writes `['session', id]` and maps replacement into exact `['sessions']`. |
| `web/src/components/workspace/session-pane.tsx:166-194` — pane rename/restart/close succeeds | Rename/restart call the helper and invalidate `['sessions']`; close removes `['session', id]`, invalidates `['sessions']`, then requests layout removal. |
| `web/src/components/workspace/agent-switcher.tsx:209-222` — user launches agent | Optimistically patches `foreground_command` in `['session', id]` and exact `['sessions']`; normal session polling reconciles. |
| `web/src/components/workspace/new-workspace-menu.tsx:60-78` — create workspace succeeds | Invalidates `['workspaces']`, returned `['workspace', id]`, and `['sessions']`. |
| `web/src/components/workspace/new-session-menu.tsx:174-195` — create/add session succeeds or layout conflict occurs | Success invalidates `['workspaces']`, returned `['workspace', id]`, and `['sessions']`; failure invalidates the current workspace detail. |
| `web/src/components/workspace/launcher-fab.tsx:236-255` — launcher creates/adds session or layout conflict occurs | Same three success invalidations as new-session menu; conflict invalidates current workspace detail. |
| `web/src/components/workspace/workspace-tabs.tsx:202-220` — any ordinary tab/layout patch | `onMutate` and success write `['workspace', id]` plus exact `['workspaces']`; error invalidates detail and workspace-list prefix. |
| `web/src/components/workspace/workspace-tabs.tsx:616-701` — duplicate/close tab | Duplicate success writes both workspace caches and invalidates sessions. Close invalidates sessions after batch deletion, then invokes the ordinary patch mutation. |
| `web/src/components/workspace/workspace-tabs.tsx:719-741` — save template | Invalidates `['workspace-templates']`. |
| `web/src/components/workspace/workspace-tabs.tsx:751-770` — delete workspace | Invalidates `['workspaces']` and `['sessions']`, then navigates. |
| `web/src/components/workspace/workspace-tabs.tsx:796-819` — archive workspace | Invalidates `['workspaces']` and `['sessions']`, then navigates. |
| `web/src/components/workspace/tab-home.tsx:48-60` — change tab home | Success writes workspace detail and exact list; error invalidates detail. |
| `web/src/components/workspace/archived-banner.tsx:18-27` — restore workspace | Invalidates `['workspaces']`, singular prefix `['workspace']`, and `['sessions']`. |
| `web/src/components/nav/Sidebar.tsx:101-110` — common workspace refresh | Invalidates `['sessions']`, `['workspaces']`, singular prefix `['workspace']`, and `['hosts']`. Rename/archive/restore/delete call this refresh. |
| `web/src/components/nav/Sidebar.tsx:126-149` — reorder workspace | `onMutate` rewrites exact active `['workspaces']`; success/error both run the common refresh. |
| `web/src/components/workspace/workspace-grid.tsx:501-528` — commit logical layout | Writes `['workspace', id]` and maps it into exact `['workspaces']`; this is the central local transaction write. |
| `web/src/components/workspace/workspace-grid.tsx:545-601` — duplicate pane | After create/placement (or compensating delete), invalidates `['sessions']`. |
| `web/src/components/workspace/workspace-grid.tsx:807-839` — discard pane | Removes `['session', id]` and invalidates `['sessions']` after committing layout removal. |
| `web/src/components/workspace/workspace-grid.tsx:1463-1494` — convert pane to file widget | Invalidates `['sessions']` after layout/session operations, including partial failure. |
| `web/src/components/workspace/workspace-grid.tsx:1497-1538` — move session to another host | Seeds the newly created destination into exact `['sessions']`; after swap/removal it invalidates `['sessions']`. |
| `web/src/components/files/FileExplorer.tsx:478-499` — affected-directory refresh or global file refresh | Invalidates root, resolved-root, or specific directory exact prefixes; global refresh invalidates `['host-files', hostId]`. Upload/mkdir/rename/delete call these helpers (`web/src/components/files/FileExplorer.tsx:563-652`). |
| `web/src/components/settings/AgentsPanel.tsx:43-85` — agent CRUD or YOLO toggle | CRUD calls `invalidate ['agents']`; YOLO `onMutate` maps an optimistic row, and only error invalidates. |
| `web/src/components/settings/SkillsPanel.tsx:40-63` — create/update/delete skill | Each success invalidates `['skills']`. |
| `web/src/components/settings/TemplatesPanel.tsx:37-62` — rename/icon/delete template | Each success invalidates `['workspace-templates']`. |
| `web/src/components/settings/DevicesPanel.tsx:42-46` — browser registration becomes ready | Invalidates `['browser-devices']`. |
| `web/src/components/settings/DevicesPanel.tsx:77-115` — revoke device | Writes staged registration state; current-device cleanup writes local identity `null`; settlement invalidates devices. |
| `web/src/components/settings/DevicesPanel.tsx:117-150` — cleanup/start fresh | Writes local identity `null`; fresh start invalidates registration and local-identity keys. |
| `web/src/components/settings/DevicesPanel.tsx:169-194` — rename/prune device | Each success invalidates `['browser-devices']`. |
| `web/src/components/trust/device-endorsement.tsx:121-134` — endorse device | Invalidates prefix `['trust']`. |
| `web/src/components/settings/TrustPanel.tsx:124-139` — create trust setup | Invalidates prefix `['trust']`. |
| `web/src/components/settings/TrustPanel.tsx:152-170` — unlock trust | Invalidates prefix `['trust']`. |
| `web/src/components/settings/TrustPanel.tsx:180-190` — create backup | Invalidates prefix `['trust']`. |
| `web/src/components/settings/TrustPanel.tsx:216-229` — revoke trust/passkey operation | Invalidates prefix `['trust']`. |
| `web/src/components/settings/TrustPanel.tsx:258-271` — forget/reset local trust | Invalidates prefix `['trust']`. |

Direct `query.refetch()` calls are not cache-family writes: app-entry retry refetches hosts/workspaces,
introduction acceptance refetches its own introductions query, and icon suggestions expose a manual refetch
(`web/src/app/app/page.tsx:132-148`; `web/src/components/trust/introduction-panel.tsx:48-61`;
`web/src/components/workspace/workspace-icon-dialog.tsx:69-88`).
