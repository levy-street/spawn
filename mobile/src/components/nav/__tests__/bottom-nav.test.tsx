import { fireEvent, render } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import {
  BottomNav,
  type BottomNavTabState,
  bottomNavDestinationForPath,
  companionTabBackDestination,
  isBottomNavRoute,
} from "@/components/nav/bottom-nav";
import { registerNavigationOverlayDismiss } from "@/components/nav/overlay-dismiss";
import { haptics } from "@/lib/haptics";
import { borderWidth, ThemeProvider } from "@/theme";

const mockDismissAllRoutes = jest.fn();
const mockDismissAllSheets = jest.fn();
const mockNavigateRoute = jest.fn();
const mockNavigateTab = jest.fn();
let mockPathname = "/workspaces";

jest.mock("@gorhom/bottom-sheet", () => ({
  useBottomSheetModal: () => ({ dismissAll: mockDismissAllSheets }),
}));

jest.mock("expo-router", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ dismissAll: mockDismissAllRoutes, navigate: mockNavigateRoute }),
}));

jest.mock("@/lib/haptics", () => ({
  haptics: { selection: jest.fn() },
}));

const INSETS = { bottom: 34, left: 0, right: 0, top: 59 };
const ROOT_STATE: BottomNavTabState = {
  index: 0,
  routes: [
    { key: "workspaces-key", name: "workspaces" },
    { key: "hosts-key", name: "hosts" },
    { key: "settings-key", name: "settings" },
  ],
};

function nav(state = ROOT_STATE) {
  return (
    <SafeAreaInsetsContext.Provider value={INSETS}>
      <ThemeProvider>
        <BottomNav navigation={{ navigate: mockNavigateTab }} state={state} />
      </ThemeProvider>
    </SafeAreaInsetsContext.Provider>
  );
}

function renderNav(pathname: string, state = ROOT_STATE) {
  mockPathname = pathname;
  return render(nav(state));
}

describe("BottomNav", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses exact roots for profile chrome and maps pushed routes to their destination", () => {
    expect(isBottomNavRoute("/workspaces")).toBe(true);
    expect(isBottomNavRoute("/hosts")).toBe(true);
    expect(isBottomNavRoute("/settings")).toBe(true);
    expect(isBottomNavRoute("/host/one")).toBe(false);

    expect(bottomNavDestinationForPath("/workspace/one")).toBe("/workspaces");
    expect(bottomNavDestinationForPath("/host/one/agents")).toBe("/hosts");
    expect(bottomNavDestinationForPath("/admin/users")).toBe("/settings");
    expect(bottomNavDestinationForPath("/terminal/one")).toBeNull();
    expect(companionTabBackDestination("/host/one")).toBe("/hosts");
    expect(companionTabBackDestination("/host/one/agents")).toBeNull();
    expect(companionTabBackDestination("/workspace/one")).toBe("/workspaces");
  });

  it("keeps the current destination selected over a pushed screen", async () => {
    const screen = await renderNav("/host/one");

    expect(screen.getByRole("tab", { name: "Hosts" }).props["accessibilityState"]).toEqual({
      selected: true,
    });
    expect(screen.getByRole("tab", { name: "Workspaces" }).props["accessibilityState"]).toEqual({
      selected: false,
    });
  });

  it("switches tabs without pushing or replacing a route", async () => {
    const screen = await renderNav("/workspaces");

    await fireEvent.press(screen.getByRole("tab", { name: "Settings" }));

    expect(haptics.selection).toHaveBeenCalledTimes(1);
    expect(mockDismissAllSheets).toHaveBeenCalledTimes(1);
    expect(mockNavigateTab).toHaveBeenCalledWith("settings", undefined);
    expect(mockNavigateRoute).not.toHaveBeenCalled();
    expect(mockDismissAllRoutes).not.toHaveBeenCalled();
  });

  it("returns to the retained companion tab and its nested stack", async () => {
    const hostState: BottomNavTabState = {
      index: 1,
      routes: [
        { key: "workspaces-key", name: "workspaces" },
        { key: "host-key", name: "host", params: { screen: "[id]", id: "host-one" } },
        { key: "settings-key", name: "settings" },
      ],
    };
    const screen = await renderNav("/host/host-one", hostState);

    mockPathname = "/workspaces";
    await screen.rerender(nav(ROOT_STATE));
    await fireEvent.press(screen.getByRole("tab", { name: "Hosts" }));

    expect(mockNavigateTab).toHaveBeenCalledWith("host", {
      screen: "[id]",
      id: "host-one",
    });
  });

  it("pops overlays and lands on the root when the active tab is tapped", async () => {
    const screen = await renderNav("/settings/profile", {
      ...ROOT_STATE,
      index: 2,
    });

    await fireEvent.press(screen.getByRole("tab", { name: "Settings" }));

    expect(mockDismissAllSheets).toHaveBeenCalledTimes(1);
    expect(mockDismissAllRoutes).toHaveBeenCalledTimes(1);
    expect(mockNavigateRoute).toHaveBeenCalledWith("/settings");
    expect(mockNavigateTab).not.toHaveBeenCalled();
  });

  it("closes registered overlays before landing on a different destination root", async () => {
    const onDismiss = jest.fn();
    const unregister = registerNavigationOverlayDismiss(onDismiss);
    const screen = await renderNav("/workspaces");

    await fireEvent.press(screen.getByRole("tab", { name: "Hosts" }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(mockDismissAllRoutes).toHaveBeenCalledTimes(1);
    expect(mockNavigateRoute).toHaveBeenCalledWith("/hosts");
    expect(mockNavigateTab).not.toHaveBeenCalled();
    unregister();
  });

  it("owns its bottom safe-area inset and top hairline", async () => {
    const screen = await renderNav("/workspaces");
    const style = StyleSheet.flatten(screen.getByTestId("bottom-nav").props["style"]);

    expect(style.paddingBottom).toBe(INSETS.bottom);
    expect(style.borderTopWidth).toBe(borderWidth.hairline);
  });
});
