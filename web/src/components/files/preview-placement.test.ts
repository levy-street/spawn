import { describe, expect, test } from "bun:test";

import { placeMenu } from "@/components/ui/menu-position";
import {
  PREVIEW_CARD_WIDTH_PX,
  PREVIEW_POINTER_CLEARANCE_PX,
  PREVIEW_TREE_RESERVE_PX,
  previewPlacement,
} from "./preview-placement";

const row = { top: 200, bottom: 228, left: 0, right: 0 };

/** A panel of `width` whose right edge sits `gap` in from the viewport. */
function panelAt(width: number, gap: number, viewportWidth: number) {
  const right = viewportWidth - gap;
  return { top: 100, bottom: 900, left: right - width, right };
}

describe("previewPlacement", () => {
  test("the row gives the vertical extent, the panel the horizontal one", () => {
    const panel = panelAt(320, 900, 1440);
    const { anchor } = previewPlacement(row, panel, 1440);
    expect(anchor.top).toBe(row.top);
    expect(anchor.bottom).toBe(row.bottom);
    expect(anchor.left).toBe(panel.left);
  });

  test("room beside the panel keeps the card beside it", () => {
    const panel = panelAt(320, PREVIEW_CARD_WIDTH_PX + 40, 1440);
    const { anchor, overlay } = previewPlacement(row, panel, 1440);
    expect(overlay).toBe(false);
    expect(anchor.right).toBe(panel.right);
  });

  test("a panel filling the window puts the card over it, clear of the tree", () => {
    // The explorer as a full-width pane: nothing to its right at all, which
    // used to send the card flipping onto the sidebar.
    const panel = panelAt(650, 0, 1160);
    const { anchor, overlay, side, maxWidth } = previewPlacement(row, panel, 1160);
    expect(overlay).toBe(true);
    expect(side).toBe("bottom");
    expect(anchor.left).toBe(panel.left + PREVIEW_TREE_RESERVE_PX);
    // And what is left is still a card worth reading, inside the panel.
    expect(maxWidth).toBeGreaterThan(320);
    expect(anchor.left + (maxWidth ?? 0)).toBeLessThanOrEqual(panel.right);
  });

  test("a card over its own panel never covers the row it describes", () => {
    // The Files page at 1440x900: the card used to lie level with the row,
    // over its ⋯ button (and a rename field's message under it).
    const viewport = { width: 1440, height: 900 };
    const panel = { top: 160, bottom: 870, left: 285, right: 1440 };
    for (const top of [180, 224, 480, 700, 840]) {
      const hovered = { top, bottom: top + 28, left: panel.left, right: panel.right };
      const placement = previewPlacement(hovered, panel, viewport.width);
      expect(placement.overlay).toBe(true);
      const card = placeMenu({
        anchor: placement.anchor,
        menuWidth: Math.min(PREVIEW_CARD_WIDTH_PX, placement.maxWidth ?? Infinity),
        menuHeight: 520,
        align: "start",
        side: placement.side,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
      });
      const height = Math.min(520, card.maxHeight);
      const clear = card.top >= hovered.bottom || card.top + height <= hovered.top;
      expect({ top, clear }).toEqual({ top, clear: true });
      // Edge to edge with it: no other row lies between the row and its card.
      expect([hovered.bottom, hovered.top]).toContain(
        card.top >= hovered.bottom ? card.top : card.top + height,
      );
      // Right of the strip of tree kept clear.
      expect(card.left).toBeGreaterThanOrEqual(panel.left + PREVIEW_TREE_RESERVE_PX);
    }
  });

  test("beside the panel the card is level with its row, and off it", () => {
    const panel = panelAt(320, PREVIEW_CARD_WIDTH_PX + 40, 1440);
    const placement = previewPlacement(row, panel, 1440);
    expect(placement.side).toBe("right");
    const card = placeMenu({
      anchor: placement.anchor,
      menuWidth: PREVIEW_CARD_WIDTH_PX,
      menuHeight: 400,
      align: "start",
      side: placement.side,
      viewportWidth: 1440,
      viewportHeight: 900,
    });
    expect(card.left).toBeGreaterThanOrEqual(panel.right);
    expect(card.top).toBe(row.top);
  });

  test("a panel too narrow to host a card goes beside itself instead", () => {
    // A pane in a grid with the window to its left: overlaying would cost the
    // whole tree and buy a sliver, so the old flip is the better answer.
    const panel = panelAt(380, 0, 1160);
    const { anchor, overlay } = previewPlacement(row, panel, 1160);
    expect(overlay).toBe(false);
    expect(anchor.right).toBe(panel.right);
  });

  test("a pointer on a name leaves the card hung from the strip, as it always was", () => {
    const viewport = { width: 1440, height: 900 };
    const panel = { top: 110, bottom: 850, left: 281, right: 1415 };
    const hovered = { top: 138, bottom: 166, left: panel.left, right: panel.right };
    const without = previewPlacement(hovered, panel, viewport.width);
    for (const x of [
      panel.left + 12,
      panel.left + 120,
      panel.left + PREVIEW_TREE_RESERVE_PX - 30,
    ]) {
      expect(previewPlacement(hovered, panel, viewport.width, x)).toEqual(without);
    }
  });

  test("lying over the list, the card is never in the pointer's way to the next row", () => {
    // The Files page at Playwright's 1280x720 and at 1440x900, and an explorer
    // pane filling a 1160 window: measured from the live layout. A card hung
    // from the strip whatever the pointer did lay under the middle of every
    // row below, and a click there — the next file, a Shift-click to extend
    // the selection — landed on the card.
    const cases = [
      { viewport: { width: 1280, height: 720 }, panel: { left: 281, right: 1255 }, roomy: true },
      { viewport: { width: 1440, height: 900 }, panel: { left: 281, right: 1415 }, roomy: true },
      { viewport: { width: 1160, height: 900 }, panel: { left: 264, right: 1152 }, roomy: false },
      // The narrowest panel that still hosts a card over itself.
      { viewport: { width: 640, height: 900 }, panel: { left: 40, right: 640 }, roomy: false },
    ];
    for (const { viewport, panel: edges, roomy } of cases) {
      const panel = { top: 110, bottom: viewport.height - 20, ...edges };
      const strip = panel.left + PREVIEW_TREE_RESERVE_PX;
      for (const top of [140, 420, viewport.height - 80]) {
        const hovered = { top, bottom: top + 28, left: panel.left, right: panel.right };
        for (let x = panel.left; x <= panel.right; x += 7) {
          const placement = previewPlacement(hovered, panel, viewport.width, x);
          expect(placement.overlay).toBe(true);
          const width = Math.min(PREVIEW_CARD_WIDTH_PX, placement.maxWidth ?? Infinity);
          const card = placeMenu({
            anchor: placement.anchor,
            menuWidth: width,
            menuHeight: 520,
            align: "start",
            side: placement.side,
            viewportWidth: viewport.width,
            viewportHeight: viewport.height,
          });
          const at = { x, top };
          // Clear of the pointer's column, with room for a hand that drifts.
          const clearOfPointer =
            card.left + width <= x - PREVIEW_POINTER_CLEARANCE_PX ||
            card.left >= x + PREVIEW_POINTER_CLEARANCE_PX;
          expect({ ...at, clearOfPointer }).toEqual({ ...at, clearOfPointer: true });
          // Still over its own panel, right of the strip of names.
          expect({ ...at, left: card.left >= strip }).toEqual({ ...at, left: true });
          expect({ ...at, inside: card.left + width <= panel.right }).toEqual({
            ...at,
            inside: true,
          });
          // And still a card worth having, wherever the panel has the room
          // for one beside any column.
          expect(width).toBeGreaterThan(roomy ? 320 : 0);
        }
      }
    }
  });

  test("a pointer out past the card's span leaves it where it was", () => {
    const panel = { top: 110, bottom: 850, left: 281, right: 1415 };
    const hovered = { top: 138, bottom: 166, left: panel.left, right: panel.right };
    const without = previewPlacement(hovered, panel, 1440);
    const span = without.anchor.left + (without.maxWidth ?? 0);
    expect(previewPlacement(hovered, panel, 1440, span + PREVIEW_POINTER_CLEARANCE_PX)).toEqual(
      without,
    );
  });

  test("beside the panel the pointer changes nothing", () => {
    const panel = panelAt(320, PREVIEW_CARD_WIDTH_PX + 40, 1440);
    const without = previewPlacement(row, panel, 1440);
    expect(previewPlacement(row, panel, 1440, panel.left + 200)).toEqual(without);
  });

  test("the reserve always leaves less than a whole card, or it would not overlay", () => {
    // The two constants have to stay in a workable relationship: a reserve as
    // wide as the card would mean an overlaid card never fits its own panel.
    expect(PREVIEW_TREE_RESERVE_PX).toBeLessThan(PREVIEW_CARD_WIDTH_PX);
  });
});
