# R19 — Blocking bugs, gestures, and automated verification

**TL;DR**
1. The terminal failure is deterministic: every terminal transport asks `deviceIdentity` to sign, but normal authentication never selects the account, so `currentAccount()` throws `IDENTITY_ABSENT`.
2. Current source does contain five special-purpose `setDeviceIdentityAccount()` calls; the actual defect is the absence of one authoritative auth-lifecycle binding before protected runtime starts, plus zero calls to `clearDeviceIdentityAccount()`.
3. **RECOMMEND:** make `AuthGate` own account binding from `me.user.id`, block signing until binding is ready, and clear the binding/connections/account-scoped transient state on logout, 401, server change, and A→B account change.
4. The key is the canonical account UUID, not email, host, session, or browser-device ID; both the identity storage format and registration transcript bind that UUID.
5. Do not destroy A's identity on ordinary logout/switch; clear the in-memory selection, then select B. Reserve `deviceIdentity.reset()` and `onDeviceIdentityReset` for revoke/delete/fresh-start cleanup.
6. The unwired-hook audit found three real lifecycle holes: identity clear is unused, realtime generation registration is unused, and pending authenticated deep-link clear is unused; token expiry also deletes silently without notifying subscribers.
7. In current source, workspace header `+` opens the launcher unless pane placement is full, and `...` opens workspace actions; if both are inert, verify the physical device is running this bundle and inspect touch interception.
8. Tabs still have no close button and no drag-reorder recognizer: only tap-select, long-press action sheet, pager swipe, and discrete move-left/right actions exist.
9. The prior anywhere-dismiss fix covered only the loaded terminal `Modal`; default stack pages still use edge gestures, terminal loading/error states have gestures disabled, and the terminal pan competes with a native WebView plus nested long press.
10. Automated screenshot interaction is not runnable in this agent sandbox today: CoreSimulatorService is denied, Maestro/Appium are absent, and Java is 8; Maestro on an externally enabled simulator is the strongest future option, while real daemon/WebRTC, camera, and biometric proof remain manual.

## A. Terminal identity failure

### Proven failure path

The thrown text is exact, not a network diagnosis:

```ts
let activeAccountId: string | null = null;

export function setDeviceIdentityAccount(accountId: string): void {
  activeAccountId = parseCanonicalUuid(accountId);
}

export function clearDeviceIdentityAccount(): void {
  activeAccountId = null;
}

function currentAccount(): string {
  if (activeAccountId === null) {
    throw new DeviceIdentityError(
      "IDENTITY_ABSENT",
      "Device identity account must be selected before use",
    );
  }
  return activeAccountId;
}
```

`mobile/src/lib/crypto/identity.ts:39-40`, `mobile/src/lib/crypto/identity.ts:61-82`.

Opening a terminal immediately calls `deviceIdentity.ensure()` to obtain the browser public key and later `signSignalTranscript()` for worker signing requests (`mobile/src/terminal/transport/signed-signalling.ts:29-48`). Both pass through `currentAccount()` (`mobile/src/lib/crypto/identity.ts:212-229`). Therefore this exception occurs before a WebRTC connection can be authenticated; presenting it as generic “Connection failed” hides a local bootstrap bug.

One correction to the supplied premise matters for the fix review: **current** production source does call `setDeviceIdentityAccount()`, but only opportunistically inside trust/settings ceremonies:

| Production call | Account source | Why it does not fix normal terminal startup |
|---|---|---|
| Device registration | `input.accountId` before ensure/sign (`mobile/src/data/trust/registration.ts:42-54`) | Runs only when `ensureDeviceRegistered()` is invoked. |
| Host pairing approval | `ceremony.accountId` (`mobile/src/data/queries/pairing.ts:202-230`) | Runs only during pairing. |
| Device endorsement | `input.accountId` (`mobile/src/data/trust/endorsement.ts:94-105`) | Runs only during endorsement. |
| Device trust settings | selected account ID (`mobile/src/components/settings/device-trust-panel.tsx:45-53`) | Requires opening that settings UI. |
| Permanent account deletion | `user.id` immediately before reset (`mobile/src/components/settings/account-panel.tsx:47-60`) | Destructive cleanup, after the authenticated lifetime. |

There is no universal call on login/bootstrap, and `clearDeviceIdentityAccount()` has no production reference beyond its declaration. The shipped failure is therefore “never wired to the authentication lifecycle,” even though later patches have added isolated setters.

### Correct owner and ordering

The three candidate owners are not equivalent:

| Candidate | Evidence | Decision |
|---|---|---|
| Auth gate | It already reads the token, resolves `me`, waits for config/hosts, and chooses the authenticated destination (`mobile/src/lib/auth-gate.tsx:81-193`). | **RECOMMEND:** this is the only existing authority over signed-in versus signed-out/account-ready state. |
| Realtime provider | It mounts above the router/AuthGate and opens the alert socket unconditionally (`mobile/src/lib/providers.tsx:81-102`, `mobile/src/data/realtime/provider.tsx:61-151`). It has no `me` or account input. | Move/gate it under the authenticated-account boundary; do not make it discover identity independently. |
| Query layer | `useMeQuery()` is only a cache wrapper, and login/signup seed the cache directly (`mobile/src/data/queries/auth.ts:16-18`, `mobile/src/data/queries/auth.ts:28-64`). | Do not hide global security lifecycle side effects in a reusable query function. It may provide the resolved `me`, not own binding. |

**RECOMMEND:** add one `AuthenticatedAccountBoundary` as part of `AuthGate`, with an explicit state such as `{status: "ready", accountId}` only after `setDeviceIdentityAccount(me.user.id)` has completed. Every authenticated signing/transport consumer must be inactive until that state is ready. On no token, 401, logout, server change, or account transition, the boundary must synchronously retire authenticated transports, clear account-scoped transient state, call `clearDeviceIdentityAccount()`, and only then publish signed-out/loading or bind the next account.

A passive effect by itself is insufficient. `AuthGate` deliberately leaves `{children}` mounted underneath its loading overlay (`mobile/src/lib/auth-gate.tsx:288-303`), so a terminal child can mount and sign before an account-binding `useEffect` runs. Use one of these equivalent safe structures:

