import { describe, expect, test } from "bun:test";
import { type MenuAnchor, placeMenu, pointAnchor } from "./menu-position";

const VIEW = { viewportWidth: 1200, viewportHeight: 800 };

/** A trigger box; defaults to a 28px kebab button. */
function anchor(partial: Partial<MenuAnchor>): MenuAnchor {
  return { top: 100, bottom: 128, left: 200, right: 228, ...partial };
}

describe("placeMenu", () => {
  test("drops below the anchor when there is room", () => {
    const placement = placeMenu({
      anchor: anchor({}),
      menuWidth: 176,
      menuHeight: 120,
      align: "start",
      ...VIEW,
    });
    expect(placement.top).toBe(132);
    expect(placement.left).toBe(200);
  });

  test("end-aligns the menu's right edge to the anchor's", () => {
    const placement = placeMenu({
      anchor: anchor({ left: 600, right: 628 }),
      menuWidth: 176,
      menuHeight: 120,
      align: "end",
      ...VIEW,
    });
    expect(placement.left).toBe(628 - 176);
  });

  test("an end-aligned box near the left edge flips onto the anchor's other edge", () => {
    // The regression: a sidebar kebab at x≈40 with a 176px menu hung off its
    // right edge lands at -136. Flipping keeps it joined to the trigger;
    // clamping alone would have parked it in the gutter at 8.
    const placement = placeMenu({
      anchor: anchor({ left: 12, right: 40 }),
      menuWidth: 176,
      menuHeight: 120,
      align: "end",
      ...VIEW,
    });
    expect(placement.left).toBe(12);
  });

  test("a start-aligned box near the right edge flips its right edge onto the anchor's", () => {
    const placement = placeMenu({
      anchor: anchor({ left: 1150, right: 1178 }),
      menuWidth: 176,
      menuHeight: 120,
      align: "start",
      ...VIEW,
    });
    expect(placement.left).toBe(1178 - 176);
  });

  test("clamps only when neither edge of the anchor leaves room", () => {
    const placement = placeMenu({
      anchor: anchor({ left: 4, right: 900 }),
      menuWidth: 1100,
      menuHeight: 120,
      align: "start",
      ...VIEW,
    });
    expect(placement.left).toBe(8);
  });

  test("flips above the anchor when the menu would run off the bottom", () => {
    const placement = placeMenu({
      anchor: anchor({ top: 700, bottom: 728 }),
      menuWidth: 176,
      menuHeight: 200,
      align: "start",
      ...VIEW,
    });
    expect(placement.top).toBe(700 - 4 - 200);
  });

  test("side: top flips back down when there is no room above", () => {
    const placement = placeMenu({
      anchor: anchor({ top: 20, bottom: 48 }),
      menuWidth: 176,
      menuHeight: 200,
      align: "start",
      side: "top",
      ...VIEW,
    });
    expect(placement.top).toBe(52);
  });

  test("a caller's own tighter cap decides the box, and top follows it", () => {
    // The breadcrumb drill-down carries max-h-72, so it measures 288 even
    // where 500 would fit: the flip-up position has to sit on the real box.
    const placement = placeMenu({
      anchor: anchor({ top: 700, bottom: 728 }),
      menuWidth: 176,
      menuHeight: 288,
      align: "start",
      ...VIEW,
    });
    expect(placement.top).toBe(700 - 4 - 288);
  });

  test("caps the height to the roomier side when the menu fits neither", () => {
    const placement = placeMenu({
      anchor: anchor({ top: 300, bottom: 328 }),
      menuWidth: 176,
      menuHeight: 900,
      align: "start",
      ...VIEW,
    });
    // 472 below vs 288 above: below wins and the menu scrolls inside it.
    expect(placement.top).toBe(332);
    expect(placement.maxHeight).toBe(800 - 8 - 332);
  });

  test("caps upward too, keeping the top edge inside the gutter", () => {
    const placement = placeMenu({
      anchor: anchor({ top: 700, bottom: 728 }),
      menuWidth: 176,
      menuHeight: 900,
      align: "start",
      ...VIEW,
    });
    expect(placement.top).toBe(8);
    expect(placement.maxHeight).toBe(700 - 4 - 8);
  });

  test("max-height is the available room, not the measured height", () => {
    // Pinning it to the measured height would freeze the border box and stop
    // the ResizeObserver from ever re-placing a menu whose panel grew.
    const placement = placeMenu({
      anchor: anchor({}),
      menuWidth: 176,
      menuHeight: 120,
      align: "start",
      ...VIEW,
    });
    expect(placement.maxHeight).toBe(800 - 8 - 132);
  });

  test("a cursor anchor drops from the point", () => {
    const placement = placeMenu({
      anchor: pointAnchor(400, 300),
      menuWidth: 176,
      menuHeight: 120,
      align: "start",
      ...VIEW,
    });
    expect(placement).toMatchObject({ left: 400, top: 304 });
  });

  test("a cursor anchor in the bottom-right corner stays on screen", () => {
    const placement = placeMenu({
      anchor: pointAnchor(1195, 795),
      menuWidth: 176,
      menuHeight: 120,
      align: "start",
      ...VIEW,
    });
    expect(placement.left).toBe(1200 - 176 - 8);
    expect(placement.top).toBe(795 - 4 - 120);
  });

  test("a viewport narrower than the menu still shows its leading edge", () => {
    const placement = placeMenu({
      anchor: anchor({ left: 10, right: 38 }),
      menuWidth: 176,
      menuHeight: 120,
      align: "end",
      viewportWidth: 120,
      viewportHeight: 800,
    });
    expect(placement.left).toBe(8);
    expect(placement.maxWidth).toBe(104);
  });
});

