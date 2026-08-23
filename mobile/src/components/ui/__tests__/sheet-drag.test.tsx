import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { Text as NativeText, StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { Sheet } from "@/components/ui/sheet";
import { radii, ThemeProvider } from "@/theme";

/** The handlers each gesture registered, so one can be replayed here. */
interface MockCapturedGestures {
  panUpdate?: ((event: { translationY: number }) => void) | undefined;
  panEnd?: ((event: { translationY: number; velocityY: number }) => void) | undefined;
  tapEnd?: ((event: unknown, success: boolean) => void) | undefined;
  tapMaxDistance?: number | undefined;
}
const mockGestures: MockCapturedGestures = {};

jest.mock("react-native-gesture-handler", () => {
  const ReactModule = jest.requireActual("react") as typeof import("react");
  const Native = jest.requireActual("react-native") as typeof import("react-native");
  return {
    Gesture: {
      Pan: () => {
        const builder: Record<string, unknown> = {};
        builder["onBegin"] = () => builder;
        builder["onUpdate"] = (handler: MockCapturedGestures["panUpdate"]) => {
          mockGestures.panUpdate = handler;
          return builder;
        };
        builder["onEnd"] = (handler: MockCapturedGestures["panEnd"]) => {
          mockGestures.panEnd = handler;
          return builder;
        };
        return builder;
      },
      Tap: () => {
        const builder: Record<string, unknown> = {};
        builder["maxDistance"] = (distance: number) => {
          mockGestures.tapMaxDistance = distance;
          return builder;
        };
        builder["onEnd"] = (handler: MockCapturedGestures["tapEnd"]) => {
          mockGestures.tapEnd = handler;
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

/** Long enough for a close animation to have run and reported back, had one started. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
}

/**
 * One sheet, one uninterrupted sequence: a mount per assertion leaves a close
 * animation in flight that swallows the next render.
 */
describe("Sheet drag", () => {
  it("closes on a scrim tap but never on a drag that was pulled back up", async () => {
    const onDismiss = jest.fn();
    const screen = await render(
      <Sheet onDismiss={onDismiss} visible>
        <NativeText>Drawer body</NativeText>
      </Sheet>,
      { wrapper: Providers },
    );
    act(() => {
      fireEvent(screen.getByTestId("sheet-panel"), "layout", {
        nativeEvent: { layout: { height: 300, width: 390, x: 0, y: 0 } },
      });
    });

    // The foot only clears the screen edge while the sheet is being dragged, so
    // it has to follow the display's curve rather than cut a square across it.
    const panel = StyleSheet.flatten(screen.getByTestId("sheet-panel").props["style"]);
    expect(panel["borderBottomLeftRadius"]).toBe(radii.device);
    expect(panel["borderBottomRightRadius"]).toBe(radii.device);

    // Pulled a long way down and then back up before release: the outcome is read
    // from where the sheet would come to rest, not from how far it once travelled.
    act(() => mockGestures.panUpdate?.({ translationY: 220 }));
    act(() => mockGestures.panEnd?.({ translationY: 120, velocityY: -900 }));
    await settle();
    expect(onDismiss).not.toHaveBeenCalled();

    // The scrim's tap is a real gesture, so a drag that started up there fails it
    // rather than dismissing on release the way its touch handler used to.
    expect(mockGestures.tapMaxDistance).toBe(6);
    act(() => mockGestures.tapEnd?.(undefined, false));
    await settle();
    expect(onDismiss).not.toHaveBeenCalled();

    // A tap that stayed put still closes it.
    act(() => mockGestures.tapEnd?.(undefined, true));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));

    await screen.unmount();
  });
});
