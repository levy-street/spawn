import { render } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { Dimensions, Text as NativeText, StyleSheet } from "react-native";
import { SafeAreaInsetsContext, SafeAreaProvider } from "react-native-safe-area-context";

import { Sheet } from "@/components/ui/sheet";
import { chrome, ThemeProvider } from "@/theme";

jest.mock("react-native-gesture-handler", () => {
  const ReactModule = jest.requireActual("react") as typeof import("react");
  const Native = jest.requireActual("react-native") as typeof import("react-native");
  const builder = (): Record<string, unknown> => {
    const stub: Record<string, unknown> = {};
    for (const key of ["maxDistance", "onBegin", "onUpdate", "onEnd", "onFinalize"]) {
      stub[key] = () => stub;
    }
    return stub;
  };
  return {
    Gesture: { Pan: builder, Tap: builder },
    GestureDetector: ({ children }: PropsWithChildren) =>
      ReactModule.createElement(Native.View, null, children),
  };
});

jest.mock("react-native-screens", () => {
  const ReactModule = jest.requireActual("react") as typeof import("react");
  const Native = jest.requireActual("react-native") as typeof import("react-native");
  return {
    FullWindowOverlay: ({ children }: PropsWithChildren) =>
      ReactModule.createElement(Native.View, { testID: "sheet-window-overlay" }, children),
  };
});

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

// The window's real insets, which a sheet at window level has to be able to
// reach even when the tree above it says otherwise.
jest.mock("react-native-safe-area-context", () => ({
  ...(jest.requireActual(
    "react-native-safe-area-context",
  ) as typeof import("react-native-safe-area-context")),
  initialWindowMetrics: {
    frame: { x: 0, y: 0, width: 390, height: 844 },
    insets: { top: 47, right: 0, bottom: 34, left: 0 },
  },
}));

function Providers({ children }: PropsWithChildren): React.JSX.Element {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider>{children}</ThemeProvider>
    </SafeAreaProvider>
  );
}

describe("Sheet size", () => {
  it("hugs its content by default", async () => {
    const screen = await render(
      <Sheet onDismiss={jest.fn()} visible>
        <NativeText>Drawer body</NativeText>
      </Sheet>,
      { wrapper: Providers },
    );

    const panel = StyleSheet.flatten(screen.getByTestId("sheet-panel").props["style"]);
    expect(panel["height"]).toBeUndefined();
    await screen.unmount();
  });

  it("claims the available height when told to stand tall", async () => {
    const screen = await render(
      <Sheet onDismiss={jest.fn()} size="tall" visible>
        <NativeText>Drawer body</NativeText>
      </Sheet>,
      { wrapper: Providers },
    );

    const panel = StyleSheet.flatten(screen.getByTestId("sheet-panel").props["style"]);
    const content = StyleSheet.flatten(screen.getByTestId("sheet-content").props["style"]);

    // A hugging panel gives its children no height to flex into, so a stepped or
    // scrolling sheet has to be handed the room explicitly.
    expect(panel["height"]).toBe(
      Dimensions.get("window").height - METRICS.insets.top - chrome.sheetTopClearance,
    );
    expect(panel["height"]).toBe(panel["maxHeight"]);
    expect(content["flex"]).toBe(1);
    await screen.unmount();
  });

  it("keeps its clearance under a dialog that zeroes the top inset", async () => {
    // A dialog hands its children `top: 0` — its own header already clears the
    // status bar. A sheet raised from inside one is not inside it, though: on
    // iOS it is a window-level overlay, and taking that zero at face value put
    // a tall sheet's grabber under the clock.
    const screen = await render(
      <SafeAreaInsetsContext.Provider value={{ ...METRICS.insets, top: 0 }}>
        <Sheet onDismiss={jest.fn()} size="tall" visible>
          <NativeText>Drawer body</NativeText>
        </Sheet>
      </SafeAreaInsetsContext.Provider>,
      { wrapper: Providers },
    );

    const panel = StyleSheet.flatten(screen.getByTestId("sheet-panel").props["style"]);
    expect(panel["height"]).toBe(
      Dimensions.get("window").height - METRICS.insets.top - chrome.sheetTopClearance,
    );
    await screen.unmount();
  });
});
