/**
 * Viewport-aware placement for the portalled menus (`ui/dropdown-menu`,
 * `ui/cascade-menu`).
 *
 * Both menus render `position: fixed` into `document.body`, so nothing else
 * constrains them — keeping a menu on screen is entirely this function's job.
 * It always resolves to a numeric `left`/`top` rather than pinning an edge with
 * `right`/`bottom`: an edge pin cannot be clamped (the opposite edge is wherever
 * the menu's own width happens to put it), which is how a menu hung off a
 * sidebar kebab ended up half off the left of the screen.
 *
 * The contract: the returned box is always fully inside the viewport, inset by
 * `MARGIN`. When the menu cannot fit at its natural size it is capped instead of
 * pushed off — hence `maxHeight`/`maxWidth`, which the caller applies so the
 * menu scrolls internally.
 */

/** Gutter the menu never crosses on any side. */
const MARGIN = 8;
/** Gap between the anchor and the menu. */
const OFFSET = 4;

export type MenuAlign = "start" | "end";
export type MenuSide = "top" | "bottom";

/** The trigger's rect — or a zero-size rect at the cursor, for `openAt`. */
export type MenuAnchor = { top: number; bottom: number; left: number; right: number };

export type MenuPlacement = {
  position: "fixed";
  left: number;
  top: number;
  maxHeight: number;
  maxWidth: number;
};

export function pointAnchor(x: number, y: number): MenuAnchor {
  return { top: y, bottom: y, left: x, right: x };
}

export function placeMenu({
  anchor,
  menuWidth,
  menuHeight,
  align,
  side = "bottom",
  viewportWidth,
  viewportHeight,
}: {
  anchor: MenuAnchor;
  /** The menu's current rendered width. */
  menuWidth: number;
  /** The menu's current rendered height. */
  menuHeight: number;
  align: MenuAlign;
  side?: MenuSide;
  viewportWidth: number;
  viewportHeight: number;
}): MenuPlacement {
  const roomBelow = viewportHeight - MARGIN - (anchor.bottom + OFFSET);
  const roomAbove = anchor.top - OFFSET - MARGIN;

  // Preferred side wins when the menu fits there; otherwise flip if the other
  // side fits, and if neither does, take the roomier one and let the height
  // cap below turn the overflow into a scroll.
  const preferBelow = side !== "top";
  const fitsPreferred = menuHeight <= (preferBelow ? roomBelow : roomAbove);
  const fitsOther = menuHeight <= (preferBelow ? roomAbove : roomBelow);
  const below = fitsPreferred ? preferBelow : fitsOther ? !preferBelow : roomBelow >= roomAbove;

  // The cap is the whole of the available room, never the menu's own measured
  // height. Two reasons: pinning max-height to what the menu measures today
  // would freeze its border box, so the ResizeObserver that re-places it would
  // never fire again when a cascade step swapped in a taller panel; and the
  // room does not depend on the measurement, so feeding a capped height back
  // in on the next pass cannot ratchet the menu smaller. A caller's own
  // tighter cap (`max-h-72` on the breadcrumb drill-down) survives too — it
  // simply wins the measurement, and `top` follows the box that results.
  const maxHeight = Math.max(0, below ? roomBelow : roomAbove);
  const height = Math.min(menuHeight, maxHeight);
  const top = below ? anchor.bottom + OFFSET : anchor.top - OFFSET - height;

  const maxWidth = Math.max(0, viewportWidth - MARGIN * 2);
  const width = Math.min(menuWidth, maxWidth);
  // `end` hangs the menu's right edge off the anchor's right edge; `start`
  // lines their left edges up. Either way the result is clamped, so a narrow
  // viewport (or a trigger near an edge) slides the menu in rather than off.
  const desiredLeft = align === "end" ? anchor.right - width : anchor.left;

  return {
    position: "fixed",
    left: clamp(desiredLeft, MARGIN, viewportWidth - width - MARGIN),
    top: clamp(top, MARGIN, viewportHeight - height - MARGIN),
    maxHeight,
    maxWidth,
  };
}

function clamp(value: number, min: number, max: number): number {
  // max < min when the viewport is smaller than the menu; the gutter on the
  // leading edge wins so the menu's start is always reachable.
  return Math.max(min, Math.min(value, Math.max(min, max)));
}

/**
 * The menu's laid-out box. Layout size, not `getBoundingClientRect`: the open
 * animation scales the menu, and a measurement taken mid-zoom places it a few
 * pixels off.
 */
export function measureMenu(element: HTMLElement | null, fallbackWidth: number) {
  if (!element) return { width: fallbackWidth, height: 0 };
  return { width: element.offsetWidth || fallbackWidth, height: element.offsetHeight };
}
