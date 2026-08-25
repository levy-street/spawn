import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";

import { UnderlineTabs } from "@/components/ui/underline-tabs";
import { ThemeProvider } from "@/theme";

/** The pan handlers the strip registered, so a drag can be replayed here. */
interface MockCapturedPan {
  onStart?: (() => void) | undefined;
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
        builder["onStart"] = (handler: MockCapturedPan["onStart"]) => {
          mockCapturedPan.onStart = handler;
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
    },
    GestureDetector: ({ children }: PropsWithChildren) =>
      ReactModule.createElement(Native.View, null, children),
  };
});

jest.mock("@/lib/haptics", () => ({ haptics: { selection: jest.fn() } }));

const OPTIONS = [
  { value: "hosted", label: "spawnd.dev" },
  { value: "own", label: "Self-hosted" },
] as const;

async function renderStrip(onChange: jest.Mock, value: "hosted" | "own" = "hosted") {
  await render(
    <ThemeProvider>
      <UnderlineTabs
        accessibilityLabel="Server"
        onChange={onChange}
        options={OPTIONS}
        testID="tabs"
        value={value}
      />
    </ThemeProvider>,
  );
  await act(() =>
    fireEvent(screen.getByTestId("tabs"), "layout", {
      nativeEvent: { layout: { height: 44, width: 320, x: 0, y: 0 } },
    }),
  );
}

describe("UnderlineTabs", () => {
  beforeEach(() => {
    mockCapturedPan = {};
  });

  it("is a tab list whose chosen tab is marked, and taps choose", async () => {
    const onChange = jest.fn();
    await renderStrip(onChange);

    expect(screen.getByRole("tab", { name: "spawnd.dev" }).props["accessibilityState"]).toEqual({
      selected: true,
    });
    expect(screen.getByTestId("tabs-indicator")).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole("tab", { name: "Self-hosted" }));
    expect(onChange).toHaveBeenCalledWith("own");
    // Tapping the tab already chosen is not a change.
    await fireEvent.press(screen.getByRole("tab", { name: "spawnd.dev" }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("follows a drag: short of halfway it settles back, past it or flicked it lets go", async () => {
    const onChange = jest.fn();
    await renderStrip(onChange);

    // Two tabs across 320pt: each is 160 wide. Not far enough: nothing changes.
    await act(async () => {
      mockCapturedPan.onStart?.();
      mockCapturedPan.onUpdate?.({ translationX: 40 });
      mockCapturedPan.onEnd?.({ translationX: 40, velocityX: 0 });
    });
    expect(onChange).not.toHaveBeenCalled();

    // Barely moved, but thrown hard: the projection carries it across.
    act(() => {
      mockCapturedPan.onStart?.();
      mockCapturedPan.onUpdate?.({ translationX: 20 });
      mockCapturedPan.onEnd?.({ translationX: 20, velocityX: 1200 });
    });
    // The commit crosses back to JS, which the mock defers a tick.
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("own"));
    onChange.mockClear();

    // Dragged most of the way over and let go: the nearest tab wins.
    act(() => {
      mockCapturedPan.onStart?.();
      mockCapturedPan.onUpdate?.({ translationX: 120 });
      mockCapturedPan.onEnd?.({ translationX: 120, velocityX: 0 });
    });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("own"));
  });
});
