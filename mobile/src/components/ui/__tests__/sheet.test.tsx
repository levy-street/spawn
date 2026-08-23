import { act, fireEvent, render } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { Text as NativeText, StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { Sheet } from "@/components/ui/sheet";
import { ThemeProvider } from "@/theme";

/** The pan handlers the sheet registered, so a drag can be replayed here. */
interface MockCapturedPan {
  onBegin?: (() => void) | undefined;
  onUpdate?: ((event: { translationY: number }) => void) | undefined;
  onEnd?: ((event: { translationY: number; velocityY: number }) => void) | undefined;
  onTapEnd?: ((event: unknown, success: boolean) => void) | undefined;
}
let mockCapturedPan: MockCapturedPan = {};

jest.mock("react-native-gesture-handler", () => {
  const ReactModule = jest.requireActual("react") as typeof import("react");
  const Native = jest.requireActual("react-native") as typeof import("react-native");
  return {
    Gesture: {
      Pan: () => {
        const builder: Record<string, unknown> = {};
        builder["onBegin"] = (handler: () => void) => {
          mockCapturedPan.onBegin = handler;
          return builder;
        };
        builder["onUpdate"] = (handler: MockCapturedPan["onUpdate"]) => {
          mockCapturedPan.onUpdate = handler;
          return builder;
        };
        builder["onEnd"] = (handler: MockCapturedPan["onEnd"]) => {
          mockCapturedPan.onEnd = handler;
          return builder;
        };
        return builder;
      },
      Tap: () => {
        const builder: Record<string, unknown> = {};
        builder["maxDistance"] = () => builder;
        builder["onEnd"] = (handler: MockCapturedPan["onTapEnd"]) => {
          mockCapturedPan.onTapEnd = handler;
          return builder;
        };
        return builder;
      },
    },
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

function Providers({ children }: PropsWithChildren): React.JSX.Element {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider>{children}</ThemeProvider>
    </SafeAreaProvider>
  );
}

type RenderedSheet = Awaited<ReturnType<typeof render>>;

function measurePanel(screen: RenderedSheet, height: number): void {
  act(() => {
    fireEvent(screen.getByTestId("sheet-panel"), "layout", {
      nativeEvent: { layout: { height, width: 390, x: 0, y: 0 } },
    });
  });
}

describe("Sheet", () => {
  beforeEach(() => {
    mockCapturedPan = {};
  });

  // A dismissal leaves a close animation in flight. Left running it lands during
  // the next test's mount and swallows its render, so each test waits it out.

  it("presents into the window overlay so it clears the nav bar", async () => {
    const screen = await render(
      <Sheet onDismiss={jest.fn()} visible>
        <NativeText>Drawer body</NativeText>
      </Sheet>,
      { wrapper: Providers },
    );

    expect(screen.getByTestId("sheet-window-overlay")).toBeTruthy();
    expect(screen.getByText("Drawer body")).toBeTruthy();
    await screen.unmount();
  });

  it("owns the bottom safe-area inset", async () => {
    const screen = await render(
      <Sheet onDismiss={jest.fn()} visible>
        <NativeText>Drawer body</NativeText>
      </Sheet>,
      { wrapper: Providers },
    );

    const content = StyleSheet.flatten(screen.getByTestId("sheet-content").props["style"]);
    expect(content["paddingBottom"]).toBe(METRICS.insets.bottom);
    await screen.unmount();
  });

  it("settles back when the drag stops short", async () => {
    const onDismiss = jest.fn();
    const screen = await render(
      <Sheet onDismiss={onDismiss} visible>
        <NativeText>Drawer body</NativeText>
      </Sheet>,
      { wrapper: Providers },
    );
    measurePanel(screen, 300);

    act(() => mockCapturedPan.onEnd?.({ translationY: 12, velocityY: 0 }));
    expect(onDismiss).not.toHaveBeenCalled();
    await screen.unmount();
  });
});
