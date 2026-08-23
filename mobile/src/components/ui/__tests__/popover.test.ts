import {
  type PopoverAnchorRect,
  pointPopoverAnchor,
  positionPopover,
} from "@/components/ui/popover";

const VIEWPORT = { viewportWidth: 1200, viewportHeight: 800 };

function anchor(partial: Partial<PopoverAnchorRect> = {}): PopoverAnchorRect {
  return { top: 100, bottom: 128, left: 200, right: 228, ...partial };
}

describe("positionPopover vertical placement", () => {
  test("drops below and start-aligns when there is room", () => {
    expect(
      positionPopover({
        anchor: anchor(),
        popoverWidth: 176,
        popoverHeight: 120,
        align: "start",
        ...VIEWPORT,
      }),
    ).toMatchObject({ left: 200, top: 132, side: "bottom" });
  });

  test("end-aligns the trailing edges", () => {
    const result = positionPopover({
      anchor: anchor({ left: 600, right: 628 }),
      popoverWidth: 176,
      popoverHeight: 120,
      align: "end",
      ...VIEWPORT,
    });
    expect(result.left).toBe(628 - 176);
  });

  test("flips the cross edge before clamping near either horizontal edge", () => {
    const nearLeft = positionPopover({
      anchor: anchor({ left: 12, right: 40 }),
      popoverWidth: 176,
      popoverHeight: 120,
      align: "end",
      ...VIEWPORT,
    });
    const nearRight = positionPopover({
      anchor: anchor({ left: 1150, right: 1178 }),
      popoverWidth: 176,
      popoverHeight: 120,
      align: "start",
      ...VIEWPORT,
    });
    expect(nearLeft.left).toBe(12);
    expect(nearRight.left).toBe(1178 - 176);
  });

  test("flips above when the preferred main side clips", () => {
    const result = positionPopover({
      anchor: anchor({ top: 700, bottom: 728 }),
      popoverWidth: 176,
      popoverHeight: 200,
      align: "start",
      ...VIEWPORT,
    });
    expect(result).toMatchObject({ top: 700 - 4 - 200, side: "top" });
  });

  test("honors a preferred top side and flips it when necessary", () => {
    const result = positionPopover({
      anchor: anchor({ top: 20, bottom: 48 }),
      popoverWidth: 176,
      popoverHeight: 200,
      align: "start",
      side: "top",
      ...VIEWPORT,
    });
    expect(result).toMatchObject({ top: 52, side: "bottom" });
  });

  test("chooses the roomier side and caps a box that fits neither", () => {
    const result = positionPopover({
      anchor: anchor({ top: 300, bottom: 328 }),
      popoverWidth: 176,
      popoverHeight: 900,
      align: "start",
      ...VIEWPORT,
    });
    expect(result.top).toBe(332);
    expect(result.maxHeight).toBe(800 - 8 - 332);
  });

  test("caps a box to a narrow viewport while keeping its leading edge reachable", () => {
    const result = positionPopover({
      anchor: anchor({ left: 10, right: 38 }),
      popoverWidth: 176,
      popoverHeight: 120,
      align: "end",
      viewportWidth: 120,
      viewportHeight: 800,
    });
    expect(result.left).toBe(8);
    expect(result.maxWidth).toBe(104);
  });

  test("positions a zero-size cursor anchor", () => {
    const result = positionPopover({
      anchor: pointPopoverAnchor(400, 300),
      popoverWidth: 176,
      popoverHeight: 120,
      align: "start",
      ...VIEWPORT,
    });
    expect(result).toMatchObject({ left: 400, top: 304 });
  });

  test("center-aligns tooltip-shaped content on the cross axis", () => {
    const result = positionPopover({
      anchor: anchor({ left: 200, right: 240 }),
      popoverWidth: 100,
      popoverHeight: 40,
      align: "center",
      ...VIEWPORT,
    });
    expect(result.left).toBe(170);
    expect(result.originX).toBe("center");
  });
});

describe("positionPopover horizontal placement", () => {
  test("places beside the anchor and start-aligns the cross axis", () => {
    const result = positionPopover({
      anchor: anchor({ top: 300, bottom: 324, left: 40, right: 360 }),
      popoverWidth: 320,
      popoverHeight: 360,
      align: "start",
      side: "right",
      ...VIEWPORT,
    });
    expect(result).toMatchObject({ left: 364, top: 300, side: "right" });
  });

  test("flips to the left when the right side cannot fit", () => {
    const result = positionPopover({
      anchor: anchor({ top: 300, bottom: 324, left: 912, right: 1200 }),
      popoverWidth: 320,
      popoverHeight: 360,
      align: "start",
      side: "right",
      ...VIEWPORT,
    });
    expect(result.left).toBe(912 - 4 - 320);
    expect(result.side).toBe("left");
  });

  test("takes and caps the roomier side when neither can fit", () => {
    const result = positionPopover({
      anchor: anchor({ top: 300, bottom: 324, left: 300, right: 700 }),
      popoverWidth: 900,
      popoverHeight: 360,
      align: "start",
      side: "right",
      ...VIEWPORT,
    });
    expect(result.left).toBe(704);
    expect(result.maxWidth).toBe(1200 - 8 - 704);
  });

  test("end-aligns and clamps the cross axis", () => {
    const result = positionPopover({
      anchor: anchor({ top: 780, bottom: 796, left: 40, right: 360 }),
      popoverWidth: 320,
      popoverHeight: 360,
      align: "end",
      side: "right",
      ...VIEWPORT,
    });
    expect(result.top).toBe(800 - 360 - 8);
  });

  test("safe-area insets participate in every screen bound", () => {
    const result = positionPopover({
      anchor: anchor({ top: 12, bottom: 24, left: 4, right: 20 }),
      popoverWidth: 176,
      popoverHeight: 780,
      align: "start",
      side: "left",
      insets: { top: 40, right: 12, bottom: 30, left: 10 },
      ...VIEWPORT,
    });
    expect(result.left).toBeGreaterThanOrEqual(18);
    expect(result.top).toBeGreaterThanOrEqual(48);
    expect(result.top + Math.min(780, result.maxHeight)).toBeLessThanOrEqual(762);
  });
});
