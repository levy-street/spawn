import { type Host, sessions, type WorkspaceTemplate, workspaces } from "@/lib/api";
import { basename } from "@/lib/paths";
import { activeTab, type LayoutV3, withActiveTab } from "@/lib/tabs";
import { pendingLaunch } from "./pending-launch";

/** See the call in `instantiateTemplate`. */
function iconForInstance(
  template: WorkspaceTemplate,
  host: Host,
  cwd: string,
): { icon?: string; icon_source?: "auto" | "custom" } {
  if (!template.icon) return {};
  if (template.icon_source === "custom") return { icon: template.icon, icon_source: "custom" };
  const sameFolder = template.host_id === host.id && template.cwd === cwd;
  return sameFolder ? { icon: template.icon, icon_source: "auto" } : {};
}

/**
 * Replay a template against a freshly chosen folder: create the workspace
 * with the template's tab set (widget tiles inline), then walk the tabs
 * creating one session per session tile — the envelope's active_tab is
 * pointed at each tab first, since session creation appends there. Agent
 * tiles queue their launch command for the pane to claim when it connects
 * (panes in background tabs claim theirs when the tab is first opened).
 */
export async function instantiateTemplate(
  template: WorkspaceTemplate,
  host: Host,
  cwd: string,
): Promise<{ workspaceId: string; focusSessionId: string | null }> {
  const { workspace } = await workspaces.create({
    name: basename(cwd) || template.name,
    // The template's mark, when it is still the right mark for this folder.
    // One the owner chose travels with the template wherever it is replayed;
    // one that was merely found in the folder the template was saved from is
    // only kept when this is that same folder — otherwise the new workspace
    // is left unlooked, and finds its own.
    ...iconForInstance(template, host, cwd),
  });
  await workspaces.update(workspace.id, { host_id: host.id, cwd });

  const tabs = template.spec.tabs.map((tab) => ({
    id: crypto.randomUUID(),
    name: tab.name,
    layout: {
      version: 3 as const,
      tiles: tab.tiles
        .filter((tile) => tile.run.kind === "files")
        .map((tile) => ({
          session_id: crypto.randomUUID(),
          x: tile.x,
          y: tile.y,
          w: tile.w,
          h: tile.h,
          widget: { kind: "files" as const, host_id: host.id, path: cwd },
        })),
    },
  }));
  const firstTabId = tabs[0]?.id as string;
  let layout: LayoutV3 = { version: 3, active_tab: firstTabId, tabs };
  layout = (await workspaces.update(workspace.id, { layout })).layout;

  let focusSessionId: string | null = null;
  for (const [index, specTab] of template.spec.tabs.entries()) {
    const tabId = tabs[index]?.id as string;
    const sessionTiles = specTab.tiles.filter((tile) => tile.run.kind !== "files");
    if (sessionTiles.length === 0) continue;
    if (activeTab(layout).id !== tabId) {
      layout = (await workspaces.update(workspace.id, { layout: withActiveTab(layout, tabId) }))
        .layout;
    }
    for (const tile of sessionTiles) {
      const session = await sessions.create({
        host_id: host.id,
        cwd,
        workspace_id: workspace.id,
        tile: { x: tile.x, y: tile.y, w: tile.w, h: tile.h },
      });
      if (tile.run.kind === "agent") pendingLaunch.set(session.id, tile.run.command);
      focusSessionId ??= session.id;
    }
    layout = (await workspaces.get(workspace.id)).layout;
  }

  if (activeTab(layout).id !== firstTabId) {
    await workspaces.update(workspace.id, { layout: withActiveTab(layout, firstTabId) });
  }
  return { workspaceId: workspace.id, focusSessionId };
}
