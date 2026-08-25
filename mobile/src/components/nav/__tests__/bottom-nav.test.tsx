import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import {
  BottomNav,
  bottomNavDestinationForPath,
  isBottomNavRoute,
} from "@/components/nav/bottom-nav";
import { registerNavigationOverlayDismiss } from "@/components/nav/overlay-dismiss";
import { haptics } from "@/lib/haptics";
import { borderWidth, ThemeProvider } from "@/theme";

const mockDispatch = jest.fn();
const mockDismissAllSheets = jest.fn();
const mockNavigateRoute = jest.fn();
let mockPathname = "/workspaces";

interface MockState {
  type?: string;
  key?: string;
  index?: number;
  routes: { name: string; state?: MockState }[];
}

/** Nothing above the roots: every stack on the way down holds one screen. */
const ROOTS_ONLY: MockState = {
  type: "stack",
  key: "root",
  index: 0,
  routes: [
    {
      name: "(drawer)",
      state: { type: "stack", key: "drawer", index: 0, routes: [{ name: "(tabs)" }] },
    },
  ],
};

/** A host pushed over the tabs, and the terminal pushed over that at the root. */
const TERMINAL_OVER_HOST: MockState = {
  type: "stack",
  key: "root",
  index: 1,
  routes: [
    {
      name: "(drawer)",
      state: {
        type: "stack",
        key: "drawer",
        index: 1,
        routes: [{ name: "(tabs)" }, { name: "host/[id]/index" }],
      },
    },
    { name: "terminal/[sessionId]" },
  ],
};

let mockRootState: MockState = ROOTS_ONLY;

jest.mock("@/components/ui/sheet", () => ({
  // Read lazily: the factory is hoisted above the const it closes over.
  dismissAllSheets: () => mockDismissAllSheets(),
}));

jest.mock("expo-router", () => ({
  useNavigationContainerRef: () => ({
    dispatch: mockDispatch,
    getRootState: () => mockRootState,
    isReady: () => true,
  }),
  usePathname: () => mockPathname,
  useRouter: () => ({ navigate: mockNavigateRoute }),
}));

jest.mock("@/lib/haptics", () => ({
  haptics: { selection: jest.fn() },
}));

jest.mock("react-native-keyboard-controller", () => {
  const { makeMutable } =
    require("react-native-reanimated") as typeof import("react-native-reanimated");
  return {
    __mockKeyboardProgress: makeMutable(0),
    useReanimatedKeyboardAnimation() {
      const { __mockKeyboardProgress: progress } = require("react-native-keyboard-controller") as {
        __mockKeyboardProgress: { value: number };
      };
      return { height: makeMutable(0), progress };
    },
  };
});

const { __mockKeyboardProgress: mockKeyboardProgress } =
  require("react-native-keyboard-controller") as { __mockKeyboardProgress: { value: number } };

const BAR_HEIGHT = 68;

const INSETS = { bottom: 34, left: 0, right: 0, top: 59 };
function nav() {
  return (
    <SafeAreaInsetsContext.Provider value={INSETS}>
      <ThemeProvider>
        <BottomNav />
      </ThemeProvider>
    </SafeAreaInsetsContext.Provider>
  );
}

function renderNav(pathname: string) {
  mockPathname = pathname;
  return render(nav());
}

describe("BottomNav", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRootState = ROOTS_ONLY;
  });

  it("rides the keyboard down instead of ghosting through it", async () => {
    mockKeyboardProgress.value = 0;
    const screen = await renderNav("/workspaces");
    const bar = screen.getByTestId("bottom-nav");
    await act(() => {
      fireEvent(bar, "layout", {
        nativeEvent: { layout: { height: BAR_HEIGHT, width: 390, x: 0, y: 0 } },
      });
    });

    expect(bar).toHaveAnimatedStyle({ transform: [{ translateY: 0 }] });

    await act(() => {
      mockKeyboardProgress.value = 1;
    });

    // Exactly its own height: the bar is off the bottom of the screen, not
    // sitting behind a translucent keyboard.
    expect(bar).toHaveAnimatedStyle({ transform: [{ translateY: BAR_HEIGHT }] });
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
  });

  it("keeps the current destination selected over a pushed screen", async () => {
    const screen = await renderNav("/host/one");

    expect(screen.getByRole("tab", { name: "Legion" }).props["accessibilityState"]).toEqual({
      selected: true,
    });
    expect(screen.getByRole("tab", { name: "Workspaces" }).props["accessibilityState"]).toEqual({
      selected: false,
    });
  });

  // Detail screens are pushed over the tab host now rather than being tabs of
  // their own, so a nav tap has exactly one behaviour: clear anything covering
  // the tabs, then focus that destination's root.
  it("switches tabs by focusing the destination root", async () => {
    const screen = await renderNav("/workspaces");

    await fireEvent.press(screen.getByRole("tab", { name: "Settings" }));

    expect(haptics.selection).toHaveBeenCalledTimes(1);
    expect(mockDismissAllSheets).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockNavigateRoute).toHaveBeenCalledWith("/settings"));
  });

  it("pops every stack on the way down, not only the nearest one", async () => {
    // A terminal over a host over the tabs: `dismissAll` only ever popped the
    // terminal, which left the host standing over the destination tab.
    mockRootState = TERMINAL_OVER_HOST;
    const screen = await renderNav("/terminal/one");

    await fireEvent.press(screen.getByRole("tab", { name: "Legion" }));

    await waitFor(() => expect(mockNavigateRoute).toHaveBeenCalledWith("/hosts"));
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "POP_TO_TOP", target: "root" }),
    );
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "POP_TO_TOP", target: "drawer" }),
    );
    expect(mockDispatch).toHaveBeenCalledTimes(2);
  });

  it("closes registered overlays before landing on a destination root", async () => {
    const onDismiss = jest.fn();
    const unregister = registerNavigationOverlayDismiss(onDismiss);
    mockRootState = TERMINAL_OVER_HOST;
    const screen = await renderNav("/workspaces");

    await fireEvent.press(screen.getByRole("tab", { name: "Legion" }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockNavigateRoute).toHaveBeenCalledWith("/hosts"));
    expect(mockDispatch).toHaveBeenCalled();
    unregister();
  });

  it("leaves the stack alone when there is nothing above the roots", async () => {
    // Dispatching a pop with nothing to pop is an unhandled action, which React
    // Navigation reports — on every single nav tap.
    const screen = await renderNav("/workspaces");

    await fireEvent.press(screen.getByRole("tab", { name: "Legion" }));

    await waitFor(() => expect(mockNavigateRoute).toHaveBeenCalledWith("/hosts"));
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("owns its bottom safe-area inset and top hairline", async () => {
    const screen = await renderNav("/workspaces");
    const style = StyleSheet.flatten(screen.getByTestId("bottom-nav").props["style"]);

    expect(style.paddingBottom).toBe(INSETS.bottom);
    expect(style.borderTopWidth).toBe(borderWidth.hairline);
  });
});
