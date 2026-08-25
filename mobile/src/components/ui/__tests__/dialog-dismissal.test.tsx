import { act, render, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { Text as NativeText } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { Dialog } from "@/components/ui/dialog";
import { ThemeProvider } from "@/theme";

/** The pan handlers the dialog registered, so a swipe can be replayed here. */
interface MockCapturedPan {
  onUpdate?: ((event: { translationX: number }) => void) | undefined;
  onEnd?: ((event: { translationX: number; velocityX: number }) => void) | undefined;
}
let mockCapturedPan: MockCapturedPan = {};

jest.mock("react-native-gesture-handler", () => {
  const ReactModule = jest.requireActual("react") as typeof import("react");
  const Native = jest.requireActual("react-native") as typeof import("react-native");
  return {
    Gesture: {
      Pan: () => {
        const builder: Record<string, unknown> = {};
        builder["activeOffsetX"] = () => builder;
        builder["failOffsetY"] = () => builder;
        builder["onStart"] = () => builder;
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

describe("Dialog dismissal", () => {
  beforeEach(() => {
    mockCapturedPan = {};
  });

  it("leaves on a rightward swipe past the threshold", async () => {
    const onDismiss = jest.fn();
    const screen = await render(
      <Dialog onDismiss={onDismiss} title="New workspace" visible>
        <NativeText>Form body</NativeText>
      </Dialog>,
      { wrapper: Providers },
    );

    await waitFor(() => expect(screen.getByText("Form body")).toBeTruthy());
    act(() => mockCapturedPan.onUpdate?.({ translationX: 160 }));
    act(() => mockCapturedPan.onEnd?.({ translationX: 160, velocityX: 900 }));

    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
    await screen.unmount();
  });

  it("stays put when the drag is pulled back short of the threshold", async () => {
    const onDismiss = jest.fn();
    const screen = await render(
      <Dialog onDismiss={onDismiss} title="New workspace" visible>
        <NativeText>Form body</NativeText>
      </Dialog>,
      { wrapper: Providers },
    );

    act(() => mockCapturedPan.onUpdate?.({ translationX: 120 }));
    act(() => mockCapturedPan.onEnd?.({ translationX: 12, velocityX: 0 }));

    // Pulled back before release: the surface springs home and the caller hears
    // nothing about it.
    expect(onDismiss).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it("does not tell a caller that closed it that it has closed", async () => {
    const onDismiss = jest.fn();
    const dialog = (visible: boolean) => (
      <Dialog onDismiss={onDismiss} title="New workspace" visible={visible}>
        <NativeText>Form body</NativeText>
      </Dialog>
    );
    const screen = await render(dialog(true), { wrapper: Providers });

    // The surface stays mounted to run the arrival in reverse, but the caller has
    // already torn down its own state — telling it again would undo work twice.
    await screen.rerender(dialog(false));
    await waitFor(() => expect(screen.queryByText("Form body")).toBeNull());

    expect(onDismiss).not.toHaveBeenCalled();
    await screen.unmount();
  });
});
