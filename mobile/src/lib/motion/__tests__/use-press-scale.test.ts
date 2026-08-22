import { act, renderHook } from "@testing-library/react-native";
import { withTiming } from "react-native-reanimated";

import { usePressScale } from "@/lib/motion/use-press-scale";

jest.mock("react-native-reanimated", () => {
  const reanimated =
    jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated");
  return {
    ...reanimated,
    withTiming: jest.fn((value: number) => value),
  };
});

describe("usePressScale", () => {
  beforeEach(() => {
    jest.mocked(withTiming).mockClear();
  });

  it("provides reusable press handlers and an animated style", async () => {
    const { result } = await renderHook(() => usePressScale({ pressedScale: 0.95 }));

    expect(result.current.animatedStyle).toBeDefined();

    await act(() => result.current.onPressIn());
    expect(withTiming).toHaveBeenLastCalledWith(0.95, expect.objectContaining({ duration: 150 }));

    await act(() => result.current.onPressOut());
    expect(withTiming).toHaveBeenLastCalledWith(1, expect.objectContaining({ duration: 150 }));
  });

  it("ignores press-in while disabled", async () => {
    const { result } = await renderHook(() =>
      usePressScale({ disabled: true, pressedScale: 0.95 }),
    );

    jest.mocked(withTiming).mockClear();
    await act(() => result.current.onPressIn());
    expect(withTiming).not.toHaveBeenCalled();
  });
});
