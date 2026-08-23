import { fireEvent, render } from "@testing-library/react-native";
import { createRef } from "react";
import { Text } from "react-native";

import { SwipeableRow, type SwipeableRowHandle } from "@/components/gestures/swipeable-row";
import { haptics } from "@/lib/haptics";
import { ThemeProvider } from "@/theme";

jest.mock("react-native-gesture-handler", () => {
  const gestureHandler = jest.requireActual<typeof import("react-native-gesture-handler")>(
    "react-native-gesture-handler",
  );
  return {
    ...gestureHandler,
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  };
});

jest.mock("@/lib/haptics", () => ({
  haptics: {
    impact: jest.fn(),
    warning: jest.fn(),
  },
}));

describe("SwipeableRow", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders leading and trailing icon-label actions", async () => {
    const screen = await render(
      <SwipeableRow
        leadingActions={[{ key: "move", label: "Move", icon: <Text>M</Text>, onPress: jest.fn() }]}
        trailingActions={[
          {
            key: "archive",
            label: "Archive",
            icon: (color) => <Text style={{ color }}>A</Text>,
            onPress: jest.fn(),
            tone: "destructive",
          },
        ]}
      >
        <Text>Workspace</Text>
      </SwipeableRow>,
      { wrapper: ThemeProvider },
    );

    expect(screen.getByText("Workspace")).toBeTruthy();
    expect(screen.getByLabelText("Move")).toBeTruthy();
    expect(screen.getByLabelText("Archive")).toBeTruthy();
  });

  it("fires a regular action callback and light haptic", async () => {
    const onPress = jest.fn();
    const screen = await render(
      <SwipeableRow leadingActions={[{ key: "move", label: "Move", icon: null, onPress }]}>
        <Text>Workspace</Text>
      </SwipeableRow>,
      { wrapper: ThemeProvider },
    );

    await fireEvent.press(screen.getByLabelText("Move"));

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(haptics.impact).toHaveBeenCalledWith("light");
  });

  it("fires a destructive action callback and warning haptic", async () => {
    const onPress = jest.fn();
    const screen = await render(
      <SwipeableRow
        trailingActions={[
          { key: "archive", label: "Archive", icon: null, onPress, tone: "destructive" },
        ]}
      >
        <Text>Workspace</Text>
      </SwipeableRow>,
      { wrapper: ThemeProvider },
    );

    await fireEvent.press(screen.getByLabelText("Archive"));

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(haptics.warning).toHaveBeenCalledTimes(1);
  });

  it("exposes a close method that settles the row at rest", async () => {
    const ref = createRef<SwipeableRowHandle>();
    await render(
      <SwipeableRow ref={ref}>
        <Text>Workspace</Text>
      </SwipeableRow>,
      { wrapper: ThemeProvider },
    );

    expect(ref.current).not.toBeNull();
    expect(() => ref.current?.close()).not.toThrow();
  });
});
