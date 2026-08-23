import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import AppStackLayout from "@/app/(drawer)/_layout";
import TabsLayout from "@/app/(drawer)/(tabs)/_layout";
import { ThemeProvider } from "@/theme";

/** The shell renders a device-approval watcher that queries; give it a client. */
function testQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

let mockPathname = "/workspaces";
let mockStackProps: Record<string, unknown> = {};
let mockStackScreens: { name: string; options?: Record<string, unknown> }[] = [];
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

  const Stack = ({ children, ...props }: Record<string, unknown>) => {
    mockStackProps = props;
    mockStackScreens = [];
    return React.createElement(
      View,
      { testID: "mock-stack" },
      React.createElement(AppHeader, { title: "Root route" }),
      React.createElement(AppHeader, { onBack: mockBack, title: "Pushed route" }),
      children as React.ReactNode,
    );
  };
  Stack.Screen = ({ name, options }: { name: string; options?: Record<string, unknown> }) => {
    mockStackScreens.push({ name, ...(options === undefined ? {} : { options }) });
    return React.createElement(View, { testID: `mock-stack-screen-${name}` });
  };

  const Tabs = ({ children, tabBar, ...props }: Record<string, unknown>) => {
    mockTabsProps = props;
    const renderTabBar = tabBar as (...args: unknown[]) => unknown;
    const tabBarNode = renderTabBar({
      navigation: { navigate: mockNavigate },
      state: {
        index: 0,
        routes: [
          { key: "workspaces-key", name: "workspaces" },
          { key: "hosts-key", name: "hosts" },
          { key: "settings-key", name: "settings" },
        ],
      },
    }) as React.ReactNode;
    return React.createElement(
      View,
      { testID: "mock-tabs" },
      children as React.ReactNode,
      tabBarNode,
    );
  };
  Tabs.Screen = ({ name }: { name: string }) =>
    React.createElement(View, { testID: `mock-tab-${name}` });

  return {
    Stack,
    Tabs,
    useNavigation: () => ({ navigate: mockNavigate }),
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

jest.mock("@/components/trust/device-approval-prompt", () => ({
  DeviceApprovalPrompt: () => null,
}));

jest.mock("@/data/queries/auth", () => ({
  useMeQuery: () => ({ data: undefined, error: null, isLoading: false, refetch: jest.fn() }),
}));

jest.mock("@/lib/auth-gate", () => ({
  useAuthenticatedAccount: () => ({ accountId: "account-one", ready: true }),
}));

const INSETS = { bottom: 34, left: 0, right: 0, top: 59 };

function renderWith(node: React.JSX.Element) {
  return render(
    <SafeAreaInsetsContext.Provider value={INSETS}>
      <QueryClientProvider client={testQueryClient()}>
        <ThemeProvider>{node}</ThemeProvider>
      </QueryClientProvider>
    </SafeAreaInsetsContext.Provider>,
  );
}

describe("app navigation shell", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStackProps = {};
    mockStackScreens = [];
    mockTabsProps = {};
  });

  it("pushes every detail screen over the tab group", async () => {
    mockPathname = "/workspaces";
    const screen = await renderWith(<AppStackLayout />);

    expect(screen.getByTestId("mock-stack")).toBeTruthy();
    const names = mockStackScreens.map((entry) => entry.name);
    expect(names).toContain("(tabs)");
    for (const pushed of ["workspace/[id]", "host/[id]/index", "legion", "admin/index"]) {
      expect(names).toContain(pushed);
    }
  });

  it("holds the tab group still while everything above it slides", async () => {
    mockPathname = "/workspaces";
    await renderWith(<AppStackLayout />);

    // Animating the tab host would animate the whole app underneath the card
    // being pushed, which is what made the app appear to slide in over itself.
    const tabHost = mockStackScreens.find((entry) => entry.name === "(tabs)");
    expect(tabHost?.options).toMatchObject({ animation: "none", gestureEnabled: false });
    expect(mockStackProps["screenOptions"]).toMatchObject({
      animation: "simple_push",
      gestureEnabled: true,
    });
  });

  it("gives the root header the profile control and the pushed header a back control", async () => {
    mockPathname = "/workspaces";
    const screen = await renderWith(<AppStackLayout />);

    // The shell always supplies the profile control; whether a header shows it is
    // decided by that header having no back action. Deciding by pathname blanked
    // the avatar for the length of every push animation.
    expect(screen.getByTestId("mock-profile-menu")).toBeTruthy();
    expect(screen.getByLabelText("Go back")).toBeTruthy();
  });

  it("mounts the bar at window level for the whole signed-in app", async () => {
    mockPathname = "/workspaces";
    // Mounted by the shell rather than by the tabs navigator, so it survives a
    // detail screen being pushed over the tabs — and cannot vanish with them.
    const screen = await renderWith(<AppStackLayout />);

    expect(screen.getByTestId("bottom-nav")).toBeTruthy();
    expect(screen.getByTestId("mock-full-window-overlay")).toBeTruthy();
  });

  it("switches the three roots instantly", async () => {
    mockPathname = "/workspaces";
    await renderWith(<TabsLayout />);

    expect(mockTabsProps).toMatchObject({ backBehavior: "none", initialRouteName: "workspaces" });
    expect(mockTabsProps["screenOptions"]).toMatchObject({ animation: "none" });
  });
});
