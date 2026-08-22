import { headerDestinationActions } from "@/components/nav/header-destinations";

const mockPush = jest.fn();

jest.mock("expo-router", () => ({
  router: { push: (...args: unknown[]) => mockPush(...args) },
}));

describe("headerDestinationActions", () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it("builds actions that navigate directly to each destination", () => {
    const actions = headerDestinationActions(["hosts", "settings"]);

    expect(actions.map(({ accessibilityLabel, icon }) => ({ accessibilityLabel, icon }))).toEqual([
      { accessibilityLabel: "Open hosts", icon: "Server" },
      { accessibilityLabel: "Open settings", icon: "Settings" },
    ]);

    actions[0]?.onPress();
    actions[1]?.onPress();

    expect(mockPush).toHaveBeenNthCalledWith(1, "/hosts");
    expect(mockPush).toHaveBeenNthCalledWith(2, "/settings");
  });
});
