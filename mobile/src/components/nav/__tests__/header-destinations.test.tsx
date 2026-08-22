import { headerDestinationActions } from "@/components/nav/header-destinations";

const mockPush = jest.fn();

jest.mock("expo-router", () => ({
  router: { push: (...args: unknown[]) => mockPush(...args) },
}));

describe("headerDestinationActions", () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it("keeps secondary destinations while dropping the primary tab routes", () => {
    const actions = headerDestinationActions(["hosts", "legion", "settings", "admin"]);

    expect(actions.map(({ accessibilityLabel, icon }) => ({ accessibilityLabel, icon }))).toEqual([
      { accessibilityLabel: "Open Legion", icon: "RadioTower" },
      { accessibilityLabel: "Open admin", icon: "ShieldCheck" },
    ]);

    actions[0]?.onPress();
    actions[1]?.onPress();

    expect(mockPush).toHaveBeenNthCalledWith(1, "/legion");
    expect(mockPush).toHaveBeenNthCalledWith(2, "/admin");
  });
});
