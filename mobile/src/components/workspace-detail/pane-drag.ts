import { useMemo } from "react";
import { type SharedValue, useSharedValue } from "react-native-reanimated";

import type { AgentIdentity } from "@/data/types/domain";

/**
 * A pane lifted out of the list and carried over the tab strip.
 *
 * The row publishes where the finger is; the strip publishes where it sits and
 * how far it has scrolled; `tabIndexAtPoint` turns the two into the tab under
 * the finger. Keeping that a plain function rather than a layout query is what
 * lets the whole gesture run on the UI thread — the strip and the row live in
 * different subtrees and never measure each other.
 */
export interface PaneDragValues {
  /** 1 while a pane is being carried, 0 otherwise. */
  active: SharedValue<number>;
  /** Finger position in window coordinates. */
  pointerX: SharedValue<number>;
  pointerY: SharedValue<number>;
  /** Index of the tab under the finger, or -1 for none. */
  hovered: SharedValue<number>;
  stripLeft: SharedValue<number>;
  stripTop: SharedValue<number>;
  stripWidth: SharedValue<number>;
  stripHeight: SharedValue<number>;
  stripScrollX: SharedValue<number>;
}

/** What the floating ghost shows while a pane is carried. */
export interface PaneGhost {
  title: string;
  identity: AgentIdentity;
}

export interface TabStripGeometry {
  stripLeft: number;
  stripTop: number;
  stripWidth: number;
  stripHeight: number;
  scrollX: number;
  /** Left inset of the first tab inside the scroller's content. */
  contentInset: number;
  tabWidth: number;
  tabGap: number;
  tabCount: number;
}

/**
 * Which tab sits under a window-space point, or -1 for none — outside the
 * strip's band, in a gap between tabs, or past the last one (the "+" button
 * is not a drop target).
 */
export function tabIndexAtPoint(x: number, y: number, geometry: TabStripGeometry): number {
  "worklet";
  const {
    stripLeft,
    stripTop,
    stripWidth,
    stripHeight,
    scrollX,
    contentInset,
    tabWidth,
    tabGap,
    tabCount,
  } = geometry;
  if (stripWidth <= 0 || stripHeight <= 0 || tabCount <= 0) return -1;
  if (x < stripLeft || x > stripLeft + stripWidth) return -1;
  if (y < stripTop || y > stripTop + stripHeight) return -1;

  const withinContent = x - stripLeft + scrollX - contentInset;
  if (withinContent < 0) return -1;
  const step = tabWidth + tabGap;
  const index = Math.floor(withinContent / step);
  if (index < 0 || index >= tabCount) return -1;
  // The gap between two tabs belongs to neither.
  return withinContent - index * step <= tabWidth ? index : -1;
}

/** The shared values one workspace screen's pane drag is written through. */
export function usePaneDragValues(): PaneDragValues {
  const active = useSharedValue(0);
  const pointerX = useSharedValue(0);
  const pointerY = useSharedValue(0);
  const hovered = useSharedValue(-1);
  const stripLeft = useSharedValue(0);
  const stripTop = useSharedValue(0);
  const stripWidth = useSharedValue(0);
  const stripHeight = useSharedValue(0);
  const stripScrollX = useSharedValue(0);
  return useMemo(
    () => ({
      active,
      pointerX,
      pointerY,
      hovered,
      stripLeft,
      stripTop,
      stripWidth,
      stripHeight,
      stripScrollX,
    }),
    [
      active,
      pointerX,
      pointerY,
      hovered,
      stripLeft,
      stripTop,
      stripWidth,
      stripHeight,
      stripScrollX,
    ],
  );
}
