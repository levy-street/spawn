import { firstAvailableTabId } from "@/components/launcher/launcher-selection";
import { fullTab, makeTab, makeWorkspace } from "./fixtures";

describe("launcher defaults", () => {
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
