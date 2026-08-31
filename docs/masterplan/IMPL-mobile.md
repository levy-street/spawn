# Mobile implementation report

## 1. Files changed and added

Modified:

- mobile/CLAUDE.md
- mobile/app.config.ts
- mobile/src/components/hosts/__tests__/fixtures.ts
- mobile/src/components/hosts/__tests__/host-views.test.tsx
- mobile/src/components/hosts/__tests__/legion.test.tsx
- mobile/src/components/hosts/host-detail-screen.tsx
- mobile/src/components/hosts/host-facts.tsx
- mobile/src/components/hosts/host-list-item.tsx
- mobile/src/components/hosts/legion-host-card.tsx
- mobile/src/components/launcher/__tests__/fixtures.ts
- mobile/src/components/launcher/__tests__/launcher-sheet.test.tsx
- mobile/src/components/launcher/launcher-sheet.tsx
- mobile/src/components/terminal-ui/__tests__/terminal-overlay.test.tsx
- mobile/src/components/workspace-detail/__tests__/fixtures.ts
- mobile/src/components/workspace-detail/workspace-detail.tsx
- mobile/src/data/__tests__/queryKeys.test.ts
- mobile/src/data/api/__tests__/endpoints.test.ts
- mobile/src/data/api/__tests__/schemas.test.ts
- mobile/src/data/api/endpoints/hosts.ts
- mobile/src/data/api/schemas/hosts.ts
- mobile/src/data/queries/hosts.ts
- mobile/src/data/queryKeys.ts
- mobile/src/data/realtime/__tests__/socket.test.ts
- mobile/src/data/realtime/socket.ts
- mobile/src/data/selectors/__tests__/host.test.ts
- mobile/src/data/selectors/__tests__/session.test.ts
- mobile/src/data/selectors/__tests__/workspace.test.ts
- mobile/src/lib/__tests__/confirm-host-wiring.test.tsx
- mobile/src/lib/__tests__/providers.test.tsx
- mobile/src/lib/providers.tsx
- mobile/tests/factories.ts

Added:

- mobile/src/components/hosts/__tests__/host-update-dialog.test.tsx
- mobile/src/components/hosts/host-update-dialog.tsx
- mobile/src/components/hosts/host-update-status.tsx
- mobile/src/data/api/endpoints/release.ts
- mobile/src/data/api/schemas/release.ts
- mobile/src/data/queries/__tests__/hosts-update.test.tsx
- mobile/src/data/queries/release.ts
- mobile/src/lib/__tests__/release-watcher.test.tsx
- mobile/src/lib/__tests__/updates.test.ts
- mobile/src/lib/release-watcher.tsx
- mobile/src/lib/updates.ts
- mobile/tests/app-config.test.ts

## 2. Spec checklist

- [x] app.config.ts writes extra.mobileTree, preferring EXPO_PUBLIC_SPAWN_MOBILE_TREE and otherwise running guarded git rev-parse HEAD:mobile.
- [x] Added the tolerant public release Zod schema, unauthenticated getRelease(), useRelease(), and qk.release().
- [x] Added the small expo-updates adapter. It disables OTA work in __DEV__/Expo Go, exposes the Expo runtime with app-version fallback, and reads Constants.expoConfig.extra.mobileTree.
- [x] Added and unit-tested pure decideMobileUpdate(...) returning none | check-ota | store, including unknown/dirty soft identities, runtime mismatch, and hard protocol refusal.
- [x] Added ReleaseWatcher under ToastProvider and KeyboardProvider in AppProviders; extended the asserted provider order.
- [x] Release checks run on mount, every 15 minutes, on foreground, and on protocol-required. Soft prompts snooze for 30 minutes.
- [x] OTA checks/fetches in the background and uses the exact restart dialog copy/buttons. Hard prompts omit Later.
- [x] Native-runtime mismatch uses the exact App Store dialog copy/buttons. No numeric App Store id exists in the repo, so the specified https://apps.apple.com/ fallback is used.
- [x] Hard 4003 with no available OTA falls back to the non-dismissible App Store prompt.
- [x] Added subscribeProtocolRequired(listener) in the shared reconnecting socket. A 4003 close emits the signal and retains permanent-close behavior.
- [x] Added daemon_tree and nullable/defaulted update to HostOutSchema; older server payloads normalize both to null.
- [x] Added updateHost(id) for POST /api/hosts/{id}/update and useUpdateHost(hostId) cache mutation.
- [x] Added two-second host-query polling while updating, capped at three minutes, with qk.hosts() and qk.host(id) invalidation when polling reaches a terminal state.
- [x] Added the shared host update dialog using ui/dialog and ui/button, with exact available/updating/failed/unsupported/offline copy, reinstall command derived from the active server origin, Copy, retry, and defer behavior.
- [x] Host detail auto-prompts at most once per host per app session.
- [x] Opening files from host detail or an existing workspace file pane is gated for outdated hosts; deferring resumes the selected action.
- [x] Launcher shell, agent, and file-explorer creation is gated for outdated hosts; Not now/Close resumes the exact pending launch.
- [x] Host rows and Legion cards show update available / updating badges; host Facts shows the matching chip. All styling uses theme tokens/primitives.
- [x] Added tests for config stamping, release/host schemas and endpoints, decisions/watcher, provider wiring, socket 4003, host update polling/cache mutation, dialog copy/actions, launcher gating, and badges/chips.
- [x] Updated mobile/CLAUDE.md to name release-watcher and updates under lib/.
- [x] No native dependency or config plugin was added; expo-updates was already installed.

