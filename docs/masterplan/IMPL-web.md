# W — web implementation report

## 1. Files changed or added

- `web/CLAUDE.md`
- `web/next.config.ts`
- `web/src/app/hosts/[id]/page.tsx`
- `web/src/components/legion/LegionHostCard.tsx`
- `web/src/components/legion/LegionStrip.tsx`
- `web/src/components/release/HostUpdateDialog.tsx` (new)
- `web/src/components/release/ReleaseWatcher.tsx` (new)
- `web/src/components/terminal/useSessionSocket.ts`
- `web/src/components/ui/cascade-menu.tsx`
- `web/src/components/workspace/launcher-fab.tsx`
- `web/src/components/workspace/new-session-menu.tsx`
- `web/src/lib/alert-socket.ts`
- `web/src/lib/api.ts`
- `web/src/lib/hostControl.test.ts`
- `web/src/lib/hostControl.ts`
- `web/src/lib/legion.test.ts`
- `web/src/lib/query.tsx`
- `web/src/lib/release.test.ts` (new)
- `web/src/lib/release.ts` (new)
- `web/tests/e2e/app-mocks.ts`

## 2. Spec checklist

- [x] `next.config.ts` exposes `buildId()` as `NEXT_PUBLIC_SPAWN_BUILD_ID`.
- [x] Added tolerant `ReleaseSchema`, public/no-store `fetchRelease()`, `clientBuildId()`, and pure `webIsStale({clientBuildId, serverBuildId})`.
- [x] Added release tests covering sparse/null wire payloads, public fetch options, build-ID reading, stale comparison, and old/null host payload defaults.
- [x] Added one module-level ReleaseWatcher scheduler and mounted it in `AppProviders`.
- [x] ReleaseWatcher checks on mount, every five minutes, visible `visibilitychange`, `online`, and `spawn:client-stale`.
- [x] Soft stale UI uses the exact SPAWN D title/body, explicit Reload/Later controls, and a 30-minute `sessionStorage` snooze. It never auto-reloads.
- [x] Hard stale ignores snooze, has no Later control, counts down from 10 seconds, and reloads after a best-effort service-worker update.
- [x] Added `HostUpdateDialog` and `useHostUpdate(host)`, with available/updating/failed/unsupported/offline state copy and controls from the spec.
- [x] Host update POST uses `hosts.update(id)`, caches its returned update state, polls `hosts.get(id)` every two seconds while updating, stops on current/failed or at three minutes, and invalidates both `["hosts"]` and `["host", id]` on completion.
- [x] Install fallback command uses the live `window.location.origin` and includes a Copy control.
- [x] Host detail auto-opens the available/failed/unsupported dialog once per host per browser session and leaves dismissal under user control.
- [x] Host launch/open-files flows in `new-session-menu` and `launcher-fab` are guarded. A queued action resumes after a successful update or when the user explicitly dismisses/proceeds; Not now proceeds immediately.
- [x] Added small existing-primitive `Badge` treatments for `update available` and `updating` in host facts, new-session pickers/home choices, launcher FAB, sidebar legion rows, and full legion cards.
- [x] `HostSchema` now has tolerant/defaulted `daemon_tree` and `update`; old payloads become `{state:"unknown", latest_version:null, error:null, requested_at:null}`.
- [x] Added `hosts.update(id)` and `release.get()` API namespaces using the exact endpoints and response schemas.
- [x] `alert-socket.ts`, `hostControl.ts`, and `useSessionSocket.ts` dispatch `CustomEvent("spawn:client-stale", {detail:{hard:true}})` on close 4003 and do not reconnect.
- [x] Host control keeps protocol refusal separate from `signedRtcRefusal` via the terminal reason `protocol_required`; test verifies it is terminal and not a trust refusal.
- [x] E2E host fixtures include `daemon_tree` and current update state; the mock router also handles public release and host-update requests so mounted watcher/dialog code stays type-correct.
- [x] `web/CLAUDE.md` lists the new `components/release/` directory.
- [x] No Playwright run, as explicitly requested.

## 3. Verification

Final required verification:

```text
cd web && npm run lint && npx tsc --noEmit && npm_config_cache=/private/tmp/spawn-web-npm-cache npx --package=bun bunx bun test src
PASS (exit 0)

Biome: Checked 340 files; exit 0 (5 warnings and 1 info remain in untouched files).
TypeScript: exit 0.
Bun: 1063 pass, 0 fail, 4250 expect() calls across 68 files.
```

Additional checks:

```text
npm_config_cache=/private/tmp/spawn-web-npm-cache npx --package=bun bunx bun test src/lib/release.test.ts src/lib/hostControl.test.ts src/lib/legion.test.ts
PASS: 101 pass, 0 fail.

git diff --check -- web
PASS: no whitespace errors.
```

The first Bun invocation without an isolated npm cache failed before running tests because the machine's home npm cache is not writable:

```text
npm error code EPERM
npm error syscall open
npm error path /Users/charliesaxton/.npm/_cacache/tmp/***
npm error errno EPERM
npm error Your cache folder contains root-owned files
```

Re-running the required `npx --package=bun` form with `npm_config_cache=/private/tmp/spawn-web-npm-cache` fixed the environment issue and passed.

An intermediate TypeScript run exposed the new required Host output fields in the legion test fixture:

```text
src/lib/legion.test.ts(29,3): error TS2322: Type ... is not assignable to type ...
Types of property 'daemon_tree' are incompatible.
Type 'string | null | undefined' is not assignable to type 'string | null'.
```

The fixture was updated with a current host update object; subsequent TypeScript and full unit runs pass.

An intermediate Biome run also reported formatting/import/dependency errors in the newly touched files (`hosts/[id]/page.tsx`, `HostUpdateDialog.tsx`, `ReleaseWatcher.tsx`, `useSessionSocket.ts`, and `hostControl.ts`). The files were formatted and the hook dependency corrected; the final full Biome command exits 0.

## 4. Left undone

- Nothing from the web stream spec is left undone.
- Playwright was deliberately not run because the task explicitly says Chrome cannot launch in this sandbox. The E2E mocks were updated and are covered by the successful TypeScript check.

## 5. Notes for other streams

- The web client expects `POST /api/hosts/{id}/update` to return `{ "update": HostUpdateOut }` on both 200 and 202. All update fields may be absent/null on old payloads, but current server responses should provide the full object.
- `requested_at` should be an ISO timestamp whenever state is `updating`; web uses it to honor the shared three-minute poll ceiling across dialog reopenings.
- The public release response can be sparse/null without prompting. Web compares only `release.web.build_id` against `NEXT_PUBLIC_SPAWN_BUILD_ID`, and the development client ID `spawn` is always treated as non-stale.
- All browser sockets use the exact hard event name/detail: `spawn:client-stale`, `{hard:true}`. A 4003 close is terminal for that socket.
- Mobile should retain the exact visible host-update copy from the shared spec. The web strings are implemented literally, including the ellipsis in `Updating…` and the same install command shape.
