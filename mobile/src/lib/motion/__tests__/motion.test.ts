import { durations } from "@/lib/motion/durations";
import { easingCurves, easings } from "@/lib/motion/easings";
import { duration, easing, easingCurve } from "@/theme";

describe("motion aliases", () => {
  it("matches the documented interaction durations", () => {
    expect(durations).toEqual({
      menu: 100,
      press: 150,
      control: 150,
      shell: 200,
      toastEnter: 200,
      drawer: 220,
      sheet: 220,
      toastExit: 150,
      toastRemoval: 180,
      toastInfo: 5000,
      toastAlert: 7000,
      toastError: 8000,
      skeletonShimmer: 2000,
    });
    expect(durations.press).toBe(duration.base);
    expect(durations.shell).toBe(duration.medium);
    expect(durations.sheet).toBe(duration.panel);
  });

  it("matches the standard and shell cubic-bezier curves", () => {
    expect(easingCurves.standard).toEqual([0.4, 0, 0.2, 1]);
    expect(easingCurves.shell).toEqual([0.32, 0.72, 0, 1]);
    expect(easingCurves.standard).toBe(easingCurve.inOut);
    expect(easingCurves.shell).toBe(easingCurve.swift);
    expect(easings.standard).toBe(easing.inOut);
    expect(easings.shell).toBe(easing.swift);
  });
});
