import { render, screen } from "@testing-library/react-native";
import { StyleSheet } from "react-native";

import TerminalScreen, { TERMINAL_ROUTE_GESTURE_OPTIONS } from "@/app/terminal/[sessionId]";
import { darkTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

interface MockTerminalData {
  error: Error | null;
  host: Record<string, unknown> | null;
  isLoading: boolean;
  refetch: jest.Mock;
  session: Record<string, unknown> | null;
}

let mockStackScreenOptions: Record<string, unknown> = {};
let mockTerminalData: MockTerminalData;

jest.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));

jest.mock("expo-router", () => {
  const React = require("react") as typeof import("react");
  const { View } = require("react-native") as typeof import("react-native");
  return {
    Stack: {
      Screen: ({ options }: { options: Record<string, unknown> }) => {
        mockStackScreenOptions = options;
        return React.createElement(View, { testID: "mock-terminal-route-options" });
      },
    },
    useLocalSearchParams: () => ({ sessionId: "00000000-0000-4000-8000-000000000001" }),
    useRouter: () => ({ back: jest.fn() }),
  };
});

jest.mock("@/components/layout/screen", () => {
  const React = require("react") as typeof import("react");
  const { View } = require("react-native") as typeof import("react-native");
  return {
    Screen: ({ children, header }: React.PropsWithChildren<{ header?: React.ReactNode }>) =>
      React.createElement(View, { testID: "mock-screen" }, header, children),
  };
});

jest.mock("@/components/layout/app-header", () => {
  const React = require("react") as typeof import("react");
  const { View } = require("react-native") as typeof import("react-native");
  return {
    AppHeader: () => React.createElement(View, { testID: "mock-terminal-state-header" }),
  };
});

jest.mock("@/components/terminal-ui/terminal-overlay", () => {
  const React = require("react") as typeof import("react");
  const { View } = require("react-native") as typeof import("react-native");
  return {
    TerminalOverlay: () => React.createElement(View, { testID: "mock-terminal-overlay" }),
  };
});

jest.mock("@/data/queries/terminal", () => ({
  useTerminalData: () => mockTerminalData,
  useKillTerminalSession: () => ({ mutateAsync: jest.fn(async () => undefined) }),
  useRenameTerminalSession: () => ({ mutateAsync: jest.fn(async () => undefined) }),
  useRestartTerminalSession: () => ({ mutateAsync: jest.fn(async () => undefined) }),
}));

jest.mock("@/theme", () => {
  const actual = jest.requireActual<typeof import("@/theme")>("@/theme");
  return { ...actual, useTheme: () => actual.darkTheme };
});

function dataFor(state: "loading" | "error" | "connected"): MockTerminalData {
  if (state === "loading") {
    return {
      error: null,
      host: null,
      isLoading: true,
      refetch: jest.fn(async () => undefined),
      session: null,
    };
  }
  if (state === "error") {
    return {
      error: new Error("Unavailable"),
      host: null,
      isLoading: false,
      refetch: jest.fn(async () => undefined),
      session: null,
    };
  }
  return {
    error: null,
    host: { id: "host" },
    isLoading: false,
    refetch: jest.fn(async () => undefined),
    session: { id: "session" },
  };
}

describe("TerminalScreen dismissal", () => {
  beforeEach(() => {
    mockStackScreenOptions = {};
  });

  test.each(["loading", "error", "connected"] as const)(
    "uses one rounded full-screen card gesture while %s",
    async (state) => {
      mockTerminalData = dataFor(state);
      await render(<TerminalScreen />);

      expect(screen.getByTestId("mock-terminal-route-options")).toBeTruthy();
      expect(mockStackScreenOptions).toMatchObject(TERMINAL_ROUTE_GESTURE_OPTIONS);
      expect(mockStackScreenOptions).toMatchObject({
        animation: "simple_push",
        animationMatchesGesture: true,
        fullScreenGestureEnabled: true,
        fullScreenGestureShadowEnabled: true,
        gestureDirection: "horizontal",
        gestureEnabled: true,
        headerShown: false,
        presentation: "card",
      });
      expect(mockStackScreenOptions["contentStyle"]).toMatchObject({
        borderRadius: darkTheme.radii.xxl,
        overflow: "hidden",
      });
      expect(
        StyleSheet.flatten(screen.getByTestId("terminal-nav-clearance").props["style"])
          .paddingBottom,
      ).toBe(sizing.bottomNav.contentHeight + sizing.bottomNav.verticalPadding);
      // An omitted response distance is what lets the native recognizer begin at screen centre.
      expect(mockStackScreenOptions).not.toHaveProperty("gestureResponseDistance");
      if (state === "connected") {
        expect(screen.getByTestId("mock-terminal-overlay")).toBeTruthy();
        expect(screen.queryByTestId("mock-terminal-state-header")).toBeNull();
      } else {
        expect(screen.queryByTestId("mock-terminal-overlay")).toBeNull();
        expect(screen.getByTestId("mock-terminal-state-header")).toBeTruthy();
      }
    },
  );
});
