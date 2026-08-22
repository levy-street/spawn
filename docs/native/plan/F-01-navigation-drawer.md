# F-01 — Replace the bottom tabs with a push-style burger drawer

**Fix batch, parallel with five other agents.**

**Read first:** `00-OVERVIEW.md` (§5, §8), then
`docs/native/research2/14-navigation-and-behaviour.md` §3 — it contains the decision, the route
restructure and the enumerated navigation call sites.

## 1. What the owner asked for

> "the 'files index' page is weird we dont need that, we dont actually need a bottom nav at all,
> all this stuff should be tucked under a burger menu, the burger menu should push the app content
> over to the right to reveal it underneith on the left"

## 2. Files you own

```
mobile/src/app/_layout.tsx
mobile/src/app/(tabs)/**            → restructure into the drawer group
mobile/src/components/nav/**        # new: drawer content
mobile/package.json                 # ONLY to add @react-navigation/drawer
mobile/src/lib/linking.ts           # only if route paths change
```

## 3. Dependency exception — you only

`research2/14 §TL;DR 8`: this needs **one** new JavaScript dependency, `@react-navigation/drawer`.
Its native peers (`react-native-gesture-handler`, `react-native-reanimated`,
`react-native-screens`) are already installed and Expo Go compatible.

**You are authorised to install exactly that one package, with `npx expo install
@react-navigation/drawer`** so the SDK 54-compatible version is selected. Install nothing else. No
other agent in this batch may install anything. Record the resolved version in your report.

If `expo install` wants to add a config plugin or anything requiring a native rebuild, **stop and
report it** — that would break Expo Go and the whole approach must be reconsidered.

## 4. What to build

- Drawer with **`drawerType: "back"`** — the drawer sits behind and the content slides right to
  reveal it, which is the behaviour the owner described. Verify against `research2/14` before
  choosing anything else.
- **Remove the bottom tab bar entirely** and **remove the root Files route**. Files stay
  contextual at `/host/[id]/files` (`research2/14 §TL;DR 9`).
- Drawer contents: **Workspaces, Hosts, Legion, Settings**, with **Admin conditional** on
  `is_admin`. Match the web app's grouping and labels where they exist.
- A burger control in the screen headers that opens the drawer, plus edge-swipe to open. The
  gesture must not fight the terminal overlay's dismissal gesture (`F-02` owns that) or the
  workspace tab pager's horizontal drag — check `drawerType` and `swipeEdgeWidth` and say what you
  chose in your report.
- Drawer styling from `@/theme` tokens only. Active/inactive row treatment should match the web
  sidebar's (`web/src/components/nav/sidebar-parts.tsx`, cited in `research2/13`).
- `haptics.selection()` on drawer item selection; nothing on open/close.

## 5. Route restructure

Route groups are URL-invisible, so public deep-link paths can stay stable
(`research2/14 §TL;DR 9`). Keep `/workspaces`, `/hosts`, `/settings/*` etc. working exactly as they
do now. `research2/14` enumerates every `router.push` / `router.replace` / `href` call site — work
from that list and update only the ones whose path genuinely changes.

**Do not** rename or move screens belonging to other agents. If a screen file must move for the
route tree, move it unchanged and say so; do not edit its contents.

## 6. Tests

- The drawer navigator renders the expected items, and Admin only when `is_admin`.
- Files is not a root destination.
- Deep links that worked before still resolve (extend the existing linking tests).
- Selecting a drawer item navigates and fires one selection haptic.

## 7. Deliverables
- [ ] `@react-navigation/drawer` installed via `expo install`, version recorded
- [ ] Bottom tabs gone; drawer with `drawerType: "back"`; Files root removed
- [ ] Burger control + edge swipe that does not conflict with pager or overlay gestures
- [ ] Deep links preserved; call sites updated from the research list
- [ ] `npm run typecheck`, `npm run lint`, `npm test` clean for your files
- [ ] Progress `docs/native/progress/F-01.md`; report `docs/native/reports/F-01.md`
