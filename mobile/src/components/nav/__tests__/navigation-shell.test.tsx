import { fireEvent, render } from "@testing-library/react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import AppStackLayout from "@/app/(drawer)/_layout";
import { ThemeProvider } from "@/theme";

let mockPathname = "/workspaces";
let mockTabsProps: Record<string, unknown> = {};
const mockBack = jest.fn();
const mockDismissAll = jest.fn();
const mockNavigate = jest.fn();

jest.mock("@gorhom/bottom-sheet", () => ({
  useBottomSheetModal: () => ({ dismissAll: jest.fn() }),
}));

jest.mock("react-native-screens", () => {
  const React = require("react") as typeof import("react");
  const { View } = require("react-native") as typeof import("react-native");
  return {
    FullWindowOverlay: ({ children }: { children: import("react").ReactNode }) =>
      React.createElement(View, { testID: "mock-full-window-overlay" }, children),
  };
});

jest.mock("expo-router", () => {
  const React = require("react") as typeof import("react");
  const { View } = require("react-native") as typeof import("react-native");
  const { AppHeader } =
    require("@/components/layout/app-header") as typeof import("@/components/layout/app-header");
  const routes = [
    { key: "workspaces-key", name: "workspaces" },
    { key: "workspace-key", name: "workspace" },
    { key: "hosts-key", name: "hosts" },
    { key: "host-key", name: "host" },
    { key: "legion-key", name: "legion" },
    { key: "settings-key", name: "settings" },
    { key: "admin-key", name: "admin" },
  ];
  const Tabs = ({ children, tabBar, ...props }: Record<string, unknown>) => {
    mockTabsProps = props;
    const renderTabBar = tabBar as (...args: unknown[]) => unknown;
    const tabBarNode = renderTabBar({
      navigation: { navigate: mockNavigate },
      state: { index: 0, routes },
    }) as React.ReactNode;
    return React.createElement(
      View,
      { testID: "mock-tabs" },
      React.createElement(AppHeader, { onBack: mockBack, title: "Current route" }),
      children as React.ReactNode,
      tabBarNode,
    );
  };
  Tabs.Screen = ({ name }: { name: string }) =>
    React.createElement(View, { testID: `mock-tab-${name}` });
  return {
    Tabs,
    usePathname: () => mockPathname,
    useRouter: () => ({
      back: mockBack,
      dismissAll: mockDismissAll,
      navigate: mockNavigate,
      replace: jest.fn(),
    }),
  };
});

jest.mock("@/components/admin/admin-access", () => {
  const React = require("react") as typeof import("react");
  return {
    AdminAccessBoundary: ({ children }: { children: import("react").ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    resolveAdminAccess: () => "allowed",
  };
});

jest.mock("@/components/nav/profile-menu", () => {
  const React = require("react") as typeof import("react");
  const { View } = require("react-native") as typeof import("react-native");
  return {
    ProfileMenu: () => React.createElement(View, { testID: "mock-profile-menu" }),
  };
});

jest.mock("@/data/queries/auth", () => ({
  useMeQuery: () => ({ data: undefined, error: null, isLoading: false, refetch: jest.fn() }),
}));

jest.mock("@/lib/auth-gate", () => ({
  useAuthenticatedAccount: () => ({ accountId: "account-one", ready: true }),
}));

const INSETS = { bottom: 34, left: 0, right: 0, top: 59 };

function renderLayout() {
  return render(
    <SafeAreaInsetsContext.Provider value={INSETS}>
      <ThemeProvider>
        <AppStackLayout />
      </ThemeProvider>
    </SafeAreaInsetsContext.Provider>,
  );
}

describe("drawer navigation shell", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTabsProps = {};
  });

  it("uses an instant tab navigator rather than a push stack", async () => {
    mockPathname = "/workspaces";
    const screen = await renderLayout();

    expect(screen.getByTestId("mock-tabs")).toBeTruthy();
    expect(mockTabsProps).toMatchObject({ backBehavior: "none", initialRouteName: "workspaces" });
    expect(mockTabsProps["screenOptions"]).toMatchObject({ animation: "none" });
  });

  it("mounts bottom navigation and profile leading chrome on a root route", async () => {
    mockPathname = "/workspaces";
    const screen = await renderLayout();

    expect(screen.getByTestId("bottom-nav")).toBeTruthy();
    expect(screen.getByTestId("mock-full-window-overlay")).toBeTruthy();
    expect(screen.getByTestId("mock-profile-menu")).toBeTruthy();
    expect(screen.queryByLabelText("Go back")).toBeNull();
  });

  it("keeps bottom navigation over a pushed screen while restoring its back control", async () => {
    mockPathname = "/settings/profile";
    const screen = await renderLayout();

    expect(screen.getByTestId("bottom-nav")).toBeTruthy();
    expect(screen.queryByTestId("mock-profile-menu")).toBeNull();
    expect(screen.getByLabelText("Go back")).toBeTruthy();
  });

  it("routes back from a retained companion root to its visible destination root", async () => {
    mockPathname = "/host/host-one";
    const screen = await renderLayout();

    await fireEvent.press(screen.getByLabelText("Go back"));

    expect(mockNavigate).toHaveBeenCalledWith("/hosts");
  });
});
