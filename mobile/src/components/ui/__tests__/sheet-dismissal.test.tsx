import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { Text as NativeText } from "react-native";
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

describe("Sheet dismissal", () => {
  beforeEach(() => {
    mockCapturedPan = {};
  });

  // On its own, because a completed pan animation leaves the test renderer unable
  // to mount another sheet in the same file.
  it("tracks a downward drag and dismisses past the threshold", async () => {
    const onDismiss = jest.fn();
    const screen = await render(
      <Sheet onDismiss={onDismiss} visible>
        <NativeText>Drawer body</NativeText>
      </Sheet>,
      { wrapper: Providers },
    );
    measurePanel(screen, 300);

    // The drag writes straight to the sheet's position, so a partial drag is
    // followed rather than snapped, and only a release decides the outcome.
    act(() => mockCapturedPan.onUpdate?.({ translationY: 40 }));
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => mockCapturedPan.onEnd?.({ translationY: 160, velocityY: 900 }));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
    await screen.unmount();
  });
});
