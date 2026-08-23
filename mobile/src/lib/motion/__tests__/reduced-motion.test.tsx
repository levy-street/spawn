import { act, renderHook, waitFor } from "@testing-library/react-native";
import { AccessibilityInfo } from "react-native";

import { motionSafe, useReducedMotion } from "@/lib/motion/reduced-motion";

describe("reduced motion", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(AccessibilityInfo.isReduceMotionEnabled).mockResolvedValue(false);
  });

  it("selects the fallback when reduced motion is enabled", () => {
    expect(motionSafe("slide", "still", true)).toBe("still");
    expect(motionSafe("slide", "still", false)).toBe("slide");
    expect(motionSafe("slide", "still")).toBe("slide");
  });

  it("reads the current system preference", async () => {
    jest.mocked(AccessibilityInfo.isReduceMotionEnabled).mockResolvedValueOnce(true);

    const { result } = await renderHook(useReducedMotion);

    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });

  it("updates when the system preference changes", async () => {
    let listener: ((enabled: boolean) => void) | undefined;
    jest.spyOn(AccessibilityInfo, "addEventListener").mockImplementationOnce(((
      event: string,
      handler: (enabled: boolean) => void,
    ) => {
      if (event === "reduceMotionChanged") {
        listener = handler;
      }
      return { remove: jest.fn() };
    }) as unknown as typeof AccessibilityInfo.addEventListener);

    const { result } = await renderHook(useReducedMotion);

    await act(() => listener?.(true));
    expect(result.current).toBe(true);
  });
});
