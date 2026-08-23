# R17 — Layout system: one safe-area owner and a phone-scale rhythm

## TL;DR

1. The top gap is structural: React Navigation's visible native header already owns the status-bar inset, then seven signed-in screens add `SafeAreaView` top padding or `insets.top` again and draw a second header.
2. The clearest instance is workspace detail: the Drawer header is visible, while `WorkspaceHeader` literally sets both `minHeight: 48 + topInset` and `paddingTop: topInset` (`mobile/src/app/(drawer)/_layout.tsx:51-54`; `mobile/src/components/workspace-detail/workspace-header.tsx:28-37`).
3. Workspaces, Archived, Hosts, Host detail, Host agents, Legion, and workspace detail must each retain exactly one header/top-inset owner; the redundant screen-level top safe area and duplicate custom header should go.
4. Auth, onboarding, terminal, full-screen dialogs, sheets, popovers, toasts, and the admin-denied boundary are headerless/full-window surfaces, so their safe-area use is legitimate and must not be deleted globally.
5. **RECOMMEND:** make the native Stack header the default `Screen` chrome; a screen under it starts with a plain `View`/list, never `SafeAreaView`, `insets.top`, manual top compensation, or a second title bar.
6. Web uses a 40px one-line mouse row, but native copied that height into a two-line phone row; the correct translation is web's proportions at phone absolutes: 64pt workspace rows, 68–72pt rich rows, 16pt gutters, and 44pt minimum controls.
7. Raise native buttons from web-identical 36/40/44pt to 44/48/52pt, workspace marks from 24 to 32pt, primary row labels from 14 to 16pt, captions from 12 to 13pt, and native header titles from forced 14pt to the platform default/17pt.
8. The new-workspace footer is currently a static right-aligned pair of 36pt buttons; it needs `KeyboardStickyView`, 48pt `flex: 1` buttons, a 12pt gap, 16pt side insets, and bottom padding that changes from `max(12, insets.bottom)` to 12 while the keyboard is open.
9. Use `KeyboardAwareScrollView` for focused-field visibility and one sticky footer; remove the current `KeyboardAvoidingView` + `automaticallyAdjustKeyboardInsets` double strategies in auth and onboarding.
10. This needs no package change: SDK 54 Expo Go includes the installed `react-native-safe-area-context` and `react-native-keyboard-controller`, and the app already mounts both providers (`mobile/package.json:33-65`; `mobile/src/lib/providers.tsx:82-101`).

## 1. Precise diagnosis: the status-bar inset is being charged twice

### 1.1 Navigator ownership today

The root Stack deliberately hides its own header (`mobile/src/app/_layout.tsx:86-97`), but that does **not** make every descendant headerless. The next navigator layer supplies visible native headers:

| Route family | Native header owner now | Screen-level chrome now | Result |
|---|---|---|---|
| Workspaces / Archived | Nested Workspaces Stack; no `headerShown: false` on either screen (`mobile/src/app/(drawer)/workspaces/_layout.tsx:10-34`) | Default `SafeAreaView` plus a custom title/header (`mobile/src/components/workspaces/workspace-list-screen.tsx:248-282`; `mobile/src/components/longtail/archived-workspaces-screen.tsx:129-143`) | Native header/status area, then another full top inset, then another title bar. |
| Hosts | Nested Hosts Stack (`mobile/src/app/(drawer)/hosts/_layout.tsx:10-29`) | `SafeAreaView edges={["top"]}` plus a 56pt header (`mobile/src/components/hosts/host-list-screen.tsx:121-135`; `mobile/src/components/hosts/host-list-screen.tsx:232-247`) | Top inset and title are both duplicated. |
| Host detail / Agents | Nested host-detail Stack (`mobile/src/app/(drawer)/host/[id]/_layout.tsx:10-36`) | Each uses `SafeAreaView edges={["top"]}` and its own 56pt back/title/actions row (`mobile/src/components/hosts/host-detail-screen.tsx:45-65`; `mobile/src/components/hosts/host-detail-screen.tsx:197-207`; `mobile/src/components/hosts/host-agents-screen.tsx:45-67`; `mobile/src/components/hosts/host-agents-screen.tsx:225-235`) | Top inset, back control, title, and actions are duplicated. |
| Legion | Drawer header is visible because only Workspaces/Hosts/Settings suppress it (`mobile/src/app/(drawer)/_layout.tsx:47-54`) | `SafeAreaView edges={["top"]}` and a custom 56pt back/title/status row (`mobile/src/components/hosts/legion-screen.tsx:51-70`; `mobile/src/components/hosts/legion-screen.tsx:157-176`) | Drawer header/status area followed by a second top inset/header. |
| Workspace detail | Drawer header is visible (`mobile/src/app/(drawer)/_layout.tsx:51-54`) | `WorkspaceDetail` reads `insets.top` and passes it to a custom header (`mobile/src/components/workspace-detail/workspace-detail.tsx:58-66`; `mobile/src/components/workspace-detail/workspace-detail.tsx:208-219`) | Most literal duplicate: custom header is `48 + topInset` high and also gets `paddingTop: topInset` (`mobile/src/components/workspace-detail/workspace-header.tsx:28-37`). |
| Settings / Admin allowed | Nested native Stacks own headers (`mobile/src/app/(drawer)/settings/_layout.tsx:10-44`; `mobile/src/app/(drawer)/admin/_layout.tsx:26-53`) | `SettingsScreen` renders the route title and description again at the top of a ScrollView (`mobile/src/components/settings/settings-screen.tsx:22-44`) | Not a direct `insets.top` addition, but a second page header and 16pt content padding make the same area read over-spaced; `automatic` inset behavior is also unnecessary here. |
| Host Files | Host-detail Stack supplies “Files” (`mobile/src/app/(drawer)/host/[id]/_layout.tsx:34-36`) | `FileExplorer` supplies another toolbar/breadcrumb header (`mobile/src/components/files/file-explorer.tsx:162-203`) | Duplicate chrome without a second explicit safe inset. |

