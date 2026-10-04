import { describe, expect, test } from "bun:test";

import { placeMenu } from "@/components/ui/menu-position";
import {
  PREVIEW_CARD_WIDTH_PX,
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

  test("the reserve always leaves less than a whole card, or it would not overlay", () => {
    // The two constants have to stay in a workable relationship: a reserve as
    // wide as the card would mean an overlaid card never fits its own panel.
    expect(PREVIEW_TREE_RESERVE_PX).toBeLessThan(PREVIEW_CARD_WIDTH_PX);
  });
});
