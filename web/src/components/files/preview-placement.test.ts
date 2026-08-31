import { describe, expect, test } from "bun:test";

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
    const { anchor, overlay } = previewPlacement(row, panel, 1160);
    expect(overlay).toBe(true);
    expect(anchor.right).toBe(panel.left + PREVIEW_TREE_RESERVE_PX);
    // And what is left is still a card worth reading.
    expect(panel.right - anchor.right).toBeGreaterThan(320);
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
