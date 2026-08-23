import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { Toast, type ToastRecord } from "@/components/ui/toast";
import { radii, ThemeProvider } from "@/theme";

interface PanEvent {
  translationX: number;
  translationY: number;
  velocityX: number;
  velocityY: number;
}

/** The handlers the pan gesture registered, so a drag can be replayed here. */
const mockGestures: {
  panUpdate?: (event: PanEvent) => void;
  panEnd?: (event: PanEvent) => void;
} = {};

jest.mock("react-native-gesture-handler", () => {
  const ReactModule = jest.requireActual("react") as typeof import("react");
  const Native = jest.requireActual("react-native") as typeof import("react-native");
  return {
    Gesture: {
      Pan: () => {
        const builder: Record<string, unknown> = {};
        builder["onUpdate"] = (handler: (event: PanEvent) => void) => {
          mockGestures.panUpdate = handler;
          return builder;
        };
        builder["onEnd"] = (handler: (event: PanEvent) => void) => {
          mockGestures.panEnd = handler;
          return builder;
        };
        return builder;
      },
    },
    GestureDetector: ({ children }: PropsWithChildren) =>
      ReactModule.createElement(Native.View, null, children),
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

function notice(): ToastRecord {
  return {
    id: "notice",
    message: "Connected",
    variant: "success",
    durationMs: 5_000,
    expiresAt: 10_000,
    leaving: false,
  };
}

/** Long enough for an exit animation to have run and reported back. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
}

async function showToast(onDismiss: jest.Mock) {
  const screen = await render(<Toast onDismiss={onDismiss} toast={notice()} />, {
    wrapper: Providers,
  });
  act(() => {
    fireEvent(screen.getByTestId("toast-notice"), "layout", {
      nativeEvent: { layout: { height: 72, width: 390, x: 0, y: 0 } },
    });
  });
  return screen;
}

/**
 * One toast, one uninterrupted sequence: a mount per assertion leaves an exit
 * animation in flight that swallows the next render.
 */
describe("Toast dismissal", () => {
  it("spans the top and clears upward or sideways, never downward", async () => {
    const onDismiss = jest.fn();
    const screen = await showToast(onDismiss);

    // A slab that fills its host, which is the page's measure less a gutter
    // either side; the host is what centres it.
    const slab = StyleSheet.flatten(screen.getByTestId("toast-notice").props["style"]);
    expect(slab["width"]).toBe("100%");
    expect(slab["borderWidth"]).toBe(1);
    expect(slab["borderRadius"]).toBe(radii.xxl);
    expect(slab["overflow"]).toBeUndefined();

    // Dragged down and released: it is pinned to the top, so this springs back.
    act(() =>
      mockGestures.panUpdate?.({
        translationX: 0,
        translationY: 90,
        velocityX: 0,
        velocityY: 0,
      }),
    );
    act(() =>
      mockGestures.panEnd?.({ translationX: 0, translationY: 90, velocityX: 0, velocityY: 200 }),
    );
    await settle();
    expect(onDismiss).not.toHaveBeenCalled();

    // Up past the threshold: gone, the way it arrived.
    act(() =>
      mockGestures.panEnd?.({ translationX: 0, translationY: -40, velocityX: 0, velocityY: -600 }),
    );
    await waitFor(() => expect(onDismiss).toHaveBeenCalledWith("notice"));

    // And sideways clears it just the same.
    act(() =>
      mockGestures.panEnd?.({ translationX: -200, translationY: 0, velocityX: -400, velocityY: 0 }),
    );
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(2));

    await screen.unmount();
  });
});
