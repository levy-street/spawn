import { activeDrawerDestination, drawerDestinations } from "@/components/nav/drawer-items";

describe("drawer destinations", () => {
  it("shows the four standard destinations without a root Files item", () => {
    const destinations = drawerDestinations(false);

    expect(destinations.map((item) => item.label)).toEqual([
      "Workspaces",
      "Hosts",
      "Legion",
      "Settings",
    ]);
    expect(destinations.some((item) => item.href === ("/files" as string))).toBe(false);
  });

  it("adds Admin only for administrators", () => {
    expect(drawerDestinations(false).map((item) => item.id)).not.toContain("admin");
    expect(drawerDestinations(true).map((item) => item.id)).toEqual([
      "workspaces",
      "hosts",
      "legion",
      "admin",
      "settings",
    ]);
  });

  it.each([
    ["workspaces", "workspaces"],
    ["workspace/[id]", "workspaces"],
    ["hosts", "hosts"],
    ["host/[id]", "hosts"],
    ["legion", "legion"],
    ["settings/account", "settings"],
    ["admin/users", "admin"],
    ["unknown", null],
  ])("maps %s to its active destination", (routeName, destination) => {
    expect(activeDrawerDestination(routeName)).toBe(destination);
  });
});
