/**
 * Viewport-aware placement for the portalled overlays (`ui/dropdown-menu`,
 * `ui/cascade-menu`, `ui/popover`).
 *
 * They render `position: fixed` into `document.body`, so nothing else
 * constrains them — keeping one on screen is entirely this function's job.
 * It always resolves to a numeric `left`/`top` rather than pinning an edge with
 * `right`/`bottom`: an edge pin cannot be clamped (the opposite edge is wherever
 * the box's own width happens to put it), which is how a menu hung off a
 * sidebar kebab ended up half off the left of the screen.
 *
 * The contract: the returned box is always fully inside the viewport, inset by
 * `MARGIN`. When it cannot fit at its natural size it is capped instead of
 * pushed off — hence `maxHeight`/`maxWidth`, which the caller applies so the
 * content scrolls internally.
 *
 * `side` picks the *main* axis. `"top"`/`"bottom"` stack the box above or below
 * the anchor and `align` then works horizontally; `"left"`/`"right"` sit it
 * beside the anchor and `align` works vertically. On the main axis the box
 * flips to the other side when the preferred one cannot hold it, and the cap is
 * the room on whichever side won. On the cross axis the cap is simply the
 * viewport less its gutters.
 */

/** Gutter the box never crosses on any side. */
const MARGIN = 8;
/** Gap between the anchor and the box. */
const OFFSET = 4;

export type MenuAlign = "start" | "end";
export type MenuSide = "top" | "bottom" | "left" | "right";

/** The trigger's rect — or a zero-size rect at the cursor, for `openAt`. */
export type MenuAnchor = { top: number; bottom: number; left: number; right: number };

export type MenuPlacement = {
  position: "fixed";
  left: number;
  top: number;
  maxHeight: number;
  maxWidth: number;
  /**
   * The corner the box was hung from, as a `transform-origin`. An opening
   * zoom looks like it grows out of the trigger only if it grows from the
   * corner nearest it; the default `center` reads as the box sliding in from
   * whichever side happens to be furthest away. Spread into the style object
   * with the rest of the placement, so it can never disagree with it.
   */
  transformOrigin: string;
};

export function pointAnchor(x: number, y: number): MenuAnchor {
  return { top: y, bottom: y, left: x, right: x };
}

/**
 * Resolve the main axis: which side of the anchor the box lands on, and how
 * much room that side gives it.
 *
 * `positive` is the side growing away from the viewport origin (below, or to
 * the right); `negative` is the other one. The preferred side wins when the box
 * fits there; otherwise flip if the other side fits; if neither does, take the
 * roomier one and let the cap turn the overflow into a scroll.
 */
function resolveMainAxis(
  size: number,
  roomPositive: number,
  roomNegative: number,
  preferPositive: boolean,
): { positive: boolean; room: number } {
  const fitsPreferred = size <= (preferPositive ? roomPositive : roomNegative);
  const fitsOther = size <= (preferPositive ? roomNegative : roomPositive);
  const positive = fitsPreferred
    ? preferPositive
    : fitsOther
      ? !preferPositive
      : roomPositive >= roomNegative;
  return { positive, room: Math.max(0, positive ? roomPositive : roomNegative) };
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
  /** The box's current rendered width. */
  menuWidth: number;
  /** The box's current rendered height. */
  menuHeight: number;
  align: MenuAlign;
  side?: MenuSide;
  viewportWidth: number;
  viewportHeight: number;
}): MenuPlacement {
  if (side === "left" || side === "right") {
    const roomRight = viewportWidth - MARGIN - (anchor.right + OFFSET);
    const roomLeft = anchor.left - OFFSET - MARGIN;
    const { positive: toRight, room: maxWidth } = resolveMainAxis(
      menuWidth,
      roomRight,
      roomLeft,
      side === "right",
    );
    const width = Math.min(menuWidth, maxWidth);
    const left = toRight ? anchor.right + OFFSET : anchor.left - OFFSET - width;

    // Cross axis: no flipping, just the viewport less its gutters. `start`
    // lines the box's top up with the anchor's top (a preview card tracks the
    // row it describes); `end` hangs its bottom off the anchor's bottom.
    const maxHeight = Math.max(0, viewportHeight - MARGIN * 2);
    const height = Math.min(menuHeight, maxHeight);
    const desiredTop = align === "end" ? anchor.bottom - height : anchor.top;

    return {
      position: "fixed",
      left: clamp(left, MARGIN, viewportWidth - width - MARGIN),
      top: clamp(desiredTop, MARGIN, viewportHeight - height - MARGIN),
      maxHeight,
      maxWidth,
      transformOrigin: `${align === "end" ? "bottom" : "top"} ${toRight ? "left" : "right"}`,
    };
  }

  const roomBelow = viewportHeight - MARGIN - (anchor.bottom + OFFSET);
  const roomAbove = anchor.top - OFFSET - MARGIN;

  // The cap is the whole of the available room, never the box's own measured
  // height. Two reasons: pinning max-height to what it measures today
  // would freeze its border box, so the ResizeObserver that re-places it would
  // never fire again when a cascade step swapped in a taller panel; and the
  // room does not depend on the measurement, so feeding a capped height back
  // in on the next pass cannot ratchet it smaller. A caller's own
  // tighter cap (`max-h-72` on the breadcrumb drill-down) survives too — it
  // simply wins the measurement, and `top` follows the box that results.
  const { positive: below, room: maxHeight } = resolveMainAxis(
    menuHeight,
    roomBelow,
    roomAbove,
    side !== "top",
  );
  const height = Math.min(menuHeight, maxHeight);
  const top = below ? anchor.bottom + OFFSET : anchor.top - OFFSET - height;

  const maxWidth = Math.max(0, viewportWidth - MARGIN * 2);
  const width = Math.min(menuWidth, maxWidth);
  // `end` hangs the box's right edge off the anchor's right edge; `start`
  // lines their left edges up.
  const fromStart = align !== "end";
  const preferred = fromStart ? anchor.left : anchor.right - width;
  const flipped = fromStart ? anchor.right - width : anchor.left;
  // Flip to the anchor's other edge before falling back to clamping. Clamping
  // keeps the box on screen but slides it away from the control it belongs to,
  // which reads as unanchored — a wide panel hung off a chip near the right of
  // the screen ends up in the gutter rather than under its trigger. A viewport
  // too narrow for either edge still clamps.
  const fits = (value: number) => value >= MARGIN && value + width <= viewportWidth - MARGIN;
  const usePreferred = fits(preferred) || !fits(flipped);
  const desiredLeft = usePreferred ? preferred : flipped;

  return {
    position: "fixed",
    left: clamp(desiredLeft, MARGIN, viewportWidth - width - MARGIN),
    top: clamp(top, MARGIN, viewportHeight - height - MARGIN),
    maxHeight,
    maxWidth,
    transformOrigin: `${below ? "top" : "bottom"} ${usePreferred === fromStart ? "left" : "right"}`,
  };
}

function clamp(value: number, min: number, max: number): number {
  // max < min when the viewport is smaller than the box; the gutter on the
  // leading edge wins so the box's start is always reachable.
  return Math.max(min, Math.min(value, Math.max(min, max)));
}

/**
 * The box's laid-out rect. Layout size, not `getBoundingClientRect`: the open
 * animation scales it, and a measurement taken mid-zoom places it a few
 * pixels off.
 */
export function measureMenu(element: HTMLElement | null, fallbackWidth: number) {
  if (!element) return { width: fallbackWidth, height: 0 };
  return { width: element.offsetWidth || fallbackWidth, height: element.offsetHeight };
}