## 3. Verification

Final passing commands:

- cd mobile && npm run typecheck — pass.
- cd mobile && npm run lint — pass, 677 files checked.
- Targeted Jest run across 14 affected suites — pass, 14 suites / 79 tests.
- cd mobile && npx jest --runInBand src/components/hosts/__tests__/screen-headers.test.tsx src/components/hosts/__tests__/host-update-dialog.test.tsx — pass, 2 suites / 6 tests.
- cd mobile && npm run ci — pass: typecheck, lint, 224 suites / 1,540 tests / 2 snapshots.
- Evaluated Expo config smoke with EXPO_PUBLIC_SPAWN_MOBILE_TREE=mobile-tree-smoke npx expo config --json — pass; extra.mobileTree was mobile-tree-smoke.
- git diff --check -- mobile — pass.

The full Jest run continues to print pre-existing Expo Go notification warnings, React act() warnings from unrelated suites, and the existing forced-worker-exit warning; it exits successfully.

Formative failures that were fixed:

1. The first typecheck exposed index-signature access and fixtures that needed normalized host fields:

~~~
app.config.ts(5,31): error TS4111: Property 'EXPO_PUBLIC_SPAWN_MOBILE_TREE' comes from an index signature, so it must be accessed with ['EXPO_PUBLIC_SPAWN_MOBILE_TREE'].
src/components/hosts/host-update-dialog.tsx(136,43): error TS18047: 'update' is possibly 'null'.
src/data/selectors/__tests__/session.test.ts(42,3): error TS2739: Type ... is missing the following properties ...: daemon_tree, update
src/lib/updates.ts(46,46): error TS4111: Property 'mobileTree' comes from an index signature, so it must be accessed with ['mobileTree'].
~~~

These were corrected with bracket access, nullable narrowing, and current/null host fixture defaults.

2. The first formatting/lint pass found two issues:

~~~
src/components/workspace-detail/workspace-detail.tsx:580:19 lint/style/noNonNullAssertion
  × Forbidden non-null assertion.

src/data/queries/hosts.ts:162:3 lint/correctness/useExhaustiveDependencies
  × This hook specifies more dependencies than necessary: host.id.
~~~

The workspace host is now narrowed before rendering, and the polling host-id ref makes the reset dependency meaningful.

3. The first full CI run had one affected legacy suite failure because that suite mocks the complete host-query module while an invisible dialog was mounted:

~~~
FAIL src/components/hosts/__tests__/screen-headers.test.tsx
  ● host screen headers › host detail renders its host name only in the shared title bar

    TypeError: (0 , _hosts.useHostUpdatePolling) is not a function

      30 | }: HostUpdateDialogProps): React.JSX.Element | null {
      31 |   const theme = useTheme();
    > 32 |   const polling = useHostUpdatePolling(host, visible);
~~~

The production host page now mounts HostUpdateDialog only when it is visible. The failed suite then passed alone, and the complete CI rerun passed all 224 suites.

## 4. Left undone

Nothing in mobile stream M is left undone.

## 5. Notes for other streams

- Server must return GET /api/release.mobile as {tree, runtime_version} and POST /api/hosts/{id}/update as {update: {state, latest_version, error, requested_at}}; mobile is tolerant of missing release/host fields for mixed-version rollout.
- The mobile host update UI consumes server-humanized HostOut.update.error verbatim inside the shared copy, so the server stream should keep those strings short and person-readable as specified.
- Mobile treats socket close 4003 as both permanent and an update trigger. No protocol frame parsing was added; the close code is the integration contract.
- The OTA release needs extra.mobileTree in the evaluated/served manifest, matching the release-script stream contract.
- The App Store path is intentionally native-only and should be called out in the orchestrator's commit message. The repo has no numeric App Store id, so mobile uses the specified generic Apple URL fallback.
- No mobile native build dependency/plugin change was made; this stream remains OTA-compatible.
