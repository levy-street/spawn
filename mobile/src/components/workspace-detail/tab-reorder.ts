export interface TabDragGeometry {
  tabWidth: number;
  tabGap: number;
  /**
   * Where each visible tab's left edge sits, when something other than tabs
   * shares the row — a group's label. Without it, tabs are evenly spaced.
   */
  slotLefts?: readonly number[];
}

function clampIndex(index: number, count: number): number {
  "worklet";
  return Math.min(Math.max(0, index), Math.max(0, count - 1));
}

function slotLeft(index: number, geometry: TabDragGeometry): number {
  "worklet";
  return geometry.slotLefts?.[index] ?? index * (geometry.tabWidth + geometry.tabGap);
}

/** Applies the web's neighbor-midpoint crossing rule to fixed-width native tabs. */
export function tabDestinationIndex(
  fromIndex: number,
  translationX: number,
  tabCount: number,
  geometry: TabDragGeometry,
): number {
  "worklet";
  if (tabCount < 2) return 0;

  const from = clampIndex(Math.trunc(fromIndex), tabCount);
  const draggedLeft = slotLeft(from, geometry) + translationX;
  const draggedRight = draggedLeft + geometry.tabWidth;
  let destination = from;

  if (translationX > 0) {
    for (let index = from + 1; index < tabCount; index += 1) {
      const neighborMidpoint = slotLeft(index, geometry) + geometry.tabWidth / 2;
      if (draggedRight <= neighborMidpoint) break;
      destination = index;
    }
  } else if (translationX < 0) {
    for (let index = from - 1; index >= 0; index -= 1) {
      const neighborMidpoint = slotLeft(index, geometry) + geometry.tabWidth / 2;
      if (draggedLeft >= neighborMidpoint) break;
      destination = index;
    }
  }

  return destination;
}

/** Places the insertion marker at the boundary represented by the final array index. */
export function tabInsertionX(
  fromIndex: number,
  toIndex: number,
  geometry: TabDragGeometry,
): number {
  "worklet";
  if (toIndex < fromIndex) {
    return Math.max(0, slotLeft(toIndex, geometry) - geometry.tabGap / 2);
  }
  if (toIndex > fromIndex) {
    return slotLeft(toIndex, geometry) + geometry.tabWidth + geometry.tabGap / 2;
  }
  return slotLeft(fromIndex, geometry);
}

/**
 * How far a tab that is not being dragged slides while another one is: into
 * its neighbour's place, toward the gap the dragged tab left. Labels never
 * move, so the slide is to the neighbour's actual position rather than one
 * even step.
 */
export function siblingShift(
  index: number,
  fromIndex: number,
  toIndex: number,
  geometry: TabDragGeometry,
): number {
  "worklet";
  if (fromIndex < 0 || index === fromIndex) return 0;
  if (fromIndex < toIndex && index > fromIndex && index <= toIndex) {
    return slotLeft(index - 1, geometry) - slotLeft(index, geometry);
  }
  if (fromIndex > toIndex && index >= toIndex && index < fromIndex) {
    return slotLeft(index + 1, geometry) - slotLeft(index, geometry);
  }
  return 0;
}
