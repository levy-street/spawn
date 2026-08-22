import {
  firstAvailableTabId,
  resolveInitialDirectory,
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
});
