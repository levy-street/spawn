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

  test("an end-aligned menu near the left edge slides in, never off", () => {
    // The regression: a sidebar kebab at x≈40 with a 176px menu hung off its
    // right edge lands at -136 unless the result is clamped.
    const placement = placeMenu({
      anchor: anchor({ left: 12, right: 40 }),
      menuWidth: 176,
      menuHeight: 120,
      align: "end",
      ...VIEW,
    });
    expect(placement.left).toBe(8);
  });

  test("a start-aligned menu near the right edge slides in, never off", () => {
    const placement = placeMenu({
      anchor: anchor({ left: 1150, right: 1178 }),
      menuWidth: 176,
      menuHeight: 120,
      align: "start",
      ...VIEW,
    });
    expect(placement.left).toBe(1200 - 176 - 8);
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
