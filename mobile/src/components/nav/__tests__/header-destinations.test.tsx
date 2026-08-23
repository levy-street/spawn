import { headerDestinationActions } from "@/components/nav/header-destinations";

const mockPush = jest.fn();

jest.mock("expo-router", () => ({
  router: { push: (...args: unknown[]) => mockPush(...args) },
}));

describe("headerDestinationActions", () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it("offers the secondary destinations a header may push to", () => {
    const actions = headerDestinationActions(["legion", "admin"]);

    expect(actions.map(({ accessibilityLabel, icon }) => ({ accessibilityLabel, icon }))).toEqual([
      { accessibilityLabel: "Open Legion", icon: "RadioTower" },
      { accessibilityLabel: "Open admin", icon: "ShieldCheck" },
    ]);

    actions[0]?.onPress();
    actions[1]?.onPress();

    expect(mockPush).toHaveBeenNthCalledWith(1, "/legion");
    expect(mockPush).toHaveBeenNthCalledWith(2, "/admin");
  });

  it("has no route to a tab root at all", () => {
    // Hosts and Settings are roots of the tab bar. A header link to one pushed a
    // card over the screen you were on, so they are not destinations any more —
    // this is a type-level guarantee, asserted here so it stays one.
    const destinations: readonly string[] = ["legion", "admin"];

    expect(destinations).not.toContain("hosts");
    expect(destinations).not.toContain("settings");
    expect(
      headerDestinationActions(["legion", "admin"]).map((action) => action.accessibilityLabel),
    ).not.toContain("Open settings");
  });
});