describe("placeMenu — horizontal sides", () => {
  /** A file-tree row: the panel supplies the x edges, the row the y extent. */
  function rowAnchor(partial: Partial<MenuAnchor> = {}): MenuAnchor {
    return { top: 300, bottom: 324, left: 40, right: 360, ...partial };
  }

  test("side:right places the card just past the anchor's right edge", () => {
    const placement = placeMenu({
      anchor: rowAnchor(),
      menuWidth: 320,
      menuHeight: 360,
      align: "start",
      side: "right",
      ...VIEW,
    });
    expect(placement.left).toBe(364);
    // `start` lines the card's top up with the row it describes.
    expect(placement.top).toBe(300);
  });

  test("side:right flips left when the panel hugs the viewport's right edge", () => {
    // The session files aside: a 288px panel docked right, so there is no room
    // to the right of it for a 320px card.
    const placement = placeMenu({
      anchor: rowAnchor({ left: 912, right: 1200 }),
      menuWidth: 320,
      menuHeight: 360,
      align: "start",
      side: "right",
      ...VIEW,
    });
    expect(placement.left).toBe(912 - 4 - 320);
    expect(placement.maxWidth).toBe(912 - 4 - 8);
  });

  test("side:left prefers the left and flips right when it cannot fit", () => {
    const flush = placeMenu({
      anchor: rowAnchor({ left: 40, right: 360 }),
      menuWidth: 320,
      menuHeight: 360,
      align: "start",
      side: "left",
      ...VIEW,
    });
    // Only 28px to the left of the panel, 836 to its right — so it flips.
    expect(flush.left).toBe(364);

    const roomy = placeMenu({
      anchor: rowAnchor({ left: 600, right: 900 }),
      menuWidth: 320,
      menuHeight: 360,
      align: "start",
      side: "left",
      ...VIEW,
    });
    expect(roomy.left).toBe(600 - 4 - 320);
  });

  test("neither side fits: takes the roomier one and caps the width", () => {
    const placement = placeMenu({
      anchor: rowAnchor({ left: 300, right: 700 }),
      menuWidth: 900,
      menuHeight: 360,
      align: "start",
      side: "right",
      ...VIEW,
    });
    // 488 to the right, 288 to the left — right wins and the card is capped.
    expect(placement.maxWidth).toBe(1200 - 8 - 704);
    expect(placement.left).toBe(704);
  });

  test("align:end hangs the card's bottom off the anchor's bottom", () => {
    const placement = placeMenu({
      anchor: rowAnchor({ top: 500, bottom: 524 }),
      menuWidth: 320,
      menuHeight: 200,
      align: "end",
      side: "right",
      ...VIEW,
    });
    expect(placement.top).toBe(524 - 200);
  });

  test("a row near the viewport bottom slides the card up, never off", () => {
    const placement = placeMenu({
      anchor: rowAnchor({ top: 780, bottom: 796 }),
      menuWidth: 320,
      menuHeight: 360,
      align: "start",
      side: "right",
      ...VIEW,
    });
    // 780 + 360 would overflow 800; clamped to the bottom gutter instead.
    expect(placement.top).toBe(800 - 360 - 8);
    expect(placement.top + 360).toBeLessThanOrEqual(800 - 8);
  });

  test("caps height to the viewport on the cross axis, without flipping", () => {
    const placement = placeMenu({
      anchor: rowAnchor(),
      menuWidth: 320,
      menuHeight: 2000,
      align: "start",
      side: "right",
      ...VIEW,
    });
    expect(placement.maxHeight).toBe(800 - 16);
    expect(placement.top).toBe(8);
  });

  test("a card taller than the viewport still starts at the top gutter", () => {
    const placement = placeMenu({
      anchor: rowAnchor({ top: 10, bottom: 34 }),
      menuWidth: 320,
      menuHeight: 5000,
      align: "start",
      side: "right",
      ...VIEW,
    });
    expect(placement.top).toBe(8);
    expect(placement.left).toBe(364);
  });
});

describe("placeMenu transform origin", () => {
  test("grows from the corner nearest the trigger, downward and start-aligned", () => {
    const placement = placeMenu({
      anchor: anchor({}),
      menuWidth: 176,
      menuHeight: 120,
      align: "start",
      ...VIEW,
    });
    expect(placement.transformOrigin).toBe("top left");
  });

  test("end-aligned grows from the right", () => {
    const placement = placeMenu({
      anchor: anchor({ left: 600, right: 628 }),
      menuWidth: 176,
      menuHeight: 120,
      align: "end",
      ...VIEW,
    });
    expect(placement.transformOrigin).toBe("top right");
  });

  test("flipped up and flipped across grows from the opposite corner", () => {
    // Bottom-right trigger: the box lands above it and hangs off its right
    // edge, so the zoom has to grow out of its own bottom-right corner.
    const placement = placeMenu({
      anchor: anchor({ top: 700, bottom: 728, left: 1150, right: 1178 }),
      menuWidth: 176,
      menuHeight: 200,
      align: "start",
      ...VIEW,
    });
    expect(placement.transformOrigin).toBe("bottom right");
  });
});