```ts
// Authority remains AuthGate; authenticated runtime is gated by accountReady.
const accountId = meQuery.data?.user.id ?? null;
const accountReady = reconcileAuthenticatedAccount(accountId); // clear A, bind B

return (
  <AuthAccountContext.Provider value={accountReady}>
    {children /* navigator may remain mounted */}
    {!accountReady.ready || !shouldRender ? <GateOverlay /> : null}
  </AuthAccountContext.Provider>
);

// Terminal/realtime open/connect conditions include accountReady.ready.
```

`reconcileAuthenticatedAccount` can be a small state machine/hook, but its ready transition must happen only after binding. The realtime provider should either move beneath this boundary or accept `enabled`/`accountId`, close the old alert client, call `retireAll()`, clear alert/connection stores, and create a new client on account change. Today it connects even before auth (`mobile/src/data/realtime/provider.tsx:71-76`, `mobile/src/data/realtime/provider.tsx:139-151`), while its URL builder requires a token (`mobile/src/data/api/socket-urls.ts:5-13`, `mobile/src/data/api/socket-urls.ts:24-25`).

Login/signup cache seeding means the boundary must react to the resolved `me.user.id`, not only a cold `GET /me` (`mobile/src/data/queries/auth.ts:45-64`). Explicit logout, deletion, and API 401 all ultimately clear the token (`mobile/src/data/api/endpoints/auth.ts:55-60`, `mobile/src/data/api/endpoints/account.ts:15-20`, `mobile/src/data/api/client.ts:122-130`); token subscription is the common trigger, but account cleanup belongs in the boundary rather than five UI call sites.

### Correct identifier and account switching

The identifier is `me.user.id`, schema-validated as a UUID (`mobile/src/data/api/schemas/auth.ts:6-12`, `mobile/src/data/api/schemas/auth.ts:22-26`). It is not `BrowserDeviceOut.id`, email, host ID, or a session ID.

This matches both designs carried forward by the implementation agents:

- The prior trust report defines a per-account record whose `accountId` is a canonical lowercase UUID and whose key is `spawn.identity.ed25519.v1.${accountId}` (`docs/native/research/05-trust-and-crypto.md:121-141`).
- Current native code canonicalizes the account into both identity and registration storage keys (`mobile/src/lib/crypto/identity.ts:53-59`) and rejects a stored record whose embedded account does not match (`mobile/src/lib/crypto/identity.ts:84-107`).
- Browser-device registration signs a transcript containing the account UUID (`docs/native/research/05-trust-and-crypto.md:166-189`), and native registration sets the same input account before signing (`mobile/src/data/trust/registration.ts:42-54`).

For switch A→B:

1. Stop/reject new signing and retire A's sockets/transports.
2. Clear `activeAccountId`; clear transient A caches, alerts, pending links, and connection state.
3. Resolve authenticated `me` for B; set `activeAccountId = canonical(B.id)`.
4. Let `deviceIdentity.ensure()` load/create only B's keyed record, then allow signing/realtime.

Do **not** call `deviceIdentity.reset()` for ordinary logout/switch. The trust design says ordinary logout preserves the SecureStore identity but clears in-memory authority (`docs/native/research/05-trust-and-crypto.md:145-152`). `reset()` deletes the active account's identity and registration marker, invokes cleanup subscribers for that account, then clears active state (`mobile/src/lib/crypto/identity.ts:282-297`). Its current `onDeviceIdentityReset` subscriber deletes that account's host pins (`mobile/src/data/trust/host-pins.ts:350-363`). That is correct for self-revoke, account deletion, and confirmed fresh start—not for merely viewing account B.

