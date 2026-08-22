import type { DrawerContentComponentProps } from "@react-navigation/drawer";
import { fireEvent, render } from "@testing-library/react-native";

const mockNavigate = jest.fn();
const mockCloseDrawer = jest.fn();
let mockIsAdmin = false;

jest.mock("expo-router", () => ({
  useRouter: () => ({ navigate: mockNavigate }),
}));

jest.mock("@react-navigation/drawer", () => {
  const { createElement } = require("react");
  const { View } = require("react-native");
  return {
    DrawerContentScrollView: ({ children }: { children: React.ReactNode }) =>
      createElement(View, { testID: "drawer-scroll" }, children),
  };
});

jest.mock("@/data/queries/auth", () => ({
  useMeQuery: () => ({ data: { user: { is_admin: mockIsAdmin } } }),
}));

import { SpawnDrawerContent } from "@/components/nav/drawer-content";
import { haptics } from "@/lib/haptics";
import { ThemeProvider } from "@/theme";

const selectionSpy = jest.spyOn(haptics, "selection").mockImplementation(() => undefined);

function drawerProps(routeName = "workspaces"): DrawerContentComponentProps {
  return {
    descriptors: {},
    navigation: {
      closeDrawer: mockCloseDrawer,
    } as unknown as DrawerContentComponentProps["navigation"],
    state: {
      default: "closed",
      history: [],
      index: 0,
      key: "drawer",
      preloadedRouteKeys: [],
      routeNames: [routeName],
      routes: [{ key: routeName, name: routeName }],
      stale: false,
      type: "drawer",
    },
  };
}

describe("SpawnDrawerContent", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAdmin = false;
  });

  it("renders expected items and hides Files and Admin for a standard user", async () => {
    const screen = await render(
      <ThemeProvider>
        <SpawnDrawerContent {...drawerProps()} />
      </ThemeProvider>,
    );

    expect(screen.getByLabelText("Workspaces")).toHaveProp("accessibilityState", {
      selected: true,
    });
    expect(screen.getByLabelText("Hosts")).toBeTruthy();
    expect(screen.getByLabelText("Legion")).toBeTruthy();
    expect(screen.getByLabelText("Settings")).toBeTruthy();
    expect(screen.queryByLabelText("Files")).toBeNull();
    expect(screen.queryByLabelText("Admin")).toBeNull();
  });

  it("renders Admin for an administrator", async () => {
    mockIsAdmin = true;
    const screen = await render(
      <ThemeProvider>
        <SpawnDrawerContent {...drawerProps("admin")} />
      </ThemeProvider>,
    );

    expect(screen.getByLabelText("Admin")).toHaveProp("accessibilityState", { selected: true });
  });

  it("navigates and fires one selection haptic when an item is selected", async () => {
    const screen = await render(
      <ThemeProvider>
        <SpawnDrawerContent {...drawerProps()} />
      </ThemeProvider>,
    );

    await fireEvent.press(screen.getByLabelText("Hosts"));

    expect(selectionSpy).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith("/hosts");
    expect(mockCloseDrawer).toHaveBeenCalledTimes(1);
  });
});
