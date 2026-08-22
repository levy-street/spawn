import { act, render } from "@testing-library/react-native";
import { Text } from "react-native";

import { FullSurfaceDismiss } from "@/components/terminal-ui/full-surface-dismiss";
import { haptics } from "@/lib/haptics";

type TouchDownHandler = (event: {
  allTouches: Array<{ absoluteX: number; absoluteY: number }>;
}) => void;
type TouchMoveHandler = (
  event: { allTouches: Array<{ absoluteX: number; absoluteY: number }> },
  manager: { activate(): void; fail(): void },
) => void;
type UpdateHandler = (event: { translationX: number; velocityX: number }) => void;

interface MockPanHandlers {
  onTouchesDown?: TouchDownHandler;
  onTouchesMove?: TouchMoveHandler;
  onUpdate?: UpdateHandler;
}

interface MockPanChain {
  manualActivation(value: boolean): MockPanChain;
  maxPointers(value: number): MockPanChain;
  cancelsTouchesInView(value: boolean): MockPanChain;
  shouldCancelWhenOutside(value: boolean): MockPanChain;
  onTouchesDown(handler: TouchDownHandler): MockPanChain;
  onTouchesMove(handler: TouchMoveHandler): MockPanChain;
  onUpdate(handler: UpdateHandler): MockPanChain;
  onEnd(handler: unknown): MockPanChain;
  onFinalize(handler: unknown): MockPanChain;
}

let mockPanHandlers: MockPanHandlers = {};

jest.mock("react-native-gesture-handler", () => {
  const React = require("react") as typeof import("react");
  const chain: MockPanChain = {
    manualActivation: () => chain,
    maxPointers: () => chain,
    cancelsTouchesInView: () => chain,
    shouldCancelWhenOutside: () => chain,
    onTouchesDown: (handler) => {
      mockPanHandlers.onTouchesDown = handler;
      return chain;
    },
    onTouchesMove: (handler) => {
      mockPanHandlers.onTouchesMove = handler;
      return chain;
    },
    onUpdate: (handler) => {
      mockPanHandlers.onUpdate = handler;
      return chain;
    },
    onEnd: () => chain,
    onFinalize: () => chain,
  };
  return {
    Gesture: { Pan: () => chain },
    GestureDetector: ({ children }: React.PropsWithChildren) => children,
  };
});

jest.mock("react-native-worklets", () => ({
  scheduleOnRN: (operation: (...args: unknown[]) => void, ...args: unknown[]) => operation(...args),
}));

jest.mock("@/lib/haptics", () => ({
  haptics: { overlayDismiss: jest.fn() },
}));

jest.mock("@/lib/motion/reduced-motion", () => ({
  useReducedMotion: () => false,
}));

jest.mock("@/theme", () => {
  const actual = jest.requireActual<typeof import("@/theme")>("@/theme");
  return { ...actual, useTheme: () => actual.darkTheme };
});

describe("FullSurfaceDismiss", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPanHandlers = {};
  });

  test("fails vertical movement so the terminal keeps scroll ownership", async () => {
    await render(
      <FullSurfaceDismiss onDismiss={jest.fn()}>
        <Text>Terminal</Text>
      </FullSurfaceDismiss>,
    );
    const manager = { activate: jest.fn(), fail: jest.fn() };

    await act(() => {
      mockPanHandlers.onTouchesDown?.({ allTouches: [{ absoluteX: 100, absoluteY: 100 }] });
      mockPanHandlers.onTouchesMove?.(
        { allTouches: [{ absoluteX: 103, absoluteY: 126 }] },
        manager,
      );
    });

    expect(manager.fail).toHaveBeenCalledTimes(1);
    expect(manager.activate).not.toHaveBeenCalled();
  });

  test("fires one threshold haptic while rightward movement remains committed", async () => {
    await render(
      <FullSurfaceDismiss onDismiss={jest.fn()}>
        <Text>Terminal</Text>
      </FullSurfaceDismiss>,
    );
    const manager = { activate: jest.fn(), fail: jest.fn() };

    await act(() => {
      mockPanHandlers.onTouchesDown?.({ allTouches: [{ absoluteX: 100, absoluteY: 100 }] });
      mockPanHandlers.onTouchesMove?.(
        { allTouches: [{ absoluteX: 120, absoluteY: 103 }] },
        manager,
      );
      mockPanHandlers.onUpdate?.({ translationX: 50, velocityX: 0 });
      mockPanHandlers.onUpdate?.({ translationX: 200, velocityX: 0 });
      mockPanHandlers.onUpdate?.({ translationX: 240, velocityX: 0 });
    });

    expect(manager.activate).toHaveBeenCalledTimes(1);
    expect(manager.fail).not.toHaveBeenCalled();
    expect(haptics.overlayDismiss).toHaveBeenCalledTimes(1);
  });
});
