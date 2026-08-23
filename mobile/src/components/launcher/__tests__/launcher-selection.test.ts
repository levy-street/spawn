import {
  firstAvailableTabId,
  resolveInitialDirectory,
  resolveLaunchHome,
} from "@/components/launcher/launcher-selection";
import { fullTab, makeHost, makeTab, makeWorkspace } from "./fixtures";

describe("launcher defaults", () => {
  test("prefers a complete target-tab home, then a complete workspace home", () => {
    const hostId = makeHost().id;
    const workspace = makeWorkspace({
      host_id: hostId,
      cwd: "/Users/ada/workspace",
      layout: {
        version: 3,
        active_tab: "tab-1",
        tabs: [makeTab({ host_id: hostId, cwd: "/Users/ada/tab" })],
      },
    });
    expect(resolveInitialDirectory(workspace, "tab-1", hostId)).toBe("/Users/ada/tab");
    expect(resolveInitialDirectory(workspace, "missing", hostId)).toBe("/Users/ada/workspace");
    expect(resolveInitialDirectory(workspace, "tab-1", "another-host")).toBeNull();
  });

  test("skips a preferred full tab and reports when all eight tabs are full", () => {
    const available = makeTab({ id: "tab-2", name: "Tab 2" });
    const workspace = makeWorkspace({
      layout: { version: 3, active_tab: "tab-1", tabs: [fullTab(), available] },
    });
    expect(firstAvailableTabId(workspace, "tab-1")).toBe("tab-2");

    const fullTabs = Array.from({ length: 8 }, (_, index) => fullTab({ id: `tab-${index + 1}` }));
    const atCapacity = makeWorkspace({
      layout: { version: 3, active_tab: "tab-1", tabs: fullTabs },
    });
    expect(firstAvailableTabId(atCapacity, "tab-1")).toBeNull();
  });

  test("answers where a window opens without asking: tab home first, then the workspace's", () => {
    const host = makeHost();
    const other = makeHost({ id: "20000000-0000-4000-8000-000000000002", name: "server" });
    const workspace = makeWorkspace({
      host_id: other.id,
      cwd: "/srv/spawn",
      layout: {
        version: 3,
        active_tab: "tab-1",
        tabs: [makeTab({ host_id: host.id, cwd: "/Users/ada/tab" }), makeTab({ id: "tab-2" })],
      },
    });

    expect(resolveLaunchHome(workspace, "tab-1", [host, other])).toEqual({
      host,
      cwd: "/Users/ada/tab",
    });
    // A tab that has never been re-pointed follows the workspace as it moves.
    expect(resolveLaunchHome(workspace, "tab-2", [host, other])).toEqual({
      host: other,
      cwd: "/srv/spawn",
    });
  });

  test("has no home to offer when neither the tab nor the workspace names a complete one", () => {
    const host = makeHost();
    const homeless = makeWorkspace({ host_id: host.id, cwd: null });
    expect(resolveLaunchHome(homeless, "tab-1", [host])).toBeNull();
  });

  test("has no home when the host it names is gone, so the launcher has to ask", () => {
    const host = makeHost();
    const workspace = makeWorkspace({ host_id: host.id, cwd: "/srv/spawn" });
    expect(resolveLaunchHome(workspace, "tab-1", [])).toBeNull();
  });
});
