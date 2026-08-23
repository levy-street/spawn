import {
  projectedDismissalEndpoint,
  rubberBandTranslation,
  shouldDismissOverlay,
} from "@/components/ui/swipe-dismiss-overlay";

describe("overlay dismissal projection", () => {
  test("a slow short drag stays attached", () => {
    expect(shouldDismissOverlay({ translationY: 60, velocityY: 20, threshold: 100 })).toBe(false);
  });

  test("distance alone commits at the threshold", () => {
    expect(shouldDismissOverlay({ translationY: 100, velocityY: 0, threshold: 100 })).toBe(true);
  });

  test("a fast downward flick commits from a short distance", () => {
    expect(shouldDismissOverlay({ translationY: 20, velocityY: 500, threshold: 100 })).toBe(true);
  });

  test("upward velocity pulls the projected endpoint back below the threshold", () => {
    expect(shouldDismissOverlay({ translationY: 120, velocityY: -200, threshold: 100 })).toBe(
      false,
    );
  });

  test("an upward drag cannot commit even with a negative projected endpoint", () => {
    expect(shouldDismissOverlay({ translationY: -40, velocityY: -900, threshold: 100 })).toBe(
      false,
    );
    expect(projectedDismissalEndpoint({ translationY: -40, velocityY: -900 })).toBe(0);
  });

  test("a caller can disable velocity projection", () => {
    expect(
      shouldDismissOverlay({
        translationY: 20,
        velocityY: 900,
        threshold: 100,
        projectionSeconds: 0,
      }),
    ).toBe(false);
  });

  test("a non-positive threshold dismisses immediately", () => {
    expect(shouldDismissOverlay({ translationY: 0, velocityY: 0, threshold: 0 })).toBe(true);
  });
});

describe("overlay rubber band", () => {
  test("preserves direction while resisting displacement", () => {
    const down = rubberBandTranslation(400, 800);
    const up = rubberBandTranslation(-400, 800);
    expect(down).toBeGreaterThan(0);
    expect(down).toBeLessThan(400);
    expect(up).toBeLessThan(0);
    expect(Math.abs(up)).toBeLessThan(400);
  });

  test("resists the closed top edge more strongly than a dismissal drag", () => {
    expect(Math.abs(rubberBandTranslation(-100, 800))).toBeLessThan(
      rubberBandTranslation(100, 800),
    );
  });

  test("returns the bound for zero displacement or unusable geometry", () => {
    expect(rubberBandTranslation(0, 800)).toBe(0);
    expect(rubberBandTranslation(100, 0)).toBe(0);
  });
});
