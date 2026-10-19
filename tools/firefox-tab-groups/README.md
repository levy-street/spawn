# SPAWN D Tab Groups

Firefox-style tab groups for the workspace tab strip on spawnd.dev, as a Firefox add-on and
as a userscript. It lives outside the product: SPAWN D itself knows nothing about groups, and
neither frontend changes.

- **Make a group:** right-click a tab → **Add tab to new group**. Name it, pick one of
  Firefox's nine colours, and press **Done** (or Enter). **Cancel** (or Escape) undoes it.
- **Add to a group:** right-click a tab → **Add tab to group ▸** → pick a group. The tab moves
  to the end of that group, as it does in Firefox. A grouped tab offers **Move tab to group**
  and **Remove from group**; a tab removed from the middle moves out to just past the group.
- **Collapse:** click the group's label. A collapsed group shows how many tabs it hides
  (`+3`) and a dot when a hidden tab has windows waiting. The open tab stays visible.
- **Edit:** right-click the label to rename it, change its colour, open a **New tab in
  group**, collapse it, or **Ungroup tabs**.
- **Drag:** a tab dropped between two tabs of a group joins it; a grouped tab dragged away
  from its group leaves it.

## How it works

`content.js` runs on `https://spawnd.dev/*`. It finds the strip through the attributes
`web/src/components/workspace/workspace-tabs.tsx` already stamps for the grid's pane drag
(`data-workspace-tab-strip`, its `-owner`, and `data-workspace-tab` on each tab) and adds its
labels, menu rows and editor beside that UI. It makes no API calls and reads no terminal
content.

- **Groups are per browser.** They are kept in the add-on's storage (`localStorage` for the
  userscript), keyed by workspace and tab id. Other browsers, the desktop app and the phone
  see plain tabs.
- **Tab order is the workspace's.** A group's tabs always sit together. To move a tab into
  place the script presses the strip's own Alt+Shift+←/→ reorder on it, one step at a time,
  so every step is an ordinary layout save.
- `MAX_TABS` (8 per workspace) still applies.
- If the strip's markup changes, the selectors under "DOM reading" in `content.js` are the
  place to look.

## Install

`./build.sh` writes `dist/spawn-tab-groups-<version>.xpi` and
`dist/spawn-tab-groups.user.js`.

- **Userscript, no signing:** install Violentmonkey or Tampermonkey, then open the
  `.user.js` from a URL (for example `python3 -m http.server --directory dist`) to get the
  manager's install page.
- **Add-on, for a session:** `about:debugging#/runtime/this-firefox` → **Load Temporary
  Add-on…** → `manifest.json`. It is gone when Firefox restarts.
- **Add-on, kept:** release Firefox installs only add-ons Mozilla has signed. Sign it as an
  unlisted add-on with your own addons.mozilla.org API key, then open the signed `.xpi`:

  ```bash
  npx web-ext sign --channel=unlisted --api-key=$AMO_JWT_ISSUER --api-secret=$AMO_JWT_SECRET
  ```

Add-ons are per Firefox profile. A SPAWN D window run as a kiosk with its own profile needs
the add-on in that profile: start Firefox with that `--profile` and without `--kiosk` to
install it.

## Develop

```bash
npm install
npm run mock     # bundles dev/mock.jsx and serves http://127.0.0.1:8737/dev/
npm run lint     # web-ext lint on the add-on
```

`dev/index.html` is a stand-in for the workspace tab strip, built on React 19 with the same
DOM contract: the data attributes, a portal context menu that closes on click, outside press
or Escape, Alt+Shift+Arrow reorder, drag with `data-dragging`, click-to-rename and the "+"
picker. It loads `content.js` directly and keeps groups in `localStorage`.