The identity remains Expo Go-compatible on SDK 54 without a new dependency: installed `expo-secure-store~15.0.8` (`mobile/package.json:33-50`) is the SDK 54 recommended version and explicitly “Included in Expo Go”; its iOS backing is Keychain and can survive reinstall ([Expo SDK 54 SecureStore](https://docs.expo.dev/versions/v54.0.0/sdk/securestore/)). The lifecycle change uses only existing React/Expo code.

### Unwired setup/registration audit — highest-value follow-on list

This audit searched production `mobile/src` call sites, excluding tests. It distinguishes a real lifecycle hole from an intentionally superseded helper.

| Export / lifecycle seam | Production references | Finding and required action |
|---|---:|---|
| `clearDeviceIdentityAccount()` | Declaration only (`mobile/src/lib/crypto/identity.ts:65-67`) | **BUG / P0:** wire through the auth-account boundary for logout, 401, server/account switch. Preserve the stored per-account key. |
| `registerRealtimeGenerationTarget()` | Declaration only (`mobile/src/data/realtime/lifecycle.ts:21-28`) | **BUG / P1:** `retireRegisteredGenerations()` and `reopenRegisteredGenerations()` are called on background/network recovery (`mobile/src/data/realtime/provider.tsx:123-143`), but the registry is always empty. Register visible terminal/host transport generations or remove this architecture and make the provider's explicit `reopenVisibleTransports` contract real. Existing surfaces have ad-hoc AppState reopen logic, so this is latent/duplicated rather than the identity failure. |
| `clearPendingAuthenticatedLink()` | Declaration only (`mobile/src/lib/linking.ts:240-252`) | **BUG / P1 account isolation:** a link remembered while signed out can survive abandonment and be consumed after a different account signs in (`mobile/src/app/_layout.tsx:51-68`). Clear on logout, account/server change, and rejected/finished auth. |
| Expired-token notification | Not an export; `get()` deletes expired storage then returns without `notifyTokenChanged()` (`mobile/src/data/api/auth-token.ts:68-73`) | **BUG / P1:** the recently added subscription works for `set()`/`clear()` (`mobile/src/data/api/auth-token.ts:77-113`) but not implicit expiry. Route expiry through the same clear-and-notify transition, exactly once. |
| Authenticated realtime lifetime | Provider has no auth/account dependency (`mobile/src/data/realtime/provider.tsx:61-76`) | **BUG / P1:** it starts an authenticated alert connection while signed out and does not hard-retire/recreate on token/account change. Put it below the boundary or give it an explicit account-enabled lifecycle. |
| `openAlertSocket()` | Declaration only (`mobile/src/data/realtime/alert-socket.ts:183-187`) | Not a shipped setup bug: `RealtimeProvider` directly constructs and connects `AlertSocketClient` (`mobile/src/data/realtime/provider.tsx:71-76`, `mobile/src/data/realtime/provider.tsx:139-149`). Delete the unused convenience export to stop false-positive audits. |
| `setEnabled()` haptics switch | Declaration only (`mobile/src/lib/haptics.ts:5-32`) | **UNKNOWN:** either an unfinished global preference wire or dead API. Current notification haptics setting is scoped separately; do not silently reinterpret it without a product decision. |
| `useShellHandoff()` | Declaration only (`mobile/src/components/launcher/use-shell-handoff.ts:11-42`) | Likely obsolete: terminal overlay now attaches pending-launch delivery directly (`mobile/src/components/terminal-ui/terminal-overlay.tsx:160-170`). Remove or document; not a bootstrap defect. |

Known-good registrations checked during the same hunt: `authToken.subscribe()` is wired in AuthGate (`mobile/src/lib/auth-gate.tsx:81-87`); URL subscription is wired at root (`mobile/src/app/_layout.tsx:60-63`); realtime lifecycle installation is wired (`mobile/src/data/realtime/provider.tsx:123-137`); pending launcher delivery is wired (`mobile/src/components/terminal-ui/terminal-overlay.tsx:160-170`); identity reset cleanup is wired in host pins (`mobile/src/data/trust/host-pins.ts:360-363`). Keep this table as a release-review checklist: every new exported `register*`, `subscribe*`, `set*Account`, `clear*`, or handler prop needs one production call-site assertion.

## B. Workspace controls: handler-to-effect audit

### Owner-reported header controls

The current tree does contain the prior fix:

```tsx
<IconButton
  accessibilityLabel="Add terminal or files"
  disabled={!canAddPane}
  onPress={onAddPane}
  testID="header-add-pane"
/>
<IconButton
  accessibilityLabel="Workspace actions"
  onPress={onActions}
  testID="workspace-actions-button"
/>
```

`mobile/src/components/workspace-detail/workspace-header.tsx:49-62`.

The parent supplies real callbacks: `...` sets `workspaceActionsVisible`; `+` sets `launcherTabId` for the active tab (`mobile/src/components/workspace-detail/workspace-detail.tsx:208-235`). `LauncherSheet` becomes visible and opens the created terminal after launch (`mobile/src/components/workspace-detail/workspace-detail.tsx:382-393`). The sole code-level reason for `+` to do nothing is its explicit disabled state when `canAddTile(activeTab.layout)` is false (`mobile/src/components/workspace-detail/workspace-detail.tsx:210-215`); the grid has a maximum of 16 and placement can also fail earlier for geometry (`mobile/src/data/layout/tiles.ts:11-13`, `mobile/src/data/layout/tiles.ts:172-182`). `...` is never disabled.

**RECOMMEND:** first verify the physical Expo Go screen contains both test IDs from this source revision (or reload Metro with cache clear); then inspect the React Native accessibility hierarchy/touch target. If `...` still does not set the sheet visible, there is a runtime/touch-layer failure. If only `+` is inert, surface “This tab is full” instead of a silent disabled icon. Add an integration test that presses the real `header-add-pane`, asserts launcher content, dismisses, presses `workspace-actions-button`, and asserts “Rename workspace” plus “Add tab”; current tests mainly substitute child components and prove prop presence (`mobile/src/components/workspace-detail/__tests__/workspace-actions.test.tsx:247-272`), not physical hit testing.

### Every interactive control in the assigned directories

“Effect” below means a state change, navigation, query/mutation, or user-visible sheet—not merely a non-null prop.

Paths abbreviated to a filename in this table are relative to `mobile/src/components/workspace-detail/` or `mobile/src/components/workspaces/`; every citation retains its exact source line.

| Surface/control | Handler present? | Actual current effect | Expected / defect |
|---|---|---|---|
| Workspace unavailable “Try again” | Yes (`workspace-detail-states.tsx:21-32`) | Refetches workspace (`workspace-detail.tsx:199-204`). | Works. |
| Header Back | Yes (`workspace-header.tsx:41-43`) | Calls route-provided `onBack` (`workspace-detail.tsx:216`). | Works; remove competing drawer header in the navigation batch. |
| Header `+` | Yes; conditionally disabled (`workspace-header.tsx:49-56`) | Opens launcher for active tab (`workspace-detail.tsx:211-215`, `workspace-detail.tsx:382-393`). | Works in source; silent when no tile fits. |
| Header `...` | Yes (`workspace-header.tsx:57-62`) | Opens workspace action sheet (`workspace-detail.tsx:212`, `workspace-detail.tsx:322-335`). | Works in source; physical inertness is not a missing callback. |
| Tab tap | Yes (`tab-strip.tsx:84-100`) | Selects tab (`workspace-detail.tsx:231-234`). | Works. |
| Tab long press | Yes (`tab-strip.tsx:89-92`) | Opens tab action sheet (`workspace-detail.tsx:224`, `workspace-detail.tsx:297-320`). | Works, but is not drag reorder. |
| Horizontal tab-page swipe | Yes (`workspace-detail.tsx:238-248`) | Pager changes selected tab (`workspace-detail.tsx:241-244`). | Works; must coexist with future tab dragging. |
| Tab-strip `+` | Yes; disabled at eight tabs (`tab-strip.tsx:132-139`, `data/layout/tabs.ts:11-25`) | Persists a new tab and selects it (`workspace-detail.tsx:225-230`). | Works; silent limit state. |
| Empty-pane “Add terminal or files” | Yes; conditionally disabled (`pane-list.tsx:104-113`) | Opens launcher (`workspace-detail.tsx:163-179`). | Works. |
| Pane-list footer Add | Yes; conditionally disabled (`pane-list.tsx:118-125`) | Opens launcher. | Works; owner is right that its current compact button is not full-width, but styling is outside R19. |
| Terminal row tap / accessibility activate | Yes (`terminal-row.tsx:79-98`) | Navigates to terminal via parent (`pane-list.tsx:76-82`). | Works once identity binding is fixed. |
| Terminal row long press / accessibility longpress | Yes (`terminal-row.tsx:86-98`) | Opens pane actions. | Works. |
| Terminal row swipe Move | Yes (`terminal-row.tsx:50-57`) | Opens destination-tab sheet. | Works. |
| Terminal row swipe Rename / Close | Yes (`terminal-row.tsx:59-75`) | Opens rename or destructive confirmation. | Works. |
| Files row tap / accessibility activate | Yes (`files-widget-row.tsx:73-88`) | Navigates to host files/path (`pane-list.tsx:57-64`). | Works. |
| Files row long press / accessibility longpress | Yes (`files-widget-row.tsx:73-88`) | Opens pane actions. | Works. |
| Files row swipe Move / Remove | Yes (`files-widget-row.tsx:41-62`) | Destination sheet / destructive confirmation. | Works. |
| Missing-session pane tap/long press | Yes (`pane-list.tsx:143-150`) | Opens pane actions so the orphan can be moved/removed. | Works. |
| Pane actions Rename | Yes (`action-sheets.tsx:57-63`) | Rename dialog then session mutation (`workspace-detail.tsx:262-264`, `workspace-detail.tsx:337-357`). | Works for terminal panes only. |
| Pane actions Move / destination tab | Yes (`action-sheets.tsx:65-80`, `action-sheets.tsx:143-161`) | Persists move (`workspace-detail.tsx:280-295`). | Works; invalid targets disabled. |
| Pane actions Duplicate | Yes (`action-sheets.tsx:74-80`) | Persists duplicated pane/session (`workspace-detail.tsx:254-259`). | Works; disabled when no fit. |
| Pane actions Move up/down | Yes (`action-sheets.tsx:81-99`) | Reorders pane locally/persistently through actions (`workspace-detail.tsx:265-268`). | Works; boundary items disabled. |
| Pane actions Restart | Yes (`action-sheets.tsx:101-108`) | Restarts session mutation (`workspace-detail.tsx:269-274`). | Works. |
| Pane actions Close/remove | Yes (`action-sheets.tsx:110-117`) | Confirmation then kill/remove (`workspace-detail.tsx:138-154`). | Works. |
| Tab actions Rename | Yes (`action-sheets.tsx:185-192`) | Rename dialog/mutation (`workspace-detail.tsx:313`, `workspace-detail.tsx:343-356`). | Works. |
| Tab actions Move left/right | Yes (`action-sheets.tsx:193-206`) | Discrete reorder (`workspace-detail.tsx:314-317`). | Works, but does not meet hold-drag requirement. |
| Tab actions Delete | Yes; disabled for last tab (`action-sheets.tsx:207-215`) | Confirmation then kills/removes tab (`workspace-detail.tsx:298-310`). | Works, but there is no visible tab `X`. |
| Workspace actions Rename / Add tab | Yes (`action-sheets.tsx:238-266`) | Rename dialog or creates tab (`workspace-detail.tsx:322-335`). | Works. |
| Rename dialog input submit / Save / Cancel | Yes (`rename-dialog.tsx:38-75`) | Validates and invokes workspace/tab/session operation (`workspace-detail.tsx:337-366`). | Works. |
| Destructive confirmation Confirm / Cancel | Yes (`workspace-detail.tsx:367-381`) | Executes stored remove/delete action or dismisses. | Works. |
| Launcher dismiss / successful launch / launch error | Yes (`workspace-detail.tsx:382-393`) | Closes, reports error, or opens new terminal. | Works in source. |
| Workspace-list New | Yes (`workspaces/workspace-list-screen.tsx:272-281`) | Opens full-mobile create dialog. | Works. |
| Workspace search field | Yes (`workspace-list-screen.tsx:283-285`) | Filters rows from local query state. | Works. |
| List/load error retry | Yes (`workspace-list-error.tsx:9-13`) | Refetches workspaces, archived, sessions, templates (`workspace-list-screen.tsx:233-246`, `workspace-list-screen.tsx:261-268`). | Works. |
| Session-status retry | Yes (`workspace-list-screen.tsx:286-297`) | Refetches sessions only. | Works. |
| Pull to refresh | Yes (`workspace-list-screen.tsx:299-317`) | Refetches all four resources with re-entry guard. | Works. |
| Empty-state New workspace | Yes (`workspace-list-empty.tsx:9-17`) | Opens create dialog (`workspace-list-screen.tsx:304-306`). | Works. |
| Archived workspaces link | Yes (`archived-workspaces-link.tsx:11-21`) | Pushes `/workspaces/archived` (`workspace-list-screen.tsx:307-311`). | Works. |
| Workspace row tap | Yes (`workspace-row.tsx:156-165`) | Opens `/workspace/[id]` (`workspace-list-screen.tsx:198-226`). | Works. |
| Workspace row long press / `...` | Yes (`workspace-row.tsx:161-165`, `workspace-row.tsx:208-238`) | Opens anchored menu. | Works. |
| Workspace row leading/trailing swipe | Yes (`workspace-row.tsx:124-147`) | Rename / archive-or-restore. | Works; suppressed while busy. |
| Workspace menu Rename / icon / duplicate / archive-or-restore / delete | Yes (`workspace-row.tsx:61-105`) | Opens dialogs or executes guarded mutations (`workspace-list-screen.tsx:180-226`). | Works. |
| Create dialog name submit / Cancel / Create | Yes (`create-workspace-dialog.tsx:72-102`, `create-workspace-dialog.tsx:111-132`) | Validates, creates from blank/template, then navigates (`workspace-list-screen.tsx:318-359`). | Works; button sizing/keyboard anchoring is another batch. |
| Create template selector | Yes (`create-workspace-dialog.tsx:123-130`) | Updates draft template ID. | Works. |
| Icon “Upload image” / “Use initials” | Yes (`workspace-icon-picker.tsx:21-31`, `workspace-icon-picker.tsx:51-58`) | Opens image picker or stores initials choice. | Works, subject to picker permission/result. |
| Rename workspace input submit / Cancel / Rename | Yes (`rename-workspace-dialog.tsx:33-80`) | Runs rename mutation (`workspace-list-screen.tsx:360-380`). | Works. |
| Change-icon picker / Cancel / Save | Yes (`change-workspace-icon-dialog.tsx:33-68`) | Runs icon mutation (`workspace-list-screen.tsx:381-400`). | Works. |

Missing controls are just as important: a tab renders one `Pressable` containing only its text (`mobile/src/components/workspace-detail/tab-strip.tsx:81-128`), so there is no `X`; it has no pan/drag gesture, so long-hold can only open actions. `dragProgress` belongs to pager indicator motion, not reordering (`mobile/src/components/workspace-detail/workspace-detail.tsx:220-248`). The data layer already has arbitrary-index `reorderTab()` (`mobile/src/data/layout/tabs.ts:72-85`), so a future drag UI can persist a computed target index without changing the layout model.

## C. Drag-to-close from anywhere

### Why the prior change fails in practice

The prior report was narrower and less verified than its title implied: it changed terminal-only files and explicitly recorded that a parent RNGH pan above `WKWebView` was **not** physically validated (`docs/native/reports/F-02.md:74-75`, `docs/native/reports/F-02.md:108-112`). Current code reveals four separate causes:

1. **Most pages never received the change.** Settings, host detail, admin, and archived workspaces use native stacks with no `fullScreenGestureEnabled`; therefore iOS uses its default edge-back recognizer (`mobile/src/app/(drawer)/settings/_layout.tsx:10-44`, `mobile/src/app/(drawer)/host/[id]/_layout.tsx:10-36`, `mobile/src/app/(drawer)/admin/_layout.tsx:26-53`, `mobile/src/app/(drawer)/workspaces/_layout.tsx:10-35`).
2. **The drawer itself is explicitly edge-only.** It enables a left drawer with `swipeEdgeWidth = spacing[5]`, and workspace detail remains a hidden drawer screen (`mobile/src/app/(drawer)/_layout.tsx:8-10`, `mobile/src/app/(drawer)/_layout.tsx:17-54`). That gesture opens a menu; it cannot provide page-wide back dismissal. Removing the drawer is prerequisite navigation cleanup.
3. **Terminal route options are overridden off.** Root declares a full-screen vertical native card (`mobile/src/app/_layout.tsx:25-32`, `mobile/src/app/_layout.tsx:96`), but the terminal screen injects `animation: "none"` and `gestureEnabled: false` in every render (`mobile/src/app/terminal/[sessionId].tsx:34-43`). Loading and error branches contain no custom dismiss recognizer at all (`mobile/src/app/terminal/[sessionId].tsx:45-92`).
4. **Only the loaded terminal has the custom pan, across a hostile native subtree.** `FullSurfaceDismiss` wraps the loaded terminal only (`mobile/src/components/terminal-ui/terminal-overlay.tsx:250-253`); its manual pan is attached to a parent view (`mobile/src/components/terminal-ui/full-surface-dismiss.tsx:49-76`, `mobile/src/components/terminal-ui/full-surface-dismiss.tsx:138-144`) while a nested long-press detector wraps `TerminalSurface`/WebView (`mobile/src/components/terminal-ui/terminal-overlay.tsx:239-245`, `mobile/src/components/terminal-ui/terminal-overlay.tsx:294-319`). On iOS RNGH creates `UIGestureRecognizer`s on the detector child, and competing recognizers cancel one another unless relations are defined ([RNGH internals](https://github.com/software-mansion/react-native-gesture-handler/blob/main/packages/docs-gesture-handler/docs/under-the-hood/how-does-it-work.md)). The source defines no `simultaneousWithExternalGesture`/failure relation or Native gesture for the WebView. **Inference:** the WebView/long-press hierarchy can win the touch stream before the manual parent activates. The owner's device report is the physical confirmation the previous report lacked.

The vertical `SwipeDismissOverlay` is not “anywhere”: terminal passes `dragHandleRegion="header"` (`mobile/src/components/terminal-ui/terminal-overlay.tsx:251`), and its eligibility check restricts starts to that region (`mobile/src/components/ui/swipe-dismiss-overlay.tsx:135-148`). It is also a React Native `Modal` (`mobile/src/components/ui/swipe-dismiss-overlay.tsx:235-255`), isolating it from the native stack card beneath it.

### Concrete, uniform fix

**RECOMMEND:** use one native-stack horizontal full-screen back gesture for navigation pages; remove terminal's nested `Modal` and custom horizontal pan rather than stacking recognizers over a WebView. Set this on every card stack:

```tsx
const fullScreenBack = {
  presentation: "card",
  gestureEnabled: true,
  gestureDirection: "horizontal",
  fullScreenGestureEnabled: true,
} as const;

<Stack screenOptions={fullScreenBack}>…</Stack>
```

Remove the terminal screen's `gestureEnabled: false` override and render loaded/loading/error as ordinary route content. React Navigation documents that `fullScreenGestureEnabled` makes dismiss work on the whole screen, is iOS-only, and does not affect modal presentations ([native-stack options](https://reactnavigation.org/docs/native-stack-navigator/#fullscreengestureenabled)). This is Expo Go-compatible with nothing new: Expo Router, RNGH, Screens, and WebView are already installed (`mobile/package.json:49-68`), and SDK 54 lists the native third-party libraries it bundles in Expo Go ([Expo SDK 54 third-party libraries](https://docs.expo.dev/versions/v54.0.0/sdk/third-party-overview/)).

Coverage inventory and disposition:

| Page/surface | Current container | Required treatment |
|---|---|---|
| Terminal loaded, loading, unavailable/error | Root native stack plus loaded-only RN `Modal` | One native card with full-screen horizontal dismiss in all states; remove `SwipeDismissOverlay`/`FullSurfaceDismiss` from route content. Keep WebView selection long press internal. |
| Workspace detail | Hidden Drawer screen with its own custom header | Remove Drawer entirely; make detail a Stack card above workspace list with full-screen back. This also removes burger/edge drawer conflict. |
| Archived workspaces | Workspaces nested Stack | Apply common full-screen card options. |
| Host detail; host agents; host files | Host nested Stack | Apply common options to detail screens; root host list stays a root destination. |
| Settings account, appearance, notifications, hosts, agents, skills, templates, devices, trust, server, about | Settings nested Stack | Apply common options. Ensure auto-routes `server`/`about` receive the same options even though they are not explicitly declared in the current layout (`mobile/src/app/(drawer)/settings/_layout.tsx:34-43`). |
| Settings profile | `presentation: "modal"` (`mobile/src/app/(drawer)/settings/_layout.tsx:43`) | If left-to-right anywhere is mandatory, change to `card`; full-screen gesture is documented not to affect modal presentation. |
| Admin index→invites/users/emails | Admin nested Stack | Apply common options to pushed detail pages. |
| New workspace | `Dialog size="full-mobile"` (`mobile/src/components/workspaces/create-workspace-dialog.tsx:98-103`) | Convert this page-like full-screen RN `Modal` into a stack card; this also gives reliable keyboard avoidance/navigation semantics. |
| File viewer | `Dialog size="viewer"` (`mobile/src/components/files/file-viewer.tsx:166-174`) | Convert to a stack card route with full-screen back; retain explicit close/download/share controls. |
| Onboarding device/host drill-ins | Onboarding Stack routes (`mobile/src/app/onboarding/_layout.tsx:1`) | Apply common full-screen card gesture after the root onboarding choice. |
| Rename/name/icon/confirm dialogs | Small RN `Modal` dialogs | Keep modal semantics: scrim, Cancel/Done, accessibility escape. Do not install page-back pans inside text fields. |
| Launcher/action sheets/font sheet | Gorhom bottom sheets | Keep native vertical sheet pan/backdrop dismissal; these are transient sheets, not horizontal navigation pages. |
| Menus/popovers | RN modal popovers | Keep outside-tap and explicit Back rows; a horizontal page swipe would conflict with anchored selection. |

After implementation, test starts at 10%, 50%, and 90% screen width on every page-card. Verify horizontal lists/pager/WebView still scroll in the opposite direction and that a rightward drag commits back. Do not retain both the native full-screen recognizer and a JS/RNGH page dismiss recognizer.

## D. Automated verification pass

### What this machine can do today — verified, not assumed

Read-only probes on 2026-08-22 returned:

```text
$ xcodebuild -version
Xcode 26.6
Build version 17F113

$ sw_vers
ProductVersion: 26.2
BuildVersion: 25C56

$ java -version
java version "1.8.0_461"

$ command -v maestro; command -v appium
# no output: neither is installed
```

The critical preflight failed:

```text
$ xcrun simctl list devices available
CoreSimulatorService connection became invalid.
Error opening log file (.../Library/Logs/CoreSimulator/...): Operation not permitted
Unable to discover any Simulator runtimes.
Unable to locate device set ... Code=61 "Connection refused"
```

This is a managed-agent permission/service boundary, not evidence that Xcode lacks a runtime. **UNKNOWN:** installed simulator device/runtimes cannot be enumerated from this environment. Because even read-only `simctl list` cannot reach CoreSimulatorService, this agent cannot honestly claim it can boot, install, open, interact, or screenshot a simulator. No automated simulator pass has been run.

There is, however, a cached compatible binary at:

```text
/Users/charliesaxton/.expo/ios-simulator-app-cache/Expo-Go-54.0.7.tar.app
CFBundleIdentifier = host.exp.Exponent
CFBundleShortVersionString = 54.0.7
CFBundleSupportedPlatforms = (iPhoneSimulator)
CFBundleURLSchemes = (exp, exps, ...)
MinimumOSVersion = 15.1
```

Expo's current documentation says a matching Expo Go can be installed on iOS Simulator, `npx expo start` plus `I` opens it, and `npx expo-go download ios latest` downloads/caches a simulator binary ([Expo iOS Simulator guide](https://docs.expo.dev/workflow/ios-simulator/)). As of 2026-07-17 the store Expo Go supports SDK 54, while simulators can install a specific compatible version ([Expo development-build FAQ](https://docs.expo.dev/develop/development-builds/faq/)). An Expo Go development URL is `exp://<host>:8081`; path deep links add `/--/…` ([Expo linking guide](https://docs.expo.dev/linking/into-your-app/)). This satisfies Expo Go compatibility without a native build.

### Tool choice

| Driver | Can drive Expo Go without a spawn native build? | Host install / privilege reality | Verdict |
|---|---|---|---|
| `xcrun simctl` | It can boot/control Simulator, install an existing `.app`, open an `exp://` URL, and capture screenshots. Apple describes `simctl` as the Simulator control tool ([Xcode command-line tools](https://developer.apple.com/documentation/xcode/xcode-command-line-tool-reference)); Apple documents `xcrun simctl io booted screenshot` ([Simulator screenshot guide](https://developer.apple.com/library/archive/documentation/IDEs/Conceptual/iOS_Simulator_Guide/InteractingwiththeiOSSimulator/InteractingwiththeiOSSimulator.html)). | Already provided by Xcode; no package install. Current sandbox cannot access its service. | Necessary orchestration/capture, **not** an interaction driver: it has no generic tap/type/query/assert API. |
| Maestro CLI | Yes. It operates through accessibility with zero app instrumentation, explicitly supports Expo Go, and says to use `openLink` rather than custom-app `launchApp` ([Maestro React Native support](https://docs.maestro.dev/platform-support/react-native)). Local iOS Simulator is supported; physical iOS execution is not ([Maestro iOS support](https://docs.maestro.dev/platform-support/ios-uikit)). | Requires Java 17+ and the Maestro CLI ([installation](https://docs.maestro.dev/maestro-cli/how-to-install-maestro-cli)). This host has Java 8 and no Maestro. Curl/Homebrew can normally install user tools, but this managed sandbox cannot write those locations and this task forbids installing. **UNKNOWN:** whether the host owner's Homebrew permissions require an admin prompt. | **RECOMMEND:** use it after external provisioning and CoreSimulator permission repair. Add no npm/native mobile dependency. |
| Appium + XCUITest | Yes in principle: target installed Expo Go with `appium:bundleId=host.exp.Exponent`, then deep-link the project; Appium capabilities support an already installed bundle ID ([XCUITest capabilities](https://appium.github.io/appium-xcuitest-driver/latest/reference/capabilities/)). No spawn app build is required. | Requires Appium server, `appium driver install xcuitest`, client/flows, and a WebDriverAgent build/install. WDA is required even for simulator ([device preparation](https://appium.github.io/appium-xcuitest-driver/latest/preparation/real-device-config/)). Current Xcode 26.6 requires a supported current XCUITest driver; official requirements map Xcode 26.0–26.6 to driver >=9.5.0 ([requirements](https://appium.github.io/appium-xcuitest-driver/latest/installation/requirements/)). None is installed. | Technically possible, much heavier than Maestro, and not provisioned. Do not choose it for this pass. |

Neither Maestro nor Appium is a mobile package, so neither changes Expo Go compatibility. `simctl` and Maestro drive the already-installed Expo Go binary from the host. Do not propose Detox or another native-instrumented runner under the Expo Go-only constraint.

### Conditional recovery runbook — execute only after preflight succeeds

This is a recovery specification, not a claim that the current sandbox can run it. The verification agent must stop at step 1 unless every preflight passes.

1. **Provision outside this managed agent:** enable access to the user's CoreSimulatorService/Simulator GUI; ensure Xcode has an iOS runtime/device; install Java 17+ and Maestro CLI. No change to `mobile/package.json` is required. Confirm:

   ```sh
   xcrun simctl list devices available
   java -version                    # must report 17 or newer
   maestro --version
   ```

2. **Select and boot an existing simulator** (replace the placeholder with a UDID returned above):

   ```sh
   export SPAWN_SIM_UDID="<available-iPhone-UDID>"
   xcrun simctl boot "$SPAWN_SIM_UDID"
   xcrun simctl bootstatus "$SPAWN_SIM_UDID" -b
   open -a Simulator --args -CurrentDeviceUDID "$SPAWN_SIM_UDID"
   ```

3. **Install/launch the cached SDK 54 Expo Go and prove it is present:**

   ```sh
   xcrun simctl install "$SPAWN_SIM_UDID" "/Users/charliesaxton/.expo/ios-simulator-app-cache/Expo-Go-54.0.7.tar.app"
   xcrun simctl get_app_container "$SPAWN_SIM_UDID" host.exp.Exponent app
   xcrun simctl launch "$SPAWN_SIM_UDID" host.exp.Exponent
   ```

4. **Start Metro in a separate terminal and retain its output.** The project script is already LAN mode (`mobile/package.json:9-18`). Do not guess the IP; copy the exact `exp://…:8081` URL printed by Expo:

   ```sh
   mkdir -p docs/native/verification3/artifacts/maestro docs/native/verification3/artifacts/screens
   cd mobile
   npm start -- --clear 2>&1 | tee ../docs/native/verification3/artifacts/metro.log
   ```

5. **Open the printed URL and make a baseline capture:**

   ```sh
   export SPAWN_EXPO_URL="exp://<LAN-IP-printed-by-Expo>:8081"
   xcrun simctl openurl "$SPAWN_SIM_UDID" "$SPAWN_EXPO_URL"
   xcrun simctl io "$SPAWN_SIM_UDID" screenshot docs/native/verification3/artifacts/screens/00-launch.png
   ```

   Expo Go/Maestro may show a one-time iOS “Open” confirmation; Maestro documents that first-link prompt ([`openLink`](https://docs.maestro.dev/api-reference/commands/openlink)). Accept it once in bootstrap flow and retain that simulator.

6. **Drive flows with Maestro** using `appId: host.exp.Exponent` and `openLink: ${SPAWN_EXPO_URL}` at the top; do not use `launchApp` with spawn's custom ID because the JS app lives inside Expo Go. Prefer existing `testID`/accessibility labels, otherwise visible text. Each flow must `assertVisible` a stable page anchor, exercise every enabled control, assert the resulting sheet/route/state, dismiss it, and `takeScreenshot` with a stable name. Maestro screenshots are PNG and honor `--test-output-dir` ([`takeScreenshot`](https://docs.maestro.dev/reference/commands-available/takescreenshot)). Run:

   ```sh
   maestro --device "$SPAWN_SIM_UDID" test docs/native/verification3/flows --test-output-dir docs/native/verification3/artifacts/maestro
   ```

7. **Capture failure evidence and detect red boxes/crashes.** A flow fails if its expected anchor does not appear. Also assert that accessible error markers such as `Unable to resolve module`, `Invariant Violation`, `TypeError`, `ReferenceError`, and `Connection failed` are absent except in an intentional failure-state flow. After the run, search retained Metro output and capture simulator logs/screens:

   ```sh
   rg -n "ERROR|FATAL|Unable to resolve module|Invariant Violation|TypeError|ReferenceError|Unhandled" docs/native/verification3/artifacts/metro.log
   xcrun simctl io "$SPAWN_SIM_UDID" screenshot docs/native/verification3/artifacts/screens/final-or-failure.png
   xcrun simctl spawn "$SPAWN_SIM_UDID" log show --style compact --last 30m --predicate 'process == "Expo Go" OR process == "Expo"' > docs/native/verification3/artifacts/simulator-expo.log
   ```

   Accessibility assertions cannot guarantee every React red box is exposed, so the raw screenshot plus Metro/simulator logs are mandatory. A missing expected anchor, process crash in simulator log, nonzero Maestro exit, or unexpected Metro error fails the pass.

8. **Do not erase/reinstall per flow.** Expo Go hosts the project, and SecureStore/Keychain may survive reinstall anyway ([Expo SDK 54 SecureStore](https://docs.expo.dev/versions/v54.0.0/sdk/securestore/)). Use explicit sign-out/seed cleanup flows and one known test account. Preserve the booted simulator until the suite finishes.

### Required screen and interaction inventory

The final flow index should account for every route currently under `mobile/src/app`, plus page-like overlays:

| Group | Capture and exercise |
|---|---|
| Public/auth | Server selection; login validation/failure/success; signup; forgot password request; reset-password invalid/valid states; verify-email waiting/resend/confirmed states. Routes: `mobile/src/app/(auth)/server.tsx:1`, `mobile/src/app/(auth)/login.tsx:1`, `mobile/src/app/(auth)/signup.tsx:1`, `mobile/src/app/(auth)/forgot-password.tsx:1`, `mobile/src/app/(auth)/reset-password.tsx:1`, `mobile/src/app/(auth)/verify-email.tsx:1`. |
| Onboarding | Choice page; device-pair code/manual input/review/failure; host install instructions/skip/success. Routes: `mobile/src/app/onboarding/index.tsx:1`, `mobile/src/app/onboarding/device.tsx:1`, `mobile/src/app/onboarding/host.tsx:1`. Camera scanning is a manual limit below. |
| Workspaces | Loading, error, empty, searched, populated, archived; pull refresh; row open/long-press/ellipsis/both swipe actions; every menu operation; new-workspace keyboard open with Cancel/Create visible; blank and template creation; rename/icon/archive/restore/delete confirmations. `mobile/src/components/workspaces/workspace-list-screen.tsx:248-402`. |
| Workspace detail | Loading/error/populated; header Back/`+`/`...`; tab select/pager swipe/add/long-press/rename/reorder/delete; visible `X` and hold-drag after implementation; empty/footer Add; terminal/files/missing rows, row swipe/long-press, pane actions/move/duplicate/restart/remove; launcher cancel/launch. `mobile/src/components/workspace-detail/workspace-detail.tsx:195-394`. |
| Terminal | Loading, unavailable, no-host-key, connecting, failed, ready shell; header close/title/status/overflow; search; copy mode; diagnostics; font sheet; upload; rename/restart/kill confirmation; anywhere-back at 10/50/90% starts. Real ready shell is conditional on daemon fixture. `mobile/src/app/terminal/[sessionId].tsx:34-108`, `mobile/src/components/terminal-ui/terminal-overlay.tsx:250-396`. |
| Hosts/files | Hosts list/detail/actions; agents; file browser navigation, new/rename/delete, file viewer loading/text/binary/error/download/share and full-screen back. Routes: `mobile/src/app/(drawer)/hosts/index.tsx:1`, `mobile/src/app/(drawer)/host/[id]/index.tsx:1`, `mobile/src/app/(drawer)/host/[id]/agents.tsx:1`, `mobile/src/app/(drawer)/host/[id]/files.tsx:1`. |
| Legion | Main states and every exposed action. `mobile/src/app/(drawer)/legion.tsx:1`. |
| Settings | Root; profile; account/logout/delete; appearance light/dark/system; notifications; hosts; agents; skills; templates; browser devices; device trust; server; about/share. The stack declares the main drill-ins at `mobile/src/app/(drawer)/settings/_layout.tsx:24-43`; server/about route entry files are `mobile/src/app/(drawer)/settings/server.tsx:1` and `mobile/src/app/(drawer)/settings/about.tsx:1`. |
| Admin | Access denied/loading/error plus home, invites, users, email actions for an admin fixture. Stack inventory: `mobile/src/app/(drawer)/admin/_layout.tsx:40-53`. |
| System variants | Light/dark; keyboard shown/hidden; reduced motion; at least one large Dynamic Type setting; portrait; safe-area screenshots; offline/reconnect; all page-card anywhere-back gestures. |

Every screenshot should be named `<NN>-<route>-<state>-<appearance>.png`; write the flow YAML under `docs/native/verification3/flows/`, screenshots/logs/results under `docs/native/verification3/artifacts/`, and a concise outcome matrix under `docs/native/verification3/REPORT.md`. Those are future verification outputs—not created by this research task.

### Honest automation limits

- **Real terminal end to end:** screenshotting loading/failure/no-host-key states is achievable with suitable API fixtures. Exercising a ready terminal requires a real authenticated account, registered browser identity, trusted paired host, live daemon, signaling WebSockets, and successful WebRTC. **UNKNOWN:** this repository/machine probe did not establish those external fixtures. A simulator-only “ready terminal” claim would be false.
- **Pairing camera:** Expo documents that iOS Simulator has no camera ([Expo iOS Simulator limitations](https://docs.expo.dev/workflow/ios-simulator/#limitations)). Maestro can test manual-code entry, not real QR capture.
- **Biometrics:** real Face ID/Touch ID, enrollment changes, Secure Enclave behavior, and physical prompt ergonomics cannot be validated by simulator automation. Expo also says SecureStore `requireAuthentication` is not supported in Expo Go when biometrics are available ([SDK 54 SecureStore](https://docs.expo.dev/versions/v54.0.0/sdk/securestore/)). Simulator match/non-match toggles are at most UI-branch tests, not biometric proof.
- **Remote push:** Expo Go SDK 53+ does not support remote push; in-app/local notifications remain available ([Expo push FAQ](https://docs.expo.dev/push-notifications/faq/)). Do not mark remote notification delivery verified under this project's Expo Go constraint.
- **Physical-only quality:** WKWebView gesture arbitration under a finger, keyboard feel, haptics, safe-area behavior on the owner's exact iPhone, WebRTC network transitions, and Liquid Glass appearance still need an owner physical-device acceptance pass. Maestro's current iOS support is simulator-only.
- **Credentials/data:** authenticated, admin, archived, trust, and destructive flows require dedicated seeded accounts and disposable server data. Without them those pages can be screenshotted only in public/error/loading states, not exercised end to end.

### Final verdict for the follow-up agent

**RECOMMEND:** do not assign the final agent a promise to “interact with everything end to end” under the current permission profile. It will fail before boot. Either (a) run that agent outside the managed sandbox after CoreSimulator access plus Java 17/Maestro are provisioned, using the conditional runbook, or (b) perform the strongest achievable alternative here: static route/control/testID audit, automated JS/unit checks, and systematic analysis of owner-supplied physical-iPhone screenshots/video while the owner manually executes the interaction matrix. Even after environment repair, call the result “simulator UI verification”; reserve terminal daemon, camera, biometrics, remote push, haptics, and physical visual/gesture acceptance for a real-device checklist.
