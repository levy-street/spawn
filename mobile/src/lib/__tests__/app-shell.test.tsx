import { render } from "@testing-library/react-native";
import type { ReactNode } from "react";

interface MockTabsProps {
  children: ReactNode;
}

interface MockTabScreenProps {
  name: string;
  options: {
    tabBarAccessibilityLabel?: string;
    title?: string;
  };
}

jest.mock("expo-router", () => {
  const { createElement } = require("react");
  const { View } = require("react-native");
  const Tabs = ({ children }: MockTabsProps) =>
    createElement(View, { testID: "root-tabs" }, children);
  Tabs.Screen = ({ name, options }: MockTabScreenProps) =>
    createElement(View, {
      accessibilityLabel: options.tabBarAccessibilityLabel,
      testID: `tab-${name}`,
    });
  return { Tabs };
});

jest.mock("@/data/queries/workspaces", () => ({
  useWorkspaceSessionsQuery: () => ({ data: [] }),
}));

jest.mock("@/data/queries/alerts", () => ({
  attentionSummaryFromCounts: () => null,
  sessionAttentionSummary: () => null,
}));

jest.mock("expo-splash-screen", () => ({
  preventAutoHideAsync: jest.fn(async () => undefined),
}));

jest.mock("expo-font", () => ({
  useFonts: () => [true, null],
}));

jest.mock("expo-notifications", () => ({}));

jest.mock("expo-font", () => ({
  useFonts: () => [true, null],
}));

jest.mock("react-native-keyboard-controller", () => ({
  KeyboardProvider: ({ children }: MockTabsProps) => children,
}));

import { TERMINAL_ROUTE_OPTIONS } from "@/app/_layout";
import TabsLayout, { ROOT_TABS } from "@/app/(tabs)/_layout";
import { ThemeProvider } from "@/theme";

describe("app navigation shell", () => {
  it("renders exactly the four native root tabs", async () => {
    const screen = await render(
      <ThemeProvider>
        <TabsLayout />
      </ThemeProvider>,
    );

    expect(ROOT_TABS.map((tab) => tab.name)).toEqual(["workspaces", "hosts", "files", "settings"]);
    for (const tab of ROOT_TABS) {
      expect(screen.getByTestId(`tab-${tab.name}`)).toBeTruthy();
      expect(screen.getByLabelText(`${tab.title} tab`)).toBeTruthy();
    }
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