React Navigation's contract is explicit: its built-in headers, tab bars, and drawers “automatically appl[y] proper insets,” and wrapping the whole surface in a `SafeAreaView` wastes space ([React Navigation safe-area guide](https://reactnavigation.org/docs/handling-safe-area/)). Expo's SDK 54 docs say `SafeAreaView` applies the inset as padding and defaults `edges` to all four sides ([Expo safe-area-context 5.6 docs](https://docs.expo.dev/versions/v54.0.0/sdk/safe-area-context/)). Therefore a default `SafeAreaView` below an ordinary opaque native header adds a second status-bar-height top pad. The owner's observed dead band of roughly one status-bar height is exactly the geometry these sources and the code produce.

The installed implementation closes a possible ambiguity: `react-native-screens`' `SafeAreaProviderCompat` checks for existing inset context and, when it finds the app's root provider, deliberately does **not** create a navigator-local provider (`mobile/node_modules/react-native-screens/src/native-stack/utils/SafeAreaProviderCompat.tsx:36-50`). The child `SafeAreaView` therefore continues to consume the full-window top inset even though native navigation has already laid its scene below the header. This is verified double-counting, not an inference from the screenshot alone.

The duplication is not caused by the root `SafeAreaProvider`; that provider is required context and correctly appears once at app root (`mobile/src/lib/providers.tsx:78-101`). The redundant layer is the **consumer inside an already-header-inset screen**.

### 1.2 Exact offenders and the layer to remove

| Screen/state | First owner (keep) | Second owner (remove) | Additional duplicate chrome |
|---|---|---|---|
| Workspaces loading | Native Workspaces Stack header (`mobile/src/app/(drawer)/workspaces/_layout.tsx:24-32`) | Default all-edge `SafeAreaView` (`mobile/src/components/workspaces/workspace-list-screen.tsx:248-257`) | Screen header skeleton occupies the content header slot. |
| Workspaces error | Same | Default all-edge `SafeAreaView` (`mobile/src/components/workspaces/workspace-list-screen.tsx:261-268`) | Same. |
| Workspaces loaded | Same | Default all-edge `SafeAreaView` (`mobile/src/components/workspaces/workspace-list-screen.tsx:272-282`) | Custom 48pt “Workspaces” row; its title is only 14pt (`mobile/src/components/workspaces/workspace-list-styles.ts:10-22`). |
| Archived | Native Archived Stack header (`mobile/src/app/(drawer)/workspaces/_layout.tsx:34`) | Default all-edge `SafeAreaView` (`mobile/src/components/longtail/archived-workspaces-screen.tsx:129-137`) | Custom back button and 24/32 title (`mobile/src/components/longtail/archived-workspaces-screen.tsx:287-301`). |
| Hosts | Native Hosts Stack header (`mobile/src/app/(drawer)/hosts/_layout.tsx:21-29`) | `SafeAreaView edges={["top"]}` (`mobile/src/components/hosts/host-list-screen.tsx:121-125`) | Custom title/+ header (`mobile/src/components/hosts/host-list-screen.tsx:126-135`). |
| Host detail | Native Host Stack header (`mobile/src/app/(drawer)/host/[id]/_layout.tsx:24-33`) | `SafeAreaView edges={["top"]}` (`mobile/src/components/hosts/host-detail-screen.tsx:45-49`) | Custom back/title/ellipsis header (`mobile/src/components/hosts/host-detail-screen.tsx:50-65`). |
| Host agents | Native Agents Stack header (`mobile/src/app/(drawer)/host/[id]/_layout.tsx:34`) | `SafeAreaView edges={["top"]}` (`mobile/src/components/hosts/host-agents-screen.tsx:45-49`) | Custom back/two-line title/refresh header (`mobile/src/components/hosts/host-agents-screen.tsx:50-67`). |
| Legion | Drawer header (`mobile/src/app/(drawer)/_layout.tsx:17-49`) | `SafeAreaView edges={["top"]}` (`mobile/src/components/hosts/legion-screen.tsx:51-55`) | Custom back/two-line title/switch header (`mobile/src/components/hosts/legion-screen.tsx:56-70`). |
| Workspace detail | Drawer header (`mobile/src/app/(drawer)/_layout.tsx:51-54`) | `paddingTop: insets.top` and `minHeight: 48 + insets.top` (`mobile/src/components/workspace-detail/workspace-detail.tsx:208-219`; `mobile/src/components/workspace-detail/workspace-header.tsx:28-37`) | Custom back/title/+/ellipsis header. |

**RECOMMEND:** Since the owner also explicitly rejected the Drawer, remove the drawer navigator and its burger controls as part of the navigation batch, but preserve this invariant through the replacement Stack: each route has one native header, and the screen body has no top-safe consumer. Put +/ellipsis actions into Stack `headerRight`; put back into native Stack behavior. Do not “fix” the gap by setting a negative margin or subtracting a guessed 44/47/59pt status height.

### 1.3 Complete safe-area and manual-top inventory: legitimate uses to retain

The following uses are not evidence of the signed-in screen bug:

| Use | Code | Verdict |
|---|---|---|
| Auth shell | Headerless Auth Stack (`mobile/src/app/(auth)/_layout.tsx:9-16`) plus a default `SafeAreaView` (`mobile/src/components/auth/auth-shell.tsx:66-74`) | **Keep one top/bottom owner.** Its manual 48pt content top pad is visual composition, not a safe inset (`mobile/src/components/auth/auth-shell.tsx:210-216`), although it should be reviewed separately if the owner includes auth in “all pages.” |
| Onboarding index/device | Headerless onboarding Stack (`mobile/src/app/onboarding/_layout.tsx:5-6`), then `SafeAreaView edges={["top","bottom"]}` (`mobile/src/app/onboarding/index.tsx:8-21`; `mobile/src/app/onboarding/device.tsx:8-21`) | **Keep safe area.** Keyboard handling is duplicated, not top safe area. |
| Admin loading/error/denied | Boundary returns instead of mounting the child Stack and uses a default `SafeAreaView` (`mobile/src/components/admin/admin-access.tsx:46-74`) | **Keep**, because no native header exists in these boundary states. Allowed admin screens should use the Stack scaffold. |
| Terminal error | Route explicitly hides the native header, then applies `insets.top + 16` and `insets.bottom + 16` (`mobile/src/app/terminal/[sessionId].tsx:34-75`) | **Keep.** It is a full-window fallback. Loading currently applies neither inset (`mobile/src/app/terminal/[sessionId].tsx:80-91`); standardize that state to the same headerless Screen. |
| Terminal normal header | Native header hidden (`mobile/src/app/terminal/[sessionId].tsx:34-42`); custom header uses `paddingTop: insets.top + 8` (`mobile/src/components/terminal-ui/terminal-header.tsx:142-155`) | **Keep the inset once.** The extra 8pt and second path row make the header taller, but are not double-safe accounting. Remove the path row per owner feedback (`mobile/src/components/terminal-ui/terminal-header.tsx:210-217`). |
| Terminal modifier bar | `KeyboardStickyView`; closed bottom pad is `max(insets.bottom, 4)`, open is 4 (`mobile/src/components/terminal-ui/modifier-bar.tsx:183-199`) | **Keep as the existing correct mechanical precedent**, then raise its base pad to the footer scale where appropriate. |
| Full-screen `Dialog` | `Modal presentationStyle="overFullScreen"`; full-screen content gets `paddingTop: insets.top` and `paddingBottom: insets.bottom` (`mobile/src/components/ui/dialog.tsx:92-139`) | **Keep**, because the modal owns the whole window. Header adds ordinary 16pt after the safe pad (`mobile/src/components/ui/dialog.tsx:141-169`). File viewer's additional 48pt body top pad is large but not another safe inset (`mobile/src/components/files/file-viewer.tsx:245-253`). |
| `Sheet` | Clamps maximum size with top/bottom insets and passes `bottomInset`/`topInset` to the bottom-sheet surface (`mobile/src/components/ui/sheet.tsx:62-79`; `mobile/src/components/ui/sheet.tsx:110-148`) | **Keep**; it is window overlay geometry, not screen-body padding. |
| Popover | Clamps placement to `top/right/bottom/left` insets (`mobile/src/components/ui/popover.tsx:103-106`; `mobile/src/components/ui/popover.tsx:256-269`) | **Keep**; it prevents floating content entering unsafe regions. |
| Toast | Places global toast stack below `insets.top + 56` (`mobile/src/components/ui/toast.tsx:281-284`; `mobile/src/components/ui/toast.tsx:399`) | **Keep**, but replace the unrelated `sidebarRailWidth` name with a semantic toast/header-clearance token. |
| Swipe-dismiss overlay | Uses `insets.top` only to define a top drag-handle hit region (`mobile/src/components/ui/swipe-dismiss-overlay.tsx:89-108`; `mobile/src/components/ui/swipe-dismiss-overlay.tsx:135-148`) | **Keep**; it does not add layout padding. |

There are two automatic-inset sites to normalize:

- `SettingsScreen` opts into both `automaticallyAdjustContentInsets` and `contentInsetAdjustmentBehavior="automatic"` under an ordinary opaque Stack header (`mobile/src/components/settings/settings-screen.tsx:22-31`). React Native 0.81 says the former is for ScrollViews placed **behind** navigation/tab bars and the latter modifies content with safe-area insets ([RN 0.81 ScrollView](https://reactnative.dev/docs/0.81/scrollview)). **RECOMMEND:** use neither in `chrome="native"`; explicitly use `contentInsetAdjustmentBehavior="never"` so screen placement is deterministic.
- `AuthShell` uses `SafeAreaView`, `contentInsetAdjustmentBehavior="automatic"`, `KeyboardAvoidingView`, and `automaticallyAdjustKeyboardInsets` together (`mobile/src/components/auth/auth-shell.tsx:70-100`). The top-safe owner should be the wrapper; the ScrollView should use `contentInsetAdjustmentBehavior="never"`. The two keyboard strategies should be replaced by the form scaffold in §4.

The rest of the manual `paddingTop` search is ordinary component spacing, not hidden safe-area arithmetic: file-home empty/loading content (`mobile/src/components/files/files-home.tsx:125`), drawer sections that will disappear with the Drawer (`mobile/src/components/nav/drawer-content.tsx:112-118`), account subsection spacing (`mobile/src/components/settings/account-panel.tsx:222`), Card internals (`mobile/src/components/ui/card.tsx:85-92`), and the pane-list footer gap (`mobile/src/components/workspace-detail/pane-list.tsx:178-182`). Do not subtract a status-bar height from any of these.

## 2. One standard screen scaffold

### 2.1 Ownership contract

**RECOMMEND:** introduce one `Screen` family with three explicit chrome modes; default to `native` and make unsafe combinations hard to express.

```ts
type ScreenChrome = "native" | "custom" | "none";

type ScreenProps = {
  chrome?: ScreenChrome;      // default: "native"
  scroll?: boolean;
  keyboard?: "none" | "form";
  footer?: ReactNode;
  children: ReactNode;
};
```

| Mode | Top owner | Body rule | Intended routes |
|---|---|---|---|
| `native` | Expo Router/React Navigation Stack header | Root is plain `View`; ScrollView/list uses `contentInsetAdjustmentBehavior="never"`; no top `SafeAreaView`, no `insets.top`, no manual header compensation, no in-content route title | Workspaces, Archived, Hosts, Host detail/agents/files, Settings, Admin, workspace detail after drawer removal. |
| `custom` | `Screen.CustomHeader` adds exactly `insets.top` once, then a 52pt content header | Body starts immediately after the custom header; descendants never read `insets.top` | Terminal only where its bespoke chrome is truly necessary. |
| `none` | `Screen` applies top/left/right safe edges once | No header; centered/scroll content adds only design spacing | Auth, onboarding, full-window loading/error surfaces. |

The scaffold owns these axes separately:

- **Top:** exactly the mode's owner above. A native Stack header is opaque by default; only a deliberately transparent header needs scroll inset behavior. Expo Router documents `headerTransparent` as the case where content renders beneath the header and needs manual top treatment ([Expo Router Stack](https://docs.expo.dev/router/advanced/stack/)). This app should not make ordinary screens transparent just to recover the current composition.
- **Horizontal:** canonical phone gutter is 16pt. If the device rotates, resolve left/right as `16 + insets.left/right` only in the scaffold; no child screen recomputes them.
- **Scroll:** `Screen.Scroll` sets `flexGrow: 1`, `keyboardDismissMode="interactive"`, `keyboardShouldPersistTaps="handled"`, `contentInsetAdjustmentBehavior="never"`, and bottom content pad as described below. Lists receive the same insets through their `contentContainerStyle`, not an outer `SafeAreaView`.
- **Bottom without footer:** scroll/list content owns `paddingBottom: max(24, insets.bottom + 16)`. A non-scroll body can add a bottom-safe spacer only where content can actually reach the home indicator.
- **Bottom with pinned footer:** the footer alone owns the bottom inset. Scroll content reserves/avoids the measured footer; it does not add `insets.bottom` too.
- **Keyboard:** only `keyboard="form"` mounts the controller-aware scroll and sticky footer from §4. Never stack `KeyboardAvoidingView`, automatic keyboard insets, and keyboard-controller movement.

Implementation shape:

```tsx
// Ordinary Stack screen: native header already consumed the top safe area.
<Screen chrome="native">
  <Screen.List contentContainerStyle={{ paddingHorizontal: 16 }} />
</Screen>

// Full-window custom terminal: custom header is the sole top owner.
<Screen chrome="custom" header={<TerminalHeader />}>...</Screen>

// Headerless auth/onboarding: Screen is sole safe-area owner.
<Screen chrome="none" scroll keyboard="form">...</Screen>
```

**RECOMMEND:** delete the forced 14pt `headerTitleStyle` shared by every current nested Stack (`mobile/src/app/(drawer)/workspaces/_layout.tsx:17-22`; `mobile/src/app/(drawer)/hosts/_layout.tsx:14-19`; `mobile/src/app/(drawer)/host/[id]/_layout.tsx:17-22`; `mobile/src/app/(drawer)/settings/_layout.tsx:17-22`; `mobile/src/app/(drawer)/admin/_layout.tsx:33-38`). Let the native platform render its normal navigation title size, or set one shared 17/22 semibold style if the font must be controlled.

## 3. A real sizing scale derived from web, translated for a phone

### 3.1 What the web actually does

The web system is internally coherent and compact:

```css
--row-h: 2.5rem; /* the 40px nav row rhythm */
```

(`web/src/app/globals.css:334-345`)

That row is a **single-line** `text-sm` sidebar item with a 36px icon slot and a 24px workspace mark (`web/src/components/nav/sidebar-parts.tsx:9-20`; `web/src/components/nav/sidebar-parts.tsx:69-101`; `web/src/components/nav/SidebarWorkspaceRow.tsx:139-151`). Web rich host cards instead use 12px padding and a 40px mark (`web/src/components/settings/HostsPanel.tsx:142-185`); simple template rows use 12px horizontal/10px vertical padding (`web/src/components/settings/TemplatesPanel.tsx:107-123`). The app's mobile header and terminal header are both 48px high with 36px controls (`web/src/components/nav/AppShell.tsx:212-252`; `web/src/components/session/session-view.tsx:203-220`). Settings use a 16px mobile gutter, 24px desktop gutter, and 24px major gap (`web/src/components/settings/SettingsDialog.tsx:106-117`).

Native's `spacing` already has the necessary 4pt rhythm and 44/48/56/64 steps (`mobile/src/theme/spacing.ts:1-26`). The mistake was treating `chrome.rowHeight: 40` as a universal phone row while separately inserting a subtitle (`mobile/src/theme/spacing.ts:65-84`; `mobile/src/components/workspaces/workspace-row.tsx:185-194`; `mobile/src/components/workspaces/workspace-row.tsx:243-275`). Apple requires at least 44×44pt hit targets ([Apple UI design tips](https://developer.apple.com/design/tips/)); merely wrapping a 40pt visual in a 44pt hit box makes it tappable, but does not answer the owner's size and visual-parity complaint.

### 3.2 Target table

| Element | Web value | Native current | **Native target** | Rationale |
|---|---:|---:|---:|---|
| Base spacing unit | 4px Tailwind rhythm | 4pt `space()` (`mobile/src/theme/spacing.ts:1-30`) | **4pt** | Keep the shared rhythm; solve size through semantic tokens, not a global multiplier. |
| Screen gutter | Sidebar 10px; settings 16px mobile / 24px desktop (`web/src/components/nav/Sidebar.tsx:464-485`; `web/src/components/settings/SettingsDialog.tsx:106-117`) | Workspaces 10pt (`mobile/src/components/workspaces/workspace-list-styles.ts:20-31`); most detail/settings 16pt | **16pt phone; 24pt regular-width** | 10pt is desktop rail padding. 16pt gives consistent phone breathing room. |
| Simple workspace row | 40px, one line (`web/src/app/globals.css:334-340`; `web/src/components/nav/SidebarWorkspaceRow.tsx:139-151`) | 40pt visual / 44pt hit, two lines (`mobile/src/components/workspaces/workspace-row.tsx:185-194`; `mobile/src/components/workspaces/workspace-row.tsx:265-275`) | **64pt visual and hit** | Two phone lines need real vertical room; target is intentionally taller than desktop. |
| Workspace row internal pad/gap | 36px icon slot, 8px gap; essentially no vertical row pad (`web/src/components/nav/sidebar-parts.tsx:9-20`) | 36pt slots, 8pt gap, 4pt right; no vertical pad (`mobile/src/components/workspaces/workspace-row.tsx:243-275`) | **12pt horizontal, 10pt vertical, 12pt gap** | Preserve the web icon→copy proportion while giving the row a touch-first silhouette. |
| Rich two-line row (host/file/pane) | Rich web host is 12px padded with 40px mark and three text lines; simple template row is 10px vertical (`web/src/components/settings/HostsPanel.tsx:142-185`; `web/src/components/settings/TemplatesPanel.tsx:107-123`) | Host 68pt (`mobile/src/components/hosts/host-list-item.tsx:21-29`); file 64pt (`mobile/src/components/files/file-row.tsx:88-96`); pane 56pt (`mobile/src/components/workspace-detail/terminal-row.tsx:99-111`) | **72pt host/file; 68pt pane** | Current host is close; pane rows are visibly compressed. Use 80–84pt only where a third line is actually shown. |
| Settings/navigation row | Web nav 40px; template row ≥52px from 32px control + 20px vertical pad (`web/src/components/nav/sidebar-parts.tsx:9-20`; `web/src/components/settings/TemplatesPanel.tsx:107-143`) | `minHeight: 44` + 8pt vertical padding, content-dependent (`mobile/src/components/settings/settings-row.tsx:145-154`) | **60pt one/two-line minimum** | Stable rhythm; retains 44pt trailing control inside 8pt vertical air. |
| Workspace mark/avatar | 24px row, 36px rail (`web/src/components/nav/sidebar-parts.tsx:69-101`) | Workspace 24pt (`mobile/src/components/workspaces/workspace-row.tsx:185-187`); generic monogram defaults 28pt (`mobile/src/components/ui/monogram.tsx:35-46`) | **32pt list mark; 36pt pane/agent; 40pt rich card** | Same approximate mark:row proportion as web, scaled to the taller phone rows. |
| Button `sm` | 36px (`web/src/components/ui/button.tsx:23-28`) | 36pt (`mobile/src/components/ui/button.tsx:51-56`) | **44pt** | Web's mouse-small becomes the minimum finger control. |
| Button default | 40px (`web/src/components/ui/button.tsx:23-28`) | 40pt (`mobile/src/components/ui/button.tsx:51-56`) | **48pt** | Primary phone control; improves perceived scale and footer presence. |
| Button `lg` | 44px (`web/src/components/ui/button.tsx:23-28`) | 44pt (`mobile/src/components/ui/button.tsx:51-56`) | **52pt** | Keeps the 4pt step above default. |
| Icon button | Web default 40px; mobile header overrides to 36px (`web/src/components/ui/button.tsx:23-28`; `web/src/components/nav/AppShell.tsx:213-249`) | 36/40/44pt by variant (`mobile/src/components/ui/icon-button.tsx:20-30`) | **44pt all normal chrome; 48pt prominent FAB** | Never depend on hitSlop to make a visibly tiny normal control feel native. |
| Header content height | 48px web mobile/terminal (`web/src/components/nav/AppShell.tsx:212-253`; `web/src/components/session/session-view.tsx:203-220`) | Native Stack plus custom 48pt Workspaces / 56pt Hosts-family; workspace custom 48pt + inset (`mobile/src/components/workspaces/workspace-list-styles.ts:10-16`; `mobile/src/components/hosts/host-list-screen.tsx:232-238`; `mobile/src/components/workspace-detail/workspace-header.tsx:28-37`) | **Native Stack default; custom-only content 52pt + top inset once** | Do not hardcode over native navigation. A custom 52pt bar comfortably holds 44pt controls. |
| Workspace tab strip | 44px strip, 32px rest / 38px connected active tab, 6px gap (`web/src/components/workspace/workspace-tabs.tsx:822-835`; `web/src/components/workspace/workspace-tabs.tsx:909-932`) | 44pt strip/hit, 32pt visual, 6pt gap (`mobile/src/components/workspace-detail/tab-strip.tsx:50-60`; `mobile/src/components/workspace-detail/tab-strip.tsx:145-175`) | **56pt strip; 44pt tab visual/hit; 8pt gap** | Phone tabs must read as controls, not desktop labels floating in a touch box. |
| Workspace tab width | 160px minimum (`web/src/components/workspace/workspace-tabs.tsx:909-932`) | Fixed 96pt (`mobile/src/components/workspace-detail/tab-strip.tsx:12-14`; `mobile/src/components/workspace-detail/tab-strip.tsx:160-170`) | **144pt min, 200pt max** | More defined and closeable while still showing the next tab on a phone. |
| Tab close/add control | Web close visual 18px / icon 12px; add 28px (`web/src/components/workspace/workspace-tabs.tsx:943-984`) | No visible X; add is 36pt (`mobile/src/components/workspace-detail/tab-strip.tsx:81-139`) | **44pt hit; 20pt close plate/14pt glyph; 44pt add** | X can be visually quiet, but its hit region cannot be desktop-sized. |
| Major section spacing | Web settings 24px (`web/src/components/settings/SettingsDialog.tsx:106-117`) | Settings 24pt; agents 32pt; Legion 20pt (`mobile/src/components/settings/settings-screen.tsx:48-56`; `mobile/src/components/hosts/host-agents-screen.tsx:216-220`; `mobile/src/components/hosts/legion-screen.tsx:152-155`) | **24pt major; 12pt heading→content; 8–12pt row gaps** | Standardize rather than inflate every gap. |
| Full-width “Add” | Web full-width action examples are 40px high (`web/src/components/workspace/workspace-tabs.tsx:1221`) | Pane “Add” is a centered 36pt intrinsic button (`mobile/src/components/workspace-detail/pane-list.tsx:119-126`; `mobile/src/components/workspace-detail/pane-list.tsx:178-182`) | **48pt, width 100%, 16pt side gutters** | Directly answers the owner; use one strong horizontal endpoint after the list. |

### 3.3 Typography roles

Tailwind resolves `xs/sm/base/lg/xl` to 12/14/16/18/20px with 16/20/24/28/28px line heights (`web/node_modules/tailwindcss/theme.css:347-356`). Native contains the same raw sizes, but its shared `Text` maps body and label to 14/20, title to 16/20, and caption to 12/16 (`mobile/src/theme/typography.ts:21-55`; `mobile/src/theme/typography.ts:85-102`; `mobile/src/components/ui/text.tsx:43-64`).

| Role | Web value | Native current | **Native target** | Use |
|---|---:|---:|---:|---|
| Micro/status | 10–11px local badges | 11/16 | **11/16** | Counts, terse status only; Apple permits 11pt but it is the floor, not normal copy. |
| Caption/secondary | 12/16 | 12/16 | **13/18** | Row subtitle, host metadata, explanatory chrome. |
| Body | 14/20 common app copy; 16/24 long prose | 14/20 | **15/22 compact; 16/24 prose** | Preserve density where scanning; use 16 for forms/descriptions. |
| Row label | 14/20 medium | 14/20 medium | **16/22 medium** | Workspace, host, file, settings primary labels. |
| Card/section title | 16–18 / 20–28 | 16/20 semibold | **18/24 semibold** | Card/empty-state/section headings. |
| Native navigation title | Web mobile header 14/20 | Forced 14/20 on every Stack | **Platform default, nominal 17/22 semibold** | The native app should feel native here; do not copy the desktop/mobile-web header label size. |
| Screen display title | Web 20–24 depending panel | 24/32 in Archived; otherwise inconsistent | **22/28 semibold** | Only headerless/large-title compositions, never directly under another route title. |
| Terminal | 13px compact | 13/15.6 | **13/16** | Keep: increasing terminal text reduces usable columns; expose user font-size controls instead. |

**Conclusion on last round's tightening:** copying the web's 40px row into native was faithful to a token but unfaithful to the component. Web's workspace row is one line, mouse/trackpad driven, and embedded in a 264px desktop rail. Native made it two lines on a coarse-pointer phone but retained the 40pt visual height. **RECOMMEND:** preserve the web ratios—mark around half the row, 8–12pt internal gaps, clear primary/secondary type—but use phone-appropriate absolutes and a 44pt hard minimum. That is why the target is 64pt, not 40pt and not a blanket scale-up of every number.

## 4. Keyboard standard: form body plus pinned action footer

### 4.1 Installed, Expo Go-compatible mechanism

The project pins `react-native-keyboard-controller` 1.18.5 and `react-native-safe-area-context` ~5.6.0 (`mobile/package.json:59-65`), and mounts `KeyboardProvider` under the root safe-area provider (`mobile/src/lib/providers.tsx:82-101`). Expo's SDK 54 “Third-party libraries supported in Expo Go” list includes both libraries and states that listed support is built into Expo Go ([SDK 54 Expo Go library list](https://docs.expo.dev/versions/v54.0.0/sdk/third-party-overview/)); the SDK 54 safe-area page marks 5.6 as “Included in Expo Go” ([safe-area-context docs](https://docs.expo.dev/versions/v54.0.0/sdk/safe-area-context/)). **Expo Go compatibility: YES; no install, plugin, rebuild, or new native module.**

The version-matched keyboard docs define `KeyboardStickyView` as moving only the footer and expose closed/opened offsets ([KeyboardStickyView 1.18 docs](https://kirillzyusko.github.io/react-native-keyboard-controller/docs/1.18.0/api/components/keyboard-sticky-view)). The installed component adds the animated keyboard height itself, so use `offset={{ closed: 0, opened: 0 }}`; the terminal already proves this arrangement (`mobile/src/components/terminal-ui/modifier-bar.tsx:183-199`). `KeyboardAwareScrollView` keeps the focused input visible; `bottomOffset` is caret clearance, and positive `extraKeyboardSpace` is specifically documented for sticky elements above the keyboard ([KeyboardAwareScrollView 1.18 docs](https://kirillzyusko.github.io/react-native-keyboard-controller/docs/1.18.0/api/components/keyboard-aware-scroll-view)).

### 4.2 Canonical form recipe

```tsx
const ACTION_H = 48;
const ACTION_GAP = 12;
const SIDE = 16;

function FormScreen({ children, actions }: Props) {
  const insets = useSafeAreaInsets();
  const keyboardOpen = useKeyboardState((s) => s.isVisible);
  const [footerHeight, setFooterHeight] = useState(72);

  return (
    <View style={{ flex: 1 }}>
      <KeyboardAwareScrollView
        bottomOffset={12}
        extraKeyboardSpace={footerHeight}
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{
          flexGrow: 1,
          gap: 20,
          paddingHorizontal: SIDE,
          paddingTop: 16,
          paddingBottom: 24,
        }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </KeyboardAwareScrollView>

      <KeyboardStickyView offset={{ closed: 0, opened: 0 }}>
        <View
          onLayout={(e) => setFooterHeight(e.nativeEvent.layout.height)}
          style={{
            flexDirection: "row",
            gap: ACTION_GAP,
            paddingHorizontal: SIDE,
            paddingTop: 12,
            paddingBottom: keyboardOpen ? 12 : Math.max(12, insets.bottom),
          }}
        >
          {actions}
        </View>
      </KeyboardStickyView>
    </View>
  );
}
```

Rules:

- Do not wrap this in `KeyboardAvoidingView`; do not also set `automaticallyAdjustKeyboardInsets`. React Native says that property independently changes ScrollView content/indicator insets when the keyboard changes ([RN 0.81 ScrollView](https://reactnative.dev/docs/0.81/scrollview)); combining mechanisms recreates the double-accounting class of bug.
- Measure the actual footer because closed iPhone safe-bottom varies. Pass that to `extraKeyboardSpace`; keep a 12pt `bottomOffset` between focused caret and the avoided region.
- While keyboard is closed, the footer owns `max(12, insets.bottom)`. While open, the keyboard itself is the safe bottom, so use 12pt—not `insets.bottom + 12`—to avoid a home-indicator-sized gap above the keyboard.
- Put the footer as a sibling after the scroll view. It participates in normal layout when closed, translates with the keyboard when open, and remains tappable throughout the animation.

### 4.3 Current divergent patterns

| Surface | Current behavior | Required normalization |
|---|---|---|
| New workspace | Full-window Dialog has safe padding, but its footer is a static row with 16pt all-side pad and `justifyContent: "flex-end"` (`mobile/src/components/ui/dialog.tsx:171-184`; `mobile/src/components/ui/dialog.tsx:220-224`). Create supplies two intrinsic `size="sm"` 36pt buttons and a plain ScrollView (`mobile/src/components/workspaces/create-workspace-dialog.tsx:86-109`). | Use the canonical aware scroll + sticky `ActionFooter`; 48pt equal-flex actions. This is P0. |
| Auth | `KeyboardAvoidingView behavior="padding"` wraps a ScrollView that also has `automaticallyAdjustKeyboardInsets` (`mobile/src/components/auth/auth-shell.tsx:90-100`). | Choose the controller-aware ScrollView only. If auth has no pinned footer, omit `KeyboardStickyView` and `extraKeyboardSpace`; top/bottom safe owner remains `Screen chrome="none"`. |
| Onboarding index/device | Same double strategy: KAV at lines 9–12 plus automatic keyboard insets at lines 13–16 (`mobile/src/app/onboarding/index.tsx:8-21`; `mobile/src/app/onboarding/device.tsx:8-21`). | Same controller-only form body. Keep one headerless safe-area owner. |
| Settings agent/skill forms | Settings ScrollView dismisses keyboard but has no avoidance; actions sit inline and wrap (`mobile/src/components/settings/settings-screen.tsx:22-31`; `mobile/src/components/settings/agent-form.tsx:189-205`; `mobile/src/components/settings/skill-form.tsx:72-93`). | If these remain inline editors, use `KeyboardAwareScrollView` at the SettingsScreen layer and keep actions inline. If promoted to full form routes, use the pinned footer pattern; do not nest aware scroll views. |
| Launcher details | Bottom sheet already uses `keyboardBehavior="interactive"` and `android_keyboardInputMode="adjustResize"` (`mobile/src/components/ui/sheet.tsx:110-148`), but Launch remains inside a plain ScrollView (`mobile/src/components/launcher/details-step.tsx:36-81`). | Treat sheets as a separate scaffold: keep bottom-sheet keyboard ownership; use its supported scroll integration if pinning is required. Do not add the full-screen sticky footer on top of sheet movement. |
| Terminal modifier bar | Already uses `KeyboardStickyView` with zero offsets and state-dependent safe-bottom padding (`mobile/src/components/terminal-ui/modifier-bar.tsx:183-199`). | Retain; extract the shared bottom-padding policy. |

## 5. Pinned action-footer specifications

### 5.1 Shared bar

| Token | Exact target |
|---|---:|
| Button height | **48pt** |
| Horizontal inset | **16pt each side** |
| Inter-button gap | **12pt** |
| Top padding | **12pt** |
| Bottom padding, keyboard closed | **`max(12pt, insets.bottom)`** |
| Bottom padding, keyboard open | **12pt** |
| Divider | **1px/hairline** top border using semantic border color |
| Surface | Opaque screen background; footer must not reveal scrolled fields under controls |

### 5.2 Single primary

```tsx
<Button style={{ flex: 1, height: 48 }}>Add</Button>
```

The bar's inner width is the screen width minus 32pt. The button consumes all of it. Apply this to the pane-list Add action now centered and intrinsic (`mobile/src/components/workspace-detail/pane-list.tsx:119-126`; `mobile/src/components/workspace-detail/pane-list.tsx:178-182`) and to any primary terminal/files creation action.

### 5.3 Cancel/Create 50/50 pair

```tsx
<Button variant="outline" style={{ flexGrow: 1, flexBasis: 0, height: 48 }}>Cancel</Button>
<Button style={{ flexGrow: 1, flexBasis: 0, height: 48 }}>Create workspace</Button>
```

Both buttons get equal shares of the **available** width after the 12pt gap: `(screenWidth - 32 - 12) / 2`. Do not set each to the literal string `"50%"`, which would make two halves plus the gap overflow. Preserve Cancel first/Create second, disable both during submission as today, and keep Create as the default submit action (`mobile/src/components/workspaces/create-workspace-dialog.tsx:72-95`).

## 6. Expo Go compatibility matrix

| Recommendation/API | Installed evidence | Expo Go SDK 54 evidence | Decision |
|---|---|---|---|
| `react-native-safe-area-context` `SafeAreaProvider`, `SafeAreaView`, `useSafeAreaInsets` | ~5.6.0 (`mobile/package.json:64`); provider exists (`mobile/src/lib/providers.tsx:82`) | SDK 54 page says Included in Expo Go and recommends ~5.6.0 ([Expo docs](https://docs.expo.dev/versions/v54.0.0/sdk/safe-area-context/)) | **Compatible; use existing dependency.** |
| `react-native-keyboard-controller` `KeyboardProvider`, `KeyboardAwareScrollView`, `KeyboardStickyView`, `useKeyboardState` | 1.18.5 (`mobile/package.json:61`); provider exists (`mobile/src/lib/providers.tsx:90-93`) | Listed among libraries whose native support is included in Expo Go for SDK 54 ([Expo list](https://docs.expo.dev/versions/v54.0.0/sdk/third-party-overview/)); API checked against 1.18 docs ([controller docs](https://kirillzyusko.github.io/react-native-keyboard-controller/docs/1.18.0/api/components/keyboard-sticky-view)) | **Compatible; use existing dependency.** |
| Expo Router native `Stack` header | Expo Router ~6.0.24 (`mobile/package.json:49`) | Expo Router's documented Stack API ([Expo Router Stack](https://docs.expo.dev/router/advanced/stack/)); it is already the SDK 54 app's active navigator (`mobile/src/app/_layout.tsx:86-97`) | **Compatible; prefer as default header owner.** |
| RN core `View`, `ScrollView`, `StyleSheet` and inset props | RN 0.81.5 (`mobile/package.json:59`) | Version-matched RN 0.81 ScrollView contract ([RN docs](https://reactnative.dev/docs/0.81/scrollview)) | **Compatible; no native addition.** |

No new library is justified. In particular, do not add another safe-area wrapper, keyboard-aware-scroll package, or layout system.

## 7. Prioritized violation ledger

### P0 — remove visible duplication and unblock the owner's exact flows

1. **Workspace detail:** Drawer native header + `insets.top` custom header + duplicate back/title/actions. Make the replacement Stack header the sole top owner; put functional +/ellipsis in `headerRight`; remove `topInset` prop entirely (`mobile/src/app/(drawer)/_layout.tsx:51-54`; `mobile/src/components/workspace-detail/workspace-detail.tsx:208-219`; `mobile/src/components/workspace-detail/workspace-header.tsx:28-63`).
2. **Workspaces, all loading/error/data states:** nested Stack header + default all-edge SafeArea + 48pt in-content title. Replace root with plain `Screen chrome="native"`; configure +/other header actions in Stack; use 16pt list gutters and 64pt rows (`mobile/src/components/workspaces/workspace-list-screen.tsx:248-282`; `mobile/src/components/workspaces/workspace-list-styles.ts:10-31`; `mobile/src/components/workspaces/workspace-row.tsx:243-275`).
3. **New workspace:** static 36pt intrinsic Dialog buttons neither split width nor track the keyboard. Adopt the form/footer spec in §§4–5 (`mobile/src/components/workspaces/create-workspace-dialog.tsx:86-109`; `mobile/src/components/ui/dialog.tsx:171-184`).
4. **Hosts:** native Stack header + top SafeArea + custom header. Keep native header, move Connect action to it, remove screen safe top/custom title, retain 68–72pt rows (`mobile/src/app/(drawer)/hosts/_layout.tsx:21-29`; `mobile/src/components/hosts/host-list-screen.tsx:121-135`; `mobile/src/components/hosts/host-list-item.tsx:21-29`).
5. **Host detail and Host agents:** native Stack headers + top SafeAreas + custom 56pt headers. Keep native headers; route actions into `headerRight`; body becomes plain/scroll Screen (`mobile/src/app/(drawer)/host/[id]/_layout.tsx:24-36`; `mobile/src/components/hosts/host-detail-screen.tsx:45-65`; `mobile/src/components/hosts/host-agents-screen.tsx:45-67`).
6. **Archived:** native Stack header + default all-edge SafeArea + custom back/24pt title. Keep the native header and replace the body wrapper; increase rich row from 64 to 72pt (`mobile/src/app/(drawer)/workspaces/_layout.tsx:34`; `mobile/src/components/longtail/archived-workspaces-screen.tsx:129-143`; `mobile/src/components/longtail/archived-workspaces-screen.tsx:302-320`).
7. **Legion:** Drawer header + SafeArea/custom header. The Drawer is being removed; give Legion one native Stack header and put Live control in body or `headerRight`, never in a second title row (`mobile/src/app/(drawer)/_layout.tsx:47-54`; `mobile/src/components/hosts/legion-screen.tsx:51-70`).

### P1 — standardize remaining screen families

8. **Every Settings route** (Settings, Account, Appearance, Notifications, Hosts, Agents, Skills, Templates, Browser devices, Device trust, Profile): Stack already supplies the route title, while `SettingsScreen` repeats title/description and opts into automatic inset behavior (`mobile/src/app/(drawer)/settings/_layout.tsx:24-44`; `mobile/src/components/settings/settings-screen.tsx:22-44`). Keep one native title; render description as first content, use 16pt gutter/24pt sections, and use one controller-aware scroll for editable panels.
9. **Every allowed Admin route** (Admin, Invites, Users, Email): native Stack plus the same `SettingsScreen` duplicate header pattern (`mobile/src/app/(drawer)/admin/_layout.tsx:26-53`; `mobile/src/components/settings/settings-screen.tsx:22-44`). The denied/loading/error boundary's own SafeArea is valid and should remain (`mobile/src/components/admin/admin-access.tsx:46-74`).
10. **Host Files:** native “Files” header plus `FileExplorer` toolbar. Separate navigation chrome from file navigation: native header owns back/title; breadcrumbs/search/list controls remain content, not a second route header (`mobile/src/app/(drawer)/host/[id]/_layout.tsx:34-36`; `mobile/src/components/files/file-explorer.tsx:162-203`). File viewer's full-screen Dialog remains its own safe-area owner (`mobile/src/components/files/file-viewer.tsx:164-199`).
11. **Auth and onboarding:** top safe areas are correct because their Stacks are headerless, but keyboard avoidance is doubled. Move all three to `Screen chrome="none" keyboard="form"` and one keyboard-controller strategy (`mobile/src/components/auth/auth-shell.tsx:70-100`; `mobile/src/app/onboarding/index.tsx:8-21`; `mobile/src/app/onboarding/device.tsx:8-21`).

### P2 — valid ownership, consistency cleanup

12. **Terminal normal/error/loading:** normal and error correctly own the top inset because the route header is hidden; loading owns none. Move all states under one custom/headerless Screen policy. Remove the path row and reduce custom header content to 52pt while preserving one `insets.top` (`mobile/src/app/terminal/[sessionId].tsx:34-91`; `mobile/src/components/terminal-ui/terminal-header.tsx:142-217`).
13. **Overlays:** Dialog, Sheet, Popover, Toast, and swipe overlay use window insets legitimately. Keep their geometry but route all full-screen form dialogs through the shared action footer so bottom safe area and keyboard movement have one owner (`mobile/src/components/ui/dialog.tsx:113-203`; `mobile/src/components/ui/sheet.tsx:110-148`; `mobile/src/components/ui/popover.tsx:256-269`; `mobile/src/components/ui/toast.tsx:399`; `mobile/src/components/ui/swipe-dismiss-overlay.tsx:135-148`).

## Final decision

**RECOMMEND:** fix the system, not seven margins: remove the Drawer, retain native Stack headers for ordinary signed-in routes, introduce an explicit three-mode Screen scaffold, centralize bottom/keyboard behavior, and replace desktop-derived semantic sizes with the phone targets above. The invariant for review is simple: **one top owner, one bottom owner, one keyboard owner, and every visible control at least 44pt.**
