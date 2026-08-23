import {
  advanceDismissHaptic,
  horizontalDismissIntent,
  rubberBandHorizontalDismiss,
} from "@/components/terminal-ui/horizontal-dismiss";

const AXIS_LOCK = {
  activationDistance: 8,
  crossAxisFailureDistance: 24,
} as const;

describe("horizontal terminal dismissal", () => {
  test.each([
    ["horizontal intent", 12, 3, "activate"],
    ["vertical intent", 3, 25, "fail"],
    ["leftward intent", -9, 1, "fail"],
    ["horizontal-major diagonal", 20, 15, "activate"],
    ["equal diagonal", 12, 12, "pending"],
    ["uncommitted movement", 7, 2, "pending"],
  ])("axis-locks %s", (_label, deltaX, deltaY, expected) => {
    expect(horizontalDismissIntent({ deltaX, deltaY, ...AXIS_LOCK })).toBe(expected);
  });

  test("fires threshold feedback exactly once per gesture", () => {
    let fired = false;
    let fireCount = 0;

    for (const committed of [false, true, true, false, true]) {
      const gate = advanceDismissHaptic(committed, fired);
      fired = gate.fired;
      if (gate.shouldFire) fireCount += 1;
    }

    expect(fireCount).toBe(1);
  });

  test("rubber-bands rightward movement and rejects leftward movement", () => {
    expect(rubberBandHorizontalDismiss(-20, 400)).toBe(0);
    expect(rubberBandHorizontalDismiss(0, 400)).toBe(0);
    expect(rubberBandHorizontalDismiss(200, 400)).toBeGreaterThan(0);
    expect(rubberBandHorizontalDismiss(200, 400)).toBeLessThan(200);
    expect(rubberBandHorizontalDismiss(200, 0)).toBe(0);
  });
});
