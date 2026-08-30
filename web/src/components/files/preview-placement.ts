import type { MenuAnchor } from "@/components/ui/menu-position";

/**
 * Where the file explorer's hover preview hangs from.
 *
 * The card would rather sit beside the panel, in the room next to it. When
 * there is no such room — the explorer filling its window, which is the
 * ordinary case for a file-explorer pane — the alternative it used to take was
 * to flip to the *other* side of the panel and land on the sidebar, halfway
 * across the app from the file it was describing.
 *
 * So it lies over its own panel instead, hung off a strip of tree kept clear
 * on the left. That reads as the preview belonging to the list, keeps the row
 * names it is about on screen beside it, and never covers anything outside the
 * explorer. Pure arithmetic, so the two rules that decide it — when to overlay,
 * and how much tree that costs — can be exercised without a browser.
 */

/** The card's natural width, which the panel is measured against. */
export const PREVIEW_CARD_WIDTH_PX = 544;

/**
 * The tree kept clear when the card lies over its own panel. Enough for a
 * row's icon and the readable head of its name at a few levels of indent —
 * the point of overlaying rather than covering.
 */
export const PREVIEW_TREE_RESERVE_PX = 264;

/**
 * Below this a card is not worth the tree it costs, so a panel too narrow to
 * host one keeps the old behaviour and goes beside itself instead. A pane in
 * a grid with the rest of the window to its left is exactly that case, and
 * there landing outside the panel is right rather than wrong.
 */
const PREVIEW_MIN_CARD_PX = 320;

/**
 * `placeMenu`'s own gutter and offset, which sit between the anchor and the
 * box on every side. Counted here so "will it fit" is asked about the width
 * the card would actually get.
 */
const PLACEMENT_INSET_PX = 12;

/** The four edges of a box, as `getBoundingClientRect` reports them. */
export interface PreviewBox {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PreviewPlacement {
  /**
   * Deliberately two rects mixed: the row supplies the vertical extent so the
   * card tracks what it describes, and the horizontal edges come from the
   * panel so it does not slide sideways as the pointer runs down the list.
   */
  anchor: MenuAnchor;
  /** The card is lying over the panel, so it must not be allowed to flip. */
  overlay: boolean;
}

export function previewPlacement(
  row: PreviewBox,
  panel: PreviewBox,
  viewportWidth: number,
): PreviewPlacement {
  const beside = viewportWidth - panel.right - PLACEMENT_INSET_PX;
  const overlaid = panel.right - panel.left - PREVIEW_TREE_RESERVE_PX - PLACEMENT_INSET_PX;
  const overlay = beside < PREVIEW_MIN_CARD_PX && overlaid >= PREVIEW_MIN_CARD_PX;
  return {
    anchor: {
      top: row.top,
      bottom: row.bottom,
      left: panel.left,
      right: overlay ? panel.left + PREVIEW_TREE_RESERVE_PX : panel.right,
    },
    overlay,
  };
}
