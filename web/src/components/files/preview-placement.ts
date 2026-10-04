import { MENU_ANCHOR_GAP_PX, type MenuAnchor } from "@/components/ui/menu-position";

/**
 * Where the file explorer's hover preview hangs from.
 *
 * The card would rather sit beside the panel, in the room next to it. When
 * there is no such room — the explorer filling its window, which is the
 * ordinary case for a file-explorer pane — the alternative it used to take was
 * to flip to the *other* side of the panel and land on the sidebar, halfway
 * across the app from the file it was describing.
 *
 * So it lies over its own panel instead, right of a strip of tree kept clear
 * on the left, and below the row it describes — above it when there is no
 * room below — never on it. Lying level with the row, as it once did, it
 * covered that row's own ⋯ button and a rename field's message under it. This
 * reads as the preview belonging to the list, keeps the row it is about whole
 * on screen, and never covers anything outside the explorer.
 *
 * Nor does it lie in the pointer's way. Hung from the strip's edge wherever
 * the pointer was, a card for a row rested on anywhere in its middle lay
 * straight across the path to the next row down, and the click meant for that
 * row landed on the card instead — a click, a pause, then Shift-click on the
 * file below could not select it. So over the panel the card keeps out of the
 * pointer's column, on whichever side of it has the room: moving up or down
 * the list always reaches a row, and the card is reached by going to it.
 *
 * Pure arithmetic, so the rules that decide it — when to overlay, how much
 * tree that costs, that the row stays clear, and that the pointer's column
 * does — can be exercised without a browser.
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

/**
 * How far a card lying over the panel keeps from the pointer's column, either
 * side: room for a hand moving "straight" down a list, which never quite does.
 */
export const PREVIEW_POINTER_CLEARANCE_PX = 24;

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
   * panel so it does not slide sideways as the pointer runs down the list —
   * lying over the panel, from the side of the pointer's column it takes.
   */
  anchor: MenuAnchor;
  /**
   * `right` sits the card beside the panel, level with the row; `bottom` hangs
   * it under the row (or over it, when that is where the room is), lying over
   * the panel. Either way the row itself stays uncovered.
   */
  side: "right" | "bottom";
  /** The card is lying over the panel. */
  overlay: boolean;
  /**
   * How wide the card may be: lying over the panel, only the room right of the
   * strip, and beside the pointer's column rather than across it.
   */
  maxWidth: number | null;
}

export function previewPlacement(
  row: PreviewBox,
  panel: PreviewBox,
  viewportWidth: number,
  /** Where the pointer is across the panel, or null when it is not over the list. */
  pointerX: number | null = null,
): PreviewPlacement {
  const beside = viewportWidth - panel.right - PLACEMENT_INSET_PX;
  const overlaid = panel.right - panel.left - PREVIEW_TREE_RESERVE_PX - PLACEMENT_INSET_PX;
  const overlay = beside < PREVIEW_MIN_CARD_PX && overlaid >= PREVIEW_MIN_CARD_PX;
  if (!overlay) {
    return {
      anchor: { top: row.top, bottom: row.bottom, left: panel.left, right: panel.right },
      side: "right",
      overlay: false,
      maxWidth: null,
    };
  }
  const { left, right, width } = overlaySpan(panel, pointerX);
  return {
    // Pulled in by placeMenu's gap, so the card meets the row edge to edge:
    // the pointer goes from the row straight onto it, crossing no other row
    // that would ask for a card of its own, or (a folder) close this one.
    anchor: {
      top: row.top + MENU_ANCHOR_GAP_PX,
      bottom: row.bottom - MENU_ANCHOR_GAP_PX,
      left,
      right,
    },
    side: "bottom",
    overlay: true,
    maxWidth: width,
  };
}

/**
 * The stretch of the panel a card lying over it takes, left to right.
 *
 * From the strip's edge, as it always was, when that leaves the pointer's
 * column clear — the pointer on a name in the strip, or out past the card.
 * Otherwise beside the column on whichever side has more room — the right
 * whenever a whole card fits there — narrower than a whole card if it must
 * be, never over the strip, and never under the pointer.
 */
function overlaySpan(
  panel: PreviewBox,
  pointerX: number | null,
): { left: number; right: number; width: number } {
  const strip = panel.left + PREVIEW_TREE_RESERVE_PX;
  const end = panel.right - PLACEMENT_INSET_PX;
  const whole = Math.min(PREVIEW_CARD_WIDTH_PX, end - strip);
  const clear = PREVIEW_POINTER_CLEARANCE_PX;
  if (pointerX === null || pointerX + clear <= strip || pointerX - clear >= strip + whole) {
    return { left: strip, right: panel.right, width: whole };
  }
  const roomRight = end - (pointerX + clear);
  const roomLeft = pointerX - clear - strip;
  if (roomRight >= whole || roomRight >= roomLeft) {
    return { left: pointerX + clear, right: panel.right, width: Math.min(whole, roomRight) };
  }
  const width = Math.min(whole, roomLeft);
  return { left: pointerX - clear - width, right: pointerX - clear, width };
}
