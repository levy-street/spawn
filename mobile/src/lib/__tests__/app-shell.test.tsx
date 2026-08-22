import { fireEvent, render } from "@testing-library/react-native";
import type { ReactNode } from "react";

interface MockDrawerProps {
  children: ReactNode;
  screenOptions: (props: { navigation: { dispatch: (action: unknown) => void } }) => {
    drawerType?: string;
    headerLeft?: () => ReactNode;
    swipeEdgeWidth?: number;
    swipeEnabled?: boolean;
  };
}

interface MockDrawerScreenProps {
  name: string;
  options: {
    headerShown?: boolean;
    title?: string;
  };
}

let capturedDrawerProps: MockDrawerProps | null = null;

jest.mock("expo-router/drawer", () => {
  const { createElement } = require("react");
  const { View } = require("react-native");
  const Drawer = (props: MockDrawerProps) => {
    capturedDrawerProps = props;
    return createElement(View, { testID: "root-drawer" }, props.children);
  };
  Drawer.Screen = ({ name, options }: MockDrawerScreenProps) =>
    createElement(View, {
      accessibilityLabel: options.title,
      testID: `drawer-screen-${name}`,
    });
  return { Drawer };
});

jest.mock("expo-router", () => ({
  usePathname: () => "/workspaces",
  useRouter: () => ({ navigate: jest.fn(), replace: jest.fn() }),
}));

jest.mock("expo-splash-screen", () => ({
  preventAutoHideAsync: jest.fn(async () => undefined),
}));

jest.mock("expo-font", () => ({
  useFonts: () => [true, null],
}));

jest.mock("expo-notifications", () => ({}));

jest.mock("react-native-keyboard-controller", () => ({
  KeyboardProvider: ({ children }: { children: ReactNode }) => children,
}));

import { TERMINAL_ROUTE_OPTIONS } from "@/app/_layout";
import DrawerLayout, { DRAWER_SWIPE_EDGE_WIDTH, ROOT_DRAWER_ROUTES } from "@/app/(drawer)/_layout";
import { ThemeProvider } from "@/theme";

describe("app navigation shell", () => {
  it("renders the drawer destinations without a root Files screen", async () => {
    const screen = await render(
      <ThemeProvider>
        <DrawerLayout />
      </ThemeProvider>,
    );

    expect(ROOT_DRAWER_ROUTES).toEqual(["workspaces", "hosts", "legion", "settings"]);
    for (const route of ROOT_DRAWER_ROUTES) {
      expect(screen.getByTestId(`drawer-screen-${route}`)).toBeTruthy();
    }
    expect(screen.queryByTestId("drawer-screen-files")).toBeNull();
  });

  it("uses a back drawer with a narrow edge swipe", async () => {
    await render(
      <ThemeProvider>
        <DrawerLayout />
      </ThemeProvider>,
    );

    expect(capturedDrawerProps).not.toBeNull();
    const dispatch = jest.fn();
    const options = capturedDrawerProps?.screenOptions({ navigation: { dispatch } });
    expect(options).toMatchObject({
      drawerType: "back",
      swipeEdgeWidth: DRAWER_SWIPE_EDGE_WIDTH,
      swipeEnabled: true,
    });
    expect(DRAWER_SWIPE_EDGE_WIDTH).toBe(20);

    const header = await render(<ThemeProvider>{options?.headerLeft?.()}</ThemeProvider>);
    await fireEvent.press(header.getByLabelText("Open navigation menu"));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "OPEN_DRAWER" }));
  });

  it("configures terminal as a vertically dismissable card", () => {
    expect(TERMINAL_ROUTE_OPTIONS).toMatchObject({
      presentation: "card",
      gestureEnabled: true,
      gestureDirection: "vertical",
      animationMatchesGesture: true,
      fullScreenGestureEnabled: true,
    });
  });
});
