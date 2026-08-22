import { fireEvent, render } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { BottomNav, isBottomNavRoute } from "@/components/nav/bottom-nav";
import { haptics } from "@/lib/haptics";
import { borderWidth, ThemeProvider } from "@/theme";

const mockReplace = jest.fn();
let mockPathname = "/workspaces";

jest.mock("expo-router", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ replace: mockReplace }),
}));

jest.mock("@/lib/haptics", () => ({
  haptics: { selection: jest.fn() },
}));

const INSETS = { bottom: 34, left: 0, right: 0, top: 59 };

function renderNav(pathname: string) {
  mockPathname = pathname;
  return render(
    <SafeAreaInsetsContext.Provider value={INSETS}>
      <ThemeProvider>
        <BottomNav />
      </ThemeProvider>
    </SafeAreaInsetsContext.Provider>,
  );
}

describe("BottomNav", () => {
  beforeEach(() => {
    mockReplace.mockClear();
    jest.mocked(haptics.selection).mockClear();
  });

  it("recognises only the three root routes", () => {
    expect(isBottomNavRoute("/workspaces")).toBe(true);
    expect(isBottomNavRoute("/hosts")).toBe(true);
    expect(isBottomNavRoute("/settings")).toBe(true);

    for (const pushed of [
      "/workspace/one",
      "/workspaces/archived",
      "/host/one",
      "/settings/profile",
      "/legion",
      "/terminal/one",
    ]) {
      expect(isBottomNavRoute(pushed)).toBe(false);
    }
  });

  it("marks the current destination as selected", async () => {
    const screen = await renderNav("/hosts");

    expect(screen.getByRole("tab", { name: "Workspaces" }).props["accessibilityState"]).toEqual({
      selected: false,
    });
    expect(screen.getByRole("tab", { name: "Hosts" }).props["accessibilityState"]).toEqual({
      selected: true,
    });
    expect(screen.getByRole("tab", { name: "Settings" }).props["accessibilityState"]).toEqual({
      selected: false,
    });
  });

  it("replaces the route and gives selection feedback", async () => {
    const screen = await renderNav("/workspaces");

    await fireEvent.press(screen.getByRole("tab", { name: "Settings" }));

    expect(haptics.selection).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith("/settings");
  });

  it("owns its bottom safe-area inset and top hairline", async () => {
    const screen = await renderNav("/workspaces");
    const style = StyleSheet.flatten(screen.getByTestId("bottom-nav").props["style"]);

    expect(style.paddingBottom).toBe(INSETS.bottom);
    expect(style.borderTopWidth).toBe(borderWidth.hairline);
  });
});
