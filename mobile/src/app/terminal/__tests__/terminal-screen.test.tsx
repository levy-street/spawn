import { act, render, screen } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import TerminalScreen, { TERMINAL_ROUTE_GESTURE_OPTIONS } from "@/app/terminal/[sessionId]";
import type { KillTerminalSessionResult } from "@/data/queries/terminal";
import { darkTheme } from "@/theme";
import { bottomNavHeight } from "@/theme/sizing";

const INSETS = { top: 47, left: 0, right: 0, bottom: 34 };

function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: INSETS }}
    >
      <TerminalScreen />
    </SafeAreaProvider>,
  );
}

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

interface MockOverlayProps {
  onKill?: () => Promise<void>;
}

let mockOverlayProps: MockOverlayProps = {};

jest.mock("@/components/terminal-ui/terminal-overlay", () => {
  const React = require("react") as typeof import("react");
  const { View } = require("react-native") as typeof import("react-native");
  return {
    TerminalOverlay: (props: MockOverlayProps) => {
      mockOverlayProps = props;
      return React.createElement(View, { testID: "mock-terminal-overlay" });
    },
  };
});

const mockKill = jest.fn<Promise<KillTerminalSessionResult>, []>(async () => ({
  alreadyGone: false,
  paneError: null,
}));

jest.mock("@/data/queries/terminal", () => ({
  useTerminalData: () => mockTerminalData,
  useKillTerminalSession: () => ({ mutateAsync: mockKill }),
  useRenameTerminalSession: () => ({ mutateAsync: jest.fn(async () => undefined) }),
  useRestartTerminalSession: () => ({ mutateAsync: jest.fn(async () => undefined) }),
}));

const mockToast = {
  show: jest.fn(),
  success: jest.fn(),
  error: jest.fn(),
  dismiss: jest.fn(),
  clear: jest.fn(),
};

jest.mock("@/components/ui/toast", () => ({ useToast: () => mockToast }));

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
    session: { id: "session", name: "Build" },
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
      await renderScreen();

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
        borderRadius: darkTheme.radii.device,
        overflow: "hidden",
      });
      // An omitted response distance is what lets the native recognizer begin at screen centre.
      expect(mockStackScreenOptions).not.toHaveProperty("gestureResponseDistance");
      if (state === "connected") {
        expect(screen.getByTestId("mock-terminal-overlay")).toBeTruthy();
        expect(screen.queryByTestId("mock-terminal-state-header")).toBeNull();
        // The overlay reserves the nav bar itself, and gives that reservation
        // back when the keyboard covers the bar; a wrapper here could not.
        expect(screen.queryByTestId("terminal-nav-clearance")).toBeNull();
      } else {
        expect(screen.queryByTestId("mock-terminal-overlay")).toBeNull();
        expect(screen.getByTestId("mock-terminal-state-header")).toBeTruthy();
        expect(
          StyleSheet.flatten(screen.getByTestId("terminal-nav-clearance").props["style"])
            .paddingBottom,
        ).toBe(bottomNavHeight(INSETS.bottom));
      }
    },
  );
});

describe("TerminalScreen kill reporting", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOverlayProps = {};
    mockTerminalData = dataFor("connected");
  });

  test("names the killed session in a toast the closing screen cannot swallow", async () => {
    await renderScreen();

    await act(async () => {
      await mockOverlayProps.onKill?.();
    });

    expect(mockKill).toHaveBeenCalledTimes(1);
    expect(mockToast.success).toHaveBeenCalledWith("Session killed", { detail: "Build" });
  });

  test("says so when the session was already gone", async () => {
    mockKill.mockResolvedValueOnce({ alreadyGone: true, paneError: null });
    await renderScreen();

    await act(async () => {
      await mockOverlayProps.onKill?.();
    });

    expect(mockToast.success).toHaveBeenCalledWith("Session removed", {
      detail: "It had already ended on the host.",
    });
  });

  test("separates a pane that stayed behind from a kill that failed", async () => {
    mockKill.mockResolvedValueOnce({
      alreadyGone: false,
      paneError: new Error("workspace patch rejected"),
    });
    await renderScreen();

    await act(async () => {
      await mockOverlayProps.onKill?.();
    });

    expect(mockToast.error).toHaveBeenCalledWith(
      "Session killed, but its pane stayed in the workspace",
      {
        detail: "workspace patch rejected",
      },
    );
  });

  test("reports a kill the server refused without rethrowing at the closed screen", async () => {
    mockKill.mockRejectedValueOnce(new Error("host is offline"));
    await renderScreen();

    await act(async () => {
      await expect(mockOverlayProps.onKill?.()).resolves.toBeUndefined();
    });

    expect(mockToast.error).toHaveBeenCalledWith("Session could not be killed", {
      detail: "host is offline",
    });
  });
});
